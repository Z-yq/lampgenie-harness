/**
 * 进程级 env 互斥:vitest threads pool 的 worker 线程共享 process.env 但
 * 不共享模块状态(globalThis 每线程独立,内存锁无效)——并行文件各自 set/delete
 * GENIE_PERMISSION_RULES 等进程级开关会互相拆台(注意:background-subagent-e2e 与
 * plan-gate 并行时 afterEach 删掉对方正依赖的 rules → 间歇假红)。
 * 用文件锁(O_EXCL 原子创建,跨线程/进程可见):动 env 的测试文件 beforeAll 抢锁、
 * afterAll 归还,同批并行文件在这类测试上退化为串行。
 * 容错:抢锁 240s 超时=降级直跑(恢复旧行为,宁可偶发假红不卡死);锁文件 mtime 超
 * 10 分钟视为崩溃残留,直接接管清理。
 */
import { openSync, closeSync, unlinkSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOCK_PATH = join(tmpdir(), "genie-gateway-test-env.lock");
const STALE_MS = 10 * 60_000;

function tryCreate(name: string): boolean {
  try {
    const fd = openSync(LOCK_PATH, "wx");
    closeSync(fd);
    try { writeFileSync(LOCK_PATH, name, "utf-8"); } catch { /* 持有者标记写失败不影响互斥 */ }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") return true; // 非占用类错误=降级直跑
    try {
      if (Date.now() - statSync(LOCK_PATH).mtimeMs > STALE_MS) {
        unlinkSync(LOCK_PATH);
        return tryCreate(name); // 接管陈旧锁(一次重试足够)
      }
    } catch { /* stat 失败按占用处理 */ }
    return false;
  }
}

export async function acquireEnvLock(name: string): Promise<void> {
  const deadline = Date.now() + 240_000;
  while (!tryCreate(name)) {
    if (Date.now() > deadline) return; // 超时降级:直跑(旧行为)
    await new Promise((r) => setTimeout(r, 150));
  }
}

export function releaseEnvLock(_name: string): void {
  try { unlinkSync(LOCK_PATH); } catch { /* 已被清理(接管路径)=无害 */ }
}
