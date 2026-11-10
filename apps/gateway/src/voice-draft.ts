/**
 * 聊天窗语音任务书:录音 → coding.models.voice 角色模型(qwen3.8-omni-flash 形态
 * 的 OpenAI 兼容端点,支持 input_audio)→ 任务书文本。
 * 与 annotate-voice.ts(逐字转写)同源但提示词不同:那里是「逐字记录不许改写」,
 * 这里是「听懂 + 结合项目/已有草稿整理成一份可执行任务书」——单次 omni 调用直接产出,
 * 不做两段式(先转写再撰写)。
 * 音频形态解析/上限复用 annotate-voice 的 parseAudioDataUrl(同一套 audio/* 白名单与 8MB 上限);
 * 返回体抽取复用 extractContent。纯函数 + 可注入 fetch,便于单测(mock fetch 覆盖段落/超时/HTTP 错)。
 */
import { chatCompletionsUrl } from "@lampgenie/runtime/agent/openai-provider";
import { extractContent, type AudioPayload } from "./annotate-voice.js";

/** 撰写默认超时:omni 整段听音+生成通常 5~30s;长录音(120s 上限)放宽到 120s。 */
export const VOICE_DRAFT_TIMEOUT_MS = 120_000;

export type VoiceDraftContext = {
  /** 会话 owner 项目显示名(服务端从项目注册表解析;解析不出=不带,不硬造)。 */
  projectName?: string;
  /** 输入区已有文字草稿(口述与文字合并成同一份任务书,不丢用户写下的内容)。 */
  draftText?: string;
};

/**
 * 撰写提示词:口述→任务书。
 * 纪律:只输出任务书本身;不编造;拿不准进「待确认」;已有草稿内容必须并入不丢失。
 */
export function buildVoiceDraftPrompt(ctx: VoiceDraftContext): string {
  const lines: string[] = [
    "你在为一个 vibe coding 工作台把用户的口述整理成一份「任务书」。这段录音是用户对着聊天窗说的话,",
    "可能口语化、跳跃、带语气词、说到一半改口——请听懂真实意图,而不是逐字抄写。",
  ];
  if (ctx.projectName) {
    lines.push(`任务所属项目:「${ctx.projectName}」。要求里的措辞尽量贴合这个项目的语境。`);
  }
  if (ctx.draftText && ctx.draftText.trim()) {
    lines.push(
      "用户在输入框里已经写了以下文字(可能与口述重复或互补),把它和口述合并成同一份任务书,不许丢掉用户写下的内容:",
      "【已有文字开始】",
      ctx.draftText.trim(),
      "【已有文字结束】",
    );
  }
  lines.push(
    "请输出一份结构清晰的任务书,包含以下小节(用户没提到的节直接省略,不要写「无」):",
    "1. 目标:一两句话说清楚要做什么、做成什么样;",
    "2. 具体要求:编号列表,每条具体、可执行、可验证;口述里的每个要点都要落到条目上,不许遗漏;",
    "3. 验收标准:怎么算做完了(可观察的结果,不是过程);",
    "4. 约束与注意:用户提到的限制、偏好、不要动的东西;",
    "5. 待确认:口述里含糊、有歧义或互相冲突、需要用户拍板的点(逐条列出;没有就省略这一节)。",
    "纪律:",
    "- 不编造用户没说的细节;听不清/没说清的宁可放进「待确认」,不要臆测补全;",
    "- 不输出与任务书无关的内容:不要解释你做了什么、不要问候语、不要前后缀;",
    "- 用简体中文,纯文本轻排版(小节标题+编号列表),不要 Markdown 代码块包裹。",
  );
  return lines.join("\n");
}

export type VoiceDrafter = (audio: AudioPayload, ctx: VoiceDraftContext) => Promise<string>;

export type VoiceDrafterOptions = {
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

/** 从返回体取任务书文本:choices 内容、对象包裹({text}/{content:{text}})、分段数组都拍平;空=可读错。 */
function draftTextOf(raw: unknown): string {
  const content = extractContent(raw);
  let text = "";
  if (typeof content === "string") text = content;
  else if (content && typeof content === "object") {
    const obj = content as { text?: unknown; content?: unknown };
    const inner = obj.text !== undefined ? obj.text : obj.content;
    if (typeof inner === "string") text = inner;
    else if (Array.isArray(inner)) {
      // 分段数组(content[{text}]):取 text 片段拼接
      text = inner.map((c) => (c && typeof c === "object" ? String((c as { text?: unknown }).text ?? "") : String(c ?? ""))).join("");
    } else if (inner && typeof inner === "object") {
      text = String((inner as { text?: unknown }).text ?? "");
    }
  }
  const out = text.replace(/^\s*```(?:markdown|md)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  if (!out) throw new Error("任务书撰写返回为空");
  return out;
}

/**
 * 造一个任务书撰写器:POST `${baseUrl}/v1/chat/completions`(baseUrl 自带 /v1 时不重复拼,
 * 归一逻辑与 annotate-voice 同一 chatCompletionsUrl),messages 塞 `input_audio`(base64+format)
 * + 撰写提示词。超时/HTTP 错抛可读 Error。
 */
export function createVoiceDrafter(opts: VoiceDrafterOptions): VoiceDrafter {
  const apiKey = String(opts.apiKey ?? "").trim();
  if (!apiKey) throw new Error("语音任务书缺少 API Key(coding.models.voice 未解析到凭证)");
  if (!opts.baseUrl) throw new Error("语音任务书缺少端点(coding.models.voice 未解析到 baseUrl)");
  if (!opts.model) throw new Error("语音任务书缺少模型(coding.models.voice.model 未配置)");
  const url = chatCompletionsUrl(opts.baseUrl);
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : VOICE_DRAFT_TIMEOUT_MS;
  const doFetch: typeof fetch = opts.fetchImpl ?? fetch;

  return async (audio: AudioPayload, ctx: VoiceDraftContext): Promise<string> => {
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
              { type: "text", text: buildVoiceDraftPrompt(ctx) },
              // DashScope qwen-omni 系的 input_audio.data 要 Data URI 形态(data:;base64,xxx):
 // 裸 base64 经验证 400「The provided URL does not appear to be valid」(生产环境验证;
              // 与 OpenAI 标准的裸 base64 不同,是这个端点族的已知差异)。
              { type: "input_audio", input_audio: { data: "data:;base64," + audio.bytes.toString("base64"), format: audio.format } },
            ],
          }],
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`任务书撰写超时(${Math.round(timeoutMs / 1000)}s):录音太长或端点无响应,可稍后再试`);
      throw new Error(`任务书撰写请求失败:${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      let body = "";
      try { body = await res.text(); } catch { body = ""; }
      throw new Error(`任务书撰写失败:HTTP ${res.status} ${briefBody(body)}`.trim());
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new Error("任务书撰写响应不是合法 JSON");
    }
    return draftTextOf(data);
  };
}
