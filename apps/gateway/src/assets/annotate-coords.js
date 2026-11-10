/* 截图标注坐标换算层( 抽出,纯函数、无 DOM 依赖:浏览器挂 window.GenieAnnotateCoords,node 可 require 单测)。
 * 唯一职责:把「屏幕上的一次指针事件坐标」精确换成「图像原生像素」,并在下列真实病灶下仍逐像素对齐:
 *   - DOM 盒子尺寸 ≠ 位图布局尺寸(flex 压缩 / #capOverlay inset:0 取 clientWidth 而位图按 innerWidth 建,含滚动条差)
 *   - DPR 位图放大(位图 device px 放大,字符面仍按 CSS px 显示)
 *   - 图像在盒子里居中留边(offsetX/offsetY 非 0)+ 滚轮缩放(scale ≠ 1)
 * 两轴各自归一(scaleX/scaleY 分别算),不假设等比 —— 横向与纵向误差不应互相污染。
 * box 模型(全部 CSS px,除 imgWidth/imgHeight 为图像原生像素):
 *   left/top                 盒子在客户端坐标里的左上角(getBoundingClientRect)
 *   width/height             盒子实际 CSS 尺寸(可能被压扁,≠ 布局尺寸)
 *   imgWidth/imgHeight       图像原生像素尺寸
 *   scale                    图像像素 → 布局 CSS 像素比例(缺省 1)
 *   offsetX/offsetY          图像左上角相对盒子左上角的位置,单位=布局 CSS 像素(缺省 0)
 *   layoutWidth/layoutHeight 布局空间尺寸(缺省 imgWidth*scale / imgHeight*scale);
 *                            盒子被压扁时 layoutWidth/width、layoutHeight/height 即两轴归一系数
 */
(function () {
  "use strict";
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }
  /** 归一化 box:缺省值 + 两轴压缩系数(屏幕 CSS px → 布局 CSS px)。 */
  function prep(box) {
    var b = box || {};
    var scale = num(b.scale, 1); if (!(scale > 0)) scale = 1;
    var imgW = num(b.imgWidth, 0), imgH = num(b.imgHeight, 0);
    var w = num(b.width, 0), h = num(b.height, 0);
    var lw = num(b.layoutWidth, imgW * scale), lh = num(b.layoutHeight, imgH * scale);
    if (!(lw > 0)) lw = imgW * scale;
    if (!(lh > 0)) lh = imgH * scale;
    return {
      left: num(b.left, 0), top: num(b.top, 0),
      kx: w > 0 && lw > 0 ? lw / w : 1, ky: h > 0 && lh > 0 ? lh / h : 1,
      ox: num(b.offsetX, 0), oy: num(b.offsetY, 0), scale: scale,
      imgW: imgW, imgH: imgH, w: w, h: h, lw: lw, lh: lh,
    };
  }
  /** 客户端坐标 → 图像原生像素(不 clamp:越界由调用方决定夹取口径)。 */
  function clientToImage(pt, box) {
    var p = prep(box), x = num(pt && pt.x, 0), y = num(pt && pt.y, 0);
    return { x: ((x - p.left) * p.kx - p.ox) / p.scale, y: ((y - p.top) * p.ky - p.oy) / p.scale };
  }
  /** 图像原生像素 → 客户端坐标(clientToImage 的严格逆)。 */
  function imageToClient(pt, box) {
    var p = prep(box), x = num(pt && pt.x, 0), y = num(pt && pt.y, 0);
    var lx = x * p.scale + p.ox, ly = y * p.scale + p.oy;
    return { x: p.left + lx / p.kx, y: p.top + ly / p.ky };
  }
  /** CSS 显示尺寸 + DPR → canvas 位图尺寸(取整、下限 1,DPR 非法/<=0 当 1)。 */
  function bitmapOf(cssWidth, cssHeight, dpr) {
    var d = num(dpr, 1); if (!(d > 0)) d = 1;
    return {
      width: Math.max(1, Math.round(num(cssWidth, 1) * d)),
      height: Math.max(1, Math.round(num(cssHeight, 1) * d)),
    };
  }
  /** 图像铺进盒子的比例:cover=铺满取 max、contain=完整可见取 min(cap1=true 时不放大超出 1:1)。 */
  function fitScale(imgWidth, imgHeight, boxWidth, boxHeight, opts) {
    var iw = num(imgWidth, 0), ih = num(imgHeight, 0), bw = num(boxWidth, 0), bh = num(boxHeight, 0);
    if (!(iw > 0) || !(ih > 0) || !(bw > 0) || !(bh > 0)) return 1;
    var o = opts || {}, sx = bw / iw, sy = bh / ih;
    var s = o.cover ? Math.max(sx, sy) : Math.min(sx, sy);
    if (!o.cover && o.cap1) s = Math.min(s, 1);
    return s > 0 ? s : 1;
  }
  var api = { clientToImage: clientToImage, imageToClient: imageToClient, bitmapOf: bitmapOf, fitScale: fitScale };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.GenieAnnotateCoords = api;
})();
