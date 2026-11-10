/**
 * 视觉图回收的 **epoch 口径**(2026-10-29 token 优化轮 04)。
 * 经验证病根(脚本 `.genie/tmp/agent-eff/analyze15.py`,24h 12 会话 2064 次调用):
 * `deriveMessages` 旧口径按「同 turn 只留最新 2 张」回收——同一 turn 里每看第 3 张图,就把历史
 * 中段的第 1 张改写成占位,请求前缀从该位置起逐字节不同 → **整条历史重新计费**。
 * PPT 校对会话(web-1793246472452)583 次调用里 479 次落入这一类,单次 21,368 uncached,
 * 合计 10.2M uncached = 全部未命中 token 的 **48.5%**。
 * 新口径:同 turn + 最近 2 个 epoch(桶宽 20 步)内图全部保留;只有候选超过上限才批量裁一次。
 * 本文件守护两条性质:
 *  ① prefix-stable  ——同 epoch 内新增图只追加,已组装的历史逐字节不变(缓存命中的前提);
 *  ② cross-epoch-reclaim ——跨 epoch 必须真的回收(容量有界,不是永不裁剪)。
 * 另有「跨 turn 全回收」与「同 epoch 三图全保留」两条边界。
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

  it("cross-epoch-reclaim:跨 2 个 epoch 后旧图必须回收(容量有界,不是永不裁剪)", () => {
    const journal = new MemoryJournal();
    seedVision(journal, "epoch-3", [
      { turn: 1, step: 1, imgs: ["data:image/png;base64,EP0"] }, // epoch 0
      { turn: 1, step: 45, imgs: ["data:image/png;base64,EP2"] }, // epoch 2 → epoch 0 淘汰
    ]);
    const msgs = deriveMessages(journal, "epoch-3");
    expect(withImages(msgs as never)).toHaveLength(1);
    expect(withImages(msgs as never)[0]!.images[0]).toBe("data:image/png;base64,EP2");
    expect(JSON.stringify(msgs)).not.toContain("EP0");
  });

  it("跨 turn 后上一 turn 的图全部占位(上限只保当前 turn)", () => {
    const journal = new MemoryJournal();
    seedVision(journal, "epoch-4", [
      { turn: 1, step: 1, imgs: ["data:image/png;base64,QQ", "data:image/png;base64,Qg", "data:image/png;base64,Qw"] },
      { turn: 2, step: 2, imgs: ["data:image/png;base64,TkVX"] },
    ]);
    const msgs = deriveMessages(journal, "epoch-4");
    expect(withImages(msgs as never)).toHaveLength(1);
    expect(withImages(msgs as never)[0]!.images).toEqual(["data:image/png;base64,TkVX"]);
    expect(msgs.filter((m) => m.content.includes(PLACEHOLDER))).toHaveLength(3);
  });
});