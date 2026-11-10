/**
 * 视觉桥 e2e(2026-10-25 view_image;对齐 ZCode tool-result-media-projection):
 * 工具返回 [vision-image] 哨兵 → loop 落账剥离 dataUrl 进 payload.images + 确认句 →
 * deriveMessages 投影后置 user 消息(user+images)→ provider 请求可见;
 * 多次注入按 **turn 边界**回收:同一 turn 内全保留 dataUrl,进入新 turn 后旧 turn 的图转占位
 * (2026-11 token 优化轮 02;旧的「只留最新一张」会逐图重写历史中段,提示缓存整段失效)。
 * 坏哨兵按普通文本落账。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { AgentLoop, deriveMessages, VISION_TOOL_SENTINEL, type LlmProvider, type Tool, type Message } from "../src/agent/loop";

function visionTool(dataUrl = "data:image/png;base64,QUJD", label = "pic.png(image/png,3KB)"): Tool {
  return {
    name: "view_image",
    description: "查看图片",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    isConcurrencySafe: () => true,
    async execute() {
      return VISION_TOOL_SENTINEL + JSON.stringify({ dataUrl, label });
    },
  };
}

/** 记录每轮请求消息的假 LLM:第 N 轮发起工具调用,最后轮返回终稿。 */
function recordingLlm(script: { toolCalls?: { id: string; name: string; arguments: string }[] }[]): LlmProvider & { requests: Message[][] } {
  const requests: Message[][] = [];
  let round = 0;
  return {
    requests,
    async chat(messages: Message[]) {
      requests.push(messages.map((m) => ({ ...m })));
      const step = script[Math.min(round, script.length - 1)]!;
      round++;
      if (step.toolCalls) return { content: "看图中", toolCalls: step.toolCalls };
      return { content: "终稿" };
    },
  };
}

describe("视觉桥(view_image sentinel → 后置 user images)", () => {
  it("哨兵落账:payload.images=dataUrl,content=确认句(无 dataUrl 泄入工具文本)", async () => {
    const journal = new MemoryJournal();
    const llm = recordingLlm([{ toolCalls: [{ id: "c1", name: "view_image", arguments: '{"path":"pic.png"}' }] }, {}]);
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "sys", llm, tools: [visionTool()] });
    await loop.runTurn("看这张图");
    const results = journal.readAll().filter((e) => e.kind === "tool.result");
    expect(results).toHaveLength(1);
    const p = results[0]!.payload as { content: string; images?: string[] };
    expect(p.images).toEqual(["data:image/png;base64,QUJD"]);
    expect(p.content).toContain("图片已注入视觉通道");
    expect(p.content).toContain("pic.png");
    expect(p.content).not.toContain("base64"); // dataUrl 不进工具可见文本
  });

  it("第二轮请求:tool 消息后紧跟后置 user 消息(user+images),provider 可见", async () => {
    const journal = new MemoryJournal();
    const llm = recordingLlm([{ toolCalls: [{ id: "c1", name: "view_image", arguments: '{"path":"pic.png"}' }] }, {}]);
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "sys", llm, tools: [visionTool()] });
    await loop.runTurn("看这张图");
    const second = llm.requests[1]!;
    const toolIdx = second.findIndex((m) => m.role === "tool");
    const after = second[toolIdx + 1] as { role: string; images?: string[] };
    expect(after?.role).toBe("user");
    expect(after?.images).toEqual(["data:image/png;base64,QUJD"]);
  });

  // 2026-11 token 优化轮 02:回收口径从「只留最新一张」改为 **turn 边界**——同 turn 内一律保留
  // dataUrl(否则同一 turn 内每加一张图就重写历史中段,提示缓存整段失效),只有进入新 turn 后
  // 旧 turn 的图才转占位。跨 turn 行为见 agent-loop-vision-turn-boundary.test.ts。
  it("deriveMessages 重放:后置 user 消息在列;同 turn 内两次注入都保留 dataUrl(不转占位)", async () => {
    const journal = new MemoryJournal();
    const llm = recordingLlm([
      { toolCalls: [{ id: "c1", name: "view_image", arguments: '{"path":"pic.png"}' }] },
      { toolCalls: [{ id: "c2", name: "view_image", arguments: '{"path":"pic.png"}' }] },
      {},
    ]);
    const tool = visionTool("data:image/png;base64, TkVX", "shot2.png");
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "sys", llm, tools: [tool] });
    await loop.runTurn("看两张图");
    const msgs = deriveMessages(journal, "s1");
    const withImages = msgs.filter((m) => m.role === "user" && (m as { images?: string[] }).images?.length);
    expect(withImages).toHaveLength(2); // 同一 turn:两张都留
    expect((withImages[1] as { images: string[] }).images).toEqual(["data:image/png;base64, TkVX"]);
    // 同 turn 不产生回收占位
    expect(msgs.some((m) => m.role === "user" && m.content.includes("历史图片已从上下文移除"))).toBe(false);
  });

  it("用户贴图 + 工具注入并存:同 turn 内两条都保留 dataUrl(turn 内不回收)", async () => {
    const journal = new MemoryJournal();
    const llm = recordingLlm([{ toolCalls: [{ id: "c1", name: "view_image", arguments: '{"path":"pic.png"}' }] }, {}]);
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "sys", llm, tools: [visionTool()] });
    await loop.runTurn("看这张图", ["data:image/jpeg;base64,VVNFUg=="]);
    const msgs = deriveMessages(journal, "s1");
    const withImages = msgs.filter((m) => m.role === "user" && (m as { images?: string[] }).images?.length) as { images: string[] }[];
    expect(withImages).toHaveLength(2);
    expect(withImages[0]!.images).toEqual(["data:image/jpeg;base64,VVNFUg=="]); // 用户贴图
    expect(withImages[1]!.images).toEqual(["data:image/png;base64,QUJD"]); // 工具图
  });

  it("坏哨兵(非合法 JSON):按普通工具文本落账,不产生 images", async () => {
    const journal = new MemoryJournal();
    const bad: Tool = {
      name: "view_image",
      description: "查看图片",
      parameters: { type: "object", properties: {} },
      isConcurrencySafe: () => true,
      async execute() { return VISION_TOOL_SENTINEL + "{not-json"; },
    };
    const llm = recordingLlm([{ toolCalls: [{ id: "c1", name: "view_image", arguments: '{"path":"pic.png"}' }] }, {}]);
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "sys", llm, tools: [bad] });
    await loop.runTurn("看图");
    const p = journal.readAll().find((e) => e.kind === "tool.result")!.payload as { content: string; images?: string[] };
    expect(p.images).toBeUndefined();
    expect(p.content).toContain("not-json"); // 原样落账(诚实回退)
  });

  // 2026-10-30 多图化:工具一次返回多张(paths 数组),哨兵 payload 形状 {images[],label,errors?}。
  it("多图哨兵:images 数组直通投影,确认句带张数", async () => {
    const journal = new MemoryJournal();
    const multi: Tool = {
      name: "view_image",
      description: "查看图片",
      parameters: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } }, required: ["paths"] },
      isConcurrencySafe: () => true,
      async execute() {
        return VISION_TOOL_SENTINEL + JSON.stringify({
          images: ["data:image/png;base64,QUJD", "data:image/jpeg;base64,REVG"],
          label: "a.png(image/png,1KB)、b.jpg(image/jpeg,2KB)",
        });
      },
    };
    const llm = recordingLlm([{ toolCalls: [{ id: "c1", name: "view_image", arguments: '{"paths":["a.png","b.jpg"]}' }] }, {}]);
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "sys", llm, tools: [multi] });
    await loop.runTurn("看两张图");
    const p = journal.readAll().find((e) => e.kind === "tool.result")!.payload as { content: string; images?: string[] };
    expect(p.images).toEqual(["data:image/png;base64,QUJD", "data:image/jpeg;base64,REVG"]);
    expect(p.content).toContain("2 张");
    expect(p.content).not.toContain("base64");
    // provider 投影:后置 user 消息携带两张
    const second = llm.requests[1]!;
    const after = second[second.findIndex((m) => m.role === "tool") + 1] as { role: string; images?: string[] };
    expect(after?.role).toBe("user");
    expect(after?.images).toEqual(["data:image/png;base64,QUJD", "data:image/jpeg;base64,REVG"]);
  });

  it("多图哨兵带 errors:确认句附失败行(部分成功语义)", async () => {
    const journal = new MemoryJournal();
    const partial: Tool = {
      name: "view_image",
      description: "查看图片",
      parameters: { type: "object", properties: {} },
      isConcurrencySafe: () => true,
      async execute() {
        return VISION_TOOL_SENTINEL + JSON.stringify({
          images: ["data:image/png;base64,QUJD"],
          label: "ok.png(image/png,1KB)",
          errors: ["- nope.png: 文件不存在"],
        });
      },
    };
    const llm = recordingLlm([{ toolCalls: [{ id: "c1", name: "view_image", arguments: '{"path":"pic.png"}' }] }, {}]);
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "sys", llm, tools: [partial] });
    await loop.runTurn("看图");
    const p = journal.readAll().find((e) => e.kind === "tool.result")!.payload as { content: string; images?: string[] };
    expect(p.images).toEqual(["data:image/png;base64,QUJD"]);
    expect(p.content).toContain("失败");
    expect(p.content).toContain("nope.png");
  });

  it("旧单图形状({dataUrl})保持兼容:回放历史 journal 不丢图", async () => {
    const journal = new MemoryJournal();
    const legacy: Tool = {
      name: "view_image",
      description: "查看图片",
      parameters: { type: "object", properties: {} },
      isConcurrencySafe: () => true,
      async execute() { return VISION_TOOL_SENTINEL + JSON.stringify({ dataUrl: "data:image/png;base64,QUJD", label: "old.png" }); },
    };
    const llm = recordingLlm([{ toolCalls: [{ id: "c1", name: "view_image", arguments: '{"path":"pic.png"}' }] }, {}]);
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "sys", llm, tools: [legacy] });
    await loop.runTurn("看图");
    const p = journal.readAll().find((e) => e.kind === "tool.result")!.payload as { images?: string[] };
    expect(p.images).toEqual(["data:image/png;base64,QUJD"]);
  });

  it("images 数组含非法元素(非 data:image/ 前缀):过滤后全空则按普通文本落账", async () => {
    const journal = new MemoryJournal();
    const junk: Tool = {
      name: "view_image",
      description: "查看图片",
      parameters: { type: "object", properties: {} },
      isConcurrencySafe: () => true,
      async execute() { return VISION_TOOL_SENTINEL + JSON.stringify({ images: ["http://x/y.png"], label: "remote" }); },
    };
    const llm = recordingLlm([{ toolCalls: [{ id: "c1", name: "view_image", arguments: '{"path":"pic.png"}' }] }, {}]);
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "sys", llm, tools: [junk] });
    await loop.runTurn("看图");
    const p = journal.readAll().find((e) => e.kind === "tool.result")!.payload as { content: string; images?: string[] };
    expect(p.images).toBeUndefined();
    expect(p.content).toContain("http://x/y.png"); // 原样落账(诚实回退)
  });

  it("llm-trace 降载:images 换 KB 占位(dataUrl 不进轨迹文件)", async () => {
    const journal = new MemoryJournal();
    const llm = recordingLlm([{ toolCalls: [{ id: "c1", name: "view_image", arguments: '{"path":"pic.png"}' }] }, {}]);
    const traces: { messages?: Message[] }[] = [];
    const loop = new AgentLoop({
      journal, sessionId: "s1", system: "sys", llm, tools: [visionTool("data:image/png;base64," + "A".repeat(3072))],
      llmTrace: (t) => { traces.push(t as { messages?: Message[] }); },
    });
    await loop.runTurn("看图");
    expect(traces.length).toBeGreaterThan(0);
    for (const t of traces) {
      for (const m of t.messages ?? []) {
        if (m.role === "user") {
          for (const img of (m as { images?: string[] }).images ?? []) {
            expect(img.startsWith("(data-url")).toBe(true);
            expect(img).not.toContain("base64");
          }
        }
      }
    }
  });
});
