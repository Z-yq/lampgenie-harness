/**
 * 「轨迹」独立看板视图 #view-traj 契约(step-1535)。
 *
 * 用户口径:轨迹要成为**独立看板视图**(逐次决策 + 事件账本 + 泳道三 pane 同屏),唯一数据源 = histEvents;
 * 不再是「追踪 Trace」里的入口 + #sw-trace / #trajBoard 全屏浮层。
 *
 * 本文件守四件事(每件都是用户可感的行为,不是实现细节):
 *   ① 载体与结构:true 视图 #view-traj + 三 host + 视图头刷新 + 侧栏 act-traj + 注册表(CV_CARDS/VIEW_NAMES);
 *      负面:不再有 position:fixed 的全屏 .traj-board 规则、不再有 trajBoardOpen/trajBoardClose;
 *   ② 入口改路由:composer pill / 轨迹卡「看板」/ 侧栏都落到 switchView("traj");
 *   ③ 页面内联 <script> 全部可被 new Script 解析(删代码不引入语法错,整页脚本仍能执行);
 *   ④ 泳道纯函数行为:histEvents 三泳道 + turn 分隔线;老会话事件没有 time 时按 seq 兜底,不产生 NaN(R1 闭环)。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { servePanel } from "../src/panel.js";

const PORT = 7899;

async function panelHtml(): Promise<string> {
  const srv = servePanel(PORT, () => { /* 纯静态:不接 WS */ });
  try {
    return await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
  } finally {
    await srv.close();
  }
}

/** 从面板 HTML 里切出顶层函数源码(花括号配平)——与 panel-traj-board.test.ts 同法。 */
function extractFn(html: string, name: string): string {
  const head = "function " + name + "(";
  const i = html.indexOf(head);
  if (i < 0) throw new Error("未找到函数 " + name);
  let depth = 0, started = false, j = i;
  for (; j < html.length; j++) {
    const c = html[j];
    if (c === "{") { depth++; started = true; }
    else if (c === "}") { depth--; if (started && depth === 0) { j++; break; } }
  }
  return html.slice(i, j);
}

// 彩色 emoji 门:正则与白名单照抄 panel-traj-board.test.ts(单色排版符号白名单,不算彩色 emoji)
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{2300}-\u{23FF}]/u;
const ALLOW = new Set(["✓", "✗", "✕", "→", "←", "↑", "↓", "↵", "⇤", "⇥", "↳", "⎇", "■", "»", "…", "⚠", "☰", "♥", "⚙", "⌕", "⌄", "◇", "▶", "●", "▤", "◈", "▣", "✂"]);
function emojiBad(s: string): string[] {
  return [...s].filter((ch) => EMOJI.test(ch) && !ALLOW.has(ch));
}

describe("轨迹独立视图 #view-traj(step-1535)", () => {
  it("①载体与结构:视图 + 三 host + 视图头刷新 + 侧栏入口 + 注册表齐备", async () => {
    const html = await panelHtml();
    // 载体:真视图(panel-wrap),内部保留 #trajBoard 容器
    expect(html).toContain('<div class="view panel-wrap" id="view-traj">');
    expect(html.indexOf('id="view-track"')).toBeLessThan(html.indexOf('id="view-traj"'));
    // 三 pane host 同屏
    for (const id of ["trajBoard", "trajCardsHost", "trajRowsHost", "trajInsp", "trajLanesHost", "trajLaneSum", "trajViewRefresh", "trajSearch", "trajExpandAll", "trajCopyPath"]) {
      expect(html, "缺节点 #" + id).toContain('id="' + id + '"');
    }
    // 视图头文案 = 卡片 title(命名单一来源)
    expect(html).toContain('<span class="vw-title">轨迹 Trail</span>');
    expect(html).toContain('<span class="vw-scope" id="scopeTraj"');
    // pane chip 三值 + 泳道模式 chip 三值
    for (const p of ["decisions", "ledger", "lanes"]) expect(html).toContain('data-traj-pane="' + p + '"');
    for (const lm of ["sequence", "duration", "time"]) expect(html).toContain('data-traj-lmode="' + lm + '"');
    // 侧栏入口 + 三处注册派生
    expect(html).toContain('id="act-traj"');
    expect(html).toContain('{ name: "traj", node: "view-traj", title: "轨迹 Trail", tag: "决策 · 账本 · 泳道"');
    expect(html).toContain("traj: \"traj\"");
    expect(html).toContain("traj: \"轨迹 Trail\"");
    expect(html).toContain('$("act-traj").classList.toggle("on", name === "traj")');
    expect(html).toContain('if (name === "traj") { trajBoardInitDone = false; trajBoardRefresh(); }');
  }, 30_000);

  it("②全屏浮层形态已取消(负面):无 position:fixed 的 .traj-board、无 open/close、无 body 滚动锁", async () => {
    const html = await panelHtml();
    expect(html).not.toContain(".traj-board{position:fixed");
    expect(html).not.toMatch(/\.traj-board\s*\{[^}]*position:\s*fixed/);
    expect(html).not.toContain('id="trajBoardClose"');
    expect(html).not.toContain("trajBoardOpen");
    expect(html).not.toContain("trajBoardClose");
    // #trajBoard 容器不再靠 display 开关(样式里没有 display:none 的 trajBoard)
    expect(html).not.toContain('<div id="trajBoard" class="traj-board" style="display:none"');
  }, 30_000);

  it("③入口改路由:composer pill / 轨迹卡「看板」都走 switchView('traj')", async () => {
    const html = await panelHtml();
    expect(html).toContain('$("trajBoardBtn").onclick = () => { switchView("traj"); trajViewFocusLatest(); };');
    expect(html).toContain('const open = t.closest("[data-traj-open]")');
    expect(html).toContain("e.preventDefault()");
    expect(html).toContain('switchView("traj");');
    expect(html).toContain('$("trajViewRefresh").onclick = () => trajBoardRefresh();');
  }, 30_000);

  it("④页面内联 <script> 全部可解析(删代码未引入语法错)", async () => {
    const html = await panelHtml();
    const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(blocks.length, "面板应含内联脚本").toBeGreaterThan(0);
    for (let i = 0; i < blocks.length; i++) {
      expect(() => new Script(blocks[i]), "第 " + (i + 1) + " 段内联脚本语法错误").not.toThrow();
    }
    // status-widget.js 资产同样可解析(它的删改不波及整页)
    const here = dirname(fileURLToPath(import.meta.url));
    const widget = readFileSync(join(here, "../src/assets/status-widget.js"), "utf-8");
    expect(() => new Script(widget), "status-widget.js 语法错误").not.toThrow();
  }, 30_000);

  it("⑤整页无彩色 emoji", async () => {
    const html = await panelHtml();
    expect(emojiBad(html)).toEqual([]);
  }, 30_000);

  it("⑥泳道纯函数:三泳道 + turn 分隔线;事件无 time 时按 seq 兜底且坐标不含 NaN(R1)", async () => {
    const html = await panelHtml();
    const srcs = ["trajLaneShortModel", "trajLaneFmtMs", "trajLaneRecord", "trajLaneHtml"].map((n) => extractFn(html, n)).join("\n");
    const body = "function esc(s){return String(s==null?'':s)"
      + ".replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');}"
      + "\nconst TRAJ_LANE_ERR_LABEL = { \"unknown-tool\": \"未知工具\", \"timeout\": \"超时\", \"threw\": \"抛错\", \"aborted\": \"已取消\", \"denied\": \"被拒\" };"
      + "\n" + srcs + "\nreturn { trajLaneHtml: trajLaneHtml };";
    // eslint-disable-next-line no-new-func
    const api = new Function(body)() as { trajLaneHtml: (evs: unknown, mode: string) => string };
    // 老会话事件:只有 {seq,kind,payload},没有 time(journal 落盘补 time 之前的历史数据)
    const oldEvents = [
      { seq: 1, kind: "turn.start", payload: { turn: 1 } },
      { seq: 2, kind: "message.user", payload: { text: "改一下 panel.ts" } },
      { seq: 3, kind: "message.agent", payload: { text: "好", llmMs: 1200, usage: { totalTokens: 30 }, model: "openai-compat/gpt-5.1" } },
      { seq: 4, kind: "tool.call", payload: { name: "read_file" } },
      { seq: 5, kind: "tool.result", payload: { name: "read_file", content: "错误:not found", durationMs: 5 } },
      { seq: 6, kind: "todo.updated", payload: { items: [1, 2] } },
    ];
    for (const mode of ["sequence", "duration", "time"]) {
      const out = api.trajLaneHtml(oldEvents, mode);
      expect(out).not.toContain("NaN");
      expect(out).toContain('data-lane="tool"');
      expect(out).toContain('data-lane="message"');
      expect(out).toContain('data-lane="system"');
      expect(out).toContain('class="sw-turn"');       // turn 分隔线
      expect(out).toContain("泳道模式=" + mode);
      expect(out).toContain("read_file");             // 工具名进泳道
      expect(out).toMatch(/class="sw-rec\s+err"/);    // 错误态可见(错误记录带 err 类)
    }
    // tool.call 与 tool.result 配对纪律:同一条工具链只出一条记录
    const seq = api.trajLaneHtml(oldEvents, "sequence");
    expect((seq.match(/read_file/g) || []).length).toBeLessThanOrEqual(2); // 副标题 + tooltip
    // 空事件:不抛、不产生空泳道乱码
    expect(api.trajLaneHtml(null, "sequence")).toContain("0 条记录");
  }, 30_000);
});
