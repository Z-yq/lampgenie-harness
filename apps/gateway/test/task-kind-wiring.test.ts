import { AGENT_WIRING_SRC } from "./panel-source.js";
/**
 * agent-wiring 逐类守卫接线测试:纯路径(runtime task-kind 纯函数 + TaskSupervisor 真实例)
 * + 源码断言(接线必须在场,防止「能力表写了但没接上」)。
 * 覆盖探针:A) 8 类能力表齐; B) 未知 kind → user + normalized=false; C) reminder guard write_file DENY;
 * D) 工具过滤(reminder 无 terminal/write/spawn,minimal 保留); E) memoryScope none 跳过注入的接线;
 * F) 默认 user 工具面逐字不变; G) journal 留痕接线。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  TASK_KINDS,
  TASK_KIND_CAPABILITIES,
  taskKindCapabilities,
  kindGuard,
  filterToolNamesByKindCapabilities,
} from "@lampgenie/runtime/task/task-kind";
import { TaskSupervisor as RuntimeTaskSupervisor } from "@lampgenie/runtime/task/task-manager";

const WIRING = AGENT_WIRING_SRC;
const MANAGER = readFileSync(resolve(__dirname, "../../../packages/harness-runtime/src/task/task-manager.ts"), "utf8");

const ALL_NAMES = [
  "spawn_subagent", "steer_agent", "resume_agent", "stop_agent", "list_agents",
  "terminal", "run_cmd", "write_file", "edit_file", "apply_patch", "board_upsert",
  "read_file", "glob", "grep", "code_sense", "tool_view", "todo_write", "task_phase", "ask_user",
];

describe("A/B/C) 纯路径:能力表 / 归一 / guard", () => {
  it("A) 8 类能力表齐,每类都有能力对象", () => {
    expect(TASK_KINDS.length).toBe(8);
    for (const kind of TASK_KINDS) {
      expect(TASK_KIND_CAPABILITIES[kind], kind).toBeTruthy();
    }
  });

  it("B) 未知 kind → user 能力 + UNKNOWN_KIND(normalized=false 不静默)", () => {
    const look = taskKindCapabilities("work");
    expect(look.kind).toBe("user");
    expect(look.code).toBe("UNKNOWN_KIND");
    expect(look.capabilities.memoryScope).toBe("project");
  });

  it("C) reminder guard:write_file/terminal/spawn 全 DENY,user 全 OK", () => {
    expect(kindGuard("reminder", "write_file")).toEqual({ allow: false, code: "KIND_DENY" });
    expect(kindGuard("reminder", "terminal")).toEqual({ allow: false, code: "KIND_DENY" });
    expect(kindGuard("reminder", "spawn_subagent")).toEqual({ allow: false, code: "KIND_DENY" });
    expect(kindGuard("user", "write_file")).toEqual({ allow: true, code: "OK" });
  });
});

describe("D/F) 工具面过滤(纯路径)", () => {
  it("D) reminder:无 terminal/run_cmd/write_file/board_upsert/spawn,minimal + 只读保留", () => {
    const { kept, removed } = filterToolNamesByKindCapabilities(ALL_NAMES, TASK_KIND_CAPABILITIES.reminder);
    for (const name of ["terminal", "run_cmd", "write_file", "edit_file", "apply_patch", "board_upsert", "spawn_subagent"]) {
      expect(kept, name).not.toContain(name);
      expect(removed, name).toContain(name);
    }
    expect(kept).toEqual(["read_file", "glob", "grep", "code_sense", "tool_view", "todo_write", "task_phase", "ask_user"]);
  });

  it("F) 默认 user:removed 为空,kept 逐字同序(工具面不变)", () => {
    const { kept, removed } = filterToolNamesByKindCapabilities(ALL_NAMES, TASK_KIND_CAPABILITIES.user);
    expect(removed).toEqual([]);
    expect(kept).toEqual(ALL_NAMES);
  });
});

describe("E/G) 接线源码断言(能力表真的接上了)", () => {
  it("runWithAgent 取 caps:优先任务自带 kindCapabilities,否则按 kind 查表", () => {
    expect(WIRING).toContain("taskKindCapabilities(taskKindInfo.kind).capabilities");
    expect(WIRING).toContain("taskKindCarrier.kindCapabilities");
    expect(WIRING).toContain('normalizeTaskKind(taskKindCarrier.kind ?? "user")');
  });

  it("工具面过滤:filterToolNamesByKindCapabilities(mainTools.map(...), taskKindCaps)", () => {
    expect(WIRING).toContain("filterToolNamesByKindCapabilities(mainTools.map((t) => t.name), taskKindCaps)");
    expect(WIRING).toContain("mainTools.splice(0, mainTools.length, ...mainTools.filter((t) => keep.has(t.name)))");
  });

  it("E) 记忆注入:memoryScope !== \"none\" 才注入(guard 在既有注入点前)", () => {
    expect(WIRING).toContain('taskKindCaps.memoryScope !== "none"');
    const guardIdx = WIRING.indexOf('taskKindCaps.memoryScope !== "none"');
    const blockIdx = WIRING.indexOf("memory.contextBlockFrozen");
    expect(guardIdx).toBeGreaterThan(0);
    expect(blockIdx).toBeGreaterThan(guardIdx);
  });

  it("G) journal 留痕:type=task.kind.tools 且带 kind/removed 与一次/任务去重", () => {
    expect(WIRING).toContain('type: "task.kind.tools"');
    expect(WIRING).toContain("kind: taskKindInfo.kind");
    expect(WIRING).toContain("removed: kindFilter.removed");
    expect(WIRING).toContain("taskKindToolsLogged");
  });

  it("manager 接线:create/createScheduled 归一 kind 并挂 kindCapabilities;canAnnounce 门在此", () => {
    expect(MANAGER).toContain("normalizeTaskKind(options.kind ?? 'user')");
    expect(MANAGER).toContain("kindCapabilities: taskKindCapabilities(normalizedKind.kind).capabilities");
    expect(MANAGER).toContain("if (caps.canAnnounce === false) return false");
    expect(MANAGER).toContain("function withKindCapabilities");
  });
});

describe("真实例任务:kind 与能力位随视图透传", () => {
  it("create() 缺省 kind=user,caps 全能力 project,视图可读", () => {
    const tm = new RuntimeTaskSupervisor({ maxConcurrent: 2 });
    const view = tm.create({ objective: "默认任务", ownerId: "o1", sessionId: "s1" }) as Record<string, unknown>;
    expect(view.kind).toBe("user");
    expect(view.kindCapabilities).toMatchObject({ canWriteFiles: true, memoryScope: "project" });
    expect(view.kindOriginal).toBeUndefined();
  });

  it("B) create({kind:'weird'}) → user + kindOriginal 保留原值", () => {
    const tm = new RuntimeTaskSupervisor({ maxConcurrent: 2 });
    const view = tm.create({ objective: "幽灵 kind", ownerId: "o1", sessionId: "s1", kind: "weird" }) as Record<string, unknown>;
    expect(view.kind).toBe("user");
    expect(view.kindOriginal).toBe("weird");
    expect(view.kindCapabilities).toMatchObject({ canWriteFiles: true });
  });

  it("create({kind:'reminder'}) → 只读能力位随视图透传", () => {
    const tm = new RuntimeTaskSupervisor({ maxConcurrent: 2 });
    const view = tm.create({ objective: "提醒", ownerId: "o1", sessionId: "s1", kind: "reminder" }) as Record<string, unknown>;
    expect(view.kind).toBe("reminder");
    expect(view.kindCapabilities).toMatchObject({
      canSpawnSubagent: false, canUseTerminal: false, canWriteFiles: false, memoryScope: "session",
    });
    expect((view.kindCapabilities as { minimalLifecycleTools: string[] }).minimalLifecycleTools)
      .toEqual(["todo_write", "task_phase", "ask_user"]);
  });

  it("createScheduled(type=reminder/scheduled_task) 都挂对应能力位", () => {
    const tm = new RuntimeTaskSupervisor({ maxConcurrent: 2 });
    const reminder = tm.createScheduled({
      objective: "到点提醒", ownerId: "o1", sessionId: "s1", schedule: { at: Date.now() + 60_000 },
    }) as Record<string, unknown>;
    expect(reminder.kind).toBe("reminder");
    expect(reminder.kindCapabilities).toMatchObject({ canWriteFiles: false, memoryScope: "session" });

    const scheduled = tm.createScheduled({
      objective: "定时任务", ownerId: "o1", sessionId: "s1", type: "task", schedule: { at: Date.now() + 60_000 },
    }) as Record<string, unknown>;
    expect(scheduled.kind).toBe("scheduled_task");
    expect(scheduled.kindCapabilities).toMatchObject({ canWriteFiles: false, memoryScope: "session" });
  });

  it("E) 8 类里没有 memoryScope=none 的 kind(none 仅作类型面合法值/自定义 caps)", () => {
    for (const kind of TASK_KINDS) {
      expect(TASK_KIND_CAPABILITIES[kind].memoryScope, kind).not.toBe("none");
    }
  });
});
