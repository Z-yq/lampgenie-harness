/**
 * 改派导入(amend-import)持久层:把 runtime 的纯裁决落到单一 JSON 账本。
 * 数据面:`<root>/.genie/rsi/amend.json`
 *   {
 *     "v": 1,
 *     "run"?: RunState,                 // 上一次读入/预检过的 run 快照
 *     "precheck"?: AmendResult | null,  // 最近一次预检结论
 *     "cache"?: ImportCache | null,     // 导入缓存(可跨进程复用)
 *     "diverged"?: string[],            // 已判定 hash 分叉的 askId(单调累积)
 *     "resume"?: { mode, codes } | null,
 *     "lastAction"?: string,
 *     "updatedAt"?: number
 *   }
 * 为什么是单文件整账本:改派导入的关键不变量是「跨进程单调」——第二个 CLI 进程
 * 不得把已经判为分叉(HASH_DIVERGED)的 ask 回落到 HIT,也不得在门关上(DOOR_CLOSED)
 * 之后重新开一条世界写。整账本 + 临时文件 rename 原子替换,让「读到的永远是某一完整代」
 * 成立:崩溃最多丢掉最后一次未 rename 的写。
 * 失败口径:
 * - 参数错误(TypeError)是唯一 throw 的情形。
 * - 读失败(文件不存在 = 首次;JSON 坏 / 形状坏)→ 折叠成 AMEND_STORE_ERROR,**写操作拒写**
 *   (坏账本上先落库会掩盖原始损坏,宁可停下等人看)。
 * - 写后校验(读回 v 与 lastAction 一致)不过 → AMEND_STORE_WRITE_MISMATCH(不 throw)。
 * - 业务拒绝沿用 runtime 的 AMEND_* 稳定码,且拒收前不落盘(预检失败时**不调** stopPredecessor)。
 * 依赖纪律:node:fs / node:path + runtime 纯逻辑(经 workspace 子路径导入)。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  AMEND_BOUNDARY_MISSING,
  AMEND_DOOR_CLOSED,
  AMEND_FALLBACK_LIVE,
  AMEND_HASH_DIVERGED,
  AMEND_INVALID,
  AMEND_RUN_MISSING,
  AMEND_SKIP_SETTLEMENT,
  AMEND_TARGET_DIRTY,
  buildImportCache,
  closeOnWorldWrite,
  emptyImportCache,
  matchImport,
  precheck,
  resumeRebuild,
  stopPredecessor,
  type AmendCode,
  type AmendResult,
  type AskRecord,
  type AskStatus,
  type ImportCache,
  type ImportedNode,
  type RunState,
  type TargetSession,
} from "@lampgenie/runtime/agent/amend-import";

/** store 层自产的失败码(业务拒绝沿用 runtime 的 AMEND_* 码)。 */
export const AMEND_STORE_CODES = ["AMEND_STORE_ERROR", "AMEND_STORE_WRITE_MISMATCH"] as const;

export type AmendStoreCode = (typeof AMEND_STORE_CODES)[number];

export const AMEND_STORE_ERROR: AmendStoreCode = "AMEND_STORE_ERROR";
export const AMEND_STORE_WRITE_MISMATCH: AmendStoreCode = "AMEND_STORE_WRITE_MISMATCH";

/** 账本路径(目录 + 文件各一份,便于上层建目录/守护)。 */
export interface AmendPaths {
  dir: string;
  file: string;
}

/** 相对仓库根的账本位置。 */
export const AMEND_RELATIVE_DIR = ".genie/rsi";
export const AMEND_FILE = "amend.json";

let tmpSeq = 0;

/** 解析账本路径;root 必填。 */
export function amendPaths(root: string): AmendPaths {
  if (typeof root !== "string" || root.trim() === "") throw new TypeError("amendPaths: root 必须是非空字符串");
  const dir = join(root, AMEND_RELATIVE_DIR);
  return { dir, file: join(dir, AMEND_FILE) };
}

/* ------------------------------------------------------------------ */
/* 形状归一(账本读写都过这一层,坏形状一律折叠成 STORE_ERROR)          */
/* ------------------------------------------------------------------ */

const ASK_STATUSES: readonly AskStatus[] = ["completed", "running", "failed"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeAsk(raw: unknown): AskRecord | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw["id"]);
  if (id === "") return null;
  const statusRaw = asString(raw["status"], "running");
  const status: AskStatus = (ASK_STATUSES as readonly string[]).includes(statusRaw) ? (statusRaw as AskStatus) : "running";
  const record: AskRecord = { id, actor: asString(raw["actor"]), status };
  const boundary = asString(raw["messageBoundary"]);
  if (boundary !== "") record.messageBoundary = boundary;
  if (typeof raw["toolCalls"] === "number" && Number.isFinite(raw["toolCalls"])) record.toolCalls = raw["toolCalls"];
  const hash = asString(raw["payloadHash"]);
  if (hash !== "") record.payloadHash = hash;
  return record;
}

/** JSON → RunState(缺字段补默认;run 本身不是对象 = null,由调用方折叠成 STORE_ERROR)。 */
export function normalizeRunState(raw: unknown): RunState | null {
  if (!isRecord(raw)) return null;
  const asks: AskRecord[] = [];
  if (Array.isArray(raw["asks"])) {
    for (const item of raw["asks"]) {
      const ask = normalizeAsk(item);
      if (ask !== null) asks.push(ask);
    }
  }
  const worldQueue: { id: string; payloadHash: string }[] = [];
  if (Array.isArray(raw["worldQueue"])) {
    for (const item of raw["worldQueue"]) {
      if (!isRecord(item)) continue;
      const id = asString(item["id"]);
      if (id === "") continue;
      worldQueue.push({ id, payloadHash: asString(item["payloadHash"]) });
    }
  }
  const run: RunState = {
    runId: asString(raw["runId"]),
    exists: typeof raw["exists"] === "boolean" ? raw["exists"] : true,
    asks,
    worldQueue,
  };
  const rawTarget = raw["target"];
  if (isRecord(rawTarget)) {
    const target: { sessionId?: string; seeds?: string[]; history?: string[] } = {};
    const sessionId = asString(rawTarget["sessionId"]);
    if (sessionId !== "") target.sessionId = sessionId;
    if (Array.isArray(rawTarget["seeds"])) target.seeds = asStringArray(rawTarget["seeds"]);
    if (Array.isArray(rawTarget["history"])) target.history = asStringArray(rawTarget["history"]);
    run.target = target;
  }
  return run;
}

/* ------------------------------------------------------------------ */
/* 账本读写                                                           */
/* ------------------------------------------------------------------ */

/** 账本内存形状。diverged 恒为数组(便于单调累积)。 */
export interface AmendLedger {
  v: 1;
  run?: RunState;
  precheck?: AmendResult | null;
  cache?: ImportCache | null;
  diverged: string[];
  resume?: { mode: "cache" | "live"; codes: string[] } | null;
  lastAction?: string;
  updatedAt?: number;
}

export function emptyAmendLedger(): AmendLedger {
  return { v: 1, diverged: [] };
}

function normalizeCache(raw: unknown): ImportCache | null {
  if (!isRecord(raw)) return null;
  const actorPrefix: Record<string, AskRecord[]> = {};
  const rawPrefix = raw["actorPrefix"];
  if (isRecord(rawPrefix)) {
    for (const [actor, list] of Object.entries(rawPrefix)) {
      if (!Array.isArray(list)) continue;
      const asks: AskRecord[] = [];
      for (const item of list) {
        const ask = normalizeAsk(item);
        if (ask !== null) asks.push(ask);
      }
      actorPrefix[actor] = asks;
    }
  }
  const worldQueue: { id: string; payloadHash: string }[] = [];
  if (Array.isArray(raw["worldQueue"])) {
    for (const item of raw["worldQueue"]) {
      if (!isRecord(item)) continue;
      const id = asString(item["id"]);
      if (id === "") continue;
      worldQueue.push({ id, payloadHash: asString(item["payloadHash"]) });
    }
  }
  return { actorPrefix, worldQueue, closed: raw["closed"] === true };
}

function normalizeResult(raw: unknown): AmendResult | null {
  if (!isRecord(raw)) return null;
  const codes = asStringArray(raw["codes"]) as AmendCode[];
  const detail = isRecord(raw["detail"]) ? (raw["detail"] as Record<string, unknown>) : undefined;
  const result: AmendResult = { ok: raw["ok"] === true, codes };
  if (detail !== undefined) result.detail = detail;
  return result;
}

function sanitizeLedger(raw: Record<string, unknown>): AmendLedger | null {
  if (raw["v"] !== 1) return null;
  const ledger: AmendLedger = { v: 1, diverged: [] };
  const run = raw["run"];
  if (isRecord(run)) {
    const normalized = normalizeRunState(run);
    if (normalized === null) return null;
    ledger.run = normalized;
  } else if (run !== undefined && run !== null) {
    return null;
  }
  if (raw["precheck"] !== undefined && raw["precheck"] !== null) {
    const result = normalizeResult(raw["precheck"]);
    if (result === null) return null;
    ledger.precheck = result;
  } else {
    ledger.precheck = null;
  }
  if (raw["cache"] !== undefined && raw["cache"] !== null) {
    const cache = normalizeCache(raw["cache"]);
    if (cache === null) return null;
    ledger.cache = cache;
  } else {
    ledger.cache = null;
  }
  ledger.diverged = asStringArray(raw["diverged"]);
  const resume = raw["resume"];
  if (isRecord(resume)) {
    const mode = asString(resume["mode"]);
    if (mode !== "cache" && mode !== "live") return null;
    ledger.resume = { mode, codes: asStringArray(resume["codes"]) };
  } else {
    ledger.resume = null;
  }
  const lastAction = asString(raw["lastAction"]);
  if (lastAction !== "") ledger.lastAction = lastAction;
  if (typeof raw["updatedAt"] === "number" && Number.isFinite(raw["updatedAt"])) ledger.updatedAt = raw["updatedAt"];
  return ledger;
}

/** 读账本结果。 */
export interface ReadAmendStoreResult {
  ok: boolean;
  codes: string[];
  ledger: AmendLedger;
  file: string;
  /** 文件是否存在(不存在=false 但 ok=true:首次创建场景)。 */
  exists: boolean;
}

/**
 * 读账本并做形状校验。
 * 文件不存在 = 空账本 + ok(首次运行);文件存在但解析/形状失败 = ok:false(调用方必须拒写)。
 */
export function readAmendStore(root: string): ReadAmendStoreResult {
  const paths = amendPaths(root);
  const fail = (): ReadAmendStoreResult => ({
    ok: false,
    codes: [AMEND_STORE_ERROR],
    ledger: emptyAmendLedger(),
    file: paths.file,
    exists: true,
  });
  if (!existsSync(paths.file)) {
    return { ok: true, codes: [], ledger: emptyAmendLedger(), file: paths.file, exists: false };
  }
  let text: string;
  try {
    text = readFileSync(paths.file, "utf8");
  } catch {
    return fail();
  }
  if (text.trim() === "") {
    return { ok: true, codes: [], ledger: emptyAmendLedger(), file: paths.file, exists: true };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail();
  }
  if (!isRecord(raw)) return fail();
  const ledger = sanitizeLedger(raw);
  if (ledger === null) return fail();
  return { ok: true, codes: [], ledger, file: paths.file, exists: true };
}

/** 写账本结果。 */
export interface WriteAmendStoreResult {
  ok: boolean;
  codes: string[];
  file: string;
  lastAction: string;
  persisted: boolean;
}

/**
 * 原子写账本:临时文件 → rename 替换 → 读回校验(v 与 lastAction 一致)。
 * 账本本身读不出来时**拒写**(坏账本上先落库会掩盖原始损坏)。
 */
export function writeAmendStore(root: string, ledger: AmendLedger): WriteAmendStoreResult {
  const paths = amendPaths(root);
  const current = readAmendStore(root);
  if (!current.ok) {
    return { ok: false, codes: [AMEND_STORE_ERROR], file: paths.file, lastAction: "", persisted: false };
  }
  const payload: AmendLedger = {
    ...ledger,
    v: 1,
    diverged: [...(ledger.diverged ?? [])],
    updatedAt: ledger.updatedAt ?? Date.now(),
  };
  const lastAction = payload.lastAction ?? "";
  const tmp = join(paths.dir, `${AMEND_FILE}.tmp-${process.pid}-${tmpSeq}`);
  tmpSeq += 1;
  try {
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    renameSync(tmp, paths.file);
  } catch {
    rmSync(tmp, { force: true });
    return { ok: false, codes: [AMEND_STORE_ERROR], file: paths.file, lastAction, persisted: false };
  }
  const back = readAmendStore(root);
  if (!back.ok || back.ledger.v !== payload.v || (back.ledger.lastAction ?? "") !== lastAction) {
    return { ok: false, codes: [AMEND_STORE_WRITE_MISMATCH], file: paths.file, lastAction, persisted: false };
  }
  return { ok: true, codes: [], file: paths.file, lastAction, persisted: true };
}

/* ------------------------------------------------------------------ */
/* run 文件读取                                                       */
/* ------------------------------------------------------------------ */

interface ReadRunFileResult {
  ok: boolean;
  codes: string[];
  run?: RunState;
  reason?: string;
}

/** 读 run 快照文件(JSON → RunState;不存在 / 坏 JSON / 非对象 → ok:false)。 */
export function readRunFile(runFile: string): ReadRunFileResult {
  if (typeof runFile !== "string" || runFile.trim() === "") throw new TypeError("readRunFile: runFile 必须是非空字符串");
  if (!existsSync(runFile)) return { ok: false, codes: [AMEND_STORE_ERROR], reason: "run file not found" };
  let text: string;
  try {
    text = readFileSync(runFile, "utf8");
  } catch {
    return { ok: false, codes: [AMEND_STORE_ERROR], reason: "run file unreadable" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, codes: [AMEND_STORE_ERROR], reason: "run file is not valid JSON" };
  }
  const run = normalizeRunState(raw);
  if (run === null) return { ok: false, codes: [AMEND_STORE_ERROR], reason: "run file is not an object" };
  return { ok: true, codes: [], run };
}

/* ------------------------------------------------------------------ */
/* 六个 OnDisk 动作                                                   */
/* ------------------------------------------------------------------ */

function mergeCodes(base: string[], extra: string[]): string[] {
  const merged = [...base];
  for (const code of extra) if (!merged.includes(code)) merged.push(code);
  return merged;
}

/** 把写盘失败折叠进动作返回值(写失败优先 STORE_* 码)。 */
function writeFailure(file: string): { ok: false; codes: string[]; file: string; persisted: false } {
  return { ok: false, codes: [AMEND_STORE_ERROR], file, persisted: false };
}

export interface PrecheckFromFileResult {
  ok: boolean;
  codes: string[];
  file: string;
  runId: string;
  stopped: boolean;
  pending: string[];
  persisted: boolean;
  detail?: Record<string, unknown>;
}

/**
 * 从 run 文件做预检:读 run → 组装 targetSession → precheck(runtime)→ 落盘 run+precheck。
 * 预检失败时**不调** stopPredecessor(前置不成立就不动前驱),detail.stopped=false 表明这一点。
 */
export function precheckFromFile(
  root: string,
  runFile: string,
  opts: { targetSessionId?: string } = {},
): PrecheckFromFileResult {
  const paths = amendPaths(root);
  const current = readAmendStore(root);
  if (!current.ok) {
    return { ...writeFailure(paths.file), runId: "", stopped: false, pending: [], detail: { reason: "ledger unreadable" } };
  }
  const read = readRunFile(runFile);
  if (!read.ok || read.run === undefined) {
    return {
      ...writeFailure(paths.file),
      runId: "",
      stopped: false,
      pending: [],
      detail: { reason: read.reason ?? "run unreadable", runFile },
    };
  }
  const run = read.run;
  const explicitTarget = (opts.targetSessionId ?? "").trim();
  const targetSession: TargetSession = {
    id: explicitTarget !== "" ? explicitTarget : (run.target?.sessionId ?? ""),
    seeds: run.target?.seeds ?? [],
    history: run.target?.history ?? [],
  };
  const pre = precheck(run, targetSession.id === "" ? {} : { targetSession });
  let codes: string[] = [...pre.codes];
  let ok = pre.ok;
  let stopped = false;
  let pending: string[] = [];
  let detail: Record<string, unknown> = { ...(pre.detail ?? {}) };
  if (pre.ok) {
    const stoppedResult = stopPredecessor(run, { awaitSettlement: true });
    stopped = stoppedResult.stopped;
    pending = [...stoppedResult.pending];
    codes = mergeCodes(codes, stoppedResult.codes);
    ok = pre.ok && stoppedResult.ok;
    detail = { ...detail, ...(stoppedResult.detail ?? {}), stopped, pending };
  } else {
    // 预检失败:拒收前零副作用,前驱一律不动。
    detail = { ...detail, stopped: false };
    pending = [];
  }
  const result: AmendResult = { ok, codes: codes as AmendCode[], detail };
  const write = writeAmendStore(root, {
    ...current.ledger,
    run,
    precheck: result,
    lastAction: "precheck",
  });
  if (!write.ok) {
    return {
      ok: false,
      codes: mergeCodes(codes, write.codes),
      file: write.file,
      runId: run.runId,
      stopped,
      pending,
      persisted: false,
      detail,
    };
  }
  return { ok, codes, file: write.file, runId: run.runId, stopped, pending, persisted: true, detail };
}

export interface BuildFromFileResult {
  ok: boolean;
  codes: string[];
  file: string;
  cacheActors: number;
  cacheAsks: number;
  worldQueue: number;
  persisted: boolean;
}

/** 从 run(显式文件优先,否则账本里的 run)构建导入缓存并落盘。 */
export function buildFromFile(root: string, runFile?: string): BuildFromFileResult {
  const paths = amendPaths(root);
  const current = readAmendStore(root);
  if (!current.ok) return { ...writeFailure(paths.file), cacheActors: 0, cacheAsks: 0, worldQueue: 0 };
  let run: RunState | undefined;
  if (typeof runFile === "string" && runFile.trim() !== "") {
    const read = readRunFile(runFile);
    if (!read.ok || read.run === undefined) {
      return { ...writeFailure(paths.file), cacheActors: 0, cacheAsks: 0, worldQueue: 0 };
    }
    run = read.run;
  } else {
    run = current.ledger.run;
  }
  if (run === undefined) {
    return { ok: false, codes: [AMEND_INVALID], file: paths.file, cacheActors: 0, cacheAsks: 0, worldQueue: 0, persisted: false };
  }
  const built = buildImportCache(run);
  const cache = built.cache ?? emptyImportCache();
  const codes = built.ok ? built.codes : mergeCodes(built.codes, built.codes.length === 0 ? [AMEND_INVALID] : []);
  const cacheActors = Object.keys(cache.actorPrefix).length;
  const cacheAsks = Object.values(cache.actorPrefix).reduce((sum, asks) => sum + asks.length, 0);
  if (!built.ok) {
    return { ok: false, codes, file: paths.file, cacheActors, cacheAsks, worldQueue: cache.worldQueue.length, persisted: false };
  }
  const write = writeAmendStore(root, { ...current.ledger, run, cache, lastAction: "build" });
  if (!write.ok) {
    return { ok: false, codes: mergeCodes(codes, write.codes), file: write.file, cacheActors, cacheAsks, worldQueue: cache.worldQueue.length, persisted: false };
  }
  return { ok: true, codes, file: write.file, cacheActors, cacheAsks, worldQueue: cache.worldQueue.length, persisted: true };
}

export interface MatchOnDiskResult {
  ok: boolean;
  codes: string[];
  file: string;
  hit: boolean;
  node?: ImportedNode;
  diverged: string[];
  persisted: boolean;
  detail?: Record<string, unknown>;
}

/**
 * 账本上的导入匹配。
 * `diverged` 是跨进程单调的:一旦某 askId 被判 hash 分叉,后续进程直接拒绝,不再回落 HIT。
 */
export function matchOnDisk(
  root: string,
  opts: { actor: string; askId: string; payloadHash?: string },
): MatchOnDiskResult {
  const paths = amendPaths(root);
  const actor = typeof opts.actor === "string" ? opts.actor.trim() : "";
  const askId = typeof opts.askId === "string" ? opts.askId.trim() : "";
  if (actor === "") throw new TypeError("matchOnDisk: actor 必须是非空字符串");
  if (askId === "") throw new TypeError("matchOnDisk: askId 必须是非空字符串");
  const current = readAmendStore(root);
  if (!current.ok) {
    return { ...writeFailure(paths.file), hit: false, diverged: [], detail: { reason: "ledger unreadable" } };
  }
  const diverged = [...current.ledger.diverged];
  if (diverged.includes(askId)) {
    return {
      ok: false,
      codes: [AMEND_HASH_DIVERGED],
      file: paths.file,
      hit: false,
      diverged,
      persisted: false,
      detail: { askId, source: "ledger.diverged" },
    };
  }
  const cache = current.ledger.cache ?? emptyImportCache();
  const match = matchImport(cache, {
    actor,
    askId,
    ...(opts.payloadHash === undefined ? {} : { payloadHash: opts.payloadHash }),
  });
  const nextDiverged = match.codes.includes(AMEND_HASH_DIVERGED) && !diverged.includes(askId) ? [...diverged, askId] : diverged;
  const needsPersist = nextDiverged.length !== diverged.length || (match.ok && match.hit);
  let persisted = false;
  let file = paths.file;
  if (needsPersist) {
    const write = writeAmendStore(root, {
      ...current.ledger,
      diverged: nextDiverged,
      lastAction: match.hit ? "match" : (current.ledger.lastAction ?? "match"),
    });
    persisted = write.ok;
    file = write.file;
    if (!write.ok) {
      return {
        ok: false,
        codes: mergeCodes(match.codes, write.codes),
        file,
        hit: false,
        diverged: nextDiverged,
        persisted: false,
        detail: match.detail,
      };
    }
  }
  return { ok: match.ok, codes: [...match.codes], file, hit: match.hit, node: match.node, diverged: nextDiverged, persisted, detail: match.detail };
}

export interface CloseOnDiskResult {
  ok: boolean;
  codes: string[];
  file: string;
  closed: boolean;
  persisted: boolean;
  detail?: Record<string, unknown>;
}

/** 世界写发生 → 关掉导入门(账本 cache.closed 落盘,跨进程生效)。 */
export function closeOnDisk(root: string, opts: { worldToolCalls: number }): CloseOnDiskResult {
  const paths = amendPaths(root);
  const worldToolCalls = typeof opts.worldToolCalls === "number" ? opts.worldToolCalls : Number.NaN;
  if (!Number.isFinite(worldToolCalls) || worldToolCalls < 0) throw new TypeError("closeOnDisk: worldToolCalls 必须是非负数");
  const current = readAmendStore(root);
  if (!current.ok) return { ...writeFailure(paths.file), closed: false, detail: { reason: "ledger unreadable" } };
  const cache = current.ledger.cache ?? emptyImportCache();
  const closedResult = closeOnWorldWrite(cache, { worldToolCalls });
  const write = writeAmendStore(root, {
    ...current.ledger,
    cache: cache,
    lastAction: "close",
  });
  if (!write.ok) {
    return {
      ok: false,
      codes: mergeCodes(closedResult.codes, write.codes),
      file: write.file,
      closed: closedResult.closed,
      persisted: false,
      detail: closedResult.detail,
    };
  }
  return {
    ok: closedResult.ok,
    codes: [...closedResult.codes],
    file: write.file,
    closed: closedResult.closed,
    persisted: true,
    detail: closedResult.detail,
  };
}

export interface ResumeOnDiskResult {
  ok: boolean;
  codes: string[];
  file: string;
  mode: "cache" | "live";
  persisted: boolean;
  detail?: Record<string, unknown>;
}

/** 续跑决策:缓存可用→cache 重放;不可用→live 重建(降级不算失败)。 */
export function resumeOnDisk(root: string, opts: { cacheOk: boolean }): ResumeOnDiskResult {
  const paths = amendPaths(root);
  const current = readAmendStore(root);
  if (!current.ok) {
    return { ...writeFailure(paths.file), mode: "live", detail: { reason: "ledger unreadable" } };
  }
  const planned = resumeRebuild({ cacheOk: opts.cacheOk === true });
  const write = writeAmendStore(root, {
    ...current.ledger,
    resume: { mode: planned.mode, codes: [...planned.codes] },
    lastAction: "resume",
  });
  if (!write.ok) {
    return {
      ok: false,
      codes: mergeCodes(planned.codes, write.codes),
      file: write.file,
      mode: planned.mode,
      persisted: false,
    };
  }
  // FALLBACK_LIVE 是「降级但仍可续跑」的正常结论,不算失败(CLI 给 exit 0)。
  const ok = planned.ok || planned.codes.includes(AMEND_FALLBACK_LIVE);
  return { ok, codes: [...planned.codes], file: write.file, mode: planned.mode, persisted: true, detail: planned.detail };
}

/** 账本摘要(CLI --report 用)。 */
export interface AmendStoreReport {
  ok: boolean;
  codes: string[];
  file: string;
  runId: string;
  asks: { completed: number; running: number; failed: number };
  cacheActors: number;
  cacheAsks: number;
  worldQueue: number;
  closed: boolean;
  diverged: string[];
  precheckCode: string | null;
  resumeMode: "cache" | "live" | null;
  lastAction: string | null;
}

export function reportAmendStore(root: string): AmendStoreReport {
  const paths = amendPaths(root);
  const current = readAmendStore(root);
  const base: AmendStoreReport = {
    ok: current.ok,
    codes: [...current.codes],
    file: paths.file,
    runId: "",
    asks: { completed: 0, running: 0, failed: 0 },
    cacheActors: 0,
    cacheAsks: 0,
    worldQueue: 0,
    closed: false,
    diverged: [],
    precheckCode: null,
    resumeMode: null,
    lastAction: null,
  };
  if (!current.ok) return base;
  const ledger = current.ledger;
  const counts = { completed: 0, running: 0, failed: 0 };
  for (const ask of ledger.run?.asks ?? []) counts[ask.status] = (counts[ask.status] ?? 0) + 1;
  const cache = ledger.cache ?? emptyImportCache();
  const asks = Object.values(cache.actorPrefix).reduce((sum, list) => sum + list.length, 0);
  return {
    ...base,
    runId: ledger.run?.runId ?? "",
    asks: counts,
    cacheActors: Object.keys(cache.actorPrefix).length,
    cacheAsks: asks,
    worldQueue: cache.worldQueue.length,
    closed: cache.closed === true,
    diverged: [...ledger.diverged],
    precheckCode: ledger.precheck?.codes[0] ?? null,
    resumeMode: ledger.resume?.mode ?? null,
    lastAction: ledger.lastAction ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* 拒绝码判定(CLI 用来映射 exit 2)                                    */
/* ------------------------------------------------------------------ */

/** 业务拒绝码集合:出现即代表「场景不允许」而非「参数/存储坏了」。 */
export const AMEND_REJECTION_CODES = [
  AMEND_HASH_DIVERGED,
  AMEND_DOOR_CLOSED,
  AMEND_RUN_MISSING,
  AMEND_BOUNDARY_MISSING,
  AMEND_TARGET_DIRTY,
  AMEND_SKIP_SETTLEMENT,
  AMEND_INVALID,
] as const;

export function isAmendRejection(code: string): boolean {
  return (AMEND_REJECTION_CODES as readonly string[]).includes(code);
}

/** AMEND_INVALID 的语义重导出(便于 CLI 只依赖 store)。 */
export { AMEND_INVALID };
