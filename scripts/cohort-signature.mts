#!/usr/bin/env -S node --experimental-strip-types
/**
 * 情境签名样本 CLI:--add / --buckets / --compare / --counterfactuals / --version-change /
 * --mark-stale / --confounders / --survivor-bias / --report。
 * 纯表面层:分桶/两臂评估/反事实配对/版本治理/混杂与幸存者体检在
 * packages/harness-runtime/src/agent/cohort-signature.ts(纯逻辑),
 * 落盘与投影在 apps/gateway/src/cohort-signature-store.ts(`<root>/.genie/rsi/signatures.jsonl`,append-only)。
 * 本文件只做 argv 解析、JSON 读入、打印与退出码映射。
 * 用法:
 * node --experimental-strip-types scripts/cohort-signature.mts --root <dir> --add <file|->
 * node --experimental-strip-types scripts/cohort-signature.mts --root <dir> --buckets [--json]
 * node --experimental-strip-types scripts/cohort-signature.mts --root <dir> --compare <idA> <idB> [--strict] [--min-per-arm N] [--json]
 * node --experimental-strip-types scripts/cohort-signature.mts --root <dir> --counterfactuals [--min-per-arm N] [--json]
 * node --experimental-strip-types scripts/cohort-signature.mts --root <dir> --version-change --model <v> --provider <v> [--experiments <file>] [--json]
 * node --experimental-strip-types scripts/cohort-signature.mts --root <dir> --mark-stale [--model <v> --provider <v>] [--experiments <file>] [--json]
 * node --experimental-strip-types scripts/cohort-signature.mts --root <dir> --confounders [--json]
 * node --experimental-strip-types scripts/cohort-signature.mts --root <dir> --survivor-bias [--json]
 * node --experimental-strip-types scripts/cohort-signature.mts --root <dir> --report [--json]
 * 输入:路径或 - 表示 stdin;JSON 可为单对象 / {sample:...} / 数组(逐个登记)。
 * 退出码:0 成功 / 1 参数错误(含输入非法、登记被拒)/ 2 不可比或样本不足(compare、counterfactuals)。
 * 注意:--version-change 恒退出 0(版本变了是事实,不是错误),--survivor-bias 有偏差也只告警不失败。
 */
import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  addSample,
  buckets,
  compare,
  confounders,
  counterfactuals,
  markStale,
  reportSignatures,
  survivorBias,
  versionChange,
} from "../apps/gateway/src/cohort-signature-store.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_INCOMPARABLE = 2;

const BOOL_FLAGS = new Set([
  "buckets",
  "counterfactuals",
  "version-change",
  "mark-stale",
  "confounders",
  "survivor-bias",
  "report",
  "json",
  "strict",
  "help",
]);

const SINGLE_VALUE_FLAGS = new Set(["root", "add", "model", "provider", "experiments", "min-per-arm"]);

const COMMANDS = [
  "add",
  "buckets",
  "compare",
  "counterfactuals",
  "version-change",
  "mark-stale",
  "confounders",
  "survivor-bias",
  "report",
] as const;

type Command = (typeof COMMANDS)[number];

interface Parsed {
  values: Map<string, string>;
  flags: Set<string>;
  compare: [string, string] | undefined;
}

const HELP = [
  "用法:node --experimental-strip-types scripts/cohort-signature.mts --root <dir> <子命令> [--json]",
  "",
  "  --root <dir>                       台账根目录(必填;真实运行请只给 /tmp 下的目录)",
  "  --add <file|->                     登记样本(JSON:对象 / {sample:...} / 数组)",
  "  --buckets                          各签名桶计数(每桶一行:key D=.. F=.. I=.. C=..)",
  "  --compare <idA> <idB> [--strict] [--min-per-arm N]   两条样本的对比(同桶同 decision 成臂)",
  "  --counterfactuals [--min-per-arm N]                  同桶同指标两臂配对",
  "  --version-change --model <v> --provider <v> [--experiments <file>]   版本登记(变了则重估基线)",
  "  --mark-stale [--model <v> --provider <v>] [--experiments <file>]     按目标版本切 stale/active",
  "  --confounders                      混杂因子体检(version/project/taskClass/duration)",
  "  --survivor-bias                    幸存者偏差体检(全 done → 告警)",
  "  --report                           汇总报表(buckets / versions / 告警)",
  "  --json                             机器可读输出",
  "  --help                             本帮助",
  "",
  "退出码:0 成功 / 1 参数错误 / 2 不可比或样本不足。",
].join("\n");

function parseArgs(argv: string[]): Parsed {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  let comparePair: [string, string] | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]!;
    if (!raw.startsWith("--")) throw new Error(`无法识别的参数:${raw}`);
    const name = raw.slice(2);
    if (BOOL_FLAGS.has(name)) {
      flags.add(name);
      continue;
    }
    if (name === "compare") {
      const first = argv[i + 1];
      const second = argv[i + 2];
      if (first === undefined || second === undefined || first.startsWith("--") || second.startsWith("--")) {
        throw new Error("--compare 需要两个取值:<idA> <idB>");
      }
      if (comparePair !== undefined) throw new Error("--compare 只能给一次");
      comparePair = [first, second];
      flags.add(name);
      i += 2;
      continue;
    }
    if (!SINGLE_VALUE_FLAGS.has(name)) throw new Error(`未知选项 --${name}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`--${name} 需要取值`);
    values.set(name, next);
    i += 1;
  }
  return { values, flags, compare: comparePair };
}

function commandOf(parsed: Parsed): Command | undefined {
  const found = COMMANDS.filter(
    (command) => parsed.flags.has(command) || (command === "add" && parsed.values.has("add")),
  );
  if (found.length > 1) throw new Error(`子命令互斥,只给一个:${found.join(" / ")}`);
  return found[0];
}

function p(line: string): void {
  process.stdout.write(`${line}\n`);
}

// 下游提前关管道(`--report | head -3`)时 stdout 会抛 EPIPE:静默收工,不把栈当结论打给用户。
process.stdout.on("error", (error: { code?: string }) => {
  if (error.code === "EPIPE") process.exit(0);
});

function printJson(value: unknown): void {
  p(JSON.stringify(value, null, 2));
}

function intOf(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`--${label} 需要正整数,收到 ${value}`);
  return parsed;
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

/** 从 `{sample:...}` / `{experiments:[...]}` / 数组 / 裸对象里取出全部条目。 */
function unwrapAll(payload: unknown, key: string): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== "object" || payload === null) throw new Error("输入必须是 JSON 对象或数组");
  const record = payload as Record<string, unknown>;
  const inner = record[key];
  if (Object.keys(record).length === 1 && inner !== undefined) {
    return Array.isArray(inner) ? inner : [inner];
  }
  if (record["samples"] !== undefined && Array.isArray(record["samples"])) return record["samples"];
  return [payload];
}

/** 实验清单:数组 / {experiments:[...]},条目形如 {id, signature}。 */
async function readExperiments(spec: string | undefined): Promise<Array<{ id: string; signature: never }> | undefined> {
  if (spec === undefined) return undefined;
  const payload = await readJson(spec, "--experiments");
  const items = unwrapAll(payload, "experiments");
  const experiments: Array<{ id: string; signature: never }> = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) throw new Error("--experiments 条目必须是对象");
    const record = item as Record<string, unknown>;
    const id = record["id"];
    if (typeof id !== "string" || id.trim() === "") throw new Error("--experiments 条目缺 id");
    experiments.push({ id, signature: record["signature"] as never });
  }
  return experiments;
}

async function registerAll(root: string, spec: string | undefined): Promise<boolean> {
  if (spec === undefined) return true;
  const payload = await readJson(spec, "--add");
  for (const item of unwrapAll(payload, "sample")) {
    const result = addSample(root, item);
    if (!result.ok) {
      p(`sample 拒收: code=${result.codes.join(",") || "unknown"}${result.id !== undefined ? ` id=${result.id}` : ""}`);
      return false;
    }
    p(`sample 已登记:${result.id ?? ""}`);
  }
  return true;
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.flags.has("help")) {
    p(HELP);
    return EXIT_OK;
  }
  const root = parsed.values.get("root");
  if (root === undefined) throw new Error("缺少 --root <dir>");
  const asJson = parsed.flags.has("json");
  const command = commandOf(parsed);
  if (command === undefined) {
    throw new Error("需要至少一个子命令(--add/--buckets/--compare/--counterfactuals/--version-change/--mark-stale/--confounders/--survivor-bias/--report)");
  }

  if (command === "add") {
    const registered = await registerAll(root, parsed.values.get("add") ?? "-");
    return registered ? EXIT_OK : EXIT_USAGE;
  }

  if (command === "buckets") {
    const result = buckets(root);
    if (asJson) {
      printJson(result);
      return EXIT_OK;
    }
    p(
      `buckets: 行=${result.totalLines} 坏行=${result.parseErrors} 桶=${Object.keys(result.buckets).length} 样本=${result.totals.samples} D=${result.totals.done} F=${result.totals.failed} I=${result.totals.interrupted} C=${result.totals.cancelled}`,
    );
    for (const key of Object.keys(result.buckets).sort()) {
      const bucket = result.buckets[key]!;
      p(
        `  ${key} D=${bucket.counts.done} F=${bucket.counts.failed} I=${bucket.counts.interrupted} C=${bucket.counts.cancelled}`,
      );
    }
    return EXIT_OK;
  }

  if (command === "compare") {
    const pair = parsed.compare;
    if (pair === undefined) throw new Error("--compare 需要两个取值:<idA> <idB>");
    const options: { aId: string; bId: string; strict?: boolean; minPerArm?: number } = {
      aId: pair[0],
      bId: pair[1],
    };
    if (parsed.flags.has("strict")) options.strict = true;
    const minPerArm = intOf(parsed.values.get("min-per-arm"), "min-per-arm");
    if (minPerArm !== undefined) options.minPerArm = minPerArm;
    const result = compare(root, options);
    if (asJson) {
      printJson(result);
    } else {
      p(
        `compare: ${result.aId} vs ${result.bId} verdict=${result.verdict} arm=${result.armSizes.a}/${result.armSizes.b} includesFailures=${result.includesFailures.a}/${result.includesFailures.b} codes=${result.codes.join(",")}`,
      );
      if (result.signatureKeyA !== undefined) p(`  A#${result.signatureKeyA}`);
      if (result.signatureKeyB !== undefined) p(`  B#${result.signatureKeyB}`);
      for (const delta of result.deltas) {
        p(`  ${delta.metric}: a=${delta.a} b=${delta.b} delta=${delta.delta} withinTolerance=${delta.withinTolerance}`);
      }
    }
    return result.verdict === "comparable" ? EXIT_OK : EXIT_INCOMPARABLE;
  }

  if (command === "counterfactuals") {
    const options: { minPerArm?: number } = {};
    const minPerArm = intOf(parsed.values.get("min-per-arm"), "min-per-arm");
    if (minPerArm !== undefined) options.minPerArm = minPerArm;
    const result = counterfactuals(root, options);
    if (asJson) {
      printJson(result);
    } else {
      p(
        `counterfactuals: 配对=${result.result.pairs.length} 候选=${result.result.candidates.length} codes=${result.result.codes.join(",")}`,
      );
      for (const pair of result.result.pairs) {
        p(
          `  ${pair.signatureKey} ${pair.metric}: ${pair.decisionA}=${pair.meanA}(${pair.sampleA}) ${pair.decisionB}=${pair.meanB}(${pair.sampleB}) delta=${pair.delta} codes=${pair.codes.join(",")}`,
        );
      }
      for (const candidate of result.result.candidates) {
        p(
          `  ${candidate.signatureKey} ${candidate.decisionA}/${candidate.decisionB}: insufficient — ${candidate.reason}`,
        );
      }
    }
    const insufficient = result.result.pairs.length === 0 && result.result.candidates.length > 0;
    return insufficient ? EXIT_INCOMPARABLE : EXIT_OK;
  }

  if (command === "version-change") {
    const modelVersion = parsed.values.get("model");
    const providerVersion = parsed.values.get("provider");
    if (modelVersion === undefined || providerVersion === undefined) {
      throw new Error("--version-change 需要 --model <v> 与 --provider <v>");
    }
    const experiments = await readExperiments(parsed.values.get("experiments"));
    const options: { modelVersion: string; providerVersion: string; experiments?: never } = {
      modelVersion,
      providerVersion,
    };
    if (experiments !== undefined) options.experiments = experiments as never;
    const result = versionChange(root, options);
    if (asJson) {
      printJson(result);
    } else {
      const prev = result.prev === undefined ? "-" : `${result.prev.modelVersion}/${result.prev.providerVersion}`;
      p(
        `version-change: ${prev} -> ${modelVersion}/${providerVersion} changed=${result.result.changed} appended=version:${result.appended.version},baseline:${result.appended.baseline} codes=${result.codes.join(",")}`,
      );
      p(`  stale=${JSON.stringify(result.result.staleExperimentIds)}`);
    }
 // 版本变化是事实而不是错误:恒 0(版本已变也要能进 CI 打印 stale 清单)。
    return result.ok ? EXIT_OK : EXIT_USAGE;
  }

  if (command === "mark-stale") {
    const experiments = await readExperiments(parsed.values.get("experiments"));
    const options: { modelVersion?: string; providerVersion?: string; experiments?: never } = {};
    const modelVersion = parsed.values.get("model");
    const providerVersion = parsed.values.get("provider");
    if (modelVersion !== undefined) options.modelVersion = modelVersion;
    if (providerVersion !== undefined) options.providerVersion = providerVersion;
    if (experiments !== undefined) options.experiments = experiments as never;
    const result = markStale(root, options);
    if (asJson) printJson(result);
    else p(`mark-stale: stale=${JSON.stringify(result.stale)} active=${JSON.stringify(result.active)}`);
    return EXIT_OK;
  }

  if (command === "confounders") {
    const result = confounders(root);
    if (asJson) {
      printJson(result);
      return EXIT_OK;
    }
    p(`confounders: 坏行=${result.parseErrors} codes=${result.codes.join(",") || "-"}`);
    for (const item of result.result.items) {
      p(`  ${item.factor}: present=${item.present} ${item.detail}`);
    }
    return EXIT_OK;
  }

  if (command === "survivor-bias") {
    const result = survivorBias(root);
    if (asJson) {
      printJson(result);
      return EXIT_OK;
    }
    if (result.result.biased) {
      p(`告警 SURVIVOR_BIAS: 对照集全为 done(没有 failed/interrupted 样本),excludedCount=${result.result.excludedCount}`);
    }
    p(
      `survivor-bias: biased=${result.result.biased} excludedCount=${result.result.excludedCount} codes=${result.codes.join(",") || "-"}`,
    );
    return EXIT_OK;
  }

 // report
  const report = reportSignatures(root);
  if (asJson) {
    printJson(report);
    return EXIT_OK;
  }
  p(
    `report: 行=${report.totalLines} 坏行=${report.parseErrors} 样本=${report.samples} 桶=${report.buckets.length} codes=${report.codes.join(",") || "-"}`,
  );
  for (const bucket of report.buckets) {
    p(
      `  ${bucket.signatureKey} D=${bucket.counts.done} F=${bucket.counts.failed} I=${bucket.counts.interrupted} C=${bucket.counts.cancelled} mean=${bucket.mean} decisions=${bucket.decisions.join(",") || "-"}`,
    );
  }
  const versionRows = report.versions as Record<
    string,
    { providerVersions: string[]; mean: number; count: number }
  >;
  for (const [model, version] of Object.entries(versionRows)) {
    p(`  version ${model}: providers=${version.providerVersions.join(",")} mean=${version.mean} count=${version.count}`);
  }
  for (const item of report.confounders.items) {
    if (item.present) p(`  告警 ${item.factor}:${item.detail}`);
  }
  if (report.survivorBias.biased) p("  告警 SURVIVOR_BIAS:对照集全为 done");
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
