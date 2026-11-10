/**
 * CLI smoke:refs 字面量引用面(--json 可解析 + 人类面分组 + --no-docs)。
 * 用本仓真实目标 graph 只读扫描(不建索引;所属符号读现成索引,缺席留空)。
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { runCli, type CliIo } from "../src/cli.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function capture(): { io: CliIo; out: () => string; err: () => string } {
  const o: string[] = [];
  const e: string[] = [];
  return {
    io: { out: (s) => (o.push(s), undefined), err: (s) => (e.push(s), undefined) },
    out: () => o.join("\n"),
    err: () => e.join("\n"),
  };
}

describe("CLI refs", () => {
  it("refs graph --json:语境分组 + file:line + 代码/测试/文档统计", async () => {
    const cap = capture();
    const code = await runCli(["refs", "graph", "--root", ROOT, "--json"], cap.io);
    expect(code).toBe(0);
    const j = JSON.parse(cap.out());
    expect(j.query).toBe("refs");
    expect(j.literal).toBe("graph");
    expect(j.totals.code).toBeGreaterThan(0);
    expect(j.totals.test).toBeGreaterThan(0);
    expect(j.totals.doc).toBeGreaterThan(0);
    expect(Array.isArray(j.nextSteps)).toBe(true);
    // 行号不写死(文件增删行会让 328/345 这类锚点过期):按 file+context 断言命中形态,
    // 行号只要求 >0(引用面仍带 file:line)。
    const hit = (file: string, context: string) =>
      j.hits.find((h: { file: string; line: number; context: string }) => h.file === file && h.context === context);
    const eq = hit("apps/gateway/src/sense-index-manager.ts", "eq-literal");
    const str = hit("apps/gateway/src/sense-index-manager.ts", "string-literal");
    expect(eq?.line).toBeGreaterThan(0);
    expect(str?.line).toBeGreaterThan(0);
    expect(j.hits.some((h: { file: string; context: string }) => h.file === "apps/gateway/src/sense-tool.ts" && h.context === "object-key")).toBe(true);
  }, 120_000);

  it("refs(人类面):按语境分组 + 统计 + 建议下一步", async () => {
    const cap = capture();
    const code = await runCli(["refs", "graph", "--root", ROOT], cap.io);
    expect(code).toBe(0);
    const text = cap.out();
    expect(text).toContain('codesense refs "graph"');
    expect(text).toContain("[eq-literal]");
    expect(text).toContain("[object-key]");
    expect(text).toContain("[doc]");
    expect(text).toContain("统计: 代码");
    expect(text).toContain("建议下一步:");
    expect(text).toContain("已知边界");
  }, 120_000);

  it("--no-docs 关闭文档面;缺字面量=用法错(exit 2)", async () => {
    const cap = capture();
    const code = await runCli(["refs", "graph", "--root", ROOT, "--json", "--no-docs"], cap.io);
    expect(code).toBe(0);
    const j = JSON.parse(cap.out());
    expect(j.totals.doc).toBe(0);
    expect(j.filtered.docs).toBeGreaterThan(0);

    const bad = capture();
    const badCode = await runCli(["refs"], bad.io);
    expect(badCode).toBe(2);
    expect(bad.err()).toContain("用法: codesense refs");
  }, 120_000);
});
