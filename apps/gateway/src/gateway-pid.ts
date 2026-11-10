/**
 * 网关 pid 文件( 7700 稳定性批)。
 * 语义:`.genie/gateway.pid` 只表示「当前**正在服务**的网关进程」——由网关在 listen/装配完成
 * 后自行写入(此前写点在外部的重启脚本里,重启不经过脚本就永远是旧 pid,外部门禁/排障会误杀)。
 * 退出时仅当内容仍是自己的 pid 才删除(避免把继任者的 pid 文件误删)。
 * 写盘用 tmp+rename:读方(面板/守护/安全重启器)永远不会读到半截数字。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** pid 文件路径(仓根下的 .genie;与 journal/watchdog 同数据根)。 */
export function gatewayPidPath(root: string): string {
  return join(root, ".genie", "gateway.pid");
}

/** 读 pid;内容不是正整数(损坏/空)时 undefined。 */
export function readGatewayPid(path: string): number | undefined {
  try {
    const n = Number(readFileSync(path, "utf-8").trim());
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** 写 pid(原子替换);失败返回 false(只读盘不阻断网关主流程)。 */
export function writeGatewayPid(path: string, pid = process.pid): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${pid}.tmp`;
    writeFileSync(tmp, String(pid), "utf-8");
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** 退出清理:仅当文件内容仍是自己的 pid 才删。返回是否删除。 */
export function clearGatewayPid(path: string, pid = process.pid): boolean {
  if (!existsSync(path)) return false;
  if (readGatewayPid(path) !== pid) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

export interface ExitLogInput {
  /** 退出来源:signal=收到信号;exit=代码路径退出(含 process.exit/事件循环结束)。 */
  reason: "signal" | "exit";
  /** 仅 reason=signal:信号名(SIGTERM/SIGINT/SIGHUP)。 */
  signal?: string;
  /** 仅 reason=exit:进程退出码。 */
  code?: number;
  pid?: number;
  ppid?: number;
  uptimeMs?: number;
  /** 活跃任务数(running/queued/blocked);-1=网关装配中/取不到。 */
  activeTasks?: number;
  /** 分布摘要(如 running:1,queued:2)。 */
  taskStates?: string;
  /** 启动来源环境标记(watchdog/safe-restart/desktop;缺省不带)。 */
  startedBy?: string;
}

/**
 * 退出日志单行(落 stdout/stderr→日志文件,便于 grep `[gateway] exit`)。
 * 例:`[gateway] exit reason=signal signal=SIGTERM pid=1 ppid=1 uptimeMs=1200 activeTasks=0 startedBy=watchdog`
 */
export function formatExitLog(input: ExitLogInput): string {
  const parts = [`[gateway] exit reason=${input.reason}`];
  if (input.signal) parts.push(`signal=${input.signal}`);
  if (input.code !== undefined) parts.push(`code=${input.code}`);
  parts.push(`pid=${input.pid ?? process.pid}`);
  parts.push(`ppid=${input.ppid ?? process.ppid}`);
  if (input.uptimeMs !== undefined) parts.push(`uptimeMs=${Math.max(0, Math.round(input.uptimeMs))}`);
  parts.push(`activeTasks=${input.activeTasks === undefined || input.activeTasks < 0 ? "?" : input.activeTasks}`);
  if (input.taskStates) parts.push(`taskStates=${input.taskStates}`);
  if (input.startedBy) parts.push(`startedBy=${input.startedBy}`);
  return parts.join(" ");
}
