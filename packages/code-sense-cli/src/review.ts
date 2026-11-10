/**
 * codesense review 指令:把 code-sense 自研评审引擎(packages/code-sense/src/review)
 * 封装为 CLI 形态——人(markdown)/agent(--json)双格式,CI 门禁退出码。
 * 同源纪律:本文件是薄适配,评审行为(target 解析/确定性层/反模式/深审编排/防幻觉/
 * 引用孤儿闸/行级回写店/全文件扫描/会话续跑)全部在引擎 codeReview() 单点;CLI 与
 * gateway code_review 工具共享同一引擎,差异只在包装面。
 */
import { resolve } from "node:path";
import {
  codeReview, collectReviewTarget, deriveImpact,
  ReviewSessionError, ScanPathError, listReviewSessions, loadReviewSession,
  type CodeReviewResult, type Finding, type ReviewLlm, type ReviewSession,
  type ScanOptions, type SessionCompare,
} from "@lampgenie/code-sense/review";
import { flagBool, flagStr, type ParsedArgs } from "./args.js";
import { resolveProjectRoot } from "./registry.js";
import { resolveReviewLlm } from "./review-llm.js";
import type { ResolveOpts } from "./llm-config.js";

export interface ReviewCmdResult {
  /** 人类可读 markdown(缺省输出)。 */
  text: string;
  /** --json 结构化输出。 */
  json: unknown;
  /** blocker 条数(>0 → exit 1,CI 门禁语义)。 */
  blockers: number;
}

/** root 解析:--root > 注册表就近(逐级向上) > 当前目录。
 * review 只要求 git 仓,不强制建索引(与查询指令的 index 引导不同,刻意宽化:CI 零配置)。 */
export function resolveReviewRoot(p: ParsedArgs): { root: string; source: string } {
  const explicit = flagStr(p, "root");
  if (explicit) return { root: resolve(explicit), source: "--root" };
  const hit = resolveProjectRoot(process.cwd());
  if (hit) return { root: hit.root, source: hit.source === "registry" ? "注册表" : "索引产物" };
  return { root: process.cwd(), source: "cwd" };
}

/** --rounds 解析:undefined=引擎缺省(2);"invalid"=用法错。 */
export function roundsArg(p: ParsedArgs): number | undefined | "invalid" {
  const raw = p.flags.rounds;
  if (raw === undefined) return undefined;
  if (raw === true) return "invalid";
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : "invalid";
}

/** 正整数 flag(scan 预算类):undefined=缺省;"invalid"=用法错。 */
function intArg(p: ParsedArgs, key: string): number | undefined | "invalid" {
  const raw = p.flags[key];
  if (raw === undefined) return undefined;
  if (raw === true) return "invalid";
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : "invalid";
}

/** 逗号分隔 glob 列表(--include a,b)。 */
function globList(p: ParsedArgs, key: string): string[] | undefined {
  const raw = flagStr(p, key);
  if (!raw) return undefined;
  const out = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return out.length ? out : undefined;
}

export interface ReviewCmdOpts {
  json: boolean;
  /** 测试注入:深审 LLM 桩(在场即深审,不走凭证链)。 */
  llmOverride?: ReviewLlm;
  /** 测试注入:凭证解析覆盖(透传 resolveLlmConfig 的 env/configFile,隔离真实 ~/.codesense)。 */
  llmResolve?: ResolveOpts;
}

/** --base-url/--model/--api-key 三件套 flag(flag 档;任一在场即进入解析,缺件由 resolveLlmConfig 抛)。 */
function pickLlmFlags(p: ParsedArgs): ResolveOpts["flags"] | undefined {
  const baseURL = flagStr(p, "base-url");
  const model = flagStr(p, "model");
  const apiKey = flagStr(p, "api-key");
  if (!baseURL && !model && !apiKey) return undefined;
  return {
    ...(baseURL ? { baseURL } : {}),
    ...(model ? { model } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}

/** scan 配置:显式 flag > --resume/--compare 基线会话继承(同一批文件续跑)。 */
function resolveScanOptions(
  p: ParsedArgs,
  scanPath: string | undefined,
  baseline: ReviewSession | null,
  inherit: boolean): ScanOptions {
  const base = inherit && baseline?.kind === "scan" ? baseline.target.scan : undefined;
  const include = globList(p, "include");
  const exclude = globList(p, "exclude");
  const maxFiles = intArg(p, "max-files");
  const maxTokens = intArg(p, "max-tokens");
  const maxFileBytes = intArg(p, "max-file-size");
  return {
    ...(scanPath ? { paths: [scanPath] } : base?.paths?.length ? { paths: base.paths } : {}),
    ...(include ? { include } : base?.include?.length ? { include: base.include } : {}),
    ...(exclude ? { exclude } : base?.exclude?.length ? { exclude: base.exclude } : {}),
    ...(typeof maxFiles === "number" ? { maxFiles } : base?.maxFiles !== undefined ? { maxFiles: base.maxFiles } : {}),
    ...(typeof maxTokens === "number" ? { maxTokens } : base?.maxTokens !== undefined ? { maxTokens: base.maxTokens } : {}),
    ...(typeof maxFileBytes === "number" ? { maxFileBytes } : base?.maxFileBytes !== undefined ? { maxFileBytes: base.maxFileBytes } : {}),
  };
}

export async function reviewCommand(p: ParsedArgs, opts: ReviewCmdOpts): Promise<ReviewCmdResult> {
  const rounds = roundsArg(p);
  if (rounds === "invalid") {
    throw new ReviewUsageError("--rounds 必须是 ≥1 的整数(缺省=2)");
  }
  for (const key of ["max-files", "max-tokens", "max-file-size"] as const) {
    if (intArg(p, key) === "invalid") throw new ReviewUsageError(`--${key} 必须是 ≥1 的整数`);
  }
  const { root } = resolveReviewRoot(p);

  // --sessions:只读列出本仓历史会话,不跑评审。
  if (flagBool(p, "sessions")) {
    const sessions = listReviewSessions(root);
    return {
      text: renderSessions(sessions, root),
      json: {
        command: "review",
        root,
        sessions: sessions.map((s) => ({
          id: s.id, createdAt: s.createdAt, kind: s.kind, counts: s.counts,
          files: s.target.files.length, ...(s.baseline ? { baseline: s.baseline } : {}), ...(s.resumedFrom ? { resumedFrom: s.resumedFrom } : {}),
        })),
      },
      blockers: 0,
    };
  }

  const resumeId = flagStr(p, "resume");
  const compareId = flagStr(p, "compare");
  if (resumeId && compareId) throw new ReviewUsageError("--resume 与 --compare 二选一(续跑 vs 一次性对比)");
  const baselineId = resumeId ?? compareId;
  let baseline: ReviewSession | null = null;
  if (baselineId) {
    baseline = loadReviewSession(root, baselineId);
    if (!baseline) throw new ReviewUsageError(`基线会话不存在: ${baselineId}(用 codesense review --sessions 查看本仓会话)`);
  }

  const scanRaw = p.flags.scan;
  const scanFlag = scanRaw !== undefined;
  const wantScan = scanFlag || baseline?.kind === "scan";
  if (scanFlag && baseline && baseline.kind !== "scan") {
    throw new ReviewUsageError(`--scan 与基线会话类型不一致(基线 ${baseline.id} 是 ${baseline.kind});去掉 --scan 或改用 scan 基线`);
  }
  const scanPath = typeof scanRaw === "string" ? scanRaw : (wantScan ? p._[1] : undefined);
  const scanOptions = wantScan ? resolveScanOptions(p, scanPath, baseline, Boolean(baselineId)) : undefined;
  const target = wantScan ? undefined : (p._[1] ?? baseline?.target.target);
  const deep = flagBool(p, "deep");
  const wantImpact = flagBool(p, "impact");
  if (wantScan && wantImpact) throw new ReviewUsageError("--impact 只适用于 diff 审查,不适用于 --scan");

  let llm: ReviewLlm | undefined;
  if (deep) {
    if (opts.llmOverride) {
      llm = opts.llmOverride;
    } else {
 // 凭证链 flag > env > config > ask-file(与 sensing/api 语义层同构);
      // fail-visible:--deep 缺凭证不静默降级(exit 2 由调用方按 UsageError 处理;
      // 部分凭证形态错=LlmConfigError 上抛,CLI 同档 exit 2)
      const flags = pickLlmFlags(p);
      const resolved = resolveReviewLlm({ ...opts.llmResolve, ...(flags ? { flags } : {}) });
      if (!resolved) {
        throw new ReviewUsageError(
          "--deep 需要深审凭证——凭证链 flag > env > config > ask-file(见 `codesense config` 与 docs/codesense-cli.md):\n" +
          "  ①flag: --base-url <url> --model <名> --api-key <key>(三件套一起给)\n" +
          "  ②env: GENIE_LLM_BASE_URL / GENIE_LLM_MODEL / GENIE_LLM_API_KEY(与 gateway 同名同源)\n" +
          "  ③config: codesense config set llm.baseURL/llm.model/llm.apiKey(写入 ~/.codesense/config.json,权限 600)\n" +
          "  ④ask-file: codesense config set llm.askFile.dir <目录>(宿主零配置:CLI 写 ask-*.json,宿主 agent 答 answer-*.json)\n" +
          "  不加 --deep 则只跑确定性+反模式层(零 LLM,免费)。",
        );
      }
      llm = resolved.llm;
    }
  }

  // --impact 仅随 --deep 生效(影响面注入深审上下文;无 LLM 时引擎不消费)。
  // 只读现有 c2f 索引,索引缺席=空(引擎 fail-soft),本指令从不触发索引构建。
  let impact: ReturnType<typeof deriveImpact> | undefined;
  if (deep && wantImpact && !wantScan) {
    const t0 = await collectReviewTarget(root, target);
    impact = deriveImpact(root, t0);
  }

  let r: CodeReviewResult;
  try {
    r = await codeReview(root, {
      ...(target ? { target } : {}),
      ...(scanOptions ? { scan: scanOptions } : {}),
      ...(llm ? { llm } : {}),
      ...(impact?.length ? { impact } : {}),
      ...(rounds !== undefined ? { maxRounds: rounds } : {}),
      ...(baselineId ? { session: { baseline: baselineId, ...(resumeId ? { resumedFrom: resumeId } : {}) } } : {}),
    });
  } catch (err) {
    // 扫描路径/基线会话类错误=用法档 exit 2(不是运行失败)
    if (err instanceof ScanPathError) throw new ReviewUsageError(err.message);
    if (err instanceof ReviewSessionError) throw new ReviewUsageError(err.message);
    throw err;
  }
  return { text: renderMarkdown(r, { deep }), json: renderJson(r, root, { deep }), blockers: countSeverity(r.findings, "blocker") };
}

export class ReviewUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewUsageError";
  }
}

function countSeverity(findings: Finding[], sev: Finding["severity"]): number {
  return findings.filter((f) => f.severity === sev).length;
}

const SEV_LABEL: Record<Finding["severity"], string> = { blocker: "Blocker(必须修)", warning: "Warning(应修)", nit: "Nit(建议)" };
const SOURCE_LABEL: Record<string, string> = { deterministic: "确定性", antipattern: "反模式", cli: "ocr-cli", llm: "LLM深审" };

function skippedTotal(r: CodeReviewResult): number {
  return r.scan ? Object.values(r.scan.skipped).reduce((n, v) => n + v, 0) : 0;
}

/** markdown(人读):目标/摘要/按 severity 分组的 findings 表/层明细/会话对比。 */
export function renderMarkdown(r: CodeReviewResult, opts: { deep: boolean }): string {
  const b = countSeverity(r.findings, "blocker");
  const w = countSeverity(r.findings, "warning");
  const n = countSeverity(r.findings, "nit");
  const lines: string[] = [];
  lines.push("# 代码评审报告(codesense review)");
  lines.push("");
  if (r.target.kind === "scan" && r.scan) {
    const s = r.scan;
    lines.push(`- 目标: scan · ${r.target.files.length} 文件 · ${r.target.totalLines} 行 · 候选 ${s.candidateFiles} · 合格 ${s.eligibleFiles} · 过滤/跳过 ${skippedTotal(r)} · 截断 ${s.truncatedCount} · 约 ${s.estimatedTokens} tokens${s.budgetExceeded ? " · 超预算(深审分批跳过)" : ""}`);
    lines.push(`- 扫描排除: 二进制 ${s.skipped.binary} / 大文件 ${s.skipped.tooLarge} / 忽略 ${s.skipped.ignored} / 超文件数 ${s.skipped.overFileLimit} / 读失败 ${s.skipped.readError}`);
  } else {
    lines.push(`- 目标: ${r.target.kind} · ${r.target.files.length} 文件 · ${r.target.totalLines} 行${r.target.truncated ? " · 已截断(200KB 预算)" : ""}`);
  }
  lines.push(`- 摘要: ${r.summary}`);
  lines.push(`- 结论: ${b > 0 ? `存在 ${b} 条 blocker(exit 1)` : "无 blocker(exit 0)"} — blocker ${b} / warning ${w} / nit ${n}`);
  if (r.session) {
    lines.push(`- 会话: ${r.session.id} → ${r.session.path}(续跑 --resume ${r.session.id} / 对比 --compare ${r.session.id})`);
  }
  if (r.scanDeep) {
    lines.push(`- scan 深审: ${r.scanDeep.batches} 批 / ${r.scanDeep.filesReviewed} 文件 / ${r.scanDeep.estimatedTokens} tokens${r.scanDeep.filesSkippedByBudget ? ` / 预算跳过 ${r.scanDeep.filesSkippedByBudget} 文件` : ""}${r.scanDeep.llmTruncatedFiles ? ` / 上下文截断 ${r.scanDeep.llmTruncatedFiles} 文件` : ""}`);
  }
  lines.push("");
  if (r.findings.length === 0) {
    lines.push("## 发现");
    lines.push("");
    lines.push("(本次已运行层未发现;未运行层见下方「层明细」——零发现 ≠ 代码干净)");
  } else {
    lines.push(`## 发现(${r.findings.length} 条)`);
    for (const sev of ["blocker", "warning", "nit"] as const) {
      const group = r.findings.filter((f) => f.severity === sev);
      if (!group.length) continue;
      lines.push("");
      lines.push(`### ${SEV_LABEL[sev]} × ${group.length}`);
      lines.push("");
      for (const f of group) {
        const src = f.source ? ` · 来源 ${SOURCE_LABEL[f.source] ?? f.source}` : "";
        lines.push(`- **${f.file}:${f.line}** ${f.title}${src}`);
        lines.push(`  - ${f.detail.replace(/\n/g, " ").slice(0, 300)}`);
        if (f.scenario) lines.push(`  - 触发场景: ${f.scenario.replace(/\n/g, " ").slice(0, 200)}`);
      }
    }
  }
  lines.push("");
  lines.push("## 层明细");
  lines.push("");
  if (r.target.kind === "scan") {
    lines.push(`- 确定性层: ${r.deterministic.length} 条;反模式八类: 未运行(scan 模式无「新增行」语义)`);
  } else {
    lines.push(`- 确定性层: ${r.deterministic.length} 条;反模式八类: ${r.antipatterns.length} 条`);
  }
  if (opts.deep && r.rounds) {
    const rounds = r.rounds.map((x) => `R${x.round}+${x.newFindings.length}`).join(" / ");
    lines.push(`- LLM 深审: ${r.rounds.length} 轮(${rounds})${r.graceRoundRan ? " + grace" : ""}`);
  } else {
    lines.push("- LLM 深审: 未运行(--deep 开启;凭证链 flag>env>config>ask-file,见 codesense config)");
  }
  if (r.writeback) {
    lines.push(`- 行级回写: +${r.writeback.posted} 新增 / ${r.writeback.resolved} 已解决 / ${r.writeback.reopened} 复现 → ${r.writeback.storePath}`);
  }
  if (r.orphanCheck) {
    lines.push(`- 引用孤儿闸: 拒收 ${r.orphanCheck.orphans.length} / 行号夹紧 ${r.orphanCheck.clamped} / diff 独引 ${r.orphanCheck.diffOnly}`);
  }
  if (r.storeOrphans?.missingFile.length) {
    lines.push(`- 回写店孤儿条目: ${r.storeOrphans.missingFile.length} 条(文件已删/改名,sticky 保留)`);
  }
  if (r.compare) lines.push(...renderCompare(r.compare));
  return lines.join("\n");
}

function renderCompare(c: SessionCompare): string[] {
  const lines: string[] = [];
  lines.push("");
  lines.push(`## 对比基线 ${c.baseline}(当前 ${c.current})`);
  lines.push("");
  lines.push(`- 新增 ${c.counts.new} / 已修复 ${c.counts.resolved} / 未变 ${c.counts.unchanged} / 复现 ${c.counts.reappeared}`);
  const groups: Array<[string, Finding[]]> = [["新增", c.new], ["已修复", c.resolved], ["复现", c.reappeared]];
  for (const [label, list] of groups) {
    if (!list.length) continue;
    lines.push("");
    lines.push(`### ${label} × ${list.length}`);
    for (const f of list.slice(0, 50)) lines.push(`- **${f.file}:${f.line}** ${f.title}`);
    if (list.length > 50) lines.push(`- …另外 ${list.length - 50} 条(见 --json)`);
  }
  if (c.unchanged.length) {
    lines.push("");
    lines.push(`### 未变 × ${c.unchanged.length}(行号可能已漂移;明细见 --json)`);
  }
  return lines;
}

export function renderSessions(sessions: ReviewSession[], root: string): string {
  const lines = [`# review 会话(${root})`, ""];
  if (!sessions.length) {
    lines.push("(零会话——先跑一次 codesense review)");
    return lines.join("\n");
  }
  for (const s of sessions) {
    const counts = `${s.counts.total} findings(B${s.counts.blocker}/W${s.counts.warning}/N${s.counts.nit})`;
    const lineage = s.resumedFrom ? ` · 续跑自 ${s.resumedFrom}` : s.baseline ? ` · 对比 ${s.baseline}` : "";
    lines.push(`- ${s.id}  ${s.createdAt}  ${s.kind}  ${s.target.files.length} 文件  ${counts}${lineage}`);
  }
  lines.push("");
  lines.push("续跑/对比: codesense review --resume <id> [--scan ...] / codesense review --compare <id>");
  return lines.join("\n");
}

/** JSON(agent 消费):findings 全量+层明细+target 元数据+scan/session/compare;diffText 全文不进(体积)。 */
export function renderJson(r: CodeReviewResult, root: string, opts: { deep: boolean }): unknown {
  return {
    command: "review",
    root,
    target: {
      kind: r.target.kind,
      files: r.target.files.map((f) => ({ path: f.path, status: f.status })),
      totalLines: r.target.totalLines,
      truncated: r.target.truncated,
      ...(r.scan ? { scan: r.scan } : {}),
    },
    summary: r.summary,
    counts: {
      total: r.findings.length,
      blocker: countSeverity(r.findings, "blocker"),
      warning: countSeverity(r.findings, "warning"),
      nit: countSeverity(r.findings, "nit"),
    },
    layers: {
      deterministic: r.deterministic.length,
      antipatterns: r.antipatterns.length,
      deep: {
        enabled: opts.deep,
        ...(r.rounds ? { rounds: r.rounds.map((x) => ({ round: x.round, newFindings: x.newFindings.length, confirmedTotal: x.confirmedTotal, earlyStopped: x.earlyStopped })), graceRoundRan: r.graceRoundRan ?? false } : {}),
      },
    },
    findings: r.findings,
    ...(r.scanDeep ? { scanDeep: r.scanDeep } : {}),
    ...(r.session ? { session: r.session } : {}),
    ...(r.compare ? { compare: r.compare } : {}),
    ...(r.writeback ? { writeback: r.writeback } : {}),
    ...(r.orphanCheck ? { orphanCheck: { orphans: r.orphanCheck.orphans.length, clamped: r.orphanCheck.clamped, diffOnly: r.orphanCheck.diffOnly, orphanList: r.orphanCheck.orphans.map((o) => ({ file: o.finding.file, title: o.finding.title, reason: o.reason })) } } : {}),
    ...(r.storeOrphans ? { storeOrphans: r.storeOrphans } : {}),
  };
}
