/**
 * RSI 注入枢纽接线契约(事件面 v1,读源码断言):
 * - run-with-agent 开工统一走 rsiInjectionHub.collect(不再内联各 RSI 注入实现);
 * - 首批 listener 在 rsi-injection-listeners.ts 注册(negkb-deadends 迁移 + gap-prevention 新接);
 * - 零块=零注入;留痕 custom{type:"loop.inject.shown", sources+bytes+skipped};
 * - 追加进 composeSystemPrompt 的 base(稳定前缀),与方向简报同位;
 * - 仅 coding 类 + 非远程项目(fail-soft 由 hub 兜底)。
 * 行为面由 loop-injection-hub.test.ts(预算/折叠)与 negative-kb-store/gap-taxonomy-store 覆盖。
 */
import { describe, it, expect } from "vitest";
import { AGENT_WIRING_SRC } from "./panel-source.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rsiInjectionHub } from "../src/rsi-injection-listeners.js";

const src = AGENT_WIRING_SRC;
const listenersSrc = readFileSync(join(__dirname, "../src/rsi-injection-listeners.ts"), "utf8");

describe("注入枢纽接线(run-with-agent)", () => {
  it("开工统一 collect(point=kickoff),不再内联 negKbInject/negkb 块实现", () => {
    expect(src).toContain("rsiInjectionHub.collect(");
    expect(src).toContain("RSI_INJECTION_POINT_KICKOFF");
    expect(src).not.toContain("negKbInject(");
    expect(src).not.toContain("negkb.brief.shown");
  });

  it("仅 coding 类 + 非远程项目;整体 try/catch fail-soft", () => {
    expect(src).toContain('taskClassState.value === "coding" && !taskRemoteProject');
    expect(src).toMatch(/\/\/ 枢纽整体失败:零注入\(fail-soft,不阻塞开工\)/);
  });

  it("留痕 custom loop.inject.shown(sources 带 source+bytes;skipped 不静默)", () => {
    expect(src).toContain('type: "loop.inject.shown"');
    expect(src).toContain("source: b.source, bytes: b.bytes");
    expect(src).toContain("skipped: injected.skipped");
  });

  it("追加进 compose base 稳定前缀(空串=零变化)", () => {
    expect(src).toContain('+ (rsiInjectBrief === "" ? "" : "\\n\\n" + rsiInjectBrief)');
  });

  it("阶段恰时注入(2026-11-17):task_phase 回执携带枢纽块,每会话每点位一次", () => {
    expect(src).toContain("RSI_INJECTION_POINT_FOR_PHASE[key]");
    expect(src).toContain("phaseInjectShown");
 // 零块=零变化;留痕与开工位同一 kind(point=phase-<key>)
    expect(src).toMatch(/point: `phase-\$\{key\}`/);
  });
});

describe("首批 listener 注册(rsi-injection-listeners)", () => {
  it("negkb-deadends 与 gap-prevention 都在册(hub 实例真实注册)", () => {
    expect(rsiInjectionHub.listenerIds()).toEqual(expect.arrayContaining(["negkb-deadends", "gap-prevention"]));
  });

  it("negkb 迁移:同检索同预算(1200),标题保留;实现驻 listener 不在核心", () => {
    expect(listenersSrc).toContain('id: "negkb-deadends"');
    expect(listenersSrc).toContain("maxChars: 1200");
    expect(listenersSrc).toContain("## 已验证死路(负面知识库,别再走)");
  });

  it("gap-prevention:点位→gap 注入点映射,只取 context 块(#211 消费面首接)", () => {
    expect(listenersSrc).toContain('id: "gap-prevention"');
    expect(listenersSrc).toContain('kickoff: "pre-requirement"');
    expect(listenersSrc).toContain("applyAt(repoRoot(), gapPoint");
    expect(listenersSrc).toContain("contextBlocks");
  });

  it("阶段点位映射齐全(五阶段→gap pre-*;死路只在开工位)", () => {
    expect(listenersSrc).toContain('"phase-plan": "pre-plan"');
    expect(listenersSrc).toContain('"phase-implement": "pre-write"');
    expect(listenersSrc).toContain('"phase-verify": "pre-verify"');
    expect(listenersSrc).toContain('"phase-close": "pre-close"');
 // negkb listener 明确限定开工位(阶段位返回空)
    expect(listenersSrc).toContain("input.point !== RSI_INJECTION_POINT_KICKOFF");
  });
});
