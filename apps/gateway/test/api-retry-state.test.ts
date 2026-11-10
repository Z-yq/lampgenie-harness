/**
 * 重试态跨会话保活(batch1b)单测:锁住 gateway 侧 per-session 内存镜像的语义边界。
 *
 * 语义来源(只读参考,不 import):ZCode/packages/services/src/zcode-session/zcodeSessionApiRetry.ts
 *  — attempt 从 1 起;retry 开始不清旧态;首个模型进展才清;会话终态清零。
 * 为什么必须有这层:重试态此前只活在当前渲染里,面板切走会话再切回来就丢(用户以为任务卡死)。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ApiRetryStatusZ } from "@lampgenie/protocol";
import { beginRetry, clearOnProgress, clearOnTerminal, snapshot, __resetForTest } from "../src/session-retry-state.js";

const SID = "web-retry-test";

beforeEach(() => { __resetForTest(); });

describe("session-retry-state(batch1b)", () => {
  it("①attempt 从 1 起:首次 beginRetry 即 attempt=1(不从 0 起)", () => {
    const st = beginRetry(SID, { maxRetries: 5, retryDelayMs: 800, errorStatus: 500, error: "HTTP 500" });
    expect(st.attempt).toBe(1);
    expect(st.kind).toBe("api_retry");
    expect(st.maxRetries).toBeGreaterThanOrEqual(st.attempt);
    // 协议 schema 同口径(字段对得上真帧,不是自造的平行结构)
    expect(ApiRetryStatusZ.parse(st)).toMatchObject({ kind: "api_retry", attempt: 1, errorStatus: 500 });
    expect(snapshot(SID)).toMatchObject({ attempt: 1, errorStatus: 500 });
  });

  it("②重试中 snapshot 返回 attempt=2(retry 开始不清旧态,计数只增)", () => {
    beginRetry(SID, { maxRetries: 5, retryDelayMs: 500, errorStatus: 429, error: "HTTP 429" });
    // 第二次重试排期:不传 attempt=自动 +1;不传的字段沿用上一次(不清零、不重置)
    const second = beginRetry(SID, { retryDelayMs: 1600 });
    expect(second.attempt).toBe(2);
    expect(second.maxRetries).toBe(5);
    expect(second.errorStatus).toBe(429);
    const s = snapshot(SID);
    expect(s).not.toBeNull();
    expect(s!.attempt).toBe(2);
    expect(s!.retryDelayMs).toBe(1600);
    // 返回副本:调用方改返回值不能污染镜像
    s!.attempt = 99;
    expect(snapshot(SID)!.attempt).toBe(2);
  });

  it("③clearOnProgress(首个模型进展)后 snapshot 为空", () => {
    beginRetry(SID, { maxRetries: 5, errorStatus: 503, error: "HTTP 503" });
    expect(snapshot(SID)).not.toBeNull();
    clearOnProgress(SID);
    expect(snapshot(SID)).toBeNull();
    clearOnProgress(SID); // 幂等:再清一次不炸
    expect(snapshot(SID)).toBeNull();
  });

  it("④clearOnTerminal(done/failed/cancelled)后 snapshot 为空", () => {
    beginRetry(SID, { maxRetries: 5, errorStatus: null, error: "connect_error" });
    expect(snapshot(SID)).not.toBeNull();
    clearOnTerminal(SID);
    expect(snapshot(SID)).toBeNull();
    // 未知会话读取=null(不抛;面板可无脑 snapshot)
    expect(snapshot("web-never-seen")).toBeNull();
  });
});
