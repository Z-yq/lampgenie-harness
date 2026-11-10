#!/usr/bin/env node
/**
 * g2 journal 热窗冷卸 —— 稳态 RSS 探针(2026-11)。
 *
 * 目的:用产线 journal 目录(.genie/journals,只读打开)做夹具,量「热窗关闭」与「热窗启用」两种
 * 稳态下 FileJournal 的堆驻留差异,回答「热窗到底省了多少 RSS」。
 *
 * 用法:
 *   node --max-old-space-size=6144 scripts/rss-probe-journal.mjs
 *   node --max-old-space-size=6144 scripts/rss-probe-journal.mjs --dir .genie/journals --hot-sessions 20
 *   node --max-old-space-size=6144 scripts/rss-probe-journal.mjs --no-full-read   # 跳过 readAll 完整性校验
 *
 * 子进程两趟(避免同进程堆复用/GC 干扰):
 *   ①基线:GENIE_JOURNAL_HOT_SESSIONS=0(全量驻留 = 今天的现状)
 *   ②现状:GENIE_JOURNAL_HOT_SESSIONS=<N>(默认 20,热窗生效)
 * 每趟打印 process.memoryUsage() 的 rss/heapUsed/heapTotal、事件数、加载耗时与热窗画像;
 * 父进程汇总打印「稳态 RSS 前后对比」。夹具缺失直接报错退出(不编造数字)。
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const MB = 1_048_576;

function parseArgs(argv) {
  const args = { dir: null, hotSessions: 20, fullRead: true, child: false, envHot: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") args.dir = argv[++i];
    else if (a === "--hot-sessions") args.hotSessions = Number(argv[++i]);
    else if (a === "--no-full-read") args.fullRead = false;
    else if (a === "--child") args.child = true;
    else if (a === "--env-hot") args.envHot = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.log("用法: node --max-old-space-size=6144 scripts/rss-probe-journal.mjs [--dir <journalDir>] [--hot-sessions N] [--no-full-read]");
      process.exit(0);
    } else {
      console.error(`未知参数: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

/** 子进程:真跑一遍 loadChunked,量稳态内存。 */
async function runChild(args) {
  const dir = resolve(args.dir ?? join(ROOT, ".genie", "journals"));
  const gatewayFile = join(dir, "gateway.jsonl");
  assertFixture(dir);
  if (args.envHot !== null) process.env.GENIE_JOURNAL_HOT_SESSIONS = String(args.envHot);

  const t0 = Date.now();
  const { FileJournal } = await import("../packages/core/src/journal/journal.ts");
  const journal = new FileJournal(gatewayFile, { sharded: true, deferLoad: true });
  await journal.loadChunked();
  const loadMs = Date.now() - t0;

  // 稳态:两次 full GC(若有 --expose-gc)后取 memoryUsage,避免把加载瞬时峰值当稳态。
  const settle = () => {
    if (typeof global.gc === "function") { global.gc(); global.gc(); }
  };
  settle();
  const afterLoad = process.memoryUsage();
  const stats = journal.hotWindowStats();
  const waterMark = journal.length;

  let readAllCount = null;
  let readAllMs = null;
  let afterReadAll = null;
  if (args.fullRead) {
    const t1 = Date.now();
    const all = journal.readAll();
    readAllMs = Date.now() - t1;
    readAllCount = all.length;
    let monotonic = true;
    for (let i = 1; i < all.length; i++) if (all[i].seq <= all[i - 1].seq) { monotonic = false; break; }
    afterReadAll = { count: all.length, monotonic };
    // readAll 的临时数组可被 GC:验证「补齐后可回收」。
    afterReadAll.rssAfterGc = null;
    all.length = 0;
    settle();
    afterReadAll.rssAfterGc = process.memoryUsage().rss;
  }
  settle();
  const final = process.memoryUsage();

  console.log(`PROBE_RESULT ${JSON.stringify({
    hotLimit: stats.hotLimit,
    hotSessions: stats.hotSessions,
    coldSessions: stats.coldSessions,
    residentEvents: stats.residentEvents,
    waterMark,
    loadMs,
    afterLoad: { rss: afterLoad.rss, heapUsed: afterLoad.heapUsed, heapTotal: afterLoad.heapTotal },
    readAllCount,
    readAllMs,
    afterReadAll,
    final: { rss: final.rss, heapUsed: final.heapUsed },
    gcExposed: typeof global.gc === "function",
  })}`);
  // FileJournal 无 close():只读夹具不会写盘;退出即可(setTimeout 钩子未注册:未开 write-behind)。
  process.exit(0);
}

/** 夹具可用性:目录在场且至少有一种 journal 布局(gateway.jsonl / global.jsonl / sessions/)。 */
function assertFixture(dir) {
  const ok = existsSync(dir)
    && (existsSync(join(dir, "gateway.jsonl")) || existsSync(join(dir, "global.jsonl")) || existsSync(join(dir, "sessions")));
  if (!ok) {
    console.error(`[probe] 夹具不可用:${dir} 不存在或没有 journal 文件(gateway.jsonl/global.jsonl/sessions/)——用 --dir 指向真实 journal 目录`);
    process.exit(3);
  }
}

function runParent(args) {
  const dir = resolve(args.dir ?? join(ROOT, ".genie", "journals"));
  const gatewayFile = join(dir, "gateway.jsonl");
  assertFixture(dir);
  const sizeOf = (p) => { try { return statSync(p).size; } catch { return 0; } };
  const totalBytes = sizeOf(gatewayFile) + sizeOf(join(dir, "global.jsonl"));
  console.log(`[probe] 夹具 ${dir}`);
  console.log(`[probe] gateway.jsonl ${(sizeOf(gatewayFile) / MB).toFixed(1)}MB + global.jsonl ${(sizeOf(join(dir, "global.jsonl")) / MB).toFixed(1)}MB + sessions/(会话分文件)`);
  console.log(`[probe] 只读打开;子进程各跑一趟 node --max-old-space-size=6144`);

  const runs = [
    { label: "基线(热窗关闭)", envHot: "0" },
    { label: `现状(热窗 N=${args.hotSessions})`, envHot: String(args.hotSessions) },
  ];
  const results = [];
  for (const run of runs) {
    const argv = [
      "--max-old-space-size=6144",
      "--expose-gc",
      "--import", "tsx",
      fileURLToPath(import.meta.url),
      "--child",
      "--dir", dir,
      "--env-hot", run.envHot,
    ];
    if (!args.fullRead) argv.push("--no-full-read");
    const t = Date.now();
    const r = spawnSync(process.execPath, argv, { encoding: "utf-8", maxBuffer: 64 * MB, cwd: ROOT });
    if (r.status !== 0) {
      console.error(`[probe] ${run.label} 子进程失败(status=${r.status})`);
      console.error(r.stderr?.slice(-4000) ?? "");
      process.exit(4);
    }
    const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("PROBE_RESULT "));
    if (!line) {
      console.error(`[probe] ${run.label} 子进程没输出结果`);
      console.error(r.stdout?.slice(-2000) ?? "");
      process.exit(5);
    }
    const data = JSON.parse(line.slice("PROBE_RESULT ".length));
    const wall = Date.now() - t;
    results.push({ label: run.label, data, wall });
    console.log(`[probe] ${run.label}: 用时 ${(wall / 1000).toFixed(1)}s,稳态 rss=${(data.afterLoad.rss / MB).toFixed(0)}MB heapUsed=${(data.afterLoad.heapUsed / MB).toFixed(0)}MB 事件数=${data.readAllCount ?? data.waterMark}(水位 ${data.waterMark}) 热会话 ${data.hotSessions}/冷会话 ${data.coldSessions}/驻留 ${data.residentEvents}`);
  }

  const [base, hot] = results;
  const dRss = (base.data.afterLoad.rss - hot.data.afterLoad.rss) / MB;
  const dHeap = (base.data.afterLoad.heapUsed - hot.data.afterLoad.heapUsed) / MB;
  const pct = base.data.afterLoad.rss > 0 ? (dRss * 100) / (base.data.afterLoad.rss / MB) : 0;
  const signed = (v) => `${v >= 0 ? "-" : "+"}${Math.abs(v).toFixed(0)}MB`;
  console.log("");
  console.log("=== 稳态 RSS 前后对比(loadChunked 完成后,GC 后测量)===");
  console.log(`  基线(热窗关闭): rss ${(base.data.afterLoad.rss / MB).toFixed(0)}MB / heapUsed ${(base.data.afterLoad.heapUsed / MB).toFixed(0)}MB / 事件数 ${base.data.readAllCount ?? base.data.waterMark}`);
  console.log(`  热窗 N=${hot.data.hotLimit}: rss ${(hot.data.afterLoad.rss / MB).toFixed(0)}MB / heapUsed ${(hot.data.afterLoad.heapUsed / MB).toFixed(0)}MB / 事件数 ${hot.data.readAllCount ?? hot.data.waterMark}`);
  console.log(`  Δ(基线 - 热窗): rss ${signed(dRss)} (${pct.toFixed(0)}%),heapUsed ${signed(dHeap)}`);
  if (base.data.readAllCount !== null && hot.data.readAllCount !== null) {
    const dCount = hot.data.readAllCount - base.data.readAllCount;
    const dWater = hot.data.waterMark - base.data.waterMark;
    const same = base.data.readAllCount === hot.data.readAllCount;
    console.log(`  readAll 完整性: 基线 ${base.data.readAllCount} 条 / 热窗 ${hot.data.readAllCount} 条 ${
      same ? "✔ 一致" : `差 ${dCount} 条(同期水位差 ${dWater} —— 夹具是产线活目录,两趟之间网关仍在追加;差值与水位差同量级即为一致)`
    };热窗 readAll 用时 ${hot.data.readAllMs}ms(冷会话补齐 IO:解析冷会话分文件)`);
  }
  console.log(`  热窗画像: 热会话 ${hot.data.hotSessions}/冷会话 ${hot.data.coldSessions}、驻留事件 ${hot.data.residentEvents}/${hot.data.waterMark}`);
  console.log(`  gcExposed=${hot.data.gcExposed}(未加 --expose-gc 时数字含未回收垃圾,偏保守)`);
  if (hot.data.afterLoad.rss / MB < 300) console.log("  达标:热窗稳态 RSS < 300MB");
  else console.log("  未达标:热窗稳态 RSS ≥ 300MB");
}

const args = parseArgs(process.argv.slice(2));
if (args.child) await runChild(args);
else runParent(args);
