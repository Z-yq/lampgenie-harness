/**
 * Review 行级回写(ocr git note 思想 TS 重写):评审发现以行锚定评论持久化到本地 JSON 店
 * (路径注入,如 .genie/review-comments.json)。语义三件:
 * - sticky:评论跨轮一直在,直到发现不再复现(打 resolvedAt 标记,不删除);
 * - 增量:稳定键=hash(path|line|rule|normalizedMessage) 防重发;
 * - 幂等:重跑零 diff(零变化不落盘);发现复现=解除解决标记,不重发不重复。
 * 核心为纯函数 apply(store, findings, now);GitNoteWriteback 是 load→apply→save 门面。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { Finding } from "./index";

export interface StoredComment {
  key: string;
  path: string;
  line: number;
  rule?: string;
  message: string;
  severity: Finding["severity"];
  postedAt: number;
  /** 发现不再复现的时刻(sticky:标记不删除;复现即移除本标记)。 */
  resolvedAt?: number;
  /** 复现次数(重新打开计数)。 */
  repostCount?: number;
}

export interface ReviewCommentStore {
  version: 1;
  comments: StoredComment[];
  updatedAt?: number;
}

/** 消息归一:空白折叠(同一条发现的措辞换行/多空格不换键)。 */
export function normalizeMessage(msg: string): string {
  return msg.replace(/\s+/g, " ").trim();
}

/** 稳定键:hash(path|line|rule|normalizedMessage) 截 16 hex(行级锚定语义:行号漂移=新键,如实)。 */
export function findingKey(f: { file: string; line: number; rule?: string; message?: string; title?: string; detail?: string }): string {
  const message = normalizeMessage(f.message ?? [f.title, f.detail].filter(Boolean).join(": "));
  return createHash("sha256").update(`${f.file}|${f.line}|${f.rule ?? ""}|${message}`).digest("hex").slice(0, 16);
}

export interface ApplyReport {
  posted: StoredComment[];
  resolved: StoredComment[];
  reopened: StoredComment[];
  unchanged: number;
  /** 是否产生了任何变化(幂等门:零变化调用方可跳过落盘)。 */
  changed: boolean;
}

/** 纯函数:store+当前 findings+now → 新 store 与增量报告(不 mutate 入参)。 */
export function apply(
  store: ReviewCommentStore,
  findings: Finding[],
  now: number,
): { store: ReviewCommentStore; report: ApplyReport } {
  const comments = store.comments.map((c) => ({ ...c }));
  const byKey = new Map(comments.map((c) => [c.key, c]));
  const report: ApplyReport = { posted: [], resolved: [], reopened: [], unchanged: 0, changed: false };
  const seen = new Set<string>();

  for (const f of findings) {
    const message = normalizeMessage([f.title, f.detail].filter(Boolean).join(": "));
    const rule = (f as Finding & { rule?: string }).rule;
    const key = findingKey({ file: f.file, line: f.line, rule, message });
    seen.add(key);
    const existing = byKey.get(key);
    if (existing) {
      if (existing.resolvedAt !== undefined) {
        // 复现:解除解决标记,不重发(店中同一条评论原地复活)
        delete existing.resolvedAt;
        existing.repostCount = (existing.repostCount ?? 0) + 1;
        report.reopened.push(existing);
      } else {
        report.unchanged++;
      }
      continue;
    }
    const fresh: StoredComment = {
      key,
      path: f.file,
      line: f.line,
      message,
      severity: f.severity,
      postedAt: now,
      ...(rule ? { rule } : {}),
      repostCount: 0,
    };
    comments.push(fresh);
    byKey.set(key, fresh);
    report.posted.push(fresh);
  }

  // sticky 收尾:本轮未复现且未解决的 → 打 resolvedAt(不删除,历史可追溯)
  for (const c of comments) {
    if (!seen.has(c.key) && c.resolvedAt === undefined) {
      c.resolvedAt = now;
      report.resolved.push(c);
    }
  }
  report.changed = report.posted.length + report.resolved.length + report.reopened.length > 0;
  return { store: { version: 1, comments, updatedAt: now }, report };
}

/** 读店:缺文件/损坏/版本不符 → 全新空店(诚实从零,不猜)。 */
export function loadStore(file: string): ReviewCommentStore {
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as ReviewCommentStore;
    if (raw && raw.version === 1 && Array.isArray(raw.comments)) return raw;
  } catch {
    /* 缺文件或损坏:从零开始 */
  }
  return { version: 1, comments: [] };
}

/** 落盘:内容确定性(store 对象字段序稳定)→ 同内容同字节,双重保存幂等。 */
export function saveStore(file: string, store: ReviewCommentStore): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(store, null, 1));
}

export interface WritebackReport extends ApplyReport {
  storePath: string;
}

/** 行级回写门面:load → apply → (有变化才)save。 */
export class GitNoteWriteback {
  constructor(private readonly storePath: string) {}

  sync(findings: Finding[], now: number = Date.now()): WritebackReport {
    const loaded = loadStore(this.storePath);
    const { store, report } = apply(loaded, findings, now);
    if (report.changed) saveStore(this.storePath, store); // 幂等:零变化不落盘
    return { ...report, storePath: this.storePath };
  }

  load(): ReviewCommentStore {
    return loadStore(this.storePath);
  }
}
