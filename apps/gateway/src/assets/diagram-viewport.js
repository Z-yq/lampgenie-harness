/** 图(diagram/SVG)viewport 引擎——纯函数资产,浏览器与 vitest 双端可测。
 * 移植自 ZCode(packages/ui),上游源自 vercel/ai-elements(Apache-2.0)衍生实现:
 *   - packages/ui/src/lib/diagramViewport.ts(clamp/zoomAtPoint/pan/fit 四函数,语义 1:1)
 *   - packages/ui/src/components/ai-elements/diagram-preview-dialog.tsx
 *     (resolveSvgBounds 的 DOM 无关部分:排除规则/bbox 并集;applyPreviewSvgLayout 的
 *      坐标系对齐计算。React/浏览器副作用未搬。)
 * 移植日期:。原文件保留 Apache-2.0 许可,此处为衍生移植。
 * 双端约定与 board-flow-layout.js 同款:UMD 风格工厂——
 *   CommonJS(vitest 经 esbuild 转换)走 module.exports;浏览器 script 标签挂全局
 *   DiagramViewport;ESM named export 由文件尾部 export 语句提供(node "type":"module")。
 */
const DiagramViewport = (function () {
  "use strict";

  /** 缩放下限。对应原文件常量 MIN_DIAGRAM_SCALE(diagramViewport.ts)。 */
  var MIN_DIAGRAM_SCALE = 0.25;
  /** 缩放上限。对应原文件常量 MAX_DIAGRAM_SCALE(diagramViewport.ts)。 */
  var MAX_DIAGRAM_SCALE = 4;

  /** 对应原文件 clampDiagramScale(diagramViewport.ts):非有限值兜底 1,否则夹取 [0.25, 4]。 */
  function clampScale(scale) {
    if (!Number.isFinite(scale)) {
      return 1;
    }
    return Math.min(MAX_DIAGRAM_SCALE, Math.max(MIN_DIAGRAM_SCALE, scale));
  }

  /** 对应原文件 zoomDiagramAtPoint(diagramViewport.ts):
   * 先把光标点反解为图内容坐标((p - t)/s),再以 nextScale 重投影,
   * 保证光标下的内容点屏幕位移为 0(以光标为锚的缩放数学)。 */
  function zoomAtPoint(transform, viewportPoint, nextScale) {
    var safeCurrentScale = clampScale(transform.scale);
    var safeNextScale = clampScale(nextScale);
    var diagramX = (viewportPoint.x - transform.translateX) / safeCurrentScale;
    var diagramY = (viewportPoint.y - transform.translateY) / safeCurrentScale;
    return {
      scale: safeNextScale,
      translateX: viewportPoint.x - diagramX * safeNextScale,
      translateY: viewportPoint.y - diagramY * safeNextScale,
    };
  }

  /** 对应原文件 panDiagram(diagramViewport.ts):平移量直接叠加到 translate。 */
  function pan(transform, delta) {
    return {
      scale: transform.scale,
      translateX: transform.translateX + delta.x,
      translateY: transform.translateY + delta.y,
    };
  }

  /** 对应原文件 fitDiagramToViewport(diagramViewport.ts):
   * 可用区 = viewport 两侧各留 padding,scale 取宽高比小者并夹取;
   * translate 让图在 viewport 中居中(减去图自身原点偏移)。 */
  function fitToViewport(options) {
    var diagramX = options.diagramX || 0;
    var diagramY = options.diagramY || 0;
    var diagramHeight = options.diagramHeight;
    var diagramWidth = options.diagramWidth;
    var padding = options.padding === undefined ? 32 : options.padding;
    var viewportHeight = options.viewportHeight;
    var viewportWidth = options.viewportWidth;

    if (
      diagramWidth <= 0 ||
      diagramHeight <= 0 ||
      viewportWidth <= 0 ||
      viewportHeight <= 0
    ) {
      return { scale: 1, translateX: 0, translateY: 0 };
    }

    var availableWidth = Math.max(1, viewportWidth - padding * 2);
    var availableHeight = Math.max(1, viewportHeight - padding * 2);
    var scale = clampScale(
      Math.min(availableWidth / diagramWidth, availableHeight / diagramHeight),
    );

    return {
      scale: scale,
      translateX: (viewportWidth - diagramWidth * scale) / 2 - diagramX * scale,
      translateY: (viewportHeight - diagramHeight * scale) / 2 - diagramY * scale,
    };
  }

  /* ── SVG bounds 求解(resolveSvgBounds 的 DOM 无关部分)──────────────────
   * 对应 diagram-preview-dialog.tsx 的常量 svgGraphicSelector / nonVisibleSvgAncestorSelector
   * / isTransparentPaint / mergeBounds / isCanvasBackgroundElement / resolveSvgBounds。
   * DOM 遍历(getComputedStyle/getBBox/closest)全部通过 getBBox/elementView 注入,
   * 浏览器端传真实实现,vitest 端传 stub——纯逻辑(排除规则/并集/回退链)在本文件。 */

  var SVG_GRAPHIC_TAG_NAMES = [
    "circle",
    "ellipse",
    "foreignobject",
    "g",
    "image",
    "line",
    "path",
    "polygon",
    "polyline",
    "rect",
    "text",
    "use",
  ];
  var NON_VISIBLE_ANCESTOR_TAG_NAMES = [
    "clippath",
    "defs",
    "lineargradient",
    "marker",
    "mask",
    "metadata",
    "pattern",
    "radialgradient",
    "script",
    "style",
    "symbol",
    "title",
  ];

  function makeTagSet(names) {
    var set = {};
    for (var i = 0; i < names.length; i += 1) set[names[i]] = true;
    return set;
  }

  var GRAPHIC_TAGS = makeTagSet(SVG_GRAPHIC_TAG_NAMES);
  var NON_VISIBLE_TAGS = makeTagSet(NON_VISIBLE_ANCESTOR_TAG_NAMES);

  /** 对应 isTransparentPaint(diagram-preview-dialog.tsx):空/none/transparent/全透明 rgba。 */
  function isTransparentPaint(value) {
    var normalized = String(value).trim().toLowerCase();
    return (
      normalized.length === 0 ||
      normalized === "none" ||
      normalized === "transparent" ||
      normalized === "rgba(0, 0, 0, 0)"
    );
  }

  /** 对应 mergeBounds(diagram-preview-dialog.tsx):两个 bbox 求并集矩形。 */
  function mergeBounds(current, box) {
    if (!current) {
      return { height: box.height, width: box.width, x: box.x, y: box.y };
    }
    var currentX = current.x || 0;
    var currentY = current.y || 0;
    var minX = Math.min(currentX, box.x);
    var minY = Math.min(currentY, box.y);
    var maxX = Math.max(currentX + current.width, box.x + box.width);
    var maxY = Math.max(currentY + current.height, box.y + box.height);
    return { height: maxY - minY, width: maxX - minX, x: minX, y: minY };
  }

  /** 对应 isCanvasBackgroundElement(diagram-preview-dialog.tsx)的判定核:
   * rect 且几乎覆盖根画布(位置差 ≤1、宽高 ≥95%),且描边透明或 class 含 "background"
   * → 视为画布背景板,不计入内容并集。style/className 从 elementView 读取。 */
  function isCanvasBackgroundRect(view, box, rootBounds) {
    if (view.tagName !== "rect" || rootBounds.width <= 0 || rootBounds.height <= 0) {
      return false;
    }
    var rootX = rootBounds.x || 0;
    var rootY = rootBounds.y || 0;
    var coversRoot =
      Math.abs(box.x - rootX) <= 1 &&
      Math.abs(box.y - rootY) <= 1 &&
      box.width >= rootBounds.width * 0.95 &&
      box.height >= rootBounds.height * 0.95;
    return (
      coversRoot &&
      (isTransparentPaint(view.stroke) || String(view.className).includes("background"))
    );
  }

  /** 对应 resolveSvgBounds(diagram-preview-dialog.tsx)核心语义(可注入版):
   * rootBounds:readRootSvgBounds 的产物(viewBox 优先,退声明尺寸/客户端尺寸——
   *   该读取本身是 DOM 副作用,由调用方完成,此处只消费);
   * elements:候选图形元素列表(调用方已按 svgGraphicSelector 选取);
   * elementView(el) → { tagName, className, stroke, display, visibility, opacity,
   *   ancestorTagNames, box }:每个元素的可注入视图;
   * getBBox(el) → { x, y, width, height } | null:元素 bbox,不可用返回 null。
   * 排除规则:不可见祖先(defs/mask/clipPath 等)、display:none/visibility:hidden/
   * opacity:0、退化 bbox、画布背景 rect;其余求并集。全空回退 rootBounds。 */
  function resolveSvgBounds(rootBounds, elements, elementView, getBBox) {
    var visibleBounds = null;
    for (var i = 0; i < elements.length; i += 1) {
      var el = elements[i];
      var view = elementView(el);
      if (!view || !view.tagName) continue;
      var tag = String(view.tagName).toLowerCase();
      if (!GRAPHIC_TAGS[tag]) continue;
      var ancestors = view.ancestorTagNames || view.ancestors || [];
      var hiddenAncestor = false;
      for (var a = 0; a < ancestors.length; a += 1) {
        if (NON_VISIBLE_TAGS[String(ancestors[a]).toLowerCase()]) {
          hiddenAncestor = true;
          break;
        }
      }
      if (hiddenAncestor) continue;

      var display = String(view.display || "").toLowerCase();
      var visibility = String(view.visibility || "").toLowerCase();
      var opacity = Number(view.opacity);
      if (display === "none" || visibility === "hidden" || opacity === 0) continue;

      var box;
      try {
        box = getBBox(el);
      } catch (error) {
        continue; // 原文件:bbox 读取失败时跳过,用其余可见图形求并集。
      }
      if (!box || box.width <= 0 || box.height <= 0) continue;
      if (isCanvasBackgroundRect(view, box, rootBounds)) continue;
      visibleBounds = mergeBounds(visibleBounds, box);
    }

    if (visibleBounds && visibleBounds.width > 0 && visibleBounds.height > 0) {
      return visibleBounds;
    }
    // 原文件回退链:可见并集为空 → 根元素 bbox(由调用方作为 rootBounds 传入)→ viewBox。
    return {
      height: rootBounds.height,
      width: rootBounds.width,
      x: rootBounds.x,
      y: rootBounds.y,
    };
  }

  /** 对应 applyPreviewSvgLayout(diagram-preview-dialog.tsx)的坐标计算部分:
   * 给定根 bounds,产出父容器与 SVG 应对齐到的 CSS 尺寸(同一坐标系,fit 计算与
   * transform 才一致;Mermaid 常见 width:100%+max-width 会让父容器塌成 300px)。
   * style 写入(DOM 副作用)不搬,由调用方执行。 */
  function computePreviewSvgLayout(rootBounds) {
    if (rootBounds.width > 0 && rootBounds.height > 0) {
      return {
        applicable: true,
        contentWidth: rootBounds.width,
        contentHeight: rootBounds.height,
        svgWidth: "100%",
        svgHeight: "100%",
        svgMaxWidth: "none",
      };
    }
    return { applicable: false, contentWidth: 0, contentHeight: 0 };
  }

  /* ── 矩阵工具:把元素 bbox 从自身 user space 映射到 root svg 的 user space ────────
   * SVGGraphicsElement.getBBox() 返回的框**不含自身与祖先的 transform**(纯局部坐标)。
   * 板图/mermaid 都是「每个节点一个 <g transform="translate(x,y)">」的布局,
 * 直接对一堆局部框求并集 = 把不同坐标系混在一起(经验证 minX 被拉到 -429.79、
   * 并集宽 7642 > viewBox 宽 7261,紧凑 fit 反而比 viewBox 更大)。
   * 修法:先 m = inverse(rootCTM) × elementCTM 把框映射到 root user space 再并集。
   * 三个函数纯数学、无 DOM 依赖,便于单测。 */

  /** 仿射矩阵 {a,b,c,d,e,f} 求逆;退化(det=0)返回 null。 */
  function invertMatrix(m) {
    if (!m) return null;
    var det = m.a * m.d - m.b * m.c;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
    return {
      a: m.d / det,
      b: -m.b / det,
      c: -m.c / det,
      d: m.a / det,
      e: (m.c * m.f - m.d * m.e) / det,
      f: (m.b * m.e - m.a * m.f) / det,
    };
  }

  /** 矩阵复合 m1 × m2(先应用 m2,再应用 m1)。 */
  function multiplyMatrix(m1, m2) {
    if (!m1 || !m2) return null;
    return {
      a: m1.a * m2.a + m1.c * m2.b,
      b: m1.b * m2.a + m1.d * m2.b,
      c: m1.a * m2.c + m1.c * m2.d,
      d: m1.b * m2.c + m1.d * m2.d,
      e: m1.a * m2.e + m1.c * m2.f + m1.e,
      f: m1.b * m2.e + m1.d * m2.f + m1.f,
    };
  }

  /** bbox 经仿射矩阵映射:四角变换后取轴对齐外接矩形(保持 AABB 语义)。 */
  function mapBoxByMatrix(box, m) {
    if (!box || !m) return box;
    var x0 = box.x;
    var y0 = box.y;
    var x1 = box.x + box.width;
    var y1 = box.y + box.height;
    var corners = [
      [x0, y0],
      [x1, y0],
      [x0, y1],
      [x1, y1],
    ];
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    for (var i = 0; i < corners.length; i += 1) {
      var px = corners[i][0];
      var py = corners[i][1];
      var tx = m.a * px + m.c * py + m.e;
      var ty = m.b * px + m.d * py + m.f;
      if (tx < minX) minX = tx;
      if (tx > maxX) maxX = tx;
      if (ty < minY) minY = ty;
      if (ty > maxY) maxY = ty;
    }
    return { height: maxY - minY, width: maxX - minX, x: minX, y: minY };
  }

  /** 浏览器端便捷适配器:把真实 DOM SVGSVGElement 适配到 resolveSvgBounds 的注入面。
   * 仅在 DOM 存在时可用(vitest 端不需要它)。对应 resolveSvgBounds 原始实现。
   * env(可选,仅供单测注入):{ getComputedStyle(el), getCTM(el) }——缺省走 window/element。 */
  function resolveSvgBoundsFromDom(svgElement, env) {
    if (!svgElement) return { height: 0, width: 0 };
    var readStyle =
      env && typeof env.getComputedStyle === "function"
        ? env.getComputedStyle
        : function (el) {
            return window.getComputedStyle(el);
          };
    var readCtm =
      env && typeof env.getCTM === "function"
        ? env.getCTM
        : function (el) {
            return el && typeof el.getCTM === "function" ? el.getCTM() : null;
          };
    var viewBox = svgElement.viewBox && svgElement.viewBox.baseVal;
    var rootBounds;
    if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
      rootBounds = { height: viewBox.height, width: viewBox.width, x: viewBox.x, y: viewBox.y };
    } else {
      rootBounds = {
        height: svgElement.clientHeight,
        width: svgElement.clientWidth,
        x: 0,
        y: 0,
      };
    }
    var candidates = Array.prototype.slice.call(
      svgElement.querySelectorAll(SVG_GRAPHIC_TAG_NAMES.join(",")),
    );
    // root user space 反矩阵:逆 rootCTM × elCTM 才是「该元素的框在 root 坐标系的位置」。
    var rootInverse = null;
    try {
      rootInverse = invertMatrix(readCtm(svgElement));
    } catch (error) {
      rootInverse = null; // 根 ctm 读不到(未布局/非渲染):退回旧的局部框口径,不劣化
    }
    return resolveSvgBounds(
      rootBounds,
      candidates,
      function (el) {
        var style = readStyle(el);
        var className =
          el.className && typeof el.className === "object" && "baseVal" in el.className
            ? el.className.baseVal
            : String(el.className || "");
        var ancestorTags = [];
        for (var node = el.parentElement; node && node !== svgElement; node = node.parentElement) {
          ancestorTags.push(node.tagName.toLowerCase());
        }
        return {
          tagName: String(el.tagName).toLowerCase(),
          className: className,
          stroke: style.stroke,
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          ancestorTagNames: ancestorTags,
        };
      },
      function (el) {
 // 任务B 修复:局部 getBBox → 映射到 root user space 后再并集。
        var box = el.getBBox();
        var local = { x: box.x, y: box.y, width: box.width, height: box.height };
        if (!rootInverse) return local;
        var elementMatrix = null;
        try {
          elementMatrix = readCtm(el);
        } catch (error) {
          elementMatrix = null; // 元素无 ctm(未渲染等):保留局部框,行为同修复前
        }
        var relative = elementMatrix ? multiplyMatrix(rootInverse, elementMatrix) : null;
        return relative ? mapBoxByMatrix(local, relative) : local;
      },
    );
  }

  return {
    MIN_DIAGRAM_SCALE: MIN_DIAGRAM_SCALE,
    MAX_DIAGRAM_SCALE: MAX_DIAGRAM_SCALE,
    clampScale: clampScale,
    zoomAtPoint: zoomAtPoint,
    pan: pan,
    fitToViewport: fitToViewport,
    isTransparentPaint: isTransparentPaint,
    mergeBounds: mergeBounds,
    isCanvasBackgroundRect: isCanvasBackgroundRect,
    resolveSvgBounds: resolveSvgBounds,
    computePreviewSvgLayout: computePreviewSvgLayout,
    resolveSvgBoundsFromDom: resolveSvgBoundsFromDom,
    invertMatrix: invertMatrix,
    multiplyMatrix: multiplyMatrix,
    mapBoxByMatrix: mapBoxByMatrix,
    SVG_GRAPHIC_TAG_NAMES: SVG_GRAPHIC_TAG_NAMES,
    NON_VISIBLE_ANCESTOR_TAG_NAMES: NON_VISIBLE_ANCESTOR_TAG_NAMES,
  };
})();

// ESM named exports(浏览器 <script type=module> / vitest 直接 import 均走这里)。
export const MIN_DIAGRAM_SCALE = DiagramViewport.MIN_DIAGRAM_SCALE;
export const MAX_DIAGRAM_SCALE = DiagramViewport.MAX_DIAGRAM_SCALE;
export const clampScale = DiagramViewport.clampScale;
export const zoomAtPoint = DiagramViewport.zoomAtPoint;
export const pan = DiagramViewport.pan;
export const fitToViewport = DiagramViewport.fitToViewport;
export const isTransparentPaint = DiagramViewport.isTransparentPaint;
export const mergeBounds = DiagramViewport.mergeBounds;
export const isCanvasBackgroundRect = DiagramViewport.isCanvasBackgroundRect;
export const resolveSvgBounds = DiagramViewport.resolveSvgBounds;
export const computePreviewSvgLayout = DiagramViewport.computePreviewSvgLayout;
export const resolveSvgBoundsFromDom = DiagramViewport.resolveSvgBoundsFromDom;
export const invertMatrix = DiagramViewport.invertMatrix;
export const multiplyMatrix = DiagramViewport.multiplyMatrix;
export const mapBoxByMatrix = DiagramViewport.mapBoxByMatrix;
export const SVG_GRAPHIC_TAG_NAMES = DiagramViewport.SVG_GRAPHIC_TAG_NAMES;
export const NON_VISIBLE_ANCESTOR_TAG_NAMES = DiagramViewport.NON_VISIBLE_ANCESTOR_TAG_NAMES;
export default DiagramViewport;
