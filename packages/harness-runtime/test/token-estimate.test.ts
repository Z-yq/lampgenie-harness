import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approxTokensOfChars,
  calibrate,
  calibrationOf,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTokens,
  estimatorKind,
  flushCalibration,
  rawTokens,
  resetForTest,
  setCalibrationFile,
} from "../src/agent/token-estimate";

const ENV_ASSET = "GENIE_TOKENIZER_ASSET";
const savedAssetEnv = process.env[ENV_ASSET];

let calibFile = "";

beforeEach(() => {
  delete process.env[ENV_ASSET];
  resetForTest();
  const dir = mkdtempSync(join(tmpdir(), "genie-token-est-"));
  calibFile = join(dir, "token-calibration.json");
  setCalibrationFile(calibFile);
  resetForTest();
});

afterEach(() => {
  if (savedAssetEnv === undefined) delete process.env[ENV_ASSET];
  else process.env[ENV_ASSET] = savedAssetEnv;
  resetForTest();
});

describe("rawTokens —— 真分词器逐值断言", () => {
  it("已知样本计数与 cl100k_base 一致", () => {
    expect(estimatorKind()).toBe("tokenizer");
 // 以下真值由 cl100k_base 经验证得出
    expect(rawTokens("hello world")).toBe(2);
    expect(rawTokens("中文测试")).toBe(3);
    expect(rawTokens("hello, 世界!")).toBe(7);
    expect(rawTokens("const a = 1;")).toBe(6);
    expect(rawTokens("function foo(){return 42}")).toBe(7);
    expect(rawTokens("")).toBe(0);
  });

  it("缓存命中返回同一答案，长文本分块累加不抛", () => {
    const text = "abcdefghij".repeat(1200); // 12000 字符 > 单块阈值
    const first = rawTokens(text);
    expect(first).toBeGreaterThan(0);
    expect(rawTokens(text)).toBe(first);
    const whole = rawTokens("x".repeat(12000));
    expect(whole).toBeGreaterThan(0);
  });
});

describe("资产缺失 → CJK 系数回退", () => {
  it("env 指向不存在路径时进 fallback 且用 1.95/字", () => {
    process.env[ENV_ASSET] = join(tmpdir(), "definitely-missing-cl100k_base.json");
    resetForTest();
    expect(estimatorKind()).toBe("fallback");
    expect(() => rawTokens("中文测试")).not.toThrow();
    expect(rawTokens("中文测试")).toBe(Math.ceil(4 * 1.95)); // 8
    expect(rawTokens("hello world")).toBe(Math.ceil(11 * 0.25)); // 3
  });
});

describe("标定 ratio", () => {
  it("样本 <3 时 ratio 恒 1，estimateTokens === rawTokens", () => {
    for (let i = 0; i < 2; i++) {
      const r = calibrate({ providerKey: "p", model: "m", estInputRaw: 100, reportedInput: 140 });
      expect(r.samples).toBe(i + 1);
      expect(r.ratio).toBe(1);
    }
    expect(calibrationOf("p", "m").ratio).toBe(1);
    expect(estimateTokens("hello world", { providerKey: "p", model: "m" })).toBe(rawTokens("hello world"));
  });

  it("第 3 个样本起启用 ratio（初值=首批均值，之后 EWMA）", () => {
    for (let i = 0; i < 3; i++) calibrate({ providerKey: "p", model: "m", estInputRaw: 100, reportedInput: 130 });
    const state = calibrationOf("p", "m");
    expect(state.samples).toBe(3);
    expect(state.ratio).toBeCloseTo(1.3, 5);
    const raw = rawTokens("hello world");
    const est = estimateTokens("hello world", { providerKey: "p", model: "m" });
    expect(est).not.toBe(raw);
    expect(Math.abs(est - Math.round(raw * state.ratio))).toBeLessThanOrEqual(1);
  });

  it("离群样本（r=10）不进 samples", () => {
    const r = calibrate({ providerKey: "p", model: "m", estInputRaw: 100, reportedInput: 1000 });
    expect(r.inputSampled).toBe(false);
    expect(r.samples).toBe(0);
    expect(calibrationOf("p", "m").ratio).toBe(1);
  });

  it("累积大比例样本后 ratio 被夹在 ≤ 3.0", () => {
    for (let i = 0; i < 20; i++) calibrate({ providerKey: "p", model: "m", estInputRaw: 100, reportedInput: 295 });
    const state = calibrationOf("p", "m");
    expect(state.samples).toBe(20);
    expect(state.ratio).toBeLessThanOrEqual(3.0);
    expect(state.ratio).toBeGreaterThan(2.5);
  });

  it("suspect=true 整条样本丢弃", () => {
    const r = calibrate({ providerKey: "p", model: "m", estInputRaw: 100, reportedInput: 100, suspect: true });
    expect(r.inputSampled).toBe(false);
    expect(r.outputSampled).toBe(false);
    expect(r.samples).toBe(0);
  });

  it("output 侧独立标定", () => {
    for (let i = 0; i < 3; i++) calibrate({ providerKey: "p", model: "m", estOutputRaw: 200, reportedOutput: 300 });
    const state = calibrationOf("p", "m");
    expect(state.samples).toBe(0);
    expect(state.outputSamples).toBe(3);
    expect(state.outputRatio).toBeCloseTo(1.5, 5);
    expect(state.ratio).toBe(1);
  });
});

describe("标定持久化", () => {
  it("写盘 → 重置内存 → lazy load 读出相同数值", () => {
    for (let i = 0; i < 3; i++) {
      calibrate({ providerKey: "p", model: "m", estInputRaw: 100, reportedInput: 130, estOutputRaw: 200, reportedOutput: 260 });
    }
    const before = calibrationOf("p", "m");
    expect(before.samples).toBe(3);
    expect(before.ratio).not.toBe(1);
    flushCalibration();
    const onDisk = JSON.parse(readFileSync(calibFile, "utf8")) as { providers: Record<string, unknown> };
    expect(Object.keys(onDisk.providers)).toContain("p|m");

    resetForTest(); // 保留注入路径，清空内存
    const after = calibrationOf("p", "m");
    expect(after).toEqual(before);
  });

  it("损坏文件不抛，回到空态", () => {
    writeFileSync(calibFile, "{bad json", "utf8");
    resetForTest();
    expect(() => calibrationOf("p", "m")).not.toThrow();
    expect(calibrationOf("p", "m")).toEqual({ ratio: 1, outputRatio: 1, samples: 0, outputSamples: 0 });
    expect(() => calibrate({ providerKey: "p", model: "m", estInputRaw: 100, reportedInput: 130 })).not.toThrow();
  });
});

describe("消息与字符量估算", () => {
  it("消息计入 role / content / toolCalls 参数，数组汇总同倍率", () => {
    const messages = [
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: JSON.stringify({ path: "src/a.ts" }) }] },
      { role: "tool", toolCallId: "c1", content: "文件内容".repeat(50) },
    ];
    const single = estimateMessageTokens(messages[0]);
    expect(single).toBeGreaterThan(0);
    const all = estimateMessagesTokens(messages);
    expect(all).toBeGreaterThan(single);
    expect(estimateMessagesTokens([])).toBe(0);
    expect(estimateMessageTokens(null)).toBe(0);
    expect(() => estimateMessageTokens({ role: "user", content: { nested: [1, 2] } })).not.toThrow();
  });

  it("字符量粗算 CJK 感知且不乘 ratio", () => {
    expect(approxTokensOfChars(0)).toBe(0);
    expect(approxTokensOfChars(1000)).toBe(350);
    expect(approxTokensOfChars(-5)).toBe(0);
    for (let i = 0; i < 5; i++) calibrate({ providerKey: "p", model: "m", estInputRaw: 100, reportedInput: 300 });
    expect(approxTokensOfChars(1000)).toBe(350);
  });
});
