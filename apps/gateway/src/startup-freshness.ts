/**
 *  开工前置门:基线新鲜度校验 + 规则旧措辞同步(零外部依赖,只 import node:*)。
 * 背景:任务从上一轮会话继承的本地分支常常落后上游多个提交/分叉,主 agent 在旧基线上
 * 开工 → 改的代码与上游冲突、审阅/合并全白做。故开工第一轮前先量一次「基线 vs 上游」:
 *   - behind(上游独有提交)/ ahead(本分支独有)/ diverged(两边都有)→ 拦或警告;
 *   - 计数用 `git rev-list --left-right --count <base>...<upstream>`(左=本分支独有=ahead,
 * 右=上游独有=behind;git 经验证口径,写反会把「落后」当「领先」而放过门)。
 * 另附「规则旧措辞」扫描:仓内 .genie/rule-wording.json 声明了「旧说法 → 现行规则」,
 * docs/ 与 AGENTS.md 里仍写着旧说法的行会给模型一份提示清单(不阻塞)。
 * 纪律:本模块**绝不抛错给调用方**——git 不可用/坏仓/超时一律降级 unknown + reason;
 * 所有决策也都在这里做成纯函数(planFreshnessSkip/planFreshnessAction/render*),
 * agent-wiring 只做「取 cfg → 调函数 → 落 journal → 拼 instruction」的薄接线(可测)。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type FreshnessState = "fresh" | "behind" | "ahead-warn" | "diverged-warn" | "unknown" | "skipped";

/** git 执行器:返回 stdout,失败抛错(cwd=仓根,timeoutMs=单次命令超时)。 */
export type GitRun = (args: string[], opts?: { cwd?: string; timeoutMs?: number }) => string;

export interface BaselineStatus {
  state: FreshnessState;
  behind: number;
  ahead: number;
  baseRef: string;
  upstreamRef: string | null;
  fetched: boolean;
  note?: string;
  durationMs: number;
  reason?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_AHEAD = 50;
const STALE_NOTE = "本地引用可能过期(未 fetch;远端有新提交时 behind 会低估)";
const REASON_MAX = 200;

/** 缺省 runner:execFileSync(git 不在 PATH / 非 git 目录 → 抛错,由上层降级)。 */
const defaultRun: GitRun = (args, opts) =>
  String(execFileSync("git", args, {
    cwd: opts?.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
    ...(opts?.timeoutMs ? { timeout: opts.timeoutMs } : {}),
  }));

function errText(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown } | null;
  const stderr = typeof e?.stderr === "string" ? e.stderr : "";
  const raw = stderr.trim() || String((e?.message ?? err) ?? "");
  return raw.replace(/\s+/g, " ").trim().slice(0, REASON_MAX) || "unknown-error";
}

function remoteOf(upstreamRef: string): string {
  const idx = upstreamRef.indexOf("/");
  return idx > 0 ? upstreamRef.slice(0, idx) : upstreamRef;
}

/**
 * 上游 ref 解析(可内部复用):显式给了就用;否则 @{upstream} → origin/master → origin/main
 * → upstream/master;全失败返回 null(调用方落 unknown/no-upstream)。
 */
export function resolveUpstream(repoRoot: string, run: GitRun = defaultRun, explicit?: string, timeoutMs = DEFAULT_TIMEOUT_MS): string | null {
  if (explicit) return explicit;
  const cwd = repoRoot;
  try {
    const out = run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd, timeoutMs }).trim();
    if (out && out !== "HEAD") return out;
  } catch { /* 无 upstream → 继续探测候选 */ }
  for (const cand of ["origin/master", "origin/main", "upstream/master"]) {
    try {
      const out = run(["rev-parse", "--verify", "--quiet", cand], { cwd, timeoutMs }).trim();
      if (out) return cand;
    } catch { /* 该候选不存在 → 下一个 */ }
  }
  return null;
}

/**
 * 量一次基线新鲜度。**绝不抛错**:任何 git 失败/超时都返回 state=unknown + reason。
 * fetch 缺省 false(不联网,快);fetch=true 时先 `git fetch --quiet <remote>` 再计数。
 */
export function readBaselineStatus(opts: {
  repoRoot: string;
  baseRef?: string;
  upstreamRef?: string;
  maxAhead?: number;
  run?: GitRun;
  fetch?: boolean;
  timeoutMs?: number;
}): BaselineStatus {
  const t0 = Date.now();
  const run = opts.run ?? defaultRun;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAhead = opts.maxAhead ?? DEFAULT_MAX_AHEAD;
  const baseRef = opts.baseRef ?? "HEAD";
  const cwd = opts.repoRoot;
  const mk = (p: Partial<BaselineStatus> & { state: FreshnessState }): BaselineStatus => ({
    state: p.state,
    behind: p.behind ?? 0,
    ahead: p.ahead ?? 0,
    baseRef,
    upstreamRef: p.upstreamRef ?? null,
    fetched: p.fetched ?? false,
    ...(p.note !== undefined ? { note: p.note } : {}),
    ...(p.reason !== undefined ? { reason: p.reason } : {}),
    durationMs: Date.now() - t0,
  });

  let upstreamRef: string | null;
  try {
    upstreamRef = resolveUpstream(cwd, run, opts.upstreamRef, timeoutMs);
  } catch (err) {
    return mk({ state: "unknown", reason: `upstream-resolve-failed: ${errText(err)}`, note: STALE_NOTE });
  }
  if (!upstreamRef) return mk({ state: "unknown", reason: "no-upstream", note: STALE_NOTE });

  // fetch 策略:只在显式 fetch=true 时联网;成功才置 fetched=true,失败=unknown(明确注明 fetch 失败)。
  let fetched = false;
  if (opts.fetch) {
    const remote = remoteOf(upstreamRef);
    try {
      run(["fetch", "--quiet", remote], { cwd, timeoutMs });
      fetched = true;
    } catch (err) {
      return mk({
        state: "unknown",
        upstreamRef,
        reason: `fetch-failed(${remote}): ${errText(err)}`,
        note: "fetch 失败,本地引用可能过期",
      });
    }
  }

  let behind = 0;
  let ahead = 0;
  try {
 // 口径修正(git 经验证):`git rev-list --left-right --count A...B` 输出「左=仅 A 可达 右=仅 B 可达」,
    // A=HEAD(base) → **左=本分支独有(ahead)、右=上游独有(behind)**。写反会把「落后」当「领先」放过门。
    const out = run(["rev-list", "--left-right", "--count", `${baseRef}...${upstreamRef}`], { cwd, timeoutMs });
    const nums = out.trim().split(/\s+/).map((s) => Number(s));
    const left = nums[0];
    const right = nums[1];
    if (left === undefined || right === undefined || !Number.isFinite(left) || !Number.isFinite(right)) {
      throw new Error(`rev-list 输出无法解析: ${out.trim().slice(0, 80)}`);
    }
    ahead = left;
    behind = right;
  } catch (err) {
    return mk({
      state: "unknown",
      upstreamRef,
      fetched,
      reason: `rev-list-failed: ${errText(err)}`,
      ...(fetched ? {} : { note: STALE_NOTE }),
    });
  }

  const note = fetched ? `已 fetch ${remoteOf(upstreamRef)}` : STALE_NOTE;
  // 判定顺序按口径固定:两边都有 → diverged;只落后 → behind;领先超阈 → ahead-warn;齐平 → fresh。
  const state: FreshnessState = behind > 0 && ahead > 0
    ? "diverged-warn"
    : behind > 0
      ? "behind"
      : ahead > maxAhead
        ? "ahead-warn"
        : "fresh";
  return mk({ state, behind, ahead, upstreamRef, fetched, note });
}

// ── 接线决策纯函数(agent-wiring 薄接线;可独立测)────────────────────────────

export interface FreshnessConfig {
  enabled?: boolean;
  blockOnBehind?: boolean;
  maxAheadCommits?: number;
  fetch?: boolean;
  timeoutMs?: number;
}

export type FreshnessSkipReason = "taskClass" | "env" | "config";

/** 跳过判定:任务类别非 coding → taskClass;env GENIE_FRESHNESS=off → env;cfg.enabled=false → config。 */
export function planFreshnessSkip(input: {
  taskClass: string;
  cfg?: FreshnessConfig;
  env?: Record<string, string | undefined>;
}): { skip: boolean; reason?: FreshnessSkipReason } {
  const env = input.env ?? process.env;
  if (input.taskClass !== "coding") return { skip: true, reason: "taskClass" };
  if (String(env["GENIE_FRESHNESS"] ?? "").toLowerCase() === "off") return { skip: true, reason: "env" };
  if (input.cfg?.enabled === false) return { skip: true, reason: "config" };
  return { skip: false };
}

export type FreshnessEffect = "proceed" | "blocked" | "warn-block-override";

/**
 * 处置决策:只有 state=behind 才可能拦(diverged/ahead-warn/unknown 一律放行+留痕)。
 * blockOnBehind 缺省 true;cfg.blockOnBehind=false 或 env GENIE_FRESHNESS_BLOCK=off → 降级警告。
 */
export function planFreshnessAction(
  status: BaselineStatus,
  cfg?: FreshnessConfig,
  env: Record<string, string | undefined> = process.env): { effect: FreshnessEffect; message?: string; note?: string } {
  if (status.state !== "behind") return { effect: "proceed" };
  const upstream = status.upstreamRef ?? "(unknown)";
  const remote = status.upstreamRef ? remoteOf(status.upstreamRef) : "origin";
  const overrideByEnv = String(env["GENIE_FRESHNESS_BLOCK"] ?? "").toLowerCase() === "off";
  const blockOnBehind = cfg?.blockOnBehind ?? true;
  const fix = `修复:git fetch ${remote} && git pull --rebase(工作区有未提交改动时先 stash);修好后重新提交任务。`;
  if (!blockOnBehind || overrideByEnv) {
    const why = overrideByEnv ? "env GENIE_FRESHNESS_BLOCK=off" : "config agent.startupFreshness.blockOnBehind=false";
    return {
      effect: "warn-block-override",
      message: `[开工前置门] 本地基线落后上游 ${status.behind} 个提交(upstream=${upstream},ahead=${status.ahead},base=${status.baseRef})。`
        + `已按 ${why} 降级为警告继续——动手前请先 git fetch ${remote} && git pull --rebase,否则改动可能与上游冲突。`,
      note: "block-override",
    };
  }
  return {
    effect: "blocked",
    message: `[开工前置门] 本地基线落后上游 ${status.behind} 个提交(upstream=${upstream},ahead=${status.ahead},base=${status.baseRef}),拒绝在旧基线上开工。`
      + fix,
    note: "behind",
  };
}

/** 非阻塞态的 instruction 追加行(注入前让模型知道基线口径)。 */
export function renderFreshnessLine(status: BaselineStatus): string {
  const parts = [
    `[基线新鲜度] state=${status.state}`,
    `behind=${status.behind}`,
    `ahead=${status.ahead}`,
    `upstream=${status.upstreamRef ?? "none"}`,
  ];
  if (status.note) parts.push(`note=${status.note}`);
  if (status.state === "unknown" && status.reason) parts.push(`reason=${status.reason}`);
  return parts.join(" ");
}

// ── 规则旧措辞(旧说法 → 现行规则)──────────────────────────────────────────

export interface WordingRule { old: string; new: string; files?: string[]; since?: string }
export type WordingHit = { file: string; line: number; old: string; new: string };

const WORDING_MAX_HITS = 50;
const WORDING_TABLE_REL = join(".genie", "rule-wording.json");

class WordingTableError extends Error {}

function parseWordingTable(raw: string): WordingRule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new WordingTableError(`JSON 解析失败: ${errText(err)}`);
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === "object" && Array.isArray((parsed as { rules?: unknown }).rules)
      ? (parsed as { rules: unknown[] }).rules
      : null);
  if (!list) throw new WordingTableError("形状错误:期望数组或 {rules: [...]}");
  const rules: WordingRule[] = [];
  for (const [i, item] of list.entries()) {
    if (!item || typeof item !== "object") throw new WordingTableError(`形状错误:rules[${i}] 不是对象`);
    const r = item as { old?: unknown; new?: unknown; files?: unknown; since?: unknown };
    if (typeof r.old !== "string" || !r.old) throw new WordingTableError(`形状错误:rules[${i}].old 必须是非空字符串`);
    if (typeof r.new !== "string") throw new WordingTableError(`形状错误:rules[${i}].new 必须是字符串`);
    if (r.files !== undefined && (!Array.isArray(r.files) || r.files.some((f) => typeof f !== "string"))) {
      throw new WordingTableError(`形状错误:rules[${i}].files 必须是字符串数组`);
    }
    if (r.since !== undefined && typeof r.since !== "string") throw new WordingTableError(`形状错误:rules[${i}].since 必须是字符串`);
    rules.push({
      old: r.old,
      new: r.new,
      ...(r.files ? { files: r.files as string[] } : {}),
      ...(r.since !== undefined ? { since: r.since as string } : {}),
    });
  }
  return rules;
}

/** 读 <repoRoot>/.genie/rule-wording.json:不存在→ok+rules:[](不是错误);坏表→ok:false(不抛)。 */
export function loadWordingTable(repoRoot: string): { ok: true; rules: WordingRule[] } | { ok: false; error: string } {
  const path = join(repoRoot, WORDING_TABLE_REL);
  if (!existsSync(path)) return { ok: true, rules: [] };
  try {
    return { ok: true, rules: parseWordingTable(readFileSync(path, "utf8")) };
  } catch (err) {
    return { ok: false, error: `旧措辞表 ${WORDING_TABLE_REL} 不可用: ${errText(err)}` };
  }
}

function skipPathSegments(relPath: string): boolean {
  const segs = relPath.split("/");
 // =历史计划(旧说法在那里的出现是记录,不是现行规则);archive 任意大小写=归档。
  return segs.some((s) => s === "tasks" || s.toLowerCase().includes("archive"));
}

function collectWordingFiles(repoRoot: string): string[] {
  const out: string[] = [];
  const rootAgents = join(repoRoot, "AGENTS.md");
  try { if (statSync(rootAgents).isFile()) out.push("AGENTS.md"); } catch { /* 无根 AGENTS.md */ }
  const walk = (dir: string, relDir: string) => {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const abs = join(dir, name);
      const rel = relDir ? `${relDir}/${name}` : name;
      if (skipPathSegments(rel)) continue;
      let st: ReturnType<typeof statSync> | null = null;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) walk(abs, rel);
      else if (st.isFile() && rel.toLowerCase().endsWith(".md")) out.push(rel);
    }
  };
  walk(join(repoRoot, "docs"), "docs");
  return out;
}

/**
 * 扫 docs/**\/*.md 与仓根 AGENTS.md 里的「旧说法」(逐行字面包含 old 即命中):
 * 同文件同 old 只报首处;总上限 50;跳过 与 *archive* 目录;文件读失败静默跳过。
 */
export function scanRuleWording(opts: { repoRoot: string; rules?: WordingRule[] }): { ok: boolean; hints: WordingHit[]; error?: string } {
  let rules = opts.rules;
  if (!rules) {
    const table = loadWordingTable(opts.repoRoot);
    if (!table.ok) return { ok: false, hints: [], error: table.error };
    rules = table.rules;
  }
  if (rules.length === 0) return { ok: true, hints: [] };

  const files = collectWordingFiles(opts.repoRoot);
  const fileLines = new Map<string, string[] | null>();
  const readLines = (rel: string): string[] | null => {
    if (fileLines.has(rel)) return fileLines.get(rel) ?? null;
    let lines: string[] | null = null;
    try { lines = readFileSync(join(opts.repoRoot, ...rel.split("/")), "utf8").split(/\r?\n/); } catch { lines = null; }
    fileLines.set(rel, lines);
    return lines;
  };

  const hints: WordingHit[] = [];
  const seen = new Set<string>(); // `${file}\u0000${old}`
  for (const rule of rules) {
    const matchers = (rule.files ?? []).map((p) => {
      try { return new RegExp(p); } catch { return null; }
    }).filter((r): r is RegExp => r !== null);
    for (const rel of files) {
      if (hints.length >= WORDING_MAX_HITS) break;
      if (matchers.length > 0 && !matchers.some((re) => re.test(rel))) continue;
      const key = `${rel}\u0000${rule.old}`;
      if (seen.has(key)) continue;
      const lines = readLines(rel);
      if (!lines) continue;
      const idx = lines.findIndex((line) => line.includes(rule.old));
      if (idx < 0) continue;
      seen.add(key);
      hints.push({ file: rel, line: idx + 1, old: rule.old, new: rule.new });
    }
  }
  return { ok: true, hints: hints.slice(0, WORDING_MAX_HITS) };
}

/** 注入 instruction 的清单(≤10 条),不阻塞任务。 */
export function renderWordingLines(hits: WordingHit[], limit = 10): string {
  if (hits.length === 0) return "";
  const shown = hits.slice(0, limit);
  return [
    `[规则旧措辞] 本仓已换新说法,以下文档行仍在用旧说法(共 ${hits.length} 处,列前 ${shown.length};改文档时按「现行规则」写):`,
    ...shown.map((h) => `- ${h.file}:${h.line} 「${h.old}」→ 「${h.new}」`),
  ].join("\n");
}
