/**
 * code-index MCP 核心逻辑(单一真相版,2026-10-15 从 apps/gateway/src/code-index-core.ts 迁入
 * code-sense-cli 包——CLI / MCP stdio / gateway 三方共用同一份工具面与格式化,gateway 侧只剩
 * 再导出薄壳)。上游纪律原样保留:
 *
 * 多仓路由语义(2026-10-13 修复:此前「第一个就绪仓先到先得」,工作区里字母序靠前且
 * gitHead 不再变化的仓会永久占住服务,其余仓永远查不到):
 *   - 全部工具带可选 repo 参数(仓目录名,如 lampgenie-harness);
 *   - 路径类工具:显式 repo > 路径首段命中子仓名(剥前缀) > 跨仓搜索(byFile 命中的首个就绪仓,命中多个标注「另见」);
 *   - 符号类工具:显式 repo > 跨仓合并结果(逐条标注来源仓);
 *   - 查询时对缺失/过期的仓补建索引(此前只有「全部未就绪」才触发构建)。
 * 索引本体=code-sense 的 c2f 静态索引(.genie/sense-index,gitHead 判过期)。
 */
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import {
  loadIndex, indexStale, querySymbol, queryFile, queryEntryPoints, queryEntryPointsMeta, renderNeighborhood, renderFile, samplingNote,
  queryImpact, renderImpact, suggestSymbolNames,
  type C2fIndex, type C2fNode, type SymbolQueryResult,
} from "@lampgenie/code-sense";
import { languageCoverageCachedSync, coverageWarnings, unsupportedLanguageText, unsupportedLanguageTextSync } from "@lampgenie/code-sense/callgraph/coverage";
import { scanProcessEntriesSync, renderProcessEntries } from "@lampgenie/code-sense/sensing/procentries";
import { buildModuleView, renderModuleView } from "@lampgenie/code-sense/callgraph/modview";
import { buildCodeFlow, FlowTargetError, renderCodeFlowMermaid, renderCodeFlowText } from "@lampgenie/code-sense/callgraph/flow";
import { loadRegistry, normalizeRoot } from "./registry.js";
/** 表面分类唯一真相(核心库导出;文案里的类数/类名跟随 SURFACE_CATEGORIES,不写死数字)。 */
import { SURFACE_CATEGORIES } from "@lampgenie/code-sense/surface";

export interface RepoState { root: string; name: string; index: C2fIndex; stale: boolean; }
export interface McpToolResult { content: { type: string; text: string }[]; isError: boolean; }
export interface CodeIndexMcp {
  tools: unknown[];
  dispatchTool(name: string, args: Record<string, unknown>): McpToolResult;
  /** 异步分派全量面:api/state/algo(step-080,sensing 行扫描,天然 async)在此处理,
   * 其余工具委托 dispatchTool(同步契约零变更——query.ts/CLI 同步链与四个既有测试依赖它)。 */
  dispatchToolAsync(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
}

/** 工作区根的仓发现:根自身是仓(.git)=单仓;否则一级子目录含 .git/package.json 视为独立仓。 */
export function discoverRoots(root: string): string[] {
  if (existsSync(join(root, ".git"))) return [root];
  try {
    const out: string[] = [];
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const sub = join(root, e.name);
      if (existsSync(join(sub, ".git")) || existsSync(join(sub, "package.json"))) out.push(sub);
    }
    return out.length > 0 ? out : [root];
  } catch {
    return [root];
  }
}

const REPO_ARG = { repo: { type: "string", description: "可选,仓目录名(如 lampgenie-harness);缺省=跨仓自动路由" } };

/** wire 协议的 root 覆盖:缺省=服务实例根;显式 root 便于同一 MCP 服务查另一个项目。 */
const ROOT_ARG = { root: { type: "string", description: "可选,项目根(缺省=服务实例根;相对路径按该根解析)" } };

/** sensing 三工具(api/state/algo)的 repo 语义与六件套不同:缺省=扫描整个根(与 CLI
 * api/state/algo 同语义,行扫描按目录走,不做跨仓索引路由);显式 repo=定向该仓目录。 */
const SENSING_REPO_ARG = { repo: { type: "string", description: "可选,仓目录名;缺省=扫描整个根(与 CLI api/state/algo 同语义)" } };

const DEPTH_ARG = { depth: { type: "number", description: "可选,关系遍历层数上限(≥1 整数;缺省=1 即直接调用方/被调方)。>1 时输出逐条标注深度层级(d2=二层间接),渲染沿用 ×N 合并与节点上限防爆炸" } };

/** 全量工具定义(16 件;分派面与 required 校验的单一真相)。 */
const ALL_TOOLS = [
  {
    name: "code_index_symbol",
    description: "查代码符号(静态索引,毫秒):定义位置+谁调用它(callers)+它调用谁(callees)。跨仓合并结果,逐条标注来源仓;精确未命中时给「你是不是想找」容错建议(大小写/分隔符归一+编辑距离)。符号邻域 mermaid 图(人看)走 CLI `codesense symbol <name> --graph`",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "符号名(函数/方法/类)" }, ...DEPTH_ARG, ...REPO_ARG }, required: ["name"] },
  },
  {
    name: "code_index_file",
    description: "查文件的符号表(静态索引):该文件全部函数/方法+分类+出入度。路径可带仓前缀(lampgenie-harness/packages/…)或用 repo 参数指定仓。文件级 mermaid 关系图(人看)走 CLI `codesense file <path> --graph`",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "相对项目根的文件路径" }, ...REPO_ARG }, required: ["path"] },
  },
  {
    name: "code_index_entrypoints",
    description: "入口函数清单(trunk:索引内无调用方的函数——索引可能存在未覆盖的调用形态,不等于绝对无调用方)——理解项目从哪开始读。缺省=逐仓分组返回;首节含进程入口(py __main__/c·go·java main/package.json bin 启动器视角)",
    inputSchema: { type: "object", properties: { ...REPO_ARG } },
  },
  {
    name: "code_index_modules",
    description: "模块视图(2026-10-22):模块清单(目录分组,文件数/语言)+跨模块交互矩阵(A→B=A 调用 B,边数降序)+枢纽(被依赖最多)+测试面(tests 对各模块的调用覆盖)。「这个仓有哪些模块、模块间怎么交互」的架构级答案;graph=true 追加 mermaid 架构图。分组=目录启发式(根文件自成组;modules/tests/packages/apps/cmd/src/internal 摊二级)",
    inputSchema: {
      type: "object",
      properties: {
        ...ROOT_ARG,
        ...SENSING_REPO_ARG,
        graph: { type: "boolean", description: "可选,追加 mermaid 架构图;缺省=false 纯文本" },
      },
    },
  },
  {
    name: "code_index_flow",
    description: "整仓代码流(2026-10-26,code2flow 语义):module/file/function 三层聚合全项目调用流——入口/trunk/leaf/regular 分类、File/Class 分组、默认裁零连接、BFS 分层(d0..)、主干路径、枢纽;返回文本摘要,graph=true 追加 mermaid。level=auto 缺省(模块≥6 看模块,否则文件/函数);target+upstream/downstream 出目标上下游子图",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "string", description: "可选:module|file|function|auto(缺省 auto)" },
        scope: { type: "string", description: "可选:目录/文件前缀,只画该子树" },
        target: { type: "string", description: "可选:目标(函数名/文件路径/模块名);配 upstream/downstream 出子图" },
        upstream: { type: "number", description: "可选:target 上游层数(缺省 2)" },
        downstream: { type: "number", description: "可选:target 下游层数(缺省 2)" },
        maxNodes: { type: "number", description: "可选:显式收窄节点数;缺省不设上限(诚实全量)" },
        graph: { type: "boolean", description: "可选:追加 mermaid(缺省 true)" },
        ...REPO_ARG,
      },
    },
  },
  {
    name: "code_index_graph",
    description: "符号邻域关系图(code2flow 形态 mermaid):所在 File/Class 分组+上下游+分类着色。跨仓取首个命中仓并标注",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "符号名" }, ...DEPTH_ARG, ...REPO_ARG }, required: ["name"] },
  },
  {
    name: "code_index_filegraph",
    description: "文件级关系图(code2flow 形态 mermaid):文件内全部符号+调用边。路径可带仓前缀或用 repo 参数指定仓",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "相对项目根的文件路径" }, ...REPO_ARG }, required: ["path"] },
  },
  {
    name: "code_index_impact",
    description: "改动影响面清单(step-066):改/删/重构一个函数前必查——完整签名与参数+双向调用闭包(逐跳 dN 标注)+受影响文件(调用+import 双通道)+关联测试定位+跨语言桥边段(索引含 bridge 段时:后端 handler 的前端调用点/前端符号触达的后端端点,带置信度与双端 file:line 证据),一次查询全出。改函数前先查影响面",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "符号名(函数/方法/类)" }, depth: { type: "number", description: "可选,闭包深度(缺省 2;d1 恒完整,深层每层封顶 24)" }, ...REPO_ARG }, required: ["name"] },
  },
  {
    name: "code_index_api",
    description: "HTTP 接口表面(step-077,确定性行扫描,不触发索引构建):服务有哪些接口(method/path/handler/file:line,六框架族)+OpenAPI 规范对账三态(一致/仅规范/仅代码)+handler 影响面摘要(静态索引在场时挂载;缺席=显式降级说明,清单不受影响)",
    inputSchema: { type: "object", properties: { ...SENSING_REPO_ARG } },
  },
  {
    name: "code_index_state",
    description: "状态机表面(step-077,五形态确定性提取,不触发索引构建):TRANSITIONS 字面量表/switch+联合类型双条件收敛/状态模式类族/XState createMachine/Redux slice(弱化产物如实标注不冒充状态机),转移带触发与 file:line 证据",
    inputSchema: { type: "object", properties: { ...SENSING_REPO_ARG } },
  },
  {
    name: "code_index_algo",
    description: "算法画像(step-077,框架 API 模式识别,不触发索引构建):模型定义/训练/推理/数据管线/CV-DSP/评估指标六类管线角色分布(信号带 file:line 证据行,类定义加权防误报),附目录级角色汇总。file 参数与 CLI algo [file] 同参(只影响 LLM 导读粒度,确定性清单不按文件过滤)",
    inputSchema: { type: "object", properties: { file: { type: "string", description: "可选,文件路径(与 CLI algo [file] 同参;仅影响 LLM 导读粒度,确定性清单不过滤)" }, ...SENSING_REPO_ARG } },
  },
  {
    name: "code_index_vars",
    description: "文件变量类型清单(step-089,声明时数据类型,不触发索引构建):类型分组的变量/字段/枚举常量/typedef 清单,每条带 dataType(int/char*/struct X/数组/函数指针、TS 泛型与联合、Py 注解、Go/Java 静态类型)+行号;按类型分组输出。支持 c/cpp/python/typescript/go/java,其余扩展名如实降级",
    inputSchema: { type: "object", properties: { file: { type: "string", description: "相对路径(可带仓前缀 lampgenie-harness/packages/…)或配合 repo 参数的仓内相对路径" }, ...REPO_ARG }, required: ["file"] },
  },
  {
    name: "code_index_project",
    description: "项目底座画像(step-089):这个项目大概是干什么的(purpose)+主线能力+偏离主线提示+技术栈/框架指纹/入口/目录拓扑,全带证据行。读 .genie/sense-index/profile.json manifest(生产者:在项目根跑 codesense project --write;确定性骨架无 LLM 也可用);manifest 缺席=显式提示不猜",
    inputSchema: { type: "object", properties: { ...REPO_ARG } },
  },
  {
    name: "code_index_wire",
    description: "WS 消息协议表面(2026-10-21,确定性行扫描,不触发索引构建):协议声明(ClientMessage/ServerMessage discriminatedUnion)↔ 服务端 switch(msg.type) handler ↔ 面板/assets 发送调用与接收分支 三处对账,按 union 分组输出 type/handler/发送点/接收点/状态表 + 孤儿四类(A 声明无 handler/B handler 未声明/C 发送未声明/D 声明但面板不发送)。加/改一条 WS 消息时一次看清三处是否齐;changed=true 只看 git 工作区改动涉及的 type(按 type 字面量集合 diff,分新增/删除/改动)",
    inputSchema: {
      type: "object",
      properties: {
        ...ROOT_ARG,
        ...SENSING_REPO_ARG,
        changed: { type: "boolean", description: "可选,只列 git 工作区改动(type 字面量集合 diff:新增/删除/改动)涉及的 type;缺省=false 全量" },
      },
    },
  },
  {
    name: "code_index_refs",
    description: "字符串字面量引用面(2026-10-21,确定性行扫描,不触发索引构建):按语境(case-literal / eq-literal / z-literal / object-key / string-literal / doc)列出某个字面量的全部引用点(file:line + 所属符号),覆盖产品源码/测试/文档/agent 提示词文本。删字符串标识的动作(如 action === \"graph\")、查错误串或提示词引用时用——这类标识不是符号,symbol/impact 全空、explore 不命中。默认排除 node_modules/dist/.genie/vendor",
    inputSchema: {
      type: "object",
      properties: {
        literal: { type: "string", description: "要查的字符串字面量(不含外层引号,如 graph / track.view)" },
        ...ROOT_ARG,
        ...SENSING_REPO_ARG,
        includeTests: { type: "boolean", description: "可选,含测试文件;缺省 true(删除动作必须看测试)" },
        includeDocs: { type: "boolean", description: "可选,含文档/提示词文本;缺省 true(删除动作必须看文档)" },
      },
      required: ["literal"],
    },
  },
  {
    name: "code_index_branches",
    description: "分支/循环骨架(2026-10-23,tree-sitter 全树走查,索引非前置):一个文件的 if/elif/else 条件文本 + while/do-while/for/for-of/for-in/switch/case + 三元,每个分支带直接调用的函数与所属函数(py/ts/js/c/cpp/java/go;tree-sitter 不可用时行级降级)——回答「这个调用在什么条件下发生」。code_index_refs 的代码命中已带最内层决策点标注,本工具是文件级全骨架",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件相对路径(支持 py/ts/tsx/js/jsx/mjs/cjs/c/h/cc/cpp/hpp/java/go)" },
        ...ROOT_ARG,
        ...SENSING_REPO_ARG,
      },
      required: ["path"],
    },
  },
  {
    name: "code_index_surface",
    description: `概念足迹面(2026-11-06,确定性行扫描,不触发索引构建):换/迁移/下线一个概念(WS 消息名、journal 事件 kind、配置键、面板文案、资源名、测试断言、文档章节)时,把全部落点按 ${SURFACE_CATEGORIES.length} 类表面(${SURFACE_CATEGORIES.join("/")})分组列全,每条带 file:line + 动作建议(change/remove/keep-legacy)+ 分类计数。回答「这个概念要动的地方齐了吗」,替代人肉多轮 grep。与 code_index_refs 的区别:refs 按语境看单字面量的引用形态,surface 按功能面给出改动清单;多个概念词可逗号一次扫。默认排除 node_modules/dist/.genie/vendor`,
    inputSchema: {
      type: "object",
      properties: {
        concept: { type: "string", description: "要扫的概念词,多个用逗号分隔(如 track.view,journal kind)" },
        concepts: { type: "array", items: { type: "string" }, description: "可选,概念词数组(与 concept 等价,可同时给;结果合并)" },
        ...ROOT_ARG,
        ...SENSING_REPO_ARG,
      },
      required: ["concept"],
    },
  },
];

/**
 * MCP 工具面(tools/list,2026-10-26 起十四件;2026-11-06 +surface=十五件)——code_index_graph/code_index_filegraph
 * 移出 agent 面(mermaid 关系图 agent 几乎不消费,反而增加工具选择负担;图给人看走 CLI
 * `codesense symbol <name> --graph` / `codesense file <path> --graph`);code_index_modules
 * 新增(模块清单+跨模块交互矩阵——架构级问题此前无面);code_index_branches 新增
 * (分支/循环骨架——条件关系此前无面)。分派处理器保留:
 * ①gateway 直调测试与 CLI 文本面仍消费;②required 校验按 ALL_TOOLS(移出≠失效,只是不再
 * 主动曝光)。 */
export const CODE_INDEX_TOOLS = ALL_TOOLS.filter(
  (t) => t.name !== "code_index_graph" && t.name !== "code_index_filegraph",
);

// ---- 格式化函数(导出:CLI 人类可读输出与 MCP 工具面逐字同一份,防双实现漂移) ----

/** 符号查询结果 → MCP/CLI 同源文本(单一真相;--json 形态由 CLI 直接序列化 SymbolQueryResult)。
 * step-099(RC-096-B5):弃边可见性与 impact 面对齐——命中名有构建期弃边台账或索引内未解析边时
 * 追加一行诚实计量(此前弃边只在对照 grep 时才可见)。 */
export function formatSymbolHit(s: RepoState, h: SymbolQueryResult): string {
  const sym = h.symbol;
  // step-098(RC-096-B6):trunk 标签不过度声明——索引看不见≠无人调用(getCompletions/
  // User.has_access 两例实锤);弃边/未解析同名调用在场时直说「存在未解析同名调用」
  const kind = sym.kind === "trunk" ? "入口(trunk,索引内无调用方)" : sym.kind === "leaf" ? "叶子(leaf,不调用他人)" : "常规";
  const ref = (c: { name: string; file: string; line: number }) =>
    c.line > 0 ? `${c.name}@${c.file}:${c.line}` : `${c.name}@${c.file}`; // <module> 虚调用方无行号
  // 弃边行(台账键=调用点书写名;裸名与登记名双查,与 impact 同口径)
  const bare = sym.name.includes(".") ? sym.name.slice(sym.name.lastIndexOf(".") + 1) : sym.name;
  const drop = s.index.dropped
    ? (Object.hasOwn(s.index.dropped, sym.name) ? s.index.dropped[sym.name] : undefined)
      ?? (Object.hasOwn(s.index.dropped, bare) ? s.index.dropped[bare] : undefined)
    : undefined;
  let unresolved = 0;
  for (const e of s.index.edges) if (!e.to && (e.toName === sym.name || e.toName === bare)) unresolved++;
  const dropBits: string[] = [];
  if (drop) {
    dropBits.push(`同名调用候选构建期被弃 ${drop.count} 处(${Object.entries(drop.reasons).map(([k, v]) => `${k} ×${v}`).join("; ")})`);
  }
  if (unresolved > 0) dropBits.push(`未解析边 ${unresolved} 处`);
  const dropLine = dropBits.length > 0 ? `  弃边与不可见: ${dropBits.join(";")}(明细见 code_index_impact)` : null;
  const noCaller = dropLine
    ? "  被调用: 索引内无(存在未解析/被弃同名调用——见下行,可能含真实调用方)"
    : "  被调用: 索引内无调用方(索引未覆盖的调用形态可能存在,不等于绝对无调用方)";
  return [
    `[${s.name}] ${sym.name} [${kind}] — ${sym.file}:${sym.line}`,
    h.callers.length ? `  被调用(${h.callers.length}): ` + h.callers.slice(0, 12).map(ref).join(", ") : noCaller,
    h.callees.length ? `  调用(${h.callees.length}): ` + h.callees.slice(0, 12).map(ref).join(", ") : "  调用: 无(叶子函数)",
    ...(dropLine ? [dropLine] : []),
  ].join("\n");
}

/** 深度引用:hop 距离标注(深度遍历时每条关系带 depth 层级)。 */
export interface DeepRef { id: string; name: string; file: string; line: number; depth: number }

/** N 层关系遍历(symbol/callers/callees 的 depth 语义,单一真相):
 * d1=直接调用方/被调方(与 querySymbol 同一去重语义,**完整不封顶**——step-066 A4 修复:
 * 旧版全局 CAP=24 被 d1 吃满即 return,直接关系 35→24 缩水且零 d2 行,请求更大深度反而
 * 丢失直接关系);d≥2 沿 index.edges 做 id 级 BFS,每层各自封顶 DEEP_CAP_PER_LEVEL 防爆炸,
 * 某层封顶=停止向更深扩展并如实标 truncated(不静默)。`<module>` 虚调用方与 c2f 消费面
 * 同一特判。 */
export function querySymbolDeep(index: C2fIndex, name: string, depth: number): (SymbolQueryResult & { callersDeep: DeepRef[]; calleesDeep: DeepRef[]; truncated: boolean })[] {
  const hits = querySymbol(index, name);
  if (depth <= 1) {
    return hits.map((h) => ({
      ...h,
      callersDeep: h.callers.map((c) => ({ ...c, depth: 1 })),
      calleesDeep: h.callees.map((c) => ({ ...c, depth: 1 })),
      truncated: false,
    }));
  }
  const DEEP_CAP_PER_LEVEL = 24;
  const nodeById = new Map(index.nodes.map((n) => [n.id, n]));
  const nodeRef = (id: string, d: number): DeepRef => {
    const real = nodeById.get(id);
    if (real) return { id: real.id, name: real.name, file: real.file, line: real.line, depth: d };
    const hash = id.lastIndexOf("#");
    return { id, name: hash >= 0 ? id.slice(hash + 1) : id, file: hash >= 0 ? id.slice(0, hash) : "", line: 0, depth: d };
  };
  const walk = (dir: "callers" | "callees", startIds: string[]): { refs: DeepRef[]; truncated: boolean } => {
    const refs: DeepRef[] = [];
    const seen = new Set<string>(startIds);
    let frontier = [...startIds];
    let truncated = false;
    for (let d = 1; d <= depth && !truncated; d++) {
      const cap = d === 1 ? Infinity : DEEP_CAP_PER_LEVEL;
      const next: string[] = [];
      let levelCount = 0;
      for (const id of frontier) {
        for (const e of index.edges) {
          const other = dir === "callers" ? (e.to === id ? e.from : null) : e.from === id ? e.to : null;
          if (!other || seen.has(other)) continue;
          seen.add(other);
          if (levelCount >= cap) { truncated = true; break; }
          refs.push(nodeRef(other, d));
          levelCount++;
          next.push(other);
        }
        if (truncated) break;
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
    return { refs, truncated };
  };
  return hits.map((h) => {
    const callers = walk("callers", [h.symbol.id]);
    const callees = walk("callees", [h.symbol.id]);
    return {
      ...h,
      callersDeep: callers.refs,
      calleesDeep: callees.refs,
      truncated: callers.truncated || callees.truncated,
    };
  });
}

/** 深度形态符号文本(带 d 标注;d1 也标——仅当调用方显式给了 depth 参数)。 */
export function formatSymbolHitDeep(s: RepoState, h: SymbolQueryResult & { callersDeep: DeepRef[]; calleesDeep: DeepRef[]; truncated: boolean }, depth: number): string {
  // 文本形态:直接层保持 formatSymbolHit 原文(d1 由「被调用/调用」清单天然表达),
  // 间接层逐条 (dN) 标注 + 尾注总深度与截断态(与 json 的逐条 depth 字段等价)
  const base = formatSymbolHit(s, h);
  const heads: string[] = [];
  for (const r of h.callersDeep) if (r.depth > 1) heads.push(`    (d${r.depth}) ${r.name}@${r.file}${r.line > 0 ? ":" + r.line : ""}`);
  for (const r of h.calleesDeep) if (r.depth > 1) heads.push(`    (d${r.depth}) ${r.name}@${r.file}${r.line > 0 ? ":" + r.line : ""}`);
  const note = `  (depth=${depth}${h.truncated ? ",深层每层 24 条封顶已截断" : ""})`;
  return [...base.split("\n"), ...heads, note].join("\n");
}

/** depth 入参校验(工具面单一闸):undefined=缺省 1(现行为);给了就必须是 ≥1 整数。 */
export function parseDepthArg(args: Record<string, unknown>): { depth: number; labeled: boolean } | { error: string } {
  const raw = args?.depth;
  if (raw === undefined || raw === null || raw === "") return { depth: 1, labeled: false };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return { error: `depth 必须是 ≥1 的整数,收到: ${String(raw)}` };
  return { depth: n, labeled: true };
}

/** 同名多定义消歧提示(step-066 C3):>1 处命中时头部列出全部定义,点破「同名多处」事实,
 * agent 不必从并列输出里自行数行数。 */
export function formatAmbiguityHeader(hits: { symbol: { name: string; file: string; line: number } }[]): string {
  if (hits.length <= 1) return "";
  return `⚠ 同名定义 ${hits.length} 处(按类名前缀/文件区分,逐条列出如下):\n` +
    hits.map((h) => `  - ${h.symbol.name} @ ${h.symbol.file}:${h.symbol.line}`).join("\n");
}

/** 符号未命中建议(2026-10-21 B,单一真相):大小写归一/编辑距离≤2 近似候选,
 * 跨仓聚合去重(逐仓 suggestSymbolNames,大小写命中排前、组内 inCount 降序)。
 * CLI 文本面(dispatchTool)与 --json suggestions 字段同源消费——agent 拼错一个
 * 字符不再断链(实锤:INIT_DETECTOR / initdetect 双双「未找到符号」)。 */
export function symbolSuggestions(sts: RepoState[], name: string, limit = 5): string[] {
  if (sts.length === 0 || !name) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const st of sts) {
    for (const s of suggestSymbolNames(st.index, name, limit)) {
      if (!seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
  }
  return out.slice(0, limit);
}

/** 「未找到符号」miss 文案(单一真相;+容错建议行,建议为空=原样不加空尾巴)。 */
export function symbolMissText(sts: RepoState[], name: string, why = "", stale = ""): string {
  const base = `未找到符号: ${name}(已查就绪仓: ${sts.map((s) => s.name).join(", ")})`;
  const suggest = symbolSuggestions(sts, name);
  return base + (suggest.length ? `;你是不是想找: ${suggest.join(", ")}` : "") + why + stale;
}

/** 文件符号表 → 同源文本(2026-10-21:symKind 如实标注——interface/type/enum/arrow/class
 * 不再与普通函数混为一谈;name 已含 parent 限定名,嵌套符号可直接看出所在处)。 */
export function formatFileNodes(s: RepoState, nodes: C2fNode[]): string {
  return nodes
    .map((n) => `  [${s.name}] ${n.kind === "trunk" ? "[入口]" : n.kind === "leaf" ? "[叶子]" : "      "} ${n.name} :${n.line}${n.symKind ? ` {${n.symKind}}` : ""}${n.dataType ? ` [${n.dataType}]` : ""} (调用 ${n.outCount} / 被调 ${n.inCount})`)
    .join("\n");
}

/** 单仓入口清单块(`## <repo>` 头,跨仓分组语义的一部分)。
 * step-067 fail-visible:语言覆盖缺口时显式状态行(零覆盖/低覆盖告警),不再输出无告警的误导视图——
 * step-065 实测:C 仓仅 1 个 py 文件被索引,entrypoints 只报 get_rank1 而工具看似健康。 */
export function formatEntrypointsBlock(st: RepoState, limit = 15, perRepo = 8, opts: { all?: boolean } = {}): string {
  // 覆盖状态(manifest 有则用,旧索引现场重算;同步缓存路径,dispatchTool 同步约束)
  const cov = st.index.coverage ?? languageCoverageCachedSync(st.root, Object.keys(st.index.byFile));
  const warns = coverageWarnings(cov);
  const statusLines = warns.map((w) => `  ⚠️ 覆盖缺口: ${w}`)
    .concat(warns.length > 0 ? ["  (以上语言未进索引,入口清单只覆盖已索引语言——如实呈报,非全仓视图)"] : []);
  // 2026-10-22 P1:进程入口首节(启动器/进程 main,与扇出榜解耦)——「这个仓怎么跑起来」
  // 的第一屏答案;扇出榜语义不变,在其后。同步扫描(rg spawnSync 一次,~百 ms 级)。
  const procSection = renderProcessEntries(scanProcessEntriesSync(st.root, st.index, opts), 8);
  // step-141 P1-1:非产品路径(docs/tutorial/examples/test mocks)默认过滤,过滤条数如实呈报
  const meta = queryEntryPointsMeta(st.index, limit, opts);
  const eps = meta.kept;
  const filterLine = meta.note ? [`  [路径过滤] ${meta.note}`] : [];
  if (eps.length === 0) {
    // 空索引 ≠ 闭环/库形态:如实区分,不给误导归因
    const unsupported = unsupportedLanguageText(cov);
    const head = st.index.nodes.length === 0
      ? `## ${st.name}\n  索引为空(${unsupported ?? "无源码文件被索引——语言覆盖缺口或索引残缺"}${
        // step-141 P0-2:无 adapter 的语言不问「重建」——重建永不会成功(诚实口径,与 doctor 对齐)
        unsupported ? ";该仓可索引的源码文件为 0" : ";后台重建中,稍后重试"})`
      : `## ${st.name}\n  无扇出入口(入度全>0,闭环/库形态)${meta.filtered > 0 ? `(已过滤 ${meta.filtered} 条非产品路径入口,--all 查看)` : ""}`;
    const lines = [...head.split("\n"), ...procSection, ...filterLine, ...statusLines];
    return lines.join("\n");
  }
  const head = `## ${st.name}\n` + eps.slice(0, perRepo).map((n) => `  ${n.name} — ${n.file}:${n.line} (下游 ${n.outCount})`).join("\n");
  const lines = [...head.split("\n"), ...procSection, ...filterLine, ...statusLines];
  return lines.join("\n");
}

/** 索引后台重建的 worker 候选(跨平台定位,2026-10-15 迁移时修掉 URL().pathname 的 Windows 假设):
 * ① gateway dist 形态:sense-index-worker.mjs/.js 与本模块同目录(bundle/tsc 两种落点);
 * ② 本包 dist 形态:cli.js/cli.mjs 同目录(codesense index 作为 worker,退出码 0=成功);
 * ③ 本包 dev(src)形态:../dist/cli.js。
 * 前缀候选优先生效=gateway 现行为逐字节保留;CLI 形态自动落到自己的 index 子命令。 */
function resolveWorker(root: string): { path: string; args: string[] } | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const name of ["sense-index-worker.mjs", "sense-index-worker.js"]) {
    const p = join(here, name);
    if (existsSync(p)) return { path: p, args: [root] };
  }
  for (const p of [join(here, "cli.js"), join(here, "cli.mjs"), join(here, "..", "dist", "cli.js"), join(here, "..", "dist", "cli.mjs")]) {
    if (existsSync(p)) return { path: p, args: ["index", root, "--quiet"] };
  }
  return null;
}

export function createCodeIndexMcp(root: string, opts: { autoBuild?: boolean } = {}): CodeIndexMcp {
  const roots = discoverRoots(root);
  // autoBuild=false(CLI 一次性进程用):查询只读现成索引,不 fork 后台重建——
  // 一次性进程退出会把 fork 出的构建子进程变成孤儿;CLI 侧自己同步补建后再进查询
  const autoBuild = opts.autoBuild !== false;
  const indexCache = new Map<string, C2fIndex>();
  const rebuilding = new Set<string>();
  const failedAt = new Map<string, number>();

  function ensureBuild(r: string): void {
    if (rebuilding.has(r)) return;
    if (Date.now() - (failedAt.get(r) ?? 0) < 60_000) return;
    const worker = resolveWorker(r);
    if (!worker) return;
    rebuilding.add(r);
    const w = fork(worker.path, worker.args, { stdio: "ignore" });
    w.on("exit", (code) => {
      rebuilding.delete(r);
      if (code === 0) {
        const idx = loadIndex(r);
        if (idx) indexCache.set(r, idx);
      } else {
        failedAt.set(r, Date.now());
      }
    });
    w.on("error", () => {
      rebuilding.delete(r);
      failedAt.set(r, Date.now());
    });
  }

  /** 各仓就绪索引(缓存优先,盘上兜底;过期如实标注)。 */
  function states(): RepoState[] {
    const out: RepoState[] = [];
    for (const r of roots) {
      let idx = indexCache.get(r);
      if (!idx || indexStale(r, idx)) {
        const l = loadIndex(r);
        if (l) {
          indexCache.set(r, l);
          idx = l;
        }
      }
      if (idx) out.push({ root: r, name: basename(r), index: idx, stale: indexStale(r, idx) });
    }
    return out;
  }

  /** 对缺失/过期的仓触发后台构建(即使已有别的仓就绪——旧逻辑的饥饿根源)。 */
  function kickBuilds(): void {
    if (!autoBuild) return;
    for (const r of roots) {
      const idx = indexCache.get(r) ?? loadIndex(r);
      if (!idx || indexStale(r, idx)) ensureBuild(r);
    }
  }

  function repoByName(name: string): string | null {
    const direct = roots.find((r) => basename(r) === name || resolve(r) === resolve(name));
    if (direct) return direct;
    // --repo 回查注册表(2026-10-21 E④):cd 进 ~/sense-eval/agent_alpha 不带 --root 能查,
    // 但 --repo agent_alpha 从别的根报「未知仓」——repo 参数只认当前进程已加载的就绪集,
    // 注册表(~/.codesense/registry.json)才是跨根路由的真相源。命中即纳入本工作区
    //(索引未建=显式「尚未就绪」,不误报未知仓)。
    const reg = loadRegistry().roots.find((e) => e.name === name || normalizeRoot(e.root) === normalizeRoot(name));
    if (reg && existsSync(reg.root)) {
      const norm = normalizeRoot(reg.root);
      if (!roots.some((r) => normalizeRoot(r) === norm)) roots.push(norm);
      return norm;
    }
    return null;
  }

  function repoNames(): string {
    // 可用仓名=工作区根 ∪ 注册表(--repo 现在两者都认;报错面给全量,agent 能自纠)
    const local = roots.map((r) => basename(r));
    const reg = loadRegistry().roots.map((e) => e.name);
    return [...new Set([...local, ...reg])].join(", ") || "无";
  }

  /** 路径首段命中子仓名→剥前缀定向该仓。 */
  function splitRepoPath(p: string): { root: string; rel: string } | null {
    const norm = p.replace(/\\/g, "/");
    const seg = norm.split("/")[0] ?? "";
    const hit = seg ? roots.find((r) => basename(r) === seg) : null;
    return hit ? { root: hit, rel: norm.slice(seg.length + 1) } : null;
  }

  /** 显式 repo 参数→只查该仓;未知仓名→err。 */
  function pickForced(args: Record<string, unknown>): { sts: RepoState[]; err?: string; missing?: string } {
    const ra = args?.repo ? String(args.repo) : null;
    if (!ra) return { sts: states() };
    const r = repoByName(ra);
    if (!r) return { sts: [], err: `未知仓: ${ra}(可用: ${repoNames()})` };
    const sts = states().filter((s) => s.root === r);
    if (sts.length === 0) return { sts: [], missing: basename(r) };
    return { sts };
  }

  function toolResult(text: string): McpToolResult {
    return { content: [{ type: "text", text }], isError: false };
  }

  /** 工具入参 required 校验(2026-10-20 修):单一真相=CODE_INDEX_TOOLS[].inputSchema.required。
   * 缺陷现场:tools/call 传 {"symbol":"Execute"}(参数名写错)时旧实现拿空名去查,返回
   * 「未找到符号: (已查就绪仓: go-cobra)」且 isError:false——调用方 agent 会把「参数名打错」
   * 误读成「符号不存在」并继续错下去。现在缺参/空串/参数名不符一律 isError:true,不进查询。
   * 落点是两个分派入口(dispatchTool 覆盖 CLI 查询路径,dispatchToolAsync 覆盖 serve 的
   * tools/call),13 个工具全部生效,不是只修 symbol。 */
  function missingRequiredArgs(name: string, args: Record<string, unknown>): string | null {
    const tool = ALL_TOOLS.find((t) => t.name === name);
    const schema = tool?.inputSchema as
      | { required?: string[]; properties?: Record<string, unknown> }
      | undefined;
    const required = schema?.required ?? [];
    const missing = required.filter((k) => {
      const v = args?.[k];
      return typeof v !== "string" || v.trim() === "";
    });
    if (missing.length === 0) return null;
    const usable = Object.keys(schema?.properties ?? {});
    const given = Object.keys(args ?? {}).filter((k) => !required.includes(k));
    const hint = missing.map((k) => `缺少必填参数 ${k}(期望参数名:${k})`).join(";");
    const gotNote = given.length > 0
      ? `;收到的其它键: ${given.join(", ")}(参数名须与 schema 一致)`
      : "";
    return `${hint}${gotNote} [工具 ${name};可用参数: ${usable.join(", ")}]`;
  }

  function notReady(what?: string): string {
    return `索引尚未就绪${what ? `: ${what}` : ""}(后台构建中,稍后重试)`;
  }

  function staleNote(sts: RepoState[]): string {
    const building = roots.filter((r) => rebuilding.has(r)).map((r) => basename(r));
    const stale = sts.filter((s) => s.stale).map((s) => s.name);
    const bits: string[] = [];
    if (building.length) bits.push(`索引后台更新中: ${building.join(", ")}`);
    else if (stale.length) bits.push(`索引可能过期: ${stale.join(", ")}`);
    // step-141 P0-1:采样索引不静默——count 比对已退化的口径要说出来,否则「新鲜」结论看起来比实际强
    const sampled = sts.map((s) => s.index).map((idx) => samplingNote(idx)).filter((x): x is string => !!x);
    if (sampled.length) bits.push([...new Set(sampled)].join(";"));
    return bits.length ? `\n(${bits.join(";")})` : "";
  }

  /** 空索引的真实原因(step-141 P0-2,单一真相;五处调用点共用,禁止各自拼措辞)。
   * 无 adapter 的语言(Rust/PHP/Ruby/C#…)永不会被索引——说「已触发后台重建,稍后重试」
   * 是把用户送进死循环(实测 rust-ripgrep/php-guzzle/ruby-jekyll 每查必刷)。措辞与 doctor
   * 的 coverageWarnings 对齐:同一事实、同一说法。 */
function emptyIndexWhy(sts: RepoState[]): string {
    const unsupported = [...new Set(sts.map((s) => unsupportedLanguageTextSync(s.root, Object.keys(s.index.byFile))).filter((x): x is string => !!x))];
    if (unsupported.length > 0) return `——${unsupported.join(";")}`;
    return "——就绪仓的索引全为空(源码语言未被索引覆盖或索引残缺,已触发后台重建,稍后重试)";
  }

  /** 2026-11-08 全覆盖:file miss 先查文件级状态表(与 gateway formatQuery 同口径)——
   * skipped/symbol-less/error 都有可操作原因,不再统一「文件无索引符号」。 */
  function fileStatusMiss(index: C2fIndex, rel: string): string | null {
    const table = index.fileStatus;
    if (!table) {
      // 兼容旧索引:skippedFiles 原因表仍在,别退化成裸「文件无索引符号」。
      const s = index.skippedFiles?.find((x) => x.rel === rel || x.rel.endsWith("/" + rel) || rel.endsWith("/" + x.rel));
      return s ? `文件未进索引: ${rel}(原因: ${s.reason};仍可 refs/grep/read_file)` : null;
    }
    const key = Object.hasOwn(table, rel) ? rel : Object.keys(table).find((k) => k.endsWith("/" + rel));
    const st = key ? table[key] : undefined;
    if (!st) return null;
    if (st.status === "skipped") return `文件未进索引: ${rel}(原因: ${st.reason};仍可 refs/grep/read_file)`;
    if (st.status === "error") return `文件解析失败(已登记): ${rel}(原因: ${st.reason};可用 read_file/refs)`;
    if (st.status === "symbol-less") return `文件已索引但无函数/类声明: ${rel}(barrel 导出/副作用脚本/测试用例等;内容用 read_file/refs,import 关系用 impact)`;
    return null;
  }

  function dispatchTool(name: string, args: Record<string, unknown>): McpToolResult {
    kickBuilds();
    const missingArg = missingRequiredArgs(name, args);
    if (missingArg) return { content: [{ type: "text", text: missingArg }], isError: true };
    switch (name) {
      case "code_index_symbol": {
        const { sts, err, missing } = pickForced(args);
        if (err) return toolResult(err);
        if (missing) return toolResult(notReady(missing));
        const depthArg = parseDepthArg(args);
        if ("error" in depthArg) return { content: [{ type: "text", text: depthArg.error }], isError: true };
        const sym = String(args?.name ?? "");
        if (depthArg.depth > 1 || depthArg.labeled) {
          const merged = sts.flatMap((st) => querySymbolDeep(st.index, sym, depthArg.depth).map((h) => ({ st, h })));
          if (merged.length === 0) {
            return toolResult(symbolMissText(sts, sym, "", staleNote(sts)));
          }
          return toolResult(formatAmbiguityHeader(merged.map((m) => m.h)) +
            merged.map((m) => formatSymbolHitDeep(m.st, m.h, depthArg.depth)).join("\n---\n") + staleNote(sts));
        }
        const merged: { st: RepoState; h: SymbolQueryResult }[] = [];
        for (const st of sts) for (const h of querySymbol(st.index, sym)) merged.push({ st, h });
        if (merged.length === 0) {
          // 诚实降级:就绪仓索引全空时点破真实原因(无 adapter 语言/残缺索引),不给「没这个符号」的假象
          const emptyIdx = sts.length > 0 && sts.every((s) => s.index.nodes.length === 0);
          const why = emptyIdx ? emptyIndexWhy(sts) : "";
          return toolResult(symbolMissText(sts, sym, why, staleNote(sts)));
        }
        return toolResult(formatAmbiguityHeader(merged.map((m) => m.h)) +
          merged.map((m) => formatSymbolHit(m.st, m.h)).join("\n---\n") + staleNote(sts));
      }
      case "code_index_file":
      case "code_index_filegraph": {
        const { sts, err, missing } = pickForced(args);
        if (err) return toolResult(err);
        if (missing) return toolResult(notReady(missing));
        const isGraph = name === "code_index_filegraph";
        const raw = String(args?.path ?? "");
        let pinned = args?.repo ? repoByName(String(args.repo)) : null;
        let rel = raw;
        if (!pinned) {
          const sp = splitRepoPath(raw);
          if (sp) {
            pinned = sp.root;
            rel = sp.rel;
          }
        }
        if (pinned) {
          const st = sts.find((s) => s.root === pinned);
          if (!st) return toolResult(notReady(basename(pinned)));
          const nodes = queryFile(st.index, rel);
          if (nodes.length === 0) {
            const stMsg = fileStatusMiss(st.index, rel);
            if (stMsg) return toolResult(stMsg + `\n(仓: ${st.name})` + staleNote([st]));
            const why = st.index.nodes.length === 0
              ? `(${unsupportedLanguageTextSync(st.root, Object.keys(st.index.byFile)) ?? "该仓索引为空:语言未被索引覆盖或索引残缺,已触发后台重建"})`
              : "(索引只收源码文件,文档/测试目录不在索引)";
            return toolResult(`文件无索引符号: ${raw}(仓 ${st.name}${why})` + staleNote([st]));
          }
          return toolResult((isGraph ? renderFile(st.index, rel) : formatFileNodes(st, nodes)) + `\n(仓: ${st.name})` + staleNote([st]));
        }
        const hits: { st: RepoState; nodes: C2fNode[] }[] = [];
        for (const st of sts) {
          const nodes = queryFile(st.index, rel);
          if (nodes.length > 0) hits.push({ st, nodes });
        }
        if (hits.length === 0) {
          for (const st of sts) {
            const stMsg = fileStatusMiss(st.index, rel);
            if (stMsg) return toolResult(stMsg + `\n(仓: ${st.name})` + staleNote([st]));
          }
          const emptyIdx = sts.length > 0 && sts.every((s) => s.index.nodes.length === 0);
          const why = emptyIdx ? `;${emptyIndexWhy(sts).replace(/^——/, "")}` : "";
          return toolResult(`文件无索引符号: ${raw}(已查就绪仓: ${sts.map((s) => s.name).join(", ")}${why};可加 repo 参数指定仓,或等其余仓索引建好)` + staleNote(sts));
        }
        const first = hits[0]!;
        const others = hits.slice(1).map((h) => h.st.name);
        const body = isGraph ? renderFile(first.st.index, rel) : formatFileNodes(first.st, first.nodes);
        const note = others.length > 0
          ? `\n(仓: ${first.st.name};同名文件另见: ${others.join(", ")}——可加 repo 参数消歧)`
          : `\n(仓: ${first.st.name})`;
        return toolResult(body + note + staleNote(sts));
      }
      case "code_index_entrypoints": {
        const { sts, err, missing } = pickForced(args);
        if (err) return toolResult(err);
        if (missing) return toolResult(notReady(missing));
        if (sts.length === 0) return toolResult(notReady());
        const parts = sts.map((st) => formatEntrypointsBlock(st));
        return toolResult(parts.join("\n") + staleNote(sts));
      }
      case "code_index_modules": {
        // 2026-10-22 P1:模块视图(与 CLI codesense modules 同源渲染)
        const { sts, err, missing } = pickForced(args);
        if (err) return toolResult(err);
        if (missing) return toolResult(notReady(missing));
        if (sts.length === 0) return toolResult(notReady());
        const graph = args?.graph === true;
        const parts = sts.map((st) => `## ${st.name}\n${renderModuleView(buildModuleView(st.index), { graph })}`);
        return toolResult(parts.join("\n\n") + staleNote(sts));
      }
      case "code_index_flow": {
        const { sts, err, missing } = pickForced(args);
        if (err) return toolResult(err);
        if (missing) return toolResult(notReady(missing));
        if (sts.length === 0) return toolResult(notReady());
        const levelArg = String(args?.level ?? "auto");
        if (!["module", "file", "function", "auto"].includes(levelArg)) {
          return { content: [{ type: "text", text: `level 必须是 module|file|function|auto(收到 ${levelArg})` }], isError: true };
        }
        const level = levelArg as "module" | "file" | "function" | "auto";
        const target = args?.target ? String(args.target) : undefined;
        const scope = args?.scope ? String(args.scope) : undefined;
        const maxNodes = typeof args?.maxNodes === "number" && Number.isFinite(args.maxNodes) ? args.maxNodes : undefined;
        const upstream = typeof args?.upstream === "number" && Number.isFinite(args.upstream) ? args.upstream : undefined;
        const downstream = typeof args?.downstream === "number" && Number.isFinite(args.downstream) ? args.downstream : undefined;
        const graph = args?.graph !== false;
        const parts: string[] = [];
        for (const st of sts) {
          try {
            const proc = scanProcessEntriesSync(st.root, st.index).entries;
            const flow = buildCodeFlow(st.index, {
              level,
              ...(scope ? { scope } : {}),
              ...(target ? { target } : {}),
              ...(upstream !== undefined ? { upstream } : {}),
              ...(downstream !== undefined ? { downstream } : {}),
              ...(maxNodes !== undefined ? { maxNodes } : {}),
              processEntries: proc,
            });
            const head = sts.length > 1 ? `## ${st.name}\n` : "";
            parts.push(head + renderCodeFlowText(flow) + (graph ? "\n\n" + renderCodeFlowMermaid(flow, { legend: false }) : ""));
          } catch (e) {
            if (e instanceof FlowTargetError) parts.push(`[${st.name}] ${e.message}`);
            else throw e;
          }
        }
        return toolResult(parts.join("\n\n") + staleNote(sts));
      }
      case "code_index_graph": {
        const { sts, err, missing } = pickForced(args);
        if (err) return toolResult(err);
        if (missing) return toolResult(notReady(missing));
        if (sts.length === 0) return toolResult(notReady());
        const depthArg = parseDepthArg(args);
        if ("error" in depthArg) return { content: [{ type: "text", text: depthArg.error }], isError: true };
        const sym = String(args?.name ?? "");
        for (const st of sts) {
          if (querySymbol(st.index, sym).length > 0) {
            return toolResult(renderNeighborhood(st.index, sym, 26, depthArg.depth) + `\n(仓: ${st.name})` + staleNote(sts));
          }
        }
        {
          const emptyIdx = sts.length > 0 && sts.every((s) => s.index.nodes.length === 0);
          const why = emptyIdx ? emptyIndexWhy(sts) : "";
          return toolResult(`未找到符号: ${sym}(已查就绪仓: ${sts.map((s) => s.name).join(", ")})` + why + staleNote(sts));
        }
      }
      case "code_index_impact": {
        const { sts, err, missing } = pickForced(args);
        if (err) return toolResult(err);
        if (missing) return toolResult(notReady(missing));
        if (sts.length === 0) return toolResult(notReady());
        const depthArg = parseDepthArg(args);
        if ("error" in depthArg) return { content: [{ type: "text", text: depthArg.error }], isError: true };
        const sym = String(args?.name ?? "");
        const merged: { st: RepoState; text: string }[] = [];
        for (const st of sts) {
          const r = queryImpact(st.index, sym, { depth: depthArg.depth });
          if (r.definitions.length === 0) continue;
          // renderImpact 内部:多定义=定义块逐个渲染,文件/测试/汇总只出一次(不重复)
          merged.push({ st, text: `[${st.name}] ${renderImpact(r)}` });
        }
        if (merged.length === 0) {
          const emptyIdx = sts.length > 0 && sts.every((s) => s.index.nodes.length === 0);
          const why = emptyIdx ? "——就绪仓的索引全为空(语言覆盖缺口或索引残缺,已触发后台重建)" : "";
          return toolResult(`未找到符号: ${sym}(已查就绪仓: ${sts.map((s) => s.name).join(", ")})` + why + staleNote(sts));
        }
        return toolResult(merged.map((m) => m.text).join("\n---\n") + staleNote(sts));
      }
      default:
        return { content: [{ type: "text", text: `未知工具: ${name}` }], isError: true };
    }
  }

  /** sensing 三工具的分派(step-080 B①)。与 CLI queryApiCmd/queryStateCmd/queryAlgoCmd
   * 同核:同一 query* 主入口 + 同一 render* 渲染函数(不复制逻辑);缺省输出=渲染函数逐字
   * 输出(无前缀/无注记),与 `codesense api|state|algo --root <同一根>` 逐字节同源。
   * repo 参数=定向该仓目录扫描;未知仓与 pickForced 同文案。扫描失败 isError 兜底,
   * 不炸 stdio 协议面。 */
  async function dispatchToolAsync(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    // surface:concept(逗号分隔)与 concepts(数组)二选一——数组形态先归一成 concept,
    // 让 required 校验与 handler 共用同一条入参语义(只给 concepts 数组也算给了概念词)。
    if (
      name === "code_index_surface" &&
      !(typeof args?.concept === "string" && args.concept.trim() !== "") &&
      Array.isArray(args?.concepts)
    ) {
      const joined = (args.concepts as unknown[]).filter((x): x is string => typeof x === "string").join(",");
      if (joined) args = { ...args, concept: joined };
    }
    // required 校验前置(与 dispatchTool 同一函数/同一真相:CODE_INDEX_TOOLS[].inputSchema.required)。
    // serve 的 tools/call 全部 14 个工具都经此路径,缺参/空串/参数名错在此拦下,不进查询。
    const missingArg = missingRequiredArgs(name, args);
    // surface:缺 concept 时在标准参数提示后补一行用法(通用提示只报参数名,调用方不知道该写什么)
    if (missingArg) {
      const usage = name === "code_index_surface"
        ? ";用法: code_index_surface { concept: \"概念词[,概念词2]\" }(或 concepts: [\"a\",\"b\"] 数组;root 可选)"
        : "";
      return { content: [{ type: "text", text: missingArg + usage }], isError: true };
    }
    if (name === "code_index_wire") {
      // 2026-10-21:WS 消息协议表面(纯行扫描,索引非前置)。root=可选覆盖,
      // repo=定向子仓目录;changed=true 只列 git 工作区改动涉及的 type。
      let scanRoot = root;
      const rootArg = args?.root;
      if (typeof rootArg === "string" && rootArg.trim()) scanRoot = resolve(root, rootArg.trim());
      if (!existsSync(scanRoot)) {
        return { content: [{ type: "text", text: `root 不存在: ${scanRoot}(root 参数按服务实例根解析)` }], isError: true };
      }
      const ra = args?.repo ? String(args.repo) : null;
      if (ra) {
        const r = repoByName(ra);
        if (r) scanRoot = r;
        else if (existsSync(join(scanRoot, ra))) scanRoot = join(scanRoot, ra);
        else return toolResult(`未知仓: ${ra}(可用: ${repoNames()})`);
      }
      try {
        const wire = await import("@lampgenie/code-sense/wire");
        const r = wire.scanWire(scanRoot, { changed: args?.changed === true });
        return toolResult(wire.renderWire(r));
      } catch (err) {
        return { content: [{ type: "text", text: `wire 扫描失败: ${String(err instanceof Error ? err.message : err)}` }], isError: true };
      }
    }
    if (name === "code_index_refs") {
      // 2026-10-21:字面量引用面(纯行扫描,索引非前置;所属符号读现成索引,缺席留空)。
      // root=可选覆盖,repo=定向子仓目录;includeTests/includeDocs 缺省 true。
      let scanRoot = root;
      const rootArg = args?.root;
      if (typeof rootArg === "string" && rootArg.trim()) scanRoot = resolve(root, rootArg.trim());
      if (!existsSync(scanRoot)) {
        return { content: [{ type: "text", text: `root 不存在: ${scanRoot}(root 参数按服务实例根解析)` }], isError: true };
      }
      const ra = args?.repo ? String(args.repo) : null;
      if (ra) {
        const r = repoByName(ra);
        if (r) scanRoot = r;
        else if (existsSync(join(scanRoot, ra))) scanRoot = join(scanRoot, ra);
        else return toolResult(`未知仓: ${ra}(可用: ${repoNames()})`);
      }
      const literal = typeof args?.literal === "string" ? args.literal : "";
      try {
        const lr = await import("@lampgenie/code-sense/retrieval/literal-refs");
        const r = await lr.scanLiteralRefs(scanRoot, literal, {
          includeTests: args?.includeTests !== false,
          includeDocs: args?.includeDocs !== false,
        });
        return toolResult(lr.renderLiteralRefs(r));
      } catch (err) {
        return { content: [{ type: "text", text: `refs 扫描失败: ${String(err instanceof Error ? err.message : err)}` }], isError: true };
      }
    }
    if (name === "code_index_branches") {
      // 2026-10-23:分支/循环骨架(与 CLI branches 命令同源;纯 tree-sitter 扫描,索引非前置)。
      let scanRoot = root;
      const rootArg = args?.root;
      if (typeof rootArg === "string" && rootArg.trim()) scanRoot = resolve(root, rootArg.trim());
      if (!existsSync(scanRoot)) {
        return { content: [{ type: "text", text: `root 不存在: ${scanRoot}(root 参数按服务实例根解析)` }], isError: true };
      }
      const ra = args?.repo ? String(args.repo) : null;
      if (ra) {
        const r = repoByName(ra);
        if (r) scanRoot = r;
        else if (existsSync(join(scanRoot, ra))) scanRoot = join(scanRoot, ra);
        else return toolResult(`未知仓: ${ra}(可用: ${repoNames()})`);
      }
      const p = typeof args?.path === "string" ? args.path.replace(/\\/g, "/").trim() : "";
      if (!p) return toolResult("branches 需要 path=文件相对路径(如 modules/asr/qwen_asr.py)");
      try {
        const d = await import("@lampgenie/code-sense/sensing/decision");
        const r = await d.scanDecisionFile(scanRoot, p);
        if (!r) {
          return toolResult(`未提取到分支/循环骨架: ${p}(支持 py/ts/tsx/js/jsx/mjs/cjs/c/h/cc/cpp/hpp/java/go;文件须存在于仓内)`);
        }
        return toolResult(d.renderDecisionSkeleton(r));
      } catch (err) {
        return { content: [{ type: "text", text: `branches 扫描失败: ${String(err instanceof Error ? err.message : err)}` }], isError: true };
      }
    }
    if (name === "code_index_surface") {
      // 2026-11-06:概念足迹面(与 CLI surface 命令同源;纯行扫描,索引非前置)。
      // concept=逗号分隔多个,concepts=数组形态(两者可同时给,合并去重);root=可选覆盖,
      // repo=定向子仓目录。
      const conceptArg = typeof args?.concept === "string" ? args.concept : "";
      const arr = Array.isArray(args?.concepts) ? args.concepts.filter((x): x is string => typeof x === "string") : [];
      const concepts = [...conceptArg.split(","), ...arr].map((s) => s.trim()).filter(Boolean);
      if (concepts.length === 0) {
        return {
          content: [{ type: "text", text: `surface 需要 concept=概念词(多个用逗号分隔,或用 concepts=[…] 数组):每次把该概念的全部落点按 ${SURFACE_CATEGORIES.length} 类表面列全` }],
          isError: true,
        };
      }
      let scanRoot = root;
      const rootArg = args?.root;
      if (typeof rootArg === "string" && rootArg.trim()) scanRoot = resolve(root, rootArg.trim());
      if (!existsSync(scanRoot)) {
        return { content: [{ type: "text", text: `root 不存在: ${scanRoot}(root 参数按服务实例根解析)` }], isError: true };
      }
      const ra = args?.repo ? String(args.repo) : null;
      if (ra) {
        const r = repoByName(ra);
        if (r) scanRoot = r;
        else if (existsSync(join(scanRoot, ra))) scanRoot = join(scanRoot, ra);
        else return toolResult(`未知仓: ${ra}(可用: ${repoNames()})`);
      }
      try {
        const sf = await import("@lampgenie/code-sense/surface");
        const r = await sf.scanSurface(scanRoot, concepts);
        return toolResult(sf.renderSurfaceMarkdown(r));
      } catch (err) {
        return { content: [{ type: "text", text: `surface 扫描失败: ${String(err instanceof Error ? err.message : err)}` }], isError: true };
      }
    }
    if (name === "code_index_vars") {
      // step-089 P1:文件变量类型清单(逐文件深提取,索引非前置)。路径=根内相对路径;
      // 多仓工作区首段命中子仓名时自动剥前缀定向;显式 repo 参数优先。
      const rawPath = String(args?.file ?? "").replace(/\\/g, "/");
      if (!rawPath) return toolResult("vars 需要 file 参数(相对路径)");
      let scanRoot = root;
      let rel = rawPath;
      const firstSeg = rawPath.split("/")[0]!;
      if (
        firstSeg && existsSync(join(root, firstSeg)) &&
        (existsSync(join(root, firstSeg, ".git")) || existsSync(join(root, firstSeg, "package.json")))
      ) {
        scanRoot = join(root, firstSeg);
        rel = rawPath.slice(firstSeg.length + 1);
      }
      const ra = args?.repo ? String(args.repo) : null;
      if (ra) {
        const r = repoByName(ra);
        if (!r) return toolResult(`未知仓: ${ra}(可用: ${repoNames()})`);
        scanRoot = r;
        const prefix = basename(r) + "/";
        if (rel.startsWith(prefix)) rel = rel.slice(prefix.length);
      }
      try {
        const typed = await import("@lampgenie/code-sense/typed/index");
        const r = await typed.extractTypedSymbols(scanRoot, rel);
        return toolResult(typed.renderVars(r));
      } catch (err) {
        return { content: [{ type: "text", text: `vars 提取失败: ${String(err instanceof Error ? err.message : err)}` }], isError: true };
      }
    }
    if (name === "code_index_project") {
      // step-089 P3:项目底座画像(读 manifest,索引/LLM 均非前置;缺席=显式提示)
      let scanRoot = root;
      const ra = args?.repo ? String(args.repo) : null;
      if (ra) {
        const r = repoByName(ra);
        if (!r) return toolResult(`未知仓: ${ra}(可用: ${repoNames()})`);
        scanRoot = r;
      }
      try {
        const pp = await import("@lampgenie/code-sense/project-profile");
        const loaded = pp.loadProjectProfile(scanRoot);
        if (!loaded) {
          // 2026-10-22 P0:与其它工具一致按需生成确定性骨架,不再要求先跑 project --write。
          const profile = await pp.queryProjectProfile(scanRoot, { withLlm: false });
          return toolResult(pp.renderProjectProfile(profile) + "\n(确定性骨架按需生成,未落盘;需要 LLM 解读与缓存请运行 codesense project --write)");
        }
        return toolResult(pp.renderProjectProfile(loaded.profile, { stale: loaded.stale }));
      } catch (err) {
        return { content: [{ type: "text", text: `project 画像读取失败: ${String(err instanceof Error ? err.message : err)}` }], isError: true };
      }
    }
    if (name !== "code_index_api" && name !== "code_index_state" && name !== "code_index_algo") {
      return dispatchTool(name, args);
    }
    kickBuilds();
    let scanRoot = root;
    const ra = args?.repo ? String(args.repo) : null;
    if (ra) {
      const r = repoByName(ra);
      if (!r) return toolResult(`未知仓: ${ra}(可用: ${repoNames()})`);
      scanRoot = r;
    }
    try {
      const sensing = await import("@lampgenie/code-sense/sensing/index");
      if (name === "code_index_api") {
        const r = await sensing.queryApiSurface(scanRoot, { withImpact: true });
        return toolResult(sensing.renderApiSurface(r));
      }
      if (name === "code_index_state") {
        const r = await sensing.queryStateMachines(scanRoot);
        return toolResult(sensing.renderStateMachines(r));
      }
      const fileArg = args?.file !== undefined && args?.file !== null && args.file !== "" ? String(args.file) : undefined;
      const r = await sensing.queryAlgoProfiles(scanRoot, fileArg ? { file: fileArg } : {});
      return toolResult(sensing.renderAlgoProfiles(r));
    } catch (err) {
      return { content: [{ type: "text", text: `扫描失败: ${String(err instanceof Error ? err.message : err)}` }], isError: true };
    }
  }

  return { tools: CODE_INDEX_TOOLS, dispatchTool, dispatchToolAsync };
}
