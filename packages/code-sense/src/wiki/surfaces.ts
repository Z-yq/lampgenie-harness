/**
 * 仓库交互面与管线簇(通用机制):「人人能看懂这个仓」的确定性信号层。
 * 设计原则(与具体仓无关):
 * 1) 交互面 = 数据/控制从哪里进来、到哪里出去。信号族:HTTP 写/读端点(12 框架)、
 *    WS、进程入口(py __main__ / js bin / c·go·java main / package.json bin = CLI+文件输入)。
 *    哪类信号存在就呈现哪类;全缺席=纯库形态,如实标注,不硬造。
 * 2) 管线簇 = 从「入界面文件」出发的 file 级下游子图,按**下游重叠度**聚类
 * (依据:5 个共享同一套 utils 的训练脚本 → 1 个训练管线族,
 *    不再拆成 5 条重复功能线)。每簇:多源 BFS 分层(d0=接入 → d1=处理 → d2+=核心/存储)、
 *    存储枢纽(簇内高入边文件)、独立 mermaid。
 * 3) 全部带 file:line 证据,可被 guide/features/LLM 三方共同消费;LLM 只许在骨架上写人话。
 */
import { queryApiSurface } from "../sensing/index";
import type { ProcessEntry } from "../sensing/procentries";
import { filterCodeFlow, renderCodeFlowMermaid, type CodeFlow, type FlowNode } from "../callgraph/flow";
import { moduleGroupOf } from "../callgraph/modview";
import { slugify } from "./pages";

export type SurfaceKind = "http-write" | "http-read" | "ws" | "process" | "root";

export interface RepoSurface {
  kind: SurfaceKind;
  direction: "in" | "out";
  /** 展示名:POST /v1/memory/{id}/messages | train_asd.py */
  name: string;
  /** docstring/守卫说明(确定性摘录,非 LLM)。 */
  detail?: string;
  file: string;
  line: number;
}

export interface PipelineTrigger {
  name: string;
  kind: SurfaceKind;
  file: string;
  line: number;
  detail?: string;
}

export interface PipelineLayer {
  depth: number;
  role: string;
  files: string[];
  /** 本层枢纽(簇内入边最高)。 */
  hub?: string;
  hubIn?: number;
}

export interface RepoPipeline {
  id: string;
  title: string;
  triggers: PipelineTrigger[];
  /** 触发文件清单(去重)。 */
  entryFiles: string[];
  /** 簇内全部文件(按层排序;全量,不设上限)。 */
  files: string[];
  modules: string[];
  layers: PipelineLayer[];
  /** 存储/核心候选(簇内高入边非触发文件)。 */
  sinks: string[];
  mermaid: string;
  reach: number;
}

export type RepoShape = "service" | "cli" | "mixed" | "library";

export interface RepoSurfaces {
  shape: RepoShape;
  httpFrameworks: string[];
  /** 写端点 + 进程入口(数据/控制进来)。 */
  inSurfaces: RepoSurface[];
  /** 读端点 + WS(数据/结果出去)。 */
  outSurfaces: RepoSurface[];
  processEntries: ProcessEntry[];
  pipelines: RepoPipeline[];
}

const WRITE_RE = /^(POST|PUT|PATCH|DELETE)$/i;

/** 交互面采集:HTTP(api 扫描器同源)+ 进程入口(procentries 同源)。失败面=缺席,不毙整体。 */
export async function collectSurfaces(
  root: string,
  processEntries: ProcessEntry[],
): Promise<{ http: { frameworks: string[]; in: RepoSurface[]; out: RepoSurface[] } | null }> {
  try {
    const r = await queryApiSurface(root, { withImpact: false });
    if (r.endpoints.length === 0) return { http: null };
    const toSurface = (e: { method: string; path: string; handler?: string; file: string; line: number; docHint?: string; kind: string }): RepoSurface => ({
      kind: e.kind === "ws" ? "ws" : WRITE_RE.test(e.method) ? "http-write" : "http-read",
      direction: e.kind === "ws" || WRITE_RE.test(e.method) ? "in" : "out",
      name: `${e.method} ${e.path}`,
      ...(e.docHint ? { detail: e.docHint } : {}),
      file: e.file,
      line: e.line,
    });
    const all = r.endpoints.map(toSurface);
    return {
      http: {
        frameworks: r.frameworks,
        in: all.filter((x) => x.direction === "in"),
        out: all.filter((x) => x.direction === "out"),
      },
    };
  } catch {
    return { http: null };
  }
}

/** 下游闭包:多源 BFS ≤maxDepth 跳。cap 只作护栏(防异常环爆炸),正常仓远达不到;
 * 不再用小 cap 截断聚类集合(旧 14 会把高重叠入口拆散)。 */
function downstreamOf(flow: CodeFlow, starts: string[], maxDepth = 3, cap = 4096): Map<string, number> {
  const adj = new Map<string, string[]>();
  for (const e of flow.edges) (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
  const depth = new Map<string, number>();
  const q: string[] = [];
  for (const s of starts) {
    if (flow.nodes.some((n) => n.id === s) && !depth.has(s)) { depth.set(s, 0); q.push(s); }
  }
  for (let i = 0; i < q.length && depth.size < cap; i++) {
    const cur = q[i]!;
    const d = depth.get(cur)!;
    if (d >= maxDepth) continue;
    for (const nxt of adj.get(cur) ?? []) {
      if (depth.has(nxt) || depth.size >= cap) continue;
      depth.set(nxt, d + 1);
      q.push(nxt);
    }
  }
  return depth;
}

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};

const LAYER_ROLE = (d: number): string => (d === 0 ? "接入层(数据/触发进来)" : d === 1 ? "处理层" : "核心/存储层");

/**
 * 管线簇:入界面文件 → 下游闭包 → 按 Jaccard≥0.55 贪心聚类 → 每簇多源 BFS 分层。
 * fileFlow 缺席/零入口 → 空数组(调用方降级到模块级功能线)。
 */
export function clusterPipelines(
  fileFlow: CodeFlow | null,
  inSurfaces: RepoSurface[],
  maxPipelines = 8): RepoPipeline[] {
  if (!fileFlow || inSurfaces.length === 0) return [];
  const nodeById = new Map(fileFlow.nodes.map((n) => [n.id, n]));
  // 触发文件=入界面文件中在 file 图里有节点的(图外触发文件无下游可画,不建簇)
  const triggerFiles = [...new Set(inSurfaces.map((s) => s.file))].filter((f) => nodeById.has(`f:${f}`));
  if (triggerFiles.length === 0) return [];

  // 每个触发文件的下游闭包
  const sets = new Map<string, Set<string>>();
  for (const f of triggerFiles) {
    sets.set(f, new Set(downstreamOf(fileFlow, [`f:${f}`]).keys()));
  }
  // 按闭包大小降序贪心聚类
  const order = [...sets.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));
  interface Cluster { files: Set<string>; members: string[] }
  const clusters: Cluster[] = [];
  for (const [file, set] of order) {
    if (set.size === 0) continue; // 零下游(纯声明文件)不建簇
    const hit = clusters.find((c) => jaccard(set, c.files) >= 0.55);
    if (hit) {
      hit.members.push(file);
      for (const x of set) hit.files.add(x);
    } else {
      clusters.push({ files: new Set(set), members: [file] });
    }
  }
  clusters.sort((a, b) => b.files.size - a.files.size || a.members[0]!.localeCompare(b.members[0]!));

  const pipelines: RepoPipeline[] = [];
  for (const c of clusters.slice(0, maxPipelines)) {
    const startIds = c.members.map((f) => `f:${f}`!).filter((id) => nodeById.has(id));
    const depth = downstreamOf(fileFlow, startIds);
    // 闭包可能因 cap 截断,以聚类并集为准补深度(未达=最深+1)
    const keep = new Set<string>();
    for (const id of c.files) if (nodeById.has(id)) keep.add(id);
    for (const id of keep) if (!depth.has(id)) depth.set(id, 3);
    const nodes = fileFlow.nodes.filter((n) => keep.has(n.id));
    const triggers: PipelineTrigger[] = c.members.map((f) => {
      const s = inSurfaces.find((x) => x.file === f) ?? {
        kind: "root" as const, direction: "in" as const, name: f.split("/").pop() || f,
        detail: "组合根(启动装配)", file: f, line: 1,
      };
      return { name: s.name, kind: s.kind, file: s.file, line: s.line, ...(s.detail ? { detail: s.detail } : {}) };
    });
    // 分层:按多源 BFS 深度;每层取前 10 文件 + 枢纽
    const layers: PipelineLayer[] = [];
    for (const d of [...new Set(nodes.map((n) => n.depth < 0 ? 3 : depth.get(n.id) ?? 3))].sort((a, b) => a - b)) {
      const list = nodes.filter((n) => (depth.get(n.id) ?? 3) === d).sort((a, b) => (b.inCalls + b.outCalls) - (a.inCalls + a.outCalls));
      const hub = [...list].sort((a, b) => b.inCalls - a.inCalls)[0];
      layers.push({
        depth: d,
        role: LAYER_ROLE(d),
        files: list.slice(0, 10).map((n) => n.label),
        ...(hub && hub.inCalls > 0 && d > 0 ? { hub: hub.label, hubIn: hub.inCalls } : {}),
      });
    }
    // 存储/核心:簇内非触发的高入边文件 top3
    const sinks = nodes
      .filter((n) => !c.members.some((f) => n.id === `f:${f}`))
      .sort((a, b) => b.inCalls - a.inCalls)
      .slice(0, 3)
      .map((n) => n.label);
    const repFile = c.members[0]!;
    // 标题用入口文件短路径(末两段):端点串太长且无 LLM 语义名时不可读;
    // 末两段还能消歧(life_journal/runner.py vs pipeline_v2/runner.py)。
    const short = repFile.split("/").slice(-2).join("/");
    pipelines.push({
      id: slugify(repFile) || "pipeline",
      title: c.members.length > 1 ? `${short} 等 ${c.members.length} 个入口` : short,
      triggers,
      entryFiles: [...c.members],
      files: nodes.sort((a, b) => (depth.get(a.id) ?? 9) - (depth.get(b.id) ?? 9)).map((n) => n.label),
      modules: [...new Set(nodes.map((n) => moduleGroupOf(n.label)))],
      layers,
      sinks,
      mermaid: renderCodeFlowMermaid(filterCodeFlow(fileFlow, keep), { legend: false }),
      reach: keep.size,
    });
  }
  return pipelines;
}

/** 形态判定:HTTP 在场=service;进程入口在场=cli;两者=mixed;都没有=library。 */
export function repoShape(hasHttp: boolean, processCount: number): RepoShape {
  if (hasHttp && processCount > 0) return "mixed";
  if (hasHttp) return "service";
  if (processCount > 0) return "cli";
  return "library";
}