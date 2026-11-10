#!/usr/bin/env node
/**
 * RSI 成本与 ROI 门 CLI(RSI 成本 2026-11):记账 / 周期报告 / ROI 评测 / 状态 / 报告 / 采纳门。
 * 纯表面层:所有账本与门禁逻辑在
 * packages/harness-runtime/src/agent/rsi-cost-roi.ts(纯逻辑)
 * apps/gateway/src/rsi-cost-store.ts(.genie/rsi/cost.jsonl 追加事件 + 投影)
 * 本文件只做 argv 解析、JSON/NDJSON 输入读入与退出码映射。
 * 退出码:0 成功 / 1 参数或运行错误 / 2 采纳门不通过(RSI_ROI_ADOPT_*)。
 * 注意:--evaluate 得出 downshift/pause 不算失败(门禁生效是正常结论),仍 exit 0;
 * 要真正停摆必须显式 --apply(暂停还会调 --breaker-root 的熔断台账)。
 * 用法:node --experimental-strip-types scripts/rsi-cost-roi.mts --root <dir> ...
 */
import fs from "node:fs";

import {
  adoptRoiGate,
  type RoiPolicy,
} from "../packages/harness-runtime/src/agent/rsi-cost-roi.ts";
import {
  cycleReport,
  evaluateRoiGate,
  recordCost,
  recordSavings,
  reportCost,
} from "../apps/gateway/src/rsi-cost-store.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_ADOPT_BLOCKED = 2;

const VALUE_FLAGS = new Set([
  "root",
  "cost",
  "saving",
  "cycle",
  "cycles",
  "policy",
  "breaker-root",
  "adopt-check",
]);

const BOOL_FLAGS = new Set(["json", "evaluate", "apply", "status", "report", "help"]);

type Parsed = { values: Map<string, string>; lists: Map<string, string[]>; flags: Set<string>; positional: string[] };

function parseArgs(argv: string[]): Parsed {
  const values = new Map<string, string>;
  const lists = new Map<string, string[]>;
  const flags = new Set<string>;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) {
      positional.push(raw);
      continue;
    }
    const name = raw.slice(2);
    if (VALUE_FLAGS.has(name)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        values.set(name, "");
        continue;
      }
      values.set(name, next);
      const bucket = lists.get(name);
      if (bucket === undefined) lists.set(name, [next]);
      else bucket.push(next);
      i += 1;
      continue;
    }
    if (BOOL_FLAGS.has(name)) flags.add(name);
  }
  return { values, lists, flags, positional };
}

function emit(json: boolean, payload: Record<string, unknown>, lines: string[]): void {
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`${lines.join("\n")}\n`);
}

function fail(code: number, message: string, json: boolean): never {
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, codes: [message], exitCode: code }, null, 2)}\n`);
  else process.stdout.write(`${message}\n`);
  process.exit(code);
  throw new Error(message);
}

/** `-` = stdin;JSON 数组或 NDJSON(逐行对象)都接受。 */
function readEntries(spec: string): unknown[] {
  const text = spec === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(spec, "utf8");
  const trimmed = text.trim;
  if (trimmed === "") return [];
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  }
  const out: unknown[] = [];
  for (const line of trimmed.split("\n")) {
    const row = line.trim;
    if (row === "") continue;
    out.push(JSON.parse(row));
  }
  return out;
}

function parsePolicy(raw: string | undefined): Partial<RoiPolicy> | undefined {
  if (raw === undefined || raw === "") return undefined;
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("--policy 必须是 JSON 对象");
  }
  return parsed as Partial<RoiPolicy>;
}

function helpText: string {
  return [
    "用法:node --experimental-strip-types scripts/rsi-cost-roi.mts --root <dir> [子命令] [--json]",
    "  --cost <file|->            记成本条目(JSON 数组或 NDJSON;'-'=stdin;可重复)",
    "  --saving <file|->          记节省条目(可重复)",
    "  --cycle <cycleId>          打印该周期报告(可与 --cost/--saving 同用:先记账再报告)",
    "  --evaluate [--cycles a,b] [--policy '<json>'] [--apply] [--breaker-root <dir>]",
    "                             评测 ROI 门;缺省只预览(不落盘),--apply 才落 downshift/pause",
    "  --status                   最近一次降频/停摆状态(无则说明未触发)",
    "  --report                   汇总:周期 / 累计 / 两维度分摊 / 最近状态 / 坏行",
    "  --adopt-check '{\"estimateRoi\":..,\"measuredRoi\":..}'  采纳门(不通过 exit 2)",
    "  --help                     本帮助",
    "退出码:0 成功 / 1 参数错误 / 2 采纳门不通过(--evaluate 的 downshift/pause 仍 exit 0)",
  ].join("\n");
}

function num(value: number | null): string {
  return value === null ? "null" : String(Number(value.toFixed(4)));
}

async function main: Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  const json = parsed.flags.has("json");
  const root = parsed.values.get("root") ?? "";
  const get = (name: string): string | undefined => {
    const value = parsed.values.get(name);
    return value === undefined || value === "" ? undefined : value;
  };
 /** 可重复的取值旗标(--cost/--saving 可写多次,每次一个文件)。 */
  const all = (name: string): string[] => {
    const bucket = parsed.lists.get(name);
    if (bucket !== undefined && bucket.length > 0) return bucket;
    const single = get(name);
    return single === undefined ? [] : [single];
  };

  if (parsed.flags.has("help") || (parsed.flags.size === 0 && parsed.values.size === 0)) {
    process.stdout.write(`${helpText}\n`);
    return EXIT_OK;
  }

  if (!root) fail(EXIT_USAGE, "--root 必填", json);

 // 1) 记账(--cost/--saving 可重复,逐个文件读入)
  const recorded = { costs: 0, savings: 0 };
  for (const costPath of all("cost")) {
    for (const entry of readEntries(costPath)) {
      const result = recordCost(root, entry as never);
      if (!result.ok) fail(EXIT_USAGE, result.codes.join(","), json);
      recorded.costs += 1;
    }
  }
  for (const savingPath of all("saving")) {
    for (const entry of readEntries(savingPath)) {
      const result = recordSavings(root, entry as never);
      if (!result.ok) fail(EXIT_USAGE, result.codes.join(","), json);
      recorded.savings += 1;
    }
  }
  const wrote = recorded.costs + recorded.savings;

  const cycleId = get("cycle");
  const wantEvaluate = parsed.flags.has("evaluate");
  const wantStatus = parsed.flags.has("status");
  const wantReport = parsed.flags.has("report");
  const adoptRaw = get("adopt-check");

  if (!cycleId && !wantEvaluate && !wantStatus && !wantReport && adoptRaw === undefined) {
    if (wrote === 0) fail(EXIT_USAGE, "需要子命令:--cost/--saving/--cycle/--evaluate/--status/--report/--adopt-check/--help", json);
    const cycles = recordSummary(root);
    emit(json, { ok: true, recorded, cycles }, [
      `已记账:cost ${recorded.costs} 条 / saving ${recorded.savings} 条`,
      `台账周期:${cycles.length === 0 ? "(空)" : cycles.join(",")}`,
    ]);
    return EXIT_OK;
  }

  let exitCode = EXIT_OK;

 // 2) 周期报告
  if (cycleId !== undefined) {
    const report = cycleReport(root, cycleId);
    emit(
      json,
      { ok: true, recorded, report },
      [
        `周期 ${report.cycleId}:cost=${report.costTokens} saving=${report.savingTokens} net=${report.netTokens} roi=${num(report.roi)}`,
        `  条目:cost ${report.entries.costs} / saving ${report.entries.savings},invalid=${report.invalid},坏行=${report.badLines}`,
        `  按阶段:${Object.entries(report.costByStage)
          .filter(([, value]) => value !== 0)
          .map(([key, value]) => `${key}=${value}`)
          .join(",") || "(无)"}`,
        `  按机制:${Object.entries(report.costByMechanism).map(([key, value]) => `${key}=${value}`).join(",") || "(无)"}`,
        `  按项目:${Object.entries(report.costByProject).map(([key, value]) => `${key}=${value}`).join(",") || "(无)"}`,
      ];
  }

 // 3) ROI 评测
  if (wantEvaluate) {
    const cyclesRaw = get("cycles");
    const policy = parsePolicy(get("policy"));
    const result = await evaluateRoiGate(root, {
      cycleIds: cyclesRaw === undefined ? undefined : cyclesRaw.split(",").map((id) => id.trim).filter((id) => id !== ""),
      policy,
      apply: parsed.flags.has("apply"),
      breakerRoot: get("breaker-root"),
    });
    const factor = result.quota.nightlyWindowFactor;
    emit(
      json,
      {
        ok: result.ok,
        action: result.action,
        codes: result.codes,
        negativeStreak: result.negativeStreak,
        quota: result.quota,
        detail: result.detail,
        applied: result.applied,
        wroteLines: result.wroteLines,
        cycleIds: result.cycleIds,
        breaker: result.breaker,
        badLines: result.badLines,
      },
      [
        `ROI 门:action=${result.action} streak=${result.negativeStreak} codes=[${result.codes.join(",")}]`,
        `  配额:nightlyWindowFactor=${factor === undefined ? "-" : factor} experimentQuotaFactor=${result.quota.experimentQuotaFactor ?? "-"}`,
        `  ${result.detail}`,
        `  ${result.applied ? `已落盘 ${result.wroteLines} 行` : "预览(未落盘;加 --apply 才落盘)"}` +
          (result.breaker === undefined
            ? ""
            : ` 熔断:${result.breaker.ok ? "paused" : result.breaker.codes.join(",")}`),
      ];
  }

 // 4) 状态
  if (wantStatus) {
    const report = reportCost(root);
    const last = report.lastGate;
    emit(
      json,
      { ok: true, lastGate: last, badLines: report.badLines, cycles: report.cycles },
      last === undefined
        ? ["ROI 门状态:未触发降频/停摆(台账无 downshift 行)"]
        : [
            `ROI 门状态:${last.action} at=${last.at} streak=${last.negativeStreak}`,
            `  配额:nightlyWindowFactor=${last.quota.nightlyWindowFactor ?? "-"} experimentQuotaFactor=${last.quota.experimentQuotaFactor ?? "-"}`,
          ];
  }

 // 5) 汇总报告
  if (wantReport) {
    const report = reportCost(root);
    const lines = [
      `周期 ${report.cycles.length} 个:${report.cycles.join(",") || "(空)"}`,
      `累计:cost=${report.totals.costTokens} saving=${report.totals.savingTokens} net=${report.totals.netTokens} roi=${num(report.totals.roi)} wallMs=${report.totals.wallMs}`,
      `按阶段:${Object.entries(report.totals.costByStage)
        .filter(([, value]) => value !== 0)
        .map(([key, value]) => `${key}=${value}`)
        .join(",") || "(无)"}`,
      `按机制:${report.byMechanism.map((row) => `${row.key} cost=${row.costTokens} saving=${row.savingTokens} net=${row.netTokens}`).join("; ") || "(无)"}`,
      `按项目:${report.byProject.map((row) => `${row.key} cost=${row.costTokens} saving=${row.savingTokens} net=${row.netTokens}`).join("; ") || "(无)"}`,
      `最近门禁:${report.lastGate === undefined ? "未触发" : `${report.lastGate.action} at=${report.lastGate.at} streak=${report.lastGate.negativeStreak}`}`,
      `坏行:${report.badLines}/${report.totalLines}`,
    ];
    emit(json, { ok: report.ok, report }, lines);
  }

 // 6) 采纳门
  if (adoptRaw !== undefined) {
    let payload: Record<string, unknown>;
    try {
      const parsedAdopt = JSON.parse(adoptRaw);
      if (typeof parsedAdopt !== "object" || parsedAdopt === null || Array.isArray(parsedAdopt)) {
        throw new TypeError("--adopt-check 必须是 JSON 对象");
      }
      payload = parsedAdopt as Record<string, unknown>;
    } catch {
      fail(EXIT_USAGE, "--adopt-check 必须是 JSON 对象", json);
    }
    const gate = adoptRoiGate(payload);
    if (!gate.ok) exitCode = EXIT_ADOPT_BLOCKED;
    emit(json, { ok: gate.ok, codes: gate.codes, detail: gate.detail }, [
      `采纳门:${gate.ok ? "通过" : "拒绝"} codes=[${gate.codes.join(",")}]`,
      `  ${gate.detail}`,
    ]);
  }

  return exitCode;
}

/** 台账周期列表(记账后的小结用)。 */
function recordSummary(root: string): string[] {
  return reportCost(root).cycles;
}

main.then(
  (code) => process.exit(code),
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`错误:${message}\n`);
    process.exit(EXIT_USAGE);
  };
