/**
 * CFG × 静态索引(2026-10-27):给函数说明补「上游调用方 / 下游被调方」。
 *
 * 与 sensing/cfg 的分工:cfg 只读语法树(不依赖索引);本模块把索引里的调用边贴回
 * CfgDescription.callers/callees。索引缺席/同名多处=按文件+最近行号选,失败就留空
 * (页面显示「索引未提供」,不编造)。
 */
import type { C2fIndex, C2fNode } from "../callgraph/c2f";
import type { CfgCallRef, CfgFunction } from "./cfg";

function findIndexNode(index: C2fIndex, fn: CfgFunction, byId: Map<string, C2fNode>): C2fNode | undefined {
  const short = fn.name.split(".").pop() ?? fn.name;
  const ids = new Set([...(index.byName[fn.name] ?? []), ...(index.byName[short] ?? [])]);
  let best: C2fNode | undefined;
  for (const id of ids) {
    const n = byId.get(id);
    if (!n || n.file !== fn.file) continue;
    if (n.line === fn.line) return n;
    if (!best || Math.abs(n.line - fn.line) < Math.abs(best.line - fn.line)) best = n;
  }
  if (best) return best;
  // 旧索引/限定名变体:按文件内同名兜底
  for (const id of index.byFile[fn.file] ?? []) {
    const n = byId.get(id);
    if (!n) continue;
    if (n.name === fn.name || n.name === short || n.name.endsWith(`.${short}`)) {
      if (!best || Math.abs(n.line - fn.line) < Math.abs(best.line - fn.line)) best = n;
    }
  }
  return best;
}

/** 把索引里的直接调用方/被调方贴到 fn.description(原地修改;每侧最多 6 条)。 */
export function attachCfgContext(fn: CfgFunction, index: C2fIndex, byId?: Map<string, C2fNode>): void {
  const nodes = byId ?? new Map(index.nodes.map((n) => [n.id, n]));
  const node = findIndexNode(index, fn, nodes);
  if (!node) return;
  const callers: CfgCallRef[] = [];
  const callees: CfgCallRef[] = [];
  for (const e of index.edges) {
    if (e.to === node.id) {
      const n = nodes.get(e.from);
      if (n) callers.push({ name: n.name, file: n.file, line: n.line });
    }
    if (e.from === node.id) {
      const n = nodes.get(e.to);
      if (n) callees.push({ name: n.name, file: n.file, line: n.line });
    }
  }
  const dedupe = (xs: CfgCallRef[]): CfgCallRef[] => {
    const m = new Map<string, CfgCallRef>();
    for (const x of xs) m.set(`${x.file ?? ""}:${x.line ?? 0}:${x.name}`, x);
    return [...m.values()].filter((x) => !(x.file === fn.file && x.line === fn.line && x.name === fn.name));
  };
  fn.description.callers = dedupe(callers).slice(0, 6);
  fn.description.callees = dedupe(callees).slice(0, 6);
}
