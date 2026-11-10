import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildC2fIndex, saveIndex, srcFingerprint } from "@lampgenie/code-sense";
import { createCodeIndexMcp, type CodeIndexMcp } from "../src/code-index-core";

// 多仓路由语义回归(修复:此前「第一个就绪仓先到先得」让字母序靠前的仓
// 永久占住服务,其余仓查询恒空——工作区验证 lampgenie-harness 永远轮不到)。
// 夹具=临时工作区两仓,同名文件 src/dup.ts 制造跨仓歧义,预建索引后进程内调工厂。

let ws = "";
let mcp: CodeIndexMcp;

const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

beforeAll(async () => {
  ws = mkdtempSync(join(tmpdir(), "cimcp-"));
  const repos: Record<string, Record<string, string>> = {
    "repo-a": {
      "src/alpha.ts": [
        "export function alphaHelper(x: number): number { return x + 1; }",
        "export function alphaTrunk(): number { return alphaHelper(1); }",
        "",
      ].join("\n"),
      "src/dup.ts": "export function dupSym(): number { return alphaHelper(41); }\n",
    },
    "repo-b": {
      "src/beta.ts": [
        "export function betaHelper(x: number): number { return x * 2; }",
        "export function betaTrunk(): number { return betaHelper(21); }",
        "",
      ].join("\n"),
      "src/dup.ts": "export function dupSym(): number { return betaHelper(2); }\n",
    },
  };
  for (const [name, files] of Object.entries(repos)) {
    const dir = join(ws, name);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
    for (const [f, content] of Object.entries(files)) writeFileSync(join(dir, f), content);
    saveIndex(dir, await buildC2fIndex(dir));
  }
  mcp = createCodeIndexMcp(ws);
}, 180_000);

afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe("code-index MCP 多仓路由", () => {
  it("工具面均带可选 repo 参数(2026-11-06:+surface = 15 件)", () => {
    expect(mcp.tools).toHaveLength(15);
    for (const t of mcp.tools as Array<{ inputSchema: { properties: Record<string, unknown> } }>) {
      expect(t.inputSchema.properties.repo).toBeDefined();
    }
  });

  it("impact:改动影响面清单(签名/闭包/文件/测试一单)", () => {
    const out = text(mcp.dispatchTool("code_index_impact", { name: "alphaTrunk" }));
    expect(out).toContain("改动影响面: alphaTrunk");
    expect(out).toContain("上游调用方");
    expect(out).toContain("受影响文件");
    expect(out).toContain("关联测试");
  });

  it("symbol:跨仓自动路由到正确仓(不再被首个就绪仓占住)", () => {
    const out = text(mcp.dispatchTool("code_index_symbol", { name: "alphaTrunk" }));
    expect(out).toContain("[repo-a]");
    expect(out).toContain("alphaTrunk");
    expect(out).not.toContain("betaHelper");
  });

  it("symbol:同名符号跨仓合并,逐条标注来源仓", () => {
    const out = text(mcp.dispatchTool("code_index_symbol", { name: "dupSym" }));
    expect(out).toContain("[repo-a]");
    expect(out).toContain("[repo-b]");
  });

  it("symbol:repo 参数定向单仓", () => {
    const out = text(mcp.dispatchTool("code_index_symbol", { name: "dupSym", repo: "repo-b" }));
    expect(out).toContain("[repo-b]");
    expect(out).not.toContain("[repo-a]");
  });

  it("symbol:未知仓名显式报错并列出可用仓", () => {
    const out = text(mcp.dispatchTool("code_index_symbol", { name: "dupSym", repo: "ghost" }));
    expect(out).toContain("未知仓");
    expect(out).toContain("repo-a");
  });

  it("file:路径仓前缀路由(剥前缀)", () => {
    const out = text(mcp.dispatchTool("code_index_file", { path: "repo-a/src/alpha.ts" }));
    expect(out).toContain("alphaTrunk");
    expect(out).toContain("(仓: repo-a)");
  });

  it("file:无前缀路径跨仓搜索命中", () => {
    const out = text(mcp.dispatchTool("code_index_file", { path: "src/beta.ts" }));
    expect(out).toContain("betaHelper");
  });

  it("file:跨仓同名文件提示另见,repo 参数消歧", () => {
    const out = text(mcp.dispatchTool("code_index_file", { path: "src/dup.ts" }));
    expect(out).toContain("另见");
    const outB = text(mcp.dispatchTool("code_index_file", { path: "src/dup.ts", repo: "repo-b" }));
    expect(outB).not.toContain("repo-a");
  });

  it("entrypoints:缺省逐仓分组,repo 参数单仓", () => {
    const out = text(mcp.dispatchTool("code_index_entrypoints", {}));
    expect(out).toContain("## repo-a");
    expect(out).toContain("## repo-b");
    const outA = text(mcp.dispatchTool("code_index_entrypoints", { repo: "repo-a" }));
    expect(outA).toContain("alphaTrunk");
    expect(outA).not.toContain("betaTrunk");
  });

  it("graph/filegraph:带仓标注渲染", () => {
    const g = text(mcp.dispatchTool("code_index_graph", { name: "alphaTrunk" }));
    expect(g).toContain("flowchart");
    expect(g).toContain("(仓: repo-a)");
    const fg = text(mcp.dispatchTool("code_index_filegraph", { path: "repo-b/src/beta.ts" }));
    expect(fg).toContain("flowchart");
    expect(fg).toContain("(仓: repo-b)");
  });
});

describe("code-index MCP 空索引诚实降级(2026-10-14:残缺索引不冒充「闭环/库形态」)", () => {
  it("entrypoints/symbol/file 对空索引给显式原因", async () => {
    const dir = join(ws, "repo-c");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "repo-c" }));
    writeFileSync(join(dir, "src", "mod.py"), "def thing():\n    return 1\n");
    const idx = await buildC2fIndex(dir);
    // 手工构残缺空索引(模拟旧版语言缺口产物):带新指纹,落在「空索引自愈」档
    const fp = srcFingerprint(dir);
    saveIndex(dir, { ...idx, nodes: [], edges: [], byFile: {}, byName: {}, srcMtime: fp.maxMtime, srcCount: fp.count });
    const m2 = createCodeIndexMcp(ws);
    const ep = text(m2.dispatchTool("code_index_entrypoints", { repo: "repo-c" }));
    expect(ep).toContain("索引为空");
    expect(ep).not.toContain("闭环/库形态");
    const sym = text(m2.dispatchTool("code_index_symbol", { name: "nope", repo: "repo-c" }));
    expect(sym).toContain("索引全为空");
    const file = text(m2.dispatchTool("code_index_file", { path: "src/mod.py", repo: "repo-c" }));
    expect(file).toContain("索引为空");
  }, 60_000);
});
