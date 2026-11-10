/**
 * n6 技能索引节测试(ZCode core/context/sections/skills.ts):
 * ① 索引行格式含 file 路径(description ≤250 + whenToUse `(当: …)`);
 * ② 超预算降级为 name + file 一行;
 * ③ 空索引不产生空段落(条件输出)。
 */
import { describe, it, expect } from "vitest";
import {
  composeSystemPrompt,
  renderSkillIndex,
  SKILL_INDEX_MAX_CHARS,
  SKILL_INDEX_DESC_CHARS,
  type SkillIndexEntry,
} from "../src/agent/system-composer";

const BASE = "你是 lampgenie-harness 的主 agent。(技能索引测试基线)";

function entry(over: Partial<SkillIndexEntry> = {}): SkillIndexEntry {
  return {
    category: "coding",
    name: "ts-esm-paths",
    description: "TS ESM 相对 import 需带扩展名",
    path: "/repo/.genie/experiences/coding/ts-esm-paths/SKILL.md",
    ...over,
  };
}

describe("renderSkillIndex(n6 行格式)", () => {
  it("索引行含 name/description/whenToUse；可推导路径省略、不可推导的仍输出", () => {
    const text = renderSkillIndex([
      entry(),
      entry({ category: "ops", name: "port-conflict", description: "端口占用先查残留进程", whenToUse: "服务起不来时", path: "/repo/.genie/experiences/ops/port-conflict/SKILL.md" }),
      { category: "builtin", name: "tdd", description: "测试驱动开发" },
    ]);
    expect(text).toContain("# 技能索引");
 // `.genie/experiences/<category>/<name>/SKILL.md` 可由索引行名字推导 → 省略
 // (经验证占索引 47% 字符，而读取通道是 skill_view(category,name)，不需要路径)。
    expect(text).toContain("- ops/port-conflict: 端口占用先查残留进程 (当: 服务起不来时)");
    expect(text).not.toContain("(file: /repo/.genie/experiences/ops/port-conflict/SKILL.md)");
    expect(text).toContain("- coding/ts-esm-paths: TS ESM 相对 import 需带扩展名");
    expect(text).not.toContain("(file: /repo/.genie/experiences/coding/ts-esm-paths/SKILL.md)");
    // 无 path 的条目(内置技能)不出 (file: …),不编假路径
    expect(text).toContain("- builtin/tdd: 测试驱动开发");
    expect(text).not.toContain("builtin/tdd: 测试驱动开发 (file:");
    // 按 qualified name 排序(builtin/coding/ops 字典序)
    expect(text.indexOf("builtin/tdd")).toBeLessThan(text.indexOf("coding/ts-esm-paths"));
  });

  it("不可推导的路径(插件/自定义根)仍原样输出", () => {
    const text = renderSkillIndex([
      entry({ category: "plugin-x", name: "my-skill", description: "外部插件技能", path: "/opt/plugins/x/my-skill/SKILL.md" }),
    ]);
    expect(text).toContain("- plugin-x/my-skill: 外部插件技能 (file: /opt/plugins/x/my-skill/SKILL.md)");
  });

  it("description 超 SKILL_INDEX_DESC_CHARS 字符截断(不切出半条技能名)", () => {
    const long = "长".repeat(400);
    const text = renderSkillIndex([entry({ description: long })]);
    const line = text.split("\n").find((l) => l.startsWith("- coding/ts-esm-paths"))!;
    // 可推导路径已省略 → desc 从冒号后到行尾
    const desc = line.slice("- coding/ts-esm-paths: ".length);
    expect(desc.length).toBe(SKILL_INDEX_DESC_CHARS);
    expect(desc.endsWith("…")).toBe(true);
    expect(line).not.toContain("(file:");
  });

  it("超预算降级为 name + file 一行", () => {
 // fixture 用**各自不同**的 description:同模板条目会被折叠( P2),
    // 折叠后体量很小、根本不会超预算,测不到降级分支。降级分支要覆盖的是「真·大量不同技能」。
    const many = Array.from({ length: 200 }, (_, i) =>
      entry({
        name: `skill-${String(i).padStart(3, "0")}`,
        description: `第${i}个技能:${"描述".repeat(120)}`,
        path: `/repo/.genie/experiences/coding/skill-${i}/SKILL.md`,
      }));
    const full = renderSkillIndex(many, SKILL_INDEX_MAX_CHARS);
    expect(full.length).toBeLessThanOrEqual(SKILL_INDEX_MAX_CHARS); // 降级形态本身不超预算
    expect(full).not.toContain("描述描述");
    expect(full).toContain("- coding/skill-000 (file: /repo/.genie/experiences/coding/skill-0/SKILL.md)");
    // 降级后每行仍可用(名字+路径),无截断产生的半行
    for (const line of full.split("\n").slice(1)) {
      expect(line).toMatch(/^- [a-z]+\/[a-z0-9-]+ \(file: .+\)$/);
    }

    // 预算足够时给完整描述形态
    const small = renderSkillIndex(many.slice(0, 2), 20_000);
    expect(small).toContain("描述描述");
  });

  it("折叠让「同模板大批量」不再触发降级(折叠本身就是省预算的手段)", () => {
    // 200 条同模板:不折叠时必然超预算走降级;折叠后只有 1 行 → 完整形态即可容纳
    const dup = Array.from({ length: 200 }, (_, i) =>
      entry({ category: "incidents", name: `task-${i}`, description: "同一句模板描述".repeat(20), path: `/p/task-${i}/SKILL.md` }));
    const out = renderSkillIndex(dup, SKILL_INDEX_MAX_CHARS);
    expect(out).toContain("200 条同类");
    expect(out.length).toBeLessThan(500); // 折叠后极短,远未到 20000 预算
    // 且没有退化成「逐条 name+file」形态
    expect(out).not.toContain("- incidents/task-0 ");
  });

  it("空索引返回空串(不产生空段落)", () => {
    expect(renderSkillIndex([])).toBe("");
    const r = composeSystemPrompt({ base: BASE, skillIndex: [] });
    expect(r.sections.map((s) => s.name)).toEqual(["identity"]);
    expect(r.text).not.toContain("# 技能索引");
    // 空字符串入参同样不渲染
    const r2 = composeSystemPrompt({ base: BASE, skillIndex: "   " });
    expect(r2.text).not.toContain("# 技能索引");
  });
});

describe("同模板条目折叠(2026-10-29 token 轮 P2)", () => {
 /** 造 N 条同描述前缀的条目(模拟 incidents/task-* 的经验证形态)。 */
  const dupes = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => entry({
      category: "incidents", name: `task-${i}`, description: `${prefix}……后面是同样的模板正文`, path: `/p/incidents/task-${i}/SKILL.md`,
    }));

  it("≥5 条同模板 → 折叠成 1 行带计数,原条目不再逐条占行", () => {
    const text = renderSkillIndex(dupes(15, "失败任务候选经验:做个小功能"));
    const folded = text.split("\n").filter((l) => l.includes("条同类"));
    expect(folded).toHaveLength(1);
    expect(folded[0]).toContain("incidents/*(15 条同类");
    expect(folded[0]).toContain("skill_view(category=");
    // 逐条行不该再出现(15 条名字全部消失)
    for (let i = 0; i < 15; i++) expect(text).not.toContain(`incidents/task-${i}:`);
  });

  it("negative 少于 5 条不折叠(不误压掉真有差异的少量条目)", () => {
    const text = renderSkillIndex(dupes(4, "失败任务候选经验:做个小功能"));
    expect(text).not.toContain("条同类");
    expect(text).toContain("incidents/task-0:");
  });

  it("negative 描述不同的条目即使同 category 也不折叠(按内容判定,不按名字正则)", () => {
    const mixed = [
      entry({ category: "incidents", name: "task-a", description: "甲种问题的失败经验" }),
      entry({ category: "incidents", name: "task-b", description: "乙种完全不同的失败经验" }),
      entry({ category: "incidents", name: "task-c", description: "丙种又是另一个失败经验" }),
      entry({ category: "incidents", name: "task-d", description: "丁种另一个失败经验描述" }),
      entry({ category: "incidents", name: "task-e", description: "戊种另一个失败经验描述" }),
    ];
    const text = renderSkillIndex(mixed);
    expect(text).not.toContain("条同类");
  });

  it("折叠后索引显著变短(15 条同模板:逐条 ≈ 每条 100+ 字符)", () => {
    const many = dupes(15, "失败任务候选经验:做个小功能");
    const text = renderSkillIndex(many);
    // 15 条逐条渲染 ≥ 15 × 60 字符;折叠后应远小于此
    expect(text.length).toBeLessThan(15 * 60);
  });

  it("collapseDuplicateSkills 纯函数:返回折叠行 + 未被折叠的剩余条目", async () => {
    const { collapseDuplicateSkills, SKILL_COLLAPSE_MIN } = await import("../src/agent/system-composer");
    expect(SKILL_COLLAPSE_MIN).toBe(5);
    const entries = [...dupes(6, "同一模板"), entry({ category: "coding", name: "solo", description: "唯一的经验" })];
    const { collapsed, rest } = collapseDuplicateSkills(entries);
    expect(collapsed).toHaveLength(1);
    expect(rest.map((e) => e.name)).toEqual(["solo"]);
  });
});

describe("composeSystemPrompt 技能索引节(n6)", () => {
  it("条目数组入参会渲染成独立 skill-index 节,位于 identity 之后", () => {
    const r = composeSystemPrompt({ base: BASE, skillIndex: [entry()] });
    expect(r.sections.map((s) => s.name)).toEqual(["identity", "skill-index"]);
    expect(r.sections[1]!.content).toContain("- coding/ts-esm-paths:");
    expect(r.text.indexOf(BASE)).toBeLessThan(r.text.indexOf("# 技能索引"));
  });

  it("预渲染字符串入参原样进节(装配方用 renderSkillIndex 控制预算)", () => {
    const pre = renderSkillIndex([entry()], 500);
    const r = composeSystemPrompt({ base: BASE, skillIndex: pre });
    expect(r.sections.map((s) => s.name)).toEqual(["identity", "skill-index"]);
    expect(r.sections[1]!.content).toBe(pre.trim());
  });

  it("skillIndexBudget 覆盖缺省 20000", () => {
    const many = Array.from({ length: 20 }, (_, i) => entry({ name: `s${i}`, description: "描述".repeat(40), path: `/p/s${i}/SKILL.md` }));
    const wide = composeSystemPrompt({ base: BASE, skillIndex: many });
    const narrow = composeSystemPrompt({ base: BASE, skillIndex: many, skillIndexBudget: 200 });
    expect(wide.sections[1]!.content).toContain("描述描述");
    expect(narrow.sections[1]!.content).not.toContain("描述描述");
    expect(narrow.sections[1]!.content).toContain("(file: /p/s0/SKILL.md)");
  });
});

describe("技能索引体量守卫（防回涨）", () => {
  it("56 条真实规模条目的渲染体量不超上限（生产实测基线）", () => {
 // 生产测量：56 条真实索引占 9,835 字符；本轮 desc cap 100→80 后经验证 ≈6,362。
    // 掉回 9k 说明 cap 被改回或 (file: path) 重新出现。
    // **fixture 描述必须各不相同**：同模板描述会被 collapseDuplicateSkills 折成一行，
 // 那样渲染出 210 字符，断言等于没测（ 首次写就踩了这个坑）。
    const many = Array.from({ length: 56 }, (_, i) => {
      const n = `skill-${String(i).padStart(2, "0")}`;
      return entry({
        name: n,
        description: `第${i}条技能:${"细节说明".repeat(16)}`, // 各自不同 + 约 130 字（生产均长 133）
        path: `/repo/.genie/experiences/coding/${n}/SKILL.md`, // 必须用同名（补零），否则推导不匹配会被当成不可推导
      });
    });
    const text = renderSkillIndex(many, SKILL_INDEX_MAX_CHARS);
    console.log(`[skill-index-size] ${text.length} chars / ${many.length} 条`);
    // 未折叠证明：行数应接近条目数（每行一条）
    const lines = text.split("\n").filter((l) => l.startsWith("- "));
    expect(lines.length, "56 条不该被折叠").toBeGreaterThanOrEqual(50);
    expect(text.length, "56 条索引体量（cap=80 实测 6,362）").toBeLessThanOrEqual(6600);
    // 可推导路径已省略
    expect(text).not.toContain("(file: /repo/.genie/experiences/");
  });

  it("描述 cap = 80（改回 100 会让每步多付约 1,447 tok）", () => {
    expect(SKILL_INDEX_DESC_CHARS).toBe(80);
  });
});
