/**
 * code_sense file/symbol miss 的可操作回执(2026-11-08,7700 审计修复)。
 *
 * 背景:最近 3.5 天 44 次未命中里,23 次 file miss 有 15 次是「文件真实存在、只是索引没收录」
 * (索引 8 天未重建 / panel.ts 超解析守卫),旧回执统一是「文件无索引符号」——模型只能换关键词硬撞。
 * 新契约:
 *  - 构建期被跳过的文件 → 带原因 + refs/grep 出路;
 *  - 文件存在但晚于索引构建 → 明说「索引滞后」+ 重建中;
 *  - symbol/impact miss → 附一行「N 个文件未进索引」注记;
 *  - 确实查无此文件 → 保持原文案(不编造)。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatQuery } from "../src/sense-index-manager.js";
import type { C2fIndex, C2fNode } from "@lampgenie/code-sense";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sense-miss-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function mkNode(partial: Partial<C2fNode> & { id: string; name: string; file: string; line: number }): C2fNode {
  return { kind: "regular", outCount: 0, inCount: 0, ...partial };
}

function mkIndex(partial: Partial<C2fIndex>): C2fIndex {
  return {
    version: 1,
    root: "/tmp/fake-root",
    gitHead: "test",
    builtAt: 0,
    buildMs: 0,
    nodes: [],
    edges: [],
    byFile: {},
    byName: {},
    ...partial,
  } as C2fIndex;
}

describe("formatQuery file miss 可操作回执", () => {
  it("构建期被解析守卫跳过的文件:带原因 + refs/grep 出路", () => {
    const index = mkIndex({
      root: "/tmp/fake-root",
      builtAt: Date.now(),
      skippedFiles: [{ rel: "apps/gateway/src/panel.ts", reason: "超大单文件 2.2MB > 4MB 解析上限" }],
    });
    const out = formatQuery(index, "file", "apps/gateway/src/panel.ts");
    expect(out).toContain("文件未进索引");
    expect(out).toContain("超大单文件");
    expect(out).toContain("action=refs");
    expect(out).not.toContain("文件无索引符号");
  });

  it("文件存在但晚于索引构建:明说索引滞后(不让模型以为文件不存在)", () => {
    const r = tmp();
    mkdirSync(join(r, "src"), { recursive: true });
    writeFileSync(join(r, "src", "new.ts"), "export const x = 1;\n");
    const index = mkIndex({ root: r, builtAt: Date.now() - 60_000 });
    const out = formatQuery(index, "file", "src/new.ts");
    expect(out).toContain("文件存在但未进索引");
    expect(out).toContain("索引已滞后");
  });

  it("确实查无此文件:保持原文案(不编造原因)", () => {
    const r = tmp();
    const index = mkIndex({ root: r, builtAt: Date.now() - 60_000 });
    const out = formatQuery(index, "file", "src/nope.ts");
    expect(out).toBe("文件无索引符号: src/nope.ts");
  });

  it("symbol miss:附「N 个文件未进索引」注记(非空索引时)", () => {
    const index = mkIndex({
      root: "/tmp/fake-root",
      builtAt: Date.now(),
      nodes: [mkNode({ id: "src/a.ts#A", name: "A", file: "src/a.ts", line: 1 })],
      skippedFiles: [{ rel: "panel.ts", reason: "超大" }],
    });
    const out = formatQuery(index, "symbol", "cvRenderMode");
    expect(out).toContain("未找到符号");
    expect(out).toContain("1 个文件因解析守卫未进索引");
    expect(out).toContain("action=refs");
  });

  it("symbol-less 文件:说「已索引但无函数/类声明」,不再误报文件不存在", () => {
    const index = mkIndex({
      root: "/tmp/fake-root",
      builtAt: Date.now(),
      fileStatus: { "src/barrel.ts": { status: "symbol-less" }, "src/boot.ts": { status: "symbol-less" } },
    });
    const out = formatQuery(index, "file", "src/barrel.ts");
    expect(out).toContain("文件已索引但无函数/类声明");
    expect(out).toContain("read_file");
    expect(out).not.toContain("文件无索引符号");
  });

  it("error 文件:说「解析失败(已登记)」并给 read_file/refs 出路", () => {
    const index = mkIndex({
      root: "/tmp/fake-root",
      builtAt: Date.now(),
      fileStatus: { "src/bad.ts": { status: "error", reason: "ts-morph 装载失败" } },
    });
    const out = formatQuery(index, "file", "src/bad.ts");
    expect(out).toContain("文件解析失败(已登记)");
    expect(out).toContain("read_file");
  });
});