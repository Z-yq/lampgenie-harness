#!/usr/bin/env tsx
/**
 * 轨迹收割 CLI(M201,2026-11-09):读 journal → 抽取统一轨迹事件批次 → 脱敏落盘 + 账本幂等。
 *
 * 用法:
 *   npx tsx scripts/trace-harvest.mts --journal-dir .genie/journals --out /tmp/trace-harvest [options]
 *
 *   --journal-dir <dir>  journal 根目录(必填;内含 global.jsonl / sessions/ / sessions-archive/)
 *   --out <dir>          产出目录(必填;批次 <out>/batches/*.jsonl + <out>/ledger.json)
 *   --sessions a,b       限定会话(缺省全量;真实运行务必限定,见纪律)
 *   --rule-version r1    抽取规则版本(进批次键,换版本必产新批)
 *   --max-events N       单会话单批事件上限(超限截断并标记)
 *   --dry-run            只读:不写批次文件、不写账本
 *   --json               机器可读报告
 *
 * 退出码:0 = 完成(含「无新事件」);1 = 运行失败(有失败会话/异常);2 = 参数错误。
 *
 * 只读纪律:本 CLI 只用 journal 的读面(loadChunked + readSession),不 append、不清理、不建锁;
 * 产物全部写 --out(真实运行时用 /tmp),绝不写回 .genie。
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { FileJournal } from "../packages/core/src/journal/journal.ts";
import { harvestTraces } from "../apps/gateway/src/trace-harvest.ts";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const argv = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function usage(message: string): never {
  console.error(`[trace-harvest] ${message}`);
  console.error(
    "用法: npx tsx scripts/trace-harvest.mts --journal-dir <dir> --out <dir> " +
      "[--sessions a,b] [--rule-version r1] [--max-events N] [--json] [--dry-run]",
  );
  process.exit(EXIT_USAGE);
  throw new Error("unreachable: usage()"); // 让 TS 认可 never(process.exit 的返回类型随 lib 配置而异)
}

const journalDir = flag("--journal-dir");
const outDir = flag("--out");
if (!journalDir) usage("缺少 --journal-dir");
if (!outDir) usage("缺少 --out");
if (!existsSync(journalDir)) usage(`journal 目录不存在: ${journalDir}`);

const sessionsArg = flag("--sessions");
const sessions = sessionsArg
  ? sessionsArg.split(",").map((s) => s.trim()).filter(Boolean)
  : undefined;

const ruleVersion = flag("--rule-version") ?? "r1";
if (!ruleVersion.trim()) usage("--rule-version 不能为空");

const maxEventsRaw = flag("--max-events");
let maxEventsPerSession: number | undefined;
if (maxEventsRaw !== undefined) {
  const n = Number(maxEventsRaw);
  if (!Number.isFinite(n) || n <= 0) usage(`--max-events 需要正整数,收到 ${maxEventsRaw}`);
  maxEventsPerSession = Math.floor(n);
}

const asJson = argv.includes("--json");
const dryRun = argv.includes("--dry-run");

const journalAbs = resolve(journalDir);
const outAbs = resolve(outDir);

async function main(): Promise<number> {
  // 自建只读 FileJournal:分片 + 延迟加载 + 归档冷读(归档会话 readSession 需要显式开启)。
  const journal = new FileJournal(join(journalAbs, "gateway.jsonl"), {
    sharded: true,
    deferLoad: true,
    archiveDir: join(journalAbs, "sessions-archive"),
  });
  await journal.loadChunked();
  journal.enableArchiveReads();

  const report = await harvestTraces({
    journal,
    root: process.cwd(),
    ...(sessions ? { sessions } : {}),
    outDir: outAbs,
    dryRun,
    ruleVersion,
    ...(maxEventsPerSession !== undefined ? { maxEventsPerSession } : {}),
  });

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    const cov = report.coverage;
    console.log(`[trace-harvest] journal=${journalAbs} out=${report.outDir}${dryRun ? " (dry-run)" : ""}`);
    console.log(`  ruleVersion=${report.ruleVersion} contractVersion=${report.version}`);
    console.log(
      `  会话 ${report.sessions} · 新批 ${report.batches} · 跳过批 ${report.skippedBatches} · ` +
        `新事件 ${report.events} · 跳事件 ${report.skippedEvents}`,
    );
    console.log(
      `  覆盖: input=${cov.inputEvents} dup=${cov.duplicateSeqs} mapped=${cov.mappedEvents} ` +
        `rate=${(cov.coverageRate * 100).toFixed(1)}%`,
    );
    const unmapped = Object.entries(cov.unmappedByKind).sort((a, b) => b[1] - a[1]);
    if (unmapped.length) {
      console.log(`  未映射: ${unmapped.map(([k, n]) => `${k}×${n}`).join(", ")}`);
    }
    console.log(
      `  丢弃字段 ${report.dropped} · 截断批 ${report.windowTruncated} · 失败会话 ${report.failedSessions.length}`,
    );
    for (const f of report.failedSessions) console.error(`  ! ${f.sessionId}: ${f.error}`);
  }

  return report.failedSessions.length > 0 ? EXIT_FAILED : EXIT_OK;
}

try {
  process.exit(await main());
} catch (e) {
  const message = typeof e === "object" && e !== null && "message" in e
    ? String((e as { message: unknown }).message)
    : String(e);
  console.error(`[trace-harvest] 失败: ${message}`);
  process.exit(EXIT_FAILED);
}
