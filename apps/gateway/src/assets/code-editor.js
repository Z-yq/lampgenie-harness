/**
 * code-editor.js — 自有代码编辑器(Monaco 兼容适配层;零第三方依赖,零 worker,零外联)。
 *
 * 架构:高亮 <pre> 镜像 + 透明 <textarea> 输入层(原生 IME/剪贴板/无障碍/按键语义),
 * 行号槽与诊断标记挂槽位;分语言词法高亮为自有实现(C-like/JSON/CSS/Python/Shell/
 * YAML/TOML/Markdown/HTML/XML 子集),未映射语言=纯文本。
 * 对外暴露与 Monaco 同形的命名空间(window.OwnCodeEditor ≈ window.monaco):
 *   Uri.file / Range / KeyMod / KeyCode / editor.{create,createModel,getModel,setModelMarkers,
 *   defineTheme,setTheme,getModels} 与编辑器实例 API(create/setModel/getValue/setValue/
 *   updateOptions/layout/onDidChange 系列/revealLineInCenter/setSelection/deltaDecorations/
 *   getSelection/getAction/executeEdits/addCommand/createDiffEditor/getModel)。
 * DOM 词表与 Monaco 同形(.monaco-editor/.view-lines/.view-line/.line-numbers),面板样式
 * 与浏览器断言零改动可用。
 * 功能边界:不提供 IntelliSense 补全/多光标/minimap(面板缺省即关);超出面板实际用法的
 * Monaco API 以安全 no-op 兜底。>4000 行文件高亮降级为纯文本(保输入流畅,登记在头注)。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.OwnCodeEditor = factory();
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  // ------------------------------------------------------------------
  // 主题与词法高亮调色板(明/暗;面板 bronze/amber 色系)
  // ------------------------------------------------------------------
  var TOKEN_PALETTES = {
    dark: {
      kw: "#c98f45", str: "#9dc48b", num: "#d9a05b", com: "#6b5c4a", typ: "#e0c089", txt: "#ece1d1", punct: "#b39b74",
    },
    light: {
      kw: "#a05f1c", str: "#3e7a3e", num: "#9a6a1f", com: "#8a7a64", typ: "#7a5a10", txt: "#2a1c0e", punct: "#5a4a2e",
    },
  };
  var themeName = "dark";
  function pal() { return TOKEN_PALETTES[themeName] || TOKEN_PALETTES.dark; }

  var KEYWORDS = {
    ts: "const let var function return if else for while do break continue class extends new this super import export from default try catch finally throw typeof instanceof void delete in of async await yield static get set public private protected readonly interface implements enum declare namespace abstract as is keyof infer satisfies switch case null undefined true false",
    py: "def class return if elif else for while break continue import from as with try except finally raise yield lambda global nonlocal assert pass del in is not and or None True False async await match case",
    go: "package import func var const type struct interface map chan go defer select switch case default if else for range return break continue fallthrough nil true false",
    rs: "fn let mut const static struct enum impl trait pub use mod match if else for while loop return break continue as dyn ref move where unsafe async await self Self Some None Ok Err true false",
    c: "int char float double void long short unsigned signed struct union enum typedef static extern register const volatile return if else for while do switch case default break continue sizeof goto auto inline",
    java: "public private protected class interface extends implements static final void int long double float boolean char byte short new return if else for while do switch case default break continue try catch finally throw throws this super import package instanceof abstract synchronized volatile transient null true false",
    sh: "if then else elif fi for while do done case esac function return exit local export readonly shift",
    yaml: "true false null yes no on off",
    lua: "local function end if then else elseif for while do return break repeat until nil true false and or not",
    sql: "select from where insert into values update set delete create table drop alter join left right inner outer on group by order limit offset as and or not null primary key foreign references index distinct union all having",
  };
  var ALIAS = {
    ts: ["ts", "tsx", "typescript"], js: ["js", "jsx", "javascript", "mjs", "cjs", "mts", "cts"],
    py: ["py", "python"], go: ["go"], rs: ["rs", "rust"], c: ["c", "cpp", "h", "hpp", "cc", "cxx", "cs"],
    java: ["java", "kt", "swift", "scala"], sh: ["sh", "bash", "zsh", "ps1"], yaml: ["yaml", "yml"],
    lua: ["lua"], sql: ["sql"], css: ["css", "scss", "less"], json: ["json"], md: ["md", "markdown"],
    html: ["html", "xml", "svg", "vue"], toml: ["toml", "ini", "cfg"], plaintext: ["txt", "log", "plaintext"],
  };
  var LANG_OF = {};
  for (var k in ALIAS) for (var a = 0; a < ALIAS[k].length; a++) LANG_OF[ALIAS[k][a]] = k;

  function isWordChar(c) { return /[A-Za-z0-9_$]/.test(c); }

  /** C-like 词法:一行 → [{text, cls}]。简单状态机(字符串/注释不跨行时逐行处理;
   *  块注释跨行由调用方携带 inBlockComment 状态)。 */
  function tokenizeCLine(line, state) {
    var out = [];
    var i = 0, buf = "", cls = null;
    function flush() { if (buf) { out.push({ text: buf, cls: cls }); buf = ""; cls = null; } }
    var kwSet = KEYWORDS[state.lang];
    while (i < line.length) {
      if (state.block) {
        var end = line.indexOf("*/", i);
        if (end === -1) { out.push({ text: line.slice(i), cls: "com" }); return out; }
        out.push({ text: line.slice(i, end + 2), cls: "com" });
        i = end + 2; state.block = false; continue;
      }
      var rest = line.slice(i);
      var m;
      if ((m = rest.match(/^\/\/.*$/))) { flush(); out.push({ text: m[0], cls: "com" }); break; }
      if ((m = rest.match(/^\/\*/))) { flush(); state.block = true; i += 2; continue; }
      if ((m = rest.match(/^(["'])(?:\\.|(?!\1)[^\\])*\1?/))) {
        flush(); out.push({ text: m[0], cls: "str" }); i += m[0].length; continue;
      }
      if ((m = rest.match(/^`(?:\\.|[^`])*`?/))) { flush(); out.push({ text: m[0], cls: "str" }); i += m[0].length; continue; }
      if ((m = rest.match(/^[0-9][0-9xXbBoOaAfF._]*/))) { flush(); out.push({ text: m[0], cls: "num" }); i += m[0].length; continue; }
      if (isWordChar(line[i])) {
        var w = rest.match(/^[A-Za-z0-9_$]+/)[0];
        flush();
        if (kwSet && kwSet.split(" ").indexOf(w) >= 0) out.push({ text: w, cls: "kw" });
        else if (/^[A-Z]/.test(w) || /^[A-Z][a-z0-9]*[A-Z]/.test(w)) out.push({ text: w, cls: "typ" });
        else out.push({ text: w, cls: null });
        i += w.length; continue;
      }
      buf += line[i]; i++;
      if (!cls) cls = "punct";
    }
    flush();
    return out;
  }

  function tokenizeSimpleLine(line, state) {
    var out = [];
    var i = 0;
    var kwSet = KEYWORDS[state.lang];
    while (i < line.length) {
      var rest = line.slice(i);
      var m;
      if (state.lang === "py" || state.lang === "sh" || (state.lang === "yaml") || (state.lang === "toml")) {
        if ((m = rest.match(/^#.*$/))) { out.push({ text: m[0], cls: "com" }); break; }
      }
      if (state.lang === "sql") {
        if ((m = rest.match(/^--.*$/))) { out.push({ text: m[0], cls: "com" }); break; }
        if ((m = rest.match(/^\/\*/))) { out.push({ text: rest.slice(m.index), cls: "com" }); break; }
      }
      if ((m = rest.match(/^(["'])(?:\\.|(?!\1)[^\\])*\1?/))) { out.push({ text: m[0], cls: "str" }); i += m[0].length; continue; }
      if ((m = rest.match(/^[0-9][0-9._xXbBa-fA-F]*/))) { out.push({ text: m[0], cls: "num" }); i += m[0].length; continue; }
      if (isWordChar(line[i])) {
        var w = rest.match(/^[A-Za-z0-9_]+/)[0];
        if (kwSet && kwSet.split(" ").indexOf(w) >= 0) out.push({ text: w, cls: "kw" });
        else out.push({ text: w, cls: null });
        i += w.length; continue;
      }
      out.push({ text: line[i], cls: "punct" }); i++;
    }
    return out;
  }

  function tokenizeMdLine(line) {
    var out = [];
    if (/^\s{0,3}#{1,6}\s/.test(line)) return [{ text: line, cls: "kw" }];
    if (/^\s*([-*+]|\d+\.)\s/.test(line)) return [{ text: line, cls: null }];
    if (/^\s*```/.test(line)) return [{ text: line, cls: "com" }];
    var parts = line.split(/(`[^`]*`|\*\*[^*]+\*\*|\[[^\]]*\]\([^)]*\))/);
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      if (/^`/.test(parts[i])) out.push({ text: parts[i], cls: "str" });
      else if (/^\*\*/.test(parts[i])) out.push({ text: parts[i], cls: "kw" });
      else out.push({ text: parts[i], cls: null });
    }
    return out;
  }

  function tokenizeHtmlLine(line, state) {
    var out = [];
    var re = /(<!--[\s\S]*?-->|<\/?[A-Za-z][A-Za-z0-9:_-]*|\/?>|"[^"]*"|'[^']*')/g;
    var last = 0, m;
    while ((m = re.exec(line)) !== null) {
      if (m.index > last) out.push({ text: line.slice(last, m.index), cls: null });
      var tok = m[0];
      var cls = /^</.test(tok) ? "kw" : /^["']/.test(tok) ? "str" : /^<!--/.test(tok) ? "com" : null;
      out.push({ text: tok, cls: cls });
      last = m.index + tok.length;
    }
    if (last < line.length) out.push({ text: line.slice(last), cls: null });
    return out;
  }

  function tokenizeJsonLine(line) {
    var out = [];
    var re = /("(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/g;
    var last = 0, m;
    while ((m = re.exec(line)) !== null) {
      if (m.index > last) out.push({ text: line.slice(last, m.index), cls: "punct" });
      var tok = m[0];
      out.push({ text: tok, cls: /:$/.test(tok) ? "typ" : /^"/.test(tok) ? "str" : "num" });
      last = m.index + tok.length;
    }
    if (last < line.length) out.push({ text: line.slice(last), cls: "punct" });
    return out;
  }

  function tokenizeCssLine(line, state) {
    var out = [];
    var re = /(\/\*[\s\S]*?\*\/|\/\/.*$|@[\w-]+|"[^"]*"|'[^']*'|#[0-9a-fA-F]{3,8}\b|-?\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms)?)/g;
    var last = 0, m;
    while ((m = re.exec(line)) !== null) {
      if (m.index > last) out.push({ text: line.slice(last, m.index), cls: null });
      var tok = m[0];
      out.push({ text: tok, cls: /^\/|^\@/.test(tok) ? "com" : /^["']/.test(tok) ? "str" : "num" });
      last = m.index + tok.length;
    }
    if (last < line.length) out.push({ text: line.slice(last), cls: null });
    return out;
  }

  function highlightLines(content, lang) {
    var lines = String(content).split("\n");
    if (lines.length > 4000) return null; // 超长降级:纯文本(保输入流畅)
    var state = { lang: LANG_OF[lang] || (lang === "plaintext" ? "plaintext" : lang), block: false };
    if (state.lang === "plaintext" || !state.lang) return null;
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var toks;
      if (state.lang === "md") toks = tokenizeMdLine(lines[i]);
      else if (state.lang === "html") toks = tokenizeHtmlLine(lines[i], state);
      else if (state.lang === "json") toks = tokenizeJsonLine(lines[i]);
      else if (state.lang === "css") toks = tokenizeCssLine(lines[i], state);
      else if (state.lang === "ts" || state.lang === "js" || state.lang === "c" || state.lang === "java" || state.lang === "go" || state.lang === "rs" || state.lang === "sql" || state.lang === "lua") toks = tokenizeCLine(lines[i], state);
      else toks = tokenizeSimpleLine(lines[i], state);
      out.push(toks.length ? toks : [{ text: "", cls: null }]);
    }
    return out;
  }

  function xmlEsc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ------------------------------------------------------------------
  // 模型注册表(URI 键)与命名空间
  // ------------------------------------------------------------------
  var modelRegistry = {};   // uriString -> Model
  var themeListeners = [];

  function makeUri(path) {
    return { path: String(path), $$dgUri: true, toString: function () { return String(path); } };
  }
  function uriKey(uri) {
    if (uri === null || uri === undefined) return String(uri);
    if (typeof uri === "string") return uri;
    return typeof uri.toString === "function" ? uri.toString() : String(uri);
  }

  function makeModel(content, language, uri) {
    var key = uriKey(uri);
    if (key && modelRegistry[key]) { modelRegistry[key]._content = String(content); return modelRegistry[key]; }
    var lines = String(content).split("\n");
    var model = {
      uri: uri || null,
      __dgModel: true,
      getLanguageId: function () { return language || "plaintext"; },
      getValue: function () { return model._content; },
      setValue: function (v) { model._content = String(v); if (model.__onChange) model.__onChange(); },
      dispose: function () { if (key) delete modelRegistry[key]; },
      getOptions: function () { return { tabSize: 4, insertSpaces: true, readOnly: false }; },
      getEOL: function () { return "\n"; },
      getLineCount: function () { return model._content.split("\n").length; },
      getLineMaxColumn: function (lineNumber) {
        var ls = model._content.split("\n");
        return (ls[Math.min(Math.max(0, lineNumber - 1), ls.length - 1)] || "").length + 1;
      },
      getValueInRange: function (range) {
        if (!range) return model._content;
        var ls = model._content.split("\n");
        var sL = Math.max(1, range.startLineNumber), eL = Math.min(ls.length, range.endLineNumber);
        if (sL === eL) return (ls[sL - 1] || "").slice((range.startColumn || 1) - 1, (range.endColumn || 1) - 1);
        var out = (ls[sL - 1] || "").slice((range.startColumn || 1) - 1);
        for (var i = sL; i < eL - 1; i++) out += "\n" + (ls[i] || "");
        out += "\n" + (ls[eL - 1] || "").slice(0, Math.max(0, (range.endColumn || 1) - 1));
        return out;
      },
      getFullModelRange: function () {
        return new Range(1, 1, model.getLineCount(), model.getLineMaxColumn(model.getLineCount()));
      },
      _content: String(content),
    };
    if (key) modelRegistry[key] = model;
    return model;
  }

  function Range(startLineNumber, startColumn, endLineNumber, endColumn) {
    return {
      startLineNumber: startLineNumber, startColumn: startColumn || 1,
      endLineNumber: endLineNumber || startLineNumber, endColumn: endColumn || startColumn || 1,
    };
  }

  // ------------------------------------------------------------------
  // 编辑器实例
  // ------------------------------------------------------------------
  function EditorInstance(host, opts) {
    opts = opts || {};
    var self = this;
    this.__dg = true;
    var readOnly = !!opts.readOnly;
    var wordWrap = opts.wordWrap === "on";
    var listeners = { content: [], cursor: [], selection: [] };
    var markersByModel = {}; // uriKey -> markers[]
    var decorations = [];    // {line, className}
    var current = null;      // 当前 Model
    var dom = null;          // DOM 引用束
    var rafPending = false;

    function buildDom() {
      var root = document.createElement("div");
      root.className = "monaco-editor dg-editor" + (themeName === "light" ? " dg-light" : " dg-dark");
      root.style.cssText = "position:relative;width:100%;height:100%;display:flex;overflow:hidden;background:transparent";
      var gutter = document.createElement("div");
      gutter.className = "dg-gutter";
      gutter.style.cssText = "flex:0 0 auto;min-width:46px;text-align:right;padding:8px 10px 8px 6px;user-select:none;overflow:hidden;font-family:" + (opts.fontFamily || "ui-monospace, monospace") + ";font-size:" + (opts.fontSize || 12.5) + "px;line-height:" + (opts.lineHeight || 20) + "px;color:#6b5c4a";
      var wrap = document.createElement("div");
      wrap.className = "dg-wrap";
      wrap.style.cssText = "position:relative;flex:1 1 auto;overflow:hidden";
      var pre = document.createElement("pre");
      pre.className = "view-lines";
      pre.style.cssText = "margin:0;padding:8px 12px;font-family:" + (opts.fontFamily || "ui-monospace, monospace") + ";font-size:" + (opts.fontSize || 12.5) + "px;line-height:" + (opts.lineHeight || 20) + "px;letter-spacing:0;white-space:pre;overflow:hidden;color:" + pal().txt + ";tab-size:" + (opts.tabSize || 4);
      var ta = document.createElement("textarea");
      ta.className = "dg-input";
      ta.spellcheck = false;
      ta.wrap = "off";
      ta.style.cssText = "position:absolute;inset:0;margin:0;padding:8px 12px;border:0;outline:0;resize:none;background:transparent;color:transparent;caret-color:" + (themeName === "light" ? "#a05f1c" : "#c98f45") + ";font-family:" + (opts.fontFamily || "ui-monospace, monospace") + ";font-size:" + (opts.fontSize || 12.5) + "px;line-height:" + (opts.lineHeight || 20) + "px;letter-spacing:0;white-space:pre;overflow:auto;tab-size:" + (opts.tabSize || 4);
      var currentLine = document.createElement("div");
      currentLine.className = "dg-current-line";
      currentLine.style.cssText = "position:absolute;left:0;right:0;height:" + (opts.lineHeight || 20) + "px;background:" + (themeName === "light" ? "rgba(160,95,28,.07)" : "rgba(201,143,69,.08)") + ";pointer-events:none";
      wrap.appendChild(pre);
      wrap.appendChild(currentLine);
      wrap.appendChild(ta);
      root.appendChild(gutter);
      root.appendChild(wrap);
      host.appendChild(root);
      dom = { root: root, gutter: gutter, pre: pre, ta: ta, wrap: wrap, currentLine: currentLine };
      // 输入 → 模型 + 事件 + 重高亮(rAF 节流)
      ta.addEventListener("input", function () {
        if (!current) return;
        current._content = ta.value;
        scheduleRepaint();
        fire(listeners.content, {});
      });
      ta.addEventListener("scroll", function () {
        pre.scrollTop = ta.scrollTop;
        pre.style.transform = "translateY(" + (-ta.scrollTop) + "px)";
        pre.scrollLeft = ta.scrollLeft;
        pre.style.transform = "translate(" + (-ta.scrollLeft) + "px," + (-ta.scrollTop) + "px)";
        dom.currentLine.style.top = (8 + curLine() * (opts.lineHeight || 20) - ta.scrollTop) + "px";
      });
      function cursorFire() {
        var pos = caretPos();
        fire(listeners.cursor, { position: pos });
        fire(listeners.selection, {});
        dom.currentLine.style.top = (8 + pos.lineNumber * (opts.lineHeight || 20) - ta.scrollTop) + "px";
      }
      ta.addEventListener("keyup", cursorFire);
      ta.addEventListener("click", cursorFire);
      ta.addEventListener("select", cursorFire);
      if (opts.automaticLayout && typeof ResizeObserver === "function") {
        new ResizeObserver(function () { self.layout(); }).observe(host);
      }
    }

    function fire(arr, ev) { for (var i = 0; i < arr.length; i++) { try { arr[i](ev); } catch (e) { /* 监听器异常不炸编辑器 */ } } }

    function curLine() {
      if (!dom || !current) return 0;
      var upto = dom.ta.value.slice(0, dom.ta.selectionStart);
      return upto.split("\n").length - 1;
    }

    function caretPos() {
      if (!dom || !current) return { lineNumber: 1, column: 1 };
      var upto = dom.ta.value.slice(0, dom.ta.selectionStart);
      var nl = upto.split("\n");
      return { lineNumber: nl.length, column: nl[nl.length - 1].length + 1 };
    }

    function scheduleRepaint() {
      if (rafPending) return;
      rafPending = true;
      (typeof requestAnimationFrame === "function" ? requestAnimationFrame : function (f) { setTimeout(f, 16); })(function () {
        rafPending = false;
        repaint();
      });
    }

    function repaint() {
      if (!dom || !current) return;
      var content = current._content;
      var tokens = highlightLines(content, current.getLanguageId());
      var ls = content.split("\n");
      var palNow = pal();
      var html = "";
      for (var i = 0; i < ls.length; i++) {
        var spans = "";
        if (tokens) {
          for (var k = 0; k < tokens[i].length; k++) {
            var tk = tokens[i][k];
            spans += '<span style="color:' + (tk.cls ? palNow[tk.cls] || palNow.txt : palNow.txt) + '">' + xmlEsc(tk.text) + "</span>";
          }
        } else spans += xmlEsc(ls[i]);
        // 空行占位高度
        var deco = "";
        for (var d = 0; d < decorations.length; d++) {
          if (decorations[d].line === i + 1) deco += ' ' + decorations[d].className;
        }
        html += '<div class="view-line' + deco + '" style="min-height:' + (opts.lineHeight || 20) + 'px">' + spans + (spans ? "" : "&#8203;") + "</div>";
      }
      dom.pre.innerHTML = html;
      // 行号
      var g = "";
      for (var n = 1; n <= ls.length; n++) {
        var mark = "";
        var mk = markersByModel[uriKey(current.uri)];
        for (var mi = 0; mk && mi < mk.length; mi++) {
          if (mk[mi].lineNumber !== n) continue;
          var col = mk[mi].severity === 8 ? "#e06c5a" : mk[mi].severity === 4 ? "#d9a05b" : "#6b5c4a";
          mark += '<span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:' + col + ';margin-left:4px"></span>';
        }
        var decoN = "";
        for (var d2 = 0; d2 < decorations.length; d2++) {
          if (decorations[d2].line === n) decoN += ' ' + decorations[d2].className;
        }
        g += '<div class="line-numbers' + decoN + '"' + (decoN ? ' style="background:rgba(201,143,69,.14)"' : "") + ">" + n + mark + "</div>";
      }
      dom.gutter.innerHTML = g;
      dom.ta.readOnly = readOnly;
      dom.ta.wrap = wordWrap ? "soft" : "off";
      dom.pre.style.whiteSpace = wordWrap ? "pre-wrap" : "pre";
      dom.ta.style.whiteSpace = wordWrap ? "pre-wrap" : "pre";
      syncScroll();
    }

    function syncScroll() {
      if (!dom) return;
      dom.pre.style.transform = "translate(" + (-dom.ta.scrollLeft) + "px," + (-dom.ta.scrollTop) + "px)";
      dom.currentLine.style.top = (8 + curLine() * (opts.lineHeight || 20) - dom.ta.scrollTop) + "px";
    }

    // ---- 对外实例 API(Monaco 同形) ----
    this.getModel = function () { return current; };
    this.setModel = function (model) {
      current = model || null;
      if (dom) {
        dom.ta.value = current ? current._content : "";
        repaint();
        cursorFire();
      }
    };
    this.getValue = function () { return current ? current._content : ""; };
    this.setValue = function (v) {
      if (current) { current.setValue(v); }
      if (dom) dom.ta.value = current ? current._content : "";
      repaint();
      fire(listeners.content, {});
    };
    this.updateOptions = function (o) {
      if (!o) return;
      if (typeof o.readOnly === "boolean") readOnly = o.readOnly;
      if (o.wordWrap !== undefined) wordWrap = o.wordWrap === "on";
      if (dom) repaint();
    };
    this.layout = function () {
      if (!dom) return;
      repaint();
      syncScroll();
    };
    this.onDidChangeModelContent = function (cb) { listeners.content.push(cb); return { dispose: function () { var i = listeners.content.indexOf(cb); if (i >= 0) listeners.content.splice(i, 1); } }; };
    this.onDidChangeCursorPosition = function (cb) { listeners.cursor.push(cb); return { dispose: function () { var i = listeners.cursor.indexOf(cb); if (i >= 0) listeners.cursor.splice(i, 1); } }; };
    this.onDidChangeCursorSelection = function (cb) { listeners.selection.push(cb); return { dispose: function () { var i = listeners.selection.indexOf(cb); if (i >= 0) listeners.selection.splice(i, 1); } }; };
    this.revealLineInCenter = function (lineNumber) {
      if (!dom) return;
      var lh = opts.lineHeight || 20;
      var target = 8 + (lineNumber - 1) * lh - dom.ta.clientHeight / 2 + lh / 2;
      dom.ta.scrollTop = Math.max(0, target);
      syncScroll();
    };
    this.setSelection = function (range) {
      if (!dom || !range || !current) return;
      var ls = current._content.split("\n");
      var startOff = 0;
      for (var i = 0; i < range.startLineNumber - 1 && i < ls.length; i++) startOff += ls[i].length + 1;
      startOff += (range.startColumn || 1) - 1;
      var endOff = 0;
      for (var j = 0; j < range.endLineNumber - 1 && j < ls.length; j++) endOff += ls[j].length + 1;
      endOff += (range.endColumn || 1) - 1;
      dom.ta.focus();
      dom.ta.setSelectionRange(Math.min(startOff, endOff), Math.max(startOff, endOff));
      cursorFireSafe();
    };
    function cursorFireSafe() {
      var pos = caretPos();
      fire(listeners.cursor, { position: pos });
      fire(listeners.selection, {});
    }
    this.getSelection = function () {
      if (!dom || !current) return null;
      var ta = dom.ta;
      var ls = current._content.split("\n");
      function offToPos(off) {
        var upto = current._content.slice(0, off).split("\n");
        return { lineNumber: upto.length, column: upto[upto.length - 1].length + 1 };
      }
      var s = offToPos(ta.selectionStart), e = offToPos(ta.selectionEnd);
      return {
        startLineNumber: s.lineNumber, startColumn: s.column,
        endLineNumber: e.lineNumber, endColumn: e.column,
        isEmpty: function () { return ta.selectionStart === ta.selectionEnd; },
      };
    };
    this.deltaDecorations = function (oldIds, newDecorations) {
      decorations = [];
      var ids = [];
      for (var i = 0; i < (newDecorations || []).length; i++) {
        var d = newDecorations[i];
        decorations.push({ line: d.range && d.range.startLineNumber, className: d.options && d.options.className || "" });
        ids.push({ id: "dgdec-" + i });
      }
      repaint();
      return ids;
    };
    this.setModelMarkers = function (model, owner, markers) { setModelMarkers(model, owner, markers); };
    this.executeEdits = function (source, edits) {
      if (!dom || !current || !edits || !edits.length) return false;
      var ta = dom.ta, v = current._content;
      var last = edits[edits.length - 1];
      var r = last.range || {};
      if (r.startLineNumber === 1 && r.endLineNumber >= current.getLineCount()) {
        current._content = typeof last.text === "string" ? last.text : ta.value;
      } else {
        // 简化 splice:按偏移替换
        var ls = v.split("\n");
        var sOff = 0;
        for (var i = 0; i < r.startLineNumber - 1 && i < ls.length; i++) sOff += ls[i].length + 1;
        sOff += (r.startColumn || 1) - 1;
        var eOff = sOff;
        for (var j = r.startLineNumber; j <= r.endLineNumber && j <= ls.length; j++) eOff += (ls[j - 1] || "").length + (j < r.endLineNumber ? 1 : 0);
        eOff += (r.endColumn || 1) - 1;
        if (r.startLineNumber === r.endLineNumber) eOff = sOff + Math.max(0, (r.endColumn || 1) - (r.startColumn || 1));
        current._content = v.slice(0, sOff) + (typeof last.text === "string" ? last.text : "") + v.slice(eOff);
      }
      ta.value = current._content;
      repaint();
      fire(listeners.content, {});
      return true;
    };
    this.addCommand = function (mask, fn) {
      keybinds.push({ mask: mask || 0, fn: fn });
      return keybinds.length;
    };
    this.getAction = function (name) {
      if (name === "actions.find" || name === "editor.action.startFindReplaceAction") {
        return { run: function () { openFind(name === "editor.action.startFindReplaceAction"); return Promise.resolve(true); } };
      }
      return null; // quickOutline 等交面板兜底(自有正则大纲面板)
    };
    this.getOption = function () { return { tabSize: 4, insertSpaces: true }; };
    this.getEOL = function () { return "\n"; };
    this.dispose = function () {
      if (dom && dom.root.parentNode) dom.root.parentNode.removeChild(dom.root);
      dom = null; current = null;
    };
    this.__cursorFire = cursorFireSafe;
    this.__dom = function () { return dom; };

    // ---- 查找/替换小部件(自有;Ctrl+F/Ctrl+H 入口) ----
    var findBar = null;
    var keybinds = [];
    host.addEventListener("keydown", function (e) {
      var mods = (e.ctrlKey || e.metaKey ? 2048 : 0) | (e.shiftKey ? 1024 : 0) | (e.altKey ? 512 : 0);
      for (var i = 0; i < keybinds.length; i++) {
        var kb = keybinds[i];
        if ((kb.mask & 2048) && (e.ctrlKey || e.metaKey) && (kb.mask & 0xff) === e.keyCode) {
          e.preventDefault(); e.stopPropagation();
          kb.fn();
          return;
        }
      }
    }, true);
    // Escape 关找框(host 级)
    host.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && findBar && findBar.style.display !== "none") { findBar.style.display = "none"; }
    }, true);
    function openFind(withReplace) {
      if (!dom) return;
      if (findBar) { findBar.style.display = "flex"; var q = findBar.querySelector(".dg-find-q"); if (q) { q.focus(); q.select(); } return; }
      findBar = document.createElement("div");
      findBar.className = "dg-find";
      findBar.style.cssText = "position:absolute;top:0;right:12px;z-index:20;display:flex;gap:6px;align-items:center;padding:6px 8px;background:" + (themeName === "light" ? "#f3ead9" : "#181008") + ";border:1px solid " + (themeName === "light" ? "#d8c49a" : "#3a2c17") + ";border-radius:0 0 8px 8px;font-family:" + (opts.fontFamily || "ui-monospace, monospace") + ";font-size:12px;color:" + pal().txt;
      findBar.innerHTML =
        '<input class="dg-find-q" placeholder="查找…" style="width:180px;padding:3px 6px;background:transparent;border:1px solid #4a3a26;border-radius:4px;color:inherit;font:inherit">' +
        (withReplace ? '<input class="dg-find-r" placeholder="替换…" style="width:140px;padding:3px 6px;background:transparent;border:1px solid #4a3a26;border-radius:4px;color:inherit;font:inherit">' : "") +
        '<button class="dg-find-prev" style="padding:2px 8px;background:transparent;border:1px solid #4a3a26;border-radius:4px;color:inherit;cursor:pointer">↑</button>' +
        '<button class="dg-find-next" style="padding:2px 8px;background:transparent;border:1px solid #4a3a26;border-radius:4px;color:inherit;cursor:pointer">↓</button>' +
        (withReplace ? '<button class="dg-find-do" style="padding:2px 8px;background:transparent;border:1px solid #4a3a26;border-radius:4px;color:inherit;cursor:pointer">替换</button>' : "") +
        '<button class="dg-find-x" style="padding:2px 8px;background:transparent;border:1px solid #4a3a26;border-radius:4px;color:inherit;cursor:pointer">×</button>';
      dom.root.appendChild(findBar);
      var q = findBar.querySelector(".dg-find-q");
      var r = findBar.querySelector(".dg-find-r");
      function findNext(back) {
        if (!q.value) return;
        var v = current._content;
        var from = back ? dom.ta.selectionStart - 1 : dom.ta.selectionEnd;
        var idx;
        if (back) idx = v.lastIndexOf(q.value, Math.max(0, from - q.value.length));
        else idx = v.toLowerCase().indexOf(q.value.toLowerCase(), Math.max(0, from));
        if (idx === -1) idx = back ? v.lastIndexOf(q.value) : v.toLowerCase().indexOf(q.value.toLowerCase());
        if (idx === -1) return;
        dom.ta.focus();
        dom.ta.setSelectionRange(idx, idx + q.value.length);
        var line = current._content.slice(0, idx).split("\n").length;
        self.revealLineInCenter(line);
        cursorFireSafe();
      }
      findBar.querySelector(".dg-find-prev").onclick = function () { findNext(true); };
      findBar.querySelector(".dg-find-next").onclick = function () { findNext(false); };
      findBar.querySelector(".dg-find-x").onclick = function () { findBar.style.display = "none"; };
      q.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { findNext(e.shiftKey); e.preventDefault(); }
        if (e.key === "Escape") { findBar.style.display = "none"; e.preventDefault(); }
      });
      if (r) {
        r.addEventListener("keydown", function (e) { if (e.key === "Enter") { doReplace(); e.preventDefault(); } });
        findBar.querySelector(".dg-find-do").onclick = doReplace;
      }
      function doReplace() {
        if (!q.value || !r || !current) return;
        var v = current._content;
        var sel = dom.ta.value.slice(dom.ta.selectionStart, dom.ta.selectionEnd);
        if (sel.toLowerCase() === q.value.toLowerCase()) {
          var s = dom.ta.selectionStart, e2 = dom.ta.selectionEnd;
          current._content = v.slice(0, s) + r.value + v.slice(e2);
          dom.ta.value = current._content;
          dom.ta.setSelectionRange(s, s + r.value.length);
          repaint();
          fire(listeners.content, {});
        }
        findNext(false);
      }
      var seed = "";
      try {
        var sel = self.getSelection();
        var mdl = self.getModel();
        if (sel && mdl && !sel.isEmpty()) seed = mdl.getValueInRange(sel).split("\n")[0].slice(0, 120);
      } catch (e) { /* 选区种子失败不阻打开 */ }
      q.value = seed;
      q.focus(); q.select();
      // Ctrl+F/Ctrl+H 再次触发=聚焦回找框
      findBar.addEventListener("keydown", function (e) {
        if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "h")) { e.preventDefault(); q.focus(); q.select(); }
      });
    }

    function setModelMarkers(model, owner, markers) {
      markersByModel[uriKey(model && model.uri)] = (markers || []).map(function (m) {
        return { lineNumber: m.startLineNumber || m.lineNumber || 1, severity: m.severity || 8, message: m.message || "" };
      });
      repaint();
    }

    buildDom();
    this.__setModelMarkers = setModelMarkers;
    this.setTheme = function (name) {
      themeName = name === "vs" || name === "light" ? "light" : "dark";
      if (dom) {
        dom.root.classList.toggle("dg-light", themeName === "light");
        dom.root.classList.toggle("dg-dark", themeName === "dark");
        dom.ta.style.caretColor = themeName === "light" ? "#a05f1c" : "#c98f45";
        repaint();
      }
    };
  }

  // ------------------------------------------------------------------
  // Diff 编辑器(双栏;自有 LCS 行对齐)
  // ------------------------------------------------------------------
  function lcsRows(aLines, bLines) {
    var n = aLines.length, m = bLines.length;
    // 大文件防护:超 4000 行退化为顺序对齐(不找公共子序列)
    if (n * m > 16e6) {
      var rows0 = [];
      var max0 = Math.max(n, m);
      for (var q = 0; q < max0; q++) rows0.push({ a: q < n ? q : -1, b: q < m ? q : -1, state: q < n && q < m && aLines[q] === bLines[q] ? "same" : "chg" });
      return rows0;
    }
    var dp = [];
    for (var i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
    for (var ii = n - 1; ii >= 0; ii--) {
      for (var jj = m - 1; jj >= 0; jj--) {
        dp[ii][jj] = aLines[ii] === bLines[jj] ? dp[ii + 1][jj + 1] + 1 : Math.max(dp[ii + 1][jj], dp[ii][jj + 1]);
      }
    }
    var rows = [];
    var x = 0, y = 0;
    while (x < n && y < m) {
      if (aLines[x] === bLines[y]) { rows.push({ a: x, b: y, state: "same" }); x++; y++; }
      else if (dp[x + 1][y] >= dp[x][y + 1]) { rows.push({ a: x, b: -1, state: "del" }); x++; }
      else { rows.push({ a: -1, b: y, state: "add" }); y++; }
    }
    while (x < n) { rows.push({ a: x, b: -1, state: "del" }); x++; }
    while (y < m) { rows.push({ a: -1, b: y, state: "add" }); y++; }
    return rows;
  }

  function createDiffEditor(hostEl, opts) {
    opts = opts || {};
    hostEl.style.display = "flex";
    hostEl.style.gap = "8px";
    var panes = [];
    for (var side = 0; side < 2; side++) {
      var pane = document.createElement("div");
      pane.style.cssText = "flex:1 1 0;overflow:auto;position:relative";
      var pre = document.createElement("pre");
      pre.className = "view-lines dg-diff-pane";
      pre.style.cssText = "margin:0;padding:8px;font-family:" + (opts.fontFamily || "ui-monospace, monospace") + ";font-size:" + (opts.fontSize || 12.5) + "px;line-height:" + (opts.lineHeight || 20) + "px;white-space:pre;color:" + pal().txt;
      pane.appendChild(pre);
      hostEl.appendChild(pane);
      panes.push(pre);
    }
    function esc(s) { return xmlEsc(s); }
    function render(ORIGINAL, MODIFIED) {
      var aText = ORIGINAL && ORIGINAL.__dgModel ? ORIGINAL.getValue() : String(ORIGINAL || "");
      var bText = MODIFIED && MODIFIED.__dgModel ? MODIFIED.getValue() : String(MODIFIED || "");
      var rows = lcsRows(aText.split("\n"), bText.split("\n"));
      var htmlA = "", htmlB = "";
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (r.state === "same") {
          htmlA += '<div class="view-line">' + esc(aText.split("\n")[r.a]) + "</div>";
          htmlB += '<div class="view-line">' + esc(bText.split("\n")[r.b]) + "</div>";
        } else if (r.state === "del") {
          htmlA += '<div class="view-line" style="background:rgba(224,108,90,.14)">' + esc(aText.split("\n")[r.a]) + "</div>";
          htmlB += '<div class="view-line" style="background:rgba(224,108,90,.05)">&#8203;</div>';
        } else {
          htmlA += '<div class="view-line" style="background:rgba(224,108,90,.05)">&#8203;</div>';
          htmlB += '<div class="view-line" style="background:rgba(126,201,143,.14)">' + esc(bText.split("\n")[r.b]) + "</div>";
        }
      }
      panes[0].innerHTML = htmlA || "&#8203;";
      panes[1].innerHTML = htmlB || "&#8203;";
    }
    return {
      setModel: function (m) { render(m && m.original, m && m.modified); },
      layout: function () { /* 自适应容器,无需额外计算 */ },
      updateOptions: function () {},
    };
  }

  // ------------------------------------------------------------------
  // monaco 同形命名空间
  // ------------------------------------------------------------------
  var monacoNs = {
    Uri: { file: makeUri, parse: makeUri },
    Range: Range,
    KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512, WinCtrl: 256 },
    KeyCode: { KeyF: 70, KeyH: 72, Escape: 27, Enter: 13, Tab: 9 },
    editor: {
      create: function (host, opts) { var ed = new EditorInstance(host, opts); if (typeof opts.theme === "string") ed.setTheme(opts.theme === "vs" || opts.theme === "light" ? "light" : "dark"); return ed; },
      createModel: function (content, language, uri) { return makeModel(content, language, uri); },
      getModel: function (uri) { return modelRegistry[uriKey(uri)] || null; },
      getModels: function () { var out = []; for (var k in modelRegistry) out.push(modelRegistry[k]); return out; },
      setModelMarkers: function (model, owner, markers) {
        // 模型级标记:登记后由对应实例 repaint(实例不可达时仅登记,挂载后可见)
        if (model) model.__markers = markers || [];
        for (var k in liveEditors) if (liveEditors[k].getModel() === model) liveEditors[k].__setModelMarkers(model, owner, markers);
      },
      defineTheme: function () { /* 渲染主题走 CSS 调色板,接受不处理 */ },
      setTheme: function (name) {
        themeName = name === "vs" || name === "light" ? "light" : "dark";
        for (var k in liveEditors) liveEditors[k].setTheme(name);
      },
      createDiffEditor: function (hostEl, opts) { return createDiffEditor(hostEl, opts); },
    },
  };
  var liveEditors = {};

  // create 包一层:登记活实例(setModelMarkers 转发需要)
  var origCreate = monacoNs.editor.create;
  monacoNs.editor.create = function (host, opts) {
    var ed = origCreate(host, opts);
    liveEditors[String(Math.random())] = ed;
    return ed;
  };

  return monacoNs;
});
