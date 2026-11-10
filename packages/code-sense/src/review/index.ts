/**
 * code_review 引擎:diff 收集(确定性)→确定性检查+反模式→LLM 深审
 * (多轮编排 rounds+防幻觉 filter+定位降级 resolver+规则引擎 rules)+ocr CLI 层(opt-in)
 * +行级回写(sticky 店)。五件引擎在主链的装配点=codeReview()。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { detectCli, runCliReview, toFindings } from "./cli-engine";
import { multiroundReview, type RoundResult } from "./rounds";
import { filterFindings } from "./filter";
import { GitNoteWriteback, loadStore } from "./writeback";
import { checkFindingRefs, orphanNote, sweepStoreOrphans, type StoreSweepResult, type OrphanCheckResult } from "./review-orphans";
import type { LlmRelocate } from "./resolver";
import { loadIndex, querySymbol } from "../callgraph/c2f";
import { collectScanTarget, SCAN_DEFAULTS, type ScanOptions, type ScanStats } from "./scan";
import {
  compareSessions, loadReviewSession, saveReviewSession, ReviewSessionError,
  type ReviewSession, type SessionCompare, type SessionTargetMeta,
} from "./session";
import { SCAN_REVIEW_PROMPT } from "./prompt";
import { decideDeepReview, type LlmPolicy } from "./policy";

const execFileP = promisify(execFile);

// ---- diff 收集( §2.1) ----
export interface ReviewFile { path: string; status: string; diffText: string; /** scan 模式:原文件内容(深审上下文直接用)。 */ content?: string }
export interface ReviewTarget {
  kind: "uncommitted" | "commit" | "branch" | "scan";
  files: ReviewFile[];
  totalLines: number;
  truncated: boolean;
  /** fixG1:任务变更集基线(checkpoint sha)——在场=本 diff 只含该基线之后的改动,不含共享工作区里更早的在途改动。 */
  baseSha?: string;
  /** fixG1:基线不可用(sha 失效/非 git 仓)回退全仓未提交 diff 的原因——如实标注,不静默。 */
  baseFallback?: string;
  /** scan 模式统计(候选/过滤/截断/预算;diff 模式缺省)。 */
  scan?: ScanStats;
}

const DIFF_BUDGET = 200 * 1024;

/** fixG1:baseSha=任务开工 checkpoint(git stash create 的悬空 commit)。
 * 在场且有效→diff 基线=该 sha(git diff <sha> = 工作区相对快照,含已暂存),只审本任务变更集,
 * 不把共享工作区里更早的在途改动(别的 agent 的)滚进来;sha 失效(128)→回退全仓未提交并如实标注。
 * untracked 收集两条路径共用(照旧)。 */
export async function collectReviewTarget(root: string, target?: string, baseSha?: string): Promise<ReviewTarget> {
  let kind: ReviewTarget["kind"] = "uncommitted";
  let diff = "";
  let usedBase = "";
  let baseFallback = "";
  if (!target) {
    kind = "uncommitted";
    // fixG1:checkpoint 基线优先(多 agent 共享工作区时,review 只审本任务变更集)。
    if (baseSha && /^[0-9a-f]{7,40}$/.test(baseSha)) {
      try {
        diff = await git(root, ["diff", baseSha]);
        usedBase = baseSha;
      } catch {
        // fixG1 追加:回退口径要提醒甄别归属(全仓 diff 混并行会话在途改动,findings 不全归本任务)。
        baseFallback = `checkpoint 基线 ${baseSha.slice(0, 10)} 不可用,已回退全仓未提交 diff(含并行会话在途改动,findings 需甄别归属)`;
      }
    }
    if (!usedBase) {
      // 不吞环境错误:非 git 根(code 128)要抛出去(fail-visible),无差异(code 1)才是空串。
      const [unstaged, staged] = await Promise.all([
        git(root, ["diff"]), git(root, ["diff", "--cached"]),
      ]);
      diff = unstaged + staged;
    }
 // 未跟踪文件( §2.1):新生文件根本不进 git diff,必须从 status 收集,
    // 否则「新写的文件零审查」。伪 diff 形态(全部 + 行)让下游确定性/LLM/定位层无感。
    try {
      const st = await git(root, ["status", "--porcelain", "-uall"]);
      const untracked = st.split("\n")
        .map((l) => (l.startsWith("?? ") ? l.slice(3).trim() : ""))
        .filter((p) => p && !/(^|\/)\./.test(p) && !/(^|\/)(dist|build|node_modules|\.venv|__pycache__)\//.test(p));
      for (const p of untracked.slice(0, 30)) {
        const raw = await readFile(join(root, p), "utf-8").catch(() => "");
        if (!raw) continue;
        const lines = raw.split("\n").slice(0, 400);
        diff += `diff --git a/${p} b/${p}\nnew file mode 100644\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => "+" + l).join("\n")}\n`;
      }
    } catch { /* status 失败不阻塞(降级为仅 diff 可审) */ }
  } else if (/^[0-9a-f]{7,40}$/.test(target)) {
    kind = "commit";
    diff = await git(root, ["show", target, "--format="]);
  } else {
    kind = "branch";
    diff = await git(root, ["diff", `${target}...HEAD`]);
  }

  let truncated = false;
  if (diff.length > DIFF_BUDGET) {
    truncated = true;
    diff = diff.slice(0, DIFF_BUDGET);
  }
  // 解析 diff → 文件条目
  const files: ReviewFile[] = [];
  let cur: ReviewFile | null = null;
  for (const line of diff.split("\n")) {
    const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (m) {
      if (cur) files.push(cur);
      cur = { path: m[2]!, status: "modified", diffText: line + "\n" };
      continue;
    }
    if (cur) {
      if (/^new file mode/.test(line)) cur.status = "added";
      if (/^deleted file mode/.test(line)) cur.status = "deleted";
      cur.diffText += line + "\n";
    }
  }
  if (cur) files.push(cur);
  const totalLines = files.reduce((n, f) => n + f.diffText.split("\n").length, 0);
  return { kind, files, totalLines, truncated, ...(usedBase ? { baseSha: usedBase } : {}), ...(baseFallback ? { baseFallback } : {}) };
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    if ((err as { code?: number }).code === 1 && args[0] === "diff") return ""; // 无差异
    throw err;
  }
}

// ---- 确定性检查层( §2.2,零 LLM) ----
export interface Finding {
  file: string;
  line: number;
  severity: "blocker" | "warning" | "nit";
  title: string;
  detail: string;
  scenario?: string;
  /** LLM 逐字摘录的 diff 代码行(resolver 定位三级降级的锚点)。 */
  anchorText?: string;
 /** 来源层(缺省=确定性/LLM 混合的旧语义;cli=外部评审 CLI 子进程, 二期)。 */
  source?: "deterministic" | "antipattern" | "cli" | "llm";
}

/** 凭证形态表(修:原 CRED_RE 的 sk- 分支字符类不含连字符,OpenAI
 * sk-proj-、sk-live-、Anthropic sk-ant- 主流形态全漏检——经验证 sk-live-<20 位尾段> /
 * sk-proj-<20 位尾段> 均 MISS)。
 * 取舍:**保守不误报**优先。sk- 家族拆三条:
 *   R1 已知前缀形态(sk-proj-/sk-live-/sk-ant-…):头段白名单 + 尾段容忍连字符/下划线;
 *   R2 旧 OpenAI 纯字母数字形态(20+ 位);
 *   R3 通用「一段前缀 + 长尾」形态(尾段纯字母数字 ≥16,不含连字符);
 * 这样覆盖三个经验证 MISS 样例,同时 `sk-learn-tutorial-slides-2024` 这类普通词串(多段连字符、
 * 尾段不够长)不命中——把 [A-Za-z0-9_-]{20,} 无差别放宽会误报。
 * 注:注释与测试里一律不写完整可命中的样例字面量(review-cred.test.ts 运行时拼接),否则本仓
 * 自己的 review 会把本文件报成凭证入库。 */
export const CRED_PATTERNS: { name: string; re: RegExp }[] = [
  // R1:sk-proj-…/sk-live-…/sk-ant-api03-…(头段白名单,尾段可含 - 与 _)
  { name: "sk-前缀形态", re: /\bsk-(?:proj|live|test|ant|svcacct|admin)(?:-[a-z0-9]{2,8})?-[A-Za-z0-9_-]{16,}/ },
  // R2:sk-<20+ 位字母数字>(旧 OpenAI 形态)
  { name: "sk-字母数字形态", re: /\bsk-[A-Za-z0-9]{20,}/ },
  // R3:sk-<一段>-<长尾字母数字 ≥16>(通用,覆盖 sk-live-<长尾> 类形态)
  { name: "sk-连字符形态", re: /\bsk-[A-Za-z0-9]{1,20}-[A-Za-z0-9]{16,}/ },
  // dashscope/百炼 ak-
  { name: "ak-形态", re: /\bak-[A-Za-z0-9]{20,}/ },
  // 腾讯云 SecretId
  { name: "AKID 形态", re: /\bAKID[A-Za-z0-9]{13,}/ },
  // Slack bot/user/app token
  { name: "xox[bpa]- 形态", re: /\bxox[bpa]-[0-9A-Za-z-]{10,}/ },
  // Google API key(AIza + 35 位)
  { name: "AIza 形态", re: /\bAIza[A-Za-z0-9_-]{35}/ },
  { name: "PEM 私钥", re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "ghp_ 形态", re: /\bghp_[A-Za-z0-9]{30,}/ },
];

/** 命中首个凭证形态的 name(无命中=null)。detail 文案据此说明命中了哪种形态。 */
export function credentialHit(text: string): string | null {
  for (const p of CRED_PATTERNS) if (p.re.test(text)) return p.name;
  return null;
}

export function deterministicFindings(t: ReviewTarget): Finding[] {
  const out: Finding[] = [];
  for (const f of t.files) {
 // 凭证红线( CRED_RE→CRED_PATTERNS:多形态逐条匹配,命中即 blocker)
    for (const cred of CRED_PATTERNS) {
      if (cred.re.test(f.diffText)) {
        out.push({
          file: f.path, line: 1, severity: "blocker",
          title: "疑似凭证入库",
          detail: `diff 中出现 API key/私钥/JWT 形态内容(${cred.name})`,
          scenario: "任何包含该 diff 的提交都会泄露凭证",
        });
        break;
      }
    }
    // 生成物混入
    if (/(^|\/)(dist|build|node_modules|\.venv)\//.test(f.path)) {
      out.push({
        file: f.path, line: 1, severity: "blocker",
        title: "构建产物/依赖目录混入变更",
        detail: "生成物不应进版本管理",
        scenario: "每次构建产生噪声 diff,污染审查与 blame",
      });
    }
    // 调试残留(新增行)
    const added = f.diffText.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    for (let i = 0; i < added.length; i++) {
      const l = added[i]!;
      if (/console\.(?:log|debug)\(|System\.out\.print|\bprint\(/.test(l) && !/\/\/ ?(eslint|ts-expect)/.test(l)) {
        out.push({
          file: f.path, line: 1, severity: "nit",
          title: "疑似调试输出残留",
          detail: `新增行: ${l.slice(1, 80).trim()}`,
          scenario: "仅当该输出非有意日志",
        });
        break; // 每文件一条
      }
    }
    // 超大单文件
    if (f.diffText.split("\n").length > 2000) {
      out.push({
        file: f.path, line: 1, severity: "warning",
        title: "单文件 diff 超 2000 行",
        detail: "建议拆分变更便于审查",
        scenario: "大 diff 审查质量必然下降",
      });
    }
  }
  return out;
}

// ---- LLM 深审层( §2.3 + 五件引擎装配) ----
export interface ReviewLlm {
  chat(prompt: string): Promise<{ content: string }>;
}

/** 变更符号影响面(code_sense c2f 索引派生,注入深审 prompt)。 */
export interface ImpactInfo { symbol: string; upstream: string[]; downstream: string[] }

/** 上下文包:diff + 变更文件全文(截断)+ 约定文件 + code_sense 影响面。 */
async function buildReviewContext(root: string, t: ReviewTarget, impact?: ImpactInfo[]): Promise<string> {
  let ctx = `## Diff (${t.kind}${t.truncated ? ",已截断" : ""})\n`;
  for (const f of t.files.slice(0, 20)) {
    ctx += `\n### ${f.path} (${f.status})\n\`\`\`diff\n${f.diffText.slice(0, 8000)}\n\`\`\`\n`;
    if (f.status !== "deleted") {
      const full = await readFile(join(root, f.path), "utf-8").catch(() => "");
      if (full) ctx += `<details file="${f.path}">\n${full.slice(0, 6000)}\n</details>\n`;
    }
  }
  for (const conv of ["AGENTS.md", "CONVENTIONS.md"]) {
    const c = await readFile(join(root, conv), "utf-8").catch(() => "");
    if (c) ctx += `\n### 约定 ${conv}\n${c.slice(0, 3000)}\n`;
  }
  if (impact?.length) {
    ctx += `\n### 变更符号影响面(code_sense)\n`;
    for (const i of impact) {
      ctx += `符号 ${i.symbol}:\n- 上游调用点: ${i.upstream.slice(0, 10).join("; ") || "无"}\n- 下游: ${i.downstream.slice(0, 10).join("; ") || "无"}\n`;
    }
  }
  return ctx;
}

const ADDED_SYMBOL_RE = /^\+\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|interface|type)\s+([A-Za-z_$][\w$]*)/;

/** diff 新增导出符号提取(去重,按出现序,cap 上限)。 */
export function changedSymbols(t: ReviewTarget, cap = 20): string[] {
  const names: string[] = [];
  for (const f of t.files) {
    for (const line of f.diffText.split("\n")) {
      const m = ADDED_SYMBOL_RE.exec(line);
      if (m && !names.includes(m[1]!)) names.push(m[1]!);
      if (names.length >= cap) return names;
    }
  }
  return names;
}

/** 影响面派生:diff 新增导出符号 → c2f 静态索引查上下游(索引缺席/无符号=空,不阻塞审查)。 */
export function deriveImpact(root: string, t: ReviewTarget, maxSymbols = 3): ImpactInfo[] {
  const idx = loadIndex(root);
  if (!idx) return [];
  const out: ImpactInfo[] = [];
  for (const name of changedSymbols(t)) {
    if (out.length >= maxSymbols) break;
    const hits = querySymbol(idx, name);
    if (!hits.length) continue;
    const h = hits[0]!;
    out.push({
      symbol: name,
      upstream: h.callers.map((c) => `${c.file}:${c.line} ${c.name}`),
      downstream: h.callees.map((c) => `${c.file}:${c.line} ${c.name}`),
    });
  }
  return out;
}

/** LLM 重定位第四级(把注入的 llm 包成 resolver 的 relocate 回调;三闸在 resolver 侧)。 */
function llmRelocateFrom(llm: ReviewLlm): LlmRelocate {
  return async (finding, files) => {
    const prompt = `代码审查发现无法在 diff 中定位,请给出它最可能所在的位置。
发现: [${finding.file}:${finding.fallbackLine}] ${finding.anchorText.slice(0, 200)}
候选文件(diff 摘录):
${files.map((f) => `### ${f.path}\n\`\`\`\n${f.snippet}\n\`\`\``).join("\n")}
输出严格 JSON: {"path":"候选中的文件路径","line":行号,"confidence":0到1} — 不确定就 confidence 给 0。只输出 JSON。`;
    const r = await llm.chat(prompt);
    const parsed = JSON.parse(r.content.trim().replace(/^```json\s*|\s*```$/g, "")) as { path?: string; line?: number; confidence?: number };
    if (!parsed.path || typeof parsed.line !== "number") return null;
    return { path: parsed.path, line: parsed.line, confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0 };
  };
}

// ---- 全文件扫描深审:分批 + 总 token 预算扣减 ----
export interface ScanDeepReport {
  /** 实际派发的批次数。 */
  batches: number;
  /** 实际送进 LLM 上下文的文件数。 */
  filesReviewed: number;
  /** 因总 token 预算耗尽而整批跳过的文件数(如实登记)。 */
  filesSkippedByBudget: number;
  /** 单文件超过 llmFileChars 被上下文截断的文件数。 */
  llmTruncatedFiles: number;
  /** 深审累计估算 token(字符/4)。 */
  estimatedTokens: number;
}

/** 扫描批规划:按每文件上下文上限与批上限切批(单文件超批上限时独占一批)。 */
export function planScanBatches(files: ReviewFile[]): ReviewFile[][] {
  const batches: ReviewFile[][] = [];
  let cur: ReviewFile[] = [];
  let chars = 0;
  for (const f of files) {
    const part = Math.min(f.content?.length ?? f.diffText.length, SCAN_DEFAULTS.llmFileChars);
    if (cur.length && (cur.length >= SCAN_DEFAULTS.batchFiles || chars + part > SCAN_DEFAULTS.batchChars)) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(f);
    chars += part;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/** 扫描上下文包(全文件;超长截断并标注,由 ScanDeepReport 计数)。 */
export function buildScanContext(files: ReviewFile[], batchIndex: number, batchTotal: number): { context: string; chars: number; truncated: number } {
  let ctx = `## 全文件扫描(第 ${batchIndex}/${batchTotal} 批,${files.length} 文件)\n`;
  let chars = 0;
  let truncated = 0;
  for (const f of files) {
    const full = f.content ?? f.diffText;
    const cut = full.length > SCAN_DEFAULTS.llmFileChars;
    if (cut) truncated++;
    const body = cut ? full.slice(0, SCAN_DEFAULTS.llmFileChars) : full;
    const note = cut ? ` truncated="true" 原文 ${full.length} 字符,仅前 ${SCAN_DEFAULTS.llmFileChars}` : "";
    ctx += `\n<file path="${f.path}"${note}>\n${body}\n</file>\n`;
    chars += body.length;
  }
  return { context: ctx, chars, truncated };
}

// ---- 行级回写(二期,sticky 店:<root>/.genie/review-comments.json) ----
export interface ReviewWritebackReport { posted: number; resolved: number; reopened: number; unchanged: number; storePath: string }

function syncWriteback(root: string, findings: Finding[]): ReviewWritebackReport | undefined {
  if (findings.length === 0) return undefined; // 零发现不建店
  try {
    const r = new GitNoteWriteback(join(root, ".genie", "review-comments.json")).sync(findings);
    return { posted: r.posted.length, resolved: r.resolved.length, reopened: r.reopened.length, unchanged: r.unchanged, storePath: r.storePath };
  } catch {
    return undefined; // 店文件损坏/只读盘:回写失败不阻塞审查
  }
}

function wbNote(wb: ReviewWritebackReport | undefined): string {
  return wb ? `;行级回写 +${wb.posted} 新增/${wb.resolved} 已解决/${wb.reopened} 复现` : "";
}

export interface CodeReviewResult {
  findings: Finding[];
  summary: string;
  deterministic: Finding[];
  antipatterns: Finding[];
  target: ReviewTarget;
  writeback?: ReviewWritebackReport;
  rounds?: RoundResult[];
  graceRoundRan?: boolean;
 /** 引用孤儿检查:拒收的幻影引用+行号夹紧计数;有脏才带此字段。 */
  orphanCheck?: OrphanCheckResult;
 /** 回写店孤儿对账:文件已删/改名的 sticky 条目,只报不删。 */
  storeOrphans?: StoreSweepResult;
 /** scan 模式统计。 */
  scan?: ScanStats;
  /** scan 深审分批/预算统计(仅 scan + LLM 深审时)。 */
  scanDeep?: ScanDeepReport;
 /** 本次 review 落盘的会话。 */
  session?: { id: string; path: string; baseline?: string; resumedFrom?: string };
  /** --resume/--compare 的四态对比(基线会话存在时)。 */
  compare?: SessionCompare;
}

export interface ReviewSessionOptions {
  /** 对比基线(会话 id);缺失/类型不一致=fail-visible(ReviewSessionError)。 */
  baseline?: string;
  /** --resume 血缘:本会话续跑自哪个会话(与 baseline 同值,session 文件可追溯)。 */
  resumedFrom?: string;
  /** 显式关会话落盘(默认 true:每次 review 都落 `.genie/reviews/<id>.json`)。 */
  save?: boolean;
}

function scanSkipTotal(s: ScanStats): number {
  return Object.values(s.skipped).reduce((n, v) => n + v, 0);
}

/** 总入口:确定性层+反模式层必跑+行级回写;LLM 深审=多轮编排+防幻觉+定位降级;CLI 层 opt-in(env GENIE_REVIEW_CLI / opts.reviewCli,cli:false 显式关)。
 * opts.scan 走全文件扫描(kind=scan);每次 review 落会话,opts.session.baseline 出四态对比。 */
export async function codeReview(
  root: string,
  opts: {
    target?: string;
    /** fixG1:任务变更集基线(checkpoint sha)——仅 target 缺席时生效;见 collectReviewTarget。 */
    baseSha?: string;
    llm?: ReviewLlm;
    impact?: ImpactInfo[];
    reviewCli?: string;
    /** 显式关 CLI 层(验收钩子等免费路径用:ocr 本身是 LLM agent loop,不随 env 自动激活)。 */
    cli?: boolean;
    maxRounds?: number;
    customRules?: { pattern: string; checklist: string }[];
    /** 全文件扫描配置(在场即 scan 模式;target 忽略)。 */
    scan?: ScanOptions;
    /** 会话落盘/续跑/比较。 */
    session?: ReviewSessionOptions;
 /** 深审策略( O1):always=恒深审(缺省,旧行为);never=只跑免费层;auto=免费层 0 blocker
     * 且变更集小则跳过并显式写进 summary。缺席=旧行为(llm 在场即深审)。 */
    llmPolicy?: LlmPolicy;
  } = {},
): Promise<CodeReviewResult> {
  const isScan = opts.scan !== undefined;
  const t = isScan ? await collectScanTarget(root, opts.scan!) : await collectReviewTarget(root, opts.target, opts.baseSha);
  // fixG1:基线标注进 summary(在场=本任务变更集;回退=如实说不含基线)——读者第一眼知道审的是什么口径。
  const baseNote = t.baseSha
    ? `;基线=任务 checkpoint ${t.baseSha.slice(0, 10)}(只含本任务开工后的变更,不含共享工作区更早的在途改动)`
    : t.baseFallback
      ? `;⚠ ${t.baseFallback}`
      : "";

  // 基线会话先校验(缺失/类型不符在烧 LLM 前 fail-visible)
  if (opts.session?.baseline) {
    const baseline = loadReviewSession(root, opts.session.baseline);
    if (!baseline) throw new ReviewSessionError(`基线会话不存在: ${opts.session.baseline}(用 --sessions 查看本仓会话)`);
    if (baseline.kind !== t.kind) {
      throw new ReviewSessionError(`会话类型不一致: 基线=${baseline.kind}, 当前=${t.kind}(scan 与 diff 的 findings 不可对比)`);
    }
  }

  const det = deterministicFindings(t);
  // 反模式八类(确定性部分;孤独逻辑/另起炉灶走 grep)。diff 语义对全文件扫描不成立 → scan 跳过。
  let anti: Finding[] = [];
  let modeNote = "";
  if (!isScan) {
    const { detectAntipatterns } = await import("./antipatterns");
    try { anti = await detectAntipatterns(root, t); } catch { anti = []; /* 反模式检测失败不阻塞审查 */ }
  } else {
    modeNote = "scan 模式不跑 diff 语义反模式确定性层(深审提示词维度保留)";
  }
  // OCR CLI 层(opt-in:bin 显式给出且 detect 过才跑;失败可见(进 summary)但不阻塞主链)。scan 无 diff 目标 → 跳过。
  let cli: Finding[] = [];
  let cliNote = "";
  if (isScan) {
    cliNote = "scan 模式不跑 ocr CLI 层";
  } else {
    const cliBin = opts.cli === false ? undefined : (opts.reviewCli ?? process.env.GENIE_REVIEW_CLI);
    if (cliBin) {
      if (detectCli(cliBin)) {
        try {
          cli = toFindings(await runCliReview(
            cliBin,
            { kind: t.kind as "uncommitted" | "commit" | "branch", ...(t.kind === "commit" ? { commit: opts.target } : t.kind === "branch" ? { from: opts.target } : {}) },
            { cwd: root },
          ));
        } catch (err) {
          cliNote = `评审 CLI 失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else {
        cliNote = `GENIE_REVIEW_CLI 已设置但二进制不可用: ${cliBin}`;
      }
    }
  }
  const baseRaw = [...det, ...anti, ...cli];
 // O1:深审策略闸——免费层(确定性+反模式+CLI)已跑完才决定是否烧 LLM。
 // 经验证:干净小变更上深审跑满 8 分钟时间盒且零新增,纯烧钱;auto 档据此跳过并显式写进 summary。
  // scan 模式不做 auto 跳过(小变更门针对 diff 变更集;scan 自带分批+token 预算闸)。
  const policy: LlmPolicy = opts.llmPolicy ?? "always";
  const decision = decideDeepReview(isScan && policy === "auto" ? "always" : policy, {
    files: t.files.length,
    totalLines: t.totalLines,
    blocking: baseRaw.filter((f) => f.severity === "blocker").length,
  });
  /** 本次实际可用的深审 LLM(策略闸未放行=undefined,后续分支按「无 LLM」路径走)。 */
  const effLlm = opts.llm && decision.run ? opts.llm : undefined;
  /** 策略说明(仅在注入了 LLM 时附加——无 llm 的调用方 summary 已有「未注入 LLM」口径)。 */
  const policyNote = opts.llm ? `;${decision.note}` : "";

  const targetMeta = (): SessionTargetMeta => ({
    kind: t.kind,
    ...(opts.target && !isScan ? { target: opts.target } : {}),
    ...(t.baseSha ? { baseSha: t.baseSha } : {}),
    ...(opts.scan ? { scan: opts.scan } : {}),
    files: t.files.map((f) => ({ path: f.path, status: f.status })),
    totalLines: t.totalLines,
    truncated: t.truncated,
    ...(t.scan ? { scanStats: t.scan } : {}),
  });

  /** 会话落盘(失败 fail-soft 不阻塞审查;基线错误仍抛出)。 */
  const finalizeSession = (findings: Finding[], summary: string): Pick<CodeReviewResult, "session" | "compare"> => {
    if (opts.session?.save === false) return {};
    try {
      const saved = saveReviewSession(root, {
        kind: t.kind,
        target: targetMeta(),
        findings,
        summary,
        ...(opts.session?.baseline ? { baseline: opts.session.baseline } : {}),
        ...(opts.session?.resumedFrom ? { resumedFrom: opts.session.resumedFrom } : {}),
      });
      const out: Pick<CodeReviewResult, "session" | "compare"> = {
        session: {
          id: saved.session.id,
          path: saved.path,
          ...(saved.session.baseline ? { baseline: saved.session.baseline } : {}),
          ...(saved.session.resumedFrom ? { resumedFrom: saved.session.resumedFrom } : {}),
        },
      };
      if (opts.session?.baseline) out.compare = compareSessions(root, opts.session.baseline, saved.session);
      return out;
    } catch (err) {
      if (err instanceof ReviewSessionError) throw err;
      return {}; // 只读盘/损坏:会话落盘失败不阻塞审查
    }
  };

  const scanPrefix = t.scan
    ? `全文件扫描 ${t.files.length} 文件/${t.totalLines} 行(候选 ${t.scan.candidateFiles},合格 ${t.scan.eligibleFiles},过滤/跳过 ${scanSkipTotal(t.scan)},截断 ${t.scan.truncatedCount}${t.scan.budgetExceeded ? ",估算超预算" : ""})`
    : "";

 // 引用孤儿检查(board-store 边引用完整性同律):四源合一后统一过闸,
  // 幻觉路径/越界路径拒收(fail-visible 计数),越界行号夹紧,deleted 文件按 diff 独引收录。
  // 闸在回写店之前——幻影路径不进店,各模块不再各玩各的数据。
  // 无 LLM:闸确定性三源即出口;深审:闸合并后全集(一次覆盖四源,计数不重不漏)。
  if (!effLlm) {
    const gate0 = checkFindingRefs(root, t, baseRaw);
    const wb = isScan ? undefined : syncWriteback(root, gate0.kept);
    const storeOrphans = wb ? sweepStoreAfterSync(root, new Set(t.files.map((f) => f.path.replace(/^\.\//, "")))) : undefined;
    const summary = isScan
      ? `${scanPrefix};确定性检查 ${det.length} 条;${modeNote};${cliNote};未注入 LLM,深度审查未运行${policyNote}${orphanNote(gate0)}`
      : `确定性+反模式检查(${det.length}+${anti.length} 条)${cli.length ? `+CLI ${cli.length} 条` : ""}${cliNote ? `;${cliNote}` : ""}${baseNote}${wbNote(wb)}${orphanNote(gate0)}${storeSweepNote(storeOrphans)};未注入 LLM,深度审查未运行${policyNote}`;
    return {
      findings: gate0.kept,
      summary,
      deterministic: det,
      antipatterns: anti,
      target: t,
      ...(t.scan ? { scan: t.scan } : {}),
      ...(wb ? { writeback: wb } : {}),
      ...(gate0.orphans.length || gate0.clamped || gate0.diffOnly ? { orphanCheck: gate0 } : {}),
      ...(storeOrphans && storeOrphans.missingFile.length ? { storeOrphans } : {}),
      ...finalizeSession(gate0.kept, summary),
    };
  }
  const llm = effLlm;

  // ---- scan 深审:分批(每批 ≤8 文件/45k 字符)+ 总 token 预算扣减;超预算整批跳过并登记 ----
  if (isScan) {
    const maxTokens = t.scan?.maxTokens ?? SCAN_DEFAULTS.maxTokens;
    const batches = planScanBatches(t.files);
    const locatedAll: (Finding & { resolution?: string })[] = [];
    const removedAll: Finding[] = [];
    const roundsAll: RoundResult[] = [];
    let graceRoundRan = false;
    let usedTokens = 0;
    let batchesRun = 0;
    let filesReviewed = 0;
    let filesSkippedByBudget = 0;
    let llmTruncatedFiles = 0;
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]!;
      const { context, chars, truncated } = buildScanContext(batch, i + 1, batches.length);
      const tokens = Math.ceil(chars / 4);
      // 首批必跑(哪怕单批已超预算,否则「深审」完全空转);后续超预算整批跳过并登记。
      if (batchesRun > 0 && usedTokens + tokens > maxTokens) {
        filesSkippedByBudget += batch.length;
        continue;
      }
      usedTokens += tokens;
      batchesRun += 1;
      filesReviewed += batch.length;
      llmTruncatedFiles += truncated;
      const mr = await multiroundReview({
        files: batch,
        llm,
        diffContext: context,
        rulesRoot: root,
        ...(opts.maxRounds !== undefined ? { maxRounds: opts.maxRounds } : {}),
        ...(opts.customRules ? { customRules: opts.customRules } : {}),
        promptOverride: SCAN_REVIEW_PROMPT,
        llmRelocate: llmRelocateFrom(llm),
      });
      const filt = await filterFindings(mr.located, context, undefined, llm);
      locatedAll.push(...filt.kept);
      removedAll.push(...filt.removed);
      roundsAll.push(...mr.rounds);
      graceRoundRan = graceRoundRan || mr.graceRoundRan;
    }
    const gate = checkFindingRefs(root, t, [...baseRaw, ...locatedAll]);
    const findings = gate.kept;
    const scanDeep: ScanDeepReport = {
      batches: batchesRun,
      filesReviewed,
      filesSkippedByBudget,
      llmTruncatedFiles,
      estimatedTokens: usedTokens,
    };
    const loc: Record<string, number> = { anchor: 0, refile: 0, fallback: 0, llm: 0, unresolved: 0 };
    for (const f of locatedAll) {
      const res = f.resolution;
      if (res && res in loc) loc[res]!++;
    }
    const deep = locatedAll.length
      ? `LLM 深审 ${batchesRun} 批 × ${roundsAll.length} 轮${graceRoundRan ? "+grace" : ""} 确认 ${locatedAll.length} 条(防幻觉删 ${removedAll.length};定位 anchor ${loc.anchor}/refile ${loc.refile}/fallback ${loc.fallback}/llm ${loc.llm}/未定位 ${loc.unresolved})`
      : `LLM 深审零新增(${batchesRun} 批,解析失败或确无问题)`;
    const summary = `${scanPrefix};${deep};预算 ${usedTokens}/${maxTokens} tokens${filesSkippedByBudget ? `,预算跳过 ${filesSkippedByBudget} 文件` : ""}${llmTruncatedFiles ? `,${llmTruncatedFiles} 文件上下文截断` : ""};${modeNote};${cliNote}${orphanNote(gate)}`;
    return {
      findings,
      summary,
      deterministic: det,
      antipatterns: anti,
      target: t,
      ...(t.scan ? { scan: t.scan } : {}),
      scanDeep,
      ...(gate.orphans.length || gate.clamped || gate.diffOnly ? { orphanCheck: gate } : {}),
      rounds: roundsAll,
      graceRoundRan,
      ...finalizeSession(findings, summary),
    };
  }

  // ---- diff 深审:上下文包 → 多轮编排(规则注入/confirmed 防重/零新增早停/grace round)
  // → 定位三级降级+LLM 第四级 → 防幻觉判删(保护主题确定性保留,宁保不删)。 ----
  const ctx = await buildReviewContext(root, t, opts.impact);
  const mr = await multiroundReview({
    files: t.files,
    llm,
    diffContext: ctx,
    rulesRoot: root,
    ...(opts.maxRounds !== undefined ? { maxRounds: opts.maxRounds } : {}),
    ...(opts.customRules ? { customRules: opts.customRules } : {}),
    llmRelocate: llmRelocateFrom(llm),
  });
  const filt = await filterFindings(mr.located, ctx, undefined, llm);
  const gate = checkFindingRefs(root, t, [...baseRaw, ...filt.kept]);
  const findings = gate.kept;
  const wb = syncWriteback(root, findings);
  const storeOrphans = wb ? sweepStoreAfterSync(root, new Set(t.files.map((f) => f.path.replace(/^\.\//, "")))) : undefined;
  const loc: Record<string, number> = { anchor: 0, refile: 0, fallback: 0, llm: 0, unresolved: 0 };
  for (const f of filt.kept) {
    const res = (f as Finding & { resolution?: string }).resolution;
    if (res && res in loc) loc[res]!++;
  }
  const deep = mr.confirmed.length
    ? `LLM 深审 ${mr.rounds.length} 轮${mr.graceRoundRan ? "+grace" : ""} 确认 ${mr.confirmed.length} 条(防幻觉删 ${filt.removed.length};定位 anchor ${loc.anchor}/refile ${loc.refile}/fallback ${loc.fallback}/llm ${loc.llm}/未定位 ${loc.unresolved})`
    : "LLM 深审零新增(解析失败或确无问题)";
  const summary = `${deep}${cliNote ? `;${cliNote}` : ""}${baseNote}${wbNote(wb)}${orphanNote(gate)}${storeSweepNote(storeOrphans)}`;
  return {
    findings,
    summary,
    deterministic: det,
    antipatterns: anti,
    target: t,
    ...(wb ? { writeback: wb } : {}),
    ...(gate.orphans.length || gate.clamped || gate.diffOnly ? { orphanCheck: gate } : {}),
    ...(storeOrphans && storeOrphans.missingFile.length ? { storeOrphans } : {}),
    rounds: mr.rounds,
    graceRoundRan: mr.graceRoundRan,
    ...finalizeSession(findings, summary),
  };
}

// ---- 引用孤儿检查接线 ----
function sweepStoreAfterSync(root: string, scope?: Set<string>): StoreSweepResult | undefined {
  try {
    // syncWriteback 命中=店文件在;读同一份做孤儿对账(只报不删,sticky 语义保留)
    return sweepStoreOrphans(root, loadStore(join(root, ".genie", "review-comments.json")), scope);
  } catch {
    return undefined;
  }
}

function storeSweepNote(s: StoreSweepResult | undefined): string {
  return s && s.missingFile.length ? `;回写店孤儿条目 ${s.missingFile.length} 条(文件已删/改名,sticky 保留待议)` : "";
}

// scan/session 能力从同一入口导出(CLI/外部调用方只依赖 `@lampgenie/code-sense/review`)。
export * from "./scan";
export * from "./session";
