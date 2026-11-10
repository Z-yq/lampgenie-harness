#!/usr/bin/env -S node --experimental-strip-types
/**
 * 一次通过率与缺陷逃逸度量 CLI(RSI #212):--delivery / --fix / --compute / --report / --review / --audit-rows。
 *
 * 纯表面层:关联/分桶/五项指标/前后对比在 packages/harness-runtime/src/agent/cohort-metrics.ts(纯逻辑),
 * 落盘与投影在 apps/gateway/src/cohort-metrics-store.ts(`<root>/.genie/rsi/cohort.jsonl`,append-only)。
 * 本文件只做 argv 解析、JSON 读入与退出码映射。
 *
 * 用法:
 *   node --experimental-strip-types scripts/cohort-metrics.mts --root <dir> --delivery <file|-> [--fix <file|->]
 *   node --experimental-strip-types scripts/cohort-metrics.mts --root <dir> --compute [--window-days N] [--min-deliveries N] [--json]
 *   node --experimental-strip-types scripts/cohort-metrics.mts --root <dir> --report [--json]
 *   node --experimental-strip-types scripts/cohort-metrics.mts --root <dir> --review [--before-signatures a,b] [--after-signatures c] [--json]
 *   node --experimental-strip-types scripts/cohort-metrics.mts --root <dir> --audit-rows [--json]
 *
 * 输入:路径或 - 表示 stdin;JSON 可为单对象 / {delivery:...} / {fix:...} / 数组(逐个登记)。
 * 退出码:0 成功 / 1 参数错误(含输入非法、登记被拒)。
 */
import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  compute,
  exportAuditRows,
  recordDelivery,
  recordFix,
  reportCohorts,
  review,
} from "../apps/gateway/src/cohort-metrics-store.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;

const VALUE_FLAGS = new Set([
  "root",
  "delivery",
  "fix",
  "window-days",
  "min-deliveries",
  "before-signatures",
  "after-signatures",
]);

const BOOL_FLAGS = new Set(["compute", "report", "review", "audit-rows", "json", "help"]);

const COMMANDS = ["compute", "report", "review", "audit-rows"] as const;

type Command = (typeof COMMANDS)[number];

interface Parsed {
  values: Map<string, string>;
  multi: Map<string, string[]>;
  flags: Set<string>;
}

const HELP = [
  "用法:node --experimental-strip-types scripts/cohort-metrics.mts --root <dir> <子命令> [--json]",
  "",
  "  --root <dir>                       台账根目录(真实运行请只给 /tmp 下的目录)",
  "  --delivery <file|->                登记交付(JSON:对象 / {delivery:...} / 数组)",
  "  --fix <file|->                     登记修复(JSON:对象 / {fix:...} / 数组)",
  "  --compute [--window-days N] [--min-deliveries N] [--json]   算桶指标(关联+五项指标)",
  "  --report [--json]                  汇总报表(totals / byModule / byTaskClass / byBoardType / byDefectClass / sampleLow)",
  "  --review [--before-signatures a,b] [--after-signatures c,d] [--json]  复审清单(flat/declined)",
  "  --audit-rows [--json]              审计面行(模块/类别/任务类/板型/指标/样本)",
  "  --help                             本帮助",
  "",
  "退出码:0 成功 / 1 参数错误。",
].join("\n");

function parseArgs(argv: string[]): Parsed {
  const values = new Map<string, string>();
  const multi = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]!;
    if (!raw.startsWith("--")) throw new Error(`无法识别的参数:${raw}`);
    const name = raw.slice(2);
    if (BOOL_FLAGS.has(name)) {
      flags.add(name);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new Error(`未知选项 --${name}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`--${name} 需要取值`);
    if (name === "delivery" || name === "fix") {
      const list = multi.get(name) ?? [];
      list.push(next);
      multi.set(name, list);
    } else {
      values.set(name, next);
    }
    i += 1;
  }
  return { values, multi, flags };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(spec: string, label: string): Promise<unknown> {
  const text = spec === "-" ? await readStdin() : await readFile(spec, "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON:${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 从 `{delivery:...}` / `{fix:...}` / 数组 / 裸对象里取出全部记录。 */
function unwrapAll(payload: unknown, key: "delivery" | "fix"): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== "object" || payload === null) throw new Error("输入必须是 JSON 对象或数组");
  const record = payload as Record<string, unknown>;
  if (Object.keys(record).length === 1 && record[key] !== undefined) {
    const inner = record[key];
    return Array.isArray(inner) ? inner : [inner];
  }
  return [record];
}

function commandOf(parsed: Parsed): Command | undefined {
  const present = COMMANDS.filter((name) => parsed.flags.has(name));
  if (present.length > 1) throw new Error(`子命令互斥:${present.join(" / ")}`);
  return present[0];
}

function intOf(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${label} 需要非负数字`);
  return n;
}

function listOf(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function p(line: string): void {
  process.stdout.write(`${line}\n`);
}

function printJson(value: unknown): void {
  p(JSON.stringify(value, null, 2));
}

function fmtRate(value: number | null): string {
  return value === null ? "null" : String(value);
}

async function registerAll(root: string, specs: string[] | undefined, kind: "delivery" | "fix"): Promise<boolean> {
  if (specs === undefined) return true;
  for (const spec of specs) {
    const payload = await readJson(spec, `--${kind}`);
    for (const item of unwrapAll(payload, kind)) {
      const result = kind === "delivery" ? recordDelivery(root, item) : recordFix(root, item);
      if (!result.ok) {
        p(`${kind} 拒收: code=${result.code ?? "unknown"}${result.id ? ` id=${result.id}` : ""}`);
        return false;
      }
      p(`${kind} 已登记:${result.id}`);
    }
  }
  return true;
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.flags.has("help")) {
    p(HELP);
    return EXIT_OK;
  }
  const root = parsed.values.get("root") ?? process.cwd();
  const asJson = parsed.flags.has("json");
  const command = commandOf(parsed);

  const registered = await registerAll(root, parsed.multi.get("delivery"), "delivery");
  if (!registered) return EXIT_USAGE;
  const fixed = await registerAll(root, parsed.multi.get("fix"), "fix");
  if (!fixed) return EXIT_USAGE;

  if (command === undefined) {
    if (parsed.multi.size === 0) throw new Error("需要至少一个子命令(--compute/--report/--review/--audit-rows)或 --delivery/--fix");
    return EXIT_OK;
  }

  if (command === "compute") {
    const windowDays = intOf(parsed.values.get("window-days"), "window-days");
    const minDeliveries = intOf(parsed.values.get("min-deliveries"), "min-deliveries");
    const options: { windowDays?: number; minDeliveries?: number } = {};
    if (windowDays !== undefined) options.windowDays = windowDays;
    if (minDeliveries !== undefined) options.minDeliveries = minDeliveries;
    const result = compute(root, options);
    if (asJson) {
      printJson(result);
      return EXIT_OK;
    }
    p(
      `compute: 行=${result.totalLines} 坏行=${result.parseErrors} 桶=${result.cohorts.length} 关联=${result.linked.length} 未关联=${result.unlinked.length} codes=${result.codes.join(",")}`,
    );
    for (const cohort of result.cohorts) {
      const signature = cohort.key.signature !== undefined ? `#${cohort.key.signature}` : "";
      p(
        `  ${cohort.key.module}/${cohort.key.taskClass}/${cohort.key.boardType}${signature}: D=${cohort.deliveries} E=${cohort.escapes} firstPass=${fmtRate(cohort.firstPassRate)} escape=${fmtRate(cohort.escapeRate)} fanout=${fmtRate(cohort.fanoutReworkRate)} delayMedian=${fmtRate(cohort.discoveryDelay.medianDays)}d byStage=${JSON.stringify(cohort.discoveryDelay.byStage)} classes=${JSON.stringify(cohort.escapeClasses)} sample=${cohort.sampleSufficient ? "ok" : "low"}`,
      );
    }
    for (const fix of result.unlinked) p(`  未关联修复:${fix.id}(module=${fix.module} at=${fix.at})`);
    return EXIT_OK;
  }

  if (command === "report") {
    const result = reportCohorts(root);
    if (asJson) {
      printJson(result);
      return EXIT_OK;
    }
    p(
      `report: 行=${result.totalLines} 坏行=${result.parseErrors} 桶=${result.cohorts} 交付=${result.totals.deliveries} 逃逸=${result.totals.escapes} firstPass=${fmtRate(result.totals.firstPassRate)} escape=${fmtRate(result.totals.escapeRate)} fanout=${fmtRate(result.totals.fanoutReworkRate)}`,
    );
    p(`  byModule=${JSON.stringify(result.byModule)}`);
    p(`  byTaskClass=${JSON.stringify(result.byTaskClass)}`);
    p(`  byBoardType=${JSON.stringify(result.byBoardType)}`);
    p(`  byDefectClass=${JSON.stringify(result.byDefectClass)}`);
    p(`  sampleLow=${JSON.stringify(result.sampleLow)}`);
    return EXIT_OK;
  }

  if (command === "review") {
    const before = listOf(parsed.values.get("before-signatures"));
    const after = listOf(parsed.values.get("after-signatures"));
    const options: { beforeSignatures?: string[]; afterSignatures?: string[] } = {};
    if (before !== undefined) options.beforeSignatures = before;
    if (after !== undefined) options.afterSignatures = after;
    const result = review(root, options);
    if (asJson) {
      printJson(result);
      return EXIT_OK;
    }
    p(`review: mode=${result.mode} 对比=${result.comparisons.length} 待复审=${result.items.length} codes=${result.codes.join(",")}`);
    for (const item of result.items) {
      const signature = item.signature !== undefined ? `#${item.signature}` : "";
      p(
        `  ${item.module}/${item.taskClass}/${item.boardType}${signature}: ${item.verdict} delta=${item.deltaPct}% before=${fmtRate(item.beforeFirstPassRate)}(D=${item.beforeDeliveries}) after=${fmtRate(item.afterFirstPassRate)}(D=${item.afterDeliveries}) — ${item.reason}`,
      );
    }
    return EXIT_OK;
  }

  // audit-rows
  const audit = exportAuditRows(root);
  if (asJson) {
    printJson(audit);
    return EXIT_OK;
  }
  p(`audit-rows: 行=${audit.totalLines} 坏行=${audit.parseErrors} 行数=${audit.rows.length} codes=${audit.codes.join(",")}`);
  for (const row of audit.rows) {
    const signature = row.signature !== undefined ? `#${row.signature}` : "";
    const defectClass = row.defectClass !== undefined ? `/${row.defectClass}` : "";
    p(
      `  ${row.module}/${row.taskClass}/${row.boardType}${signature}${defectClass}: D=${row.deliveries} E=${row.escapes} firstPass=${row.firstPassRate} escape=${row.escapeRate} fanout=${fmtRate(row.fanoutReworkRate)} delayMedian=${fmtRate(row.medianDiscoveryDays)}d sample=${row.sampleSufficient ? "ok" : "low"}`,
    );
  }
  return EXIT_OK;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT_USAGE;
  });
