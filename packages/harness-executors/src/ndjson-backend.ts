/**
 * SubagentBackend 契约( §1 定稿)+ NDJSON-RPC 子进程基类。
 * backend 内部 session/工具细节永不反序列化给主控(dsh 私有边界原则)。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import {
  confineSpec,
  type ConfinementCapabilities,
  type ConfinementFacts,
  type ConfinementPolicy,
  type ConfinementRunner,
} from "./sandbox-confinement";

export interface TaskSpec {
  taskId: string;
  instructions: string;
  workdir: string;
  permissions: "readonly" | "sandbox" | "inherit";
  budget?: { tokens?: number; wallClockSec?: number };
  env?: Record<string, string>;
 /** 派生权限规则(父 deny 下传的收敛集;executor 侧按能力采纳)。 */
  permissionRules?: { permission: string; pattern: string; action: "allow" | "deny" | "ask" }[];
 /** 父中止信号( ZCode createSubagentTaskAbortController 语义):父 loop 取消→子代理一并取消。 */
  parentSignal?: AbortSignal;
}

export interface TaskResult {
  ok: boolean;
  finalText?: string;
  artifacts?: { path: string; mime: string }[];
  error?: { kind: "timeout" | "cancelled" | "backend-crash" | "budget-exhausted" | "spawn-failed" | "stalled"; detail?: string };
}

export type SubagentEvent =
  | { type: "ready" }
  | { type: "progress"; note: string; pct?: number }
  | { type: "permission-ask"; requestId: string; summary: string; risk: "low" | "high" }
  | { type: "result"; result: TaskResult };

export interface SubagentHandle {
  readonly taskId: string;
  readonly pid?: number;
 /** ACP 后端会话 id(非 ACP 后端缺席)——接线侧据此落 journal。 */
  readonly acpSessionId?: string;
  /** ACP adapter 标识(内置名/命令;非 ACP 后端缺席)。 */
  readonly acpAdapter?: string;
  cancel(mode: "graceful" | "force"): Promise<void>;
  steer(text: string, mode: "hint" | "directive"): Promise<boolean>;
 /** 权限应答:对子进程 permission-ask 的回流——此前 ask 有来无回必挂死。 */
  respondPermission(requestId: string, decision: "allow-once" | "reject"): Promise<void>;
}

export interface SubagentBackend {
  readonly kind: string;
  spawn(spec: TaskSpec, onEvent: (e: SubagentEvent) => void): Promise<SubagentHandle>;
}

/** 子进程状态机。 */
type ChildState = "spawning" | "ready" | "running" | "done" | "failed" | "cancelled";

/**
 * 被沙箱门拒绝时的空句柄:没有子进程,所有控制动作都是安全 no-op。
 * 返回句柄而不是 throw——调用方已从 result 事件拿到失败原因,throw 只会被当成宿主崩溃。
 */
function deniedHandle(taskId: string): SubagentHandle {
  return {
    taskId,
    async cancel() {},
    async steer() {
      return false;
    },
    async respondPermission() {},
  };
}

/**
 * NDJSON-RPC over stdio 子进程基类:
 * 一行一个 JSON;spawn→ready(超时判失败)→progress→result;cancel 三板斧。
 */
export abstract class NdjsonChildBackend implements SubagentBackend {
  abstract readonly kind: string;
  /** 子进程命令与参数。 */
  abstract command(spec: TaskSpec): { cmd: string; args: string[]; env?: Record<string, string> };
  /** ready 等待超时。 */
  readyTimeoutMs = 5000;
 /** 最近一次派发的沙箱事实(测试/观测用;被拒绝时也写入)。 */
  lastConfinement?: ConfinementFacts;
 /** 最近一次实际下发给子进程的 spawn 载荷(新增 confinement 字段的取证点)。 */
  lastSpawnMessage?: Record<string, unknown>;

 /** runner 归因:基类登记为 ndjson;echo 等子类覆写。 */
  protected confinementKind(): ConfinementRunner {
    return "ndjson";
  }

 /** 该 runner 的隔离能力快照。基类按四项全能力登记;echo 覆写为全 false。 */
  protected confinementCapabilities(): ConfinementCapabilities {
    return { fsIsolation: true, networkIsolation: true, processIsolation: true, envScrub: true };
  }

 /** 派发策略缺省全拒(需要放行时由子类/调用方显式给 policy)。 */
  protected confinementPolicy(): ConfinementPolicy {
    return {};
  }

  async spawn(spec: TaskSpec, onEvent: (e: SubagentEvent) => void): Promise<SubagentHandle> {
 // 沙箱门在 spawn 之前:声明不等于事实,违规的 spec 连子进程都不给起。
    const verdict = confineSpec(
      {
        permissions: spec.permissions,
        workdir: spec.workdir,
        instructions: spec.instructions,
 // 只往下传 spec 显式携带的 env 覆盖量;不把 process.env 塞进来(否则凭据面永远命中)
        env: spec.env,
      },
      this.confinementPolicy(),
      { backendKind: this.confinementKind(), capabilities: this.confinementCapabilities() },
    );
    this.lastConfinement = verdict.facts;
    if (!verdict.ok) {
      onEvent({
        type: "result",
        result: {
          ok: false,
          error: { kind: "spawn-failed", detail: `sandbox-confinement-denied: ${verdict.violations.join("; ")}`.slice(0, 300) },
        },
      });
      return deniedHandle(spec.taskId);
    }

    const { cmd, args, env } = this.command(spec);
    const child = spawn(cmd, args, {
      cwd: spec.workdir,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
 // spawn 失败(ENOENT 等)必接住:上抛会把宿主进程整个带崩(规划任务派发经验证)。
    child.on("error", (err) => {
      if (state === "spawning" || state === "running") {
        state = "failed";
        onEvent({ type: "result", result: { ok: false, error: { kind: "spawn-failed", detail: String(err).slice(0, 200) } } });
      }
    });

    let state: ChildState = "spawning";
    const pending = new Map<string, (v: unknown) => void>();

    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // 非 JSON 行(子进程日志)忽略
      }
      // RPC 响应
      if (typeof msg.id === "string" && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
        return;
      }
      // 事件
      switch (msg.type) {
        case "ready":
          if (state === "spawning") state = "ready";
          onEvent({ type: "ready" });
          break;
        case "progress":
          onEvent({ type: "progress", note: String(msg.note ?? ""), pct: msg.pct as number | undefined });
          break;
        case "permission.ask":
          onEvent({ type: "permission-ask", requestId: String(msg.requestId), summary: String(msg.summary ?? ""), risk: msg.risk === "high" ? "high" : "low" });
          break;
        case "result":
          state = msg.ok ? "done" : "failed";
          onEvent({ type: "result", result: msg as unknown as TaskResult });
          break;
      }
    });

    const send = (msg: Record<string, unknown>): Promise<unknown> => {
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        pending.set(id, resolve);
        child.stdin!.write(JSON.stringify({ id, ...msg }) + "\n");
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error("子进程响应超时"));
          }
        }, this.readyTimeoutMs);
      });
    };

    // ready 闸门与 spawn 指令并发:子进程收到 spawn 才回 ready。
    const readyGate = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (state === "spawning") {
          state = "failed";
          child.kill("SIGKILL");
          onEvent({ type: "result", result: { ok: false, error: { kind: "spawn-failed", detail: "ready 超时" } } });
          reject(new Error("ready 超时"));
        }
      }, this.readyTimeoutMs);
      const onReady = (e: SubagentEvent) => {
        if (e.type === "ready") {
          clearTimeout(timer);
          state = "running";
          resolve();
        }
      };
      const origOnEvent = onEvent;
      onEvent = (e) => { onReady(e); origOnEvent(e); };
    });

 // 发送 spawn 指令:confinement 是新增可选字段,老 child 忽略它照常工作。
    const spawnMessage: Record<string, unknown> = {
      type: "spawn",
      taskId: spec.taskId,
      instructions: spec.instructions,
      permissions: spec.permissions,
      budget: spec.budget,
      ...(spec.permissionRules ? { permissionRules: spec.permissionRules } : {}),
      confinement: verdict.facts,
    };
    this.lastSpawnMessage = spawnMessage;
    await send(spawnMessage);
    await readyGate;

    const self = this;
    return {
      taskId: spec.taskId,
      pid: child.pid,
      async cancel(mode) {
        if (state !== "running") return;
        state = "cancelled";
        if (mode === "graceful") {
          try {
            await Promise.race([
              send({ type: "cancel", taskId: spec.taskId }),
              new Promise((_, rej) => setTimeout(() => rej(new Error("cancel 超时")), 1500)),
            ]);
            return;
          } catch {
            // 升级
          }
        }
        child.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 1500));
        if (child.exitCode === null) child.kill("SIGKILL");
      },
      async steer(text, mode) {
        if (state !== "running") return false;
        try {
          const res = (await send({ type: "steer", taskId: spec.taskId, text, mode })) as { accepted?: boolean };
          return res.accepted === true;
        } catch {
          return false;
        }
      },
      async respondPermission(requestId, decision) {
        await send({ type: "permission.respond", requestId, decision });
      },
    };
  }
}
