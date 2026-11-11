import { describe, expect, it } from "vitest";
import {
  PROFILE_CODES,
  applyProfile,
  resolveTaskProfile,
  validateProfile,
  type TaskProfile,
} from "../src/agent/task-profile";

const coding: TaskProfile = {
  id: "coding-default",
  taskClass: "coding",
  maxSteps: 120,
  tools: { allow: ["read_file", "write_file", "edit_file"], deny: ["terminal"] },
  skills: { allow: ["builtin/codebase-inspection"] },
  model: { model: "gpt-5", providerId: "azure", effort: "high" },
  presetRevision: "preset-7",
};

describe("validateProfile:必填与取值域", () => {
  it("最小合法档案零 issues", () => {
    expect(validateProfile({ id: "a1", taskClass: "coding" })).toEqual([]);
  });

  it("完整合法档案零 issues", () => {
    expect(validateProfile(coding)).toEqual([]);
  });

  it("非对象整体判非法", () => {
    expect(validateProfile(null)).toHaveLength(1);
    expect(validateProfile("x")[0]!.code).toBe(PROFILE_CODES.INVALID);
  });

  it("id 必须是 slug(大写/空格/空串都拦)", () => {
    for (const id of ["", "Bad", "a b", "-x"]) {
      const issues = validateProfile({ id, taskClass: "coding" });
      expect(issues.some((i) => i.field === "id")).toBe(true);
    }
  });

  it("taskClass 只接受 coding/office/qa/*", () => {
    expect(validateProfile({ id: "a", taskClass: "research" }).some((i) => i.field === "taskClass")).toBe(true);
    for (const c of ["coding", "office", "qa", "*"]) expect(validateProfile({ id: "a", taskClass: c })).toEqual([]);
  });

  it("maxSteps 边界 1..3000 合法,0/3001/小数/非数非法", () => {
    expect(validateProfile({ id: "a", taskClass: "coding", maxSteps: 1 })).toEqual([]);
    expect(validateProfile({ id: "a", taskClass: "coding", maxSteps: 3000 })).toEqual([]);
    for (const n of [0, 3001, 1.5, "10"]) {
      expect(validateProfile({ id: "a", taskClass: "coding", maxSteps: n }).some((i) => i.field === "maxSteps")).toBe(true);
    }
  });

  it("tools allow/deny 重叠判非法", () => {
    const issues = validateProfile({ id: "a", taskClass: "coding", tools: { allow: ["read_file"], deny: ["read_file"] } });
    expect(issues.some((i) => i.field === "tools")).toBe(true);
  });

  it("tools 非对象/含非字符串项判非法", () => {
    expect(validateProfile({ id: "a", taskClass: "coding", tools: [] as unknown as object }).length).toBeGreaterThan(0);
    expect(validateProfile({ id: "a", taskClass: "coding", tools: { allow: [1] as unknown as string[] } }).length).toBeGreaterThan(0);
  });

  it("model.model 非空必填;providerId/effort 类型受限", () => {
    expect(validateProfile({ id: "a", taskClass: "coding", model: { model: "" } }).some((i) => i.field === "model.model")).toBe(true);
    expect(validateProfile({ id: "a", taskClass: "coding", model: { model: "m", providerId: 1 as unknown as string } }).length).toBeGreaterThan(0);
    expect(validateProfile({ id: "a", taskClass: "coding", model: { model: "m", effort: 2 as unknown as string } }).length).toBeGreaterThan(0);
  });

  it("skills.allow 重复项判非法", () => {
    const issues = validateProfile({ id: "a", taskClass: "coding", skills: { allow: ["x/y", "x/y"] } });
    expect(issues.some((i) => i.field === "skills.allow")).toBe(true);
  });

  it("字符串字段类型错判非法(presetRevision/updatedAt)", () => {
    expect(validateProfile({ id: "a", taskClass: "coding", presetRevision: 7 as unknown as string }).length).toBeGreaterThan(0);
    expect(validateProfile({ id: "a", taskClass: "coding", updatedAt: Number.NaN }).length).toBeGreaterThan(0);
  });
});

describe("resolveTaskProfile:优先级与失败码", () => {
  const office: TaskProfile = { id: "office-default", taskClass: "office" };
  const wildcard: TaskProfile = { id: "any-default", taskClass: "*" };

  it("taskClass 精确匹配 → OK", () => {
    const r = resolveTaskProfile([coding, office, wildcard], { taskClass: "coding" });
    expect(r.ok).toBe(true);
    expect(r.code).toBe(PROFILE_CODES.OK);
    expect(r.profile?.id).toBe("coding-default");
    expect(r.profile?.id).not.toBe(wildcard.id);
  });

  it("无精确匹配时回退 \"*\" → OK", () => {
    const r = resolveTaskProfile([coding, wildcard], { taskClass: "qa" });
    expect(r.code).toBe(PROFILE_CODES.OK);
    expect(r.profile?.id).toBe("any-default");
  });

  it("既无精确也无 \"*\" → NO_MATCH", () => {
    const r = resolveTaskProfile([coding], { taskClass: "qa" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(PROFILE_CODES.NO_MATCH);
    expect(r.profile).toBeUndefined();
  });

  it("空列表 → NO_MATCH(不 throw)", () => {
    expect(resolveTaskProfile([], { taskClass: "coding" }).code).toBe(PROFILE_CODES.NO_MATCH);
  });

  it("显式 profileId 优先于 taskClass", () => {
    const r = resolveTaskProfile([coding, office], { taskClass: "coding", profileId: "office-default" });
    expect(r.code).toBe(PROFILE_CODES.OK);
    expect(r.profile?.id).toBe("office-default");
  });

  it("显式 profileId 不存在 → NOT_FOUND(fail-closed,不回退猜测)", () => {
    const r = resolveTaskProfile([coding, wildcard], { taskClass: "coding", profileId: "nope" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(PROFILE_CODES.NOT_FOUND);
  });

  it("同 taskClass 多份 → CONFLICT,updatedAt 最新胜出并带 reason", () => {
    const oldOne: TaskProfile = { id: "coding-old", taskClass: "coding", updatedAt: 100 };
    const newOne: TaskProfile = { id: "coding-new", taskClass: "coding", updatedAt: 200 };
    const r = resolveTaskProfile([oldOne, newOne], { taskClass: "coding" });
    expect(r.ok).toBe(true);
    expect(r.code).toBe(PROFILE_CODES.CONFLICT);
    expect(r.profile?.id).toBe("coding-new");
    expect(r.reason).toContain("coding-old");
    expect(r.reason).toContain("coding-new");
  });

  it("updatedAt 相同取数组中靠后者(确定性)", () => {
    const a: TaskProfile = { id: "a-first", taskClass: "coding", updatedAt: 5 };
    const b: TaskProfile = { id: "b-second", taskClass: "coding", updatedAt: 5 };
    expect(resolveTaskProfile([a, b], { taskClass: "coding" }).profile?.id).toBe("b-second");
    expect(resolveTaskProfile([b, a], { taskClass: "coding" }).profile?.id).toBe("a-first");
  });

  it("更新的一份非法 → INVALID(fail-closed,不静默用旧的)", () => {
    const bad: TaskProfile = { id: "coding-bad", taskClass: "coding", maxSteps: 9999, updatedAt: 300 };
    const good: TaskProfile = { id: "coding-good", taskClass: "coding", updatedAt: 100 };
    const r = resolveTaskProfile([good, bad], { taskClass: "coding" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(PROFILE_CODES.INVALID);
    expect(r.issues?.length).toBeGreaterThan(0);
  });

  it("显式命中非法档案 → INVALID", () => {
    const r = resolveTaskProfile([{ id: "bad", taskClass: "coding", model: { model: "" } }], { taskClass: "coding", profileId: "bad" });
    expect(r.code).toBe(PROFILE_CODES.INVALID);
  });
});

describe("applyProfile:工具/步数/技能/模型", () => {
  const base = {
    tools: ["read_file", "write_file", "edit_file", "terminal", "browser"],
    maxSteps: 3000,
    skills: ["builtin/codebase-inspection", "builtin/tdd", "coding/board-x"],
    model: { model: "base-model" },
  };

  it("allow 非空=白名单,保持 base 原顺序", () => {
    const r = applyProfile(base, { id: "p", taskClass: "coding", tools: { allow: ["terminal", "read_file"] } });
    expect(r.applied.tools).toEqual(["read_file", "terminal"]);
  });

  it("deny 优先于 allow(防御未校验重叠)", () => {
    const r = applyProfile(base, { id: "p", taskClass: "coding", tools: { allow: ["read_file", "terminal"], deny: ["terminal"] } });
    expect(r.applied.tools).toEqual(["read_file"]);
    expect(r.applied.toolsAllow).toEqual(["read_file", "terminal"]);
    expect(r.applied.toolsDeny).toEqual(["terminal"]);
  });

  it("只有 deny 时其余全保留", () => {
    const r = applyProfile(base, { id: "p", taskClass: "coding", tools: { deny: ["browser"] } });
    expect(r.applied.tools).toEqual(["read_file", "write_file", "edit_file", "terminal"]);
  });

  it("allow 空数组不等于白名单(不过滤)", () => {
    const r = applyProfile(base, { id: "p", taskClass: "coding", tools: { allow: [] } });
    expect(r.applied.tools).toEqual(base.tools);
  });

  it("allow 点名 base 没有的工具 → ignored,不新增", () => {
    const r = applyProfile(base, { id: "p", taskClass: "coding", tools: { allow: ["spawn_subagent"] } });
    expect(r.applied.tools).toEqual([]);
    expect(r.ignored).toContain("tools.allow:spawn_subagent");
  });

  it("base 无 tools 时不臆造,记 ignored", () => {
    const r = applyProfile({ maxSteps: 10 }, { id: "p", taskClass: "coding", tools: { deny: ["x"] } });
    expect(r.applied.tools).toBeUndefined();
    expect(r.ignored).toContain("tools:base-missing");
  });

  it("maxSteps 覆盖 base", () => {
    const r = applyProfile(base, { id: "p", taskClass: "coding", maxSteps: 80 });
    expect(r.applied.maxSteps).toBe(80);
    expect(r.base.maxSteps).toBe(3000);
  });

  it("非法 maxSteps 不生效(防御未校验对象)", () => {
    const r = applyProfile(base, { id: "p", taskClass: "coding", maxSteps: 0 });
    expect(r.applied.maxSteps).toBeUndefined();
  });

  it("skills allow 非空 → 过滤 base", () => {
    const r = applyProfile(base, { id: "p", taskClass: "coding", skills: { allow: ["builtin/tdd"] } });
    expect(r.applied.skills).toEqual(["builtin/tdd"]);
  });

  it("skills base 缺失 → ignored", () => {
    const r = applyProfile({ tools: ["x"] }, { id: "p", taskClass: "coding", skills: { allow: ["a/b"] } });
    expect(r.applied.skills).toBeUndefined();
    expect(r.ignored).toContain("skills:base-missing");
  });

  it("skills 点名 base 没有的项 → ignored", () => {
    const r = applyProfile(base, { id: "p", taskClass: "coding", skills: { allow: ["nope/nope"] } });
    expect(r.applied.skills).toEqual([]);
    expect(r.ignored).toContain("skills.allow:nope/nope");
  });

  it("model 覆盖 base,且 applied 是拷贝", () => {
    const profile: TaskProfile = { id: "p", taskClass: "coding", model: { model: "gpt-5", providerId: "p1", effort: "high" } };
    const r = applyProfile(base, profile);
    expect(r.applied.model).toEqual({ model: "gpt-5", providerId: "p1", effort: "high" });
    expect(r.base.model).toEqual({ model: "base-model" });
    expect(r.applied.model).not.toBe(profile.model);
  });

  it("presetRevision 只记录", () => {
    const r = applyProfile(base, { id: "p", taskClass: "coding", presetRevision: "rev-3" });
    expect(r.applied.presetRevision).toBe("rev-3");
  });

  it("不可变:不修改入参数组/对象", () => {
    const tools = [...base.tools];
    const skills = [...base.skills];
    const model = { model: "base-model" };
    applyProfile({ tools, maxSteps: 5, skills, model }, coding);
    expect(tools).toEqual(base.tools);
    expect(skills).toEqual(base.skills);
    expect(model).toEqual({ model: "base-model" });
  });

  it("确定性:同一入参两次结果逐字相同", () => {
    const a = applyProfile(base, coding);
    const b = applyProfile(base, coding);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("没有任何面时不改 base,applied 为空对象", () => {
    const r = applyProfile(base, { id: "p", taskClass: "coding" });
    expect(r.applied).toEqual({});
    expect(r.ignored).toEqual([]);
    expect(r.base.tools).toEqual(base.tools);
  });

  it("PROFILE_CODES 五码齐全", () => {
    expect(Object.values(PROFILE_CODES).sort()).toEqual(
      ["PROFILE_CONFLICT", "PROFILE_INVALID", "PROFILE_NO_MATCH", "PROFILE_NOT_FOUND", "PROFILE_OK"].sort(),
    );
  });
});
