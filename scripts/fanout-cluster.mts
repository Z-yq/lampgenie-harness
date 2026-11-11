#!/usr/bin/env -S node
/**
 * 扇出簇 CLI(扇出返工簇 2026-11):change / fix / detect / list / classify / checklist / gate / to-graph / report。
 * 纯表面层:聚簇与三态判定在 packages/harness-runtime/src/agent/fanout-cluster.ts(纯逻辑),
 * 落盘与投影在 apps/gateway/src/fanout-cluster-store.ts(`<root>/.genie/rsi/fanout.jsonl`,append-only)。
 * 本文件只做 argv 解析、JSON 读入与退出码映射。
 * 用法:node scripts/fanout-cluster.mts --root <dir> <子命令> [--json]
 * --change <file|-> 登记变更(JSON:对象 / {change:...} / 数组取首项)
 * --fix <file|-> 登记修复
 * --detect [--window-days N] 聚簇并落新簇(同 id 幂等)
 * --list [--verdict <v>] [--json] 列簇(按窗口起点升序)
 * --classify <id> 重判某个簇(三态 + 理由)
 * --checklist <archetype> [--json] 某原型的必备清单 + 机械化命令
 * --gate --archetype <a> [--checklist <file|->] [--facts <file>] 辐射面门(并留痕)
 * --to-graph <id> [--graph-root <dir>] 投影进证据图(graphRoot 缺省 = root)
 * --report [--json] 汇总报表
 * --help 本帮助
 * 退出码:0 成功;1 参数错误(缺参数 / 非法 JSON / 非法原型);2 门不通过 或 无法入图/找不到簇;
 * 3 重复变更/修复(FANOUT_DUPLICATE)。
 * 落盘位置:`<root>/.genie/rsi/fanout.jsonl`(真实运行请只给 /tmp 下的 root)。
 */
import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  classifyStoredCluster,
  detectAndSave,
  fanoutClusterPath,
  listClusters,
  projectToGraph,
  radiationGate,
  recordChange,
  recordFix,
  reportFanout,
  requiredChecklistFor,
} from "../apps/gateway/src/fanout-cluster-store.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_REJECT = 2;
const EXIT_DUPLICATE = 3;

const VALUE_FLAGS = new Set([
  "root",
  "change",
  "fix",
  "window-days",
  "verdict",
  "classify",
  "checklist",
  "archetype",
  "facts",
  "to-graph",
  "graph-root",
]);

const BOOL_FLAGS = new Set(["detect", "list", "gate", "report", "json", "help"]);

const COMMANDS = ["change", "fix", "detect", "list", "classify", "checklist", "gate", "to-graph", "report"] as const;

type Command = (typeof COMMANDS)[number];

interface Parsed {
  values: Map<string, string>;
  flags: Set<string>;
}

const HELP = [
  "扇出簇 CLI:用 --root 指定台账根目录(<root>/.genie/rsi/fanout.jsonl)",
  "",
  "用法:node scripts/fanout-cluster.mts --root <dir> <子命令> [--json]",
  "",
  "子命令:",
  "  --change <file|->                                登记变更(id/taskId/at/files/entity|module 必填)",
  "  --fix <file|->                                   登记修复(id/taskId/at/files/edges 必填)",
  "  --detect [--window-days N]                       聚簇并落新簇(缺省窗口 14 天,同 id 幂等)",
  "  --list [--verdict <v>] [--json]                  列簇(verdict=impact-not-closed|batched-delivery|insufficient-evidence)",
  "  --classify <id>                                  重判某个簇(三态 + 理由 + 缺项)",
  "  --checklist <archetype> [--json]                 必备清单 + 机械化命令(integration-replace|public-contract-change|delete-or-semantic-change)",
  "  --gate --archetype <a> [--checklist <file|->] [--facts <file>]  辐射面门(通过 exit 0,不通过 exit 2)",
  "  --to-graph <id> [--graph-root <dir>]             投影进证据图(缺省 graphRoot = root)",
  "  --report [--json]                                汇总报表(byVerdict/byEdgeType/坏行)",
  "  --help                                           本帮助",
  "",
  "输入:路径或 - 表示 stdin;JSON 可为单对象 / {change:...} / {fix:...} / 数组(取第一项)。",
  "退出码:0 成功 / 1 参数错误 / 2 门不通过或无法入图 / 3 重复登记。",
].join("\n");

/** argv → 值表 + 布尔标记(不认识的 flag 也算参数错误)。 */
function parseArgs(argv: string[]): Parsed {
  const values = new Map<string, string>();
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

/** 从 `{change:...}` / `{fix:...}` / 数组首项 / 裸对象里取出实体。 */
function unwrap(payload: unknown, key: "change" | "fix"): Record<string, unknown> {
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
  const present = COMMANDS.filter((name) => {
 // --gate 的清单参数与 --checklist 子命令同名,gate 在场时它只是参数。
    if (name === "checklist" && parsed.flags.has("gate")) return false;
    return parsed.flags.has(name) || parsed.values.has(name);
  });
  if (present.length === 0) throw new Error("缺少子命令(用 --help 看用法)");
  if (present.length > 1) throw new Error(`一次只能跑一个子命令:${present.join(", ")}`);
  return present[0]!;
}

function requireValue(parsed: Parsed, name: string): string {
  const value = parsed.values.get(name);
  if (value === undefined || value.trim() === "") throw new Error(`缺少 --${name}`);
  return value;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** 清单输入:接受 {items:[{key}]} / ["key",...] / [{key},...]。 */
function asChecklist(payload: unknown): { items: { key: string; evidence?: string }[] } {
  if (Array.isArray(payload)) {
    return {
      items: payload.map((item) => (typeof item === "string" ? { key: item } : (item as { key: string; evidence?: string }))),
    };
  }
  if (typeof payload === "object" && payload !== null && Array.isArray((payload as { items?: unknown }).items)) {
    return payload as { items: { key: string; evidence?: string }[] };
  }
  throw new Error("清单输入必须是数组或 {items:[...]}");
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

  if (command === "change" || command === "fix") {
    const spec = requireValue(parsed, command);
    const payload = await readJson(spec, command === "change" ? "变更" : "修复");
    const entity = unwrap(payload, command);
    const result = command === "change" ? recordChange(root, entity) : recordFix(root, entity);
    if (asJson) printJson(result);
    else process.stdout.write(`${command} ${result.id ?? ""}: ok=${result.ok}${result.code ? ` code=${result.code}` : ""}\n`);
    if (result.ok) return EXIT_OK;
    return result.code === "FANOUT_DUPLICATE" ? EXIT_DUPLICATE : EXIT_USAGE;
  }

  if (command === "detect") {
    const windowDays = parsed.values.get("window-days");
    const opts: { windowDays?: number; now?: number } = {};
    if (windowDays !== undefined) {
      const value = Number(windowDays);
      if (!Number.isFinite(value) || value <= 0) throw new Error("--window-days 必须是正数");
      opts.windowDays = value;
    }
    const result = detectAndSave(root, opts);
    if (asJson) printJson(result);
    else {
      process.stdout.write(`detect: ok=${result.ok} new=${result.ids.length} codes=${result.codes.join(",")}\n`);
      for (const cluster of result.clusters) {
        process.stdout.write(
          `- ${cluster.id} entity=${cluster.entity} size=${cluster.size} verdict=${cluster.verdict} edges=${cluster.edgeTypes.join("/")}\n`,
        );
      }
    }
    return result.ok ? EXIT_OK : EXIT_USAGE;
  }

  if (command === "list") {
    const verdict = parsed.values.get("verdict");
    const result = listClusters(root, { verdict });
    if (asJson) printJson(result);
    else {
      process.stdout.write(`list: clusters=${result.clusters.length} 坏行=${result.parseErrors} 总行=${result.totalLines}\n`);
      for (const cluster of result.clusters) {
        process.stdout.write(
          `- ${cluster.id} entity=${cluster.entity} size=${cluster.size} verdict=${cluster.verdict} edges=${cluster.edgeTypes.join("/")}\n`,
        );
      }
    }
    return result.ok ? EXIT_OK : EXIT_USAGE;
  }

  if (command === "classify") {
    const id = requireValue(parsed, "classify");
    const result = classifyStoredCluster(root, id);
    if (asJson) printJson(result);
    else {
      process.stdout.write(`classify ${id}: ${result.verdict} codes=${result.codes.join(",")}\n`);
      process.stdout.write(`  理由:${result.rationale}\n`);
      if (result.missing !== undefined && result.missing.length > 0) p("  建议补清单项:" + result.missing.join(", "));
    }
    return result.ok ? EXIT_OK : EXIT_REJECT;
  }

  if (command === "checklist") {
    const archetype = requireValue(parsed, "checklist");
    const result = requiredChecklistFor(archetype);
    if (asJson) printJson(result);
    else if (!result.applicable) p(`checklist ${archetype}: 不适用(非扇出原型),无需辐射面清单`);
    else {
      p(`checklist ${archetype}: ${result.required.length} 项必备`);
      for (const item of result.required) p(`- ${item.key}(${item.label}):${item.mechanism}`);
    }
    return EXIT_OK;
  }

  if (command === "gate") {
    const archetype = requireValue(parsed, "archetype");
    const checklistSpec = parsed.values.get("checklist");
    let checklist: { items: { key: string; evidence?: string }[] } | undefined;
    if (checklistSpec !== undefined) checklist = asChecklist(await readJson(checklistSpec, "清单"));
    let facts: Record<string, unknown> | undefined;
    const factsSpec = parsed.values.get("facts");
    if (factsSpec !== undefined) {
      const payload = await readJson(factsSpec, "facts");
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("--facts 必须是 JSON 对象");
      facts = payload as Record<string, unknown>;
    }
    const result = radiationGate(root, { archetype, checklist: checklist as never, facts });
    if (asJson) printJson(result);
    else {
      p(`gate ${archetype}: ok=${result.ok} codes=${result.codes.join(",")}`);
      if (result.missing !== undefined && result.missing.length > 0) p(`  缺项:${result.missing.join(", ")}`);
    }
    return result.ok ? EXIT_OK : EXIT_REJECT;
  }

  if (command === "to-graph") {
    const id = requireValue(parsed, "to-graph");
    const graphRoot = parsed.values.get("graph-root") ?? root;
    const result = projectToGraph(root, id, { graphRoot });
    if (asJson) printJson(result);
    else {
      p(`to-graph ${id}: ok=${result.ok} nodes=${result.nodes} codes=${result.codes.join(",")}`);
      if (result.ids.length > 0) p(`  ids=${result.ids.join(",")}`);
    }
    return result.ok ? EXIT_OK : EXIT_REJECT;
  }

 // report
  const report = reportFanout(root);
  if (asJson) printJson(report);
  else {
    p(`report: lines=${report.totalLines} 坏行=${report.parseErrors} changes=${report.changes} fixes=${report.fixes} clusters=${report.clusters} gates=${report.gates}(拒 ${report.gateRejected})`);
    p(`  byVerdict=${JSON.stringify(report.byVerdict)}`);
    p(`  byEdgeType=${JSON.stringify(report.byEdgeType)}`);
    if (report.badLines.length > 0) p(`  坏行行号=${report.badLines.join(",")}`);
    p(`  台账:${fanoutClusterPath(root)}`);
  }
  return EXIT_OK;
}

function p(line: string): void {
  process.stdout.write(`${line}\n`);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT_USAGE;
  });
