/**
 * OTLP/HTTP JSON 追踪导出(遗留:OTel/远端上报,零依赖最小实现)。
 * journal 事件(turn/step/tool/llm)→ OTLP trace spans,批量定时外送;opt-in:
 * 未配 GENIE_OTEL_ENDPOINT 完全不构造、零开销;外送失败静默计数(fail-soft,不碰主链)。
 * 协议:OTLP v1 traces JSON(PUT/POST application/json),span 形状取规范子集。
 */
import type { Journal, JournalEvent } from "@lampgenie/core";
import {
  ExportLedger,
  copyForExport,
  dedupeKeyOf,
  redactForExport,
  type ExportRedactor,
} from "./export-ledger";

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
 /** 导出账本注入(测试/复用;缺省按 maxRecordBytes 新建)。 */
  ledger?: ExportLedger;
 /** 单条 span 导出字节上限(缺省 256 KiB;超限拒绝而非截断)。 */
  maxRecordBytes?: number;
 /** 脱敏器注入(测试用;缺省递归 redactText)。 */
  redactor?: ExportRedactor;
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
 /**
 * 已导出 span 数/失败次数(观测)。
 * dropped* 为导出闸门丢弃计数(不截断、不降级):重复 / 超限 / 脱敏失败(含不可拷贝)。
 */
  stats(): {
    spans: number;
    failures: number;
    pending: number;
    droppedRedaction: number;
    droppedTooLarge: number;
    droppedDuplicate: number;
  };
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

 // ── 导出闸门(flush 前逐条过闸;span 本体永不被改写,只处理导出副本)──
  const ledger = opts.ledger ?? new ExportLedger({ maxRecordBytes: opts.maxRecordBytes ?? 262_144 });
 /** 已过闸、待外送的导出副本:发送失败时保留,重试不再重复入账(否则下轮会被误判 DUPLICATE)。 */
  let outbox: Span[] = [];
  let droppedRedaction = 0;
  let droppedTooLarge = 0;
  let droppedDuplicate = 0;

 /** span 所属 session:优先 genie.session 属性(turn span 带);其余 span 无 session 字段,
 * traceId 是哈希、不含 sid,故回退 "unknown"(spanId 本身已唯一,去重键仍稳定)。 */
  const sessionOf = (s: Span): string => {
    for (const a of s.attributes) {
      const v = a.value as { stringValue?: unknown };
      if (a.key === "genie.session" && typeof v.stringValue === "string") return v.stringValue;
    }
    return "unknown";
  };

 /**
 * 单条 span 过闸:深拷贝 → 脱敏(只作用于副本)→ 入账。
 * 失败分支一律丢弃(不截断、不回退原记录):这是「宁可少一条遥测,不可漏一次凭证」的边界。
 */
  const gate = (s: Span): Span | undefined => {
    const copy = copyForExport(s);
    if (!copy.ok) {
 // 不可序列化与脱敏失败同属 fail-closed 丢弃桶(都无法证明出站内容安全)。
      droppedRedaction += 1;
      ledger.markRedactionFailed();
      return undefined;
    }
    const redacted = redactForExport(copy.record, opts.redactor);
    if (!redacted.ok) {
      droppedRedaction += 1;
      ledger.markRedactionFailed();
      return undefined;
    }
    const res = ledger.admit(dedupeKeyOf(sessionOf(s), "otel", s.spanId), redacted.record);
    if (res.ok) return redacted.record as Span;
    if (res.code === "TOO_LARGE") droppedTooLarge += 1;
    else if (res.code === "DUPLICATE") droppedDuplicate += 1;
    else droppedRedaction += 1; // INVALID(空 key 等)归入同一 fail-closed 桶
    return undefined;
  };

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
    for (;;) {
 // 先补齐 outbox:队首逐条过闸(过闸即出队,失败直接丢弃计数,不会被重复判定)。
      while (outbox.length < maxBatch && spans.length > 0) {
        const s = spans.shift()!;
        const prepared = gate(s);
        if (prepared) outbox.push(prepared);
      }
      if (outbox.length === 0) break;
 // 先窥视后出队:外送失败批次留在 outbox(fail-soft 不丢数据),成功才切掉。
      const batch = outbox.slice(0, maxBatch);
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
        outbox = outbox.slice(batch.length);
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
    stats: () => ({
      spans: exported,
      failures,
      pending: spans.length + outbox.length,
      droppedRedaction,
      droppedTooLarge,
      droppedDuplicate,
    }),
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
