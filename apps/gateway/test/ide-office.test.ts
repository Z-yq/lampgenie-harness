/**
 * Office 文档渲染件(assets/ide-office.js,板节点 ide-o2 PPTX / ide-o3 DOCX 的渲染半边)契约测试。
 *
 * 本仓 vitest 是 node 环境(无 DOM / 无 jsdom),不造假 DOM,分三层:
 *  ①源码契约(读文本):导出面(window.IdeOffice / globalThis.IdeOffice 四键)、EMU 常量 9525、
 *    离线红线(不含任何 url 协议)、零 innerHTML(文档文本一律 textContent / esc)、
 *    导航快捷键与图片 onerror 兜底在场;
 *  ②纯函数层(__test):EMU→px、百分比定位、HTML 转义、颜色/地址白名单、align/heading 归一化、
 *    blockKind / shapeKind 分派(unsupported 一律归到占位);
 *  ③降级层:host 缺失 / ast 非对象 / DOM 不存在时 render 返回 {ok:false, reason},不抛不白屏;
 *    clear 幂等。
 * 真实版式与缩放验收走浏览器实测(容器宽 → transform scale 适配)。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const ASSET = join(here, "..", "src", "assets", "ide-office.js");
const source = readFileSync(ASSET, "utf8");

/** 在最小沙箱里跑资产;无 window 时资产挂 globalThis,有 window 时挂 window。 */
function load(extra: Record<string, unknown> = {}): Record<string, any> {
  const sandbox: Record<string, any> = { console, ...extra };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "ide-office.js" });
  return (sandbox.window ? sandbox.window.IdeOffice : sandbox.IdeOffice) as Record<string, any>;
}

/** 渲染路径用的最小 DOM 桩(node 无 DOM 也不装 jsdom):只实现 ide-office 真正调用到的接口。
 *  用途是跑通 DOM 分支「不抛 + 结构在场」,不做版式断言(版式走浏览器实测)。 */
class FakeEl {
  tagName: string;
  childNodes: any[] = [];
  style: Record<string, any> = {};
  attrs: Record<string, string> = {};
  dataset: Record<string, any> = {};
  className = "";
  title = "";
  textContent = "";
  clientWidth = 800;
  classList = { add: (_c: string) => {} };
  constructor(t: string) {
    this.tagName = String(t).toUpperCase();
  }
  appendChild(c: any) {
    this.childNodes.push(c);
    return c;
  }
  removeChild(c: any) {
    this.childNodes = this.childNodes.filter((x: any) => x !== c);
    return c;
  }
  get firstChild() {
    return this.childNodes[0] || null;
  }
  setAttribute(k: string, v: any) {
    this.attrs[k] = String(v);
  }
  getAttribute(k: string) {
    return this.attrs[k] === undefined ? null : this.attrs[k];
  }
  removeAttribute(k: string) {
    delete this.attrs[k];
  }
  addEventListener() {}
  removeEventListener() {}
  focus() {}
  querySelectorAll() {
    return [];
  }
}

function makeFakeDom() {
  return { createElement: (t: string) => new FakeEl(t) };
}

describe("ide-office 源码契约", () => {
  it("可被 JS 引擎解析(资产无 TS 护栏,坏文件会直进产线)", () => {
    expect(() => new Function(source)).not.toThrow();
  });

  it("导出面:window.IdeOffice / globalThis.IdeOffice 四键", () => {
    expect(source).toContain("window.IdeOffice");
    expect(source).toContain("globalThis.IdeOffice");
    for (const k of ["render:", "clear:", "__test:", "version:"]) expect(source).toContain(k);
  });

  it("EMU 常量在位(96dpi:1px = 9525 EMU)", () => {
    expect(source).toContain("9525");
    expect(source).toContain("EMU_PER_PX");
    expect(source).toContain("12192000");
  });

  it("离线红线:不含任何 url 协议、不加载外部资源(禁 CDN)", () => {
    expect(source).not.toContain("http://");
    expect(source).not.toContain("https://");
  });

  it("零 innerHTML 拼接(文档文本是不可信输入,只能 textContent / esc)", () => {
    expect(source).not.toContain("innerHTML");
    expect(source).toContain("textContent");
    expect(source).toContain("esc(");
  });

  it("导航与图片兜底:键盘 ← →、页切换、img onerror 隐藏占位", () => {
    expect(source).toContain("ArrowLeft");
    expect(source).toContain("ArrowRight");
    expect(source).toContain("keydown");
    expect(source).toContain('"error"');
    expect(source).toContain("objectFit");
    expect(source).toContain("ResizeObserver");
  });

  // 2026-10-29 板「OOXML 文本回写」P2:编辑定位属性与编辑态导出面(面板收集 dirty 段靠它们)
  it("编辑定位属性在位:PPT 文本框 slide:S:shape:I / Word 段落 block:N,且导出 setEdit/collectEdits", () => {
    expect(source).toContain("data-io-edit");
    expect(source).toContain('"slide:" + slideNo + ":shape:" + shapeIdx');
    expect(source).toContain('"block:" + idx');
    for (const k of ["setEdit:", "collectEdits:"]) expect(source).toContain(k);
    expect(source).toContain("contenteditable");
  });

  it("降级与占位文案齐全", () => {
    expect(source).toContain("暂不支持(chart/SmartArt/嵌入媒体/组合)");
    expect(source).toContain("(空文档)");
    expect(source).toContain("(此处有暂不支持的内容,已跳过)");
    expect(source).toContain("try {");
    expect(source).toContain("catch (");
  });
});

describe("ide-office 纯函数(__test)", () => {
  const api = load();
  const T = api.__test;

  it("__test 面齐全且不依赖 DOM", () => {
    for (const k of ["emuToPx", "pct", "esc", "safeColor", "safeSrc", "alignOf", "headingLevel", "blockKind", "shapeKind", "unsupportedLabel"]) {
      expect(typeof T[k]).toBe("function");
    }
    expect(T.constants.EMU_PER_PX).toBe(9525);
    expect(T.constants.HEADING_PX.slice(1)).toEqual([24, 20, 17]);
    expect(T.constants.DEF_W_EMU).toBe(12192000);
    expect(T.constants.DEF_H_EMU).toBe(6858000);
  });

  it("EMU → px:9525 EMU = 1px,16:9 标准页 = 1280×720", () => {
    expect(T.emuToPx(9525)).toBe(1);
    expect(T.emuToPx(12192000)).toBe(1280);
    expect(T.emuToPx(6858000)).toBe(720);
    expect(T.emuToPx("x")).toBe(0);
    expect(T.emuToPx(undefined)).toBe(0);
  });

  it("百分比定位:left/top/cx/cy 全部换算成页宽高的百分比", () => {
    expect(T.pct(914400, 12192000)).toBe("7.5%");
    expect(T.pct(0, 12192000)).toBe("0%");
    expect(T.pct(12192000, 12192000)).toBe("100%");
    expect(T.pct(99999999, 12192000)).toBe("100%"); // 越界夹紧,不撑破页框
    expect(T.pct(-500, 12192000)).toBe("0%");
    expect(T.pct(100, 0)).toBe("0%"); // 非法分母
  });

  it("esc:文档文本转义后不含裸 < > \" ' &", () => {
    const out = T.esc('<img onerror=x>');
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(out).toContain("&lt;img");
    expect(T.esc('"a"&\'b\'').indexOf('"')).toBe(-1);
    expect(T.esc("")).toBe("");
    expect(T.esc(null)).toBe("");
  });

  it("颜色白名单:挡住 style 注入,合法色原样保留", () => {
    expect(T.safeColor("#C9A227")).toBe("#C9A227");
    expect(T.safeColor("#fff")).toBe("#fff");
    expect(T.safeColor("rgb(1,2,3)")).toBe("rgb(1,2,3)");
    expect(T.safeColor("transparent")).toBe("transparent");
    expect(T.safeColor("red; background:url(x)", "#000")).toBe("#000");
    expect(T.safeColor("javascript:alert(1)", "#000")).toBe("#000");
    expect(T.safeColor(undefined, "")).toBe("");
  });

  it("图片地址白名单:只放同源绝对路径,挡协议头与协议相对地址", () => {
    expect(T.safeSrc("/ide/office/media?path=a.pptx&part=ppt/media/image1.png")).toContain("/ide/office/media");
    expect(T.safeSrc("//evil.example/x.png")).toBe("");
    expect(T.safeSrc("data:image/png;base64,AAAA")).toBe("");
    expect(T.safeSrc("javascript:alert(1)")).toBe("");
    expect(T.safeSrc("image1.png")).toBe("");
    expect(T.safeSrc(null)).toBe("");
  });

  it("align / heading 归一化", () => {
    expect(T.alignOf("l")).toBe("left");
    expect(T.alignOf("c")).toBe("center");
    expect(T.alignOf("r")).toBe("right");
    expect(T.alignOf("center")).toBe("center");
    expect(T.alignOf("weird", "left")).toBe("left");
    expect(T.headingLevel("Heading1")).toBe(1);
    expect(T.headingLevel("heading2")).toBe(2);
    expect(T.headingLevel("Heading3")).toBe(3);
    expect(T.headingLevel("Heading9")).toBe(3);
    expect(T.headingLevel("Normal")).toBe(0);
    expect(T.headingLevel(null)).toBe(0);
  });

  it("blockKind 分派:p / table / 其余一律 unsupported", () => {
    expect(T.blockKind({ type: "p" })).toBe("p");
    expect(T.blockKind({ type: "paragraph" })).toBe("p");
    expect(T.blockKind({ type: "table", rows: [["a"]] })).toBe("table");
    expect(T.blockKind({ type: "unsupported", unsupportedKind: "textbox" })).toBe("unsupported");
    expect(T.blockKind({ type: "sdt" })).toBe("unsupported");
    expect(T.blockKind(null)).toBe("unsupported");
    expect(T.blockKind("p")).toBe("unsupported");
  });

  it("shapeKind 分派:text / image / shape,其余(含 unsupportedKind)归占位", () => {
    expect(T.shapeKind({ type: "text", text: "标题" })).toBe("text");
    expect(T.shapeKind({ type: "image", src: "/ide/office/media?path=a" })).toBe("image");
    expect(T.shapeKind({ type: "shape", fill: "#FFFFFF" })).toBe("shape");
    expect(T.shapeKind({ type: "unsupported", unsupportedKind: "chart" })).toBe("unsupported");
    // AST v2:table / chart 由占位升为真件(type 直给,或 type="shape" 但带载荷)
    expect(T.shapeKind({ type: "chart" })).toBe("chart");
    expect(T.shapeKind({ type: "table", table: { rows: [] } })).toBe("table");
    expect(T.shapeKind({ type: "shape", chart: { kind: "bar", series: [] } })).toBe("chart");
    expect(T.shapeKind({ type: "shape", table: { rows: [], colWidthsEmu: [1] } })).toBe("table");
    expect(T.shapeKind({ type: "group" })).toBe("unsupported");
    expect(T.shapeKind({})).toBe("unsupported");
    expect(T.shapeKind(null)).toBe("unsupported");
    expect(T.unsupportedLabel("chart")).toBe("图表");
    expect(T.unsupportedLabel("smartart")).toBe("SmartArt");
    expect(T.unsupportedLabel("media")).toBe("嵌入媒体");
    expect(T.unsupportedLabel("group")).toBe("组合");
    expect(T.unsupportedLabel("nope")).toBe("其他");
  });
});

describe("ide-office 降级(无 DOM 也不抛)", () => {
  const api = load();

  it("host 缺失 → {ok:false} 且不抛", () => {
    expect(api.render({ host: null })).toEqual({ ok: false, reason: "host-unusable" });
    expect(api.render({ host: null, ast: { kind: "pptx", slides: [] } })).toEqual({ ok: false, reason: "host-unusable" });
    expect(api.render()).toEqual({ ok: false, reason: "host-unusable" });
    expect(api.render(undefined)).toEqual({ ok: false, reason: "host-unusable" });
  });

  it("host 不像宿主元素(无 appendChild)→ {ok:false}", () => {
    const r = api.render({ host: {}, ast: null });
    expect(r.ok).toBe(false);
    expect(typeof r.reason).toBe("string");
  });

  it("宿主可用但 ast 非对象 → {ok:false},node 无 document 时先报 no-dom", () => {
    const host = { appendChild() {} };
    const r = api.render({ host, ast: null });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no-dom"); // node 环境无 document:不进 DOM 路径,也不抛
    expect(() => api.render({ host, ast: { kind: "pdf" } })).not.toThrow();
    expect(api.render({ host, ast: { kind: "pdf" } }).ok).toBe(false);
  });

  it("clear 幂等且不抛(可重复调、可传 null)", () => {
    const host = { appendChild() {}, firstChild: null, removeChild() {} };
    expect(api.clear(host)).toBe(true);
    expect(api.clear(host)).toBe(true);
    expect(api.clear(null)).toBe(true);
    expect(api.clear(undefined)).toBe(true);
  });

  it("node 直接 import 不崩(无 window 时退到 globalThis 挂载)", async () => {
    const mod: any = await import(pathToFileURL(ASSET).href);
    expect(mod).toBeTruthy();
    const g = (globalThis as any).IdeOffice;
    expect(g).toBeTruthy();
    expect(typeof g.render).toBe("function");
    expect(typeof g.clear).toBe("function");
    expect(typeof g.__test.emuToPx).toBe("function");
    expect(g.version).toBe("1");
    const r = g.render({ host: null, ast: { kind: "docx", blocks: [] } });
    expect(r.ok).toBe(false);
  });
});

/** AST v2 扩展(渐变 / 阴影描边 / 表格 / 图表 / SmartArt / 修订 / 批注 / 页眉页脚脚注)。
 *  node 无 DOM,继续以 __test 纯函数 + 源码契约为主;DOM 分支靠最小桩对象跑通「不抛」。 */
describe("ide-office AST v2:渐变填充 safeFill", () => {
  const T = load().__test;

  it("__test 面新增 safeFill/shadowCss/strokeCss/colWidthsToPercents/chartGeom/revisedStyle", () => {
    for (const k of ["safeFill", "shadowCss", "strokeCss", "strokeWidthPx", "colWidthsToPercents", "chartGeom", "chartNodeCount", "pieGradientCss", "revisedStyle", "catStep"]) {
      expect(typeof T[k]).toBe("function");
    }
    expect(T.constants.MAX_STROKE_PX).toBe(20);
    expect(T.constants.MAX_NODES).toBe(200);
    expect(T.constants.MAX_CATS).toBe(8);
  });

  it("纯色字符串原样走 safeColor;渐变对象生成 linear-gradient(angle deg, color pos%)", () => {
    expect(T.safeFill("#ff0000")).toEqual({ css: "#ff0000", isGradient: false });
    const g = T.safeFill({ gradient: { angle: 45, stops: [{ pos: 0, color: "#fff" }, { pos: 1, color: "#000" }] } });
    expect(g.isGradient).toBe(true);
    expect(g.css).toContain("linear-gradient");
    expect(g.css).toContain("45deg");
    expect(g.css).toContain("#fff 0%");
    expect(g.css).toContain("#000 100%");
    // 单 stop 不是合法渐变 → 退纯色
    expect(T.safeFill({ gradient: { angle: 10, stops: [{ pos: 0.5, color: "#123456" }] } })).toEqual({ css: "#123456", isGradient: false });
    expect(T.safeFill(null)).toEqual({ css: "", isGradient: false });
    expect(T.safeFill({})).toEqual({ css: "", isGradient: false });
  });

  it("negative 注入:angle/颜色里的 url(、javascript:、;position 全被挡", () => {
    const r = T.safeFill({
      gradient: { angle: "0;background:url(javascript:alert(1))", stops: [{ pos: 0, color: "red;position:fixed" }] },
    });
    expect(r.css).not.toContain("url(");
    expect(r.css).not.toContain("javascript:");
    expect(r.css).not.toContain("position:fixed");
    expect(r.isGradient).toBe(false); // 唯一 stop 非法色 → 整个渐变无有效 stop
    // 合法 stop 但 angle 带注入:angle 被 Number() + 夹取成纯数字
    const r2 = T.safeFill({
      gradient: { angle: "0;background:url(javascript:alert(1))", stops: [{ pos: 0, color: "#111" }, { pos: 1, color: "#222" }] },
    });
    expect(r2.css).not.toContain("url(");
    expect(r2.css).not.toContain("javascript:");
    expect(r2.css).toContain("linear-gradient(0deg");
    // 越界角度夹到 0~360
    const r3 = T.safeFill({ gradient: { angle: 720, stops: [{ pos: 0, color: "#111" }, { pos: 1, color: "#222" }] } });
    expect(r3.css).toContain("360deg");
    const r4 = T.safeFill({ gradient: { angle: -30, stops: [{ pos: 0, color: "#111" }, { pos: 1, color: "#222" }] } });
    expect(r4.css).toContain("0deg");
    // pos 越界夹到 0/100%
    const r5 = T.safeFill({ gradient: { angle: 90, stops: [{ pos: -1, color: "#111" }, { pos: 9, color: "#222" }] } });
    expect(r5.css).toContain("0%, #222 100%");
  });
});

describe("ide-office AST v2:阴影 / 描边", () => {
  const T = load().__test;

  it("shadow → box-shadow(EMU→px,dx dy blur color)", () => {
    expect(T.shadowCss({ color: "#000", blurEmu: 19050, dxEmu: 19050, dyEmu: 28575 })).toBe("2px 3px 2px #000");
    expect(T.shadowCss(undefined)).toBe("");
    expect(T.shadowCss(null)).toBe("");
    expect(T.shadowCss({})).toBe("");
    // 非法色走兜底色,不把注入串带进样式
    const bad = T.shadowCss({ color: "red;background:url(x)", dxEmu: 9525, dyEmu: 0, blurEmu: 0 });
    expect(bad).not.toContain("url(");
    expect(bad).toContain("1px 0px 0px");
  });

  it("stroke 宽度夹到 ≤20px;缺失返回空串(不造默认边框)", () => {
    expect(T.strokeCss({ color: "#333", widthEmu: 19050 })).toBe("2px solid #333");
    expect(T.strokeCss({ color: "#333", widthEmu: 99999999 })).toBe("20px solid #333"); // 超宽夹紧
    expect(T.strokeWidthPx({ widthEmu: 99999999 })).toBe(20);
    expect(T.strokeCss({ widthEmu: 0 })).toBe("");
    expect(T.strokeCss({})).toBe("");
    expect(T.strokeCss(null)).toBe("");
    expect(T.strokeWidthPx(null)).toBe(0);
  });
});

describe("ide-office AST v2:表格", () => {
  const T = load().__test;

  it("colWidthsToPercents 按比例分配列宽", () => {
    expect(T.colWidthsToPercents([1, 1, 2])).toEqual([25, 25, 50]);
    expect(T.colWidthsToPercents([3])).toEqual([100]);
    expect(T.colWidthsToPercents([])).toEqual([]);
    expect(T.colWidthsToPercents([0, 0])).toEqual([50, 50]); // 全 0 → 等分
    expect(T.colWidthsToPercents([1, "x", 1])).toEqual([50, 0, 50]); // 非数按 0
  });
});

describe("ide-office AST v2:图表几何 chartGeom", () => {
  const T = load().__test;

  it("bar:柱形数与高度比例正确(300×200 设计框)", () => {
    const g = T.chartGeom({ kind: "bar", series: [{ name: "s", cats: ["a", "b"], vals: [1, 3] }] }, 300, 200);
    expect(g.empty).toBe(false);
    expect(g.kind).toBe("bar");
    expect(g.bars.length).toBe(2);
    expect(g.bars[0].value).toBe(1);
    expect(g.bars[1].value).toBe(3);
    // 比例:1 : 3(零线对齐,柱高与数值成正比)
    expect(g.bars[0].h / g.bars[1].h).toBeCloseTo(1 / 3, 4);
    // 多系列并排:每类 2 根柱,同组不重叠
    const g2 = T.chartGeom({ kind: "bar", series: [{ name: "a", cats: ["x"], vals: [1] }, { name: "b", cats: ["x"], vals: [2] }] }, 300, 200);
    expect(g2.bars.length).toBe(2);
    expect(g2.bars[0].x).toBeLessThan(g2.bars[1].x);
    expect(g2.legend.length).toBe(2);
  });

  it("line:折点/线段 + 非有限数跳过该点;pie:只取第一系列", () => {
    const gl = T.chartGeom({ kind: "line", series: [{ name: "l", cats: ["a", "b", "c"], vals: [1, null, 3] }] }, 300, 200);
    expect(gl.empty).toBe(false);
    const pts = gl.series[0].points;
    expect(pts.length).toBe(3);
    expect(pts[1].valid).toBe(false); // null 跳过
    expect(pts[2].valid).toBe(true);
    expect(gl.series[0].segments.length).toBe(0); // 中间断点 → 无相邻线段
    const gp = T.chartGeom({ kind: "pie", series: [{ name: "p", cats: ["x", "y"], vals: [3, 1] }, { name: "q", cats: ["z"], vals: [9] }] }, 300, 200);
    expect(gp.pie.length).toBe(2); // 第二系列不参与
    expect(gp.pie[0].frac).toBeCloseTo(0.75, 6);
    expect(gp.pie[1].end).toBeCloseTo(1, 6);
  });

  it("空 series → {empty:true};分类标签超 8 个按步长抽稀", () => {
    expect(T.chartGeom({ kind: "bar", series: [] }, 300, 200).empty).toBe(true);
    expect(T.chartGeom({ kind: "bar", series: [{ name: "s", cats: [], vals: [] }] }, 300, 200).empty).toBe(true);
    expect(T.chartGeom({ kind: "bar", series: [{ name: "s", cats: ["a"], vals: [NaN] }] }, 300, 200).empty).toBe(true);
    expect(T.chartGeom(null, 300, 200).empty).toBe(true);
    expect(T.chartGeom({ kind: "bar", series: [] }, 0, 0).empty).toBe(true);
    const cats = Array.from({ length: 17 }, (_, i) => "c" + i);
    const vals = Array.from({ length: 17 }, (_, i) => i + 1);
    const g = T.chartGeom({ kind: "bar", series: [{ name: "s", cats, vals }] }, 300, 200);
    expect(g.step).toBe(3);
    expect(g.labels.filter((l: any) => l.show).length).toBeLessThanOrEqual(8);
    expect(T.catStep(8)).toBe(1);
    expect(T.catStep(17)).toBe(3);
  });

  it("图表节点数 > 200 → chartNodeCount 超限(调用方降级占位)", () => {
    const many = { kind: "bar", series: [{ name: "s", cats: Array.from({ length: 260 }, () => "c"), vals: Array.from({ length: 260 }, () => 1) }] };
    expect(T.chartNodeCount(many)).toBe(260);
    expect(T.chartNodeCount(many)).toBeGreaterThan(T.constants.MAX_NODES);
    expect(T.chartNodeCount({ kind: "bar", series: [] })).toBe(0);
    // 饼图只算第一系列
    expect(T.chartNodeCount({ kind: "pie", series: [{ vals: [1, 2] }, { vals: [1, 2, 3] }] })).toBe(2);
  });

  it("饼图 conic-gradient 值过黑名单", () => {
    const css = T.pieGradientCss([{ start: 0, end: 0.25, color: "#4c78a8" }, { start: 0.25, end: 1, color: "#f58518" }]);
    expect(css).toContain("conic-gradient");
    expect(css).toContain("0deg 90deg");
    expect(css).not.toContain("url(");
    expect(css).not.toContain("javascript:");
    expect(T.pieGradientCss([])).toBe("transparent");
  });
});

describe("ide-office AST v2:修订与源码契约", () => {
  const T = load().__test;

  it("revisedStyle:ins 下划线+绿,del 删除线+红+半透明(del 文本仍显示)", () => {
    expect(T.revisedStyle("ins").textDecoration).toBe("underline");
    expect(T.revisedStyle("ins").color).toBe("#1a7f37");
    expect(T.revisedStyle("del").textDecoration).toBe("line-through");
    expect(T.revisedStyle("del").color).toBe("#b42318");
    expect(Number(T.revisedStyle("del").opacity)).toBeLessThan(1);
    expect(T.revisedStyle(undefined)).toBe(null);
    expect(T.revisedStyle("weird")).toBe(null);
  });

  it("源码契约:离线零协议、零 innerHTML、导出面与 safeFill/linear-gradient 在位", () => {
    expect(source).not.toContain("http://");
    expect(source).not.toContain("https://");
    expect(source).not.toContain("innerHTML");
    expect(source).toContain("safeFill");
    expect(source).toContain("linear-gradient");
    expect(source).toContain("box-shadow");
    expect(source).toContain("conic-gradient");
    expect(source).toContain("colgroup");
    expect(source).toContain("comments");
    expect(source).toContain("footnotes");
    const api = load();
    for (const k of ["render", "clear", "__test"]) expect(typeof api[k] === "function" || typeof api[k] === "object").toBe(true);
  });

  it("DOM 桩:pptx(渐变/阴影/描边/表格/图表/SmartArt/修订)与 docx(页眉/页脚/脚注/批注)渲染不抛", () => {
    // 最小 DOM 桩见模块顶部 makeFakeDom()(只实现渲染路径用到的接口)
    const api = load({ document: makeFakeDom() });
    const host: any = new FakeEl("div");
    const r = api.render({
      host,
      ast: {
        kind: "pptx",
        slides: [
          {
            index: 1,
            shapes: [
              { type: "shape", x: 0, y: 0, cx: 100, cy: 100, fill: { gradient: { angle: 90, stops: [{ pos: 0, color: "#fff" }, { pos: 1, color: "#00f" }] } }, shadow: { color: "#000", dxEmu: 9525, dyEmu: 9525, blurEmu: 9525 }, stroke: { color: "#333", widthEmu: 19050 } },
              { type: "table", x: 0, y: 0, cx: 100, cy: 100, table: { rows: [{ cells: [{ text: "A" }, { text: "B" }] }, { cells: [{ text: "x" }, { text: "y" }] }], colWidthsEmu: [1, 2] } },
              { type: "chart", x: 0, y: 0, cx: 100, cy: 100, chart: { kind: "bar", series: [{ name: "s", cats: ["a", "b"], vals: [1, 3] }] } },
              { type: "chart", x: 0, y: 0, cx: 100, cy: 100, chart: { kind: "bar", series: [] } },
              { type: "shape", x: 0, y: 0, cx: 100, cy: 100, diagram: { nodes: [{ id: "a", text: "根" }, { id: "b", text: "子", parentId: "a" }] } },
              { type: "text", x: 0, y: 0, cx: 100, cy: 100, runs: [{ text: "插入", revised: "ins" }, { text: "删除", revised: "del" }] },
            ],
          },
        ],
      },
    });
    expect(r.ok).toBe(true);
    const flat = (n: any, out: any[] = []): any[] => {
      out.push(n);
      for (const c of n.childNodes || []) flat(c, out);
      return out;
    };
    const nodes = flat(host);
    const shapeEl = nodes.find((e) => e.className === "io-shape");
    expect(shapeEl.style.background).toContain("linear-gradient(90deg");
    expect(shapeEl.style.boxShadow).toBe("1px 1px 1px #000");
    expect(shapeEl.style.border).toBe("2px solid #333");
    expect(nodes.filter((e) => e.tagName === "COL").map((c) => c.style.width)).toEqual(["33.33%", "66.67%"]);
    expect(nodes.filter((e) => e.tagName === "TH").length).toBe(2);
    expect(nodes.filter((e) => e.className === "io-chart-bar").length).toBe(2);
    expect(nodes.some((e) => e.textContent === "(无数据)")).toBe(true);
    expect(nodes.filter((e) => e.className.indexOf("io-sa-node") === 0).map((e) => e.textContent)).toEqual(["根", "子"]);
    const ins = nodes.find((e) => e.attrs["data-io-revised"] === "ins");
    const del = nodes.find((e) => e.attrs["data-io-revised"] === "del");
    expect(ins.textContent).toBe("插入");
    expect(ins.style.textDecoration).toBe("underline");
    expect(del.textContent).toBe("删除"); // del 文本必须显示
    expect(del.style.textDecoration).toBe("line-through");

    const host2: any = new FakeEl("div");
    const r2 = api.render({
      host: host2,
      ast: {
        kind: "docx",
        headers: [{ type: "p", text: "页眉文字" }],
        footers: [{ type: "p", text: "页脚文字" }],
        footnotes: [{ type: "p", text: "脚注文字" }],
        blocks: [{ type: "p", text: "正文", comments: ["批注一", "批注二"] }],
      },
    });
    expect(r2.ok).toBe(true);
    const n2 = flat(host2);
    for (const cls of ["io-header", "io-footer", "io-footnotes"]) expect(n2.filter((e) => e.className === cls).length).toBe(1);
    const badge = n2.find((e) => e.className === "io-cmt-badge");
    expect(badge.textContent).toBe("💬2");
    expect(badge.title).toContain("批注一");
    expect(badge.title).toContain("批注二");
    expect(n2.filter((e) => e.className === "io-cmt-item").map((e) => e.textContent)).toEqual(["批注一", "批注二"]);
  });

  it("空 headers/footers/footnotes 不渲染该区块;清空幂等", () => {
    const api = load({ document: makeFakeDom() });
    const host: any = { appendChild() {}, querySelectorAll: () => [], dataset: {} };
    expect(api.render({ host, ast: { kind: "docx", headers: [], footers: [], footnotes: [], blocks: [] } }).ok).toBe(true);
    expect(api.clear(host)).toBe(true);
    expect(api.clear(undefined)).toBe(true);
  });
});
