/**
 * 任务级验证账本(M107),纯函数层(2026-11-07)。
 *
 * 口径:任务收尾时回答「本次任务最后一次成功跑验证/测试命令之后,是否又改过代码」。
 * 数据源只有本任务的 journal 事件(调用方用 `journal.readSession(sessionId, taskStartSeq)` 切片,
 * 不全量 readAll):terminal 工具调用 + 对应 tool.result 成败 + 文件写工具调用的 path。
 *
 * 三条判据(全部确定性,不调 LLM):
 *  1) 验证命令:name="terminal" 且 command 命中 vitest/jest/pytest/go test/cargo test/npm test/
 *     pnpm test/yarn test/tsc/eslint/lint/build/playwright(词边界、大小写不敏感),排除 --watch;
 *     对应 tool.result(toolCallId 匹配)必须不是错误/超时;
 *  2) 代码写:edit_file/write_file/apply_patch 的 path 扩展名属代码集;文档(.md/.mdx/.txt/.rst)
 *     不计(文档改动不需要跑测试,抑制提示);
 *  3) stale:存在代码写 seq > 最后一次成功验证 seq;无验证命令且有代码写 → stale(no-verification)。
 *
 * 子代理的 spawn_subagent 不算验证(子代理内部的 terminal 事件不在本事件流里,如实 false)。
 */
import { extname, isAbsolute, relative, sep } from "node:path";

/** journal 事件最小面(测试可直接喂普通对象)。 */
export interface VerifyLedgerEvent {
  seq: number;
  kind: string;
  time?: number;
  payload?: unknown;
}

export type VerifyLedgerReason = "ok" | "no-verification" | "writes-after-verification";

export interface VerificationHit {
  command: string;
  seq: number;
  at: number;
}

export interface VerifyLedgerWrite {
  file: string;
  seq: number;
}

export interface VerifyLedger {
  verificationCount: number;
  lastVerification: VerificationHit | null;
  /** 最后一次成功验证之后写过的代码文件(≤10 条,按 seq 升序)。 */
  writesAfter: VerifyLedgerWrite[];
  /** 代码写总条数(提示文案「改了 N 个文件」与「无验证」判定用)。 */
  codeWriteCount: number;
  stale: boolean;
  reason: VerifyLedgerReason;
}

/** 验证类命令的特征词(词边界、大小写不敏感)。 */
const VERIFY_COMMAND_RE =
  /\b(vitest|jest|pytest|go\s+test|cargo\s+test|npm\s+test|pnpm\s+test|yarn\s+test|tsc|eslint|lint|build|playwright)\b/i;

/** 代码文件扩展名(改动后应重新验证);文档类不进此表(抑制)。 */
const CODE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".java", ".rs", ".c", ".cc", ".cpp", ".h", ".hpp",
  ".cs", ".rb", ".php", ".swift", ".kt", ".kts", ".scala", ".vue", ".svelte",
]);

/** 文档扩展名:写它们不触发 stale(B5「文档抑制」)。 */
const DOC_EXT = new Set([".md", ".mdx", ".txt", ".rst"]);

const WRITE_TOOLS = new Set(["edit_file", "write_file", "apply_patch"]);

/** writesAfter 上限(回执/journal 不膨胀)。 */
const MAX_WRITES = 10;

/** 命令是否算「验证类」:命中特征词且不是 watch 模式(长驻进程不产生一次性结论)。 */
export function isVerificationCommand(command: string): boolean {
  const cmd = String(command ?? "");
  if (!cmd.trim()) return false;
  if (/--watch\b/i.test(cmd)) return false;
  return VERIFY_COMMAND_RE.test(cmd);
}

/** tool.result 是否表示失败:结构化 error 字段在场,或文案以「错误」「[browser 失败]」开头。 */
export function isFailedToolResult(content: unknown, error?: unknown): boolean {
  if (error) return true;
  const text = typeof content === "string" ? content.trim() : "";
  return /^(错误|\[browser 失败\])/.test(text);
}

function payloadOf(e: VerifyLedgerEvent): Record<string, unknown> {
  return (e.payload && typeof e.payload === "object" ? e.payload : {}) as Record<string, unknown>;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 写工具调用的目标路径(apply_patch 也走 path;拿不到就跳过该事件)。 */
function writtenPath(payload: Record<string, unknown>): string {
  const a = parseArgs(payload.arguments);
  return typeof a.path === "string" ? a.path.trim() : "";
}

function relTo(root: string | undefined, p: string): string {
  if (!root || !isAbsolute(p)) return p;
  const r = relative(root, p);
  if (!r || r.startsWith("..")) return p;
  return r.split(sep).join("/");
}

/** 全部代码写事件(按 seq 升序):文档扩展名与无扩展名一律不计。 */
function codeWrites(events: readonly VerifyLedgerEvent[], root?: string): VerifyLedgerWrite[] {
  const out: VerifyLedgerWrite[] = [];
  for (const e of events) {
    if (e.kind !== "tool.call") continue;
    const p = payloadOf(e);
    if (!WRITE_TOOLS.has(String(p.name ?? ""))) continue;
    const path = writtenPath(p);
    if (!path) continue;
    const ext = extname(path).toLowerCase();
    if (DOC_EXT.has(ext)) continue;
    if (!CODE_EXT.has(ext)) continue;
    out.push({ file: relTo(root, path), seq: Number(e.seq) || 0 });
  }
  return out;
}

/** 成功验证命令(按 seq 升序):terminal 调用 + 同 toolCallId 的非失败 result。 */
function successfulVerifications(events: readonly VerifyLedgerEvent[]): VerificationHit[] {
  const calls = new Map<string, { command: string; seq: number; at: number }>();
  for (const e of events) {
    if (e.kind !== "tool.call") continue;
    const p = payloadOf(e);
    if (String(p.name ?? "") !== "terminal") continue;
    const id = String(p.toolCallId ?? "");
    const a = parseArgs(p.arguments);
    const command = typeof a.command === "string" ? a.command.trim() : "";
    if (!id || !isVerificationCommand(command)) continue;
    calls.set(id, { command, seq: Number(e.seq) || 0, at: typeof e.time === "number" ? e.time : 0 });
  }
  if (!calls.size) return [];
  const out: VerificationHit[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (e.kind !== "tool.result") continue;
    const p = payloadOf(e);
    const id = String(p.toolCallId ?? "");
    const call = calls.get(id);
    if (!call || seen.has(id)) continue;
    if (isFailedToolResult(p.content, p.error)) continue;
    seen.add(id);
    out.push(call);
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/**
 * 本任务验证账本。`root` 只用于把绝对写路径展示成项目相对路径(判据不依赖它)。
 */
export function computeVerifyLedger(events: readonly VerifyLedgerEvent[], root?: string): VerifyLedger {
  const evs = [...events].sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
  const verifications = successfulVerifications(evs);
  const writes = codeWrites(evs, root);
  const last = verifications.length ? verifications[verifications.length - 1]! : null;
  const after = last ? writes.filter((w) => w.seq > last.seq) : writes;
  const stale = after.length > 0;
  return {
    verificationCount: verifications.length,
    lastVerification: last,
    writesAfter: after.slice(-MAX_WRITES),
    codeWriteCount: writes.length,
    stale,
    reason: stale ? (last ? "writes-after-verification" : "no-verification") : "ok",
  };
}

function fileList(writes: readonly VerifyLedgerWrite[], cap = 6): string {
  const names = writes.slice(-cap).map((w) => w.file).join("、");
  return writes.length > cap ? `${names} 等 ${writes.length} 个` : names;
}

/** warn 模式的可见提示(收尾追加进 finalOut);不 stale 返回 ""。 */
export function renderVerifyLedgerWarning(ledger: VerifyLedger): string {
  if (!ledger.stale) return "";
  const files = fileList(ledger.writesAfter);
  if (ledger.reason === "no-verification") {
    return `[验证账本] 本任务改了 ${ledger.codeWriteCount} 个代码文件但没有任何验证命令记录(${files})——先跑验证/测试再宣称完成。`;
  }
  return `[验证账本] 最近一次验证之后又改了 ${ledger.writesAfter.length} 个代码文件:${files}——先跑验证/测试再宣称完成。`;
}

/** hard 模式的补跑指令(runTurn 系统消息)。 */
export function renderVerifyRetryPrompt(ledger: VerifyLedger): string {
  const files = fileList(ledger.writesAfter, 8);
  const tail = ledger.reason === "no-verification"
    ? "本任务没有任何验证/测试命令记录"
    : `最近一次验证之后又改了 ${ledger.writesAfter.length} 个代码文件:${files}`;
  return `[验证账本补跑] ${tail}。现在先跑本轮改动对应的验证/测试命令(terminal,例如 npx vitest run <相关测试>),确认通过后再宣称完成。`;
}
