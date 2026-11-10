/**
 * depth 参数测试(2026-10-15 二期):--depth N=关系遍历层数上限。
 * ①工具面 schema 向后兼容(可选参数,file/graph 工具不加);
 * ②缺省(不给 depth)=现行为逐字节(无 d 标注、无 depth 字段);
 * ③depth=1 vs depth=2 差异:多层链 alphaHelper ← alphaTrunk ← mainEntry 上,
 *   d2 才出现 mainEntry(间接调用方),文本带 (d2) 标注、json 带 depth 字段;
 * ④graph 渲染:d2 出现 mainEntry 节点+边带 d 标注;缺省与显式 depth=1 均无标注;
 * ⑤非法 depth(0/非整数)被工具面与 CLI 双闸拒绝。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildC2fIndex, saveIndex } from "@lampgenie/code-sense";
import { createCodeIndexMcp, parseDepthArg, type CodeIndexMcp } from "../src/mcp-core.js";
import { runCli, type CliIo } from "../src/cli.js";

let ws = "";
let mcp: CodeIndexMcp;
let fakeHome = "";

function capture(): { io: CliIo; out: () => string; err: () => string } {
  const o: string[] = [];
  const e: string[] = [];
  return {
    io: { out: (s2) => (o.push(s2), undefined), err: (s2) => (e.push(s2), undefined) },
    out: () => o.join("\n"),
    err: () => e.join("\n"),
  };
}

const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

beforeAll(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), "csdhome-"));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  ws = mkdtempSync(join(tmpdir(), "csdepth-"));
  mkdirSync(join(ws, "src"), { recursive: true });
  writeFileSync(join(ws, "src", "chain.ts"), [
    "export function alphaHelper(x: number): number { return x + 1; }",
    "export function alphaTrunk(): number { return alphaHelper(1); }",
    "export function mainEntry(): number { return alphaTrunk() + 1; }",
    "",
  ].join("\n"));
  saveIndex(ws, await buildC2fIndex(ws));
  mcp = createCodeIndexMcp(ws, { autoBuild: false });
}, 180_000);

afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
}, 60_000);

describe("MCP 工具面:depth 可选参数(向后兼容)", () => {
  it("schema:symbol 带可选 depth;file/entrypoints 不带;graph/filegraph 已移出工具面(2026-10-21 E③)", () => {
    const tools = mcp.tools as Array<{ name: string; inputSchema: { properties: Record<string, unknown>; required: string[] } }>;
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const n of ["code_index_symbol"]) {
      expect(byName.get(n)!.inputSchema.properties.depth).toBeDefined();
      expect(byName.get(n)!.inputSchema.required).not.toContain("depth"); // 可选=向后兼容
    }
    for (const n of ["code_index_file", "code_index_entrypoints"]) {
      expect(byName.get(n)!.inputSchema.properties.depth).toBeUndefined();
    }
    // mermaid 图类移出 MCP agent 面(给人看走 CLI symbol --graph/file --graph);
    // 分派处理器保留(直调仍出图,required 校验按 ALL_TOOLS 不受影响)
    expect(byName.has("code_index_graph")).toBe(false);
    expect(byName.has("code_index_filegraph")).toBe(false);
    expect(text(mcp.dispatchTool("code_index_graph", { name: "alphaTrunk" })).toLowerCase()).toContain("graph");
  });

  it("缺省(不给 depth)=现行为:无 d 标注、无 depth= 尾注", () => {
    const out = text(mcp.dispatchTool("code_index_symbol", { name: "alphaHelper" }));
    expect(out).toContain("alphaTrunk@src/chain.ts:2");
    expect(out).not.toContain("(d");
    expect(out).not.toContain("depth=");
    expect(out).not.toContain("mainEntry");
  });

  it("depth=1 vs depth=2 差异:d1 不出现间接层;d2 出现 mainEntry 且带 (d2) 标注", () => {
    const d1 = text(mcp.dispatchTool("code_index_symbol", { name: "alphaHelper", depth: 1 }));
    expect(d1).toContain("alphaTrunk@src/chain.ts:2");
    expect(d1).not.toContain("mainEntry");
    expect(d1).toContain("(depth=1)");
    const d2 = text(mcp.dispatchTool("code_index_symbol", { name: "alphaHelper", depth: 2 }));
    expect(d2).toContain("(d2) mainEntry@src/chain.ts:3");
    expect(d2).toContain("(depth=2)");
    expect(d2).not.toContain("(d3)");
  });

  it("graph:缺省与显式 depth=1 输出一致且无 d 边标注;d2 出现 mainEntry 节点与 d 标注", () => {
    const def = text(mcp.dispatchTool("code_index_graph", { name: "alphaHelper" }));
    const d1 = text(mcp.dispatchTool("code_index_graph", { name: "alphaHelper", depth: 1 }));
    expect(d1).toBe(def);
    expect(def).not.toContain("d1|");
    expect(def).not.toContain("mainEntry");
    const d2 = text(mcp.dispatchTool("code_index_graph", { name: "alphaHelper", depth: 2 }));
    expect(d2).toContain("mainEntry");
    expect(d2).toMatch(/\|\d+ d2\|/); // 边深度标注
  });

  it("parseDepthArg 双闸:缺省 1 不标注;0/-1/1.5/abc 报错", () => {
    expect(parseDepthArg({})).toEqual({ depth: 1, labeled: false });
    expect(parseDepthArg({ depth: 3 })).toEqual({ depth: 3, labeled: true });
    for (const bad of [0, -1, 1.5, "abc"]) {
      const r = parseDepthArg({ depth: bad });
      expect("error" in r).toBe(true);
    }
    const dispatched = mcp.dispatchTool("code_index_symbol", { name: "alphaHelper", depth: 0 });
    expect(dispatched.isError).toBe(true);
  });
});

describe("CLI --depth 透传", () => {
  it("symbol --depth 2 --json:callers 带 depth 字段;缺省 json 形态无 depth 字段(向后兼容)", async () => {
    process.chdir(ws);
    const r = capture();
    expect(await runCli(["symbol", "alphaHelper", "--depth", "2", "--json"], r.io)).toBe(0);
    const j = JSON.parse(r.out());
    expect(j.depth).toBe(2);
    expect(j.hits[0].callers).toEqual([
      expect.objectContaining({ name: "alphaTrunk", depth: 1 }),
      expect.objectContaining({ name: "mainEntry", depth: 2 }),
    ]);
    const def = capture();
    expect(await runCli(["symbol", "alphaHelper", "--json"], def.io)).toBe(0);
    const dj = JSON.parse(def.out());
    expect(dj.depth).toBeUndefined();
    expect(dj.hits[0].callers[0].depth).toBeUndefined();
    expect(dj.hits[0].callers).toHaveLength(1); // 只有直接调用方
  }, 120_000);

  it("callers --depth 2 文本含 (d2) 间接层;--depth 0 exit 2", async () => {
    process.chdir(ws);
    const t = capture();
    expect(await runCli(["callers", "alphaHelper", "--depth", "2"], t.io)).toBe(0);
    expect(t.out()).toContain("mainEntry@src/chain.ts:3 (d2)");
    const bad = capture();
    expect(await runCli(["symbol", "alphaHelper", "--depth", "0"], bad.io)).toBe(2);
    expect(bad.err()).toContain("≥1");
  }, 120_000);
});
