/**
 * board-sense(step-073,tasks/step-073-whiteboard-semantic/step.md D1):
 * code-sense 分析产物 → 可编辑语义白板(BoardDoc 的 nodes/edges 形态)的四个确定性纯函数转换器。
 *
 * 「模块语义级」相对 c2f fileToModules 模块板的增量:
 * - fileToModules=单文件内符号(函数级);本文件 moduleMapBoard=全仓模块(目录级),
 *   边=跨模块真实调用聚合(c2f 全量边按模块前缀归组 ×N)——分层+组件依赖语义进节点边。
 * - archGraphBoard:LLM 架构图(带 evidence 分级,inferred→「推断·」标签,不冒充实证)。
 * - sequenceBoard:符号静态语句序→链式时序板(序号+异步边界入边标签;静态序≠运行序如实标注)。
 * - pageFlowBoard:页面流→io 节点+导航边(trigger 入标签)。
 *
 * 纪律:转换器零 IO 零随机(幂等);边完整性=只引用已产出节点 id;全部产出过 BoardDocZ 才落盘(调用方职责)。
 */
import type { BoardDoc, BoardFlowStep } from "@lampgenie/protocol";
import type { C2fIndex } from "@lampgenie/code-sense/callgraph/c2f";
import type { DecisionKind, DecisionPoint } from "@lampgenie/code-sense/sensing/decision";
import type { Graph as ArchGraph } from "@lampgenie/code-sense/archmap/index";
import type { StaticSequence } from "@lampgenie/code-sense/sequence/index";
import type { PageFlowResult } from "@lampgenie/code-sense/pageflow/index";
import { deriveModules } from "@lampgenie/code-sense/modulemap/index";

type BoardNode = BoardDoc["nodes"][number];
type BoardEdge = BoardDoc["edges"][number];

/** 板节点 id 消毒(与画布/存储同律:非 [A-Za-z0-9_] 折叠,长度截断,撞名加序号)。 */
function makeIdAlloc() {
  const used = new Set<string>();
  return (raw: string): string => {
    const base = raw.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "n";
    let out = base;
    let k = 1;
    while (used.has(out)) out = (base + "_" + k++).slice(0, 44);
    used.add(out);
    return out;
  };
}

/** 文件 → 模块键(与 modulemap deriveModules 同口径:packages/<x>/apps/<x>,其余 (root))。 */
function moduleOfFile(file: string): string {
  const m = /^(packages|apps)\/([^/]+)\//.exec(file);
  return m ? `${m[1]}/${m[2]}` : "(root)";
}

/** modulemap→模块语义板:节点=全仓模块(职责句+入口文件+文件/符号计数),边=跨模块真实调用聚合 ×N。
 * 零编造:边全部来自 c2f 索引真实调用记录;模块内调用不出边(自环无信息量)。 */
export function moduleMapBoard(index: C2fIndex): { title: string; nodes: BoardNode[]; edges: BoardEdge[]; planned_files: string[] } {
  const files = Object.keys(index.byFile);
  const guides = deriveModules(files);
  const idAlloc = makeIdAlloc();
  const nodeId = new Map<string, string>();
  // 每模块文件/符号计数(内容语义:模块规模)
  const symCount = new Map<string, number>();
  for (const [f, ids] of Object.entries(index.byFile)) {
    const mk = moduleOfFile(f);
    symCount.set(mk, (symCount.get(mk) ?? 0) + ids.length);
  }
  const fileCount = new Map<string, number>();
  for (const f of files) {
    const mk = moduleOfFile(f);
    fileCount.set(mk, (fileCount.get(mk) ?? 0) + 1);
  }
  // 跨模块调用聚合
  const agg = new Map<string, number>(); // "A>B" → count
  for (const e of index.edges) {
    const fromM = moduleOfFile(e.file);
    const toFile = e.to.split("#")[0] ?? "";
    if (!toFile) continue;
    const toM = moduleOfFile(toFile);
    if (fromM === toM) continue;
    agg.set(fromM + ">" + toM, (agg.get(fromM + ">" + toM) ?? 0) + 1);
  }
  const nodes: BoardNode[] = guides.slice(0, 56).map((g) => {
    const id = idAlloc(g.name);
    nodeId.set(g.name, id);
    const fc = fileCount.get(g.name) ?? 0;
    const sc = symCount.get(g.name) ?? 0;
    return {
      id, kind: "module" as const, label: g.name,
      summary: `${g.responsibility}(文件 ${fc} · 符号 ${sc})`.slice(0, 500),
      change: "keep" as const, done: false, comments: [],
      fileRef: g.entryFile,
      flow: [],
    };
  });
  // 边:按聚合计数降序,截 120(协议上限);权重太低的噪声尾裁掉
  const edges: BoardEdge[] = [...agg.entries()]
    .filter(([k]) => {
      const [a = "", b = ""] = k.split(">");
      return nodeId.has(a) && nodeId.has(b);
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, 120)
    .map(([k, n]) => {
      const [a = "", b = ""] = k.split(">");
      return { from: nodeId.get(a)!, to: nodeId.get(b)!, kind: "call" as const, label: "调用×" + n };
    });
  return {
    title: `模块依赖语义板(${guides.length} 模块 · ${edges.length} 条跨模块调用)`,
    nodes, edges,
    planned_files: guides.slice(0, 56).map((g) => g.entryFile).slice(0, 60),
  };
}

/** archmap(LLM 架构图)→板:evidence 三级如实进边标签(inferred=推断,虚线感由标签承担);
 * 节点 fileRef=evidencePath(可点回代码档案)。narrative 摘要进标题。 */
export function archGraphBoard(g: ArchGraph, narrative: string): { title: string; nodes: BoardNode[]; edges: BoardEdge[] } {
  const idAlloc = makeIdAlloc();
  const nodeId = new Map<string, string>();
  const nodes: BoardNode[] = g.nodes.slice(0, 56).map((n) => {
    const id = idAlloc(n.id);
    nodeId.set(n.id, id);
    return {
      id, kind: "module" as const, label: n.label.slice(0, 160),
      summary: (n.evidencePath ? `证据:${n.evidencePath}` : "架构组件(LLM 归纳,无直接文件证据)").slice(0, 500),
      change: "keep" as const, done: false, comments: [],
      ...(n.evidencePath ? { fileRef: n.evidencePath } : {}),
      flow: [],
    };
  });
  const evTag: Record<string, string> = { excerpt: "", index: "", readme: "README·", inferred: "推断·" };
  const edges: BoardEdge[] = g.edges
    .filter((e) => nodeId.has(e.from) && nodeId.has(e.to))
    .slice(0, 120)
    .map((e) => ({
      from: nodeId.get(e.from)!, to: nodeId.get(e.to)!,
      kind: e.evidence === "inferred" ? ("data" as const) : ("call" as const),
      label: ((evTag[e.evidence] ?? "") + (e.label || "依赖")).slice(0, 120),
    }));
  const brief = narrative.trim().split("\n")[0]?.slice(0, 60) ?? "";
  return { title: `架构语义板${brief ? ":" + brief : ""}(${nodes.length} 组件 · ${edges.length} 依赖)`, nodes, edges };
}

/** sequence(符号静态时序)→板:caller 中心节点 + 去重 callee 节点;边标调用序 ①②③ 与异步边界。
 * 静态序≠运行序——标题如实标注。 */
export function sequenceBoard(symbol: string, file: string, seq: StaticSequence): { title: string; nodes: BoardNode[]; edges: BoardEdge[] } {
  const idAlloc = makeIdAlloc();
  const callerId = idAlloc(symbol);
  const nodes: BoardNode[] = [{
    id: callerId, kind: "function" as const, label: symbol.slice(0, 160),
    summary: `时序中心 @ ${file}(共 ${seq.steps.length} 步调用,异步边界 ${seq.asyncBoundaries} 处)`.slice(0, 500),
    change: "keep" as const, done: false, comments: [],
    symbolRef: { name: symbol, file },
    flow: seq.steps.slice(0, 40).map((s) => ({
      type: "step" as const,
      text: `${s.order + 1}. ${s.callee}${s.asyncBoundary !== "sync" ? ` [${s.asyncBoundary}]` : ""}`.slice(0, 300),
    })),
  }];
  const calleeId = new Map<string, string>();
  for (const s of seq.steps) {
    if (calleeId.has(s.callee)) continue;
    const id = idAlloc(s.callee);
    calleeId.set(s.callee, id);
    nodes.push({
      id, kind: "function" as const, label: s.callee.slice(0, 160),
      summary: `被 ${symbol} 调用(第 ${seq.steps.filter((x) => x.callee === s.callee).map((x) => x.order + 1).join("/")} 步)`.slice(0, 500),
      change: "keep" as const, done: false, comments: [], flow: [],
    });
    if (nodes.length >= 56) break;
  }
  const edges: BoardEdge[] = [];
  for (const [callee, id] of calleeId) {
    const steps = seq.steps.filter((s) => s.callee === callee);
    const orders = steps.map((s) => s.order + 1).join(",");
    const asyncs = [...new Set(steps.map((s) => s.asyncBoundary).filter((b) => b !== "sync"))];
    edges.push({
      from: callerId, to: id, kind: "call" as const,
      label: (`第${orders}步` + (asyncs.length ? " " + asyncs.join("/") : "")).slice(0, 120),
    });
    if (edges.length >= 120) break;
  }
  return { title: `静态时序板:${symbol}(语句序≠运行序)`, nodes, edges };
}

/** pageflow→板:页面=io 节点(route+文件+组件),边=导航/弹窗/提交(trigger 入标签)。 */
export function pageFlowBoard(pf: PageFlowResult): { title: string; nodes: BoardNode[]; edges: BoardEdge[] } {
  const idAlloc = makeIdAlloc();
  const nodeId = new Map<string, string>();
  const nodes: BoardNode[] = pf.pages.slice(0, 56).map((p) => {
    const id = idAlloc(p.id || p.route);
    nodeId.set(p.id, id);
    return {
      id, kind: "io" as const, label: p.route.slice(0, 160),
      summary: (`页面 ${p.file}` + (p.components.length ? ` · 组件:${p.components.slice(0, 4).join(",")}` : "")).slice(0, 500),
      change: "keep" as const, done: false, comments: [],
      fileRef: p.file,
      flow: [],
    };
  });
  const kindMap: Record<string, BoardEdge["kind"]> = { navigates: "call", "opens-modal": "data", submits: "verify", external: "data" };
  const edges: BoardEdge[] = pf.edges
    .filter((e) => nodeId.has(e.from) && nodeId.has(e.to))
    .slice(0, 120)
    .map((e) => ({
      from: nodeId.get(e.from)!, to: nodeId.get(e.to)!,
      kind: kindMap[e.kind] ?? ("call" as const),
      label: `${e.trigger}${e.tier === "inferred" ? "(推断)" : ""}`.slice(0, 120),
    }));
  return { title: `页面流板(${nodes.length} 页面 · ${edges.length} 跳转)`, nodes, edges };
}

// ---- step-121 工作流板(docKind=workflow):结构化 spec→可执行编排板的确定性转换器 ----

/** 工作流板结构描述(程序化造板/agent 造板入口):
 * steps=节点(id / kind 为 wf-x 前缀类型 / label / config 按 kind);edges=执行顺序或分支(label 真/假)。 */
export interface WorkflowSpec {
  title?: string;
  steps: {
    id: string;
    kind: "wf-script" | "wf-test" | "wf-agent" | "wf-condition" | "wf-parallel" | "wf-notify";
    label: string;
    summary?: string;
    config?: { command?: string; timeoutMs?: number; actor?: string; instructions?: string; cond?: string; message?: string };
  }[];
  edges?: { from: string; to: string; label?: string }[];
}

/** 工作流 spec→工作流板(docKind=workflow)节点边。零编造:引用不存在节点的边丢弃;
 * 编译级校验(环/扇入/配置完备)不在转换器——转换器只保证形状合法,语义留给 compileWorkflowBoard fail-visible。 */
export function workflowBoard(spec: WorkflowSpec): { title: string; nodes: BoardNode[]; edges: BoardEdge[] } {
  const idAlloc = makeIdAlloc();
  const nodeId = new Map<string, string>();
  const nodes: BoardNode[] = spec.steps.slice(0, 56).map((s) => {
    const id = idAlloc(s.id || s.label);
    nodeId.set(s.id, id);
    return {
      id, kind: s.kind, label: s.label.slice(0, 160),
      summary: (s.summary ?? `${s.kind} 步骤`).slice(0, 500),
      change: "add" as const, done: false, comments: [],
      ...(s.config && Object.keys(s.config).length ? { wf: s.config } : {}),
      flow: [],
    };
  });
  const edges: BoardEdge[] = [];
  for (const e of (spec.edges ?? []).slice(0, 120)) {
    const from = nodeId.get(e.from), to = nodeId.get(e.to);
    if (!from || !to) continue; // 引用不存在的步骤=spec 不完整,丢弃不编造
    edges.push({ from, to, kind: "call" as const, ...(e.label ? { label: e.label.slice(0, 120) } : {}) });
  }
  return { title: (spec.title ?? `工作流板(${nodes.length} 步骤)`).slice(0, 200), nodes, edges };
}

// ---- step-083 页面结构板(plan 白板化):规划产物→docKind=page 板的确定性转换器 ----
// fixG(2026-10-18)两阶段复核:sections/components 本就可选——骨架版(pages+navs,无 sections)经本转换器
// 自然成立(page 节点+nav 边零丢弃,summary 如实记「区块 0 · 组件 0」),丰满版(带 sections/components)
// 同样全量成立;板全量覆盖+rev 自增,rev1 骨架→rev2 丰满无需任何兼容改动(零行为改动,验证见报告)。

/** 页面结构描述(规划文本的结构化形态):pages=页面清单(section=区块名清单/component=组件名清单),
 * navs=页面间导航(from/to 用页面名,trigger=入口动作如「点击签署」)。 */
export interface PageStructureSpec {
  pages: { name: string; route?: string; summary?: string; sections?: string[]; components?: string[] }[];
  navs?: { from: string; to: string; trigger?: string }[];
}

/** 规划的页面结构→页面结构板节点边(线框形态,配合 docKind:"page" 使用)。
 * 页面=page 节点(summary 含 route),区块/组件=section/component 节点+contains 边(区块最多每页 8);
 * 导航=nav 边(trigger 入标签)。零编造:navs 引用不存在的页面名即丢弃(边完整性同四转换器纪律)。 */
export function pageStructureBoard(spec: PageStructureSpec): { title: string; nodes: BoardNode[]; edges: BoardEdge[] } {
  const idAlloc = makeIdAlloc();
  const pageId = new Map<string, string>();
  const nodes: BoardNode[] = [];
  const edges: BoardEdge[] = [];
  for (const p of spec.pages.slice(0, 16)) {
    const id = idAlloc("page_" + p.name);
    pageId.set(p.name, id);
    const route = p.route ? ` · 路由 ${p.route}` : "";
    nodes.push({
      id, kind: "page" as const, label: p.name.slice(0, 160),
      summary: (`${p.summary ?? "页面"}${route} · 区块 ${Math.min(p.sections?.length ?? 0, 8)} · 组件 ${Math.min(p.components?.length ?? 0, 8)}`).slice(0, 500),
      change: "add" as const, done: false, comments: [], flow: [],
    });
  }
  for (const p of spec.pages.slice(0, 16)) {
    const pid = pageId.get(p.name)!;
    for (const s of (p.sections ?? []).slice(0, 8)) {
      if (nodes.length >= 60) break; // 协议上限 60 节点(board-store 同拍)
      const id = idAlloc(`sec_${p.name}_${s}`);
      nodes.push({
        id, kind: "section" as const, label: s.slice(0, 160),
        summary: `「${p.name}」页面的区块`.slice(0, 500),
        change: "add" as const, done: false, comments: [], flow: [],
      });
      edges.push({ from: pid, to: id, kind: "contains" as const });
    }
    for (const c of (p.components ?? []).slice(0, 8)) {
      if (nodes.length >= 60) break;
      const id = idAlloc(`cmp_${p.name}_${c}`);
      nodes.push({
        id, kind: "component" as const, label: c.slice(0, 160),
        summary: `「${p.name}」页面使用的组件`.slice(0, 500),
        change: "add" as const, done: false, comments: [], flow: [],
      });
      edges.push({ from: pid, to: id, kind: "contains" as const });
    }
  }
  for (const n of (spec.navs ?? []).slice(0, 40)) {
    const from = pageId.get(n.from);
    const to = pageId.get(n.to);
    if (!from || !to) continue; // 导航目标页不存在=规划不完整,丢弃不编造
    edges.push({ from, to, kind: "nav" as const, label: (n.trigger ?? "导航").slice(0, 120) });
  }
  return {
    title: `页面结构板(${pageId.size} 页面 · ${nodes.length} 节点 · ${edges.filter((e) => e.kind === "nav").length} 导航)`,
    nodes, edges,
  };
}

// ---- 控制流板(docKind=design,decisions):code_sense branches 产物 → 板上第一批真条件/循环 ----
// 为什么要在本层重建树:decision.ts 的 DecisionPoint 是**扁平**点列——if 与 else 是两个并列点,
// 分支体只靠 lineStart/lineEnd + depth 隐式表达(没有 then/else 字段)。所以画 if/else 必须
// 按 depth + 行序自己重建归属;纪律同其余转换器:零 IO、不编造(else 找不到宿主就退化成同级语句)。

/** 板上 flow 总节点上限(=BoardNodeZ.flow 顶层 max 40);嵌套单数组上限 20(BoardFlowStepZ 递归 max 20)。 */
const MAX_FLOW_NODES = 40;
const MAX_FLOW_CHILDREN = 20;
/** 每个决策点直接归属调用展示上限(原文最多 8,板上取 3 免刷屏)。 */
const MAX_CALLS_PER_STEP = 3;

const LOOP_KINDS = new Set<DecisionKind>(["while", "do-while", "for", "for-of", "for-in"]);

function condOf(p: DecisionPoint): string {
  return (p.condition ?? "(条件未知)").slice(0, 200);
}

/** 循环语义:for-of/for-in 取被迭代对象,while 退化为条件文本(如实标注「当 …」)。 */
function overOf(p: DecisionPoint): string {
  const raw = p.loopIterates || p.loopTarget || (p.condition ? `当 ${p.condition}` : "每一项");
  return raw.replace(/\s+/g, " ").slice(0, 120);
}

/** 一个点的直接归属调用 → 一条 step(最多 3 个,名字单调简单可读)。 */
function callStepOf(p: DecisionPoint): BoardFlowStep | null {
  const calls = p.calls.slice(0, MAX_CALLS_PER_STEP);
  return calls.length ? { type: "step", text: ("调用 " + calls.join(", ")).slice(0, 300) } : null;
}

/** flow 树规模:节点总数 + 单个容器数组的最大子数(超协议上限时触发裁剪)。 */
function flowStat(steps: BoardFlowStep[]): { count: number; maxArr: number } {
  let count = 0;
  let maxArr = steps.length;
  for (const s of steps) {
    count++;
    for (const kid of [s.then, s.else, s.body]) {
      if (!kid || !kid.length) continue;
      const st = flowStat(kid);
      count += st.count;
      maxArr = Math.max(maxArr, st.maxArr);
    }
  }
  return { count, maxArr };
}

/** 超限裁剪:按层(BFS)保留——浅层主干优先,深层分支成批舍弃;每个容器再守 20 条。
 * 返回重建后的树 + 被舍弃的节点数(调用方补一条截断提示,不静默)。 */
function pruneFlow(roots: BoardFlowStep[], budget: number): { roots: BoardFlowStep[]; dropped: number } {
  const total = flowStat(roots).count;
  const keep = new Set<BoardFlowStep>();
  let kept = 0;
  let level: BoardFlowStep[][] = [roots];
  while (level.length > 0 && kept < budget) {
    const next: BoardFlowStep[][] = [];
    for (const arr of level) {
      for (const s of arr) {
        if (kept >= budget) break;
        keep.add(s);
        kept++;
        for (const kid of [s.then, s.else, s.body]) if (kid && kid.length) next.push(kid);
      }
    }
    level = next;
  }
  const rebuild = (arr: BoardFlowStep[], cap: number): BoardFlowStep[] => {
    const out: BoardFlowStep[] = [];
    for (const s of arr) {
      if (out.length >= cap || !keep.has(s)) continue; // 未入选=被截断
      const n: BoardFlowStep = {
        type: s.type,
        ...(s.text ? { text: s.text } : {}),
        ...(s.cond ? { cond: s.cond } : {}),
        ...(s.over ? { over: s.over } : {}),
      };
      if (s.then) n.then = rebuild(s.then, MAX_FLOW_CHILDREN);
      if (s.else) n.else = rebuild(s.else, MAX_FLOW_CHILDREN);
      if (s.body) n.body = rebuild(s.body, MAX_FLOW_CHILDREN);
      out.push(n);
    }
    return out;
  };
  const out = rebuild(roots, budget);
  // 以重建后真实规模算丢弃数(容器 20 条上限也会真丢节点,不能只按 BFS 入选数报)
  return { roots: out, dropped: total - flowStat(out).count };
}

/** 扁平决策点 → 树(按 lineStart 升序 + depth 栈重建归属):
 * if→branch(then);else→回填上一个 if/elif 分支的 else;elif→上一个分支的 else 里再嵌 branch;
 * while/for/for-of/for-in→loop(body);switch→branch(then 内平铺 case 标签);ternary→降级 step(不值得画分支)。 */
function buildFlowTree(points: DecisionPoint[]): BoardFlowStep[] {
  const roots: BoardFlowStep[] = [];
  const stack: { depth: number; body: BoardFlowStep[] }[] = [];
  // depth → 该层最近一个 if/elif/switch 分支(else/elif 的归属目标;分支链被兄弟语句打断即失效)
  const chain = new Map<number, BoardFlowStep>();
  for (const p of points) {
    if (stack.length > p.depth) stack.length = Math.max(0, p.depth);
    for (const k of [...chain.keys()]) if (k > p.depth) chain.delete(k);
    const body = stack.length > 0 ? stack[stack.length - 1]!.body : roots;
    const calls = callStepOf(p);
    if (p.kind === "if" || p.kind === "elif") {
      const br: BoardFlowStep = { type: "branch", cond: condOf(p), then: [], else: [] };
      const prev = p.kind === "elif" ? chain.get(p.depth) : undefined;
      // elif=上一个分支的 else 里再嵌一个 branch(if/else-if/else 三连的嵌套形态)
      if (prev && prev.type === "branch") (prev.else ??= []).push(br);
      else body.push(br);
      if (calls) br.then!.push(calls);
      stack.push({ depth: p.depth, body: br.then! });
      chain.set(p.depth, br);
      continue;
    }
    if (p.kind === "else") {
      const prev = chain.get(p.depth);
      const sink = prev && prev.type === "branch" ? (prev.else ??= []) : body; // 无宿主=退化为同级语句,不编造分支
      if (calls) sink.push(calls);
      stack.push({ depth: p.depth, body: sink });
      chain.delete(p.depth); // 分支链到此收尾
      continue;
    }
    if (LOOP_KINDS.has(p.kind)) {
      const lp: BoardFlowStep = { type: "loop", over: overOf(p), body: [] };
      body.push(lp);
      if (calls) lp.body!.push(calls);
      stack.push({ depth: p.depth, body: lp.body! });
      chain.delete(p.depth);
      continue;
    }
    if (p.kind === "switch") {
      const br: BoardFlowStep = { type: "branch", cond: `switch(${condOf(p)})`.slice(0, 200), then: [], else: [] };
      body.push(br);
      if (calls) br.then!.push(calls);
      stack.push({ depth: p.depth, body: br.then! });
      chain.set(p.depth, br);
      continue;
    }
    if (p.kind === "case" || p.kind === "default") {
      // case/default 归属最近 switch:标签成一条 step,其内容平铺在同一 then 里(case 不单独成分支)
      const label = p.kind === "default" ? "default:" : `case ${condOf(p)}:`;
      body.push({ type: "step", text: label.slice(0, 300) });
      if (calls) body.push(calls);
      stack.push({ depth: p.depth, body }); // 子决策与 case 内容同层平铺,不虚构缩进层级
      chain.delete(p.depth);
      continue;
    }
    // ternary:条件表达式画成分支没有可读价值,降级一条语句(如实保留条件原文)
    body.push({ type: "step", text: `?: 条件 ${condOf(p)}`.slice(0, 300) });
    chain.delete(p.depth);
  }
  return roots;
}

/** 决策点 → 板 flow(递归树,branch/loop/step)。整棵树 ≤40 节点(浅层优先),超限尾部补截断提示。 */
export function decisionsToFlow(points: DecisionPoint[], fnName?: string): BoardFlowStep[] {
  const scoped = fnName ? points.filter((p) => (p.fn ?? "") === fnName) : points;
  const src = scoped
    .slice()
    .sort((a, b) => a.lineStart - b.lineStart || a.lineEnd - b.lineEnd || a.depth - b.depth);
  const tree = buildFlowTree(src);
  if (tree.length === 0) return [];
  const st = flowStat(tree);
  if (st.count <= MAX_FLOW_NODES && st.maxArr <= MAX_FLOW_CHILDREN) return tree;
  // 超限:内容预算留一条给截断提示(顶层数组仍 ≤40,保证过 BoardFlowStepZ 的 max(40))
  const budget = Math.max(1, Math.min(MAX_FLOW_NODES - 1, st.count));
  const { roots, dropped } = pruneFlow(tree, budget);
  if (dropped > 0) roots.push({ type: "step", text: `…已截断 ${dropped} 个深层分支` });
  return roots.slice(0, MAX_FLOW_NODES);
}

/** 控制流板 spec(agent 造板入口):points=code_sense branches 的 points 原样;fn=只画某函数。 */
export interface DecisionsBoardSpec {
  /** 符号名(单函数场景,进 symbolRef/label)。 */
  symbol?: string;
  /** 只取该函数的分支点(points 覆盖多函数时可只画一个)。 */
  fn?: string;
  points: DecisionPoint[];
  title?: string;
}

/** 分支/循环点 → 控制流板(单节点带 flow;points 覆盖多 fn 时每 fn 一节点、节点间无边)。
 * 零编造:摘要里的 if/loop/深度计数全部来自真实 points;无点=如实写「无分支点」的空板节点。 */
export function decisionsBoard(spec: DecisionsBoardSpec): { title: string; nodes: BoardNode[]; edges: BoardEdge[] } {
  const idAlloc = makeIdAlloc();
  const wanted = spec.fn?.trim();
  const scoped = wanted ? spec.points.filter((p) => (p.fn ?? "") === wanted) : spec.points;
  const src = scoped.length > 0 ? scoped : spec.points; // fn 名对不上=按全部点建板,不出空板
  const groups = new Map<string, DecisionPoint[]>();
  for (const p of src) {
    const k = p.fn ?? "";
    const list = groups.get(k) ?? [];
    list.push(p);
    groups.set(k, list);
  }
  const summarize = (pts: DecisionPoint[]): string => {
    const ifs = pts.filter((p) => p.kind === "if" || p.kind === "elif" || p.kind === "else").length;
    const loops = pts.filter((p) => LOOP_KINDS.has(p.kind)).length;
    const switches = pts.filter((p) => p.kind === "switch").length;
    const ternaries = pts.filter((p) => p.kind === "ternary").length;
    const deepest = pts.reduce((m, p) => Math.max(m, p.depth), 0) + 1;
    return (
      `控制流:if×${ifs} / loop×${loops},最深 ${deepest} 层` +
      (switches ? ` · switch×${switches}` : "") +
      (ternaries ? ` · 三元×${ternaries}` : "")
    );
  };
  const single = groups.size <= 1;
  const nodes: BoardNode[] = [];
  if (groups.size === 0) {
    // 无分支点:仍给一个节点(板协议 nodes min 1),摘要如实说没有
    const name = (spec.symbol ?? spec.fn ?? "控制流").slice(0, 160);
    const id = idAlloc(spec.symbol ?? spec.fn ?? "control_flow");
    nodes.push({
      id, kind: "function" as const, label: name,
      summary: "控制流:无分支点(if×0 / loop×0)".slice(0, 500),
      change: "keep" as const, done: false, comments: [],
      ...(spec.symbol ? { symbolRef: { name: spec.symbol } } : {}),
      flow: [],
    });
  }
  for (const [fn, pts] of [...groups.entries()].slice(0, 56)) {
    const label = (fn || spec.symbol || spec.fn || "控制流").slice(0, 160);
    const id = idAlloc(fn || spec.symbol || spec.fn || "control_flow");
    nodes.push({
      id, kind: "function" as const, label,
      summary: summarize(pts).slice(0, 500),
      change: "keep" as const, done: false, comments: [],
      // symbolRef 只在单组(单函数)时给:多函数板上一个节点对全部点=误导
      ...(single && spec.symbol ? { symbolRef: { name: spec.symbol } } : {}),
      flow: decisionsToFlow(pts),
    });
  }
  const head = spec.symbol || spec.fn || "控制流";
  const title = (spec.title ?? `控制流板:${head}(${src.length} 个分支点 · ${nodes.length} 函数)`).slice(0, 200);
  return { title, nodes, edges: [] };
}
