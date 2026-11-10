/**
 * 板质量结算消费面(bq3,2026-11-05 板质量遥测闭环):
 * - computeSkeletonAdoption 纯函数:landed 并集为分母、终板 sk- 存活为分子;
 *   分母 0(无骨架事件)=null(整段不落);多事件 landed 去重合并;round3 三位小数。
 * - PlanQualityZ schema:不带 skeleton 过/带 skeleton 过/坏类型拒。
 */
import { describe, it, expect } from "vitest";
import { computeSkeletonAdoption } from "../src/agent-wiring.js";
import { PlanQualityZ, type PlanQuality } from "@lampgenie/protocol";

describe("computeSkeletonAdoption(骨架采纳率纯函数)", () => {
  it("无骨架事件(landed 并集为空)→ null:整段 skeleton 不落", () => {
    expect(computeSkeletonAdoption([{ id: "sk-a" }], [])).toBeNull();
    expect(computeSkeletonAdoption([{ id: "sk-a" }], [{ payload: {} }, { payload: { landed: "sk-a" } }])).toBeNull();
  });

  it("终板全存活 → adoptionRate=1;部分存活按 landed 并集算分母", () => {
    const evs = [{ payload: { landed: ["sk-a", "sk-b"] } }];
    expect(computeSkeletonAdoption([{ id: "sk-a" }, { id: "sk-b" }, { id: "n1" }], evs as never)).toEqual({ generated: 2, survived: 2, adoptionRate: 1 });
    expect(computeSkeletonAdoption([{ id: "sk-a" }, { id: "n1" }], evs as never)).toEqual({ generated: 2, survived: 1, adoptionRate: 0.5 });
  });

  it("多事件 landed 去重合并(两次骨架同名 id 只算一次)", () => {
    const evs = [{ payload: { landed: ["sk-a", "sk-b"] } }, { payload: { landed: ["sk-b", "sk-c"] } }];
    expect(computeSkeletonAdoption([{ id: "sk-b" }], evs as never)).toEqual({ generated: 3, survived: 1, adoptionRate: 0.333 });
  });

  it("三位小数舍入(round3):1/3 → 0.333", () => {
    const evs = [{ payload: { landed: ["sk-a", "sk-b", "sk-c"] } }];
    expect(computeSkeletonAdoption([{ id: "sk-a" }], evs as never)!.adoptionRate).toBe(0.333);
  });
});

describe("PlanQualityZ(协议 schema)", () => {
  const base: PlanQuality = {
    boardType: "code", nodes: 7, contentNodes: 7,
    p0: { passed: 1, total: 1, rate: 1 }, anchorDensity: 1,
  };
  it("不带 skeleton 通过;带 skeleton 通过;boardType 可为 null", () => {
    expect(PlanQualityZ.parse(base)).toEqual(base);
    expect(PlanQualityZ.parse({ ...base, skeleton: { generated: 2, survived: 1, adoptionRate: 0.5 } })).toMatchObject({ skeleton: { generated: 2 } });
    expect(PlanQualityZ.parse({ ...base, boardType: null }).boardType).toBeNull();
  });
  it("坏类型被拒:nodes 字符串 / adoptionRate 字符串 / boardType 键在场 undefined", () => {
    expect(PlanQualityZ.safeParse({ ...base, nodes: "7" }).success).toBe(false);
    expect(PlanQualityZ.safeParse({ ...base, skeleton: { generated: 2, survived: 1, adoptionRate: "0.5" } }).success).toBe(false);
    expect(PlanQualityZ.safeParse({ ...base, boardType: undefined }).success).toBe(false);
  });
});
