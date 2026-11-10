/**
 * Windows shell 抽象( K4 / P1-6)。
 * 背景:hooks 执行、终端工具、子代理 run_cmd 三处原本硬编码 `bash -lc <cmd>`,Windows 原生无 bash,
 * 双击 exe 形态下这三个功能会直接 ENOENT 崩掉(不是"降级",是"不可用")。此模块把「命令字符串 →
 * (可执行文件, 参数数组)」的决策收成一处纯函数,三处调用点统一走它。
 * 规则(平台无关,可单测):
 * - 覆盖来源:`opts.shellBin` > env `GENIE_SHELL_BIN`(桌面壳/用户显式指定,Windows 上建议填
 *   Git for Windows 的 bash,如 `C:\Program Files\Git\bin\bash.exe`,即可拿回 POSIX 语义);
 * - 有 shellBin 时:basename 含 `bash`/`sh` → `-lc`(POSIX 登录 shell 语义,与旧行为一致);
 *   basename 含 `cmd` → `/d /s /c`(Windows cmd 专用语义);其他名字(如 powershell.exe)不猜,
 *   退回按平台默认参数形态处理(win32 → `/d /s /c`,其他 → `-lc`);
 * - 无 shellBin 时:platform=win32 → `cmd.exe /d /s /c <cmd>`;其他 → `bash -lc <cmd>`。
 * Windows 降级理由:cmd.exe 的 `/d`(跳过 AutoRun 注册表脚本)/`/s`(保留引号原样,配合 `/c` 的
 * 外层引号剥离规则)/`/c`(执行后退出)是让 `cmd /c "命令含空格"` 可靠工作的标准组合;它**不是** bash,
 * 因此 `&&` 之外的 POSIX 语法(单引号、`$(...)`、`export`、`[ -f ... ]`)不会被解释——这是显式降级,
 * 由调用点的 ENOENT/错误文案告知用户装 Git for Windows 或设 `GENIE_SHELL_BIN`,不静默吞。
 * 纯函数:零 IO、不读时钟、不 spawn,除默认读一次 `process.env.GENIE_SHELL_BIN`。
 */
import { parseWslPath, wslErrorHint, wslShellInvocation } from "./wsl.js";

export interface ShellInvocation {
  /** 要执行的可执行文件名或绝对路径。 */
  cmd: string;
  /** 参数数组(命令原文作为最后一个元素原样透传,含空格/引号的命令不会被本模块改写)。 */
  args: string[];
  /** 人类可读的降级说明(仅 Windows 默认走 cmd.exe 时给出);调用点可打印。 */
  hint?: string;
  /** 执行面:wsl=命令在 WSL 发行版内执行(调用点不要再用 UNC cwd 启动进程)。缺省=宿主 shell。 */
  mode?: "wsl" | "host";
}

/** shell 缺失时的统一提示文案(ENOENT):三处调用点的错误信息都要带这一句。 */
export const SHELL_MISSING_HINT = "Windows 下请安装 Git for Windows 或设置 GENIE_SHELL_BIN(如 C:\\Program Files\\Git\\bin\\bash.exe)";

/** 取 basename,同时认 `/` 与 `\`(Windows 路径在任意平台跑单测都要正确切分;只切不解析盘符)。 */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return (parts[parts.length - 1] || p).toLowerCase();
}

/** basename 含 `bash`/`sh` 即按 POSIX shell 处理(Git-Bash、/bin/sh、dash 等同族)。 */
function isPosixShellName(base: string): boolean {
  return base.includes("bash") || base.includes("sh");
}

const CMD_ARGS = (command: string): string[] => ["/d", "/s", "/c", command];
const POSIX_ARGS = (command: string): string[] => ["-lc", command];

/**
 * 把一条命令字符串翻译成 {可执行文件, 参数}。
 * @param command 用户命令原文(不 trim、不改写,原样作为 shell 的参数)
 * @param opts.platform 覆盖平台判定(缺省 process.platform;单测注入用)
 * @param opts.shellBin 覆盖 shell 可执行文件(缺省 env GENIE_SHELL_BIN;都没有=平台默认)
 * @param opts.cwd 命令将要在哪个目录执行:Windows 下若是 WSL UNC 路径,改走 wsl.exe 回到发行版内
 *   (优先级最高——Git-Bash 隔着 9p 跑 Windows 工具链不是 WSL 项目要的语义)
 */
export function shellInvocation(
  command: string,
  opts?: { platform?: NodeJS.Platform; shellBin?: string; cwd?: string },
): ShellInvocation {
  const platform = opts?.platform ?? process.platform;
  // WSL 项目优先:UNC 路径 → wsl.exe -d <distro> --cd <posix> --exec bash -lc <cmd>
  if (platform === "win32" && opts?.cwd) {
    const wsl = parseWslPath(opts.cwd);
    if (wsl) {
      return {
        ...wslShellInvocation(wsl.distro, wsl.posix, command),
        mode: "wsl",
        hint: "WSL 项目:命令在 " + wsl.distro + " 内执行(wsl.exe);Linux 侧工具链与路径语义",
      };
    }
  }
  const raw = opts?.shellBin ?? process.env.GENIE_SHELL_BIN;
  const shellBin = typeof raw === "string" && raw.trim() ? raw.trim() : undefined;

  if (shellBin) {
    const base = baseName(shellBin);
    if (isPosixShellName(base)) return { cmd: shellBin, args: POSIX_ARGS(command) };
    if (base.includes("cmd")) return { cmd: shellBin, args: CMD_ARGS(command) };
    // 未知自定义 shell:不猜参数方言,按平台默认形态处理(仍是用户指定的那个可执行文件)。
    return { cmd: shellBin, args: platform === "win32" ? CMD_ARGS(command) : POSIX_ARGS(command) };
  }

  if (platform === "win32") {
    return {
      cmd: "cmd.exe",
      args: CMD_ARGS(command),
      hint: "Windows 无 bash,命令经 cmd.exe /d /s /c 执行;" + SHELL_MISSING_HINT,
    };
  }
  return { cmd: "bash", args: POSIX_ARGS(command) };
}

/**
 * shell 不存在(ENOENT)时返回人话提示,其他错误返回 undefined(调用点按原错误处理)。
 * 用途:三处调用点都要在错误信息里带上 SHELL_MISSING_HINT,不静默吞。
 */
export function shellErrorHint(err: unknown, inv?: ShellInvocation): string | undefined {
  if (!err) return undefined;
  const code = (err as { code?: unknown }).code;
  const msg = String((err as { message?: unknown }).message ?? err);
  if (inv?.mode === "wsl") {
    const wslHint = wslErrorHint(err);
    if (wslHint) return wslHint;
  }
  if (code === "ENOENT" || /ENOENT|not found|不是内部或外部命令/i.test(msg)) {
    const who = inv ? `(${inv.cmd} 未找到)` : "";
    return (who ? "shell 未找到" + who + ":" : "shell 未找到:") + SHELL_MISSING_HINT;
  }
  return undefined;
}