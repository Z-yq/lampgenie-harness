/**
 * code_sense action=world:分派 + 执行(进程内读产物,零索引)。
 * 既有 12 动作语义零变化(抽代表动作断言);world 三形态 + 缺产物指路。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchSenseArgs, codeSenseTool, SENSE_ACTIONS } from "../src/sense-tool.js";
import { writeWorldArtifact, writeDrillCorpus } from "@lampgenie/code-sense/world/store";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "sense-world-"));
  const skeleton = "# L0 骨架\n- 主线: 测试仓\n";
  const markdown = "# 模块 alpha-mod\n- 职责: 测试\n";
  writeWorldArtifact(root, {
    skeleton,
    pages: [{ module: "alpha-mod", markdown, bytes: Buffer.byteLength(markdown, "utf8") }],
    fp: { builtAt: 1000 },
    renderMs: 1,
  });
  writeDrillCorpus(root, {
    version: 1,
    indexBuiltAt: 1000,
    modules: [{ name: "alpha-mod", slug: "alpha-mod", dirs: ["alpha-mod/src"], files: ["panel"], symbols: ["doWork"], note: "甲职责" }],
  });
  return root;
}

describe("dispatchSenseArgs:world 追加不改动既有动作", () => {
  it("SENSE_ACTIONS 含 world(末尾追加)", () => {
    expect(SENSE_ACTIONS).toContain("world");
    expect(SENSE_ACTIONS.slice(0, 12)).toEqual(["symbol", "file", "impact", "entrypoints", "project", "wire", "refs", "surface", "vars", "branches", "flow", "radiation"]);
  });
  it("world 空 target 合法(=读 L0)", () => {
    const d = dispatchSenseArgs({ action: "world" });
    expect(d).toMatchObject({ kind: "structural", action: "world", target: "" });
  });
  it("world module: 前缀与文本下钻都走结构面", () => {
    expect(dispatchSenseArgs({ action: "world", target: "module:alpha-mod" })).toMatchObject({ kind: "structural", action: "world", target: "module:alpha-mod" });
    expect(dispatchSenseArgs({ action: "world", target: "改 panel 逻辑" })).toMatchObject({ kind: "structural", action: "world" });
  });
  it("既有动作分派不变(impact/symbol/refs 代表)", () => {
    expect(dispatchSenseArgs({ action: "impact", target: "foo" })).toMatchObject({ kind: "structural", action: "impact", target: "foo" });
    expect(dispatchSenseArgs({ action: "symbol", target: "bar" })).toMatchObject({ kind: "structural", action: "symbol", target: "bar" });
    expect(dispatchSenseArgs({ action: "refs", target: "lit" })).toMatchObject({ kind: "structural", action: "refs", target: "lit" });
    expect(dispatchSenseArgs({ action: "nope" }).kind).toBe("invalid");
  });
});

describe("code_sense action=world 执行( fixture 产物)", () => {
  it("空 target → L0 骨架全文", async () => {
    const t = codeSenseTool(fixture());
    const out = await t.execute({ action: "world" });
    expect(out).toContain("L0 骨架");
  });
  it("module:<名> → 单模块页", async () => {
    const t = codeSenseTool(fixture());
    const out = await t.execute({ action: "world", target: "module:alpha-mod" });
    expect(out).toContain("模块 alpha-mod");
  });
  it("module 不存在 → 列已有模块,不 throw", async () => {
    const t = codeSenseTool(fixture());
    const out = await t.execute({ action: "world", target: "module:nope" });
    expect(out).toContain("没有模块");
    expect(out).toContain("alpha-mod");
  });
  it("文本下钻 → 命中页 + 理由", async () => {
    const t = codeSenseTool(fixture());
    const out = await t.execute({ action: "world", target: "alpha-mod" });
    expect(out).toContain("下钻命中");
    expect(out).toContain("模块 alpha-mod");
  });
  it("零词面命中 → 明说兜底,不灌页", async () => {
    const t = codeSenseTool(fixture());
    const out = await t.execute({ action: "world", target: "zzzqqqxxx" });
    expect(out).toContain("零词面命中");
  });
  it("产物缺失 → 重建指路,不 throw 不自动建", async () => {
    const root = mkdtempSync(join(tmpdir(), "sense-world-empty-"));
    const t = codeSenseTool(root);
    const out = await t.execute({ action: "world" });
    expect(out).toContain("产物缺失");
    expect(out).toContain("world --rebuild");
  });
});
