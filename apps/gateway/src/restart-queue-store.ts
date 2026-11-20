/**
 * 待重启队列:把「修复已完成、但必须重启网关才生效」变成显式队列,不再静默挂起。
 * 设计闸不变:RSI/子代理**不得**自重启网关(sys_restart 只在 super 且需用户明确确认)。
 * 本模块只做三件事:
 * 1) 入队:任务终态文本带「待重启」语义,或 super 显式 add → 落一条 pending 条目;
 * 同一状态点(statusPoint)仍有 pending 时不重复入队(抑制「同一修复派两次」的账本噪声)。
 * 2) 回写:网关启动钩子调 settleRestartQueue → 所有 pending 落 settled(restartedAt + pid),
 * 这是「重启已完成」的终态回写;随后由调用方发通知。幂等:无 pending 不写盘。
 * 3) 关闭:人工/super 确认生效后 close。
 * 数据面:`<root>/.genie/restart-queue.jsonl`,每行一条事件
 * {"v":1,"type":"add"|"settled"|"close"|"note","id":...,"at":ISO,...}
 * 折叠规则与其它 RSI 台账一致:append-only + 坏行跳过,不 throw。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const RESTART_QUEUE_VERSION = 1;
export const RESTART_QUEUE_FILE = "restart-queue.jsonl";

export type RestartEntryStatus = "pending" | "settled" | "closed";

export interface RestartQueueEntry {
  id: string;
  title: string;
  reason: string;
  statusPoint: string;
  status: RestartEntryStatus;
  at: number;
  taskId?: string;
  sessionId?: string;
  settledAt?: number;
  settledPid?: number;
  closedAt?: number;
  closedBy?: string;
}

export interface RestartQueuePaths {
  dir: string;
  file: string;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function assertRoot(root: unknown): string {
  if (typeof root !== "string" || root.trim() === "") throw new TypeError("restart-queue: root 必须是非空字符串");
  return root;
}

export function restartQueuePaths(root: string): RestartQueuePaths {
  const base = assertRoot(root);
  const dir = join(base, ".genie");
  return { dir, file: join(dir, RESTART_QUEUE_FILE) };
}

/** 状态点归一化:同一条用户诉求的不同派发应折叠到同一个键(供重复入队抑制)。 */
export function normalizeStatusPoint(title: string): string {
  return String(title ?? "")
    .toLowerCase()
    .replace(/\[rsi\]/g, " ")
    .replace(/ws-[a-z0-9]+/g, " ")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, " ")
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "");
}

/** 任务终态文本是否声明「需要重启才生效」。只做入队信号,不代表执行任何重启。 */
export function detectRestartNeeded(text: unknown): boolean {
  const s = String(text ?? "");
 // 反例优先:明确说「无需/不需重启」不算待重启。
  if (new RegExp("无需重启|不需重启|不需要重启|无需再重启").test(s)) return false;
  return /待重启|需重启|需要重启|重启后生效|重启才生效|restart\s*(required|needed)|needs?\s*restart/i.test(s);
}

function appendLine(root: string, line: UnknownRecord): boolean {
  const { dir, file } = restartQueuePaths(root);
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(file, `${JSON.stringify(line)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

interface FoldedState {
  order: string[];
  entries: Map<string, RestartQueueEntry>;
}

function fold(root: string): FoldedState {
  const { file } = restartQueuePaths(root);
  const order: string[] = [];
  const entries = new Map<string, RestartQueueEntry>();
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { order, entries };
  }
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // 坏行跳过不 throw
    }
    if (!isRecord(parsed)) continue;
    const type = nonEmpty(parsed["type"]);
    const id = nonEmpty(parsed["id"]);
    if (type === undefined || id === undefined) continue;
    if (type === "add") {
      if (entries.has(id)) continue;
      const title = nonEmpty(parsed["title"]) ?? id;
      const entry: RestartQueueEntry = {
        id,
        title,
        reason: nonEmpty(parsed["reason"]) ?? "",
        statusPoint: nonEmpty(parsed["statusPoint"]) ?? normalizeStatusPoint(title),
        status: "pending",
        at: typeof parsed["at"] === "number" ? (parsed["at"] as number) : Date.now(),
      };
      const taskId = nonEmpty(parsed["taskId"]);
      if (taskId !== undefined) entry.taskId = taskId;
      const sessionId = nonEmpty(parsed["sessionId"]);
      if (sessionId !== undefined) entry.sessionId = sessionId;
      entries.set(id, entry);
      order.push(id);
      continue;
    }
    const entry = entries.get(id);
    if (entry === undefined) continue;
    if (type === "settled" && entry.status === "pending") {
      entry.status = "settled";
      entry.settledAt = typeof parsed["at"] === "number" ? (parsed["at"] as number) : Date.now();
      const pid = parsed["pid"];
      if (typeof pid === "number") entry.settledPid = pid;
    } else if (type === "close") {
      entry.status = "closed";
      entry.closedAt = typeof parsed["at"] === "number" ? (parsed["at"] as number) : Date.now();
      const by = nonEmpty(parsed["by"]);
      if (by !== undefined) entry.closedBy = by;
    }
  }
  return { order, entries };
}

export function listRestartQueue(root: string): RestartQueueEntry[] {
  const { order, entries } = fold(root);
  return order.map((id) => ({ ...(entries.get(id) as RestartQueueEntry) }));
}

export function listPendingRestarts(root: string): RestartQueueEntry[] {
  return listRestartQueue(root).filter((entry) => entry.status === "pending");
}

/** 入队。同状态点已 pending → duplicate=true(只留一条 note,不重复建条目)。 */
export function queueRestart(
  root: string,
  input: {
    title: string;
    reason?: string;
    taskId?: string;
    sessionId?: string;
    statusPoint?: string;
    at?: number;
  },
): { ok: boolean; id?: string; duplicate?: boolean; error?: string } {
  const title = nonEmpty(input?.title);
  if (title === undefined) return { ok: false, error: "title 必填" };
  const base = assertRoot(root);
  const at = typeof input.at === "number" && Number.isFinite(input.at) ? input.at : Date.now();
  const statusPoint = nonEmpty(input.statusPoint) ?? normalizeStatusPoint(title);
  const existing = listPendingRestarts(base).find((entry) => entry.statusPoint === statusPoint);
  if (existing !== undefined) {
    appendLine(base, { v: RESTART_QUEUE_VERSION, type: "note", id: existing.id, at, reason: "duplicate-suppressed", title });
    return { ok: true, id: existing.id, duplicate: true };
  }
  const id = `rq_${at.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const line: UnknownRecord = { v: RESTART_QUEUE_VERSION, type: "add", id, at, title, reason: String(input.reason ?? "").slice(0, 300), statusPoint };
  if (nonEmpty(input.taskId) !== undefined) line["taskId"] = nonEmpty(input.taskId);
  if (nonEmpty(input.sessionId) !== undefined) line["sessionId"] = nonEmpty(input.sessionId);
  if (!appendLine(base, line)) return { ok: false, error: "待重启队列写入失败" };
  return { ok: true, id };
}

/** 网关启动钩子:所有 pending → settled(回写重启时间与 pid)。无 pending 不写盘、返回空。 */
export function settleRestartQueue(
  root: string,
  opts: { pid?: number; at?: number },
): RestartQueueEntry[] {
  const base = assertRoot(root);
  const at = typeof opts?.at === "number" && Number.isFinite(opts.at) ? opts.at : Date.now();
  const pid = typeof opts?.pid === "number" ? opts.pid : process.pid;
  const pending = listPendingRestarts(base);
  if (pending.length === 0) return [];
  const settled: RestartQueueEntry[] = [];
  for (const entry of pending) {
    if (!appendLine(base, { v: RESTART_QUEUE_VERSION, type: "settled", id: entry.id, at, pid })) continue;
    settled.push({ ...entry, status: "settled", settledAt: at, settledPid: pid });
  }
  return settled;
}

export function closeRestartEntry(root: string, id: string, opts?: { by?: string; at?: number }): { ok: boolean; error?: string } {
  const base = assertRoot(root);
  const key = nonEmpty(id);
  if (key === undefined) return { ok: false, error: "id 必填" };
  const entry = listRestartQueue(base).find((item) => item.id === key);
  if (entry === undefined) return { ok: false, error: `待重启条目不存在: ${key}` };
  if (entry.status === "closed") return { ok: true };
  const at = typeof opts?.at === "number" && Number.isFinite(opts.at) ? opts.at : Date.now();
  const by = nonEmpty(opts?.by) ?? "panel";
  if (!appendLine(base, { v: RESTART_QUEUE_VERSION, type: "close", id: key, at, by })) {
    return { ok: false, error: "待重启队列写入失败" };
  }
  return { ok: true };
}

/** 台账存在性检查(诊断/测试用;真实读取用 listRestartQueue)。 */
export function restartQueueExists(root: string): boolean {
  return existsSync(restartQueuePaths(root).file);
}

/** 建空台账(仅当缺失):供启动时保证「无 pending」是显式事实而不是缺文件。 */
export function ensureRestartQueue(root: string): boolean {
  const { dir, file } = restartQueuePaths(root);
  if (existsSync(file)) return false;
  mkdirSync(dirname(file), { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, "", "utf8");
  return true;
}