/**
 * 服务端目录浏览(step-056,「选目录弹 Windows 对话框」根治):
 * 面板跑在浏览器/Electron,浏览器侧选目录只能拿到 Windows 侧相对路径(webkitdirectory);
 * gateway 本体跑在 WSL——目录浏览必须由服务端做,才能浏览到 /home/... 真实项目路径。
 * fs.list 故意不限定根:它就是「添加项目」的目录选择器;gateway 是本地工具,
 * 特权面与终端视图(项目根任意命令)一致,不引入新边界。
 */
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, parse } from "node:path";
import { spawn } from "node:child_process";

export interface FsEntry {
  name: string;
  kind: "dir" | "file";
  size: number;
  mtime: number;
}

export interface ListDirResult {
  path: string;
  /** 上级目录;根("/")与非法路径为 null。 */
  parent: string | null;
  home: string;
  entries: FsEntry[];
}

/** 目录列表:目录在前、名称升序;showHidden=false 时跳过点文件。 */
export function listDir(dir: string, showHidden = false): ListDirResult {
  const home = homedir();
  if (!dir || !isAbsolute(dir)) throw new Error("必须是绝对路径");
  const stat = statSync(dir);
  if (!stat.isDirectory()) throw new Error("不是目录");
  const parent = dirname(dir);
  const raw = readdirSync(dir);
  const entries: FsEntry[] = [];
  for (const name of raw) {
    if (!showHidden && name.startsWith(".")) continue;
    let st;
    try {
      st = statSync(dir + "/" + name);
    } catch {
      continue; // 竞态删除/权限拒绝:跳过该条,不炸整个列表
    }
    entries.push({ name, kind: st.isDirectory() ? "dir" : "file", size: st.size, mtime: st.mtimeMs });
  }
  entries.sort((a, b) => (a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : a.name < b.name ? -1 : 1));
  return { path: dir, parent: parent === dir ? null : parent, home, entries };
}

/** 打开命令选择(纯函数,测试锚定):平台×路径 → [命令, 参数]。 */
export function openCommandFor(platform: string, p: string, reveal: boolean): { cmd: string; args: string[] } {
  if (platform === "darwin") return { cmd: "open", args: reveal ? ["-R", p] : [p] };
  if (platform === "win32") return { cmd: "explorer.exe", args: [reveal ? "/select," + p : p] };
  // Linux / WSL:/mnt/* 是 Windows 盘挂载,explorer.exe 直达;/home 等 WSL 原生路径优先 wslview(wslu),
  // 退化 xdg-open;最后 explorer.exe(对 \\wsl$ 形态无效但保底不炸)。
  if (p.startsWith("/mnt/")) return { cmd: "explorer.exe", args: [p] };
  return { cmd: "wslview", args: [p] };
}

/** 系统打开(文件=默认应用;目录=reveal 时定位到文件管理器)。尽力而为:逐个回退,报告最终使用的工具。 */
export function openPath(p: string, reveal = false): { ok: boolean; tool: string; error?: string } {
  if (!p || !isAbsolute(p)) return { ok: false, tool: "", error: "必须是绝对路径" };
  try {
    statSync(p);
  } catch {
    return { ok: false, tool: "", error: "路径不存在" };
  }
  const candidates: { cmd: string; args: string[] }[] = [openCommandFor(process.platform, p, reveal)];
  if (process.platform === "linux") {
    candidates.push({ cmd: "xdg-open", args: [p] });
    candidates.push({ cmd: "explorer.exe", args: [p] });
  }
  let lastErr = "";
  for (const c of candidates) {
    try {
      const child = spawn(c.cmd, c.args, { stdio: "ignore", detached: true });
      child.on("error", () => { /* ENOENT 等:换下一个候选 */ });
      child.unref();
      return { ok: true, tool: c.cmd };
    } catch (err) {
      lastErr = String(err);
    }
  }
  return { ok: false, tool: "", error: lastErr || "无可用打开方式" };
}

/** 目录选择器锚点(添加项目初始位置)。Windows 桌面壳:根=当前盘符,并给出 WSL 锚点标签。 */
export function browseAnchors(): { home: string; root: string; rootLabel: string; cwd: string; platform: string } {
  const win = process.platform === "win32";
  return {
    home: homedir(),
    root: win ? parse(process.cwd()).root : "/",
    rootLabel: win ? "根目录(当前盘符)" : "根目录(WSL 文件系统)",
    cwd: process.cwd(),
    platform: process.platform,
  };
}

/** 条目显示名(面包屑尾段)。 */
export function baseName(p: string): string {
  return basename(p) || p;
}
