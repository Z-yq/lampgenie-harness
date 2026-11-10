/**
 * 代码档案的 flow 数据源:把整仓 code flow 接到 wiki 管线。
 * 两条数据路径:
 *  - 有静态索引(优先):buildCodeFlow 出 module/file 两层图 + 入口/功能线;
 *  - 无索引(诚实降级):用 wiki 自己的模块/import 扫描造一个词法级 module 图,
 *    页面与 manifest 明确标 source=lexical(不冒充符号级调用边)。
 * 功能拆解(WikiFeature)是确定性派生:入口(进程/bin/零入度根)→ 下游模块 BFS ≤3 跳 →
 * 关键文件/函数按调用量排序 → 每功能线一张子图 mermaid。LLM 只在这层事实上写语义解读,
 * 不改边、不改文件/符号清单。
 */
import { readFileSync } from "node:fs";
import { collectSurfaces, clusterPipelines, repoShape, type RepoPipeline, type RepoSurface, type RepoShape } from "./surfaces";
import { buildPipelineCfgs, type WikiPipelineCfg } from "./cfg-source";
import { join } from "node:path";
import { loadIndex, type C2fIndex, type C2fNode } from "../callgraph/c2f";
import {
  buildCodeFlow, filterCodeFlow, renderCodeFlowMermaid,
  type CodeFlow, type FlowNode,
} from "../callgraph/flow";
import { moduleGroupOf } from "../callgraph/modview";
import { moduleAnnotationText, moduleNotes, type ModuleNote } from "../callgraph/module-notes";
import { scanProcessEntriesSync, type ProcessEntry } from "../sensing/procentries";
import { slugify } from "./pages";
import type { WikiInput } from "./scan";
import type { WikiFeature, WikiFlowSummary } from "./types";

export interface WikiFlowBundle {
  source: "index" | "lexical";
  /** 模块级全仓图(主图;功能线也在这层切)。 */
  moduleFlow: CodeFlow;
  /** 文件级全仓图(有索引时;仅用于热点/模块流页)。 */
  fileFlow: CodeFlow | null;
  /** 页面主图:模块数≥4 用模块图,否则用文件图(小仓模块图只有一两个点)。 */
  primary: CodeFlow;
  features: WikiFeature[];
  /** 模块 → package.json description(确定性语义线索;无=不出现在表里)。 */
  moduleDocs: Record<string, string>;
  /** 模块 → 一句话作用/角色(来源:package.json/README/docstring/名称/拓扑;图旁斜体)。 */
  moduleNotes: Record<string, ModuleNote>;
  /** 可生成 file 级 flow 子页的模块(有索引时的 top 模块)。 */
  moduleNames: string[];
  /** 模块名 → 该模块的 file 级子图(有索引时;flow 子页用)。 */
  moduleFlows: Record<string, CodeFlow>;
  /** LLM 页的源码摘录文件(入口/功能线热点)。 */
  llmFiles: string[];
  /** 功能线相关文件(页面 sources / 增量失效)。 */
  featureFiles: string[];
  /** 给 LLM 的确定性骨架(入口/边/功能线/接口面;禁止它编造图里的边)。 */
  llmContext: string;
 /** 交互面+管线簇(通用机制:HTTP/WS/进程入口 → in/out 面 → 聚类管线)。 */
  surfaces: {
    shape: RepoShape;
    httpFrameworks: string[];
    inSurfaces: RepoSurface[];
    outSurfaces: RepoSurface[];
    pipelines: RepoPipeline[];
  } | null;
  /** 每条管线 1 页「关键流程图」(函数级 CFG;长函数分页,不丢节点)。 */
  cfgs: WikiPipelineCfg[];
  summary: WikiFlowSummary;
  notes: string[];
}

function topFilesOfModule(index: C2fIndex, module: string, limit: number): string[] {
  const out: { file: string; symbols: number }[] = [];
  for (const [file, ids] of Object.entries(index.byFile)) {
    if (file !== module && moduleGroupOf(file) !== module) continue;
    out.push({ file, symbols: ids.length });
  }
  return out.sort((a, b) => b.symbols - a.symbols || a.file.localeCompare(b.file)).slice(0, limit).map((x) => x.file);
}

function topSymbolsOfFiles(index: C2fIndex, files: string[], limit: number): WikiFeature["symbols"] {
  const set = new Set(files);
  const nodes: C2fNode[] = index.nodes.filter((n) => set.has(n.file));
  nodes.sort((a, b) => (b.outCount + b.inCount) - (a.outCount + a.inCount) || a.file.localeCompare(b.file) || a.line - b.line);
  return nodes.slice(0, limit).map((n) => ({ name: n.name, file: n.file, line: n.line, calls: n.outCount + n.inCount }));
}

function greedyPath(start: string, edges: CodeFlow["edges"], labels: Map<string, string>, maxHops = 4): string[] {
  const out = new Map<string, CodeFlow["edges"]>();
  for (const e of edges) (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
  for (const list of out.values()) list.sort((a, b) => b.count - a.count);
  const path: string[] = [labels.get(start) ?? start];
  const seen = new Set<string>([start]);
  let cur = start;
  for (let hop = 0; hop < maxHops; hop++) {
    const next = (out.get(cur) ?? []).find((e) => !seen.has(e.to));
    if (!next) break;
    path.push(labels.get(next.to) ?? next.to);
    seen.add(next.to);
    cur = next.to;
  }
  return path;
}

/** 从主图入口派生功能线(确定性;BFS ≤3 跳、≤14 节点)。
 * level=module:节点=模块,files/symbols 按模块聚合;
 * level=file:节点=文件,modules=visited 文件的所属模块,files=visited 文件本身(按符号数排序)。 */
function extractFeatures(flow: CodeFlow, index: C2fIndex | null, maxFeatures: number, docs: Record<string, string>): WikiFeature[] {
  const isFileLevel = flow.level === "file";
  const labels = new Map(flow.nodes.map((n) => [n.id, n.label === "<module>" && n.file ? `<module>@${n.file}` : n.label]));
  const adj = new Map<string, string[]>();
  for (const e of flow.edges) (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
  const entryNodes = flow.nodes
    .filter((n) => n.entry)
    .sort((a, b) => (b.outCalls + b.inCalls) - (a.outCalls + a.inCalls))
    .slice(0, maxFeatures);
  const features: WikiFeature[] = [];
  for (const entry of entryNodes) {
    const visited = new Set<string>([entry.id]);
    const depth = new Map<string, number>([[entry.id, 0]]);
    const queue = [entry.id];
    for (let i = 0; i < queue.length && visited.size < 14; i++) {
      const cur = queue[i]!;
      const d = depth.get(cur)!;
      if (d >= 3) continue;
      for (const nxt of adj.get(cur) ?? []) {
        if (visited.has(nxt) || visited.size >= 14) continue;
        visited.add(nxt);
        depth.set(nxt, d + 1);
        queue.push(nxt);
      }
    }
    const subEdges = flow.edges.filter((e) => visited.has(e.from) && visited.has(e.to));
    const visitedNodes = flow.nodes.filter((n) => visited.has(n.id));
    let files: string[] = [];
    let modules: string[];
    if (isFileLevel) {
      modules = [...new Set(visitedNodes.map((n) => moduleGroupOf(n.label)))];
      if (index) {
        files = visitedNodes
          .map((n) => ({ file: n.label, symbols: index.byFile[n.label]?.length ?? 0 }))
          .sort((a, b) => b.symbols - a.symbols || a.file.localeCompare(b.file))
          .slice(0, 8)
          .map((x) => x.file);
      }
    } else {
      modules = visitedNodes.map((n) => n.label);
      if (index) {
        for (const m of modules) {
          for (const f of topFilesOfModule(index, m, 3)) if (!files.includes(f)) files.push(f);
          if (files.length >= 8) break;
        }
      }
    }
    const symbols = index ? topSymbolsOfFiles(index, files.slice(0, 4), 8) : [];
    const mermaid = renderCodeFlowMermaid(filterCodeFlow(flow, visited), { legend: false });
    const baseTitle = entry.label === "<module>" && entry.file ? `<module>@${entry.file}` : entry.label;
    const entryTitle = docs[entry.label] ? `${baseTitle} — ${docs[entry.label]}` : baseTitle;
    features.push({
      id: slugify(baseTitle),
      title: entryTitle,
      entry: {
        label: entryTitle,
        kind: entry.entryKind ?? "trunk",
        ...(entry.file ? { file: entry.file } : {}),
        ...(entry.line ? { line: entry.line } : {}),
      },
      path: greedyPath(entry.id, flow.edges, labels),
      modules,
      files: files.slice(0, 8),
      symbols,
      edges: subEdges.map((e) => ({ from: labels.get(e.from) ?? e.from, to: labels.get(e.to) ?? e.to, count: e.count })),
      reach: visited.size,
      mermaid,
    });
  }
  // 无入口(纯库/闭环):用全图 Top 12 节点造一条「全仓主流程」,不冒充功能拆解。
  if (features.length === 0 && flow.nodes.length > 0) {
    const kept = new Set(flow.nodes.slice(0, 12).map((n) => n.id));
    features.push({
      id: "all",
      title: "全仓主流程(无显式入口)",
      entry: { label: "(无入口)", kind: "none" },
      path: flow.nodes.slice(0, 5).map((n) => n.label),
      modules: flow.nodes.slice(0, 12).map((n) => n.label),
      files: [],
      symbols: [],
      edges: flow.edges.filter((e) => kept.has(e.from) && kept.has(e.to)).map((e) => ({ from: labels.get(e.from) ?? e.from, to: labels.get(e.to) ?? e.to, count: e.count })),
      reach: kept.size,
      mermaid: renderCodeFlowMermaid(filterCodeFlow(flow, kept), { legend: false }),
    });
  }
  return features;
}

/** 无索引兜底:按 wiki 自己的模块/import 扫描造一个词法级 module 索引(不产符号边)。 */
function lexicalIndex(input: WikiInput): C2fIndex | null {
  const names = input.modules.map((m) => m.name);
  if (names.length === 0) return null;
  const nodes: C2fNode[] = names.map((name) => ({
    id: `${name}#${name}`, name, file: name, line: 1, kind: "regular", outCount: 0, inCount: 0,
  }));
  const byFile: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  const byName: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const n of nodes) {
    (byFile[n.file] ??= []).push(n.id);
    (byName[n.name] ??= []).push(n.id);
  }
  const edges: C2fIndex["edges"] = [];
  for (const imp of input.imports) {
    const a = input.moduleOf.get(imp.file);
    if (!a) continue;
    for (const t of imp.targets) {
      const b = input.moduleOf.get(t.file);
      if (!b || a === b) continue;
      edges.push({ from: `${a}#${a}`, to: `${b}#${b}`, toName: b, file: imp.file, line: t.line, kind: "import" });
    }
  }
  return {
    version: 1, root: input.root, gitHead: input.gitHead, builtAt: Date.now(), buildMs: 0,
    nodes, edges, byFile, byName,
  } as unknown as C2fIndex;
}

function lexicalProcessEntries(input: WikiInput): ProcessEntry[] {
  return input.hints.entryFiles.slice(0, 12).map((e) => ({
    kind: "js-bin", lang: "js", file: e.file, line: e.line, label: e.reason || "entry", calls: [],
  })) as ProcessEntry[];
}

function buildLlmContext(
  flow: CodeFlow,
  features: WikiFeature[],
  source: "index" | "lexical",
  notes: string[],
  surfaces: WikiFlowBundle["surfaces"],
): string {
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const entries = flow.nodes.filter((n) => n.entry).map((n) => `${n.label}(${n.entryKind ?? "trunk"}${n.entryLabel ? `: ${n.entryLabel}` : ""})`);
  const edges = flow.edges.slice(0, 30).map((e) => `${byId.get(e.from)?.label ?? e.from} → ${byId.get(e.to)?.label ?? e.to} ×${e.count}`);
  const layers = new Map<number, string[]>();
  for (const n of flow.nodes) {
    if (n.depth < 0) continue;
    (layers.get(n.depth) ?? layers.set(n.depth, []).get(n.depth)!).push(n.label);
  }
  const layerText = [...layers.entries()].sort((a, b) => a[0] - b[0]).slice(0, 6).map(([d, names]) => `d${d}: ${names.slice(0, 10).join(", ")}`);
  const featureText = features.map((f, i) => {
    const syms = f.symbols.slice(0, 6).map((s) => `${s.name}@${s.file}:${s.line}`).join(", ");
    return `F${i + 1} [id=${f.id}] ${f.title}: 路径 ${f.path.join(" → ")};模块 ${f.modules.join(", ")};关键文件 ${f.files.slice(0, 4).join(", ")}${syms ? `;关键符号 ${syms}` : ""}`;
  });
  return [
    `数据口径: ${source === "index" ? "静态调用索引(符号级)" : "词法级(仅 import,未加载索引)"} · ${flow.level} 层 · ${flow.stats.nodesShown} 节点/${flow.stats.edgesShown} 边`,
    "【入口】",
    ...entries.slice(0, 12).map((x) => `- ${x}`),
    "【模块/文件边】",
    ...edges.map((x) => `- ${x}`),
    "【分层】",
    ...layerText.map((x) => `- ${x}`),
    "【功能线(确定性拆解)】",
    ...featureText.map((x) => `- ${x}`),
    ...(notes.length ? ["【口径说明】", ...notes.map((n) => `- ${n}`)] : []),
    ...(surfaces ? [
      `【仓库形态】${surfaces.shape}${surfaces.httpFrameworks.length ? `(框架 ${surfaces.httpFrameworks.join("/")})` : ""}`,
      `【交互面(确定性)】进来 ${surfaces.inSurfaces.length} 个(写端点+进程入口)/ 出去 ${surfaces.outSurfaces.length} 个(读端点)`,
      ...surfaces.inSurfaces.slice(0, 12).map((e) => `- 入 ${e.name} @ ${e.file}:${e.line}${e.detail ? `(${e.detail.slice(0, 50)})` : ""}`),
      ...surfaces.outSurfaces.slice(0, 8).map((e) => `- 出 ${e.name} @ ${e.file}:${e.line}${e.detail ? `(${e.detail.slice(0, 50)})` : ""}`),
      ...(surfaces.pipelines.length ? [
        "【管线簇(入界面 → 下游重叠聚类;d0=接入 → d1=处理 → d2+=核心/存储)】",
        ...surfaces.pipelines.flatMap((p) => [
          `- [id=${p.id}] ${p.title}: 触发 ${p.triggers.length} 个;模块 ${p.modules.join(",")};`,
          `  分层 ${p.layers.map((l) => `d${l.depth}(${l.files.slice(0, 3).join("|")}${l.hub ? `,枢纽 ${l.hub}` : ""})`).join(" → ")}`,
          `  存储/核心 ${p.sinks.slice(0, 3).join(", ")}`,
        ]),
      ] : ["【管线簇】未检出可聚类的下游链(库形态或零入界面)"]),
    ] : ["【交互面】未采集(flow 关闭)"]),
    "纪律: 上述入口/边/功能线/交互面/管线簇是确定性事实;叙述必须与之保持一致,不得添加不存在的模块或调用边;不要输出 mermaid 图(图由确定性骨架提供)。",
  ].join("\n");
}

export async function loadWikiFlow(root: string, input: WikiInput, opts: { maxFeatures: number; maxFlowFiles: number }): Promise<WikiFlowBundle | null> {
  const notes: string[] = [];
  let index: C2fIndex | null = null;
  try {
    index = loadIndex(root);
  } catch {
    index = null;
  }
  let source: "index" | "lexical" = "index";
  let proc: ProcessEntry[] = [];
  let synthetic: C2fIndex | null = null;
  if (!index || index.nodes.length === 0) {
    synthetic = lexicalIndex(input);
    if (!synthetic) return null;
    source = "lexical";
    index = null;
    proc = lexicalProcessEntries(input);
    notes.push("未找到静态索引:本页 flow 为词法级(模块/import),运行 codesense index 后重建可得到符号级调用流");
  } else {
    const head = index.headSha ?? index.gitHead ?? "";
    if (index.headSha && input.gitHead && index.headSha !== input.gitHead) {
      notes.push("静态索引的 git HEAD 与 wiki 输入不一致:flow 可能落后于工作区,建议先 codesense index 再重建");
    } else if (!head) {
      notes.push("索引未记录 git HEAD:flow 与源码的新鲜度无法对账(按索引当前内容生成)");
    }
    proc = scanProcessEntriesSync(root, index).entries;
  }
  const idx = index ?? synthetic!;
  const moduleFlow = buildCodeFlow(idx, { level: "module", processEntries: proc });
  const fileFlow = source === "index"
    ? buildCodeFlow(idx, { level: "file", maxNodes: opts.maxFlowFiles, processEntries: proc })
    : null;
  const primary = moduleFlow.nodes.length >= 4 ? moduleFlow : (fileFlow ?? moduleFlow);
  if (primary !== moduleFlow) notes.push("模块数不足 4:主图改用文件级(模块级只有一两个点,读不出方向)");
  const moduleDocs: Record<string, string> = {};
  for (const n of primary.nodes) {
    const pkg = /^\(?root\)?$/i.test(n.label) ? "package.json" : `${n.label}/package.json`;
    try {
      const j = JSON.parse(readFileSync(join(root, pkg), "utf-8")) as { description?: unknown };
      if (typeof j.description === "string" && j.description.trim()) moduleDocs[n.label] = j.description.trim().slice(0, 120);
    } catch {
      // 无 package.json/无 description:不编造
    }
  }
  // 模块作用注记:画在模块图节点名下方(graph 本身只有名字+规模,读不出职责)
  const modNotes = moduleNotes(root, moduleFlow, { docs: moduleDocs });
  moduleFlow.annotations = Object.fromEntries(
    Object.entries(modNotes).map(([k, v]) => [k, moduleAnnotationText(v)]),
  );
  if (primary === moduleFlow) primary.annotations = moduleFlow.annotations;
  let features = extractFeatures(primary, idx, opts.maxFeatures, moduleDocs);
  const moduleFlows: Record<string, CodeFlow> = {};
  if (source === "index") {
    const candidates = [...input.modules]
      .filter((m) => (input.moduleFiles.get(m.name)?.length ?? 0) > 0)
      .sort((a, b) => (input.moduleFiles.get(b.name)?.length ?? 0) - (input.moduleFiles.get(a.name)?.length ?? 0))
      .slice(0, 6)
      .map((m) => m.name);
    for (const name of candidates) {
 // 根模块的 name 是 "(root)"/"root":scope 前缀匹配不到任何文件(经验证生成 0 节点空页),
      // 改用「无斜杠的根级文件」正则;其余模块用目录前缀。
      const isRoot = /^\(?root\)?$/i.test(name);
      const mf = buildCodeFlow(idx, {
        level: "file",
        ...(isRoot ? { include: "^[^/]+$" } : { scope: name }),
        maxNodes: 0, maxEdges: 0, // 诚实全量:模块子图也不设上限
        processEntries: proc,
      });
      if (mf.nodes.length >= 2) moduleFlows[name] = mf;
    }
  }
  const moduleNames = Object.keys(moduleFlows);
  const featureFiles = [...new Set(features.flatMap((f) => f.files))].slice(0, 12);
  const entryFiles = primary.nodes.filter((n) => n.entry && n.file).map((n) => n.file!);
  const moduleHotFiles = source === "index"
    ? primary.nodes.slice(0, 4).flatMap((n) => topFilesOfModule(idx, n.label, 2))
    : [];
  const llmFiles = [...new Set([...entryFiles, ...featureFiles, ...moduleHotFiles, ...input.hints.entryFiles.map((x) => x.file)])]
    .filter((f) => input.sourceFiles.includes(f))
    .slice(0, 8);
  // 交互面(通用信号层):HTTP 写/读 + 进程入口;哪类在场呈现哪类,全缺席=纯库形态
  let surfaces: WikiFlowBundle["surfaces"] = null;
  {
    const http = await collectSurfaces(root, proc);
    const inSurfaces: RepoSurface[] = [
      ...(http?.http?.in ?? []),
      ...proc
        .filter((e) => e.file !== "package.json")
        .map((e) => ({
          kind: "process" as const, direction: "in" as const,
          name: e.file.split("/").pop() || e.file,
          ...(e.label ? { detail: e.label } : {}),
          file: e.file, line: e.line,
        })),
    ];
    // 组合根(启动装配点)也是控制进入面:模块级跨文件调用=进程从这里把控制交进代码
 // (lampgenie-harness 依据:gateway main.ts 无 HTTP 写端点,漏掉它整条网关管线消失)。
    const covered = new Set(inSurfaces.map((e) => e.file));
    const rootSurfaces: RepoSurface[] = (fileFlow?.nodes ?? [])
      .filter((n) => n.entry && n.outCalls > 0 && n.file && !covered.has(n.file))
      .sort((a, b) => b.outCalls - a.outCalls)
      .slice(0, 12)
      .map((n) => ({
        kind: "root" as const, direction: "in" as const,
        name: n.file!.split("/").pop() || n.file!,
        detail: "组合根(启动装配)", file: n.file!, line: n.line ?? 1,
      }));
    inSurfaces.push(...rootSurfaces);
    const outSurfaces = http?.http?.out ?? [];
    // 聚类用**无预算**专用 file 图:聚合毫秒级,而渲染预算(maxFlowFiles)会把触发文件
 // 本身裁掉(依据:service/app.py 不在预算内,HTTP 簇整族消失)。
    let pipelineFlow: CodeFlow | null = null;
    if (source === "index") {
      try {
        pipelineFlow = buildCodeFlow(idx, { level: "file", maxNodes: 0, maxEdges: 0, processEntries: proc });
      } catch {
        pipelineFlow = null;
      }
    }
    const pipelines = pipelineFlow ? clusterPipelines(pipelineFlow, inSurfaces, opts.maxFeatures) : [];
    surfaces = {
      shape: repoShape((http?.http?.in.length ?? 0) + (http?.http?.out.length ?? 0) > 0, proc.length),
      httpFrameworks: http?.http?.frameworks ?? [],
      inSurfaces, outSurfaces, pipelines,
    };
  }

  // 功能拆解 = 管线簇(通用):入界面 → 下游闭包 → 重叠聚类;file 图缺席/零入界面时
  // 降级为旧入口可达功能线(词法级/无触发面仓仍可用)。
  if (surfaces && surfaces.pipelines.length > 0) {
    features = surfaces.pipelines.map((p) => ({
      id: p.id,
      title: p.title,
      triggers: p.triggers,
      entry: { label: p.entryFiles[0] ?? p.title, kind: p.triggers[0]?.kind ?? "process", ...(p.triggers[0]?.file ? { file: p.triggers[0]!.file, line: p.triggers[0]!.line } : {}) },
      path: p.layers.map((l) => l.files[0]).filter((x): x is string => Boolean(x)).slice(0, 4),
      modules: p.modules,
      files: p.files.slice(0, 8),
      symbols: [],
      edges: [],
      reach: p.reach,
      mermaid: p.mermaid,
    }));
    notes.push(`功能拆解=管线簇(入界面下游按重叠度聚类,${surfaces.pipelines.length} 簇);关键函数清单见各簇关键文件`);
  }

  // 关键流程图:每条管线挑 ≤3 个函数(入口优先 + 复杂度),函数体语句级 CFG
  let cfgs: WikiPipelineCfg[] = [];
  if (source === "index" && surfaces && surfaces.pipelines.length > 0) {
    cfgs = await buildPipelineCfgs(root, idx, surfaces.pipelines, { maxPerPipeline: 3 });
    if (cfgs.length > 0) notes.push(`关键流程图:${cfgs.length} 条管线 × ≤3 个关键函数(长函数分页,节点/边不删)`);
  }

  const llmContext = buildLlmContext(primary, features, source, notes, surfaces);
  const st = primary.stats;
  const summary: WikiFlowSummary = {
    source,
    level: primary.level,
    nodes: st.nodesShown,
    edges: st.edgesShown,
    entries: primary.entries.length,
    omittedNodes: st.nodesOmitted,
    omittedEdges: st.edgesOmitted,
    unresolvedCalls: st.unresolvedCalls,
    bridgeEdges: st.bridgeEdges,
    features,
    notes,
  };
  return {
    source, moduleFlow, fileFlow, primary, features, moduleDocs, moduleNotes: modNotes, moduleNames, moduleFlows,
    llmFiles, featureFiles, llmContext, surfaces, cfgs, summary, notes,
  };
}