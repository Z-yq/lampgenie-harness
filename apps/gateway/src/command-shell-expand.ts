/**
 * 自定义命令 body 的 !`cmd` shell 片段展开(r4,ZCode custom-command-shell-expansion 语义)。
 *
 * 语义(ZCode apps/zcode-cli/packages/bootstrap/src/custom-command-shell-expansion.ts;
 * planner 实测该文件在 ref 树零命中,按已定稿语义实现):
 * - 模板中 `` !`cmd` `` 片段 → 同步执行 `bash -c <cmd>`,以 stdout(去尾换行)替换该片段;
 * - 3s 超时(kill 后按失败处理);
 * - stdout 截 2000 字;
 * - 失败(非零退出/超时/无法 spawn)替换为 `(cmd 失败:<原因截 120 字>)`,不抛错;
 * - 每条 body 最多展开 3 处,超出部分保留原文(防一条模板拉起一串子进程);
 * - cwd=repoRoot(由调用方传入;缺省实现不在此模块猜测)。
 *
 * 纯函数形态:run 注入默认执行器(execFileSync bash),单测注桩不真 exec。
 * 接线:server.ts commands.list case 返回前对 custom 段 body 展开(见该处注释),
 * 协议不变,面板零改动。
 */
import { execFileSync } from "node:child_process";

/** 单片段执行结果:ok=stdout(未截断,调用方统一切 2000);!ok=失败原因(未截断)。 */
export type ShellSnippetResult = { ok: true; stdout: string } | { ok: false; reason: string };

/** 执行器:同步跑一条 bash 命令;永不抛错(抛错由默认实现兜成 { ok:false })。 */
export type ShellSnippetRunner = (cmd: string, cwd: string) => ShellSnippetResult;

/** 片段形态:!(反引号)…(反引号);cmd 允许除反引号外任意字符(含换行)。 */
const SNIPPET_RE = /!`([^`]*)`/g;

/** 每 body 展开上限(超出保留原文)。 */
export const SHELL_SNIPPET_MAX_PER_BODY = 3;

/** stdout 截断上限(字符)。 */
export const SHELL_SNIPPET_OUTPUT_LIMIT = 2000;

/** 失败原因截断上限(字符)。 */
export const SHELL_SNIPPET_REASON_LIMIT = 120;

/** bash 超时(ms)。 */
export const SHELL_SNIPPET_TIMEOUT_MS = 3000;

/** 默认执行器:execFileSync("bash", ["-c", cmd]) 同步执行,3s 超时,异常兜成失败结果。 */
export function runShellSnippet(cmd: string, cwd: string): ShellSnippetResult {
  try {
    const stdout = execFileSync("bash", ["-c", cmd], {
      cwd,
      timeout: SHELL_SNIPPET_TIMEOUT_MS,
      encoding: "utf8",
      // stdout 即产出;stderr 不混入(失败原因里带前 200 字,够定位)。
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, reason: shellFailReason(err, cmd) };
  }
}

/** 把 execFileSync 抛出的各种形态(execFileSync 返回值带 status/stderr/killSignal)折成一句原因。 */
function shellFailReason(err: unknown, cmd: string): string {
  const e = err as { killed?: boolean; signal?: string; status?: number | null; stderr?: string | Buffer; timedOut?: boolean; message?: string };
  const stderr = (typeof e.stderr === "string" ? e.stderr : e.stderr?.toString("utf8") ?? "").trim().replace(/\s+/g, " ");
  if (e.killed || e.signal === "SIGTERM" || e.timedOut) return `超时(> ${SHELL_SNIPPET_TIMEOUT_MS / 1000}s)`;
  const head = stderr.slice(0, 200);
  const tail = typeof e.status === "number" ? `exit ${e.status}` : String(e.message ?? "未知错误").replace(/\s+/g, " ").slice(0, 200);
  return head ? `exit ${e.status ?? "?"}: ${head}` : tail;
}

/**
 * 展开 body 里的 !`cmd` 片段(纯函数):命中片段逐个经 run 执行并替换;超过
 * MAX_PER_BODY 处的片段保留原文;失败片段替换为 `(cmd 失败:<原因截 120>)`。
 * body 无片段时原样返回(同一引用不拷贝,lists 大批量时零开销)。
 */
export function expandShellSnippets(body: string, cwd: string, run: ShellSnippetRunner = runShellSnippet): string {
  if (!body || body.indexOf("!`") === -1) return body;
  let count = 0;
  return body.replace(SNIPPET_RE, (whole: string, cmd: string): string => {
    count += 1;
    if (count > SHELL_SNIPPET_MAX_PER_BODY) return whole; // 超出上限:保留原文
    const r = run(cmd, cwd);
    if (r.ok) {
      const out = r.stdout.replace(/\r?\n$/, "");
      return out.length > SHELL_SNIPPET_OUTPUT_LIMIT ? out.slice(0, SHELL_SNIPPET_OUTPUT_LIMIT) : out;
    }
    const reason = r.reason.length > SHELL_SNIPPET_REASON_LIMIT ? r.reason.slice(0, SHELL_SNIPPET_REASON_LIMIT) : r.reason;
    return `(${cmd} 失败:${reason})`;
  });
}
