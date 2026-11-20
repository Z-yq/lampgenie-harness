import { afterAll, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  TOOL_PIN_CONFIRM_REQUIRED,
  TOOL_PIN_CREATED,
  TOOL_PIN_INVALID,
  TOOL_PIN_REPLAY_RESOLVED,
  TOOL_PIN_SCHEMA_MISSING,
  TOOL_PIN_SESSION_LOCKED,
  TOOL_PIN_UPGRADED,
  type ToolCatalog,
} from "@lampgenie/runtime/agent/tool-version-pin";
import {
  TOOL_PIN_DUPLICATE,
  TOOL_PIN_NOT_FOUND,
  applyUpgrade,
  closeSession,
  createPins,
  getPins,
  listCalls,
  recordCall,
  replayCall,
  reportPins,
  toolPinsPath,
} from "../src/tool-pins-store";

/** 全部用例只写 os.tmpdir() 下的临时目录,绝不碰仓库 .genie。 */
const tempDirs: string[] = [];

function tmpRoot(tag = "tool-pins"): string {
  const dir = mkdtempSync(join(tmpdir(), `${tag}-`));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const OLD_SCHEMA = {
  type: "object",
  properties: { a: { type: "string" } },
  required: ["a"],
};
const NEW_SCHEMA = {
  type: "object",
  properties: { a: { type: "string" }, b: { type: "number" } },
  required: ["a"],
};

function demoCatalog(): ToolCatalog {
  return {
    toolA: {
      latest: "1.0.0",
      versions: ["1.0.0", "2.0.0"],
      schemas: { "1.0.0": OLD_SCHEMA, "2.0.0": NEW_SCHEMA },
    },
  };
}

function lines(root: string): string[] {
  return readText(root)
    .split("\n")
    .filter((line) => line.trim() !== "");
}

/** 台账还没被写过(文件不存在)按空串,便于断言「没写行」。 */
function readText(root: string): string {
  try {
    return readFileSync(toolPinsPath(root), "utf8");
  } catch {
    return "";
  }
}

describe("tool-pins-store create / getPins", () => {
  it("create 把 catalog 快照钉成 latest,并落一行 create", async () => {
    const root = tmpRoot();
    const res = await createPins(root, { sessionId: "s1", catalog: demoCatalog() });
    expect(res.ok).toBe(true);
    expect(res.codes).toContain(TOOL_PIN_CREATED);
    expect(res.pins?.versions).toEqual({ toolA: "1.0.0" });

    const got = getPins(root, "s1");
    expect(got.codes).toEqual([]);
    expect(got.pins?.status).toBe("open");
    expect(got.pins?.versions["toolA"]).toBe("1.0.0");

    const rows = lines(root);
    expect(rows).toHaveLength(1);
    const row = JSON.parse(rows[0] as string);
    expect(row).toMatchObject({ v: 1, type: "create", sessionId: "s1", status: "open" });
    expect(row.catalog.toolA.latest).toBe("1.0.0");
    expect(row.versions).toEqual({ toolA: "1.0.0" });
  });

  it("create 支持 overrides(钉到白名单内的指定版本)", async () => {
    const root = tmpRoot();
    const res = await createPins(root, { sessionId: "s1", catalog: demoCatalog(), overrides: { toolA: "2.0.0" } });
    expect(res.ok).toBe(true);
    expect(getPins(root, "s1").pins?.versions["toolA"]).toBe("2.0.0");
    expect(JSON.parse(lines(root)[0] as string).overrides).toEqual({ toolA: "2.0.0" });
  });

  it("重复 create 同一 sessionId → DUPLICATE 且不写行", async () => {
    const root = tmpRoot();
    expect((await createPins(root, { sessionId: "s1", catalog: demoCatalog() })).ok).toBe(true);
    const again = await createPins(root, { sessionId: "s1", catalog: demoCatalog() });
    expect(again.ok).toBe(false);
    expect(again.codes).toEqual([TOOL_PIN_DUPLICATE]);
    expect(lines(root)).toHaveLength(1);
  });

  it("catalog 里全是不存在的版本 → 不写行、不带 CREATED", async () => {
    const root = tmpRoot();
    const res = await createPins(root, {
      sessionId: "s1",
      catalog: { toolA: { latest: "9.9.9", versions: ["1.0.0"] } },
    });
    expect(res.ok).toBe(false);
    expect(res.codes).not.toContain(TOOL_PIN_CREATED);
    expect(lines(root)).toHaveLength(0);
  });
});

describe("tool-pins-store call / close", () => {
  it("call 记录的版本来自钉扎(1.0.0),行里带 version", async () => {
    const root = tmpRoot();
    await createPins(root, { sessionId: "s1", catalog: demoCatalog() });
    const res = await recordCall(root, { sessionId: "s1", callId: "call-1", tool: "toolA", args: { a: "x" } });
    expect(res.ok).toBe(true);
    expect(res.call?.version).toBe("1.0.0");
    const row = JSON.parse(lines(root)[1] as string);
    expect(row).toMatchObject({ type: "call", callId: "call-1", tool: "toolA", version: "1.0.0" });
    expect(row.args).toEqual({ a: "x" });
  });

  it("close 之后 call 被拒 SESSION_LOCKED,且不写行", async () => {
    const root = tmpRoot();
    await createPins(root, { sessionId: "s1", catalog: demoCatalog() });
    expect(closeSession(root, "s1").ok).toBe(true);
    expect(getPins(root, "s1").pins?.status).toBe("closed");
    const before = lines(root).length;
    const res = await recordCall(root, { sessionId: "s1", callId: "call-x", tool: "toolA" });
    expect(res.ok).toBe(false);
    expect(res.codes).toContain(TOOL_PIN_SESSION_LOCKED);
    expect(lines(root)).toHaveLength(before);
  });

  it("重复 close → TOOL_PIN_INVALID 且不写第二条 close 行", async () => {
    const root = tmpRoot();
    await createPins(root, { sessionId: "s1", catalog: demoCatalog() });
    expect(closeSession(root, "s1").ok).toBe(true);
    const before = lines(root).length;
    const again = closeSession(root, "s1");
    expect(again.ok).toBe(false);
    expect(again.codes).toEqual([TOOL_PIN_INVALID]);
    expect(lines(root)).toHaveLength(before);
  });

  it("callId 在同一会话内重复 → DUPLICATE", async () => {
    const root = tmpRoot();
    await createPins(root, { sessionId: "s1", catalog: demoCatalog() });
    expect((await recordCall(root, { sessionId: "s1", callId: "call-1", tool: "toolA" })).ok).toBe(true);
    const dup = await recordCall(root, { sessionId: "s1", callId: "call-1", tool: "toolA" });
    expect(dup.ok).toBe(false);
    expect(dup.codes).toEqual([TOOL_PIN_DUPLICATE]);
    expect(listCalls(root).calls).toHaveLength(1);
  });
});

describe("tool-pins-store upgrade", () => {
  it("未确认的 upgrade → CONFIRM_REQUIRED,不写行、版本不变", async () => {
    const root = tmpRoot();
    await createPins(root, { sessionId: "s1", catalog: demoCatalog() });
    const res = await applyUpgrade(root, { sessionId: "s1", tool: "toolA", to: "2.0.0", by: "me", confirmed: false });
    expect(res.ok).toBe(false);
    expect(res.codes).toEqual([TOOL_PIN_CONFIRM_REQUIRED]);
    expect(lines(root)).toHaveLength(1);
    expect(getPins(root, "s1").pins?.versions["toolA"]).toBe("1.0.0");
  });

  it("确认后 upgrade 落行,后续 call 用新版,upgrades 有留痕", async () => {
    const root = tmpRoot();
    await createPins(root, { sessionId: "s1", catalog: demoCatalog() });
    const res = await applyUpgrade(root, { sessionId: "s1", tool: "toolA", to: "2.0.0", by: "me", confirmed: true });
    expect(res.ok).toBe(true);
    expect(res.codes).toContain(TOOL_PIN_UPGRADED);

    const row = JSON.parse(lines(root)[1] as string);
    expect(row).toMatchObject({ type: "upgrade", tool: "toolA", from: "1.0.0", to: "2.0.0", by: "me", confirmed: true });

    const pins = getPins(root, "s1").pins;
    expect(pins?.versions["toolA"]).toBe("2.0.0");
    expect(pins?.upgrades).toHaveLength(1);
    expect(pins?.upgrades[0]).toMatchObject({ tool: "toolA", from: "1.0.0", to: "2.0.0", by: "me", confirmed: true });

    const call = await recordCall(root, { sessionId: "s1", callId: "call-2", tool: "toolA" });
    expect(call.call?.version).toBe("2.0.0");
  });

  it("升级到目录外/未钉住的工具 → UNKNOWN_TOOL", async () => {
    const root = tmpRoot();
    await createPins(root, { sessionId: "s1", catalog: demoCatalog() });
    const res = await applyUpgrade(root, { sessionId: "s1", tool: "toolZ", to: "2.0.0", by: "me", confirmed: true });
    expect(res.ok).toBe(false);
    expect(res.codes).toContain("TOOL_PIN_UNKNOWN_TOOL");
  });
});

describe("tool-pins-store replay", () => {
  it("回放旧 call 按旧版本 schema 解析(REPLAY_RESOLVED)", async () => {
    const root = tmpRoot();
    await createPins(root, { sessionId: "s1", catalog: demoCatalog() });
    await recordCall(root, { sessionId: "s1", callId: "call-1", tool: "toolA" });
    await applyUpgrade(root, { sessionId: "s1", tool: "toolA", to: "2.0.0", by: "me", confirmed: true });

    const res = await replayCall(root, { sessionId: "s1", callId: "call-1", catalog: demoCatalog() });
    expect(res.codes).toEqual([TOOL_PIN_REPLAY_RESOLVED]);
    expect(res.schema).toEqual(OLD_SCHEMA);
  });

  it("catalog 删掉旧 schema → SCHEMA_MISSING(绝不回退落盘快照)", async () => {
    const root = tmpRoot();
    await createPins(root, { sessionId: "s1", catalog: demoCatalog() });
    await recordCall(root, { sessionId: "s1", callId: "call-1", tool: "toolA" });

    const trimmed = demoCatalog();
    delete trimmed.toolA.schemas?.["1.0.0"];
    const res = await replayCall(root, { sessionId: "s1", callId: "call-1", catalog: trimmed });
    expect(res.schema).toBeUndefined();
    expect(res.codes).toEqual([TOOL_PIN_SCHEMA_MISSING]);
  });

  it("回放不存在的 callId → NOT_FOUND", async () => {
    const root = tmpRoot();
    await createPins(root, { sessionId: "s1", catalog: demoCatalog() });
    const res = await replayCall(root, { sessionId: "s1", callId: "nope", catalog: demoCatalog() });
    expect(res.codes).toEqual([TOOL_PIN_NOT_FOUND]);
  });
});

describe("tool-pins-store list / report", () => {
  it("listCalls 按 session 过滤,traceBatchKey 随行保留", async () => {
    const root = tmpRoot();
    await createPins(root, { sessionId: "s1", catalog: demoCatalog() });
    await createPins(root, { sessionId: "s2", catalog: demoCatalog() });
    await recordCall(root, { sessionId: "s1", callId: "call-1", tool: "toolA", traceBatchKey: "batch-9" });
    await recordCall(root, { sessionId: "s2", callId: "call-1", tool: "toolA" });

    expect(listCalls(root).calls).toHaveLength(2);
    const only1 = listCalls(root, { sessionId: "s1" });
    expect(only1.calls).toHaveLength(1);
    expect(only1.calls[0]).toMatchObject({ sessionId: "s1", callId: "call-1", version: "1.0.0", traceBatchKey: "batch-9" });
  });

  it("reportPins 给出 open/closed、callsByVersion、upgrades", async () => {
    const root = tmpRoot();
    await createPins(root, { sessionId: "s1", catalog: demoCatalog() });
    await recordCall(root, { sessionId: "s1", callId: "call-1", tool: "toolA" });
    await applyUpgrade(root, { sessionId: "s1", tool: "toolA", to: "2.0.0", by: "me", confirmed: true });
    await recordCall(root, { sessionId: "s1", callId: "call-2", tool: "toolA" });
    await createPins(root, { sessionId: "s2", catalog: demoCatalog() });
    closeSession(root, "s1");

    const report = reportPins(root);
    expect(report.open).toEqual(["s2"]);
    expect(report.closed).toEqual(["s1"]);
    expect(report.callsByVersion).toEqual({ "toolA@1.0.0": 1, "toolA@2.0.0": 1 });
    expect(report.upgrades).toHaveLength(1);
    expect(report.upgrades[0]).toMatchObject({ sessionId: "s1", tool: "toolA", from: "1.0.0", to: "2.0.0", by: "me" });
    expect(typeof report.upgrades[0]?.at).toBe("string");
    expect(report.sessions.map((item) => [item.sessionId, item.status])).toEqual([
      ["s1", "closed"],
      ["s2", "open"],
    ]);
    expect(report.parseErrors).toBe(0);
    expect(report.totalLines).toBe(6);
  });
});

describe("tool-pins-store 坏行容错与参数校验", () => {
  it("坏行(坏 JSON / v≠1 / type 未知 / 缺载荷)只计数,投影照旧生效", async () => {
    const root = tmpRoot();
    await createPins(root, { sessionId: "s1", catalog: demoCatalog() });
    await recordCall(root, { sessionId: "s1", callId: "call-1", tool: "toolA" });

    const path = toolPinsPath(root);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      [
        "{ 这是坏 JSON",
        JSON.stringify({ v: 2, type: "create", at: new Date().toISOString(), sessionId: "bad" }),
        JSON.stringify({ v: 1, type: "teleport", at: new Date().toISOString(), sessionId: "s1" }),
        JSON.stringify({ v: 1, type: "call", at: new Date().toISOString(), sessionId: "s1" }),
        "",
      ].join("\n"),
      "utf8",
    );

    const report = reportPins(root);
    expect(report.parseErrors).toBe(4);
    expect(report.badLines).toEqual([3, 4, 5, 6]);
    expect(report.totalLines).toBe(6);
    expect(report.open).toEqual(["s1"]);
    expect(report.callsByVersion).toEqual({ "toolA@1.0.0": 1 });

    const calls = listCalls(root, { sessionId: "s1" });
    expect(calls.calls).toHaveLength(1);
    expect(calls.parseErrors).toBe(4);
    expect(getPins(root, "s1").pins?.versions["toolA"]).toBe("1.0.0");
  });

  it("不存在的 session → 各处都报 TOOL_PIN_NOT_FOUND", async () => {
    const root = tmpRoot();
    expect(getPins(root, "ghost").codes).toEqual([TOOL_PIN_NOT_FOUND]);
    expect(closeSession(root, "ghost").codes).toEqual([TOOL_PIN_NOT_FOUND]);
    expect((await recordCall(root, { sessionId: "ghost", callId: "c1", tool: "toolA" })).codes).toEqual([
      TOOL_PIN_NOT_FOUND,
    ]);
    expect(
      (await applyUpgrade(root, { sessionId: "ghost", tool: "toolA", to: "2.0.0", by: "me", confirmed: true })).codes,
    ).toEqual([TOOL_PIN_NOT_FOUND]);
  });

  it("root/sessionId 非法抛 TypeError,其余坏参数折叠成 INVALID", async () => {
    const root = tmpRoot();
    expect(() => getPins("", "s1")).toThrow(TypeError);
    expect(() => getPins(root, "  ")).toThrow(TypeError);
    await expect(createPins(root, { sessionId: "", catalog: demoCatalog() })).rejects.toThrow(TypeError);
    await createPins(root, { sessionId: "s1", catalog: demoCatalog() });
    expect((await recordCall(root, { sessionId: "s1", callId: "", tool: "toolA" })).codes).toEqual([TOOL_PIN_INVALID]);
    expect((await applyUpgrade(root, { sessionId: "s1", tool: "toolA", to: "", by: "me" })).codes).toEqual([
      TOOL_PIN_INVALID,
    ]);
  });
});
