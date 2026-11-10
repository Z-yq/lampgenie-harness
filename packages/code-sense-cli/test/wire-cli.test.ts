/**
 * CLI smoke:wire --json 可解析且字段齐全(真实本仓只读扫描;不建索引)。
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

describe("CLI wire", () => {
  it("wire --json:可解析、union/types/orphans/stats 字段齐全", async () => {
    const cap = capture();
    const code = await runCli(["wire", "--root", ROOT, "--json"], cap.io);
    expect(cap.err()).toBe("");
    expect(code).toBe(0);
    const j = JSON.parse(cap.out());
    expect(j.query).toBe("wire");
    expect(Array.isArray(j.unions)).toBe(true);
    expect(j.unions.length).toBeGreaterThanOrEqual(2);
    expect(j.stats.uniqueTypes).toBeGreaterThan(100);
    expect(Array.isArray(j.types)).toBe(true);
    expect(j.orphans).toBeTruthy();
    expect(Array.isArray(j.orphans.declaredNoHandler)).toBe(true);
    expect(Array.isArray(j.orphans.handlerUndeclared)).toBe(true);
    expect(Array.isArray(j.orphans.sendUndeclared)).toBe(true);
    expect(Array.isArray(j.orphans.declaredNeverSent)).toBe(true);
    expect(Array.isArray(j.knownLimits)).toBe(true);
  }, 120_000);

  it("wire(人类面):按 union 分组 + 孤儿段", async () => {
    const cap = capture();
    const code = await runCli(["wire", "--root", ROOT], cap.io);
    expect(code).toBe(0);
    expect(cap.out()).toContain("[ClientMessage]");
    expect(cap.out()).toContain("孤儿");
    expect(cap.out()).toContain("已知边界");
  }, 120_000);
});
