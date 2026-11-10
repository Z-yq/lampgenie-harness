/**
 * 白板关系推导的「符号调用」解析器(设计板节点 n4 的接线件)。
 * 性能改造( perf 板):
 * - 索引缓存从 60s TTL 改为 **index.json mtime+size 短路**:索引未变时连续 upsert 不再重复 parse
 *   几十 MB JSON(只 stat 一次);索引变更后下一次调用即重新加载(不误缓存)。
 * - callees 查询从「每符号 querySymbol 全边扫描」改为 **一次性 from→callees Map**:O(E) 建图,
 *   查询 O(byName ids × 出度);5× 相对门由 bench.mjs 对拍旧 querySymbol 路径。
 * - 保留原有语义:索引不在场/查不到 → null/undefined,不猜、不按命名相似度编边。
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { indexDir, loadIndex } from "@lampgenie/code-sense/callgraph/c2f";

interface CacheEntry {
  at: number;
  /** null=该根目录当前无索引(缓存「没有」这个事实) */
  index: ReturnType<typeof loadIndex>;
  mtimeMs: number;
  size: number;
  /** index.json 实际 parse 次数(诊断/bench;mtime 未变时不增) */
  parseCalls: number;
  /** from 符号 id → 直接 callee 符号名列表(首次查询时 O(E) 建图) */
  calleesByFrom?: Map<string, string[]>;
}

const cache = new Map<string, CacheEntry>();

/** 测试/bench 用:清空缓存(避免用例间互相污染)。 */
export function clearDeriveIndexCache(): void {
  cache.clear();
}

/** 诊断:本根目录索引缓存 stats(parse_calls 用于 mtime 短路门)。 */
export function deriveIndexStats(root: string): { parseCalls: number; mtimeMs: number; size: number; hasIndex: boolean } {
  const e = cache.get(root);
  return { parseCalls: e?.parseCalls ?? 0, mtimeMs: e?.mtimeMs ?? -1, size: e?.size ?? -1, hasIndex: !!e?.index };
}

function statIndex(root: string): { mtimeMs: number; size: number; exists: boolean } {
  try {
    const st = statSync(join(indexDir(root), "index.json"));
    return { mtimeMs: st.mtimeMs, size: st.size, exists: true };
  } catch {
    return { mtimeMs: -1, size: -1, exists: false };
  }
}

function getEntry(root: string): CacheEntry {
  const st = statIndex(root);
  const hit = cache.get(root);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  let index: ReturnType<typeof loadIndex> = null;
  let parseCalls = hit?.parseCalls ?? 0;
  if (st.exists) {
    try { index = loadIndex(root); } catch { index = null; }
    parseCalls++;
  }
  const entry: CacheEntry = { at: Date.now(), index, mtimeMs: st.mtimeMs, size: st.size, parseCalls };
  cache.set(root, entry);
  return entry;
}

/** from 符号 id → callee 名(一次性建图;与 querySymbol 的 callees 语义一致:
 * 按调用方 id 去重、返回 callee 的 **符号名**——索引里的 e.to 是节点 id,
 * 若原样返回 id 会让 R3 的 targets 名字匹配全部落空(静默退化为 R4)。 */
function ensureCallees(entry: CacheEntry): Map<string, string[]> {
  if (entry.calleesByFrom) return entry.calleesByFrom;
  const nameById = new Map<string, string>();
  for (const n of entry.index?.nodes ?? []) nameById.set(n.id, n.name);
  const calleeIdSeen = new Map<string, Set<string>>();
  const map = new Map<string, string[]>();
  for (const e of entry.index?.edges ?? []) {
    if (!e.from || !e.to) continue;
    let seen = calleeIdSeen.get(e.from);
    if (!seen) { seen = new Set(); calleeIdSeen.set(e.from, seen); }
    if (seen.has(e.to)) continue; // 与 querySymbol 的 seenCallees 同语义(按 callee id 去重)
    seen.add(e.to);
    const hash = e.to.lastIndexOf("#");
    const name = nameById.get(e.to) ?? (hash >= 0 ? e.to.slice(hash + 1) : e.to);
    const arr = map.get(e.from);
    if (arr) { if (!arr.includes(name)) arr.push(name); }
    else map.set(e.from, [name]);
  }
  entry.calleesByFrom = map;
  return map;
}

/**
 * 构造 calleesOf 解析器。索引不可用返回 undefined(约定:调用方不要再传空 resolver 假装可用)。
 * @param root 索引根(通常=项目工作目录)
 */
export function makeCalleesResolver(root: string): ((symbol: string) => string[] | null) | undefined {
  if (!root) return undefined;
  const entry = getEntry(root);
  if (!entry.index) return undefined;
  const byName = entry.index.byName;
  const calleesByFrom = ensureCallees(entry);
  return (symbol: string): string[] | null => {
    const ids = Object.hasOwn(byName, symbol) ? byName[symbol] ?? [] : [];
    if (ids.length === 0) return null;
    const out: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      for (const name of calleesByFrom.get(id) ?? []) {
        if (seen.has(name)) continue;
        seen.add(name);
        out.push(name);
      }
    }
    return out.length ? out : null;
  };
}
