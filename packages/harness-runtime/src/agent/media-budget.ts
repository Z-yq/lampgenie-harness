/**
 * 请求级媒体预算与能力投影:一次 LLM 请求里所有图片字节总量超限时,
 * 按确定性顺序省略旧图并记账;受保护媒体(最后一条含图消息里的图 + 最近 N 张)优先保留。
 * 为什么需要一条独立机制:
 * - 历史回放的请求会滚雪球:每张视图图都是 data URL(常见 1~3 MiB),几轮之后就撞 provider
 * 的请求尺寸上限,整轮 400。图片进上下文是「按需看一眼」,旧图的价值随时间衰减,
 * 但文本/tool 结果里的结论必须一直保留——所以只裁图,绝不改文本。
 * - 裁剪必须是确定性的:同样的请求消息永远省掉同样几张、同样顺序,面板/回放才能解释,
 * 也不至于两次请求之间「这次省 A 下次省 B」让缓存前缀反复失效。
 * - 「受保护媒体」是这条机制的安全阀:最后一条含图消息几乎必然是用户刚发的那一条,
 * 最近 N 张同理;把它们也省掉等于把问题从预算变成了功能故障。
 * - 单张受保护图本身就超预算 = 请求从根上发不出去:此时必须显式返回
 * PROTECTED_OVER_BUDGET,由调用方决定报错/降级,绝不静默发一个必然被拒的请求。
 * - 未知媒体(http(s) 地址)不占本地预算,但也从不被省略(省掉它不减轻任何字节),
 * 只记账,避免「看起来省了其实没省」。
 * - 省略只缩短 images 数组,不删消息、不动 content:角色序列与文本一律不变,
 * 谁省了几张由调用方落 journal(见 mediaBudgetNote)。
 * 纯逻辑:零 IO,不读文件/网络/环境,无任何 import。
 * 所有函数不抛异常——非法输入返回稳定码,消息原样返回,输入对象永不被改写。
 */

/** 单请求媒体字节预算缺省值:40 MiB(够放十来张截图,低于主流 provider 的请求体上限)。 */
export const MEDIA_BUDGET_DEFAULT_BYTES = 40 * 1024 * 1024;

/** 「最近 N 张图」受保护缺省张数。 */
export const MEDIA_BUDGET_DEFAULT_PROTECT_RECENT = 4;

/** 预算结果稳定码:每个码对应一个可判定的结局。 */
export const MEDIA_BUDGET_CODES = {
 /** 未超预算:消息原样(同一引用),请求字节逐字不变。 */
  OK: "MEDIA_BUDGET_OK",
 /** 已省略旧图:调用方应把 accounting 落 journal 并注入提示。 */
  OMITTED: "MEDIA_BUDGET_OMITTED",
 /** 受保护媒体自身就超预算(或受保护集合合计超预算):消息原样,调用方决定报错/降级。 */
  PROTECTED_OVER_BUDGET: "MEDIA_BUDGET_PROTECTED_OVER_BUDGET",
 /** 非法输入(消息非数组/元素非对象/预算或保护数为非法值):消息原样。 */
  INVALID: "MEDIA_BUDGET_INVALID",
} as const;

export type MediaBudgetCode = (typeof MEDIA_BUDGET_CODES)[keyof typeof MEDIA_BUDGET_CODES];

/** 视觉能力投影稳定码。 */
export const VISION_PROJECTION_CODES = {
  OK: "MEDIA_CAP_OK",
  NO_VISION: "MEDIA_CAP_NO_VISION",
  INVALID: "MEDIA_CAP_INVALID",
} as const;

/** 消息的最小结构约束:只关心 images,其余字段(role/content/tool 字段)原样透传。 */
export interface MediaMessageLike {
  role?: string;
  content?: unknown;
  images?: string[];
  [key: string]: unknown;
}

/** 省略账目:total/unknown 按**请求原样**计,kept/omitted 按**裁剪后**的结果计。 */
export interface MediaBudgetAccounting {
 /** 请求内可计量图片的原始字节总量(未知 URL 不计入)。 */
  totalBytes: number;
 /** 裁剪后保留的图片张数。 */
  keptImages: number;
 /** 被省略的图片张数。 */
  omittedImages: number;
 /** 被省略图片的字节数(全部来自可计量图片)。 */
  omittedBytes: number;
 /** 请求内无法本地计量的图片张数(http(s) 地址等,不占预算但始终保留)。 */
  unknownImages: number;
 /** 裁剪后仍在的受保护图片张数(最后一条含图消息 + 最近 N 张的并集)。 */
  protectedKept: number;
}

export interface MediaBudgetOptions {
 /** 预算字节,缺省 40 MiB;必须为有限非负数。 */
  maxBytes?: number;
 /** 受保护「最近 N 张」,缺省 4;必须为非负整数。 */
  protectRecent?: number;
}

export interface MediaBudgetResult<T extends MediaMessageLike = MediaMessageLike> {
  messages: T[];
  accounting: MediaBudgetAccounting;
  code: MediaBudgetCode;
}

/** 视觉能力输入:provider/模型声明的能力面(缺失字段按「未声明」处理,不猜)。 */
export interface VisionCapabilityInput {
  vision?: boolean;
  inputFormats?: string[];
}

/** 视觉能力投影结果:projectImages=false 时调用方应在请求前剥离图片(保留文本占位)。 */
export interface VisionProjection {
  projectImages: boolean;
 /** 可投影的图片 MIME 清单(空数组=未声明格式,按 provider 默认处理)。 */
  formats: string[];
  reason: string;
  code: (typeof VISION_PROJECTION_CODES)[keyof typeof VISION_PROJECTION_CODES];
}

/** 一个待预算的图片槽位:消息下标 / 消息内下标 / 字节数(-1=未知)。 */
interface ImageSlot {
  mi: number;
  ii: number;
  bytes: number;
}

/**
 * 估算一个图片 URL 的字节数:
 * - `data:image/...;base64,<payload>` → base64 长度 * 3/4 再减 padding(不真正解码);
 * - http(s) 及其它形态 → -1(未知:不算入本地预算,但计数且从不省略);
 * - 空 base64 payload → 0;非字符串 → -1。
 */
export function estimateDataUrlBytes(url: unknown): number {
  if (typeof url !== "string" || url.length === 0) return -1;
  const head = /^data:[^,]*;base64,/i.exec(url);
  if (!head) return -1;
  const b64 = url.slice(head[0].length).replace(/\s+/g, "");
  if (b64.length === 0) return 0;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

/** 空账目(无图/非法输入时的确定基线)。 */
function emptyAccounting(extra?: Partial<MediaBudgetAccounting>): MediaBudgetAccounting {
  return {
    totalBytes: 0,
    keptImages: 0,
    omittedImages: 0,
    omittedBytes: 0,
    unknownImages: 0,
    protectedKept: 0,
    ...extra,
  };
}

/**
 * 应用请求级媒体预算:返回**新**消息数组(未裁剪的消息沿用原引用),
 * 只缩短 `images` 数组,不删消息、不改 content/工具字段。纯函数,输入永不被改写。
 */
export function applyMediaBudget<T extends MediaMessageLike>(
  messages: readonly T[],
  opts: MediaBudgetOptions = {},
): MediaBudgetResult<T> {
  const maxBytes = opts.maxBytes ?? MEDIA_BUDGET_DEFAULT_BYTES;
  const protectRecent = opts.protectRecent ?? MEDIA_BUDGET_DEFAULT_PROTECT_RECENT;
 // 非法输入一律 INVALID + 原样返回:调用方仍能拿到原始 messages 决定如何降级。
  const all: T[] = Array.isArray(messages) ? (messages as T[]) : [];
  const invalidInput =
    !Array.isArray(messages) ||
    messages.some((m) => typeof m !== "object" || m === null) ||
    typeof maxBytes !== "number" ||
    !Number.isFinite(maxBytes) ||
    maxBytes < 0 ||
    typeof protectRecent !== "number" ||
    !Number.isInteger(protectRecent) ||
    protectRecent < 0;
  if (invalidInput) {
    return { messages: all, accounting: emptyAccounting(), code: MEDIA_BUDGET_CODES.INVALID };
  }

 // 1) 收集全部图片槽位(顺序 = 请求内的时间顺序)。
  const slots: ImageSlot[] = [];
  for (let mi = 0; mi < all.length; mi++) {
    const images = all[mi]!.images;
    if (!Array.isArray(images)) continue;
    for (let ii = 0; ii < images.length; ii++) {
      slots.push({ mi, ii, bytes: estimateDataUrlBytes(images[ii]) });
    }
  }
  if (slots.length === 0) {
    return { messages: all, accounting: emptyAccounting(), code: MEDIA_BUDGET_CODES.OK };
  }

  const knownTotal = slots.reduce((sum, s) => sum + Math.max(0, s.bytes), 0);
  const unknownImages = slots.filter((s) => s.bytes < 0).length;
  const base = emptyAccounting({
    totalBytes: knownTotal,
    keptImages: slots.length,
    unknownImages,
    protectedKept: 0,
  });

 // 2) 未超预算:原样(同一数组引用),请求字节逐字不变。
  if (knownTotal <= maxBytes) {
    return {
      messages: all,
      accounting: { ...base, protectedKept: protectedSlotIds(all, slots, protectRecent).size },
      code: MEDIA_BUDGET_CODES.OK,
    };
  }

 // 3) 受保护集合:最后一条含图消息的全部图 ∪ 最近 protectRecent 张(并集,按槽位下标)。
  const protectedIds = protectedSlotIds(all, slots, protectRecent);
  const protectedBytes = slots.reduce((sum, s, i) => (protectedIds.has(i) ? sum + Math.max(0, s.bytes) : sum), 0);

 // 4) 单张受保护图或受保护集合本身就超预算:显式失败,消息原样(调用方决定报错/降级)。
  const singleProtectedOver = slots.some((s, i) => protectedIds.has(i) && s.bytes > maxBytes);
  if (singleProtectedOver || protectedBytes > maxBytes) {
    return {
      messages: all,
      accounting: { ...base, protectedKept: protectedIds.size },
      code: MEDIA_BUDGET_CODES.PROTECTED_OVER_BUDGET,
    };
  }

 // 5) 从旧到新省略非受保护图,直到总量 ≤ 预算。未知图(–1)省略不减轻任何字节,
 // 省了只是白丢信息 → 跳过,始终保留并计数。
  const omitted = new Set<number>();
  let remaining = knownTotal;
  for (let i = 0; i < slots.length && remaining > maxBytes; i++) {
    if (protectedIds.has(i)) continue;
    const bytes = slots[i]!.bytes;
    if (bytes <= 0) continue;
    omitted.add(i);
    remaining -= bytes;
  }
 // 非受保护图全砍完仍超预算 = 受保护集合超限(第 4 步已拦,这里只是防御性)。
  if (remaining > maxBytes) {
    return {
      messages: all,
      accounting: { ...base, protectedKept: protectedIds.size },
      code: MEDIA_BUDGET_CODES.PROTECTED_OVER_BUDGET,
    };
  }

 // 6) 重建:只克隆被缩短的消息;全部图被省掉时删除 images 属性(避免空数组进 wire)。
  const omittedByMsg = new Map<number, Set<number>>();
  for (const i of omitted) {
    const s = slots[i]!;
    let set = omittedByMsg.get(s.mi);
    if (!set) omittedByMsg.set(s.mi, (set = new Set()));
    set.add(s.ii);
  }
  const out = all.map((m, mi) => {
    const gone = omittedByMsg.get(mi);
    if (!gone) return m; // 未裁剪的消息沿用原引用
    const kept = (m.images ?? []).filter((_, ii) => !gone.has(ii));
    const clone = { ...m } as T & { images?: string[] };
    if (kept.length > 0) clone.images = kept;
    else delete clone.images;
    return clone as T;
  });

  const omittedBytes = [...omitted].reduce((sum, i) => sum + Math.max(0, slots[i]!.bytes), 0);
  return {
    messages: out,
    accounting: {
      ...base,
      keptImages: slots.length - omitted.size,
      omittedImages: omitted.size,
      omittedBytes,
      protectedKept: protectedIds.size,
    },
    code: MEDIA_BUDGET_CODES.OMITTED,
  };
}

/** 受保护槽位下标集合:最后一条含图消息的全部图 + 最近 protectRecent 张(并集)。 */
function protectedSlotIds(messages: readonly MediaMessageLike[], slots: ImageSlot[], protectRecent: number): Set<number> {
  const ids = new Set<number>();
  let lastWithImages = -1;
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const images = messages[mi]?.images;
    if (Array.isArray(images) && images.length > 0) {
      lastWithImages = mi;
      break;
    }
  }
  for (let i = 0; i < slots.length; i++) {
    if (slots[i]!.mi === lastWithImages) ids.add(i);
    if (protectRecent > 0 && i >= slots.length - protectRecent) ids.add(i);
  }
  return ids;
}

/**
 * 给调用方的一段中文说明(省略了几张/多少 MB/为什么);无省略返回空串。
 * 只描述本次请求的裁剪,不声称历史被改动。
 */
export function mediaBudgetNote(accounting: MediaBudgetAccounting): string {
  if (!accounting || !(accounting.omittedImages > 0)) return "";
  const mb = (bytes: number) => (Math.max(0, bytes) / (1024 * 1024)).toFixed(1);
  const unknown = accounting.unknownImages > 0
    ? `另有 ${accounting.unknownImages} 张远程图片无法在本地计量,始终保留。`
    : "";
  return `[媒体预算] 本次请求图片共 ${mb(accounting.totalBytes)} MB,超过单请求预算:`
    + `已按「保护最后一条含图消息与最近若干张」规则省略 ${accounting.omittedImages} 张旧图`
    + `(${mb(accounting.omittedBytes)} MB),保留 ${accounting.keptImages} 张`
    + `(其中受保护 ${accounting.protectedKept} 张)。省略只作用于本次请求,历史消息与文本未改动;`
    + `需要旧图请重新读取。${unknown}`;
}

/**
 * 能力投影:根据模型声明的能力面,决定本次请求可投影的媒体形态。
 * 无 vision → 不投影图片(调用方在请求前剥离,保留文本占位),并给出 reason。
 */
export function projectVisionCapability(caps?: VisionCapabilityInput | null): VisionProjection {
  if (!caps || typeof caps !== "object" || typeof caps.vision !== "boolean") {
    return {
      projectImages: false,
      formats: [],
      reason: "未声明模型能力:按无视觉处理,请求前剥离图片并保留文本占位",
      code: VISION_PROJECTION_CODES.INVALID,
    };
  }
  if (!caps.vision) {
    return {
      projectImages: false,
      formats: [],
      reason: "模型不支持视觉输入:跳过图片投影,正文与工具结果保持不变",
      code: VISION_PROJECTION_CODES.NO_VISION,
    };
  }
  const seen = new Set<string>();
  const formats: string[] = [];
  if (Array.isArray(caps.inputFormats)) {
    for (const f of caps.inputFormats) {
      if (typeof f !== "string") continue;
      const norm = f.trim().toLowerCase();
      if (!norm.startsWith("image/")) continue; // 文本/音频格式不参与图片投影
      if (seen.has(norm)) continue;
      seen.add(norm);
      formats.push(norm);
    }
  }
  return {
    projectImages: true,
    formats,
    reason: formats.length > 0
      ? `模型支持视觉输入:可投影 ${formats.join(" / ")}`
      : "模型支持视觉输入:未声明输入格式,按 provider 默认处理",
    code: VISION_PROJECTION_CODES.OK,
  };
}
