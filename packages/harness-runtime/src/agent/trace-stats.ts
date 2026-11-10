/**
 * agent loop 追踪统计投影(step-031,deepseek-harness session-stats 的诚实子集):
 * 从 journal 事件派生 turns/steps/llmMs/toolMs/token 聚合。
 * 诚实边界:TTFT/解码吞吐仅流式链路(事件带 ttftMs+usage)有值,缺 0(不推断);
 * 旧事件无 llmMs/usage 字段时按 0 计(不推断)。
 */
import type { Journal } from "@lampgenie/core";

/** 单个子代理的 token 消耗(2026-10-22 用户口径:子代理单独一窗,不并入主会话 tokens)。 */
export interface TraceSubagentTokens {
  agentId: string;
  taskId?: string;
  title?: string;
  /** 该 agent 首次活动时记录的模型名(2026-11-03;内层 message.agent 的 payload.model 首值,
   *  后续不覆盖——子代理中途换模型只认开局那个,避免把一个 agent 的花销算到两个模型上)。
   *  缺省=内层事件无 model(老 journal / provider 不暴露)。 */
  model?: string;
  /** 该 agent 的 LLM 调用次数(subagent.event 内层 message.agent 计一次)。 */
  calls: number;
  input: number;
  output: number;
  total: number;
  cached: number;
  /** 缓存写入量(成本第三段,2026-10-28;仅 Anthropic 原生口径下发)。 */
  cacheWrite?: number;
  llmMs: number;
  /** 最近一次活动时间(spawn 或 event 的 e.time;前端「最近 3 条」排序用,缺 0)。 */
  lastAt?: number;
}

export interface TraceStats {
  turns: number;
  steps: number;
  llmCalls: number;
  /** LLM 调用失败数(txa5,2026-11 轨迹补齐):只统计落 journal 的 `llm.trace` 且 payload 带非空
   *  `error` 的事件(成功路径的 llm.trace 不带 error,不计)。口径与 llmCalls 独立——
   *  llmCalls 仍是 message.agent 计数(失败调用不落 message.agent)。
   *  意义:旧口径下「8 路 fetch failed」在统计里完全不可见(0 调用/0 耗时),看着像没有花销。 */
  llmFailures: number;
  /** 失败调用累计耗时(ms,llm.trace.payload.ms 之和;缺省按 0)。 */
  failedLlmMs: number;
  /** LLM 调用总耗时(ms)。 */
  llmMs: number;
  /** 单次 LLM 调用最大耗时(ms)。 */
  llmMsMax: number;
  toolCalls: number;
  toolMs: number;
  tokens: { input: number; output: number; total: number; cached: number; cacheWrite?: number };
  /** 当前上下文占用(step-048 容量看板;2026-11 口径定为「API 实测为主」)。
   *  **有 API 值就取 API 返回的 usage.inputTokens**——展示主数字只认 API 值;本地估算
   *  (`estimatedInputTokens`)只用于内部触发/标定,进 `contextTokensEst` 作旁注,**不得**顶替本字段。
   *  `usageSuspect` 只是旁注徽标:即便样本「不可能」(如 cached > 上一步 input)也按 API 原值展示,
   *  **不改写**本字段。唯一无 API 值的情形是 compact.done 后的压缩估算(见 contextEstimated)。 */
  contextTokens: number;
  /** 与 `contextTokens` 同值(向后兼容保留:旧消费方仍按此字段名读,语义已统一为 API 上报值)。 */
  contextTokensReported: number;
  /** 该次调用的本地估算输入 token(原 `llm.trace.estimatedInputTokens` 经 `turn:step` 关联到
   *  estByCall 的值):仅作旁注/对照(如 delta = 实测 - 估算),**不是**展示主数字。
   *  无本地估算(旧 journal / provider 不暴露)时不出现该键。 */
  contextTokensEst?: number;
  /** contextTokens 的口径(2026-10-30 修「/compact 后看板不更新」;2026-11 口径收敛)。
   *  false   = 最近一次 LLM 调用的 **API 实测** usage.inputTokens(有 API 值即一律 false,含 suspect 样本);
   *  true    = 估算值,**只**用于 compact.done 后的「摘要+关键事实+tail」估算(那时确实拿不到 API 值)。
   *  UI 据 true 加「≈」前缀,不把估算当实测展示。 */
  contextEstimated?: boolean;
  /** 任一 `llm.trace` 事件带 `usageSuspect` 即为 true(step-1027):上报 usage 与请求规模对不上,
   *  面板据此把上报值降为副标/加告警,容量口径改由本地估算驱动。 */
  usageSuspect?: boolean;
  /** 最近一条 `usageAnomaly` 文本(step-1027;如 "usage 输入 111976 远超估算 4200")。 */
  usageAnomaly?: string;
  /** 归一分层汇总(step-1027):仅当至少一条 `llm.trace` 事件带 `estimatedInputTokens` 时出现
   *  (旧 journal 不出现该键——不造数、不给旧断言添恒 0 字段)。
   *  按 `llm.trace` 事件累加:est* 取本地估算,rep* 取同事件 `payload.usage` 的上报值(缺值按 0),
   *  calls=入账事件数,suspectCalls=其中带 usageSuspect 的事件数。失败调用也计入(失败也有请求规模)。 */
  usageNormalized?: {
    calls: number;
    estInput: number;
    estCached: number;
    repInput: number;
    repCached: number;
    suspectCalls: number;
  };
  /** 首 token 延迟(step-031 流式收口):流式链路均值;非流式=0。 */
  ttftMs: number;
  ttftMsMax: number;
  /** 解码吞吐(tokens/s):流式链路 outputTokens/((llmMs-ttftMs)/1000) 均值;缺 0。 */
  decodeTps: number;
  /** 按模型归集的用量(2026-10-28 成本核算;主会话 + 子代理合并,成本=Σ用量×该模型单价)。 */
  byModel: { model: string; calls: number; input: number; output: number; total: number; cached: number; cacheWrite: number }[];
  /** 子代理消耗(2026-10-22):按 agentId 独立聚合,不并入上方主会话 tokens。 */
  subagents: {
    /** 派发数(spawn 事件;含无 usage 的后端)。 */
    spawned: number;
    agents: TraceSubagentTokens[];
    totals: { calls: number; input: number; output: number; total: number; cached: number; llmMs: number };
  };
}

/** 单次调用的稳定键(step-1027):`turn:step`。缺任一维(旧 journal / 外部后端不写)时返回 undefined,
 *  调用方据此退化到旧口径,不做任何猜测性关联。 */
function callKeyOf(p: Record<string, unknown>): string | undefined {
  return typeof p.turn === "number" && typeof p.step === "number" ? `${p.turn}:${p.step}` : undefined;
}

export function deriveTraceStats(events: { kind: string; payload: unknown; time?: number }[]): TraceStats {
  const out: TraceStats = {
    turns: 0, steps: 0, llmCalls: 0, llmFailures: 0, failedLlmMs: 0, llmMs: 0, llmMsMax: 0,
    toolCalls: 0, toolMs: 0, tokens: { input: 0, output: 0, total: 0, cached: 0 },
    contextTokens: 0, contextTokensReported: 0,
    ttftMs: 0, ttftMsMax: 0, decodeTps: 0,
    byModel: [],
    subagents: { spawned: 0, agents: [], totals: { calls: 0, input: 0, output: 0, total: 0, cached: 0, llmMs: 0 } },
  };
  // 预扫描(step-1027 统计归一层):`turn:step` → 该次调用的本地估算输入 token。
  // 不靠事件先后猜——message.agent 与 llm.trace 的落盘顺序不保证(失败调用根本只有 llm.trace),
  // 故先扫一遍把估算索引起来,主循环按 turn:step 命中即用。compact.done **不参与**(它估的是压缩后
  // 规模,不是某次调用的请求规模)。
  const estByCall = new Map<string, number>();
  for (const e of events) {
    if (e.kind !== "llm.trace") continue;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const est = typeof p.estimatedInputTokens === "number" ? p.estimatedInputTokens : undefined;
    if (est === undefined) continue;
    const key = callKeyOf(p);
    if (key) estByCall.set(key, est);
  }
  // 归一分层汇总(step-1027):lazy 分配,只有真的见过估算字段才挂到 out 上。
  let usageNorm: NonNullable<TraceStats["usageNormalized"]> | undefined;
  let hasEstimate = false;
  let ttftCount = 0;
  let tpsSum = 0;
  let tpsCount = 0;
  // 子代理按 agentId 归集(2026-10-22):spawn 提供 title/taskId,event 提供 usage;
  // 同一 agentId 的 message.agent 逐次累加(与主会话 tokens 同口径:每次调用求和)。
  // 按模型归集(2026-10-28 成本核算):主会话 + 子代理共用同一张表——钱是一起花的。
  const modelTokens = new Map<string, { model: string; calls: number; input: number; output: number; total: number; cached: number; cacheWrite: number }>();
  const subAgents = new Map<string, TraceSubagentTokens>();
  const subOf = (agentId: string): TraceSubagentTokens => {
    let a = subAgents.get(agentId);
    if (!a) {
      a = { agentId, calls: 0, input: 0, output: 0, total: 0, cached: 0, llmMs: 0 };
      subAgents.set(agentId, a);
    }
    return a;
  };
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    switch (e.kind) {
      case "turn.start":
        out.turns += 1;
        break;
      case "step.end":
        out.steps += 1;
        break;
      case "message.agent":
        out.llmCalls += 1;
        const llmMs = typeof p.llmMs === "number" ? p.llmMs : 0;
        out.llmMs += llmMs;
        out.llmMsMax = Math.max(out.llmMsMax, llmMs);
        const ttft = typeof p.ttftMs === "number" ? p.ttftMs : undefined;
        if (ttft !== undefined) {
          out.ttftMs += ttft;
          out.ttftMsMax = Math.max(out.ttftMsMax, ttft);
          ttftCount += 1;
        }
        const u = p.usage as { inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedTokens?: number; cacheCreationTokens?: number } | undefined;
        if (u) {
          out.tokens.input += u.inputTokens ?? 0;
          out.tokens.output += u.outputTokens ?? 0;
          out.tokens.total += u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
          out.tokens.cached += u.cachedTokens ?? 0; // 提示缓存命中(step-048:命中率=cached/input,前端算)
          // 缓存写入(成本核算第三段,2026-10-28):只在有值时出现,避免给旧客户端/旧断言添一个恒 0 字段。
          if (u.cacheCreationTokens) out.tokens.cacheWrite = (out.tokens.cacheWrite ?? 0) + u.cacheCreationTokens;
          if (u.inputTokens) {
            // 口径(2026-11 用户硬要求「命中率/消耗一律以 LLM API 返回值为准」):展示主数字 = API 上报的
            // usage.inputTokens,如实给出。即使 usageSuspect(cached > 上一步 input 这类「不可能」样本)
            // 也**不改写**:suspect 只是旁注徽标(usageSuspect/usageAnomaly),数字仍是 API 原值。
            out.contextTokens = u.inputTokens;
            out.contextTokensReported = u.inputTokens; // 同值,向后兼容旧字段名消费方
            // 本地估算另行旁注(原「优先估算」口径已废):只作对照,不顶替实测。
            const key = callKeyOf(p);
            const est = key !== undefined ? estByCall.get(key) : undefined;
            if (est !== undefined) out.contextTokensEst = est;
            else delete out.contextTokensEst; // 本次无估算:不留上一次的陈旧旁注
            // 实测回到主位:压缩当下用估算,下一条消息立刻回到实测口径
            // (2026-10-30 修「/compact 后看板不更新」的配套)。
            out.contextEstimated = false;
          }
          // 按模型归集(2026-10-28 成本核算):成本=用量×该模型单价,必须按模型分段而不是混一锅。
          const model = typeof p.model === "string" && p.model ? p.model : "";
          const mk = model || "?";
          const mAcc = modelTokens.get(mk) ?? { model: model || "?", calls: 0, input: 0, output: 0, total: 0, cached: 0, cacheWrite: 0 };
          mAcc.calls += 1;
          mAcc.input += u.inputTokens ?? 0;
          mAcc.output += u.outputTokens ?? 0;
          mAcc.total += u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
          mAcc.cached += u.cachedTokens ?? 0;
          mAcc.cacheWrite += u.cacheCreationTokens ?? 0;
          modelTokens.set(mk, mAcc);
          // 解码吞吐:仅流式(ttft 在场且解码窗口>0)才计,不推断。
          if (ttft !== undefined && llmMs > ttft && (u.outputTokens ?? 0) > 0) {
            tpsSum += (u.outputTokens ?? 0) / ((llmMs - ttft) / 1000);
            tpsCount += 1;
          }
        }
        break;
      case "tool.result":
        out.toolCalls += 1;
        out.toolMs += typeof p.durationMs === "number" ? p.durationMs : 0;
        break;
      // LLM 失败(txa5):loop 在 chat 抛错时落一条带 error 的 llm.trace(成功路径不带 error)。
      // 只认非空 error——否则成功轨迹也会被算成失败;耗时取 payload.ms(缺省 0,不推断)。
      // 不动 llmCalls/llmMs 口径(那两个仍只由 message.agent 计入)。
      case "llm.trace": {
        // 统计归一层(step-1027):估算/异常字段必须在失败 break **之前**处理——失败调用也有请求规模
        // (「8 路 fetch failed」往往正是最贵那次),且成功/失败都要计入 usageNormalized。
        {
          const est = typeof p.estimatedInputTokens === "number" ? p.estimatedInputTokens : undefined;
          const estCached = typeof p.estimatedCachedTokens === "number" ? p.estimatedCachedTokens : undefined;
          const tu = p.usage as { inputTokens?: number; cachedTokens?: number } | undefined;
          const suspect = p.usageSuspect === true;
          if (est !== undefined) {
            hasEstimate = true;
            // 旁注口径:本地估算只记录在 contextTokensEst,不参与 contextTokens(那是 API 实测值)。
            // 无 usage 的调用(失败/旧后端)也能在此留下请求规模,但**不**因此把 contextTokens 变成估算。
            out.contextTokensEst = est;
          }
          const acc = (usageNorm ??= { calls: 0, estInput: 0, estCached: 0, repInput: 0, repCached: 0, suspectCalls: 0 });
          acc.calls += 1;
          acc.estInput += est ?? 0;
          acc.estCached += estCached ?? 0;
          acc.repInput += tu?.inputTokens ?? 0; // 上报值与估算值分开求和:面板直接看两套delta
          acc.repCached += tu?.cachedTokens ?? 0;
          if (suspect) {
            acc.suspectCalls += 1;
            out.usageSuspect = true;
          }
          const anomaly = typeof p.usageAnomaly === "string" ? p.usageAnomaly.trim() : "";
          if (anomaly) out.usageAnomaly = anomaly; // 最近一条(迭代序即落盘序)
        }
        const errText = typeof p.error === "string" ? p.error.trim() : "";
        if (errText === "") break;
        out.llmFailures += 1;
        out.failedLlmMs += typeof p.ms === "number" ? p.ms : 0;
        // 失败调用也按模型入账(2026-11-03):旧口径下「某模型连续 fetch failed」在 byModel 里
        // 完全不可见(0 调用),成本核算看着像没花销。这里只把 calls +1(token 各值保持 0:失败
        // 没拿到 usage),且**不**把 payload.ms 计入任何 token/ms 字段——失败耗时不该污染平均延迟。
        // 无 model 时**不建桶**(刻意不复用 message.agent 的 "?" 兜底):失败事件缺模型多半是
        // provider 不暴露,建 "?" 占位桶会把不同端点/模型的失败糊成一桶,是脏数据。
        {
          const fm = typeof p.model === "string" && p.model ? p.model : "";
          if (fm) {
            const facc = modelTokens.get(fm)
              ?? { model: fm, calls: 0, input: 0, output: 0, total: 0, cached: 0, cacheWrite: 0 };
            facc.calls += 1;
            modelTokens.set(fm, facc);
          }
        }
        break;
      }
      // 压缩边界:重算「当前上下文占用」(2026-10-30 修「/compact 后看板不更新」)。
      //
      // 病灶:contextTokens 的唯一赋值点在 `case "message.agent"`(下一段的 `u.inputTokens`),
      // 而 `/compact` 只写 `compact.done`、**不产生 message.agent** → 压缩完再派生,trace.stats
      // 拿到的还是压缩前那次调用的输入规模。用户点完 /compact,看板的「上下文占用 %」纹丝不动,
      // 必须等发下一条消息才变——这正是实报现象。
      //
      // 口径(按 payload 实测字段估算,不是猜):
      //   auto-compact 落账时带 summary / facts / tail(见 auto-compact.ts 的 compact.done payload),
      //   压缩后的历史 = 摘要 + 关键事实台账 + tail 原文(见 deriveMessages 的 compact.done 分支:
      //   清空历史 → 重放 tail → 重注入摘要)。所以按这几块的字符数 /4 折算成 token 是最贴近真实
      //   发送规模的估算。
      // **已知偏低**:system prompt / 工具面 / 技能索引不在 payload 里,估算不含它们,故真实规模会
      //   比这个数大。为不把估算当实测展示,写 contextEstimated:true,UI 加「≈」前缀。这是**唯一**
      //   允许估算顶替 contextTokens 的场景(压缩当下确实拿不到 API 值);下一次真实 LLM 调用立刻用
      //   API 上报值覆盖并把标记置回 false(见 message.agent 分支)。
      // 累计量(tokens.input/cached/llmCalls)**不动**:那是全历史求和,压缩不该削减已花掉的钱。
      case "compact.done": {
        // 无摘要或空白摘要不算真压缩(auto-compact 摘要为空时不写本事件;旧 journal 里有
        // 无摘要的占位事件)——不据它改任何数,与 deriveMessages 的边界判定同口径。
        const summary = typeof p.summary === "string" ? p.summary : "";
        if (summary.trim() === "") break;
        const facts = typeof p.facts === "string" ? p.facts : "";
        const tail = Array.isArray(p.tail)
          ? (p.tail as { content?: unknown }[]).reduce((a, m) => a + String(m?.content ?? "").length, 0)
          : 0;
        const estChars = summary.length + facts.length + tail;
        const estTokens = Math.ceil(estChars / 4);
        // 只在估算确实更小的时候覆盖:压缩理论上总是减小规模;若估算反而更大(极端长摘要),
        // 保留原实测值更诚实,不要凭空把占用调大。
        if (estTokens > 0 && (out.contextTokens === 0 || estTokens < out.contextTokens)) {
          out.contextTokens = estTokens;
          out.contextEstimated = true;
        }
        break;
      }
      // ---- 子代理消耗(2026-10-22)----
      case "subagent.spawn": {
        out.subagents.spawned += 1;
        const aid = typeof p.agentId === "string" ? p.agentId : "";
        if (aid) {
          const a = subOf(aid);
          if (typeof p.taskId === "string") a.taskId = p.taskId;
          if (typeof p.title === "string") a.title = p.title;
          if (typeof e.time === "number") a.lastAt = Math.max(a.lastAt ?? 0, e.time); // 派发即最近活动(无 event 的后端靠它参与排序)
        }
        break;
      }
      case "subagent.event": {
        // 内层 kind 才是子 loop 的真实事件(message.agent/tool.*);裁剪后 usage 仍在(llm-loop-backend:trimSubLoopEvent)。
        const innerKind = typeof p.kind === "string" ? p.kind : "";
        if (innerKind !== "message.agent") break;
        const aid = typeof p.agentId === "string" ? p.agentId : "(unknown)";
        const a = subOf(aid);
        // 首次出现的模型名才写入(2026-11-03):子代理中途换模型不改写,历史归因保持稳定。
        if (!a.model && typeof p.model === "string" && p.model) a.model = p.model;
        if (!a.taskId && typeof p.taskId === "string") a.taskId = p.taskId;
        if (typeof e.time === "number") a.lastAt = Math.max(a.lastAt ?? 0, e.time); // 每次内层活动刷新(取最大,兼容乱序批)
        else if (typeof a.lastAt !== "number") a.lastAt = 0;
        a.calls += 1;
        a.llmMs += typeof p.llmMs === "number" ? p.llmMs : 0;
        const su = p.usage as { inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedTokens?: number; cacheCreationTokens?: number } | undefined;
        if (su) {
          a.input += su.inputTokens ?? 0;
          a.output += su.outputTokens ?? 0;
          a.total += su.totalTokens ?? (su.inputTokens ?? 0) + (su.outputTokens ?? 0);
          a.cached += su.cachedTokens ?? 0;
          a.cacheWrite = (a.cacheWrite ?? 0) + (su.cacheCreationTokens ?? 0);
          // 成本核算:子代理的用量按它自己的模型入账(子 loop 与主轨可用不同模型)。
          const model = typeof p.model === "string" && p.model ? p.model : "";
          const mk = model || "?";
          const mAcc = modelTokens.get(mk) ?? { model: model || "?", calls: 0, input: 0, output: 0, total: 0, cached: 0, cacheWrite: 0 };
          mAcc.calls += 1;
          mAcc.input += su.inputTokens ?? 0;
          mAcc.output += su.outputTokens ?? 0;
          mAcc.total += su.totalTokens ?? (su.inputTokens ?? 0) + (su.outputTokens ?? 0);
          mAcc.cached += su.cachedTokens ?? 0;
          mAcc.cacheWrite += su.cacheCreationTokens ?? 0;
          modelTokens.set(mk, mAcc);
        }
        break;
      }
    }
  }
  if (ttftCount > 0) out.ttftMs = Math.round(out.ttftMs / ttftCount);
  if (tpsCount > 0) out.decodeTps = Math.round(tpsSum / tpsCount);
  if (usageNorm && hasEstimate) out.usageNormalized = usageNorm;
  if (subAgents.size > 0) {
    const agents = [...subAgents.values()].sort((x, y) => (y.total - x.total) || (y.output - x.output));
    out.subagents.agents = agents;
    for (const a of agents) {
      out.subagents.totals.calls += a.calls;
      out.subagents.totals.input += a.input;
      out.subagents.totals.output += a.output;
      out.subagents.totals.total += a.total;
      out.subagents.totals.cached += a.cached;
      out.subagents.totals.llmMs += a.llmMs;
    }
  }
  if (modelTokens.size > 0) {
    out.byModel = [...modelTokens.values()].sort((x, y) => (y.total - x.total) || (y.output - x.output));
  }
  return out;
}

/** 便捷入口:按 sessionId 过滤后派生。 */
export function traceStatsOf(journal: Journal, sessionId: string): TraceStats {
  return deriveTraceStats(journal.readAll().filter((e) => e.sessionId === sessionId));
}
