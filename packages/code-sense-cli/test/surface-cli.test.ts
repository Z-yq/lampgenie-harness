/**
 * CLI smoke:surface 概念足迹面(11 类表面分类 + 相对路径 + 缺概念词即用法错)。
 * 用极小玩具目录(3 个命中文件)只读扫描,不建索引、不扫整仓(慢=不可接受)。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliIo } from "../src/cli.js";
import { SURFACE_CATEGORIES } from "@lampgenie/code-sense/surface";

function capture(): { io: CliIo; out: () => string; err: () => string } {
  const o: string[] = [];
  const e: string[] = [];
  return {
    io: { out: (s) => (o.push(s), undefined), err: (s) => (e.push(s), undefined) },
    out: () => o.join("\n"),
    err: () => e.join("\n"),
  };
}

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codesense-surface-"));
  const put = (rel: string, text: string) => {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text, "utf8");
  };
  // 三处命中,分别落在 protocol / config / docs 三个表面
  put("packages/protocol/src/x.ts", 'export const msg = "demoFlag";\n');
  put("genie.config.json", '{\n  "feature": "demoFlag"\n}\n');
  put("docs/a.md", "# 章节\n\n关于 demoFlag 的说明。\n");
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("CLI surface", () => {
  it("surface <概念词> --json:退出 0 + 可解析 + byCategory 11 类键 + 相对路径", async () => {
    const cap = capture();
    const code = await runCli(["surface", "demoFlag", "--root", root, "--json"], cap.io);
    expect(code).toBe(0);
    const j = JSON.parse(cap.out());
    expect(typeof j.root).toBe("string");
    expect(Array.isArray(j.knownLimits)).toBe(true);
    expect(j.concepts).toEqual(["demoFlag"]);
    // byCategory:11 类表面键齐全(零命中也要有键,计数不编造;数量随 SURFACE_CATEGORIES 同步)
    for (const c of SURFACE_CATEGORIES) expect(j.byCategory, `缺 ${c} 键`).toHaveProperty(c);
    expect(Object.keys(j.byCategory).length).toBe(SURFACE_CATEGORIES.length);
    expect(j.byCategory.protocol).toBeGreaterThan(0);
    expect(j.byCategory.config).toBeGreaterThan(0);
    expect(j.byCategory.docs).toBeGreaterThan(0);
    // 命中 file 为根内相对路径(不带 tmp 绝对前缀)
    const files = j.hits.map((h: { file: string }) => h.file);
    expect(files).toContain("packages/protocol/src/x.ts");
    expect(files).toContain("genie.config.json");
    expect(files).toContain("docs/a.md");
    expect(files.every((f: string) => !f.startsWith("/") && !/^[A-Za-z]:/.test(f))).toBe(true);
    const hit = j.hits.find((h: { file: string }) => h.file === "packages/protocol/src/x.ts");
    expect(hit.category).toBe("protocol");
    expect(hit.line).toBeGreaterThan(0);
    expect(typeof hit.suggest).toBe("string");
  }, 60_000);

  it("缺概念词=用法错(exit 2,stderr 给用法,不静默返回空清单)", async () => {
    const cap = capture();
    const code = await runCli(["surface", "--root", root], cap.io);
    expect(code).toBe(2);
    expect(cap.err()).toContain("用法: codesense surface");
  }, 60_000);

  it("零命中=exit 1(与 refs 一致:空结果不当成功)", async () => {
    const cap = capture();
    const code = await runCli(["surface", "noSuchConceptZzz", "--root", root, "--json"], cap.io);
    expect(code).toBe(1);
    const j = JSON.parse(cap.out());
    expect(j.hits.length).toBe(0);
  }, 60_000);
});
