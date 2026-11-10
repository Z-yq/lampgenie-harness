/**
 * 子代理终态「可投递正文」纯函数回归(2026-10-30,task_output 免独立往返)。
 *
 * 背景:旧实现终态只发「300 字摘要 + 指针(task_output agentId=…)」,主模型必然再发一轮
 * task_output 取正文——每次子代理完成额外吃一次完整 LLM 往返。本测试锁四点:
 *  ① extractDeliverableText 的提取口径(剥 [progress]、取最后一个 [result] 之后、超限截断、空输入);
 *  ② buildFinalNoticeText 注入的正文段 > 300 字(证明不是「只有指针」的旧行为);
 *  ③ 负面:300 字以内的短结果不该再补指针(正文已完整,补指针=白诱一次往返);
 *  ④ GENIE_SUBAGENT_INJECT_MAX=0 退化旧行为(摘要 + 指针)——旋钮是真旋钮,不是装饰。
 * 纯函数级:不启 gateway、不连 LLM,毫秒级。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SUBAGENT_INJECT_MAX,
  TRUNCATED_MARK,
  buildFinalNoticeText,
  extractDeliverableText,
  subagentInjectBatchMax,
  subagentInjectMaxChars,
  subagentInjectMergeMs,
} from "../src/subagent-result-digest.js";

const ENV_KEYS = ["GENIE_SUBAGENT_INJECT_MAX", "GENIE_SUBAGENT_INJECT_BATCH_MAX", "GENIE_SUBAGENT_INJECT_MERGE_MS"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

describe("extractDeliverableText", () => {
  it("剥掉 [progress] 行,只留 [result ok=true] 之后的正文", () => {
    const out = [
      "[progress] 读文件 a.ts",
      "[progress] 跑测试",
      "[result ok=true] 已修复 ABC 三处:…最终结论正文",
    ].join("\n");
    const got = extractDeliverableText(out, 4000);
    expect(got.text).toBe("已修复 ABC 三处:…最终结论正文");
    expect(got.truncated).toBe(false);
    expect(got.text).not.toContain("[progress]");
  });

  it("多个 [result] 段时取最后一个(终态才是真相)", () => {
    const out = "[progress] x\n[result ok=false] 第一次失败\n[progress] 重试\n[result ok=true] 第二次成功,正文在此";
    expect(extractDeliverableText(out, 4000).text).toBe("第二次成功,正文在此");
  });

  it("超过 4000 字截断并带 TRUNCATED_MARK(有 [result] 时截头,结论在前)", () => {
    const body = "结".repeat(6000);
    const got = extractDeliverableText(`[progress] 开始\n[result ok=true] ${body}`, DEFAULT_SUBAGENT_INJECT_MAX);
    expect(got.truncated).toBe(true);
    expect(got.text.endsWith(TRUNCATED_MARK)).toBe(true);
    expect(got.text.length).toBe(DEFAULT_SUBAGENT_INJECT_MAX + TRUNCATED_MARK.length);
  });

  it("空输入 / 只有 progress 行 → 空正文(调用方据此补指针)", () => {
    expect(extractDeliverableText("", 4000)).toEqual({ text: "", truncated: false });
    expect(extractDeliverableText("[progress] 只是心跳\n[progress] 又是心跳", 4000).text).toBe("");
  });

  it("maxChars<=0 = 关闭注入(返回空正文,由调用方退化为摘要+指针)", () => {
    expect(extractDeliverableText("[result ok=true] 有正文", 0)).toEqual({ text: "", truncated: false });
  });
});

describe("buildFinalNoticeText 正文注入", () => {
  it("终态正文段长度 > 300(不是旧行为「只有摘要+指针」)", () => {
    const body = "这是一段足够长的终态正文。".repeat(200); // ≈ 2600 字
    const text = buildFinalNoticeText([
      { agentId: "agent_x", label: "完成", summary: "子代理完成了任务", outputText: `[progress] 干活\n[result ok=true] ${body}` },
    ]);
    expect(text).toContain("[后台子代理 agent_x 完成]");
    expect(text).toContain(body.slice(0, 400));
    // 标题行(≤300 字摘要)之外的正文长度必须远超 300——注入的是正文而不是指针
    const bodyPart = text.split("\n\n").slice(1).join("\n\n");
    expect(bodyPart.length).toBeGreaterThan(300);
    expect(text).not.toContain("(全文:task_output");
  });

  it("短结果(≤300 字且未截断)不补指针(负面:不该白诱一次 task_output 往返)", () => {
    const short = "改完 3 个文件,测试全绿。";
    const text = buildFinalNoticeText([{ agentId: "agent_s", label: "完成", summary: short, outputText: `[result ok=true] ${short}` }]);
    expect(text).toContain(short);
    expect(text).not.toContain("(全文:task_output");
  });

  it("正文被截断 → 补指针(模型据此按需读全文)", () => {
    const body = "长".repeat(5000);
    const text = buildFinalNoticeText([{ agentId: "agent_l", label: "完成", summary: "很长", outputText: `[result ok=true] ${body}`, maxChars: 1000 }]);
    expect(text).toContain(TRUNCATED_MARK);
    expect(text).toContain('(全文:task_output agentId="agent_l")');
  });

  it("pointerOnly(死讯/deadline 收割)→ 只有摘要 + 指针", () => {
    const text = buildFinalNoticeText([{ agentId: "agent_d", label: "死讯", summary: "已判死", pointerOnly: true, outputText: "[result ok=false] 不该被注入的正文" }]);
    expect(text).toContain("[后台子代理 agent_d 死讯] 已判死");
    expect(text).not.toContain("不该被注入的正文");
    expect(text).toContain('(全文:task_output agentId="agent_d")');
  });
});

describe("GENIE_SUBAGENT_INJECT_MAX=0 退化旧行为", () => {
  it("注入关闭 → 摘要 + 指针(与 2026-10-30 之前完全一致)", () => {
    process.env.GENIE_SUBAGENT_INJECT_MAX = "0";
    expect(subagentInjectMaxChars()).toBe(0);
    const body = "正文".repeat(1000);
    const text = buildFinalNoticeText([{ agentId: "agent_off", label: "完成", summary: "干完了", outputText: `[result ok=true] ${body}` }]);
    expect(text).not.toContain(body.slice(0, 50));
    expect(text).toContain("[后台子代理 agent_off 完成] 干完了");
    expect(text).toContain('(全文:task_output agentId="agent_off")');
  });
});

describe("env 旋钮读取(非法值一律退缺省)", () => {
  it("缺省值 = 4000 / 8000 / 500", () => {
    delete process.env.GENIE_SUBAGENT_INJECT_MAX;
    delete process.env.GENIE_SUBAGENT_INJECT_BATCH_MAX;
    delete process.env.GENIE_SUBAGENT_INJECT_MERGE_MS;
    expect(subagentInjectMaxChars()).toBe(DEFAULT_SUBAGENT_INJECT_MAX);
    expect(subagentInjectBatchMax()).toBe(8000);
    expect(subagentInjectMergeMs()).toBe(500);
  });

  it("GENIE_SUBAGENT_INJECT_MAX=0 → 0(关闭);非数字 → 0(安全侧=不注入)", () => {
    process.env.GENIE_SUBAGENT_INJECT_MAX = "0";
    expect(subagentInjectMaxChars()).toBe(0);
    process.env.GENIE_SUBAGENT_INJECT_MAX = "abc";
    expect(subagentInjectMaxChars()).toBe(0);
  });

  it("GENIE_SUBAGENT_INJECT_MERGE_MS=0 → 0(关闭合并窗口)", () => {
    process.env.GENIE_SUBAGENT_INJECT_MERGE_MS = "0";
    expect(subagentInjectMergeMs()).toBe(0);
  });
});
