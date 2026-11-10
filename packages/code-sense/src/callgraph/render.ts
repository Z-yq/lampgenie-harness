/**
 * 调用链→mermaid 关系图(designs/16 §6.1 code2flow 形态,面向人)。
 * 分工(designs/16 §9):图给人看,结构化数据给 LLM——本模块只产图,不承担信息完整性
 * (完整性在 callchain.edges 与 evidence,裁剪只影响图不影响数据)。
 * 节点 id 用 nd0..(与面板下钻 map 对齐);上限 34 节点/48 边(§10 mermaid 可读上限,
 * 超限按离圆心近者优先——edges 本身是 BFS 序,nearest-first)。
 */
import type { FlowEdge } from "./engine";

export interface CallchainDiagram {
  mermaid: string;
  /** nd-id → 符号显示名(面板点节点下钻用;未解析目标名也在此)。 */
  nodes: { id: string; name: string }[];
  nodeCount: number;
  edgeCount: number;
  truncated: boolean;
}

const MAX_NODES = 34;
const MAX_EDGES = 48;

/** HTML 实体转义(标签进 mermaid 后由 mermaid 再渲染一层 HTML,注入面在此封死)。 */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** 相对路径取末三段(apps/gateway/src/app.ts → gateway/src/app.ts)——两段在 monorepo 里歧义过多。 */
function shortPath(p: string): string {
  const segs = p.split("/");
  return segs.length <= 3 ? p : segs.slice(-3).join("/");
}

/** id 形如 path#Container.name → 显示名取 # 后整段。 */
function nameOfId(id: string): string {
  const i = id.lastIndexOf("#");
  return i >= 0 ? id.slice(i + 1) : id;
}

function fileOfId(id: string): string {
  const i = id.lastIndexOf("#");
  return i >= 0 ? id.slice(0, i) : "";
}

export function callchainMermaid(cc: {
  center: { name: string; id: string; file: string; line: number };
  upstream: FlowEdge[];
  downstream: FlowEdge[];
}): CallchainDiagram {
  const nodeIds = new Map<string, string>(); // symbol-id/ext-key → nd id
  const nodeNames: { id: string; name: string }[] = [];
  const lines: string[] = ["flowchart TD"];
  const classedExt: string[] = [];
  let truncated = false;
  let edgeCount = 0;

  // File 分组收集(code2flow 形态对齐:质量审计 2026-10-13)——节点行登记在组里,组装时统一展开
  const fileGroups = new Map<string, string[]>(); // 目录 → 节点行
  const looseNodes: string[] = [];                // 无 file 的节点行(未解析目标等)
  const registeredNodeLines = new Set<string>();  // 已入组的行(防 lines 混入)

  const register = (key: string, name: string, file: string, line?: number, ext = false): string | null => {
    const existing = nodeIds.get(key);
    if (existing) return existing;
    if (nodeIds.size >= MAX_NODES) { truncated = true; return null; }
    const nd = `nd${nodeIds.size}`;
    nodeIds.set(key, nd);
    nodeNames.push({ id: nd, name });
    const where = file ? (line && line > 0 ? `${shortPath(file)}:${line}` : shortPath(file)) : "";
    const nodeLine = `  ${nd}["${esc(name)}${where ? "<br/>" + esc(where) : ""}"]`;
    if (file) {
      const grp = shortPath(file).split("/").slice(0, -1).join("/") || ".";
      if (!fileGroups.has(grp)) fileGroups.set(grp, []);
      fileGroups.get(grp)!.push(nodeLine);
    } else {
      looseNodes.push(nodeLine);
    }
    registeredNodeLines.add(nodeLine);
    if (ext) classedExt.push(nd);
    return nd;
  };

  register(cc.center.id, cc.center.name, cc.center.file, cc.center.line);

  const emit = (e: FlowEdge): void => {
    if (edgeCount >= MAX_EDGES) { truncated = true; return; }
    const from = register(e.from, nameOfId(e.from), fileOfId(e.from));
    if (!from) return;
    // 未解析目标(动态分派/复杂 import 形态):虚线节点,如实不冒充
    const ext = !e.to;
    const key = e.to || `ext:${e.from}@${e.line}:${e.toName ?? "?"}`;
    const name = e.to ? nameOfId(e.to) : (e.toName ?? "(未解析)");
    const to = register(key, name, e.to ? fileOfId(e.to) : "", undefined, ext);
    if (!to) return;
    const label = e.line > 0 ? `|L${e.line}|` : "";
    lines.push(ext ? `  ${from} -.->${label} ${to}` : `  ${from} -->${label} ${to}`);
    edgeCount++;
  };

  // 两侧轮转注入,保证圆心近邻优先上图(两列表各自 BFS 序)
  const ds = cc.downstream;
  const us = cc.upstream;
  for (let i = 0; i < Math.max(ds.length, us.length); i++) {
    if (i < ds.length) emit(ds[i]!);
    if (i < us.length) emit(us[i]!);
  }

  // 组装:File 子图在前(多文件时),loose 节点随后;边已在 lines(边引用节点无需先声明,mermaid 允许)
  {
    const edgeLines = lines.slice(1); // 去掉 flowchart TD 头
    const out: string[] = ["flowchart TD"];
    for (const l of looseNodes) out.push(l);
    let fi = 0;
    for (const [grp, groupLines] of fileGroups) {
      out.push(`  subgraph sg${fi++}["File: ${grp}"]`);
      out.push(...groupLines);
      out.push("  end");
    }
    out.push(...edgeLines);
    lines.length = 0;
    lines.push(...out);
  }
  lines.push("  classDef ctr fill:#c98f45,stroke:#ece1d1,color:#0b0806,font-weight:bold;");
  if (classedExt.length > 0) {
    lines.push("  classDef ext fill:#241708,stroke:#8a6a3a,stroke-dasharray:3 3,color:#c7b8a4;");
    lines.push(`  class ${classedExt.join(",")} ext;`);
  }
  lines.push("  class nd0 ctr;");

  return {
    mermaid: lines.join("\n"),
    nodes: nodeNames,
    nodeCount: nodeNames.length,
    edgeCount,
    truncated,
  };
}
