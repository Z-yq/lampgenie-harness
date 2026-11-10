/**
 * 400 unsupported image 自愈(2026-11-05 实锤:10144x1146 图注入 → `messages[55].image[1]:
 * You have uploaded an unsupported image`,坏 dataUrl 已进 journal,derive 每轮重放 → 会话永久卡死)。
 *
 * 契约:只认「unsupported image」类可判定错误;OpenAI 系下标可信(1:1 同序)时清该条 images,
 * 不可信(下标记不到/该条无图/非 chat 协议)时横扫全部带图消息;修完重试,最多 2 次;
 * 其它 400 原样抛;留 journal 可检索事件(custom what=vision.repair)。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import {
  AgentLoop,
  repairUnsupportedImage,
  type LlmProvider,
  type Message,
  type Tool,
} from "../src/agent/loop";

const IMG = "data:image/png;base64,QUJD";

function imgMsg(text = "[视觉注入] 图片已注入", n = 1): Message {
  return { role: "user", content: text, images: Array.from({ length: n }, () => IMG) };
}

describe("repairUnsupportedImage(纯函数)", () => {
  it("下标命中且该条带图 → 只清该条(文本换占位)", () => {
    const messages: Message[] = [
      { role: "user", content: "看这两张" },
      imgMsg("[视觉注入] a", 2),
      imgMsg("[视觉注入] b", 1),
    ];
    const err = new Error("400 messages[1].image[1]: You have uploaded an unsupported image. Please see ...");
    const rep = repairUnsupportedImage(err, messages);
    expect(rep).toEqual({ removed: 2, at: 1 });
    expect((messages[1] as { images?: string[] }).images).toBeUndefined();
    expect(messages[1]!.content).toContain("因超出模型尺寸限制已从上下文移除");
    // 其它消息不受影响(同 turn 的其它图不该被连带删掉)
    expect((messages[2] as { images?: string[] }).images).toHaveLength(1);
  });

  it("下标越界或该条无图 → 保守横扫:清空全部带图消息", () => {
    const messages: Message[] = [imgMsg("a", 1), { role: "user", content: "无图" }, imgMsg("b", 1)];
    const rep = repairUnsupportedImage(new Error("messages[99].image[0]: unsupported image"), messages);
    expect(rep?.at).toBeNull();
    expect(rep?.removed).toBe(2);
    for (const m of messages) expect((m as { images?: string[] }).images).toBeUndefined();
  });

  it("attempt>0(第二次修复)不再信下标,直接横扫 → 保证收敛(请求里 images 归零)", () => {
    const messages: Message[] = [imgMsg("a", 1), imgMsg("b", 1)];
    const rep = repairUnsupportedImage(new Error("messages[0].image[0]: unsupported image"), messages, 1);
    expect(rep?.at).toBeNull();
    expect(rep?.removed).toBe(2);
    expect(messages.filter((m) => (m as { images?: string[] }).images?.length).length).toBe(0);
  });

  it("非 unsupported image 错误 → null(其它 400 不许被当图片问题吞掉)", () => {
    const messages: Message[] = [imgMsg("a", 1)];
    expect(repairUnsupportedImage(new Error("400 invalid_request_error: bad tool_calls"), messages)).toBeNull();
    expect((messages[0] as { images?: string[] }).images).toHaveLength(1);
  });

  it("无可修内容(整条请求无图)→ null", () => {
    expect(repairUnsupportedImage(new Error("messages[0].image[0]: unsupported image"), [{ role: "user", content: "hi" }])).toBeNull();
  });
});

/** 可编排失败的假 LLM:按 script 顺序返回或抛错,记录每次请求快照。 */
function scriptedLlm(script: (Error | { content: string })[]): LlmProvider & { requests: Message[][] } {
  const requests: Message[][] = [];
  let round = 0;
  return {
    requests,
    async chat(messages: Message[]) {
      requests.push(JSON.parse(JSON.stringify(messages)) as Message[]);
      const step = script[Math.min(round, script.length - 1)]!;
      round++;
      if (step instanceof Error) throw step;
      return { content: step.content };
    },
  };
}

const IMG_TOOL: Tool = {
  name: "view_image",
  description: "查看图片",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  isConcurrencySafe: () => true,
  async execute() {
    return "[vision-image]" + JSON.stringify({ dataUrl: IMG, label: "big.png(image/png,300KB)" });
  },
};

describe("loop 400 自愈(重试与留痕)", () => {
  it("首次 400 unsupported image → 去图重试成功,journal 留 vision.repair 且重试请求已无图", async () => {
    const journal = new MemoryJournal();
    const llm = scriptedLlm([{ content: "" }, new Error("400 messages[2].image[0]: You have uploaded an unsupported image."), { content: "终稿" }]);
    // 第 1 次:发起 view_image 工具调用;第 2 次:400(此时历史里已有图);第 3 次:成功。
    let round = 0;
    const toolLlm = llm as LlmProvider & { requests: Message[][] };
    const orig = toolLlm.chat.bind(toolLlm);
    toolLlm.chat = async (m, t, s, onD) => {
      round++;
      if (round === 1) {
        toolLlm.requests.push(JSON.parse(JSON.stringify(m)) as Message[]);
        return { content: "看图", toolCalls: [{ id: "c1", name: "view_image", arguments: '{"path":"pic.png"}' }] };
      }
      return orig(m, t, s, onD);
    };
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "sys", llm: toolLlm, tools: [IMG_TOOL] });
    const out = await loop.runTurn("看这张大图");
    expect(out).toBe("终稿");
    // 成功那次请求(最后一次)里已无任何图片
    const last = toolLlm.requests[toolLlm.requests.length - 1]!;
    expect(last.filter((m) => (m as { images?: string[] }).images?.length)).toHaveLength(0);
    const repairs = journal.readAll().filter((e) => e.kind === "custom" && (e.payload as { what?: string }).what === "vision.repair");
    expect(repairs).toHaveLength(1);
    expect((repairs[0]!.payload as { attempt: number }).attempt).toBe(1);
    expect(String((repairs[0]!.payload as { error: string }).error)).toContain("unsupported image");
  });

  it("同类 400 持续出现:修到请求无图为止,再失败抛原错(收敛,不死循环)", async () => {
    const journal = new MemoryJournal();
    const boom = new Error("400 messages[1].image[0]: unsupported image");
    const llm = scriptedLlm([boom, boom, boom, boom]);
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "sys", llm, tools: [] });
    await expect(loop.runTurn("hi", ["data:image/png;base64,QUJD"])).rejects.toThrow(/unsupported image/);
    // 首次请求带图 → 修一次;重试请求已零图,再报同类错无图可修 → 直接抛原错(不会二次空转)。
    const reqs = (llm as LlmProvider & { requests: Message[][] }).requests;
    expect(reqs).toHaveLength(2);
    expect(reqs[1]!.filter((m) => (m as { images?: string[] }).images?.length)).toHaveLength(0);
    const repairs = journal.readAll().filter((e) => e.kind === "custom" && (e.payload as { what?: string }).what === "vision.repair");
    expect(repairs).toHaveLength(1);
    expect((repairs[0]!.payload as { attempt: number }).attempt).toBe(1);
  });

  it("上限硬约束:两次自愈后请求已无图,再报即抛原错(不会继续空转)", async () => {
    const journal = new MemoryJournal();
    const requests: Message[][] = [];
    let round = 0;
    const llm: LlmProvider = {
      async chat(m: Message[]) {
        requests.push(JSON.parse(JSON.stringify(m)) as Message[]);
        round++;
        if (round === 1) return { content: "看图A", toolCalls: [{ id: "c1", name: "view_image", arguments: '{"path":"pic.png"}' }] };
        if (round === 2) return { content: "看图B", toolCalls: [{ id: "c2", name: "view_image", arguments: '{"path":"pic.png"}' }] };
        // 第 3 次起持续同一句 400:①命中首张图 → 清该条 ②该条已无图 → 横扫清剩余 ③已零图 → 抛原错
        throw new Error("400 messages[4].image[0]: unsupported image");
      },
    };
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "sys", llm, tools: [IMG_TOOL] });
    await expect(loop.runTurn("看两张")).rejects.toThrow(/unsupported image/);
    // 2 次工具调用 + 首调失败 + 2 次自愈重试 = 5 次;此后请求已零图,不再空转
    expect(requests).toHaveLength(5);
    expect(requests[4]!.filter((m) => (m as { images?: string[] }).images?.length)).toHaveLength(0);
    const repairs = journal.readAll().filter((e) => e.kind === "custom" && (e.payload as { what?: string }).what === "vision.repair");
    expect(repairs).toHaveLength(2);
  });

  it("请求里本来就没有图:不做无意义重试,直接抛原错", async () => {
    const journal = new MemoryJournal();
    const llm = scriptedLlm([new Error("400 messages[0].image[0]: unsupported image")]);
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "sys", llm, tools: [] });
    await expect(loop.runTurn("hi")).rejects.toThrow(/unsupported image/);
    expect((llm as LlmProvider & { requests: Message[][] }).requests).toHaveLength(1);
  });

  it("非图片类 400:原样抛出,不重试不自愈", async () => {
    const journal = new MemoryJournal();
    const llm = scriptedLlm([new Error("400 invalid_request_error: tool_calls must be followed")]);
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "sys", llm, tools: [] });
    await expect(loop.runTurn("hi")).rejects.toThrow(/tool_calls must be followed/);
    expect((llm as LlmProvider & { requests: Message[][] }).requests).toHaveLength(1);
    expect(journal.readAll().filter((e) => e.kind === "custom")).toHaveLength(0);
  });
});
