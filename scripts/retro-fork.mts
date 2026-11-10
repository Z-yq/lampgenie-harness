#!/usr/bin/env tsx
/**
 * 后台复盘 fork CLI(#114):驱动 append-only 台账 tick,跑出触发判定与 fork 规格,写复盘产物。
 *
 * 用法:
 *   NODE_OPTIONS=--conditions=development npx tsx scripts/retro-fork.mts \
 *     --root /tmp/rf --session s1 --event user-turn --times 10 [--json]
 *   ... --event final-response [--json]                    # 阈值已满 → trigger + forkSpec
 *   ... --event interrupt|cron|tool-iteration [--times n]
 *   ... --summary "<洞察一句话>" [--ref <evidence-ref>]...  # 写一条产物(幂等键去重)
 *   ... --report [--json]                                   # 全量报告
 *
 * 退出码:0 = 正常(含 skipped);1 = 参数错;2 = 拒绝(产物重复/状态非法)。
 *
 * 纪律:只写 <root>/.genie/rsi/retro.jsonl;只读不碰其它目录;不接 loop(纯手工/脚本驱动)。
 */
import { resolve } from "node:path";
import { getRetroState, recordArtifact, retroReport, tick } from "../apps/gateway/src/retro-fork-store.ts";
import type { RetroEventKind } from "@lampgenie/runtime/agent/retrospective-fork";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_REJECTED = 2;

const EVENT_KINDS: readonly RetroEventKind[] = [
  "user-turn",
  "tool-iteration",
  "final-response",
  "interrupt",
  "cron",
  "retro-done",
];

const VALUE_FLAGS = new Set(["--root", "--session", "--event", "--times", "--summary", "--ref"]);
const BOOL_FLAGS = new Set(["--report", "--json", "--help"]);

interface Parsed {
  values: Map<string, string>;
  lists: Map<string, string[]>;
  flags: Set<string>;
}

function parse(argv: string[]): Parsed | { error: string } {
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();
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
      if (token === "--ref") {
        const list = lists.get(token) ?? [];
        list.push(value);
        lists.set(token, list);
      } else {
        values.set(token, value);
      }
      i += 1;
      continue;
    }
    return { error: `未知参数: ${token}` };
  }
  return { values, lists, flags };
}

const USAGE = [
  "后台复盘 fork CLI",
  "",
  "  npx tsx scripts/retro-fork.mts --root <dir> --session <id> --event <kind> [--times n] [--json]",
  "  npx tsx scripts/retro-fork.mts --root <dir> --session <id> --summary <text> [--ref <id>]... [--json]",
  "  npx tsx scripts/retro-fork.mts --root <dir> --report [--json]",
  "",
  `  --event: ${EVENT_KINDS.join(" | ")}`,
  "  公共开关:--root <dir>(缺省 cwd)--json --help",
  "  产出:.genie/rsi/retro.jsonl(append-only)",
  "退出码:0 正常(含 skipped)| 1 参数错 | 2 拒绝(产物重复/状态非法)",
].join("\n");

function usage(message: string): never {
  console.error(`[retro-fork] ${message}`);
  console.error("用法: npx tsx scripts/retro-fork.mts --help");
  process.exit(EXIT_USAGE);
  throw new Error("unreachable: usage()");
}

function positiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) usage(`${name} 需要正整数,收到 ${raw}`);
  if (n > 1000) usage(`${name} 上限 1000,收到 ${raw}`);
  return n;
}

async function main(argv: string[]): Promise<number> {
  const parsed = parse(argv);
  if ("error" in parsed) usage(parsed.error);
  if (parsed.flags.has("--help")) {
    console.log(USAGE);
    return EXIT_OK;
  }
  const root = resolve(parsed.values.get("--root") ?? process.cwd());
  const asJson = parsed.flags.has("--json");

  if (parsed.flags.has("--report")) {
    const report = retroReport(root);
    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`[retro-fork] 台账 ${report.file} · 行数 ${report.totalLines}(坏行 ${report.badLines})`);
      for (const session of report.sessions) {
        console.log(
          `  ${session.sessionId}: userTurns=${session.userTurns} toolIterations=${session.toolIterations} `
          + `retroCount=${session.retroCount} depth=${session.depth} nudge=${session.nudge} `
          + `triggers=${session.triggers} forks=${session.forks} artifacts=${session.artifacts}`,
        );
      }
      console.log(
        `  合计: sessions=${report.totals.sessions} triggers=${report.totals.triggers} `
        + `forks=${report.totals.forks} artifacts=${report.totals.artifacts} retros=${report.totals.retros}`,
      );
    }
    return EXIT_OK;
  }

  const sessionId = parsed.values.get("--session");
  if (sessionId === undefined || sessionId.trim() === "") usage("缺少 --session <id>");

  const summary = parsed.values.get("--summary");
  const refs = parsed.lists.get("--ref") ?? [];
  const eventRaw = parsed.values.get("--event");

  if (eventRaw !== undefined) {
    if (!(EVENT_KINDS as readonly string[]).includes(eventRaw)) usage(`未知 --event: ${eventRaw}`);
    const event = eventRaw as RetroEventKind;
    const times = positiveInt(parsed.values.get("--times"), "--times") ?? 1;
    let last = tick(root, { sessionId: sessionId.trim(), event });
    for (let i = 1; i < times; i += 1) {
      if (!last.ok) break;
      last = tick(root, { sessionId: sessionId.trim(), event });
    }
    if (asJson) {
      console.log(JSON.stringify({ tick: last, state: getRetroState(root, sessionId.trim()) }, null, 2));
    } else {
      console.log(
        `[retro-fork] ${last.sessionId} ${event}×${times} → trigger=${last.trigger} codes=[${last.codes.join(",")}]`,
      );
      console.log(`  reason: ${last.reason}`);
      console.log(
        `  state: userTurns=${last.state.userTurns} toolIterations=${last.state.toolIterations} `
        + `retroCount=${last.state.retroCount} depth=${last.state.depth} nudge=${last.state.nudge}`,
      );
      if (last.forkSpec !== undefined) {
        console.log(`  forkSpec.tools: ${last.forkSpec.tools.join(",")}`);
        console.log(`  forkSpec.deny: ${last.forkSpec.deny.join(",")}`);
        console.log(`  forkSpec.depth=${last.forkSpec.depth} detached=${last.forkSpec.detached} nudge=${last.forkSpec.nudge}`);
      }
    }
    if (!last.ok) return EXIT_REJECTED;
  }

  if (summary !== undefined) {
    const recorded = recordArtifact(root, {
      sessionId: sessionId.trim(),
      summary,
      ...(refs.length > 0 ? { evidenceRefs: refs } : {}),
    });
    if (asJson) {
      console.log(JSON.stringify({ artifact: recorded }, null, 2));
    } else if (recorded.ok && recorded.artifact !== undefined) {
      console.log(
        `[retro-fork] artifact ${recorded.artifact.idempotencyKey} confidence=${recorded.artifact.confidence} `
        + `refs=${recorded.artifact.evidenceRefs.length}`,
      );
    } else {
      console.error(`[retro-fork] 产物被拒: ${recorded.codes.join(",")} ${recorded.reason ?? ""}`.trim());
    }
    if (!recorded.ok) return EXIT_REJECTED;
    return EXIT_OK;
  }

  if (eventRaw === undefined) usage("缺少 --event 或 --summary(--report 单独使用)");
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
  console.error(`[retro-fork] 失败: ${message}`);
  process.exit(EXIT_USAGE);
}
