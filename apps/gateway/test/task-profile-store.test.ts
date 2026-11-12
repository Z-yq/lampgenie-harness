import { AGENT_WIRING_SRC } from "./panel-source.js";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TASK_PROFILES_VERSION,
  addTaskProfile,
  applyTaskProfile,
  listTaskProfiles,
  loadTaskProfiles,
  removeTaskProfile,
  reportTaskProfiles,
  resolveTaskProfileAt,
  saveTaskProfiles,
  showTaskProfile,
  taskProfilesPath,
  type TaskProfilesFileLike,
} from "../src/task-profile-store";
import type { TaskProfile } from "@lampgenie/runtime/agent/task-profile";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "m161-profile-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const coding: TaskProfile = {
  id: "coding-default",
  taskClass: "coding",
  maxSteps: 120,
  tools: { allow: ["read_file", "write_file"], deny: ["terminal"] },
  skills: { allow: ["builtin/codebase-inspection"] },
  model: { model: "gpt-5", effort: "high" },
  presetRevision: "rev-2",
};

/** 直接写档案文件(测试坏文件/坏条目用)。 */
function writeRaw(value: unknown): void {
  const path = taskProfilesPath(root);
  mkdirSync(join(root, ".genie"), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

describe("loadTaskProfiles:缺失/坏文件/坏条目", () => {
  it("文件缺失=空表 OK(零行为变化基线)", async () => {
    const r = await loadTaskProfiles(root);
    expect(r.ok).toBe(true);
    expect(r.code).toBe("PROFILE_OK");
    expect(r.profiles).toEqual([]);
    expect(r.parseErrors).toBe(0);
  });

  it("坏 JSON → PROFILE_INVALID 且不猜测内容", async () => {
    writeRaw("{ not json");
    const r = await loadTaskProfiles(root);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("PROFILE_INVALID");
    expect(r.parseErrors).toBe(1);
    expect(r.profiles).toEqual([]);
  });

  it("顶层不是对象/ profiles 不是数组 → PROFILE_INVALID", async () => {
    writeRaw([]);
    expect((await loadTaskProfiles(root)).code).toBe("PROFILE_INVALID");
    writeRaw({ v: TASK_PROFILES_VERSION, profiles: {} });
    expect((await loadTaskProfiles(root)).code).toBe("PROFILE_INVALID");
  });

  it("坏条目剔除并计入 parseErrors,好条目照常返回", async () => {
    writeRaw({
      v: TASK_PROFILES_VERSION,
      profiles: [coding, { id: "Bad Id", taskClass: "coding" }, { id: "ok2", taskClass: "office" }],
    });
    const r = await loadTaskProfiles(root);
    expect(r.ok).toBe(true);
    expect(r.profiles.map((p) => p.id)).toEqual(["coding-default", "ok2"]);
    expect(r.parseErrors).toBe(1);
    expect(r.issues?.some((i) => i.index === 1)).toBe(true);
  });

  it("版本号不符计入 parseErrors(条目仍可用)", async () => {
    writeRaw({ v: 999, profiles: [coding] });
    const r = await loadTaskProfiles(root);
    expect(r.profiles).toHaveLength(1);
    expect(r.parseErrors).toBe(1);
  });
});

describe("addTaskProfile / saveTaskProfiles:校验与原子写", () => {
  it("add 落盘可读回,并补 updatedAt", async () => {
    const added = await addTaskProfile(root, coding, { now: 1000 });
    expect(added.ok).toBe(true);
    expect(added.profile?.updatedAt).toBe(1000);
    const loaded = await loadTaskProfiles(root);
    expect(loaded.profiles[0]).toEqual({ ...coding, updatedAt: 1000 });
  });

  it("add 非法档案 → PROFILE_INVALID 且不写文件", async () => {
    const r = await addTaskProfile(root, { id: "bad", taskClass: "coding", maxSteps: 0 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("PROFILE_INVALID");
    expect(await loadTaskProfiles(root)).toMatchObject({ profiles: [], parseErrors: 0 });
  });

  it("add 重复 id → PROFILE_CONFLICT(create-only)", async () => {
    await addTaskProfile(root, coding, { now: 1 });
    const again = await addTaskProfile(root, { ...coding, taskClass: "office" }, { now: 2 });
    expect(again.ok).toBe(false);
    expect(again.code).toBe("PROFILE_CONFLICT");
    expect((await loadTaskProfiles(root)).profiles[0]!.taskClass).toBe("coding");
  });

  it("saveTaskProfiles 有一份非法就整体拒绝,原文件不变", async () => {
    await addTaskProfile(root, coding, { now: 1 });
    const before = readFileSync(taskProfilesPath(root), "utf8");
    const r = await saveTaskProfiles(root, [coding, { id: "x", taskClass: "nope" as TaskProfile["taskClass"] }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("PROFILE_INVALID");
    expect(readFileSync(taskProfilesPath(root), "utf8")).toBe(before);
  });

  it("原子写:目录内无 tmp 残留,文件是完整 JSON", async () => {
    await addTaskProfile(root, coding, { now: 1 });
    const dir = join(root, ".genie");
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
    const parsed = JSON.parse(readFileSync(taskProfilesPath(root), "utf8")) as TaskProfilesFileLike;
    expect(parsed.v).toBe(TASK_PROFILES_VERSION);
    expect(parsed.profiles).toHaveLength(1);
  });
});

describe("remove / show / list", () => {
  it("remove 已存在 → 文件里消失", async () => {
    await addTaskProfile(root, coding, { now: 1 });
    const r = await removeTaskProfile(root, "coding-default");
    expect(r.ok).toBe(true);
    expect(r.removed?.id).toBe("coding-default");
    expect(await loadTaskProfiles(root)).toMatchObject({ profiles: [] });
  });

  it("remove 不存在 → PROFILE_NOT_FOUND", async () => {
    const r = await removeTaskProfile(root, "nope");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("PROFILE_NOT_FOUND");
  });

  it("show 存在/不存在", async () => {
    await addTaskProfile(root, coding, { now: 1 });
    expect((await showTaskProfile(root, "coding-default")).profile?.id).toBe("coding-default");
    expect((await showTaskProfile(root, "nope")).code).toBe("PROFILE_NOT_FOUND");
  });

  it("list 计数与路径", async () => {
    await addTaskProfile(root, coding, { now: 1 });
    await addTaskProfile(root, { id: "office-1", taskClass: "office" }, { now: 2 });
    const r = await listTaskProfiles(root);
    expect(r.count).toBe(2);
    expect(r.path).toBe(taskProfilesPath(root));
  });
});

describe("resolveTaskProfileAt:fail-closed", () => {
  it("coding 命中;未知 taskClass 回退 \"*\"", async () => {
    await addTaskProfile(root, coding, { now: 1 });
    await addTaskProfile(root, { id: "any", taskClass: "*" }, { now: 2 });
    const hit = await resolveTaskProfileAt(root, { taskClass: "coding" });
    expect(hit.code).toBe("PROFILE_OK");
    expect(hit.profile?.id).toBe("coding-default");
    const fallback = await resolveTaskProfileAt(root, { taskClass: "qa" });
    expect(fallback.profile?.id).toBe("any");
  });

  it("显式 profileId 不存在 → PROFILE_NOT_FOUND(不回退猜测)", async () => {
    await addTaskProfile(root, coding, { now: 1 });
    const r = await resolveTaskProfileAt(root, { taskClass: "coding", profileId: "ghost" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("PROFILE_NOT_FOUND");
    expect(r.profile).toBeUndefined();
  });

  it("冲突档案:updatedAt 最新胜出并记 reason", async () => {
    await addTaskProfile(root, { id: "c-old", taskClass: "coding" }, { now: 100 });
    await addTaskProfile(root, { id: "c-new", taskClass: "coding" }, { now: 200 });
    const r = await resolveTaskProfileAt(root, { taskClass: "coding" });
    expect(r.code).toBe("PROFILE_CONFLICT");
    expect(r.profile?.id).toBe("c-new");
    expect(r.reason).toContain("c-old");
  });

  it("坏 JSON 文件 → PROFILE_INVALID(fail-closed)", async () => {
    writeRaw("{{{");
    const r = await resolveTaskProfileAt(root, { taskClass: "coding" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("PROFILE_INVALID");
  });

  it("无匹配 → PROFILE_NO_MATCH", async () => {
    await addTaskProfile(root, coding, { now: 1 });
    const r = await resolveTaskProfileAt(root, { taskClass: "office" });
    expect(r.code).toBe("PROFILE_NO_MATCH");
  });
});

describe("装配静态断言(:journal task.profile / effectiveMaxSteps)", () => {
  const wiring = AGENT_WIRING_SRC;

  it("装配侧写 task.profile 留痕(含 applied 与 fail-closed 分支)", () => {
    expect(wiring).toContain('what: "task.profile"');
    expect(wiring).toContain("profileId: profile.id");
    expect(wiring).toContain("effectiveMaxSteps");
    expect(wiring).toContain('code: resolved.code');
  });

  it("loop maxSteps 与执行信封 maxIterations 同源使用 effectiveMaxSteps", () => {
    expect(wiring).toContain("maxSteps: effectiveMaxSteps");
    expect(wiring).toContain("maxIterations: effectiveMaxSteps");
    expect(wiring).not.toContain("maxSteps: agentConfig?.agent?.maxSteps ?? 3000");
    expect(wiring).not.toContain("maxIterations: agentConfig?.agent?.maxSteps ?? 3000");
  });

  it("档案工具面在 governToolIdentity 之后过滤,并留 task.profile.tools 证据", () => {
    const gov = wiring.indexOf("const governedTools = governToolIdentity(mainTools");
    const filter = wiring.indexOf("if (taskProfile?.tools) {");
    expect(gov).toBeGreaterThan(-1);
    expect(filter).toBeGreaterThan(gov);
    expect(wiring).toContain('what: "task.profile.tools"');
  });

  it("显式 profileId 来自 idempotencyKey 前缀 profile:<id>:", () => {
    expect(wiring).toContain("/^profile:([a-z0-9][a-z0-9._-]{0,63}):/");
    expect(wiring).toContain("task.idempotencyKey");
  });
});

describe("applyTaskProfile / report", () => {
  it("经 store 调用纯逻辑:allow 白名单 + deny 优先", async () => {
    const r = await applyTaskProfile(
      { tools: ["read_file", "write_file", "terminal", "browser"], maxSteps: 3000 },
      { id: "p", taskClass: "coding", tools: { allow: ["read_file", "terminal"], deny: ["terminal"] }, maxSteps: 50 },
    );
    expect(r.applied.tools).toEqual(["read_file"]);
    expect(r.applied.maxSteps).toBe(50);
  });

  it("report 计数(byTaskClass/with/parseErrors)", async () => {
    await addTaskProfile(root, coding, { now: 10 });
    await addTaskProfile(root, { id: "office-1", taskClass: "office", maxSteps: 30 }, { now: 20 });
    const rep = await reportTaskProfiles(root);
    expect(rep.total).toBe(2);
    expect(rep.byTaskClass.coding).toBe(1);
    expect(rep.byTaskClass.office).toBe(1);
    expect(rep.byTaskClass.qa).toBe(0);
    expect(rep.with.model).toBe(1);
    expect(rep.with.maxSteps).toBe(2);
    expect(rep.latestUpdatedAt).toBe(20);
    expect(rep.parseErrors).toBe(0);
  });
});
