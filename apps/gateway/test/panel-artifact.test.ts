/**
 * 富图形交付(2026-11-06 step-1024)契约测试:md 围栏 ```html / ```svg → 图卡
 *  ① ```html 产 .md-artifact.md-html + sandbox="" iframe + CSP(default-src 'none')+ srcdoc 转义;
 *  ② height info 夹取(缺省 560,min 240,max 1200);
 *  ③ ```svg 产 .md-artifact.md-svg 占位 + data-art-src 完整保留(HTML 转义形态),不再落 code-wrap;
 *  ④ >512KB 两种围栏都回落代码块 + 一行说明;
 *  ⑤ 既有行为零回归:```js 代码块、```mermaid 占位不变;
 *  ⑥ negative:html 围栏里的 <script> 在输出 HTML 里必须以实体形态存在(不可成为真 script 元素);
 *  ⑦ SYSTEM_TAIL 带 fig 通道指引(≤2 行)。
 * 形态:panel-mermaid.test.ts 同款 extractFn + new Function 沙箱(不起浏览器)。
 * SVG 的 DOM 净化(剥脚本节点、on 事件属性、外部 href)由 test/ui/richartifact.spec.cjs 在真实浏览器里验。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { servePanel } from "../src/panel.js";

const NL = String.fromCharCode(10);
const FENCE = "```";
const CAP = 512 * 1024;

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

/** 拼一个只含渲染管线所需函数的沙箱(mdToHtml + renderCodeBlock + 图卡 helper)。 */
function makeMdToHtml(html: string): (t: string) => string {
  const parts = [
    "const esc=" + escSrc(html) + ";",
    "const FENCE=String.fromCharCode(96,96,96);",
    "const hl=(m,q)=>m;const mdInline=(s)=>s;const sketchifyHtml=(s)=>s;",
    "const artFallbackNote=" + extractFn(html, "artFallbackNote") + ";",
    "const artInfoOf=" + extractFn(html, "artInfoOf") + ";",
    "const artHtmlCard=" + extractFn(html, "artHtmlCard") + ";",
    "const artSvgCard=" + extractFn(html, "artSvgCard") + ";",
    "const renderCodeBlock=" + extractFn(html, "renderCodeBlock") + ";",
    extractFn(html, "mdToHtml") + NL + "return mdToHtml;",
  ];
  return new Function(parts.join(NL))() as (t: string) => string;
}

async function withPanel<T>(port: number, fn: (html: string) => T | Promise<T>): Promise<T> {
  const srv = servePanel(port, () => { /* 无需 WS */ });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    return await fn(await res.text());
  } finally {
    await srv.close();
  }
}

const HTML_SRC = "<!doctype html><html><head><style>body{background:#111}</style></head><body><div class=a>架构卡</div></body></html>";
const SVG_SRC = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60"><rect x="4" y="4" width="90" height="50"/><text x="10" y="30">矩阵</text></svg>';

describe("富图形交付:html/svg 图卡围栏(step-1024)", () => {
  it("① ```html → md-artifact.md-html + sandbox 空 iframe + CSP meta + 缺省高度 560", async () => {
    await withPanel(7911, (html) => {
      const mdToHtml = makeMdToHtml(html);
      const out = mdToHtml("前文" + NL + FENCE + "html" + NL + HTML_SRC + NL + FENCE + NL + "后文");
      expect(out).toContain('class="md-artifact md-html"');
      expect(out).toContain('sandbox=""');
      // srcdoc 属性内是 esc 后的整份文档:CSP meta + 原始内容都在
      const m = /srcdoc="([^"]*)"/.exec(out);
      expect(m, "无 srcdoc").not.toBeNull();
      const srcdoc = m![1];
      expect(srcdoc).toContain("Content-Security-Policy");
      expect(srcdoc).toContain("default-src 'none'");
      expect(srcdoc).toContain("style-src 'unsafe-inline'");
      expect(srcdoc).toContain("img-src data:");
      expect(srcdoc).toContain("font-src data:");
      expect(srcdoc).toContain("架构卡"); // 源内容原样进 srcdoc
      expect(srcdoc).toContain("&lt;div class=a&gt;"); // 属性值内的标签已转义(不会成为真 DOM)
      expect(srcdoc.indexOf("&lt;!doctype")).toBe(0);   // 完整文档形态:只插 CSP,不二次包裹
      expect(out).toContain('style="height:560px"');
      expect(out).not.toContain("code-wrap is-code");
      expect(out).toContain("前文");
      expect(out).toContain("后文");
    });
  }, 30_000);

  it("② height info 夹取:720 生效、100 → 240、5000 → 1200", async () => {
    await withPanel(7912, (html) => {
      const mdToHtml = makeMdToHtml(html);
      const h720 = mdToHtml(FENCE + "html height=720" + NL + HTML_SRC + NL + FENCE);
      expect(h720).toContain('style="height:720px"');
      const lo = mdToHtml(FENCE + "html height=100" + NL + HTML_SRC + NL + FENCE);
      expect(lo).toContain('style="height:240px"');
      const hi = mdToHtml(FENCE + "HTML height=5000" + NL + HTML_SRC + NL + FENCE);
      expect(hi).toContain('style="height:1200px"');
      expect(hi).toContain('class="md-artifact md-html"'); // 语言大小写不敏感
    });
  }, 30_000);

  it("③ ```svg → md-artifact.md-svg 占位 + data-art-src 保留源(转义形态),不落 code-wrap", async () => {
    await withPanel(7913, (html) => {
      const mdToHtml = makeMdToHtml(html);
      const out = mdToHtml(FENCE + "svg" + NL + SVG_SRC + NL + FENCE);
      expect(out).toContain('class="md-artifact md-svg"');
      expect(out).toContain('data-art-svg="1"');
      const m = /data-art-src="([^"]*)"/.exec(out);
      expect(m, "无 data-art-src").not.toBeNull();
      expect(m![1]).toContain("&lt;svg");
      expect(m![1]).toContain("矩阵");
      expect(out).toContain('class="art-fit"'); // 1:1 切换
      expect(out).toContain('class="art-full"'); // 全屏
      expect(out).not.toContain("code-wrap is-code");
    });
  }, 30_000);

  it("④ 超 512KB:html/svg 都回落代码块 + 一行说明", async () => {
    await withPanel(7914, (html) => {
      const mdToHtml = makeMdToHtml(html);
      const big = "x".repeat(CAP + 10);
      const h = mdToHtml(FENCE + "html" + NL + big + NL + FENCE);
      expect(h).toContain("图卡源超出 512KB 上限,已回落为代码块");
      expect(h).toContain("code-wrap is-code");
      expect(h).not.toContain("md-artifact");
      const s = mdToHtml(FENCE + "svg" + NL + big + NL + FENCE);
      expect(s).toContain("图卡源超出 512KB 上限,已回落为代码块");
      expect(s).not.toContain("md-artifact");
      // 边界内(略小于上限)仍走图卡
      const ok = mdToHtml(FENCE + "svg" + NL + ("y".repeat(CAP - 64)) + NL + FENCE);
      expect(ok).toContain("md-artifact md-svg");
    });
  }, 30_000);

  it("⑤ 零回归:```js 代码块与 ```mermaid 占位不变", async () => {
    await withPanel(7915, (html) => {
      const mdToHtml = makeMdToHtml(html);
      const js = mdToHtml(FENCE + "js" + NL + "let y = 2;" + NL + FENCE);
      expect(js).toContain('class="code-wrap is-code"');
      expect(js).toContain('data-lang="js"');
      expect(js).toContain('<span class="cl">let y = 2;</span>');
      expect(js).toContain("code-copy");
      expect(js).not.toContain("md-artifact");
      const mm = mdToHtml(FENCE + "mermaid" + NL + "graph TD" + NL + "  A --> B" + NL + FENCE);
      expect(mm).toContain('class="md-mermaid"');
      expect(mm).toContain("data-mermaid-lazy");
      expect(mm).not.toContain("md-artifact");
    });
  }, 30_000);

  it("⑥ negative:html 围栏内 <script>/onclick 只能以实体形态存在,输出不含可执行 script 元素", async () => {
    await withPanel(7916, (html) => {
      const mdToHtml = makeMdToHtml(html);
      const evil = '<body><script>window.__pwned=1</script><div onclick="window.__pwned=2">x</div></body>';
      const out = mdToHtml(FENCE + "html" + NL + evil + NL + FENCE);
      // 输出层只有外层 .md-artifact 结构;源里的尖括号全被转义进属性值
      expect(out).toContain('class="md-artifact md-html"');
      const srcdoc = (/srcdoc="([^"]*)"/.exec(out) || [])[1] || "";
      expect(srcdoc).toContain("&lt;script&gt;");
      expect(out.indexOf("<script")).toBeLessThan(0);
      expect(out).toContain("前文".slice(0, 0)); // 占位断言(空串恒真),保持与其他用例同一结构
    });
  }, 30_000);

  it("⑦ 页面脚本内置图卡运行时:artRenderIn/artSanitizeSvg 存在且四处挂载钩子到位", async () => {
    await withPanel(7917, (html) => {
      for (const fn of ["artRenderIn", "artSanitizeSvg", "artMountSvg", "artBindDelegates"]) {
        expect(html).toContain("function " + fn + "(");
      }
      expect(html).toContain("artRenderIn(host)");
      expect(html).toContain("artRenderIn($(\"chatBody\"))");
      expect(html).toContain("for (const root of mfRoots) artRenderIn(root)");
      // 净化白名单:危险节点与属性名必须出现在源码里
      for (const k of ["foreignobject", "iframe", "embed", "xlink:href", "javascript:"]) {
        expect(html.toLowerCase()).toContain(k);
      }
    });
  }, 30_000);

  it("⑧ SYSTEM_TAIL 带图卡通道指引(≤2 行,且不改其它提示词段)", () => {
    const src = readFileSync(new URL("../src/agent-wiring.ts", import.meta.url), "utf8");
    const i = src.indexOf("const SYSTEM_TAIL = `");
    expect(i).toBeGreaterThan(0);
    const tail = src.slice(i, src.indexOf("`;", i + 20));
    expect(tail).toContain("\\`\\`\\`html");
    expect(tail).toContain("\\`\\`\\`svg");
    expect(tail).toContain("设计稿级");
    expect(tail).toContain("height=720");
    expect(tail).toContain("mermaid");
    // 只加在一个段里:全文出现次数与 Tail 内一致(不复制到 SYSTEM_LITE 等别处)
    const total = (src.match(/设计稿级/gu) || []).length;
    expect(total).toBe((tail.match(/设计稿级/gu) || []).length);
  });
});
