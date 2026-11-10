/**
 * 邀请码存储( §3):一次性、7 天有效、最大兑换 1 次。
 * 原稿形态=SQLite 滚动;node20 无 node:sqlite,一期=JSONL 追加+加载时滚动截断
 * (保留最近 1000 条;数据权威在 Git——兑换结果最终以 roster MR 体现,此仓可重建)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface InviteRecord {
  code: string;
  createdAt: number;
  expiresAt: number;
  createdBy: string;
 /** 邀请绑定的项目(项目绑定团队:兑换产生的 roster 条目自动带 projects)。 */
  projects: string[];
  /** 兑换结果(null=未兑换)。 */
  redeemedBy: string | null;
  redeemedAt: number | null;
  /** 兑换产生的 roster MR 分支。 */
  branch: string | null;
}

const ROLLING_KEEP = 1000;

export class InviteStore {
  private records = new Map<string, InviteRecord>();

  constructor(private readonly file: string) {
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf-8").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const r = JSON.parse(t) as InviteRecord;
          r.projects = Array.isArray(r.projects) ? r.projects : []; // 旧记录无 projects 字段归一
          this.records.set(r.code, r);
        } catch {
          // 损坏行跳过:JSONL 半行(崩溃截断)容忍,整体可重建。
        }
      }
    }
  }

  issue(code: string, createdBy: string, expiresAt: number, projects: string[] = []): InviteRecord {
    const r: InviteRecord = { code, createdAt: Date.now(), expiresAt, createdBy, projects: [...projects], redeemedBy: null, redeemedAt: null, branch: null };
    this.records.set(code, r);
    this.persist();
    return r;
  }

  /** 兑换校验+登记(原子:校验与登记同调用;过期/超次/不存在各返明确原因)。 */
  redeem(code: string, username: string): { ok: true; record: InviteRecord } | { ok: false; reason: string } {
    const r = this.records.get(code);
    if (!r) return { ok: false, reason: "邀请码不存在" };
    if (Date.now() > r.expiresAt) return { ok: false, reason: "邀请码已过期" };
    if (r.redeemedBy !== null) return { ok: false, reason: "邀请码已被兑换" };
    r.redeemedBy = username;
    r.redeemedAt = Date.now();
    this.persist();
    return { ok: true, record: r };
  }

  attachBranch(code: string, branch: string): void {
    const r = this.records.get(code);
    if (r) {
      r.branch = branch;
      this.persist();
    }
  }

  get(code: string): InviteRecord | undefined {
    return this.records.get(code);
  }

  list(): InviteRecord[] {
    return [...this.records.values()];
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    // 滚动:按创建时间倒序保留最近 ROLLING_KEEP 条。
    const kept = this.list().sort((a, b) => b.createdAt - a.createdAt).slice(0, ROLLING_KEEP);
    this.records = new Map(kept.map((r) => [r.code, r]));
    writeFileSync(this.file, kept.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
}
