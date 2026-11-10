/**
 * 白板「节点勾选派发」+「flow 折叠态摘要」契约测试。
 * 锁住两条面:
 *  ①勾选派发:节点卡头 `.bd-sel` 复选框 + 工具条「已选 N 个」/「派发选中」(#bdDispatchSel,N=0 disabled)
 *    + 点派发走 board.continue 且带 nodeIds(照抄 boardContinue 的写法,只多一个字段)+ 成功清空/失败保留;
 *    勾选态只在模块级 Set(bdSel)里,不进 board.save 的 nodes(纯 UI 态,重绘后从 Set 恢复)。
 *  ②flow 可见性:节点卡折叠态就能看到「分支 N / 循环 M」(bdFlowStat 递归统计),点开复用 bdFlowHtml;
 *    cond/over 为空串时不出现「如果」这类空标签。
 * 与 panel-board-live.test.ts 同构:页面函数从真实面板 HTML 里花括号配平切出后 new Function 执行,
 * 既断源码关键字也跑真实语义(MVP 行为)。零反斜杠纪律:全部 includes 字面断言。
 */
import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";

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

const NL = String.fromCharCode(10);

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

describe("白板节点勾选派发 + flow 可见性", () => {
  it("①工具条:已选 N 个 + 派发选中(N=0 disabled),节点卡头有 .bd-sel 复选框", async () => {
    await withPanel(7981, (html) => {
      // 工具条控件(静态 HTML 里就在位,首屏即可见/可禁用)
      expect(html).toContain('id="bdSelCount"');
      expect(html).toContain('id="bdDispatchSel"');
      expect(html).toContain("已选 0 个");
      expect(html).toContain('id="bdDispatchSel" disabled');
      expect(html).toContain('class="bd-sel-bar"');
      // 节点卡头复选框:cardOf 里按 bdSel 恢复 checked
      const rb = extractFn(html, "renderBoard");
      expect(rb).toContain('class="bd-sel"');
      expect(rb).toContain('data-sel="');
      expect(rb).toContain("bdSel.has(n.id)");
      expect(rb).toContain('" checked"');
      // 勾选事件:stopPropagation(点勾不触发点卡)+ 只动 Set + 刷计数
      expect(rb).toContain('querySelectorAll(".bd-sel")');
      expect(rb).toContain("e.stopPropagation()");
      expect(rb).toContain("bdSel.add(");
      expect(rb).toContain("bdSel.delete(");
      // 纯 UI 态:Set 声明在位,且不被写进 board.save 的 doc
      expect(html).toContain("const bdSel = new Set();");
      const save = extractFn(html, "boardSave");
      expect(save).not.toContain("bdSel");
      // 计数/按钮可用性:bdSelRender 单一出处
      const render = extractFn(html, "bdSelRender");
      expect(render).toContain('"已选 " + bdSel.size + " 个"');
      expect(render).toContain("btn.disabled = bdSel.size === 0");
      // 重绘漏斗(renderBoard)里同步一次:切板/board.doc 回填后勾选态自动恢复
      expect(rb).toContain("bdSelRender();");
      // 按钮接线
      expect(html).toContain('$("bdDispatchSel").onclick');
    });
  }, 30_000);

  it("②派发:board.continue 带 nodeIds;成功(task.submitted)清空勾选,失败(error 帧)保留", async () => {
    await withPanel(7982, async (html) => {
      const fnSrc = extractFn(html, "bdSelRender") + NL + extractFn(html, "bdDispatchSel");
      const prelude = `
        const bdSel = new Set();
        var boardDoc = { nodes: [{ id: "a" }, { id: "b" }, { id: "c" }] };
        var currentSid = "s1", boardTaskId = "t1";
        var sent = [], toasts = [];
        function $(id) { return { textContent: "", disabled: false, id: id }; }
        function toast(t, isErr) { toasts.push(String(t) + (isErr ? "!" : "")); }
        function uiPrompt() { return Promise.resolve("把这两个节点先做掉"); }
        function wsSafeSend(p) { sent.push(p); }
        function renderBoard() {}
        function setTimeout(fn, ms) { return 0; } // 12s 兜底计时器不进真实定时器(防测试进程挂 handle)
        var ws = { ls: [], addEventListener(t, f) { this.ls.push(f); }, removeEventListener(t, f) { this.ls = this.ls.filter(function (x) { return x !== f; }); } };
      `;
      const api = new Function(prelude + NL + fnSrc + NL + "return { bdSel: bdSel, send: bdDispatchSel, ls: function () { return ws.ls; }, sent: function () { return sent; }, toasts: function () { return toasts; }, doc: function () { return boardDoc; } };")() as {
        bdSel: Set<string>;
        send: () => void;
        ls: () => Array<((ev: { data: string }) => void)>;
        sent: () => string[];
        toasts: () => string[];
        doc: () => { nodes: { id: string }[] };
      };

      // 空勾选:直接拒绝,不发消息
      api.send();
      await new Promise((r) => setTimeout(r, 0));
      expect(api.sent().length).toBe(0);

      // 勾两个 → 派发:消息体 = board.continue + nodeIds
      api.bdSel.add("a");
      api.bdSel.add("c");
      api.send();
      await new Promise((r) => setTimeout(r, 0));
      expect(api.sent().length).toBe(1);
      const msg = JSON.parse(api.sent()[0]!) as { v: number; type: string; sessionId: string; taskId: string; note: string; nodeIds: string[] };
      expect(msg.v).toBe(1);
      expect(msg.type).toBe("board.continue");
      expect(msg.sessionId).toBe("s1");
      expect(msg.taskId).toBe("t1");
      expect(msg.note).toBe("把这两个节点先做掉");
      expect(msg.nodeIds).toEqual(["a", "c"]);

      // 失败(error 帧):勾选保留
      const listener = api.ls()[0]!;
      expect(typeof listener).toBe("function");
      listener({ data: JSON.stringify({ type: "error", code: "board-not-found", message: "白板不存在" }) });
      expect(Array.from(api.bdSel)).toEqual(["a", "c"]);
      expect(api.ls().length).toBe(0); // 一次性监听已撤(不泄漏)

      // 再来一次,成功(task.submitted 命中当前会话):清空勾选
      api.send();
      await new Promise((r) => setTimeout(r, 0));
      const l2 = api.ls()[0]!;
      l2({ data: JSON.stringify({ type: "task.submitted", task: { id: "tk1", sessionId: "s1" } }) });
      expect(Array.from(api.bdSel)).toEqual([]);
      // 别的会话的 task.submitted 不算本板的成功回执(不清空)
      api.bdSel.add("b");
      api.send();
      await new Promise((r) => setTimeout(r, 0));
      const l3 = api.ls()[0]!;
      l3({ data: JSON.stringify({ type: "task.submitted", task: { id: "tk2", sessionId: "other" } }) });
      expect(Array.from(api.bdSel)).toEqual(["b"]);
    });
  }, 30_000);

  it("③flow 可见性:节点卡折叠态给「分支 N / 循环 M」摘要,展开复用 bdFlowHtml;空 cond/over 不出现空标签", async () => {
    await withPanel(7983, (html) => {
      // 摘要行挂进节点卡(与验收摘要同级);有 flow 才出
      const rb = extractFn(html, "renderBoard");
      expect(rb).toContain("bdFlowSumHtml(n)");
      const sum = extractFn(html, "bdFlowSumHtml");
      expect(sum).toContain("bdFlowStat(n.flow)");
      expect(sum).toContain('"分支 "');
      expect(sum).toContain('"循环 "');
      expect(sum).toContain('class="bd-flowsum"');
      expect(sum).toContain("bdFlowHtml(n.flow, 0)"); // 展开复用既有递归块,不另起渲染
      expect(html).toContain(".bd-flowsum summary");
      // 递归统计:branch 计 then/else 子块,loop 计 body 子块
      const stat = extractFn(html, "bdFlowStat");
      expect(stat).toContain('s.type === "branch"');
      expect(stat).toContain('s.type === "loop"');
      expect(stat).toContain("walk(s.then)");
      expect(stat).toContain("walk(s.else)");
      expect(stat).toContain("walk(s.body)");
      // 空 cond/over 兜底:不再渲染「如果 ?」这种空标签
      const flow = extractFn(html, "bdFlowHtml");
      expect(flow).toContain("(条件略)");
      expect(flow).toContain("(集合略)");

      // 行为:统计 + 摘要文案 + 递归 HTML(用真实函数跑)
      const src = 'function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }' + NL +
        flow + NL + stat + NL + sum;
      const api = new Function(src + NL + "return { stat: bdFlowStat, sum: bdFlowSumHtml, html: bdFlowHtml };")() as {
        stat: (s: unknown[]) => { branch: number; loop: number; step: number; total: number };
        sum: (n: unknown) => string;
        html: (s: unknown[], d: number) => string;
      };
      const flowTree = [
        { type: "step", text: "建 journal" },
        { type: "branch", cond: "任务到终态", then: [{ type: "branch", cond: "ok", then: [] }], else: [{ type: "step", text: "重试" }] },
        { type: "loop", over: "待办项", body: [{ type: "loop", over: "子项", body: [] }] },
      ];
      expect(api.stat(flowTree)).toEqual({ branch: 2, loop: 2, step: 2, total: 6 });
      const cardHtml = api.sum({ id: "x", flow: flowTree });
      expect(cardHtml).toContain("分支 2");
      expect(cardHtml).toContain("循环 2");
      expect(cardHtml).toContain("步骤 2");
      expect(cardHtml).toContain("建 journal"); // 展开块内容已在 details 内
      expect(cardHtml).toContain("如果 任务到终态");
      expect(cardHtml).toContain("否则");
      expect(cardHtml).toContain("循环 待办项");
      // 无 flow = 零 HTML(不给空 details 占位)
      expect(api.sum({ id: "y" })).toBe("");
      expect(api.sum({ id: "z", flow: [] })).toBe("");
      // 空 cond/over:兜底文案而非「如果 ?」/「循环 ?」
      const bare = api.html([{ type: "branch", cond: "", then: [] }, { type: "loop", over: "   ", body: [] }], 0);
      expect(bare).toContain("如果 (条件略)");
      expect(bare).toContain("循环 (集合略)");
      expect(bare).not.toContain("如果 ?");
      expect(bare).not.toContain("循环 ?");
    });
  }, 30_000);
});