import { describe, it, expect } from "vitest";
import { fileSymbolsOf } from "../src/index";
import { buildC2fIndex, saveIndex } from "../src/callgraph/c2f";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("fileSymbolsOf 快路径(静态索引,审计三改接入档案)", () => {
  it("索引在场:毫秒返回符号+调用边(与懒解析同构)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-fsym-"));
    writeFileSync(join(dir, "hub.ts"), [
      "export function hubFn(): number {",
      "  return leafFn() + 1;",
      "}",
      "export function leafFn(): number {",
      "  return 42;",
      "}",
      "export function entry(): number { return hubFn(); }",
    ].join("\n"));
    // 预建索引(快路径前提)
    const idx = await buildC2fIndex(dir);
    saveIndex(dir, idx);
    const t0 = Date.now();
    const r = await fileSymbolsOf(dir, "hub.ts");
    const ms = Date.now() - t0;
    expect(r.symbols.map((s) => s.name).sort()).toEqual(["entry", "hubFn", "leafFn"]);
    const hubEdges = r.edges.filter((e) => e.fromName === "hubFn");
    expect(hubEdges.some((e) => e.toName === "leafFn")).toBe(true);
    expect(r.edges.some((e) => e.fromName === "entry" && e.toName === "hubFn")).toBe(true);
    expect(ms).toBeLessThan(2000); // 快路径毫秒级(慢路径含 ts-morph 初始化 ≥3s)
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
