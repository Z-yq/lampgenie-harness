/**
 * browser 工具的 ref 选择面(纯函数模块,无 playwright 依赖,可单测):
 * ref 分配、ref→selector 解析、快照 URL 过期判定集中在此,browser-tool.ts 只做编排。
 * 形态来源: ZCode/packages/shared/src/browser-use/snapshot.ts(ref 为按 DOM 序分配的稳定引用 e1, e2, ...)
 * 形态来源: ZCode/apps/zcode-cli/packages/core/src/browser-client/playwright.ts(导航后旧 ref 失效,必须重新快照)
 */

export type RefEntry = { selector: string; name?: string };

export type RefLookup =
  | { ok: true; selector: string; name?: string }
  | { ok: false; error: string };

const REF_RE = /^e(\d+)$/i;

/** "e3" / "E3" → "e3";纯数字 "3" → "e3";其它原样(交给上层报未知 ref)。 */
export function normalizeRef(ref: string): string {
  const t = String(ref ?? "").trim();
  if (!t) return "";
  if (REF_RE.test(t)) return t.toLowerCase();
  if (/^\d+$/.test(t)) return "e" + t;
  return t;
}

/**
 * "e3,e5" / "e3 e5" / ["e3","e5"] → ["e3","e5"]:去重保序、丢空。
 * 多 ref 语法目前只作未来扩展口(resolveRef 仍只解单个,避免拼 nth 选择器产生假定位)。
 */
export function splitRefs(input: string | string[]): string[] {
  const raw = Array.isArray(input) ? input : String(input ?? "").split(/[,\s]+/);
  const out: string[] = [];
  for (const item of raw) {
    const n = normalizeRef(item);
    if (!n || out.includes(n)) continue;
    out.push(n);
  }
  return out;
}

/**
 * 单 ref 解析:支持 "e3" 与纯数字 "3";数组形态按 DOM 序取下标(e<n> → elements[n-1])。
 * 多 ref(如 "e3,e5")直接 ok=false:act/操作都是单目标,拼选择器只会得到错误定位。
 */
export function resolveRef(refs: Map<string, RefEntry> | RefEntry[], ref: string): RefLookup {
  const tokens = splitRefs(ref);
  if (!tokens.length) return { ok: false, error: "ref 为空:请先 action=snapshot 拿到 e1..eN 清单再操作" };
  if (tokens.length > 1) {
    return {
      ok: false,
      error: `多 ref「${String(ref ?? "").trim()}」不支持:一次只解一个 ref,多目标请逐个操作`,
    };
  }
  const key = tokens[0]!;
  const index = Number(key.slice(1)) - 1;
  const entry = refs instanceof Map ? refs.get(key) : refs[index];
  if (!entry || !entry.selector) {
    return { ok: false, error: `未知 ref「${key}」。请先 action=snapshot 拿到 e1..eN 清单再 act` };
  }
  return entry.name ? { ok: true, selector: entry.selector, name: entry.name } : { ok: true, selector: entry.selector };
}

/**
 * 快照过期判定(对齐 ZCode:导航后 ref 失效):URL 不同即过期;
 * 从未快照过(undefined/空串)也按过期处理——没有 ref 清单就不该按 ref 操作。
 */
export function refsStale(snapshotUrl: string | undefined, currentUrl: string): boolean {
  if (!snapshotUrl) return true;
  return snapshotUrl !== currentUrl;
}

/** 按 DOM 序生成 e1..eN;selector 为空的元素不可定位,跳过且不占号。 */
export function buildRefMap(elements: Array<{ selector: string; name?: string }>): Map<string, RefEntry> {
  const map = new Map<string, RefEntry>();
  let n = 0;
  for (const el of elements) {
    const selector = String(el?.selector ?? "").trim();
    if (!selector) continue;
    n += 1;
    map.set("e" + n, el.name ? { selector, name: el.name } : { selector });
  }
  return map;
}
