/**
 * 进程入口扫描(2026-10-22 P1):「这个仓怎么跑起来/业务入口在哪」的第一屏答案。
 *
 * 背景(用户拷问实锚):agent_alpha 的生产启动器 webrtc_multiprocess_server.py(main@94 →
 * run_master,master/worker 多进程)在 entrypoints top-300 之外——扇出排序天然沉底(启动器的
 * 职责是运行时动态 spawn,静态扇出≈0),榜首反而是 UI 渲染函数与审计脚本。「图上无入边且
 * 扇出大」≠「进程入口」,本模块按语言各自的启动约定做确定性提取,与扇出榜解耦成节:
 *
 * 形态面(按语言):
 * - python:`if __name__ == "__main__":` 守卫(单双引号两形态)→ 守卫块内被调符号(缩进块,
 *   ≤48 行;asyncio.run(fn) 特判点名),符号经索引 byName 解析(同文件优先);
 * - js/ts(node):`require.main === module`(bin 脚本直跑守卫)/ `import.meta.main`(deno 形态);
 * - c/c++:main/wmain/WinMain/SDL_main/_tmain 函数定义(读索引符号,无需行扫描);
 * - go:package main 的 `func main`(读索引;cmd 子目录形态天然覆盖);
 * - java:`static void main(String[])`(读索引,method 形态);
 * - manifest:package.json `bin` 字段(声明式 CLI 入口;console_scripts/pyproject 属已知边界)。
 *
 * 纪律:纯确定性(零 LLM)、**同步**(dispatchTool 同步渲染约束;rg spawnSync 一次调用);
 * 非产品路径(scripts/docs/examples)默认过滤并如实计数(--all 放行,与 entrypoints 同口径);
 * 索引缺席时行扫描面(py/js/bin)仍可用,c/go/java 面显式降级。rg 缺席回退系统 grep。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { isNonProductPath, isTestPath } from "../path-filter";
import type { C2fIndex } from "../callgraph/c2f";

export type ProcessEntryKind = "py-main" | "js-bin" | "c-main" | "go-main" | "java-main" | "pkg-bin";

export interface ProcessEntry {
  kind: ProcessEntryKind;
  lang: "python" | "js" | "c" | "go" | "java" | "manifest";
  file: string;
  /** 守卫行/py 定义行;pkg-bin=1。 */
  line: number;
  /** 显示名:main@94 / __main__@156 / bin 名。 */
  label: string;
  /** 守卫块内调用的符号(≤3,索引解析;无索引=裸名);c/go/java main 为其符号名。 */
  calls: string[];
}

export interface ProcessEntryScan {
  entries: ProcessEntry[];
  /** 被路径过滤掉的条数(诚实计数)。 */
  filtered: number;
  /** 索引缺席(c/go/java 符号面不可用)。 */
  indexAvailable: boolean;
  /** 行扫描引擎(rg/grep/absent)。 */
  engine: "rg" | "grep" | "absent";
}

const PY_BUILTIN = new Set([
  "print", "len", "range", "str", "int", "float", "dict", "list", "set", "bool", "tuple",
  "open", "input", "exit", "quit", "isinstance", "issubclass", "getattr", "setattr", "hasattr",
  "super", "enumerate", "zip", "map", "filter", "sorted", "min", "max", "sum", "abs", "round",
  "asyncio", "uvicorn", "argparse", "logging", "os", "sys", "time", "pathlib", "json",
  "if", "else", "elif", "while", "for", "try", "except", "finally", "with", "assert", "raise", "return",
]);

/** 命中行是否像真守卫(2026-10-26 假阳性修复):本模块自己的文档注释/模式串里就写着
 * `require.main === module`、`import.meta.main`——旧版按「文件首个命中行」直接采信,把
 * procentries.ts 自己标成了 bin 守卫(整仓 flow 的入口节因此把 packages/code-sense 当启动器)。
 * 判据:①注释/docstring 行(// /* * # 开头)不算;②模式串前面有**落单引号**(在字符串字面量里)
 * 不算。`typeof require !== "undefined" && require.main === module` 这类双引号成对的真实守卫
 * 仍放行。 */
function looksLikeGuard(line: string, patterns: string[]): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^(\/\/|\/\*|\*|#)/.test(t)) return false;
  let idx = -1;
  for (const p of patterns) {
    const i = t.indexOf(p);
    if (i >= 0 && (idx < 0 || i < idx)) idx = i;
  }
  if (idx < 0) return false;
  const before = t.slice(0, idx);
  const quotes = (before.match(/["'`]/g) ?? []).length;
  return quotes % 2 === 0;
}

/** rg/grep 命中 → {file: 首个**像守卫**的命中行}(去重取首行;注释/模式串行跳过)。 */
function grepFirstLines(root: string, patterns: string[], glob: string): { byFile: Map<string, number>; engine: ProcessEntryScan["engine"] } {
  const byFile = new Map<string, number>();
  try {
    const out = execFileSync("rg", ["-n", "--no-heading", "-F", "-m", "8", "-g", glob, ...patterns.flatMap((p) => ["-e", p]), "--", root], {
      maxBuffer: 8 * 1024 * 1024, timeout: 20_000,
    }).toString("utf-8");
    for (const line of out.split("\n")) {
      const m = /^(.*?):(\d+):(.*)$/.exec(line);
      if (!m) continue;
      const file = m[1]!.replace(/\\/g, "/").startsWith(root.replace(/\\/g, "/") + "/")
        ? m[1]!.slice(root.length + 1).replace(/\\/g, "/")
        : m[1]!.replace(/\\/g, "/");
      if (!byFile.has(file) && looksLikeGuard(m[3] ?? "", patterns)) byFile.set(file, Number(m[2]));
    }
    return { byFile, engine: "rg" };
  } catch (err) {
    if ((err as { status?: number }).status === 1) return { byFile, engine: "rg" }; // 零命中
    // rg 缺席/超时 → grep 回退(不含 glob,按扩展名过滤)
    try {
      const exts = glob.match(/\.\w+/g) ?? [];
      const args = ["-rn", "-F"];
      for (const p of patterns) args.push("-e", p);
      for (const e of exts) args.push(`--include=*[${e}]`);
      args.push("--", root);
      const out = execFileSync("grep", args, { maxBuffer: 8 * 1024 * 1024, timeout: 20_000 }).toString("utf-8");
      for (const line of out.split("\n")) {
        const m = /^(.*?):(\d+):(.*)$/.exec(line);
        if (!m) continue;
        const file = m[1]!.replace(/\\/g, "/");
        const rel = file.startsWith(root + "/") ? file.slice(root.length + 1) : file;
        if (!byFile.has(rel) && looksLikeGuard(m[3] ?? "", patterns)) byFile.set(rel, Number(m[2]));
      }
      return { byFile, engine: "grep" };
    } catch (err2) {
      if ((err2 as { status?: number }).status === 1) return { byFile, engine: "grep" };
      return { byFile, engine: "absent" };
    }
  }
}

/** 守卫行起取缩进块(≤48 行),返回块文本。 */
function indentBlock(lines: string[], startIdx: number): string {
  const guard = lines[startIdx]!;
  const baseIndent = guard.length - guard.trimStart().length;
  const out: string[] = [];
  for (let i = startIdx; i < Math.min(lines.length, startIdx + 48); i++) {
    const l = lines[i]!;
    if (i === startIdx) { out.push(l.trim()); continue; }
    if (!l.trim()) { out.push(l); continue; } // 块内空行
    const ind = l.length - l.trimStart().length;
    if (ind <= baseIndent) break; // 守卫块结束
    out.push(l.trim());
  }
  return out.join("\n");
}

/** 块内调用符号提取:fn( 形态;builtin/关键字滤除,保持出现序,截 6。 */
function calledSymbols(block: string): string[] {
  const out: string[] = [];
  for (const m of block.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
    const n = m[1]!;
    if (PY_BUILTIN.has(n) || out.includes(n)) continue;
    out.push(n);
    if (out.length >= 6) break;
  }
  return out;
}

function resolveCalls(names: string[], index: C2fIndex | null, file: string): string[] {
  if (names.length === 0) return [];
  if (!index) return names.slice(0, 3);
  const out: string[] = [];
  for (const n of names) {
    const ids = Object.hasOwn(index.byName, n) ? index.byName[n]! : [];
    if (ids.length === 0) continue;
    const sameFile = ids.find((id) => id.startsWith(file + "#"));
    const pick = sameFile ?? (ids.length === 1 ? ids[0] : undefined);
    if (!pick) { out.push(n); continue; }
    const rel = pick.slice(0, pick.lastIndexOf("#"));
    out.push(rel === file ? n : `${n}@${rel}`);
    if (out.length >= 3) break;
  }
  return out.length > 0 ? out : names.slice(0, 3);
}

const C_MAIN_NAMES = new Set(["main", "wmain", "WinMain", "SDL_main", "_tmain"]);
const C_EXTS = [".c", ".cc", ".cpp", ".cxx"];

export function scanProcessEntriesSync(root: string, index: C2fIndex | null, opts: { all?: boolean } = {}): ProcessEntryScan {
  const raw: ProcessEntry[] = [];
  let engine: ProcessEntryScan["engine"] = "absent";

  // ① python __main__ 守卫(双引号/单引号两形态,-F 字面量)
  const py = grepFirstLines(root, ['__name__ == "__main__', "__name__ == '__main__'"], "*.{py}");
  engine = py.engine === "absent" ? engine : py.engine;
  for (const [file, line] of py.byFile) {
    let calls: string[] = [];
    try {
      const text = readFileSync(join(root, file), "utf-8");
      calls = resolveCalls(calledSymbols(indentBlock(text.split("\n"), line - 1)), index, file);
    } catch { /* 读失败=裸守卫行,calls 空 */ }
    raw.push({ kind: "py-main", lang: "python", file, line, label: `__main__@${line}`, calls });
  }

  // ② js/ts bin 守卫
  const js = grepFirstLines(root, ["require.main === module", "import.meta.main"], "*.{js,cjs,mjs,ts}");
  engine = js.engine === "absent" ? engine : js.engine;
  for (const [file, line] of js.byFile) {
    raw.push({ kind: "js-bin", lang: "js", file, line, label: `bin 守卫@${line}`, calls: [] });
  }

  // ③ c/go/java main 符号(索引面;缺席=显式降级)
  if (index) {
    for (const n of index.nodes) {
      const ext = n.file.slice(n.file.lastIndexOf("."));
      if (C_MAIN_NAMES.has(n.name) && C_EXTS.includes(ext)) {
        raw.push({ kind: "c-main", lang: "c", file: n.file, line: n.line, label: `${n.name}@${n.line}`, calls: [] });
      } else if (n.name === "main" && ext === ".go") {
        raw.push({ kind: "go-main", lang: "go", file: n.file, line: n.line, label: `main@${n.line}`, calls: [] });
      } else if (n.name === "main" && ext === ".java") {
        raw.push({ kind: "java-main", lang: "java", file: n.file, line: n.line, label: `${n.name}.main@${n.line}`, calls: [] });
      }
    }
  }

  // ④ package.json bin(声明式 CLI 入口)
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as { bin?: string | Record<string, string> };
    if (typeof pkg.bin === "string") raw.push({ kind: "pkg-bin", lang: "manifest", file: "package.json", line: 1, label: `bin → ${pkg.bin}`, calls: [] });
    else if (pkg.bin && typeof pkg.bin === "object") {
      for (const [name, target] of Object.entries(pkg.bin).slice(0, 6)) {
        raw.push({ kind: "pkg-bin", lang: "manifest", file: "package.json", line: 1, label: `bin ${name} → ${target}`, calls: [] });
      }
    }
  } catch { /* 无 package.json/解析失败:该面不适用 */ }

  // 路径治理:非产品路径(docs/examples/vendor)默认滤(--all 放行,与 entrypoints 同口径);
  // scripts/ 与测试文件不滤但排序沉底(进程入口面里审计/演示脚本恰是用户拷问的噪声源,
  // 但「存在」仍如实呈现,filtered 只计被滤的)。
  const keep = opts.all ? raw : raw.filter((e) => !isNonProductPath(e.file));
  const filtered = raw.length - keep.length;
  const rank = (e: ProcessEntry): number => {
    if (isTestPath(e.file)) return 2;
    if (/(^|\/)(scripts?|demos?|examples?|bench)\//.test(e.file)) return 1;
    return 0;
  };
  // 深度优先:仓库根/浅层文件更可能是启动器(实锚 agent_alpha:根目录 web_chat_server.py 与
  // webrtc_multiprocess_server.py 曾被字典序排到 24 条之外),同深度再按字典序。
  const depth = (e: ProcessEntry): number => e.file.split("/").length;
  const kindRank = (e: ProcessEntry): number => (e.kind === "pkg-bin" ? 1 : 0);
  const entries = keep
    .sort((a, b) => rank(a) - rank(b) || depth(a) - depth(b) || kindRank(a) - kindRank(b) || a.file.localeCompare(b.file))
    .slice(0, 24);
  return { entries, filtered, indexAvailable: index !== null, engine };
}

/** 渲染「进程入口」节(人类面;entrypoints 输出首节)。 */
export function renderProcessEntries(scan: ProcessEntryScan, max = 8): string[] {
  if (scan.entries.length === 0) {
    const base = scan.indexAvailable
      ? "进程入口: 未发现(py __main__/js bin/c·go·java main/package.json bin 五面均无;纯库形态仓属正常)"
      : "进程入口: 行扫描面无发现;c/go/java main 符号面需索引(当前缺席,重建后补全)";
    return [base];
  }
  const lines = [`进程入口(${scan.entries.length}${scan.filtered > 0 ? `,已过滤非产品路径 ${scan.filtered} 条(--all 查看)` : ""}——启动器/进程 main,与扇出榜解耦):`];
  const TAG: Record<ProcessEntryKind, string> = { "py-main": "py", "js-bin": "js", "c-main": "c", "go-main": "go", "java-main": "java", "pkg-bin": "bin" };
  for (const e of scan.entries.slice(0, max)) {
    const calls = e.calls.length > 0 ? ` → ${e.calls.join(", ")}` : "";
    lines.push(`  [${TAG[e.kind]}] ${e.file}:${e.line} ${e.label}${calls}`);
  }
  if (scan.entries.length > max) lines.push(`  …还有 ${scan.entries.length - max} 个(--json 全量)`);
  return lines;
}
