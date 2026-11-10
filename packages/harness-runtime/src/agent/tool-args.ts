/**
 * 工具入参归一与校验诊断(机制 M150)。
 *
 * 病根:模型把参数写成「JSON 字符串里再套一层」「"42" / "true" / 裸标量当数组」等形态时,
 * 旧链路要么整轮重派、要么把 ajv/Zod 的原始 dump 丢给模型(它读不懂),要么静默强转污染数据。
 *
 * 本模块只做三件无歧义的事:
 *   1) JSON-string 归一:raw 是字符串就按文本形态解析一次(解不出/不是对象才报 issue);
 *   2) 无歧义 coercion:仅当 schema **声明**了该字段类型,且转换结果唯一(数字串→数字、
 *      "true"/"false"→布尔、裸标量→单元素数组、JSON 文本→数组/对象、标量→字符串);
 *      不确定(空串、混合、解析失败)一律**保留原值**交给工具,绝不猜;
 *   3) 结构化 issue(path/expected/got/message)+ 固定错误框,作为**工具结果**回给模型
 *      (不是 turn 失败,也不重派整轮)。
 *
 * 零回归:工具没有 parameters 或 schema 不是 object → 原样透传,连拷贝都不做。
 */

export interface ToolArgIssue {
  /** 出错位置:字段名;对象级问题用 "$"。 */
  path: string;
  /** 期望(如 "required" / "number" / "object")。 */
  expected: string;
  /** 实收值的类型描述(如 "undefined" / `string "abc"`)。 */
  got: string;
  /** 一句人话说明。 */
  message: string;
}

export interface ToolArgRename {
  from: string;
  to: string;
}

export interface ToolArgCoercion {
  path: string;
  /** 转换前类型。 */
  from: string;
  /** 转换后类型。 */
  to: string;
}

export interface ToolArgNormalizeResult {
  /** 无 issue 即 ok。**保留原值不算 issue**(不确定 ≠ 错)。 */
  ok: boolean;
  value: unknown;
  issues: ToolArgIssue[];
  renamed: ToolArgRename[];
  coerced: ToolArgCoercion[];
}

/** provider 化键名 → 本仓 schema 键名。仅在「schema 声明了目标键」且「目标键尚无值」时生效。 */
const RENAME_MAP: Record<string, string> = {
  file_path: "path",
  filePath: "path",
  oldString: "old_string",
  newString: "new_string",
  replaceAll: "replace_all",
  query_string: "query",
};

/** 错误框上限(总长 / 条数)。 */
const MAX_ERROR_CHARS = 2000;
const MAX_ERROR_ISSUES = 10;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** got 的类型描述:类型 + 短预览(截 60 字,不泄漏长正文)。 */
function describeGot(v: unknown): string {
  if (v === undefined) return "undefined";
  const t = typeOf(v);
  let preview: string;
  try {
    preview = typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
  } catch {
    preview = String(v);
  }
  if (preview.length > 60) preview = preview.slice(0, 59) + "…";
  return `${t} ${preview}`;
}

function errText(err: unknown): string {
  const s = err instanceof Error ? err.message : String(err);
  return s.length > 200 ? s.slice(0, 199) + "…" : s;
}

interface CoercionOutcome {
  changed: boolean;
  value: unknown;
}

/** 单值 coercion(仅当 schema 声明类型时被调用;拿不准一律 changed=false)。 */
function coerceValue(v: unknown, declared: string): CoercionOutcome {
  switch (declared) {
    case "number":
    case "integer": {
      if (typeof v !== "string") return { changed: false, value: v };
      const t = v.trim();
      if (!/^-?\d+(\.\d+)?$/.test(t)) return { changed: false, value: v };
      const n = Number(t);
      return Number.isFinite(n) ? { changed: true, value: n } : { changed: false, value: v };
    }
    case "boolean": {
      if (typeof v !== "string") return { changed: false, value: v };
      const t = v.trim().toLowerCase();
      if (t === "true") return { changed: true, value: true };
      if (t === "false") return { changed: true, value: false };
      return { changed: false, value: v };
    }
    case "array": {
      if (typeof v === "string") {
        const t = v.trim();
        if (t.startsWith("[")) {
          try {
            const parsed: unknown = JSON.parse(t);
            if (Array.isArray(parsed)) return { changed: true, value: parsed };
          } catch { /* 解析失败=保留原值 */ }
          return { changed: false, value: v };
        }
        // 单个裸标量(非空串、非对象文本)→ 包成单元素数组(元素保留原值,不再二次推断)
        if (t !== "" && !t.startsWith("{")) return { changed: true, value: [v] };
        return { changed: false, value: v };
      }
      if (typeof v === "number" || typeof v === "boolean") return { changed: true, value: [v] };
      return { changed: false, value: v };
    }
    case "object": {
      if (typeof v !== "string") return { changed: false, value: v };
      const t = v.trim();
      if (!t.startsWith("{")) return { changed: false, value: v };
      try {
        const parsed: unknown = JSON.parse(t);
        if (isPlainObject(parsed)) return { changed: true, value: parsed };
      } catch { /* 解析失败=保留原值 */ }
      return { changed: false, value: v };
    }
    case "string": {
      if (typeof v === "number" || typeof v === "boolean") return { changed: true, value: String(v) };
      return { changed: false, value: v };
    }
    default:
      return { changed: false, value: v };
  }
}

/**
 * 归一 + 校验工具入参。
 *
 * @param raw    provider 送来的参数(通常已是 JSON.parse 后的值;也接受原始 JSON 字符串)
 * @param schema 工具的 JSON Schema;缺席或 type≠object → 原样透传(零回归)
 */
export function normalizeToolArgs(
  raw: unknown,
  schema?: Record<string, unknown> | null,
): ToolArgNormalizeResult {
  const passthrough: ToolArgNormalizeResult = { ok: true, value: raw, issues: [], renamed: [], coerced: [] };
  if (!isPlainObject(schema) || schema["type"] !== "object") return passthrough;

  const issues: ToolArgIssue[] = [];
  const renamed: ToolArgRename[] = [];
  const coerced: ToolArgCoercion[] = [];
  let value: unknown = raw;

  // 1) JSON-string 归一
  if (typeof value === "string") {
    const text = value.trim();
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        value = JSON.parse(text);
      } catch (err) {
        issues.push({
          path: "$", expected: "JSON", got: describeGot(value),
          message: `JSON 解析失败:${errText(err)}`,
        });
        return { ok: false, value: raw, issues, renamed, coerced };
      }
    } else {
      issues.push({
        path: "$", expected: "object", got: describeGot(value),
        message: "参数必须是 JSON 对象",
      });
      return { ok: false, value: raw, issues, renamed, coerced };
    }
  }

  // 2) 必须是对象
  if (!isPlainObject(value)) {
    issues.push({
      path: "$", expected: "object", got: describeGot(value),
      message: "参数必须是 JSON 对象",
    });
    return { ok: false, value: raw, issues, renamed, coerced };
  }

  const props = isPlainObject(schema["properties"]) ? schema["properties"] as Record<string, unknown> : {};
  const obj: Record<string, unknown> = { ...value };

  // 3) 改名(先于 required:file_path 改名后能补上 required 的 path)
  for (const [from, to] of Object.entries(RENAME_MAP)) {
    if (!(from in obj)) continue;
    if (obj[to] !== undefined) continue;   // 目标键已有值 → 不动
    if (!(to in props)) continue;          // schema 未声明目标键 → 不动
    obj[to] = obj[from];
    delete obj[from];
    renamed.push({ from, to });
  }

  // 4) required
  const requiredRaw = schema["required"];
  if (Array.isArray(requiredRaw)) {
    for (const name of requiredRaw) {
      if (typeof name !== "string") continue;
      if (hasOwn(obj, name) && obj[name] !== undefined) continue;
      issues.push({
        path: name, expected: "required", got: "undefined",
        message: `缺少必填参数 ${name}`,
      });
    }
  }

  // 5) 无歧义 coercion(只对 schema 声明了类型的键)
  for (const key of Object.keys(obj)) {
    const spec = props[key];
    if (!isPlainObject(spec)) continue;
    const declared = spec["type"];
    if (typeof declared !== "string") continue;
    const outcome = coerceValue(obj[key], declared);
    if (!outcome.changed) continue;
    coerced.push({ path: key, from: typeOf(obj[key]), to: typeOf(outcome.value) });
    obj[key] = outcome.value;
  }

  const unchanged = renamed.length === 0 && coerced.length === 0;
  return {
    ok: issues.length === 0,
    // 无任何改写时返回原引用(零回归:工具拿到的是同一个对象);
    // 但 raw 是字符串时**必须**返回解析后的对象(否则工具又拿到一段 JSON 文本)。
    value: unchanged && raw === value ? raw : obj,
    issues,
    renamed,
    coerced,
  };
}

/**
 * 固定错误框(模型可自救的形态:位置/期望/实收/一句原因 + 重试指引)。
 * 上限:总长 ≤2000 字符、issue ≤10 条(超出写一行「另有 N 条」)。
 */
export function renderToolArgError(toolName: string, issues: readonly ToolArgIssue[]): string {
  const head = `[工具参数错误] ${toolName}`;
  const tail = "修正后重试;不要改变无关参数。";
  const shown = issues.slice(0, MAX_ERROR_ISSUES);
  const lines = shown.map((i) => `- ${i.path}: 期望 ${i.expected},收到 ${i.got} — ${i.message}`);
  if (issues.length > shown.length) lines.push(`- (另有 ${issues.length - shown.length} 条未列出)`);

  let out = [head, ...lines, tail].join("\n");
  // 超长时从尾部逐条丢 issue 行(保留头尾),最后硬截断兜底
  while (out.length > MAX_ERROR_CHARS && lines.length > 1) {
    lines.pop();
    out = [head, ...lines, tail].join("\n");
  }
  if (out.length > MAX_ERROR_CHARS) out = out.slice(0, MAX_ERROR_CHARS);
  return out;
}
