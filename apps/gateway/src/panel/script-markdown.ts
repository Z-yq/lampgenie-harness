/**
 * 面板主脚本分片:script-markdown(逐字自 panel.ts PAGE 模板搬移, 拆分)。
 * 模板约束沿袭:不得出现反引号与 ${;行内换行不得写裸转义。
 */
export const PANEL_JS_MARKDOWN = `const FENCE = BT + BT + BT;
/** 图片 src 归一( md 可点击图片实修):\→/、剥 file:// 前缀、剥 <…> 包裹、
 * 剥尾部 title(![a](x.png "标题") / '标题' 都只取 x.png)。入参可能是 esc 后的形态
 * (<→&lt,两种形态都吃。归一结果只用于生成 asset URL/图片标签,不参与其它行内语法判定。 */
function mdImgSrc(raw) {
  const BS = String.fromCharCode(92); // 反斜杠走 fromCharCode:PAGE 是大模板串,字面反斜杠会被吃掉
  let s = String(raw == null ? "" : raw).trim();
 // esc 形态还原(只还 &lt;/&gt;/&quot;:这三者才影响包角与 title 切分)
  s = s.split("&lt;").join("<").split("&gt;").join(">").split("&quot;").join('"');
  s = s.split(BS).join("/"); // Windows 分隔符(md 路径里的分隔符统一成 /)
  const wrapped = s.charAt(0) === "<" && s.charAt(s.length - 1) === ">";
 // ![a](<x y.png>):尖括号内整体就是路径(空格合法),不再切 title
  if (wrapped) s = s.slice(1, -1).trim();
  if (s.slice(0, 7).toLowerCase() === "file://") s = s.slice(7); // file:///mnt/e/x.png → /mnt/e/x.png
 // 尾部 title 只认「空格 + 引号」形态(![a](x.png "标题") / '标题'):路径里的空格不动,保证幂等
  if (!wrapped) {
    const dq = s.indexOf('"'), sq = s.indexOf("'");
    const q = dq >= 0 ? dq : sq;
    if (q > 1 && s.charAt(q - 1) === " ") s = s.slice(0, q - 1);
  }
  return s.trim();
}
/** 单图 HTML(可点击图片的内层用:与 ![] 分支同一套 io 通道 + 默认 /uploads? 白名单);
 * 返回 null = 不在可用白名单,调用方回退。注意 ![] 分支本体保持原样(不改成调本函数)。 */
function mdImgHtml(src, alt, io) {
  const s = String(src || "");
  if (io && typeof io.media === "function") { const mv = io.media(s, alt); if (typeof mv === "string") return mv; }
  if (io && typeof io.img === "function") { const iv = io.img(s, alt); if (typeof iv === "string") return iv; }
  if (s.indexOf("/uploads?") === 0) return '<img class="md-img" loading="lazy" src="' + s + '" alt="' + alt + '">';
  return null;
}
function mdInline(t, io) {
 // 单遍扫描(2026-10 重构):从左到右一次成型,不再多轮 indexOf 串行替换——
 // 旧实现按「行内代码→粗体→斜体→图片→链接」分轮在已转义串上拼标签,嵌套/畸形标记会产出错配标签。
 // 现在:识别顺序 行内代码 > 图片/链接 > 粗体 > 删除线 > 斜体;匹配不到闭合标记=按字面输出原符号,
 // 绝不留半个标签。行内代码内不解析任何标记;粗体/删除线/斜体内部递归解析(粗体内允许行内代码)。
 // io( IDE md 预览):可选第 3 参 {img,media,link} 回调——不传或回调返回 null=落回本函数
 // 默认白名单(/uploads? 图、http 链接),聊天流等既有 mdToHtml 调用不传 io,行为逐字节不变。
  return citeText(mdInlineScan(esc(t), 0, io));
}
function mdInlineScan(s, depth, io) {
  let out = "", i = 0;
  const n = s.length;
  const NL2 = String.fromCharCode(10);
  const nest = (inner) => (depth < 3 ? mdInlineScan(inner, depth + 1, io) : inner);
  while (i < n) {
    const c = s.charAt(i);
 // 行内代码(BT…BT):最优先,内部不再解析任何标记
    if (c === BT) {
      const j = s.indexOf(BT, i + 1);
      if (j > i + 1) { out += "<code>" + s.slice(i + 1, j) + "</code>"; i = j + 1; continue; }
      out += BT; i++; continue; // 无闭合:字面输出
    }
 // 可点击图片 [![alt](src)](href):GitHub 文档标准写法(genie-memory 的 14 张流程图为它)。
 // 旧实现:下面的 "!" 分支从 "[" 起算 alt → 取到空 alt 不渲染,剩 "](" 尾巴当字面量,整张图消失。
 // 这里整体识别:内层走与单图完全相同的 media/img 通道(同 URL 生成),外层 http(s) 加
 // target/rel、项目内相对链接包 io.link(第三参 innerHtml 原样输出图片)。
 // 识别失败(缺 ")" / 内层不在白名单)→ 落回下面既有 "!"/"[" 分支,行为逐字不变。
    if (c === "[" && s.charAt(i + 1) === "!") {
      const j = s.indexOf("](", i + 3);
      const k = j > i + 3 ? s.indexOf(")", j + 2) : -1;
      const m = k > j + 2 && s.charAt(k + 1) === "]" && s.charAt(k + 2) === "(" ? s.indexOf(")", k + 3) : -1;
      if (m > k + 3) {
        const alt = s.slice(i + 3, j);
        const src = mdImgSrc(s.slice(j + 2, k));
        const href = s.slice(k + 3, m);
        const inner = mdImgHtml(src, alt, io);
        if (inner) {
          let lk = "";
          if (href.indexOf("http://") === 0 || href.indexOf("https://") === 0) {
            lk = '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + inner + "</a>";
          } else if (io && typeof io.link === "function") {
            const lv = io.link(href, alt, inner);
            if (typeof lv === "string") lk = lv;
          }
          out += lk || inner; i = m + 1; continue; // 包不上链接也至少把图显示出来
        }
      }
    }
 // 图片 ![alt](src):src 仅放行同源受控端点 /uploads?(白名单目录文件服务),外链/其它 src 不渲染。
 // io.media/img( IDE md 预览):视频扩展名先问 io.media、其余图先问 io.img;回调产 html 或
 // null(null=回退本分支默认白名单)。聊天流不传 io,此分支行为与旧版逐字节一致。
    if (c === "!" && s.charAt(i + 1) === "[") {
      const j = s.indexOf("](", i + 2);
      const k = j > i + 2 ? s.indexOf(")", j + 2) : -1;
      if (k > j + 2) {
        const alt = s.slice(i + 2, j);
        const src = mdImgSrc(s.slice(j + 2, k)); // 归一:\→/、file://、<…> 包裹、尾部 title
        if (io && typeof io.media === "function") {
          const mv = io.media(src, alt);
          if (typeof mv === "string") { out += mv; i = k + 1; continue; }
        }
        if (io && typeof io.img === "function") {
          const iv = io.img(src, alt);
          if (typeof iv === "string") { out += iv; i = k + 1; continue; }
        }
        if (src.indexOf("/uploads?") === 0) {
          out += '<img class="md-img" loading="lazy" src="' + src + '" alt="' + alt + '">';
          i = k + 1; continue;
        }
      }
      out += "!"; i++; continue; // 白名单不符/无闭合:字面输出
    }
 // 链接 [t](http…):仅 http 白名单,其余按字面输出;io.link(IDE md 预览)可接相对链接
    if (c === "[") {
      const j = s.indexOf("](", i + 1);
      const k = j > i + 1 ? s.indexOf(")", j + 2) : -1;
      if (k > j + 2) {
        const text = s.slice(i + 1, j);
        const url = s.slice(j + 2, k);
        if (url.indexOf("http") === 0) {
          out += '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + nest(text) + "</a>";
          i = k + 1; continue;
        }
        if (io && typeof io.link === "function") {
          const lv = io.link(url, text);
          if (typeof lv === "string") { out += lv; i = k + 1; continue; }
        }
      }
      out += "["; i++; continue;
    }
 // 粗体 **x**
    if (c === "*" && s.charAt(i + 1) === "*") {
      const j = s.indexOf("**", i + 2);
      if (j > i + 2) { out += "<b>" + nest(s.slice(i + 2, j)) + "</b>"; i = j + 2; continue; }
      out += "*"; i++; continue;
    }
 // 删除线 ~~x~~
    if (c === "~" && s.charAt(i + 1) === "~") {
      const j = s.indexOf("~~", i + 2);
      if (j > i + 2) { out += "<del>" + nest(s.slice(i + 2, j)) + "</del>"; i = j + 2; continue; }
      out += "~"; i++; continue;
    }
 // 斜体 *x*(单星;内容两端不得为空格——避开「2 * 3」算式;内部含粗体标记则不认)
    if (c === "*") {
      const j = s.indexOf("*", i + 1);
      if (j > i + 1) {
        const inner = s.slice(i + 1, j);
        if (inner.charAt(0) !== " " && inner.charAt(inner.length - 1) !== " " && inner.indexOf("**") < 0) {
          out += "<i>" + nest(inner) + "</i>";
          i = j + 1; continue;
        }
      }
      out += "*"; i++; continue;
    }
    if (c === NL2) { out += NL2; i++; continue; }
    out += c; i++;
  }
  return out;
}
function hl(mark, q) {
  if (!q) return mark;
  const lower = mark.toLowerCase(), needle = q.toLowerCase();
  let out = "", i = 0, hit;
  while ((hit = lower.indexOf(needle, i)) >= 0) {
    out += mark.slice(i, hit) + "<mark>" + mark.slice(hit, hit + q.length) + "</mark>";
    i = hit + q.length;
  }
  return out + mark.slice(i);
}
// 代码块渲染:每行一个 span.cl,CSS 计数器出行为行号(body.lineno 开关);长行换行由 body.nowrapcode 控制。
// mermaid 语法块的渲染运行时:自有图渲染器(diagram-renderer.js,纯 JS 资产,零第三方依赖)。
// 占位节点 .md-mermaid[data-mermaid-lazy] 自携带源文本(data-src);渲染完成后 mmRenderIn 扫描
// →按需注入 /assets/diagram-renderer.js(单例幂等)→ OwnDiagram.run({nodes}) 出图;
// 脚本加载失败/超时(5s)/语法超子集一律降级 <pre> 代码文本,不白屏不抛错。
let MM_LIB_LOAD = null; // diagram-renderer.js 懒加载单例(重复渲染不重复注入)
/** 主题基座:浅主题→light 调色板,深主题→dark(渲染器内置明暗双板)。 */
function mmApplyTheme() {
  if (typeof window === "undefined" || !window.OwnDiagram || typeof window.OwnDiagram.configure !== "function") return false;
  try {
    const light = (typeof isLightBase === "function") ? !!isLightBase() : false;
    window.OwnDiagram.configure({ theme: light ? "light" : "dark" });
    return true;
  } catch (e) { return false; }
}
function mmEnsureLib() {
  if (window.OwnDiagram) return Promise.resolve(true);
  if (MM_LIB_LOAD) return MM_LIB_LOAD;
  MM_LIB_LOAD = new Promise((res) => {
    const sc = document.createElement("script");
    sc.src = "/assets/diagram-renderer.js";
    let done = false;
    const fin = (ok) => { if (!done) { done = true; res(ok); } };
    sc.onload = () => {
      try { fin(!!(window.OwnDiagram && typeof window.OwnDiagram.run === "function") && mmApplyTheme()); } catch (e) { fin(false); }
    };
    sc.onerror = () => fin(false);
    setTimeout(() => fin(false), 5000); // 加载超时:降级代码文本,不悬"渲染中…"
    document.head.appendChild(sc);
  });
  return MM_LIB_LOAD;
}
function mmFallback(el) { // 占位回退 <pre> 源文本(data-src 还原;复制也直接可用)
  const src = el.getAttribute("data-src") || "";
  el.removeAttribute("data-mermaid-lazy");
  el.textContent = "";
  const pre = document.createElement("pre");
  pre.className = "md-mermaid-src";
  pre.style.cssText = "overflow:auto;max-width:100%;margin:0;font-family:var(--font-mono,monospace);font-size:11px;line-height:1.5;padding:8px";
  pre.textContent = src;
  el.appendChild(pre);
}
function mmRenderIn(root) { // 消息渲染完成钩子:扫描 root(缺省 document)内未处理占位并出图
  const scope = root && root.querySelectorAll ? root : document;
  const els = scope.querySelectorAll(".md-mermaid[data-mermaid-lazy]");
  if (!els.length) return;
  mmEnsureLib().then((ok) => {
    for (const el of els) {
      if (!el.hasAttribute("data-mermaid-lazy")) continue; // 已渲染/已降级(重复渲染幂等)
      if (!ok || !window.OwnDiagram || typeof window.OwnDiagram.run !== "function") { mmFallback(el); continue; }
      Promise.resolve(window.OwnDiagram.run({ nodes: [el] })).then(() => {
        const svg = el.querySelector("svg");
        if (svg) svg.style.maxWidth = "100%"; else mmFallback(el); // 无 svg=异常防御降级
      }).catch(() => mmFallback(el)); // 语法超子集:单节点 reject,降级代码文本
    }
  });
}
// ---- 富图形交付:围栏 html / svg → 可看图卡 ----
// 设计稿级布局/排版/标注不是 mermaid 能表达的形态(分层容器、斜向带、编号标注、逐点注解);
// 这类图由 agent 用自包含 html(内联 CSS)/ svg 交付,面板把它渲染成图卡。
// html: 沙箱 iframe(sandbox="" 禁脚本/表单/同源 + 注入 CSP default-src 'none',图/字体只放 data:);
// svg: DOMParser 解析(XML 解析期不执行脚本)→ 剥 script/foreignObject/iframe/object/embed/audio/video、
// 剥 on* 属性、href 只留 #片段与 data:image → importNode 内联。失败或超 512KB 一律回落代码块 + 一行说明。
function artInfoOf(info0) {
 // 围栏 info:首词=语言,后续 key=value;目前只认 height(HTML 图卡高度:夹 240~1200,缺省 560)
  const raw = String(info0 || "").replace(String.fromCharCode(9), " ").trim();
  const parts = raw ? raw.split(" ") : [];
  const lang = String(parts[0] || "").toLowerCase();
  let height = 560;
  for (let i = 1; i < parts.length; i++) {
    const seg = String(parts[i] || "").toLowerCase();
    if (seg.indexOf("height=") === 0) {
      const n = parseInt(seg.slice(7), 10);
      if (n > 0) height = Math.max(240, Math.min(1200, n));
    }
  }
  return { lang: lang, height: height };
}
function artFallbackNote(msg) { return '<div class="md-art-note">' + esc(msg) + "</div>"; }
function artHtmlCard(src, height) {
  const Q = String.fromCharCode(39); // 单引号:CSP 关键字定界(PAGE 模板串里不写转义)
  const csp = '<meta http-equiv="Content-Security-Policy" content="default-src ' + Q + "none" + Q +
    "; style-src " + Q + "unsafe-inline" + Q + '; img-src data:; font-src data:">';
 // 源是完整文档时只往 <head> 里插 CSP(不二次包裹 body——旧写法会把整份 doctype 塞进 body 里);
 // 片段形态才裹成完整文档。两种形态 CSP 都排在 iframe 内文档最前。
  const s = String(src || "");
  const low = s.toLowerCase();
  let doc = "";
  if (low.indexOf("<!doctype") >= 0 || low.indexOf("<html") >= 0) {
    const hi = low.indexOf("<head");
    const headEnd = hi >= 0 ? s.indexOf(">", hi) : -1;
    if (headEnd > 0) doc = s.slice(0, headEnd + 1) + csp + s.slice(headEnd + 1);
    else doc = csp + s;
    if (doc.trim().toLowerCase().indexOf("<!doctype") !== 0 && low.indexOf("<!doctype") !== 0) doc = "<!doctype html>" + doc;
  } else {
    doc = '<!doctype html><html><head><meta charset="utf-8">' + csp + "</head><body>" + s + "</body></html>";
  }
  return '<div class="md-artifact md-html"><div class="md-artifact-bar"><span class="art-kind">HTML 图卡</span>' +
    '<span class="art-sp"></span><button class="art-full">全屏</button></div><div class="art-body">' +
    '<iframe sandbox="" referrerpolicy="no-referrer" title="HTML 图卡" style="height:' + height + 'px"' +
    ' srcdoc="' + esc(doc) + '"></iframe></div></div>';
}
function artSvgCard(src) {
 // 纯字符串占位(可测、可增量比较);落 DOM 后由 artRenderIn → artMountSvg 解析净化再内联。
  return '<div class="md-artifact md-svg" data-art-svg="1" data-art-src="' + esc(src) + '">' +
    '<div class="md-artifact-bar"><span class="art-kind">SVG 图卡</span><span class="art-sp"></span>' +
    '<button class="art-fit">1:1</button><button class="art-full">全屏</button></div>' +
    '<div class="art-body"><div class="cc-empty">图渲染中…</div></div></div>';
}
let artDelegated = false; // 图卡交互委托一次性守卫(同 code-copy 语义,防每次渲染重复挂监听)
function artStripSvgAttrs(el) {
  if (!el || !el.attributes) return;
  const list = [];
  for (let i = 0; i < el.attributes.length; i++) list.push(el.attributes[i]);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const nm = String(a.name || "").toLowerCase();
    const val = String(a.value || "").trim().toLowerCase();
    if (nm.indexOf("on") === 0) { el.removeAttribute(a.name); continue; } // on* 事件处理器
    if (nm === "href" || nm === "xlink:href" || nm === "src") {
 // 只允许文档内片段与内联图;外部取数(网络图/字体/文档)一律剥掉
      if (!(val.indexOf("#") === 0 || val.indexOf("data:image") === 0)) el.removeAttribute(a.name);
      continue;
    }
    if (nm === "style" && val.indexOf("url(") >= 0 && val.indexOf("url(#") < 0 && val.indexOf("url(data:image") < 0) {
      el.removeAttribute(a.name); continue;
    }
    if (val.indexOf("javascript:") === 0) el.removeAttribute(a.name);
  }
}
function artSanitizeSvg(src) {
  if (typeof DOMParser === "undefined") return null; // 非浏览器环境(单测沙箱):只留占位,不炸
  let doc = null;
  try { doc = new DOMParser().parseFromString(String(src || ""), "image/svg+xml"); } catch (e) { return null; }
  if (!doc) return null;
  const root = doc.documentElement;
  if (!root || String(root.nodeName || "").toLowerCase() !== "svg") return null;
  if (doc.getElementsByTagName("parsererror").length || doc.getElementsByTagName("parserError").length) return null;
  const BAN = ["script", "foreignobject", "iframe", "object", "embed", "audio", "video"];
  const elems = [root];
  const all = root.getElementsByTagName("*");
  for (let i = 0; i < all.length; i++) elems.push(all[i]);
  for (let i = elems.length - 1; i >= 0; i--) {
    const el = elems[i];
    const nm = String(el.nodeName || "").toLowerCase();
    if (BAN.indexOf(nm) >= 0) { if (el.parentNode) el.parentNode.removeChild(el); continue; }
    artStripSvgAttrs(el);
  }
  return root;
}
function artDegrade(box, src, msg) {
  const note = artFallbackNote(msg + ",已回落为代码块");
  const code = '<pre class="code">' + String(src || "").split(String.fromCharCode(10))
    .map((l) => '<span class="cl">' + (esc(l) || "&nbsp;") + "</span>").join("") + "</pre>";
  const body = box.querySelector(".art-body");
  if (body) body.innerHTML = note + code; else box.innerHTML = note + code;
  box.removeAttribute("data-art-svg");
}
function artMountSvg(box, src) {
  const root = artSanitizeSvg(src);
  if (!root) { artDegrade(box, src, "SVG 解析失败"); return; }
  const body = box.querySelector(".art-body");
  if (!body) { box.removeAttribute("data-art-svg"); return; }
  let node = null;
  try { node = document.importNode(root, true); } catch (e) { artDegrade(box, src, "SVG 挂载失败"); return; }
  body.innerHTML = "";
  body.appendChild(node);
  box.removeAttribute("data-art-svg"); // 幂等:重复 artRenderIn 不再重挂
}
function artBindDelegates() {
  if (artDelegated) return;
  artDelegated = true;
  document.addEventListener("click", (e) => {
    const t = e.target && e.target.closest ? e.target.closest(".art-full,.art-fit") : null;
    if (!t) return;
    const box = t.closest ? t.closest(".md-artifact") : null;
    if (!box) return;
    if (t.classList.contains("art-full")) {
      const on = !box.classList.contains("art-fs");
      box.classList.toggle("art-fs", on);
      t.textContent = on ? "退出全屏" : "全屏";
    } else {
      const raw = box.classList.toggle("art-raw");
      t.textContent = raw ? "适宽" : "1:1";
    }
  });
  document.addEventListener("keydown", (e) => {
    if (!e.key || e.key !== "Escape") return;
    const open = document.querySelectorAll(".md-artifact.art-fs");
    if (!open.length) return;
    e.preventDefault();
    for (let i = 0; i < open.length; i++) {
      open[i].classList.remove("art-fs");
      const b = open[i].querySelector(".art-full");
      if (b) b.textContent = "全屏";
    }
  });
}
/** 图卡挂载钩子(与 mmRenderIn 同形):消息流/子代理工作区/IDE md 预览/wiki 落 innerHTML 后各调一次。 */
function artRenderIn(root) {
  if (typeof document === "undefined") return;
  const scope = root || document;
  if (!scope.querySelectorAll) return;
  if (scope.querySelector(".md-artifact")) artBindDelegates();
  const els = scope.querySelectorAll('.md-artifact.md-svg[data-art-svg="1"]');
  for (let i = 0; i < els.length; i++) artMountSvg(els[i], els[i].getAttribute("data-art-src") || "");
}
function renderCodeBlock(lines, lang0) {
  const info = artInfoOf(lang0);
  const srcText = lines.join(String.fromCharCode(10));
  const big = srcText.length > 524288; // 512KB 上限:超限回落代码块,不把大字符串塞进 iframe/srcdoc
  if (!big && info.lang === "html") return artHtmlCard(srcText, info.height);
  if (!big && info.lang === "svg") return artSvgCard(srcText);
  const body = lines.map((l) => '<span class="cl">' + (esc(l) || "&nbsp;") + '</span>').join("");
 // 语言来自开围栏行(mdToHtml 记录到 preLang;围栏行本身不进 preBuf——旧实现期待它进 preBuf,
 // 导致所有围栏语言丢失 + mermaid 永不进 md-mermaid, 修复)。
  const lang = String(lang0 || "").trim();
  if (lang === "mermaid") {
 // mermaid 围栏:占位节点自携带源文本(data-src,esc 已覆盖 &<>";单引号属性安全),
 // 重复渲染/降级还原都不依赖外部 Map——懒加载失败(脚本 404/网络/语法错)可就地回退 <pre> 代码文本。
    return '<div class="md-mermaid" data-mermaid-lazy="1" data-src="' + esc(lines.join(String.fromCharCode(10))) +
      '"><div class="cc-empty">mermaid 图渲染中…</div></div>';
  }
 // (历史注:CODE_SRC Map 原为围栏原文暂存, mermaid 懒加载改版后源文本由 data-src 自携带,Map 已移除)
 // is-code 板色标记 + data-lang(同族 .code-wrap 靠类区分语种;终端/JSON 各自板色见 CSS)
  const over = big && (info.lang === "html" || info.lang === "svg")
    ? artFallbackNote("图卡源超出 512KB 上限,已回落为代码块") : "";
  return over + '<div class="code-wrap is-code" data-lang="' + esc(lang || "text") + '"><div class="code-bar"><span class="code-lang">' + esc(lang || "code") + '</span>' +
    '<button class="code-copy">复制</button></div>' +
    '<pre class="code">' + body + '</pre></div>';
}
function mdToHtml(text, q, io) {
  const lines = String(text).split(String.fromCharCode(10));
  let html = "", inPre = false, preBuf = [], preLang = "", listOpen = false, olOpen = false, olStart = "1", quoteOpen = false;
 // subTag = 当前开启的子列表标签(null | "ul" | "ol"):ul/ol 嵌套对称,close 时按标签输出对应闭合
  let liOpen = false, subTag = null; // 嵌套列表(渲染二期):父 li 保持开启,子列表嵌在其中
  let tableBuf = [], tablePending = false;
  let paraBuf = []; // :连续正文行聚成 <p>(旧实现逐行 <br>,段距无从谈起=信息挤成一片)
  const flushPara = () => {
    if (!paraBuf.length) return;
    html += "<p>" + paraBuf.join("<br>") + "</p>";
    paraBuf = [];
  };
  const closeSubTag = () => { if (subTag) { html += "</" + subTag + ">"; subTag = null; } };
  const closeList = () => {
    flushPara();
    closeSubTag();
    if (liOpen) { html += "</li>"; liOpen = false; }
    if (listOpen) { html += "</ul>"; listOpen = false; }
    if (olOpen) { html += "</ol>"; olOpen = false; }
  };
 // 关闭嵌套+父 li(顶层新条目/换列表类型前调)
  const closeSub = () => { closeSubTag(); if (liOpen) { html += "</li>"; liOpen = false; } };
  for (const line of lines) {
    if (line.startsWith(FENCE)) {
      if (inPre) { html += renderCodeBlock(preBuf, preLang); preBuf = []; preLang = ""; inPre = false; }
      else { closeList(); if (quoteOpen) { html += "</blockquote>"; quoteOpen = false; } preLang = line.slice(FENCE.length).trim(); inPre = true; }
      continue;
    }
    if (inPre) { preBuf.push(line); continue; }
    const hm = /^(#{1,4}) (.+)$/.exec(line);
    if (hm) { closeList(); const lv = Math.min(6, hm[1].length + 2); html += "<h" + lv + ">" + hl(mdInline(hm[2], io), q) + "</h" + lv + ">"; continue; }
 // 分隔线(渲染二期):--- / *** / ___ 独占一行
    const tr = line.trim();
    if (tr.length >= 3 && (tr === "-".repeat(tr.length) || tr === "*".repeat(tr.length) || tr === "_".repeat(tr.length))) {
      closeList(); if (quoteOpen) { html += "</blockquote>"; quoteOpen = false; }
      html += '<hr class="md-hr">'; continue;
    }
 // 任务列表(渲染二期):- [ ] / - [x] → 复选框
    const tkm = (line.startsWith("- [ ] ") || line.startsWith("- [x] ") || line.startsWith("- [X] ") || line.startsWith("* [ ] ") || line.startsWith("* [x] ") || line.startsWith("* [X] "))
      ? { done: line.charAt(3) !== " ", text: line.slice(6) } : null;
    const lm = /^ *[-*] (.+)$/.exec(line);
    const indent = line.length - line.trimStart().length;
    if (lm || tkm) {
      const content = tkm
        ? '<input type="checkbox" disabled' + (tkm.done ? " checked" : "") + ">" + hl(mdInline(tkm.text, io), q)
        : hl(mdInline(lm[1], io), q);
      if (indent >= 2 && (listOpen || olOpen)) {
 // 嵌套子列表(一级):挂在当前父 li 内(父列表 ul/ol 皆可);已开子列表类型不同则先关再开
        if (subTag !== "ul") { closeSubTag(); html += "<ul>"; subTag = "ul"; }
        html += "<li>" + content + "</li>";
        continue;
      }
      closeSub();
      if (olOpen) { html += "</ol>"; olOpen = false; }
      if (!listOpen) { html += "<ul>"; listOpen = true; }
      html += "<li>" + content; liOpen = true; // 父 li 保持开启(子列表要嵌进来)
      continue;
    }
 // 有序列表(渲染修复):1. / 1、两种形态——此前不支持,整段摔成裸行(格式乱飞主源之一)
 // 嵌套对称:正则捕获缩进 om[1]、序号 om[2]、正文 om[3];父 li 保持开启以挂子 ol
    const om = /^( *)([0123456789]+)[.] (.+)$/.exec(line) || /^( *)([0123456789]+)、(.+)$/.exec(line);
    if (om) {
      const oIndent = om[1].length, oContent = hl(mdInline(om[3], io), q);
      if (oIndent >= 2 && (listOpen || olOpen)) {
 // 嵌套有序子列表(一级):与 ul 对称,挂在当前父 li 内;子 ol 不带 start(浏览器自然从 1 起)
        if (subTag !== "ol") { closeSubTag(); html += "<ol>"; subTag = "ol"; }
        html += "<li>" + oContent + "</li>";
        continue;
      }
      closeSub();
      if (listOpen) { html += "</ul>"; listOpen = false; }
      if (!olOpen) { olStart = om[2]; html += '<ol start="' + om[2] + '">'; olOpen = true; }
      html += "<li>" + oContent; liOpen = true; // 父 li 保持开启(嵌套 ol 要嵌进来),闭合由 closeSub/closeList 补
      continue;
    }
 // 非列表行:先收掉嵌套与父 li,再收顶层列表(ul/ol 各自按开着的标签闭合)
    if (subTag || liOpen) closeSub(); else if (listOpen) { html += "</ul>"; listOpen = false; }
    if (olOpen) { html += "</ol>"; olOpen = false; }
 // 表格(ZCode markdown-table):| 表头 | + | --- | 分隔行 + 数据行
    if (!inPre && line.startsWith("|")) {
      const isSep = /^[|][:| -]*[|]$/.test(line.trim());
      if (isSep) continue; // 分隔行不产内容
 // 先按 | 切,再丢首尾空段——旧口径 /^\||\|$/g 只能吃「正好一个」首尾竖线,
 // 行尾竖线带空格或双竖线时留下空段 → 表头多一列「幻影空列」(经验证表头 6 列数据 5 列)。
      const cells = line.split("|").map((c) => c.trim());
      if (cells.length && cells[0] === "") cells.shift();
      if (cells.length && cells[cells.length - 1] === "") cells.pop();
      tableBuf.push(cells);
      tablePending = true;
      continue;
    }
    if (tablePending && !line.startsWith("|")) {
 // 表格块结束:第一行=表头,其余=数据
      const rows = tableBuf; tableBuf = []; tablePending = false;
      if (rows.length) {
        closeList();
        const head = rows[0] || [];
        html += '<div class="md-table-wrap"><table class="md-table"><thead><tr>' + head.map((c) => "<th>" + hl(mdInline(c, io), q) + "</th>").join("") + "</tr></thead><tbody>" +
          rows.slice(1).map((r) => "<tr>" + head.map((_, ci) => "<td>" + hl(mdInline(r[ci] || "", io), q) + "</td>").join("") + "</tr>").join("") + "</tbody></table></div>";
      }
    }
 // blockquote(ZCode markdown-blockquote):连续 > 行
    if (!inPre && line.startsWith("> ")) {
      if (!quoteOpen) { closeList(); html += '<blockquote class="md-quote">'; quoteOpen = true; }
      html += hl(mdInline(line.slice(2), io), q) + "<br>";
      continue;
    }
    if (quoteOpen) { html += "</blockquote>"; quoteOpen = false; }
    closeList();
    if (line.trim() === "") { flushPara(); continue; }
    paraBuf.push(hl(mdInline(line, io), q));
  }
  if (inPre) html += renderCodeBlock(preBuf, preLang);
  flushPara();
  closeList();
  if (quoteOpen) html += "</blockquote>";
  if (tablePending && tableBuf.length) {
    const head = tableBuf[0] || [];
    html += '<div class="md-table-wrap"><table class="md-table"><thead><tr>' + head.map((c) => "<th>" + hl(mdInline(c, io), q) + "</th>").join("") + "</tr></thead><tbody>" +
      tableBuf.slice(1).map((r) => "<tr>" + head.map((_, ci) => "<td>" + hl(mdInline(r[ci] || "", io), q) + "</td>").join("") + "</tr>").join("") + "</tbody></table></div>";
  }
  return sketchifyHtml(html); // 内容层 emoji 素描化总出口(全量/增量 mfPatch 同链,确定性转换)
}
`;
