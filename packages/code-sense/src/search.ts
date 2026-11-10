/**
 * L0 搜索层:grep 包装(ripgrep 优先,系统 grep 兜底)+ 标识符归一化变体。
 * 红线:路径沙箱(realpath 限制项目根)。
 * 符号优先召回:中文词典/分词/标识符切分迁到 ./search/cjk.ts(纯函数单一真相),
 * 本文件只保留 grep 通道与 normalizeQuery 变体拼装。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, relative, isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";
import { CJK_EN_DICT, cjkDomainWords } from "./retrieval/cjk";

export { cjkDomainWords };
export { segmentCjk, splitIdentifier, queryTerms, cjkToEnglish } from "./retrieval/cjk";
export type { QueryTerm, QueryTerms, QueryTermSource } from "./retrieval/cjk";

const execFileP = promisify(execFile);

export class SandboxError extends Error {
  readonly code = "sandbox";
}

/** 沙箱:target 必须在项目根内(realpath 防符号链接逃逸;不存在路径按父目录判界)。 */
export async function sandboxResolve(root: string, target: string): Promise<string> {
  const abs = isAbsolute(target) ? target : resolve(root, target);
  const realRoot = await realpath(root);
  let realAbs: string;
  try {
    realAbs = await realpath(abs);
  } catch {
    // 路径不存在:按「已存在的最近祖先」判界,仍越界则拒
    const parts = abs.split("/");
    for (let i = parts.length; i > 1; i--) {
      try {
        const anc = await realpath(parts.slice(0, i).join("/") || "/");
        const probe = anc + "/" + parts.slice(i).join("/");
        const rel = relative(realRoot, probe);
        if (rel.startsWith("..") || isAbsolute(rel)) {
          throw new SandboxError(`路径越界(限制项目根): ${target}`);
        }
        return probe;
      } catch (e) {
        if (e instanceof SandboxError) throw e;
        continue;
      }
    }
    throw new SandboxError(`路径越界或不可解析: ${target}`);
  }
  const rel = relative(realRoot, realAbs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new SandboxError(`路径越界(限制项目根): ${target}`);
  }
  return realAbs;
}

export interface GrepMatch {
  file: string;   // 相对项目根
  line: number;
  text: string;
  /** 命中的模式(focus 特异性排序用:长变体=更精确的定位信号)。 */
  pattern?: string;
}

/** 归一化变体:camelCase ↔ snake_case ↔ kebab-case( §5)。 */
/** 中文功能词 → 英文词根映射(用户用户反馈:查「总路线」只回 1 条文档命中,agent 被迫
 * 手工 grep 18 次;中文 query 无 camel/snake 变体,explore 对「按功能中文名找实现」场景失效)。
 * 确定性词表(非 LLM):通用功能域词,命中 query 中任一中文词即追加英文词根变体。
 * 词表单一真相在 ./search/cjk.ts(explore 符号召回与 wiki 切词共用,不复制)。 */

/** query 中含中文时:按词表追加英文词根。**主词根优先 + 总量封顶**:
 * grepIn 逐 pattern 起一次 rg(全仓扫描),中文问句若把词典里所有同义词(agent/auth/allow/
 * grant/proxy…)都单列,9p 大仓上经验证 pattern 18→grep 14.3s(基线 8 个 pattern≈6s)。
 * 符号优先召回之后 grep 只是补充证据,故取「每个命中中文词的主词根」+ 次词根补足到 6 个;
 * 主词根=词典数组首项(子代理→subagent/审批→approve/权限→permission),特异性最高。 */
const CJK_GREP_ROOT_MAX = 6;
function cjkExpand(q: string): string[] {
  if (!/[\u4e00-\u9fff]/.test(q)) return [];
  const primary: string[] = [];
  const secondary: string[] = [];
  const seen = new Set<string>();
  for (const [cn, ens] of CJK_EN_DICT) {
    if (!q.includes(cn)) continue;
    ens.forEach((en, i) => {
      if (seen.has(en)) return;
      seen.add(en);
      (i === 0 ? primary : secondary).push(en);
    });
  }
  const bySpecificity = (a: string, b: string): number => b.length - a.length || a.localeCompare(b);
  return [...primary.sort(bySpecificity), ...secondary.sort(bySpecificity)].slice(0, CJK_GREP_ROOT_MAX);
}

export function normalizeQuery(q: string): string[] {
  const variants = new Set<string>([q]);
  // camel → snake / kebab
  const snake = q.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  variants.add(snake);
  variants.add(snake.replace(/_/g, "-"));
  // snake → camel
  const camel = q.replace(/[-_]([a-z])/g, (_, c: string) => c.toUpperCase());
  variants.add(camel);
 // 空格多词短语拆分(用户用户反馈「tts voice audio chat 零命中」):整句短语在代码里
  // 永远 grep 不到字面量;拆成单词后按「单词|单词」逐个承载(ZC-10 逐 pattern 配额语义不变)。
  // 只拆 ≥2 词的英文短语(单词查询无意义);过短词(<3 字符,如 "ai")会洪泛,跳过。
  const words = q.trim().split(/[\s,;、]+/).filter((w) => /^[A-Za-z][A-Za-z0-9_-]{2,}$/.test(w));
  if (words.length >= 2) {
    variants.add(words.join("|")); // 词根组:任一单词命中即算(逐 pattern 配额由 grepIn 承载)
    for (const w of words) if (w.length >= 4) variants.add(w); // 高特异单词单列(tts/audio/voice/chat)
  }
  // 中文功能词 → 英文词根(词表映射;每个词根单列,保持逐 pattern 配额语义(ZC-10:不合并正则))。
 // 排序=特异性降序(符号优先):`子代理 spawn 权限审批` 的变体里 subagent/permission
  // 必须先于 agent/session 跑——grepIn 按到达序截断,通用词先跑会把定义行挤出配额。
  const cjkRoots = cjkExpand(q).sort((a, b) => b.length - a.length || a.localeCompare(b));
  for (const w of cjkRoots) variants.add(w);
  return [...variants].filter(Boolean);
}

/** 从命中行提取英文标识符(camelCase/kebab/PascalCase,≥4 字符)——explore 低命中自举二轮用:
 * 首轮「路线|roadmap」类命中里往往埋着真正的 UI 锚点(view-pipeline/act-sense),提取后再聚合一轮,
 * 等价于 agent 手工逐步试探关键词的过程(经验证用户 session 里 agent 用 18 次 grep 干的就是这个)。 */
export function extractIdentifiers(text: string, limit = 8): string[] {
  const out: string[] = [];
  const re = /[A-Za-z][A-Za-z0-9_-]{3,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.length < limit) {
    const w = m[0];
    // 过滤纯常用词(命中行里的高频英文虚词不值得二轮)
    if (!/^(true|false|null|undefined|const|return|import|export|require|function|string|number|boolean|error|async|await|this|self|test|spec)$/.test(w)) out.push(w);
  }
  return out;
}

async function grepCmd(): Promise<"rg" | "grep"> {
  try {
    await execFileP("rg", ["--version"]);
    return "rg";
  } catch {
    return "grep";
  }
}

/** 文件级命中清单(rg -l / grep -rl):只回「哪些文件含任一模式」,无行级配额截断——
 * 行级 perPattern 配额在高频字面量(如 "new Set([" 165 行)上按 rg 并行序截断,
 * 文件集合逐 run 漂移(注意:task.ts 的 TRANSITIONS 金标准被随机挤出候选)。
 * 用途=候选文件预筛(sensing 三剖面);要行级命中请用 grepIn。 */
export async function grepFilesIn(
  root: string,
  patterns: string[],
  opts: { max?: number; glob?: string } = {},
): Promise<string[]> {
  if (patterns.length === 0) return [];
  const max = opts.max ?? 1000;
  const cmd = await grepCmd();
  const out = new Set<string>();
  for (const p of patterns) {
    if (out.size >= max) break;
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
      if (cmd === "rg") {
        const { stdout } = await execFileP("rg", [
          "-l", "-g", opts.glob ?? "*.{ts,tsx,js,jsx,mjs,cjs,py,go,java,rs,md,html,vue,c,h,cc,cpp,cxx,hh,hpp,hxx,cs,kt,kts,scala,swift}",
          "--", escaped, root,
        ], { maxBuffer: 16 * 1024 * 1024 });
        for (const line of stdout.split("\n")) {
          if (!line) continue;
          out.add(relative(root, line.endsWith("\r") ? line.slice(0, -1) : line));
        }
      } else {
        const { stdout } = await execFileP("grep", [
          "-rl", "-E", `--include=*.{ts,tsx,js,jsx,mjs,cjs,py,go,java,rs,md,html,vue,c,h,cc,cpp,cxx,hh,hpp,hxx,cs,kt,kts,scala,swift}`, `--`, escaped, root,
        ], { maxBuffer: 16 * 1024 * 1024 });
        for (const line of stdout.split("\n")) {
          if (!line) continue;
          out.add(relative(root, line.endsWith("\r") ? line.slice(0, -1) : line));
        }
      }
    } catch (err) {
      // 无命中退出码 1——不是错误
      if ((err as { code?: number }).code !== 1) throw err;
    }
  }
  return [...out].slice(0, max);
}

/** 多字面量一次扫描(`rg -F -e p1 -e p2 ...`,带行号):框架指纹 14 族 × 多 pattern
 * 场景一次全仓扫描替代 40+ 次 rg( dify 经验证 157s → 秒级)。返回行级命中;
 * 调用方按行文本与文件内容回查具体模式/导入语境,避免「先截 6 个文件」漏掉非测试证据。 */
export interface MultiGrepMatch { file: string; line: number; text: string }
export async function grepMatchesAny(
  root: string,
  patterns: string[],
  opts: { max?: number; glob?: string | string[]; perFile?: number } = {},
): Promise<MultiGrepMatch[]> {
  const uniq = [...new Set(patterns)];
  if (uniq.length === 0) return [];
  const max = opts.max ?? 6000;
  const perFile = opts.perFile ?? 20;
  const globs = opts.glob === undefined
    ? ["*.{ts,tsx,js,jsx,mjs,cjs,py,go,java,rs,md,html,vue}"]
    : Array.isArray(opts.glob) ? opts.glob : [opts.glob];
  const cmd = await grepCmd();
  const out: MultiGrepMatch[] = [];
  try {
    let stdout: string;
    if (cmd === "rg") {
      const args = ["-n", "--no-heading", "-F", "-m", String(perFile)];
      for (const g of globs) args.push("-g", g); // rg 多个 -g 为叠加包含面(:构建文件裸名需要第二 glob)
      for (const p of uniq) args.push("-e", p);
      args.push("--", root);
      ({ stdout } = await execFileP("rg", args, { maxBuffer: 32 * 1024 * 1024 }));
    } else {
      const args = ["-rn", "-F", "-m", String(perFile)];
      for (const p of uniq) args.push("-e", p);
      for (const ext of ["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "java", "rs", "md", "html", "vue"]) {
        args.push("--include=*." + ext);
      }
      args.push(root);
      ({ stdout } = await execFileP("grep", args, { maxBuffer: 32 * 1024 * 1024 }));
    }
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
      const m = /^(.*):(\d+):(.*)$/.exec(clean);
      if (!m) continue;
      out.push({ file: relative(root, m[1]!), line: Number(m[2]), text: m[3]!.slice(0, 300) });
      if (out.length >= max) break;
    }
  } catch (err) {
    if ((err as { code?: number }).code !== 1) throw err;
  }
  return out;
}

/** 在 root 内 grep 模式集合(任一命中);限制文件类型为文本源码。
 * 配额按模式均分:顺序早退会让先跑的常用词模式("append")吃满全部配额,
 * 后面的特异性模式("MemoryJournal")从未执行——定义文件进不了候选(ZC-10 根因)。 */
export async function grepIn(
  root: string,
  patterns: string[],
  opts: { max?: number; glob?: string } = {},
): Promise<GrepMatch[]> {
  if (patterns.length === 0) return [];
  const max = opts.max ?? 100;
  const perPattern = Math.max(10, Math.floor(max / patterns.length));
  const cmd = await grepCmd();
  const out: GrepMatch[] = [];
  // 曾登记「合并正则优化」——经评估**不可做**:交替|合并后命中分布由文件扫描序决定,
  // 常用词模式会吃满整体配额,特异性模式(定义文件)进不了候选——正是下方按模式均分
 // 配额要防的 ZC-10 根因。逐 pattern 是承重语义,非偷懒(评估记录)。
  for (const p of patterns) {
    let taken = 0;
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
      if (cmd === "rg") {
        const { stdout } = await execFileP("rg", [
          "--no-heading", "-n", "-m", String(perPattern), "-g", opts.glob ?? "*.{ts,tsx,js,jsx,mjs,py,go,java,rs,md,html,vue}",
          "--", escaped, root,
        ], { maxBuffer: 16 * 1024 * 1024 });
        for (const line of stdout.split("\n")) {
          if (!line) continue;
 // CRLF 仓(注意):JS 正则的 `.` 不匹配 \r,行尾 \r 让 `^(.*):(\d+):(.*)$` 整行失配
          // →Windows 风格文件的命中被静默丢弃(agent_alpha 的 fastapi 命中 40→25,真路由文件漏出候选)。
          const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
          const m = /^(.*):(\d+):(.*)$/.exec(clean);
          if (m) {
            out.push({ file: relative(root, m[1]!), line: Number(m[2]), text: m[3]!.slice(0, 200), pattern: p });
            if (++taken >= perPattern) break;
          }
        }
      } else {
        const { stdout } = await execFileP("grep", [
          "-rn", "-E", `--include=*.{ts,tsx,js,py,go,java,md,html}`, `--`, escaped, root,
        ], { maxBuffer: 16 * 1024 * 1024 });
        for (const line of stdout.split("\n")) {
          const clean = line.endsWith("\r") ? line.slice(0, -1) : line; // CRLF 同 rg 分支
          const m = /^(.*?):(\d+):(.*)$/.exec(clean);
          if (m) {
            out.push({ file: relative(root, m[1]!), line: Number(m[2]), text: m[3]!.slice(0, 200), pattern: p });
            if (++taken >= perPattern) break;
          }
        }
      }
    } catch (err) {
      // grep 无命中退出码 1——不是错误
      if ((err as { code?: number }).code !== 1) throw err;
    }
  }
  return out.slice(0, max);
}
