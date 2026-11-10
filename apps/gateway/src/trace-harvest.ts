/**
 * 轨迹收割(生产消费端,M201,2026-11-09):把 journal 的原始事件按会话切成批次,脱敏后落盘,
 * 并用**账本 ledger** 保证重跑幂等。契约与映射逻辑在
 * `packages/harness-runtime/src/agent/trace-contract.ts`(纯逻辑),本文件只做 IO 与水位管理。
 *
 * 数据面:
 * - `<outDir>/batches/<batchKey>.jsonl` —— 一行一条轨迹事件(已脱敏)。
 * - `<outDir>/ledger.json` —— {version, ruleVersion, batches:{[batchKey]:{sessionId,seqStart,
 *   seqEnd,at,events,dropped,ruleVersion}}};原子写(tmp + rename)。
 *
 * 幂等语义:
 * - 账本已有该 batchKey → `skippedBatches++` 且**不重写批次文件**(文件内容由 key 决定)。
 * - 会话水位 = 该会话所有账本批次的 max(seqEnd);`readSession(sid, sinceSeq)` 的 sinceSeq 是
 *   **inclusive**(core: `e.seq >= sinceSeq`),故续读传 `seqEnd + 1`。
 * - 为使「重跑」能被账本命中(而不是读到空窗口),每会话从**最后一个已入账批次的 seqStart**
 *   起读:窗口未变则 batchKey 相同 → 跳过;有新事件则本轮窗口变大 → 产新批,再前进。
 *
 * 旁路纪律:单会话读取/落盘失败只进 `failedSessions`(不 throw 到调用方);参数级错误才抛。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  TraceBatch,
  TraceBatchKeyInput,
  TraceCoverage,
  TraceExtractOptions,
} from "@lampgenie/runtime/agent/trace-contract";

/** 契约模块面(惰性解析,见 loadContract)。 */
interface TraceContractModule {
  readonly TRACE_CONTRACT_VERSION: number;
  extractTraceBatch(rawEvents: readonly unknown[], opts: TraceExtractOptions): TraceBatch;
  traceBatchKey(input: TraceBatchKeyInput): string;
}

let contractModule: Promise<TraceContractModule> | undefined;

/**
 * 惰性解析契约模块。
 * - vitest / 带 `--conditions=development` 的运行时:走包导出的 src 入口(正常路径)。
 * - 裸 node / tsx(CLI 场景无 development 条件,dist 未必含新文件):回退到仓内源文件。
 * 两条路指向同一份 trace-contract.ts,语义一致。
 */
async function loadContract(): Promise<TraceContractModule> {
  contractModule ??= (async () => {
    const spec = "@lampgenie/runtime/agent/trace-contract";
    try {
      return (await import(spec)) as TraceContractModule;
    } catch {
      const srcUrl = new URL(
        "../../../packages/harness-runtime/src/agent/trace-contract.ts",
        import.meta.url,
      ).href;
      return (await import(srcUrl)) as TraceContractModule;
    }
  })();
  return contractModule;
}

/** 收割只需 journal 的两个读面(测试注入假 journal;FileJournal 天然满足)。 */
export interface HarvestJournal {
  readSession(sessionId: string, sinceSeq?: number): readonly unknown[];
  readAll?(sinceSeq?: number): readonly unknown[];
}

export interface HarvestOptions {
  journal: HarvestJournal;
  /** 仓根(outDir 缺省 = <root>/.genie/trace-harvest)。 */
  root: string;
  /** 限定会话;缺省从 journal 全量事件里推 distinct sessionId(需 journal.readAll)。 */
  sessions?: readonly string[];
  outDir?: string;
  /** 只读:不写批次文件、不写账本(仍按磁盘账本判 skіpped)。 */
  dryRun?: boolean;
  /** 抽取规则版本(进批次键);缺省 "r1"。 */
  ruleVersion?: string;
  /** 单会话单批上限;超限截断并标 windowTruncated,循环继续读到末尾。 */
  maxEventsPerSession?: number;
  /** 时间源(测试注入;缺省 Date.now)。 */
  now?: () => number;
}

export interface HarvestSessionFailure {
  sessionId: string;
  error: string;
}

export interface HarvestBatchRecord {
  batchKey: string;
  sessionId: string;
  seqStart: number;
  seqEnd: number;
  events: number;
  dropped: number;
  skipped: boolean;
  file?: string;
}

export interface HarvestReport {
  version: number;
  ruleVersion: string;
  outDir: string;
  dryRun: boolean;
  /** 本轮处理的会话数(含失败)。 */
  sessions: number;
  /** 本轮新写入批次数。 */
  batches: number;
  /** 账本命中而跳过的批次数。 */
  skippedBatches: number;
  /** 本轮新写入的轨迹事件数。 */
  events: number;
  /** 被跳过批次的轨迹事件数(账本记录值,仅报告用)。 */
  skippedEvents: number;
  duplicateSeqs: number;
  /** 本轮所有已抽取批次的丢弃字段总数。 */
  dropped: number;
  /** 本轮所有已抽取批次的覆盖率聚合(含被跳过的批次,如实反映「这一轮看了什么」)。 */
  coverage: TraceCoverage;
  /** 因 maxEventsPerSession 截断的批次数。 */
  windowTruncated: number;
  failedSessions: HarvestSessionFailure[];
  batchesDetail: HarvestBatchRecord[];
  /** 账本解析失败/版本不一致而重建(旧批次文件仍在,键不同故不复用)。 */
  ledgerReset?: boolean;
}

interface LedgerBatch {
  sessionId: string;
  seqStart: number;
  seqEnd: number;
  at: number;
  events: number;
  dropped: number;
  ruleVersion?: string;
}

interface TraceLedger {
  version: number;
  ruleVersion: string;
  batches: Record<string, LedgerBatch>;
}

const LEDGER_FILE = "ledger.json";
const BATCH_DIR = "batches";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? "unknown");
}

/** seq 必须是有限数字,否则视为缺失(畸形行不该把水位带到 NaN)。 */
function seqOf(raw: unknown): number | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const seq = (raw as { seq?: unknown }).seq;
  return typeof seq === "number" && Number.isFinite(seq) ? seq : undefined;
}

function emptyCoverage(): TraceCoverage {
  return { inputEvents: 0, duplicateSeqs: 0, mappedEvents: 0, unmappedByKind: {}, coverageRate: 0 };
}

function addCoverage(into: TraceCoverage, add: TraceCoverage): void {
  into.inputEvents += add.inputEvents;
  into.duplicateSeqs += add.duplicateSeqs;
  into.mappedEvents += add.mappedEvents;
  for (const [kind, n] of Object.entries(add.unmappedByKind)) {
    into.unmappedByKind[kind] = (into.unmappedByKind[kind] ?? 0) + n;
  }
  const denom = into.inputEvents - into.duplicateSeqs;
  into.coverageRate = denom > 0 ? into.mappedEvents / denom : 0;
}

/** 原子写文本:同目录 tmp + rename(账本被并发读者半读到是更坏的结果)。 */
async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, path);
}

async function readLedger(path: string, contractVersion: number, ruleVersion: string): Promise<{ ledger: TraceLedger; reset: boolean }> {
  const fresh = (): TraceLedger => ({ version: contractVersion, ruleVersion, batches: {} });
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch {
    return { ledger: fresh(), reset: false }; // 首次运行:没有账本是常态
  }
  try {
    const parsed = JSON.parse(text) as Partial<TraceLedger>;
    const batches = parsed.batches && typeof parsed.batches === "object" ? parsed.batches : {};
    if (parsed.version !== contractVersion) {
      // 契约升版:旧账本键由旧版本生成,不可能命中;重建账本(旧批次文件保留可追溯)。
      return { ledger: { version: contractVersion, ruleVersion, batches: {} }, reset: true };
    }
    return {
      ledger: { version: contractVersion, ruleVersion: parsed.ruleVersion ?? ruleVersion, batches },
      reset: false,
    };
  } catch {
    return { ledger: fresh(), reset: true };
  }
}

/** 会话续读起点:最后一个已入账批次的 seqStart(窗口未变 → 同键跳过)。 */
function resumeSeqOf(ledger: TraceLedger, sessionId: string): number {
  let resume = 0;
  let bestEnd = -1;
  for (const batch of Object.values(ledger.batches)) {
    if (batch.sessionId !== sessionId) continue;
    if (batch.seqEnd > bestEnd) {
      bestEnd = batch.seqEnd;
      resume = batch.seqStart;
    }
  }
  return resume;
}

function sessionIdsOf(journal: HarvestJournal): string[] {
  if (typeof journal.readAll !== "function") return [];
  const ids = new Set<string>();
  for (const raw of journal.readAll()) {
    if (raw === null || typeof raw !== "object") continue;
    const sid = (raw as { sessionId?: unknown }).sessionId;
    if (typeof sid === "string" && sid) ids.add(sid);
  }
  return [...ids].sort();
}

/**
 * 收割轨迹。**不抛主链**(参数级错误除外):单会话失败进 failedSessions。
 */
export async function harvestTraces(opts: HarvestOptions): Promise<HarvestReport> {
  if (!opts || !opts.journal || typeof opts.journal.readSession !== "function") {
    throw new TypeError("harvestTraces: journal.readSession 缺失");
  }
  if (!opts.root) throw new TypeError("harvestTraces: root 必填");
  const contract = await loadContract();
  const contractVersion = contract.TRACE_CONTRACT_VERSION;
  const ruleVersion = opts.ruleVersion ?? "r1";
  const outDir = opts.outDir ?? join(opts.root, ".genie", "trace-harvest");
  const dryRun = opts.dryRun === true;
  const now = opts.now ?? (() => Date.now());
  const maxEvents =
    typeof opts.maxEventsPerSession === "number" && opts.maxEventsPerSession > 0
      ? Math.floor(opts.maxEventsPerSession)
      : undefined;

  const sessions = opts.sessions?.length ? [...new Set(opts.sessions)] : sessionIdsOf(opts.journal);

  const ledgerPath = join(outDir, LEDGER_FILE);
  const { ledger, reset } = await readLedger(ledgerPath, contractVersion, ruleVersion);

  const report: HarvestReport = {
    version: contractVersion,
    ruleVersion,
    outDir,
    dryRun,
    sessions: 0,
    batches: 0,
    skippedBatches: 0,
    events: 0,
    skippedEvents: 0,
    duplicateSeqs: 0,
    dropped: 0,
    coverage: emptyCoverage(),
    windowTruncated: 0,
    failedSessions: [],
    batchesDetail: [],
    ...(reset ? { ledgerReset: true } : {}),
  };
  if (reset) {
    // 重建账本时不保留旧批记录:它们由旧版本键生成,不能用来判重。
    ledger.batches = {};
  }

  for (const sessionId of sessions) {
    report.sessions += 1;
    let from = resumeSeqOf(ledger, sessionId);
    // 已入账窗口(seqStart → seqEnd):读窗口在该边界处截断,批与批不重叠
    // (否则新增事件后重算的大窗口会把旧批事件再收一遍,跨批聚合就会重复计数)。
    const knownWindows = new Map<number, number>();
    for (const b of Object.values(ledger.batches)) {
      if (b.sessionId === sessionId) knownWindows.set(b.seqStart, b.seqEnd);
    }
    // 防呆:正常情况下每轮至少推进一个批次(截断循环),上限兜底避免病态数据死循环。
    for (let guard = 0; guard < 512; guard++) {
      let raw: readonly unknown[];
      try {
        raw = opts.journal.readSession(sessionId, from);
      } catch (e) {
        report.failedSessions.push({ sessionId, error: errText(e) });
        break;
      }
      if (!raw || raw.length === 0) break;

      const cap = knownWindows.get(from);
      const bounded =
        cap === undefined
          ? raw
          : raw.filter((e) => {
              const s = seqOf(e);
              return s === undefined || s <= cap;
            });
      if (bounded.length === 0) break;

      const truncated = maxEvents !== undefined && bounded.length > maxEvents;
      const slice = truncated ? bounded.slice(0, maxEvents) : bounded;
      if (truncated) report.windowTruncated += 1;

      const seqs = slice.map(seqOf).filter((s): s is number => s !== undefined);
      const seqStart = seqs.length ? Math.min(...seqs) : from;
      const seqEnd = seqs.length ? Math.max(...seqs) : from;

      let batch: TraceBatch;
      try {
        batch = contract.extractTraceBatch(slice, { ruleVersion, sessionId, seqStart, seqEnd });
      } catch (e) {
        report.failedSessions.push({ sessionId, error: errText(e) });
        break;
      }
      addCoverage(report.coverage, batch.coverage);
      report.duplicateSeqs += batch.coverage.duplicateSeqs;
      report.dropped += batch.dropped.count;

      const known = ledger.batches[batch.batchKey];
      if (known) {
        report.skippedBatches += 1;
        report.skippedEvents += known.events;
        report.batchesDetail.push({
          batchKey: batch.batchKey,
          sessionId,
          seqStart: known.seqStart,
          seqEnd: known.seqEnd,
          events: known.events,
          dropped: known.dropped,
          skipped: true,
        });
      } else {
        const file = join(outDir, BATCH_DIR, `${batch.batchKey}.jsonl`);
        if (!dryRun) {
          try {
            await mkdir(join(outDir, BATCH_DIR), { recursive: true });
            // "wx":文件已存在(账本被删/手改)时保留原文件——批次内容由 key 唯一决定。
            const body = batch.events.map((ev) => JSON.stringify(ev)).join("\n") + (batch.events.length ? "\n" : "");
            try {
              await writeFile(file, body, { encoding: "utf-8", flag: "wx" });
            } catch (e) {
              const code = (e as { code?: string }).code;
              if (code !== "EEXIST") throw e;
            }
          } catch (e) {
            report.failedSessions.push({ sessionId, error: `write-batch: ${errText(e)}` });
            break;
          }
        }
        ledger.batches[batch.batchKey] = {
          sessionId,
          seqStart,
          seqEnd,
          at: now(),
          events: batch.events.length,
          dropped: batch.dropped.count,
          ruleVersion,
        };
        report.batches += 1;
        report.events += batch.events.length;
        report.batchesDetail.push({
          batchKey: batch.batchKey,
          sessionId,
          seqStart,
          seqEnd,
          events: batch.events.length,
          dropped: batch.dropped.count,
          skipped: false,
          ...(dryRun ? {} : { file }),
        });
      }

      // 水位推进(readSession 的 sinceSeq 是 inclusive,故 +1)。
      const next = Number.isFinite(seqEnd) ? seqEnd + 1 : from + 1;
      if (next <= from) break; // 没有可用的 seq:不猜,交给下次全量
      from = next;
      // 未被 maxEvents 截断、也不是在已入账窗口边界处停下 → 已读到会话末尾。
      if (!truncated && cap === undefined) break;
    }
  }

  if (!dryRun && report.batches > 0) {
    try {
      await mkdir(outDir, { recursive: true });
      await writeAtomic(
        ledgerPath,
        JSON.stringify({ version: ledger.version, ruleVersion, batches: ledger.batches }, null, 2) + "\n",
      );
    } catch (e) {
      // 账本写失败:批次文件已在盘上,但本轮不可声称入账——如实记进失败面。
      report.failedSessions.push({ sessionId: "<ledger>", error: `write-ledger: ${errText(e)}` });
    }
  }

  return report;
}
