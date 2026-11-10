import { describe, it, expect } from "vitest";
import * as vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 截图标注坐标换算层(assets/annotate-coords.js,UMD:node 直接 require)。
 * 锁的是「取屏偏移」根因:rect 与位图尺寸不等、DPR 位图放大、缩放留边时,pointer → 图像原生像素仍逐像素对齐。 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSET = join(HERE, "../src/assets/annotate-coords.js");
type Coords = {
  clientToImage(pt: { x: number; y: number }, box: Record<string, number>): { x: number; y: number };
  imageToClient(pt: { x: number; y: number }, box: Record<string, number>): { x: number; y: number };
  bitmapOf(cssWidth: number, cssHeight: number, dpr: number): { width: number; height: number };
  fitScale(imgW: number, imgH: number, boxW: number, boxH: number, opts?: { cover?: boolean; cap1?: boolean }): number;
};
/** 资产是浏览器 UMD 脚本(本包 type=module,createRequire 会把它当 ESM 加载出空命名空间),
 * 故用 vm 在带 module 的沙箱里执行 —— 同时验证「node 直接可用」这一 UMD 承诺。 */
const ASSET_SRC = readFileSync(ASSET, "utf8");
const sandbox: { module: { exports: unknown }; window?: unknown } = { module: { exports: {} } };
vm.runInNewContext(ASSET_SRC, sandbox, { filename: ASSET });
const C = sandbox.module.exports as Coords;
const W = vm.runInNewContext(ASSET_SRC + "\n;window.GenieAnnotateCoords;", { window: {} }, { filename: ASSET }) as Coords;

describe("annotate-coords:clientToImage", () => {
  it("① 2560×1440 图像显示在 1280×720 盒子里:client(640,360) → 图像 (1280,720)", () => {
    const box = { left: 0, top: 0, width: 1280, height: 720, imgWidth: 2560, imgHeight: 1440, scale: 0.5 };
    expect(C.clientToImage({ x: 640, y: 360 }, box)).toEqual({ x: 1280, y: 720 });
    expect(C.clientToImage({ x: 0, y: 0 }, box)).toEqual({ x: 0, y: 0 });
  });

  it("② rect ≠ 位图:DPR=1.5 位图 1920×1080 装在 1280×720 的 CSS 盒(scale=1.5 反算)仍正确", () => {
    // 位图 1920×1080 = device px;CSS 显示 1280×720 → 图像原生像素(1920×1080)映射到 1280 CSS px,scale=1280/1920
    const box = { left: 40, top: 20, width: 1280, height: 720, imgWidth: 1920, imgHeight: 1080, scale: 1280 / 1920 };
    const p = C.clientToImage({ x: 40 + 640, y: 20 + 360 }, box);
    expect(p.x).toBeCloseTo(960, 9);
    expect(p.y).toBeCloseTo(540, 9);
  });

  it("②b rect 被压缩(layout≠rect)时按两轴分别归一,横向误差不污染纵向", () => {
    // 布局空间 1000×600 的图像被 flex 压到 800×600 的盒子里:横向 kx=1.25、纵向 ky=1
    const box = { left: 100, top: 50, width: 800, height: 600, imgWidth: 1000, imgHeight: 600, layoutWidth: 1000, layoutHeight: 600 };
    expect(C.clientToImage({ x: 100 + 400, y: 50 + 300 }, box)).toEqual({ x: 500, y: 300 });
    expect(C.clientToImage({ x: 100 + 800, y: 50 + 600 }, box)).toEqual({ x: 1000, y: 600 });
  });

  it("③ 1.25 缩放 + 居中留边(offset 非 0)", () => {
    // 布局空间 1400×1100:图像 1000×800 按 1.25 显示成 1250×1000,居中 → ox=75, oy=50
    const box = { left: 10, top: 10, width: 1400, height: 1100, imgWidth: 1000, imgHeight: 800, scale: 1.25, offsetX: 75, offsetY: 50, layoutWidth: 1400, layoutHeight: 1100 };
    expect(C.clientToImage({ x: 10 + 75, y: 10 + 50 }, box)).toEqual({ x: 0, y: 0 });
    expect(C.clientToImage({ x: 10 + 75 + 625, y: 10 + 50 + 500 }, box)).toEqual({ x: 500, y: 400 });
  });

  it("④ imageToClient 是严格逆(往返误差 ≤1e-9)", () => {
    const box = { left: 13.5, top: 7.25, width: 1100, height: 700, imgWidth: 2560, imgHeight: 1440, scale: 0.43, offsetX: 33.5, offsetY: 12.25, layoutWidth: 1100, layoutHeight: 619 };
    for (const pt of [{ x: 0, y: 0 }, { x: 1280, y: 720 }, { x: 2559.5, y: 1439.25 }]) {
      const back = C.imageToClient(C.clientToImage(pt, box), box);
      expect(Math.abs(back.x - pt.x)).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(back.y - pt.y)).toBeLessThanOrEqual(1e-9);
    }
  });

  it("不 clamp:越界值原样返回(夹取口径留给调用方)", () => {
    const box = { left: 0, top: 0, width: 100, height: 100, imgWidth: 100, imgHeight: 100 };
    expect(C.clientToImage({ x: -10, y: 200 }, box)).toEqual({ x: -10, y: 200 });
  });
});

describe("annotate-coords:bitmapOf / fitScale", () => {
  it("⑤ bitmapOf 按 DPR 放大、取整、下限 1", () => {
    expect(C.bitmapOf(1280, 720, 1)).toEqual({ width: 1280, height: 720 });
    expect(C.bitmapOf(1280, 720, 1.5)).toEqual({ width: 1920, height: 1080 });
    expect(C.bitmapOf(1279.4, 719.6, 1)).toEqual({ width: 1279, height: 720 });
    expect(C.bitmapOf(0, 0, 2)).toEqual({ width: 1, height: 1 });
    expect(C.bitmapOf(0, 0, 0)).toEqual({ width: 1, height: 1 }); // DPR 非法按 1
  });

  it("⑥ fitScale:cover 取 max(铺满)、contain 取 min(全见)、cap1 不放大", () => {
    expect(C.fitScale(2560, 1440, 1280, 720, { cover: true })).toBe(0.5);
    expect(C.fitScale(2560, 1440, 1280, 1000, { cover: true })).toBeCloseTo(1000 / 1440, 12);
    expect(C.fitScale(2560, 1440, 1280, 1000)).toBeCloseTo(0.5, 12);
    expect(C.fitScale(100, 100, 1280, 720)).toBe(7.2);
    expect(C.fitScale(100, 100, 1280, 720, { cap1: true })).toBe(1);
    expect(C.fitScale(0, 0, 1280, 720)).toBe(1); // 退化输入不炸
  });

  it("资产形态:UMD 双出口都存在(module.exports 与 window.GenieAnnotateCoords 等价)", () => {
    const src = readFileSync(ASSET, "utf8");
    expect(src).toContain("module.exports");
    expect(src).toContain("window.GenieAnnotateCoords");
    expect(typeof W.clientToImage).toBe("function");
    expect(W.bitmapOf(100, 50, 2)).toEqual({ width: 200, height: 100 });
    expect(W.clientToImage({ x: 10, y: 10 }, { left: 0, top: 0, width: 100, height: 100, imgWidth: 100, imgHeight: 100 })).toEqual(C.clientToImage({ x: 10, y: 10 }, { left: 0, top: 0, width: 100, height: 100, imgWidth: 100, imgHeight: 100 }));
  });
});
