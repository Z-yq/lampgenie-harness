/**
 * 压缩闸门:autoCompactGate 纯函数锚定。
 * 背景(真实 journal 26 次压缩回放):旧判定 used 扫描不认 compact.done 边界 + 基线超阈无检测
 * → 每步重压(锯齿「动不动上下文已压缩」)。
 * 阈值优先序(窗口声明>显式阈值>0.8×缺省窗口 1M)+ 边界识别只认带摘要的 compact.done
 * (旧 microcompact 无摘要 compact.done 不再清零 used)。
 */
import { describe, it, expect } from "vitest";
import { autoCompactGate, DEFAULT_CONTEXT_WINDOW_TOKENS, type GateEvent } from "../src/compact-gate.js";

let seq = 0;
function ev(kind: string, payload: Record<string, unknown> = {}, sid = "s1"): GateEvent {
  return { kind, sessionId: sid, seq: ++seq, payload };
}

describe("autoCompactGate(/058)", () => {
  it("边界感知:最后一次真压缩(compact.done 带摘要)之前的陈旧 usage 不参与判定(锯齿根治)", () => {
    const events: GateEvent[] = [];
    events.push(ev("message.agent", { usage: { inputTokens: 9000 } })); // 压缩前:超阈
    events.push(ev("compact.done", { summary: "x" }));                  // 压缩边界
    events.push(ev("message.agent", { usage: { inputTokens: 900 } }));  // 压缩后:远低于阈
    // 窗口 8192→阈值 6554:陈旧 9000 若被计入会误触发;边界后 900 不触发
    const d = autoCompactGate(events, "s1", 8192, 24000);
    expect(d.used).toBe(900);
    expect(d.fire).toBe(false);
  });

  it("超阈触发:边界后实测 ≥ 窗口 80% 且消息数足够 → fire+force", () => {
    const events: GateEvent[] = [];
    events.push(ev("compact.done", { summary: "x" }));
    for (let i = 0; i < 5; i++) events.push(ev("message.agent", { usage: { inputTokens: 7000 + i } }));
    const d = autoCompactGate(events, "s1", 8192, 24000); // 阈 6554
    expect(d.fire).toBe(true);
    expect(d.force).toBe(true);
    expect(d.threshold).toBe(6554);
  });

  it("基线抑制:刚压完(≤2 条消息)仍 ≥ 阈值 → 不重压,报 baseline(压不动系统提示)", () => {
    const events: GateEvent[] = [];
    events.push(ev("compact.done", { summary: "x" }));
    events.push(ev("message.agent", { usage: { inputTokens: 7000 } }));
    events.push(ev("message.agent", { usage: { inputTokens: 7200 } }));
    const d = autoCompactGate(events, "s1", 8192, 24000);
    expect(d.fire).toBe(false);
    expect(d.baseline).toBe(true);
  });

  it("基线抑制会随消息积累解除:第 3 条起仍超阈则重新 fire(真增长不被误伤)", () => {
    const events: GateEvent[] = [];
    events.push(ev("compact.done", { summary: "x" }));
    events.push(ev("message.agent", { usage: { inputTokens: 7000 } }));
    events.push(ev("message.agent", { usage: { inputTokens: 7200 } }));
    events.push(ev("message.agent", { usage: { inputTokens: 7400 } }));
    expect(autoCompactGate(events, "s1", 8192, 24000).fire).toBe(true);
  });

  it("无 usage 会话:放行给 autoCompact 的 est 二次闸;阈值取窗口 80%", () => {
    const events: GateEvent[] = [ev("message.user", { text: "hi" }), ev("message.agent", { text: "yo" })];
    const d = autoCompactGate(events, "s1", 8192, 24000);
    expect(d.used).toBe(0);
    expect(d.fire).toBe(true);
    expect(d.force).toBe(false);
    expect(d.threshold).toBe(6554);
  });

  it("未配窗口:显式阈值(fallback)兜底生效,force 语义同源", () => {
    const events: GateEvent[] = [];
    events.push(ev("compact.done", { summary: "x" }));
    for (let i = 0; i < 5; i++) events.push(ev("message.agent", { usage: { inputTokens: 25000 } }));
    const d = autoCompactGate(events, "s1", undefined, 24000);
    expect(d.threshold).toBe(24000);
    expect(d.fire).toBe(true);
  });

  it(" 缺省保守:未配窗口且未配阈值 → 0.8×1M=800_000,但受 300_000 绝对封顶(2026-11-03)", () => {
    const events: GateEvent[] = [];
    events.push(ev("compact.done", { summary: "x" }));
    for (let i = 0; i < 5; i++) events.push(ev("message.agent", { usage: { inputTokens: 500_000 } }));
    const d = autoCompactGate(events, "s1", undefined, 0);
    expect(DEFAULT_CONTEXT_WINDOW_TOKENS).toBe(1_000_000);
    // 窗口口径 800_000 被 MAX_COMPACT_TOKENS=300_000 截断:封顶是为治「长会话每步重发全部历史」
    expect(d.threshold).toBe(300_000);
    expect(d.fire).toBe(true); // 50 万 tok 已远超封顶 → 必须压
  });

  it("2026-11-05 封顶口径修订:1M 窗口 + xhigh = 满窗口 966_000(用户:最高档给满窗口);提前压缩档仍封顶 300_000", () => {
    const events: GateEvent[] = [ev("message.agent", { usage: { inputTokens: 1_000 } })];
    expect(autoCompactGate(events, "s1", 1_000_000, 0, undefined, "xhigh").threshold).toBe(966_000);
    // 非最高档(提前压缩语义)仍受 300K 成本封顶
    expect(autoCompactGate(events, "s1", 1_000_000, 0, undefined, "high").threshold).toBe(300_000);
    expect(autoCompactGate(events, "s1", 1_000_000, 0, undefined, undefined).threshold).toBe(300_000);
  });

  it("2026-11-03 effort 缩放：判定侧真用了 scaledThreshold(旧码只用未缩放 threshold)", () => {
    const mk = (effort: string, used: number) => {
      const es: GateEvent[] = [ev("compact.done", { summary: "x" })];
      for (let i = 0; i < 5; i++) es.push(ev("message.agent", { usage: { inputTokens: used } }));
      return autoCompactGate(es, "s1", 1_000_000, 0, undefined, effort);
    };
 // xhigh=满窗口 966k → 350k 不触发;high=封顶 300k → 350k 触发(档位语义真实生效)
    expect(mk("xhigh", 350_000).threshold).toBe(966_000);
    expect(mk("xhigh", 350_000).fire).toBe(false);
    expect(mk("high", 350_000).threshold).toBe(300_000);
    expect(mk("high", 350_000).fire).toBe(true);
    // 若判定懒用未缩放 threshold(966000),350k 绝不会触发——这条是回归锚
  });

  it("2026-11-03 强压(2026-11-04 floor 护栏修订版):压缩有效(floor<阈)后又涨到 1.2×阈值 → hardOver 强压", () => {
    const es: GateEvent[] = [ev("compact.done", { summary: "x" })];
    es.push(ev("message.agent", { usage: { inputTokens: 100_000 } })); // floor=100k < 300k:上次压缩有效
    es.push(ev("message.agent", { usage: { inputTokens: 370_000 } })); // 真实增长到 1.2×阈值(单步巨工具结果)
    const d = autoCompactGate(es, "s1", 1_000_000, 0);
    expect(d.threshold).toBe(300_000);
    expect(d.floorUsed).toBe(100_000);
    expect(d.fire).toBe(true);   // 370k ≥ 300k×1.2 且 floor 证明压缩有效 → hardOver 强压
    expect(d.force).toBe(true);
    expect(d.baseline).toBe(false);
  });

  it("2026-11-04 floor 护栏:刚压完就 ≥ 阈值(压不动)即使涨到 1.2×也不许强压(死亡螺旋根治)", () => {
 // web-1793696471953 注意形态:压缩后首个水位已超阈(基线/子代理用量在阈上),
    // hardOver 旁路若放行 → 每步强压 12 条消息的对话史,摘要套摘要,原始用户消息全丢。
    const es: GateEvent[] = [ev("compact.done", { summary: "x" })];
    es.push(ev("message.agent", { usage: { inputTokens: 31_715 } }));  // floor=31715 ≥ 阈 24000
    es.push(ev("message.agent", { usage: { inputTokens: 38_293 } }));  // used ≥ 1.2×24000=28800 → hardOver
    const d = autoCompactGate(es, "s1", undefined, 24000); // 窗口丢失场景:退化到显式 24000
    expect(d.threshold).toBe(24_000);
    expect(d.floorUsed).toBe(31_715);
    expect(d.fire).toBe(false);  // floor 卡死 → 按基线抑制,不进 hardOver 旁路
    expect(d.baseline).toBe(true);
  });

  it("2026-11-03 基线抑制窗仍生效:刚压完略超阈(未到 1.2 倍)不重压", () => {
    const es: GateEvent[] = [ev("compact.done", { summary: "x" })];
    es.push(ev("message.agent", { usage: { inputTokens: 310_000 } })); // 1.03 倍,未到 1.2
    const d = autoCompactGate(es, "s1", 1_000_000, 0);
    expect(d.fire).toBe(false);
    expect(d.baseline).toBe(true);
  });

  it(" 窗口优先:声明了 contextWindow 时显式阈值不生效(窗口是权威)", () => {
    const events: GateEvent[] = [ev("message.agent", { usage: { inputTokens: 30_000 } })];
    const d = autoCompactGate(events, "s1", 8192, 24000);
    expect(d.threshold).toBe(6554); // 0.8×8192,而非显式 24000
  });

  it(" 旧 microcompact 边界(无摘要 compact.done)不被当真边界——used 不被清零", () => {
    const events: GateEvent[] = [];
    events.push(ev("compact.done", { summary: "x" }));                 // 真压缩边界
    for (let i = 0; i < 3; i++) events.push(ev("message.agent", { usage: { inputTokens: 7000 } }));
    // 旧 microcompact 形态:payload={compacted,keepRecent},无 summary——不是压缩边界
    events.push(ev("compact.done", { compacted: 2, keepRecent: 5 }));
    const d = autoCompactGate(events, "s1", 8192, 24000);
 // 若伪边界被认,used 清零→走 est 兜底(fire=true,force=false);修复后按真经验证 force 触发
    expect(d.used).toBe(7000);
    expect(d.fire).toBe(true);
    expect(d.force).toBe(true);
  });

  it("会话隔离:别的会话的 usage/压缩不影响本会话判定", () => {
    const events: GateEvent[] = [];
    events.push({ kind: "message.agent", sessionId: "other", seq: ++seq, payload: { usage: { inputTokens: 9000 } } });
    events.push({ kind: "message.agent", sessionId: "s1", seq: ++seq, payload: { usage: { inputTokens: 100 } } });
    const d = autoCompactGate(events, "s1", 8192, 24000);
    expect(d.used).toBe(100);
    expect(d.fire).toBe(false);
  });
});
