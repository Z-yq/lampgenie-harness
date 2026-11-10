/**
 * 轨迹看板(step-1020)契约测试 —— PAGE 源码字符串断言 + 真函数求值。
 *
 * 取码 harness 照抄 panel-trajectory.test.ts / panel-ide-deep.test.ts:面板是单 HTML 模板字符串,
 * 浏览器侧函数就在源码里,从 GET / 拿真 HTML → 正则/配平截取函数源码 → new Function 求值后断言
 * 「真函数真渲染」,不是只看源码里有没有这几个字。
 *
 * 覆盖:
 *  ①骨架锚点(overlay / 两处入口 / 过滤 chip 四值 / 搜索框 / 复制按钮 / inspector)
 *  ②汇总条 10 项口径词全在场
 *  ③PAGE 无 emoji(正则与白名单照抄 panel.test.ts)
 *  ④TRAJ_MODEL_JS 注入串可执行:1600 条合成事件 → capTrajRows 1500 行 + truncated=true
 *  ⑤行表渲染函数:含 error 行 → 产物带错误态 class 与错误文本
 *  ⑥渲染产物串无 emoji
 *  ⑦规模上限提示条显式出现(不静默截断)
 */
import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";
import { TRAJ_MODEL_JS, TRAJ_ROW_CAP } from "../src/panel-traj-model.js";

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

/** esc 同语义(抽取段依赖它)。 */
function escT(s: unknown): string {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * 把注入串 + 抽取到的渲染函数源码放进同一函数体求值(等同浏览器侧同一脚本作用域的可见性)。
 * 注入串提供 esc 之外的 fmtTokens/fmtDuration/capTrajRows/TRAJ_ROW_CAP 等。
 */
function loadFromPage(html: string, names: string[]): Record<string, any> {
  const srcs = names.map((n) => extractFn(html, n)).join(String.fromCharCode(10));
  const body = "function esc(s){return String(s==null?'':s)"
    + ".replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');}"
    + String.fromCharCode(10) + TRAJ_MODEL_JS + String.fromCharCode(10) + srcs
    + String.fromCharCode(10) + "return {" + names.join(",") + "};";
  // eslint-disable-next-line no-new-func
  return new Function(body)() as Record<string, any>;
}

// emoji 门:正则与白名单照抄 panel.test.ts(单色排版符号白名单,不是彩色 emoji)
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{2300}-\u{23FF}]/u;
const ALLOW = new Set(["✓", "✗", "✕", "→", "←", "↑", "↓", "↵", "⇤", "⇥", "↳", "⎇", "■", "»", "…", "⚠", "☰", "♥", "⚙", "⌕", "⌄", "◇", "▶", "●", "▤", "◈", "▣", "✂"]);
function emojiBad(s: string): string[] {
  return [...s].filter((ch) => EMOJI.test(ch) && !ALLOW.has(ch));
}

/** 合成事件:1600 条(user/model 交替),用于规模上限与注入串可执行性。 */
function syntheticEvents(n: number): unknown[] {
  const out: unknown[] = [];
  for (let i = 1; i <= n; i++) {
    if (i % 4 === 1) out.push({ seq: i, kind: "message.user", time: i * 10, sessionId: "s1", payload: { text: "第" + i + "条" } });
    else if (i % 4 === 2) out.push({ seq: i, kind: "llm.trace", time: i * 10, sessionId: "s1", payload: { turn: 1 + Math.floor(i / 40), step: i, model: "m", durationMs: 12, usage: { inputTokens: 100, cachedTokens: 90, outputTokens: 10 } } });
    else if (i % 4 === 3) out.push({ seq: i, kind: "tool.call", time: i * 10, sessionId: "s1", payload: { toolCallId: "c" + i, name: "read_file", arguments: "{}", turn: 1 + Math.floor(i / 40) } });
    else out.push({ seq: i, kind: "tool.result", time: i * 10, sessionId: "s1", payload: { toolCallId: "r" + i, name: "read_file", content: "ok", durationMs: 3, turn: 1 + Math.floor(i / 40) } });
  }
  return out;
}

describe("轨迹看板(step-1020)①骨架锚点", () => {
  it("独立视图(step-1535:#view-traj 内常驻,不再是全屏 overlay)/两处入口/过滤四值/搜索/复制/inspector 全在场", async () => {
    await withPanel(7893, (html) => {
      expect(html).toContain('id="view-traj"');           // 载体:独立视图
      expect(html).toContain('id="trajBoard"');           // 视图内保留容器 id(三 host 的锚点)
      expect(html).toContain('id="trajBoardBtn"');       // 入口 1:composer pill
      expect(html).toContain("data-traj-open");           // 入口 2:轨迹卡 summary
      expect(html).toContain('id="trajSearch"');
      expect(html).toContain('id="trajCopyPath"');
      expect(html).toContain('id="trajInsp"');
      // 三 pane host 同屏在场(step-1535):决策卡 / 事件账本 / 泳道
      expect(html).toContain('id="trajCardsHost"');
      expect(html).toContain('id="trajRowsHost"');
      expect(html).toContain('id="trajLanesHost"');
      expect(html).toContain('id="trajLaneSum"');
      expect(html).toContain('id="trajViewRefresh"');     // 视图头刷新(原浮层关闭按钮的位置)
      // 全屏 overlay 形态已取消:不再有 position:fixed 的 .traj-board 规则,也没有关闭按钮
      expect(html).not.toContain(".traj-board{position:fixed");
      expect(html).not.toContain("trajBoardClose");
      // 过滤 chip 四个值全在场
      for (const m of ["all", "model", "tool", "error"]) {
        expect(html).toContain('data-traj-mode="' + m + '"');
      }
      // pane chip 三值 + 泳道模式 chip 三值(step-1535)
      for (const p of ["decisions", "ledger", "lanes"]) {
        expect(html).toContain('data-traj-pane="' + p + '"');
      }
      for (const lm of ["sequence", "duration", "time"]) {
        expect(html).toContain('data-traj-lmode="' + lm + '"');
      }
      // 轨迹卡保留:summary 补了「看板」,且 handler 走 preventDefault/stopPropagation(点它不展开 details)
      const card = extractFn(html, "trajCardHtml");
      expect(card).toContain('data-traj-open="1"');
      expect(html).toContain('const open = t.closest("[data-traj-open]")');
      expect(html).toContain("e.preventDefault()");
      expect(html).toContain("e.stopPropagation()");
      // 入口一律改走视图路由:不再有 trajBoardOpen 调用
      expect(html).not.toContain("trajBoardOpen(");
      expect(html).not.toContain("trajBoardClose(");
      expect(html).toContain('switchView("traj")');
      // DOM 顺序:轨迹视图容器在 #boardFloat 之前(插在 #view-track 之后)
      const iTraj = html.indexOf('id="trajBoard"'), iFloat = html.indexOf('id="boardFloat"');
      const iTrack = html.indexOf('id="view-track"'), iView = html.indexOf('id="view-traj"');
      expect([iTrack, iView, iTraj, iFloat], "顺序锚点:" + [iTrack, iView, iTraj, iFloat].join(",")).not.toContain(-1);
      expect(iTraj).toBeLessThan(iFloat);
      expect(iTrack).toBeLessThan(iView);
    });
  }, 30_000);

  it("②汇总条 10 项口径词全部在场", async () => {
    await withPanel(7894, (html) => {
      const fn = loadFromPage(html, ["trajBoardSumHtml"]);
      const out = fn.trajBoardSumHtml({
        calls: 7, turns: 2, inputTokens: 1500, outputTokens: 90, cachedTokens: 1425, cacheHitRate: 0.95,
        tools: 3, errors: 1, wallMs: 65_000, localScores: 2, prunes: 4, rows: 20,
      });
      // 词表:调用数/轮数/输入/输出/缓存命中率/工具数/错误数/墙钟/本地评分/剪枝
      for (const w of ["调用数", "轮数", "输入", "输出", "缓存命中率", "工具数", "错误数", "墙钟", "本地评分", "剪枝"]) {
        expect(out, "汇总条缺词:" + w).toContain(w);
      }
      // 精确值:命中率一位小数百分比 + token 速览 + 耗时速览
      expect(out).toContain("95.0%");
      expect(out).toContain("1.5K");
      expect(out).toContain("1m05s");
      expect(out).toContain(">7<");
      expect(out).toContain(">2<");
    });
  }, 30_000);
});

describe("轨迹看板(step-1020)②注入串可执行 + 行表渲染", () => {
  it("④1600 条合成事件 → capTrajRows 返回最近 1500 行且 truncated=true", async () => {
    // 直接在 node 侧求值注入串:任何 ReferenceError 都会在这里炸
    // eslint-disable-next-line no-new-func
    const api = new Function(TRAJ_MODEL_JS + String.fromCharCode(10)
      + "return {buildTrajRows:buildTrajRows,capTrajRows:capTrajRows,groupTrajTurns:groupTrajTurns,"
      + "summarizeTraj:summarizeTraj,filterTrajRows:filterTrajRows,fmtTokens:fmtTokens,fmtDuration:fmtDuration,"
      + "TRAJ_ROW_CAP:TRAJ_ROW_CAP};")() as Record<string, any>;
    expect(api.TRAJ_ROW_CAP).toBe(1500);
    expect(api.TRAJ_ROW_CAP).toBe(TRAJ_ROW_CAP);
    const rows = api.buildTrajRows(syntheticEvents(1600));
    expect(rows.length).toBeGreaterThan(1500);
    const cap = api.capTrajRows(rows);
    expect(cap.rows.length).toBe(1500);
    expect(cap.truncated).toBe(true);
    expect(cap.total).toBe(rows.length);
    // 保留的是**最近**的一批:末行 seq = 最后一条事件
    expect(cap.rows[cap.rows.length - 1].seq).toBe(1600);
    // 汇总/过滤也在注入串里能跑(数据层闭环)
    const turns = api.groupTrajTurns(rows);
    const sum = api.summarizeTraj(rows, turns);
    expect(sum.rows).toBe(rows.length);
    expect(sum.turns).toBeGreaterThan(1);
    expect(api.filterTrajRows(rows, "tool").every((r: any) => r.kind === "tool")).toBe(true);
  }, 30_000);

  it("⑤含 error 行 → 行表产物带错误态 class 与错误文本;⑥产物无 emoji", async () => {
    await withPanel(7895, (html) => {
      const fn = loadFromPage(html, ["trajBoardRowHtml", "trajBoardTableHtml", "trajBoardTurnHeadHtml", "trajBoardInspHtml"]);
      const rows = [
        { seq: 1, idx: 0, turn: 1, kind: "user", label: "user", summary: "修一下 panel.ts", at: 1000, status: "ok" },
        { seq: 2, idx: 1, turn: 1, kind: "tool", label: "read_file", summary: "read a.ts", at: 1100, durationMs: 150, status: "ok", toolName: "read_file", toolCallId: "c1" },
        { seq: 3, idx: 2, turn: 1, kind: "model", label: "claude-x", summary: "t1s1", at: 1300, durationMs: 500, inputTokens: 1234, cachedTokens: 1200, outputTokens: 60, status: "error", error: "provider 429 too many requests" },
      ];
      const one = fn.trajBoardRowHtml(rows[2]);
      expect(one).toContain('class="tb-row err"');        // 错误态 class
      expect(one).toContain('class="st err"');
      expect(one).toContain("provider 429 too many requests"); // 错误文本可见(不是只藏在 title)
      // 正常行不带 err
      const ok = fn.trajBoardRowHtml(rows[1]);
      expect(ok).not.toContain("tb-row err");
      expect(ok).toContain('class="st"');
      // 行表:轮头 + 8 列表头 + 每行 data-idx
      const table = fn.trajBoardTableHtml(rows, [{ turn: 1, wallMs: 300, calls: 1, toolHistogram: [{ name: "read_file", count: 1 }] }]);
      expect(table).toContain('class="tb-hd"');
      expect(table).toContain('class="tb-trhead"');
      expect(table).toContain("第 1 轮");
      expect(table).toContain("墙钟 300ms");
      expect(table).toContain("read_file×1");
      expect(table).toContain('data-idx="0"');
      expect(table).toContain('data-idx="2"');
      // inspector:全部字段 + 错误文本单独一行
      const insp = fn.trajBoardInspHtml(rows[2]);
      for (const w of ["序号", "轮", "类型", "标签", "摘要", "耗时", "输入", "缓存", "输出", "状态", "工具名", "toolCallId"]) {
        expect(insp, "inspector 缺字段:" + w).toContain(w);
      }
      expect(insp).toContain('class="errtext"');
      expect(insp).toContain("provider 429 too many requests");
      expect(fn.trajBoardInspHtml(null)).toContain("点一行看明细");
      // ⑥两类产物串都不得含 emoji
      expect(emojiBad(table)).toEqual([]);
      expect(emojiBad(insp)).toEqual([]);
    });
  }, 30_000);

  it("⑦>1500 行时表头显式提示(不静默截断);空态/无匹配也不空白", async () => {
    await withPanel(7896, (html) => {
      const fn = loadFromPage(html, ["trajBoardTableHtml", "trajBoardRowHtml", "trajBoardTurnHeadHtml"]);
      // 构造 1600 行(列字段最小集)
      const many: any[] = [];
      for (let i = 0; i < 1600; i++) many.push({ seq: i + 1, idx: i, turn: 1 + Math.floor(i / 100), kind: "user", label: "user", summary: "e" + i, at: 1000 + i, status: "ok" });
      const out = fn.trajBoardTableHtml(many, [{ turn: 16, wallMs: 1, calls: 0, toolHistogram: [] }]);
      expect(out).toContain("仅显示最近 1500 行");
      expect(out).toContain("共 1600 行");
      expect(out).toContain("完整数据请查看轨迹文件");
      // 只渲染 1500 行(data-idx 出现次数)
      const hits = out.match(/data-idx="/g) || [];
      expect(hits.length).toBe(1500);
      // 空输入不出空壳
      expect(fn.trajBoardTableHtml([], [])).toContain("没有匹配的行");
      // 提示条文案本身也不得含 emoji
      expect(emojiBad(out)).toEqual([]);
    });
  }, 30_000);
});

describe("轨迹看板(step-1020)③PAGE 零 emoji", () => {
  it("整页 HTML 无彩色 emoji(白名单=单色排版符号)", async () => {
    await withPanel(7897, (html) => {
      const bad = emojiBad(html);
      expect(bad, "页面含 emoji: " + [...new Set(bad)].join(" ")).toEqual([]);
    });
  }, 30_000);
});
