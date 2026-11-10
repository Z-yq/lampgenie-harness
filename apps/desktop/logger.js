/**
 * 壳日志(step-136 P1-4):<logsDir>/desktop.log,单文件超 5MB 滚动为 .1~.3 链式。
 * 纯 node 内置模块,无 electron 依赖;每行 `ISO 时间 level msg`。
 */
const { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } = require("node:fs");
const { join } = require("node:path");

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;

function createLogger(dir) {
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, "desktop.log");

  function rotateIfNeeded() {
    try {
      if (!existsSync(logPath) || statSync(logPath).size < MAX_BYTES) return;
      // 链式:删最旧,其余顺移,当前文件转 .1
      const oldest = `${logPath}.${KEEP}`;
      if (existsSync(oldest)) unlinkSync(oldest);
      for (let i = KEEP - 1; i >= 1; i--) {
        const from = `${logPath}.${i}`;
        if (existsSync(from)) renameSync(from, `${logPath}.${i + 1}`);
      }
      renameSync(logPath, `${logPath}.1`);
    } catch {
      // 日志自身故障不得影响启动
    }
  }

  function write(level, args) {
    rotateIfNeeded();
    const msg = args
      .map((a) => {
        if (typeof a === "string") return a;
        if (a instanceof Error) return a.stack || a.message;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" ");
    const line = `${new Date().toISOString()} ${level} ${msg}\n`;
    try {
      appendFileSync(logPath, line, { mode: 0o644 });
    } catch {
      // 同上:磁盘只读/权限问题时静默,stdout 仍有输出
    }
  }

  return {
    logPath,
    info: (...a) => write("INFO", a),
    warn: (...a) => write("WARN", a),
    error: (...a) => write("ERROR", a),
    close: () => {
      /* appendFileSync 无句柄需要释放,保留接口以对称 */
    },
  };
}

module.exports = { createLogger, MAX_BYTES, KEEP };