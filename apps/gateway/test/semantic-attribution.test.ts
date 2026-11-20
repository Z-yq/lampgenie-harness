/**
 * LLM 语义归因层单测:prompt 构建/响应解析/待归因筛选/幂等跳过/enrichment 写入。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAttributionPrompt,
  parseAttributionResponse,
  findUnattributedChains,
  writeEnrichment,
  runSemanticAttribution,
  LLM_ATTRIBUTION_VERSION,
  type AttributionInput,
} from "../src/semantic-attribution.js";

let root = "";
const roots: string[] = [];
const T0 = 1_700_000_000_000;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "llm-attrib-"));
  roots.push(root);
});
afterEach(() => {
  while (roots.length > 0) { const r = roots.pop(); if (r) rmSync(r, { recursive: true, force: true }); }
});

function seedChain(chainId: string, defectClass: string): void {
  const dir = join(root, ".genie", "rsi");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "rework-chains.jsonl"),
    JSON.stringify({ v: 1, type: "chain", chainId, fixSession: `fix-${chainId}`, buildSession: `build-${chainId}`, path: "src/x.ts", defectClass, diffSummary: "加了空值检查", buildReadPaths: ["src/api.ts", "src/types.ts"], fixTitle: "修复空值崩溃" }) + "\n",
    { flag: "a" },
  );
}

const SAMPLE_INPUT: AttributionInput = {
  chainId: "ch-1",
  fixSession: "fix-sess",
  buildSession: "build-sess",
  path: "src/order.ts",
  diffSummary: "加了 Order.status 过滤,补了边界测试",
  buildReadPaths: ["src/types.ts", "src/api.ts"],
  fixTitle: "修复已取消订单也被导出",
};

describe("buildAttributionPrompt", () => {
  it("含七类枚举/三态 verdict/JSON 格式/决策时可得性证据", () => {
    const { system, user } = buildAttributionPrompt(SAMPLE_INPUT);
    for (const c of ["contract", "boundary", "concurrency", "resource", "protocol", "logic", "regression"]) {
      expect(system).toContain(c);
    }
    expect(system).toContain("preventable");
    expect(system).toContain("drift");
    expect(system).toContain('{"defectClass"');
    expect(user).toContain(SAMPLE_INPUT.diffSummary.slice(0, 50));
    expect(user).toContain("src/types.ts"); // build 读过 → 可得性证据
  });
});

describe("parseAttributionResponse", () => {
  it("合法 JSON → 正确解析;markdown 围栏剥离", () => {
    const ok = parseAttributionResponse("ch-1", '{"defectClass":"boundary","verdict":"preventable","confidence":0.9,"reason":"枚举未取"}', "test-model", T0);
    expect(ok).toMatchObject({ chainId: "ch-1", defectClass: "boundary", verdict: "preventable", confidence: 0.9, reason: "枚举未取", model: "test-model", version: LLM_ATTRIBUTION_VERSION });
    const fenced = parseAttributionResponse("ch-1", '```json\n{"defectClass":"logic","verdict":"drift","confidence":0.7,"reason":"需求后变"}\n```', "m", T0);
    expect(fenced?.defectClass).toBe("logic");
  });

  it("非法类别/verdict/confidence → null 不 throw", () => {
    expect(parseAttributionResponse("c", '{"defectClass":"wrong","verdict":"preventable","confidence":0.5}', "m", T0)).toBeNull();
    expect(parseAttributionResponse("c", '{"defectClass":"logic","verdict":"wrong","confidence":0.5}', "m", T0)).toBeNull();
    expect(parseAttributionResponse("c", '{"defectClass":"logic","verdict":"drift","confidence":2.0}', "m", T0)).toBeNull();
    expect(parseAttributionResponse("c", "not json", "m", T0)).toBeNull();
  });
});

describe("findUnattributedChains", () => {
  it("只选 uncategorized/None 且无同版 enrichment 的链;已有 enrichment 跳过", () => {
    seedChain("ch-1", "uncategorized");
    seedChain("ch-2", "");
    seedChain("ch-3", "contract"); // 已有分类,跳过
    seedChain("ch-4", "None");
    const found = findUnattributedChains(root);
    expect(found.map((f) => f.chainId).sort()).toEqual(["ch-1", "ch-2", "ch-4"]);
 // 写入 ch-1 enrichment → 再查不再含 ch-1
    writeEnrichment(root, { chainId: "ch-1", defectClass: "boundary", verdict: "preventable", confidence: 0.8, reason: "test", model: "m", version: LLM_ATTRIBUTION_VERSION, at: T0 });
    const again = findUnattributedChains(root);
    expect(again.map((f) => f.chainId)).not.toContain("ch-1");
    expect(again.length).toBe(2);
  });
});

describe("runSemanticAttribution(端到端,mock LLM)", () => {
  it("全流程:找链→调 LLM→写 enrichment→幂等重跑零重复", async () => {
    seedChain("ch-a", "uncategorized");
    seedChain("ch-b", "");
    let callCount = 0;
    const chatFn = async (msgs: Array<{ role: string; content: string }>) => {
      callCount += 1;
      const user = msgs.find((m) => m.role === "user")?.content ?? "";
      if (user.includes("ch-a")) return { content: '{"defectClass":"contract","verdict":"preventable","confidence":0.85,"reason":"签名变更未同步调用方"}' };
      return { content: '{"defectClass":"boundary","verdict":"drift","confidence":0.6,"reason":"需求后加的状态"}' };
    };
    const first = await runSemanticAttribution(root, chatFn, "test-model", { now: T0 });
    expect(first.enriched).toBe(2);
    expect(first.errors).toBe(0);
    expect(callCount).toBe(2);
 // 台账有 2 条 enrichment
    const text = readFileSync(join(root, ".genie", "rsi", "rework-chains.jsonl"), "utf8");
    const enrichLines = text.split("\n").filter((l) => l.includes('"type":"enrichment"'));
    expect(enrichLines).toHaveLength(2);
 // 重跑:同版 enrichment 已在 → 零链待归因,零 LLM 调用
    const second = await runSemanticAttribution(root, chatFn, "test-model", { now: T0 + 1000 });
    expect(second.enriched).toBe(0);
    expect(callCount).toBe(2); // 没新调用
  });

  it("LLM 返回垃圾 → 计 errors,不写盘,不 throw", async () => {
    seedChain("ch-bad", "uncategorized");
    const bad = async () => ({ content: "I am not a JSON" });
    const r = await runSemanticAttribution(root, bad, "m", { now: T0 });
    expect(r.enriched).toBe(0);
    expect(r.errors).toBe(1);
  });
});
