/**
 * 子代理深度与工具面收敛(纯逻辑单测)。
 * 覆盖:DEPTH_CODES/上限 · depthOfRecords(根/链/缺父/环/超长/脏入参/不可变/确定性) ·
 * spawnDepthVerdict(OK/超限/环/非法/自报深度不采信) · convergeDeny(并集/默认 deny/primary-only/主 agent 视角/排序去重) ·
 * resumeSessionKey(稳定/前缀/空值)。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUBAGENT_DENY,
  DEPTH_CODES,
  MAX_SUBAGENT_DEPTH,
  PRIMARY_ONLY_TOOLS,
  convergeDeny,
  depthOfRecords,
  resumeSessionKey,
  spawnDepthVerdict,
  type DepthRecord,
} from "../src/agent/subagent-depth.js";

/** root→a→b→c 链(与验收探针 A 同一形态)。 */
const CHAIN: DepthRecord[] = [
  { agentId: "root" },
  { agentId: "a", parentId: "root" },
  { agentId: "b", parentId: "a" },
  { agentId: "c", parentId: "b" },
];

describe("常量与判定码", () => {
  it("DEPTH_CODES 恰为四值", () => {
    expect([...DEPTH_CODES]).toEqual(["OK", "DEPTH_EXCEEDED", "INVALID", "CYCLE"]);
  });

  it("MAX_SUBAGENT_DEPTH = 3(根 0 / 子 1 / 孙 2 / 曾孙 3,再往下拒)", () => {
    expect(MAX_SUBAGENT_DEPTH).toBe(3);
  });

  it("DEFAULT_SUBAGENT_DENY 含 todowrite/task;PRIMARY_ONLY_TOOLS 显式空数组", () => {
    expect([...DEFAULT_SUBAGENT_DENY]).toEqual(["todowrite", "task"]);
    expect([...PRIMARY_ONLY_TOOLS]).toEqual([]);
  });
});

describe("depthOfRecords:只用父子链推导", () => {
  it("空 records / 未知 agentId → 深度 0", () => {
    expect(depthOfRecords([], "ghost")).toMatchObject({ ok: true, depth: 0, code: "OK" });
    expect(depthOfRecords(undefined, "ghost")).toMatchObject({ ok: true, depth: 0, code: "OK" });
  });

  it("根节点(无 parentId)→ 深度 0", () => {
    const r = depthOfRecords(CHAIN, "root");
    expect(r).toMatchObject({ ok: true, depth: 0, code: "OK", chain: ["root"] });
  });

  it("探针 A:root→a→b→c 链,c 的深度 = 3", () => {
    expect(depthOfRecords(CHAIN, "a").depth).toBe(1);
    expect(depthOfRecords(CHAIN, "b").depth).toBe(2);
    expect(depthOfRecords(CHAIN, "c").depth).toBe(3);
  });

  it("链返回叶→根顺序,便于错误文本渲染", () => {
    expect(depthOfRecords(CHAIN, "c").chain).toEqual(["c", "b", "a", "root"]);
  });

  it("父记录缺席(指向未知 id)→ 停在已走跳数,不报错", () => {
    const r = depthOfRecords([{ agentId: "x", parentId: "missing" }], "x");
    expect(r).toMatchObject({ ok: true, depth: 1, code: "OK", chain: ["x", "missing"] });
  });

  it("探针 B:两节点互指成环 → CYCLE", () => {
    const r = depthOfRecords([{ agentId: "a", parentId: "b" }, { agentId: "b", parentId: "a" }], "a");
    expect(r.code).toBe("CYCLE");
    expect(r.ok).toBe(false);
  });

  it("自指环 a→a → CYCLE(不死循环)", () => {
    expect(depthOfRecords([{ agentId: "a", parentId: "a" }], "a").code).toBe("CYCLE");
  });

  it("超 100 节点链 → INVALID", () => {
    const long: DepthRecord[] = [{ agentId: "n0" }];
    for (let i = 1; i <= 120; i++) long.push({ agentId: `n${i}`, parentId: `n${i - 1}` });
    const r = depthOfRecords(long, "n120");
    expect(r.code).toBe("INVALID");
    expect(r.ok).toBe(false);
  });

  it("空 agentId → INVALID(不 throw)", () => {
    expect(depthOfRecords(CHAIN, "")).toMatchObject({ ok: false, depth: 0, code: "INVALID" });
    expect(depthOfRecords(CHAIN, "   ")).toMatchObject({ ok: false, code: "INVALID" });
  });

  it("脏入参(非数组/含非对象项)不 throw,按缺席处理", () => {
    expect(() => depthOfRecords("not-array" as unknown as DepthRecord[], "a")).not.toThrow();
    expect(depthOfRecords("not-array" as unknown as DepthRecord[], "a")).toMatchObject({ ok: true, depth: 0 });
    expect(depthOfRecords([null as unknown as DepthRecord, { agentId: 42 } as unknown as DepthRecord], "a")).toMatchObject({ ok: true, depth: 0 });
  });

  it("不修改入参 records(纯函数)", () => {
    const input: DepthRecord[] = CHAIN.map((r) => ({ ...r }));
    const before = JSON.stringify(input);
    depthOfRecords(input, "c");
    expect(JSON.stringify(input)).toBe(before);
  });

  it("确定性:同输入两次结果逐字相同", () => {
    expect(JSON.stringify(depthOfRecords(CHAIN, "c"))).toBe(JSON.stringify(depthOfRecords(CHAIN, "c")));
  });
});

describe("spawnDepthVerdict:spawn 前裁决", () => {
  it("主 agent(根)派第一层 → OK depth 1", () => {
    expect(spawnDepthVerdict({ records: CHAIN, parentId: "root" })).toMatchObject({ ok: true, depth: 1, code: "OK" });
  });

  it("depth 2 的父派发 → OK depth 3(贴线不拒)", () => {
    expect(spawnDepthVerdict({ records: CHAIN, parentId: "b" })).toMatchObject({ ok: true, depth: 3, code: "OK" });
  });

  it("探针 A:链 root→a→b→c 再 spawn → DEPTH_EXCEEDED(depth 4)", () => {
    const v = spawnDepthVerdict({ records: CHAIN, parentId: "c" });
    expect(v.ok).toBe(false);
    expect(v.code).toBe("DEPTH_EXCEEDED");
    expect(v.depth).toBe(4);
  });

  it("超限错误文本带最大深度与链", () => {
    const v = spawnDepthVerdict({ records: CHAIN, parentId: "c" });
    expect(v.reason).toContain("上限 3");
    expect(v.reason).toContain("root → a → b → c");
    expect(v.reason).toContain("本次 = 4");
  });

  it("requestedDepth 自报 0 也不采信:仍按链判超限", () => {
    const v = spawnDepthVerdict({ records: CHAIN, parentId: "c", requestedDepth: 0 });
    expect(v.code).toBe("DEPTH_EXCEEDED");
    expect(v.depth).toBe(4);
  });

  it("requestedDepth 与链不一致时写进 reason(不信任留痕)", () => {
    const v = spawnDepthVerdict({ records: CHAIN, parentId: "c", requestedDepth: 1 });
    expect(v.reason).toContain("自报 depth=1 不予采信");
    expect(v.reason).toContain("父深度 3");
  });

  it("requestedDepth 与链一致时不写不信任提示", () => {
    const v = spawnDepthVerdict({ records: CHAIN, parentId: "c", requestedDepth: 3 });
    expect(v.reason).not.toContain("不予采信");
  });

  it("父链成环 → CYCLE(拒绝派发)", () => {
    const v = spawnDepthVerdict({
      records: [{ agentId: "a", parentId: "b" }, { agentId: "b", parentId: "a" }],
      parentId: "a",
    });
    expect(v.ok).toBe(false);
    expect(v.code).toBe("CYCLE");
  });

  it("parentId 缺失/空白 → INVALID(失败方向=不派发)", () => {
    expect(spawnDepthVerdict({ records: CHAIN })).toMatchObject({ ok: false, code: "INVALID" });
    expect(spawnDepthVerdict({ records: CHAIN, parentId: "  " })).toMatchObject({ ok: false, code: "INVALID" });
  });

  it("未登记的新主任务(records 里没有它)→ 按根处理,第一层放行", () => {
    expect(spawnDepthVerdict({ records: [], parentId: "web-new-task" })).toMatchObject({ ok: true, depth: 1, code: "OK" });
  });

  it("maxDepth 可覆盖(缺省 MAX_SUBAGENT_DEPTH)", () => {
    expect(spawnDepthVerdict({ records: CHAIN, parentId: "c", maxDepth: 4 })).toMatchObject({ ok: true, depth: 4 });
  });

  it("不修改入参(records 与 verdict 确定性)", () => {
    const input: DepthRecord[] = CHAIN.map((r) => ({ ...r }));
    const before = JSON.stringify(input);
    const a = spawnDepthVerdict({ records: input, parentId: "c" });
    const b = spawnDepthVerdict({ records: input, parentId: "c" });
    expect(JSON.stringify(input)).toBe(before);
    expect(a).toEqual(b);
  });
});

describe("convergeDeny:父 deny ∪ 子 deny ∪ 默认 ∪ primary-only", () => {
  it("探针 C:父 deny terminal + 子 deny board → 并集", () => {
    const r = convergeDeny({ parentDeny: ["terminal"], childDeny: ["board"] });
    expect(r.deny).toEqual(expect.arrayContaining(["terminal", "board"]));
    expect(r.sources.parent).toEqual(["terminal"]);
    expect(r.sources.child).toEqual(["board"]);
  });

  it("探针 E:默认 deny todowrite/task 恒在(即使两路 deny 为空)", () => {
    const r = convergeDeny({});
    expect(r.deny).toContain("todowrite");
    expect(r.deny).toContain("task");
    expect(r.sources.default).toEqual(["task", "todowrite"]);
  });

  it("探针 D:primary-only 工具被子代理调用一律 deny", () => {
    const r = convergeDeny({ primaryOnly: ["spawn_subagent"] });
    expect(r.deny).toContain("spawn_subagent");
    expect(r.sources.primary).toEqual(["spawn_subagent"]);
  });

  it("isPrimaryOnly=true(主 agent 视角)不追加 primary-only", () => {
    const r = convergeDeny({ primaryOnly: ["spawn_subagent"], isPrimaryOnly: true });
    expect(r.deny).not.toContain("spawn_subagent");
    expect(r.sources.primary).toEqual([]);
  });

  it('kind="primary" 等价主 agent 视角', () => {
    const r = convergeDeny({ primaryOnly: ["spawn_subagent"], kind: "primary" });
    expect(r.deny).not.toContain("spawn_subagent");
  });

  it("四路来源都记录在 sources(可审计谁加的 deny)", () => {
    const r = convergeDeny({ parentDeny: ["p"], childDeny: ["c"], primaryOnly: ["x"], kind: "subagent" });
    expect(r.sources).toEqual({ parent: ["p"], child: ["c"], default: ["task", "todowrite"], primary: ["x"] });
  });

  it("去重:两路给同一个工具只出现一次", () => {
    const r = convergeDeny({ parentDeny: ["task"], childDeny: ["task"] });
    expect(r.deny.filter((d) => d === "task")).toHaveLength(1);
  });

  it("确定性排序(ASCII,跨机器可复现)", () => {
    expect(convergeDeny({ parentDeny: ["z"], childDeny: ["a"] }).deny).toEqual(["a", "task", "todowrite", "z"]);
    expect(JSON.stringify(convergeDeny({ parentDeny: ["z", "a"] }))).toBe(JSON.stringify(convergeDeny({ parentDeny: ["a", "z"] })));
  });

  it("空白/非字符串项被清洗,重复给同一结果", () => {
    const a = convergeDeny({ parentDeny: [" terminal ", "", "  "] as string[] });
    const b = convergeDeny({ parentDeny: ["terminal"] });
    expect(a.deny).toEqual(b.deny);
  });

  it("脏入参(非数组)不 throw", () => {
    expect(() => convergeDeny({ parentDeny: "terminal" as unknown as string[] })).not.toThrow();
    expect(convergeDeny({ parentDeny: "terminal" as unknown as string[] }).deny).toEqual(["task", "todowrite"]);
  });

  it("不修改入参(返回新数组)", () => {
    const parentDeny = ["terminal"];
    const childDeny = ["board"];
    convergeDeny({ parentDeny, childDeny });
    expect(parentDeny).toEqual(["terminal"]);
    expect(childDeny).toEqual(["board"]);
  });
});

describe("resumeSessionKey:同一 child 会话续跑", () => {
  it("探针 F:键稳定且为 child:<taskId>", () => {
    expect(resumeSessionKey("1a2b3c4d")).toBe("child:1a2b3c4d");
    expect(resumeSessionKey("1a2b3c4d")).toBe(resumeSessionKey("1a2b3c4d"));
  });

  it("首尾空白被裁剪,同一 taskId 同一键", () => {
    expect(resumeSessionKey(" 1a2b3c4d ")).toBe("child:1a2b3c4d");
  });

  it("空/非字符串 → child:(不 throw)", () => {
    expect(resumeSessionKey("")).toBe("child:");
    expect(resumeSessionKey(undefined as unknown as string)).toBe("child:");
  });

  it("不同 taskId → 不同键(不撞会话)", () => {
    expect(resumeSessionKey("t1")).not.toBe(resumeSessionKey("t2"));
  });
});
