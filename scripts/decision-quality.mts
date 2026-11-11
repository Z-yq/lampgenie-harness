#!/usr/bin/env -S node --experimental-strip-types
/**
 * 决策质量 CLI(决策质量 2026-11):record / aggregate / patterns / promote / library / counterfactual / correct / report。
 * 纯表面层:判定与聚类在 packages/harness-runtime/src/agent/decision-quality.ts(纯逻辑),
 * 落盘与投影在 apps/gateway/src/decision-quality-store.ts
 * (`<root>/.genie/rsi/decisions.jsonl` + `<root>/.genie/rsi/patterns.jsonl`,均 append-only)。
 * 本文件只做 argv 解析、JSON 读入与退出码映射。
 * 用法:node --experimental-strip-types scripts/decision-quality.mts --root <dir> <子命令> [--json]
 * --record <file|-> 记一条决策(JSON:对象 / {decision:...} / 数组取首项)
 * --aggregate 聚合全部决策 → 候选模式快照
 * --patterns [--kind k] [--level L0..L3] [--status s] [--json] 列模式(折叠后的最新状态)
 * --promote <patternId> [--cross-entity n] [--replay] [--transfer] 升一级
 * --library <patternId> 入知识库
 * --counterfactual <decisionId> 找更优对照
 * --correct <decisionId> --by <who> --note <text> [--avoidability <k>] 人工纠正(追加覆盖行)
 * --report [--json] 汇总报表
 * --help 本帮助
 * 退出码:0 成功;1 参数错误(缺参数 / 非法 JSON / 未知子命令 / 非法取值);
 * 2 不可升阶 / 证据缺失 / 无对照;3 pattern 或 decision 不存在。
 * 落盘位置:`<root>/.genie/rsi/*.jsonl`(真实运行请只给 /tmp 下的 root)。
 */
import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  addToLibrary,
  aggregate,
  counterfactual,
  humanCorrect,
  listPatterns,
  promote,
  record,
  reportDecisions,
} from "../apps/gateway/src/decision-quality-store.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_BLOCKED = 2;
const EXIT_MISSING = 3;

const VALUE_FLAGS = new Set([
  "root",
  "record",
  "kind",
  "level",
  "status",
  "promote",
  "cross-entity",
  "library",
  "counterfactual",
  "correct",
  "by",
  "note",
  "avoidability",
]);

const BOOL_FLAGS = new Set([
  "aggregate",
  "patterns",
  "report",
  "replay",
  "transfer",
  "json",
  "help",
]);

const KINDS = new Set(["anti-pattern", "efficient-pattern"]);
const LEVELS = new Set(["L0", "L1", "L2", "L3"]);
const STATUSES = new Set(["candidate", "library", "observation"]);
const AVOIDABILITIES = new Set(["decision-error", "environment-noise", "requirement-change", "unknown"]);

const COMMANDS = [
  "record",
  "aggregate",
  "patterns",
  "promote",
  "library",
  "counterfactual",
  "correct",
  "report",
] as const;

type Command = (typeof COMMANDS)[number];

interface Parsed {
  values: Map<string, string>;
  flags: Set<string>;
}

const HELP = [
  "决策质量 CLI:用 --root 指定台账根目录(<root>/.genie/rsi/decisions.jsonl + patterns.jsonl)",
  "",
  "用法:node --experimental-strip-types scripts/decision-quality.mts --root <dir> <子命令> [--json]",
  "",
  "子命令:",
  "  --record <file|->                         记一条决策(sessionId/type/choice/outcome/evidenceRefs/cost/context 必填)",
  "  --aggregate                               聚合全部决策 → 候选模式(落 patterns.jsonl)",
  "  --patterns [--kind k] [--level L0..L3] [--status s] [--json]  列模式",
  "  --promote <patternId> [--cross-entity n] [--replay] [--transfer]  升一级(L0→L1→L2→L3)",
  "  --library <patternId>                     入知识库(需 level≠L0 且 confidence≥0.6)",
  "  --counterfactual <decisionId>             找同上下文更优的对照",
  "  --correct <decisionId> --by <who> --note <text> [--avoidability <k>]  人工纠正(追加覆盖行)",
  "  --report [--json]                         汇总报表(byType/byOutcome/byAvoidability/levels)",
  "  --help                                    本帮助",
  "",
  "输入:路径或 - 表示 stdin;JSON 可为单对象 / {decision:...} / 数组(取第一项)。",
  "退出码:0 成功 / 1 参数错误 / 2 不可升阶·证据缺失·无对照 / 3 pattern 或 decision 不存在。",
].join("\n");

/** argv → 值表 + 布尔标记(不认识的 flag 也算参数错误)。 */
function parseArgs(argv: string[]): Parsed {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (raw === undefined || !raw.startsWith("--")) throw new Error(`无法识别的参数:${raw ?? ""}`);
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

/** 读 stdin(用于 `-`)。 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

/** 读 JSON 输入:路径或 `-`(stdin)。 */
async function readJson(spec: string, label: string): Promise<unknown> {
  const text = spec === "-" ? await readStdin() : await readFile(spec, "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON:${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 从 `{decision:...}` / 数组取首项 / 裸对象里取出实体。 */
function unwrap(payload: unknown, key: "decision"): Record<string, unknown> {
  if (Array.isArray(payload)) {
    if (payload.length === 0) throw new Error("输入数组为空");
    return unwrap(payload[0], key);
  }
  if (typeof payload !== "object" || payload === null) throw new Error("输入必须是 JSON 对象");
  const recordValue = payload as Record<string, unknown>;
  const wrapped = recordValue[key];
  if (Object.keys(recordValue).length === 1 && typeof wrapped === "object" && wrapped !== null) {
    return wrapped as Record<string, unknown>;
  }
  return recordValue;
}

/** 找出唯一子命令;零个/多个都算参数错误。 */
function commandOf(parsed: Parsed): Command {
  const present = COMMANDS.filter((name) => parsed.flags.has(name) || parsed.values.has(name));
  if (present.length === 0) throw new Error("缺少子命令(用 --help 看用法)");
  if (present.length > 1) throw new Error(`一次只能跑一个子命令:${present.join(", ")}`);
  return present[0] as Command;
}

function requireValue(parsed: Parsed, name: string): string {
  const value = parsed.values.get(name);
  if (value === undefined || value.trim() === "") throw new Error(`缺少 --${name}`);
  return value;
}

function enumValue(parsed: Parsed, name: string, allowed: Set<string>): string | undefined {
  if (!parsed.values.has(name)) return undefined;
  const value = requireValue(parsed, name);
  if (!allowed.has(value)) throw new Error(`非法 --${name}:${value}(可选 ${[...allowed].join("/")})`);
  return value;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** 一条模式的人类可读摘要:id/level/status/conf/freq/kind/name。 */
function describePattern(pattern: {
  id: string;
  level: string;
  status: string;
  confidence: number;
  frequency: number;
  kind: string;
  name: string;
}): string {
  return `- ${pattern.id} ${pattern.level}/${pattern.status} conf=${pattern.confidence} freq=${pattern.frequency} ${pattern.kind} ${pattern.name}`;
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

  if (command === "record") {
    const payload = await readJson(requireValue(parsed, "record"), "--record");
    const decision = unwrap(payload, "decision");
    const result = record(root, decision);
    if (asJson) printJson(result);
    if (result.record === undefined) {
      process.stderr.write(`未落盘:${result.codes.join(",")}\n`);
      return result.codes.includes("DQ_EVIDENCE_REQUIRED") ? EXIT_BLOCKED : EXIT_USAGE;
    }
    if (!asJson) {
      process.stdout.write(
        `已记录 ${result.record.id} type=${result.record.type} outcome=${result.record.outcome} ` +
          `avoidability=${result.record.avoidability}\n`,
      );
    }
    return EXIT_OK;
  }

  if (command === "aggregate") {
    const result = aggregate(root);
    if (asJson) printJson(result);
    else {
      process.stdout.write(
        `聚合完成:候选 ${result.patterns.length} 条(决策行 ${result.totalLines},坏行 ${result.badLines})\n`,
      );
      for (const pattern of result.patterns) process.stdout.write(`${describePattern(pattern)}\n`);
    }
    return EXIT_OK;
  }

  if (command === "patterns") {
    const opts: { kind?: string; level?: string; status?: string } = {};
    const kind = enumValue(parsed, "kind", KINDS);
    const level = enumValue(parsed, "level", LEVELS);
    const status = enumValue(parsed, "status", STATUSES);
    if (kind !== undefined) opts.kind = kind;
    if (level !== undefined) opts.level = level;
    if (status !== undefined) opts.status = status;
    const result = listPatterns(root, opts);
    if (asJson) {
      printJson(result);
      return EXIT_OK;
    }
    process.stdout.write(`模式 ${result.patterns.length} 条(总行 ${result.totalLines},坏行 ${result.badLines})\n`);
    for (const pattern of result.patterns) process.stdout.write(`${describePattern(pattern)}\n`);
    return EXIT_OK;
  }

  if (command === "promote") {
    const id = requireValue(parsed, "promote");
    const evidence: { minCrossEntity?: number; replayValidated?: boolean; transferTested?: boolean } = {};
    if (parsed.values.has("cross-entity")) {
      const raw = requireValue(parsed, "cross-entity");
      const parsedNumber = Number(raw);
      if (!Number.isInteger(parsedNumber) || parsedNumber < 0) throw new Error(`非法 --cross-entity:${raw}`);
      evidence.minCrossEntity = parsedNumber;
    }
    if (parsed.flags.has("replay")) evidence.replayValidated = true;
    if (parsed.flags.has("transfer")) evidence.transferTested = true;
    const result = promote(root, id, evidence);
    if (asJson) printJson(result);
    if (result.codes.includes("DQ_PATTERN_NOT_FOUND")) {
      process.stderr.write(`模式不存在:${id}\n`);
      return EXIT_MISSING;
    }
    if (!result.codes.includes("DQ_PATTERN_PROMOTED")) {
      process.stderr.write(`未升阶:${result.codes.join(",")} ${result.reason ?? ""}\n`.trimEnd() + "\n");
      return EXIT_BLOCKED;
    }
    if (!asJson && result.pattern !== undefined) {
      process.stdout.write(`已升阶 ${describePattern(result.pattern)}\n`);
    }
    return EXIT_OK;
  }

  if (command === "library") {
    const id = requireValue(parsed, "library");
    const result = addToLibrary(root, id);
    if (asJson) printJson(result);
    if (result.codes.includes("DQ_PATTERN_NOT_FOUND")) {
      process.stderr.write(`模式不存在:${id}\n`);
      return EXIT_MISSING;
    }
    if (!result.codes.includes("DQ_LIBRARY_ADDED")) {
      process.stderr.write(`未入库:${result.codes.join(",")} ${result.reason ?? ""}\n`.trimEnd() + "\n");
      return EXIT_BLOCKED;
    }
    if (!asJson && result.pattern !== undefined) {
      process.stdout.write(`已入库 ${describePattern(result.pattern)}\n`);
    }
    return EXIT_OK;
  }

  if (command === "counterfactual") {
    const id = requireValue(parsed, "counterfactual");
    const result = counterfactual(root, id);
    if (asJson) printJson(result);
    if (result.codes.includes("DQ_DECISION_NOT_FOUND")) {
      process.stderr.write(`决策不存在:${id}\n`);
      return EXIT_MISSING;
    }
    if (result.match === undefined) {
      process.stderr.write(`无对照:${result.codes.join(",")}\n`);
      return EXIT_BLOCKED;
    }
    if (!asJson) {
      const match = result.match;
      process.stdout.write(
        `对照 ${match.decisionId} choice=${match.choice} outcome=${match.outcome} ` +
          `cost=${match.cost.tokens}/${match.cost.wallMs}/${match.cost.toolCalls}\n`,
      );
    }
    return EXIT_OK;
  }

  if (command === "correct") {
    const id = requireValue(parsed, "correct");
    const by = requireValue(parsed, "by");
    const note = requireValue(parsed, "note");
    const avoidability = enumValue(parsed, "avoidability", AVOIDABILITIES);
    const opts: { by: string; note: string; avoidability?: string } = { by, note };
    if (avoidability !== undefined) opts.avoidability = avoidability;
    const result = humanCorrect(root, id, opts);
    if (asJson) printJson(result);
    if (result.codes.includes("DQ_DECISION_NOT_FOUND")) {
      process.stderr.write(`决策不存在:${id}\n`);
      return EXIT_MISSING;
    }
    if (result.record === undefined || result.codes.includes("DQ_STORE_INVALID_INPUT")) {
      process.stderr.write(`纠正失败:${result.codes.join(",")}\n`);
      return EXIT_USAGE;
    }
    if (!asJson) {
      process.stdout.write(`已纠正 ${id} avoidability=${result.record.avoidability}\n`);
    }
    return EXIT_OK;
  }

  const report = reportDecisions(root);
  if (asJson) {
    printJson(report);
    return EXIT_OK;
  }
  process.stdout.write(
    `决策 ${report.total} 条(坏行 ${report.badLines},观察 ${report.observations.length})\n`,
  );
  process.stdout.write(`byType: ${JSON.stringify(report.byType)}\n`);
  process.stdout.write(`byOutcome: ${JSON.stringify(report.byOutcome)}\n`);
  process.stdout.write(`byAvoidability: ${JSON.stringify(report.byAvoidability)}\n`);
  process.stdout.write(`patterns: ${JSON.stringify(report.patterns)}\n`);
  process.stdout.write(`levels: ${JSON.stringify(report.levels)}\n`);
  return EXIT_OK;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = EXIT_USAGE;
}
