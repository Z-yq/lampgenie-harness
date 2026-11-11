#!/usr/bin/env -S node --experimental-strip-types
/**
 * Tips 组合预算 CLI(RSI #204):add-rule / rules / resolve / usage / reset / report。
 * 纯表面层:选择判定在 packages/harness-runtime/src/agent/tips-budget.ts(纯逻辑),
 * 落盘与重放在 apps/gateway/src/tips-budget-store.ts
 * (`<root>/.genie/rsi/tips.jsonl`,append-only)。本文件只做 argv 解析、JSON 读入与退出码映射。
 * 用法:node --experimental-strip-types scripts/tips-budget.mts --root <dir> <子命令> [--json]
 * --add-rule <file|-> 加规则(JSON 单对象或数组)
 * --rules [--key k] [--json] 列规则(同 id 后写为准)
 * --resolve <candidates.json|-> [--node n] [--max-per-node n] [--max-words-node n]
 * [--max-global n] [--max-words-global n]
 * 选一次 tips(候选可纯数组 / {candidates:[...]} / 字符串数组)
 * --usage 当前窗口用量
 * --reset 清零预算窗口(追加 reset 行)
 * --report [--json] 报表
 * --help 本帮助
 * 退出码:0 成功;1 参数错误(缺参数 / 非法 JSON / 未知子命令 / 非法取值);
 * 2 全部被丢弃或预算耗尽(selected 为空);3 规则集为空而候选非空(不存在)。
 * 落盘位置:`<root>/.genie/rsi/tips.jsonl`(真实运行请只给 /tmp 下的 root)。
 */
import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  addRule,
  listRules,
  reportTips,
  resetUsage,
  resolve as resolveStore,
  tipsPath,
  usage as usageOf,
} from "../apps/gateway/src/tips-budget-store.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_EMPTY = 2;
const EXIT_MISSING = 3;

const VALUE_FLAGS = new Set([
  "root",
  "add-rule",
  "key",
  "resolve",
  "node",
  "max-per-node",
  "max-words-node",
  "max-global",
  "max-words-global",
]);

const BOOL_FLAGS = new Set(["rules", "usage", "reset", "report", "json", "help"]);

const COMMANDS = ["add-rule", "rules", "resolve", "usage", "reset", "report"] as const;

type Command = (typeof COMMANDS)[number];

const HELP = [
  "Tips 组合预算 CLI:用 --root 指定台账根目录(<root>/.genie/rsi/tips.jsonl)",
  "",
  "用法:node --experimental-strip-types scripts/tips-budget.mts --root <dir> <子命令> [--json]",
  "",
  "子命令:",
  "  --add-rule <file|->                       加规则(JSON 单对象或数组;id/key/text/version/priority/maxWords 必填)",
  "  --rules [--key k] [--json]                列规则",
  "  --resolve <file|-> [--node n] [--max-per-node n] [--max-words-node n]",
  "                     [--max-global n] [--max-words-global n]   选一次 tips(候选:纯数组 / {candidates:[...]} / 字符串数组)",
  "  --usage                                   当前窗口用量",
  "  --reset                                   清零预算窗口",
  "  --report [--json]                         报表(rules/byCategory/byPriority/dropsByReason/compressed/resolves)",
  "  --help                                    本帮助",
  "",
  "输入:路径或 - 表示 stdin。",
  "退出码:0 成功 / 1 参数错误 / 2 全部被丢弃或预算耗尽 / 3 规则集为空而候选非空。",
].join("\n");

interface Parsed {
  values: Map<string, string>;
  flags: Set<string>;
}

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

/** 唯一子命令;零个/多个都算参数错误。 */
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

/** 取正整数 flag(缺省 undefined)。 */
function intFlag(parsed: Parsed, name: string): number | undefined {
  if (!parsed.values.has(name)) return undefined;
  const raw = requireValue(parsed, name);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name} 必须是正整数:${raw}`);
  return value;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** 候选归一:纯数组 / {candidates:[...]} / 字符串数组;nodeId 缺省用 --node。 */
function candidatesOf(payload: unknown, nodeId: string | undefined): Array<Record<string, unknown>> {
  const list = Array.isArray(payload)
    ? payload
    : typeof payload === "object" && payload !== null && Array.isArray((payload as Record<string, unknown>)["candidates"])
      ? ((payload as Record<string, unknown>)["candidates"] as unknown[])
      : undefined;
  if (list === undefined) throw new Error("--resolve 输入必须是数组或 {candidates:[...]}");
  const out: Array<Record<string, unknown>> = [];
  for (const item of list) {
    if (typeof item === "string") {
      out.push(nodeId === undefined ? { ruleId: item } : { ruleId: item, nodeId });
      continue;
    }
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("候选必须是字符串或对象");
    }
    const entry = { ...(item as Record<string, unknown>) };
    if (entry["nodeId"] === undefined && nodeId !== undefined) entry["nodeId"] = nodeId;
    if (entry["at"] === undefined) entry["at"] = Date.now();
    out.push(entry);
  }
  return out;
}

/** `--add-rule` 载荷归一:单对象 / 数组 / {rule:...} / {rules:[...]}。 */
function rulesOf(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (typeof payload === "object" && payload !== null) {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record["rules"])) return record["rules"] as unknown[];
    if (typeof record["rule"] === "object" && record["rule"] !== null) return [record["rule"]];
    return [payload];
  }
  throw new Error("--add-rule 输入必须是 JSON 对象或数组");
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

  if (command === "add-rule") {
    const payload = await readJson(requireValue(parsed, "add-rule"), "--add-rule");
    const rules = rulesOf(payload);
    const results = rules.map((rule) => addRule(root, rule));
    if (asJson) printJson({ path: tipsPath(root), results });
    let failed = false;
    for (const result of results) {
      if (result.ok) {
        if (!asJson) process.stdout.write(`已加规则 ${result.rule?.id ?? "?"}\n`);
        continue;
      }
      failed = true;
      process.stderr.write(`拒收:${result.codes.join(",")}\n`);
    }
    return failed ? EXIT_USAGE : EXIT_OK;
  }

  if (command === "rules") {
    const key = parsed.values.get("key");
    const rules = listRules(root, key === undefined ? {} : { key });
    if (asJson) printJson(rules);
    else {
      process.stdout.write(`规则 ${rules.length} 条(${tipsPath(root)})\n`);
      for (const rule of rules) {
        process.stdout.write(
          `- ${rule.id} key=${rule.key} ${rule.category} P${rule.priority} v=${rule.version} maxWords=${rule.maxWords}\n`,
        );
      }
    }
    return EXIT_OK;
  }

  if (command === "resolve") {
    const payload = await readJson(requireValue(parsed, "resolve"), "--resolve");
    const nodeId = parsed.values.get("node");
    const candidates = candidatesOf(payload, nodeId);
    const budget = {
      maxTipsPerNode: intFlag(parsed, "max-per-node"),
      maxWordsPerNode: intFlag(parsed, "max-words-node"),
      maxTipsGlobal: intFlag(parsed, "max-global"),
      maxWordsGlobal: intFlag(parsed, "max-words-global"),
    };
    if (listRules(root).length === 0 && candidates.length > 0) {
      if (asJson) printJson({ codes: ["TIPS_STORE_INVALID_INPUT"], selected: [], dropped: [], reason: "no-rules" });
      else process.stderr.write(`规则集为空(${tipsPath(root)}),先用 --add-rule 加规则\n`);
      return EXIT_MISSING;
    }
    const result = resolveStore(root, candidates, { nodeId, budget, now: Date.now() });
    const invalidInput = result.codes.includes("TIPS_STORE_INVALID_INPUT");
    if (asJson) printJson(result);
    else if (invalidInput) {
      process.stderr.write(
        "拒收:TIPS_STORE_INVALID_INPUT —— 候选自带 nodeId 不一致且未给 --node(整批必须同一节点)\n",
      );
    } else {
      for (const entry of result.selected) {
        process.stdout.write(`TIPS_SELECTED= ${entry.rule.id}${entry.compressed ? " compressed" : ""}\n`);
      }
      for (const entry of result.dropped) {
        process.stdout.write(`${entry.code}= ${entry.ruleId} ${entry.reason}\n`);
      }
      process.stdout.write(
        `选中 ${result.selected.length} 条 / 丢弃 ${result.dropped.length} 条 ` +
          `node=${result.nodeId} usage=${JSON.stringify(result.usageAfter)}\n`,
      );
    }
    return result.selected.length === 0 ? EXIT_EMPTY : EXIT_OK;
  }

  if (command === "usage") {
    const used = usageOf(root);
    if (asJson) printJson(used);
    else {
      process.stdout.write(
        `global: tips=${used.globalTips} words=${used.globalWords}\n` +
          `byNode: ${JSON.stringify(used.nodeTips)}\nbyNodeWords: ${JSON.stringify(used.nodeWords)}\n`,
      );
    }
    return EXIT_OK;
  }

  if (command === "reset") {
    const result = resetUsage(root, { now: Date.now() });
    if (asJson) printJson(result);
    else process.stdout.write(`预算窗口已清零(${result.codes.join(",")})\n`);
    return result.ok ? EXIT_OK : EXIT_USAGE;
  }

  const report = reportTips(root);
  if (asJson) printJson(report);
  else {
    process.stdout.write(
      `规则 ${report.rules} 条,选择 ${report.resolves} 次,压缩 ${report.compressed} 条,坏行 ${report.badLines}\n` +
        `byCategory: ${JSON.stringify(report.byCategory)}\n` +
        `byPriority: ${JSON.stringify(report.byPriority)}\n` +
        `dropsByReason: ${JSON.stringify(report.dropsByReason)}\n`,
    );
  }
  return EXIT_OK;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT_USAGE;
  },
);
