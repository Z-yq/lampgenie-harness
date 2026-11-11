/**
 * 模型族适配层:provider-facing 的 JSON Schema 归一 + 提示变体。
 * **为什么只改 provider-facing copy**:工具注册表本体是所有 provider 共享的模型可见契约 ——
 * name/description/parameters 同时被参数校验、系统提示渲染、提示前缀缓存(断点前缀逐字节)
 * 与其它 provider 读取。若在原对象上做「$ref 展开 / 剥 null / 补 integer 边界」,改动会顺着
 * 注册表波及校验语义与缓存命中(同一工具在两家 provider 之间前缀漂移),还会让审计/回放看到
 * 一份谁也没请求过的 schema。故这里只在**请求体这一层**产出副本:请求组装时 clone 一份、
 * 归一这份、发出去,注册表本体逐字不动(纯函数、零 IO、不可变、确定性)。
 */
import type { ToolSpec } from "./loop";

/** 判定顺序即优先级(别让 claude 被 gpt 之类的短前缀误吞;先前缀、后退化为包含)。 */
export const MODEL_FAMILIES = ["gpt", "claude", "gemini", "qwen", "moonshot", "generic"] as const;

export type Family = (typeof MODEL_FAMILIES)[number];

/** 可判定的族(不含兜底 generic),顺序=判定优先级。 */
const MATCH_ORDER: readonly Exclude<Family, "generic">[] = ["gpt", "claude", "gemini", "qwen", "moonshot"];

const INTEGER_MIN = -9007199254740991;
const INTEGER_MAX = 9007199254740991;
const DEFAULT_MAX_DEPTH = 8;
/** 纯嵌套(非 $ref)硬上限:防病态深树爆栈,超过一律走 schema-unreadable 兜底。 */
const HARD_NEST_LIMIT = 64;

const EDIT_FILE_HINTS: readonly string[] = [
  "改文件用 edit_file:给 old_string/new_string,old_string 必须与文件现有内容逐字一致(含缩进与空行)且足够独特;替换失败先重读文件再改。",
];

const FAMILY_HINTS: Record<Family, readonly string[]> = {
  gpt: [
    "改文件用 apply_patch 补丁语法:以 *** Begin Patch 开头、*** End Patch 结尾,段内用 *** Update File: <路径> / *** Add File: <路径>,行前缀 + 新增、- 删除、空格 上下文;不要整文件覆盖。",
    "一个补丁可含多段(*** Update File 多次出现),按文件顺序排列。",
  ],
  claude: EDIT_FILE_HINTS,
  gemini: EDIT_FILE_HINTS,
  qwen: EDIT_FILE_HINTS,
  moonshot: EDIT_FILE_HINTS,
  generic: [], // 未知族不给提示:猜错语法比不提示更贵
};

/** apiId/model → 模型族。大小写不敏感;前缀优先,其次包含;空/未知=generic。 */
export function modelFamilyOf(apiId: string | undefined | null): Family {
  const raw = typeof apiId === "string" ? apiId.trim().toLowerCase() : "";
  if (!raw) return "generic";
  for (const family of MATCH_ORDER) if (raw.startsWith(family)) return family;
  for (const family of MATCH_ORDER) if (raw.includes(family)) return family;
  return "generic";
}

/** 该族走哪个改文件工具(gpt 系=apply_patch 补丁,其余=edit_file 精确替换)。 */
export function patchToolNameForFamily(family: Family): string {
  return family === "gpt" ? "apply_patch" : "edit_file";
}

export interface ProviderCtx {
  apiId?: string;
  model?: string;
}

export interface NormalizeSchemaResult {
  schema: unknown;
  changed: boolean;
  warnings: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 严格 null schema:`{type:"null"}` 且无其它键(带 description 的不认作纯 null,保守不剥)。 */
function isNullSchema(value: unknown): boolean {
  return isPlainObject(value) && Object.keys(value).length === 1 && value["type"] === "null";
}

/** 本地 ref 名:`#/definitions/x` / `#/$defs/x`(单段路径);其它(远程/带斜杠)= 不认。 */
function localRefName(ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  for (const prefix of ["#/definitions/", "#/$defs/"]) {
    if (!ref.startsWith(prefix)) continue;
    const name = ref.slice(prefix.length);
    if (name.length > 0 && !name.includes("/")) return name;
  }
  return null;
}

function localDefinition(root: Record<string, unknown>, name: string): unknown {
  for (const bagKey of ["definitions", "$defs"]) {
    const bag = root[bagKey];
    if (isPlainObject(bag) && Object.prototype.hasOwnProperty.call(bag, name)) return bag[name];
  }
  return undefined;
}

function inferType(node: Record<string, unknown>): string {
  if ("properties" in node) return "object";
  if ("items" in node) return "array";
  const values = node["enum"];
  if (Array.isArray(values) && values.length > 0) {
    if (values.every((v) => typeof v === "boolean")) return "boolean";
    if (values.every((v) => typeof v === "number")) return "number";
  }
  return "string";
}

/** 这些键自带类型语义,缺 type 时不猜(免得以 "string" 盖掉组合器)。 */
const TYPE_BEARING_KEYS = ["$ref", "anyOf", "oneOf", "allOf", "not", "const"] as const;

/** 这些键的值是「名字 → 子 schema」的映射:只归一每个子 schema,容器本身不是 schema
 * (否则会给 properties 这个 map 硬塞一个 type:"string")。 */
const SCHEMA_MAP_KEYS = new Set(["properties", "patternProperties", "definitions", "$defs", "dependentSchemas"]);

/**
 * provider-facing schema 归一:纯函数,返回新对象(输入逐字不动)。
 * - inline `$ref`(只本地 definitions/$defs;深度上限 maxDepth,环引用保留 $ref + circular-ref 警告);
 * - 剥可选 null(`anyOf/oneOf` 恰为 [X,{type:"null"}];`type` 数组去掉 "null");
 * - integer 补 64 位安全边界(minimum/maximum 缺失才补);
 * - 缺 type 按现状推断(object/array/boolean/number/string,均带 type-inferred 警告);
 * - 任何异常(非对象输入 / 递归过深)→ 原样返回 + schema-unreadable;全程不 throw。
 */
export function normalizeToolSchema(schema: unknown, opts?: { maxDepth?: number }): NormalizeSchemaResult {
  if (!isPlainObject(schema)) return { schema, changed: false, warnings: ["schema-unreadable"] };
  const root = schema;
  const wanted = opts?.maxDepth;
  const maxDepth = typeof wanted === "number" && Number.isFinite(wanted) && wanted >= 0 ? Math.floor(wanted) : DEFAULT_MAX_DEPTH;
  const warnings: string[] = [];
  let changed = false;

  try {
    const normalized = walk(root, 0, "$", []);
    return { schema: normalized, changed, warnings };
  } catch {
    return { schema, changed: false, warnings: ["schema-unreadable"] };
  }

  function walkSchemaMap(value: unknown, depth: number, path: string, refs: readonly string[]): unknown {
    if (!isPlainObject(value)) return value; // 病态形态(非对象)照原样带走,不猜
    const out: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(value)) out[name] = walk(child, depth + 1, `${path}.${name}`, refs);
    return out;
  }

  function walk(node: unknown, depth: number, path: string, refs: readonly string[]): unknown {
    if (depth > HARD_NEST_LIMIT) throw new Error(`schema nesting too deep at ${path}`);
    if (Array.isArray(node)) return node.map((item, index) => walk(item, depth + 1, `${path}[${index}]`, refs));
    if (!isPlainObject(node)) return node;

 // ---- ① inline $ref(只展开本地定义;环引用/查不到/超深度 → 保留 $ref)----
    let expanded: Record<string, unknown> | null = null;
    const refName = localRefName(node["$ref"]);
    if (refName !== null) {
      const target = localDefinition(root, refName);
      if (refs.includes(refName)) {
        warnings.push(`circular-ref: #/definitions/${refName} 在展开路径上重复出现,保留 $ref 不动(${path})`);
      } else if (target !== undefined && isPlainObject(target)) {
        if (refs.length >= maxDepth) throw new Error(`ref expansion depth > ${maxDepth} at ${path}`);
        const walked = walk(target, depth + 1, `${path}>${refName}`, [...refs, refName]);
        if (isPlainObject(walked)) {
          expanded = walked;
          changed = true;
        }
      }
 // target 缺省 / 非对象:保留 $ref,其余键照常归一
    }

 // ---- ② 逐键深拷贝(先展开体,兄弟键覆盖——description 等以引用点为准)----
    let out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref") {
        if (expanded === null) out[key] = value; // 未展开:原样保留
        continue;
      }
      out[key] = SCHEMA_MAP_KEYS.has(key)
        ? walkSchemaMap(value, depth + 1, `${path}.${key}`, refs)
        : walk(value, depth + 1, `${path}.${key}`, refs);
    }
    if (expanded !== null) out = { ...expanded, ...out };

 // ---- ③ 可选剥 null ----
    for (const key of ["anyOf", "oneOf"] as const) {
      const variants = out[key];
      if (!Array.isArray(variants) || variants.length !== 2) continue;
      const [first, second] = variants;
      const keep = isNullSchema(first) && !isNullSchema(second) ? second
        : isNullSchema(second) && !isNullSchema(first) ? first
          : undefined;
      if (keep === undefined || !isPlainObject(keep)) continue;
      const rest: Record<string, unknown> = { ...out };
      delete rest[key];
      out = { ...rest, ...keep };
      changed = true;
    }
    const typeValue = out["type"];
    if (Array.isArray(typeValue)) {
      const kept = typeValue.filter((member) => member !== "null");
 // 只剩 null 不动(那本身就是个合法 null schema);多成员只删 "null"
      if (kept.length > 0 && kept.length < typeValue.length) {
        out["type"] = kept.length === 1 ? kept[0] : kept;
        changed = true;
      }
    }

 // ---- ④ integer 补 64 位安全边界(已有值不动)----
    if (out["type"] === "integer") {
      if (out["minimum"] === undefined) {
        out["minimum"] = INTEGER_MIN;
        changed = true;
        warnings.push(`integer-bounds: 缺 minimum,补 ${INTEGER_MIN}(${path})`);
      }
      if (out["maximum"] === undefined) {
        out["maximum"] = INTEGER_MAX;
        changed = true;
        warnings.push(`integer-bounds: 缺 maximum,补 ${INTEGER_MAX}(${path})`);
      }
    }

 // ---- ⑤ 缺 type 推断(组合器/$ref/$const 在场则不猜)----
    if (out["type"] === undefined && !TYPE_BEARING_KEYS.some((key) => key in out)) {
      const inferred = inferType(out);
      out["type"] = inferred;
      changed = true;
      warnings.push(`type-inferred: 缺 type,推断为 ${inferred}(${path})`);
    }

    return out;
  }
}

/**
 * 请求体层的 tools 副本:只归一 `parameters`(name/description 逐字不动),
 * 返回新数组 + 新 tool 对象。确定性(同输入同输出)、不可变(输入深比对不变)。
 */
export function normalizeToolsForProvider(tools: ToolSpec[], ctx: ProviderCtx): ToolSpec[] {
 // 归一内容本身与族无关(所有 provider 共用同一份安全副本:补丁/剥 null/补边界对任何
 // 端点都只减歧义不减信息)。ctx 留给调用方显式交代 apiId/model,也便于将来按族分级。
  void ctx;
  return tools.map((tool) => {
    const result = normalizeToolSchema(tool.parameters);
    return { ...tool, parameters: isPlainObject(result.schema) ? result.schema : tool.parameters };
  });
}

/** apiId 优先、model 兜底 —— 两个字段任一能定族就够。 */
function familyOfCtx(ctx: ProviderCtx): Family {
  const byApiId = modelFamilyOf(ctx.apiId);
  return byApiId !== "generic" ? byApiId : modelFamilyOf(ctx.model);
}

/**
 * 提示变体:族/该族改文件工具/风格提示。generic 返回空 hints ——
 * 不知道对面是谁就不要塞语法(错语法的代价高于没有提示)。
 */
export function promptVariantForProvider(ctx: ProviderCtx): { family: Family; editTool: string; styleHints: string[] } {
  const family = familyOfCtx(ctx);
  return { family, editTool: patchToolNameForFamily(family), styleHints: [...FAMILY_HINTS[family]] };
}

/**
 * wire 层实际注入的提示文本:只在**显式 apiId** 可判族时给出内容,generic/未知 → 空串(不凭空造 system)。
 * 为什么不做 model 兜底:①system 是提示缓存断点前缀,注入会移动静态前缀,须由操作者显式声明 apiId
 * 才改变;②provider-apitypes 的既有 E2E 已断言 system 逐字等于原文,model 兜底注入会改其报文。
 * 当前 ApiTypeAdapterCur 尚未公开 apiId(见 provider-apitypes.ts 的可选读取),故线上口径=不注入;
 * cur 暴露 apiId 后本函数自动生效,无需改调用点。
 */
export function declaredPromptHints(ctx: ProviderCtx): string {
  if (modelFamilyOf(ctx.apiId) === "generic") return "";
  return promptVariantForProvider({ apiId: ctx.apiId }).styleHints.join("\n");
}
