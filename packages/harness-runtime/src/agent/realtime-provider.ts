/**
 * DashScope/Qwen Realtime provider(WebSocket,api-ws beta 方言)。
 * 协议照 qwen-audio-agent 的 openai-compatible-protocol.mjs/realtime-provider.mjs:
 * session.update(modalities:["text"], turn_detection:null) → conversation.item.create
 * (input_text/function_call/function_call_output)→ response.create → response.text.delta/done
 * → response.done(output[] 含 message 与 function_call)。单响应槽:每次 chat 新建会话,全量回放历史。
 * 端点规则(genie-voice qwen_realtime.py 实证):wss://<host>/api-ws/v1/realtime?model=...,
 * Authorization: Bearer <key>;https baseUrl 的 host 直接复用。
 *
 * text+audio 直出(2026-10-21 realtime-plus 形态,qwen-audio-3.1-realtime* 口径,参考 genie-voice
 * qwen_realtime.py):audioOut=true 时 session modalities ["text","audio"] + voice + 百炼传统字符串
 * 音频格式(input_audio_format/output_audio_format);response.audio.delta 聚合为 LlmResponse.audio
 * (pcm16@24k 包 WAV 容器,浏览器可直接播)——该形态链路上不再外挂 tts。语音输入同样直入:
 * user 消息带 audio(input_audio 内容件,voice.speak 转写会话同款实证形态)。
 * 事件名百炼为 pre-rename 口径(response.audio.delta / response.audio_transcript.delta,
 * 见 genie-voice _BAILIAN_EVENT_REMAP),renamed 口径一并兼容。
 */
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { LlmProvider, LlmResponse, Message, ToolSpec } from "./loop";
import { extractUsage } from "./openai-provider";
import { pcm16ToWav } from "./audio-wav";

/** 百炼 realtime 输出音频口径:PCM16 单声道 24kHz(OpenAI Realtime 语义,genie-voice 同)。 */
const REALTIME_OUT_RATE = 24_000;

export interface RealtimeOptions {
  /** 完整 realtime WS base(wss://.../api-ws/v1/realtime);也可给 https 端点(按 host 推导)。 */
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /** text+audio 直出(realtime-plus 形态):session modalities ["text","audio"],聚合 response.audio.delta
   * 进 LlmResponse.audio(WAV 容器)。缺省 false=纯文本(现状,字节级不变)。 */
  audioOut?: boolean;
  /** audioOut 时的输出音色(session.voice;realtime 音色域如 longanlingxin)。 */
  voice?: string;
}

export function realtimeUrl(baseUrl: string, model: string): string {
  let url = baseUrl;
  // https 端点(compatible-mode)→ 同 host 的 api-ws realtime 路径
  if (url.startsWith("https://")) url = url.replace(/^https:\/\//, "wss://").replace(/\/(compatible-mode)?(\/v1)?\/?$/, "");
  if (!/\/api-ws\/v1\/realtime$/.test(url)) url = url.replace(/\/$/, "") + "/api-ws/v1/realtime";
  return url + (url.includes("?") ? "&" : "?") + "model=" + encodeURIComponent(model);
}

const eventId = () => "event_" + randomUUID().replaceAll("-", "");

export function createRealtimeProvider(opts: RealtimeOptions): LlmProvider & { update(patch: Partial<RealtimeOptions>): void; readonly modelName: string } {
  const cur = { ...opts };
  return {
    /** 模型名读数(step-060 子代理目录):registry/面板展示用;getter=热更新(update)后读到新值。 */
    get modelName() { return cur.model; },
    update(patch) {
      if (patch.model !== undefined) cur.model = String(patch.model);
      if (patch.baseUrl !== undefined) cur.baseUrl = String(patch.baseUrl);
      if (patch.apiKey !== undefined) cur.apiKey = String(patch.apiKey);
      if (patch.timeoutMs !== undefined) cur.timeoutMs = Number(patch.timeoutMs);
      if (patch.voice !== undefined) cur.voice = patch.voice === "" ? undefined : String(patch.voice);
      if (patch.audioOut !== undefined) cur.audioOut = Boolean(patch.audioOut);
    },
    chat(messages, tools, signal, onDelta): Promise<LlmResponse> {
      const once = (): Promise<LlmResponse> => new Promise<LlmResponse>((resolve, reject) => {
        const deadline = setTimeout(() => { cleanup(); reject(new Error(`realtime 超时(${cur.timeoutMs ?? 60_000}ms)`)); }, cur.timeoutMs ?? 60_000);
        const ws = new WebSocket(realtimeUrl(cur.baseUrl, cur.model), {
          headers: { authorization: `Bearer ${cur.apiKey}` },
          handshakeTimeout: Math.min(cur.timeoutMs ?? 60_000, 30_000),
          maxPayload: 1024 * 1024,
        });
        let settled = false;
        const fail = (err: Error) => { if (!settled) { settled = true; cleanup(); reject(err); } };
        const done = (r: LlmResponse) => { if (!settled) { settled = true; cleanup(); resolve(r); } };
        function cleanup() {
          clearTimeout(deadline);
          try { ws.close(); } catch { /* ignore */ }
        }
        signal?.addEventListener("abort", () => fail(new Error("aborted")), { once: true });
        ws.on("error", (e: Error) => fail(new Error("realtime ws: " + e.message)));
        ws.on("unexpected-response", (_r: unknown, resp: { statusCode?: number }) => fail(new Error(`realtime 握手 ${resp.statusCode ?? "?"}`)));

        // 状态机:session.updated → 逐条回放 item(等 created)→ response.create → response.done
        const items = buildItems(messages);
        // 语音输入在场才声明输入音频格式(纯文本会话字节级维持现状;pcm16=voice.speak 转写会话实证口径)
        const hasAudioIn = items.some((i) => Array.isArray((i as { content?: Array<{ type?: string }> }).content) && (i as { content: Array<{ type?: string }> }).content.some((c) => c.type === "input_audio"));
        const audioOut = cur.audioOut === true;
        let sent = 0;
        let pendingCreate = false;
        const sendItem = () => {
          if (sent >= items.length) {
            if (!pendingCreate) {
              pendingCreate = true;
              // audioOut 时 response 不带 modalities(继承 session 的 ["text","audio"];genie-voice 父类同款)
              ws.send(JSON.stringify({ event_id: eventId(), type: "response.create", ...(audioOut ? {} : { response: { modalities: ["text"] } }) }));
            }
            return;
          }
          ws.send(JSON.stringify({ event_id: eventId(), type: "conversation.item.create", item: items[sent]! }));
        };

        ws.on("open", () => {
          const system = messages.find((m) => m.role === "system");
          ws.send(JSON.stringify({
            event_id: eventId(),
            type: "session.update",
            session: {
              modalities: audioOut ? ["text", "audio"] : ["text"],
              turn_detection: null,
              // 音频格式仅在音频在场时声明(百炼传统字符串口径,genie-voice 实证:input pcm16/output pcm)
              ...((hasAudioIn || audioOut) ? { input_audio_format: "pcm16" } : {}),
              ...(audioOut ? { output_audio_format: "pcm" } : {}),
              ...(audioOut && cur.voice ? { voice: cur.voice } : {}),
              ...(system ? { instructions: system.content } : {}),
              ...(tools.length > 0
                ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) }
                : {}),
            },
          }));
        });

        // text+audio 直出聚合槽:音频 delta(b64 pcm 分片)与口述转写(pre-rename 口径优先)
        const audioChunks: Buffer[] = [];
        let transcript = "";
        ws.on("message", (raw: WebSocket.RawData) => {
          let e: Record<string, unknown>;
          try { e = JSON.parse(raw.toString()) as Record<string, unknown>; } catch { return; }
          const type = e.type as string;
          if (type === "error") {
            const err = e.error as { message?: string; code?: string } | undefined;
            fail(new Error(`realtime: ${err?.message ?? String(e).slice(0, 120)}${err?.code ? " (" + err.code + ")" : ""}`));
            return;
          }
          // DashScope api-ws 握手层错误是扁平 {code,message} 信封(无 type 字段,如选了非 realtime 模型回
          // InvalidParameter "url error")——不识别会干等满超时再重试,fail-fast 才能让配置错误秒级显形。
          if (!type && (e.code !== undefined || e.message !== undefined)) {
            fail(new Error(`realtime: ${String(e.message ?? e.code).slice(0, 160)}${e.code ? " (" + String(e.code) + ")" : ""}`));
            return;
          }
          if (type === "session.updated") { sendItem(); return; }
          if (type === "conversation.item.created") { sent += 1; sendItem(); return; }
          // 流式增量(step-050,ZCode 流式消息展示):response.text.delta 逐块透出;终态仍以 response.done 聚合为准。
          if (type === "response.text.delta") {
            const d = String(e.delta ?? "");
            if (d && onDelta) { try { onDelta({ text: d }); } catch { /* 回调异常不断流 */ } }
            return;
          }
          // 口述转写增量(audio 输出的文字面;百炼 pre-rename 口径,renamed 一并认)
          if (type === "response.audio_transcript.delta" || type === "response.output_audio_transcript.delta") {
            const d = String(e.delta ?? "");
            transcript += d;
            if (d && onDelta) { try { onDelta({ text: d }); } catch { /* 回调异常不断流 */ } }
            return;
          }
          // 音频增量(b64 pcm 分片;百炼 pre-rename 口径,renamed 一并认)
          if (type === "response.audio.delta" || type === "response.output_audio.delta") {
            const d = String(e.delta ?? "");
            if (d) audioChunks.push(Buffer.from(d, "base64"));
            return;
          }
          if (type === "response.done") {
            const resp = e.response as { status?: string; output?: unknown[] } | undefined;
            if (resp?.status && resp.status !== "completed") { fail(new Error(`realtime response ${resp.status}`)); return; }
            const out = (resp?.output ?? []) as Array<Record<string, unknown>>;
            let text = "";
            const toolCalls: { id: string; name: string; arguments: string }[] = [];
            for (const o of out) {
              if (o.type === "message") {
                const content = o.content as Array<{ type?: string; text?: string }> | undefined;
                text += (content ?? []).map((c) => c.text ?? "").join("");
              } else if (o.type === "function_call") {
                toolCalls.push({ id: String(o.call_id ?? o.id ?? "call_" + randomUUID().slice(0, 8)), name: String(o.name ?? ""), arguments: String(o.arguments ?? "{}") });
              }
            }
            // audio 形态下 message 文字面可能为空(内容件是 audio)——口述转写兜底为正文
            const content = text || transcript;
            const audio = audioChunks.length
              ? { mime: "audio/wav", base64: pcm16ToWav(Buffer.concat(audioChunks), REALTIME_OUT_RATE).toString("base64") }
              : undefined;
            const rtUsage = extractUsage((resp ?? {}) as Record<string, unknown>);
            done({ content, ...(toolCalls.length ? { toolCalls } : {}), ...(audio ? { audio } : {}), ...(rtUsage ? { usage: rtUsage } : {}) });
          }
        });
      });
      // step-052 自愈:超时多为端点会话态卡死(实测 860ms 直连正常而网关全挂)——换新会话重试一次;
      // 失败一律留日志(此前静默无痕,排障全靠猜)。
      return once().catch((err: Error) => {
        if (/超时/.test(err.message) && !signal?.aborted) {
          console.error("[realtime] 超时,重试一次:", err.message.slice(0, 120));
          return once();
        }
        console.error("[realtime] 调用失败:", err.message.slice(0, 200));
        throw err;
      });
    },
  };
}

/** 把 agent loop 的 messages 翻译成 realtime conversation items(全量回放)。 */
function buildItems(messages: Message[]): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === "system") continue; // 进 instructions
    if (m.role === "user") {
      // 语音直入(realtime-plus):audio 在场只发 input_audio(占位文本不掺和,防误导模型;
      // {type:"input_audio", audio:b64} 为 voice.speak 转写会话同款实证形态)
      const audio = (m as { audio?: { data: string } }).audio;
      items.push(audio?.data
        ? { type: "message", role: "user", content: [{ type: "input_audio", audio: audio.data }] }
        : { type: "message", role: "user", content: [{ type: "input_text", text: m.content }] });
    } else if (m.role === "assistant") {
      // DashScope api-ws beta 方言:assistant 回放的 content 类型必须是 output_text(step-052 实测;
      // 此前的 'text' 让多轮会话第二回合起必被拒:assistant role only supports content type 'output_text')。
      if (m.content) items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: m.content }] });
      for (const c of m.toolCalls ?? []) {
        items.push({ type: "function_call", call_id: c.id, name: c.name, arguments: c.arguments });
      }
    } else if (m.role === "tool") {
      items.push({ type: "function_call_output", call_id: m.toolCallId ?? "", output: m.content });
    }
  }
  return items;
}
