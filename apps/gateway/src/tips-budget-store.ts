/**
 * Tips 组合预算的持久层:把 tips-budget 的纯逻辑落到 append-only jsonl。
 * 为什么 append-only:预算消耗是「这一轮为什么只给这两条 tip」的审计事实;reset 不擦历史,
 * 而是追加一条 reset 行划分新窗口,重放同一文件就能复算任意时刻的 usage。
 * 单行追加 + 写后重读行数校验,让「写成功了吗」成为可复核断言(而不是信任 append 没抛)。
 * 数据面 `<root>/.genie/rsi/tips.jsonl`:
 * - rule    {rule}                            一条规则(同 id 后写为准)
 * - resolve {result}                          一次选择(selected/dropped/codes + nodeId,可重放 usage)
 * - reset   {}                                预算窗口清零标记
 * 投影语义:按行序读全部行;坏行(JSON 坏 / v 不是 1 / type 未知 / 载荷不合法)只计入
 * badLines 并跳过:一行坏不整文件失效、不 throw。
 * 依赖纪律:node:fs / node:path + runtime 的纯逻辑模块;不引 agent loop、不引 gateway 其余业务模块。
 * runtime 模块按 decision-quality-store 的既有套路惰性解析(两跳):
 * ① 带 `--conditions=development` 的运行时(vitest)走包导出 src 入口;
 * ② 裸 tsx/dist 缺该文件时回退到仓内源文件(new URL,避免静态 .ts specifier 触发 TS5097/TS6059)。
 * 除参数错误(root 非法)外不 throw:IO/投影失败一律折叠成稳定码返回。
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  DroppedTip,
  SelectedTip,
  TipsBudget,
  TipsResolveResult,
  TipsRule,
  TipsUsage,
} from "@lampgenie/runtime/agent/tips-budget";

/** 本模块从 runtime 面用到的能力(惰性解析后填充)。 */
interface TipsRuntime {
  validateRule(rule: unknown): { ok: boolean; codes: string[] };
  resolveTips(input: { rules?: unknown; candidates?: unknown }, options?: unknown): TipsResolveResult;
  emptyUsage(): TipsUsage;
  countWords(text: string): number;
}

let tipsRuntime: TipsRuntime | undefined;

/** 两跳解析 runtime 模块(见文件头依赖纪律)。 */
async function loadTipsRuntime(): Promise<TipsRuntime> {
  if (tipsRuntime) return tipsRuntime;
  const spec = "@lampgenie/runtime/agent/tips-budget";
  try {
    tipsRuntime = (await import(spec)) as TipsRuntime;
  } catch {
    const srcUrl = new URL(
      "../../../packages/harness-runtime/src/agent/tips-budget.ts",
      import.meta.url).href;
    tipsRuntime = (await import(srcUrl)) as TipsRuntime;
  }
  return tipsRuntime;
}

/** runtime 面(顶层 await:所有导出函数保持同步签名)。 */
const rt = await loadTipsRuntime();

/** store 稳定码:store 层自产的码(判定码沿用 runtime 的 TIPS_*)。 */
export const TIPS_STORE_CODES = [
  "TIPS_STORE_INVALID_INPUT",
  "TIPS_STORE_WRITE_FAILED",
  "TIPS_RULE_ADDED",
  "TIPS_RULE_RESOLVED",
  "TIPS_USAGE_RESET",
] as const;

export type TipsStoreCode = (typeof TIPS_STORE_CODES)[number];

/** 落盘行类型(只增不改)。 */
export const TIPS_LINE_TYPES = ["rule", "resolve", "reset"] as const;

export type TipsLineType = (typeof TIPS_LINE_TYPES)[number];

/** resolve 行里可重放的最小 select 记录(不存全文,存得出预算消耗)。 */
export interface TipsSelectedRecord {
  ruleId: string;
  key: string;
  words: number;
  compressed: boolean;
}

export interface TipsResolveRecord {
  nodeId: string;
  selected: TipsSelectedRecord[];
  dropped: Array<{ ruleId: string; code: string; reason: string }>;
  codes: string[];
}

export interface TipsRuleLine {
  v: 1;
  type: "rule";
  at: number;
  rule: TipsRule;
}

export interface TipsResolveLine {
  v: 1;
  type: "resolve";
  at: number;
  result: TipsResolveRecord;
}

export interface TipsResetLine {
  v: 1;
  type: "reset";
  at: number;
}

export type TipsLine = TipsRuleLine | TipsResolveLine | TipsResetLine;

/** 选择结果 + 落盘态。 */
export interface TipsStoreResolveResult extends TipsResolveResult {
  nodeId: string;
  recorded: boolean;
}

export interface TipsStoreReport {
  rules: number;
  byCategory: Record<string, number>;
  byPriority: Record<string, number>;
  dropsByReason: Record<string, number>;
  compressed: number;
  resolves: number;
  badLines: number;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function assertRoot(root: unknown): string {
  if (typeof root !== "string" || root.trim() === "") throw new Error("root 必须是非空字符串");
  return root;
}

/** tips 台账文件绝对路径:`<root>/.genie/rsi/tips.jsonl`。 */
export function tipsPath(root: string): string {
  const base = assertRoot(root);
  return join(base, ".genie", "rsi", "tips.jsonl");
}

/** 统计文件非空行数;文件不存在/读失败按 0。 */
function countLines(path: string): number {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return 0;
  }
  let n = 0;
  for (const line of text.split("\n")) if (line.trim() !== "") n += 1;
  return n;
}

/** 追加一行并做写后行数校验;失败返回 false(不回滚、不 throw)。 */
function appendLine(path: string, line: TipsLine): boolean {
  const before = countLines(path);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    return false;
  }
  return countLines(path) === before + 1;
}

/** 已落盘规则的结构校验(行由本模块/runtime 产出,这里只挡手改与截断)。 */
function coerceRule(value: unknown): TipsRule | undefined {
  if (!isRecord(value)) return undefined;
  if (rt.validateRule(value).ok !== true) return undefined;
  return value as unknown as TipsRule;
}

function coerceSelected(value: unknown): TipsSelectedRecord | undefined {
  if (!isRecord(value)) return undefined;
  const ruleId = textOf(value["ruleId"]);
  const key = textOf(value["key"]);
  if (ruleId === undefined || key === undefined) return undefined;
  if (!isFiniteNumber(value["words"])) return undefined;
  if (typeof value["compressed"] !== "boolean") return undefined;
  return { ruleId, key, words: value["words"], compressed: value["compressed"] };
}

function coerceDropped(value: unknown): { ruleId: string; code: string; reason: string } | undefined {
  if (!isRecord(value)) return undefined;
  const ruleId = typeof value["ruleId"] === "string" ? value["ruleId"] : undefined;
  const code = textOf(value["code"]);
  const reason = textOf(value["reason"]);
  if (ruleId === undefined || code === undefined || reason === undefined) return undefined;
  return { ruleId, code, reason };
}

function coerceResolveRecord(value: unknown): TipsResolveRecord | undefined {
  if (!isRecord(value)) return undefined;
  const nodeId = textOf(value["nodeId"]);
  if (nodeId === undefined) return undefined;
  if (!Array.isArray(value["selected"]) || !Array.isArray(value["dropped"])) return undefined;
  const selected: TipsSelectedRecord[] = [];
  for (const item of value["selected"]) {
    const entry = coerceSelected(item);
    if (entry === undefined) return undefined;
    selected.push(entry);
  }
  const dropped: Array<{ ruleId: string; code: string; reason: string }> = [];
  for (const item of value["dropped"]) {
    const entry = coerceDropped(item);
    if (entry === undefined) return undefined;
    dropped.push(entry);
  }
  const codes = Array.isArray(value["codes"])
    ? value["codes"].filter((code): code is string => typeof code === "string")
    : [];
  return { nodeId, selected, dropped, codes };
}

/** 行序投影后的事件(保留 interleaving,reset 才能正确划窗口)。 */
type TipsEvent =
  | { kind: "rule"; rule: TipsRule }
  | { kind: "resolve"; record: TipsResolveRecord }
  | { kind: "reset" };

interface Projection {
  events: TipsEvent[];
  totalLines: number;
  badLines: number;
}

/** 读全文件并按行序投影;坏行只计数(JSON 坏 / v≠1 / type 未知 / 载荷不合法)。 */
function project(root: string): Projection {
  const path = tipsPath(root);
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { events: [], totalLines: 0, badLines: 0 };
  }
  const events: TipsEvent[] = [];
  let totalLines = 0;
  let badLines = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    totalLines += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      badLines += 1;
      continue;
    }
    if (!isRecord(parsed) || parsed["v"] !== 1 || !isFiniteNumber(parsed["at"])) {
      badLines += 1;
      continue;
    }
    const type = textOf(parsed["type"]);
    if (type === "rule") {
      const rule = coerceRule(parsed["rule"]);
      if (rule === undefined) {
        badLines += 1;
        continue;
      }
      events.push({ kind: "rule", rule });
      continue;
    }
    if (type === "resolve") {
      const record = coerceResolveRecord(parsed["result"]);
      if (record === undefined) {
        badLines += 1;
        continue;
      }
      events.push({ kind: "resolve", record });
      continue;
    }
    if (type === "reset") {
      events.push({ kind: "reset" });
      continue;
    }
    badLines += 1;
  }
  return { events, totalLines, badLines };
}

/** 加一条规则:经 runtime 校验,合法才落盘(同 id 后写为准)。 */
export function addRule(root: string, rule: unknown): { ok: boolean; codes: string[]; rule?: TipsRule } {
  const path = tipsPath(root);
  const verdict = rt.validateRule(rule);
  if (!verdict.ok) return { ok: false, codes: ["TIPS_INVALID"] };
  const typed = rule as TipsRule;
  const wrote = appendLine(path, { v: 1, type: "rule", at: Date.now(), rule: typed });
  if (!wrote) return { ok: false, codes: ["TIPS_STORE_WRITE_FAILED"] };
  return { ok: true, codes: ["TIPS_RULE_ADDED"], rule: typed };
}

/** 规则投影:按 id 去重(后写为准)。 */
function projectRules(events: TipsEvent[]): TipsRule[] {
  const byId = new Map<string, TipsRule>();
  for (const event of events) if (event.kind === "rule") byId.set(event.rule.id, event.rule);
  return [...byId.values()];
}

/** 列规则:按 id 去重(后写为准),可按 key 过滤。 */
export function listRules(root: string, options: { key?: string } = {}): TipsRule[] {
  const rules = projectRules(project(root).events);
  const key = textOf(options.key);
  return key === undefined ? rules : rules.filter((rule) => rule.key === key);
}

/** 行序重放 usage:rule 行不计,resolve 行按 selected 累加,reset 行清零(其后为新窗口)。 */
export function usage(root: string): TipsUsage {
  const acc = rt.emptyUsage();
  for (const event of project(root).events) {
    if (event.kind === "reset") {
      acc.nodeTips = {};
      acc.nodeWords = {};
      acc.globalTips = 0;
      acc.globalWords = 0;
      continue;
    }
    if (event.kind !== "resolve") continue;
    let tips = 0;
    let words = 0;
    for (const entry of event.record.selected) {
      tips += 1;
      words += entry.words;
    }
    acc.nodeTips[event.record.nodeId] = (acc.nodeTips[event.record.nodeId] ?? 0) + tips;
    acc.nodeWords[event.record.nodeId] = (acc.nodeWords[event.record.nodeId] ?? 0) + words;
    acc.globalTips += tips;
    acc.globalWords += words;
  }
  return acc;
}

/**
 * 候选归一:预算扣减与 usage 记账必须是同一个节点。
 * - options.nodeId 有值:整批候选改写为该节点(节点内语义 = 整批同一 node);
 * - 否则要求候选间 nodeId 一致(缺 nodeId 按 runtime 口径视作 default),不一致拒收;
 * - 两者都无 → default。
 */
function normalizeCandidates(
  candidates: unknown,
  explicitNodeId: string | undefined): { ok: boolean; nodeId: string; candidates: unknown[] } {
  const list = Array.isArray(candidates) ? candidates : [];
  if (explicitNodeId !== undefined) {
    return {
      ok: true,
      nodeId: explicitNodeId,
      candidates: list.map((raw) => (isRecord(raw) ? { ...raw, nodeId: explicitNodeId } : raw)),
    };
  }
  const seen = new Set<string>();
  let missing = false;
  for (const raw of list) {
    if (!isRecord(raw)) continue;
    const nodeId = textOf(raw["nodeId"]);
    if (nodeId === undefined) missing = true;
    else seen.add(nodeId);
  }
  if (missing) seen.add("default");
  if (seen.size > 1) return { ok: false, nodeId: firstNodeId(list) ?? "default", candidates: [] };
  return { ok: true, nodeId: [...seen][0] ?? "default", candidates: list };
}

/** 解析一次候选集:读规则 + 重放 usage → runtime 选择 → 追加 resolve 行。 */
export function resolve(
  root: string,
  candidates: unknown,
  options: { nodeId?: string; budget?: TipsBudget; now?: number } = {},
): TipsStoreResolveResult {
  const path = tipsPath(root);
  const rules = listRules(root);
  const before = usage(root);
  const normalized = normalizeCandidates(candidates, textOf(options.nodeId));
  if (!normalized.ok) {
    return {
      selected: [],
      dropped: [],
      usageAfter: before,
      codes: ["TIPS_STORE_INVALID_INPUT"],
      nodeId: normalized.nodeId,
      recorded: false,
    };
  }
  const result = rt.resolveTips(
    { rules, candidates: normalized.candidates },
    { usage: before, budget: options.budget, nodeId: normalized.nodeId, now: options.now },
  );
  const nodeId = normalized.nodeId;
  const record: TipsResolveRecord = {
    nodeId,
    selected: result.selected.map((entry: SelectedTip) => ({
      ruleId: entry.rule.id,
      key: entry.rule.key,
      words: rt.countWords(entry.text),
      compressed: entry.compressed,
    })),
    dropped: result.dropped.map((entry: DroppedTip) => ({
      ruleId: entry.ruleId,
      code: entry.code,
      reason: entry.reason,
    })),
    codes: [...result.codes],
  };
  const recorded = appendLine(path, { v: 1, type: "resolve", at: options.now ?? Date.now(), result: record });
  const codes = [...result.codes];
  codes.push(recorded ? "TIPS_RULE_RESOLVED" : "TIPS_STORE_WRITE_FAILED");
  return { ...result, codes, nodeId, recorded };
}

function firstNodeId(candidates: unknown[]): string | undefined {
  for (const raw of candidates) {
    if (!isRecord(raw)) continue;
    const nodeId = textOf(raw["nodeId"]);
    if (nodeId !== undefined) return nodeId;
  }
  return undefined;
}

/** 追加 reset 行:此后重放从空窗口开始。 */
export function resetUsage(root: string, options: { now?: number } = {}): { ok: boolean; codes: string[] } {
  const path = tipsPath(root);
  const wrote = appendLine(path, { v: 1, type: "reset", at: options.now ?? Date.now() });
  return wrote ? { ok: true, codes: ["TIPS_USAGE_RESET"] } : { ok: false, codes: ["TIPS_STORE_WRITE_FAILED"] };
}

/** 报表:规则数/分组、丢弃原因(按 code)、压缩数、选择次数、坏行数。 */
export function reportTips(root: string): TipsStoreReport {
  const projection = project(root);
  const rules = projectRules(projection.events);
  const byCategory: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  for (const rule of rules) {
    byCategory[String(rule.category)] = (byCategory[String(rule.category)] ?? 0) + 1;
    byPriority[String(rule.priority)] = (byPriority[String(rule.priority)] ?? 0) + 1;
  }
  const dropsByReason: Record<string, number> = {};
  let compressed = 0;
  let resolves = 0;
  for (const event of projection.events) {
    if (event.kind !== "resolve") continue;
    resolves += 1;
    for (const entry of event.record.dropped) {
      dropsByReason[entry.code] = (dropsByReason[entry.code] ?? 0) + 1;
    }
    for (const entry of event.record.selected) if (entry.compressed) compressed += 1;
  }
  return {
    rules: rules.length,
    byCategory,
    byPriority,
    dropsByReason,
    compressed,
    resolves,
    badLines: projection.badLines,
  };
}
