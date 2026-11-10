#!/usr/bin/env -S node --experimental-strip-types
/**
 * 漏点预防件 CLI(漏点预防路由 2026-11):seed / route / list / apply / bump / expire / report。
 *
 * 纯表面层:分类法与路由判定在 packages/harness-runtime/src/agent/gap-taxonomy.ts(纯逻辑),
 * 落盘与投影在 apps/gateway/src/gap-taxonomy-store.ts(`<root>/.genie/rsi/gaps.jsonl`,append-only)。
 * 本文件只做 argv 解析、退出码映射与人类可读输出。
 *
 * 用法:node --experimental-strip-types scripts/gap-taxonomy.mts --root <dir> <子命令> [--json]
 *   --seed                                             种入默认分类法(幂等)
 *   --route <defectId> [--graph-root <dir>]            用 #210 台账里的缺陷做漏点路由
 *   --list [--category c] [--form f] [--injection-point p] [--json]  列预防件
 *   --apply <injectionPoint> [--module m] [--board-type t] [--task-class c]  注入到某一交付节点之前
 *   --bump <defectId>                                  按佐证缺陷调权
 *   --expire                                           过期扫描
 *   --report [--json]                                  汇总报表
 *   --help                                             本帮助
 *
 * 退出码:0 成功;1 参数错误(缺 root / 未知 flag / 非法 injectionPoint / 非法 form / 缺陷不存在);
 *         2 无可路由条目(route 无命中 / bump 无关联 / expire 无可过期);3 重复种入(GAP_SEED_DUPLICATE)。
 * 落盘位置:`<root>/.genie/rsi/gaps.jsonl`(真实运行请只给 /tmp 下的 root)。
 */
import process from "node:process";

import {
  applyAt,
  bumpForDefect,
  expire,
  listPreventions,
  reportGaps,
  routeFromDefect,
  seedTaxonomy,
} from "../apps/gateway/src/gap-taxonomy-store.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_NO_MATCH = 2;
const EXIT_DUPLICATE = 3;

// 下游提前关掉管道(`| head -n` / 分页器)时 stdout 会发 EPIPE:这是正常收尾,不该打整段未捕获栈。
// 其它 stdout 错误仍走默认(没有监听器时 node 会抛未捕获的 'error';这里重新抛出以保持同等可见性)。
process.stdout.on("error", (err) => {
  if ((err as { code?: string } | undefined)?.code === "EPIPE") {
    process.exit(EXIT_OK);
  }
  throw err;
});

const VALUE_FLAGS = new Set([
  "root",
  "route",
  "apply",
  "bump",
  "category",
  "form",
  "injection-point",
  "module",
  "board-type",
  "task-class",
  "graph-root",
]);

const BOOL_FLAGS = new Set(["seed", "list", "expire", "report", "json", "help"]);

const COMMANDS = ["seed", "route", "list", "apply", "bump", "expire", "report"] as const;

type Command = (typeof COMMANDS)[number];

interface Parsed {
  values: Map<string, string>;
  flags: Set<string>;
}

const HELP = [
  "漏点预防件 CLI:用 --root 指定台账根目录(<root>/.genie/rsi/gaps.jsonl)",
  "",
  "用法:node --experimental-strip-types scripts/gap-taxonomy.mts --root <dir> <子命令> [--json]",
  "",
  "子命令:",
  "  --seed                                        种入默认分类法(七类 × context/gate/tool,幂等)",
  "  --route <defectId> [--graph-root <dir>]       用 #210 台账缺陷的 missedLink 做路由并落行",
  "  --list [--category c] [--form f] [--injection-point p] [--json]  列预防件",
  "  --apply <injectionPoint> [--module m] [--board-type t] [--task-class c]  分组注入文本",
  "  --bump <defectId>                             佐证调权(confidence 上限 0.9)",
  "  --expire                                      过期扫描(expiresAt <= now)",
  "  --report [--json]                             汇总报表(byCategory/byForm/byInjection)",
  "  --help                                        本帮助",
  "",
  "注入点:pre-requirement / pre-plan / pre-write / pre-verify / pre-close。",
  "退出码:0 成功 / 1 参数错误 / 2 无可路由条目 / 3 重复种入。",
].join("\n");

/** argv → 值表 + 布尔标记(不认识的 flag 也算参数错误)。 */
function parseArgs(argv: string[]): Parsed {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) throw new Error(`无法识别的参数:${raw}`);
    const name = raw.slice(2);
    if (BOOL_FLAGS.has(name)) {
      flags.add(name);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new Error(`未知选项 --${name}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`--${name} 需要取值`);
    values.set(name, next);
    i += 1;
  }
  return { values, flags };
}

/** 找出唯一子命令;零个/多个都算参数错误。 */
function commandOf(parsed: Parsed): Command {
  const present = COMMANDS.filter((name) => parsed.flags.has(name) || parsed.values.has(name));
  if (present.length === 0) throw new Error("缺少子命令(用 --help 看用法)");
  if (present.length > 1) throw new Error(`一次只能跑一个子命令:${present.join(", ")}`);
  return present[0];
}

function requireValue(parsed: Parsed, name: string): string {
  const value = parsed.values.get(name);
  if (value === undefined || value.trim() === "") throw new Error(`缺少 --${name}`);
  return value;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** trigger 的人读投影:只列有值的字段。 */
function describeTrigger(trigger: {
  module?: string;
  boardType?: string;
  taskClass?: string;
  decisionNode?: string;
  textPattern?: string;
}): string {
  const parts = (["module", "boardType", "taskClass", "decisionNode", "textPattern"] as const)
    .map((field) => (trigger[field] === undefined ? undefined : `${field}=${trigger[field]}`))
    .filter((part): part is string => part !== undefined);
  return parts.length === 0 ? "*" : parts.join(",");
}

function describeEntry(entry: {
  id: string;
  form: string;
  gapCategory: string;
  carrier: string;
  injectionPoint: string;
  guidance: string;
  confidence: number;
  expiresAt?: number;
  trigger: Parameters<typeof describeTrigger>[0];
}): string {
  const expiry = entry.expiresAt === undefined ? "" : ` expiresAt=${entry.expiresAt}`;
  return (
    `- [${entry.form}] ${entry.id} category=${entry.gapCategory} 注入点=${entry.injectionPoint} ` +
    `confidence=${entry.confidence} 载体=${entry.carrier} trigger=${describeTrigger(entry.trigger)}${expiry}\n` +
    `    ${entry.guidance}`
  );
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.flags.has("help")) {
    process.stdout.write(`${HELP}\n`);
    return EXIT_OK;
  }

  const root = requireValue(parsed, "root");
  const command = commandOf(parsed);
  const asJson = parsed.flags.has("json");

  if (command === "seed") {
    const result = seedTaxonomy(root);
    if (asJson) printJson(result);
    if (!result.ok) {
      process.stderr.write(`种入失败:${result.code ?? "GAP_STORE_ERROR"}\n`);
      return EXIT_USAGE;
    }
    if (result.code === "GAP_SEED_DUPLICATE") {
      if (!asJson) process.stdout.write(`分类法已齐备:新增 0 条,台账共 ${result.total} 条\n`);
      return EXIT_DUPLICATE;
    }
    if (!asJson) process.stdout.write(`已种入 ${result.added} 条预防件,台账共 ${result.total} 条\n`);
    return EXIT_OK;
  }

  if (command === "route") {
    const defectId = requireValue(parsed, "route");
    const graphRoot = parsed.values.get("graph-root");
    const result = graphRoot === undefined ? routeFromDefect(root, defectId) : routeFromDefect(root, defectId, { graphRoot });
    if (asJson) printJson(result);
    if (!result.ok) {
      process.stderr.write(`路由失败:${result.code ?? "GAP_STORE_ERROR"}\n`);
      return result.code === "GAP_DEFECT_NOT_FOUND" ? EXIT_USAGE : EXIT_NO_MATCH;
    }
    if (!asJson) {
      process.stdout.write(
        `${result.defectId} → ${result.category ?? "?"} routed=${result.routed.length} codes=${(result.codes ?? []).join(",")}\n`,
      );
      for (const entry of result.routed) process.stdout.write(`${describeEntry(entry)}\n`);
      for (const reason of result.matchReasons ?? []) process.stdout.write(`  命中理由 ${reason}\n`);
      if (result.graph !== undefined) {
        process.stdout.write(`  证据图 projection=${result.graph.ok ? "ok" : "failed"} ids=${result.graph.ids.join(",")}\n`);
      }
    }
    if (result.routed.length === 0) return EXIT_NO_MATCH;
    return EXIT_OK;
  }

  if (command === "list") {
    const filter: {
      category?: string;
      form?: string;
      injectionPoint?: string;
      includeExpired?: boolean;
    } = {};
    if (parsed.values.has("category")) filter.category = requireValue(parsed, "category");
    if (parsed.values.has("form")) filter.form = requireValue(parsed, "form");
    if (parsed.values.has("injection-point")) filter.injectionPoint = requireValue(parsed, "injection-point");
    const result = listPreventions(root, filter);
    if (asJson) printJson(result);
    if (!result.ok) {
      process.stderr.write("筛选失败:非法 category / form / injection-point\n");
      return EXIT_USAGE;
    }
    if (!asJson) {
      process.stdout.write(`预防件 ${result.total} 条 byCategory=${JSON.stringify(result.byCategory)}\n`);
      for (const entry of result.items) process.stdout.write(`${describeEntry(entry)}\n`);
    }
    return EXIT_OK;
  }

  if (command === "apply") {
    const injectionPoint = requireValue(parsed, "apply");
    const ctx: { module?: string; boardType?: string; taskClass?: string } = {};
    if (parsed.values.has("module")) ctx.module = requireValue(parsed, "module");
    if (parsed.values.has("board-type")) ctx.boardType = requireValue(parsed, "board-type");
    if (parsed.values.has("task-class")) ctx.taskClass = requireValue(parsed, "task-class");
    const result = applyAt(root, injectionPoint, ctx);
    if (asJson) printJson(result);
    if (!result.ok) {
      process.stderr.write(`注入失败:${result.code ?? "GAP_STORE_ERROR"}(注入点须为 pre-requirement/pre-plan/pre-write/pre-verify/pre-close)\n`);
      return EXIT_USAGE;
    }
    if (!asJson) {
      process.stdout.write(
        `${injectionPoint} 注入:context=${result.counts.context} gate=${result.counts.gate} tool=${result.counts.tool}\n`,
      );
      for (const block of result.contextBlocks) process.stdout.write(`  [上下文] ${block}\n`);
      for (const gate of result.gates) process.stdout.write(`  [闸门] ${gate}\n`);
      for (const check of result.toolChecks) process.stdout.write(`  [工具检查] ${check}\n`);
    }
    return EXIT_OK;
  }

  if (command === "bump") {
    const defectId = requireValue(parsed, "bump");
    const result = bumpForDefect(root, defectId);
    if (asJson) printJson(result);
    if (!result.ok) {
      process.stderr.write(`调权失败:${result.code ?? "GAP_STORE_ERROR"}\n`);
      return result.code === "GAP_INVALID_INPUT" ? EXIT_USAGE : EXIT_NO_MATCH;
    }
    if (!asJson) {
      process.stdout.write(`${defectId} 佐证调权:${result.updated.length} 条\n`);
      for (const item of result.updated) process.stdout.write(`- ${item.id} ${item.from} → ${item.to}\n`);
    }
    return EXIT_OK;
  }

  if (command === "expire") {
    const result = expire(root);
    if (asJson) printJson(result);
    if (!result.ok) {
      process.stderr.write("过期扫描失败:GAP_STORE_ERROR\n");
      return EXIT_USAGE;
    }
    if (!asJson) {
      if (result.expired.length === 0) process.stdout.write("没有可过期的预防件\n");
      else process.stdout.write(`已过期 ${result.expired.length} 条:${result.expired.join(",")}\n`);
    }
    return result.expired.length === 0 ? EXIT_NO_MATCH : EXIT_OK;
  }

  const report = reportGaps(root);
  if (asJson) {
    printJson(report);
    return EXIT_OK;
  }
  process.stdout.write(
    `预防件 ${report.total} 条(有效 ${report.active},过期 ${report.expired},未路由 ${report.unrouted},` +
      `总行 ${report.totalLines},坏行 ${report.parseErrors})\n`,
  );
  process.stdout.write(`byCategory: ${JSON.stringify(report.byCategory)}\n`);
  process.stdout.write(`byForm: ${JSON.stringify(report.byForm)}\n`);
  process.stdout.write(`byInjection: ${JSON.stringify(report.byInjection)}\n`);
  return EXIT_OK;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = EXIT_USAGE;
}
