/**
 * 系统提示「裸块 → 具名节」单一真源(修 f1)。
 * **经验证故障**:system 全文用字符串 `+` 拼(memBlock + goalBlock + planBlock + workspaceBlock +
 * planFileBlock),而给 loop 做节 diff 的 `systemSections` 另手写一份 → 两份清单不同步,
 * 漏了 planBlock/workspaceBlock。
 * 后果不是「少发一点」而是**静默丢规则**:plan 模式与「工作区内」权限模式的约束文本在全文里,
 * 但节 diff 永远看不到它们变化 → `[系统提示更新]` 零追加 → 模型收不到「现在是 plan 模式,
 * 不许改代码」。省 token 绝不能换行为退化。
 * 本文件锁住三件事:
 * ① plan / workspace 必须出现在节清单里(正是漏掉的那两个);
 * ② 空块不进节清单(与旧字符串拼接语义一致);
 * ③ 节清单 join 后逐字节等于旧的字符串拼接顺序。
 */
import { describe, it, expect } from "vitest";
import { namedSystemBlocks } from "../src/agent-wiring.js";

describe("namedSystemBlocks 裸块→节", () => {
  it("plan 与 workspace 都在节清单里(修前漏掉的两个)", () => {
    const secs = namedSystemBlocks({
      memory: "## 记忆\nM",
      goal: "## 目标\nG",
      plan: "## plan 模式\n不许改代码",
      workspace: "## 当前权限模式=工作区内\n只能读写项目内",
      planFile: "## 计划文件\nP",
    });
    const names = secs.map((s) => s.name);
    expect(names).toContain("plan");
    expect(names).toContain("workspace");
    expect(names).toEqual(["memory", "goal", "plan", "workspace", "plan-file"]);
  });

  it("negative 空块不进节清单(与旧字符串拼接语义一致)", () => {
    const secs = namedSystemBlocks({ memory: "", goal: "## 目标\nG", plan: "", workspace: "", planFile: "" });
    expect(secs.map((s) => s.name)).toEqual(["goal"]);
    // 全空 → 空数组
    expect(namedSystemBlocks({})).toEqual([]);
  });

  it("negative 顺序必须与旧拼接一致(join 后逐字节等于旧字符串相加)", () => {
    const b = {
      memory: "MEM",
      goal: "GOAL",
      plan: "PLAN",
      workspace: "WORKSPACE",
      planFile: "PLANFILE",
    };
    const legacy = b.memory + b.goal + b.plan + b.workspace + b.planFile;
    expect(namedSystemBlocks(b).map((s) => s.content).join("")).toBe(legacy);
    // 部分缺席时同样等价(空串相加不影响结果)
    const partial = { memory: "", goal: "GOAL", plan: "PLAN", workspace: "", planFile: "" };
    expect(namedSystemBlocks(partial).map((s) => s.content).join(""))
      .toBe(partial.memory + partial.goal + partial.plan + partial.workspace + partial.planFile);
  });

  it("plan 模式下只出现 plan 一节、workspace 模式只出现 workspace 一节(条件块互斥)", () => {
    const planMode = namedSystemBlocks({ plan: "## plan 模式\n不许改代码", workspace: "" });
    expect(planMode.map((s) => s.name)).toEqual(["plan"]);
    const wsMode = namedSystemBlocks({ plan: "", workspace: "## 工作区内\n只能读写项目内" });
    expect(wsMode.map((s) => s.name)).toEqual(["workspace"]);
  });
});