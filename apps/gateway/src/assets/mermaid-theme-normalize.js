/** mermaid 主题色归一化——canvas 采样可注入的类纯函数资产(浏览器与 vitest 双端可测)。
 * 移植自 ZCode packages/ui/src/components/ai-elements/mermaid-block.tsx 的
 * normalizeCssColorForMermaid / resolveCssColor / createMermaidConfig 色彩链;
 * 上游源自 vercel/ai-elements(Apache-2.0)衍生实现,原文件许可 Apache-2.0,
 * 移植日期,此处为衍生移植。
 * 动机(原文件注释):Mermaid 底层 khroma 解析器不支持 Tailwind v4 常见的
 * oklab()/color-mix() 结果;先让浏览器解析主题 token,再经 canvas 采样成传统
 * rgb()/rgba(),避免把现代 CSS 颜色直接传给 Mermaid——深浅主题切换图不褪色的关键。
 * DOM 副作用(document/getComputedStyle/canvas)全部抽为可注入采样器:
 *   - 浏览器端 createCanvasColorSampler() 产出 {resolve, sample};
 *   - 也可注入单函数 sampler(color) → {r,g,b,a}|null | [r,g,b,a]|null(a 取 0..1,
 *     兼容 canvas 的 0..255,vitest 端传 stub 最省事);
 *   - 缺省/返回 null 时原样透传(或用显式 fallback),SSR 与最小 DOM mock 不崩。
 * 核心纯逻辑(传统色短路/alpha 归一/rgb 输出格式/themeVars 表遍历)在本文件。
 */

/** 对应原文件常量 MERMAID_COLOR_CANVAS_SENTINEL:canvas 哨兵色,
 * fillStyle 赋值后仍等于哨兵即代表浏览器不接受该颜色格式。 */
const CANVAS_SENTINEL_COLOR = "#010203";

/** 传统 rgb()/rgba()/hex 形式:khroma 本就支持,原样透传、不经过采样器。 */
function isLegacyRgbColor(raw) {
  return /^\s*(#[0-9a-f]{3,8}\b|rgba?\()/i.test(String(raw));
}

/** 把采样结果({r,g,b,a} 或 [r,g,b,a])归一为 rgb()/rgba() 串。
 * 对应原文件 normalizeCssColorForMermaid 的输出格式:alpha 保留 3 位小数,
 * 不透明时输出紧凑 rgb(...)。a 兼容 0..1(CSS 口径)与 0..255(canvas 口径)。 */
function toRgbString(sampled) {
  var r;
  var g;
  var b;
  var a;
  if (Array.isArray(sampled)) {
    r = sampled[0];
    g = sampled[1];
    b = sampled[2];
    a = sampled[3];
  } else if (sampled && typeof sampled === "object") {
    r = sampled.r;
    g = sampled.g;
    b = sampled.b;
    a = sampled.a;
  }
  r = r === undefined ? 0 : r;
  g = g === undefined ? 0 : g;
  b = b === undefined ? 0 : b;
  if (a === undefined || a === null) {
    a = 1;
  } else if (a > 1) {
    a = a / 255; // canvas getImageData 的 alpha 是 0..255
  }
  var roundedAlpha = Number(a.toFixed(3));
  return roundedAlpha >= 1
    ? "rgb(" + r + ", " + g + ", " + b + ")"
    : "rgba(" + r + ", " + g + ", " + b + ", " + roundedAlpha + ")";
}

/** 归一化单个颜色串(核心,对应原文件 normalizeCssColorForMermaid):
 * normalizeCssColor(raw, fallback, sampler) 或 normalizeCssColor(raw, { sampler, fallback })。
 * - rgb()/rgba()/hex:原样透传(不调采样器);
 * - 无采样器:原样透传(测试/SSR 环境不崩,原文件语义);
 * - 采样器返回 null/抛错:fallback(缺省回退为 raw 本身);
 * - 其余:输出 rgb()/rgba() 串。
 * sampler 可为单函数(color → {r,g,b,a}|[r,g,b,a]|null)或
 * { resolve(color)->cssColor|null, sample(cssColor)->像素|null } 对象
 * (浏览器端见 createCanvasColorSampler)。 */
function normalizeCssColor(raw, fallbackOrOptions, maybeSampler) {
  var fallback;
  var sampler = maybeSampler;
  if (fallbackOrOptions && typeof fallbackOrOptions === "object") {
    if (!sampler) sampler = fallbackOrOptions.sampler;
    if (fallback === undefined && typeof fallbackOrOptions.fallback === "string") {
      fallback = fallbackOrOptions.fallback;
    }
  } else if (typeof fallbackOrOptions === "string") {
    fallback = fallbackOrOptions;
  }
  if (!raw) {
    return raw || fallback || "";
  }
  if (isLegacyRgbColor(raw)) {
    return raw;
  }
  if (!sampler) {
    return raw;
  }
  try {
    var sampled;
    if (typeof sampler === "function") {
      sampled = sampler(raw);
    } else {
      var resolved = typeof sampler.resolve === "function" ? sampler.resolve(raw) : raw;
      if (!resolved) {
        return fallback || raw;
      }
      sampled = sampler.sample(resolved);
    }
    if (!sampled) {
      return fallback || raw;
    }
    return toRgbString(sampled);
  } catch (error) {
    return fallback || raw;
  }
}

/** 对应原文件 createMermaidConfig(mermaid-block.tsx)的 themeVariables 变量表:
 * Mermaid 变量全集与深浅主题回退色(语义 1:1,键序一致),供接线方取默认值。 */
const MERMAID_THEME_VARS_LIGHT = {
  actorBkg: "#ffffff",
  actorBorder: "#d4d4d8",
  actorTextColor: "#27272a",
  background: "#ffffff",
  lineColor: "#52525b",
  mainBkg: "#ffffff",
  nodeBorder: "#d4d4d8",
  noteBkgColor: "#f0f9ff",
  noteTextColor: "#27272a",
  primaryBorderColor: "#d4d4d8",
  primaryColor: "#f4f4f5",
  primaryTextColor: "#27272a",
  secondaryBorderColor: "#d4d4d8",
  secondaryColor: "#f0f9ff",
  secondaryTextColor: "#27272a",
  signalColor: "#52525b",
  signalTextColor: "#27272a",
  tertiaryBorderColor: "#d4d4d8",
  tertiaryColor: "#ffffff",
  tertiaryTextColor: "#27272a",
  textColor: "#27272a",
};

const MERMAID_THEME_VARS_DARK = {
  actorBkg: "#18181b",
  actorBorder: "#3f3f46",
  actorTextColor: "#f4f4f5",
  background: "#18181b",
  lineColor: "#a1a1aa",
  mainBkg: "#18181b",
  nodeBorder: "#3f3f46",
  noteBkgColor: "#1f2937",
  noteTextColor: "#f4f4f5",
  primaryBorderColor: "#3f3f46",
  primaryColor: "#27272a",
  primaryTextColor: "#f4f4f5",
  secondaryBorderColor: "#3f3f46",
  secondaryColor: "#1f2937",
  secondaryTextColor: "#f4f4f5",
  signalColor: "#a1a1aa",
  signalTextColor: "#f4f4f5",
  tertiaryBorderColor: "#3f3f46",
  tertiaryColor: "#18181b",
  tertiaryTextColor: "#f4f4f5",
  textColor: "#f4f4f5",
};

/** 归一化主入口(对应原文件 resolveCssColor + normalizeCssColorForMermaid 组合链):
 * normalizeMermaidThemeVars(themeVars, options):
 *   themeVars:{ [varName]: cssColor } 对象 / 字符串数组 / 单个颜色串;
 *   options.sampler:采样器(单函数或 {resolve,sample}),缺省原样透传;
 *   options.fallback:采样失败时的统一回退色(缺省回退为原值);
 *   options.theme:"light"|"dark",键值缺失时用原文件深浅主题回退表补默认色。
 * 返回同形状结果:值为 rgb()/rgba() 串;已是 rgb/hex 的值原样透传。 */
function normalizeMermaidThemeVars(themeVars, options) {
  var opts = options || {};
  var sampler = opts.sampler;
  var fallbackTable =
    opts.theme === "dark" ? MERMAID_THEME_VARS_DARK : MERMAID_THEME_VARS_LIGHT;

  var normalizeOne = function (value, key) {
    if (typeof value !== "string") {
      return value;
    }
    var effective = value;
    if (!effective && key && Object.prototype.hasOwnProperty.call(fallbackTable, key)) {
      effective = fallbackTable[key];
    }
    return normalizeCssColor(effective, { sampler: sampler, fallback: opts.fallback });
  };

  if (typeof themeVars === "string") {
    return normalizeCssColor(themeVars, { sampler: sampler, fallback: opts.fallback });
  }
  if (!themeVars || typeof themeVars !== "object") {
    return themeVars;
  }
  if (Array.isArray(themeVars)) {
    var list = [];
    for (var i = 0; i < themeVars.length; i += 1) {
      list.push(normalizeOne(themeVars[i], null));
    }
    return list;
  }
  var result = {};
  for (var key in themeVars) {
    if (!Object.prototype.hasOwnProperty.call(themeVars, key)) continue;
    result[key] = normalizeOne(themeVars[key], key);
  }
  return result;
}

/** 浏览器端真实采样器工厂:对应原文件模块级 mermaidColorResolverEl +
 * mermaidColorNormalizeCtx(span 解析 + canvas 1x1 采样 + 哨兵色检测)。
 * DOM 不可用时返回 null,上层自动走透传/回退(SSR 与最小 mock 不崩,原文件语义)。 */
function createCanvasColorSampler(doc) {
  var documentRef = doc || (typeof document !== "undefined" ? document : null);
  if (!documentRef || typeof documentRef.createElement !== "function") {
    return null;
  }
  var resolverEl = documentRef.createElement("span");
  var canvas = documentRef.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  var ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return null;
  }
  ctx.globalCompositeOperation = "copy";

  return {
    resolve: function (raw) {
      if (!documentRef.body || typeof window === "undefined" || !window.getComputedStyle) {
        return raw;
      }
      documentRef.body.appendChild(resolverEl);
      try {
        resolverEl.style.color = "";
        resolverEl.style.color = raw;
        var resolved = window.getComputedStyle(resolverEl).color;
        return resolved || null;
      } finally {
        resolverEl.remove();
      }
    },
    sample: function (resolved) {
      try {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = CANVAS_SENTINEL_COLOR;
        var sentinelFillStyle = ctx.fillStyle;
        ctx.fillStyle = resolved;
        // fillStyle 停在哨兵色 = canvas 也不认该格式 → 交上层回退。
        if (ctx.fillStyle === sentinelFillStyle) {
          return null;
        }
        ctx.fillRect(0, 0, 1, 1);
        var data = ctx.getImageData(0, 0, 1, 1).data;
        return [data[0] || 0, data[1] || 0, data[2] || 0, data[3] === undefined ? 255 : data[3]];
      } catch (error) {
        return null;
      }
    },
  };
}

const MermaidThemeNormalize = {
  CANVAS_SENTINEL_COLOR: CANVAS_SENTINEL_COLOR,
  normalizeCssColor: normalizeCssColor,
  normalizeMermaidThemeVars: normalizeMermaidThemeVars,
  createCanvasColorSampler: createCanvasColorSampler,
  MERMAID_THEME_VARS_LIGHT: MERMAID_THEME_VARS_LIGHT,
  MERMAID_THEME_VARS_DARK: MERMAID_THEME_VARS_DARK,
};

// 浏览器 script 标签挂全局(与 src/assets 其他资产同款约定);ESM named export 见下。
if (typeof self !== "undefined") {
  self.MermaidThemeNormalize = MermaidThemeNormalize;
} else if (typeof globalThis !== "undefined") {
  globalThis.MermaidThemeNormalize = MermaidThemeNormalize;
}

export {
  CANVAS_SENTINEL_COLOR,
  normalizeCssColor,
  normalizeMermaidThemeVars,
  createCanvasColorSampler,
  MERMAID_THEME_VARS_LIGHT,
  MERMAID_THEME_VARS_DARK,
};
export default MermaidThemeNormalize;
