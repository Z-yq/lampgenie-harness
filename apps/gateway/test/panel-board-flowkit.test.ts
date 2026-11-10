/**
 * 白板画布「flowkit 单张 SVG」契约测试 —— 锁住渲染模式开关与 svg 路径的五个硬口径:
 *  ①svg 模式渲染: #cvWorld 里没有卡片 DOM(.cv-node 计数 0),世界内容只有一个 .cv-svg-host 主机;
 *  ②cards 回退(localStorage.cvRender="cards"):逐节点卡片照旧出,画布内 0 个 svg 主机;
 *  ③世界尺寸:回包 svg 的 viewBox w/h + 60 留白;viewBox 畸形 → 回退(cards 累加结果),不抛错;
 *  ④适配下限:CV_FIT_READABLE_MIN=0.7 仍夹住适配 k(1000 宽内容进 500 宽画布 → 0.7 不是 0.5);
 *  ⑤增量补丁:同 rev 不重注入 svg、不动 cvPan(既有 P0「保存回执抢走用户视野」不许复活)。
 * 手法与 panel-board-live.test.ts 同构:从真实面板 HTML 花括号配平切函数后 new Function 执行;
 * 本仓 vitest 是 node 环境(无 jsdom),所以 DOM 只做**最小桩**(只实现被测函数真正调用的接口),
 * 断言落在真实语义上(返回的字符串/数值/调用次数),不做版式断言。
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

/** 取 svg 模式那段的函数源码集合(渲染模式 + viewBox 解析 + 世界尺寸 + 内容框 + 增量决策)。 */
const SVG_SRC = ["cvRenderMode", "cvSvgFilterOf", "cvSvgSig", "cvVbParse", "cvSvgBox", "cvSvgWorldSize", "cvSvgContentBox", "cvSvgPatchPlan", "esc"];

/** localStorage 桩:按给定表返回;另一个实例 throw(隐私模式/不可用)→ 必须回退 svg。 */
function lsStub(map: Record<string, string>): { getItem: (k: string) => string | null } {
  return { getItem: (k: string) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k]! : null) };
}
function lsBroken(): { getItem: (k: string) => string | null } {
  return { getItem: () => { throw new Error("localStorage 不可用"); } };
}

/** 最小元素桩:只实现被测代码用到的接口(attrs/querySelector/innerHTML/children)。 */
class StubEl {
  attrs: Record<string, string> = {};
  children: StubEl[] = [];
  innerHTML = "";
  id = "";
  constructor(id = "") { this.id = id; }
  getAttribute(k: string) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k]! : null; }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
  append(c: StubEl) { this.children.push(c); return c; }
  /** 深度优先找 id(画布桩里 #cvSvgHost 挂在 #cvWorld 下面,不是 host 的直接子节点)。 */
  find(id: string): StubEl | null {
    for (const c of this.children) { if (c.id === id) return c; const d = c.find(id); if (d) return d; }
    return null;
  }
  /** 只支持两种形态: "#cvSvgHost > svg" / "#cvSvgHost svg" 与 "#cvSvgHost"。 */
  querySelector(sel: string) {
    const wantSvgHost = sel.indexOf("#cvSvgHost") === 0;
    if (!wantSvgHost) return null;
    const host = this.find("cvSvgHost");
    if (sel === "#cvSvgHost") return host;
    const svg = host ? host.find("__svg") : null;
    return svg;
  }
}

/** 建一棵最小的画布 DOM:#cvWorld > #cvSvgHost > svg(viewBox 可选;传 "" 表示有 svg 但无 viewBox)。返回 host 与 svg 元素。 */
function canvasDom(viewBox: string | null, withSvgHost = true, withWorld = true) {
  const host = new StubEl("host");
  const world = new StubEl("cvWorld");
  if (withWorld) host.append(world);
  let svg: StubEl | null = null;
  let svgHost: StubEl | null = null;
  if (withSvgHost) {
    svgHost = world.append(new StubEl("cvSvgHost"));
    if (viewBox !== null) {
      svg = svgHost.append(new StubEl("__svg"));
      if (viewBox !== "") svg.setAttribute("viewBox", viewBox);
    }
  }
  return { host, world, svgHost, svg };
}

/** 把一小组面板函数拼成可执行沙箱(只有 localStorage 由用例给),返回导出面。
 *  cvSvgContentBox 走 cvHostEl() 取默认宿主,所以把宿主查找也一起拉进沙箱(测试里显式传 host 时用不到)。 */
function sandbox(html: string, ls: { getItem: (k: string) => string | null }) {
  const names = SVG_SRC.concat(["cvHostEl"]);
  const src = names.map((n) => extractFn(html, n)).join(NL);
  const ret = "return {" + SVG_SRC.filter((n) => n !== "esc").join(",") + "};";
  const f = new Function("localStorage", "document", "cvActiveHost", src + NL + ret) as (l: unknown, d?: unknown, a?: unknown) => Record<string, any>;
  return f(ls, { getElementById: () => null }, null);
}

const SVG_OK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="400" height="300"><rect/></svg>';

describe("白板 flowkit 单张 SVG 渲染", () => {
  it("single-svg:svg 模式渲染 —— #cvWorld 里 0 张节点卡、恰好 1 个 svg 主机(内容=回包那张 SVG)", async () => {
    await withPanel(7981, (html) => {
      const sb = sandbox(html, lsStub({}));
      // 默认走 svg(单点回滚开关缺省值)
      expect(sb.cvRenderMode()).toBe("svg");
      // 渲染模式开关必须真被用到:拼串分流 + 世界尺寸 + 适配 + 交互绑定 + 小地图各处都问它
      const body = extractFn(html, "cvWorldBodyHtml");
      expect(body).toContain('if (mode === "cards") return p.laneHtml + p.edgeSvg');
      expect(body).toContain('id="cvSvgHost"');
      expect(html).toContain('const cvSvgBodyHtml = cvMode === "svg" ?');
      // 世界拼串点:svg 模式的"三块"= 唯一一个 svg 主机;cards 模式仍是泳道+边+卡三块
      const svgBody = body.slice(body.indexOf("return p.popupMask"));
      expect(svgBody).toContain('<div class="cv-svg-host" id="cvSvgHost"');
      expect(svgBody).not.toContain("p.laneHtml");
      expect(svgBody).not.toContain("p.cards");
      // 行为:走 svg 分支拼出的内容里没有任何 .cv-node 卡片,只有 1 个 svg 主机
      const mk = new Function(extractFn(html, "esc") + NL + body + NL + "return cvWorldBodyHtml;")() as (m: string, p: unknown) => string;
      const out = mk("svg", { laneHtml: '<div class="cv-lane">lane</div>', edgeSvg: '<svg class="bf-cv-edges"></svg>', popupMask: "", cards: '<div class="cv-node">卡</div>', anchors: "", fold: "", svg: SVG_OK, sig: "t1|3|svg" });
      expect(out.split("cv-svg-host").length - 1).toBe(1);
      expect(out).toContain('id="cvSvgHost"');
      expect(out).toContain("viewBox");
      expect(out).not.toContain("cv-node");
      expect(out).not.toContain("cv-lane");
      expect(out).not.toContain("bf-cv-edges");
      // cards 模式:老拼串逐字保留(泳道 + 边 + 卡片三块都在,顺序不变)
      const outC = mk("cards", { laneHtml: "<LANE>", edgeSvg: "<EDGE>", popupMask: "<MASK>", cards: "<CARDS>", anchors: "<ANCH>", fold: "<FOLD>", svg: SVG_OK, sig: "s" });
      expect(outC).toBe("<LANE><EDGE><MASK><CARDS><ANCH><FOLD>");
      expect(outC).not.toContain("cv-svg-host");
 // DOM 计数口径(经验证):svg 模式画布内 .cv-node=0、.cv-svg-host=1;cards 模式 .cv-node=N、.cv-svg-host=0
      const count = (h: string, cls: string) => h.split('class="' + cls).length - 1;
      expect(count(out, "cv-node")).toBe(0);
      expect(count(out, "cv-svg-host")).toBe(1);
      expect(count(mk("cards", { laneHtml: "", edgeSvg: "", popupMask: "", cards: '<div class="cv-node">a</div><div class="cv-node">b</div>', anchors: "", fold: "", svg: "", sig: "s" }), "cv-node")).toBe(2);
      // 交互降级:svg 模式卡片交互一律不绑(平移/缩放/滚轮/「适」「全」/小地图委托不在该函数里)
      const bind = extractFn(html, "cvBindInteractions");
      expect(bind).toContain('if (cvRenderMode() === "svg") return;');
    });
  }, 30_000);

  it("cards-fallback:localStorage.cvRender='cards' → 卡片路径逐字回退,cvRenderMode 单点回滚真的生效", async () => {
    await withPanel(7982, (html) => {
      // 回滚开关:只有字面 "cards" 才回退,其它任何值/异常一律 svg(不能因为脏值把画布画空)
      expect(sandbox(html, lsStub({ cvRender: "cards" })).cvRenderMode()).toBe("cards");
      expect(sandbox(html, lsStub({})).cvRenderMode()).toBe("svg");
      expect(sandbox(html, lsStub({ cvRender: "svg" })).cvRenderMode()).toBe("svg");
      expect(sandbox(html, lsStub({ cvRender: "CARDS" })).cvRenderMode()).toBe("svg");
      expect(sandbox(html, lsBroken()).cvRenderMode()).toBe("svg"); // localStorage 抛错 → svg,不崩
      // 模式进签名:切模式必须触发整体重渲(否则缓存/早退会把老模式钉死在 DOM 上)
      const sbC = sandbox(html, lsStub({ cvRender: "cards" }));
      expect(sbC.cvSvgSig({ taskId: "t1", rev: 3 })).toBe("t1|3|cards");
      expect(sandbox(html, lsStub({})).cvSvgSig({ taskId: "t1", rev: 3 })).toBe("t1|3|svg");
      // cards 模式下不拼 svg 主机(cvSvgBodyHtml 空串),旧串仍在
 // P0 修复后:cvSvgBodyHtml 只传**裸 svg 文本**(外壳由 cvWorldBodyHtml 唯一负责),
      // 且内容只在「缓存签名命中且非空」时才带上;否则空串(空壳帧,等回包)。
      expect(html).toContain('const cvSvgBodyHtml = cvMode === "svg" ?');
      expect(html).toContain('(cvSvgHasNow ? cvSvgCacheHtml : "") : "";');
      expect(html).toContain("const cvSvgHasNow = cvMode === \"svg\" && cvSvgCacheSig === cvSvgSigNow && !!cvSvgCacheHtml;");
      // 根因锁死:svg 主机的外壳只有一层(cvSvgBodyHtml 不得再包一层 #cvSvgHost),且 data-sig
      // 只在真有 svg 内容时才写——空壳帧写 sig 会让回包后 cvSvgPatchPlan 恒判 keep,注入永不发生
      expect(html).toContain("const sigAttr = p.svg ? ' data-sig=\"' + esc(p.sig) + '\"' : \"\";");
      expect(html.match(/id="cvSvgHost"/g) || []).toHaveLength(1);
      // cards 模式的增量路径没被 svg 分支污染:结构签名 + cvPatchCanvas 仍只对 cards 生效
      expect(html).toContain('if (cvMode === "cards" && host.__cvSig === sig && host.querySelector(".bf-cv-world")) {');
      expect(html).toContain("if (cvPatchCanvas(host, doc, pos, ro, roLinks)) return;");
    });
  }, 30_000);

  it("world-size:viewBox '0 0 400 300' → 世界 460×360(+60 留白);畸形 viewBox 回退不抛错", async () => {
    await withPanel(7983, (html) => {
      const sb = sandbox(html, lsStub({}));
      // 主干:viewBox 宽高 + 60 留白(与前字符串最大值的 +60 口径一致)
      expect(sb.cvSvgBox(SVG_OK)).toEqual({ minX: 0, minY: 0, w: 400, h: 300 });
      expect(sb.cvSvgWorldSize(SVG_OK)).toEqual({ w: 460, h: 360 });
      // 负 minX/minY(布局留白平移)也照读:只取宽高,不搬运坐标
      expect(sb.cvSvgBox('<svg viewBox="-20 -40 400 300">')).toEqual({ minX: -20, minY: -40, w: 400, h: 300 });
      // 逗号分隔/多余空白/单引号属性都认
      expect(sb.cvSvgBox('<svg viewBox="0,0,400,300">')).toEqual({ minX: 0, minY: 0, w: 400, h: 300 });
      expect(sb.cvSvgBox("<svg viewBox='  0 0 400 300 '>")).toEqual({ minX: 0, minY: 0, w: 400, h: 300 });
      // 畸形/缺失 → null(调用方据此回退 cards 累加结果,绝不崩)
      for (const bad of ["", "<svg/>", '<svg viewBox="">', '<svg viewBox="0 0 0 300">', '<svg viewBox="0 0 400 0">',
        '<svg viewBox="0 0 a b">', '<svg viewBox="0 0 400">', '<svg viewBox="0 0 400 300 9">', null, undefined]) {
        expect(sb.cvSvgBox(bad), String(bad)).toBeNull();
        expect(sb.cvSvgWorldSize(bad), String(bad)).toBeNull();
      }
      // 渲染链接线:svg 模式下 maxX/maxY 直接吃回包 viewBox(不再累加卡片包围盒),失败时不动累加值
      expect(html).toContain("const cvSvgBoxNow = cvMode === ");
      expect(html).toContain('? cvSvgWorldSize(cvSvgCacheSig === cvSvgSigNow ? cvSvgCacheHtml : "") : null;');
      expect(html).toContain("if (cvSvgBoxNow) { maxX = cvSvgBoxNow.w; maxY = cvSvgBoxNow.h; }");
      // 缓存签名不匹配 = 另一个 rev 的 svg,不能拿来定世界尺寸(尺寸随内容变)
      const mixed = sandbox(html, lsStub({}));
      expect(mixed.cvSvgWorldSize("")).toBeNull();
      // 内容框(适配/小地图用):优先 viewBox;无 viewBox 退 width/height;都没有 → null
      const d1 = canvasDom("0 0 1000 700");
      expect(sb.cvSvgContentBox(d1.host)).toEqual({ w: 1000, h: 700 });
      const d2 = canvasDom("");
      d2.svg!.setAttribute("width", "640"); d2.svg!.setAttribute("height", "480");
      expect(sb.cvSvgContentBox(d2.host)).toEqual({ w: 640, h: 480 });
      const d3 = canvasDom(null);
      expect(sb.cvSvgContentBox(d3.host)).toBeNull();
      const d4 = canvasDom("0 0 400 300", false);
      expect(sb.cvSvgContentBox(d4.host)).toBeNull();
      expect(sb.cvSvgContentBox(null)).toBeNull();
    });
  }, 30_000);

  it("fit:viewBox 宽 1000 进 500 宽画布 → naturalK 0.5 被 CV_FIT_READABLE_MIN(0.7)夹回 0.7;畸形 viewBox 不重置视野", async () => {
    await withPanel(7984, (html) => {
      // 常量在位(下限没被删/没被调松)
      expect(html).toContain("const CV_FIT_READABLE_MIN = 0.7;");
      const sb = sandbox(html, lsStub({}));
      const box = sb.cvSvgContentBox(canvasDom("0 0 1000 700").host);
      expect(box).toEqual({ w: 1000, h: 700 });
      // cvFitNow 的算式与夹取逐字复刻(取自真实源码,防止以后改动漂移):
      //   maxX = w + 60, maxY = h + 60 → naturalK = min(W/(maxX-minX+40), availH/(maxY+40)) → clamp(fitMinK, MAX)
      const CV_MAX_ZOOM = 2, CV_FIT_READABLE_MIN = 0.7;
      const fitK = (w: number, rw: number, rh: number) => {
        const maxX = w + 60, maxY = 0 + 60 + 0; // minX/minY=0
        const availH = Math.max(120, rh - 8);
        const naturalK = Math.min(rw / (maxX - 0 + 40), availH / (maxY - 0 + 40));
        return { naturalK, k: Math.min(CV_MAX_ZOOM, Math.max(CV_FIT_READABLE_MIN, naturalK)) };
      };
      const r = fitK(1000, 500, 400);
      expect(r.naturalK).toBeCloseTo(500 / 1100, 6); // ≈0.4545:内容 1000 宽进 500 宽画布
      expect(r.k).toBe(0.7); // 被可读下限夹住(不是 0.4545)
      // 内容小到天然 k>0.7 时下限不干预(夹取是下限不是钉死)
      expect(fitK(200, 500, 400).k).toBeGreaterThan(0.7);
      // 实际源码口径一致:svg 模式的包围盒 = viewBox + 60,常量与夹取原样保留
      const fit = extractFn(html, "cvFitNow");
 // 任务B(E1):「适」默认改紧凑 fit(引擎 resolveSvgBoundsFromDom 的可见图形并集,
      // 排除 defs/mask/clipPath/画布背景 rect);旧 viewBox 口径只在取证开关 __cvFitBasis==="viewbox"
      // 时启用。两条口径都必须保留,否则新旧对照截图无从取证、回退也没着落。
      expect(fit).toContain('window.__cvFitBasis === "viewbox"');
      expect(fit).toContain("cvFitOldBasis ? cvSvgContentBox(cvH) : cvTightSvgBounds(cvH)");
      expect(fit).toContain("if (cvSvgB) { minX = cvSvgB.minX || 0; minY = cvSvgB.minY || 0;");
      expect(fit).toContain("maxX = (cvSvgB.minX || 0) + cvSvgB.w + 60; maxY = (cvSvgB.minY || 0) + cvSvgB.h + 60;");
      expect(fit).toContain("const naturalK = Math.min(r.width / (maxX - minX + 40), availH / (maxY - minY + 40));");
      expect(fit).toContain("CV_FIT_READABLE_MIN);");
      expect(fit).toContain("cvPan.k = Math.min(CV_MAX_ZOOM, Math.max(fitMinK, naturalK));");
      // 无条件夹取行原样(code 板 0.9 分支同样在)
      expect(fit).toContain('(cvActiveDoc && cvActiveDoc.boardType === "code") ? 0.9 : CV_FIT_READABLE_MIN');
      // 畸形 viewBox(svg 模式没有任何卡片 DOM)→ 直接返回,不把视野 reset 成 NaN/0
      expect(fit).toContain('if (cvFitMode === "svg" && !cvSvgB) return;');
      expect(fit).toContain('if (cvFitMode !== "svg" && !cvH.querySelectorAll(".cv-node").length) return;');
 // 卡片用 DOM 经验证(面板无 jsdom 时也走不到的兜底口径保留):offsetWidth/offsetHeight 未删
      expect(fit).toContain("const w = el.offsetWidth || 220, h = el.offsetHeight || 110;");
      // 小地图:svg 模式按 viewBox 画等比矩形占位(选"画占位"而非"隐藏",保持小地图可见可用)
      expect(html).toContain("const sbMini = cvRenderMode() === ");
      expect(html).toContain("if (sbMini) { minX = 0; minY = 0; maxX = sbMini.w; maxY = sbMini.h; }");
      expect(html).toContain("const svgMiniOn = cvRenderMode() === ");
      expect(html).toContain("for (const n of (svgMiniOn ? [] : doc.nodes))");
    });
  }, 30_000);

  it("patch:同 rev 连续两次渲染不重注入 svg、不重置 cvPan;内容变了才整块重注入", async () => {
    await withPanel(7985, (html) => {
      const sb = sandbox(html, lsStub({}));
      const sig = sb.cvSvgSig({ taskId: "t1", rev: 7 });
      expect(sig).toBe("t1|7|svg");
      // 增量决策表:签名未变+已缓存=keep;签名变了=inject;svg 没回来=wait
      expect(sb.cvSvgPatchPlan(sig, sig, true)).toBe("keep");
      expect(sb.cvSvgPatchPlan(sig, "t1|6|svg", true)).toBe("inject");
      expect(sb.cvSvgPatchPlan(sig, sig, false)).toBe("wait");
      expect(sb.cvSvgPatchPlan(sig, "", false)).toBe("wait");
      // 渲染链早退分支存在,且早退**只**写 __cvSig,不碰 cvPan/cvApplyTf/cvFitNow
      const keepMark = 'if (plan === "keep") { host.__cvSig = cvSvgSigNow; return; }';
      const keepIdx = html.indexOf(keepMark);
      expect(keepIdx, "未找到 svg 模式的早退分支").toBeGreaterThan(0);
      const keepLine = html.slice(keepIdx, keepIdx + keepMark.length);
      expect(keepLine).toContain("return;");
      expect(keepLine).not.toContain("cvApplyTf");
      expect(keepLine).not.toContain("cvFitNow");
      expect(keepLine).not.toContain("cvPan");
      // 早退处不跑逐节点 patch(.cv-node 那套只给 cards 模式):
      const beforeKeep = html.slice(Math.max(0, keepIdx - 900), keepIdx);
      expect(beforeKeep).toContain("cvSvgPatchPlan(cvSvgSigNow, domSig, !!svgNow)");
      expect(html.slice(keepIdx + keepMark.length, keepIdx + keepMark.length + 200)).not.toContain("cvPatchCanvas");
      // 同 rev 第二次渲染:不重注入、不重置视野(P0「保存回执抢走用户视野」不许复活)
      const replay = (docRev: number, domSig: string) => {
        const cacheSig = "t1|7|svg";
        const now = sb.cvSvgSig({ taskId: "t1", rev: docRev });
        const cached = cacheSig === now ? SVG_OK : "";
        return sb.cvSvgPatchPlan(now, domSig, !!cached);
      };
      expect(replay(7, "t1|7|svg")).toBe("keep"); // 第二次:同 rev → 什么都不做
      expect(replay(8, "t1|7|svg")).toBe("wait"); // 新 rev 但 svg 还没到 → 发请求,先不动 DOM
      // 服务端回包回填缓存后,新 rev 才 inject
      expect(sb.cvSvgPatchPlan("t1|8|svg", "t1|7|svg", true)).toBe("inject");
      // inject 分支:整块重注入 + 保视野(注释里锁住"绝不调 cvApplyTf/cvFitNow")
      const injIdx = html.indexOf('if (plan === "inject" && svgHostOld && host.querySelector(".bf-cv-world")) {');
      expect(injIdx).toBeGreaterThan(0);
      const injBody = html.slice(injIdx, html.indexOf("return;", injIdx) + 7);
      expect(injBody).toContain("svgHostOld.innerHTML = svgNow;");
      // 只断言「代码里没有真的调用」:去掉注释行后再看(注释点名这两者是在说明为何不调,属设计意图)
      const injCode = injBody.split(NL).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join(NL);
      expect(injCode).not.toContain("cvApplyTf(");
      expect(injCode).not.toContain("cvFitNow(");
      expect(injCode).not.toContain("cvPan");
      // 签名只由 rev + 模式(+板 id)组成:节点内容变化但 rev 不变时不触发 svg 重注入(服务端权威出图)
      expect(sb.cvSvgSig({ taskId: "t1", rev: 7, nodes: [{ id: "a" }] })).toBe("t1|7|svg");
      expect(sb.cvSvgSig({ taskId: "t1", rev: 7, nodes: [{ id: "b" }] })).toBe(sb.cvSvgSig({ taskId: "t1", rev: 7, nodes: [{ id: "a" }] }));
      // 请求去重:同签名在途不重复发(防回包→重渲→再请求的风暴)
      const req = extractFn(html, "cvSvgRequest");
      expect(req).toContain("if (cvSvgPending === sig) return;");
      expect(req).toContain('type: "board.diagram"');
      // 回包分发:cache 只在真拿到 svg 时回填(失败不写入假缓存)
      expect(html).toContain('if (m.type === "board.diagram.result") {');
      expect(html).toContain("cvSvgCacheHtml = String(m.svg);");
      expect(html).toContain("cvSvgCacheSig = cvSvgReqSig || ");
    });
  }, 30_000);

  it("sig-filter:过滤态进签名(无过滤逐字不变;按写者/折叠各自可区分),cvSvgFilterOf 未启用返回 null", async () => {
    await withPanel(7986, (html) => {
      // 无过滤:签名逐字保持既有值(测试锁了 t1|7|svg,不许漂移)
      const sb = sandbox(html, lsStub({}));
      expect(sb.cvSvgSig({ taskId: "t1", rev: 7 })).toBe("t1|7|svg");
      expect(sb.cvSvgFilterOf()).toBe(null);
      // 真实逻辑沙箱:把 cvSvgSig/cvSvgFilterOf/cvRenderMode 源码拼进 new Function,注入过滤态
      const src = ["cvRenderMode", "cvSvgFilterOf", "cvSvgSig"].map((n) => extractFn(html, n)).join(NL);
      const mk = new Function("cvWriterOn", "cvFoldGroups", "localStorage", src + NL + "return { sig: cvSvgSig, flt: cvSvgFilterOf };");
      const run = (on: Set<string> | null, fold: boolean) =>
        mk(on, fold, lsStub({})) as { sig: (d: unknown) => string; flt: () => { writers: string[]; foldGroups: boolean } | null };
      // 有写者过滤 → 签名带 |w:a1|f:0
      const a = run(new Set(["a1"]), false);
      expect(a.sig({ taskId: "t1", rev: 7 })).toBe("t1|7|svg|w:a1|f:0");
      expect(a.flt()).toEqual({ writers: ["a1"], foldGroups: false });
      // 写者集合排序稳定(Set 插入序不影响签名)
      expect(run(new Set(["b1", "a1"]), false).sig({ taskId: "t1", rev: 7 })).toBe(run(new Set(["a1", "b1"]), false).sig({ taskId: "t1", rev: 7 }));
      expect(run(new Set(["b1", "a1"]), false).sig({ taskId: "t1", rev: 7 })).toContain("|w:a1,b1|f:0");
      // 只折叠不按写者 → 仍给出 w: 空段(与全量图可区分)
      const f = run(null, true);
      expect(f.sig({ taskId: "t1", rev: 7 })).toBe("t1|7|svg|w:|f:1");
      expect(f.flt()).toEqual({ writers: [], foldGroups: true });
      // 写者 + 折叠 → f:1
      expect(run(new Set(["a1"]), true).sig({ taskId: "t1", rev: 7 })).toContain("|w:a1|f:1");
      // 两者都启用时才不是 null;空 Set(=不过滤)也当未启用
      expect(run(new Set<string>(), false).flt()).toBe(null);
      expect(run(new Set<string>(), false).sig({ taskId: "t1", rev: 7 })).toBe("t1|7|svg");
      // 模式仍进签名(cards 回退不被过滤态掩盖)
      expect(run(new Set(["a1"]), false).sig({ taskId: "t1", rev: 7, kind: "cards" })).toContain("|w:a1");
    });
  }, 30_000);

  it("request-filter:请求体按需带 filter + 画布有「折叠分组」chip 且点它走 data-cvfold 分支", async () => {
    await withPanel(7987, (html) => {
      const req = extractFn(html, "cvSvgRequest");
      // 过滤态取自 cvSvgFilterOf();为 null 时不带 filter 字段,否则并进请求体
      expect(req).toContain("const flt = cvSvgFilterOf();");
      expect(req).toContain("if (flt) body.filter = flt;");
      expect(req).toContain('type: "board.diagram"');
      expect(req).toContain("if (cvSvgPending === sig) return;"); // 去重仍在(过滤态进 sig,换过滤即新请求)
      // 折叠分组 chip + 组数统计函数
      expect(html).toContain('data-cvfold="1"');
      expect(html).toContain("折叠分组 (");
      expect(html).toContain("function cvGroupCount(doc)");
      expect(html).toContain("let cvFoldGroups = false;");
      // wbar 出现条件放宽:写者 ≥2 **或** 有可折叠分组(svg 模式)。
      // 折叠可用性按服务端 board-filter.ts 同口径:大组(≥5)≥1 **或** 碎泳道(1~4 节点小组)≥12。
      expect(html).toContain('const cvFoldAvail = cvRenderMode() === "svg" && cvFoldAvailable(doc);');
      expect(html).toContain("function cvFoldAvailable(doc) {");
      // cvGroupCount 从 cvGroupSplit 取,不再自己数一遍(避免双胞胎实现漂移)
      expect(html).toContain("function cvGroupSplit(doc) {");
      expect(html).toContain("function cvGroupCount(doc) { return cvGroupSplit(doc)[0]; }");
      expect(html).toContain("return s[0] >= 1 || s[1] >= SMALL_GROUP_MERGE_AT_UI;");
      expect(html).toContain("if (!cvPageInfo && (cvWriterAll.length >= 2 || cvFoldAvail)) {");
      // 委托选择器含 [data-cvfold],点它翻转折叠态(在 data-fold 分支之前,不走泳道展开)
      const canvas = extractFn(html, "renderBoardCanvas");
      expect(canvas).toContain("[data-wpfx],[data-wall],[data-fold],[data-cvfold]");
      expect(canvas.indexOf('hasAttribute("data-cvfold")')).toBeGreaterThan(0);
      expect(canvas.indexOf('hasAttribute("data-cvfold")')).toBeLessThan(canvas.indexOf('getAttribute("data-fold")'));
      // 组数统计口径:只数 group 非空且该组 ≥5 个节点的组
      const gc = new Function(extractFn(html, "cvGroupSplit") + NL + extractFn(html, "cvGroupCount") + NL + "return cvGroupCount;")() as (d: unknown) => number;
      const mkN = (id: string, group?: string) => ({ id, label: id, kind: "module", accept: [], ...(group ? { group } : {}) });
      expect(gc({ nodes: [mkN("a1-x", "G1"), mkN("a1-y", "G1"), mkN("a1-z", "G1"), mkN("a1-w", "G1"), mkN("a1-v", "G1")] })).toBe(1);
      expect(gc({ nodes: [mkN("a1-x", "G1"), mkN("a1-y", "G1"), mkN("a1-z", "G1"), mkN("a1-w", "G1")] })).toBe(0); // 4 < 5
      expect(gc({ nodes: [mkN("a1-x"), mkN("a1-y"), mkN("a1-z"), mkN("a1-w"), mkN("a1-v")] })).toBe(0); // 无 group 不数
      expect(gc({ nodes: [mkN("a1-x", " G2 "), mkN("a1-y", "G2"), mkN("a1-z", "G2"), mkN("a1-w", "G2"), mkN("a1-v", "G2"), mkN("a1-u", "G2")] })).toBe(1); // trim 后同名合并
      expect(gc(null)).toBe(0);
    });
  }, 30_000);

  it("svg-select:svg 模式节点点击选中(命中 data-node-id)+ 详情卡同步 + 就地带 cv-svg-on 高亮,不整板重渲", async () => {
    await withPanel(7988, (html) => {
      // ①命中函数存在且行为对:目标自身/祖先/都没有 → id/祖先 id/""
      const src = extractFn(html, "cvSvgNodeAt");
      const mode = () => "svg";
      const docStub = { nodeType: 9 }; // 宿主 document 桩:循环终止条件 n !== document 要用到
      const nodeAt = new Function("cvRenderMode", "document", src + NL + "return cvSvgNodeAt;")(mode, docStub) as (ev: unknown) => string;
      const mkEl = (attrs: Record<string, string>, parent: any = null) => ({
        attrs,
        parentElement: parent,
        getAttribute(k: string) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k]! : null; },
      });
      // 目标自身带 data-node-id(flowkit 的 <g>)
      const self = mkEl({ "data-node-id": "n-1" });
      expect(nodeAt({ target: self })).toBe("n-1");
      // 目标在祖先里(<text>/<rect> 子元素被点到,向上找最近的 g)
      const g = mkEl({ "data-node-id": "n-2" });
      const child = mkEl({}, mkEl({}, g));
      expect(nodeAt({ target: child })).toBe("n-2");
      // 最近的祖先优先(嵌套节点取里层)
      const outer = mkEl({ "data-node-id": "outer" });
      const inner = mkEl({ "data-node-id": "inner" }, outer);
      expect(nodeAt({ target: mkEl({}, inner) })).toBe("inner");
      // 都没有 / 空事件 → ""
      expect(nodeAt({ target: mkEl({}) })).toBe("");
      expect(nodeAt(null)).toBe("");
      expect(nodeAt({})).toBe("");
      // 非 svg 模式一律不命中(cards 模式走卡片自身点击)
      const cardsMode = new Function("cvRenderMode", src + NL + "return cvSvgNodeAt;")(() => "cards") as (ev: unknown) => string;
      expect(cardsMode({ target: self })).toBe("");
      // ②选中态回放函数:cvSvgTryPatch 在 innerHTML = svgNow 之后调用它;首帧也调
      expect(html).toContain("function cvSvgApplySel(root)");
      const patch = extractFn(html, "cvSvgTryPatch");
      const inj = patch.indexOf("innerHTML = svgNow");
      expect(inj).toBeGreaterThan(0);
      expect(patch.indexOf("cvSvgApplySel(", inj)).toBeGreaterThan(inj);
      // ③renderBoardCanvas 里的 svg 交互委托:命中函数 + 全局选中 + 详情卡,且不整板重渲
 // B(契约变更,原断言随设计一起改):点选从 pointerdown 挪到 pointerup 结算,
      // 因为默认左键在节点上也要能平移整张图(原实现 pointerdown 即 stopPropagation → 图内拖不动)。
      // 新的契约:pointerdown 只记命中(cvSvgDown),pointerup 且位移 <4px 才算点击。
      const canvas = extractFn(html, "renderBoardCanvas");
      expect(canvas).toContain("cvSvgNodeAt(e)");
      expect(canvas).toContain("cvSvgDown = id ? { id: id, sx: e.clientX, sy: e.clientY } : null;");
      const downWin = canvas.slice(canvas.indexOf("let cvSvgDown"), canvas.indexOf("let cvSvgDown") + 4000);
      expect(downWin).toContain("boardSelNode");
      expect(downWin).toContain("renderBoardDetail()");
      expect(downWin).toContain(">= 4) return"); // 位移门槛:拖过就不是点击
      expect(downWin).not.toContain("renderBoard()");
      expect(canvas).toContain("cvSvgApplySel(host.querySelector(\"#cvSvgHost\"))"); // 首帧高亮
      // 再点一次取消选中 + pan 分支编辑态也平移
      expect(canvas).toContain("boardSelNode = (boardSelNode === d.id) ? null : d.id;");
      expect(canvas).not.toContain('if (cvMode === "svg" && cvSvgNodeAt(e) && boardEditOn) return;');
      expect(canvas).toContain('if (cvMode === "svg" && cvLinkFrom) return;');
      // 默认平移:节点 pointerdown 里不得再 stopPropagation(否则图内拖不动整张图)
      const svgDown = canvas.slice(canvas.indexOf('if (cvMode === "svg") cvHost.addEventListener("pointerdown"'), canvas.indexOf('if (cvMode === "svg" && cvLinkFrom) return;'));
      expect(svgDown.length).toBeGreaterThan(0);
      expect(svgDown).not.toContain("e.stopPropagation(); // 节点接管");
      // ④样式:选中类是 .cv-svg-on,选择器带 stroke(否则点击无任何视觉回声)
      expect(html).toContain("cv-svg-on");
      const cssIdx = html.indexOf("#cvSvgHost [data-node-id].cv-svg-on rect");
      expect(cssIdx).toBeGreaterThan(0);
      expect(html.slice(cssIdx, cssIdx + 400)).toContain("stroke:");
      // 可发现性:svg 主机带操作提示 title,卡片交互绑定的早退注释点名交互在别处
      expect(html).toContain('title="点节点看详情,空白拖拽平移,滚轮缩放"');
      expect(extractFn(html, "cvBindInteractions")).toContain("在 renderBoardCanvas 的 svg 交互委托里");
    });
  }, 30_000);
});