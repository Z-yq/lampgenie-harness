/**
 * provider-facing schema 归一的**接线静态断言**(非端到端):
 * 三处请求体组装是运行时链路(src 深路径 + 真 provider/端点),端到端起不来,故用
 * 「源码切片必须含归一调用」把断线钉死 —— 行为面由 packages/harness-runtime/test/provider-schema.test.ts
 * 的纯逻辑直测兜。切片口径:函数起点 → 下一个顶层 function/export 声明前,避免相邻函数误命中。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");

const API_TYPES = src("../../../packages/harness-runtime/src/agent/provider-apitypes.ts");
const OPENAI_PROVIDER = src("../../../packages/harness-runtime/src/agent/openai-provider.ts");
const FACTORY = src("../src/factory.ts");

/** 取一个具名函数体:从 `function NAME(` 起,到其后第一个顶层 `function `/`export ` 声明为止。 */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `未找到函数 ${name}`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n(?:export )?(?:async )?function |\n(?:export )?(?:interface|type|const) /);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("provider-apitypes:两协议请求体都先归一 tools", () => {
  it("toAnthropicBody 函数体内出现 normalizeToolsForProvider", () => {
    expect(functionBody(API_TYPES, "toAnthropicBody")).toContain("normalizeToolsForProvider");
  });

  it("toResponsesBody 函数体内出现 normalizeToolsForProvider", () => {
    expect(functionBody(API_TYPES, "toResponsesBody")).toContain("normalizeToolsForProvider");
  });

  it("两处都从 provider-schema 导入(import 语句在场)", () => {
    expect(API_TYPES).toMatch(/import \{[^}]*normalizeToolsForProvider[^}]*\} from "\.\/provider-schema(\.ts)?";/);
    expect(API_TYPES).toMatch(/import \{[^}]*declaredPromptHints[^}]*\} from "\.\/provider-schema(\.ts)?";/);
  });

  it("两处都把 styleHints 并入 system(只有原本有 system 才追加)", () => {
    expect(API_TYPES).toContain("declaredPromptHints");
    const anthropic = functionBody(API_TYPES, "toAnthropicBody");
    const responses = functionBody(API_TYPES, "toResponsesBody");
    expect(anthropic).toMatch(/systemText = system && hints/);
    expect(responses).toMatch(/if \(hints\)/);
  });
});

describe("openai-provider:chat.completions 请求体也归一 tools", () => {
  it("toOpenAi 函数体内出现 normalizeToolsForProvider", () => {
    expect(functionBody(OPENAI_PROVIDER, "toOpenAi")).toContain("normalizeToolsForProvider");
  });

  it("toOpenAi 的 tools 输出用归一后的副本(不再直用入参 tools)", () => {
    const body = functionBody(OPENAI_PROVIDER, "toOpenAi");
    expect(body).toContain("providerTools");
    expect(body).not.toMatch(/tools\.map\(/);
  });

  it("调用点把 apiId/model 交给 toOpenAi", () => {
    expect(OPENAI_PROVIDER).toMatch(/toOpenAi\(messages, tools, \{ apiId: .*model: cur\.model \}\);/);
  });

  it("generic/未知族时零变化(不走归一,原样透传 schema)", () => {
    expect(functionBody(OPENAI_PROVIDER, "toOpenAi")).toMatch(/family === "generic" \?/);
  });

  it("openai-provider 从 provider-schema 导入(import 语句在场)", () => {
    expect(OPENAI_PROVIDER).toMatch(/import \{[^}]*normalizeToolsForProvider[^}]*\} from "\.\/provider-schema(\.ts)?";/);
  });
});

describe("apiId 贯通(providerId → provider → 请求体上下文)", () => {
  it("factory.providerFromRef 把 providerId 作为 apiId 传给 createOpenAiCompatProvider", () => {
    expect(functionBody(FACTORY, "providerFromRef")).toContain("apiId: ref.providerId");
  });

  it("provider-apitypes 不再用 cast 读 apiId(接口字段直读)", () => {
    expect(API_TYPES).not.toMatch(/as \{ apiId/);
    expect(API_TYPES).not.toContain("as ApiTypeAdapterCur & { apiId");
  });

  it("openai-provider 的 toOpenAi 调用点直读 cur.apiId(无 cast)", () => {
    expect(OPENAI_PROVIDER).toContain("apiId: cur.apiId");
    expect(OPENAI_PROVIDER).not.toMatch(/as \{ apiId: string/);
  });
});
