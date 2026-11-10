import { describe, it, expect } from "vitest";
import { MemberSchema, ProjectsSchema } from "../src/roster/schema";

describe("roster schema(团队花名册;C10 计划的 search-index 评分件无消费方已裁撤,2026-10-13)", () => {
  it("成员:必填指纹,吊销位默认 false", () => {
    const m = MemberSchema.parse({
      username: "alice", fingerprint: "gh7k-2mpx", registeredAt: "2026-10-10",
    });
    expect(m.role).toBe("member");
    expect(m.revoked).toBe(false);
  });
  it("项目类型枚举只收 personal|team", () => {
    expect(() => ProjectsSchema.parse({ projects: { x: { type: "public" } } })).toThrow();
  });
});
