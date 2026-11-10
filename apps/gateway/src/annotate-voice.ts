/**
 * 录音批注转写(截图标注链的语音输入,2026-11 新增)。
 *
 * 面板在标注时可以直接说话,录音以 dataURL(audio/webm;codecs=opus)随 annotate.submit
 * 一起上来;服务端把它交给小模型(qwen3.8-omni-flash 形态的 OpenAI 兼容端点)转写成
 * 文字,再并入任务书。全链路 fail-soft:转写失败只记原因,不阻塞提交。
 *
 * 纯函数 + 可注入 fetch,便于单测(mock fetch 即可覆盖段落解析/超时/HTTP 错误)。
 */
import { chatCompletionsUrl } from "@lampgenie/runtime/agent/openai-provider";

/** 语义上限 8MB:面板 webm/opus 一分钟约 100~200KB,8MB 足够长录音;超限直接拒绝。 */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
/** 转写默认超时(小模型整段转写通常 3~10s)。 */
export const VOICE_PARSE_TIMEOUT_MS = 30_000;

export type AudioFormat = "webm" | "mp3" | "m4a" | "wav";

export type AudioPayload = { bytes: Buffer; format: AudioFormat; mime: string };

/** mime → 端点要求的 format 字段(input_audio.format)。 */
const FORMAT_BY_MIME: Record<string, AudioFormat> = {
  "audio/webm": "webm",
  "audio/mp3": "mp3",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/x-wav": "wav",
};

/**
 * 解析录音 dataURL:`data:audio/webm;codecs=opus;base64,...`。
 * 只接受 audio/* 且 format 在支持集内;>8MB 拒绝并给可读错。
 * (dataURL 形态校验即在此处做——不再单独导出布尔判定,避免死代码。)
 */
export function parseAudioDataUrl(dataUrl: string): AudioPayload {
  const raw = String(dataUrl ?? "");
  const m = /^data:(audio\/[^;,]+)(?:;codecs=([^;,]+))?;base64,(.*)$/s.exec(raw);
  if (!m) throw new Error("录音数据不是 audio/* 的 dataURL");
  const mime = String(m[1] ?? "").toLowerCase();
  const format = FORMAT_BY_MIME[mime];
  if (!format) throw new Error(`录音格式不支持(${mime};支持 webm/mp3/m4a/wav)`);
  let bytes: Buffer;
  try {
    bytes = Buffer.from(String(m[3] ?? ""), "base64");
  } catch {
    throw new Error("录音 base64 解码失败");
  }
  if (!bytes.length) throw new Error("录音数据为空");
  if (bytes.length > MAX_AUDIO_BYTES) {
    throw new Error(`录音过大(${(bytes.length / 1024 / 1024).toFixed(1)}MB > 8MB 上限)`);
  }
  return { bytes, format, mime };
}

export type VoiceSegment = { at: string; text: string };
export type VoiceTranscript = { text: string; segments: VoiceSegment[] };

/** 从模型返回体里取出内容(兼容 {choices:[{message:{content}}]} 与直接给字符串/对象两种形态)。
 *  voice-draft.ts(聊天窗语音任务书)复用同一抽取逻辑,故导出。 */
export function extractContent(raw: unknown): unknown {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const choices = (raw as { choices?: { message?: { content?: unknown }; text?: unknown }[] }).choices;
    if (Array.isArray(choices) && choices.length) {
      const content = choices[0]?.message?.content ?? choices[0]?.text;
      if (typeof content === "string") return content;
      if (content && typeof content === "object") return content;
      // 部分端点把内容放在 content 数组里:取 text 片段拼接
      if (Array.isArray(content)) {
        const joined = content
          .map((c) => (c && typeof c === "object" ? String((c as { text?: unknown }).text ?? "") : ""))
          .join("");
        if (joined) return joined;
      }
    }
    return raw;
  }
  return undefined;
}

/** 去掉可能的 ```json 围栏。 */
function stripFence(text: string): string {
  const m = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  return m ? String(m[1] ?? "") : text;
}

function normalizeSegments(value: unknown): VoiceSegment[] {
  if (!Array.isArray(value)) return [];
  const out: VoiceSegment[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const seg = item as { at?: unknown; time?: unknown; text?: unknown };
    const text = String(seg.text ?? "").trim();
    if (!text) continue;
    const at = String(seg.at ?? seg.time ?? "").trim();
    out.push({ at, text });
  }
  return out;
}

/**
 * 解析转写结果:优先 JSON(`{segments:[{time|at,text}]}` 或 `{text}`),
 * 非 JSON 时整段当文本、segments 为空。空结果抛可读错(调用方记 voiceError)。
 */
export function parseVoiceTranscript(raw: unknown): VoiceTranscript {
  const content = extractContent(raw);
  if (content === undefined || content === null) throw new Error("录音转写返回为空");
  if (typeof content === "object") {
    const obj = content as { text?: unknown; segments?: unknown };
    const segments = normalizeSegments(obj.segments);
    const text = String(obj.text ?? segments.map((s) => s.text).join("\n")).trim();
    if (!text) throw new Error("录音转写返回为空");
    return { text, segments };
  }
  const text = stripFence(String(content)).trim();
  if (!text) throw new Error("录音转写返回为空");
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as { text?: unknown; segments?: unknown };
      const segments = normalizeSegments(obj.segments);
      const merged = String(obj.text ?? segments.map((s) => s.text).join("\n")).trim();
      if (merged) return { text: merged, segments };
    }
  } catch {
    /* 非 JSON:整段作文本 */
  }
  return { text, segments: [] };
}

/** 转写提示词:逐字、分行、标部位、不编造、不总结成指令。 */
export const VOICE_TRANSCRIBE_PROMPT = [
  "你在帮助工程师理解用户对一张界面截图的口头评论。请把这段录音**逐字转写**成文字。",
  "要求:",
  "1. 逐字记录用户说的话,保留口语与语气,不要改写、不要润色、不要总结成任务指令;",
  "2. 按语义分行(每个意思一段),每行前面标出用户提到的大致部位,格式如「[左上]」「[按钮区]」「[中部列表]」——部位只能来自用户自己的说法或明显的指示词,拿不准就写「[未指明]」;",
  "3. 听不清的地方写「[听不清]」,绝不编造内容;",
  "4. 只输出转写结果本身,不要解释、不要加前后缀。",
].join("\n");

export type VoiceParser = (bytes: Buffer, mime: string) => Promise<VoiceTranscript>;

/** 录音转写的缺省模型(生产口径:qwen3.8-omni-flash,支持 input_audio 的 OpenAI 兼容端点)。 */
export const VOICE_PARSE_MODEL = "qwen3.8-omni-flash";
/** 缺省凭证引用名(值存 .genie/secrets.json 或同名 env;与 coding 轨同源不新造)。 */
export const VOICE_PARSE_API_KEY_ENV = "GENIE_LLM_API_KEY";

export type VoiceParserOptions = {
  /** OpenAI 兼容端点(已含 /v1 或不含都可,内部归一)。 */
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/** 从 model 返回体里抽取可读错误摘要(截断 200 字,避免日志被整页 HTML 淹没)。 */
function briefBody(text: string): string {
  const one = String(text ?? "").replace(/\s+/g, " ").trim();
  return one.length > 200 ? one.slice(0, 200) + "…" : one;
}

/**
 * 造一个转写器:POST `${baseUrl}/v1/chat/completions`(baseUrl 自带 /v1 时不重复拼,
 * 归一逻辑与 packages/harness-runtime/src/agent/openai-provider.ts:279 chatCompletionsUrl 一致),
 * messages 里塞 `input_audio`(base64+format)。超时/HTTP 错抛可读 Error。
 */
export function createVoiceParser(opts: VoiceParserOptions): VoiceParser {
  const apiKey = String(opts.apiKey ?? "").trim();
  if (!apiKey) throw new Error("录音解析缺少 API Key(配置 annotate.voiceParse.apiKeyEnv 或写入 .genie/secrets.json)");
  if (!opts.baseUrl) throw new Error("录音解析缺少端点(annotate.voiceParse.baseUrl)");
  if (!opts.model) throw new Error("录音解析缺少模型(annotate.voiceParse.model)");
  const url = chatCompletionsUrl(opts.baseUrl);
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : VOICE_PARSE_TIMEOUT_MS;
  const doFetch: typeof fetch = opts.fetchImpl ?? fetch;

  return async (bytes: Buffer, mime: string): Promise<VoiceTranscript> => {
    const format = FORMAT_BY_MIME[String(mime ?? "").toLowerCase()] ?? "webm";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: opts.model,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: VOICE_TRANSCRIBE_PROMPT },
              // DashScope qwen-omni 系的 input_audio.data 要 Data URI 形态(data:;base64,xxx):
              // 裸 base64 实测 400「The provided URL does not appear to be valid」(2026-11-08 产线实锚,
              // 与 voice-draft.ts 同源修复)。
              { type: "input_audio", input_audio: { data: "data:;base64," + bytes.toString("base64"), format } },
            ],
          }],
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`录音解析超时(${Math.round(timeoutMs / 1000)}s)`);
      throw new Error(`录音解析请求失败:${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      let body = "";
      try { body = await res.text(); } catch { body = ""; }
      throw new Error(`录音解析失败:HTTP ${res.status} ${briefBody(body)}`.trim());
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new Error("录音解析响应不是合法 JSON");
    }
    return parseVoiceTranscript(data);
  };
}
