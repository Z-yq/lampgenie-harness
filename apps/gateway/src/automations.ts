/**
 * 定时自动化(ZCode AutomationsSection/automationCron 移植):
 * 保存的规则{name, instruction, everyMinutes, enabled}持久化 .genie/automations.json;
 * 调度判定=纯函数(check 注入 now),驱动侧 30s tick;到点经回调提交 system 任务。
 * 把 occurrence 发生身份接到生产调度器——账本键 `${automationId}@${nextRunAt}`,
 * fire 顺序 claim → onSubmit → complete → markRun,进程死在 submit 前不会重复触发;
 * manual 触发不占计划发生(不 claim、不写 completed)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  OCCURRENCE_RECORD_LIMIT,
  occurrenceKey,
  pruneOccurrenceRecords,
  recoverClaimedOccurrences,
} from "@lampgenie/runtime/task/occurrence";
import {
  RECEIPT_KEEP,
  classifyDeliveryError,
  isReady,
  nextReceipt,
  pruneReceipts,
  receiptKeyFor,
  type Receipt,
} from "@lampgenie/runtime/task/delivery-receipt";

/** 单个计划发生的账本记录(随 Automation 持久化进 automations.json)。 */
export interface AutomationOccurrenceRecord {
  status: "claimed" | "completed" | "failed";
 /** 最近一次状态变更时间。 */
  at: number;
  owner?: string;
}

export interface Automation {
  id: string;
  name: string;
  instruction: string;
  /** 间隔分钟(≥1);触发即排下次。 */
  everyMinutes: number;
  enabled: boolean;
  createdAt: number;
  lastRunAt: number | null;
  nextRunAt: number;
  lastTaskSessionId: string | null;
  runCount: number;
 /** 作用域(ZCode 自动化 全局/项目 tabs 对齐):"global"=缺省;否则=项目 id(任务按该项目 workdir 跑)。 */
  scope?: string;
 /** occurrence 账本:键=`${id}@${nextRunAt}`,只保留最近 50 个;旧文件无此字段=空账本。 */
  occurrences?: Record<string, AutomationOccurrenceRecord>;
 /** 乐观并发版本:用户编辑每次成功 +1;旧文件无此字段=1。 */
  revision: number;
 /** 投递 receipt 账本:键=`<id>#<occurrenceKey>`,只保留最近 20 条;旧文件无此字段=空账本。 */
  receipt?: Record<string, Receipt>;
}

export interface AutomationEvent {
  at: number;
  automationId: string;
  sessionId: string;
  trigger: "schedule" | "manual";
 /** 本次触发的发生身份(manual 缺省)。 */
  occurrenceKey?: string;
 /** 账本判定结果(旧消费方忽略)。 */
  status?: "claimed" | "completed" | "skipped" | "failed";
 /** 投递 receipt 结果(;旧消费方忽略):DELIVERED/PENDING/FAILED/DUPLICATE。 */
  receiptStatus?: string;
 /** 已发生的 transient 失败次数。 */
  receiptAttempts?: number;
}

/** claimOccurrence 的结果码(与 occurrence 账本语义对齐)。 */
export type OccurrenceClaimCode = "CLAIMED" | "ALREADY_COMPLETED" | "ALREADY_CLAIMED" | "MISSING";

export class AutomationStore {
  private items = new Map<string, Automation>();

  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    try {
      const arr = JSON.parse(readFileSync(file, "utf-8")) as Automation[];
      let recovered = 0;
      for (const a of arr) {
        if (!a || !a.id || !a.instruction) continue;
 // :旧文件无 revision/receipt 字段 → 归一化为起始版本 1 / 无 receipt 账本(不为此写盘)。
        const rev = Number(a.revision);
        a.revision = Number.isFinite(rev) && rev >= 1 ? Math.floor(rev) : 1;
        if (!a.receipt || typeof a.receipt !== "object") a.receipt = undefined;
        if (a.occurrences && typeof a.occurrences === "object") {
 // 重启恢复:进程死在 submit 前的 claimed 残留重置为 failed(幂等),下一次 claim 可重试。
          const result = recoverClaimedOccurrences(a.occurrences);
          if (result.recovered > 0) {
            a.occurrences = result.records;
            recovered += result.recovered;
          }
        }
        this.items.set(a.id, a);
      }
      if (recovered > 0) this.persist();
    } catch {
 // 坏文件容忍:空表起步
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify([...this.items.values()], null, 2) + "\n");
  }

  list(): Automation[] {
    return [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  create(input: { name: string; instruction: string; everyMinutes: number; enabled?: boolean; scope?: string }): Automation | { error: string } {
    const name = input.name.trim();
    const instruction = input.instruction.trim();
    const every = Math.floor(input.everyMinutes);
    if (!name) return { error: "名称为空" };
    if (!instruction) return { error: "指令为空" };
    if (!Number.isFinite(every) || every < 1 || every > 525600) return { error: "间隔须为 1~525600 分钟" };
    const a: Automation = {
      id: randomUUID(),
      name,
      instruction,
      everyMinutes: every,
      enabled: input.enabled ?? true,
      createdAt: Date.now(),
      lastRunAt: null,
      nextRunAt: Date.now() + every * 60_000,
      lastTaskSessionId: null,
      runCount: 0,
      revision: 1,
      ...(input.scope ? { scope: input.scope } : {}),
    };
    this.items.set(a.id, a);
    this.persist();
    return a;
  }

 /**
 * 编辑(CAS):给了 expectedRevision 且不符 → 返回 `{error:"conflict", revision}`,不写盘、不改字段;
 * 成功则 revision+1。expectedRevision 也可放在 patch 里(server 透传形态)。
 */
  update(
    id: string,
    patch: { name?: string; instruction?: string; everyMinutes?: number; enabled?: boolean; expectedRevision?: number },
    opts?: { expectedRevision?: number },
  ): Automation | { error: string; revision?: number } {
    const a = this.items.get(id);
    if (!a) return { error: "不存在" };
    const expected = opts?.expectedRevision ?? patch.expectedRevision;
    if (typeof expected === "number" && Number.isFinite(expected) && expected !== a.revision) {
      return { error: "conflict", revision: a.revision };
    }
    if (patch.everyMinutes !== undefined) {
      const every = Math.floor(patch.everyMinutes);
      if (!Number.isFinite(every) || every < 1 || every > 525600) return { error: "间隔须为 1~525600 分钟" };
      a.everyMinutes = every;
      a.nextRunAt = Date.now() + every * 60_000; // 改间隔重排下次
    }
    if (patch.name !== undefined && patch.name.trim()) a.name = patch.name.trim();
    if (patch.instruction !== undefined && patch.instruction.trim()) a.instruction = patch.instruction.trim();
    if (patch.enabled !== undefined) a.enabled = patch.enabled;
    a.revision = (Number.isFinite(a.revision) ? a.revision : 1) + 1;
    this.persist();
    return a;
  }

  remove(id: string): boolean {
    const ok = this.items.delete(id);
    if (ok) this.persist();
    return ok;
  }

  /** 触发登记(调度或手动):排下次+记账。 */
  markRun(id: string, sessionId: string, now: number, trigger: "schedule" | "manual"): Automation | undefined {
    const a = this.items.get(id);
    if (!a) return undefined;
    a.lastRunAt = now;
    a.lastTaskSessionId = sessionId;
    a.runCount++;
    if (trigger === "schedule") a.nextRunAt = now + a.everyMinutes * 60_000;
    this.persist();
    return a;
  }

  get(id: string): Automation | undefined {
    return this.items.get(id);
  }

 /** 账本快照(键=`${id}@${instant}`,旧文件无字段=空账本)。 */
  occurrencesOf(id: string): Record<string, AutomationOccurrenceRecord> {
    return { ...(this.items.get(id)?.occurrences ?? {}) };
  }

 /** receipt 账本快照(键=`<id>#<occurrenceKey>`,旧文件无字段=空账本)。 */
  receiptsOf(id: string): Record<string, Receipt> {
    return { ...(this.items.get(id)?.receipt ?? {}) };
  }

 /** 写入一条投递 receipt:只保留最近 20 条 key(按 at 升序淘汰最旧)。 */
  writeReceipt(id: string, key: string, receipt: Receipt): void {
    const a = this.items.get(id);
    if (!a || !key) return;
    const ledger: Record<string, Receipt> = { ...(a.receipt ?? {}) };
    ledger[key] = receipt;
    a.receipt = pruneReceipts(ledger, RECEIPT_KEEP);
    this.persist();
  }

  private writeOccurrence(id: string, key: string, record: AutomationOccurrenceRecord): void {
    const a = this.items.get(id);
    if (!a) return;
    const ledger: Record<string, AutomationOccurrenceRecord> = { ...(a.occurrences ?? {}) };
    ledger[key] = record;
 // 容量上限:只保留最近 50 个发生,超出淘汰最旧。
    a.occurrences = pruneOccurrenceRecords(ledger, OCCURRENCE_RECORD_LIMIT);
    this.persist();
  }

 /** 认领一次计划发生:completed 拒、claimed 拒;failed/无记录可认领。 */
  claimOccurrence(id: string, instant: number, now: number): OccurrenceClaimCode {
    const a = this.items.get(id);
    if (!a) return "MISSING";
    const key = occurrenceKey(id, instant);
    if (!key) return "ALREADY_CLAIMED"; // 身份不可用:fail-closed,宁可跳过也不重复执行
    const existing = a.occurrences?.[key];
    if (existing?.status === "completed") return "ALREADY_COMPLETED";
    if (existing?.status === "claimed") return "ALREADY_CLAIMED";
    this.writeOccurrence(id, key, { status: "claimed", at: now });
    return "CLAIMED";
  }

 /** 完成一次计划发生:completed 幂等;提交已成功的事实优先记录。 */
  completeOccurrence(id: string, instant: number, now: number): boolean {
    const a = this.items.get(id);
    if (!a) return false;
    const key = occurrenceKey(id, instant);
    if (!key) return false;
    const existing = a.occurrences?.[key];
    if (existing?.status === "completed") return true;
    this.writeOccurrence(id, key, {
      status: "completed",
      at: now,
      ...(existing?.owner ? { owner: existing.owner } : {}),
    });
    return true;
  }

 /** 认领回收(提交失败):claimed→failed,下一次 claim 可重试;completed 不动。 */
  releaseOccurrence(id: string, instant: number, now: number): boolean {
    const a = this.items.get(id);
    if (!a) return false;
    const key = occurrenceKey(id, instant);
    if (!key) return false;
    const existing = a.occurrences?.[key];
    if (!existing || existing.status === "completed") return false;
    this.writeOccurrence(id, key, { ...existing, status: "failed", at: now });
    return true;
  }
}

/** 调度判定(纯函数,注入 now):启用的规则里 nextRunAt 已到者。 */
export function dueAutomations(items: Automation[], now: number): Automation[] {
  return items.filter((a) => a.enabled && a.nextRunAt <= now);
}

/**
 * 驱动器:tick(now)→ 对到期规则走 occurrence 账本(claim→receipt 门→submit→complete)并 markRun;
 * 每次触发落一条 automation.run 事件(带 receipt status/attempts)。
 */
export class AutomationScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: AutomationStore,
    private readonly onSubmit: (a: Automation, trigger: "schedule" | "manual") => string,
    private readonly onEvent: (e: AutomationEvent) => void,
    private readonly tickMs = 30_000) {}

  /** 定时驱动(unref 不阻退出)。 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(now = Date.now()): number {
    let n = 0;
    for (const a of dueAutomations(this.store.list(), now)) {
      const sid = this.fire(a, "schedule", now);
      if (sid) n++;
    }
    return n;
  }

  /** 手动「立即运行」(不重排 nextRun)。 */
  runNow(id: string): string | null {
    const a = this.store.get(id);
    if (!a) return null;
    return this.fire(a, "manual", Date.now());
  }

 /**
 * 单次触发:schedule 走 claim → receipt 门 → submit → receipt 落账;每次触发只落一条
 * automation.run 事件(带 receipt 结果)。manual 不 claim、不写 receipt(可重复)。
 */
  private fire(a: Automation, trigger: "schedule" | "manual", now: number): string | null {
    const sid = `auto-${a.id.slice(0, 8)}-${now.toString(36)}`;
    if (trigger === "manual") {
 // 手动触发不占计划发生:不 claim、不写 receipt,每次都可跑。
      this.onEvent({ at: now, automationId: a.id, sessionId: sid, trigger });
      this.onSubmit(a, trigger);
      this.store.markRun(a.id, sid, now, trigger);
      return sid;
    }
 // 发生身份 = (automationId, scheduled instant):用本轮到期的 nextRunAt,不用派发时刻。
    const instant = a.nextRunAt;
    const key = occurrenceKey(a.id, instant);
    const receiptKey = receiptKeyFor(a.id, key);
    const prev = receiptKey ? this.store.receiptsOf(a.id)[receiptKey] : undefined;
    const claim = this.store.claimOccurrence(a.id, instant, now);
    if (claim !== "CLAIMED") {
 // 已完成/已认领(single-flight):不提交,但仍 markRun 推进 nextRunAt,避免每 tick 重复尝试;tick 计数不计。
      this.onEvent({
        at: now, automationId: a.id, sessionId: sid, trigger, occurrenceKey: key, status: "skipped",
        ...(prev ? { receiptStatus: prev.status, receiptAttempts: prev.attempts } : {}),
      });
      this.store.markRun(a.id, sid, now, trigger);
      return null;
    }
 // receipt 门(claim 之后):DELIVERED/FAILED 不再投;PENDING 未到 nextAttemptAt 也不投。
    if (!this.receiptGateOpen(prev, now)) {
      this.onEvent({
        at: now, automationId: a.id, sessionId: sid, trigger, occurrenceKey: key, status: "skipped",
        ...(prev ? { receiptStatus: prev.status, receiptAttempts: prev.attempts } : {}),
      });
      this.store.markRun(a.id, sid, now, trigger);
      return null;
    }
    try {
      this.onSubmit(a, trigger);
    } catch (err) {
      const cls = classifyDeliveryError(err);
      const receipt = nextReceipt(prev, { ok: false, error: err }, { at: now, key: receiptKey });
      this.store.writeReceipt(a.id, receiptKey, receipt);
 // 认领回收:下一 tick 可重试;其它规则照常处理(不 rethrow,避免一条规则炸整个 tick)。
      this.store.releaseOccurrence(a.id, instant, now);
      this.onEvent({
        at: now, automationId: a.id, sessionId: sid, trigger, occurrenceKey: key, status: "failed",
        receiptStatus: receipt.status, receiptAttempts: receipt.attempts,
      });
 // permanent:receipt failed 且仍 markRun(不空转);transient:不推进 nextRunAt,下 tick 到点再试(受退避约束)。
      if (cls.kind === "permanent") this.store.markRun(a.id, sid, now, trigger);
      return null;
    }
    const receipt = nextReceipt(prev, { ok: true }, { at: now, key: receiptKey });
    this.store.writeReceipt(a.id, receiptKey, receipt);
    this.store.completeOccurrence(a.id, instant, now);
    this.onEvent({
      at: now, automationId: a.id, sessionId: sid, trigger, occurrenceKey: key, status: "claimed",
      receiptStatus: receipt.status, receiptAttempts: receipt.attempts,
    });
    this.store.markRun(a.id, sid, now, trigger);
    return sid;
  }

 /**
 * receipt 退避门:无 receipt → 开(首次投递);PENDING 严格按 nextAttemptAt 判——首次 transient
 * 也从 30s 退避起(now<nextAttemptAt 一律不提交);DELIVERED/FAILED → 关(不重投/不重试)。
 */
  private receiptGateOpen(receipt: Receipt | undefined, now: number): boolean {
    if (!receipt) return true;
    return isReady(receipt, now);
  }
}
