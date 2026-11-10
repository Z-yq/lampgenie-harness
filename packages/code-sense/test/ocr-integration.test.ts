import { describe, it, expect } from "vitest";
import { parseHunks, resolveByAnchor, locateFinding } from "../src/review/resolver";
import { filterFindings, isProtected } from "../src/review/filter";
import { loadRules } from "../src/review/rules";
import { multiroundReview } from "../src/review/rounds";
import type { Finding } from "../src/review/index";

const DIFF = [
  "diff --git a/x.ts b/x.ts",
  "@@ -1,3 +1,5 @@",
  " export const a = 1;",
  "+export const b = compute(a);",
  "+",
  "+export const c = 3;",
  " export const d = 4;",
].join("\n");

describe("D1 定位三级降级", () => {
  it("锚点精确匹配 hunk 行号", () => {
    const hunks = parseHunks(DIFF, "x.ts");
    expect(hunks[0]!.newStart).toBe(1);
    const r = resolveByAnchor(hunks, "export const c = 3;");
    expect(r?.line).toBe(4); // new 侧第 4 行(context 行计入)
  });
  it("多行锚点连续匹配", () => {
    const r = resolveByAnchor(parseHunks(DIFF, "x.ts"), "export const b = compute(a);\n\nexport const c = 3;");
    expect(r?.line).toBe(2);
  });
  it("三级降级:锚点在别的文件→refile;都不中→fallback/unresolved", () => {
    // refile:锚点实际在 y.ts
    const diffs = [
      { path: "x.ts", diffText: DIFF },
      { path: "y.ts", diffText: DIFF.replace(/x\.ts/g, "y.ts") },
    ];
    const loc = locateFinding({ file: "x.ts", anchorText: "export const c = 3;", fallbackLine: 99 }, [
      { path: "x.ts", diffText: "@@ -1 +1 @@\n+only" },
      ...diffs.slice(1),
    ]);
    expect(loc.resolution).toBe("refile");
    expect(loc.file).toBe("y.ts");
    // fallback:行号在 diff 范围内
    const fb = locateFinding({ file: "x.ts", anchorText: "根本不存在", fallbackLine: 2 }, [{ path: "x.ts", diffText: DIFF }]);
    expect(fb.resolution).toBe("fallback");
    expect(fb.line).toBe(2);
    // unresolved
    const un = locateFinding({ file: "x.ts", anchorText: "不存在", fallbackLine: 500 }, [{ path: "x.ts", diffText: DIFF }]);
    expect(un.resolution).toBe("unresolved");
  });
});

describe("D2 filter 防幻觉", () => {
  const f1: Finding = { file: "x.ts", line: 1, severity: "warning", title: "竞态风险", detail: "并发场景未加锁" };
  const f2: Finding = { file: "x.ts", line: 1, severity: "nit", title: "命名风格", detail: "变量名不符驼峰" };
  it("保护主题(竞态)确定性保留,不进 LLM 判删", () => {
    expect(isProtected(f1)).toBe(true);
    expect(isProtected(f2)).toBe(false);
  });
  it("LLM 判删非保护项;解析失败宁保不删", async () => {
    const llm = { async chat() { return { content: JSON.stringify({ analysis: "f2 可删", remove_indices: [1], keep_indices: [0] }) }; } };
    const r = await filterFindings([f1, f2], DIFF, undefined, llm);
    expect(r.kept.map((x) => x.title)).toContain("竞态风险");
    expect(r.removed.map((x) => x.title)).toContain("命名风格");
    const bad = { async chat() { return { content: "不是json" }; } };
    const r2 = await filterFindings([f2], DIFF, undefined, bad);
    expect(r2.kept).toHaveLength(1); // 宁保不删
  });
});

describe("D3 规则引擎", () => {
  it("四层叠加+按扩展名注入", () => {
    const { rulesFor, layers } = loadRules(process.cwd(), [
      { pattern: "**/*.spec.ts", checklist: "## 项目自定义:测试文件规则" },
    ]);
    expect(layers[0]!.name).toBe("custom");
    expect(rulesFor("a.spec.ts")).toContain("项目自定义");
    expect(rulesFor("a.ts")).toContain("TypeScript Checklist");
    expect(rulesFor("a.py")).toContain("Python Checklist");
    expect(rulesFor("a.xyz")).toContain("通用 Checklist"); // default 兜底
  });
});

describe("D4 多轮+grace", () => {
  it("轮间防重+零新增早停+grace round", async () => {
    let round = 0;
    const llm = {
      async chat(prompt: string) {
        if (prompt.includes("第 1 轮")) {
          return { content: JSON.stringify({ findings: [
            { file: "x.ts", line: 2, severity: "warning", title: "T1", detail: "d" },
            { file: "x.ts", line: 3, severity: "nit", title: "T2", detail: "d" },
          ], summary: "" }) };
        }
        if (prompt.includes("第 2 轮")) {
          // 重复 T1 + 一个新的
          return { content: JSON.stringify({ findings: [
            { file: "x.ts", line: 2, severity: "warning", title: "T1", detail: "d 重复" },
            { file: "x.ts", line: 9, severity: "warning", title: "T3", detail: "d" },
          ], summary: "" }) };
        }
        // grace
        round++;
        return { content: JSON.stringify({ findings: [
          { file: "x.ts", line: 10, severity: "warning", title: "G1", detail: "grace 补充" },
        ], summary: "" }) };
      },
    };
    const r = await multiroundReview({
      files: [{ path: "x.ts", diffText: DIFF, status: "modified" }],
      llm, diffContext: DIFF,
    });
    const titles = r.confirmed.map((f) => f.title);
    expect(titles).toContain("T1");
    expect(titles).toContain("T2");
    expect(titles).toContain("T3");
    expect(titles).toContain("G1"); // grace round 补充
    expect(titles.filter((t) => t === "T1")).toHaveLength(1); // 防重
    // 定位已附(resolution 字段)
    expect(r.located.every((f) => "resolution" in f)).toBe(true);
    expect(r.graceRoundRan).toBe(true);
  });
  it("零新增早停", async () => {
    const llm = { async chat() { return { content: '{"findings":[],"summary":""}' }; } };
    const r = await multiroundReview({ files: [{ path: "x.ts", diffText: DIFF, status: "m" }], llm, diffContext: DIFF });
    expect(r.rounds).toHaveLength(1);
    expect(r.rounds[0]!.earlyStopped).toBe(true);
  });
});
