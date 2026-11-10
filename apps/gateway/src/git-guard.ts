/**
 * git 破坏命令守卫(g1,2026-11-05)。
 *
 * **病根实锤**:11-05 09:18 一个子代理执行 `git stash`,把全仓 142 个未提交文件收进 stash,
 * 工作树回退成"什么都没改"的假象。既有命令围栏 `fenceCommand`(file-tools.ts)只管路径越界,
 * git stash/checkout/reset/clean/restore 一条都不拦。
 *
 * **判定口径**:基于**解析后的 git 子命令**判定,不做裸子串匹配——
 *   `echo git stash` / `git log --grep=stash` / `grep -r "git checkout" .` 一律不误判(前者命令词不是 git,
 *   后者是 log 的查询参数/是 grep 的参数)。
 *
 * **能穿透的前缀形态**(逐段剥壳):
 *   `FOO=1 git stash`(环境赋值)、`sudo -u x git stash`(sudo/env/nice/nohup/time/xargs 等包装器)、
 *   `cd /x && git stash`(按 `; && || | & 换行` 切段后逐段判)、`git -C <path> stash`、`git --no-pager stash`、
 *   `git -c core.pager=cat stash`(全局选项)、`sh -c "git stash"` / `bash -lc "cd x && git stash"`(引号内递归解析)。
 *
 * **能力边界(如实登记,不假装封死)**:
 *   - `$(...)`/反引号命令替换里的 git:反引号按引号处理不解析内部;`$(git stash)` 不在解析范围。
 *   - `bash script.sh` / `make deploy` / `node -e` 等**脚本/解释器内部**的 git 调用:文本层看不见。
 *   - 别名(`git config alias.x stash` 后跑 `git x`)、git 插件/子命令扩展:按未知子命令处理=一律 write(保守)。
 *   - 远程 `ssh host git stash`、`xargs -I{} git stash`(包装器后的占位符形态)只做尽力解析。
 *   - 超长/奇异引号嵌套(如 `sh -c "sh -c 'git stash'"` 深层)只递归一层 sh -c。
 *
 * 返回约定:`null` = 非 git 命令 / 只读 git 查询(无需干预);否则给出判定。
 * `destructive` 蕴含 `write`(破坏命令当然也是写),调用方用 `destructive || write` 判"要干预"即可。
 */

/** git 守卫判定结果。 */
export interface GitGuardVerdict {
  /** 破坏性(会丢工作树/历史改动):stash、checkout、reset、clean、restore、switch、worktree remove|prune、rm、update-ref -d、filter-branch。 */
  destructive: boolean;
  /** 写操作(add/commit/push/merge/rebase/… 等非只读子命令)。destructive=true 时本字段也为 true。 */
  write: boolean;
  /** 解析出的 git 子命令(小写;取不到时为空串)。 */
  subcommand: string;
  /** 人话原因(进拒因/审计 payload,模型据此自我纠正)。 */
  reason: string;
}

/** 只读 git 子命令(查询类;命中即 null 放行)。 */
const READ_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "rev-parse", "describe", "blame", "annotate", "grep",
  "ls-files", "ls-tree", "ls-remote", "shortlog", "show-ref", "for-each-ref", "cat-file",
  "merge-base", "rev-list", "show-branch", "diff-tree", "diff-files", "diff-index",
  "whatchanged", "name-rev", "var", "version", "help", "count-objects", "fsck",
  "verify-commit", "verify-tag", "check-ignore", "check-attr", "check-ref-format",
]);

/** 直接破坏(无条件 destructive,不看参数)。 */
const DESTRUCTIVE_SUBCOMMANDS = new Set(["checkout", "reset", "clean", "restore", "switch", "filter-branch"]);

/** 包装器命令(剥掉后继续看真正的命令词)。 */
const WRAPPERS = new Set(["sudo", "doas", "env", "nohup", "time", "nice", "ionice", "command", "exec", "stdbuf", "xargs", "busybox", "timeout"]);

/** 包装器里「需要消费下一个词」的选项(值紧跟其后)——**按包装器分表**,别用一张大表:
 *  `env -i git stash` 与 `sudo -u root git stash` 的 `-i`/`-u` 语义不同,合表会把 `git` 当下一个值吃掉。 */
const WRAPPER_OPTS_WITH_VALUE: Record<string, ReadonlySet<string>> = {
  sudo: new Set(["-u", "-g", "-p", "-C", "-h", "-r", "-t", "-U", "-T", "-D"]),
  doas: new Set(["-u", "-C"]),
  env: new Set(["-u", "-C", "--unset", "--chdir"]),
  nice: new Set(["-n", "--adjustment"]),
  ionice: new Set(["-c", "-n", "-p"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  xargs: new Set(["-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
};

/** 环境变量赋值前缀:`FOO=1` / `A=b`。 */
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** shell 解释器(git 可能在 `sh -c "..."` 的引号里)。 */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish"]);

/** git 全局选项里「带值」的(--opt value / --opt=value 两形态)。 */
const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env"]);

/** 按 shell 段切分 + 分词(**引号内不切**;引号内容按一个词保留,引号字符剥掉)。
 *  段分隔符:换行 `;` `&&` `||` `|` `&`(引号外)。 */
export function splitShellSegments(text: string): string[][] {
  const segs: string[][] = [];
  let cur: string[] = [];
  let word = "";
  let has = false;
  let quote = "";
  const pushWord = (): void => { if (has) { cur.push(word); word = ""; has = false; } };
  const pushSeg = (): void => { pushWord(); if (cur.length) segs.push(cur); cur = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) { quote = ""; continue; }
      if (ch === "\\" && quote === '"' && i + 1 < text.length) { word += text[++i]; has = true; continue; }
      word += ch; has = true; continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; has = true; continue; }
    if (ch === "\\" && i + 1 < text.length) { word += text[++i]; has = true; continue; }
    if (ch === "\n" || ch === ";") { pushSeg(); continue; }
    if (ch === "&" || ch === "|") { pushSeg(); if (text[i + 1] === ch) i++; continue; }
    if (/\s/.test(ch)) { pushWord(); continue; }
    word += ch; has = true;
  }
  pushSeg();
  return segs;
}

/** 取命令名(去路径/去 .exe)。 */
function baseName(word: string): string {
  const seg = word.replace(/\\/g, "/").split("/").pop() ?? word;
  return seg.toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
}

/** 剥包装器/环境赋值前缀,返回剥到真正的命令词为止的剩余词表。 */
function peelPrefix(tokens: string[]): string[] {
  let t = tokens.slice();
  for (let guard = 0; guard < 32; guard++) {
    if (t.length === 0) return t;
    const w = t[0]!;
    if (ENV_ASSIGN.test(w)) { t.shift(); continue; }
    if (WRAPPERS.has(baseName(w))) {
      const name = baseName(w);
      t.shift();
      const withValue = WRAPPER_OPTS_WITH_VALUE[name] ?? new Set<string>();
      while (t.length > 0 && t[0]!.startsWith("-")) {
        const opt = t.shift()!;
        if (withValue.has(opt) && t.length > 0 && !t[0]!.startsWith("-")) t.shift();
      }
      // `timeout 30 git stash`:时长是位置参数,不是命令词(仅 timeout 需要)
      if (name === "timeout" && t.length > 0 && /^\d+(\.\d+)?[smhd]?$/.test(t[0]!)) t.shift();
      continue;
    }
    if (baseName(w) === "cd") { t.splice(0, Math.min(2, t.length)); continue; }
    return t;
  }
  return t;
}

/** shell 解释器里「后面跟一整条命令」的旗标形态:POSIX `-c`/`-lc`,`cmd /c|/k`,PowerShell `-Command`。 */
const POSIX_C_FLAG = /^-[a-zA-Z]*c[a-zA-Z]*$/;
const POWERSHELL_CMD_FLAG = /^-(c|co|com|comm|comma|comman|command)$/i;

/** `sh -c "..."` / `bash -lc "..."` / `cmd /c "..."` / PowerShell -Command / `eval "..."` 的引号内命令。 */
function innerShellCommand(tokens: string[]): string | null {
  if (tokens.length === 0) return null;
  const head = baseName(tokens[0]!);
  if (head === "eval") return tokens.slice(1).join(" ") || null;
  const isCmd = head === "cmd";
  const isPs = head === "powershell" || head === "pwsh";
  if (!SHELLS.has(head) && !isCmd && !isPs) return null;
  const idx = tokens.findIndex((t, i) => {
    if (i === 0) return false;
    if (isCmd) return /^\/[ck]$/i.test(t); // cmd /c 与 /k
    if (isPs) return POWERSHELL_CMD_FLAG.test(t);
    return POSIX_C_FLAG.test(t);
  });
  if (idx < 0) return null;
  const next = String(tokens[idx + 1] ?? "").trim();
  return next || null;
}

/** 建判定对象(destructive 蕴含 write)。 */
function verdict(destructive: boolean, write: boolean, subcommand: string, reason: string): GitGuardVerdict {
  return { destructive, write: destructive || write, subcommand: subcommand.toLowerCase(), reason };
}

/** 按子命令 + 参数分类(null=只读放行)。 */
function classify(sub: string, rest: string[]): GitGuardVerdict | null {
  const positional = rest.filter((t) => !t.startsWith("-"));
  const hasFlag = (...names: string[]): boolean => rest.some((t) => names.includes(t));
  const act = positional[0]?.toLowerCase() ?? "";

  if (DESTRUCTIVE_SUBCOMMANDS.has(sub)) {
    const detail = sub === "checkout" ? "会切换分支/覆盖工作树文件,未提交改动可能被丢弃"
      : sub === "reset" ? "会移动 HEAD/索引,工作树改动可能被丢弃"
        : sub === "clean" ? "会删除未跟踪文件(不可恢复)"
          : sub === "restore" ? "会覆盖工作树文件,未提交改动被丢弃"
            : sub === "switch" ? "会切换分支(工作树随之改写)"
              : "会重写历史/引用(filter-branch)";
    return verdict(true, true, sub, `git ${sub} ${detail}`);
  }
  switch (sub) {
    case "stash": {
      if (act === "list" || act === "show") return null; // 只读查询放行
      return verdict(true, true, "stash", `git stash 会把未提交改动整体收进 stash、工作树回退(2026-11-05 实锤:142 文件被收走)`);
    }
    case "worktree": {
      if (act === "list") return null;
      if (act === "remove" || act === "prune") return verdict(true, true, "worktree", `git worktree ${act} 会删除工作树目录/元数据`);
      return verdict(false, true, "worktree", `git worktree ${act || "add"}(写操作)`);
    }
    case "update-ref": {
      if (hasFlag("-d", "--delete")) return verdict(true, true, "update-ref", "git update-ref -d 会删除引用(指向的提交可能失联)");
      return verdict(false, true, "update-ref", "git update-ref 会改写引用(写操作)");
    }
    case "rm": {
      if (hasFlag("--cached")) return verdict(false, true, "rm", "git rm --cached 只动索引(写操作)");
      return verdict(true, true, "rm", "git rm 会从工作树删除文件");
    }
    case "reflog": {
      if (act === "expire" || act === "delete") return verdict(true, true, "reflog", `git reflog ${act} 会清理 reflog(丢失恢复线索)`);
      return null;
    }
    case "branch": {
      // 只读:无位置参数且只有列类旗标
      const listFlags = new Set(["-l", "--list", "--show-current", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--merged", "--no-merged", "--contains", "--no-contains", "-i", "--ignore-case", "--sort", "--format", "--points-at", "--column", "--no-column", "-h", "--help"]);
      const onlyList = positional.length === 0 && rest.every((t) => listFlags.has(t));
      if (onlyList) return null;
      return verdict(false, true, "branch", `git branch ${positional[0] ? "创建/移动/删除分支" : "改分支状态"}(写操作)`);
    }
    case "tag": {
      const listFlags = new Set(["-l", "--list", "-n", "-i", "--ignore-case", "-v", "--verify", "--contains", "--no-contains", "--points-at", "--merged", "--no-merged", "--sort", "--format", "--column", "--no-column", "-h", "--help"]);
      if (rest.length === 0) return null; // 裸 git tag = 列表
      if (positional.length === 0 && rest.every((t) => listFlags.has(t) || /^-n\d+$/.test(t))) return null;
      return verdict(false, true, "tag", "git tag 创建/删除标签(写操作)");
    }
    case "remote": {
      if (rest.length === 0) return null; // 裸 git remote = 列表
      if (act === "" || act === "show" || act === "get-url" || hasFlag("-v", "--verbose")) return null;
      return verdict(false, true, "remote", `git remote ${act}(改远端配置/写操作)`);
    }
    case "config": {
      const readFlags = ["--get", "--get-all", "--get-regexp", "--list", "-l", "--show-origin", "--list-origin", "--get-urlmatch", "-h", "--help"];
      const writeFlags = ["--unset", "--unset-all", "--add", "--replace-all", "--set", "--rename-section", "--remove-section", "-e", "--edit"];
      if (hasFlag(...writeFlags)) return verdict(false, true, "config", "git config 改配置(写操作)");
      if (hasFlag(...readFlags)) return null;
      if (positional.length >= 2) return verdict(false, true, "config", "git config 写键值(写操作)");
      return null; // git config <key> = 读
    }
    case "pull":
    case "fetch": {
      return verdict(false, true, sub, `git ${sub} 会改写本地引用(写操作)`);
    }
    default: break;
  }
  if (READ_SUBCOMMANDS.has(sub)) return null;
  return verdict(false, true, sub || "?", `git ${sub || "?"} 不是只读查询(按写操作处理;未知子命令/别名同样保守拦)`);
}

/** 解析一条 git 命令(词表以 git 打头),返回判定或 null。 */
function parseGitCommand(tokens: string[]): GitGuardVerdict | null {
  let i = 1;
  while (i < tokens.length) {
    const a = tokens[i]!;
    if (a === "--") { i++; break; }
    if (!a.startsWith("-")) break;
    if (GIT_GLOBAL_WITH_VALUE.has(a)) { i += 2; continue; }
    i += 1; // 裸旗标 / --opt=value
  }
  const sub = tokens[i];
  if (!sub) return null; // 只有全局选项(git --version 之类)= 无子命令,不动
  return classify(sub.toLowerCase(), tokens.slice(i + 1));
}

/** 单段判定(递归处理 sh -c / eval)。 */
function guardSegment(tokens: string[], depth: number): GitGuardVerdict | null {
  const peeled = peelPrefix(tokens);
  if (peeled.length === 0) return null;
  if (depth < 2) {
    const inner = innerShellCommand(peeled);
    if (inner) {
      const v = guardGitCommandDepth(inner, depth + 1);
      // 引号内是真 git 破坏命令:原样上抛(不因"在引号里"降级为只读)
      if (v) return v;
    }
  }
  if (baseName(peeled[0]!) !== "git") return null; // 命令词不是 git → 不干预(`echo git stash` / `grep "git checkout"` 在此出局)
  return parseGitCommand(peeled);
}

/** 主入口:解析命令文本,返回 git 判定(null=非 git 或不需干预)。多段命令取最严。 */
export function guardGitCommand(cmd: string): GitGuardVerdict | null {
  return guardGitCommandDepth(String(cmd ?? ""), 0);
}

function guardGitCommandDepth(cmd: string, depth: number): GitGuardVerdict | null {
  const text = String(cmd ?? "");
  if (!text.trim()) return null;
  let worst: GitGuardVerdict | null = null;
  for (const seg of splitShellSegments(text)) {
    const v = guardSegment(seg, depth);
    if (!v) continue;
    if (!worst || (v.destructive && !worst.destructive)) worst = v;
  }
  return worst;
}

/** 子代理面的拒因文本(单一来源,run_cmd 与 terminal 两处共用)。 */
export function subagentGitBlockReason(v: GitGuardVerdict): string {
  return `子代理禁止执行 git 写操作(git ${v.subcommand}:${v.reason});如需执行请由父代理(main agent)操作`;
}

/** 主 agent 面的审计留痕:命中 destructive/write 时 append 一条 custom/git.audit(放行但留痕)。 */
export function auditGitCommand(journal: { append: (e: never) => unknown } | null | undefined, sessionId: string, cmd: string): GitGuardVerdict | null {
  const v = guardGitCommand(cmd);
  if (!v || !journal) return v;
  try {
    journal.append({
      kind: "custom",
      sessionId,
      payload: { type: "git.audit", cmd: String(cmd).slice(0, 2000), subcommand: v.subcommand, destructive: v.destructive, at: Date.now() },
    } as never);
  } catch { /* 留痕失败不影响主 agent 执行 */ }
  return v;
}
