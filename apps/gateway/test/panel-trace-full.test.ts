/**
 * 轨迹看板「逐次 LLM 决策」卡体渲染契约(step-1026)。
 *
 * 取码方式与 panel-traj-board.test.ts 同构:面板是单 HTML,浏览器侧函数就在源码里 ——
 * GET / 拿真 HTML → 花括号配平抽函数源码 → 与 TRAJ_MODEL_JS 一起 new Function 求值,
 * 断的是「真函数真渲染」而不是页面上有没有这几个字。
 *
 * 覆盖(用户口径逐条):
 *  ①干条:序号/turn-step/模型/耗时/首字/输入(缓存,命中%)/输出/工具名/错误红标
 *  ②未命中输入:已命中前缀一行(条数+约 tok),其后消息逐条全文、不截断
 *  ③长 tool 结果:首尾都在(证明没截断)
 *  ④输出:content 全文 + toolCalls name/arguments + reasoning 截断 600 字带标记 + error 全文
 *  ⑤转义:正文里的 <script> 不得变成真标签;零 emoji
 *  ⑥折叠/展开:折叠态只有干条无卡体;展开态有卡体
 */
import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";
import { TRAJ_MODEL_JS } from "../src/panel-traj-model.js";

const NL = String.fromCharCode(10);

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

/** 抽出卡片渲染族 + 注入数据层,放进同一函数作用域求值(等同浏览器侧可见性)。 */
function loadCardFns(html: string): Record<string, any> {
  const names = [
    "trajBoardTurnHeadHtml", "trajBoardCardHeadHtml", "trajBoardThinkHtml", "trajBoardArgsText",
    "trajBoardBodyHtml", "trajBoardCardHtml", "trajBoardCardsHtml", "filterDecisionRows",
  ];
  const srcs = names.map((n) => extractFn(html, n)).join(NL);
  const body = "function esc(s){return String(s==null?'':s)"
    + ".replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');}" + NL
    + "const trajBoardState={rows:[],turns:[],view:[],files:[],ord:{},q:'',mode:'all',pane:'decisions'};" + NL
    + "const trajExpanded=new Set();const trajTraceCache=new Map();" + NL
    + "const TRAJ_THINK_CAP=600;const TRAJ_EXPAND_ALL_MAX=30;" + NL
    + TRAJ_MODEL_JS + NL + srcs + NL
    + "return {" + names.join(",") + "};";
  // eslint-disable-next-line no-new-func
  return new Function(body)() as Record<string, any>;
}

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{2300}-\u{23FF}]/u;
const ALLOW = new Set(["✓", "✗", "✕", "→", "←", "↑", "↓", "↵", "⇤", "⇥", "↳", "⎇", "■", "»", "…", "⚠", "☰", "♥", "⚙", "⌕", "⌄", "◇", "▶", "●", "▤", "◈", "▣", "✂"]);
function emojiBad(s: string): string[] {
  return [...s].filter((ch) => EMOJI.test(ch) && !ALLOW.has(ch));
}

/** 一行轨迹行(llm.trace 摘要形状)。 */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq: 12, idx: 3, turn: 2, kind: "model", label: "claude-sonnet", summary: "t2s1 · 改好了 · 调用:2",
    at: 1000, durationMs: 1850, ttftMs: 320, inputTokens: 42500, cachedTokens: 39680, outputTokens: 228,
    status: "ok", traceFile: "/repo/.genie/llm-trace/web-1/call-0003-t2s1-1.json",
    stepNo: 1, tools: ["read_file", "terminal"], ...over,
  };
}

/** trace 文件形状(实测:content/toolCalls/usage/reasoning;messages 三种 key 形态)。 */
function trace(cur: unknown[], prevExtra: unknown[] = []): unknown {
  return {
    ts: 1793888000000, sessionId: "web-1", turn: 2, step: 1, model: "claude-sonnet",
    durationMs: 1850, ttftMs: 320,
    request: { messageCount: prevExtra.length + cur.length, messages: [...prevExtra, ...cur] },
    response: {
      content: "改好了:两处都修了。",
      toolCalls: [{ id: "call_1", name: "read_file", arguments: '{"path":"a.ts","limit":40}' }],
      reasoning: "x".repeat(1500),
      usage: { inputTokens: 42500, cachedTokens: 39680, outputTokens: 228 },
    },
  };
}

const SYS = { role: "system", content: "你是 lampgenie-harness 的 vibe coding 主 agent。" };
const USR = { role: "user", content: "把轨迹看板做成逐次决策平铺" };
const AST = { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"a.ts"}' }] };
const TOOL = { role: "tool", toolCallId: "c1", content: "HEAD-" + "z".repeat(4000) + "-TAIL" };

describe("轨迹看板逐次决策卡(step-1026)", () => {
  it("①干条:序号/turn-step/模型/耗时/首字/token/工具名/错误红标", async () => {
    await withPanel(7898, (html) => {
      const fn = loadCardFns(html);
      const head = fn.trajBoardCardHeadHtml(row(), 7, false);
      for (const w of ["#7", "t2 s1", "claude-sonnet", "耗时 1.9s", "首字 320ms", "输入 42.5K", "缓存 39.7K", "命中 93.4%", "输出 228", "read_file", "terminal", "展开全文"]) {
        expect(head, "干条缺:" + w).toContain(w);
      }
      const err = fn.trajBoardCardHeadHtml(row({ status: "error", error: "provider 429" }), 1, true);
      expect(err).toContain('class="bad"');
      expect(err).toContain("收起");
      // 无 token 字段(失败态 trace)也不出 NaN / undefined
      const bare = fn.trajBoardCardHeadHtml(row({ inputTokens: undefined, cachedTokens: undefined, outputTokens: undefined, durationMs: undefined, ttftMs: undefined, tools: [] }), 1, false);
      expect(bare).not.toContain("undefined");
      expect(bare).not.toContain("NaN");
      expect(bare).toContain("无工具调用");
    });
  }, 30_000);

  it("②已命中前缀一行 + 未命中输入逐条全文(不截断);③长 tool 结果首尾都在", async () => {
    await withPanel(7899, (html) => {
      const fn = loadCardFns(html);
      // 上一请求 = SYS + USR + AST + TOOL;本次在其后追加一条 user(尾部新增)
      const prev = { request: { messages: [SYS, USR, AST, TOOL] }, response: {} };
      const cur = trace([SYS, USR, AST, TOOL, { role: "user", content: "继续" }]);
      const body = fn.trajBoardBodyHtml(row(), cur, prev);
      expect(body).toContain("未命中输入");
      expect(body).toContain("已命中前缀:4 条");
      expect(body).toContain("tok(已省略)");
      // 未命中段 = 只有最后那条「继续」,前缀段(含 4000 字 tool 结果)已省略
      expect(body).toContain("继续");
      expect(body).not.toContain("HEAD-zzzz");
      // 输出段全文 + 工具参数 JSON 美化 + thinking 截断标记
      expect(body).toContain("输出");
      expect(body).toContain("改好了:两处都修了。");
      expect(body).toContain("&quot;path&quot;: &quot;a.ts&quot;");
      expect(body).toContain("思考已截断,共 1500 字");
      // 首调(prev 空):全部消息逐条全文,长 tool 结果首尾都在
      const first = fn.trajBoardBodyHtml(row(), trace([SYS, USR, AST, TOOL]), null);
      expect(first).toContain("已命中前缀:0 条");
      expect(first).toContain("HEAD-");
      expect(first).toContain("-TAIL");
      expect(first).toContain('<span>c1</span>'); // tool 消息头带 toolCallId(便于对齐 tool.call)
      expect(emojiBad(body)).toEqual([]);
      expect(emojiBad(first)).toEqual([]);
    });
  }, 30_000);

  it("④未命中正文不出现截断省略号;thinking 单独截断;⑤转义与零 emoji", async () => {
    await withPanel(7900, (html) => {
      const fn = loadCardFns(html);
      const evil = { role: "tool", toolCallId: "c9", content: "<script>alert(1)</script>" + "y".repeat(3000) + "END-MARK" };
      const cur = trace([SYS, USR, evil]);
      const body = fn.trajBoardBodyHtml(row(), cur, null);
      expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(body).not.toContain("<script>alert(1)</script>");
      expect(body).toContain("END-MARK");
      // 正文段里不能出现「…(已截断)」这类截断标记(thinking 的那条除外)
      const bodyOnly = body.split("思考")[0];
      expect(bodyOnly).not.toContain("截断");
      expect(emojiBad(body)).toEqual([]);
    });
  }, 30_000);

  it("⑥折叠态只有干条无卡体;展开态出现卡体;错误卡带红框", async () => {
    await withPanel(7901, (html) => {
      const fn = loadCardFns(html);
      const folded = fn.trajBoardCardHtml(row(), 3, { expanded: false });
      expect(folded).toContain('class="tb-card');
      expect(folded).toContain('data-trace-file="/repo/.genie/llm-trace/web-1/call-0003-t2s1-1.json"');
      expect(folded).not.toContain("tb-c-body");
      const open = fn.trajBoardCardHtml(row(), 3, { expanded: true, loading: true });
      expect(open).toContain("tb-c-body");
      expect(open).toContain("正文加载中");
      const done = fn.trajBoardCardHtml(row(), 3, { expanded: true, trace: trace([SYS, USR]), prevTrace: null });
      expect(done).toContain("未命中输入");
      expect(done).toContain("输出");
      expect(done).toContain("复制路径");
      const errCard = fn.trajBoardCardHtml(row({ status: "error" }), 4, { expanded: false });
      expect(errCard).toContain('class="tb-card err"');
      // 行表视图的过滤语义仍可用(工具/错误过滤在同一行池上工作)
      const rows = [row(), row({ idx: 4, traceFile: "/x/2.json", tools: [] }), row({ idx: 5, traceFile: "/x/3.json", status: "error" })];
      expect(fn.filterDecisionRows(rows, "tool", "").length).toBe(2);
      expect(fn.filterDecisionRows(rows, "error", "").length).toBe(1);
      expect(fn.filterDecisionRows(rows, "all", "read_file").length).toBe(2);
    });
  }, 30_000);

  it("⑦实时追加:新决策只加一张卡;底部才滚底,上滚不抢滚;无变化不重渲", async () => {
    await withPanel(7903, (html) => {
      const srcs = ["trajBoardLiveSync", "trajBoardOn"].map((n) => extractFn(html, n)).join(NL);
      const body = "let histEvents=[{seq:1,kind:'llm.trace',payload:{file:'/t/a.json'}}];" + NL
        + "const trajExpanded=new Set();" + NL
        + "const host={scrollTop:0,clientHeight:100,scrollHeight:200};" + NL
        + "const box={style:{display:'flex'}};" + NL
        + "function $(id){return id==='trajBoard'?box:id==='trajCardsHost'?host:null;}" + NL
        + "let refreshCount=0;const trajBoardState={filesKey:''};" + NL
        + "function trajBoardRefresh(){refreshCount++;trajBoardState.filesKey=histEvents.map(function(e){return String(e.payload.file);}).join('|');}" + NL
        + srcs + NL
        + "return {live:trajBoardLiveSync,on:trajBoardOn,host:host,box:box,expanded:trajExpanded,state:trajBoardState,count:function(){return refreshCount;},set:function(v){histEvents=v;}};";
      // eslint-disable-next-line no-new-func
      const t = new Function(body)() as Record<string, any>;
      // 首帧:看板在场 → 一次渲染,最新(唯一)卡自动展开
      t.live();
      expect(t.count()).toBe(1);
      expect(t.expanded.has("/t/a.json")).toBe(true);
      // 无新增再调:不重渲(filesKey 未变)
      t.live();
      expect(t.count()).toBe(1);
      // 底部时新决策到达:滚到底
      t.host.scrollTop = 100; // 100+100 >= 200-12 = 底部
      t.set([{ seq: 1, kind: "llm.trace", payload: { file: "/t/a.json" } }, { seq: 2, kind: "llm.trace", payload: { file: "/t/b.json" } }]);
      t.live();
      expect(t.count()).toBe(2);
      expect(t.expanded.has("/t/b.json")).toBe(true);
      expect(t.host.scrollTop).toBe(200);
      // 上滚阅读时新决策到达:不抢滚(内容仍就位)
      t.host.scrollTop = 10;
      t.set([{ seq: 1, kind: "llm.trace", payload: { file: "/t/a.json" } }, { seq: 2, kind: "llm.trace", payload: { file: "/t/b.json" } }, { seq: 3, kind: "llm.trace", payload: { file: "/t/c.json" } }]);
      t.live();
      expect(t.count()).toBe(3);
      expect(t.expanded.has("/t/c.json")).toBe(true);
      expect(t.host.scrollTop).toBe(10);
      // 看板关闭:零渲染
      t.box.style.display = "none";
      expect(t.on()).toBe(false);
      t.set([]);
      t.live();
      expect(t.count()).toBe(3);
    });
  }, 30_000);
});
