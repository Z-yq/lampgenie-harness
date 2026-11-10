/**
 * M58 图片 offload 持久位置:loop 接线契约(假 provider,不连网)。
 *
 * 契约:chat 抛「图片预算/尺寸」类错误且本请求带图 → offload 一次 + 用新 messages 立即重试一次
 * (不占 provider 重试预算);无可 offload / 写盘失败 / 投影校验不符 → 抛原错误(不重试);
 * 非图片错误逐字不变(1 次调用,零 journal 自定义事件);已 offload 占位不再处理。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import { AgentLoop, type LlmProvider, type Message } from "../src/agent/loop";
import { IMAGE_OFFLOAD_PLACEHOLDER } from "../src/agent/image-offload";

/** 4 字节 PNG 载荷:sha1("ABC") 前 12 位 = a9993e364706。 */
const IMG = "data:image/png;base64,QUJD";
const IMG_SHA12 = createHash("sha1").update(Buffer.from("QUJD", "base64")).digest("hex").slice(0, 12);
const IMG_BUDGET_ERR = () => new Error("400 IMAGE_OFFLOAD_REQUIRED: request contains image data that must be offloaded");

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

const imagesOf = (msgs: Message[]): string[] =>
  msgs.flatMap((m) => (m as { images?: string[] }).images ?? []);

const offloadEvents = (journal: MemoryJournal): { count: number; files: string[]; reason: string }[] =>
  journal.readAll()
    .filter((e) => e.kind === "custom" && (e.payload as { what?: string }).what === "image.offloaded")
    .map((e) => e.payload as { count: number; files: string[]; reason: string });

describe("loop 图片 offload(重试与留痕)", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "loop-img-offload-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("首调图片预算错误、次调成功 → provider 2 次,文件落盘,journal 1 条,messages 条数/角色不变、images 清空", async () => {
    const journal = new MemoryJournal();
    const llm = scriptedLlm([IMG_BUDGET_ERR(), { content: "看到了" }]);
    const loop = new AgentLoop({
      journal, sessionId: "s1", system: "sys", llm,
      imageOffload: { root },
    });
    const out = await loop.runTurn("看这张", [IMG]);
    expect(out).toBe("看到了");
    expect(llm.requests).toHaveLength(2);

    const [first, second] = llm.requests as [Message[], Message[]];
    expect(imagesOf(first!)).toEqual([IMG]);
    expect(imagesOf(second!)).toEqual([]);
    // 投影不变:条数与角色序列逐位相同
    expect(second!.length).toBe(first!.length);
    expect(second!.map((m) => m.role)).toEqual(first!.map((m) => m.role));
    // 末条 user 正文带占位行
    const tail = second![second!.length - 1]!;
    expect(tail.content).toContain(IMAGE_OFFLOAD_PLACEHOLDER);
    expect(tail.content).toContain(`sha1 ${IMG_SHA12}`);
    expect(tail.content).toContain("(sha1 ");

    const ev = offloadEvents(journal);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.count).toBe(1);
    expect(ev[0]!.reason).toBe("provider-image-budget");
    expect(ev[0]!.files).toHaveLength(1);
    expect((await stat(ev[0]!.files[0]!)).size).toBe(3); // "ABC"
    expect(await readdir(join(root, ".genie", "image-offload", "s1"))).toHaveLength(1);
  });

  it("重试仍失败 → 只重试 1 次(共 2 次调用),错误带「图片已 offload,仍失败」", async () => {
    const journal = new MemoryJournal();
    const llm = scriptedLlm([IMG_BUDGET_ERR(), IMG_BUDGET_ERR()]);
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "sys", llm, imageOffload: { root } });
    await expect(loop.runTurn("看这张", [IMG])).rejects.toThrow(/图片已 offload/);
    expect(llm.requests).toHaveLength(2);
    expect(imagesOf(llm.requests[1]!)).toEqual([]);
    expect(offloadEvents(journal)).toHaveLength(1);
  });

  it("已 offload 占位(hash 命中)→ offloaded=0,不重试(1 次调用)", async () => {
    const journal = new MemoryJournal();
    // 历史里已有该图的占位 + 原始 data URL(journal 不改,占位与图并存 → 幂等判定跳过)
    journal.append({
      kind: "message.user", sessionId: "s1",
      payload: { text: `看图\n${IMAGE_OFFLOAD_PLACEHOLDER} /tmp/x.png (sha1 ${IMG_SHA12}, 3B)]`, images: [IMG] },
    });
    const llm = scriptedLlm([IMG_BUDGET_ERR()]);
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "sys", llm, imageOffload: { root } });
    await expect(loop.runTurn("继续")).rejects.toThrow(/IMAGE_OFFLOAD_REQUIRED/);
    expect(llm.requests).toHaveLength(1);
    expect(offloadEvents(journal)).toHaveLength(0);
  });

  it("非图片错误 → 不 offload 不重试(1 次),无自定义留痕", async () => {
    const journal = new MemoryJournal();
    const llm = scriptedLlm([new Error("400 invalid_request_error: tool_calls must be followed")]);
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "sys", llm, imageOffload: { root } });
    await expect(loop.runTurn("hi", [IMG])).rejects.toThrow(/tool_calls must be followed/);
    expect(llm.requests).toHaveLength(1);
    expect(offloadEvents(journal)).toHaveLength(0);
  });

  it("请求里本来无图 → 图片错误也不 offload(1 次),不产生空重试", async () => {
    const journal = new MemoryJournal();
    const llm = scriptedLlm([IMG_BUDGET_ERR()]);
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "sys", llm, imageOffload: { root } });
    await expect(loop.runTurn("hi")).rejects.toThrow(/IMAGE_OFFLOAD_REQUIRED/);
    expect(llm.requests).toHaveLength(1);
    expect(offloadEvents(journal)).toHaveLength(0);
  });

  it("写盘失败(root 下 .genie 是普通文件)→ 原错误抛出,无 image.offloaded", async () => {
    await writeFile(join(root, ".genie"), "not a dir");
    const journal = new MemoryJournal();
    const llm = scriptedLlm([IMG_BUDGET_ERR(), { content: "不该到这里" }]);
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "sys", llm, imageOffload: { root } });
    await expect(loop.runTurn("看图", [IMG])).rejects.toThrow(/IMAGE_OFFLOAD_REQUIRED/);
    expect(llm.requests).toHaveLength(1); // 写盘失败不重试
    expect(offloadEvents(journal)).toHaveLength(0);
  });

  it("未配置 imageOffload → 行为逐字不变(图片错误 1 次调用)", async () => {
    const journal = new MemoryJournal();
    const llm = scriptedLlm([IMG_BUDGET_ERR()]);
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "sys", llm });
    await expect(loop.runTurn("看图", [IMG])).rejects.toThrow(/IMAGE_OFFLOAD_REQUIRED/);
    expect(llm.requests).toHaveLength(1);
    expect(offloadEvents(journal)).toHaveLength(0);
  });

  it("投影校验失败(构造异常 offload 实现:少一条消息)→ 不重试,原错误抛出", async () => {
    const journal = new MemoryJournal();
    const llm = scriptedLlm([IMG_BUDGET_ERR(), { content: "不该到这里" }]);
    const loop = new AgentLoop({
      journal, sessionId: "s1", system: "sys", llm,
      imageOffload: {
        root,
        impl: async (messages) => ({
          messages: messages.slice(1), // 故意少一条:条数变化 → 校验必须拒
          offloaded: [{ path: "/tmp/whatever.png", sha1: "0".repeat(40), bytes: 3, messageIndex: 0, imageIndex: 0 }],
          skipped: [],
        }),
      },
    });
    await expect(loop.runTurn("看图", [IMG])).rejects.toThrow(/IMAGE_OFFLOAD_REQUIRED/);
    expect(llm.requests).toHaveLength(1);
    expect(offloadEvents(journal)).toHaveLength(0);
  });

  it("同 hash 重复(两轮)→ 文件只写一次(复用)", async () => {
    const journal = new MemoryJournal();
    const llm = scriptedLlm([IMG_BUDGET_ERR(), { content: "一" }, IMG_BUDGET_ERR(), { content: "二" }]);
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "sys", llm, imageOffload: { root } });
    expect(await loop.runTurn("第一次", [IMG])).toBe("一");
    const file = offloadEvents(journal)[0]!.files[0]!;
    const mtime1 = (await stat(file)).mtimeMs;
    expect(await loop.runTurn("第二次", [IMG])).toBe("二");
    expect((await stat(file)).mtimeMs).toBe(mtime1); // 复用,未重写
    expect(await readdir(join(root, ".genie", "image-offload", "s1"))).toHaveLength(1);
    expect(offloadEvents(journal)).toHaveLength(2); // 每轮各 1 条留痕
  });

  it("非法 data URL → skipped 且保留原图:请求里仍有原样图片,但无 offload 成功项 → 不重试", async () => {
    const journal = new MemoryJournal();
    const bad = "data:image/gif;base64,QUJD";
    const llm = scriptedLlm([IMG_BUDGET_ERR(), { content: "不该到这里" }]);
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "sys", llm, imageOffload: { root } });
    await expect(loop.runTurn("看图", [bad])).rejects.toThrow(/IMAGE_OFFLOAD_REQUIRED/);
    expect(llm.requests).toHaveLength(1);
    expect(offloadEvents(journal)).toHaveLength(0);
  });
});
