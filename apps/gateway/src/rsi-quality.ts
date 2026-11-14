/**
 * RSI 结果质量评估(质量契约 v2)。
 * 要解决的问题:12 个机制每轮产出 6~19 条「某字段缺失/台账只有 N 行/文件不存在」式观察,
 * 用户看的是流水账,无法据此做决策。本模块只做**确定性评估**(零 LLM):
 * - 每条结论必须带证据(evidence / detail 里的 证据:/file:line)、影响(impact)、建议(action);
 * - 识别浅层观察(shallow):缺失/只有/无数据/字段名复述,且没有影响与建议;
 * - 识别重复(duplicate):同标题归一化后相同 / 同摘要前缀;
 * - 上限 6 条(超过只保留影响最大的 6 条,由 agent 遵守,评估侧点名 overLimit);
 * - 汇总为 0~100 分 + 可读 issues,随 run 落盘并在面板显示。
 * 纪律:纯函数、零 IO、不 throw;空 items = 100 分(诚实空产出,不是低质量)。
 */

/** 单次运行最多允许的结论条数(与 brief 的 1~6 一致)。 */
export const RSI_QUALITY_MAX_ITEMS = 6;

export interface RsiQualityItemInput {
  id?: string;
  title?: string;
  summary?: string;
  detail?: string;
  evidence?: string;
  impact?: string;
  action?: string;
}

export type RsiQualityIssueCode =
  | "MISSING_EVIDENCE"
  | "MISSING_IMPACT"
  | "MISSING_ACTION"
  | "SHALLOW"
  | "DUPLICATE"
  | "OVER_LIMIT"
 /** 交付缺失/路径自愈(经验证:agent 抄错 runId 或没写结果文件)。 */
  | "RESULT_MISSING"
  | "PATH_REPAIRED";

export interface RsiQualityIssue {
  code: RsiQualityIssueCode;
  itemId?: string;
  note: string;
}

export interface RsiQualityResult {
  items: number;
  evidenced: number;
  impacted: number;
  actionable: number;
  shallow: number;
  duplicates: number;
  overLimit: boolean;
  score: number;
  issues: RsiQualityIssue[];
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 证据形态:显式 evidence 字段,或 detail 里出现 证据:/file:line/第 N 行/字段=值。 */
function hasEvidence(item: RsiQualityItemInput): boolean {
  if (str(item.evidence) !== "") return true;
  const detail = str(item.detail);
  if (detail === "") return false;
  return /证据\s*[:：]|file\s*:|[A-Za-z0-9_./-]+\.(ts|js|mjs|cjs|json|jsonl|md|py|go|java|cpp|c|h)\s*:\s*\d+|第\s*\d+\s*行|=[^,，;；]{1,60}/.test(detail);
}

function hasImpact(item: RsiQualityItemInput): boolean {
  if (str(item.impact) !== "") return true;
  return /影响\s*[:：]/.test(str(item.detail));
}

function hasAction(item: RsiQualityItemInput): boolean {
  if (str(item.action) !== "") return true;
  return /(建议|修复|动作|下一步|做法)\s*[:：]/.test(str(item.detail));
}

const SHALLOW_PATTERNS: readonly RegExp[] = [
  /缺失|不存在|不可读|无数据|为空|仅有|只有|只有一|未落地|未消化|未闭环|未回填|未认账/,
  /(共|只有|仅有)\s*\d+\s*(行|条|个|份)|字段.{0,8}(缺失|没有)|文件.{0,8}(不存在|缺失)/,
  /建议(完善|加强|提升|优化)|加强监控|提高可读性/,
];

function isShallow(item: RsiQualityItemInput): boolean {
  const text = `${str(item.title)} ${str(item.summary)}`;
  if (text.trim() === "") return true;
  if (hasImpact(item) || hasAction(item)) return false;
  return SHALLOW_PATTERNS.some((re) => re.test(text));
}

/** 标题归一化:小写、去标点/空白(保留数字,「发现 1/2」是不同结论),用于判重。 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

function issue(code: RsiQualityIssueCode, note: string, itemId?: string): RsiQualityIssue {
  return itemId === undefined ? { code, note } : { code, note, itemId };
}

/**
 * 评估一组结果条目的质量。空数组=100(无发现是诚实的,不惩罚)。
 * 评分:100 起,每条缺证据 -12 / 缺影响 -10 / 缺建议 -8;浅层每条 -15;重复每条 -10;
 * 超上限 -15;下限 0。
 */
export function assessResultQuality(items: readonly RsiQualityItemInput[] | undefined): RsiQualityResult {
  const list = Array.isArray(items) ? items.filter((item) => typeof item === "object" && item !== null) : [];
  const result: RsiQualityResult = {
    items: list.length,
    evidenced: 0,
    impacted: 0,
    actionable: 0,
    shallow: 0,
    duplicates: 0,
    overLimit: list.length > RSI_QUALITY_MAX_ITEMS,
    score: 100,
    issues: [],
  };
  if (list.length === 0) return result;

  const seenTitles = new Set<string>();
  const seenSummaries = new Set<string>();
  let missingEvidence = 0;
  let missingImpact = 0;
  let missingAction = 0;

  for (let i = 0; i < list.length; i += 1) {
    const item = list[i]!;
    const itemId = str(item.id) || `#${i + 1}`;
    const title = str(item.title) || itemId;
    const summary = str(item.summary);
    const evidenced = hasEvidence(item);
    const impacted = hasImpact(item);
    const actionable = hasAction(item);
    if (evidenced) result.evidenced += 1;
    else {
      missingEvidence += 1;
      result.issues.push(issue("MISSING_EVIDENCE", `「${title}」没有可复核证据(file:line/字段=值)`, itemId));
    }
    if (impacted) result.impacted += 1;
    else {
      missingImpact += 1;
      result.issues.push(issue("MISSING_IMPACT", `「${title}」没有写不处理的后果(impact)`, itemId));
    }
    if (actionable) result.actionable += 1;
    else {
      missingAction += 1;
      result.issues.push(issue("MISSING_ACTION", `「${title}」没有最小可执行动作(action)`, itemId));
    }
    if (isShallow(item)) {
      result.shallow += 1;
      result.issues.push(issue("SHALLOW", `「${title}」是浅层观察(缺失/数量复述/套话),没有影响与建议`, itemId));
    }
    const titleKey = normalizeTitle(title);
 // 摘要归一化保留数字(第 1 条/第 2 条是不同结论);标题归一化去掉数字(编号不构成差异)。
    const summaryKey = summary.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 30);
    const dupTitle = titleKey !== "" && seenTitles.has(titleKey);
    const dupSummary = summaryKey.length >= 12 && seenSummaries.has(summaryKey);
    if (dupTitle || dupSummary) {
      result.duplicates += 1;
      result.issues.push(issue("DUPLICATE", `「${title}」与前面的条目重复(同标题/同摘要前缀)`, itemId));
    }
    if (titleKey !== "") seenTitles.add(titleKey);
    if (summaryKey.length >= 12) seenSummaries.add(summaryKey);
  }

  if (result.overLimit) {
    result.issues.push(issue("OVER_LIMIT", `共 ${list.length} 条,超过上限 ${RSI_QUALITY_MAX_ITEMS};只保留影响最大的 ${RSI_QUALITY_MAX_ITEMS} 条`));
  }

  let score = 100;
  score -= missingEvidence * 12;
  score -= missingImpact * 10;
  score -= missingAction * 8;
  score -= result.shallow * 15;
  score -= result.duplicates * 10;
  if (result.overLimit) score -= 15;
  result.score = Math.max(0, Math.min(100, Math.round(score)));
 // issues 上限 20,避免 UI 被刷屏(计数字段仍完整)。
  if (result.issues.length > 20) result.issues = result.issues.slice(0, 20);
  return result;
}
