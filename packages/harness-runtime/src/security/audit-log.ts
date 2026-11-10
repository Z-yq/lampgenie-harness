/**
 * 审计日志(designs/10 §6):统一 schema、JSONL append-only、与 session journal 分离。
 * 红线:明细脱敏后 hash(detail_hash 可对账);只记网络段标签不记具体 IP;只增不改。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** 动作全集(designs/10 §6 枚举)。live=已有真实产生点;pending=登记待接线(不造假)。 */
export const AUDIT_ACTIONS = [
  "config.change",
  "member.invite",
  "resource.push",
  "roster.merge",
  "eval.gate-override",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** 已知但尚无产生点的动作(产生点建成即迁入 live;对账脚本核对这张表)。 */
export const AUDIT_ACTIONS_PENDING = [
  "permission.approve",
  "credential.rotate",
  "member.revoke",
  "build.push-direct",
  "im.pull-history",
  "node.remove",
  "role.change",
] as const;

export interface AuditEvent {
  ts: string;
  actor: { kind: "user" | "agent" | "system"; fingerprint?: string; device?: string };
  action: AuditAction;
  target: { type: string; id: string };
  /** 明细脱敏后 sha256(可对账;原文不入审计日志)。 */
  detail_hash: string;
  result: "ok" | "deny" | "error";
  /** 只记网络段标签(lan/vpn-x/unknown),不记具体 IP。 */
  source_ip_scope: string;
}

export function hashDetail(detail: unknown): string {
  return "sha256:" + createHash("sha256").update(JSON.stringify(detail)).digest("hex").slice(0, 32);
}

export class AuditLog {
  constructor(private readonly file: string = join(homedir(), "audit", `${new Date().toISOString().slice(0, 7)}.jsonl`)) {}

  /** 追加一条(只增);明细只入 hash 不入日志;写失败 fails-soft(返回 false 可观测,不阻塞主流程)。 */
  append(ev: Omit<AuditEvent, "ts" | "detail_hash">, detail: unknown): boolean {
    const event: AuditEvent = {
      ...ev,
      ts: new Date().toISOString(),
      detail_hash: hashDetail(detail),
    };
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, JSON.stringify(event) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  /** 读取(对账/查询面用)。 */
  read(): AuditEvent[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as AuditEvent);
  }
}
