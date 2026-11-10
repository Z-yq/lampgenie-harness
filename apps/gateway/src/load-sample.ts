/**
 * 本机负载采样(节点 Fleet「真实负载」):
 * 旧路径 gateway 本机心跳与 node-agent 心跳都硬编码 {cpu:0,mem:0,runningTasks:0}——面板渲染的
 * 负载是恒零占位。本函数给两边同一口径:cpu=1 分钟负载均值/核数(0..1),mem=1-可用/总量(0..1),
 * runningTasks 由调用方传(gateway=运行中任务数;node-agent=委派执行并发数)。
 */
import os from "node:os";

export function sampleLoad(runningTasks = 0): { cpu: number; mem: number; runningTasks: number } {
  const cpus = os.cpus().length || 1;
  const cpu = Math.max(0, Math.min(1, (os.loadavg()[0] ?? 0) / cpus));
  const total = os.totalmem();
  const mem = total > 0 ? Math.max(0, Math.min(1, (total - os.freemem()) / total)) : 0;
  return { cpu, mem, runningTasks };
}
