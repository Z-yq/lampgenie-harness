/**
 * 注入间隔闸(J1 2026-11 token 轮)契约测试:同一 key 两次注入间隔 ≥10k token。
 *
 * 分工:闸本体在 runtime(`@lampgenie/runtime/agent/inject-gate`,`inject-gate` 自己的单测覆盖
 * 水位/回退语义);本文件验**装配侧接线**——buildLoopTips 收到 ctx.gate 后是否真的「每步尝试、
 * 由闸限流」,以及 fired(一次为限)与 gate(token 间隔)两层如何串联。
 *
 * 断言口径:`tip.injected` 的 payload.tokensSpent 由 runtime loop 落账(loop.ts 里 tips 调用处),
 * gateway 侧的 buildLoopTips 拿不到那次落账事件——所以这里只断言「注入了/没注入」的次数,
 * tokensSpent 字段本身由 runtime 单测覆盖。
 */
import { it, expect } from "vitest";
import { createInjectGate } from "@lampgenie/runtime/agent/inject-gate";
import { buildLoopTips } from "../src/agent-wiring.js";

it("gate:同一 repeatable key(parallel)在 0 注入一次,+5k 被拒,+10k 放行", () => {
  const gate = createInjectGate();
  const tips = buildLoopTips({ sessionId: "iv-1" });
  // step 1:tokensSpent=0 → 闸无记录 → 放行
  expect(tips({ step: 1, lastStepTools: ["read_file"], tokensSpent: 0, gate })?.keys).toContain("parallel");
  // step 2:+5,000 token(不足 10k 间隔)→ 拒
  expect(tips({ step: 2, lastStepTools: ["grep"], tokensSpent: 5_000, gate })).toBeNull();
  // step 3:+10,000 token(达间隔)→ 放行
  expect(tips({ step: 3, lastStepTools: ["list_dir"], tokensSpent: 10_000, gate })?.keys).toContain("parallel");
  // 水位抬到 10k 后:+15k 拒、+20k 放行
  expect(tips({ step: 4, lastStepTools: ["glob"], tokensSpent: 15_000, gate })).toBeNull();
  expect(tips({ step: 5, lastStepTools: ["glob"], tokensSpent: 20_000, gate })?.keys).toContain("parallel");
});

it("gate:轨迹回看(task:trajectory)是滚动水位——每落一条新轨迹按 10k 间隔注入,不是一次为限", () => {
  const gate = createInjectGate();
  const tips = buildLoopTips({ sessionId: "iv-traj" });
  const c = (step: number, tokensSpent: number, trajectory: string) => tips({ step, lastStepTools: [], tokensSpent, gate, trajectory });
  // 首条轨迹:闸无记录 → 放行
  expect(c(5, 0, "第5步 · 工具3类 · 并行0% · 错误0")?.keys).toContain("task:trajectory");
  // 内容变了但水位只 +5k → 被 10k 闸拦(滚动内容也守间隔)
  expect(c(10, 5_000, "第10步 · 工具4类 · 并行25% · 错误1")).toBeNull();
  // 水位到 +10k → 新轨迹放行(此时 fired 早已含该 key,证明它不走 once)
  expect(c(15, 10_000, "第15步 · 工具5类 · 并行40% · 错误1")?.keys).toContain("task:trajectory");
  // 同一行内容不重复注(即便水位够)
  expect(c(20, 30_000, "第15步 · 工具5类 · 并行40% · 错误1")).toBeNull();
});

it("gate 与 fired 串联:一次性 key(dispatch)受 fired 硬限,抬 token 也不重注", () => {
  const gate = createInjectGate();
  const tips = buildLoopTips({ sessionId: "iv-2" });
  expect(tips({ step: 1, lastStepTools: ["spawn_subagent"], tokensSpent: 0, gate })?.keys).toContain("dispatch");
  // token 拉满也不放行:fired 命中直接拒(闸都不进)
  expect(tips({ step: 2, lastStepTools: ["spawn_subagent"], tokensSpent: 100_000, gate })).toBeNull();
});

it("gate 缺省(旧 ctx)不过闸:并行提醒退回旧步数节流,行为同旧版", () => {
  const tips = buildLoopTips({ sessionId: "iv-3" });
  expect(tips({ step: 1, lastStepTools: ["read_file"] })?.keys).toContain("parallel");
  // 冷却窗内不重复(旧语义:8 步)
  expect(tips({ step: 2, lastStepTools: ["read_file"] })).toBeNull();
  expect(tips({ step: 9, lastStepTools: ["read_file"] })?.keys).toContain("parallel");
});

it("gate:压缩边界后 fired 清空,一次性 key 允许重注入(闸水位仍在,不额外放宽)", () => {
  const gate = createInjectGate();
  const tips = buildLoopTips({ sessionId: "iv-4" });
  expect(tips({ step: 1, lastStepTools: ["spawn_subagent"], tokensSpent: 0, gate, compacts: 0 })?.keys).toContain("dispatch");
  // compact 后 fired 清空 → 同 key 再试:闸水位=0,间隔未满 10k → 仍拒
  expect(tips({ step: 2, lastStepTools: ["read_file", "grep"], tokensSpent: 3_000, gate, compacts: 1 })).toBeNull();
  // 再抬到 ≥10k → 放行(dispatch 与 parallel 同句注入时 keys 两条都在)
  const r = tips({ step: 3, lastStepTools: ["spawn_subagent"], tokensSpent: 12_000, gate, compacts: 1 });
  expect(r?.keys).toContain("dispatch");
});
