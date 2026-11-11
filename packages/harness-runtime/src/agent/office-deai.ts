/**
 * 办公输出「去 AI 味」审计(Office De-AI Audit)——纯逻辑。
 * 为什么要有这一层,而不是继续把「避免 AI 味」写成提示词清单:
 * - 提示词清单只能对模型喊话,喊完无从判定是否照做;这里把清单变成正则规则表 + 可复现打分,
 * 同一份文件跑两次必须同分,评审时能指着 findings 说「这一句命中了哪条规则」。
 * - 规则必须带稳定 id 与稳定码:命中项要能被豁免、豁免要能被审计(谁在什么理由下放过了哪一句),
 * 用自然语言描述规则会随措辞漂移,id 不会。
 * - 打分只看「加权命中密度」而不看命中绝对条数:长文档天然会命中更多词,按绝对条数打分会把
 * 篇幅当罪证;归一化到每千字之后,长短文档可比。
 * - 纯函数:零 IO、零时钟、零随机、不 import 第三方。同样的输入必然同样的输出,
 * 这是「可复现」的全部含义;要时间/文件/网络的部分留给 gateway store 与 CLI。
 * 归一化口径(改这里等于改历史分数,必须同步 DEAI_RULES_VERSION):
 * - score = 100 * (1 - e^(-加权命中/千字 / SATURATION)) + 结构惩罚(排比/清单同构),
 * 截断到 0..100 取整。饱和函数的好处是「命中极多」不会线性冲顶,而是逼近 100,
 * 避免一篇 200 字的模板文与一篇 5000 字的烂文拿到同一个 100。
 * - 单条规则最多按 6 次命中计分(SCORE_HITS_CAP):同一个词被抓 50 次是复读,不是 50 倍 AI 味;
 * findings 仍逐条保留(最多 maxFindings),只是计分不再叠加。
 * 所有导出函数不抛异常:非法输入返回稳定码(DEAI_INVALID 等),返回对象每次新建,
 * 传入的 result / exemptions 数组不会被改写。
 */

/** 规则表版本:任何规则/权重/打分常数变动都必须改这个版本号,历史报告据此判断可比性。 */
export const DEAI_RULES_VERSION = "1.0.0";

/** 稳定码:每个码对应一个可判定的结局(调用方按码分流,不解析中文文案)。 */
export const DEAI_CODES = [
  "DEAI_OK",
  "DEAI_EMPTY",
  "DEAI_INVALID",
  "DEAI_EXEMPTION_INVALID",
  "DEAI_EXEMPTION_UNUSED",
  "DEAI_THRESHOLD_FAIL",
  "DEAI_THRESHOLD_WARN",
] as const;

export type DeaiCode = (typeof DEAI_CODES)[number];

/** 文档类别:只影响「预处理方式」(md 剥代码块),不影响规则表。 */
export type DeaiKind = "md" | "txt" | "docx" | "pptx" | "xlsx";

/** 规则类别:七类必须都有规则,否则「去 AI 味」只覆盖了一半(见测试)。 */
export type DeaiCategory =
  | "puffery"
  | "hedging"
  | "template"
  | "connector"
  | "meta"
  | "emoji"
  | "symmetry";

export type DeaiSeverity = "low" | "medium" | "high";
export type DeaiLocale = "zh" | "en";
export type DeaiVerdict = "pass" | "warn" | "fail";

/** 单条规则的匹配模式:刻意存正则源码字符串而不是 RegExp 实例——规则表要能被 JSON 序列化/审计。 */
export interface DeaiPattern {
  source: string;
  flags: string;
}

export interface DeaiRule {
  id: string;
  category: DeaiCategory;
 /** 权重:同一处命中,「作为 AI 语言模型」比「首先…其次」更该扣分。 */
  weight: number;
  patterns: DeaiPattern[];
  severity: DeaiSeverity;
  locales: DeaiLocale[];
 /** 给人看的改法提示(报告里直接展示,不参与计算)。 */
  hint: string;
}

/** 命中项:offset/length 指向「预处理后」的文本(md 已剥代码块)。 */
export interface DeaiFinding {
  ruleId: string;
  category: DeaiCategory;
  severity: DeaiSeverity;
  excerpt: string;
  offset: number;
  length: number;
  hint: string;
}

export interface DeaiStats {
  chars: number;
  sentences: number;
  findings: number;
  densityPerKilo: number;
  bulletUniformity: number;
  bullets: number;
  avgSentenceLength: number;
  sentenceLengthStdDev: number;
  emojiDensity: number;
  codeBlocksStripped: number;
}

/** 打分/阈值轨迹:报告要能自己解释「为什么是 63 分」,不能只给一个数。 */
export interface DeaiAudit {
  rulesVersion: string;
  kind: DeaiKind;
  warnThreshold: number;
  failThreshold: number;
  exemptionsApplied: number;
  formula: "deai-sat-v1";
  saturation: number;
  weightedHits: number;
  weightedPerKilo: number;
  densityScore: number;
  bulletPenalty: number;
  cappedRules: number;
}

export interface DeaiResult {
  ok: boolean;
  codes: DeaiCode[];
  score: number;
  verdict: DeaiVerdict;
  findings: DeaiFinding[];
  stats: DeaiStats;
  audit: DeaiAudit;
}

export interface DeaiAnalyzeInput {
  text: string;
  kind?: DeaiKind;
}

export interface DeaiOptions {
  warnThreshold?: number;
  failThreshold?: number;
  maxFindings?: number;
  maxHitsPerRuleForScore?: number;
}

/** 豁免条目:按「规则 + 归一化 excerpt 精确匹配」消费,reason 必填(审计留痕,不是可选备注)。 */
export interface DeaiExemption {
  ruleId: string;
  excerpt: string;
  reason: string;
  owner?: string;
}

export interface DeaiExemptionOutcome {
  applied: DeaiExemption[];
  unused: DeaiExemption[];
  invalid: DeaiExemption[];
  appliedFindings: number;
}

export interface DeaiExemptedResult extends DeaiResult {
  exemptions: DeaiExemptionOutcome;
  residualFindings: DeaiFinding[];
  residualScore: number;
  residualVerdict: DeaiVerdict;
}

export interface DeaiRuleHit {
  ruleId: string;
  category: DeaiCategory;
  count: number;
}

export interface DeaiMergeReport {
  ok: boolean;
  codes: DeaiCode[];
  rulesVersion: string;
  docs: number;
  worstVerdict: DeaiVerdict;
  averageScore: number;
  verdicts: Record<DeaiVerdict, number>;
  ruleHits: DeaiRuleHit[];
}

export interface DeaiMergeInput {
  id?: string;
  result: DeaiResult;
}

const DEFAULT_WARN = 40;
const DEFAULT_FAIL = 60;
const DEFAULT_MAX_FINDINGS = 500;
/** 计分时单条规则的命中次数上限:复读不等于多倍 AI 味。 */
const SCORE_HITS_CAP = 6;
/** 饱和常数:加权命中密度达到 SATURATION 时约得 63 分,是「明显有 AI 味」的手感基准。 */
const SATURATION = 20;
/** 结构惩罚上限:清单/排比同构是最软的一类信号,单独不足以判 fail。 */
const BULLET_PENALTY_MAX = 12;
const EXCERPT_MAX = 40;

/**
 * 规则表(31 条:zh 15 / en 14,emoji 两条双语)。
 * 为什么这样分七类:这七类对应「读起来像 AI」的实际成因——空泛夸张(puffery)、
 * 不敢下结论(hedging)、模板开场收尾(template)、机械连接词(connector)、
 * 自我指涉(meta)、表情滥用(emoji)、排比同构(symmetry)。缺任何一类,
 * 分数就无法解释某一类文档为什么读起来怪。
 */
export const DEAI_RULES: readonly DeaiRule[] = [
 // ── puffery 空泛夸张 ───────────────────────────────────────────────
  {
    id: "zh-puffery-core",
    category: "puffery",
    weight: 2,
    patterns: [{ source: String.raw`赋能|闭环|抓手|护城河|组合拳`, flags: "g" }],
    severity: "high",
    locales: ["zh"],
    hint: "换成具体做了什么、影响了谁、量级多少;「赋能/闭环」这类词本身不携带信息。",
  },
  {
    id: "zh-puffery-grand",
    category: "puffery",
    weight: 1.5,
    patterns: [{ source: String.raw`全方位|多维度|深度融合|顶层设计|生态化|生态闭环`, flags: "g" }],
    severity: "medium",
    locales: ["zh"],
    hint: "删掉范围副词,直接说覆盖的边界与不覆盖的部分。",
  },
  {
    id: "zh-puffery-hype",
    category: "puffery",
    weight: 1.5,
    patterns: [{ source: String.raw`极致|颠覆|引领行业|打造世界级|一站式|数智化|降本增效`, flags: "g" }],
    severity: "medium",
    locales: ["zh"],
    hint: "形容词换成可核对的指标(耗时、成本、覆盖率)。",
  },
  {
    id: "en-puffery-buzzword",
    category: "puffery",
    weight: 2,
    patterns: [
      { source: String.raw`\b(?:leverag\w*|synerg\w*|holistic|empower\w*|best-in-class|world-class)\b`, flags: "gi" },
    ],
    severity: "high",
    locales: ["en"],
    hint: "Name the action and the measured effect instead of the buzzword.",
  },
  {
    id: "en-puffery-hype",
    category: "puffery",
    weight: 1.5,
    patterns: [
      {
        source: String.raw`\b(?:robust|seamless\w*|cutting-edge|game-chang\w*|revolutionar\w*|unlock\w*|next-gen)\b`,
        flags: "gi",
      },
    ],
    severity: "medium",
    locales: ["en"],
    hint: "Replace the adjective with the concrete constraint it is hiding.",
  },
 // ── hedging 模棱两可 ───────────────────────────────────────────────
  {
    id: "zh-hedging-maybe",
    category: "hedging",
    weight: 1,
    patterns: [{ source: String.raw`或许|也许|可能会?|大概是`, flags: "g" }],
    severity: "medium",
    locales: ["zh"],
    hint: "要么给出判断与依据,要么明确写「未验证,原因如下」。",
  },
  {
    id: "zh-hedging-vague-source",
    category: "hedging",
    weight: 1.2,
    patterns: [{ source: String.raw`据说|据悉|据了解|相关人士|业内普遍认为`, flags: "g" }],
    severity: "medium",
    locales: ["zh"],
    hint: "补出处(谁、哪份材料、哪一天),否则这句不算证据。",
  },
  {
    id: "en-hedging-soft",
    category: "hedging",
    weight: 1,
    patterns: [{ source: String.raw`\b(?:it (?:seems|appears)|to some extent|arguably|more or less)\b`, flags: "gi" }],
    severity: "medium",
    locales: ["en"],
    hint: "State the claim or mark it explicitly as an assumption.",
  },
  {
    id: "en-hedging-vague-source",
    category: "hedging",
    weight: 1.2,
    patterns: [
      {
        source: String.raw`\b(?:it is (?:widely )?believed|(?:some|many) (?:people|experts) (?:say|believe)|studies show)\b`,
        flags: "gi",
      },
    ],
    severity: "medium",
    locales: ["en"],
    hint: "Cite the study or drop the appeal to unnamed authority.",
  },
  {
    id: "en-hedging-filler",
    category: "hedging",
    weight: 0.8,
    patterns: [
      { source: String.raw`\b(?:very|really|quite|extremely) (?:important|significant|critical)\b`, flags: "gi" },
    ],
    severity: "low",
    locales: ["en"],
    hint: "Delete the intensifier; if it matters, show why.",
  },
 // ── template 套话开场白/总结语 ─────────────────────────────────────
  {
    id: "zh-template-opening",
    category: "template",
    weight: 2,
    patterns: [{ source: String.raw`在当今.{0,12}?时代|随着.{0,20}?的(?:不断)?(?:发展|进步|普及)`, flags: "g" }],
    severity: "high",
    locales: ["zh"],
    hint: "删掉时间背景开场,第一句直接给结论或问题。",
  },
  {
    id: "zh-template-invite",
    category: "template",
    weight: 1.5,
    patterns: [
      { source: String.raw`让我们(?:一起)?(?:来)?(?:看看|探讨|探索)|接下来(?:我们)?(?:来看|看看)`, flags: "g" },
    ],
    severity: "medium",
    locales: ["zh"],
    hint: "把「我们来聊聊」换成要讨论的具体问题。",
  },
  {
    id: "zh-template-closing",
    category: "template",
    weight: 2,
    patterns: [
      { source: String.raw`希望(?:本文|这篇|以上)|以上就是(?:本文|今天)|感谢(?:大家)?(?:的)?阅读`, flags: "g" },
    ],
    severity: "high",
    locales: ["zh"],
    hint: "结尾给决议/下一步/负责人,不要用客套话收尾。",
  },
  {
    id: "zh-template-outline",
    category: "template",
    weight: 1.5,
    patterns: [{ source: String.raw`本文将从.{0,20}?(?:几个)?方面|下面(?:将)?从.{0,12}?角度`, flags: "g" }],
    severity: "medium",
    locales: ["zh"],
    hint: "目录本身就是结构;不要用一句话预告目录。",
  },
  {
    id: "en-template-opening",
    category: "template",
    weight: 2,
    patterns: [{ source: String.raw`\bIn today'?s (?:fast-paced|rapidly|ever-changing|digital|modern)\b`, flags: "gi" }],
    severity: "high",
    locales: ["en"],
    hint: "Lead with the claim; drop the era-setting preamble.",
  },
  {
    id: "en-template-invite",
    category: "template",
    weight: 1.5,
    patterns: [{ source: String.raw`\b(?:Let'?s|Let us) (?:dive|explore|take a look|unpack)\b`, flags: "gi" }],
    severity: "medium",
    locales: ["en"],
    hint: "Ask the real question instead of inviting the reader along.",
  },
  {
    id: "en-template-closing",
    category: "template",
    weight: 2,
    patterns: [{ source: String.raw`\bI hope this (?:helps|article|guide)\b|\bThanks for reading\b`, flags: "gi" }],
    severity: "high",
    locales: ["en"],
    hint: "Close with the decision or next step, not with courtesy.",
  },
 // ── connector 机械连接词 ───────────────────────────────────────────
  {
    id: "zh-connector-sequence",
    category: "connector",
    weight: 1,
    patterns: [{ source: String.raw`首先[，,]?[\s\S]{0,120}?其次|其次[，,]?[\s\S]{0,120}?最后`, flags: "g" }],
    severity: "medium",
    locales: ["zh"],
    hint: "用因果/条件替代序数罗列:读者要的是关系,不是编号。",
  },
  {
    id: "zh-connector-summary",
    category: "connector",
    weight: 1.2,
    patterns: [{ source: String.raw`综上所述|总而言之|总的来说|由此可见|不难看出`, flags: "g" }],
    severity: "medium",
    locales: ["zh"],
    hint: "直接写结论句;「综上」不增加信息。",
  },
  {
    id: "en-connector-linear",
    category: "connector",
    weight: 1,
    patterns: [
      {
        source: String.raw`^(?:Furthermore|Moreover|Additionally|In addition|Firstly|Secondly|Lastly)\b`,
        flags: "gim",
      },
    ],
    severity: "medium",
    locales: ["en"],
    hint: "Drop the discourse marker; connect by meaning instead.",
  },
  {
    id: "en-connector-summary",
    category: "connector",
    weight: 1.2,
    patterns: [{ source: String.raw`\bIn conclusion\b|\bTo summari[sz]e\b|\bAll in all\b`, flags: "gi" }],
    severity: "medium",
    locales: ["en"],
    hint: "Write the conclusion sentence itself.",
  },
 // ── meta AI 自我指涉 ──────────────────────────────────────────────
  {
    id: "zh-meta-identity",
    category: "meta",
    weight: 3,
    patterns: [{ source: String.raw`作为(?:一个|一名)?\s*(?:AI|人工智能)(?:语言模型|助手|模型)?`, flags: "g" }],
    severity: "high",
    locales: ["zh"],
    hint: "删掉身份声明:读者关心内容,不关心写作者的类别。",
  },
  {
    id: "zh-meta-limits",
    category: "meta",
    weight: 2,
    patterns: [
      { source: String.raw`我(?:无法|不能)(?:访问|浏览|获取|查看)|根据我的(?:训练数据|知识截止|知识库)`, flags: "g" },
    ],
    severity: "high",
    locales: ["zh"],
    hint: "能力边界写成流程约束(需要人工补哪一步),不要写成自述。",
  },
  {
    id: "en-meta-identity",
    category: "meta",
    weight: 3,
    patterns: [{ source: String.raw`\bas an AI (?:language )?model\b`, flags: "gi" }],
    severity: "high",
    locales: ["en"],
    hint: "Remove the self-identification sentence.",
  },
  {
    id: "en-meta-limits",
    category: "meta",
    weight: 2,
    patterns: [
      {
        source: String.raw`\bI (?:cannot|can'?t) (?:browse|access|see)\b|\bmy (?:training data|knowledge cutoff)\b`,
        flags: "gi",
      },
    ],
    severity: "high",
    locales: ["en"],
    hint: "Express the limitation as a checklist item, not as self-narration.",
  },
 // ── emoji 滥用(中英通用) ─────────────────────────────────────────
  {
    id: "emoji-cluster",
    category: "emoji",
    weight: 0.8,
    patterns: [{ source: String.raw`(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}][\s]*){2,}`, flags: "gu" }],
    severity: "medium",
    locales: ["zh", "en"],
    hint: "去掉成串表情:正式文档里它们只增加视觉噪声。",
  },
  {
    id: "emoji-decorative",
    category: "emoji",
    weight: 0.6,
    patterns: [{ source: String.raw`^[\s>#*+-]*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]`, flags: "gmu" }],
    severity: "low",
    locales: ["zh", "en"],
    hint: "标题行/列表行前的装饰表情可以直接删。",
  },
 // ── symmetry 排比/清单同构 ────────────────────────────────────────
  {
    id: "zh-symmetry-notonly",
    category: "symmetry",
    weight: 1.2,
    patterns: [{ source: String.raw`不仅[\s\S]{0,30}?而且`, flags: "g" }],
    severity: "medium",
    locales: ["zh"],
    hint: "「不仅…而且」常用来凑气势;拆成两个独立结论更清楚。",
  },
  {
    id: "zh-symmetry-parallel",
    category: "symmetry",
    weight: 1,
    patterns: [{ source: String.raw`一方面[\s\S]{0,60}?另一方面|既[\s\S]{0,20}?又`, flags: "g" }],
    severity: "medium",
    locales: ["zh"],
    hint: "两面并列若无对比意义,只留结论更有力。",
  },
  {
    id: "en-symmetry-notonly",
    category: "symmetry",
    weight: 1.2,
    patterns: [{ source: String.raw`\bnot only\b[\s\S]{0,60}?\bbut also\b`, flags: "gi" }],
    severity: "medium",
    locales: ["en"],
    hint: "Split into two plain statements.",
  },
  {
    id: "en-symmetry-listicle",
    category: "symmetry",
    weight: 1,
    patterns: [{ source: String.raw`\bFirst(?:ly)?\b[\s\S]{0,120}?\bSecond(?:ly)?\b`, flags: "gi" }],
    severity: "medium",
    locales: ["en"],
    hint: "Three ordered points is a listicle, not an argument; state the relation.",
  },
];

/** 规则类别全表(测试与报告都用它判断覆盖度)。 */
export const DEAI_CATEGORIES: readonly DeaiCategory[] = [
  "puffery",
  "hedging",
  "template",
  "connector",
  "meta",
  "emoji",
  "symmetry",
];

const KINDS: readonly DeaiKind[] = ["md", "txt", "docx", "pptx", "xlsx"];
const VERDICTS: readonly DeaiVerdict[] = ["pass", "warn", "fail"];

/** 归一化 excerpt 的口径:把空白折叠、去首尾、小写(英文大小写不该影响豁免)。 */
export function normalizeExcerpt(text: string): string {
  if (typeof text !== "string") return "";
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value);
  if (rounded < 0) return 0;
  if (rounded > 100) return 100;
  return rounded;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 剥离 md 的围栏代码块:代码块里出现 `leverage` 是代码,不是 AI 味。
 * 返回剥离后的文本与块数(计数要报给报告:读者据此知道统计口径)。
 */
function stripFencedCode(text: string): { text: string; stripped: number } {
  let stripped = 0;
  let out = text.replace(/^([ \t]*)(?:```|~~~)[^\n]*\n[\s\S]*?^\1(?:```|~~~)[ \t]*$/gm, () => {
    stripped += 1;
    return "";
  });
 // 未闭合的围栏(文档尾部截断)按「到结尾都是代码」处理,否则残段会被当成正文。
  const unclosed = out.search(/^[ \t]*(?:```|~~~)/m);
  if (unclosed >= 0) {
    out = out.slice(0, unclosed);
    stripped += 1;
  }
  return { text: out, stripped };
}

/** 句子切分:中英标点与换行都算边界;空段丢弃(否则句长统计被空行拉低)。 */
function splitSentences(text: string): string[] {
  return text
    .split(/[。！？!?；;\.\n]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

const BULLET_LINE_RE = /^[\s>]*(?:[-*+•]|\d{1,2}[.)])\s+(.*)$/;

/** 清单统计:同构率 = 1 - 标准差/均值(≥4 条才计算,少于 4 条谈同构没有意义)。 */
function bulletStats(text: string): { bullets: number; uniformity: number } {
  const lengths: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = BULLET_LINE_RE.exec(line);
    if (match === null) continue;
    const body = (match[1] ?? "").trim();
    if (body.length === 0) continue;
    lengths.push([...body].length);
  }
  if (lengths.length < 4) return { bullets: lengths.length, uniformity: 0 };
  const mean = lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
  if (mean <= 0) return { bullets: lengths.length, uniformity: 0 };
  const variance = lengths.reduce((sum, value) => sum + (value - mean) ** 2, 0) / lengths.length;
  const sd = Math.sqrt(variance);
  const uniformity = Math.max(0, Math.min(1, 1 - sd / mean));
  return { bullets: lengths.length, uniformity: round2(uniformity) };
}

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu;

function countEmoji(text: string): number {
  let count = 0;
  for (const _match of text.matchAll(EMOJI_RE)) count += 1;
  return count;
}

/**
 * 加权命中密度 → 分数。
 * 结构惩罚单独加(out of density),因为它是「形态」信号:六条长短完全一致的要点本身不是错,
 * 但在 AI 文里几乎总与套话同时出现,给它一个最高 12 分的补充权重,不足以单独判 fail。
 */
function scoreOf(
  findings: DeaiFinding[],
  chars: number,
  bulletUniformity: number,
  maxHitsPerRule: number): {
  score: number;
  weightedHits: number;
  weightedPerKilo: number;
  densityScore: number;
  bulletPenalty: number;
  cappedRules: number;
} {
  const weightOf = new Map<string, number>();
  for (const rule of DEAI_RULES) weightOf.set(rule.id, rule.weight);
  const counts = new Map<string, number>();
  for (const finding of findings) counts.set(finding.ruleId, (counts.get(finding.ruleId) ?? 0) + 1);
  let weightedHits = 0;
  let cappedRules = 0;
  for (const [ruleId, count] of counts) {
    const weight = weightOf.get(ruleId);
    if (weight === undefined) continue; // 未知规则(旧报告)不参与计分,但保留在 findings 里
    if (count > maxHitsPerRule) cappedRules += 1;
    weightedHits += Math.min(count, maxHitsPerRule) * weight;
  }
  const weightedPerKilo = chars > 0 ? (weightedHits * 1000) / chars : 0;
  const densityScore = 100 * (1 - Math.exp(-weightedPerKilo / SATURATION));
  const bulletPenalty = Math.round(bulletUniformity * BULLET_PENALTY_MAX);
  return {
    score: clampScore(densityScore + bulletPenalty),
    weightedHits: round2(weightedHits),
    weightedPerKilo: round2(weightedPerKilo),
    densityScore: round2(densityScore),
    bulletPenalty,
    cappedRules,
  };
}

function verdictOf(score: number, warn: number, fail: number): DeaiVerdict {
  if (score >= fail) return "fail";
  if (score >= warn) return "warn";
  return "pass";
}

/** 阈值校验:两个都必须是 0..100 的数字且 warn < fail,否则回到缺省(返回稳定码而不是抛)。 */
function resolveThresholds(opts: DeaiOptions | undefined): { warn: number; fail: number; invalid: boolean } {
  const warnRaw = opts?.warnThreshold;
  const failRaw = opts?.failThreshold;
  const warn = typeof warnRaw === "number" && Number.isFinite(warnRaw) ? warnRaw : DEFAULT_WARN;
  const fail = typeof failRaw === "number" && Number.isFinite(failRaw) ? failRaw : DEFAULT_FAIL;
  if (warn < 0 || warn > 100 || fail < 0 || fail > 100 || warn >= fail) {
    return { warn: DEFAULT_WARN, fail: DEFAULT_FAIL, invalid: true };
  }
  return { warn, fail, invalid: false };
}

/** 空结果(非法输入/空文本共用):字段齐全,保证下游不必分情况解引用。 */
function emptyResult(codes: DeaiCode[], kind: DeaiKind, warn: number, fail: number): DeaiResult {
  return {
    ok: codes.length === 0 || (codes.length === 1 && codes[0] === "DEAI_EMPTY"),
    codes,
    score: 0,
    verdict: "pass",
    findings: [],
    stats: {
      chars: 0,
      sentences: 0,
      findings: 0,
      densityPerKilo: 0,
      bulletUniformity: 0,
      bullets: 0,
      avgSentenceLength: 0,
      sentenceLengthStdDev: 0,
      emojiDensity: 0,
      codeBlocksStripped: 0,
    },
    audit: {
      rulesVersion: DEAI_RULES_VERSION,
      kind,
      warnThreshold: warn,
      failThreshold: fail,
      exemptionsApplied: 0,
      formula: "deai-sat-v1",
      saturation: SATURATION,
      weightedHits: 0,
      weightedPerKilo: 0,
      densityScore: 0,
      bulletPenalty: 0,
      cappedRules: 0,
    },
  };
}

/**
 * 审计一份文档。
 * 输入 `{text, kind}`;kind 缺省 txt(md 才会剥代码块,别的类别当纯文本)。
 * 非法输入(非对象 / text 不是字符串)= ok:false + DEAI_INVALID,不抛。
 */
export function analyzeDocument(input: DeaiAnalyzeInput | undefined, opts?: DeaiOptions): DeaiResult {
  const thresholds = resolveThresholds(opts);
  const codes: DeaiCode[] = [];
  if (thresholds.invalid) codes.push("DEAI_INVALID");

  const kindRaw = isPlainObject(input) ? (input as { kind?: unknown }).kind : undefined;
  const kind: DeaiKind =
    typeof kindRaw === "string" && (KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as DeaiKind) : "txt";
  if (typeof kindRaw === "string" && !(KINDS as readonly string[]).includes(kindRaw)) codes.push("DEAI_INVALID");

  if (!isPlainObject(input) || typeof (input as { text?: unknown }).text !== "string") {
    const result = emptyResult(
      Array.from(new Set([...codes, "DEAI_INVALID" as DeaiCode])),
      kind,
      thresholds.warn,
      thresholds.fail);
    result.ok = false;
    return result;
  }

  const rawText = (input as { text: string }).text;
  const stripped = kind === "md" ? stripFencedCode(rawText) : { text: rawText, stripped: 0 };
  const analyzed = stripped.text;
  const chars = analyzed.length;
  if (chars === 0) {
    const result = emptyResult(
      Array.from(new Set([...codes, "DEAI_EMPTY" as DeaiCode])),
      kind,
      thresholds.warn,
      thresholds.fail);
    result.stats.codeBlocksStripped = stripped.stripped; // 全是代码块的 md:字数 0 但剥离块数要如实留痕
    return result;
  }

  const maxFindings =
    typeof opts?.maxFindings === "number" && opts.maxFindings > 0 ? Math.floor(opts.maxFindings) : DEFAULT_MAX_FINDINGS;
  const maxHitsPerRule =
    typeof opts?.maxHitsPerRuleForScore === "number" && opts.maxHitsPerRuleForScore > 0
      ? Math.floor(opts.maxHitsPerRuleForScore)
      : SCORE_HITS_CAP;

  const seen = new Set<string>();
  const findings: DeaiFinding[] = [];
  for (const rule of DEAI_RULES) {
    for (const pattern of rule.patterns) {
      let re: RegExp;
      try {
 // 每次新建 RegExp:带 g 的实例有 lastIndex 状态,复用会让第二次调用漏检(确定性关键)。
        re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
      } catch {
        continue; // 坏规则不拖垮整篇分析(规则表本身由测试守住)
      }
      for (const match of analyzed.matchAll(re)) {
        const matched = match[0];
        if (matched.length === 0) continue;
        const offset = match.index ?? 0;
        const key = `${rule.id}@${offset}`;
        if (seen.has(key)) continue; // 同规则同位置只记一次(模式互相包含时不重复扣分)
        seen.add(key);
        const excerpt = normalizeExcerpt(matched).slice(0, EXCERPT_MAX);
        findings.push({
          ruleId: rule.id,
          category: rule.category,
          severity: rule.severity,
          excerpt,
          offset,
          length: matched.length,
          hint: rule.hint,
        });
        if (findings.length >= maxFindings) break;
      }
      if (findings.length >= maxFindings) break;
    }
    if (findings.length >= maxFindings) break;
  }
  findings.sort((a, b) => (a.offset === b.offset ? a.ruleId.localeCompare(b.ruleId) : a.offset - b.offset));

  const sentences = splitSentences(analyzed);
  const sentenceLengths = sentences.map((sentence) => [...sentence].length);
  const sentenceMean =
    sentenceLengths.length > 0 ? sentenceLengths.reduce((sum, value) => sum + value, 0) / sentenceLengths.length : 0;
  const sentenceVariance =
    sentenceLengths.length > 0
      ? sentenceLengths.reduce((sum, value) => sum + (value - sentenceMean) ** 2, 0) / sentenceLengths.length
      : 0;
  const emojiCount = countEmoji(analyzed);
  const bullets = bulletStats(analyzed);
  const scored = scoreOf(findings, chars, bullets.uniformity, maxHitsPerRule);
  const verdict = verdictOf(scored.score, thresholds.warn, thresholds.fail);

  const finalCodes: DeaiCode[] = [...new Set(codes)];
  if (verdict === "fail") finalCodes.push("DEAI_THRESHOLD_FAIL");
  else if (verdict === "warn") finalCodes.push("DEAI_THRESHOLD_WARN");
  if (finalCodes.length === 0) finalCodes.push("DEAI_OK");

  return {
    ok: true,
    codes: finalCodes,
    score: scored.score,
    verdict,
    findings,
    stats: {
      chars,
      sentences: sentences.length,
      findings: findings.length,
      densityPerKilo: round2((findings.length * 1000) / chars),
      bulletUniformity: bullets.uniformity,
      bullets: bullets.bullets,
      avgSentenceLength: round2(sentenceMean),
      sentenceLengthStdDev: round2(Math.sqrt(sentenceVariance)),
      emojiDensity: round2((emojiCount * 1000) / chars),
      codeBlocksStripped: stripped.stripped,
    },
    audit: {
      rulesVersion: DEAI_RULES_VERSION,
      kind,
      warnThreshold: thresholds.warn,
      failThreshold: thresholds.fail,
      exemptionsApplied: 0,
      formula: "deai-sat-v1",
      saturation: SATURATION,
      weightedHits: scored.weightedHits,
      weightedPerKilo: scored.weightedPerKilo,
      densityScore: scored.densityScore,
      bulletPenalty: scored.bulletPenalty,
      cappedRules: scored.cappedRules,
    },
  };
}

/** 判断某个 finding 是否被某条豁免消费:规则相同 + 归一化 excerpt 逐字相等。 */
function consumes(finding: DeaiFinding, exemption: { ruleId: string; excerpt: string }): boolean {
  return (
    finding.ruleId === exemption.ruleId && normalizeExcerpt(finding.excerpt) === normalizeExcerpt(exemption.excerpt)
  );
}

/**
 * 应用豁免:把「已判定为可接受」的命中从计分里摘掉,重算 residual 分。
 * 为什么按「规则 + excerpt 精确匹配」而不是按规则整体豁免:
 * 整条规则豁免会让「这篇文档的黑话都可以留」变成一句空话,下次再写十句也照样放过;
 * 精确到句子才能做到「这一句是我们行业术语,理由写在审计里」。
 * 为什么 reason 至少 4 字:没有理由的豁免等于静默消音,审计价值为零。
 * 返回新对象:result 与 exemptions 都不被改写(豁免是一次独立的判定,不是对上次结果的修补)。
 */
export function applyExemptions(
  result: DeaiResult,
  exemptions: readonly DeaiExemption[] | undefined): DeaiExemptedResult {
  const hasResult = isPlainObject(result);
  const baseFindings =
    hasResult && Array.isArray((result as DeaiResult).findings) ? (result as DeaiResult).findings : [];
  const auditIn = hasResult && isPlainObject((result as DeaiResult).audit) ? (result as DeaiResult).audit : undefined;
  const statsIn = hasResult && isPlainObject((result as DeaiResult).stats) ? (result as DeaiResult).stats : undefined;
  const kind: DeaiKind = auditIn?.kind ?? "txt";
  const warn = auditIn?.warnThreshold ?? DEFAULT_WARN;
  const fail = auditIn?.failThreshold ?? DEFAULT_FAIL;
  const chars = statsIn?.chars ?? 0;
  const uniformity = statsIn?.bulletUniformity ?? 0;
  const fallback = emptyResult([], kind, warn, fail);

  const applied: DeaiExemption[] = [];
  const unused: DeaiExemption[] = [];
  const invalid: DeaiExemption[] = [];
  const consumed = new Set<number>();

  const list = Array.isArray(exemptions) ? exemptions : [];
  for (const entry of list) {
    if (!isPlainObject(entry)) {
      invalid.push({ ruleId: "", excerpt: "", reason: "" });
      continue;
    }
    const candidate = entry as unknown as DeaiExemption;
    const ruleId = typeof candidate.ruleId === "string" ? candidate.ruleId.trim() : "";
    const excerpt = typeof candidate.excerpt === "string" ? candidate.excerpt : "";
    const reason = typeof candidate.reason === "string" ? candidate.reason.trim() : "";
    if (ruleId === "" || normalizeExcerpt(excerpt) === "" || [...reason].length < 4) {
      invalid.push({ ...candidate, ruleId, excerpt, reason });
      continue;
    }
    let hit = false;
    for (let i = 0; i < baseFindings.length; i += 1) {
      const current = baseFindings[i];
      if (current === undefined) continue;
      if (consumed.has(i)) continue;
      if (consumes(current, { ruleId, excerpt })) {
        consumed.add(i);
        hit = true;
      }
    }
    if (hit) applied.push({ ...candidate, ruleId, excerpt, reason });
    else unused.push({ ...candidate, ruleId, excerpt, reason });
  }

  const residualFindings = baseFindings.filter((_finding, index) => !consumed.has(index));
  const rescored = scoreOf(residualFindings, chars, uniformity, SCORE_HITS_CAP);
  const residualVerdict = verdictOf(rescored.score, warn, fail);

  const codes: DeaiCode[] = [];
  if (!hasResult) codes.push("DEAI_INVALID");
  if (invalid.length > 0) codes.push("DEAI_EXEMPTION_INVALID");
  if (unused.length > 0) codes.push("DEAI_EXEMPTION_UNUSED");
  if (residualVerdict === "fail") codes.push("DEAI_THRESHOLD_FAIL");
  else if (residualVerdict === "warn") codes.push("DEAI_THRESHOLD_WARN");
  if (codes.length === 0) codes.push("DEAI_OK");

  return {
    ...(hasResult ? (result as DeaiResult) : fallback),
    ok: hasResult ? (result as DeaiResult).ok : false,
    codes,
    findings: baseFindings,
    stats: { ...(statsIn ?? fallback.stats), findings: residualFindings.length },
    audit: {
      ...(auditIn ?? fallback.audit),
      exemptionsApplied: applied.length,
      weightedHits: rescored.weightedHits,
      weightedPerKilo: rescored.weightedPerKilo,
      densityScore: rescored.densityScore,
      bulletPenalty: rescored.bulletPenalty,
      cappedRules: rescored.cappedRules,
      rulesVersion: DEAI_RULES_VERSION,
    },
    exemptions: { applied, unused, invalid, appliedFindings: consumed.size },
    residualFindings,
    residualScore: rescored.score,
    residualVerdict,
  };
}

/**
 * 多文档合并:取最差 verdict、平均分、按规则聚合命中数。
 * 为什么取最差而不是平均 verdict:读者要的是「这批文档能不能发」,一篇 fail 不该因为其它篇干净而被放过。
 */
export function mergeReports(docs: readonly (DeaiResult | DeaiMergeInput)[] | undefined): DeaiMergeReport {
  const verdicts: Record<DeaiVerdict, number> = { pass: 0, warn: 0, fail: 0 };
  if (!Array.isArray(docs)) {
    return {
      ok: false,
      codes: ["DEAI_INVALID"],
      rulesVersion: DEAI_RULES_VERSION,
      docs: 0,
      worstVerdict: "pass",
      averageScore: 0,
      verdicts,
      ruleHits: [],
    };
  }
  const results: DeaiResult[] = [];
  for (const entry of docs) {
    if (isPlainObject(entry) && isPlainObject((entry as unknown as DeaiMergeInput).result)) {
      results.push((entry as unknown as DeaiMergeInput).result);
    } else if (isPlainObject(entry) && "score" in entry && "verdict" in entry) {
      results.push(entry as unknown as DeaiResult);
    }
  }
  if (results.length === 0) {
    return {
      ok: false,
      codes: ["DEAI_EMPTY"],
      rulesVersion: DEAI_RULES_VERSION,
      docs: 0,
      worstVerdict: "pass",
      averageScore: 0,
      verdicts,
      ruleHits: [],
    };
  }
  let worst: DeaiVerdict = "pass";
  let total = 0;
  const hitCounts = new Map<string, { category: DeaiCategory; count: number }>();
  for (const result of results) {
    const score = typeof result.score === "number" && Number.isFinite(result.score) ? result.score : 0;
    const verdict = (VERDICTS as readonly string[]).includes(result.verdict) ? result.verdict : "pass";
    total += score;
    verdicts[verdict] += 1;
    if (verdict === "fail") worst = "fail";
    else if (verdict === "warn" && worst !== "fail") worst = "warn";
    const findings = Array.isArray(result.findings) ? result.findings : [];
    for (const finding of findings) {
      const bucket = hitCounts.get(finding.ruleId);
      if (bucket === undefined) hitCounts.set(finding.ruleId, { category: finding.category, count: 1 });
      else bucket.count += 1;
    }
  }
  const ruleHits: DeaiRuleHit[] = [...hitCounts.entries()]
    .map(([ruleId, bucket]) => ({ ruleId, category: bucket.category, count: bucket.count }))
    .sort((a, b) => (b.count === a.count ? a.ruleId.localeCompare(b.ruleId) : b.count - a.count));
  return {
    ok: true,
    codes: ["DEAI_OK"],
    rulesVersion: DEAI_RULES_VERSION,
    docs: results.length,
    worstVerdict: worst,
    averageScore: clampScore(total / results.length),
    verdicts,
    ruleHits,
  };
}

/** 规则目录(只读快照,给人/报告列规则用;不暴露内部可变引用)。 */
export function deaiRuleCatalog(): DeaiRule[] {
  return DEAI_RULES.map((rule) => ({
    ...rule,
    patterns: rule.patterns.map((pattern) => ({ ...pattern })),
    locales: [...rule.locales],
  }));
}
