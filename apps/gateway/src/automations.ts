/**
 * 定时自动化(ZCode AutomationsSection/automationCron 移植):
 * 保存的规则{name, instruction, everyMinutes, enabled}持久化 .genie/automations.json;
 * 调度判定=纯函数(check 注入 now),驱动侧 30s tick;到点经回调提交 system 任务。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

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
}

export interface AutomationEvent {
  at: number;
  automationId: string;
  sessionId: string;
  trigger: "schedule" | "manual";
}

export class AutomationStore {
  private items = new Map<string, Automation>();

  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        const arr = JSON.parse(readFileSync(file, "utf-8")) as Automation[];
        for (const a of arr) if (a && a.id && a.instruction) this.items.set(a.id, a);
      } catch {
        // 坏文件容忍:空表起步
      }
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
      ...(input.scope ? { scope: input.scope } : {}),
    };
    this.items.set(a.id, a);
    this.persist();
    return a;
  }

  update(id: string, patch: { name?: string; instruction?: string; everyMinutes?: number; enabled?: boolean }): Automation | { error: string } {
    const a = this.items.get(id);
    if (!a) return { error: "不存在" };
    if (patch.everyMinutes !== undefined) {
      const every = Math.floor(patch.everyMinutes);
      if (!Number.isFinite(every) || every < 1 || every > 525600) return { error: "间隔须为 1~525600 分钟" };
      a.everyMinutes = every;
      a.nextRunAt = Date.now() + every * 60_000; // 改间隔重排下次
    }
    if (patch.name !== undefined && patch.name.trim()) a.name = patch.name.trim();
    if (patch.instruction !== undefined && patch.instruction.trim()) a.instruction = patch.instruction.trim();
    if (patch.enabled !== undefined) a.enabled = patch.enabled;
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
}

/** 调度判定(纯函数,注入 now):启用的规则里 nextRunAt 已到者。 */
export function dueAutomations(items: Automation[], now: number): Automation[] {
  return items.filter((a) => a.enabled && a.nextRunAt <= now);
}

/**
 * 驱动器:tick(now)→对到期规则经 onSubmit 提交任务并 markRun;
 * journal-first:每次触发先落 automation.run 事件再提交。
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

  private fire(a: Automation, trigger: "schedule" | "manual", now: number): string | null {
    const sid = `auto-${a.id.slice(0, 8)}-${now.toString(36)}`;
    this.onEvent({ at: now, automationId: a.id, sessionId: sid, trigger });
    this.onSubmit(a, trigger);
    this.store.markRun(a.id, sid, now, trigger);
    return sid;
  }
}
