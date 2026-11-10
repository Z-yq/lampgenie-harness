/**
 * 会话查询游标的持久层:把 session-cursor 的纯逻辑落到单一 JSON state 文件。
 * 数据面:`<root>/.genie/rsi/cursor-state.json`
 * {v:1, generation, issued:[{id,generation,queryFingerprint,at}], bumps:[{cause,from,to,at}]}
 * - generation 是当前语料版本,读时不存在 / 坏 JSON / 坏字段一律回落 1:单条坏文件不能杀死整个 CLI。
 * - issued 是已签发游标的台账(只增),用来回答「这个游标是不是我们发的」与观察膨胀;
 * - bumps 是 generation 推进留痕,回答「什么时候因为什么变过」。
 * 为什么原子写:直接覆盖 state 文件时若写一半崩溃/被 kill,留下的就是坏 JSON,下次读回落 1 会让
 * 所有在途游标凭空 stale。所以先写同目录临时文件再 renameSync 覆盖(rename 在同一文件系统内是原子的),
 * 成功后目录里不留 `.tmp`(失败路径主动 rmSync 清理)。
 * 依赖纪律:node:fs / node:path + runtime 的纯逻辑模块(不引 agent loop、不引 gateway 其余业务模块)。
 * runtime 模块按 cohort-signature-store 的既有套路惰性解析(两跳):
 * ① 带 `--conditions=development` 的运行时(vitest)走包导出 src 入口;
 * ② 裸 tsx/dist 缺该文件时回退到仓内源文件(new URL,避免静态 .ts specifier 触发 TS5097/TS6059)。
 * 除参数错误(root 非法)外不 throw:IO / 投影失败一律折叠成稳定码返回。
 * store 自产的码(CURSOR_STORE_*)与 runtime 的 CURSOR_* 分开:前者说「存/取失败」,后者说「游标能不能用」。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type {
  CursorEnvelope,
  CursorPayload,
  GenerationCause,
} from "@lampgenie/runtime/agent/session-cursor";

/** store 稳定码:store 层自产的失败码(游标判定码沿用 runtime 的 CURSOR_*)。 */
export const CURSOR_STORE_CODES = [
  "CURSOR_STORE_ERROR",
  "CURSOR_STORE_WRITE_FAILED",
  "CURSOR_STORE_BAD_STATE",
] as const;

export type CursorStoreCode = (typeof CURSOR_STORE_CODES)[number];

/** 已签发游标台账条目。 */
export interface IssuedCursorRecord {
  id: string;
  generation: number;
  queryFingerprint: string;
  at: number;
}

/** generation 推进留痕条目。 */
export interface CursorBumpRecord {
  cause: string;
  from: number;
  to: number;
  at: number;
}

export interface CursorState {
  v: 1;
  generation: number;
  issued: IssuedCursorRecord[];
  bumps: CursorBumpRecord[];
}

export interface IssueRequest {
  query: unknown;
  position?: { beforeSeq?: number; afterSeq?: number } | undefined;
}

export interface IssueResult {
  ok: boolean;
  code: string;
  generation: number;
  id?: string;
  envelope?: CursorEnvelope;
  codes: string[];
}

export interface ValidateRequest {
  query: unknown;
}

export interface ValidateResult {
  ok: boolean;
  code: string;
  detail: string;
  generation: number;
}

export interface BumpRequest {
  cause: GenerationCause;
}

export interface BumpResult {
  ok: boolean;
  code: string;
  from: number;
  to: number;
  generation: number;
  codes: string[];
}

export interface ReconcileRequest {
  causes: readonly unknown[];
}

export interface ReconcileResult {
  ok: boolean;
  code: string;
  generation: number;
  applied: string[];
  codes: string[];
}

export interface CursorStoreReport {
  generation: number;
  issued: number;
  bumps: number;
  stale: number;
  causes: string[];
  codes: string[];
}

/** 两跳解析所需的 runtime 面(只声明用到的函数,便于替换与静态检查)。 */
interface CursorRuntime {
  issueCursor(options: {
    generation: number;
    query: unknown;
    position?: { beforeSeq?: number; afterSeq?: number } | undefined;
    at?: number;
  }): CursorEnvelope;
  validateCursor(
    envelope: unknown,
    options: { currentGeneration: number; query: unknown },
  ): { ok: boolean; code: string; detail: string };
  parseCursor(envelope: unknown): { payload?: CursorPayload; code?: string };
  queryFingerprint(query: unknown): string;
  nextGeneration(current: unknown, cause: GenerationCause): number;
  reconcile(
    events: readonly unknown[],
    options: { cursorGen: number },
  ): { generation: number; applied: string[] };
}

let cursorRuntime: CursorRuntime | undefined;

/** 两跳解析 runtime 模块(见文件头依赖纪律)。 */
async function loadCursorRuntime(): Promise<CursorRuntime> {
  if (cursorRuntime) return cursorRuntime;
  const spec = "@lampgenie/runtime/agent/session-cursor";
  try {
    cursorRuntime = (await import(spec)) as CursorRuntime;
  } catch {
    const srcUrl = new URL(
      "../../../packages/harness-runtime/src/agent/session-cursor.ts",
      import.meta.url).href;
    cursorRuntime = (await import(srcUrl)) as CursorRuntime;
  }
  return cursorRuntime;
}

/** runtime 面(顶层 await:所有导出函数保持同步签名)。 */
const rt = await loadCursorRuntime();

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function assertRoot(root: unknown): string {
  if (typeof root !== "string" || root.trim() === "") throw new Error("root 必须是非空字符串");
  return root;
}

function generationOf(value: unknown): number {
  if (!isFiniteNumber(value)) return 1;
  const truncated = Math.trunc(value);
  return truncated >= 1 ? truncated : 1;
}

/** state 文件绝对路径:`<root>/.genie/rsi/cursor-state.json`。 */
export function cursorStatePath(root: string): string {
  const base = assertRoot(root);
  return join(base, ".genie", "rsi", "cursor-state.json");
}

function emptyState(): CursorState {
  return { v: 1, generation: 1, issued: [], bumps: [] };
}

function issuedOf(value: unknown): IssuedCursorRecord[] {
  const list: readonly unknown[] = Array.isArray(value) ? value : [];
  const out: IssuedCursorRecord[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const id = item["id"];
    const fingerprint = item["queryFingerprint"];
    const at = item["at"];
    if (typeof id !== "string" || id === "") continue;
    if (typeof fingerprint !== "string" || fingerprint === "") continue;
    if (!isFiniteNumber(at)) continue;
    out.push({ id, generation: generationOf(item["generation"]), queryFingerprint: fingerprint, at: Math.trunc(at) });
  }
  return out;
}

function bumpsOf(value: unknown): CursorBumpRecord[] {
  const list: readonly unknown[] = Array.isArray(value) ? value : [];
  const out: CursorBumpRecord[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const cause = item["cause"];
    const from = item["from"];
    const to = item["to"];
    const at = item["at"];
    if (typeof cause !== "string" || cause === "") continue;
    if (!isFiniteNumber(from) || !isFiniteNumber(to) || !isFiniteNumber(at)) continue;
    out.push({ cause, from: Math.trunc(from), to: Math.trunc(to), at: Math.trunc(at) });
  }
  return out;
}

/**
 * 读 state:缺文件按空态(不记码),坏 JSON / 坏形状按空态 + CURSOR_STORE_BAD_STATE。
 * 两条都不 throw——一份坏文件只该损失历史台账,不该让 CLI 整体不可用。
 */
function readState(root: string): { state: CursorState; codes: string[] } {
  const path = cursorStatePath(root);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { state: emptyState(), codes: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { state: emptyState(), codes: ["CURSOR_STORE_BAD_STATE"] };
  }
  if (!isRecord(parsed)) return { state: emptyState(), codes: ["CURSOR_STORE_BAD_STATE"] };
  if (parsed["v"] !== 1) return { state: emptyState(), codes: ["CURSOR_STORE_BAD_STATE"] };
  return {
    state: {
      v: 1,
      generation: generationOf(parsed["generation"]),
      issued: issuedOf(parsed["issued"]),
      bumps: bumpsOf(parsed["bumps"]),
    },
    codes: [],
  };
}

/** 原子写:同目录临时文件 → renameSync 覆盖;失败时清掉临时文件并返回 false(不 throw)。 */
function writeState(root: string, state: CursorState): boolean {
  const path = cursorStatePath(root);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // 清理失败不掩盖主错误:下面的返回值已经说明写入没成功。
    }
    return false;
  }
  return true;
}

/** 当前语料 generation;文件不存在 / 坏 JSON / 坏字段 → 1。 */
export function currentGeneration(root: string): number {
  const base = assertRoot(root);
  return readState(base).state.generation;
}

/** 签发游标:用当前 generation 封装查询与翻页位置,并把台账条目落盘。 */
export function issue(root: string, request: IssueRequest): IssueResult {
  const base = assertRoot(root);
  const { state, codes } = readState(base);
  const at = Date.now();
  const envelope = rt.issueCursor({
    generation: state.generation,
    query: request.query,
    position: request.position,
    at,
  });
  const record: IssuedCursorRecord = {
    id: `cur_${at}_${state.issued.length + 1}`,
    generation: state.generation,
    queryFingerprint: envelope.payload.queryFingerprint,
    at,
  };
  const next: CursorState = { ...state, issued: [...state.issued, record] };
  if (!writeState(base, next)) {
    return {
      ok: false,
      code: "CURSOR_STORE_WRITE_FAILED",
      generation: state.generation,
      codes: [...codes, "CURSOR_STORE_WRITE_FAILED"],
    };
  }
  return {
    ok: true,
    code: "CURSOR_ISSUED",
    generation: state.generation,
    id: record.id,
    envelope,
    codes,
  };
}

/** 校验游标:判定完全交给 runtime(四码 + STALE 先于指纹),store 只提供当前 generation。 */
export function validate(root: string, envelope: unknown, request: ValidateRequest): ValidateResult {
  const base = assertRoot(root);
  const { state } = readState(base);
  const verdict = rt.validateCursor(envelope, { currentGeneration: state.generation, query: request.query });
  return {
    ok: verdict.ok,
    code: verdict.code,
    detail: verdict.detail,
    generation: state.generation,
  };
}

/** 推进 generation(单条 cause),并留痕 from/to。 */
export function bump(root: string, request: BumpRequest): BumpResult {
  const base = assertRoot(root);
  const { state, codes } = readState(base);
  const from = state.generation;
  const to = rt.nextGeneration(from, request.cause);
  const at = Date.now();
  const next: CursorState = {
    ...state,
    generation: to,
    bumps: [...state.bumps, { cause: request.cause, from, to, at }],
  };
  if (!writeState(base, next)) {
    return { ok: false, code: "CURSOR_STORE_WRITE_FAILED", from, to, generation: from, codes: [...codes, "CURSOR_STORE_WRITE_FAILED"] };
  }
  return { ok: true, code: "CURSOR_GENERATION_BUMPED", from, to, generation: to, codes };
}

/**
 * 批量应用语料变更(单事务:读一次盘、写一次盘):同一 cause 只推进一格,
 * applied 去重且保持首次出现顺序;generation = 原 generation + applied.length。
 */
export function reconcile(root: string, request: ReconcileRequest): ReconcileResult {
  const base = assertRoot(root);
  const { state, codes } = readState(base);
  const causes: readonly unknown[] = Array.isArray(request.causes) ? request.causes : [];
  const result = rt.reconcile(causes, { cursorGen: state.generation });
  if (result.applied.length === 0) {
    return { ok: true, code: "CURSOR_GENERATION_BUMPED", generation: state.generation, applied: [], codes };
  }
  const at = Date.now();
  let running = state.generation;
  const bumps: CursorBumpRecord[] = [...state.bumps];
  for (const cause of result.applied) {
    bumps.push({ cause, from: running, to: running + 1, at });
    running += 1;
  }
  const next: CursorState = { ...state, generation: result.generation, bumps };
  if (!writeState(base, next)) {
    return {
      ok: false,
      code: "CURSOR_STORE_WRITE_FAILED",
      generation: state.generation,
      applied: [],
      codes: [...codes, "CURSOR_STORE_WRITE_FAILED"],
    };
  }
  return { ok: true, code: "CURSOR_GENERATION_BUMPED", generation: result.generation, applied: result.applied, codes };
}

/** 台账报表:generation、签发/推进条数、已过期的游标条数(可观测膨胀点)、出现过的 cause。 */
export function report(root: string): CursorStoreReport {
  const base = assertRoot(root);
  const { state, codes } = readState(base);
  let stale = 0;
  for (const record of state.issued) if (record.generation !== state.generation) stale += 1;
  const causes: string[] = [];
  for (const record of state.bumps) if (!causes.includes(record.cause)) causes.push(record.cause);
  return {
    generation: state.generation,
    issued: state.issued.length,
    bumps: state.bumps.length,
    stale,
    causes,
    codes,
  };
}
