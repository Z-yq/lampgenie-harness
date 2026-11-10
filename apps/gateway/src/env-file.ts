/**
 * .env 文件加载(gateway 启动早期):KEY=VALUE 受控解析,只填 process.env 未占用的键
 * (进程真实 env 优先——外部显式配置不该被文件悄悄覆盖)。
 * 背景:RELAY_URL 等启动级开关此前只认 process.env,repoRoot/.env 里的配置是死文件
 * (团队页空态注意:RELAY_URL=ws://127.0.0.1:7870 写在 .env 里从未生效)。
 * 语义:支持 # 注释/空行/首尾空白/成对引号剥离;非法行(无=)跳过不计;不递归展开。
 */
import { existsSync, readFileSync } from "node:fs";

export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!existsSync(path)) return [];
  let text = "";
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const applied: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key in env) continue; // 进程 env 已占用:文件不覆盖
    env[key] = value;
    applied.push(key);
  }
  return applied;
}
