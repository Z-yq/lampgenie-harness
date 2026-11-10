/**
 * M115 工具循环护栏(tool-loop-guard):治「同一读取/搜索/失败调用反复重放」「A,B,A,B 批次循环」
 * 「重复结果灌上下文」三类空转(机制 M115)。
 *
 * 本模块是纯函数 + 状态机,不依赖 Journal/AgentLoop;loop 在工具执行段前后接线:
 *   beforeCall() 执行前查 stop/配额(命中=该调用不执行,直接回工具 error);
 *   record()     执行后记账并给出 {notice(前置一行)/stub(只换模型可见文本)/stop(兜底)}。
 *
 * 口径:
 *  - 签名 = `tool|canonicalArgs(args)`(键排序递归 JSON;数组保序;undefined/函数忽略)。
 *  - 同签名连续 3 次 → notice;连续 5 次 → stop(第 5 次在 beforeCall 就被拦下,不执行)。
 *  - 批次周期(2~4 次调用一轮,最近 8 次窗口)重复 2 轮 → notice;第 3 轮 → stop。
 *  - 结果 hash 第 2 次出现且工具只读 → stub(modelContent 换一行占位,journal 原文不动)。
 *  - 每 turn 配额:web_search ≤8、spawn_subagent ≤6(env 可调,0=关)。
 *  - 成功 mutation 重置连击/失败计数;poller 与参数错误/guardrail 拒绝不计失败。
 *  - 状态随 turn 生灭(loop 每 turn new 一个实例),跨 turn 不累积。
 */
import { createHash } from "node:crypto";

/** 被记录调用的归类(loop 按 ToolExecOutcome.error 映射;参数错误/拒绝/取消不算失败)。 */
export type GuardKind = "ok" | "error" | "arg-error" | "guardrail-refusal" | "aborted" | "blocked";

export interface GuardBlock {
  code: "GUARD_STOP" | "GUARD_QUOTA";
  /** 直接作为工具 error 结果回给模型的固定文案(首行带稳定码)。 */
  text: string;
}

export interface RecordDecision {
  /** 前置一行提示(挂在工具结果前面,不单独加一轮)。 */
  notice?: string;
  /** 结果去重占位:替换**模型可见文本**,journal tool.result 原文不变。 */
  stub?: string;
  /** 兜底:同一签名已达 stop 阈值(正常路径已在 beforeCall 拦下)。 */
  stop?: string;
}

export interface ToolLoopGuardOptions {
  /** 每 turn web_search 上限(缺省 8;0=关)。 */
  webSearchMax?: number;
  /** 每 turn spawn_subagent 上限(缺省 6;0=关)。 */
  subagentMax?: number;
  /** env 读取源(测试注入用;缺省 process.env)。 */
  env?: Record<string, string | undefined>;
}

export const GUARD_WEB_SEARCH_ENV = "GENIE_GUARD_WEB_SEARCH_MAX";
export const GUARD_SUBAGENT_ENV = "GENIE_GUARD_SUBAGENT_MAX";
export const DEFAULT_WEB_SEARCH_MAX = 8;
export const DEFAULT_SUBAGENT_MAX = 6;

/** 同签名连击阈值(notice / hard stop)。 */
export const SAME_SIG_NOTICE_AT = 3;
export const SAME_SIG_STOP_AT = 5;
/** 批次周期检测的窗口上限与候选轮长。 */
const RECENT_WINDOW = 8;
const CYCLE_LENGTHS = [2, 3, 4] as const;

/** 结果可 stub 的只读工具(规范化后参数无关)。 */
const STUB_TOOLS = new Set([
  "read_file", "grep", "glob", "list_dir", "web_fetch", "web_search",
  "session_search", "code_sense", "task_output",
]);
/** 无条件视为轮询器(不参与连续失败计数)。wait_until(2026-11-08):超时后重试同参是合法形态。 */
const POLLER_TOOLS = new Set(["task_output", "wait_for", "wait_until"]);
/** 成功即视为 mutation(重置连击/失败计数)。 */
const MUTATION_TOOLS = new Set([
  "write_file", "edit_file", "apply_patch", "board_upsert", "todo_write",
  "deliverable", "board_export_pptx",
]);

/** 递归规范化:对象键排序;数组保序但缺省值补 null;undefined/函数/符号丢弃。 */
function canonicalize(v: unknown): unknown {
  if (v === null) return null;
  const t = typeof v;
  if (t === "undefined" || t === "function" || t === "symbol") return undefined;
  if (t === "bigint") return String(v);
  if (t !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => { const c = canonicalize(x); return c === undefined ? null : c; });
  const src = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src).sort()) {
    const c = canonicalize(src[k]);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

/** 参数规范串(同参不同键序 → 同一签名)。 */
export function canonicalArgs(args: unknown): string {
  const c = canonicalize(args);
  return JSON.stringify(c === undefined ? null : c);
}

/** 调用签名 = 工具名 + 规范参数。 */
export function callSignature(tool: string, args: unknown): string {
  return `${tool}|${canonicalArgs(args)}`;
}

/** 结果指纹(sha1 前 16 位):只用于「结果是否与之前某次逐字相同」。 */
export function resultHashOf(text: string): string {
  return createHash("sha1").update(String(text ?? ""), "utf8").digest("hex").slice(0, 16);
}

function splitSignature(signature: string): { tool: string; args: string } {
  const i = signature.indexOf("|");
  if (i < 0) return { tool: signature, args: "" };
  return { tool: signature.slice(0, i), args: signature.slice(i + 1) };
}

function actionOf(args: string): string | undefined {
  try {
    const p = JSON.parse(args) as { action?: unknown; cmd?: unknown };
    const a = p?.action ?? p?.cmd;
    return typeof a === "string" ? a : undefined;
  } catch {
    return undefined;
  }
}

/** 只读结果去重范围(spec 点名 browser snapshot / job read 两个条件型)。 */
export function isStubTool(tool: string, args: string): boolean {
  if (STUB_TOOLS.has(tool)) return true;
  if (tool === "browser") {
    const a = actionOf(args);
    return a === undefined || a === "snapshot" || a === "screenshot";
  }
  if (tool === "job") return actionOf(args) === "read";
  return false;
}

/** 轮询器:等待类调用本来就会反复出现,不计失败(也不触发 mutation 重置)。 */
export function isPoller(tool: string, args: string): boolean {
  if (POLLER_TOOLS.has(tool)) return true;
  if (tool === "job") { const a = actionOf(args); return a === "wait" || a === "read"; }
  if (tool === "browser") return actionOf(args) === "wait";
  return false;
}

/** 成功即 mutation(有副作用地改变了世界)的工具。 */
export function isMutation(tool: string, args: string): boolean {
  if (MUTATION_TOOLS.has(tool)) return true;
  if (tool === "job") { const a = actionOf(args); return a === "start" || a === "kill"; }
  if (tool === "terminal") return actionOf(args) === "send";
  return false;
}

function limitFromEnv(raw: string | undefined, dflt: number): number {
  if (raw === undefined) return dflt;
  const s = raw.trim();
  if (!s) return dflt;
  const n = Number(s);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(0, Math.floor(n));
}

function sameSlice(sigs: string[], start: number, pattern: string[]): boolean {
  for (let i = 0; i < pattern.length; i += 1) if (sigs[start + i] !== pattern[i]) return false;
  return true;
}

/** 轮换归一:A,B,A 与 B,A,A 等旋转等价形态视为同一周期去重键。 */
function canonicalCycleKey(length: number, pattern: string[]): string {
  let best = pattern.join("¦");
  for (let i = 1; i < pattern.length; i += 1) {
    const rotated = [...pattern.slice(i), ...pattern.slice(0, i)].join("¦");
    if (rotated < best) best = rotated;
  }
  return `${length}:${best}`;
}

export interface GuardStats {
  turn: number;
  stops: number;
  notices: number;
  stubbed: number;
  quotas: number;
}

export class ToolLoopGuard {
  readonly turn: number;
  private readonly webSearchMax: number;
  private readonly subagentMax: number;
  private lastSig = "";
  private streak = 0;
  /** 最近调用签名窗口(批次周期检测用)。 */
  private recent: string[] = [];
  private failStreak = 0;
  private readonly stopped = new Set<string>();
  private readonly resultSeen = new Map<string, number>();
  private readonly cycleNoticed = new Set<string>();
  private readonly toolCalls = new Map<string, number>();
  private callNo = 0;
  private readonly counters = { stops: 0, notices: 0, stubbed: 0, quotas: 0 };

  constructor(turn: number, opts: ToolLoopGuardOptions = {}) {
    this.turn = turn;
    const env = opts.env ?? process.env;
    this.webSearchMax = opts.webSearchMax ?? limitFromEnv(env[GUARD_WEB_SEARCH_ENV], DEFAULT_WEB_SEARCH_MAX);
    this.subagentMax = opts.subagentMax ?? limitFromEnv(env[GUARD_SUBAGENT_ENV], DEFAULT_SUBAGENT_MAX);
  }

  /** 连续失败计数(排除 poller/参数错误/拒绝/取消)。 */
  get failures(): number {
    return this.failStreak;
  }

  stats(): GuardStats {
    return { turn: this.turn, ...this.counters };
  }

  hasActivity(): boolean {
    return this.counters.stops + this.counters.notices + this.counters.stubbed + this.counters.quotas > 0;
  }

  /** 执行前:该签名已 stop / 本次会触达 stop / 配额用尽 → 返回拦截(**调用方不得执行**)。 */
  beforeCall(toolName: string, signature: string): GuardBlock | undefined {
    if (this.stopped.has(signature)) {
      this.counters.stops += 1;
      return { code: "GUARD_STOP", text: this.stoppedText(toolName) };
    }
    const prospectiveStreak = signature === this.lastSig ? this.streak + 1 : 1;
    if (prospectiveStreak >= SAME_SIG_STOP_AT) {
      this.stopped.add(signature);
      this.counters.stops += 1;
      return { code: "GUARD_STOP", text: this.stoppedText(toolName) };
    }
    const cyc = this.cycleLevel([...this.recent, signature]);
    if (cyc && cyc.periods >= 3) {
      this.stopped.add(signature);
      this.counters.stops += 1;
      return { code: "GUARD_STOP", text: this.stoppedText(toolName) };
    }
    const max = toolName === "web_search"
      ? this.webSearchMax
      : toolName === "spawn_subagent" ? this.subagentMax : 0;
    if (max > 0) {
      const used = this.toolCalls.get(toolName) ?? 0;
      if (used >= max) {
        this.counters.quotas += 1;
        return { code: "GUARD_QUOTA", text: this.quotaText(toolName, max) };
      }
      // 预留:同一步并行批(多个 web_search)依次查,不会一起越过上限。
      this.toolCalls.set(toolName, used + 1);
    }
    return undefined;
  }

  /** 执行后记账:返回是否需要前置 notice / 结果 stub(以及兜底 stop)。 */
  record(signature: string, resultHash: string, info: { ok?: boolean; kind?: GuardKind } = {}): RecordDecision {
    this.callNo += 1;
    const { tool, args } = splitSignature(signature);
    const ok = info.ok !== false;
    const kind = info.kind ?? (ok ? "ok" : "error");
    const out: RecordDecision = {};
    const countsFailure = !ok && (kind === "error" || kind === "blocked") && !isPoller(tool, args);

    if (ok && isMutation(tool, args)) {
      // 成功 mutation:世界已变,旧连击/失败账不再有意义。
      this.lastSig = "";
      this.streak = 0;
      this.failStreak = 0;
      this.recent = [];
      return out;
    }

    if (countsFailure) this.failStreak += 1;
    this.streak = signature === this.lastSig ? this.streak + 1 : 1;
    this.lastSig = signature;
    this.recent.push(signature);
    if (this.recent.length > RECENT_WINDOW) this.recent.shift();

    if (this.streak === SAME_SIG_NOTICE_AT) {
      this.counters.notices += 1;
      out.notice = `[循环护栏] 同一调用已连续第 ${this.streak} 次(${tool});重复执行不会带来不同结果——请换参数/换工具/先看结果,再决定下一步。`;
    } else {
      const cyc = this.cycleLevel(this.recent);
      if (cyc && cyc.periods === 2 && !this.cycleNoticed.has(cyc.key)) {
        this.cycleNoticed.add(cyc.key);
        this.counters.notices += 1;
        out.notice = `[循环护栏] 检测到 ${cyc.length} 次调用为一轮的批次循环(已重复 2 轮);同一轮回不会产出新信息——换策略或先读已有结果。`;
      }
    }

    if (this.streak >= SAME_SIG_STOP_AT) {
      this.stopped.add(signature);
      this.counters.stops += 1;
      out.stop = this.stoppedText(tool);
    }

    if (isStubTool(tool, args)) {
      const first = this.resultSeen.get(resultHash);
      if (first !== undefined) {
        this.counters.stubbed += 1;
        out.stub = `[结果与第 ${first} 次调用相同,已省略;需要全文用原调用或 result_read]`;
      } else {
        this.resultSeen.set(resultHash, this.callNo);
      }
    }
    return out;
  }

  private stoppedText(tool: string): string {
    return `[GUARD_STOP] 同一调用连续 ${SAME_SIG_STOP_AT} 次(${tool}),已停止本轮;换策略或向用户确认。`;
  }

  private quotaText(tool: string, max: number): string {
    return `[GUARD_QUOTA] 本轮 ${tool} 调用已达上限 ${max} 次;换工具/换策略,或直接基于已有结果继续。`;
  }

  /** 最近窗口里尾部的最大周期重复:返回轮长/轮数/去重键。 */
  private cycleLevel(sigs: string[]): { length: number; periods: number; key: string } | undefined {
    let best: { length: number; periods: number; key: string } | undefined;
    for (const L of CYCLE_LENGTHS) {
      if (sigs.length < 2 * L) continue;
      const pattern = sigs.slice(-L);
      // 同签名连击由 streak 单独计数(周期全同会把它重复报成批次循环),这里只认真正的交替轮次。
      if (pattern.every((p) => p === pattern[0])) continue;
      let periods = 1;
      for (let i = sigs.length - L; i - L >= 0; i -= L) {
        if (!sameSlice(sigs, i - L, pattern)) break;
        periods += 1;
      }
      if (periods < 2) continue;
      if (!best || periods > best.periods) best = { length: L, periods, key: canonicalCycleKey(L, pattern) };
    }
    return best;
  }
}
