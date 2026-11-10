/** 索引构建 worker(fork 入口):ts-morph 全图解析跑在独立进程,主进程事件循环不受阻。 */
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { buildC2fIndex, saveIndex, indexDir } from "@lampgenie/code-sense";

// Emscripten(web-tree-sitter)wasm 装载失败会以**独立的 unhandled rejection**逃逸——
// loadTsParser 的 try/catch 接不到(Node 对 unhandled rejection 默认策略=杀进程)。
// 注意:bundle 形态下 wasm 相对定位落空(dist/ 无 tree-sitter.wasm),Python 仓
// 构建即崩、全部语言陪葬。worker 契约=「建索引,失败退出码 1」:可选增强(tree-sitter 补盲)
// 失败必须回退纯文本形态,不允许炸掉整个构建。
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[sense-index-worker] unhandledRejection(不中断构建): ${String(reason).slice(0, 300)}\n`);
});

// ---- 父生命周期绑定(根治孤儿 worker) ----
// 事故基线: 经验证 3 个孤儿 worker 并发重复索引同一仓根,各 ~1.3GB——父 gateway 被
// kill 后 fork 出的 worker 独立存活跑完整场构建(ts-morph 全仓 101s 级)。
// 机制:①fork IPC 断开('disconnect',覆盖父正常退出与 kill -9);②看门狗周期核对初始 ppid
// (覆盖 IPC 异常形态;父死后 worker 被 init 收养,process.ppid 变化是最硬信号)。
// 任一触发 → 立即自退(检测粒度=看门狗周期 2s),不再白烧内存。
const EXIT_PARENT_LOST = 3;
const parentPid = process.ppid;
const parentPollMs = 2_000;
let parentGone = false;

function onParentGone(why: string): void {
  if (parentGone) return;
  parentGone = true;
  process.stderr.write(`[sense-index-worker] 父进程丢失(${why}),自退防孤儿\n`);
  cleanWorkerPid();
  process.exit(EXIT_PARENT_LOST);
}
process.on("disconnect", () => onParentGone("IPC 断开(disconnect)"));
const parentWatch = setInterval(() => {
  if (process.ppid !== parentPid) return onParentGone(`ppid 变更 ${parentPid}→${process.ppid}(父已死,被收养)`);
  try {
    process.kill(parentPid, 0);
  } catch {
    onParentGone(`kill(${parentPid},0) 失败(父不存在)`);
  }
}, parentPollMs);
parentWatch.unref?.();

// ---- worker.pid 自登记(sweep/锁礼让的孤儿判定源;干净退出自删,被 kill 留给 sweep 清) ----
const root = process.argv[2];

/** /proc/<pid>/stat 字段 22(starttime,与 build-lock 的 pid+starttime 双校验同口径)。 */
function readOwnStartTime(): string | null {
  try {
    const stat = readFileSync(`/proc/${process.pid}/stat`, "utf-8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trim().split(" ");
    return afterComm[19]?.trim() ?? null;
  } catch {
    return null; // 非 Linux:pid-only 判定档
  }
}

function workerPidFile(): string {
  return indexDir(root!) + "/worker.pid";
}

function writeWorkerPid(): void {
  if (!root) return;
  try {
    mkdirSync(indexDir(root), { recursive: true });
    const tmp = workerPidFile() + "." + randomUUID() + ".tmp";
    writeFileSync(tmp, JSON.stringify({ pid: process.pid, startTime: readOwnStartTime(), startedAt: new Date().toISOString() }));
    renameSync(tmp, workerPidFile());
  } catch {
    /* 登记失败不拦构建(防御层) */
  }
}

function cleanWorkerPid(): void {
  if (!root) return;
  try {
    unlinkSync(workerPidFile());
  } catch {
    /* 已删/未登记 */
  }
}

if (!root) { process.exit(2); }
writeWorkerPid();
buildC2fIndex(root)
  .then((idx) => { saveIndex(root, idx); cleanWorkerPid(); process.exit(0); })
  .catch(() => { cleanWorkerPid(); process.exit(1); });
