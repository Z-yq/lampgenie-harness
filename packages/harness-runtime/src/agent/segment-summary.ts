/**
 * 已闭合段温区批的语义摘要执行器(设计 §3.6.3/§4.1.2 第一手段)。
 * 设计口径:温区精简第一手段 = **小模型摘要**(产物 W′ 是新增冷区上下文);确定性占位化
 * (microcompact 组清理)降为兜底轨。本模块只负责「把计划命中的 tool 结果批成摘要文本」:
 * - 输入是**已 settle 批准**的 toolCallId 集(经济门已裁决,见 degradation-queue);
 * - 摘要由装配方注入的 `digest`(big-intake 同源小模型轨,gateway 的 digest 角色)生成;
 * - 未配置/超时/空摘要 → 返回空 Map,调用方回落确定性占位(不硬造、不阻塞)。
 * 纯异步边界、零 journal/消息副作用:只读 messages,返回 id→summary。摘要长度硬帽,
 * 避免「摘要本身又把上下文撑大」;原文全文仍在 journal/工具寻址处,可回读。
 */
import { isPlaceholderContent } from "./microcompact";

/** 单条结果低于此字符数不做语义摘要(省不出摘要成本,直接占位更划算)。 */
export const SEGMENT_SUMMARY_MIN_CHARS = 2_000;
/** 送给小模型的原文上限(字符);超出截断并显式标注。 */
export const SEGMENT_SUMMARY_MAX_INPUT_CHARS = 24_000;
/** 单条摘要产物字符上限(硬帽;与提示词「≤800 字」对齐,中文≈800 tok,覆盖 W′ 估价)。 */
export const SEGMENT_SUMMARY_MAX_CHARS = 800;
/** 摘要产物 token 估价(用于经济门 W′;确定性占位约 40 tok,摘要按 800 tok 保守估——
 * 提示词上限 800 字,中文近似 1 token/字,宁可高估也不让经济门误批)。 */
export const SEGMENT_SUMMARY_EST_TOKENS = 800;
/** 单批最多摘要条数(防一次 turn 末批准几十条把模型打爆;超出回落占位)。 */
export const SEGMENT_SUMMARY_MAX_PER_BATCH = 12;
/** 摘要并发数(小模型端点通常限流;3 路并行,失败条目回落占位)。 */
export const SEGMENT_SUMMARY_CONCURRENCY = 3;

export type SegmentDigest = (prompt: string, opts: { timeoutMs: number }) => Promise<string>;

/** 最小消息形状(避免把 loop 的 Message 类型拖进本模块;结构兼容)。 */
export interface SummaryMessage {
  role: string;
  toolCallId?: string;
  content?: unknown;
  toolCalls?: Array<{ id: string; name: string; arguments?: string }>;
}

export interface BuildSegmentSummaryOptions {
 /** settle 批准的 toolCallId 集。 */
  ids: ReadonlySet<string>;
  goal: string;
  digest?: SegmentDigest;
  digestTimeoutMs?: number;
}

function argsWhere(raw: string | undefined): string {
  if (!raw) return "";
  try {
    const a = JSON.parse(raw) as Record<string, unknown>;
    for (const k of ["path", "command", "pattern", "url"]) {
      const v = a[k];
      if (typeof v === "string" && v) return v.slice(0, 200);
    }
  } catch { /* 非法 JSON 不猜 */ }
  return "";
}

/** 小模型四段摘要提示词(关键结论/精确锚点/异常与风险/下一步)。 */
export function segmentSummaryPrompt(goal: string, tool: string, where: string, body: string): string {
  const truncated = body.length > SEGMENT_SUMMARY_MAX_INPUT_CHARS;
  const input = truncated ? body.slice(0, SEGMENT_SUMMARY_MAX_INPUT_CHARS) : body;
  return [
    "你在压缩一段已经闭合的工具结果(温区语义精简),供后续编码决策继续使用。",
    `任务目标:${goal.slice(0, 800) || "(未提供)"}`,
    `来源:${tool || "tool"}${where ? " " + where : ""}`,
    truncated ? `注意:原文共 ${body.length} 字符,以下只给前 ${SEGMENT_SUMMARY_MAX_INPUT_CHARS} 字符。` : "",
    "请输出四段,每段一行短标题,不要复述原文:",
    "关键结论:这段结果证明了什么/否定了什么",
    "精确锚点:后续要复用的文件、符号、行号、命令或参数",
    "异常与风险:错误、边界、不确定点(没有就写无)",
    "下一步:基于这段结果应继续做什么(没有就写无)",
    "总长不超过 800 字;不要输出代码块以外的寒暄。",
    "--- 原文 ---",
    input,
  ].filter(Boolean).join("\n");
}

/**
 * 为批准的计划生成摘要对照表。任何失败/空摘要的条目**不进入** Map(回落占位);
 * 单条摘要超过 `SEGMENT_SUMMARY_MAX_CHARS` 截断(显式标记省略)。
 */
export async function buildSegmentSummaryPlan(
  messages: readonly SummaryMessage[],
  opts: BuildSegmentSummaryOptions,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!opts.digest || opts.ids.size === 0 || !Array.isArray(messages)) return out;

 // toolCallId → 调用元数据(工具名/寻址);assistant.toolCalls 是派生消息里的可靠来源。
  const meta = new Map<string, { name: string; where: string }>();
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.toolCalls)) continue;
    for (const c of m.toolCalls) {
      if (c && typeof c.id === "string" && typeof c.name === "string") {
        meta.set(c.id, { name: c.name, where: argsWhere(c.arguments) });
      }
    }
  }

  const candidates: Array<{ id: string; prompt: string; chars: number }> = [];
  for (const m of messages) {
    if (m.role !== "tool" || typeof m.toolCallId !== "string" || !opts.ids.has(m.toolCallId)) continue;
    if (typeof m.content !== "string" || m.content.length < SEGMENT_SUMMARY_MIN_CHARS) continue;
    if (isPlaceholderContent(m.content)) continue; // 已占位/已摘要:不重复烧模型
    const id = m.toolCallId;
    const info = meta.get(id) ?? { name: "", where: "" };
    candidates.push({ id, prompt: segmentSummaryPrompt(opts.goal, info.name, info.where, m.content), chars: m.content.length });
  }
 // 大批次优先摘要最大的结果(省得最多);超出单批上限的其余条目回落占位。
  candidates.sort((a, b) => b.chars - a.chars);
  const digest = opts.digest;
  const jobs: Array<() => Promise<{ id: string; summary: string } | undefined>> = candidates
    .slice(0, SEGMENT_SUMMARY_MAX_PER_BATCH)
    .map(({ id, prompt }) => async () => {
      try {
        const text = await digest(prompt, { timeoutMs: opts.digestTimeoutMs ?? 20_000 });
        const summary = String(text ?? "").trim();
        if (!summary) return undefined;
        const capped = summary.length > SEGMENT_SUMMARY_MAX_CHARS
          ? summary.slice(0, SEGMENT_SUMMARY_MAX_CHARS) + "\n…(摘要超长已截断;全文按寻址重读)"
          : summary;
        return { id, summary: capped };
      } catch {
        return undefined; // fail-soft:占位兜底
      }
    });
  if (jobs.length === 0) return out;
 // 3 路并发:小模型端点限流下仍能在可接受时间内跑完整批;失败的条目自然回落占位。
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      if (!job) continue;
      const r = await job();
      if (r) out.set(r.id, r.summary);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SEGMENT_SUMMARY_CONCURRENCY, jobs.length) }, worker));
  return out;
}