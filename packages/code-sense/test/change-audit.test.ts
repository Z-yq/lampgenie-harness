/** surface 审计:resolved/removed 计入 resolved;keep-legacy 需带 ≥4 字理由否则进 invalidJustifications;未覆盖命中 → unexplained。 */
import { describe, it, expect } from "vitest";
import { auditSurface } from "../src/surface/audit.js";
import type { SurfaceResolution } from "../src/surface/audit.js";
import type { SurfaceCategory, SurfaceHit, SurfaceReport } from "../src/surface/index.js";

let seq = 0;

function hit(category: SurfaceCategory, file: string, line = 1): SurfaceHit {
  seq++;
  return {
    id: `${category}:${file}:${line}:demoFlag`,
    category, file, line,
    text: `const x = "demoFlag"; // ${seq}`,
    suggest: "change",
    concept: "demoFlag",
  };
}

function reportOf(hits: SurfaceHit[]): SurfaceReport {
  const byCategory = {
    protocol: 0, db: 0, journal: 0, config: 0, symbol: 0, ui: 0, assets: 0,
    deploy: 0, i18n: 0, tests: 0, docs: 0,
  } as Record<SurfaceCategory, number>;
  for (const h of hits) byCategory[h.category]++;
  return {
    root: "/tmp/toy", concepts: ["demoFlag"], hits, byCategory,
    scannedFiles: hits.length, truncated: false, knownLimits: [],
  };
}

const SEVEN: [SurfaceCategory, string][] = [
  ["protocol", "packages/protocol/src/messages.ts"],
  ["journal", "src/journal/events.ts"],
  ["config", "genie.config.json"],
  ["ui", "apps/gateway/src/panel.ts"],
  ["assets", "assets/demo-assets.json"],
  ["tests", "packages/protocol/test/demo.test.ts"],
  ["docs", "docs/demo.md"],
];

function sevenHits(): SurfaceHit[] {
  return SEVEN.map(([c, f], i) => hit(c, f, i + 1));
}

describe("auditSurface", () => {
  it("只 resolved ui → passed=false,unexplained 含其余六类", () => {
    const rep = reportOf(sevenHits());
    const ui = rep.hits.find((h) => h.category === "ui")!;
    const a = auditSurface(rep, [{ file: ui.file, line: ui.line, status: "resolved" }]);
    expect(a.passed).toBe(false);
    expect(a.total).toBe(7);
    expect(a.resolved).toBe(1);
    const cats = new Set(a.unexplained.map((u) => u.category));
    for (const c of ["protocol", "journal", "config", "assets", "tests", "docs"] as const) {
      expect(cats.has(c), `unexplained 应含 ${c}`).toBe(true);
    }
    expect(a.unexplained.some((u) => u.category === "ui")).toBe(false);
    expect(a.invalidJustifications).toEqual([]);
    expect(a.summary).toContain("未通过");
  });

  it("全部 resolved → passed=true", () => {
    const rep = reportOf(sevenHits());
    const res: SurfaceResolution[] = rep.hits.map((h) => ({ file: h.file, line: h.line, status: "resolved" }));
    const a = auditSurface(rep, res);
    expect(a.passed).toBe(true);
    expect(a.resolved).toBe(7);
    expect(a.justified).toBe(0);
    expect(a.summary).toContain("通过");
  });

  it("removed 同样计入 resolved", () => {
    const rep = reportOf(sevenHits());
    const res: SurfaceResolution[] = rep.hits.map((h) => ({ file: h.file, status: "removed" }));
    const a = auditSurface(rep, res);
    expect(a.passed).toBe(true);
    expect(a.resolved).toBe(7);
  });

  it("keep-legacy 带 reason → justified 且 passed", () => {
    const rep = reportOf(sevenHits());
    const res: SurfaceResolution[] = rep.hits.map((h) => ({
      file: h.file,
      line: h.line,
      status: h.category === "docs" ? ("keep-legacy" as const) : ("resolved" as const),
      ...(h.category === "docs" ? { reason: "历史章节,保留旧说明" } : {}),
    }));
    const a = auditSurface(rep, res);
    expect(a.passed).toBe(true);
    expect(a.justified).toBe(1);
    expect(a.resolved).toBe(6);
    expect(a.invalidJustifications).toEqual([]);
  });

  it("keep-legacy 无 reason → passed=false 且 invalidJustifications 非空", () => {
    const rep = reportOf(sevenHits());
    const res: SurfaceResolution[] = rep.hits.map((h) => ({
      file: h.file,
      line: h.line,
      status: h.category === "docs" ? ("keep-legacy" as const) : ("resolved" as const),
    }));
    const a = auditSurface(rep, res);
    expect(a.passed).toBe(false);
    expect(a.invalidJustifications.length).toBe(1);
    expect(a.invalidJustifications[0]!.file).toBe("docs/demo.md");
    expect(a.justified).toBe(0);
    expect(a.summary).toContain("无效理由 1");
  });

  it("reason 过短(<4 字)也算无效", () => {
    const rep = reportOf([hit("docs", "docs/demo.md")]);
    const a = auditSurface(rep, [{ file: "docs/demo.md", status: "keep-legacy", reason: "旧" }]);
    expect(a.passed).toBe(false);
    expect(a.invalidJustifications.length).toBe(1);
  });

  it("file 匹配但 line 不等 → 不算覆盖(unexplained)", () => {
    const rep = reportOf([hit("ui", "apps/gateway/src/panel.ts", 10)]);
    const a = auditSurface(rep, [{ file: "apps/gateway/src/panel.ts", line: 11, status: "resolved" }]);
    expect(a.passed).toBe(false);
    expect(a.unexplained.length).toBe(1);
  });
});
