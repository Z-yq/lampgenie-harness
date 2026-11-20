/**
 * code 驱动夜间管线的子进程入口(P4。
 * 背景:管线直跑在调度 tick 里(重同步 IO:枚举/解析数百会话文件)曾阻塞网关事件循环 ~5min,
 * WS 全超时、面板假死,且第一拍状态未落盘引发第二拍重建周期的竞态。本入口让调度器把管线
 * **spawn 成子进程**执行——事件循环零阻塞;stdout 末行输出机器可读 JSON 供调度器解析。
 * 互斥:调度器可能在一个 worker 还没退时再 spawn 一个。用
 * `<root>/.genie/rsi/nightly/<project>/.worker.lock`(JSON {pid, at})互斥:抢不到锁(被别的
 * 活进程持有)就 emit {ok:true, note:"worker already running"} 退出 0,不重复跑同一 project。
 * 用法:node nightly-worker.mjs --root <dir> --project <id> --date <YYYY-MM-DD> --journal <dir>
 * exit 0=管线 done(含幂等跳过);2=被拒/失败(JSON 带原因)。
 */
import { acquireNightlyLock, reclaimNightly, releaseNightlyLock, runNightly, startNightly } from "./nightly-store.js";

function argOf(name: string): string | undefined {
  const argv = process.argv;
  for (let i = 0; i < argv.length - 1; i += 1) {
    if (argv[i] === name) return argv[i + 1];
  }
  return undefined;
}

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

async function main(): Promise<number> {
  const root = argOf("--root");
  const projectId = argOf("--project");
  const date = argOf("--date");
  const journalDir = argOf("--journal");
  if (root === undefined || projectId === undefined || date === undefined || journalDir === undefined) {
    emit({ ok: false, note: "缺少参数:需要 --root/--project/--date/--journal" });
    return 2;
  }
  const lock = acquireNightlyLock(root, projectId, { pid: process.pid });
  if (!lock.acquired) {
 // 另一个活进程正在跑同一 project:不是失败,静默让路(调度器不需要重试)。
    emit({ ok: true, note: "worker already running", holderPid: lock.holder?.pid ?? null });
    return 0;
  }
  try {
 // 先回收陈旧 run(上次 worker 被杀留下的 pending/running 不会永久挂着)。
    const reclaimed = await reclaimNightly(root, { projectId, date, journalDir });
    if (reclaimed.status === "live") {
      emit({ ok: true, ...(reclaimed.run === null ? {} : { runId: reclaimed.run.runId }), note: `夜间 run 进行中:${reclaimed.note}` });
      return 0;
    }
    const started = await startNightly(root, { date, projectId, journalDir });
    if (started.run === null || started.run.status === "skipped") {
      emit({ ok: false, note: `start 被拒:${started.codes.join(",")}` });
      return 2;
    }
    if (started.run.status === "done") {
      emit({ ok: true, note: "同日已完成且无新会话" });
      return 0;
    }
    const result = await runNightly(root, { runId: started.run.runId, journalDir });
    const doneSteps = result.run.steps.filter((s) => s.status === "done").length;
    const ok = result.run.status === "done";
    emit({
      ok,
      runId: started.run.runId,
      status: result.run.status,
      note: `${result.run.status} steps=${doneSteps}/${result.run.steps.length}${result.run.error === undefined ? "" : ` error=${result.run.error}`}`,
    });
    return ok ? 0 : 2;
  } finally {
    releaseNightlyLock(root, projectId, { pid: process.pid });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    emit({ ok: false, note: `worker 异常:${error instanceof Error ? error.message : String(error)}` });
    process.exit(2);
  });