#!/usr/bin/env node
/**
 * RSI 周报与可纠正面 CLI(RSI #200,2026-11)。
 *
 * 纯表面层:
 *   - 三问周报的纯逻辑在 packages/harness-runtime/src/agent/rsi-weekly-report.ts
 *   - 六源聚合 / 纠正 / 事件记录在 apps/gateway/src/rsi-weekly.ts(.genie/rsi/weekly.jsonl)
 * 本文件只做 argv 解析、输出格式与退出码映射。
 *
 * 退出码:0 成功 / 1 参数错误 / 2 纠正失败或无可纠正 / 3 提醒被 TTL 抑制。
 * 用法:npx tsx scripts/rsi-weekly.mts --root <dir> --report [--from ISO --to ISO] [--attention-only]
 *        [--json] [--export <file.md>]
 *        --correct <target> --kind rewrite|disable|rollback --by <who> --reason <why>
 *        [--statement <s>] [--graph-root <dir>]
 *        --remind
 */
import {
  aggregateWeekly,
  appendWeeklyEvent,
  correctFromReport,
  shouldRemind,
  writeReportFile,
  type WeeklyEvent,
} from "../apps/gateway/src/rsi-weekly.ts";
import { renderWeeklyReportText } from "../packages/harness-runtime/src/agent/rsi-weekly-report.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_CORRECT_FAILED = 2;
const EXIT_REMIND_SUPPRESSED = 3;

const VALUE_FLAGS = new Set([
  "root",
  "from",
  "to",
  "export",
  "correct",
  "kind",
  "by",
  "reason",
  "statement",
  "graph-root",
]);
const BOOL_FLAGS = new Set(["report", "attention-only", "json", "remind", "help"]);

interface Parsed {
  values: Map<string, string>;
  flags: Set<string>;
}

function parseArgs(argv: string[]): Parsed | { error: string } {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]!;
    if (!raw.startsWith("--")) return { error: `未知参数:${raw}` };
    const name = raw.slice(2);
    if (BOOL_FLAGS.has(name)) {
      flags.add(name);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) return { error: `未知参数:--${name}` };
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      values.set(name, "");
      continue;
    }
    values.set(name, next);
    i += 1;
  }
  return { values, flags };
}

const USAGE = `RSI 周报 CLI(三问:本周改了什么 / 净省了多少 / 需要你决定什么)

用法:
  --root <dir>                     仓库根(缺省 cwd)
  --report                         生成周报(默认动作)
    --from <ISO> --to <ISO>        统计窗口(缺省最近 7 天)
    --attention-only               只看需要人处理的(健康时静默)
    --json                         JSON 输出
    --export <file.md>             markdown 落盘
  --correct <target>               纠正一条事实/实验
    --kind rewrite|disable|rollback
    --by <who> --reason <why>
    --statement <新说法>           rewrite 必填
    --graph-root <dir>             证据图谱根(缺省同 --root)
  --remind                         待批超时提醒(24h TTL 内重复提醒被抑制)
  --help                           本帮助

退出码:0 成功 / 1 参数错误 / 2 纠正失败或无可纠正 / 3 提醒被 TTL 抑制`;

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}\n`);
    return EXIT_USAGE;
  }
  const { values, flags } = parsed;
  if (flags.has("help")) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT_OK;
  }
  const root = values.get("root") ?? process.cwd();
  if (root === "") {
    process.stderr.write("--root 需要一个目录\n");
    return EXIT_USAGE;
  }
  const graphRoot = values.get("graph-root") || undefined;

  if (values.has("correct") || flags.has("correct")) {
    const target = (values.get("correct") ?? "").trim();
    const kind = (values.get("kind") ?? "").trim();
    const by = (values.get("by") ?? "").trim();
    const reason = (values.get("reason") ?? "").trim();
    if (target === "") {
      process.stderr.write("--correct 需要一个 target\n");
      return EXIT_USAGE;
    }
    if (kind !== "rewrite" && kind !== "disable" && kind !== "rollback") {
      process.stderr.write("--kind 必须是 rewrite|disable|rollback\n");
      return EXIT_USAGE;
    }
    if (by === "" || reason === "") {
      process.stderr.write("--by 与 --reason 必填\n");
      return EXIT_USAGE;
    }
    const statement = values.get("statement");
    if (kind === "rewrite" && (statement ?? "").trim() === "") {
      process.stderr.write("--kind rewrite 需要 --statement\n");
      return EXIT_USAGE;
    }
    const result = await correctFromReport(
      root,
      { kind, target, by, reason, ...(statement !== undefined ? { newStatement: statement } : {}) },
      graphRoot !== undefined ? { graphRoot } : {},
    );
    if (!result.ok) {
      process.stderr.write(`纠正失败:${result.codes.join(",") || "unknown"}\n`);
      return EXIT_CORRECT_FAILED;
    }
    const lines = [`纠正完成:${target}(${kind})`];
    if (result.graphNodeId !== undefined) lines.push(`图谱新版本:${result.graphNodeId}`);
    if (result.historyLength !== undefined) lines.push(`历史版本数:${result.historyLength}`);
    if (result.codes.length > 0) lines.push(`codes:${result.codes.join(",")}`);
    process.stdout.write(`${lines.join("\n")}\n`);
    return EXIT_OK;
  }

  if (flags.has("remind")) {
    const report = await aggregateWeekly(root, {});
    const outcome = shouldRemind(root, report);
    if (!outcome.remind) {
      process.stdout.write(`提醒被抑制:${outcome.reason}\n`);
      return EXIT_REMIND_SUPPRESSED;
    }
    const event: WeeklyEvent = {
      kind: "reminded",
      at: new Date().toISOString(),
      attentionCount: report.attentionCount,
      reason: outcome.reason,
    };
    appendWeeklyEvent(root, event);
    process.stdout.write(`已提醒:${outcome.reason}(待决 ${report.attentionCount} 项)\n`);
    return EXIT_OK;
  }

  if (flags.has("report") || flags.size === 0) {
    const from = values.get("from");
    const to = values.get("to");
    const report = await aggregateWeekly(root, {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(flags.has("attention-only") ? { attentionOnly: true } : {}),
    });
    appendWeeklyEvent(root, {
      kind: "generated",
      at: new Date().toISOString(),
      attentionCount: report.attentionCount,
      healthy: report.healthy,
      window: report.window,
    });
    const exportTo = values.get("export");
    if (exportTo) {
      const path = writeReportFile(root, report, exportTo);
      process.stderr.write(`周报已写入:${path}\n`);
    }
    if (flags.has("json")) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderWeeklyReportText(report)}\n`);
    }
    return EXIT_OK;
  }

  process.stderr.write(`${USAGE}\n`);
  return EXIT_USAGE;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`运行失败:${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = EXIT_USAGE;
  });
