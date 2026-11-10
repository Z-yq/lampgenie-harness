/**
 * xlsx 计算真值链:脚本写出的 xlsx 公式里没有缓存值,「看起来对」不等于「算得对」。
 * 机制要求(「表格计算真值链」):
 *  1. 扫错误值:错误范围会产生 0 / #REF! 之类的结果,但不报错 —— 只有读 <v> 缓存值才看得见;
 *  2. 扫公式模式漂移:一列公式应当同形(整列填充),个别行公式不一致是静默的数据错;
 *  3. 重算:没有缓存值的公式必须真的跑一次重算引擎(soffice)才能拿到真值;
 *     引擎缺失 / 不可用必须明确返回 skipped,**不得当成「干净」**(禁止返回 ok)。
 * 设计取舍:不引 XML 解析器(与 office-qa / office-ooxml 一致),用「单元格块 + 子节点」
 * 两段正则。命中判断只看 <v> / <f> 节点内的完整值,因此 sharedStrings / inlineStr 里
 * 出现的 "#N/A 表示…" 说明文字不会被误报。
 * 已知边界:
 *  - 共享公式(<f t="shared" si="0"/> 的从属单元格没有公式文本)不参与漂移比对;
 *  - 图表空引用检测用「全表 ref 集合」近似跨表引用(宁可漏报不误报)。
 */
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

/** Excel 七类错误值(缓存值里出现即代表这一格算错了)。 */
export const XLSX_ERROR_CODES = ["#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A", "#NUM!", "#NULL!"] as const;

const ERROR_SET: ReadonlySet<string> = new Set<string>(XLSX_ERROR_CODES);

export interface FormulaErrorHit {
  /** 部件路径(如 "xl/worksheets/sheet1.xml"),不做 file→sheet 名映射以免猜错。 */
  sheet: string;
  /** 单元格引用,如 "B3";取不到 r 属性时为 `#<序号>`。 */
  cell: string;
  /** 命中的错误码,取值来自 XLSX_ERROR_CODES。 */
  code: string;
  /** 单元格原文片段(截断),便于人工定位。 */
  snippet: string;
}

export interface PatternDriftHit {
  sheet: string;
  column: string;
  /** 同列多数行一致的模板(行号已替换为 {r})。 */
  expected: string;
  /** 该行实际公式原文。 */
  actual: string;
  /** 偏离的单元格引用。 */
  ref: string;
}

export interface RecalcRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type RecalcRunner = (cmd: string, args: string[]) => Promise<RecalcRunResult>;

export interface RecalcOptions {
  /** 注入执行器(测试/自定义引擎);缺省用 child_process 跑 soffice。 */
  run?: RecalcRunner;
  /** 超时毫秒,缺省 120s;超时按 failed 处理(不静默当成功)。 */
  timeoutMs?: number;
}

export interface RecalcResult {
  /** ok=真的重算出了文件;skipped=没有可用引擎;failed=引擎在但没成功。 */
  status: "ok" | "skipped" | "failed";
  reason?: string;
  /** ok 时的重算产物绝对路径(临时目录,调用方读完可删)。 */
  outputPath?: string;
}

/** 单元格块:<c .../> 或 <c ...>…</c>(属性里不会出现 ">",够用)。 */
const CELL_RE = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
const CELL_REF_RE = /\br="([A-Za-z]{1,3}\d+)"/;
/** <v> 或 <f> 节点(带属性的 <f t="shared"> 也算)。 */
const VALUE_NODE_RE = /<(v|f)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;

/** 扫 worksheet XML 里的公式错误值。命中只认 <v>/<f> 节点内的完整错误码。 */
export function scanFormulaErrors(xmlParts: Record<string, string>): FormulaErrorHit[] {
  const hits: FormulaErrorHit[] = [];
  const seen = new Set<string>();
  for (const [sheet, xml] of Object.entries(xmlParts ?? {})) {
    if (typeof xml !== "string" || !xml) continue;
    CELL_RE.lastIndex = 0;
    let cell: RegExpExecArray | null;
    let ordinal = 0;
    while ((cell = CELL_RE.exec(xml))) {
      ordinal += 1;
      const attrs = cell[1] ?? "";
      const inner = cell[2] ?? "";
      const ref = CELL_REF_RE.exec(attrs)?.[1] ?? `#${ordinal}`;
      VALUE_NODE_RE.lastIndex = 0;
      let node: RegExpExecArray | null;
      while ((node = VALUE_NODE_RE.exec(inner))) {
        const raw = unescapeXml(node[2] ?? "").trim();
        // 公式带前导 "=";缓存值不带。两者都只做「整值等于错误码」判定:
        // =IFERROR(A1,"#N/A") 这类把错误码写在字符串字面量里的公式不误报。
        const value = raw.startsWith("=") ? raw.slice(1).trim() : raw;
        if (!ERROR_SET.has(value)) continue;
        const key = `${sheet}|${ref}|${value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({ sheet, cell: ref, code: value, snippet: cellSnippet(ref, inner) });
      }
    }
  }
  return hits;
}

/** 从 worksheet XML 抽出带公式的单元格(供漂移比对)。 */
export function formulaCellsOf(xml: string): { ref: string; formula: string }[] {
  const out: { ref: string; formula: string }[] = [];
  if (typeof xml !== "string" || !xml) return out;
  CELL_RE.lastIndex = 0;
  let cell: RegExpExecArray | null;
  while ((cell = CELL_RE.exec(xml))) {
    const ref = CELL_REF_RE.exec(cell[1] ?? "")?.[1];
    if (!ref) continue;
    const f = /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(cell[2] ?? "");
    if (!f) continue;
    const formula = unescapeXml(f[1] ?? "").trim();
    if (!formula) continue; // 共享公式从属格:没有公式文本,不参与比对
    out.push({ ref, formula });
  }
  return out;
}

/** 把公式里的单元格引用行号换成 {r},用于同列同形比对。 */
export function formulaTemplate(formula: string): string {
  return String(formula ?? "")
    .replace(/\s+/g, "")
    // 引用形态:$A$1 / A1 / $A1 / A$1;排除 LOG10( 这类「函数名+数字」与小数。
    .replace(/(?<![A-Za-z_0-9])(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?![\d.(])/g, "$1$2$3{r}");
}

/**
 * 同列连续 ≥3 行公式应同形;个别偏离即报告(expected=多数模板,actual=该行原文)。
 * 连续 = 行号相邻;断行/空行会把一列切成多段,每段独立判定。
 */
export function scanFormulaPatternDrift(sheet: {
  name: string;
  cells: { ref: string; formula: string }[];
}): PatternDriftHit[] {
  const out: PatternDriftHit[] = [];
  const sheetName = sheet?.name ?? "";
  const byCol = new Map<string, { row: number; ref: string; formula: string }[]>();
  for (const cell of sheet?.cells ?? []) {
    if (!cell || typeof cell.ref !== "string" || typeof cell.formula !== "string") continue;
    const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(cell.ref.trim());
    if (!m) continue;
    const column = (m[1] as string).toUpperCase();
    const row = Number(m[2]);
    if (!Number.isFinite(row)) continue;
    const list = byCol.get(column) ?? [];
    list.push({ row, ref: cell.ref.trim(), formula: cell.formula });
    byCol.set(column, list);
  }

  for (const [column, cells] of byCol) {
    cells.sort((a, b) => a.row - b.row);
    let start = 0;
    for (let i = 1; i <= cells.length; i += 1) {
      const prev = cells[i - 1] as { row: number };
      const cur = cells[i] as { row: number } | undefined;
      if (cur && cur.row === prev.row + 1) continue;
      const run = cells.slice(start, i);
      if (run.length >= 3) out.push(...driftOfRun(sheetName, column, run));
      start = i;
    }
  }
  return out;
}

function driftOfRun(
  sheet: string,
  column: string,
  run: { row: number; ref: string; formula: string }[],
): PatternDriftHit[] {
  const counts = new Map<string, { n: number; first: number }>();
  run.forEach((c, idx) => {
    const t = formulaTemplate(c.formula);
    const prev = counts.get(t);
    counts.set(t, prev ? { n: prev.n + 1, first: prev.first } : { n: 1, first: idx });
  });
  // 多数模板胜出;并列时取最早出现的那个(稳定、可解释)。
  let expected = "";
  let best = { n: -1, first: Number.MAX_SAFE_INTEGER };
  for (const [tpl, info] of counts) {
    if (info.n > best.n || (info.n === best.n && info.first < best.first)) {
      expected = tpl;
      best = info;
    }
  }
  const out: PatternDriftHit[] = [];
  for (const c of run) {
    if (formulaTemplate(c.formula) === expected) continue;
    out.push({ sheet, column, expected, actual: c.formula, ref: c.ref });
  }
  return out;
}

/** 找出引用区域全空的图表(图表挂着但数据区没值 = 导出的空图)。 */
export function scanChartGaps(
  charts: Record<string, string>,
  sheets: Record<string, string>,
): { part: string; range: string }[] {
  const filled = new Set<string>();
  for (const xml of Object.values(sheets ?? {})) {
    if (typeof xml !== "string" || !xml) continue;
    CELL_RE.lastIndex = 0;
    let cell: RegExpExecArray | null;
    while ((cell = CELL_RE.exec(xml))) {
      const ref = CELL_REF_RE.exec(cell[1] ?? "")?.[1];
      if (!ref) continue;
      const inner = cell[2] ?? "";
      const text = inner.replace(/<[^>]*>/g, "").trim();
      if (text || /<f[\s>]/.test(inner)) filled.add(ref.toUpperCase());
    }
  }

  const out: { part: string; range: string }[] = [];
  for (const [part, xml] of Object.entries(charts ?? {})) {
    if (typeof xml !== "string" || !xml) continue;
    const ranges = [...xml.matchAll(/<c:f>([\s\S]*?)<\/c:f>/g)]
      .map((m) => (m[1] ?? "").trim())
      .filter(Boolean);
    if (!ranges.length) continue;
    if (ranges.some((r) => rangeHasValue(r, filled))) continue;
    out.push({ part, range: ranges[0] as string });
  }
  return out;
}

function rangeHasValue(range: string, filled: Set<string>): boolean {
  // "Sheet1!$B$2:$B$10" / "'My Sheet'!$A$1" / 多区逗号分隔
  for (const piece of range.split(",")) {
    const body = (piece.split("!").pop() ?? "").trim();
    const [from, to] = body.split(":");
    const a = parseRef(from ?? "");
    if (!a) continue;
    const b = to ? parseRef(to) : a;
    if (!b) continue;
    const cols = colRange(a.col, b.col);
    const rows = rowRange(a.row, b.row);
    // 上限保护:大区域只抽样边界,防病态表格把 QA 拖死。
    if (cols.length * rows.length > 4000) {
      if (filled.has(refOf(a.col, a.row)) || filled.has(refOf(b.col, b.row))) return true;
      continue;
    }
    for (const c of cols) for (const r of rows) if (filled.has(refOf(c, r))) return true;
  }
  return false;
}

function parseRef(s: string): { col: string; row: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(s.trim());
  if (!m) return null;
  return { col: (m[1] as string).toUpperCase(), row: Number(m[2]) };
}

function colRange(a: string, b: string): string[] {
  const x = colNumber(a);
  const y = colNumber(b);
  if (x <= 0 || y <= 0) return [];
  const out: string[] = [];
  for (let i = Math.min(x, y); i <= Math.max(x, y); i += 1) out.push(colName(i));
  return out;
}

function rowRange(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) out.push(i);
  return out;
}

function colNumber(col: string): number {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function colName(n: number): string {
  let s = "";
  let v = n;
  while (v > 0) {
    const r = (v - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    v = Math.floor((v - 1) / 26);
  }
  return s;
}

function refOf(col: string, row: number): string {
  return `${col}${row}`;
}

/**
 * 用 soffice 重算一个 xlsx:默认 `soffice --headless --convert-to xlsx --outdir <tmp> <src>`,
 * 并用 -env:UserInstallation 指到临时 profile(防止桌面会话的 profile 锁)。
 * 三态语义(不得含糊):
 *  - skipped:找不到/跑不起来的引擎 —— 「没重算」,绝不能说干净;
 *  - failed :引擎在,但退出非 0 / 超时 / 没产出文件;
 *  - ok     :产出文件存在,outputPath 指向它。
 */
export async function recalcWithSoffice(absPath: string, opts: RecalcOptions = {}): Promise<RecalcResult> {
  const src = String(absPath ?? "");
  if (!src) return { status: "skipped", reason: "未提供文件路径" };
  const timeoutMs = opts.timeoutMs ?? 120_000;
  let outDir: string | null = null;
  try {
    const dir = await mkdtemp(join(tmpdir(), "xlsx-recalc-"));
    outDir = dir;
    const profile = join(dir, "profile");
    const args = [
      "--headless",
      "--norestore",
      `-env:UserInstallation=file://${profile}`,
      "--convert-to",
      "xlsx",
      "--outdir",
      dir,
      src,
    ];
    const run = opts.run ?? defaultSofficeRun;
    const res = await withTimeout(run("soffice", args), timeoutMs);
    if (res.timedOut) return { status: "failed", reason: `soffice 超时(${timeoutMs}ms 未返回)` };
    const { ok, stdout, stderr } = res.value as RecalcRunResult;
    const text = `${stderr ?? ""}\n${stdout ?? ""}`;
    if (!ok) {
      if (looksLikeMissingEngine(text)) {
        return { status: "skipped", reason: `未找到可用的 soffice 重算引擎: ${firstLine(text) || "spawn ENOENT"}` };
      }
      return { status: "failed", reason: `soffice 退出非 0: ${firstLine(stderr || stdout) || "(无输出)"}` };
    }
    const outputPath = join(dir, basename(src));
    try {
      await stat(outputPath);
    } catch {
      return { status: "failed", reason: `soffice 返回成功但未产出 ${basename(src)}(输出目录里没有文件)` };
    }
    return { status: "ok", outputPath };
  } catch (err) {
    if (isEnoent(err)) return { status: "skipped", reason: `未找到可用的 soffice 重算引擎: ${msgOf(err)}` };
    return { status: "failed", reason: `重算流程异常: ${msgOf(err)}` };
  } finally {
    // ok 的产物留给调用方读;其它分支的临时目录(含 profile)直接清掉。
    if (outDir && (await dirHasNoOutput(outDir))) await rm(outDir, { recursive: true, force: true });
  }
}

async function dirHasNoOutput(dir: string): Promise<boolean> {
  try {
    const names = await readdir(dir);
    return !names.some((n) => n.toLowerCase().endsWith(".xlsx"));
  } catch {
    return false; // 判断不了就保守不删
  }
}

const defaultSofficeRun: RecalcRunner = (cmd, args) =>
  new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, stdout: "", stderr: `spawn ${cmd} ENOENT: ${msgOf(err)}` });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (r: RecalcRunResult): void => {
      if (settled) return;
      settled = true;
      resolve({ ok: r.ok, stdout: clip(r.stdout), stderr: clip(r.stderr) });
    };
    child.on("error", (err) => {
      const code = (err as { code?: unknown }).code ?? "";
      done({ ok: false, stdout, stderr: `spawn ${cmd} ${code}: ${err.message}` });
    });
    child.stdout?.on("data", (d: unknown) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d: unknown) => {
      stderr += String(d);
    });
    child.on("close", (code) => done({ ok: code === 0, stdout, stderr }));
  });

type Timed<T> = { value: T; timedOut: false } | { value: undefined; timedOut: true };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<Timed<T>> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<Timed<T>>((resolve) => {
    timer = setTimeout(() => resolve({ value: undefined, timedOut: true }), ms);
    if (timer && typeof timer.unref === "function") timer.unref();
  });
  const done = p.then((value) => ({ value, timedOut: false as const }));
  return Promise.race([done, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function looksLikeMissingEngine(text: string): boolean {
  return /\bENOENT\b|command not found|is not recognized as an internal|没有那个文件或目录|找不到指定的文件/i.test(text);
}

function isEnoent(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if ((err as { code?: unknown }).code === "ENOENT") return true;
  return /\bENOENT\b/.test(msgOf(err));
}

function clip(s: string): string {
  const v = String(s ?? "");
  return v.length > 4000 ? `${v.slice(0, 4000)}…` : v;
}

function firstLine(s: string): string {
  const line = String(s ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ? (line.length > 200 ? `${line.slice(0, 200)}…` : line) : "";
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function cellSnippet(ref: string, inner: string): string {
  const flat = inner.replace(/\s+/g, " ").trim();
  const body = flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
  return `<c r="${ref}">${body}</c>`;
}

function unescapeXml(s: string): string {
  return String(s ?? "").replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (all, ent: string) => {
    if (ent === "amp") return "&";
    if (ent === "lt") return "<";
    if (ent === "gt") return ">";
    if (ent === "quot") return '"';
    if (ent === "apos") return "'";
    const code = ent.startsWith("#x") ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
    try {
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    } catch {
      return all;
    }
  });
}
