/**
 *  Tips 冲突消解与组合预算(RFI #204)。
 * 提示词/纪律 tips 一旦多起来就会互相打架:两条 tip 说反话、同一组互斥 tip 同时上线、
 * 依赖的 tip 被裁掉却留下依赖者、token 预算被低价值 tip 吃光。本模块把「tip 组合」
 * 当成一次带约束的选择问题:冲突 → 互斥组 → 依赖闭包 → 单条长度压缩 → 四维预算,
 * 每一步都吐稳定码,让「为什么这条 tip 没出现」可复核。
 * 纯逻辑:零 IO、零全局状态、不抛异常(非法输入折成 TIPS_INVALID 计数跳过);
 * 词口径复用 attention-budget 的 countWords(CJK 每字 1 词,拉丁/数字按空白切)。
 */

import { countWords } from "./attention-budget";

/** 词口径统一出口:store/CLI 不必为计数再引一个模块(与 attention-budget 同一实现)。 */
export { countWords };

export const TIPS_BUDGET_VERSION = 1;

/** 单条 tip 的准入面。 */
export interface TipsRule {
  id: string;
  key: string;
  category: "dispatch" | "discipline" | "context" | "tool" | "review" | "other";
  priority: 0 | 1 | 2 | 3;
  version: string;
  text: string;
  maxWords: number;
  exclusiveGroup?: string;
  conflictsWith?: string[];
  requires?: string[];
  allowCompression?: boolean;
  expiresAt?: number;
  evidenceRefs?: string[];
}

/** 一个「本次想挂到某节点上的 tip」候选。 */
export interface TipsCandidate {
  ruleId: string;
  nodeId: string;
  at: number;
}

/** 已消耗预算(可由 resolve 结果重放得到)。 */
export interface TipsUsage {
  nodeTips: Record<string, number>;
  nodeWords: Record<string, number>;
  globalTips: number;
  globalWords: number;
}

/** 四维预算:节点条数/节点词数/全局条数/全局词数。 */
export interface TipsBudget {
  maxTipsPerNode?: number;
  maxWordsPerNode?: number;
  maxTipsGlobal?: number;
  maxWordsGlobal?: number;
}

/** 缺省预算:每节点 2 条 120 词,全局 20 条 800 词。 */
export const DEFAULT_TIPS_BUDGET: Readonly<Required<TipsBudget>> = Object.freeze({
  maxTipsPerNode: 2,
  maxWordsPerNode: 120,
  maxTipsGlobal: 20,
  maxWordsGlobal: 800,
});

/** 空 usage(不共享引用,每次新对象)。 */
export function emptyUsage(): TipsUsage {
  return { nodeTips: {}, nodeWords: {}, globalTips: 0, globalWords: 0 };
}

/** 稳定码(全部可枚举;测试逐字断言)。 */
export const TIPS_CODES = [
  "TIPS_INVALID",
  "TIPS_SELECTED",
  "TIPS_DROPPED_CONFLICT",
  "TIPS_DROPPED_EXCLUSIVE",
  "TIPS_DROPPED_REQUIRES",
  "TIPS_DROPPED_BUDGET_NODE",
  "TIPS_DROPPED_BUDGET_GLOBAL",
  "TIPS_DROPPED_EXPIRED",
  "TIPS_DROPPED_STALE_VERSION",
  "TIPS_COMPRESSED",
  "TIPS_DUPLICATE",
] as const;

export type TipsCode = (typeof TIPS_CODES)[number];

export interface SelectedTip {
  rule: TipsRule;
  text: string;
  compressed: boolean;
  reason: string;
}

export interface DroppedTip {
  ruleId: string;
  reason: string;
  code: TipsCode;
}

export interface TipsResolveResult {
  selected: SelectedTip[];
  dropped: DroppedTip[];
  usageAfter: TipsUsage;
  codes: string[];
}

export interface TipsResolveOptions {
  usage?: TipsUsage;
  budget?: TipsBudget;
  nodeId?: string;
  now?: number;
}

export interface TipsBudgetReport {
  nodeUsage: Record<string, { tips: number; words: number }>;
  globalUsage: { tips: number; words: number };
  remaining: { globalTips: number; globalWords: number };
  byNodeRemaining: Record<string, { tips: number; words: number }>;
}

const CATEGORIES: ReadonlySet<string> = new Set<string>([
  "dispatch",
  "discipline",
  "context",
  "tool",
  "review",
  "other",
]);

/** 句末标点(含换行):压缩优先在这些位置断句,不把句子切一半。 */
const SENTENCE_END = new Set<string>(["。", "！", "？", "；", "!", "?", ";", "\n"]);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function intInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

// ── 校验 ────────────────────────────────────────────────────────────────

/** 规则准入校验:id/key/text/version 非空、priority∈0..3、maxWords 为正整数。 */
export function validateRule(rule: unknown): { ok: boolean; codes: string[] } {
  if (!isRecord(rule)) return { ok: false, codes: ["TIPS_INVALID"] };
  if (textOf(rule["id"]) === undefined) return { ok: false, codes: ["TIPS_INVALID"] };
  if (textOf(rule["key"]) === undefined) return { ok: false, codes: ["TIPS_INVALID"] };
  if (textOf(rule["text"]) === undefined) return { ok: false, codes: ["TIPS_INVALID"] };
  if (textOf(rule["version"]) === undefined) return { ok: false, codes: ["TIPS_INVALID"] };
  if (!intInRange(rule["priority"], 0, 3)) return { ok: false, codes: ["TIPS_INVALID"] };
  if (!intInRange(rule["maxWords"], 1, Number.MAX_SAFE_INTEGER)) return { ok: false, codes: ["TIPS_INVALID"] };
  if (rule["category"] !== undefined && !CATEGORIES.has(String(rule["category"]))) {
    return { ok: false, codes: ["TIPS_INVALID"] };
  }
  return { ok: true, codes: [] };
}

// ── 压缩 ────────────────────────────────────────────────────────────────

/** 最长的、词数不超过 limit 的前缀(末尾空白去掉);切不出非空文本时返回 ""。 */
function cutToWords(text: string, limit: number): string {
  const chars = Array.from(String(text ?? ""));
  let lastGood = 0;
  for (let i = 1; i <= chars.length; i += 1) {
    const prefix = chars.slice(0, i).join("");
    if (countWords(prefix) <= limit) lastGood = i;
    else break;
  }
  return chars.slice(0, lastGood).join("").trimEnd();
}

/**
 * 把 tip 压到 maxWords 词以内:优先在句末标点处断,断不出再逐字截;末尾加省略号
 * (省略号不计词)。已不超预算 → 原样返回;压不出来 → 原样返回 + compressed:false,
 * 由调用方判「超限丢弃」。
 */
export function compressTip(text: string, maxWords: number): { text: string; compressed: boolean } {
  const s = String(text ?? "");
  if (!(typeof maxWords === "number") || !Number.isFinite(maxWords) || maxWords <= 0) {
    return { text: s, compressed: false };
  }
  if (countWords(s) <= maxWords) return { text: s, compressed: false };

  const chars = Array.from(s);
  let base = "";
  for (let i = chars.length; i >= 1; i -= 1) {
    if (!SENTENCE_END.has(chars[i - 1] ?? "")) continue;
    const prefix = chars.slice(0, i).join("");
    if (prefix.trim() === "") continue;
    if (countWords(prefix) <= maxWords) {
      base = prefix.trimEnd();
      break;
    }
  }
  if (base === "") base = cutToWords(s, maxWords);
  if (base.trim() === "") return { text: s, compressed: false };
  const out = `${base}…`;
  if (countWords(out) > maxWords) {
    const tighter = cutToWords(base, maxWords);
    if (tighter.trim() === "" || countWords(`${tighter}…`) > maxWords) {
      return { text: s, compressed: false };
    }
    return { text: `${tighter}…`, compressed: true };
  }
  return { text: out, compressed: true };
}

// ── 版本 ────────────────────────────────────────────────────────────────

/** 版本比较:去前导 v/V 后按 "." 分段;两段都是数字按数值比,否则退回字符串比。 */
export function compareVersion(a: string, b: string): number {
  const pa = String(a ?? "").replace(/^[vV]/, "").split(".");
  const pb = String(b ?? "").replace(/^[vV]/, "").split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const sa = pa[i] ?? "0";
    const sb = pb[i] ?? "0";
    const numA = /^\d+$/.test(sa);
    const numB = /^\d+$/.test(sb);
    if (numA && numB) {
      const diff = Number(sa) - Number(sb);
      if (diff !== 0) return diff > 0 ? 1 : -1;
      continue;
    }
    if (sa === sb) continue;
    return sa > sb ? 1 : -1;
  }
  return 0;
}

/** 同 key 是否已存在更高版本的规则。 */
export function isRuleStale(rule: TipsRule, rules: readonly TipsRule[]): boolean {
  if (!isRecord(rule)) return false;
  const key = textOf((rule as TipsRule).key);
  const version = textOf((rule as TipsRule).version);
  if (key === undefined || version === undefined) return false;
  for (const other of rules ?? []) {
    if (!isRecord(other)) continue;
    if (textOf(other.key) !== key) continue;
    if (textOf(other.version) === undefined) continue;
    if (compareVersion(other.version, version) > 0) return true;
  }
  return false;
}

// ── 选择 ────────────────────────────────────────────────────────────────

function pushCode(codes: string[], code: string): void {
  if (!codes.includes(code)) codes.push(code);
}

/** (priority 升 → version 降 → id 升)排序:高优先(数字小)先占预算,同优先级新版先。 */
function orderOf(a: TipsRule, b: TipsRule): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const byVersion = compareVersion(b.version, a.version);
  if (byVersion !== 0) return byVersion;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function lowerList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const s = textOf(item);
    if (s !== undefined && !out.includes(s)) out.push(s);
  }
  return out;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function cloneUsage(usage: TipsUsage | undefined): TipsUsage {
  const base = isRecord(usage) ? usage : undefined;
  const nodeTips: Record<string, number> = {};
  const nodeWords: Record<string, number> = {};
  for (const [k, v] of Object.entries(base?.nodeTips ?? {})) {
    if (typeof v === "number" && Number.isFinite(v)) nodeTips[k] = v;
  }
  for (const [k, v] of Object.entries(base?.nodeWords ?? {})) {
    if (typeof v === "number" && Number.isFinite(v)) nodeWords[k] = v;
  }
  return {
    nodeTips,
    nodeWords,
    globalTips: numberOr(base?.globalTips, 0),
    globalWords: numberOr(base?.globalWords, 0),
  };
}

function budgetOf(budget: TipsBudget | undefined): Required<TipsBudget> {
  const src = isRecord(budget) ? budget : {};
  return {
    maxTipsPerNode: numberOr(src.maxTipsPerNode, DEFAULT_TIPS_BUDGET.maxTipsPerNode),
    maxWordsPerNode: numberOr(src.maxWordsPerNode, DEFAULT_TIPS_BUDGET.maxWordsPerNode),
    maxTipsGlobal: numberOr(src.maxTipsGlobal, DEFAULT_TIPS_BUDGET.maxTipsGlobal),
    maxWordsGlobal: numberOr(src.maxWordsGlobal, DEFAULT_TIPS_BUDGET.maxWordsGlobal),
  };
}

/** 选择管线里流动的单元:规则 + 它要挂的节点(候选自带 nodeId 优先)。 */
interface Slot {
  rule: TipsRule;
  nodeId: string;
}

/**
 * 一次 tips 选择:非法 → 过期 → 重复 → 陈旧版本 → 冲突/互斥 → 依赖闭包 →
 * 单条压缩 → 四维预算。顺序即语义,不要调换(先便宜后贵的淘汰理由才可解释)。
 */
export function resolveTips(
  input: { rules?: unknown; candidates?: unknown },
  options: TipsResolveOptions = {},
): TipsResolveResult {
  const dropped: DroppedTip[] = [];
  const codes: string[] = [];
  const selected: SelectedTip[] = [];

  const rawRules = Array.isArray(input?.rules) ? input.rules : [];
  const byId = new Map<string, TipsRule>();
  const validRules: TipsRule[] = [];
  for (const raw of rawRules) {
    if (validateRule(raw).ok !== true) continue;
    const rule = raw as TipsRule;
    validRules.push(rule);
    if (!byId.has(rule.id)) byId.set(rule.id, rule);
  }

  const now = numberOr(options.now, Date.now());
  const usageAfter = cloneUsage(options.usage);

  // a/b:准入 + 过期 + 同 node 重复
  const seen = new Set<string>();
  const alive: Slot[] = [];
  for (const raw of Array.isArray(input?.candidates) ? input.candidates : []) {
    const cand = isRecord(raw) ? raw : {};
    const ruleId = textOf(cand["ruleId"]) ?? "";
    const rule = byId.get(ruleId);
    if (ruleId === "" || rule === undefined || validateRule(rule).ok !== true) {
      dropped.push({ ruleId, reason: "invalid-rule", code: "TIPS_INVALID" });
      pushCode(codes, "TIPS_INVALID");
      continue;
    }
    if (typeof rule.expiresAt === "number" && now >= rule.expiresAt) {
      dropped.push({ ruleId, reason: "expired", code: "TIPS_DROPPED_EXPIRED" });
      pushCode(codes, "TIPS_DROPPED_EXPIRED");
      continue;
    }
    const nodeOf =
      textOf(cand["nodeId"]) ??
      (typeof options.nodeId === "string" && options.nodeId.trim() !== "" ? options.nodeId : "default");
    const dupKey = `${nodeOf}::${ruleId}`;
    if (seen.has(dupKey)) {
      dropped.push({ ruleId, reason: `duplicate:${nodeOf}`, code: "TIPS_DUPLICATE" });
      pushCode(codes, "TIPS_DUPLICATE");
      continue;
    }
    seen.add(dupKey);
    alive.push({ rule, nodeId: nodeOf });
  }

  // c:同 key 存在更高 version → 陈旧
  const fresh: Slot[] = [];
  for (const slot of alive) {
    if (isRuleStale(slot.rule, validRules)) {
      dropped.push({
        ruleId: slot.rule.id,
        reason: `stale-version:${slot.rule.key}`,
        code: "TIPS_DROPPED_STALE_VERSION",
      });
      pushCode(codes, "TIPS_DROPPED_STALE_VERSION");
      continue;
    }
    fresh.push(slot);
  }

  // d:冲突/互斥(高优先先选,贪心)
  const ordered = [...fresh].sort((x, y) => orderOf(x.rule, y.rule));
  const conflicted: Slot[] = [];
  for (const slot of ordered) {
    const rule = slot.rule;
    const conflicts = lowerList(rule.conflictsWith);
    const hit = conflicted.find(
      (chosen) =>
        conflicts.includes(chosen.rule.id) || lowerList(chosen.rule.conflictsWith).includes(rule.id),
    );
    if (hit !== undefined) {
      dropped.push({ ruleId: rule.id, reason: `conflict:${hit.rule.id}`, code: "TIPS_DROPPED_CONFLICT" });
      pushCode(codes, "TIPS_DROPPED_CONFLICT");
      continue;
    }
    const group = textOf(rule.exclusiveGroup);
    const sameGroup =
      group === undefined
        ? undefined
        : conflicted.find((chosen) => textOf(chosen.rule.exclusiveGroup) === group);
    if (sameGroup !== undefined) {
      dropped.push({ ruleId: rule.id, reason: `exclusive:${group}`, code: "TIPS_DROPPED_EXCLUSIVE" });
      pushCode(codes, "TIPS_DROPPED_EXCLUSIVE");
      continue;
    }
    conflicted.push(slot);
  }

  // e:依赖闭包——被 requires 丢弃者不作为他人依赖来源,迭代到稳定
  let survivors = [...conflicted];
  for (;;) {
    const ids = new Set<string>(survivors.map((slot) => slot.rule.id));
    const stillOk: Slot[] = [];
    let removed = 0;
    for (const slot of survivors) {
      const missing = lowerList(slot.rule.requires).filter((dep) => !ids.has(dep));
      if (missing.length > 0) {
        dropped.push({
          ruleId: slot.rule.id,
          reason: `requires-missing:${missing.join(",")}`,
          code: "TIPS_DROPPED_REQUIRES",
        });
        pushCode(codes, "TIPS_DROPPED_REQUIRES");
        removed += 1;
        continue;
      }
      stillOk.push(slot);
    }
    survivors = stillOk;
    if (removed === 0) break;
  }

  // f/g:压缩 + 四维预算(高优先先占)
  const budget = budgetOf(options.budget);
  for (const slot of [...survivors].sort((x, y) => orderOf(x.rule, y.rule))) {
    const rule = slot.rule;
    let text = rule.text;
    let compressed = false;
    const maxWords = Number.isInteger(rule.maxWords) && rule.maxWords > 0 ? rule.maxWords : budget.maxWordsPerNode;
    if (countWords(text) > maxWords) {
      if (rule.allowCompression === false) {
        dropped.push({ ruleId: rule.id, reason: "tip-max-words-no-compress", code: "TIPS_DROPPED_BUDGET_NODE" });
        pushCode(codes, "TIPS_DROPPED_BUDGET_NODE");
        continue;
      }
      const squeezed = compressTip(text, maxWords);
      if (!squeezed.compressed || countWords(squeezed.text) > maxWords) {
        dropped.push({ ruleId: rule.id, reason: "tip-max-words", code: "TIPS_DROPPED_BUDGET_NODE" });
        pushCode(codes, "TIPS_DROPPED_BUDGET_NODE");
        continue;
      }
      text = squeezed.text;
      compressed = true;
    }

    const nodeId = slot.nodeId;
    const words = countWords(text);
    const nodeTips = usageAfter.nodeTips[nodeId] ?? 0;
    const nodeWords = usageAfter.nodeWords[nodeId] ?? 0;
    if (nodeTips + 1 > budget.maxTipsPerNode) {
      dropped.push({ ruleId: rule.id, reason: "node-tips", code: "TIPS_DROPPED_BUDGET_NODE" });
      pushCode(codes, "TIPS_DROPPED_BUDGET_NODE");
      continue;
    }
    if (nodeWords + words > budget.maxWordsPerNode) {
      dropped.push({ ruleId: rule.id, reason: "node-words", code: "TIPS_DROPPED_BUDGET_NODE" });
      pushCode(codes, "TIPS_DROPPED_BUDGET_NODE");
      continue;
    }
    if (usageAfter.globalTips + 1 > budget.maxTipsGlobal) {
      dropped.push({ ruleId: rule.id, reason: "global-tips", code: "TIPS_DROPPED_BUDGET_GLOBAL" });
      pushCode(codes, "TIPS_DROPPED_BUDGET_GLOBAL");
      continue;
    }
    if (usageAfter.globalWords + words > budget.maxWordsGlobal) {
      dropped.push({ ruleId: rule.id, reason: "global-words", code: "TIPS_DROPPED_BUDGET_GLOBAL" });
      pushCode(codes, "TIPS_DROPPED_BUDGET_GLOBAL");
      continue;
    }

    selected.push({ rule, text, compressed, reason: "selected" });
    pushCode(codes, "TIPS_SELECTED");
    if (compressed) pushCode(codes, "TIPS_COMPRESSED");
    usageAfter.nodeTips[nodeId] = nodeTips + 1;
    usageAfter.nodeWords[nodeId] = nodeWords + words;
    usageAfter.globalTips += 1;
    usageAfter.globalWords += words;
  }

  return { selected, dropped, usageAfter, codes };
}

/** 预算快照:以 DEFAULT_TIPS_BUDGET 为基准算剩余(超支钳 0)。 */
export function budgetReport(usage: TipsUsage, budget: TipsBudget = {}): TipsBudgetReport {
  const b = budgetOf({ ...DEFAULT_TIPS_BUDGET, ...budgetOf(budget) });
  const u = cloneUsage(usage);
  const nodeUsage: Record<string, { tips: number; words: number }> = {};
  const byNodeRemaining: Record<string, { tips: number; words: number }> = {};
  for (const nodeId of Object.keys(u.nodeTips)) {
    const tips = u.nodeTips[nodeId] ?? 0;
    const words = u.nodeWords[nodeId] ?? 0;
    nodeUsage[nodeId] = { tips, words };
  }
  for (const nodeId of Object.keys(u.nodeWords)) {
    if (nodeUsage[nodeId] !== undefined) continue;
    nodeUsage[nodeId] = { tips: 0, words: u.nodeWords[nodeId] ?? 0 };
  }
  for (const [nodeId, entry] of Object.entries(nodeUsage)) {
    byNodeRemaining[nodeId] = {
      tips: Math.max(0, b.maxTipsPerNode - entry.tips),
      words: Math.max(0, b.maxWordsPerNode - entry.words),
    };
  }
  return {
    nodeUsage,
    globalUsage: { tips: u.globalTips, words: u.globalWords },
    remaining: {
      globalTips: Math.max(0, b.maxTipsGlobal - u.globalTips),
      globalWords: Math.max(0, b.maxWordsGlobal - u.globalWords),
    },
    byNodeRemaining,
  };
}
