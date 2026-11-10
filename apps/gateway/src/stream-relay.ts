/**
 * 流式中继(ZCode 流式消息展示):loop onStream → 按会话聚合节流 → WS stream 消息。
 * llm-delta 高频(逐 token)合批 80ms 窗;控制事件(llm-begin/end、tool-*)立即冲刷待发增量后直发,保序。
 * 旁路通道:不落 journal,终态(message.agent/tool.result)仍走既有持久链路。
 */
export type RelayStreamEvent =
  | { type: "llm-begin" }
  | { type: "llm-delta"; text?: string; reasoning?: string }
  | { type: "llm-end"; text: string }
  | { type: "tool-begin"; callId: string; name: string }
  | { type: "tool-end"; callId: string; name: string; durationMs: number }
  | { type: "tool-progress"; callId: string; name: string; note: string }; // fixC-D4:长工具阶段进度直发

interface Pending {
  text: string;
  reasoning: string;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createStreamRelay(send: (msg: Record<string, unknown>) => void): { push(sessionId: string, ev: RelayStreamEvent): void; close(): void } {
  const pend = new Map<string, Pending>();
  const flush = (sid: string) => {
    const p = pend.get(sid);
    if (!p) return;
    if (p.timer) { clearTimeout(p.timer); p.timer = null; }
    if (p.text || p.reasoning) {
      send({ v: 1, type: "stream", sessionId: sid, ev: { type: "llm-delta", ...(p.text ? { text: p.text } : {}), ...(p.reasoning ? { reasoning: p.reasoning } : {}) } });
      p.text = "";
      p.reasoning = "";
    }
  };
  return {
    push(sid, ev) {
      if (ev.type === "llm-delta") {
        let p = pend.get(sid);
        if (!p) { p = { text: "", reasoning: "", timer: null }; pend.set(sid, p); }
        if (ev.text) p.text += ev.text;
        if (ev.reasoning) p.reasoning += ev.reasoning;
        if (!p.timer) p.timer = setTimeout(() => flush(sid), 80);
        return;
      }
      flush(sid); // 控制事件先冲刷,流内顺序不乱
      send({ v: 1, type: "stream", sessionId: sid, ev });
    },
    close() {
      for (const sid of [...pend.keys()]) flush(sid);
    },
  };
}
