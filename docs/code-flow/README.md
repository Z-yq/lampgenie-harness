# lampgenie-harness 全仓代码流(2026-10-26)

code-sense 的整仓 flow 能力产物:三层聚合(module/file/function)+ code2flow 语义
(每文件 `<module>` 组合根、trunk/leaf/regular 三色、File/Class 分组、默认裁零连接、
入口/分层/主干/枢纽)。图是确定性构建的,同源数据也沉淀在代码档案里。

## 本目录产物

| 文件 | 内容 | 规模 |
| --- | --- | --- |
| `lampgenie-harness-module.png` / `.svg` / `.mmd` | **模块级全仓流**(主图) | 18 节点 / 18 边 · 入口 3 |
| `lampgenie-harness-files.png` / `.mmd` | 文件级全量流(不设上限) | 见文件 |
| `gateway-functions.png` / `.mmd` | `apps/gateway` 函数级流(Top 50 预算) | 47 节点 / 80 边 |

主图读数:

- 入口:`apps/gateway`(组合根)、`apps/relay`(组合根)、`scripts`(组合根);
- 主干:`gateway → core ×54`、`gateway → harness-runtime ×48`、`gateway → code-sense ×28`、
  `scripts → code-sense ×19`;`code-sense-cli → code-sense ×114` 是库内复用最密的一条;
- 跨语言:`code-sense → services` GET `/health`、`harness-runtime → services` POST `/decide` 两条 HTTP 桥(虚线);
- 口径:测试文件、`tasks/`、`docs/`、`examples/` 等非产品路径默认不进图;未解析调用 36741 条
  (外部库/动态形态)只计入脚下,不画边;零连接节点默认裁掉。

> 图给人看;结构化数据用 `codesense flow --json`。代码档案里的
> `.genie/wiki/lampgenie-harness/flow.md`、`flow/*.md` 是同一份 flow 的持久页面,
> 面板「代码档案 · Wiki 文档」tab 直接渲染 mermaid。
>
> 面板查看:代码档案 → Wiki 文档(分组「全仓流程 / 语义指南 / 功能拆解」)。注意 Wiki 按
> **当前项目**取数——当前项目不是 lampgenie-harness 时,先在侧栏「+ 添加项目」加入
> `/mnt/e/workship/genie/lampgenie-harness`,或直接用 CLI `codesense wiki get flow` /
> `codesense wiki get features`。

## 重新生成

```bash
# 1) 模块级(默认 auto;lampgenie-harness 模块数≥6 → module)
node packages/code-sense-cli/dist/cli.js flow --root . --out docs/code-flow/lampgenie-harness-module.mmd

# 2) 文件级 / 函数级(预算与 scope)
node packages/code-sense-cli/dist/cli.js flow --root . --level file --max-nodes 50 \
  --out docs/code-flow/lampgenie-harness-files.mmd
node packages/code-sense-cli/dist/cli.js flow --root . --level function --scope apps/gateway --max-nodes 50 \
  --out docs/code-flow/gateway-functions.mmd

# 3) mermaid → SVG/PNG(零联网;用仓内 mermaid.min.js + playwright-core)
CHROME_PATH=$(ls -d ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome | head -1) \
  node scripts/render-mermaid.mjs docs/code-flow/lampgenie-harness-module.mmd \
  docs/code-flow/lampgenie-harness-module.png --width 2200

# 4) 沉淀到代码档案(flow/模块 flow/语义指南/功能拆解;--no-flow 可关)
node packages/code-sense-cli/dist/cli.js wiki rebuild --root . --no-llm
```

## 与 /ref 参考实现的关系

- `code2flow`(致谢):root 节点 / trunk-leaf-regular 三色 / File+Class 分组 / 默认裁零连接 /
  `--target-function --upstream --downstream` 子图 / graphviz DOT 语义均已移植;
  整仓尺度额外做了 module/file/function 三层聚合与入口可达优先预算。
- `deepwiki-open`(致谢):wiki 结构(overview/架构/功能页)+ 页内 mermaid/表格/引用 +
  「每页只依据 relevant files、必须引用行号」的纪律,落到 guide/features 的 LLM 叙述层;
  flow 骨架与图由确定性构建器提供,LLM 不改边/不改文件清单。
- 未做(明确边界):单函数控制流图(分支/循环的 CFG)尚未画成图;`codesense branches`
  已有决策点骨架文本,后续可作为功能线页的「关键函数分支骨架」子块接入。