/**
 * 任务类别 → 模型/供应商路由表(gateway 工厂消费的纯逻辑层)。
 * 要治的病:主对话/压缩/标题/摘要/视觉/记忆/评审/日报/子代理九类任务共用一条模型链,
 * 导致压缩任务用贵模型烧钱、标题任务排队等主模型、vision 任务落到不支持图片的模型;
 * 而「没配就回落默认」与「配了但是坏的」在配置层无法区分。
 * 本模块零 IO(不读 env/文件)、不抛异常、不可变、确定性,只做两件事:
 * 1) resolveTaskModelRoute:把 (kind, taskClass, base, table, freeProviders) 解析成一条
 * 路由 + 来源标记(table/task-class/fallback/base),供工厂按序建客户端;
 * 2) validateRoutingTable:对整表做静态体检,产出机器可读的 RoutingIssue 列表。
 * 不变量:入参永不被修改(只读 + 浅拷贝出参),同输入恒同输出。
 */

/** 九类任务的稳定顺序(顺序参与确定性输出)。 */
export const TASK_MODEL_KINDS = [
  "main",
  "compact",
  "title",
  "summary",
  "vision",
  "memory",
  "review",
  "digest",
  "subagent",
] as const;

export type TaskModelKind = (typeof TASK_MODEL_KINDS)[number];

/** 一条路由说明:provider/模型/baseUrl/密钥环境变量,可带自己的回落链与匹配标签。 */
export interface RouteRef {
  providerId?: string;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  fallbackChain?: RouteRef[];
  freeOnly?: boolean;
  taskClasses?: string[];
}

export type TaskModelRoutingTable = Partial<Record<TaskModelKind, RouteRef>>;

/** 命中的来源:`table`=直接命中表项,`task-class`=按 taskClasses 命中,`fallback`=表项被过滤后用了回落,`base`=无表项走默认。 */
export type RouteSource = "table" | "task-class" | "fallback" | "base";

export type ResolveTaskModelRouteResult =
  | { ok: true; route: RouteRef; source: RouteSource; chain: RouteRef[] }
  | { ok: false; code: "INVALID" };

export type RoutingIssueCode =
  | "unknown-kind"
  | "invalid-entry"
  | "missing-endpoint"
  | "duplicate-fallback"
  | "free-only-without-provider"
  | "unknown-provider";

export interface RoutingIssue {
  code: RoutingIssueCode;
  kind: string;
  detail: string;
}

const INVALID: { ok: false; code: "INVALID" } = { ok: false, code: "INVALID" };

/** 普通对象判定:数组/null/原始值都不算(表项必须是普通对象)。 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 非空字符串判定(空串视为没配)。 */
function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** kind 判定:`TASK_MODEL_KINDS` 成员才算合法任务类别。 */
export function isTaskModelKind(v: unknown): v is TaskModelKind {
  return typeof v === "string" && (TASK_MODEL_KINDS as readonly string[]).includes(v);
}

/** 把 Iterable/ReadonlySet 收成 Set;非可迭代(含 undefined/null)按空集处理,绝不抛。 */
function toSet(v: unknown): Set<string> {
  if (v === undefined || v === null) return new Set<string>();
  try {
    if (typeof (v as Iterable<string>)[Symbol.iterator] !== "function") return new Set<string>();
    return new Set<string>(v as Iterable<string>);
  } catch {
    return new Set<string>();
  }
}

/** freeOnly 项的准入判定:必须是字符串 providerId 且在免费集合里。 */
function freeAllowed(item: Record<string, unknown>, free: Set<string>): boolean {
  if (item.freeOnly !== true) return true;
  const pid = item.providerId;
  return typeof pid === "string" && free.has(pid);
}

/** 去重键:providerId|model|baseUrl(任一缺失按空串)。 */
function dedupKey(item: Record<string, unknown>): string {
  const pid = typeof item.providerId === "string" ? item.providerId : "";
  const model = typeof item.model === "string" ? item.model : "";
  const baseUrl = typeof item.baseUrl === "string" ? item.baseUrl : "";
  return `${pid}|${model}|${baseUrl}`;
}

/**
 * 解析一条任务模型路由。
 * 优先级:表项(可选 taskClasses 门) → 表项 fallbackChain → base。任一步不可用时返回 INVALID,
 * 绝不抛异常;也不会修改 input(含 table/base/freeProviders)。
 */
export function resolveTaskModelRoute(input: {
  kind: string;
  taskClass?: string;
  base?: RouteRef;
  table?: Record<string, RouteRef> | undefined;
  freeProviders?: Iterable<string> | ReadonlySet<string>;
}): ResolveTaskModelRouteResult {
  try {
    const src: Record<string, unknown> = isPlainObject(input) ? (input as unknown as Record<string, unknown>) : {};
    const kind = src.kind;
 // 未知(或非字符串)kind 一律 INVALID——即便 table 里恰好有同名 key。
    if (!isTaskModelKind(kind)) return INVALID;

    const free = toSet(src.freeProviders);

 /** 无表项/表项不适用时的默认路径。 */
    const basePath = (): ResolveTaskModelRouteResult => {
      const base = src.base;
      if (!isPlainObject(base)) return INVALID;
 // freeOnly 的默认路由也必须落在免费供应商上,否则等于没配。
      if (base.freeOnly === true && !freeAllowed(base, free)) return INVALID;
      const copy: RouteRef = { ...(base as RouteRef) };
      return { ok: true, route: copy, source: "base", chain: [{ ...(base as RouteRef) }] };
    };

    const table = src.table;
    const entry = isPlainObject(table) ? (table as Record<string, unknown>)[kind] : undefined;
 // 没配该 kind(undefined/null):直接走默认,不视作错误。
    if (entry === undefined || entry === null) return basePath();
    if (!isPlainObject(entry)) return INVALID;

 // taskClasses 门:非空数组时,只有当前 taskClass 严格命中才可用。
    const classes = entry.taskClasses;
    if (Array.isArray(classes) && classes.length > 0) {
      const current = src.taskClass;
      const hit = typeof current === "string" && classes.some((c) => c === current);
 // 不命中:直接回默认,刻意不碰该表项的 fallbackChain(那是别的任务类别的链)。
      if (!hit) return basePath();
    }

    const rawChain: unknown[] = [entry, ...(Array.isArray(entry.fallbackChain) ? (entry.fallbackChain as unknown[]) : [])];
    const seen = new Set<string>();
    const chain: Record<string, unknown>[] = [];
    for (const item of rawChain) {
      if (!isPlainObject(item)) continue;
      if (!freeAllowed(item, free)) continue;
      const key = dedupKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      chain.push(item);
    }

    if (chain.length > 0) {
      const head = chain[0];
 // 表项本身被过滤掉(或被去重提前吃掉)时,首个可用项来自 fallbackChain。
      if (head !== (entry as Record<string, unknown>)) {
        return { ok: true, route: { ...(head as RouteRef) }, source: "fallback", chain: chain.map((x) => ({ ...(x as RouteRef) })) };
      }
      const source: RouteSource = Array.isArray(classes) && classes.length > 0 ? "task-class" : "table";
      return { ok: true, route: { ...(head as RouteRef) }, source, chain: chain.map((x) => ({ ...(x as RouteRef) })) };
    }
 // 全被滤掉(且没有可用 fallback):用默认路由兜底。
    return basePath();
  } catch {
    return INVALID;
  }
}

/**
 * 整表静态体检(面向 issue 文案与 CI 断言,不解析路由)。
 * 检查项:未知 kind / 表项非对象 / 无 providerId 也无 model / freeOnly 却没有 providerId /
 * 序列内重复项(含 fallback 重复表项) / providerId 不在已知供应商集合。
 */
export function validateRoutingTable(
  table: unknown,
  opts?: { knownProviders?: Iterable<string> },
): { ok: boolean; issues: RoutingIssue[] } {
  const issues: RoutingIssue[] = [];
  try {
    if (table === undefined) return { ok: true, issues: [] };
    if (!isPlainObject(table)) {
      return { ok: false, issues: [{ code: "invalid-entry", kind: "", detail: "路由表必须是对象" }] };
    }

    const knownRaw = isPlainObject(opts) ? (opts as Record<string, unknown>).knownProviders : undefined;
    const known = knownRaw === undefined || knownRaw === null ? undefined : toSet(knownRaw);

 // Object.keys 走 own 可枚举 key,顺序稳定(插入序),保证 issues 确定性。
    for (const kind of Object.keys(table)) {
      if (!isTaskModelKind(kind)) {
        issues.push({ code: "unknown-kind", kind, detail: `未知任务类别 ${kind}` });
        continue;
      }
      const entry = (table as Record<string, unknown>)[kind];
      if (!isPlainObject(entry)) {
        issues.push({ code: "invalid-entry", kind, detail: `表项必须是对象(实际 ${entry === null ? "null" : Array.isArray(entry) ? "array" : typeof entry})` });
        continue;
      }
      if (!nonEmptyString(entry.providerId) && !nonEmptyString(entry.model)) {
        issues.push({ code: "missing-endpoint", kind, detail: "既无 providerId 也无 model,无法发起请求" });
      }
      if (entry.freeOnly === true && !nonEmptyString(entry.providerId)) {
        issues.push({ code: "free-only-without-provider", kind, detail: "freeOnly 项必须显式给出 providerId" });
      }

 // 序列 = 表项 + 其 fallbackChain(只取普通对象项),按去重键查重。
      const seq: Record<string, unknown>[] = [entry];
      if (Array.isArray(entry.fallbackChain)) {
        for (const item of entry.fallbackChain as unknown[]) if (isPlainObject(item)) seq.push(item);
      }
      const seen = new Set<string>();
      for (const item of seq) {
        const key = dedupKey(item);
        if (seen.has(key)) {
          issues.push({ code: "duplicate-fallback", kind, detail: `重复路由 ${key}(表项或 fallbackChain 内出现多次)` });
          continue;
        }
        seen.add(key);
      }

      if (known) {
        for (const item of seq) {
          const pid = item.providerId;
          if (!nonEmptyString(pid) || known.has(pid)) continue;
          issues.push({ code: "unknown-provider", kind, detail: `未知供应商 ${pid}` });
        }
      }
    }
    return { ok: issues.length === 0, issues };
  } catch {
 // 极端入参(带 getter 抛出等):仍然给出可解释的失败,不抛异常。
    return { ok: false, issues: issues.length > 0 ? issues : [{ code: "invalid-entry", kind: "", detail: "路由表检查失败" }] };
  }
}
