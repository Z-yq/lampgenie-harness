#!/usr/bin/env tsx
/**
 * Prompt footprint 预算闸 / 负收益剪枝 CLI(CI 入口)。
 * 用法:
 * tsx scripts/prompt-budget-gate.mts --manifest <next.json> \
 * [--baseline <base.json>] [--budget <budget.json>] [--experiments <ledger.jsonl|json>] \
 * [--changed id1,id2] [--max-delta <tokens>] [--max-delta-ratio <ratio>] [--json] [--report]
 * 行为:
 * - 无 --baseline:只跑 evaluateBudget;
 * - 有 --baseline:额外跑 evaluateDelta(用 --changed 作为 allowChangedIds,阈值取 --max-delta /
 * --max-delta-ratio,未给则回落到 budget.deltaRatio);
 * - 有 --experiments:额外输出 negativeReturnPrunes(只读账本,不落盘);
 * - --json 机器可读;--report 人读摘要(默认两者都不给时打精简摘要)。
 * 退出码(CI 契约):
 * 0 = 全部通过;
 * 2 = 任一 breach(预算/增量)或存在可执行剪枝(CI 要拦);
 * 1 = 参数/读取错误(含预算/账本文件坏);
 * 3 = manifest 坏(JSON 非法或缺字段)。
 * 口径:chars 逐字 exact;tokensRaw 不乘系数;tokensEstimate 乘 provider 标定 ratio(缺省 1),两列不合成。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PROMPT_BUDGET_GATE_VERSION,
  evaluateBudget,
  evaluateDelta,
  negativeReturnPrunes,
  type DeltaEvaluation,
  type BudgetEvaluation,
  type NegativeReturnReport,
  type PromptBudget,
} from "../packages/harness-runtime/src/agent/prompt-budget-gate.ts";
import { SECTION_CATEGORIES, parseFootprintManifest, type FootprintInput } from "../packages/harness-runtime/src/agent/prompt-footprint.ts";

const args = process.argv.slice(2);

function valueOf(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function die(code: number, msg: string): never {
  console.error(msg);
  process.exit(code);
  throw new Error(msg);
}

const VALUE_FLAGS = new Set([
  "--manifest",
  "--baseline",
  "--budget",
  "--experiments",
  "--changed",
  "--max-delta",
  "--max-delta-ratio",
]);
const BOOL_FLAGS = new Set(["--json", "--report"]);
for (let i = 0; i < args.length; i += 1) {
  const a = args[i]!;
  if (BOOL_FLAGS.has(a)) continue;
  if (!VALUE_FLAGS.has(a)) die(1, `未知参数: ${a}`);
  if (args[i + 1] === undefined) die(1, `参数 ${a} 缺少取值`);
  i += 1;
}

const manifestPath = valueOf("--manifest");
if (!manifestPath) {
  die(1, "用法: --manifest <next.json> [--baseline <base.json>] [--budget <budget.json>] [--experiments <ledger>] [--changed id1,id2] [--json] [--report]");
}
const baselinePath = valueOf("--baseline");
const budgetPath = valueOf("--budget");
const experimentsPath = valueOf("--experiments");
const changedArg = valueOf("--changed");
const maxDeltaArg = valueOf("--max-delta");
const maxRatioArg = valueOf("--max-delta-ratio");
const asJson = args.includes("--json");
const asReport = args.includes("--report");

function readText(path: string): string {
  try {
    return readFileSync(resolve(path), "utf8");
  } catch (err) {
    die(1, `读取失败(${path}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** manifest 坏 → 退出码 3(与 prompt-footprint CLI 同口径)。 */
function loadManifest(path: string): FootprintInput {
  const parsed = parseFootprintManifest(readText(path));
  if (!parsed.ok) die(3, `${parsed.code}: ${parsed.message}(${path})`);
  return parsed.input;
}

function parseNumberArg(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) die(1, `参数 ${name} 必须是非负数字: ${raw}`);
  return value;
}

const nextInput = loadManifest(manifestPath);
const baseInput = baselinePath ? loadManifest(baselinePath) : undefined;

let budget: PromptBudget | undefined;
if (budgetPath) {
  let raw: unknown;
  try {
    raw = JSON.parse(readText(budgetPath));
  } catch (err) {
    die(1, `预算文件 JSON 非法(${budgetPath}): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) die(1, `预算文件根必须是对象(${budgetPath})`);
  budget = raw as PromptBudget;
}

const changedIds = changedArg
  ? changedArg.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
  : [];
const maxDeltaTokens = parseNumberArg("--max-delta", maxDeltaArg);
const maxDeltaRatio = parseNumberArg("--max-delta-ratio", maxRatioArg) ?? budget?.deltaRatio;

const budgetEval: BudgetEvaluation = evaluateBudget(nextInput, budget);
let deltaEval: DeltaEvaluation | undefined;
if (baseInput) {
  deltaEval = evaluateDelta(baseInput, nextInput, {
    allowChangedIds: changedIds,
    maxDeltaTokens,
    maxDeltaRatio,
    unit: budget?.unit,
  });
}

let pruneReport: NegativeReturnReport | undefined;
if (experimentsPath) {
  const text = readText(experimentsPath);
  const trimmed = text.trim();
  let experiments: unknown;
  if (trimmed.length === 0) {
    experiments = [];
  } else {
 // 先按整文件 JSON 解;失败再退回 JSONL(账本常见为 .jsonl 逐行记录)。
    try {
      experiments = JSON.parse(trimmed);
    } catch (wholeErr) {
      const rows: unknown[] = [];
      let ok = true;
      for (const [index, line] of trimmed.split(/\r?\n/).entries()) {
        if (line.trim().length === 0) continue;
        try {
          rows.push(JSON.parse(line));
        } catch (err) {
          ok = false;
          die(
            1,
            `账本既非合法 JSON 也非合法 JSONL(${experimentsPath})第 ${index + 1} 行: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (!ok) die(1, `账本 JSON 非法(${experimentsPath}): ${wholeErr instanceof Error ? wholeErr.message : String(wholeErr)}`);
      experiments = rows;
    }
  }
  pruneReport = negativeReturnPrunes(experiments, nextInput);
}

/** 人读摘要:每类 used/limit(+delta)、breach 明细、剪枝清单。 */
function renderReport(): string {
  const lines: string[] = [];
  lines.push(`prompt-budget-gate v${PROMPT_BUDGET_GATE_VERSION} — ${manifestPath}`);
  lines.push(`unit=${budgetEval.unit} budget=${budgetEval.verdict} code=${budgetEval.code}` + (deltaEval ? ` delta=${deltaEval.verdict}/${deltaEval.code}` : ""));
  const checkByCategory = new Map<string, BudgetEvaluation["checks"][number]>();
  for (const check of budgetEval.checks) {
    if (check.scope === "category" && check.category) checkByCategory.set(check.category, check);
  }
  const totalCheck = budgetEval.checks.find((c) => c.scope === "total");
  const totalLimit = totalCheck ? String(totalCheck.limit) : "-";
  const deltaTotal = deltaEval?.totalDelta ?? 0;
  const totalUsed = budgetEval.unit === "raw" ? budgetEval.report.total.tokensRaw : budgetEval.report.total.tokensEstimate;
  lines.push(
    `total      used=${totalUsed}(${budgetEval.unit}) limit=${totalLimit}` +
      (deltaEval ? ` delta=${deltaTotal >= 0 ? "+" : ""}${deltaTotal}` : ""),
  );
  for (const category of SECTION_CATEGORIES) {
    const stat = budgetEval.report.byCategory[category];
    const check = checkByCategory.get(category);
    const delta = deltaEval?.categories.find((c) => c.category === category)?.delta;
    lines.push(
      `  ${category.padEnd(14)} used=${String(stat.tokensEstimate).padEnd(8)} limit=${String(check?.limit ?? "-").padEnd(8)}` +
        (delta === undefined ? "" : ` delta=${delta >= 0 ? "+" : ""}${delta}`),
    );
  }
  if (budgetEval.breaches.length > 0) {
    lines.push("breaches(budget):");
    for (const breach of budgetEval.breaches) lines.push(`  [${breach.code}] ${breach.message}`);
  }
  if (deltaEval && deltaEval.breaches.length > 0) {
    lines.push("breaches(delta):");
    for (const breach of deltaEval.breaches) lines.push(`  [${breach.code}] ${breach.message}`);
  }
  if (deltaEval) {
    const changed = deltaEval.changed.length > 0 ? deltaEval.changed.join(", ") : "-";
    lines.push(`changed=${changed} added=${deltaEval.added.length} removed=${deltaEval.removed.length}`);
  }
  if (pruneReport) {
    lines.push(`prunes=${pruneReport.prunes.length} unattributed=${pruneReport.unattributed.length} code=${pruneReport.code}`);
    for (const prune of pruneReport.prunes) {
      lines.push(
        `  [prune] ${prune.experimentId} ${prune.surface}:${prune.ref} → ${prune.sections.join(", ")} ` +
          `节省≈${prune.estimatedTokensSaved}(${prune.savedFrom})`,
      );
    }
    for (const item of pruneReport.unattributed) {
      lines.push(`  [unattributed] ${item.experimentId} ${item.surface}:${item.ref} (${item.reason})`);
    }
  }
  return lines.join("\n");
}

if (asJson) {
  const payload = {
    version: PROMPT_BUDGET_GATE_VERSION,
    manifest: manifestPath,
    budget: budgetEval,
    delta: deltaEval,
    prunes: pruneReport,
  };
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log(renderReport());
}

// 退出码判定:预算/增量 breach、可执行剪枝 → 2;坏输入已在上面各自退出。
const budgetInvalid = budgetEval.verdict === "invalid";
const deltaInvalidOrMissing = deltaEval !== undefined && (deltaEval.verdict === "invalid" || deltaEval.verdict === "no-baseline");
const hasBreach = budgetEval.verdict === "over" || (deltaEval !== undefined && deltaEval.verdict === "over");
const hasPrune = (pruneReport?.prunes.length ?? 0) > 0;
const prunesInvalid = pruneReport !== undefined && pruneReport.code !== "OK";

if (budgetInvalid) die(1, `预算配置非法: ${budgetEval.breaches[0]?.message ?? "INVALID"}`);
if (deltaInvalidOrMissing) die(1, `增量判定不可用: ${deltaEval?.breaches[0]?.message ?? "NO_BASELINE"}`);
if (prunesInvalid) die(1, `剪枝输入非法: ${pruneReport?.code}`);
if (hasBreach || hasPrune) {
  if (asReport || !asJson) {
    const names = [...budgetEval.breaches, ...(deltaEval?.breaches ?? [])].map((b) => b.code);
    const pruneNote = hasPrune ? ` 可执行剪枝 ${pruneReport?.prunes.length} 条` : "";
    console.error(`FAIL: ${names.length > 0 ? names.join(", ") : "OK"}${pruneNote}`);
  }
  process.exit(2);
}
process.exit(0);
