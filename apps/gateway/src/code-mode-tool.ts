/**
 * M147 工具面即 SDK(PTC/代码模式):一个 `run_code` 调用完成多步工具链。
 *
 * 病灶(机制「工具面即 SDK」):
 * - 多步工具链每步烧一次推理轮(模型看结果→决定下一步),N 步=N 次完整往返;
 * - 中间结果(文件全文/日志/列表)全部倒进模型上下文;
 * - 工具多到选不动(wire schema 常驻)。
 *
 * 本模块把已注册工具投影成沙箱里的 `tools` SDK:模型写一段 async 代码,
 * 沙箱内 `await tools.<name>(args)` 逐个走正常执行管线(executeSub 注入=权限/plan-gate/超时),
 * 只回**最终返回值 + 子调用账本 + console logs**。核心工具仍 eager 暴露(本工具不替代它们)。
 *
 * 设计纪律:
 * - 沙箱用 `node:vm.runInNewContext`,globals 只给 tools/console/Math/JSON/Number/String/Array/Object/Promise;
 *   无 require/process/fetch/setTimeout/import(越界访问=ReferenceError 进 ok:false)。
 *   **非强隔离**:vm 是进程内上下文隔离,不是安全边界(残留,见交付回执)。
 * - 子调用逐个过 permission predicate(装配方注入现网 plan-gate/权限判据;缺省放行但照常记账);
 * - 限额:maxCalls/perCallTimeoutMs/totalTimeoutMs/maxOutputChars/concurrency(信号量,排队不报错);
 * - 稳定码:UNKNOWN_TOOL / PERMISSION_DENIED / CODE_LIMIT_CALLS / CODE_TIMEOUT / CODE_OUTPUT_TRUNCATED;
 * - 账本:每个真实子调用落 journal custom `code.mode.call`(失败静默,不影响执行)。
 */
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import type { Tool } from "@lampgenie/runtime/agent/loop";

export interface CodeModeLimits {
  /** 单次 run_code 内最多子调用次数(缺省 40;第 41 次返回 CODE_LIMIT_CALLS)。 */
  maxCalls?: number;
  /** 单个子调用超时(缺省 30_000ms;超时返回 CODE_TIMEOUT,后续调用不受影响)。 */
  perCallTimeoutMs?: number;
  /** 整段代码总时长(缺省 120_000ms)。 */
  totalTimeoutMs?: number;
  /** 返回给模型的结果文本上限(缺省 20_000 字符,超限截断并标 CODE_OUTPUT_TRUNCATED)。 */
  maxOutputChars?: number;
  /** 同时执行的子调用上限(缺省 3;超出的排队,不报错、不丢)。 */
  concurrency?: number;
}

const DEFAULT_LIMITS: Required<CodeModeLimits> = {
  maxCalls: 40,
  perCallTimeoutMs: 30_000,
  totalTimeoutMs: 120_000,
  maxOutputChars: 20_000,
  concurrency: 3,
};

/** 子调用执行器(装配方实现:调用目标工具的 execute,复用其超时/审批/plan-gate)。 */
export interface CodeModeSubCallOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}
export type CodeModeSubExecutor = (
  name: string,
  args: unknown,
  opts: CodeModeSubCallOptions,
) => Promise<string>;

/** 子调用权限判据(装配方注入现网 plan-gate/权限规则;缺省=放行但照常落账本)。 */
export type CodeModePermissionResult = boolean | { allow: boolean; reason?: string };
export type CodeModePermission = (
  name: string,
  args: unknown,
) => CodeModePermissionResult | Promise<CodeModePermissionResult>;

/** 账本最小依赖(只用到 custom append;失败静默)。 */
export interface CodeModeJournal {
  append(event: { kind: "custom"; sessionId: string; payload: Record<string, unknown> }): unknown;
}

export interface CreateCodeModeToolOptions {
  /** 已注册工具清单(装配方传入当前任务的实际工具面)。 */
  tools: readonly Tool[];
  /** 子调用执行体:复用正常执行管线(超时/plan-gate/审批)。 */
  executeSub: CodeModeSubExecutor;
  /** 追加到签名清单后的补充说明(可选)。 */
  describe?: (name: string) => string | undefined;
  limits?: CodeModeLimits;
  permission?: CodeModePermission;
  journal?: CodeModeJournal;
  sessionId?: string;
  taskId?: string;
}

interface SubCallRecord {
  tool: string;
  argsHash: string;
  durationMs: number;
  ok: boolean;
  error?: string;
}

/** JSON Schema 类型 → 紧凑签名类型(只认 type/enum/anyOf,其余 unknown)。 */
function typeOfSchema(schema: unknown): string {
  const o = (schema ?? {}) as { type?: unknown; enum?: unknown[]; anyOf?: Array<{ type?: unknown }> };
  if (Array.isArray(o.enum) && o.enum.length > 0) return o.enum.map((v) => JSON.stringify(v)).join("|");
  if (Array.isArray(o.type)) return o.type.filter((t) => typeof t === "string").join("|") || "unknown";
  if (typeof o.type === "string") return o.type;
  if (Array.isArray(o.anyOf)) {
    const parts = o.anyOf.map((x) => x?.type).filter((t): t is string => typeof t === "string");
    if (parts.length > 0) return [...new Set(parts)].join("|");
  }
  return "unknown";
}

/**
 * 由工具名 + parameters.required/properties 生成紧凑签名:
 *   `add(a:number, b:number)`,可选参数带 `?`(`upper(text:string, locale?:string)`)。
 * run_code 自身不入清单(禁递归,装配方已过滤,这里再兜一层)。
 */
export function toolSignature(tool: { name: string; parameters: Record<string, unknown> }): string {
  const params = (tool.parameters?.properties ?? {}) as Record<string, unknown>;
  const required = new Set<string>(
    Array.isArray(tool.parameters?.required)
      ? (tool.parameters.required as unknown[]).filter((x): x is string => typeof x === "string")
      : [],
  );
  // required 在前,optional 在后(模型一眼看到必填项)。
  const names = Object.keys(params).sort((a, b) => Number(required.has(b)) - Number(required.has(a)));
  const rendered = names.map((n) => `${n}${required.has(n) ? "" : "?"}:${typeOfSchema(params[n])}`);
  return `${tool.name}(${rendered.join(", ")})`;
}

/** 构造签名清单文本(工具描述与 code 参数说明共用同一份,防两处口径漂移)。 */
export function buildSignatureList(tools: readonly Tool[], describe?: (name: string) => string | undefined): string {
  return tools
    .filter((t) => t.name !== "run_code")
    .map((t) => {
      const hint = describe?.(t.name);
      return hint ? `${toolSignature(t)}  // ${hint}` : toolSignature(t);
    })
    .join("\n");
}

/** 稳定序列化(键排序),用于 argsHash 跨调用可比。 */
function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function hashArgs(args: unknown): string {
  return createHash("sha1").update(stableStringify(args ?? {})).digest("hex").slice(0, 12);
}

/** 结果值 → 返回文本:string 原样,其它 JSON 序列化(不可序列化则 String)。 */
function toResultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function formatLogArg(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** 并发信号量(超出 concurrency 的调用排队等待,不报错、不丢)。 */
function createSemaphore(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  return async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      const next = queue.shift();
      if (next) next();
    }
  };
}

async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      const e = new Error(`子调用超时(${ms}ms)`) as Error & { code?: string };
      e.code = "CODE_TIMEOUT";
      reject(e);
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createCodeModeTool(opts: CreateCodeModeToolOptions): Tool {
  const limits: Required<CodeModeLimits> = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
  const toolMap = new Map(opts.tools.filter((t) => t.name !== "run_code").map((t) => [t.name, t]));
  const signatures = buildSignatureList(opts.tools, opts.describe);
  const description = [
    "代码模式(PTC/工具面即 SDK):一次调用执行多步工具链,只回最终返回值+子调用账本,省掉每步一次推理轮,中间结果不进上下文。",
    "沙箱内用 `await tools.<name>(args)` 调用已注册工具(单个子调用照常过权限/plan-gate/超时);子调用返回工具结果文本(string),结构化结果需自行 JSON.parse;console.log 会被捕获进 logs。",
    "沙箱无 require/process/fetch/setTimeout/import(越界访问抛 ReferenceError);代码在 async 函数体内执行,用 `return` 返回结果。",
    "可用工具签名(必填参数在前,`?`=可选):",
    signatures,
    `限额:≤${limits.maxCalls} 次子调用、单次 ${limits.perCallTimeoutMs}ms、总时长 ${limits.totalTimeoutMs}ms、返回文本 ≤${limits.maxOutputChars} 字符、并发 ${limits.concurrency}。`,
  ].join("\n");

  return {
    name: "run_code",
    description,
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "在 async 函数体内执行的 JS 代码,用 `return` 返回结果。示例:`const a = await tools.add({a:1,b:2}); const b = await tools.upper({text:\"x\"}); return {a,b};`\n可用工具签名:\n" +
            signatures,
        },
        purpose: { type: "string", description: "这次多步工具链的目的(可选,便于审计)。" },
      },
      required: ["code"],
    },
    // 自管超时(totalTimeoutMs),豁免 loop 统一帽;有副作用(工具调用),不可并行安全。
    timeoutMs: 0,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async execute(rawArgs: unknown): Promise<string> {
      const a = (rawArgs ?? {}) as { code?: unknown };
      const code = typeof a.code === "string" ? a.code : "";
      const calls: SubCallRecord[] = [];
      const logs: string[] = [];
      if (!code.trim()) {
        return JSON.stringify({ ok: false, code: "INVALID_INPUT", error: "code 不能为空", calls, logs });
      }

      const withSlot = createSemaphore(limits.concurrency);
      const startedAt = Date.now();
      const deadline = startedAt + limits.totalTimeoutMs;
      let callCount = 0;

      const journalCall = (record: SubCallRecord): void => {
        if (!opts.journal) return;
        try {
          opts.journal.append({
            kind: "custom",
            sessionId: opts.sessionId ?? "",
            payload: {
              type: "code.mode.call",
              sessionId: opts.sessionId,
              taskId: opts.taskId,
              tool: record.tool,
              argsHash: record.argsHash,
              durationMs: record.durationMs,
              ok: record.ok,
              ...(record.error ? { error: record.error } : {}),
              codeMode: true,
            },
          });
        } catch {
          /* 账本失败静默:不影响代码执行与返回 */
        }
      };

      /** 子调用入口:限额 → 未知工具 → 权限 → 并发/超时 → executeSub → 记账。 */
      const invoke = async (name: string, rawCallArgs: unknown): Promise<unknown> => {
        if (callCount >= limits.maxCalls) {
          return { error: "CODE_LIMIT_CALLS", message: `已超过 maxCalls=${limits.maxCalls},本次子调用被拒绝` };
        }
        callCount += 1;
        const target = toolMap.get(name);
        if (!target) return { error: "UNKNOWN_TOOL", message: `未知工具:${name}` };

        if (opts.permission) {
          let verdict: CodeModePermissionResult;
          try {
            verdict = await opts.permission(name, rawCallArgs);
          } catch (e) {
            verdict = { allow: false, reason: e instanceof Error ? e.message : String(e) };
          }
          const allow = typeof verdict === "boolean" ? verdict : verdict.allow;
          if (!allow) {
            const reason = typeof verdict === "object" ? (verdict.reason ?? "权限拒绝") : "权限拒绝";
            const record: SubCallRecord = { tool: name, argsHash: hashArgs(rawCallArgs), durationMs: 0, ok: false, error: "PERMISSION_DENIED" };
            calls.push(record);
            journalCall(record);
            return { error: "PERMISSION_DENIED", reason, message: reason };
          }
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return { error: "CODE_TIMEOUT", message: "整段代码已超过 totalTimeoutMs,子调用被拒绝" };
        }
        const timeoutMs = Math.min(limits.perCallTimeoutMs, remaining);
        const ac = new AbortController();
        const record: SubCallRecord = { tool: name, argsHash: hashArgs(rawCallArgs), durationMs: 0, ok: false };
        calls.push(record);
        const t0 = Date.now();
        try {
          const text = await withSlot(() =>
            withTimeout(opts.executeSub(name, rawCallArgs, { timeoutMs, signal: ac.signal }), timeoutMs, () => ac.abort()),
          );
          record.ok = true;
          record.durationMs = Date.now() - t0;
          journalCall(record);
          return text;
        } catch (e) {
          const code = (e as { code?: string })?.code === "CODE_TIMEOUT" ? "CODE_TIMEOUT" : "CALL_FAILED";
          record.ok = false;
          record.error = code;
          record.durationMs = Date.now() - t0;
          journalCall(record);
          return { error: code, message: e instanceof Error ? e.message : String(e) };
        }
      };

      const toolProxy = new Proxy(Object.create(null) as Record<string, unknown>, {
        get(_target, prop) {
          if (typeof prop !== "string") return undefined;
          return async (callArgs?: unknown) => invoke(prop, callArgs ?? {});
        },
        has() {
          return true;
        },
      });

      const sandbox: Record<string, unknown> = {
        tools: toolProxy,
        console: {
          log: (...args: unknown[]) => logs.push(args.map(formatLogArg).join(" ")),
          info: (...args: unknown[]) => logs.push(args.map(formatLogArg).join(" ")),
          warn: (...args: unknown[]) => logs.push("[warn] " + args.map(formatLogArg).join(" ")),
          error: (...args: unknown[]) => logs.push("[error] " + args.map(formatLogArg).join(" ")),
        },
        // 显式白名单:沙箱内不注入任何宿主能力(require/process/fetch/setTimeout 都不存在)。
        Math,
        JSON,
        Number,
        String,
        Array,
        Object,
        Promise,
      };

      let timer: ReturnType<typeof setTimeout> | undefined;
      const totalTimeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const e = new Error(`代码总时长超过 ${limits.totalTimeoutMs}ms`) as Error & { code?: string };
          e.code = "CODE_TIMEOUT";
          reject(e);
        }, limits.totalTimeoutMs);
      });

      try {
        const wrapped = `(async () => {\n${code}\n})()`;
        const value = await Promise.race([
          Promise.resolve(runInNewContext(wrapped, sandbox, { timeout: limits.totalTimeoutMs, filename: "run_code.vm" })),
          totalTimeout,
        ]);
        const text = toResultText(value);
        let out = text;
        let truncated = false;
        if (out.length > limits.maxOutputChars) {
          out = out.slice(0, limits.maxOutputChars) + `\n…[结果已截断:原长 ${text.length} 字符]`;
          truncated = true;
        }
        return JSON.stringify({
          ok: true,
          result: out,
          ...(truncated ? { truncated: true, code: "CODE_OUTPUT_TRUNCATED" } : {}),
          calls,
          logs,
        });
      } catch (e) {
        const err = e as Error & { code?: string };
        const timedOut = err.code === "CODE_TIMEOUT";
        return JSON.stringify({
          ok: false,
          code: timedOut ? "CODE_TIMEOUT" : "CODE_EXEC_ERROR",
          error: err.message ?? String(e),
          errorName: err.name,
          calls,
          logs,
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
