/**
 * 计划退出评审持久层(生产侧,#10):把 plan-exit-review 的纯状态机落到单一 JSON 账本。
 * 数据面:`<root>/.genie/rsi/plan-exits.json`
 *   { "v": 1, "reviews": { "<planId>": ReviewState } }
 * 为什么是单文件整账本:评审是状态机(pending→approved/rejected/failed,approved 再→applied),
 * 读时只关心每条评审的当前状态;整账本 + 原子替换(写临时文件 → rename)保证「读到的永远是
 * 某一完整代」。崩溃最多丢最后一次未 rename 的写,不会读到半条评审。
 * 失败口径:
 * - 参数/业务拒绝直接透传 runtime 的 PLANEXIT_* 码,**拒收前零副作用**(不写盘)。
 * - 坏账本(JSON 坏/形状坏)→ PLANEXIT_STORE_ERROR,写操作一律拒写。
 * - 写后校验(条数一致)不过 → PLANEXIT_STORE_WRITE_MISMATCH(不 throw,失败可见)。
 * - 同一 planId 已有 pending 时重复 request → PLANEXIT_PENDING,不覆盖原账本。
 * 依赖纪律:node:fs / node:path + runtime 纯逻辑(经 workspace 子路径导入)。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  applyPendingExit,
  decideReview,
  isReviewState,
  PLANEXIT_INVALID,
  PLANEXIT_PENDING,
  PLANEXIT_REJECTION_CODES,
  requestExit,
  timeoutReview,
  type PlanExitResult,
  type PlanSubmission,
  type ReviewChannel,
  type ReviewState,
  type ReviewStatus,
} from "@lampgenie/runtime/agent/plan-exit-review";

export const PLAN_EXIT_VERSION = 1;
export const PLAN_EXIT_RELATIVE_DIR = ".genie/rsi";
export const PLAN_EXIT_FILE = "plan-exits.json";

export const PLAN_EXIT_STORE_OK = "PLANEXIT_STORE_OK" as const;
export const PLAN_EXIT_STORE_ERROR = "PLANEXIT_STORE_ERROR" as const;
export const PLAN_EXIT_STORE_WRITE_MISMATCH = "PLANEXIT_STORE_WRITE_MISMATCH" as const;

export type PlanExitStoreCode =
  | typeof PLAN_EXIT_STORE_OK
  | typeof PLAN_EXIT_STORE_ERROR
  | typeof PLAN_EXIT_STORE_WRITE_MISMATCH;

/** 账本形状。 */
export interface PlanReviewStore {
  v: number;
  reviews: Record<string, ReviewState>;
}

export function emptyPlanReviewStore(): PlanReviewStore {
  return { v: PLAN_EXIT_VERSION, reviews: {} };
}

export interface PlanExitPaths {
  dir: string;
  file: string;
}

/** 解析账本路径;root 必填。 */
export function planExitPaths(root: string): PlanExitPaths {
  if (typeof root !== "string" || root.trim() === "") throw new TypeError("planExitPaths: root 必须是非空字符串");
  const dir = join(root, PLAN_EXIT_RELATIVE_DIR);
  return { dir, file: join(dir, PLAN_EXIT_FILE) };
}

export interface ReadPlanExitResult {
  ok: boolean;
  codes: string[];
  store: PlanReviewStore;
  dropped: string[];
  file: string;
  /** 文件是否存在(不存在=false 但 ok=true:首次创建场景)。 */
  exists: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function badLedger(file: string, detail: string): ReadPlanExitResult {
  return { ok: false, codes: [PLAN_EXIT_STORE_ERROR, detail], store: emptyPlanReviewStore(), dropped: [], file, exists: true };
}

/**
 * 读账本并做形状校验。
 * 文件不存在 = 空账本 + ok(首次运行);文件存在但解析/形状失败 = ok:false(调用方必须拒写)。
 * 单条评审形状坏 → 丢弃进 dropped(不拖垮整板);reviews 本身坏 → 整本判坏。
 */
export function readPlanExitStore(root: string): ReadPlanExitResult {
  const paths = planExitPaths(root);
  if (!existsSync(paths.file)) {
    return { ok: true, codes: [], store: emptyPlanReviewStore(), dropped: [], file: paths.file, exists: false };
  }
  let text: string;
  try {
    text = readFileSync(paths.file, "utf8");
  } catch {
    return { ...badLedger(paths.file, "账本读取失败"), exists: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return badLedger(paths.file, "JSON 解析失败");
  }
  const rec = asRecord(parsed);
  if (rec === undefined) return badLedger(paths.file, "账本必须是对象");
  const rawReviews = rec["reviews"];
  if (rawReviews === undefined) return { ok: true, codes: [], store: emptyPlanReviewStore(), dropped: [], file: paths.file, exists: true };
  const reviewsRec = asRecord(rawReviews);
  if (reviewsRec === undefined) return badLedger(paths.file, "reviews 必须是对象");

  const store = emptyPlanReviewStore();
  const dropped: string[] = [];
  for (const [planId, value] of Object.entries(reviewsRec)) {
    if (isReviewState(value)) store.reviews[planId] = value;
    else dropped.push(planId);
  }
  return { ok: true, codes: [], store, dropped, file: paths.file, exists: true };
}

let tmpSeq = 0;

/**
 * 原子写账本:写临时文件 → 回读校验条数 → rename 覆盖。
 * 不 throw;失败折叠成 STORE_ERROR / STORE_WRITE_MISMATCH。
 */
export function writePlanExitStore(
  root: string,
  store: PlanReviewStore): { ok: boolean; code: PlanExitStoreCode; file: string } {
  const paths = planExitPaths(root);
  try {
    mkdirSync(paths.dir, { recursive: true });
  } catch {
    return { ok: false, code: PLAN_EXIT_STORE_ERROR, file: paths.file };
  }
  const tmp = `${paths.file}.${process.pid}.${tmpSeq++}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    const back = asRecord(JSON.parse(readFileSync(tmp, "utf8")));
    const backReviews = back === undefined ? undefined : asRecord(back["reviews"]);
    const want = Object.keys(store.reviews).length;
    const got = backReviews === undefined ? -1 : Object.keys(backReviews).length;
    if (got !== want) {
      rmSync(tmp, { force: true });
      return { ok: false, code: PLAN_EXIT_STORE_WRITE_MISMATCH, file: paths.file };
    }
    renameSync(tmp, paths.file);
    return { ok: true, code: PLAN_EXIT_STORE_OK, file: paths.file };
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 临时文件清理失败不影响判定 */
    }
    return { ok: false, code: PLAN_EXIT_STORE_ERROR, file: paths.file };
  }
}

/** 落盘操作统一返回形状。 */
export interface PlanExitStoreOutcome {
  ok: boolean;
  code: string;
  resume: boolean;
  file: string;
  written: boolean;
  state?: ReviewState;
  feedback?: string;
  missing?: string[];
  detail?: string;
  submission?: PlanSubmission;
}

function outcome(result: PlanExitResult, file: string, written: boolean): PlanExitStoreOutcome {
  return {
    ok: result.ok,
    code: result.code,
    resume: result.resume,
    file,
    written,
    state: result.state,
    feedback: result.feedback,
    missing: result.missing,
    detail: result.detail,
    submission: result.submission,
  };
}

function storeError(file: string, detail: string): PlanExitStoreOutcome {
  return { ok: false, code: PLAN_EXIT_STORE_ERROR, resume: false, file, written: false, detail };
}

/** 提交评审请求:完整计划 + 有通道 → pending 落盘(阻塞当前调用)。 */
export function requestPlanExitOnDisk(
  root: string,
  input: { submission: PlanSubmission; channel: ReviewChannel; now?: number },
): PlanExitStoreOutcome {
  const paths = planExitPaths(root);
  const read = readPlanExitStore(root);
  if (!read.ok) return storeError(paths.file, `账本损坏,拒写(${read.codes.join(" ")})`);

  const result = requestExit(input);
  if (!result.ok) return outcome(result, paths.file, false);

  const state = result.state as ReviewState;
  const planId = state.planId as string;
  const existing = read.store.reviews[planId];
  if (existing !== undefined && existing.status === "pending") {
    // 同一 planId 重复提交:幂等返回原 pending,不覆盖(零副作用)。
    return { ok: true, code: PLANEXIT_PENDING, resume: false, file: paths.file, written: false, state: existing, detail: "already-pending" };
  }

  const next: PlanReviewStore = { v: PLAN_EXIT_VERSION, reviews: { ...read.store.reviews, [planId]: state } };
  const write = writePlanExitStore(root, next);
  if (!write.ok) return storeError(paths.file, `账本写入失败(${write.code})`);
  return outcome(result, paths.file, true);
}

/** 记录用户决定:approve → pendingExitAt;keep-planning → rejected + feedback。 */
export function decidePlanExitOnDisk(
  root: string,
  input: { planId: string; decision: "approve" | "keep-planning"; feedback?: string; at?: number },
): PlanExitStoreOutcome {
  const paths = planExitPaths(root);
  const read = readPlanExitStore(root);
  if (!read.ok) return storeError(paths.file, `账本损坏,拒写(${read.codes.join(" ")})`);
  const current = read.store.reviews[input.planId];
  if (current === undefined) {
    return { ok: false, code: PLANEXIT_INVALID, resume: false, file: paths.file, written: false, detail: `未找到评审 ${input.planId}` };
  }
  const result = decideReview(current, { decision: input.decision, feedback: input.feedback, at: input.at });
  if (!result.ok) return outcome(result, paths.file, false);
  const state = result.state as ReviewState;
  const next: PlanReviewStore = { v: PLAN_EXIT_VERSION, reviews: { ...read.store.reviews, [input.planId]: state } };
  const write = writePlanExitStore(root, next);
  if (!write.ok) return storeError(paths.file, `账本写入失败(${write.code})`);
  return outcome(result, paths.file, true);
}

/** 超时裁决:到点 failed(不自动 approve);未到点不写盘。 */
export function timeoutPlanExitOnDisk(
  root: string,
  input: { planId: string; now?: number; timeoutMs?: number },
): PlanExitStoreOutcome {
  const paths = planExitPaths(root);
  const read = readPlanExitStore(root);
  if (!read.ok) return storeError(paths.file, `账本损坏,拒写(${read.codes.join(" ")})`);
  const current = read.store.reviews[input.planId];
  if (current === undefined) {
    return { ok: false, code: PLANEXIT_INVALID, resume: false, file: paths.file, written: false, detail: `未找到评审 ${input.planId}` };
  }
  const result = timeoutReview(current, { now: input.now, timeoutMs: input.timeoutMs });
  if (!result.ok) {
    if (result.state === undefined || result.state.status === current.status) return outcome(result, paths.file, false);
  }
  if (result.code === PLANEXIT_PENDING) return outcome(result, paths.file, false);
  const state = result.state as ReviewState;
  const next: PlanReviewStore = { v: PLAN_EXIT_VERSION, reviews: { ...read.store.reviews, [input.planId]: state } };
  const write = writePlanExitStore(root, next);
  if (!write.ok) return storeError(paths.file, `账本写入失败(${write.code})`);
  return outcome(result, paths.file, true);
}

/** 下一次 pre-step 应用 pending exit(只一次)。 */
export function applyPlanExitOnDisk(
  root: string,
  input: { planId: string; preStepAt?: number },
): PlanExitStoreOutcome {
  const paths = planExitPaths(root);
  const read = readPlanExitStore(root);
  if (!read.ok) return storeError(paths.file, `账本损坏,拒写(${read.codes.join(" ")})`);
  const current = read.store.reviews[input.planId];
  if (current === undefined) {
    return { ok: false, code: PLANEXIT_INVALID, resume: false, file: paths.file, written: false, detail: `未找到评审 ${input.planId}` };
  }
  const result = applyPendingExit(current, { preStepAt: input.preStepAt });
  if (!result.ok) return outcome(result, paths.file, false);
  const state = result.state as ReviewState;
  const next: PlanReviewStore = { v: PLAN_EXIT_VERSION, reviews: { ...read.store.reviews, [input.planId]: state } };
  const write = writePlanExitStore(root, next);
  if (!write.ok) return storeError(paths.file, `账本写入失败(${write.code})`);
  return outcome(result, paths.file, true);
}

/** 点查一条评审。 */
export function getPlanExitOnDisk(root: string, planId: string): { review?: ReviewState; file: string; ok: boolean } {
  const read = readPlanExitStore(root);
  return { review: read.store.reviews[planId], file: read.file, ok: read.ok };
}

/** 账本报告(状态计数 + 逐条)。 */
export interface PlanExitReport {
  ok: boolean;
  file: string;
  exists: boolean;
  total: number;
  byStatus: Record<ReviewStatus, number>;
  reviews: Array<{
    planId: string;
    status: ReviewStatus;
    submittedAt?: number;
    decidedAt?: number;
    pendingExitAt?: number;
    exitApplied?: boolean;
    feedback?: string;
  }>;
  codes: string[];
  dropped: string[];
}

export function reportPlanExits(root: string): PlanExitReport {
  const read = readPlanExitStore(root);
  const byStatus: Record<ReviewStatus, number> = { pending: 0, approved: 0, rejected: 0, failed: 0 };
  const reviews = Object.entries(read.store.reviews).map(([planId, state]) => {
    byStatus[state.status] += 1;
    return {
      planId,
      status: state.status,
      submittedAt: state.submittedAt,
      decidedAt: state.decidedAt,
      pendingExitAt: state.pendingExitAt,
      exitApplied: state.exitApplied,
      feedback: state.feedback,
    };
  });
  reviews.sort((a, b) => {
    const sa = a.submittedAt ?? 0;
    const sb = b.submittedAt ?? 0;
    if (sa !== sb) return sa - sb;
    return a.planId < b.planId ? -1 : a.planId > b.planId ? 1 : 0;
  });
  return {
    ok: read.ok,
    file: read.file,
    exists: read.exists,
    total: reviews.length,
    byStatus,
    reviews,
    codes: read.codes,
    dropped: read.dropped,
  };
}

/** 业务拒绝码判定(CLI 用来映射 exit 2)。 */
export function isPlanExitRejection(code: string): boolean {
  return (PLANEXIT_REJECTION_CODES as readonly string[]).includes(code);
}
