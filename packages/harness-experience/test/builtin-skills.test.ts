import { describe, it, expect } from "vitest";
import { BUILTIN_SKILLS, mergeSkillIndex, builtinSkillBody } from "../src/builtin-skills.js";

describe("builtin-skills", () => {
  it("12 个内置技能(7 通用 + 4 办公产出 + 1 演示生产环境),每条有出处注记", () => {
    expect(BUILTIN_SKILLS.length).toBe(12);
    expect(BUILTIN_SKILLS.every((s) => s.body.includes("出处:"))).toBe(true);
  });
  it("ppt-master 演示生产环境技能:判型/两道门/版式容量表/能力边界/反模式齐备,且不照搬上游脚本", () => {
    const b = builtinSkillBody("ppt-master")!;
    expect(b).toBeTruthy();
    // 判型按产物生命周期(迁移自上游 routing.md:22 的判据),不按话题
    expect(b).toContain("产物生命周期 + 变更模型");
    // 两道人工门
    expect(b).toContain("门一");
    expect(b).toContain("门二");
    // 版式容量取自本仓 validateDeck 真值:对比栏 ≤3 栏/≤4 条、表格 2~5 行、流程图节点 ≤16 字
    expect(b).toContain("≤3 栏");
    expect(b).toContain("2~5 行");
    expect(b).toContain("≤16 字");
    // 能力边界必须如实:不能原生编辑既有 pptx、不承诺动画/母版
    expect(b).toContain("不能原生编辑");
    expect(b).toContain("做不到");
    // 不携带上游资产:正文不出现其 Python 脚本名与素材库体量
    expect(b).not.toContain("svg_to_pptx.py");
    expect(b).not.toContain("12027");
  });
  it("办公技能族:五条齐全,三痛点各有硬规则", () => {
    const office = BUILTIN_SKILLS.filter((s) => s.name.startsWith("office-"));
    expect(office.map((s) => s.name).sort()).toEqual([
      "office-docx",
      "office-pptx",
      "office-report",
      "office-writing",
      "office-xlsx",
    ]);
    // 痛点①只画轮廓 / ②agent 腔 / ③通篇表格不画图 都必须在内核里有硬线
    const core = builtinSkillBody("office-writing")!;
    expect(core).toContain("禁提纲交付");
    expect(core).toContain("禁的句式");
    expect(core).toContain("mermaid");
    expect(core).toContain("so-what");
 // 动笔前先想清「面向谁报告/主题是什么/重点是什么/论据与分析从哪来」
    expect(core).toContain("开工四问");
    expect(core).toContain("面向谁报告");
    expect(core).toContain("汇报主题是什么");
    expect(core).toContain("论据与分析");
    // 论点四段 + 反证:缺任何一段不算论点
    expect(core).toContain("主张 + 论据 + 分析 + 结论");
    expect(core).toContain("不许复述论据");
    expect(core).toContain("反证");
    // 每条格式技能都必须指回内核,避免规则漂移
    for (const s of office.filter((x) => x.name !== "office-writing")) {
      expect(s.body).toContain("office-writing");
    }
  });
  it("mergeSkillIndex:用户同名覆盖内置;不同名并存", () => {
    const user = [{ category: "coding", name: "tdd", description: "用户版 tdd" }];
    const merged = mergeSkillIndex(user);
    expect(merged.filter((x) => x.name === "tdd")).toEqual([user[0]!]);
    expect(merged.some((x) => x.category === "builtin" && x.name === "simplify-code")).toBe(true);
  });
  it("builtinSkillBody 按名取全文", () => {
    expect(builtinSkillBody("tdd")!).toContain("1. 红");
    expect(builtinSkillBody("nope")).toBeNull();
  });
});
