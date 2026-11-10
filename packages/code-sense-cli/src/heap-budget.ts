/**
 * 索引堆预算自适应(step-086,RC-K2):索引前按仓规模估内存,给 worker/CLI 推荐堆帽或分级告警;
 * 超预算→按 RC-L 公平采样降数(GENIE_SENSE_MAX_FILES,engine 既有机制,本模块只算值/设环境,
 * code-sense 零改动),截断如实登记。
 *
 * 标定(step-085 实测 RSS + 本轮磁盘实测文件数;estMb = 700 基线 + Σ 档系数×文件数):
 *   | 语料 | 文件数 | 实测 RSS | estMb | 误差 |
 *   | poly-redash | 504 | <1024 | ~900 | ✓ |
 *   | poly-owncast(修后) | 808 | 1042 | 821 | -21%(包络下缘) |
 *   | poly-streamlit | 2250 | 1322 | 1600 | +21% |
 *   | cpp-opencv | 4131 | 2653 | 2972 | +12% |
 *   | grafana 全量 | 16715 | 2057 | 2847 | +38% |
 *   | grafana 6000 截断集 | 6000 | 1205(exit 134 @1024) | 1420 | ≥+18%(风险检出 ✓) |
 * 误差包络 -21%~+38%,按 ±40% 消费;字节模型失效实证:owncast 4.5MB 源码吃 1042MB RSS——
 * 内存主驱动是符号/AST 规模(语言档),源码字节数只作报告交叉项。
 */
import { statSync } from "node:fs";
import { getHeapStatistics } from "node:v8";
import { listSourceFilesDetailed, GRAPH_TS_EXT, GRAPH_STRUCT_EXT } from "@lampgenie/code-sense/callgraph/engine";

/** 每文件内存系数(MB/文件,按语言档;五点标定见模块头)。 */
export const MB_PER_FILE = {
  ts: 0.15, // .ts/.tsx/.js/.jsx/.mjs/.cjs(ts-morph 语义档)
  go: 0.1,
  java: 0.25,
  py: 0.4,
  cpp: 0.55, // .c/.cc/.cpp/.cxx/.h/.hh/.hpp/.hxx(tree-sitter 结构档,头文件大户)
} as const;

/** 进程基线(Node+ts-morph+web-tree-sitter 装载后的 RSS 地板;grafana/opencv 双向校准)。 */
export const BASELINE_MB = 700;
/** 估算误差包络(相对五点标定,如实标注)。 */
export const ESTIMATE_ENVELOPE = 0.4;
/** 每语言档大小采样数(均匀取样的 stat 次数上限/档;防 drvfs 全量 stat 慢盘)。 */
const SAMPLE_PER_CLASS = 150;
/** 降数下限:采样低于此值覆盖意义归零,宁可如实告警不再降。 */
export const MIN_SCAN_LIMIT = 300;

export type ExtClass = keyof typeof MB_PER_FILE;

export function extClassOf(file: string): ExtClass {
  const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
  if (ext === ".go") return "go";
  if (ext === ".java") return "java";
  if (ext === ".py") return "py";
  if (GRAPH_STRUCT_EXT.has(ext)) return "cpp"; // 结构档余下= C/C++ 族 + Rust/C#/Ruby/PHP(tree-sitter 结构档,保守取 cpp 系数)
  if (GRAPH_TS_EXT.has(ext)) return "ts";
  return "ts"; // 引擎扫描面(GRAPH_SOURCE_EXT)之外不出现;防御归 ts 档
}

export interface HeapEstimate {
  root: string;
  /** 引擎扫描面文件数(受 GENIE_SENSE_MAX_FILES 上限影响;totalSeen=磁盘实见)。 */
  files: number;
  totalSeen?: number;
  scanLimit: number;
  scanTruncated: boolean;
  byClass: Record<ExtClass, number>;
  /** 采样统计:文件数×平均大小(源码字节交叉项;仅报告,不进估算)。 */
  sampledFiles: number;
  sourceMbEstimate: number;
  /** 内存估算(MB)= 基线 + Σ 系数×文件数;±40% 包络。 */
  estMb: number;
  /** 本进程实际堆帽(MB,v8 heap_size_limit)。 */
  processHeapMb: number;
  /** 生效预算(MB)= GENIE_SENSE_HEAP_MB 显式 或 进程堆帽×0.8(GC 余量)。 */
  budgetMb: number;
  tier: "ok" | "warn" | "risk";
  /** 建议 worker 堆帽(MB)= clamp(est×1.35, 1024, 4096) 取 256 整;risk/显式帽时给出。 */
  recommendedHeapMb: number;
  /** 超预算时的降数建议(≤scanLimit;undefined=无需降)。 */
  reducedMaxFiles?: number;
  /** 降数后仍超预算(仓太大,已到底线)→ 如实告警标记。 */
  overBudgetAfterReduce?: boolean;
  notes: string[];
}

/** 本进程堆帽(MB,v8 heap_size_limit);异常退化 2048(Node 20 x64 缺省档)。 */
function processHeapLimitMb(): number {
  try {
    return Math.round(getHeapStatistics().heap_size_limit / 1048576);
  } catch {
    return 2048;
  }
}

export function explicitHeapMb(): number | null {
  const n = Number.parseInt(process.env.GENIE_SENSE_HEAP_MB ?? "", 10);
  return Number.isFinite(n) && n >= 256 ? n : null;
}

/** 均匀采样 stat(每档 ≤SAMPLE_PER_CLASS):avg bytes/文件。 */
function sampleBytes(files: string[]): { sampled: number; totalBytes: number } {
  if (files.length === 0) return { sampled: 0, totalBytes: 0 };
  const step = Math.max(1, Math.floor(files.length / SAMPLE_PER_CLASS));
  let sampled = 0;
  let totalBytes = 0;
  for (let i = 0; i < files.length; i += step) {
    try {
      const st = statSync(files[i]!);
      if (st.isFile()) {
        sampled++;
        totalBytes += st.size;
      }
    } catch {
      /* 扫描间隙消失:跳过 */
    }
  }
  return { sampled, totalBytes };
}

/** 估算索引内存并定级;不落地任何状态(纯读+可选环境写入由 applyBudgetReduce 负责)。 */
export async function estimateIndexMemory(root: string): Promise<HeapEstimate> {
  const scanLimit = maxFilesEnv();
  const scan = await listSourceFilesDetailed(root, scanLimit);
  const byClass: Record<ExtClass, number> = { ts: 0, go: 0, java: 0, py: 0, cpp: 0 };
  const byClassFiles: Record<ExtClass, string[]> = { ts: [], go: [], java: [], py: [], cpp: [] };
  for (const f of scan.files) {
    const c = extClassOf(f);
    byClass[c]++;
    byClassFiles[c].push(f);
  }
  let sampledFiles = 0;
  let totalBytes = 0;
  for (const c of Object.keys(byClassFiles) as ExtClass[]) {
    const s = sampleBytes(byClassFiles[c]!);
    sampledFiles += s.sampled;
    totalBytes += s.totalBytes;
  }
  let est = BASELINE_MB;
  for (const c of Object.keys(byClass) as ExtClass[]) est += MB_PER_FILE[c] * byClass[c]!;
  est = Math.round(est);
  const sourceMbEstimate = Math.round(((totalBytes / Math.max(1, sampledFiles)) * scan.files.length) / 1048576);

  const processHeapMb = processHeapLimitMb();
  const explicit = explicitHeapMb();
  const budgetMb = explicit ?? Math.round(processHeapMb * 0.8);
  // 2026-11-08(7700 审计):文件数模型对上千文件的 ts 仓会低估——lampgenie-harness 1439 文件
  // 估算 916MB,实测构建峰值 RSS 2.6GB(默认 2GB 堆直接 OOM)。大仓给堆帽下限 4096MB
  // (V8 堆帽是上限不是预占,不浪费常驻内存);risk/降数判定仍按 est,不受本下限影响。
  const largeRepoFloorMb = scan.files.length >= 800 ? 4096 : 0;
  const recommendedHeapMb = Math.max(largeRepoFloorMb, Math.min(4096, Math.max(1024, Math.ceil((est * 1.35) / 256) * 256)));

  const notes: string[] = [];
  if (largeRepoFloorMb > 0) {
    notes.push(`大仓堆帽下限 ${largeRepoFloorMb}MB(源文件数 ${scan.files.length}≥800;文件数估算 ${est}MB 对大仓会低估,7700 实测 1439 ts 文件峰值 2.6GB)`);
  }
  let reducedMaxFiles: number | undefined;
  let overBudgetAfterReduce: boolean | undefined;

  let tier: HeapEstimate["tier"] = "ok";
  if (est > budgetMb) {
    tier = "risk";
    // 降数解:est(limit) ≈ BASELINE + Σ coef×count×(limit/files) → limit = (budget-BASELINE)/blendedPerFile
    const blended = (est - BASELINE_MB) / Math.max(1, scan.files.length);
    const fit = Math.floor((budgetMb - BASELINE_MB) / Math.max(0.01, blended));
    reducedMaxFiles = Math.max(MIN_SCAN_LIMIT, Math.min(scanLimit, fit));
    if (BASELINE_MB + blended * reducedMaxFiles > budgetMb) {
      overBudgetAfterReduce = true;
      notes.push(`仓过大:采样降到下限 ${MIN_SCAN_LIMIT} 仍估算 ${Math.round(BASELINE_MB + blended * reducedMaxFiles)}MB > 预算 ${budgetMb}MB,如实告警(可能 OOM 或进一步截断)`);
    }
    notes.push(`估算 ${est}MB 超预算 ${budgetMb}MB(±40% 包络)——建议堆帽 ${recommendedHeapMb}MB(NODE_OPTIONS=--max-old-space-size=${recommendedHeapMb})或按公平采样降数 ${reducedMaxFiles}`);
  } else if (est > budgetMb * 0.75) {
    tier = "warn";
    notes.push(`估算 ${est}MB 贴预算线 ${budgetMb}MB(±40% 包络)——建议显式堆帽 NODE_OPTIONS=--max-old-space-size=${recommendedHeapMb}`);
  }

  return {
    root,
    files: scan.files.length,
    ...(scan.totalSeen !== undefined ? { totalSeen: scan.totalSeen } : {}),
    scanLimit,
    scanTruncated: scan.truncated,
    byClass,
    sampledFiles,
    sourceMbEstimate,
    estMb: est,
    processHeapMb,
    budgetMb,
    tier,
    recommendedHeapMb,
    ...(reducedMaxFiles !== undefined ? { reducedMaxFiles } : {}),
    ...(overBudgetAfterReduce !== undefined ? { overBudgetAfterReduce } : {}),
    notes,
  };
}

function maxFilesEnv(): number {
  const n = Number.parseInt(process.env.GENIE_SENSE_MAX_FILES ?? "", 10);
  return Number.isFinite(n) && n >= 10 ? n : 6000;
}

/**
 * 预算落地(risk 档):设 GENIE_SENSE_MAX_FILES 让引擎走 RC-L 公平采样。
 * 返回实际写入值(null=未降)。环境写入是本模块唯一副作用;调用方负责在构建进程内调用
 * (gateway 侧传给 fork env,不污染父进程)。
 */
export function applyBudgetReduce(est: HeapEstimate): number | null {
  if (est.tier !== "risk" || est.reducedMaxFiles === undefined) return null;
  process.env.GENIE_SENSE_MAX_FILES = String(est.reducedMaxFiles);
  return est.reducedMaxFiles;
}

/** fork env 降数(不改本进程):返回要合并进子进程 env 的键值(null=无需)。 */
export function budgetReduceEnv(est: HeapEstimate): Record<string, string> | null {
  if (est.tier !== "risk" || est.reducedMaxFiles === undefined) return null;
  return { GENIE_SENSE_MAX_FILES: String(est.reducedMaxFiles) };
}
