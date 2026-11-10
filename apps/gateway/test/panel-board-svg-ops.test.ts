/**
 * 白板 flowkit 断裂修复契约测试 —— 锁住「svg 模式下按钮不再静默失效」的四条口径:
 *  ①整理按钮:svg 模式串含 disabled 且 title 说明布局由 flowkit/ELK 决定;cards 模式逐字保留旧串;
 *  ②导出 PNG:boardExportPng 先走 svg 直出(cvExportSvgPng),拿不到才回退旧卡片/简图路线;
 *  ③导出尺寸计划 cvSvgPngPlan:viewBox 优先,大板(>400 万像素)自动降 1x,无尺寸返回 null(不抛);
 *  ④svg 直操作层 cvBindSvgOps:右键菜单/双击空白/键盘三组绑在 svg 模式;
 *     同时锁死**既有口径不被破坏**——cvBindInteractions 的 svg 首行早退必须仍在(卡片几何交互不能硬塞进 svg)。
 * 手法同 panel-board-flowkit.test.ts:从面板 HTML 花括号配平切函数,new Function 起沙箱,断言真实语义。
 */
import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";

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

/** 最小元素桩:只实现被测函数用到的接口。 */
class StubEl {
  attrs: Record<string, string> = {};
  children: StubEl[] = [];
  id = "";
  constructor(id = "") { this.id = id; }
  getAttribute(k: string) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k]! : null; }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
  append(c: StubEl) { this.children.push(c); return c; }
  find(id: string): StubEl | null {
    for (const c of this.children) { if (c.id === id) return c; const d = c.find(id); if (d) return d; }
    return null;
  }
  querySelector(sel: string) {
    if (sel.indexOf("#cvSvgHost") !== 0) return null;
    const host = this.find("cvSvgHost");
    if (!host) return null;
    if (sel === "#cvSvgHost") return host;
    return host.find("__svg");
  }
}

/** 建最小画布 DOM:host > #cvWorld > #cvSvgHost > svg(viewBox 可选)。 */
function canvasDom(viewBox: string | null) {
  const host = new StubEl("host");
  const world = host.append(new StubEl("cvWorld"));
  const svgHost = world.append(new StubEl("cvSvgHost"));
  let svg: StubEl | null = null;
  if (viewBox !== null) {
    svg = svgHost.append(new StubEl("__svg"));
    if (viewBox !== "") svg.setAttribute("viewBox", viewBox);
  }
  return { host, svg };
}

describe("白板 flowkit 断裂修复", () => {
  it("①整理按钮:svg 模式置灰+说明,cards 模式逐字保留旧串", async () => {
    await withPanel(7985, (html) => {
      const src = extractFn(html, "cvRailAddbarHtml");
      const rail = new Function(src + NL + "return cvRailAddbarHtml;")() as (m: string) => string;
      const svgHtml = rail("svg");
      // svg 模式:必须 disabled(点了没反应=静默失败,是本次普查要清掉的形态)
      expect(svgHtml).toContain('id="cvArrangeBtn" disabled');
      expect(svgHtml).toContain("flowkit"); // 说明里点明为什么不可用
      // 「添加模块」在 svg 下仍可用(它只改 BoardDoc,不依赖卡片几何)
      expect(svgHtml).toContain('id="cvAddBtn"');
      expect(svgHtml).not.toContain('id="cvAddBtn" disabled');
      // cards 模式:旧串逐字不变(不加 disabled,title 仍是旧的)
      const cardsHtml = rail("cards");
      expect(cardsHtml).not.toContain("disabled");
      expect(cardsHtml).toContain("按调用关系自动重排全部模块");
      // 调用点:底部工具条按当前渲染模式取串(不是写死一种)
      expect(html).toContain('(ro ? "" : cvRailAddbarHtml(cvMode))');
    });
  });

  it("②导出 PNG:svg 直出优先,拿不到才回退旧路线(负向:无 svg 返回 false 不抛)", async () => {
    await withPanel(7986, (html) => {
      const fnBody = extractFn(html, "boardExportPng");
      // 顺序契约:先试 svg 直出,再走 world 卡片路线 —— 这是「导出按钮 100% 失效」的修法本体
      const iSvg = fnBody.indexOf("cvExportSvgPng(host)");
      const iWorld = fnBody.indexOf('querySelector(".bf-cv-world")');
      expect(iSvg).toBeGreaterThan(0);
      expect(iWorld).toBeGreaterThan(iSvg);

      // 行为契约:没有 #cvSvgHost svg 的宿主 → cvExportSvgPng 返回 false(调用方继续走旧路线),绝不抛
      const src = extractFn(html, "cvSvgPngPlan") + NL + extractFn(html, "cvSvgBox") + NL + extractFn(html, "cvExportSvgPng");
      const sb = new Function("XMLSerializer", "Image", "toast", "document", "window", "boardTaskId",
        src + NL + "return cvExportSvgPng;")(
        class { serializeToString() { return ""; } } as unknown as typeof XMLSerializer,
        class { onload: null | (() => void) = null; onerror: null | (() => void) = null; src = ""; set src2(_v: string) {} } as unknown as typeof Image,
        () => { /* toast 桩 */ },
        { body: { backgroundColor: "" }, getComputedStyle: () => ({ backgroundColor: "" }), createElement: () => ({ getContext: () => ({ fillRect() {}, drawImage() {} }), toDataURL: () => "" }) },
        { getComputedStyle: () => ({ backgroundColor: "" }) },
        "t1",
      ) as (h: unknown) => boolean;
      // 无 svg 主机 → false(不抛错、不假装成功)
      expect(sb(new StubEl("host"))).toBe(false);
      // 有 #cvSvgHost 但没 svg → 同样 false
      const emptyDom = new StubEl("host");
      emptyDom.append(new StubEl("cvWorld")).append(new StubEl("cvSvgHost"));
      expect(sb(emptyDom)).toBe(false);
    });
  });

  it("③导出尺寸计划:viewBox 优先;大板按像素面积降 1x;无尺寸返回 null", async () => {
    await withPanel(7987, (html) => {
      const src = extractFn(html, "cvSvgPngPlan") + NL + extractFn(html, "svgAttrNum") + NL + extractFn(html, "cvSvgBox") + NL + extractFn(html, "cvVbParse");
      const plan = new Function(src + NL + "return cvSvgPngPlan;")() as (s: string) => { w: number; h: number; scale: number; outW: number; outH: number } | null;
      // 常规板:2x
      const small = plan('<svg viewBox="0 0 400 300"></svg>')!;
      expect(small).toEqual({ w: 400, h: 300, scale: 2, outW: 800, outH: 600 });
 // 经验证大板(7261×2942):2x = 341MB RGBA → 必须降 1x,不许把浏览器打爆
      const big = plan('<svg viewBox="0 0 7261 2942"></svg>')!;
      expect(big.scale).toBe(1);
      expect(big.outW).toBe(7261);
      expect(big.outH).toBe(2942);
      // 没有 viewBox 时退 width/height 属性
      const attrOnly = plan('<svg width="640" height="480"></svg>')!;
      expect([attrOnly.w, attrOnly.h]).toEqual([640, 480]);
      // 负向:一个尺寸都拿不到 → null(调用方回退,不抛)
      for (const bad of ["", "<svg></svg>", "<svg viewBox=\"\"></svg>", "<svg viewBox=\"0 0 0 300\"></svg>"]) {
        expect(plan(bad)).toBeNull();
      }
    });
  });

  it("④svg 直操作层:三组入口绑在 svg 模式;卡片几何交互仍只在 cards 路径", async () => {
    await withPanel(7988, (html) => {
      const bind = extractFn(html, "cvBindSvgOps");
      expect(bind).toContain('cvRenderMode() !== "svg"');
      // 三组断裂入口(svg 模式下原本随 cvBindInteractions 早退一起消失)
      expect(bind).toContain('addEventListener("contextmenu"');
      expect(bind).toContain('addEventListener("dblclick"');
      expect(bind).toContain('addEventListener("keydown"');
      // 节点命中走 svg 自己的口径,不是 .cv-node
      expect(bind).toContain("cvSvgNodeAt(e)");
      expect(bind).not.toContain("dataset.cv");
      // 右键菜单四项(节点)+ 空白三项,逐字锁住"不再空菜单"
      for (const label of ["编辑明细", "复制", "创建副本", "删除", "粘贴", "添加模块", "适配全部"]) {
        expect(bind).toContain(label);
      }
      // 明确不可用的路径要给出说明,而不是静默:整理布局置灰 + Ctrl+A 提示
      expect(bind).toContain("整理布局(SVG 视图不适用)");
      expect(bind).toContain("全选/框选");
      // 调用点:每次画布渲染都绑(与 cvBindInteractions 并列,互不干扰)
      expect(html).toContain("cvBindSvgOps(host, doc);");
      // 既有口径不许破坏:cvBindInteractions 的 svg 首行早退仍在(卡片几何交互不能搬进 svg)
      expect(extractFn(html, "cvBindInteractions")).toContain('if (cvRenderMode() === "svg") return;');
    });
  });
});

/** 从 a 切到 b(不含 b)的一段源码;用于箭头函数/事件分支这类「无函数名」的片段。 */
function sliceBetween(html: string, a: string, b: string): string {
  const i = html.indexOf(a);
  expect(i, "未找到起点 " + a.slice(0, 40)).toBeGreaterThan(0);
  const j = html.indexOf(b, i);
  expect(j, "未找到终点 " + b.slice(0, 40)).toBeGreaterThan(i);
  return html.slice(i, j);
}

/** 最小 toast/WS 记录桩。 */
function recorder() {
  const sent: string[] = [], toasts: string[] = [];
  return {
    sent, toasts,
    wsSafeSend(s: string) { sent.push(s); },
    toast(t: string) { toasts.push(t); },
  };
}

describe("画布四件事(添加闭环/平移/连线/边标签常显)", () => {
  it("A1 添加闭环:cvAfterStruct 走 bdSaveNow;在途笔排队补发不丢笔", async () => {
    await withPanel(7989, (html) => {
      const after = extractFn(html, "cvAfterStruct");
      // 结构变更不再走 900ms 防抖(注释里提到旧名是允许的,但**调用**必须没有)
      expect(after).toContain("if (!boardEditOn) bdSaveNow();");
      expect(after).not.toContain("bdSaveLayoutDebounced();");
      expect(after).toContain("renderBoard();"); // 先重渲再落盘,顺序不变

      // 行为:在途 → 排队;回执后 flush 补发同一笔内容(不是丢弃)
      const src = extractFn(html, "bdSaveNow") + NL + extractFn(html, "bdSaveFlushQueued");
      const timers: Array<() => void> = [];
      const rec = recorder();
      const sb = new Function(
        "S", "wsSafeSend", "currentSid", "boardTaskId", "toast", "setTimeout", "clearTimeout", "bdSentStructSig", "JSON",
        "var boardDoc = S.doc, cvRo = false, bdLayoutInflight = false, bdSaveQueued = false, bdLayoutTimer = null;" + NL +
        src + NL +
        "return {" +
        "  save: bdSaveNow, flush: bdSaveFlushQueued," +
        "  st: function () { return { inflight: bdLayoutInflight, queued: bdSaveQueued, timer: !!bdLayoutTimer }; }," +
        "  ack: function () { bdLayoutInflight = false; bdLayoutTimer = null; }" +
        "};",
      )(
        { doc: { rev: 7, nodes: [{ id: "n1" }], edges: [] } },
        rec.wsSafeSend, "sid-1", "task-1", rec.toast,
        (fn: () => void) => { timers.push(fn); return timers.length; },
        () => { /* clearTimeout */ },
        () => "sig",
        JSON) as {
        save: () => boolean; flush: () => void;
        st: () => { inflight: boolean; queued: boolean; timer: boolean };
        ack: () => void;
      };

      expect(sb.save()).toBe(true); // 第一笔真发出去
      expect(rec.sent.length).toBe(1);
      const f1 = JSON.parse(rec.sent[0]!);
      expect(f1.type).toBe("board.save");
      expect(f1.baseRev).toBe(7);
      expect(sb.st().inflight).toBe(true);

      expect(sb.save()).toBe(false); // 在途:不发第二笔
      expect(sb.st().queued).toBe(true); // 但记下「还有一笔要补」
      expect(sb.st().timer).toBe(true); // 并排了补发定时(不是静默丢弃)
      expect(rec.sent.length).toBe(1); // 没重复发

      sb.flush(); // 仍在途 → 再排一次,不丢
      expect(rec.sent.length).toBe(1);
      expect(sb.st().queued).toBe(true);

      sb.ack(); // 模拟 board.save 回执落地(在途旗解除)
      sb.flush();
      expect(rec.sent.length).toBe(2); // 排队那笔补发成功
      const f2 = JSON.parse(rec.sent[1]!);
      expect(f2.type).toBe("board.save");
      expect(f2.doc.nodes.length).toBe(1); // 内容仍在(不是空笔)
      expect(sb.st().queued).toBe(false);
    });
  });

  it("A2 出图等待期保留上一版 svg:stale 分支 + data-stale=\"1\" 由 p.stale 决定", async () => {
    await withPanel(7990, (html) => {
      // 源码:旧图复用三要素(hasNow 判当前版 / stale 判「有旧图但非当前版」/ body 取旧图)
      expect(html).toContain("const cvSvgHasNow = cvMode === \"svg\" && cvSvgCacheSig === cvSvgSigNow && !!cvSvgCacheHtml;");
      expect(html).toContain("const cvSvgStale = cvMode === \"svg\" && !cvSvgHasNow && !!cvSvgCacheHtml;");
      expect(html).toContain("const cvSvgBodyOut = cvSvgStale ? cvSvgCacheHtml : cvSvgBodyHtml;");
      expect(html).toContain("const cvSvgBodySig = cvSvgStale ? cvSvgCacheSig : cvSvgSigNow;");
      // 新图到位后抹掉「等图」标记
      expect(html).toContain('old.removeAttribute("data-stale")');
      // 等图期降透明度的 CSS 在
      expect(html).toContain('.cv-svg-host[data-stale="1"]');

      // 行为:纯函数直接跑
      const escSrc = "function esc(s) { return String(s); }";
      const src = escSrc + NL + extractFn(html, "cvWorldBodyHtml");
      const world = new Function(src + NL + "return cvWorldBodyHtml;")() as (m: string, p: unknown) => string;
      const base = { laneHtml: "", edgeSvg: "", popupMask: "", cards: "", anchors: "", fold: "" };
      const SVG = '<svg id="pic"><g data-node-id="n1"></g></svg>';

      // stale=true:旧图继续挂着 + data-stale="1"
      const stale = world("svg", { ...base, svg: SVG, sig: "OLD", stale: true });
      expect(stale).toContain(SVG);
      expect(stale).toContain('data-stale="1"');
      expect(stale).toContain('data-sig="OLD"'); // sig 写的是「DOM 里真装着的那一版」
      // stale=false:新图正常,不带 stale 标记
      const fresh = world("svg", { ...base, svg: SVG, sig: "NEW", stale: false });
      expect(fresh).toContain(SVG);
      expect(fresh).not.toContain("data-stale");
      expect(fresh).toContain('data-sig="NEW"');
      // 空壳帧(还没有任何图):不写 data-sig(p.svg 空串),否则 inject 分支永不可达
      const shell = world("svg", { ...base, svg: "", sig: "NEW", stale: false });
      expect(shell).not.toContain("data-sig");
      expect(shell).not.toContain("data-stale");
      // cards 模式逐字老口径:三块原样拼接,不掺 svg/stale
      const cards = world("cards", { ...base, laneHtml: "L", edgeSvg: "E", popupMask: "P", cards: "C", anchors: "A", fold: "F", svg: SVG, sig: "S", stale: true });
      expect(cards).toBe("LEPC" + "AF");
    });
  });

  it("A3 平移:svg 节点 pointerdown 不再 stopPropagation;任何位置左键都平移(编辑态不早退);点选挪到 pointerup+位移阈值", async () => {
    await withPanel(7991, (html) => {
      // 按下分支(从 cvSvgDown 声明到按下记录行):不许吞事件 —— 吞了平移分支就永远收不到节点上的按下
      const down = sliceBetween(html, "let cvSvgDown = null;", "cvSvgDown = id ? { id: id, sx: e.clientX, sy: e.clientY } : null;");
      expect(down).not.toContain("e.stopPropagation()");
      expect(down).not.toContain("e.preventDefault();\n    }\n    // 不 preventDefault");
      expect(down).toContain("cvSvgNodeAt(e)");

      // pan 分支:编辑态也照常平移(svg 视图无节点拖拽实现,旧口径「编辑态早退」=图元上拖不动的死区)
      expect(html).not.toContain('if (cvMode === "svg" && cvSvgNodeAt(e) && boardEditOn) return;');
      expect(html).toContain('if (cvMode === "svg" && cvLinkFrom) return;'); // 唯一的图元期早退=连线态

      // 点选:pointerup 结算 + 位移 <4px 才算点击
      const pend = sliceBetween(html, "const pend = (e) => {", 'cvHost.addEventListener("pointerup", pend);');
      expect(pend).toContain('e.type !== "pointerup"');
      expect(pend).toContain(">= 4");
      expect(pend).toContain("boardSelNode = (boardSelNode === d.id) ? null : d.id;");
      expect(pend).toContain("renderBoardDetail()");
      // 点选逻辑不许再出现在按下分支里(否则拖动会顺手改选中)
      expect(down).not.toContain("boardSelNode =");
    });
  });

  it("A4 连线入口:cvLinkFrom/cvLinkAskWord 存在,label 真进 edges;Esc 退出连线态", async () => {
    await withPanel(7992, (html) => {
      expect(html).toContain("let cvLinkFrom = null;");
      expect(extractFn(html, "cvLinkAskWord")).toContain("cvAddEdge(from, to, word)");
      expect(extractFn(html, "cvLinkStart")).toContain("cvLinkFrom = id;");
      expect(extractFn(html, "cvLinkCancel")).toContain("cvLinkFrom = null;");
      // 两条入口:L 键 + 右键「连线到…」
      expect(extractFn(html, "cvBindSvgOps")).toContain("cvLinkStart(boardSelNode)");
      expect(extractFn(html, "cvBindSvgOps")).toContain("连线到…");
      // Esc 退出连线态(cvBindSvgOps 的 Escape 分支)
      const esc = sliceBetween(extractFn(html, "cvBindSvgOps"), 'if (e.key === "Escape")', "}, true);");
      expect(esc).toContain("cvLinkCancel()");
      // 连线态下点目标 = 收线,不起平移
      expect(html).toContain("if (cvMode === \"svg\" && cvLinkFrom) return;");

      // 行为:cvAddEdge 的第三次参数真的落到 edges[].label
      const src = extractFn(html, "cvAddEdge");
      const rec = recorder();
      const doc: { rev: number; docKind: string; nodes: Array<{ id: string; kind: string; label: string }>; edges: Array<Record<string, unknown>> } =
        { rev: 1, docKind: "design", nodes: [{ id: "n1", kind: "module", label: "A" }, { id: "n2", kind: "module", label: "B" }], edges: [] };
      const addEdge = new Function(
        "cvRo", "cvTargetDoc", "cvPushUndo", "cvAfterStruct", "toast", "cvUndoStack",
        src + NL + "return cvAddEdge;",
      )(false, () => doc, () => { /* undo */ }, () => { /* after */ }, rec.toast, []) as (f: string, t: string, l?: string) => void;
      addEdge("n1", "n2", "验证");
      expect(doc.edges.length).toBe(1);
      const e0 = doc.edges[0]!;
      expect(e0.from).toBe("n1");
      expect(e0.to).toBe("n2");
      expect(e0.label).toBe("验证");
      expect(e0.virtual).toBe(true);
      // 关系词留空:不写 label 字段(旧口径不变)
      addEdge("n2", "n1", "");
      expect(doc.edges.length).toBe(2);
      expect("label" in doc.edges[1]!).toBe(false);
      // 重复边:拒收 + 说明
      addEdge("n1", "n2", "再连一次");
      expect(doc.edges.length).toBe(2);
      expect(rec.toasts.join("|")).toContain("已有连线");
    });
  });

  it("A5 边标签常显:cvLabelHideK() 是唯一出处,z-low 与 fit 提示共用,不再写死阈值", async () => {
    await withPanel(7993, (html) => {
      const hideK = extractFn(html, "cvLabelHideK");
      // 同一段源码在两个沙箱里跑,只换 cvUiInfo(普通板 / UI 交互图)
      const kOf = (ui: unknown) => (new Function("cvUiInfo", hideK + NL + "return cvLabelHideK();")(ui) as number);
      expect(kOf(null)).toBe(0.4);
      expect(kOf({ page: "x" })).toBe(0.38);

      // z-low 走单一出处
      expect(extractFn(html, "cvApplyTf")).toContain('world.classList.toggle("z-low", cvPan.k < cvLabelHideK());');
      // fit 提示同样从它取门槛(不是再写一份 0.42/0.55)
      expect(extractFn(html, "cvFitNow")).toContain("const labelHideK = cvLabelHideK();");
      expect(extractFn(html, "cvFitNow")).toContain("if (cvPan.k < labelHideK)");
      // 全局:不再有写死的标签隐藏阈值常量比较
      expect(html).not.toContain("cvPan.k < 0.55");
      expect(html).not.toContain("cvPan.k < 0.42");
      expect(html).not.toContain("cvPan.k < 0.38");
      expect(html).not.toContain("cvPan.k < 0.4)");
    });
  });

  it("A7 删除:剔节点同时剔悬空边,并经 cvAfterStruct 即时落盘", async () => {
    await withPanel(7995, (html) => {
      const doc: { nodes: Array<{ id: string }>; edges: Array<{ from: string; to: string }> } = {
        nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
        edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "a", to: "c" }],
      };
      const marks: string[] = [];
      const del = new Function(
        "cvRo", "cvTargetDoc", "cvPushUndo", "cvSelected", "cvAfterStruct", "toast", "boardSelNode",
        extractFn(html, "cvDelNodes") + NL + "return cvDelNodes;",
      )(false, () => doc, () => { /* undo */ }, new Set<string>(), () => marks.push("after"), () => { /* toast */ }, null) as (ids: string[]) => void;
      del(["b"]);
      expect(doc.nodes.map((n) => n.id)).toEqual(["a", "c"]);
      // 两条含 b 的边一起消失,只剩 a->c(悬空边零残留)
      expect(doc.edges.map((e) => e.from + "->" + e.to)).toEqual(["a->c"]);
      expect(marks).toEqual(["after"]); // 结构变更走 cvAfterStruct(内部 bdSaveNow → 即时落盘)
      // 拒收路径仍在:只读画布、删到空
      expect(extractFn(html, "cvDelNodes")).toContain("if (cvRo) return;");
      expect(extractFn(html, "cvDelNodes")).toContain("至少保留一个模块");
    });
  });

  it("A6 添加模块:同名类型带序号 + 立即回执 toast", async () => {
    await withPanel(7994, (html) => {
      const add = extractFn(html, "cvAddNode");
      // 同 kind 计数 → 「函数 2 / 函数 3」
      expect(add).toContain('for (const x of t.nodes) if (x && x.kind === (kind || "module")) sameKind++;');
      expect(add).toContain('label: sameKind ? baseName + " " + (sameKind + 1) : baseName');
      // 出图期间立即回执(不再「点了没反应」)
      expect(add).toContain('toast("已添加 " + baseName + "「" + n.label + "」· 正在出图…");');
      // 回执在 cvAfterStruct 之前(先给反馈,再重渲落盘)
      expect(add.indexOf("正在出图")).toBeLessThan(add.indexOf("cvAfterStruct();"));
      // 新节点保持选中(右栏明细卡随 renderBoard 带出来)
      expect(add).toContain("boardSelNode = n.id;");
    });
  });
});
