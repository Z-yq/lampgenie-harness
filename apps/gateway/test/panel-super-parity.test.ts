import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PANEL_SRC } from "./panel-source.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** panel-source.ts 的 PARTS 尚未登记 script-super-chat.ts(既有缺口,不在本任务改动范围)——
 * 这里单独读该分片,保证 Super 输入链断言的覆盖面完整。 */
const SUPER_CHAT_SRC = readFileSync(join(HERE, "../src/panel/script-super-chat.ts"), "utf8");

/**
 * Super 聊天窗 × coding agent 聊天窗 对齐——同源契约层(验收②的前半)。
 * 真·双渲染 DOM 结构断言(同一段消息两侧真跑、统计类名层级/折叠节点数/按钮数)在
 * test/ui/super-parity-ime.spec.cjs:那里有真实 DOM,可直接把两侧产物挂进节点用
 * querySelector 计数,比 vm 桩 DOM 更可信(本仓 vitest 无 DOM 环境,不造 jsdom)。
 * 本文件守两件事,它们才是「两侧用同一份实现」的可证伪判据:
 * ①定义唯一:共享构建器全仓只有一份实现(出现第二份近似版即失败);
 * ②分支覆盖:Super 渲染主链(supRenderChatNow)与 coding 渲染主链(renderHistory)
 * 调用的是同一批构建器,Super 分支里不出现自写 markdown/表格/工具卡。
 * 另有输入链契约(G1 IME 守卫两处 / G2 roundGroupHtml 活跃参数 / G3 聚合卡结构 /
 * G4-G7 提交态·草稿·焦点·流式机制)逐条锚在源码上。
 */

const count = (s: string, needle: string) => s.split(needle).length - 1;

/** 花括号配平抽顶层函数体(同 canvas-shell.test.ts 的 extractFn 思路)。 */
function sliceFn(src: string, name: string): string {
  const head = "function " + name + "(";
  const at = src.indexOf(head);
  if (at < 0) throw new Error("未找到函数 " + name);
  let i = src.indexOf("{", at);
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  throw new Error("花括号未配平:" + name);
}

const SHARED = [
  "mdToHtml", "replyBlockHtml", "roundGroupHtml", "toolCallCard",
  "msgActsHtml", "msgSumBarHtml", "roundBindIn", "errLineRe", "toolResultBody",
];

describe("A① 共享构建器定义唯一(出现第二份近似实现即失败)", () => {
  it("九个共享函数全仓各只有一份 function 定义", () => {
    for (const fn of SHARED) {
      expect(count(PANEL_SRC, "function " + fn + "("), fn + " 应恰好一份实现").toBe(1);
    }
  });

  it("markdown 渲染单一入口:mdToHtml 之外无第二套表格/代码块拼装", () => {
 // 表格标记只出现在 mdToHtml(script-markdown)里
    const md = sliceFn(PANEL_SRC, "mdToHtml");
    expect(md.length).toBeGreaterThan(200);
 // Super 渲染主链不自写 <table>/<pre>(markdown 一律经 replyBlockHtml→mdToHtml)
    const sup = sliceFn(PANEL_SRC, "supRenderChatNow");
    expect(sup).not.toContain("<table");
    expect(sup).not.toContain("<pre");
    expect(sup).not.toContain("mdToHtml(");
  });
});

describe("A② 两侧渲染主链调用同一批构建器(分支覆盖)", () => {
  it("Super 侧 supRenderChatNow 走共享构建器", () => {
    const sup = sliceFn(PANEL_SRC, "supRenderChatNow");
    for (const fn of ["replyBlockHtml(", "roundGroupHtml(", "toolCallCard(", "msgSumBarHtml(", "msgActsHtml(", "roundBindIn("]) {
      expect(sup, "Super 渲染应使用 " + fn).toContain(fn);
    }
 // 聚合卡:自写卡片但同族类名(G3 起补 tc-ic/tc-fail),不新造类名前缀
    expect(sup).toContain("supToolAggCard(");
  });

  it("coding 侧 renderHistory 用同一批构建器(轮级组经 roundPartsWrap 统一套壳)", () => {
    const hist = sliceFn(PANEL_SRC, "renderHistory");
    for (const fn of ["replyBlockHtml(", "toolCallCard(", "msgSumBarHtml(", "msgActsHtml(", "roundPartsWrap("]) {
      expect(hist, "coding 渲染应使用 " + fn).toContain(fn);
    }
 // 轮级组在 coding 侧由 roundPartsWrap 套壳(它调 roundGroupHtml)——两侧最终同一构建器
    expect(sliceFn(PANEL_SRC, "roundPartsWrap")).toContain("roundGroupHtml(");
  });

  it("轮级组:两侧 roundGroupHtml 同签名调用(terminal/active/activeAt 三参齐)", () => {
    const sig = sliceFn(PANEL_SRC, "roundGroupHtml");
    for (const p of ["terminal", "active", "activeAt", "ROUND_LIVE_STEPS"]) expect(sig).toContain(p);
 // Super 两处调用都补了 active/activeAt(G2)
    expect(count(PANEL_SRC, "round:super:\" + supTurnSeq, !supState.waiting, supState.waiting")).toBe(2);
  });

  it("思考卡/错误行规则两侧同源(think-card 类 + errLineRe 行级标红)", () => {
    expect(count(PANEL_SRC, 'class="think-card"') + count(PANEL_SRC, "class=\"think-card")).toBeGreaterThanOrEqual(2);
 // errLineRe 被 markdown 围栏代码块与工具卡结果体两处共用
    expect(count(PANEL_SRC, "errLineRe(")).toBeGreaterThanOrEqual(2);
    expect(PANEL_SRC).toContain("code-err-line");
  });
});

describe("B 输入链契约", () => {
  it("G1:IME 组合期守卫两处(superInput 主输入 + sup-answer 行内回答),与 coding 侧同款", () => {
    expect(PANEL_SRC).toContain("if (e.isComposing || e.keyCode === 229) return;");
    const superKd = PANEL_SRC.indexOf('document.getElementById("superInput").addEventListener("keydown"');
    expect(superKd).toBeGreaterThan(0);
    expect(PANEL_SRC.slice(superKd, superKd + 700)).toContain("isComposing");
    const ansKd = PANEL_SRC.indexOf('wrap.querySelector("input")');
    expect(ansKd).toBeGreaterThan(0);
    expect(PANEL_SRC.slice(ansKd, ansKd + 700)).toContain("isComposing");
 // coding 侧基准仍在
    const codingKd = PANEL_SRC.indexOf('$("instruction").onkeydown');
    expect(PANEL_SRC.slice(codingKd, codingKd + 700)).toContain("isComposing");
  });

  it("G2:roundGroupHtml 两处调用均传 active/activeAt(Super 侧 live 语义对齐)", () => {
    expect(PANEL_SRC).toContain('roundGroupHtml(proc, "round:super:" + supTurnSeq, !supState.waiting, supState.waiting, m.ts || 0)');
    expect(PANEL_SRC).toContain('roundGroupHtml(proc, "round:super:" + supTurnSeq, !supState.waiting, supState.waiting, (group[group.length - 1] || {}).ts || 0)');
  });

  it("G3:聚合卡结构对齐标记(tc-ic 图标 / tc-fail 失败类 / 执行中图标)", () => {
    expect(PANEL_SRC).toContain("toolMetaOf(name) : null");
    expect(PANEL_SRC).toMatch(/'<span class="tc-ic">' \+ ic\(meta\.i\)/);
    expect(PANEL_SRC).toMatch(/tool-card' \+ \(anyErr \? " tc-fail" : ""\)/);
  });

  it("G4/G5/G7:提交中禁用+提示、sup:draft 草稿、发送后焦点回输入框", () => {
    expect(PANEL_SRC).toContain("function supSendBtnSync()");
    expect(PANEL_SRC).toContain('toast("Super 正在处理上一条,稍候再发(输入会保留)", true)');
    expect(count(PANEL_SRC, 'localStorage.setItem("sup:draft"')).toBeGreaterThanOrEqual(2); // input + quick 菜单
    expect(PANEL_SRC).toContain('localStorage.getItem("sup:draft")');
    expect(PANEL_SRC).toContain('localStorage.removeItem("sup:draft")');
    const seg = sliceFn(PANEL_SRC, "supSend");
    expect(seg).toContain("inp.focus()");
 // waiting 解除的三条路径都同步按钮态(done/error)
    expect(count(PANEL_SRC, "supState.waiting = false; supSendBtnSync()")).toBe(2);
  });

  it("G6:流式 live 气泡与 coding 侧同机制(整块重建+尾沿合并),不另造增量层", () => {
    expect(PANEL_SRC).toContain("function supStreamSync()");
    expect(PANEL_SRC).toContain('el.id = "supLiveStream"');
    expect(PANEL_SRC).toContain("supStreamTimer = setTimeout(function () { supStreamTimer = 0; supStreamSync(); }, 80)");
 // coding 侧 live 草稿同为整块拼装(同一套做法)
    expect(PANEL_SRC).toContain("liveDraft.text");
  });

  it("B3:粘贴/拖拽/附件入口与 coding 侧同路径(paste 只吞媒体文件、drop 阻止冒泡防重复添加)", () => {
    expect(SUPER_CHAT_SRC).toContain('ta.addEventListener("paste"');
    expect(SUPER_CHAT_SRC).toContain("e.stopPropagation(); // 防 document 级 drop 把同一文件再加进任务聊天窗附件");
    expect(SUPER_CHAT_SRC).toContain('box.addEventListener("dragover"');
 // 只吞图片/视频(文本粘贴保持原生,不抢用户粘贴的多行文字)
    expect(SUPER_CHAT_SRC).toContain('if (ty.indexOf("image/") !== 0 && ty.indexOf("video/") !== 0) continue;');
  });

  it("B5:连打不重复发送——waiting 同步置位 + 按键路径先判 waiting", () => {
    const seg = sliceFn(PANEL_SRC, "supSend");
    expect(seg.indexOf("if (supState.waiting)")).toBeGreaterThan(0);
    expect(seg.indexOf("supState.waiting = true")).toBeGreaterThan(seg.indexOf("if (supState.waiting)"));
  });
});