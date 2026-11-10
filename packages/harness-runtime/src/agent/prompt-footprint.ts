/**
 * Prompt footprint 归因。
 * 回答「常驻提示词到底贵在哪」:把一次请求里**常驻的那部分**按稳定度/来源分块记账,
 * 并给离线 A/B 提供字节断言——改了 A 提示词却动了 B 的字节时立刻报错。
 * 口径(硬约束):
 *  - chars = 分块文本的**逐字长度**(exact,不做换行/空白归一化)。
 *  - 双 tokenizer 两列都报,不合成一个数:
 *      tokensRaw      = 本地分词器原始计数(rawTokens,不乘任何系数);
 *      tokensEstimate = 标定后估算(estimateTokens,乘 provider 标定 ratio,ratio 缺省 1)。
 *    两列都只是本地估算,不读 provider usage。
 *  - 分块类别见 SECTION_CATEGORIES;manifest 里未知类别一律归 "other"(不丢数据、不报错)。
 *  - diff 的硬断言:未在 changedIds 里声明的分块,两边文本必须**逐字节相等**,
 *    否则返回 {ok:false, code:"PROMPT_UNRELATED_BYTES_CHANGED"}。
 *  - 本模块永不抛(manifest 解析用返回值报错)。
 */
import { estimateTokens, rawTokens } from "./token-estimate";

/** 分块类别(顺序即表格顺序)。 */
export const SECTION_CATEGORIES = [
  "stable",
  "context",
  "volatile",
  "skills_index",
  "memory",
  "user_profile",
  "tool_schema",
  "toolset",
  "other",
] as const;

export type SectionCategory = (typeof SECTION_CATEGORIES)[number];

const CATEGORY_SET: ReadonlySet<string> = new Set<string>(SECTION_CATEGORIES);

/** 技能描述硬上限(字符/码点);超限截断并加可见省略号。 */
export const SKILL_DESCRIPTION_MAX = 60;
/** clamp 允许的 max 下限 / 上限(越界按边界钳制)。 */
export const SKILL_DESCRIPTION_MIN = 20;
export const SKILL_DESCRIPTION_HARD_MAX = 200;

export interface FootprintSection {
  /** 分块唯一 id(diff 按 id 对齐)。 */
  id: string;
  /** 类别;未知值归 "other"。 */
  category: string;
  /** 该块原文。 */
  text: string;
}

export interface FootprintTool {
  name: string;
  description?: string;
  parameters?: unknown;
}

export interface FootprintToolsetEntry {
  name: string;
  hint?: string;
}

export interface FootprintInput {
  sections?: FootprintSection[];
  tools?: FootprintTool[];
  toolset?: FootprintToolsetEntry[];
}

export interface FootprintEntry {
  id: string;
  category: SectionCategory;
  chars: number;
  tokensRaw: number;
  tokensEstimate: number;
}

export interface FootprintCategoryStat {
  chars: number;
  tokensRaw: number;
  tokensEstimate: number;
  /** 该类别 tokensEstimate 占总量的比例(0..1;总量 0 → 0)。 */
  share: number;
}

export interface FootprintTotal {
  chars: number;
  tokensRaw: number;
  tokensEstimate: number;
}

export interface FootprintReport {
  entries: FootprintEntry[];
  byCategory: Record<SectionCategory, FootprintCategoryStat>;
  total: FootprintTotal;
  /** 前 5 贡献者(按 tokensEstimate 降序,同值按 chars、id)。 */
  top: FootprintEntry[];
}

/** 未知类别 → "other"。 */
export function normalizeCategory(category: unknown): SectionCategory {
  return typeof category === "string" && CATEGORY_SET.has(category) ? (category as SectionCategory) : "other";
}

/** 安全 JSON 化:循环引用/异常 → ""(不抛)。 */
function safeJson(value: unknown): string {
  try {
    const seen = new WeakSet<object>();
    const out = JSON.stringify(value, (_k, v: unknown) => {
      if (typeof v === "object" && v !== null) {
        if (seen.has(v as object)) return "[circular]";
        seen.add(v as object);
      }
      return v;
    });
    return typeof out === "string" ? out : "";
  } catch {
    return "";
  }
}

/** 一条工具定义的分块文本(键序固定,便于字节比对)。 */
function toolText(tool: FootprintTool): string {
  const name = typeof tool?.name === "string" ? tool.name : "";
  const description = typeof tool?.description === "string" ? tool.description : "";
  const parameters = tool?.parameters === undefined ? "" : safeJson(tool.parameters);
  return JSON.stringify({ name, description, parameters });
}

/** 一条 toolset 条目的分块文本。 */
function toolsetText(entry: FootprintToolsetEntry): string {
  const name = typeof entry?.name === "string" ? entry.name : "";
  const hint = typeof entry?.hint === "string" ? entry.hint : "";
  return `${name}: ${hint}`;
}

function entryOf(id: string, category: SectionCategory, text: string): FootprintEntry {
  return {
    id,
    category,
    chars: text.length,
    tokensRaw: rawTokens(text),
    tokensEstimate: estimateTokens(text),
  };
}

/** id → 分块原文(sections 原文 / tool JSON / toolset hint 文本)。 */
function textsOf(input: FootprintInput | null | undefined): Map<string, string> {
  const safe: FootprintInput = input ?? {};
  const out = new Map<string, string>();
  for (const s of safe.sections ?? []) {
    if (!s || typeof s !== "object") continue;
    out.set(String(s.id ?? ""), typeof s.text === "string" ? s.text : "");
  }
  for (const t of safe.tools ?? []) {
    if (!t || typeof t !== "object") continue;
    out.set(`tool:${String(t.name ?? "")}`, toolText(t));
  }
  for (const t of safe.toolset ?? []) {
    if (!t || typeof t !== "object") continue;
    out.set(`toolset:${String(t.name ?? "")}`, toolsetText(t));
  }
  return out;
}

/** 摊平成逐条分块(保持输入顺序:sections → tools → toolset)。 */
function textEntriesOf(input: FootprintInput | null | undefined): FootprintEntry[] {
  const safe: FootprintInput = input ?? {};
  const out: FootprintEntry[] = [];
  for (const s of safe.sections ?? []) {
    if (!s || typeof s !== "object") continue;
    out.push(entryOf(String(s.id ?? ""), normalizeCategory(s.category), typeof s.text === "string" ? s.text : ""));
  }
  for (const t of safe.tools ?? []) {
    if (!t || typeof t !== "object") continue;
    out.push(entryOf(`tool:${String(t.name ?? "")}`, "tool_schema", toolText(t)));
  }
  for (const t of safe.toolset ?? []) {
    if (!t || typeof t !== "object") continue;
    out.push(entryOf(`toolset:${String(t.name ?? "")}`, "toolset", toolsetText(t)));
  }
  return out;
}

/** 分块归因报告:逐块 chars + 双 token 列,再按类别汇总 + top5。 */
export function buildFootprint(input: FootprintInput): FootprintReport {
  const entries = textEntriesOf(input);
  const byCategory = {} as Record<SectionCategory, FootprintCategoryStat>;
  for (const cat of SECTION_CATEGORIES) byCategory[cat] = { chars: 0, tokensRaw: 0, tokensEstimate: 0, share: 0 };
  const total: FootprintTotal = { chars: 0, tokensRaw: 0, tokensEstimate: 0 };
  for (const e of entries) {
    const stat = byCategory[e.category];
    stat.chars += e.chars;
    stat.tokensRaw += e.tokensRaw;
    stat.tokensEstimate += e.tokensEstimate;
    total.chars += e.chars;
    total.tokensRaw += e.tokensRaw;
    total.tokensEstimate += e.tokensEstimate;
  }
  for (const cat of SECTION_CATEGORIES) {
    byCategory[cat].share = total.tokensEstimate > 0 ? byCategory[cat].tokensEstimate / total.tokensEstimate : 0;
  }
  const top = entries
    .slice()
    .sort((a, b) => b.tokensEstimate - a.tokensEstimate || b.chars - a.chars || a.id.localeCompare(b.id))
    .slice(0, 5);
  return { entries, byCategory, total, top };
}

// ---------------------------------------------------------------------------
// 离线 A/B diff:changedIds 之外的 section 必须字节相等
// ---------------------------------------------------------------------------

export interface FootprintDiffOptions {
  /** 允许发生字节变化的 section id。 */
  changedIds?: readonly string[];
}

export interface FootprintSectionDelta {
  id: string;
  category: SectionCategory;
  charsDelta: number;
  tokensRawDelta: number;
  tokensEstimateDelta: number;
}

export interface FootprintDiffOk {
  ok: true;
  code: "OK";
  /** 声明过且真的变了的分块(逐块双 token 增量)。 */
  changed: FootprintSectionDelta[];
  /** 只在 next / 只在 base 出现过的分块 id。 */
  added: string[];
  removed: string[];
  /** 总量增量(next - base)。 */
  total: { charsDelta: number; tokensRawDelta: number; tokensEstimateDelta: number };
  baseTotal: FootprintTotal;
  nextTotal: FootprintTotal;
}

export interface FootprintDiffUnrelated {
  ok: false;
  code: "PROMPT_UNRELATED_BYTES_CHANGED";
  /** 未声明却改了字节的分块 id。 */
  ids: string[];
}

export type FootprintDiff = FootprintDiffOk | FootprintDiffUnrelated;

function deltaOf(from: FootprintEntry, to: FootprintEntry): FootprintSectionDelta {
  return {
    id: to.id,
    category: to.category,
    charsDelta: to.chars - from.chars,
    tokensRawDelta: to.tokensRaw - from.tokensRaw,
    tokensEstimateDelta: to.tokensEstimate - from.tokensEstimate,
  };
}

/**
 * 两个 manifest 的离线 diff。
 * 硬断言:changedIds 之外、两边都存在的 id 必须逐字节相等;有越界改动即 ok:false。
 */
export function diffFootprint(
  base: FootprintInput,
  next: FootprintInput,
  options: FootprintDiffOptions = {},
): FootprintDiff {
  const changedIds = new Set(options.changedIds ?? []);
  const baseEntries = textEntriesOf(base);
  const nextEntries = textEntriesOf(next);
  const baseText = textsOf(base);
  const nextText = textsOf(next);
  const baseById = new Map<string, { entry: FootprintEntry; text: string }>();
  const nextById = new Map<string, { entry: FootprintEntry; text: string }>();
  for (const e of baseEntries) baseById.set(e.id, { entry: e, text: baseText.get(e.id) ?? "" });
  for (const e of nextEntries) nextById.set(e.id, { entry: e, text: nextText.get(e.id) ?? "" });

  const unrelated: string[] = [];
  const changed: FootprintSectionDelta[] = [];
  for (const [id, b] of baseById) {
    const n = nextById.get(id);
    if (!n) continue;
    if (b.text === n.text) continue;
    if (!changedIds.has(id)) unrelated.push(id);
    else changed.push(deltaOf(b.entry, n.entry));
  }
  if (unrelated.length > 0) {
    return { ok: false, code: "PROMPT_UNRELATED_BYTES_CHANGED", ids: unrelated.sort((a, b) => a.localeCompare(b)) };
  }
  const added: string[] = [];
  for (const id of nextById.keys()) if (!baseById.has(id)) added.push(id);
  const removed: string[] = [];
  for (const id of baseById.keys()) if (!nextById.has(id)) removed.push(id);
  const baseTotal = buildFootprint(base).total;
  const nextTotal = buildFootprint(next).total;
  return {
    ok: true,
    code: "OK",
    changed: changed.sort((a, b) => a.id.localeCompare(b.id)),
    added: added.sort((a, b) => a.localeCompare(b)),
    removed: removed.sort((a, b) => a.localeCompare(b)),
    total: {
      charsDelta: nextTotal.chars - baseTotal.chars,
      tokensRawDelta: nextTotal.tokensRaw - baseTotal.tokensRaw,
      tokensEstimateDelta: nextTotal.tokensEstimate - baseTotal.tokensEstimate,
    },
    baseTotal,
    nextTotal,
  };
}

// ---------------------------------------------------------------------------
// 技能描述钳制(60 字符硬限)
// ---------------------------------------------------------------------------

export interface ClampedDescription {
  /** 截断后的文本(超限部分以 "…" 收尾)。 */
  text: string;
  truncated: boolean;
  originalLength: number;
  /** 实际生效的上限(已钳制到 20..200)。 */
  max: number;
}

/**
 * 技能描述硬限:超限按**码点**截取(不裂代理对)并追加 "…"。
 * max 超出 20..200 → 钳到边界;非有限数 → 默认 60。
 * 注:按码点与旧实现的 slice(0,max) 只在「跨 BMP 的 emoji 恰好落在边界」时不同,
 * 现有经验库全为 BMP 文本,故 renderExperienceIndex 输出逐字节不变。
 */
export function clampSkillDescription(desc: string, max: number = SKILL_DESCRIPTION_MAX): ClampedDescription {
  const limit = Number.isFinite(max)
    ? Math.min(SKILL_DESCRIPTION_HARD_MAX, Math.max(SKILL_DESCRIPTION_MIN, Math.trunc(max)))
    : SKILL_DESCRIPTION_MAX;
  const text = typeof desc === "string" ? desc : "";
  if (text.length <= limit) return { text, truncated: false, originalLength: text.length, max: limit };
  const points = Array.from(text);
  if (points.length <= limit) return { text, truncated: false, originalLength: text.length, max: limit };
  return { text: `${points.slice(0, limit).join("")}…`, truncated: true, originalLength: text.length, max: limit };
}

// ---------------------------------------------------------------------------
// manifest 解析(JSON)
// ---------------------------------------------------------------------------

export interface ManifestParseOk {
  ok: true;
  input: FootprintInput;
}

export interface ManifestParseFail {
  ok: false;
  code: "MANIFEST_JSON_INVALID" | "MANIFEST_INVALID";
  message: string;
}

export type ManifestParseResult = ManifestParseOk | ManifestParseFail;

function fail(code: ManifestParseFail["code"], message: string): ManifestParseFail {
  return { ok: false, code, message };
}

/**
 * 解析 footprint manifest(JSON 字符串或已解析值)。
 * 未知 category 归 "other";缺 id / 缺 category → MANIFEST_INVALID。
 */
export function parseFootprintManifest(raw: string | unknown): ManifestParseResult {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch (err) {
      return fail("MANIFEST_JSON_INVALID", `JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("MANIFEST_INVALID", "manifest 根必须是对象");
  }
  const root = value as Record<string, unknown>;

  const sectionsRaw = root["sections"];
  if (sectionsRaw !== undefined && !Array.isArray(sectionsRaw)) {
    return fail("MANIFEST_INVALID", "sections 必须是数组");
  }
  const sections: FootprintSection[] = [];
  const sectionList = (sectionsRaw as unknown[] | undefined) ?? [];
  for (let i = 0; i < sectionList.length; i += 1) {
    const item = sectionList[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return fail("MANIFEST_INVALID", `sections[${i}] 必须是对象`);
    }
    const s = item as Record<string, unknown>;
    if (typeof s["id"] !== "string" || s["id"].length === 0) {
      return fail("MANIFEST_INVALID", `sections[${i}] 缺 id`);
    }
    if (typeof s["category"] !== "string" || s["category"].length === 0) {
      return fail("MANIFEST_INVALID", `sections[${i}](id=${s["id"]}) 缺 category`);
    }
    sections.push({
      id: s["id"],
      category: normalizeCategory(s["category"]),
      text: typeof s["text"] === "string" ? s["text"] : "",
    });
  }

  const toolsRaw = root["tools"];
  if (toolsRaw !== undefined && !Array.isArray(toolsRaw)) {
    return fail("MANIFEST_INVALID", "tools 必须是数组");
  }
  const tools: FootprintTool[] = [];
  for (const item of (toolsRaw as unknown[] | undefined) ?? []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return fail("MANIFEST_INVALID", "tools 项必须是对象");
    }
    const t = item as Record<string, unknown>;
    if (typeof t["name"] !== "string" || t["name"].length === 0) {
      return fail("MANIFEST_INVALID", "tools 项缺 name");
    }
    tools.push({
      name: t["name"],
      description: typeof t["description"] === "string" ? t["description"] : undefined,
      parameters: t["parameters"],
    });
  }

  const toolsetRaw = root["toolset"];
  if (toolsetRaw !== undefined && !Array.isArray(toolsetRaw)) {
    return fail("MANIFEST_INVALID", "toolset 必须是数组");
  }
  const toolset: FootprintToolsetEntry[] = [];
  for (const item of (toolsetRaw as unknown[] | undefined) ?? []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return fail("MANIFEST_INVALID", "toolset 项必须是对象");
    }
    const t = item as Record<string, unknown>;
    if (typeof t["name"] !== "string" || t["name"].length === 0) {
      return fail("MANIFEST_INVALID", "toolset 项缺 name");
    }
    toolset.push({ name: t["name"], hint: typeof t["hint"] === "string" ? t["hint"] : undefined });
  }

  return { ok: true, input: { sections, tools, toolset } };
}
