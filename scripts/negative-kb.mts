#!/usr/bin/env -S node --experimental-strip-types
/**
 * 负面知识库 CLI(RSI #215):record / lookup / inject / revive / expire / list / suggest / report。
 *
 * 纯表面层:召回/注入/翻案/过期判定在 packages/harness-runtime/src/agent/negative-knowledge.ts(纯逻辑),
 * 落盘与投影在 apps/gateway/src/negative-kb-store.ts(`<root>/.genie/rsi/negkb.jsonl`,append-only)。
 * 本文件只做 argv 解析、JSON 读入与退出码映射。
 *
 * 用法:node --experimental-strip-types scripts/negative-kb.mts --root <dir> <子命令> [--json]
 *   --record <file|->                                  记一条死路(JSON:对象 / {record:...} / 数组取首项)
 *   --lookup <file|-> [--json]                          召回死路(JSON:{planText,module,taskClass,keywords})
 *   --inject <file|-> [--json]                          规划期注入块(超预算即停)
 *   --revive <id> --by <who> --reason <text> [--new-evidence <text>]  翻案
 *   --expire                                            过期扫描(expiresAt <= now 的置 expired)
 *   --list [--status active|revived|expired] [--json]    列死路
 *   --suggest <sessions.json> [--json]                   从放弃会话推断候选死路并落盘
 *   --report [--json]                                   汇总报表
 *   --help                                             本帮助
 *
 * 退出码:0 成功(含 lookup/inject 无命中——空结果不是失败);1 参数错误(缺参数 / 未知 flag / 非法 JSON);
 *         3 重复记账(NEGKB_DUPLICATE)。
 * 落盘位置:`<root>/.genie/rsi/negkb.jsonl`(真实运行请只给 /tmp 下的 root)。
 */
import { readFile } from "node:fs/promises";
import process from "node:process";

import type {
  AbandonSession,
  DeadEndRecord,
  RecordDeadEndInput,
  RetrieveQuery,
} from "@lampgenie/runtime/agent/negative-knowledge";
import {
  expire,
  inject,
  listDeadEnds,
  negativeKbPath,
  recordDeadEnd,
  reportNegative,
  retrieve,
  revive,
  suggest,
} from "../apps/gateway/src/negative-kb-store.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_DUPLICATE = 3;

const VALUE_FLAGS = new Set([
  "root",
  "record",
  "lookup",
  "inject",
  "revive",
  "by",
  "reason",
  "new-evidence",
  "status",
  "suggest",
]);

const BOOL_FLAGS = new Set(["json", "expire", "list", "report", "help"]);

const COMMANDS = ["record", "lookup", "inject", "revive", "expire", "list", "suggest", "report", "help"] as const;

type Command = (typeof COMMANDS)[number];

const STATUSES = new Set(["active", "revived", "expired"]);

interface Parsed {
  values: Map<string, string>;
  flags: Set<string>;
}

const HELP = [
  "负面知识库 CLI(死路账本):用 --root 指定台账根目录(<root>/.genie/rsi/negkb.jsonl)",
  "",
  "用法:node --experimental-strip-types scripts/negative-kb.mts --root <dir> <子命令> [--json]",
  "",
  "子命令:",
  "  --record <file|->                                 记死路(plan + failureEvidence 必填)",
  "  --lookup <file|-> [--json]                         召回(命中项带 score/reasons/alternative)",
  "  --inject <file|-> [--json]                         规划期注入块(此路不通|原因|替代)",
  "  --revive <id> --by <who> --reason <text> [--new-evidence <text>]  翻案",
  "  --expire                                          过期扫描",
  "  --list [--status active|revived|expired] [--json]   列死路(createdAt 升序)",
  "  --suggest <sessions.json> [--json]                 从放弃会话推断候选并落盘",
  "  --report [--json]                                 汇总报表(active/revived/expired/hits/坏行)",
  "  --help                                            本帮助",
  "",
  "输入:路径或 - 表示 stdin;JSON 可为单对象 / {record:...} / 数组(取第一项)。",
  "退出码:0 成功(lookup/inject 无命中仍为 0) / 1 参数错误 / 3 重复记账。",
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

/** 从 `{record:...}` / 数组取首项 / 裸对象里取出实体。 */
function unwrap(payload: unknown, key: "record"): Record<string, unknown> {
  if (Array.isArray(payload)) {
    if (payload.length === 0) throw new Error("输入数组为空");
    return unwrap(payload[0], key);
  }
  if (typeof payload !== "object" || payload === null) throw new Error("输入必须是 JSON 对象");
  const record = payload as Record<string, unknown>;
  const wrapped = record[key];
  if (Object.keys(record).length === 1 && typeof wrapped === "object" && wrapped !== null) {
    return wrapped as Record<string, unknown>;
  }
  return record;
}

/** 找出唯一子命令;零个/多个都算参数错误。 */
function commandOf(parsed: Parsed): Command {
  if (parsed.flags.has("help")) return "help";
  const found = COMMANDS.filter((cmd) => cmd !== "help" && (parsed.values.has(cmd) || parsed.flags.has(cmd)));
  if (found.length === 0) throw new Error("缺少子命令(见 --help)");
  if (found.length > 1) throw new Error(`一次只能用一个子命令,收到:${found.join(",")}`);
  return found[0];
}

function requireValue(parsed: Parsed, name: string): string {
  const value = parsed.values.get(name);
  if (value === undefined || value.trim() === "") throw new Error(`缺少 --${name}`);
  return value;
}

function truncate(text: string, max = 60): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function describe(record: DeadEndRecord): string {
  return `${record.id} ${record.status} conf=${record.confidence} plan=${truncate(record.plan)}`;
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const command = commandOf(parsed);

  if (command === "help") {
    process.stdout.write(`${HELP}\n`);
    return EXIT_OK;
  }

  const root = requireValue(parsed, "root");
  const json = parsed.flags.has("json");

  if (command === "record") {
    const spec = requireValue(parsed, "record");
    const payload = unwrap(await readJson(spec, "--record"), "record");
    const result = recordDeadEnd(root, payload as unknown as RecordDeadEndInput);
    if (!result.ok) {
      if (result.codes.includes("NEGKB_DUPLICATE")) {
        process.stdout.write(`重复记账(未重复写盘):${describe(result.record as DeadEndRecord)}\n`);
        return EXIT_DUPLICATE;
      }
      process.stdout.write(`记账失败:${result.codes.join(",")}\n`);
      return EXIT_USAGE;
    }
    const record = result.record as DeadEndRecord;
    if (json) printJson(record);
    else process.stdout.write(`已记账:${describe(record)}\n`);
    return EXIT_OK;
  }

  if (command === "lookup") {
    const spec = requireValue(parsed, "lookup");
    const query = unwrap(await readJson(spec, "--lookup"), "record") as unknown as RetrieveQuery;
    const result = retrieve(root, query);
    if (json) {
      printJson(result);
      return EXIT_OK;
    }
    if (result.hits.length === 0) {
      process.stdout.write(`无命中(${result.codes.join(",")})\n`);
      return EXIT_OK;
    }
    for (const hit of result.hits) {
      const alt = hit.alternative && hit.alternative.trim() !== "" ? hit.alternative : "暂无";
      process.stdout.write(
        `[${hit.score}] ${hit.record.id}  ${truncate(hit.record.plan)} —— 原因:${hit.reasons.join(",")} | 替代:${alt}\n`,
      );
    }
    return EXIT_OK;
  }

  if (command === "inject") {
    const spec = requireValue(parsed, "inject");
    const query = unwrap(await readJson(spec, "--inject"), "record") as unknown as RetrieveQuery;
    const result = inject(root, query);
    if (json) {
      printJson(result);
      return EXIT_OK;
    }
    if (result.blocks.length === 0) {
      process.stdout.write("无死路可注入\n");
      return EXIT_OK;
    }
    for (const block of result.blocks) process.stdout.write(`${block}\n`);
    return EXIT_OK;
  }

  if (command === "revive") {
    const id = requireValue(parsed, "revive");
    const by = requireValue(parsed, "by");
    const reason = requireValue(parsed, "reason");
    const newEvidence = parsed.values.get("new-evidence");
    const result = revive(root, id, { by, reason, ...(newEvidence ? { newEvidence } : {}) });
    if (!result.ok) {
      process.stdout.write(`翻案失败:${result.codes.join(",")}\n`);
      return EXIT_USAGE;
    }
    const record = result.record as DeadEndRecord;
    if (json) printJson(record);
    else process.stdout.write(`已翻案:${describe(record)} corrections=${record.corrections.length}\n`);
    return EXIT_OK;
  }

  if (command === "expire") {
    const result = expire(root);
    if (json) {
      printJson(result);
      return EXIT_OK;
    }
    process.stdout.write(`已过期:${result.expired.length} 条${result.expired.length > 0 ? ` (${result.expired.join(",")})` : ""}\n`);
    return EXIT_OK;
  }

  if (command === "list") {
    const status = parsed.values.get("status");
    if (status !== undefined && !STATUSES.has(status)) throw new Error(`非法 --status:${status}`);
    const records = listDeadEnds(root, status ? { status: status as "active" | "revived" | "expired" } : {});
    if (json) {
      printJson(records);
      return EXIT_OK;
    }
    if (records.length === 0) process.stdout.write("账本为空\n");
    for (const record of records) process.stdout.write(`${describe(record)} corrections=${record.corrections.length}\n`);
    return EXIT_OK;
  }

  if (command === "suggest") {
    const spec = requireValue(parsed, "suggest");
    const payload = await readJson(spec, "--suggest");
    const sessions = (Array.isArray(payload)
      ? payload
      : typeof payload === "object" && payload !== null && Array.isArray((payload as { sessions?: unknown }).sessions)
        ? (payload as { sessions: unknown[] }).sessions
        : [payload]) as AbandonSession[];
    const result = suggest(root, sessions);
    if (json) {
      printJson(result);
      return EXIT_OK;
    }
    if (result.candidates.length === 0) process.stdout.write(`无新候选(${result.codes.join(",")})\n`);
    for (const candidate of result.candidates) process.stdout.write(`候选:${describe(candidate)}\n`);
    return EXIT_OK;
  }

  // report
  const report = reportNegative(root);
  if (json) {
    printJson(report);
    return EXIT_OK;
  }
  process.stdout.write(
    `账本 ${negativeKbPath(root)}\n总计:${report.total} active:${report.active} revived:${report.revived} expired:${report.expired} hits:${report.hits} 有替代:${report.withAlternative} 坏行:${report.parseErrors} 总行:${report.totalLines}\n`,
  );
  return EXIT_OK;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = EXIT_USAGE;
}
