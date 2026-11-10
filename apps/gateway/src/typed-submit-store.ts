/**
 * typed submit 台账(RSI #31):`<root>/.genie/rsi/typed-submits.json`,整文件原子写(tmp + rename)。
 * 数据面:
 *   { v:1, asks: { [askId]: { state: TypedAskState, schema: JsonSchema } } }
 * 纯逻辑(校验 / 次数 / nudge)在 packages/harness-runtime/src/agent/typed-submit.ts,
 * 本文件只做持久化与投影(open / submit / nudge / report)。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  createTypedAsk,
  nudgeIfNoSubmit,
  submitResult,
  TYPED_INVALID,
  TYPED_NOT_FOUND,
  type JsonSchema,
  type NudgeOutcome,
  type SubmitOutcome,
  type TypedAskState,
  type Violation,
} from "@lampgenie/runtime/agent/typed-submit";

export interface TypedSubmitEntry {
  state: TypedAskState;
  schema: JsonSchema;
}

export interface TypedSubmitFile {
  v: 1;
  asks: Record<string, TypedSubmitEntry>;
}

export interface TypedSubmitReportRow {
  askId: string;
  status: TypedAskState["status"];
  attempts: number;
  nudged: boolean;
}

export interface TypedSubmitReport {
  total: number;
  open: number;
  settled: number;
  failed: number;
  nudged: number;
  byAttempts: Record<string, number>;
  asks: TypedSubmitReportRow[];
}

export interface TypedSubmitOpResult {
  ok: boolean;
  codes: string[];
  entry?: TypedSubmitEntry;
  violations?: Violation[];
  message?: string;
  reason?: string;
}

/** 台账相对路径(相对仓库根)。 */
export const TYPED_SUBMIT_REL = join(".genie", "rsi", "typed-submits.json");

/** 台账文件绝对路径。 */
export function typedSubmitPath(root: string): string {
  return join(root, TYPED_SUBMIT_REL);
}

function emptyFile(): TypedSubmitFile {
  return { v: 1, asks: {} };
}

/** 读台账;文件缺失或损坏时返回空台账(不抛)。 */
export function readTypedSubmitFile(root: string): TypedSubmitFile {
  const path = typedSubmitPath(root);
  if (!existsSync(path)) return emptyFile();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TypedSubmitFile>;
    const asks: Record<string, TypedSubmitEntry> = {};
    const raw = parsed && typeof parsed === "object" ? parsed.asks : undefined;
    if (raw && typeof raw === "object") {
      for (const [askId, entry] of Object.entries(raw)) {
        if (!entry || typeof entry !== "object") continue;
        const state = (entry as TypedSubmitEntry).state;
        if (!state || typeof state !== "object" || typeof state.askId !== "string") continue;
        asks[askId] = { state, schema: (entry as TypedSubmitEntry).schema ?? {} };
      }
    }
    return { v: 1, asks };
  } catch {
    return emptyFile();
  }
}

/** 原子写台账:先写 `<path>.tmp-<pid>-<ts>` 再 rename;失败时清掉临时文件。 */
export function writeTypedSubmitFile(root: string, file: TypedSubmitFile): string {
  const path = typedSubmitPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ v: 1, asks: file.asks }, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return path;
}

function badCode(code: string, reason: string): TypedSubmitOpResult {
  return { ok: false, codes: [code], message: reason, reason };
}

/** 新建 ask;askId 非法或已存在(open/settled/failed)一律拒收。 */
export function openTypedSubmit(
  root: string,
  askId: string,
  schema: JsonSchema): TypedSubmitOpResult {
  if (typeof askId !== "string" || askId.trim() === "") {
    return badCode(TYPED_INVALID, "ask-id-required");
  }
  if (!schema || typeof schema !== "object") {
    return badCode(TYPED_INVALID, "schema-required");
  }
  const file = readTypedSubmitFile(root);
  if (file.asks[askId]) {
    return badCode(TYPED_INVALID, "ask-exists");
  }
  const entry: TypedSubmitEntry = { state: createTypedAsk(askId), schema };
  file.asks[askId] = entry;
  writeTypedSubmitFile(root, file);
  return { ok: true, codes: [], entry };
}

/** 提交 payload:走 schema 校验,只有通过才 settle;结果落盘后返回。 */
export function submitTypedSubmit(
  root: string,
  askId: string,
  payload: unknown): TypedSubmitOpResult {
  if (typeof askId !== "string" || askId.trim() === "") {
    return badCode(TYPED_INVALID, "ask-id-required");
  }
  const file = readTypedSubmitFile(root);
  const entry = file.asks[askId];
  if (!entry) return badCode(TYPED_NOT_FOUND, "ask-not-found");

  const outcome: SubmitOutcome = submitResult(entry.state, payload, entry.schema);
  file.asks[askId] = { state: outcome.state, schema: entry.schema };
  writeTypedSubmitFile(root, file);
  return {
    ok: outcome.ok,
    codes: outcome.codes,
    entry: file.asks[askId],
    violations: outcome.violations,
  };
}

/** turn 结束时补 nudge(只一次);已 nudge 仍无 submit → failed。 */
export function nudgeTypedSubmit(root: string, askId: string): TypedSubmitOpResult {
  if (typeof askId !== "string" || askId.trim() === "") {
    return badCode(TYPED_INVALID, "ask-id-required");
  }
  const file = readTypedSubmitFile(root);
  const entry = file.asks[askId];
  if (!entry) return badCode(TYPED_NOT_FOUND, "ask-not-found");

  const outcome: NudgeOutcome = nudgeIfNoSubmit(entry.state, { turnEnded: true });
  file.asks[askId] = { state: outcome.state, schema: entry.schema };
  writeTypedSubmitFile(root, file);
  return {
    ok: outcome.nudged,
    codes: outcome.codes,
    entry: file.asks[askId],
    message: outcome.message,
  };
}

/** 汇总投影:状态计数 / 次数分布 / 逐 ask 行。 */
export function reportTypedSubmits(root: string): TypedSubmitReport {
  const file = readTypedSubmitFile(root);
  const asks = Object.values(file.asks)
    .map(({ state }) => state)
    .sort((a, b) => a.askId.localeCompare(b.askId));
  const report: TypedSubmitReport = {
    total: asks.length,
    open: 0,
    settled: 0,
    failed: 0,
    nudged: 0,
    byAttempts: {},
    asks: [],
  };
  for (const state of asks) {
    report[state.status] += 1;
    if (state.nudged) report.nudged += 1;
    const key = String(state.attempts);
    report.byAttempts[key] = (report.byAttempts[key] ?? 0) + 1;
    report.asks.push({
      askId: state.askId,
      status: state.status,
      attempts: state.attempts,
      nudged: state.nudged,
    });
  }
  return report;
}
