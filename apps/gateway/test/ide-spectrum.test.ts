/**
 * 音频频谱视图(assets/ide-spectrum.js,板节点 ide-m5)契约测试。
 *
 * 本仓 vitest 是 node 环境(无 DOM / 无 WebAudio),不造 jsdom,分三层:
 *  ①源码契约(读文件文本):导出面四键 + RED、信号链关键字(createMediaElementSource /
 *    AnalyserNode / destination 防静音)、WeakMap 防二次 source、离线红线(禁 url 协议)、
 *    禁整段解码大文件、禁 console.log 噪声;
 *  ②纯函数层(__test):对数频率轴 → bin 反函数、dpr 适配夹紧、区间峰值电平、模式归一化;
 *  ③降级层:无 window / 无 AudioContext 时 attach 返回 {ok:false},detach 幂等不抛。
 * 真实绘制与媒体联动不做单测(DOM/WebAudio 交互验收走浏览器实测)。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const ASSET = join(here, "..", "src", "assets", "ide-spectrum.js");
const source = readFileSync(ASSET, "utf8");

/** 在最小沙箱里跑资产;无 window 时资产挂 globalThis,有 window 时挂 window。 */
function load(extra: Record<string, unknown> = {}): Record<string, any> {
  const sandbox: Record<string, any> = { console, ...extra };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "ide-spectrum.js" });
  return (sandbox.window ? sandbox.window.IdeSpectrum : sandbox.IdeSpectrum) as Record<string, any>;
}

/** 够 attach 走的 canvas / 2D 上下文 / media 桩;用于把降级路径逼到 AudioContext 缺失那一步。 */
function fakeCanvas() {
  const g2d = {
    fillStyle: "",
    strokeStyle: "",
    font: "",
    textAlign: "",
    textBaseline: "",
    lineWidth: 1,
    clearRect() {},
    fillRect() {},
    fillText() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    createLinearGradient: () => ({ addColorStop() {} }),
  };
  return { width: 0, height: 0, clientWidth: 240, clientHeight: 72, parentElement: null, getContext: () => g2d };
}

const fakeMedia = () => ({ paused: true, addEventListener() {}, removeEventListener() {} });

describe("ide-spectrum 源码契约", () => {
  it("可被 JS 引擎解析(资产无 TS 护栏,坏文件会直进产线)", () => {
    expect(() => new Function(source)).not.toThrow();
  });

  it("导出面:window.IdeSpectrum 四键 + RED", () => {
    expect(source).toContain("window.IdeSpectrum");
    for (const k of ["attach:", "detach:", "setMode:", "isAttached:", "RED:"]) expect(source).toContain(k);
  });

  it("信号链:createMediaElementSource → AnalyserNode → destination(防静音)", () => {
    expect(source).toContain("createMediaElementSource");
    expect(source).toContain("AnalyserNode");
    expect(source).toContain("destination");
    expect(source).toContain("getByteFrequencyData");
    expect(source).toContain("getByteTimeDomainData");
    expect(source).toContain("devicePixelRatio");
    expect(source).toContain("ResizeObserver");
  });

  it("WeakMap 缓存 media source(同元素二次 createMediaElementSource 会抛 InvalidStateError)", () => {
    expect(source).toContain("WeakMap");
  });

  it("离线红线:不含任何 url 协议、不加载外部资源", () => {
    expect(source).not.toContain("http://");
    expect(source).not.toContain("https://");
  });

  it("不做整段解码(大音频会把几百 MB 读进内存),且无 console.log 噪声", () => {
    expect(source).not.toContain("decodeAudioData");
    expect(source).not.toContain("console.log");
  });
});

describe("ide-spectrum 纯函数(__test)", () => {
  const api = load();
  const T = api.__test;

  it("__test 面齐全且不依赖 DOM", () => {
    for (const k of ["freqForRatio", "binForRatio", "dprFit", "barLevel", "modeOf", "maxHzFor"]) {
      expect(typeof T[k]).toBe("function");
    }
    expect(T.constants.FFT_SIZE).toBeGreaterThanOrEqual(1024);
    expect(T.constants.BAR_COUNT).toBeGreaterThan(0);
  });

  it("对数频率轴:两端夹紧在 [MIN_HZ, maxHz],中间单调递增", () => {
    expect(T.freqForRatio(0, 20, 20000)).toBeCloseTo(20, 6);
    expect(T.freqForRatio(1, 20, 20000)).toBeCloseTo(20000, 6);
    expect(T.freqForRatio(-3, 20, 20000)).toBeCloseTo(20, 6);
    expect(T.freqForRatio(9, 20, 20000)).toBeCloseTo(20000, 6);
    const mid = T.freqForRatio(0.5, 20, 20000);
    expect(mid).toBeGreaterThan(20);
    expect(mid).toBeLessThan(20000);
    expect(mid).toBeCloseTo(20 * Math.sqrt(1000), 6);
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const f = T.freqForRatio(i / 20, 20, 20000);
      expect(f).toBeGreaterThan(prev);
      prev = f;
    }
  });

  it("binForRatio:0 → 首 bin,1 → 末 bin,全程单调且不越界", () => {
    const n = 1024;
    // 轴起点是 20Hz(不是 DC):44.1kHz/1024 bin 下 ≈ bin 0.93 → 落在 bin 1
    expect(T.binForRatio(0, n, 44100)).toBeLessThanOrEqual(2);
    // 轴终点是 min(20kHz, 奈奎斯特):44.1kHz 下 20kHz 只到 bin ≈928(留出 20k-22.05k 空档)
    expect(T.binForRatio(1, n, 44100)).toBe(928);
    // 低采样率时 20kHz 上界被奈奎斯特压下,末端正好落最后一 bin
    expect(T.binForRatio(1, n, 32000)).toBe(n - 1);
    let prev = -1;
    for (let i = 0; i <= 40; i++) {
      const b = T.binForRatio(i / 40, n, 44100);
      expect(b).toBeGreaterThanOrEqual(prev);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(n - 1);
      prev = b;
    }
    // 采样率越低,同一横坐标落到的 bin 越靠后(奈奎斯特更小)
    expect(T.binForRatio(0.5, n, 22050)).toBeGreaterThan(T.binForRatio(0.5, n, 88200));
  });

  it("maxHzFor:不超过奈奎斯特,也不超过 20kHz", () => {
    expect(T.maxHzFor(44100)).toBe(20000);
    expect(T.maxHzFor(8000)).toBe(4000);
    expect(T.maxHzFor(0)).toBe(20000);
  });

  it("dprFit:位图尺寸 = css × dpr,dpr 夹在 [1,3],非法输入兜底 1", () => {
    expect(T.dprFit(100, 50, 2)).toEqual({ w: 200, h: 100, dpr: 2 });
    expect(T.dprFit(120, 40, 4)).toEqual({ w: 360, h: 120, dpr: 3 });
    expect(T.dprFit(0, 0, 0)).toEqual({ w: 1, h: 1, dpr: 1 });
    expect(T.dprFit(NaN, -5, NaN)).toEqual({ w: 1, h: 1, dpr: 1 });
  });

  it("barLevel:区间峰值归一 0..1,空数据/反向区间安全", () => {
    const data = new Uint8Array([0, 128, 255, 10, 0]);
    expect(T.barLevel(data, 0, 4)).toBe(1);
    expect(T.barLevel(data, 1, 1)).toBeCloseTo(128 / 255, 6);
    expect(T.barLevel(data, 3, 1)).toBeCloseTo(255 / 255, 6); // 反序自动交换
    expect(T.barLevel(data, 0, 999)).toBe(1);                 // 越界夹紧
    expect(T.barLevel(null, 0, 3)).toBe(0);
    expect(T.barLevel(new Uint8Array(0), 0, 0)).toBe(0);
  });

  it("modeOf:只认 wave,其余归 bars", () => {
    expect(T.modeOf("wave")).toBe("wave");
    expect(T.modeOf("bars")).toBe("bars");
    expect(T.modeOf("BARS")).toBe("bars");
    expect(T.modeOf(undefined)).toBe("bars");
  });
});

describe("ide-spectrum 降级与幂等", () => {
  it("无 window(node)时 attach 返回 {ok:false} 而不是 throw", async () => {
    const api = load();
    const r = await api.attach({ canvas: null, media: null });
    expect(r.ok).toBe(false);
    expect(typeof r.reason).toBe("string");
    expect(api.isAttached()).toBe(false);
  });

  it("无 AudioContext 环境:attach 降级返因,画布写文案,detach 幂等不抛", async () => {
    const api = load({ window: {} as Record<string, unknown>, document: {} });
    const canvas = fakeCanvas();
    const r = await api.attach({ canvas, media: fakeMedia() });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("audio-context");
    expect(api.isAttached()).toBe(false);
    expect(canvas.width).toBeGreaterThan(0); // 尺寸已按 dpr 适配过(降级也画出画布)
    expect(() => api.detach()).not.toThrow();
    expect(() => api.detach()).not.toThrow(); // 幂等
    expect(api.isAttached()).toBe(false);
  });

  it("参数不可用时也走降级(不吞成异常)", async () => {
    const api = load({ window: {} as Record<string, unknown>, document: {} });
    const r = await api.attach({ canvas: fakeCanvas(), media: null });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("media-unusable");
    const r2 = await api.attach({ canvas: null, media: fakeMedia() });
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe("canvas-unusable");
  });

  it("setMode 归一化并返回生效模式", () => {
    const api = load();
    expect(api.setMode("wave")).toBe("wave");
    expect(api.setMode("bars")).toBe("bars");
    expect(api.setMode("nope")).toBe("bars");
    expect(api.setMode()).toBe("bars");
  });

  it("node 直接 import 不崩(无 window 时退到 globalThis 挂载)", async () => {
    const mod: any = await import(pathToFileURL(ASSET).href);
    expect(mod).toBeTruthy();
    const api = (globalThis as any).IdeSpectrum;
    expect(api).toBeTruthy();
    expect(typeof api.attach).toBe("function");
    expect(typeof api.__test.binForRatio).toBe("function");
    const r = await api.attach({ canvas: null, media: null });
    expect(r.ok).toBe(false);
  });
});
