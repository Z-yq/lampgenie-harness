/**
 * Office(PPTX/DOCX)只读预览的服务端解析(2026-10-29,板节点 ide-o1)。
 *
 * 为什么不在前端解:pptx/docx 是 zip 二进制,浏览器侧要么引 zip 库要么拉整包;而且 IDE 的文件字节
 * 走的是 file.read(文本)与 /ide/asset(图片/媒体)两条既定通道,二进制文档哪条都不合适。
 * 这里用 jszip(pptxgenjs 的传递依赖,已在盘上)解包 + 正则/手写轻量 XML 树(**不引 XML 解析器**,
 * OOXML 结构简单,少一个打包风险面),产出与前端约定的 OfficeAst,由 assets/ide-office.js 只负责画。
 *
 * 契约(不可改,前端 worker 按此实现):
 *   OfficeRun / OfficeShape / OfficeSlide / OfficeBlock / OfficeAst —— 见下方 interface。
 *
 * 健壮性硬要求(用户口径「预览不该白屏也不该 500 满天飞」):
 *  - 任何 XML 缺字段不得抛错:取不到的属性一律走默认值(数字 0 / 空文本 / 不产出该字段);
 *  - zip 解不开(非 OOXML / 坏包)→ throw Error("不是有效的 OOXML 文件");
 *  - 文件超 128MB 直接拒(防内存炸弹:整包要读进内存才能解)。
 */
import JSZip from "jszip";

export interface OfficeRun { text: string; bold?: boolean; italic?: boolean; underline?: boolean; sizePt?: number; color?: string; revised?: "ins" | "del" }
/** 渐变色标:pos 0..1(对应 a:gs@pos/100000),color "#RRGGBB"。 */
export interface GradientStop { pos: number; color: string }
/** 线性渐变:angle 度(CSS 约定 0=向上、顺时针;由 a:lin@ang/60000 再 +90 折算到 CSS 角度)。 */
export interface OfficeGradient { angle: number; stops: GradientStop[] }
/** 外阴影:a:outerShdw 的 blurRad / dist+dir 投影到 x/y(EMU)。 */
export interface OfficeShadow { color: string; blurEmu: number; dxEmu: number; dyEmu: number }
/** 描边:a:ln@w + a:ln/a:solidFill。 */
export interface OfficeStroke { color: string; widthEmu: number }
export interface OfficeTableCell { text: string }
export interface OfficeTableShape { rows: { cells: OfficeTableCell[] }[]; colWidthsEmu: number[] }
export interface OfficeChartSeries { name: string; cats: string[]; vals: number[] }
export interface OfficeChart { kind: "bar" | "line" | "pie"; series: OfficeChartSeries[] }
export interface OfficeDiagramNode { id: string; text: string; parentId?: string }
export interface OfficeShape {
  type: "text" | "image" | "shape" | "table" | "chart" | "unsupported";
  x: number; y: number; cx: number; cy: number;      // EMU 原始值
  text?: string;
  runs?: OfficeRun[];
  align?: "l" | "c" | "r";
  fill?: string | { gradient: OfficeGradient };      // 纯色 "#RRGGBB" | 线性渐变
  src?: string;                                      // 形如 "/ide/office/media?path=<urlencoded 相对路径>&part=ppt/media/image1.png"
  shadow?: OfficeShadow;
  stroke?: OfficeStroke;
  table?: OfficeTableShape;
  chart?: OfficeChart;
  diagram?: { nodes: OfficeDiagramNode[] };
  unsupportedKind?: "chart" | "smartart" | "media" | "group" | "other";
}
export interface OfficeSlide { index: number; widthEmu: number; heightEmu: number; shapes: OfficeShape[] }
export interface OfficeBlock {
  type: "p" | "table" | "unsupported";
  style?: string;                                    // 如 "Heading1"
  align?: "left" | "center" | "right";
  listLevel?: number;
  runs?: OfficeRun[];
  rows?: string[][];                                 // 表格:每行每格的纯文本
  comments?: string[];                               // 批注:形如 ["张三: 这里要改"]
  unsupportedKind?: string;
}
/** docx 的 blocks **只含 body**;页眉/页脚/脚注各自成数组(否则 blockIndex 会漂移)。 */
export type OfficeAst =
  | { kind: "pptx"; slides: OfficeSlide[] }
  | { kind: "docx"; blocks: OfficeBlock[]; headers?: OfficeBlock[]; footers?: OfficeBlock[]; footnotes?: OfficeBlock[] };

/** 单文件上限(与路由 413 同源口径):整包读进内存才可解,再大就是内存炸弹。
 *  2026-10-29 AST v2:64MB → 128MB(带图/嵌表的大课件常超 64MB,实测 90MB 级 pptx 可正常解)。 */
export const OFFICE_MAX_BYTES = 128 * 1024 * 1024;
/** 可预览扩展名(小写带点)。 */
export const OFFICE_DOC_EXT = new Set([".pptx", ".docx"]);
/** /ide/office/media 的 part 白名单前缀(防路径穿越:只允许这两棵树下的媒体文件)。 */
const OFFICE_MEDIA_PART_RE = /^(?:ppt|word)\/media\/[A-Za-z0-9._-]+$/;

/** 解析入口:ext 只认 ".pptx"/".docx"(其余抛错,文案含「仅 .pptx/.docx」)。
 *  opts 是**加性可选**扩展(契约签名本身不变):docPath/pid 只用来拼图片 src 的完整 URL,
 *  缺省时 src 仍带 part 但无 path(前端若自行拼 URL 也不冲突)。 */
export async function parseOffice(
  buf: Buffer,
  ext: ".pptx" | ".docx",
  opts?: { docPath?: string; pid?: string },
): Promise<OfficeAst> {
  const e = String(ext || "").toLowerCase();
  if (!OFFICE_DOC_EXT.has(e)) throw new Error("不支持的文档类型:仅 .pptx/.docx 可预览");
  if (!buf || buf.length === 0) throw new Error("不是有效的 OOXML 文件");
  if (buf.length > OFFICE_MAX_BYTES) throw new Error("文件过大(>128MB),不支持预览");
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(buf); } catch { throw new Error("不是有效的 OOXML 文件"); }
  const docPath = String(opts?.docPath || "");
  const pid = opts?.pid ? String(opts.pid) : "";
  if (e === ".pptx") {
    if (!zip.file("ppt/presentation.xml") && !Object.keys(zip.files).some((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))) {
      throw new Error("不是有效的 OOXML 文件(缺少 ppt/presentation.xml)");
    }
    return await parsePptx(zip, docPath, pid);
  }
  if (!zip.file("word/document.xml")) throw new Error("不是有效的 OOXML 文件(缺少 word/document.xml)");
  return await parseDocx(zip);
}

/** 从 zip 里单独取一个媒体 part(/ide/office/media 用:不整包解压大文件)。
 *  part 必须命中白名单前缀(ppt/media/、word/media/);不在包内/不在白名单 → null。 */
export async function readOfficePart(buf: Buffer, part: string): Promise<Buffer | null> {
  const p = String(part || "").replace(/\\/g, "/");
  if (!OFFICE_MEDIA_PART_RE.test(p)) return null;
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(buf); } catch { throw new Error("不是有效的 OOXML 文件"); }
  const f = zip.file(p);
  if (!f) return null;
  try {
    const out = await f.async("nodebuffer");
    return Buffer.isBuffer(out) ? out : Buffer.from(out);
  } catch { return null; }
}

// ───────────────────────── 轻量 XML 树(够用即可,缺字段一律走默认) ─────────────────────────
interface XNode {
  name: string; attrs: Record<string, string>; kids: (XNode | string)[];
  /** span 模式下记录节点在原文里的位置(rewriteOfficeText 做精确字符串替换用):
   *  openAt = 开标签 '<' 下标;contentAt = 内容起点(开标签 '>' 之后);contentEnd = 内容终点(闭合标签 '<')。
   *  自闭合标签 contentAt === contentEnd。非 span 模式一律 undefined。 */
  openAt?: number; contentAt?: number; contentEnd?: number;
}


/** 本地名(去命名空间前缀):a:t → t、w:pStyle → pStyle、p:sp → sp。 */
function localName(nm: string): string {
  const i = nm.indexOf(":");
  return i < 0 ? nm : nm.slice(i + 1);
}

function decodeEntities(s: string): string {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(lt|gt|amp|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/g, (m, g: string) => {
    switch (g) {
      case "lt": return "<";
      case "gt": return ">";
      case "amp": return "&";
      case "quot": return "\"";
      case "apos": return "'";
      default:
        if (g[0] === "#") {
          const code = g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
          if (isFinite(code) && code > 0 && code <= 0x10ffff) { try { return String.fromCodePoint(code); } catch { return m; } }
        }
        return m;
    }
  });
}

/** 找标签名结束的 '>'(跳过属性值里的引号内容;OOXML 属性值里偶见 '>')。 */
function tagClose(src: string, from: number): number {
  let q = "";
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === q) q = ""; continue; }
    if (c === "\"" || c === "'") { q = c; continue; }
    if (c === ">") return i;
  }
  return -1;
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const name = m[1];
    if (!name) continue;
    out[name] = decodeEntities(m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : ""));
  }
  return out;
}

/** 手写 XML → 轻量树。容忍:声明/注释/CDATA/DOCTYPE/自闭合/属性引号;标签不配对时按就近栈回落。
 *  span=true 时额外记录每个节点的原文位置(openAt/contentAt/contentEnd),供 rewriteOfficeText
 *  做**精确字符串替换**(只改目标文本节点的字符区间,不重新序列化整棵树)。 */
function parseXmlCore(src: string, span: boolean): XNode {
  const root: XNode = { name: "#root", attrs: {}, kids: [] };
  if (span) { root.openAt = 0; root.contentAt = 0; root.contentEnd = src.length; }
  const stack: XNode[] = [root];
  const n = src.length;
  let i = 0;
  const pushText = (t: string): void => {
    if (!t) return;
    const top = stack[stack.length - 1];
    if (top) top.kids.push(decodeEntities(t));
  };
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) { pushText(src.slice(i)); break; }
    if (lt > i) pushText(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) { const e = src.indexOf("-->", lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith("<![CDATA[", lt)) {
      const e = src.indexOf("]]>", lt + 9);
      const txt = src.slice(lt + 9, e < 0 ? n : e);
      const top = stack[stack.length - 1];
      if (top) top.kids.push(txt);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (src.startsWith("<?", lt)) { const e = src.indexOf("?>", lt + 2); i = e < 0 ? n : e + 2; continue; }
    if (src.startsWith("<!", lt)) { const e = tagClose(src, lt + 2); i = e < 0 ? n : e + 1; continue; }
    const gt = tagClose(src, lt + 1);
    if (gt < 0) break;
    const raw = src.slice(lt + 1, gt);
    i = gt + 1;
    if (raw[0] === "/") { // 闭合标签:就近弹出到同名节点(容忍多余/缺失的闭合)
      const nm = raw.slice(1).trim();
      for (let k = stack.length - 1; k > 0; k--) {
        const cur = stack[k];
        if (cur && cur.name === nm) { // 被这段闭合标签一并弹掉的节点,内容都在 lt 处结束
          for (let j = stack.length - 1; j >= k; j--) {
            const it = stack[j];
            if (span && it && it.contentEnd === undefined) it.contentEnd = lt;
          }
          stack.length = k;
          break;
        }
      }
      continue;
    }
    const selfClose = raw.endsWith("/");
    const body = selfClose ? raw.slice(0, -1) : raw;
    const sp = body.search(/\s/);
    const name = sp < 0 ? body : body.slice(0, sp);
    if (!name) continue;
    const node: XNode = { name, attrs: parseAttrs(sp < 0 ? "" : body.slice(sp)), kids: [] };
    if (span) { node.openAt = lt; node.contentAt = gt + 1; if (selfClose) node.contentEnd = gt + 1; }
    const top = stack[stack.length - 1];
    if (top) top.kids.push(node);
    if (!selfClose) stack.push(node);
  }
  if (span) { // 未闭合的残缺节点:内容算到文末,保证区间合法(替换时不会越界)
    for (const it of stack) { if (it.contentEnd === undefined) it.contentEnd = n; }
  }
  return root;
}

/** 手写 XML → 轻量树(对外既有导出;行为不变)。 */
export function parseXmlTree(src: string): XNode {
  return parseXmlCore(src, false);
}

/** 直接子节点里按本地名找第一个。 */
function child(n: XNode | undefined, name: string): XNode | undefined {
  if (!n) return undefined;
  for (const k of n.kids) { if (typeof k !== "string" && localName(k.name) === name) return k; }
  return undefined;
}
function children(n: XNode | undefined, name: string): XNode[] {
  const out: XNode[] = [];
  if (!n) return out;
  for (const k of n.kids) { if (typeof k !== "string" && localName(k.name) === name) out.push(k); }
  return out;
}
/** 深度优先找第一个后代(含直接子)。 */
function findFirst(n: XNode | undefined, name: string): XNode | undefined {
  if (!n) return undefined;
  for (const k of n.kids) {
    if (typeof k === "string") continue;
    if (localName(k.name) === name) return k;
    const d = findFirst(k, name);
    if (d) return d;
  }
  return undefined;
}
function findAll(n: XNode, name: string, acc: XNode[] = []): XNode[] {
  for (const k of n.kids) {
    if (typeof k === "string") continue;
    if (localName(k.name) === name) acc.push(k);
    findAll(k, name, acc);
  }
  return acc;
}
/** 属性取值:先精确名(含前缀无关的裸名),再按本地名匹配(r:embed → "embed"、w:val → "val")。 */
function attrOf(n: XNode | undefined, name: string): string | undefined {
  if (!n) return undefined;
  const exact = n.attrs[name];
  if (exact !== undefined) return exact;
  for (const k of Object.keys(n.attrs)) { if (localName(k) === name) return n.attrs[k]; }
  return undefined;
}
function numOr(v: string | undefined, d = 0): number {
  if (v === undefined || v === null || v === "") return d;
  const x = Number(v);
  return isFinite(x) ? x : d;
}
/** 节点的文本(含后代文本,不做 trim —— xml:space="preserve" 下空格有意义)。 */
function textOf(n: XNode | undefined): string {
  if (!n) return "";
  let s = "";
  for (const k of n.kids) s += typeof k === "string" ? k : textOf(k);
  return s;
}
/** OOXML 布尔开关元素(w:b / a:rPr@b):val 缺失或非 0/false/off/none → 视为开启。 */
function flagOn(n: XNode | undefined): boolean {
  if (!n) return false;
  const v = attrOf(n, "val");
  if (v === undefined || v === "") return true;
  const s = v.trim().toLowerCase();
  return !(s === "0" || s === "false" || s === "off" || s === "none" || s === "no");
}
function normColor(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return undefined;
  return "#" + s.toUpperCase();
}
// ───────────────── 颜色:主题色折算(AST v2 板节点 02) ─────────────────
/** 主题色方案(dk1/lt1/dk2/lt2/accent1-6/hlink/folHlink → "#RRGGBB")。 */
type ThemeColors = Record<string, string>;
/** 形状/占位符继承上下文:主题色 + 母版/版式兜底(底色/字号/对齐)。**全部可选**,缺什么就回退默认。 */
interface ShapeCtx {
  theme?: ThemeColors;
  bg?: string;                 // 从 layout → master 继承来的底色
  inh?: Map<string, { szPt?: number; align?: "l" | "c" | "r" }>;  // 占位符键 → 继承字号/对齐
}

/** 预读的图形部件(chartN.xml / dataN.xml):part 路径 → XML 原文。
 *  pptxShapeList 是同步递归,部件内容必须先在 parsePptx 里异步读好塞进来。 */
interface PptxParts { parts?: Record<string, string> }

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
function toHex2(x: number): string {
  const v = Math.round(clamp01(x / 255) * 255);
  return (v < 16 ? "0" : "") + v.toString(16).toUpperCase();
}
/** "#RRGGBB" → [r,g,b](非法 → undefined)。 */
function hexRgb(h: string | undefined): [number, number, number] | undefined {
  const c = normColor(h);
  if (!c) return undefined;
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}
/** 主题色修饰:lumMod/lumOff/shade/tint(OOXML 用千分比,60000 = 60%)。
 *  lum 类按 HSL 亮度线性改(与 PowerPoint 观感一致),shade/tint 按 RGB 线性混黑/混白。 */
function applyColorMods(hex: string | undefined, colorNode: XNode | undefined): string | undefined {
  const rgb = hexRgb(hex);
  if (!rgb || !colorNode) return hex;
  const modOf = (nm: string): number | undefined => {
    const n = child(colorNode, nm);
    if (!n) return undefined;
    const v = attrOf(n, "val");
    return v === undefined || v === "" ? undefined : numOr(v, 0) / 100000;
  };
  const lumMod = modOf("lumMod"), lumOff = modOf("lumOff"), shade = modOf("shade"), tint = modOf("tint");
  let [r, g, b] = rgb;
  if (shade !== undefined) { r *= shade; g *= shade; b *= shade; }
  if (tint !== undefined) { r = r * tint + 255 * (1 - tint); g = g * tint + 255 * (1 - tint); b = b * tint + 255 * (1 - tint); }
  if (lumMod !== undefined || lumOff !== undefined) {
    // RGB → HSL(只取亮度做线性换算,色相/饱和度不变)→ HSL → RGB
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
      else if (max === gn) h = (bn - rn) / d + 2;
      else h = (rn - gn) / d + 4;
      h /= 6;
    }
    const nl = clamp01(l * (lumMod === undefined ? 1 : lumMod) + (lumOff === undefined ? 0 : lumOff));
    const hue2rgb = (p: number, q: number, t: number): number => {
      let tt = t;
      if (tt < 0) tt += 1;
      if (tt > 1) tt -= 1;
      if (tt < 1 / 6) return p + (q - p) * 6 * tt;
      if (tt < 1 / 2) return q;
      if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
      return p;
    };
    if (s === 0) { r = nl * 255; g = nl * 255; b = nl * 255; }
    else {
      const q = nl < 0.5 ? nl * (1 + s) : nl + s - nl * s;
      const p = 2 * nl - q;
      r = hue2rgb(p, q, h + 1 / 3) * 255; g = hue2rgb(p, q, h) * 255; b = hue2rgb(p, q, h - 1 / 3) * 255;
    }
  }
  return "#" + toHex2(r) + toHex2(g) + toHex2(b); // toHex2 内部 clamp,不会越界
}
/** 主题色名取基色(支持 clrMap 重映射已在构建表时做完;此处只查表)。 */
function schemeBase(name: string, theme: ThemeColors | undefined): string | undefined {
  if (!theme) return undefined;
  const k = String(name || "").trim();
  return normColor(theme[k]);
}
/** 颜色节点(srgbClr / sysClr / schemeClr / prstClr) → "#RRGGBB"(含修饰;缺主题 → undefined)。 */
function colorNodeHex(n: XNode | undefined, theme: ThemeColors | undefined): string | undefined {
  if (!n) return undefined;
  const tag = localName(n.name);
  if (tag === "srgbClr") return applyColorMods(normColor(attrOf(n, "val")), n);
  if (tag === "sysClr") return applyColorMods(normColor(attrOf(n, "lastClr")), n);
  if (tag === "schemeClr") return applyColorMods(schemeBase(attrOf(n, "val") || "", theme), n);
  return undefined;
}
/** 容器下第一个颜色子节点(不限本地名,按已知形态挑)。 */
function firstColorChild(container: XNode | undefined, theme: ThemeColors | undefined): string | undefined {
  if (!container) return undefined;
  const order = ["srgbClr", "sysClr", "schemeClr"];
  for (const want of order) {
    const n = child(container, want);
    if (n) {
      const c = colorNodeHex(n, theme);
      if (c) return c;
    }
  }
  return undefined;
}
/** <a:solidFill>…</a:solidFill> → "#RRGGBB"(srgbClr / sysClr@lastClr / schemeClr 折算;没有就 undefined)。 */
function solidFillColor(container: XNode | undefined, theme?: ThemeColors): string | undefined {
  const fill = container ? child(container, "solidFill") : undefined;
  return firstColorChild(fill, theme);
}
/** 渐变:<a:gradFill><a:gsLst><a:gs pos=…/><a:lin ang=…/></a:gradFill> → {angle, stops}。
 *  OOXML 的 ang 是「六万分之一度、0=向右、顺时针」,CSS linear-gradient 角是「0=向上、顺时针」,
 *  故 CSS 角 = ang/60000 + 90。缺 ang → 90(CSS 里等于"向右")。色标按 pos 升序、pos 归一到 0..1。 */
function gradientFill(container: XNode | undefined, theme: ThemeColors | undefined): OfficeGradient | undefined {
  const gf = container ? child(container, "gradFill") : undefined;
  if (!gf) return undefined;
  const gsLst = child(gf, "gsLst");
  const stops: GradientStop[] = [];
  for (const gs of children(gsLst, "gs")) {
    const pos = clamp01(numOr(attrOf(gs, "pos"), 0) / 100000);
    const color = firstColorChild(gs, theme);
    if (!color) continue;                                  // 取不到颜色的色标不产出(不造 #undefined)
    stops.push({ pos, color });
  }
  if (!stops.length) return undefined;
  stops.sort((a, b) => a.pos - b.pos);
  const lin = child(gf, "lin");
  const rawAng = numOr(attrOf(lin, "ang"), 0) / 60000;
  const angle = Math.round(((rawAng + 90) % 360) * 100) / 100;
  return { angle, stops };
}
/** 外阴影:<a:effectLst><a:outerShdw blurRad dist dir srgbClr>。
 *  dx = dist*cos(dir)、dy = dist*sin(dir),dir 是六万分之一度(顺时针,0=右,故屏幕 y 轴向下取 +sin)。 */
function outerShadow(effectLst: XNode | undefined, theme: ThemeColors | undefined): OfficeShadow | undefined {
  const sh = effectLst ? child(effectLst, "outerShdw") : undefined;
  if (!sh) return undefined;
  const blur = numOr(attrOf(sh, "blurRad"), 0);
  const dist = numOr(attrOf(sh, "dist"), 0);
  const dir = numOr(attrOf(sh, "dir"), 0) / 60000;         // 度
  const rad = (dir * Math.PI) / 180;
  const dx = Math.round(dist * Math.cos(rad));
  const dy = Math.round(dist * Math.sin(rad));
  const color = firstColorChild(sh, theme) || "#000000";
  return { color, blurEmu: blur, dxEmu: dx, dyEmu: dy };
}
/** 描边:<a:ln w="12700"><a:solidFill><a:srgbClr/></a:solidFill></a:ln> → {widthEmu,color}。
 *  无 a:ln → undefined(不默认造 1px 黑边)。 */
function lineStroke(spPr: XNode | undefined, theme: ThemeColors | undefined): OfficeStroke | undefined {
  const ln = spPr ? child(spPr, "ln") : undefined;
  if (!ln) return undefined;
  if (child(ln, "noFill")) return undefined;              // 显式"无描边"
  const w = numOr(attrOf(ln, "w"), 0);
  const color = solidFillColor(ln, theme);
  if (!color && w <= 0) return undefined;
  const out: OfficeStroke = { widthEmu: w, color: color || "#000000" };
  return out;
}

// ───────────────────────── PPTX ─────────────────────────
function pptxXfrm(container: XNode | undefined): { x: number; y: number; cx: number; cy: number } {
  const xfrm = container ? findFirst(container, "xfrm") : undefined;
  const off = child(xfrm, "off");
  const ext = child(xfrm, "ext");
  return { x: numOr(attrOf(off, "x")), y: numOr(attrOf(off, "y")), cx: numOr(attrOf(ext, "cx")), cy: numOr(attrOf(ext, "cy")) };
}
function pptxAlign(v: string | undefined): "l" | "c" | "r" | undefined {
  const s = String(v || "").toLowerCase();
  if (s === "l" || s === "left") return "l";
  if (s === "ctr" || s === "center") return "c";
  if (s === "r" || s === "right") return "r";
  if (s === "just" || s === "justify" || s === "dist" || s === "thai_dist") return "l";
  return undefined;
}
/** <a:rPr sz="1800" b="1" i="0"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:rPr> → run 属性。 */
function pptxRunProps(rPr: XNode | undefined, theme?: ThemeColors): Omit<OfficeRun, "text"> {
  const out: Omit<OfficeRun, "text"> = {};
  if (!rPr) return out;
  const b = attrOf(rPr, "b");
  if (b !== undefined && b !== "" && b !== "0" && b.toLowerCase() !== "false") out.bold = true;
  const i = attrOf(rPr, "i");
  if (i !== undefined && i !== "" && i !== "0" && i.toLowerCase() !== "false") out.italic = true;
  const u = attrOf(rPr, "u");
  if (u !== undefined && u !== "" && u.toLowerCase() !== "none") out.underline = true;
  const sz = numOr(attrOf(rPr, "sz"), 0);
  if (sz > 0) out.sizePt = sz / 100; // 百分之一磅 → pt
  const c = solidFillColor(rPr, theme);
  if (c) out.color = c;
  return out;
}
/** txBody → { text, runs, align }:每段 a:p 的 a:r 依次收集,段间插 {"\n"} run 保住换行。 */
function pptxTextBody(txBody: XNode | undefined, theme?: ThemeColors): { text: string; runs: OfficeRun[]; align?: "l" | "c" | "r" } {
  const runs: OfficeRun[] = [];
  const parts: string[] = [];
  let align: "l" | "c" | "r" | undefined;
  const paras = children(txBody, "p");
  for (const p of paras) {
    const pPr = child(p, "pPr");
    if (!align) align = pptxAlign(attrOf(pPr, "algn"));
    if (parts.length > 0 && runs.length > 0) runs.push({ text: "\n" }); // 段间换行(首段前不插)
    let line = "";
    for (const k of p.kids) {
      if (typeof k === "string") continue;
      const tag = localName(k.name);
      if (tag === "r" || tag === "fld") {
        const txt = textOf(child(k, "t"));
        if (!txt) continue;
        line += txt;
        runs.push({ text: txt, ...pptxRunProps(child(k, "rPr"), theme) });
      } else if (tag === "br") {
        line += "\n";
        runs.push({ text: "\n" });
      }
    }
    parts.push(line);
  }
  return { text: parts.join("\n"), runs, align };
}

function pptxRelMap(xml: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!xml) return out;
  const root = parseXmlTree(xml);
  for (const rel of findAll(root, "Relationship")) {
    const id = attrOf(rel, "Id");
    const target = attrOf(rel, "Target");
    const mode = attrOf(rel, "TargetMode");
    if (!id || !target) continue;
    if (mode && mode.toLowerCase() === "external") continue; // 外链不同步(不产出 src)
    out[id] = target;
  }
  return out;
}
/** zip 内相对路径解析("../media/image1.png" 相对 "ppt/slides" → "ppt/media/image1.png")。 */
function resolvePart(baseDir: string, target: string): string {
  const t = String(target || "").replace(/\\/g, "/");
  if (t.startsWith("/")) return t.slice(1);
  const segs = (baseDir ? baseDir.split("/") : []).concat(t.split("/"));
  const out: string[] = [];
  for (const s of segs) {
    if (!s || s === ".") continue;
    if (s === "..") { out.pop(); continue; }
    out.push(s);
  }
  return out.join("/");
}
/** 媒体 src(前端 <img> 直连 /ide/office/media;part 已白名单化,path 走 urlencode)。 */
function mediaSrc(docPath: string, part: string, pid: string): string | undefined {
  if (!OFFICE_MEDIA_PART_RE.test(part)) return undefined;
  const q = "/ide/office/media?path=" + encodeURIComponent(docPath) + "&part=" + part;
  return pid ? q + "&pid=" + encodeURIComponent(pid) : q;
}

/** 形状 spPr → 底色(纯色 | 渐变):solidFill 优先,其次 gradFill;都没有 → undefined。 */
function pptxFill(spPr: XNode | undefined, theme?: ThemeColors): string | { gradient: OfficeGradient } | undefined {
  const solid = solidFillColor(spPr, theme);
  if (solid) return solid;
  const grad = gradientFill(spPr, theme);
  if (grad) return { gradient: grad };
  return undefined;
}

/** 形状占位符键(nvSpPr/nvPr/ph@type + @idx):layout/master 的同键占位符提供继承字号/对齐。 */
function phKeys(sp: XNode): string[] {
  const ph = sp ? findFirst(child(sp, "nvSpPr"), "ph") : undefined;
  if (!ph) return [];
  const out: string[] = [];
  const type = String(attrOf(ph, "type") || "").trim();
  const idx = String(attrOf(ph, "idx") || "").trim();
  if (type) out.push("t:" + type);
  if (idx) out.push("i:" + idx);
  return out;
}
/** 从 layout/master 的占位符里收集「键 → {szPt, align}」继承表(layout 覆盖 master 由调用序决定)。 */
function phInherit(root: XNode | undefined, into: Map<string, { szPt?: number; align?: "l" | "c" | "r" }>): void {
  if (!root) return;
  for (const sp of findAll(root, "sp")) {
    const keys = phKeys(sp);
    if (!keys.length) continue;
    const body = child(sp, "txBody");
    const szNode = findFirst(body, "defRPr") || findFirst(body, "rPr");
    const sz = numOr(attrOf(szNode, "sz"), 0);
    const al = pptxAlign(attrOf(findFirst(body, "pPr"), "algn"));
    if (sz <= 0 && !al) continue;
    const val = { szPt: sz > 0 ? sz / 100 : undefined, align: al };
    for (const k of keys) {
      const cur = into.get(k);
      into.set(k, { szPt: val.szPt ?? cur?.szPt, align: val.align ?? cur?.align });
    }
  }
}

function pptxSp(sp: XNode, ctx?: ShapeCtx): OfficeShape {
  const spPr = child(sp, "spPr");
  const pos = pptxXfrm(spPr);
  const fill = pptxFill(spPr, ctx?.theme);
  const body = pptxTextBody(child(sp, "txBody"), ctx?.theme);
  // 占位符继承:自己的 ph 键(layout/master 同键占位符)提供字号/对齐,取不到就不加字段
  let inhSz: number | undefined;
  let inhAl: "l" | "c" | "r" | undefined;
  if (ctx?.inh) {
    for (const key of phKeys(sp)) {
      const hit = ctx.inh.get(key);
      if (!hit) continue;
      if (inhSz === undefined && hit.szPt !== undefined && hit.szPt > 0) inhSz = hit.szPt;
      if (inhAl === undefined && hit.align) inhAl = hit.align;
    }
  }
  if (inhSz !== undefined) {
    for (const r of body.runs) if (r.sizePt === undefined && r.text.trim()) r.sizePt = inhSz;
  }
  const out: OfficeShape = !body.text && !body.runs.length
    ? { type: "shape", ...pos }                                   // 无文字的纯形状(矩形/箭头等)
    : { type: "text", ...pos, text: body.text, runs: body.runs };
  if (body.align) out.align = body.align;
  else if (inhAl && out.type === "text") out.align = inhAl;
  if (fill !== undefined) out.fill = fill;
  else if (ctx?.bg) out.fill = ctx.bg;                            // 显式无填充 → 母版背景兜底
  const shadow = outerShadow(child(spPr, "effectLst"), ctx?.theme);
  if (shadow) out.shadow = shadow;
  const stroke = lineStroke(spPr, ctx?.theme);
  if (stroke) out.stroke = stroke;
  return out;
}

function pptxPic(pic: XNode, rels: Record<string, string>, baseDir: string, docPath: string, pid: string): OfficeShape {
  const pos = pptxXfrm(child(pic, "spPr"));
  const blip = findFirst(pic, "blip");
  if (findFirst(pic, "videoFile") || findFirst(pic, "audioFile") || findFirst(pic, "media")) {
    return { type: "unsupported", ...pos, unsupportedKind: "media" }; // 影音不预览(前端无法解容器)
  }
  const rid = attrOf(blip, "embed") || attrOf(blip, "link");
  const target = rid ? rels[rid] : undefined;
  const part = target ? resolvePart(baseDir, target) : "";
  const src = part && docPath ? mediaSrc(docPath, part, pid) : undefined;
  if (!src) return { type: "unsupported", ...pos, unsupportedKind: "other" };
  return { type: "image", ...pos, src };
}

/** 图表部件(c:chartSpace) → {kind, series}。
 *  kind 取 c:barChart / c:lineChart / c:pieChart;系列名 c:tx、分类 c:cat、数值 c:val
 *  (各自 strCache/numCache/strLit/numLit 都认)。c:ser 为空 → series:[](不抛错)。 */
function chartCachedValues(n: XNode | undefined): string[] {
  if (!n) return [];
  const host = findFirst(n, "strCache") || findFirst(n, "numCache") || findFirst(n, "strLit") || findFirst(n, "numLit");
  const out: string[] = [];
  for (const pt of children(host, "pt")) {
    const v = child(pt, "v");
    out.push(v ? textOf(v) : "");
  }
  if (out.length) return out;
  const v = findFirst(n, "v"); // 退化形态:<c:tx><c:v>系列名</c:v></c:tx>
  return v ? [textOf(v)] : [];
}
function parseChartXml(xml: string): OfficeChart | undefined {
  const root = parseXmlTree(xml);
  let kindNode: XNode | undefined;
  let kind: "bar" | "line" | "pie" | undefined;
  for (const cand of [["barChart", "bar"], ["lineChart", "line"], ["pieChart", "pie"]] as const) {
    const n = findFirst(root, cand[0]);
    if (n) { kindNode = n; kind = cand[1]; break; }
  }
  if (!kindNode || !kind) return undefined;
  const series: OfficeChartSeries[] = [];
  for (const ser of children(kindNode, "ser")) {
    const name = chartCachedValues(child(ser, "tx"))[0] || "";
    const cats = chartCachedValues(child(ser, "cat"));
    const vals = chartCachedValues(child(ser, "val")).map((s) => { const n = Number(s); return isFinite(n) ? n : 0; });
    series.push({ name, cats, vals });
  }
  return { kind, series };
}

/** SmartArt 部件(dgm:dataModel) → 节点树。
 *  dgm:pt@modelId 是节点 id;dgm:cxn(type=parOf,@srcId=父,@destId=子)定父子。
 *  无 modelId 的点(连线端点/空点)跳过;dgm:pt 全空 → {nodes:[]}(不抛错)。 */
function parseDiagramXml(xml: string): { nodes: OfficeDiagramNode[] } {
  const nodes: OfficeDiagramNode[] = [];
  const root = parseXmlTree(xml);
  const ptLst = findFirst(root, "ptLst");
  for (const pt of children(ptLst, "pt")) {
    const id = String(attrOf(pt, "modelId") || "").trim();
    if (!id) continue;
    const t = findFirst(pt, "t");
    nodes.push({ id, text: t ? textOf(t) : "" });
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const cxn of findAll(findFirst(root, "cxnLst") || root, "cxn")) {
    const type = String(attrOf(cxn, "type") || "").toLowerCase();
    if (type && type !== "parof" && type !== "paroftrans") continue;
    const src = String(attrOf(cxn, "srcId") || "").trim();
    const dst = String(attrOf(cxn, "destId") || "").trim();
    const childNode = dst ? byId.get(dst) : undefined;
    if (!src || !childNode || childNode.parentId || !byId.has(src)) continue;
    childNode.parentId = src;
  }
  return { nodes };
}

/** graphicFrame:表格(a:tbl)结构化、图表(经 rels → chartN.xml)出 chart、SmartArt(经 r:dm)出 diagram;
 *  部件缺失/解析不出 → 保持 unsupported(带 unsupportedKind),前端照旧落降级文案。 */
function pptxGraphicFrame(gf: XNode, rels: Record<string, string>, baseDir: string, docPath: string, pid: string, ctx?: PptxParts): OfficeShape {
  const pos = pptxXfrm(gf);   // p:graphicFrame/p:xfrm(V1 误传 child(gf,"xfrm") 进去，几何一直是 0)
  const gd = findFirst(gf, "graphicData");
  const uri = String(attrOf(gd, "uri") || "").toLowerCase();
  const chartEl = findFirst(gf, "chart");
  const relIds = findFirst(gf, "relIds");
  const isChart = uri.indexOf("/chart") >= 0 || !!chartEl;
  const isDgm = uri.indexOf("/diagram") >= 0 || !!relIds || !!findFirst(gf, "diagram");
  if (isChart) {
    const rid = attrOf(chartEl, "id");
    const target = rid ? rels[rid] : undefined;
    const xml = target ? ctx?.parts?.[resolvePart(baseDir, target)] : undefined;
    const chart = xml ? parseChartXml(xml) : undefined;
    if (chart) return { type: "chart", ...pos, chart };
    return { type: "unsupported", ...pos, unsupportedKind: "chart" };
  }
  if (isDgm) {
    const rid = attrOf(relIds, "dm");
    const target = rid ? rels[rid] : undefined;
    const xml = target ? ctx?.parts?.[resolvePart(baseDir, target)] : undefined;
    if (xml) return { type: "shape", ...pos, diagram: parseDiagramXml(xml) };
    return { type: "unsupported", ...pos, unsupportedKind: "smartart" };
  }
  const tbl = findFirst(gf, "tbl");
  if (tbl) { // 表格:结构化出 rows/cells + 逐列宽(不再拍平成文本)
    const rows: { cells: OfficeTableCell[] }[] = [];
    for (const tr of children(tbl, "tr")) {
      const cells: OfficeTableCell[] = [];
      for (const tc of children(tr, "tc")) cells.push({ text: textOf(tc).replace(/\s+/g, " ").trim() });
      rows.push({ cells });
    }
    const colWidthsEmu: number[] = [];
    for (const gc of children(child(tbl, "tblGrid"), "gridCol")) colWidthsEmu.push(numOr(attrOf(gc, "w"), 0));
    return { type: "table", ...pos, table: { rows, colWidthsEmu } };
  }
  return { type: "unsupported", ...pos, unsupportedKind: "other" };
}

/** 组合内的坐标变换:x' = a + x*sx、y' = b + y*sy(把子形状局部坐标搬到父坐标)。 */
interface Xf { a: number; b: number; sx: number; sy: number }
function finNum(n: number): number { return Number.isFinite(n) ? n : 0; }
/** grpSpPr/xfrm → 子坐标系到父坐标系的变换。chExt 缺失/为 0 → 缩放退化为 1(绝不出 NaN/Infinity)。 */
function groupXf(grpSpPr: XNode | undefined, outer?: Xf): Xf {
  const xfrm = child(grpSpPr, "xfrm");
  const off = child(xfrm, "off"), ext = child(xfrm, "ext");
  const chOff = child(xfrm, "chOff"), chExt = child(xfrm, "chExt");
  const offX = finNum(numOr(attrOf(off, "x"), 0)), offY = finNum(numOr(attrOf(off, "y"), 0));
  const extCx = finNum(numOr(attrOf(ext, "cx"), 0)), extCy = finNum(numOr(attrOf(ext, "cy"), 0));
  const chX = finNum(numOr(attrOf(chOff, "x"), 0)), chY = finNum(numOr(attrOf(chOff, "y"), 0));
  const chCx = finNum(numOr(attrOf(chExt, "cx"), 0)), chCy = finNum(numOr(attrOf(chExt, "cy"), 0));
  let sx = chCx > 0 && extCx > 0 ? extCx / chCx : 1;
  let sy = chCy > 0 && extCy > 0 ? extCy / chCy : 1;
  if (!Number.isFinite(sx) || sx <= 0) sx = 1;
  if (!Number.isFinite(sy) || sy <= 0) sy = 1;
  const self: Xf = { a: offX - chX * sx, b: offY - chY * sy, sx, sy };
  if (!outer) return self;
  return { a: outer.a + outer.sx * self.a, b: outer.b + outer.sy * self.b, sx: outer.sx * self.sx, sy: outer.sy * self.sy };
}
function applyXf(sh: OfficeShape, xf: Xf | undefined): OfficeShape {
  if (!xf) return sh;
  sh.x = finNum(xf.a + sh.x * xf.sx);
  sh.y = finNum(xf.b + sh.y * xf.sy);
  sh.cx = finNum(sh.cx * xf.sx);
  sh.cy = finNum(sh.cy * xf.sy);
  return sh;
}

const PPTX_GROUP_MAX_DEPTH = 8; // 组嵌套上限(防环/防爆栈)

/** spTree/grpSp 子节点 → 扁平形状数组。grpSp 按 grpSpPr/a:xfrm 递归展开成**绝对定位** shape(深度上限 8)。 */
function pptxShapeList(host: XNode, rels: Record<string, string>, baseDir: string, docPath: string, pid: string, out: OfficeShape[], depth = 0, nodes?: XNode[], ctx?: ShapeCtx & PptxParts, xf?: Xf): OfficeShape[] {
  /** nodes(可选,2026-10-29 文本回写用):与 out **同序**记录形状对应的 XML 节点,
   *  保证 shapes[i] ↔ nodes[i] 一一对应(rewriteOfficeText 靠它定位第 i 个形状的文本节点)。 */
  const push = (sh: OfficeShape, node: XNode): void => {
    applyXf(sh, xf);
    out.push(sh);
    if (nodes) nodes.push(node);
  };
  for (const k of host.kids) {
    if (typeof k === "string") continue;
    const tag = localName(k.name);
    if (tag === "sp") push(pptxSp(k, ctx), k);
    else if (tag === "pic") push(pptxPic(k, rels, baseDir, docPath, pid), k);
    else if (tag === "graphicFrame") push(pptxGraphicFrame(k, rels, baseDir, docPath, pid, ctx), k);
    else if (tag === "cxnSp") { // 连线:按形状处理(几何 + 填充;线段粗细不进契约)
      const spPr = child(k, "spPr");
      const sh: OfficeShape = { type: "shape", ...pptxXfrm(spPr) };
      const fill = pptxFill(spPr, ctx?.theme);
      if (fill !== undefined) sh.fill = fill;
      else if (ctx?.bg) sh.fill = ctx.bg;
      const stroke = lineStroke(spPr, ctx?.theme);
      if (stroke) sh.stroke = stroke;
      push(sh, k);
    } else if (tag === "grpSp") { // 组合:递归展平(AST v2),坐标按 grpSpPr/a:xfrm 变换到绝对坐标
      if (depth >= PPTX_GROUP_MAX_DEPTH) continue;
      pptxShapeList(k, rels, baseDir, docPath, pid, out, depth + 1, nodes, ctx, groupXf(child(k, "grpSpPr"), xf));
    } else if (tag === "AlternateContent") { // mc:AlternateContent:只认 Fallback(与 Choice 同几何,兼容分支)
      const fb = child(k, "Fallback");
      if (fb && depth < 4) pptxShapeList(fb, rels, baseDir, docPath, pid, out, depth + 1, nodes, ctx, xf);
    }
    // 其余(nvGrpSpPr/grpSpPr/extLst/... )忽略
  }
  return out;
}

/** 主题部件(ppt/theme/themeN.xml)→ clrScheme 表。sysClr 取 lastClr(a:sysClr val="windowText" 只有 lastClr 是色值)。 */
function parseThemeXml(xml: string | undefined): ThemeColors {
  const out: ThemeColors = {};
  if (!xml) return out;
  const cs = findFirst(parseXmlTree(xml), "clrScheme");
  if (!cs) return out;
  for (const k of cs.kids) {
    if (typeof k === "string") continue;
    const name = localName(k.name);                 // dk1/lt1/dk2/lt2/accent1..6/hlink/folHlink
    const hex = firstColorChild(k, undefined);
    if (hex) out[name] = hex;
  }
  return out;
}

/** p:cSld/p:bg → 底色(bgPr 的 solidFill/gradFill 纯色部分;bgRef 走 schemeClr 索引近似)。 */
function pptxBgColor(root: XNode | undefined, theme?: ThemeColors): string | undefined {
  const cSld = root ? findFirst(root, "cSld") : undefined;
  const bg = child(cSld, "bg");
  if (!bg) return undefined;
  const bgPr = child(bg, "bgPr");
  if (bgPr) {
    const c = solidFillColor(bgPr, theme);
    if (c) return c;
    const grad = gradientFill(bgPr, theme);
    const first = grad && grad.stops[0];
    if (first) return first.color;
    return undefined;
  }
  const bgRef = child(bg, "bgRef");                 // 主题背景引用:靠 schemeClr 近似(不做完整 style matrix)
  return firstColorChild(bgRef, theme);
}

async function parsePptx(zip: JSZip, docPath: string, pid: string): Promise<OfficeAst> {
  let widthEmu = 9144000; // 缺 sldSz 时的 4:3 默认(10in × 7.5in)
  let heightEmu = 6858000;
  const presXml = await readZipText(zip, "ppt/presentation.xml");
  if (presXml) {
    const sz = findFirst(parseXmlTree(presXml), "sldSz");
    const cx = numOr(attrOf(sz, "cx"), 0);
    const cy = numOr(attrOf(sz, "cy"), 0);
    if (cx > 0) widthEmu = cx;
    if (cy > 0) heightEmu = cy;
  }
  const parts: { part: string; num: number }[] = [];
  for (const name of Object.keys(zip.files)) {
    const m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
    if (m && m[1]) parts.push({ part: name, num: Number(m[1]) });
  }
  parts.sort((a, b) => a.num - b.num);

  // ── 主题/母版/版式(AST v2 板节点 02):按需读 + 缓存;缺任何一环都只是「继承不到」,不抛错 ──
  const cache = new Map<string, string | undefined>();
  const readCached = async (part: string): Promise<string | undefined> => {
    if (cache.has(part)) return cache.get(part);
    const v = await readZipText(zip, part);
    cache.set(part, v);
    return v;
  };
  const rootCache = new Map<string, XNode | undefined>();
  const rootOf = async (part: string): Promise<XNode | undefined> => {
    if (rootCache.has(part)) return rootCache.get(part);
    const xml = await readCached(part);
    const r = xml ? parseXmlTree(xml) : undefined;
    rootCache.set(part, r);
    return r;
  };
  const themeCache = new Map<string, ThemeColors>();
  const themeOf = async (part: string): Promise<ThemeColors> => {
    const hit = themeCache.get(part);
    if (hit) return hit;
    const t = parseThemeXml(await readCached(part));
    themeCache.set(part, t);
    return t;
  };
  /** 按 rels 里的 Type 后缀找目标 part(如 "/slideLayout"、"/theme"),读不到就返回 undefined。 */
  const relTargetOf = async (part: string, typeSuffix: string): Promise<string | undefined> => {
    const slash = part.lastIndexOf("/");
    const dir = slash < 0 ? "" : part.slice(0, slash);
    const base = slash < 0 ? part : part.slice(slash + 1);
    const xml = await readZipText(zip, dir + "/_rels/" + base + ".rels");
    if (!xml) return undefined;
    for (const rel of findAll(parseXmlTree(xml), "Relationship")) {
      const type = String(attrOf(rel, "Type") || "").toLowerCase();
      const target = attrOf(rel, "Target");
      if (!target || type.indexOf(typeSuffix.toLowerCase()) < 0) continue;
      return resolvePart(dir, target);
    }
    return undefined;
  };
  const fileList = Object.keys(zip.files);
  const firstOf = (re: RegExp): string | undefined => fileList.filter((n) => re.test(n)).sort()[0];

  const slides: OfficeSlide[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    const xml = await readZipText(zip, p.part);
    const shapes: OfficeShape[] = [];
    if (xml) {
      const root = parseXmlTree(xml);
      const spTree = findFirst(root, "spTree");
      const slideDir = "ppt/slides";
      const relsXml = await readZipText(zip, "ppt/slides/_rels/" + p.part.slice("ppt/slides/".length) + ".rels");
      const rels = pptxRelMap(relsXml);
      const layoutPart = await relTargetOf(p.part, "/slideLayout") || firstOf(/^ppt\/slideLayouts\/slideLayout\d+\.xml$/);
      const masterPart = (layoutPart ? await relTargetOf(layoutPart, "/slideMaster") : undefined)
        || firstOf(/^ppt\/slideMasters\/slideMaster\d+\.xml$/);
      const themePart = (masterPart ? await relTargetOf(masterPart, "/theme") : undefined)
        || (layoutPart ? await relTargetOf(layoutPart, "/theme") : undefined)
        || firstOf(/^ppt\/theme\/theme\d+\.xml$/) || "ppt/theme/theme1.xml";
      const theme = await themeOf(themePart);
      const layoutRoot = layoutPart ? await rootOf(layoutPart) : undefined;
      const masterRoot = masterPart ? await rootOf(masterPart) : undefined;
      const bg = pptxBgColor(layoutRoot, theme) || pptxBgColor(masterRoot, theme);
      const inh = new Map<string, { szPt?: number; align?: "l" | "c" | "r" }>();
      phInherit(masterRoot, inh);                     // 先母版,再版式(版式更具体,覆盖母版)
      phInherit(layoutRoot, inh);
      // 部件预读:slide rels 指向的 chart / diagram XML(同步递归里查表,不再回 zip)
      const partsXml: Record<string, string> = {};
      for (const rid of Object.keys(rels)) {
        const target = rels[rid];
        if (!target) continue;
        const part = resolvePart(slideDir, target);
        if (!/^ppt\/(?:charts|diagrams)\/[^/]+\.xml$/.test(part)) continue;
        const txt = await readCached(part);
        if (txt) partsXml[part] = txt;
      }
      if (spTree) {
        pptxShapeList(spTree, rels, slideDir, docPath, pid, shapes, 0, undefined, { theme, bg, inh, parts: partsXml }, undefined);
      }
    }
    slides.push({ index: i + 1, widthEmu, heightEmu, shapes }); // index 从 1 起(与文件名序号一致)
  }
  return { kind: "pptx", slides };
}

// ───────────────────────── DOCX ─────────────────────────
function docxAlign(v: string | undefined): "left" | "center" | "right" | undefined {
  const s = String(v || "").toLowerCase();
  if (s === "left" || s === "start" || s === "both" || s === "distribute") return "left";
  if (s === "center") return "center";
  if (s === "right" || s === "end") return "right";
  return undefined;
}
/** 单个 w:r → run(w:t 文本;w:br/w:tab 保换行缩进;w:rPr 出 b/i/u/sz/color)。
 *  w:delText(被删除的原文)照样产出文本,由调用方打 revised:"del" —— 不静默丢(板节点 08 硬要求)。
 *  域代码 w:instrText 不产出。 */
function docxRun(r: XNode, revised?: "ins" | "del"): OfficeRun | null {
  let text = "";
  let sawDelText = false;
  for (const k of r.kids) {
    if (typeof k === "string") continue;
    const tag = localName(k.name);
    if (tag === "t") text += textOf(k);
    else if (tag === "delText") { text += textOf(k); sawDelText = true; }
    else if (tag === "br" || tag === "cr") text += "\n";
    else if (tag === "tab") text += "\t";
    else if (tag === "noBreakHyphen") text += "-";
  }
  if (!text) return null;
  const out: OfficeRun = { text };
  const rev = revised || (sawDelText ? "del" : undefined);
  if (rev) out.revised = rev;
  const rPr = child(r, "rPr");
  if (rPr) {
    if (flagOn(child(rPr, "b"))) out.bold = true;
    if (flagOn(child(rPr, "i"))) out.italic = true;
    if (flagOn(child(rPr, "u"))) out.underline = true;
    const half = numOr(attrOf(child(rPr, "sz"), "val"), 0);
    if (half > 0) out.sizePt = half / 2; // 半磅 → pt
    const c = normColor(attrOf(child(rPr, "color"), "val"));
    if (c) out.color = c;
  }
  return out;
}
/** 段落内收集 run:超链/内容控件(sdtContent)递归;
 *  插入修订(w:ins/w:moveTo)→ revised:"ins";删除修订(w:del/w:moveFrom)→ revised:"del"(文本来自 w:delText)。 */
function docxRuns(n: XNode, out: OfficeRun[], depth = 0, revised?: "ins" | "del"): void {
  if (depth > 8) return;
  for (const k of n.kids) {
    if (typeof k === "string") continue;
    const tag = localName(k.name);
    if (tag === "r") { const r = docxRun(k, revised); if (r) out.push(r); }
    else if (tag === "ins" || tag === "moveTo") docxRuns(k, out, depth + 1, revised === "del" ? "del" : "ins");
    else if (tag === "del" || tag === "moveFrom") docxRuns(k, out, depth + 1, "del");
    else if (tag === "hyperlink" || tag === "smartTag" || tag === "fldSimple") docxRuns(k, out, depth + 1, revised);
    else if (tag === "sdt") { const c = child(k, "sdtContent"); if (c) docxRuns(c, out, depth + 1, revised); }
    // w:pPr / w:bookmarkStart / w:commentRangeStart ... 一律跳过
  }
}
function docxPara(p: XNode): OfficeBlock {
  const out: OfficeBlock = { type: "p" };
  const pPr = child(p, "pPr");
  const styleVal = attrOf(child(pPr, "pStyle"), "val");
  if (styleVal) out.style = styleVal;
  const al = docxAlign(attrOf(child(pPr, "jc"), "val"));
  if (al) out.align = al;
  const numPr = child(pPr, "numPr");
  if (numPr) {
    const ilvl = attrOf(child(numPr, "ilvl"), "val");
    out.listLevel = ilvl === undefined ? 0 : Math.max(0, Math.trunc(numOr(ilvl, 0)));
  }
  const runs: OfficeRun[] = [];
  docxRuns(p, runs);
  out.runs = runs;
  return out;
}
function docxTable(tbl: XNode): OfficeBlock {
  const rows: string[][] = [];
  for (const tr of children(tbl, "tr")) {
    const cells: string[] = [];
    for (const tc of children(tr, "tc")) {
      const paras = children(tc, "p");
      const texts: string[] = [];
      for (const p of paras) texts.push(textOf(p));
      if (!texts.length) { // tc 里可能被 w:sdt 包一层
        const sdt = child(tc, "sdt");
        const content = sdt ? child(sdt, "sdtContent") : undefined;
        if (content) for (const p of children(content, "p")) texts.push(textOf(p));
      }
      cells.push(texts.join("\n").replace(/\s+/g, " ").trim());
    }
    rows.push(cells);
  }
  return { type: "table", rows };
}
/** word/comments.xml → {id: "作者: 内容"}。缺 author 只留内容;缺注释部件 → 空表(不抛错)。 */
function docxComments(xml: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!xml) return out;
  for (const c of findAll(parseXmlTree(xml), "comment")) {
    const id = String(attrOf(c, "id") || "").trim();
    if (!id) continue;
    const author = String(attrOf(c, "author") || "").trim();
    const text = textOf(c).replace(/\s+/g, " ").trim();
    if (!text) continue;
    out[id] = author ? author + ": " + text : text;
  }
  return out;
}
/** 段落内 commentRangeStart 包住的批注 id(按文中出现顺序,去重)。 */
function docxParagraphCommentIds(p: XNode): string[] {
  const ids: string[] = [];
  for (const n of findAll(p, "commentRangeStart")) {
    const id = String(attrOf(n, "id") || "").trim();
    if (id && ids.indexOf(id) < 0) ids.push(id);
  }
  return ids;
}

/** body 顺序遍历:块级元素只认 w:p / w:tbl / w:sdt;分节/页眉页脚/批注/修订不产出节点。
 *  nodes(可选,2026-10-29 文本回写用):与 out 同序记录块对应的 XML 节点(w:p / w:tbl)。
 *  cmts(可选,AST v2):批注 id → "作者: 内容",命中的段落挂 block.comments(string[])。 */
function docxBlocksFromBody(body: XNode, nodes?: XNode[], cmts?: Record<string, string>): OfficeBlock[] {
  const out: OfficeBlock[] = [];
  const walk = (host: XNode, depth = 0): void => {
    if (depth > 6) return;
    for (const k of host.kids) {
      if (typeof k === "string") continue;
      const tag = localName(k.name);
      if (tag === "p") {
        const blk = docxPara(k);
        if (cmts) {
          const list: string[] = [];
          for (const id of docxParagraphCommentIds(k)) {
            const s = cmts[id];
            if (s) list.push(s);
          }
          if (list.length) blk.comments = list;
        }
        out.push(blk);
        if (nodes) nodes.push(k);
      }
      else if (tag === "tbl") { out.push(docxTable(k)); if (nodes) nodes.push(k); }
      else if (tag === "sdt") { const c = child(k, "sdtContent"); if (c) walk(c, depth + 1); }
      else if (tag === "customXml") walk(k, depth + 1);
      // w:sectPr / w:bookmarkStart / w:proofErr / w:commentRangeStart ... 跳过
    }
  };
  walk(body);
  return out;
}

/** 页眉/页脚/脚注部件 → OfficeBlock[](与 body 同一套段落/表格解析,只是不进 blocks)。
 *  footnotes.xml/endnotes.xml 是多条 w:footnote 并列,各自当一条段落流解析。 */
function docxBlocksOfPart(root: XNode | undefined, partRootName: string): OfficeBlock[] {
  if (!root) return [];
  const host = child(root, partRootName);
  if (host) {
    if (partRootName === "footnotes" || partRootName === "endnotes") {
      const item = partRootName === "footnotes" ? "footnote" : "endnote";
      const out: OfficeBlock[] = [];
      for (const fn of children(host, item)) out.push(...docxBlocksFromBody(fn));
      return out;
    }
    return docxBlocksFromBody(host);
  }
  return docxBlocksFromBody(root);
}
/** zip 里某前缀下的所有 part(word/header1.xml、word/footer2.xml),按文件名数字升序。 */
function docxPartsOf(zip: JSZip, re: RegExp): string[] {
  return Object.keys(zip.files).filter((n) => re.test(n)).sort((a, b) => {
    const na = Number((/(\d+)\.xml$/.exec(a) || [])[1] || 0);
    const nb = Number((/(\d+)\.xml$/.exec(b) || [])[1] || 0);
    return na - nb;
  });
}

async function parseDocx(zip: JSZip): Promise<OfficeAst> {
  const xml = await readZipText(zip, "word/document.xml");
  if (!xml) throw new Error("不是有效的 OOXML 文件(缺少 word/document.xml)");
  const root = parseXmlTree(xml);
  const body = findFirst(root, "body");
  const cmts = docxComments(await readZipText(zip, "word/comments.xml"));
  const out: OfficeAst = { kind: "docx", blocks: body ? docxBlocksFromBody(body, undefined, cmts) : [] };
  // AST v2(板节点 08):页眉/页脚/脚注**不进 blocks**(否则 blockIndex 漂移,回写与既有测试全红)
  const headers: OfficeBlock[] = [];
  for (const part of docxPartsOf(zip, /^word\/header\d*\.xml$/)) {
    headers.push(...docxBlocksOfPart(parseXmlTree((await readZipText(zip, part)) || "<root/>"), "hdr"));
  }
  const footers: OfficeBlock[] = [];
  for (const part of docxPartsOf(zip, /^word\/footer\d*\.xml$/)) {
    footers.push(...docxBlocksOfPart(parseXmlTree((await readZipText(zip, part)) || "<root/>"), "ftr"));
  }
  const footnotes: OfficeBlock[] = [];
  const fnXml = await readZipText(zip, "word/footnotes.xml");
  if (fnXml) footnotes.push(...docxBlocksOfPart(parseXmlTree(fnXml), "footnotes"));
  if (headers.length) out.headers = headers;
  if (footers.length) out.footers = footers;
  if (footnotes.length) out.footnotes = footnotes;
  return out;
}

// ───────────────────────── 共用 ─────────────────────────
async function readZipText(zip: JSZip, path: string): Promise<string | undefined> {
  const f = zip.file(path);
  if (!f) return undefined;
  try {
    const s = await f.async("string");
    return typeof s === "string" ? s : undefined;
  } catch { return undefined; }
}

// ───────────────────────── 文本级回写(2026-10-29 板节点「OOXML 文本回写」P2) ─────────────────────────
/** 一条文本编辑指令(下标语义与 parseOffice 输出一致;整段替换,不保留 run 级差异)。 */
export interface OfficeTextEdit {
  slideIndex?: number;     // pptx:第几页(1-based,与 OfficeAst.slides[].index 一致)
  shapeIndex?: number;     // pptx:该页 shapes 数组下标(与 parseOffice 输出一致)
  blockIndex?: number;     // docx:blocks 数组下标
  text: string;            // 新文本(整段替换)
}

/** XML 文本节点五字符转义(写回前必做,否则 & < > 会破 XML)。 */
const XML_TEXT_ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" };
function escapeXmlText(s: string): string {
  return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, (c) => XML_TEXT_ESC[c] ?? c);
}

interface TextSpan { start: number; end: number; text: string }

/** 从后往前套用替换区间(前面的下标因此不会失效)。 */
function applySpans(src: string, spans: TextSpan[]): string {
  const sorted = spans.slice().sort((a, b) => b.start - a.start);
  let out = src;
  for (const s of sorted) out = out.slice(0, s.start) + s.text + out.slice(s.end);
  return out;
}
/** 「首节点吃全部文本,其余清空」——整段替换语义(text 里的换行原样留在首个 w:t/a:t 内)。 */
function spansForTextNodes(tNodes: XNode[], text: string): TextSpan[] {
  const out: TextSpan[] = [];
  let first = true;
  for (const t of tNodes) {
    if (t.contentAt === undefined || t.contentEnd === undefined) continue;
    out.push({ start: t.contentAt, end: t.contentEnd, text: first ? escapeXmlText(text) : "" });
    first = false;
  }
  return out;
}
/** pptx 幻灯片 part 清单(与 parsePptx 同序:按文件名数字升序,index 从 1 起)。 */
function pptxSlidePartsOf(zip: JSZip): { part: string; num: number }[] {
  const parts: { part: string; num: number }[] = [];
  for (const name of Object.keys(zip.files)) {
    const m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
    if (m && m[1]) parts.push({ part: name, num: Number(m[1]) });
  }
  parts.sort((a, b) => a.num - b.num);
  return parts;
}

/**
 * 文本级回写(只改文本节点的字符区间,**不重新序列化整棵 XML**)。
 *
 * 实现:zip 解包 → 读目标 part 的**原始字符串**(ppt/slides/slideN.xml 或 word/document.xml)
 * → 用与 parseOffice 同源的遍历(pptxShapeList / docxBlocksFromBody 的 nodes 收集口)定位第 N 个
 * shape/block → 只把该 shape/block 下 `<a:t>` / `<w:t>` 的内容区间替换成转义后的新文本
 * → `zip.file(part, newXml)` **只覆盖这一个条目** → generateAsync 重新打包。
 *
 * 字节层面的如实口径:**zip 重新打包后整体字节必然与原文件不同**(DEFLATE 压缩流、条目顺序/时间戳
 * 都会变),所以验收标准是「其它条目的**解压后内容**逐字不变」,不是「zip 字节不变」。
 * 本函数只改被编辑 part 的文本节点区间,其余 part 的解压内容天然一致。
 *
 * 定位失败(下标越界 / 该 shape 没有文本节点 / 表格块 / 找不到 body)一律抛明确错误,
 * 不静默返回原 buf(否则上层会以为"保存成功但其实没改")。
 */
export async function rewriteOfficeText(buf: Buffer, ext: ".pptx" | ".docx", edits: OfficeTextEdit[]): Promise<Buffer> {
  const e = String(ext || "").toLowerCase();
  if (!OFFICE_DOC_EXT.has(e)) throw new Error("不支持的文档类型:仅 .pptx/.docx 可回写");
  if (!buf || buf.length === 0) throw new Error("不是有效的 OOXML 文件");
  if (buf.length > OFFICE_MAX_BYTES) throw new Error("文件过大(>128MB),不支持回写");
  if (!Array.isArray(edits) || edits.length === 0) throw new Error("没有要写入的文本改动");
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(buf); } catch { throw new Error("不是有效的 OOXML 文件"); }

  /** part → 该 part 上待替换的字符区间(同一 part 的多条 edit 合并成一次字符串改写)。 */
  const perPart = new Map<string, TextSpan[]>();
  const addSpan = (part: string, spans: TextSpan[]): void => {
    if (!spans.length) return;
    const cur = perPart.get(part);
    if (cur) cur.push(...spans); else perPart.set(part, spans.slice());
  };

  if (e === ".pptx") {
    if (!zip.file("ppt/presentation.xml") && !pptxSlidePartsOf(zip).length) {
      throw new Error("不是有效的 OOXML 文件(缺少 ppt/presentation.xml)");
    }
    const parts = pptxSlidePartsOf(zip);
    // 按页归集:同一页的多条 edit 只读/只写一次
    const bySlide = new Map<number, OfficeTextEdit[]>();
    for (const ed of edits) {
      const si = Number(ed.slideIndex);
      if (!Number.isInteger(si) || si < 1) throw new Error("ppt 回写缺少合法的 slideIndex(1-based)");
      if (si > parts.length) throw new Error("幻灯片下标越界:第 " + si + " 页不存在(共 " + parts.length + " 页)");
      const arr = bySlide.get(si);
      if (arr) arr.push(ed); else bySlide.set(si, [ed]);
    }
    for (const [si, list] of bySlide) {
      const p = parts[si - 1];
      if (!p) throw new Error("幻灯片下标越界:第 " + si + " 页不存在(共 " + parts.length + " 页)");
      const xml = await readZipText(zip, p.part);
      if (xml === undefined) throw new Error("包内缺少 " + p.part);
      const root = parseXmlCore(xml, true);
      const spTree = findFirst(root, "spTree");
      const shapes: OfficeShape[] = [];
      const nodes: XNode[] = [];
      if (spTree) pptxShapeList(spTree, {}, "ppt/slides", "", "", shapes, 0, nodes);
      const spans: TextSpan[] = [];
      for (const ed of list) {
        const idx = Number(ed.shapeIndex);
        if (!Number.isInteger(idx) || idx < 0) throw new Error("ppt 回写缺少合法的 shapeIndex(该页 shapes 下标)");
        if (idx >= nodes.length) throw new Error("shapeIndex 越界:第 " + si + " 页没有下标 " + idx + " 的形状(共 " + nodes.length + " 个)");
        const node = nodes[idx];
        if (!node) throw new Error("shapeIndex 越界:第 " + si + " 页没有下标 " + idx + " 的形状(共 " + nodes.length + " 个)");
        const txBody = child(node, "txBody");
        // 只有 a:txBody(真正的文本框)能整段替换。表格(graphicFrame/a:tbl)与图表/图片没有 txBody,
        // 里面的 a:t 是**单元格文本**——按"首节点吃全部文本"写会毁掉表格结构,故明确拒绝(不猜)。
        if (!txBody) {
          throw new Error("第 " + si + " 页下标 " + idx + " 的形状不是文本框(" + localName(node.name) + "):表格/图表/图片不支持文本回写");
        }
        const tNodes = findAll(txBody, "t");
        if (!tNodes.length) {
          throw new Error("第 " + si + " 页下标 " + idx + " 的形状没有可编辑文本节点(空文本框)");
        }
        // 多段(a:p)且行数与段数一致时,逐段分发换行(保住 PPT 里的换行语义);否则整段塞首节点
        const paras = children(txBody, "p");
        const lines = String(ed.text ?? "").split("\n");
        const perParT = paras.map((pa) => findAll(pa, "t"));
        if (paras.length > 1 && lines.length === paras.length && perParT.every((ts) => ts.length > 0)) {
          for (let i = 0; i < paras.length; i++) spans.push(...spansForTextNodes(perParT[i] || [], lines[i] ?? ""));
        } else {
          spans.push(...spansForTextNodes(tNodes, String(ed.text ?? "")));
        }
      }
      addSpan(p.part, spans);
    }
  } else {
    if (!zip.file("word/document.xml")) throw new Error("不是有效的 OOXML 文件(缺少 word/document.xml)");
    const part = "word/document.xml";
    const xml = await readZipText(zip, part);
    if (xml === undefined) throw new Error("包内缺少 " + part);
    const root = parseXmlCore(xml, true);
    const body = findFirst(root, "body");
    if (!body) throw new Error("word/document.xml 缺少 body");
    const nodes: XNode[] = [];
    const blocks = docxBlocksFromBody(body, nodes);
    const spans: TextSpan[] = [];
    for (const ed of edits) {
      const idx = Number(ed.blockIndex);
      if (!Number.isInteger(idx) || idx < 0) throw new Error("docx 回写缺少合法的 blockIndex(blocks 下标)");
      if (idx >= nodes.length) throw new Error("blockIndex 越界:文档没有下标 " + idx + " 的块(共 " + nodes.length + " 块)");
      const node = nodes[idx];
      if (!node) throw new Error("blockIndex 越界:文档没有下标 " + idx + " 的块(共 " + nodes.length + " 块)");
      if (localName(node.name) !== "p") {
        const kind = blocks[idx] ? blocks[idx]!.type : "unknown";
        throw new Error("下标 " + idx + " 的块不是段落(" + kind + "):表格/其它块暂不支持文本回写");
      }
      const tNodes = findAll(node, "t");
      if (!tNodes.length) throw new Error("下标 " + idx + " 的段落没有可编辑文本节点(空段落)");
      spans.push(...spansForTextNodes(tNodes, String(ed.text ?? "")));
    }
    addSpan(part, spans);
  }

  if (!perPart.size) throw new Error("没有定位到任何可写文本节点");
  for (const [part, spans] of perPart) {
    const xml = await readZipText(zip, part);
    if (xml === undefined) throw new Error("包内缺少 " + part);
    // 只覆盖这一个条目:其它条目的解压后内容不受影响(zip 整体字节会变,见函数头注释)
    zip.file(part, applySpans(xml, spans));
  }
  return await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

