/**
 * typed ask 的提交修复协议(RSI #31):schema 校验失败不整轮重派,而是同 turn 把
 * violation(path/expected/got)作为 tool error 回给子代理,最多 3 次 repair + 1 次 nudge,
 * 只有通过 schema 的 submit 才能 settle。
 * 全纯函数,不触 IO;落盘与投影在 apps/gateway/src/typed-submit-store.ts。
 */

export type JsonSchemaType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null";

/** 支持的 schema 子集:足够覆盖 typed ask 的结果契约,不追 JSON Schema 全集。 */
export interface JsonSchema {
  type?: JsonSchemaType | JsonSchemaType[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
}

/** 一处校验失败:路径 / 期望 / 实际值(got 为 undefined 时字面量 "undefined")。 */
export interface Violation {
  path: string;
  expected: string;
  got: string;
}

export type TypedStatus = "open" | "settled" | "failed";

export interface TypedAskState {
  askId: string;
  /** 已用掉的 repair 次数(校验失败的 submit 计数)。 */
  attempts: number;
  /** 是否已经 nudge 过一次(只一次)。 */
  nudged: boolean;
  status: TypedStatus;
  /** 仅 status="settled" 时才存在。 */
  payload?: unknown;
}

/** 允许的 repair 次数;第 MAX+1 次校验失败直接转 failed。 */
export const TYPED_MAX_REPAIRS = 3;

export const TYPED_INVALID = "TYPED_INVALID";
export const TYPED_SUBMITTED = "TYPED_SUBMITTED";
export const TYPED_VIOLATION = "TYPED_VIOLATION";
export const TYPED_NUDGED = "TYPED_NUDGED";
export const TYPED_VALIDATION_FAILED = "TYPED_VALIDATION_FAILED";
export const TYPED_ALREADY_SETTLED = "TYPED_ALREADY_SETTLED";
export const TYPED_NOT_FOUND = "TYPED_NOT_FOUND";

export const TYPED_CODES = {
  INVALID: TYPED_INVALID,
  SUBMITTED: TYPED_SUBMITTED,
  VIOLATION: TYPED_VIOLATION,
  NUDGED: TYPED_NUDGED,
  VALIDATION_FAILED: TYPED_VALIDATION_FAILED,
  ALREADY_SETTLED: TYPED_ALREADY_SETTLED,
  NOT_FOUND: TYPED_NOT_FOUND,
} as const;

/** turn 结束时仍 open 且未 nudge 的固定文案(只发一次)。 */
export const TYPED_NUDGE_MESSAGE =
  "本轮结束但尚未调用 submit_result:请立即调用 submit_result 提交结果;" +
  "若结果不符合 schema,会以 tool error 返回 violations(path/expected/got),逐条修正后重新提交。";

export interface ValidateResult {
  ok: boolean;
  violations: Violation[];
}

export interface SubmitOutcome {
  state: TypedAskState;
  ok: boolean;
  violations?: Violation[];
  codes: string[];
}

export interface NudgeOutcome {
  state: TypedAskState;
  nudged: boolean;
  message?: string;
  codes: string[];
}

/** 新建一个 open 态的 typed ask。 */
export function createTypedAsk(askId: string): TypedAskState {
  return { askId, attempts: 0, nudged: false, status: "open" };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function joinPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function clip(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** got 的可读描述:undefined 逐字 "undefined"(契约要求)。 */
export function describeGot(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  const t = typeof value;
  if (t === "string") return clip(JSON.stringify(value));
  if (t === "object") return "object";
  return clip(String(value));
}

function typeMatches(value: unknown, type: JsonSchemaType): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
  }
}

function expectedOf(schema: JsonSchema | undefined): string {
  if (!schema) return "defined";
  if (schema.type) return Array.isArray(schema.type) ? schema.type.join("|") : schema.type;
  if (schema.enum) return `enum(${schema.enum.map(describeGot).join("|")})`;
  return "defined";
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function walk(value: unknown, schema: JsonSchema, path: string, out: Violation[]): void {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      out.push({
        path: path || "(root)",
        expected: types.join("|"),
        got: describeGot(value),
      });
      return; // 类型不对就不再下钻,避免噪音违例
    }
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    if (!schema.enum.some((candidate) => sameValue(candidate, value))) {
      out.push({
        path: path || "(root)",
        expected: `enum(${schema.enum.map(describeGot).join("|")})`,
        got: describeGot(value),
      });
    }
  }

  if (Array.isArray(value) && schema.items) {
    const items = schema.items;
    value.forEach((item, index) => walk(item, items, `${path}[${index}]`, out));
  }

  if (isPlainObject(value)) {
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) {
        out.push({
          path: joinPath(path, key),
          expected: props[key] ? expectedOf(props[key]) : "defined",
          got: "undefined",
        });
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      const child = value[key];
      if (child === undefined) continue; // 可选字段缺失不报;required 已在上方覆盖
      walk(child, sub, joinPath(path, key), out);
    }
  }
}

/** 递归校验 value 是否满足 schema;绝不抛异常(内部异常降级为一条 violation)。 */
export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  path = "",
): ValidateResult {
  const violations: Violation[] = [];
  try {
    walk(value, schema ?? {}, path, violations);
  } catch (error) {
    violations.push({
      path: path || "(root)",
      expected: "valid-schema",
      got: clip(`schema-error: ${(error as Error)?.message ?? String(error)}`),
    });
  }
  return { ok: violations.length === 0, violations };
}

/**
 * 提交结果:通过 schema 才 settle;失败 attempts+1 并回 violations(供同 turn 当 tool error 回给模型)。
 * 第 TYPED_MAX_REPAIRS+1 次失败 → status=failed + TYPED_VALIDATION_FAILED。
 */
export function submitResult(
  state: TypedAskState,
  payload: unknown,
  schema: JsonSchema): SubmitOutcome {
  if (state.status !== "open") {
    return { state: { ...state }, ok: false, codes: [TYPED_ALREADY_SETTLED] };
  }
  const detail = validateAgainstSchema(payload, schema);
  if (detail.ok) {
    return {
      state: { ...state, status: "settled", payload },
      ok: true,
      codes: [TYPED_SUBMITTED],
    };
  }
  const attempts = state.attempts + 1;
  const exhausted = attempts > TYPED_MAX_REPAIRS;
  return {
    state: { ...state, attempts, status: exhausted ? "failed" : "open" },
    ok: false,
    violations: detail.violations,
    codes: exhausted ? [TYPED_VIOLATION, TYPED_VALIDATION_FAILED] : [TYPED_VIOLATION],
  };
}

/**
 * turn 结束时补一次 nudge:open 且未 nudge → 打 nudged 标记并返回固定文案(只一次);
 * 已 nudge 过仍无 submit → failed(TYPED_VALIDATION_FAILED)。
 */
export function nudgeIfNoSubmit(
  state: TypedAskState,
  opts: { turnEnded: boolean },
): NudgeOutcome {
  if (state.status !== "open") {
    return { state: { ...state }, nudged: false, codes: [TYPED_ALREADY_SETTLED] };
  }
  if (!opts.turnEnded) {
    return { state: { ...state }, nudged: false, codes: [] };
  }
  if (!state.nudged) {
    return {
      state: { ...state, nudged: true },
      nudged: true,
      message: TYPED_NUDGE_MESSAGE,
      codes: [TYPED_NUDGED],
    };
  }
  return { state: { ...state, status: "failed" }, nudged: false, codes: [TYPED_VALIDATION_FAILED] };
}

/** 把 violations 拼成给模型看的修复提示(逐条 path/expected/got)。 */
export function repairPrompt(violations: Violation[]): string {
  const lines = violations.map((v) => `- path=${v.path} expected=${v.expected} got=${v.got}`);
  if (lines.length === 0) {
    return "提交结果未通过 schema 校验,请重新调用 submit_result。";
  }
  return ["提交结果未通过 schema 校验,请逐条修正后重新调用 submit_result:", ...lines].join(
    "\n",
  );
}

/** 剩余 repair 次数(已 failed/settled 为 0)。 */
export function remainingRepairs(state: TypedAskState): number {
  if (state.status !== "open") return 0;
  return Math.max(0, TYPED_MAX_REPAIRS - state.attempts);
}
