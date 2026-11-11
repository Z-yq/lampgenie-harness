/**
 * 工具结果双投影:展示投影(display)与模型投影(content/modelContent/images)隔离的单测。
 * 关键断言:display/displayText 永不进入模型上下文;迟到更新按 generation 单调收敛,不改写历史。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { deriveMessages } from "../src/agent/loop";
import {
  DISPLAY_TRUNCATED_MARK,
  MAX_DISPLAY_BODY_CHARS,
  MAX_DISPLAY_META_CHARS,
  MAX_DISPLAY_TITLE_CHARS,
  applyDisplayUpdate,
  displayFromToolResult,
  modelVisibleToolResult,
  normalizeToolDisplay,
  projectToolDisplays,
  type ToolDisplayProjection,
} from "../src/agent/tool-display";

const SID = "s1";

/** 造一条 tool.result 事件(形状与 loop 落账一致:payload 里带 display 时也不进模型)。 */
function resultEvent(toolCallId: string, extra: Record<string, unknown> = {}, time = 1000): Record<string, unknown> {
  return {
    kind: "tool.result",
    sessionId: SID,
    time,
    payload: { toolCallId, name: "probe_tool", content: "MODEL-TEXT", ...extra },
  };
}

/** 造一条迟到展示更新事件(custom{what:"toolDisplay.update"})。 */
function updateEvent(toolCallId: string, display: unknown, generation: number, at: number): Record<string, unknown> {
  return {
    kind: "custom",
    sessionId: SID,
    time: at,
    payload: { what: "toolDisplay.update", toolCallId, display, generation, at },
  };
}

function proj(display: unknown, generation: number, updatedAt: number): ToolDisplayProjection {
  return { display: display as ToolDisplayProjection["display"], generation, updatedAt };
}

/** deriveMessages 有 tool-pairing 自愈:tool 消息必须配对 assistant(toolCalls),否则被剔除。 */
function assistantCallEvent(toolCallId: string, time = 900): Record<string, unknown> {
  return { kind: "message.agent", sessionId: SID, time, payload: { text: "", toolCalls: [{ id: toolCallId, name: "probe_tool", arguments: {} }] } };
}

describe("normalizeToolDisplay 合法输入", () => {
  it("card 全字段:kind/title/body/meta/version 原样保留", () => {
    const d = normalizeToolDisplay({ kind: "card", title: " T ", body: "B", meta: { k: 1 }, version: 2 });
    expect(d).toEqual({ kind: "card", title: "T", body: "B", meta: { k: 1 }, version: 2 });
  });

  it("text 只给 body 也合法", () => {
    expect(normalizeToolDisplay({ kind: "text", body: "hello" })).toEqual({ kind: "text", body: "hello" });
  });

  it("五种 kind 全部接受", () => {
    for (const kind of ["text", "card", "table", "diff", "json"] as const) {
      expect(normalizeToolDisplay({ kind })?.kind).toBe(kind);
    }
  });

  it("未知字段不拷贝(schema 收敛,面板/回放不各读各的)", () => {
    const d = normalizeToolDisplay({ kind: "text", body: "B", evil: "x", display: { kind: "card" } });
    expect(d).toEqual({ kind: "text", body: "B" });
    expect(Object.keys(d!)).not.toContain("evil");
  });
});

describe("normalizeToolDisplay 非法输入(不抛,丢弃并给 reason)", () => {
  it("非普通对象 → undefined + display-not-object", () => {
    for (const raw of [null, undefined, "x", 42, ["text"], true]) {
      const reasons: string[] = [];
      expect(normalizeToolDisplay(raw, reasons)).toBeUndefined();
      expect(reasons).toEqual(["display-not-object"]);
    }
  });

  it("kind 非法 → undefined + display-kind-invalid", () => {
    const reasons: string[] = [];
    expect(normalizeToolDisplay({ kind: "html", body: "x" }, reasons)).toBeUndefined();
    expect(reasons).toEqual(["display-kind-invalid"]);
  });

  it("缺 kind → undefined + display-kind-invalid", () => {
    expect(normalizeToolDisplay({ body: "x" })).toBeUndefined();
  });

  it("title 非字符串 → 丢 title、保留 kind、给 reason", () => {
    const reasons: string[] = [];
    const d = normalizeToolDisplay({ kind: "card", title: 123, body: "B" }, reasons);
    expect(d).toEqual({ kind: "card", body: "B" });
    expect(reasons).toEqual(["display-title-invalid"]);
  });

  it("body 空串 → 丢 body、给 reason", () => {
    const reasons: string[] = [];
    const d = normalizeToolDisplay({ kind: "text", body: "" }, reasons);
    expect(d).toEqual({ kind: "text" });
    expect(reasons).toEqual(["display-body-empty"]);
  });

  it(`body 超长截断到 ${MAX_DISPLAY_BODY_CHARS} 字符 + 固定标记`, () => {
    const d = normalizeToolDisplay({ kind: "text", body: "x".repeat(MAX_DISPLAY_BODY_CHARS + 100) });
    expect(d!.body!.length).toBe(MAX_DISPLAY_BODY_CHARS + DISPLAY_TRUNCATED_MARK.length);
    expect(d!.body!.endsWith(DISPLAY_TRUNCATED_MARK)).toBe(true);
  });

  it("恰好等于上限不截断(边界不误伤)", () => {
    const d = normalizeToolDisplay({ kind: "text", body: "x".repeat(MAX_DISPLAY_BODY_CHARS) });
    expect(d!.body!.endsWith(DISPLAY_TRUNCATED_MARK)).toBe(false);
  });

  it("title 超长截断", () => {
    const d = normalizeToolDisplay({ kind: "card", title: "t".repeat(MAX_DISPLAY_TITLE_CHARS + 10) });
    expect(d!.title!.length).toBe(MAX_DISPLAY_TITLE_CHARS);
  });

  it("meta 非普通对象 → 丢 meta、给 reason", () => {
    const reasons: string[] = [];
    const d = normalizeToolDisplay({ kind: "json", meta: [1, 2] }, reasons);
    expect(d).toEqual({ kind: "json" });
    expect(reasons).toEqual(["display-meta-invalid"]);
  });

  it("meta 过大 → 丢 meta、给 reason", () => {
    const reasons: string[] = [];
    const d = normalizeToolDisplay({ kind: "json", meta: { blob: "y".repeat(MAX_DISPLAY_META_CHARS) } }, reasons);
    expect(d!.meta).toBeUndefined();
    expect(reasons).toEqual(["display-meta-too-large"]);
  });

  it("meta 循环引用 → 丢 meta、给 reason", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const reasons: string[] = [];
    const d = normalizeToolDisplay({ kind: "json", meta: circular }, reasons);
    expect(d!.meta).toBeUndefined();
    expect(reasons).toEqual(["display-meta-unserializable"]);
  });

  it("version 非负整数才收:负数/浮点丢弃、整数保留", () => {
    expect(normalizeToolDisplay({ kind: "text", version: -1 })!.version).toBeUndefined();
    expect(normalizeToolDisplay({ kind: "text", version: 1.5 })!.version).toBeUndefined();
    expect(normalizeToolDisplay({ kind: "text", version: 3 })!.version).toBe(3);
  });
});

describe("normalizeToolDisplay 不可变与确定性", () => {
  it("不修改入参对象,meta 是深拷贝快照", () => {
    const meta = { nested: { v: 1 } };
    const raw = { kind: "json", body: "B", meta };
    const d = normalizeToolDisplay(raw)!;
    (raw as { kind: string }).kind = "text";
    meta.nested.v = 99;
    expect(d.kind).toBe("json");
    expect(d.meta).toEqual({ nested: { v: 1 } });
  });

  it("同输入两次输出深等(确定性)", () => {
    const raw = { kind: "table", title: "T", body: "B", meta: { a: [1, 2] } };
    expect(normalizeToolDisplay(raw)).toEqual(normalizeToolDisplay(raw));
  });
});

describe("displayFromToolResult:display 优先,displayText 回退", () => {
  it("有合法 display 时优先取它(displayText 被忽略)", () => {
    const d = displayFromToolResult({ content: "c", display: { kind: "card", title: "T" }, displayText: "旧文本" });
    expect(d).toEqual({ kind: "card", title: "T" });
  });

  it("只有 displayText → 合成 {kind:'text', body}", () => {
    expect(displayFromToolResult({ content: "c", displayText: "旧文本" })).toEqual({ kind: "text", body: "旧文本" });
  });

  it("displayText 空白 → undefined", () => {
    expect(displayFromToolResult({ content: "c", displayText: "   " })).toBeUndefined();
  });

  it("display 非法但 displayText 非空 → 回退 displayText 并给 reason", () => {
    const reasons: string[] = [];
    const d = displayFromToolResult({ display: { kind: "nope" }, displayText: "fallback" }, reasons);
    expect(d).toEqual({ kind: "text", body: "fallback" });
    expect(reasons).toEqual(["display-kind-invalid"]);
  });

  it("两者都无 → undefined", () => {
    expect(displayFromToolResult({ content: "c" })).toBeUndefined();
  });

  it("payload 非对象 → undefined", () => {
    expect(displayFromToolResult(null)).toBeUndefined();
    expect(displayFromToolResult("x")).toBeUndefined();
  });
});

describe("applyDisplayUpdate:generation 严格单调", () => {
  it("无 current + generation=1 → 接受", () => {
    const r = applyDisplayUpdate(undefined, { what: "toolDisplay.update", toolCallId: "c1", display: { kind: "card", body: "B" }, generation: 1, at: 100 });
    expect(r.accepted).toBe(true);
    expect(r.projection).toEqual(proj({ kind: "card", body: "B" }, 1, 100));
  });

  it("generation 更大 → 接受并替换 projection", () => {
    const current = proj({ kind: "text", body: "old" }, 2, 100);
    const r = applyDisplayUpdate(current, { what: "toolDisplay.update", toolCallId: "c1", display: { kind: "text", body: "new" }, generation: 3, at: 200 });
    expect(r.accepted).toBe(true);
    expect(r.projection!.display).toEqual({ kind: "text", body: "new" });
    expect(r.projection!.generation).toBe(3);
  });

  it("generation 相等 → 拒绝(只改 body 的补丁不被接受)", () => {
    const current = proj({ kind: "text", body: "old" }, 2, 100);
    const r = applyDisplayUpdate(current, { what: "toolDisplay.update", toolCallId: "c1", display: { kind: "text", body: "patched" }, generation: 2, at: 999 });
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("display-generation-not-newer");
    expect(r.projection).toBeUndefined();
  });

  it("generation 更小 → 拒绝", () => {
    const current = proj({ kind: "text", body: "old" }, 5, 100);
    const r = applyDisplayUpdate(current, { what: "toolDisplay.update", toolCallId: "c1", display: { kind: "text", body: "stale" }, generation: 4, at: 1000 });
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("display-generation-not-newer");
  });

  it("非法更新逐条给 reason(非对象/what 错/缺 toolCallId/generation 非整数/at 非数字/display 非法)", () => {
    const base = { what: "toolDisplay.update", toolCallId: "c1", display: { kind: "text", body: "B" }, generation: 1, at: 1 };
    expect(applyDisplayUpdate(undefined, null).reason).toBe("update-not-object");
    expect(applyDisplayUpdate(undefined, { ...base, what: "other" }).reason).toBe("update-what-invalid");
    expect(applyDisplayUpdate(undefined, { ...base, toolCallId: "" }).reason).toBe("update-tool-call-id-invalid");
    expect(applyDisplayUpdate(undefined, { ...base, generation: 1.5 }).reason).toBe("update-generation-invalid");
    expect(applyDisplayUpdate(undefined, { ...base, at: NaN }).reason).toBe("update-at-invalid");
    expect(applyDisplayUpdate(undefined, { ...base, display: { kind: "bad" } }).reason).toBe("update-display-invalid");
  });
});

describe("projectToolDisplays:按 toolCallId 聚合", () => {
  it("单条 tool.result → generation=0 基线,updatedAt 取事件时间", () => {
    const scan = projectToolDisplays([resultEvent("c1", { display: { kind: "card", title: "T", body: "B" } }, 1234)]);
    expect(scan.displays.get("c1")).toEqual(proj({ kind: "card", title: "T", body: "B" }, 0, 1234));
    expect(scan.skipped).toBe(0);
  });

  it("result + generation=2 迟到更新 → 取新值、generation 上浮", () => {
    const scan = projectToolDisplays([
      resultEvent("c1", { display: { kind: "card", body: "B" } }),
      updateEvent("c1", { kind: "card", body: "B2" }, 2, 2000),
    ]);
    expect(scan.displays.get("c1")!.display).toEqual({ kind: "card", body: "B2" });
    expect(scan.displays.get("c1")!.generation).toBe(2);
    expect(scan.displays.get("c1")!.updatedAt).toBe(2000);
  });

  it("乱序更新(gen 3 → 1 → 2)按 generation 取最大", () => {
    const scan = projectToolDisplays([
      updateEvent("c1", { kind: "text", body: "v3" }, 3, 3000),
      updateEvent("c1", { kind: "text", body: "v1" }, 1, 1000),
      updateEvent("c1", { kind: "text", body: "v2" }, 2, 2000),
    ]);
    expect(scan.displays.get("c1")!.display).toEqual({ kind: "text", body: "v3" });
    expect(scan.displays.get("c1")!.generation).toBe(3);
    expect(scan.reasons).toContain("display-generation-not-newer");
  });

  it("同 generation 取更晚 at(与事件物理顺序无关)", () => {
    const a = updateEvent("c1", { kind: "text", body: "early" }, 1, 100);
    const b = updateEvent("c1", { kind: "text", body: "late" }, 1, 900);
    expect(projectToolDisplays([a, b]).displays.get("c1")!.display).toEqual({ kind: "text", body: "late" });
    expect(projectToolDisplays([b, a]).displays.get("c1")!.display).toEqual({ kind: "text", body: "late" });
  });

  it("非法 update 事件跳过并计数(坏事件不能让整段回放失败)", () => {
    const scan = projectToolDisplays([
      updateEvent("c1", { kind: "nope" }, 1, 10),
      { kind: "custom", sessionId: SID, payload: { what: "toolDisplay.update", toolCallId: "c1", display: { kind: "text", body: "B" }, generation: -1, at: 1 } },
      { kind: "custom", sessionId: SID, payload: { what: "toolDisplay.update", display: { kind: "text" }, generation: 1, at: 1 } },
    ]);
    expect(scan.skipped).toBe(3);
    expect(scan.displays.size).toBe(0);
    expect(scan.reasons).toEqual(["display-kind-invalid", "update-display-invalid", "update-generation-invalid", "update-tool-call-id-invalid"]);
  });

  it("tool.result 没有 display/displayText 是常态,不计 skipped", () => {
    const scan = projectToolDisplays([resultEvent("c1"), resultEvent("c2", { display: { kind: "text", body: "B" } })]);
    expect(scan.displays.has("c1")).toBe(false);
    expect(scan.displays.has("c2")).toBe(true);
    expect(scan.skipped).toBe(0);
  });

  it("tool.result 的 display 存在却非法 → 计 skipped 且不产出投影", () => {
    const scan = projectToolDisplays([resultEvent("c1", { display: { kind: "html" } })]);
    expect(scan.displays.size).toBe(0);
    expect(scan.skipped).toBe(1);
    expect(scan.reasons).toContain("result-display-unusable");
  });

  it("displayText 旧事件也能投影为 text", () => {
    const scan = projectToolDisplays([resultEvent("c1", { displayText: "旧展示" })]);
    expect(scan.displays.get("c1")!.display).toEqual({ kind: "text", body: "旧展示" });
  });

  it("同一 toolCallId 两条 tool.result → 取更晚 time(迟到补写不倒退)", () => {
    const scan = projectToolDisplays([
      resultEvent("c1", { display: { kind: "text", body: "newer" } }, 2000),
      resultEvent("c1", { display: { kind: "text", body: "older" } }, 1000),
    ]);
    expect(scan.displays.get("c1")!.display).toEqual({ kind: "text", body: "newer" });
  });

  it("其它 kind 与其它 custom.what 被静默忽略", () => {
    const scan = projectToolDisplays([
      { kind: "message.agent", sessionId: SID, payload: { text: "x" } },
      { kind: "custom", sessionId: SID, payload: { what: "write-barrier.fail" } },
    ]);
    expect(scan.displays.size).toBe(0);
    expect(scan.skipped).toBe(0);
  });

  it("空事件流 → 空 map、零跳过", () => {
    const scan = projectToolDisplays([]);
    expect(scan.displays.size).toBe(0);
    expect(scan.skipped).toBe(0);
    expect(scan.reasons).toEqual([]);
  });

  it("不修改输入事件数组/对象(不可变)", () => {
    const events = [resultEvent("c1", { display: { kind: "card", body: "B" } }), updateEvent("c1", { kind: "card", body: "B2" }, 2, 20)];
    const snapshot = JSON.stringify(events);
    projectToolDisplays(events);
    expect(JSON.stringify(events)).toBe(snapshot);
  });
});

describe("modelVisibleToolResult:模型投影物理隔离", () => {
  it("只回 content/modelContent/images,display 与 displayText 一律不出现", () => {
    const out = modelVisibleToolResult({
      content: "MODEL-TEXT",
      modelContent: "STUB",
      images: ["data:image/png;base64,AA"],
      display: { kind: "card", title: "TITLE-X", body: "BODY-X" },
      displayText: "DISPLAY-TEXT-X",
    });
    expect(out).toEqual({ content: "MODEL-TEXT", modelContent: "STUB", images: ["data:image/png;base64,AA"] });
    const json = JSON.stringify(out);
    expect(json).not.toContain("display");
    expect(json).not.toContain("TITLE-X");
    expect(json).not.toContain("BODY-X");
    expect(json).not.toContain("DISPLAY-TEXT-X");
  });

  it("没有 modelContent 时不凭空补键(deriveMessages 的 ?? 兜底保持不变)", () => {
    expect(modelVisibleToolResult({ content: "c" })).toEqual({ content: "c" });
  });

  it("images 过滤非字符串与空串", () => {
    expect(modelVisibleToolResult({ content: "c", images: ["a", 1, "", "b"] }).images).toEqual(["a", "b"]);
    expect(modelVisibleToolResult({ content: "c", images: [] }).images).toBeUndefined();
  });

  it("非对象 → content 空串(不抛)", () => {
    expect(modelVisibleToolResult(null)).toEqual({ content: "" });
  });
});

describe("deriveMessages 行为不变:display 不进模型上下文", () => {
  it("tool.result 带 display → 模型消息只含 content", () => {
    const journal = new MemoryJournal();
    journal.append(assistantCallEvent("c1") as never);
    journal.append({
      kind: "tool.result",
      sessionId: SID,
      payload: { toolCallId: "c1", name: "t", content: "MODEL-TEXT", display: { kind: "card", title: "TITLE-X", body: "BODY-X" } },
    });
    const msgs = deriveMessages(journal, SID);
    expect(msgs.filter((m) => m.role === "tool")).toEqual([{ role: "tool", toolCallId: "c1", content: "MODEL-TEXT" }]);
    expect(JSON.stringify(msgs)).not.toContain("display");
    expect(JSON.stringify(msgs)).not.toContain("TITLE-X");
  });

  it("displayText 旧字段也不进模型(它只是展示回退来源)", () => {
    const journal = new MemoryJournal();
    journal.append(assistantCallEvent("c1") as never);
    journal.append({
      kind: "tool.result",
      sessionId: SID,
      payload: { toolCallId: "c1", name: "t", content: "MODEL-TEXT", displayText: "DISPLAY-TEXT-X" },
    });
    const msgs = deriveMessages(journal, SID);
    expect(msgs.filter((m) => m.role === "tool")[0]!.content).toBe("MODEL-TEXT");
    expect(JSON.stringify(msgs)).not.toContain("DISPLAY-TEXT-X");
  });

  it("迟到展示更新事件(custom)不改变 deriveMessages", () => {
    const journal = new MemoryJournal();
    journal.append(assistantCallEvent("c1") as never);
    journal.append({
      kind: "tool.result",
      sessionId: SID,
      payload: { toolCallId: "c1", name: "t", content: "MODEL-TEXT", display: { kind: "card", body: "B" } },
    });
    const before = deriveMessages(journal, SID);
    journal.append({
      kind: "custom",
      sessionId: SID,
      payload: { what: "toolDisplay.update", toolCallId: "c1", display: { kind: "card", body: "LATE-BODY" }, generation: 2, at: 5000 },
    });
    const after = deriveMessages(journal, SID);
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain("LATE-BODY");
  });
});

describe("真实探针:journal 回放 + 迟到更新隔离", () => {
  it("模型投影恒为 MODEL-TEXT;展示投影随 generation 收敛;陈旧更新被忽略并给 reason", () => {
    const journal = new MemoryJournal();
 // ⓪ assistant(toolCalls) 先落账:deriveMessages 的 tool-pairing 自愈会剔除没有配对的 tool 消息
 // (这是既有协议约束,与本任务无关)。
    journal.append(assistantCallEvent("call-1") as never);
 // ① 一条带 display 的 tool.result
    journal.append({
      kind: "tool.result",
      sessionId: SID,
      payload: { toolCallId: "call-1", name: "probe_tool", content: "MODEL-TEXT", display: { kind: "card", title: "T", body: "B" } },
    });
    const toolMsgs = (ms: ReturnType<typeof deriveMessages>) => ms.filter((m) => m.role === "tool");
    const msgs1 = deriveMessages(journal, SID);
    const scan1 = projectToolDisplays(journal.readAll());
    console.log("[probe] ① deriveMessages =", JSON.stringify(msgs1));
    console.log("[probe] ① projectToolDisplays =", JSON.stringify([...scan1.displays]));

 // ② 迟到的 generation=2 更新:投影取新值,模型仍 MODEL-TEXT
    journal.append({
      kind: "custom",
      sessionId: SID,
      payload: { what: "toolDisplay.update", toolCallId: "call-1", display: { kind: "card", title: "T2", body: "B2" }, generation: 2, at: 2000 },
    });
    const scan2 = projectToolDisplays(journal.readAll());
    const msgs2 = deriveMessages(journal, SID);
    console.log("[probe] ② projectToolDisplays =", JSON.stringify([...scan2.displays]));
    console.log("[probe] ② deriveMessages =", JSON.stringify(msgs2));

 // ③ 更迟到的 generation=1:被忽略并给 reason
    journal.append({
      kind: "custom",
      sessionId: SID,
      payload: { what: "toolDisplay.update", toolCallId: "call-1", display: { kind: "text", body: "STALE" }, generation: 1, at: 3000 },
    });
    const scan3 = projectToolDisplays(journal.readAll());
    const applied = applyDisplayUpdate(scan2.displays.get("call-1"), {
      what: "toolDisplay.update", toolCallId: "call-1", display: { kind: "text", body: "STALE" }, generation: 1, at: 3000,
    });
    console.log("[probe] ③ projectToolDisplays =", JSON.stringify([...scan3.displays]), "reasons =", scan3.reasons.join(" | "));
    console.log("[probe] ③ applyDisplayUpdate(stale) =", JSON.stringify(applied));
    console.log("[probe] ③ deriveMessages =", JSON.stringify(deriveMessages(journal, SID)));

 // 断言(探针本身也是回归)
    expect(toolMsgs(msgs1)).toEqual([{ role: "tool", toolCallId: "call-1", content: "MODEL-TEXT" }]);
    expect(scan1.displays.get("call-1")!.display).toEqual({ kind: "card", title: "T", body: "B" });
    expect(scan2.displays.get("call-1")!.display).toEqual({ kind: "card", title: "T2", body: "B2" });
    expect(msgs2).toEqual(msgs1);
    expect(toolMsgs(msgs2)).toEqual([{ role: "tool", toolCallId: "call-1", content: "MODEL-TEXT" }]);
    expect(JSON.stringify(msgs2)).not.toContain("T2");
    expect(scan3.displays.get("call-1")!.display).toEqual({ kind: "card", title: "T2", body: "B2" });
    expect(scan3.reasons).toContain("display-generation-not-newer");
    expect(applied.accepted).toBe(false);
    expect(applied.reason).toBe("display-generation-not-newer");
    expect(JSON.stringify(deriveMessages(journal, SID))).not.toContain("STALE");
  });
});
