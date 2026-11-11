/**
 * provider-facing schema 归一纯逻辑直测:族判定 / $ref 展开与环引用 / 剥 null /
 * integer 边界 / 缺 type 推断 / 不可读兜底 / 不可变与确定性 / tools 副本 / 提示变体。
 * 全内存零 IO —— 这一层只处理请求体副本,注册表本体在这里被反复证明「没被动过」。
 */
import { describe, expect, it } from "vitest";
import { createOpenAiCompatProvider } from "../src/agent/openai-provider.ts";
import {
  MODEL_FAMILIES,
  declaredPromptHints,
  modelFamilyOf,
  normalizeToolSchema,
  normalizeToolsForProvider,
  patchToolNameForFamily,
  promptVariantForProvider,
} from "../src/agent/provider-schema.ts";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("modelFamilyOf", () => {
  it("gpt 前缀 → gpt", () => {
    expect(modelFamilyOf("gpt-5.1")).toBe("gpt");
    expect(modelFamilyOf("gpt-4o-mini")).toBe("gpt");
  });

  it("claude 不被短前缀误吞 → claude", () => {
    expect(modelFamilyOf("claude-sonnet-4-5")).toBe("claude");
    expect(modelFamilyOf("claude-3-5-haiku")).toBe("claude");
  });

  it("大小写不敏感:GPT-4 → gpt", () => {
    expect(modelFamilyOf("GPT-4")).toBe("gpt");
    expect(modelFamilyOf("Gemini")).toBe("gemini");
  });

  it("gemini / qwen / moonshot 各自命中", () => {
    expect(modelFamilyOf("gemini-2.5-pro")).toBe("gemini");
    expect(modelFamilyOf("qwen3-coder")).toBe("qwen");
    expect(modelFamilyOf("moonshot-v1-128k")).toBe("moonshot");
  });

  it("未知模型名 → generic", () => {
    expect(modelFamilyOf("deepseek-v3")).toBe("generic");
    expect(modelFamilyOf("glm-4.6")).toBe("generic");
  });

  it("空串 / undefined / null → generic(不抛)", () => {
    expect(modelFamilyOf("")).toBe("generic");
    expect(modelFamilyOf("   ")).toBe("generic");
    expect(modelFamilyOf(undefined)).toBe("generic");
    expect(modelFamilyOf(null)).toBe("generic");
  });

  it("前缀不中时退化为包含匹配", () => {
    expect(modelFamilyOf("openai/gpt-4o")).toBe("gpt");
    expect(modelFamilyOf("anthropic.claude-3-opus")).toBe("claude");
  });

  it("MODEL_FAMILIES 表含全部六族且 generic 在末位", () => {
    expect([...MODEL_FAMILIES]).toEqual(["gpt", "claude", "gemini", "qwen", "moonshot", "generic"]);
  });

  it("patchToolNameForFamily:gpt → apply_patch,其余(含 generic)→ edit_file", () => {
    expect(patchToolNameForFamily("gpt")).toBe("apply_patch");
    expect(patchToolNameForFamily("claude")).toBe("edit_file");
    expect(patchToolNameForFamily("gemini")).toBe("edit_file");
    expect(patchToolNameForFamily("qwen")).toBe("edit_file");
    expect(patchToolNameForFamily("moonshot")).toBe("edit_file");
    expect(patchToolNameForFamily("generic")).toBe("edit_file");
  });
});

describe("normalizeToolSchema · $ref 展开", () => {
  it("展开本地 #/definitions/x", () => {
    const res = normalizeToolSchema({
      type: "object",
      properties: { where: { $ref: "#/definitions/Where" } },
      definitions: { Where: { type: "object", properties: { id: { type: "string" } } } },
    });
    const schema = res.schema as { properties: { where: Record<string, unknown> } };
    expect(schema.properties.where["$ref"]).toBeUndefined();
    expect(schema.properties.where["type"]).toBe("object");
    expect(res.changed).toBe(true);
  });

  it("展开本地 #/$defs/x", () => {
    const res = normalizeToolSchema({
      type: "object",
      properties: { n: { $ref: "#/$defs/Count" } },
      $defs: { Count: { type: "integer", minimum: 0, maximum: 10 } },
    });
    const schema = res.schema as { properties: { n: Record<string, unknown> } };
    expect(schema.properties.n).toEqual({ type: "integer", minimum: 0, maximum: 10 });
  });

  it("环引用保留 $ref 并给 circular-ref 警告(不无限展开)", () => {
    const res = normalizeToolSchema({
      type: "object",
      properties: { node: { $ref: "#/definitions/Node" } },
      definitions: {
        Node: { type: "object", properties: { next: { $ref: "#/definitions/Node" } } },
      },
    });
    expect(res.warnings.some((w) => w.startsWith("circular-ref"))).toBe(true);
    const schema = res.schema as { properties: { node: { properties: { next: Record<string, unknown> } } } };
    expect(schema.properties.node.properties.next["$ref"]).toBe("#/definitions/Node");
  });

  it("非本地/带斜杠的 $ref 不展开(只认本地单段定义)", () => {
    const res = normalizeToolSchema({
      type: "object",
      properties: {
        a: { $ref: "https://example.com/schema.json#/x" },
        b: { $ref: "#/definitions/nested/deep" },
      },
      definitions: { "nested/deep": { type: "object" } },
    });
    const schema = res.schema as { properties: Record<string, Record<string, unknown>> };
    expect(schema.properties["a"]?.["$ref"]).toBe("https://example.com/schema.json#/x");
    expect(schema.properties["b"]?.["$ref"]).toBe("#/definitions/nested/deep");
  });

  it("$ref 兄弟键(description)覆盖展开体的同名字段,不丢注释", () => {
    const res = normalizeToolSchema({
      type: "object",
      properties: { w: { $ref: "#/definitions/Where", description: "调用点描述" } },
      definitions: { Where: { type: "object", description: "定义描述" } },
    });
    const schema = res.schema as { properties: { w: Record<string, unknown> } };
    expect(schema.properties.w["description"]).toBe("调用点描述");
    expect(schema.properties.w["type"]).toBe("object");
  });

  it("展开深度超 maxDepth → 整体 schema-unreadable(不半途而废)", () => {
    const defs: Record<string, unknown> = {};
    for (let i = 0; i < 11; i += 1) defs[`d${i}`] = { type: "object", properties: { next: { $ref: `#/definitions/d${i + 1}` } } };
    defs["d11"] = { type: "object", properties: { v: { type: "string" } } };
    const deep = { type: "object", definitions: defs, properties: { root: { $ref: "#/definitions/d0" } } };
    expect(normalizeToolSchema(deep).warnings).toEqual(["schema-unreadable"]);
  });

  it("opts.maxDepth 放宽后同一 schema 可展开", () => {
    const defs: Record<string, unknown> = {};
    for (let i = 0; i < 11; i += 1) defs[`d${i}`] = { type: "object", properties: { next: { $ref: `#/definitions/d${i + 1}` } } };
    defs["d11"] = { type: "object", properties: { v: { type: "string" } } };
    const deep = { type: "object", definitions: defs, properties: { root: { $ref: "#/definitions/d0" } } };
    expect(normalizeToolSchema(deep).warnings).toEqual(["schema-unreadable"]);
    const relaxed = normalizeToolSchema(deep, { maxDepth: 20 });
    expect(relaxed.warnings).not.toContain("schema-unreadable");
    expect(relaxed.changed).toBe(true);
  });
});

describe("normalizeToolSchema · 可选剥 null", () => {
  it("anyOf [X, {type:\"null\"}] → X", () => {
    const res = normalizeToolSchema({ anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] });
    expect(res.schema).toEqual({ type: "string", minLength: 1 });
    expect(res.changed).toBe(true);
  });

  it("oneOf [{type:\"null\"}, X] → X", () => {
    const res = normalizeToolSchema({ oneOf: [{ type: "null" }, { type: "integer", minimum: 0, maximum: 5 }] });
    expect(res.schema).toEqual({ type: "integer", minimum: 0, maximum: 5 });
  });

  it("三成员 anyOf 不剥(只处理恰为两成员的可选形态)", () => {
    const input = { anyOf: [{ type: "string" }, { type: "null" }, { type: "number" }] };
    const res = normalizeToolSchema(input);
    expect(res.schema).toEqual(input);
    expect(res.changed).toBe(false);
  });

  it("type: [\"string\",\"null\"] → type: \"string\"", () => {
    expect(normalizeToolSchema({ type: ["string", "null"] }).schema).toEqual({ type: "string" });
  });

  it("type 多成员只删 null,剩多成员仍为数组", () => {
    expect(normalizeToolSchema({ type: ["string", "number", "null"] }).schema).toEqual({ type: ["string", "number"] });
  });

  it("type 只剩 [\"null\"] 不动", () => {
    const input = { type: ["null"] };
    const res = normalizeToolSchema(input);
    expect(res.schema).toEqual({ type: ["null"] });
    expect(res.changed).toBe(false);
  });

  it("required 不被剥 null 逻辑改动", () => {
    const res = normalizeToolSchema({
      type: "object",
      required: ["a", "b"],
      properties: { a: { type: ["string", "null"] }, b: { type: "string" } },
    });
    const schema = res.schema as { required: string[]; properties: Record<string, unknown> };
    expect(schema.required).toEqual(["a", "b"]);
    expect(schema.properties["a"]).toEqual({ type: "string" });
  });
});

describe("normalizeToolSchema · integer 边界", () => {
  it("缺 minimum/maximum 时补 64 位安全边界(两处警告)", () => {
    const res = normalizeToolSchema({ type: "object", properties: { n: { type: "integer" } } });
    const schema = res.schema as { properties: { n: Record<string, unknown> } };
    expect(schema.properties.n["minimum"]).toBe(-9007199254740991);
    expect(schema.properties.n["maximum"]).toBe(9007199254740991);
    expect(res.warnings.filter((w) => w.startsWith("integer-bounds"))).toHaveLength(2);
  });

  it("已有 minimum 不动,只补 maximum", () => {
    const res = normalizeToolSchema({ type: "integer", minimum: 3 });
    expect(res.schema).toEqual({ type: "integer", minimum: 3, maximum: 9007199254740991 });
    expect(res.warnings.filter((w) => w.startsWith("integer-bounds"))).toHaveLength(1);
  });
});

describe("normalizeToolSchema · 缺 type 推断", () => {
  it("有 properties → object", () => {
    const res = normalizeToolSchema({ properties: { a: { type: "string" } } });
    expect((res.schema as Record<string, unknown>)["type"]).toBe("object");
    expect(res.warnings.some((w) => w.startsWith("type-inferred"))).toBe(true);
  });

  it("有 items → array", () => {
    expect(normalizeToolSchema({ items: { type: "string" } }).schema).toMatchObject({ type: "array" });
  });

  it("enum 全 boolean → boolean", () => {
    expect(normalizeToolSchema({ enum: [true, false] }).schema).toMatchObject({ type: "boolean" });
  });

  it("enum 全 number → number", () => {
    expect(normalizeToolSchema({ enum: [1, 2, 3] }).schema).toMatchObject({ type: "number" });
  });

  it("其余情况 → string", () => {
    const res = normalizeToolSchema({});
    expect(res.schema).toEqual({ type: "string" });
    expect(res.warnings.some((w) => w.startsWith("type-inferred"))).toBe(true);
  });

  it("组合器在场时不猜 type(不把 anyOf 主体降级成 string)", () => {
    const res = normalizeToolSchema({ anyOf: [{ type: "string" }, { type: "number" }] });
    expect((res.schema as Record<string, unknown>)["type"]).toBeUndefined();
  });
});

describe("normalizeToolSchema · 兜底与不变量", () => {
  it("非对象输入原样返回 + changed:false + schema-unreadable", () => {
    for (const bad of ["text", 42, null, undefined, [1, 2]] as unknown[]) {
      const res = normalizeToolSchema(bad);
      expect(res.schema).toBe(bad);
      expect(res.changed).toBe(false);
      expect(res.warnings).toEqual(["schema-unreadable"]);
    }
  });

  it("病态输入不抛(全程 try/catch 兜底)", () => {
    expect(() => normalizeToolSchema(Symbol("x") as unknown)).not.toThrow();
    expect(() => normalizeToolSchema({ type: { nested: true } })).not.toThrow();
  });

  it("不可变:输入深比对逐字未变", () => {
    const input = {
      type: "object",
      properties: { a: { $ref: "#/definitions/A" }, n: { type: "integer" }, s: { type: ["string", "null"] } },
      definitions: { A: { type: "object", properties: { x: { type: "string" } } } },
      required: ["a"],
    };
    const before = clone(input);
    normalizeToolSchema(input);
    expect(input).toEqual(before);
  });

  it("确定性:同输入两次调用深等价", () => {
    const input = { type: "object", properties: { n: { type: "integer" }, s: { anyOf: [{ type: "string" }, { type: "null" }] } } };
    const a = normalizeToolSchema(input);
    const b = normalizeToolSchema(input);
    expect(a.schema).toEqual(b.schema);
    expect(a.warnings).toEqual(b.warnings);
    expect(a.changed).toBe(b.changed);
  });

  it("返回的是新对象(不与输入共享引用)", () => {
    const properties = { type: "string" };
    const input = { type: "object", properties: { a: properties } };
    const res = normalizeToolSchema(input) as unknown as { schema: { properties: Record<string, unknown> } };
    expect(res.schema).not.toBe(input);
    expect(res.schema.properties).not.toBe(properties);
  });
});

describe("normalizeToolsForProvider", () => {
  it("只改 parameters,name/description 等逐字不动", () => {
    const tools = [
      {
        name: "read_file",
        description: "读文件",
        parameters: { type: "object", properties: { n: { type: "integer" } } },
      },
    ];
    const out = normalizeToolsForProvider(tools, { model: "gpt-5.1" });
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("read_file");
    expect(out[0]?.description).toBe("读文件");
    expect((out[0]?.parameters as { properties: { n: Record<string, unknown> } }).properties.n["minimum"]).toBe(-9007199254740991);
  });

  it("返回新数组 + 新 tool 对象,输入深比对未变", () => {
    const tools = [{ name: "t", description: "d", parameters: { type: "object", properties: { a: { type: "string" } } } }];
    const before = clone(tools);
    const out = normalizeToolsForProvider(tools, {});
    expect(out).not.toBe(tools);
    expect(out[0]).not.toBe(tools[0]);
    expect(tools).toEqual(before);
  });

  it("generic(未知模型)对无 $ref/integer 的 schema 深等价(零变化)", () => {
    const parameters = { type: "object", properties: { path: { type: "string", description: "路径" } }, required: ["path"] };
    const out = normalizeToolsForProvider([{ name: "t", description: "d", parameters }], { model: "deepseek-v3" });
    expect(out[0]?.parameters).toEqual(parameters);
  });

  it("空 tools → 空数组", () => {
    expect(normalizeToolsForProvider([], { apiId: "gpt-4" })).toEqual([]);
  });
});

describe("promptVariantForProvider", () => {
  it("gpt 系提示 apply_patch 语法", () => {
    const variant = promptVariantForProvider({ model: "gpt-5.1" });
    expect(variant.family).toBe("gpt");
    expect(variant.editTool).toBe("apply_patch");
    expect(variant.styleHints.join("\n")).toContain("apply_patch");
  });

  it("claude 系提示 edit_file 精确替换", () => {
    const variant = promptVariantForProvider({ model: "claude-sonnet-4-5" });
    expect(variant.family).toBe("claude");
    expect(variant.editTool).toBe("edit_file");
    expect(variant.styleHints.join("\n")).toContain("edit_file");
  });

  it("未知 → generic + 空 hints / edit_file", () => {
    const variant = promptVariantForProvider({});
    expect(variant.family).toBe("generic");
    expect(variant.editTool).toBe("edit_file");
    expect(variant.styleHints).toEqual([]);
  });

  it("apiId 优先于 model", () => {
    expect(promptVariantForProvider({ apiId: "claude-3-haiku", model: "gpt-4o" }).family).toBe("claude");
    expect(promptVariantForProvider({ apiId: "gpt-4o", model: "claude-3-haiku" }).family).toBe("gpt");
  });

  it("返回的 styleHints 是副本(改它不影响下次调用)", () => {
    const first = promptVariantForProvider({ model: "gpt-5.1" });
    first.styleHints.push("污染");
    expect(promptVariantForProvider({ model: "gpt-5.1" }).styleHints).not.toContain("污染");
  });
});

describe("declaredPromptHints(wire 注入口径)", () => {
  it("显式 apiId 声明的族才给提示文本", () => {
    expect(declaredPromptHints({ apiId: "claude-sonnet-4-5" })).toContain("edit_file");
    expect(declaredPromptHints({ apiId: "gpt-5.1" })).toContain("apply_patch");
  });

  it("未声明 apiId(只给 model)不注入 —— 不靠模型名猜提示、不动静态 system 前缀", () => {
    expect(declaredPromptHints({ model: "gpt-5.1" })).toBe("");
    expect(declaredPromptHints({ model: "claude-sonnet-4-5" })).toBe("");
    expect(declaredPromptHints({})).toBe("");
  });

  it("未知 apiId → 空串(不会凭 generic 造 system);apiId 优先于 model", () => {
    expect(declaredPromptHints({ apiId: "deepseek-v3" })).toBe("");
    expect(declaredPromptHints({ apiId: "deepseek-v3", model: "deepseek-v3" })).toBe("");
    expect(declaredPromptHints({ apiId: "claude-sonnet-4-5", model: "gpt-5.1" })).toContain("edit_file");
  });

  it("api.id 形态的 apiId 也能定族(openai-gpt → gpt);无 apiId 时 model 不兜底", () => {
    expect(declaredPromptHints({ apiId: "openai-gpt" })).toContain("apply_patch");
    expect(declaredPromptHints({ apiId: undefined, model: "mystery" })).toBe("");
  });
});

describe("apiId 贯通(provider 构造 → cur)", () => {
  it("createOpenAiCompatProvider 携带 apiId,describe() 只读可见;update 不改(构造期固定)", () => {
    const p = createOpenAiCompatProvider({ baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "mystery", apiId: "openai-gpt" });
    expect(p.describe().apiId).toBe("openai-gpt");
    p.update({ model: "mystery-2" });
    expect(p.describe().apiId).toBe("openai-gpt");
 // 族判定仍由 modelFamilyOf 单独负责:apiId 不进 modelFamilyOf 的类型面(不受影响)
    expect(modelFamilyOf("mystery")).toBe("generic");
    expect(modelFamilyOf("openai-gpt")).toBe("gpt");
  });

  it("未给 apiId 时 describe().apiId 为 undefined(线上缺省=不注入 hints)", () => {
    const p = createOpenAiCompatProvider({ baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "gpt-5.1" });
    expect(p.describe().apiId).toBeUndefined();
  });
});
