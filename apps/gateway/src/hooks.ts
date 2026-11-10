/**
 * 任务生命周期钩子(ZCode hooks 概念裁剪):.genie/hooks.json。
 * 事件:task.start/task.done/task.fail/task.cancel;动作:在项目根执行一条命令(30s 超时;
 * shell 由 shell-invocation 决定:POSIX=bash 登录 shell(-lc 语义),Windows=cmd.exe /d /s /c,GENIE_SHELL_BIN 可覆盖)。
 * 纪律:fail-soft(钩子失败不影响任务;结果落 journal hook.run 可观测);命令跑在项目根,输出只留摘要。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { shellErrorHint, shellInvocation } from "./shell-invocation.js";
import type { Journal, Task } from "@lampgenie/core";

export type HookEvent = "task.start" | "task.done" | "task.fail" | "task.cancel";
export const HOOK_EVENTS: HookEvent[] = ["task.start", "task.done", "task.fail", "task.cancel"];

export interface Hook {
  id: string;
  name: string;
  event: HookEvent;
  command: string;
  enabled: boolean;
  createdAt: number;
  lastRunAt: number | null;
  lastOk: boolean | null;
  lastOutput: string;
}

export class HookStore {
  private items = new Map<string, Hook>();

  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        const arr = JSON.parse(readFileSync(file, "utf-8")) as Hook[];
        for (const h of arr) if (h && h.id && h.command) this.items.set(h.id, h);
      } catch {
        // 坏文件容忍:空表起步
      }
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify([...this.items.values()], null, 2) + "\n");
  }

  list(): Hook[] {
    return [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  add(input: { name: string; event: string; command: string }): Hook | { error: string } {
    const name = String(input.name || "").trim();
    const command = String(input.command || "").trim();
    const event = String(input.event || "");
    if (!name) return { error: "名称为空" };
    if (!command) return { error: "命令为空" };
    if (!HOOK_EVENTS.includes(event as HookEvent)) return { error: "事件须为 " + HOOK_EVENTS.join("/") };
    const h: Hook = {
      id: randomUUID(), name, event: event as HookEvent, command, enabled: true,
      createdAt: Date.now(), lastRunAt: null, lastOk: null, lastOutput: "",
    };
    this.items.set(h.id, h);
    this.persist();
    return h;
  }

  update(id: string, patch: { enabled?: boolean; command?: string; name?: string }): Hook | undefined {
    const h = this.items.get(id);
    if (!h) return undefined;
    if (patch.enabled !== undefined) h.enabled = patch.enabled;
    if (patch.command !== undefined && patch.command.trim()) h.command = patch.command.trim();
    if (patch.name !== undefined && patch.name.trim()) h.name = patch.name.trim();
    this.persist();
    return h;
  }

  remove(id: string): boolean {
    const ok = this.items.delete(id);
    if (ok) this.persist();
    return ok;
  }

  markRun(id: string, ok: boolean, output: string): void {
    const h = this.items.get(id);
    if (!h) return;
    h.lastRunAt = Date.now();
    h.lastOk = ok;
    h.lastOutput = output.slice(0, 300);
    this.persist();
  }
}

/** 单条钩子执行:在项目根执行命令(shell 由 shellInvocation 决定:POSIX=bash 登录 shell(-lc),Win32=cmd.exe /d /s /c),
 *  30s 超时,fail-soft。shell 缺位(ENOENT)时把「装 Git for Windows / 设 GENIE_SHELL_BIN」提示拼进输出,不静默吞。 */
function execHook(command: string, cwd: string): Promise<{ ok: boolean; code: number | null; output: string }> {
  const inv = shellInvocation(command, { cwd });
  return new Promise((resolve) => {
    // WSL 项目:cwd 由 wsl.exe --cd 承担(UNC 不作为 Windows 进程工作目录使用)。
    execFile(inv.cmd, inv.args, { cwd: inv.mode === "wsl" ? undefined : cwd, timeout: 30_000, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : err ? 1 : 0;
      const hint = shellErrorHint(err, inv);
      const output = (String(stdout || "") + String(stderr || "") + (hint ? "\n" + hint : "")).trim();
      resolve({ ok: !err, code, output });
    });
  });
}

/** 事件触达:对启用中的匹配钩子逐个执行并落 journal(返回执行条数)。 */
export async function runHookEvent(store: HookStore, journal: Journal, event: HookEvent, task: Task, cwd: string): Promise<number> {
  let n = 0;
  for (const h of store.list()) {
    if (!h.enabled || h.event !== event) continue;
    n++;
    const r = await execHook(h.command, cwd);
    store.markRun(h.id, r.ok, r.output);
    journal.append({
      kind: "hook.run",
      sessionId: task.sessionId,
      payload: { hookId: h.id, name: h.name, event, taskId: task.id, ok: r.ok, code: r.code, output: r.output.slice(0, 500) },
    });
  }
  return n;
}
