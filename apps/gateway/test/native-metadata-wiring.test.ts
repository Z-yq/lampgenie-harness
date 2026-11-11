/**
 * 接线静态断言:源码级把三处接线钉死(不改其它源文件,只读源码断言)。
 * - harness-runtime loop:deriveMessages 新增可选 currentModel 判据;
 * 主 LLM 调用点 catch context_exceeded → OverflowOnceGuard → 单次强制压缩 + 重放。
 * - gateway compact-hook:闭包可选第三参 {reason:"overflow"} → force=true 且绕过 gate.fire;
 * 不传时行为逐字不变(旧 force 表达式不被无条件替换)。
 * 行为面由 packages/harness-runtime/test/native-metadata.test.ts 与既有 auto-compact 用例兜底。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");

const LOOP = src("../../../packages/harness-runtime/src/agent/loop.ts");
const HOOK = src("../src/compact-hook.ts");
const NATIVE = src("../../../packages/harness-runtime/src/agent/native-metadata.ts");
const CORE_TYPES = src("../../../packages/core/src/journal/types.ts");

describe("loop.ts 接线:deriveMessages 原生元数据判据", () => {
  it("deriveMessages 新增可选 currentModel 参数", () => {
    expect(LOOP).toContain("export function deriveMessages(journal: Journal, sessionId: string, opts?: { currentModel?: string }): Message[]");
  });
  it("assistant 分支用 shouldReplayNativeMetadata 且 currentModel 未传=旧行为", () => {
    expect(LOOP).toContain("shouldReplayNativeMetadata(");
    expect(LOOP).toContain("opts?.currentModel === undefined");
 // 降级时 reasoning 不带出:replay 与 reasoning 同一 spread 表达式
    expect(LOOP).toContain("...(replay && typeof p.reasoning === \"string\" && p.reasoning ? { reasoning: p.reasoning } : {})");
  });
  it("messageHadError 认失败标记(payload.error/failed/incomplete)", () => {
    expect(LOOP).toContain("const messageHadError = p.error !== undefined || p.failed === true || p.incomplete === true;");
  });
});

describe("loop.ts 接线:overflow 单次重放", () => {
  it("catch ModelRequestError 且 kind=context_exceeded 才进守卫", () => {
    expect(LOOP).toContain("err instanceof ModelRequestError && err.kind === \"context_exceeded\"");
  });
  it("用 OverflowOnceGuard 判定并把 compact.overflow 落 journal(不再 as EventKind 绕过联合)", () => {
    expect(LOOP).toContain("this.overflowGuard.next({ turn, durableOutputTokens, overflow: true })");
    expect(LOOP).toContain("kind: \"compact.overflow\",");
    expect(LOOP).not.toContain("as EventKind");
    expect(LOOP).toContain("payload: { action: guard.action, code: guard.code, turn, step }");
  });
  it("compact-and-replay 分支调用 compressHook 第三参 {reason:\"overflow\"} 并重取 deriveMessages 重放", () => {
    expect(LOOP).toContain("this.opts.compactHook(journal, sessionId, { reason: \"overflow\" })");
    expect(LOOP).toContain("const replayDerived = deriveMessages(journal, sessionId, { currentModel: modelAtStart });");
    expect(LOOP).toContain("reqMessages = [replaySystem, ...replayDerived];");
    expect(LOOP).toContain("this.overflowGuard.noteSurfaceTokens(");
 // 重放=同一 step 循环内 continue(不是新 turn)
    expect(LOOP).toContain("attemptId = `${sessionId}:${turn}:${step}:${++this.attemptSeq}`;");
  });
  it("compactHook 类型允许可选第三参(不改既有两参调用语义)", () => {
    expect(LOOP).toContain("compactHook?: (journal: Journal, sessionId: string, opts?: { reason?: \"overflow\" }) => Promise<void>;");
  });
  it("durable 工具输出按本 turn 反向扫描估算", () => {
    expect(LOOP).toContain("function durableToolOutputTokens(journal: Journal, sessionId: string, turn: number): number");
  });
});

describe("loop.ts 接线:正常每步降级 + turn 边界重置", () => {
  it("每步 deriveMessages 传 t0 快照的当前模型(正常请求路径)", () => {
    expect(LOOP).toContain("const modelForDerive = llmModelVendor.modelName ?? llmModelVendor.model;");
    expect(LOOP).toContain("? deriveMessages(journal, sessionId, { currentModel: modelForDerive })");
  });
  it("provider 无模型名(undefined)时不传 → 旧行为逐字不变", () => {
    expect(LOOP).toContain(": deriveMessages(journal, sessionId);");
  });
  it("每 turn 边界重置 overflow 守卫停滞标记/同 turn 审批", () => {
    expect(LOOP).toContain("this.overflowGuard.resetForTurn();");
    expect(NATIVE).toContain("resetForTurn(): void");
  });
  it("core EventKind 联合已登记 compact.overflow(无 cast 绕过)", () => {
    expect(CORE_TYPES).toContain("| \"compact.overflow\"");
  });
});

describe("compact-hook.ts 接线:overflow 强制压缩", () => {
  it("闭包签名含可选第三参", () => {
    expect(HOOK).toContain("opts?: { reason?: \"overflow\" }) => Promise<void>");
    expect(HOOK).toContain("return async (j, sid, hookOpts) => {");
  });
  it("reason=overflow 时绕过 gate.fire 且 force=true", () => {
    expect(HOOK).toContain("if (!gate.fire && hookOpts?.reason !== \"overflow\") return;");
    expect(HOOK).toContain("force: gate.force || hookOpts?.reason === \"overflow\",");
  });
  it("旧行为不被无条件替换(不存在裸 force: gate.force)", () => {
    expect(HOOK).not.toContain("force: gate.force,");
  });
});

describe("native-metadata.ts 导出面", () => {
  it("必需导出全在", () => {
    for (const name of [
      "NATIVE_METADATA_CODES",
      "shouldReplayNativeMetadata",
      "degradeMessageNativeMetadata",
      "projectMessagesForProvider",
      "serializeHeadAsTextCheckpoint",
      "OverflowOnceGuard",
    ]) {
      expect(NATIVE).toContain(`export ${name.startsWith("NATIVE") ? "const" : name === "OverflowOnceGuard" ? "class" : "function"} ${name}`);
    }
  });
  it("中文注释解释了模型切换降级与 overflow 单次的理由", () => {
    expect(NATIVE).toContain("模型切换");
    expect(NATIVE).toContain("死循环压缩");
    expect(NATIVE).toContain("摘要套摘要");
  });
});
