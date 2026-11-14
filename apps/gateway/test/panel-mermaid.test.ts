/**
 * 消息流 mermaid 懒加载渲染契约测试:
 *  ① mdToHtml 对 ```mermaid 围栏产 .md-mermaid 占位节点且 data-src 完整保留源文本(HTML 转义形态);
 *  ② 普通 ```js 代码块路径零改动(is-code 板 + span.cl 行 + 复制钮);
 *  ③ 未闭合 ```mermaid 不炸(单遍状态机尾部 renderCodeBlock 路径);
 *  ④ 懒加载运行时三件套在页面脚本内接线:mmEnsureLib(单例注入 /assets/diagram-renderer.js)、
 *    mmFallback(data-src 还原 <pre>)、mmRenderIn(三处消息渲染钩子调用);
 *  ⑤ /assets/diagram-renderer.js 资产路由可达(servePanel 真实实例 fetch)。
 * 形态:panel-canvas-fixes.test.ts 的 extractFn(花括号配平)——不起浏览器,vitest 单文件可跑。
 */
import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";

const NL = String.fromCharCode(10);
const FENCE = "```";

/** 从面板 HTML 里切出顶层函数源码(花括号配平;与 panel-canvas-fixes.test.ts 同构)。 */
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

const MER_SRC = "graph TD" + NL + "  A[开始] --> B{判断}" + NL + "  B -->|是| C[结束]";

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

describe("消息流 mermaid 懒加载渲染(2026-10-29)", () => {
  it("① mdToHtml:```mermaid 产占位节点且 data-src 保留源文本(转义形态);前正文不丢", async () => {
    await withPanel(7894, (html) => {
      const md = extractFn(html, "mdToHtml");
      const mdToHtml: (t: string, q: string) => string = new Function(
        "const esc=" + escSrc(html) + ";const FENCE=String.fromCharCode(96,96,96);" +
        "const artFallbackNote=" + extractFn(html, "artFallbackNote") + ";const artInfoOf=" + extractFn(html, "artInfoOf") + ";const artHtmlCard=" + extractFn(html, "artHtmlCard") + ";const artSvgCard=" + extractFn(html, "artSvgCard") + ";const renderCodeBlock=" + extractFn(html, "renderCodeBlock") + ";const sketchifyHtml=(s)=>s;" +
        "const hl=(m,q)=>m;" + // q="" 时恒等(mdToHtml 首行守卫)
        "const mdInline=(s)=>s;" + // 占位:源文本不含行内标记,mdInline 恒等不影响 data-src 断言
        md + NL + "return mdToHtml;",
      )() as (t: string, q: string) => string;
      const out = mdToHtml("前文" + NL + FENCE + "mermaid" + NL + MER_SRC + NL + FENCE + NL + "后文", "");
      expect(out).toContain('class="md-mermaid"');
      expect(out).toContain("data-mermaid-lazy");
      // data-src 是 esc() 后的属性值:& < > " 已转义;实体逐项核对
      const m = /data-src="([^"]*)"/.exec(out);
      expect(m, "未找到 data-src 属性").not.toBeNull();
      const attr = m![1];
      expect(attr).toContain("graph TD");
      expect(attr).toContain("A[开始] --&gt; B{判断}"); // > → &gt;(< 与 " 同理;源里无 < )
      expect(attr).not.toMatch(/[^;]&(?![a-z]+;)/); // 不残留裸 &(转义完备)
      // 占位内不含 <pre>(不与普通代码块路径混流)
      expect(out).not.toContain("code-wrap is-code");
      // 前后正文仍在
      expect(out).toContain("前文");
      expect(out).toContain("后文");
    });
  }, 30_000);

  it("② 普通 ```js 代码块零改动:is-code 板 + span.cl 行 + data-lang=js", async () => {
    await withPanel(7895, (html) => {
      const md = extractFn(html, "mdToHtml");
      const mdToHtml: (t: string, q: string) => string = new Function(
        "const esc=" + escSrc(html) + ";const FENCE=String.fromCharCode(96,96,96);const artFallbackNote=" + extractFn(html, "artFallbackNote") + ";const artInfoOf=" + extractFn(html, "artInfoOf") + ";const artHtmlCard=" + extractFn(html, "artHtmlCard") + ";const artSvgCard=" + extractFn(html, "artSvgCard") + ";const renderCodeBlock=" + extractFn(html, "renderCodeBlock") + ";const sketchifyHtml=(s)=>s;const hl=(m,q)=>m;const mdInline=(s)=>s;" + md + NL + "return mdToHtml;",
      )() as (t: string, q: string) => string;
      const out = mdToHtml("```js" + NL + "let y = 2;" + NL + "```", "");
      expect(out).toContain('class="code-wrap is-code"');
      expect(out).toContain('data-lang="js"');
      expect(out).toContain('<span class="cl">let y = 2;</span>');
      expect(out).toContain("code-copy");
      expect(out).not.toContain("md-mermaid");
    });
  }, 30_000);

  it("③ 未闭合 ```mermaid 围栏不炸(尾部落占位,源文本仍完整保留)", async () => {
    await withPanel(7896, (html) => {
      const md = extractFn(html, "mdToHtml");
      const mdToHtml: (t: string, q: string) => string = new Function(
        "const esc=" + escSrc(html) + ";const FENCE=String.fromCharCode(96,96,96);const artFallbackNote=" + extractFn(html, "artFallbackNote") + ";const artInfoOf=" + extractFn(html, "artInfoOf") + ";const artHtmlCard=" + extractFn(html, "artHtmlCard") + ";const artSvgCard=" + extractFn(html, "artSvgCard") + ";const renderCodeBlock=" + extractFn(html, "renderCodeBlock") + ";const sketchifyHtml=(s)=>s;const hl=(m,q)=>m;const mdInline=(s)=>s;" + md + NL + "return mdToHtml;",
      )() as (t: string, q: string) => string;
      let out = "";
      expect(() => { out = mdToHtml(FENCE + "mermaid" + NL + "graph TD" + NL + "  A --> B", ""); }).not.toThrow();
      expect(out).toContain('class="md-mermaid"');
      expect(out).toContain("data-src");
    });
  }, 30_000);

  it("④ 懒加载运行时接线:mmEnsureLib/mmFallback/mmRenderIn 在页面内 + 三处渲染钩子已换用 + CODE_SRC 已退役", async () => {
    await withPanel(7897, (html) => {
      for (const fn of ["mmEnsureLib", "mmFallback", "mmRenderIn"]) {
        expect(html).toContain("function " + fn + "(");
      }
      // 单例懒注入:/assets/diagram-renderer.js 由 mmEnsureLib 动态创建(不再有 CODE_SRC Map)
      expect(html).toContain('sc.src = "/assets/diagram-renderer.js"');
      expect(html).not.toMatch(/CODE_SRC\s*\./); // CODE_SRC 退役:无成员访问(页面其它 new Map 合法存在,不能一刀切)
      // 主历史/子代理工作区/Wiki/IDE md 预览四处钩子换用 mmRenderIn
      expect((html.match(/mmRenderIn\(/g) || []).length).toBeGreaterThanOrEqual(5); // 定义 1 + 调用 4
 // IDE markdown 预览宿主落位后必须扫占位出图(漏调=占位卡永久卡「mermaid 图渲染中…」, 修复)
      expect(/ideBodyShow\("md"\)/.test(html)).toBe(true);
      expect(html).toContain("mmRenderIn(host); // mermaid 围栏懒加载出图(与消息流");
      // 旧 data-mermaid-id 消费面全部移除(不留死代码)
      expect(html).not.toContain("data-mermaid-id");
      // 降级路径:data-src 还原(innerHTML 属性解析口径)
      expect(html).toContain("getAttribute(\"data-src\")");
    });
  }, 30_000);

  it("⑤ /assets/diagram-renderer.js 资产路由可达(200 + JS 类型)", async () => {
    await withPanel(7898, async (_html) => {
      const res = await fetch("http://127.0.0.1:7898/assets/diagram-renderer.js");
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body.length).toBeGreaterThan(1_000); // 自有渲染器(UMD,零第三方依赖)
      expect(body).toContain("OwnDiagram");
      expect(body).not.toMatch(/^\s*(export|import)/m); // 经典脚本口径(页面 <script src> 直接跑)
    });
  }, 30_000);
});

/** esc 源码提取(renderCodeBlock/mdToHtml 依赖;双引号包裹形态)。 */
function escSrc(html: string): string {
  const i = html.indexOf("function esc(s)");
  expect(i, "未找到 esc").toBeGreaterThan(0);
  let depth = 0, started = false, j = i;
  for (; j < html.length; j++) {
    const c = html[j];
    if (c === "{") { depth++; started = true; }
    else if (c === "}") { depth--; if (started && depth === 0) { j++; break; } }
  }
  return html.slice(i, j);
}
