#!/usr/bin/env node
/**
 * journal 存储维护 CLI(M123,2026-11-08)。
 *
 * 用法(node scripts/journal-maintenance.mts [...];Node ≥22.18 默认类型剥离)或 pnpm exec tsx 同参数:
 *   --plan                  (默认)只读:打印候选/可回收字节/预计减少的 boot 文件数
 *   --apply                 执行归档(活 writer 下须 --force;先快照→plan→apply)
 *   --verify                逐条重算归档 sha256 与 manifest 比对
 *   --restore <sid>         sha256 校验后把会话文件 rename 回 sessions/(目标存在 → 拒)
 *   --json                  机器可读输出(缺省文本)
 *   --max-files <n>         单次最多归档文件数(默认 20)
 *   --max-bytes <n|200MB>   单次归档字节预算(默认 200MB)
 *   --older-than-days <n>   mtime 早于 n 天才是候选(默认 7)
 *   --keep-newest <n>       最新 n 个会话文件永不归档(默认 10)
 *   --force                 活 writer 下仍执行(慎用:维护方须自行确保不再写入)
 *   --journal <dir>         journal 目录(缺省从 cwd 向上找 .genie/journals)
 *   --archive <dir>         归档目录(缺省 <journal>/sessions-archive)
 *
 * 退出码:0=正常;2=活 writer 拒跑 / 校验失败 / 恢复失败 / 归档漂移 abort;3=参数或 IO 错误。
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_KEEP_NEWEST,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  DEFAULT_OLDER_THAN_DAYS,
  applyArchive,
  archiveGate,
  journalArchiveDirOf,
  listHolders,
  planArchive,
  restoreArchive,
  snapshotJournal,
  verifyArchive,
} from "../apps/gateway/src/journal-maintenance.ts";

const EXIT_OK = 0;
const EXIT_BLOCKED = 2;
const EXIT_USAGE = 3;

function usage(message: string): never {
  console.error(message);
  console.error("用法:journal-maintenance.mts [--plan|--apply|--verify|--restore <sid>] [--json] [--force] [--max-files n] [--max-bytes 200MB] [--older-than-days n] [--keep-newest n] [--journal dir] [--archive dir]");
  process.exit(EXIT_USAGE);
  throw new Error("unreachable"); // 防 tsconfig 下 process.exit 未被当 never 的配置差异
}

function parseBytes(raw: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|k|m|g)?$/i.exec(raw.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = (m[2] ?? "b").toLowerCase();
  const mult = unit === "b" ? 1
    : unit === "kb" || unit === "k" ? 1024
    : unit === "mb" || unit === "m" ? 1024 ** 2
    : 1024 ** 3;
  return Math.floor(n * mult);
}

function findJournalDir(start: string): string | undefined {
  let dir = resolve(start);
  for (let i = 0; i < 8; i += 1) {
    const cand = join(dir, ".genie", "journals");
    if (existsSync(cand)) return cand;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** journalDir = <root>/.genie/journals 时反推 root(holder 探测要看 <root>/.genie/*)。 */
function rootOfJournalDir(journalDir: string): string {
  const norm = journalDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const suffix = "/.genie/journals";
  return norm.endsWith(suffix) ? norm.slice(0, -suffix.length) : process.cwd();
}

function countSessionsFiles(journalDir: string): number {
  try {
    return readdirSync(join(journalDir, "sessions")).filter((n) => n.endsWith(".jsonl")).length;
  } catch {
    return 0;
  }
}

const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--restore", "--journal", "--archive", "--max-files", "--max-bytes", "--older-than-days", "--keep-newest"]);
const BOOL_FLAGS = new Set(["--plan", "--apply", "--verify", "--json", "--force"]);
const values = new Map<string, string>();
const flags = new Set<string>();
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]!;
  if (VALUE_FLAGS.has(arg)) {
    const value = argv[i + 1];
    if (value === undefined) usage(`参数 ${arg} 需要值`);
    values.set(arg, value);
    i += 1;
    continue;
  }
  if (BOOL_FLAGS.has(arg)) {
    flags.add(arg);
    continue;
  }
  usage(`未知参数: ${arg}`);
}

const modes = ["--apply", "--verify", "--restore"].filter((m) => (m === "--plan" ? flags.has(m) : flags.has(m) || values.has(m)));
if (modes.length > 1) usage(`模式互斥:${modes.join(" ")}`);
const mode: "plan" | "apply" | "verify" | "restore" =
  flags.has("--apply") ? "apply" : flags.has("--verify") ? "verify" : values.has("--restore") ? "restore" : "plan";

function numFlag(name: string): number | undefined {
  const raw = values.get(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) usage(`${name} 需要非负数字,收到 ${raw}`);
  return n;
}

const bytesRaw = values.get("--max-bytes");
const maxBytes = bytesRaw === undefined ? DEFAULT_MAX_BYTES : parseBytes(bytesRaw);
if (maxBytes === undefined) usage(`--max-bytes 需要字节数或 200MB/1G 形态,收到 ${bytesRaw}`);

const journalDirArg = values.get("--journal");
const journalDir = journalDirArg ? resolve(journalDirArg) : findJournalDir(process.cwd());
if (!journalDir) usage("找不到 journal 目录(.genie/journals);用 --journal 指定");
if (!existsSync(journalDir)) usage(`journal 目录不存在:${journalDir}`);
const archiveDirArg = values.get("--archive");
const archiveDir = archiveDirArg ? resolve(archiveDirArg) : journalArchiveDirOf(journalDir);
const root = rootOfJournalDir(journalDir);
const json = flags.has("--json");
const planOptions = {
  journalDir,
  archiveDir,
  olderThanDays: numFlag("--older-than-days") ?? DEFAULT_OLDER_THAN_DAYS,
  maxFiles: numFlag("--max-files") ?? DEFAULT_MAX_FILES,
  maxBytes,
  keepNewest: numFlag("--keep-newest") ?? DEFAULT_KEEP_NEWEST,
};

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function humanBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

function summarizeSkipped(skipped: Array<{ reason: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of skipped) out[s.reason] = (out[s.reason] ?? 0) + 1;
  return out;
}

try {
  const holders = listHolders(root);

  if (mode === "plan") {
    const plan = planArchive(planOptions);
    const sessionsFiles = countSessionsFiles(journalDir);
    if (json) {
      printJson({
        mode: "plan",
        journalDir,
        archiveDir,
        root,
        holders,
        sessionsFiles,
        candidates: plan.candidates,
        totalBytes: plan.totalBytes,
        totalBytesHuman: humanBytes(plan.totalBytes),
        candidateCount: plan.candidates.length,
        projectedBootSessionsFiles: Math.max(0, sessionsFiles - plan.candidates.length),
        skipped: summarizeSkipped(plan.skipped),
        threshold: plan.threshold,
        olderThanDays: plan.olderThanDays,
        maxFiles: plan.maxFiles,
        maxBytes: plan.maxBytes,
        keepNewest: plan.keepNewest,
        generatedAt: plan.generatedAt,
      });
    } else {
      console.log(`mode=plan journal=${journalDir} archive=${archiveDir}`);
      console.log(`holders: live=${holders.live} gatewayPid=${holders.gatewayPid ?? "-"} lockPid=${holders.lockPid ?? "-"} workers=${holders.workerPids.join(",") || "-"}`);
      console.log(`sessions=${sessionsFiles} candidates=${plan.candidates.length} totalBytes=${plan.totalBytes}(${humanBytes(plan.totalBytes)}) bootFiles ${sessionsFiles}→${Math.max(0, sessionsFiles - plan.candidates.length)}(预计 -${plan.candidates.length})`);
      for (const c of plan.candidates) {
        console.log(`  - ${c.sid} ${humanBytes(c.bytes)} ${new Date(c.mtime).toISOString()}`);
      }
      const skipped = summarizeSkipped(plan.skipped);
      console.log(`skipped: ${Object.entries(skipped).map(([k, v]) => `${k}=${v}`).join(" ") || "-"}`);
    }
    process.exit(EXIT_OK);
  }

  if (mode === "apply") {
    const gate = archiveGate(holders, { force: flags.has("--force"), dryRun: false });
    if (!gate.ok) {
      if (json) printJson({ mode: "apply", ok: false, code: gate.code, holders });
      else {
        console.error(`STORAGE_BUSY_HOLDERS: 活 writer 在写 journal(gatewayPid=${holders.gatewayPid ?? "-"} lockPid=${holders.lockPid ?? "-"} alive=${holders.alivePids.join(",") || "-"}),拒绝归档。`);
        console.error("确认已停机并想强制执行时加 --force(维护方自负双写风险)。");
      }
      process.exit(EXIT_BLOCKED);
    }
    const snapshotBefore = snapshotJournal(journalDir);
    const plan = planArchive(planOptions);
    const result = applyArchive(plan, { snapshotBefore });
    if (json) printJson({ ...result, sessionsFilesBefore: countSessionsFiles(journalDir) + result.archived.length });
    else {
      console.log(`mode=apply ok=${result.ok} archived=${result.archived.length} skipped=${result.skipped.length}${result.aborted ? ` aborted=${result.aborted.code}@${result.aborted.file}` : ""}`);
      for (const a of result.archived) console.log(`  + ${a.sid} → ${a.target} sha256=${a.sha256.slice(0, 12)}…${a.drift ? " (drift)" : ""}`);
      for (const s of result.skipped) console.log(`  - ${s.file} (${s.reason}${s.detail ? `: ${s.detail}` : ""})`);
      console.log(`manifest=${result.manifestPath} cursor=${result.cursorPath}`);
    }
    process.exit(result.ok ? EXIT_OK : EXIT_BLOCKED);
  }

  if (mode === "verify") {
    const result = verifyArchive(archiveDir);
    if (json) printJson({ mode: "verify", ...result });
    else {
      console.log(`mode=verify ok=${result.ok} checked=${result.checked} failures=${result.failures.length}`);
      for (const f of result.failures) console.log(`  ! ${f.file} ${f.code}${f.sid ? ` sid=${f.sid}` : ""}`);
      console.log(`manifest=${result.manifestPath}`);
    }
    process.exit(result.ok ? EXIT_OK : EXIT_BLOCKED);
  }

  const sid = values.get("--restore");
  if (!sid) usage("--restore 需要 <sid>");
  const result = restoreArchive({ archiveDir, journalDir, sid });
  if (json) printJson({ mode: "restore", ...result });
  else console.log(result.ok ? `mode=restore ok sid=${result.sid} → ${result.restored}` : `mode=restore failed code=${result.code}${result.detail ? ` detail=${result.detail}` : ""}`);
  process.exit(result.ok ? EXIT_OK : EXIT_BLOCKED);
} catch (err) {
  console.error(`journal-maintenance 失败:${String((err as Error)?.stack ?? err).slice(0, 800)}`);
  process.exit(EXIT_USAGE);
}
