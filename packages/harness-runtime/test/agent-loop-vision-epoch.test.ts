/**
 * 视觉图片保留策略。
 * 病根:旧 epoch 口径在 `deriveMessages` 每步按 turn/epoch/张数主动把历史图改写成文字占位——
 * 请求前缀从该位置起逐字节失效,经验证单会话多次 cold/partial miss( t9s40/t9s80)。
 * 新口径:**正常路径不回收**。图片一经注入逐字保留到真压缩边界(compact.done 清空历史);
 * 只有 provider 图片尺寸/预算错误兜底(repairUnsupportedImage / image-offload)才允许改请求副本。
 * 本文件守护:
 * ① 同 epoch/跨 epoch/跨 turn 新增图只追加,历史逐字节不变;
 * ② 真压缩边界后旧图随历史清空(不靠中段改写)。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { deriveMessages } from "../src/agent/loop";

const PLACEHOLDER = "历史图片已从上下文移除";

/** 手工播种 journal:精确控制 turn / step / 每次看图张数。
 *  step=undefined 时不写 step.start(模拟旧 journal 或同 step 内连续看图)。 */
function seedVision(
  journal: MemoryJournal,
  sid: string,
  spec: { turn: number | null; step?: number; imgs: string[] }[],
): void {
  let n = 0;
  for (const seg of spec) {
    if (seg.turn !== null) journal.append({ kind: "turn.start", sessionId: sid, payload: { turn: seg.turn } });
    if (seg.step !== undefined) {
      journal.append({ kind: "step.start", sessionId: sid, payload: { turn: seg.turn ?? 0, step: seg.step } });
    }
    journal.append({ kind: "message.user", sessionId: sid, payload: { text: "看图" } });
    // toolCall id 与 dataUrl 无关(否则 dataUrl 会经 id 文本残留,断言测不到真回收)
    const ids = seg.imgs.map(() => `call-${++n}`);
    journal.append({
      kind: "message.agent", sessionId: sid,
      payload: { text: "看图中", toolCalls: ids.map((id) => ({ id, name: "view_image", arguments: "{}" })) },
    });
    for (let i = 0; i < seg.imgs.length; i++) {
      journal.append({
        kind: "tool.result", sessionId: sid,
        payload: { toolCallId: ids[i], content: "图片已注入视觉通道", images: [seg.imgs[i]!] },
      });
    }
  }
}

const withImages = (msgs: { role: string; content: string; images?: string[] }[]) =>
  msgs.filter((m) => m.role === "user" && m.images?.length) as { images: string[] }[];

describe("视觉回收 epoch 口径", () => {
  it("prefix-stable:同 epoch 内每新增一张 view_image,已组装的历史消息逐字节不变", () => {
    const journal = new MemoryJournal();
    seedVision(journal, "epoch-1", [{ turn: 1, step: 5, imgs: ["data:image/png;base64,QQ"] }]);
    const before = deriveMessages(journal, "epoch-1");

    // 同一 epoch(step 8 < 20)再来看一张
    seedVision(journal, "epoch-1", [{ turn: 1, step: 8, imgs: ["data:image/png;base64,Qg"] }]);
    const after = deriveMessages(journal, "epoch-1");

    // 前 len(before) 条必须逐字节相同(新图只追加在尾部)——这是缓存命中率的唯一前提
    expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
    expect(withImages(after as never)).toHaveLength(2);
    expect(after.some((m) => m.content.includes(PLACEHOLDER))).toBe(false);
  });

  it("同 epoch 三张图全部保留(旧口径第 3 张就会挤掉第 1 张)", () => {
    const journal = new MemoryJournal();
    seedVision(journal, "epoch-2", [
      { turn: 1, step: 1, imgs: ["data:image/png;base64,QQ"] },
      { turn: 1, step: 2, imgs: ["data:image/png;base64,Qg"] },
      { turn: 1, step: 3, imgs: ["data:image/png;base64,Qw"] },
    ]);
    const msgs = deriveMessages(journal, "epoch-2");
    expect(withImages(msgs as never)).toHaveLength(3);
    expect(msgs.filter((m) => m.content.includes(PLACEHOLDER))).toHaveLength(0);
  });

  it("2026-11-20 新口径:跨 epoch 不回收(只在 compact 时随历史清空)", () => {
    const journal = new MemoryJournal();
    seedVision(journal, "epoch-3", [
      { turn: 1, step: 1, imgs: ["data:image/png;base64,EP0"] }, // epoch 0
      { turn: 1, step: 45, imgs: ["data:image/png;base64,EP2"] }, // epoch 2
    ]);
    const msgs = deriveMessages(journal, "epoch-3");
 // 两张图都保留;没有任何中段改写(前缀稳定)
    expect(withImages(msgs as never)).toHaveLength(2);
    expect(JSON.stringify(msgs)).toContain("EP0");
    expect(msgs.filter((m) => m.content.includes(PLACEHOLDER))).toHaveLength(0);
  });

  it("2026-11-20 新口径:跨 turn 不回收(只在 compact 时随历史清空)", () => {
    const journal = new MemoryJournal();
    seedVision(journal, "epoch-4", [
      { turn: 1, step: 1, imgs: ["data:image/png;base64,QQ", "data:image/png;base64,Qg", "data:image/png;base64,Qw"] },
      { turn: 2, step: 2, imgs: ["data:image/png;base64,TkVX"] },
    ]);
    const msgs = deriveMessages(journal, "epoch-4");
 // 4 张图全部保留(不再按 turn 回收)
    expect(withImages(msgs as never)).toHaveLength(4);
    expect(msgs.filter((m) => m.content.includes(PLACEHOLDER))).toHaveLength(0);
  });

  it("真压缩边界 compact.done 后旧图随历史清空(不靠中段改写)", () => {
    const journal = new MemoryJournal();
    seedVision(journal, "epoch-5", [
      { turn: 1, step: 1, imgs: ["data:image/png;base64,OLD"] },
    ]);
 // 真压缩边界:摘要 + 空 tail(旧历史整体清空)
    journal.append({ kind: "compact.done", sessionId: "epoch-5", payload: { summary: "摘要", tail: [] } });
    journal.append({ kind: "message.user", sessionId: "epoch-5", payload: { text: "压缩后继续" } });
    const msgs = deriveMessages(journal, "epoch-5");
    expect(withImages(msgs as never)).toHaveLength(0);
    expect(JSON.stringify(msgs)).not.toContain("OLD");
  });
});