/**
 * 定时计划持久化:RuntimeTaskSupervisor 的 store 后端。
 * 接口形状由 runtime TaskStore(packages/harness-runtime/src/task/task-repository.ts)决定:
 * load: any[] / nextTaskNumber / nextJobNumber / save(tasks, meta?) / saveDeferred(tasks, meta?)
 * 语义:
 * - 文件不存在 / 坏 JSON / 形状不符 → 空表,绝不 throw 到调用方;
 * - save 同步原子写(tmp + rename,父目录自动创建);
 * - saveDeferred 200ms 防抖合并(窗口内多次调用只落最后一次快照);flush 强制落盘;
 * - 落盘失败只 console.warn 一次,不把异常抛回调度器。
 * 只做搬运:调用方(序列化投影在 runtime TaskStore)给什么就存什么,不裁剪字段。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const DEBOUNCE_MS = 200;

export interface ScheduledTaskStoreMeta {
  nextTaskNumber?: number;
  nextJobNumber?: number;
  [key: string]: unknown;
}

interface ScheduledTaskStoreDoc {
  version: number;
  savedAt: number;
  tasks: unknown[];
  meta: ScheduledTaskStoreMeta;
}

function saneNumber(value: unknown, fallback = 1): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

export class ScheduledTaskFileStore {
  readonly file: string;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: { tasks: unknown[]; meta: ScheduledTaskStoreMeta } | null = null;
  private taskNumber = 1;
  private jobNumber = 1;
  private warned = false;
  private tmpSeq = 0;

  constructor({ file, now = () => Date.now() }: { file: string; now?: () => number }) {
    this.file = file;
    this.now = now;
  }

 // —— 发号游标(TaskStore.load 读这两个 getter;save 时写回 meta)——
  get nextTaskNumber(): number {
    return this.taskNumber;
  }

  set nextTaskNumber(value: number) {
    this.taskNumber = saneNumber(value, this.taskNumber);
  }

  get nextJobNumber(): number {
    return this.jobNumber;
  }

  set nextJobNumber(value: number) {
    this.jobNumber = saneNumber(value, this.jobNumber);
  }

 /** 文件不存在 / 坏 JSON / 形状不符 → [];永不 throw。 */
  load(): unknown[] {
    let parsed: unknown;
    try {
      if (!existsSync(this.file)) return [];
      parsed = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return [];
    }
 // 兼容裸数组(手工/早期文件)与带 meta 的对象两种形状。
    if (Array.isArray(parsed)) return parsed;
    if (!parsed || typeof parsed !== "object") return [];
    const doc = parsed as Partial<ScheduledTaskStoreDoc>;
    const meta = doc.meta && typeof doc.meta === "object"
      ? doc.meta as ScheduledTaskStoreMeta
      : {};
    this.taskNumber = saneNumber(meta.nextTaskNumber ?? meta.nextJobNumber, this.taskNumber);
    this.jobNumber = saneNumber(meta.nextJobNumber ?? meta.nextTaskNumber, this.jobNumber);
    return Array.isArray(doc.tasks) ? doc.tasks : [];
  }

 /** 同步落盘(取消在途防抖,后写覆盖先写)。 */
  save(tasks: unknown[] = [], meta: ScheduledTaskStoreMeta = {}): void {
    this.cancelTimer();
    this.pending = null;
    this.writeNow(tasks, meta);
  }

 /** 防抖落盘:200ms 窗口内合并,只落最后一次快照。 */
  saveDeferred(tasks: unknown[] = [], meta: ScheduledTaskStoreMeta = {}): void {
    this.pending = {
      tasks: Array.isArray(tasks) ? tasks : [],
      meta: meta && typeof meta === "object" ? meta : {},
    };
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, DEBOUNCE_MS);
  }

 /** 强制把在途快照落盘(进程收尾 / 测试用)。 */
  flush(): void {
    this.cancelTimer();
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    this.writeNow(pending.tasks, pending.meta);
  }

 /** 收尾:落盘 + 清定时器。 */
  close(): void {
    this.flush();
  }

  private cancelTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private writeNow(tasks: unknown[], meta: ScheduledTaskStoreMeta): void {
    const doc: ScheduledTaskStoreDoc = {
      version: 1,
      savedAt: this.now(),
      tasks: Array.isArray(tasks) ? tasks : [],
      meta: {
        ...meta,
        nextTaskNumber: saneNumber(meta?.nextTaskNumber, this.taskNumber),
        nextJobNumber: saneNumber(meta?.nextJobNumber ?? meta?.nextTaskNumber, this.jobNumber),
      },
    };
    this.taskNumber = doc.meta.nextTaskNumber as number;
    this.jobNumber = doc.meta.nextJobNumber as number;
    let tmp: string | null = null;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      this.tmpSeq += 1;
      tmp = `${this.file}.${process.pid}.${this.tmpSeq}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
      renameSync(tmp, this.file);
      tmp = null;
    } catch (error) {
      if (tmp) {
        try {
          rmSync(tmp, { force: true });
        } catch { /* 清理失败不影响调用方 */ }
      }
      if (!this.warned) {
        this.warned = true;
 // 只告警一次:反复失败(磁盘满/权限)不应刷日志。
        console.warn(`[scheduled-task-store] 落盘失败(file=${this.file}):`, error);
      }
    }
  }
}
