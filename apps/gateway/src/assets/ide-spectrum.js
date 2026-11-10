/* 音频频谱视图(板节点 ide-m5;参考 Adobe Audition 频谱视图的读数习惯)。
 * 形态:canvas 频谱条(bars,对数频率轴 + 渐变配色 + 底部基线)/ 时域波形(wave,对称居中)。
 * 信号链:createMediaElementSource → AnalyserNode → destination(必须接 destination,
 * 否则媒体元素被接管后音频全静音——这是该 API 最常见的坑)。
 * 自包含:IIFE 挂 window.IdeSpectrum,无外部依赖、无网络资源;panel 侧只需一行 <script> + 显式路由。
 * 实时分析:整段解码(几百 MB 内存炸弹)一律不做,分析数据全部来自 AnalyserNode 的逐帧快照。
 * 降级:AudioContext 缺失 / 2D 上下文缺失 / createMediaElementSource 抛错(CORS、同元素已建过 source)
 * → 返回 {ok:false, reason},画布上写一行降级文案,不抛未捕获异常(只留一条 console.warn)。
 * 性能:每帧一次 getByteFrequencyData + 一次 2D 绘制;频域/时域/柱级数组全部 attach 时预分配,
 * 帧内不新建数组或对象;渐变对象按尺寸缓存。 */
(function () {
  "use strict";

  var MIN_HZ = 20;          // 对数频率轴下界(AU 视图同款取值)
  var BAR_COUNT = 96;       // 频域柱数(384px 宽 ≈ 4px/柱)
  var FFT_SIZE = 2048;      // 44.1kHz 下 ≈ 21.5Hz/bin,足够撑起对数轴低端
  var DECAY = 0.55;         // 柱高平滑系数(旧帧权重;避免指针抖动)
  var MAX_DPR = 3;          // DPR 上限:5K 屏不把画布放大 4 倍烧 CPU
  var RED = "#d9483b";      // 满刻度红(峰值/告警色,对外导出供 panel 复用)

  var PALETTE = {
    low: "#2f6f7e",
    mid: "#c9a25e",
    high: RED,
    grid: "rgba(201,162,94,0.16)",
    base: "rgba(201,162,94,0.42)",
    wave: "#c9a25e",
    notice: "#a3937a",
  };

  /* ---------------- 纯函数(可测,挂 __test) ---------------- */

  /** 归一化横坐标 → 对数频率(Hz);ratio 越界自动夹紧。 */
  function freqForRatio(ratio, minHz, maxHz) {
    var r = typeof ratio === "number" && isFinite(ratio) ? ratio : 0;
    if (r < 0) r = 0;
    if (r > 1) r = 1;
    var lo = typeof minHz === "number" && minHz > 0 ? minHz : MIN_HZ;
    var hi = typeof maxHz === "number" && maxHz > lo ? maxHz : lo * 1000;
    return lo * Math.pow(hi / lo, r);
  }

  /** 采样率对应的分析上界:不超过奈奎斯特,也不超过 20kHz(人耳上限)。 */
  function maxHzFor(sampleRate) {
    var sr = typeof sampleRate === "number" && sampleRate > 0 ? sampleRate : 44100;
    return Math.min(20000, sr / 2);
  }

  /** 归一化横坐标 → 频域 bin 下标(对数轴 → 线性 bin 的反函数)。 */
  function binForRatio(ratio, binCount, sampleRate) {
    var n = typeof binCount === "number" && binCount > 0 ? binCount : 1;
    var f = freqForRatio(ratio, MIN_HZ, maxHzFor(sampleRate));
    var nyq = sampleRate > 0 ? sampleRate / 2 : 22050;
    var b = Math.round((f / nyq) * (n - 1));
    if (b < 0) b = 0;
    if (b > n - 1) b = n - 1;
    return b;
  }

  /** css 尺寸 + devicePixelRatio → 画布位图尺寸(dpr 夹在 [1, MAX_DPR])。 */
  function dprFit(cssW, cssH, dpr) {
    var w = typeof cssW === "number" && isFinite(cssW) && cssW > 0 ? cssW : 0;
    var h = typeof cssH === "number" && isFinite(cssH) && cssH > 0 ? cssH : 0;
    var d = typeof dpr === "number" && isFinite(dpr) && dpr > 0 ? dpr : 1;
    if (d > MAX_DPR) d = MAX_DPR;
    return { w: Math.max(1, Math.round(w * d)), h: Math.max(1, Math.round(h * d)), dpr: d };
  }

  /** 一段 bin 区间的电平(0..1):取区间峰值,区间外/空数据返回 0。 */
  function barLevel(data, from, to) {
    if (!data || !data.length) return 0;
    var a = from < 0 ? 0 : from;
    var b = to > data.length - 1 ? data.length - 1 : to;
    if (b < a) { var t = a; a = b; b = t; }
    if (a < 0) a = 0;
    var m = 0;
    for (var i = a; i <= b; i++) if (data[i] > m) m = data[i];
    return m / 255;
  }

  /** 模式归一化:只认 "wave",其余一律 "bars"。 */
  function modeOf(m) {
    return m === "wave" ? "wave" : "bars";
  }

  /* ---------------- 运行时状态 ---------------- */

  // 同一 <audio> 元素只能 createMediaElementSource 一次(第二次抛 InvalidStateError),
  // 因此 source 按元素缓存到 WeakMap,detach 后复用同一元素时取缓存,绝不重复创建。
  var sourceCache = new WeakMap();
  var sharedCtx = null; // AudioContext 单例(不对它 close:close 会让缓存的 source 失效)

  var state = {
    canvas: null,
    media: null,
    g: null,
    audioCtx: null,
    source: null,
    analyser: null,
    mode: "bars",
    raf: 0,
    run: false,
    attached: false,
    degraded: false,
    cssW: 0,
    cssH: 0,
    dpr: 1,
    freq: null,
    time: null,
    bars: null,
    grad: null,
    ro: null,
    onResize: null,
    onPlay: null,
    onStop: null,
  };

  function msgOf(e) {
    return String((e && e.message) || e || "unknown");
  }

  function raf(fn) {
    return typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : 0;
  }

  function unraf(id) {
    if (id && typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
  }

  /* ---------------- 画布尺寸 ---------------- */

  function fitCanvas() {
    var cv = state.canvas;
    if (!cv) return false;
    var host = cv.parentElement || null;
    var cssW = cv.clientWidth || (host && host.clientWidth) || 0;
    var cssH = cv.clientHeight || (host && host.clientHeight) || 0;
    var dpr = typeof window !== "undefined" ? window.devicePixelRatio : 1;
    var fit = dprFit(cssW || 320, cssH || 96, dpr);
    if (cv.width !== fit.w) cv.width = fit.w;
    if (cv.height !== fit.h) cv.height = fit.h;
    state.cssW = cssW || 320;
    state.cssH = cssH || 96;
    state.dpr = fit.dpr;
    state.grad = null; // 尺寸变→渐变缓存失效
    return true;
  }

  /* ---------------- 绘制 ---------------- */

  function cw() { return (state.canvas && state.canvas.width) || 1; }
  function ch() { return (state.canvas && state.canvas.height) || 1; }

  function barsGradient() {
    if (state.grad) return state.grad;
    var g = state.g.createLinearGradient(0, ch(), 0, 0);
    g.addColorStop(0, PALETTE.low);
    g.addColorStop(0.55, PALETTE.mid);
    g.addColorStop(1, PALETTE.high);
    state.grad = g;
    return g;
  }

  function waveGradient() {
    if (state.grad) return state.grad;
    var g = state.g.createLinearGradient(0, 0, cw(), 0);
    g.addColorStop(0, PALETTE.low);
    g.addColorStop(0.5, PALETTE.wave);
    g.addColorStop(1, PALETTE.high);
    state.grad = g;
    return g;
  }

  /** AU 风格频域条:对数频率轴 + 四道横向刻度 + 底部基线。 */
  function drawBars() {
    var g2d = state.g;
    var data = state.freq;
    var bars = state.bars;
    if (!g2d || !data) return;
    var w = cw();
    var h = ch();
    var dpr = state.dpr;
    g2d.clearRect(0, 0, w, h);
    // 横向刻度(固定 4 道,填充矩形比 stroke 更省)
    g2d.fillStyle = PALETTE.grid;
    var tickH = Math.max(1, Math.round(dpr * 0.5));
    for (var t = 1; t <= 4; t++) {
      var y = Math.round((h * t) / 5);
      g2d.fillRect(0, y, w, tickH);
    }
    var sr = state.audioCtx ? state.audioCtx.sampleRate : 44100;
    var n = BAR_COUNT;
    var slot = w / n;
    var barW = Math.max(1, slot * 0.72);
    var base = Math.max(1, Math.round(dpr)); // 底部基线厚度
    g2d.fillStyle = barsGradient();
    for (var i = 0; i < n; i++) {
      var b0 = binForRatio(i / n, data.length, sr);
      var b1 = binForRatio((i + 1) / n, data.length, sr);
      var lv = barLevel(data, b0, b1);
      var prev = bars[i];
      var v = prev * DECAY + lv * (1 - DECAY);
      bars[i] = v;
      var hgt = Math.max(1, v * (h - base));
      g2d.fillRect(Math.round(i * slot), h - base - hgt, Math.round(barW), hgt);
    }
    // 底部基线
    g2d.fillStyle = PALETTE.base;
    g2d.fillRect(0, h - base, w, base);
  }

  /** 时域波形:零轴居中,上下对称。 */
  function drawWave() {
    var g2d = state.g;
    var data = state.time;
    if (!g2d || !data) return;
    var w = cw();
    var h = ch();
    var dpr = state.dpr;
    g2d.clearRect(0, 0, w, h);
    var mid = h / 2;
    g2d.fillStyle = PALETTE.grid;
    g2d.fillRect(0, Math.round(mid), w, Math.max(1, Math.round(dpr * 0.5)));
    var amp = mid * 0.86;
    var step = w / (data.length - 1);
    g2d.beginPath();
    for (var i = 0; i < data.length; i++) {
      var y = mid + ((data[i] - 128) / 128) * amp;
      if (i === 0) g2d.moveTo(0, y);
      else g2d.lineTo(i * step, y);
    }
    g2d.lineWidth = Math.max(1, dpr);
    g2d.strokeStyle = waveGradient();
    g2d.stroke();
  }

  function drawNotice(text) {
    var g2d = state.g;
    if (!g2d || !state.canvas) return;
    var w = cw();
    var h = ch();
    g2d.clearRect(0, 0, w, h);
    g2d.fillStyle = PALETTE.base;
    g2d.fillRect(0, h - Math.max(1, Math.round(state.dpr)), w, Math.max(1, Math.round(state.dpr)));
    g2d.fillStyle = PALETTE.notice;
    g2d.font = Math.round(11 * state.dpr) + "px monospace";
    g2d.textAlign = "center";
    g2d.textBaseline = "middle";
    g2d.fillText(text, w / 2, h / 2);
  }

  /** 一帧:读一次分析数据 + 一次绘制(模式分派)。 */
  function tick() {
    var an = state.analyser;
    if (!an || !state.g) return;
    if (state.mode === "wave") {
      an.getByteTimeDomainData(state.time);
      drawWave();
    } else {
      an.getByteFrequencyData(state.freq);
      drawBars();
    }
  }

  function startLoop() {
    if (!state.analyser || !state.attached) return;
    state.run = true;
    if (state.raf) return;
    state.raf = raf(loop);
  }

  function loop() {
    // 暂停/detach 后 run=false:即便有残留回调被调用也立刻断链,保证 rAF 真停、不空转
    if (!state.run || !state.attached || !state.analyser) { state.raf = 0; return; }
    state.raf = raf(loop);
    tick();
  }

  function stopLoop() {
    state.run = false;
    if (state.raf) { unraf(state.raf); state.raf = 0; }
  }

  /* ---------------- 音频图 ---------------- */

  function ensureGraph(media) {
    var Ctor = typeof window !== "undefined" ? window.AudioContext || window.webkitAudioContext : null;
    if (!Ctor) return { ok: false, reason: "audio-context-unavailable" };
    if (!sharedCtx) {
      try { sharedCtx = new Ctor(); } catch (e) { return { ok: false, reason: "audio-context-failed:" + msgOf(e) }; }
    }
    var ctx = sharedCtx;
    if (ctx.state === "suspended" && typeof ctx.resume === "function") {
      try { ctx.resume(); } catch (e) { /* 无手势时可能拒绝,不影响后续 attach */ }
    }
    var src = sourceCache.get(media);
    if (!src) {
      try {
        src = ctx.createMediaElementSource(media);
      } catch (e) {
        // CORS 跨域媒体 / 该元素已被别处建过 source:降级,不抛
        return { ok: false, reason: "media-source-failed:" + msgOf(e) };
      }
      sourceCache.set(media, src);
    }
    var hasAnalyserNode = typeof ctx.createAnalyser === "function";
    if (!hasAnalyserNode) return { ok: false, reason: "analyser-unavailable" };
    var an;
    try { an = ctx.createAnalyser(); } catch (e) { return { ok: false, reason: "analyser-failed:" + msgOf(e) }; }
    an.fftSize = FFT_SIZE;
    an.smoothingTimeConstant = 0.75;
    try { src.disconnect(); } catch (e) { /* 未连接时 disconnect 可安全忽略 */ }
    try {
      src.connect(an);
      // 分析支路必须一路接到 destination:media 元素被 createMediaElementSource 接管后,
      // 不接 destination 就彻底静音。
      an.connect(ctx.destination);
    } catch (e) {
      return { ok: false, reason: "connect-failed:" + msgOf(e) };
    }
    return { ok: true, ctx: ctx, src: src, an: an };
  }

  /* ---------------- 对外 API ---------------- */

  function degrade(reason) {
    state.degraded = true;
    state.attached = false;
    if (state.g && state.canvas) {
      try { fitCanvas(); drawNotice("频谱不可用:" + reason); } catch (e) { /* 画布不可用就算了 */ }
    }
    if (typeof console !== "undefined" && console.warn) console.warn("[ide-spectrum] 降级:" + reason);
    return { ok: false, reason: reason };
  }

  function attach(opts) {
    var canvas = opts && opts.canvas;
    var media = opts && opts.media;
    try {
      if (state.attached) detach();
      if (typeof window === "undefined") return Promise.resolve({ ok: false, reason: "no-window" });
      if (!canvas || typeof canvas.getContext !== "function") return Promise.resolve(degrade("canvas-unusable"));
      if (!media || typeof media.addEventListener !== "function") return Promise.resolve(degrade("media-unusable"));
      state.canvas = canvas;
      state.media = media;
      state.degraded = false;
      var g2d = null;
      try { g2d = canvas.getContext("2d"); } catch (e) { g2d = null; }
      if (!g2d) return Promise.resolve(degrade("canvas-2d-unavailable"));
      state.g = g2d;
      fitCanvas();
      var graph = ensureGraph(media);
      if (!graph.ok) {
        state.g = g2d; // 保留 2D 上下文以便写降级文案
        return Promise.resolve(degrade(graph.reason));
      }
      state.audioCtx = graph.ctx;
      state.source = graph.src;
      state.analyser = graph.an;
      state.freq = new Uint8Array(graph.an.frequencyBinCount);
      state.time = new Uint8Array(graph.an.fftSize);
      state.bars = new Float32Array(BAR_COUNT);
      state.grad = null;
      // 媒体事件:暂停/结束→停 rAF 并画一帧静止图(不空转);播放→恢复循环
      state.onPlay = function () { startLoop(); };
      state.onStop = function () { stopLoop(); tick(); };
      media.addEventListener("play", state.onPlay);
      media.addEventListener("playing", state.onPlay);
      media.addEventListener("pause", state.onStop);
      media.addEventListener("ended", state.onStop);
      // 容器尺寸跟随(ResizeObserver 优先,退化到 window.resize)
      if (typeof ResizeObserver === "function") {
        state.ro = new ResizeObserver(function () { fitCanvas(); if (!state.raf) tick(); });
        try { state.ro.observe(canvas.parentElement || canvas); } catch (e) { state.ro = null; }
      } else if (typeof window.addEventListener === "function") {
        state.onResize = function () { fitCanvas(); if (!state.raf) tick(); };
        window.addEventListener("resize", state.onResize);
      }
      state.attached = true;
      tick(); // 先出一帧(暂停态=静止图,播放态=立刻有读数)
      if (!media.paused) startLoop();
      return Promise.resolve({ ok: true });
    } catch (e) {
      return Promise.resolve(degrade("attach-failed:" + msgOf(e)));
    }
  }

  function detach() {
    // 幂等:重复调用不抛、不重复断连
    stopLoop();
    var media = state.media;
    if (media) {
      if (state.onPlay) {
        try { media.removeEventListener("play", state.onPlay); } catch (e) { /* noop */ }
        try { media.removeEventListener("playing", state.onPlay); } catch (e) { /* noop */ }
      }
      if (state.onStop) {
        try { media.removeEventListener("pause", state.onStop); } catch (e) { /* noop */ }
        try { media.removeEventListener("ended", state.onStop); } catch (e) { /* noop */ }
      }
    }
    if (state.ro) { try { state.ro.disconnect(); } catch (e) { /* noop */ } state.ro = null; }
    if (state.onResize && typeof window !== "undefined" && window.removeEventListener) {
      try { window.removeEventListener("resize", state.onResize); } catch (e) { /* noop */ }
    }
    if (state.analyser) { try { state.analyser.disconnect(); } catch (e) { /* noop */ } }
    // 交还音频通道:分析支路断开后把 source 直连 destination,否则 detach 后播放变哑
    if (state.source) {
      try { state.source.disconnect(); } catch (e) { /* noop */ }
      if (state.audioCtx && state.audioCtx.destination) {
        try { state.source.connect(state.audioCtx.destination); } catch (e) { /* noop */ }
      }
    }
    state.analyser = null;
    state.source = null;
    state.audioCtx = null;
    state.media = null;
    state.canvas = null;
    state.g = null;
    state.freq = null;
    state.time = null;
    state.bars = null;
    state.grad = null;
    state.onPlay = null;
    state.onStop = null;
    state.onResize = null;
    state.attached = false;
    state.degraded = false;
    return { ok: true };
  }

  function setMode(mode) {
    state.mode = modeOf(mode);
    state.grad = null;            // 两种模式渐变方向不同,换模式即失效
    if (state.attached && !state.raf) tick(); // 暂停态切换:立刻重画静止图
    return state.mode;
  }

  function isAttached() {
    return !!state.attached;
  }

  var TEST_API = {
    freqForRatio: freqForRatio,
    maxHzFor: maxHzFor,
    binForRatio: binForRatio,
    dprFit: dprFit,
    barLevel: barLevel,
    modeOf: modeOf,
    constants: { MIN_HZ: MIN_HZ, BAR_COUNT: BAR_COUNT, FFT_SIZE: FFT_SIZE, MAX_DPR: MAX_DPR, DECAY: DECAY },
  };

  var api = {
    attach: attach,
    detach: detach,
    setMode: setMode,
    isAttached: isAttached,
    RED: RED,
    __test: TEST_API,
  };

  if (typeof window !== "undefined") {
    window.IdeSpectrum = api;
  } else if (typeof globalThis !== "undefined") {
    // 无 window(node 单测)时退到 globalThis:纯函数与降级分支可在无 DOM 环境验证
    globalThis.IdeSpectrum = api;
  }
})();
