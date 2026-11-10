/**
 * 接线闭环回归锚(J1 2026-11 token 轮,子任务 B + C)。
 * 缺口形态:agent-wiring-dynamic-tips.ts 已备好 `dyn:verify-cadence` / `dyn:delegate` 两张卡的
 * 判定(纯函数 + 常量),但 buildLoopTips 没把 `lastVerifyStep` / `spawnedSubagent` / `tokensSpent`
 * 填进 DynSignals → 生产路径上两张卡永不触发(死代码)。本文件按真实 ctx 序列驱动 buildLoopTips
 * (闭包状态的归属处)来验信号累积,顺带锁 C 的两个进度折算纯函数。
 * 零反斜杠纪律:断言全用 includes 字面串。
 */
import { it, expect, afterEach, describe } from "vitest";
import { buildLoopTips } from "../src/agent-wiring.js";
import {
  DYN_VERIFY_CADENCE_STEP,
  DYN_VERIFY_CADENCE_GAP,
  DYN_DELEGATE_STEP,
  DYN_DELEGATE_TOKENS,
} from "../src/agent-wiring-dynamic-tips.js";

afterEach(() => { delete process.env.GENIE_TIPS; });

/** 走一步只读探测(code_sense 是 PARALLEL_ELIGIBLE,gate 会让「并行」卡也注入;断言按 key 精确取)。 */
function ro(step: number) {
  return { step, lastStepTools: ["code_sense"], lastStepFiles: [] as string[] };
}

/* ───────────── B) dyn:verify-cadence:lastVerifyStep 信号 ───────────── */

describe("B) dyn:verify-cadence 信号接线", () => {
  it("① 先验一次(step2 run_cmd),连着 10 步没验证 → step12 注入「未验证」卡", () => {
    const tips = buildLoopTips({ sessionId: "w-cad-1" });
    // step1 无验证历史:lastVerifyStep 尚无值 → 该卡不触发(那时该说「先跑第一轮验证」=SOP 职责)
    expect(tips(ro(1))?.keys ?? []).not.toContain("dyn:verify-cadence");
    // step2 跑了验证工具 → lastVerifyStep=2
    const r2 = tips({ step: 2, lastStepTools: ["run_cmd"], lastStepFiles: [] });
    expect(r2?.keys ?? []).not.toContain("dyn:verify-cadence");
    // step3..11 全是只读探测(步数没到 12 或间隔没到 10)
    for (let s = 3; s < DYN_VERIFY_CADENCE_STEP; s++) {
      expect(tips(ro(s))?.keys ?? []).not.toContain("dyn:verify-cadence", `step${s} 不该触发`);
    }
    // step12:12-2=10 ≥ DYN_VERIFY_CADENCE_GAP → 注入
    const hit = tips(ro(DYN_VERIFY_CADENCE_STEP));
    expect(hit, "step12 必须注入(信号未接线时这里是 null)").not.toBeNull();
    expect(hit!.keys).toContain("dyn:verify-cadence");
    expect(hit!.text).toContain("动态·验证节奏");
    expect(hit!.text).toContain("未验证");
    // 与常量口径一致(防文案/常量漂移)
    expect(DYN_VERIFY_CADENCE_STEP - 2).toBeGreaterThanOrEqual(DYN_VERIFY_CADENCE_GAP);
  });

  it("② 第 13 步跑了 run_cmd → lastVerifyStep 更新、不再注入;once 生效不重放", () => {
    const tips = buildLoopTips({ sessionId: "w-cad-2" });
    tips({ step: 2, lastStepTools: ["run_cmd"], lastStepFiles: [] });
    for (let s = 3; s < 12; s++) tips(ro(s));
    expect(tips(ro(12))!.keys).toContain("dyn:verify-cadence");
    // step13 又验证一次 → lastVerifyStep=13,间隔归零;即使 fired 被清(模拟 compact)也不该立刻重注
    const r13 = tips({ step: 13, lastStepTools: ["run_cmd"], lastStepFiles: [], compacts: 1 });
    expect(r13?.keys ?? []).not.toContain("dyn:verify-cadence");
    // 再连 9 步仍不触发(13+10=23 才够)
    for (let s = 14; s < 23; s++) {
      expect(tips(ro(s))?.keys ?? []).not.toContain("dyn:verify-cadence", `step${s} 不该触发`);
    }
    expect(tips(ro(23))!.keys).toContain("dyn:verify-cadence");
  });

  it("②b 从未验证过(无 run_cmd/terminal/run_workflow)→ 再多步也不触发该卡", () => {
    const tips = buildLoopTips({ sessionId: "w-cad-3" });
    for (let s = 1; s <= 30; s++) {
      expect(tips(ro(s))?.keys ?? []).not.toContain("dyn:verify-cadence", `step${s} 不该触发`);
    }
  });

  it("②c terminal / run_workflow 同样算验证工具(不只是 run_cmd)", () => {
    const tips = buildLoopTips({ sessionId: "w-cad-4" });
    tips({ step: 1, lastStepTools: ["terminal"], lastStepFiles: [] });
    for (let s = 2; s < 12; s++) tips(ro(s));
    expect(tips(ro(12))!.keys).toContain("dyn:verify-cadence");
  });
});

/* ───────────── B) dyn:delegate:spawnedSubagent + tokensSpent 信号 ───────────── */

describe("B) dyn:delegate 信号接线", () => {
  const light = { ...ro(1), tokensSpent: 0 };

  it("③ step≥25 + 上下文够重 + 从未 spawn → 注入;spawn 过后永不再触发", () => {
    const tips = buildLoopTips({ sessionId: "w-del-1" });
    // 步数/上下文都够,但一次都没 spawn → 卡该出
    const hit = tips({ step: DYN_DELEGATE_STEP, lastStepTools: ["code_sense"], lastStepFiles: [], tokensSpent: DYN_DELEGATE_TOKENS });
    expect(hit, "step25 + 120k + 未 spawn 必须注入(信号未接线时这里是 null)").not.toBeNull();
    expect(hit!.keys).toContain("dyn:delegate");
    expect(hit!.text).toContain("动态·上下文委派");
    // once:同信号下一步不重放
    expect(tips({ step: DYN_DELEGATE_STEP + 1, lastStepTools: ["code_sense"], lastStepFiles: [], tokensSpent: DYN_DELEGATE_TOKENS })?.keys ?? []).not.toContain("dyn:delegate");
  });

  it("③b spawn 过后(即使 compact 清 fired)delegate 不再触发", () => {
    const tips = buildLoopTips({ sessionId: "w-del-2" });
    const heavy = { lastStepFiles: [] as string[], tokensSpent: DYN_DELEGATE_TOKENS };
    // 先 spawn 一次(step1)→ spawnedSubagent=true,此后不回退
    tips({ step: 1, lastStepTools: ["spawn_subagent"], ...heavy });
    // 到点也不该出(delegate 的判定是 spawnedSubagent===false)
    expect(tips({ step: DYN_DELEGATE_STEP, lastStepTools: ["code_sense"], ...heavy })?.keys ?? []).not.toContain("dyn:delegate");
    // compact 后额度清空,但步态事实不清 → 仍不触发
    expect(
      tips({ step: DYN_DELEGATE_STEP + 5, lastStepTools: ["code_sense"], ...heavy, compacts: 1 })?.keys ?? [],
    ).not.toContain("dyn:delegate");
  });

  it("④ tokens 不足 120k 不触发(步数够也一样)", () => {
    const tips = buildLoopTips({ sessionId: "w-del-3" });
    const r = tips({ step: DYN_DELEGATE_STEP + 10, lastStepTools: ["code_sense"], lastStepFiles: [], tokensSpent: DYN_DELEGATE_TOKENS - 1 });
    expect(r?.keys ?? []).not.toContain("dyn:delegate");
  });

  it("④b 步数不足 25 不触发(上下文够重也一样)", () => {
    const tips = buildLoopTips({ sessionId: "w-del-4" });
    const r = tips({ step: DYN_DELEGATE_STEP - 1, lastStepTools: ["code_sense"], lastStepFiles: [], tokensSpent: DYN_DELEGATE_TOKENS * 3 });
    expect(r?.keys ?? []).not.toContain("dyn:delegate");
    // 同序列下一步(到点)就出——证明上一步只是被步数条件挡住
    expect(tips({ step: DYN_DELEGATE_STEP, lastStepTools: ["code_sense"], lastStepFiles: [], tokensSpent: DYN_DELEGATE_TOKENS * 3 })!.keys).toContain("dyn:delegate");
  });

  it("④c ctx.tokensSpent 缺省(旧 ctx 形态)→ 视作 0,不触发", () => {
    const tips = buildLoopTips({ sessionId: "w-del-5" });
    const r = tips({ step: DYN_DELEGATE_STEP + 2, lastStepTools: ["code_sense"], lastStepFiles: [] });
    expect(r?.keys ?? []).not.toContain("dyn:delegate");
    void light;
  });
});

/* ───────────── B) 兼容与顺序:旧 ctx / key 顺序 / gate 行为不变 ───────────── */

describe("B) 兼容:旧 ctx 行为不变 + key 顺序 + gate", () => {
  it("⑤ keys 顺序不因新字段变化(既有卡相对顺序:dispatch → hypothesis → verify-stop)", () => {
    const tips = buildLoopTips({ sessionId: "w-ord-1" });
    // 造 hypothesis(连改同一文件 3 步)+ verify-stop(验证 2 轮 + 2 个错误)+ dispatch(spawn 见过)
    tips({ step: 1, lastStepTools: ["edit_file", "run_cmd"], lastStepFiles: ["a.ts"] });
    tips({ step: 2, lastStepTools: ["edit_file", "terminal"], lastStepFiles: ["a.ts"] });
    const r = tips({
      step: 3, lastStepTools: ["edit_file", "spawn_subagent", "board_upsert"], lastStepFiles: ["a.ts"],
      totalErrors: 2,
    });
    const keys = r!.keys;
    const iHyp = keys.indexOf("dyn:hypothesis");
    const iStop = keys.indexOf("dyn:verify-stop");
    expect(iHyp).toBeGreaterThanOrEqual(0);
    expect(iStop).toBeGreaterThan(iHyp); // hypothesis 在 verify-stop 之前(既有顺序不变)
    expect(keys.indexOf("dispatch")).toBe(0); // dispatch 卡在 dyn 块之前
    expect(keys.indexOf("dispatch")).toBeLessThan(iHyp); // 非 dyn 卡整体排在 dyn 块前面
    expect(keys).not.toContain("dyn:phase-align"); // 已落板
    expect(keys).not.toContain("dyn:verify-cadence"); // 本步刚验过(间隔 0)
  });

  it("⑤b 两张新卡在 dyn 块内末尾顺序排列(verify-cadence 先于 delegate)", () => {
    const tips = buildLoopTips({ sessionId: "w-ord-2" });
    tips({ step: 2, lastStepTools: ["run_cmd"], lastStepFiles: [] });
    for (let s = 3; s < DYN_VERIFY_CADENCE_STEP; s++) tips(ro(s));
    const r = tips({ step: DYN_DELEGATE_STEP, lastStepTools: ["code_sense"], lastStepFiles: [], tokensSpent: DYN_DELEGATE_TOKENS });
    const keys = r!.keys;
    expect(keys).toContain("dyn:verify-cadence");
    expect(keys).toContain("dyn:delegate");
    expect(keys.indexOf("dyn:verify-cadence")).toBeLessThan(keys.indexOf("dyn:delegate"));
  });

  it("⑤c gate 10k 间隔与 once 语义不变:同卡 fired 后即使水位够了也不重放", () => {
    const tips = buildLoopTips({ sessionId: "w-ord-3" });
    const gate = { check: () => true, lastTokens: () => undefined, reset: () => {} };
    const sig = { lastStepFiles: [] as string[], tokensSpent: DYN_DELEGATE_TOKENS, gate };
    expect(tips({ step: DYN_DELEGATE_STEP, lastStepTools: ["code_sense"], ...sig })!.keys).toContain("dyn:delegate");
    // 水位全放行也不重放(once)
    expect(
      tips({ step: DYN_DELEGATE_STEP + 1, lastStepTools: ["code_sense"], ...sig, tokensSpent: DYN_DELEGATE_TOKENS * 5 })?.keys ?? [],
    ).not.toContain("dyn:delegate");
  });

  it("⑥ 旧 ctx(不带 tokensSpent/gate/phase 等新字段)行为与改动前一致:纯只读不注入", () => {
    const tips = buildLoopTips({ sessionId: "w-legacy" });
    // 旧形态:只有 step/lastStepTools/totalErrors/lastStepFiles(两个只读探测 → 不触发并行提醒)
    for (let s = 1; s <= 5; s++) {
      expect(tips({ step: s, lastStepTools: ["grep", "glob"], lastStepFiles: [] })).toBeNull();
    }
    // 旧形态的 hypothesis 仍按原口径触发(闭包信号不受新字段影响)
    tips({ step: 6, lastStepTools: ["edit_file"], lastStepFiles: ["x.ts"] });
    tips({ step: 7, lastStepTools: ["edit_file"], lastStepFiles: ["x.ts"] });
    const r = tips({ step: 8, lastStepTools: ["edit_file"], lastStepFiles: ["x.ts"] });
    expect(r?.keys).toContain("dyn:hypothesis");
  });

  it("⑥b GENIE_TIPS=off 仍全关(新卡也压住)", () => {
    process.env.GENIE_TIPS = "off";
    const tips = buildLoopTips({ sessionId: "w-off" });
    tips({ step: 2, lastStepTools: ["run_cmd"], lastStepFiles: [] });
    for (let s = 3; s < DYN_VERIFY_CADENCE_STEP; s++) tips(ro(s));
    expect(tips({ step: DYN_DELEGATE_STEP, lastStepTools: ["code_sense"], lastStepFiles: [], tokensSpent: DYN_DELEGATE_TOKENS })).toBeNull();
  });
});
