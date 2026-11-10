/**
 * 工具版本钉扎(#207):会话快照 / 版本解析 / 调用记账 / 升级留痕 / 兼容性 / 历史回放。
 * 全部纯数据 + 固定时间戳常量,不碰文件与真实时钟;非法输入只换码,不抛异常。
 */
import { describe, expect, it } from "vitest";
import {
  TOOL_PIN_CALL_RECORDED,
  TOOL_PIN_CODES,
  TOOL_PIN_CONFIRM_REQUIRED,
  TOOL_PIN_CREATED,
  TOOL_PIN_INCOMPATIBLE,
  TOOL_PIN_INVALID,
  TOOL_PIN_RENAME_HINT,
  TOOL_PIN_REPLAY_RESOLVED,
  TOOL_PIN_SCHEMA_MISSING,
  TOOL_PIN_SESSION_LOCKED,
  TOOL_PIN_UNKNOWN_TOOL,
  TOOL_PIN_UPGRADED,
  TOOL_PIN_VERSION,
  applyUpgrade,
  argHintsForReplay,
  checkCompatibility,
  createSessionPins,
  pinForEnvelope,
  recordCall,
  replayCall,
  resolveVersion,
} from "../src/agent/tool-version-pin.ts";
import type { JSONSchemaObject, SessionToolPins, ToolCatalog } from "../src/agent/tool-version-pin.ts";

const T0 = 1_700_000_000_000;

/** 旧版:path 必填,limit 是 number,legacy 已废弃。 */
const SCHEMA_V1: JSONSchemaObject = {
  type: "object",
  properties: {
    path: { type: "string" },
    limit: { type: "number" },
    legacy: { type: "boolean" },
  },
  required: ["path"],
};

/** 新版:legacy 删除、limit 变 string 且升为必填、新增 extra。 */
const SCHEMA_V2: JSONSchemaObject = {
  type: "object",
  properties: {
    path: { type: "string" },
    limit: { type: "string" },
    extra: { type: "number" },
  },
  required: ["path", "limit"],
};

function catalog(): ToolCatalog {
  return {
    read_file: {
      latest: "1.2.0",
      versions: ["1.0.0", "1.1.0", "1.2.0"],
      schemas: { "1.0.0": SCHEMA_V1, "1.2.0": SCHEMA_V2 },
    },
    grep: { latest: "2.0.0", versions: ["2.0.0"], schemas: { "2.0.0": SCHEMA_V1 } },
  };
}

function pins(partial: Partial<SessionToolPins> = {}): SessionToolPins {
  return {
    sessionId: "S-1",
    createdAt: T0,
    versions: { read_file: "1.0.0", grep: "2.0.0" },
    status: "open",
    upgrades: [],
    ...partial,
  };
}

/** 让畸形输入能直接塞进签名(测试专用)。 */
function junk(value: unknown): never {
  return value as never;
}

describe("码表与契约", () => {
  it("暴露固定代数与 11 个稳定码", () => {
    expect(TOOL_PIN_VERSION).toBe(1);
    expect(TOOL_PIN_CODES.length).toBe(11);
    expect(new Set(TOOL_PIN_CODES).size).toBe(11);
  });

  it("逐个导出的常量与码表同值", () => {
    expect(TOOL_PIN_CODES).toContain(TOOL_PIN_INVALID);
    expect(TOOL_PIN_CODES).toContain(TOOL_PIN_CREATED);
    expect(TOOL_PIN_CODES).toContain(TOOL_PIN_UNKNOWN_TOOL);
    expect(TOOL_PIN_CODES).toContain(TOOL_PIN_SESSION_LOCKED);
    expect(TOOL_PIN_CODES).toContain(TOOL_PIN_CONFIRM_REQUIRED);
    expect(TOOL_PIN_CODES).toContain(TOOL_PIN_UPGRADED);
    expect(TOOL_PIN_CODES).toContain(TOOL_PIN_INCOMPATIBLE);
    expect(TOOL_PIN_CODES).toContain(TOOL_PIN_RENAME_HINT);
    expect(TOOL_PIN_CODES).toContain(TOOL_PIN_SCHEMA_MISSING);
    expect(TOOL_PIN_CODES).toContain(TOOL_PIN_REPLAY_RESOLVED);
    expect(TOOL_PIN_CODES).toContain(TOOL_PIN_CALL_RECORDED);
  });
});

describe("createSessionPins", () => {
  it("快照每个工具的 latest 并给出 CREATED", () => {
    const result = createSessionPins({ sessionId: "S-1", catalog: catalog(), at: T0 });
    expect(result.codes).toEqual([TOOL_PIN_CREATED]);
    expect(result.pins.versions).toEqual({ read_file: "1.2.0", grep: "2.0.0" });
    expect(result.pins.status).toBe("open");
    expect(result.pins.createdAt).toBe(T0);
    expect(result.pins.sessionId).toBe("S-1");
  });

  it("overrides 生效且优先于 latest", () => {
    const result = createSessionPins({ sessionId: "S-1", catalog: catalog(), overrides: { read_file: "1.0.0" }, at: T0 });
    expect(result.codes).toEqual([TOOL_PIN_CREATED]);
    expect(result.pins.versions["read_file"]).toBe("1.0.0");
    expect(result.pins.versions["grep"]).toBe("2.0.0");
  });

  it("override 指向目录外的工具 → UNKNOWN_TOOL 且只有目录内工具被钉", () => {
    const result = createSessionPins({ sessionId: "S-1", catalog: catalog(), overrides: { web_fetch: "9.9.9" }, at: T0 });
    expect(result.codes).toContain(TOOL_PIN_UNKNOWN_TOOL);
    expect(result.codes).toContain(TOOL_PIN_CREATED);
    expect(result.pins.versions["web_fetch"]).toBeUndefined();
    expect(Object.keys(result.pins.versions)).toEqual(["read_file", "grep"]);
  });

  it("override 版本不在 versions 白名单 → 该工具不钉 + UNKNOWN_TOOL", () => {
    const result = createSessionPins({ sessionId: "S-1", catalog: catalog(), overrides: { read_file: "0.9.0" }, at: T0 });
    expect(result.codes).toContain(TOOL_PIN_UNKNOWN_TOOL);
    expect(result.pins.versions["read_file"]).toBeUndefined();
    expect(result.pins.versions["grep"]).toBe("2.0.0");
  });

  it("versions 为空数组时不做白名单校验", () => {
    const result = createSessionPins({
      sessionId: "S-1",
      catalog: { odd: { latest: "3.0.0", versions: [] } },
      at: T0,
    });
    expect(result.codes).toEqual([TOOL_PIN_CREATED]);
    expect(result.pins.versions["odd"]).toBe("3.0.0");
  });

  it("latest 缺失/空 → 跳过该工具 + UNKNOWN_TOOL", () => {
    const result = createSessionPins({
      sessionId: "S-1",
      catalog: { broken: { latest: "", versions: ["1.0.0"] }, ok: { latest: "1.0.0", versions: ["1.0.0"] } },
      at: T0,
    });
    expect(result.codes).toContain(TOOL_PIN_UNKNOWN_TOOL);
    expect(result.pins.versions["broken"]).toBeUndefined();
    expect(result.pins.versions["ok"]).toBe("1.0.0");
  });

  it("sessionId 空 → 空 versions + INVALID", () => {
    const result = createSessionPins({ sessionId: "  ", catalog: catalog(), at: T0 });
    expect(result.codes).toEqual([TOOL_PIN_INVALID]);
    expect(result.pins.versions).toEqual({});
  });

  it("catalog 非对象 → 空 versions + INVALID", () => {
    const result = createSessionPins({ sessionId: "S-1", catalog: junk(["x"]), at: T0 });
    expect(result.codes).toEqual([TOOL_PIN_INVALID]);
    expect(result.pins.versions).toEqual({});
  });

  it("at 非有限数 → createdAt 记 0 且不报错", () => {
    const result = createSessionPins({ sessionId: "S-1", catalog: catalog(), at: Number.NaN });
    expect(result.pins.createdAt).toBe(0);
    expect(result.codes).toContain(TOOL_PIN_CREATED);
  });

  it("不改入参 catalog(深拷贝)", () => {
    const source = catalog();
    const before = JSON.stringify(source);
    const result = createSessionPins({ sessionId: "S-1", catalog: source, at: T0 });
    result.pins.versions["read_file"] = "tampered";
    expect(JSON.stringify(source)).toBe(before);
  });

  it("畸形入参不抛", () => {
    expect(() => createSessionPins(junk(null))).not.toThrow();
    expect(() => createSessionPins(junk(42))).not.toThrow();
    expect(createSessionPins(junk(null)).codes).toEqual([TOOL_PIN_INVALID]);
  });
});

describe("resolveVersion", () => {
  it("命中钉扎 → 返回版本且无码", () => {
    const result = resolveVersion(pins(), "read_file");
    expect(result.version).toBe("1.0.0");
    expect(result.codes).toEqual([]);
  });

  it("会话内版本固定:升级前多次解析结果一致", () => {
    const state = pins();
    expect(resolveVersion(state, "read_file").version).toBe("1.0.0");
    expect(resolveVersion(state, "read_file").version).toBe("1.0.0");
  });

  it("closed 会话照常解析", () => {
    const result = resolveVersion(pins({ status: "closed" }), "read_file");
    expect(result.version).toBe("1.0.0");
    expect(result.codes).toEqual([]);
  });

  it("未钉工具 → UNKNOWN_TOOL", () => {
    expect(resolveVersion(pins(), "web_fetch").codes).toEqual([TOOL_PIN_UNKNOWN_TOOL]);
  });

  it("tool 空 → INVALID", () => {
    expect(resolveVersion(pins(), " ").codes).toEqual([TOOL_PIN_INVALID]);
  });

  it("pins 畸形 → INVALID 不抛", () => {
    expect(resolveVersion(junk(null), "read_file").codes).toEqual([TOOL_PIN_INVALID]);
    expect(resolveVersion(junk({ versions: [] }), "read_file").codes).toEqual([TOOL_PIN_INVALID]);
  });
});

describe("recordCall", () => {
  it("成功记账带钉扎版本", () => {
    const result = recordCall(pins(), { callId: "C-1", tool: "read_file", args: { path: "a.ts" }, at: T0 + 5 });
    expect(result.codes).toEqual([TOOL_PIN_CALL_RECORDED]);
    expect(result.call?.version).toBe("1.0.0");
    expect(result.call?.sessionId).toBe("S-1");
    expect(result.call?.args).toEqual({ path: "a.ts" });
    expect(result.call?.at).toBe(T0 + 5);
  });

  it("args 缺省为 {}", () => {
    const result = recordCall(pins(), { callId: "C-1", tool: "grep", at: T0 });
    expect(result.call?.args).toEqual({});
  });

  it("args 非对象(数组/字符串) → INVALID", () => {
    expect(recordCall(pins(), { callId: "C-1", tool: "grep", args: junk([1, 2]) as never }).codes).toEqual([TOOL_PIN_INVALID]);
    expect(recordCall(pins(), { callId: "C-1", tool: "grep", args: junk("path") as never }).codes).toEqual([TOOL_PIN_INVALID]);
  });

  it("args 为 null → INVALID", () => {
    expect(recordCall(pins(), { callId: "C-1", tool: "grep", args: junk(null) as never }).codes).toEqual([TOOL_PIN_INVALID]);
  });

  it("closed 会话拒收 → SESSION_LOCKED 且无 call", () => {
    const result = recordCall(pins({ status: "closed" }), { callId: "C-2", tool: "read_file", at: T0 });
    expect(result.codes).toEqual([TOOL_PIN_SESSION_LOCKED]);
    expect(result.call).toBeUndefined();
  });

  it("未钉工具 → UNKNOWN_TOOL", () => {
    const result = recordCall(pins(), { callId: "C-3", tool: "web_fetch", at: T0 });
    expect(result.codes).toEqual([TOOL_PIN_UNKNOWN_TOOL]);
    expect(result.call).toBeUndefined();
  });

  it("callId/tool 空 → INVALID", () => {
    expect(recordCall(pins(), { callId: "", tool: "read_file", at: T0 }).codes).toEqual([TOOL_PIN_INVALID]);
    expect(recordCall(pins(), { callId: "C-4", tool: "  ", at: T0 }).codes).toEqual([TOOL_PIN_INVALID]);
  });

  it("traceBatchKey 非空才挂上", () => {
    const withKey = recordCall(pins(), { callId: "C-5", tool: "read_file", at: T0, traceBatchKey: "B-1" });
    expect(withKey.call?.traceBatchKey).toBe("B-1");
    const blankKey = recordCall(pins(), { callId: "C-6", tool: "read_file", at: T0, traceBatchKey: "   " });
    expect(blankKey.call && "traceBatchKey" in blankKey.call).toBe(false);
  });

  it("at 非有限数记 0", () => {
    const result = recordCall(pins(), { callId: "C-7", tool: "read_file", at: Number.POSITIVE_INFINITY });
    expect(result.call?.at).toBe(0);
  });

  it("深拷贝 args,不改入参", () => {
    const args = { path: "a.ts", nested: { depth: 1 } };
    const before = JSON.stringify(args);
    const result = recordCall(pins(), { callId: "C-8", tool: "read_file", args, at: T0 });
    (result.call?.args["nested"] as Record<string, unknown>)["depth"] = 99;
    expect(JSON.stringify(args)).toBe(before);
  });

  it("畸形入参不抛", () => {
    expect(() => recordCall(junk(undefined), junk(undefined))).not.toThrow();
    expect(recordCall(junk(undefined), junk(undefined)).codes).toEqual([TOOL_PIN_INVALID]);
  });
});

describe("applyUpgrade", () => {
  it("未确认 → CONFIRM_REQUIRED,原清单不变", () => {
    const state = pins();
    const result = applyUpgrade(state, { tool: "read_file", to: "1.2.0", by: "rsi", at: T0, confirmed: false });
    expect(result.codes).toEqual([TOOL_PIN_CONFIRM_REQUIRED]);
    expect(result.pins.versions["read_file"]).toBe("1.0.0");
    expect(result.pins.upgrades).toEqual([]);
    expect(state.versions["read_file"]).toBe("1.0.0");
  });

  it("缺 confirmed 字段也算未确认", () => {
    const result = applyUpgrade(pins(), { tool: "read_file", to: "1.2.0", by: "rsi", at: T0 });
    expect(result.codes).toEqual([TOOL_PIN_CONFIRM_REQUIRED]);
  });

  it("closed 会话拒升级 → SESSION_LOCKED", () => {
    const result = applyUpgrade(pins({ status: "closed" }), { tool: "read_file", to: "1.2.0", by: "rsi", at: T0, confirmed: true });
    expect(result.codes).toEqual([TOOL_PIN_SESSION_LOCKED]);
    expect(result.pins.versions["read_file"]).toBe("1.0.0");
  });

  it("to 与当前版本相同 → INVALID", () => {
    const result = applyUpgrade(pins(), { tool: "read_file", to: "1.0.0", by: "rsi", at: T0, confirmed: true });
    expect(result.codes).toEqual([TOOL_PIN_INVALID]);
  });

  it("by 空 → INVALID", () => {
    const result = applyUpgrade(pins(), { tool: "read_file", to: "1.2.0", by: "", at: T0, confirmed: true });
    expect(result.codes).toEqual([TOOL_PIN_INVALID]);
  });

  it("未钉工具 → UNKNOWN_TOOL", () => {
    const result = applyUpgrade(pins(), { tool: "web_fetch", to: "1.0.0", by: "rsi", at: T0, confirmed: true });
    expect(result.codes).toEqual([TOOL_PIN_UNKNOWN_TOOL]);
  });

  it("确认后升级生效并留痕", () => {
    const result = applyUpgrade(pins(), { tool: "read_file", to: "1.2.0", by: "rsi", at: T0 + 9, confirmed: true });
    expect(result.codes).toEqual([TOOL_PIN_UPGRADED]);
    expect(result.pins.versions["read_file"]).toBe("1.2.0");
    expect(result.pins.upgrades).toEqual([
      { at: T0 + 9, tool: "read_file", from: "1.0.0", to: "1.2.0", by: "rsi", confirmed: true },
    ]);
  });

  it("升级后新调用用新版,旧记录仍是旧版", () => {
    const state = pins();
    const before = recordCall(state, { callId: "C-old", tool: "read_file", at: T0 });
    const upgraded = applyUpgrade(state, { tool: "read_file", to: "1.2.0", by: "rsi", at: T0 + 1, confirmed: true });
    const after = recordCall(upgraded.pins, { callId: "C-new", tool: "read_file", at: T0 + 2 });
    expect(before.call?.version).toBe("1.0.0");
    expect(after.call?.version).toBe("1.2.0");
  });

  it("不改入参 pins(返回深拷贝)", () => {
    const state = pins();
    const before = JSON.stringify(state);
    const result = applyUpgrade(state, { tool: "read_file", to: "1.2.0", by: "rsi", at: T0, confirmed: true });
    result.pins.upgrades.push({ at: 0, tool: "x", from: "a", to: "b", by: "c", confirmed: true });
    expect(JSON.stringify(state)).toBe(before);
  });

  it("畸形入参不抛", () => {
    expect(() => applyUpgrade(junk(null), junk(null))).not.toThrow();
    expect(applyUpgrade(junk(null), junk(null)).codes).toEqual([TOOL_PIN_CONFIRM_REQUIRED]);
  });
});

describe("checkCompatibility", () => {
  it("同版本且 schema 齐备 → compatible:true 无码", () => {
    const result = checkCompatibility({
      recordedVersion: "1.0.0",
      currentVersion: "1.0.0",
      oldSchema: SCHEMA_V1,
      newSchema: SCHEMA_V2,
    });
    expect(result).toEqual({ compatible: true, codes: [], renameHints: [], breakingChanges: [] });
  });

  it("schema 缺失优先于同版本判定", () => {
    const result = checkCompatibility({ recordedVersion: "1.0.0", currentVersion: "1.0.0", oldSchema: SCHEMA_V1 });
    expect(result.compatible).toBe(false);
    expect(result.codes).toEqual([TOOL_PIN_SCHEMA_MISSING]);
    expect(result.breakingChanges).toEqual([]);
  });

  it("属性被删 → property-removed", () => {
    const result = checkCompatibility({
      recordedVersion: "1.0.0",
      currentVersion: "1.2.0",
      oldSchema: SCHEMA_V1,
      newSchema: SCHEMA_V2,
    });
    expect(result.compatible).toBe(false);
    expect(result.codes).toEqual([TOOL_PIN_INCOMPATIBLE]);
    expect(result.breakingChanges).toContainEqual({ kind: "property-removed", path: "legacy", from: "boolean" });
  });

  it("类型变化 → type-changed 带 from/to", () => {
    const result = checkCompatibility({
      recordedVersion: "1.0.0",
      currentVersion: "1.2.0",
      oldSchema: SCHEMA_V1,
      newSchema: SCHEMA_V2,
    });
    expect(result.breakingChanges).toContainEqual({ kind: "type-changed", path: "limit", from: "number", to: "string" });
  });

  it("新增必填(属性两边都有) → required-added", () => {
    const result = checkCompatibility({
      recordedVersion: "1.0.0",
      currentVersion: "1.2.0",
      oldSchema: SCHEMA_V1,
      newSchema: SCHEMA_V2,
    });
    expect(result.breakingChanges).toContainEqual({ kind: "required-added", path: "limit" });
    // extra 只在新版存在,不构成 required-added
    expect(result.breakingChanges.some((c) => c.path === "extra")).toBe(false);
  });

  it("无差异 → compatible:true、codes 空", () => {
    const result = checkCompatibility({
      recordedVersion: "1.0.0",
      currentVersion: "1.2.0",
      oldSchema: SCHEMA_V1,
      newSchema: JSON.parse(JSON.stringify(SCHEMA_V1)),
    });
    expect(result.compatible).toBe(true);
    expect(result.codes).toEqual([]);
    expect(result.breakingChanges).toEqual([]);
  });

  it("renameMap 数组形态 → 命中改名提示", () => {
    const oldSchema: JSONSchemaObject = { type: "object", properties: { old_name: { type: "string" } }, required: [] };
    const newSchema: JSONSchemaObject = { type: "object", properties: { new_name: { type: "string" } }, required: [] };
    const result = checkCompatibility({
      recordedVersion: "1.0.0",
      currentVersion: "1.2.0",
      oldSchema,
      newSchema,
      renameMap: [{ from: "old_name", to: "new_name", reason: "统一命名" }],
    });
    expect(result.renameHints).toEqual([{ from: "old_name", to: "new_name", reason: "统一命名" }]);
    expect(result.codes).toContain(TOOL_PIN_RENAME_HINT);
    expect(result.codes).toContain(TOOL_PIN_INCOMPATIBLE);
  });

  it("renameMap Record 形态 → reason 用固定中文说明", () => {
    const oldSchema: JSONSchemaObject = { type: "object", properties: { old_name: { type: "string" } } };
    const newSchema: JSONSchemaObject = { type: "object", properties: { new_name: { type: "string" } } };
    const result = checkCompatibility({
      recordedVersion: "1.0.0",
      currentVersion: "1.2.0",
      oldSchema,
      newSchema,
      renameMap: { old_name: "new_name" },
    });
    expect(result.renameHints.length).toBe(1);
    expect(result.renameHints[0]?.from).toBe("old_name");
    expect(result.renameHints[0]?.to).toBe("new_name");
    expect(result.renameHints[0]?.reason).toMatch(/改名/);
  });

  it("renameMap 判据不成立时不提示", () => {
    const oldSchema: JSONSchemaObject = { type: "object", properties: { keep: { type: "string" } } };
    const newSchema: JSONSchemaObject = { type: "object", properties: { keep: { type: "string" } } };
    const result = checkCompatibility({
      recordedVersion: "1.0.0",
      currentVersion: "1.2.0",
      oldSchema,
      newSchema,
      renameMap: { keep: "renamed" },
    });
    expect(result.renameHints).toEqual([]);
    expect(result.compatible).toBe(true);
  });

  it("breaking 与改名提示并存时两条码都给", () => {
    const result = checkCompatibility({
      recordedVersion: "1.0.0",
      currentVersion: "1.2.0",
      oldSchema: SCHEMA_V1,
      newSchema: SCHEMA_V2,
      renameMap: [{ from: "legacy", to: "extra" }],
    });
    expect(result.codes).toEqual([TOOL_PIN_INCOMPATIBLE, TOOL_PIN_RENAME_HINT]);
    expect(result.renameHints.length).toBe(1);
  });

  it("畸形入参不抛", () => {
    expect(() => checkCompatibility(junk(null))).not.toThrow();
    const result = checkCompatibility(junk(null));
    expect(result.codes).toEqual([TOOL_PIN_SCHEMA_MISSING]);
    expect(result.renameHints).toEqual([]);
  });
});

describe("replayCall", () => {
  it("按记录版本取 schema", () => {
    const result = replayCall({ callId: "C-1", tool: "read_file", version: "1.0.0" }, catalog());
    expect(result.codes).toEqual([TOOL_PIN_REPLAY_RESOLVED]);
    expect(result.schema).toEqual(SCHEMA_V1);
  });

  it("schema 缺失 → SCHEMA_MISSING(不回落 latest)", () => {
    const result = replayCall({ callId: "C-2", tool: "read_file", version: "1.1.0" }, catalog());
    expect(result.codes).toEqual([TOOL_PIN_SCHEMA_MISSING]);
    expect(result.schema).toBeUndefined();
  });

  it("目录里没有该工具 → UNKNOWN_TOOL", () => {
    expect(replayCall({ callId: "C-3", tool: "web_fetch", version: "1.0.0" }, catalog()).codes).toEqual([TOOL_PIN_UNKNOWN_TOOL]);
  });

  it("call 畸形 → INVALID 不抛", () => {
    expect(replayCall(junk(null), catalog()).codes).toEqual([TOOL_PIN_INVALID]);
    expect(replayCall({ tool: "read_file", version: "" }, catalog()).codes).toEqual([TOOL_PIN_INVALID]);
    expect(() => replayCall(junk(7), junk(7))).not.toThrow();
  });

  it("返回的 schema 是深拷贝", () => {
    const source = catalog();
    const result = replayCall({ callId: "C-4", tool: "read_file", version: "1.0.0" }, source);
    expect(result.schema).not.toBe(source["read_file"]!.schemas!["1.0.0"]);
  });
});

describe("argHintsForReplay", () => {
  it("与 latest 相同 → 无提示", () => {
    expect(argHintsForReplay({ tool: "read_file", version: "1.2.0" }, catalog()).hints).toEqual([]);
  });

  it("版本较旧 → version-newer + 新增必填 + 被删属性", () => {
    const hints = argHintsForReplay({ tool: "read_file", version: "1.0.0" }, catalog()).hints;
    expect(hints[0]?.kind).toBe("version-newer");
    expect(hints[0]?.note).toContain("1.0.0");
    expect(hints[0]?.note).toContain("1.2.0");
    expect(hints).toContainEqual(expect.objectContaining({ kind: "required-added", path: "limit" }));
    const removed = hints.find((h) => h.kind === "property-removed" && h.path === "legacy");
    expect(removed?.note).toContain("可能改名");
  });

  it("工具或 schema 缺失 → 无提示", () => {
    expect(argHintsForReplay({ tool: "web_fetch", version: "1.0.0" }, catalog()).hints).toEqual([]);
    expect(argHintsForReplay({ tool: "read_file", version: "1.1.0" }, catalog()).hints).toEqual([]);
  });

  it("畸形入参不抛", () => {
    expect(() => argHintsForReplay(junk(undefined), junk(undefined))).not.toThrow();
    expect(argHintsForReplay(junk(undefined), junk(undefined)).hints).toEqual([]);
  });
});

describe("pinForEnvelope", () => {
  it("投影版本表副本 + 固定代数", () => {
    const envelope = pinForEnvelope(pins());
    expect(envelope.generation).toBe(TOOL_PIN_VERSION);
    expect(envelope.toolVersions).toEqual({ read_file: "1.0.0", grep: "2.0.0" });
    expect("status" in envelope).toBe(false);
  });

  it("副本不与 pins 共享引用", () => {
    const state = pins();
    const envelope = pinForEnvelope(state);
    envelope.toolVersions["read_file"] = "tampered";
    expect(state.versions["read_file"]).toBe("1.0.0");
  });

  it("畸形入参 → 空版本表,不抛", () => {
    expect(pinForEnvelope(junk(null)).toolVersions).toEqual({});
    expect(pinForEnvelope(junk(null)).generation).toBe(1);
  });
});
