/**
 * 办公视觉机器 QA(Office Visual QA,2026-11):把「这一页长什么样」压成一组可判定的规则。
 * 为什么需要一层纯逻辑的机器体检:
 * - 办公文档(PPT/Word/PDF)交付前的视觉缺陷——文字压字/文字压图、元素出界被裁切、浅灰字看不清、
 * 标题和正文一样大、整页几乎空白、图片糊成马赛克、左边缘参差不齐——恰恰是人眼评审最容易漏掉、
 * 用户第一眼就会看到的那类问题。它们在渲染后的几何数据上是**可判定**的:一旦能用数字判定,
 * 就能在渲染完、交付前自动拦下来,不必等投诉。
 * - 反过来,机器永远读不懂「这里看起来就是故意的」。所以本模块只回答「哪里可疑、多可疑」
 * (issues + severity + score + 修复提示),不下「必须改」的命令;人工/多模态复核走另一路
 * (buildReviewRequest 只组装评审请求,不假装评审已经发生)。
 * - 结论必须是确定性的:同一份几何数据跑两次要给同一个 score、同一份 issue 顺序。否则 CLI
 * 与网关各算一次就会互相打架,也无法落盘做前后比对。因此:不读时间、不读随机、不依赖对象
 * 属性遍历顺序;浮点先四舍五入到 2 位小数再比较;issue 排序键固定。
 * 不变量:
 * 1. 零 IO:不读文件/网络/环境/时钟;页面几何与 PNG 路径全部由入参给。
 * 2. 不 throw:非法入参折叠成 VIS_INVALID,空稿件折叠成 VIS_EMPTY_DECK——两者都是**结论**而不是异常,
 * 因为「用户上传了一个坏文件」是正常业务分支,不该让上层用 try/catch 接。
 * 3. 不改入参:输出全部新建对象;同一输入永远产出同一输出(可直接 JSON 深比较)。
 * 4. 阈值一律走 thresholds:VIS_DEFAULT_THRESHOLDS 只是默认值,调用方(opts)可逐项覆盖,
 * 规则实现里不得再出现写死的数字(否则「可覆盖」就成了假承诺)。
 * 5. 缺数据不瞎猜:没有 fontSizePt 的文本不参与 VIS_FONT_MIN;没有 imagePx 的图片不参与
 * VIS_IMAGE_DPI;颜色解析失败的那一条直接跳过。宁可漏报,不可编造缺陷——假阳性会让
 * 用户开始忽略整份报告。
 * 6. 稳定码顺序固定(VIS_QA_CODES),便于自动化按码断言;ruleId 与码同名前缀 VIS_,
 * 但**不是**同一张表:码是「这一份文件被判成什么」,规则是「哪条体检项」。
 * 单位约定:几何一律 pt(1pt = 1/72 in),原点在页面左上角、y 向下;imagePx 是图片像素。
 */
export const VIS_QA_VERSION = 1;

/** 稳定码:一份稿件的最终结论(只这 5 个,顺序固定)。 */
export const VIS_OK = "VIS_OK";
export const VIS_INVALID = "VIS_INVALID";
export const VIS_EMPTY_DECK = "VIS_EMPTY_DECK";
export const VIS_FAIL = "VIS_FAIL";
export const VIS_WARN = "VIS_WARN";

/** 全部稳定码(固定顺序:通过 → 非法 → 空稿件 → 失败 → 警告)。 */
export const VIS_QA_CODES: readonly string[] = [VIS_OK, VIS_INVALID, VIS_EMPTY_DECK, VIS_FAIL, VIS_WARN];

/** 规则 id:与稳定码同前缀,便于日志里一眼区分「结论」与「规则」。 */
const RULE_EMPTY_PAGE = "VIS_EMPTY_PAGE";
const RULE_OFF_CANVAS = "VIS_OFF_CANVAS";
const RULE_OVERLAP = "VIS_OVERLAP";
const RULE_FONT_MIN = "VIS_FONT_MIN";
const RULE_HIERARCHY = "VIS_HIERARCHY";
const RULE_CONTRAST = "VIS_CONTRAST";
const RULE_ACCENT_SHARE = "VIS_ACCENT_SHARE";
const RULE_WHITESPACE = "VIS_WHITESPACE";
const RULE_IMAGE_DPI = "VIS_IMAGE_DPI";
const RULE_ALT_MISSING = "VIS_ALT_MISSING";
const RULE_GRID_MISALIGN = "VIS_GRID_MISALIGN";

type Severity = "p0" | "p1" | "p2";

/**
 * 规则目录(p0=必改/p1=应改/p2=建议)。顺序 = 声明顺序,与报告里的排序无关(排序另有规则);
 * 这里的顺序只表达「严重性递减的大致阅读顺序」,便于面板原样渲染。
 */
export const VIS_RULES: readonly { id: string; severity: Severity; title: string }[] = [
  { id: RULE_EMPTY_PAGE, severity: "p0", title: "空页:整页没有任何可见文本/图形/图片" },
  { id: RULE_OFF_CANVAS, severity: "p1", title: "元素越界:超出页面边界超过容差(会被裁切)" },
  { id: RULE_OVERLAP, severity: "p1", title: "元素重叠:非包含关系的交叠面积超过较小者占比上限" },
  { id: RULE_FONT_MIN, severity: "p1", title: "字号过小:低于最小正文字号,打印/投影不可读" },
  { id: RULE_HIERARCHY, severity: "p2", title: "层级不清:标题字号不足正文中位字号的倍数" },
  { id: RULE_CONTRAST, severity: "p1", title: "对比度不足:文本与背景低于 WCAG 阈值" },
  { id: RULE_ACCENT_SHARE, severity: "p2", title: "强调色过量:高饱和填充占比或色相数超上限" },
  { id: RULE_WHITESPACE, severity: "p2", title: "留白异常:整页过空或过挤(确定性网格采样)" },
  { id: RULE_IMAGE_DPI, severity: "p2", title: "图片分辨率不足:有效 DPI 低于下限" },
  { id: RULE_ALT_MISSING, severity: "p1", title: "图片缺替代文本:无障碍与检索都会缺信息" },
  { id: RULE_GRID_MISALIGN, severity: "p2", title: "版式不齐:文本块左边缘偏离网格的占比过高" },
];

/** RGB 三元组(0..255 整数)。 */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** 矩形:单位 pt,页面左上原点。 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 图片像素尺寸(用于反推有效 DPI)。 */
export interface SizePx {
  w: number;
  h: number;
}

/** 一个可见元素。text/fontSizePt 只对 kind==="text" 有意义;imagePx/altText 只对 kind==="image" 有意义。 */
export interface Shape {
  kind: "text" | "image" | "shape";
  rect: Rect;
  text?: string;
  fontSizePt?: number;
  bold?: boolean;
  color?: string;
  fill?: string;
  imagePx?: SizePx;
  altText?: string;
  isTitle?: boolean;
}

/** 一页的几何数据(index 是排版意义上的页码,review 输出直接用它)。 */
export interface PageGeometry {
  index: number;
  width: number;
  height: number;
  shapes: Shape[];
 /** 页面底色("#rrggbb",来自 slide bg 部件)。缺省不是白:深色底下的浅色字在纯白假设下会被误判低对比,
 * 所以解析层能拿到就必须给;拿不到才退 "-" 与纯白假设。 */
  background?: string;
}

/** 全部阈值(可被 opts 覆盖;默认值见 VIS_DEFAULT_THRESHOLDS)。 */
export interface VisThresholds {
  minFontPt: number;
  titleRatio: number;
  largeFontPt: number;
  boldLargeFontPt: number;
  minContrast: number;
  minContrastLarge: number;
  maxOverlapShare: number;
  offCanvasTolerancePt: number;
  accentShareMaxPct: number;
  hueMax: number;
  whitespaceMaxPct: number;
  whitespaceMinPct: number;
  minImageDpi: number;
  gridIn: number;
  gridToleranceIn: number;
  gridMisalignShareMaxPct: number;
}

/** 默认阈值。顺序与 VisThresholds 一致,值单位:pt / 倍 / 比值 / % / dpi / in。 */
export const VIS_DEFAULT_THRESHOLDS: Readonly<VisThresholds> = Object.freeze({
  minFontPt: 12,
  titleRatio: 1.6,
  largeFontPt: 18,
  boldLargeFontPt: 14,
  minContrast: 4.5,
  minContrastLarge: 3.0,
  maxOverlapShare: 0.25,
  offCanvasTolerancePt: 1,
  accentShareMaxPct: 20,
  hueMax: 8,
  whitespaceMaxPct: 85,
  whitespaceMinPct: 8,
  minImageDpi: 120,
  gridIn: 0.1,
  gridToleranceIn: 0.06,
  gridMisalignShareMaxPct: 30,
});

/** 一条问题。severity 只有 p0/p1/p2;shapeIndex 缺失表示「页级结论」而不是某个元素。 */
export interface VisIssue {
  ruleId: string;
  severity: Severity;
  page: number;
  shapeIndex?: number;
  detail: string;
  fixHint: string;
}

/** 体检指标(给面板/CLI 直接渲染;数值除 counts 外都保留 2 位小数)。 */
export interface VisMetrics {
  pages: number;
  shapes: number;
  p0: number;
  p1: number;
  p2: number;
  accentSharePct: number;
  hueCount: number;
  whitespacePct: number;
  minFontPt: number | null;
  minContrast: number | null;
  minImageDpi: number | null;
  textBlocks: number;
  gridMisalignSharePct: number;
}

/** 体检报告:ok 只表达「没有 p0/p1」,不表达「完美」;score 是给人看的粗粒度分数。 */
export interface VisReport {
  ok: boolean;
  code: string;
  score: number;
  verdict: "pass" | "warn" | "fail";
  issues: VisIssue[];
  metrics: VisMetrics;
}

/** 逐页复核项:png 缺失时 status 只能是 pending——绝不能假装已经看过图。 */
export interface ReviewPageEntry {
  page: number;
  png?: string;
  status: "ready" | "pending";
}

/** 交给多模态评审的请求(纯数据,不含任何「已评审」语义)。 */
export interface ReviewRequest {
  perPage: ReviewPageEntry[];
  prompt: string;
  machineSummary: string;
  pendingCount: number;
}

/* ------------------------------------------------------------------ *
 * 颜色:解析 / WCAG 相对亮度 / 对比度
 * ------------------------------------------------------------------ */

const HEX_COLOR_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB_FN_COLOR_RE = /^rgb\(\s*(\d{1,3})\s*[\s,]+\s*(\d{1,3})\s*[\s,]+\s*(\d{1,3})\s*\)$/i;

function parseHexColor(body: string): RGB | null {
  const expanded = body.length === 3 ? body.replace(/./g, (ch) => ch + ch) : body;
  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16),
  };
}

/**
 * 解析颜色。支持 `#rgb` / `#rrggbb` / `rrggbb` / `rgb(r,g,b)`(逗号或空格分隔),大小写不敏感。
 * 其他一切(#4 位、rgba、命名色、越界分量、非字符串)→ null。**绝不**猜一个近似色:
 * 猜错会把「对比度不足」判成合格,比不判更糟。
 */
export function parseColor(input: unknown): RGB | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (raw === "") return null;
  const hex = HEX_COLOR_RE.exec(raw);
  if (hex) {
    const body = hex[1];
    if (!body) return null;
    return parseHexColor(body);
  }
  const fn = RGB_FN_COLOR_RE.exec(raw);
  if (fn) {
    const r = Number(fn[1]);
    const g = Number(fn[2]);
    const b = Number(fn[3]);
    if (![r, g, b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) return null;
    return { r, g, b };
  }
  return null;
}

/** sRGB 分量线性化(WCAG 2.x 的定义式,阈值 0.03928 与 2.4 指数都不能「近似」)。 */
function linearizeChannel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 相对亮度:0.2126R + 0.7152G + 0.0722B(系数是人眼锥体敏感度,不是随便配的权重)。 */
export function relativeLuminance(c: RGB): number {
  return 0.2126 * linearizeChannel(c.r) + 0.7152 * linearizeChannel(c.g) + 0.0722 * linearizeChannel(c.b);
}

function toRgb(value: RGB | string): RGB | null {
  if (typeof value === "string") return parseColor(value);
  if (value && typeof value === "object") {
    const { r, g, b } = value;
    if (isFiniteNumber(r) && isFiniteNumber(g) && isFiniteNumber(b)) return { r, g, b };
  }
  return null;
}

/**
 * 对比度 (L1+0.05)/(L2+0.05),L1 为较亮者。任一侧非法 → 返回 1
 * (数学上「无对比度可分」,不会因为解析失败而误判为「对比度很好」)。
 */
export function contrastRatio(a: RGB | string, b: RGB | string): number {
  const ca = toRgb(a);
  const cb = toRgb(b);
  if (!ca || !cb) return 1;
  const la = relativeLuminance(ca);
  const lb = relativeLuminance(cb);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/* ------------------------------------------------------------------ *
 * 内部归一化:入参对象一律复制成内部形状,既不信任也不改动调用方的数据
 * ------------------------------------------------------------------ */

interface NormShape {
  index: number;
  kind: Shape["kind"];
  rect: Rect;
  text: string | null;
  fontSizePt: number | null;
  bold: boolean;
  color: string | null;
  fill: string | null;
  imagePx: SizePx | null;
  altText: string | null;
  isTitle: boolean;
}

interface NormPage {
  index: number;
  width: number;
  height: number;
  shapes: NormShape[];
  background: string | null;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function readString(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key];
  return typeof v === "string" ? v : null;
}

function readNumber(rec: Record<string, unknown>, key: string): number | null {
  const v = rec[key];
  return isFiniteNumber(v) ? v : null;
}

function normalizeRect(raw: unknown): Rect | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const x = rec["x"];
  const y = rec["y"];
  const w = rec["w"];
  const h = rec["h"];
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(w) || !isFiniteNumber(h)) return null;
  return { x, y, w, h };
}

function normalizeShape(raw: unknown, index: number): NormShape | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const rect = normalizeRect(rec["rect"]);
  if (!rect) return null;
  const text = readString(rec, "text");
  const rawKind = rec["kind"];
  const kind: Shape["kind"] =
    rawKind === "text" || rawKind === "image" || rawKind === "shape" ? rawKind : text !== null ? "text" : "shape";
  const px = rec["imagePx"];
  let imagePx: SizePx | null = null;
  if (px && typeof px === "object") {
    const p = px as Record<string, unknown>;
    if (isFiniteNumber(p["w"]) && isFiniteNumber(p["h"])) imagePx = { w: p["w"], h: p["h"] };
  }
  return {
    index,
    kind,
    rect,
    text,
    fontSizePt: readNumber(rec, "fontSizePt"),
    bold: rec["bold"] === true,
    color: readString(rec, "color"),
    fill: readString(rec, "fill"),
    imagePx,
    altText: readString(rec, "altText"),
    isTitle: rec["isTitle"] === true,
  };
}

/** 归一化整份稿件;返回 null 表示入参不合法(→ VIS_INVALID),不抛异常。 */
function normalizeDeck(input: unknown): NormPage[] | null {
  if (!Array.isArray(input)) return null;
  const pages: NormPage[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const raw: unknown = input[i];
    if (!raw || typeof raw !== "object") return null;
    const rec = raw as Record<string, unknown>;
    const width = rec["width"];
    const height = rec["height"];
 // 宽高缺失/非数字/非正数都无法建立坐标系:与其算出一堆 NaN 结论,不如直接判非法。
    if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) return null;
    const rawShapes: unknown[] = Array.isArray(rec["shapes"]) ? (rec["shapes"] as unknown[]) : [];
    const shapes: NormShape[] = [];
    for (let j = 0; j < rawShapes.length; j += 1) {
      const shape = normalizeShape(rawShapes[j], j);
      if (shape) shapes.push(shape);
    }
    const pageIndex = rec["index"];
    const bgRaw = rec["background"];
    const background = typeof bgRaw === "string" && bgRaw.trim() !== "" ? bgRaw : null;
    pages.push({ index: isFiniteNumber(pageIndex) ? pageIndex : i, width, height, shapes, background });
  }
  return pages;
}

/* ------------------------------------------------------------------ *
 * 几何小工具
 * ------------------------------------------------------------------ */

function areaOf(rect: Rect): number {
  return rect.w * rect.h;
}

function hasVisibleArea(rect: Rect): boolean {
  return areaOf(rect) > 0;
}

function isNonBlankText(text: string | null): boolean {
  return text !== null && text.trim() !== "";
}

const CONTAIN_EPSILON = 1e-9;

/** a 是否完全包含 b(含 0 容差:相等矩形互相包含 → 不算重叠,否则重复元素会刷一片假重叠)。 */
function containsRect(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + CONTAIN_EPSILON &&
    a.y <= b.y + CONTAIN_EPSILON &&
    a.x + a.w >= b.x + b.w - CONTAIN_EPSILON &&
    a.y + a.h >= b.y + b.h - CONTAIN_EPSILON
  );
}

function intersectionArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function containsPoint(rect: Rect, px: number, py: number): boolean {
  return px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  const lo = sorted[mid - 1] ?? 0;
  const hi = sorted[mid] ?? 0;
  return (lo + hi) / 2;
}

/** 2 位小数:所有对外的百分比/比率都先过这一道,保证同一输入两次跑出同一串数字。 */
function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

/* ------------------------------------------------------------------ *
 * HSL(只为强调色规则服务)
 * ------------------------------------------------------------------ */

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function toHsl(c: RGB): Hsl {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

/** 色相桶:每 30° 一桶,共 12 桶(桶号而不是色相值,避免 359.9 与 0.1 被当成两种颜色)。 */
function hueBucket(hue: number): number {
  return Math.min(11, Math.max(0, Math.floor(hue / 30)));
}

/* ------------------------------------------------------------------ *
 * 阈值合并
 * ------------------------------------------------------------------ */

function resolveThresholds(overrides: Partial<VisThresholds> | undefined): VisThresholds {
  const merged: VisThresholds = { ...VIS_DEFAULT_THRESHOLDS };
  if (overrides && typeof overrides === "object") {
    const rec = overrides as Record<string, unknown>;
    for (const key of Object.keys(VIS_DEFAULT_THRESHOLDS) as (keyof VisThresholds)[]) {
      const value = rec[key];
      if (isFiniteNumber(value)) merged[key] = value;
    }
  }
  return merged;
}

/* ------------------------------------------------------------------ *
 * 报告骨架
 * ------------------------------------------------------------------ */

function zeroMetrics(pages: number): VisMetrics {
  return {
    pages,
    shapes: 0,
    p0: 0,
    p1: 0,
    p2: 0,
    accentSharePct: 0,
    hueCount: 0,
    whitespacePct: 0,
    minFontPt: null,
    minContrast: null,
    minImageDpi: null,
    textBlocks: 0,
    gridMisalignSharePct: 0,
  };
}

function invalidReport(): VisReport {
  return { ok: false, code: VIS_INVALID, score: 0, verdict: "fail", issues: [], metrics: zeroMetrics(0) };
}

function emptyDeckReport(): VisReport {
  return { ok: false, code: VIS_EMPTY_DECK, score: 0, verdict: "fail", issues: [], metrics: zeroMetrics(0) };
}

const SEVERITY_RANK: Record<Severity, number> = { p0: 0, p1: 1, p2: 2 };

interface RankedIssue extends VisIssue {
 /** 同一 ruleId 内部的优先位:文本压图片 / 文本压文本要先被看到(其余规则恒为 0)。 */
  priority: number;
}

function compareIssues(a: RankedIssue, b: RankedIssue): number {
  if (a.page !== b.page) return a.page - b.page;
  const sa = SEVERITY_RANK[a.severity];
  const sb = SEVERITY_RANK[b.severity];
  if (sa !== sb) return sa - sb;
  if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
  if (a.priority !== b.priority) return a.priority - b.priority;
  const ia = a.shapeIndex ?? -1;
  const ib = b.shapeIndex ?? -1;
  return ia - ib;
}

/* ------------------------------------------------------------------ *
 * 主入口:inspectDeck
 * ------------------------------------------------------------------ */

interface AccState {
  shapes: number;
  accentArea: number;
  pageArea: number;
  hues: Set<number>;
  coveredCells: number;
  totalCells: number;
  minFont: number | null;
  minContrast: number | null;
  minDpi: number | null;
  textBlocks: number;
  misalignedBlocks: number;
}

/** 网格采样分辨率:32×18 = 576 个单元,足够区分「整页空白」与「正常版式」,又完全确定。 */
const GRID_COLS = 32;
const GRID_ROWS = 18;

/**
 * 体检一份已渲染的页面几何。纯函数:不 throw、不改入参、同输入同输出。
 * issues 稳定排序:page → severity(p0<p1<p2) → ruleId → (规则内优先位) → shapeIndex。
 */
export function inspectDeck(
  pages: PageGeometry[],
  opts?: { thresholds?: Partial<VisThresholds> },
): VisReport {
  const t = resolveThresholds(opts?.thresholds);
  const deck = normalizeDeck(pages);
  if (!deck) return invalidReport();
  if (deck.length === 0) return emptyDeckReport();

  const issues: RankedIssue[] = [];
  const acc: AccState = {
    shapes: 0,
    accentArea: 0,
    pageArea: 0,
    hues: new Set<number>(),
    coveredCells: 0,
    totalCells: 0,
    minFont: null,
    minContrast: null,
    minDpi: null,
    textBlocks: 0,
    misalignedBlocks: 0,
  };

  const push = (issue: VisIssue, priority = 0): void => {
    issues.push({ ...issue, priority });
  };

  for (const page of deck) {
    const shapes = page.shapes;
    const pageW = page.width;
    const pageH = page.height;
    const pageArea = pageW * pageH;
    acc.shapes += shapes.length;
    acc.pageArea += pageArea;

 /* --- 空页:没有可见面积也没有文本,才叫空(页面上放一条 0 面积的参考线不算内容) --- */
    const visible = shapes.filter((s) => hasVisibleArea(s.rect) || isNonBlankText(s.text));
    if (visible.length === 0) {
      push({
        ruleId: RULE_EMPTY_PAGE,
        severity: "p0",
        page: page.index,
        detail: `第 ${page.index} 页没有任何可见文本/图形/图片(shapes=${shapes.length})`,
        fixHint: "补内容或删掉这一页;空白页在投影时会像卡住了一样",
      });
    }

 /* --- 越界:超出容差才算(0.5pt 的排版余量是正常的,报出来只会淹没真问题) --- */
    const tol = t.offCanvasTolerancePt;
    for (const s of shapes) {
      const overRight = s.rect.x + s.rect.w - (pageW + tol);
      const overBottom = s.rect.y + s.rect.h - (pageH + tol);
      const overLeft = -s.rect.x - tol;
      const overTop = -s.rect.y - tol;
      if (overRight > 0 || overBottom > 0 || overLeft > 0 || overTop > 0) {
        const parts: string[] = [];
        if (overLeft > 0) parts.push(`左溢 ${round2(overLeft)}pt`);
        if (overTop > 0) parts.push(`上溢 ${round2(overTop)}pt`);
        if (overRight > 0) parts.push(`右溢 ${round2(overRight)}pt`);
        if (overBottom > 0) parts.push(`下溢 ${round2(overBottom)}pt`);
        push({
          ruleId: RULE_OFF_CANVAS,
          severity: "p1",
          page: page.index,
          shapeIndex: s.index,
          detail: `${s.kind} 超出页面 ${round2(pageW)}×${round2(pageH)}pt 边界:${parts.join("、")}`,
          fixHint: "把元素收回版心内,或调整页面尺寸;被裁掉的内容打印出来就没了",
        });
      }
    }

 /* --- 重叠:包含关系不算(容器+子元素是正常排版),只有「真交叠」按占比判定 --- */
    for (let i = 0; i < shapes.length; i += 1) {
      const a = shapes[i];
      if (!a || !hasVisibleArea(a.rect)) continue;
      for (let j = i + 1; j < shapes.length; j += 1) {
        const b = shapes[j];
        if (!b || !hasVisibleArea(b.rect)) continue;
        const inter = intersectionArea(a.rect, b.rect);
        if (inter <= 0) continue;
        if (containsRect(a.rect, b.rect) || containsRect(b.rect, a.rect)) continue;
        const smaller = Math.min(areaOf(a.rect), areaOf(b.rect));
        if (smaller <= 0) continue;
        const share = inter / smaller;
        if (!(share > t.maxOverlapShare)) continue;
        const textOverImage = (a.kind === "text" && b.kind === "image") || (b.kind === "text" && a.kind === "image");
        const textOverText = a.kind === "text" && b.kind === "text";
        const priority = textOverImage ? 0 : textOverText ? 1 : 2;
        const subject = a.kind === "text" ? a : b.kind === "text" ? b : areaOf(a.rect) <= areaOf(b.rect) ? a : b;
        push(
          {
            ruleId: RULE_OVERLAP,
            severity: "p1",
            page: page.index,
            shapeIndex: subject.index,
            detail: `shape#${a.index}(${a.kind}) 与 shape#${b.index}(${b.kind}) 交叠 ${round2(share * 100)}% 较小者面积(上限 ${round2(t.maxOverlapShare * 100)}%)`,
            fixHint: "挪开或缩小其中一个,实在要叠就让被压的那个整体退到背景层;压住文字会直接丢信息",
          },
          priority);
      }
    }

 /* --- 字号下限:没有 fontSizePt 的文本框不参与(不知道就别判) --- */
    for (const s of shapes) {
      if (s.kind !== "text" || s.fontSizePt === null) continue;
      if (acc.minFont === null || s.fontSizePt < acc.minFont) acc.minFont = s.fontSizePt;
      if (s.fontSizePt < t.minFontPt) {
        push({
          ruleId: RULE_FONT_MIN,
          severity: "p1",
          page: page.index,
          shapeIndex: s.index,
          detail: `文本字号 ${round2(s.fontSizePt)}pt 小于下限 ${round2(t.minFontPt)}pt`,
          fixHint: `正文不小于 ${round2(t.minFontPt)}pt;字号不够在投影和打印上都会糊成一片`,
        });
      }
    }

 /* --- 层级:标题必须比正文明显大(倍数不足=读者看不出哪个是标题) --- */
    const titleFonts = shapes.filter((s) => s.kind === "text" && s.isTitle && s.fontSizePt !== null);
    if (titleFonts.length > 0) {
      const bodyFonts = shapes
        .filter((s) => s.kind === "text" && !s.isTitle && s.fontSizePt !== null)
        .map((s) => s.fontSizePt as number);
      if (bodyFonts.length > 0) {
        const bodyMedian = median(bodyFonts);
        const need = round2(t.titleRatio * bodyMedian);
        for (const s of titleFonts) {
          const size = s.fontSizePt as number;
          if (size < t.titleRatio * bodyMedian) {
            push({
              ruleId: RULE_HIERARCHY,
              severity: "p2",
              page: page.index,
              shapeIndex: s.index,
              detail: `标题字号 ${round2(size)}pt 不足正文中位数 ${round2(bodyMedian)}pt 的 ${round2(t.titleRatio)} 倍(至少 ${need}pt)`,
              fixHint: `把标题放大到 ${need}pt 以上,或把正文字号调小;层级差 <${round2(t.titleRatio)} 倍时人眼分不出主次`,
            });
          }
        }
      }
    }

 /* --- 对比度:背景取「覆盖该文本且最小的那个 fill」,其次页面底色,最后才假设纯白 --- */
    for (const s of shapes) {
      if (s.kind !== "text") continue;
      const fg = parseColor(s.color ?? "#000000");
      let bgRaw: string | null = null;
      let bestArea = Number.POSITIVE_INFINITY;
      for (const other of shapes) {
        if (other === s || other.fill === null) continue;
        if (!containsRect(other.rect, s.rect)) continue;
        const area = areaOf(other.rect);
        if (area < bestArea) {
          bestArea = area;
          bgRaw = other.fill;
        }
      }
 // 页面底色可能是空串/非法值:解析不通就退回纯白假设,而不是「跳过判定」(跳过=静默放过)
      const bgCandidate = bgRaw ?? (typeof page.background === "string" && page.background !== "" ? page.background : null);
      const bgResolved = bgCandidate && parseColor(bgCandidate) ? bgCandidate : "#ffffff";
      const bg = parseColor(bgResolved);
      if (!fg || !bg) continue;
      const isLarge =
        (s.fontSizePt !== null && s.fontSizePt >= t.largeFontPt) ||
        (s.bold && s.fontSizePt !== null && s.fontSizePt >= t.boldLargeFontPt);
      const need = isLarge ? t.minContrastLarge : t.minContrast;
      const ratio = contrastRatio(fg, bg);
      if (acc.minContrast === null || ratio < acc.minContrast) acc.minContrast = ratio;
      if (ratio < need) {
        push({
          ruleId: RULE_CONTRAST,
          severity: "p1",
          page: page.index,
          shapeIndex: s.index,
          detail: `${isLarge ? "大字" : "正文"}对比度 ${round2(ratio)}:1 低于 ${round2(need)}:1(前景 ${s.color ?? "#000000"},背景 ${bgResolved ?? "#ffffff"})`,
          fixHint: "加深文字色或调浅背景;低于 WCAG 阈值时弱视用户和投影环境基本读不出来",
        });
      }
    }

 /* --- 强调色:高饱和填充既不能铺满整页,也不能五颜六色 —— 两条都算「视觉噪音」 --- */
    const pageHues = new Set<number>();
    let accentArea = 0;
    for (const s of shapes) {
      if (s.fill === null || !hasVisibleArea(s.rect)) continue;
      const rgb = parseColor(s.fill);
      if (!rgb) continue;
      const hsl = toHsl(rgb);
      if (hsl.s >= 0.2) {
        const bucket = hueBucket(hsl.h);
        pageHues.add(bucket);
        acc.hues.add(bucket);
      }
      if (hsl.s >= 0.6 && hsl.l >= 0.25 && hsl.l <= 0.75) accentArea += areaOf(s.rect);
    }
    acc.accentArea += accentArea;
    const pageAccentPct = pageArea > 0 ? round2((accentArea / pageArea) * 100) : 0;
    if (pageAccentPct > t.accentShareMaxPct || pageHues.size > t.hueMax) {
      push({
        ruleId: RULE_ACCENT_SHARE,
        severity: "p2",
        page: page.index,
        detail: `高饱和填充占页面 ${pageAccentPct}%(上限 ${round2(t.accentShareMaxPct)}%),填充色相桶 ${pageHues.size} 个(上限 ${round2(t.hueMax)})`,
        fixHint: "强调色只留给真正的重点(整页 ≤20%、色相 ≤8 桶);铺满整页的高饱和色会盖掉内容层级",
      });
    }

 /* --- 留白:确定性网格采样(单元格中心命中判定),不用随机撒点(那样结果不可复现) --- */
    const cells = GRID_COLS * GRID_ROWS;
    let covered = 0;
    for (let row = 0; row < GRID_ROWS; row += 1) {
      const py = ((row + 0.5) * pageH) / GRID_ROWS;
      for (let col = 0; col < GRID_COLS; col += 1) {
        const px = ((col + 0.5) * pageW) / GRID_COLS;
        let hit = false;
        for (const s of shapes) {
          if (!hasVisibleArea(s.rect)) continue;
          if (containsPoint(s.rect, px, py)) {
            hit = true;
            break;
          }
        }
        if (hit) covered += 1;
      }
    }
    acc.coveredCells += covered;
    acc.totalCells += cells;
    const whitespacePct = round2((1 - covered / cells) * 100);
    if (whitespacePct > t.whitespaceMaxPct || whitespacePct < t.whitespaceMinPct) {
      push({
        ruleId: RULE_WHITESPACE,
        severity: "p2",
        page: page.index,
        detail: `未被覆盖面积 ${whitespacePct}%(健康区间 ${round2(t.whitespaceMinPct)}%~${round2(t.whitespaceMaxPct)}%)`,
        fixHint:
          whitespacePct > t.whitespaceMaxPct
            ? "整页太空:补内容或缩小页面尺寸;一页只有两行字会显得没做完"
            : "整页太挤:删减或拆页,把留白拉回 8% 以上",
      });
    }

 /* --- 图片:有效 DPI(像素宽 ÷ 打印英寸宽)与 alt 文本 --- */
    for (const s of shapes) {
      if (s.kind !== "image") continue;
      if (s.imagePx !== null && s.imagePx.w > 0 && s.rect.w > 0) {
        const dpi = s.imagePx.w / (s.rect.w / 72);
        if (acc.minDpi === null || dpi < acc.minDpi) acc.minDpi = dpi;
        if (dpi < t.minImageDpi) {
          push({
            ruleId: RULE_IMAGE_DPI,
            severity: "p2",
            page: page.index,
            shapeIndex: s.index,
            detail: `图片有效 DPI ${round2(dpi)}(下限 ${round2(t.minImageDpi)}):${round2(s.imagePx.w)}px 铺在 ${round2(s.rect.w)}pt(${round2(s.rect.w / 72)}in)宽上`,
            fixHint: `换更清晰的图源,或把显示尺寸缩到 ${round2((s.imagePx.w / t.minImageDpi) * 72)}pt 以内`,
          });
        }
      }
      if (!isNonBlankText(s.altText)) {
        push({
          ruleId: RULE_ALT_MISSING,
          severity: "p1",
          page: page.index,
          shapeIndex: s.index,
          detail: "图片缺少 alt 替代文本",
          fixHint: "补一句物有所值的替代文本;读屏用户和文档检索都靠它认图",
        });
      }
    }

 /* --- 版式对齐:左边缘到 0.1in 网格的距离超容差的文本块占比 ---
 * 注意阈值的内在关系:默认容差 0.06in(4.32pt)> 半格 0.05in(3.6pt),也就是说在默认阈值下
 * 「到最近网格线的距离」永远 ≤ 半格 < 容差,这条规则不会自燃。它是给调用方收紧密度用的
 * (例如 gridToleranceIn=0.02in 时,偏离 2pt 就会被算作不齐);默认参数保持任务书给定值,
 * 不改规则语义,只把这条数学事实写在这里,免得后人以为「规则写了却没生效」。 */
    const blocks = shapes.filter((s) => s.kind === "text" && isNonBlankText(s.text));
    if (blocks.length > 0) {
      const gridPt = t.gridIn * 72;
      const alignTolPt = t.gridToleranceIn * 72;
      let misaligned = 0;
      if (gridPt > 0) {
        for (const b of blocks) {
          const nearest = Math.round(b.rect.x / gridPt) * gridPt;
          if (Math.abs(b.rect.x - nearest) > alignTolPt) misaligned += 1;
        }
      }
      acc.textBlocks += blocks.length;
      acc.misalignedBlocks += misaligned;
      const sharePct = round2((misaligned / blocks.length) * 100);
      if (sharePct > t.gridMisalignShareMaxPct) {
        push({
          ruleId: RULE_GRID_MISALIGN,
          severity: "p2",
          page: page.index,
          detail: `左边缘偏离 ${round2(t.gridIn)}in 网格的文本块 ${misaligned}/${blocks.length}(${sharePct}%,上限 ${round2(t.gridMisalignShareMaxPct)}%)`,
          fixHint: "对齐到网格线或用分布对齐;参差的左边缘看起来就是没排版",
        });
      }
    }
  }

  issues.sort(compareIssues);

  const p0 = issues.filter((i) => i.severity === "p0").length;
  const p1 = issues.filter((i) => i.severity === "p1").length;
  const p2 = issues.filter((i) => i.severity === "p2").length;
  const score = Math.max(0, Math.min(100, 100 - 25 * p0 - 8 * p1 - 3 * p2));

  const metrics: VisMetrics = {
    pages: deck.length,
    shapes: acc.shapes,
    p0,
    p1,
    p2,
    accentSharePct: acc.pageArea > 0 ? round2((acc.accentArea / acc.pageArea) * 100) : 0,
    hueCount: acc.hues.size,
    whitespacePct: acc.totalCells > 0 ? round2((1 - acc.coveredCells / acc.totalCells) * 100) : 0,
    minFontPt: acc.minFont === null ? null : round2(acc.minFont),
    minContrast: acc.minContrast === null ? null : round2(acc.minContrast),
    minImageDpi: acc.minDpi === null ? null : round2(acc.minDpi),
    textBlocks: acc.textBlocks,
    gridMisalignSharePct: acc.textBlocks > 0 ? round2((acc.misalignedBlocks / acc.textBlocks) * 100) : 0,
  };

  const cleanIssues: VisIssue[] = issues.map(({ priority: _priority, ...rest }) => rest);

  if (p0 > 0 || p1 > 0) {
    return { ok: false, code: VIS_FAIL, score, verdict: "fail", issues: cleanIssues, metrics };
  }
  if (p2 > 0) {
    return { ok: true, code: VIS_WARN, score, verdict: "warn", issues: cleanIssues, metrics };
  }
  return { ok: true, code: VIS_OK, score, verdict: "pass", issues: cleanIssues, metrics };
}

/* ------------------------------------------------------------------ *
 * 评审请求组装
 * ------------------------------------------------------------------ */

const VIS_CODE_TOKEN_RE = /VIS_[A-Z_]+/g;

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function ruleIdsFromVerdict(verdict: VisReport | string | undefined): string[] {
  if (typeof verdict === "string") {
    return uniqueSorted(verdict.match(VIS_CODE_TOKEN_RE) ?? []);
  }
  if (verdict && typeof verdict === "object" && Array.isArray(verdict.issues)) {
    return uniqueSorted(verdict.issues.map((i) => i.ruleId).filter((id) => typeof id === "string"));
  }
  return [];
}

function summarize(verdict: VisReport | string | undefined): { summary: string; code: string } {
  if (typeof verdict === "string") {
    const code = verdict.trim().replace(/\s+/g, " ") || "VIS_UNKNOWN";
    return { summary: `code=${code} verdict=n/a score=0 p0=0 p1=0 p2=0`, code };
  }
  if (verdict && typeof verdict === "object") {
    const m = verdict.metrics;
    const num = (v: unknown): number => (isFiniteNumber(v) ? v : 0);
    const code = typeof verdict.code === "string" ? verdict.code : "VIS_UNKNOWN";
    const summary = `code=${code} verdict=${verdict.verdict} score=${num(verdict.score)} p0=${num(m?.p0)} p1=${num(m?.p1)} p2=${num(m?.p2)}`;
    return { summary, code };
  }
  return { summary: "code=VIS_UNKNOWN verdict=n/a score=0 p0=0 p1=0 p2=0", code: "VIS_UNKNOWN" };
}

/**
 * 组装一次「逐页对照 PNG 的人工/多模态复核」请求。
 * 为什么要有 pending 这一态:渲染可能失败或未跑,缺失 PNG 的页**不能**被写成 ready——
 * 那等于让评审员对着空气给出结论。pendingCount 让上层能拒绝「拿半份图就宣布通过」。
 * 全函数不 throw、不改入参、同输入同输出(不做时间戳:时间会让两次调用不再相等)。
 */
export function buildReviewRequest(input: {
  pages: PageGeometry[];
  pngPaths?: string[];
  machineVerdict?: VisReport | string;
}): ReviewRequest {
  const pagesIn: unknown[] = input && Array.isArray(input.pages) ? (input.pages as unknown[]) : [];
  const paths: unknown[] = input && Array.isArray(input.pngPaths) ? (input.pngPaths as unknown[]) : [];
  const perPage: ReviewPageEntry[] = [];
  for (let i = 0; i < pagesIn.length; i += 1) {
    const raw: unknown = pagesIn[i];
    const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    const rawIndex = rec ? rec["index"] : undefined;
    const page = isFiniteNumber(rawIndex) ? rawIndex : i;
    const rawPng: unknown = paths[i];
    const png = typeof rawPng === "string" && rawPng.trim() !== "" ? rawPng : null;
    perPage.push(png === null ? { page, status: "pending" } : { page, png, status: "ready" });
  }

  const pendingPages = perPage.filter((p) => p.status === "pending").map((p) => p.page);
  const pendingCount = pendingPages.length;
  const ruleIds = ruleIdsFromVerdict(input?.machineVerdict);
  const { summary } = summarize(input?.machineVerdict);

  const ruleLine = ruleIds.length > 0 ? ruleIds.join("、") : "(机器未报具体规则)";
  const pendingLine =
    pendingCount > 0
      ? `第 ${pendingPages.join("、")} 页未提供 PNG,不要臆测:这些页只允许记录机器结论,不得编造画面细节。`
      : "全部页面均已提供 PNG,必须逐页对照图片作答。";

  const prompt = [
    "你是办公文档的视觉评审员。下面会给出逐页 PNG 渲染图和机器体检结论,请按页复核。",
    "逐页对照 PNG 检查六件事:①重叠(文本压文本、文本压图片,是否遮住关键信息);②越界(元素是否被页面边界裁切);③对比度(正文至少 4.5:1,大字至少 3:1);④层级(标题与正文的字号关系是否一眼可辨);⑤留白(整页过空还是过挤);⑥图片质量(是否明显糊、是否缺替代文本)。",
    `机器已报规则:${ruleLine}。请逐条在图上确认,机器漏掉但你确实看到的问题也要报。`,
    `共 ${perPage.length} 页;${pendingLine}`,
    "输出格式:每页一行 `page=<页码> result=pass|warn|fail` + 一句理由(不超过 40 字),只写你从 PNG 上真的看到的东西。",
  ].join("\n");

  return { perPage, prompt, machineSummary: summary, pendingCount };
}
