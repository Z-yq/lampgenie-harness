/**
 * refs(字面量引用面):
 *  - 纯分类函数覆盖 6 类语境;
 *  - 本仓真实目标 graph:能找全 sense-index-manager.ts 的 === 分支/错误串、
 *    sense-tool.ts 的 retired 映射、测试文件与 docs/codesense-cli.md;
 *  - walk 引擎(自实现遍历)验证默认排除 node_modules/dist/.genie/vendor 与 --no-tests/--no-docs。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { classifyLiteralOccurrences, scanLiteralRefs } from "../src/retrieval/literal-refs.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TMP: string[] = [];

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "codesense-refs-"));
  TMP.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

afterEach(() => {
  for (const d of TMP.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败不影响断言 */
    }
  }
});

describe("classifyLiteralOccurrences(纯分类)", () => {
  it("case / eq / z-literal / object-key(引号与未引号)/ string / 注释", () => {
    expect(classifyLiteralOccurrences('    case "graph":', "graph")).toContain("case-literal");
    expect(classifyLiteralOccurrences('  if (action === "graph") {', "graph")).toContain("eq-literal");
    expect(classifyLiteralOccurrences('  if (action !== "graph") {', "graph")).toContain("eq-literal");
    expect(classifyLiteralOccurrences('  if (action == "graph") {', "graph")).toContain("eq-literal");
    expect(classifyLiteralOccurrences('  const s = z.literal("graph");', "graph")).toContain("z-literal");
    expect(classifyLiteralOccurrences('  const map = { "graph": 1 };', "graph")).toContain("object-key");
    expect(classifyLiteralOccurrences('  const map = { graph: 1 };', "graph")).toContain("object-key");
    expect(classifyLiteralOccurrences('  graph: 1,', "graph", "const map = {")).toContain("object-key");
 // 参数表 / TS 类型注解不是对象字面量键(值 PascalCase +,; }) 收尾 = 类型形态)
    expect(classifyLiteralOccurrences('  function f(a: string, graph: CallGraph) {', "graph")).not.toContain("object-key");
    expect(classifyLiteralOccurrences('  return { graph: CallGraph };', "graph")).not.toContain("object-key");
    expect(classifyLiteralOccurrences('  return { graph: cached.graph };', "graph")).toContain("object-key");
    expect(classifyLiteralOccurrences('  return "graph";', "graph")).toContain("string-literal");
    // 注释里的 case 不冒充分派,只按字符串提及记
    expect(classifyLiteralOccurrences('// case "graph": 旧分派', "graph")).toEqual(["string-literal"]);
    // 非完整字面量(子串)不命中
    expect(classifyLiteralOccurrences('  const s = "graphify";', "graph")).toEqual([]);
  });

  it("一行多语境(=== 与 z.literal 各记一次)", () => {
    const ctx = classifyLiteralOccurrences('  if (action === "graph") return z.literal("graph");', "graph");
    expect(ctx).toEqual(expect.arrayContaining(["eq-literal", "z-literal"]));
  });

  it("C/C++ 预处理宏引用(2026-10-22 P0)", () => {
    expect(classifyLiteralOccurrences("#ifdef USE_FIXED", "USE_FIXED")).toContain("cpp-macro");
    expect(classifyLiteralOccurrences("#ifndef USE_FIXED", "USE_FIXED")).toContain("cpp-macro");
    expect(classifyLiteralOccurrences("#if defined(USE_FIXED) && X", "USE_FIXED")).toContain("cpp-macro");
    expect(classifyLiteralOccurrences("#define USE_FIXED 1", "USE_FIXED")).toContain("cpp-macro");
    // 普通字符串提及不算宏引用
    expect(classifyLiteralOccurrences('const char* s = "USE_FIXED";', "USE_FIXED")).not.toContain("cpp-macro");
  });
});

describe("构建文件与宏引用进扫描面(2026-10-22 P0)", () => {
  it("CMakeLists/Makefile 归 build 桶,宏引用归 cpp-macro", async () => {
    const dir = fixture({
      "CMakeLists.txt": "option(USE_FIXED \"use fixed post process\" ON)\nadd_library(mod_a ./src/a.c)\n",
      "Makefile": "CFLAGS += -DUSE_FIXED\n",
      "src/a.c": "#ifdef USE_FIXED\nint fixed(void) { return 1; }\n#endif\n",
    });
    const r = await scanLiteralRefs(dir, "USE_FIXED");
    expect(r.totals.build).toBe(2); // CMakeLists + Makefile
    expect(r.totals.byContext["cpp-macro"]).toBeGreaterThanOrEqual(1);
    expect(r.groups["build-file"].map((h) => h.file).sort()).toEqual(["CMakeLists.txt", "Makefile"]);
  });
});

describe("scanLiteralRefs(本仓真实目标 graph)", () => {
  it("找全 === 分支 / 错误串 / sense-tool retired 映射 / 测试 / 文档,且语境分组", async () => {
    const r = await scanLiteralRefs(ROOT, "graph");
    // 行号不写死(文件增删行会让 :328/:345 锚点过期):按 file+context 断言,行号只要求 >0。
    const branch = r.hits.find((h) => h.file === "apps/gateway/src/sense-index-manager.ts" && h.context === "eq-literal");
    expect(branch, "action === \"graph\" 分支应命中 eq-literal").toBeTruthy();
    expect(branch!.line).toBeGreaterThan(0);
    const errString = r.hits.find((h) => h.file === "apps/gateway/src/sense-index-manager.ts" && h.context === "string-literal");
    expect(errString, "错误串应命中 string-literal").toBeTruthy();
    expect(errString!.line).toBeGreaterThan(0);

    const retired = r.hits.find(
      (h) => h.file === "apps/gateway/src/sense-tool.ts" && h.context === "object-key" && h.text.includes("graph:"),
    );
    expect(retired, "sense-tool.ts 的 retired 映射键应命中 object-key").toBeTruthy();

    const testHit = r.hits.find((h) => h.kind === "test" && h.context === "string-literal");
    expect(testHit, "测试文件里应有 string-literal 命中").toBeTruthy();
    expect(testHit!.file).toMatch(/test\//);

    const docHit = r.hits.find((h) => h.file === "docs/codesense-cli.md" && h.context === "doc");
    expect(docHit, "docs/codesense-cli.md 应有 doc 命中").toBeTruthy();

    // 语境分组自洽:每组只含本语境
    for (const [ctx, items] of Object.entries(r.groups)) {
      for (const h of items) expect(h.context).toBe(ctx);
    }
    expect(r.totals.code).toBeGreaterThan(0);
    expect(r.totals.test).toBeGreaterThan(0);
    expect(r.totals.doc).toBeGreaterThan(0);

    // 所属符号:索引在场时两处都归属 formatQuery(最近前置声明);缺席留空不猜
    if (r.indexAvailable) {
      expect(branch!.symbol).toBe("formatQuery");
      expect(errString!.symbol).toBe("formatQuery");
      expect(r.nextSteps).toContain("codesense impact formatQuery");
    } else {
      expect(branch!.symbol).toBeUndefined();
    }
    expect(r.engine).toBe("grep");
  }, 120_000);
});

describe("scanLiteralRefs(walk 引擎/排除口径)", () => {
  const SRC = [
    "export function run(action: string) {",
    '  if (action === "widget") return z.literal("widget");',
    '  switch (action) {',
    '    case "widget":',
    "      return 1;",
    "  }",
    '  return "widget";',
    "}",
    'const map = { widget: 1 };',
    "",
  ].join("\n");

  it("默认排除 node_modules/dist/.genie/vendor;五类代码语境 + doc 都可命中", async () => {
    const dir = fixture({
      "src/app.ts": SRC,
      "test/app.test.ts": 'expect(run("widget")).toBe(1);\n',
      "docs/guide.md": "widget 是字符串标识。\n",
      "node_modules/pkg/index.js": 'module.exports = "widget";\n',
      "dist/app.js": 'const a = "widget";\n',
      ".genie/cache.js": 'const b = "widget";\n',
      "vendor/lib.js": 'const c = "widget";\n',
    });
    const r = await scanLiteralRefs(dir, "widget", { engine: "walk" });
    expect(r.engine).toBe("walk");
    const files = new Set(r.hits.map((h) => h.file));
    expect(files.has("src/app.ts")).toBe(true);
    expect(files.has("test/app.test.ts")).toBe(true);
    expect(files.has("docs/guide.md")).toBe(true);
    for (const f of files) {
      expect(f).not.toMatch(/(^|\/)(node_modules|dist|\.genie|vendor)\//);
    }
    const srcCtx = new Set(r.hits.filter((h) => h.file === "src/app.ts").map((h) => h.context));
    expect(srcCtx).toEqual(new Set(["case-literal", "eq-literal", "z-literal", "object-key", "string-literal"]));
    expect(r.totals.code).toBeGreaterThan(0);
    expect(r.totals.test).toBe(1);
    expect(r.totals.doc).toBe(1);
  });

  it("--no-tests / --no-docs 关闭对应扫描面(默认都开启)", async () => {
    const dir = fixture({
      "src/app.ts": SRC,
      "test/app.test.ts": 'expect(run("widget")).toBe(1);\n',
      "docs/guide.md": "widget 是字符串标识。\n",
    });
    const noTests = await scanLiteralRefs(dir, "widget", { engine: "walk", includeTests: false });
    expect(noTests.hits.some((h) => h.kind === "test")).toBe(false);
    expect(noTests.filtered.tests).toBeGreaterThan(0);
    expect(noTests.hits.some((h) => h.kind === "doc")).toBe(true);

    const noDocs = await scanLiteralRefs(dir, "widget", { engine: "walk", includeDocs: false });
    expect(noDocs.hits.some((h) => h.kind === "doc")).toBe(false);
    expect(noDocs.filtered.docs).toBeGreaterThan(0);
    expect(noDocs.hits.some((h) => h.kind === "test")).toBe(true);
  });

  it("includeBare(2026-11-06):缺省 false 只认引号字面量,true 才把未加引号的标识符出现算命中", async () => {
    const dir = fixture({
      "src/demo-flag.ts": [
        "export const demoFlag = 1;",
        'export const label = "demoFlag";',
        "const demoFlagAlt = 2;",
        "",
      ].join("\n"),
    });
    const off = await scanLiteralRefs(dir, "demoFlag", { engine: "walk" });
    // refs 工具口径逐字不变:只有引号那条进命中
    expect(off.hits.map((h) => h.line)).toEqual([2]);
    expect(off.hits[0]!.context).toBe("string-literal");

    const on = await scanLiteralRefs(dir, "demoFlag", { engine: "walk", includeBare: true });
    expect(on.hits.map((h) => h.line)).toEqual([1, 2]);
    expect(on.hits.every((h) => h.context === "string-literal")).toBe(true);
    // 词边界生效:demoFlagAlt 不是 demoFlag 的出现(标识符形态按整词匹配)
    expect(on.hits.some((h) => h.line === 3)).toBe(false);
  });
});

describe("决策点标注与预览(2026-10-21,联动 sensing/decision)", () => {
  it("eq-literal 命中挂最内层决策点 + ±2 行预览 + 渲染 ⟂ 行", async () => {
    const dir = fixture({
      "mod.py": [
        "def run(mode):",
        '    if mode == "fixed":',
        "        reset_buf()",
        "    else:",
        "        dynamic_buf()",
        "    return mode",
        "",
      ].join("\n"),
    });
    const r = await scanLiteralRefs(dir, "fixed", { engine: "walk" });
    const hit = r.hits.find((h) => h.context === "eq-literal");
    expect(hit).toBeDefined();
    expect(hit!.decision?.kind).toBe("if");
    expect(hit!.decision?.condition).toBe('mode == "fixed"');
    expect(hit!.decision?.line).toBe(2);
    expect(hit!.preview?.length).toBe(4); // 行 1-4(命中行 2,±2)
    expect(hit!.preview?.some((l) => l.startsWith(">2"))).toBe(true);
    const { renderLiteralRefs } = await import("../src/retrieval/literal-refs.js");
    expect(renderLiteralRefs(r)).toContain('⟂ if mode == "fixed" (@2)');
  });

  it("不支持语言(md)命中不挂决策点不挂预览", async () => {
    const dir = fixture({ "doc.md": 'use "fixed" mode\n' });
    const r = await scanLiteralRefs(dir, "fixed", { engine: "walk" });
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits.every((h) => h.decision === undefined && h.preview === undefined)).toBe(true);
  });
});
