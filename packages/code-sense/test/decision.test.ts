/**
 * sensing/decision 单测:分支/循环决策点感知。
 * 覆盖:python(if/elif/else 独立 clause + while/for 迭代目标 + 三元)、js(else-if 链=
 * elif、for-of/in 区分、switch case/default、三元 ternary_expression)、typescript
 * (类型注解下零 ERROR)、c(do-while/for/switch case_statement/三元)、cpp(range-for)、
 * java(alternative 直挂 if/block、enhanced for、switch_expression 组)、go(for 三态:
 * for_clause/range_clause/裸条件、expression_case)、嵌套深度与调用归属最内层、
 * 内层决策点定位(refs 联动)、降级路径(不支持扩展名)。
 */
import { describe, it, expect } from "vitest";
import { extractDecisionPoints, decisionLangOf, innermostDecisionAt, renderDecisionSkeleton, scanDecisionFile } from "../src/sensing/decision";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PY_SRC = [
  "def f(a, b):",
  '    if a == "x":',
  "        g(a)",
  '    elif a == "y":',
  "        h(a)",
  "    else:",
  "        i(a)",
  "    while b > 0:",
  "        b -= 1",
  "    for item in a:",
  "        k(item)",
  "    v = g(a) if b else h(a)",
  "",
  "def other():",
  "    return check()",
].join("\n");

const JS_SRC = [
  "function f(a, b) {",
  '  if (a === "x") { g(a); }',
  '  else if (a === "y") { h(a); }',
  "  else { i(a); }",
  "  while (b > 0) { b--; }",
  "  for (let j = 0; j < 10; j++) { g(j); }",
  "  for (const x of a) { k(x); }",
  "  for (const key in a) { k(key); }",
  '  switch (a) { case "x": g(1); break; default: h(2); }',
  "  const v = a ? g(a) : h(a);",
  "}",
  "",
  "function outer() {",
  "  if (cond1()) {",
  "    if (cond2()) { deep(); }",
  "  }",
  "}",
].join("\n");

const TS_SRC = [
  "function f(a: string, b: number): number {",
  '  if (a === "x") { return g(a); }',
  "  for (const x of [a]) { k(x); }",
  "  return b;",
  "}",
].join("\n");

const C_SRC = [
  "int f(int a, int b) {",
  "  if (a == 1) { g(a); }",
  "  else if (a == 2) { h(a); }",
  "  else { i(a); }",
  "  while (b > 0) { b--; }",
  "  do { b--; } while (check(b));",
  "  for (int i2 = 0; i2 < 10; i2++) { g(i2); }",
  "  switch (a) { case 1: g(1); break; default: break; }",
  "  int v = a ? g(a) : h(a);",
  "  return v;",
  "}",
].join("\n");

const CPP_SRC = [
  "int f(std::vector<int> v) {",
  "  for (int x : v) { g(x); }",
  "  return 0;",
  "}",
].join("\n");

const JAVA_SRC = [
  "class C {",
  "  int f(int a, int b) {",
  "    if (a == 1) { g(a); }",
  "    else if (a == 2) { h(a); }",
  "    else { i(a); }",
  "    while (b > 0) { b--; }",
  "    do { b--; } while (b > 0);",
  "    for (int i3 = 0; i3 < 10; i3++) { g(i3); }",
  "    for (int x : arr) { k(x); }",
  "    switch (a) { case 1: g(1); break; default: break; }",
  "    int v = a ? g(a) : h(a);",
  "    return v;",
  "  }",
  "}",
].join("\n");

const GO_SRC = [
  "func f(a int, b int) int {",
  "\tif a == 1 {",
  "\t\tg(a)",
  "\t} else if a == 2 {",
  "\t\th(a)",
  "\t} else {",
  "\t\ti(a)",
  "\t}",
  "\tfor b > 0 {",
  "\t\tb--",
  "\t}",
  "\tfor j := 0; j < 10; j++ {",
  "\t\tg(j)",
  "\t}",
  "\tfor _, x := range a {",
  "\t\tk(x)",
  "\t}",
  "\tswitch a {",
  "\tcase 1:",
  "\t\tg(1)",
  "\tdefault:",
  "\t\th(2)",
  "\t}",
  "\treturn a",
  "}",
].join("\n");

describe("decision: python", () => {
  it("if/elif/else 独立成点,条件与字面量齐", async () => {
    const pts = await extractDecisionPoints("python", PY_SRC);
    expect(pts).not.toBeNull();
    const kinds = pts!.map((p) => p.kind);
    expect(kinds).toEqual(expect.arrayContaining(["if", "elif", "else", "while", "for", "ternary"]));
    const ifP = pts!.find((p) => p.kind === "if")!;
    expect(ifP.condition).toBe('a == "x"');
    expect(ifP.literals).toEqual(["x"]);
    expect(ifP.fn).toBe("f");
    expect(ifP.calls).toContain("g");
    const elifP = pts!.find((p) => p.kind === "elif")!;
    expect(elifP.calls).toContain("h");
    expect(elifP.calls).not.toContain("g"); // 嵌套/兄弟分支的调用不串点
    const elseP = pts!.find((p) => p.kind === "else")!;
    expect(elseP.calls).toEqual(["i"]);
  });

  it("for 带迭代目标与被迭代对象;while 条件;三元归属函数", async () => {
    const pts = await extractDecisionPoints("python", PY_SRC);
    const forP = pts!.find((p) => p.kind === "for")!;
    expect(forP.loopTarget).toBe("item");
    expect(forP.loopIterates).toBe("a");
    expect(forP.calls).toEqual(["k"]);
    const whileP = pts!.find((p) => p.kind === "while")!;
    expect(whileP.condition).toBe("b > 0");
    const ternary = pts!.find((p) => p.kind === "ternary")!;
    expect(ternary.condition).toBe("b");
    expect(ternary.fn).toBe("f");
    // other 函数无决策点:全部点归属 f
    expect(pts!.every((p) => p.fn === "f")).toBe(true);
  });
});

describe("decision: javascript/typescript", () => {
  it("else-if 链归 elif;for-of/for-in 区分;switch case/default", async () => {
    const pts = await extractDecisionPoints("javascript", JS_SRC);
    expect(pts).not.toBeNull();
    const kinds = pts!.map((p) => p.kind);
    expect(kinds).toEqual(expect.arrayContaining(["if", "elif", "else", "while", "for", "for-of", "for-in", "switch", "case", "default", "ternary"]));
    const elifP = pts!.find((p) => p.kind === "elif")!;
    expect(elifP.condition).toBe('a === "y"');
    const ofP = pts!.filter((p) => p.kind === "for-of");
    expect(ofP.length).toBeGreaterThanOrEqual(1);
    expect(ofP[0]!.loopTarget).toBe("x");
    expect(ofP[0]!.loopIterates).toBe("a");
    const inP = pts!.find((p) => p.kind === "for-in")!;
    expect(inP.loopTarget).toBe("key");
    const caseP = pts!.find((p) => p.kind === "case")!;
    expect(caseP.condition).toBe('"x"');
    expect(caseP.literals).toEqual(["x"]);
    const classic = pts!.filter((p) => p.kind === "for").find((p) => p.condition?.includes("j < 10"));
    expect(classic).toBeDefined();
  });

  it("嵌套深度与调用归属最内层(innermostDecisionAt 联动)", async () => {
    const pts = await extractDecisionPoints("javascript", JS_SRC);
    const inner = pts!.find((p) => p.calls.includes("deep"))!;
    expect(inner.kind).toBe("if");
    expect(inner.condition).toBe("cond2()");
    expect(inner.depth).toBe(1);
    const outer = pts!.find((p) => p.calls.includes("cond1"))!;
    expect(outer.calls).toContain("cond1");
    expect(outer.calls).not.toContain("deep"); // 内层调用不重复计入外层
    expect(innermostDecisionAt(pts!, 15)?.calls).toContain("deep");
  });

  it("typescript 语法独立解析(类型注解零 ERROR)", async () => {
    const pts = await extractDecisionPoints("typescript", TS_SRC);
    expect(pts).not.toBeNull();
    const kinds = pts!.map((p) => p.kind);
    expect(kinds).toEqual(expect.arrayContaining(["if", "for-of"]));
    const ifP = pts!.find((p) => p.kind === "if")!;
    expect(ifP.condition).toBe('a === "x"');
    expect(ifP.fn).toBe("f");
  });
});

describe("decision: c/cpp", () => {
  it("do-while/for/switch case_statement/三元;else-if 归 elif", async () => {
    const pts = await extractDecisionPoints("c", C_SRC);
    expect(pts).not.toBeNull();
    const kinds = pts!.map((p) => p.kind);
    expect(kinds).toEqual(expect.arrayContaining(["if", "elif", "else", "while", "do-while", "for", "switch", "case", "default", "ternary"]));
    const dw = pts!.find((p) => p.kind === "do-while")!;
    expect(dw.condition).toBe("check(b)");
    expect(dw.calls).toContain("check"); // 条件内调用归本点
    const c = pts!.find((p) => p.kind === "case")!;
    expect(c.condition).toBe("1");
    const forC = pts!.filter((p) => p.kind === "for").find((p) => p.condition?.includes("i2 < 10"));
    expect(forC).toBeDefined();
    expect(pts!.every((p) => p.fn === "f")).toBe(true);
  });

  it("cpp range-for = for-of(declarator/right)", async () => {
    const pts = await extractDecisionPoints("cpp", CPP_SRC);
    expect(pts).not.toBeNull();
    const ofP = pts!.find((p) => p.kind === "for-of");
    expect(ofP).toBeDefined();
    expect(ofP!.loopTarget).toBe("x");
    expect(ofP!.loopIterates).toBe("v");
    expect(ofP!.calls).toEqual(["g"]);
  });
});

describe("decision: java", () => {
  it("alternative 直挂形态:else-if=elif,enhanced for=for-of,switch 组=case", async () => {
    const pts = await extractDecisionPoints("java", JAVA_SRC);
    expect(pts).not.toBeNull();
    const kinds = pts!.map((p) => p.kind);
    expect(kinds).toEqual(expect.arrayContaining(["if", "elif", "else", "while", "do-while", "for", "for-of", "switch", "case", "default", "ternary"]));
    const elifP = pts!.find((p) => p.kind === "elif")!;
    expect(elifP.condition).toBe("a == 2");
    const enh = pts!.find((p) => p.kind === "for-of")!;
    expect(enh.loopTarget).toBe("x");
    expect(enh.loopIterates).toBe("arr");
    const caseP = pts!.find((p) => p.kind === "case")!;
    expect(caseP.condition).toBe("1");
    const ifP = pts!.find((p) => p.kind === "if")!;
    expect(ifP.fn).toBe("f");
  });
});

describe("decision: go", () => {
  it("for 三态:裸条件=条件文本,for_clause=条件,range=for-of;switch case/default", async () => {
    const pts = await extractDecisionPoints("go", GO_SRC);
    expect(pts).not.toBeNull();
    const kinds = pts!.map((p) => p.kind);
    expect(kinds).toEqual(expect.arrayContaining(["if", "elif", "else", "for", "for-of", "switch", "case", "default"]));
    const whileForm = pts!.filter((p) => p.kind === "for").find((p) => p.condition === "b > 0");
    expect(whileForm).toBeDefined();
    const classic = pts!.filter((p) => p.kind === "for").find((p) => p.condition?.includes("j < 10"));
    expect(classic).toBeDefined();
    const rng = pts!.find((p) => p.kind === "for-of")!;
    expect(rng.loopTarget).toBe("_, x");
    expect(rng.loopIterates).toBe("a");
    expect(rng.calls).toEqual(["k"]);
    const caseP = pts!.find((p) => p.kind === "case")!;
    expect(caseP.condition).toBe("1");
    expect(caseP.calls).toEqual(["g"]);
    const elifP = pts!.find((p) => p.kind === "elif")!;
    expect(elifP.calls).toEqual(["h"]);
  });
});

describe("decision: 入口与联动", () => {
  it("decisionLangOf 扩展名映射;不支持=undefined", () => {
    expect(decisionLangOf("a.py")).toBe("python");
    expect(decisionLangOf("a.ts")).toBe("typescript");
    expect(decisionLangOf("a.tsx")).toBe("typescript");
    expect(decisionLangOf("a.js")).toBe("javascript");
    expect(decisionLangOf("a.c")).toBe("c");
    expect(decisionLangOf("a.hpp")).toBe("cpp");
    expect(decisionLangOf("a.java")).toBe("java");
    expect(decisionLangOf("a.go")).toBe("go");
    expect(decisionLangOf("a.md")).toBeUndefined();
    expect(decisionLangOf("a.rs")).toBeUndefined();
  });

  it("scanDecisionFile 读文件+渲染;不支持类型=null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-decision-"));
    try {
      writeFileSync(join(dir, "m.py"), PY_SRC);
      const r = await scanDecisionFile(dir, "m.py");
      expect(r).not.toBeNull();
      expect(r!.engine).toBe("tree-sitter");
      expect(r!.totals.points).toBeGreaterThan(5);
      const text = renderDecisionSkeleton(r!);
      expect(text).toContain("分支/循环骨架");
      expect(text).toContain("[f]");
      expect(text).toContain('a == "x"');
      expect(text).toContain("迭代: item ← a");
      expect(await scanDecisionFile(dir, "nope.md")).toBeNull();
      expect(await scanDecisionFile(dir, "missing.py")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("语法错误区间跳过但其余照采(degraded)", async () => {
    // 局部坏行(可恢复):if 点存活
    const local = ["def f(a):", "    if a == 1:", "        g(a)", "    x = = = broken", "    return a", ""].join("\n");
    const pts = await extractDecisionPoints("python", local);
    expect(pts).not.toBeNull();
    expect(pts!.some((p) => p.kind === "if" && p.condition === "a == 1")).toBe(true);
    // 不可恢复错误(未闭合括号吞掉整个函数,ERROR 包裹全部):诚实跳过=零点
    const swallowed = ["def f(a):", "    if a == 1:", "        g(a)", "    this is ) not valid python (((", ""].join("\n");
    const pts2 = await extractDecisionPoints("python", swallowed);
    expect(pts2).toEqual([]);
  });
});
