#!/usr/bin/env -S node --experimental-strip-types
/**
 * 缺陷血缘 CLI(缺陷血缘 2026-11):register / attribute / clarify / list / queue / to-graph / report。
 *
 * 纯表面层:归属判定在 packages/harness-runtime/src/agent/defect-lineage.ts(纯逻辑),
 * 落盘与投影在 apps/gateway/src/defect-lineage-store.ts(`<root>/.genie/rsi/defects.jsonl`,append-only)。
 * 本文件只做 argv 解析、JSON 读入与退出码映射。
 *
 * 用法:node --experimental-strip-types scripts/defect-lineage.mts --root <dir> <子命令> [--json]
 *   --register <file|->                                登记缺陷(JSON:对象 / {defect:...} / 数组取首项)
 *   --attribute <id> --source <file|->                  自动归属(JSON:{source:...} / 对象 / 数组取首项)
 *   --clarify <id> --by <who> --note <text> [--source <file>] [--missed-link <k>]  人工入链
 *   --list [--category <c>] [--unattributed] [--json]  列缺陷(状态/类别/置信/漏点)
 *   --queue                                            未归属队列(等人工澄清)
 *   --to-graph <id> [--graph-root <dir>]               投影进证据图(graphRoot 缺省 = root)
 *   --report [--json]                                  汇总报表
 *   --help                                             本帮助
 *
 * 退出码:0 成功;1 参数错误(缺参数 / 非法 JSON / 非法 missed-link);2 无法入链(attribute 未归属 或 to-graph 失败);
 *         3 重复登记(DEFECT_DUPLICATE)。
 * 落盘位置:`<root>/.genie/rsi/defects.jsonl`(真实运行请只给 /tmp 下的 root)。
 */
import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  attributeDefect,
  clarifyDefect,
  listDefects,
  projectToGraph,
  registerDefect,
  reportDefects,
  unattributedQueue,
} from "../apps/gateway/src/defect-lineage-store.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_UNATTRIBUTED = 2;
const EXIT_DUPLICATE = 3;

const VALUE_FLAGS = new Set([
  "root",
  "register",
  "attribute",
  "source",
  "clarify",
  "by",
  "note",
  "missed-link",
  "category",
  "to-graph",
  "graph-root",
]);

const BOOL_FLAGS = new Set(["json", "unattributed", "list", "queue", "report", "help"]);

const MISSED_LINKS = new Set([
  "requirement",
  "plan-coverage",
  "verification-coverage",
  "knowledge-gap",
  "tool-gap",
  "wrong-assumption",
  "impact-analysis",
  "none",
]);

const COMMANDS = ["register", "attribute", "clarify", "list", "queue", "to-graph", "report"] as const;

type Command = (typeof COMMANDS)[number];

interface Parsed {
  values: Map<string, string>;
  flags: Set<string>;
}

const HELP = [
  "缺陷血缘 CLI:用 --root 指定台账根目录(<root>/.genie/rsi/defects.jsonl)",
  "",
  "用法:node --experimental-strip-types scripts/defect-lineage.mts --root <dir> <子命令> [--json]",
  "",
  "子命令:",
  "  --register <file|->                              登记缺陷(id/fixTaskId/description/files/fixedAt 必填)",
  "  --attribute <id> --source <file|->               自动归属(投票 → 置信 → 类别 → 漏点 → 链)",
  "  --clarify <id> --by <who> --note <text>          人工判定入链[--source <file>] [--missed-link <k>]",
  "  --list [--category <c>] [--unattributed] [--json] 列缺陷(含状态/category/confidence/missedLink)",
  "  --queue                                         未归属队列(等人工澄清)",
  "  --to-graph <id> [--graph-root <dir>]             投影进证据图(缺省 graphRoot = root)",
  "  --report [--json]                               汇总报表(byCategory/byConfidence/byMissedLink)",
  "  --help                                          本帮助",
  "",
  "输入:路径或 - 表示 stdin;JSON 可为单对象 / {defect:...} / {source:...} / 数组(取第一项)。",
  "退出码:0 成功 / 1 参数错误 / 2 无法入链 / 3 重复登记。",
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

/** 从 `{defect:...}` / `{source:...}` / 数组取首项 / 裸对象里取出实体。 */
function unwrap(payload: unknown, key: "defect" | "source"): Record<string, unknown> {
  if (Array.isArray(payload)) {
    if (payload.length === 0) throw new Error(`输入数组为空`);
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

/** 一条缺陷的人类可读摘要(状态 + 类别 + 置信 + 漏点 + 是否入链)。 */
function describe(item: {
  defect: { id: string; fixTaskId: string; category: string; confidence: string; missedLink?: string; files: string[]; module?: string };
  status: string;
  lineage?: { unattributed: boolean; chain: unknown[]; confidence?: string };
}): string {
  const defect = item.defect;
  const linked = item.status === "attributed" || item.status === "clarified";
  const confidence = item.lineage?.confidence ?? defect.confidence;
  const chainLength = item.lineage?.chain.length ?? 0;
  const parts = [
    `${defect.id} [${item.status}]`,
    `category=${defect.category}`,
    `confidence=${confidence}`,
    `missedLink=${defect.missedLink ?? "none"}`,
    `files=${defect.files.length}`,
    linked ? `已入链(chain=${chainLength})` : "未入链",
    `fixTask=${defect.fixTaskId}`,
  ];
  if (defect.module !== undefined) parts.push(`module=${defect.module}`);
  return `- ${parts.join(" ")}`;
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

  if (command === "register") {
    const payload = await readJson(requireValue(parsed, "register"), "--register");
    const defect = unwrap(payload, "defect");
    const result = registerDefect(root, defect as never);
    if (result.ok) {
      if (asJson) printJson(result);
      else process.stdout.write(`已登记 ${result.id}\n`);
      return EXIT_OK;
    }
    process.stderr.write(`登记失败:${result.code}\n`);
    return result.code === "DEFECT_DUPLICATE" ? EXIT_DUPLICATE : EXIT_USAGE;
  }

  if (command === "attribute") {
    const id = requireValue(parsed, "attribute");
    const payload = await readJson(requireValue(parsed, "source"), "--source");
    const source = unwrap(payload, "source");
    const result = attributeDefect(root, id, source as never);
    if (asJson) printJson(result);
    if (!result.ok) {
      process.stderr.write(`归属失败:${result.code}\n`);
      return EXIT_USAGE;
    }
    const lineage = result.lineage;
    if (result.unattributed === true) {
      process.stderr.write(
        `${id} 无法归属(${result.code ?? "DEFECT_UNATTRIBUTED"});可用 --queue 查看,或 --clarify 人工入链\n`,
      );
      return EXIT_UNATTRIBUTED;
    }
    if (!asJson) {
      process.stdout.write(
        `${id} 已入链:category=${lineage?.defect?.category ?? "?"} confidence=${lineage?.confidence ?? "?"} ` +
          `missedLink=${lineage?.defect?.missedLink ?? "none"} chain=${lineage?.chain.length ?? 0}\n`,
      );
    }
    return EXIT_OK;
  }

  if (command === "clarify") {
    const id = requireValue(parsed, "clarify");
    const by = requireValue(parsed, "by");
    const note = requireValue(parsed, "note");
    let missedLink: string | undefined;
    if (parsed.values.has("missed-link")) {
      missedLink = requireValue(parsed, "missed-link");
      if (!MISSED_LINKS.has(missedLink)) throw new Error(`非法 --missed-link:${missedLink}`);
    }
    let sourceTaskId: string | undefined;
    if (parsed.values.has("source")) {
      const payload = await readJson(requireValue(parsed, "source"), "--source");
      const source = unwrap(payload, "source");
      const taskId = source.taskId;
      if (typeof taskId === "string" && taskId.trim() !== "") sourceTaskId = taskId;
    }
    const input: { by: string; note: string; sourceTaskId?: string; missedLink?: never } = { by, note };
    if (sourceTaskId !== undefined) input.sourceTaskId = sourceTaskId;
    if (missedLink !== undefined) input.missedLink = missedLink as never;
    const result = clarifyDefect(root, id, input);
    if (asJson) printJson(result);
    if (!result.ok) {
      process.stderr.write(`澄清失败:${result.code}\n`);
      return EXIT_USAGE;
    }
    if (!asJson) {
      const lineage = result.lineage;
      process.stdout.write(
        `${id} 已人工入链(by=${by}):category=${lineage?.defect?.category ?? "?"} ` +
          `confidence=${lineage?.confidence ?? "?"} missedLink=${lineage?.defect?.missedLink ?? "none"} ` +
          `chain=${lineage?.chain.length ?? 0}\n`,
      );
    }
    return EXIT_OK;
  }

  if (command === "list") {
    const filter: { category?: string; unattributed?: boolean; json?: boolean } = {};
    if (parsed.values.has("category")) filter.category = requireValue(parsed, "category");
    if (parsed.flags.has("unattributed")) filter.unattributed = true;
    if (asJson) filter.json = true;
    const result = listDefects(root, filter);
    if (asJson) {
      printJson(result);
      return EXIT_OK;
    }
    process.stdout.write(`缺陷 ${result.items.length} 条(总行 ${result.totalLines},坏行 ${result.parseErrors})\n`);
    for (const item of result.items) process.stdout.write(`${describe(item)}\n`);
    return EXIT_OK;
  }

  if (command === "queue") {
    const result = unattributedQueue(root);
    if (asJson) {
      printJson(result);
      return EXIT_OK;
    }
    process.stdout.write(`未归属队列 ${result.items.length} 条\n`);
    for (const item of result.items) {
      const modulePart = item.module !== undefined ? ` module=${item.module}` : "";
      process.stdout.write(
        `- ${item.id} fixTask=${item.fixTaskId}${modulePart} category=${item.category} ` +
          `confidence=${item.confidence} reason=${item.reason}\n`,
      );
    }
    return EXIT_OK;
  }

  if (command === "to-graph") {
    const id = requireValue(parsed, "to-graph");
    const graphRoot = parsed.values.get("graph-root") ?? root;
    const result = projectToGraph(root, id, { graphRoot });
    if (asJson) printJson(result);
    if (!result.ok) {
      process.stderr.write(`投影失败:${result.code}(${result.codes.join(",")})\n`);
      return EXIT_UNATTRIBUTED;
    }
    if (!asJson) {
      process.stdout.write(`已投影 ${id}:nodes=${result.nodes} ids=${result.ids.join(",")}\n`);
    }
    return EXIT_OK;
  }

  const report = reportDefects(root);
  if (asJson) {
    printJson(report);
    return EXIT_OK;
  }
  process.stdout.write(
    `缺陷 ${report.total} 条(总行 ${report.totalLines},坏行 ${report.parseErrors},未入链 ${report.unattributed},待澄清 ${report.pendingClarify})\n`,
  );
  process.stdout.write(`byCategory: ${JSON.stringify(report.byCategory)}\n`);
  process.stdout.write(`byConfidence: ${JSON.stringify(report.byConfidence)}\n`);
  process.stdout.write(`byMissedLink: ${JSON.stringify(report.byMissedLink)}\n`);
  return EXIT_OK;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = EXIT_USAGE;
}
