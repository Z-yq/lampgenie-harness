import { describe, it, expect } from "vitest";
import { AimdRegulator } from "../src/concurrency/aimd-controller";

describe("AIMD 并发状态机(AimdRegulator)", () => {
  it("429(throttled)降 cap 至 0.75 倍", () => {
    const c = new AimdRegulator("p/m", 4);
    const epoch = c.noteAdmitted(1000);
    const changes = c.noteThrottled(2000, epoch, { reason: "rate_limited" });
    expect(changes.length).toBeGreaterThan(0);
    expect(c.snapshot().cap).toBe(3); // 4×0.75
  });
  it("旧 epoch 的 429 不砍新 cap(epoch 防脏)", () => {
    const c = new AimdRegulator("p/m", 4);
    const e1 = c.noteAdmitted(1000);
    c.noteThrottled(2000, e1, { reason: "rate_limited" }); // cap 4→3, epoch 翻转
    const capAfterCut = c.snapshot().cap;
    c.noteThrottled(3000, e1, { reason: "rate_limited" }); // 旧 epoch 信号
    expect(c.snapshot().cap).toBe(capAfterCut); // 不再降
  });
  it("连续 4 次当前 epoch 成功且有等待者 → cap+1", () => {
    const c = new AimdRegulator("p/m", 4);
    const e = c.noteAdmitted(1000);
    c.noteThrottled(2000, e, { reason: "rate_limited" }); // 4→3
    c.noteQueueDepth(3000, 2);
    for (let i = 0; i < 4; i++) {
      const ep = c.noteAdmitted(4000 + i * 100);
      c.noteSuccess(5000 + i * 100, ep);
    }
    expect(c.snapshot().cap).toBe(4); // 3+1 回升
  });
  it("idle 5 分钟后回天花板", () => {
    const c = new AimdRegulator("p/m", 4);
    const e = c.noteAdmitted(1000);
    c.noteThrottled(2000, e, { reason: "rate_limited" });
    expect(c.snapshot().cap).toBe(3);
    c.pulse(2000 + 300_001); // > AIMD_IDLE_RESET_MS
    expect(c.snapshot().cap).toBe(4);
  });
});
