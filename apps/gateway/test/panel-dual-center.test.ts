/**
 * 双中心布局(会话流+IDE 并列常驻)契约测试 —— PAGE 源码字符串断言。
 * 覆盖:①双栏 CSS(body.dual-center/--dual-chatw/窄屏降级) ②路由分流(switchView("ide")→右栏开合
 * 不改 data-view) ③viewLive dual 分支(右栏 IDE 判活,防 WS 停更) ④拖拽条(夹紧+localStorage 持久化)
 * ⑤Monaco 重排兜底(ideLayoutKick+ResizeObserver) ⑥刷新还原(savedView=ide 不拽走身份) ⑦入口按钮。
 * 风格照抄 panel-ide-deep.test.ts:servePanel 取真实面板 HTML,再做字符串/函数体断言(零构建链)。
 */
import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";

/** 从面板 HTML 里切出顶层函数源码(花括号配平),用于断言函数体内行为。 */
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
  const srv = servePanel(port, () => { /* 不需要 WS */ });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    return await fn(await res.text());
  } finally {
    await srv.close();
  }
}

describe("双中心布局:会话流+IDE 并列常驻", () => {
  it("①分栏 CSS:body.dual-center 双栏 + --dual-chatw + 立绘让位 + 窄屏降级", async () => {
    await withPanel(7901, (html) => {
      // 双栏核心:分隔条仅在「会话流」视图 + dual 态显示;chat 固定宽/ide flex:1
      expect(html).toContain('body.dual-center[data-view="chat"] #dualSplit');
      expect(html).toContain("body.dual-center #view-tasks.on");
      expect(html).toContain("var(--dual-chatw");
      expect(html).toContain("body.dual-center #view-ide.on");
 // 指挥台让位(复用 board 先例)+ 页面右距释放(数字人立绘已退役,改 #sc-root)
      expect(html).toContain("body.dual-center #sc-root");
      // 窄屏降级两档:≤1400 收窄;≤1150 禁双栏
      expect(html).toContain("@media (max-width:1400px)");
      expect(html).toContain("@media (max-width:1150px)");
      // DOM:分隔条在 .middle 内,#view-tasks 之后
      const iTasks = html.indexOf('id="view-tasks"');
      const iSplit = html.indexOf('id="dualSplit"');
      expect(iSplit).toBeGreaterThan(iTasks);
    });
  });

  it("②路由分流:双栏开启时 switchView(\"ide\") 只切右栏,不改视图身份", async () => {
    await withPanel(7902, (html) => {
      const sv = extractFn(html, "switchView");
      expect(sv).toContain('name === "ide" && dualOpen');
      expect(sv).toContain("dualToggle(); return;");
      const chrome = extractFn(html, "applyViewChrome");
      expect(chrome).toContain('dualOpen && v === "ide" && name === "chat"'); // 右栏与当前视图并列 .on
    });
  });

  it("③viewLive 放宽:双栏开启时右栏 IDE 判活(防 SCM/问题/诊断 WS 停更)", async () => {
    await withPanel(7903, (html) => {
      const vl = extractFn(html, "viewLive");
      expect(vl).toContain('dualOpen && document.body.classList.contains("dual-center") && n === "ide"');
    });
  });

  it("④拖拽条:360/280 夹紧 + localStorage 持久化 + 双击收起", async () => {
    await withPanel(7904, (html) => {
      expect(html).toContain('id="dualSplit"');
      expect(html).toContain("pointerdown");
      expect(html).toContain("Math.min(max, e2.clientX)");
      expect(html).toContain("Math.max(DUAL_CHAT_MIN");
      expect(html).toContain("dualWriteLS(DUAL_LS_W"); // 松手持久化栏宽
      expect(html).toContain("sp.ondblclick = () => dualToggle(false)"); // 双击收起右栏
      // 开合态持久化 key
      expect(html).toContain('"dualCenter.open"');
      expect(html).toContain('"dualCenter.w"');
    });
  });

  it("⑤Monaco 重排兜底:ideLayoutKick + ResizeObserver 观测 ideBody", async () => {
    await withPanel(7905, (html) => {
      const kick = extractFn(html, "ideLayoutKick");
      expect(kick).toContain("ideMonaco.editor.layout()");
      expect(html).toContain('ResizeObserver(() => ideLayoutKick()).observe(body)');
      expect(html).toContain('$("ideBody")');
    });
  });

  it("⑥刷新还原:开合态恢复 + savedView=ide 不拽走视图身份", async () => {
    await withPanel(7906, (html) => {
      expect(html).toContain('dualReadLS(DUAL_LS_OPEN, "0") === "1"'); // 启动恢复开合态
      expect(html).toContain("window.innerWidth > 1400"); // ≤1400 不自动展开
      expect(html).toContain('savedView === "ide" && dualOpen'); // 刷新落右栏态:重开右栏而非改 data-view
    });
  });

  it("⑦入口:IDE 头部「双栏」按钮 + 窄屏守卫提示", async () => {
    await withPanel(7907, (html) => {
      expect(html).toContain('btn.id = "ideDualBtn"');
      expect(html).toContain("btn.onclick = (e3) => { e3.stopPropagation(); dualToggle(); }");
      const tg = extractFn(html, "dualToggle");
      expect(tg).toContain("dualAllowed()"); // ≤1150 禁双栏守卫
      expect(tg).toContain('classList.toggle("dual-center"');
      expect(tg).toContain('loadViewData("ide")'); // 展开即补位数据
    });
  });
});
