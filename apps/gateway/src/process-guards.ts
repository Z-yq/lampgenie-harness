/**
 * 进程级崩溃保活(2026-10-28,web_search 打崩 session-worker 事故产物)。
 *
 * 背景:会话 worker 里一个第三方库/内置工具漏出的同步链路让一条 socket 的 'error'
 * 无人监听,Node 把它抬成 uncaughtException;worker 只挂了 unhandledRejection,
 * 于是整个 worker code=1 退出——同一 worker 下的主 agent 与所有在跑子代理一起被收尸
 * (用户视角=任务莫名失败)。gateway 主进程早就有这层保活(main.ts),worker 一直是缺口。
 *
 * 纪律:保活 ≠ 吞错。异常一律响亮打到 stderr(→日志文件),含 tag + 堆栈首段,
 * 业务错误仍在各自连接/工具返回里 fail-visible;进程不静默死,也不假装没事。
 */

/** 打印用的错误摘要:Error 取 stack 首段,其它值 String 截断。 */
function describeCrash(err: unknown, limit = 600): string {
  if (err instanceof Error) {
    const text = err.stack || err.message || err.name;
    return text.slice(0, limit);
  }
  return String(err).slice(0, limit);
}

export interface CrashGuardOptions {
  /** 日志前缀,如 "session-worker" → `[session-worker] uncaughtException 保活:…` */
  tag: string;
  /** 自定义写日志(默认 console.error);测试用它接管输出。 */
  log?: (line: string) => void;
}

export interface CrashGuardHandle {
  /** 卸掉本 guard 装的监听(测试收尾用;生产不卸)。 */
  dispose: () => void;
  /** 至今捕获到的崩溃次数(含 uncaughtException 与 unhandledRejection)。 */
  readonly count: () => number;
}

/**
 * 安装 uncaughtException + unhandledRejection 保活监听。
 * 语义参考 main.ts:记录后继续运行,不 exit——本地服务/会话可用性优先。
 */
export function installCrashGuards(options: CrashGuardOptions): CrashGuardHandle {
  const log = options.log ?? ((line: string) => { console.error(line); });
  const tag = options.tag;
  let count = 0;
  const onUncaught = (err: unknown): void => {
    count += 1;
    log(`[${tag}] uncaughtException 保活(pid=${process.pid}): ${describeCrash(err)}`);
  };
  const onRejection = (reason: unknown): void => {
    count += 1;
    log(`[${tag}] unhandledRejection 保活(pid=${process.pid}): ${describeCrash(reason, 400)}`);
  };
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onRejection);
  return {
    count: () => count,
    dispose: () => {
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onRejection);
    },
  };
}
