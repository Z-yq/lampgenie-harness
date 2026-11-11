/**
 * 接线验收(读源码断言):error-repair 纯逻辑模块导出面 + openai-provider 三处接入
 * (attemptedRepairs/repairPlan/applyRepair、emit model_repair 重发、detectFake200 伪 200)。
 * 纯源码断言:不启动 gateway、不真连网。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

const errorRepairSrc = read("packages/harness-runtime/src/agent/error-repair.ts");
const providerSrc = read("packages/harness-runtime/src/agent/openai-provider.ts");
const policySrc = read("packages/harness-runtime/src/agent/model-error-policy.ts");
const apitypesSrc = read("packages/harness-runtime/src/agent/provider-apitypes.ts");
const admissionSrc = read("packages/harness-runtime/src/concurrency/admission.ts");

describe("error-repair 纯逻辑模块(导出面)", () => {
  it("REPAIR_CODES 封闭五值 + 封闭 REPAIR_TABLE 九个 reason", () => {
    expect(errorRepairSrc).toContain(
      'export const REPAIR_CODES = ["OK", "NOT_REPAIRABLE", "ALREADY_ATTEMPTED", "FAKE_200", "INVALID"] as const;',
    );
    for (const reason of [
      "context_exceeded",
      "invalid_request",
      "transient",
      "rate_limited",
      "auth",
      "not_configured",
      "model_unavailable",
      "quota",
      "cancelled",
    ]) {
      expect(errorRepairSrc).toContain(`${reason}:`);
    }
    expect(errorRepairSrc).toContain('invalid_request: freezeActions(["strip-reasoning", "clamp-max-tokens", "drop-unsupported-params"])');
    expect(errorRepairSrc).toContain('context_exceeded: freezeActions(["report-context-exceeded"])');
  });

  it("repairPlan / applyRepair / detectFake200 / shouldTreatAsError 均导出", () => {
    expect(errorRepairSrc).toContain("export function repairPlan(");
    expect(errorRepairSrc).toContain("export function applyRepair(");
    expect(errorRepairSrc).toContain("export function detectFake200(");
    expect(errorRepairSrc).toContain("export function shouldTreatAsError(");
  });

  it("一次性去重键 onceKey=`${code}:${attempt}` 与 ALREADY_ATTEMPTED 分支在场", () => {
    expect(errorRepairSrc).toContain("const onceKey = `${code}:${attempt}`;");
    expect(errorRepairSrc).toContain('code: "ALREADY_ATTEMPTED"');
  });

  it("applyRepair 白名单只含三键,且不改入参(浅拷贝 map/展开)", () => {
    expect(errorRepairSrc).toContain('export const DROP_UNSUPPORTED_KEYS = ["response_format", "parallel_tool_calls", "logprobs"] as const;');
    expect(errorRepairSrc).toContain("request.messages.map((m) => ({ ...(m as Record<string, unknown>) }))");
  });

  it("model-error-policy 提供最小导出 extractErrorCode,error-repair 复用它", () => {
    expect(policySrc).toContain("export function extractErrorCode(");
    expect(errorRepairSrc).toContain('import { extractErrorCode } from "./model-error-policy";');
  });
});

describe("openai-provider 三处接入(源码断言)", () => {
  it("接线 1:每次请求局部 attemptedRepairs + repairPlan/applyRepair 改写入口", () => {
    expect(providerSrc).toContain("const attemptedRepairs = new Set<string>();");
    expect(providerSrc).toContain("const plan = repairPlan({");
    expect(providerSrc).toContain("const repaired = applyRepair({ messages: reqMessages, tools: reqTools, extra: reqExtra }, plan.actions);");
    expect(providerSrc).toContain("attemptedRepairs.add(decision.kind);");
 // repair 钩子只在 invalid_request 分类分支触发
    expect(providerSrc).toContain('if (decision.kind === "invalid_request" && opts.repair) {');
  });

  it("接线 2:发出 model_repair 生命周期事件后立即重发(不占既有 retry 预算)", () => {
    expect(providerSrc).toContain('type: "model_repair"');
    expect(providerSrc).toContain("function emitModelRepair(");
    expect(providerSrc).toContain("emitModelRepair(opts.emit, decision.kind, actions);");
    expect(providerSrc).toContain("attempt--;");
    expect(providerSrc).toContain("repair: ({ decision }: { decision: ModelErrorDecision }) => repairBody(decision),");
  });

  it("接线 3:解析响应前 detectFake200 判定伪 200(chat/completions 两条解析路径)", () => {
    const callAt = providerSrc.indexOf("detectFake200(res.status, rawText)");
    const parseAt = providerSrc.indexOf("JSON.parse(rawText)");
    expect(callAt).toBeGreaterThan(-1);
    expect(parseAt).toBeGreaterThan(callAt);
    expect(providerSrc).toContain("shouldTreatAsError(fake200)");
    expect(providerSrc).toContain("伪 200:响应体为错误");
  });

  it("边界:anthropic/responses 适配器与 provider-apitypes 未被接入(语义逐字不变)", () => {
    expect(providerSrc).toContain("anthropicChat(cur, messages, tools, controller.signal, onDelta, rctx)");
    expect(providerSrc).toContain("responsesChat(cur, messages, tools, controller.signal, onDelta, rctx)");
    expect(apitypesSrc).not.toContain("repairPlan");
    expect(apitypesSrc).not.toContain("applyRepair");
    expect(apitypesSrc).not.toContain("detectFake200");
  });

  it("接线 4:流式路径接同一套修复(body getter + repair/repairAttempted + 二败注明)", () => {
 // 流式 dispatch:body 以 getter 传入(修复重建后的新体才是重发体)
    expect(providerSrc).toContain("() => body,");
    expect(providerSrc).toContain("body: () => Record<string, unknown>,");
    expect(providerSrc).toContain("retryCtx: StreamRetryCtx,");
 // 流式 postWithRetry 注入 repair 入口(与非流式同一 repairBody)
    expect(providerSrc).toContain("...(retryCtx.repair ? { repair: retryCtx.repair } : {}),");
    expect(providerSrc).toContain("repairAttempted: () => attemptedRepairs.size > 0");
 // 流式 fetch 重发前现取 body(不是调用时快照)
    expect(providerSrc).toContain("...body(), stream: true, stream_options: { include_usage: true }");
 // 修复后仍失败 → 上抛并注明
    expect(providerSrc).toContain("修复后仍失败");
  });

  it("接线 5:model_repair 登记进 ModelLifecycleEvent 联合(provider 无局部扩展类型)", () => {
    expect(admissionSrc).toContain('type: "model_repair";');
    expect(admissionSrc).toContain("| ModelRepairEvent;");
    expect(providerSrc).not.toContain('as unknown as (e: { type: "model_repair"');
    expect(providerSrc).toContain('emit({ type: "model_repair", code, actions: [...actions], at: Date.now() });');
  });
});
