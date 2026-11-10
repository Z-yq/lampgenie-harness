/**
 * 视觉通道图片尺寸守卫(事故:view_image 注入 10144x1146 PNG → 下一轮 LLM 400
 * `messages[55].image[1]: You have uploaded an unsupported image...`;坏 dataUrl 已进 journal,
 * deriveMessages 每轮重放 → 会话永久卡死)。
 * 零第三方依赖,只做两件事:
 *  ① readImageSize(buf)  —— 从文件头解析像素尺寸:PNG IHDR / JPEG SOF / GIF 逻辑屏 / WebP
 *     (VP8X 扩展 / VP8 有损 / VP8L 无损)。
 *  ② checkImageSize(size, label, limits) —— 长边/总像素超限判定,返回可直接给模型看的可操作文案。
 * 契约:解析失败(未知格式/头被截断)= null,**调用方据此放行**——不因解析器盲区拦正常图;
 * 只有真正解析出尺寸且超限才拒注入。
 */

export type ImageFormat = "png" | "jpeg" | "gif" | "webp";

export interface ImageSize {
  width: number;
  height: number;
  format: ImageFormat;
}

/** 长边上限缺省 4000px(主流视觉模型单边接受上限的量级;经验证 10144 直接被端点 400)。 */
export const VISION_MAX_EDGE_DEFAULT = 4_000;
/** 总像素上限缺省 1600 万(≈4000×4000);防「边都合规但面积巨大」的极端长图。 */
export const VISION_MAX_PIXELS_DEFAULT = 16_000_000;

export interface VisionLimits {
  maxEdge: number;
  maxPixels: number;
}

function envNum(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

/** 生效限额(每次现算:调用频次极低,且测试要用 env 注入)。 */
export function visionLimits(): VisionLimits {
  return {
    maxEdge: envNum("GENIE_VISION_MAX_EDGE", VISION_MAX_EDGE_DEFAULT),
    maxPixels: envNum("GENIE_VISION_MAX_PIXELS", VISION_MAX_PIXELS_DEFAULT),
  };
}

const PNGSIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const u16be = (b: Uint8Array, i: number): number => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8);
const u32be = (b: Uint8Array, i: number): number => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const u24le = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const ascii = (b: Uint8Array, i: number, n: number): string => String.fromCharCode(...b.subarray(i, i + n));

/** PNG:8 字节魔数 + IHDR(id 在偏移 12,宽/高各 4 字节大端在 16/20)。 */
function pngSize(b: Uint8Array): ImageSize | null {
  if (b.length < 24) return null;
  for (let i = 0; i < 8; i++) if (b[i] !== PNGSIG[i]) return null;
  if (ascii(b, 12, 4) !== "IHDR") return null;
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  return width > 0 && height > 0 ? { width, height, format: "png" } : null;
}

/** JPEG:SOI 后逐段走,命中 SOF0..SOF15(排除 DHT 0xC4 / JPG 0xC8 / DAC 0xCC)读高/宽
 *  (段内偏移 +5/+7,各 2 字节大端);扫到 SOS(0xDA)仍未命中 → 放弃(=放行)。 */
function jpegSize(b: Uint8Array): ImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; } // 段间填充
    const marker = b[i + 1]!;
    if (marker === 0xff) { i++; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
    if (marker === 0xda) return null; // 扫描已开始,之后不会再有 SOF
    const segLen = u16be(b, i + 2);
    if (segLen < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = u16be(b, i + 5);
      const width = u16be(b, i + 7);
      return width > 0 && height > 0 ? { width, height, format: "jpeg" } : null;
    }
    i += 2 + segLen;
  }
  return null;
}

/** GIF:逻辑屏宽/高(各 2 字节小端,偏移 6/8)。 */
function gifSize(b: Uint8Array): ImageSize | null {
  if (b.length < 10) return null;
  if (ascii(b, 0, 4) !== "GIF8") return null;
  const width = u16le(b, 6);
  const height = u16le(b, 8);
  return width > 0 && height > 0 ? { width, height, format: "gif" } : null;
}

/** WebP:RIFF....WEBP + 首个块(VP8X 扩展 / VP8 有损 / VP8L 无损)。 */
function webpSize(b: Uint8Array): ImageSize | null {
  if (b.length < 30) return null;
  if (ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  const fourcc = ascii(b, 12, 4);
  if (fourcc === "VP8X") {
    // 载荷:1 字节 flags + 3 字节保留 + 画布宽-1(小端 24 位,偏移 24) + 画布高-1(偏移 27)
    const width = u24le(b, 24) + 1;
    const height = u24le(b, 27) + 1;
    return width > 0 && height > 0 ? { width, height, format: "webp" } : null;
  }
  if (fourcc === "VP8 ") {
    // 帧标签 3 字节 + 同步码 9D 01 2A(偏移 23..25) + 宽/高各 2 字节(低 14 位有效)
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    const width = u16le(b, 26) & 0x3fff;
    const height = u16le(b, 28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height, format: "webp" } : null;
  }
  if (fourcc === "VP8L") {
    // 签名 0x2F 后 14 位宽-1 + 14 位高-1
    if (b[20] !== 0x2f) return null;
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return width > 0 && height > 0 ? { width, height, format: "webp" } : null;
  }
  return null;
}

/** 从文件头字节解析像素尺寸;未知格式/头不足 → null(调用方放行)。 */
export function readImageSize(buf: Uint8Array): ImageSize | null {
  return pngSize(buf) ?? jpegSize(buf) ?? gifSize(buf) ?? webpSize(buf);
}

/** dataUrl → 头字节再解析(只解前 64K 字符 ≈ 48KB 原始,覆盖 JPEG 的 EXIF 段)。 */
export function imageSizeOfDataUrl(dataUrl: string): ImageSize | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  try {
    return readImageSize(Buffer.from(dataUrl.slice(comma + 1, comma + 1 + 64_000), "base64"));
  } catch {
    return null;
  }
}

export interface SizeCheckOk { ok: true; size: ImageSize | null }
export interface SizeCheckFail { ok: false; reason: string; size: ImageSize }
export type SizeCheck = SizeCheckOk | SizeCheckFail;

/** 超限判定 + **可操作**文案(路径/实际尺寸/限额/降级建议全在句子里)。
 *  合法或解析不出尺寸(传 null)→ ok:true(解析器盲区不拦正常图)。 */
export function checkImageSize(size: ImageSize | null, label: string, limits: VisionLimits = visionLimits()): SizeCheck {
  if (!size) return { ok: true, size: null };
  const pixels = size.width * size.height;
  const edge = Math.max(size.width, size.height);
  if (edge <= limits.maxEdge && pixels <= limits.maxPixels) return { ok: true, size };
  const mp = (limits.maxPixels / 10_000).toFixed(0); // 万像素口径:16_000_000 → 1600
  return {
    ok: false,
    size,
    reason:
      `[图片超限] ${label} 为 ${size.width}x${size.height},超过模型视觉上限` +
      `(长边≤${limits.maxEdge}px/≤${mp}万像素);未注入视觉通道。` +
      `请重排/拆分成多张或等比缩小后重试(渲染脚本可加 maxWidth/尺寸参数)。`,
  };
}
