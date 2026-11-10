/**
 * 图片 offload 持久位置(M58,对齐 docs/mechanisms.md #58)。
 *
 * 要治的病:图片密集会话里 provider 直接回 `IMAGE_OFFLOAD_REQUIRED` / 图片尺寸预算类错误,
 * 整个 turn 立即失败(此前 10144px PNG 事故:坏 data URL 已进 journal,每轮重放都撞同一错),
 * 重试白烧 provider 重试预算;历史图片也回不来(derive 每轮重放同一批 data URL)。
 *
 * 本模块是**纯数据变换 + durable 落盘**(不依赖 provider、不改 journal):
 *  1) `isImageBudgetError` 只认图片预算/尺寸类错误(含中文文案),其它错误一律 false;
 *  2) `offloadImages` 按消息顺序、消息内图片顺序把 data URL 落盘到
 *     `<root>/.genie/image-offload/<sessionId>/<sha1>.<ext>`,请求里换成一行占位文本
 *     (`[image offloaded: <绝对路径> (sha1 <前12位>, <bytes>B)]`),占位按普通文本计价。
 *     同 hash 已存在 → 直接复用(durable,不重复写);非法/非白名单 data URL 保留原样并记 skipped。
 *
 * 落盘用「临时文件 + rename」:写一半崩掉不会留下半张图被后续请求当真图读。
 */
import { createHash } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** 占位行前缀(幂等判定与测试共用;正文追加的每一行都以它开头)。 */
export const IMAGE_OFFLOAD_PLACEHOLDER = "[image offloaded:";

/**
 * 图片预算/尺寸类错误文案。刻意只匹配「image|vision 附近出现预算类词」与中文图片过大文案,
 * 避免把 `400 invalid_request` / tool-pairing 当成图片问题吞掉。
 */
const IMAGE_BUDGET_RE =
  /IMAGE_OFFLOAD_REQUIRED|image.{0,20}(budget|limit|too\s+large|dimensions?|pixels?|resolution)|vision.{0,20}(limit|too\s+large)|不支持.*图片|图片.*(过大|尺寸)/i;

/** provider 侧错误码(部分网关只用 code 表达,不给可读文案)。 */
const IMAGE_BUDGET_CODE = "IMAGE_OFFLOAD_REQUIRED";

/** 错误文本收集的递归深度上限(provider 错误对象常带 cause 链,防环)。 */
const TEXT_DEPTH = 4;

function textsOf(input: unknown, depth = 0): string[] {
  if (input === null || input === undefined || depth > TEXT_DEPTH) return [];
  if (typeof input === "string") return [input];
  if (typeof input === "number" || typeof input === "boolean") return [];
  if (input instanceof Error) {
    const e = input as Error & { body?: unknown; detail?: unknown; cause?: unknown };
    return [e.message, ...textsOf(e.body, depth + 1), ...textsOf(e.detail, depth + 1), ...textsOf(e.cause, depth + 1)];
  }
  if (typeof input === "object") {
    const o = input as Record<string, unknown>;
    return [
      ...(typeof o.message === "string" ? [o.message] : []),
      ...textsOf(o.body, depth + 1),
      ...textsOf(o.detail, depth + 1),
      ...textsOf(o.err, depth + 1),
      ...textsOf(o.error, depth + 1),
    ];
  }
  return [];
}

function codesOf(input: unknown, depth = 0): string[] {
  if (input === null || input === undefined || depth > TEXT_DEPTH) return [];
  if (typeof input !== "object") return [];
  const o = input as Record<string, unknown>;
  const out: string[] = [];
  if (typeof o.code === "string") out.push(o.code);
  if (input instanceof Error) out.push(...codesOf((input as Error & { cause?: unknown }).cause, depth + 1));
  out.push(...codesOf(o.err, depth + 1));
  return out;
}

/**
 * 是否「图片预算/尺寸」类错误。接受 Error / 字符串 / `{status, body, detail, err}` 任一种输入
 * (provider 适配层形态不一),非图片错误一律 false。
 */
export function isImageBudgetError(input?: unknown): boolean {
  if (codesOf(input).some((c) => c === IMAGE_BUDGET_CODE)) return true;
  return textsOf(input).some((t) => IMAGE_BUDGET_RE.test(t));
}

/** 可 offload 的最小消息形状(不 import loop 的 Message,避免循环依赖)。 */
export interface OffloadableMessage {
  role: string;
  content: string;
  images?: string[];
}

export interface ImageOffloadOptions {
  /** 仓库根;落盘目录 = `<root>/.genie/image-offload/<sessionId>/`。 */
  root: string;
  sessionId: string;
  /** 子任务标识:只用于临时文件名,不改变最终落盘路径(同 hash 跨任务复用)。 */
  jobId?: string;
}

export interface OffloadedImage {
  /** 落盘后的绝对路径(与占位文本里的路径逐字一致)。 */
  path: string;
  /** 图片字节的 sha1(全量;占位里只放前 12 位)。 */
  sha1: string;
  bytes: number;
  /** 原请求中的定位(消息下标 / 消息内 images 下标),便于排查。 */
  messageIndex: number;
  imageIndex: number;
}

export interface SkippedImage {
  messageIndex: number;
  imageIndex: number;
  /** invalid-data-url(非白名单/非法 base64)| already-offloaded(已是占位)。 */
  reason: string;
}

export interface ImageOffloadResult<M extends OffloadableMessage = OffloadableMessage> {
  /** 新数组(未 offload 任何图片时是**原引用**,调用方可零成本判断)。 */
  messages: M[];
  offloaded: OffloadedImage[];
  /** 保留原样、未落盘的图(不静默删)。 */
  skipped: SkippedImage[];
}

/** 白名单:png/jpeg/webp + base64。 */
const DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/;

/** 路径段消毒(会话 id / jobId 来自外部,防 `../` 越界)。 */
function safeSegment(s: string): string {
  const out = String(s ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/\.{2,}/g, "-") // 折叠连续点:防 ".." 片段混进路径语义
    .slice(0, 120);
  return out && out !== "." && out !== ".." ? out : "unknown";
}

/**
 * durable 写:目标已存在且尺寸相同 → 复用(不重复写);否则临时文件 + rename。
 * 任一步失败向上抛(调用方据此**不重试**,诚实抛原错误)。
 */
async function writeDurable(file: string, buf: Buffer, tag: string): Promise<void> {
  try {
    const st = await stat(file);
    if (st.isFile() && st.size === buf.length) return; // 已落过同一张图:复用
  } catch { /* 不存在 → 往下写 */ }
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${tag}-${Math.random().toString(16).slice(2, 10)}`;
  await writeFile(tmp, buf);
  await rename(tmp, file);
}

/**
 * 把请求里可 offload 的图片落盘、正文换占位文本。**不改 journal/历史**,只返回新 messages。
 *
 * 只处理 `role === "user"` 的 `images[]`(普通用户消息 + view_image 的 `[视觉注入]` 投影消息)——
 * tool 消息本身不带图,图片在 derive 时已投影成后置 user 消息。
 */
export async function offloadImages<M extends OffloadableMessage>(
  messages: M[],
  opts: ImageOffloadOptions,
): Promise<ImageOffloadResult<M>> {
  const skipped: SkippedImage[] = [];
  const offloaded: OffloadedImage[] = [];
  const out = [...messages];
  let changed = false;
  const baseDir = resolve(opts.root, ".genie", "image-offload", safeSegment(opts.sessionId));
  const tag = safeSegment(String(opts.jobId ?? ""));

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const images = Array.isArray(m.images) ? m.images : undefined;
    if (!images?.length) continue;
    const keep: string[] = [];
    const lines: string[] = [];
    for (let j = 0; j < images.length; j++) {
      const img = images[j];
      if (typeof img !== "string" || !img) {
        skipped.push({ messageIndex: i, imageIndex: j, reason: "invalid-data-url" });
        if (typeof img === "string") keep.push(img);
        continue;
      }
      const hit = DATA_URL_RE.exec(img.trim());
      if (!hit) {
        const already = img.includes(IMAGE_OFFLOAD_PLACEHOLDER);
        skipped.push({ messageIndex: i, imageIndex: j, reason: already ? "already-offloaded" : "invalid-data-url" });
        keep.push(img);
        continue;
      }
      const ext = hit[1] === "jpeg" ? "jpg" : hit[1]!;
      const buf = Buffer.from(hit[2]!, "base64");
      if (!buf.length) {
        skipped.push({ messageIndex: i, imageIndex: j, reason: "invalid-data-url" });
        keep.push(img);
        continue;
      }
      const sha1 = createHash("sha1").update(buf).digest("hex");
      const prefix = sha1.slice(0, 12);
      // 幂等:本条正文里已追加过这张图的占位(hash 前 12 位命中)→ 不再落盘、不重复追加。
      if (m.content.includes(IMAGE_OFFLOAD_PLACEHOLDER) && m.content.includes(prefix)) {
        skipped.push({ messageIndex: i, imageIndex: j, reason: "already-offloaded" });
        keep.push(img);
        continue;
      }
      const file = join(baseDir, `${sha1}.${ext}`);
      await writeDurable(file, buf, tag || "offload");
      offloaded.push({ path: file, sha1, bytes: buf.length, messageIndex: i, imageIndex: j });
      lines.push(`${IMAGE_OFFLOAD_PLACEHOLDER} ${file} (sha1 ${prefix}, ${buf.length}B)]`);
    }
    if (lines.length === 0) continue; // 本消息全是 skipped:原样保留
    const rec: M = {
      ...m,
      content: [m.content, ...lines].filter((x) => x.length > 0).join("\n"),
    };
    if (keep.length > 0) rec.images = keep;
    else delete rec.images;
    out[i] = rec;
    changed = true;
  }
  // 什么都没 offload(无图 / 全 skipped):返回原引用
  return { messages: changed ? out : messages, offloaded, skipped };
}

/**
 * 投影校验(M58 要求 3):offload 前后**消息条数与角色序列必须逐位相同**,只允许正文追加占位与
 * images 数组缩短。校验不通过 = 不重试(诚实),由调用方抛原错误。
 */
export function offloadProjectionPreserved<M extends OffloadableMessage>(
  before: readonly M[],
  after: readonly M[],
): boolean {
  if (before.length !== after.length) return false;
  for (let i = 0; i < before.length; i++) {
    if (before[i]!.role !== after[i]!.role) return false;
  }
  return true;
}
