/**
 * 面板 usage 双口径显示层契约测试。
 * 取码范式照抄 panel-trace-full.test.ts:面板是单 HTML 模板字符串,浏览器侧函数就在源码里 ——
 * GET / 拿真 HTML → 花括号配平抽函数源码 → 与 TRAJ_MODEL_JS 一起 new Function 求值,
 * 断「真函数真渲染」而不是源码里有没有这几个字。
 * 覆盖(逐条):
 * ①卡头主数字=API 经验证 usage(输入/缓存原值,命中率=cached/input);本地估算只作次级「估算 Z(触发用)」;
 *    usageSuspect 只出「上游usage异常」徽标(title 带 anomaly 原文),不改写主数字(85.8% 也照显示);
 *    input=0/缺值 → 「输入 —」(不写 0%)。无估算的旧行 → 同一 API 形态,不出估算/徽标
 *  ②汇总条:输入/命中率主值=API 合计(input=0 → 「—」),估算单列「估算(触发用)」,「异常 N」保留
 *  ③prune 卡:有 context.prune → 决策视图出 prune 卡(含项数/节省 tok/原因);没有 → 不出
 *  ④回落:旧 llm.trace(仅 usage)与旧 trace.stats(无 contextTokensReported)→ 渲染与旧文案一致、不抛错
 *  ⑤零 emoji(正则与白名单照抄 panel-trace-full.test.ts)
 */
import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";
import { TRAJ_MODEL_JS } from "../src/panel-traj-model.js";

const NL = String.fromCharCode(10);

/** 从面板 HTML 里切出顶层函数源码(花括号配平)。 */
function extractFn(html: string, name: string): string {
  const head = "function " + name + "(";
  const i = html.indexOf(head);
  expect(i, "未找到函数 " + name).toBeGreaterThan(0);
  let depth = 0, started = false, j = i;
  for (; j < html.length; j++) {
    const c = html[j];
    if (c === "{") { depth++; started = true; }
    else if (c === "}") { depth--; if (started && depth === 0) { j++; break; } }
  }
  return html.slice(i, j);
}

async function withPanel<T>(port: number, fn: (html: string) => T | Promise<T>): Promise<T> {
  const srv = servePanel(port, () => { /* 纯静态:不接 WS */ });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    return await fn(await res.text());
  } finally {
    await srv.close();
  }
}

const CARD_FNS = [
  "trajNumOrNull", "decorateTrajUsage", "trajBoardUsageTotals", "trajPruneItems",
  "trajBoardSumHtml", "trajBoardTurnHeadHtml", "trajBoardCardHeadHtml", "trajBoardThinkHtml",
  "trajBoardArgsText", "trajBoardBodyHtml", "trajBoardCardHtml", "trajBoardPruneCardHtml",
  "trajBoardCardsHtml", "filterDecisionRows", "trajBoardPrevFile", "trajBoardCardState",
];

/** 抽卡片渲染族 + 注入数据层,放进同一函数作用域求值(等同浏览器侧可见性)。 */
function loadCardFns(html: string): Record<string, any> {
  const srcs = CARD_FNS.map((n) => extractFn(html, n)).join(NL);
  const body = "function esc(s){return String(s==null?'':s)"
    + ".replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');}" + NL
    + "const trajBoardState={rows:[],turns:[],view:[],files:[],ord:{},q:'',mode:'all',pane:'decisions',prunes:[]};" + NL
    + "const trajExpanded=new Set();const trajTraceCache=new Map();" + NL
    + "const TRAJ_THINK_CAP=600;const TRAJ_EXPAND_ALL_MAX=30;" + NL
    + TRAJ_MODEL_JS + NL + srcs + NL
    + "return {" + CARD_FNS.join(",") + ",trajBoardState};";
  // eslint-disable-next-line no-new-func
  return new Function(body)() as Record<string, any>;
}

/** 抽 pill 侧函数(需要 traceStats/currentSid/histEvents/ic/$ 这些页面态,给最小替身)。 */
function loadPillFns(html: string, stats: Record<string, unknown>, events: unknown[] = []): Record<string, any> {
  const names = ["trajNumOrNull", "ctxUsageNorm", "ctxTok", "ctxStats", "ctxPillMenuHtml", "ctxPillRender"];
  const srcs = names.map((n) => extractFn(html, n)).join(NL);
  const body = "function esc(s){return String(s==null?'':s)"
    + ".replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');}" + NL
    + "function ic(){return '<svg></svg>';}" + NL
    + "const el={textContent:''};function $(id){return id==='ctxPill'?el:null;}" + NL
    + "const currentSid='sess-1';const histEvents=" + JSON.stringify(events) + ";" + NL
    + "const traceStats=" + JSON.stringify(stats) + ";" + NL
    + srcs + NL
    + "return {" + names.join(",") + ",el};";
  // eslint-disable-next-line no-new-func
  return new Function(body)() as Record<string, any>;
}

// emoji 门:正则与白名单照抄 panel-trace-full.test.ts(单色排版符号白名单,不是彩色 emoji)
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{2300}-\u{23FF}]/u;
const ALLOW = new Set(["✓", "✗", "✕", "→", "←", "↑", "↓", "↵", "⇤", "⇥", "↳", "⎇", "■", "»", "…", "⚠", "☰", "♥", "⚙", "⌕", "⌄", "◇", "▶", "●", "▤", "◈", "▣", "✂"]);
function emojiBad(s: string): string[] {
  return [...s].filter((ch) => EMOJI.test(ch) && !ALLOW.has(ch));
}

const FILE_A = "/repo/.genie/llm-trace/web-1/call-0001-t1s1-1.json";
const FILE_B = "/repo/.genie/llm-trace/web-1/call-0002-t1s2-1.json";

/** 决策行(llm.trace 摘要形状)。 */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq: 12, idx: 3, turn: 2, kind: "model", label: "claude-sonnet", summary: "t2s1 · 改好了 · 调用:2",
    at: 1000, durationMs: 1850, ttftMs: 320, inputTokens: 42500, cachedTokens: 39680, outputTokens: 228,
    status: "ok", traceFile: FILE_A, stepNo: 1, tools: ["read_file"], ...over,
  };
}

/** 新字段齐全的 llm.trace 事件(数据契约)。 */
function traceEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq: 10, kind: "llm.trace", time: 1793888000000, sessionId: "web-1",
    payload: {
      turn: 1, step: 1, model: "claude-sonnet", file: FILE_A, durationMs: 900,
      usage: { inputTokens: 120000, cachedTokens: 140000, outputTokens: 300 },
      estimatedInputTokens: 188000, estimatedCachedTokens: 150000,
      usageSuspect: true, usageAnomaly: "上报 cached 150528 > 上一步 input 111976",
      ...over,
    },
  };
}

describe("面板 usage 双口径显示层", () => {
  it("①卡头:有估算→(估)/(报)+异常徽标(title 带原文);无估算→旧形态且无 undefined/NaN", async () => {
    await withPanel(7971, (html) => {
      const fn = loadCardFns(html);
      const est = fn.decorateTrajUsage([row({ inputTokens: 111976, cachedTokens: 150528 })], [traceEvent()])[0];
      expect(est.inputTokensEst).toBe(188000);
      expect(est.cachedTokensEst).toBe(150000);
      expect(est.usageSuspect).toBe(true);
      const head = fn.trajBoardCardHeadHtml(est, 7, false);
 // 主数字 = API 经验证(input/cached 原值,命中率=cached/input),估算只在次级「估算 Z(触发用)」
      expect(head).toContain("输入 112.0K tok(缓存 150.5K,命中 134.4%)");
      expect(head).toContain("估算 188.0K(触发用)");
      expect(head).not.toContain("(估)");
      expect(head).not.toContain("(报)");
      expect(head).toContain("上游usage异常");
      expect(head).toContain("tb-suspect");
      expect(head).toContain("上报 cached 150528 &gt; 上一步 input 111976");
      expect(head).not.toContain("undefined");
      expect(head).not.toContain("NaN");
      expect(emojiBad(head)).toEqual([]);

      // 无估算(旧 journal):主数字仍=API,不出 suspect span、无 undefined/NaN
      const old = fn.decorateTrajUsage([row()], [{ seq: 10, kind: "llm.trace", payload: { file: FILE_A, usage: { inputTokens: 42500 } } }])[0];
      expect(old.inputTokensEst).toBeUndefined();
      const oldHead = fn.trajBoardCardHeadHtml(old, 7, false);
      expect(oldHead).not.toContain("上游usage异常");
      expect(oldHead).not.toContain("tb-suspect");
      expect(oldHead).not.toContain("估算");
      expect(oldHead).not.toContain("undefined");
      expect(oldHead).not.toContain("NaN");
      expect(oldHead).toContain("输入 42.5K tok(缓存 39.7K,命中 93.4%)");
      expect(emojiBad(oldHead)).toEqual([]);
    });
  }, 30_000);

  it("①b 命中率取 API 实测:94.9% / 85.8%(suspect 也照显)/ input=0 → 「—」不写 0%", async () => {
    await withPanel(7976, (html) => {
      const fn = loadCardFns(html);
      const h1 = fn.trajBoardCardHeadHtml(row({ inputTokens: 56240, cachedTokens: 53376 }), 1, false);
      expect(h1).toContain("命中 94.9%");
 // 「不可能」样本(cached > 输入)也照经验证显示,usageSuspect 只加徽标
      const h2 = fn.trajBoardCardHeadHtml(row({ inputTokens: 80457, cachedTokens: 68992, usageSuspect: true, usageAnomaly: "上报 cached 68992 > 上一步 input 70000" }), 1, false);
      expect(h2).toContain("命中 85.8%");
      expect(h2).toContain("输入 80.5K tok(缓存 69.0K,命中 85.8%)");
      expect(h2).toContain("tb-suspect");
      expect(h2).toContain("上报 cached 68992 &gt; 上一步 input 70000");
      // input=0 / 缺值 → 主数字「—」,不出命中%(不写 0%)
      const z = fn.trajBoardCardHeadHtml(row({ inputTokens: 0, cachedTokens: 0, outputTokens: 12 }), 1, false);
      expect(z).toContain("输入 —");
      expect(z).not.toContain("0%");
      expect(z).not.toContain("NaN");
      const n = fn.trajBoardCardHeadHtml(row({ inputTokens: undefined, cachedTokens: undefined, outputTokens: 12 }), 1, false);
      expect(n).not.toContain("0%");
      expect(n).not.toContain("NaN");
      expect(n).not.toContain("undefined");
      expect(emojiBad(z)).toEqual([]);
    });
  }, 30_000);

  it("②汇总条:输入/命中率主值=API 合计,估算单列「估算(触发用)」,异常 N 保留", async () => {
    await withPanel(7972, (html) => {
      const fn = loadCardFns(html);
      const rowsEst = fn.decorateTrajUsage(
        [row(), row({ idx: 4, seq: 20, traceFile: FILE_B, turn: 2 })],
        [traceEvent(), traceEvent({ file: FILE_B })],
      );
      const totals = fn.trajBoardUsageTotals(rowsEst);
      expect(totals.estRows).toBe(2);
      expect(totals.suspect).toBe(2);
      expect(totals.repInput).toBe(85000);
      const sum = { calls: 3, turns: 2, inputTokens: 85000, cachedTokens: 70000, outputTokens: 456, cacheHitRate: 0.82, tools: 4, errors: 0, wallMs: 60000, localScores: 1, prunes: 0 };
      const htmlEst = fn.trajBoardSumHtml(sum, totals);
      expect(htmlEst).toContain("输入<b>85.0K</b>");
      expect(htmlEst).toContain("缓存命中率<b>93.4%</b>");
      expect(htmlEst).toContain("估算(触发用)<b>376.0K</b>");
      expect(htmlEst).toContain("异常<b>2</b>");
      expect(htmlEst).not.toContain("(估)");
      expect(htmlEst).not.toContain("(报)");
      expect(emojiBad(htmlEst)).toEqual([]);

      // 无估算数据(旧 journal)→ 主值仍是 API 合计,只是不出「估算」项
      const legacy = Object.assign({}, sum, { cacheHitRate: 0.5 });
      const htmlOld = fn.trajBoardSumHtml(legacy, fn.trajBoardUsageTotals([row()]));
      expect(htmlOld).not.toContain("估算");
      expect(htmlOld).not.toContain("异常");
      for (const w of ["调用数", "轮数", "输入", "输出", "缓存命中率", "工具数", "错误数", "墙钟", "本地评分", "剪枝"]) {
        expect(htmlOld, "旧汇总条缺:" + w).toContain(w);
      }
      expect(htmlOld).toContain("输入<b>42.5K</b>");
      expect(htmlOld).toContain("缓存命中率<b>93.4%</b>");
      // 形参缺省(单元其它调用方)也不炸:此时走旧 a.inputTokens/a.cacheHitRate 形态
      expect(fn.trajBoardSumHtml(sum)).toContain("调用数");
      expect(fn.trajBoardSumHtml(sum)).toContain("缓存命中率<b>82.0%</b>");
      // 合计为 0(没有 API 值)→ 命中率「—」,不写 0%
      const zero = fn.trajBoardSumHtml(sum, { estRows: 0, estInput: 0, estCached: 0, repInput: 0, repCached: 0, suspect: 0 });
      expect(zero).toContain("缓存命中率<b>—</b>");
      expect(zero).not.toContain("0.0%");
    });
  }, 30_000);

  it("③prune 卡:有 context.prune→独立卡(项数/节省/原因);没有→不出现", async () => {
    await withPanel(7973, (html) => {
      const fn = loadCardFns(html);
      const pruneEv = { seq: 11, kind: "context.prune", time: 1793888000000, payload: { reason: "big", savedTokens: 500, items: [{}, {}, {}] } };
      const pruneOnly = fn.trajPruneItems([pruneEv, { seq: 1, kind: "message.user", payload: { text: "hi" } }]);
      expect(pruneOnly.length).toBe(1);
      const card = fn.trajBoardPruneCardHtml(pruneEv, 1);
      expect(card).toContain("tb-prune");
      expect(card).toContain("上下文剪枝");
      expect(card).toContain("压 3 项");
      expect(card).toContain("省 500 tok");
      expect(card).toContain("big");
      expect(card).not.toContain("policy");
      expect(card).not.toContain("undefined");
      expect(emojiBad(card)).toEqual([]);
      // policy 有才显示(当前 loop 不上报 → 省略,不造假)
      expect(fn.trajBoardPruneCardHtml(Object.assign({}, pruneEv, { payload: Object.assign({}, pruneEv.payload, { policy: "microcompact" }) }), 1)).toContain("microcompact");

      // 决策视图合流:prunes 进 trajBoardState 才出现(排序按 seq)
      const rows = [row({ seq: 12, traceFile: FILE_A })];
      fn.trajBoardState.rows = rows;
      fn.trajBoardState.prunes = [];
      fn.trajBoardState.q = "";
      fn.trajBoardState.mode = "all";
      const noPrune = fn.trajBoardCardsHtml(rows);
      expect(noPrune).not.toContain("tb-prune");
      expect(noPrune).not.toContain("上下文剪枝");
      fn.trajBoardState.prunes = fn.trajPruneItems([pruneEv]);
      const withPrune = fn.trajBoardCardsHtml(rows);
      expect(withPrune).toContain("tb-prune");
      expect(withPrune).toContain("压 3 项");
      expect(withPrune).toContain("省 500 tok");
      expect(withPrune).toContain("big");
      expect(withPrune).toContain("另有 1 次上下文剪枝");
      expect(withPrune.indexOf("tb-prune")).toBeLessThan(withPrune.indexOf("data-trace-file"));
      expect(emojiBad(withPrune)).toEqual([]);
    });
  }, 30_000);

  it("④回落:旧 trace.stats(无 contextTokensReported)→ pill 文案与旧形态一致、不抛错", async () => {
    await withPanel(7974, (html) => {
      const legacyEvents = [
        { seq: 1, kind: "message.user", payload: { text: "把轨迹看板做成逐次决策平铺" } },
        { seq: 2, kind: "message.agent", payload: { text: "改好了", usage: { inputTokens: 42500, outputTokens: 228 } } },
      ];
      // 旧 trace.stats:只有 contextWindow + 旧字段(无 contextTokens/contextTokensReported)
      const fnOld = loadPillFns(html, { "sess-1": { contextWindow: 200000 } }, legacyEvents);
      const nOld = fnOld.ctxUsageNorm("sess-1");
      expect(nOld.est).toBeNull();
      expect(nOld.rep).toBeNull();
      fnOld.ctxPillRender();
      expect(fnOld.el.textContent).toBe("上下文 2 条 · 42.5k/200k tok · 21%");
      expect(fnOld.ctxPillMenuHtml({ users: 1, agents: 1, tools: 0, chars: 400, est: 100, realIn: 42500, realOut: 228, cumIn: 42500, cumOut: 228 }))
        .toContain("当前上下文(最近一次调用实测)");
      // 旧 llm.trace(仅 usage,无估算字段)→ 卡头保持现状
      const fn = loadCardFns(html);
      const legacyRow = fn.decorateTrajUsage([row()], [{ seq: 9, kind: "llm.trace", payload: { file: FILE_A, usage: { inputTokens: 42500, cachedTokens: 39680, outputTokens: 228 } } }])[0];
      expect(fn.trajBoardCardHeadHtml(legacyRow, 1, false)).toContain("输入 42.5K tok");
      expect(fn.trajBoardUsageTotals([legacyRow]).estRows).toBe(0);
    });
  }, 30_000);

  it("⑤新 trace.stats:当前上下文主值=API 实测,本地估算作次级「估算 Z(触发用)」;非法值不产 NaN", async () => {
    await withPanel(7975, (html) => {
      const fnNew = loadPillFns(html, { "sess-1": { contextWindow: 200000, contextTokens: 150528, contextTokensReported: 150528, contextTokensEst: 188000 } }, [{ seq: 1, kind: "message.user", payload: { text: "hi" } }]);
      const n = fnNew.ctxUsageNorm("sess-1");
      expect(n.rep).toBe(150528);
      expect(n.est).toBe(188000);
      fnNew.ctxPillRender();
      expect(fnNew.el.textContent).toBe("上下文 1 条 · 150.5k tok/200k · 75%,估算 188k(触发用)");
      expect(fnNew.el.textContent).not.toContain("(估)");
      const menu = fnNew.ctxPillMenuHtml({ users: 1, agents: 0, tools: 0, chars: 10, est: 2, realIn: 0, realOut: 0, cumIn: 0, cumOut: 0 });
      expect(menu).toContain("当前上下文(最近一次调用实测):<b>150528</b> tok");
      expect(menu).toContain("本地估算 188000 tok(触发用)");
      expect(emojiBad(fnNew.el.textContent)).toEqual([]);
      // 压缩后无 API 值(contextEstimated)→ 主值退回本地估算,不重复后缀
      const fnEst = loadPillFns(html, { "sess-1": { contextWindow: 200000, contextTokensEst: 188000, contextEstimated: true } }, [{ seq: 1, kind: "message.user", payload: { text: "hi" } }]);
      const nEst = fnEst.ctxUsageNorm("sess-1");
      expect(nEst.rep).toBeNull();
      expect(nEst.est).toBe(188000);
      expect(nEst.estimated).toBe(true);
      fnEst.ctxPillRender();
      expect(fnEst.el.textContent).toBe("上下文 1 条 · 188k tok/200k · 94%");
      // 完全没有 trace.stats(旧会话)→ 同样不炸,渲染回旧形态
      const fnNone = loadPillFns(html, {}, [{ seq: 1, kind: "message.user", payload: { text: "hi" } }]);
      expect(fnNone.ctxUsageNorm("sess-1").est).toBeNull();
      expect(fnNone.ctxUsageNorm("sess-1").rep).toBeNull();
      fnNone.ctxPillRender();
      expect(fnNone.el.textContent).toBe("上下文 1 条");
      // 非法的估算值(null/字符串)→ 当缺失,不产 NaN
      const fn = loadCardFns(html);
      const bad = fn.decorateTrajUsage([row()], [{ seq: 9, kind: "llm.trace", payload: { file: FILE_A, estimatedInputTokens: "abc", estimatedCachedTokens: null } }])[0];
      expect(bad.inputTokensEst).toBeUndefined();
      expect(fn.trajBoardCardHeadHtml(bad, 1, false)).not.toContain("NaN");
    });
  }, 30_000);
});
