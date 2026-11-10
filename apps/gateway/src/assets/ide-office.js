/* Office 文档渲染件(板节点 ide-o2 PPTX 幻灯片视图 / ide-o3 DOCX 文档流视图的渲染半边)。
 * 输入契约(服务端固定产出,本文件只消费)AST v2:
 *   GET /ide/office?path=…&pid=… → { kind:"pptx", slides:[{index,widthEmu,heightEmu,shapes:[…]}] }
 *                                   { kind:"docx", blocks:[…], headers?, footers?, footnotes? }
 *   shape.type ∈ text|image|shape|table|chart|unsupported(shape 带 table/chart/diagram 载荷时按载荷画);
 *   shape.fill 可为纯色字符串或 {gradient:{angle,stops}};shape.shadow / shape.stroke 可选;
 *   run.revised ∈ ins|del;block.comments 为批注文本数组。
 * 渲染策略:
 *   - PPTX:单页切换(不把 N 页同时挂 DOM,省内存);页尺寸 EMU→px(1px = 9525 EMU,96dpi),
 *     子元素全部按百分比定位,整页用一个 transform: scale(k) 适配容器宽 —— 文字是矢量重采样,
 *     放缩后不糊(对比 width:100% + aspect-ratio 会把 px 字号锁死)。
 *   - DOCX:单一 .io-page(白底 / A4 比例 / 内距 48px / max-width 820px / 居中),块流自上而下排;
 *     页眉 / 脚注 / 页脚各一个灰色小字区块,空数组则不渲染。
 *   - 图表走纯 DOM(百分比绝对定位 + conic-gradient 饼图),不用 canvas(无需释放)、不用 SVG(不引外部命名空间)。
 * 安全:文档内容是不可信输入 —— 全程 textContent + createElement,零 HTML 字符串拼接(不碰 inner-markup 接口);
 *   颜色/填充/图片地址走白名单校验(safeColor / safeFill / safeSrc),样式注入与协议注入都挡在纯函数里
 *   (渐变串落 style 前再兜一次 url( / javascript: / expression( / ;position 黑名单)。
 * 降级:render 全程 try/catch,host 缺失 / ast 非对象 / kind 未知 / DOM 不可用 → {ok:false, reason}
 *   并在 host 写一行降级文案;绝不抛未捕获异常、绝不白屏。表格单元格 / 图表数据点 / SmartArt 节点数
 *   超 200 时降级为占位文案(防炸)。
 * 自包含:IIFE 挂 window.IdeOffice(无 window 退 globalThis),无任何外部资源。 */
(function () {
  "use strict";

  var EMU_PER_PX = 9525;            // 96dpi:1px = 9525 EMU
  var DEF_W_EMU = 12192000;         // 16:9 标准页宽(1280px)
  var DEF_H_EMU = 6858000;          // 16:9 标准页高(720px)
  var A4_RATIO = 297 / 210;
  var FONT =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif';
  var MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace';
  var HEADING_PX = [0, 24, 20, 17]; // Heading1/2/3
  var BODY_PX = 15;
  var UNSUPPORTED_TEXT = "暂不支持(chart/SmartArt/嵌入媒体/组合)";
  var DOCX_SKIP_TEXT = "(此处有暂不支持的内容,已跳过)";
  var EMPTY_TEXT = "(空文档)";
  var IMG_MISSING_TEXT = "图片缺失";
  var GRAY = { bg: "#f1f2f4", line: "#b3b8c0", text: "#6b7280" };
  var SHELL_BG = "#e9eaee";
  var INK = "#1f2328";
  /* ---- AST v2 扩展(渐变 / 阴影描边 / 表格 / 图表 / SmartArt / 修订 / 批注 / 页眉页脚脚注)---- */
  var REV_INS = "#1a7f37";          // 修订-插入:绿色系(常量,不吃用户输入)
  var REV_DEL = "#b42318";          // 修订-删除:红色系(文本仍显示,只加删除线,不像 Word 默认隐藏)
  var PALETTE = ["#4c78a8", "#f58518", "#e45756", "#72b7b2", "#54a24b", "#eeca3b", "#b279a2", "#9d755d"];
  var MAX_NODES = 200;              // 单个表格单元格数 / 图表数据点数 / SmartArt 节点数上限,超了降级占位
  var MAX_STROKE_PX = 20;           // 描边宽度夹取上限
  var MAX_CATS = 8;                 // 图表分类标签超过这个数就按步长抽稀
  var CHART_EMPTY_TEXT = "(无数据)";
  var TABLE_EMPTY_TEXT = "(无表格数据)";
  var SMARTART_EMPTY_TEXT = "SmartArt 无节点";
  var COMMENT_ICON = "💬";
  var TABLE_LINE = "#d6d9de";
  var TABLE_HEAD_BG = "#f4f5f7";
  /* 样式注入黑名单:渐变串(唯一拼接出来的 CSS 值)落盘前再兜一次。 */
  var CSS_BAD_RE = /url\(|javascript:|expression\(|;position/i;

  /* ---------------- 纯函数(可测,挂 __test) ---------------- */

  function num(v, dflt) {
    return typeof v === "number" && isFinite(v) ? v : dflt;
  }

  /** EMU → CSS px(96dpi)。 */
  function emuToPx(emu) {
    return num(emu, 0) / EMU_PER_PX;
  }

  /** 绝对量 → 占页面的百分比字符串;越界夹紧到 [0,100],total 非法退 "0%"。 */
  function pct(value, total) {
    var t = num(total, 0);
    if (!(t > 0)) return "0%";
    var r = (num(value, 0) / t) * 100;
    if (!isFinite(r) || r < 0) r = 0;
    if (r > 100) r = 100;
    var s = r.toFixed(4);
    if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
    return s + "%";
  }

  /** HTML 转义(字符类五连)。内部渲染走 textContent,此函数供字符串场景兜底。 */
  function esc(v) {
    if (v === null || v === undefined) return "";
    return String(v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  var COLOR_RE = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(0|1|0?\.\d+)\s*\)|transparent|white|black)$/i;
  /** 颜色白名单(文档里的 fill / color 直接进 style,必须挡住 style 注入)。 */
  function safeColor(v, dflt) {
    var s = typeof v === "string" ? v.trim() : "";
    if (s && COLOR_RE.test(s)) return s;
    return typeof dflt === "string" ? dflt : "";
  }

  /** 图片地址白名单:只接受同源绝对路径("/…"),挡掉协议头、协议相对("//host")与内联脚本。 */
  function safeSrc(v) {
    var s = typeof v === "string" ? v.trim() : "";
    if (!s) return "";
    if (s.charAt(0) !== "/") return "";
    if (s.charAt(1) === "/") return "";
    if (/[\s"'<>]/.test(s)) return "";
    return s;
  }

  /** 数字夹取到 [lo,hi]:先 Number(),非有限数 → dflt(再不行 0)。 */
  function clampNum(v, lo, hi, dflt) {
    var n = Number(v);
    if (!isFinite(n)) n = Number(dflt);
    if (!isFinite(n)) n = 0;
    if (n < lo) n = lo;
    if (n > hi) n = hi;
    return n;
  }

  /** px 值串(最多两位小数,去掉浮点尾巴)。 */
  function pxStr(px) {
    var v = Math.round(num(px, 0) * 100) / 100;
    return v + "px";
  }

  /** fill 白名单:字符串走 safeColor;渐变对象走 gradient.stops → CSS linear-gradient。
   *  - angle:强制 Number() 后夹到 0~360,非有限数回 0(挡 "0;background:url(...)" 这类注入);
   *  - stop:颜色逐个过 safeColor,非法色直接丢该 stop;pos 夹到 0~1 后 ×100 转百分比;
   *  - 单 stop 不是合法渐变 → 退纯色;最终串再兜一次 CSS_BAD_RE(url( / javascript: / expression( / ;position)。
   *  返回 { css, isGradient }(不直接进 style,便于测试断言与上层决定是否落 style)。 */
  function safeFill(fill) {
    var out = { css: "", isGradient: false };
    if (typeof fill === "string") {
      out.css = safeColor(fill, "");
      return out;
    }
    if (!fill || typeof fill !== "object") return out;
    var g = fill.gradient;
    if (!g || typeof g !== "object") return out;
    var stops = Array.isArray(g.stops) ? g.stops : [];
    var parts = [];
    var colors = [];
    for (var i = 0; i < stops.length && parts.length < 16; i++) {
      var s = stops[i];
      if (!s || typeof s !== "object") continue;
      var c = safeColor(s.color, "");
      if (!c) continue; // 非法色 → 丢该 stop
      var pos = clampNum(s.pos, 0, 1, 0) * 100;
      pos = Math.round(pos * 100) / 100;
      colors.push(c);
      parts.push(c + " " + pos + "%");
    }
    if (!parts.length) return out;
    if (parts.length === 1) {
      out.css = colors[0]; // 单色退化(linear-gradient 至少两个位置才成立)
      return out;
    }
    var angle = clampNum(g.angle, 0, 360, 0);
    angle = Math.round(angle * 100) / 100;
    var css = "linear-gradient(" + angle + "deg, " + parts.join(", ") + ")";
    if (CSS_BAD_RE.test(css)) return out;
    out.css = css;
    out.isGradient = true;
    return out;
  }

  /** shadow → box-shadow 值(EMU 走 emuToPx);字段全缺 → 空串(不造默认阴影)。 */
  function shadowCss(shadow) {
    if (!shadow || typeof shadow !== "object") return "";
    var any = typeof shadow.color === "string";
    var keys = ["dxEmu", "dyEmu", "blurEmu"];
    for (var i = 0; i < keys.length; i++) {
      if (isFinite(Number(shadow[keys[i]]))) any = true;
    }
    if (!any) return "";
    var color = safeColor(shadow.color, "rgba(0,0,0,.28)");
    var dx = clampNum(emuToPx(shadow.dxEmu), -200, 200, 0);
    var dy = clampNum(emuToPx(shadow.dyEmu), -200, 200, 0);
    var blur = clampNum(emuToPx(shadow.blurEmu), 0, 200, 0);
    return pxStr(dx) + " " + pxStr(dy) + " " + pxStr(blur) + " " + color;
  }

  /** stroke.widthEmu → px,夹到 [0,20];缺失/非法 → 0。 */
  function strokeWidthPx(stroke) {
    if (!stroke || typeof stroke !== "object") return 0;
    var raw = Number(stroke.widthEmu);
    if (!isFinite(raw) || raw <= 0) return 0;
    return clampNum(emuToPx(raw), 0, MAX_STROKE_PX, 0);
  }

  /** stroke → border 值("2px solid #333");宽度为 0/缺失 → 空串(不造默认边框)。 */
  function strokeCss(stroke) {
    var w = strokeWidthPx(stroke);
    if (!(w > 0)) return "";
    return pxStr(w) + " solid " + safeColor(stroke && stroke.color, "#8a8f98");
  }

  /** 列宽 EMU 数组 → 百分比数组([1,1,2] → [25,25,50];全非法则等分)。 */
  function colWidthsToPercents(widths) {
    var list = Array.isArray(widths) ? widths : [];
    var n = list.length;
    if (!n) return [];
    var vals = [];
    var total = 0;
    for (var i = 0; i < n; i++) {
      var v = Number(list[i]);
      if (!isFinite(v) || v < 0) v = 0;
      vals.push(v);
      total += v;
    }
    var out = [];
    for (var j = 0; j < n; j++) {
      var p = total > 0 ? (vals[j] / total) * 100 : 100 / n;
      out.push(Math.round(p * 100) / 100);
    }
    return out;
  }

  /** 修订(run.revised)→ 样式声明;ins=下划线+绿,del=删除线+红+半透明(del 文本仍显示)。 */
  function revisedStyle(revised) {
    var k = typeof revised === "string" ? revised.trim().toLowerCase() : "";
    if (k === "ins") return { textDecoration: "underline", color: REV_INS, background: "rgba(26,127,55,.08)" };
    if (k === "del") return { textDecoration: "line-through", color: REV_DEL, opacity: "0.72" };
    return null;
  }

  /** 图表分类标签抽稀步长:≤8 全显示,超过按步长取。 */
  function catStep(count) {
    var n = num(count, 0);
    if (!(n > MAX_CATS)) return 1;
    var s = Math.ceil(n / MAX_CATS);
    return s > 0 ? s : 1;
  }

  function chartKindOf(chart) {
    var k = chart && typeof chart === "object" && typeof chart.kind === "string" ? chart.kind.trim().toLowerCase() : "";
    if (k === "line" || k === "pie" || k === "bar") return k;
    return "bar";
  }

  /** 图表节点数(有限 vals 个数,用于 >200 降级判定;饼图只算第一系列)。 */
  function chartNodeCount(chart) {
    if (!chart || typeof chart !== "object") return 0;
    var series = Array.isArray(chart.series) ? chart.series : [];
    var kind = chartKindOf(chart);
    var n = 0;
    for (var i = 0; i < series.length; i++) {
      var s = series[i] && typeof series[i] === "object" ? series[i] : {};
      var vals = Array.isArray(s.vals) ? s.vals : [];
      for (var j = 0; j < vals.length; j++) {
        if (isFinite(Number(vals[j])) && vals[j] !== null && vals[j] !== "") n++;
      }
      if (kind === "pie") return n; // 饼只取第一系列
    }
    return n;
  }

  /** 图表几何(纯函数,px 坐标,不碰 DOM):bar 柱形组 / line 折点与线段 / pie 扇区。
   *  空 series 或一个有限数都没有 → { empty: true }(由调用方画「(无数据)」)。
   *  vals 里的非有限数 → 该点跳过(hasVal:false,不画)。 */
  function chartGeom(chart, width, height) {
    var w = num(width, 0);
    var h = num(height, 0);
    var kind = chartKindOf(chart);
    if (!(w > 0) || !(h > 0) || !chart || typeof chart !== "object") {
      return { empty: true, kind: kind, w: w > 0 ? w : 0, h: h > 0 ? h : 0, series: [], bars: [], pie: [], labels: [] };
    }
    var seriesIn = Array.isArray(chart.series) ? chart.series : [];
    var catCount = 0;
    var maxV = 0;
    var minV = 0;
    var hasVal = false;
    var catTexts = [];
    var norm = [];
    for (var i = 0; i < seriesIn.length; i++) {
      var src = seriesIn[i] && typeof seriesIn[i] === "object" ? seriesIn[i] : {};
      var catsIn = Array.isArray(src.cats) ? src.cats : [];
      var valsIn = Array.isArray(src.vals) ? src.vals : [];
      var cats = [];
      var vals = [];
      for (var c = 0; c < Math.max(catsIn.length, valsIn.length); c++) {
        cats.push(catsIn[c] === null || catsIn[c] === undefined ? "" : String(catsIn[c]));
        var v = valsIn[c];
        var okv = v !== null && v !== undefined && v !== "" && isFinite(Number(v));
        vals.push(okv ? Number(v) : null);
        if (okv) {
          hasVal = true;
          if (Number(v) > maxV) maxV = Number(v);
          if (Number(v) < minV) minV = Number(v);
        }
      }
      if (cats.length > catCount) catCount = cats.length;
      for (var q = 0; q < cats.length; q++) {
        if (q >= catTexts.length) catTexts.push(cats[q]);
      }
      norm.push({ name: typeof src.name === "string" ? src.name : "", cats: cats, vals: vals });
      if (kind === "pie") break; // 饼只取第一系列
    }
    if (!hasVal || !catCount) {
      return { empty: true, kind: kind, w: w, h: h, series: [], bars: [], pie: [], labels: [] };
    }
    if (maxV === 0 && minV === 0) maxV = 1; // 全 0:给个量程,免得除 0

    var labelH = Math.min(18, Math.max(10, h * 0.1));
    var plot = { x: 8, y: 8, w: w - 16, h: h - 8 - labelH };
    if (!(plot.w > 1)) plot.w = 1;
    if (!(plot.h > 1)) plot.h = 1;
    var span = maxV - minV;
    if (!(span > 0)) span = 1;
    function yOf(v) {
      return plot.y + (plot.h * (maxV - v)) / span;
    }
    var zeroY = yOf(0);
    if (zeroY < plot.y) zeroY = plot.y;
    if (zeroY > plot.y + plot.h) zeroY = plot.y + plot.h;

    var step = catStep(catCount);
    var labels = [];
    for (var li = 0; li < catCount; li++) {
      labels.push({ index: li, text: li % step === 0 ? catTexts[li] || "" : "", show: li % step === 0 });
    }

    var seriesOut = [];
    var allBars = [];
    var pie = [];
    var groupW = plot.w / catCount;
    var si;
    if (kind === "bar") {
      var inner = groupW * 0.72;
      var barW = inner / Math.max(1, norm.length);
      for (si = 0; si < norm.length; si++) {
        var sb = norm[si];
        var bars = [];
        for (var bi = 0; bi < sb.vals.length; bi++) {
          var bv = sb.vals[bi];
          if (bv === null) continue; // 非有限数跳过该点
          var top = yOf(bv);
          var y0 = Math.min(top, zeroY);
          var bh = Math.abs(zeroY - top);
          var bar = {
            x: plot.x + bi * groupW + (groupW - inner) / 2 + si * barW,
            y: y0,
            w: barW,
            h: bh,
            value: bv,
            catIndex: bi,
            seriesIndex: si,
            color: PALETTE[si % PALETTE.length],
          };
          bars.push(bar);
          allBars.push(bar);
        }
        seriesOut.push({ name: sb.name, color: PALETTE[si % PALETTE.length], cats: sb.cats, vals: sb.vals, bars: bars, points: [] });
      }
    } else if (kind === "line") {
      for (si = 0; si < norm.length; si++) {
        var sl = norm[si];
        var pts = [];
        var segs = [];
        for (var pi = 0; pi < sl.vals.length; pi++) {
          var pv = sl.vals[pi];
          var px = plot.x + (catCount > 1 ? (plot.w * pi) / (catCount - 1) : plot.w / 2);
          if (pv === null) {
            pts.push({ x: px, y: 0, valid: false, value: null, catIndex: pi });
            continue;
          }
          pts.push({ x: px, y: yOf(pv), valid: true, value: pv, catIndex: pi });
        }
        for (var gi = 1; gi < pts.length; gi++) {
          var a = pts[gi - 1];
          var b = pts[gi];
          if (!a.valid || !b.valid) continue;
          var dx = b.x - a.x;
          var dy = b.y - a.y;
          segs.push({
            x1: a.x, y1: a.y, x2: b.x, y2: b.y,
            len: Math.sqrt(dx * dx + dy * dy),
            angle: (Math.atan2(dy, dx) * 180) / Math.PI,
          });
        }
        seriesOut.push({ name: sl.name, color: PALETTE[si % PALETTE.length], cats: sl.cats, vals: sl.vals, points: pts, segments: segs, bars: [] });
      }
    } else {
      // pie:第一系列,只取有限且 ≥0 的值
      var s0 = norm[0] || { name: "", cats: [], vals: [] };
      var total = 0;
      for (var ti = 0; ti < s0.vals.length; ti++) {
        var tv = s0.vals[ti];
        if (tv === null || tv < 0) continue;
        total += tv;
      }
      if (!(total > 0)) {
        return { empty: true, kind: kind, w: w, h: h, series: [], bars: [], pie: [], labels: labels };
      }
      var acc = 0;
      for (var pj = 0; pj < s0.vals.length; pj++) {
        var pvv = s0.vals[pj];
        if (pvv === null || pvv < 0) continue;
        var frac = pvv / total;
        pie.push({
          start: acc,
          end: acc + frac,
          frac: frac,
          value: pvv,
          label: s0.cats[pj] || "",
          color: PALETTE[pie.length % PALETTE.length],
        });
        acc += frac;
      }
      seriesOut.push({
        name: s0.name,
        color: PALETTE[0],
        cats: s0.cats,
        vals: s0.vals,
        points: [],
        bars: [],
        pie: pie,
      });
    }

    var legend = [];
    for (var g2 = 0; g2 < seriesOut.length; g2++) {
      legend.push({ name: seriesOut[g2].name || "系列" + (g2 + 1), color: seriesOut[g2].color });
    }
    return {
      empty: false,
      kind: kind,
      w: w,
      h: h,
      plot: plot,
      zeroY: zeroY,
      labelH: labelH,
      step: step,
      cats: catTexts,
      labels: labels,
      series: seriesOut,
      bars: allBars,
      pie: pie,
      legend: legend,
    };
  }

  var ALIGN = {
    l: "left", left: "left", start: "left",
    c: "center", center: "center", centre: "center",
    r: "right", right: "right", end: "right",
    justify: "justify", both: "justify",
  };
  function alignOf(v, dflt) {
    var k = typeof v === "string" ? v.trim().toLowerCase() : "";
    return ALIGN[k] || dflt || "left";
  }

  /** docx 段落 style → 标题级别(1..3);非标题返回 0。 */
  function headingLevel(style) {
    if (typeof style !== "string") return 0;
    var m = /^heading\s*([1-9])$/i.exec(style.trim());
    if (!m) return 0;
    var n = parseInt(m[1], 10);
    if (!isFinite(n) || n <= 0) return 0;
    return n > 3 ? 3 : n;
  }

  /** docx block → 渲染类别。 */
  function blockKind(block) {
    if (!block || typeof block !== "object") return "unsupported";
    var t = typeof block.type === "string" ? block.type.trim().toLowerCase() : "";
    if (t === "p" || t === "paragraph" || t === "heading") return "p";
    if (t === "table") return "table";
    return "unsupported";
  }

  /** pptx shape → 渲染类别(text/image/shape/table/chart;AST v2 起 table/chart 是真件,
   *  其余(组合/媒体/老 chart 占位)一律 unsupported)。 */
  function shapeKind(shape) {
    if (!shape || typeof shape !== "object") return "unsupported";
    var t = typeof shape.type === "string" ? shape.type.trim().toLowerCase() : "";
    if (t === "table" || t === "chart") return t;
    if (t === "text" || t === "image" || t === "shape") {
      // 放宽:type 仍是 "shape" 但带了 table/chart 载荷,按载荷分派(契约允许两者并存)
      if (t === "shape") {
        if (shape.table && typeof shape.table === "object") return "table";
        if (shape.chart && typeof shape.chart === "object") return "chart";
      }
      return t;
    }
    return "unsupported";
  }

  /** unsupportedKind → 占位框上的具体说明(给 title 用)。 */
  function unsupportedLabel(kind) {
    var k = typeof kind === "string" ? kind.trim().toLowerCase() : "";
    if (k === "chart") return "图表";
    if (k === "smartart") return "SmartArt";
    if (k === "media") return "嵌入媒体";
    if (k === "group") return "组合";
    return "其他";
  }

  /* ---------------- DOM 小工具 ---------------- */

  function hasDoc() {
    return typeof document !== "undefined" && document && typeof document.createElement === "function";
  }

  function sty(el, decls) {
    if (!el || !el.style || !decls) return el;
    for (var k in decls) {
      if (!Object.prototype.hasOwnProperty.call(decls, k)) continue;
      var v = decls[k];
      if (v === null || v === undefined) continue;
      try {
        el.style[k] = v;
      } catch (e) {
        /* 非法样式值静默丢弃,不影响其余渲染 */
      }
    }
    return el;
  }

  function mk(tag, cls, decls) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (decls) sty(el, decls);
    return el;
  }

  function txt(el, s) {
    el.textContent = s === null || s === undefined ? "" : String(s);
    return el;
  }

  function wipe(el) {
    if (!el) return el;
    try {
      while (el.firstChild) el.removeChild(el.firstChild);
    } catch (e) {
      /* 非标准宿主忽略 */
    }
    return el;
  }

  function safeAppend(host, el) {
    try {
      if (host && typeof host.appendChild === "function") host.appendChild(el);
      return true;
    } catch (e) {
      return false;
    }
  }

  var cleanups = typeof WeakMap === "function" ? new WeakMap() : null;

  function bindCleanup(host, fn) {
    if (!cleanups || !host || typeof host !== "object") return;
    try {
      cleanups.set(host, fn);
    } catch (e) {
      /* 宿主不可作为 WeakMap 键时忽略 */
    }
  }

  /* ---------------- 降级 ---------------- */

  /** 在 host 里写一行降级文案(不抛),并返回 {ok:false, reason}。 */
  function degrade(host, reason, message) {
    try {
      if (host && hasDoc() && typeof host.appendChild === "function") {
        wipe(host);
        var box = mk("div", "io-degrade", {
          padding: "18px 20px",
          margin: "12px",
          border: "1px dashed " + GRAY.line,
          borderRadius: "8px",
          background: GRAY.bg,
          color: GRAY.text,
          fontSize: "13px",
          lineHeight: "1.6",
          fontFamily: FONT,
        });
        txt(box, message || "文档无法渲染");
        safeAppend(host, box);
      }
    } catch (e) {
      /* 降级路径自身也不许抛 */
    }
    return { ok: false, reason: reason };
  }

  /* ---------------- DOCX ---------------- */

  function cellText(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "object") {
      if (v.text !== null && v.text !== undefined) return String(v.text);
      return "";
    }
    return String(v);
  }

  function applyRuns(el, runs, dfltPx, dfltColor) {
    var list = Array.isArray(runs) ? runs : [];
    for (var i = 0; i < list.length; i++) {
      var raw = list[i];
      var r = raw && typeof raw === "object" ? raw : { text: raw };
      var sp = mk("span", "io-run");
      txt(sp, r.text); // del 修订也照常落文本(不隐藏),靠样式区分
      if (r.bold) sp.style.fontWeight = "700";
      if (r.italic) sp.style.fontStyle = "italic";
      if (r.underline) sp.style.textDecoration = "underline";
      var pt = num(r.sizePt, 0);
      sp.style.fontSize = (pt > 0 ? pt : dfltPx) + "px";
      var c = safeColor(r.color, dfltColor);
      if (c) sp.style.color = c;
      // 修订:ins=下划线+绿;del=删除线+红+半透明(颜色走常量,不吃文档输入)
      var rv = revisedStyle(r.revised);
      if (rv) {
        sty(sp, rv);
        sp.setAttribute("data-io-revised", String(r.revised).trim().toLowerCase());
      }
      el.appendChild(sp);
    }
  }

  /** 段落批注:角标(💬+条数)+ title 放全部批注文本,点击展开/收起内联小列表。
   *  装饰节点一律 data-io-nonedit="1"(编辑态不可编、dirty 收集时排除,不污染原文比对)。 */
  function commentBadge(list) {
    var wrap = mk("span", "io-cmt", {
      display: "inline-block",
      marginLeft: "6px",
      verticalAlign: "super",
      userSelect: "none",
      cursor: "pointer",
      lineHeight: "1",
    });
    wrap.setAttribute("data-io-nonedit", "1");
    var texts = [];
    for (var i = 0; i < list.length; i++) {
      texts.push(list[i] === null || list[i] === undefined ? "" : String(list[i]));
    }
    var badge = mk("span", "io-cmt-badge", {
      display: "inline-block",
      padding: "1px 5px",
      borderRadius: "8px",
      background: "#fff4d6",
      color: "#8a6116",
      border: "1px solid #e6cf9a",
      fontSize: "11px",
      lineHeight: "15px",
      fontFamily: FONT,
    });
    txt(badge, COMMENT_ICON + (texts.length > 1 ? String(texts.length) : ""));
    badge.title = texts.join("\n");
    var box = mk("span", "io-cmt-list", { display: "none" });
    box.setAttribute("data-io-nonedit", "1");
    for (var j = 0; j < texts.length; j++) {
      var item = mk("div", "io-cmt-item", {
        display: "block",
        margin: "4px 0",
        padding: "3px 8px",
        borderLeft: "2px solid #e6cf9a",
        background: "#fffbe9",
        color: "#6b5322",
        fontSize: "12px",
        lineHeight: "1.5",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontFamily: FONT,
        textAlign: "left",
        fontWeight: "400",
      });
      txt(item, texts[j]);
      box.appendChild(item);
    }
    wrap.addEventListener("click", function (ev) {
      try {
        if (ev && ev.stopPropagation) ev.stopPropagation();
      } catch (e) {
        /* ignore */
      }
      box.style.display = box.style.display === "none" ? "block" : "none"; // 再点收起
    });
    wrap.appendChild(badge);
    wrap.appendChild(box);
    return wrap;
  }

  /** 段落块。idx=该块在 ast.blocks 里的下标(2026-10-29 文本回写:输出 data-io-edit 定位属性,
   *  面板进入编辑态时按它收集 dirty 段落的 textContent 组 edits[blockIndex])。 */
  function docxParagraph(block, idx) {
    var lvl = headingLevel(block.style);
    var fs = lvl ? HEADING_PX[lvl] : BODY_PX;
    var el = mk(lvl ? "h" + lvl : "div", "io-p" + (lvl ? " io-h io-h" + lvl : ""), {
      margin: lvl ? "20px 0 10px" : "0 0 10px",
      fontSize: fs + "px",
      lineHeight: lvl ? "1.35" : "1.7",
      fontWeight: lvl ? "700" : "400",
      textAlign: alignOf(block.align, "left"),
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
    });
    var listLevel = num(block.listLevel, -1);
    if (listLevel >= 0 && !lvl) {
      var depth = listLevel > 8 ? 8 : listLevel;
      el.style.paddingLeft = 18 * depth + "px";
      var bullet = mk("span", "io-bullet", { color: GRAY.text, marginRight: "6px", userSelect: "none" });
      bullet.setAttribute("data-io-nonedit", "1"); // 项目符号不是正文:编辑态不可编、收集 dirty 时排除
      txt(bullet, depth >= 1 ? "◦" : "•");
      el.appendChild(bullet);
    }
    var runs = Array.isArray(block.runs) ? block.runs : [];
    if (runs.length) applyRuns(el, runs, fs, INK);
    else txt(el, block.text);
    var comments = Array.isArray(block.comments) ? block.comments : [];
    if (comments.length) el.appendChild(commentBadge(comments)); // AST v2:段落批注角标
    if (typeof idx === "number" && idx >= 0) el.setAttribute("data-io-edit", "block:" + idx);
    return el;
  }

  function docxTable(block) {
    var tbl = mk("table", "io-table", {
      width: "100%",
      borderCollapse: "collapse",
      margin: "10px 0 14px",
      fontSize: "14px",
      lineHeight: "1.5",
    });
    var rows = Array.isArray(block.rows) ? block.rows : [];
    for (var i = 0; i < rows.length; i++) {
      var row = Array.isArray(rows[i]) ? rows[i] : [];
      var tr = mk("tr");
      for (var j = 0; j < row.length; j++) {
        var head = i === 0;
        var cell = mk(head ? "th" : "td", null, {
          border: "1px solid #d6d9de",
          padding: "6px 8px",
          textAlign: "left",
          verticalAlign: "top",
          background: head ? "#f4f5f7" : "transparent",
          fontWeight: head ? "700" : "400",
          wordBreak: "break-word",
        });
        txt(cell, cellText(row[j]));
        tr.appendChild(cell);
      }
      tbl.appendChild(tr);
    }
    return tbl;
  }

  function docxUnsupported(block) {
    var el = mk("div", "io-unsupported", {
      margin: "8px 0",
      padding: "6px 10px",
      background: GRAY.bg,
      border: "1px dashed " + GRAY.line,
      borderRadius: "6px",
      color: GRAY.text,
      fontSize: "13px",
    });
    txt(el, DOCX_SKIP_TEXT);
    if (block && block.unsupportedKind) el.title = String(block.unsupportedKind);
    return el;
  }

  /** AST v2 的页眉 / 页脚 / 脚注区块:复用块渲染,套灰色小字(空数组由调用方拦掉,这里只管画)。 */
  function docxAuxBlock(list, cls, label, extra) {
    var box = mk("div", cls, {
      margin: "0 0 16px",
      padding: "6px 10px",
      borderBottom: "1px solid #e3e5ea",
      background: "#fafbfc",
      borderRadius: "4px",
      color: GRAY.text,
      fontSize: "12px",
      lineHeight: "1.5",
      fontFamily: FONT,
    });
    if (extra) sty(box, extra);
    var head = mk("div", "io-aux-label", { fontSize: "11px", opacity: ".7", marginBottom: "2px", letterSpacing: ".05em" });
    txt(head, label);
    box.appendChild(head);
    for (var i = 0; i < list.length; i++) {
      var b = list[i] && typeof list[i] === "object" ? list[i] : {};
      var k = blockKind(b);
      var node;
      if (k === "table") node = docxTable(b);
      else if (k === "p") node = docxParagraph(b, -1);
      else node = docxUnsupported(b);
      sty(node, { fontSize: "12px", color: GRAY.text, margin: "0 0 4px", fontWeight: "400" });
      box.appendChild(node);
    }
    return box;
  }

  /** 页眉 / 页脚 / 脚注的空判定(try 里调用,数组非空才算有内容)。 */
  function auxList(v) {
    return Array.isArray(v) && v.length ? v : null;
  }

  function renderDocx(host, ast, opts) {
    var blocks = Array.isArray(ast.blocks) ? ast.blocks : [];
    var root = mk("div", "io-doc io-docx", {
      height: "100%",
      overflow: "auto",
      boxSizing: "border-box",
      padding: "20px",
      background: SHELL_BG,
      color: INK,
      fontFamily: FONT,
    });
    var page = mk("div", "io-page", {
      width: "100%",
      maxWidth: "820px",
      boxSizing: "border-box",
      margin: "0 auto",
      padding: "48px",
      background: "#fff",
      minHeight: "1123px",
      fontSize: BODY_PX + "px",
      lineHeight: "1.65",
      fontFamily: FONT,
      color: INK,
      boxShadow: "0 1px 3px rgba(0,0,0,.18), 0 12px 32px rgba(0,0,0,.08)",
    });
    var headers = auxList(ast.headers);
    var footers = auxList(ast.footers);
    var footnotes = auxList(ast.footnotes);
    if (headers) page.appendChild(docxAuxBlock(headers, "io-header", "页眉", null));
    if (!blocks.length) {
      var empty = mk("div", "io-empty", { color: GRAY.text, fontSize: "14px", textAlign: "center", padding: "40px 0" });
      txt(empty, EMPTY_TEXT);
      page.appendChild(empty);
    } else {
      for (var i = 0; i < blocks.length; i++) {
        var block = blocks[i] && typeof blocks[i] === "object" ? blocks[i] : {};
        var kind = blockKind(block);
        if (kind === "p") page.appendChild(docxParagraph(block, i));
        else if (kind === "table") page.appendChild(docxTable(block));
        else page.appendChild(docxUnsupported(block));
      }
    }
    if (footnotes) {
      page.appendChild(docxAuxBlock(footnotes, "io-footnotes", "脚注", { marginTop: "24px", borderBottom: "none", borderTop: "1px solid #e3e5ea", paddingTop: "10px" }));
    }
    if (footers) {
      page.appendChild(docxAuxBlock(footers, "io-footer", "页脚", { margin: "24px 0 0", borderBottom: "none", borderTop: "1px solid #e3e5ea" }));
    }
    root.appendChild(page);
    safeAppend(host, root);
    applyEdit(host); // 编辑态保持(2026-10-29 文本回写):重渲后按 host.dataset.ioEdit 重新挂 contenteditable

    // A4 比例:min-height 随页宽走(210:297),容器变化时重算。
    function fit() {
      try {
        var w = page.clientWidth || 0;
        if (w > 0) page.style.minHeight = Math.round(w * A4_RATIO) + "px";
      } catch (e) {
        /* 测量失败保持 CSS 兜底值 */
      }
    }
    fit();
    var ro = null;
    if (typeof ResizeObserver === "function") {
      try {
        ro = new ResizeObserver(fit);
        ro.observe(page);
      } catch (e) {
        ro = null;
      }
    }
    bindCleanup(host, function () {
      if (ro) {
        try {
          ro.disconnect();
        } catch (e) {
          /* ignore */
        }
      }
    });
    return { ok: true, kind: "docx", count: blocks.length };
  }

  /* ---------------- PPTX ---------------- */

  /** 文本框节点。slideNo/shapeIdx(2026-10-29 文本回写):输出 data-io-edit="slide:S:shape:I"
   *  定位属性(面板编辑态按它组 edits[slideIndex, shapeIndex];与 parseOffice 的 shapes 下标同源)。 */
  /** 形状填充:字符串/渐变都过 safeFill;dflt 只在 fill 无有效值时兜底。 */
  function applyFill(el, fill, dflt) {
    if (!el) return null;
    var f = safeFill(fill);
    var css = f.css || (typeof dflt === "string" ? dflt : "");
    if (css) el.style.background = css;
    if (f.isGradient) el.setAttribute("data-io-fill", "gradient"); // 便于浏览器侧核对渐变真的生效了
    return f;
  }

  /** 描边 / 阴影:字段缺失一律不动样式(不造默认边框、不造默认阴影)。 */
  function decorate(el, shape) {
    if (!el || !shape || typeof shape !== "object") return el;
    var sc = strokeCss(shape.stroke);
    if (sc) el.style.border = sc;
    var sh = shadowCss(shape.shadow);
    if (sh) el.style.boxShadow = sh;
    return el;
  }

  /** 居中占位小字(表格/图表/SmartArt 的数据缺失或过大降级都用它)。 */
  function noteBox(text, decls) {
    var el = mk("div", "io-note", {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      width: "100%",
      height: "100%",
      padding: "4px",
      boxSizing: "border-box",
      color: GRAY.text,
      fontSize: "12px",
      textAlign: "center",
      overflow: "hidden",
      fontFamily: FONT,
    });
    if (decls) sty(el, decls);
    txt(el, text);
    return el;
  }

  function textShape(shape, slideNo, shapeIdx) {
    var runs = Array.isArray(shape.runs) ? shape.runs : [];
    var first = runs.length && runs[0] && typeof runs[0] === "object" ? runs[0] : {};
    var pt = num(first.sizePt, 0);
    var el = mk("div", "io-text", {
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      display: "flex",
      flexDirection: "column",
      justifyContent: "center",
      textAlign: alignOf(shape.align, "left"),
      fontSize: (pt > 0 ? pt : 18) + "px",
      lineHeight: "1.3",
      color: safeColor(first.color, INK),
      overflow: "hidden",
    });
    if (runs.length) applyRuns(el, runs, pt > 0 ? pt : 18, INK);
    else txt(el, shape.text);
    applyFill(el, shape.fill, ""); // 文本形状也吃渐变/纯色底
    decorate(el, shape);
    if (typeof slideNo === "number" && slideNo > 0 && typeof shapeIdx === "number" && shapeIdx >= 0) {
      el.setAttribute("data-io-edit", "slide:" + slideNo + ":shape:" + shapeIdx);
    }
    return el;
  }

  function imageShape(shape) {
    var frame = mk("div", "io-image", { overflow: "hidden", border: "1px dashed rgba(120,128,140,.45)" });
    var src = safeSrc(shape.src);
    if (!src) {
      var miss = mk("div", "io-image-miss", {
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: GRAY.text,
        fontSize: "12px",
      });
      txt(miss, IMG_MISSING_TEXT);
      frame.appendChild(miss);
      return frame;
    }
    var img = mk("img", "io-img", { width: "100%", height: "100%", objectFit: "contain", display: "block" });
    img.setAttribute("src", src);
    img.setAttribute("alt", "");
    img.setAttribute("draggable", "false");
    img.style.border = "none";
    img.addEventListener("error", function () {
      // 加载失败:隐藏 img、留占位说明,不破版。
      try {
        img.style.visibility = "hidden";
        if (!frame.querySelector(".io-image-miss")) {
          var tip = mk("div", "io-image-miss", {
            position: "absolute",
            left: "0",
            top: "0",
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: GRAY.text,
            fontSize: "12px",
          });
          txt(tip, IMG_MISSING_TEXT);
          frame.appendChild(tip);
        }
      } catch (e) {
        /* ignore */
      }
    });
    frame.appendChild(img);
    return frame;
  }

  /** 形状(矩形等):background 必须走 safeFill —— 原来直接用 safeColor 会把渐变对象静默判成
   *  transparent(planner 标红的点),这里全量换掉。 */
  function plainShape(shape) {
    var el = mk("div", "io-shape", { overflow: "hidden" });
    var f = applyFill(el, shape.fill, "transparent");
    if (!f || !f.css) el.style.background = "transparent";
    decorate(el, shape);
    return el;
  }

  /** 表格形状:真 <table>,绝对定位在 shape 框内(由 shapeNode 的 absolute 定位负责),
   *  列宽按 colWidthsEmu 比例给 <colgroup>,首行浅底 + 全边框,单元格文本 textContent 自动换行。
   *  type 仍是 "shape" 时若带行数组(1.x 后端)也照样画。 */
  function tableShape(shape) {
    var spec = shape && typeof shape === "object" && shape.table && typeof shape.table === "object" ? shape.table : null;
    var rowsIn = spec && Array.isArray(spec.rows) ? spec.rows : null; // 严格按契约:表格数据只在 shape.table 里
    var wrap = mk("div", "io-table-wrap", {
      width: "100%",
      height: "100%",
      overflow: "hidden",
      boxSizing: "border-box",
      background: "#fff",
    });
    decorate(wrap, shape);
    if (!rowsIn || !rowsIn.length) {
      wrap.appendChild(noteBox(TABLE_EMPTY_TEXT));
      return wrap;
    }
    // 单元格计数超限 → 降级占位(防炸)
    var cells = 0;
    for (var ri = 0; ri < rowsIn.length; ri++) {
      if (Array.isArray(rowsIn[ri])) cells += rowsIn[ri].length;
      else if (rowsIn[ri] && typeof rowsIn[ri] === "object" && Array.isArray(rowsIn[ri].cells)) cells += rowsIn[ri].cells.length;
    }
    if (cells > MAX_NODES) {
      wrap.appendChild(noteBox("表格过大,已省略(" + cells + " 格)"));
      return wrap;
    }
    var tbl = mk("table", "io-table", {
      width: "100%",
      height: "100%",
      borderCollapse: "collapse",
      tableLayout: "fixed",
      fontSize: "12px",
      lineHeight: "1.35",
      color: INK,
      fontFamily: FONT,
      wordBreak: "break-word",
    });
    var widths = [];
    if (spec && Array.isArray(spec.colWidthsEmu)) widths = spec.colWidthsEmu.slice();
    else if (shape && Array.isArray(shape.colWidthsEmu)) widths = shape.colWidthsEmu.slice();
    if (widths.length) {
      var percents = colWidthsToPercents(widths);
      var cg = document.createElement("colgroup");
      for (var ci = 0; ci < percents.length; ci++) {
        var col = document.createElement("col");
        col.style.width = percents[ci] + "%";
        cg.appendChild(col);
      }
      tbl.appendChild(cg);
    }
    for (var r = 0; r < rowsIn.length; r++) {
      var row = rowsIn[r];
      var tr = mk("tr");
      var rowCells = [];
      if (Array.isArray(row)) {
        for (var z = 0; z < row.length; z++) rowCells.push(row[z] && typeof row[z] === "object" ? row[z] : { text: row[z] });
      } else if (row && typeof row === "object" && Array.isArray(row.cells)) {
        rowCells = row.cells;
      }
      var head = r === 0;
      for (var q = 0; q < rowCells.length; q++) {
        var cd = rowCells[q] && typeof rowCells[q] === "object" ? rowCells[q] : { text: rowCells[q] };
        var cell = mk(head ? "th" : "td", null, {
          border: "1px solid " + TABLE_LINE,
          padding: "2px 4px",
          textAlign: "left",
          verticalAlign: "top",
          background: head ? TABLE_HEAD_BG : "transparent",
          fontWeight: head ? "700" : "400",
          wordBreak: "break-word",
          overflowWrap: "anywhere",
          whiteSpace: "normal",
          boxSizing: "border-box",
        });
        txt(cell, cd.text);
        tr.appendChild(cell);
      }
      tbl.appendChild(tr);
    }
    wrap.appendChild(tbl);
    return wrap;
  }

  /** 饼图扇区 → CSS conic-gradient(颜色只取固定调色板,天然过黑名单;不用 SVG/canvas 免命名空间与释放)。 */
  function pieGradientCss(slices) {
    var list = Array.isArray(slices) ? slices : [];
    if (!list.length) return "transparent";
    var parts = [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s || typeof s !== "object") continue;
      var c = safeColor(s.color, PALETTE[i % PALETTE.length]);
      var from = Math.round(clampNum(s.start, 0, 1, 0) * 360 * 100) / 100;
      var to = Math.round(clampNum(s.end, 0, 1, 0) * 360 * 100) / 100;
      if (to <= from) continue;
      parts.push(c + " " + from + "deg " + to + "deg");
    }
    if (!parts.length) return "transparent";
    var css = "conic-gradient(" + parts.join(", ") + ")";
    return CSS_BAD_RE.test(css) ? "transparent" : css;
  }

  /** 图表形状:纯 DOM(百分比绝对定位),不用 canvas(无需释放)、不用 SVG(不引入外部命名空间)。
   *  bar/line/pie 三型;series 为空 / 全是非有限数 → 「(无数据)」不白屏;数据点 > 200 → 降级占位。
   *  几何先在 320×200 设计框里由 chartGeom 算好,再统一换算成百分比,随 shape 框一起缩放。 */
  function chartShape(shape) {
    // 严格按契约:图表数据只在 shape.chart 里(type:"chart" 也带 chart 载荷);缺载荷 → 「(无数据)」
    var chart = shape && typeof shape === "object" && shape.chart && typeof shape.chart === "object" ? shape.chart : null;
    var wrap = mk("div", "io-chart", {
      position: "relative",
      width: "100%",
      height: "100%",
      boxSizing: "border-box",
      overflow: "hidden",
      background: "#fff",
      fontFamily: FONT,
    });
    decorate(wrap, shape);
    var series = chart && Array.isArray(chart.series) ? chart.series : [];
    if (!series.length) {
      wrap.appendChild(noteBox(CHART_EMPTY_TEXT));
      return wrap;
    }
    if (chartNodeCount(chart) > MAX_NODES) {
      wrap.appendChild(noteBox("图表数据过多,已省略"));
      return wrap;
    }
    var W = 320;
    var H = 200;
    var geom = chartGeom(chart, W, H);
    if (geom.empty) {
      wrap.appendChild(noteBox(CHART_EMPTY_TEXT));
      return wrap;
    }
    var asPct = function (v, total) {
      var r = (num(v, 0) / total) * 100;
      if (!isFinite(r)) r = 0;
      return Math.round(r * 1000) / 1000 + "%";
    };
    var i;
    if (geom.kind === "pie") {
      var wheel = mk("div", "io-pie", {
        position: "absolute",
        left: "6%",
        top: "6%",
        width: "66%",
        height: "88%",
        borderRadius: "50%",
        border: "1px solid #e3e5ea",
        boxSizing: "border-box",
        background: pieGradientCss(geom.pie),
      });
      wrap.appendChild(wheel);
      var pieLegend = mk("div", "io-pie-legend", {
        position: "absolute",
        right: "2px",
        top: "4px",
        width: "26%",
        fontSize: "9px",
        lineHeight: "1.4",
        color: GRAY.text,
        overflow: "hidden",
      });
      for (i = 0; i < geom.pie.length; i++) {
        var slice = geom.pie[i];
        var li = mk("div", "io-pie-item", { display: "flex", alignItems: "center", gap: "3px", whiteSpace: "nowrap" });
        li.appendChild(mk("span", "io-pie-dot", { display: "inline-block", width: "6px", height: "6px", borderRadius: "2px", background: slice.color, flex: "0 0 auto" }));
        var lt = mk("span", null, { overflow: "hidden", textOverflow: "ellipsis" });
        txt(lt, (slice.label ? slice.label + " " : "") + Math.round(slice.frac * 100) + "%");
        li.appendChild(lt);
        pieLegend.appendChild(li);
      }
      wrap.appendChild(pieLegend);
    } else {
      wrap.appendChild(
        mk("div", "io-axis-y", {
          position: "absolute",
          left: asPct(geom.plot.x, W),
          top: asPct(geom.plot.y, H),
          width: "1px",
          height: asPct(geom.plot.h, H),
          background: "#c9ccd2",
        })
      );
      wrap.appendChild(
        mk("div", "io-axis-zero", {
          position: "absolute",
          left: asPct(geom.plot.x, W),
          top: asPct(geom.zeroY, H),
          width: asPct(geom.plot.w, W),
          height: "0",
          borderTop: "1px dashed #a9adb5",
        })
      );
      if (geom.kind === "bar") {
        for (i = 0; i < geom.bars.length; i++) {
          var b = geom.bars[i];
          var bar = mk("div", "io-chart-bar", {
            position: "absolute",
            left: asPct(b.x, W),
            top: asPct(b.y, H),
            width: asPct(b.w, W),
            height: asPct(b.h > 0.6 ? b.h : 0.6, H),
            background: b.color,
            minWidth: "1px",
          });
          bar.setAttribute("data-io-value", String(b.value));
          wrap.appendChild(bar);
        }
      } else {
        for (i = 0; i < geom.series.length; i++) {
          var s = geom.series[i];
          for (var g = 0; g < (s.segments || []).length; g++) {
            var sg = s.segments[g];
            // 线段:宽度按设计框宽换算的百分比 + 旋转(高宽比不同时略有拉伸,见报告「近似」一节)
            var seg = mk("div", "io-seg", {
              position: "absolute",
              left: asPct(sg.x1, W),
              top: asPct(sg.y1, H),
              width: asPct(sg.len, W),
              height: "1.5px",
              background: s.color,
              transformOrigin: "0 50%",
              transform: "rotate(" + Math.round(sg.angle * 100) / 100 + "deg)",
            });
            wrap.appendChild(seg);
          }
          for (var p = 0; p < (s.points || []).length; p++) {
            var pt = s.points[p];
            if (!pt || !pt.valid) continue; // 非有限数:该点跳过
            wrap.appendChild(
              mk("div", "io-dot", {
                position: "absolute",
                left: asPct(pt.x - 2, W),
                top: asPct(pt.y - 2, H),
                width: "4px",
                height: "4px",
                borderRadius: "50%",
                background: s.color,
              })
            );
          }
        }
      }
      // 分类标签(超 8 个按步长抽稀)
      for (i = 0; i < geom.labels.length; i++) {
        var lb = geom.labels[i];
        if (!lb.show) continue;
        var lx =
          geom.kind === "line" && geom.cats.length > 1
            ? geom.plot.x + (geom.plot.w * lb.index) / (geom.cats.length - 1)
            : geom.plot.x + (geom.plot.w * (lb.index + 0.5)) / Math.max(1, geom.cats.length);
        var label = mk("div", "io-cat", {
          position: "absolute",
          left: asPct(lx, W),
          bottom: "0",
          transform: "translateX(-50%)",
          fontSize: "8px",
          lineHeight: "1.2",
          color: GRAY.text,
          whiteSpace: "nowrap",
          fontFamily: FONT,
        });
        txt(label, lb.text);
        wrap.appendChild(label);
      }
    }
    if (geom.kind !== "pie" && geom.legend && geom.legend.length > 1) {
      var legend = mk("div", "io-chart-legend", {
        position: "absolute",
        right: "2px",
        top: "2px",
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: "1px",
        padding: "1px 3px",
        fontSize: "9px",
        lineHeight: "1.35",
        color: GRAY.text,
        background: "rgba(255,255,255,.82)",
        borderRadius: "3px",
      });
      for (i = 0; i < geom.legend.length; i++) {
        var item = mk("span", "io-legend-item", { display: "inline-flex", alignItems: "center", gap: "3px" });
        item.appendChild(mk("span", "io-legend-dot", { display: "inline-block", width: "7px", height: "7px", borderRadius: "2px", background: geom.legend[i].color }));
        var lname = mk("span", null);
        txt(lname, geom.legend[i].name);
        item.appendChild(lname);
        legend.appendChild(item);
      }
      wrap.appendChild(legend);
    }
    return wrap;
  }

  /** SmartArt(diagram.nodes,shape.type 仍是 "shape"):按 parentId 建层级,纵向盒子 + 缩进 + 连线。
   *  cycles(父指针成环)按「已访问就挂到根」处理,不乱序。 */
  function smartArtShape(shape) {
    var spec = shape && typeof shape === "object" && shape.diagram && typeof shape.diagram === "object" ? shape.diagram : null;
    var nodesIn = spec && Array.isArray(spec.nodes) ? spec.nodes : null;
    var wrap = mk("div", "io-smartart", {
      width: "100%",
      height: "100%",
      boxSizing: "border-box",
      overflow: "hidden",
      padding: "4px",
      background: "#fff",
      fontFamily: FONT,
    });
    decorate(wrap, shape);
    if (!nodesIn || !nodesIn.length) {
      wrap.appendChild(noteBox(SMARTART_EMPTY_TEXT));
      return wrap;
    }
    if (nodesIn.length > MAX_NODES) {
      wrap.appendChild(noteBox("SmartArt 节点过多,已省略(" + nodesIn.length + ")"));
      return wrap;
    }
    var byId = {};
    var order = [];
    for (var i = 0; i < nodesIn.length; i++) {
      var raw = nodesIn[i] && typeof nodesIn[i] === "object" ? nodesIn[i] : { text: nodesIn[i] };
      var id = raw.id === null || raw.id === undefined ? "n" + i : String(raw.id);
      if (Object.prototype.hasOwnProperty.call(byId, id)) continue;
      byId[id] = { id: id, text: raw.text === null || raw.text === undefined ? "" : String(raw.text), parentId: raw.parentId === null || raw.parentId === undefined ? "" : String(raw.parentId), depth: 0, kids: [] };
      order.push(byId[id]);
    }
    // 建树:父不存在/自环/成环 → 视为根
    var roots = [];
    for (var j = 0; j < order.length; j++) {
      var nd = order[j];
      var pid = nd.parentId;
      if (pid && pid !== nd.id && byId[pid] && !isAncestor(byId, pid, nd.id)) byId[pid].kids.push(nd);
      else roots.push(nd);
    }
    // 深度赋值(树的规模 ≤ 200,递归安全)
    var assign = function (n, d) {
      n.depth = d > 12 ? 12 : d;
      for (var k = 0; k < n.kids.length; k++) assign(n.kids[k], n.depth + 1);
    };
    for (var r2 = 0; r2 < roots.length; r2++) assign(roots[r2], 0);
    var list = mk("div", "io-sa-list", { display: "block", width: "100%" });
    for (var m = 0; m < order.length; m++) {
      var node = order[m];
      var row = mk("div", "io-sa-row", {
        display: "block",
        marginLeft: node.depth * 10 + "px",
        marginBottom: "3px",
        position: "relative",
      });
      if (node.depth > 0) {
        var link = mk("span", "io-sa-link", {
          display: "inline-block",
          width: "10px",
          borderTop: "1px solid " + GRAY.line,
          verticalAlign: "middle",
          marginRight: "2px",
        });
        link.setAttribute("data-io-nonedit", "1");
        row.appendChild(link);
      }
      var box = mk("span", "io-sa-node", {
        display: "inline-block",
        padding: "1px 6px",
        border: "1px solid #cfd4dc",
        borderRadius: "4px",
        background: node.depth === 0 ? "#eef2f8" : "#fafbfc",
        color: INK,
        fontSize: "11px",
        lineHeight: "1.5",
        maxWidth: "calc(100% - 16px)",
        wordBreak: "break-word",
        fontWeight: node.depth === 0 ? "700" : "400",
      });
      box.setAttribute("data-io-sa-depth", String(node.depth));
      txt(box, node.text);
      row.appendChild(box);
      list.appendChild(row);
    }
    wrap.appendChild(list);
    return wrap;
  }

  /** b 是否是 a 的祖先(防 parentId 成环)。 */
  function isAncestor(byId, a, b) {
    var cur = byId[a];
    var guard = 0;
    while (cur && cur.parentId && guard < 256) {
      if (cur.parentId === b) return true;
      cur = byId[cur.parentId];
      guard++;
    }
    return false;
  }

  /** 旧版(1.x)未拆分的 chart/smartart 占位仍走 unsupportedShape。 */
  function unsupportedShape(shape) {
    var el = mk("div", "io-unsupported", {
      background: GRAY.bg,
      border: "1px dashed " + GRAY.line,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      color: GRAY.text,
      fontSize: "13px",
      textAlign: "center",
      padding: "4px",
      boxSizing: "border-box",
      overflow: "hidden",
    });
    txt(el, UNSUPPORTED_TEXT);
    if (shape && shape.unsupportedKind) el.title = unsupportedLabel(shape.unsupportedKind) + "(" + String(shape.unsupportedKind) + ")";
    return el;
  }

  function shapeNode(shape, pageW, pageH, slideNo, shapeIdx) {
    var kind = shapeKind(shape);
    var el;
    if (kind === "text") el = textShape(shape, slideNo, shapeIdx);
    else if (kind === "image") el = imageShape(shape);
    else if (kind === "table") el = tableShape(shape);
    else if (kind === "chart") el = chartShape(shape);
    else if (kind === "shape") el = shape.diagram && typeof shape.diagram === "object" ? smartArtShape(shape) : plainShape(shape);
    else el = unsupportedShape(shape);
    el.classList.add("io-node");
    sty(el, {
      position: "absolute",
      left: pct(shape.x, pageW),
      top: pct(shape.y, pageH),
      width: pct(shape.cx, pageW),
      height: pct(shape.cy, pageH),
      boxSizing: "border-box",
    });
    return el;
  }

  function renderPptx(host, ast, opts) {
    var slides = Array.isArray(ast.slides) ? ast.slides : [];
    var root = mk("div", "io-doc io-pptx", {
      height: "100%",
      boxSizing: "border-box",
      display: "flex",
      flexDirection: "column",
      background: SHELL_BG,
      color: INK,
      fontFamily: FONT,
      outline: "none",
    });
    root.tabIndex = 0;

    /* 顶部工具条:‹ 1/3 › + 文件名 */
    var bar = mk("div", "io-bar", {
      flex: "0 0 auto",
      display: "flex",
      alignItems: "center",
      gap: "8px",
      padding: "6px 10px",
      background: "#262a33",
      color: "#e6e8ee",
      font: "12px/1.4 " + MONO,
      userSelect: "none",
    });
    function navBtn(label, aria) {
      var b = mk("button", "io-nav", {
        background: "transparent",
        color: "#e6e8ee",
        border: "1px solid rgba(255,255,255,.22)",
        borderRadius: "6px",
        padding: "1px 9px",
        font: "13px/1.5 " + MONO,
        cursor: "pointer",
      });
      b.type = "button";
      b.setAttribute("aria-label", aria);
      txt(b, label);
      return b;
    }
    var prevBtn = navBtn("‹", "上一页");
    var nextBtn = navBtn("›", "下一页");
    var label = mk("span", "io-pageno", { minWidth: "42px", textAlign: "center", fontVariantNumeric: "tabular-nums" });
    bar.appendChild(prevBtn);
    bar.appendChild(label);
    bar.appendChild(nextBtn);
    var docName = typeof opts.docPath === "string" && opts.docPath ? opts.docPath.split(/[\\/]/).pop() : "";
    if (docName) {
      var tag = mk("span", "io-docname", {
        marginLeft: "auto",
        opacity: ".62",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        maxWidth: "50%",
      });
      txt(tag, docName);
      bar.appendChild(tag);
    }
    root.appendChild(bar);

    var stage = mk("div", "io-stage", {
      flex: "1 1 auto",
      position: "relative",
      overflow: "hidden",
      padding: "12px",
      boxSizing: "border-box",
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "flex-start",
    });
    var holder = mk("div", "io-holder", { position: "relative", transformOrigin: "top left", flex: "0 0 auto" });
    var slideEl = mk("div", "io-slide", {
      position: "relative",
      width: "100%",
      height: "100%",
      background: "#fff",
      overflow: "hidden",
      boxShadow: "0 1px 3px rgba(0,0,0,.2), 0 10px 28px rgba(0,0,0,.1)",
    });
    holder.appendChild(slideEl);
    stage.appendChild(holder);
    root.appendChild(stage);

    if (!slides.length) {
      var empty = mk("div", "io-empty", {
        position: "absolute",
        left: "0",
        top: "0",
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: GRAY.text,
        fontSize: "14px",
      });
      txt(empty, EMPTY_TEXT);
      slideEl.appendChild(empty);
      holder.style.width = emuToPx(DEF_W_EMU) + "px";
      holder.style.height = emuToPx(DEF_H_EMU) + "px";
    }

    var cur = 0;
    var pageW = DEF_W_EMU;
    var pageH = DEF_H_EMU;
    var wpx = emuToPx(DEF_W_EMU);
    var hpx = emuToPx(DEF_H_EMU);

    function paint() {
      var slide = slides[cur] && typeof slides[cur] === "object" ? slides[cur] : {};
      pageW = num(slide.widthEmu, DEF_W_EMU);
      pageH = num(slide.heightEmu, DEF_H_EMU);
      if (!(pageW > 0)) pageW = DEF_W_EMU;
      if (!(pageH > 0)) pageH = DEF_H_EMU;
      wpx = emuToPx(pageW);
      hpx = emuToPx(pageH);
      holder.style.width = wpx + "px";
      holder.style.height = hpx + "px";
      snapshotEdits(host); // 翻页会 wipe 掉当前页 DOM:先把用户改动收进 store,画完 applyEdit 再回填
      wipe(slideEl);
      var shapes = Array.isArray(slide.shapes) ? slide.shapes : [];
      var slideNo = num(slide.index, cur + 1); // ast.slides[].index 即 1-based 页号(回写时当 slideIndex 用)
      for (var i = 0; i < shapes.length; i++) {
        var shape = shapes[i] && typeof shapes[i] === "object" ? shapes[i] : {};
        slideEl.appendChild(shapeNode(shape, pageW, pageH, slideNo, i));
      }
      if (label) txt(label, cur + 1 + "/" + slides.length);
      applyEdit(host); // 编辑态跨页保持(2026-10-29 文本回写):重画后重新挂 contenteditable
      fit();
    }

    // 整页按容器宽等比缩放(transform scale:文字矢量重采样,不糊)。
    function fit() {
      try {
        var avail = (stage.clientWidth || 0) - 24;
        if (avail <= 0 && host && typeof host.clientWidth === "number") avail = host.clientWidth - 24;
        if (avail <= 0) {
          holder.style.transform = "scale(1)";
          stage.style.height = hpx + 24 + "px";
          return;
        }
        var k = avail / wpx;
        holder.style.transform = "scale(" + k + ")";
        stage.style.height = Math.round(hpx * k) + 24 + "px";
      } catch (e) {
        /* 测量失败按原尺寸显示 */
      }
    }

    function go(delta) {
      if (!slides.length) return;
      var next = cur + delta;
      if (next < 0) next = 0;
      if (next > slides.length - 1) next = slides.length - 1;
      if (next === cur) return;
      cur = next;
      paint();
    }

    prevBtn.addEventListener("click", function () {
      go(-1);
    });
    nextBtn.addEventListener("click", function () {
      go(1);
    });
    var onKey = function (ev) {
      if (!ev) return;
      var k = ev.key;
      if (k === "ArrowLeft" || k === "ArrowUp" || k === "PageUp") {
        ev.preventDefault();
        go(-1);
      } else if (k === "ArrowRight" || k === "ArrowDown" || k === "PageDown") {
        ev.preventDefault();
        go(1);
      } else if (k === "Home") {
        ev.preventDefault();
        go(-slides.length);
      } else if (k === "End") {
        ev.preventDefault();
        go(slides.length);
      }
    };
    root.addEventListener("keydown", onKey);
    stage.addEventListener("click", function () {
      try {
        root.focus();
      } catch (e) {
        /* ignore */
      }
    });

    paint();
    safeAppend(host, root);
    try {
      root.focus();
    } catch (e) {
      /* 焦点失败不影响渲染 */
    }

    var ro = null;
    if (typeof ResizeObserver === "function") {
      try {
        ro = new ResizeObserver(fit);
        ro.observe(stage);
      } catch (e) {
        ro = null;
      }
    }

    bindCleanup(host, function () {
      try {
        root.removeEventListener("keydown", onKey);
      } catch (e) {
        /* ignore */
      }
      if (ro) {
        try {
          ro.disconnect();
        } catch (e) {
          /* ignore */
        }
      }
    });

    return { ok: true, kind: "pptx", count: slides.length, page: cur + 1 };
  }

  /* ---------------- 对外 API ---------------- */

  /** 渲染入口:同步返回 {ok, reason?};失败一律降级,不抛。 */
  function render(opts) {
    var o = opts && typeof opts === "object" ? opts : {};
    var host = o.host;
    var usable = host && (typeof host === "object" || typeof host === "function") && typeof host.appendChild === "function";
    if (!usable) return { ok: false, reason: "host-unusable" };
    if (!hasDoc()) return { ok: false, reason: "no-dom" };
    try {
      clear(host);
    } catch (e) {
      /* 复用同一 host 时先清场,失败继续 */
    }
    var ast = o.ast;
    if (!ast || typeof ast !== "object") return degrade(host, "ast-invalid", "文档内容无效,无法渲染");
    var kind = typeof ast.kind === "string" ? ast.kind.trim().toLowerCase() : "";
    try {
      if (kind === "pptx") return renderPptx(host, ast, o);
      if (kind === "docx") return renderDocx(host, ast, o);
      return degrade(host, "kind-unknown", "暂不支持该文档类型:" + (ast.kind === undefined ? "(空)" : String(ast.kind)).slice(0, 40));
    } catch (e) {
      try {
        clear(host);
      } catch (e2) {
        /* ignore */
      }
      var msg = e && e.message ? String(e.message) : "未知错误";
      return degrade(host, "render-failed", "渲染失败:" + msg.slice(0, 120));
    }
  }

  /** 编辑态节点文本(排除 data-io-nonedit 装饰,如列表项目符号;块级子节点(w:br 编辑后浏览器可能插
   *  的 <div>/<p>)按换行计)。面板收集 dirty 与 ide-office 记录 data-io-orig 都走这一个口径,
   *  否则「原文带符号、新文不带」会永远判脏。 */
  function editTextOf(el) {
    if (!el) return "";
    var s = "";
    var walk = function (n, depth) {
      if (depth > 32 || !n) return;
      var kids = n.childNodes || [];
      for (var i = 0; i < kids.length; i++) {
        var c = kids[i];
        if (!c) continue;
        if (c.nodeType === 3) {
          s += c.nodeValue === null || c.nodeValue === undefined ? "" : String(c.nodeValue);
        } else if (c.nodeType === 1) {
          if (c.getAttribute && c.getAttribute("data-io-nonedit") === "1") continue;
          var tag = c.tagName ? String(c.tagName).toUpperCase() : "";
          if (tag === "BR") {
            s += "\n";
            continue;
          }
          walk(c, depth + 1);
          if (tag === "DIV" || tag === "P" || tag === "LI") s += "\n";
        }
      }
    };
    walk(el, 0);
    return s.replace(/\n+$/, "");
  }

  /** 每 host 一份编辑存储 {key: {orig, text}}:**跨翻页/跨重画保命**——PPT 翻页会 wipe 重画 DOM,
   *  不存下来的话「第 1 页改完翻到第 2 页再翻回来」改动就没了。orig=进编辑态时的原文(判脏基准),
   *  text=用户当前文本(翻页后回填到新节点上)。 */
  function editStoreOf(host) {
    if (!host) return {};
    try {
      if (!host.__ioEdits || typeof host.__ioEdits !== "object") host.__ioEdits = {};
      return host.__ioEdits;
    } catch (e) {
      return {};
    }
  }
  /** 把当前 DOM 上所有可编辑节点的文本收进 store(重画/翻页**前**调用,防丢改动)。 */
  function snapshotEdits(host) {
    if (!host || typeof host.querySelectorAll !== "function") return;
    var on = false;
    try {
      on = !!(host.dataset && host.dataset.ioEdit === "1"); // 非编辑态不存(store 由 setEdit 清空,存了也只是噪声)
    } catch (e) {
      on = false;
    }
    if (!on) return;
    var store = editStoreOf(host);
    var list = [];
    try {
      list = host.querySelectorAll("[data-io-edit]");
    } catch (e) {
      return;
    }
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var key = el.getAttribute ? el.getAttribute("data-io-edit") : "";
      if (!key) continue;
      var cur = editTextOf(el);
      var rec = store[key];
      if (!rec) store[key] = { orig: cur, text: cur };
      else rec.text = cur;
    }
  }

  /** 编辑态开关(2026-10-29 文本回写 P2):给 host 打 dataset.ioEdit 标记,并给所有可编辑文本节点
   *  (带 data-io-edit 的 PPT 文本框 / Word 段落)加 contenteditable;进编辑态时把该节点的原始文本
   *  记进 store.orig(面板据此判断某段是否真的改过,只回传 dirty 段),并把 store.text 回填到
   *  新画出来的节点上(翻页回来/重渲后改动不丢)。
   *  PPT 翻页会 wipe 重画 —— paint() 每次画完都调 applyEdit(内部先 restore),所以编辑态跨页保持。
   *  返回被标记的节点数(0 = 该文档没有可编辑文本,面板据此提示而不进编辑态)。 */
  function applyEdit(host) {
    if (!host || !hasDoc() || typeof host.querySelectorAll !== "function") return 0;
    var on = false;
    try {
      on = !!(host.dataset && host.dataset.ioEdit === "1");
    } catch (e) {
      on = false;
    }
    var list = [];
    try {
      list = host.querySelectorAll("[data-io-edit]");
    } catch (e2) {
      return 0;
    }
    var store = editStoreOf(host);
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      try {
        var key = el.getAttribute ? el.getAttribute("data-io-edit") : "";
        if (on) {
          var rec = key ? store[key] : null;
          if (key && !rec) {
            rec = { orig: editTextOf(el), text: editTextOf(el) };
            store[key] = rec;
          }
          // 翻页/重画后把 store 里存的文本回填(只回填与当前不同的,避免无谓改 DOM)
          if (rec && typeof rec.text === "string" && editTextOf(el) !== rec.text) txt(el, rec.text);
          el.setAttribute("contenteditable", "true");
          el.setAttribute("spellcheck", "false");
          el.setAttribute("data-io-orig", rec ? rec.orig : editTextOf(el));
          el.style.outline = "1px dashed rgba(201,143,69,.8)";
          el.style.outlineOffset = "2px";
        } else {
          el.removeAttribute("contenteditable");
          el.removeAttribute("data-io-orig");
          el.style.outline = "";
          el.style.outlineOffset = "";
        }
      } catch (e3) {
        /* 单个节点失败不影响其余 */
      }
    }
    return list.length;
  }

  /** 对外:开/关编辑态(面板「编辑文本」/「取消编辑」调);返回可编辑节点数。
   *  关编辑态=丢弃改动(清空 store),与面板「取消编辑」语义一致。 */
  function setEdit(host, on) {
    if (!host) return 0;
    try {
      if (host.dataset) host.dataset.ioEdit = on ? "1" : "0";
      host.__ioEdits = {};
    } catch (e) {
      return 0;
    }
    return applyEdit(host);
  }

  /** 对外:收集 dirty 节点(与 orig 不同的) → [{key:"slide:S:shape:I"|"block:N", text}]。
   *  面板据此组 ide.office.edit 的 edits[](只有真改过的段落回传,未改的不动原文)。
   *  先刷一遍当前 DOM 进 store,再按 store 全量比对 —— 这样 PPT 翻过页的那些页面的改动也一并交出。 */
  function collectEdits(host) {
    var out = [];
    if (!host || typeof host.querySelectorAll !== "function") return out;
    snapshotEdits(host);
    var store = editStoreOf(host);
    for (var key in store) {
      if (!Object.prototype.hasOwnProperty.call(store, key)) continue;
      var rec = store[key];
      if (!rec) continue;
      if (typeof rec.text !== "string") continue;
      if (rec.text === rec.orig) continue; // 未改
      out.push({ key: String(key), text: rec.text });
    }
    return out;
  }

  /** 清空并释放(切标签/关标签);幂等,不抛。 */
  function clear(host) {
    try {
      if (!host || (typeof host !== "object" && typeof host !== "function")) return true;
      if (cleanups) {
        var fn = null;
        try {
          fn = cleanups.get(host);
        } catch (e) {
          fn = null;
        }
        if (typeof fn === "function") {
          try {
            fn();
          } catch (e) {
            /* 释放钩子失败不影响清空 */
          }
          try {
            cleanups.delete(host);
          } catch (e2) {
            /* ignore */
          }
        }
      }
      wipe(host);
      return true;
    } catch (e) {
      return false;
    }
  }

  var api = {
    version: "1",
    render: render,
    clear: clear,
    setEdit: setEdit,
    collectEdits: collectEdits,
    __test: {
      emuToPx: emuToPx,
      pct: pct,
      esc: esc,
      safeColor: safeColor,
      safeFill: safeFill,
      safeSrc: safeSrc,
      alignOf: alignOf,
      headingLevel: headingLevel,
      blockKind: blockKind,
      shapeKind: shapeKind,
      unsupportedLabel: unsupportedLabel,
      shadowCss: shadowCss,
      strokeCss: strokeCss,
      strokeWidthPx: strokeWidthPx,
      colWidthsToPercents: colWidthsToPercents,
      chartGeom: chartGeom,
      chartNodeCount: chartNodeCount,
      pieGradientCss: pieGradientCss,
      revisedStyle: revisedStyle,
      catStep: catStep,
      constants: {
        EMU_PER_PX: EMU_PER_PX,
        DEF_W_EMU: DEF_W_EMU,
        DEF_H_EMU: DEF_H_EMU,
        HEADING_PX: HEADING_PX,
        BODY_PX: BODY_PX,
        A4_RATIO: A4_RATIO,
        UNSUPPORTED_TEXT: UNSUPPORTED_TEXT,
        EMPTY_TEXT: EMPTY_TEXT,
        MAX_NODES: MAX_NODES,
        MAX_STROKE_PX: MAX_STROKE_PX,
        MAX_CATS: MAX_CATS,
        CHART_EMPTY_TEXT: CHART_EMPTY_TEXT,
        REV_INS: REV_INS,
        REV_DEL: REV_DEL,
        PALETTE: PALETTE,
      },
    },
  };

  if (typeof window !== "undefined" && window) {
    window.IdeOffice = api;
  } else if (typeof globalThis !== "undefined" && globalThis) {
    globalThis.IdeOffice = api; // node 端(测试/SSR)无 window 时退到 globalThis,便于 import
  }
  if (typeof module !== "undefined" && module && module.exports) {
    try {
      module.exports = api;
    } catch (e) {
      /* ESM 环境下无 module,忽略 */
    }
  }
})();
