# code_review 触发矩阵——四条路径一个引擎(step-075;CI Action step-116;review-hook 已下线 step-083)

> 单一真相:`packages/code-sense/src/review/index.ts` 的 `codeReview(root, opts)`。
> 所有触发路径只是「谁发起、跑哪几层、结果送去哪」的包装差异;评审行为本身
> (diff 收集 / 确定性四类 / 反模式八类 / LLM 多轮深审 / 防幻觉过滤 / 定位三级降级 /
> 引用孤儿闸 / 行级回写店 / 全文件扫描 / 会话续跑)只有一份实现,各路径零漂移。

## 1. 触发矩阵

| 触发路径 | 谁发起 | 何时 | 跑哪几层 | 结果去哪 | 开关/配置 |
|---|---|---|---|---|---|
| **面板 `/review`** | 人(面板聊天窗) | 手动输入 slash | 展开为指令文本发给主 agent → agent 自主调 `code_review` 工具(=下一行路径) | 同 agent 工具路径 | 面板 SLASH_COMMANDS 内置条目 |
| **agent 工具 `code_review`** | 主 agent(LLM 自主决策) | 任务执行中(含 /review 展开后) | 确定性+反模式恒跑;**LLM 深审=models.review 配置驱动**(未配置=确定性 only);ocr CLI 层随 env `GENIE_REVIEW_CLI` opt-in | journal `review.findings` → 面板行级评论卡;工具返回文本=summary+前 20 条 | `coding.models.review`(设置页「评审模型」);`GENIE_REVIEW_CLI` |
| **验收钩子 review-hook** | —(**已下线**,step-083) | — | — | — | 2026-10-16 用户口径:「code review 不要自动触发,应当由 coding agent 来触发,因为不是所有任务都是 coding 任务」——非 coding 任务(规划/问答)done 也弹评论卡。移除 app.ts 状态机接线与 review-hook.ts;触发权交还 coding agent 提示词纪律(SYSTEM: coding 任务完成前主动调 code_review 并按 findings 修复,非 coding 任务不调)。历史实现见 tasks/step-055。 |
| **`codesense review` CLI** | 人 / CI / 外部 agent | 手动、CI 流水线、任何 shell | 确定性+反模式恒跑(diff);`--scan` 时确定性层跑、diff 语义反模式层不跑;LLM 深审=`--deep` opt-in(凭证链 flag>env>config>ask-file,step-105 起;env 档三件套 `GENIE_LLM_BASE_URL/MODEL/API_KEY` 与 gateway `buildLlmFromEnv` 同名同源);ocr 层同随 `GENIE_REVIEW_CLI`(scan 不跑) | stdout:markdown(人读)/`--json`(agent 消费);行级回写店 `<root>/.genie/review-comments.json`(diff 模式;scan 不写);review 会话 `<root>/.genie/reviews/<id>.json`(每次落盘,step-116);退出码 | `--scan [path]` / `--include` / `--exclude` / `--resume <id>` / `--compare <id>` / `--sessions` / `--deep` / `--base-url·--model·--api-key` / `--rounds N` / `--impact` / `--json`;退出码见 §3 |
| **GitHub Action `.github/actions/codesense-review`**(step-116) | CI workflow(人配置) | push/PR/手动 workflow | 与 `codesense review` CLI 同一形态(diff 或 `--scan` 全文件;`--deep` opt-in) | Action outputs(`findings/blockers/warnings/nits/session/exit-code`)+ job summary 表格;退出码透传 | `with: root/target/scan/include/exclude/deep/rounds/预算`;LLM 凭证经 `env` 注入 |

共同副作用(引擎内建,存续路径一致):有 findings 时维护行级回写店 `.genie/review-comments.json`
(sticky 评论:不复现打 resolvedAt 不删除);出口引用孤儿闸(幻影路径拒收+行号夹紧)恒在。

## 2. CLI 指令形态

```
codesense review [target] [--root dir] [--scan [path]] [--include glob] [--exclude glob]
                 [--max-files N] [--max-tokens N] [--max-file-size N]
                 [--deep] [--rounds N] [--impact]
                 [--resume <id> | --compare <id>] [--sessions]
                 [--json] [--no-color]
```

- **target**:缺省=未提交变更(unstaged+staged+未跟踪伪 diff);`/^[0-9a-f]{7,40}$/`=commit
  (`git show`);其余=分支(`git diff <branch>...HEAD`)。与引擎 `collectReviewTarget` 逐字同源。
- **root 解析**:`--root` > 注册表就近(`~/.codesense/registry.json`,逐级向上) > 当前目录。
  review 只要求 git 仓,**不强制 `codesense init`**(CI 零配置可跑);`--impact` 只读现有索引,
  索引缺席=不注入影响面,本指令从不触发索引构建。
- **--scan [path]**(step-116):全文件扫描(陌生仓审计),不是 diff。`path` 缺省=全仓,
  可给目录或文件(仓内相对);`--include` 白名单 / `--exclude` 额外黑名单(逗号分隔 glob)。
  枚举走 `git ls-files --cached --others --exclude-standard`(**继承 .gitignore**;非 git 目录回退
  walk + 根 .gitignore 简读),默认排除 vendored/生成物(`node_modules/dist/build/out/coverage/
  vendor/third_party/.venv/target/...`、lockfile、`*.min.js`、`*.map`、`*.snap`、`*.generated.*` 等)。
  预算:文件数上限 `--max-files`(缺省 200)、单文件上限 `--max-file-size`(缺省 128KiB,
  **超出截断并登记** `truncatedFiles`;>4× 上限跳过)、深审总 token `--max-tokens`(缺省 120k,
  按批扣减,超限整批跳过并登记)。scan 模式:确定性层照跑;**diff 语义反模式确定性层不跑**
  (无「新增行」语义;深审提示词里的八类维度保留);ocr CLI 层不跑;不写 diff 回写店。
- **--deep**:LLM 多轮深审(confirmed 防重/零新增早停/grace round/定位三级降级+LLM 第四级/
  防幻觉过滤)。scan 深审按批(≤8 文件/45k 字符)派发,单文件上下文超 12k 字符截断并登记。
  缺凭证=fail-visible exit 2,**不静默降级**为确定性层。凭证链(step-105)=
  flag(`--base-url/--model/--api-key`)> env 三件套 > `codesense config` 配置文件 > ask-file 中继,
  与 codesense-cli 语义层同一条链(见 docs/codesense-cli.md §2 评审节「LLM 深审凭证链」)。
- **--rounds N**:深审轮数(≥1 整数,缺省=2,引擎 ocr effort=medium 语义)。
- **--impact**:深审上下文注入 code_sense 影响面(diff 新增导出符号的上下游,`deriveImpact`);
  scan 模式不适用(显式给出=exit 2)。
- **会话(step-116)**:每次 review 落 `<root>/.genie/reviews/<id>.json`
  (findings+target+时间+scan 配置/统计+baseline/resumedFrom)。
  - `--resume <id>`:以该会话为基线续跑(**继承其 scan 范围/预算**),新会话记录
    `resumedFrom=<id>`,输出四态对比;
  - `--compare <id>`:一次性对比(同样继承 scan 范围,但不写 resumedFrom 血缘);
  - `--sessions`:只读列出本仓会话(id/时间/类型/findings 计数/血缘);
  - 四态 = **新增**(当前有、基线无、更早也无)/ **已修复**(基线有、当前无)/
    **未变**(两边都有,行号可漂移)/ **复现**(当前有、基线无,但更早会话出现过)。
    身份键 = `path | normalize(anchorText || detail || title)`(行号不参与;措辞大改会表现为
    resolved+new,与 OCR 同款限制)。
  - 基线不存在/类型不一致(scan vs diff)=exit 2;scan 路径越界/不存在=exit 2。

## 3. 退出码(CI 门禁语义)

| 码 | 语义 |
|---|---|
| 0 | 评审完成且无 blocker |
| 1 | 评审完成但**有 blocker**(CI 拦门)/ 运行错误(非 git 仓、LLM HTTP 失败等,stderr 有文案) |
| 2 | 用法/配置错误(非法 --rounds/预算、--deep 缺凭证、scan 路径非法、基线会话缺失/类型不一致) |

CI 用法示例:`codesense review --deep && echo PASS` —— blocker 即红。

## 4. CLI vs gateway `code_review` 工具:同源对照(2026-10-16 实测)

同一引擎函数、同一 target 解析、同一出口闸;差异只在包装面:

| 维度 | gateway 工具 | codesense review CLI |
|---|---|---|
| 引擎调用 | `codeReview(root, {target, llm})` | 同左(逐字同一函数;CLI 额外可传 `scan`/`session`) |
| root | 任务项目根(无项目回退 harness 根) | `--root`/注册表就近/cwd |
| 深审 LLM 来源 | `coding.models.review`(配置文件) | env 三件套(--deep 时) |
| 深审开关 | 配置了 review 模型即深审 | 显式 `--deep` opt-in |
| 全文件扫描 | 未接线(引擎已支持 `scan`) | `--scan [path]` + 预算旗标 |
| 会话 | 引擎默认落 `.genie/reviews`(每次 review) | 同;`--resume/--compare/--sessions` 消费 |
| ocr CLI 层 | 随 `GENIE_REVIEW_CLI` env | 同(未动;scan 不跑) |
| 结果消费 | journal→面板评论卡;工具返回截断文本(前 20 条) | stdout markdown/--json 全量 findings;退出码 |
| 行级回写店 | 引擎内建(有 findings 即写) | 同(同一文件,跨路径 sticky 连续;scan 模式不写) |
| 引用孤儿闸 | 引擎出口恒在 | 同 |

实测锚:本仓真实未提交变更,CLI 确定性层 6 条(0 blocker/4 warning/2 nit)与引擎直出一致;
深审样例见 `tasks/step-075-review-cli-trigger-matrix/evidence/`;scan/续跑实测见
`tasks/step-116-review-scan-resume/`。

## 5. 不做什么(边界)

- CLI 不写 journal、不渲染面板卡(harness 会话态功能,见 codesense-cli.md §6 同款边界)。
- CLI 不新增「只确定性层」开关——确定性+反模式恒跑是 diff 引擎语义;scan 因无「新增行」
  语义只跳过反模式的确定性部分(深审提示词维度保留),不是开关。
- 回写店无 `--no-store` 开关(引擎未暴露; sticky 店是跨路径共享状态,关它会产生口径分叉)。
- scan 不做「每文件一个 agent」的 OCR 形态(成本×文件数),而是分批多轮 + 总预算;
  `--resume` 是**结果四态对比**,不是 OCR 的文件级断点续跑(本引擎无需长任务 checkpoint)。
- open-code-review(Go,外部件致谢)保持只读,`GENIE_REVIEW_CLI` 适配层 opt-in 不动。

## 6. CI 形态(GitHub Action,step-116)

### 6.1 Action 契约(`.github/actions/codesense-review/action.yml`)

- 形态:composite action;内部执行 `<cli> review ... --json`,解析 JSON 后写
  `GITHUB_OUTPUT`(findings/blockers/warnings/nits/session/exit-code)与 `GITHUB_STEP_SUMMARY`
  (目标/结论/四态对比/前 30 条 findings 表格),退出码原样透传。
- 输入:`cli`(默认 PATH 中 `codesense`)、`root`、`target`、`scan`(true 或路径)、
  `include`、`exclude`、`deep`、`rounds`、`max-files`、`max-tokens`、`max-file-size`、`extra-args`。
- 前置:运行器上已有可执行的 `codesense`(本仓示例先 `pnpm install` + 构建
  `@lampgenie/code-sense-cli`,再把 `node_modules/.bin` 加入 PATH);LLM 凭证经 `env` 注入。

### 6.2 workflow 片段

```yaml
name: codesense review
on:
  pull_request:
  workflow_dispatch:
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @lampgenie/code-sense-cli build
      - uses: ./.github/actions/codesense-review
        with:
          # diff 审查(PR):target 用基线分支;全文件扫描则改为 scan: "src/"
          target: origin/${{ github.base_ref }}
          deep: "true"
        env:
          GENIE_LLM_BASE_URL: ${{ secrets.GENIE_LLM_BASE_URL }}
          GENIE_LLM_MODEL: ${{ secrets.GENIE_LLM_MODEL }}
          GENIE_LLM_API_KEY: ${{ secrets.GENIE_LLM_API_KEY }}
```

全文件扫描(陌生仓/定时审计)把 `target` 换成 `scan: "src/"`(或 `scan: "true"` 全仓),
并按需加 `include/exclude/max-files/max-tokens`。

### 6.3 本地校验

- YAML:`python3 -c "import yaml..."` 解析通过(2026-10-16 实测);
- shell:`bash -n` 对 action 的 `run:` 块语法通过;
- `actionlint`/`act` 本机不可用(命令探测为空),未做真实 runner 执行(登记待调度)。
