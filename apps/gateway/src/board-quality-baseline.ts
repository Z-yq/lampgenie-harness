// 板质量遥测基线表(bq5):纯聚合脚本,零仓内依赖(node:fs/node:path 直跑)。
// 直跑:node --experimental-strip-types apps/gateway/src/board-quality-baseline.ts --journal <dir>
// journal 落盘布局(上游已验证):
//   <journalDir>/global.jsonl          跨会话 kind
//   <journalDir>/sessions/<sid>.jsonl  会话肥 kind
//   <journalDir>/gateway.jsonl         旧文件(冻结,读到并入)
// 逐行 JSON:{seq,kind,sessionId,time,payload}
// 事件字段契约(上游并行任务落账;本脚本对字段缺失防御,缺了当 0/跳过,不抛):
//   kind=board.audit    payload={taskId,boardType?,ok,grand{total,passed,rate},
//                                planQuality{nodes,contentNodes,anchorDensity,p0{passed,total,rate}},
//                                issueCounts{contract,type,symbol,target},skeletonPrefilled,snapshotFp,auditPath}
//   kind=board.skeleton payload={taskId,boardId,status:"ok"|"rejected",generated,landedCount,elidedRate,dropped{...}}
//   kind=custom         payload.type==="task.quality" {taskId,planQuality{...},skeleton?{generated,survived,adoptionRate}}

import * as fs from "node:fs";
import * as path from "node:path";

const DAY_MS = 86400000;
const NO_BOARD_TYPE = "(无板型)";

/** 表头元信息(纯函数缺省时输出占位说明)。 */
export type BaselineMeta = {
  /** journal 数据源目录(表头回显)。 */
  sourceDir?: string;
  /** 复算命令原样回显(CLI 侧拼好传入)。 */
  cmd?: string;
};

/** 单板型聚合桶。 */
type BoardTypeAgg = {
  boardType: string;
  audits: number;
  okCount: number;
  issueContract: number;
  issueType: number;
  issueSymbol: number;
  issueTarget: number;
  p0RateSum: number;
  p0Audits: number;
  anchorSum: number;
  anchorAudits: number;
};

function newAgg(boardType: string): BoardTypeAgg {
  return {
    boardType,
    audits: 0,
    okCount: 0,
    issueContract: 0,
    issueType: 0,
    issueSymbol: 0,
    issueTarget: 0,
    p0RateSum: 0,
    p0Audits: 0,
    anchorSum: 0,
    anchorAudits: 0,
  };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** 比率 round3;非有限值输出 n/a。 */
function rate3(x: number): string {
  if (!Number.isFinite(x)) return "n/a";
  return String(Math.round(x * 1000) / 1000);
}

/**
 * 纯聚合:lines=全部 jsonl 行合集(global+sessions+旧 gateway),按窗口过滤后聚合,
 * 返回 markdown 基线表。窗口=nowMs-days*86400000 ≤ time(time 缺失/非数按 0=窗口外剔除)。
 */
export function aggregateBoardQuality(
  lines: string[],
  nowMs: number,
  days: number,
  meta?: BaselineMeta): string {
  const winStart = nowMs - days * DAY_MS;
  const byType = new Map<string, BoardTypeAgg>();
  const skeletonTasks = new Set<string>();
  let skeletonOkEvents = 0;
  let skeletonRejected = 0;
  let elidedSum = 0;
  const settledTasks = new Set<string>();
  // taskId -> 窗口内最新一条 task.quality(adoptionRate 无 skeleton 时为 null)
  const latestQuality = new Map<string, { time: number; adoption: number | null }>();
  let anyEvent = false;

  for (const raw of lines) {
    const line = typeof raw === "string" ? raw.trim() : "";
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // 畸形行跳过
    }
    const rec = asRecord(obj);
    const kind = typeof rec.kind === "string" ? rec.kind : "";
    if (!kind) continue;
    const time = asNum(rec.time);
    if (!(time >= winStart)) continue; // 窗口外(含 time 缺失=0)剔除
    const payload = asRecord(rec.payload);
    anyEvent = true;

    if (kind === "board.audit") {
      const bt =
        typeof payload.boardType === "string" && payload.boardType ? payload.boardType : NO_BOARD_TYPE;
      let agg = byType.get(bt);
      if (!agg) {
        agg = newAgg(bt);
        byType.set(bt, agg);
      }
      agg.audits += 1;
      if (payload.ok === true) agg.okCount += 1;
      const ic = asRecord(payload.issueCounts);
      agg.issueContract += asNum(ic.contract);
      agg.issueType += asNum(ic.type);
      agg.issueSymbol += asNum(ic.symbol);
      agg.issueTarget += asNum(ic.target);
      // P0 覆盖均值:仅 grand.total>0 且 p0.total>0 的审计计 passed/total,分母=计入的审计数
      const grand = asRecord(payload.grand);
      const pq = asRecord(payload.planQuality);
      const p0 = asRecord(pq.p0);
      const grandTotal = asNum(grand.total);
      const p0Total = asNum(p0.total);
      if (grandTotal > 0 && p0Total > 0) {
        agg.p0RateSum += asNum(p0.passed) / p0Total;
        agg.p0Audits += 1;
      }
      // 锚密度均值:planQuality.anchorDensity 在场才计入,分母=计入的审计数
      if (typeof pq.anchorDensity === "number" && Number.isFinite(pq.anchorDensity)) {
        agg.anchorSum += pq.anchorDensity;
        agg.anchorAudits += 1;
      }
    } else if (kind === "board.skeleton") {
      const tid = typeof payload.taskId === "string" ? payload.taskId : "";
      if (tid) skeletonTasks.add(tid);
      if (payload.status === "rejected") {
        skeletonRejected += 1;
      } else if (payload.status === "ok") {
        skeletonOkEvents += 1;
        elidedSum += asNum(payload.elidedRate);
      }
    } else if (kind === "custom" && payload.type === "task.quality") {
      const tid = typeof payload.taskId === "string" ? payload.taskId : "";
      if (!tid) continue;
      settledTasks.add(tid);
      const sk = asRecord(payload.skeleton);
      const adoption =
        typeof sk.adoptionRate === "number" && Number.isFinite(sk.adoptionRate)
          ? sk.adoptionRate
          : null;
      const prev = latestQuality.get(tid);
      if (!prev || time >= prev.time) latestQuality.set(tid, { time, adoption });
    }
  }

  // 采纳率均值:各任务最新一条 task.quality 带 skeleton.adoptionRate 的取值均值
  let adoptionSum = 0;
  let adoptionTasks = 0;
  for (const rec of latestQuality.values()) {
    if (rec.adoption !== null) {
      adoptionSum += rec.adoption;
      adoptionTasks += 1;
    }
  }

  const usage = settledTasks.size > 0 ? rate3(skeletonTasks.size / settledTasks.size) : "n/a";
  const adoptionAvg = adoptionTasks > 0 ? rate3(adoptionSum / adoptionTasks) : "n/a";
  const elidedAvg = skeletonOkEvents > 0 ? rate3(elidedSum / skeletonOkEvents) : "n/a";

  const out: string[] = [];
  out.push("# 板质量基线表");
  out.push("");
  out.push(`- 数据源目录:\`${meta?.sourceDir ?? "(未提供,纯函数聚合)"}\``);
  out.push(
    `- 窗口:${new Date(winStart).toISOString()} ~ ${new Date(nowMs).toISOString()}(--days ${days})`,
  );
  out.push(`- 复算命令:\`${meta?.cmd ?? "(未提供)"}\``);
  out.push("");
  if (!anyEvent) out.push("> 窗口内无事件");
  out.push("");
  out.push("## 板型质量");
  out.push("");
  out.push(
    "| 板型 | audits | ok率 | 契约均次 | 板型门均次 | 幻影均次 | targets均次 | P0覆盖均值 | 锚密度均值 |",
  );
  out.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const types = [...byType.values()].sort((a, b) =>
    a.boardType < b.boardType ? -1 : a.boardType > b.boardType ? 1 : 0);
  for (const t of types) {
    const okRate = rate3(t.okCount / t.audits);
    const contract = rate3(t.issueContract / t.audits);
    const typeIssue = rate3(t.issueType / t.audits);
    const symbol = rate3(t.issueSymbol / t.audits);
    const target = rate3(t.issueTarget / t.audits);
    const p0Avg = t.p0Audits > 0 ? rate3(t.p0RateSum / t.p0Audits) : "n/a";
    const anchorAvg = t.anchorAudits > 0 ? rate3(t.anchorSum / t.anchorAudits) : "n/a";
    out.push(
      `| ${t.boardType} | ${t.audits} | ${okRate} | ${contract} | ${typeIssue} | ${symbol} | ${target} | ${p0Avg} | ${anchorAvg} |`,
    );
  }
  out.push("");
  out.push("## 骨架遥测");
  out.push("");
  out.push("| 指标 | 数值 |");
  out.push("| --- | --- |");
  out.push(`| 使用率 | ${usage} |`);
  out.push(`| 采纳率 | ${adoptionAvg} |`);
  out.push(`| 剔除率 | ${elidedAvg} |`);
  out.push(`| 骨架任务数 | ${skeletonTasks.size} |`);
  out.push(`| rejected 次数 | ${skeletonRejected} |`);
  out.push(`| 结算任务数 | ${settledTasks.size} |`);
  out.push("");
  return out.join("\n");
}

/** 从 cwd 向上逐级(限 8 级)找含 .genie/journals 的目录。 */
/** 候选目录是否"有当轮数据":含 global.jsonl 或 sessions/ 下有 jsonl。
 * 经验证缺陷:apps/gateway/.genie/journals 是 10-18 的残留(只有旧 gateway.jsonl +
 *  shots/),真源在仓根 —— 只判"目录存在"会把数据源指错,静默输出空表。 */
function hasLiveJournal(cand: string): boolean {
  try {
    if (fs.existsSync(path.join(cand, "global.jsonl"))) return true;
    const sd = path.join(cand, "sessions");
    if (!fs.existsSync(sd)) return false;
    return fs.readdirSync(sd).some((f) => f.endsWith(".jsonl"));
  } catch {
    return false;
  }
}

function findDefaultJournalDir(): string | undefined {
  let dir = process.cwd();
  let firstExisting: string | undefined;
  for (let i = 0; i < 8; i += 1) {
    const cand = path.join(dir, ".genie", "journals");
    try {
      if (fs.existsSync(cand) && fs.statSync(cand).isDirectory()) {
        if (hasLiveJournal(cand)) return cand; // 有当轮数据者优先(离 cwd 最近的)
        firstExisting ??= cand; // 只在找不到有数据的候选时才回退到"仅存在"
      }
    } catch {
      // 存在性检查异常按不存在处理
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return firstExisting;
}

/** 收集 journal 目录下全部 jsonl 行:global.jsonl + sessions/*.jsonl + 旧 gateway.jsonl。 */
export function readJournalLines(journalDir: string): string[] {
  const files: string[] = [];
  for (const name of ["global.jsonl", "gateway.jsonl"]) {
    const p = path.join(journalDir, name);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) files.push(p);
  }
  const sessionsDir = path.join(journalDir, "sessions");
  try {
    if (fs.existsSync(sessionsDir) && fs.statSync(sessionsDir).isDirectory()) {
      for (const name of fs.readdirSync(sessionsDir).sort()) {
        if (name.endsWith(".jsonl")) files.push(path.join(sessionsDir, name));
      }
    }
  } catch {
    // sessions 目录读不了按空处理
  }
  const lines: string[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trim()) lines.push(line);
    }
  }
  return lines;
}

/** CLI 入口:--journal <dir> / --days N(缺省 7)/ --out <file>(缺省 stdout)。返回进程退出码。 */
export function main(argv: string[]): number {
  let journalDir: string | undefined;
  let days = 7;
  let outFile: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? "";
    if (a === "--journal" || a.startsWith("--journal=")) {
      journalDir = a === "--journal" ? argv[++i] : a.slice("--journal=".length);
      if (!journalDir) {
        process.stderr.write("错误:--journal 需要目录参数\n");
        return 1;
      }
    } else if (a === "--days" || a.startsWith("--days=")) {
      const v = a === "--days" ? argv[++i] : a.slice("--days=".length);
      const n = Number(v);
      if (v === undefined || !Number.isFinite(n) || n <= 0) {
        process.stderr.write(`错误:--days 需要正整数,收到 ${String(v)}\n`);
        return 1;
      }
      days = Math.floor(n);
    } else if (a === "--out" || a.startsWith("--out=")) {
      outFile = a === "--out" ? argv[++i] : a.slice("--out=".length);
      if (!outFile) {
        process.stderr.write("错误:--out 需要文件路径参数\n");
        return 1;
      }
    } else {
      process.stderr.write(`错误:未知参数 ${a}\n`);
      return 1;
    }
  }
  if (!journalDir) {
    journalDir = findDefaultJournalDir();
    if (!journalDir) {
      process.stderr.write(
        "错误:未从 cwd 向上(8 级内)找到 .genie/journals;请用 --journal <dir> 显式指定\n",
      );
      return 1;
    }
  }
  if (!fs.existsSync(journalDir)) {
    process.stderr.write(`错误:journal 目录不存在:${journalDir}\n`);
    return 1;
  }
  const lines = readJournalLines(journalDir);
  const cmd = [
    "node",
    "--experimental-strip-types",
    String(process.argv[1] ?? "board-quality-baseline.ts"),
    ...argv,
  ].join(" ");
  const md = aggregateBoardQuality(lines, Date.now(), days, { sourceDir: journalDir, cmd });
  if (outFile) {
    try {
      fs.writeFileSync(outFile, md, "utf8");
    } catch (e) {
      process.stderr.write(`错误:写 ${outFile} 失败:${String(e)}\n`);
      return 1;
    }
  } else {
    process.stdout.write(md);
  }
  return 0;
}

// 直跑入口(vitest import 时 argv[1] 不指向本文件,不触发)
if (process.argv[1]?.endsWith("board-quality-baseline.ts")) {
  process.exit(main(process.argv.slice(2)));
}
