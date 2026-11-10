/**
 * 面板渲染缺陷修复批契约测试:
 *  ①超宽消息行换行约束(事件元信息行/工具行块 CSS);
 *  ②终端转轮帧折叠去重(foldTermFrames 连续注记合并/幂等/计数);
 *  ③白板入口画布分流(boardEntryGo:画布=定位白板卡,经典=浮窗);
 *  ④双导航融合(cvRail 退役后面板侧承接:cv-cards 监听/托盘状态点/连接点/托盘最小化钮);
 *  ⑤画布形态分身独立看板(Chat 卡过滤子代理来源 + 分身卡消息流容器)。
 * 页面函数从真实面板 HTML 提取(extractFn 花括号配平,与 canvas-shell.test.ts 同构)后 new Function 执行。
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
const F1 = String.fromCharCode(0x280b), F2 = String.fromCharCode(0x2819), F3 = String.fromCharCode(0x2839);

async function withPanel<T>(port: number, fn: (html: string) => T | Promise<T>): Promise<T> {
  const srv = servePanel(port, () => { /* 不需要 WS */ });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    return await fn(await res.text());
  } finally {
    await srv.close();
  }
}

describe("面板渲染缺陷修复批(2026-10-21)", () => {
  it("①超宽消息行:事件行/工具行块带换行约束;代码块 nowrap 白名单保留", async () => {
    await withPanel(7891, (html) => {
      // .task-sub/.ev-line(事件元信息行)与 .tr-lines .cl(工具行块)必须有强制换行
      expect(html).toContain(".task-sub,.ev-line{overflow-wrap:anywhere;word-break:break-word}");
      expect(html).toContain(".tr-lines .cl{overflow-wrap:anywhere}");
      expect(html).toContain(".tool-card .tc-body,.tool-group .tg-item .tc-body{overflow-wrap:anywhere}");
      // 白名单:nowrapcode 模式的 pre.code 仍是 nowrap+横向滚动(代码块可滚不撑破卡片)
      expect(html).toContain("body.nowrapcode pre.code{white-space:pre;overflow-x:auto}");
    });
  }, 30_000);

  it("②折叠注记去重:连续/空行分隔/已有注记并入/幂等/短于3帧保留", async () => {
    await withPanel(7892, (html) => {
      const src = extractFn(html, "foldTermFrames");
      const fold: (t: string) => string = new Function(src + NL + "return foldTermFrames;")() as (t: string) => string;
      const frames = [F1, F2, F3, String.fromCharCode(0x2838), String.fromCharCode(0x283c)];
      // 连续帧:一段折叠成单注记(计数=帧数)
      expect(fold(frames.join(NL))).toBe("（已折叠 5 帧转轮动画）");
 // 空行分隔的两段:合并为一个注记、帧数累加(经验证重复标签主诉)
      expect(fold(frames.join(NL) + NL + NL + frames.join(NL))).toBe("（已折叠 10 帧转轮动画）");
      // 输入里已是注记:与后续帧段合并累加(重复折叠幂等,不增殖)
      expect(fold("（已折叠 7 帧转轮动画）" + NL + NL + frames.join(NL))).toBe("（已折叠 12 帧转轮动画）");
      expect(fold(fold(frames.join(NL)))).toBe("（已折叠 5 帧转轮动画）");
      // 短于 3 帧不折叠(原行为不回退);真实内容行隔开的两段不合并
      expect(fold(F1 + NL + F2)).toBe(F1 + NL + F2);
      const keep = fold(F1 + NL + "普通行" + NL + frames.slice(0, 3).join(NL) + NL + "另一普通行");
      expect(keep).toContain("普通行");
      expect(keep).toContain("（已折叠 3 帧转轮动画）");
      const apart = fold(frames.slice(0, 3).join(NL) + NL + "真实输出行" + NL + frames.slice(0, 3).join(NL));
      expect((apart.match(/已折叠/g) || []).length).toBe(2); // 有内容隔开=两个独立注记,合并不越权
      // 无帧文本原样
      expect(fold("abc" + NL + "def")).toBe("abc" + NL + "def");
    });
  }, 30_000);

  it("③白板入口画布分流:画布=CanvasShell.focus 白板卡,经典=boardOpenTask 浮窗", async () => {
    await withPanel(7893, (html) => {
      const src = extractFn(html, "boardEntryGo");
      expect(src).toContain("isCanvas()");
      expect(src).toContain('cv.focus("board"');
      expect(src).toContain("boardOpenTask(id)"); // 经典/异常回退原入口(浮窗行为不变)
      // 两个入口都接分流:composer 白板 pill 与任务卡 board-chip
      expect(html).toContain('$("boardFloatBtn").onclick = () => boardEntryGo("")');
      expect(html).toContain('boardEntryGo(bc.dataset.boardTask || "")');
      // 编辑中切板仍走确认链(不静默丢草稿)
      expect(src).toContain("boardEditOn");
    });
  }, 30_000);

  it("④双导航融合:面板侧承接 cvRail 职责(灰态/状态点/连接点/最小化钮)", async () => {
    await withPanel(7894, (html) => {
      // 隐藏卡唤回:cv-cards 监听 → 托盘按钮置灰(cv-card-off)
      expect(html).toContain('window.addEventListener("cv-cards"');
      expect(html).toContain(".sb-act.cv-card-off");
      // 卡片状态点迁托盘:CV_TRAY_ACT 映射 + cv-bad/cv-warn 点
      expect(html).toContain("const CV_TRAY_ACT = {");
      expect(html).toContain(".sb-act.cv-bad::after");
      // 连接点下沉托盘品牌点(画布形态 header 隐藏)
      expect(html).toContain("#sidebar.cv-conn-ok .brand-dot");
      const conn = extractFn(html, "cvConn");
      expect(conn).toContain("cv-conn-ok");
      expect(conn).not.toContain("CanvasShell.setConn"); // 旧 rail 通路退役
      // 托盘自带最小化钮(收起为 #sbRail 细条,不依赖 cvRail)
      expect(html).toContain("cv-tray-min");
      expect(html).toContain("btn.onclick = () => toggleSidebar()");
    });
  }, 30_000);

  it("⑤子agent会话流独立卡:Chat 卡画布过滤 + 独立卡容器/未读/定位", async () => {
    await withPanel(7895, (html) => {
      // 会话流过滤开关:renderHistory 内 cvHideSub = canvasActive()
      expect(html).toContain("const cvHideSub = canvasActive();");
      // 过滤点:子代理→主代理交互卡(system-reminder)/spawn 过程卡/终态卡/三类工具回显
      expect(html).toContain('if (cvHideSub && (c.name === "spawn_subagent" || c.name === "answer_subagent")) continue;');
      expect(html).toContain('if (cvHideSub && (ev.payload.name === "spawn_subagent" || ev.payload.name === "answer_subagent" || ev.payload.name === "task_output")) continue;');
      expect(html).toContain("if (cvHideSub) continue; // 画布形态:终态文本由子agent会话流卡分组尾承载");
      // 独立卡:CV_CARDS 规格 + 视图宿主 + 渲染/定位/未读(分身卡回归纯目录,不再挂消息流)
      expect(html).toContain('{ name: "subchat", node: "view-subchat", title: "子代理会话流"');
      expect(html).toContain('id="view-subchat"');
      expect(html).toContain('id="subchat-body"');
      expect(html).not.toContain('id="sub-msgs"');
      expect(html).toContain("function subMsgRender()");
      expect(html).toContain('const host = $("subchat-body");');
      expect(html).toContain("function subMsgLocate(");
      expect(html).toContain("let subMsgUnread = 0;");
      expect(html).toContain("subMsgSync(evs)");
      // 画布专属:经典布局整卡隐藏 + 托盘按钮隐藏;目录条目画布分流(跨卡定位分组,不开工作区 tab)
      expect(html).toContain("body:not(.cv-shell) #view-subchat{display:none}");
      expect(html).toContain("body:not(.cv-shell) #act-subchat{display:none}");
      expect(html).toContain('if (name === "subchat") subMsgRender();');
      expect(html).toContain('CV_TRAY_ACT = { git: "act-git"');
      expect(html).toContain('subchat: "act-subchat"');
      expect(html).toContain("if (canvasActive() && subMsgLocate(aid)) return;");
    });
  }, 30_000);
});
