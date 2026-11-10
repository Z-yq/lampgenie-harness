import { describe, it, expect } from "vitest";
import { createWorkflowConcurrencyCoordinator } from "../src/concurrency/governor";

describe("并发协调器(进程级 AIMD 治理)", () => {
  it("tryEnter 快路径:闸门开即有票;429 事件后泳道 cap 下降", () => {
    const gov = createWorkflowConcurrencyCoordinator({ ceiling: 4 });
    const key = "p/m";
    const t1 = gov.tryEnter("run-1", key);
    expect(t1).toBeTruthy();
    expect(gov.snapshot(key)?.cap).toBe(4);
    t1!.emit({ type: "model_request_started" });
    t1!.emit({ type: "model_request_failed", reason: "rate_limited", code: "429" });
    t1!.release();
    expect(gov.snapshot(key)?.cap).toBe(3); // 4×0.75
  });
  it("主代理 passthrough 通道:永不被堵(快路径总命中)", () => {
    const gov = createWorkflowConcurrencyCoordinator({ ceiling: 1 });
    const t = gov.tryEnter("run-1", "p/m");
    expect(t).toBeTruthy();
    // 常规快路径此时应无票(有在飞)
    expect(gov.tryEnter("run-2", "p/m")).toBeUndefined();
    // passthrough 仍然拿到票
    const obs = gov.passthrough().tryTake?.({ model: { providerId: "p", modelId: "m" } });
    expect(obs).toBeTruthy();
    obs?.release();
    t!.release();
  });
});
