/**
 * 压缩钩子工厂(「compact 触发的同时触发 exp」落地):
 * 阈值判定 autoCompactGate(模型声明 contextWindow→窗口×80% 为权威;未声明→显式阈值;
 * 皆无→0.8×缺省窗口 1M=800k,宁晚不早);真压缩(带摘要 compact.done 边界)之外不压——
 * 子 agent 结果合并进会话(tool.result)只是普通上下文增长,不走本钩子的压缩路径(解耦)。
 * 真压缩发生→同步触发经验沉淀(exp=harness-experience distillFromTask,fold-in 进经验库,
 * 被压缩的头部内容不丢知识;异步不阻塞主链路,失败静默)。
 */
import { autoCompact } from "@lampgenie/runtime/agent/auto-compact";
import { clearReadFiles, readFilesOf } from "@lampgenie/runtime/agent/read-file-state";
import type { MicrocompactConfig } from "@lampgenie/runtime/agent/microcompact";
import { distillFromTask, type ExperienceStore } from "@lampgenie/experience";
import type { Journal } from "@lampgenie/core";
import type { LlmProvider } from "@lampgenie/runtime/agent/loop";
import { autoCompactGate } from "./compact-gate.js";
import { loadDenyMatcher, rehydrateAfterCompact, type CompactRehydrateConfig } from "./compact-rehydrate.js";
import { repoRoot } from "./repo-root.js";

export interface CompactHookOptions {
  /** 主模型上下文窗口 tokens(main.ts 按轨取 config);undefined=无窗口回退链。 */
  contextWindow?: number;
 /** 请求实际 max_tokens( O3/O4:输出预留=min(该值??32000,21000),与 ZCode 同尺)。 */
  maxOutputTokens?: number;
  /** 显式压缩阈值(config agent.compactThresholdTokens;仅未声明窗口时生效)。 */
  explicitThreshold?: number;
 /** 思考力度档位(四档联动:阈值×EFFORT_COMPACT_RATIOS;缺省=1.0 不缩放)。 */
  reasoningEffort?: string;
  /** 摘要前 microcompact 配置(与 loop 读侧同源;缺省只做超大结果/去重等确定性治理)。 */
  microcompact?: MicrocompactConfig;
  /** 压缩模型轨(生产:models.compact ?? auxLlm ?? llm,不走 realtime 主轨)。 */
  compactLlm: LlmProvider;
  /** exp 提炼模型轨(缺省同压缩轨)。 */
  expLlm?: LlmProvider;
  /** DevLog 落盘目录。 */
  devlogDir: string;
  /** 触发任务 id(exp 沉淀条目溯源用)。 */
  taskId: string;
  /** 会话无 message.user 时的兜底指令(一般=任务书)。 */
  fallbackInstruction: string;
  /** 经验库 store(生产传 getExperienceStore() 单例;测试注入临时 store)。 */
  store: ExperienceStore;
 /**  压缩后文件正文补回配置(agent.compactRehydrate;缺省启用)。对象或执行时读取的 getter——
   * getter 形态让「执行时 config 关闭」生效(热配置刷新后不必重建 hook)。 */
  compactRehydrate?: CompactRehydrateConfig | (() => CompactRehydrateConfig | undefined);
  /** 仓根(测试注入;缺省 repoRoot())。 */
  repoRoot?: string;
  /** 压缩完成回调(2026-11 看板刷新桥):手动/自动路径之外,自动压缩成功也要能主动推一帧
   *  trace.stats(否则看板上容量%要等 2s 轮询)。未注入=零行为差异。 */
  onCompacted?: (r: { sessionId: string; compacted: boolean; summary?: string }) => void;
}

/** 看板刷新桥的进程级注册表(2026-11):server.ts 启动时把 broadcastTraceStats 注册进来,
 * agent-wiring / compact-hook 的自动压缩路径据此主动推一帧 trace.stats(它们拿不到 wss)。
 * 未注册(测试/独立装配)= no-op,零行为差异。 */
let traceStatsBroadcaster: ((sessionId: string) => Promise<void>) | null = null;

export function registerTraceStatsBroadcaster(fn: ((sessionId: string) => Promise<void>) | null): void {
  traceStatsBroadcaster = fn;
}

/** 取当前注册的看板刷新桥(未注册=undefined;调用方按需 void 调用,不阻塞主链路)。 */
export function broadcastTraceStatsOf(): ((sessionId: string) => Promise<void>) | undefined {
  return traceStatsBroadcaster ?? undefined;
}

/** 产出一个可挂 AgentLoop.compactHook 的闭包。 */
export function makeCompactHook(o: CompactHookOptions): (j: Journal, sid: string) => Promise<void> {
  return async (j, sid) => {
    const gate = autoCompactGate(j.readAll(), sid, o.contextWindow, o.explicitThreshold ?? 0, o.maxOutputTokens, o.reasoningEffort);
    const threshold = gate.threshold;
    if (gate.baseline) {
      // 每个压缩episode只提示一次(episode=自最后一次 compact.done 起)
      const evs = j.readAll();
      const lastCompactSeq = [...evs].reverse().find((e) => e.sessionId === sid && e.kind === "compact.done")?.seq ?? 0;
      const alreadyTold = evs.some((e) => e.sessionId === sid && e.kind === "message.system" && (e.seq ?? 0) > lastCompactSeq
        && String((e.payload as { text?: string }).text || "").includes("上下文基线"));
      if (!alreadyTold) {
        const effortNote = gate.effortRatio < 1 ? `(当前思考力度档位阈值×${gate.effortRatio})` : "";
        const floorNote = gate.floorUsed > 0 && gate.floorUsed >= threshold
          ? `;上次压缩后首个实测水位 ${gate.floorUsed} tok 仍 ≥ 阈值(2026-11-04 floor 护栏:强压已停用——继续压只会摘要套摘要丢原始消息)`
          : "";
        const reason = `上下文基线(系统提示+注入块)约 ${gate.used} tok,已接近压缩阈值 ${threshold} tok${effortNote}——压缩只能裁对话裁不动基线,已暂停自动压缩。请精简记忆注入或调大模型上下文窗口${floorNote}。`;
        j.append({ kind: "message.system", sessionId: sid, payload: { text: reason } });
        // 跳过落事件(2026-11 边界元数据):基线过大=这次自动压缩没发生,事件流里要留痕
        // (此前只有一条 message.system,看板/审计无法把它算成「压缩跳过」)。
        j.append({ kind: "compact.skipped", sessionId: sid, payload: { reason: "上下文基线过大,已暂停自动压缩", trigger: "auto", thresholdTokens: threshold, ...(gate.floorUsed ? { floorUsed: gate.floorUsed } : {}) } });
      }
      return;
    }
    if (!gate.fire) return;
 // (配合 n1「head 为空=诚实返回,不再假压缩」):保留条数按实际消息数收敛——
    // 固定 keepRecent=10 时,「消息少但单条巨大」的会话(3 条 tool 结果撑爆窗口)head 恒为空,
    // autoCompact 会诚实拒绝 → 压缩永远跑不动。收敛口径=最多保留 10 条,但至少留 1 条进 head。
    const msgCount = j.readAll().filter((e) => e.sessionId === sid
      && (e.kind === "message.user" || e.kind === "message.agent" || e.kind === "tool.result" || e.kind === "message.system")).length;
    const keepRecentMessages = Math.max(1, Math.min(10, msgCount - 1));
    const r = await autoCompact(j, sid, {
      thresholdTokens: threshold,
      keepRecentMessages,
      compactLlm: o.compactLlm,
      devlogDir: o.devlogDir,
      force: gate.force,
      trigger: "auto",
      ...(o.microcompact ? { microcompact: o.microcompact } : {}),
    });
    // 看板刷新桥(2026-11):自动压缩成功也要推一帧 trace.stats。onCompacted 未注入时
    // 退回进程级注册表(server.ts 启动注册),两者皆无=零行为差异。
    if (r.compacted) {
 //  压缩后文件正文补回:压缩后只剩 summary+tail,刚读过的文件正文消失。
      // 顺序关键——先取台账 entries,再 rehydrate,最后 clearReadFiles(反了就取不到候选)。
      // 失败 try/catch 静默:补回只是提示层增益,绝不影响压缩/exp 主链。
      try {
        const cfg = typeof o.compactRehydrate === "function" ? o.compactRehydrate() : o.compactRehydrate;
        if (cfg?.enabled !== false) {
          const root = o.repoRoot ?? repoRoot();
          const entries = readFilesOf(sid);
          if (entries.length > 0) {
            rehydrateAfterCompact({
              journal: j,
              sessionId: sid,
              entries,
              repoRoot: root,
              caps: cfg ?? {},
              deny: loadDenyMatcher(root),
            });
          }
        }
      } catch { /* 正文补回失败不影响压缩 */ }
 // 重复读取去重台账:压缩成功后上下文里已没有原文,台账必须清空——否则
      // 模型重读同一段会被「重复读取·已省略」挡住,拿不到被压掉的原文。try/catch 静默不影响压缩主链。
      try { clearReadFiles(sid); } catch { /* 提示层台账清理失败不影响压缩 */ }
      const payload = { sessionId: sid, compacted: true, ...(r.summary !== undefined ? { summary: r.summary } : {}) };
      if (o.onCompacted) {
        try { o.onCompacted(payload); } catch { /* 回调失败不影响主链路 */ }
      } else {
        void broadcastTraceStatsOf()?.(sid);
      }
    }
 // (「compact 触发的同时触发 exp」):真压缩发生→被压缩的头部内容
    // 同步进经验库(fold-in)。异步不阻塞主链路;distillFromTask 内部已有失败兜底。
    if (r.compacted) {
      const expLlm = o.expLlm ?? o.compactLlm;
      const lastUser = [...j.readAll()].reverse().find((e) => e.sessionId === sid && e.kind === "message.user");
      void distillFromTask(o.store, j, {
        id: `${o.taskId}-compact`,
        sessionId: sid,
        instruction: String((lastUser?.payload as { text?: string } | undefined)?.text ?? o.fallbackInstruction).slice(0, 500),
        state: "done",
        result: r.summary ?? "",
      }, { chat: (prompt) => expLlm.chat([{ role: "user", content: prompt }], []) }).catch(() => {});
    }
  };
}
