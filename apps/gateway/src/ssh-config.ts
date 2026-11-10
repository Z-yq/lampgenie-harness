/**
 * SSH config 解析(对齐 ZCode 新建连接「从 SSH config 导入」):
 * 读 ~/.ssh/config,取具体 Host 条目(通配 * ? 条目为默认段属性,一期跳过),
 * 字段:HostName(缺省=别名)/User/Port(缺省 22)/IdentityFile(取首个)。
 * 只读解析,不执行任何 ssh;返回供「新建连接」表单填充。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SshConfigEntry {
  alias: string;
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

export function parseSshConfig(text: string): SshConfigEntry[] {
  const entries: SshConfigEntry[] = [];
  let cur: { aliases: string[]; host?: string; user?: string; port?: number; identityFile?: string } | null = null;
  const flush = () => {
    if (!cur) return;
    for (const alias of cur.aliases) {
      if (alias.includes("*") || alias.includes("?") || alias.includes("!")) continue; // 通配/否定模式=默认段,不作为可导入条目
      entries.push({ alias, host: cur.host ?? alias, ...(cur.user ? { user: cur.user } : {}), ...(cur.port ? { port: cur.port } : {}), ...(cur.identityFile ? { identityFile: cur.identityFile } : {}) });
    }
    cur = null;
  };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const eq = line.match(/^(\S+)\s*=\s*(.+)$/); // OpenSSH 允许 Key=Value 形态
    const m = eq ? [eq[1]!, eq[2]!] : line.split(/\s+/);
    const key = (m[0] ?? "").toLowerCase();
    const val = m.slice(1).join(" ").trim();
    if (!val) continue;
    if (key === "host") { flush(); cur = { aliases: val.split(/\s+/) }; continue; }
    if (!cur) continue;
    if (key === "hostname") cur.host = val;
    else if (key === "user") cur.user = val;
    else if (key === "port") { const n = Number(val); if (Number.isInteger(n) && n >= 1 && n <= 65535) cur.port = n; }
    else if (key === "identityfile") { const p = val.replace(/^~(?=\/|$)/, homedir()); if (!cur.identityFile) cur.identityFile = p; }
  }
  flush();
  return entries;
}

export function loadSshConfigEntries(configPath?: string): { entries: SshConfigEntry[]; path: string } {
  const path = configPath ?? join(homedir(), ".ssh", "config");
  if (!existsSync(path)) return { entries: [], path };
  try {
    return { entries: parseSshConfig(readFileSync(path, "utf-8")), path };
  } catch {
    return { entries: [], path };
  }
}
