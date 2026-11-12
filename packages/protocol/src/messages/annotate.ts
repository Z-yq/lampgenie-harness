/**
 * 截图标注域消息(面板自有能力)+ 聊天窗语音任务书(voice.draft)。
 * 自 index.ts(2941 行)按域拆分,逐字搬移。
 */
import { z } from "zod";
import { Envelope } from "./core.js";
// [CROSS-IMPORTS]
// ---- 截图标注(面板自有能力) ----
// 链路:composer 按钮→getDisplayMedia 取屏→画框裁剪→面板标注编辑器(框/点/全局
// 三类编号批注)→ annotate.submit →服务端落盘 <项目>/.genie/feedback/ +构造
// feedback-minimal-4 兼容 JSON +组装 instruction → task.submit(忙则入队)。
// 几何/JSON 构造在服务端(apps/gateway/src/annotate.ts,可单测),面板只交原始批注。
export const AnnotateNoteZ = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("region"),
 /** 图像像素坐标(左上原点;服务端负责取整/夹边,x2≥x1+1)。 */
    source: z.object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() }),
 /** 布局意图(组件拆移):rect=搬动后的最终区域;服务端换算 movement{rect,dx,dy,scaleX?,scaleY?}。 */
    movement: z.object({ rect: z.object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() }) }).optional(),
 /** 随组件搬动的子批注(框选,坐标在最终画面;输出为 feedback children,编号全局连续)。 */
    children: z.array(z.object({
      source: z.object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() }),
      text: z.string().min(1).max(10000),
    })).max(1000).optional(),
 /** 有 movement 时允许空文本(纯布局意图,annotations 留空);无 movement 必填。 */
    text: z.string().max(10000),
  }),
  z.object({
    kind: z.literal("point"),
    point: z.object({ x: z.number(), y: z.number() }),
    text: z.string().min(1).max(10000),
  }),
  z.object({ kind: z.literal("global"), text: z.string().min(1).max(10000) }),
]);
export const AnnotateSubmit = Envelope.extend({
  type: z.literal("annotate.submit"),
 /** 目标会话(反馈作为该会话的追问/新任务投递;项目归属复用 task.submit 决议)。 */
  sessionId: z.string().min(1),
 /** 面板裁剪后的截图(image/png dataURL;尺寸/哈希由服务端从字节经验证)。 */
  dataUrl: z.string().min(1),
  notes: z.array(AnnotateNoteZ).min(1).max(1000),
 /** 带编号标记的预览图(image/jpeg dataURL;服务端校验尺寸与原图一致后随反馈落盘)。 */
  previewDataUrl: z.string().min(1).optional(),
 /** 采集上下文(截图=screen,导入=file+fileName;capturedAt 为带时区 ISO)。 */
  capture: z.object({
    source: z.enum(["screen", "file"]),
    capturedAt: z.string().min(1),
    fileName: z.string().max(255).optional(),
  }).optional(),
 /** 页面说明(≤500 字符,显示在反馈 capture.page,帮 agent 定位截图所在页面)。 */
  pageContext: z.string().max(500).optional(),
 /** 录音批注(dataURL,`data:audio/webm;codecs=opus;base64,...`;服务端转写为文字并入任务书)。
 * 语义上限 8MB 由服务端校验(这里只做形态校验:必须是 audio/* 的 dataURL)。 */
  audioUrl: z.string().min(1).regex(/^data:audio\/[^;,]+(?:;codecs=[^;,]+)?;base64,/).optional(),
});
export const AnnotateResult = Envelope.extend({
  type: z.literal("annotate.result"),
  ok: z.boolean(),
 /** ok=true:投递目标任务(新任务或入队项所属会话)。 */
  taskId: z.string().optional(),
  queued: z.boolean().optional(),
  imagePath: z.string().optional(),
  feedbackPath: z.string().optional(),
 /** ok=true 且带预览时回带(全 global 批注无预览则缺省)。 */
  previewPath: z.string().optional(),
 /** 任务书是否经小模型整理(refine);缺省/false=回落模板任务书。 */
  refined: z.boolean().optional(),
 /** 录音已保留的音频文件路径(转写失败时音频仍在盘上,便于回听)。 */
  voicePath: z.string().optional(),
 /** 录音转写失败原因(fail-soft:不影响提交,任务书里会注明)。 */
  voiceError: z.string().optional(),
  message: z.string().optional(),
});

// ---- 录屏批注----
// 链路:编辑器「● 录屏批注」→ getDisplayMedia(屏幕)+ getUserMedia(麦克风)→ 离屏 canvas
// 合成(视频帧+笔迹,12fps)→ MediaRecorder 出 webm → annotate.record → 服务端落盘
// <项目>/.genie/feedback/ → omni(qwen3.8-omni-flash)解析(音频转写+关键帧)→ 任务书投递。
export const AnnotateStrokeZ = z.object({
  kind: z.enum(["pen", "rect"]),
 /** 相对录制开始的毫秒偏移。 */
  t: z.number().min(0).max(300000),
  x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(),
 /** kind=pen 的采样点(≤4000;x1/y1..x2/y2 是其外接框)。 */
  points: z.array(z.object({ x: z.number(), y: z.number() })).max(4000).optional(),
});
export const AnnotateRecord = Envelope.extend({
  type: z.literal("annotate.record"),
  sessionId: z.string().min(1),
 /** 合成后的录屏(webm dataURL;服务端限 12MB)。 */
  videoUrl: z.string().min(1).regex(/^data:video\/webm(?:;codecs=[^;,]+)?;base64,/),
 /** 麦克风独立音轨(omni 转写用;合成轨里的音频端点不保证能解码)。 */
  audioUrl: z.string().min(1).regex(/^data:audio\/[^;,]+(?:;codecs=[^;,]+)?;base64,/).optional(),
 /** 停止时抽取的关键帧(image/jpeg dataURL,≤4 张),供多模态模型看画面。 */
  keyframes: z.array(z.string().regex(/^data:image\/jpeg;base64,/)).max(4).optional(),
  strokes: z.array(AnnotateStrokeZ).max(2000).optional(),
  durationMs: z.number().min(0).max(300000),
  pageContext: z.string().max(500).optional(),
  capture: z.object({
    source: z.enum(["screen", "file"]),
    capturedAt: z.string().min(1),
    fileName: z.string().max(255).optional(),
  }).optional(),
});
export const AnnotateRecordResult = Envelope.extend({
  type: z.literal("annotate.record.result"),
  ok: z.boolean(),
  taskId: z.string().optional(),
  queued: z.boolean().optional(),
  videoPath: z.string().optional(),
  audioPath: z.string().optional(),
  feedbackPath: z.string().optional(),
 /** 任务书是否经 omni 整理;缺省/false=模板回落。 */
  refined: z.boolean().optional(),
 /** omni 解析失败原因(fail-soft:视频已落盘,任务书里会注明)。 */
  parseError: z.string().optional(),
  message: z.string().optional(),
});

// ---- 聊天窗语音任务书----
// 链路:composer 🎤 按钮→MediaRecorder 录音(dataURL)→ voice.draft →服务端用 coding.models.voice
// 角色模型(qwen3.8-omni-flash 形态的 OpenAI 兼容端点)把口述整理成任务书 → voice.draft.result
// →面板把任务书文本回填聊天输入区(用户确认后自己发送)。撰写期间按 sessionId 加输入锁:
// 同会话禁止输入,切到别的会话不受影响(锁是纯客户端 per-session 状态)。
export const VoiceDraft = Envelope.extend({
  type: z.literal("voice.draft"),
 /** 锁定/回填目标会话(草稿态="";服务端不依赖它做状态,只透传回包)。 */
  sessionId: z.string(),
 /** 录音 dataURL(`data:audio/webm;codecs=opus;base64,...`;8MB/形态校验在服务端 annotate-voice 同源)。 */
  audioUrl: z.string().min(1).regex(/^data:audio\/[^;,]+(?:;codecs=[^;,]+)?;base64,/),
 /** 输入区已有文字草稿(口述与文字合并成同一份任务书,不丢用户写下的内容)。 */
  draftText: z.string().max(20000).optional(),
});
export const VoiceDraftResult = Envelope.extend({
  type: z.literal("voice.draft.result"),
 /** 原样回带请求的 sessionId(面板按它解锁+回填)。 */
  sessionId: z.string(),
  ok: z.boolean(),
 /** ok=true:任务书全文(回填输入区)。 */
  text: z.string().optional(),
 /** ok=false:可操作错误(含「未配置 coding.models.voice」指路)。 */
  message: z.string().optional(),
});
