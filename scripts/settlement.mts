#!/usr/bin/env node
/**
 * 结算 CLI:把 eagerFork / race / timeout / drain / report 跑成一条可复核的命令行。
 * 用法:
 * node --experimental-strip-types scripts/settlement.mts --root <dir> [--fork <file>] [--drain] [--race]
 * [--timeout <ms>] [--report] [--json]
 * --fork <file> JSON 数组 [{id, outcome:"ok"|"fail", delayMs}]。重复 id **只建一个 task**(去重),
 * 并对该 handle await 两次(演示 DOUBLE_AWAIT_IDEMPOTENT:executions 仍为 1)。
 * --race raceSettle:首个落定者胜出,其余 abort
 * --timeout n withTimeout(handles, n):到点 abort 全部
 * 缺省/--drain drain:等全部落定并取未观察拒绝清单
 * --report 追加一条 report 事件并打印聚合
 * --json 输出机器可读 JSON
 * 退出码:0 正常 / 1 未观察拒绝或超时 / 2 参数或坏输入(此时不写 jsonl)。
 * 事件流:<root>/.genie/rsi/settlement.jsonl(--root 缺省 = cwd)。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SETTLE_CODES } from "../packages/harness-runtime/src/agent/tool-settlement.ts";
import type { SettleHandle, SettleTask } from "../packages/harness-runtime/src/agent/tool-settlement.ts";
import {
  awaitAll,
  drain,
  fork,
  race,
  readSettlementEvents,
  report,
  settlementPath,
  withTimeout,
} from "../apps/gateway/src/settlement-store.ts";

const USAGE = [
  "用法: settlement --root <dir> [--fork <file>] [--drain | --race | --timeout <ms>] [--report] [--json]",
  "退出码: 0 正常 / 1 未观察拒绝或超时 / 2 参数或坏输入(不写 jsonl)",
].join("\n");

class ArgError extends Error {}

const BOOLEAN_FLAGS = new Set(["drain", "race", "report", "json", "help"]);
const VALUE_FLAGS = new Set(["root", "fork", "timeout"]);

type Options = Record<string, string | true>;

function parseArgs(argv: string[]): Options {
  const opts: Options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (!token.startsWith("--")) throw new ArgError(`位置参数不支持: ${token}`);
    const name = token.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      opts[name] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new ArgError(`未知参数 --${name}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new ArgError(`--${name} 缺少取值`);
    opts[name] = value;
    i += 1;
  }
  return opts;
}

interface ForkSpec {
  id: string;
  outcome: "ok" | "fail";
  delayMs: number;
}

function readForkSpecs(file: string): ForkSpec[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new ArgError(`读不到 --fork 文件 ${file}:${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ArgError(`${file} 不是合法 JSON:${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new ArgError(`${file} 必须是任务数组 [{id, outcome, delayMs}]`);
  return parsed.map((item, index) => {
    if (item === null || typeof item !== "object") throw new ArgError(`${file}[${index}] 必须是对象`);
    const raw = item as Record<string, unknown>;
    if (typeof raw.id !== "string" || raw.id === "") throw new ArgError(`${file}[${index}] 缺 id`);
    const outcome = raw.outcome;
    if (outcome !== "ok" && outcome !== "fail") throw new ArgError(`${file}[${index}].outcome 必须是 "ok" | "fail"`);
    const delayMs = raw.delayMs === undefined ? 0 : raw.delayMs;
    if (typeof delayMs !== "number" || !Number.isFinite(delayMs) || delayMs < 0) {
      throw new ArgError(`${file}[${index}].delayMs 必须是非负数`);
    }
    return { id: raw.id, outcome, delayMs };
  });
}

function readTimeout(opts: Options): number | undefined {
  if (opts.timeout === undefined) return undefined;
  const raw = opts.timeout;
  if (typeof raw !== "string") throw new ArgError("--timeout 缺少取值");
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) throw new ArgError(`--timeout 必须是正数(收到 ${raw})`);
  return ms;
}

/** 按 id 去重(保留首次出现),并记录重复次数。 */
function dedupeSpecs(specs: ForkSpec[]): { unique: ForkSpec[]; duplicates: string[]; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  const unique: ForkSpec[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    counts[spec.id] = (counts[spec.id] ?? 0) + 1;
    if (seen.has(spec.id)) continue;
    seen.add(spec.id);
    unique.push(spec);
  }
  const duplicates = Object.keys(counts).filter((id) => (counts[id] ?? 0) > 1);
  return { unique, duplicates, counts };
}

function abortError(id: string): Error {
  const error = new Error(`aborted:${id}`);
  error.name = "AbortError";
  return error;
}

interface Simulation {
  tasks: SettleTask[];
  runs: Record<string, number>;
}

/** 造模拟任务:等 delayMs → ok 兑现 / fail 拒绝;被 abort 时提前结束并抛 abort 错误。 */
function simulate(unique: ForkSpec[]): Simulation {
  const runs: Record<string, number> = {};
  const tasks: SettleTask[] = unique.map((spec) => ({
    id: spec.id,
    run: (ctx) =>
      new Promise((resolveTask, rejectTask) => {
        runs[spec.id] = (runs[spec.id] ?? 0) + 1;
        const finish = (): void => {
          if (spec.outcome === "fail") rejectTask(new Error(`fail:${spec.id}`));
          else resolveTask({ id: spec.id, ok: true });
        };
        if (spec.delayMs === 0) {
          finish();
          return;
        }
        const timer = setTimeout(finish, spec.delayMs);
        const onAbort = (): void => {
          clearTimeout(timer);
          rejectTask(abortError(spec.id));
        };
        if (ctx.signal.aborted) {
          onAbort();
          return;
        }
        ctx.signal.addEventListener("abort", onAbort, { once: true });
      }),
  }));
  return { tasks, runs };
}

function describeHandles(handles: readonly SettleHandle[]): { id: string; state: string; codes: string[]; observed: boolean }[] {
  return handles.map((handle) => ({
    id: handle.id,
    state: handle.state,
    codes: Array.isArray(handle.codes) ? handle.codes.map(String) : [],
    observed: handle.observed === true,
  }));
}

async function main(): Promise<number> {
  let opts: Options;
  let specs: ForkSpec[] = [];
  let timeoutMs: number | undefined;
  try {
    opts = parseArgs(process.argv.slice(2));
    if (opts.help === true) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    timeoutMs = readTimeout(opts);
    if (typeof opts.fork === "string") specs = readForkSpecs(opts.fork);
  } catch (error) {
    if (error instanceof ArgError) {
      process.stderr.write(`参数错误: ${error.message}\n${USAGE}\n`);
      return 2;
    }
    throw error;
  }

  const root = typeof opts.root === "string" ? resolve(opts.root) : process.cwd();
  const json = opts.json === true;
  const mode: "drain" | "race" | "timeout" = opts.race === true ? "race" : timeoutMs !== undefined ? "timeout" : "drain";
  const { unique, duplicates, counts } = dedupeSpecs(specs);
  const { tasks, runs } = simulate(unique);

  const handles: SettleHandle[] =
    specs.length === 0 ? [] : (await fork(root, tasks as SettleTask[])).handles;
  const runsTotal = (): number => Object.values(runs).reduce((sum, n) => sum + n, 0);

 // 去重演示:被重复声明的 id 只跑了一个 task,但对该 handle await 两次。
  const doubleAwaited: { id: string; awaitCount: number; codes: string[]; entries: number }[] = [];
  for (const id of duplicates) {
    const handle = handles.find((h) => h.id === id);
    if (handle === undefined) continue;
    await awaitAll(root, [handle, handle]);
    doubleAwaited.push({
      id,
      awaitCount: typeof handle.awaitCount === "number" ? handle.awaitCount : 0,
      codes: Array.isArray(handle.codes) ? handle.codes.map(String) : [],
      entries: counts[id] ?? 0,
    });
  }
  const executions = duplicates.length > 0 ? (runs[duplicates[0] as string] ?? 0) : runsTotal();

  let diagnostics: { kind: string; handleId: string; at: number }[] = [];
  let winner: string | null = null;
  let aborted: string[] = [];
  let timedOut = false;
  let code: string | undefined;
  let results: { id: string; ok: boolean; value?: unknown; error?: unknown }[] = [];

  if (handles.length === 0) {
 // 没有 --fork:只做 --report,不落空的 drain/race 事件(不制造假结算痕迹)。
  } else if (mode === "race") {
    const settled = await race(root, handles);
    winner = settled.winner?.id ?? null;
    aborted = Array.isArray(settled.aborted) ? settled.aborted : [];
    diagnostics = (settled.log?.diagnostics ?? []).map((d) => ({ kind: d.kind, handleId: d.handleId, at: d.at }));
    results = [{ id: settled.winner.id, ok: settled.winner.state === "fulfilled", value: settled.winner.result }];
  } else if (mode === "timeout") {
    const settled = await withTimeout(root, handles, timeoutMs as number);
    if (settled.status === "timeout") {
      timedOut = true;
      code = settled.code ?? SETTLE_CODES.TIMEOUT_ABORTED;
      aborted = settled.aborted;
    } else {
      diagnostics = (settled.log?.diagnostics ?? []).map((d) => ({ kind: d.kind, handleId: d.handleId, at: d.at }));
      results = settled.log.handles.map((h) => ({ id: h.id, ok: h.state === "fulfilled", value: h.result, error: h.error }));
    }
  } else {
    const log = await drain(root, handles);
    diagnostics = (log?.diagnostics ?? []).map((d) => ({ kind: d.kind, handleId: d.handleId, at: d.at }));
    results = (log?.handles ?? []).map((h) => ({ id: h.id, ok: h.state === "fulfilled", value: h.result, error: h.error }));
  }

  const aggregate = opts.report === true ? await report(root, { limit: 10 }) : undefined;
  const failed = timedOut || diagnostics.length > 0;
  const rc = failed ? 1 : 0;

  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        root,
        file: settlementPath(root),
        mode,
        entries: specs.length,
        tasks: unique.length,
        executions,
        duplicates,
        dedup: doubleAwaited,
        handles: describeHandles(handles),
        results,
        winner,
        aborted,
        timedOut,
        code: code ?? null,
        diagnostics: diagnostics.length,
        diagnosticsItems: diagnostics,
        events: readSettlementEvents(root).events.length,
        report: aggregate ?? null,
      })}\n`,
    );
  } else {
    process.stdout.write(`settlement root=${root} mode=${mode} entries=${specs.length} tasks=${unique.length} executions=${executions}\n`);
    for (const handle of describeHandles(handles)) {
      process.stdout.write(`  ${handle.id} ${handle.state} observed=${handle.observed} codes=[${handle.codes.join(",")}]\n`);
    }
    if (winner !== null) process.stdout.write(`  winner=${winner} aborted=[${aborted.join(",")}]\n`);
    if (timedOut) process.stdout.write(`  timeout=${timeoutMs}ms code=${code} aborted=[${aborted.join(",")}]\n`);
    process.stdout.write(`  diagnostics=${diagnostics.length}\n`);
    for (const item of diagnostics) process.stdout.write(`    ${item.kind} ${item.handleId} @${item.at}\n`);
    if (aggregate !== undefined) {
      process.stdout.write(
        `  report total=${aggregate.total} diagnostics=${aggregate.diagnostics} byKind=${JSON.stringify(aggregate.byKind)} badLines=${aggregate.badLines.length}\n`,
      );
    }
    process.stdout.write(`exit=${rc}\n`);
  }

  if (failed) {
    const reason = timedOut
      ? `${code ?? SETTLE_CODES.TIMEOUT_ABORTED}:${aborted.join(",")}`
      : `unobserved-rejection:${diagnostics.map((d) => d.handleId).join(",")}`;
    process.stderr.write(`✗ ${reason}\n`);
  }
  return rc;
}

process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
process.exitCode = await main();
