/**
 * OTLP/HTTP JSON 追踪导出(step-031 遗留收口:OTel/远端上报,零依赖最小实现)。
 * journal 事件(turn/step/tool/llm)→ OTLP trace spans,批量定时外送;opt-in:
 * 未配 GENIE_OTEL_ENDPOINT 完全不构造、零开销;外送失败静默计数(fail-soft,不碰主链)。
 * 协议:OTLP v1 traces JSON(PUT/POST application/json),span 形状取规范子集。
 */
import type { Journal, JournalEvent } from "@lampgenie/core";

export interface OtelExporterOptions {
  /** OTLP/HTTP 端点(如 http://localhost:4318/v1/traces)。 */
  endpoint: string;
  /** 服务名(resource.service.name;缺省 lampgenie-harness)。 */
  serviceName?: string;
  /** 额外请求头(如认证)。 */
  headers?: Record<string, string>;
  /** 批量外送间隔 ms(缺省 5000)。 */
  flushIntervalMs?: number;
  /** 每批最大 span 数(超出截断,防端点拒收;缺省 200)。 */
  maxBatch?: number;
  /** fetch 注入(测试用)。 */
  fetchImpl?: typeof fetch;
  /** 时钟注入(测试用)。 */
  now?: () => number;
}

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startUnixNano: string;
  endUnixNano: string;
  attributes: { key: string; value: Record<string, unknown> }[];
  status?: { code: number; message?: string };
}

const attr = (k: string, v: string | number | boolean) => ({
  key: k,
  value: vtypeof(v),
});
function vtypeof(v: string | number | boolean): Record<string, unknown> {
  if (typeof v === "number") return { intValue: String(Math.round(v)) };
  if (typeof v === "boolean") return { boolValue: v };
  return { stringValue: v };
}

/** 简单确定性 16 字节 hex(哈希自字符串;traceId 需 32 hex,spanId 16 hex)。 */
function hexId(seed: string, len: number): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i++) {
    h1 = (h1 ^ seed.charCodeAt(i)) * 16777619 >>> 0;
    h2 = (h2 + seed.charCodeAt(i) * (i + 1)) >>> 0;
  }
  let out = "";
  let x = (h1 ^ h2) >>> 0;
  for (let i = 0; i < len / 8; i++) {
    x = (x * 1103515245 + 12345 + i) >>> 0;
    out += x.toString(16).padStart(8, "0");
  }
  return out.slice(0, len);
}

const NS = 1_000_000; // ms → ns

export interface OtelExporter {
  /** 挂到 journal(订阅增量事件;返回退订函数)。 */
  attach(journal: Journal): () => void;
  /** 手动冲刷(测试/停机用)。 */
  flush(): Promise<void>;
  /** 已导出 span 数/失败次数(观测)。 */
  stats(): { spans: number; failures: number; pending: number };
  stop(): void;
}

export function createOtelExporter(opts: OtelExporterOptions): OtelExporter {
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetchImpl ?? fetch;
  const maxBatch = opts.maxBatch ?? 200;
  const spans: Span[] = [];
  let exported = 0;
  let failures = 0;
  /** 进行中的 turn/step/tool 区间:openSpans 按 key 存开始信息。 */
  const open = new Map<string, { span: Span; t0: number }>();
  const turnTrace = new Map<string, string>(); // `${sessionId}:${turn}` → traceId
  let timer: ReturnType<typeof setInterval> | undefined;

  const start = (key: string, span: Span, t0: number) => { open.set(key, { span, t0 }); spans.push(span); };
  const end = (key: string, tEnd: number, status?: Span["status"]) => {
    const o = open.get(key);
    if (!o) return;
    o.span.endUnixNano = String(tEnd * NS);
    if (status) o.span.status = status;
    open.delete(key);
  };

  const handle = (e: JournalEvent): void => {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const sid = e.sessionId;
    switch (e.kind) {
      case "turn.start": {
        const turn = Number(p.turn ?? 0);
        const traceId = hexId(`${sid}:${turn}:${e.seq ?? ""}`, 32);
        turnTrace.set(`${sid}:${turn}`, traceId);
        start(`${sid}:turn:${turn}`, {
          traceId, spanId: hexId(`${sid}:turn:${turn}`, 16), name: "agent.turn", kind: 1,
          startUnixNano: String(now() * NS), endUnixNano: String(now() * NS),
          attributes: [attr("genie.session", sid), attr("genie.turn", turn)],
        }, now());
        break;
      }
      case "turn.end": {
        const turn = Number(p.turn ?? 0);
        end(`${sid}:turn:${turn}`, now(), String(p.reason) === "error" ? { code: 2, message: String(p.reason) } : { code: 1 });
        break;
      }
      case "step.start": {
        const turn = Number(p.turn ?? 0);
        const step = Number(p.step ?? 0);
        const traceId = turnTrace.get(`${sid}:${turn}`) ?? hexId(`${sid}:${turn}`, 32);
        start(`${sid}:step:${turn}:${step}`, {
          traceId, spanId: hexId(`${sid}:step:${turn}:${step}`, 16),
          parentSpanId: hexId(`${sid}:turn:${turn}`, 16),
          name: "agent.step", kind: 1,
          startUnixNano: String(now() * NS), endUnixNano: String(now() * NS),
          attributes: [attr("genie.turn", turn), attr("genie.step", step)],
        }, now());
        break;
      }
      case "step.end": {
        end(`${sid}:step:${Number(p.turn ?? 0)}:${Number(p.step ?? 0)}`, now(), String(p.reason) === "error" ? { code: 2, message: String(p.error ?? "error").slice(0, 120) } : { code: 1 });
        break;
      }
      case "tool.call": {
        const id = String(p.toolCallId ?? "");
        const traceId = spans.at(-1)?.traceId ?? hexId(sid, 32);
        start(`${sid}:tool:${id}`, {
          traceId, spanId: hexId(`${sid}:tool:${id}`, 16),
          parentSpanId: spans.at(-1)?.spanId,
          name: `tool.${String(p.name ?? "?")}`, kind: 3,
          startUnixNano: String(now() * NS), endUnixNano: String(now() * NS),
          attributes: [attr("genie.tool", String(p.name ?? "?")), attr("genie.toolCallId", id)],
        }, now());
        break;
      }
      case "tool.result": {
        const key = `${sid}:tool:${String(p.toolCallId ?? "")}`;
        const content = String(p.content ?? "");
        end(key, now(), content.startsWith("错误") ? { code: 2, message: content.slice(0, 120) } : { code: 1 });
        break;
      }
      case "message.agent": {
        // LLM 调用区间:llmMs 在场才成 span(不推断)。
        const llmMs = typeof p.llmMs === "number" ? p.llmMs : undefined;
        if (llmMs === undefined) break;
        const turn = Number(p.turn ?? 0);
        const traceId = turnTrace.get(`${sid}:${turn}`) ?? hexId(sid, 32);
        const tEnd = now();
        const usage = p.usage as { inputTokens?: number; outputTokens?: number } | undefined;
        spans.push({
          traceId, spanId: hexId(`${sid}:llm:${turn}:${Number(p.step ?? 0)}`, 16),
          parentSpanId: hexId(`${sid}:step:${turn}:${Number(p.step ?? 0)}`, 16),
          name: "llm.chat", kind: 4,
          startUnixNano: String((tEnd - llmMs) * NS), endUnixNano: String(tEnd * NS),
          attributes: [
            attr("genie.turn", turn), attr("genie.llmMs", llmMs),
            ...(typeof p.ttftMs === "number" ? [attr("genie.ttftMs", p.ttftMs)] : []),
            ...(usage?.inputTokens !== undefined ? [attr("genie.tokens.input", usage.inputTokens)] : []),
            ...(usage?.outputTokens !== undefined ? [attr("genie.tokens.output", usage.outputTokens)] : []),
          ],
        });
        break;
      }
      default:
        break;
    }
  };

  const flush = async (): Promise<void> => {
    while (spans.length > 0) {
      // 先窥视后出队:外送失败批次留在队列(fail-soft 不丢数据),成功才 splice。
      const batch = spans.slice(0, maxBatch);
      const payload = {
        resourceSpans: [{
          resource: { attributes: [attr("service.name", opts.serviceName ?? "lampgenie-harness")] },
          scopeSpans: [{
            scope: { name: "lampgenie-harness.agent", version: "1" },
            spans: batch.map((s) => ({
              traceId: s.traceId, spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name, kind: s.kind,
              startTimeUnixNano: s.startUnixNano, endTimeUnixNano: s.endUnixNano,
              attributes: s.attributes,
              status: s.status ?? { code: 1 },
            })),
          }],
        }],
      };
      try {
        const res = await doFetch(opts.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
          body: JSON.stringify(payload),
        });
        if (!res.ok) { failures += 1; break; }
        spans.splice(0, batch.length);
        exported += batch.length;
      } catch {
        failures += 1;
        break; // 端点不可达:留待下轮,不无限打转
      }
    }
  };

  return {
    attach(journal) {
      timer = setInterval(() => { void flush(); }, opts.flushIntervalMs ?? 5000);
      timer.unref?.();
      return journal.subscribe(handle);
    },
    flush,
    stats: () => ({ spans: exported, failures, pending: spans.length }),
    stop: () => { if (timer) clearInterval(timer); },
  };
}

/** env 便捷装配(缺端点返回 undefined=零开销;GENIE_OTEL_HEADERS 形如 "k=v,k2=v2")。 */
export function otelExporterFromEnv(env: NodeJS.ProcessEnv = process.env): OtelExporter | undefined {
  const endpoint = env.GENIE_OTEL_ENDPOINT;
  if (!endpoint) return undefined;
  const headers: Record<string, string> = {};
  for (const pair of (env.GENIE_OTEL_HEADERS ?? "").split(",")) {
    const i = pair.indexOf("=");
    if (i > 0) headers[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return createOtelExporter({ endpoint, ...(Object.keys(headers).length ? { headers } : {}) });
}
