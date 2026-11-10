/**
 * typed ask 提交修复协议纯逻辑:递归 schema 校验 / 同 turn 回 violation / 3 次 repair 上限 /
 * 一次 nudge / 修复文案。全纯函数直测,不触 IO。
 * 断言锁的是对外契约(violation 三要素与 TYPED_* 稳定码),不是实现细节。
 */
import { describe, expect, it } from "vitest";
import {
  createTypedAsk,
  describeGot,
  nudgeIfNoSubmit,
  remainingRepairs,
  repairPrompt,
  submitResult,
  TYPED_ALREADY_SETTLED,
  TYPED_CODES,
  TYPED_INVALID,
  TYPED_MAX_REPAIRS,
  TYPED_NUDGE_MESSAGE,
  TYPED_NUDGED,
  TYPED_NOT_FOUND,
  TYPED_SUBMITTED,
  TYPED_VALIDATION_FAILED,
  TYPED_VIOLATION,
  validateAgainstSchema,
  type JsonSchema,
  type TypedAskState,
} from "../src/agent/typed-submit.ts";

const NAME_SCHEMA: JsonSchema = {
  type: "object",
  required: ["name"],
  properties: { name: { type: "string" } },
};

function openState(askId = "ask-1"): TypedAskState {
  return createTypedAsk(askId);
}

describe("typed-submit / validateAgainstSchema 基础类型", () => {
  it("合法 object 通过且 violations 为空", () => {
    const result = validateAgainstSchema({ name: "ok" }, NAME_SCHEMA);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("缺 required 字段:path=name expected=string got=undefined(逐字)", () => {
    const result = validateAgainstSchema({}, NAME_SCHEMA);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toEqual({ path: "name", expected: "string", got: "undefined" });
  });

  it("多个 required 缺失各报一条", () => {
    const schema: JsonSchema = {
      type: "object",
      required: ["a", "b"],
      properties: { a: { type: "string" }, b: { type: "number" } },
    };
    const paths = validateAgainstSchema({}, schema).violations.map((v) => v.path);
    expect(paths).toEqual(["a", "b"]);
  });

  it("required 但值为 undefined 也算缺失", () => {
    const result = validateAgainstSchema({ name: undefined }, NAME_SCHEMA);
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.got).toBe("undefined");
  });

  it("类型错:string 期望拿到 number 时 got 是 123", () => {
    const result = validateAgainstSchema({ name: 123 }, NAME_SCHEMA);
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toEqual({ path: "name", expected: "string", got: "123" });
  });

  it("可选字段缺失不报错", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { name: { type: "string" }, note: { type: "string" } },
    };
    expect(validateAgainstSchema({ name: "x" }, schema).ok).toBe(true);
  });

  it("显式 null 与缺失区分:string 期望下 null 得 got=null", () => {
    const result = validateAgainstSchema({ name: null }, NAME_SCHEMA);
    expect(result.violations[0]?.got).toBe("null");
    expect(result.violations[0]?.expected).toBe("string");
  });

  it("并列 type 数组:[\"string\",\"null\"] 接受 null", () => {
    const schema: JsonSchema = { type: "object", properties: { name: { type: ["string", "null"] } } };
    expect(validateAgainstSchema({ name: null }, schema).ok).toBe(true);
    expect(validateAgainstSchema({ name: 1 }, schema).ok).toBe(false);
  });

  it("boolean 类型校验", () => {
    const schema: JsonSchema = { type: "boolean" };
    expect(validateAgainstSchema(true, schema).ok).toBe(true);
    expect(validateAgainstSchema("true", schema).violations[0]).toEqual({
      path: "(root)",
      expected: "boolean",
      got: '"true"',
    });
  });

  it("integer 拒绝小数", () => {
    const schema: JsonSchema = { type: "integer" };
    expect(validateAgainstSchema(2, schema).ok).toBe(true);
    const bad = validateAgainstSchema(1.5, schema);
    expect(bad.ok).toBe(false);
    expect(bad.violations[0]).toEqual({ path: "(root)", expected: "integer", got: "1.5" });
  });

  it("number 拒绝 NaN", () => {
    const result = validateAgainstSchema(Number.NaN, { type: "number" });
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.got).toBe("NaN");
  });

  it("顶层类型不符时 path 是 (root)", () => {
    const result = validateAgainstSchema([], { type: "object" });
    expect(result.violations[0]?.path).toBe("(root)");
    expect(result.violations[0]?.got).toBe("array(0)");
  });
});

describe("typed-submit / validateAgainstSchema 嵌套与数组", () => {
  it("嵌套对象路径 a.b", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { a: { type: "object", properties: { b: { type: "string" } } } },
    };
    const result = validateAgainstSchema({ a: { b: 1 } }, schema);
    expect(result.violations[0]).toEqual({ path: "a.b", expected: "string", got: "1" });
  });

  it("嵌套 required 用点路径:", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        a: { type: "object", required: ["b"], properties: { b: { type: "number" } } },
      },
    };
    const result = validateAgainstSchema({ a: {} }, schema);
    expect(result.violations[0]).toEqual({ path: "a.b", expected: "number", got: "undefined" });
  });

  it("数组 items 路径 items[0]", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { items: { type: "array", items: { type: "string" } } },
    };
    const result = validateAgainstSchema({ items: [1] }, schema);
    expect(result.violations[0]).toEqual({ path: "items[0]", expected: "string", got: "1" });
  });

  it("数组多元素违例各报一条", () => {
    const schema: JsonSchema = { type: "array", items: { type: "number" } };
    const paths = validateAgainstSchema(["a", 2, "c"], schema).violations.map((v) => v.path);
    expect(paths).toEqual(["[0]", "[2]"]);
  });

  it("自定义 path 前缀参与拼接", () => {
    const result = validateAgainstSchema({}, NAME_SCHEMA, "result");
    expect(result.violations[0]?.path).toBe("result.name");
  });

  it("enum 命中通过", () => {
    const schema: JsonSchema = { type: "string", enum: ["a", "b"] };
    expect(validateAgainstSchema("b", schema).ok).toBe(true);
  });

  it("enum 不命中:expected 列出候选", () => {
    const result = validateAgainstSchema("c", { type: "string", enum: ["a", "b"] });
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.expected).toBe('enum("a"|"b")');
    expect(result.violations[0]?.got).toBe('"c"');
  });

  it("畸形 schema 不抛(required 给字符串)", () => {
    const schema = { required: "name" } as unknown as JsonSchema;
    expect(() => validateAgainstSchema({}, schema)).not.toThrow();
  });

  it("循环引用值不抛", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => validateAgainstSchema(cyclic, { type: "object" })).not.toThrow();
    expect(validateAgainstSchema(cyclic, { type: "object" }).ok).toBe(true);
  });
});

describe("typed-submit / submitResult 结算门槛", () => {
  it("首次合法提交才 settle 并保留 payload", () => {
    const out = submitResult(openState(), { name: "ok" }, NAME_SCHEMA);
    expect(out.ok).toBe(true);
    expect(out.state.status).toBe("settled");
    expect(out.state.payload).toEqual({ name: "ok" });
    expect(out.state.attempts).toBe(0);
    expect(out.codes).toEqual([TYPED_SUBMITTED]);
    expect(out.violations).toBeUndefined();
  });

  it("校验失败不 settle:attempts+1 且回 violations", () => {
    const out = submitResult(openState(), {}, NAME_SCHEMA);
    expect(out.ok).toBe(false);
    expect(out.state.status).toBe("open");
    expect(out.state.attempts).toBe(1);
    expect(out.violations?.[0]).toEqual({ path: "name", expected: "string", got: "undefined" });
    expect(out.codes).toEqual([TYPED_VIOLATION]);
  });

  it("失败三次仍在 open,且 attempts 严格递增", () => {
    let state = openState();
    for (let i = 1; i <= TYPED_MAX_REPAIRS; i += 1) {
      const out = submitResult(state, {}, NAME_SCHEMA);
      state = out.state;
      expect(out.ok).toBe(false);
      expect(state.status).toBe("open");
      expect(state.attempts).toBe(i);
    }
  });

  it("第 4 次失败转 failed 并同时给 VIOLATION 与 VALIDATION_FAILED", () => {
    let state = openState();
    for (let i = 0; i < TYPED_MAX_REPAIRS; i += 1) state = submitResult(state, {}, NAME_SCHEMA).state;
    const out = submitResult(state, {}, NAME_SCHEMA);
    expect(out.ok).toBe(false);
    expect(out.state.status).toBe("failed");
    expect(out.state.attempts).toBe(4);
    expect(out.codes).toEqual([TYPED_VIOLATION, TYPED_VALIDATION_FAILED]);
    expect(out.violations).toHaveLength(1);
  });

  it("失败后合法提交照样 settle,attempts 保留", () => {
    const first = submitResult(openState(), {}, NAME_SCHEMA);
    const second = submitResult(first.state, { name: "late" }, NAME_SCHEMA);
    expect(second.ok).toBe(true);
    expect(second.state.status).toBe("settled");
    expect(second.state.attempts).toBe(1);
    expect(second.state.payload).toEqual({ name: "late" });
  });

  it("已 settled 再提交 → TYPED_ALREADY_SETTLED 且 payload 不被覆盖", () => {
    const settled = submitResult(openState(), { name: "first" }, NAME_SCHEMA).state;
    const again = submitResult(settled, { name: "second" }, NAME_SCHEMA);
    expect(again.ok).toBe(false);
    expect(again.codes).toEqual([TYPED_ALREADY_SETTLED]);
    expect(again.state.payload).toEqual({ name: "first" });
    expect(again.state.status).toBe("settled");
  });

  it("已 failed 再提交 → TYPED_ALREADY_SETTLED,停顿在 failed", () => {
    const failed: TypedAskState = { ...openState(), attempts: 4, status: "failed" };
    const out = submitResult(failed, { name: "ok" }, NAME_SCHEMA);
    expect(out.ok).toBe(false);
    expect(out.codes).toEqual([TYPED_ALREADY_SETTLED]);
    expect(out.state.status).toBe("failed");
  });

  it("submitResult 不改入参 state(纯函数)", () => {
    const state = openState();
    submitResult(state, {}, NAME_SCHEMA);
    expect(state).toEqual({ askId: "ask-1", attempts: 0, nudged: false, status: "open" });
  });
});

describe("typed-submit / nudgeIfNoSubmit 一次 nudge", () => {
  it("turn 未结束时 nudge 不生效", () => {
    const out = nudgeIfNoSubmit(openState(), { turnEnded: false });
    expect(out.nudged).toBe(false);
    expect(out.codes).toEqual([]);
    expect(out.state.nudged).toBe(false);
  });

  it("turn 结束仍 open → 打 nudged 并返回固定文案", () => {
    const out = nudgeIfNoSubmit(openState(), { turnEnded: true });
    expect(out.nudged).toBe(true);
    expect(out.codes).toEqual([TYPED_NUDGED]);
    expect(out.message).toBe(TYPED_NUDGE_MESSAGE);
    expect(out.state.nudged).toBe(true);
    expect(out.state.status).toBe("open");
  });

  it("已 nudge 过再结束仍无 submit → failed + VALIDATION_FAILED", () => {
    const once = nudgeIfNoSubmit(openState(), { turnEnded: true });
    const twice = nudgeIfNoSubmit(once.state, { turnEnded: true });
    expect(twice.nudged).toBe(false);
    expect(twice.state.status).toBe("failed");
    expect(twice.codes).toEqual([TYPED_VALIDATION_FAILED]);
  });

  it("nudge 之后合法提交仍可 settle", () => {
    const once = nudgeIfNoSubmit(openState(), { turnEnded: true });
    const out = submitResult(once.state, { name: "ok" }, NAME_SCHEMA);
    expect(out.ok).toBe(true);
    expect(out.state.status).toBe("settled");
  });

  it("已 settled 时 nudge → ALREADY_SETTLED", () => {
    const settled = submitResult(openState(), { name: "ok" }, NAME_SCHEMA).state;
    const out = nudgeIfNoSubmit(settled, { turnEnded: true });
    expect(out.nudged).toBe(false);
    expect(out.codes).toEqual([TYPED_ALREADY_SETTLED]);
  });
});

describe("typed-submit / 修复文案与辅助", () => {
  it("repairPrompt 逐条输出 path/expected/got", () => {
    const text = repairPrompt([{ path: "name", expected: "string", got: "undefined" }]);
    expect(text).toContain("path=name expected=string got=undefined");
    expect(text.startsWith("提交结果未通过 schema 校验")).toBe(true);
  });

  it("repairPrompt 多违例逐行", () => {
    const text = repairPrompt([
      { path: "a", expected: "string", got: "1" },
      { path: "b", expected: "number", got: "undefined" },
    ]);
    expect(text.split("\n")).toHaveLength(3);
    expect(text).toContain("path=b expected=number got=undefined");
  });

  it("repairPrompt 空违例走兜底文案", () => {
    expect(repairPrompt([])).toBe("提交结果未通过 schema 校验,请重新调用 submit_result。");
  });

  it("remainingRepairs:0→3、3→0、终态→0", () => {
    expect(remainingRepairs(openState())).toBe(3);
    expect(remainingRepairs({ ...openState(), attempts: 3 })).toBe(0);
    expect(remainingRepairs({ ...openState(), status: "settled" })).toBe(0);
    expect(remainingRepairs({ ...openState(), status: "failed" })).toBe(0);
  });

  it("createTypedAsk 初值", () => {
    expect(createTypedAsk("a")).toEqual({ askId: "a", attempts: 0, nudged: false, status: "open" });
  });

  it("describeGot 对 undefined/null/数组/长字符串的形态", () => {
    expect(describeGot(undefined)).toBe("undefined");
    expect(describeGot(null)).toBe("null");
    expect(describeGot([1, 2])).toBe("array(2)");
    expect(describeGot("x".repeat(200))).toContain("…");
  });

  it("稳定码字面量", () => {
    expect(TYPED_INVALID).toBe("TYPED_INVALID");
    expect(TYPED_SUBMITTED).toBe("TYPED_SUBMITTED");
    expect(TYPED_VIOLATION).toBe("TYPED_VIOLATION");
    expect(TYPED_NUDGED).toBe("TYPED_NUDGED");
    expect(TYPED_VALIDATION_FAILED).toBe("TYPED_VALIDATION_FAILED");
    expect(TYPED_ALREADY_SETTLED).toBe("TYPED_ALREADY_SETTLED");
    expect(TYPED_NOT_FOUND).toBe("TYPED_NOT_FOUND");
    expect(TYPED_CODES.VALIDATION_FAILED).toBe(TYPED_VALIDATION_FAILED);
    expect(TYPED_MAX_REPAIRS).toBe(3);
  });
});
