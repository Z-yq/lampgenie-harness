/**
 * 办公文档可寻址契约(office-anchor):给 deck.md 源稿 / pptx 文本一套统一、可执行的
 * 「那一页/那一张到底是哪一张」口径。
 * 为什么需要一条独立契约:
 * - 页码口径必须唯一:人写「第3页」、模型写「p3」、pptx 写「slide 3」,三者若各自 0-based/1-based
 * 混用,「改第 3 页」会稳定改错一页;本模块一律 1-based,非 1-based 一律拒绝而不是猜。
 * - 标题匹配必须先归一:CJK 部首(氵/水)、全半角、标点、空白、中文数字(第三章 vs 第3章)
 * 都是同一张标题的不同写法;不归一就永远「找不到」,归一过度又会误命中,所以要打分并允许
 * 「并列 → 歧义」而不是硬选一个。
 * - TOC 与正文是同一份事实的两次陈述:缺项/多项/顺序/重复/越界/整体 off-by-one 必须能点名,
 * 但本模块只报告与给修正建议,绝不改写原文(源稿是人的资产,机器只做体检)。
 * - 所有函数不 throw、不可变、同输入同输出:它是 CLI/生成器的公共底座,失败必须以稳定码回传。
 * 纯逻辑:零 IO,不读文件/网络/环境,只用 JS 内置能力。
 */

/** 契约版本:CLI 输出与生成器接线都带上它,便于回溯哪一版口径产出的结论。 */
export const OFFICE_ANCHOR_VERSION = "1.0.0";

/** 稳定码:每个码对应一个可判定的结局(不加盖异常)。 */
export const ANCHOR_CODES = [
  "OK",
  "INVALID",
  "NOT_FOUND",
  "AMBIGUOUS",
  "TOC_DRIFT",
  "TOC_DUPLICATE",
  "TOC_ORDER",
  "TOC_OUT_OF_RANGE",
] as const;

export type AnchorCode = (typeof ANCHOR_CODES)[number];

/** 1-based 页码上限:超过它按 INVALID 处理(单页寻址不可能有 9999 张以上)。 */
export const MAX_ANCHOR_INDEX = 9999;

/** 原始锚点串上限:超长输入不可能是真页码,直接拒绝(防把正文误当锚点)。 */
export const MAX_ANCHOR_RAW_LENGTH = 32;

/**
 * CJK 部首/部件折叠表(24 组高频)。
 * 目的:同一标题在不同输入法/不同人手里可能写成部首形式(氵)或整字(水),归一后必须一致。
 * 取舍说明:阝 左右两读(左阜右邑),本契约统一取「阜」——归一只要确定,不需要语言学正确。
 */
export const CJK_RADICAL_MAP: Readonly<Record<string, string>> = Object.freeze({
  氵: "水",
  扌: "手",
  忄: "心",
  讠: "言",
  钅: "金",
  纟: "糸",
  阝: "阜",
  亻: "人",
  刂: "刀",
  辶: "辵",
  冫: "冰",
  灬: "火",
  饣: "食",
  犭: "犬",
  礻: "示",
  衤: "衣",
  艹: "艸",
  "⺮": "竹",
  王: "玉",
  鱼: "魚",
  马: "馬",
  鸟: "鳥",
  车: "車",
  页: "頁",
});

/** 中文数字单字(含常见变体)。 */
const CJK_NUMERAL_DIGITS: Readonly<Record<string, number>> = Object.freeze({
  〇: 0,
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
});

/** 中文数字单位。 */
const CJK_NUMERAL_UNITS: Readonly<Record<string, number>> = Object.freeze({
  十: 10,
  百: 100,
  千: 1000,
});

const CJK_NUMERAL_RUN = /[〇零一二三四五六七八九十百千两]+/g;

/** 把一段连续中文数字转成阿拉伯数字串(支持到千位;「二三」这类裸连写按末位,罕见且确定性)。 */
function cjkRunToNumber(run: string): string {
  let total = 0;
  let current = 0;
  for (const ch of run) {
    const unit = CJK_NUMERAL_UNITS[ch];
    if (unit !== undefined) {
      if (current === 0) current = 1;
      total += current * unit;
      current = 0;
      continue;
    }
    const digit = CJK_NUMERAL_DIGITS[ch];
    if (digit !== undefined) current = digit;
  }
  return String(total + current);
}

/** 中文数字折叠:第十二章 → 第12章,第二十章 → 第20章,「第 3 章」与「第三章」同形。 */
function foldCjkNumerals(input: string): string {
  if (!/[〇零一二三四五六七八九十百千两]/.test(input)) return input;
  return input.replace(CJK_NUMERAL_RUN, (run) => cjkRunToNumber(run));
}

/**
 * 标题归一(唯一口径):
 * 1. NFKC:全角→半角、兼容汉字归一;
 * 2. 小写;
 * 3. 只保留 Unicode 字母/数字(去掉中英标点、空白、符号、emoji),内部空白也一并去掉;
 * 4. CJK 部首/部件折叠(24 组);
 * 5. 中文数字→阿拉伯数字(第三章 ≡ 第3章)。
 * 幂等:再跑一次不会改变结果。
 */
export function normalizeHeading(text: string): string {
  const folded = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
  if (!folded) return "";
  let out = "";
  for (const ch of folded) {
    out += CJK_RADICAL_MAP[ch] ?? ch;
  }
  return foldCjkNumerals(out);
}

/** 锚点解析结果:1-based,kind 区分正文页码(page)与幻灯片序号(slide)。 */
export interface ParsedAnchor {
  ok: boolean;
  code: AnchorCode;
  kind: "page" | "slide" | null;
  index: number | null;
  raw: string;
}

/** 数字形态探测(用于区分「非法数字锚点 → INVALID」与「文本标题 → 走匹配」)。 */
function looksNumericAnchor(raw: string): boolean {
  const text = raw.normalize("NFKC").trim().toLowerCase();
  if (!text) return false;
  return (
    /^(?:p(?:age)?\s*)?[+-]?\d+$/.test(text) ||
    /^第\s*[+-]?\d+\s*[页张]$/.test(text) ||
    /^slide\s*[+-]?\d+$/.test(text) ||
    /^幻灯片\s*[+-]?\d+$/.test(text)
  );
}

function invalidAnchor(raw: string, code: AnchorCode = "INVALID"): ParsedAnchor {
  return { ok: false, code, kind: null, index: null, raw };
}

/**
 * 解析页码/幻灯片锚点(一律 1-based):
 * 3 | p3 | P3 | page 3 | 第3页 | slide 3 | 幻灯片3 | 第3张
 * 0 / 负数 / 非数字 / 超长(>32 字符或 >9999 或带符号)→ INVALID。
 * 「第N张」「slide」「幻灯片」→ kind=slide,其余 → kind=page。
 */
export function parseAnchor(input: string): ParsedAnchor {
  const raw = typeof input === "string" ? input : String(input ?? "");
  if (!raw || raw.length > MAX_ANCHOR_RAW_LENGTH) return invalidAnchor(raw);
  const text = raw.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  let kind: "page" | "slide" = "page";
  let digits: string | null = null;
  let match: RegExpMatchArray | null = null;

  if ((match = text.match(/^([+-]?\d+)$/))) {
    digits = match[1] ?? null;
  } else if ((match = text.match(/^p(?:age)?\s*([+-]?\d+)$/))) {
    digits = match[1] ?? null;
  } else if ((match = text.match(/^第\s*([+-]?\d+)\s*([页张])$/))) {
    digits = match[1] ?? null;
    kind = match[2] === "张" ? "slide" : "page";
  } else if ((match = text.match(/^slide\s*([+-]?\d+)$/))) {
    digits = match[1] ?? null;
    kind = "slide";
  } else if ((match = text.match(/^幻灯片\s*([+-]?\d+)$/))) {
    digits = match[1] ?? null;
    kind = "slide";
  }

  if (digits === null) return invalidAnchor(raw);
  if (!/^\d+$/.test(digits)) return invalidAnchor(raw);
  if (digits.length > 6) return invalidAnchor(raw);
  const index = Number(digits);
  if (!Number.isSafeInteger(index) || index < 1 || index > MAX_ANCHOR_INDEX) return invalidAnchor(raw);
  return { ok: true, code: "OK", kind, index, raw };
}

/** 一个可被寻址的标题(1-based index;line/level 便于回原文)。 */
export interface HeadingRef {
  text: string;
  index: number;
  line?: number;
  level?: number;
}

/** 候选匹配方式:index=数字直接命中,exact/prefix/contains=文本三层。 */
export type AnchorMatch = "index" | "exact" | "prefix" | "contains";

/** 一个命中候选及打分(lenDiff/rawLenDiff 越小越接近;score 仅作可读汇总)。 */
export interface AnchorCandidate {
  text: string;
  index: number;
  match: AnchorMatch;
  lenDiff: number;
  rawLenDiff: number;
  score: number;
}

/** 锚点解析结果。 */
export interface AnchorResolution {
  ok: boolean;
  code: AnchorCode;
  query: string;
  anchor: ParsedAnchor;
  index: number | null;
  candidates: AnchorCandidate[];
}

function candidateOf(
  heading: HeadingRef,
  normalizedHeading: string,
  queryNorm: string,
  queryRaw: string,
  match: Exclude<AnchorMatch, "index">,
): AnchorCandidate {
  const lenDiff = Math.abs(normalizedHeading.length - queryNorm.length);
  const rawLenDiff = Math.abs(heading.text.length - queryRaw.length);
  return {
    text: heading.text,
    index: heading.index,
    match,
    lenDiff,
    rawLenDiff,
    score: lenDiff * 100 + rawLenDiff,
  };
}

/**
 * 把锚点解析到具体标题(1-based):
 * - 数字锚点(p3 / 第3页 / 3):直接按 1-based index 命中;越界 → NOT_FOUND,非法数字 → INVALID。
 * - 文本锚点:归一后先 exact,再 prefix,再 contains(三层 fallback);候选按
 * 「归一后长度差 → 原始长度差 → 位置」排序;最高分完全并列 → AMBIGUOUS(带候选),无 → NOT_FOUND。
 * 位置只用于稳定排序与候选展示,不替调用者拍板「并列时该选哪一张」。
 */
export function resolveAnchor(
  headings: readonly HeadingRef[],
  anchor: string | ParsedAnchor): AnchorResolution {
  const parsed = typeof anchor === "string" ? parseAnchor(anchor) : anchor;
  const query = typeof anchor === "string" ? anchor : anchor.raw;

  if (parsed.ok && parsed.index !== null) {
    const target = headings.find((h) => h.index === parsed.index);
    if (!target) {
      return { ok: false, code: "NOT_FOUND", query, anchor: parsed, index: null, candidates: [] };
    }
    return {
      ok: true,
      code: "OK",
      query,
      anchor: parsed,
      index: target.index,
      candidates: [
        {
          text: target.text,
          index: target.index,
          match: "index",
          lenDiff: 0,
          rawLenDiff: 0,
          score: 0,
        },
      ],
    };
  }

  if (typeof anchor === "string" && looksNumericAnchor(anchor)) {
    return { ok: false, code: "INVALID", query, anchor: parsed, index: null, candidates: [] };
  }
  if (!query.trim() || query.length > MAX_ANCHOR_RAW_LENGTH) {
    return { ok: false, code: "INVALID", query, anchor: parsed, index: null, candidates: [] };
  }
  const queryNorm = normalizeHeading(query);
  if (!queryNorm) {
    return { ok: false, code: "INVALID", query, anchor: parsed, index: null, candidates: [] };
  }

  const normalized = headings.map((heading) => ({
    heading,
    norm: normalizeHeading(heading.text),
  }));

  const tiers: Exclude<AnchorMatch, "index">[] = ["exact", "prefix", "contains"];
  let pool: AnchorCandidate[] = [];
  for (const tier of tiers) {
    pool = normalized
      .filter(({ norm }) => {
        if (!norm) return false;
        if (tier === "exact") return norm === queryNorm;
        if (tier === "prefix") return norm.startsWith(queryNorm);
        return norm.includes(queryNorm);
      })
      .map(({ heading, norm }) => candidateOf(heading, norm, queryNorm, query, tier));
    if (pool.length > 0) break;
  }

  if (pool.length === 0) {
    return { ok: false, code: "NOT_FOUND", query, anchor: parsed, index: null, candidates: [] };
  }

  pool.sort((a, b) => a.lenDiff - b.lenDiff || a.rawLenDiff - b.rawLenDiff || a.index - b.index);
  const top = pool[0];
  if (!top) {
    return { ok: false, code: "NOT_FOUND", query, anchor: parsed, index: null, candidates: [] };
  }
  const tied = pool.filter((c) => c.lenDiff === top.lenDiff && c.rawLenDiff === top.rawLenDiff);
  if (tied.length > 1) {
    return { ok: false, code: "AMBIGUOUS", query, anchor: parsed, index: null, candidates: tied };
  }
  return {
    ok: true,
    code: "OK",
    query,
    anchor: parsed,
    index: top.index,
    candidates: pool.slice(0, 5),
  };
}

/** TOC 条目:index 是原文声明的序号(link 形态按出现顺序补 1-based)。 */
export interface TocEntry {
  index: number;
  title: string;
  raw: string;
  form: "ordered" | "link" | "table";
}

/** TOC 解析结果:declared 区分「文档根本没目录」与「有目录但空」。 */
export interface TocDocument {
  declared: boolean;
  headingLine: number | null;
  entries: TocEntry[];
}

/** 正文标题(1-based index,按选定 level 过滤后编号)。 */
export interface OfficeHeading {
  text: string;
  index: number;
  line: number;
  level: number;
}

const FENCE_RE = /^\s*(```|~~~)/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const TOC_KEYWORDS = /^(目录|目次|contents|tableofcontents|toc)$/;

/** 行级 fence 掩码:代码块里的 `## foo` / `1. bar` 不是标题也不是目录。 */
function fenceMask(lines: readonly string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (FENCE_RE.test(line)) {
      mask[i] = true;
      inFence = !inFence;
      continue;
    }
    mask[i] = inFence;
  }
  return mask;
}

function headingOf(line: string): { level: number; text: string } | null {
  const match = line.match(HEADING_RE);
  if (!match) return null;
  const hashes = match[1] ?? "";
  return { level: hashes.length, text: match[2] ?? "" };
}

/** 去掉行内 markdown 痕迹(**、`、首尾强调标记、尾随 #)。 */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/^[_*]+|[_*]+$/g, "")
    .replace(/\s+#+\s*$/, "")
    .trim();
}

/** 目录标题关键词归一(去 markdown/空白/冒号后再比)。 */
function tocKeywordOf(text: string): string {
  return text
    .replace(/[*_`#]/g, "")
    .replace(/[\s:：]/g, "")
    .toLowerCase();
}

/** 解析单行目录条目;ordinal 是 link 形态缺失序号时的兜底(1-based 出现顺序)。 */
function parseTocLine(rawLine: string, ordinal: number): TocEntry | null {
  const line = rawLine.trim();
  if (!line) return null;
  if (line.startsWith(">")) return null;
  if (/^\|?\s*[-:| ]+\|?\s*$/.test(line)) return null;

  const link = line.match(/^[-*+]\s+\[([^\]]+)\]\(#[^)]*\)\s*$/);
  if (link) {
    const title = stripInlineMarkdown(link[1] ?? "");
    if (!title) return null;
    return { index: ordinal, title, raw: rawLine, form: "link" };
  }

  const table = line.match(/^\|\s*(\d{1,3})\s*\|\s*([^|]+?)\s*(?:\|.*)?$/);
  if (table) {
    const title = stripInlineMarkdown(table[2] ?? "");
    if (!title) return null;
    if (/^(标题|title|章节|内容|名称)$/i.test(title)) return null;
    return { index: Number(table[1]), title, raw: rawLine, form: "table" };
  }

  const ordered = line.match(/^(\d{1,3})[.)、]\s+(.+?)\s*$/);
  if (ordered) {
    const title = stripInlineMarkdown(ordered[2] ?? "");
    if (!title) return null;
    return { index: Number(ordered[1]), title, raw: rawLine, form: "ordered" };
  }
  return null;
}

/**
 * 解析目录:
 * - 优先找一节标题为「目录 / 目次 / Contents / Table of Contents / TOC」的块,块内逐行识别
 * `1. 标题` / `- [标题](#anchor)` / `| 1 | 标题 |` 三种形态;
 * - 没有目录节时,退化为「第一个二级及以下标题之前的正文前置区」,只认上面三种形态
 * (避免把普通正文里的有序列表当成目录)。
 * 返回值只报告事实,不改动原文。
 */
export function parseTocDocument(markdown: string): TocDocument {
  const lines = markdown.split(/\r?\n/);
  const fenced = fenceMask(lines);

  let tocHeading = -1;
  let tocLevel = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (fenced[i]) continue;
    const heading = headingOf(lines[i] ?? "");
    if (!heading) continue;
    if (TOC_KEYWORDS.test(tocKeywordOf(heading.text))) {
      tocHeading = i;
      tocLevel = heading.level;
      break;
    }
  }

  const entries: TocEntry[] = [];
  const collect = (from: number, to: number): void => {
    for (let i = from; i < to; i += 1) {
      if (fenced[i]) continue;
      const entry = parseTocLine(lines[i] ?? "", entries.length + 1);
      if (entry) entries.push(entry);
    }
  };

  if (tocHeading >= 0) {
    let end = lines.length;
    for (let i = tocHeading + 1; i < lines.length; i += 1) {
      if (fenced[i]) continue;
      const heading = headingOf(lines[i] ?? "");
      if (heading && heading.level <= tocLevel) {
        end = i;
        break;
      }
    }
    collect(tocHeading + 1, end);
    return { declared: true, headingLine: tocHeading + 1, entries };
  }

  let firstSection = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    if (fenced[i]) continue;
    const heading = headingOf(lines[i] ?? "");
    if (heading && heading.level >= 2) {
      firstSection = i;
      break;
    }
  }
  collect(0, firstSection);
  return { declared: false, headingLine: null, entries };
}

/** 只要条目列表(与 parseTocDocument 同源,便于只需条目的调用方)。 */
export function parseToc(markdown: string): TocEntry[] {
  return parseTocDocument(markdown).entries;
}

/**
 * 抽取正文标题(默认 level 2、3 = deck 的章节/页面标题;1 # 标题通常不参与 TOC 校验)。
 * 跳过代码围栏;index 按过滤后的出现顺序 1-based 编号。
 * 「目录 / Contents / TOC」这类节标题本身不计入正文标题:否则目录会把自己算进去,
 * 导致全部序号 +1 并让 TOC 校验永远报 off-by-one(目录与正文是同一份事实的两次陈述,
 * 目录节只是陈述入口,不是被陈述的内容)。
 */
export function extractHeadings(
  markdown: string,
  opts: { levels?: readonly number[] } = {},
): OfficeHeading[] {
  const levels = opts.levels && opts.levels.length > 0 ? opts.levels : [2, 3];
  const lines = markdown.split(/\r?\n/);
  const fenced = fenceMask(lines);
  const out: OfficeHeading[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (fenced[i]) continue;
    const heading = headingOf(lines[i] ?? "");
    if (!heading) continue;
    if (!levels.includes(heading.level)) continue;
    const text = stripInlineMarkdown(heading.text);
    if (!text) continue;
    if (TOC_KEYWORDS.test(tocKeywordOf(text))) continue;
    out.push({ text, index: out.length + 1, line: i + 1, level: heading.level });
  }
  return out;
}

/** TOC 校验问题:code 是稳定码,kind 细分同类(code 下的具体形态)。 */
export interface TocIssue {
  code: AnchorCode;
  kind?: string;
  entryIndex: number;
  title: string;
  expected?: string | number;
  actual?: string | number;
  message: string;
  suggestion?: string;
}

/** 一条 TOC 条目 → 正文标题的配对。 */
export interface TocMatch {
  entryIndex: number;
  headingIndex: number;
  title: string;
}

/** TOC 校验结果。 */
export interface TocValidation {
  ok: boolean;
  tocEntries: number;
  headings: number;
  issues: TocIssue[];
  matched: TocMatch[];
 /** 目录与正文整体相差的 1-based 偏移(+1 = 目录疑似 0-based);无则为 null。 */
  offByOne: number | null;
}

/**
 * 校验 TOC 与正文标题:
 * - 缺正文标题(TOC 有、正文无)→ TOC_DRIFT(missing);
 * - 正文有而 TOC 无 → TOC_DRIFT(extra);
 * - 顺序不一致 → TOC_ORDER;
 * - 目录重复列同一标题 → TOC_DUPLICATE;
 * - index 越界(不在 1..正文标题数)→ TOC_OUT_OF_RANGE;
 * - 全部条目按归一标题都能配上,但声明序号与正文 1-based 位置整体差 1 → TOC_DRIFT(off-by-one),
 * 附修正建议(只建议,不改原文),并抑制由它派生的越界/顺序噪声;
 * - 空目录:默认视为「未声明目录」放行;opts.requireToc=true 时报 TOC_DRIFT(missing-toc)。
 */
export function validateToc(
  toc: readonly TocEntry[],
  headings: readonly HeadingRef[],
  opts: { requireToc?: boolean } = {},
): TocValidation {
  const matched: TocMatch[] = [];
  const issues: TocIssue[] = [];

  if (toc.length === 0) {
    if (opts.requireToc) {
      issues.push({
        code: "TOC_DRIFT",
        kind: "missing-toc",
        entryIndex: 0,
        title: "",
        message: "文档未声明目录,但调用方要求必须有目录",
        suggestion: "补一节「## 目录」并逐条列出标题",
      });
    }
    return {
      ok: issues.length === 0,
      tocEntries: 0,
      headings: headings.length,
      issues,
      matched,
      offByOne: null,
    };
  }

  const normalizedHeadings = headings.map((heading) => ({
    heading,
    norm: normalizeHeading(heading.text),
  }));
  const seen = new Map<string, number>();
  const missing: TocIssue[] = [];
  const duplicate: TocIssue[] = [];
  const range: TocIssue[] = [];
  const pairs: { entry: TocEntry; headingIndex: number }[] = [];

  for (const entry of toc) {
    const norm = normalizeHeading(entry.title);
    if (!norm) {
      missing.push({
        code: "TOC_DRIFT",
        kind: "missing",
        entryIndex: entry.index,
        title: entry.title,
        message: "目录条目归一后为空,无可匹配内容",
      });
      continue;
    }

    const firstSeen = seen.get(norm);
    if (firstSeen !== undefined) {
      duplicate.push({
        code: "TOC_DUPLICATE",
        entryIndex: entry.index,
        title: entry.title,
        expected: firstSeen,
        actual: entry.index,
        message: `目录重复列出「${entry.title}」`,
        suggestion: "保留一条,删掉重复条目",
      });
    } else {
      seen.set(norm, entry.index);
    }

    const hits = normalizedHeadings.filter(({ norm: hNorm }) => hNorm === norm);
    const first = hits[0];
    if (!first) {
      missing.push({
        code: "TOC_DRIFT",
        kind: "missing",
        entryIndex: entry.index,
        title: entry.title,
        message: `目录条目「${entry.title}」在正文标题中找不到`,
      });
    } else if (hits.length > 1) {
      missing.push({
        code: "TOC_DRIFT",
        kind: "ambiguous-heading",
        entryIndex: entry.index,
        title: entry.title,
        actual: hits.map(({ heading }) => heading.index).join(","),
        message: `正文有 ${hits.length} 个标题归一后同名,无法确定指向:${hits
          .map(({ heading }) => `#${heading.index} ${heading.text}`)
          .join(" / ")}`,
      });
      pairs.push({ entry, headingIndex: first.heading.index });
    } else {
      pairs.push({ entry, headingIndex: first.heading.index });
    }

    if (entry.index < 1 || entry.index > headings.length) {
      range.push({
        code: "TOC_OUT_OF_RANGE",
        entryIndex: entry.index,
        title: entry.title,
        expected: `1..${headings.length}`,
        actual: entry.index,
        message: `目录序号 ${entry.index} 越界(正文标题共 ${headings.length} 条)`,
      });
    }
  }

  const deltas = pairs.map((pair) => pair.headingIndex - pair.entry.index);
  const uniform =
    pairs.length === toc.length &&
    deltas.length >= 2 &&
    deltas.every((delta) => delta === deltas[0]);
  const offByOne = uniform && (deltas[0] === 1 || deltas[0] === -1) ? (deltas[0] as number) : null;

  issues.push(...missing, ...duplicate);

  if (offByOne !== null) {
    const suggestion =
      offByOne === 1
        ? "目录疑似 0-based:把每条序号 +1(正文按 1-based 计),或改用 parseAnchor 的 1-based 口径"
        : "目录序号整体偏大 1:把每条序号 -1,或核对是否把正文 1-based 序号写成了 2-based";
    issues.push({
      code: "TOC_DRIFT",
      kind: "off-by-one",
      entryIndex: pairs[0]?.entry.index ?? 0,
      title: "<全表>",
      expected: "目录序号 = 正文 1-based 位置",
      actual: `整体相差 ${offByOne}`,
      message: `目录序号与正文实际 1-based 位置整体相差 ${offByOne},归一标题全部匹配 → 疑似 off-by-one`,
      suggestion,
    });
  } else {
    issues.push(...range);
    for (let i = 1; i < pairs.length; i += 1) {
      const prev = pairs[i - 1];
      const cur = pairs[i];
      if (!prev || !cur) continue;
      if (cur.headingIndex <= prev.headingIndex) {
        issues.push({
          code: "TOC_ORDER",
          entryIndex: cur.entry.index,
          title: cur.entry.title,
          expected: `> ${prev.headingIndex}`,
          actual: cur.headingIndex,
          message: `目录顺序与正文不一致:「${cur.entry.title}」指向第 ${cur.headingIndex} 条,却排在第 ${prev.headingIndex} 条之后`,
          suggestion: "按正文标题顺序重排目录条目",
        });
      }
    }
  }

  for (const { heading, norm } of normalizedHeadings) {
    if (!seen.has(norm)) {
      issues.push({
        code: "TOC_DRIFT",
        kind: "extra",
        entryIndex: 0,
        title: heading.text,
        actual: heading.index,
        message: `正文标题「${heading.text}」(第 ${heading.index} 条)未出现在目录中`,
        suggestion: "补进目录或从正文删除",
      });
    }
  }

  for (const pair of pairs) {
    matched.push({
      entryIndex: pair.entry.index,
      headingIndex: pair.headingIndex,
      title: pair.entry.title,
    });
  }

  return {
    ok: issues.length === 0,
    tocEntries: toc.length,
    headings: headings.length,
    issues,
    matched,
    offByOne,
  };
}
