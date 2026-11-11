#!/usr/bin/env -S npx tsx
/**
 * 任务图 CLI(#174):init / should / apply / reopen / replay / report。
 * 用法:
 * tsx scripts/task-graph.mts --root /tmp/tg --init /tmp/init.json # "-" 从 stdin 读
 * tsx scripts/task-graph.mts --root /tmp/tg --should --target 2 [--json]
 * tsx scripts/task-graph.mts --root /tmp/tg --apply /tmp/ext.json --target 2 [--json]
 * tsx scripts/task-graph.mts --root /tmp/tg --reopen --node a --round 1 [--json]
 * tsx scripts/task-graph.mts --root /tmp/tg --replay [--completed a,b] [--json]
 * tsx scripts/task-graph.mts --root /tmp/tg --report [--json]
 * 退出码:0 成功(含 PLANNER_SKIPPED / REPLAY_SKIPPED);
 * 1 运行/校验失败(TASKGRAPH_INVALID / IO);
 * 2 参数错误 / 恶劣边(TASKGRAPH_BAD_EDGE)/ 超限(TASKGRAPH_EXHAUSTED / REOPEN_LIMIT / CRITIC_ROUND_LIMIT)。
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type StoreModule = typeof import("../apps/gateway/src/task-graph-store.ts");

const USAGE = `任务图 CLI(#174)

用法:
  --root <dir>                    图根目录;图文件 <dir>/.genie/rsi/task-graph.json
  --init <file>                  初始化图({nodes,edges,...}; "-" 从 stdin 读)
  --should --target <n>          判断该不该跑 planner(frontier<target 或存在 unseen completions)
  --apply <file> --target <n>    先问 should,再从文件读 PlannerOutput 并合并(带配额)
  --reopen --node <id> --round <n>  critic 重开一个终态节点(per-node ≤2,round ≤3)
  --replay [--completed a,b]     replay:已完成节点跳过执行
  --report                       汇总报告
  --json                         以 JSON 输出
  --help, -h                     打印本说明

退出码:0 成功;1 校验/IO 失败;2 参数错误 / 坏边 / 超限(exhausted)。`;

interface CliArgs {
  root: string;
  init?: string;
  should: boolean;
  apply?: string;
  target: number;
  reopen: boolean;
  node?: string;
  round?: number;
  replay: boolean;
  completed: string[];
  report: boolean;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    root: "",
    should: false,
    target: 1,
    reopen: false,
    replay: false,
    completed: [],
    report: false,
    json: false,
    help: false,
  };
  const valueOf = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} 缺少取值`);
    return v;
  };
  const numOf = (i: number, flag: string): number => {
    const raw = valueOf(i, flag);
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${flag} 需要数字,收到 ${raw}`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case "--help":
      case "-h":
        out.help = true;
        break;
      case "--root":
        out.root = resolve(valueOf(i, arg));
        i += 1;
        break;
      case "--init":
        out.init = valueOf(i, arg);
        i += 1;
        break;
      case "--should":
        out.should = true;
        break;
      case "--apply":
        out.apply = valueOf(i, arg);
        i += 1;
        break;
      case "--target":
        out.target = numOf(i, arg);
        i += 1;
        break;
      case "--reopen":
        out.reopen = true;
        break;
      case "--node":
        out.node = valueOf(i, arg);
        i += 1;
        break;
      case "--round":
        out.round = numOf(i, arg);
        i += 1;
        break;
      case "--replay":
        out.replay = true;
        break;
      case "--completed":
        out.completed = valueOf(i, arg)
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id !== "");
        i += 1;
        break;
      case "--report":
        out.report = true;
        break;
      case "--json":
        out.json = true;
        break;
      default:
        throw new Error(`未知参数:${arg}`);
    }
  }
  return out;
}

/** 读 stdin 全文。 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

/** 读 JSON 文件或 stdin("-")。 */
async function readJsonSource(src: string): Promise<unknown> {
  const text = src === "-" ? await readStdin() : await readFile(resolve(src), "utf8");
  return JSON.parse(text) as unknown;
}

async function loadStore(): Promise<StoreModule> {
  return (await import("../apps/gateway/src/task-graph-store.ts")) as unknown as StoreModule;
}

/** 码 → 退出码:坏边/超限 2,其余失败 1,成功 0。 */
const EXIT_TWO: ReadonlySet<string> = new Set<string>([
  "TASKGRAPH_BAD_EDGE",
  "TASKGRAPH_EXHAUSTED",
  "TASKGRAPH_REOPEN_LIMIT",
  "TASKGRAPH_CRITIC_ROUND_LIMIT",
]);

function exitCodeOf(result: { ok: boolean; code?: string }): number {
  if (result.code !== undefined && EXIT_TWO.has(result.code)) return 2;
  return result.ok ? 0 : 1;
}

function emit(args: CliArgs, payload: Record<string, unknown>, human: string): void {
  if (args.json) console.log(JSON.stringify(payload, null, 2));
  else console.log(human);
}

function actionCount(args: CliArgs): number {
  return [args.init !== undefined, args.should, args.apply !== undefined, args.reopen, args.replay, args.report].filter(
    (on) => on).length;
}

async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`参数错误:${err instanceof Error ? err.message : String(err)}`);
    console.error(USAGE);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.root === "") {
    console.error("缺少 --root");
    console.error(USAGE);
    return 2;
  }
  if (actionCount(args) === 0) {
    console.error("缺少子命令(--init/--should/--apply/--reopen/--replay/--report)");
    console.error(USAGE);
    return 2;
  }
  if (actionCount(args) > 1) {
    console.error("同一轮只能有一个子命令");
    return 2;
  }
  if (args.reopen && (args.node === undefined || args.round === undefined)) {
    console.error("--reopen 需要 --node <id> 与 --round <n>");
    return 2;
  }

  const store = await loadStore();

  if (args.init !== undefined) {
    let input: unknown;
    try {
      input = await readJsonSource(args.init);
    } catch (err) {
      console.error(`读取 init 文件失败:${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    const res = store.init(args.root, input);
    emit(
      args,
      { ok: res.ok, code: res.code ?? (res.ok ? "INIT" : "TASKGRAPH_INVALID"), path: res.path, nodes: res.graph.nodes.length },
      res.ok
        ? `nodes=${res.graph.nodes.length} edges=${res.graph.edges.length} path=${res.path}`
        : `code=${res.code} path=${res.path}`,
    );
    return res.ok ? 0 : 1;
  }

  if (args.should) {
    const res = store.shouldRun(args.root, { targetCollection: args.target });
    emit(
      args,
      {
        ok: res.ok,
        code: res.code,
        run: res.run,
        reason: res.reason,
        frontier: res.frontier,
        target: args.target,
        unseenCompletions: res.unseenCompletions ?? [],
        path: res.path,
      },
      `code=${res.code} run=${res.run} frontier=${res.frontier} target=${args.target} unseen=[${(res.unseenCompletions ?? []).join(",")}]`,
    );
    return exitCodeOf(res);
  }

  if (args.apply !== undefined) {
    const gate = store.shouldRun(args.root, { targetCollection: args.target });
    if (!gate.ok) {
      emit(args, { ok: false, code: gate.code, path: gate.path }, `code=${gate.code}`);
      return 1;
    }
    if (gate.run !== true) {
      emit(args, { ok: true, code: gate.code, skipped: true, path: gate.path }, `code=${gate.code} skipped=true`);
      return 0;
    }
    let output: unknown;
    try {
      output = await readJsonSource(args.apply);
    } catch (err) {
      console.error(`读取 apply 文件失败:${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    const res = store.apply(args.root, output as Parameters<StoreModule["apply"]>[1]);
    emit(
      args,
      {
        ok: res.ok,
        code: res.code,
        added: res.added,
        exhausted: res.exhausted,
        plannerRuns: res.graph.plannerRuns,
        consecutiveErrors: res.graph.consecutiveErrors,
        nodes: res.graph.nodes.length,
        edges: res.graph.edges.length,
        issues: res.issues,
        path: res.path,
      },
      [
        `code=${res.code}`,
        `nodes=${res.graph.nodes.length} edges=${res.graph.edges.length}`,
        `plannerRuns=${res.graph.plannerRuns} consecutiveErrors=${res.graph.consecutiveErrors}`,
        `exhausted=${res.exhausted === true}`,
        ...(res.issues && res.issues.length > 0 ? [`issues=${res.issues.map((i) => i.reason).join(",")}`] : []),
      ].join(" "),
    );
    return exitCodeOf(res);
  }

  if (args.reopen) {
    const res = store.criticReopen(args.root, { nodeId: args.node!, round: args.round! });
    emit(
      args,
      {
        ok: res.ok,
        code: res.code,
        reason: res.reason,
        node: res.node,
        stagesReset: res.stagesReset,
        path: res.path,
      },
      res.ok
        ? `code=${res.code} node=${res.node?.id} status=${res.node?.status} stage=${res.node?.stage} reopens=${res.node?.reopens} reset=[${(res.stagesReset ?? []).join(",")}]`
        : `code=${res.code} reason=${res.reason ?? ""}`,
    );
    return exitCodeOf(res);
  }

  if (args.replay) {
    const res = store.replay(args.root, args.completed);
    emit(
      args,
      { ok: true, code: res.code, skipped: res.skipped ?? [], executed: res.executed ?? [], path: res.path },
      `code=${res.code} skipped=[${(res.skipped ?? []).join(",")}] executed=[${(res.executed ?? []).join(",")}]`,
    );
    return 0;
  }

  const rep = store.report(args.root);
  emit(
    args,
    rep as unknown as Record<string, unknown>,
    [
      `nodes=${rep.nodes} edges=${rep.edges}`,
      `frontier=${rep.frontier} analyzed=${rep.analyzed}`,
      `plannerRuns=${rep.plannerRuns} consecutiveErrors=${rep.consecutiveErrors} exhausted=${rep.exhausted}`,
      `byKind=${JSON.stringify(rep.byKind)} byStatus=${JSON.stringify(rep.byStatus)}`,
      `unseenCompletions=[${rep.unseenCompletions.join(",")}]`,
      `found=${rep.found} path=${rep.path}`,
    ].join("\n"),
  );
  return rep.ok ? 0 : 1;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`运行失败:${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
