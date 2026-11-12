/**
 * 面板分片:script-annotate(逐字自 panel.ts PAGE 模板搬移, 拆分)。
 * 模板约束沿袭:不得出现裸反引号与 ${。
 */
export const PANEL_JS_ANNOTATE = `
<!-- 截图标注(2026-10-26,面板自有能力):取屏画框覆盖层 + 标注编辑器。
 交互:框选/点/全局三类编号批注,侧栏卡片写意见,拖动调位置;
 提交后服务端落盘 <项目>/.genie/feedback/ 并把反馈投递给当前会话的 coding agent。 -->
<div id="capOverlay" style="display:none">
  <canvas id="capCanvas"></canvas>
  <div id="capSel" style="display:none"></div>
  <div id="capSize" style="display:none"></div>
  <div id="capBar" style="display:none">
    <button id="capOk" type="button">确认截图</button>
    <button id="capReset" type="button">重选</button>
    <button id="capCancel" type="button">取消</button>
  </div>
  <div id="capHint">拖拽框选要标注的区域 · 双击=整屏 · Enter 确认 · Esc 取消</div>
</div>
<!-- 录屏批注:屏幕+笔迹+麦克风实时合成,停止后可回放并交 omni 解析 -->
<div id="annvOverlay" style="display:none">
  <canvas id="annvCanvas"></canvas>
  <div id="annvBar">
    <span id="annvTimer">● 0:00</span>
    <button class="ann-tbtn" id="annvPen" type="button" title="自由笔(默认)">画笔</button>
    <button class="ann-tbtn" id="annvRect" type="button" title="框选区域">框选</button>
    <button class="ann-tbtn" id="annvClear" type="button" title="清掉已画笔迹">清笔迹</button>
    <span id="annvHint">在画面上拖动即标注 · 空格=临时平移 · 停止后整段可回放并解析</span>
    <button class="ann-tbtn" id="annvPause" type="button" title="暂停录制(暂停期笔迹不记录,避免与视频时间轴错位)">暂停</button>
    <button class="ann-tbtn" id="annvStop" type="button">停止</button>
    <button class="ann-tbtn" id="annvCancel" type="button">取消</button>
  </div>
</div>
<div id="annEditor" style="display:none">
  <div id="annTop">
    <strong>截图标注</strong>
    <span id="annMeta"></span>
    <span id="annCoords" title="指针位置(图像像素)"></span>
    <input id="annPage" type="text" placeholder="页面说明(可选,帮 agent 定位)" maxlength="500" title="描述截图所在的页面/界面,随反馈保存(≤500 字)">
    <span class="ann-sp"></span>
    <button class="ann-tbtn" id="annImportBtn" type="button" title="打开本地图片继续标注(也可在编辑器里直接粘贴图片)">导入图片</button>
    <input type="file" id="annImportInput" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" style="display:none">
    <button class="ann-tbtn" id="annFitBtn" type="button" title="适应窗口(快捷键 0)">适应</button>
    <button class="ann-tbtn" id="annZoomOut" type="button" title="缩小(-)">−</button>
    <span id="annZoomLabel">100%</span>
    <button class="ann-tbtn" id="annZoomIn" type="button" title="放大(+)">+</button>
    <button class="ann-tbtn" id="annUndoBtn" type="button" title="撤销(Ctrl+Z)">撤销</button>
    <button class="ann-tbtn" id="annRedoBtn" type="button" title="重做(Ctrl+Y)">重做</button>
    <span class="ann-sp"></span>
    <button class="ann-tbtn" id="annRecBtn" type="button" title="录音评论(再点停止;最长 120s)">● 录音</button>
    <span id="annRecState"></span>
    <audio id="annRecAudio" controls style="display:none;height:26px"></audio>
    <button class="ann-tbtn" id="annRecDel" type="button" style="display:none" title="删除录音">删除录音</button>
    <button class="ann-tbtn" id="annScreenRecBtn" type="button" title="录屏批注:录屏幕+笔迹+麦克风,停止后可回放并交给 omni 解析成任务书">● 录屏批注</button>
    <span id="annVidState"></span>
    <video id="annVidPreview" controls style="display:none;height:26px;max-width:220px"></video>
    <button class="ann-tbtn" id="annVidDel" type="button" style="display:none" title="删除录制">删除录制</button>
    <button class="ann-tbtn" id="annClear" type="button" title="清空全部批注">清空</button>
    <button class="ann-tbtn" id="annCancel" type="button">关闭</button>
    <button id="annSend" type="button" title="批注写入 .genie/feedback/ 并发送给当前会话的任务">发送给任务</button>
  </div>
  <div id="annMain">
    <div id="annViewport">
      <div id="annStage">
        <canvas id="annCanvas"></canvas>
        <svg id="annOverlay" xmlns="http://www.w3.org/2000/svg"></svg>
        <div id="annPins"></div>
      </div>
    </div>
    <div id="annSide">
      <div id="annTools">
        <button class="ann-tool active" data-amode="smart" type="button" title="智能选块:悬停自动识别界面块,点击即批注;拖拽=手动框选(B)">选块</button>
        <button class="ann-tool" data-amode="select" type="button" title="选择/移动/缩放批注(V)">选择</button>
        <button class="ann-tool" data-amode="rect" type="button" title="拖拽框选一个区域写意见(R)">框选</button>
        <button class="ann-tool" data-amode="point" type="button" title="点一下,精确指向一个位置(P)">点选</button>
        <button class="ann-tool" data-amode="global" type="button" title="对整张截图写整体意见(G)">整体</button>
        <button class="ann-tool" id="annCompBtn" type="button" title="组件模式:基于自动识别切出可搬动的组件,拖动即表达布局意图(反馈含 movement)">组件</button>
      </div>
      <div id="annHint">选块:悬停识别,点击即批注(旁框输意见,Enter 保存),滚轮缩放,[ ] 换块 · V 选择 R 框选 P 点选 G 整体 · 方向键微调 · 空格拖移</div>
      <div id="annCards"></div>
    </div>
    <div id="annInline" style="display:none">
      <textarea id="annInlineText" rows="2" maxlength="10000" placeholder="写下修改意见…"></textarea>
      <div class="ann-inline-bar"><span>Enter 保存 · Esc 取消</span><button id="annInlineOk" type="button">保存</button></div>
    </div>
  </div>
</div>
<script>
/* 截图标注链路(独立脚本块:只依赖全局 toast/wsSafeSend/currentSid,便于单独编译守卫)。
 交互模型:note 模型/pin 编号/几何语义,
 实现为 lampgenie-harness 自有代码;提交协议 annotate.submit 见 protocol。 */
(function () {
  "use strict";
  var capOverlay = document.getElementById("capOverlay");
  var capCanvas = document.getElementById("capCanvas");
  var capSel = document.getElementById("capSel");
  var capSize = document.getElementById("capSize");
  var capBar = document.getElementById("capBar");
  var capHint = document.getElementById("capHint");
  var editor = document.getElementById("annEditor");
  var viewport = document.getElementById("annViewport");
  var stage = document.getElementById("annStage");
  var canvas = document.getElementById("annCanvas");
  var overlay = document.getElementById("annOverlay");
  var pins = document.getElementById("annPins");
  var cards = document.getElementById("annCards");
  var annMain = document.getElementById("annMain");
  var sendBtn = document.getElementById("annSend");
  var recBtn = document.getElementById("annRecBtn");
  var recState = document.getElementById("annRecState");
  var recAudio = document.getElementById("annRecAudio");
  var recDel = document.getElementById("annRecDel");
 // cap:取屏画框态;ann:编辑器态。几何一律图像像素(int),显示换算 zoom。
  var cap = null; // {url, img, scale, cssW, cssH, dpr, ox, oy, drag, sel:{x,y,w,h}}
  var ann = null; // {dataUrl,img,w,h,zoom,px,py,notes,sel,mode,drag,undo,redo,sending,rec}
  var KIND_LABEL = { region: "框选", point: "点选", global: "整体" };

 /* ---------- 坐标换算唯一入口(assets/annotate-coords.js) ----------
 取屏覆盖层与标注编辑器共用同一套换算;资产缺失时用等价最小实现兜底并告警(绝不抛)。 */
  var COORDS = (typeof window !== "undefined" && window.GenieAnnotateCoords) || null;
  if (!COORDS || typeof COORDS.clientToImage !== "function") {
    try { console.warn("[annotate] /assets/annotate-coords.js 未加载,使用内联坐标换算兜底"); } catch (e) { /* 无控制台 */ }
    COORDS = (function () {
      function n(v, d) { var x = Number(v); return isFinite(x) ? x : d; }
      function prep(b) {
        var s = n(b.scale, 1); if (!(s > 0)) s = 1;
        var iw = n(b.imgWidth, 0), ih = n(b.imgHeight, 0), w = n(b.width, 0), h = n(b.height, 0);
        var lw = n(b.layoutWidth, iw * s) || iw * s, lh = n(b.layoutHeight, ih * s) || ih * s;
        return { left: n(b.left, 0), top: n(b.top, 0), kx: w > 0 && lw > 0 ? lw / w : 1, ky: h > 0 && lh > 0 ? lh / h : 1, ox: n(b.offsetX, 0), oy: n(b.offsetY, 0), s: s };
      }
      return {
        clientToImage: function (p, b) { var k = prep(b || {}); return { x: ((n(p.x, 0) - k.left) * k.kx - k.ox) / k.s, y: ((n(p.y, 0) - k.top) * k.ky - k.oy) / k.s }; },
        imageToClient: function (p, b) { var k = prep(b || {}); return { x: k.left + (n(p.x, 0) * k.s + k.ox) / k.kx, y: k.top + (n(p.y, 0) * k.s + k.oy) / k.ky }; },
        bitmapOf: function (w, h, dpr) { var d = n(dpr, 1); if (!(d > 0)) d = 1; return { width: Math.max(1, Math.round(n(w, 1) * d)), height: Math.max(1, Math.round(n(h, 1) * d)) }; },
        fitScale: function (iw, ih, bw, bh, o) {
          iw = n(iw, 0); ih = n(ih, 0); bw = n(bw, 0); bh = n(bh, 0);
          if (!(iw > 0) || !(ih > 0) || !(bw > 0) || !(bh > 0)) return 1;
          var opt = o || {}, s = opt.cover ? Math.max(bw / iw, bh / ih) : Math.min(bw / iw, bh / ih);
          if (!opt.cover && opt.cap1) s = Math.min(s, 1);
          return s > 0 ? s : 1;
        },
      };
    })();
  }
  function annCoords() { return (typeof window !== "undefined" && window.GenieAnnotateCoords) || COORDS; }

  function esc(text) { return String(text).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

 /* ---------- 取屏(微信截图式:整屏冻结 1:1 覆盖,真实尺寸上画框/选点;滚轮缩放,空格平移) ---------- */
  function startScreenShot() {
    if (cap || ann) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      toast("当前环境不支持屏幕截取,请在 Chrome/Edge 浏览器或桌面应用中使用", 1); return;
    }
    navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "monitor" }, audio: false }).then(function (stream) {
      var video = document.createElement("video");
      video.srcObject = stream; video.muted = true; video.playsInline = true;
      var grabTries = 0;
      var grab = function () {
        var w = video.videoWidth, h = video.videoHeight;
 // 显示器休眠/窗口最小化时 Windows 会递微型帧(<200px):继续等,拿不到真帧不进画框
        if ((!w || !h || w < 200) && grabTries++ < 25) { setTimeout(grab, 160); return; }
        if (!w || !h || w < 200) { stream.getTracks().forEach(function (t) { t.stop(); }); toast("屏幕画面暂不可读(显示器休眠或锁定?),请点亮屏幕后重试", 1); return; }
        var c = document.createElement("canvas"); c.width = w; c.height = h;
        c.getContext("2d").drawImage(video, 0, 0, w, h);
        stream.getTracks().forEach(function (t) { t.stop(); });
        var url = c.toDataURL("image/png");
        var img = new Image();
        img.onload = function () {
 // 桌面壳:先整窗全屏(微信式整屏冻结,cover);浏览器:窗口内 contain 适配
          enterCaptureFullscreen(function (isFull) { openCaptureOverlay(url, img, isFull); });
        };
        img.src = url;
      };
      video.play().then(function () { requestAnimationFrame(function () { requestAnimationFrame(grab); }); }).catch(function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        toast("屏幕画面读取失败,请重试", 1);
      });
    }).catch(function (err) {
      if (err && err.name === "NotAllowedError") { toast("已取消屏幕选取"); return; }
      toast("屏幕截取失败:" + String(err && err.message || err).slice(0, 120), 1);
    });
  }
 // 桌面桥:整窗全屏进出(等视口真正变大再回调,避免遮罩按旧尺寸取景)
 // 回调参数=是否真的进了全屏:浏览器/无桥时恒 false,覆盖层必须走 contain(否则取景被 cover 裁掉边界,
 // 表现为「框到的位置不是鼠标点的位置」——E2E 经验证:浏览器路径误用 cover,选区整体偏移)。
  function enterCaptureFullscreen(done) {
    var bridge = window.genieWindow;
    if (!(bridge && bridge.captureEnter)) { done(false); return; }
    try { bridge.captureEnter(); } catch (e) { done(false); return; }
    var tries = 0;
    var wait = function () {
      tries++;
      if (window.innerWidth >= (window.screen || { width: 0 }).width * 0.9 || tries > 14) { setTimeout(function () { done(true); }, 140); return; }
      setTimeout(wait, 80);
    };
    setTimeout(wait, 60);
  }
  function exitCaptureFullscreen() {
    try { if (window.genieWindow && window.genieWindow.captureExit) window.genieWindow.captureExit(); } catch (e) { /* 无害 */ }
  }
  function openCaptureOverlay(url, img, fullscreen) {
    var vw = Math.max(320, window.innerWidth), vh = Math.max(240, window.innerHeight);
    var C = annCoords();
 // 初始与最小缩放都用 contain(整张截图完整可见,且随时能缩回全图)。
 // 旧实现 fullscreen 分支用 cover:跨屏/异比例截图初始即被裁边,且下限=cover 永远缩不回全图(用户经验证)。
    var scale = C.fitScale(img.naturalWidth, img.naturalHeight, vw, vh, { cap1: true });
    var dpr = Math.max(1, window.devicePixelRatio || 1);
    var bmp = C.bitmapOf(vw, vh, dpr); // 位图=device px(#capCanvas CSS 100%/100%,换算层吃 dpr 与盒子压缩)
    cap = { url: url, img: img, scale: scale, cover: scale, minScale: scale, maxScale: scale * 8, cssW: vw, cssH: vh, dpr: dpr,
      ox: (vw - img.naturalWidth * scale) / 2, oy: (vh - img.naturalHeight * scale) / 2, fullscreen: !!fullscreen,
      drag: null, pan: null, sel: null, spaceDown: false, capturedAt: new Date().toISOString() };
    capCanvas.width = bmp.width; capCanvas.height = bmp.height;
    capSel.style.display = "none"; capSize.style.display = "none"; capBar.style.display = "none";
    capHint.style.display = "";
    capOverlay.style.display = "flex";
    capPaint();
  }
  function closeCaptureOverlay() {
    if (cap && cap.fullscreen) exitCaptureFullscreen(); // 先退全屏(窗口回原尺寸)
    cap = null; capOverlay.style.display = "none";
  }
 /** 取屏覆盖层的换算盒(布局空间:cap.ox/oy/scale/选区全部用「布局 CSS px」,与 capPaint 同一坐标)。
 * 注意:这里必须 offset=0/scale=1——若把 cap.scale 与 cap.ox 一起塞进来,clientToImage 会额外
 * 除以 cap.scale 得到「图像原生像素」,而 cap.sel/cap.ox 的消费方(capPaint/confirmCapture)按
 * 布局 px 解释它,结果就是「框的位置与鼠标落点成比例偏移」(E2E 经验证:350×280 的拖框被算成
 * 300×400 的选区)。图像像素换算只在 confirmCapture 里做一次((x-ox)/scale)。 */
  function capBox(r) {
    return { left: r.left, top: r.top, width: r.width, height: r.height,
      imgWidth: cap.img.naturalWidth, imgHeight: cap.img.naturalHeight,
      offsetX: 0, offsetY: 0, scale: 1, layoutWidth: cap.cssW, layoutHeight: cap.cssH };
  }
  function capPaint() {
    if (!cap) return;
    var g = capCanvas.getContext("2d");
    var dpr = cap.dpr || 1;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, capCanvas.width, capCanvas.height);
 // 位图=device px、绘制坐标=布局 CSS px:dpr 只提清晰度,不改几何(dpr 非偏移源)
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "#000"; g.fillRect(0, 0, cap.cssW, cap.cssH);
    var dw = cap.img.naturalWidth * cap.scale, dh = cap.img.naturalHeight * cap.scale;
    g.drawImage(cap.img, cap.ox, cap.oy, dw, dh);
    var s = cap.sel;
    if (s && s.w > 0 && s.h > 0) {
 // 选区外压暗(四条带),选区描边(微信式)
      g.fillStyle = "rgba(0,0,0,.45)";
      g.fillRect(0, 0, cap.cssW, Math.max(0, s.y));
      g.fillRect(0, s.y + s.h, cap.cssW, Math.max(0, cap.cssH - s.y - s.h));
      g.fillRect(0, s.y, Math.max(0, s.x), s.h);
      g.fillRect(s.x + s.w, s.y, Math.max(0, cap.cssW - s.x - s.w), s.h);
      g.strokeStyle = "#c98f45"; g.lineWidth = 1.5; g.strokeRect(s.x, s.y, s.w, s.h);
    }
  }
  function capPaintSelChrome() {
    if (!cap || !cap.sel || cap.sel.w < 1) { capSize.style.display = "none"; capBar.style.display = "none"; return; }
    var C = annCoords(), s = cap.sel, r = capCanvas.getBoundingClientRect();
    var tl = C.imageToClient({ x: s.x, y: s.y }, capBox(r)), br = C.imageToClient({ x: s.x + s.w, y: s.y + s.h }, capBox(r));
    var iw = Math.round(s.w / cap.scale), ih = Math.round(s.h / cap.scale);
    capSize.textContent = iw + " × " + ih;
    capSize.style.display = "block";
    capSize.style.left = tl.x + "px"; capSize.style.top = Math.max(2, tl.y - 24) + "px";
    var bw = 190, bh = 46;
    var bx = clamp(br.x - bw, 8, window.innerWidth - bw - 8);
    var by = br.y + 10; if (by + bh > window.innerHeight - 8) by = Math.max(8, tl.y - bh - 10);
    capBar.style.left = bx + "px"; capBar.style.top = by + "px";
    capBar.style.display = "flex";
  }
 /** 指针 → 布局空间坐标(client 归一后,cap.sel/cap.ox 同一坐标系;上界=布局尺寸,不再用位图 device px)。 */
  function capPos(ev) {
    var r = capCanvas.getBoundingClientRect();
    var C = annCoords(); // 唯一换算入口:assets/annotate-coords.js → window.GenieAnnotateCoords
    var p = C.clientToImage({ x: ev.clientX, y: ev.clientY }, capBox(r));
    return { x: clamp(p.x, 0, cap.cssW), y: clamp(p.y, 0, cap.cssH) };
  }
  capCanvas && (capCanvas.onpointerdown = function (ev) {
    if (!cap) return;
    if (ev.button === 1 || (ev.button === 0 && cap.spaceDown)) { // 空格/中键=平移
      cap.drag = null; cap.pan = { sx: ev.clientX, sy: ev.clientY, ox: cap.ox, oy: cap.oy };
      capCanvas.setPointerCapture(ev.pointerId);
      ev.preventDefault();
      return;
    }
    if (ev.button !== 0) return;
    var p = capPos(ev);
    cap.pan = null;
    cap.drag = { sx: p.x, sy: p.y };
    cap.sel = { x: p.x, y: p.y, w: 0, h: 0 };
    capHint.style.display = "none";
    capCanvas.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  capCanvas && (capCanvas.onpointermove = function (ev) {
    if (!cap) return;
    if (cap.pan) {
 // 拖动位移落在 client CSS px,cap.ox 在布局空间 → 按两轴归一系数换算(否则高 DPR/有滚动条时平移量偏小)
      var rp = capCanvas.getBoundingClientRect();
      var kx = rp.width > 0 ? cap.cssW / rp.width : 1, ky = rp.height > 0 ? cap.cssH / rp.height : 1;
      var nx = cap.pan.ox + (ev.clientX - cap.pan.sx) * kx;
      var ny = cap.pan.oy + (ev.clientY - cap.pan.sy) * ky;
      var dxL = nx - cap.ox, dyL = ny - cap.oy; // 本次增量(布局 px)
      cap.ox = nx; cap.oy = ny;
      if (cap.sel) { cap.sel.x += dxL; cap.sel.y += dyL; capPaintSelChrome(); } // 选框跟图一起走,不平移=脱离内容
      capPaint();
      return;
    }
    if (!cap.drag) return;
    var p = capPos(ev);
    cap.sel = { x: Math.min(cap.drag.sx, p.x), y: Math.min(cap.drag.sy, p.y), w: Math.abs(p.x - cap.drag.sx), h: Math.abs(p.y - cap.drag.sy) };
    capPaint();
    capPaintSelChrome();
  });
  capCanvas && (capCanvas.onpointerup = function (ev) {
    if (!cap) return;
    if (cap.pan && cap.pan.sx !== undefined) { try { capCanvas.releasePointerCapture(ev.pointerId); } catch (e) { /* 已释放 */ } cap.pan = null; return; }
    if (cap.drag) { try { capCanvas.releasePointerCapture(ev.pointerId); } catch (e) { /* 已释放 */ } cap.drag = null; capPaint(); capPaintSelChrome(); }
  });
  capCanvas && (capCanvas.onwheel = function (ev) {
    if (!cap) return;
    ev.preventDefault();
    var lp = capPos(ev), mx = lp.x, my = lp.y; // 光标锚定:换算到布局空间(与 cap.ox/scale 同坐标)
    var factor = Math.exp(-ev.deltaY * 0.0016);
    var minS = cap.minScale || cap.cover, maxS = cap.maxScale || (cap.cover || 1) * 8;
    var next = clamp(cap.scale * factor, minS, maxS);
    if (next === cap.scale) return;
    var k = next / cap.scale;
    cap.ox = mx - (mx - cap.ox) * k; cap.oy = my - (my - cap.oy) * k; // 光标锚定缩放
    if (cap.sel) { // 已框出的选区同锚点等比变换:缩放后选框仍贴住同一块图像内容(否则一滚轮选框就脱钩)
      cap.sel = { x: mx - (mx - cap.sel.x) * k, y: my - (my - cap.sel.y) * k, w: cap.sel.w * k, h: cap.sel.h * k };
    }
    cap.scale = next;
    capPaint();
    capPaintSelChrome();
  }, { passive: false });
  function confirmCapture() {
    if (!cap || !cap.sel || cap.sel.w < 6 || cap.sel.h < 6) { toast("先拖拽框选一块区域"); return; }
    var s = cap.sel, sc = cap.scale;
 // 画布坐标→原图像素(含平移偏移),并夹进图像边界(缩放后选区可能伸出画面)
    var ix1 = clamp(Math.round((s.x - cap.ox) / sc), 0, cap.img.naturalWidth - 1);
    var iy1 = clamp(Math.round((s.y - cap.oy) / sc), 0, cap.img.naturalHeight - 1);
    var ix2 = clamp(Math.round((s.x + s.w - cap.ox) / sc), ix1 + 1, cap.img.naturalWidth);
    var iy2 = clamp(Math.round((s.y + s.h - cap.oy) / sc), iy1 + 1, cap.img.naturalHeight);
    var sw = ix2 - ix1, sh = iy2 - iy1;
    var c = document.createElement("canvas"); c.width = sw; c.height = sh;
    c.getContext("2d").drawImage(cap.img, ix1, iy1, sw, sh, 0, 0, sw, sh);
    var url = c.toDataURL("image/png");
 // 超大选区预防性降采样:PNG dataURL 会整个进 WS 帧(服务端上限 24MB,base64 膨胀 4/3)
    var LIMIT = 12 * 1024 * 1024;
    var scaleDown = 1;
    for (var tries = 0; tries < 6 && url.length > LIMIT; tries++) {
      scaleDown *= 0.7;
      var dw = Math.max(1, Math.round(sw * scaleDown)), dh = Math.max(1, Math.round(sh * scaleDown));
      var dc = document.createElement("canvas"); dc.width = dw; dc.height = dh;
      var dg = dc.getContext("2d"); dg.imageSmoothingQuality = "high";
      dg.drawImage(c, 0, 0, dw, dh);
      url = dc.toDataURL("image/png");
    }
    if (scaleDown < 1) toast("选区过大,已降采样 " + Math.round(scaleDown * 100) + "% 后提交");
    var capturedAt = cap.capturedAt;
    closeCaptureOverlay(); // 内含退全屏
    setTimeout(function () { openAnnotateEditor(url, { source: "screen", capturedAt: capturedAt }); }, 120);
  }
  document.getElementById("capOk") && (document.getElementById("capOk").onclick = confirmCapture);
  capCanvas && (capCanvas.ondblclick = function () { // 双击=选中画面里可见的整块
    if (!cap) return;
    cap.sel = { x: cap.ox, y: cap.oy, w: cap.img.naturalWidth * cap.scale, h: cap.img.naturalHeight * cap.scale };
    capPaint(); capPaintSelChrome();
  });
  document.getElementById("capReset") && (document.getElementById("capReset").onclick = function () { if (cap) { cap.sel = null; cap.drag = null; capSize.style.display = "none"; capBar.style.display = "none"; capHint.style.display = ""; capPaint(); } });
  document.getElementById("capCancel") && (document.getElementById("capCancel").onclick = closeCaptureOverlay);

 /* ---------- 智能选块(自研启发式:缩小采样上做「颜色量化连通域 + 边缘密度」两类选块,
 小面积优先去重;纯本地计算,图像数据不出浏览器。「量化+连通域+边缘密度」的思路
 参考开源截图批注工具的通用做法) ---------- */
  function annDetectRegions(rgba, w, h, ow, oh, opts) {
    ow = ow || w; oh = oh || h;
    if (w < 16 || h < 16) return [];
 // 尺寸闸可参数化:全局检测用默认(8×6 整图像素);放大后的「细检」必须降到 3px 级,
 // 否则 10px 小标签在原图里只有 3-6px,重跑再多次也过不了同一道闸(第三轮)。
    var G = opts || {};
    var minW = G.minW || 8, minH = G.minH || 6;
    var blobW = G.blobW || 10, blobH = G.blobH || 8, blobN = G.blobN || 60;
    var edgeW = G.edgeW || 10, edgeH = G.edgeH || 6, edgeN = G.edgeN || 20;
    var bandH = G.bandH || 5, bandW = G.bandW || 6;
    var count = w * h, palette = new Int32Array(count), edgeMap = new Int32Array(count), found = [];
    function areaOf(r) { return (r.x2 - r.x1) * (r.y2 - r.y1); }
    function pushCandidate(r, label) {
      var b = { x1: Math.max(0, Math.floor(r.x1 * ow / w)), y1: Math.max(0, Math.floor(r.y1 * oh / h)), x2: Math.min(ow, Math.ceil(r.x2 * ow / w)), y2: Math.min(oh, Math.ceil(r.y2 * oh / h)) };
      if (b.x2 - b.x1 < minW || b.y2 - b.y1 < minH || areaOf(b) > ow * oh * 0.9) return;
      found.push({ bounds: b, label: label });
    }
 // 框的四条边是否接近单色(与左上角像素同色):判断「实心色块」还是「镂空框」。
    function rimUniform(r) {
      var base = palette[r.y1 * w + r.x1], hits = 0, total = 0, x, y;
      for (x = r.x1; x < r.x2; x++) { hits += (palette[r.y1 * w + x] === base ? 1 : 0) + (palette[(r.y2 - 1) * w + x] === base ? 1 : 0); total += 2; }
      for (y = r.y1; y < r.y2; y++) { hits += (palette[y * w + r.x1] === base ? 1 : 0) + (palette[y * w + r.x2 - 1] === base ? 1 : 0); total += 2; }
      return hits / total;
    }
 // 4 连通连通域,逐个报包围盒与像素数(skipZero 时跳过 0 值)。
    function blobs(map, skipZero, emit) {
      var seen = new Uint8Array(map.length), stack = new Int32Array(map.length), from;
      for (from = 0; from < map.length; from++) {
        if (seen[from] || (skipZero && map[from] === 0)) continue;
        var top = 0, size = 0, value = map[from], x1 = from % w, x2 = x1, y1 = (from - x1) / w, y2 = y1;
        stack[top++] = from; seen[from] = 1;
        while (top > 0) {
          var i = stack[--top], x = i % w, y = (i - x) / w;
          size++;
          if (x < x1) x1 = x; if (x > x2) x2 = x;
          if (y < y1) y1 = y; if (y > y2) y2 = y;
          if (x > 0 && !seen[i - 1] && map[i - 1] === value) { seen[i - 1] = 1; stack[top++] = i - 1; }
          if (x + 1 < w && !seen[i + 1] && map[i + 1] === value) { seen[i + 1] = 1; stack[top++] = i + 1; }
          if (y > 0 && !seen[i - w] && map[i - w] === value) { seen[i - w] = 1; stack[top++] = i - w; }
          if (y + 1 < h && !seen[i + w] && map[i + w] === value) { seen[i + w] = 1; stack[top++] = i + w; }
        }
        emit({ x1: x1, y1: y1, x2: x2 + 1, y2: y2 + 1 }, size);
      }
    }
 // 掩码膨胀(半径 rx/ry 的居中矩形窗),逐行/逐列前缀和实现。
    function spread(mask, rx, ry) {
      var tmp = new Uint8Array(mask.length), out = new Uint8Array(mask.length), x, y;
      for (y = 0; y < h; y++) {
        var pre = new Int32Array(w + 1);
        for (x = 0; x < w; x++) pre[x + 1] = pre[x] + mask[y * w + x];
        for (x = 0; x < w; x++) {
          tmp[y * w + x] = pre[Math.min(w, x + rx + 1)] - pre[Math.max(0, x - rx)] > 0 ? 1 : 0;
        }
      }
      for (x = 0; x < w; x++) {
        var col = new Int32Array(h + 1);
        for (y = 0; y < h; y++) col[y + 1] = col[y] + tmp[y * w + x];
        for (y = 0; y < h; y++) {
          out[y * w + x] = col[Math.min(h, y + ry + 1)] - col[Math.max(0, y - ry)] > 0 ? 1 : 0;
        }
      }
      return out;
    }
    var i, x, y;
    for (i = 0; i < count; i++) palette[i] = (rgba[i * 4] >> 3) * 1024 + (rgba[i * 4 + 1] >> 3) * 32 + (rgba[i * 4 + 2] >> 3);
    blobs(palette, false, function (r, n) {
      var fill = n / areaOf(r);
 // 5bit 量化 + 更细尺寸/像素闸:低对比嵌套小框不再被并进父块(选块增强)
      if (r.x2 - r.x1 >= blobW && r.y2 - r.y1 >= blobH && n > blobN && (fill >= 0.7 || (fill >= 0.22 && rimUniform(r) > 0.86))) pushCandidate(r, "色块区域");
    });
    function channelJump(a, b) { return Math.max(Math.abs(rgba[a * 4] - rgba[b * 4]), Math.abs(rgba[a * 4 + 1] - rgba[b * 4 + 1]), Math.abs(rgba[a * 4 + 2] - rgba[b * 4 + 2])); }
    for (y = 1; y < h - 1; y++) for (x = 1; x < w - 1; x++) { var ii = y * w + x; if (channelJump(ii, ii + 1) > 36 || channelJump(ii, ii + w) > 36) edgeMap[ii] = 1; }
    blobs(spread(edgeMap, 1, 1), true, function (r, n) {
      if (r.x2 - r.x1 >= edgeW && r.y2 - r.y1 >= edgeH && n >= edgeN) { r.x1 = Math.max(0, r.x1 + 1); r.x2 = Math.min(w, r.x2 - 1); pushCandidate(r, "内容区域"); }
    });
 // 第三路:文字行/块内小元素(边缘行带分割)。连通域把「一块面板」当整体,块里的一行字、
 // 一个图标+文字行从来不是独立候选——这就是「很多细节选不中」的主因;行带按列空隙切段能切出来。
    var rowCnt = new Int32Array(h), colOn = new Uint8Array(w);
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) if (edgeMap[y * w + x]) rowCnt[y]++;
    var bands = [], bStart = -1, bGap = 0;
    for (y = 0; y <= h; y++) {
      var hasRow = y < h && rowCnt[y] >= 2; // ≥2 个边缘点才算有内容,滤掉孤立噪点行
      if (hasRow) { if (bStart < 0) bStart = y; bGap = 0; }
      else if (bStart >= 0 && ++bGap > 1) { bands.push([bStart, y - bGap]); bStart = -1; bGap = 0; } // 允许 1 行空隙(字形上下沿)
    }
    for (var bi = 0; bi < bands.length && bi < 400; bi++) {
      var by1 = bands[bi][0], by2 = bands[bi][1] + 1;
      if (by2 - by1 < bandH) continue; // 太扁的行带(分隔线)不切
      colOn.fill(0);
      for (y = by1; y < by2; y++) for (x = 0; x < w; x++) if (edgeMap[y * w + x]) colOn[x] = 1;
      var segs = [], sStart = -1, cGap = 0, maxGap = Math.max(6, Math.round((by2 - by1) * 1.1)); // 列空隙 >1.1 倍行高才算断开(字间距不断)
      for (x = 0; x <= w; x++) {
        var on = x < w && colOn[x] === 1;
        if (on) { if (sStart < 0) sStart = x; cGap = 0; }
        else if (sStart >= 0 && ++cGap > maxGap) { segs.push([sStart, x - cGap]); sStart = -1; cGap = 0; }
      }
      if (sStart >= 0) segs.push([sStart, w - 1]);
      for (var si = 0; si < segs.length && si < 40; si++) {
        var sx1 = segs[si][0], sx2 = segs[si][1] + 1;
        if (sx2 - sx1 < bandW) continue;
        pushCandidate({ x1: sx1, y1: by1, x2: sx2, y2: by2 }, "文字行");
      }
    }
 // 小面积优先去重(IoU > 0.87 视为同一块)。
    var unique = [];
    found.sort(function (a, b) { return areaOf(a.bounds) - areaOf(b.bounds); });
    for (i = 0; i < found.length && unique.length < 600; i++) {
      var cand = found[i], dup = false;
      for (var j = 0; j < unique.length; j++) {
        var o = unique[j].bounds;
        var inter = Math.max(0, Math.min(cand.bounds.x2, o.x2) - Math.max(cand.bounds.x1, o.x1)) * Math.max(0, Math.min(cand.bounds.y2, o.y2) - Math.max(cand.bounds.y1, o.y1));
        var whole = areaOf(cand.bounds) + areaOf(o) - inter;
        if (whole > 0 && inter / whole > 0.87) { dup = true; break; }
      }
      if (!dup) unique.push(cand);
    }
    return unique;
  }
  function annDetect() {
    if (!ann) return;
    var ratio = Math.min(1, 2200 / Math.max(ann.w, ann.h)); // 2200 采样:3000px 截图里 16px 细节仍占 ~11.7px(旧 1400 只剩 7.5px 被闸掉)
    var w = Math.max(1, Math.round(ann.w * ratio)), h = Math.max(1, Math.round(ann.h * ratio));
    var c = document.createElement("canvas"); c.width = w; c.height = h;
    var g = c.getContext("2d", { willReadFrequently: true });
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, w, h); // 透明底按白底算
    g.drawImage(ann.img, 0, 0, w, h);
    var pixels;
    try { pixels = g.getImageData(0, 0, w, h).data; } catch (e) { return; }
    setTimeout(function () { // 让位首帧渲染,再跑检测(纯本地,数十毫秒级)
      if (!ann) return;
      try {
        ann.candidates = annDetectRegions(pixels, w, h, ann.w, ann.h);
        if (ann.mode === "smart") annRenderOverlay();
      } catch (e) { ann.candidates = []; toast("自动选块不可用,仍可手动框选"); }
    }, 30);
  }
  var annFineTimer = 0;
 /** 深缩放细化选块(第三轮):全局候选在「最长边 2200」采样图上算,放大后屏幕上的 10px 级
 * 小标签在原图里只有几像素,过不了尺寸闸 → 放大到底也选不中。zoom≥1.5 时改对「当前可见区域」
 * 按原生分辨率重跑一次,候选回填整图坐标并与全局候选合并(细候选面积更小,天然优先命中)。 */
  function annFineDetect() {
    annFineTimer = 0;
    if (!ann) return;
    if (ann.zoom < 1.5) { ann.fineCands = []; if (ann.mode === "smart") { ann.hoverCand = null; annRenderOverlay(); } return; }
    var vw = viewport.clientWidth, vh = viewport.clientHeight, z = ann.zoom;
    var x0 = Math.max(0, Math.floor(-ann.px / z)), y0 = Math.max(0, Math.floor(-ann.py / z));
    var x1 = Math.min(ann.w, Math.ceil((vw - ann.px) / z)), y1 = Math.min(ann.h, Math.ceil((vh - ann.py) / z));
    var cw = x1 - x0, chh = y1 - y0;
    if (cw < 16 || chh < 16) { ann.fineCands = []; return; }
    var k = Math.min(1, 1800 / Math.max(cw, chh)); // 只有可见区本身极大才降采样
    var sw = Math.max(16, Math.round(cw * k)), sh = Math.max(16, Math.round(chh * k));
    var c = document.createElement("canvas"); c.width = sw; c.height = sh;
    var g = c.getContext("2d", { willReadFrequently: true });
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, sw, sh);
    try { g.drawImage(ann.img, x0, y0, cw, chh, 0, 0, sw, sh); } catch (e) { return; }
    var px;
    try { px = g.getImageData(0, 0, sw, sh).data; } catch (e) { return; }
    var list = [];
    try {
      list = annDetectRegions(px, sw, sh, cw, chh, { minW: 3, minH: 3, blobW: 3, blobH: 3, blobN: 6, edgeW: 3, edgeH: 3, edgeN: 6, bandH: 2, bandW: 2 });
    } catch (e) { list = []; }
    for (var i = 0; i < list.length; i++) {
      var b = list[i].bounds;
      list[i].bounds = { x1: b.x1 + x0, y1: b.y1 + y0, x2: b.x2 + x0, y2: b.y2 + y0 };
      list[i].fine = true;
    }
    ann.fineCands = list;
    ann.hoverIndex = 0; // 候选集变了:序位回到最小块,避免陈旧指针指到已消失的候选
    if (ann.mode === "smart") { ann.hoverCand = null; annRenderOverlay(); }
  }
  function annScheduleFine() {
    if (annFineTimer) clearTimeout(annFineTimer);
    annFineTimer = setTimeout(annFineDetect, 220); // 视野稳定后才算,拖动期间不反复跑
  }
 /** 换候选(滚轮/键盘/钩子共用):序位 +delta 后按当前指针重取,并刷新提示。
 * 候选集是「面积升序」的,delta=+1 就是往上选更大的一层(文字行→按钮→面板)。 */
  function annCycleCand(delta) {
    if (!ann || ann.mode !== "smart") return false;
    ann.hoverIndex = Math.max(0, ann.hoverIndex + delta);
    var hc = candidateAt(annImgPoint({ clientX: lastClient.x, clientY: lastClient.y }));
    if (hc !== ann.hoverCand) { ann.hoverCand = hc; annRenderOverlay(); }
    annHintPaint();
    return true;
  }
  var ANN_HINT_BASE = "";
 /** 选块提示:悬停多候选时显示「候选 i/n」,让 [ ] 换块可发现。 */
  function annHintPaint() {
    var el = document.getElementById("annHint");
    if (!el) return;
    if (!ANN_HINT_BASE) ANN_HINT_BASE = el.textContent || "";
    if (ann && ann.mode === "smart" && ann.hoverCand) {
      var extra = ann.hoverChoices > 1 ? ("候选 " + ann.hoverPos + "/" + ann.hoverChoices + " · [ ] 或 Tab/Shift+滚轮 换块 · ") : "";
      el.textContent = "选块:" + extra + "点击即批注 · 滚轮缩放 · 空格拖移";
    } else el.textContent = ANN_HINT_BASE;
  }
  function candidateAt(p) {
    if (!ann) return null;
    var pool = (ann.candidates || []).concat(ann.fineCands || []); // 深缩放细候选(原生分辨率)一起参与命中
    if (!pool.length) return null;
    var choices = [];
    for (var i = 0; i < pool.length; i++) {
      var b = pool[i].bounds;
      if (p.x >= b.x1 && p.x < b.x2 && p.y >= b.y1 && p.y < b.y2) choices.push(b);
    }
    if (!choices.length) { ann.hoverChoices = 0; ann.hoverPos = 0; return null; }
    choices.sort(function (a, b) { return (a.x2 - a.x1) * (a.y2 - a.y1) - (b.x2 - b.x1) * (b.y2 - b.y1); }); // 小块优先(更精确):大框里的小框也选得中
    var idx = Math.min(ann.hoverIndex, choices.length - 1);
    ann.hoverChoices = choices.length; ann.hoverPos = idx + 1;
    return choices[idx];
  }

 /* ---------- 标注编辑器(note 模型:region/point/global,编号=顺序) ---------- */
  function openAnnotateEditor(dataUrl, opts) {
 // opts:{source:"screen"|"file", fileName?, capturedAt?};已打开时确认后替换素材
    if (ann && ann.sending) { toast("反馈发送中,请稍候…", 1); return; }
    if (ann) {
      if (ann.notes.length && !window.confirm("当前批注还未发送,换图将丢弃,确定?")) return;
      annRecDispose(); // 换图=丢弃旧素材,录音一并清理(停录 + revoke)
      ann = null; editor.style.display = "none";
    }
    var img = new Image();
    img.onload = function () {
      ann = { dataUrl: dataUrl, img: img, w: img.naturalWidth, h: img.naturalHeight, zoom: 1, px: 0, py: 0, notes: [], sel: null, mode: "smart", drag: null, undo: [], redo: [], spaceDown: false, sending: false, candidates: [], hoverCand: null, hoverIndex: 0, userZoomed: false, layout: null, layoutMode: false,
        cap: { source: (opts && opts.source) || "screen", capturedAt: (opts && opts.capturedAt) || new Date().toISOString(), fileName: (opts && opts.fileName) || undefined } };
      canvas.width = ann.w; canvas.height = ann.h;
 // viewBox=图像像素坐标系:overlay 的 rect/circle/path 全按图像像素书写,
 // 浏览器自动映射到 stage CSS 尺寸 → 缩放/平移后标注视觉与鼠标一致。
 // (缺它时 SVG 用户坐标系=CSS 尺寸,图像像素被当 CSS px,zoom≠1 视觉错位 zoom 倍。)
      overlay.setAttribute("viewBox", "0 0 " + ann.w + " " + ann.h);
      overlay.setAttribute("preserveAspectRatio", "none");
      annPaintCanvas();
      document.getElementById("annMeta").textContent = ann.w + " × " + ann.h + " px" + (ann.cap.source === "file" && ann.cap.fileName ? " · " + ann.cap.fileName : "");
      editor.style.display = "flex";
      setAnnMode("smart");
      annFit();
      annRenderAll();
      annDetect();
    };
    img.onerror = function () { toast("图片解码失败", 1); };
    img.src = dataUrl;
  }
 /* ---------- 录音评论:MediaRecorder → Blob → dataURL 随 annotate.submit 的 audioUrl 上行 ---------- */
  var REC_MAX_MS = 120 * 1000;          // 单条录音上限 120s,到点自动 stop
  var REC_MAX_BYTES = 8 * 1024 * 1024;  // 超 8MB 拒发(WS 帧承受不了),不静默丢弃
  function annRecSupported() { return !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia); }
  function annRecFmt(sec) { var s = Math.max(0, Math.floor(sec || 0)); return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2); }
  function annRecStop() {
    if (!ann || !ann.rec) return;
    var R = ann.rec;
    if (R.timer) { clearInterval(R.timer); R.timer = null; }
    if (R.rec && R.rec.state !== "inactive") { try { R.rec.stop(); } catch (e) { /* 已停 */ } }
  }
 /** 清理录音状态:停录 + 停轨道 + revoke blob URL(关编辑器/发送成功/删除录音共用)。 */
  function annRecDispose() {
    if (!ann || !ann.rec) return;
    var R = ann.rec;
    annRecStop();
    if (R.stream) { try { R.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* 已停 */ } R.stream = null; }
    if (R.url) { try { URL.revokeObjectURL(R.url); } catch (e) { /* 已释放 */ } R.url = null; }
    R.blob = null; R.chunks = []; R.seconds = 0; R.startedAt = 0;
    ann.rec = null;
    try { recAudio.pause(); } catch (e) { /* 无音轨 */ }
    try { recAudio.removeAttribute("src"); } catch (e) { /* 无 src */ }
    recAudio.style.display = "none";
    recState.textContent = ""; recState.classList.remove("rec");
    if (recDel) recDel.style.display = "none";
    if (recBtn) { recBtn.textContent = "● 录音"; recBtn.disabled = !annRecSupported(); }
  }
  function annRecTick() { // 500ms 刷新计时;到 120s 自动 stop
    if (!ann || !ann.rec || !ann.rec.startedAt) return;
    var el = Date.now() - ann.rec.startedAt;
    ann.rec.seconds = Math.floor(el / 1000);
    recState.textContent = "● " + annRecFmt(ann.rec.seconds);
    if (el >= REC_MAX_MS) annRecStop();
  }
  function annRecStart() {
    if (!ann) return;
    if (!annRecSupported()) { toast("当前环境不支持录音(缺 MediaRecorder 或麦克风权限)", 1); if (recBtn) recBtn.disabled = true; return; }
    if (ann.rec) annRecDispose();
    var mime = "";
    var cands = ["audio/webm;codecs=opus", "audio/webm"];
    for (var ci = 0; ci < cands.length && !mime; ci++) {
      try { if (!window.MediaRecorder.isTypeSupported || window.MediaRecorder.isTypeSupported(cands[ci])) mime = cands[ci]; } catch (e) { /* 探测失败=当不支持 */ }
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      if (!ann) { try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* 已停 */ } return; }
      var mr;
      try { mr = new window.MediaRecorder(stream, mime ? { mimeType: mime } : {}); } catch (e) { mr = new window.MediaRecorder(stream); }
      ann.rec = { rec: mr, chunks: [], blob: null, url: null, startedAt: Date.now(), timer: null, seconds: 0, stream: stream, mime: mime || "" };
      mr.ondataavailable = function (ev) { if (ann && ann.rec && ev.data && ev.data.size > 0) ann.rec.chunks.push(ev.data); };
      mr.onstop = function () {
        try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* 已停 */ }
        if (!ann || !ann.rec) return;
        var R = ann.rec;
        if (R.timer) { clearInterval(R.timer); R.timer = null; }
        R.startedAt = 0; R.stream = null;
        var blob = null;
        try { blob = R.chunks.length ? new Blob(R.chunks, { type: R.mime || "audio/webm" }) : null; } catch (e) { blob = null; }
        R.chunks = []; R.blob = blob && blob.size > 0 ? blob : null;
        recBtn.textContent = "● 录音"; recBtn.disabled = !annRecSupported(); recState.classList.remove("rec");
        if (!R.blob) { recState.textContent = "没录到声音"; return; }
        try { R.url = URL.createObjectURL(R.blob); recAudio.src = R.url; recAudio.style.display = "inline-block"; } catch (e) { R.url = null; }
        if (recDel) recDel.style.display = "";
        recState.textContent = "已录 " + annRecFmt(R.seconds) + " · " + Math.max(1, Math.round(R.blob.size / 1024)) + "KB";
        if (R.blob.size > REC_MAX_BYTES) recState.textContent += "(过大,发送会被拦)";
      };
      try { mr.start(); } catch (e) {
        ann.rec = null;
        try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e2) { /* 已停 */ }
        toast("录音启动失败:" + String(e && e.message || e).slice(0, 80), 1); return;
      }
      recBtn.textContent = "■ 停止"; recState.classList.add("rec");
      annRecTick();
      ann.rec.timer = setInterval(annRecTick, 500);
    }).catch(function (err) {
      toast("麦克风不可用:" + String(err && err.message || err).slice(0, 100), 1);
      if (recBtn) recBtn.disabled = true;
    });
  }
  recBtn && (recBtn.onclick = function () {
    if (!ann) return;
    if (ann.rec && ann.rec.rec && ann.rec.rec.state === "recording") { annRecStop(); return; }
    if (ann.rec && ann.rec.blob) annRecDispose(); // 重录=覆盖旧录音
    annRecStart();
  });
  recDel && (recDel.onclick = function () { annRecDispose(); });
 /* ---------- 录屏批注:屏幕+笔迹+麦克风合成 webm → annotate.record ---------- */
  var VID_MAX_MS = 120000, VID_MAX_BYTES = 12 * 1024 * 1024, VID_BITRATE = 700000;
  var vid = null; // {mr,audioMr,chunks,audioChunks,blob,audioBlob,url,audioUrl,screen,mic,video,canvas,ctx,strokes,drag,keyframes,startedAt,dur,timer,loop,mime,mode,capturedAt}
  function annvEl(id) { return document.getElementById(id); }
  function annVidSupported() { return !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia && HTMLCanvasElement.prototype.captureStream); }
  function annVidFmt(sec) { var s = Math.max(0, Math.floor(sec || 0)); return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2); }
  function annVidSetState(txt, warn) { var el = annvEl("annVidState"); if (el) { el.textContent = txt || ""; el.style.color = warn ? "#e2564a" : ""; } }
  function annVidToolPaint() {
    var pen = annvEl("annvPen"), rect = annvEl("annvRect");
    var mode = vid ? vid.mode : "pen";
    if (pen) pen.classList.toggle("on", mode === "pen");
    if (rect) rect.classList.toggle("on", mode === "rect");
  }
  function annVidLoopDraw() {
    if (!vid) return;
    var cv = vid.canvas, g = vid.ctx;
    try { g.drawImage(vid.video, 0, 0, cv.width, cv.height); } catch (e) { g.fillStyle = "#000"; g.fillRect(0, 0, cv.width, cv.height); }
    g.lineWidth = Math.max(2, cv.width / 600); g.lineCap = "round"; g.lineJoin = "round"; g.strokeStyle = "#ff3b30";
    for (var i = 0; i < vid.strokes.length; i++) {
      var s = vid.strokes[i];
      if (s.kind === "rect") g.strokeRect(Math.min(s.x1, s.x2), Math.min(s.y1, s.y2), Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1));
      else if (s.points && s.points.length > 1) { g.beginPath(); g.moveTo(s.points[0].x, s.points[0].y); for (var j = 1; j < s.points.length; j++) g.lineTo(s.points[j].x, s.points[j].y); g.stroke(); }
    }
    var d = vid.drag;
    if (d && d.type === "rect") { g.setLineDash([8, 6]); g.strokeRect(Math.min(d.sx, d.x1), Math.min(d.sy, d.y1), Math.abs(d.x1 - d.sx), Math.abs(d.y1 - d.sy)); g.setLineDash([]); }
  }
  function annVidKeyframe() { // 停止/落笔时抽关键帧(≤4 张,≤900px),给 omni 看画面
    if (!vid || vid.keyframes.length >= 4) return;
    try {
      var cv = vid.canvas, k = Math.min(1, 900 / Math.max(cv.width, cv.height));
      var c2 = document.createElement("canvas"); c2.width = Math.max(2, Math.round(cv.width * k)); c2.height = Math.max(2, Math.round(cv.height * k));
      c2.getContext("2d").drawImage(cv, 0, 0, c2.width, c2.height);
      vid.keyframes.push(c2.toDataURL("image/jpeg", 0.7));
    } catch (e) { /* 抽帧失败不影响录制 */ }
  }
  function annVidFinish() {
    if (!vid) return;
    var R = vid;
    if (R.timer) { clearInterval(R.timer); R.timer = 0; }
    if (R.loop) { clearInterval(R.loop); R.loop = 0; }
    if (R.audioMr) { try { if (R.audioMr.state !== "inactive") R.audioMr.stop(); } catch (e) { /* 已停 */ } R.audioMr = null; }
    try { R.screen && R.screen.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* 已停 */ }
    try { R.mic && R.mic.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* 已停 */ }
    try { R.video.pause(); R.video.srcObject = null; } catch (e) { /* 已拆 */ }
    var blob = null; try { blob = R.chunks.length ? new Blob(R.chunks, { type: R.mime || "video/webm" }) : null; } catch (e) { blob = null; }
    R.chunks = []; R.blob = blob && blob.size > 0 ? blob : null;
    var ab = null; try { ab = R.audioChunks.length ? new Blob(R.audioChunks, { type: "audio/webm" }) : null; } catch (e) { ab = null; }
    R.audioChunks = []; R.audioBlob = ab && ab.size > 0 ? ab : null;
    var ov = annvEl("annvOverlay"); if (ov) ov.style.display = "none";
    if (!R.blob) { annVidSetState("没录到画面,请重试", true); vid = null; return; }
    try { R.url = URL.createObjectURL(R.blob); var pv = annvEl("annVidPreview"); if (pv) { pv.src = R.url; pv.style.display = "inline-block"; } } catch (e) { R.url = null; }
    var st = "已录 " + annVidFmt((R.dur || (Date.now() - R.startedAt)) / 1000) + " · " + Math.max(1, Math.round(R.blob.size / 1024)) + "KB";
    if (R.blob.size > VID_MAX_BYTES) st += "(过大,发送会被拦)";
    annVidSetState(st, R.blob.size > VID_MAX_BYTES);
    var del = annvEl("annVidDel"); if (del) del.style.display = "inline-block";
  }
  function annVidStop() {
    if (!vid) return;
    var R = vid;
    if (R.timer) { clearInterval(R.timer); R.timer = 0; }
    if (R.loop) { clearInterval(R.loop); R.loop = 0; }
    annVidLoopDraw(); // 最后一帧带完整笔迹
    annVidKeyframe();
    var stopped = false;
    try { if (R.audioMr && R.audioMr.state !== "inactive") R.audioMr.stop(); } catch (e) { /* 已停 */ }
    try { if (R.mr && R.mr.state !== "inactive") { R.mr.stop(); stopped = true; } } catch (e) { /* 已停 */ }
    if (!stopped) annVidFinish();
  }
 /** 录制计时(暂停/继续复用):dur 只在非暂停期增长,暂停时长不计入时间轴。 */
  function annVidTimerStart(R) {
    if (R.timer) clearInterval(R.timer);
    R.timer = setInterval(function () {
      if (!vid || vid !== R || R.paused) return;
      R.dur = Date.now() - R.startedAt;
      var t = annvEl("annvTimer"); if (t) t.textContent = "● " + annVidFmt(R.dur / 1000);
      if (R.dur >= VID_MAX_MS) { toast("录屏已达 120s 上限,自动停止", 1); annVidStop(); }
    }, 250);
  }
 /** 暂停/继续(第三轮):暂停期冻结计时并禁用笔迹输入——笔迹时间轴靠 startedAt 推算,
 * 边暂停边画会让「第几秒画了什么」与视频时长错位。 */
  function annVidPauseToggle() {
    if (!vid || !vid.mr) return;
    var R = vid, btn = annvEl("annvPause"), t = annvEl("annvTimer");
    if (R.mr.state === "recording") {
      try { R.mr.pause(); } catch (e) { return; }
      if (R.audioMr) { try { R.audioMr.pause(); } catch (e) { /* 已停 */ } }
      R.paused = true;
      R.dur = Date.now() - R.startedAt;
      if (R.timer) { clearInterval(R.timer); R.timer = 0; }
      if (R.loop) { clearInterval(R.loop); R.loop = 0; } // 暂停=冻结画面,不再合成新帧
      if (btn) btn.textContent = "继续";
      if (t) t.textContent = "[暂停] " + annVidFmt(R.dur / 1000);
      if (R.canvas) R.canvas.style.cursor = "not-allowed";
      annVidSetState("已暂停(暂停期笔迹不记录)");
    } else if (R.mr.state === "paused") {
      try { R.mr.resume(); } catch (e) { return; }
      if (R.audioMr) { try { R.audioMr.resume(); } catch (e) { /* 已停 */ } }
      R.paused = false;
      R.startedAt = Date.now() - R.dur; // 时间轴接续:累计时长不被暂停期拉长
      R.loop = setInterval(annVidLoopDraw, 83);
      annVidTimerStart(R);
      if (btn) btn.textContent = "暂停";
      if (R.canvas) R.canvas.style.cursor = "crosshair";
      annVidSetState("");
    }
  }
  function annVidDispose() {
    var R = vid;
    if (R) {
      if (R.timer) clearInterval(R.timer);
      if (R.loop) clearInterval(R.loop);
      try { if (R.mr && R.mr.state !== "inactive") R.mr.stop(); } catch (e) { /* 已停 */ }
      try { if (R.audioMr && R.audioMr.state !== "inactive") R.audioMr.stop(); } catch (e) { /* 已停 */ }
      try { R.screen && R.screen.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* 已停 */ }
      try { R.mic && R.mic.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* 已停 */ }
      if (R.url) { try { URL.revokeObjectURL(R.url); } catch (e) { /* 已释放 */ } }
    }
    vid = null;
    var ov = annvEl("annvOverlay"); if (ov) ov.style.display = "none";
    var pv = annvEl("annVidPreview"); if (pv) { try { pv.pause(); } catch (e) { /* 无音轨 */ } pv.removeAttribute("src"); pv.style.display = "none"; }
    var del = annvEl("annVidDel"); if (del) del.style.display = "none";
    annVidSetState("");
  }
  function annVidStart() {
    if (!ann) { toast("先在标注编辑器里打开一张截图,再录制批注", 1); return; }
    if (!annVidSupported()) { toast("当前环境不支持录屏批注(缺 MediaRecorder / getDisplayMedia)", 1); return; }
    if (vid && vid.blob) { toast("已有录制,先发送或删除再重录", 1); return; }
    if (vid) annVidDispose();
    var micP = navigator.mediaDevices.getUserMedia({ audio: true }).catch(function () { return null; }); // 麦克风可选:拒绝=无声录制
    navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "monitor" }, audio: false }).then(function (screen) {
      micP.then(function (mic) {
        if (!screen) return;
        var v = document.createElement("video");
        v.srcObject = screen; v.muted = true; v.playsInline = true;
        v.play().then(function () {
          var vw = v.videoWidth || 1280, vh = v.videoHeight || 720;
          var k = Math.min(1, 1600 / Math.max(vw, vh)); // 4K 掉帧防护:合成画布最长边 ≤1600
          var cv = annvEl("annvCanvas");
          cv.width = Math.max(2, Math.round(vw * k)); cv.height = Math.max(2, Math.round(vh * k));
          var g = cv.getContext("2d");
          var mixed = new MediaStream();
          var cs = cv.captureStream(12);
          cs.getVideoTracks().forEach(function (t) { mixed.addTrack(t); });
          if (mic) mic.getAudioTracks().forEach(function (t) { mixed.addTrack(t); });
          var mime = "";
          var cands = ["video/webm;codecs=vp8", "video/webm"];
          for (var i = 0; i < cands.length && !mime; i++) {
            try { if (!window.MediaRecorder.isTypeSupported || window.MediaRecorder.isTypeSupported(cands[i])) mime = cands[i]; } catch (e) { /* 探测失败=当不支持 */ }
          }
          var mr;
          try { mr = new window.MediaRecorder(mixed, mime ? { mimeType: mime, videoBitsPerSecond: VID_BITRATE } : { videoBitsPerSecond: VID_BITRATE }); }
          catch (e) { try { mr = new window.MediaRecorder(mixed); } catch (e2) { toast("录屏启动失败:" + String(e2 && e2.message || e2).slice(0, 100), 1); return; } }
          vid = { mr: mr, audioMr: null, chunks: [], audioChunks: [], blob: null, audioBlob: null, url: null, screen: screen, mic: mic, video: v, canvas: cv, ctx: g,
            strokes: [], drag: null, keyframes: [], startedAt: Date.now(), dur: 0, timer: 0, loop: 0, paused: false, mime: mime || "video/webm", mode: "pen", capturedAt: new Date().toISOString() };
          if (mic) { // 独立音轨:合成轨里的音频端点不保证可解码,omni 转写用这条
            try {
              var am = new window.MediaRecorder(mic, { mimeType: "audio/webm;codecs=opus" });
              am.ondataavailable = function (ev) { if (vid && ev.data && ev.data.size > 0) vid.audioChunks.push(ev.data); };
              am.start(250); vid.audioMr = am;
            } catch (e) { vid.audioMr = null; }
          }
          mr.ondataavailable = function (ev) { if (vid && ev.data && ev.data.size > 0) vid.chunks.push(ev.data); };
          mr.onstop = annVidFinish;
          annvEl("annvOverlay").style.display = "flex";
          annVidToolPaint();
          vid.loop = setInterval(annVidLoopDraw, 83);
          annVidTimerStart(vid);
          try { mr.start(250); } catch (e) { toast("录屏启动失败:" + String(e && e.message || e).slice(0, 100), 1); annVidDispose(); }
        }).catch(function (e) {
          try { screen.getTracks().forEach(function (t) { t.stop(); }); } catch (e2) { /* 已停 */ }
          if (mic) { try { mic.getTracks().forEach(function (t) { t.stop(); }); } catch (e3) { /* 已停 */ } }
          toast("屏幕画面不可读:" + String(e && e.message || e).slice(0, 100), 1);
        });
      });
    }).catch(function (err) {
      toast(err && err.name === "NotAllowedError" ? "已取消录屏" : ("录屏失败:" + String(err && err.message || err).slice(0, 100)), 1);
    });
  }
  function annVidSubmit() {
    if (!ann || ann.sending) return;
    if (!vid || !vid.blob) { toast("先点「● 录屏批注」录一段(停止后可回放)", 1); return; }
    if (vid.blob.size > VID_MAX_BYTES) { toast("录制过大(>" + Math.round(VID_MAX_BYTES / 1024 / 1024) + "MB),请删掉重录更短的一段", 1); return; }
    var sid = currentSid || ("web-" + Date.now());
    if (!currentSid) { currentSid = sid; try { sessionStorage.setItem("zh:sid", sid); localStorage.setItem("zh:sid", sid); } catch (e) { /* 存储不可用 */ } }
    var page = "";
    try { page = String(annvEl("annPage").value || "").trim().slice(0, 500); } catch (e) { page = ""; }
    ann.sending = true; sendBtn.disabled = true; sendBtn.textContent = "发送中…";
    annMain.style.pointerEvents = "none";
    var payload = {
      v: 1, type: "annotate.record", sessionId: sid, durationMs: Math.round(vid.dur || 0),
      strokes: vid.strokes, keyframes: vid.keyframes.slice(0, 4),
      capture: { source: "screen", capturedAt: vid.capturedAt },
      ...(page ? { pageContext: page } : {}),
    };
    var doSend = function (audioUrl) {
      if (!ann) return;
      if (audioUrl) payload.audioUrl = audioUrl;
      wsSafeSend(JSON.stringify(payload));
      if (ann.submitTimer) clearTimeout(ann.submitTimer);
      ann.submitTimer = setTimeout(function () {
        if (!ann || !ann.sending) return;
        annUnlock();
        toast("服务未回执(录屏批注已保留,可重试发送)", 1);
      }, 60000);
    };
    var fr = new FileReader();
    fr.onload = function () {
      if (!ann) return;
      payload.videoUrl = String(fr.result || "");
      if (!vid || !vid.audioBlob) { doSend(""); return; }
      var ar = new FileReader();
      ar.onload = function () { doSend(String(ar.result || "")); };
      ar.onerror = function () { doSend(""); }; // 音频读不出=只发视频+笔迹,不阻塞
      ar.readAsDataURL(vid.audioBlob);
    };
    fr.onerror = function () { annUnlock(); toast("录屏读取失败,请重新录制", 1); };
    fr.readAsDataURL(vid.blob);
  }
  annvEl("annScreenRecBtn") && (annvEl("annScreenRecBtn").onclick = annVidStart);
  annvEl("annvStop") && (annvEl("annvStop").onclick = annVidStop);
  annvEl("annvPause") && (annvEl("annvPause").onclick = annVidPauseToggle);
  annvEl("annvCancel") && (annvEl("annvCancel").onclick = function () { annVidDispose(); });
  annvEl("annvClear") && (annvEl("annvClear").onclick = function () { if (vid) { vid.strokes = []; vid.drag = null; annVidLoopDraw(); } });
  annvEl("annvPen") && (annvEl("annvPen").onclick = function () { if (vid) { vid.mode = "pen"; annVidToolPaint(); } });
  annvEl("annvRect") && (annvEl("annvRect").onclick = function () { if (vid) { vid.mode = "rect"; annVidToolPaint(); } });
  annvEl("annVidDel") && (annvEl("annVidDel").onclick = function () { annVidDispose(); });
  (function () { // 录屏画面上的笔迹交互(自由笔 + 框选)
    var cv = annvEl("annvCanvas");
    if (!cv) return;
    function pt(ev) {
      var r = cv.getBoundingClientRect();
      var kx = r.width > 0 ? cv.width / r.width : 1, ky = r.height > 0 ? cv.height / r.height : 1;
      return { x: clamp((ev.clientX - r.left) * kx, 0, cv.width), y: clamp((ev.clientY - r.top) * ky, 0, cv.height) };
    }
    cv.addEventListener("pointerdown", function (ev) {
      if (!vid || vid.paused || ev.button !== 0) return; // 暂停期不落笔:笔迹时间轴必须与视频时间轴一致
      ev.preventDefault();
      var p = pt(ev), t = Math.max(0, Date.now() - vid.startedAt);
      if (vid.mode === "rect") vid.drag = { type: "rect", sx: p.x, sy: p.y, x1: p.x, y1: p.y };
      else {
        var s = { kind: "pen", t: t, x1: p.x, y1: p.y, x2: p.x, y2: p.y, points: [{ x: p.x, y: p.y }] };
        vid.strokes.push(s); vid.drag = { type: "pen", stroke: s };
      }
      try { cv.setPointerCapture(ev.pointerId); } catch (e) { /* 已释放 */ }
    });
    cv.addEventListener("pointermove", function (ev) {
      if (!vid || !vid.drag) return;
      var p = pt(ev), d = vid.drag;
      if (d.type === "rect") { d.x1 = p.x; d.y1 = p.y; }
      else {
        var s = d.stroke, last = s.points[s.points.length - 1];
        if (Math.abs(p.x - last.x) + Math.abs(p.y - last.y) >= 2) s.points.push({ x: p.x, y: p.y });
        s.x2 = p.x; s.y2 = p.y;
      }
    });
    function endStroke(ev) {
      if (!vid || !vid.drag) return;
      var d = vid.drag, p = pt(ev);
      vid.drag = null;
      if (d.type === "rect") {
        var x1 = Math.min(d.sx, p.x), y1 = Math.min(d.sy, p.y), x2 = Math.max(d.sx, p.x), y2 = Math.max(d.sy, p.y);
        if (x2 - x1 >= 6 && y2 - y1 >= 6) vid.strokes.push({ kind: "rect", t: Math.max(0, Date.now() - vid.startedAt), x1: x1, y1: y1, x2: x2, y2: y2 });
      }
      annVidKeyframe();
      try { cv.releasePointerCapture(ev.pointerId); } catch (e) { /* 已释放 */ }
    }
    cv.addEventListener("pointerup", endStroke);
    cv.addEventListener("pointercancel", endStroke);
  })();
  function onAnnotateRecordResult(m) {
    if (ann && ann.submitTimer) { clearTimeout(ann.submitTimer); ann.submitTimer = null; }
    annUnlock();
    if (!ann) { if (!m.ok && m.message) toast(m.message, 1); return; }
    if (m.ok) {
      annVidDispose();
      annRecDispose();
      ann = null; editor.style.display = "none";
      var okMsg = m.queued ? "录屏批注已写入队列,将随当前任务续发"
        : (m.refined === true ? "录屏批注已发送(omni 已整理成任务书)" : "录屏批注已发送(未经 omni 整理)");
      if (m.parseError) okMsg += " · 解析失败:" + String(m.parseError).slice(0, 120) + "(录像已保留)";
      toast(okMsg, m.parseError ? 1 : 0);
    } else {
      toast(m.message || "录屏批注提交失败", 1);
    }
  }
  window.__annRecordResult = onAnnotateRecordResult;
 // 录屏验收钩子:录制态/体积/笔迹/关键帧/回放 URL(静态页 E2E 用,不依赖网关)。
  window.__annTestRecord = function () {
    return vid ? { recording: !!(vid.mr && vid.mr.state === "recording"), paused: !!vid.paused, state: vid.mr ? vid.mr.state : "",
      dur: Math.round(vid.dur || 0), bytes: vid.blob ? vid.blob.size : 0,
      strokes: vid.strokes.length, keyframes: vid.keyframes.length,
      preview: (document.getElementById("annVidPreview") || {}).src || "" } : null;
  };
  window.__annTestRecordStart = function () { annVidStart(); };
  function closeAnnotateEditor() {
    if (ann && ann.sending) return;
    if (ann && ann.notes.length && !window.confirm("还有未发送的批注,确定丢弃并关闭?")) return;
    annRecDispose(); // 录音中关编辑器:停录 + revoke blob URL
    ann = null; editor.style.display = "none";
  }
  function setAnnMode(mode) {
    if (!ann) return;
    ann.mode = mode; ann.drag = null; ann.hoverCand = null; ann.hoverIndex = 0;
    var tools = document.querySelectorAll(".ann-tool");
    for (var i = 0; i < tools.length; i++) tools[i].classList.toggle("active", tools[i].getAttribute("data-amode") === mode);
    stage.style.cursor = mode === "select" ? "default" : "crosshair";
  }
  function annPaintCanvas() {
    if (!ann) return;
    var g = canvas.getContext("2d");
    g.clearRect(0, 0, ann.w, ann.h);
    if (ann.layout && window.GenieAnnotateLayout) window.GenieAnnotateLayout.render(g, ann.img, ann.layout);
    else g.drawImage(ann.img, 0, 0);
  }
  function cloneRect(r) { return { x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 }; }
  function sameRect(a, b) { return !!a && !!b && a.x1 === b.x1 && a.y1 === b.y1 && a.x2 === b.x2 && a.y2 === b.y2; }
  function trackedMovements() {
    if (!ann || !ann.layout || !window.GenieAnnotateLayout) return [];
    return window.GenieAnnotateLayout.ledgerOf(ann.layout).filter(function (m) { return !sameRect(m.source, m.destination); });
  }
  function movementDestinationOf(sourceRect) {
    var moves = trackedMovements();
    for (var i = 0; i < moves.length; i++) if (sameRect(moves[i].source, sourceRect)) return moves[i].destination;
    return sourceRect;
  }
 // 搬动后同步位移批注:回原位的位移删批注,新位移补空批注
  function synchronizeMovementNotes() {
    if (!ann || !ann.layout) return;
    var moves = trackedMovements();
    ann.notes = ann.notes.filter(function (n) { return !n.movementSource || String(n.text || "").trim() || moves.some(function (m) { return sameRect(m.source, n.movementSource); }); });
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      var has = ann.notes.some(function (n) { return n.movementSource && sameRect(n.movementSource, m.source); });
      if (!has && ann.notes.length < 1000) {
        ann.notes.push({ id: "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), movementSource: cloneRect(m.source), source: cloneRect(m.destination), text: "", movement: true });
      }
    }
  }
  function annSnapshot() { return JSON.stringify({ notes: ann.notes, layout: ann.layout }); }
  function annRemember(before) { ann.undo.push(before); if (ann.undo.length > 50) ann.undo.shift(); ann.redo = []; }
  function annUndo() {
    if (!ann || !ann.undo.length) return;
    ann.redo.push(annSnapshot());
    if (ann.redo.length > 50) ann.redo.shift();
    var snap = JSON.parse(ann.undo.pop());
    ann.notes = snap.notes; ann.layout = snap.layout || null;
    if (ann.sel && !ann.notes.some(function (n) { return n.id === ann.sel; })) ann.sel = null;
    annRenderAll();
  }
  function annRedo() {
    if (!ann || !ann.redo.length) return;
    ann.undo.push(annSnapshot());
    var snap = JSON.parse(ann.redo.pop());
    ann.notes = snap.notes; ann.layout = snap.layout || null;
    if (ann.sel && !ann.notes.some(function (n) { return n.id === ann.sel; })) ann.sel = null;
    annRenderAll();
  }
  var ANN_ZOOM_MIN = 0.01, ANN_ZOOM_MAX = 8; // 0.01 只是极端大图的硬底
 /** 最小缩放=「适应」比例(缩到最小永远整图可见);小图不超 1:1。旧实现固定 0.01 会把图缩成一个点。 */
  function annMinZoom() {
    if (!ann) return ANN_ZOOM_MIN;
    var f = Math.min((viewport.clientWidth - 24) / ann.w, (viewport.clientHeight - 24) / ann.h);
    return Math.min(1, Math.max(ANN_ZOOM_MIN, f > 0 ? f : ANN_ZOOM_MIN));
  }
 /** 缩放/平移后的边界收敛:内容小于视口=该轴居中;大于视口=夹在视口内,不允许把图整块拖出可视区。 */
  function annClampView() {
    if (!ann) return;
    var vw = viewport.clientWidth, vh = viewport.clientHeight;
    var w = ann.w * ann.zoom, h = ann.h * ann.zoom;
    ann.px = w <= vw ? (vw - w) / 2 : clamp(ann.px, vw - w, 0);
    ann.py = h <= vh ? (vh - h) / 2 : clamp(ann.py, vh - h, 0);
  }
  function annFit() {
    if (!ann) return;
    ann.userZoomed = false;
    var vw = viewport.clientWidth - 24, vh = viewport.clientHeight - 24;
    ann.zoom = clamp(Math.min(vw / ann.w, vh / ann.h), 0.01, 1);
    ann.px = (viewport.clientWidth - ann.w * ann.zoom) / 2;
    ann.py = (viewport.clientHeight - ann.h * ann.zoom) / 2;
    annPaint();
  }
  function annZoomAt(factor, cx, cy) {
    if (!ann) return;
    var next = clamp(ann.zoom * factor, annMinZoom(), ANN_ZOOM_MAX); // 下限=适应比例:缩到最小必然整图可见(旧 0.02 既看不全又可能「按−反而变大」)
 // 锚点统一 viewport 局部坐标(ann.px/py 即此系;stage 在 viewport 内偏移 0):
 // 旧实现 cx-r.left 取 stage rect(与 viewport 同系,等价)但 cy 缺省混用 clientHeight,
 // 真正的漂移源是「无参缩放锚≠用户预期中心」+fit 的 12px 下限;此处统一换算并保持锚点语义。
    var vpr = viewport.getBoundingClientRect();
    var ax = cx === undefined ? viewport.clientWidth / 2 : cx - vpr.left;
    var ay = cy === undefined ? viewport.clientHeight / 2 : cy - vpr.top;
    var k = next / ann.zoom;
    ann.px = ax - (ax - ann.px) * k; ann.py = ay - (ay - ann.py) * k;
    ann.zoom = next; ann.userZoomed = true;
    annClampView(); // 缩小到内容小于视口时自动回中,不再整块飘出可视区
    annPaint();
  }
  function annPaint() {
    if (!ann) return;
    stage.style.left = ann.px + "px"; stage.style.top = ann.py + "px";
    stage.style.width = (ann.w * ann.zoom) + "px"; stage.style.height = (ann.h * ann.zoom) + "px";
    document.getElementById("annZoomLabel").textContent = Math.round(ann.zoom * 100) + "%";
    annRenderOverlay();
    annScheduleFine(); // 视野变了:220ms 后按可见区重算细候选
  }
  function noteRect(n) {
    if (n.kind === "region") return n.source;
    if (n.movementSource) return movementDestinationOf(n.movementSource);
    return null;
  }
  function annRenderOverlay() {
    if (!ann) return;
    var z = ann.zoom, svg = "";
    var HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
    function hpos(b, h) {
      var mx = (b.x1 + b.x2) / 2, my = (b.y1 + b.y2) / 2;
      return { nw: { x: b.x1, y: b.y1 }, n: { x: mx, y: b.y1 }, ne: { x: b.x2, y: b.y1 }, e: { x: b.x2, y: my }, se: { x: b.x2, y: b.y2 }, s: { x: mx, y: b.y2 }, sw: { x: b.x1, y: b.y2 }, w: { x: b.x1, y: my } }[h];
    }
    for (var i = 0; i < ann.notes.length; i++) {
      var n = ann.notes[i], b = noteRect(n);
      if (!b) continue;
      var sel = n.id === ann.sel;
      svg += '<rect x="' + b.x1 + '" y="' + b.y1 + '" width="' + (b.x2 - b.x1) + '" height="' + (b.y2 - b.y1) + '" fill="rgba(201,143,69,' + (sel ? ".14" : ".06") + ')" stroke="' + (sel ? "#e8b478" : "#c98f45") + '" stroke-width="1.5" vector-effect="non-scaling-stroke"/>';
      if (sel) for (var j = 0; j < HANDLES.length; j++) {
        var p = hpos(b, HANDLES[j]);
        svg += '<rect data-ah="' + HANDLES[j] + '" x="' + (p.x - 4 / z) + '" y="' + (p.y - 4 / z) + '" width="' + (8 / z) + '" height="' + (8 / z) + '" fill="#fff" stroke="#c98f45" stroke-width="1" vector-effect="non-scaling-stroke"/>';
      }
    }
    if (ann.layout) {
      var moves = trackedMovements();
      for (var mi = 0; mi < moves.length; mi++) {
        var mv = moves[mi], ax1 = (mv.source.x1 + mv.source.x2) / 2, ay1 = (mv.source.y1 + mv.source.y2) / 2, ax2 = (mv.destination.x1 + mv.destination.x2) / 2, ay2 = (mv.destination.y1 + mv.destination.y2) / 2;
        svg += '<path d="M' + ax1 + ',' + ay1 + ' L' + ax2 + ',' + ay2 + '" stroke="#e8b478" stroke-width="2" stroke-dasharray="6 4" vector-effect="non-scaling-stroke"/>' +
          '<circle cx="' + ax1 + '" cy="' + ay1 + '" r="' + (3 / z) + '" fill="#e8b478"/><path d="M' + ax2 + ',' + ay2 + ' l' + (-8 / z) + ',' + (-4 / z) + 'M' + ax2 + ',' + ay2 + ' l' + (-8 / z) + ',' + (4 / z) + '" stroke="#e8b478" stroke-width="2" vector-effect="non-scaling-stroke" fill="none"/>';
      }
    }
    if (ann.hoverCand && !ann.drag) {
      var hc = ann.hoverCand;
      svg += '<rect x="' + hc.x1 + '" y="' + hc.y1 + '" width="' + (hc.x2 - hc.x1) + '" height="' + (hc.y2 - hc.y1) + '" fill="rgba(201,143,69,.08)" stroke="#c98f45" stroke-dasharray="5 4" stroke-width="1.5" vector-effect="non-scaling-stroke"/>';
    }
    if (ann.drag && ann.drag.type === "draw" && ann.drag.cur) {
      var d = ann.drag, r2 = { x1: Math.min(d.sx, d.cur.x), y1: Math.min(d.sy, d.cur.y), x2: Math.max(d.sx, d.cur.x), y2: Math.max(d.sy, d.cur.y) };
      svg += '<rect x="' + r2.x1 + '" y="' + r2.y1 + '" width="' + (r2.x2 - r2.x1) + '" height="' + (r2.y2 - r2.y1) + '" fill="rgba(201,143,69,.1)" stroke="#c98f45" stroke-dasharray="4 3" stroke-width="1.5" vector-effect="non-scaling-stroke"/>';
    }
    overlay.innerHTML = svg;
    var pinHtml = "";
    for (var k = 0; k < ann.notes.length; k++) {
      var n2 = ann.notes[k], at = null;
      if (n2.movementSource) { var md = movementDestinationOf(n2.movementSource); at = { x: md.x1 * z, y: md.y1 * z }; }
      else if (n2.anchor) at = { x: n2.anchor.x * z, y: n2.anchor.y * z };
      else if (n2.kind === "region") at = { x: n2.source.x1 * z, y: n2.source.y1 * z };
      else if (n2.kind === "point") at = { x: n2.point.x * z, y: n2.point.y * z };
      if (!at) continue;
      pinHtml += '<button class="ann-pin' + (n2.id === ann.sel ? " selected" : "") + '" data-apin="' + esc(n2.id) + '" type="button" title="' + esc(n2.text || "批注 " + (k + 1)) + '" style="left:' + at.x + 'px;top:' + at.y + 'px">' + (k + 1) + "</button>";
    }
    pins.innerHTML = pinHtml;
  }
  function annRenderCards() {
    if (!ann) return;
    if (!ann.notes.length) { cards.innerHTML = '<div id="annEmpty">还没有批注——框选或点选画面,写下修改意见</div>'; return; }
    var html = "";
    for (var i = 0; i < ann.notes.length; i++) {
      var n = ann.notes[i], pos = "";
      if (n.kind === "region") pos = Math.round(n.source.x1) + "," + Math.round(n.source.y1) + " · " + Math.round(n.source.x2 - n.source.x1) + "×" + Math.round(n.source.y2 - n.source.y1);
      else if (n.kind === "point") pos = Math.round(n.point.x) + "," + Math.round(n.point.y);
      html += '<article class="ann-card' + (n.id === ann.sel ? " selected" : "") + '" data-acard="' + esc(n.id) + '">' +
        '<div class="ann-card-head"><span class="ann-card-num">' + (i + 1) + '</span><span class="ann-card-kind">' + (n.movementSource ? "移动" : KIND_LABEL[n.kind]) + '</span>' +
        '<span class="ann-card-pos">' + esc(pos) + '</span><button class="ann-card-del" data-adel="' + esc(n.id) + '" type="button" title="删除批注">✕</button></div>' +
        '<textarea data-atext="' + esc(n.id) + '" placeholder="写下修改意见…(编号 ' + (i + 1) + ')" maxlength="10000">' + esc(n.text) + "</textarea></article>";
    }
    cards.innerHTML = html;
    var ta = cards.querySelector("textarea[data-atext='" + (ann.editFocus || "") + "']");
    ann.editFocus = null;
    if (ta) { ta.focus(); ta.closest(".ann-card") && ta.closest(".ann-card").scrollIntoView({ block: "nearest" }); }
  }
  function annRenderAll() {
    document.getElementById("annUndoBtn").disabled = !(ann && ann.undo.length);
    document.getElementById("annRedoBtn").disabled = !(ann && ann.redo.length);
    annPaint(); annRenderCards();
  }
  function annAddNote(note) {
    if (!ann) return;
    if (ann.notes.length >= 1000) { toast("批注数量已达上限(1000)"); return; }
    annRemember(annSnapshot());
    note.id = "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    note.text = "";
    ann.notes.push(note);
    ann.sel = note.id;
    annRenderAll();
    openAnnInline(note.id, anchorOf(note), true);
  }
 // 批注锚点(屏幕坐标,相对 viewport):就地输入框落位用
  function anchorOf(n) {
    var z = ann ? ann.zoom : 1;
    if (n.movementSource) { var r2 = movementDestinationOf(n.movementSource); return { x: r2.x1 * z, y: r2.y1 * z }; }
    if (n.anchor) return { x: n.anchor.x * z, y: n.anchor.y * z }; // 点击点优先(标在你点的地方)
    if (n.kind === "region") return { x: n.source.x1 * z, y: n.source.y1 * z };
    if (n.kind === "point") return { x: n.point.x * z, y: n.point.y * z };
    return null; // 全局:用最近指针位置
  }
 /* ---------- 就地批注输入(输入框在批注旁,不来回跑侧栏)。
 闭包按 noteId 精确关闭:连批场景下旧框 blur 在新框 focus 时同步触发,不能按「当前 inlineId」关。 ---------- */
  var lastMouse = { x: 0, y: 0 };
  function openAnnInline(noteId, at, isNew) {
    if (!ann) return;
    var note = null; for (var i = 0; i < ann.notes.length; i++) if (ann.notes[i].id === noteId) note = ann.notes[i];
    if (!note) return;
    var inline = document.getElementById("annInline"), box = document.getElementById("annInlineText");
    ann.inlineId = noteId;
    box.value = note.text;
    if (!at) at = { x: lastMouse.x, y: lastMouse.y };
    at = { x: at.x + ann.px, y: at.y + ann.py }; // 锚=stage 内坐标 → viewport 屏幕坐标(补画布平移)
    var vw = viewport.clientWidth, vh = viewport.clientHeight, W = 250, H = 116;
    inline.style.left = Math.min(Math.max(6, at.x + 10), Math.max(6, vw - W - 6)) + "px";
    inline.style.top = Math.min(Math.max(6, at.y - H - 6), Math.max(6, vh - H - 6)) + "px";
    var closing = false;
    function close() {
      if (closing) return;
      closing = true;
      if (!ann) { // 提交回执已整体关闭编辑器:尾随 blur 不再触碰已置空的 ann
        box.removeEventListener("blur", onBlur);
        box.removeEventListener("keydown", onKey);
        box.removeEventListener("input", onInput);
        inline.style.display = "none";
        return;
      }
      box.removeEventListener("blur", onBlur);
      box.removeEventListener("keydown", onKey);
      box.removeEventListener("input", onInput);
      var text = String(note.text || "").trim();
      if (!text && isNew) { // 新建且未写一个字:静默丢弃(弹回创建前的撤销栈,不留空批注)
        var idx = -1; for (var j = 0; j < ann.notes.length; j++) if (ann.notes[j].id === noteId) idx = j;
        if (idx >= 0) { ann.notes.splice(idx, 1); if (ann.sel === noteId) ann.sel = null; }
        if (ann.undo.length) ann.undo.pop();
        if (ann.inlineId === noteId) ann.inlineId = null;
        inline.style.display = "none";
        annRenderAll();
        return;
      }
      if (!text && note.movementSource) { // 位移意见未写一个字:组件搬回原位(不留无说明的搬动)
        if (ann.layout && window.GenieAnnotateLayout) {
          var moves0 = trackedMovements();
          for (var mi0 = 0; mi0 < moves0.length; mi0++) if (sameRect(moves0[mi0].source, note.movementSource)) {
            window.GenieAnnotateLayout.moveGroup(ann.layout, moves0[mi0].groupId, moves0[mi0].source);
            break;
          }
        }
        var didx = -1; for (var dj = 0; dj < ann.notes.length; dj++) if (ann.notes[dj].id === noteId) didx = dj;
        if (didx >= 0) { ann.notes.splice(didx, 1); if (ann.sel === noteId) ann.sel = null; }
        if (ann.undo.length) ann.undo.pop();
        if (ann.inlineId === noteId) ann.inlineId = null;
        inline.style.display = "none";
        annPaintCanvas(); annRenderAll();
        return;
      }
      if (ann.inlineId === noteId) ann.inlineId = null;
 // 新框已接管时不清 display(openAnnInline 随后置 block;此处提前隐藏会闪掉新框)
      if (ann.inlineId !== noteId && ann.inlineId === null) inline.style.display = "none";
      annRenderCards();
    }
    function onBlur() { close(); }
    function onKey(ev) {
      if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); close(); }
      else if (ev.key === "Escape") { close(); }
    }
    function onInput() { note.text = box.value; }
    box.addEventListener("blur", onBlur);
    box.addEventListener("keydown", onKey);
    box.addEventListener("input", onInput);
    document.getElementById("annInlineOk").onclick = function () { close(); };
    inline.style.display = "block";
    box.focus(); box.select();
  }
  function annDeleteNote(id) {
    if (!ann) return;
    var idx = -1; for (var i = 0; i < ann.notes.length; i++) if (ann.notes[i].id === id) idx = i;
    if (idx < 0) return;
    if (victim.movementSource && ann.layout && window.GenieAnnotateLayout) {
 // 删位移意见=组件搬回原位,轨迹随之消失
      var L3 = window.GenieAnnotateLayout;
      var moves = trackedMovements();
      for (var mi = 0; mi < moves.length; mi++) if (sameRect(moves[mi].source, victim.movementSource)) {
        annRemember(annSnapshot());
        L3.transform(ann.layout, moves[mi].groupId, moves[mi].source);
        synchronizeMovementNotes();
        if (ann.sel === id) ann.sel = null;
        annPaintCanvas();
        annRenderAll();
        return;
      }
    }
    annRemember(annSnapshot());
    ann.notes.splice(idx, 1);
    if (ann.sel === id) ann.sel = null;
    annRenderAll();
  }
 /** 编辑器指针 → 图像原生像素。唯一换算入口(assets/annotate-coords.js):stage rect + ann.zoom + 图像尺寸,
 * 结果与旧式 (client - rect.left) / zoom 逐字等价(stage 无 border/padding 时 rect.width === ann.w*zoom),并额外吃掉盒子压缩差。 */
  function annImgPoint(ev) {
    var r = stage.getBoundingClientRect();
    var p = annCoords().clientToImage({ x: ev.clientX, y: ev.clientY }, {
      left: r.left, top: r.top, width: r.width, height: r.height,
      imgWidth: ann.w, imgHeight: ann.h, scale: ann.zoom, offsetX: 0, offsetY: 0,
    });
    return { x: clamp(p.x, 0, ann.w), y: clamp(p.y, 0, ann.h) };
  }
  function selBounds() {
    if (!ann || !ann.sel) return null;
    var n = null; for (var i = 0; i < ann.notes.length; i++) if (ann.notes[i].id === ann.sel) n = ann.notes[i];
    return n ? noteRect(n) : null;
  }
  function handleAt(p) {
    var b = selBounds(); if (!b) return null;
    var HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"], near = 10 / ann.zoom;
    var mx = (b.x1 + b.x2) / 2, my = (b.y1 + b.y2) / 2;
    var map = { nw: { x: b.x1, y: b.y1 }, n: { x: mx, y: b.y1 }, ne: { x: b.x2, y: b.y1 }, e: { x: b.x2, y: my }, se: { x: b.x2, y: b.y2 }, s: { x: mx, y: b.y2 }, sw: { x: b.x1, y: b.y2 }, w: { x: b.x1, y: my } };
    for (var i = 0; i < HANDLES.length; i++) {
      var q = map[HANDLES[i]];
      if (Math.abs(p.x - q.x) <= near && Math.abs(p.y - q.y) <= near) return HANDLES[i];
    }
    return null;
  }
  function resizeWith(b, h, p) {
    var r = { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 };
    if (h.indexOf("w") >= 0) r.x1 = clamp(p.x, 0, b.x2 - 1);
    if (h.indexOf("e") >= 0) r.x2 = clamp(p.x, b.x1 + 1, ann.w);
    if (h.indexOf("n") >= 0) r.y1 = clamp(p.y, 0, b.y2 - 1);
    if (h.indexOf("s") >= 0) r.y2 = clamp(p.y, b.y1 + 1, ann.h);
    return r;
  }
  viewport.addEventListener("pointerdown", function (ev) {
    if (!ann || ann.sending || ev.button === 2) return;
    ev.preventDefault(); // 阻止 mousedown 默认聚焦:否则就地输入框刚 focus 就被浏览器焦点抢走→blur→被误丢
    var p = annImgPoint(ev);
    if (ev.button === 0 && ann.spaceDown) { // 空格按住:任意位置拖动=平移
      ann.drag = { type: "pan", sx: ev.clientX, sy: ev.clientY, opx: ann.px, opy: ann.py, moved: false };
      viewport.setPointerCapture(ev.pointerId);
      return;
    }
    if (ev.button === 1 || ann.mode === "select") {
      var hid = ann.mode === "select" ? handleAt(p) : null;
      if (hid) {
        annRemember(annSnapshot());
        ann.drag = { type: "resize", handle: hid, orig: JSON.parse(JSON.stringify(selBounds())) };
        viewport.setPointerCapture(ev.pointerId);
        return;
      }
      var hitId = null;
      for (var i = ann.notes.length - 1; i >= 0; i--) {
        var n = ann.notes[i];
        if (n.kind === "region" && p.x >= n.source.x1 && p.x < n.source.x2 && p.y >= n.source.y1 && p.y < n.source.y2) { hitId = n.id; break; }
        if (n.kind === "point" && Math.hypot((p.x - n.point.x) * ann.zoom, (p.y - n.point.y) * ann.zoom) < 12) { hitId = n.id; break; }
      }
      if (hitId) {
        annRemember(annSnapshot());
        ann.sel = hitId;
        var note = null; for (var j = 0; j < ann.notes.length; j++) if (ann.notes[j].id === hitId) note = ann.notes[j];
        ann.drag = note.kind === "region"
          ? { type: "move", sx: p.x, sy: p.y, orig: JSON.parse(JSON.stringify(note.source)), moved: false }
          : { type: "move-point", sx: p.x, sy: p.y, orig: { x: note.point.x, y: note.point.y }, moved: false };
        annRenderAll();
        viewport.setPointerCapture(ev.pointerId);
        return;
      }
 // 组件模式:命中可搬动组件 → 拖拽=搬运
      if (ann.layout && window.GenieAnnotateLayout) {
        var hits = window.GenieAnnotateLayout.pick(ann.layout, p.x, p.y);
        var pick = hits[clamp(ann.hoverIndex, 0, Math.max(0, hits.length - 1))] || hits[0];
        if (pick) {
          annRemember(annSnapshot());
          ann.drag = { type: "comp-move", groupId: pick.id, start: p, origBounds: JSON.parse(JSON.stringify(pick.bounds)), beforeNotes: JSON.parse(JSON.stringify(ann.notes)), beforeLayout: JSON.parse(JSON.stringify(ann.layout)), moved: false };
          viewport.setPointerCapture(ev.pointerId);
          return;
        }
      }
 // 空白处:拖动=平移,点击=取消选择
      ann.drag = { type: "pan", sx: ev.clientX, sy: ev.clientY, opx: ann.px, opy: ann.py, moved: false };
      viewport.setPointerCapture(ev.pointerId);
      return;
    }
    if (ann.mode === "rect" || ann.mode === "smart") {
 // 不在此 remember:成功创建由 annAddNote 统一记一次(否则一次创建占两格撤销)
      ann.drag = { type: "draw", sx: p.x, sy: p.y, cur: null, cand: ann.mode === "smart" ? candidateAt(p) : null };
      viewport.setPointerCapture(ev.pointerId);
    } else if (ann.mode === "point") {
      annAddNote({ kind: "point", point: { x: clamp(Math.round(p.x), 0, ann.w - 1), y: clamp(Math.round(p.y), 0, ann.h - 1) } });
    }
  });
  function annCoordsText(ev) {
    try {
      var p = annImgPoint(ev);
      document.getElementById("annCoords").textContent = Math.round(p.x) + ", " + Math.round(p.y) + " px";
      var r = stage.getBoundingClientRect();
      lastMouse = { x: ev.clientX - r.left, y: ev.clientY - r.top };
      lastClient = { x: ev.clientX, y: ev.clientY };
    } catch (e) { /* 无害 */ }
  }
  var lastClient = { x: 0, y: 0 };
  viewport.addEventListener("pointermove", function (ev) {
    if (!ann) return;
    annCoordsText(ev);
    if (!ann.drag) {
      if (ann.mode === "smart") {
        var hc = candidateAt(annImgPoint(ev));
        if (hc !== ann.hoverCand) { ann.hoverCand = hc; annRenderOverlay(); }
        annHintPaint();
        stage.style.cursor = hc ? "pointer" : "crosshair";
      } else if (ann.hoverCand) { ann.hoverCand = null; annRenderOverlay(); annHintPaint(); }
      return;
    }
    var d = ann.drag;
    if (d.type === "pan") {
      var dx = ev.clientX - d.sx, dy = ev.clientY - d.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      ann.px = d.opx + dx; ann.py = d.opy + dy;
      annClampView(); // 平移也守边界:图小=恒居中,图大=不能拖出空白
      annPaint();
      return;
    }
    var p = annImgPoint(ev);
    if (d.type === "draw") { d.cur = p; annRenderOverlay(); return; }
    if (d.type === "move") {
      var note = null; for (var i = 0; i < ann.notes.length; i++) if (ann.notes[i].id === ann.sel) note = ann.notes[i];
      if (!note) return;
      var w = d.orig.x2 - d.orig.x1, h = d.orig.y2 - d.orig.y1;
      var nx = clamp(d.orig.x1 + Math.round(p.x - d.sx), 0, ann.w - w), ny = clamp(d.orig.y1 + Math.round(p.y - d.sy), 0, ann.h - h);
      note.source = { x1: nx, y1: ny, x2: nx + w, y2: ny + h };
      if (nx !== d.orig.x1 || ny !== d.orig.y1) d.moved = true;
      annRenderAll();
      return;
    }
    if (d.type === "move-point") {
      var note2 = null; for (var k = 0; k < ann.notes.length; k++) if (ann.notes[k].id === ann.sel) note2 = ann.notes[k];
      if (!note2) return;
      note2.point = { x: clamp(Math.round(d.orig.x + (p.x - d.sx)), 0, ann.w - 1), y: clamp(Math.round(d.orig.y + (p.y - d.sy)), 0, ann.h - 1) };
      d.moved = true;
      annRenderAll();
      return;
    }
    if (d.type === "resize") {
      var note3 = null; for (var m = 0; m < ann.notes.length; m++) if (ann.notes[m].id === ann.sel) note3 = ann.notes[m];
      if (!note3) return;
      note3.source = resizeWith(d.orig, d.handle, p);
      annRenderAll();
      return;
    }
    if (d.type === "comp-move") {
      var L2 = window.GenieAnnotateLayout;
      var dx = Math.round(p.x - d.start.x), dy = Math.round(p.y - d.start.y);
      if (!dx && !dy) return;
      d.moved = true;
      var dest = { x1: d.origBounds.x1 + dx, y1: d.origBounds.y1 + dy, x2: d.origBounds.x2 + dx, y2: d.origBounds.y2 + dy };
      L2.transform(ann.layout, d.groupId, dest); // 轨迹内部追踪
      ann.notes = L2.remapNotes(d.beforeNotes, d.beforeLayout, ann.layout);
      synchronizeMovementNotes();
      annPaintCanvas();
      annRenderOverlay();
      annRenderCards();
      return;
    }
  });
  viewport.addEventListener("pointerup", function (ev) {
    if (!ann || !ann.drag) return;
    var d = ann.drag; ann.drag = null;
    try { viewport.releasePointerCapture(ev.pointerId); } catch (e) { /* 已释放 */ }
    if (d.type === "draw") {
      var dist = Math.hypot((d.cur ? d.cur.x : d.sx) - d.sx, (d.cur ? d.cur.y : d.sy) - d.sy) * ann.zoom;
      if (ann.mode === "smart" && dist < 5) { // 点击:候选块即批注,无候选=点批注(参考同语义)
        if (d.cand) {
          var cx = clamp(Math.round(d.sx), d.cand.x1, d.cand.x2 - 1), cy = clamp(Math.round(d.sy), d.cand.y1, d.cand.y2 - 1);
 // anchor=点击点(图像像素):钉/就地框/预览画在「你点的位置」,几何仍描述整个块
          annAddNote({ kind: "region", source: { x1: d.cand.x1, y1: d.cand.y1, x2: d.cand.x2, y2: d.cand.y2 }, anchor: { x: cx, y: cy } });
        }
        else annAddNote({ kind: "point", point: { x: clamp(Math.round(d.sx), 0, ann.w - 1), y: clamp(Math.round(d.sy), 0, ann.h - 1) } });
        return;
      }
      var x1 = Math.round(Math.min(d.sx, d.cur ? d.cur.x : d.sx)), y1 = Math.round(Math.min(d.sy, d.cur ? d.cur.y : d.sy));
      var x2 = Math.round(Math.max(d.sx, d.cur ? d.cur.x : d.sx)), y2 = Math.round(Math.max(d.sy, d.cur ? d.cur.y : d.sy));
 // 最小框尺寸按 CSS px 判(屏幕上拖了多大):旧口径 3 图像像素在深度缩小后把几十 CSS px 的拖框全吞掉
      if ((x2 - x1) * ann.zoom < 4 || (y2 - y1) * ann.zoom < 4) { annRenderAll(); return; } // 太小=取消,未入栈无须弹栈
      annAddNote({ kind: "region", source: { x1: x1, y1: y1, x2: Math.min(x2, ann.w), y2: Math.min(y2, ann.h) } });
      return;
    }
    if (d.type === "comp-move") {
      if (!d.moved) { // 点击未拖:还原快照(remember 已入栈,弹出)
        ann.layout = d.beforeLayout; ann.notes = d.beforeNotes;
        if (ann.undo.length) ann.undo.pop();
      } else {
        synchronizeMovementNotes();
        var moves2 = trackedMovements();
        for (var mi2 = 0; mi2 < moves2.length; mi2++) {
          var mvn = null; for (var ni = 0; ni < ann.notes.length; ni++) if (ann.notes[ni].movementSource && sameRect(ann.notes[ni].movementSource, moves2[mi2].source)) mvn = ann.notes[ni];
          if (mvn && !String(mvn.text || "").trim()) { ann.sel = mvn.id; annRenderAll(); openAnnInline(mvn.id, anchorOf(mvn), false); break; }
        }
      }
      annRenderAll();
      return;
    }
    if (d.type === "pan" && !d.moved) { ann.sel = null; annRenderAll(); }
    if (d.type === "move" && !d.moved) annRenderCards();
  });
  viewport.addEventListener("wheel", function (ev) {
    if (!ann || ann.drag) return; // 拖拽中滚轮不介入(参考同守卫,防几何错位)
    ev.preventDefault();
    if (ev.shiftKey && ann.mode === "smart") { annCycleCand(ev.deltaY > 0 ? 1 : -1); return; } // Shift+滚轮=换候选(不抢缩放)
    annZoomAt(Math.exp(-ev.deltaY * 0.0018), ev.clientX, ev.clientY); // 滚轮恒缩放(默认模式不能缩放反直觉)
  }, { passive: false });
  viewport.addEventListener("pointerleave", function () {
    document.getElementById("annCoords").textContent = "";
    if (ann && ann.hoverCand) { ann.hoverCand = null; annRenderOverlay(); }
  });
 // 窗口尺寸变化:fit 态(未手动缩放)重跑 annFit 保完整居中;手动态不动用户视野
  window.addEventListener("resize", function () { if (ann && !ann.userZoomed) annFit(); });
  pins.addEventListener("click", function (ev) {
    var id = ev.target && ev.target.getAttribute ? ev.target.getAttribute("data-apin") : null;
    if (!id || !ann) return;
    ann.sel = id; annRenderAll();
    var note = null; for (var pi = 0; pi < ann.notes.length; pi++) if (ann.notes[pi].id === id) note = ann.notes[pi];
    if (note) openAnnInline(id, anchorOf(note)); // 钉点击=选中并就地编辑
    var card = cards.querySelector("[data-acard='" + id + "']");
    if (card) card.scrollIntoView({ block: "nearest" });
  });
  cards.addEventListener("keydown", function (ev) {
    var t = ev.target;
    if (t && t.tagName === "TEXTAREA" && ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); try { t.blur(); } catch (e) { /* 无害 */ } }
  });
  cards.addEventListener("input", function (ev) {
    var id = ev.target && ev.target.getAttribute ? ev.target.getAttribute("data-atext") : null;
    if (!id || !ann) return;
    for (var i = 0; i < ann.notes.length; i++) if (ann.notes[i].id === id) ann.notes[i].text = ev.target.value;
  });
  cards.addEventListener("click", function (ev) {
    if (!ann) return;
    var del = ev.target && ev.target.getAttribute ? ev.target.getAttribute("data-adel") : null;
    if (del) { annDeleteNote(del); return; }
    var card = ev.target.closest ? ev.target.closest("[data-acard]") : null;
    if (!card) return;
    var id = card.getAttribute("data-acard");
 // 点在 textarea 上(想打字):只补选中态,不重建卡片(重建会丢输入焦点,用户得点两次)
    if (ev.target && ev.target.tagName === "TEXTAREA") {
      if (ann.sel !== id) {
        ann.sel = id; annPaint();
        var cardsAll = cards.querySelectorAll("[data-acard]");
        for (var ci = 0; ci < cardsAll.length; ci++) cardsAll[ci].classList.toggle("selected", cardsAll[ci].getAttribute("data-acard") === id);
      }
      return;
    }
    if (ann.sel !== id) { ann.sel = id; annRenderAll(); }
  });
  var tools = document.querySelectorAll(".ann-tool");
  for (var ti = 0; ti < tools.length; ti++) tools[ti].onclick = function () {
    var mode = this.getAttribute("data-amode");
    if (mode === "global") { annAddNote({ kind: "global" }); return; } // 全局批注:就地输入框落在最近指针处(anchorOf 返回 null)
    setAnnMode(mode);
  };
  document.getElementById("annCompBtn").onclick = function () {
    if (!ann) return;
    if (ann.layout) { // 关闭组件模式:保留已搬动状态(面板可见箭头消失?不——保留 layout 继续生效)
      this.classList.toggle("active");
      ann.layoutMode = !ann.layoutMode;
      setAnnMode(ann.layoutMode ? "select" : "smart");
      toast(ann.layoutMode ? "组件模式:拖动组件表达布局意图" : "已退出组件模式(已搬动的组件保持原样)");
      return;
    }
    if (!window.GenieAnnotateLayout) { toast("组件引擎未加载,刷新页面重试", 1); return; }
    try {
      ann.layout = window.GenieAnnotateLayout.build(ann.w, ann.h, ann.candidates || []);
      ann.layoutMode = true;
      this.classList.add("active");
      setAnnMode("select");
      annPaintCanvas();
      toast("组件模式:拖动画面里的组件表达布局意图(候选 " + (ann.candidates || []).length + " 个)");
    } catch (e) { toast("组件切分失败:" + String(e && e.message || e).slice(0, 80), 1); }
  };
  document.getElementById("annFitBtn").onclick = annFit;
  document.getElementById("annZoomIn").onclick = function () { annZoomAt(1.25); };
  document.getElementById("annZoomOut").onclick = function () { annZoomAt(0.8); };
  document.getElementById("annUndoBtn").onclick = annUndo;
  document.getElementById("annRedoBtn").onclick = annRedo;
  document.getElementById("annCancel").onclick = closeAnnotateEditor;
  document.getElementById("annClear").onclick = function () {
    if (!ann || !ann.notes.length) return;
    if (!window.confirm("清空全部 " + ann.notes.length + " 条批注?")) return;
    annRemember(annSnapshot()); ann.notes = []; ann.sel = null; annRenderAll();
  };

 /* ---------- 提交:落盘+投递由服务端完成(annotate.submit) ---------- */
 // 预览图:原图+框线+编号圆钉,供 agent 直观对照编号。
 // 全局意见无坐标不画标记;全部为 global 时预览无增量信息,不上传(服务端也就不落 preview)。
 // notes=提交后(剔除空文本)的批注数组:预览编号必须与 JSON 的 annotations[].number 同源,
 // 否则空文本批注存在时图上编号与反馈编号错位,agent 对照会错。
  function renderAnnPreview(notes) {
    if (!ann || !notes) return null;
    var hasMarked = false;
    for (var q = 0; q < notes.length; q++) if (notes[q].kind !== "global") { hasMarked = true; break; }
    if (!hasMarked) return null;
    var c = document.createElement("canvas"); c.width = ann.w; c.height = ann.h;
    var g = c.getContext("2d");
    g.drawImage(ann.img, 0, 0);
    var line = Math.max(1, ann.w / 800);
    g.lineWidth = line * 2; g.strokeStyle = "#c98f45"; g.lineCap = "round"; g.lineJoin = "round";
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i], at = null;
      if (n.kind === "region" && n.source.x2 > n.source.x1) {
        g.strokeRect(n.source.x1, n.source.y1, n.source.x2 - n.source.x1, n.source.y2 - n.source.y1);
        at = n.anchor ? { x: n.anchor.x, y: n.anchor.y } : { x: n.source.x1, y: n.source.y1 };
      } else if (n.movementSource) {
        at = { x: n.source.x1, y: n.source.y1 }; // 位移批注:原图上锚定源区角(目标由 JSON movement 描述)
      } else if (n.kind === "point") {
        at = { x: n.point.x, y: n.point.y };
      }
      if (!at) continue; // 全局意见无坐标,不画标记
      var r = line * 12;
      at.x = Math.min(Math.max(at.x, r), c.width - r); at.y = Math.min(Math.max(at.y, r), c.height - r);
      g.beginPath(); g.arc(at.x, at.y, r, 0, Math.PI * 2); g.fillStyle = "#c98f45"; g.fill();
      g.fillStyle = "#171008"; g.font = "bold " + Math.round(line * 13) + "px sans-serif";
      g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(String(i + 1), at.x, at.y);
    }
    return c.toDataURL("image/jpeg", 0.85);
  }
  function annSubmit() {
    if (!ann || ann.sending) return;
 // 组件拆移装配(必须先于载荷构建):位移意见必须有说明(否则搬动悬空无意义),
 // 被搬动组件覆盖内的普通批注折叠为它的 children(坐标已是搬动后画面)
    if (ann.layout) {
      var movesAll = trackedMovements();
      for (var mi3 = 0; mi3 < movesAll.length; mi3++) {
        var hasText = ann.notes.some(function (n) { return n.movementSource && sameRect(n.movementSource, movesAll[mi3].source) && String(n.text || "").trim(); });
        if (!hasText) { toast("移动过的组件要写一句意见(点它旁边带箭头的编号钉)", 1); return; }
      }
      var movSrcs = movesAll.map(function (m) { return m.source; });
      var insideMoved = function (src) {
        for (var k = 0; k < movSrcs.length; k++) {
          var s = movSrcs[k];
          if (src.x1 >= s.x1 && src.y1 >= s.y1 && src.x2 <= s.x2 && src.y2 <= s.y2 && (src.x2 - src.x1) * (src.y2 - src.y1) > 0) return s;
        }
        return null;
      };
      var kept = [];
      for (var ni3 = 0; ni3 < ann.notes.length; ni3++) {
        var n3 = ann.notes[ni3];
        if (n3.movementSource) { kept.push(n3); continue; }
        if (n3.kind === "region" && !n3.anchor) {
          var owner = insideMoved(n3.source);
          if (owner) {
 // 随组件搬走的批注 → 子批注(坐标换算回搬动后画面)
            for (var mj = 0; mj < ann.notes.length; mj++) if (ann.notes[mj].movementSource && sameRect(ann.notes[mj].movementSource, owner)) {
 // 子批注 source=搬动后画面的绝对坐标
              (ann.notes[mj].children = ann.notes[mj].children || []).push({ source: cloneRect(n3.source), text: String(n3.text || "").trim() });
            }
            continue; // 从独立批注里移除
          }
        }
        kept.push(n3);
      }
      ann.notes = kept;
    }
    var notes = [];
    for (var i = 0; i < ann.notes.length; i++) {
      var n = ann.notes[i], text = String(n.text || "").trim();
      if (n.movementSource) { // 位移批注:source=原始区域,movement.rect=最终区域(零位移不可发生:空文字已在装配段拦截)
        var mdest = movementDestinationOf(n.movementSource);
        notes.push({ kind: "region", source: { x1: n.movementSource.x1, y1: n.movementSource.y1, x2: n.movementSource.x2, y2: n.movementSource.y2 }, text: text, movement: { rect: { x1: mdest.x1, y1: mdest.y1, x2: mdest.x2, y2: mdest.y2 } }, ...(n.children && n.children.length ? { children: n.children } : {}) });
        continue;
      }
      if (!text) continue;
      if (n.kind === "region") notes.push({ kind: "region", source: { x1: n.source.x1, y1: n.source.y1, x2: n.source.x2, y2: n.source.y2 }, text: text, ...(n.anchor ? { anchor: n.anchor } : {}) });
      else if (n.kind === "point") notes.push({ kind: "point", point: { x: n.point.x, y: n.point.y }, text: text });
      else notes.push({ kind: "global", text: text });
    }
 // 录音:纯口述也允许提交(自动补一条覆盖全图的 region 文本,服务端 region text 非空即通过);
 // 超 8MB 直接拦下并告知(不静默丢弃)
    var recBlob = ann.rec && ann.rec.blob && ann.rec.blob.size > 0 ? ann.rec.blob : null;
    if (recBlob && recBlob.size > 8 * 1024 * 1024) { toast("录音过大(>8MB),请缩短或重录", 1); return; }
    if (!notes.length) {
      if (!recBlob) { toast("至少写一条意见(在右侧卡片输入)", 1); return; }
      notes.push({ kind: "region", source: { x1: 0, y1: 0, x2: ann.w, y2: ann.h }, text: "(见录音评论:用户口述,无图上文字)" });
    }
    var dropped = ann.notes.length - notes.length;
    if (dropped > 0) toast("已跳过 " + dropped + " 条空白批注");
    var sid = currentSid || ("web-" + Date.now());
    if (!currentSid) { currentSid = sid; try { sessionStorage.setItem("zh:sid", sid); localStorage.setItem("zh:sid", sid); } catch (e) { /* 存储不可用 */ } }
    var page = "";
    try { page = String(document.getElementById("annPage").value || "").trim().slice(0, 500); } catch (e) { page = ""; }
    var payload = {
      v: 1, type: "annotate.submit", sessionId: sid, dataUrl: ann.dataUrl, notes: notes,
      previewDataUrl: renderAnnPreview(notes),
      capture: { source: ann.cap.source, capturedAt: ann.cap.capturedAt, ...(ann.cap.fileName ? { fileName: ann.cap.fileName } : {}) },
      ...(page ? { pageContext: page } : {}),
    };
    ann.sending = true; sendBtn.disabled = true; sendBtn.textContent = "发送中…";
    annMain.style.pointerEvents = "none"; // 发送锁:期间禁止编辑
    try { document.getElementById("annPage").disabled = true; } catch (e) { /* 无害 */ }
 // 录音 → dataURL 必须先走 FileReader(异步):读完后才发;发送锁与超时兜底语义保持不变
    var doSend = function (audioUrl) {
      if (!ann) return;
      if (audioUrl) payload.audioUrl = audioUrl; // 仅在真有录音时带字段
      wsSafeSend(JSON.stringify(payload));
 // 超时兜底:网关重启/回执丢失时
 // 不让编辑器卡死在「发送中…」;sending 期禁关窗,超时放行让用户重试。
      if (ann.submitTimer) clearTimeout(ann.submitTimer);
      ann.submitTimer = setTimeout(function () {
        if (!ann || !ann.sending) return;
        annUnlock();
        toast("服务未回执(可能已送达也可能未送达),批注已保留,可重试发送", 1);
      }, 30000);
    };
    if (!recBlob) { doSend(""); return; }
    var fr = new FileReader();
    fr.onload = function () { doSend(String(fr.result || "")); };
    fr.onerror = function () { annUnlock(); toast("录音读取失败,请删除录音或重录后再发送", 1); };
    fr.readAsDataURL(recBlob);
  }
  function annUnlock() {
    if (!ann) return;
    ann.sending = false; sendBtn.disabled = false; sendBtn.textContent = "发送给任务";
    annMain.style.pointerEvents = "";
    try { document.getElementById("annPage").disabled = false; } catch (e) { /* 无害 */ }
  }
  sendBtn.onclick = function () { if (vid && vid.blob) { annVidSubmit(); return; } annSubmit(); };
  window.__annTestSubmit = function () { try { annSubmit(); return "ok:" + (ann ? "open" : "closed"); } catch (e) { return "ERR:" + (e && e.message || e); } };
  function onAnnotateResult(m) {
    if (ann && ann.submitTimer) { clearTimeout(ann.submitTimer); ann.submitTimer = null; }
    if (!ann) { if (!m.ok && m.message) toast(m.message, 1); return; }
    annUnlock();
    if (m.ok) {
      annRecDispose(); // 发送成功:停录 + revoke blob URL(音频已随载荷上行)
      ann = null; editor.style.display = "none";
 // 回执文案带整理状态(服务端 refined / voiceError,另一子代理在 protocol 侧扩展)
      var okMsg = m.queued ? "标注反馈已写入队列,将随当前任务续发"
        : (m.refined === true ? "标注反馈已发送(已 LLM 整理)"
          : (m.refined === false ? "标注反馈已发送(未经 LLM 整理)" : "标注反馈已发送给任务"));
      if (m.voiceError) okMsg += " · 录音解析失败:" + String(m.voiceError).slice(0, 120) + "(音频已保留)";
      toast(okMsg, m.voiceError ? 1 : 0);
    } else {
      toast(m.message || "提交失败", 1);
    }
  }
  document.addEventListener("keydown", function (ev) {
    if (cap) {
      if (ev.key === "Escape") { closeCaptureOverlay(); }
      else if (ev.key === "Enter") { confirmCapture(); }
      else if (ev.code === "Space") { ev.preventDefault(); cap.spaceDown = true; capCanvas.style.cursor = "grab"; }
      return;
    }
    if (!ann) return;
    var a = document.activeElement;
    var typing = a && ((a.tagName === "TEXTAREA" || a.tagName === "INPUT") && editor.contains(a));
    if (ev.key === "Escape") {
      if (typing) {
        try { a.blur(); } catch (e) { /* 无害 */ } return; // 输入框内 Esc=退出输入(就地框 blur=保存关闭)
      }
      if (ann.drag) { ann.drag = null; annRenderAll(); return; } // 先取消拖拽
      if (ann.sel) { ann.sel = null; annRenderAll(); return; }  // 再取消选择
      closeAnnotateEditor(); return; // 最后才关编辑器
    }
    if (typing) return; // 输入框内的其余按键不触发编辑快捷键
    var ctrl = ev.ctrlKey || ev.metaKey;
    var key = ev.key.toLowerCase();
    if (ctrl && (key === "z" || key === "y")) { ev.preventDefault(); if (key === "y" || ev.shiftKey) { annRedo(); } else { annUndo(); } return; }
    if (ev.code === "Space" && !typing) { ev.preventDefault(); ann.spaceDown = true; viewport.style.cursor = "grab"; return; }
    if (ev.key === "0") { ev.preventDefault(); annFit(); return; }
    if (ev.key === "1") { ev.preventDefault(); annZoomAt(1 / ann.zoom); return; }
    if (ev.key === "+" || ev.key === "=") { ev.preventDefault(); annZoomAt(1.25); return; }
    if (ev.key === "-") { ev.preventDefault(); annZoomAt(0.8); return; }
    if ((key === "[" || key === "]" || key === "tab") && ann.mode === "smart") { // 换候选块:小块↔大块(Tab/Shift+Tab 同效)
      ev.preventDefault();
      var step = key === "tab" ? (ev.shiftKey ? -1 : 1) : (key === "]" ? 1 : -1);
      annCycleCand(step);
      return;
    }
    if (key === "v" || key === "b" || key === "r" || key === "p") { setAnnMode({ v: "select", b: "smart", r: "rect", p: "point" }[key]); return; }
    if (key === "g") { annAddNote({ kind: "global" }); return; }
    if (ev.key === "Delete" || ev.key === "Backspace") { if (ann.sel) { annDeleteNote(ann.sel); } return; }
    if (ev.key.indexOf("Arrow") === 0 && ann.sel) { // 方向键微调批注(Shift=10px)
      var note = null; for (var i = 0; i < ann.notes.length; i++) if (ann.notes[i].id === ann.sel) note = ann.notes[i];
      if (!note) return;
      var amount = ev.shiftKey ? 10 : 1;
      var dx = ev.key === "ArrowLeft" ? -amount : ev.key === "ArrowRight" ? amount : 0;
      var dy = ev.key === "ArrowUp" ? -amount : ev.key === "ArrowDown" ? amount : 0;
      if (!dx && !dy) return;
      ev.preventDefault();
      annRemember(annSnapshot());
      if (note.kind === "region") {
        var w = note.source.x2 - note.source.x1, h = note.source.y2 - note.source.y1;
        note.source = { x1: Math.min(Math.max(note.source.x1 + dx, 0), ann.w - w), y1: Math.min(Math.max(note.source.y1 + dy, 0), ann.h - h), x2: 0, y2: 0 };
        note.source.x2 = note.source.x1 + w; note.source.y2 = note.source.y1 + h;
      } else if (note.kind === "point") {
        note.point = { x: Math.min(Math.max(note.point.x + dx, 0), ann.w - 1), y: Math.min(Math.max(note.point.y + dy, 0), ann.h - 1) };
      } else { return; }
      annRenderAll();
    }
  });
  document.addEventListener("keyup", function (ev) {
    if (cap && ev.code === "Space") { cap.spaceDown = false; capCanvas.style.cursor = "crosshair"; }
    if (ann && ev.code === "Space") { ann.spaceDown = false; viewport.style.cursor = ann.mode === "select" ? "default" : "crosshair"; }
  });
  window.addEventListener("blur", function () { if (ann) { ann.spaceDown = false; ann.drag = null; } });
  window.addEventListener("resize", function () { if (ann && !ann.userZoomed) annFit(); });
 // 刷新/关页守卫:编辑器或取屏中有内容时浏览器弹离开确认
  window.addEventListener("beforeunload", function (ev) {
    if ((ann && (ann.notes.length || ann.sending)) || cap) { ev.preventDefault(); ev.returnValue = ""; }
  });
 /* ---------- 导入已有图片(文件选择/粘贴/拖入) ---------- */
  function importImageFile(file) {
    if (!file) return;
    if (file.type && file.type.indexOf("image/") !== 0) { toast("请选择图片文件(PNG/JPEG/WebP/GIF/BMP)", 1); return; }
    var name = file.name || "粘贴的图片";
    var r = new FileReader();
    r.onload = function () {
 // 打开成功与否由编辑器 meta 行呈现(文件名/尺寸),此处不弹 toast(openAnnotateEditor 异步,此处判断不到)
      openAnnotateEditor(String(r.result), { source: "file", fileName: name, capturedAt: file.lastModified ? new Date(file.lastModified).toISOString() : new Date().toISOString() });
    };
    r.onerror = function () { toast("图片读取失败:" + name, 1); };
    r.readAsDataURL(file);
  }
  document.getElementById("annImportBtn").onclick = function () { document.getElementById("annImportInput").click(); };
  document.getElementById("annImportInput").onchange = function () {
    var f = this.files && this.files[0];
    this.value = "";
    importImageFile(f);
  };
 // 编辑器打开时,粘贴图片走导入(面板主脚本另有全页粘贴→附件通道;capture 相先于其 bubble 监听)
  document.addEventListener("paste", function (ev) {
    if (!ann) return;
    var t = ev.target;
    if (t && ((t.tagName === "TEXTAREA" || t.tagName === "INPUT") && editor.contains(t))) return;
    var items = ev.clipboardData && ev.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf("image/") === 0) {
        ev.preventDefault(); ev.stopPropagation();
        importImageFile(items[i].getAsFile());
        return;
      }
    }
  }, true);
 // 编辑器打开时,拖入图片文件走导入(同理 capture 相截获,防串到附件通道)
  document.addEventListener("dragover", function (ev) {
    if (ann && ev.dataTransfer && ev.dataTransfer.types && ev.dataTransfer.types.indexOf("Files") >= 0) ev.preventDefault();
  }, true);
  document.addEventListener("drop", function (ev) {
    if (!ann) return;
    var files = ev.dataTransfer && ev.dataTransfer.files;
    if (!files || !files.length) return;
    for (var i = 0; i < files.length; i++) {
      if (files[i].type && files[i].type.indexOf("image/") === 0) {
        ev.preventDefault(); ev.stopPropagation();
        importImageFile(files[i]);
        return;
      }
    }
  }, true);

 /* ---------- 入口与回执 ---------- */
  var shotBtn = document.getElementById("shotBtn");
  if (shotBtn) shotBtn.onclick = startScreenShot;
 // E2E 钩子:浏览器测试注入合成截图,绕过 getDisplayMedia(权限/无头环境),其余链路全真。
  window.__annTestOpen = function (dataUrl, opts) { openAnnotateEditor(dataUrl, opts); };
  window.__annTestState = function () { return ann ? { mode: ann.mode, candidates: (ann.candidates || []).length, fine: (ann.fineCands || []).length, hover: !!ann.hoverCand, hoverPos: ann.hoverPos || 0, hoverChoices: ann.hoverChoices || 0, notes: ann.notes.length, sending: !!ann.sending, groups: ann.layout ? ann.layout.groups.length : -1, pieces: ann.layout ? ann.layout.pieces.length : -1, layoutMode: !!ann.layoutMode } : null; };
 // 缩放/选框保真验收钩子:真实 client rect(含 transform),给 E2E 做「图像像素 ↔ 页面坐标」换算。
  window.__annView = function () {
    if (!ann) return null;
    var vp = viewport.getBoundingClientRect(), st = stage.getBoundingClientRect();
    return { zoom: ann.zoom, img: { w: ann.w, h: ann.h },
      vp: { w: vp.width, h: vp.height, l: vp.left, t: vp.top },
      stage: { l: st.left - vp.left, t: st.top - vp.top, w: st.width, h: st.height } };
  };
  window.__annNotes = function () {
    return ann ? ann.notes.map(function (n) { return { kind: n.kind, source: n.source ? { x1: n.source.x1, y1: n.source.y1, x2: n.source.x2, y2: n.source.y2 } : null, point: n.point || null, text: n.text || "", anchor: n.anchor || null }; }) : [];
  };
  window.__annTestDetect = annDetectRegions;
 // 选块验收钩子:返回当前候选框(图像像素)→ E2E 断言「大框里的小框」也在候选里。
  window.__annCandidates = function () { return ann ? (ann.candidates || []).concat(ann.fineCands || []).map(function (c) { return { label: c.label, fine: !!c.fine, x1: c.bounds.x1, y1: c.bounds.y1, x2: c.bounds.x2, y2: c.bounds.y2 }; }) : []; };
  window.__annTestCycle = function (delta) { return annCycleCand(delta || 1); };
  window.__annResult = onAnnotateResult;
})();
</script>`;
