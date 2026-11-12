/**
 * 录屏批注——服务端纯逻辑。
 * 链路:面板「● 录屏批注」把 屏幕帧+笔迹 合成 webm(含独立麦克风音轨),
 * 以 annotate.record 上行 → 本模块落盘 <项目>/.genie/feedback/ → 交给
 * qwen3.8-omni-flash 解析(音频逐字转写 + 关键帧看画面 + 笔迹时间轴)→
 * 组装任务书 → task.submit(忙则入队)。
 * 与 annotate.ts 同风格:依赖注入、fail-soft(解析失败不阻塞投递,视频照常落盘),
 * fetch 可注入便于单测。
 */
import { createHash } from "node:crypto";
import { ANNOTATE_DIR, type AnnotateCapture, normalizeCapture, normalizePageContext } from "./annotate.js";
import { chatCompletionsUrl } from "@lampgenie/runtime/agent/openai-provider";
import { extractContent, parseAudioDataUrl } from "./annotate-voice.js";

/** 视频上限 12MB(dataURL 会再膨胀 4/3;ws 默认 maxPayload 100MB,但单帧过大拖垮面板)。 */
export const MAX_VIDEO_BYTES = 12 * 1024 * 1024;
/** 录制时长上限(与面板一致)。 */
export const MAX_RECORD_MS = 120_000;
/** omni 解析超时:带关键帧的整段理解比纯转写慢,给 60s。 */
export const RECORD_PARSE_TIMEOUT_MS = 60_000;
/** 缺省模型(与录音转写同源)。 */
export const RECORD_PARSE_MODEL = "qwen3.8-omni-flash";

export type RecordStroke = {
  kind: "pen" | "rect";
  t: number;
  x1: number; y1: number; x2: number; y2: number;
  points?: { x: number; y: number }[];
};

export type ParsedVideo = { bytes: Buffer; mime: string };

/** 解析 `data:video/webm...;base64,...`;形态错/超限抛可读错。 */
export function parseVideoDataUrl(dataUrl: string): ParsedVideo {
  const raw = String(dataUrl ?? "");
  const m = /^data:(video\/webm)(?:;codecs=[^;,]+)?;base64,(.*)$/s.exec(raw);
  if (!m) throw new Error("录屏数据不是 video/webm 的 dataURL");
  let bytes: Buffer;
  try {
    bytes = Buffer.from(String(m[2] ?? ""), "base64");
  } catch {
    throw new Error("录屏 base64 解码失败");
  }
  if (!bytes.length) throw new Error("录屏数据为空");
  if (bytes.length > MAX_VIDEO_BYTES) {
    throw new Error(`录屏过大(${(bytes.length / 1024 / 1024).toFixed(1)}MB > ${MAX_VIDEO_BYTES / 1024 / 1024}MB 上限)`);
  }
  return { bytes, mime: m[1] ?? "video/webm" };
}

/** 解析关键帧 `data:image/jpeg;base64,...`(最多 4 张,单张 ≤2MB)。 */
export function parseKeyframes(list: string[] | undefined): Buffer[] {
  if (!list || !list.length) return [];
  const out: Buffer[] = [];
  for (const item of list.slice(0, 4)) {
    const m = /^data:image\/jpeg;base64,(.*)$/s.exec(String(item ?? ""));
    if (!m) continue;
    const bytes = Buffer.from(String(m[1] ?? ""), "base64");
    if (bytes.length && bytes.length <= 2 * 1024 * 1024) out.push(bytes);
  }
  return out;
}

function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * 笔迹 → 可读时间轴(给模型和任务书看:第几秒在哪个区域画了什么)。
 * 纯函数,单测直接断言。
 */
export function strokeTimeline(strokes: RecordStroke[], durationMs: number): string {
  if (!strokes || !strokes.length) return "";
  const lines: string[] = [];
  const sorted = strokes.slice().sort((a, b) => a.t - b.t).slice(0, 200);
  for (const s of sorted) {
    const at = fmtClock(s.t);
    const x1 = Math.round(Math.min(s.x1, s.x2)), y1 = Math.round(Math.min(s.y1, s.y2));
    const x2 = Math.round(Math.max(s.x1, s.x2)), y2 = Math.round(Math.max(s.y1, s.y2));
    if (s.kind === "rect") lines.push(`${at} 框选 (${x1},${y1}) → (${x2},${y2})`);
    else {
      const n = s.points?.length ?? 0;
      lines.push(`${at} 手绘 ${n ? `${n} 点 ` : ""}区域 (${x1},${y1}) → (${x2},${y2})`);
    }
  }
  return `时长 ${fmtClock(durationMs)}\n${lines.join("\n")}`;
}

/** omni 解析提示词:逐字转写 + 结合关键帧与笔迹时间轴写成可执行任务书。 */
export const RECORD_PARSE_PROMPT = [
  "你在帮助工程师理解用户对一段界面录像的口头批注。输入包含:一段录音、若干关键帧截图、以及用户画在画面上的笔迹时间轴。",
  "请输出结构化任务书,格式:",
  "## 用户意图(一句话)",
  "## 问题清单(按时间顺序;每条写「部位 + 现象 + 期望」,部位来自笔迹时间轴或关键帧里能看到的区域)",
  "## 笔迹记录(逐条复述时间轴里的框选/手绘区域,并说明该处用户说了什么)",
  "## 待确认(信息不足才写,没有写「无」)",
  "要求:只依据输入内容,不编造界面细节;听不清的写「[听不清]」;不要输出多余解释。",
].join("\n");

export type RecordParseInput = {
  audio?: { bytes: Buffer; mime: string };
  keyframes: Buffer[];
  timeline: string;
  durationMs: number;
  pageContext?: string;
};

export type RecordParse = { taskBook: string; transcript: string };

/** 从模型返回体取任务书正文(兼容 choices[].message.content 与裸字符串)。 */
export function parseRecordContent(raw: unknown): RecordParse {
  const content = extractContent(raw);
  if (content === undefined || content === null) throw new Error("录屏解析返回为空");
  const text = typeof content === "string"
    ? content
    : typeof content === "object" && (content as { text?: unknown }).text !== undefined
      ? String((content as { text?: unknown }).text)
      : JSON.stringify(content);
  const trimmed = text.trim().replace(/^\s*```(?:markdown|md)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  if (!trimmed) throw new Error("录屏解析返回为空");
  return { taskBook: trimmed, transcript: trimmed };
}

export type RecordParser = (input: RecordParseInput) => Promise<RecordParse>;

export type RecordParserOptions = {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/**
 * 造一个录屏解析器:OpenAI 兼容 /chat/completions,content 里塞
 * input_audio(音频)+ image_url(关键帧 base64)+ text(提示词与时间轴)。
 * 端点不支持图片时由调用方 fail-soft 回落模板任务书。
 */
export function createRecordParser(opts: RecordParserOptions): RecordParser {
  const apiKey = String(opts.apiKey ?? "").trim();
  if (!apiKey) throw new Error("录屏解析缺少 API Key(配置 annotate.videoParse.apiKeyEnv 或写入 .genie/secrets.json)");
  if (!opts.baseUrl) throw new Error("录屏解析缺少端点(annotate.videoParse.baseUrl)");
  if (!opts.model) throw new Error("录屏解析缺少模型(annotate.videoParse.model)");
  const url = chatCompletionsUrl(opts.baseUrl);
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : RECORD_PARSE_TIMEOUT_MS;
  const doFetch: typeof fetch = opts.fetchImpl ?? fetch;

  return async (input: RecordParseInput): Promise<RecordParse> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const content: unknown[] = [
      { type: "text", text: RECORD_PARSE_PROMPT },
      { type: "text", text: `【笔迹时间轴】\n${input.timeline || "(无笔迹)"}${input.pageContext ? `\n【页面说明】${input.pageContext}` : ""}` },
    ];
    if (input.audio) {
 // DashScope qwen-omni:input_audio.data 需 Data URI 形态(与 annotate-voice 同源)。
      content.push({ type: "input_audio", input_audio: { data: "data:;base64," + input.audio.bytes.toString("base64"), format: "webm" } });
    }
    for (const frame of input.keyframes) {
      content.push({ type: "image_url", image_url: { url: "data:image/jpeg;base64," + frame.toString("base64") } });
    }
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: opts.model, messages: [{ role: "user", content }] }),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`录屏解析超时(${Math.round(timeoutMs / 1000)}s)`);
      throw new Error(`录屏解析请求失败:${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      let body = "";
      try { body = await res.text(); } catch { body = ""; }
      const brief = String(body).replace(/\s+/g, " ").slice(0, 200);
      throw new Error(`录屏解析失败:HTTP ${res.status} ${brief}`.trim());
    }
    let data: unknown;
    try { data = await res.json(); } catch { throw new Error("录屏解析响应不是合法 JSON"); }
    return parseRecordContent(data);
  };
}

export type RecordPaths = {
  dir: string;
  stem: string;
  videoPath: string;
  audioPath: string;
  jsonPath: string;
  videoFile: string;
  audioFile: string;
};

export function recordPaths(root: string, now = new Date(), rand = Math.random().toString(36).slice(2, 8)): RecordPaths {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stem = `record-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${rand}`;
  const dir = `${root.replace(/[\\/]+$/, "")}/${ANNOTATE_DIR}`;
  return { dir, stem, videoPath: `${dir}/${stem}.webm`, audioPath: `${dir}/${stem}.audio.webm`, jsonPath: `${dir}/${stem}.record.json`, videoFile: `${stem}.webm`, audioFile: `${stem}.audio.webm` };
}

export type RecordAttachment = { name: string; path: string; mime?: string; size?: number };

export type RecordDeps = {
  projects: { list(): { id: string; path: string }[]; resolveWorkdir(id: string): string };
  tm: { list(): { sessionId: string; state: string }[]; submit(role: string, sessionId: string, instruction: string, extra?: { projectId?: string; attachments?: RecordAttachment[] }): { id: string } };
  journal: { append(entry: { kind: string; sessionId: string; payload: unknown }): void };
  queueApi?: { enqueue(msg: { sessionId: string; instruction: string; projectId?: string; attachments?: RecordAttachment[] }): unknown };
  parser?: { parse: RecordParser; model?: string };
  prepareAttachments?: (info: { sessionId: string; videoPath: string; feedbackPath: string; audioPath?: string }) => RecordAttachment[] | undefined;
  remotePrefix?: string;
};

export type RecordMsg = {
  sessionId: string;
  videoUrl: string;
  audioUrl?: string;
  keyframes?: string[];
  strokes?: RecordStroke[];
  durationMs: number;
  pageContext?: string;
  capture?: AnnotateCapture;
  projectId?: string;
};

export type RecordOutcome = {
  ok: boolean;
  taskId?: string;
  queued?: boolean;
  videoPath?: string;
  audioPath?: string;
  feedbackPath?: string;
  refined?: boolean;
  parseError?: string;
  message?: string;
};

const REMOTE_PREFIX = "remote://";

type IO = { mkdirSync(p: string, o: { recursive: boolean }): void; existsSync(p: string): boolean; writeFileSync(p: string, d: Buffer | string, enc?: "utf8"): void };

/** 模板回落任务书(omni 未配置/失败时仍能投递,视频与时间轴可人工对照)。 */
export function buildRecordInstruction(videoPath: string, feedbackPath: string, timeline: string, pageContext?: string): string {
  const lines = [
    "用户录制了一段带笔迹的屏幕批注(录屏 + 语音 + 手绘),请按批注修改界面。",
    `- 录屏(可回放):${videoPath}`,
    `- 笔迹与时间轴 JSON:${feedbackPath}`,
    pageContext ? `- 页面说明:${pageContext}` : "",
    timeline ? `\n【笔迹时间轴】\n${timeline}` : "",
    "\n注:本次任务书未经 LLM 整理;录像已落盘,可据此理解用户指的位置与意图。",
  ];
  return lines.filter(Boolean).join("\n");
}

/** 主流程:解析/落盘/解析任务书/投递。fail-soft:omni 失败只记 parseError。 */
export async function processAnnotateRecord(deps: RecordDeps, msg: RecordMsg, io: IO): Promise<RecordOutcome> {
  try {
    return await processInner(deps, msg, io);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "录屏批注提交失败" };
  }
}

async function processInner(deps: RecordDeps, msg: RecordMsg, io: IO): Promise<RecordOutcome> {
  if (msg.projectId === undefined) return { ok: false, message: "请先添加并选择一个本地项目,再发送录屏批注" };
  const remotePrefix = deps.remotePrefix ?? REMOTE_PREFIX;
  const entry = deps.projects.list().find((p) => p.id === msg.projectId);
  if (entry && String(entry.path).startsWith(remotePrefix)) return { ok: false, message: "远程项目暂不支持录屏批注(反馈文件需要本地落盘)" };
  if (!Number.isFinite(msg.durationMs) || msg.durationMs > MAX_RECORD_MS + 5_000) return { ok: false, message: "录制时长超出上限(120s)" };
  const video = parseVideoDataUrl(msg.videoUrl);
  const audio = msg.audioUrl ? parseAudioDataUrl(msg.audioUrl) : undefined;
  const keyframes = parseKeyframes(msg.keyframes);
  const strokes = (msg.strokes ?? []).map((s) => ({ ...s, t: Math.max(0, Number(s.t) || 0) }));
  const timeline = strokeTimeline(strokes, msg.durationMs);
  const page = normalizePageContext(msg.pageContext);
  const capture = msg.capture ? normalizeCapture(msg.capture) : { source: "screen" as const, capturedAt: new Date().toISOString() };
  const root = deps.projects.resolveWorkdir(msg.projectId);
  const paths = recordPaths(root);
  io.mkdirSync(paths.dir, { recursive: true });
  if (io.existsSync(paths.videoPath) || io.existsSync(paths.jsonPath)) return { ok: false, message: "落盘路径冲突,请重试" };
  io.writeFileSync(paths.videoPath, video.bytes);
  if (audio) io.writeFileSync(paths.audioPath, audio.bytes);
  const feedback = {
    schemaVersion: "record-minimal-1",
    tool: { name: "LampGenie", version: "0.1.0" },
    capture: { ...capture, ...(page ? { page, pageSource: "agent" as const } : {}) },
    durationMs: msg.durationMs,
    video: { file: paths.videoFile, sha256: createHash("sha256").update(video.bytes).digest("hex"), bytes: video.bytes.length },
    ...(audio ? { audio: { file: paths.audioFile, bytes: audio.bytes.length } } : {}),
    strokes,
    timeline,
    keyframes: keyframes.length,
  };
  io.writeFileSync(paths.jsonPath, JSON.stringify(feedback, null, 2) + "\n", "utf8");

  let parsed: RecordParse | undefined;
  let parseError: string | undefined;
  if (!deps.parser) parseError = "录屏解析未配置(缺凭证或 annotate.videoParse.baseUrl)";
  else {
    const started = Date.now();
    try {
      parsed = await deps.parser.parse({ audio: audio ? { bytes: audio.bytes, mime: audio.mime } : undefined, keyframes, timeline, durationMs: msg.durationMs, ...(page ? { pageContext: page } : {}) });
    } catch (err) {
      parseError = err instanceof Error ? err.message : "录屏解析失败";
    }
    deps.journal.append({
      kind: "custom", sessionId: msg.sessionId,
      payload: { type: "annotate.record.parse", ...(deps.parser.model ? { model: deps.parser.model } : {}), ms: Date.now() - started, chars: parsed?.taskBook.length ?? 0, ok: parseError === undefined, ...(parseError ? { reason: parseError } : {}) },
    });
  }
  let instruction: string;
  if (parsed) instruction = `${parsed.taskBook}\n\n(录屏与笔迹时间轴已落盘:${paths.videoPath} / ${paths.jsonPath})`;
  else {
    instruction = buildRecordInstruction(paths.videoPath, paths.jsonPath, timeline, page);
    if (parseError) instruction += `\n(注:录屏解析失败:${parseError})`;
  }
  deps.journal.append({
    kind: "custom", sessionId: msg.sessionId,
    payload: { type: "annotate.record", projectId: msg.projectId, videoPath: paths.videoPath, ...(audio ? { audioPath: paths.audioPath } : {}), feedbackPath: paths.jsonPath, refined: !!parsed, strokes: strokes.length, durationMs: msg.durationMs },
  });
  let attachments: RecordAttachment[] | undefined;
  if (deps.prepareAttachments) {
    try {
      attachments = deps.prepareAttachments({ sessionId: msg.sessionId, videoPath: paths.videoPath, feedbackPath: paths.jsonPath, ...(audio ? { audioPath: paths.audioPath } : {}) });
    } catch { attachments = undefined; /* 附件复制失败不阻塞投递 */ }
  }
  const busy = deps.tm.list().some((t) => t.sessionId === msg.sessionId && (t.state === "queued" || t.state === "running" || t.state === "blocked"));
  const base = { ok: true as const, videoPath: paths.videoPath, ...(audio ? { audioPath: paths.audioPath } : {}), feedbackPath: paths.jsonPath, refined: !!parsed, ...(parseError ? { parseError } : {}) };
  if (deps.queueApi && busy) {
    deps.queueApi.enqueue({ sessionId: msg.sessionId, instruction, projectId: msg.projectId, ...(attachments && attachments.length ? { attachments } : {}) });
    return { ...base, queued: true };
  }
  const task = deps.tm.submit("user", msg.sessionId, instruction, { projectId: msg.projectId, ...(attachments && attachments.length ? { attachments } : {}) });
  return { ...base, taskId: task.id, queued: false };
}
