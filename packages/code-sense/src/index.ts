/**
 * code_sense 唯一入口(designs/16 §2 定稿接口)。
 * 一期(step-017):debug 全量/explore grep 版/plan+ui 显式降级/五态/沙箱/预算。
 */
import { sandboxResolve, SandboxError } from "./search";
import { recallSymbols, type SymbolCandidate } from "./retrieval/symbol-recall";
import { isDocLikePath, isNonProductPath, isTestPath, isVendoredPath } from "./path-filter";
import { existsSync } from "node:fs";
import { relative, isAbsolute } from "node:path";
import { scanProject, type ProjectState } from "./project";
import { buildCallGraph, buildCallGraphFromFiles, subgraph, GRAPH_SOURCE_EXT, type CallGraph, type FlowEdge, type Signature } from "./callgraph/engine";
import { callchainMermaid } from "./callgraph/render";
import { LayerCache } from "./cache";
import { decideMode, type AutoDecision, type Mode } from "./profile";

export type EvidenceKind = "ast" | "index" | "readme" | "grep" | "suggested" | "inferred";
export type Tier = "semantic" | "structural" | "lexical";
export { renderForLlm } from "./llm";
// 符号优先召回(2026-10-21):explore 的查询→候选符号面;分词/词典在 ./search/cjk.ts(纯函数)
export type { SymbolCandidate, SymbolRef, SymbolDoc, SymbolScore } from "./retrieval/symbol-recall";
export type { QueryTerm, QueryTerms } from "./retrieval/cjk";
export { recallSymbols, scoreSymbols, loadIndexCached, clearSymbolRecallCache } from "./retrieval/symbol-recall";
export { splitIdentifier, queryTerms, segmentCjk, cjkToEnglish, CJK_EN_DICT, CJK_STOPWORDS } from "./retrieval/cjk";
export { callchainMermaid } from "./callgraph/render";
export { fileToModules, classifySymbol, type FileModules, type CodeModuleNode, type CodeModuleEdge } from "./callgraph/modules";
// senseB21:内嵌脚本索引(模板字符串 <script>/JS 段 → 虚拟符号+inline 作用域边)
export {
  extractInlineJsUnits, parseInlineJsAst, parseInlineJsAstTolerant, collectInlineJs, inlineJsTextCandidate,
  type InlineJsUnit, type InlineJsDecl, type InlineJsCall, type InlineJsAst, type JsNode, type InlineJsCollectStat,
} from "./callgraph/inline-js";
// senseB22:app 路由画像(自写 switchView/data-view 族 SPA 的前端路由表)
export { queryAppRoutes, renderAppRoutes, type AppRoutesResult, type AppRoute, type AppRouteOpen, type AppRouteEntry } from "./pageflow/approutes";
export {
  buildC2fIndex, saveIndex, loadIndex, loadIndexAsync, indexStale, indexDir,
  gitHeadSha, srcFingerprint, srcFingerprintCached,
  querySymbol, queryFile, queryEntryPoints, queryEntryPointsMeta, renderNeighborhood, renderFile,
  isSampledIndex, samplingNote, suggestSymbolNames,
  classify, applyJsxComponentUsage,
  type C2fIndex, type C2fNode, type C2fEdge, type NodeKind, type SymbolQueryResult,
} from "./callgraph/c2f";
// 模块视图(2026-10-22 P1):模块清单+跨模块交互矩阵+枢纽/测试面/mermaid——架构级答案面
export { buildModuleView, renderModuleView, mermaidModuleGraph, moduleGroupOf, type ModuleView, type ModuleInfo, type ModuleEdge, type HubInfo, type TestLink } from "./callgraph/modview";
/** 路径口径(2026-10-20 六面同源单一真相):测试/非产品路径/证据优先级。
 * 从本包根出口统一转出,消费方不必知道它住在 path-filter.ts 还是 callgraph/c2f.ts。 */
export { isTestPath, isNonProductPath, isNonProductEvidencePath, isBuildArtifactPath, isDocLikePath, evidenceRank, filterNonProductPaths, nonProductFilterNote } from "./path-filter";
export {
  queryImpact, renderImpact, renderSignature, IMPACT_DEFAULT_DEPTH,
  type ImpactResult, type ImpactDefinition, type ImpactRef, type ImpactTestRef, type ImpactFileRef,
} from "./callgraph/impact";
export {
  queryApiSurface, renderApiSurface, invalidateApiSurfaceCache,
  queryStateMachines, renderStateMachines,
  queryAlgoProfiles, renderAlgoProfiles,
  setSensingDeps, getSensingDeps, runSemanticBatch, excerptAt,
  extractApiSurface, extractEndpointsFromFile, detectFrameworks, normalizePath,
  extractStateMachinesFromFile, extractStateMachineSurface,
  extractAlgoProfileFromFile, extractAlgoSurface,
  findSpecFiles, parseSpecFile, parseSpecJson, parseSpecYamlSubset, reconcileSpec,
  type ApiEndpoint, type ApiSurface, type ApiSurfaceResult, type ApiEndpointJoined,
  type SpecOperation, type SpecParseResult, type SpecReconcile,
  type SenseLlm, type SensingDeps, type EvidenceAnchor, type SemanticOutcome,
  type StateMachine, type StateTransition, type StateMachineSurface,
  type AlgoKind, type AlgoSignal, type AlgoProfile, type AlgoSurface, type AlgoSurfaceResult,
} from "./sensing/index";

export interface CodeSenseResult {
  mode: "debug" | "plan" | "explore" | "ui" | "api" | "state" | "algo";
  autoDecision?: AutoDecision;
  projectState: ProjectState;
  /** explore 自举二轮的溯源说明(2026-10-18:低命中时用命中行标识符扩展再聚合,词列在说明里)。 */
  note?: string;

  callchain?: {
    center: { name: string; id: string; file: string; line: number };
    upstream: FlowEdge[];
    downstream: FlowEdge[];
    /** 面向人的关系图(mermaid)——LLM 消费上面的结构化边,图给面板(designs/16 §9 分工)。 */
    mermaid?: string;
    /** nd-id→符号名(面板点节点下钻用)。 */
    mermaidNodes?: { id: string; name: string }[];
    mermaidTruncated?: boolean;
  };
  signatures?: Record<string, Signature>;
  matches?: { file: string; line: number; text: string }[];
  /** explore 符号优先召回(2026-10-21):查询 → 候选符号(索引打分+1 跳邻居扩展)。
   * 加性字段(旧消费方忽略即可);缺省/空=索引未就绪或零命中(已如实降级到 grep)。 */
  symbols?: SymbolCandidate[];

  // —— ui 剖面(v8 §2) ——
  pageflow?: import("./pageflow/index").PageFlowResult;
  /** senseB22:app 路由画像(自写 switchView/data-view 族 SPA 的前端路由表;
   * React/Vue/HTML 三形态由 pageflow 承载,两者互补)。 */
  routes?: import("./pageflow/approutes").AppRoutesResult;

  // —— 业务感知剖面(step-077,designs/24)——
  /** api 剖面:HTTP 接口表面(确定性)+OpenAPI 对账+影响面+LLM 语义(opt-in 分层)。 */
  api?: import("./sensing/index").ApiSurfaceResult;
  /** state 剖面:状态机表面(五形态确定性提取,mermaid 可上白板)。 */
  state?: import("./sensing/index").StateMachineSurface;
  /** algo 剖面:算法画像(框架 API 模式识别+模块聚合+LLM 导读 opt-in)。 */
  algo?: import("./sensing/index").AlgoSurfaceResult;

  // —— plan 剖面(v8 §2) ——
  architecture?: { mermaid: string; nodes: unknown[]; edges: unknown[] };
  modules?: import("./modulemap/index").ModuleGuide[];
  hotspots?: string[];

  // —— debug 剖面:时序(R5-C20 接入:step-020 的孤儿能力接进返回) ——
  sequence?: import("./sequence/index").StaticSequence;

  // —— debug 剖面:IDE 三件套(任务开工全局意识的直接证据源) ——
  /** 圆心符号全仓引用(词法级,含 import/回调传递等小图解析不到的用法;封顶 80 条)。 */
  references?: { file: string; line: number; text: string }[];
  referenceCount?: number;
  /** 签名具名类型的定义位置(跳到类型定义;解析不到的类型不标)。 */
  typeDefs?: Record<string, { file: string; line: number }>;

  degraded?: { layer: string; reason: string; howToActivate: string }[];

  evidence: { path: string; line?: number; kind: EvidenceKind; tier: Tier }[];
  cache: { hit: boolean; builtAt: number };
  budget: { truncated: boolean; omittedCount: number };
}

export interface CodeSenseOptions {
  mode?: Mode;
  depth?: number;
  refresh?: boolean;
  /** plan 剖面跳过 archLlm(gitdiagram 全量生成)——step-052:30KB 提示下全量实测 ~55s,
   * 任务开工注入只取静态模块图(毫秒级);LLM 版由调用方走暖缓存/后台生成。 */
  skipArchLlm?: boolean;
}

/** plan 剖面依赖(可选注入:LLM 缺席时降级为静态模块结构,显式标注)。 */
export interface PlanDeps {
  archLlm?: import("./archmap/index").ArchLlm;
}
let planDeps: PlanDeps = {};
export function setPlanDeps(d: PlanDeps): void { planDeps = d; }

/** 结果预算上限(designs/16 §9)。 */
const RESULT_BUDGET_BYTES = 16 * 1024;
const GRAPH_TTL_MS = 60_000;

/** 懒图缓存:root|query|depth→小图(短 TTL;single-flight 防并发重扫)。
 * hit 字段如实反映缓存命中——未命中=每次真构建(此前的假命中是诚实性问题)。 */
const lazyGraphCache = new Map<string, { builtAt: number; graph: CallGraph }>();
const lazyGraphInflight = new Map<string, Promise<CallGraph>>();

async function getLazyGraph(key: string, refresh: boolean, build: () => Promise<CallGraph>): Promise<{ graph: CallGraph; hit: boolean; builtAt: number }> {
  const cached = lazyGraphCache.get(key);
  if (cached && !refresh && Date.now() - cached.builtAt < GRAPH_TTL_MS) {
    return { graph: cached.graph, hit: true, builtAt: cached.builtAt };
  }
  let p = lazyGraphInflight.get(key);
  if (!p) {
    p = build().then((graph) => {
      // 空图不缓存:ts-morph 高负载下偶发整图空解析(套件四见的同源抖动)——
      // 毒缓存会把 60s 内的全部重试钉死在失败态
      if (graph.symbols.size > 0) lazyGraphCache.set(key, { builtAt: Date.now(), graph });
      return graph;
    }).finally(() => {
      lazyGraphInflight.delete(key);
    });
    lazyGraphInflight.set(key, p);
  }
  const graph = await p;
  const entry = lazyGraphCache.get(key);
  return { graph, hit: false, builtAt: entry?.builtAt ?? Date.now() };
}

export async function codeSense(root: string, query: string, opts: CodeSenseOptions = {}): Promise<CodeSenseResult> {
  // 沙箱:root 本身解析(防 query 夹带路径由下游用,但 root 也过一遍 realpath)
  await sandboxResolve(root, ".");

  const scan = await scanProject(root);
  // 全图构建是重操作(分钟级):debug 走懒解析、plan 走采样——没有任何剖面需要全图,
  // 仅 D2 类「显式全图」调用方直接用 buildCallGraph。此处不再无条件触发。

  // 剖面判定(懒图模式下无全图符号表,known 恒空——符号判定靠形态规则)
  const mode = opts.mode && opts.mode !== "auto" ? opts.mode : null;
  const auto = mode ? null : decideMode(query, new Set<string>());
  const picked: "debug" | "plan" | "explore" | "ui" | "api" | "state" | "algo" = mode ?? auto!.picked;

  const base: CodeSenseResult = {
    mode: picked,
    ...(auto ? { autoDecision: auto } : {}),
    projectState: scan.state,
    evidence: [],
    // 非懒图剖面无图缓存;debug 剖面会用真实命中态覆盖此字段
    cache: { hit: false, builtAt: Date.now() },
    budget: { truncated: false, omittedCount: 0 },
  };

  if (scan.state === "EMPTY") {
    return {
      ...base,
      degraded: [
        { layer: "all", reason: "空项目(0 源文件)", howToActivate: "创建首批源文件后自动建索引" },
      ],
    };
  }

  let result: CodeSenseResult;
  switch (picked) {
    case "debug":
      // auto 提取出符号 token 时(混合语句),debug 用提取出的符号定位
      result = await debugProfile(root, auto?.symbol ?? query, scan, opts.depth ?? 2, base, opts.refresh === true);
      break;
    case "explore":
      result = await exploreProfile(root, query, base);
      break;
    case "plan":
      result = await planProfile(root, scan, base, opts);
      break;
    case "ui":
      result = await uiProfile(root, scan, base);
      break;
    case "api":
      result = await apiProfile(root, query, base);
      break;
    case "state":
      result = await stateProfile(root, base);
      break;
    case "algo":
      result = await algoProfile(root, query, base);
      break;
  }

  return applyBudget(result);
}


async function debugProfile(root: string, query: string, scan: import("./project").ProjectScan, depth: number, base: CodeSenseResult, refresh: boolean): Promise<CodeSenseResult> {
  // 懒解析:先 grep 定位涉事文件,只解析「命中文件+同目录源文件」(大仓秒级,防事件循环长阻塞)
  const { grepIn } = await import("./search");
  // file:line / 路径形态:路径本身直接入 focus(不靠 grep 运气——变体污染曾把目标文件挤出 focus,
  // 导致「未找到符号」误报);路径越界走沙箱拒,不静默
  const lineMatch = /^(.*):(\d+)$/.exec(query);
  const pathForm = /^(.*)\.(ts|tsx|js|jsx|mjs|cjs|py)$/.exec(query.split(":")[0]!.trim());
  const explicitFiles = new Set<string>();
  if (pathForm || lineMatch) {
    const pathPart = (lineMatch?.[1] ?? query).trim();
    try {
      const resolved = await sandboxResolve(root, pathPart);
      const rel = relative(root, resolved);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        return { ...base, degraded: [{ layer: "callgraph", reason: `路径越界: ${pathPart}`, howToActivate: "使用项目根内的相对路径" }] };
      }
      // basename 形态(logger.ts:98)解析到根下不存在的文件时不占 explicit——回落 grep 定位
      if (existsSync(resolved)) explicitFiles.add(rel);
    } catch (e) {
      if (e instanceof SandboxError) throw e;
      // 其它解析失败(如纯文件名不存在)回落 grep,不误伤
    }
  }
  // 多形态变体:全词(obj.method)/末段(method)/首段(obj)——单段截断会漏方法链定位(R4-C9)。
  // 过滤 <3 字符段:文件扩展名("ts")类垃圾变体会吃满 grep 配额,把真命中挤出 focus。
  const qBase = query.split(":")[0]!.trim();
  const qParts = qBase.split(/[.\s]+/).filter((p) => p.length >= 3);
  // 长变体(更特异)排前:短常用词("append")先跑会在配额内淹没特异性命中
  const qVariants = [...new Set([qBase, qParts[qParts.length - 1] ?? qBase, qParts[0] ?? qBase])]
    .filter((v) => v.length >= 2)
    .sort((a, b) => b.length - a.length);
  // 定义形态模式:「class X」「function X」——rg 并行截断的样本里引用/文档行会淹没定义文件,
  // 定义形态命中的文件特异性最高(模式最长),确定性置顶(ZC-10 主修)
  const dotted = /^([\w$]+)\.([\w$]+)$/.exec(query);
  const defShapes = dotted
    ? [`class ${dotted[1]}`]
    : [`class ${qBase}`, `function ${qBase}`];
  const rawHits = explicitFiles.size > 0 ? [] : await grepIn(root, [...defShapes, ...qVariants], { max: 150 });
  // 行级命中→文件级 focus:行配额下多引用文件会吃满配额、rg 线程遍历序不定,
  // 定义文件(文件名含 query)可能被挤出 focus →「未找到符号」的确定性误报来源。
  // 排序=特异性:文件名含变体/驼峰词干(定义文件)最优先,其次「最长变体命中」的文件
  // (obj.method 全形 > 类名 > 末段常用词——"append" 这类噪声变体命中的文件排最后)。
  const lowers = qVariants.map((v) => v.toLowerCase());
  // 驼峰词干(widgetMain→widget):定义文件常按概念命名而非函数全名
  const stems = lowers.map((v) => v.split(/(?=[A-Z])/)[0]!.toLowerCase()).filter((s) => s.length >= 4);
  // 双向文件名匹配:basename 含变体(tabStore→tabStoreProvider.tsx)之外,
  // 变体含 basename 去扩展名(MemoryJournal.append→journal.ts)——类名>文件名的命名惯例,
  // 让定义文件确定性置顶(同特异性文件的 rg 到达序不定)
  const basenameHit = (f: string) => {
    const base = f.split("/").pop()!.toLowerCase();
    const noExt = base.replace(/\.[a-z]+$/, "");
    return lowers.some((v) => base.includes(v)) || stems.some((s) => base.includes(s))
      || (noExt.length >= 4 && lowers.some((v) => v.includes(noExt)));
  };
  const fileScore = new Map<string, number>();
  const hitFiles: string[] = [];
  // 非源码文件(md/文档)不进 focus 也不算证据:C27 的本意是「文档里提及的符号」快速降级——
  // md 命中若算证据,ghostMentionFn 类查询会带 2 次退避+3 次重建(~10s)才降级(实锤复测)
  const isSrcHit = (f: string): boolean => GRAPH_SOURCE_EXT.has(f.slice(f.lastIndexOf(".")));
  for (const h of rawHits) {
    if (!isSrcHit(h.file)) continue;
    if (!fileScore.has(h.file)) hitFiles.push(h.file);
    const spec = (h.pattern ?? qBase).length;
    if (spec > (fileScore.get(h.file) ?? 0)) fileScore.set(h.file, spec);
  }
  const ordered = hitFiles
    .map((f, i) => ({ f, s: (basenameHit(f) ? 1000 : 0) + (fileScore.get(f) ?? 0), i }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.f)
    .slice(0, 25);
  const hits = ordered.map((file) => ({ file }));
  // focus 总量封顶:常用词变体会把命中目录的邻居全展开(harness 仓 "append" 实测炸到 100+ 文件,
  // ts-morph 解析超时)——显式/命中文件必保,邻居按序补足
  const FOCUS_MAX = 40;
  const focus = new Set<string>([...explicitFiles, ...ordered].slice(0, FOCUS_MAX));
  const hitDirs = new Set([...hits, ...[...explicitFiles].map((f) => ({ file: f }))].map((h) => h.file.split("/").slice(0, -1).join("/")));
  for (const f of scan.files) {
    if (focus.size >= FOCUS_MAX) break;
    const d = f.split("/").slice(0, -1).join("/");
    if (hitDirs.has(d)) focus.add(f);
  }
  const cacheKey = `${root}|${query}|${depth}`;
  // 零命中(拼错/不在本项目的符号)不建图:此前空 focus 落到「解析前 200 文件」慢路径,
  // 大仓上 15-25s 才返回降级——grep 零证据时直接空图秒回
  const noEvidence = focus.size === 0 && rawHits.length === 0 && explicitFiles.size === 0;
  const buildGraph = async () => (await import("./callgraph/engine")).buildCallGraphFromFiles(
    root,
    noEvidence ? [] : focus.size > 0 ? [...focus] : scan.files.slice(0, 200),
  );
  let { graph, hit, builtAt } = await getLazyGraph(cacheKey, refresh, buildGraph);
  // query 形态:file.ts:123 → 该行所属符号;符号名 → 匹配(唯一或最长包含);
  // obj.method → 容器.方法(方法符号 name=method、container=obj——整串从来匹配不上 name,
  // R4-C9 此前靠 degraded 分支假绿);方法在基类定义时(MemoryJournal.append→BaseJournal.append)
  // 按文件名↔类名互含回退到基类符号(继承语义)
  const resolve = (g: CallGraph): { center?: import("./callgraph/engine").Symbol; upstream: FlowEdge[]; downstream: FlowEdge[] } => {
    const preds: ((s: { id: string; name: string; file: string; line: number; container?: string }) => boolean)[] = [];
    if (lineMatch) {
      const f = lineMatch[1]!.replace(/^.*\//, "");
      const ln = Number(lineMatch[2]);
      preds.push((s) => s.file.endsWith(f) && Math.abs(s.line - ln) < 30);
    } else {
      const cands = [...g.symbols.values()].filter((s) => s.name === query);
      if (cands.length > 0) {
        preds.push((s) => cands.some((c) => c.id === s.id));
      } else if (dotted) {
        const [cls, m] = [dotted[1]!, dotted[2]!];
        preds.push((s) => s.name === m && s.container === cls);
        preds.push((s) => {
          if (s.name !== m) return false;
          const b = s.file.split("/").pop()!.toLowerCase().replace(/\.[a-z]+$/, "");
          return b.length >= 4 && cls.toLowerCase().includes(b);
        });
      } else {
        const q = query.toLowerCase();
        preds.push((s) => s.name.toLowerCase().includes(q));
      }
    }
    for (const pred of preds) {
      const sub = subgraph(g, pred, depth, root);
      if (sub.center) return sub;
    }
    return { upstream: [], downstream: [] };
  };
  let sub = resolve(graph);
  // ts-morph 高负载下偶发整图空解析(套件四见的同源抖动):「整图为空 + grep 证明符号文本在仓内」
  // 才值得重试(递增退避 ×2)。图非空的「未找到」不重试——审计 R1-C27:文档/注释里提及的符号
  // (存在于仓内但解析不出符号)会带 3 次无关重建+2.8s 退避,白等 15s 才降级
  const symbolGrepped = hits.length > 0 || explicitFiles.size > 0;
  if (!sub.center && graph.symbols.size === 0 && symbolGrepped) {
    for (const backoff of [800, 2000]) {
      await new Promise((res) => setTimeout(res, backoff));
      const retry = await getLazyGraph(cacheKey, true, buildGraph);
      graph = retry.graph;
      hit = retry.hit;
      builtAt = retry.builtAt;
      sub = resolve(graph);
      if (sub.center) break;
    }
  }
  if (!sub.center) {
    // 逐出本 key 缓存:缺中心的图不能毒化 60s 内的后续重试
    lazyGraphCache.delete(cacheKey);
    return { ...base, degraded: [{ layer: "callgraph", reason: `未找到符号: ${query}`, howToActivate: "确认符号名或用 explore 检索" }] };
  }
  const signatures: Record<string, Signature> = {};
  const originalId = findOriginalId(graph, sub.center) ?? sub.center.id;
  const sym = graph.symbols.get(originalId);
  if (sym?.signature) signatures[sub.center.name] = sym.signature;
  // IDE「查找所有引用」:圆心符号全仓 grep 出现点(imports/回调传递/JSX 等小图解析不到的用法都在)。
  // upstream 边只覆盖小图内可解析调用——引用清单补全「谁在用它」的完整画面(词法级,如实标 tier)
  let references: { file: string; line: number; text: string }[] | undefined;
  let referenceCount = 0;
  if (sub.center.name.length >= 3) {
    try {
      const refs = await grepIn(root, [sub.center.name], { max: 120 });
      // 排序=定义形态置顶 > 代码文件 > 文档提及,再截 80:grep max 是先到先得配额,
      // rg 到达序不定,定义文件(app.ts)会被挤出引用清单(ZC-11b 假红真因——此前误归
      // 「资源饥饿」;与 focus 侧 ZC-10「定义形态特异性置顶」同源教训)
      const isCode = (f: string) => /\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|rs)$/.test(f);
      const nameEsc = sub.center.name.replace(/\$/g, "\\$");
      const defRe = new RegExp(`(?:function|class|interface|type|const|def)\\s+${nameEsc}\\b`);
      const scored = refs.map((m) => ({ m, s: defRe.test(m.text) ? 3000 : isCode(m.file) ? 1000 : 0 }));
      const ordered = scored.sort((a, b) => b.s - a.s).slice(0, 80).map((x) => x.m);
      referenceCount = refs.length;
      references = ordered.map((m) => ({ file: m.file, line: m.line, text: m.text.trim().slice(0, 100) }));
    } catch { /* 引用检索失败不阻塞主链 */ }
  }
  // IDE「跳到类型定义」:签名里的具名类型(剥 import(...) 前缀与泛型后缀)定位定义处。
  // 原始类型/内建泛型跳过;上限 4 个类型(任务开工注入的时延预算)
  const typeDefs: Record<string, { file: string; line: number }> = {};
  const PRIMITIVES = new Set(["string", "number", "boolean", "any", "unknown", "void", "object", "null", "undefined", "never", "Promise", "Record", "Array", "Map", "Set", "Partial", "Readonly"]);
  for (const sig of Object.values(signatures)) {
    for (const p of sig.params ?? []) {
      if (Object.keys(typeDefs).length >= 4) break;
      const cleaned = (p.type ?? "").replace(/^import\([^)]*\)\./, "").trim();
      const ident = /^([A-Z][A-Za-z0-9]+)(?:<|\b)/.exec(cleaned)?.[1] ?? (/^[A-Z][A-Za-z0-9]+$/.test(cleaned) ? cleaned : undefined);
      if (!ident || PRIMITIVES.has(ident) || typeDefs[ident]) continue;
      try {
        const defHits = await grepIn(root, [`interface ${ident}`, `class ${ident}`, `type ${ident}`], { max: 9 });
        const first = defHits[0];
        if (first) typeDefs[ident] = { file: first.file, line: first.line };
      } catch { /* 类型定位失败:该类型不标位置 */ }
    }
  }
  // 时序(R5-C20):聚焦符号的静态执行序+异步边界;失败静默省略,不冒充、不阻塞主链。
  let sequence: import("./sequence/index").StaticSequence | undefined;
  try {
    const seq = await (await import("./sequence/index")).sequenceOfSymbol(root, [...focus], sub.center.name);
    if (seq) sequence = seq;
  } catch { /* 时序提取失败不阻塞 debug */ }
  const diagram = callchainMermaid({
    center: { name: sub.center.name, id: sub.center.id, file: sub.center.file, line: sub.center.line },
    upstream: sub.upstream,
    downstream: sub.downstream,
  });
  return {
    ...base,
    cache: { hit, builtAt },
    ...(sequence ? { sequence } : {}),
    ...(references ? { references, referenceCount } : {}),
    ...(Object.keys(typeDefs).length ? { typeDefs } : {}),
    callchain: {
      center: { name: sub.center.name, id: sub.center.id, file: sub.center.file, line: sub.center.line },
      upstream: sub.upstream,
      downstream: sub.downstream,
      mermaid: diagram.mermaid,
      mermaidNodes: diagram.nodes,
      ...(diagram.truncated ? { mermaidTruncated: true } : {}),
    },
    ...(Object.keys(signatures).length ? { signatures } : {}),
    evidence: [
      ...sub.downstream.map((e) => ({ path: e.file, line: e.line, kind: e.evidenceKind, tier: e.tier })),
      ...sub.upstream.map((e) => ({ path: e.file, line: e.line, kind: e.evidenceKind, tier: e.tier })),
    ].slice(0, 200),
  };
}

async function planProfile(root: string, scan: import("./project").ProjectScan, base: CodeSenseResult, opts?: CodeSenseOptions): Promise<CodeSenseResult> {
  const { deriveModules } = await import("./modulemap/index");
  const { gitHotspots } = await import("./archmap/index");
  const modules = deriveModules(scan.files);
  const hotspots = await gitHotspots(root);
  const out: CodeSenseResult = {
    ...base,
    modules,
    ...(hotspots.length ? { hotspots } : {}),
    evidence: modules.map((m) => ({ path: m.entryFile, kind: "ast" as const, tier: "semantic" as const })),
  };
  if (scan.state === "EMPTY") {
    const { skeletonPrompt, SkeletonSchema } = await import("./modulemap/index");
    return {
      ...out,
      degraded: [{ layer: "archmap", reason: "空项目(0 源文件)——骨架建议模式(需注入 archLlm)", howToActivate: "setPlanDeps({archLlm}) 后获得 LLM 骨架建议" }],
    };
  }
  if (planDeps.archLlm && !opts?.skipArchLlm) {
    const { generateArchitecture, graphToMermaid } = await import("./archmap/index");
    try {
      const { graph, narrative, repairs } = await generateArchitecture(root, scan.files, planDeps.archLlm);
      return {
        ...out,
        architecture: { mermaid: graphToMermaid(graph), nodes: graph.nodes, edges: graph.edges },
        evidence: [
          ...graph.edges.filter((e) => e.evidencePath).map((e) => ({ path: e.evidencePath!, kind: (e.evidence === "inferred" ? "inferred" : "index") as EvidenceKind, tier: "semantic" as Tier })),
          ...out.evidence,
        ],
        cache: { ...out.cache },
        ...(repairs > 0 ? { degraded: [...(out.degraded ?? []), { layer: "archmap", reason: `修复环触发 ${repairs} 次`, howToActivate: "产物可用,修复计数已记录" }] } : {}),
      };
    } catch (err) {
      return { ...out, degraded: [...(out.degraded ?? []), { layer: "archmap", reason: `LLM 生成失败: ${String(err).slice(0, 80)}`, howToActivate: "重试或检查 archLlm" }] };
    }
  }
  // 无 LLM:静态模块结构(显式降级,不冒充架构图)
  return {
    ...out,
    degraded: [...(out.degraded ?? []), { layer: "archmap(架构图)", reason: "未注入 archLlm——返回静态模块结构", howToActivate: "setPlanDeps({archLlm}) 启用 gitdiagram 管线" }],
  };
}

async function uiProfile(root: string, scan: import("./project").ProjectScan, base: CodeSenseResult): Promise<CodeSenseResult> {
  const { pageFlow } = await import("./pageflow/index");
  const pf = await pageFlow(root, scan.files);
  // senseB22:app 路由画像并入 ui mode(自写 switchView 族;失败/未检出不毙剖面,显式降级)
  let routes: import("./pageflow/approutes").AppRoutesResult | undefined;
  const degraded = [...(base.degraded ?? [])];
  try {
    const { queryAppRoutes } = await import("./pageflow/approutes");
    routes = await queryAppRoutes(root, scan.files);
    if (!routes.router) degraded.push({ layer: "approutes", reason: routes.degraded[0] ?? "未检出路由器函数", howToActivate: "确认仓内有自写 switchView/dataset.view 路由或框架路由配置" });
  } catch (err) {
    degraded.push({ layer: "approutes", reason: `路由画像提取失败: ${String(err instanceof Error ? err.message : err).slice(0, 80)}`, howToActivate: "重试或检查内嵌脚本文件可读性" });
  }
  const routeFiles = new Set((routes?.routes ?? []).map((r) => r.file));
  return {
    ...base,
    ...(routes ? { routes } : {}),
    ...(degraded.length ? { degraded } : {}),
    pageflow: pf,
    evidence: [
      // 页面本身也是主张(此前 0 边时 evidence 恒空——页面清单无出处);HTML 标签扫描=词法级
      ...pf.pages.map((p) => ({ path: p.file, kind: "grep" as const, tier: "structural" as const })),
      ...pf.edges.map((e) => ({ path: e.evidence.path, line: e.evidence.line, kind: (e.tier === "inferred" ? "inferred" : "ast") as EvidenceKind, tier: (e.tier === "inferred" ? "structural" : e.tier) as Tier })),
      // senseB22:路由器所在文件进证据面
      ...[...routeFiles].map((f) => ({ path: f, kind: "grep" as const, tier: "structural" as const })),
    ],
  };
}

/** api 剖面(step-077,designs/24 §5.1):HTTP 接口表面。
 * 语义层在注入 senseLlm 时自动启用(注入=调用方明确要语义);query 含路径片段(/api/x)时过滤到匹配端点。 */
async function apiProfile(root: string, query: string, base: CodeSenseResult): Promise<CodeSenseResult> {
  const { queryApiSurface, getSensingDeps } = await import("./sensing/index");
  const withSemantics = Boolean(getSensingDeps().senseLlm);
  const surface = await queryApiSurface(root, { withSemantics });
  // 路径片段定向:「/api/chat 是做什么的」→ 过滤到匹配端点(无匹配=回退全量+提示)
  const pathTok = /(\/[\w\-/{}/:]+)/.exec(query)?.[1];
  let filtered = surface.endpoints;
  let filterNote: string | undefined;
  if (pathTok && pathTok.length > 1) {
    const stem = pathTok.replace(/\{[^}]*\}/g, "").replace(/:[\w]+/g, "").replace(/\/+$/, "");
    const hit = surface.endpoints.filter((e) => e.path.includes(stem));
    if (hit.length > 0) filtered = hit;
    else filterNote = `路径片段 ${pathTok} 无匹配端点,返回全量清单`;
  }
  const degraded = [...(base.degraded ?? [])];
  if (surface.endpoints.length === 0) {
    degraded.push({
      layer: "sensing-api",
      reason: "未识别到受支持框架的路由形态(express/koa/fastify/nextjs/flask/fastapi/aiohttp/spring/gin/net-http/mux)",
      howToActivate: "裸 node createServer if-chain 路由不在支持面(无确定性形态);确认框架在支持清单内",
    });
  }
  if (surface.indexJoin.status === "degraded") {
    degraded.push({ layer: "sensing-api-impact", reason: surface.indexJoin.reason ?? "", howToActivate: "codesense index 构建静态索引后影响面可用" });
  }
  if (withSemantics && surface.semanticLayer.status === "failed") {
    degraded.push({ layer: "sensing-semantic", reason: surface.semanticLayer.reason ?? "", howToActivate: "重试或检查 senseLlm" });
  }
  if (!withSemantics) {
    degraded.push({ layer: "sensing-semantic", reason: "未注入 senseLlm——返回纯确定性接口清单", howToActivate: "setSensingDeps({senseLlm}) 启用接口语义描述" });
  }
  if (filterNote) degraded.push({ layer: "sensing-api-filter", reason: filterNote, howToActivate: "检查路径片段" });
  return {
    ...base,
    api: { ...surface, endpoints: filtered },
    ...(degraded.length ? { degraded } : {}),
    evidence: filtered.slice(0, 100).map((e) => ({ path: e.file, line: e.line, kind: "grep" as const, tier: "structural" as const })),
  };
}

/** state 剖面(step-077 P2,designs/24 §2.2):状态机表面(五形态;零检出=显式降级)。 */
async function stateProfile(root: string, base: CodeSenseResult): Promise<CodeSenseResult> {
  const { queryStateMachines } = await import("./sensing/index");
  const surface = await queryStateMachines(root);
  const degraded = [...(base.degraded ?? [])];
  if (surface.machines.length === 0) {
    degraded.push({
      layer: "sensing-state",
      reason: "未检出受支持的状态机形态(transitions-table/switch 转移/状态模式类族/XState/Redux slice)",
      howToActivate: "确认仓内有具名状态管理代码;DB status 字段流转按设计不做(见 designs/24 §2.2)",
    });
  }
  return {
    ...base,
    state: surface,
    ...(degraded.length ? { degraded } : {}),
    evidence: [
      ...surface.machines.flatMap((m) => m.transitions.slice(0, 40).map((t) => ({ path: t.evidence.file, line: t.evidence.line, kind: "grep" as const, tier: "structural" as const }))),
    ].slice(0, 100),
  };
}

/** algo 剖面(step-077 P3,designs/24 §2.3):算法画像。query 含文件路径片段时聚焦导读。 */
async function algoProfile(root: string, query: string, base: CodeSenseResult): Promise<CodeSenseResult> {
  const { queryAlgoProfiles, getSensingDeps } = await import("./sensing/index");
  const withSemantics = Boolean(getSensingDeps().senseLlm);
  const fileTok = /([\w/.-]+\.(?:py|ts|tsx|js))/.exec(query)?.[1];
  const surface = await queryAlgoProfiles(root, { withSemantics, ...(fileTok ? { file: fileTok } : {}) });
  const degraded = [...(base.degraded ?? [])];
  if (surface.profiles.length === 0) {
    degraded.push({
      layer: "sensing-algo",
      reason: "未检出算法框架信号(nn.Module/训练循环/推理入口/DataLoader/cv2/librosa 等)",
      howToActivate: "确认仓内有 CV/语音/深度学习代码;信号清单见 designs/24 §2.3",
    });
  }
  if (!withSemantics) {
    degraded.push({ layer: "sensing-semantic", reason: "未注入 senseLlm——返回纯确定性算法画像", howToActivate: "setSensingDeps({senseLlm}) 启用算法步骤导读" });
  }
  return {
    ...base,
    algo: surface,
    ...(degraded.length ? { degraded } : {}),
    evidence: surface.profiles.slice(0, 40).flatMap((p) => p.signals.slice(0, 3).map((s) => ({ path: p.file, line: s.line, kind: "grep" as const, tier: "structural" as const }))).slice(0, 100),
  };
}

function findOriginalId(graph: CallGraph, center: { name: string; file: string }): string | undefined {
  const tail = center.file.split("/").pop();
  return tail ? (graph.byName.get(center.name) ?? []).find((id) => id.includes(tail)) : undefined;
}

async function exploreProfile(root: string, query: string, base: CodeSenseResult): Promise<CodeSenseResult> {
  const { grepIn, normalizeQuery, extractIdentifiers } = await import("./search");
  // ① 符号优先召回(2026-10-21):中文问句先切词+中英词典映射,读静态索引打分出候选符号。
  // 这是「入口词」修复——symbol 一查就准,explore 此前只走 grep,中文问句没有 camelCase 字面量
  // 必然召回不到 makeSubagentPermissionAsker 这类符号。索引缺失=诚实降级(不建索引、不编造)。
  const recall = recallSymbols(root, query);
  // 2026-10-22 P0:第三方/内嵌源码候选不进 explore 默认面(旧行为只降 0.3 倍,
  // saadk_6920 的 OpenCV thirdparty 头仍占满候选)。docs/examples 保留(已有降权)。
  const symbols = recall.symbols.filter((s) => !isVendoredPath(s.file));
  const vendorFiltered = recall.symbols.length - symbols.length;
  // ② 原有 grep 通道保留(降权:输出在后、证据排序让位符号);变体管线不变
  const variants = normalizeQuery(query);
  let matches = await grepIn(root, variants, { max: 100 });
  let bootstrapped: string[] = [];
  // 低命中自举二轮(2026-10-18):首轮命中 <3 且命中行里有英文标识符时,提取标识符再聚合一轮
  // (「总路线」首轮仅 1 条文档命中;二轮从该行/既有命中提取 roadmap 类词根继续挖 UI 锚点)。
  // 只自举一次,配额不变;扩出的词记录在 degraded 说明里(诚实可溯)。
  if (matches.length < 3) {
    const ids = extractIdentifiers(matches.map((m) => m.text).join(" "), 6);
    const extra = ids.filter((w) => !variants.includes(w)).slice(0, 4);
    if (extra.length) {
      const more = await grepIn(root, extra, { max: 60 });
      const seen = new Set(matches.map((m) => m.file + ":" + m.line));
      for (const m of more) if (!seen.has(m.file + ":" + m.line)) matches.push(m);
      bootstrapped = extra;
    }
  }
  const degraded = [...(base.degraded ?? [])];
  if (recall.degraded) degraded.push({ layer: "symbol-recall", reason: recall.degraded, howToActivate: "codesense index <root> 构建静态索引(符号召回=毫秒级读索引,不触发构建)" });
  // grep 行排序(2026-10-21 符号优先):候选符号所在文件 > 生产源码 > 测试 > 文档/非产品路径
  // (docs/tasks/vendor/ref)。实锤:中文问句的前列曾是 AGENTS.md/tasks 文档(中文叙述天然含问句词),
  // 真实现文件被挤到后面——符号块虽已置顶,行命中仍按此序降噪(稳定排序,同档内保持 ripgrep 到达序)。
  const symbolFiles = new Set(symbols.map((s) => s.file));
  const rank = (f: string): number => {
    if (symbolFiles.has(f)) return 3000;
    if (isNonProductPath(f) || isDocLikePath(f)) return 0;
    return isTestPath(f) ? 1000 : 2000;
  };
  matches = matches
    .map((m, i) => ({ m, i }))
    .sort((a, b) => rank(b.m.file) - rank(a.m.file) || a.i - b.i)
    .map((x) => x.m);
  const notes: string[] = [];
  if (vendorFiltered > 0) notes.push(`已过滤 ${vendorFiltered} 个第三方路径候选(thirdparty/vendor/node_modules;外来代码不参与默认探索面)`);
  if (bootstrapped.length) notes.push(`explore 自举二轮(首轮低命中,已用命中行标识符扩展: ${bootstrapped.join(", ")})`);
  // 零命中是常见形态(自然语言整句 grep 不到字面量):符号也零命中才报零命中;
  // 符号命中而 grep 零命中=符号优先兜底成功,如实说明(不假装 grep 有结果)
  if (matches.length === 0 && symbols.length === 0) {
    return {
      ...base,
      matches,
      // 顺序=向后兼容:grep 零命中仍是 degraded[0](既有消费方/测试按首条判零命中);
      // 符号召回降级排在后面(新增通道不抢首条语义)。
      degraded: [
        { layer: "grep", reason: `零命中: ${query}`, howToActivate: "改用符号名/camelCase 关键词,或 debug 剖面查调用链" },
        ...degraded,
      ],
      note: `符号优先召回亦零命中(索引内 ${recall.indexSize} 符号);词表: ${recall.terms.terms.map((t) => t.term).slice(0, 8).join(", ") || "(无)"}`,
    };
  }
  if (matches.length === 0 && symbols.length > 0) {
    notes.push(`grep 零命中,已由符号候选兜底(索引内 ${recall.indexSize} 符号)`);
  }
  return {
    ...base,
    matches,
    ...(symbols.length ? { symbols } : {}),
    ...(degraded.length ? { degraded } : {}),
    ...(notes.length ? { note: notes.join(";") } : {}),
    evidence: [
      // 符号候选=索引证据(structural),排在 grep 行证据之前(符号优先)
      ...symbols.map((s) => ({ path: s.file, line: s.line, kind: "index" as const, tier: "structural" as const })),
      ...matches.map((m) => ({ path: m.file, line: m.line, kind: "grep" as const, tier: "lexical" as const })),
    ].slice(0, 200),
  };
}

/** 结果预算:超限裁剪(designs/16 §9 裁剪序)。
 * 裁剪序=matches→references→sequence(steps)→远跳(callchain)→evidence→sequence(整块丢弃)——
 * 预算是白名单式机制:结果里新增任何集合字段都必须同步登记进裁剪序,
 * 否则字段默认逃逸(审计 R1-C25:references/sequence 曾把最坏组合顶到 42.7KB)。 */
function applyBudget(r: CodeSenseResult): CodeSenseResult {
  let out = JSON.stringify(r);
  if (out.length <= RESULT_BUDGET_BYTES) return r;
  let omitted = 0;
  const budgeted: CodeSenseResult = { ...r };
  const fits = () => JSON.stringify(budgeted).length <= RESULT_BUDGET_BYTES;

  if (budgeted.matches && budgeted.matches.length > 30) {
    omitted += budgeted.matches.length - 30;
    budgeted.matches = budgeted.matches.slice(0, 30);
  }
  // explore 符号候选(2026-10-21):新集合字段必须登记进裁剪序(C25 纪律;此前 references/
  // sequence 逃逸把最坏组合顶到 42.7KB)。裁剪序=符号优先:先裁降权的 grep 行(30→20),
  // 再动符号候选(10→6)——符号是主召回通道,不能被行命中的体积挤掉。
  if (!fits() && budgeted.symbols && budgeted.symbols.length > 10) {
    omitted += budgeted.symbols.length - 10;
    budgeted.symbols = budgeted.symbols.slice(0, 10);
  }
  if (!fits() && budgeted.matches && budgeted.matches.length > 20) {
    omitted += budgeted.matches.length - 20;
    budgeted.matches = budgeted.matches.slice(0, 20);
  }
  // api 剖面(step-077):端点清单裁剪(C25 纪律——新集合字段必须登记进裁剪序)
  if (budgeted.api && budgeted.api.endpoints.length > 30) {
    omitted += budgeted.api.endpoints.length - 30;
    budgeted.api = { ...budgeted.api, endpoints: budgeted.api.endpoints.slice(0, 30) };
  }
  // senseB22:routes 画像裁剪(C25 纪律——新集合字段必须登记进裁剪序)
  if (budgeted.routes) {
    const rr = budgeted.routes;
    if (rr.routes.length > 40) {
      omitted += rr.routes.length - 40;
      budgeted.routes = { ...rr, routes: rr.routes.slice(0, 40) };
    }
    for (const route of budgeted.routes.routes) {
      if (route.opens.length > 12) {
        omitted += route.opens.length - 12;
        route.opens = route.opens.slice(0, 12);
      }
      if (route.entries.length > 10) {
        omitted += route.entries.length - 10;
        route.entries = route.entries.slice(0, 10);
      }
    }
  }
  // state 剖面(step-077):状态机转移/提示区裁剪
  if (budgeted.state) {
    const s = budgeted.state;
    const totalT = s.machines.reduce((n, m) => n + m.transitions.length, 0);
    if (s.machines.length > 8) {
      omitted += s.machines.length - 8;
      budgeted.state = { ...s, machines: s.machines.slice(0, 8) };
    } else if (totalT > 60) {
      omitted += totalT - 60;
      budgeted.state = {
        ...s,
        machines: s.machines.map((m) => ({ ...m, transitions: m.transitions.slice(0, 15) })),
      };
    }
    if (budgeted.state.statusHints.length > 10) {
      omitted += budgeted.state.statusHints.length - 10;
      budgeted.state = { ...budgeted.state, statusHints: budgeted.state.statusHints.slice(0, 10) };
    }
  }
  if (!fits() && budgeted.sequence && budgeted.sequence.steps.length > 12) {
    omitted += budgeted.sequence.steps.length - 12;
    budgeted.sequence = { ...budgeted.sequence, steps: budgeted.sequence.steps.slice(0, 12), mermaid: "" };
    // mermaid(面板渲染用,可达 5KB+)随裁剪置空——steps 列表才是 LLM/数据消费面
  }
  if (!fits() && budgeted.references && budgeted.references.length > 30) {
    omitted += budgeted.references.length - 30;
    budgeted.references = budgeted.references.slice(0, 30);
    // referenceCount 保留原值(如实:命中了 N 处,列表被裁)
  }
  if (!fits() && budgeted.evidence && budgeted.evidence.length > 30) {
    omitted += budgeted.evidence.length - 30;
    budgeted.evidence = budgeted.evidence.slice(0, 30);
  }
  // 符号候选最后一道裁(10→6):只有在行命中/证据/调用链都裁过之后仍超预算才动
  if (!fits() && budgeted.symbols && budgeted.symbols.length > 6) {
    omitted += budgeted.symbols.length - 6;
    budgeted.symbols = budgeted.symbols.slice(0, 6);
  }
  if (!fits() && budgeted.callchain) {
    // 砍最远跳:保留每侧前 40 条边
    omitted += Math.max(0, budgeted.callchain.upstream.length - 40) + Math.max(0, budgeted.callchain.downstream.length - 40);
    budgeted.callchain = {
      ...budgeted.callchain,
      upstream: budgeted.callchain.upstream.slice(0, 40),
      downstream: budgeted.callchain.downstream.slice(0, 40),
    };
  }
  // 极端兜底(顺序=先砍引用清单再砍 callchain 主链,最后才丢时序——
  // 时序 steps 已在上面裁到 12,直接丢会丢 debug 剖面核心亮点):
  if (!fits() && budgeted.references && budgeted.references.length > 10) {
    omitted += budgeted.references.length - 10;
    budgeted.references = budgeted.references.slice(0, 10);
  }
  if (!fits() && budgeted.callchain) {
    omitted += Math.max(0, budgeted.callchain.upstream.length - 16) + Math.max(0, budgeted.callchain.downstream.length - 16);
    budgeted.callchain = {
      ...budgeted.callchain,
      upstream: budgeted.callchain.upstream.slice(0, 16),
      downstream: budgeted.callchain.downstream.slice(0, 16),
    };
  }
  if (!fits() && budgeted.references && budgeted.references.length > 0) {
    omitted += budgeted.references.length;
    budgeted.references = [];
  }
  // 最终手段:sequence 整块丢弃(时序是增强信息;mermaid 字符串随块走)
  if (!fits() && budgeted.sequence) {
    omitted += budgeted.sequence.steps.length + 1;
    delete budgeted.sequence;
  }
  // 最终手段 2:api 端点整块裁到 10(语义/影响面随行去)
  if (!fits() && budgeted.api && budgeted.api.endpoints.length > 10) {
    omitted += budgeted.api.endpoints.length - 10;
    budgeted.api = { ...budgeted.api, endpoints: budgeted.api.endpoints.slice(0, 10) };
  }
  // 最终手段 3:algo 画像裁到 8(信号行裁剪)
  if (!fits() && budgeted.algo && budgeted.algo.profiles.length > 8) {
    omitted += budgeted.algo.profiles.length - 8;
    budgeted.algo = { ...budgeted.algo, profiles: budgeted.algo.profiles.slice(0, 8) };
  }
  budgeted.budget = { truncated: true, omittedCount: omitted };
  return budgeted;
}

/** 文件级下钻(step-048 追记八:项目档案钻到「每个文件的每个函数」+调用关系图):
 * 快路径=静态 c2f 索引直读(毫秒,2026-10-12 三改:提前生成,不点哪个算哪个);
 * 索引未就绪回退懒解析(与 debugProfile 同口径)。
 * 六期修复(step-057):旧版慢路径会在主进程内跑 buildC2fIndex(ts-morph 全仓,分钟级阻塞事件循环)——
 * 现在重建只经 onStale 回调交给调用方(gateway 走 sense-index-manager 的 fork),本函数绝不起进程内重建;
 * allowStale=用过期索引降级应答(调用方明知索引略旧也要快),配合 onStale 通知后台刷新。 */
export async function fileSymbolsOf(root: string, relFile: string, opts?: {
  allowStale?: boolean;
  onStale?: (root: string) => void;
}): Promise<{
  symbols: { name: string; kind: string; line: number; container: string | null; parent: string | null; id: string }[];
  edges: { from: string; fromName: string; to: string; toName: string; line: number; crossFile: boolean }[];
  /** 索引略旧(allowStale 降级)时=true,面板可标注。 */
  degradedStale?: boolean;
}> {
  const c2f = await import("./callgraph/c2f");
  const index = c2f.loadIndex(root);
  if (index) {
    const stale = c2f.indexStale(root, index);
    if (!stale || opts?.allowStale) {
      if (stale) opts?.onStale?.(root); // 降级应答的同时通知调用方后台 fork 重建
      // review 抓:①绝对路径入参先归一(byFile 按相对路径键,裸查=静默空);②快路 name 是
      // Container.method 全名,慢路是裸名+container 字段——拆开对齐,防消费端双前缀
      const rel = isAbsolute(relFile) && relFile.startsWith(root + "/") ? relFile.slice(root.length + 1) : relFile;
      const inFileIds = new Set(index.byFile[rel] ?? []);
    const symbols = inFileIds.size > 0
      ? [...inFileIds]
          .map((id) => index.nodes.find((n) => n.id === id))
          .filter((n): n is NonNullable<typeof n> => !!n)
          // senseB23:内嵌脚本符号按 inline-js 如实展示(此前 container 符号一律冒充 method)。
          // 2026-10-21:类型声明/箭头/类按 symKind 如实展示(此前 interface/type/enum 冒充
          // function、嵌套箭头无显示位);parent 随行(嵌套符号的所在函数/类)。
          .map((n) => ({ name: n.name.includes(".") ? n.name.slice(n.name.lastIndexOf(".") + 1) : n.name, kind: n.symKind ?? (n.container ? "method" : "function"), line: n.line, container: n.container ?? null, parent: n.parent ?? null, id: n.id }))
          .sort((a, b) => a.line - b.line)
      : [];
    const edges = index.edges
      .filter((e) => inFileIds.has(e.from))
      .map((e) => ({ from: e.from, fromName: e.from.split("#").pop() ?? e.from, to: e.to, toName: e.toName || (e.to.split("#").pop() ?? ""), line: e.line, crossFile: !inFileIds.has(e.to) }));
    return stale ? { symbols, edges, degradedStale: true } : { symbols, edges };
    }
  }
  // 慢路径兜底(索引缺失):懒解析本文件+邻域(轻);**不再进程内重建**——六期修复,主进程 ts-morph
  // 全仓构建=事件循环分钟级卡死(实测把 gateway 打成无响应);重建交给调用方 onStale/启动预热 fork。
  const scan = await scanProject(root);
  // engine 的 symbol.file 是绝对路径(实测);比对前归一(相对入参 → 绝对)
  const absTarget = isAbsolute(relFile) ? relFile : `${root.replace(/\/$/, "")}/${relFile}`;
  const dir = relFile.split("/").slice(0, -1).join("/");
  const neighbors = scan.files.filter((f) => f !== relFile && f.split("/").slice(0, -1).join("/") === dir);
  const graph = await buildCallGraphFromFiles(
    root,
    [...new Set([relFile, ...neighbors])],
  );
  const inFile = new Set<string>();
  const symbols: { name: string; kind: string; line: number; container: string | null; parent: string | null; id: string }[] = [];
  for (const s of graph.symbols.values()) {
    if (s.file !== absTarget) continue;
    inFile.add(s.id);
    if (s.kind === "class") continue; // 类容器不占函数行;其方法单独列出(container 字段标注归属)
    symbols.push({ name: s.name, kind: s.kind, line: s.line, container: s.container ?? null, parent: s.parent ?? null, id: s.id });
  }
  symbols.sort((a, b) => a.line - b.line);
  const edges: { from: string; fromName: string; to: string; toName: string; line: number; crossFile: boolean }[] = [];
  for (const s of graph.symbols.values()) {
    if (!inFile.has(s.id)) continue;
    for (const e of graph.outEdges.get(s.id) ?? []) {
      edges.push({ from: s.id, fromName: s.name, to: e.to, toName: e.toName ?? e.to, line: e.line, crossFile: !inFile.has(e.to) });
    }
  }
  return { symbols, edges };
}
