/**
 * terminal「绕写」检测(plan-gate 用; 抽成纯函数, 升级为 shell 词法解析)。
 * 要解决的问题:门禁只该拦「用 terminal 写文件绕过白板」,但旧正则有两类失真——
 * ①把无害重定向(`2>/dev/null`、`2>&1`)当写文件:只读勘察 `ls ... | grep ... 2>/dev/null`
 * 被拒,agent 反复换招重试(经验证 6 会话 31 次误拒,单任务 39 次工具失败);
 * ②引号/拼接漏判:`echo hi > "out.txt"` 在旧实现里引号字面量被剥掉后重定向目标消失 → 真写漏放。
 * v2 口径(真正的 tokenizer,不再对原始字符串跑正则):
 * - 词法:单/双引号、反斜杠转义、`$(...)`/反引号当**不透明词**(内部不再解析);
 * - 算子:`&& ||; | & ` 切简单命令;重定向 `> >> >| <> &> &>> N> N>> N>&M << <<- <<< <`;
 * heredoc 读到定界符行,正文整体吞掉(正文里的 `>`/`rm` 不参与判断);
 * - 写判定:重定向目标是**真实文件**(`>` 系;`/dev/null`、`/dev/stdout`、`/dev/stderr`、
 * `/dev/fd/N`、`/proc/self/fd/N`、fd 复制 `>&N` 除外);或写命令(sed -i / tee 带文件实参 /
 * dd of=真实文件 / truncate / install / patch / cp 两个以上实参)。
 * - 纯函数,零 IO;不确定时宁可判 true(门禁 fail-closed)。
 * 已知边界(登记不修):`$(...)` 内部的嵌套写不解析;awk/perl/ruby 脚本字面量里的
 * `print > "out"` 属脚本语言级写,不做语言内分析;`mv/rm/mkdir/touch` 维持旧口径**不**算
 * 绕写(写入文件内容的路径才拦;扩目录等于放宽误拦面,与 修复方向相反)。
 */

/** 词:一段被当整体的文本(引号内容/普通词/$(...) 都算一个词),word 为去引号定界符后的文本。 */
interface ShellToken {
  word: string;
 /** 词内出现过引号/命令替换(重定向目标判断不受影响;仅诊断用)。 */
  quoted: boolean;
}

interface ReadWordResult {
  token: ShellToken;
 /** 消耗到的下一个位置。 */
  end: number;
}

/** 词法后的一元:词 / 算子 / 重定向(target=重定向目标词;heredoc 无 target)。 */
type Piece =
  | { kind: "word"; token: ShellToken }
  | { kind: "op"; text: string }
  | { kind: "redirect"; op: string; fd: number | undefined; target: ShellToken | undefined };

const OPERATOR_CHARS = "<>|&;()";

const HARMLESS_SINKS: ReadonlySet<string> = new Set<string>([
  "/dev/null",
  "/dev/zero",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/full",
]);

/** 重定向目标是否是无害汇(不落盘)。 */
function harmlessTarget(word: string): boolean {
  const w = word.trim();
  if (HARMLESS_SINKS.has(w)) return true;
  if (/^\/dev\/fd\/\d+$/.test(w)) return true;
  if (/^\/proc\/self\/fd\/\d+$/.test(w)) return true;
  return false;
}

/**
 * 从 start 读一个词(单一事实源:词内引号/转义/$(...) 的边界判定只在这里)。
 * 词结束于:空白 / 算子字符 / 串尾。`#` 不算词内边界(只有词首的 # 才是注释)。
 */
function readWordAt(s: string, start: number): ReadWordResult {
  const n = s.length;
  let i = start;
  let word = "";
  let quoted = false;
  while (i < n) {
    const ch = s[i]!;
    if (ch === "'") {
      quoted = true;
      const end = s.indexOf("'", i + 1);
      if (end === -1) {
        word += s.slice(i + 1);
        return { token: { word, quoted }, end: n };
      }
      word += s.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i++;
      while (i < n && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < n) i++;
        word += s[i]!;
        i++;
      }
      i++; // 收尾双引号(不存在也安全:已在串尾)
      continue;
    }
    if (ch === "\\" && i + 1 < n) {
      if (s[i + 1] !== "\n") word += s[i + 1]!;
      i += 2;
      continue;
    }
    if (ch === "$" && s[i + 1] === "(") {
 // $(...) 命令替换:平衡括号扫描(跳过内部引号串),整体当不透明词
      quoted = true;
      let depth = 0;
      let k = i + 1;
      while (k < n) {
        const c = s[k]!;
        if (c === "(") depth++;
        else if (c === ")") {
          depth--;
          if (depth === 0) break;
        } else if (c === "'") {
          const e = s.indexOf("'", k + 1);
          if (e !== -1) k = e;
        } else if (c === '"') {
          k++;
          while (k < n && s[k] !== '"') {
            if (s[k] === "\\") k++;
            k++;
          }
        }
        k++;
      }
      word += s.slice(i, Math.min(k + 1, n));
      i = Math.min(k + 1, n);
      continue;
    }
    if (ch === "`") {
      quoted = true;
      const end = s.indexOf("`", i + 1);
      const stop = end === -1 ? n : end;
      word += s.slice(i, stop + 1);
      i = stop + 1;
      continue;
    }
    if (/\s/.test(ch) || OPERATOR_CHARS.includes(ch)) break;
    word += ch;
    i++;
  }
  return { token: { word, quoted }, end: i };
}

/** 找最长算子:三字符 → 两字符 → 单字符(顺序即优先级)。 */
function readOperatorAt(s: string, i: number): string {
  for (const len of [3, 2, 1]) {
    const candidate = s.slice(i, i + len);
    if (candidate.length < len) continue;
    if (["&>>", "<<<", "<<-"].includes(candidate)) return candidate;
    if (len !== 3 && [">>", "<<", ">&", "&>", ">|", "<>", "||", "&&"].includes(candidate)) return candidate;
  }
  return s[i]!;
}

/** 词法分析:切词、剥引号定界符、识别算子与重定向;heredoc 正文吞到定界符行。 */
function tokenize(input: string): Piece[] {
  const s = String(input ?? "");
  const pieces: Piece[] = [];
  const n = s.length;
  let i = 0;

  while (i < n) {
    const ch = s[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "#") {
      const nl = s.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }

 // fd 粘连:前一个 piece 是紧跟的单数字词且中间无空白 → 该数字是重定向 fd
    const last = pieces[pieces.length - 1];
    const stickyFd =
      i > 0 && /\d/.test(s[i - 1]!) && last !== undefined && last.kind === "word" && last.token.word === s[i - 1];

    const op = OPERATOR_CHARS.includes(ch) ? readOperatorAt(s, i) : "";
    if (op !== "") {
      const fd = stickyFd ? Number(s[i - 1]) : undefined;
      i += op.length;
      if (op === ";" && s[i] === ";") i++; // ;; (case 内)当两个分界

      const isRedirect =
        op === ">" || op === ">>" || op === ">|" || op === "<>" || op === "&>" || op === "&>>" || op === ">&" || op === "<"
        || op === "<<" || op === "<<-" || op === "<<<";
      if (!isRedirect) {
        pieces.push({ kind: "op", text: op });
        continue;
      }

      if (stickyFd && last !== undefined && last.kind === "word") pieces.pop(); // fd 数字从词列表摘出

      if (op === "<<" || op === "<<-") {
 // heredoc:读定界符词,再吞正文到定界符行(整体不进 pieces)
        while (i < n && /\s/.test(s[i]!)) i++;
        const delimStart = i;
        while (i < n && !/\s/.test(s[i]!) && !OPERATOR_CHARS.includes(s[i]!)) i++;
        const delim = s.slice(delimStart, i);
        if (delim !== "") {
          while (i < n) {
            const nl = s.indexOf("\n", i);
            if (nl === -1) break;
            const nextNl = s.indexOf("\n", nl + 1);
            const lineEnd = nextNl === -1 ? n : nextNl;
            let line = s.slice(nl + 1, lineEnd);
            if (op === "<<-") line = line.replace(/^\t+/, "");
            i = lineEnd + 1;
            if (line === delim) break;
          }
        }
        pieces.push({ kind: "redirect", op, fd, target: undefined });
        continue;
      }

 // 普通重定向:吃目标词
      while (i < n && /\s/.test(s[i]!)) i++;
      if (i < n && !OPERATOR_CHARS.includes(s[i]!)) {
        const { token, end } = readWordAt(s, i);
        i = end;
        pieces.push({ kind: "redirect", op, fd, target: token });
      } else {
        pieces.push({ kind: "redirect", op, fd, target: undefined });
      }
      continue;
    }

    const { token, end } = readWordAt(s, i);
    i = end;
    if (token.word !== "" || token.quoted) pieces.push({ kind: "word", token });
  }
  return pieces;
}

/** 写命令表:命令名 → 判定(argv 为命令字之后的实参词)。 */
const WRITE_COMMANDS: Readonly<Record<string, (argv: string[]) => boolean>> = {
  sed: (argv) => argv.some((a) => /^(-[A-Za-z]*i|--in-place(=.*)?)$/.test(a)),
  tee: (argv) => operandsOf(argv).some((f) => !harmlessTarget(f)),
  dd: (argv) =>
    argv.some((a) => {
      const m = /^of=(.*)$/.exec(a);
      return m !== null && m[1] !== "" && !harmlessTarget(m[1]!);
    }),
  truncate: (argv) => operandsOf(argv).length > 0,
  install: () => true,
  patch: () => true,
  cp: (argv) => operandsOf(argv).length >= 2,
};

/** 实参里的操作数(剥选项;`--` 之后全是操作数)。本组写命令的选项都不带独立参数值。 */
function operandsOf(argv: string[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k]!;
    if (a === "--") {
      out.push(...argv.slice(k + 1));
      break;
    }
    if (a.startsWith("-")) continue;
    out.push(a);
  }
  return out;
}

/** 命令字识别时可跳过的前缀(env/nohup/nice/time/command/exec/sudo + VAR=val 赋值)。 */
const WRAPPER_PREFIXES: ReadonlySet<string> = new Set<string>(["env", "nohup", "nice", "time", "command", "exec", "sudo"]);

/** 一个简单命令(词序列)是否命中写命令表。 */
function simpleCommandWrites(tokens: ShellToken[]): boolean {
  if (tokens.length === 0) return false;
  let k = 0;
  while (k < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[k]!.word)) k++;
  let name = tokens[k]?.word ?? "";
  let guard = 0;
  while (WRAPPER_PREFIXES.has(name) && guard++ < 4) {
    k++;
    while (k < tokens.length && (tokens[k]!.word.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[k]!.word))) k++;
    name = tokens[k]?.word ?? "";
  }
  const judge = WRITE_COMMANDS[name];
  if (judge === undefined) return false;
  return judge(tokens.slice(k + 1).map((t) => t.word));
}

/**
 * true = 命令含「写文件/原地改文件」形态(需要过 plan-gate)。
 * v2:shell 词法解析(引号/变量/heredoc/fd 重定向),不再对原始串跑正则。
 */
export function terminalLooksLikeWrite(command: string): boolean {
  const pieces = tokenize(command);
 // 1) 重定向:目标是真实文件 → 写。fd 复用(`>&N`/`2>&1`)与读方向(`<`/heredoc)不算。
  for (const piece of pieces) {
    if (piece.kind !== "redirect") continue;
    const { op, target } = piece;
    if (op === "<" || op === "<<" || op === "<<-" || op === "<<<") continue;
    if (op === ">&") continue; // fd 复制(2>&1 / >&2)
    if (target === undefined) continue;
    if (harmlessTarget(target.word)) continue;
    return true;
  }
 // 2) 写命令:按简单命令切分(|/&&/||/;/&/ 都是边界),看命令字与实参
  let argv: ShellToken[] = [];
  const flush = (): boolean => {
    const writes = simpleCommandWrites(argv);
    argv = [];
    return writes;
  };
  for (const piece of pieces) {
    if (piece.kind === "word") {
      argv.push(piece.token);
      continue;
    }
    if (piece.kind === "redirect") continue;
    if (flush()) return true;
  }
  return flush();
}

/**
 * 兼容导出(v1 的剥除函数):v2 不再需要「先剥再匹配」,保留给既有测试与调用方。
 * 语义不变:剥 /dev/null 与 fd 复制、剥引号字面量。
 */
export function stripHarmlessRedirects(command: string): string {
  return String(command ?? "")
    .replace(/\d?&?>\s*\/dev\/null\b/g, " ")
    .replace(/\d?>\s*&\s*\d+/g, " ")
    .replace(/'(?:[^'\\]|\\.)*'/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"/g, " ");
}
