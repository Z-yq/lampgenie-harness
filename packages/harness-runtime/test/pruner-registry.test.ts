/**
 * ContextPruner 声明层测试(缺口#31,件3):八件齐 + 元数据结构性断言。
 * 断言来源 = docs/design/02-context-economy/04-mechanisms.md §4.1.8.1 契约总表。
 */
import { describe, expect, it } from "vitest";
import { PRUNER_REGISTRY, findPruner } from "../src/agent/pruner-registry";

const IDS = [
  "big-intake",
  "spill",
  "head-tail-refine",
  "microcompact",
  "model-scoring",
  "context-prune",
  "age",
  "auto-compact",
];

describe("PRUNER_REGISTRY:八件齐", () => {
  it("恰好八件,id 与契约总表一致且不重复", () => {
    expect(PRUNER_REGISTRY).toHaveLength(8);
    expect(PRUNER_REGISTRY.map((p) => p.id).sort()).toEqual([...IDS].sort());
    expect(new Set(PRUNER_REGISTRY.map((p) => p.id)).size).toBe(8);
  });

  it("findPruner 命中/未命中", () => {
    expect(findPruner("age")?.id).toBe("age");
    expect(findPruner("nope")).toBeNull();
  });
});

describe("PRUNER_REGISTRY:元数据断言(契约总表)", () => {
  it("热区三件 mutatesEmittedBytes 全 false(热区没有事后剪)", () => {
    const hot = PRUNER_REGISTRY.filter((p) => p.zone === "hot");
    expect(hot.map((p) => p.id).sort()).toEqual(["big-intake", "head-tail-refine", "spill"]);
    for (const p of hot) expect(p.mutatesEmittedBytes).toBe(false);
  });

  it("热区件:big-intake/spill 持久化 artifact(全文落盘);head-tail-refine none", () => {
    expect(findPruner("big-intake")).toMatchObject({ zone: "hot", segment: "increment", persists: "artifact", idempotent: true });
    expect(findPruner("spill")).toMatchObject({ zone: "hot", segment: "increment", persists: "artifact", idempotent: true });
    expect(findPruner("head-tail-refine")).toMatchObject({ zone: "hot", segment: "tail", persists: "none", idempotent: true });
  });

  it("温区件:W1/W2/W3 对应 microcompact/model-scoring/context-prune,持久化全 journal", () => {
    expect(findPruner("microcompact")).toMatchObject({ zone: "warm", segment: "middle", persists: "journal" });
    expect(findPruner("model-scoring")).toMatchObject({ zone: "warm", segment: "middle", mutatesEmittedBytes: false, persists: "journal", idempotent: true });
    expect(findPruner("context-prune")).toMatchObject({ zone: "warm", segment: "middle", mutatesEmittedBytes: true, persists: "journal", idempotent: false });
  });

  it("冷区件:auto-compact all-head 改已发出字节且非幂等;age 只留痕 journal", () => {
    expect(findPruner("auto-compact")).toMatchObject({ zone: "cold", segment: "all-head", mutatesEmittedBytes: true, persists: "journal", idempotent: false });
    expect(findPruner("age")).toMatchObject({ zone: "cold", mutatesEmittedBytes: true, persists: "journal", idempotent: true });
  });

  it("zone/segment/persists 取值域受限(字符串字面量联合,无 enum)", () => {
    const zones = new Set(["hot", "warm", "cold"]);
    const segments = new Set(["increment", "tail", "middle", "frozen", "all-head"]);
    const persists = new Set(["none", "artifact", "journal"]);
    for (const p of PRUNER_REGISTRY) {
      expect(zones.has(p.zone)).toBe(true);
      expect(segments.has(p.segment)).toBe(true);
      expect(persists.has(p.persists)).toBe(true);
      expect(typeof p.mutatesEmittedBytes).toBe("boolean");
      expect(typeof p.idempotent).toBe("boolean");
    }
  });
});

describe("PRUNER_REGISTRY:声明层桩行为", () => {
  it("plan 返回零效果并显式 skipped=registry-metadata-only(不装成真裁了)", () => {
    for (const p of PRUNER_REGISTRY) {
      const r = p.plan({ anything: true });
      expect(r.targets).toEqual([]);
      expect(r.savedTokens).toBe(0);
      expect(r.breakCostTokens).toBe(0);
      expect(r.skipped).toBe("registry-metadata-only");
    }
  });

  it("apply 返回空 messages + audit(声明层不绑实现)", () => {
    for (const p of PRUNER_REGISTRY) {
      const r = p.apply({ targets: ["a"] });
      expect(Array.isArray(r.messages)).toBe(true);
      expect(r.messages).toEqual([]);
      expect(r.audit).toMatchObject({ stub: true });
    }
  });
});
