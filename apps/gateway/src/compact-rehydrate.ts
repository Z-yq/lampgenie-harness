/**
 * 压缩后文件正文补回(,矩阵 #48 missing:
 * compact.done 之后上下文只剩 summary+tail,压缩前刚读过的文件正文消失,读文件台账里只剩路径——
 * 模型只能重读(白烧往返)或凭记忆猜(幻觉)。本模块在真压缩成功后按 readAt 降序重读磁盘
 * 最近的 N 个已读文件,渲染成一个 message.system 块补回正文。
 * 口径(用户 任务书):
 * - 名额:先按 readAt 降序取 N 个候选(缺省 5,可配 3-8);读取阶段失败**不补位**——如实反映
 *   「最近文件面」,而不是硬凑够 N 个。
 * - 预算:单文件 ≤ maxFileTokens(缺省 5000,超出取头部并标 partialView「原文件 N 行」);
 *   总量 ≤ maxTotalTokens(缺省 50000,超出即停止,余下 skipped=budget 并标 partialView);
 *   渲染总字符 ≤ 200k。
 * - 权限:只跳过 deny 规则(GENIE_PERMISSION_RULES + 项目 .genie/permissions.json,同形数组);
 *   ask/allow 照读(补回是后台读,不触发审批)。
 * - 审计:journal 事件 custom compact.rehydrate 全量字段;事件/注入失败不影响压缩(调用方再兜一层)。
 * 全部 IO 可注入(readFile/statMtime/deny),渲染为纯函数,便于单测。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";
import type { Journal } from "@lampgenie/core";
import { estimateTokens } from "@lampgenie/runtime/agent/token-estimate";

/** 配置键 agent.compactRehydrate(schema 同形);undefined 字段走缺省值。 */
export interface CompactRehydrateConfig {
  /** false=关闭补回(旧行为:只 clear 台账)。 */
  enabled?: boolean;
  /** 候选文件数上限(3-8,缺省 5)。 */
  maxFiles?: number;
  /** 单文件 token 上限(缺省 5000)。 */
  maxFileTokens?: number;
  /** 总量 token 上限(缺省 50000)。 */
  maxTotalTokens?: number;
}

/** 读文件台账条目(harness-runtime read-file-state.ReadFileEntry 的结构子集)。 */
export interface RehydrateEntry {
  path: string;
  readAt: number;
  mtimeMs?: number;
}

/** 预算口径(可注入覆盖;缺省见 REHYDRATE_DEFAULTS)。 */
export type RehydrateCaps = CompactRehydrateConfig;

export const REHYDRATE_DEFAULTS = {
  maxFiles: 5,
  maxFileTokens: 5_000,
  maxTotalTokens: 50_000,
  maxChars: 200_000,
} as const;

/** maxFiles 可配区间(任务书 3-8)。 */
export const REHYDRATE_MAX_FILES_RANGE = { min: 3, max: 8 } as const;

export type RehydrateSkipReason = "deny" | "read-failed" | "budget";

export interface RehydratePlanItem {
  path: string;
  readAt: number;
  /** 台账读时刻的 mtime(仅作 stat 失败时的展示兜底)。 */
  mtime: number;
}

export interface RehydrateFileInfo {
  path: string;
  chars: number;
  tokens: number;
  partialView: boolean;
}

export interface RehydrateSkippedInfo {
  path: string;
  reason: RehydrateSkipReason;
}

export interface RehydrateResult {
  files: RehydrateFileInfo[];
  skipped: RehydrateSkippedInfo[];
  totalChars: number;
  totalTokens: number;
  partialView: boolean;
  /** 注入了的 message.system 正文(""=没有可注入的正文)。 */
  message: string;
  messageChars: number;
}

/** path 归一化(与台账同语义:统一 `/`、去前导 `./`、trim)。 */
export function normalizeRehydratePath(filePath: string): string {
  return String(filePath ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function clampMaxFiles(v: number | undefined): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return REHYDRATE_DEFAULTS.maxFiles;
  return Math.max(REHYDRATE_MAX_FILES_RANGE.min, Math.min(REHYDRATE_MAX_FILES_RANGE.max, n));
}

function positive(v: number | undefined, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

/**
 * 名额规划:按 readAt 降序取最近 N 个(纯函数,不触碰磁盘)。
 * 读取阶段失败不补位——候选就是「最近 N 个」,如实反映最近文件面。
 */
export function planRehydrate(entries: readonly RehydrateEntry[], caps: RehydrateCaps = {}): RehydratePlanItem[] {
  const maxFiles = clampMaxFiles(caps.maxFiles);
  return [...entries]
    .filter((e) => e && typeof e.path === "string" && e.path.trim() !== "")
    .map((e) => ({ path: normalizeRehydratePath(e.path), readAt: Number(e.readAt) || 0, mtime: Number(e.mtimeMs) || 0 }))
    .sort((a, b) => b.readAt - a.readAt)
    .slice(0, maxFiles);
}

/** 简单 glob → 正则(任务书口径:`*`/`**` 均 → `.*`,只做仓内相对路径全匹配)。 */
export function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "*") {
      if (pattern[i + 1] === "*") i++;
      out += ".*";
    } else if ("\\^$.|?+()[]{}".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return new RegExp(out + "$");
}

/** 权限规则的最小形态(与 .genie/permissions.json 同形)。 */
export interface PermissionRuleLike {
  permission?: string;
  pattern?: string;
  action?: string;
}

/** deny 规则集 → 判据(只有 read_file/* 的 deny 参与;ask/allow 一律不拦)。 */
export function makeDenyMatcher(rules: readonly PermissionRuleLike[]): (relPath: string) => boolean {
  const matchers = rules
    .filter((r) => r && r.action === "deny" && typeof r.pattern === "string" && r.pattern.trim() !== "")
    .filter((r) => r.permission === undefined || r.permission === "read_file" || r.permission === "read" || r.permission === "*")
    .map((r) => globToRegExp(normalizeRehydratePath(String(r.pattern))));
  if (matchers.length === 0) return () => false;
  return (relPath: string) => {
    const p = normalizeRehydratePath(relPath);
    return matchers.some((re) => re.test(p));
  };
}

/** 装载 deny 规则:env GENIE_PERMISSION_RULES(JSON 数组)> 项目 .genie/permissions.json(两处同形)。 */
export function loadDenyRules(repoRootDir: string, env: NodeJS.ProcessEnv = process.env): PermissionRuleLike[] {
  const out: PermissionRuleLike[] = [];
  const envRaw = env.GENIE_PERMISSION_RULES;
  if (envRaw !== undefined && envRaw !== "") {
    try {
      const parsed = JSON.parse(envRaw) as unknown;
      if (Array.isArray(parsed)) out.push(...(parsed as PermissionRuleLike[]));
    } catch { /* 坏 JSON 不阻断补回 */ }
  }
  const file = join(repoRootDir, ".genie", "permissions.json");
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
      if (Array.isArray(parsed)) out.push(...(parsed as PermissionRuleLike[]));
    } catch { /* 坏文件不阻断补回 */ }
  }
  return out;
}

export function loadDenyMatcher(repoRootDir: string, env: NodeJS.ProcessEnv = process.env): (relPath: string) => boolean {
  return makeDenyMatcher(loadDenyRules(repoRootDir, env));
}

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "ts", ".tsx": "tsx", ".mts": "ts", ".cts": "ts",
  ".js": "js", ".jsx": "jsx", ".mjs": "js", ".cjs": "js",
  ".json": "json", ".jsonc": "json", ".md": "md", ".markdown": "md",
  ".yml": "yaml", ".yaml": "yaml", ".py": "python", ".sh": "bash",
  ".css": "css", ".scss": "scss", ".html": "html", ".vue": "vue",
  ".go": "go", ".rs": "rust", ".java": "java", ".kt": "kotlin",
  ".sql": "sql", ".toml": "toml", ".xml": "xml", ".txt": "txt",
};

function langOf(filePath: string): string {
  return LANG_BY_EXT[extname(filePath).toLowerCase()] ?? "";
}

function countLines(content: string): number {
  if (content === "") return 0;
  return content.split("\n").length;
}

/** 截到 token 上限(按估算值比例收敛;返回实际保留的头部文本)。 */
export function truncateToTokens(content: string, cap: number): { text: string; tokens: number; truncated: boolean } {
  const total = estimateTokens(content);
  if (total <= cap) return { text: content, tokens: total, truncated: false };
  if (cap <= 0) return { text: "", tokens: 0, truncated: true };
  let keep = content.length;
  let text = content;
  let tokens = total;
  for (let i = 0; i < 8 && tokens > cap && keep > 0; i++) {
    keep = Math.max(1, Math.floor(keep * (cap / tokens) * 0.98));
    text = content.slice(0, keep);
    tokens = estimateTokens(text);
  }
  return { text, tokens, truncated: true };
}

export interface HydratedFile {
  path: string;
  mtime: number;
  /** 原文件行数(渲染在标题里)。 */
  lines: number;
  content: string;
  lang: string;
  tokens: number;
  partialView: boolean;
}

/** 渲染补回块(纯函数;总字符超限截断并标 partialView)。 */
export function renderRehydrateMessage(
  files: readonly HydratedFile[],
  skipped: readonly RehydrateSkippedInfo[],
  maxChars: number = REHYDRATE_DEFAULTS.maxChars): { message: string; partialView: boolean } {
  const lines: string[] = [`## 压缩后文件正文补回(重读磁盘;${files.length} 个)`];
  for (const f of files) {
    lines.push(`### ${f.path}(mtime ${new Date(f.mtime || 0).toISOString()},${f.lines} 行)`);
    lines.push("```" + f.lang);
    lines.push(f.content.endsWith("\n") ? f.content.slice(0, -1) : f.content);
    lines.push("```");
    if (f.partialView) lines.push(`> partialView: 已截断到 ${f.tokens} tok,原文件 ${f.lines} 行`);
  }
  const budget = skipped.filter((s) => s.reason === "budget");
  if (budget.length > 0) {
    lines.push(`> partialView: 总量预算已满,余下 ${budget.length} 个文件未补回(${budget.map((s) => s.path).join(", ")})`);
  }
  const failed = skipped.filter((s) => s.reason === "read-failed");
  if (failed.length > 0) {
    lines.push(`> partialView: ${failed.length} 个文件读取失败(${failed.map((s) => s.path).join(", ")})`);
  }
  const denied = skipped.filter((s) => s.reason === "deny");
  if (denied.length > 0) {
    lines.push(`> 已按 deny 规则跳过 ${denied.length} 个文件(${denied.map((s) => s.path).join(", ")})`);
  }
  if (skipped.length > 0) lines.push(`> 跳过明细见 journal 事件 custom compact.rehydrate`);
  let message = lines.join("\n");
  let truncated = false;
  if (message.length > maxChars) {
    message = message.slice(0, maxChars) + `\n…(补回块超 ${maxChars} 字符已截断)`;
    truncated = true;
  }
  const partialView = truncated || files.some((f) => f.partialView) || failed.length > 0 || budget.length > 0;
  return { message, partialView };
}

export interface RehydrateOptions {
  journal: Pick<Journal, "append">;
  sessionId: string;
  entries: readonly RehydrateEntry[];
  repoRoot: string;
  caps?: RehydrateCaps;
  /** deny 判据(缺省 loadDenyMatcher(repoRoot));只跳过 deny,ask/allow 照读。 */
  deny?: (relPath: string) => boolean;
  /** 读取注入(缺省 readFileSync utf8)。 */
  readFile?: (absPath: string) => string;
  /** mtime 注入(缺省 statSync().mtimeMs;失败回落台账 mtime)。 */
  statMtime?: (absPath: string) => number | undefined;
  now?: () => number;
}

/**
 * 真压缩后补回:按 readAt 降序取最近 N 个候选 → deny 跳过 → 读磁盘 → 单文件/总量预算 →
 * 渲染一个 message.system 块 + journal 事件 custom compact.rehydrate。
 * 本函数自身吞掉所有 IO 异常(失败记 skipped,不抛);调用方仍需 try/catch 兜底。
 */
export function rehydrateAfterCompact(o: RehydrateOptions): RehydrateResult {
  const caps = o.caps ?? {};
  const maxFileTokens = positive(caps.maxFileTokens, REHYDRATE_DEFAULTS.maxFileTokens);
  const maxTotalTokens = positive(caps.maxTotalTokens, REHYDRATE_DEFAULTS.maxTotalTokens);
  const maxChars = REHYDRATE_DEFAULTS.maxChars;
  const deny = o.deny ?? loadDenyMatcher(o.repoRoot);
  const readFile = o.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
  const statMtime = o.statMtime ?? ((p: string) => { try { return statSync(p).mtimeMs; } catch { return undefined; } });
  const now = o.now ?? (() => Date.now());

  const plan = planRehydrate(o.entries, caps);
  const hydrated: HydratedFile[] = [];
  const skipped: RehydrateSkippedInfo[] = [];
  let totalChars = 0;
  let totalTokens = 0;
  let budgetExhausted = false;

  for (const item of plan) {
    if (budgetExhausted) {
      skipped.push({ path: item.path, reason: "budget" });
      continue;
    }
    if (deny(item.path)) {
      skipped.push({ path: item.path, reason: "deny" });
      continue;
    }
    const abs = isAbsolute(item.path) ? item.path : join(o.repoRoot, item.path);
    let raw: string;
    try {
      raw = readFile(abs);
    } catch {
      skipped.push({ path: item.path, reason: "read-failed" });
      continue;
    }
    const lines = countLines(raw);
    const cut = truncateToTokens(raw, maxFileTokens);
    // 总量预算(任务书口径:超 50k → 停止,余下 skipped=budget 并标 partialView)。
    if (totalTokens + cut.tokens > maxTotalTokens) {
      skipped.push({ path: item.path, reason: "budget" });
      budgetExhausted = true;
      continue;
    }
    const mtime = statMtime(abs) ?? item.mtime;
    hydrated.push({ path: item.path, mtime, lines, content: cut.text, lang: langOf(item.path), tokens: cut.tokens, partialView: cut.truncated });
    totalChars += cut.text.length;
    totalTokens += cut.tokens;
  }

  const rendered = renderRehydrateMessage(hydrated, skipped, maxChars);
  const result: RehydrateResult = {
    files: hydrated.map((f) => ({ path: f.path, chars: f.content.length, tokens: f.tokens, partialView: f.partialView })),
    skipped,
    totalChars,
    totalTokens,
    partialView: rendered.partialView,
    message: hydrated.length > 0 ? rendered.message : "",
    messageChars: hydrated.length > 0 ? rendered.message.length : 0,
  };

  // 审计事件(字段齐全;失败不影响压缩主链)。
  try {
    o.journal.append({
      kind: "custom",
      sessionId: o.sessionId,
      payload: {
        type: "compact.rehydrate",
        sessionId: o.sessionId,
        files: result.files,
        skipped: result.skipped,
        totalChars: result.totalChars,
        totalTokens: result.totalTokens,
        partialView: result.partialView,
        at: now(),
      },
    });
  } catch { /* 审计失败不影响补回 */ }

  // 补回块(没有正文就不注入,避免空块噪声)。
  if (result.message !== "") {
    try {
      o.journal.append({ kind: "message.system", sessionId: o.sessionId, payload: { text: result.message } });
    } catch { /* 注入失败不影响压缩 */ }
  }
  return result;
}
