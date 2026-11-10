/**
 * 视觉通道尺寸守卫单测(2026-11-05 事故:10144x1146 PNG 注入 → 每轮 400 unsupported image)。
 * 覆盖:PNG IHDR / JPEG SOF0 / GIF 逻辑屏 / WebP VP8X 解析;长边与总像素双阈值;
 * 解析失败(null)= 放行(解析器盲区不拦正常图);env 可覆盖缺省限额。
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  readImageSize,
  imageSizeOfDataUrl,
  checkImageSize,
  visionLimits,
  VISION_MAX_EDGE_DEFAULT,
  VISION_MAX_PIXELS_DEFAULT,
} from "../src/image-size.js";

/** 手工构造 PNG 头(魔数 + 长度 + IHDR + 宽/高;CRC 不校验,守卫只读 24 字节)。 */
function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b.writeUInt8(8, 24);
  b.writeUInt8(6, 25);
  return b;
}

/** JPEG:SOI + SOF0 段(高/宽各 2 字节大端)+ SOS。 */
function jpeg(w: number, h: number): Buffer {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08,
    (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255,
    0x03, 0x01, 0x22, 0x00, 0xff, 0xda, 0x00, 0x02,
  ]);
}

/** GIF:GIF89a + 逻辑屏宽/高(小端)。 */
function gif(w: number, h: number): Buffer {
  const b = Buffer.alloc(13);
  b.write("GIF89a", 0, "ascii");
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}

/** WebP(VP8X 扩展块):RIFF....WEBP + "VP8X" + 块长 + flags/reserved + 宽-1/高-1(各 3 字节小端)。 */
function webpVp8x(w: number, h: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(22, 4);
  b.write("WEBP", 8, "ascii");
  b.write("VP8X", 12, "ascii");
  b.writeUInt32LE(10, 16);
  const put24 = (v: number, at: number) => { b[at] = v & 255; b[at + 1] = (v >> 8) & 255; b[at + 2] = (v >> 16) & 255; };
  put24(w - 1, 24);
  put24(h - 1, 27);
  return b;
}

const ENV_KEYS = ["GENIE_VISION_MAX_EDGE", "GENIE_VISION_MAX_PIXELS"];

describe("readImageSize(零依赖图片头解析)", () => {
  afterEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });

  it("PNG:两种事故尺寸都解析正确", () => {
    expect(readImageSize(png(3330, 7022))).toEqual({ width: 3330, height: 7022, format: "png" });
    expect(readImageSize(png(10144, 1146))).toEqual({ width: 10144, height: 1146, format: "png" });
  });

  it("JPEG:SOF0 段读高/宽(段内偏移 +5/+7)", () => {
    expect(readImageSize(jpeg(1200, 800))).toEqual({ width: 1200, height: 800, format: "jpeg" });
  });

  it("GIF:逻辑屏宽/高(小端)", () => {
    expect(readImageSize(gif(640, 480))).toEqual({ width: 640, height: 480, format: "gif" });
  });

  it("WebP VP8X:24 位小端 +1", () => {
    expect(readImageSize(webpVp8x(9000, 500))).toEqual({ width: 9000, height: 500, format: "webp" });
  });

  it("解析失败:未知/截断/零尺寸 → null(调用方放行)", () => {
    expect(readImageSize(Buffer.from("not-an-image-at-all"))).toBeNull();
    expect(readImageSize(png(3330, 7022).subarray(0, 20))).toBeNull();
    expect(readImageSize(png(0, 100))).toBeNull();
    expect(readImageSize(Buffer.alloc(0))).toBeNull();
  });

  it("imageSizeOfDataUrl:dataUrl 形态同样可解析", () => {
    const du = "data:image/png;base64," + png(10144, 1146).toString("base64");
    expect(imageSizeOfDataUrl(du)).toEqual({ width: 10144, height: 1146, format: "png" });
    expect(imageSizeOfDataUrl("data:image/png;base64,####")).toBeNull();
    expect(imageSizeOfDataUrl("garbage")).toBeNull();
  });
});

describe("checkImageSize(长边/总像素双阈值)", () => {
  afterEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });

  it("缺省限额=长边 4000 / 1600 万像素", () => {
    expect(visionLimits()).toEqual({ maxEdge: VISION_MAX_EDGE_DEFAULT, maxPixels: VISION_MAX_PIXELS_DEFAULT });
    expect(VISION_MAX_EDGE_DEFAULT).toBe(4000);
    expect(VISION_MAX_PIXELS_DEFAULT).toBe(16_000_000);
  });

  it("合法图:ok,尺寸照旧返回(零行为变化的前提)", () => {
    const v = checkImageSize({ width: 1920, height: 1080, format: "png" }, "shot.png");
    expect(v.ok).toBe(true);
  });

  it("事故三张里的另两张也超长边(3330x7022 / 1358x6318)", () => {
    expect(checkImageSize({ width: 3330, height: 7022, format: "png" }, "a.png").ok).toBe(false);
    expect(checkImageSize({ width: 1358, height: 6318, format: "png" }, "b.png").ok).toBe(false);
  });

  it("长边超限:10144x1146 拒绝 + 可操作文案(路径/实际尺寸/限额/缩图建议)", () => {
    const v = checkImageSize({ width: 10144, height: 1146, format: "png" }, "code-flow/35.png");
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain("[图片超限]");
    expect(v.reason).toContain("code-flow/35.png");
    expect(v.reason).toContain("10144x1146");
    expect(v.reason).toContain("长边≤4000px");
    expect(v.reason).toContain("未注入视觉通道");
    expect(v.reason).toContain("maxWidth");
  });

  it("总像素超限(边都合规):4000x4001 被判超限", () => {
    const v = checkImageSize({ width: 4000, height: 4001, format: "png" }, "tall.png");
    expect(v.ok).toBe(false);
  });

  it("解析失败(null)= 放行:不因解析器盲区拦正常图", () => {
    expect(checkImageSize(null, "unknown.bin").ok).toBe(true);
  });

  it("env 覆盖限额生效", () => {
    process.env.GENIE_VISION_MAX_EDGE = "1000";
    expect(checkImageSize({ width: 1200, height: 200, format: "png" }, "x.png").ok).toBe(false);
    expect(checkImageSize({ width: 900, height: 200, format: "png" }, "x.png").ok).toBe(true);
  });
});
