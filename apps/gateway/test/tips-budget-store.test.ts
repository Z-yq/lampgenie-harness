/**
 * tips-budget-store 用例:规则落盘/去重投影/key 过滤/resolve 落盘与 usage 重放/
 * reset 划窗口/报表分组/坏行容忍/参数错误。
 * 全部用例只写 os.tmpdir() 下的临时目录,绝不碰仓库 .genie。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TIPS_LINE_TYPES,
  addRule,
  listRules,
  reportTips,
  resetUsage,
  resolve,
  tipsPath,
  usage,
} from "../src/tips-budget-store";

const T0 = 1_700_000_000_000;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tips-budget-store-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function rule(over: Record<string, unknown> = {}): Record<string, unknown> {
  const id = String(over["id"] ?? "r1");
  return {
    id,
    key: over["key"] ?? id,
    category: "other",
    priority: 1,
    version: "v1",
    text: "短文提示",
    maxWords: 20,
    ...over,
  };
}

function cand(ruleId: string, nodeId = "n1"): Record<string, unknown> {
  return { ruleId, nodeId, at: T0 };
}

function lines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("tipsPath", () => {
  it("指向 <root>/.genie/rsi/tips.jsonl", () => {
    expect(tipsPath(root)).toBe(join(root, ".genie", "rsi", "tips.jsonl"));
    expect([...TIPS_LINE_TYPES]).toEqual(["rule", "resolve", "reset"]);
  });

  it("行类型常量稳定", () => {
    expect(TIPS_LINE_TYPES).toContain("reset");
  });
});

describe("addRule", () => {
  it("合法规则落盘并返回规则本体", () => {
    const result = addRule(root, rule({ id: "r1" }));
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual(["TIPS_RULE_ADDED"]);
    expect(result.rule?.id).toBe("r1");
    const rows = lines(tipsPath(root));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["v"]).toBe(1);
    expect(rows[0]?.["type"]).toBe("rule");
    expect((rows[0]?.["rule"] as { id?: string }).id).toBe("r1");
    expect(typeof rows[0]?.["at"]).toBe("number");
  });

  it("非法规则拒收且不落盘", () => {
    expect(addRule(root, rule({ id: "" }))).toEqual({ ok: false, codes: ["TIPS_INVALID"] });
    expect(addRule(root, rule({ priority: 9 }))).toEqual({ ok: false, codes: ["TIPS_INVALID"] });
    expect(addRule(root, "nope")).toEqual({ ok: false, codes: ["TIPS_INVALID"] });
    expect(lines(tipsPath(root))).toHaveLength(0);
  });
});

describe("listRules", () => {
  it("全量读出 + key 过滤", () => {
    addRule(root, rule({ id: "r1", key: "k1" }));
    addRule(root, rule({ id: "r2", key: "k2" }));
    expect(listRules(root).map((r) => r.id).sort()).toEqual(["r1", "r2"]);
    expect(listRules(root, { key: "k2" }).map((r) => r.id)).toEqual(["r2"]);
  });

  it("同 id 后写为准", () => {
    addRule(root, rule({ id: "r1", text: "旧文" }));
    addRule(root, rule({ id: "r1", text: "新文" }));
    const all = listRules(root);
    expect(all).toHaveLength(1);
    expect(all[0]?.text).toBe("新文");
  });
});

describe("resolve", () => {
  it("选择结果落成 resolve 行(形状可重放)", () => {
    addRule(root, rule({ id: "r1" }));
    const result = resolve(root, [cand("r1")], { now: T0 });
    expect(result.nodeId).toBe("n1");
    expect(result.recorded).toBe(true);
    expect(result.codes).toContain("TIPS_RULE_RESOLVED");
    const rows = lines(tipsPath(root));
    expect(rows).toHaveLength(2);
    const last = rows[1]!;
    expect(last["type"]).toBe("resolve");
    const record = last["result"] as Record<string, unknown>;
    expect(record["nodeId"]).toBe("n1");
    const selected = record["selected"] as Array<Record<string, unknown>>;
    expect(selected).toEqual([{ ruleId: "r1", key: "r1", words: 4, compressed: false }]);
    expect(record["dropped"]).toEqual([]);
    expect(record["codes"]).toContain("TIPS_SELECTED");
  });

  it("nodeId 缺省取候选自身 nodeId,再缺省 default", () => {
    addRule(root, rule({ id: "r1" }));
    expect(resolve(root, [cand("r1", "n9")]).nodeId).toBe("n9");
    expect(resolve(root, [{ ruleId: "r1" }]).nodeId).toBe("default");
  });

  it("过期规则经 store 落 TIPS_DROPPED_EXPIRED", () => {
    addRule(root, rule({ id: "r1", expiresAt: T0 }));
    const result = resolve(root, [cand("r1")], { now: T0 });
    expect(result.selected).toHaveLength(0);
    expect(result.dropped[0]?.code).toBe("TIPS_DROPPED_EXPIRED");
    const record = lines(tipsPath(root))[1]?.["result"] as { dropped?: Array<{ code?: string }> };
    expect(record.dropped?.[0]?.code).toBe("TIPS_DROPPED_EXPIRED");
  });
});

describe("节点归一(resolve 的 --node 与候选自带 nodeId)", () => {
  it("显式 nodeId 覆盖候选自带 nodeId:预算与 usage 都记该节点", () => {
    addRule(root, rule({ id: "r1", category: "dispatch", priority: 1, exclusiveGroup: "g1", key: "k1" }));
    addRule(root, rule({ id: "r2", category: "discipline", priority: 0, exclusiveGroup: "g1", key: "k2" }));
    const seeded = resolve(root, [cand("r1", "n1")], { nodeId: "n1", budget: { maxTipsPerNode: 1 }, now: T0 });
    expect(seeded.selected.map((s) => s.rule.id)).toEqual(["r1"]);
    expect(seeded.usageAfter.nodeTips).toEqual({ n1: 1 });

    // 候选仍带 n1,但显式 nodeId=n3:预算按 n3(空)判 → r2 不被误丢,usage 记 n3
    const result = resolve(root, [cand("r1"), cand("r2")], {
      nodeId: "n3",
      budget: { maxTipsPerNode: 1 },
      now: T0 + 1,
    });
    expect(result.nodeId).toBe("n3");
    expect(result.recorded).toBe(true);
    expect(result.codes).not.toContain("TIPS_DROPPED_BUDGET_NODE");
    expect(result.selected.map((s) => s.rule.id)).toEqual(["r2"]);
    expect(result.dropped.map((d) => d.code)).toEqual(["TIPS_DROPPED_EXCLUSIVE"]);
    expect(result.usageAfter.nodeTips).toEqual({ n1: 1, n3: 1 });
    const record = lines(tipsPath(root))[3]?.["result"] as Record<string, unknown>;
    expect(record["nodeId"]).toBe("n3");
    expect(usage(root).nodeTips).toEqual({ n1: 1, n3: 1 });
  });

  it("无 nodeId 且候选混用 → TIPS_STORE_INVALID_INPUT 且不落盘", () => {
    addRule(root, rule({ id: "r1" }));
    const rowsBefore = lines(tipsPath(root)).length;
    const result = resolve(root, [cand("r1", "n1"), cand("r1", "n3")], { now: T0 });
    expect(result.codes).toEqual(["TIPS_STORE_INVALID_INPUT"]);
    expect(result.selected).toEqual([]);
    expect(result.dropped).toEqual([]);
    expect(result.recorded).toBe(false);
    expect(lines(tipsPath(root))).toHaveLength(rowsBefore);
    expect(usage(root)).toEqual({ nodeTips: {}, nodeWords: {}, globalTips: 0, globalWords: 0 });

    // 缺失 nodeId 等价 default,与显式 n1 混用同样拒收
    expect(resolve(root, [cand("r1", "n1"), { ruleId: "r1" }], { now: T0 }).codes).toEqual([
      "TIPS_STORE_INVALID_INPUT",
    ]);
    expect(lines(tipsPath(root))).toHaveLength(rowsBefore);
  });

  it("候选缺 nodeId 时用 options.nodeId", () => {
    addRule(root, rule({ id: "r1" }));
    const result = resolve(root, [{ ruleId: "r1" }], { nodeId: "n7", now: T0 });
    expect(result.nodeId).toBe("n7");
    expect(result.selected.map((s) => s.rule.id)).toEqual(["r1"]);
    expect(result.usageAfter.nodeTips).toEqual({ n7: 1 });
    const record = lines(tipsPath(root))[1]?.["result"] as Record<string, unknown>;
    expect(record["nodeId"]).toBe("n7");
  });

  it("候选与 options 都无 nodeId → default", () => {
    addRule(root, rule({ id: "r1" }));
    const result = resolve(root, [{ ruleId: "r1" }], { now: T0 });
    expect(result.nodeId).toBe("default");
    expect(result.usageAfter.nodeTips).toEqual({ default: 1 });
    const record = lines(tipsPath(root))[1]?.["result"] as Record<string, unknown>;
    expect(record["nodeId"]).toBe("default");
  });

  it("候选与 options 一致时行为逐字不变", () => {
    addRule(root, rule({ id: "r1" }));
    const first = resolve(root, [cand("r1", "n1")], { nodeId: "n1", now: T0 });
    expect(first.nodeId).toBe("n1");
    expect(first.recorded).toBe(true);
    expect(first.codes).toEqual(["TIPS_SELECTED", "TIPS_RULE_RESOLVED"]);
    expect(first.selected.map((s) => s.rule.id)).toEqual(["r1"]);
    expect(first.selected[0]?.compressed).toBe(false);
    const row = lines(tipsPath(root))[1]?.["result"] as Record<string, unknown>;
    expect(row["selected"]).toEqual([{ ruleId: "r1", key: "r1", words: 4, compressed: false }]);

    const second = resolve(root, [cand("r1", "n1")], { now: T0 + 1 });
    expect(second.nodeId).toBe("n1");
    expect(second.selected.map((s) => s.rule.id)).toEqual(["r1"]);
    expect(second.dropped).toEqual([]);
    expect(usage(root).nodeTips).toEqual({ n1: 2 });
  });
});

describe("usage 重放", () => {
  it("两次 resolve 累加", () => {
    addRule(root, rule({ id: "r1" }));
    addRule(root, rule({ id: "r2" }));
    resolve(root, [cand("r1")], { now: T0 });
    resolve(root, [cand("r2")], { now: T0 + 1 });
    const used = usage(root);
    expect(used.nodeTips).toEqual({ n1: 2 });
    expect(used.nodeWords).toEqual({ n1: 8 });
    expect(used.globalTips).toBe(2);
    expect(used.globalWords).toBe(8);
  });

  it("reset 后清零(rule 行不计)", () => {
    addRule(root, rule({ id: "r1" }));
    resolve(root, [cand("r1")], { now: T0 });
    expect(usage(root).globalTips).toBe(1);
    expect(resetUsage(root, { now: T0 + 2 })).toEqual({ ok: true, codes: ["TIPS_USAGE_RESET"] });
    expect(usage(root)).toEqual({ nodeTips: {}, nodeWords: {}, globalTips: 0, globalWords: 0 });
  });

  it("reset 之后的新窗口继续累加", () => {
    addRule(root, rule({ id: "r1" }));
    resolve(root, [cand("r1")], { now: T0 });
    resetUsage(root, { now: T0 + 1 });
    resolve(root, [cand("r1")], { now: T0 + 2 });
    expect(usage(root).globalTips).toBe(1);
  });
});

describe("reportTips", () => {
  it("分组、丢弃原因与压缩数", () => {
    addRule(root, rule({ id: "r1", category: "dispatch", priority: 1, exclusiveGroup: "g1" }));
    addRule(root, rule({ id: "r2", category: "discipline", priority: 0, exclusiveGroup: "g1" }));
    addRule(root, rule({ id: "r3", category: "context", priority: 2, requires: ["r-missing"] }));
    addRule(root, rule({ id: "r4", category: "tool", priority: 1, text: "第一条纪律。第二条纪律。", maxWords: 5 }));
    const result = resolve(root, [cand("r1"), cand("r2"), cand("r3"), cand("r4")], { now: T0 });
    expect(result.selected.map((s) => s.rule.id).sort()).toEqual(["r2", "r4"]);
    expect(result.selected.find((s) => s.rule.id === "r4")?.compressed).toBe(true);

    const report = reportTips(root);
    expect(report.rules).toBe(4);
    expect(report.byCategory).toEqual({ dispatch: 1, discipline: 1, context: 1, tool: 1 });
    expect(report.byPriority).toEqual({ "1": 2, "0": 1, "2": 1 });
    expect(report.dropsByReason).toEqual({ TIPS_DROPPED_EXCLUSIVE: 1, TIPS_DROPPED_REQUIRES: 1 });
    expect(report.compressed).toBe(1);
    expect(report.resolves).toBe(1);
    expect(report.badLines).toBe(0);
  });
});

describe("坏行容忍", () => {
  it("坏 JSON / v≠1 / type 未知 / 载荷不合法只计 badLines", () => {
    addRule(root, rule({ id: "r1" }));
    const path = tipsPath(root);
    appendFileSync(path, "{oops\n", "utf8");
    appendFileSync(path, `${JSON.stringify({ v: 2, type: "rule", at: T0, rule: rule() })}\n`, "utf8");
    appendFileSync(path, `${JSON.stringify({ v: 1, type: "weird", at: T0 })}\n`, "utf8");
    appendFileSync(path, `${JSON.stringify({ v: 1, type: "rule", at: T0, rule: {} })}\n`, "utf8");
    expect(listRules(root).map((r) => r.id)).toEqual(["r1"]);
    expect(reportTips(root).badLines).toBe(4);
    expect(usage(root).globalTips).toBe(0);
  });
});

describe("错误与隔离", () => {
  it("root 非字符串/空 → 参数错误", () => {
    expect(() => tipsPath("")).toThrow();
    expect(() => addRule(undefined as unknown as string, rule())).toThrow();
    expect(() => listRules(null as unknown as string)).toThrow();
    expect(() => usage(123 as unknown as string)).toThrow();
    expect(() => reportTips("  ")).toThrow();
  });

  it("空目录读出空投影(不建文件)", () => {
    expect(listRules(root)).toEqual([]);
    expect(usage(root)).toEqual({ nodeTips: {}, nodeWords: {}, globalTips: 0, globalWords: 0 });
    expect(reportTips(root)).toEqual({
      rules: 0,
      byCategory: {},
      byPriority: {},
      dropsByReason: {},
      compressed: 0,
      resolves: 0,
      badLines: 0,
    });
    expect(existsSync(tipsPath(root))).toBe(false);
  });

  it("临时目录隔离:两个 root 互不干扰", () => {
    const other = mkdtempSync(join(tmpdir(), "tips-budget-store-other-"));
    try {
      addRule(root, rule({ id: "r1" }));
      addRule(other, rule({ id: "r2" }));
      expect(listRules(root).map((r) => r.id)).toEqual(["r1"]);
      expect(listRules(other).map((r) => r.id)).toEqual(["r2"]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
