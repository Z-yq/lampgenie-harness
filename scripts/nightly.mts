#!/usr/bin/env tsx
/**
 * 夜间离线整合调度 CLI(#190 Dreaming+):增量拉轨迹 → 去噪 → 挖掘 → 待审证据 → 候选 → 排队实验。
 *
 * 用法:
 *   NODE_OPTIONS=--conditions=development npx tsx scripts/nightly.mts --start --root /tmp/ngt \
 *     --project demo --date 2026-11-09 --journal /tmp/ngt/journal [--online-busy] [--max-sessions N] [--budget N]
 *   ... --run <runId> [--journal <dir>] | --pause <runId> --reason <text> | --resume <runId> | --retry <runId>
 *   ... --finalize <runId> | --list [--json] | --show <runId> [--json] | --report [--json] | --help
 *
 * 退出码:0 = 成功;1 = 参数错;2 = 跳过/暂停/预算超限/坏步/失败;3 = 已完成/不存在。
 *
 * 纪律:只读 journal;只写 <root>/.genie/rsi/nightly 下的账本;只产候选,不 adopt、不改线上。
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  NIGHTLY_DIR,
  finalizeNightly,
  listRuns,
  nightlyReport,
  pauseNightly,
  readQueue,
  retryNightly,
  resumeNightly,
  runNightly,
  startNightly,
} from "../apps/gateway/src/nightly-store.ts";
import type { NightlyRun } from "@lampgenie/runtime/agent/nightly-run";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_STATUS = 2;
const EXIT_DONE = 3;

const VALUE_FLAGS = new Set([
  "--root",
  "--project",
  "--date",
  "--journal",
  "--max-sessions",
  "--budget",
  "--reason",
  "--run",
  "--pause",
  "--resume",
  "--retry",
  "--finalize",
  "--show",
]);
const BOOL_FLAGS = new Set(["--start", "--list", "--report", "--online-busy", "--json", "--help"]);
const COMMANDS = ["--start", "--run", "--pause", "--resume", "--retry", "--finalize", "--list", "--show", "--report"];

const HELP = [
  "nightly —— 夜间离线整合调度(#190 Dreaming+)",
  "",
  "用法:",
  "  npx tsx scripts/nightly.mts --start --project <p> --date <YYYY-MM-DD> --journal <dir> [--online-busy] [--max-sessions N] [--budget N]",
  "  npx tsx scripts/nightly.mts --run <runId> [--journal <dir>]",
  "  npx tsx scripts/nightly.mts --pause <runId> [--reason <text>]",
  "  npx tsx scripts/nightly.mts --resume <runId> [--journal <dir>]",
  "  npx tsx scripts/nightly.mts --retry <runId> [--journal <dir>]",
  "  npx tsx scripts/nightly.mts --finalize <runId>",
  "  npx tsx scripts/nightly.mts --list [--json]",
  "  npx tsx scripts/nightly.mts --show <runId> [--json]",
  "  npx tsx scripts/nightly.mts --report [--project <p>] [--date <YYYY-MM-DD>] [--json]",
  "",
  "公共开关:--root <dir>(缺省 cwd)--journal <dir>(缺省 <root>/.genie/journals)--json --help",
  `产出目录:${NIGHTLY_DIR}/<project>/<date>.json + queue.jsonl + cursor.json`,
  "退出码:0 成功 | 1 参数错 | 2 跳过/暂停/预算/坏步/失败 | 3 已完成/不存在",
  "纪律:只读 journal;六步只产候选(排队实验),不 direct adopt、不改线上。",
].join("\n");

interface Parsed {
  values: Map<string, string>;
  flags: Set<string>;
}

function parse(argv: string[]): Parsed | { error: string } {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (BOOL_FLAGS.has(token)) {
      flags.add(token);
      continue;
    }
    if (VALUE_FLAGS.has(token)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return { error: `${token} 需要一个值` };
      values.set(token, value);
      i += 1;
      continue;
    }
    return { error: `未知参数: ${token}` };
  }
  return { values, flags };
}

function usage(message: string): never {
  console.error(`[nightly] ${message}`);
  console.error("用法: npx tsx scripts/nightly.mts --help");
  process.exit(EXIT_USAGE);
  throw new Error("unreachable: usage()");
}

function positiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) usage(`${name} 需要正整数,收到 ${raw}`);
  return Math.floor(n);
}

function dateOk(date: string | undefined): date is string {
  return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date);
}

function codeExit(codes: readonly string[]): number {
  if (codes.includes("NIGHTLY_SKIPPED_DONE")) return EXIT_DONE;
  if (
    codes.includes("NIGHTLY_SKIPPED_ONLINE_BUSY") ||
    codes.includes("NIGHTLY_PAUSED") ||
    codes.includes("NIGHTLY_BUDGET_EXCEEDED") ||
    codes.includes("NIGHTLY_BAD_STEP") ||
    codes.includes("NIGHTLY_FAILED") ||
    codes.includes("NIGHTLY_INVALID")
  ) {
    return EXIT_STATUS;
  }
  return EXIT_OK;
}

function printRun(run: NightlyRun, codes: readonly string[], asJson: boolean): void {
  if (asJson) {
    process.stdout.write(JSON.stringify({ run, codes }, null, 2) + "\n");
    return;
  }
  const done = run.steps.filter((step) => step.status === "done").length;
  console.log(
    `[nightly] runId=${run.runId} project=${run.projectId} date=${run.date} status=${run.status} ` +
      `steps=${done}/${run.steps.length} budget=${run.budget.tokens}/${run.budget.maxTokens}`,
  );
  console.log(`  window: ${run.window.from} ~ ${run.window.to}`);
  const cov = run.coverage;
  console.log(
    `  coverage: sessions ${cov.sessionsProcessed}/${cov.sessionsTotal}(跳过 ${cov.sessionsSkipped}) ` +
      `events ${cov.eventsRead}(跳过 ${cov.eventsSkipped})`,
  );
  console.log(`  candidates=${run.candidates.length} unprocessed=${run.unprocessed.length}`);
  if (run.pauseReason) console.log(`  pauseReason: ${run.pauseReason}`);
  for (const step of run.steps) {
    console.log(`  - ${step.name}: ${step.status} tokens=${step.consumedTokens}${step.artifactRef ? ` → ${step.artifactRef}` : ""}`);
  }
  if (codes.length > 0) console.log(`  codes: ${codes.join(", ")}`);
}

async function main(argv: string[]): Promise<number> {
  const parsed = parse(argv);
  if ("error" in parsed) usage(parsed.error);
  const { values, flags } = parsed;
  if (flags.has("--help")) {
    console.log(HELP);
    return EXIT_OK;
  }

  const selected = COMMANDS.filter((cmd) => flags.has(cmd) || values.has(cmd));
  if (selected.length !== 1) usage(`需要且只需要一个动作(收到 ${selected.length} 个)`);
  const command = selected[0] ?? "--list";

  const root = resolve(values.get("--root") ?? process.cwd());
  const asJson = flags.has("--json");
  const journalDefault = resolve(root, ".genie", "journals");
  const journalDir = resolve(values.get("--journal") ?? journalDefault);
  const project = values.get("--project");
  const date = values.get("--date");
  const maxSessions = positiveInt(values.get("--max-sessions"), "--max-sessions");
  const budget = positiveInt(values.get("--budget"), "--budget");

  const requireJournal = (): string => {
    if (!existsSync(journalDir)) usage(`journal 目录不存在: ${journalDir}`);
    return journalDir;
  };

  const locate = async (runId: string | undefined): Promise<NightlyRun> => {
    if (!runId) usage("缺少 runId");
    const run = (await listRuns(root)).find((entry) => entry.runId === runId);
    if (!run) {
      console.error(`[nightly] run 不存在: ${runId}`);
      process.exit(EXIT_DONE);
    }
    return run;
  };

  if (command === "--start") {
    if (!project) usage("--start 缺少 --project");
    if (!dateOk(date)) usage("--start 需要 --date YYYY-MM-DD");
    const journal = requireJournal();
    const result = await startNightly(root, {
      date,
      projectId: project,
      journalDir: journal,
      onlineBusy: flags.has("--online-busy"),
      ...(maxSessions !== undefined ? { maxSessions } : {}),
      ...(budget !== undefined ? { config: { maxTokens: budget } } : {}),
    });
    if (!result.run) {
      console.error(`[nightly] start 被拒绝: ${result.codes.join(", ")}`);
      return EXIT_USAGE;
    }
    if (result.codes.includes("NIGHTLY_SKIPPED_ONLINE_BUSY")) {
      console.log(`[nightly] 在线忙碌,本轮让路(未产生 run): ${result.codes.join(", ")}`);
      return EXIT_STATUS;
    }
    if (result.codes.includes("NIGHTLY_SKIPPED_DONE")) {
      console.log(`[nightly] 已完成,跳过: ${result.run.runId} (${result.codes.join(", ")})`);
      return EXIT_DONE;
    }
    printRun(result.run, result.codes, asJson);
    return EXIT_OK;
  }

  if (command === "--run") {
    const run = await locate(values.get("--run"));
    const result = await runNightly(root, {
      runId: { projectId: run.projectId, date: run.date },
      journalDir: requireJournal(),
      ...(maxSessions !== undefined ? { maxSessions } : {}),
    });
    printRun(result.run, result.codes, asJson);
    return codeExit(result.codes);
  }

  if (command === "--pause") {
    const run = await locate(values.get("--pause"));
    const result = await pauseNightly(root, {
      projectId: run.projectId,
      date: run.date,
      reason: values.get("--reason") ?? "manual",
    });
    if (!result.run) {
      console.error(`[nightly] 暂停失败: ${result.codes.join(", ")}`);
      return EXIT_DONE;
    }
    printRun(result.run, result.codes, asJson);
    return codeExit(result.codes);
  }

  if (command === "--resume" || command === "--retry") {
    const run = await locate(values.get(command));
    const journal = requireJournal();
    const options = {
      projectId: run.projectId,
      date: run.date,
      journalDir: journal,
      ...(maxSessions !== undefined ? { maxSessions } : {}),
    };
    const result = command === "--resume" ? await resumeNightly(root, options) : await retryNightly(root, options);
    printRun(result.run, result.codes, asJson);
    return codeExit(result.codes);
  }

  if (command === "--finalize") {
    const run = await locate(values.get("--finalize"));
    const result = await finalizeNightly(root, { projectId: run.projectId, date: run.date });
    if (!result.run) {
      console.error(`[nightly] 收尾失败: ${result.codes.join(", ")}`);
      return EXIT_DONE;
    }
    printRun(result.run, result.codes, asJson);
    return codeExit(result.codes);
  }

  if (command === "--list") {
    const runs = (await listRuns(root)).filter(
      (run) => (project === undefined || run.projectId === project) && (date === undefined || run.date === date),
    );
    if (asJson) {
      process.stdout.write(JSON.stringify(runs, null, 2) + "\n");
    } else if (runs.length === 0) {
      console.log("[nightly] 无 run");
    } else {
      for (const run of runs) {
        const done = run.steps.filter((step) => step.status === "done").length;
        console.log(
          `${run.date} ${run.projectId} ${run.status} steps=${done}/${run.steps.length} ` +
            `tokens=${run.budget.tokens} candidates=${run.candidates.length} runId=${run.runId}`,
        );
      }
    }
    const queue = readQueue(root);
    if (!asJson) console.log(`[nightly] queue: ${queue.length} 条候选排队`);
    return runs.length === 0 ? EXIT_DONE : EXIT_OK;
  }

  if (command === "--report") {
    const lines = await nightlyReport(root, {
      ...(project !== undefined ? { projectId: project } : {}),
      ...(date !== undefined ? { date } : {}),
    });
    const empty = lines.length === 1 && lines[0] === "nightly: 无匹配 run";
    if (asJson) {
      process.stdout.write(JSON.stringify({ lines, queue: readQueue(root) }, null, 2) + "\n");
    } else {
      for (const line of lines) console.log(line);
    }
    return empty ? EXIT_DONE : EXIT_OK;
  }

  // --show
  const run = await locate(values.get("--show"));
  if (asJson) {
    process.stdout.write(JSON.stringify(run, null, 2) + "\n");
  } else {
    printRun(run, [], false);
    const queued = readQueue(root).filter((line) => line.runId === run.runId);
    console.log(`  queue entries for run: ${queued.length}`);
    if (run.unprocessed.length > 0) {
      console.log(`  unprocessed: ${run.unprocessed.map((item) => `${item.sessionId}(${item.reason})`).join(", ")}`);
    }
  }
  return EXIT_OK;
}

process.stdout.on("error", (error: { code?: string }) => {
  if (error.code === "EPIPE") process.exit(EXIT_OK);
});

try {
  process.exit(await main(process.argv.slice(2)));
} catch (error) {
  const message = typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error);
  console.error(`[nightly] 失败: ${message}`);
  process.exit(EXIT_USAGE);
}
