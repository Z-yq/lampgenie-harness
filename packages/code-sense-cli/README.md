# @lampgenie/code-sense-cli

**codesense** —— 把 code-sense 静态调用索引(code2flow 形态)包装成的独立 CLI / MCP 服务。
零 lampgenie-harness 运行时依赖:`dist/cli.js` 是 esbuild 自包含 bundle(`@lampgenie/code-sense`
已内联),运行时外部依赖仅三件:`ts-morph` / `web-tree-sitter` / `tree-sitter-wasms`(wasm 语法资产)。

> 私有包:不发布到 npmjs.com。分发形态 = tarball(主)或内网私有 registry(就绪,见下)。

---

## 1. 安装

### 形态 A:tarball(主交付,零 registry 依赖)

```bash
# 产出侧(仓内,需要已构建的 dist/cli.js):
cd packages/code-sense-cli
npm pack                 # 或 pnpm pack:tarball → lampgenie-harness-code-sense-cli-<version>.tgz

# 消费侧(同事机器 / 工具链容器,Node ≥20):
npm install -g /path/lampgenie-harness-code-sense-cli-<version>.tgz
codesense --help
```

tarball 内容白名单(`files` 字段):`dist/cli.js` + `README.md`(+ npm 自动带上的 `package.json`)。
安装时 npm 会从默认 registry 拉三件第三方依赖;纯离线环境用
`npm install -g <tarball> --offline`(需本地 npm 缓存已有三件)或在有网机器先
`npm install -g <tarball>` 再整体打包 `$(npm root -g)/@lampgenie/code-sense-cli` 目录拷贝。

### 形态 B:私有 registry(就绪,未启用)

`package.json` 已占位:

```json
"publishConfig": { "registry": "http://localhost:4873/", "access": "restricted" }
```

将来要推到内网 registry(如 Verdaccio)时的操作序列:

```bash
# 1. 把 publishConfig.registry 改成真实内网地址(或发布时用 --registry 覆盖)
# 2. 临时去掉 "private": true(private 包 npm/pnpm 均拒绝发布)
# 3. npm publish        # 或 pnpm publish(pnpm 会顺带重写 workspace 协议;本包已无 workspace 运行时依赖)
# 消费侧: npm install -g @lampgenie/code-sense-cli --registry=http://内网地址/
```

> 当前 `private: true` 是拍板状态——publishConfig 只在「将来要发时」生效。

### 形态 C:仓内开发(monorepo workspace)

```bash
pnpm install && pnpm build     # dist/cli.js = esbuild 自包含 bin
```

## 2. 使用

```bash
codesense index /path/repo --register   # 探索+建索引(增量复用)+登记进注册表
codesense symbol handleMessage --json
codesense callers handleMessage
codesense impact handleMessage --depth 2   # 改动影响面(改函数前必查)
codesense entrypoints --limit 10
codesense file apps/gateway/src/server.ts --graph   # mermaid 文件图
codesense flow                 # 整仓代码流(module/file/function 三层 + 入口/分层/主干)
codesense flow --level file --max-nodes 50 --out flow.mmd
codesense serve /path/repo     # MCP stdio(codex/trae/dsh/zcode 等直接接入)
codesense doctor               # wasm/注册表/索引 自检
codesense review               # 代码评审(确定性+反模式八类;--deep 走 LLM)
```

完整指令清单见 `codesense --help`(管理 / 查询 / 代码档案 / 服务 / 评审 + 全局选项)。
注册表 = `~/.codesense/registry.json`;索引产物 = `<root>/.genie/sense-index/`。

## 3. 命令清单(速查)

| 组 | 命令 | 一句话 |
|---|---|---|
| 管理 | `index` / `roots` / `remove` / `doctor` | 建索引并登记(`--register`)/ 清单 / 注销 / 自检 |
| 查询 | `symbol` / `callers` / `callees` / `impact` | 符号详情与调用关系(`symbol --graph` 出邻域图;`--depth N` 遍历层数) |
| 查询 | `entrypoints` / `file` / `branches` / `modules` | 入口清单 / 文件符号表 / 分支骨架 / 模块矩阵 |
| 流程 | `flow` | 整仓代码流(module/file/function 三层 + 入口/分层/主干/管线簇;缺省全量不设上限;`--out` 出 mermaid/DOT/JSON) |
| 表面 | `api` / `bridge` / `state` / `algo` / `vars` / `tokens` / `project` | HTTP 接口 / 跨语言桥边 / 状态机 / 算法画像 / 变量类型 / token 流 / 项目底座认知 |
| 档案 | `wiki list/get/rebuild/audit/ask` | 持久 repo wiki + 全仓代码流/语义指南/功能拆解页 |
| 服务 | `serve` | MCP stdio 服务(工具面十五件,与 lampgenie-harness gateway 同源) |
| 评审 | `review` | diff 收集→确定性+反模式八类→可选 LLM 深审;exit 1=有 blocker(CI 门禁) |

## 4. LLM 凭证配置(语义能力:`api --semantics` / `project` / `review --deep`)

凭证解析链:**显式 flag > env 三件套 > 配置文件 > 无 LLM(确定性降级,显式标注)**。

```bash
# 方式 A:配置文件(自动权限 600,输出永远脱敏尾 4)
codesense config set llm.baseURL https://api.example.com   # OpenAI 兼容端点
codesense config set llm.model   your-model
codesense config set llm.apiKey  sk-xxxx
codesense config list            # 核对生效档位

# 方式 B:宿主 env(codex/trae 启动环境里带)
GENIE_LLM_BASE_URL=... GENIE_LLM_MODEL=... GENIE_LLM_API_KEY=... codesense project

# 方式 C:ask-file 中继(宿主零配置,宿主 agent 自己当 LLM)
codesense config set llm.askFile.dir /path/ask-dir
# CLI 写 ask-<id>.json,宿主答 answer-<id>.json,120s 超时=该次语义降级
```

无凭证时纯静态面(索引/调用图/接口面/状态机)全部照常;只有语义描述类显式降级。

## 5. 多平台接入(MCP)

`codesense serve` 是 stdio MCP 服务,任何支持「stdio 子进程 + MCP」的宿主同构接入。
工具名与参数面与 lampgenie-harness gateway 的 code-index MCP **完全一致**,客户端换宿主不改提示词。

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

tarball 全局安装后 `command` 可直接写 `codesense`(npm 全局 bin 在 PATH):
`"args": ["serve", "/abs/path/your-project"]`。

不支持 MCP 的宿主直接用 CLI 直调(`--json` 给 agent 消费)。

## 6. 形态边界(诚实)

- **tarball/registry 形态 = CLI 专用**:`package.json` 的 `exports` 映射面向仓内 workspace
  (development 条件直解 `src/*.ts`);tarball 内只发 `dist/cli.js`,把本包当库
  `import "@lampgenie/code-sense-cli/..."` 会 miss——程序化集成请在 monorepo 内走 workspace。
- 白板(board)等交互能力属 lampgenie-harness 面板的会话态功能,**不在本 CLI 范围**;
  本工具只做「索引+关系查询」纯能力。
- LLM 类剖面(code_sense debug/plan/explore 的模型编排环节)不进 CLI——那是 gateway 的域。
- 增量复用按「规范绝对路径+mtime+size 指纹」(sidecar v2,realpath);WSL `/mnt/*` 慢盘
  mtime 抖动会降低复用命中率(产物仍正确,只是变慢)。

## 7. 仓内开发

- 单一真相:`@lampgenie/code-sense` 核心库;本包 `src/mcp-core.ts` 是工具面唯一实现,
  gateway 只剩再导出薄壳(指令集/MCP 工具面/gateway 内部工具三方同源)。
- 详细规格/三方映射表/精度边界:仓根 `docs/codesense-cli.md`。
- 构建注意:code-sense 的 tsc dist 内部 import 无扩展名,不能被裸 node 直载——
  这正是 bin 走 esbuild bundle 的原因;`pnpm build` 末尾的 esbuild 步失败会 `|| true` 吞掉,
  构建后请确认 `dist/cli.js` mtime 已刷新。
