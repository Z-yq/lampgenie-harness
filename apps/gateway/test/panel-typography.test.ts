/**
 * step-142 消息流排版系统化:实测校准 + 排版守卫。
 *
 * 契约(上一批落地的排版令牌层,src/panel.ts `:root` 内 --fs-x / --lh-x / --indent-x / --gap-x / --font-x 四族):
 * ① 8 类消息(用户消息 / agent 正文 md / 思考卡 / 工具卡 / 代码·终端·JSON 板 / 子代理卡 / 系统行 / chip)
 *    的字号·行高·字体·缩进·块距只允许引用令牌,同类出现第二种取值即为缺陷;
 * ② 排版与主题解耦:body.light 与五套 body.theme-* 一律不得覆写排版令牌;
 * ③ 窄视口(375)不得把正文压到不可读,代码板必须能横向滚动而非破版。
 *
 * 实测口径:真 chromium(playwright-core + /usr/bin/google-chrome)打开 servePanel 起的临时实例,
 * 用面板自带的测试钩子 window.__mature.setHist + renderHistory 注入多类型会话(与 test/ui/*.spec.cjs 同源做法),
 * 再用 getComputedStyle 读真实计算值,与 :root 令牌解析值比对——**不硬编码 px 数字**:令牌微调后本测试不脆。
 * 端口走 7880-7889 空闲探测(不碰产线 7700,也不与 7891/7892/7897 撞)。
 *
 * 页面脚本语法守卫不在此重复:test/panel-script-syntax.test.ts 已对每个内联 <script> 做编译校验。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { servePanel } from "../src/panel.js";

const require_ = createRequire(import.meta.url);
const { chromium } = require_("playwright-core") as typeof import("playwright-core");

const EVIDENCE_DIR = fileURLToPath(new URL("./ui/evidence/", import.meta.url));
const CHROME = "/usr/bin/google-chrome";

// ---- 页面内探针(纯 JS 源码字符串:evaluate 传字符串=不经打包器转译,规避 keepNames 注入的 __name 引用) ----
const PAGE_HELPERS = `
function __tok(n){ var v=getComputedStyle(document.documentElement).getPropertyValue(n); return (v||"").trim(); }
function __px(v){ return parseFloat(String(v).replace("px","")); }
function __fam(v){ var s=String(v||"").split(",")[0].trim(); return s.replace(/^["']|["']$/g,"").toLowerCase(); }
function __read(el){
  if(!el) return { present:false };
  var cs=getComputedStyle(el);
  return { present:true, fs:cs.fontSize, lh:cs.lineHeight, ff:cs.fontFamily,
    padL:cs.paddingLeft, padR:cs.paddingRight, marT:cs.marginTop, marL:cs.marginLeft,
    ox:cs.overflowX, sw:el.scrollWidth, cw:el.clientWidth };
}
function __all(sel){ return [].slice.call(document.querySelectorAll(sel)); }
// 令牌 → 计算字距:letter-spacing 的 em 相对元素自身 font-size(不是根字号),故必须传入元素的 fs。
function __lsPx(v, fsPx){
  var s=String(v==null?"":v).trim();
  if(!s||s==="normal") return 0;
  var n=parseFloat(s);
  if(isNaN(n)) return NaN;
  if(s.indexOf("rem")>0) return n*parseFloat(getComputedStyle(document.documentElement).fontSize);
  if(s.indexOf("em")>0) return n*fsPx;
  if(s.indexOf("%")>0) return n*fsPx/100;
  return n;
}
function __lsRead(el){
  if(!el) return null;
  var cs=getComputedStyle(el);
  return { ls:cs.letterSpacing, fs:cs.fontSize, lsPx:__lsPx(cs.letterSpacing, __px(cs.fontSize)) };
}
function __lsReport(){
  var md=__mdReply();
  var out={ tokens:{}, els:{} };
  ["--ls-body","--ls-tight","--ls-code","--ls-cjk"].forEach(function(n){ out.tokens[n]=__tok(n); });
  out.els.reply=__lsRead(md);
  out.els.codeWrap=__lsRead(md && md.querySelector(".code-wrap"));
  out.els.pre=__lsRead(md && md.querySelector(".code-wrap pre.code"));
  out.els.inlineCode=__lsRead(md && md.querySelector("code"));
  // 期望值:同一令牌按「该元素自身字号」解析 —— 与元素 computed 值同源比对,不写死 px
  out.expect={};
  if(out.els.reply) out.expect.reply=__lsPx(out.tokens["--ls-body"], __px(out.els.reply.fs));
  if(out.els.codeWrap) out.expect.codeWrap=__lsPx(out.tokens["--ls-code"], __px(out.els.codeWrap.fs));
  if(out.els.pre) out.expect.pre=__lsPx(out.tokens["--ls-code"], __px(out.els.pre.fs));
  if(out.els.inlineCode) out.expect.inlineCode=__lsPx(out.tokens["--ls-code"], __px(out.els.inlineCode.fs));
  return out;
}
function __mdReply(){ var t=__all(".task-reply"); for(var i=0;i<t.length;i++){ if(t[i].querySelector("h3")) return t[i]; } return null; }
function __report(){
  var md=__mdReply();
  var out={ tokens:{}, els:{}, counts:{} };
  ["--fs-body","--fs-body-sm","--fs-tool","--fs-code","--fs-code-sm","--fs-chip",
   "--lh-body","--lh-code","--lh-tight","--indent-1","--indent-2","--indent-3",
   "--gap-msg","--gap-block","--gap-tool","--font-body","--font-ui","--font-mono",
   "--fs-h1","--fs-h2","--fs-h3",
   "--ls-body","--ls-tight","--ls-code","--ls-cjk"]
    .forEach(function(n){ out.tokens[n]=__tok(n); });
  out.counts = { taskReply: __all(".task-reply").length, toolCard: __all(".tool-card:not(.sub-card)").length,
    isCode: __all(".task-reply .code-wrap.is-code pre.code").length, isJson: __all(".code-wrap.is-json pre.code").length,
    isTerm: __all(".code-wrap.is-term").length, subCard: __all(".sub-card").length, sysLine: __all(".sys-line").length };
  out.els.userLine = __read(document.querySelector(".user-line"));
  out.els.userLine2 = __read(__all(".user-line")[1]);
  out.els.userWho = __read(document.querySelector(".user-line .who"));
  out.els.taskReply = __read(md);
  // 标题按真实渲染链读:mdToHtml 把 md 的 #/##/### 降两级映射成 h3/h4/h5
  // (src/panel.ts:5156 Math.min(6, hm[1].length + 2)),消息流里不产 h1/h2
  // ——故 h1/h2 探针节点已删除,改断言真实产出的 DOM 标题级别。# → h3(=正文×1.3)/
  // ## → h4(=正文×1.15)/ ### → h5(=正文档 --fs-h3),三档严格递减。
  out.els.h3 = __read(md && md.querySelector("h3"));
  out.els.h4 = __read(md && md.querySelector("h4"));
  out.els.h5 = __read(md && md.querySelector("h5"));
  out.heads = md ? __all(".task-reply h1,.task-reply h2,.task-reply h3,.task-reply h4,.task-reply h5,.task-reply h6")
    .map(function(h){ return h.tagName.toLowerCase() + ":" + (h.textContent||"").slice(0,8); }) : [];
  out.els.table = __read(md && md.querySelector("table.md-table"));
  out.els.ul1 = __read(md && md.querySelector("ul"));
  out.els.ul2 = __read(md && md.querySelector("ul ul"));
  // 2026-11-06 有序列表嵌套(缺陷1):顶层 ol + 子 ol 探针
  out.els.ol1 = __read(md && md.querySelector("ol"));
  out.els.olSub = __read(md && md.querySelector("ol ol"));
  out.els.blockquote = __read(md && md.querySelector("blockquote"));
  out.els.inlineCode = __read(md && md.querySelector("code"));
  var pres = __all(".task-reply .code-wrap.is-code pre.code");
  out.els.mdPre1 = __read(pres[0]);
  out.els.mdPre2 = __read(pres[1]);
  out.els.thinkBody = __read(document.querySelector(".think-card .th-body"));
  var sums = __all(".tool-card:not(.sub-card) summary");
  out.els.toolSummary1 = __read(sums[0]);
  out.els.toolSummary2 = __read(sums[1]);
  out.els.toolBody = __read(document.querySelector(".tool-card:not(.sub-card) .tc-body"));
  out.els.termLine = __read(document.querySelector(".code-wrap.is-term .cl"));
  out.els.termBody = __read(document.querySelector(".code-wrap.is-term>.tc-body") || document.querySelector(".code-wrap.is-term .tc-body"));
  out.els.jsonPre = __read(document.querySelector(".code-wrap.is-json pre.code"));
  out.els.subTask = __read(document.querySelector(".sub-card .sub-task"));
  out.els.subSummary = __read(document.querySelector(".sub-card summary"));
  out.els.sysLine = __read(document.querySelector(".sys-line"));
  out.els.chipText = __read(document.querySelector(".tr-chip") || document.querySelector(".cp-pill") || document.querySelector(".user-line .who"));
  // 2026-10-22 tips 注入留痕:折叠提示行(摘要行档 --fs-body-sm / --lh-tight / sans)
  out.els.tipLine = __read(document.querySelector(".tip-line > summary"));
  out.els.tipBody = __read(document.querySelector(".tip-line .tl-body"));
  out.counts.tipLine = __all(".tip-line").length;
  // 2026-11-06 缺陷1 计数:子 ol 数量 + 顶层 ol 直接子元素数(嵌套若没挂进父 li,顶层会多出一项)
  out.counts.olSub = __all(".task-reply ol ol").length;
  out.counts.olTopLi = md ? (md.querySelectorAll("ol").length ? md.querySelector("ol").children.length : 0) : 0;
  return out;
}
`;

// 多类型会话:一条消息流覆盖 8 类内容(真实渲染路径,非手写 DOM)
const CONV = [
  { seq: 1, kind: "message.user", time: Date.parse("2026-10-14T10:00:00"), payload: { text: "排版实测:把消息流字号规范统一一下" } },
  {
    seq: 2, kind: "message.agent", time: Date.parse("2026-10-14T10:00:02"), llmMs: 3200,
    payload: {
      reasoning: "先核对既有令牌,再按 8 类消息逐一比对字号行高。",
      text: "# 一级标题\n## 二级标题\n### 三级标题\n\n正文段落在这一行,用来量正文基准字号与行高;行内 `inline_code` 也在这一行。\n\n" +
        "- 一级列表项\n  - 二级嵌套项\n\n" +
        "1. 顶层有序一\n   1. 嵌套有序一\n   2. 嵌套有序二\n2. 顶层有序二\n\n" +
        "| 列A | 列B |\n| --- | --- |\n| 值1 | 值2 |\n\n> 引用块一行,用来看左缩进与字号档\n\n" +
        "```ts\nconst a = 1;\n```\n",
    },
  },
  { seq: 3, kind: "message.agent", time: Date.parse("2026-10-14T10:00:04"), payload: { text: "第二段正文,用来做同类同规格对照。\n\n```js\nlet y = 2;\n```\n" } },
  {
    seq: 4, kind: "message.agent", time: Date.parse("2026-10-14T10:00:06"),
    payload: { text: "跑几条工具。", toolCalls: [
      { id: "c1", name: "run_cmd", arguments: JSON.stringify({ command: "pnpm build" }) },
      { id: "c2", name: "web_fetch", arguments: JSON.stringify({ url: "http://127.0.0.1/x" }) },
      { id: "c3", name: "web_fetch", arguments: JSON.stringify({ url: "http://127.0.0.1/y" }) },
    ] },
  },
  { seq: 5, kind: "tool.result", time: Date.parse("2026-10-14T10:00:08"), payload: { toolCallId: "c1", name: "run_cmd", arguments: JSON.stringify({ command: "pnpm build" }), content: "$ pnpm build\n构建中...\n构建失败:3 个包\n", durationMs: 1200 } },
  { seq: 6, kind: "tool.result", time: Date.parse("2026-10-14T10:00:09"), payload: { toolCallId: "c2", name: "web_fetch", arguments: JSON.stringify({ url: "http://127.0.0.1/x" }), content: JSON.stringify({ ok: true, n: 42, s: "hi" }, null, 2), durationMs: 40 } },
  { seq: 7, kind: "tool.result", time: Date.parse("2026-10-14T10:00:10"), payload: { toolCallId: "c3", name: "web_fetch", arguments: JSON.stringify({ url: "http://127.0.0.1/y" }), content: JSON.stringify({ ok: false, n: 7 }, null, 2), durationMs: 44 } },
  { seq: 8, kind: "subagent.spawn", time: Date.parse("2026-10-14T10:00:12"), payload: { agentId: "ag-typo-1", title: "调查渲染链路", instructions: "【子智能体角色:worker】\n【任务书】调查渲染链路并汇总产出" } },
  { seq: 9, kind: "subagent.result", time: Date.parse("2026-10-14T10:00:16"), payload: { agentId: "ag-typo-1", event: { finalText: "子代理结果正文一行" } } },
  { seq: 10, kind: "message.system", time: Date.parse("2026-10-14T10:00:18"), payload: { text: "goal 已切换:消息流排版系统化" } },
  { seq: 11, kind: "message.user", time: Date.parse("2026-10-14T10:00:20"), payload: { text: "第二条用户消息(同类同规格对照实例)" } },
  { seq: 12, kind: "compact.done", time: Date.parse("2026-10-14T10:00:22"), payload: { summary: "前 12 轮已蒸馏" } },
  // 2026-10-22 tips 注入留痕:loop 旁路落 journal,面板折叠展示「tips · 类别 · 第N步 · 字符数」
  {
    seq: 13, kind: "tip.injected", time: Date.parse("2026-10-14T10:00:24"),
    payload: {
      keys: ["code-orient", "dispatch"], turn: 1, step: 3, chars: 96,
      text: "<system-reminder>tips(做这类事之前的信息增强,直接利用,不要复述此段)\n## 派发 tips\n- 小步修改自己上手更快\n</system-reminder>",
    },
  },
];

type Reading = {
  present: boolean; fs?: string; lh?: string; ff?: string;
  padL?: string; padR?: string; marT?: string; marL?: string; ox?: string; sw?: number; cw?: number;
};
type Report = { tokens: Record<string, string>; els: Record<string, Reading>; counts: Record<string, number>; heads: string[] };

const px = (v: string | undefined): number => parseFloat(String(v ?? "").replace("px", ""));
const fam = (v: string | undefined): string =>
  String(v ?? "").split(",")[0]!.trim().replace(/^["']|["']$/g, "").toLowerCase();
const near = (a: number, b: number, tol = 1): boolean => Math.abs(a - b) <= tol;

/** 期望值断言:元素字号必须等于令牌解析值(令牌驱动,不硬编码 px)。 */
function expectFs(reading: Reading, tokPx: number, label: string, tokName: string): void {
  expect(reading.present, label + " 元素缺席").toBe(true);
  expect(px(reading.fs), label + " font-size 应等于 " + tokName + "(" + tokPx + "px)").toBeCloseTo(tokPx, 1);
}

/** 行高断言:落在「令牌倍数 × 元素字号」±1px 内(浏览器 computed line-height 是 px)。 */
function expectLh(reading: Reading, multiplier: number, label: string, tokName: string): void {
  const fsPx = px(reading.fs);
  const want = fsPx * multiplier;
  expect(near(px(reading.lh), want, 1), label + " line-height 应在 " + tokName + "×" + fsPx + "=" + want.toFixed(1) + "px ±1 内(got " + reading.lh + ")").toBe(true);
}

let server: { close: () => Promise<void> } | null = null;
let browser: import("playwright-core").Browser | null = null;
let page: import("playwright-core").Page | null = null;
let baseUrl = "";
let html = "";
let report: Report | null = null;

async function pickFreePort(): Promise<number> {
  for (let p = 7880; p <= 7889; p++) {
    const free = await new Promise<boolean>((res) => {
      const s = createServer();
      s.once("error", () => { try { s.close(); } catch { /* 已关 */ } res(false); });
      s.once("listening", () => s.close(() => res(true)));
      s.listen(p, "127.0.0.1");
    });
    if (free) return p;
  }
  throw new Error("7880-7889 段无空闲端口");
}

beforeAll(async () => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const port = await pickFreePort();
  baseUrl = "http://127.0.0.1:" + port;
  server = servePanel(port, () => {});
  const res = await fetch(baseUrl + "/");
  expect(res.status).toBe(200);
  html = await res.text();

  browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  // 经典布局(画布形态会把消息流搬进浮卡,不是排版本体所在);固定会话 id + 关掉工具分组(单卡路径)
  const initScript =
    "localStorage.setItem('zh:cv-mode','classic');" +
    "localStorage.setItem('zh:g-search','off');" +
    "localStorage.setItem('zh:g-term','off');" +
    "localStorage.setItem('zh:g-changes','off');" +
    "sessionStorage.setItem('zh:sid','spec-typo');";
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.addInitScript(initScript);
  await page.goto(baseUrl + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  // 造数据路线:面板自带测试钩子 window.__mature.setHist + renderHistory(panel.ts:16066)
  // ——走真实 renderHistory 渲染链(mdToHtml/工具卡/子代理卡/系统行全真产),比手写 DOM 片段保真。
  // 注:这里必须把数据 JSON.stringify 进脚本字符串再 evaluate 整串——evaluate 传函数字面量会被 vitest/esbuild
  // 的 keepNames 包一层 __name(...),页面上下文没有 __name 直接 ReferenceError(实测坑,详见报告)。
  const injected = await page.evaluate(
    "(function(){ if(!window.__mature) return false; window.__mature.setHist(" + JSON.stringify(CONV) +
      "); window.__mature.renderHistory(); return true; })()",
  );
  expect(injected, "window.__mature 测试钩子不可用(面板渲染链改动?本测试依赖它注入会话)").toBe(true);
  await page.waitForTimeout(600);
  report = (await page.evaluate("(function(){" + PAGE_HELPERS + "return __report();})()")) as Report;
}, 120_000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (server) await server.close().catch(() => {});
});

describe("step-142 消息流排版系统化", () => {
  it("① 排版令牌层齐备:18 个令牌在 :root 定义,var() 引用 ≥60,主题块零覆写", () => {
    // 令牌定义:任务书列举的 6 字号 + 3 行高 + 3 缩进 + 3 块距 + 3 字体族 = 18 项,全部落在 :root 块内。
    const rootStart = html.indexOf(":root{");
    expect(rootStart, "未找到 :root 块").toBeGreaterThan(0);
    const h3i = html.indexOf("--fs-h3:", rootStart);
    expect(h3i, "未找到 --fs-h3(排版令牌层末项)").toBeGreaterThan(rootStart);
    const rootBlock = html.slice(rootStart, html.indexOf("}", h3i) + 1);
    const TOKENS = [
      "--fs-body", "--fs-body-sm", "--fs-tool", "--fs-code", "--fs-code-sm", "--fs-chip",
      "--lh-body", "--lh-code", "--lh-tight",
      "--indent-1", "--indent-2", "--indent-3",
      "--gap-msg", "--gap-block", "--gap-tool",
      "--font-body", "--font-ui", "--font-mono",
    ];
    for (const t of TOKENS) {
      expect(new RegExp(t.replace(/-/g, "-") + "\\s*:").test(rootBlock), "排版令牌 " + t + " 未在 :root 定义").toBe(true);
    }
    // 规范值(上一批落地口径):字号/缩进/块距必须就是这些数,防止被悄悄改档
    const SPEC: Record<string, string> = {
      "--fs-body": "19px", "--fs-body-sm": "15px", "--fs-tool": "12px", "--fs-code": "12.5px",
      "--fs-code-sm": "11.5px", "--fs-chip": "11px",
      "--lh-body": "1.85", "--lh-code": "1.6", "--lh-tight": "1.6",
      "--indent-1": "22px", "--indent-2": "44px", "--indent-3": "66px",
      "--gap-msg": "14px", "--gap-block": "12px", "--gap-tool": "6px",
    };
    for (const [k, v] of Object.entries(SPEC)) {
      const m = new RegExp(k + "\\s*:\\s*([^;}]+)").exec(rootBlock);
      expect(m, k + " 取值缺失").toBeTruthy();
      expect(m![1]!.trim(), k + " 规范值").toBe(v);
    }

    // 派生标题令牌(--fs-h1/h2/h3)必须有真实 CSS 消费者:定义在 :root 却没人 var() 引用 = 死令牌。
    // step-142 起标题分级由 .task-reply h3/h4/h5 三条规则消费(mdToHtml 把 md #/##/### 降两级映射到 h3/h4/h5),
    // 故不再靠往 .task-reply append h1/h2 探针节点证明令牌生效。
    for (const hTok of ["--fs-h1", "--fs-h2", "--fs-h3"]) {
      const defM = new RegExp(hTok + "\\s*:\\s*([^;}]+)").exec(rootBlock);
      expect(defM, hTok + " 未在 :root 定义").toBeTruthy();
      const consumers = html.split("var(" + hTok + ")").length - 1;
      expect(consumers, hTok + " 在 HTML 里没有 var() 消费者(死令牌)").toBeGreaterThanOrEqual(1);
    }
    // 标题三档必须由 .task-reply 的 h3/h4/h5 规则分别消费(真实 DOM 级别口径,src/panel.ts:1715-1719)
    expect(html, ".task-reply h3 规则应消费 --fs-h1").toMatch(/\.task-reply h1,\.task-reply h3\{font-size:var\(--fs-h1\)/);
    expect(html, ".task-reply h4 规则应消费 --fs-h2").toMatch(/\.task-reply h2,\.task-reply h4\{font-size:var\(--fs-h2\)/);
    expect(html, ".task-reply h5 规则应消费 --fs-h3").toMatch(/\.task-reply h5,\.task-reply h6\{font-size:var\(--fs-h3\)/);
    // 派生令牌派生关系:--fs-h1=正文×1.3 / --fs-h2=正文×1.15 / --fs-h3=正文(不许写死 px)
    expect(/--fs-h1:calc\(var\(--fs-body\) \* 1\.3\)/.test(rootBlock), "--fs-h1 应为 --fs-body×1.3").toBe(true);
    expect(/--fs-h2:calc\(var\(--fs-body\) \* 1\.15\)/.test(rootBlock), "--fs-h2 应为 --fs-body×1.15").toBe(true);
    expect(/--fs-h3:var\(--fs-body\)/.test(rootBlock), "--fs-h3 应等于 --fs-body").toBe(true);

    // var() 引用总数:实际 200+ (fs/lh/indent/gap 四族),守 ≥60 的下限——防「改成裸数值」整片回退
    const refGroups = ["var(--fs-", "var(--lh-", "var(--indent-", "var(--gap-"];
    const refCounts = refGroups.map((g) => html.split(g).length - 1);
    const refTotal = refCounts.reduce((a, b) => a + b, 0);
    expect(refTotal, "排版令牌 var() 引用总数([" + refGroups.join(" ") + "]=" + refCounts.join("/") + ")").toBeGreaterThanOrEqual(60);

    // 三个字体族令牌各至少被引用 2 处
    for (const f of ["--font-body", "--font-ui", "--font-mono"]) {
      const n = html.split("var(" + f + ")").length - 1;
      expect(n, f + " 引用次数").toBeGreaterThanOrEqual(2);
    }

    // 排版与主题解耦:body.light 与五套 body.theme-* 的任何 CSS 块内都不得出现排版令牌定义
    const themeBlock = /(?:body\.light|body\.theme-[a-z]+)[^{}]*\{[^{}]*\}/g;
    const blocks = html.match(themeBlock) ?? [];
    expect(blocks.length, "未匹配到任何主题块(选择器改写?)").toBeGreaterThanOrEqual(6);
    const violating: string[] = [];
    for (const b of blocks) {
      const defs = b.match(/--(?:fs|lh|indent|gap|font)-[a-z0-9-]+\s*:/g);
      if (defs) violating.push(b.slice(0, 60).replace(/\s+/g, " ") + " → " + defs.join(","));
    }
    expect(violating, "主题块内覆写了排版令牌(排版必须与主题解耦)").toEqual([]);
  });

  it("② computed 实测:8 类消息的字号/行高/字体族与 :root 令牌逐一一致", () => {
    const r = report!;
    const t = r.tokens;
    const bodyPx = px(t["--fs-body"]);
    const bodySmPx = px(t["--fs-body-sm"]);
    const toolPx = px(t["--fs-tool"]);
    const codePx = px(t["--fs-code"]);
    const codeSmPx = px(t["--fs-code-sm"]);
    const chipPx = px(t["--fs-chip"]);
    const lhBody = parseFloat(t["--lh-body"]!);
    const lhCode = parseFloat(t["--lh-code"]!);
    const lhTight = parseFloat(t["--lh-tight"]!);
    const fBody = fam(t["--font-body"]);
    const fUi = fam(t["--font-ui"]);
    const fMono = fam(t["--font-mono"]);

    // 令牌自身解析(浏览器侧):确认 :root 令牌在页面里真的拿到了值
    expect(bodyPx).toBe(19);
    // 行高只守「放松档区间」不写死数值:--lh-body 由 step-142 起从 1.8 调到 1.85(panel.ts:217),
    // 精确值已由 ① 的 SPEC 表锚定,这里只证浏览器侧真的解析出了值。
    expect(lhBody, "--lh-body 应为放松档(1.8~2.0)").toBeGreaterThanOrEqual(1.8);
    expect(lhBody, "--lh-body 应为放松档(1.8~2.0)").toBeLessThanOrEqual(2.0);
    expect(fBody.length).toBeGreaterThan(0);
    expect(fMono).not.toBe(fBody);

    // 渲染到场性:8 类内容真实出现在消息流里
    expect(r.counts.taskReply, "agent 正文块数").toBeGreaterThanOrEqual(2);
    expect(r.counts.toolCard, "工具卡数").toBeGreaterThanOrEqual(2);
    expect(r.counts.isCode, "代码板(pre.code)数").toBeGreaterThanOrEqual(2);
    expect(r.counts.isJson, "JSON 板数").toBeGreaterThanOrEqual(2);
    expect(r.counts.isTerm, "终端板数").toBeGreaterThanOrEqual(1);
    expect(r.counts.subCard, "子代理过程卡数").toBeGreaterThanOrEqual(1);
    expect(r.counts.sysLine, "系统行数").toBeGreaterThanOrEqual(1);

    // 1) 用户消息正文
    expectFs(r.els.userLine!, bodyPx, "用户消息 .user-line", "--fs-body");
    expectLh(r.els.userLine!, lhBody, "用户消息 .user-line", "--lh-body");
    expect(fam(r.els.userLine!.ff), "用户消息 font-family 首项").toBe(fBody);

    // 2) agent 正文容器
    expectFs(r.els.taskReply!, bodyPx, "agent 正文 .task-reply", "--fs-body");
    expectLh(r.els.taskReply!, lhBody, "agent 正文 .task-reply", "--lh-body");
    expect(fam(r.els.taskReply!.ff), "agent 正文 font-family 首项").toBe(fBody);

    // 3) agent 标题分级(真实渲染链,不用探针节点):mdToHtml 的 `lv = Math.min(6, n + 2)`
    //    (src/panel.ts:5156)把 markdown 的 #/##/### 降两级映射成 h3/h4/h5,消息流里不产 h1/h2:
    //    md # → h3(=正文×1.3)/ md ## → h4(=正文×1.15)/ md ### → h5(=正文档 --fs-h3)。
    const h3Px = px(r.els.h3!.fs);
    const h4Px = px(r.els.h4!.fs);
    const h5Px = px(r.els.h5!.fs);
    expect(r.els.h3!.present, "h3(=md #)缺席").toBe(true);
    expect(r.els.h4!.present, "h4(=md ##)缺席").toBe(true);
    expect(r.els.h5!.present, "h5(=md ###)缺席").toBe(true);
    // 渲染链口径守门:消息流里不得出现 h1/h2(探针已删,产 h1/h2 = mdToHtml 映射被改)
    expect(r.heads, "消息流标题级别应为 h3/h4/h5 三档(实测 " + JSON.stringify(r.heads) + ")")
      .toEqual(["h3:一级标题", "h4:二级标题", "h5:三级标题"]);
    expect(h3Px, "h3(md #)font-size 应等于正文×1.3(--fs-h1)").toBeCloseTo(bodyPx * 1.3, 1);
    expect(h4Px, "h4(md ##)font-size 应等于正文×1.15(--fs-h2)").toBeCloseTo(bodyPx * 1.15, 1);
    expect(h5Px, "h5(md ###)font-size 应等于正文档(--fs-h3=--fs-body)").toBeCloseTo(bodyPx, 1);
    expect(h3Px, "标题字号必须三档严格递减:h3 > h4").toBeGreaterThan(h4Px);
    expect(h4Px, "标题字号必须三档严格递减:h4 > h5").toBeGreaterThan(h5Px);
    for (const [lbl, e] of [["h3", r.els.h3!], ["h4", r.els.h4!], ["h5", r.els.h5!]] as Array<[string, Reading]>) {
      expect(fam(e.ff), lbl + " font-family 首项(标题走 --font-ui)").toBe(fUi);
    }
    // 三档令牌严格递减(--fs-h1 > --fs-h2 > --fs-h3 = 正文),保证分级不塌成同档
    const h1Px = bodyPx * 1.3;
    const h2Px = bodyPx * 1.15;
    expect(h1Px, "--fs-h1 必须 > --fs-h2").toBeGreaterThan(h2Px);
    expect(h2Px, "--fs-h2 必须 > --fs-h3(=正文)").toBeGreaterThan(bodyPx);
    expect(bodyPx, "第三档 --fs-h3 必须 = 正文(--fs-body)").toBeCloseTo(bodyPx, 1);
    // 令牌值侧:--fs-h3 定义为 var(--fs-body),Chrome 对 custom property 返回未替换的 token 序列,
    // 故不取 computed 值,改在 ① 断言定义串与 h5 实测字号(=正文)双证。

    // 4) agent 表格:次要叙述档 --fs-body-sm + 紧凑行高 --lh-tight
    expectFs(r.els.table!, bodySmPx, "agent 表格 .md-table", "--fs-body-sm");
    expectLh(r.els.table!, lhTight, "agent 表格 .md-table", "--lh-tight");

    // 5) agent 嵌套列表缩进:一级 --indent-1,二级 --indent-2(缩进只能走令牌)
    expect(r.els.ul1!.present && r.els.ul2!.present, "列表实例缺席").toBe(true);
    expect(px(r.els.ul1!.marL), "一级列表 margin-left 应等于 --indent-1").toBeCloseTo(px(t["--indent-1"]), 1);
    expect(px(r.els.ul2!.marL), "二级列表 margin-left 应等于 --indent-2").toBeCloseTo(px(t["--indent-2"]), 1);
    expect(px(t["--indent-2"]), "indent-2 应为 indent-1 的两倍").toBeCloseTo(px(t["--indent-1"]) * 2, 1);
    expect(px(t["--indent-3"]), "indent-3 应为 indent-1 的三倍").toBeCloseTo(px(t["--indent-1"]) * 3, 1);

    // 5b) 有序列表嵌套(2026-11-06 缺陷1):ol 嵌套能力须与 ul 对称
    //     —— 嵌套 ol 真的挂在第一个父 li 内(顶层 ol 直接子元素=2),缩进走 --indent-2 令牌。
    expect(r.els.ol1!.present && r.els.olSub!.present, "有序列表嵌套缺席(顶层 ol / ol ol)").toBe(true);
    expect(px(r.els.olSub!.marL), "嵌套有序列表 margin-left 应等于 --indent-2").toBeCloseTo(px(t["--indent-2"]), 1);
    expect(px(r.els.olSub!.marL), "嵌套 ol 缩进必须 > 0(证明没被拍成同级)").toBeGreaterThan(0);
    expect(r.counts.olSub, ".task-reply ol ol 计数应为 1").toBe(1);
    expect(r.counts.olTopLi, "顶层 ol 直接子元素应=2(嵌套 ol 须挂在第一个 li 内,不许变成第 3 个顶层项)").toBe(2);

    // 6) agent 引用块:--fs-body-sm + --indent-1 左缩进
    expectFs(r.els.blockquote!, bodySmPx, "agent 引用 blockquote", "--fs-body-sm");
    expect(px(r.els.blockquote!.padL), "引用块左内距应等于 --indent-1").toBeCloseTo(px(t["--indent-1"]), 1);

    // 7) 行内 code:--fs-code-sm + mono
    expectFs(r.els.inlineCode!, codeSmPx, "行内 code", "--fs-code-sm");
    expect(fam(r.els.inlineCode!.ff), "行内 code font-family 首项").toBe(fMono);

    // 8) 思考卡体:--fs-body-sm + --font-ui + 正文行高
    expectFs(r.els.thinkBody!, bodySmPx, "思考卡体 .th-body", "--fs-body-sm");
    expectLh(r.els.thinkBody!, lhBody, "思考卡体 .th-body", "--lh-body");
    expect(fam(r.els.thinkBody!.ff), "思考卡体 font-family 首项").toBe(fUi);

    // 9) 工具卡标题:--fs-tool + mono
    expectFs(r.els.toolSummary1!, toolPx, "工具卡标题 summary", "--fs-tool");
    expect(fam(r.els.toolSummary1!.ff), "工具卡标题 font-family 首项(必须 mono)").toBe(fMono);

    // 10) 终端板行:板族 mono + 板族本体档 --fs-code(step-142 提权:工具卡内 .tc-body 不再压成 code-sm)
    expect(r.els.termLine!.present, "终端板行缺席").toBe(true);
    expect(fam(r.els.termLine!.ff), "终端板行 font-family 首项(必须 mono)").toBe(fMono);
    expectFs(r.els.termLine!, codePx, "终端板行 .cl", "--fs-code");
    expectLh(r.els.termLine!, lhCode, "终端板行", "--lh-code");
    // 板体容器自身也是 --fs-code(行 .cl 继承它;两者同档才说明提权规则真的命中容器)
    expectFs(r.els.termBody!, codePx, "终端板体 .code-wrap.is-term>.tc-body", "--fs-code");

    // 11) 代码板 pre.code:--fs-code + --lh-code + mono
    expectFs(r.els.mdPre1!, codePx, "代码板 pre.code", "--fs-code");
    expectLh(r.els.mdPre1!, lhCode, "代码板 pre.code", "--lh-code");
    expect(fam(r.els.mdPre1!.ff), "代码板 font-family 首项").toBe(fMono);

    // 12) JSON 板:同属板族 --fs-code + --lh-code
    expectFs(r.els.jsonPre!, codePx, "JSON 板 is-json pre.code", "--fs-code");
    expectLh(r.els.jsonPre!, lhCode, "JSON 板 is-json pre.code", "--lh-code");

    // 13) 子代理过程卡正文:从属档 --fs-code-sm + --lh-code + --font-ui
    expectFs(r.els.subTask!, codeSmPx, "子代理卡正文 .sub-task", "--fs-code-sm");
    expectLh(r.els.subTask!, lhCode, "子代理卡正文 .sub-task", "--lh-code");
    expect(fam(r.els.subTask!.ff), "子代理卡正文 font-family 首项").toBe(fUi);

    // 14) 系统行:--fs-body-sm + --lh-tight + --font-ui
    expectFs(r.els.sysLine!, bodySmPx, "系统行 .sys-line", "--fs-body-sm");
    expectLh(r.els.sysLine!, lhTight, "系统行 .sys-line", "--lh-tight");
    expect(fam(r.els.sysLine!.ff), "系统行 font-family 首项").toBe(fUi);

    // 15) chip 徽标:固定档 --fs-chip
    expectFs(r.els.chipText!, chipPx, "chip 徽标", "--fs-chip");
    expect(chipPx, "chip 档应小于正文档(徽标不得抢正文)").toBeLessThan(bodyPx);

    // 16) tips 提示行摘要:与系统行同族 --fs-body-sm + --lh-tight + --font-ui;正文从属档 --fs-code-sm
    expect(r.counts.tipLine, "tips 提示行未渲染(.tip-line 缺席)").toBe(1);
    expectFs(r.els.tipLine!, bodySmPx, "tips 行 .tip-line summary", "--fs-body-sm");
    expectLh(r.els.tipLine!, lhTight, "tips 行 .tip-line summary", "--lh-tight");
    expect(fam(r.els.tipLine!.ff), "tips 行 font-family 首项").toBe(fUi);
    expect(r.els.tipBody!.present, "tips 展开正文 .tl-body 缺席").toBe(true);
    expectFs(r.els.tipBody!, codeSmPx, "tips 展开正文 .tl-body", "--fs-code-sm");

    // D-3 逐类核对表数据:把实测值打到测试输出(供收口报告直接引用;真值来自本次 run,非硬编码)。
    const rows: Array<[string, Reading | undefined, string]> = [
      ["用户消息 .user-line", r.els.userLine, "--fs-body / --lh-body / serif"],
      ["用户消息 .who 徽标", r.els.userWho, "--fs-chip / --lh-tight / sans"],
      ["agent 正文 .task-reply", r.els.taskReply, "--fs-body / --lh-body / serif"],
      ["agent h3(=md #)", r.els.h3, "--fs-h1(=body×1.3) / --lh-tight / sans"],
      ["agent h4(=md ##)", r.els.h4, "--fs-h2(=body×1.15) / --lh-tight / sans"],
      ["agent h5(=md ###)", r.els.h5, "--fs-h3(=body) / --lh-tight / sans"],
      ["agent 表格 .md-table", r.els.table, "--fs-body-sm / --lh-tight / 继承"],
      ["agent 列表(一级)", r.els.ul1, "继承正文 / indent-1"],
      ["agent 列表(二级嵌套)", r.els.ul2, "继承正文 / indent-2"],
      ["agent 引用 blockquote", r.els.blockquote, "--fs-body-sm / --lh-body / 继承"],
      ["agent 行内 code", r.els.inlineCode, "--fs-code-sm / mono"],
      ["agent 围栏代码板 pre.code", r.els.mdPre1, "--fs-code / --lh-code / mono"],
      ["思考卡体 .th-body", r.els.thinkBody, "--fs-body-sm / --lh-body / sans"],
      ["工具卡标题 summary", r.els.toolSummary1, "--fs-tool / --lh-tight / mono"],
      ["工具卡体 .tc-body", r.els.toolBody, "--fs-code-sm / --lh-code / mono"],
      ["终端板行 .cl", r.els.termLine, "--fs-code(板族本体档,step-142 提权) / --lh-code / mono"],
      ["终端板体 .code-wrap.is-term>.tc-body", r.els.termBody, "--fs-code / --lh-code / mono"],
      ["JSON 板 pre.code", r.els.jsonPre, "--fs-code / --lh-code / mono"],
      ["子代理卡正文 .sub-task", r.els.subTask, "--fs-code-sm / --lh-code / sans"],
      ["子代理卡标题 summary", r.els.subSummary, "--fs-tool / --lh-tight / mono"],
      ["系统行 .sys-line", r.els.sysLine, "--fs-body-sm / --lh-tight / sans"],
      ["chip 徽标(.tr-chip)", r.els.chipText, "--fs-chip / mono"],
    ];
    const table = rows.map(
      ([label, e, spec]) =>
        "| " + label + " | " + (e?.present ? e.fs : "-") + " | " + (e?.present ? e.lh : "-") + " | " +
        (e?.present ? fam(e.ff) : "-") + " | " + (e?.present ? e.padL + "/" + e.padR : "-") + " | " +
        (e?.present ? e.marT + "/" + e.marL : "-") + " | " + spec + " |",
    );
    console.log("\n### D-3 逐类核对表(实测 font-size | line-height | font-family 首项 | padding L/R | margin T/L | 规范)\n" +
      "| 类型 | fs | lh | font | padding L/R | margin T/L | 规范 |\n|---|---|---|---|---|---|---|\n" +
      table.join("\n"));
  });

  it("③ 同类同规格:同类两个实例的 font-size / line-height 完全相等", () => {
    const r = report!;
    const pairs: Array<[string, Reading | undefined, Reading | undefined]> = [
      ["用户消息 .user-line", r.els.userLine, r.els.userLine2],
      ["工具卡标题 .tool-card summary", r.els.toolSummary1, r.els.toolSummary2],
      ["代码板 pre.code", r.els.mdPre1, r.els.mdPre2],
    ];
    for (const [label, a, b] of pairs) {
      expect(a && b && a.present && b.present, label + " 两个实例未同时在场").toBe(true);
      expect(b!.fs, label + " font-size 两实例应相等").toBe(a!.fs);
      expect(b!.lh, label + " line-height 两实例应相等").toBe(a!.lh);
      expect(b!.ff, label + " font-family 两实例应相等").toBe(a!.ff);
    }
  });

  it("④ 窄视口 375:正文可读不溢出,代码板横向滚动可用", async () => {
    const pg = page!;
    await pg.setViewportSize({ width: 375, height: 800 });
    await pg.waitForTimeout(600);
    const narrow = (await pg.evaluate(
      "(function(){" + PAGE_HELPERS + "var body=__read(document.querySelector('.task-reply'));" +
      "var pres=__all('pre.code');var codes=pres.map(function(e){return __read(e);});" +
      "var cw=__read(document.querySelector('.code-wrap.is-code'));" +
      "var ul=__read(document.querySelector('.task-reply ul ul'));" +
      "return { body:body, codes:codes, codeWrap:cw, ul:ul, docSW:document.documentElement.scrollWidth, inner:window.innerWidth };" +
      "})()",
    )) as { body: Reading; codes: Reading[]; codeWrap: Reading; ul: Reading; docSW: number; inner: number };

    // ① 正文可读:字号仍 ≥15px,且没被压成 0
    expect(px(narrow.body.fs), "窄视口正文 font-size 不得 <15px").toBeGreaterThanOrEqual(15);
    expect(px(narrow.body.fs), "窄视口正文 font-size 不得为 0").toBeGreaterThan(0);
    // 无横向溢出
    expect(narrow.docSW, "窄视口整页横向溢出(docSW=" + narrow.docSW + " innerWidth=" + narrow.inner + ")").toBeLessThanOrEqual(narrow.inner + 2);
    // ② 代码板未被挤压破版。两条合法收纳路径(任一成立即未破版):
    //    a) 横向滚动可用:overflow-x 为 auto/scroll,或内容确实超宽(sw > cw);
    //    b) 内容已换行收纳:pre.code .cl 是 white-space:pre-wrap,超宽行被折行 → sw ≤ cw,无内容被裁。
    //    真正破版的形态是「既不能滚、内容又超宽被 hidden 裁掉」——这种必须红。
    expect(narrow.codes.length, "窄视口下代码板缺席").toBeGreaterThan(0);
    for (const c of narrow.codes) {
      const scrollable = c.ox === "auto" || c.ox === "scroll" || (c.sw ?? 0) > (c.cw ?? 0);
      const wrapped = (c.sw ?? 0) <= (c.cw ?? 0) + 2;
      expect(scrollable || wrapped, "窄视口代码板被裁破版(overflow-x=" + c.ox + ", sw=" + c.sw + ", cw=" + c.cw + ")").toBe(true);
    }
    // 横向滚动能力本身没丢:正文围栏代码块(.task-reply pre,即 .code-wrap.is-code pre.code)必须可滚
    const mdPres = narrow.codes.filter((c) => (c.ox === "auto" || c.ox === "scroll") || (c.sw ?? 0) > (c.cw ?? 0));
    expect(mdPres.length, "窄视口下没有任何代码板可横向滚动(围栏块滚动能力丢失)").toBeGreaterThan(0);
    // 缩进令牌在窄视口不被压缩(仍是 28px 档)
    expect(px(narrow.ul.marL), "窄视口二级列表缩进应仍等于 --indent-2").toBeCloseTo(px(report!.tokens["--indent-2"]), 1);
  });

  it("⑥ J5 字距族:--ls-* 四档在 :root 生效,.task-reply / .task-reply .code-wrap 计算字距与令牌同源(零硬编码)", async () => {
    const r = (await page.evaluate("(function(){" + PAGE_HELPERS + "return __lsReport();})()")) as {
      tokens: Record<string, string>;
      els: Record<string, { ls: string; fs: string; lsPx: number } | null>;
      expect: Record<string, number>;
    };
    for (const n of ["--ls-body", "--ls-tight", "--ls-code", "--ls-cjk"]) {
      expect(r.tokens[n], "字距令牌 " + n + " 未在 :root 定义").toBeTruthy();
    }
    // 正文:.task-reply 的 computed letter-spacing 必须等于 --ls-body 按自身字号解析的值
    expect(r.els.reply, "未找到 .task-reply").toBeTruthy();
    expect(r.els.reply!.ls, "正文不得再出现裸值字距").not.toBe("normal");
    expect(r.els.reply!.lsPx, "正文 computed 字距应与 --ls-body 同源(" + r.els.reply!.ls + " vs " + r.expect.reply + ")")
      .toBeCloseTo(r.expect.reply, 2);
    // 代码块:.task-reply .code-wrap / pre / code 一律 --ls-code(=0,等宽列对齐)
    for (const k of ["codeWrap", "pre", "inlineCode"]) {
      const el = r.els[k];
      expect(el, "未找到 .task-reply 的 " + k).toBeTruthy();
      expect(el!.lsPx, k + " 字距应为 --ls-code(" + el!.ls + " vs " + r.expect[k] + ")").toBeCloseTo(r.expect[k]!, 2);
    }
    expect(r.els.codeWrap!.lsPx, "代码块字距必须为 0(任何字距都会破列对齐)").toBe(0);
  }, 30_000);

  it("⑤ 截图证据:桌面 1400 / 完整消息流 / 窄视口 375", async () => {
    const pg = page!;
    const shots: Array<{ path: string; fullPage: boolean }> = [];
    // 窄视口那轮结束后要回到 1400 拍桌面图
    await pg.setViewportSize({ width: 1400, height: 900 });
    await pg.waitForTimeout(500);
    shots.push({ path: EVIDENCE_DIR + "typography-desktop-1400.png", fullPage: false });
    shots.push({ path: EVIDENCE_DIR + "typography-types-full.png", fullPage: true });

    const captured: string[] = [];
    for (const s of shots) {
      try {
        if (s.fullPage) {
          // 面板是 overflow:hidden 的应用布局,fullPage 只会拍到一屏——截图前临时放开聊天滚动容器的
          // 高度/溢出约束,让整条消息流进图;拍完立刻还原(不影响上面的 computed 断言)。
          await pg.evaluate(
            "(function(){var vt=document.getElementById('view-tasks');var cb=document.getElementById('chatBody');" +
            "window.__shotSnap={vh:vt?vt.style.height:'',vo:vt?vt.style.overflow:'',bh:document.body.style.height,bo:document.body.style.overflow,hh:document.documentElement.style.height,ho:document.documentElement.style.overflow};" +
            "if(vt){vt.style.height='auto';vt.style.overflow='visible';}" +
            "if(cb){cb.style.maxHeight='none';}" +
            "document.body.style.height='auto';document.body.style.overflow='visible';" +
            "document.documentElement.style.height='auto';document.documentElement.style.overflow='visible';})()",
          );
          await pg.waitForTimeout(300);
        }
        await pg.screenshot({ path: s.path, fullPage: s.fullPage });
        captured.push(s.path);
      } catch (e) {
        console.warn("[typography] 截图失败(不硬失败):" + s.path + " — " + String(e).slice(0, 160));
      } finally {
        if (s.fullPage) {
          await pg.evaluate(
            "(function(){var s=window.__shotSnap||{};var vt=document.getElementById('view-tasks');var cb=document.getElementById('chatBody');" +
            "if(vt){vt.style.height=s.vh||'';vt.style.overflow=s.vo||'';}" +
            "if(cb){cb.style.maxHeight='';}" +
            "document.body.style.height=s.bh||'';document.body.style.overflow=s.bo||'';" +
            "document.documentElement.style.height=s.hh||'';document.documentElement.style.overflow=s.ho||'';})()",
          ).catch(() => {});
          await pg.waitForTimeout(200);
        }
      }
    }

    // 窄视口图
    await pg.setViewportSize({ width: 375, height: 800 });
    await pg.waitForTimeout(600);
    const narrowShot = EVIDENCE_DIR + "typography-narrow-375.png";
    try {
      await pg.screenshot({ path: narrowShot });
      captured.push(narrowShot);
    } catch (e) {
      console.warn("[typography] 窄视口截图失败(不硬失败):" + String(e).slice(0, 160));
    }

    // 证据文件必须真的存在且 >10KB(空白图/丢图在这里暴露)
    for (const p of [EVIDENCE_DIR + "typography-desktop-1400.png", EVIDENCE_DIR + "typography-types-full.png", narrowShot]) {
      const st = statSync(p);
      expect(st.size, p + " 体积应 >10KB").toBeGreaterThan(10 * 1024);
    }
    expect(captured.length).toBeGreaterThanOrEqual(3);
  }, 90_000);
});
