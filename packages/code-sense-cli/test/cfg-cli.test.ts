/**
 * cfg CLI e2e:函数级控制流图——索引定位/--file 定位/--depth 被调函数/--out 落盘/
 * --json 契约/未命中退出码。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli, type CliIo } from "../src/cli.js";

let ws = "";
let fakeHome = "";
let prevCwd = "";

function capture(): { io: CliIo; out: () => string; err: () => string } {
  const o: string[] = [];
  const e: string[] = [];
  return {
    io: { out: (s) => (o.push(s), undefined), err: (s) => (e.push(s), undefined) },
    out: () => o.join("\n"),
    err: () => e.join("\n"),
  };
}

function writeFiles(base: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(base, rel);
    mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
    writeFileSync(abs, content);
  }
}

beforeAll(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), "cfghome-"));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  ws = mkdtempSync(join(tmpdir(), "cfgcli-"));
  writeFiles(ws, {
    "src/alpha.ts": [
      "/** alpha helper:加上一。 */",
      "export function alphaHelper(x: number): number { return x + 1; }",
      "export function alphaTrunk(n: number): number {",
      "  let total = 0;",
      "  for (let i = 0; i < n; i++) {",
      "    if (i % 2 === 0) {",
      "      total += alphaHelper(i);",
      "    } else {",
      "      total -= 1;",
      "    }",
      "  }",
      "  return total;",
      "}",
      "",
    ].join("\n"),
    "src/legacy.rs": "fn legacy() -> i32 { 1 }\n",
  });
  prevCwd = process.cwd();
}, 60_000);

afterAll(() => {
  process.chdir(prevCwd);
  rmSync(ws, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
}, 60_000);

describe("cfg CLI", () => {
  it("index 后按符号名定位并输出语句级流程", async () => {
    const idx = capture();
    expect(await runCli(["index", "--register", ws], idx.io)).toBe(0);
    const r = capture();
    const code = await runCli(["cfg", "alphaTrunk", "--root", ws], r.io);
    const out = r.out();
    expect(code).toBe(0);
    expect(out).toContain("函数级控制流图");
    expect(out).toContain("alphaHelper"); // 真实调用名出现在语句里
    expect(out).toContain("是");
    expect(out).toContain("职责:");
    expect(out).toContain("输入:");
    expect(out).toContain("输出:");
    expect(out).toContain("关键判断:");
    expect(out).toContain("否");
    expect(out).toContain("循环");
    expect(out).toContain("退出");
    expect(out).toContain("```mermaid");
  }, 30_000);

  it("--json 契约:functions[0] 带 nodes/edges/stats", async () => {
    const r = capture();
    const code = await runCli(["cfg", "alphaTrunk", "--root", ws, "--json"], r.io);
    expect(code).toBe(0);
    const j = JSON.parse(r.out());
    expect(j.query).toBe("cfg");
    expect(j.functions[0].name).toBe("alphaTrunk");
    expect(j.functions[0].stats.decisions).toBeGreaterThanOrEqual(2);
    expect(j.functions[0].description.purposeSource).toBe("signature");
    expect(j.functions[0].description.purpose).toContain("按函数名/签名推断");
    expect(j.functions[0].nodes.some((n: { text: string }) => n.text.includes("alphaHelper"))).toBe(true);
    expect(j.functions[0].edges.some((e: { label?: string }) => e.label === "循环")).toBe(true);
  });

  it("--depth 1 展开同文件被调函数;--file 定向文件", async () => {
    const r = capture();
    const code = await runCli(["cfg", "alphaTrunk", "--root", ws, "--file", "src/alpha.ts", "--depth", "1", "--json"], r.io);
    expect(code).toBe(0);
    const j = JSON.parse(r.out());
    expect(j.functions.length).toBeGreaterThanOrEqual(2);
    expect(j.functions.map((f: { name: string }) => f.name)).toContain("alphaHelper");
    expect(j.functions[0].description.callees.some((c: { name: string }) => c.name === "alphaHelper")).toBe(true);
  });

  it("--out 落盘 mermaid;--full 出完整单图", async () => {
    const out = join(ws, "cfg-out.mmd");
    const r = capture();
    const code = await runCli(["cfg", "alphaTrunk", "--root", ws, "--out", out, "--full"], r.io);
    expect(code).toBe(0);
    expect(existsSync(out)).toBe(true);
    const md = readFileSync(out, "utf8");
    expect(md).toContain("flowchart TD");
    expect(md).toContain("alphaHelper");
  });

  it("未命中=exit 1;不支持/语法错误=可操作提示", async () => {
    const miss = capture();
    expect(await runCli(["cfg", "noSuchFunction", "--root", ws], miss.io)).toBe(1);
    expect(miss.out()).toContain("未找到");

    const unsupported = capture();
    expect(await runCli(["cfg", "legacy", "--root", ws, "--file", "src/legacy.rs"], unsupported.io)).toBe(1);
    expect(unsupported.out()).toContain("语言不支持");
  });
});
