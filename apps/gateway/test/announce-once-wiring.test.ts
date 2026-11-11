import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**  wiring:loop.ts 的 systemSectionDelta 必须走 announce-once 判定并落 runtime.announce。
 * 两条路径:①读源码断言接入点(防「纯逻辑写了但没接线」);②纯逻辑路径(直接跑 announce-once
 * 的 first→already-announced→after-compact 判定,确保网关侧口径与单测一致)。 */

const src = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");
const LOOP_SRC = src("../../../packages/harness-runtime/src/agent/loop.ts");

describe("loop.ts 接入 announce-once(源码断言)", () => {
  it("import 了 shouldAnnounce / markAnnounced / stableHash", () => {
    expect(LOOP_SRC).toMatch(/import\s*\{[^}]*shouldAnnounce[^}]*\}\s*from\s*"\.\/announce-once"/);
    expect(LOOP_SRC).toMatch(/import\s*\{[^}]*markAnnounced[^}]*\}\s*from\s*"\.\/announce-once"/);
    expect(LOOP_SRC).toMatch(/import\s*\{[^}]*stableHash[^}]*\}\s*from\s*"\.\/announce-once"/);
  });

  it("systemSectionDelta 内以 kind=system-section-update + stableHash(block) 调 shouldAnnounce", () => {
    const start = LOOP_SRC.indexOf("private async systemSectionDelta");
    expect(start).toBeGreaterThan(-1);
    const body = LOOP_SRC.slice(start, LOOP_SRC.indexOf("private async runModelScoring"));
    expect(body).toContain("shouldAnnounce({");
    expect(body).toContain('kind: "system-section-update"');
    expect(body).toContain("payloadHash: stableHash(block)");
  });

  it("announce=false → 返回空串(本轮零追加,与「无节变化」同路径)", () => {
    const start = LOOP_SRC.indexOf("private async systemSectionDelta");
    const body = LOOP_SRC.slice(start, LOOP_SRC.indexOf("private async runModelScoring"));
    expect(body).toMatch(/if\s*\(!decision\.ok\s*\|\|\s*!decision\.announce\)\s*return\s*""/);
  });

  it("公告落 custom 事件(payload 来自 markAnnounced,带 runtime.announce 标记)", () => {
    const start = LOOP_SRC.indexOf("private async systemSectionDelta");
    const body = LOOP_SRC.slice(start, LOOP_SRC.indexOf("private async runModelScoring"));
    expect(body).toContain("markAnnounced(journal.readSession(sessionId)");
    expect(body).toMatch(/kind:\s*"custom"/);
    expect(body).toContain("payload: ev.payload");
    expect(body).toContain("runtime.announce.");
 // runtime.announce 是 announce-once 的常量,不在 loop 里硬编码字面 payload.type
    expect(LOOP_SRC).not.toContain('type: "runtime.announce"');
  });

  it("落账失败不阻断注入(catch 放行)", () => {
    const start = LOOP_SRC.indexOf("private async systemSectionDelta");
    const body = LOOP_SRC.slice(start, LOOP_SRC.indexOf("private async runModelScoring"));
    expect(body).toMatch(/catch\s*\{[^}]*\}[^}]*return block/);
  });
});

describe("announce-once 纯路径(网关侧口径)", () => {
  it("A→B→C→B 闭环:first → already-announced → after-compact → already-announced", async () => {
    const mod = await import("../../../packages/harness-runtime/src/agent/announce-once");
    const payloadHash = mod.stableHash("[系统提示更新] agents-md");
    const input = { sessionId: "wiring", kind: "system-section-update", payloadHash } as const;

    const first = mod.shouldAnnounce({ ...input, events: [] });
    expect(first).toMatchObject({ ok: true, announce: true, reason: "first" });

    const recorded = mod.markAnnounced([], "wiring", { kind: input.kind, key: first.key, at: 10 });
    expect(recorded).toHaveLength(1);
    const second = mod.shouldAnnounce({ ...input, events: recorded });
    expect(second).toMatchObject({ ok: true, announce: false, reason: "already-announced" });

    const compacted = [...recorded, { seq: 2, kind: "compact.done", sessionId: "wiring", payload: { summary: "摘要" } }];
    const third = mod.shouldAnnounce({ ...input, events: compacted });
    expect(third).toMatchObject({ ok: true, announce: true, reason: "after-compact" });

    const reAnnounced = mod.markAnnounced(compacted, "wiring", { kind: input.kind, key: third.key, at: 20 });
    expect(reAnnounced).toHaveLength(1);
    const fourth = mod.shouldAnnounce({ ...input, events: [...compacted, ...reAnnounced] });
    expect(fourth).toMatchObject({ ok: true, announce: false, reason: "already-announced" });
  });

  it("未知 kind 在网关侧同样判 INVALID(不抛)", async () => {
    const mod = await import("../../../packages/harness-runtime/src/agent/announce-once");
    const r = mod.shouldAnnounce({ events: [], sessionId: "wiring", kind: "bogus", payloadHash: "h" });
    expect(r.ok).toBe(false);
    expect(r.key).toBe(mod.INVALID);
  });
});
