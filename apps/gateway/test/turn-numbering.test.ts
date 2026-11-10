/**
 * turn 显示序号派生单测(2026-10-24:Trace 看板「永远 Turn 1」修复)。
 * 口径:no 按 turn.start 出现序派生、各 sessionId 独立递增;
 * payload.turn 不可信(loop 静态计数器每任务归零,journal 实证同会话两次 turn:1)。
 */
import { describe, expect, it } from "vitest";
import { TurnNoCounter } from "../src/track-turns";

describe("TurnNoCounter(会话内 turn 显示序号)", () => {
  it("同一会话内每次 next 独立递增 1,2,3…", () => {
    const c = new TurnNoCounter();
    expect(c.next("web-a")).toBe(1);
    expect(c.next("web-a")).toBe(2);
    expect(c.next("web-a")).toBe(3);
  });

  it("多会话交错时各自独立计数互不串", () => {
    const c = new TurnNoCounter();
    expect(c.next("web-a")).toBe(1);
    expect(c.next("web-b")).toBe(1); // 另一会话从 1 起
    expect(c.next("web-a")).toBe(2);
    expect(c.next("web-b")).toBe(2);
    expect(c.next("web-a")).toBe(3);
  });

  it("复现真实故障形态:同会话两次任务提交 payload.turn 均 1,派生 no 为 1,2(不透传)", () => {
    const c = new TurnNoCounter();
    const payloadTurns = [1, 1]; // journal 实证(web-1792593394925 两次 turn.start payload 均 turn:1)
    const nos = payloadTurns.map(() => c.next("web-1792593394925"));
    expect(nos).toEqual([1, 2]);
  });

  it("未知会话首次调用即得 1(缺省路径)", () => {
    const c = new TurnNoCounter();
    expect(c.next("fresh-sid")).toBe(1);
  });
});
