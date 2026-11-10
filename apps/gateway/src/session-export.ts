/**
 * journal → deepseek-harness session-format v4 导出(二期)。
 * 行帧规格=deepseek-harness 开源项目公开的 session-format v4(致谢),实现为本仓自研:
 * 行帧契约(v1-to-v2/codec.ts encodeHeader/encodeSourceEventRanges 对照):
 *   header 行={type:"session",version:4,id,createdAt,[cwd],[parentSession],isSeeded,
 *              [origin],delegationDepth,[agentPreset]}(exact-keys);
 *   事件行={type,seq,time,data,[ignorable],[sourceEventSeqs],[surfaceOp]}。
 * 事件映射:journal message.user→user/message、message.agent→assistant/message、
 * tool.result→tool/result(一等到消息);其余 journal 事件不进会话格式(过程遥测,
 * 会话格式语义=对话记录)。校验=本地 exact-keys 实现。
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Journal } from "@lampgenie/core";

/** 导出会话事件(v4 逻辑形状,即物理行)。 */
export interface DshSessionEvent {
  type: string;
  seq: number;
  time: number;
  data: Record<string, unknown>;
}

interface JournalEventLike {
  kind: string;
  sessionId: string;
  seq?: number;
  time?: number;
  payload: unknown;
}

/** journal 事件 → dsh v4 会话事件;非对话事件返回 undefined。 */
export function journalEventToV4(e: JournalEventLike, seq: number): DshSessionEvent | undefined {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const time = typeof e.time === "number" ? e.time : Date.now();
  if (e.kind === "message.user") {
    return {
      type: "user/message", seq, time,
      data: { content: String(p.text ?? ""), source: { kind: "lampgenie-harness" } },
    };
  }
  if (e.kind === "message.agent") {
    return {
      type: "assistant/message", seq, time,
      data: { message: { role: "assistant", content: [{ type: "text", text: String(p.text ?? "") }], source: { kind: "lampgenie-harness" } } },
    };
  }
  if (e.kind === "tool.result") {
    const callId = String(p.toolCallId ?? `t${seq}`);
    return {
      type: "tool/result", seq, time,
      data: { message: { id: callId, role: "toolResult", content: [{ type: "text", text: String(p.content ?? "") }], source: { kind: "tool", callId } } },
    };
  }
  return undefined;
}

const HEADER_REQUIRED = new Set(["type", "version", "id", "createdAt", "isSeeded", "delegationDepth"]);
const HEADER_OPTIONAL = new Set(["cwd", "parentSession", "origin", "agentPreset"]);
const EVENT_REQUIRED = new Set(["type", "seq", "time", "data"]);
const EVENT_OPTIONAL = new Set(["ignorable", "sourceEventSeqs", "surfaceOp"]);

/** v4 物理帧校验(exact-keys,判据与 base/json.ts 一致;不合规抛错=诚实导出)。 */
export function assertV4Artifact(header: Record<string, unknown>, rows: unknown[]): void {
  const hKeys = new Set(Object.keys(header));
  for (const k of hKeys) {
    if (!HEADER_REQUIRED.has(k) && !HEADER_OPTIONAL.has(k)) throw new Error(`v4 header 存在未知键 ${k}(exact-keys 契约)`);
  }
  for (const k of HEADER_REQUIRED) {
    if (!hKeys.has(k)) throw new Error(`v4 header 缺必填键 ${k}`);
  }
  if (header.type !== "session" || header.version !== 4) throw new Error(`v4 header type/version 不符:${String(header.type)}/v${String(header.version)}`);
  if (typeof header.id !== "string" || !header.id) throw new Error("v4 header id 必须非空字符串");
  if (!Number.isSafeInteger(header.createdAt) || (header.createdAt as number) < 0) throw new Error("v4 header createdAt 必须非负安全整数");
  if (typeof header.isSeeded !== "boolean") throw new Error("v4 header isSeeded 必须布尔");
  if (!Number.isSafeInteger(header.delegationDepth) || (header.delegationDepth as number) < 0) throw new Error("v4 header delegationDepth 必须非负安全整数");
  for (const r of rows) {
    const row = r as Record<string, unknown>;
    if (typeof row !== "object" || row === null || Array.isArray(row)) throw new Error("v4 事件行必须是对象");
    for (const k of Object.keys(row)) {
      if (!EVENT_REQUIRED.has(k) && !EVENT_OPTIONAL.has(k)) throw new Error(`v4 事件行存在未知键 ${k}`);
    }
    for (const k of ["type", "seq", "time", "data"] as const) {
      if (!(k in row)) throw new Error(`v4 事件行缺必填键 ${k}`);
    }
    if (!Number.isSafeInteger(row.seq) || (row.seq as number) < 0) throw new Error(`v4 事件行 seq 非法:${String(row.seq)}`);
    if (typeof row.type !== "string" || !row.type) throw new Error("v4 事件行 type 必须非空字符串");
  }
}

export interface SessionExportFile {
  header: Record<string, unknown>;
  rows: DshSessionEvent[];
  /** 规范文件名(base/filename.ts 语义:session.v4.jsonl)。 */
  filename: string;
}

/** 会话导出为 v4 artifact(纯函数,不落盘)。 */
export function journalToSessionV4(events: JournalEventLike[], sessionId: string, cwd?: string): SessionExportFile {
  const rows: DshSessionEvent[] = [];
  for (const e of events) {
    if (e.sessionId !== sessionId) continue;
    const v = journalEventToV4(e, rows.length);
    if (v) rows.push(v);
  }
  const createdAt = events.find((e) => e.sessionId === sessionId && typeof e.time === "number")?.time ?? Date.now();
  const header: Record<string, unknown> = {
    type: "session",
    version: 4,
    id: sessionId,
    createdAt,
    ...(cwd ? { cwd } : {}),
    isSeeded: false,
    delegationDepth: 0,
  };
  assertV4Artifact(header, rows);
  return { header, rows, filename: "session.v4.jsonl" };
}

/** 落盘导出:写 <dir>/<sessionId>/session.v4.jsonl;返回文件路径。 */
export function exportSessionToFile(journal: Journal, sessionId: string, outDir: string, cwd?: string): string {
  const { header, rows, filename } = journalToSessionV4(journal.readAll() as unknown as JournalEventLike[], sessionId, cwd);
  const dir = join(outDir, sessionId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, filename);
  const body = [JSON.stringify(header), ...rows.map((r) => JSON.stringify(r))].join("\n") + "\n";
  writeFileSync(file, body, "utf-8");
  return file;
}

/** 读回校验(对账):逐行 JSON 解析 + v4 帧校验;返回事件数。 */
export function verifySessionFile(file: string): { events: number } {
  const lines = readFileSync(file, "utf-8").split("\n").filter((l) => l.trim());
  if (lines.length === 0) throw new Error("空会话文件");
  const header = JSON.parse(lines[0]!) as Record<string, unknown>;
  const rows = lines.slice(1).map((l) => JSON.parse(l) as Record<string, unknown>);
  assertV4Artifact(header, rows);
  return { events: rows.length };
}
