import { AGENT_WIRING_SRC } from "./panel-source.js";
/**
 * 权限 guard 链 + session-always 的接线测试(apps/gateway 侧)。
 * 两类断言:
 * ① 静态:agent-wiring.ts 确实在**两处** ask 决策前接入 decidePermission,且审计名固定
 * (permission.guard)——防止后续重构把接线删掉却测试全绿。
 * ② 行为:decidePermission 的三种结局(deny 直拒 / always 放行 / ask 交回)与审计落账,
 * 以及 env GENIE_NO_ALWAYS_ALLOW=1 的「不写不命中」。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MemoryJournal } from "@lampgenie/core";
import {
  clearSessionAlways,
  decidePermission,
  noAlwaysAllowEnabled,
  permissionAlwaysKey,
  rememberSessionAlways,
  sessionAlwaysStoreForTests,
  setPermissionGuards,
} from "../src/agent-wiring.js";
import type { Guard } from "@lampgenie/runtime/agent/permission-guard";

const SRC = AGENT_WIRING_SRC;
const countOf = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

function denyGuard(id: string, reason: string): Guard {
  return { id, check: () => ({ verdict: "deny", reason }) };
}
function abstainGuard(id: string): Guard {
  return { id, check: () => ({ verdict: "abstain" }) };
}

function guardEvents(j: MemoryJournal): { type?: string; tool?: string; source?: string; guardId?: string; reasons?: string[] }[] {
  return j.readAll()
    .filter((e) => e.kind === "custom" && (e.payload as { type?: string })?.type === "permission.guard")
    .map((e) => e.payload as { type?: string; tool?: string; source?: string; guardId?: string; reasons?: string[] });
}

describe("接线静态断言(两处 ask 决策前接入)", () => {
  it("从 runtime 的 permission-guard 模块导入 evaluatePermission(别名)与 SessionAlwaysStore", () => {
    expect(SRC).toContain('from "@lampgenie/runtime/agent/permission-guard"');
    expect(SRC).toContain("evaluatePermission as evaluatePermissionGuard");
    expect(SRC).toContain("SessionAlwaysStore");
  });

  it("decidePermission 共三处调用(主 loop onAsk 1 + 子代理 permission-ask 2 条重复 handler)", () => {
 // 子代理链在 agent-wiring 里有 bg/前台两份逐字相同的 permission-ask handler:
 // 只改一份 = 另一条路径静默绕过 guard(等于放宽),所以两份都必须接。
    expect(countOf(SRC, "const guardEv = decidePermission(")).toBe(3);
  });

  it("两处调用点都在 ask 决策之前:主 loop panelAsk 与子代理 applyDecision 附近", () => {
    const mainAt = SRC.indexOf("const guardEv = decidePermission(");
    const subAt = SRC.lastIndexOf("const guardEv = decidePermission(");
    expect(mainAt).toBeGreaterThan(0);
    expect(subAt).toBeGreaterThan(mainAt);
 // 主 loop:guard 判定在 brokerRef.ask 之前
    expect(mainAt).toBeLessThan(SRC.indexOf("await brokerRef.ask(", mainAt));
 // 子代理:guard 判定在三级决策(env 开关)之前
    expect(subAt).toBeLessThan(SRC.indexOf('process.env.GENIE_SUBAGENT_ASK === "allow-once"', subAt));
  });

  it("审计事件名固定 permission.guard,payload 带 guardId 与 reasons", () => {
    expect(SRC).toContain('type: "permission.guard"');
    expect(SRC).toContain("guardId: guardIds.join");
    expect(SRC).toContain("reasons: ev.denyReasons");
  });

  it("always 命中走既有 applyDecision(allow-once, session-always)路径;deny 不咨询面板", () => {
    expect(SRC).toContain('applyDecision("allow-once", "session-always")');
    expect(SRC).toContain('applyDecision("reject", "guard-denied")');
 // deny 分支必须在 permissionBroker.ask 之前 return(不咨询)
    const denyAt = SRC.lastIndexOf('applyDecision("reject", "guard-denied")');
    expect(SRC.slice(denyAt, denyAt + 200)).toContain("return;");
  });
});

describe("decidePermission 行为", () => {
  beforeEach(() => {
    setPermissionGuards([]);
    clearSessionAlways();
    delete process.env.GENIE_NO_ALWAYS_ALLOW;
  });
  afterEach(() => {
    setPermissionGuards([]);
    clearSessionAlways();
    delete process.env.GENIE_NO_ALWAYS_ALLOW;
  });

  it("空链 + 空存储 → ask/source=mode(零行为变化),不落审计", () => {
    const j = new MemoryJournal();
    const ev = decidePermission({ tool: "file.write", summary: "写 a", sessionId: "s1", journal: j });
    expect(ev.effect).toBe("ask");
    expect(ev.source).toBe("mode");
    expect(guardEvents(j)).toEqual([]);
  });

  it("guard deny → deny/guard,落 permission.guard 审计(guardId + reasons)", () => {
    setPermissionGuards([denyGuard("ro-write", "只读会话禁写"), abstainGuard("other")]);
    const j = new MemoryJournal();
    const ev = decidePermission({ tool: "file.write", summary: "写 a", sessionId: "s1", journal: j });
    expect(ev.effect).toBe("deny");
    expect(ev.source).toBe("guard");
    const g = guardEvents(j);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ tool: "file.write", source: "guard", guardId: "ro-write", reasons: ["ro-write: 只读会话禁写"] });
  });

  it("guard abstain → 仍 ask,不落审计", () => {
    setPermissionGuards([abstainGuard("soft")]);
    const j = new MemoryJournal();
    const ev = decidePermission({ tool: "file.write", summary: "写 a", sessionId: "s1", journal: j });
    expect(ev.effect).toBe("ask");
    expect(guardEvents(j)).toEqual([]);
  });

  it("guard 抛错 → deny(fail-closed),调用方不抛", () => {
    setPermissionGuards([{ id: "boom", check: () => { throw new Error("bad"); } }]);
    const j = new MemoryJournal();
    const ev = decidePermission({ tool: "file.write", summary: "写 a", sessionId: "s1", journal: j });
    expect(ev.effect).toBe("deny");
  });

  it("session-always 命中 → allow/source=always,落审计", () => {
    const j = new MemoryJournal();
    expect(rememberSessionAlways("s1", "file.write", "写 a", "r1")).toBe(true);
    const ev = decidePermission({ tool: "file.write", summary: "写 a", sessionId: "s1", journal: j });
    expect(ev.effect).toBe("allow");
    expect(ev.source).toBe("always");
    expect(guardEvents(j)[0]).toMatchObject({ source: "always", effect: "allow" });
  });

  it("remember 与 decidePermission 用同一键(工具|摘要),摘要不同即不命中", () => {
    rememberSessionAlways("s1", "file.write", "写 a");
    const j = new MemoryJournal();
    expect(decidePermission({ tool: "file.write", summary: "写 a", sessionId: "s1", journal: j }).effect).toBe("allow");
    expect(decidePermission({ tool: "file.write", summary: "写 b", sessionId: "s1", journal: j }).effect).toBe("ask");
    expect(permissionAlwaysKey("file.write", "写 a")).toBe("file.write|写 a");
  });

  it("会话隔离:同 key 另一会话不命中", () => {
    rememberSessionAlways("s1", "file.write", "写 a");
    const j = new MemoryJournal();
    expect(decidePermission({ tool: "file.write", summary: "写 a", sessionId: "s2", journal: j }).effect).toBe("ask");
  });

  it("GENIE_NO_ALWAYS_ALLOW=1 → remember 拒写、lookup 恒 miss(ask)", () => {
    process.env.GENIE_NO_ALWAYS_ALLOW = "1";
    expect(noAlwaysAllowEnabled()).toBe(true);
    expect(rememberSessionAlways("s1", "file.write", "写 a")).toBe(false);
    expect(sessionAlwaysStoreForTests().stats().entries).toBe(0);
    const j = new MemoryJournal();
    expect(decidePermission({ tool: "file.write", summary: "写 a", sessionId: "s1", journal: j }).effect).toBe("ask");
  });

  it("deny 优先于已命中的 session-always(收窄不能被打回)", () => {
    rememberSessionAlways("s1", "file.write", "写 a");
    setPermissionGuards([denyGuard("ro", "禁写")]);
    const j = new MemoryJournal();
    const ev = decidePermission({ tool: "file.write", summary: "写 a", sessionId: "s1", journal: j });
    expect(ev.effect).toBe("deny");
    expect(ev.source).toBe("guard");
  });

  it("clearSessionAlways(sessionId) 后不再命中", () => {
    rememberSessionAlways("s1", "file.write", "写 a");
    clearSessionAlways("s1");
    const j = new MemoryJournal();
    expect(decidePermission({ tool: "file.write", summary: "写 a", sessionId: "s1", journal: j }).effect).toBe("ask");
  });
});
