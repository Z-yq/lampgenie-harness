/**
 * fail-visible 三面单测:
 * 覆盖报告计算/告警判定、manifest 落盘(buildIndexWithReuse)、doctor 覆盖核对(WARN 不假绿)、
 * entrypoints 零覆盖显式状态、旧索引向后兼容(无 coverage 字段=现场重算降级,不假绿不炸)。
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndexWithReuse } from "../src/incremental.js";
import { runDoctor } from "../src/doctor.js";
import { formatEntrypointsBlock, type RepoState } from "../src/mcp-core.js";
import { loadIndex, saveIndex, querySymbol, queryEntryPoints, type C2fIndex } from "@lampgenie/code-sense/callgraph/c2f";
import {
  computeLanguageCoverage, coverageWarnings, coverageVerdict, formatCoverageLine, type LanguageCoverage,
} from "@lampgenie/code-sense/callgraph/coverage";

const dirs: string[] = [];
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gh-cov-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("语言覆盖报告( fail-visible)", () => {
  it("computeLanguageCoverage:磁盘/已索引按扩展名分列,零覆盖如实呈现", async () => {
    const dir = fixture({
      "a.c": "int one(void) { return 1; }\n",
      "b.c": "int two(void) { return 2; }\n",
      "inc/hdr.h": "int hdr_fn(void);\n",
      "util.py": "def py_fn():\n    pass\n",
    });
    const cov = await computeLanguageCoverage(dir, ["a.c", "util.py"]);
    expect(cov.byExt[".c"]).toEqual({ diskFiles: 2, indexedFiles: 1 });
    expect(cov.byExt[".h"]).toEqual({ diskFiles: 1, indexedFiles: 0 });
    expect(cov.byExt[".py"]).toEqual({ diskFiles: 1, indexedFiles: 1 });
    expect(cov.totalDisk).toBe(4);
    expect(cov.totalIndexed).toBe(2);
  });

  it("coverageVerdict/coverageWarnings:zero 与 C/C++ low 告警,健康面零告警", () => {
    expect(coverageVerdict(".h", { diskFiles: 10, indexedFiles: 0 })).toBe("zero");
    expect(coverageVerdict(".cpp", { diskFiles: 10, indexedFiles: 3 })).toBe("low");
    expect(coverageVerdict(".cpp", { diskFiles: 10, indexedFiles: 8 })).toBe("ok");
    expect(coverageVerdict(".py", { diskFiles: 10, indexedFiles: 3 })).toBe("ok"); // 非 C/C++ 不套低覆盖阈
    expect(coverageVerdict(".c", { diskFiles: 0, indexedFiles: 0 })).toBe("ok"); // 磁盘无文件不判缺
    const warns = coverageWarnings({
      byExt: {
        ".h": { diskFiles: 10, indexedFiles: 0 },
        ".cpp": { diskFiles: 4, indexedFiles: 1 },
        ".py": { diskFiles: 10, indexedFiles: 2 },
      },
      totalDisk: 24,
      totalIndexed: 3,
    });
    expect(warns).toHaveLength(2);
    expect(warns[0]).toContain(".h: 磁盘 10 个源文件,覆盖 0");
    expect(warns[1]).toContain(".cpp");
    expect(formatCoverageLine({ byExt: { ".c": { diskFiles: 6, indexedFiles: 6 } }, totalDisk: 6, totalIndexed: 6 })).toContain(".c 6/6");
    expect(formatCoverageLine(undefined)).toBeUndefined();
  });

  it("manifest:buildIndexWithReuse 产物带 coverage 字段(含  分层)并落盘可读回", async () => {
    const dir = fixture({
      "lib.c": "int add_them(int a, int b) { return a + b; }\n",
      "hdr.h": "int add_them(int a, int b);\n",
      "aggregator.h": "#ifndef AGG_H\n#define AGG_H\n#include <stdio.h>\n#endif\n",
    });
    const out = await buildIndexWithReuse(dir, { force: true });
    expect(out.index.coverage).toBeDefined();
    // 分层:lib.c/hdr.h=full(有符号),aggregator.h=empty(解析干净确认无声明,如实计覆盖)
    expect(out.index.coverage!.byExt[".c"]).toMatchObject({ diskFiles: 1, indexedFiles: 1, full: 1, lexical: 0, empty: 0, skipped: 0 });
    expect(out.index.coverage!.byExt[".h"]).toMatchObject({ diskFiles: 2, indexedFiles: 1, full: 1, empty: 1 });
    expect(out.index.coverage!.coveragePct).toBe(100); // (full 2 + empty 1)/3
    expect(out.index.coverage!.totalCovered).toBe(3);
    expect(out.index.coverage!.layeredScope).toBe("full");
    // 落盘回读
    const back = loadIndex(dir)!;
    expect(back.coverage?.byExt[".c"]).toMatchObject({ diskFiles: 1, indexedFiles: 1, full: 1 });
    // C/C++ 文件确实进了索引(符号可查)
    expect(querySymbol(back, "add_them").length).toBeGreaterThan(0);
  });

  it(" 分层:lexical/skipped 计数与 skippedReasons 逐文件,coveragePct 口径诚实", async () => {
    const dir = fixture({
      "ok.c": "int ok_fn(void) { return 1; }\n",
      "noise.h": "@interface Trash : NSObject\n@end\nextern int g_flag;\n", // ObjC 干扰致 ERROR,但 extern 声明经容错提取→ full
      "pure_blob.h": "0x62, 0xEB, 0x5A, 0xAA,\n".repeat(25000), // 超 512KB 闸、零声明 → skipped(429KB 会进 tree-sitter 病态解析,必须 >512KB)
    });
    const out = await buildIndexWithReuse(dir, { force: true });
    const cov = out.index.coverage!;
    expect(cov.byExt[".c"]).toMatchObject({ full: 1 });
    expect(cov.byExt[".h"] && cov.byExt[".h"].full).toBe(1); // noise.h: 容错提取 extern 声明 → full(原词法档漂移,能力增益)
    expect(cov.byExt[".h"] && cov.byExt[".h"].skipped).toBe(1); // pure_blob.h 跳过
    expect(cov.coveragePct).toBe(66.7); // (full 1 + lexical 1)/(3) — skipped 不进分子
    expect(Object.keys(cov.skippedReasons ?? {})).toContain("pure_blob.h");
    expect((cov.skippedReasons ?? {})["pure_blob.h"]).toContain("512KB");
    // doctor 覆盖行带分层口径
    expect(formatCoverageLine(cov)).toContain("分层覆盖 66.7%");
  });

  it(" RC-G:GENIE_SENSE_MAX_FILES 上限可配,truncation 如实登记", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`f${i}.c`] = `int fn_${i}(void) { return ${i}; }\n`;
    const dir = fixture(files);
    const prev = process.env.GENIE_SENSE_MAX_FILES;
    process.env.GENIE_SENSE_MAX_FILES = "10"; // floor=10
    try {
      const out = await buildIndexWithReuse(dir, { force: true });
      expect(out.index.nodes.length).toBe(10); // 只扫到上限
      expect(out.index.coverage!.truncated).toBeDefined();
      expect(out.index.coverage!.truncated!.reason).toContain("GENIE_SENSE_MAX_FILES");
      expect(out.index.coverage!.totalDisk).toBe(10); // 分母=截断后集合,截断已如实登记
    } finally {
      if (prev === undefined) delete process.env.GENIE_SENSE_MAX_FILES;
      else process.env.GENIE_SENSE_MAX_FILES = prev;
    }
  });

  it("doctor:C 仓零覆盖 → 显式 WARN(不再全 [ok] 假绿),warn 不翻转退出判定", async () => {
    const dir = fixture({
      "real.c": "int real_fn(int x) { return x; }\n",
      "another.c": "int another_fn(void) { return 0; }\n",
      "update_defines.py": "VALUE = 1\n",
    });
 // 手工构造旧形态索引:只有 py 文件符号、无 coverage 字段(经验证的 1/~1846 假绿形态)
    const oldStyle: C2fIndex = {
      version: 1,
      root: dir,
      gitHead: "",
      builtAt: Date.now(),
      buildMs: 1,
      nodes: [{ id: "update_defines.py#main", name: "main", file: "update_defines.py", line: 1, kind: "trunk", outCount: 0, inCount: 0 }],
      edges: [],
      byFile: { "update_defines.py": ["update_defines.py#main"] },
      byName: { main: ["update_defines.py#main"] },
    };
    saveIndex(dir, oldStyle);
    const d = await runDoctor(dir);
    const covWarn = d.checks.filter((c) => c.name.startsWith("coverage:") && c.status === "warn");
    // .c 零覆盖 WARN + 旧格式 manifest WARN
    expect(covWarn.some((c) => c.name === "coverage:.c" && c.detail.includes("磁盘 2 个源文件,覆盖 0"))).toBe(true);
    expect(covWarn.some((c) => c.name === "coverage:manifest")).toBe(true);
    expect(d.ok).toBe(true); // warn 语义:可见但不 fail(与 doctor 既有契约一致)
  });

  it("entrypoints:零覆盖语言 → 显式状态行,不再是误导视图", async () => {
    const dir = fixture({
      "a.c": "int c_fn(void) { return 1; }\n",
      "only.py": "def py_entry():\n    pass\n",
    });
    const oldStyle: C2fIndex = {
      version: 1,
      root: dir,
      gitHead: "",
      builtAt: Date.now(),
      buildMs: 1,
      nodes: [{ id: "only.py#py_entry", name: "py_entry", file: "only.py", line: 1, kind: "trunk", outCount: 0, inCount: 0 }],
      edges: [],
      byFile: { "only.py": ["only.py#py_entry"] },
      byName: { py_entry: ["only.py#py_entry"] },
    };
    const st: RepoState = { root: dir, name: "zerocov", index: oldStyle, stale: true };
    const text = formatEntrypointsBlock(st, 15, 8);
    expect(text).toContain("py_entry"); // 已索引语言的入口仍列出(如实)
    expect(text).toContain("覆盖缺口"); // 零覆盖显式告警
    expect(text).toContain(".c: 磁盘 1 个源文件,覆盖 0");
    expect(text).toContain("非全仓视图");
  });

  it("向后兼容:旧索引(无 coverage 字段)不重建——查询/entrypoints 可用,降级显式", async () => {
    const dir = fixture({
      "solo.c": "int solo_fn(void) { return 1; }\n",
    });
    const oldStyle: C2fIndex = {
      version: 1,
      root: dir,
      gitHead: "",
      builtAt: Date.now(),
      buildMs: 1,
      nodes: [
        { id: "legacy.ts#legacyFn", name: "legacyFn", file: "legacy.ts", line: 3, kind: "trunk", outCount: 1, inCount: 0 },
        { id: "legacy.ts#helper", name: "helper", file: "legacy.ts", line: 1, kind: "leaf", outCount: 0, inCount: 1 },
      ],
      edges: [{ from: "legacy.ts#legacyFn", to: "legacy.ts#helper", toName: "helper", file: "legacy.ts", line: 3, kind: "import" }],
      byFile: { "legacy.ts": ["legacy.ts#legacyFn", "legacy.ts#helper"] },
      byName: { legacyFn: ["legacy.ts#legacyFn"], helper: ["legacy.ts#helper"] },
    };
    saveIndex(dir, oldStyle);
    const idx = loadIndex(dir)!;
    expect(idx.coverage).toBeUndefined(); // 旧格式如实无字段
    // 查询面照常工作(降级可用)
    expect(querySymbol(idx, "legacyFn")).toHaveLength(1);
    expect(queryEntryPoints(idx)).toHaveLength(1);
    // 覆盖状态现场重算:.ts 磁盘 0/索引 2(如实并列),.c 零覆盖告警
    const cov: LanguageCoverage = await computeLanguageCoverage(dir, Object.keys(idx.byFile));
    const warns = coverageWarnings(cov);
    expect(warns.some((w) => w.startsWith(".c:"))).toBe(true);
  });
});
// RC-H:整仓不支持语言 fail-visible(此前纯 Rust/C#/PHP 仓 totalDisk=0,
// doctor「磁盘无源文件」+「通过」假绿;audit 注意)
// Rust/C#/Ruby/PHP 已接入 adapter → 本组夹具改用仍未覆盖的 Lua/Kotlin。
describe("不支持语言诚实报错( RC-H)", () => {
  it("纯 .lua 仓:coverage 行含 unsupported 标记,告警显式「语言不支持」而非二义措辞", async () => {
    const dir = fixture({
      "src/main.lua": "local function main() end\n",
      "src/lib.lua": "local function lib_fn() end\n",
    });
    const cov = await computeLanguageCoverage(dir, []);
    expect(cov.byExt[".lua"]).toMatchObject({ diskFiles: 2, indexedFiles: 0, unsupported: true });
    expect(cov.unsupportedByExt).toMatchObject({ ".lua": 2 });
    const warns = coverageWarnings(cov);
    expect(warns.some((w) => w.includes(".lua: 语言不支持(无 adapter)"))).toBe(true);
    expect(warns.some((w) => w.includes("语言不适配或该语言解析全部失败"))).toBe(false); // 不再二义
    expect(formatCoverageLine(cov)).toContain(".lua 0/2(不支持)");
  });

  it("混合仓:不支持语言进分层分母,coveragePct 如实下降;manifest 落盘可读回", async () => {
    const dir = fixture({
      "a.go": "package app\n\nfunc AppRun() int { return 1 }\n",
      "m.lua": "local function m() end\n",
    });
    const out = await buildIndexWithReuse(dir, { force: true });
    const cov = out.index.coverage!;
    expect(cov.byExt[".go"]).toMatchObject({ diskFiles: 1, indexedFiles: 1, full: 1 });
    expect(cov.byExt[".lua"]).toMatchObject({ diskFiles: 1, indexedFiles: 0, skipped: 1, unsupported: true });
    expect(cov.coveragePct).toBe(50); // covered 1 /(1 go + 1 lua)——不支持语言计入分母
    const back = loadIndex(dir)!;
    expect(back.coverage?.byExt[".lua"]?.unsupported).toBe(true);
  });

  it("doctor:纯不支持语言仓不再「磁盘无源文件」假绿,显式 WARN 语言不支持", async () => {
    const dir = fixture({
      "p.kt": "fun guzzleGet(u: String) = u\n",
      "q.kt": "fun guzzlePost(u: String) = u\n",
    });
    const out = await buildIndexWithReuse(dir, { force: true });
    expect(out.index.nodes.length).toBe(0); // 不索引(诚实空)
    const d = await runDoctor(dir);
    const covWarn = d.checks.filter((c) => c.name.startsWith("coverage:") && c.status === "warn");
    expect(covWarn.some((c) => c.name === "coverage:.kt" && c.detail.includes("语言不支持(无 adapter)"))).toBe(true);
    // 覆盖行不再是「磁盘无源文件」
    const covLine = d.checks.find((c) => c.name === "coverage");
    expect(covLine?.detail ?? "").toContain(".kt 0/2(不支持)");
    expect(covLine?.detail ?? "").not.toContain("磁盘无源文件");
  });

  it("Rust/C#/Ruby/PHP 已接入 adapter:不再计入不支持清单,文件进索引", async () => {
    const dir = fixture({
      "a.rs": "pub fn rust_fn() -> i32 { 1 }\n",
      "b.cs": "public class CsClass { public void Run() {} }\n",
      "c.rb": "class RbClass\n  def go\n    1\n  end\nend\n",
      "d.php": "<?php function php_fn() {}\n",
    });
    const cov = await computeLanguageCoverage(dir, []);
    for (const ext of [".rs", ".cs", ".rb", ".php"]) {
      expect(cov.byExt[ext]?.unsupported).toBeUndefined();
    }
    expect(cov.unsupportedByExt).toBeUndefined();
    const out = await buildIndexWithReuse(dir, { force: true });
    expect(out.index.nodes.length).toBeGreaterThanOrEqual(4);
    const names = out.index.nodes.map((n) => n.name);
    for (const n of ["rust_fn", "CsClass", "RbClass", "php_fn"]) expect(names).toContain(n);
  });
});

