/**
 * 模块视图(modview, P1):「有哪些模块、模块间怎么交互」的架构级答案面。
 * 背景(用户拷问依据):agent_alpha 的模块清单+交互矩阵,CLI 此前完全无面(project 拓扑只给
 * top-6 目录计数、explore 返回散点函数、modulemap 无交互面且无 CLI 出口)——数据在索引里
 * 是全的,本模块把它产品化:分组 → 跨模块边聚合 → 枢纽/测试面/mermaid 架构图。
 * 分组规则(在 agent_alpha 上经 grep 逐边验证):
 * - 根目录文件自成一组(web_chat_server.py、grpc_multimodal_adapter.py——进程启动器形态);
 * - 大目录摊开二级:modules/<sub>、tests、packages/<name>、apps/<name>、cmd/<bin>(Go 惯例)、
 *   src/<sub>、internal/<sub>——modules/ 不摊会把引擎主体与 v1 旧核混成一组;
 * - 其余取一级目录。
 * 边语义:A→B = A 组内符号调用 B 组内符号的索引边数(方向=依赖方向);tests 组单独成面
 * (测试对模块的覆盖),不混入主干;枢纽=被非测试模块调用最多的组(入边+来源模块数)。
 * 纯查询层:零抽取变化,不触发索引版本迁移。
 */
import type { C2fIndex } from "./c2f";

/** 摊开二级的顶层目录(modules/packages/apps/cmd/src/internal)。tests 不摊:测试=单一面
 * (实仓注意:tests/ws_api_e2e、tests/bak 各自成组后测试边混进交互主干)。 */
const EXPAND_DIRS = new Set(["modules", "packages", "apps", "cmd", "src", "internal"]);

export function moduleGroupOf(file: string): string {
  const segs = file.split("/");
  if (segs.length === 1) return file; // 根文件自成组(启动器/适配器形态)
  const first = segs[0]!;
  // 摊开目录下的散文件(modules/x.py 两段)也按根文件语义自成组——聚成裸组「modules」
 // 会产出「modules → modules/digital_human」这类可读性差的边(实仓注意)
  if (EXPAND_DIRS.has(first)) {
    if (segs.length === 2) return file;
    if (segs.length > 2) return `${first}/${segs[1]!}`;
  }
  return first;
}

const TEST_GROUP = "tests";

export interface ModuleInfo {
  name: string;
  /** 有索引符号的文件数。 */
  files: number;
  /** 出现的语言扩展名(去重,截 4)。 */
  langs: string[];
}

export interface ModuleEdge {
  from: string;
  to: string;
  count: number;
}

export interface HubInfo {
  module: string;
  /** 调用它的非测试模块数。 */
  sourceModules: number;
  /** 来自非测试模块的入边总数。 */
  inEdges: number;
}

export interface TestLink {
  module: string;
  edges: number;
  testFiles: number;
}

export interface ModuleView {
  modules: ModuleInfo[];
  /** 跨模块交互(不含 tests 组),按边数降序。 */
  interactions: ModuleEdge[];
  /** 枢纽(被依赖最多,截 6)。 */
  hubs: HubInfo[];
  /** 测试面:tests 组对各模块的调用边与涉及测试文件数,按边数降序截 8。 */
  testLinks: TestLink[];
  /** 分组摊开与否的口径说明(诚实:分组是启发式)。 */
  groupingNote: string;
}

export function buildModuleView(index: C2fIndex, opts: { maxModules?: number; maxEdges?: number } = {}): ModuleView {
  const maxModules = opts.maxModules ?? 40;
  const maxEdges = opts.maxEdges ?? 200;

  // 模块清单:组 → 文件集/语言集(小模块截断进 (misc),不静默)
  const byGroup = new Map<string, { files: Set<string>; langs: Set<string> }>();
  const fileGroup = new Map<string, string>();
  for (const n of index.nodes) {
    const g = moduleGroupOf(n.file);
    fileGroup.set(n.file, g);
    let cur = byGroup.get(g);
    if (!cur) { cur = { files: new Set(), langs: new Set() }; byGroup.set(g, cur); }
    cur.files.add(n.file);
    const dot = n.file.lastIndexOf(".");
    if (dot >= 0) cur.langs.add(n.file.slice(dot));
  }
  const sortedGroups = [...byGroup.entries()].sort((a, b) => b[1].files.size - a[1].files.size || a[0].localeCompare(b[0]));
  const kept = sortedGroups.slice(0, maxModules);
  const misc = sortedGroups.slice(maxModules);
  const modules: ModuleInfo[] = kept.map(([name, v]) => ({
    name,
    files: v.files.size,
    langs: [...v.langs].slice(0, 4),
  }));
  if (misc.length > 0) {
    const miscFiles = misc.reduce((n, [, v]) => n + v.files.size, 0);
    modules.push({ name: "(misc)", files: miscFiles, langs: [] });
    for (const [, v] of misc) for (const f of v.files) fileGroup.set(f, "(misc)");
  }

  // 跨组边聚合(to 空边不计——未解析边无目标组);tests 组单列
  const cross = new Map<string, number>();
  const inByModule = new Map<string, { edges: number; sources: Set<string> }>();
  const testFace = new Map<string, { edges: number; files: Set<string> }>();
  for (const e of index.edges) {
    if (!e.to) continue;
    const ga = fileGroup.get(e.file) ?? moduleGroupOf(e.file);
    const tFile = targetFileOf(e.to);
    const gb = fileGroup.get(tFile) ?? moduleGroupOf(tFile);
    if (ga === gb) continue;
    if (ga === TEST_GROUP) {
      const cur = testFace.get(gb) ?? { edges: 0, files: new Set<string>() };
      cur.edges++;
      cur.files.add(e.file);
      testFace.set(gb, cur);
      continue;
    }
    if (gb === TEST_GROUP) continue; // 模块→测试方向的边不进主干
    const k = `${ga}\u0000${gb}`;
    cross.set(k, (cross.get(k) ?? 0) + 1);
    const hub = inByModule.get(gb) ?? { edges: 0, sources: new Set<string>() };
    hub.edges++;
    hub.sources.add(ga);
    inByModule.set(gb, hub);
  }
  const interactions: ModuleEdge[] = [...cross.entries()]
    .map(([k, count]) => { const [from, to] = k.split("\u0000"); return { from: from!, to: to!, count }; })
    .sort((a, b) => b.count - a.count || (a.from + a.to).localeCompare(b.from + b.to))
    .slice(0, maxEdges);
  const hubs: HubInfo[] = [...inByModule.entries()]
    .map(([module, v]) => ({ module, sourceModules: v.sources.size, inEdges: v.edges }))
    .sort((a, b) => b.inEdges - a.inEdges || b.sourceModules - a.sourceModules)
    .slice(0, 6);
  const testLinks: TestLink[] = [...testFace.entries()]
    .map(([module, v]) => ({ module, edges: v.edges, testFiles: v.files.size }))
    .sort((a, b) => b.edges - a.edges)
    .slice(0, 8);

  return {
    modules,
    interactions,
    hubs,
    testLinks,
    groupingNote: "分组=目录(根文件自成组;modules/tests/packages/apps/cmd/src/internal 摊二级;小目录并入 (misc))——启发式,非包语义",
  };
}

/** 索引边 to(id=file#sym)取文件段。 */
function targetFileOf(id: string): string {
  const hash = id.lastIndexOf("#");
  return hash >= 0 ? id.slice(0, hash) : id;
}

/** 人类面渲染。graph=true 追加 mermaid 架构图(节点=Top 模块,边标调用数)。 */
export function renderModuleView(v: ModuleView, opts: { maxLines?: number; graph?: boolean } = {}): string {
  const maxLines = opts.maxLines ?? 16;
  const lines: string[] = [];
  lines.push(`模块视图(${v.modules.length} 组 · ${v.groupingNote})`);
  lines.push("");
  lines.push("模块清单(按文件数):");
  for (const m of v.modules.slice(0, 12)) {
    lines.push(`  ${m.name} ×${m.files}${m.langs.length > 0 ? ` [${m.langs.join(" ")}]` : ""}`);
  }
  if (v.modules.length > 12) lines.push(`  …还有 ${v.modules.length - 12} 组(--json 全量)`);
  lines.push("");
  if (v.interactions.length === 0) {
    lines.push("交互主干: 无跨模块调用边(纯独立模块/索引未覆盖调用形态)");
  } else {
    lines.push(`交互主干(A → B = A 调用 B,边数降序 Top ${Math.min(maxLines, v.interactions.length)}):`);
    for (const e of v.interactions.slice(0, maxLines)) {
      lines.push(`  ${e.from} → ${e.to} ×${e.count}`);
    }
    if (v.interactions.length > maxLines) lines.push(`  …还有 ${v.interactions.length - maxLines} 条(--json 全量)`);
  }
  if (v.hubs.length > 0) {
    lines.push("");
    lines.push("枢纽(被依赖最多):");
    for (const h of v.hubs) lines.push(`  ${h.module} — 被 ${h.sourceModules} 个模块调用(入边 ${h.inEdges})`);
  }
  if (v.testLinks.length > 0) {
    lines.push("");
    lines.push("测试面(tests 组对各模块的调用):");
    for (const t of v.testLinks) lines.push(`  tests → ${t.module} ×${t.edges}(${t.testFiles} 个测试文件)`);
  }
  if (opts.graph) lines.push("\n" + mermaidModuleGraph(v));
  return lines.join("\n");
}

/** mermaid 架构图:Top 模块节点 + Top 交互边(带 ×N 标签);节点名清洗防语法冲突。 */
export function mermaidModuleGraph(v: ModuleView, maxNodes = 16, maxEdges = 32): string {
  const nodeSet = new Set<string>();
  for (const e of v.interactions.slice(0, maxEdges)) { nodeSet.add(e.from); nodeSet.add(e.to); }
  for (const m of v.modules.slice(0, maxNodes)) nodeSet.add(m.name);
  const nodes = [...nodeSet].slice(0, Math.max(maxNodes, nodeSet.size > maxNodes ? maxNodes : nodeSet.size));
  const idOf = new Map(nodes.map((n, i) => [n, `m${i}`]));
  const esc = (s: string): string => s.replace(/[^\w.\-/\u4e00-\u9fff]/g, "_");
  const out: string[] = ["graph LR"];
  for (const n of nodes) out.push(`  ${idOf.get(n)}["${esc(n)}"]`);
  for (const e of v.interactions.slice(0, maxEdges)) {
    const a = idOf.get(e.from);
    const b = idOf.get(e.to);
    if (a && b) out.push(`  ${a} -->|×${e.count}| ${b}`);
  }
  return out.join("\n");
}
