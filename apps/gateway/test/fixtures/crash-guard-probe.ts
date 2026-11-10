/**
 * 子进程夹具:装 process-guards 后抛一个进程级异常,验证「保活 + 响亮记录」。
 * 用法:node --import tsx <本文件>
 * 输出:GUARD:... 行 + 崩溃日志;退出码 0 = 进程未被打死。
 */
import { installCrashGuards } from "../../src/process-guards.js";

const guard = installCrashGuards({ tag: "probe" });
process.nextTick(() => {
  throw new Error("boom-uncaught");
});
// 等一拍:异常在 tick 里抛出,下一轮宏任务仍应活着(guard 已接管 uncaughtException)
setTimeout(() => {
  console.log(`GUARD:alive count=${guard.count()}`);
  process.exit(0);
}, 200);
