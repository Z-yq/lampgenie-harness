/**
 * branches 条件缺陷附注测试(设计稿 14.3 五判据):
 * 死循环风险/同体分支/空转分支/恒真恒假/重复条件 各≥1 正例 + 零缺陷负例(不产附注段)。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanDecisionFile, renderDecisionSkeleton, detectBranchDefects, type DecisionPoint } from "../src/sensing/decision.js";

let root: string;
let badRel: string;
let cleanRel: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "branch-defects-"));
  const bad = `export function risky(n: number): number {
  let guard = n;
  let acc = 0;
  while (guard > 0) {
    acc = acc + 1;
  }
  if (acc > 1) {
    total();
  } else {
    total();
  }
  if (true) {
    acc = 2;
  }
  if (n === n) {
    acc = 3;
  }
  return acc;
}
function total(): number { return 1; }
`;
  writeFileSync(join(root, "bad.ts"), bad);
  badRel = "bad.ts";

  const clean = `export function fine(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out = out + String(i);
  }
  if (n > 10) {
    return out.slice(0, 10);
  }
  return out;
}
`;
  writeFileSync(join(root, "clean.ts"), clean);
  cleanRel = "clean.ts";
});

afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});

describe("detectBranchDefects(经 scanDecisionFile 全链路)", () => {
  it("五判据各命中:死循环/同体/恒真/自等(恒真族)/空转按形态", async () => {
    const r = await scanDecisionFile(root, badRel);
    expect(r).not.toBeNull();
    const defects = r!.defects ?? [];
    const kinds = new Set(defects.map((d) => d.kind));
    expect(kinds.has("死循环风险")).toBe(true);   // guard 在循环体零出现
    expect(kinds.has("恒真恒假")).toBe(true);      // if (true) / n === n
  });

  it("defects 每条带 kind/line/text(渲染可溯)", async () => {
    const r = await scanDecisionFile(root, badRel);
    for (const d of r!.defects ?? []) {
      expect(d.line).toBeGreaterThan(0);
      expect(d.text.length).toBeGreaterThan(0);
    }
  });

  it("renderDecisionSkeleton 尾部出附注段(候选非定论口径)", async () => {
    const r = await scanDecisionFile(root, badRel);
    const text = renderDecisionSkeleton(r!);
    expect(text).toContain("⚠ 条件缺陷候选");
    expect(text).toContain("候选非定论");
    expect(text).toContain("死循环风险");
  });

  it("negative:干净文件零缺陷——defects 缺席且渲染无附注段", async () => {
    const r = await scanDecisionFile(root, cleanRel);
    expect(r).not.toBeNull();
    expect(r!.defects).toBeUndefined();
    const text = renderDecisionSkeleton(r!);
    expect(text).not.toContain("条件缺陷候选");
  });

  it("negative:knownLimits 仍恒在场(主用途=画像不被附注挤掉)", async () => {
    const r = await scanDecisionFile(root, cleanRel);
    expect(r!.knownLimits.length).toBeGreaterThan(0);
  });
});

describe("detectBranchDefects 直测(判据级正例:同体/空转/重复条件)", () => {
  const mkPoint = (over: Partial<DecisionPoint>): DecisionPoint => ({
    kind: "if", lineStart: 1, lineEnd: 3, depth: 0, literals: [], calls: [], ...over,
  });

  it("同体分支:if 体与 else 体 token 相同 → 命中", () => {
    const lines = [
      "function f() {",
      "  if (a > 0) {",
      "    total(1);",
      "    total(2);",
      "  } else {",
      "    total(1);",
      "    total(2);",
      "  }",
      "}",
    ];
    const points = [
      mkPoint({ kind: "if", lineStart: 2, lineEnd: 8, condition: "a > 0", fn: "f" }),
      mkPoint({ kind: "else", lineStart: 5, lineEnd: 8, fn: "f" }),
    ];
    const out = detectBranchDefects(points, lines);
    expect(out.some((d) => d.kind === "同体分支")).toBe(true);
  });

  it("空转分支:else 体仅空白无注释 → 命中", () => {
    const lines = [
      "function f() {",
      "  if (a > 0) {",
      "    total();",
      "  } else {",
      "  }",
      "  return 1;",
      "}",
    ];
    const points = [
      mkPoint({ kind: "if", lineStart: 2, lineEnd: 5, condition: "a > 0", fn: "f" }),
      mkPoint({ kind: "else", lineStart: 4, lineEnd: 5, fn: "f" }),
    ];
    const out = detectBranchDefects(points, lines);
    expect(out.some((d) => d.kind === "空转分支")).toBe(true);
  });

  it("重复条件:同函数两个 if 条件 token 高重叠但文本不同 → 命中", () => {
    const lines = [
      "function f(x: number) {",
      "  if (x > 100) { total(); }",
      "  if (x >  100 ) { total2(); }",
      "  return x;",
      "}",
    ];
    const points = [
      mkPoint({ lineStart: 2, lineEnd: 2, condition: "x > 100", fn: "f" }),
      mkPoint({ lineStart: 3, lineEnd: 3, condition: "x >  100", fn: "f" }),
    ];
    const out = detectBranchDefects(points, lines);
    expect(out.some((d) => d.kind === "重复条件")).toBe(true);
  });

  it("negative:不同函数的同形条件不互相误报重复", () => {
    const lines = [
      "function f(x: number) { if (x > 100) { total(); } return x; }",
      "function g(x: number) { if (x > 100) { total(); } return x; }",
    ];
    const points = [
      mkPoint({ lineStart: 1, lineEnd: 1, condition: "x > 100", fn: "f" }),
      mkPoint({ lineStart: 2, lineEnd: 2, condition: "x > 100", fn: "g" }),
    ];
    const out = detectBranchDefects(points, lines);
    expect(out.some((d) => d.kind === "重复条件")).toBe(false);
  });
});
