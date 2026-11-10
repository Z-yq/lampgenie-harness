/**
 * auto-compact( §4.2 三段式)+ 压缩即 DevLog 落盘。
 * tail 保留 + 摘要 agent + compact boundary 落 journal + DevLog 双格式。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Journal, JournalEvent } from "@lampgenie/core";
import { deriveMessages, type LlmProvider, type Message } from "./loop";
import { buildFactsLedger } from "./facts-ledger";
import { microcompactMessages, type MicrocompactConfig } from "./microcompact";
// token 口径统一见 agent/token-estimate.ts(真分词器 + 标定 ratio)。
import { approxTokensOfChars, estimateMessagesTokens } from "./token-estimate";

/**
 * 摘要提示词(ZCode/apps/zcode-cli/packages/core/src/compact/prompt.ts 原文对齐):
 * 前导/主体/尾部三块,主体是九段式英文结构。摘要模型只许输出纯文本
 * (`<analysis>` + `<summary>` 块),禁调工具——否则压缩会变成又一轮工具调用。
 */
const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`;

const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like file names, full code snippets, function signatures, file edits
   - Errors that you ran into and how you fixed them
   - Specific user feedback, especially if the user told you to do something differently
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Security-relevant constraints stated by the user (sensitive files or data to avoid, operations that must not be performed, credential or secret handling rules) MUST be preserved verbatim in the summary so they continue to apply after compaction.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. Preserve any security-relevant instructions or constraints verbatim so they remain in effect after compaction.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Next Step: List the next step that you will take that is related to the most recent work you were doing, directly in line with the user's most recent explicit requests. Include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off.`;

const NO_TOOLS_TRAILER =
  "\n\nREMINDER: Do NOT call any tools. Respond with plain text only — "
  + "an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.";

export interface CompactOptions {
  /** 估算 token 阈值(超过即触发)。 */
  thresholdTokens: number;
  /** tail 保留近 N 条消息。 */
  keepRecentMessages: number;
  /** 压缩用的便宜模型。 */
  compactLlm: LlmProvider;
  /** DevLog 落盘目录。 */
  devlogDir: string;
  /** 摘要指示(/compact [instructions] 透传;拼进摘要 system)。 */
  instructions?: string;
  /** 强制执行(手动 /compact:低于阈值也压)。 */
  force?: boolean;
  /** 摘要前先做一次读侧 microcompact(head/tail/dedup/supersede),避免摘要模型只看到每条消息的前 2000 字。 */
  microcompact?: MicrocompactConfig;
  /** 触发来源(边界元数据):手动 /compact=manual,自动阈值钩子=auto(缺省)。 */
  trigger?: "manual" | "auto";
}

/** 消息 tokens 快估(autoCompact 的二次闸:microcompact 剪完是否还要摘要)。
 *  历史:原口径 `len/4`(opencode Token.estimate)对中文会话系统性低估约 2 倍(近 5 天 6,975 个
 *  采样点比对上游 usage.inputTokens:usage/est 中位 1.99);后来改用 microcompact 的 CJK 系数。
 *  2026-11 token 轮:token 口径统一见 agent/token-estimate.ts(真分词器 + 标定 ratio),
 *  本函数只做转调——microcompact / autoCompact / loop 三处判定从此只有一把尺子。 */
export function estimateTokens(messages: Message[]): number {
  return estimateMessagesTokens(messages);
}

/** compact.done 里 tail 单条 content 上限(可重建消息数组,别把 journal 撑爆)。 */
const TAIL_CONTENT_LIMIT = 8000;
/** 摘要模型看到的 head 单条 content 上限:必须容纳 microcompact 的头 4K+尾 1K,否则尾部错误又会被切掉。 */
const SUMMARY_MESSAGE_CHARS = 6000;

/** 可重建的 tail 消息(role/content 必有,toolCalls/toolCallId 按需;不带 audio/images)。 */
export interface CompactTailMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
  toolCallId?: string;
}

/** Message → tail 条目(压缩边界后重放用:去掉 images/audio,超长 content 截断)。 */
function toTailMessage(m: Message): CompactTailMessage | null {
  // system 在 deriveMessages 里不会出现(只有 user/assistant/tool 三种来源);防御性跳过。
  if (m.role !== "user" && m.role !== "assistant" && m.role !== "tool") return null;
  const raw = String(m.content ?? "");
  const content = raw.length > TAIL_CONTENT_LIMIT ? raw.slice(0, TAIL_CONTENT_LIMIT) + "…(截断)" : raw;
  if (m.role === "tool") return { role: "tool", content, toolCallId: m.toolCallId };
  if (m.role === "assistant") return { role: "assistant", content, ...(m.toolCalls?.length ? { toolCalls: m.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })) } : {}) };
  return { role: "user", content };
}

/**
 * surface 事件 = 真正的会话真相(deriveMessages 读的那批)。
 *  提交前重验:摘要期间这类事件任一新增,说明 head 已被抛在后面,不能用旧 head 提交边界。
 * compact.* / turn.* / step.* / task.* 等过程事件不算(它们不改变会话内容)。
 */
const SURFACE_EVENT_KINDS = new Set<string>(["message.user", "message.agent", "message.system", "tool.call", "tool.result"]);

/** 会话级压缩锁(压缩事务):同一会话同一时刻只允许一次摘要事务。
 *  进程内 Map——进程崩溃锁随进程消失,留下的悬空 compact.start 由入口 abandoned 检测收尾。 */
interface CompactLock {
  startedAt: number;
  /** compact.start 落账后的**本会话事件计数**水位(count,不是 seq);提交前用它判 surface 是否变过。 */
  generation: number;
}
const compactionLocks = new Map<string, CompactLock>();

/** 只读 helper(compact-gate/compact-hook/面板可用):该会话当前是否有压缩在跑,不参与判定。 */
export function compactionInFlight(sessionId: string): { startedAt: number; generation: number } | undefined {
  const lock = compactionLocks.get(sessionId);
  return lock ? { startedAt: lock.startedAt, generation: lock.generation } : undefined;
}

/**
 * 入口 abandoned 检测:本会话最后一条 compact.start 之后既无 compact.done 也无
 * compact.failed = 那次事务没走完(进程崩溃/被杀/异常逃逸)。
 * - 幂等键绑定 startSeq:同一条悬空 start 只落一条,重复调用不重复落;
 * - 本次压缩的 start 在本检测之后才写,不会把自己判成 abandoned;
 * - 本进程已有锁在跑(在途压缩)时不检测——那条 start 正在被处理,不是悬空。
 */
function detectAbandonedCompaction(journal: Journal, sessionId: string, trigger: "manual" | "auto"): void {
  try {
    if (compactionLocks.has(sessionId)) return;
    const events = journal.readSession(sessionId);
    let lastStart: JournalEvent | undefined;
    for (const e of events) if (e.kind === "compact.start") lastStart = e;
    if (!lastStart) return;
    const settled = events.some((e) => e.seq > lastStart!.seq && (e.kind === "compact.done" || e.kind === "compact.failed"));
    if (settled) return;
    const startedAt = Number((lastStart.payload as { startedAt?: number } | undefined)?.startedAt ?? lastStart.time);
    journal.append({
      kind: "compact.abandoned",
      sessionId,
      idempotencyKey: `compact-abandoned:${sessionId}:${lastStart.seq}`,
      payload: { startSeq: lastStart.seq, startedAt, ageMs: Math.max(0, Date.now() - startedAt), trigger },
    });
  } catch {
    // 检测本身出错不改压缩行为(与压缩无耦合的纯观测)。
  }
}

/** 压缩一段会话,写 DevLog,返回摘要。 */
export async function autoCompact(
  journal: Journal,
  sessionId: string,
  opts: CompactOptions): Promise<{ compacted: boolean; devlogPath?: string; summary?: string; reason?: string }> {
 //  abandoned 检测放在最入口:即使本次因阈值/守卫被跳过,也能收尾上一次没走完的事务
  // (进程崩溃/被杀/异常逃逸留下的悬空 compact.start)。本进程有锁在跑时不检测(在途不是悬空);
  // 本次 compact.start 在本检测之后才写,不会把自己判成 abandoned。
  detectAbandonedCompaction(journal, sessionId, opts.trigger ?? "auto");
  const rawMessages = deriveMessages(journal, sessionId);
  const tokensBefore = estimateTokens(rawMessages);
  // 先剪后摘:去掉旧工具结果的中段/重复项,摘要模型才能看到真正的尾部错误与关键锚点。
  // 若 microcompact 已把上下文降到阈值以下,这一步就不再摘要(比「到了阈值却先摘要」更省)。
  const prePruned = microcompactMessages(rawMessages, opts.microcompact);
  const messages = prePruned.messages;
  const tokens = estimateTokens(messages);
  const trigger = opts.trigger ?? "auto";
  if (tokens < opts.thresholdTokens && !opts.force) {
    return {
      compacted: false,
      reason: prePruned.compacted > 0 ? "微压缩后低于阈值" : "低于阈值且未强制",
    };
  }
 // 强压守卫(压缩死亡螺旋根治):自动路径的 force(gate hardOver)在「对话史估算
  // 已低于阈值」时必须放弃——used 超阈但对话史很小,说明超出部分在不可压缩基线(system/注入块
  // /摘要台账)或共享 journal 的子代理用量里,压缩只能把已经缩小的对话史再压一遍(摘要套摘要、
 // 原始用户消息丢失)。注意:web-1793696471953 连环 60 次强压,每次仅 12 条消息、est 6~17K,
  // 原始提问全部丢失。手动 /compact(trigger=manual)不受此限。
 // 骑线修复:守卫目标是「对话史相对阈值极小(基线在阈上)」的螺旋形态(注意 6~17K vs 300K=2~6%)。
  // 但闸门按真实 input 测(含系统/工具面 ~12K),消息估算常停在阈值线下的 90%+ —— 两把尺骑线打架:
 // 闸门每步喊压、这里每步拒,面板连续渲染「无需压缩」分隔线(web-1793790405127 注意 15 连)。
  // 阈值附近的对话史(≥ FORCE_EST_MIN_RATIO)是真实可压体量,照压(压一次即回落到小体积,空转自然停)。
  const FORCE_EST_MIN_RATIO = 0.5; // 死螺旋案例 est 仅为阈值的 2~6%,0.5 安全分界
  if (opts.force && trigger === "auto" && tokens < opts.thresholdTokens * FORCE_EST_MIN_RATIO) {
    const reason = `强压守卫:对话史估算 ${tokens} tok 已低于阈值 ${opts.thresholdTokens}(used 超阈部分为不可压缩基线或子代理用量,压缩无意义)`
      + (opts.thresholdTokens <= 32_000 ? ";阈值异常偏小——检查模型 contextWindow 声明与 compactThresholdTokens 配置" : "");
    journal.append({ kind: "compact.skipped", sessionId, payload: { reason, trigger, guard: "force-vs-est", tokens, thresholdTokens: opts.thresholdTokens } });
    return { compacted: false, reason: "强压守卫:对话史估算低于阈值,强压无意义" };
  }

  // tail 保留(先算 head:消息数 ≤ keepRecentMessages 时没有可压缩部分)
  const tail = messages.slice(-opts.keepRecentMessages);
  const head = messages.slice(0, Math.max(0, messages.length - opts.keepRecentMessages));

 // 修「主动 /compact 感觉没运行」:head 为空=只把 system 提示喂给模型 → 摘要空串 →
  // 仍写 compact.done(summary="")被 loop.ts 的边界判定(summary 非空才截断)忽略 → 上下文一条没减,
  // 前端却报「已压缩(摘要 0 字)」。这里直接诚实返回,且**不写 compact.start/不落 devlog**(不留假压缩痕迹)。
  if (head.length === 0) {
    const reason = `会话过短(消息 ${messages.length} 条 ≤ 保留 ${opts.keepRecentMessages} 条),无可压缩部分`;
    // 落事件(边界元数据):前端/看板靠它区分「跳过」与「失败/正常」,否则这次尝试在事件流里是空的。
    journal.append({ kind: "compact.skipped", sessionId, payload: { reason, trigger } });
    return { compacted: false, reason };
  }

 //  压缩事务:会话级锁——在既有守卫(阈值/强压/空 head)之后、写 compact.start 之前获取。
  // 同一会话同一时刻只允许一次摘要事务:auto 钩子与手动 /compact 并发时,后来者直接跳过且**不调摘要模型**。
  const heldLock = compactionLocks.get(sessionId);
  if (heldLock) {
    journal.append({
      kind: "compact.skipped",
      sessionId,
      payload: { reason: "compaction-in-progress", trigger, since: heldLock.startedAt, generation: heldLock.generation },
    });
    return { compacted: false, reason: "压缩进行中(compaction-in-progress):跳过本次,不调摘要模型" };
  }
  const lock: CompactLock = { startedAt: Date.now(), generation: 0 };
  compactionLocks.set(sessionId, lock);

  try {
    // 台账扫「剪枝前的全量消息」:head/tail 剪掉的中段、tail 的 8000 字截断都可能藏
    // path:line/错误/测试锚点;从剪枝后内容抽会漏掉这些——台账必须覆盖原始事实源。
    const facts = buildFactsLedger(rawMessages);
 /** head 的 token 估算(缩小校验的被减数):与 loop/microcompact 同一把尺子。 */
    const headTokens = estimateTokens(head);
 /** 压缩模型名 t0 快照:provider.modelName 是 getter(热切换后读出新值),
     *  必须在 compactLlm.chat() 之前固定,否则记的是「切换后的模型」而非本次压缩实际用的模型。 */
    const compactVendor = opts.compactLlm as { model?: string; modelName?: string };
    const compactModelName = compactVendor.modelName ?? compactVendor.model;
    const modelAtStart = typeof compactModelName === "string" && compactModelName ? compactModelName : undefined;
    journal.append({
      kind: "compact.start",
      sessionId,
      payload: {
        tokens: tokensBefore,
 // 观测性:每次压缩自证判定阈值——死亡螺旋复盘时不再需要反推
        // (web-1793696471953 的 60 次连环强压当时无从知道阈值是多少)。
        threshold: opts.thresholdTokens,
        tokensAfterMicrocompact: tokens,
        messages: messages.length,
        trigger,
        startedAt: lock.startedAt,
        ...(modelAtStart ? { model: modelAtStart } : {}),
        ...(prePruned.compacted > 0 ? { microcompacted: prePruned.compacted } : {}),
        ...(opts.instructions ? { instructions: opts.instructions.slice(0, 200) } : {}),
      },
    });
 //  generation 水位 = compact.start 落账后**本会话事件计数**(修复)。
    // 不能用 seq:session-worker 的 ProxyJournal 本地 append 的 seq=replica.length(≈3.6k),
    // 而种子/网关推送事件保留全局 seq(≈67 万),混用 seq 时 readSession(seq+1) 会把整段
 // 历史都算成「新增」→ 每次 surface-changed,压缩永不成功(注意 5d7461f1 toGeneration=674500)。
    lock.generation = journal.readSession(sessionId).length;

    // 压缩 agent 摘要 head(ZCode compact/prompt.ts 提示词逐字:禁工具前导 + 九段式主体 + 禁工具尾注;
    // 自定义指示以 Additional Instructions 块追加在主体之后,与 ZCode buildCompactPrompt 一致)
    const summarySystem = NO_TOOLS_PREAMBLE
      + BASE_COMPACT_PROMPT
      + NO_TOOLS_TRAILER
      + (opts.instructions ? `\n\nAdditional Instructions:\n${opts.instructions}` : "")
      + (facts.text ? `\n\n关键事实台账(必须原样保留其中的路径/错误码/测试名/数字,不要改写):\n${facts.text}` : "");
    const summaryRes = await opts.compactLlm.chat(
      [
        { role: "system", content: summarySystem },
        ...head.map((m) => ({ role: "user" as const, content: `[${m.role}] ${String(m.content ?? "").slice(0, SUMMARY_MESSAGE_CHARS)}` })),
      ],
      [],
    );
    const summary = String(summaryRes.content ?? "");

    // 摘要空串=模型没产出(空 head 已在上游拦掉;这里是端点抽风/拒答)。**不写 compact.done**:
    // 边界判定要求 summary 非空,写一条空摘要边界只会污染边界语义(且前端会念「摘要 0 字」)。
    // compact.start 保留——它是过程事件,不是边界;失败另落 compact.failed(前端要能看见「压了但没成」)。
    if (summary.trim() === "") {
      const reason = "摘要模型返回空内容(未压缩,历史保持不变)";
      journal.append({ kind: "compact.failed", sessionId, payload: { reason, trigger } });
      return { compacted: false, reason };
    }

 // ──  提交前重验 ①:surface generation ──────────────────────────────────────
    // 摘要 LLM 调用期间可能新到达消息/工具结果——那份摘要基于的 head 已经落后于 journal。
    // 用旧 head 提交边界会把新到达的内容一并抹掉,故重读 compact.start 之后**新增的事件**:
    // 出现任一 surface 事件(user/agent/system/tool.call/tool.result)→ 放弃提交,历史不变。
    // 只尝试一次,不自动重试(避免连环压缩)。
 // 水位口径(修复):按**本会话事件计数**切片,不按 seq 过滤——session-worker 下
    // ProxyJournal 本地 append 的 seq=replica.length、推送事件是全局 seq,两者不可比。
    const now = journal.readSession(sessionId);
    const added = now.length > lock.generation ? now.slice(lock.generation) : [];
    const surfaced = added.filter((e) => SURFACE_EVENT_KINDS.has(e.kind));
    if (surfaced.length > 0) {
      const reason = `surface-changed:摘要期间会话新增 ${added.length} 条事件(其中消息事件 ${surfaced.length} 条),本次摘要已过期(未压缩,历史保持不变)`;
      journal.append({
        kind: "compact.failed",
        sessionId,
        payload: {
          reason: "surface-changed",
          message: reason,
          trigger,
          // 字段名沿用(前端兼容),语义是**本会话事件计数**不是 seq。
          fromGeneration: lock.generation,
          toGeneration: now.length,
          // 只用于说明,不参与判定(seq 仅原样回显,不做比较)。
          changedEvents: added.slice(0, 20).map((e) => ({ seq: e.seq, kind: e.kind })),
        },
      });
      return { compacted: false, reason };
    }

 // ──  提交前重验 ②:摘要必须严格小于被遮蔽范围 ──────────────────────────────
    // 摘要比分母还大 = 压缩后上下文反而变长,却把原文丢了。facts 是附加台账(另算),不参与比较。
    // 口径:token-estimate 的同一把尺子(head 走消息估算,summary 走字符近似,CJK 感知)。
    const summaryTokens = approxTokensOfChars(summary.length);
    if (summaryTokens >= headTokens) {
      const reason = `摘要不比原文小(${summaryTokens} tok ≥ head ${headTokens} tok,未压缩,历史保持不变)`;
      journal.append({
        kind: "compact.failed",
        sessionId,
        payload: { reason: "summary-not-smaller", message: reason, trigger, summaryTokens, headTokens },
      });
      return { compacted: false, reason };
    }

    // compact boundary 落 journal(带 tail:边界后由 deriveMessages 重放,防压缩后模型失忆)
    journal.append({
      kind: "compact.done",
      sessionId,
      payload: {
        summary,
        ...(modelAtStart ? { model: modelAtStart } : {}),
        tokensBefore,
        tokensAfterMicrocompact: tokens,
        headCount: head.length,
        tailKept: tail.length,
        // 边界元数据(前端/看板定位「这次压缩是谁触发、压了多少、边界 id 是什么」):
        // summaryChars 与 result 回包同口径(=summary.length),tokensAfter 不重复造——
        // 消费方(trace-stats.ts compact.done 分支)按 summary+facts+tail 字符数 /4 自估,这里不另立口径。
        trigger,
        summaryChars: summary.length,
 //  事务观测:缩小校验的两个口径值(复盘时不必再反推)
        headTokens,
        summaryTokens,
        // 压缩指示随边界一起落(panel 的「压缩指示」chip 读 compact.done payload;
        // start 事件不进聊天流,只留 start 会让 chip 永不显示)
        ...(opts.instructions ? { instructions: opts.instructions.slice(0, 200) } : {}),
        boundaryId: `cb-${sessionId}-${Date.now()}`,
        // 被压缩 head 对应的 journal seq:Message 是 derive 产物(无 seq,且一条事件可派生多条消息
        // /多事件合成一条),无法可靠反查——如实留空数组,由消费方按 headCount 自行处理。
        summaryMessageIds: [] as number[],
        tail: tail.map(toTailMessage).filter((m): m is CompactTailMessage => m !== null),
        ...(facts.text ? { facts: facts.text } : {}),
        ...(prePruned.compacted > 0 ? {
          microcompact: {
            compacted: prePruned.compacted,
            savedTokens: prePruned.savedTokens ?? 0,
            reason: prePruned.reason,
            manifest: prePruned.manifest,
          },
        } : {}),
      },
    });

    // reminder 重注入(ZCode 纪律:防压缩丢任务状态)
    const extras = [
      facts.text ? `[关键事实台账]\n${facts.text}` : "",
      prePruned.manifest ?? "",
    ].filter(Boolean).join("\n\n");
    journal.append({
      kind: "message.system",
      sessionId,
      payload: {
        text: `[上下文已压缩] 前文摘要:${summary}\n(最近 ${tail.length} 条原文保留)${extras ? `\n\n${extras}` : ""}`,
      },
    });

    // DevLog 双格式落盘
    mkdirSync(opts.devlogDir, { recursive: true });
    const slug = `devlog-${sessionId}-${Date.now()}`;
    const jsonPath = join(opts.devlogDir, `${slug}.json`);
    const mdPath = join(opts.devlogDir, `${slug}.md`);
    writeFileSync(jsonPath, JSON.stringify({
      sessionId, compactedAt: Date.now(), summary,
      tokensBefore, tokensAfterMicrocompact: tokens,
      headMessages: head.length, tailKept: tail.length,
      ...(facts.text ? { facts: facts.text } : {}),
      ...(prePruned.compacted > 0 ? {
        microcompact: {
          compacted: prePruned.compacted,
          savedTokens: prePruned.savedTokens ?? 0,
          reason: prePruned.reason,
          manifest: prePruned.manifest,
        },
      } : {}),
    }, null, 2));
    writeFileSync(mdPath, `# DevLog ${sessionId}\n\n- 压缩时间: ${new Date().toISOString()}\n- token 前: ${tokensBefore}\n- 微压缩后 token: ${tokens}\n- 压缩消息: ${head.length} 条(保留尾部 ${tail.length})\n\n## 摘要\n\n${summary}\n${facts.text ? `\n## 关键事实台账\n\n${facts.text}\n` : ""}`);

    return { compacted: true, devlogPath: mdPath, summary };
  } finally {
 //  出口唯一释放点:成功/空摘要/surface-changed/not-smaller/摘要模型抛异常,
    // 全部经 finally 解锁——否则一次失败会让该会话永久卡在「进行中」,后续压缩全被 skipped 吞掉。
    compactionLocks.delete(sessionId);
  }
}
