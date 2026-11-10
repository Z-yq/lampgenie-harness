#!/usr/bin/env -S node --experimental-strip-types
/**
 * 子代理进程交接台账 CLI:register agent / register process / handoff / inventory / delegate / report。
 *
 * 纯表面层:交接语义(归属校验、限次、盘点、分桶、删字段)在
 * packages/harness-runtime/src/agent/subagent-handoff.ts(纯逻辑),
 * 落盘与重放在 apps/gateway/src/handoff-store.ts(`<root>/.genie/rsi/handoff.jsonl`,append-only)。
 * 本文件只做 argv 解析、JSON 读入、打印与退出码映射。
 *
 * 用法:
 *   node --experimental-strip-types scripts/handoff.mts --root <dir> --agent a1 [--max-handoffs 3] [--json]
 *   node --experimental-strip-types scripts/handoff.mts --root <dir> --process p1 --agent a1 [--purpose "watch CI"] [--json]
 *   node --experimental-strip-types scripts/handoff.mts --root <dir> --process p1 --from a1 --to a2 --purpose "长跑" [--json]
 *   node --experimental-strip-types scripts/handoff.mts --root <dir> --inventory a1 [--unread 2] [--json]
 *   node --experimental-strip-types scripts/handoff.mts --root <dir> --delegate <file> [--group g] [--concurrency n] [--json]
 *   node --experimental-strip-types scripts/handoff.mts --root <dir> --report [--json]
 *
 * --delegate 文件:任务数组 `[{id,group?,agentId}]`,或 `{tasks:[...],results?:[{taskId,group?,ok?,output?}]}`。
 * 退出码:0 成功 / 1 参数错误(含非法输入、重复登记、进程不存在)/
 *         2 交接被语义拒绝(缺 purpose / 非 owner / 超限)。
 */
import { readFile } from "node:fs/promises";
import process from "node:process";

import type { DelegateTask, JoinTaskResult } from "@lampgenie/runtime/agent/subagent-handoff";
import {
  delegate,
  handoff,
  inventory,
  registerAgent,
  registerProcess,
  reportHandoff,
} from "../apps/gateway/src/handoff-store.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_REFUSED = 2;

/** 被语义拒绝(该退出 2)的稳定码。 */
const REFUSED_CODES = new Set(["HANDOFF_PURPOSE_REQUIRED", "HANDOFF_NOT_OWNER", "HANDOFF_LIMIT"]);

const BOOL_FLAGS = new Set(["report", "json", "help"]);
const SINGLE_VALUE_FLAGS = new Set([
  "root",
  "agent",
  "process",
  "from",
  "to",
  "purpose",
  "inventory",
  "delegate",
  "group",
  "concurrency",
  "max-handoffs",
  "unread",
]);

interface Parsed {
  values: Map<string, string>;
  flags: Set<string>;
}

const HELP = [
  "用法:node --experimental-strip-types scripts/handoff.mts --root <dir> <子命令> [--json]",
  "",
  "  --root <dir>                       台账根目录(必填)",
  "  --agent <id> [--max-handoffs N]    登记代理(缺省上限 3)",
  "  --process <id> --agent <owner> [--purpose <text>]        登记进程(owner 不存在会自动登记)",
  "  --process <id> --from <a> --to <b> --purpose <text>      交接(缺 purpose/非 owner/超 3 次 → exit 2)",
  "  --inventory <agent> [--unread N]   退出盘点 handed_off / orphaned / unread_completions",
  "  --delegate <file> [--group g] [--concurrency n]          按 group 分桶,每桶一条聚合消息",
  "  --report                           台账汇总",
  "  --json                             机器可读输出",
  "  --help                             本帮助",
  "",
  "退出码:0 成功 / 1 参数错误 / 2 交接被拒(缺 purpose、非 owner、超限)。",
].join("\n");

function parseArgs(argv: string[]): Parsed {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]!;
    if (!raw.startsWith("--")) throw new Error(`无法识别的参数:${raw}`);
    const name = raw.slice(2);
    if (BOOL_FLAGS.has(name)) {
      if (flags.has(name)) throw new Error(`--${name} 只能给一次`);
      flags.add(name);
      continue;
    }
    if (!SINGLE_VALUE_FLAGS.has(name)) throw new Error(`未知选项 --${name}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`--${name} 需要取值`);
    values.set(name, next);
    i += 1;
  }
  return { values, flags };
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
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`--${label} 需要非负整数`);
  return Math.floor(parsed);
}

function exitForCode(code: string): number {
  if (REFUSED_CODES.has(code)) return EXIT_REFUSED;
  if (code === "HANDOFF_HANDED_OFF" || code === "HANDOFF_INVENTORY" || code === "HANDOFF_JOINED") {
    return EXIT_OK;
  }
  return EXIT_USAGE;
}

async function readJson(path: string): Promise<unknown> {
  const text = path === "-" ? await readStdin() : await readFile(path, "utf8");
  return JSON.parse(text) as unknown;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function tasksOf(raw: unknown): { tasks: DelegateTask[]; results: JoinTaskResult[] } {
  const list = Array.isArray(raw) ? raw : (raw as { tasks?: unknown })?.tasks;
  if (!Array.isArray(list)) throw new Error("--delegate 文件必须是任务数组或 {tasks:[...]}");
  const tasks: DelegateTask[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.agentId !== "string") {
      throw new Error("任务必须带 string id 与 agentId");
    }
    tasks.push({
      id: row.id,
      agentId: row.agentId,
      ...(typeof row.group === "string" ? { group: row.group } : {}),
    });
  }
  const rawResults = (raw as { results?: unknown })?.results;
  const results: JoinTaskResult[] = [];
  if (Array.isArray(rawResults)) {
    for (const item of rawResults) {
      if (typeof item !== "object" || item === null) continue;
      const row = item as Record<string, unknown>;
      if (typeof row.taskId !== "string") continue;
      results.push({
        taskId: row.taskId,
        ...(typeof row.group === "string" ? { group: row.group } : {}),
        ...(typeof row.ok === "boolean" ? { ok: row.ok } : {}),
        ...(typeof row.output === "string" ? { output: row.output } : {}),
      });
    }
  }
  return { tasks, results };
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.flags.has("help")) {
    p(HELP);
    return EXIT_OK;
  }
  const root = parsed.values.get("root");
  if (root === undefined) throw new Error("缺 --root <dir>");
  const json = parsed.flags.has("json");

  const commands = [
    parsed.values.has("inventory") ? "inventory" : undefined,
    parsed.values.has("delegate") ? "delegate" : undefined,
    parsed.flags.has("report") ? "report" : undefined,
    parsed.values.has("process") ? "process" : undefined,
    parsed.values.has("agent") ? "agent" : undefined,
  ].filter((item): item is string => item !== undefined);
  if (commands.length === 0) throw new Error("缺子命令:--agent / --process / --inventory / --delegate / --report");
  const primary = commands[0]!;
  // --agent 与 --process 同时出现是合法的(agent 是 process 的 owner),其余组合互斥。
  const conflicting = commands.filter(
    (command, index) => index > 0 && !(primary === "process" && command === "agent"),
  );
  if (conflicting.length > 0) throw new Error(`子命令互斥:${commands.join(" / ")}`);

  if (primary === "agent") {
    const id = parsed.values.get("agent")!;
    const maxHandoffs = intOf(parsed.values.get("max-handoffs"), "max-handoffs");
    const result = registerAgent(root, { id, maxHandoffs });
    if (json) printJson(result);
    else if (result.ok) p(`agent ${result.agent?.id} 已登记(maxHandoffs=${result.agent?.maxHandoffs})`);
    else p(`拒收 ${result.code}`);
    return result.ok ? EXIT_OK : exitForCode(result.code);
  }

  if (primary === "process") {
    const processId = parsed.values.get("process")!;
    const from = parsed.values.get("from");
    const to = parsed.values.get("to");
    if (from !== undefined || to !== undefined) {
      if (from === undefined || to === undefined) throw new Error("交接需要同时给 --from 与 --to");
      const result = handoff(root, {
        processId,
        fromAgent: from,
        toAgent: to,
        purpose: parsed.values.get("purpose"),
      });
      if (json) printJson(result);
      else if (result.ok) p(`${processId}: ${from} → ${to} 交接完成(handoffs=${result.process?.handoffs})`);
      else p(`拒收 ${result.code}`);
      return result.ok ? EXIT_OK : exitForCode(result.code);
    }
    const owner = parsed.values.get("agent");
    if (owner === undefined) throw new Error("登记进程需要 --agent <owner>");
    const result = registerProcess(root, { id: processId, owner, purpose: parsed.values.get("purpose") });
    if (json) printJson(result);
    else if (result.ok) p(`process ${processId} 已登记(owner=${owner})`);
    else p(`拒收 ${result.code}`);
    return result.ok ? EXIT_OK : exitForCode(result.code);
  }

  if (primary === "inventory") {
    const agentId = parsed.values.get("inventory")!;
    const unread = intOf(parsed.values.get("unread"), "unread");
    const result = inventory(root, agentId, { unreadCompletions: unread });
    if (json) printJson(result);
    else {
      p(`inventory ${result.inventory.agentId}`);
      p(`  handed_off: ${result.inventory.handedOff.length === 0 ? "-" : result.inventory.handedOff.join(", ")}`);
      p(`  orphaned: ${result.inventory.orphaned.length === 0 ? "-" : result.inventory.orphaned.join(", ")}`);
      p(`  unread_completions: ${result.inventory.unreadCompletions}`);
    }
    return result.ok ? EXIT_OK : exitForCode(result.code);
  }

  if (primary === "delegate") {
    const file = parsed.values.get("delegate")!;
    const { tasks, results } = tasksOf(await readJson(file));
    const result = delegate(root, {
      tasks,
      group: parsed.values.get("group"),
      concurrency: intOf(parsed.values.get("concurrency"), "concurrency"),
      results,
    });
    if (json) printJson(result);
    else {
      p(`delegate: ${result.joined.count} 个桶, concurrency=${result.plan.concurrency}, slots=${result.plan.slots}`);
      for (const message of result.joined.messages) p(`  ${message}`);
    }
    return result.ok ? EXIT_OK : exitForCode(result.code);
  }

  const report = reportHandoff(root);
  if (json) printJson(report);
  else {
    p(`handoff 台账: ${report.totalLines} 行(坏行 ${report.parseErrors}, 重放拒收 ${report.replayRejects})`);
    p(`  agent=${report.agents} process=${report.processes} handoff=${report.handoffs} delegate=${report.counts.delegate} inventory=${report.counts.inventory}`);
    const owners = Object.entries(report.owners)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([owner, count]) => `${owner}:${count}`);
    p(`  owners: ${owners.length === 0 ? "-" : owners.join(", ")}`);
    p(`  handed_off: ${Object.keys(report.handedOff).length === 0 ? "-" : Object.entries<string[]>(report.handedOff).map(([agent, ids]) => `${agent}→${ids.join("|")}`).join(", ")}`);
    p(`  orphaned: ${report.orphaned.length === 0 ? "-" : report.orphaned.join(", ")}`);
    p(`  unread_completions: ${Object.keys(report.unreadCompletions).length === 0 ? "-" : Object.entries(report.unreadCompletions).map(([agent, n]) => `${agent}:${n}`).join(", ")}`);
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
