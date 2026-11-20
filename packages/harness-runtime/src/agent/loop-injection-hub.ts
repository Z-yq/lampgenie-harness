/**
 * loop 注入枢纽(事件面 v1,,RSI 注入编排段)。
 * 设计动机:RSI 的每类产物(死路/预防件/基因/方向)都要「在对应节点注入」——此前每个注入位
 * 都是一次 gateway 核心代码修改(run-with-agent/file-tools 各自手接)。本模块把「某节点注入
 * 什么」变成**可注册的 listener**(瀑布插件式精髓的落地形态,自建、不引依赖):
 * - listener 只产文本(空串=零注入),不感知彼此;
 * - hub 管预算(单块上限+总上限,超限**整块跳过**——截断的半句话比没有更误导)、
 * fail-soft(单个 listener 抛错折叠成 skipped,绝不阻塞开工)、来源标签(审计可回查)。
 * 语义对照(对齐 ref/deepseek-harness 的三种派发):
 * - collect(本模块)= waterfall 的无 veto 变体:多个 listener 各自贡献块,顺序稳定合成;
 * - 硬门类干预(plan-gate/change_surface)**不进本枢纽**——那是 serial/veto 语义,
 * 已有独立闸门实现,不重复造。
 * 纪律:零 IO、零 LLM、不 throw;listener 可同步可异步;注册幂等(同 id 覆盖)。
 */

/** 注入输入:listener 只读,不修改(无变换链语义)。 */
export interface LoopInjectionInput {
 /** 注入点标识(v1 生产使用 "kickoff";与 gap-taxonomy 的 INJECTION_POINTS 由 listener 自行映射)。 */
  point: string;
  sessionId: string;
 /** 任务指令原文(词面匹配用)。 */
  taskText: string;
  taskClass?: string;
 /** 命中模块(如缺陷基因匹配的主模块;无则缺省)。 */
  module?: string;
}

/** 单个注入块(带来源与预算审计)。 */
export interface LoopInjectionBlock {
  source: string;
  text: string;
  bytes: number;
}

export interface LoopInjectionListener {
 /** 稳定 id(注册幂等键;进审计留痕)。 */
  id: string;
 /** 产出注入文本;空串=本 listener 零注入。禁止 throw(hub 仍兜底折叠)。 */
  collect: (input: LoopInjectionInput) => string | Promise<string>;
 /** 单块字节上限(缺省 LOOP_INJECTION_BLOCK_MAX_BYTES);超限整块跳过并记 skipped。 */
  maxBytes?: number;
}

export const LOOP_INJECTION_BLOCK_MAX_BYTES = 1536;

export interface LoopInjectionResult {
  blocks: LoopInjectionBlock[];
  totalBytes: number;
 /** 被跳过的 listener id 与原因(超预算/抛错)——审计面用,不静默。 */
  skipped: Array<{ id: string; reason: "error" | "over-budget"; bytes?: number; error?: string }>;
}

export interface LoopInjectionHub {
  register(listener: LoopInjectionListener): void;
 /** 收集一次:顺序=注册序(确定性);单 listener 失败/超限不拖垮其余。 */
  collect(input: LoopInjectionInput): Promise<LoopInjectionResult>;
 /** 已注册 listener id(测试/审计)。 */
  listenerIds(): string[];
}

export function createLoopInjectionHub(opts: { totalMaxBytes?: number } = {}): LoopInjectionHub {
  const totalMaxBytes = typeof opts.totalMaxBytes === "number" && opts.totalMaxBytes > 0 ? opts.totalMaxBytes : 4096;
  const listeners = new Map<string, LoopInjectionListener>();
  return {
    register(listener) {
      if (!listener || typeof listener.id !== "string" || listener.id.trim() === "") return;
      if (typeof listener.collect !== "function") return;
      listeners.set(listener.id, listener); // 同 id 覆盖=幂等注册
    },
    async collect(input) {
      const result: LoopInjectionResult = { blocks: [], totalBytes: 0, skipped: [] };
      for (const listener of listeners.values()) {
        let text = "";
        try {
 // await 对同步返回的 string 同样成立;异步 listener 的 Promise 在此统一解开。
          const out = await listener.collect(input);
          if (typeof out === "string") text = out;
        } catch (error) {
          result.skipped.push({ id: listener.id, reason: "error", error: error instanceof Error ? error.message : String(error) });
          continue;
        }
        if (text === "") continue;
        const maxBytes = typeof listener.maxBytes === "number" && listener.maxBytes > 0 ? listener.maxBytes : LOOP_INJECTION_BLOCK_MAX_BYTES;
        const bytes = Buffer.byteLength(text, "utf8");
        if (bytes > maxBytes || result.totalBytes + bytes > totalMaxBytes) {
          result.skipped.push({ id: listener.id, reason: "over-budget", bytes });
          continue;
        }
        result.blocks.push({ source: listener.id, text, bytes });
        result.totalBytes += bytes;
      }
      return result;
    },
    listenerIds() {
      return [...listeners.keys()];
    },
  };
}
