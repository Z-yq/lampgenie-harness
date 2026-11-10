/**
 * wire --changed 精度(fixture + 本仓真实工作区):
 *  - fixture:只新增 1 条消息 → 精确报 1 条;只删除 1 条 → 精确报 1 条。
 *    旧实现按 changed 行收集大写标识符,union 成员数组行含全部声明名,任意一次协议改动
 *    都会把整条 union 报成 changed(fixture 实测 4 types、真实仓 153 types)。
 *  - 真实仓:工作区当前有大量未提交改动,故不断言 0;断言「不是整条 ClientMessage 全量」,
 *    并核对 stats 与过滤后的集合一致(干净工作区时应为 0)。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { scanWire } from "../src/wire/index.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE_DIRS: string[] = [];

type Msg = [decl: string, type: string];

function protocolText(msgs: Msg[]): string {
  return [
    'import { z } from "zod";',
    "const Envelope = z.object({ v: z.literal(1) });",
    ...msgs.map(([decl, type]) => `export const ${decl} = Envelope.extend({ type: z.literal("${type}"), payload: z.object({}) });`),
    `export const ClientMessage = z.discriminatedUnion("type", [${msgs.map(([decl]) => decl).join(", ")}]);`,
    "",
  ].join("\n");
}

function serverText(msgs: Msg[]): string {
  return [
    "export function handle(msg: { type: string }): number {",
    "  switch (msg.type) {",
    ...msgs.flatMap(([, type], i) => [`    case "${type}":`, `      return ${i + 1};`]),
    "    default:",
    "      return 0;",
    "  }",
    "}",
    "",
  ].join("\n");
}

const BASELINE: Msg[] = [["Ping", "ping"], ["TrackView", "track.view"], ["OldMsg", "old.msg"]];

function git(dir: string, args: string[]): void {
  execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "pipe", "pipe"] });
}

function writeFixture(msgs: Msg[]): string {
  const dir = mkdtempSync(join(tmpdir(), "codesense-wire-changed-"));
  FIXTURE_DIRS.push(dir);
  const p = join(dir, "packages/protocol/src/index.ts");
  const s = join(dir, "apps/gateway/src/server.ts");
  mkdirSync(dirname(p), { recursive: true });
  mkdirSync(dirname(s), { recursive: true });
  writeFileSync(p, protocolText(msgs));
  writeFileSync(s, serverText(msgs));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "fixture@example.com"]);
  git(dir, ["config", "user.name", "fixture"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "baseline"]);
  return dir;
}

function overwrite(dir: string, msgs: Msg[]): void {
  writeFileSync(join(dir, "packages/protocol/src/index.ts"), protocolText(msgs));
  writeFileSync(join(dir, "apps/gateway/src/server.ts"), serverText(msgs));
}

afterEach(() => {
  for (const d of FIXTURE_DIRS.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败不影响断言 */
    }
  }
});

describe("wire --changed:type 字面量集合 diff", () => {
  it("只新增 1 条消息 → 精确报 1 条(不是整条 union)", () => {
    const dir = writeFixture(BASELINE);
    overwrite(dir, [...BASELINE, ["HelloWorld", "hello.world"]]);
    const r = scanWire(dir, { changed: true });
    const c = r.changed!;
    expect(c.filtered).toBe(true);
    expect(c.added).toEqual(["hello.world"]);
    expect(c.removed).toEqual([]);
    expect(c.touched).toEqual([]);
    expect(c.types).toEqual(["hello.world"]);
    expect(r.types.map((t) => t.type)).toEqual(["hello.world"]);
    // stats 按过滤后的集合计算(旧口径仍是全量 4 memberships/3 handlers)
    expect(r.stats.uniqueTypes).toBe(1);
    expect(r.stats.handlers).toBe(1);
    expect(r.stats.unions).toBe(1);
    expect(r.stats.memberships).toBe(1);
  });

  it("只删除 1 条消息 → 精确报 1 条", () => {
    const dir = writeFixture(BASELINE);
    overwrite(dir, BASELINE.filter(([, type]) => type !== "old.msg"));
    const r = scanWire(dir, { changed: true });
    const c = r.changed!;
    expect(c.added).toEqual([]);
    expect(c.removed).toEqual(["old.msg"]);
    expect(c.touched).toEqual([]);
    expect(c.types).toEqual(["old.msg"]);
    // 删除项的 type 已不在当前协议结构里(rows 为空),但 removed 仍如实列出
    expect(r.types).toEqual([]);
    expect(r.stats.uniqueTypes).toBe(0);
    expect(r.stats.handlers).toBe(0);
  });

  it("真实仓:--changed 不是整条 ClientMessage 全量(工作区脏,干净时应为 0)", () => {
    const full = scanWire(ROOT);
    const r = scanWire(ROOT, { changed: true });
    const c = r.changed!;
    const clientMembers = full.unions.find((u) => u.name === "ClientMessage")?.members.length ?? 0;
    expect(clientMembers).toBeGreaterThan(100);
    // 旧实现实测 153 types(≈整条 ClientMessage);新实现只报字面量真实增删改的行
    expect(c.types.length).toBeLessThan(clientMembers);
    expect(c.types).toEqual([...new Set([...c.added, ...c.removed, ...c.touched])].sort());
    expect(r.stats.uniqueTypes).toBe(r.types.length);
    expect(r.stats.handlers).toBeLessThanOrEqual(full.stats.handlers);
  }, 120_000);
});
