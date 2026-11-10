/**
 * WSL 项目桥(2026-10-27,Windows 桌面壳专用)。
 *
 * 背景:Windows 桌面端把 WSL 发行版里的项目登记为 UNC 路径
 * (`\\wsl.localhost\<发行版>\home\...` 或旧式 `\\wsl$\...`)。文件读写走 UNC 由 Windows 直读 9p,
 * 但**命令执行必须回到 WSL 内**:否则 Git-Bash 只是隔着共享目录跑 Windows 工具链
 * (node/python/git 全是 Windows 版,权限/换行/符号链接语义都对不上)。
 *
 * 本模块只做三件事:
 * ① 纯函数:UNC ↔ (发行版, POSIX 路径) 互转、wsl.exe 调用参数拼装(可单测,零 IO);
 * ② 发行版枚举/主目录探测(异步,60s 缓存;非 Windows 平台直接空);
 * ③ `wsl.exe -d <distro> --cd <posix> --exec ...` 统一形态(shell/PTY/git 三用)。
 */
import { execFile } from "node:child_process";

export interface WslLocation {
  /** 发行版名(如 "Ubuntu";保留原大小写,命令行原样透传)。 */
  distro: string;
  /** 发行版内 POSIX 绝对路径(UNC 根 = "/")。 */
  posix: string;
}

export interface WslCommand {
  cmd: string;
  args: string[];
}

/** `\\wsl.localhost\<distro>\<rest>` / `\\wsl$\<distro>\<rest>` / `//wsl.localhost/<distro>/<rest>`。 */
const WSL_UNC_RE = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]+([^\\/]+)([\\/][\s\S]*)?$/i;

/** UNC 路径 → WSL 位置;非 WSL UNC 返回 null。纯函数。 */
export function parseWslPath(p: string): WslLocation | null {
  const s = String(p ?? "").trim();
  const m = WSL_UNC_RE.exec(s);
  if (!m) return null;
  const distro = (m[1] ?? "").trim();
  if (!distro) return null;
  const rest = (m[2] ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  return { distro, posix: "/" + rest.replace(/^\/+/, "") };
}

/** (发行版, POSIX 路径) → 标准 UNC 路径(统一用 wsl.localhost 新形态)。纯函数。 */
export function wslUncFor(distro: string, posix: string): string {
  const norm = "/" + String(posix ?? "/").replace(/\\/g, "/").replace(/^\/+/, "");
  const tail = norm === "/" ? "" : norm.replace(/\//g, "\\");
  return "\\\\wsl.localhost\\" + distro + tail;
}

/** wsl.exe 公共前缀:-d <distro> --cd <posix>(缺省 "/")。 */
function wslBase(distro: string, posix: string): string[] {
  return ["-d", distro, "--cd", posix && posix.startsWith("/") ? posix : "/"];
}

/** 命令行工具形态:命令经 WSL 内 bash -lc 执行(POSIX 语义,与 Linux 网关一致)。纯函数。 */
export function wslShellInvocation(distro: string, posix: string, command: string): WslCommand {
  return { cmd: "wsl.exe", args: [...wslBase(distro, posix), "--exec", "bash", "-lc", command] };
}

/** 交互式终端形态:bash 不过 rc/profile(与本地终端会话同口径)。纯函数。 */
export function wslPtyInvocation(distro: string, posix: string): WslCommand {
  return { cmd: "wsl.exe", args: [...wslBase(distro, posix), "--exec", "bash", "--norc", "--noprofile"] };
}

/** git 形态:argv 直传 WSL 内 git(不经过 shell,文件名含空格/引号安全)。纯函数。 */
export function wslGitInvocation(distro: string, posix: string, args: string[]): WslCommand {
  return { cmd: "wsl.exe", args: [...wslBase(distro, posix), "--exec", "git", ...args] };
}

/** 平台能否用 WSL 桥(只有 Windows 壳有意义;Linux/macOS 返回 false)。 */
export function wslSupported(platform: string = process.platform): boolean {
  return platform === "win32";
}

/** 解码 wsl.exe 输出:`-l -q` 是 UTF-16LE(带 BOM),普通命令透传 UTF-8。 */
function decodeWslText(buf: Buffer): string {
  const utf16 = buf.length >= 2 && (buf[0] === 0xff || buf[1] === 0x00);
  const text = buf.toString(utf16 ? "utf16le" : "utf8");
  return text.replace(/^\uFEFF/, "").replace(/\0/g, "");
}

function execFileBuffer(cmd: string, args: string[], timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, encoding: "buffer", maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout as Buffer);
    });
  });
}

interface CacheEntry<T> {
  at: number;
  value: T;
}
const CACHE_TTL_MS = 60_000;
let distroCache: CacheEntry<string[]> | null = null;
const homeCache = new Map<string, CacheEntry<string | null>>();

/** 枚举本机 WSL 发行版(wsl.exe -l -q;未安装 WSL/调用失败 → [])。60s 缓存。 */
export async function listWslDistros(opts?: { force?: boolean; platform?: string }): Promise<string[]> {
  if (!wslSupported(opts?.platform)) return [];
  if (!opts?.force && distroCache && Date.now() - distroCache.at < CACHE_TTL_MS) return distroCache.value;
  try {
    const buf = await execFileBuffer("wsl.exe", ["-l", "-q"], 8_000);
    const list = decodeWslText(buf)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    distroCache = { at: Date.now(), value: list };
    return list;
  } catch {
    distroCache = { at: Date.now(), value: [] };
    return [];
  }
}

/** 发行版内主目录(`echo $HOME`);探测失败/非绝对路径 → null。60s 缓存。 */
export async function wslHome(distro: string, opts?: { force?: boolean; platform?: string }): Promise<string | null> {
  if (!wslSupported(opts?.platform)) return null;
  const hit = homeCache.get(distro);
  if (!opts?.force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  try {
    const buf = await execFileBuffer("wsl.exe", ["-d", distro, "--exec", "sh", "-lc", "echo $HOME"], 10_000);
    const home = (decodeWslText(buf).trim().split(/\r?\n/).pop() ?? "").trim();
    const value = home.startsWith("/") ? home : null;
    homeCache.set(distro, { at: Date.now(), value });
    return value;
  } catch {
    homeCache.set(distro, { at: Date.now(), value: null });
    return null;
  }
}

export interface WslAnchor {
  distro: string;
  /** 发行版内主目录(探测失败为 null)。 */
  home: string | null;
  /** 目录选择器锚点 UNC(主目录优先,探测失败回落到发行版根)。 */
  path: string;
}

/** 目录选择器 WSL 锚点(Windows 桌面壳:每个发行版一行;非 Windows → [])。 */
export async function wslAnchors(opts?: { force?: boolean; platform?: string }): Promise<WslAnchor[]> {
  const distros = await listWslDistros(opts);
  return Promise.all(
    distros.map(async (distro) => {
      const home = await wslHome(distro, opts);
      return { distro, home, path: wslUncFor(distro, home ?? "/") };
    }),
  );
}

/** wsl.exe 相关失败的人话提示(ENOENT/发行版不存在/git 缺失);其他错误返回 undefined。 */
export function wslErrorHint(err: unknown, distro?: string): string | undefined {
  if (!err) return undefined;
  const code = (err as { code?: unknown }).code;
  const msg = String((err as { message?: unknown }).message ?? err);
  if (code === "ENOENT" && /wsl(\.exe)?/i.test(msg)) {
    return "未找到 wsl.exe:本机未安装 WSL 或不在 PATH;请先执行 `wsl --install` 或改用 Windows 本地目录";
  }
  if (/command not found|not found|no such file or directory|没有那个文件或目录/i.test(msg) && /git/i.test(msg)) {
    return "WSL 发行版内没有 git" + (distro ? "(" + distro + ")" : "") + ":在发行版内安装 git 后重试";
  }
  if (/There is no distribution with the supplied name|WSL_E_DISTRO_NOT_FOUND/i.test(msg)) {
    return "WSL 发行版不存在" + (distro ? "(" + distro + ")" : "") + ":检查 `wsl -l -v` 后重新添加项目";
  }
  return undefined;
}

/** 测试用:清空进程内缓存。 */
export function __resetWslCache(): void {
  distroCache = null;
  homeCache.clear();
}