/**
 * 全文件扫描(参照 open-code-review `ocr scan` / internal/scan/provider.go):
 * 枚举 → 过滤(.gitignore+include/exclude+默认排除)→ 预算(文件数/单文件/总 token)→
 * 每文件生成 `@@ -0,0 +1,N @@` 全 `+` 伪 diff,让下游确定性层/定位器/LLM 无感复用。
 * 诚实登记纪律:被过滤/跳过的文件按原因计数并留样本;单文件超限是「截断+登记」,
 * 不是静默丢弃;总 token 预算只在深审分批扣减,确定性层仍覆盖全部入选文件。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, stat, open } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { ReviewFile, ReviewTarget } from "./index";

const execFileP = promisify(execFile);

export interface ScanOptions {
  /** 扫描路径(仓内相对;目录或文件;缺省=全仓)。 */
  paths?: string[];
  /** 白名单 glob(命中任一;缺省=不过滤)。 */
  include?: string[];
  /** 额外黑名单 glob(命中任一即跳过)。 */
  exclude?: string[];
  /** 文件数上限(默认 200)。 */
  maxFiles?: number;
  /** 单文件字节上限(默认 128KiB;超出截断并登记)。 */
  maxFileBytes?: number;
  /** 深审总 token 预算(默认 120000;字符数/4 估算)。 */
  maxTokens?: number;
}

export const SCAN_DEFAULTS = {
  maxFiles: 200,
  maxFileBytes: 128 * 1024,
  maxTokens: 120_000,
  /** 深审每文件上下文字符上限。 */
  llmFileChars: 12_000,
  /** 深审每批上下文字符上限(低于 rounds 的 60k 切片,留出提示词余量)。 */
  batchChars: 45_000,
  /** 深审每批文件数上限。 */
  batchFiles: 8,
} as const;

export interface ScanSkipSample {
  path: string;
  reason: "binary" | "too-large" | "ignored" | "over-file-limit" | "read-error" | "not-regular";
}

export interface ScanTruncatedFile {
  path: string;
  bytes: number;
  keptBytes: number;
}

export interface ScanStats {
  mode: "scan";
  /** 枚举到的候选文件总数(git ls-files 或 walk)。 */
  candidateFiles: number;
  /** 过滤后、文件数上限前的合格文件数。 */
  eligibleFiles: number;
  /** 实际扫描文件数(含截断)。 */
  scannedFiles: number;
  totalBytes: number;
  totalChars: number;
  /** 字符数/4 的粗估 token。 */
  estimatedTokens: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTokens: number;
  /** 全部入选文件的估算 token 是否超预算(深审会按批跳过并登记)。 */
  budgetExceeded: boolean;
  skipped: {
    binary: number;
    tooLarge: number;
    ignored: number;
    overFileLimit: number;
    readError: number;
    notRegular: number;
  };
  /** 跳过样本(每类合计最多 50 条)。 */
  skippedFiles: ScanSkipSample[];
  /** 截断文件明细(最多 50 条;truncatedCount 是全量)。 */
  truncatedFiles: ScanTruncatedFile[];
  truncatedCount: number;
  /** 枚举来源(git=继承 .gitignore;walk=非 git 回退)。 */
  source: "git" | "walk";
}

export class ScanPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScanPathError";
  }
}

const DEFAULT_EXCLUDED_DIRS = new Set([
  "node_modules", "dist", "build", "out", "coverage", "vendor", "third_party",
  ".venv", "venv", "__pycache__", "target", ".next", ".nuxt", ".turbo", ".cache",
  ".git", ".genie", ".idea", ".vscode", ".pytest_cache", ".mypy_cache",
  "Pods", "DerivedData",
]);

/** 生成物/锁文件默认排除(路径级,不区分大小写)。 */
const DEFAULT_EXCLUDED_FILE_RE = [
  /(^|\/)(\.gitignore|\.gitattributes)$/i,
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|npm-shrinkwrap\.json|cargo\.lock|poetry\.lock|go\.sum)$/i,
  /\.min\.(js|css)$/i,
  /\.map$/i,
  /\.snap$/i,
  /_pb2?\.py$/i,
  /\.pb\.go$/i,
  /\.g\.dart$/i,
  /\.generated\.[^/]+$/i,
];

/** 默认排除判定(目录段 + 生成物文件名)。 */
export function isDefaultExcluded(path: string): boolean {
  const segs = path.split("/");
  if (segs.some((s) => DEFAULT_EXCLUDED_DIRS.has(s))) return true;
  return DEFAULT_EXCLUDED_FILE_RE.some((re) => re.test(path));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** glob → RegExp(支持星号通配/问号/花括号枚举;无斜杠的模式自动前缀任意深度)。 */
export function globToRegExp(glob: string): RegExp {
  let p = glob.trim().replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  p = p.replace(/\/+$/, "");
  if (!p) return /^$/;
  const anchored = !p.includes("/");
  if (anchored) p = `**/${p}`;
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "*") {
      if (p[i + 1] === "*") {
        if (p[i + 2] === "/") { re += "(?:[^/]+/)*"; i += 2; }
        else { re += ".*"; i += 1; }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const close = p.indexOf("}", i + 1);
      if (close > i + 1) {
        const alts = p.slice(i + 1, close).split(",").map((x) => escapeRe(x.trim()));
        re += `(?:${alts.join("|")})`;
        i = close;
      } else {
        re += "\\{";
      }
    } else if (c === "[") {
      const close = p.indexOf("]", i + 1);
      if (close > i + 1) {
        re += p.slice(i, close + 1);
        i = close;
      } else {
        re += "\\[";
      }
    } else {
      re += escapeRe(c);
    }
  }
  // 无通配符的目录/文件模式:同时匹配其子路径(exclude 'test/fixtures' 覆盖目录内容)。
  const hasWildcard = /[*?[{]/.test(p);
  const tail = hasWildcard ? "" : "(?:/.*)?";
  return new RegExp(`^${re}${tail}$`);
}

export function matchGlob(pattern: string, path: string): boolean {
  try {
    return globToRegExp(pattern).test(path.replace(/\\/g, "/"));
  } catch {
    return false;
  }
}

function matchesAny(patterns: string[], path: string): boolean {
  return patterns.some((p) => matchGlob(p, path));
}

/** 根 .gitignore 简读(walk 回退面;git 面由 ls-files 原生继承)。 */
async function readRootGitignore(root: string): Promise<string[]> {
  try {
    const raw = await readFile(join(root, ".gitignore"), "utf-8");
    return raw.split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && !l.startsWith("!") && !l.startsWith("/"))
      .slice(0, 200);
  } catch {
    return [];
  }
}

/** 递归 walk(非 git 回退;跳过默认排除目录与符号链接)。 */
async function walkFiles(root: string, dir: string, out: string[], depth = 0): Promise<void> {
  if (depth > 24) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const abs = join(dir, e.name);
    const rel = relative(root, abs).split(sep).join("/");
    if (e.isDirectory()) {
      if (DEFAULT_EXCLUDED_DIRS.has(e.name)) continue;
      await walkFiles(root, abs, out, depth + 1);
    } else if (e.isFile()) {
      if (isDefaultExcluded(rel)) continue;
      out.push(rel);
    }
  }
}

async function listCandidateFiles(root: string): Promise<{ files: string[]; source: "git" | "walk" }> {
  try {
    const { stdout } = await execFileP(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root, maxBuffer: 64 * 1024 * 1024 },
    );
    const files = [...new Set(stdout.split("\0").filter(Boolean).map((p) => p.replace(/\\/g, "/")))];
    return { files, source: "git" };
  } catch {
    const files: string[] = [];
    await walkFiles(root, root, files);
    return { files, source: "walk" };
  }
}

/** 扫描路径规范化:仓内相对、必须存在、不得越界。 */
async function normalizeScanPaths(root: string, paths: string[] | undefined): Promise<string[]> {
  if (!paths?.length) return [];
  const rootAbs = resolve(root);
  const out: string[] = [];
  for (const raw of paths) {
    const p = raw.trim();
    if (!p) continue;
    const abs = resolve(rootAbs, p);
    if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
      throw new ScanPathError(`扫描路径越界(必须在仓根内): ${raw}`);
    }
    try {
      await stat(abs);
    } catch {
      throw new ScanPathError(`扫描路径不存在: ${raw}`);
    }
    const rel = relative(rootAbs, abs).split(sep).join("/");
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

function underScanPath(path: string, scanPaths: string[]): boolean {
  if (scanPaths.length === 0) return true;
  return scanPaths.some((p) => p === "" || p === "." || path === p || path.startsWith(`${p}/`));
}

interface ReadCappedResult {
  content: string;
  bytes: number;
  truncated: boolean;
  binary: boolean;
}

/** 读取文件:最多 maxBytes;二进制按前 8KB NUL 判定。 */
async function readCapped(abs: string, size: number, maxBytes: number): Promise<ReadCappedResult> {
  const take = Math.min(size, maxBytes);
  const fh = await open(abs, "r");
  try {
    const buf = Buffer.alloc(Math.max(1, take));
    const { bytesRead } = await fh.read(buf, 0, take, 0);
    const slice = buf.subarray(0, bytesRead);
    const binary = slice.subarray(0, 8000).includes(0);
    return {
      content: slice.toString("utf-8"),
      bytes: size,
      truncated: size > maxBytes,
      binary,
    };
  } finally {
    await fh.close();
  }
}

/** 每文件伪 diff(全 + 行;行号从 1 起,anchor/finding 定位与 diff 路径同源)。 */
export function toScanPseudoDiff(path: string, content: string): { diffText: string; lines: number } {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const body = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  const arr = body.length ? body.split("\n") : [];
  const header = `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${arr.length} @@\n`;
  return {
    diffText: header + arr.map((l) => "+" + l).join("\n") + (arr.length ? "\n" : ""),
    lines: arr.length,
  };
}

/** 扫描目标收集主入口。 */
export async function collectScanTarget(root: string, opts: ScanOptions = {}): Promise<ReviewTarget> {
  const maxFiles = Math.max(1, Math.trunc(opts.maxFiles ?? SCAN_DEFAULTS.maxFiles));
  const maxFileBytes = Math.max(1, Math.trunc(opts.maxFileBytes ?? SCAN_DEFAULTS.maxFileBytes));
  const maxTokens = Math.max(1, Math.trunc(opts.maxTokens ?? SCAN_DEFAULTS.maxTokens));
  const hardCap = maxFileBytes * 4;
  const scanPaths = await normalizeScanPaths(root, opts.paths);
  const include = opts.include?.filter(Boolean) ?? [];
  const exclude = opts.exclude?.filter(Boolean) ?? [];
  const { files: candidates, source } = await listCandidateFiles(root);
  if (source === "walk") {
    // 非 git 回退:根 .gitignore 的简单模式并入 exclude(negation/复杂语法不支持,登记在文档)。
    const gi = await readRootGitignore(root);
    exclude.push(...gi);
  }

  const stats: ScanStats = {
    mode: "scan",
    candidateFiles: candidates.length,
    eligibleFiles: 0,
    scannedFiles: 0,
    totalBytes: 0,
    totalChars: 0,
    estimatedTokens: 0,
    maxFiles,
    maxFileBytes,
    maxTokens,
    budgetExceeded: false,
    skipped: { binary: 0, tooLarge: 0, ignored: 0, overFileLimit: 0, readError: 0, notRegular: 0 },
    skippedFiles: [],
    truncatedFiles: [],
    truncatedCount: 0,
    source,
  };
  const sample = (path: string, reason: ScanSkipSample["reason"]): void => {
    if (stats.skippedFiles.length < 50) stats.skippedFiles.push({ path, reason });
    const key: Record<ScanSkipSample["reason"], keyof ScanStats["skipped"]> = {
      binary: "binary", "too-large": "tooLarge", ignored: "ignored",
      "over-file-limit": "overFileLimit", "read-error": "readError", "not-regular": "notRegular",
    };
    stats.skipped[key[reason]]++;
  };

  const eligible: string[] = [];
  for (const path of candidates.sort()) {
    if (!underScanPath(path, scanPaths)) continue;
    if (include.length && !matchesAny(include, path)) { sample(path, "ignored"); continue; }
    if (isDefaultExcluded(path) || matchesAny(exclude, path)) { sample(path, "ignored"); continue; }
    let st;
    try { st = await stat(join(root, path)); } catch { sample(path, "read-error"); continue; }
    if (!st.isFile()) { sample(path, "not-regular"); continue; }
    if (st.size > hardCap && st.size > maxFileBytes) { sample(path, "too-large"); continue; }
    eligible.push(path);
  }
  stats.eligibleFiles = eligible.length;

  const selected = eligible.slice(0, maxFiles);
  for (const path of eligible.slice(maxFiles)) sample(path, "over-file-limit");

  const files: ReviewFile[] = [];
  let totalLines = 0;
  for (const path of selected) {
    try {
      const st = await stat(join(root, path));
      const r = await readCapped(join(root, path), st.size, maxFileBytes);
      if (r.binary) { sample(path, "binary"); continue; }
      if (r.truncated) {
        stats.truncatedCount++;
        if (stats.truncatedFiles.length < 50) {
          stats.truncatedFiles.push({ path, bytes: r.bytes, keptBytes: Math.min(r.bytes, maxFileBytes) });
        }
      }
      const pseudo = toScanPseudoDiff(path, r.content);
      files.push({ path, status: "scanned", diffText: pseudo.diffText, content: r.content });
      totalLines += pseudo.lines;
      stats.totalBytes += r.bytes;
      stats.totalChars += r.content.length;
    } catch {
      sample(path, "read-error");
    }
  }
  stats.scannedFiles = files.length;
  stats.estimatedTokens = Math.ceil(stats.totalChars / 4);
  stats.budgetExceeded = stats.estimatedTokens > maxTokens;

  const truncated = stats.truncatedCount > 0 || stats.skipped.overFileLimit > 0 || stats.budgetExceeded;
  return { kind: "scan", files, totalLines, truncated, scan: stats };
}
