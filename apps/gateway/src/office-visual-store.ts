/**
 * PPTX 视觉 QA 存储层(M100b):几何解析 + 真渲染 + 报告落盘。
 * 为什么单独一层:office-qa.ts 只看「包结构/文本」,看不到「这一页画出来是否可读」——
 * 版式崩坏(文字压到框外、标题字号过小、图片被压扁)只有拿到**每页几何 + 真渲染图**才能判。
 * 本模块只做三件客观的事,判断留给 runtime 的 inspectDeck:
 * ① parsePptxGeometry —— 用 jszip 解包,把 slide 上每个形状的绝对矩形/字号/颜色/图片像素尺寸
 * 折算成 pt 输出(EMU/12700);组内形状按 a:xfrm off/chOff/chExt 累加到父坐标系。
 * ② renderSlides —— soffice 转 PDF + gs 出 PNG,**真的渲染**;引擎缺失就如用户反馈 RENDER_ENGINE_MISSING,
 * 绝不伪造 PNG、绝不在 outDir 留占位文件(假图会让 QA 全绿,比缺图危险得多)。
 * ③ writeVisualReport —— 按源文件指纹原子落盘报告 + 追加 ledger(同指纹幂等),且只允许写 /tmp 之下
 * (防把用户工作目录写脏)。
 * 契约与 packages/harness-runtime/src/agent/office-visual-qa.ts 对齐:
 * 这里只 **类型** import(runtime 是可选依赖,几何解析/渲染/落盘不依赖它的实现);
 * runVisualCheck 内用 **动态 import** 取 inspectDeck —— 这样单测不必先编译 runtime。
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import JSZip from "jszip";
import type { PageGeometry, VisReport } from "@lampgenie/runtime/agent/office-visual-qa";

/** 报告 schema 版本(字段增删时 +1,读旧报告的人靠它判断)。 */
export const OFFICE_VISUAL_VERSION = 1;

export const VISUAL_OK = "VISUAL_OK";
export const VISUAL_INVALID = "VISUAL_INVALID";
export const VISUAL_EMPTY_DECK = "VISUAL_EMPTY_DECK";
export const VISUAL_IO_ERROR = "VISUAL_IO_ERROR";
export const RENDER_OK = "RENDER_OK";
export const RENDER_ENGINE_MISSING = "RENDER_ENGINE_MISSING";
export const RENDER_FAILED = "RENDER_FAILED";

/** 本模块所有稳定 code(调用方按 code 分支,不按文案)。 */
export const OFFICE_VISUAL_CODES: readonly string[] = [
  VISUAL_OK,
  VISUAL_INVALID,
  VISUAL_EMPTY_DECK,
  VISUAL_IO_ERROR,
  RENDER_OK,
  RENDER_ENGINE_MISSING,
  RENDER_FAILED,
];

/** EMU → pt(1pt = 12700EMU)。 */
const EMU_PER_PT = 12700;
/** 缺 p:sldSz 时的兜底:16:9 标准宽屏 12192000×6858000EMU(= 960×540pt)。 */
const DEFAULT_SLIDE_CX = 12192000;
const DEFAULT_SLIDE_CY = 6858000;
/** 组嵌套上限(防环/防爆栈,与 office-ooxml 的 PPTX_GROUP_MAX_DEPTH 同口径)。 */
const GROUP_MAX_DEPTH = 8;
/** 渲染缺省参数。 */
const DEFAULT_DPI = 110;
const DEFAULT_RENDER_TIMEOUT_MS = 120_000;

/** 报告里的形状条目(结构 = PageGeometry["shapes"][number],不另立类型,避免与 runtime 漂移)。 */
type PShape = PageGeometry["shapes"][number];

// ───────────────────────── 轻量 XML 树(自带实现,零 XML 依赖) ─────────────────────────
/**
 * 为什么这里自带一份解析树,而不是 import office-ooxml.ts 的 parseXmlTree:
 * 兄弟模块只能用 "./office-ooxml.js" 这种后缀引(tsconfig 是 Bundler resolution + 有 emit,
 * 不允许写 .ts 后缀),而 `node --experimental-strip-types scripts/office-visual.mts` 不做
 * .js→.ts 改写(直接 ERR_MODULE_NOT_FOUND),CLI 就跑不起来。本文件又必须同时被
 * gateway 的 tsc 与 CLI 加载,所以自带同口径精简实现(完整版与坑位说明见
 * office-ooxml.ts 的 parseXmlCore,这里只保留本模块要用的 name/attrs/kids)。
 */
interface XNode {
  name: string;
  attrs: Record<string, string>;
  kids: (XNode | string)[];
}

/** 实体解码(与 office-ooxml 同表:命名实体 + 十进制/十六进制字符引用)。 */
function decodeXmlEntities(s: string): string {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(lt|gt|amp|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/g, (m, g: string) => {
    switch (g) {
      case "lt": return "<";
      case "gt": return ">";
      case "amp": return "&";
      case "quot": return "\"";
      case "apos": return "'";
      default: {
        const code = g.charAt(1) === "x" || g.charAt(1) === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
        if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
          try { return String.fromCodePoint(code); } catch { return m; }
        }
        return m;
      }
    }
  });
}

/** 找开标签的 ">"(跳过属性值里的引号内容:OOXML 属性值里偶见 ">"）。 */
function xmlTagEnd(src: string, from: number): number {
  let quote = "";
  for (let i = from; i < src.length; i++) {
    const c = src.charAt(i);
    if (quote) { if (c === quote) quote = ""; continue; }
    if (c === "\"" || c === "'") { quote = c; continue; }
    if (c === ">") return i;
  }
  return -1;
}

/** 开标签里的属性表(name="v" / name='v',实体已解码)。 */
function xmlAttrsOf(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const name = m[1];
    if (!name) continue;
    out[name] = decodeXmlEntities(m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : ""));
  }
  return out;
}

/**
 * XML → 轻量树(根是 #root 包装节点,其第一个元素子节点才是真根元素)。
 * 容忍:声明/注释/CDATA/DOCTYPE/自闭合标签/属性引号;标签不配对时按就近栈回落,
 * 结尾未闭合的标签直接按已读出内容收尾——预览/质检宁可少一截,也不能整页抛错。
 */
function parseXmlTree(src: string): XNode {
  const root: XNode = { name: "#root", attrs: {}, kids: [] };
  const stack: XNode[] = [root];
  const n = src.length;
  const top = (): XNode => stack[stack.length - 1] ?? root;
  const pushText = (t: string): void => {
    if (!t) return;
    top().kids.push(decodeXmlEntities(t));
  };
  let i = 0;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) { pushText(src.slice(i)); break; }
    if (lt > i) pushText(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) { const e = src.indexOf("-->", lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith("<![CDATA[", lt)) {
      const e = src.indexOf("]]>", lt + 9);
      top().kids.push(src.slice(lt + 9, e < 0 ? n : e));
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (src.startsWith("<?", lt)) { const e = src.indexOf("?>", lt + 2); i = e < 0 ? n : e + 2; continue; }
    if (src.startsWith("<!", lt)) { const e = xmlTagEnd(src, lt + 2); i = e < 0 ? n : e + 1; continue; }
    const gt = xmlTagEnd(src, lt + 1);
    if (gt < 0) { pushText(src.slice(lt)); break; }
    const raw = src.slice(lt + 1, gt);
    if (raw.charAt(0) === "/") {
 // 闭标签:只在栈里还能找到同名节点时才弹(容忍交叉/多余闭标签)
      const nm = raw.slice(1).trim();
      for (let k = stack.length - 1; k >= 1; k--) {
        if (stack[k]?.name === nm) { stack.length = k; break; }
      }
    } else {
      const selfClose = raw.endsWith("/");
      const body = selfClose ? raw.slice(0, -1) : raw;
      const sp = body.search(/[\s/]/);
      const node: XNode = {
        name: sp < 0 ? body : body.slice(0, sp),
        attrs: sp < 0 ? {} : xmlAttrsOf(body.slice(sp)),
        kids: [],
      };
      top().kids.push(node);
      if (!selfClose) stack.push(node);
    }
    i = gt + 1;
  }
  return root;
}

// ───────────────────────── 轻量图片头解析 ─────────────────────────
/**
 * 从文件头取像素宽高(PNG/JPEG/GIF/WebP);认不出 → null(调用方省略 imagePx,绝不造假期数字)。
 * 同样是自带实现而非 import image-size.ts,理由见上面 parseXmlTree 的注释(同一处 .js 后缀约束)。
 * 口径与 image-size.ts 的 readImageSize 一致:只读头字节,不整图解码。
 */
function readImageSize(buf: Uint8Array): { width: number; height: number } | null {
  const len = buf.length;
 // PNG:8 字节签名 + 4 长度 + "IHDR" + 宽高(大端) → 宽在 16、高在 20
  if (len >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const w = dv.getUint32(16);
    const h = dv.getUint32(20);
    return w > 0 && h > 0 ? { width: w, height: h } : null;
  }
 // GIF:"GIF8x" + 逻辑屏宽高(小端 2 字节)
  if (len >= 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    const w = (buf[6] ?? 0) | ((buf[7] ?? 0) << 8);
    const h = (buf[8] ?? 0) | ((buf[9] ?? 0) << 8);
    return w > 0 && h > 0 ? { width: w, height: h } : null;
  }
 // JPEG:扫段找 SOF(0xC0-0xCF 去掉 C4=DHT/C8=JPG/CC=DAC),高宽在段内 offset+5/+7
  if (len >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let p = 2;
    while (p + 9 < len) {
      if (buf[p] !== 0xff) { p++; continue; }
      const marker = buf[p + 1] ?? 0;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
      const segLen = ((buf[p + 2] ?? 0) << 8) | (buf[p + 3] ?? 0);
      if (segLen < 2) return null;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        const h = ((buf[p + 5] ?? 0) << 8) | (buf[p + 6] ?? 0);
        const w = ((buf[p + 7] ?? 0) << 8) | (buf[p + 8] ?? 0);
        return w > 0 && h > 0 ? { width: w, height: h } : null;
      }
      p += 2 + segLen;
    }
    return null;
  }
 // WebP:"RIFF....WEBP" + VP8/VP8L/VP8X 三种块头
  if (len >= 30 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
    const tag = String.fromCharCode(buf[12] ?? 0, buf[13] ?? 0, buf[14] ?? 0, buf[15] ?? 0);
    if (tag === "VP8 ") {
      const w = ((buf[26] ?? 0) | ((buf[27] ?? 0) << 8)) & 0x3fff;
      const h = ((buf[28] ?? 0) | ((buf[29] ?? 0) << 8)) & 0x3fff;
      return w > 0 && h > 0 ? { width: w, height: h } : null;
    }
    if (tag === "VP8L") {
      const b0 = buf[21] ?? 0, b1 = buf[22] ?? 0, b2 = buf[23] ?? 0, b3 = buf[24] ?? 0;
      const w = ((b1 & 0x3f) << 8 | b0) + 1;
      const h = ((b3 & 0x0f) << 10 | b2 << 2 | (b1 & 0xc0) >> 6) + 1;
      return w > 0 && h > 0 ? { width: w, height: h } : null;
    }
    if (tag === "VP8X") {
      const w = ((buf[24] ?? 0) << 16 | (buf[25] ?? 0) << 8 | (buf[26] ?? 0)) + 1;
      const h = ((buf[27] ?? 0) << 16 | (buf[28] ?? 0) << 8 | (buf[29] ?? 0)) + 1;
      return w > 0 && h > 0 ? { width: w, height: h } : null;
    }
  }
  return null;
}

/** 去命名空间前缀(r:embed → embed)。 */
function localName(nm: string): string {
  const i = nm.indexOf(":");
  return i < 0 ? nm : nm.slice(i + 1);
}
function xkids(n: XNode): XNode[] {
  return n.kids.filter((k): k is XNode => typeof k !== "string");
}
/** 直接子节点里按本地名找第一个。 */
function xchild(n: XNode | undefined, name: string): XNode | undefined {
  if (!n) return undefined;
  for (const k of xkids(n)) if (localName(k.name) === name) return k;
  return undefined;
}
function xchildren(n: XNode | undefined, name: string): XNode[] {
  if (!n) return [];
  return xkids(n).filter((k) => localName(k.name) === name);
}
/** 深度优先找第一个后代。 */
function xfind(n: XNode | undefined, name: string): XNode | undefined {
  if (!n) return undefined;
  for (const k of xkids(n)) {
    if (localName(k.name) === name) return k;
    const d = xfind(k, name);
    if (d) return d;
  }
  return undefined;
}
/** 深度优先收集全部后代(文档顺序)。 */
function xfindAll(n: XNode | undefined, name: string, acc: XNode[] = []): XNode[] {
  if (!n) return acc;
  for (const k of xkids(n)) {
    if (localName(k.name) === name) acc.push(k);
    xfindAll(k, name, acc);
  }
  return acc;
}
/**
 * parseXmlTree 返回的是文档包装节点(#root),它的第一个元素子节点才是真根元素
 * (p:sld / p:presentation)。取根上的直接子节点必须先脱这层包装,否则 cSld/spTree 全落空。
 */
function docRoot(n: XNode): XNode {
  if (n.name !== "#root") return n;
  return xkids(n)[0] ?? n;
}

/** 属性取值:先精确名,再按本地名兜底(r:embed → "embed")。 */
function xattr(n: XNode | undefined, name: string): string | undefined {
  if (!n) return undefined;
  const exact = n.attrs[name];
  if (exact !== undefined) return exact;
  for (const k of Object.keys(n.attrs)) if (localName(k) === name) return n.attrs[k];
  return undefined;
}
function xnum(v: string | undefined, d = 0): number {
  if (v === undefined || v === null || v === "") return d;
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}
/** 节点文本(含后代),不 trim(xml:space="preserve" 下空格有意义)。 */
function xtext(n: XNode | undefined): string {
  if (!n) return "";
  let s = "";
  for (const k of n.kids) s += typeof k === "string" ? k : xtext(k);
  return s;
}
/** srgbClr@val → "#rrggbb"(大写输入规范成小写;非法值返回 undefined,绝不造色)。 */
function srgbHex(n: XNode | undefined): string | undefined {
  const v = String(xattr(n, "val") || "").trim();
  return /^[0-9a-fA-F]{6}$/.test(v) ? "#" + v.toLowerCase() : undefined;
}
/** solidFill/a:srgbClr 的颜色(容器可以是 spPr 或 rPr)。 */
function solidFillHex(n: XNode | undefined): string | undefined {
  return srgbHex(xchild(xchild(n, "solidFill"), "srgbClr"));
}
/** 两位小数的 pt 值(几何判断不需要更高精度,也便于断言)。 */
function pt(emu: number): number {
  const v = (Number.isFinite(emu) ? emu : 0) / EMU_PER_PT;
  return Math.round(v * 100) / 100;
}

// ───────────────────────── 坐标变换(组) ─────────────────────────
/** 子坐标系 → 父坐标系:x' = a + x*sx、y' = b + y*sy(与 office-ooxml 的 groupXf 同口径)。 */
interface Xf {
  a: number;
  b: number;
  sx: number;
  sy: number;
}

/** 形状自己的 a:xfrm(spPr / grpSpPr 优先,兜底深搜第一个 xfrm)。 */
function xfrmOf(node: XNode): XNode | undefined {
  const pr = xchild(node, "spPr") ?? xchild(node, "grpSpPr");
  return xchild(pr, "xfrm") ?? xfind(node, "xfrm");
}

/**
 * grpSp 的变换:子形状坐标在 chOff/chExt 定义的子坐标系里,要映射进 off/ext 定义的父坐标系。
 * 缩放口径 sx = ext.cx / chExt.cx(chExt 缺失/为 0 → sx 退化为 1,绝不出 NaN/Infinity),
 * 平移口径 a = off.x - chOff.x * sx(把子坐标系原点搬到父坐标系)。
 */
function groupXf(node: XNode, outer?: Xf): Xf {
  const xfrm = xfrmOf(node);
  const off = xchild(xfrm, "off");
  const ext = xchild(xfrm, "ext");
  const chOff = xchild(xfrm, "chOff");
  const chExt = xchild(xfrm, "chExt");
  const offX = xnum(xattr(off, "x"));
  const offY = xnum(xattr(off, "y"));
  const extCx = xnum(xattr(ext, "cx"));
  const extCy = xnum(xattr(ext, "cy"));
  const chX = xnum(xattr(chOff, "x"));
  const chY = xnum(xattr(chOff, "y"));
  const chCx = xnum(xattr(chExt, "cx"));
  const chCy = xnum(xattr(chExt, "cy"));
  let sx = chCx > 0 && extCx > 0 ? extCx / chCx : 1;
  let sy = chCy > 0 && extCy > 0 ? extCy / chCy : 1;
  if (!Number.isFinite(sx) || sx <= 0) sx = 1;
  if (!Number.isFinite(sy) || sy <= 0) sy = 1;
  const self: Xf = { a: offX - chX * sx, b: offY - chY * sy, sx, sy };
  if (!outer) return self;
  return {
    a: outer.a + outer.sx * self.a,
    b: outer.b + outer.sy * self.b,
    sx: outer.sx * self.sx,
    sy: outer.sy * self.sy,
  };
}

/** 形状局部矩形(EMU)+ 外层变换 → 绝对矩形(pt)。 */
function absRect(xfrm: XNode | undefined, xf: Xf | undefined): { x: number; y: number; w: number; h: number } {
  const off = xchild(xfrm, "off");
  const ext = xchild(xfrm, "ext");
  const x0 = xnum(xattr(off, "x"));
  const y0 = xnum(xattr(off, "y"));
  const cx = xnum(xattr(ext, "cx"));
  const cy = xnum(xattr(ext, "cy"));
  if (!xf) return { x: pt(x0), y: pt(y0), w: pt(cx), h: pt(cy) };
  return {
    x: pt(xf.a + x0 * xf.sx),
    y: pt(xf.b + y0 * xf.sy),
    w: pt(cx * xf.sx),
    h: pt(cy * xf.sy),
  };
}

// ───────────────────────── PPTX 几何解析 ─────────────────────────
/** zip 内相对路径解析("../media/image1.png" 相对 "ppt/slides" → "ppt/media/image1.png")。 */
function resolvePart(baseDir: string, target: string): string {
  const t = String(target || "").replace(/\\/g, "/");
  if (t.startsWith("/")) return t.slice(1);
  const segs = (baseDir ? baseDir.split("/") : []).concat(t.split("/"));
  const out: string[] = [];
  for (const s of segs) {
    if (!s || s === ".") continue;
    if (s === "..") {
      out.pop();
      continue;
    }
    out.push(s);
  }
  return out.join("/");
}

/** rels XML → { rId: 目标部件路径(已按 baseDir 归一) };外链(TargetMode=external)丢弃。 */
function relMap(xml: string | undefined, baseDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!xml) return out;
  let root: XNode;
  try {
    root = parseXmlTree(xml);
  } catch {
    return out;
  }
  for (const rel of xfindAll(root, "Relationship")) {
    const id = xattr(rel, "Id");
    const target = xattr(rel, "Target");
    const mode = String(xattr(rel, "TargetMode") || "").toLowerCase();
    if (!id || !target || mode === "external") continue;
    out[id] = resolvePart(baseDir, target);
  }
  return out;
}

/** 单页解析上下文(rels + zip 句柄 + 图片像素缓存 + 告警收集)。 */
interface SlideCtx {
  zip: JSZip;
  rels: Record<string, string>;
  mediaPx: Map<string, { w: number; h: number } | null>;
  warnings: string[];
}

/** 文本类属性:字号取首个带 sz 的 rPr(百分之一 pt),加粗 b="1",颜色取首个 srgbClr。 */
function textProps(txBody: XNode | undefined): { fontSizePt?: number; bold?: boolean; color?: string } {
  const out: { fontSizePt?: number; bold?: boolean; color?: string } = {};
  const rPrs = xfindAll(txBody, "rPr");
  const pickSz = (list: XNode[]): number => {
    for (const r of list) {
      const sz = xnum(xattr(r, "sz"), 0);
      if (sz > 0) return sz;
    }
    return 0;
  };
  let sz = pickSz(rPrs);
  if (sz <= 0) sz = pickSz(xfindAll(txBody, "endParaRPr")); // 空段落/占位符只有 endParaRPr 带字号
  if (sz > 0) out.fontSizePt = Math.round((sz / 100) * 100) / 100; // sz="800" → 8pt
  for (const r of rPrs) {
    const b = String(xattr(r, "b") || "").toLowerCase();
    if (b === "1" || b === "true") {
      out.bold = true;
      break;
    }
  }
  for (const r of rPrs) {
    const c = solidFillHex(r);
    if (c) {
      out.color = c;
      break;
    }
  }
  return out;
}

/** 占位符类型(a:ph@type)是否标题;ctrTitle/title 都算标题。 */
function isTitleShape(node: XNode): boolean {
  const nv = xchild(node, "nvSpPr") ?? xchild(node, "nvPicPr");
  const ph = xchild(xchild(nv, "nvPr"), "ph");
  const t = String(xattr(ph, "type") || "").toLowerCase();
  return t === "title" || t === "ctrTitle".toLowerCase();
}

/** altText:p:nvPicPr/p:cNvPr@descr(兼容 p:nvSpPr/p:cNvPr@descr);空白视为缺。 */
function altTextOf(node: XNode): string | undefined {
  const nv = xchild(node, "nvPicPr") ?? xchild(node, "nvSpPr");
  const d = String(xattr(xchild(nv, "cNvPr"), "descr") || "").trim();
  return d || undefined;
}


/**
 * 图片像素尺寸是异步读的,所以形状先建、图片尺寸统一后置补(imagePx 可选,补不上就不写 —— 不造假期数字)。
 * 这里把「待补」的形状和对应的 promise 记下来,时 await。
 */
interface PendingPic {
  shape: PShape;
  px: Promise<{ w: number; h: number } | undefined>;
}
function picSizeAsync(node: XNode, ctx: SlideCtx): Promise<{ w: number; h: number } | undefined> {
  const blip = xfind(xchild(node, "blipFill"), "blip");
  const embed = String(xattr(blip, "embed") || "").trim();
  if (!embed) return Promise.resolve(undefined);
  const part = ctx.rels[embed];
  if (!part) {
    ctx.warnings.push(`图片 rel ${embed} 在 slide rels 中缺失`);
    return Promise.resolve(undefined);
  }
  const cached = ctx.mediaPx.get(part);
  if (cached !== undefined) return Promise.resolve(cached ?? undefined);
  const file = ctx.zip.file(part);
  if (!file) {
    ctx.warnings.push(`图片部件 ${part} 不在 zip 内`);
    ctx.mediaPx.set(part, null);
    return Promise.resolve(undefined);
  }
  return file.async("uint8array").then(
    (buf) => {
      let size: { w: number; h: number } | null = null;
      try {
        const got = readImageSize(buf);
        if (got && got.width > 0 && got.height > 0) size = { w: got.width, h: got.height };
      } catch {
        size = null;
      }
      if (!size) ctx.warnings.push(`图片 ${part} 像素尺寸解析不出(省略 imagePx)`);
      ctx.mediaPx.set(part, size);
      return size ?? undefined;
    },
    () => {
      ctx.mediaPx.set(part, null);
      return undefined;
    },
  );
}

/** 遍历 spTree:递归展开 grpSp(sp/pic/grpSp;cxnSp、graphicFrame 按矩形纳入几何,不取文本)。 */
function collectShapes(container: XNode, ctx: SlideCtx, out: PShape[], pending: PendingPic[], xf?: Xf, depth = 0): void {
  for (const k of xkids(container)) {
    const tag = localName(k.name);
    if (tag === "grpSp") {
 // 组:先算出本组的变换,再递归(深度上限防环)
      if (depth >= GROUP_MAX_DEPTH) {
        ctx.warnings.push("组嵌套超过上限,更深层的子形状被忽略");
        continue;
      }
      collectShapes(k, ctx, out, pending, groupXf(k, xf), depth + 1);
      continue;
    }
    if (tag !== "sp" && tag !== "pic" && tag !== "cxnSp" && tag !== "graphicFrame") continue;
    const xfrm = xfrmOf(k);
    const sh: PShape = { kind: "shape", rect: absRect(xfrm, xf) };
    if (tag === "sp" || tag === "pic") {
      const txBody = xchild(k, "txBody");
      const text = xfindAll(txBody, "t")
        .map((t) => xtext(t))
        .join("");
      if (text.trim()) {
        sh.text = text;
        sh.kind = "text";
        Object.assign(sh, textProps(txBody));
      }
      const spPr = xchild(k, "spPr");
      const fill = solidFillHex(spPr);
      if (fill) sh.fill = fill;
      const alt = altTextOf(k);
      if (alt) sh.altText = alt;
      if (isTitleShape(k)) sh.isTitle = true;
      if (tag === "pic") {
        if (sh.kind !== "text") sh.kind = "image";
        pending.push({ shape: sh, px: picSizeAsync(k, ctx) });
      }
    }
    out.push(sh);
  }
}

/** zip 里所有 ppt/media/* 的名称数(媒体计数,不看内容)。 */
function countMedia(zip: JSZip): number {
  return Object.keys(zip.files).filter((p) => /^ppt\/media\//i.test(p) && !zip.files[p]?.dir).length;
}

/**
 * 解析 PPTX → 每页 pt 几何。
 * 任何缺字段都退默认值(0/省略),**不抛错**;zip 解不开/非 OOXML → VISUAL_INVALID;0 页 → VISUAL_EMPTY_DECK。
 */
export async function parsePptxGeometry(buf: Uint8Array): Promise<{
  ok: boolean;
  code: string;
  pages: PageGeometry[];
  slideCount: number;
  mediaCount: number;
  warnings: string[];
}> {
  const warnings: string[] = [];
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    return { ok: false, code: VISUAL_INVALID, pages: [], slideCount: 0, mediaCount: 0, warnings: ["zip 解不开(非 OOXML 包)"] };
  }
  const presFile = zip.file("ppt/presentation.xml");
  if (!presFile) {
    return {
      ok: false,
      code: VISUAL_INVALID,
      pages: [],
      slideCount: 0,
      mediaCount: countMedia(zip),
      warnings: ["缺少 ppt/presentation.xml"],
    };
  }
  const presXml = await presFile.async("string");
  let pres: XNode;
  try {
    pres = parseXmlTree(presXml);
  } catch {
    return { ok: false, code: VISUAL_INVALID, pages: [], slideCount: 0, mediaCount: countMedia(zip), warnings: ["presentation.xml 解析失败"] };
  }

 // 页面尺寸:sldSz@cx/@cy(EMU);缺失退 16:9 默认(960×540pt)
  const sldSz = xfind(pres, "sldSz");
  let cxEmu = xnum(xattr(sldSz, "cx"), 0);
  let cyEmu = xnum(xattr(sldSz, "cy"), 0);
  if (!(cxEmu > 0) || !(cyEmu > 0)) {
    warnings.push("缺 p:sldSz,按 16:9 默认 960×540pt 处理");
    cxEmu = DEFAULT_SLIDE_CX;
    cyEmu = DEFAULT_SLIDE_CY;
  }
  const widthPt = pt(cxEmu);
  const heightPt = pt(cyEmu);

 // slide 顺序:presentation.xml.rels 的 r:id 顺序(缺 rels 退回 slideN 数字序)
  const presRelsFile = zip.file("ppt/_rels/presentation.xml.rels");
  const presRels = relMap(presRelsFile ? await presRelsFile.async("string") : undefined, "ppt");
  const orderedParts: string[] = [];
  for (const sldId of xfindAll(pres, "sldId")) {
    const rid = xattr(sldId, "id") && xattr(sldId, "r:id") !== undefined ? xattr(sldId, "r:id") : xattr(sldId, "r:id");
    const target = rid ? presRels[rid] : undefined;
    if (!target) {
      if (rid) warnings.push(`sldId ${rid} 在 presentation.xml.rels 中找不到目标`);
      continue;
    }
    orderedParts.push(target);
  }
  if (orderedParts.length === 0) {
    warnings.push("presentation.xml 无可用 sldId 映射,退回 ppt/slides/slideN.xml 数字序");
    orderedParts.push(
      ...Object.keys(zip.files)
        .filter((p) => /^ppt\/slides\/slide\d+\.xml$/i.test(p) && !zip.files[p]?.dir)
        .sort((a, b) => xnum(/(\d+)\.xml$/i.exec(a)?.[1], 0) - xnum(/(\d+)\.xml$/i.exec(b)?.[1], 0)),
    );
  }
  if (orderedParts.length === 0) {
    return { ok: false, code: VISUAL_EMPTY_DECK, pages: [], slideCount: 0, mediaCount: countMedia(zip), warnings };
  }

  const pages: PageGeometry[] = [];
 // 母版底色:slide 自己没写 bg 时继承母版(否则深色母版下的浅色字会被当成「白底浅字」误判低对比)
  let masterBgHex: string | undefined;
  const masterPart = "ppt/slideMasters/slideMaster1.xml";
  const masterFile = zip.file(masterPart);
  if (masterFile) {
    try {
      const masterRoot = parseXmlTree(await masterFile.async("string"));
      masterBgHex = solidFillHex(xchild(xchild(xchild(docRoot(masterRoot), "cSld"), "bg"), "bgPr"));
    } catch {
      warnings.push("母版页解析失败(页面底色只用 slide 自己的 bg)");
    }
  }
  for (let i = 0; i < orderedParts.length; i++) {
    const part = orderedParts[i]!;
    const f = zip.file(part);
    if (!f) {
      warnings.push(`slide 部件 ${part} 不在 zip 内(跳过)`);
      continue;
    }
    let xml: string;
    try {
      xml = await f.async("string");
    } catch {
      warnings.push(`slide 部件 ${part} 读不出(跳过)`);
      continue;
    }
    let root: XNode;
    try {
      root = parseXmlTree(xml);
    } catch {
      warnings.push(`slide 部件 ${part} XML 解析失败(按空页处理)`);
      continue;
    }
 // slide 自己的 rels(图片 r:embed 靠它找 media);文件名规则 ppt/slides/_rels/slideN.xml.rels
    const relsPart = part.replace(/^(.*\/)([^/]+)$/, "$1_rels/$2.rels");
    const relsFile = zip.file(relsPart);
    const rels = relMap(relsFile ? await relsFile.async("string") : undefined, part.replace(/\/[^/]+$/, ""));
    const ctx: SlideCtx = { zip, rels, mediaPx: new Map(), warnings };
    const spTree = xchild(xchild(docRoot(root), "cSld"), "spTree") ?? xfind(root, "spTree");
    const shapes: PShape[] = [];
    const pending: PendingPic[] = [];
    if (spTree) collectShapes(spTree, ctx, shapes, pending);
 // 图片像素尺寸后置补齐(异步读 zip;拿不到就不写 imagePx)
    for (const p of pending) {
      const px = await p.px;
      if (px && px.w > 0 && px.h > 0) p.shape.imagePx = { w: px.w, h: px.h };
    }
 // 页面底色:slide 的 p:bg/p:bgPr/solidFill,缺则继承母版;bpRef(主题引用)不解析,宁缺不造色
    const slideBgHex =
      solidFillHex(xchild(xchild(xchild(docRoot(root), "cSld"), "bg"), "bgPr")) ?? masterBgHex;
    pages.push({
      index: i + 1,
      width: widthPt,
      height: heightPt,
      shapes,
      ...(slideBgHex ? { background: slideBgHex } : {}),
    });
  }
  if (pages.length === 0) {
    return { ok: false, code: VISUAL_EMPTY_DECK, pages: [], slideCount: orderedParts.length, mediaCount: countMedia(zip), warnings };
  }
  return { ok: true, code: VISUAL_OK, pages, slideCount: pages.length, mediaCount: countMedia(zip), warnings };
}

// ───────────────────────── 真渲染(soffice + gs) ─────────────────────────
interface RunResult {
  missing: boolean;
  timedOut: boolean;
  code: number | null;
  stderr: string;
}

/** spawn 单个二进制(不经 shell → 参数不会被解释,防注入);ENOENT/超时都收敛成结构化结果。 */
function runBin(cmd: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise<RunResult>((done) => {
    let settled = false;
    let stderr = "";
    const finish = (r: RunResult): void => {
      if (settled) return;
      settled = true;
      done(r);
    };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch {
      finish({ missing: true, timedOut: false, code: null, stderr: "" });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child?.kill("SIGKILL");
      } catch {
 /* 进程可能已退出 */
      }
      finish({ missing: false, timedOut: true, code: null, stderr });
    }, Math.max(1000, timeoutMs));
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < 8000) stderr += d.toString("utf8"); // 只留尾部一小段,防日志膨胀
    });
    child.on("error", (e: Error) => {
      clearTimeout(timer);
      finish({ missing: (e as { code?: string }).code === "ENOENT", timedOut: false, code: null, stderr: stderr + String(e.message || "") });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ missing: false, timedOut: false, code, stderr });
    });
  });
}

/** 目录里所有 slide-*.png(真实存在且 >0 字节),按文件名排序 → 绝对路径。 */
async function collectPngs(outDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(outDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const nm of names.sort()) {
    if (!/^slide-\d+\.png$/i.test(nm)) continue;
    const p = resolve(outDir, nm);
    try {
      const st = await stat(p);
      if (st.isFile() && st.size > 0) out.push(p);
    } catch {
 /* 读不到就当没产出 */
    }
  }
  return out;
}

/**
 * 真渲染:soffice → PDF → gs → PNG。
 * 引擎缺失一律 RENDER_ENGINE_MISSING 且 pngPaths 为空(**绝不伪造图**);
 * 非零退出/无产出 → RENDER_FAILED,pngPaths 只含真实存在且 >0 字节的文件。
 */
export async function renderSlides(
  pptxPath: string,
  outDir: string,
  opts?: { dpi?: number; timeoutMs?: number; binaries?: { soffice?: string; gs?: string } },
): Promise<{
  ok: boolean;
  code: string;
  engine: "soffice+gs" | "none";
  pngPaths: string[];
  pages: number;
  durationMs: number;
  detail?: string;
}> {
  const started = Date.now();
  const dpi = Math.max(48, Math.round(opts?.dpi ?? DEFAULT_DPI));
  const timeoutMs = Math.max(1000, Math.round(opts?.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS));
  const soffice = opts?.binaries?.soffice || "soffice";
  const gs = opts?.binaries?.gs || "gs";
  const fail = (code: string, detail: string, engine: "soffice+gs" | "none" = "none") => ({
    ok: false,
    code,
    engine,
    pngPaths: [] as string[],
    pages: 0,
    durationMs: Date.now() - started,
    detail,
  });

  let tmp: string | null = null;
  try {
    await mkdir(outDir, { recursive: true });
    tmp = await mkdtemp(join(tmpdir(), "office-visual-"));
    const r1 = await runBin(soffice, ["--headless", "--convert-to", "pdf", "--outdir", tmp, resolve(pptxPath)], timeoutMs);
    if (r1.missing) return fail(RENDER_ENGINE_MISSING, `找不到 ${soffice}(soffice 未安装?)`);
    if (r1.timedOut) return fail(RENDER_FAILED, `soffice 超时(${timeoutMs}ms)`);
    if (r1.code !== 0) return fail(RENDER_FAILED, `soffice 退出码 ${r1.code}: ${r1.stderr.slice(-400)}`);
 // soffice 按源文件名出 PDF;拿不到就扫临时目录里唯一/第一个 pdf
    const wantPdf = join(tmp, basename(pptxPath, extname(pptxPath)) + ".pdf");
    let pdf = wantPdf;
    try {
      await stat(pdf);
    } catch {
      const found = (await readdir(tmp)).filter((n) => /\.pdf$/i.test(n)).sort();
      if (found.length === 0) return fail(RENDER_FAILED, "soffice 未产出 PDF", "soffice+gs");
      pdf = join(tmp, found[0]!);
    }
    const r2 = await runBin(
      gs,
      ["-sDEVICE=png16m", `-r${dpi}`, "-dNOPAUSE", "-dBATCH", `-sOutputFile=${join(outDir, "slide-%03d.png")}`, pdf],
      timeoutMs);
    if (r2.missing) return fail(RENDER_ENGINE_MISSING, `找不到 ${gs}(ghostscript 未安装?)`);
    if (r2.timedOut) return fail(RENDER_FAILED, `gs 超时(${timeoutMs}ms)`, "soffice+gs");
    if (r2.code !== 0) return fail(RENDER_FAILED, `gs 退出码 ${r2.code}: ${r2.stderr.slice(-400)}`, "soffice+gs");
    const pngPaths = await collectPngs(outDir);
    if (pngPaths.length === 0) return fail(RENDER_FAILED, "gs 未产出 PNG", "soffice+gs");
    return { ok: true, code: RENDER_OK, engine: "soffice+gs", pngPaths, pages: pngPaths.length, durationMs: Date.now() - started };
  } catch (e) {
    return fail(RENDER_FAILED, e instanceof Error ? e.message : String(e));
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// ───────────────────────── 落盘(原子写 + 幂等) ─────────────────────────
/**
 * 报告根只允许 /tmp 之下(规范化去尾斜杠后前缀判断)。
 * 理由:QA 报告是中间产物,写进用户仓/家目录只会留垃圾;拒绝写时**一个文件都不碰**。
 */
export function visualRootAllowed(root: string): boolean {
  const raw = String(root || "").trim();
  if (!raw) return false;
  const norm = resolve(raw).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return norm === "/tmp" || norm.startsWith("/tmp/");
}

/** 源文件指纹:字节 sha256 前 12 位(内容变了指纹就变,报告自然分离)。 */
function fingerprintOf(buf: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(buf)).digest("hex").slice(0, 12);
}

/**
 * 迟到的 runtime 依赖:包解析(仓库内已 link 时)优先,失败退回仓库相对路径。
 * 为什么要兜底:scripts/ 直接 `tsx` 跑时根 node_modules 里不一定有 @lampgenie/runtime 的
 * workspace 链接,拿不到判定函数就等于 CLI 不可用 —— 但**绝不自己实现一份判定**(会与
 * runtime 口型分叉),宁可显式失败。返回值一律由调用方判空,不打补丁式降级。
 */
async function runtimeModule(): Promise<typeof import("@lampgenie/runtime/agent/office-visual-qa")> {
  try {
    return await import("@lampgenie/runtime/agent/office-visual-qa");
  } catch {
    const fallback = "../../../packages/harness-runtime/src/agent/office-visual-qa.ts";
    return (await import(/* @vite-ignore */ fallback)) as typeof import("@lampgenie/runtime/agent/office-visual-qa");
  }
}

/** 报告目录(<root>/.genie/office/visual)。 */
function visualDir(root: string): string {
  return join(resolve(root), ".genie", "office", "visual");
}

/** 已有 ledger 里是否已录过该指纹(幂等判据)。 */
async function ledgerHas(ledgerPath: string, fingerprint: string): Promise<boolean> {
  try {
    const txt = await readFile(ledgerPath, "utf8");
    for (const line of txt.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        const row = JSON.parse(s) as { fingerprint?: string };
        if (row && row.fingerprint === fingerprint) return true;
      } catch {
 /* 坏行跳过,不让脏行阻塞追加 */
      }
    }
  } catch {
 /* 文件不存在 = 没录过 */
  }
  return false;
}

/**
 * 报告 + ledger 落盘。
 * root 不在 /tmp 之下 → VISUAL_INVALID 且不写任何文件;源文件读不出 → VISUAL_IO_ERROR。
 */
export async function writeVisualReport(
  root: string,
  input: { pptxPath: string; report: VisReport; render?: { pngPaths: string[]; engine: string } | null },
): Promise<{ ok: boolean; code: string; reportPath?: string; ledgerPath?: string; fingerprint: string }> {
  const pptxPath = resolve(input.pptxPath);
  let buf: Uint8Array | null = null;
  try {
    buf = await readFile(pptxPath);
  } catch {
    buf = null;
  }
 // 源文件读不出时也要给出稳定指纹(用路径派生),否则调用方拿不到可对齐的 key
  const fingerprint = buf ? fingerprintOf(buf) : createHash("sha256").update(`io:${pptxPath}`).digest("hex").slice(0, 12);
  if (!visualRootAllowed(root)) return { ok: false, code: VISUAL_INVALID, fingerprint };
  if (!buf) return { ok: false, code: VISUAL_IO_ERROR, fingerprint };

  const report = input.report;
  const render = input.render ?? null;
  const at = new Date().toISOString();
 // 逐页复核清单:perPage 只需要「页码 + 对应 PNG」,页码取自 metrics.pages(真实页数)。
 // buildReviewRequest 是 runtime 的纯函数,这里动态 import —— store 仍不静态依赖 runtime,
 // 但报告里的 pendingCount 与 HTTP 复核链路用的是同一份口径(缺图的页只能是 pending)。
  let review: unknown = null;
  try {
    const rt = await runtimeModule();
    const pageCount = Math.max(0, Math.round(Number(report?.metrics?.pages) || 0));
    const pagesStub = Array.from({ length: pageCount }, (_, i) => ({ index: i + 1, width: 0, height: 0, shapes: [] as PShape[] }));
    review = rt.buildReviewRequest({ pages: pagesStub, pngPaths: render?.pngPaths ?? [], machineVerdict: report });
  } catch {
    review = null; // runtime 不可用时不编造 pendingCount
  }
  const body = {
    version: OFFICE_VISUAL_VERSION,
    pptxPath,
    fingerprint,
    at,
    machine: {
      verdict: report.verdict,
      score: report.score,
      code: report.code,
      metrics: report.metrics,
      issues: report.issues,
    },
    render: render ? { engine: render.engine, pngPaths: render.pngPaths } : null,
    review,
  };
  try {
    const dir = visualDir(root);
    await mkdir(dir, { recursive: true });
    const reportPath = join(dir, `${fingerprint}.json`);
    const text = JSON.stringify(body, null, 2) + "\n";
 // 原子写:先 .tmp 再 rename,读者永远看不到半截 JSON;内容相同则跳过重写(幂等)
    let same = false;
    try {
      same = (await readFile(reportPath, "utf8")) === text;
    } catch {
      same = false;
    }
    if (!same) {
      const tmpPath = `${reportPath}.tmp`;
      await writeFile(tmpPath, text, "utf8");
      await rename(tmpPath, reportPath);
    }
    const ledgerPath = join(dir, "ledger.jsonl");
    if (!(await ledgerHas(ledgerPath, fingerprint))) {
      const row = {
        at,
        fingerprint,
        verdict: report.verdict,
        score: report.score,
        issues: Array.isArray(report.issues) ? report.issues.length : 0,
        pngs: render ? render.pngPaths.length : 0,
      };
      await writeFile(ledgerPath, JSON.stringify(row) + "\n", { flag: "a" });
    }
    return { ok: true, code: VISUAL_OK, reportPath, ledgerPath, fingerprint };
  } catch (e) {
    return { ok: false, code: VISUAL_IO_ERROR, fingerprint };
  }
}

// ───────────────────────── 一站式:解析 → 渲染 → 判定 → 落盘 ─────────────────────────
/** 是否含 p0/p1(任一即失败门);severity 命名兼容 "p0"/"P0"/"error"。 */
function hasBlockingIssue(report: VisReport): boolean {
  const issues = Array.isArray(report.issues) ? report.issues : [];
  return issues.some((it) => {
    const s = String((it as { severity?: unknown }).severity ?? "").toLowerCase();
    return s === "p0" || s === "p1" || s === "error" || s === "critical" || s === "blocker";
  });
}

/**
 * 完整视觉体检(CLI 主路径)。
 * exitCode 口径:0 = pass/warn;2 = fail(含任一 p0/p1)或空盘;1 = 参数/IO/root/渲染失败。
 */
export async function runVisualCheck(input: {
  root: string;
  pptxPath: string;
  renderOutDir?: string;
  dpi?: number;
  thresholds?: Record<string, number>;
}): Promise<{
  ok: boolean;
  code: string;
  report: VisReport;
  render: { ok: boolean; code: string; engine: string; pngPaths: string[]; pages: number; durationMs: number; detail?: string } | null;
  reportPath?: string;
  ledgerPath?: string;
  exitCode: 0 | 1 | 2;
  fingerprint: string;
  detail?: string;
}> {
 // runtime 只在真正判定时才需要 → 动态 import,store 的单测不必等 runtime 编译
  const rt = await runtimeModule();
 // inspectDeck 第二个参数是 { thresholds }(不是裸阈值表),这里只做形状适配,不改语义
  const inspectDeck = (pages: PageGeometry[], thresholds?: Record<string, number>): VisReport =>
    rt.inspectDeck(pages, thresholds ? { thresholds: thresholds as never } : undefined);

  const pptxPath = resolve(input.pptxPath);
  let buf: Uint8Array;
  try {
    buf = await readFile(pptxPath);
  } catch (e) {
    const report = { ok: false, code: VISUAL_IO_ERROR, score: 0, verdict: "fail", issues: [], metrics: {} } as unknown as VisReport;
    return {
      ok: false,
      code: VISUAL_IO_ERROR,
      report,
      render: null,
      exitCode: 1,
      fingerprint: createHash("sha256").update(`io:${pptxPath}`).digest("hex").slice(0, 12),
      detail: e instanceof Error ? e.message : String(e),
    };
  }
  const geo = await parsePptxGeometry(buf);
  const fingerprint = fingerprintOf(buf);
  const thresholds = input.thresholds;

  let render: Awaited<ReturnType<typeof renderSlides>> | null = null;
  if (input.renderOutDir) {
    render = await renderSlides(pptxPath, resolve(input.renderOutDir), { dpi: input.dpi });
    if (!render.ok) {
 // 请求了渲染但引擎缺失/渲染失败:exitCode 1(不能拿「没图」当通过,也不能当 fail 结论)
      const report = inspectDeck(geo.pages, thresholds);
      return { ok: false, code: render.code, report, render, exitCode: 1, fingerprint, detail: render.detail };
    }
  }

  const report = inspectDeck(geo.pages, thresholds);
  const written = await writeVisualReport(input.root, {
    pptxPath,
    report,
    render: render ? { pngPaths: render.pngPaths, engine: render.engine } : null,
  });
  const code = geo.ok ? report.code || VISUAL_OK : geo.code;
  const failing = geo.code === VISUAL_EMPTY_DECK || report.verdict === "fail" || hasBlockingIssue(report);
 // 非 OOXML / 空盘:没有任何可判内容 → 1(参数/IO 级)/ 2(空盘另有明确口径)
  const parseBroken = !geo.ok && geo.code !== VISUAL_EMPTY_DECK;
  const exitCode: 0 | 1 | 2 = written.ok === false || parseBroken ? 1 : failing ? 2 : 0;
  return {
    ok: written.ok && !failing,
    code: written.ok ? code : written.code,
    report,
    render,
    reportPath: written.reportPath,
    ledgerPath: written.ledgerPath,
    exitCode,
    fingerprint,
    detail: geo.warnings.length ? geo.warnings.join("; ") : undefined,
  };
}
