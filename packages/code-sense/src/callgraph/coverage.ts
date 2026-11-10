/**
 * 语言覆盖报告(step-067 fail-visible 三面之一,承 step-065 B1):
 * 「磁盘源文件数 / 有索引符号文件数」按扩展名分列——磁盘口径=engine listSourceFiles 同一扫描
 * (扩展名/跳过目录/上限一致,杜绝两处口径漂移)。
 * 消费面:① index manifest(C2fIndex.coverage,构建期落盘);② doctor 覆盖率核对;
 * ③ entrypoints 零覆盖/低覆盖显式状态。旧索引无 manifest 字段=查询面现场重算(不假绿、可降级)。
 */
import { listSourceFilesDetailed, GRAPH_SOURCE_EXT, GRAPH_SKIP_DIRS } from "./engine";
import { readdirSync } from "node:fs";
import { join } from "node:path";

/** C/C++ 扩展名(与 engine GRAPH_STRUCT_EXT 注册清单、adapters/cpp.ts CPP_EXTS 同一口径;
 * 三处字面量保持一致是登记过的耦合,改动须同步)。 */
export const C_CPP_EXTS = new Set([".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"]);

/** step-084 RC-H:已知编程语言扩展名中未被任何 adapter 覆盖的部分——磁盘存在即必须
 * 显式告警(此前纯 Rust/C#/Ruby/PHP 仓 totalDisk=0,doctor「磁盘无源文件」+「通过」假绿,
 * audit 2026-10-16 实锤)。与 engine 扫描口径解耦:本清单只服务覆盖报告,不改变索引行为。
 * 2026-10-25:Rust/C#/Ruby/PHP 已接入结构 adapter(engine GRAPH_STRUCT_EXT),移出本清单——
 * 留着会把已索引文件重复算成「不支持语言」。 */
export const KNOWN_UNSUPPORTED_EXTS = new Set([
  ".lua", ".kt", ".kts", ".swift", ".scala",
  ".pl", ".pm", ".ex", ".exs", ".erl", ".hrl", ".hs", ".dart", ".zig", ".nim",
  ".jl", ".r", ".R", ".groovy", ".clj", ".cljs", ".elm", ".ml", ".mli", ".fs", ".vb", ".vue", ".svelte",
]);

/** 磁盘上已知但不支持语言的文件计数(独立 walk:跳目录/深度与 engine 扫描同口径;
 * 只计数不存路径——分母口径,不做索引行为)。cap 防病态仓(CAP 命中即停,计数如实截断标记)。 */
const UNSUPPORTED_WALK_CAP = 200_000;
export async function unsupportedCodeFileCount(root: string): Promise<{ byExt: Map<string, number>; capped: boolean }> {
  const { readdir } = await import("node:fs/promises");
  const byExt = new Map<string, number>();
  let seen = 0;
  let capped = false;
  async function walk(dir: string, depth: number): Promise<void> {
    if (capped || depth > 12) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (capped) return;
      if (e.name.startsWith(".")) continue;
      if (SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else {
        const ext = e.name.slice(e.name.lastIndexOf("."));
        if (KNOWN_UNSUPPORTED_EXTS.has(ext)) {
          byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
          if (++seen >= UNSUPPORTED_WALK_CAP) capped = true;
        }
      }
    }
  }
  await walk(root, 0);
  return { byExt, capped };
}

/** 分层覆盖逐文件 outcome(step-079,designs/25 §1):full=结构档提取到符号/lexical=词法兜底
 * 档/empty=解析成功确认无声明/skipped=跳过(必须带原因)。coverage=(full+lexical+empty)/磁盘源文件数。 */
export type FileOutcome = { tier: "full" | "lexical" | "empty" | "skipped"; reason?: string };

export interface ExtCoverage {
  /** 磁盘源文件数(engine 扫描口径)。 */
  diskFiles: number;
  /** 其中产出 ≥1 个索引符号的文件数(legacy 口径,恒=full+lexical 当分层数据在场)。 */
  indexedFiles: number;
  /** step-079 分层计数(可选:旧索引/无 outcome 扩展名无此字段=legacy 语义)。 */
  full?: number;
  lexical?: number;
  empty?: number;
  skipped?: number;
  /** step-084 RC-H:该扩展名属已知编程语言但无 adapter 覆盖(索引侧整体 skipped)。 */
  unsupported?: boolean;
}

export interface LanguageCoverage {
  /** 键=扩展名(带点,如 ".h")。 */
  byExt: Record<string, ExtCoverage>;
  totalDisk: number;
  totalIndexed: number;
  /** step-079 分层口径(可选字段,旧索引无=查询侧 legacy 语义):
   * totalCovered=Σ(full+lexical+empty),layeredDisk=分层适用扩展名的磁盘数,
   * coveragePct=totalCovered/layeredDisk×100。skippedReasons=跳过逐文件原因(capped 50,
   * 计数不受 cap 影响);truncated=上限/RSS 护栏截断登记;layeredScope=full(全量重建)/
   * partial(增量轮仅重扫文件有 outcome,分层数据缺,退 legacy)。 */
  totalCovered?: number;
  layeredDisk?: number;
  coveragePct?: number;
  skippedReasons?: Record<string, string>;
  truncated?: { reason: string; limit?: number };
  layeredScope?: "full" | "partial";
  /** step-084 RC-H:已知编程语言但不被任何 adapter 覆盖的扩展名 → 文件数
   * (与 byExt 的 unsupported 行同源冗余,便于单字段消费)。 */
  unsupportedByExt?: Record<string, number>;
  /** 2026-11-08 全覆盖:文件级去向汇总(仅新索引;scanned=indexed+symbolLess+skipped+error)。
   * 让「1019/1110」这种按符号计的分母能把「其余文件去哪了」一次说清。 */
  fileStatus?: { scanned: number; indexed: number; symbolLess: number; skipped: number; error: number };
}

/** skippedReasons 逐文件登记上限(超出部分只计总数,不逐列——防病态仓撑爆 manifest)。 */
const SKIPPED_REASON_CAP = 50;

/** 磁盘文件按扩展名分组计数(engine 扫描同口径;截断元数据如实透出)。 */
export async function diskFileCountByExt(root: string): Promise<{ byExt: Map<string, number>; truncated?: { reason: string; limit?: number } }> {
  const scan = await listSourceFilesDetailed(root);
  const byExt = new Map<string, number>();
  for (const f of scan.files) {
    const ext = f.slice(f.lastIndexOf("."));
    byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
  }
  return { byExt, truncated: scan.truncated ? { reason: `扫描达文件上限 ${scan.limit},磁盘计数可能不完整`, limit: scan.limit } : undefined };
}

/**
 * 覆盖报告:indexedFiles = 有 ≥1 符号的文件(传 index.byFile 的键,相对路径)。
 * 按扩展名分列;索引中没有的扩展名但磁盘有 → indexedFiles=0(fail-visible 的核心数据)。
 * step-079 分层(opts.outcomes 在场时):full/lexical/empty/skipped 分档计数、
 * skippedReasons 逐文件(capped 50)、coveragePct=(full+lexical+empty)/分层适用磁盘数;
 * 无 outcome 的扩展名(ts/js 语义档,其「0 符号」不可判 empty=RC-C)不进分层口径。
 */
export async function computeLanguageCoverage(
  root: string,
  indexedRelFiles: Iterable<string>,
  opts: { outcomes?: Map<string, FileOutcome>; truncated?: { reason: string; limit?: number }; layeredScope?: "full" | "partial" } = {},
): Promise<LanguageCoverage> {
  const disk = await diskFileCountByExt(root);
  const indexed = new Map<string, number>();
  for (const rel of indexedRelFiles) {
    const ext = rel.slice(rel.lastIndexOf("."));
    indexed.set(ext, (indexed.get(ext) ?? 0) + 1);
  }
  // 分层计数:按 outcome.tier 聚到扩展名;skippedReasons 逐文件(capped)
  const layered = new Map<string, { full: number; lexical: number; empty: number; skipped: number }>();
  const skippedReasons: Record<string, string> = {};
  let skippedTotal = 0;
  if (opts.outcomes) {
    for (const [rel, o] of opts.outcomes) {
      const ext = rel.slice(rel.lastIndexOf("."));
      const agg = layered.get(ext) ?? { full: 0, lexical: 0, empty: 0, skipped: 0 };
      agg[o.tier]++;
      layered.set(ext, agg);
      if (o.tier === "skipped") {
        skippedTotal++;
        if (Object.keys(skippedReasons).length < SKIPPED_REASON_CAP) skippedReasons[rel] = o.reason ?? "未知原因";
      }
    }
  }
  const byExt: Record<string, ExtCoverage> = {};
  let totalDisk = 0;
  let totalIndexed = 0;
  let totalCovered = 0;
  let layeredDisk = 0;
  for (const [ext, n] of disk.byExt) {
    const idx = indexed.get(ext) ?? 0;
    const lay = layered.get(ext);
    byExt[ext] = {
      diskFiles: n,
      indexedFiles: idx,
      ...(lay ? { full: lay.full, lexical: lay.lexical, empty: lay.empty, skipped: lay.skipped } : {}),
    };
    totalDisk += n;
    totalIndexed += idx;
    if (lay) {
      layeredDisk += n;
      totalCovered += lay.full + lay.lexical + lay.empty;
    }
  }
  // step-084 RC-H:已知但不支持的语言——磁盘计数如实进报告(0 索引 + 整档 skipped +
  // 分层分母计入,coveragePct 如实下降);adapter 永不为这些扩展名产 outcome,合成聚合档。
  // 索引行为不变(不索引不扫描),改变的只是覆盖报告的诚实度。
  const unsupportedByExt: Record<string, number> = {};
  const unsup = await unsupportedCodeFileCount(root);
  for (const [ext, n] of unsup.byExt) {
    unsupportedByExt[ext] = n;
    const lay = layered.get(ext);
    byExt[ext] = {
      diskFiles: n,
      indexedFiles: 0,
      skipped: n,
      unsupported: true,
      ...(lay ? { full: lay.full, lexical: lay.lexical, empty: lay.empty } : {}),
    };
    totalDisk += n;
    layeredDisk += n;
    // totalCovered 不加:不支持语言 covered=0(coveragePct 分母如实含之)
  }
  // 索引里有而磁盘扫描没有的扩展名(扫描间新增/上限截断):如实并列,避免「总和不一致」观感
  for (const [ext, n] of indexed) {
    if (!byExt[ext]) byExt[ext] = { diskFiles: 0, indexedFiles: n };
  }
  // truncation 登记:上限截断 / RSS 护栏 / skipped 原因明细截取(优先级:显式传入 > skipped cap 提示)
  let truncated = opts.truncated;
  if (unsup.capped) {
    const capNote = `不支持语言文件计数达上限 ${UNSUPPORTED_WALK_CAP}(计数可能不完整)`;
    truncated = { reason: truncated ? `${truncated.reason};${capNote}` : capNote };
  }
  if (opts.outcomes && skippedTotal > SKIPPED_REASON_CAP) {
    const capNote = `${skippedTotal} 个文件跳过(原因明细截取前 ${SKIPPED_REASON_CAP} 条)`;
    truncated = { reason: opts.truncated ? `${capNote};${opts.truncated.reason}` : capNote, ...(opts.truncated?.limit ? { limit: opts.truncated.limit } : {}) };
  }
  return {
    byExt,
    totalDisk,
    totalIndexed,
    ...(Object.keys(unsupportedByExt).length > 0 ? { unsupportedByExt } : {}),
    ...(opts.outcomes ? {
      totalCovered,
      layeredDisk,
      coveragePct: layeredDisk > 0 ? Math.round((totalCovered / layeredDisk) * 1000) / 10 : undefined,
      skippedReasons,
      ...(opts.layeredScope ? { layeredScope: opts.layeredScope } : {}),
    } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

// ---- 查询路径缓存(fpCache 同款 TTL:entrypoints/doctor 每查询现场重算会重复全仓 readdir) ----
const covCache = new Map<string, { at: number; cov: LanguageCoverage }>();
const COV_TTL_MS = 10_000;

/** 带缓存的覆盖计算(索引未提供 manifest 字段时的现场降级路径)。 */
export async function languageCoverageCached(root: string, indexedRelFiles: Iterable<string>): Promise<LanguageCoverage> {
  const hit = covCache.get(root);
  if (hit && Date.now() - hit.at < COV_TTL_MS) return hit.cov;
  const cov = await computeLanguageCoverage(root, indexedRelFiles);
  covCache.set(root, { at: Date.now(), cov });
  return cov;
}

/** 同步版(MCP dispatchTool 是同步分派,不能 await):walkFingerprintSync 同款阻塞 walk,
 * TTL 缓存共享(异步版填充的缓存同步版直接命中)。 */
export function languageCoverageCachedSync(root: string, indexedRelFiles: Iterable<string>): LanguageCoverage {
  const hit = covCache.get(root);
  if (hit && Date.now() - hit.at < COV_TTL_MS) return hit.cov;
  // 同步枚举:镜像 engine listSourceFiles 的扩展名/跳过目录口径(深度上限同步对齐)
  const byDisk = new Map<string, number>();
  const unsupByDisk = new Map<string, number>();
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else {
        const ext = e.name.slice(e.name.lastIndexOf("."));
        if (GRAPH_SOURCE_EXT.has(ext)) { // 源扩展名过滤=engine 同口径(漏了会把 .md/.bin 全算成「零覆盖语言」)
          byDisk.set(ext, (byDisk.get(ext) ?? 0) + 1);
        } else if (KNOWN_UNSUPPORTED_EXTS.has(ext)) { // step-084 RC-H:不支持语言同步口径对齐
          unsupByDisk.set(ext, (unsupByDisk.get(ext) ?? 0) + 1);
        }
      }
    }
  }
  const indexed = new Map<string, number>();
  for (const rel of indexedRelFiles) {
    const ext = rel.slice(rel.lastIndexOf("."));
    indexed.set(ext, (indexed.get(ext) ?? 0) + 1);
  }
  const byExt: Record<string, { diskFiles: number; indexedFiles: number } & Partial<ExtCoverage>> = {};
  let totalDisk = 0;
  let totalIndexed = 0;
  const unsupportedByExt: Record<string, number> = {};
  for (const [ext, n] of byDisk) {
    byExt[ext] = { diskFiles: n, indexedFiles: indexed.get(ext) ?? 0 };
    totalDisk += n;
    totalIndexed += byExt[ext].indexedFiles;
  }
  for (const [ext, n] of unsupByDisk) {
    byExt[ext] = { diskFiles: n, indexedFiles: 0, skipped: n, unsupported: true };
    unsupportedByExt[ext] = n;
    totalDisk += n;
  }
  for (const [ext, n] of indexed) {
    if (!byExt[ext]) byExt[ext] = { diskFiles: 0, indexedFiles: n };
  }
  const cov: LanguageCoverage = {
    byExt,
    totalDisk,
    totalIndexed,
    ...(Object.keys(unsupportedByExt).length > 0 ? { unsupportedByExt } : {}),
  };
  covCache.set(root, { at: Date.now(), cov });
  return cov;
}

// engine GRAPH_SKIP_DIRS 单一真相(直接复用,不再抄清单)
const SKIP_DIRS = GRAPH_SKIP_DIRS;

/** 覆盖率判定(step-079 doctor/entrypoints 共用阈值):
 * - "zero":磁盘有文件、覆盖分子为 0——语言不适配或解析全失败(假绿根治对象);
 *   分层口径在场时分子=full+lexical+empty,否则=indexedFiles(legacy);
 * - "low":C/C++ 扩展覆盖 <0.5(解析降级/边界,如实告警;TS/Python 不套低覆盖阈,避免存量噪音);
 * - "ok":其余。 */
export function coverageVerdict(ext: string, c: ExtCoverage): "zero" | "low" | "ok" {
  const covered = c.full !== undefined || c.lexical !== undefined || c.empty !== undefined
    ? (c.full ?? 0) + (c.lexical ?? 0) + (c.empty ?? 0)
    : c.indexedFiles;
  if (c.diskFiles > 0 && covered === 0) return "zero";
  if (C_CPP_EXTS.has(ext) && c.diskFiles > 0 && covered / c.diskFiles < 0.5) return "low";
  return "ok";
}

/** 文本形态覆盖行(index/init/roots/doctor 共用):".c 6/6 · .cpp 7/7(磁盘→已索引)"。
 * 分层数据在场时附 coveragePct 与四档计数(step-079)。 */
export function formatCoverageLine(cov: LanguageCoverage | undefined): string | undefined {
  if (!cov) return undefined;
  const parts = Object.entries(cov.byExt)
    .sort((a, b) => b[1].diskFiles - a[1].diskFiles)
    .map(([ext, c]) => `${ext} ${c.indexedFiles}/${c.diskFiles}${c.unsupported ? "(不支持)" : ""}`);
  if (parts.length === 0) return undefined;
  let line = `${parts.join(" · ")}(已索引→磁盘)`;
  if (cov.coveragePct !== undefined) {
    const tier = Object.entries(cov.byExt).reduce(
      (acc, [, c]) => ({ full: acc.full + (c.full ?? 0), lexical: acc.lexical + (c.lexical ?? 0), empty: acc.empty + (c.empty ?? 0), skipped: acc.skipped + (c.skipped ?? 0) }),
      { full: 0, lexical: 0, empty: 0, skipped: 0 },
    );
    line += ` · 分层覆盖 ${cov.coveragePct}% [full ${tier.full} · lexical ${tier.lexical} · empty ${tier.empty} · skipped ${tier.skipped}]`;
    if (cov.truncated) line += ` · 截断: ${cov.truncated.reason}`;
  }
  if (cov.fileStatus) {
    const f = cov.fileStatus;
    line += ` · 文件去向 ${f.scanned}(有符号 ${f.indexed} / 无顶层声明 ${f.symbolLess} / 跳过 ${f.skipped} / 失败 ${f.error})`;
  }
  return line;
}

/** 不支持语言的诚实诊断文案(step-141 P0-2):查询侧此前对空索引统一说「已触发后台重建,
 * 稍后重试」——对 Lua/Kotlin/Swift 这类**无 adapter** 的仓,重试永远不会成功(实测
 * rust-ripgrep / php-guzzle / ruby-jekyll 三仓每次查询都刷这句;三语言 2026-10-25 已接入
 * adapter,不再是本清单成员)。doctor 侧已有诚实口径
 * (coverageWarnings 的「语言不支持(无 adapter)」),查询侧与之对齐:同一事实、同一措辞,
 * 并明确点破「重建无用」,不再许诺后台重建。 */
export function unsupportedLanguageText(cov: LanguageCoverage | undefined): string | undefined {
  const entries = Object.entries(cov?.unsupportedByExt ?? {});
  if (entries.length === 0) return undefined;
  const list = entries.sort((a, b) => b[1] - a[1]).slice(0, 8).map(([ext, n]) => `${ext} ${n} 个`).join(", ");
  return `语言不支持(无 adapter): ${list}——支持语言见 codesense --help(该语言不会被索引,重建也不会成功)`;
}

/** 同步口径(查 root 现算覆盖;MCP dispatchTool 是同步分派,不能 await)。 */
export function unsupportedLanguageTextSync(root: string, indexedRelFiles: Iterable<string>): string | undefined {
  return unsupportedLanguageText(languageCoverageCachedSync(root, indexedRelFiles));
}

/** 覆盖告警(zero/low 判定全扩展名过一遍;空数组=覆盖健康)。
 * fail-visible 核心:索引「形式成功实为空」从 exit 0 无告警变为显式告警行。
 * step-084 RC-H:已知但不支持的语言单独措辞(「语言不适配或解析全失败」的二义
 * 升级为确定性事实:无 adapter 覆盖,非解析失败)。 */
export function coverageWarnings(cov: LanguageCoverage): string[] {
  const out: string[] = [];
  for (const [ext, c] of Object.entries(cov.byExt)) {
    if (c.unsupported) {
      out.push(`${ext}: 语言不支持(无 adapter)——磁盘 ${c.diskFiles} 个 ${ext} 文件未索引(诚实盲区,此前静默假绿;支持语言见 codesense --help)`);
      continue;
    }
    const v = coverageVerdict(ext, c);
    if (v === "zero") {
      out.push(`${ext}: 磁盘 ${c.diskFiles} 个源文件,覆盖 0——语言不适配或该语言解析全部失败`);
    } else if (v === "low") {
      const covered = c.full !== undefined || c.lexical !== undefined || c.empty !== undefined
        ? (c.full ?? 0) + (c.lexical ?? 0) + (c.empty ?? 0)
        : c.indexedFiles;
      const pct = Math.round((covered / c.diskFiles) * 100);
      out.push(`${ext}: 覆盖率 ${covered}/${c.diskFiles}(${pct}%)低于 50%——部分文件解析降级或无符号`);
    }
  }
  return out;
}
