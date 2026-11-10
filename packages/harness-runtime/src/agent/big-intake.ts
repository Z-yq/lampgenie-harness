/**
 * 大结果「智能入上下文」闸门。
 * 与 microcompact 的「入口控增量」是同一根问题的两半:那一半治**读侧**每步改写前缀,
 * 这一半治**入口**——工具结果进来时就压到本步预算内,而不是先全量塞进上下文再靠 prune 减回去
 * (那正是用户点名的 250k→160k→240k 震荡形态)。
 * 三级策略(按量级选,便宜的先上):
 * ① **直通**:est 未同时越过「本步预算」与绝对下限(4k tok)→ 原样返回,零变化。
 * ② **chunk-select**:按行切成 ~1-1.5k tok 的块(保留原始行号),交给本地 8105 `/decide`
 *    判「这块对当前任务还有用吗」,选高相关块 + 头尾保底,压回预算;放不下的列「筛掉清单」。
 * ③ **digest**:选块后仍超摘要线,或结果本身超大 → 小模型按任务目标出四段摘要
 *    (关键结论 / 精确锚点 / 异常与风险 / 下一步);**未配小模型就不硬造摘要**,只拼装选块。
 * 保真红线(与既有 spill 纪律同源):
 * - 全文永远落盘 `.genie/tool-dumps/<callId>.txt`(逐字节等于原文,行号对齐);
 *   进上下文的是「选块/摘要 + 一行全文已落盘指针」,读侧不会再改写它(标记复用
 *   `SPILL_MARKER_PREFIX` → `isPlaceholderContent` 命中即三处全跳过)。
 * - 落盘失败 → 摘要照给,但显式标注「全文未能落盘,请重跑缩小范围」,绝不静默丢结果。
 * - 8105 不可用/超时 → 确定性兜底(头尾 + grep 命中行 + 日志 ERROR±上下文),
 *   **绝不阻塞工具返回**。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
// token 口径统一见 agent/token-estimate.ts。
// 这里用 rawTokens(**未标定**的原始分词计数)而不是 estimateTokens:big-intake 的闸门是
// 「这份结果是不是量级上大到需要分流」——判的是绝对量级,与某 provider 的历史标定 ratio 无关,
// 标定值会把不同 provider 的系数差异带进切块大小,反而让同一内容在换 provider 后切法不同。
import { rawTokens } from "./token-estimate";
import { resolveModelScoringConfig, scoreContextCandidates, type ModelScoringConfig, type ScoringCandidate } from "./model-scoring";
import { SPILL_MARKER_PREFIX, safeSegment } from "./tool-result-spill";

/** 触发闸的绝对下限(tokens):小结果一律直通,不因预算小就动它。 */
export const BIG_RESULT_MIN_TOKENS = 4_000;
/** 摘要线(tokens):超过它才值得付一次小模型摘要(≈3× 触发线)。 */
export const BIG_RESULT_DIGEST_LINE_TOKENS = 12_000;
/** 单块目标 tokens(行粒度对齐,块实际落在 1~1.5k 区间)。 */
export const CHUNK_TARGET_TOKENS = 1_200;
/** 拼装产物的字符上限:必须显著小于读侧 HUGE_RESULT_CHARS=8000,否则会被判「超大结果」再剪一次。 */
export const INTAKE_MAX_CHARS = 6_000;
/** 逐段落的确定性兜底上限(头部/尾部各留多少行)。 */
const FALLBACK_HEAD_LINES = 80;
const FALLBACK_TAIL_LINES = 60;
/** 送给小模型的已选内容字符上限(防小模型自己也爆上下文)。 */
const DIGEST_INPUT_MAX_CHARS = 24_000;

export type IntakePolicy = "off" | "chunk-select" | "digest" | "fallback" | "truncate";

export interface IntakeChunk {
  index: number;
  /** 原始行号(1-based,含)。 */
  startLine: number;
  endLine: number;
  text: string;
  tokens: number;
  /** 行内分段序号(1-based);只在该行被「超长行内分段」切开时出现。 */
  part?: number;
  /** 该行总段数(与 part 同时出现)。 */
  partCount?: number;
  /** 本块在原文中的绝对字符区间 [charStart, charEnd)(0-based,end 不含)——整行块与行内 part 都带。 */
  charStart: number;
  charEnd: number;
}

/** 唯一块标签:普通块 `行 a-b`;行内分段 `行 a 第 k/n 段(字符 s-e)`。渲染/筛掉清单/打分 candidates 共用。 */
export function chunkLabel(chunk: IntakeChunk): string {
  if (chunk.part !== undefined && chunk.partCount !== undefined) {
    return `行 ${chunk.startLine} 第 ${chunk.part}/${chunk.partCount} 段(字符 ${chunk.charStart}-${chunk.charEnd})`;
  }
  return `行 ${chunk.startLine}-${chunk.endLine}`;
}

export interface IntakeMeta {
  tool: string;
  /** 原始字符数 / tokens(估算)。 */
  chars: number;
  tokens: number;
  chunks: number;
  keptChunks: number;
  /** 真正进上下文的正文长度(截断后);不是原文长度,也不是选中块长度总和。 */
  keptChars: number;
  /** 被 INTAKE_MAX_CHARS 截掉的正文长度(0=未截断)。 */
  truncatedChars: number;
  digestChars: number;
  /** 提炼轨来源:diff=git diff 专用提炼(结构保留);generic=通用四段摘要。 */
  digestKind?: "diff" | "generic";
  /** 真正送进提炼模型的字符数(未调用=0);diff 轨是压缩后的 diff 字符数,不是原文。 */
  digestInputChars?: number;
  /** 提炼失败原因(短,≤200 字符):抛错取 err.message,空摘要记 "empty";成功时不出现。 */
  digestError?: string;
  policy: IntakePolicy;
  dumpPath?: string;
  /** 打分器来源:jev+endpoint / deterministic / none。 */
  scorer: string;
  /** 被筛掉的块数与字符量(必须显式告知模型,不许无声消失)。 */
  droppedChunks: number;
  droppedChars: number;
  durationMs: number;
  /** 落盘失败时的原因(fail-soft 标记)。 */
  dumpError?: string;
}

export interface BigIntakeConfig {
  /** 总体开关(缺省 on;`GENIE_BIG_RESULT=off` 由调用方折算成 false)。 */
  enabled?: boolean;
  minTokens?: number;
  digestLineTokens?: number;
  chunkTokens?: number;
  /** 全文落盘根(.genie/tool-dumps)。 */
  dumpDir?: string;
  /** 复用 model-scoring 的 client/批量面(8105 /decide)。 */
  scorer?: ModelScoringConfig;
  /** 打分硬超时(毫秒):到点即走确定性兜底,绝不挂住工具返回。 */
  scorerTimeoutMs?: number;
  /** 小模型摘要轨(注入式:runtime 不认识 gateway,由装配方传 compactLlm 的 chat)。 */
  digest?: (prompt: string, opts: { timeoutMs: number }) => Promise<string>;
  digestTimeoutMs?: number;
}

/** env 开关:`GENIE_BIG_RESULT=off` 时整体关闭(回退现状,逐字节等同无闸)。 */
export function bigResultEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.GENIE_BIG_RESULT ?? "").trim().toLowerCase();
  return raw !== "off" && raw !== "0" && raw !== "false";
}

/** 是否该进闸:两个条件同时成立才算(小结果零变化)。 */
export function shouldIntake(content: string, budgetTokens: number, config?: BigIntakeConfig): boolean {
  if (config?.enabled === false) return false;
  const est = rawTokens(content);
  const min = config?.minTokens ?? BIG_RESULT_MIN_TOKENS;
  if (est < min) return false;
  // 未给预算(=无法量化本步余量)时只按绝对下限判,避免「预算 0」把所有结果都拦下。
  if (budgetTokens > 0 && est <= budgetTokens) return false;
  return true;
}

/** 量级分流:中(≤摘要线)走选块,大走选块+摘要。 */
export function intakeLevel(est: number, config?: BigIntakeConfig): "chunk-select" | "digest" {
  return est > (config?.digestLineTokens ?? BIG_RESULT_DIGEST_LINE_TOKENS) ? "digest" : "chunk-select";
}

/**
 * 按行切块:每块尽量贴近 CHUNK_TARGET_TOKENS,**永不切断普通行**、`startLine/endLine` 都是原文行号。
 * 超长单行(压缩 JSON / 巨长一行)按「行内分段」切:所有 part 共享 startLine/endLine,
 * `part/partCount` 标明序号,`charStart/charEnd` 是原文绝对字符区间——按区间拼接必须逐字节等于该行。
 * 切分只依赖原文本身(纯函数),同输入必然同输出 —— 这是「结果可重复落盘/可对照」的前提。
 */
export function splitChunks(content: string, targetTokens = CHUNK_TARGET_TOKENS): IntakeChunk[] {
  const lines = content.split("\n");
  const lineStarts: number[] = [];
  {
    let pos = 0;
    for (const line of lines) { lineStarts.push(pos); pos += line.length + 1; }
  }
  const chunks: IntakeChunk[] = [];
  let buffer: string[] = [];
  let tokens = 0;
  let bufferStart = 0; // 0-based 行下标
  const flush = (endLineNo: number): void => {
    if (buffer.length === 0) return;
    const text = buffer.join("\n");
    const charStart = lineStarts[bufferStart]!;
    chunks.push({ index: chunks.length, startLine: bufferStart + 1, endLine: endLineNo, text, tokens, charStart, charEnd: charStart + text.length });
    buffer = [];
    tokens = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineTokens = rawTokens(line) + 1; // +1 = 换行
    if (needsLineSplit(line, lineTokens, targetTokens)) {
      flush(i); // 已完成的 0..i-1 行,末行号 = i(1-based)
      chunks.push(...splitLineIntoParts(line, lineStarts[i]!, i + 1, targetTokens));
      bufferStart = i + 1;
      continue;
    }
    if (buffer.length > 0 && tokens + lineTokens > targetTokens) {
      flush(i);
      bufferStart = i;
    }
    if (buffer.length === 0) bufferStart = i;
    buffer.push(line);
    tokens += lineTokens;
  }
  flush(lines.length);
  chunks.forEach((chunk, idx) => { chunk.index = idx; });
  return chunks;
}

/** 压缩 JSON 形态(单行 `{...}` / `[...]`):即使只超目标 1 倍也值得行内切。 */
function isCompactJsonLine(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return false;
  const first = t[0]!;
  const last = t[t.length - 1]!;
  return (first === "{" || first === "[") && (last === "}" || last === "]");
}

function needsLineSplit(line: string, lineTokens: number, targetTokens: number): boolean {
  if (lineTokens > targetTokens * 2) return true;
  return lineTokens > targetTokens && isCompactJsonLine(line);
}

/** 安全切点优先级(JSON 转义换行 → 对象/数组/字段边界 → 逗号 → 空白)。 */
const PART_BOUNDARIES = ["\\n", "},{", '","', ", ", ","] as const;

/**
 * 从 `ideal` 往回找安全边界:按优先级逐类找「最靠后且不越过 ideal」的切点,返回切后位置(exclusive)。
 * 都找不到 → 在 ideal 硬切(避开 surrogate pair 中间)。
 */
function findPartCut(line: string, from: number, ideal: number): number {
  for (const b of PART_BOUNDARIES) {
    let idx = line.lastIndexOf(b, ideal - b.length);
    while (idx >= from) {
      const end = idx + b.length;
      if (end > from && end <= ideal) return end;
      if (idx === 0) break;
      idx = line.lastIndexOf(b, idx - 1);
    }
  }
  // 空白边界(单字符,避开字符串内部不好判,只作为次优)
  for (let pos = ideal - 1; pos > from; pos--) {
    if (/\s/.test(line[pos]!)) return pos + 1;
  }
  // 硬切:不切 surrogate pair
  let cut = ideal;
  if (cut > from && cut < line.length) {
    const prev = line.charCodeAt(cut - 1);
    const next = line.charCodeAt(cut);
    if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) cut -= 1;
  }
  return Math.max(from + 1, cut);
}

/** 把超长单行切成多个 part(每 part 目标 targetTokens),块在原文里的字符区间必须精确可拼回。 */
function splitLineIntoParts(line: string, lineStart: number, lineNo: number, targetTokens: number): IntakeChunk[] {
  const lineTokens = Math.max(1, rawTokens(line));
  const charsPerToken = line.length / lineTokens;
  let targetChars = Math.max(64, Math.floor(targetTokens * charsPerToken * 0.85));
  targetChars = Math.min(targetChars, Math.max(64, Math.floor(line.length / 2)));
  const parts: Array<{ from: number; to: number; text: string }> = [];
  let from = 0;
  while (from < line.length && parts.length < 10_000) {
    if (line.length - from <= targetChars * 1.2) {
      parts.push({ from, to: line.length, text: line.slice(from) });
      break;
    }
    const ideal = Math.min(line.length - 1, from + targetChars);
    const to = Math.max(from + 1, Math.min(line.length, findPartCut(line, from, ideal)));
    parts.push({ from, to, text: line.slice(from, to) });
    from = to;
  }
  const partCount = parts.length;
  return parts.map((p, i) => ({
    index: 0, // 由 splitChunks 统一重编号
    startLine: lineNo,
    endLine: lineNo,
    text: p.text,
    tokens: rawTokens(p.text),
    part: i + 1,
    partCount,
    charStart: lineStart + p.from,
    charEnd: lineStart + p.to,
  }));
}

/** grep 命中行形态(`path:12:...` 或 `12:...`)—— 兜底时优先保这些块。 */
const GREP_HIT_RE = /(?:^|[\s"'(])(?:[^\s:]*):\d+:|^\s*\d+[:-]/m;
/** 日志异常行 —— 兜底时优先保「错误行 ± 上下文」。 */
const LOG_ERROR_RE = /\b(?:ERROR|FATAL|CRITICAL|PANIC|Exception|Traceback|error:|失败|错误)\b/i;

function chunkHasPattern(chunk: IntakeChunk, re: RegExp): boolean {
  return re.test(chunk.text);
}

/**
 * 确定性兜底选块(不依赖任何外部服务):
 * 头部、尾部各一块保锚点 + 命中 grep 行 / 日志异常行的块 + 与 goal 词面重合度高的块。
 * 返回按「优先级从高到低」的索引序列。
 */
export function deterministicSelection(chunks: readonly IntakeChunk[], goal = ""): number[] {
  const total = chunks.length;
  if (total === 0) return [];
  const picked = new Set<number>();
  const order: number[] = [];
  const push = (i: number): void => {
    if (i < 0 || i >= total || picked.has(i)) return;
    picked.add(i);
    order.push(i);
  };
  push(0);
  push(total - 1);
  chunks.forEach((chunk) => { if (chunkHasPattern(chunk, GREP_HIT_RE)) push(chunk.index); });
  chunks.forEach((chunk) => { if (chunkHasPattern(chunk, LOG_ERROR_RE)) push(chunk.index); });
  // 词面重合:goal 里长度 ≥2 的片段(chinese 2 字 / 英文 4 字)命中多的块排前面。
  const needles = Array.from(new Set(
    goal.split(/[\s,，。;；:：/\\()[\]{}"'`|]+/)
      .map((s) => s.trim())
      .filter((s) => (s.length >= 2 && /[^\x00-\x7f]/.test(s)) || s.length >= 4),
  )).slice(0, 12);
  if (needles.length > 0) {
    const scored = chunks
      .map((chunk) => ({ index: chunk.index, hits: needles.filter((n) => chunk.text.includes(n)).length }))
      .filter((x) => x.hits > 0)
      .sort((a, b) => b.hits - a.hits);
    for (const item of scored) push(item.index);
  }
  // 兜底:其余块按原序补上(调用方按预算裁剪,不会全进)。
  for (const chunk of chunks) push(chunk.index);
  return order;
}

/** 把选中的块渲染成带原文标签的文本(逐块 `【<chunkLabel>】`)。 */
export function renderChunks(chunks: readonly IntakeChunk[], indices: readonly number[]): string {
  const indexSet = new Set(indices);
  return chunks
    .filter((chunk) => indexSet.has(chunk.index))
    .map((chunk) => `【${chunkLabel(chunk)}】\n${chunk.text}`)
    .join("\n");
}

export interface SelectResult {
  kept: number[];
  dropped: number[];
  keptChars: number;
  droppedChars: number;
  scorer: string;
  /** 打分器失败原因(fallback 时非空)。 */
  error?: string;
}

/**
 * 选块:优先用 8105 判相关性,失败/超时 → 确定性兜底。
 * 无论哪条路,**头尾两块都保底**(锚点),再按预算裁剪。
 */
export async function selectChunks(opts: {
  chunks: readonly IntakeChunk[];
  goal: string;
  budgetTokens: number;
  config?: BigIntakeConfig;
  signalTimeoutMs?: number;
}): Promise<SelectResult> {
  const { chunks, goal } = opts;
  const budgetChars = Math.max(2_000, Math.floor(opts.budgetTokens * 4));
  const total = chunks.length;
  const head = 0;
  const tail = total - 1;

  let relevance: Map<number, number> | undefined;
  let scorerName = "deterministic";
  let error: string | undefined;
  // 只在**显式配置了打分器**时才发 HTTP:未配置 = 本机没有 8105,直接走确定性兜底
  // (避免 model-scoring 的缺省 providerUrl 让每个大结果都白等一次连接超时)。
  const scorer = opts.config?.scorer;
  const useScorer = !!scorer && resolveModelScoringConfig(scorer).mode !== "off";
  if (useScorer && total > 1 && goal.trim()) {
    const candidates: ScoringCandidate[] = chunks.map((chunk) => ({
      id: `chunk${chunk.index}`,
      tool: "chunk",
      where: chunkLabel(chunk),
      chars: chunk.text.length,
      preview: chunk.text.slice(0, 800),
    }));
    const timeoutMs = opts.signalTimeoutMs ?? opts.config?.scorerTimeoutMs ?? 1_500;
    const scoring = await Promise.race([
      scoreContextCandidates(scorer, candidates, goal),
      new Promise<undefined>((resolveTimeout) => { setTimeout(() => resolveTimeout(undefined), timeoutMs).unref?.(); }),
    ]);
    if (scoring && scoring.decisions.length > 0 && !scoring.error) {
      relevance = new Map(scoring.decisions.map((d) => [Number(d.id.replace("chunk", "")), d.keepResult]));
      scorerName = `jev:${scoring.providerUrl}`;
    } else {
      error = scoring?.error ?? (scoring ? "无决策" : `打分超时(${timeoutMs}ms)`);
    }
  }

  // 排序:头尾必留 → 相关性降序(或确定性优先级)→ 原序。
  const priority: number[] = [head, tail];
  if (relevance) {
    const ranked = chunks
      .map((chunk) => chunk.index)
      .filter((i) => i !== head && i !== tail)
      .sort((a, b) => (relevance.get(b) ?? 0) - (relevance.get(a) ?? 0));
    priority.push(...ranked);
  } else {
    for (const i of deterministicSelection(chunks, goal)) priority.push(i);
  }
  const kept: number[] = [];
  const visited = new Set<number>();
  let keptChars = 0;
  const anchors = new Set([head, tail]);
  for (const index of priority) {
    if (visited.has(index)) continue;
    visited.add(index);
    const chunk = chunks[index];
    if (!chunk) continue;
    // 头尾两块是锚点:无条件保留(哪怕略微超预算——没有头尾的摘要是不可用的)。
    const isAnchor = anchors.has(index);
    // 其余块超预算就跳过(不进 kept);它会在下面自动落进 dropped —— 不许静默消失。
    if (!isAnchor && keptChars + chunk.text.length > budgetChars && kept.length > 0) continue;
    kept.push(index);
    keptChars += chunk.text.length;
  }
  const keptSet = new Set(kept);
  const dropped = chunks.map((c) => c.index).filter((i) => !keptSet.has(i));
  const droppedChars = dropped.reduce((n, i) => n + (chunks[i]?.text.length ?? 0), 0);
  return {
    kept: kept.sort((a, b) => a - b),
    dropped,
    keptChars,
    droppedChars,
    scorer: scorerName,
    ...(error ? { error } : {}),
  };
}

/** `diff --git a/<p> b/<p>` 文件头行。 */
const DIFF_GIT_HEAD_RE = /^diff --git (.+)$/;
/** hunk 头 `@@ -n,m +n,m @@`(逗号计数可省)。 */
const HUNK_HEAD_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;
/** `+++ b/<p>` 新侧路径(可与 `--- a/<p>` 成对构成文件头)。 */
const PLUS_FILE_RE = /^\+\+\+ b\/(.+?)(?:\t.*)?$/;

interface DiffShape {
  /** 判为 diff 的文本(JSON 包裹时是解包后的文本)。 */
  text: string;
  /** diff 涉及的文件路径(b 侧优先,去重保序)。 */
  files: string[];
  /** 命中来自 JSON 解包(原始 content 是单行 JSON)时为 true,用于 header 如实标注。 */
  jsonWrapped: boolean;
}

function stripPathQuotes(p: string): string {
  return p.replace(/^"|"$/g, "").trim();
}

function pushUnique(list: string[], value: string): void {
  if (value.length > 0 && !list.includes(value)) list.push(value);
}

/** 从 `diff --git` 的尾部取文件路径:b 侧优先,取不到退回 a 侧。 */
function diffGitPath(rest: string): string | undefined {
  const trimmed = rest.trim();
  const pair = /^(?:a\/)?(.+?) b\/(.+)$/.exec(trimmed);
  if (pair) return stripPathQuotes(pair[2]!);
  const last = trimmed.split(/\s+/).pop();
  if (!last) return undefined;
  const p = stripPathQuotes(last.replace(/^[ab]\//, ""));
  return p.length > 0 ? p : undefined;
}

/** 文本形态判定:至少 1 个文件头 + 1 个 hunk 才算 diff。 */
function diffShapeOf(text: string): DiffShape | undefined {
  const files: string[] = [];
  let gitHeaders = 0;
  let pairedHeaders = 0;
  let hunks = 0;
  let seenMinus = false;
  for (const line of text.split("\n")) {
    const head = DIFF_GIT_HEAD_RE.exec(line);
    if (head) {
      gitHeaders += 1;
      seenMinus = false;
      const p = diffGitPath(head[1]!);
      if (p) pushUnique(files, p);
      continue;
    }
    if (HUNK_HEAD_RE.test(line)) {
      hunks += 1;
      seenMinus = false;
      continue;
    }
    if (/^--- (?:a\/|\/dev\/null)/.test(line)) {
      seenMinus = true;
      continue;
    }
    const plus = PLUS_FILE_RE.exec(line);
    if (plus) {
      if (seenMinus) pairedHeaders += 1;
      pushUnique(files, stripPathQuotes(plus[1]!));
      seenMinus = false;
      continue;
    }
    if (line.length > 0) seenMinus = false;
  }
  if (gitHeaders + pairedHeaders < 1 || hunks < 1) return undefined;
  return { text, files, jsonWrapped: false };
}

/** 递归收集 JSON 里的所有 string leaf(按出现顺序),用于「解包被 JSON 包裹的 diff」。 */
function collectStringLeaves(value: unknown, out: string[], depth: number): void {
  if (depth > 40 || out.length > 200_000) return;
  if (typeof value === "string") { out.push(value); return; }
  if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, out, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectStringLeaves(item, out, depth + 1);
  }
}

/**
 * 识别 git diff 结果(diff 专用提炼轨):
 * ① 直接文本:`diff --git ` 文件头(或 `--- a/` + `+++ b/` 成对)且含 hunk 头才算;
 * ② JSON 包裹(压缩单行 `{...}` / `[...]`,如 `{"stdout":["..."],...}`):解包所有 string leaf
 *    用换行拼回后按 ① 再判,命中即返回**解包后**的文本(mtime/转义换行都被还原)。
 * 命中返回 { text, files },未命中返回 undefined(调用方维持原路径,逐字不变)。
 */
export function detectDiffText(content: string): DiffShape | undefined {
  if (typeof content !== "string" || content.length === 0) return undefined;
  const direct = diffShapeOf(content);
  if (direct) return direct;
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined; // parse 失败 → 已按直接文本判过,不命中
  }
  const leaves: string[] = [];
  collectStringLeaves(parsed, leaves, 0);
  if (leaves.length === 0) return undefined;
  const unpacked = diffShapeOf(leaves.join("\n"));
  return unpacked ? { ...unpacked, jsonWrapped: true } : undefined;
}

export interface DiffFileStat {
  path: string;
  added: number;
  removed: number;
  hunks: number;
}

export interface DiffStats {
  files: DiffFileStat[];
  totalAdded: number;
  totalRemoved: number;
  fileCount: number;
}

/**
 * 确定性 diff 统计(纯函数):数字由代码算,模型只许照抄。
 * - 只数 hunk 内的 `+`/`-` 行,并排除 `+++` / `---` 文件头;
 * - 文件路径取 `diff --git` 的 b 侧(无该行时退回 `+++ b/`),同路径只记一次。
 */
export function diffStats(diffText: string): DiffStats {
  const files: DiffFileStat[] = [];
  const byPath = new Map<string, DiffFileStat>();
  let cur: DiffFileStat | undefined;
  let inHunk = false;
  const ensure = (path: string): DiffFileStat => {
    let f = byPath.get(path);
    if (!f) {
      f = { path, added: 0, removed: 0, hunks: 0 };
      byPath.set(path, f);
      files.push(f);
    }
    cur = f;
    return f;
  };
  for (const line of diffText.split("\n")) {
    const head = DIFF_GIT_HEAD_RE.exec(line);
    if (head) {
      const p = diffGitPath(head[1]!);
      cur = p ? ensure(p) : undefined;
      inHunk = false;
      continue;
    }
    if (HUNK_HEAD_RE.test(line)) {
      if (cur) cur.hunks += 1;
      inHunk = true;
      continue;
    }
    if (line.startsWith("+++ ")) {
      // 无 `diff --git` 的 unified diff:以新侧文件头起一个新文件。
      const plus = PLUS_FILE_RE.exec(line);
      if (plus) ensure(stripPathQuotes(plus[1]!));
      inHunk = false;
      continue;
    }
    if (line.startsWith("--- ")) {
      inHunk = false;
      continue;
    }
    if (!inHunk || !cur) continue;
    if (line.startsWith("+")) {
      if (!line.startsWith("+++")) cur.added += 1;
    } else if (line.startsWith("-")) {
      if (!line.startsWith("---")) cur.removed += 1;
    }
  }
  const totalAdded = files.reduce((n, f) => n + f.added, 0);
  const totalRemoved = files.reduce((n, f) => n + f.removed, 0);
  return { files, totalAdded, totalRemoved, fileCount: files.length };
}

/** 把 diffStats 渲染成提示词里的固定文本块:模型必须逐字使用。 */
export function diffStatsBlock(stats: DiffStats): string {
  const lines = ["## 确定性统计(必须逐字使用,禁止自行计算或改写)"];
  for (const f of stats.files) lines.push(`- ${f.path} +${f.added}/-${f.removed}, ${f.hunks} hunk`);
  lines.push(`- 合计:+${stats.totalAdded}/-${stats.totalRemoved}, ${stats.fileCount} 个文件`);
  return lines.join("\n");
}

interface DiffFileGroup {
  /** `diff --git ...` 头行。 */
  head: string;
  /** 头行到首个 hunk 之间的元信息行(index / --- / +++ / rename 等)。 */
  meta: string[];
  /** 每个 hunk = `@@` 行起的连续行(含 hunk 头)。 */
  hunks: string[][];
}

function groupDiffByFile(diffText: string): DiffFileGroup[] {
  const groups: DiffFileGroup[] = [];
  let cur: DiffFileGroup | undefined;
  let hunk: string[] | undefined;
  const flushHunk = (): void => {
    if (cur && hunk && hunk.length > 0) cur.hunks.push(hunk);
    hunk = undefined;
  };
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flushHunk();
      cur = { head: line, meta: [], hunks: [] };
      groups.push(cur);
      continue;
    }
    if (!cur) continue; // 首个文件头之前的说明性文字不属于任何文件
    if (HUNK_HEAD_RE.test(line)) {
      flushHunk();
      hunk = [line];
      continue;
    }
    if (hunk) hunk.push(line);
    else cur.meta.push(line);
  }
  flushHunk();
  return groups;
}

/**
 * 把 diff 压到提炼模型的输入上限内(按文件分组保留结构):
 * - 所有文件的 `diff --git` 头行与元信息(index / --- / +++ / rename)无条件保留;
 * - 每文件 hunk 超预算时**均匀抽样**:保 hunk 1、最后一个,以及按剩余预算均匀间隔的中间 hunk;
 * - 被跳过的位置显式写 `…(跳过 N 个 hunk)…`,尾部 hunk 也有机会进输入。
 */
export function compressDiffForDigest(diffText: string, maxChars = DIGEST_INPUT_MAX_CHARS): string {
  const groups = groupDiffByFile(diffText);
  if (groups.length === 0) {
    return diffText.length > maxChars ? `${diffText.slice(0, Math.max(0, maxChars - 20))}\n…(余下内容已截断)` : diffText;
  }
  // 头行 + 元信息成本(每行 +1 = join 的换行;轻微高估是安全的)。
  const headsCost = groups.reduce(
    (n, g) => n + [g.head, ...g.meta].reduce((m, l) => m + l.length + 1, 0),
    0);
  if (headsCost > maxChars) {
    // 极端:头行/元信息本身就超预算 → 头行优先,元信息按顺序裁,不保 hunk。
    const out: string[] = [];
    let used = 0;
    for (const g of groups) {
      if (used + g.head.length + 1 > maxChars) break;
      out.push(g.head);
      used += g.head.length + 1;
      for (const line of g.meta) {
        if (used + line.length + 1 > maxChars) break;
        out.push(line);
        used += line.length + 1;
      }
      const note = skipNoteOf(g.hunks.length);
      if (g.hunks.length > 0 && used + note.length + 1 <= maxChars) {
        out.push(note);
        used += note.length + 1;
      }
    }
    return out.join("\n");
  }
  const budget = maxChars - headsCost;
  // 每文件均分预算(余数按顺序补给前面的文件,确定性)。
  const shares = groups.map(() => Math.floor(budget / groups.length));
  let remainder = budget - shares.reduce((a, b) => a + b, 0);
  for (let i = 0; i < shares.length && remainder > 0; i++) {
    shares[i] = shares[i]! + 1;
    remainder -= 1;
  }
  const plans = groups.map((g, i) => planDiffHunks(g.hunks, shares[i]!));
  // 回收没花完的预算,均分给「还有 hunk 没选」的文件后重规划一轮(仍超限则逐个回退)。
  const leftover = budget - plans.reduce((n, p) => n + p.cost, 0);
  if (leftover > 0) {
    const needy = plans.map((p, i) => i).filter((i) => plans[i]!.picks.size < groups[i]!.hunks.length);
    const extra = needy.length > 0 ? Math.floor(leftover / needy.length) : 0;
    if (extra > 0) {
      for (const i of needy) {
        const replanned = planDiffHunks(groups[i]!.hunks, shares[i]! + extra);
        if (replanned.picks.size > plans[i]!.picks.size) plans[i] = replanned;
      }
      let total = headsCost + plans.reduce((n, p) => n + p.cost, 0);
      for (let k = needy.length - 1; k >= 0 && total > maxChars; k--) {
        const idx = needy[k]!;
        const fallback = planDiffHunks(groups[idx]!.hunks, shares[idx]!);
        total -= plans[idx]!.cost - fallback.cost;
        plans[idx] = fallback;
      }
    }
  }
  const buildOut = (): string => {
    const out: string[] = [];
    groups.forEach((g, i) => {
      out.push(g.head, ...g.meta);
      const picks = plans[i]!.picks;
      let skipped = 0;
      for (let k = 0; k < g.hunks.length; k++) {
        if (picks.has(k)) {
          if (skipped > 0) {
            out.push(skipNoteOf(skipped));
            skipped = 0;
          }
          out.push(...g.hunks[k]!);
        } else {
          skipped += 1;
        }
      }
      if (skipped > 0) out.push(skipNoteOf(skipped));
    });
    return out.join("\n");
  };
  let text = buildOut();
  // 以真实拼装长度为准收敛(估算与实际可能差几十字符):超限就从后往前退回抽样,头行永不丢。
  for (let guard = 0; text.length > maxChars && guard < groups.length; guard++) {
    let reverted = false;
    for (let i = groups.length - 1; i >= 0; i--) {
      const cur = plans[i]!;
      if (cur.picks.size === 0) continue;
      const fallback = planDiffHunks(groups[i]!.hunks, shares[i]!);
      if (fallback.picks.size < cur.picks.size) {
        plans[i] = fallback;
        reverted = true;
        break;
      }
    }
    if (!reverted) break;
    text = buildOut();
  }
  // 兜底:任何路径都不许超过上限(理论上不会触发)。
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 20))}\n…(余下内容已截断)`;
}

/** 被跳过的 hunk 位置标注(计数由代码给出,不静默丢)。 */
function skipNoteOf(count: number): string {
  return `…(跳过 ${count} 个 hunk)…`;
}

/**
 * 单文件 hunk 均匀抽样:保 hunk 1、最后一个,再按预算均匀间隔补中间 hunk;
 * cost 含跳过标注行,保证该文件总成本 ≤ budget(预算连头尾都放不下时只保能放下的一侧)。
 */
function planDiffHunks(hunks: string[][], budget: number): { picks: Set<number>; cost: number } {
  const n = hunks.length;
  const picks = new Set<number>();
  if (n === 0) return { picks, cost: 0 };
  const costs = hunks.map((h) => h.reduce((m, l) => m + l.length + 1, 0));
  const allCost = costs.reduce((a, b) => a + b, 0);
  if (allCost <= budget) {
    for (let i = 0; i < n; i++) picks.add(i);
    return { picks, cost: allCost };
  }
  if (n === 1) return { picks, cost: 0 };
  const first = 0;
  const last = n - 1;
  const base = costs[first]! + costs[last]!;
  if (base > budget) {
    if (costs[first]! <= budget) {
      picks.add(first);
      return { picks, cost: costs[first]! };
    }
    if (costs[last]! <= budget) {
      picks.add(last);
      return { picks, cost: costs[last]! };
    }
    return { picks, cost: 0 };
  }
  picks.add(first);
  picks.add(last);
  const mids = n - 2;
  if (mids <= 0) return { picks, cost: base };
  const midCost = costs.slice(1, last).reduce((a, b) => a + b, 0);
  const avg = midCost / mids;
  // 先按平均成本 + 跳过标注估个数,再按真实成本回调 / 试探加一。
  let count = Math.min(mids, Math.max(0, Math.floor((budget - base) / Math.max(1, avg + 16))));
  const build = (c: number): Set<number> => {
    const s = new Set<number>([first, last]);
    for (let j = 0; j < c; j++) {
      const idx = 1 + Math.floor(((j + 1) * mids) / (c + 1));
      s.add(Math.min(last - 1, Math.max(1, idx)));
    }
    return s;
  };
  const costWith = (s: Set<number>): number => {
    let c = 0;
    let skipped = 0;
    for (let i = 0; i < n; i++) {
      if (s.has(i)) {
        c += costs[i]!;
        if (skipped > 0) {
          c += skipNoteOf(skipped).length + 1;
          skipped = 0;
        }
      } else {
        skipped += 1;
      }
    }
    if (skipped > 0) c += skipNoteOf(skipped).length + 1;
    return c;
  };
  let best = build(count);
  let bestCost = costWith(best);
  while (bestCost > budget && count > 0) {
    count -= 1;
    best = build(count);
    bestCost = costWith(best);
  }
  for (let guard = 0; guard <= mids && best.size < n; guard++) {
    const next = build(count + 1);
    if (next.size <= best.size) break;
    const c = costWith(next);
    if (c > budget) break;
    count += 1;
    best = next;
    bestCost = c;
  }
  return { picks: best, cost: bestCost };
}

/** git diff 专用提示词:确定性统计 / 文件清单 / 每文件关键改动(file:line 锚点照抄)/ 风险 / 建议。 */
export function diffPrompt(goal: string, body: string, tool: string, stats?: string): string {
  return [
    "你是 diff 审阅助手。下面是一次工具调用输出里的 git diff(可能已按预算裁剪,不代表全部改动)。",
    "请**只依据给定 diff 内容输出**,锚点逐字照抄,禁止推测编造:",
    ...(stats ? [stats, ""] : []),
    "## 改了哪些文件",
    "(文件清单与行数统计以「确定性统计」为准:逐字照抄,禁止自行计算或改写;每行只补一句改动性质;没有就写「无」)",
    "## 每个文件的关键改动",
    "(每文件 1-3 条,格式 `file:line 改了什么`;锚点必须逐字照抄 diff 原文,禁止推测;没有就写「无」)",
    "## 风险",
    "(行为变化 / 兼容性 / 漏测试;没有就写「无」)",
    "## 建议",
    "(最多 3 条,可执行的动作)",
    "",
    `任务目标:${goal || "(未提供)"}`,
    `工具:${tool}`,
    "",
    "diff 内容:",
    body,
  ].join("\n");
}

/** 小模型摘要的四段提示词(锚点/数字要求「照抄原文、不得改写杜撰」)。 */
export function digestPrompt(goal: string, body: string, tool: string): string {
  return [
    "你是上下文压缩助手。下面是一次工具调用的输出(已按相关性筛选过,可能不连续)。",
    "请**只依据给定内容**输出四段,禁止推测、禁止编造:",
    "## 关键结论",
    "(任务相关的事实,3-6 条,没有就写「无」)",
    "## 精确锚点",
    "(原文里出现的 file:line / 标识符 / 数字,逐字照抄,每条一行;没有就写「无」)",
    "## 异常与风险",
    "(错误、警告、可疑之处;没有就写「无」)",
    "## 下一步建议",
    "(最多 3 条,可执行的动作)",
    "",
    `任务目标:${goal || "(未提供)"}`,
    `工具:${tool}`,
    "",
    "内容:",
    body,
  ].join("\n");
}

/** 拼装产物的账目:bodyChars=真正进上下文的正文长度;truncatedChars=被 INTAKE_MAX_CHARS 截掉的正文长度。 */
export interface AssembledIntake {
  text: string;
  bodyChars: number;
  truncatedChars: number;
}

/** 拼装最终进上下文的文本:标记 + 正文 + 落盘指针 + 筛掉清单(截断量必须同时记账与显式告知)。 */
export function assembleIntake(opts: {
  body: string;
  policy: IntakePolicy;
  totalChars: number;
  totalTokens: number;
  totalLines: number;
  keptChunks: number;
  totalChunks: number;
  dropped: readonly number[];
  chunks: readonly IntakeChunk[];
  droppedChars: number;
  dumpPath?: string;
  dumpError?: string;
  /** 截断段在**原文**中的字符区间定位器(给 chars=s-e 指针用);拿不到就写 chars=s-e。 */
  truncatedRangeOf?: (bodyChars: number) => { start: number; end: number } | undefined;
  /** digest(diff) 账目:给了且 policy=digest 时 header 走精炼口径(不报切块/筛掉清单)。 */
  digestDiff?: { inputChars: number; fileCount: number; jsonWrapped: boolean };
  /** 追加到 header `]` 之前的说明(如「提炼失败,已回退选块」);缺省 = 与既有输出逐字相同。 */
  note?: string;
}): AssembledIntake {
  const droppedText = opts.dropped.length === 0
    ? "无"
    : `${opts.dropped.length} 块/${opts.droppedChars} 字符(` + opts.dropped
      .slice(0, 8)
      .map((i) => { const c = opts.chunks[i]; return c ? chunkLabel(c) : "?"; })
      .join("、") + (opts.dropped.length > 8 ? " 等" : "") + ")";
  // truncate = 切不动(只有一块)且超预算:header 必须如实说「未切块」,不许假称 chunk-select。
  const truncateNote = opts.policy === "truncate"
    ? `,未切块(无可切边界),超出本步预算${opts.dumpPath ? ",全文在 dump" : ""}`
    : "";
  // digest(diff) 的输入不是「选中的块」而是整份 diff 的压缩体:账目必须换成精炼口径,
 // 否则「切 N 块保留 M 块」+「筛掉清单」会把两套路径的账混在一起(经验证误导 60 倍)。
  const digestDiff = opts.policy === "digest" && opts.digestDiff !== undefined;
  const lineLabel = opts.digestDiff?.jsonWrapped ? "单行 JSON" : `${opts.totalLines} 行`;
  const baseHead = digestDiff
    ? `${SPILL_MARKER_PREFIX}大结果闸门 digest(diff);原共 ${opts.totalChars} 字符/${opts.totalTokens} tok/${lineLabel},`
      + `压缩 ${opts.digestDiff!.inputChars} 字符送提炼(${opts.digestDiff!.fileCount} 个文件)]`
    : `${SPILL_MARKER_PREFIX}大结果闸门 ${opts.policy};原共 ${opts.totalChars} 字符/${opts.totalTokens} tok/${opts.totalLines} 行,`
      + `切 ${opts.totalChunks} 块保留 ${opts.keptChunks} 块${truncateNote}]`;
  const pointer = opts.dumpPath
    ? `全文已落盘:${opts.dumpPath}(${opts.totalLines} 行/${opts.totalTokens} tok),用 result_read 取回(offset/limit 或 grep;单行结果可用 chars=s-e 按字符窗口)`
    : `全文未能落盘,请重跑缩小范围(${opts.dumpError ?? "unknown"})`;
  const baseDropped = digestDiff ? "" : `筛掉清单:${droppedText}`;
  const MARKER = "…(选块正文按上限截断)";
  // 外部追加说明(diff 轨回退等)拼在 header `]` 之前、截断说明之后。
  const extra = opts.note ? `;${opts.note}` : "";
  const headerOf = (trunc: string): string =>
    trunc ? `${baseHead.slice(0, -1)};${trunc}${extra}]` : `${baseHead.slice(0, -1)}${extra}]`;
  const droppedOf = (trunc: string): string =>
    baseDropped ? (trunc ? `${baseDropped};${trunc}` : baseDropped) : "";
  // 固定点:截断说明会加进 header 与筛掉清单,正文预算随之下调 → 迭代收敛。
  let note = "";
  let bodyChars = opts.body.length;
  for (let pass = 0; pass < 4; pass++) {
    const head = headerOf(note);
    const droppedLine = droppedOf(note);
    const markerLen = bodyChars < opts.body.length ? MARKER.length : 0;
    const avail = INTAKE_MAX_CHARS - head.length - pointer.length - droppedLine.length - 3 - markerLen;
    const nextBody = Math.max(0, Math.min(opts.body.length, avail));
    const nextTrunc = opts.body.length - nextBody;
    const range = nextTrunc > 0 ? opts.truncatedRangeOf?.(nextBody) : undefined;
    const nextNote = nextTrunc > 0
      ? `另 ${nextTrunc} 字符按上限截断(可用 result_read chars=${range ? `${range.start}-${range.end}` : "s-e"} 取回)`
      : "";
    if (nextBody === bodyChars && nextNote === note) break;
    bodyChars = nextBody;
    note = nextNote;
  }
  const truncatedChars = opts.body.length - bodyChars;
  const head = headerOf(note);
  const droppedLine = droppedOf(note);
  const bodyText = truncatedChars > 0 ? `${opts.body.slice(0, bodyChars)}${MARKER}` : opts.body;
  return {
    text: `${head}\n${bodyText}\n${pointer}${droppedLine ? `\n${droppedLine}` : ""}`,
    bodyChars,
    truncatedChars,
  };
}

/** 全文落盘路径:`<dir>/<safe(callId)>-<safe(tool)>.txt`。 */
export function dumpPathOf(dir: string, callId: string, toolName: string): string {
  return resolve(join(dir, `${safeSegment(callId)}-${safeSegment(toolName)}.txt`));
}

export interface IntakeOutcome {
  content: string;
  meta: IntakeMeta;
}

/**
 * 正文第 included 个字符后的截断点落在哪个块的正文里 → 返回原文中「未进上下文」尾段的字符区间。
 * 拼装顺序与 renderChunks 一致:`【label】\n` + text,块间以 `\n` 连接。
 */
function locateTruncatedRange(
  chunks: readonly IntakeChunk[],
  kept: readonly number[],
  included: number): { start: number; end: number } | undefined {
  let pos = 0;
  for (let k = 0; k < kept.length; k++) {
    const chunk = chunks[kept[k]!];
    if (!chunk) continue;
    const textStart = pos + `【${chunkLabel(chunk)}】\n`.length;
    const textEnd = textStart + chunk.text.length;
    if (included < textStart) return { start: chunk.charStart, end: chunk.charEnd }; // 整块未进
    if (included < textEnd) {
      return { start: chunk.charStart + (included - textStart), end: chunk.charEnd };
    }
    pos = textEnd + (k === kept.length - 1 ? 0 : 1); // +1 = join 的换行
  }
  return undefined;
}

/**
 * 闸门主入口:不触发 → 原样返回(无 meta);触发 → 选块(±摘要)+ 落盘 + 拼装。
 * **任何内部异常都 fail-open 返回原文**——闸门是省 token 的优化,不能因为它失败丢工具结果。
 */
export async function intakeToolResult(opts: {
  content: string;
  callId: string;
  toolName: string;
  goal: string;
  budgetTokens: number;
  config?: BigIntakeConfig;
}): Promise<IntakeOutcome | undefined> {
  const { content, callId, toolName } = opts;
  const started = Date.now();
  if (typeof content !== "string" || content.length === 0) return undefined;
  if (!shouldIntake(content, opts.budgetTokens, opts.config)) return undefined;
  const config = opts.config;
  try {
    const tokens = rawTokens(content);
    const lines = content.split("\n").length;
    // diff 专用轨:对**原始 content** 判 git diff(含被 JSON 包裹的)——diff 是结构性内容,
    // 选块会切断 hunk(锚点全丢),所以命中且配了提炼模型时,即使量级没到摘要线也走 digest。
    const diff = detectDiffText(content);
    const isDiff = diff !== undefined;
    const diffStatsInfo = isDiff ? diffStats(diff!.text) : undefined;
    const level = isDiff && config?.digest ? "digest" : intakeLevel(tokens, config);
 // 自适应块大小:头尾两块是硬保底,块太大会让「保底两块」自己就超预算。
    // 取 min(配置块, 预算的 35%) ⇒ 头尾合计约 70% 预算,余下再填高相关块。
    const autoChunk = Math.max(150, Math.floor(opts.budgetTokens * 0.35));
    const chunkTokens = Math.min(config?.chunkTokens ?? CHUNK_TARGET_TOKENS, autoChunk);
    const chunks = splitChunks(content, chunkTokens);
    const selected = await selectChunks({
      chunks, goal: opts.goal, budgetTokens: opts.budgetTokens, config,
    });
    let body = renderChunks(chunks, selected.kept);
    let policy: IntakePolicy = selected.error ? "fallback" : "chunk-select";
    // 切不动(只有一块)且超预算:如实标 truncate,不再假称「选块」。
    if (chunks.length === 1 && (opts.budgetTokens <= 0 || tokens > opts.budgetTokens)) policy = "truncate";
    // 摘要:结果本身超大(level=digest)或命中 diff 轨,且配了小模型才做;失败保留选块拼装。
    const digestKind: "diff" | "generic" = isDiff ? "diff" : "generic";
    let digestInputChars = 0;
    let digestError: string | undefined;
    let headerNote: string | undefined;
    if (isDiff && !config?.digest) headerNote = "diff 未提炼(提炼模型未配置)";
    if (level === "digest" && config?.digest && (isDiff || body.length > 0)) {
      // diff 轨送压缩后的完整结构(每文件头行必在);generic 轨送选块正文(超限取头尾)。
      const input = isDiff
        ? compressDiffForDigest(diff!.text)
        : body.length > DIGEST_INPUT_MAX_CHARS
          ? `${body.slice(0, DIGEST_INPUT_MAX_CHARS / 2)}\n…(中段略)…\n${body.slice(-DIGEST_INPUT_MAX_CHARS / 2)}`
          : body;
      const prompt = isDiff
        ? diffPrompt(opts.goal, input, toolName, diffStatsInfo ? diffStatsBlock(diffStatsInfo) : undefined)
        : digestPrompt(opts.goal, input, toolName);
      try {
        digestInputChars = input.length; // 账目:真正送进模型的字符数
        const digest = await config.digest(prompt, {
          timeoutMs: config.digestTimeoutMs ?? 20_000,
        });
        if (digest && digest.trim()) {
          body = digest.trim();
          policy = "digest";
        } else {
          // 空摘要 = 没提炼出来:如实回退选块,不静默当成功(两条轨都记账,header 只 diff 轨加注)。
          digestError = "empty";
          if (isDiff) {
            policy = "fallback";
            headerNote = "提炼失败,已回退选块(原因:empty)";
          }
        }
      } catch (err) {
        /* 小模型失败 → 保留选块拼装(不硬造摘要);原因归一后落 meta,不再吞掉 */
        const raw = err instanceof Error ? err.message : String(err);
        const flat = raw.replace(/\s+/g, " ").trim() || "unknown";
        digestError = flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
        if (isDiff) {
          policy = "fallback";
          const short = digestError.length > 60 ? `${digestError.slice(0, 59)}…` : digestError;
          headerNote = `提炼失败,已回退选块(原因:${short})`;
        }
      }
    }
    let dumpPath: string | undefined;
    let dumpError: string | undefined;
    if (config?.dumpDir) {
      try {
        const path = dumpPathOf(config.dumpDir, callId, toolName);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content, "utf8");
        dumpPath = path;
      } catch (err) {
        dumpError = err instanceof Error ? err.message : String(err);
      }
    }
    // 正文被 INTAKE_MAX_CHARS 截断时,定位「截掉的尾部」在原文里的字符区间(给 chars=s-e 指针)。
    const truncatedRangeOf = policy === "digest"
      ? undefined
      : (included: number): { start: number; end: number } | undefined => locateTruncatedRange(chunks, selected.kept, included);
    const assembled = assembleIntake({
      body,
      policy,
      totalChars: content.length,
      totalTokens: tokens,
      totalLines: lines,
      keptChunks: selected.kept.length,
      totalChunks: chunks.length,
      dropped: selected.dropped,
      chunks,
      droppedChars: selected.droppedChars,
      ...(dumpPath ? { dumpPath } : {}),
      ...(dumpError ? { dumpError } : {}),
      ...(truncatedRangeOf ? { truncatedRangeOf } : {}),
      ...(policy === "digest" && isDiff && diffStatsInfo
        ? { digestDiff: { inputChars: digestInputChars, fileCount: diffStatsInfo.fileCount, jsonWrapped: diff!.jsonWrapped } }
        : {}),
      ...(headerNote ? { note: headerNote } : {}),
    });
    return {
      content: assembled.text,
      meta: {
        tool: toolName,
        chars: content.length,
        tokens,
        chunks: chunks.length,
        keptChunks: selected.kept.length,
        // 账目诚实:keptChars = 真正进上下文的正文长度(不是原文/选中块长度总和)。
        keptChars: assembled.bodyChars,
        truncatedChars: assembled.truncatedChars,
        digestChars: policy === "digest" ? body.length : 0,
        digestKind,
        digestInputChars,
        ...(digestError ? { digestError } : {}),
        policy,
        ...(dumpPath ? { dumpPath } : {}),
        scorer: selected.scorer,
        droppedChunks: selected.dropped.length,
        droppedChars: selected.droppedChars,
        durationMs: Date.now() - started,
        ...(dumpError ? { dumpError } : {}),
      },
    };
  } catch {
    return undefined; // fail-open:返回 undefined = 调用方保持原文
  }
}

/** result_read 的取回参数。 */
export interface ResultReadArgs {
  ref: string;
  offset?: number;
  limit?: number;
  grep?: string;
  /**
   * 字符窗口 `"start-end"`(**1-based,含两端**),用于单行超长 dump(offset/limit 按行读不到内容)。
   * 与 offset/limit/grep 互斥;不给则行为逐字等同旧版。
   */
  chars?: string;
}

/**
 * 从 dump 取回行段/关键词片段(行号沿用原文)。
 * ref 可给 callId(按 `<dumpDir>/<callId>-*.txt` 找)或 dump 文件的绝对/仓内路径。
 */
export function readToolDump(
  args: ResultReadArgs,
  opts: { dumpDir?: string; maxChars?: number; toolHint?: string },
): { ok: true; text: string } | { ok: false; error: string } {
  const ref = String(args.ref ?? "").trim();
  if (!ref) return { ok: false, error: "ref 为空:给 callId 或 dump 文件路径" };
  const maxChars = opts.maxChars ?? 40_000;
  let path: string | undefined;
  if (ref.includes("/") || ref.endsWith(".txt")) {
    path = resolve(ref);
  } else if (opts.dumpDir) {
    path = dumpPathOf(opts.dumpDir, ref, opts.toolHint ?? "tool");
    if (!existsSync(path)) {
      // tool 名不确定时按 callId 前缀扫目录(装配侧不传 toolHint 的兜底)。
      try {
        const dir = resolve(opts.dumpDir);
        const hit = readdirSync(dir).find((f) => f.startsWith(`${safeSegment(ref)}-`) && f.endsWith(".txt"));
        if (hit) path = join(dir, hit);
      } catch { /* 目录不可读 → 走下面统一报错 */ }
    }
  }
  if (!path) return { ok: false, error: "无法解析 ref:请给 dump 文件的完整路径" };
  if (!existsSync(path)) return { ok: false, error: `dump 不存在:${path}` };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return { ok: false, error: `读 dump 失败:${err instanceof Error ? err.message : String(err)}` };
  }
  if (args.chars !== undefined && String(args.chars).trim() !== "") {
    // 字符窗口:单行 dump(压缩 JSON 等)按行读只能拿到整行,按字符才能取子段。
    if (args.offset !== undefined || args.limit !== undefined || (args.grep !== undefined && String(args.grep).trim() !== "")) {
      return { ok: false, error: "chars 与 offset/limit/grep 互斥:选一种取回方式" };
    }
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(String(args.chars).trim());
    if (!m) return { ok: false, error: `chars 格式应为 "start-end"(1-based 字符区间),收到:${args.chars}` };
    const total = text.length;
    const start = Math.max(1, Number(m[1]));
    const end = Math.min(total, Number(m[2]));
    if (start > total) return { ok: false, error: `chars 起点 ${start} 超出 dump 长度(共 ${total} 字符)` };
    if (end < start) return { ok: false, error: `chars 区间非法:end(${m[2]}) < start(${m[1]})` };
    let body = text.slice(start - 1, end);
    if (body.length > maxChars) body = body.slice(0, maxChars) + `\n…(超 ${maxChars} 字符截断;缩小 chars 区间)`;
    return { ok: true, text: `字符 ${start}-${end}(共 ${total} 字符)\n${body}` };
  }
  const lines = text.split("\n");
  const offset = Math.max(1, Math.floor(args.offset ?? 1));
  const limit = Math.max(0, Math.floor(args.limit ?? 200));
  let out: string[];
  let header: string;
  if (args.grep && args.grep.trim()) {
    let re: RegExp;
    try {
      re = new RegExp(args.grep, "i");
    } catch {
      re = new RegExp(args.grep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
    const hits: string[] = [];
    for (let i = 0; i < lines.length && hits.length < limit; i++) {
      if (re.test(lines[i]!)) hits.push(`${i + 1}|${lines[i]}`);
    }
    out = hits.length > 0 ? hits : ["(无命中)"];
    header = `grep "${args.grep}" 命中 ${hits.length} 行(共 ${lines.length} 行,上限 ${limit})`;
  } else {
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    out = slice.map((line, i) => `${offset + i}|${line}`);
    header = `行 ${offset}-${offset + slice.length - 1}(共 ${lines.length} 行)`;
  }
  let body = out.join("\n");
  if (body.length > maxChars) body = body.slice(0, maxChars) + `\n…(超 ${maxChars} 字符截断;缩小 limit 或用 grep)`;
  return { ok: true, text: `${header}\n${body}` };
}
