/**
 * data 层工具注册表(声明式 schema + handler 引用)的纯逻辑直测:校验 / 注册裁决 / 版本升级 /
 * 钉扎 / 依赖降级 / 解析 / 列表 / 版本差分 / 码表快照。全内存,零 IO。
 */
import { describe, expect, it } from "vitest";
import {
  DATA_TOOL_CODES,
  DATA_TOOL_VERSION,
  checkDependencies,
  compareSemver,
  createRegistry,
  diffVersions,
  listTools,
  pinToolVersion,
  registerTool,
  resolveTool,
  unregisterTool,
  validateSpec,
} from "../src/agent/data-tool-registry";
import type { DataToolRegistry, DataToolSpec } from "../src/agent/data-tool-registry";

function spec(overrides: Partial<DataToolSpec> = {}): DataToolSpec {
  return {
    name: "demo_tool",
    version: "1.0.0",
    owner: "alice",
    description: "示例 data 工具",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    handler: { kind: "skill", ref: "skills/demo" },
    permissions: { mode: "read" },
    layer: "data",
    ...overrides,
  };
}

function registered(overrides: Partial<DataToolSpec> = {}): DataToolRegistry {
  const result = registerTool(createRegistry(), spec(overrides));
  expect(result.ok).toBe(true);
  return result.registry;
}

describe("exported contract", () => {
  it("DATA_TOOL_VERSION 为 1", () => {
    expect(DATA_TOOL_VERSION).toBe(1);
  });

  it("DATA_TOOL_CODES 逐字快照(12 码)", () => {
    expect([...DATA_TOOL_CODES]).toEqual([
      "DATA_TOOL_INVALID",
      "DATA_TOOL_DUPLICATE",
      "DATA_TOOL_VERSION_STALE",
      "DATA_TOOL_NATIVE_IMMUTABLE",
      "DATA_TOOL_NEEDS_APPROVAL",
      "DATA_TOOL_REGISTERED",
      "DATA_TOOL_UNREGISTERED",
      "DATA_TOOL_DEP_MISSING",
      "DATA_TOOL_DEGRADED",
      "DATA_TOOL_PINNED",
      "DATA_TOOL_PIN_UNKNOWN",
      "DATA_TOOL_RESOLVED",
    ]);
    expect(DATA_TOOL_CODES).toHaveLength(12);
  });
});

describe("validateSpec", () => {
  it("合法声明通过且无码", () => {
    const result = validateSpec(spec());
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual([]);
    expect(result.reasons).toEqual([]);
  });

  it("name 不匹配 /^[a-z0-9_]{3,48}$/ → INVALID", () => {
    const result = validateSpec(spec({ name: "Bad-Name" }));
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(["DATA_TOOL_INVALID"]);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("name 过短 → INVALID", () => {
    expect(validateSpec(spec({ name: "ab" })).ok).toBe(false);
  });

  it("version 非严格 x.y.z → INVALID", () => {
    expect(validateSpec(spec({ version: "1.0" })).ok).toBe(false);
    expect(validateSpec(spec({ version: "v1.0.0" })).ok).toBe(false);
    expect(validateSpec(spec({ version: "1.0.0-beta" })).ok).toBe(false);
  });

  it("owner 空/纯空白 → INVALID", () => {
    expect(validateSpec(spec({ owner: "   " })).ok).toBe(false);
  });

  it("parameters 空对象 → INVALID", () => {
    const result = validateSpec(spec({ parameters: {} }));
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(["DATA_TOOL_INVALID"]);
  });

  it("parameters 是数组 → INVALID", () => {
    expect(validateSpec({ ...spec(), parameters: [] }).ok).toBe(false);
  });

  it("handler.kind 非法 → INVALID", () => {
    expect(validateSpec({ ...spec(), handler: { kind: "http", ref: "x" } }).ok).toBe(false);
  });

  it("handler.ref 空 → INVALID", () => {
    expect(validateSpec(spec({ handler: { kind: "command", ref: "  " } })).ok).toBe(false);
  });

  it("permissions 既无 mode 也无非空 allowlist → INVALID", () => {
    expect(validateSpec({ ...spec(), permissions: {} }).ok).toBe(false);
    expect(validateSpec({ ...spec(), permissions: { allowlist: [] } }).ok).toBe(false);
  });

  it("permissions 仅 allowlist 非空 → 通过", () => {
    expect(validateSpec({ ...spec(), permissions: { allowlist: ["read_file"] } }).ok).toBe(true);
  });

  it("layer 出现但不是 data → INVALID", () => {
    expect(validateSpec({ ...spec(), layer: "native" }).ok).toBe(false);
  });

  it("shadowOf 非自指 → INVALID", () => {
    expect(validateSpec(spec({ shadowOf: "other_tool" })).ok).toBe(false);
  });

  it("wrapOf 非自指 → INVALID", () => {
    expect(validateSpec(spec({ wrapOf: "other_tool" })).ok).toBe(false);
  });

  it("多类错误合并成单条 INVALID(去重)", () => {
    const result = validateSpec({ name: "A", version: "x", owner: "", parameters: {}, handler: {}, permissions: {} });
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(["DATA_TOOL_INVALID"]);
    expect(result.reasons.length).toBeGreaterThanOrEqual(6);
  });

  it("畸形入参不抛:null/undefined/字符串/数组/数字", () => {
    for (const bad of [null, undefined, "spec", [], 42, true]) {
      const result = validateSpec(bad);
      expect(result.ok).toBe(false);
      expect(result.codes).toContain("DATA_TOOL_INVALID");
      expect(Array.isArray(result.reasons)).toBe(true);
    }
  });
});

describe("compareSemver", () => {
  it("三态 -1 / 0 / 1", () => {
    expect(compareSemver("1.0.0", "2.0.0")).toBe(-1);
    expect(compareSemver("1.10.0", "1.9.0")).toBe(1);
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  });

  it("逐段比较:patch 决定、非法按 0", () => {
    expect(compareSemver("1.2.3", "1.2.10")).toBe(-1);
    expect(compareSemver("nope", "1.0.0")).toBe(0);
    expect(compareSemver("1.0.0", "1.0")).toBe(0);
  });
});

describe("registerTool", () => {
  it("新增写入 data 与 versions 单元素", () => {
    const result = registerTool(createRegistry(), spec(), { now: 1700000000000 });
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual(["DATA_TOOL_REGISTERED"]);
    expect(result.registry.data.demo_tool?.version).toBe("1.0.0");
    expect(result.registry.versions.demo_tool).toHaveLength(1);
    expect(result.registry.data.demo_tool?.createdAt).toBe(1700000000000);
    expect(result.registry.data.demo_tool?.layer).toBe("data");
  });

  it("createdAt 缺省保留调用方给定值", () => {
    const result = registerTool(createRegistry(), spec({ createdAt: 555 }));
    expect(result.registry.data.demo_tool?.createdAt).toBe(555);
  });

  it("畸形 spec → INVALID,registry 原样", () => {
    const base = createRegistry();
    const result = registerTool(base, { name: "x" } as unknown as DataToolSpec);
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(["DATA_TOOL_INVALID"]);
    expect(result.registry).toBe(base);
  });

  it("native 同名且无 shadow/wrap → NATIVE_IMMUTABLE 且 registry 未变", () => {
    const base = createRegistry({ native: ["demo_tool"] });
    const result = registerTool(base, spec());
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(["DATA_TOOL_NATIVE_IMMUTABLE"]);
    expect(result.registry).toBe(base);
    expect(result.registry.data).toEqual({});
    expect(typeof result.reason).toBe("string");
  });

  it("opts.nativeNames 传入的 native 名同样受保护", () => {
    const result = registerTool(createRegistry(), spec(), { nativeNames: ["demo_tool"] });
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(["DATA_TOOL_NATIVE_IMMUTABLE"]);
  });

  it("shadowOf 自指 → 允许,且 native 名单保留原名", () => {
    const base = createRegistry({ native: ["demo_tool"] });
    const result = registerTool(base, spec({ shadowOf: "demo_tool" }));
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual(["DATA_TOOL_REGISTERED"]);
    expect(result.registry.native).toEqual(["demo_tool"]);
    expect(result.registry.data.demo_tool?.shadowOf).toBe("demo_tool");
  });

  it("wrapOf 自指 → 允许", () => {
    const base = createRegistry({ native: ["demo_tool"] });
    const result = registerTool(base, spec({ wrapOf: "demo_tool" }));
    expect(result.ok).toBe(true);
    expect(result.registry.data.demo_tool?.wrapOf).toBe("demo_tool");
  });

  it("rsi 无 approval → NEEDS_APPROVAL 且 registry 不变", () => {
    const base = createRegistry();
    const result = registerTool(base, spec({ registeredBy: "rsi" }));
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(["DATA_TOOL_NEEDS_APPROVAL"]);
    expect(result.registry).toBe(base);
    expect(result.registry.data).toEqual({});
  });

  it("rsi + approval.ok=false → 仍 NEEDS_APPROVAL", () => {
    const result = registerTool(createRegistry(), spec({ registeredBy: "rsi", approval: { ok: false } }));
    expect(result.codes).toEqual(["DATA_TOOL_NEEDS_APPROVAL"]);
  });

  it("rsi + approval.ok=true → 注册成功", () => {
    const result = registerTool(
      createRegistry(),
      spec({ registeredBy: "rsi", approval: { ok: true, approverKind: "human", approverId: "u1", at: 1 } }),
    );
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual(["DATA_TOOL_REGISTERED"]);
  });

  it("human 无 approval → 注册成功", () => {
    const result = registerTool(createRegistry(), spec({ registeredBy: "human" }));
    expect(result.ok).toBe(true);
  });

  it("升级:data 指向新版,versions 保留旧版并降序", () => {
    const first = registered();
    const result = registerTool(first, spec({ version: "2.0.0" }));
    expect(result.ok).toBe(true);
    expect(result.registry.data.demo_tool?.version).toBe("2.0.0");
    expect(result.registry.versions.demo_tool?.map((entry) => entry.version)).toEqual(["2.0.0", "1.0.0"]);
    expect(result.registry.versions.demo_tool?.[0]).toBe(result.registry.data.demo_tool);
  });

  it("升级跨多版本保持降序", () => {
    let registry = registered();
    registry = registerTool(registry, spec({ version: "1.5.0" })).registry;
    registry = registerTool(registry, spec({ version: "1.10.0" })).registry;
    registry = registerTool(registry, spec({ version: "2.0.0" })).registry;
    expect(registry.versions.demo_tool?.map((entry) => entry.version)).toEqual(["2.0.0", "1.10.0", "1.5.0", "1.0.0"]);
  });

  it("同版本 → DUPLICATE", () => {
    const first = registered();
    const result = registerTool(first, spec());
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(["DATA_TOOL_DUPLICATE"]);
    expect(result.registry).toBe(first);
  });

  it("降级版本 → VERSION_STALE", () => {
    const first = registered({ version: "2.0.0" });
    const result = registerTool(first, spec({ version: "1.9.9" }));
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(["DATA_TOOL_VERSION_STALE"]);
    expect(result.registry).toBe(first);
  });

  it("registry 不可变:返回新对象且原对象内容不变", () => {
    const base = createRegistry({ native: ["read_file"], plugin: ["p1"], degraded: { demo_tool: ["rg"] } });
    const result = registerTool(base, spec());
    expect(result.registry).not.toBe(base);
    expect(result.registry.native).not.toBe(base.native);
    expect(result.registry.data).not.toBe(base.data);
    expect(base.data).toEqual({});
    expect(base.versions).toEqual({});
    expect(base.degraded).toEqual({ demo_tool: ["rg"] });
    expect(base.pins).toEqual({});
    const upgraded = registerTool(result.registry, spec({ version: "1.1.0" }));
    expect(base.data.demo_tool).toBeUndefined();
    expect(result.registry.data.demo_tool?.version).toBe("1.0.0");
    expect(result.registry.versions.demo_tool).toHaveLength(1);
    expect(upgraded.registry.versions.demo_tool).not.toBe(result.registry.versions.demo_tool);
  });

  it("畸形 registry 不抛 → INVALID", () => {
    const result = registerTool(null as unknown as DataToolRegistry, spec());
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(["DATA_TOOL_INVALID"]);
  });
});

describe("unregisterTool", () => {
  it("未知工具 → UNREGISTERED", () => {
    const base = createRegistry();
    const result = unregisterTool(base, "ghost_tool");
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(["DATA_TOOL_UNREGISTERED"]);
    expect(result.reason).toBe("未注册");
    expect(result.registry).toBe(base);
  });

  it("普通注销:data 与 versions 同时删除", () => {
    const base = registered();
    const result = unregisterTool(base, "demo_tool");
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual(["DATA_TOOL_UNREGISTERED"]);
    expect(result.restored).toBeUndefined();
    expect(result.registry.data.demo_tool).toBeUndefined();
    expect(result.registry.versions.demo_tool).toBeUndefined();
    expect(base.data.demo_tool?.version).toBe("1.0.0");
  });

  it("shadow 注销:restored 回退到被遮蔽 native 并清理 degraded", () => {
    const base = createRegistry({ native: ["demo_tool"] });
    const withShadow = registerTool(
      base,
      spec({ shadowOf: "demo_tool", requires: [{ kind: "binary", name: "rg" }] }),
    ).registry;
    const degraded = checkDependencies(withShadow, { binaries: [] }).registry;
    expect(degraded.degraded).toHaveProperty("demo_tool");
    const result = unregisterTool(withShadow, "demo_tool");
    expect(result.ok).toBe(true);
    expect(result.restored).toBe("demo_tool");
    expect(result.registry.native).toEqual(["demo_tool"]);
    expect(result.registry.degraded.demo_tool).toBeUndefined();
  });
});

describe("checkDependencies", () => {
  const env = { binaries: ["rg", "ffmpeg"], envVars: ["API_KEY"], files: ["/tmp/input.json"], mcpMethods: ["mcp.search"] };

  it("binary 缺失 → DEP_MISSING + DEGRADED", () => {
    const base = registered({ requires: [{ kind: "binary", name: "ripgrep" }] });
    const result = checkDependencies(base, { ...env, binaries: [] });
    expect(result.missing).toEqual([{ name: "demo_tool", kind: "binary", dep: "ripgrep" }]);
    expect(result.degraded).toEqual(["demo_tool"]);
    expect(result.registry.degraded.demo_tool).toEqual(["ripgrep"]);
    expect(result.codes).toEqual(["DATA_TOOL_DEP_MISSING", "DATA_TOOL_DEGRADED"]);
  });

  it("env 缺失", () => {
    const base = registered({ requires: [{ kind: "env", name: "TOKEN" }] });
    const result = checkDependencies(base, env);
    expect(result.missing).toEqual([{ name: "demo_tool", kind: "env", dep: "TOKEN" }]);
    expect(result.codes).toContain("DATA_TOOL_DEP_MISSING");
  });

  it("file 缺失", () => {
    const base = registered({ requires: [{ kind: "file", name: "/tmp/missing.json" }] });
    const result = checkDependencies(base, env);
    expect(result.missing).toEqual([{ name: "demo_tool", kind: "file", dep: "/tmp/missing.json" }]);
  });

  it("mcp 方法缺失", () => {
    const base = registered({ requires: [{ kind: "mcp", name: "mcp.unknown" }] });
    const result = checkDependencies(base, env);
    expect(result.missing).toEqual([{ name: "demo_tool", kind: "mcp", dep: "mcp.unknown" }]);
  });

  it("四类都满足 → 无 missing / 无降级 / 无码", () => {
    const base = registered({
      requires: [
        { kind: "binary", name: "rg" },
        { kind: "env", name: "API_KEY" },
        { kind: "file", name: "/tmp/input.json" },
        { kind: "mcp", name: "mcp.search" },
      ],
    });
    const result = checkDependencies(base, env);
    expect(result.missing).toEqual([]);
    expect(result.degraded).toEqual([]);
    expect(result.registry.degraded).toEqual({});
    expect(result.codes).toEqual([]);
  });

  it("补全依赖后从 degraded 清空", () => {
    const base = registered({ requires: [{ kind: "binary", name: "rg" }] });
    const broken = checkDependencies(base, { binaries: [] });
    expect(broken.registry.degraded.demo_tool).toEqual(["rg"]);
    const healed = checkDependencies(broken.registry, { binaries: ["rg"] });
    expect(healed.degraded).toEqual([]);
    expect(healed.registry.degraded.demo_tool).toBeUndefined();
    expect(healed.codes).toEqual([]);
  });

  it("部分满足:只记缺失项,多工具按名升序结算", () => {
    let base = registered({ requires: [
      { kind: "binary", name: "rg" },
      { kind: "binary", name: "fd" },
    ] });
    base = registerTool(base, spec({ name: "alpha_tool", requires: [{ kind: "env", name: "MISSING_ENV" }] })).registry;
    const result = checkDependencies(base, { binaries: ["rg"] });
    expect(result.missing).toEqual([
      { name: "alpha_tool", kind: "env", dep: "MISSING_ENV" },
      { name: "demo_tool", kind: "binary", dep: "fd" },
    ]);
    expect(result.degraded).toEqual(["alpha_tool", "demo_tool"]);
  });
});

describe("resolveTool", () => {
  it("data 命中 → layer data + RESOLVED", () => {
    const base = registered();
    const result = resolveTool(base, "demo_tool");
    expect(result.layer).toBe("data");
    expect(result.spec?.version).toBe("1.0.0");
    expect(result.codes).toEqual(["DATA_TOOL_RESOLVED"]);
    expect(result.degraded).toBeUndefined();
  });

  it("native 命中 → layer native + RESOLVED", () => {
    const result = resolveTool(createRegistry({ native: ["read_file"] }), "read_file");
    expect(result.layer).toBe("native");
    expect(result.spec).toBeUndefined();
    expect(result.codes).toEqual(["DATA_TOOL_RESOLVED"]);
  });

  it("未知工具 → layer native + UNREGISTERED 且不填 spec", () => {
    const result = resolveTool(createRegistry(), "ghost_tool");
    expect(result.layer).toBe("native");
    expect(result.spec).toBeUndefined();
    expect(result.codes).toEqual(["DATA_TOOL_UNREGISTERED"]);
  });

  it("★钉扎:旧版本在会话内保持生效,新会话拿新版", () => {
    const v1 = registered();
    const pin = pinToolVersion(v1, "s1", "demo_tool", "1.0.0");
    expect(pin.ok).toBe(true);
    const v2 = registerTool({ ...v1, pins: pin.pins }, spec({ version: "2.0.0" })).registry;
    const pinned = resolveTool(v2, "demo_tool", { sessionId: "s1" });
    expect(pinned.spec?.version).toBe("1.0.0");
    expect(pinned.layer).toBe("data");
    expect(pinned.codes).toContain("DATA_TOOL_PINNED");
    expect(pinned.codes).toContain("DATA_TOOL_RESOLVED");
    const fresh = resolveTool(v2, "demo_tool", { sessionId: "s2" });
    expect(fresh.spec?.version).toBe("2.0.0");
    expect(fresh.codes).toEqual(["DATA_TOOL_RESOLVED"]);
  });

  it("registry.pins 里的钉扎同样生效", () => {
    const v1 = registered();
    const pinned = createRegistry({ ...v1, pins: { s9: { demo_tool: "1.0.0" } } });
    const v2 = registerTool(pinned, spec({ version: "2.0.0" })).registry;
    expect(resolveTool(v2, "demo_tool", { sessionId: "s9" }).spec?.version).toBe("1.0.0");
  });

  it("opts.sessionPins 优先于 registry.pins", () => {
    const v1 = registered();
    const pinned = createRegistry({ ...v1, pins: { s1: { demo_tool: "1.0.0" } } });
    const v2 = registerTool(pinned, spec({ version: "2.0.0" })).registry;
    const result = resolveTool(v2, "demo_tool", { sessionId: "s1", sessionPins: { s1: { demo_tool: "2.0.0" } } });
    expect(result.spec?.version).toBe("2.0.0");
  });

  it("钉扎未知版本 → PIN_UNKNOWN 并回落当前版本", () => {
    const base = registered();
    const result = resolveTool(base, "demo_tool", { sessionPins: { s1: { demo_tool: "9.9.9" } }, sessionId: "s1" });
    expect(result.spec?.version).toBe("1.0.0");
    expect(result.layer).toBe("data");
    expect(result.codes).toContain("DATA_TOOL_PIN_UNKNOWN");
    expect(result.codes).toContain("DATA_TOOL_RESOLVED");
  });

  it("degraded 透传到 resolve 结果", () => {
    const base = registered({ requires: [{ kind: "binary", name: "rg" }] });
    const degraded = checkDependencies(base, { binaries: [] }).registry;
    const result = resolveTool(degraded, "demo_tool");
    expect(result.degraded).toEqual(["rg"]);
    expect(result.spec?.version).toBe("1.0.0");
  });

  it("畸形入参不抛", () => {
    const result = resolveTool(undefined as unknown as DataToolRegistry, "demo_tool");
    expect(result.codes).toEqual(["DATA_TOOL_INVALID"]);
    expect(resolveTool(createRegistry(), 42 as unknown as string).codes).toEqual(["DATA_TOOL_UNREGISTERED"]);
  });
});

describe("pinToolVersion", () => {
  it("成功:返回新 pins 对象且不改入参", () => {
    const base = registered();
    const result = pinToolVersion(base, "s1", "demo_tool", "1.0.0");
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual(["DATA_TOOL_PINNED"]);
    expect(result.pins.s1?.demo_tool).toBe("1.0.0");
    expect(base.pins).toEqual({});
    expect(result.pins).not.toBe(base.pins);
  });

  it("保留同一会话其它工具的钉扎", () => {
    const base = { ...registered(), pins: { s1: { other_tool: "3.0.0" } } };
    const result = pinToolVersion(base, "s1", "demo_tool", "1.0.0");
    expect(result.pins.s1).toEqual({ other_tool: "3.0.0", demo_tool: "1.0.0" });
    expect(base.pins.s1).toEqual({ other_tool: "3.0.0" });
  });

  it("未知工具 → PIN_UNKNOWN,pins 原样", () => {
    const base = createRegistry();
    const result = pinToolVersion(base, "s1", "ghost_tool", "1.0.0");
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(["DATA_TOOL_PIN_UNKNOWN"]);
    expect(result.pins).toEqual(base.pins);
    expect(typeof result.reason).toBe("string");
  });

  it("未知版本 → PIN_UNKNOWN 且不写 pins", () => {
    const base = registered();
    const result = pinToolVersion(base, "s1", "demo_tool", "9.9.9");
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(["DATA_TOOL_PIN_UNKNOWN"]);
    expect(result.pins).toEqual({});
  });

  it("空 sessionId → INVALID 不抛", () => {
    const result = pinToolVersion(registered(), "", "demo_tool", "1.0.0");
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(["DATA_TOOL_INVALID"]);
  });

  it("钉扎历史旧版本(升级后仍可钉)", () => {
    const v2 = registerTool(registered(), spec({ version: "2.0.0" })).registry;
    const result = pinToolVersion(v2, "s1", "demo_tool", "1.0.0");
    expect(result.ok).toBe(true);
    const pinned = { ...v2, pins: result.pins };
    expect(resolveTool(pinned, "demo_tool", { sessionId: "s1" }).spec?.version).toBe("1.0.0");
  });
});

describe("listTools", () => {
  it("data 按 name 升序,native/plugin 原样", () => {
    let registry = createRegistry({ native: ["read_file"], plugin: ["p1"] });
    registry = registerTool(registry, spec({ name: "zebra_tool" })).registry;
    registry = registerTool(registry, spec({ name: "alpha_tool" })).registry;
    const listed = listTools(registry);
    expect(listed.native).toEqual(["read_file"]);
    expect(listed.plugin).toEqual(["p1"]);
    expect(listed.data.map((entry) => entry.name)).toEqual(["alpha_tool", "zebra_tool"]);
    expect(listed.data.map((entry) => entry.version)).toEqual(["1.0.0", "1.0.0"]);
  });

  it("空 degraded / 缺省 shadowOf·wrapOf 不写字段", () => {
    const listed = listTools(registered());
    const entry = listed.data[0]!;
    expect(Object.keys(entry).sort()).toEqual(["name", "version"]);
    expect("degraded" in entry).toBe(false);
    expect("shadowOf" in entry).toBe(false);
    expect("wrapOf" in entry).toBe(false);
  });

  it("有降级与 shadow/wrap 时写字段", () => {
    const base = createRegistry({ native: ["demo_tool"] });
    let registry = registerTool(base, spec({ shadowOf: "demo_tool" })).registry;
    registry = registerTool(registry, spec({ name: "wrap_tool", wrapOf: "wrap_tool" })).registry;
    registry = registerTool(
      registry,
      spec({ name: "deg_tool", version: "0.1.0", requires: [{ kind: "binary", name: "fd" }] }),
    ).registry;
    const degraded = checkDependencies(registry, { binaries: [] }).registry;
    expect(degraded.degraded.deg_tool).toEqual(["fd"]);
    const listed = listTools(degraded);
    const shadowEntry = listed.data.find((entry) => entry.name === "demo_tool");
    expect(shadowEntry?.shadowOf).toBe("demo_tool");
    expect(listed.data.find((entry) => entry.name === "wrap_tool")?.wrapOf).toBe("wrap_tool");
    expect(listed.data.find((entry) => entry.name === "deg_tool")?.degraded).toEqual(["fd"]);
  });

  it("畸形 registry 不抛", () => {
    expect(listTools(null as unknown as DataToolRegistry)).toEqual({ native: [], data: [], plugin: [] });
  });
});

describe("diffVersions", () => {
  it("无变化", () => {
    const result = diffVersions(spec(), spec());
    expect(result.changed).toBe(false);
    expect(result.schemaChanged).toBe(false);
    expect(result.handlerChanged).toBe(false);
    expect(result.permissionsChanged).toBe(false);
    expect(result.depsChanged).toBe(false);
  });

  it("schemaChanged", () => {
    const result = diffVersions(spec(), spec({ parameters: { type: "object", properties: {} } }));
    expect(result.schemaChanged).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.handlerChanged).toBe(false);
  });

  it("handlerChanged", () => {
    const result = diffVersions(spec(), { ...spec(), handler: { kind: "mcp", ref: "mcp.run" } });
    expect(result.handlerChanged).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.schemaChanged).toBe(false);
  });

  it("permissionsChanged", () => {
    const result = diffVersions(spec(), { ...spec(), permissions: { mode: "write" } });
    expect(result.permissionsChanged).toBe(true);
    expect(result.changed).toBe(true);
  });

  it("depsChanged:排序后比较,缺省视作空", () => {
    const withDeps = { ...spec(), requires: [{ kind: "binary" as const, name: "rg" }] };
    expect(diffVersions(spec(), withDeps).depsChanged).toBe(true);
    const reordered = {
      ...spec(),
      requires: [
        { kind: "binary" as const, name: "rg" },
        { kind: "env" as const, name: "A" },
      ],
    };
    const flipped = {
      ...spec(),
      requires: [
        { kind: "env" as const, name: "A" },
        { kind: "binary" as const, name: "rg" },
      ],
    };
    expect(diffVersions(reordered, flipped).depsChanged).toBe(false);
    expect(diffVersions(spec(), spec()).depsChanged).toBe(false);
  });

  it("畸形入参不抛(undefined)", () => {
    const result = diffVersions(undefined as unknown as DataToolSpec, null as unknown as DataToolSpec);
    expect(result.changed).toBe(false);
  });
});
