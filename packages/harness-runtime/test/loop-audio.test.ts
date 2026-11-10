/**
 * 语音直入 derive 契约(2026-10-21 音频链路优化):journal 全量落 audio,deriveMessages 只保留
 * **最新一条**带音频的 user 消息(历史轮音频降级为文本占位)——防多轮全量回放请求被 b64 撑爆;
 * 无音频消息/images 映射零变化。
 */
import { describe, it, expect } from "vitest";
import { deriveMessages } from "../src/agent/loop";
import type { Journal } from "@lampgenie/core";

const stubJournal = (events: { kind: string; payload: Record<string, unknown> }[]): Journal =>
  ({ readAll: () => events.map((e, i) => ({ seq: i, time: i, sessionId: "s1", ...e })) }) as unknown as Journal;

const AUDIO = (mark: string) => ({ data: Buffer.from(mark).toString("base64"), format: "pcm16" as const });

describe("deriveMessages 语音直入(audio)", () => {
  it("只回放最新一条带音频的 user 消息;历史轮音频降级为文本占位", () => {
    const j = stubJournal([
      { kind: "message.user", payload: { text: "(语音输入)", audio: AUDIO("turn1") } },
      { kind: "message.agent", payload: { text: "第一轮回复" } },
      { kind: "message.user", payload: { text: "(语音输入)", audio: AUDIO("turn2") } },
    ]);
    const out = deriveMessages(j, "s1");
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ role: "user", content: "(语音输入)" }); // 旧轮:audio 已剥离
    expect(out[1]).toEqual({ role: "assistant", content: "第一轮回复" });
    expect((out[2] as { audio?: { data: string } }).audio?.data).toBe(Buffer.from("turn2").toString("base64"));
  });

  it("仅一条带音频=原样保留;无音频=零变化(与旧口径字节一致)", () => {
    const j = stubJournal([
      { kind: "message.user", payload: { text: "(语音输入)", audio: AUDIO("only") } },
      { kind: "message.user", payload: { text: "文字输入", images: ["data:image/png;base64,x"] } },
    ]);
    const out = deriveMessages(j, "s1");
    expect((out[0] as { audio?: unknown }).audio).toBeDefined();
    expect(out[1]).toEqual({ role: "user", content: "文字输入", images: ["data:image/png;base64,x"] });

    const plain = deriveMessages(stubJournal([{ kind: "message.user", payload: { text: "hi" } }]), "s1");
    expect(plain).toEqual([{ role: "user", content: "hi" }]);
  });

  it("坏 payload(data 非字符串)不炸、不挂 audio(诚实降级)", () => {
    const j = stubJournal([{ kind: "message.user", payload: { text: "(语音输入)", audio: { data: 42 } } }]);
    const out = deriveMessages(j, "s1");
    expect(out).toEqual([{ role: "user", content: "(语音输入)" }]);
  });
});
