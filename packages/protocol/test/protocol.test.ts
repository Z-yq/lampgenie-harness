import { describe, it, expect } from "vitest";
import { parseClientMessage, explainClientMessageError, PROTOCOL_VERSION, ServerMessage, BoardAcceptZ, Task, PlanQualityZ } from "../src/index";

describe("protocol schema", () => {
  it("合法 task.submit 解析成功", () => {
    const m = parseClientMessage(JSON.stringify({
      v: PROTOCOL_VERSION, type: "task.submit", sessionId: "s1", instruction: "x",
    }));
    expect(m?.type).toBe("task.submit");
  });
 // ---- 板质量遥测( bq3):Task.planQuality 向后兼容 ----
  it("旧 Task(无 planQuality)parse 通过", () => {
    const t = Task.parse({
      id: "t1", sessionId: "s1", instruction: "x", state: "done",
      createdAt: 1, updatedAt: 2, result: "ok",
    });
    expect(t.planQuality).toBeUndefined();
  });
  it("带 planQuality+skeleton 的 Task parse 通过", () => {
    const t = Task.parse({
      id: "t1", sessionId: "s1", instruction: "x", state: "done",
      createdAt: 1, updatedAt: 2,
      planQuality: {
        boardType: "code", nodes: 7, contentNodes: 7,
        p0: { passed: 1, total: 1, rate: 1 }, anchorDensity: 1,
        skeleton: { generated: 2, survived: 1, adoptionRate: 0.5 },
      },
    });
    expect(t.planQuality?.skeleton?.adoptionRate).toBe(0.5);
  });
  it("planQuality.nodes 为字符串被拒", () => {
    expect(PlanQualityZ.safeParse({
      boardType: "code", nodes: "7", contentNodes: 7,
      p0: { passed: 1, total: 1, rate: 1 }, anchorDensity: 1,
    }).success).toBe(false);
  });
 // 生产不可达修复:外部来源字段必须原样保留(zod 默认 strip 会让 server 永远判定为内部路径)
  it("task.submit 外部来源字段不被 strip", () => {
    const envelope = { taskId: "t1", source: { kind: "bot", id: "b1" }, digest: "x".repeat(32) };
    const m = parseClientMessage(JSON.stringify({
      v: PROTOCOL_VERSION, type: "task.submit", sessionId: "s1", instruction: "x",
      source: { kind: "bot", id: "probe-bot", extra: "keep-me" },
      envelope, deliveryKey: "deliver-1",
      workspace: "/tmp/ws", projectOverride: "p1", permissions: { sandbox: "read-only" }, policy: { approval: "ask" },
    })) as Record<string, unknown> | null;
    expect(m?.source).toEqual({ kind: "bot", id: "probe-bot", extra: "keep-me" });
    expect(m?.envelope).toEqual(envelope);
    expect(m?.deliveryKey).toBe("deliver-1");
    expect(m?.workspace).toBe("/tmp/ws");
    expect(m?.projectOverride).toBe("p1");
    expect(m?.permissions).toEqual({ sandbox: "read-only" });
    expect(m?.policy).toEqual({ approval: "ask" });
  });
  it("task.submit source 字符串简写可用,内部提交零字段(面板口径)", () => {
    expect((parseClientMessage(JSON.stringify({
      v: PROTOCOL_VERSION, type: "task.submit", sessionId: "s1", instruction: "x", source: "schedule",
    })) as { source?: unknown } | null)?.source).toBe("schedule");
    const plain = parseClientMessage(JSON.stringify({
      v: PROTOCOL_VERSION, type: "task.submit", sessionId: "s1", instruction: "x",
    })) as Record<string, unknown> | null;
    expect(plain?.type).toBe("task.submit");
    expect(plain?.source).toBeUndefined();
    expect("envelope" in (plain ?? {})).toBe(false);
  });
  it("缺 v / 错版本 → null", () => {
    expect(parseClientMessage(JSON.stringify({ type: "ping" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ v: 2, type: "ping" }))).toBeNull();
  });
  it("未知 type → null", () => {
    expect(parseClientMessage(JSON.stringify({ v: 1, type: "evil" }))).toBeNull();
  });
  it("非 JSON → null", () => {
    expect(parseClientMessage("not json")).toBeNull();
  });
  it("node.register 需 capabilities/reachability", () => {
    expect(parseClientMessage(JSON.stringify({
      v: 1, type: "node.register", nodeId: "n1",
    }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({
      v: 1, type: "node.register", nodeId: "n1", capabilities: [], reachability: [],
    }))?.type).toBe("node.register");
  });
});

describe("explainClientMessageError(P3:非法消息指路)", () => {
  it("合法消息 → null(调用方用兜底文案)", () => {
    expect(explainClientMessageError(JSON.stringify({
      v: PROTOCOL_VERSION, type: "ping",
    }))).toBeNull();
  });
  it("字段缺失 → 文案带 type 与具体字段名", () => {
    const m = explainClientMessageError(JSON.stringify({
      v: 1, type: "task.submit", instruction: "x",
    }));
    expect(m).toContain("type=task.submit");
    expect(m).toContain("sessionId:"); // 缺的字段名必须带路径前缀出现,否则调用方仍无从定位
  });
  it("未知 type → 文案带原始 type 值", () => {
    expect(explainClientMessageError(JSON.stringify({ v: 1, type: "evil" }))).toContain("type=evil");
  });
  it("缺信封 v → 文案路径指向 v 字段", () => {
    const m = explainClientMessageError(JSON.stringify({ type: "ping" }))!;
    expect(m).toContain("v:"); // 路径前缀必须是 v:,只断言含字符 v 会被 zod 英文文案自身命中
    expect(m).toContain("type=ping");
  });
  it("非 JSON → 解析异常文案;缺 type → 标未知", () => {
    expect(explainClientMessageError("not json")).toContain("消息解析异常");
    expect(explainClientMessageError(JSON.stringify({ v: 1 }))).toContain("type=未知");
  });
  it("issues 超长 → 截断到 200 字符(用大量非法数组元素构造超长 issues,不依赖 zod 文案长度)", () => {
    const payload = { v: 1, type: "task.submit", sessionId: "s", instruction: "x", attachments: Array.from({ length: 50 }, () => ({})) };
    const m = explainClientMessageError(JSON.stringify(payload))!;
    const detail = m.slice(m.indexOf("):") + 2);
    // 50 个空附件元素每个产生 2 条 issue(缺 name/path),拼接原文远 > 200:
    // 断言 === 200 而非 <= 200——删掉截断逻辑时这个用例必须变红。
    expect(detail.length).toBe(200);
  });
  it("超长 type 值也截断(客户端可控文本不得撑大回显)", () => {
    const m = explainClientMessageError(JSON.stringify({ v: 1, type: "x".repeat(500) }))!;
    expect(m).toContain("type=" + "x".repeat(40));
    expect(m).not.toContain("x".repeat(41));
  });
});

describe("文件读写面( IDE:file.write + file.read full)", () => {
  it("file.write 合法解析成功(path+content)", () => {
    const m = parseClientMessage(JSON.stringify({ v: 1, type: "file.write", path: "src/a.ts", content: "let x = 1;\n" }));
    expect(m?.type).toBe("file.write");
    expect((m as { path?: string }).path).toBe("src/a.ts");
  });
  it("file.write 缺 content / 空 path → null", () => {
    expect(parseClientMessage(JSON.stringify({ v: 1, type: "file.write", path: "a.txt" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ v: 1, type: "file.write", path: "", content: "x" }))).toBeNull();
  });
  it("file.write content 可为空串(清空文件是合法语义)", () => {
    expect(parseClientMessage(JSON.stringify({ v: 1, type: "file.write", path: "a.txt", content: "" }))?.type).toBe("file.write");
  });
  it("file.read 增可选 full:true;缺省不带回旧窗口语义面", () => {
    expect(parseClientMessage(JSON.stringify({ v: 1, type: "file.read", path: "a.txt", full: true }))?.type).toBe("file.read");
    expect(parseClientMessage(JSON.stringify({ v: 1, type: "file.read", path: "a.txt" }))?.type).toBe("file.read");
    // full 只接受字面 true(不接受任意真值,防 UI 传 1/"yes" 意外进全文分支)
    expect(parseClientMessage(JSON.stringify({ v: 1, type: "file.read", path: "a.txt", full: "yes" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ v: 1, type: "file.read", path: "a.txt", full: 1 }))).toBeNull();
  });
});

// 板「OOXML 文本回写」P2:Office 文本级编辑(服务端处理路径)
describe("ide.office.edit(Office 文本回写:服务端读文件重写)", () => {
  it("合法 edits 解析成功(pptx 用 slideIndex/shapeIndex,docx 用 blockIndex)", () => {
    const a = parseClientMessage(JSON.stringify({
      v: 1, type: "ide.office.edit", path: "deck/a.pptx", pid: "p1",
      edits: [{ slideIndex: 1, shapeIndex: 0, text: "新标题" }],
    }));
    expect(a?.type).toBe("ide.office.edit");
    const b = parseClientMessage(JSON.stringify({
      v: 1, type: "ide.office.edit", path: "a.docx",
      edits: [{ blockIndex: 2, text: "第二段" }],
    }));
    expect(b?.type).toBe("ide.office.edit");
  });
  it("negative:缺 path / 空 edits / 下标非正整数 → null", () => {
    expect(parseClientMessage(JSON.stringify({ v: 1, type: "ide.office.edit", edits: [{ blockIndex: 0, text: "x" }] }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ v: 1, type: "ide.office.edit", path: "a.docx", edits: [] }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ v: 1, type: "ide.office.edit", path: "a.pptx", edits: [{ slideIndex: 0, shapeIndex: 0, text: "x" }] }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ v: 1, type: "ide.office.edit", path: "a.pptx", edits: [{ slideIndex: 1, shapeIndex: -1, text: "x" }] }))).toBeNull();
  });
  it("回包 ide.office.edit.result(ok/error 都在回包里,不走 error 帧)", () => {
    expect(ServerMessage.safeParse({ v: 1, type: "ide.office.edit.result", path: "a.pptx", ok: true, bytes: 999 }).success).toBe(true);
    expect(ServerMessage.safeParse({ v: 1, type: "ide.office.edit.result", path: "a.pptx", ok: false, error: "shapeIndex 越界" }).success).toBe(true);
  });
});

describe("音色消息面(2026-10-20 音色选择+试听)", () => {
  it("voice.list 解析成功", () => {
    const m = parseClientMessage(JSON.stringify({ v: 1, type: "voice.list" }));
    expect(m?.type).toBe("voice.list");
  });
  it("voice.tts 带可选 voice(试听单次覆盖)", () => {
    const m = parseClientMessage(JSON.stringify({ v: 1, type: "voice.tts", text: "试听", level: "full", voice: "Cherry" }));
    expect(m?.type).toBe("voice.tts");
    expect((m as { voice?: string }).voice).toBe("Cherry");
  });
  it("voice.tts 不带 voice 仍合法(普通播报,不受影响)", () => {
    expect(parseClientMessage(JSON.stringify({ v: 1, type: "voice.tts", text: "播报", level: "brief" }))?.type).toBe("voice.tts");
  });
  it("voice.tts voice 超长(>80)拒绝", () => {
    expect(parseClientMessage(JSON.stringify({ v: 1, type: "voice.tts", text: "x", voice: "v".repeat(81) }))).toBeNull();
  });
});

describe("per-session 主模型消息面(白板「per-session 主模型」)", () => {
  it("session.model.set 合法包解析出 sessionId/model(不带 providerId)", () => {
    const m = parseClientMessage(JSON.stringify({
      v: PROTOCOL_VERSION, type: "session.model.set", sessionId: "s1", model: "m1",
    }));
    expect(m?.type).toBe("session.model.set");
    expect((m as { sessionId?: string }).sessionId).toBe("s1");
    expect((m as { model?: string }).model).toBe("m1");
    expect((m as { providerId?: string }).providerId).toBeUndefined();
  });
  it("session.model.set 带 providerId 也可解析(选择=(model, providerId?)对)", () => {
    const m = parseClientMessage(JSON.stringify({
      v: 1, type: "session.model.set", sessionId: "s1", model: "GLM-5.3", providerId: "bigmodel-plan",
    }));
    expect(m?.type).toBe("session.model.set");
    expect((m as { model?: string }).model).toBe("GLM-5.3");
    expect((m as { providerId?: string }).providerId).toBe("bigmodel-plan");
  });
  it("session.model.set 缺 sessionId / 缺 model / 空 model → null(zod 拒收)", () => {
    expect(parseClientMessage(JSON.stringify({ v: 1, type: "session.model.set", model: "m1" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ v: 1, type: "session.model.set", sessionId: "s1" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ v: 1, type: "session.model.set", sessionId: "s1", model: "" }))).toBeNull();
  });
  it("session.model.get 合法解析;缺 sessionId / 多余 model 字段语义面不受影响", () => {
    const m = parseClientMessage(JSON.stringify({ v: 1, type: "session.model.get", sessionId: "s1" }));
    expect(m?.type).toBe("session.model.get");
    expect((m as { sessionId?: string }).sessionId).toBe("s1");
    // get 是只读消息:不带 sessionId 必须拒收(防误把全表拉走)
    expect(parseClientMessage(JSON.stringify({ v: 1, type: "session.model.get" }))).toBeNull();
  });
  it("m7:session.model.set 带 effort/expectedRevision 解析;effort=null 表示清除该字段", () => {
    const withEffort = parseClientMessage(JSON.stringify({
      v: 1, type: "session.model.set", sessionId: "s1", model: "GLM-5.3", effort: "xhigh", expectedRevision: 3,
    })) as { effort?: string | null; expectedRevision?: number } | null;
    expect(withEffort?.effort).toBe("xhigh");
    expect(withEffort?.expectedRevision).toBe(3);
    // ""=显式关闭(请求不带 reasoning_effort),与 null(清除字段回全局)是两种语义
    const off = parseClientMessage(JSON.stringify({ v: 1, type: "session.model.set", sessionId: "s1", model: "m1", effort: "" })) as { effort?: string | null } | null;
    expect(off?.effort).toBe("");
    const cleared = parseClientMessage(JSON.stringify({ v: 1, type: "session.model.set", sessionId: "s1", model: "m1", effort: null })) as { effort?: string | null } | null;
    expect(cleared?.effort).toBeNull();
    // 旧客户端不带 effort/expectedRevision → 字段缺省(zod optional),行为不变
    const legacy = parseClientMessage(JSON.stringify({ v: 1, type: "session.model.set", sessionId: "s1", model: "m1" })) as { effort?: string; expectedRevision?: number } | null;
    expect(legacy?.effort).toBeUndefined();
    expect(legacy?.expectedRevision).toBeUndefined();
    // expectedRevision 负值是坏包(revision 从 0 起单调递增)
    expect(parseClientMessage(JSON.stringify({ v: 1, type: "session.model.set", sessionId: "s1", model: "m1", expectedRevision: -1 }))).toBeNull();
  });
  it("m7:session.model.result 携带 effort/invalid-effort code(面板可解释拒绝原因)", () => {
    const r = ServerMessage.safeParse(JSON.parse(JSON.stringify({
      v: 1, type: "session.model.result", sessionId: "s1", ok: false, code: "invalid-effort", revision: 2,
      modelOverride: { model: "m1", effort: "ultra" },
    })));
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.type).toBe("session.model.result");
    if (r.data.type !== "session.model.result") return;
    expect(r.data.code).toBe("invalid-effort");
    expect(r.data.revision).toBe(2);
    expect(r.data.modelOverride?.effort).toBe("ultra");
    // 旧回包(无 ok/code/revision)仍合规:fork/旧服务端混跑时不炸面板
    expect(ServerMessage.safeParse({ v: 1, type: "session.model.result", sessionId: "s1", modelOverride: null }).success).toBe(true);
  });
});

describe("trace.query 请求面(txa6/txa7/txa8)", () => {
  it("合法 trace.query(带 filter)解析成功", () => {
    const m = parseClientMessage(JSON.stringify({
      v: PROTOCOL_VERSION, type: "trace.query", sessionId: "s1",
      filter: { kinds: ["tool.result"], tools: ["bash"], turn: 1, sinceSeq: 0, onlyErrors: true, limit: 50 },
    }));
    expect(m?.type).toBe("trace.query");
    // 无 filter 也可(各键全可选)
    expect(parseClientMessage(JSON.stringify({
      v: PROTOCOL_VERSION, type: "trace.query", sessionId: "s1",
    }))?.type).toBe("trace.query");
  });
  it("缺 sessionId 被拒收", () => {
    expect(parseClientMessage(JSON.stringify({ v: PROTOCOL_VERSION, type: "trace.query" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ v: PROTOCOL_VERSION, type: "trace.query", sessionId: "" }))).toBeNull();
  });
  it("limit = -1 / 0 / 超 2000 被拒收", () => {
    for (const limit of [-1, 0, 2001, 1.5]) {
      expect(parseClientMessage(JSON.stringify({
        v: PROTOCOL_VERSION, type: "trace.query", sessionId: "s1", filter: { limit },
      })), `limit=${limit}`).toBeNull();
    }
    // 上界 2000 本身合法
    expect(parseClientMessage(JSON.stringify({
      v: PROTOCOL_VERSION, type: "trace.query", sessionId: "s1", filter: { limit: 2000 },
    }))?.type).toBe("trace.query");
  });
  it("trace.query.result 回包合规(events 宽松 + summary 宽松)", () => {
    const r = ServerMessage.safeParse({
      v: PROTOCOL_VERSION, type: "trace.query.result", sessionId: "s1",
      events: [{ seq: 1, kind: "tool.result", payload: { content: "x" } }],
      summary: { matched: 1, returned: 1, kindCounts: { "tool.result": 1 } },
    });
    expect(r.success).toBe(true);
  });
});

describe("BoardAcceptZ.type 契约(2026-10-25 变更契约图)", () => {  it("四枚举各自 parse 通过", () => {
    for (const type of ["command", "browser", "manual", "negative"] as const) {
      const r = BoardAcceptZ.safeParse({ cmd: "do it", expect: "ok", type });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.type).toBe(type);
    }
  });
  it("无 type 的旧 accept 文档兼容(可选,不破坏旧板)", () => {
    const r = BoardAcceptZ.safeParse({ cmd: "legacy", expect: "ok" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.type).toBeUndefined();
  });
  it("非法 type 被 zod 拒绝(枚举边界)", () => {
    expect(BoardAcceptZ.safeParse({ cmd: "x", type: "oops" }).success).toBe(false);
  });
});

// trace.stats.result.stats 契约补齐(2026-11「面板上看得见用了什么模型」T3):
// server.ts 一直在 stats 里塞 byModel/costModels(成本区逐模型列出读的就是它们),
// schema 此前未声明 = 漏写契约;补声明后必须新旧双向可解析。
const baseStats = {
  turns: 1, steps: 2, llmCalls: 1, llmMs: 1200, llmMsMax: 1200,
  toolCalls: 0, toolMs: 0,
  tokens: { input: 10, output: 5, total: 15, cached: 0 },
  contextTokens: 100, contextWindow: 200_000,
};

describe("trace.stats.result 逐模型字段(byModel/costModels)", () => {
  it("含 byModel/costModels 的 stats 可解析(字段照 server.ts 实发形态)", () => {
    const r = ServerMessage.safeParse({
      v: PROTOCOL_VERSION, type: "trace.stats.result", sessionId: "s1",
      stats: {
        ...baseStats,
        byModel: [{ model: "openai-compat/gpt-5.1", calls: 1, input: 10, output: 5, total: 15, cached: 0 }],
        costModels: [{
          model: "openai-compat/gpt-5.1", billed: true, authMode: "api",
          price: { inputMiss: 1, cacheRead: 0.1, cacheWrite: 1, output: 2 },
          cost: { total: 0.02, inputMiss: { tokens: 10, amount: 0.01 }, output: { tokens: 5, amount: 0.01 } },
          tokens: { model: "openai-compat/gpt-5.1", calls: 1, input: 10, output: 5, total: 15, cached: 0 },
        }],
      },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      const st = r.data.stats as { byModel?: { model: string; cacheWrite: number }[]; costModels?: unknown[]; llmFailures: number };
      expect(st.byModel?.[0].model).toBe("openai-compat/gpt-5.1");
      expect(st.byModel?.[0].cacheWrite, "cacheWrite 缺省补 0(旧 runtime 不带该键)").toBe(0);
      expect(st.costModels).toHaveLength(1);
      expect(st.llmFailures).toBe(0); // 既有的 default(0) 语义不变
    }
  });

  it("负面:旧 payload(无 byModel/costModels/llmFailures)仍可解析,不抛", () => {
    const r = ServerMessage.safeParse({ v: PROTOCOL_VERSION, type: "trace.stats.result", sessionId: "s1", stats: baseStats });
    expect(r.success).toBe(true);
    if (r.success) {
      const st = r.data.stats as { byModel?: unknown; costModels?: unknown };
      expect(st.byModel).toBeUndefined();
      expect(st.costModels).toBeUndefined();
    }
  });

  it("负面:byModel 结构错(calls 非整数)被拒,不静默吞掉坏数据", () => {
    const r = ServerMessage.safeParse({
      v: PROTOCOL_VERSION, type: "trace.stats.result", sessionId: "s1",
      stats: { ...baseStats, byModel: [{ model: "m", calls: 1.5, input: 0, output: 0, total: 0, cached: 0 }] },
    });
    expect(r.success).toBe(false);
  });
});
