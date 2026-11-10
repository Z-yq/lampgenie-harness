/**
 * SOP 行式卡恰时注入(2026-11 tips SOP 化)契约:
 * - phase 首见即注入对应阶段卡(understand/plan/implement/close),一次为限;
 * - 无新 phase 卡但上一步工具带错(lastStepError)→ 排障卡兜底一次;
 * - compact 计数增长 → fired 清空,允许重注入一次(与 dispatch 同语义);
 * - 不存在 verify 卡(验收四步已由 task_phase(verify) 回执送达,重复=违 N3 教训);
 * - 未带 phase 的旧 ctx 形态 → 零 SOP 注入(旧调用方零行为变化);
 * - GENIE_TIPS=off 全关(含 SOP 分支)。
 */
import { it, expect, afterEach } from "vitest";
import { buildLoopTips } from "../src/agent-wiring.js";
import { SOP_TIPS, SOP_TIP_MAX_LINES, SOP_SURFACE_TIPS, sopTipText } from "../src/agent-wiring-sop-tips.js";

const txt = (r: { text: string } | null) => (r ? r.text : null);

afterEach(() => { delete process.env.GENIE_TIPS; });

it("SOP_TIPS:每张卡行数 ≤ SOP_TIP_MAX_LINES(行式卡防膨胀)", () => {
  for (const [k, lines] of Object.entries(SOP_TIPS) as [string, readonly string[]][]) {
    expect(lines.length, `卡 ${k}`).toBeLessThanOrEqual(SOP_TIP_MAX_LINES);
    expect(lines.length, `卡 ${k} 至少有标题+动作行`).toBeGreaterThanOrEqual(2);
    expect(lines[0], `卡 ${k} 标题行`).toMatch(/^SOP·/);
    // 行式短句:动作行动词开头(以「先/实/单/多/规/小/无/变/不/同/修/三/事/P0/候/方/设」等
    // 动词/判断词开头的短句;这里只锚定非空+不以 Markdown 列表符开头——行式卡不是列表渲染)
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i], `卡 ${k} 第 ${i + 1} 行`).not.toMatch(/^[-*#\s]/);
      expect(lines[i]!.length, `卡 ${k} 第 ${i + 1} 行短句`).toBeLessThan(80);
    }
    expect(sopTipText(k)).toBe(lines.join("\n"));
  }
});

it("SOP_TIPS:不存在 verify 卡(验收四步已由 task_phase(verify) 回执送达,重复=违 N3)", () => {
  expect(SOP_TIPS.verify).toBeUndefined();
  expect(Object.keys(SOP_TIPS).sort()).toEqual(["close", "debug", "implement", "plan", "understand"]);
});

it("phase 首见恰时注入:understand 首调注入(含「SOP·理解」,keys 含 sop:understand);同 phase 二调不注入;phase 变 plan 再注入;compact 后允许重注入一次", () => {
  let phase: string | undefined = "understand";
  const tips = buildLoopTips({ sessionId: "sop-s1", getPhase: () => phase });
  const r1 = tips({ step: 1, lastStepTools: [] });
  expect(txt(r1)).toContain("SOP·理解");
  expect(txt(r1)).toContain("<system-reminder>");
  expect(r1?.keys).toContain("sop:understand");
  // 同 phase 二调:一次为限,不注入
  expect(tips({ step: 2, lastStepTools: [] })).toBeNull();
  expect(tips({ step: 3, lastStepTools: [] })).toBeNull();
  // phase 变 plan → 注入 plan 卡
  phase = "plan";
  const r2 = tips({ step: 4, lastStepTools: [] });
  expect(txt(r2)).toContain("SOP·规划");
  expect(r2?.keys).toContain("sop:plan");
  expect(tips({ step: 5, lastStepTools: [] })).toBeNull();
  // verify 阶段:无卡,零注入(红线:不做 verify 卡)
  phase = "verify";
  expect(tips({ step: 6, lastStepTools: [] })).toBeNull();
  // compact 计数增长 → fired 清空,plan 卡允许重注入一次
  phase = "implement";
  const r3 = tips({ step: 7, lastStepTools: [], compacts: 1 });
  expect(txt(r3)).toContain("SOP·实施");
  expect(r3?.keys).toContain("sop:implement");
  // compact 后同 phase 二调:一次为限
  expect(tips({ step: 8, lastStepTools: [], compacts: 1 })).toBeNull();
});

it("ctx.phase 直通道:不带 deps.getPhase 的 ctx.phase 同样注入(loop tipsPhase 通道等价)", () => {
  const tips = buildLoopTips({ sessionId: "sop-s2" });
  const r = tips({ step: 1, lastStepTools: [], phase: "close" });
  expect(txt(r)).toContain("SOP·收尾");
  expect(r?.keys).toContain("sop:close");
});

it("旧调用零行为变化:不带 phase 的 ctx 不注入任何 SOP 卡(也不吃 deps.getPhase 兜底)", () => {
  // 旧调用方形态:buildLoopTips({sessionId}) 且 ctx 无 phase 字段
  const tips = buildLoopTips({ sessionId: "sop-s3" });
  expect(tips({ step: 1, lastStepTools: [] })).toBeNull();
  expect(tips({ step: 2, lastStepTools: ["edit_file", "code_sense"] })).toBeNull();
  // deps.getPhase 未接(装配方旧写法)= 零注入,即使 loop 侧 ctx.phase 恒 undefined
  const tips2 = buildLoopTips({ sessionId: "sop-s4", getPhase: () => undefined });
  expect(tips2({ step: 1, lastStepTools: [] })).toBeNull();
});

it("lastStepError=true(且无新 phase 卡)→ 注入 sop:debug 一次;再 lastStepError=true 不再注入;compact 后重注入一次", () => {
  let phase: string | undefined;
  const tips = buildLoopTips({ sessionId: "sop-s5", getPhase: () => phase });
  const r1 = tips({ step: 1, lastStepTools: ["run_cmd"], lastStepError: true });
  expect(txt(r1)).toContain("SOP·排障");
  expect(r1?.keys).toContain("sop:debug");
  // 再带错:一次为限
  expect(tips({ step: 2, lastStepTools: ["run_cmd"], lastStepError: true })).toBeNull();
  expect(tips({ step: 3, lastStepTools: ["run_cmd"], lastStepError: true })).toBeNull();
  // 有新 phase 卡时 phase 优先(debug 兜底只在无新 phase 卡时触发)
  phase = "plan";
  const r2 = tips({ step: 4, lastStepTools: [], lastStepError: true });
  expect(r2?.keys).toContain("sop:plan");
  expect(r2?.keys).not.toContain("sop:debug");
  // compact 后:debug 允许重注入一次
  phase = undefined;
  const r3 = tips({ step: 5, lastStepTools: ["run_cmd"], lastStepError: true, compacts: 1 });
  expect(txt(r3)).toContain("SOP·排障");
  expect(r3?.keys).toContain("sop:debug");
});

it("GENIE_TIPS=off 全关(含 SOP 分支)", () => {
  process.env.GENIE_TIPS = "off";
  const tips = buildLoopTips({ sessionId: "sop-s6", getPhase: () => "understand" });
  expect(tips({ step: 1, lastStepTools: [] })).toBeNull();
  expect(tips({ step: 2, lastStepTools: [], lastStepError: true })).toBeNull();
});

// ---- 全链路变更覆盖卡(2026-11-06) ----
it("SOP_SURFACE_TIPS:只覆盖 plan/close 两阶段,每卡 ≤ SOP_TIP_MAX_LINES", () => {
  expect(Object.keys(SOP_SURFACE_TIPS).sort()).toEqual(["close", "plan"]);
  for (const [k, lines] of Object.entries(SOP_SURFACE_TIPS) as [string, readonly string[]][]) {
    expect(lines.length, `覆盖卡 ${k}`).toBeLessThanOrEqual(SOP_TIP_MAX_LINES);
    expect(lines[0]).toMatch(/^SOP·/);
    for (let i = 1; i < lines.length; i++) expect(lines[i]!.length, `覆盖卡 ${k} 第 ${i + 1} 行`).toBeLessThan(80);
  }
});

it("surface 任务:plan 卡换成盘点 SOP(含「盘点」),close 卡换成残留审计卡(含「审计」);普通任务用原卡", () => {
  const surfaceTips = buildLoopTips({ sessionId: "sop-surf-1", getPhase: () => "plan", changeScope: () => "surface" });
  const planTxt = txt(surfaceTips({ step: 1, lastStepTools: [] })) ?? "";
  expect(planTxt).toContain("SOP·全链路");
  expect(planTxt).toContain("盘点");
  expect(planTxt).not.toContain("SOP·规划");

  const closeTips = buildLoopTips({ sessionId: "sop-surf-2", getPhase: () => "close", changeScope: () => "surface" });
  const closeTxt = txt(closeTips({ step: 1, lastStepTools: [] })) ?? "";
  expect(closeTxt).toContain("SOP·全链路收尾");
  expect(closeTxt).toContain("audit");

  // 普通任务(changeScope=normal / 未接)不受影响
  const normalTips = buildLoopTips({ sessionId: "sop-surf-3", getPhase: () => "plan", changeScope: () => "normal" });
  expect(txt(normalTips({ step: 1, lastStepTools: [] }))).toContain("SOP·规划");
});

it("surface 覆盖卡不扩到其它阶段:implement 仍是原卡(不新增匹配式 tips、不越阶段)", () => {
  const tips = buildLoopTips({ sessionId: "sop-surf-4", getPhase: () => "implement", changeScope: () => "surface" });
  const t = txt(tips({ step: 1, lastStepTools: [] })) ?? "";
  expect(t).toContain("SOP·实施");
  expect(t).not.toContain("SOP·全链路");
});
