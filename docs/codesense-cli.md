# codesense CLI——code-sense 静态调用索引的独立发行(`packages/code-sense-cli`)

> 立项口径(2026-10-15):「把 code-sense 包装成一种独立的 CLI 服务,方便在各种平台里使用
> (codex、trae、dsh、zcode),设计几种指令,这个指令 lampgenie-harness 也同步使用;减小非
> lampgenie-harness 用户的使用代价,方便工具传播。」

## 1. 单一真相与三方同源

```
packages/code-sense(核心库,单一真相)
        ├── buildC2fIndex / classify / loadIndex / indexStale / querySymbol
        ├── queryFile / queryEntryPoints / renderNeighborhood / renderFile
        └── src/callgraph/engine.ts(buildCallGraph / adapters / 压制名单)
              ↑
packages/code-sense-cli/src/mcp-core.ts(工具面+格式化,唯一一份)
        ├── codesense serve(MCP stdio)          ← 外部平台接入
        ├── codesense <查询指令>                  ← CLI 直调(文本=同一 dispatch 输出)
        └── apps/gateway/src/code-index-core.ts   ← 再导出薄壳(gateway 内部用法不变)
                    └── code-index-mcp.mjs(原 stdio 入口,零改动)
```

- CLI 的人类可读输出直接复用 mcp-core 的 `dispatchTool` 文本(逐字同源);
  `--json` 走结构化查询(同一核心函数),仓归属逐条标注。
- gateway 迁移后只剩再导出薄壳;原 `test/code-index-mcp.test.ts`(11 例)不改一行原样通过,
  即行为等价锚。全量重建/增量合并的唯一分类真相=`c2f.classify`(本轮起导出)。

## 2. 指令集

### 管理
| 指令 | 作用 |
|---|---|
| `codesense index [root]` | 建索引(`--force` 全量重建;默认按文件指纹增量复用;`--register` 登记注册表=任意目录就近解析;已登记的根顺带刷新注册表统计) |
| `codesense roots` | 列出已登记的根及索引规模(doctor 的快档) |
| `codesense remove <root>` | 注销(`--purge` 连 `.genie/sense-index/<hash>` 数据一起删) |
| `codesense doctor [root]` | 环境自检:node 版本/ts-morph/tree-sitter wasm 逐语言/注册表/根解析/索引健康/索引目录可写性 |

> 收尾批 J(2026-10-21):旧独立命令 `init`/`graph`/`filegraph` 已删——分别由
> `index --register` / `symbol --graph` / `file --graph` 取代(A-E 批建立的等价新形态)。

### 查询(索引缺失自动构建一次,`--no-build` 关闭;索引过期照常回答+stderr 提示)
| 指令 | 对应 MCP 工具(serve) | gateway code_index action | 核心库函数 |
|---|---|---|---|
| `codesense symbol <name>` | `code_index_symbol {name, repo?}` | `action="symbol"` | `querySymbol` |
| `codesense impact <name>` | `code_index_impact {name, depth?, repo?}` | `action="impact"` | `queryImpact`/`renderImpact` |
| `codesense flow [scope] [--level module\|file\|function\|auto] [--target <name> --upstream N --downstream N] [--dot] [--out f.mmd\|.dot\|.json]` | `code_index_flow {level?, scope?, target?, upstream?, downstream?, maxNodes?, graph?}` | `action="flow"` | `buildCodeFlow`/`renderCodeFlowText`/`renderCodeFlowMermaid`/`renderCodeFlowDot`(整仓代码流:module/file/function 三层聚合;每文件 `<module>` root、trunk/leaf/regular 三色、File/Class 分组、默认裁零连接、入口/分层/主干/枢纽;缺省不设节点上限=诚实全量,`--max-nodes` 显式收窄;索引缺失不构建,`--out` 落盘;**模块节点下方斜体=模块作用/角色**:package.json/README/模块 docstring 原文优先,`≈`=名称/拓扑推断;CLI `--json` 带 `moduleNotes`(含 source),wiki flow/guide 页同一份注记) |

| `codesense callers <name>` / `callees <name>` | (symbol 的单侧视图) | — | `querySymbol` |
| `codesense symbol <name> --graph` | —(图类移出 MCP 面,图给人看走 CLI) | `action="graph"`(gateway 同源) | `renderNeighborhood` |
| `codesense entrypoints [root]` | `code_index_entrypoints {repo?}` | `action="entrypoints"` | `queryEntryPoints`(首节=进程入口:py `__main__`/js `require.main`/c·go·java `main`/package.json `bin`,启动器视角,与扇出榜解耦) |
| `codesense modules [root] [--graph]` | `code_index_modules {repo?, graph?}`(2026-10-22 起) | —(走 `code_sense` 面待接) | `buildModuleView`/`renderModuleView`(模块清单+跨模块交互矩阵 A→B=调用方向+枢纽/测试面;`--graph`=mermaid 架构图;分组=目录启发式,tests 单一面) |
| `codesense file <path>` | `code_index_file {path, repo?}` | `action="file"` | `queryFile` |
| `codesense file <path> --graph` | —(图类移出 MCP 面) | — | `renderFile`(mermaid 文件图) |
| `codesense branches <path>` | —(refs 命中已联动带决策点标注;全骨架走 CLI) | — | `queryBranchesCmd`→`scanDecisionFile`/`renderDecisionSkeleton`(2026-10-21:if/elif/else/while/do-while/for/for-of/for-in/switch/case+三元,每点带条件/行距/深度/迭代目标/分支直接调用/所属函数;py/ts/js/c/cpp/java/go tree-sitter,不可用行级降级) |
| `codesense api [--semantics]` | `code_index_api {repo?}` | `action="api"` | `queryApiSurface`/`renderApiSurface`;`--semantics`=LLM 语义层(批量 ≤12/请求·上限 40·git sha+端点指纹缓存·`--write` 落盘·无凭证显式 off) |
| `codesense state` | `code_index_state {repo?}` | —(走 `code_sense` mode=state) | `queryStateMachines`/`renderStateMachines` |
| `codesense algo [file]` | `code_index_algo {file?, repo?}` | —(走 `code_sense` mode=algo) | `extractAlgoSurface` |
| `codesense vars <file> [--locals]` | `code_index_vars {file, repo?}` | —(file 面带 dataType) | `extractTypedSymbols`/`renderVars`;`--locals`=扩入函数内注解面(带注解 param/local,推断局部不入) |
| `codesense tokens <file>` | —(数据导出面,CLI/--json 专属) | — | `toSemanticTokens` |
| `codesense project [root]` | `code_index_project {repo?}` | `action="project"` | `queryProjectProfile`/`renderProjectProfile`(技术栈/拓扑覆盖 C/C++ 与构建文件) |
| `codesense wire [--changed]` | `code_index_wire {root?, repo?, changed?}` | `action="wire"` | `scanWire`/`renderWire`(协议↔handler↔收发三处对账;`--changed` 按 type 字面量集合 diff,分新增/删除/改动) |
| `codesense branches <path>` | `code_index_branches {path, repo?}`(2026-10-23 起) | `action="branches"`(gateway code_sense) | `scanDecisionFile`/`renderDecisionSkeleton`(分支/循环骨架:if/elif/else/while/for/switch/三元,条件+迭代目标+分支直接调用+所属函数;py/ts/js/c/cpp/java/go) |
| `codesense cfg <函数名> [--file <path>] [--line N] [--depth N] [--full] [--no-merge] [--max-nodes N] [--out f.mmd\|.md\|.json\|.dot\|.svg\|.png]` | —(函数体级图,CLI 专属;wiki 关键流程图页同源) | — | `buildFileCfgs`/`pickFunction`/`renderCfgMermaid`/`renderCfgText`(2026-10-27:语句级 CFG——真实语句文本+if/elif/else 菱形条件(是/否边)+while/for 回边(循环/退出)+switch/case+try/catch/finally(异常边)+return/throw/break/continue;结构化函数说明=职责首句/输入/输出/关键判断+为真动作/循环/异常/副作用/上下游/位置,图内只放 4 行「函数速览」+模块常量小卡;长函数按 ~22 节点分页,跨页「←/→ 第 N 页」跳转桩,**节点/边不删**;py/ts/js/c/cpp/java/go) |
| `codesense refs <字面量> [--no-tests] [--no-docs]` | `code_index_refs {literal, root?, repo?, includeTests?, includeDocs?}` | `action="refs"` | `scanLiteralRefs`/`renderLiteralRefs`(字面量引用面:case/eq/z-literal/object-key/cpp-macro/string/build-file/doc 语境 + file:line + 所属符号;2026-10-21 起代码命中带最内层决策点标注(⟂ if/while/for…),结构位点附 ±2 行预览;删除字符串/宏开关时用) |

> api/state/algo是**确定性行扫描,不依赖索引、不触发构建**(`--no-build` 语义固定);
> vars/tokens同为逐文件深提取不触发构建;project 读 manifest,缺席时按需生成确定性骨架
> (需要缓存/LLM 解读再跑 `codesense project --write`);
> wire/refs 同样为纯行扫描(索引非前置,refs 的所属符号读现成索引、缺席留空)。
> 代码档案(2026-10-26):`wiki rebuild` 在既有页面之外生成 **全仓代码流**、**模块 file 级 flow**、
> **语义级代码指南**、**功能拆解** 四类页;2026-10-27 追加 **关键流程图**(每条管线 ≤3 个关键函数,
> 函数体语句级 CFG;长函数分页,节点/边不删;单函数 >150 节点不进档案页但在候选表说明并给 CLI 指路)。
> flow 事实来自 `buildCodeFlow`(静态索引;无索引时
> 降级为词法级 module/import 图,页面与 manifest 标注 `source=lexical`);LLM 只写「语义解读」,
> 每段必须带 file:line 引用回查,图/入口/功能线由确定性骨架产出。`--no-flow` 关闭这批页面。
>
> cfg(2026-10-27)是 flow 的「函数体内视镜」:flow 回答「谁调谁」,cfg 回答「这个函数内部怎么走」——
> 条件、循环、异常路径和真实调用一条条画出来。例:
> `codesense cfg build_user_memory_from_videos --root ../genie-memory --depth 1 --out /tmp/x.mmd`
> (`--depth` 把同仓被调函数也画成独立图,默认只画主函数;`--full` 出完整单图,默认长函数分页)。
>
> 函数说明参考 deepwiki-open 开源项目的页面结构(Introduction / Detailed sections / Key functions table,
> 每条 Sources: `file:line`),不直接倾倒 docstring:职责取注释首句;输入=签名参数(raw/name/type/default);
> 输出=return 表达式+返回类型(对象/数组字面量用类型替代);关键判断=CFG 菱形+为真时第一个动作;
> 副作用=调用名启发式(明确标注;push/Map.delete/dict.update/new Error 已收口);上下游=静态索引直接调用边;
> 无注释时给「按函数名/签名推断」并置 `description.purposeSource="signature"`,不冒充文档;
> 原始注释降级为「源码注释/设计备注」(≤600,全文在 `--json`)。页面顶部先给「关键函数一览」表,
> 每个函数再给 12 行「函数速览」表,最后才是分页流程图。
>
> refs 默认扫描产品源码+测试+文档/提示词文本,默认排除 `node_modules/dist/.genie/vendor`;
> C/C++ 预处理宏(`#ifdef/#ifndef/#if defined/#define`)与 CMake/Make 构建文件单独成桶。
> 上表其余指令读静态索引。MCP serve 面的新件与 CLI 输出同源(同一 render* 函数;
> repo 参数=定向单仓目录扫描,缺省=整个根,与 CLI `--root` 同语义)。gateway 的 in-process
> `code_index` action 面收在 `api`/`project`——state/algo 属
> code_sense 认知剖面(mode 路由),不进 gateway 索引查询面。

### agent 视角选型指南(五面入口分工,)

| 要回答的问题 | 用哪个入口 | 命令 | 延迟档 |
|---|---|---|---|
| 谁调用它/它调用谁(结构关系) | gateway `code_index` / MCP / CLI | `action=symbol` / `code_index_symbol` / `symbol` | 毫秒 |
| 改这个函数影响哪些文件与测试(编辑前必查) | 同上 | `action=impact` / `code_index_impact` / `impact` | 毫秒 |
| 整个项目从哪跑起来、主流程怎么走、谁依赖谁 | gateway `code_sense` / MCP / CLI | `action=flow` / `code_index_flow` / `flow` | 百毫秒-秒(读静态索引,可附 mermaid) |
| 删除/修改一个字符串标识(如 `action === "graph"`)的引用面 | gateway `code_sense` / MCP / CLI | `action=refs` / `code_index_refs` / `refs` | 百毫秒(rg 行扫描) |
| 这个调用在什么条件下发生(分支/循环骨架) | gateway `code_sense` / CLI | `action=branches` / `branches` | 百毫秒(tree-sitter;命中带决策点标注) |
| 这个函数内部到底怎么走(语句级分支/循环/try/调用) | CLI | `cfg <函数名> [--depth N]` | 百毫秒(tree-sitter;长函数分页) |
| 这个服务有哪些 HTTP 接口、改接口波及谁 | gateway `code_index` / CLI / `code_sense` mode=api | `action=api` / `api` / `mode=api` | 秒(行扫描) |
| 状态机怎么流转 / 算法模块画像 | `code_sense` mode=state/algo / CLI `state`/`algo` | 同左 | 秒(行扫描) |
| 符号的签名/时序/全仓引用/类型定义(语义画像) | `code_sense` mode=debug | `debug` | 秒(懒解析) |
| 项目整体架构/模块分工/从哪开始读架构叙事 | `code_sense` mode=plan | `plan` | 静态毫秒 / LLM 冷启动分钟级 |
| 项目入口函数清单(trunk)/符号邻域图 | gateway `code_index` / MCP / CLI | `entrypoints`/`graph` | 毫秒 |
| 关键词找代码(命名形态不确定/要聚合导读) | `code_sense` mode=explore | `explore` | 百毫秒(rg) |
| 精确正则检索/输出形态控制(content/files/count) | file-tools `grep` | `grep` | 百毫秒(JS walk) |
| 页面流(路由/组件/跳转) | `code_sense` mode=ui | `ui` | 秒 |

记忆口诀:**结构关系与编辑前影响面→code_index(毫秒);语义画像与时序→code_sense(秒);
精确文本检索→grep;跨平台传播→CLI/MCP;lampgenie-harness 面板内→工具与面板同源同缓存。**

### 服务
| 指令 | 作用 |
|---|---|
| `codesense serve [root]` | MCP stdio 服务(JSON-RPC 2.0,MCP 2024-11-05 基线);工具面九件套与 gateway 的 code-index-mcp 完全同源;env `GENIE_SENSE_INDEX_ROOT` 可指定根。异步注:三件 sensing 工具分派是 async(行扫描秒级),stdio 退出前等在飞分派清零(一次性管道不丢响应) |

### 评审(与 gateway `code_review` 工具同一引擎)
| 指令 | 作用 |
|---|---|
| `codesense review [target]` | 审查代码变更。target 缺省=未提交变更;commit hash=审该提交;分支名=审 `<分支>...HEAD`。确定性四类(凭证/生成物/调试残留/超大)+反模式八类(含孤儿逻辑六维)恒跑;出口引用孤儿闸+行级回写店(`.genie/review-comments.json`,与面板 review store 同一文件) |
| `codesense review --scan [path]` | **全文件扫描**:枚举继承 `.gitignore`,默认排除 vendored/生成物;`--include/--exclude` 收窄;预算=文件数/单文件字节/总 token(超限截断/跳过如实登记)。scan 跑确定性层与可选深审;diff 语义反模式确定性层与 ocr CLI 层不跑;不写 diff 回写店 |
| `codesense review --sessions` | 列出本仓 review 会话(`.genie/reviews/<id>.json`) |
| `codesense review --resume <id>` | 以该会话为基线续跑(继承 scan 范围/预算),输出**新增/已修复/未变/复现**四态;新会话记 `resumedFrom` |
| `codesense review --compare <id>` | 一次性对比(同样继承 scan 范围,但不写血缘) |

评审专用参数:`--deep`(LLM 多轮深审,凭证链见下「LLM 深审凭证链」节;缺凭证=exit 2
fail-visible,不静默降级)、`--base-url/--model/--api-key`(深审凭证 flag 档,三件套一起给)、
`--rounds N`(深审轮数,≥1 整数,缺省=2)、`--impact`(深审上下文注入 code_sense 影响面;
只读现有索引,索引缺席=不注入,本指令从不触发索引构建;**scan 模式不适用**)。
scan 预算参数:`--max-files N`(缺省 200)、`--max-file-size N`(字节,缺省 131072,超出截断并登记,
>4× 跳过)、`--max-tokens N`(深审总 token,缺省 120000,按批扣减,超限整批跳过并登记)。
root 解析:`--root` > 注册表就近 > 当前目录(review 只要求 git 仓,**不强制建索引**,CI 零配置)。
评审退出码:`0` 无 blocker;`1` 有 blocker(CI 门禁)或运行错误;`2` 用法/配置错
(含 scan 路径越界/不存在、基线会话缺失/类型不一致)。
`--json` 形态=`{ command, root, target{kind,files,totalLines,truncated,scan?}, summary, counts{total,blocker,warning,nit}, layers{deterministic,antipatterns,deep{enabled,rounds?,graceRoundRan?}}, findings[], scanDeep?, session?, compare?, writeback?, orphanCheck?, storeOrphans? }`。
每次 review 落会话 `<root>/.genie/reviews/<id>.json`(findings+target+时间+基线),`--resume/--compare`
的四态对比与 `--sessions` 列表均从该目录读取(目录已 gitignore)。

#### LLM 深审凭证链

`--deep` 的 LLM 凭证解析链与语义层(`api --semantics`/`project`)**完全同构**,四档定序
**flag > env > config > ask-file**(任一档命中即生效;部分凭证形态错=exit 2 如实报错):

| 档位 | 形态 | 适用 |
|---|---|---|
| ①flag | `--base-url <url> --model <名> --api-key <key>` | 一次性覆盖(CI 里注入,不落盘) |
| ②env | `GENIE_LLM_BASE_URL`/`GENIE_LLM_MODEL`/`GENIE_LLM_API_KEY`(与 gateway `buildLlmFromEnv` 同名同源) | 宿主启动环境带凭证 |
| ③config | `codesense config set llm.baseURL/llm.model/llm.apiKey`(`~/.codesense/config.json`,权限 600,输出脱敏尾 4) | 本机长期配置(推荐,一次配置) |
| ④ask-file | `codesense config set llm.askFile.dir <目录>` | 宿主零配置:CLI 写 `ask-<id>.json`,宿主 agent 答 `answer-<id>.json`,120s 超时撤题——与 §4.x 形态②同一协议 |

ask-file 在 review 场景的注意:深审是多轮编排(rounds+grace+防幻觉复核),每轮是一次独立
ask/answer 往返——宿主应答方要能持续消费该目录(轮询 watcher 或宿主规则「见 ask-*.json 即答」);
`--rounds 1` 可把往返压到最少。零新增早停语义不变(早停轮后不再发起新 ask)。

```text
$ codesense review --deep     # 无任何凭证时(exit 2,stderr 原样指路)
--deep 需要深审凭证——凭证链 flag > env > config > ask-file(见 `codesense config` …):
  ①flag: --base-url <url> --model <名> --api-key <key>(三件套一起给)
  ②env: GENIE_LLM_BASE_URL / GENIE_LLM_MODEL / GENIE_LLM_API_KEY(与 gateway 同名同源)
  ③config: codesense config set llm.baseURL/llm.model/llm.apiKey(写入 ~/.codesense/config.json,权限 600)
  ④ask-file: codesense config set llm.askFile.dir <目录>(宿主零配置:CLI 写 ask-*.json,宿主 agent 答 answer-*.json)
  不加 --deep 则只跑确定性+反模式层(零 LLM,免费)。
```

```text
$ codesense review --deep
# 代码评审报告(codesense review)

- 目标: uncommitted · 9 文件 · 2146 行 · 已截断(200KB 预算)
- 摘要: LLM 深审 1 轮+grace 确认 2 条(防幻觉删 0;定位 anchor 1/refile 0/fallback 0/llm 1/未定位 0);行级回写 +3 新增/1 已解决/0 复现
- 结论: 无 blocker(exit 0) — blocker 0 / warning 5 / nit 3

## 发现(8 条)
### Warning(应修) × 5
- **apps/gateway/src/agent-wiring.ts:1** 换头不换尾:skillViewTool 参数 1→2 个,调用方未同步
  - …
```
(下例=2026-10-16 对本仓一次真实未提交变更的实测输出截录)

### 全局参数
`--root <dir>`(缺省:注册表就近解析当前目录 → 逐级向上 → `.genie/sense-index` 隐式根)、
`--repo <name>`(多仓工作区定向单仓)、`--json`(agent 消费的结构化形态)、`--no-color`、
`--no-build`、`--quiet`、`--limit N`(entrypoints)、
`--depth N`(symbol/callers/callees/graph 的关系遍历层数上限,≥1 整数;缺省=1 即直接关系,
输出逐字节兼容——显式给出时才逐条标注 d2/d3… 层级并带 `(depth=N)` 尾注;graph 的 mermaid
边标 `d<k>`=距圆心层级,深层 BFS 每节点每向扇出 4 + 全局节点上限防爆炸)。

**MCP 透传**:`code_index_symbol`/`code_index_graph` 的 inputSchema 带可选 `depth`(不填=
现行为,gateway 薄壳自动透传);非法值(0/负/非整数)两侧同闸报错。

退出码:`0` 成功;`1` 未命中/错误(如符号不存在、doctor FAIL);`2` 用法错误/未建索引引导。

### 输出形态示例
```text
$ codesense symbol createGatewayApp
[lampgenie-harness] createGatewayApp [常规] — apps/gateway/src/app.ts:114
  被调用(38): <module>@apps/gateway/src/main.ts, openApp@apps/gateway/test/projects.test.ts:255, …
  调用(39): buildLlmFromConfig@apps/gateway/src/factory.ts:64, …

$ codesense index --register ./aa
index /path/aa
  复用 0 文件 / 新扫 1 文件(full)
  索引: 2 节点 / 1 边(构建 9.3s)
  产物: /path/aa/.genie/sense-index/434e6e6fc07f
  已登记 → ~/.codesense/registry.json
```
`--json` 形态(query)= `{ query, name, repos, hitCount, hits: [{ repo, symbol, callers, callees }] }`;
`--json` 形态(index)= `{ root, mode, reused, scanned, nodes, edges, buildMs, relinked, indexDir, registered }`。

## 3. index --register/注册表/增量复用(G4 硬需求)

- **注册表**=用户级 `~/.codesense/registry.json`(os.homedir()+path.join,跨平台)。
  理由:root 的价值在「任何目录就近解析出所属项目」,项目内 `.codesense/` 有先有鸡问题
  (首次登记前不存在、无法发现),且 aa/bb/整仓的跨目录复用天然是用户态视角。
- **指纹 sidecar(v2)**=项目内 `<root>/.genie/sense-index/<hash>/files.json`(与索引产物
  同目录,同进退)。**键=规范化绝对路径(realpath)**,`root`=构建时的规范化绝对根——同一物理
  目录经不同父 cwd/路径拼写(符号链接)发起的 index/增量命中同一批键。`classes`=类节点 rel id
  (重分类豁免集)。v1(相对路径键)载入即拒,诚实走全量并落 v2。
- **迁移(旧根→新根重映射,已选定此方案)**:目录 mv/改名后产物随目录走进旧 hash 子目录
  (indexDir 按根路径 hash)——载入 sidecar 先精确 hash、未命中扫描 sense-index 各子目录取
  「可重映射到当前根」的最新者;重映射=整键换根前缀(键都在旧根之下,父目录改名与叶子目录
  改名统一覆盖);索引产物经 `loadIndexMigrated` 同口径发现式载入。选重映射而非判过期的理由:
  mtime/size 是物理文件属性、mv 不变——重映射只影响查得到查不到,指纹相等性仍是复用的正确性
  闸门,重映射严格优于判过期(判过期=永远全量,重映射=迁移后首跑即省)。畸形形态(键不在
  旧根之下)拒收,诚实走全量。
- **增量算法**:重叠 root(注册表命中 ∪ 目标自身旧产物——自复用不需要登记)按
  「相对路径+指纹(mtime+size)」比对;未变文件**直接搬运其节点/边**(跨根按前后缀重映射 id/路径),
  变更文件走 `buildCallGraphFromFiles` 子图重扫;合并后:失效 to 降级 unresolved →
  relink(唯一裸名+同扩展名,压制名单=engine 各快照「不兜底」语义并集,绝不造 engine 会压制的边)
  → 出入度/trunk/leaf 全量重算(c2f classify 语义,类节点豁免)。
- **实测**:aa→bb→整仓三连=复用 2/新扫 2;parity 测试证明增量合并图与全量 `buildC2fIndex`
  的节点集(含分类)与边集逐一相等(仅 relink 边 kind=unique vs 全量 import 的着色差);
  dify api/core(635 个 .py)全量 31.2s/4844 节点/3967 边,自复用重跑复用 507(其中 128 个
  因 WSL 慢盘 mtime 抖动被误判变更而重扫,产物仍正确,只是变慢);
  v2 实测:符号链接拼写两次 index 命中同批指纹键;目录改名迁移后首跑=incremental 复用 3/新扫 0,
  迁移后改一个文件=只重扫该文件。
- **精度边界(诚实)**:增量模式对「变更文件→未变更文件」的调用,子图内无 import 证据,
  走唯一名兜底,同名歧义的边会缺失(`--force` 全量恢复);WSL `/mnt/*`(drvfs)的 mtime
  抖动会降低复用命中率(实测一次 635 文件中 128 个被误判变更而重扫,产物仍正确,只是变慢);
  原生文件系统(linux ext4/macOS apfs/Windows NTFS)不受影响。

## 4. 各平台接入

### MCP 形态(codex / trae / dsh / zcode / claude 系通用)
前提:`cd packages/code-sense-cli && pnpm install && pnpm build`(产物 `dist/cli.js` 自包含)。

**ZCode**(`<workspace>/.zcode/config.json`):
```json
{
  "mcp": { "servers": {
    "codesense": { "type": "stdio", "command": "node",
      "args": ["/abs/path/packages/code-sense-cli/dist/cli.js", "serve", "/abs/path/your-project"],
      "enabled": true } } }
}
```

**codex CLI**(`~/.codex/config.toml`):
```toml
[mcp_servers.codesense]
command = "node"
args = ["/abs/path/packages/code-sense-cli/dist/cli.js", "serve", "/abs/path/your-project"]
```

**trae / claude 系**(`mcpServers` JSON 形态):
```json
{ "mcpServers": { "codesense": { "command": "node",
  "args": ["/abs/path/packages/code-sense-cli/dist/cli.js", "serve", "/abs/path/your-project"] } } }
```

**dsh(deepseek-harness)等**:任何支持「stdio 子进程 + JSON-RPC/MCP」的宿主同构接入;
不支持 MCP 的宿主直接用 CLI 直调(见下)。`serve` 的工具名与参数面与 lampgenie-harness gateway
的 code-index MCP 完全一致,客户端换宿主不改提示词。

### CLI 直调(agent shell 形态)
```bash
codesense index --register /path/repo  # 一次
codesense symbol handleMessage --json        # 结构化给 agent
codesense callers handleMessage              # 谁调用它
codesense entrypoints --limit 10             # 从哪开始读
codesense file apps/gateway/src/server.ts --graph   # mermaid 文件图
```

### lampgenie-harness 内部(gateway)用法
- 面板/agent 的 `code_index` 工具(action:symbol/file/entrypoints/graph/filegraph/impact/api/project)与 ZCode 的
  `code_index_*` MCP:入口分别为 `sense-index-manager.ts` 与 `code-index-mcp.mjs`,查询语义与 CLI 同源
  (mcp-core 单一真相)。
- 索引产物同一点(`.genie/sense-index/`):CLI 的 index(--register) 与 gateway 的后台 worker 共享,
  谁先建谁受益;`files.json` 为 CLI 增量专用 sidecar,对 gateway 透明。

### 4.x LLM 语义能力接入

语义能力三件(vars 之外):`codesense api --semantics`(HTTP 接口职责描述)、
`codesense project`(项目 purpose/主线能力/偏离提示)、LLM 档位自检(`codesense doctor`)。
凭证解析链(定稿):**显式 flag > env 三件套(GENIE_LLM_BASE_URL/MODEL/API_KEY)>
配置文件 `~/.codesense/config.json` > 无 LLM(确定性降级,显式标注不冒充)**。
同一条链也是 `codesense review --deep` 的深审凭证面。

**形态①:宿主配凭证直连(推荐,一次配置)**

```bash
# 方式 A:配置文件(权限自动 600;输出永远脱敏尾 4)
codesense config set llm.baseURL https://api.example.com   # OpenAI 兼容端点(不含 /v1)
codesense config set llm.model   your-model
codesense config set llm.apiKey  sk-xxxx
codesense config list            # 核对(显示生效档位;key 只显 ****尾4)
codesense doctor                 # llm 行= direct(来源=config;...)
codesense project --write        # 实跑:LLM purpose 层生效,manifest 落盘

# 方式 B:宿主 env(codex/trae 的启动环境里带)
GENIE_LLM_BASE_URL=... GENIE_LLM_MODEL=... GENIE_LLM_API_KEY=... codesense project
```

**形态②:ask-file 中继(宿主零配置;宿主 agent 自己当 LLM)**

CLI 无凭证时,把语义问题以结构化 JSON 交给宿主,宿主 agent 读题作答:

```bash
mkdir -p /path/ask-dir
codesense config set llm.askFile.dir /path/ask-dir
```

协议:CLI 语义请求写 `ask-<id>.json` 进目录
(`{"id","prompt","schemaHint","createdAt","timeoutSec":120}`),随后轮询 `answer-<id>.json`
(内容 `{"answer":"<模型输出 JSON 字符串>"}`,或裸字符串文件),拿到即删两文件继续管线;
**120s 超时=撤题+该次语义降级**(与无 LLM 同形态,显式 degraded)。
宿主侧(codex/trae)接线两法:宿主 agent 的后台任务/watcher 轮询 ask 目录;
或在宿主系统提示写规则「见 ask-*.json 即读题作答写 answer-<同 id>.json」。

**形态③:MCP 带内 pending-ask(协议设计,实现登记后续)**:`serve` 常驻态下,语义工具
结果内嵌 `pendingAsk {askId, prompt, schemaHint, timeoutSec}`,宿主以
`code_index_semantic_reply {askId, answer}` 回灌——形态②已覆盖同需求(文件系统中继),
带内通道待宿主生态有标准后实现。

安全边界:ask/answer 内容=脱敏代码事实锚(与直连 prompt 同一份,不含任何凭证);
目录由使用者指定;凭证永不进 ask 文件。

## 5. 跨平台与分发注意

- **wasm 随包分发**:`web-tree-sitter@0.25.10` + `tree-sitter-wasms@0.1.13`(与 code-sense
  实测配对)是本包正式依赖——bin bundle 形态下 `--external:web-tree-sitter` 保留动态 import,
  由包内 node_modules 解析;`tree-sitter-wasms/out/*.wasm` 由 engine 内
  `createRequire(import.meta.url).resolve` 定位到本包。doctor 逐语言体检(python/go/java/c/cpp)。

### 5.1 C/C++ 语言支持

- **资产获取=零新增依赖**:`tree-sitter-wasms@0.1.13` 包内自带 `tree-sitter-c.wasm` /
  `tree-sitter-cpp.wasm`,装载复用 `adapters/tree-sitter.ts` 的 `loadTsParser`(与
  py/go/java 同机制、同进程缓存+失败负缓存)。不需要任何 node-gyp 本地编译或新包。
- **扩展名**:`.c/.cc/.cpp/.cxx/.h/.hh/.hpp/.hxx`(engine `GRAPH_STRUCT_EXT`、
  `adapters/cpp.ts` `CPP_EXTS`、`callgraph/coverage.ts` `C_CPP_EXTS` 三处同清单,改动须同步)。
  `.h` 双语法兜底:先 cpp 后 c,取错误少者(C 头在 cpp 语法下的误报由 c 语法救)。
- **诚实子集**(边界如实,不硬凑):函数定义+原型(原型如实登记,定义优先)、具名且有 body 的
  struct/union/enum/class、C++ 类内方法与 `Cls::method` 域外定义、模板类
  (`template<...> class X<...>` 名在 template_type 节点)、typedef(type_definition declarator 名);
  析构/运算符重载名不收(gapi operators.hpp 的 `operator+` 系列如实 skipped)。
- **错误容忍=健康节点档+declarator 容错**:文件有 ERROR 时收无 ERROR 子树的
  定义/原型/类型;**整节点含 ERROR 但 function_declarator 子树健康 → 照常提取符号但不产调用边**
  (体不可信;`void cv::resize(...)` 函数体含 ERROR 的连坐形态由此恢复, RC-E 根治)。
  声明体内 declarator 亦坏(参数表解析失败)不猜。
- **属性宏 strip**:解析前把「ALLCAPS 标识符+引入/类型关键字」与「class/struct 与类名
  之间的属性宏」替换为等长空格(编译器 -D 等价,行号不变);预处理器行不 strip
  (`#define X` 的宏名后跟 enum 会误伤,实测反例)。CV_EXPORTS/FMT_FUNC/EXPORT_VISIBILITY/
  GTEST_API_ 族由此干净入树。
- **分层覆盖**:逐文件 outcome 四档——full(结构档有符号)/
  lexical(词法兜底档)/empty(解析干净确认无声明,纯 include 聚合头/纯 #define)/
  skipped(必须带原因,占比目标 <1%);coverage=(full+lexical+empty)/磁盘源文件数。
  lexical 档符号带 `tier=lexical` 只进覆盖计数与符号查询——零调用边、不进 byName、
  不作 relink 目标、不进 entrypoints(**不参与 callers/callees 精度口径**)。
  触发:结构档 0 符号(含 >512KB 闸命中文件),regex 提取顶层原型/extern|static|const 变量/
  数组/typedef/ObjC @interface(单文件上限 2000,毫秒级)。
- **扫描上限与内存护栏**:`GENIE_SENSE_MAX_FILES`(env,≥10,缺省 6000,
  4000 硬上限曾把 opencv 4590 截断)+`GENIE_SENSE_MAX_RSS_MB`(env,≥256,缺省 4608,
  merge 循环逐文件检查,超限停止处理剩余结构档文件);截断(达上限/护栏触发/跳过明细超 50 条)
  一律登记进 coverage manifest 的 `truncated` 字段,不许「分母=截断后集合」静默。
- **跨文件声明-定义消歧**:调用点在 .c、声明锚在 .h 是 C 仓主形态——`resolveStructCrossFile`
  同扩展名档优先(定义优先语义不变),同扩展名无候选时 C 族(上列 8 扩展名)兜底、族内唯一才
  解析(saadk_c 实测 +145 边);族内仍歧义(如 2 def+2 proto)=不解析不猜。
- **fail-visible 三面**(消灭「形式成功实为空」):① index 产物 manifest 带 `coverage`
  (按扩展名 diskFiles/indexedFiles 分列)+输出 `coverageWarnings`;② doctor 覆盖率核对
  (零覆盖=语言不适配或解析全失败→WARN;C/C++ 覆盖率 <50%→WARN;旧索引缺 coverage 字段→
  WARN 建议重建);③ entrypoints 零覆盖/低覆盖语言显式状态行,不再输出误导视图。
  旧索引(无 coverage 字段)不重建可继续用,覆盖核对现场重算(降级显式)。
- **路径**:全包 `path.join/resolve/relative`+`fileURLToPath`(mcp-core 迁移时修掉了
  `URL().pathname` 的 Windows 假设);相对路径键统一 “/” 分隔。bin 在 Windows 由 pnpm 生成
  `.cmd/.ps1` shim。deep-path(>12 层)与扫描上限见 §5.1 的 RC-G 条(可配+护栏+截断登记)。
- **bin**:`dist/cli.js`=esbuild 自包含 bundle(code-sense dist 内联;ts-morph external 声明为本包依赖)。
  注意 code-sense 的 tsc dist 内部 import 无扩展名,不能被裸 node 直载——这正是 bin 走 bundle 的原因;
  程序化 import(`@lampgenie/code-sense-cli`)在 vitest/tsx 等打包器解析下用 src/dist 均可。
- **已知环境坑**:WSL 慢盘(drvfs)mtime 抖动 → 见 §3 精度边界;`ref/` 参考仓只读——
  对其建索引会产生 `.genie/` 产物,用完应清理。

## 6. 边界(不做什么)

- **白板(board)不捆绑**:白板是 gateway 会话态的交互画布(实时通道/会话/乐观锁),
  捆进来会把纯索引工具拖成重包,外部平台也用不上其交互面。CLI 保持「索引+关系查询」纯能力;
  白板的对外传播是独立路线(未来 MCP/Web 形态)。白板等交互能力在 lampgenie-harness 面板中。
- LLM 类剖面(code_sense debug/plan/explore 的模型环节)不进 CLI——那是 gateway 的 LLM 编排域;
  CLI 只做确定性静态索引面。
- npm 发布流程(2026-10-16  已备):保持私有(不发 npmjs.com);npm 包形态已就绪——
  `files` 白名单(dist/cli.js+README)、`prepack` 存在性守卫、`publishConfig` 占位私有 registry
  (Verdaccio 默认,`private:true` 下不生效,将来去 private 即推);`@lampgenie/code-sense`
  已移 devDependencies(bundle 已内联其代码,运行时只需 ts-morph/web-tree-sitter/tree-sitter-wasms),
  `npm pack` 直出可安装 tarball;安装态 bin 符号链接静默根因(isMainEntry 未 realpath 比对)已修
  (test/main-entry-symlink.test.ts 锚定)。操作手册见包 README §1。

## 7. 测试与验证锚(2026-10-15 实测)

- 单测 `packages/code-sense-cli/test/`(vitest,41 例全绿, 实测):
  `incremental.test.ts`(三连 index 复用断言/parity/recount/变更重扫/force 注册表 +
  sidecar v2 四例:符号链接拼写命中/迁移重映射/v1 拒收/不存在根拒绝,11)、
  `depth.test.ts`(schema 向后兼容/缺省零变化锚/d1 vs d2 差异/graph d 标注/双闸校验/CLI 透传,7)、
  `cli-e2e.test.ts`(进程内 runCli 全指令+退出码+json 可解析,8)、
  `coverage.test.ts`、
  `mcp-serve.test.ts`(进程内注入 stdio+真子进程 bundle 冒烟;sensing 三工具 stdio 全链+
  错误路径+CLI↔MCP 逐字节同源对照,6)。
  配套回归:gateway `code-index-mcp.test.ts` 11/11、code-sense `c2f.test.ts` 23 通过 1 SKIP、
  `cpp-adapter.test.ts` 18、
  `code-sense.test.ts` 25(核心, 实测 444s)。
- gateway 回归:`apps/gateway/test/code-index-mcp.test.ts` 11 例**不改一行**经薄壳原样通过;
  gateway 产物 `dist/code-index-mcp.mjs` 重建冒烟(initialize/tools/call)通过。
- 真仓抽查:lampgenie-harness `symbol createGatewayApp`(38 callers 跨 packages/apps)、
  `entrypoints`(handleMessage 下游 491);`symbol permissionMode --depth 2` 的 d2 层命中
  `<module>@main.ts`(组合根→createGatewayApp→permissionMode 的真实二层链),缺省输出无标注;
  dify `api/core` 635 py 文件 31.2s 索引+entrypoints(AppRunner.run 等 trunk 全中)。
