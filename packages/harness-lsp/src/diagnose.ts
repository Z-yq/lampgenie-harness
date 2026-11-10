/**
 * 编辑后检查编排(step-114 / M108)。
 *   write/edit 落盘前 → baseline 诊断(旧内容,同一 checker) → 落盘 → 格式化(LSP→本机命令)
 *   → 诊断(server / TS 编译器兜底) → delta 对消(只报新增 ERROR) → 渲染 <diagnostics>。
 *
 * 全部 fail-soft:任何异常返回空 suffix,不影响工具成功结果;server 缺失静默跳过。
 */
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { withLspClient } from "./manager.js";
import { discoverServer, languageRouteOf } from "./servers.js";
import { applyTextEdits, externalFormat, type LspTextEdit } from "./format.js";
import { typescriptDiagnostics, isTypeScriptFile } from "./typescript.js";
import {
  LSP_DEFAULTS,
  resolveLspSettings,
  type BaselineCheckInput,
  type DiagnosticItem,
  type EditCheckInput,
  type EditCheckResult,
  type RenderDiagnosticsOptions,
} from "./types.js";

/** 行位移对消容差(±2 行,M108)。 */
const LINE_TOLERANCE = 2;

/**
 * 写前 baseline 诊断(M108):对**旧内容**跑同一检查器,得到写前诊断集。
 * 调用约束:必须在落盘前调用(tsc 兜底按磁盘内容建 program,写后磁盘已是新内容)。
 * @returns 数组=baseline(空数组=新文件/非代码文件);null=检查器不可用(调用方标 unavailable,不阻塞写)。
 */
export async function collectBaselineDiagnostics(input: BaselineCheckInput): Promise<DiagnosticItem[] | null> {
  const settings = resolveLspSettings(input.settings);
  if (!settings.enabled) return null;
  const absPath = resolve(input.absPath);
  const root = resolve(input.root);
  const route = languageRouteOf(absPath);
  if (!route) return []; // 非代码文件:本就没有诊断面

  let text = input.text;
  if (text === undefined) {
    try {
      const st = statSync(absPath);
      if (!st.isFile() || st.size > LSP_DEFAULTS.maxFileBytes) return null;
      text = readFileSync(absPath, "utf8");
    } catch {
      return []; // 文件不存在=新文件,基线为空
    }
  }
  if (text === "") return []; // 新文件/空文件:基线为空
  if (Buffer.byteLength(text) > LSP_DEFAULTS.maxFileBytes) return null;

  const server = discoverServer(route);
  if (server) {
    const diags = await withLspClient(server, root, settings.timeoutMs, async (client) => {
      await client.syncDocument(absPath, route.languageId, text!);
      return client.collectDiagnostics(absPath, settings.timeoutMs);
    });
    if (diags) return diags;
  }
  if (route.family === "ts" && isTypeScriptFile(absPath)) {
    // 兜底读磁盘(= 落盘前的旧内容,故必须写前调用)。
    return await typescriptDiagnostics(absPath, root, settings.timeoutMs);
  }
  return null;
}

/**
 * 执行一次编辑后检查。
 * @returns 诊断/格式化结果(永不抛错;不可用=checker none)。
 */
export async function checkEditedFile(input: EditCheckInput): Promise<EditCheckResult> {
  const started = Date.now();
  const settings = resolveLspSettings(input.settings);
  const zero = (): EditCheckResult => ({
    formatted: false,
    diagnostics: [],
    newDiagnostics: [],
    rendered: null,
    baseline: "off",
    checker: "none",
    elapsedMs: Date.now() - started,
  });
  if (!settings.enabled) return zero();

  const absPath = resolve(input.absPath);
  const root = resolve(input.root);
  const route = languageRouteOf(absPath);
  if (!route) return zero();

  let text: string;
  try {
    const st = statSync(absPath);
    if (!st.isFile() || st.size > LSP_DEFAULTS.maxFileBytes) return zero();
    text = input.content ?? readFileSync(absPath, "utf8");
  } catch {
    return zero();
  }

  const server = discoverServer(route);
  let formatted = false;
  let diagnostics: DiagnosticItem[] = [];
  let checker: EditCheckResult["checker"] = "none";

  const applyFormat = async (client?: import("./client.js").LspClient): Promise<string> => {
    if (!settings.format) return text;
    let next = text;
    if (client) {
      const edits = await client.formatDocument(absPath, { tabSize: route.tabSize, insertSpaces: route.insertSpaces });
      if (edits && edits.length > 0) next = applyTextEdits(next, edits as LspTextEdit[]);
    }
    if (next === text) {
      // LSP 不支持 formatting / 无结果 → 本机 formatter 兜底(缺失=null)
      const ext = await externalFormat({ text, absPath, root, family: route.family, timeoutMs: settings.timeoutMs });
      if (ext) next = ext.text;
    }
    if (next === text) return text;
    try {
      writeFileSync(absPath, next, "utf8");
      formatted = true;
      return next;
    } catch {
      return text; // 写失败(只读等)=保持原文件,不标记已格式化
    }
  };

  const lspResult = server
    ? await withLspClient(server, root, settings.timeoutMs, async (client) => {
        await client.syncDocument(absPath, route.languageId, text);
        const current = await applyFormat(client);
        if (current !== text) await client.syncDocument(absPath, route.languageId, current);
        const diags = await client.collectDiagnostics(absPath, settings.timeoutMs);
        return { current, diags };
      })
    : null;

  if (lspResult) {
    text = lspResult.current;
    diagnostics = lspResult.diags;
    checker = "lsp";
  } else {
    // 无 server / 启动失败 / broken:格式化走本机命令;TS 走编译器兜底。
    text = await applyFormat();
    if (route.family === "ts" && isTypeScriptFile(absPath)) {
      const tsDiags = await typescriptDiagnostics(absPath, root, settings.timeoutMs);
      if (tsDiags !== null) {
        diagnostics = tsDiags;
        checker = "tsc";
      }
    }
  }

  // ---- delta(M108):只报写前不存在的新增;行号按新旧文本做位移对消 ----
  const enabledDelta = settings.baseline && input.baseline !== undefined;
  const baselineState: EditCheckResult["baseline"] = !enabledDelta
    ? "off"
    : input.baseline === null
      ? "unavailable"
      : "ok";
  const newDiagnostics =
    enabledDelta && Array.isArray(input.baseline)
      ? subtractBaseline(input.baseline, diagnostics, input.baselineText, text)
      : diagnostics;

  return {
    formatted,
    diagnostics,
    newDiagnostics,
    rendered: renderDiagnostics(relativePath(root, absPath), newDiagnostics, settings.maxDiagnostics, {
      includeWarnings: settings.includeWarnings,
      ...(baselineState === "unavailable" ? { note: "baseline 不可用,仅报当前 ERROR" } : {}),
    }),
    baseline: baselineState,
    checker,
    elapsedMs: Date.now() - started,
  };
}

/** 工具结果尾缀:格式化标记 + 诊断块;无内容=空串(不改变旧工具结果形态)。 */
export async function editCheckSuffix(input: EditCheckInput): Promise<string> {
  try {
    const r = await checkEditedFile(input);
    let out = "";
    if (r.formatted) out += "\n(保存格式化已应用)";
    if (r.rendered) out += "\n\n" + r.rendered;
    return out;
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ *
 * delta 引擎(M108)
 * ------------------------------------------------------------------ */

/**
 * 写后诊断 - baseline 诊断(按 (severity, code, source, message) 匹配;行号做位移对消,±2 容差)。
 * - 同 key 的 baseline 条目一对一消费(同 message 多条不会互相掩盖);
 * - 行号映射:新旧文本做「公共前缀 / 公共后缀」对齐,变更区内按估计位置 + 内容就近锚定;
 * - 同一 message 且行号在映射结果 ±2 内 → 视为 pre-existing,丢弃。
 */
export function subtractBaseline(
  baseline: DiagnosticItem[],
  current: DiagnosticItem[],
  baselineText?: string,
  currentText?: string,
): DiagnosticItem[] {
  if (baseline.length === 0) return current;
  const map = makeLineMapper(baselineText, currentText);
  const pool = new Map<string, number[]>();
  for (const d of baseline) {
    const key = diagKey(d);
    const mapped = map(d.line);
    const arr = pool.get(key);
    if (arr) arr.push(mapped);
    else pool.set(key, [mapped]);
  }
  const out: DiagnosticItem[] = [];
  for (const d of current) {
    const arr = pool.get(diagKey(d));
    const hit = arr?.findIndex((line) => Math.abs(line - d.line) <= LINE_TOLERANCE) ?? -1;
    if (arr && hit >= 0) {
      arr.splice(hit, 1); // 一对一消费
      continue;
    }
    out.push(d);
  }
  return out;
}

function diagKey(d: DiagnosticItem): string {
  return `${d.severity}\u0001${d.code ?? ""}\u0001${d.source ?? ""}\u0001${d.message}`;
}

/**
 * 旧行号 → 新行号映射(1-based)。
 * 公共前后缀外整体平移;变更区内按平移估计,再用「旧行内容在新行中的最近同文行」锚定(治插入/删除块内的漂移)。
 */
export function makeLineMapper(baselineText?: string, currentText?: string): (oldLine: number) => number {
  if (baselineText === undefined || currentText === undefined || baselineText === currentText) {
    return (oldLine) => oldLine;
  }
  const oldLines = baselineText.split("\n");
  const newLines = currentText.split("\n");
  const shift = newLines.length - oldLines.length;
  const min = Math.min(oldLines.length, newLines.length);
  let prefix = 0;
  while (prefix < min && normalizeLine(oldLines[prefix]!) === normalizeLine(newLines[prefix]!)) prefix++;
  let suffix = 0;
  while (
    suffix < min - prefix &&
    normalizeLine(oldLines[oldLines.length - 1 - suffix]!) === normalizeLine(newLines[newLines.length - 1 - suffix]!)
  ) {
    suffix++;
  }
  const midOldEnd = oldLines.length - suffix; // 1-based 变更区末行
  const midNewEnd = newLines.length - suffix;

  return (oldLine: number): number => {
    if (oldLine <= prefix) return oldLine; // 前缀区:不动
    if (oldLine > midOldEnd) return oldLine + shift; // 后缀区:整体平移
    // 变更区:平移估计(夹在新区间内),再按旧行内容就近锚定
    const estimate = Math.min(Math.max(oldLine + shift, prefix + 1), Math.max(prefix + 1, midNewEnd));
    const key = normalizeLine(oldLines[oldLine - 1] ?? "");
    if (key === "") return estimate;
    let best = estimate;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = prefix; i < midNewEnd; i++) {
      if (normalizeLine(newLines[i] ?? "") !== key) continue;
      const dist = Math.abs(i + 1 - estimate);
      if (dist < bestDist) {
        bestDist = dist;
        best = i + 1;
      }
    }
    return best;
  };
}

function normalizeLine(line: string): string {
  return line.trim();
}

/* ------------------------------------------------------------------ *
 * 渲染(M108:只报 ERROR / 条数与字符上限 / 控制字符与 HTML 转义)
 * ------------------------------------------------------------------ */

const MAX_MESSAGE_CHARS = 400;
/** 控制字符(C0 + DEL):折叠为空格,防诊断块破坏消息结构。 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * 渲染诊断块(参照 opencode/packages/opencode/src/lsp/diagnostic.ts):
 * 缺省只回灌 ERROR(includeWarnings=true 才带 warning);按行号排序;
 * 上限 max 条 / LSP_DEFAULTS.maxRenderChars 字符;超出注明「…(+N more)」;
 * 消息折叠控制字符并做 HTML 转义(<,>,&)。
 */
export function renderDiagnostics(
  relPath: string,
  items: DiagnosticItem[],
  max: number = LSP_DEFAULTS.maxDiagnostics,
  opts: RenderDiagnosticsOptions = {},
): string | null {
  const includeWarnings = opts.includeWarnings === true;
  const kept = items
    .filter((d) => d.severity === "error" || (includeWarnings && d.severity === "warning"))
    .sort((a, b) => a.line - b.line || a.column - b.column || a.message.localeCompare(b.message));
  if (kept.length === 0) return null;

  const limited = kept.slice(0, Math.max(1, max));
  const header = `<diagnostics file="${escapeAttr(relPath)}"${opts.note ? ` note="${escapeAttr(opts.note)}"` : ""}>`;
  const footer = "</diagnostics>";
  const budget = LSP_DEFAULTS.maxRenderChars - header.length - footer.length - 1;
  const lines: string[] = [];
  let used = 0;
  for (const d of limited) {
    const code = d.code !== undefined ? ` ${escapeText(String(d.code))}` : "";
    const msg = escapeText(d.message.length > MAX_MESSAGE_CHARS ? d.message.slice(0, MAX_MESSAGE_CHARS) + "…" : d.message);
    const line = `L${d.line}:${d.column} ${d.severity}${code}: ${msg}`;
    if (lines.length > 0 && used + line.length + 1 > budget) break; // 字符预算(首条总是放行)
    lines.push(line);
    used += line.length + 1;
  }
  const more = kept.length - lines.length;
  if (more > 0) lines.push(`…(+${more} more)`);
  return `${header}\n${lines.join("\n")}\n${footer}`;
}

/** 消息文本转义:控制字符折叠为空格,<,>,& 实体化(防诊断块破坏消息结构)。 */
function escapeText(s: string): string {
  return s.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 属性值转义(路径/note):在文本转义基础上再转引号。 */
function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}

function relativePath(root: string, absPath: string): string {
  const rel = relative(root, absPath).split(sep).join("/");
  return rel || ".";
}
