/**
 * git 凭据辅助(二期:GitLab/Codeup https 克隆/推送的 token 传递)。
 * 令牌处理决策(诚实登记):
 * - 不走「token 内嵌 https URL」——那会把带 token 的 remote 写进 .git/config(token 落盘)。
 * - 不走 argv 内嵌——argv 在 /proc/<pid>/cmdline 对同机进程可读。
 * - 采用 GIT_ASKPASS:git 需要凭据时调用该 helper 程序取值。helper 脚本是**静态且不含任何机密**的
 *   (只从环境变量回显),token 仅经进程环境变量(GIT_ASKPASS_PASS)传递——不落盘、不进 argv,
 *   暴露面=git 进程自身的环境(与任何 env 传密同级)。
 * - 同时 `-c credential.helper=` 清空凭据助手链,防止宿主全局 helper(osxkeychain/store 等)
 *   把 token 存进凭据仓(落盘)。
 * - helper 脚本写入 os.tmpdir() 一次(0700);内容固定无密,可安全残留/复写。
 * - 非 linux 平台未验证(本仓开发/部署环境为 linux/WSL,登记边界)。
 */
import { writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HELPER_PATH = join(tmpdir(), "genie-git-askpass.sh");

/** helper 脚本内容:按 git 提问类型回显环境变量;脚本本身零机密。 */
const HELPER_BODY = [
  "#!/bin/sh",
  "# lampgenie-harness git askpass helper(静态无密:只回显环境变量)。",
  'case "$1" in',
  '  Username*) printf \'%s\\n\' "$GIT_ASKPASS_USER" ;;',
  "  *) printf '%s\\n' \"$GIT_ASKPASS_PASS\" ;;",
  "esac",
  "",
].join("\n");

let helperReady: Promise<string> | null = null;

function ensureHelper(): Promise<string> {
  helperReady ??= (async () => {
    await mkdir(tmpdir(), { recursive: true });
    await writeFile(HELPER_PATH, HELPER_BODY, { flag: "w" });
    await chmod(HELPER_PATH, 0o700);
    return HELPER_PATH;
  })();
  return helperReady;
}

/**
 * 构造 git 子进程的凭据环境(并入 process.env 使用)。
 * @param token 访问令牌(PAT / clone token);只进环境变量,不进 argv/磁盘。
 * @param username https 凭据用户名(GitLab PAT 任意非空 / 惯例 oauth2;Codeup 可配)。
 */
export async function askpassEnv(token: string, username = "oauth2"): Promise<Record<string, string>> {
  const helper = await ensureHelper();
  return {
    GIT_ASKPASS: helper,
    GIT_ASKPASS_USER: username,
    GIT_ASKPASS_PASS: token,
    // 无 askpass 可用时快速失败而非挂起(execFile 无 tty,终端提示本就不可用)。
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** 剥离 URL 里的内嵌凭据(防御:调用方误传带 token 的 URL 时,避免其经 clone 写进 .git/config)。 */
export function sanitizeRemoteUrl(repoUrl: string): string {
  try {
    const u = new URL(repoUrl);
    if (u.protocol === "http:" || u.protocol === "https:") {
      u.username = "";
      u.password = "";
      return u.toString();
    }
    return repoUrl; // ssh/scp/本地路径:不涉 https token
  } catch {
    return repoUrl; // scp 形(user@host:path)或本地路径,URL 解析失败原样返回
  }
}

/** clone 命令构造(单测锚点:-c credential.helper= 清空凭据助手,URL 已剥离内嵌凭据)。 */
export function buildCloneArgs(repoUrl: string, dest: string): string[] {
  return ["-c", "credential.helper=", "clone", sanitizeRemoteUrl(repoUrl), dest];
}

/** push 命令构造(与 clone 同纪律:清凭据助手 + askpass 供凭据)。 */
export function buildPushArgs(remote: string, branch: string): string[] {
  return ["-c", "credential.helper=", "push", remote, branch];
}
