/**
 * 视觉图回收改 turn 边界(2026-11 token 优化轮 02):
 * 契约:同 turn 内一律保留 dataUrl(不再「只留最新一张」——那会在同一 turn 内每加一张图
 * 就重写历史中段,实测放大 132×/提示缓存整段失效);只有**当前 turn 之前**的图转占位。
 * 图→turn 归属按 journal 事件序推(落在哪个 turn.start 之后属哪个 turn),不改 payload schema。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { AgentLoop, deriveMessages, VISION_TOOL_SENTINEL, type LlmProvider, type Tool, type Message } from "../src/agent/loop";

function visionTool(dataUrl: string, label: string): Tool {
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

/** 记录每次请求的完整消息快照(JSON 深拷贝,便于逐字节比对)。 */
function recordingLlm(script: { toolCalls?: { id: string; name: string; arguments: string }[] }[]): LlmProvider & { requests: Message[][] } {
  const requests: Message[][] = [];
  let round = 0;
  return {
    requests,
    async chat(messages: Message[]) {
      requests.push(JSON.parse(JSON.stringify(messages)) as Message[]);
      const step = script[Math.min(round, script.length - 1)]!;
      round++;
      if (step.toolCalls) return { content: "看图中", toolCalls: step.toolCalls };
      return { content: "终稿" };
    },
  };
}

const PLACEHOLDER = "历史图片已从上下文移除";

describe("视觉回收 turn 边界", () => {
  it("同 turn 内两次 view_image:第 2/3 次请求前缀逐字节相同,不出现历史图占位", async () => {
    const journal = new MemoryJournal();
    const llm = recordingLlm([
      { toolCalls: [{ id: "c1", name: "view_image", arguments: '{"path":"a.png"}' }] },
      { toolCalls: [{ id: "c2", name: "view_image", arguments: '{"path":"b.png"}' }] },
      {},
    ]);
    const loop = new AgentLoop({
      journal, sessionId: "vb-1", system: "sys", llm,
      tools: [visionTool("data:image/png;base64,AAA", "a.png")],
    });
    await loop.runTurn("看两张图");
    expect(llm.requests).toHaveLength(3);
    const [, r2, r3] = llm.requests;
    // 前缀逐字节相同:第 3 次请求 = 第 2 次请求原文 + 新增消息(历史图未被重写)
    expect(r3!.length).toBeGreaterThan(r2!.length);
    expect(JSON.stringify(r3!.slice(0, r2!.length))).toBe(JSON.stringify(r2));
    // 同 turn 内不得出现回收占位
    expect(JSON.stringify(r2)).not.toContain(PLACEHOLDER);
    expect(JSON.stringify(r3)).not.toContain(PLACEHOLDER);
    // 两张图都在(同 turn 保留)
    const imgs = (r3 as { role: string; images?: string[] }[]).filter((m) => m.role === "user" && m.images?.length);
    expect(imgs).toHaveLength(2);
    expect(imgs.every((m) => m.images![0]!.startsWith("data:image/png;base64,"))).toBe(true);
  });

  it("新 turn 开始后:旧 turn 的图才转占位,新 turn 的图保留 dataUrl", async () => {
    const journal = new MemoryJournal();
    const llm = recordingLlm([
      { toolCalls: [{ id: "c1", name: "view_image", arguments: '{"path":"old.png"}' }] },
      {},
      { toolCalls: [{ id: "c2", name: "view_image", arguments: '{"path":"new.png"}' }] },
      {},
    ]);
    let call = 0;
    const tool: Tool = {
      name: "view_image",
      description: "查看图片",
      parameters: { type: "object", properties: {} },
      isConcurrencySafe: () => true,
      async execute() {
        call++;
        const n = call === 1
          ? { dataUrl: "data:image/png;base64,T0xE", label: "old.png" }
          : { dataUrl: "data:image/png;base64,TkVX", label: "new.png" };
        return VISION_TOOL_SENTINEL + JSON.stringify(n);
      },
    };
    const loop = new AgentLoop({ journal, sessionId: "vb-2", system: "sys", llm, tools: [tool] });
    await loop.runTurn("第一轮看图");
    // 同 turn:图在、无占位
    const t1 = deriveMessages(journal, "vb-2");
    expect(JSON.stringify(t1)).not.toContain(PLACEHOLDER);

    await loop.runTurn("第二轮看图");
    const msgs = deriveMessages(journal, "vb-2");
    const withImages = msgs.filter((m) => m.role === "user" && (m as { images?: string[] }).images?.length) as { images: string[] }[];
    // 只保留新 turn 的图;旧 turn 的图转占位
    expect(withImages).toHaveLength(1);
    expect(withImages[0]!.images).toEqual(["data:image/png;base64,TkVX"]);
    expect(msgs.some((m) => m.content.includes(PLACEHOLDER) && m.content.includes("view_image"))).toBe(true);
    // 旧图 dataUrl 不得残留
    expect(JSON.stringify(msgs)).not.toContain("T0xE");
    // 第二轮请求里已是占位(旧 turn 图在进入新 turn 时就回收)
    const last = llm.requests[llm.requests.length - 1]!;
    expect(JSON.stringify(last)).not.toContain("T0xE");
  });
});

/** 手工播种 journal(turn 边界用例:要精确控制有无 turn.start / 同 turn 图数 / step 位置)。
 *  step=undefined 时不写 step.start(模拟旧 journal 或同 step 内连续看图)。 */
function seedVision(
  journal: MemoryJournal,
  sid: string,
  spec: { turn: number | null; step?: number; imgs: string[] }[],
): void {
  let n = 0;
  for (const seg of spec) {
    if (seg.turn !== null) journal.append({ kind: "turn.start", sessionId: sid, payload: { turn: seg.turn } });
    if (seg.step !== undefined) journal.append({ kind: "step.start", sessionId: sid, payload: { turn: seg.turn ?? 0, step: seg.step } });
    journal.append({ kind: "message.user", sessionId: sid, payload: { text: "看图" } });
    // toolCall id 与 dataUrl 无关(否则 dataUrl 会经 id 文本残留,断言测不到真回收)
    const ids = seg.imgs.map(() => `call-${++n}`);
    journal.append({
      kind: "message.agent", sessionId: sid,
      payload: { text: "看图中", toolCalls: ids.map((id) => ({ id, name: "view_image", arguments: "{}" })) },
    });
    for (let i = 0; i < seg.imgs.length; i++) {
      journal.append({ kind: "tool.result", sessionId: sid, payload: { toolCallId: ids[i], content: "图片已注入视觉通道", images: [seg.imgs[i]!] } });
    }
  }
}

describe("视觉回收兜底(无 turn.start 的旧 journal)", () => {
  it("事件流里没有任何 turn.start → 退化为只保留最新一张,更早的回收占位", () => {
    const journal = new MemoryJournal();
    seedVision(journal, "fb-1", [
      { turn: null, imgs: ["data:image/png;base64,T0xFMQ", "data:image/png;base64,T0xFMk"] },
      { turn: null, imgs: ["data:image/png;base64,TkVXMQ"] },
    ]);
    const msgs = deriveMessages(journal, "fb-1");
    const withImages = msgs.filter((m) => m.role === "user" && (m as { images?: string[] }).images?.length) as { images: string[] }[];
    // 旧口径兜底:只留最新一张(currentTurn 恒 0 时若不兜底会三张全留=永不裁剪)
    expect(withImages).toHaveLength(1);
    expect(withImages[0]!.images).toEqual(["data:image/png;base64,TkVXMQ"]);
    expect(msgs.filter((m) => m.content.includes(PLACEHOLDER))).toHaveLength(2);
    // 被回收的 dataUrl 不得残留
    const text = JSON.stringify(msgs);
    expect(text).not.toContain("T0xFMQ");
    expect(text).not.toContain("T0xFMk");
  });
});

describe("视觉回收 epoch 口径(2026-10-29 token 轮 04)", () => {
  it("同 turn 同 epoch 三张图 → 全部保留(旧口径每来一张就改写历史中段,缓存前缀全碎)", () => {
    const journal = new MemoryJournal();
    // step 1/2/3 全在 epoch 0(桶宽 20)
    seedVision(journal, "cap-1", [
      { turn: 1, step: 1, imgs: ["data:image/png;base64,QQ"] },
      { turn: 1, step: 2, imgs: ["data:image/png;base64,Qg"] },
      { turn: 1, step: 3, imgs: ["data:image/png;base64,Qw"] },
    ]);
    const msgs = deriveMessages(journal, "cap-1");
    const withImages = msgs.filter((m) => m.role === "user" && (m as { images?: string[] }).images?.length) as { images: string[] }[];
    expect(withImages).toHaveLength(3);
    expect(msgs.filter((m) => m.content.includes(PLACEHOLDER))).toHaveLength(0);
  });

  it("同 epoch 内每新增一张图:已组装的历史消息逐字节不变(前缀稳定)", () => {
    const journal = new MemoryJournal();
    seedVision(journal, "cap-3", [{ turn: 1, step: 5, imgs: ["data:image/png;base64,QQ"] }]);
    const before = deriveMessages(journal, "cap-3");
    // 同一 epoch(step 8)再来一张
    seedVision(journal, "cap-3", [{ turn: 1, step: 8, imgs: ["data:image/png;base64,Qg"] }]);
    const after = deriveMessages(journal, "cap-3");
    // 前 len(before) 条必须逐字节相同(新图只追加在尾部)
    expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
    const imgs = after.filter((m) => m.role === "user" && (m as { images?: string[] }).images?.length);
    expect(imgs).toHaveLength(2);
  });

  it("跨 2 个 epoch 后旧图回收(容量有界,不是永不裁剪)", () => {
    const journal = new MemoryJournal();
    seedVision(journal, "cap-4", [
      { turn: 1, step: 1, imgs: ["data:image/png;base64,EP0"] },   // epoch 0
      { turn: 1, step: 45, imgs: ["data:image/png;base64,EP2"] },  // epoch 2 → epoch 0 淘汰
    ]);
    const msgs = deriveMessages(journal, "cap-4");
    const withImages = msgs.filter((m) => m.role === "user" && (m as { images?: string[] }).images?.length) as { images: string[] }[];
    expect(withImages).toHaveLength(1);
    expect(withImages[0]!.images[0]).toBe("data:image/png;base64,EP2");
    expect(JSON.stringify(msgs)).not.toContain("EP0");
  });

  it("跨 turn 后上一 turn 的图全部占位(上限只保当前 turn)", () => {
    const journal = new MemoryJournal();
    seedVision(journal, "cap-2", [
      { turn: 1, step: 1, imgs: ["data:image/png;base64,QQ", "data:image/png;base64,Qg", "data:image/png;base64,Qw"] },
      { turn: 2, step: 2, imgs: ["data:image/png;base64,TkVX"] },
    ]);
    const msgs = deriveMessages(journal, "cap-2");
    const withImages = msgs.filter((m) => m.role === "user" && (m as { images?: string[] }).images?.length) as { images: string[] }[];
    expect(withImages).toHaveLength(1);
    expect(withImages[0]!.images).toEqual(["data:image/png;base64,TkVX"]);
    expect(msgs.filter((m) => m.content.includes(PLACEHOLDER))).toHaveLength(3);
  });
});

describe("压缩块清 audioIdx(2026-11 相邻同类 bug)", () => {
  it("压缩边界重放 tail 后不误删重放消息的 audio(陈旧下标不得越界/删错)", () => {
    const journal = new MemoryJournal();
    const sid = "cmp-1";
    // 压缩前:两条带音频的 user 消息 → audioIdx=[0,1]
    journal.append({ kind: "message.user", sessionId: sid, payload: { text: "旧语音1", audio: { data: "OLD1" } } });
    journal.append({ kind: "message.user", sessionId: sid, payload: { text: "旧语音2", audio: { data: "OLD2" } } });
    journal.append({ kind: "message.agent", sessionId: sid, payload: { text: "收到" } });
    // 压缩:清空历史 + 空 tail(清空后 out 从 0 重新计数,陈旧下标 0/1 会指向压缩后的新消息)
    journal.append({ kind: "compact.done", sessionId: sid, payload: { summary: "摘要", tail: [] } });
    journal.append({ kind: "message.system", sessionId: sid, payload: { text: "摘要正文" } });
    // 压缩后:out[0]=普通 user,out[1]=带音频 user → audioIdx=[0,1,1];
    // 若压缩块没清 audioIdx,slice(0,-1) 会删掉 out[1].audio(正是那条新语音),静默丢音频。
    journal.append({ kind: "message.user", sessionId: sid, payload: { text: "新语音前一句" } });
    journal.append({ kind: "message.user", sessionId: sid, payload: { text: "新语音", audio: { data: "NEW" } } });

    let msgs: Message[] = [];
    expect(() => { msgs = deriveMessages(journal, sid); }).not.toThrow();
    const audios = msgs.filter((m) => (m as { audio?: { data: string } }).audio) as { content: string; audio: { data: string } }[];
    expect(audios).toHaveLength(1);
    expect(audios[0]!.audio.data).toBe("NEW"); // 目标消息 audio 保留(未被陈旧下标误删)
    expect(audios[0]!.content).toBe("新语音");
    // 旧语音不得经压缩重放回来
    expect(JSON.stringify(msgs)).not.toContain("OLD1");
    expect(JSON.stringify(msgs)).not.toContain("OLD2");
  });
});
