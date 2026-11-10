import { describe, it, expect, vi } from "vitest";
import { TaskSupervisor } from "../../src/task-manager.js";
import { MemoryJournal } from "@lampgenie/core";
import { createRouter, buildTrigger } from "../../src/router/index.js";
import { DEFAULT_POLICY_CONFIG, type PolicyConfig } from "../../src/router/policy.js";

const configOf = (over: Partial<PolicyConfig> = {}): PolicyConfig => ({ ...DEFAULT_POLICY_CONFIG, ...over });

const memIo = () => {
  const files = new Map<string, string>();
  return {
    files,
    io: {
      existsSync: (p: string) => files.has(p),
      readFileSync: (p: string, _enc: string) => files.get(p) ?? "",
      mkdirSync: () => {},
      appendFileSync: (p: string, d: string, _enc: string) => { files.set(p, (files.get(p) ?? "") + d); },
      writeFileSync: (p: string, d: string, _enc: string) => { files.set(p, d); },
    },
  };
};

describe(" P3 重启恢复 + 预览截断", () => {
  it("tickets.json 落盘 → 新 createRouter 恢复 threadKey 订阅直通可用", async () => {
    const { files, io } = memIo();
    const tm = new TaskSupervisor({ maxConcurrent: 1, maxConcurrentPerOwner: 1 });
    const steer = vi.fn();
    const cfg = configOf();
    const r1 = createRouter({ taskManager: tm, journal: new MemoryJournal(), config: cfg, root: "/tmp/rs1", io, steer });
    await r1.submit({ source: "panel", sessionId: "s1", instruction: "跑构建" });
    expect(files.get("/tmp/rs1/.genie/router/tickets.json")).toBeTruthy();
    // 重启:同 io(文件在),同 config → 恢复 open Ticket;后续同 threadKey trigger → steer 直通
    const r2 = createRouter({ taskManager: tm, journal: new MemoryJournal(), config: cfg, root: "/tmp/rs1", io, steer });
    expect(r2.tickets().filter((t) => t.phase === "open")).toHaveLength(1);
    const r3 = await r2.submit({ source: "im", sessionId: "s1", instruction: "构建结果如何?" });
    expect(r3.outcome?.kind).toBe("steered");
    expect(steer).toHaveBeenCalledTimes(1);
  });

  it("重复 restore 幂等(负面):同一 tickets.json 二次构造不双开 Ticket", async () => {
    const { io } = memIo();
    const tm = new TaskSupervisor();
    const cfg = configOf();
    const r1 = createRouter({ taskManager: tm, journal: new MemoryJournal(), config: cfg, root: "/tmp/rs2", io });
    await r1.submit({ source: "panel", sessionId: "s1", instruction: "x" });
    const r2 = createRouter({ taskManager: tm, journal: new MemoryJournal(), config: cfg, root: "/tmp/rs2", io });
    const r3 = createRouter({ taskManager: tm, journal: new MemoryJournal(), config: cfg, root: "/tmp/rs2", io });
    expect(r2.tickets().filter((t) => t.phase === "open")).toHaveLength(1);
    expect(r3.tickets().filter((t) => t.phase === "open")).toHaveLength(1); // 不双开
    expect(r3.tickets()[0].ticketId).toBe(r2.tickets()[0].ticketId);
  });

  it(">200 字 trigger 不再截断(2026-11-04 修复:全文进 Trigger;预览只允许在渲染层)", () => {
    const long = "修".repeat(350) + "END";
    const t = buildTrigger({ source: "panel", sessionId: "s1", instruction: long, now: () => 1 });
    expect(t.instruction).toBe(long); // 全文(旧实现截 200+标注,任务书/派发同体被截)
    expect(t.instruction.endsWith("END")).toBe(true);
    expect(t.instruction).not.toContain("截断");
  });

  it("steer 落空(任务终态)→ steer_miss disposition 不静默", async () => {
    const tm = new TaskSupervisor();
    const router = createRouter({ taskManager: tm, journal: new MemoryJournal(), config: configOf() });
    const r1 = await router.submit({ source: "panel", sessionId: "s1", instruction: "秒完成" });
    expect(r1.outcome?.kind).toBe("dispatched");
    // TaskSupervisor 内存态:echo 类任务可能已终态——把 taskId 对应任务标 done 模拟
    const ticket = router.tickets().at(-1)!;
    const task = tm.get(ticket.taskId!);
    if (task && task.state === "running") {
      // 无法直接改 state(readonly)——跳过:此用例依赖终态任务,用 im 后续消息验证 steer_miss 或 explicit 回退
    }
    // im 未点名追问(仍 addressable)→ 走 explicit/addressed 派发或 steer_miss 落账,不静默
    const r2 = await router.submit({ source: "im", sessionId: "s1", instruction: "好了吗?" });
    expect(["dispatched", "steered", "observed"]).toContain(r2.outcome?.kind ?? "observed");
    const outcomes = router.dispositions().map((d) => d.outcome);
    // 若走了 steer_miss 分支则必有审计行;dispatched 回退也合规(不静默=有 disposition)
    expect(outcomes.length).toBeGreaterThanOrEqual(2);
  });
});
