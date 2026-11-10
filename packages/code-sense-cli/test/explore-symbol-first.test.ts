/**
 * explore / wiki ask 符号优先召回的 CLI 面单测(2026-10-21):
 *  - explore 输出先给「候选符号」块(名称/位置/被谁调/调谁/原因),再给 grep 行命中,
 *    最后给可复制的下一步命令;--json 增 symbols[]/symbolCount/nextSteps(既有字段不删)
 *  - wiki ask 页面零命中时用符号命中兜底(不再只回「无」),--json 带 symbols[]
 * 零命中时仍 exit 1(不装绿)。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCli, type CliIo } from "../src/cli.js";
import { buildC2fIndex, saveIndex } from "@lampgenie/code-sense";

let ws = "";

function capture(): { io: CliIo; out: () => string; err: () => string } {
  const o: string[] = [];
  const e: string[] = [];
  return {
    io: { out: (s) => (o.push(s), undefined), err: (s) => (e.push(s), undefined) },
    out: () => o.join("\n"),
    err: () => e.join("\n"),
  };
}

beforeAll(async () => {
  ws = mkdtempSync(join(tmpdir(), "cs-symfirst-"));
  const files: Record<string, string> = {
    "apps/gateway/src/agent-wiring.ts": [
      "export function gateJournal(): string { return \"g\"; }",
      "export function permissionMode(): string { return \"ask\"; }",
      "export function makeSubagentPermissionAsker(): boolean { return permissionMode().length > 0 && gateJournal().length > 0; }",
      "",
    ].join("\n"),
    "apps/gateway/src/permission-broker.ts": [
      "export class PermissionBroker {",
      "  ask(): boolean { return this.respond(); }",
      "  respond(): boolean { return true; }",
      "}",
      "",
    ].join("\n"),
    "README.md": "# demo\n\n子代理(spawn)把任务派发给 worker;审批回到父会话。\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(ws, rel)), { recursive: true });
    writeFileSync(join(ws, rel), content);
  }
  saveIndex(ws, await buildC2fIndex(ws));
}, 180_000);

afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
}, 60_000);

describe("explore 符号优先(CLI)", () => {
  it("文本面:候选符号块在 grep 命中之前;给出下一步命令", async () => {
    const t = capture();
    const code = await runCli(["explore", "子代理 spawn 权限审批怎么回到父会话", "--root", ws, "--no-color"], t.io);
    expect(code).toBe(0);
    const out = t.out();
    expect(out).toContain("候选符号");
    expect(out).toContain("makeSubagentPermissionAsker");
    expect(out).toContain("原因:");
    expect(out).toContain("下一步");
    expect(out).toContain("codesense symbol makeSubagentPermissionAsker");
    expect(out).toContain("codesense impact makeSubagentPermissionAsker");
    // 符号块必须在 grep 行命中标题之前(符号优先)
    const symIdx = out.indexOf("候选符号");
    const hitIdx = out.indexOf("命中", symIdx);
    expect(symIdx).toBeGreaterThanOrEqual(0);
    expect(hitIdx).toBeGreaterThan(symIdx);
  }, 120_000);

  it("--json:symbols[]/symbolCount/nextSteps 在场;既有 fields 不删", async () => {
    const j = capture();
    const code = await runCli(["explore", "子代理 spawn 权限审批怎么回到父会话", "--root", ws, "--json"], j.io);
    expect(code).toBe(0);
    const json = JSON.parse(j.out()) as {
      query: string; matchCount: number; matches: { file: string }[];
      symbolCount: number; symbols: { name: string; file: string; line: number; reasons: string[]; callers: unknown[]; callees: unknown[] }[];
      nextSteps: string[];
    };
    expect(json.query).toBe("explore");
    expect(typeof json.matchCount).toBe("number");
    expect(Array.isArray(json.matches)).toBe(true);
    expect(json.symbolCount).toBeGreaterThan(0);
    expect(json.symbols[0]!.name).toBe("makeSubagentPermissionAsker");
    expect(json.symbols[0]!.file).toContain("agent-wiring.ts");
    expect(json.symbols[0]!.line).toBeGreaterThan(0);
    expect(Array.isArray(json.symbols[0]!.reasons)).toBe(true);
    expect(json.nextSteps.some((s) => s.includes("codesense symbol makeSubagentPermissionAsker"))).toBe(true);
  }, 120_000);

  it("零命中仍 exit 1(索引符号也不命中时不装绿)", async () => {
    const t = capture();
    const code = await runCli(["explore", "zzzznotexist", "--root", ws, "--no-color"], t.io);
    expect(code).toBe(1);
    expect(t.out()).toContain("零命中");
  }, 120_000);
});

describe("wiki ask 符号兜底(CLI)", () => {
  it("无 wiki 页时不再只回「无」:候选符号兜底 + 下一步命令", async () => {
    const t = capture();
    const code = await runCli(["wiki", "ask", "子代理怎么派发", "--root", ws, "--no-color"], t.io);
    expect(code).toBe(0);
    const out = t.out();
    expect(out).toContain("候选符号");
    expect(out).toContain("makeSubagentPermissionAsker");
    expect(out).toContain("命中页面:");
    expect(out).toContain("(无)"); // 页面确实无命中(诚实)
    expect(out).toContain("下一步");
    expect(out).toContain("codesense symbol makeSubagentPermissionAsker");
  }, 120_000);

  it("--json 带 symbols[](页面/symbolDegraded 字段可用)", async () => {
    const j = capture();
    const code = await runCli(["wiki", "ask", "子代理怎么派发", "--root", ws, "--json"], j.io);
    expect(code).toBe(0);
    const json = JSON.parse(j.out()) as {
      keywords: string[]; pages: unknown[]; matches: unknown[];
      symbols?: { name: string; file: string }[];
    };
    expect(json.keywords.length).toBeGreaterThan(0);
    expect(json.symbols!.length).toBeGreaterThan(0);
    expect(json.symbols!.some((s) => s.file.includes("agent-wiring.ts"))).toBe(true);
  }, 120_000);

  it("零命中(符号也没有):exit 1", async () => {
    const t = capture();
    const code = await runCli(["wiki", "ask", "zzzznotexist", "--root", ws, "--no-color"], t.io);
    expect(code).toBe(1);
  }, 120_000);
});
