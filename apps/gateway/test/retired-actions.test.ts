/**
 * 退役表补历史名(设计稿 06-code-sense §12.5 漂移登记闭合)。
 * 背景:journal 经验证存在 action=grep(22 次)/action=files(4 次)调用,但两表
 * (SENSE_ACTIONS/RETIRED_ACTIONS)皆无——旧习惯调用落入「未知 action」通用提示,
 * 而不是定向迁移指引。本批补两条 RETIRED 条目,让旧调用拿到可直接照抄的替代命令。
 */
import { describe, it, expect } from "vitest";
import { codeSenseTool, dispatchSenseArgs, SENSE_ACTIONS } from "../src/sense-tool.js";

const repo = process.cwd(); // 纯 dispatch 断言不需要真实索引;execute 走远端外的快速失败路径

describe("RETIRED_ACTIONS 历史名迁移指引(§12.5)", () => {
  it("action=grep → dispatch 落 retired 回执并指向 action=refs", async () => {
    const d = dispatchSenseArgs({ action: "grep", target: "plan-gate" });
    expect(d.kind).not.toBe("structural"); // 不进结构面
    const t = codeSenseTool(repo);
    const out = await t.execute({ action: "grep", target: "plan-gate" });
    expect(out).toContain("action=grep 已删除");
    expect(out).toContain("action=refs"); // 迁移指引含替代命令
  });

  it("action=files → 迁移指引指向 action=file 与 explore", async () => {
    const t = codeSenseTool(repo);
    const out = await t.execute({ action: "files", target: "src" });
    expect(out).toContain("action=files 已删除");
    expect(out).toContain("action=file");
  });

  it("orphans 在 SENSE_ACTIONS 里且 dispatch 不落 invalid", () => {
    expect(SENSE_ACTIONS).toContain("orphans");
    const d = dispatchSenseArgs({ action: "orphans", target: "packages/code-sense" });
    expect(d.kind).toBe("structural");
    if (d.kind === "structural") expect(d.action).toBe("orphans");
  });

  it("negative:未知 action 仍走通用提示(grep/files 之外的新拼错不受影响)", () => {
    const d = dispatchSenseArgs({ action: "impactt", target: "x" });
 // impactt 不在两表——保持既有行为(miss 自愈/invalid 路径),不因本批改动而变
    expect(d.kind === "invalid" || d.kind === "structural").toBe(true);
  });
});
