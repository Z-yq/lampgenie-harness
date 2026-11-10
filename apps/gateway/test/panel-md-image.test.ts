/**
 * IDE markdown 预览「可点击图片」契约测试(2026-11-06)。
 * 坏例:`[![图 1 全景服务架构](30-service-architecture.png)](30-service-architecture.png)`
 * (genie-memory/docs/code-flow/README.md 的 14 张全是这个写法)——旧实现整张图不显示。
 *
 * 做法照抄同目录 panel-ide-deep.test.ts:servePanel 起真面板取 HTML → 正则/花括号配平切出
 * PAGE 内函数源码 → new Function 求值(零构建链),再用真 ideMdIo(路径 docs/code-flow/README.md)
 * 跑 mdInlineScan,断言生成的 HTML。
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { servePanel } from "../src/panel.js";

const PORT = 7937;

/** 从面板 HTML 里切出顶层函数源码(花括号配平)——同 panel-ide-deep.test.ts。 */
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

const MD = "README.md";
/** 要在测试里求值的 PAGE 函数(esc 用于还原 mdInline 的入口转义;ideMdIo 是真 io)。 */
const NEEDED = ["esc", "mdImgSrc", "mdImgHtml", "ideMdAssetUrl", "ideMdRelPath", "ideMdIo", "mdInlineScan"];

type Api = { esc: (s: string) => string; mdInlineScan: (s: string, d: number, io: unknown) => string; io: unknown };
let api: Api;
let pageHtml = "";
const panel = servePanel(PORT, () => { /* 不需要 WS */ });

beforeAll(async () => {
  const html = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
  pageHtml = html;
  const src = NEEDED.map((n) => extractFn(html, n)).join("\n");
  // PAGE 顶部常量(反引号走 fromCharCode,与页面同口径)
  const pre = "const BT = String.fromCharCode(96);\n";
  const factory = new Function("ideRoot", pre + src + "\nreturn { esc, mdInlineScan, ideMdIo };") as (
    root: unknown,
  ) => { esc: (s: string) => string; mdInlineScan: (s: string, d: number, io: unknown) => string; ideMdIo: (t: { path: string }) => unknown };
  const built = factory({ pid: "vitest-pid" });
  api = { esc: built.esc, mdInlineScan: built.mdInlineScan, io: built.ideMdIo({ path: MD }) };
}, 30_000);

afterAll(async () => {
  await panel.close();
});

/** 按 mdInline 的真实入口(先 esc 再单遍扫描)渲染一行 markdown。 */
const render = (md: string): string => api.mdInlineScan(api.esc(md), 0, api.io);
/** 从 /ide/asset?path=…&from=…&pid=… 里取某个查询参数(解码后),便于断言路径归一结果。 */
function param(html: string, key: string): string {
  const m = new RegExp("[?&]" + key + "=([^\"&]*)").exec(html);
  return m ? decodeURIComponent(m[1]) : "";
}

describe("md 可点击图片 [![alt](src)](href)", () => {
  it("①README 真语法:内层出 <img>(/ide/asset 带 path+from),外层有 <a> 且 href 非空", () => {
    const out = render("[![图 1 全景服务架构](30-service-architecture.png)](30-service-architecture.png)");
    expect(out).toContain("<img");
    expect(out).toContain("/ide/asset?");
    expect(param(out, "path")).toBe("30-service-architecture.png");
    expect(param(out, "from")).toBe(MD);
    expect(out).toContain("<a ");
    expect(out).toMatch(/<a [^>]*href="[^"]+"/);
    // 外层是项目内相对链接 → 走 io.link 的 data-ide-mdlink 委托(点开同一张图)
    expect(out).toContain("data-ide-mdlink=");
    // 不再有旧实现的残渣("](" 字面量尾巴)
    expect(out).not.toContain("](");
    expect(out).not.toContain("![");
  });

  it("②尾部 title 不进 src:`[![a](x.png \"标题\")](x.png)` → src 不含「标题」", () => {
    const out = render('[![a](x.png "标题")](x.png)');
    expect(out).toContain("<img");
    expect(param(out, "path")).toBe("x.png");
    expect(out).not.toContain("标题" + "&");
    const src = /src="([^"]*)"/.exec(out);
    expect(src).not.toBeNull();
    expect(src![1]).not.toContain(encodeURIComponent("标题"));
  });

  it("⑤外层 http(s):`[![a](/abs/e.png)](https://e.com)` → <a href=\"https://e.com\" 包裹内层图", () => {
    const out = render("[![a](/abs/e.png)](https://e.com)");
    expect(out).toContain('<a href="https://e.com"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain("<img");
    expect(param(out, "path")).toBe("/abs/e.png");
    const iA = out.indexOf("<a ");
    const iImg = out.indexOf("<img");
    const iClose = out.indexOf("</a>");
    expect(iImg).toBeGreaterThan(iA); // img 在 a 内层
    expect(iClose).toBeGreaterThan(iImg);
  });

  it("内层图片不在任何白名单(无 io 且非 /uploads?)时退回普通链接分支,不吐半截标签", () => {
    const out = api.mdInlineScan(api.esc("[![a](weird.png)](rel/other.md)"), 0, undefined);
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<a");
    expect(out).toContain("![a]"); // 字面量原样(逐字回退)
  });
});

describe("md 图片 src 归一 mdImgSrc", () => {
  it("③反斜杠:`![a](sub\\b.png)` → asset path 用 / 不是 \\", () => {
    const out = render("![a](sub\\b.png)");
    expect(out).toContain("<img");
    expect(param(out, "path")).toBe("sub/b.png");
    expect(/src="[^"]*\\[^"]*"/.test(out)).toBe(false);
  });

  it("④尖括号包裹:`![a](<x y.png>)` → src 无尖括号(含 esc 后的 &lt; 形态)", () => {
    const out = render("![a](<x y.png>)");
    expect(out).toContain("<img");
    expect(param(out, "path")).toBe("x y.png");
    const src = /src="([^"]*)"/.exec(out)![1];
    expect(src).not.toContain("<");
    expect(src).not.toContain("&lt;");
    expect(src).not.toContain("&gt;");
    // 已转义形态(直接把 esc 后的串喂给 mdImgSrc)同样要归一
    const direct = new Function(extractFn(pageHtml, "mdImgSrc") + "\nreturn mdImgSrc;")() as (s: string) => string;
    expect(direct("&lt;x y.png&gt;")).toBe("x y.png");
    expect(direct("x.png &quot;标题&quot;")).toBe("x.png");
    expect(direct("sub\\b.png")).toBe("sub/b.png");
  });

  it("file:// 前缀与单引号 title 也归一", () => {
    const out = render("![a](file:///mnt/e/p.png)");
    expect(param(out, "path")).toBe("/mnt/e/p.png");
    const out2 = render("![a](y.png '标题')");
    expect(param(out2, "path")).toBe("y.png");
  });
});

describe("既有语法不回归", () => {
  it("⑥普通 `[文字](rel/path.md)` → 仍走 io.link,不含 <img>", () => {
    const out = render("[文字](rel/path.md)");
    expect(out).toContain("data-ide-mdlink=");
    expect(out).toContain("文字");
    expect(out).not.toContain("<img");
  });

  it("普通图片 `![图](pic.png)` 与 http 图片仍渲染", () => {
    expect(render("![图](pic.png)")).toContain("/ide/asset?");
    expect(render("![图](https://x.com/a.png)")).toContain('src="https://x.com/a.png"');
  });

  it("⑦异常形态不抛错:`[](x)`、`[a]`、`[![a](x.png)`、`[[]]`、空串", () => {
    const cases = ["[](x)", "[a]", "[![a](x.png)", "[[]]", "", "[![a](", "[![a](x.png)](", "!![a](x.png)"];
    for (const c of cases) {
      expect(() => render(c), c).not.toThrow();
      expect(typeof render(c), c).toBe("string");
    }
    // 不完整形态按字面量输出(绝不吐半个标签)
    expect(render("[![a](x.png)")).not.toContain("<img");
    expect(render("[a]")).toBe("[a]");
  });
});
