/**
 * @ 文件提及索引(ZCode fileMentionProvider 移植):
 * 激活项目根的确定性文件清单(排除依赖/产物/参考仓,二进制后缀),TTL 缓存;
 * 子串过滤+basename 优先排序。零依赖步行,不猜语义。
 * :walk 是同步的,9p/网络盘上全仓可达分钟级,曾把 gateway 事件循环
 * 卡死(连接预热+首查都走这里,面板 HTTP/WS 全停)。加时间预算:预算内尽量走,
 * 超预算=部分结果+短 TTL(后续调用继续长全);完整语义不变,最坏同步阻塞≈单预算。
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "ref", "vendor", ".genie", "devlog", "coverage", ".zcode", ".agents"]);
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|mp4|mp3|wav|woff2?|ttf|eot|so|dylib|dll|exe|bin|wasm|mjs\.map|js\.map)$/i;
const MAX_FILES = 4000;
const TTL_MS = 10_000;
/** 预算截断的缓存存活:短 TTL,随后续调用继续补全(不是终态)。 */
const PARTIAL_TTL_MS = 2_500;
/** 单次同步 walk 的时间预算;GENIE_FILEINDEX_BUDGET_MS 可覆盖(0=只列根一层)。 */
const WALK_BUDGET_MS = 2_000;

interface CacheEntry {
  at: number;
  root: string;
  files: string[];
  /** 预算截断的部分结果(短 TTL;与 MAX_FILES 满载区分)。 */
  partial?: boolean;
}

let cache: CacheEntry | null = null;
let walkPartial = false;

function walk(root: string, dir: string, out: string[], depth: number, deadline: number): void {
  if (out.length >= MAX_FILES || depth > 8) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries.sort()) {
    if (out.length >= MAX_FILES) return;
    if (Date.now() > deadline) {
      walkPartial = true; // 预算尽:停在当前目录,余量交给下次调用
      return;
    }
    if (name.startsWith(".") && name !== ".github") continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(root, p, out, depth + 1, deadline);
    } else if (st.isFile() && !BINARY_EXT.test(name) && st.size < 2_000_000) {
      out.push(relative(root, p));
    }
  }
}

export function fileIndex(root: string, budgetMs?: number): string[] {
  const now = Date.now();
  if (cache && cache.root === root && now - cache.at < (cache.partial ? PARTIAL_TTL_MS : TTL_MS)) return cache.files;
  // 预算解析:显式参数 > 环境变量(允许 0)> 缺省;0=合法(只列根一层即截断)
  const rawEnv = process.env.GENIE_FILEINDEX_BUDGET_MS;
  const envBudget = rawEnv !== undefined && rawEnv !== "" && Number.isFinite(Number(rawEnv)) ? Number(rawEnv) : undefined;
  const budget = budgetMs ?? envBudget ?? WALK_BUDGET_MS;
  const files: string[] = [];
  walkPartial = false;
  walk(root, root, files, 0, now + budget);
  cache = { at: now, root, files, partial: walkPartial || undefined };
  return files;
}

/** 测试/运维缝隙:清缓存(预算截断的短 TTL 缓存不应污染断言与热更场景)。 */
export function fileIndexReset(): void {
  cache = null;
}

/** 子串过滤:basename 命中优先于路径命中;限定条数。 */
export function searchFiles(root: string, query: string, limit = 12): string[] {
  const files = fileIndex(root);
  const q = query.trim().toLowerCase();
  if (!q) return files.slice(0, limit);
  const hits = files.filter((f) => f.toLowerCase().includes(q));
  hits.sort((a, b) => {
    const ba = a.split("/").pop()!.toLowerCase().includes(q) ? 0 : 1;
    const bb = b.split("/").pop()!.toLowerCase().includes(q) ? 0 : 1;
    if (ba !== bb) return ba - bb;
    return a.length - b.length;
  });
  return hits.slice(0, limit);
}
