/**
 * M167 表面/通道能力包测试(2026-11-08)。
 *
 * 覆盖:
 * a. resolveSurfaceCaps:缺省=LEGACY(零变化)/ 部分字段 / maxChars clamp / 未知 media 丢弃 / source 判定;
 * b. validateSurfaceRaw:坏字段稳定 error;
 * c. outputContract:弱表面纯文本禁表格、强表面 markdown、legacy=""(不注入);
 * d. filterToolsForSurface:hasUI=false 剔除 GUI_ONLY_TOOLS 并列出;hasUI=true 原样;
 * e. degradeForSurface:未超原样;超限截断+显式标记+originalChars;legacy 不降级;
 * f. server 处理 handleClientSurfaceDeclare:落 journal + 回包 caps;坏字段 ok:false 不落账;
 * g. 接线序列复刻(与 agent-wiring 实际调用同一组纯函数):弱表面 instruction 含契约、
 *    tools 不含 ask_user/board_upsert、task.surface 字段齐、长文本降级并落 surface.degraded;
 *    legacy 任务零变化;
 * h. 源码静态断言:agent-wiring / server 的接线点在场(装配链路起不来时的替代锚)。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { MemoryJournal } from "@lampgenie/core";
import { ClientMessage, PROTOCOL_VERSION } from "@lampgenie/protocol";
import {
  LEGACY_CAPS,
  GUI_ONLY_TOOLS,
  SURFACE_MAX_CHARS_MAX,
  SURFACE_MAX_CHARS_MIN,
  resolveSurfaceCaps,
  validateSurfaceRaw,
  outputContract,
  filterToolsForSurface,
  degradeForSurface,
  handleClientSurfaceDeclare,
  readSessionSurfaceCaps,
  planTaskSurface,
  degradeFinalFor,
  type SurfaceCaps,
} from "../src/surface-capabilities.js";

interface FakeJournal {
  readSession(sessionId: string): ReturnType<MemoryJournal["readSession"]>;
  append(event: { kind: string; sessionId: string; payload: unknown }): unknown;
  events(): ReturnType<MemoryJournal["readAll"]>;
}

function mkJournal(): FakeJournal {
  const inner = new MemoryJournal();
  return {
    readSession: (sid: string) => inner.readSession(sid),
    append: (event) => inner.append(event as never),
    events: () => inner.readAll(),
  };
}

function declareWeak(journal: FakeJournal, sid: string): SurfaceCaps {
  const r = handleClientSurfaceDeclare(
    { sessionId: sid, rendersMarkdown: false, maxChars: 800, mediaKinds: ["link"], hasUI: false },
    journal,
  );
  if (!r.ok) throw new Error("declare failed: " + r.error);
  return r.caps;
}

const LAST_CUSTOM = (j: FakeJournal, type: string): Record<string, unknown> | undefined => {
  const evs = j.events().filter((e) => e.kind === "custom" && (e.payload as { type?: string }).type === type);
  return evs.length ? (evs[evs.length - 1]!.payload as Record<string, unknown>) : undefined;
};

const SRC_AGENT_WIRING = readFileSync(new URL("../src/agent-wiring.ts", import.meta.url), "utf8");
const SRC_SERVER = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");

describe("resolveSurfaceCaps", () => {
  it("缺省(无任何字段)= LEGACY 且 source=legacy", () => {
    expect(resolveSurfaceCaps(undefined)).toEqual(LEGACY_CAPS);
    expect(resolveSurfaceCaps({})).toEqual(LEGACY_CAPS);
    expect(resolveSurfaceCaps(null).source).toBe("legacy");
  });

  it("部分字段:有任一字段 → source=client,其余逐项取 LEGACY", () => {
    const caps = resolveSurfaceCaps({ maxChars: 1000 });
    expect(caps.source).toBe("client");
    expect(caps.maxChars).toBe(1000);
    expect(caps.rendersMarkdown).toBe(LEGACY_CAPS.rendersMarkdown);
    expect(caps.mediaKinds).toEqual(LEGACY_CAPS.mediaKinds);
    expect(caps.hasUI).toBe(LEGACY_CAPS.hasUI);
  });

  it("maxChars clamp 500..1_000_000;非数 → LEGACY", () => {
    expect(resolveSurfaceCaps({ maxChars: 1 }).maxChars).toBe(SURFACE_MAX_CHARS_MIN);
    expect(resolveSurfaceCaps({ maxChars: 0 }).maxChars).toBe(SURFACE_MAX_CHARS_MIN);
    expect(resolveSurfaceCaps({ maxChars: -5 }).maxChars).toBe(SURFACE_MAX_CHARS_MIN);
    expect(resolveSurfaceCaps({ maxChars: 5_000_000 }).maxChars).toBe(SURFACE_MAX_CHARS_MAX);
    expect(resolveSurfaceCaps({ maxChars: "1000" }).maxChars).toBe(LEGACY_CAPS.maxChars);
  });

  it("mediaKinds 只留白名单,未知/重复丢弃(空数组保留=明确声明不支持媒体)", () => {
    expect(resolveSurfaceCaps({ mediaKinds: ["image", "sms", "image", "LINK"] }).mediaKinds).toEqual(["image", "link"]);
    expect(resolveSurfaceCaps({ mediaKinds: [] }).mediaKinds).toEqual([]);
    expect(resolveSurfaceCaps({ mediaKinds: "image" }).mediaKinds).toEqual(LEGACY_CAPS.mediaKinds);
  });

  it("非对象入参 → LEGACY(不抛)", () => {
    expect(resolveSurfaceCaps(42).source).toBe("legacy");
    expect(resolveSurfaceCaps([]).source).toBe("legacy");
  });
});

describe("validateSurfaceRaw", () => {
  it("类型正确/全缺省 → ok", () => {
    expect(validateSurfaceRaw({})).toEqual({ ok: true });
    expect(validateSurfaceRaw({ rendersMarkdown: false, maxChars: 900, mediaKinds: ["file"], hasUI: false })).toEqual({ ok: true });
  });

  it("坏字段 → 稳定 error(逐个字段名)", () => {
    expect(validateSurfaceRaw({ rendersMarkdown: "no" })).toEqual({ ok: false, error: "invalid-surface:rendersMarkdown" });
    expect(validateSurfaceRaw({ hasUI: 1 })).toEqual({ ok: false, error: "invalid-surface:hasUI" });
    expect(validateSurfaceRaw({ maxChars: "900" })).toEqual({ ok: false, error: "invalid-surface:maxChars" });
    expect(validateSurfaceRaw({ mediaKinds: ["image", 3] })).toEqual({ ok: false, error: "invalid-surface:mediaKinds" });
    expect(validateSurfaceRaw([])).toEqual({ ok: false, error: "invalid-surface:not-an-object" });
  });
});

describe("outputContract", () => {
  it("legacy → 空串(不注入 = 零变化)", () => {
    expect(outputContract(LEGACY_CAPS)).toBe("");
  });

  it("弱表面:纯文本 + 禁表格 + maxChars + 无 GUI 工具", () => {
    const c = outputContract(resolveSurfaceCaps({ rendersMarkdown: false, maxChars: 700, mediaKinds: ["link"], hasUI: false }));
    expect(c).toContain("纯文本");
    expect(c).toContain("禁 markdown 表格");
    expect(c).toContain("700");
    expect(c).toContain("link");
    expect(c).toContain("不要调用 ask_user");
  });

  it("强表面(声明 markdown):含 markdown/表格/代码块", () => {
    const c = outputContract(resolveSurfaceCaps({ rendersMarkdown: true, maxChars: 5000, mediaKinds: ["image"], hasUI: true }));
    expect(c).toContain("markdown");
    expect(c).toContain("表格");
    expect(c).toContain("代码块");
  });

  it("无媒体白名单:明确不支持媒体", () => {
    const c = outputContract(resolveSurfaceCaps({ mediaKinds: [] }));
    expect(c).toContain("不支持任何媒体");
  });
});

describe("filterToolsForSurface", () => {
  const tools = [
    ...GUI_ONLY_TOOLS.map((name) => ({ name })),
    { name: "read_file" },
    { name: "write_file" },
    { name: "todo_write" },
  ];

  it("hasUI=true 原样返回,filtered 为空", () => {
    const r = filterToolsForSurface(tools, resolveSurfaceCaps({ hasUI: true }));
    expect(r.tools.map((t) => t.name)).toEqual(tools.map((t) => t.name));
    expect(r.filtered).toEqual([]);
  });

  it("hasUI=false 剔除 GUI_ONLY_TOOLS 并逐个列出", () => {
    const r = filterToolsForSurface(tools, resolveSurfaceCaps({ hasUI: false }));
    const names = r.tools.map((t) => t.name);
    for (const g of GUI_ONLY_TOOLS) expect(names).not.toContain(g);
    expect(names).toEqual(["read_file", "write_file", "todo_write"]);
    expect([...r.filtered].sort()).toEqual([...GUI_ONLY_TOOLS].sort());
  });
});

describe("degradeForSurface", () => {
  const weak = (maxChars: number): SurfaceCaps => resolveSurfaceCaps({ maxChars, hasUI: false });

  it("未超上限:原样,degraded=false", () => {
    const r = degradeForSurface("ok", weak(500));
    expect(r).toEqual({ text: "ok", degraded: false, originalChars: 2, degradedChars: 2 });
  });

  it("超上限:截断 + 显式标记 + originalChars 记原长", () => {
    const text = "x".repeat(900);
    const r = degradeForSurface(text, weak(500));
    expect(r.degraded).toBe(true);
    expect(r.originalChars).toBe(900);
    expect(r.text.startsWith("x".repeat(500))).toBe(true);
    expect(r.text).toContain("[已降级:超出表面上限 500 字符;完整内容见会话记录]");
    expect(r.degradedChars).toBe(r.text.length);
  });

  it("legacy 不降级(超 100k 也原样 = 零变化)", () => {
    const text = "y".repeat(LEGACY_CAPS.maxChars + 10);
    const r = degradeForSurface(text, LEGACY_CAPS);
    expect(r.degraded).toBe(false);
    expect(r.text).toBe(text);
  });
});

describe("server 侧 handleClientSurfaceDeclare", () => {
  it("声明落 journal custom session.surface 并回包 caps", () => {
    const j = mkJournal();
    const r = handleClientSurfaceDeclare({ sessionId: "s1", rendersMarkdown: false, maxChars: 900, mediaKinds: ["link", "sms"], hasUI: false }, j, 123);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.caps).toEqual({ rendersMarkdown: false, maxChars: 900, mediaKinds: ["link"], hasUI: false, source: "client" });
    const ev = LAST_CUSTOM(j, "session.surface");
    expect(ev).toBeTruthy();
    expect(ev!.sessionId).toBe("s1");
    expect(ev!.at).toBe(123);
    expect((ev!.caps as SurfaceCaps).maxChars).toBe(900);
    // 最新一条为准
    expect(readSessionSurfaceCaps(j, "s1").maxChars).toBe(900);
  });

  it("缺 sessionId → ok:false 且不落账", () => {
    const j = mkJournal();
    const r = handleClientSurfaceDeclare({ rendersMarkdown: false }, j);
    expect(r).toEqual({ ok: false, error: "invalid-surface:sessionId" });
    expect(j.events().length).toBe(0);
  });

  it("坏字段 → ok:false 稳定 error,且不落账", () => {
    const j = mkJournal();
    const r = handleClientSurfaceDeclare({ sessionId: "s1", maxChars: "big" }, j);
    expect(r).toEqual({ ok: false, error: "invalid-surface:maxChars" });
    expect(j.events().length).toBe(0);
  });

  it("同会话多次声明:readSessionSurfaceCaps 取最后一条", () => {
    const j = mkJournal();
    handleClientSurfaceDeclare({ sessionId: "s1", rendersMarkdown: true, maxChars: 4000 }, j);
    handleClientSurfaceDeclare({ sessionId: "s1", rendersMarkdown: false, maxChars: 600, hasUI: false }, j);
    const caps = readSessionSurfaceCaps(j, "s1");
    expect(caps.maxChars).toBe(600);
    expect(caps.hasUI).toBe(false);
  });

  it("protocol 层:client.surface 字段宽松可解析(坏字段交给 server 判),surface.result 可构造", () => {
    const parsed = ClientMessage.safeParse({ v: PROTOCOL_VERSION, type: "client.surface", sessionId: "s1", maxChars: "bad" });
    expect(parsed.success).toBe(true);
    const missing = ClientMessage.safeParse({ v: PROTOCOL_VERSION, type: "client.surface" });
    expect(missing.success).toBe(false); // sessionId 必填
  });
});

describe("接线序列复刻(与 agent-wiring 同一组纯函数)", () => {
  const tools = [
    { name: "ask_user" }, { name: "board_upsert" }, { name: "board_read" }, { name: "board_export_pptx" },
    { name: "browser" }, { name: "read_file" }, { name: "todo_write" },
  ];

  it("弱表面:instruction 含契约 / tools 剔除 GUI / task.surface 字段齐 / 长文本降级+surface.degraded", () => {
    const j = mkJournal();
    declareWeak(j, "s1");
    const plan = planTaskSurface(j, "s1", "t1", tools);
    let instruction = "base";
    if (plan.contract) instruction += "\n\n" + plan.contract;
    j.append({ kind: "custom", sessionId: "s1", payload: plan.journalPayload });
    const deg = degradeFinalFor(j, "s1", "t1", plan.caps, "z".repeat(1200));

    expect(instruction).toContain("纯文本");
    expect(plan.tools.map((t) => t.name)).toEqual(["read_file", "todo_write"]);
    expect(plan.caps.hasUI).toBe(false);
    expect(plan.caps.source).toBe("client");

    const ts = LAST_CUSTOM(j, "task.surface")!;
    expect(ts.taskId).toBe("t1");
    expect(ts.sessionId).toBe("s1");
    expect(ts.source).toBe("client");
    expect(ts.contractApplied).toBe(true);
    expect(ts.filteredTools).toEqual(expect.arrayContaining(["ask_user", "board_upsert"]));
    expect((ts.caps as SurfaceCaps).maxChars).toBe(800);

    expect(deg.degraded).toBe(true);
    expect(deg.text).toContain("[已降级:超出表面上限 800 字符;完整内容见会话记录]");
    const sd = LAST_CUSTOM(j, "surface.degraded")!;
    expect(sd.taskId).toBe("t1");
    expect(sd.originalChars).toBe(1200);
    expect(sd.maxChars).toBe(800);
    expect(typeof sd.degradedChars).toBe("number");
  });

  it("legacy 任务零变化:契约空 / 工具原样 / 不降级 / 无 surface.degraded", () => {
    const j = mkJournal();
    const before = tools.map((t) => t.name);
    const plan = planTaskSurface(j, "legacy-sid", "t2", tools);
    let instruction = "base";
    if (plan.contract) instruction += "\n\n" + plan.contract;
    j.append({ kind: "custom", sessionId: "legacy-sid", payload: plan.journalPayload });
    const deg = degradeFinalFor(j, "legacy-sid", "t2", plan.caps, "q".repeat(LEGACY_CAPS.maxChars + 100));

    expect(plan.contract).toBe("");
    expect(instruction).toBe("base");
    expect(plan.tools.map((t) => t.name)).toEqual(before);
    expect(plan.filtered).toEqual([]);
    expect(plan.journalPayload.contractApplied).toBe(false);
    expect(plan.caps.source).toBe("legacy");
    expect(deg.degraded).toBe(false);
    expect(LAST_CUSTOM(j, "surface.degraded")).toBeUndefined();
  });
});

describe("源码接线点(装配链路起不来的静态锚)", () => {
  it("agent-wiring 开工/收尾两处接线在场", () => {
    expect(SRC_AGENT_WIRING).toContain("planTaskSurface(journal, task.sessionId, task.id, mainTools)");
    expect(SRC_AGENT_WIRING).toContain("tools: surfacePlan.tools");
    expect(SRC_AGENT_WIRING).toContain("if (surfacePlan.contract) instruction += ");
    expect(SRC_AGENT_WIRING).toContain("payload: surfacePlan.journalPayload");
    expect(SRC_AGENT_WIRING).toContain("degradeFinalFor(journal, task.sessionId, task.id, surfacePlan.caps, finalOut)");
  });

  it("server 有 client.surface 分支并回 surface.result", () => {
    expect(SRC_SERVER).toContain('case "client.surface":');
    expect(SRC_SERVER).toContain("handleClientSurfaceDeclare(");
    expect(SRC_SERVER).toContain('type: "surface.result"');
  });
});
