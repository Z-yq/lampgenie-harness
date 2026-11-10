/** planner 板型提示词(分阶段技能化):
 * 系统提示只留调度器+通用硬规则+板型索引;13 类画法在 board-skills.ts 的 collect/draw/audit,
 * 由 planner 判定 boardType 后经 skill_view(category="board") 按需加载。
 * 防止后续把全部类型规则又塞回 planner 系统提示/board_upsert 描述。 */
import { describe, it, expect } from "vitest";
import { PLANNER_BOARD_SPEC } from "../src/llm-loop-backend.js";
import { boardUpsertTool } from "../src/agent-wiring.js";
import { BOARD_SKILL_TYPES, boardSkillIndex } from "../src/board-skills.js";

describe("planner 板型技能调度", () => {
  it("先判型，再按需加载 collect/draw/audit", () => {
    expect(PLANNER_BOARD_SPEC).toContain("先判型,再按需加载");
    expect(PLANNER_BOARD_SPEC).toContain('skill_view(category="board"');
    expect(PLANNER_BOARD_SPEC).toContain("<boardType>/collect");
    expect(PLANNER_BOARD_SPEC).toContain("collect=查事实");
    expect(PLANNER_BOARD_SPEC).toContain("<boardType>/audit");
    expect(PLANNER_BOARD_SPEC).toContain("未加载对应 skill 就画板=违规");
  });

  it("板型索引覆盖全部类型与三阶段", () => {
    expect(PLANNER_BOARD_SPEC).toContain("板型索引");
    for (const t of BOARD_SKILL_TYPES) expect(PLANNER_BOARD_SPEC, t).toContain(t);
    expect(PLANNER_BOARD_SPEC).toContain("collect(收集必备信息)");
    expect(PLANNER_BOARD_SPEC).toContain("draw(画法与结构)");
    expect(PLANNER_BOARD_SPEC).toContain("audit(交板自检)");
    expect(boardSkillIndex()).toContain("ui-func=UI+功能");
  });

  it("通用硬规则仍在:before/证据入边/数字口径/负面/无孤儿", () => {
    expect(PLANNER_BOARD_SPEC).toContain("通用硬规则(全板型");
    expect(PLANNER_BOARD_SPEC).toContain("modify/delete 必带 before");
    expect(PLANNER_BOARD_SPEC).toContain("必须有证据入边");
    expect(PLANNER_BOARD_SPEC).toContain("数字/时间承诺");
    expect(PLANNER_BOARD_SPEC).toContain("至少 1 条负面断言");
    expect(PLANNER_BOARD_SPEC).toContain("无孤儿节点");
  });

  it("板规范口径:现状逻辑图 + 改动徽标,keep 免 accept", () => {
    expect(PLANNER_BOARD_SPEC).toContain("现在怎么走");
    expect(PLANNER_BOARD_SPEC).toContain("改动徽标");
    expect(PLANNER_BOARD_SPEC).toContain("改动不是独立的节点");
    expect(PLANNER_BOARD_SPEC).toContain("全 keep 板");
    expect(PLANNER_BOARD_SPEC).toContain("keep 节点免 accept");
    expect(PLANNER_BOARD_SPEC).toContain("本轮会动的节点");
    expect(PLANNER_BOARD_SPEC).toContain("仓库里不存在的待办");
 // 「白板看得懂」:板首主题节点(全板型强制)
    expect(PLANNER_BOARD_SPEC).toContain("板首必须有主题节点");
    expect(PLANNER_BOARD_SPEC).toContain("id 用 theme 开头或 group=主题");
    expect(PLANNER_BOARD_SPEC).toContain("本次开发内容改的是其中哪一环");
    // 旧「计划/变更契约图」口径已退出
    expect(PLANNER_BOARD_SPEC).not.toContain("变更契约图");
    expect(PLANNER_BOARD_SPEC).not.toContain("两层表达——现状层");
  });

  it("类型画法已退出系统提示/board_upsert 描述，改由 skill 承载", () => {
    expect(PLANNER_BOARD_SPEC).not.toContain("纯 UI=docKind=page 页面结构板");
    expect(PLANNER_BOARD_SPEC).not.toContain("代码开发=现状层");
    expect(PLANNER_BOARD_SPEC.length).toBeLessThan(6000);
    const tool = boardUpsertTool({} as never, "s", "t", "/tmp");
    const desc = String(tool.description || "");
    expect(desc).toContain('skill_view(category="board"');
    expect(desc).toContain("ui/draw");
    expect(desc).not.toContain("13 类板型画法");
    expect(desc).not.toContain("代码开发=现状层");
    expect(desc.length).toBeLessThan(6000);
  });
});
