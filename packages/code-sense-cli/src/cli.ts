#!/usr/bin/env node
/**
 * codesense——code-sense 静态调用索引的独立 CLI(零 lampgenie-harness 运行时依赖)。
 * 指令集与 MCP 工具面(code_index_*)、lampgenie-harness gateway 内部工具三方同源:
 * 单一真相=packages/code-sense 核心库;本 CLI 与 src/mcp-core.ts 都是薄适配。
 * 详见 docs/codesense-cli.md(仓根)或本包 README。
 */
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseArgs, flagStr, flagBool, expandTilde, type ParsedArgs } from "./args.js";
import { makePalette } from "./color.js";
import { buildIndexWithReuse, IndexBusyError } from "./incremental.js";
import { estimateIndexMemory } from "./heap-budget.js";
import { loadRegistry, makeEntry, normalizeRoot, purgeRootData, registryPath, removeRoot, resolveProjectRoot, upsertRoot, type RegistryEntry } from "./registry.js";
import { ResolveError, queryAlgoCmd, queryApiCmd, queryBridgeCmd, queryCfgCmd, queryEdgeCmd, queryEntrypointsCmd, queryFileCmd, queryFlowCmd, queryGraphCmd, queryImpactCmd, queryModulesCmd, queryProjectCmd, queryRefsCmd, queryStateCmd, querySymbolCmd, queryTokensCmd, queryVarsCmd, queryBranchesCmd, resolveContext, writeCfgOut } from "./query.js";
import { LlmConfigError, maskKey, readConfigFile, resolveLlmConfig, setConfigKey, unsetConfigKey, configPath } from "./llm-config.js";
import { formatCoverageLine, coverageWarnings } from "@lampgenie/code-sense/callgraph/coverage";
import { loadIndex } from "@lampgenie/code-sense/callgraph/c2f";
import { codeFlowJson, renderCodeFlowDot, renderCodeFlowMermaid, type CodeFlow } from "@lampgenie/code-sense/callgraph/flow";
import { runDoctor } from "./doctor.js";
import { isMainEntry, serveMain } from "./serve.js";
import { ReviewUsageError, reviewCommand } from "./review.js";
import { WikiUsageError, wikiCommand } from "./wiki.js";

/** 表面分类的唯一真相(核心库导出;数量/顺序变化时本文件的用法文案自动跟随,不写死数字)。 */
import { SURFACE_CATEGORIES } from "@lampgenie/code-sense/surface";

export const VERSION = "0.2.0";

export const HELP = `codesense v${VERSION} — 代码静态调用索引 CLI(code2flow 形态;lampgenie-harness code-sense 独立发行)

用法: codesense <指令> [参数] [全局选项]

管理
  index [root]          建索引(--force 全量重建;默认按文件指纹增量复用;
                         --register 登记进注册表=任意目录就近解析)
  roots                  列出已登记的根及索引规模(doctor 的快档)
  remove <root>          注销根(--purge 连索引数据一起删)
  doctor [root]          环境自检(wasm/注册表/索引/可写性)

查询(索引缺失自动构建一次;--no-build 关闭)
  symbol <name>          符号详情:定义+调用方+被调方(--json 给 agent;精确未命中时给
                         「你是不是想找」容错建议)——--graph 出 mermaid 邻域图
  impact <name>          改动影响面:签名+双向调用闭包(逐跳 dN)+受影响文件+关联测试——
                         改/删/重构一个函数前先查它(--depth N 闭包深度,缺省 2)
  callers <name>         谁调用它(symbol/impact 的半边快捷面)
  callees <name>         它调用谁(symbol/impact 的半边快捷面)
  explore "<问题>"       自然语言探索(2026-10-21):「不认识这个仓,从哪看起」的第一入口——
                         关键词变体 grep 检索+低命中自举二轮,输出命中文件/行+热区文件
                         (索引非前置;与 gateway code_index mode=explore 同一管线)
  entrypoints [root]     入口函数清单(trunk,从哪开始读;--limit N)——首节=进程入口
                         (py __main__/js require.main/c·go·java main/package.json bin,启动器视角)
  modules [root]         模块视图(2026-10-22):模块清单+跨模块交互矩阵(A→B=A 调用 B,边数)+
                         枢纽(被依赖最多)+测试面;--graph 出 mermaid 架构图——
                         「这个仓有哪些模块、怎么交互」的架构级答案
  flow [scope]           整仓代码流(2026-10-26):module/file/function 三层聚合,按 code2flow
                         语义画全项目调用流——每文件 <module> root 节点、trunk/leaf/regular 三色、
                         File/Class 分组、默认裁零连接节点、入口/分层(d0..)/主干路径/枢纽。
                         默认输出文本摘要 + mermaid;只读静态索引。
                         --level module|file|function|auto(缺省 auto:模块≥6 看模块,否则文件/函数)
                         --scope <dir>  只画子树;--include/--exclude <正则> 过滤路径
                         --max-nodes N / --max-edges N  显式收窄(缺省 0=不设上限,诚实全量画出;
                                                      收窄时省略数如实报)
                         --target <name> --upstream N --downstream N  目标上下游子图(code2flow 同款)
                         --keep-isolated  保留零连接节点;--include-tests/--all 放开测试/非产品路径
                         --dot  追加 graphviz DOT;--out flow.mmd|.dot|.json|.svg|.png  落盘
  file <path>            文件符号表(分类+出入度)——--graph 出 mermaid 文件级关系图
  branches <path>        分支/循环骨架(2026-10-21):if/elif/else 条件+while/do-while/for/
                         for-of/for-in/switch/case+三元,每点带条件文本/行距/嵌套深度/
                         迭代目标(←被迭代对象)/该分支直接调用的函数/所属函数——
                         「这个调用在什么条件下发生」的控制流答案(py/ts/js/c/cpp/java/go;
                         tree-sitter 不可用时行级降级);refs 的代码命中同步带决策点标注
  cfg <函数名>           函数级控制流图(2026-10-27):把函数体画成**语句级**流程——真实语句文本+
                         if/elif/else 菱形条件(是/否边)+ while/for 回边(循环/退出)+
                         switch/case(default 兜底)+ try/catch/finally(异常边)+
                         return/throw/break/continue + 函数速览/模块常量 note。
                         长函数自动分页(每页 ≤~22 节点,跨页「←/→ 第 N 页」跳转桩,不丢节点)。
                         --file <path>/--line N  定位同名函数(缺省用索引);--depth N 同仓被调函数也画;
                         --full 完整单图;--no-merge 连续语句不合并(逐语句一框);--max-nodes N 显式上限;
                         --out cfg.mmd|.md|.json|.dot|.svg|.png  落盘
  api                    HTTP 接口表面:服务有哪些接口(method/path/handler/file:line)+
                         OpenAPI 对账+handler 影响面(索引在场时)——确定性行扫描,不触发索引构建
                         --semantics  LLM 语义描述(批量 ≤12/请求,上限 40 端点;
                                      无凭证=显式 off 不报错;--write 落盘语义缓存
                                      .genie/sense-index/api-semantics.json,按 git sha+端点指纹)
  bridge                 跨语言桥边(/107):前端 fetch 字面量 ↔ 后端 route 的确定性配对,
                         每条边带双端 file:line+confidence;纯行扫描,不触发索引构建
                         --forms http-api,ws,spec,ipc,capi,grpc  形态选择(缺省 http-api;all=全形态:
                         ws=WebSocket 通道/spec=OpenAPI 对账/ipc=Electron IPC/capi=Python C-API/grpc=gRPC)
                         --candidates 追加 LLM 消歧候选区(tier=semantic,带前端/后端双端证据链与
                         reason;确定性边仍默认输出且不进候选区;--candidates=all 追加 1 段前缀
                         low 档)。同义开关 --semantic;--json 时候选在 semanticCandidates 字段
  wire                   WS 消息协议表面:协议声明(ClientMessage/ServerMessage union)↔
                         服务端 handler ↔ 面板发送/接收 三处对账;纯行扫描,不触发索引构建
                         人类面=按 union 分组的 type/handler/发送点/接收点/状态表 + 孤儿四类
                                 (另附「接收未声明」提示)
                         --changed  只列 git 工作区改动涉及的 type(按 type 字面量集合 diff,
                                    分「新增/删除/改动」;刚加一条 WS 消息时看三处是否齐)
  refs <字面量>          字面量引用面(2026-10-21):删除/修改一个字符串标识(如
                         action === "graph")时 symbol/impact 全空——按语境(case-literal/
                         eq-literal/z-literal/object-key/string-literal/doc)列出全部引用点,
                         带 file:line+所属符号,覆盖产品源码/测试/文档/提示词文本。
                         默认排除 node_modules/dist/.genie/vendor;--no-tests/--no-docs 可关
  surface <概念词…>      概念足迹面(2026-11-06):替换/迁移/下线一个概念(消息名、journal
                         kind、配置键、面板文案、资源名、测试断言、文档章节)时,把落点按
                         ${SURFACE_CATEGORIES.length} 类表面
                         (${SURFACE_CATEGORIES.join("/")})一次列全,每类带 file:line 与
                         动作建议(change/remove/keep-legacy)。
                         与 refs 的区别:refs 按「语境」看一个字面量的引用形态(所有仓内
                         出现都算),surface 按「功能面」回答「这个概念要动的地方齐了吗」;
                         多个概念词可一次扫,--walk 换目录遍历引擎(缺省 grep 通道,毫秒级)
  config                 LLM 凭证配置(~/.codesense/config.json,权限 600,输出脱敏):
                         config set llm.baseURL|llm.model|llm.apiKey <值>
                         config get <键> / config list / config unset <键> / config path
  state                  状态机表面:transitions 表/switch 转移/状态模式类族/XState/Redux slice
                         (五形态确定性提取,触发点带 file:line;mermaid 可上白板)
  algo [file]            算法画像:模型定义/训练/推理/数据管线/CV-DSP 角色识别(信号带证据行)
  vars <file>            文件变量类型清单:类型分组的变量/字段/枚举常量/typedef,
                         每条带声明类型(C: int/char*/struct X/数组/函数指针;TS 泛型联合;
                         Py 注解;Go/Java 静态类型)——逐文件深提取,不触发索引构建
                         --locals 扩入函数内注解面(带注解 param/local;推断局部不入)
  tokens <file>          semantic-token 流导出:span+kind+dataType 的 JSON
                         (--json 全量;文本面=摘要),供 UI 语义着色/外部编辑器集成
  project [root]         项目底座认知:README 首段/包清单/框架指纹/入口/目录拓扑
                         → 确定性骨架(全带证据行)+LLM purpose(凭证链自动生效,指纹缓存;
                         --no-llm 关)——「这个项目大概是干什么的」防开发偏离主线
                         --write  落盘 .genie/sense-index/profile.json(gateway 注入与
                                  code_index action=project 消费;不落盘只读展示)
  wiki <子命令>          持久 repo wiki / 代码档案:.genie/wiki/<repo>/ 页结构
                         (概览/文件树/模块页/入口/依赖图 + 全仓代码流/模块 flow/语义指南/
                          功能拆解),每页带可校验 file:line 引用;按 git sha+输入指纹缓存
                         list [--root dir]                 已生成页清单/manifest 摘要
                         get <page-id> [--root dir]        页 markdown(引用可直接回源)
                         rebuild [--root dir] [--refresh]  生成/增量重建(--refresh 全量)
                                 [--no-llm] [--pages N] [--no-flow]
                                 LLM 叙述(缺省 4 页:概览→语义指南→功能拆解→模块页;
                                 无凭证=确定性骨架);flow 页走静态索引(缺索引=词法级)
                                 既有 LLM 页默认受保护(无凭证不覆盖);确认降级覆盖需
                                 --refresh --no-llm 组合
                         audit [page-id] [--root dir]      逐条回查引用(行号+anchor)
                         ask "<问题>" [--root dir]         词法问答(页打分 + grep;不做 embedding)

服务
  serve [root]           MCP stdio 服务(codex/trae/dsh/zcode 等 MCP 客户端直接接入;
                         工具面十五件:code_index_symbol/file/entrypoints/modules/impact +
                         api/state/algo()+ vars/project()+
                         wire(2026-10-21,WS 协议三处对账)+ refs(字面量引用面)+
                         branches(2026-10-23,分支/循环骨架)+
                         surface(2026-11-06,概念足迹 ${SURFACE_CATEGORIES.length} 类表面)——
                         mermaid 图类移出 MCP 面:agent 少消费关系图,
                         图给人看走 CLI symbol --graph / file --graph;与 gateway 同源,详见 docs)

评审(与 gateway code_review 工具/验收钩子同一引擎,diff 收集→确定性+反模式八类→可选 LLM 深审)
  review [target]        审查代码变更:target 缺省=未提交变更;commit hash→审该提交;
                         分支名→审 <分支>...HEAD。人读=markdown;--json=agent 消费。
                         --deep        LLM 多轮深审(需 env GENIE_LLM_BASE_URL/MODEL/API_KEY)
                         --rounds N    深审轮数(缺省 2)
                         --impact      深审注入 code_sense 影响面(只读现有索引,不触发构建)
                         --scan [path] 全文件扫描(非 diff;含 --include/--exclude glob 与
                                       --max-files/--max-tokens/--max-file-size 预算)
                         --resume <id> 续跑上次审查会话(对比:新增/已修复/未变/复现)
                         --compare <id> 与指定会话对比(不写血缘)
                         --sessions    列出本仓审查会话
                         退出码: 0=无 blocker;1=有 blocker(CI 门禁)或运行错误;2=用法/配置错

全局选项
  --root <dir>           项目根(缺省:注册表就近解析当前目录 → .genie/sense-index 隐式根)
  --repo <name>          多仓工作区时定向单仓(当前根未展开时回查注册表,任意已登记根可用)
  --json                 结构化输出(agent 消费)
  --no-color             关闭着色(默认 TTY 自动)
  --no-build             查询时不自动建索引
  --depth N              symbol/callers/callees/graph 的关系遍历层数上限(≥1 整数;缺省=1 即直接
                         关系;>1 时输出逐条标注 d2/d3… 层级,渲染沿用 ×N 合并与节点上限防爆炸)
  --quiet                少打日志
  --all                  api/state/algo/bridge/entrypoints:包含非产品路径条目(docs/examples/
                         tutorial/test mocks 等;缺省过滤并如实报「已过滤 N 条」)

说明:白板(board)等交互能力属 lampgenie-harness 面板的会话态功能,不在本 CLI 范围;
本工具只做「索引+关系查询」纯能力。文档:docs/codesense-cli.md。`;

export interface CliIo {
  out(s: string): void;
  err(s: string): void;
}

export function defaultIo(): CliIo {
  return { out: (s) => process.stdout.write(s + "\n"), err: (s) => process.stderr.write(s + "\n") };
}

/** 大仓索引自动抬堆(7700 审计):1439 个源文件的 ts 仓在默认 2GB 堆上 ts-morph
 * 全量解析 OOM(经验证峰值 RSS 2.6GB)。估算建议堆帽 > 当前堆上限时,用同级 node 带
 *  --max-old-space-size 重跑一次(index 命令);env 标记防递归,子进程输出直接透传。
 *  估算失败/已显式设堆=保持原行为。 */
async function ensureIndexHeap(root: string, io: CliIo, quiet: boolean): Promise<void> {
  if (process.env.GENIE_SENSE_CLI_HEAP_REEXEC === "1") return;
  if (process.execArgv.some((a) => a.includes("--max-old-space-size"))) return;
  if (process.env.NODE_OPTIONS && /max-old-space-size/.test(process.env.NODE_OPTIONS)) return;
  try {
    const est = await estimateIndexMemory(root);
    const { getHeapStatistics } = await import("node:v8");
    const cur = Math.round(getHeapStatistics().heap_size_limit / 1048576);
    if (est.recommendedHeapMb <= cur) return;
    if (!quiet) io.err(`[codesense] 大仓自动抬堆 ${cur}MB → ${est.recommendedHeapMb}MB(估算 ${est.estMb}MB;重跑一次)`);
    const child = spawnSync(process.execPath, [`--max-old-space-size=${est.recommendedHeapMb}`, ...process.argv.slice(1)], {
      stdio: "inherit",
      env: { ...process.env, GENIE_SENSE_CLI_HEAP_REEXEC: "1" },
    });
    process.exit(child.status ?? 1);
  } catch {
    /* 估算失败=按当前堆继续(旧行为) */
  }
}

export async function runCli(argv: string[], io: CliIo = defaultIo()): Promise<number> {
  const p: ParsedArgs = parseArgs(argv);
  const c = makePalette(flagBool(p, "no-color"));
  const json = flagBool(p, "json");
  const quiet = flagBool(p, "quiet");
  const cmd = p._[0] ?? "help";

  /** --depth 解析(仅在支持的指令上取值):undefined=缺省(现行为);非法= usage 错。 */
  const depthArg = (): number | undefined | "invalid" => {
    const raw = p.flags.depth;
    if (raw === undefined) return undefined;
    if (raw === true) return "invalid"; // --depth 后无值
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 ? n : "invalid";
  };

  const rootArg = (): string | undefined => {
 // 波浪号自展(非 shell 调用形态 shell 不代展开)——--root 与位置参数两源统一。
    const r = flagStr(p, "root") ?? (cmd === "entrypoints" || cmd === "index" || cmd === "serve" || cmd === "doctor" || cmd === "project" ? p._[1] : undefined);
    return r !== undefined ? expandTilde(r) : undefined;
  };

  try {
    switch (cmd) {
      case "help":
      case "--help":
      case "-h":
        io.out(HELP);
        return 0;
      case "--version":
      case "version":
        io.out(VERSION);
        return 0;

      case "index": {
        const root = normalizeRoot(rootArg() ?? process.cwd());
        const force = flagBool(p, "force");
        // --register 登记进注册表(任意目录就近解析);重叠子树增量复用
        const register = flagBool(p, "register");
        await ensureIndexHeap(root, io, quiet);
        const out = await buildIndexWithReuse(root, {
          force,
          onProgress: quiet ? undefined : (m) => io.err(c.dim(`[codesense] ${m}`)),
        });
        const nodes = out.index.nodes.length;
        const edges = out.index.edges.length;
        const entry: RegistryEntry = makeEntry(root, {
          lastIndexedAt: Date.now(),
          stats: { files: Object.keys(out.index.byFile).length, nodes, edges },
          lastBuild: { reused: out.reused.length, scanned: out.scanned.length, buildMs: out.buildMs, mode: out.mode },
        });
        if (register) {
          upsertRoot({ ...entry, registeredAt: loadRegistry().roots.find((e) => normalizeRoot(e.root) === root)?.registeredAt ?? Date.now() });
        } else {
          // index(未 --register)不新增登记,但已登记的根刷新统计(roots 面不陈旧)
          const known = loadRegistry().roots.find((e) => normalizeRoot(e.root) === root);
          if (known) upsertRoot({ ...entry, registeredAt: known.registeredAt });
        }
        if (json) {
          io.out(JSON.stringify({
            command: cmd, root, mode: out.mode, reused: out.reused.length, scanned: out.scanned.length,
            nodes, edges, buildMs: out.buildMs, relinked: out.relinked, indexDir: out.indexDir,
            extractorVersion: out.extractorVersion,
            ...(out.versionMigration ? { versionMigration: out.versionMigration } : {}),
            coverage: out.index.coverage,
            coverageWarnings: out.index.coverage ? coverageWarnings(out.index.coverage) : [],
            registered: register, registry: register ? registryPath() : undefined,
          }, null, 2));
        } else {
          io.out(`${c.bold(cmd)} ${c.dim(root)}`);
          io.out(`  ${c.green("复用 " + out.reused.length + " 文件")} / ${c.cyan("新扫 " + out.scanned.length + " 文件")}(${out.mode}${force ? ",--force" : ""})`);
          if (out.versionMigration) {
            io.out(c.yellow(`  抽取器版本升级: v${out.versionMigration.from} → v${out.versionMigration.to},已版本升级全量重扫一次(下次恢复增量复用)`));
          }
          io.out(`  索引: ${nodes} 节点 / ${edges} 边(构建 ${(out.buildMs / 1000).toFixed(1)}s${out.relinked ? `,relink ${out.relinked}` : ""})`);
          const covLine = formatCoverageLine(out.index.coverage);
          if (covLine) io.out(`  覆盖: ${covLine}`);
 // fail-visible:零覆盖/低覆盖显式告警,不再 exit 0 无声跳过
          for (const w of out.index.coverage ? coverageWarnings(out.index.coverage) : []) {
            io.err(c.yellow(`  [warn] 覆盖: ${w}`));
          }
          io.out(`  产物: ${out.indexDir}`);
          io.out(register
            ? `  ${c.green("已登记")} → ${registryPath()}`
            : c.dim("  (未登记——codesense index --register 或 init 可登记,便于任意目录就近解析)"));
        }
        return 0;
      }

      case "roots": {
        const reg = loadRegistry();
        if (json) {
          io.out(JSON.stringify({ registry: registryPath(), roots: reg.roots }, null, 2));
          return 0;
        }
        if (reg.roots.length === 0) {
          io.out("注册表为空——运行 codesense index --register [root] 登记第一个根。");
          return 0;
        }
        io.out(c.dim(`注册表: ${registryPath()}`));
        for (const e of reg.roots) {
          io.out(`  ${c.bold(e.name)}  ${e.root}`);
          io.out(`    ${e.stats.nodes} 节点 / ${e.stats.edges} 边 / ${e.stats.files} 文件 · 上次构建 ${e.lastBuild.mode}(复用 ${e.lastBuild.reused}/新扫 ${e.lastBuild.scanned})· ${new Date(e.lastIndexedAt).toLocaleString()}`);
 // 覆盖行( status 面):manifest 有则显,旧索引显「无覆盖数据(建议重建)」
          const idx = loadIndex(e.root);
          const covLine = formatCoverageLine(idx?.coverage);
          if (covLine) {
            io.out(`    覆盖: ${covLine}`);
            for (const w of idx?.coverage ? coverageWarnings(idx.coverage) : []) io.out(`    ${c.yellow("[warn] 覆盖: " + w)}`);
          } else if (idx) {
            io.out(c.dim(`    覆盖: 无数据(旧格式索引——codesense index 重建后提供)`));
          }
        }
        return 0;
      }

      case "remove": {
        const target = p._[1];
        if (!target) {
          io.err("用法: codesense remove <root> [--purge]");
          return 2;
        }
        const norm = isAbsolute(target) ? normalizeRoot(target) : normalizeRoot(resolve(process.cwd(), target));
        const gone = removeRoot(norm);
        if (!gone) {
          io.err(`未登记: ${norm}(codesense roots 查看已登记的根)`);
          return 1;
        }
        if (flagBool(p, "purge")) {
          purgeRootData(norm);
          io.out(`已注销并删除索引数据: ${norm}`);
        } else {
          io.out(`已注销: ${norm}(索引数据保留在 .genie/sense-index;--purge 连数据删)`);
        }
        return 0;
      }

      case "symbol":
      case "callers":
      case "callees": {
        const name = p._[1];
        if (!name) {
          io.err(`用法: codesense ${cmd} <符号名> [--root dir] [--repo name] [--json]${cmd === "symbol" ? " [--graph]" : ""}`);
          return 2;
        }
        const d = depthArg();
        if (d === "invalid") {
          io.err("用法: --depth 必须是 ≥1 的整数(缺省=1 即直接关系)");
          return 2;
        }
        const ctx = await resolveContext({ root: rootArg(), noBuild: flagBool(p, "no-build"), quiet });
        printNotes(io, c, ctx);
        const repo = flagStr(p, "repo");
 // E②:symbol --graph = graph <符号名>(mermaid 邻域图;graph 子命令保留为别名)
        const r = cmd === "symbol" && flagBool(p, "graph")
          ? queryGraphCmd(ctx, name, repo, json, d)
          : cmd === "symbol"
            ? querySymbolCmd(ctx, name, repo, json, d)
            : queryEdgeCmd(ctx, name, cmd as "callers" | "callees", repo, json, d);
        return emit(io, r, json);
      }

      case "explore": {
 // C/E:自然语言探索——「不认识这个仓,从哪看起」的第一入口。
 // 符号优先:查询先走 cjk 分词+中英词典 → 静态索引打分出候选符号(gateway
        // code_index mode=explore 同一管线),再叠加原有 grep 行命中(保留但在输出中降权排后)。
        const q = p._.slice(1).join(" ").trim();
        if (!q) {
          io.err('用法: codesense explore "<自然语言问题/关键词>" [--root dir] [--json]');
          return 2;
        }
        const explicit = rootArg();
        let root: string;
        if (explicit) {
          root = explicit;
          if (!existsSync(root)) {
            io.err(c.red(`root 不存在: ${root}(--root 指向的目录不在盘上;波浪号路径已自动展开)`));
            return 2;
          }
        } else {
          root = resolveProjectRoot(process.cwd())?.root ?? process.cwd();
        }
        const { codeSense } = await import("@lampgenie/code-sense");
        const r = await codeSense(root, q, { mode: "explore" });
        const matches = r.matches ?? [];
        const symbols = r.symbols ?? [];
        const nextSteps = exploreNextSteps(symbols);
        if (json) {
          io.out(JSON.stringify({
            query: "explore", question: q, root, mode: "explore",
            matchCount: matches.length, matches: matches.slice(0, 30),
            symbolCount: symbols.length, symbols,
            nextSteps,
            ...(r.note ? { note: r.note } : {}),
            ...(r.degraded?.length ? { degraded: r.degraded } : {}),
          }, null, 2));
          return matches.length === 0 && symbols.length === 0 ? 1 : 0;
        }
        const byFile = new Map<string, number>();
        for (const m of matches) byFile.set(m.file, (byFile.get(m.file) ?? 0) + 1);
        const hot = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([f, n]) => `${f}×${n}`).join(", ");
        const lines = [`explore ${c.bold(`"${q}"`)} ${c.dim(root)}`];
        if (symbols.length > 0) {
          const prim = symbols.filter((s) => !s.expanded).length;
          const exp = symbols.length - prim;
          lines.push(`  候选符号 ${symbols.length}(${c.dim(`符号优先召回;主 ${prim}${exp ? ` + 邻居 ${exp}` : ""}`)}):`);
          for (const s of symbols.slice(0, 8)) {
            lines.push(`    ${c.bold(s.name)} — ${s.file}:${s.line}${s.expanded ? c.dim(" [1 跳扩展]") : ""}`);
            const rel: string[] = [];
            if (s.callers.length) rel.push(`被谁调: ${s.callers.map((x) => `${x.name}@${shortPath(x.file)}:${x.line}`).join(", ")}`);
            if (s.callees.length) rel.push(`调谁: ${s.callees.map((x) => `${x.name}@${shortPath(x.file)}:${x.line}`).join(", ")}`);
            if (rel.length) lines.push(`      ${c.dim(rel.join(" | "))}`);
            if (s.reasons.length) lines.push(`      ${c.dim(`原因: ${s.reasons.join(" · ")}`)}`);
          }
          if (symbols.length > 8) lines.push(c.dim(`    …共 ${symbols.length} 个候选(--json 查看全部)`));
        }
        lines.push(matches.length === 0
          ? symbols.length > 0
            ? c.dim("  grep 命中 0 行(符号候选兜底;行级命中不是必要证据)")
            : `  零命中: ${r.degraded?.find((x) => x.layer === "grep")?.reason ?? q}——改用符号名/camelCase 关键词重试,或 codesense symbol <符号名> / entrypoints`
          : `  命中 ${matches.length} 行 / ${byFile.size} 文件${hot ? `(热区: ${hot})` : ""}`);
        for (const m of matches.slice(0, 12)) lines.push(`  ${m.file}:${m.line} — ${String(m.text).trim().slice(0, 120)}`);
        if (r.note) lines.push(c.dim(`  (${r.note})`));
        if (nextSteps.length) {
          lines.push(c.dim("  下一步(可直接复制):"));
          for (const step of nextSteps) lines.push(`    ${step}`);
          lines.push(c.dim("  文件面: codesense file <路径>;入口: codesense entrypoints"));
        } else {
          lines.push(c.dim("  深挖: codesense symbol|impact <符号名>;文件面: codesense file <路径>;入口: codesense entrypoints"));
        }
        io.out(lines.join("\n"));
        return matches.length === 0 && symbols.length === 0 ? 1 : 0;
      }

      case "impact": {
        const name = p._[1];
        if (!name) {
          io.err("用法: codesense impact <符号名> [--depth N] [--root dir] [--repo name] [--json]");
          return 2;
        }
        const dRaw = depthArg();
        if (dRaw === "invalid") {
          io.err("用法: --depth 必须是 ≥1 的整数(缺省=2 即直接+一层间接)");
          return 2;
        }
        const d = dRaw ?? 2; // impact 缺省闭包深度 2(d1 恒完整)
        const ctx = await resolveContext({ root: rootArg(), noBuild: flagBool(p, "no-build"), quiet });
        printNotes(io, c, ctx);
        const r = queryImpactCmd(ctx, name, flagStr(p, "repo"), json, d);
        return emit(io, r, json);
      }

      case "api": {
 // HTTP 接口表面——确定性行扫描,索引非前置(--no-build 下也能出清单)
        // 收尾批 I:--semantics 走 api-semantics 模块(批量/上限/缓存/无凭证显式 off);
        // --write 显式开启语义缓存落盘(基线仓只读红线,默认不落盘)
        const ctx = await resolveContext({ root: rootArg(), noBuild: true, quiet });
        printNotes(io, c, ctx);
        const r = await queryApiCmd(ctx, json, {
          ...(flagBool(p, "semantics") ? { semantics: true as const } : {}),
          all: flagBool(p, "all"),
          writeCache: flagBool(p, "write"),
        });
        return emit(io, r, json);
      }

      case "bridge": {
 // 跨语言桥边(HTTP api 桥原型)——前端 fetch 字面量 ↔ 后端 route 的确定性
        // 配对,每条边带双端 file:line 证据;纯行扫描链,索引非前置。
 // --forms http-api,ws,spec,ipc,capi,grpc|all(缺省 http-api,行为恒等)。
 // --candidates/--semantic 追加 LLM 消歧候选区(tier=semantic,与确定性边分离;
        // --candidates=all 追加 1 段前缀 low 档)。
        const ctx = await resolveContext({ root: rootArg(), noBuild: true, quiet });
        printNotes(io, c, ctx);
        const forms = flagStr(p, "forms");
        const candRaw = p.flags.candidates;
        const semRaw = p.flags.semantic;
        const includePrefix1 = candRaw === "all" || semRaw === "all";
        const candidates = candRaw === true || candRaw === "true" || candRaw === "all"
          || semRaw === true || semRaw === "true" || semRaw === "all";
        const r = await queryBridgeCmd(ctx, json, {
          ...(forms ? { forms } : {}),
          all: flagBool(p, "all"),
          ...(candidates ? { candidates: true, ...(includePrefix1 ? { includePrefix1: true } : {}) } : {}),
        });
        return emit(io, r, json);
      }

      case "wire": {
 // WS 消息协议表面——本仓真正的接口是消息协议而非 HTTP。
        // 纯行/结构扫描(协议 union ↔ server.ts case ↔ panel/assets 发送/接收),
        // 不触发索引构建;--changed 只看 git 工作区 diff/未跟踪文件。
        const root = rootArg() ?? resolveProjectRoot(process.cwd())?.root ?? process.cwd();
        if (!existsSync(root)) {
          io.err(c.red(`root 不存在: ${root}(--root 指向的目录不在盘上)`));
          return 2;
        }
        const { scanWire, renderWire } = await import("@lampgenie/code-sense/wire");
        const r = scanWire(root, { changed: flagBool(p, "changed") });
        return emit(io, { text: renderWire(r), json: r, miss: r.types.length === 0 }, json);
      }

      case "refs": {
 // 字面量引用面——删除/修改一个字符串标识(如 action === "graph")时,
        // symbol/impact 全空、review --scan 0 条、explore 不命中,只能 grep。本命令按语境
        // 列出全部引用点(产品源码+测试+文档/提示词文本),所属符号读现成索引(缺席留空)。
        // 纯行扫描,不触发索引构建;默认排除 node_modules/dist/.genie/vendor。
        const literal = p._[1];
        if (!literal) {
          io.err("用法: codesense refs <字面量> [--root dir] [--json] [--no-tests] [--no-docs]");
          return 2;
        }
        const root = rootArg() ?? resolveProjectRoot(process.cwd())?.root ?? process.cwd();
        if (!existsSync(root)) {
          io.err(c.red(`root 不存在: ${root}(--root 指向的目录不在盘上)`));
          return 2;
        }
        const r = await queryRefsCmd(root, literal, json, {
          includeTests: !flagBool(p, "no-tests"),
          includeDocs: !flagBool(p, "no-docs"),
        });
        return emit(io, r, json);
      }

      case "surface": {
 // 全链路闭环变更:概念足迹面——替换/迁移/下线一个概念(消息名、journal kind、
        // 配置键、面板文案、资源名、测试断言、文档章节)时,把全部落点一次列全,替掉人肉多轮 grep。
        // 纯行扫描(复用 refs 遍历),不触发索引构建;默认排除 node_modules/dist/.genie/vendor/.git。
        const concepts = p._.slice(1).filter((x) => typeof x === "string" && x.trim().length > 0);
        if (concepts.length === 0) {
          io.err("用法: codesense surface <概念词|符号名> [概念2 …] [--root dir] [--json] [--walk]");
          return 2;
        }
        const root = rootArg() ?? resolveProjectRoot(process.cwd())?.root ?? process.cwd();
        if (!existsSync(root)) {
          io.err(c.red(`root 不存在: ${root}(--root 指向的目录不在盘上)`));
          return 2;
        }
        const { scanSurface, renderSurfaceMarkdown } = await import("@lampgenie/code-sense/surface");
        const r = await scanSurface(root, concepts, flagBool(p, "walk") ? { engine: "walk" } : {});
        if (json) {
          io.out(JSON.stringify(r, null, 2));
          return r.hits.length === 0 ? 1 : 0;
        }
        io.out(renderSurfaceMarkdown(r));
        return r.hits.length === 0 ? 1 : 0;
      }

      case "config": {
 // P2:LLM 凭证配置(文件权限 600,输出永远脱敏)
        const sub = p._[1] ?? "list";
        const key = p._[2];
        const value = p._[3];
        if (sub === "path") {
          io.out(configPath());
          return 0;
        }
        if (sub === "list") {
          const cfg = readConfigFile();
          if (!cfg) {
            io.out(`${c.dim("配置文件: " + configPath() + "(尚不存在——config set llm.baseURL 创建)")}`);
            io.out(`  llm: ${c.dim("(未配置)")}`);
          } else {
            io.out(`${c.dim("配置文件: " + configPath())}`);
            const llm = cfg.llm ?? {};
            io.out(`  llm.baseURL: ${llm.baseURL ?? c.dim("(未设置)")}`);
            io.out(`  llm.model: ${llm.model ?? c.dim("(未设置)")}`);
            io.out(`  llm.apiKey: ${llm.apiKey ? maskKey(llm.apiKey) : c.dim("(未设置)")}`);
            io.out(`  llm.askFile.dir: ${llm.askFile?.dir ?? c.dim("(未设置)")}`);
          }
          const r = resolveLlmConfig();
          io.out(r
            ? `  ${c.green("生效档位: " + (r.kind === "ask-file" ? "ask-file 中继(" + r.dir + ")" : "direct(" + r.source + ",model=" + r.cfg.model + ",key=" + maskKey(r.cfg.apiKey) + ")"))}`
            : `  ${c.yellow("生效档位: 无 LLM(语义层确定性降级)")}`);
          return 0;
        }
        if (sub === "get") {
          if (!key) { io.err("用法: codesense config get <llm.baseURL|llm.model|llm.apiKey|llm.askFile.dir>"); return 2; }
          const cfg = readConfigFile();
          const v = key === "llm.baseURL" ? cfg?.llm?.baseURL
            : key === "llm.model" ? cfg?.llm?.model
              : key === "llm.apiKey" ? cfg?.llm?.apiKey
                : cfg?.llm?.askFile?.dir;
          io.out(key === "llm.apiKey" && v ? maskKey(v) : (v ?? c.dim("(未设置)")));
          return 0;
        }
        if (sub === "set") {
          if (!key || value === undefined) { io.err("用法: codesense config set <key> <value>"); return 2; }
          setConfigKey(key, value);
          io.out(`已写入 ${key}${key === "llm.apiKey" ? "(" + maskKey(value) + ")" : ""} → ${configPath()}(权限 600)`);
          return 0;
        }
        if (sub === "unset") {
          if (!key) { io.err("用法: codesense config unset <key>"); return 2; }
          io.out(unsetConfigKey(key) ? `已删除 ${key}` : `${key} 本就未设置`);
          return 0;
        }
        io.err(`未知子命令: config ${sub}(支持 list/get/set/unset/path)`);
        return 2;
      }

      case "state": {
 // P2:状态机表面(五形态;不依赖索引构建)
        const ctx = await resolveContext({ root: rootArg(), noBuild: true, quiet });
        printNotes(io, c, ctx);
        const r = await queryStateCmd(ctx, json, { all: flagBool(p, "all") });
        return emit(io, r, json);
      }

      case "algo": {
 // P3:算法画像(框架 API 模式识别;不依赖索引构建)
        const ctx = await resolveContext({ root: rootArg(), noBuild: true, quiet });
        printNotes(io, c, ctx);
        const r = await queryAlgoCmd(ctx, json, p._[1], { all: flagBool(p, "all") });
        return emit(io, r, json);
      }

      case "vars":
      case "tokens": {
 // P1:变量类型清单 / semantic-token 导出(逐文件深提取,不依赖索引构建)
        // 收尾批 F:vars --locals 扩入函数内注解面(param/parameter/local)
        const pathArg = p._[1];
        if (!pathArg) {
          io.err(`用法: codesense ${cmd} <相对路径> [--root dir] [--repo name] [--json]${cmd === "vars" ? " [--locals]" : ""}`);
          return 2;
        }
        const ctx = await resolveContext({ root: rootArg(), noBuild: true, quiet });
        printNotes(io, c, ctx);
        const repo = flagStr(p, "repo");
        const r = cmd === "vars"
          ? await queryVarsCmd(ctx, pathArg, repo, json, flagBool(p, "locals"))
          : await queryTokensCmd(ctx, pathArg, repo, json);
        return emit(io, r, json);
      }

      case "project": {
 // P3:项目底座认知(README/包清单/框架指纹/入口/拓扑 → 骨架;
        // LLM purpose 走凭证链+指纹缓存;--write 落盘供 gateway 注入/action=project 消费)
        const ctx = await resolveContext({ root: rootArg(), noBuild: true, quiet });
        printNotes(io, c, ctx);
        const r = await queryProjectCmd(ctx, json, { write: flagBool(p, "write"), noLlm: flagBool(p, "no-llm"), refresh: flagBool(p, "refresh") });
        return emit(io, r, json);
      }

      case "wiki": {
 // 持久 repo wiki(.genie/wiki/<repo>/;零 embedding;索引非前置)
        const r = await wikiCommand(p, json);
        return emit(io, { text: r.text, json: r.json, miss: r.miss ?? false }, json);
      }

      case "entrypoints": {
        const ctx = await resolveContext({ root: rootArg(), noBuild: flagBool(p, "no-build"), quiet });
        printNotes(io, c, ctx);
        const limit = Number(flagStr(p, "limit") ?? 15);
        const r = queryEntrypointsCmd(ctx, flagStr(p, "repo"), Number.isFinite(limit) ? limit : 15, json, flagBool(p, "all"));
        return emit(io, r, json);
      }

      case "modules": {
 // P1:模块视图(清单+交互矩阵+枢纽/测试面;--graph=mermaid)
        const ctx = await resolveContext({ root: rootArg(), noBuild: flagBool(p, "no-build"), quiet });
        printNotes(io, c, ctx);
        const r = queryModulesCmd(ctx, flagStr(p, "repo"), json, flagBool(p, "graph"));
        return emit(io, r, json);
      }

      case "flow": {
 // 整仓代码流:module/file/function 三层 + 入口/分层/裁剪;图给人看,JSON 给 agent。
        const ctx = await resolveContext({ root: rootArg(), noBuild: flagBool(p, "no-build"), quiet });
        printNotes(io, c, ctx);
        const level = flagStr(p, "level");
        if (level && !["module", "file", "function", "auto"].includes(level)) {
          io.err(`--level 必须是 module|file|function|auto(收到 ${level})`);
          return 2;
        }
        const direction = flagStr(p, "direction");
        if (direction && direction !== "LR" && direction !== "TD") {
          io.err(`--direction 必须是 LR|TD(收到 ${direction})`);
          return 2;
        }
        const r = queryFlowCmd(ctx, flagStr(p, "repo"), json, {
          ...(level ? { level: level as "module" | "file" | "function" | "auto" } : {}),
          scope: flagStr(p, "scope") ?? p._[1],
          include: flagStr(p, "include"),
          exclude: flagStr(p, "exclude"),
          maxNodes: optNum(p, "max-nodes"),
          maxEdges: optNum(p, "max-edges"),
          keepIsolated: flagBool(p, "keep-isolated"),
          includeTests: flagBool(p, "include-tests"),
          includeNonProduct: flagBool(p, "all"),
          target: flagStr(p, "target"),
          upstream: optNum(p, "upstream"),
          downstream: optNum(p, "downstream"),
          processEntries: !flagBool(p, "no-process-entries"),
          graph: !flagBool(p, "no-graph"),
          dot: flagBool(p, "dot"),
          direction: (direction as "LR" | "TD" | undefined),
          legend: !flagBool(p, "no-legend"),
        });
        const out = flagStr(p, "out");
        if (out) {
          const w = writeFlowOut(r.flows, out, !flagBool(p, "no-legend"));
          for (const e of w.errors) io.err(c.red(e));
          if (w.written.length) io.out(c.dim(`已写出: ${w.written.join(", ")}`));
          if (w.errors.length) return 1;
          if (json) r.json = { ...(r.json as Record<string, unknown>), out: w.written };
          else r.text += `\n\n已写出: ${w.written.join(", ")}`;
        }
        return emit(io, r, json);
      }

      case "file": {
        const pathArg = p._[1];
        if (!pathArg) {
          io.err(`用法: codesense file <相对路径> [--root dir] [--repo name] [--json] [--graph]`);
          return 2;
        }
        const ctx = await resolveContext({ root: rootArg(), noBuild: flagBool(p, "no-build"), quiet });
        printNotes(io, c, ctx);
        // file --graph 出 mermaid 文件级关系图(旧 filegraph 形态,收尾批 J 并入)
        const r = queryFileCmd(ctx, pathArg, flagStr(p, "repo"), json, flagBool(p, "graph"));
        return emit(io, r, json);
      }

      case "branches": {
        const pathArg = p._[1];
        if (!pathArg) {
          io.err(`用法: codesense branches <相对路径> [--root dir] [--repo name] [--json]`);
          return 2;
        }
        const ctx = await resolveContext({ root: rootArg(), noBuild: flagBool(p, "no-build"), quiet });
        printNotes(io, c, ctx);
        const r = await queryBranchesCmd(ctx, pathArg, flagStr(p, "repo"), json);
        return emit(io, r, json);
      }

      case "cfg": {
        const nameArg = p._[1];
        if (!nameArg) {
          io.err(`用法: codesense cfg <函数名> [--file path] [--line N] [--depth N] [--full] [--no-merge] [--out file.mmd] [--root dir] [--repo name] [--json]`);
          return 2;
        }
        const ctx = await resolveContext({ root: rootArg(), noBuild: flagBool(p, "no-build"), quiet });
        printNotes(io, c, ctx);
        const r = await queryCfgCmd(ctx, nameArg, flagStr(p, "repo"), json, {
          file: flagStr(p, "file"),
          line: optNum(p, "line"),
          depth: optNum(p, "depth"),
          full: flagBool(p, "full"),
          merge: !flagBool(p, "no-merge"),
          maxNodes: optNum(p, "max-nodes"),
        });
        const out = flagStr(p, "out");
        if (out) {
          const w = writeCfgOut(r.cfgFunctions, out, { merge: !flagBool(p, "no-merge") });
          for (const e of w.errors) io.err(c.red(e));
          if (w.written.length) io.out(c.dim(`已写出: ${w.written.join(", ")}`));
          if (w.errors.length) return 1;
          if (json) r.json = { ...(r.json as Record<string, unknown>), out: w.written };
          else r.text += `\n\n已写出: ${w.written.join(", ")}`;
        }
        return emit(io, r, json);
      }

      case "serve": {
        serveMain(p._.slice(1), { root: flagStr(p, "root") });
        // 常驻:进程由 serve 的 stdin end/drain 逻辑退出;runCli 在此不返回——否则主守卫
 // 立刻 process.exit 杀死尚未消费 stdin 的服务(经验证一次性管道场景零响应注意)
        return new Promise<number>(() => {});
      }

      case "doctor": {
        const d = await runDoctor(rootArg());
        if (json) {
          io.out(JSON.stringify({ ok: d.ok, checks: d.checks }, null, 2));
        } else {
          for (const ch of d.checks) {
            const mark = ch.status === "ok" ? c.green("ok") : ch.status === "warn" ? c.yellow("warn") : c.red("FAIL");
            io.out(`  [${mark}] ${ch.name}: ${ch.detail}`);
          }
          io.out(d.ok ? c.green("doctor: 通过") : c.red("doctor: 存在 FAIL 项"));
        }
        return d.ok ? 0 : 1;
      }

      case "review": {
        const r = await reviewCommand(p, { json });
        if (json) {
          io.out(JSON.stringify(r.json, null, 2));
        } else {
          io.out(r.text);
        }
        return r.blockers > 0 ? 1 : 0; // CI 门禁语义:blocker 存在=非零
      }

      default:
        io.err(`未知指令: ${cmd}\n`);
        io.err(HELP);
        return 2;
    }
  } catch (e) {
    if (e instanceof ResolveError) {
      io.err(c.red(e.message));
      return 2;
    }
    if (e instanceof IndexBusyError) {
 // 单飞锁:同根已有索引在飞 → 礼貌拒绝(exit 3),不重复烧内存
      io.err(c.yellow(e.message));
      return 3;
    }
    if (e instanceof ReviewUsageError || e instanceof WikiUsageError) {
      io.err(c.red(e.message));
      return 2;
    }
    if (e instanceof LlmConfigError) {
 // P2:凭证/配置形态错=用法错误档(exit 2),与 review --deep 缺凭证同语义
      io.err(c.red(e.message));
      return 2;
    }
    io.err(c.red(`codesense 错误: ${String(e instanceof Error ? e.message : e)}`));
    return 1;
  }
}

function printNotes(io: CliIo, c: ReturnType<typeof makePalette>, ctx: { notes: string[]; rootSource: string }): void {
  if (ctx.notes.length) for (const n of ctx.notes) io.err(c.dim(`[codesense] ${n}`));
}

function emit(io: CliIo, r: { text: string; json?: unknown; miss: boolean }, json: boolean): number {
  if (json) {
    io.out(JSON.stringify(r.json ?? { text: r.text }, null, 2));
    return r.miss ? 1 : 0;
  }
  io.out(r.text);
  return r.miss ? 1 : 0;
}

/** 数值旗标:非法/缺省=undefined(不做 0 的静默兜底)。 */
function optNum(p: ParsedArgs, key: string): number | undefined {
  const s = flagStr(p, key);
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** flow --out:按扩展名落盘 mermaid/dot/json/md;svg/png 走 graphviz(缺席=可操作错误)。 */
function writeFlowOut(flows: { name: string; flow: CodeFlow }[], out: string, legend: boolean): { written: string[]; errors: string[] } {
  const written: string[] = [];
  const errors: string[] = [];
  if (flows.length === 0) return { written, errors: ["无 flow 可写出(索引未就绪或目标未命中)"] };
  const ext = extname(out).toLowerCase() || ".mmd";
  const base = out.slice(0, out.length - extname(out).length) || out;
  const targets = flows.length === 1
    ? [{ name: flows[0]!.name, flow: flows[0]!.flow, path: out }]
    : flows.map(({ name, flow }) => ({ name, flow, path: `${base}-${name.replace(/[^A-Za-z0-9._-]/g, "_")}${ext}` }));
  for (const t of targets) {
    try {
      mkdirSync(dirname(resolve(t.path)), { recursive: true });
      if (ext === ".json") {
        writeFileSync(t.path, JSON.stringify(codeFlowJson(t.flow), null, 2) + "\n", "utf-8");
      } else if (ext === ".dot" || ext === ".gv") {
        writeFileSync(t.path, renderCodeFlowDot(t.flow, { legend }) + "\n", "utf-8");
      } else if (ext === ".md") {
        writeFileSync(t.path, "```mermaid\n" + renderCodeFlowMermaid(t.flow, { legend }) + "\n```\n", "utf-8");
      } else if (ext === ".svg" || ext === ".png") {
        const dotPath = `${t.path}.dot`;
        writeFileSync(dotPath, renderCodeFlowDot(t.flow, { legend }) + "\n", "utf-8");
        const bin = spawnSync("dot", [`-T${ext.slice(1)}`, "-o", t.path, dotPath], { encoding: "utf-8", timeout: 120_000 });
        if (bin.error || bin.status !== 0) {
          errors.push(`graphviz 渲染失败(${ext}): ${bin.error?.message ?? (bin.stderr || `exit ${bin.status}`)}——已保留 DOT: ${dotPath};装 graphviz 或用 --out flow.dot`);
          continue;
        }
      } else {
        writeFileSync(t.path, renderCodeFlowMermaid(t.flow, { legend }) + "\n", "utf-8");
      }
      written.push(t.path);
    } catch (err) {
      errors.push(`写出失败 ${t.path}: ${String(err instanceof Error ? err.message : err)}`);
    }
  }
  return { written, errors };
}

/** 候选符号 → 可复制的下一步命令(前 3 个:symbol 查关系,impact 查改动影响面)。 */
function exploreNextSteps(symbols: { name: string }[]): string[] {
  const names = [...new Set(symbols.slice(0, 3).map((s) => s.name))];
  const out: string[] = [];
  for (const n of names) {
    out.push(`codesense symbol ${n}`);
    out.push(`codesense impact ${n}`);
  }
  return out;
}

/** 关系展示用的短路径(basename.ts:line)——候选块内不重复完整相对路径。 */
function shortPath(file: string): string {
  const parts = file.split("/");
  return parts[parts.length - 1] ?? file;
}

// ---- 独立进程入口(被 import 时不执行) ----
if (isMainEntry(import.meta.url)) {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}
