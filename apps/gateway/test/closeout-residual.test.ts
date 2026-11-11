import { describe, it, expect } from "vitest";
import {
  RESIDUAL_CODES,
  HIT_TEXT_MAX,
  FINDINGS_TEXT_MAX,
  RESIDUAL_TEXT_MAX,
  residualFindings,
  residualVerdict,
  formatResidualFindings,
  type ResidualHitInput,
  type ResidualManifestEntry,
} from "../src/closeout-residual.js";

const hit = (over: Partial<ResidualHitInput> = {}): ResidualHitInput => ({
  file: "src/demo.ts",
  line: 10,
  text: "demoFlag",
  ...over,
});

const entry = (over: Partial<ResidualManifestEntry> = {}): ResidualManifestEntry => ({
  id: "e1",
  action: "replace",
  target: "demoFlag2",
  status: "done",
  ...over,
});

describe("closeout-residual 纯逻辑", () => {
  it("RESIDUAL_CODES 四码固定且顺序稳定", () => {
    expect([...RESIDUAL_CODES]).toEqual(["OK", "RESIDUAL_HITS", "UNRESOLVED_ENTRY", "SCAN_UNAVAILABLE"]);
  });

  it("A 无残留 → OK(命中与清单都干净)", () => {
    const r = residualFindings({ concept: "demoFlag", manifest: [entry()], hits: [] });
    expect(r.code).toBe("OK");
    expect(r.findings).toEqual([]);
    expect(r.counts).toEqual({ hits: 0, unresolved: 0, skipped: 1 });
  });

  it("B 命中未解释 → RESIDUAL_HITS,带 file/line/text", () => {
    const r = residualFindings({ concept: "demoFlag", manifest: [], hits: [hit()] });
    expect(r.code).toBe("RESIDUAL_HITS");
    expect(r.counts.hits).toBe(1);
    expect(r.findings[0]).toMatchObject({ kind: "hit", file: "src/demo.ts", line: 10, text: "demoFlag" });
    expect(r.findings[0]!.reason).toContain("demoFlag");
  });

  it("C allowed=true 命中跳过", () => {
    const r = residualFindings({ concept: "demoFlag", manifest: [], hits: [hit({ allowed: true })] });
    expect(r.code).toBe("OK");
    expect(r.counts).toEqual({ hits: 0, unresolved: 0, skipped: 1 });
  });

  it("C explained 非空命中跳过;纯空白 explained 不算解释", () => {
    const explained = residualFindings({ concept: "demoFlag", manifest: [], hits: [hit({ explained: "兼容旧配置,保留" })] });
    expect(explained.code).toBe("OK");
    const blank = residualFindings({ concept: "demoFlag", manifest: [], hits: [hit({ explained: "   " })] });
    expect(blank.code).toBe("RESIDUAL_HITS");
  });

  it("命中 text 截断到 160 字", () => {
    const r = residualFindings({ concept: "demoFlag", manifest: [], hits: [hit({ text: "x".repeat(400) })] });
    expect(r.findings[0]!.text!.length).toBe(HIT_TEXT_MAX);
  });

  it("D 清单 target 为空 → UNRESOLVED_ENTRY", () => {
    const r = residualFindings({ concept: "demoFlag", manifest: [entry({ target: "" })], hits: [] });
    expect(r.code).toBe("UNRESOLVED_ENTRY");
    expect(r.findings[0]).toMatchObject({ kind: "unresolved", entryId: "e1" });
    expect(r.findings[0]!.reason).toContain("target 为空");
  });

  it("D target 含「待」/TBD/问号都算占位", () => {
    for (const target of ["待定", "TBD", "新名字?", "新名字？"]) {
      const r = residualFindings({ concept: "demoFlag", manifest: [entry({ target })], hits: [] });
      expect(r.code, target).toBe("UNRESOLVED_ENTRY");
    }
  });

  it("D target 合法但 status 不在收口集合 → UNRESOLVED_ENTRY", () => {
    const r = residualFindings({ concept: "demoFlag", manifest: [entry({ status: "todo" })], hits: [] });
    expect(r.code).toBe("UNRESOLVED_ENTRY");
    expect(r.findings[0]!.reason).toContain("status 未收口");
  });

  it("status 缺席也算未定", () => {
    const e = entry();
    delete (e as { status?: string }).status;
    const r = residualFindings({ concept: "demoFlag", manifest: [e], hits: [] });
    expect(r.code).toBe("UNRESOLVED_ENTRY");
    expect(r.findings[0]!.reason).toContain("status 未定");
  });

  it("五种收口 status(migrated/removed/kept/accepted)全部放行", () => {
    for (const status of ["done", "migrated", "removed", "kept", "accepted", "DONE"]) {
      const r = residualFindings({ concept: "demoFlag", manifest: [entry({ status })], hits: [] });
      expect(r.code, status).toBe("OK");
    }
  });

  it("action 非 replace/remove/rename 的条目不查去向", () => {
    const r = residualFindings({
      concept: "demoFlag",
      manifest: [{ id: "k1", action: "keep", target: "", status: "" }],
      hits: [],
    });
    expect(r.code).toBe("OK");
    expect(r.counts.skipped).toBe(1);
  });

  it("命中与清单同时残留 → code 优先 RESIDUAL_HITS,findings 两类都在", () => {
    const r = residualFindings({ concept: "demoFlag", manifest: [entry({ target: "" })], hits: [hit()] });
    expect(r.code).toBe("RESIDUAL_HITS");
    expect(r.counts).toEqual({ hits: 1, unresolved: 1, skipped: 0 });
    expect(r.findings.map((f) => f.kind).sort()).toEqual(["hit", "unresolved"]);
  });

  it("畸形输入不抛错(非数组/空对象/null 元素)", () => {
    expect(residualFindings({}).code).toBe("OK");
    expect(residualFindings({ concept: 1, hits: "x", manifest: 42 }).code).toBe("OK");
    const r = residualFindings({ concept: "demoFlag", hits: [null, 3, "s", []], manifest: [null, 7] });
    expect(r.code).toBe("OK");
    expect(r.counts.skipped).toBe(6);
  });

  it("无 concept 时理由仍可读", () => {
    const r = residualFindings({ hits: [hit()] });
    expect(r.findings[0]!.reason).toContain("未解释");
  });

  it("verdict 无 findings → 四字段全空", () => {
    expect(residualVerdict({ findings: [], mode: "hard" })).toEqual({ warn: false, hardFail: false, mark: "", text: "" });
    expect(residualVerdict({})).toEqual({ warn: false, hardFail: false, mark: "", text: "" });
  });

  it("E warn 模式:warn=true / hardFail=false / mark=⚠ 残留", () => {
    const r = residualFindings({ concept: "demoFlag", manifest: [], hits: [hit()] });
    const v = residualVerdict({ findings: r.findings, mode: "warn" });
    expect(v.warn).toBe(true);
    expect(v.hardFail).toBe(false);
    expect(v.mark).toBe("⚠ 残留");
    expect(v.text).toContain("## 残留审计");
    expect(v.text).toContain("[hit]");
  });

  it("F hard 模式:hardFail=true / mark=❌ 残留未解释", () => {
    const r = residualFindings({ concept: "demoFlag", manifest: [entry({ target: "" })], hits: [] });
    const v = residualVerdict({ findings: r.findings, mode: "hard" });
    expect(v.hardFail).toBe(true);
    expect(v.mark).toBe("❌ 残留未解释");
    expect(v.text).toContain("清单未收口 1 条");
  });

  it("mode 非法值按 warn 处理", () => {
    const r = residualFindings({ concept: "demoFlag", manifest: [], hits: [hit()] });
    const v = residualVerdict({ findings: r.findings, mode: "whatever" });
    expect(v.warn).toBe(true);
    expect(v.hardFail).toBe(false);
  });

  it(`text 最多列 ${FINDINGS_TEXT_MAX} 条,其余给计数`, () => {
    const hits = Array.from({ length: 10 }, (_, i) => hit({ file: `src/f${i}.ts`, line: i + 1 }));
    const r = residualFindings({ concept: "demoFlag", manifest: [], hits });
    const v = residualVerdict({ findings: r.findings, mode: "warn" });
    expect(v.text.split("\n").filter((l) => l.startsWith("- [hit]")).length).toBe(FINDINGS_TEXT_MAX);
    expect(v.text).toContain("…还有 2 条");
  });

  it(`text 总长 ≤ ${RESIDUAL_TEXT_MAX}`, () => {
    const hits = Array.from({ length: 8 }, (_, i) => hit({ file: `src/f${i}.ts`, line: i + 1, text: "y".repeat(500) }));
    const r = residualFindings({ concept: "demoFlag", manifest: [], hits });
    const v = residualVerdict({ findings: r.findings, mode: "warn" });
    expect(v.text.length).toBeLessThanOrEqual(RESIDUAL_TEXT_MAX);
    expect(v.text.endsWith("…")).toBe(true);
  });

  it("formatResidualFindings 确定性排序(file → line → entryId)", () => {
    const r = residualFindings({
      concept: "demoFlag",
      manifest: [entry({ id: "b", target: "" }), entry({ id: "a", target: "" })],
      hits: [hit({ file: "src/b.ts", line: 5 }), hit({ file: "src/a.ts", line: 10 }), hit({ file: "src/a.ts", line: 2 })],
    });
    const lines = formatResidualFindings(r.findings);
 // 无 file 的清单条目排最前(按 entryId),其后是命中(file → line)
    expect(lines[0]).toContain("[unresolved] a");
    expect(lines[1]).toContain("[unresolved] b");
    expect(lines[2]).toContain("src/a.ts:2");
    expect(lines[3]).toContain("src/a.ts:10");
    expect(lines[4]).toContain("src/b.ts:5");
  });

  it("formatResidualFindings 不修改入参数组", () => {
    const r = residualFindings({ concept: "demoFlag", manifest: [], hits: [hit({ file: "b.ts" }), hit({ file: "a.ts" })] });
    const snapshot = r.findings.map((f) => f.file);
    formatResidualFindings(r.findings);
    expect(r.findings.map((f) => f.file)).toEqual(snapshot);
  });

  it("确定性:同一输入两次调用深相等", () => {
    const build = () => residualFindings({
      concept: "demoFlag",
      manifest: [entry({ target: "待定" }), entry({ id: "e2" })],
      hits: [hit({ file: "z.ts", line: 9 }), hit({ file: "a.ts", line: 1, explained: "ok" })],
    });
    const a = build();
    const b = build();
    expect(a).toEqual(b);
    expect(residualVerdict({ findings: a.findings, mode: "hard" }))
      .toEqual(residualVerdict({ findings: b.findings, mode: "hard" }));
  });

  it("不可变:冻结入参也能跑且不被改写", () => {
    const hits = Object.freeze([Object.freeze(hit()), Object.freeze(hit({ file: "src/z.ts", line: 1 }))]);
    const manifest = Object.freeze([Object.freeze(entry({ target: "" }))]);
    const input = Object.freeze({ concept: "demoFlag", manifest, hits });
    const before = JSON.stringify(input);
    const r = residualFindings(input);
    expect(r.code).toBe("RESIDUAL_HITS");
    expect(JSON.stringify(input)).toBe(before);
  });
});
