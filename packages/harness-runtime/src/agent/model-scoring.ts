/**
 * Phase 1/2 上下文模型评分。
 *
 * 默认走本地 150M 的 Jev 形状:POST {providerUrl}/decide
 *   { state: {goal, candidates:[{id,tool,where,chars,preview}]},
 *     questions: { call_<id>: noul, result_<id>: noul } }
 * → { call_<id>: {label,confidence,probabilities:{true,false}}, ... }
 *
 * 也支持 OpenAI 兼容 provider(POST {base}/v1/chat/completions),给其它
 * 「提炼模型服务」留出口。所有失败 fail-soft:shadow 只留痕,active 回退确定性剪枝。
 *
 * 模型永远只处理「温区候选」:最近 N 条、认知工具、错误、不可逆回执都不送;
 * 不读整段 transcript,只读 goal + 每条结果的前 500 字,控制 150M 的输入分布。
 */
import type { Message } from "./loop";
import {
  COMPACTABLE_TOOLS,
  IRREVERSIBLE_TOOLS,
  NEVER_COMPACT_TOOLS,
  looksLikeErrorResult,
  toolCallIndex,
} from "./microcompact";

export type ModelScoringMode = "off" | "shadow" | "active";
export type ModelScoringApiType = "jev" | "openai";

/** 候选过小跳过阈值(2026-11-05 审计:今日 108 次评分里 62 次候选总 chars<20k,durationMs 合计
 *  297s 纯浪费)。导出常量便于测试与离线复算同口径。0 = 关闭该维判定。 */
export const MIN_SCORING_CANDIDATES = 3;
export const MIN_SCORING_TOTAL_CHARS = 20_000;
/** 同候选集缓存:内容键 TTL 与容量(进程内 Map,不落盘)。 */
export const SCORING_CACHE_TTL_MS = 60_000;
export const SCORING_CACHE_CAPACITY = 32;

export const DEFAULT_MODEL_SCORING = {
  mode: "shadow" as ModelScoringMode,
  /** 本地 150M 监听地址(05_serve.py --serve --port 8105;8000/8102/8103 已被本机服务占用)。 */
  providerUrl: "http://127.0.0.1:8105",
  model: "jev-150m",
  apiType: "jev" as ModelScoringApiType,
  minConfidence: 0.9,
  maxCandidates: 12,
  /** 候选数 < 此值不发 HTTP(候选太少,150M 判断不值一次 p50≈5.2s 的调用)。 */
  minCandidates: MIN_SCORING_CANDIDATES,
  /** 候选总字符 < 此值不发 HTTP(内容太少,剪枝收益趋零)。 */
  minTotalChars: MIN_SCORING_TOTAL_CHARS,
  scoreEverySteps: 5,
  timeoutMs: 8_000,
};

export interface ModelScoringConfig {
  mode?: ModelScoringMode;
  providerUrl?: string;
  model?: string;
  apiType?: ModelScoringApiType;
  /** 凭证 env 名;本地 150M 无需;外部 provider 可填。 */
  apiKeyEnv?: string;
  /** 高置信度阈值(keep/drop 都要求 confidence ≥ 此值)。 */
  minConfidence?: number;
  maxCandidates?: number;
  /** 候选数下限:低于它直接跳过评分(0 = 关闭)。 */
  minCandidates?: number;
  /** 候选总字符下限:低于它直接跳过评分(0 = 关闭)。 */
  minTotalChars?: number;
  /** 每 N 步评分一次;0/缺省=用默认 5。 */
  scoreEverySteps?: number;
  timeoutMs?: number;
  /** 测试注入;生产不传。 */
  fetchImpl?: typeof fetch;
}

export interface ScoringCandidate {
  id: string;
  tool: string;
  where: string;
  chars: number;
  preview: string;
}

export interface ScoringDecision {
  id: string;
  tool: string;
  where: string;
  keepCall: number;
  keepResult: number;
  confidence: number;
}

export interface ScoringResult {
  decisions: ScoringDecision[];
  error?: string;
  durationMs: number;
  providerUrl: string;
  model: string;
  apiType: string;
  /** 审计:实际发给评分模型的 goal 字符数、候选数、preview 总字符数。 */
  goalChars: number;
  candidateCount: number;
  previewChars: number;
  /** 候选总字符数(落账口径:判断「候选过小跳过」与剪枝收益的比较基准)。 */
  totalChars: number;
  /** 本次命中「同候选集缓存」,decisions 为上次结果,durationMs=0。 */
  cacheHit?: boolean;
  /** 候选过小被跳过(未发 HTTP),durationMs=0。 */
  skipped?: ScoringSkipReason;
  /** Jev 的 typed 问题数(每候选 call/result 两问);OpenAI 协议为 0。 */
  questionCount: number;
  /** 序列化后的请求体字节数;失败时也可能有(已构体)。 */
  requestBytes?: number;
}

export interface ModelDecisionSets {
  keep: Set<string>;
  drop: Set<string>;
}

export function resolveModelScoringConfig(config?: ModelScoringConfig): Required<Omit<ModelScoringConfig, "fetchImpl" | "apiKeyEnv">> & Pick<ModelScoringConfig, "apiKeyEnv" | "fetchImpl"> {
  const d = DEFAULT_MODEL_SCORING;
  const mode = config?.mode === "off" || config?.mode === "active" || config?.mode === "shadow" ? config.mode : d.mode;
  const apiType = config?.apiType === "openai" ? "openai" : "jev";
  return {
    mode,
    providerUrl: String(config?.providerUrl ?? d.providerUrl).trim(),
    model: String(config?.model ?? d.model).trim() || d.model,
    apiType,
    ...(config?.apiKeyEnv ? { apiKeyEnv: config.apiKeyEnv } : {}),
    minConfidence: clamp(config?.minConfidence ?? d.minConfidence, 0, 1),
    maxCandidates: Math.max(1, Math.min(50, Math.floor(config?.maxCandidates ?? d.maxCandidates))),
    minCandidates: Math.max(0, Math.min(50, Math.floor(config?.minCandidates ?? d.minCandidates))),
    minTotalChars: Math.max(0, Math.min(10_000_000, Math.floor(config?.minTotalChars ?? d.minTotalChars))),
    scoreEverySteps: Math.max(1, Math.min(100, Math.floor(config?.scoreEverySteps ?? d.scoreEverySteps))),
    timeoutMs: Math.max(500, Math.min(60_000, Math.floor(config?.timeoutMs ?? d.timeoutMs))),
    ...(config?.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
  };
}

export function shouldScoreStep(step: number, config?: ModelScoringConfig): boolean {
  const c = resolveModelScoringConfig(config);
  return c.mode !== "off" && step % c.scoreEverySteps === 0;
}

export type ScoringSkipReason = "too-few-candidates" | "content-too-small";

export function scoringTotalChars(candidates: readonly ScoringCandidate[]): number {
  return candidates.reduce((n, c) => n + (Number.isFinite(c.chars) ? c.chars : String(c.preview ?? "").length), 0);
}

/**
 * 候选过小跳过判定:候选太少或内容太少时不发 HTTP(150M 单次 p50≈5.2s,判断价值不抵成本)。
 * 阈值 0 = 关闭该维(既有直调用例/单测保持原语义)。
 */
export function scoringSkipReason(
  candidates: readonly ScoringCandidate[],
  minCandidates: number = MIN_SCORING_CANDIDATES,
  minTotalChars: number = MIN_SCORING_TOTAL_CHARS,
): ScoringSkipReason | undefined {
  if (minCandidates > 0 && candidates.length < minCandidates) return "too-few-candidates";
  if (minTotalChars > 0 && scoringTotalChars(candidates) < minTotalChars) return "content-too-small";
  return undefined;
}

interface ScoringCacheEntry {
  at: number;
  decisions: ScoringDecision[];
}

/** 同候选集缓存:sessionId + 候选 ids/chars 有序拼接 + goal 短哈希 → 上次 decisions。 */
const scoringCache = new Map<string, ScoringCacheEntry>();

/** 测试用:清空缓存(进程内单例,不落盘)。 */
export function resetModelScoringCache(): void {
  scoringCache.clear();
}

/** 测试/审计用:当前缓存条目数(容量淘汰断言)。 */
export function modelScoringCacheSize(): number {
  return scoringCache.size;
}

/** djb2(无依赖的短哈希;只用于缓存键的 goal 归一,不承担安全职责)。 */
function djb2(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

export function scoringContentKey(
  sessionId: string,
  candidates: readonly ScoringCandidate[],
  goal: string,
): string {
  const shape = candidates.map((c) => `${c.id}:${c.chars}`).join("\u0001");
  return `${sessionId}\u0000${djb2(shape)}\u0000${djb2(goal.slice(0, 500))}`;
}

function readScoringCache(key: string, now: number): ScoringDecision[] | undefined {
  const entry = scoringCache.get(key);
  if (!entry) return undefined;
  if (now - entry.at > SCORING_CACHE_TTL_MS) {
    scoringCache.delete(key);
    return undefined;
  }
  return entry.decisions;
}

function writeScoringCache(key: string, decisions: readonly ScoringDecision[], now: number): void {
  if (scoringCache.size >= SCORING_CACHE_CAPACITY) {
    for (const [k, e] of scoringCache) {
      if (now - e.at > SCORING_CACHE_TTL_MS) scoringCache.delete(k);
    }
    // 超限淘汰最旧:Map 迭代顺序 = 插入顺序。
    while (scoringCache.size >= SCORING_CACHE_CAPACITY) {
      const oldest = scoringCache.keys().next().value;
      if (oldest === undefined) break;
      scoringCache.delete(oldest);
    }
  }
  scoringCache.set(key, { at: now, decisions: decisions.map((d) => ({ ...d })) });
}

/**
 * 去掉 message.user 尾部注入的「核心纪律卡」。它不是任务目标,送给 150M 只会稀释
 * 候选相关性判断(真实链路实测 618 字 goal 里约 270 字是纪律文本)。
 */
export function stripInjectedGoalChrome(text: string): string {
  const marker = "\n## 核心纪律卡";
  const at = text.indexOf(marker);
  if (at >= 0) return text.slice(0, at).trim();
  if (text.trimStart().startsWith("## 核心纪律卡")) return "";
  return text.trim();
}

/** 最近 3 条用户文本作为 goal(跳过系统提醒/纪律卡);空=空串。 */
export function goalFromMessages(messages: readonly Message[]): string {
  return messages
    .filter((m) => m.role === "user" && !String(m.content ?? "").trimStart().startsWith("[系统提醒]"))
    .map((m) => stripInjectedGoalChrome(String(m.content ?? "")))
    .filter((text) => text.length > 0)
    .slice(-3)
    .map((text) => text.slice(0, 500))
    .join("\n");
}

/**
 * 只收集温区候选:最近 6 条消息不送(热区逐字),认知/错误/不可逆/无寻址不送。
 * 输入只带前 500 字,避免 150M 被长工具输出 OOD。
 */
export function collectScoringCandidates(
  messages: readonly Message[],
  maxCandidates = 12,
  hotTailMessages = 6,
): ScoringCandidate[] {
  const list = [...messages];
  const idx = toolCallIndex(list);
  const warmBefore = Math.max(0, list.length - Math.max(0, hotTailMessages));
  const out: ScoringCandidate[] = [];
  for (let i = 0; i < warmBefore && out.length < maxCandidates; i++) {
    const message = list[i]!;
    if (message.role !== "tool" || typeof message.content !== "string") continue;
    const meta = idx.get(message.toolCallId);
    if (!meta || !meta.where || !COMPACTABLE_TOOLS.has(meta.name)) continue;
    if (NEVER_COMPACT_TOOLS.has(meta.name) || IRREVERSIBLE_TOOLS.has(meta.name)) continue;
    if (looksLikeErrorResult(message.content)) continue;
    if (message.content.startsWith("[工具结果已") || message.content.startsWith("[超大工具结果已外置:")) continue;
    if (!message.content.trim()) continue;
    out.push({
      id: message.toolCallId,
      tool: meta.name,
      where: meta.where,
      chars: message.content.length,
      preview: message.content.slice(0, 500),
    });
  }
  return out;
}

/**
 * 模型只负责给「keep/drop」;active 时只有高置信度 keep/drop 才进集合。
 * drop 采用双票:call 和 result 都必须低于阈值,避免「调用历史要留、结果可丢」时
 * 把唯一结果也压掉(2026-10-25 实测的保守化收口)。
 */
export function buildModelDecisionSets(
  decisions: readonly ScoringDecision[],
  minConfidence = 0.9,
): ModelDecisionSets {
  const keep = new Set<string>();
  const drop = new Set<string>();
  // 1-0.9 在浮点下是 0.099999...;阈值比较加 eps,否则模型给的 0.1 会被误判为“不一致”。
  const dropThreshold = 1 - minConfidence;
  const atOrBelowDrop = (v: number) => v <= dropThreshold + 1e-9;
  for (const d of decisions) {
    if (!Number.isFinite(d.confidence) || d.confidence < minConfidence) continue;
    if (d.keepResult >= minConfidence) keep.add(d.id);
    else if (atOrBelowDrop(d.keepResult) && atOrBelowDrop(d.keepCall)) drop.add(d.id);
  }
  return { keep, drop };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
}

function endpointOf(baseUrl: string, apiType: ModelScoringApiType): string {
  const base = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("model scoring providerUrl 为空");
  if (apiType === "jev") return base.endsWith("/decide") ? base : `${base}/decide`;
  if (base.endsWith("/chat/completions")) return base;
  if (base.endsWith("/v1")) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function jevQuestions(candidates: readonly ScoringCandidate[]): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  for (const c of candidates) {
    questions[`call_${c.id}`] = {
      type: "noul",
      instructions: `Tool call ${c.id} (${c.tool}) should stay in history: knowing this call was made, with its input, still matters for what the assistant does next`,
      criteria: { true: "The call still matters.", false: "The call no longer matters." },
    };
    questions[`result_${c.id}`] = {
      type: "noul",
      instructions: `The full output of tool call ${c.id} (${c.tool}, ${c.chars} chars) should stay in history verbatim: the assistant is likely to need its exact contents again and dropping them would lose information`,
      criteria: { true: "The exact output is still needed.", false: "The exact output can be dropped." },
    };
  }
  return questions;
}

interface JevAnswer {
  label?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

function keepProbability(answer: JevAnswer | undefined): number | undefined {
  if (!answer) return undefined;
  const p = answer.probabilities?.true;
  if (typeof p === "number" && Number.isFinite(p)) return clamp(p, 0, 1);
  if (answer.label === "true" && typeof answer.confidence === "number") return clamp(answer.confidence, 0, 1);
  if (answer.label === "false" && typeof answer.confidence === "number") return clamp(1 - answer.confidence, 0, 1);
  return undefined;
}

function parseJevDecisions(
  body: unknown,
  candidates: readonly ScoringCandidate[],
): ScoringDecision[] {
  const answers = (body && typeof body === "object") ? body as Record<string, JevAnswer> : {};
  const decisions: ScoringDecision[] = [];
  for (const c of candidates) {
    const call = answers[`call_${c.id}`];
    const result = answers[`result_${c.id}`];
    const keepCall = keepProbability(call);
    const keepResult = keepProbability(result);
    if (keepCall === undefined || keepResult === undefined) {
      throw new Error(`Jev 响应缺少 ${c.id} 的 call/result 概率`);
    }
    const callConf = typeof call?.confidence === "number" && Number.isFinite(call.confidence) ? call.confidence : 0;
    const resultConf = typeof result?.confidence === "number" && Number.isFinite(result.confidence) ? result.confidence : 0;
    decisions.push({
      id: c.id,
      tool: c.tool,
      where: c.where,
      keepCall,
      keepResult,
      confidence: clamp(Math.min(callConf, resultConf), 0, 1),
    });
  }
  return decisions;
}

function openAiPrompt(goal: string, candidates: readonly ScoringCandidate[]): string {
  return [
    "Score whether each tool call/result should stay in the assistant history.",
    "Return JSON only: {\"decisions\":[{\"id\":\"...\",\"keepCall\":0..1,\"keepResult\":0..1,\"confidence\":0..1}]}",
    "keepResult=1 means the exact output is still needed; 0 means it can be dropped.",
    "",
    "GOAL:",
    goal,
    "",
    "CANDIDATES:",
    JSON.stringify(candidates, null, 1),
  ].join("\n");
}

function parseOpenAiDecisions(body: unknown, candidates: readonly ScoringCandidate[]): ScoringDecision[] {
  const content = (body as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("OpenAI 响应缺少 message.content");
  const jsonText = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("OpenAI 响应不是合法 JSON");
  }
  const raw = (parsed as { decisions?: unknown })?.decisions;
  if (!Array.isArray(raw)) throw new Error("OpenAI 响应缺少 decisions[]");
  const byId = new Map<string, { keepCall?: unknown; keepResult?: unknown; confidence?: unknown }>();
  for (const item of raw) {
    if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
      byId.set((item as { id: string }).id, item as { keepCall?: unknown; keepResult?: unknown; confidence?: unknown });
    }
  }
  const decisions: ScoringDecision[] = [];
  for (const c of candidates) {
    const item = byId.get(c.id);
    if (!item) throw new Error(`OpenAI 响应缺少 ${c.id} 的决策`);
    const keepCall = Number(item.keepCall);
    const keepResult = Number(item.keepResult);
    const confidence = Number(item.confidence);
    if (![keepCall, keepResult, confidence].every((n) => Number.isFinite(n))) {
      throw new Error(`OpenAI 响应 ${c.id} 的概率非法`);
    }
    decisions.push({
      id: c.id,
      tool: c.tool,
      where: c.where,
      keepCall: clamp(keepCall, 0, 1),
      keepResult: clamp(keepResult, 0, 1),
      confidence: clamp(confidence, 0, 1),
    });
  }
  return decisions;
}

/**
 * 调 150M/Jev 或 OpenAI 兼容 provider。失败返回 error,不抛(调用方决定 shadow/active 回退)。
 *
 * opts(2026-11-05 优化):
 *  - 候选过小(数 < minCandidates 或总 chars < minTotalChars)→ 不发 HTTP,返回 skipped 标记,durationMs=0。
 *  - 同候选集缓存(content key: sessionId+候选 ids/chars+goal 短哈希,TTL 60s,容量 32)→ 命中复用
 *    上次 decisions,durationMs=0,cacheHit=true;仅成功且 decisions 非空才写缓存(error 不写)。
 *  直调用例(不传 opts.skipTooSmall)保持「永远发请求」的旧语义。
 */
export interface ScoreContextOptions {
  /** 是否启用「候选过小跳过」(loop 侧启用;既有直调用例不传=关闭)。 */
  skipTooSmall?: boolean;
  /** 是否启用同候选集缓存。 */
  cache?: boolean;
  /** 缓存作用域(键里带 sessionId);缺省 "__global"。 */
  sessionId?: string;
  /** 注入时钟(测试用 TTL,不 sleep)。 */
  now?: () => number;
}

export async function scoreContextCandidates(
  config: ModelScoringConfig | undefined,
  candidates: readonly ScoringCandidate[],
  goal: string,
  opts?: ScoreContextOptions,
): Promise<ScoringResult> {
  const resolved = resolveModelScoringConfig(config);
  const clock = opts?.now ?? Date.now;
  const started = clock();
  const goalChars = goal.length;
  const candidateCount = candidates.length;
  const previewChars = candidates.reduce((n, c) => n + String(c.preview ?? "").length, 0);
  const totalChars = scoringTotalChars(candidates);
  const baseResult = {
    decisions: [] as ScoringDecision[],
    durationMs: 0,
    providerUrl: resolved.providerUrl,
    model: resolved.model,
    apiType: resolved.apiType,
    goalChars,
    candidateCount,
    previewChars,
    totalChars,
    questionCount: 0,
    cacheHit: false,
  };
  if (resolved.mode === "off" || candidates.length === 0) {
    return { ...baseResult, durationMs: clock() - started };
  }
  const skipReason = opts?.skipTooSmall
    ? scoringSkipReason(candidates, resolved.minCandidates, resolved.minTotalChars)
    : undefined;
  if (skipReason) return { ...baseResult, skipped: skipReason, durationMs: 0 };
  const cacheKey = opts?.cache
    ? scoringContentKey(opts.sessionId ?? "__global", candidates, goal)
    : undefined;
  if (cacheKey) {
    const cached = readScoringCache(cacheKey, clock());
    if (cached) {
      // 复制一份:调用方可能改 decisions,不能污染缓存。
      return { ...baseResult, decisions: cached.map((d) => ({ ...d })), cacheHit: true, durationMs: 0 };
    }
  }
  // 不在客户端降候选/截断;150M 的 8 问/行限制由批量服务的 chunking 处理。
  let requestBytes: number | undefined;
  let questionCount = 0;
  try {
    const url = endpointOf(resolved.providerUrl, resolved.apiType);
    const headers: Record<string, string> = { "content-type": "application/json" };
    const key = resolved.apiKeyEnv ? process.env[resolved.apiKeyEnv] : undefined;
    if (key) headers.authorization = `Bearer ${key}`;
    const body = resolved.apiType === "jev"
      ? {
          state: {
            goal,
            candidates: candidates.map(({ id, tool, where, chars, preview }) => ({ id, tool, where, chars, preview })),
          },
          questions: jevQuestions(candidates),
          calibrated: true,
        }
      : {
          model: resolved.model,
          temperature: 0,
          messages: [
            { role: "system", content: "You are a context pruning scorer. Output JSON only." },
            { role: "user", content: openAiPrompt(goal, candidates) },
          ],
        };
    questionCount = resolved.apiType === "jev" ? candidates.length * 2 : 0;
    const requestText = JSON.stringify(body);
    requestBytes = new TextEncoder().encode(requestText).length;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), resolved.timeoutMs);
    let response: Response;
    try {
      response = await (resolved.fetchImpl ?? fetch)(url, {
        method: "POST",
        headers,
        body: requestText,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("provider 返回非 JSON");
    }
    const decisions = resolved.apiType === "jev"
      ? parseJevDecisions(parsed, candidates)
      : parseOpenAiDecisions(parsed, candidates);
    // 只缓存「成功且非空」的结果:error 路径绝不写缓存(否则失败态会被 TTL 放大成 60s 失能)。
    if (cacheKey && decisions.length > 0) writeScoringCache(cacheKey, decisions, clock());
    return { ...baseResult, decisions, durationMs: clock() - started, questionCount, requestBytes };
  } catch (err) {
    return {
      ...baseResult,
      error: err instanceof Error ? err.message : String(err),
      durationMs: clock() - started,
      questionCount,
      ...(requestBytes !== undefined ? { requestBytes } : {}),
    };
  }
}
