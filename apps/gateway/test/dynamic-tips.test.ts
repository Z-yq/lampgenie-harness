/**
 * 任务内动态指导卡(J1 2026-11 token 轮)契约测试:三信号各一例 + 零信号不注入 + GENIE_TIPS=off 全关。
 * 为什么放在 buildLoopTips 层测:判定口径写在 agent-wiring-dynamic-tips.ts(纯函数 dynTipKeys),
 * 但「信号怎么从 ctx 累积出来」(连续改同一文件 = 编辑类工具步的连续计数、验证轮次 = 验证工具步数、
 * 落板 = 见过 board_upsert)是 buildLoopTips 的闭包职责——本文件按真实 ctx 序列驱动它,验的是真身。
 * 零反斜杠纪律:断言全用 includes 字面串。
 */
import { it, expect, afterEach } from "vitest";
import { buildLoopTips } from "../src/agent-wiring.js";
import {
  DYN_TIP_MAX_LINES,
  DYN_TIPS,
  DYN_VERIFY_CADENCE_STEP,
  DYN_VERIFY_CADENCE_GAP,
  DYN_DELEGATE_STEP,
  DYN_DELEGATE_TOKENS,
  dynTipKeys,
  dynTipText,
  type DynSignals,
  type DynTipKey,
} from "../src/agent-wiring-dynamic-tips.js";

afterEach(() => { delete process.env.GENIE_TIPS; });

it("dyn:hypothesis —— 同一文件连续 3 步被改动才注入(第 1/2 步不注入)", () => {
  const tips = buildLoopTips({ sessionId: "dyn-h" });
  // 读文件不算改动(同一文件连读 3 步不该刷假设卡)
  expect(tips({ step: 1, lastStepTools: ["read_file", "grep"], lastStepFiles: ["a.ts"] })).toBeNull();
  expect(tips({ step: 2, lastStepTools: ["read_file", "grep"], lastStepFiles: ["a.ts"] })).toBeNull();
  expect(tips({ step: 3, lastStepTools: ["read_file", "grep"], lastStepFiles: ["a.ts"] })).toBeNull();
  // 连续编辑同一文件:streak 1 / 2 / 3
  expect(tips({ step: 4, lastStepTools: ["edit_file"], lastStepFiles: ["b.ts"] })).toBeNull();
  expect(tips({ step: 5, lastStepTools: ["edit_file"], lastStepFiles: ["b.ts"] })).toBeNull();
  const r = tips({ step: 6, lastStepTools: ["edit_file"], lastStepFiles: ["b.ts"] });
  expect(r?.text).toContain("动态·先立假设");
  expect(r?.text).toContain("同一文件连改 3 步");
  expect(r?.keys).toContain("dyn:hypothesis");
  // 一次为限(fired):后续步不再重复
  expect(tips({ step: 7, lastStepTools: ["edit_file"], lastStepFiles: ["b.ts"] })).toBeNull();
});

it("dyn:verify-stop —— 验证轮次 ≥2 且 totalErrors>=2 才注入", () => {
  const tips = buildLoopTips({ sessionId: "dyn-v" });
  // 只跑 1 轮验证且只 1 个错:不注入
  expect(tips({ step: 1, lastStepTools: ["run_cmd"], totalErrors: 1 })).toBeNull();
  // 第 2 轮验证 + 第 2 个错:注入「失败即停」
  const r = tips({ step: 2, lastStepTools: ["run_cmd"], totalErrors: 2 });
  expect(r?.text).toContain("动态·失败即停");
  expect(r?.text).toContain("先复现");
  expect(r?.keys).toContain("dyn:verify-stop");
});

it("dyn:verify-stop —— 轮次够但错误不足不注入(两条阈值同时满足才算 shotgun)", () => {
  const tips = buildLoopTips({ sessionId: "dyn-v2" });
  expect(tips({ step: 1, lastStepTools: ["terminal"], totalErrors: 0 })).toBeNull();
  expect(tips({ step: 2, lastStepTools: ["terminal"], totalErrors: 1 })).toBeNull();
});

it("dyn:phase-align —— step>40 且从未落板才注入;落过板就不再注入", () => {
  const tips = buildLoopTips({ sessionId: "dyn-p" });
  // 40 步以内不注入(边界:step=40 不算「40+」)
  expect(tips({ step: 40, lastStepTools: ["read_file", "grep"] })).toBeNull();
  const r = tips({ step: 41, lastStepTools: ["read_file", "grep"] });
  expect(r?.text).toContain("动态·阶段对齐");
  expect(r?.text).toContain("步数 40+ 未落板");
  expect(r?.keys).toContain("dyn:phase-align");
  // 落过板的任务:到 41 步也不注入(另起一个 tips 实例才不受 fired 影响)
  const touched = buildLoopTips({ sessionId: "dyn-p2" });
  expect(touched({ step: 1, lastStepTools: ["board_upsert"] })).toBeNull();
  expect(touched({ step: 41, lastStepTools: ["read_file", "grep"] })).toBeNull();
});

it("零信号不注入:普通读写步 + 无错误 + 步数少 → 全程 null", () => {
  const tips = buildLoopTips({ sessionId: "dyn-none" });
  for (let s = 1; s <= 10; s++) {
    // 每步两个调用:避开并行提醒(单只读调用会触发 parallel),只验动态卡零信号
    const tools = s % 2 === 0 ? ["read_file", "grep"] : ["grep", "glob"];
    expect(tips({ step: s, lastStepTools: tools, lastStepFiles: ["x" + s + ".ts"], totalErrors: 0 })).toBeNull();
  }
});

it("GENIE_TIPS=off 全关(动态卡也不注入)", () => {
  process.env.GENIE_TIPS = "off";
  const tips = buildLoopTips({ sessionId: "dyn-off" });
  expect(tips({ step: 6, lastStepTools: ["edit_file"], lastStepFiles: ["b.ts"] })).toBeNull();
  expect(tips({ step: 41, lastStepTools: ["read_file", "grep"] })).toBeNull();
});

it("旧 ctx 形态零行为变化:不传 lastStepFiles/totalErrors 也不崩、不注入动态卡", () => {
  const tips = buildLoopTips({ sessionId: "dyn-legacy" });
  expect(tips({ step: 1, lastStepTools: ["edit_file"] })).toBeNull();
  expect(tips({ step: 50, lastStepTools: ["edit_file"] })).not.toBeNull(); // phase-align:步数够且未落板
  expect(tips({ step: 51, lastStepTools: ["edit_file"] })?.keys ?? []).not.toContain("dyn:hypothesis");
});

// ── 新增两卡(J1 token 轮二批):纯函数层直测边界与顺序 ────────────────────────────
/** 基线信号:boardTouched=true 关掉 phase-align 噪声,便于单看目标卡的命中。 */
function sig(over: Partial<DynSignals> = {}): DynSignals {
  return { lastStepFiles: [], fileEditStreak: {}, verifyRounds: 0, totalErrors: 0, step: 1, boardTouched: true, ...over };
}

it("常量契约:阈值与卡片表一一对应(改阈值必须同时改测试)", () => {
  expect(DYN_VERIFY_CADENCE_STEP).toBe(12);
  expect(DYN_VERIFY_CADENCE_GAP).toBe(10);
  expect(DYN_DELEGATE_STEP).toBe(25);
  expect(DYN_DELEGATE_TOKENS).toBe(120_000);
  expect(DYN_TIP_MAX_LINES).toBe(6);
});

it("dyn:verify-cadence —— step≥12 且 距上次验证 ≥10 步才命中", () => {
  // 边界命中:step=12,lastVerifyStep=2 → gap=10
  expect(dynTipKeys(sig({ step: 12, lastVerifyStep: 2 }))).toContain("dyn:verify-cadence");
  // step=11(gap=10 但起始步数不够)→ 不命中
  expect(dynTipKeys(sig({ step: 11, lastVerifyStep: 1 }))).not.toContain("dyn:verify-cadence");
  // lastVerifyStep 缺省(从未验证)→ 不命中
  expect(dynTipKeys(sig({ step: 30 }))).not.toContain("dyn:verify-cadence");
  // gap=9 → 不命中
  expect(dynTipKeys(sig({ step: 12, lastVerifyStep: 3 }))).not.toContain("dyn:verify-cadence");
  // 文案:行式,含「未验证」与最小验证动作
  const txt = dynTipText("dyn:verify-cadence");
  expect(txt).toContain("10 步未验证");
  expect(txt).toContain("最小验证");
});

it("dyn:delegate —— step/spawnedSubagent/tokens 三条件全满足才命中", () => {
  const ok = { step: DYN_DELEGATE_STEP, spawnedSubagent: false, tokensSpent: DYN_DELEGATE_TOKENS };
  expect(dynTipKeys(sig(ok))).toContain("dyn:delegate");
  expect(dynTipKeys(sig({ ...ok, step: DYN_DELEGATE_STEP - 1 }))).not.toContain("dyn:delegate"); // 步数不足
  expect(dynTipKeys(sig({ ...ok, spawnedSubagent: true }))).not.toContain("dyn:delegate"); // 已 spawn
  expect(dynTipKeys(sig({ ...ok, tokensSpent: DYN_DELEGATE_TOKENS - 1 }))).not.toContain("dyn:delegate"); // tokens 不足
  // 新字段缺省(旧调用方)→ 不命中
  expect(dynTipKeys(sig({ step: 60 }))).not.toContain("dyn:delegate");
  const txt = dynTipText("dyn:delegate");
  expect(txt).toContain("spawn_subagent");
  expect(txt).toContain("主轨只收结论");
});

it("顺序固定:既有三卡相对顺序不变,新卡追加在末尾(verify-cadence → delegate)", () => {
  const all = dynTipKeys(sig({
    step: 60, fileEditStreak: { "a.ts": 3 }, verifyRounds: 2, totalErrors: 2, boardTouched: false,
    lastVerifyStep: 5, spawnedSubagent: false, tokensSpent: 200_000,
  }));
  expect(all).toEqual([
    "dyn:hypothesis", "dyn:verify-stop", "dyn:phase-align", "dyn:verify-cadence", "dyn:delegate",
  ]);
});

it("每卡行数 ≤ DYN_TIP_MAX_LINES,且文本=fired 的 join(\"\\n\")非空", () => {
  const keys: DynTipKey[] = [
    "dyn:hypothesis", "dyn:verify-stop", "dyn:phase-align", "dyn:verify-cadence", "dyn:delegate",
  ];
  expect(Object.keys(DYN_TIPS).length).toBe(keys.length);
  for (const k of keys) {
    const lines = dynTipText(k).split("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(DYN_TIP_MAX_LINES);
    expect(lines.every((l) => l.trim().length > 0)).toBe(true);
  }
});

it("DynSignals 不传新字段时判定与旧版完全一致(三卡口径零行为变化)", () => {
  const legacyCases: Partial<DynSignals>[] = [
    { step: 6, fileEditStreak: { "b.ts": 3 } },
    { step: 2, verifyRounds: 2, totalErrors: 2 },
    { step: 41, boardTouched: false },
    { step: 60, boardTouched: false },
    { step: 1 },
  ];
  for (const c of legacyCases) {
    const keys = dynTipKeys(sig(c));
    expect(keys.filter((k) => k === "dyn:verify-cadence" || k === "dyn:delegate")).toEqual([]);
  }
});
