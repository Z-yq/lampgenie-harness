/**
 * CLI e2e(进程内 runCli 全指令):夹具仓 aa/bb/整仓三连 init + 全查询指令 + --json 可解析 +
 * 退出码语义(未命中=1/引导=2)+ remove/根解析。产物全部落临时 HOME/临时目录。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli, type CliIo } from "../src/cli.js";
import { indexDir } from "@lampgenie/code-sense/callgraph/c2f";

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
  fakeHome = mkdtempSync(join(tmpdir(), "cshome-"));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  ws = mkdtempSync(join(tmpdir(), "cse2e-"));
  writeFiles(ws, {
    "aa/src/alpha.ts": 'export function alphaHelper(x: number): number { return x + 1; }\nexport function alphaTrunk(): number { return alphaHelper(1); }\n',
    "bb/src/beta.py": "def beta_helper(x):\n    return x * 2\n\ndef beta_trunk():\n    return beta_helper(21)\n",
    "shared/util.ts": "export function utilAdd(a: number, b: number): number { return a + b; }\n",
    "main.ts": 'import { alphaTrunk } from "./aa/src/alpha";\nimport { utilAdd } from "./shared/util";\nexport function mainEntry(): number {\n  const a = alphaTrunk();\n  return utilAdd(a, 0);\n}\n',
  });
  prevCwd = process.cwd();
}, 60_000);

afterAll(() => {
  process.chdir(prevCwd);
  rmSync(ws, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
}, 60_000);

describe("CLI e2e:管理指令", () => {
  it("index --register aa → 整仓(json 报复用/新扫;收尾批 J:init 已删)", async () => {
    const r1 = capture();
    const code1 = await runCli(["index", "--register", "--json", join(ws, "aa")], r1.io);
    expect(code1).toBe(0);
    const j1 = JSON.parse(r1.out());
    expect(j1.registered).toBe(true);
    expect(j1.mode).toBe("full");

    const r2 = capture();
    const code2 = await runCli(["index", "--register", "--json", ws], r2.io);
    expect(code2).toBe(0);
    const j2 = JSON.parse(r2.out());
    expect(j2.mode).toBe("incremental");
    // aa/src/alpha.ts 被 aa 根认领复用;main/shared/bb(py 走结构 adapter)新扫
    expect(j2.reused).toBe(1);
    expect(j2.nodes).toBeGreaterThanOrEqual(5);
    expect(existsSync(join(ws, ".genie", "sense-index"))).toBe(true);
  }, 300_000);

  it("roots --json 列出已登记根", async () => {
    const r = capture();
    const code = await runCli(["roots", "--json"], r.io);
    expect(code).toBe(0);
    const j = JSON.parse(r.out());
    expect(j.roots.some((e: { root: string }) => e.root === ws)).toBe(true);
  });

  it("remove 注销后 roots 不再含;二次 remove exit 1;--purge 删数据", async () => {
    const r = capture();
    expect(await runCli(["remove", ws, "--purge"], r.io)).toBe(0);
    expect(r.out()).toContain("已注销并删除");
    const r2 = capture();
    expect(await runCli(["remove", ws], r2.io)).toBe(1);
    expect(existsSync(indexDir(ws))).toBe(false); // --purge 删的是 <hash> 数据目录
    // 重新登记供后续查询用例
    expect(await runCli(["index", "--register", "--quiet", ws], capture().io)).toBe(0);
  }, 300_000);

  it("未建索引目录查询给引导文案 exit 2", async () => {
    const stray = mkdtempSync(join(tmpdir(), "csstray-"));
    const prev = process.cwd();
    process.chdir(stray);
    try {
      const r = capture();
      const code = await runCli(["symbol", "whatever"], r.io);
      expect(code).toBe(2);
      expect(r.err()).toContain("index --register");
    } finally {
      process.chdir(prev);
      rmSync(stray, { recursive: true, force: true });
    }
  });
});

describe("CLI e2e:查询指令(--json 可解析+退出码)", () => {
  it("symbol:json 结构命中+文本形态三方同源文案", async () => {
    process.chdir(ws);
    const r = capture();
    const code = await runCli(["symbol", "alphaTrunk", "--json"], r.io);
    expect(code).toBe(0);
    const j = JSON.parse(r.out());
    expect(j.hitCount).toBe(1);
    expect(j.hits[0].symbol.name).toBe("alphaTrunk");
    expect(j.hits[0].callers.map((c: { name: string }) => c.name)).toContain("mainEntry");

    const t = capture();
    const tcode = await runCli(["symbol", "alphaTrunk"], t.io);
    expect(tcode).toBe(0);
    expect(t.out()).toContain("alphaTrunk");
    expect(t.out()).toContain("被调用");
  }, 120_000);

  it("callers/callees:单侧视图 json+文本;未命中 exit 1", async () => {
    process.chdir(ws);
    const r = capture();
    expect(await runCli(["callers", "alphaTrunk", "--json"], r.io)).toBe(0);
    const j = JSON.parse(r.out());
    expect(j.repos[0].definitions[0].callers.map((c: { name: string }) => c.name)).toContain("mainEntry");

    const t = capture();
    expect(await runCli(["callees", "mainEntry"], t.io)).toBe(0);
    expect(t.out()).toContain("调用(");

    const m = capture();
    expect(await runCli(["symbol", "noSuchSymbolAnywhere", "--no-build"], m.io)).toBe(1);
    expect(m.out()).toContain("未找到符号");
  }, 120_000);

  it("entrypoints/file --graph/symbol --graph:json 与文本双形态(收尾批 J:filegraph/graph 已删)", async () => {
    process.chdir(ws);
    const ep = capture();
    expect(await runCli(["entrypoints", "--json"], ep.io)).toBe(0);
    const epj = JSON.parse(ep.out());
    expect(epj.repos[0].entrypoints.map((n: { name: string }) => n.name)).toContain("mainEntry");

    const f = capture();
    expect(await runCli(["file", "aa/src/alpha.ts", "--json"], f.io)).toBe(0);
    const fj = JSON.parse(f.out());
    expect(fj.symbols.length).toBe(2);

    const fg = capture();
    expect(await runCli(["file", "aa/src/alpha.ts", "--graph"], fg.io)).toBe(0);
    expect(fg.out()).toContain("flowchart");

    const g = capture();
    expect(await runCli(["symbol", "mainEntry", "--graph"], g.io)).toBe(0);
    expect(g.out()).toContain("flowchart");

    const py = capture();
    expect(await runCli(["file", "bb/src/beta.py", "--json"], py.io)).toBe(0);
    const pyj = JSON.parse(py.out());
    expect(pyj.symbols.map((s: { name: string }) => s.name)).toContain("beta_trunk");
  }, 120_000);

  it("doctor --json:全部检查可解析且通过", async () => {
    process.chdir(ws);
    const r = capture();
    const code = await runCli(["doctor", "--json"], r.io);
    expect(code).toBe(0);
    const j = JSON.parse(r.out());
    expect(j.ok).toBe(true);
    expect(j.checks.some((c: { name: string }) => c.name === "tree-sitter:python")).toBe(true);
  }, 120_000);
});
