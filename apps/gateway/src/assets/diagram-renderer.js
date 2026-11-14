/**
 * diagram-renderer.js — 自有图渲染器(零第三方依赖;纯函数核心,无 DOM 必要性)。
 * 支持语法子集(与仓内全部生成器的输出一一对应):
 *  - flowchart TD|LR / graph LR:节点四形(矩形/胶囊/菱形/双圆)、边(-->)、虚线边(-.->)、
 *    无向线(---)、边标签 |x|、嵌套 subgraph、classDef/class/style/linkStyle、
 *    %%{init:...}%% 头与 %% 注释行(容忍跳过)。
 *  - sequenceDiagram:participant X as 名、A->>B: 文本(含 A-->>B 虚线、自环)、Note over X: 文本。
 *  - stateDiagram-v2:状态转移 + ": 触发器"标签([*] 起止胶囊)。
 * 已知简化:subgraph 内 direction 语句忽略(以全局布局方向为准);超出子集的语法抛错,
 * 由调用方按既有契约降级为源码 <pre> 展示。
 * 入口:
 *  - render(id, src) → Promise<{svg: 字符串}>(与 mermaid.render 回执同形)
 *  - run({nodes:[el,...]}) → Promise(逐节点渲染 el.textContent/data-src 源,失败整体抛错)
 *  - configure({theme:"light"|"dark"}) → Promise(切换调色板,已渲染 SVG 不重刷)
 * 节点分组输出 <g class="node" id="<节点id>">,面板的点击下钻(g.node + id 匹配)无需改动。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.OwnDiagram = factory();
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  // ------------------------------------------------------------------
  // 主题调色板(明/暗;与面板 bronze/amber 色系一致)
  // ------------------------------------------------------------------
  var THEMES = {
    light: {
      nodeBg: "#efe6d6", nodeStroke: "#b07830", nodeFg: "#2a1c0e",
      edge: "#b07830", edgeLabelBg: "#faf6ee", edgeLabelFg: "#4a3213",
      subBg: "#f3ead9", subStroke: "#d8c49a", subFg: "#6b5327",
      dashed: "#a98553",
    },
    dark: {
      nodeBg: "#1a120a", nodeStroke: "#c98f45", nodeFg: "#e6d9bf",
      edge: "#c98f45", edgeLabelBg: "#0b0806", edgeLabelFg: "#d9c9a4",
      subBg: "#140d06", subStroke: "#3a2c17", subFg: "#b99c68",
      dashed: "#8a6d3a",
    },
  };
  var FONT_SIZE = 12.5;
  var FONT_FAMILY = "ui-sans-serif, system-ui, 'PingFang SC', 'Microsoft YaHei', sans-serif";
  var LINE_H = 17;
  var PAD_X = 12, PAD_Y = 9;
  var RANK_GAP = 46, SIB_GAP = 26;
  var theme = "dark";

  function palette() { return THEMES[theme] || THEMES.dark; }

  function configure(opts) {
    try {
      if (opts && (opts.theme === "light" || opts.theme === "dark")) theme = opts.theme;
      return Promise.resolve(true);
    } catch (e) { return Promise.reject(e); }
  }

  // ------------------------------------------------------------------
  // 文本工具
  // ------------------------------------------------------------------
  function unescapeLabel(s) {
    // 生成器侧实体与 mermaid 风格 #xx; 实体统一还原为原始字符
    return String(s)
      .replace(/#quot;/g, '"').replace(/#39;/g, "'")
      .replace(/#91;/g, "[").replace(/#93;/g, "]")
      .replace(/#35;/g, "#").replace(/#62;/g, ">").replace(/#60;/g, "<")
      .replace(/&#(\d+);/g, function (_, n) { return String.fromCodePoint(Number(n)); })
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
  }

  function xmlEsc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /** 标签 → 渲染行数组 [{text, italic}](`<br/>` 分行,`<i>` 段标记斜体)。 */
  function labelLines(label) {
    var raw = unescapeLabel(label || "");
    var chunks = raw.split(/<br\s*\/?>/i);
    var out = [];
    for (var c = 0; c < chunks.length; c++) {
      var italic = false, buf = "";
      var parts = chunks[c].split(/(<\/?i>)/i);
      for (var p = 0; p < parts.length; p++) {
        var piece = parts[p];
        if (/^<i>$/i.test(piece)) { italic = true; continue; }
        if (/^<\/i>$/i.test(piece)) { italic = false; continue; }
        if (!piece) continue;
        if (italic) {
          if (buf) { out.push({ text: buf, italic: false }); buf = ""; }
          out.push({ text: piece, italic: true });
        } else buf += piece;
      }
      if (buf) out.push({ text: buf, italic: false });
    }
    return out.length ? out : [{ text: "", italic: false }];
  }

  function isCjk(cp) {
    return (cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0x20000 && cp <= 0x2fa1f);
  }

  function textWidth(lines) {
    var w = 0;
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].text, lw = 0;
      for (var j = 0; j < t.length; j++) {
        var cp = t.codePointAt(j);
        if (cp > 0xffff) j++;
        lw += isCjk(cp) ? FONT_SIZE : FONT_SIZE * 0.52;
      }
      if (lw > w) w = lw;
    }
    return w;
  }

  // ------------------------------------------------------------------
  // 解析器:flowchart / graph
  // ------------------------------------------------------------------
  function parseAttrs(s) {
    var out = {};
    var segs = String(s).split(",");
    for (var i = 0; i < segs.length; i++) {
      var kv = segs[i].split(":");
      if (kv.length >= 2) out[kv[0].trim()] = kv.slice(1).join(":").trim();
    }
    return out;
  }

  /** 节点 token:id + 可选形状包裹的标签 + 可选 :::cls 简写。返回 {id,label,shape,cls} 或 null。 */
  function parseNodeToken(tok) {
    tok = tok.trim();
    if (!tok) return null;
    var shorthand = [];
    var sm = tok.match(/:::([A-Za-z0-9_\-]+)\s*$/);
    if (sm) { shorthand.push(sm[1]); tok = tok.slice(0, sm.index).trim(); }
    var m = tok.match(/^([A-Za-z0-9_.\-]+)([\s\S]*)$/);
    if (!m) return null;
    var id = m[1], tail = m[2].trim();
    if (!tail) return { id: id, label: "", shape: "rect", cls: shorthand };
    var shape = "rect", label = "";
    var mm;
    if ((mm = tail.match(/^\(\(([\s\S]*)\)\)$/))) { shape = "circle"; label = mm[1]; }
    else if ((mm = tail.match(/^\{([\s\S]*)\}$/))) { shape = "diamond"; label = mm[1]; }
    else if ((mm = tail.match(/^\(\[([\s\S]*)\]\)$/))) { shape = "stadium"; label = mm[1]; }
    else if ((mm = tail.match(/^\[\[([\s\S]*)\]\]$/))) { shape = "subroutine"; label = mm[1]; }
    else if ((mm = tail.match(/^\[([\s\S]*)\]$/))) { label = mm[1]; }
    else if ((mm = tail.match(/^\(([\s\S]*)\)$/))) { shape = "stadium"; label = mm[1]; }
    else return null;
    label = label.replace(/^["']|["']$/g, "");
    return { id: id, label: label, shape: shape, cls: shorthand };
  }

  function parseFlow(src) {
    var direction = /(^|\n)\s*(flowchart|graph)\s+TD\b/.test(src) ? "TD" : "LR";
    var nodes = {};        // id -> {id,label,shape,cls:[],style:{}}
    var order = [];        // 出现顺序
    var edges = [];        // {from,to,label,dashed,line}
    var subgraphs = [];    // {id,title,order:[]}
    var stack = [];        // subgraph 栈
    var classDefs = {};
    var nodeStyles = {};
    var linkStyles = {};
    var edgeIndex = 0;

    function nodeOf(id, label, shape, cls) {
      if (!nodes[id]) {
        nodes[id] = { id: id, label: label || id, shape: shape || "rect", cls: (cls || []).slice(), style: {} };
        order.push(id);
      } else {
        if (label) nodes[id].label = label;
        if (shape && shape !== "rect") nodes[id].shape = shape;
        if (cls) for (var c = 0; c < cls.length; c++) if (nodes[id].cls.indexOf(cls[c]) === -1) nodes[id].cls.push(cls[c]);
      }
      if (stack.length) {
        var top = stack[stack.length - 1];
        if (top.order.indexOf(id) === -1) top.order.push(id);
      }
      return nodes[id];
    }

    function parseEdgeStatement(line) {
      var parts = line.split(/\s*(-->|-\.->|---)\s*/);
      if (parts.length < 3) return false;
      var prev = parseNodeToken(parts[0]);
      if (!prev) return false;
      nodeOf(prev.id, prev.label, prev.shape, prev.cls);
      for (var pi = 1; pi + 1 < parts.length; pi += 2) {
        var op = parts[pi];
        var label = "";
        var after = parts[pi + 1];
        var lm = after.match(/^\|([^|]*)\|\s*/);
        if (lm) { label = lm[1]; after = after.slice(lm[0].length); }
        var next = parseNodeToken(after);
        if (!next) return false;
        nodeOf(next.id, next.label, next.shape, next.cls);
        edges.push({ from: prev.id, to: next.id, label: unescapeLabel(label), dashed: op === "-.->", line: edgeIndex++ });
        prev = next;
      }
      return true;
    }

    var lines = src.split(/\r?\n/);
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li].trim().replace(/;\s*$/, "");
      if (!line) continue;
      if (/^%%/.test(line)) continue;                                        // init 指令与注释行
      if (/^(flowchart|graph)\s+(TD|LR|TB|RL|BT|DT)\b/.test(line)) continue; // 头
      if (/^end$/i.test(line)) { if (stack.length) stack.pop(); continue; }
      var sg = line.match(/^subgraph\s+([A-Za-z0-9_.\-]+)(?:\[([\s\S]*)\])?$/);
      if (sg) {
        stack.push({ id: sg[1], title: (sg[2] || sg[1]).replace(/^["']|["']$/g, ""), order: [] });
        subgraphs.push(stack[stack.length - 1]);
        continue;
      }
      if (/^direction\s+(TB|LR|RL|BT)\b/i.test(line)) continue; // 子图方向:忽略(全局为准)
      var cd = line.match(/^classDef\s+([A-Za-z0-9_\-]+)\s+([\s\S]+)$/);
      if (cd) { classDefs[cd[1]] = parseAttrs(cd[2]); continue; }
      var clsM = line.match(/^class\s+([A-Za-z0-9_,\s]+?)\s+([A-Za-z0-9_\-]+)$/);
      if (clsM) {
        var ids = clsM[1].split(",").map(function (s) { return s.trim(); }).filter(Boolean);
        for (var ci = 0; ci < ids.length; ci++) if (nodes[ids[ci]]) nodes[ids[ci]].cls.push(clsM[2]);
        continue;
      }
      var styM = line.match(/^style\s+([A-Za-z0-9_\-]+)\s+([\s\S]+)$/);
      if (styM) { nodeStyles[styM[1]] = parseAttrs(styM[2]); continue; }
      var lsM = line.match(/^linkStyle\s+([\d,\s]+?)\s+([\s\S]+)$/);
      if (lsM) {
        var idxs = lsM[1].split(",").map(function (s) { return parseInt(s.trim(), 10); }).filter(function (n) { return !isNaN(n); });
        for (var xi = 0; xi < idxs.length; xi++) linkStyles[idxs[xi]] = parseAttrs(lsM[2]);
        continue;
      }
      if (parseEdgeStatement(line)) continue;
      var lone = parseNodeToken(line);
      if (lone) { nodeOf(lone.id, lone.label, lone.shape, lone.cls); continue; }
      throw new Error("diagram-renderer: unparsable flowchart line " + (li + 1) + ": " + line.slice(0, 60));
    }

    if (!order.length) throw new Error("diagram-renderer: no nodes");
    return { kind: "flow", direction: direction, nodes: nodes, order: order, edges: edges, subgraphs: subgraphs, classDefs: classDefs, nodeStyles: nodeStyles, linkStyles: linkStyles };
  }

  // ------------------------------------------------------------------
  // 解析器:sequenceDiagram
  // ------------------------------------------------------------------
  function parseSequence(src) {
    var participants = [];
    var pmap = {};
    var messages = [];
    var notes = [];
    function person(id, name) {
      if (!pmap[id]) { pmap[id] = { id: id, name: name || id }; participants.push(pmap[id]); }
      else if (name) pmap[id].name = name;
      return pmap[id];
    }
    var lines = src.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim().replace(/;\s*$/, "");
      if (!line || /^%%/.test(line)) continue;
      if (/^sequenceDiagram\b/.test(line)) continue;
      var pm = line.match(/^participant\s+([A-Za-z0-9_.\-]+)(?:\s+as\s+([\s\S]+))?$/i);
      if (pm) { person(pm[1], pm[2]); continue; }
      var mm = line.match(/^([A-Za-z0-9_.\-]*?)\s*(-->>|->>)\s*([A-Za-z0-9_.\-]+)\s*:\s*([\s\S]+)$/);
      if (mm) {
        if (!mm[1]) throw new Error("diagram-renderer: empty message source");
        person(mm[1]); person(mm[3]);
        messages.push({ from: mm[1], to: mm[3], text: unescapeLabel(mm[4]), dashed: mm[2] === "-->>" });
        continue;
      }
      var nm = line.match(/^Note\s+over\s+([A-Za-z0-9_.\-]+)(?:\s*,\s*([A-Za-z0-9_.\-]+))?\s*:\s*([\s\S]+)$/i);
      if (nm) {
        var over = [nm[1]];
        if (nm[2]) over.push(nm[2]);
        for (var n = 0; n < over.length; n++) person(over[n]);
        notes.push({ over: over, text: unescapeLabel(nm[3]) });
        continue;
      }
      throw new Error("diagram-renderer: unparsable sequence line " + (i + 1) + ": " + line.slice(0, 60));
    }
    if (!participants.length) throw new Error("diagram-renderer: no participants");
    return { kind: "sequence", participants: participants, messages: messages, notes: notes };
  }

  // ------------------------------------------------------------------
  // 解析器:stateDiagram-v2
  // ------------------------------------------------------------------
  function parseState(src) {
    var nodes = {}, order = [], edges = [];
    function nodeOf(id) {
      if (!nodes[id]) {
        var pseudo = id === "start" || id === "end";
        nodes[id] = { id: id, label: pseudo ? "" : id, shape: pseudo ? "stadium" : "rect", cls: [], style: {} };
        order.push(id);
      }
      return nodes[id];
    }
    var lines = src.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim().replace(/;\s*$/, "");
      if (!line || /^%%/.test(line)) continue;
      if (/^stateDiagram-v2\b/.test(line)) continue;
      if (/^direction\s/.test(line)) continue;
      var em = line.match(/^(\S+)\s*-->\s*(\S+)(?:\s*:\s*([\s\S]+))?$/);
      if (em) {
        var a = em[1] === "[*]" ? "start" : em[1];
        var b = em[2] === "[*]" ? "end" : em[2];
        nodeOf(a); nodeOf(b);
        edges.push({ from: a, to: b, label: em[3] ? unescapeLabel(em[3]) : "", dashed: false, line: edges.length });
        continue;
      }
      throw new Error("diagram-renderer: unparsable state line " + (i + 1) + ": " + line.slice(0, 60));
    }
    if (!order.length) throw new Error("diagram-renderer: no states");
    return { kind: "flow", direction: "TD", nodes: nodes, order: order, edges: edges, subgraphs: [], classDefs: {}, nodeStyles: {}, linkStyles: {} };
  }

  function parse(src) {
    var s = String(src || "");
    if (/sequenceDiagram\b/.test(s)) return parseSequence(s);
    if (/stateDiagram-v2\b/.test(s)) return parseState(s);
    if (/(^|\n)\s*(flowchart|graph)\b/.test(s)) return parseFlow(s);
    throw new Error("diagram-renderer: unsupported diagram type");
  }

  // ------------------------------------------------------------------
  // 布局:分层(TD=自上而下 / LR=自左而右)
  // ------------------------------------------------------------------
  function layoutFlow(doc) {
    var ids = doc.order, nodes = doc.nodes, edges = doc.edges;
    // 1. 分层:距最近源(无前驱节点)的最长路径(回边截断)
    var layer = {};
    function depth(id, trail) {
      if (layer[id] !== undefined) return layer[id];
      if (trail[id]) return 0;
      trail[id] = true;
      var best = -1; // 无前驱 = 源层 0
      for (var i = 0; i < edges.length; i++) {
        if (edges[i].to !== id) continue;
        var d = depth(edges[i].from, trail) + 1;
        if (d > best) best = d;
      }
      delete trail[id];
      layer[id] = best < 0 ? 0 : best;
      return layer[id];
    }
    var maxLayer = -1;
    for (var i0 = 0; i0 < ids.length; i0++) {
      depth(ids[i0], {});
      if (layer[ids[i0]] > maxLayer) maxLayer = layer[ids[i0]];
    }
    var layers = [];
    for (var L = 0; L <= maxLayer; L++) layers.push([]);
    for (var i1 = 0; i1 < ids.length; i1++) layers[layer[ids[i1]]].push(ids[i1]);
    // 2. 尺寸
    var boxes = {};
    for (var i2 = 0; i2 < ids.length; i2++) boxes[ids[i2]] = nodeBox(nodes[ids[i2]]);
    // 3. 同层排序:前驱 barycenter(两轮)
    for (var sweep = 0; sweep < 2; sweep++) {
      for (var li = 0; li < layers.length; li++) {
        layers[li].sort(function (a, b) { return bary(a) - bary(b); });
      }
    }
    function bary(id) {
      var sum = 0, cnt = 0, my = layer[id];
      for (var e = 0; e < edges.length; e++) {
        var other = null;
        if (edges[e].to === id && layer[edges[e].from] < my) other = edges[e].from;
        else if (edges[e].from === id && layer[edges[e].to] < my) other = edges[e].to;
        if (other === null) continue;
        var arr = layers[layer[other]];
        var idx = arr.indexOf(other);
        if (idx >= 0) { sum += idx; cnt++; }
      }
      return cnt ? sum / cnt : 0;
    }
    // 4. 坐标
    var depthCursor = PAD_Y, maxCross = 0;
    for (var li2 = 0; li2 < layers.length; li2++) {
      var row = layers[li2], across = PAD_X, rowCross = 0;
      for (var k = 0; k < row.length; k++) {
        var b = boxes[row[k]];
        if (doc.direction === "TD") {
          b.x = across; b.y = depthCursor;
          across += b.w + SIB_GAP;
          if (b.h > rowCross) rowCross = b.h;
        } else {
          b.x = depthCursor; b.y = across;
          across += b.h + SIB_GAP;
          if (b.w > rowCross) rowCross = b.w;
        }
      }
      if (across - SIB_GAP > maxCross) maxCross = across - SIB_GAP;
      depthCursor += rowCross + RANK_GAP;
    }
    // 5. 汇总
    var maxW = 0, maxH = 0;
    for (var id3 in boxes) {
      var bb = boxes[id3];
      if (bb.x + bb.w > maxW) maxW = bb.x + bb.w;
      if (bb.y + bb.h > maxH) maxH = bb.y + bb.h;
    }
    return { boxes: boxes, width: maxW + PAD_X, height: maxH + PAD_Y };
  }

  function nodeBox(node) {
    var lines = labelLines(node.label);
    var tw = textWidth(lines);
    var h = Math.max(LINE_H * lines.length + PAD_Y * 2, 34);
    var w = Math.max(tw + PAD_X * 2, 56);
    if (node.shape === "diamond") { w += 34; h += 26; }
    if (node.shape === "circle") { var s = Math.max(w, h); w = s; h = s; }
    return { w: w, h: h, lines: lines, shape: node.shape };
  }

  // ------------------------------------------------------------------
  // 布局:sequence(列式参与者)
  // ------------------------------------------------------------------
  function layoutSequence(doc) {
    var xs = [];
    var gap = 36;
    var x = PAD_X + 30;
    var widths = {};
    for (var i = 0; i < doc.participants.length; i++) {
      var p = doc.participants[i];
      var lines = labelLines(p.name);
      var w = Math.max(textWidth(lines) + PAD_X * 2, 64);
      widths[p.id] = { w: w, lines: lines };
      xs.push({ id: p.id, cx: x + w / 2 });
      x += w + gap;
    }
    var cxOf = {};
    for (var j = 0; j < xs.length; j++) cxOf[xs[j].id] = xs[j].cx;
    var y = 44;
    var rows = [];
    for (var m = 0; m < doc.messages.length; m++) { rows.push({ type: "msg", msg: doc.messages[m], y: y }); y += 34; }
    for (var nt = 0; nt < doc.notes.length; nt++) { rows.push({ type: "note", note: doc.notes[nt], y: y }); y += 34; }
    return { xs: xs, cxOf: cxOf, widths: widths, rows: rows, height: y + 24, width: x - gap + PAD_X };
  }

  // ------------------------------------------------------------------
  // SVG 绘制
  // ------------------------------------------------------------------
  function styleOf(node, doc) {
    var pal = palette();
    var st = { fill: pal.nodeBg, stroke: pal.nodeStroke, "stroke-width": "1.2", color: pal.nodeFg };
    for (var c = 0; c < node.cls.length; c++) {
      var def = doc.classDefs[node.cls[c]];
      if (def) for (var k in def) st[k] = def[k];
    }
    var extra = doc.nodeStyles[node.id];
    if (extra) for (var k2 in extra) st[k2] = extra[k2];
    return st;
  }

  function shapeSvg(x, y, w, h, shape, st) {
    var sw = st["stroke-width"] || 1.2;
    if (shape === "diamond") {
      var pts = (x + w / 2) + "," + y + " " + (x + w) + "," + (y + h / 2) + " " + (x + w / 2) + "," + (y + h) + " " + x + "," + (y + h / 2);
      return '<polygon points="' + pts + '" fill="' + st.fill + '" stroke="' + st.stroke + '" stroke-width="' + sw + '"/>';
    }
    if (shape === "circle") {
      var r = Math.min(w, h) / 2;
      return '<circle cx="' + (x + w / 2) + '" cy="' + (y + h / 2) + '" r="' + r + '" fill="' + st.fill + '" stroke="' + st.stroke + '" stroke-width="' + sw + '"/>';
    }
    var rx = shape === "stadium" ? Math.min(h / 2, 16) : 6;
    return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + rx + '" fill="' + st.fill + '" stroke="' + st.stroke + '" stroke-width="' + sw + '"' +
      (st["stroke-dasharray"] ? ' stroke-dasharray="' + xmlEsc(st["stroke-dasharray"]) + '"' : "") + "/>";
  }

  function nodeTextSvg(cx, cy, lines, color, fontSize) {
    var fs = fontSize || FONT_SIZE;
    var startY = cy - ((lines.length - 1) * LINE_H) / 2 + fs * 0.35;
    var s = "";
    for (var i = 0; i < lines.length; i++) {
      s += '<text x="' + cx + '" y="' + (startY + i * LINE_H) + '" text-anchor="middle" font-size="' + fs +
        '" font-family="' + xmlEsc(FONT_FAMILY) + '" fill="' + color + '"' +
        (lines[i].italic ? ' font-style="italic"' : "") + ">" + xmlEsc(lines[i].text) + "</text>";
    }
    return s;
  }

  function edgePath(a, b, direction) {
    var dx = b.cx - a.cx, dy = b.cy - a.cy;
    function borderPt(box) {
      if (Math.abs(dx) * box.h > Math.abs(dy) * box.w) {
        var sx = dx > 0 ? 1 : -1;
        return { x: box.cx + sx * box.w / 2, y: box.cy + dy * (box.w / 2) / (dx || 1) };
      }
      var sy = dy > 0 ? 1 : -1;
      return { x: box.cx + dx * (box.h / 2) / (dy || 1), y: box.cy + sy * box.h / 2 };
    }
    var p1 = borderPt(a), p2 = borderPt(b);
    var d, mid;
    if (direction === "TD") {
      var my = (p1.y + p2.y) / 2;
      d = "M" + p1.x + "," + p1.y + " C" + p1.x + "," + my + " " + p2.x + "," + my + " " + p2.x + "," + p2.y;
      mid = { x: (p1.x + p2.x) / 2, y: my };
    } else {
      var mx = (p1.x + p2.x) / 2;
      d = "M" + p1.x + "," + p1.y + " C" + mx + "," + p1.y + " " + mx + "," + p2.y + " " + p2.x + "," + p2.y;
      mid = { x: mx, y: (p1.y + p2.y) / 2 };
    }
    return { d: d, mid: mid };
  }

  function arrowDefs() {
    var pal = palette();
    return '<defs><marker id="dg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="' + pal.edge + '"/></marker></defs>';
  }

  function renderFlow(doc) {
    var pal = palette();
    var lay = layoutFlow(doc);
    var boxes = lay.boxes;
    var w = Math.ceil(lay.width), h = Math.ceil(lay.height);
    var out = [];
    for (var s = 0; s < doc.subgraphs.length; s++) {
      var sg = doc.subgraphs[s];
      var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9, any = false;
      for (var g = 0; g < sg.order.length; g++) {
        var bb = boxes[sg.order[g]];
        if (!bb) continue;
        any = true;
        if (bb.x < minX) minX = bb.x;
        if (bb.y < minY) minY = bb.y;
        if (bb.x + bb.w > maxX) maxX = bb.x + bb.w;
        if (bb.y + bb.h > maxY) maxY = bb.y + bb.h;
      }
      if (!any) continue;
      out.push('<rect x="' + (minX - 10) + '" y="' + (minY - 24) + '" width="' + (maxX - minX + 20) + '" height="' + (maxY - minY + 34) +
        '" rx="8" fill="' + pal.subBg + '" stroke="' + pal.subStroke + '" stroke-width="1"/>');
      out.push('<text x="' + (minX - 2) + '" y="' + (minY - 8) + '" font-size="12" font-weight="600" font-family="' + xmlEsc(FONT_FAMILY) + '" fill="' + pal.subFg + '">' + xmlEsc(sg.title) + "</text>");
    }
    for (var e = 0; e < doc.edges.length; e++) {
      var ed = doc.edges[e];
      var A = boxes[ed.from], B = boxes[ed.to];
      if (!A || !B) continue;
      var A2 = { cx: A.x + A.w / 2, cy: A.y + A.h / 2, w: A.w, h: A.h };
      var B2 = { cx: B.x + B.w / 2, cy: B.y + B.h / 2, w: B.w, h: B.h };
      var path = edgePath(A2, B2, doc.direction);
      var st = doc.linkStyles[ed.line] || {};
      var color = st.stroke || (ed.dashed ? pal.dashed : pal.edge);
      out.push('<path d="' + path.d + '" fill="none" stroke="' + color + '" stroke-width="1.3"' +
        (ed.dashed || st["stroke-dasharray"] ? ' stroke-dasharray="5 4"' : "") + ' marker-end="url(#dg-arrow)"/>');
      if (ed.label) {
        var lines = labelLines(ed.label);
        var tw = textWidth(lines);
        out.push('<rect x="' + (path.mid.x - tw / 2 - 4) + '" y="' + (path.mid.y - LINE_H / 2 - 1) + '" width="' + (tw + 8) + '" height="' + LINE_H + '" fill="' + pal.edgeLabelBg + '" opacity="0.92"/>');
        out.push(nodeTextSvg(path.mid.x, path.mid.y, lines, st.color || pal.edgeLabelFg, 11.5));
      }
    }
    for (var id in boxes) {
      var bb2 = boxes[id];
      var node = doc.nodes[id];
      var st2 = styleOf(node, doc);
      out.push('<g class="node" id="' + xmlEsc(id) + '">');
      out.push(shapeSvg(bb2.x, bb2.y, bb2.w, bb2.h, bb2.shape, st2));
      out.push(nodeTextSvg(bb2.x + bb2.w / 2, bb2.y + bb2.h / 2, bb2.lines, st2.color || pal.nodeFg));
      out.push("</g>");
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + " " + h + '" width="' + w + '" height="' + h +
      '" class="dg-svg dg-flow dg-' + doc.direction.toLowerCase() + '">' + arrowDefs() + out.join("") + "</svg>";
  }

  function renderSequence(doc) {
    var pal = palette();
    var lay = layoutSequence(doc);
    var w = Math.ceil(lay.width), h = Math.ceil(lay.height);
    var out = [];
    for (var i = 0; i < lay.xs.length; i++) {
      var px = lay.xs[i];
      var ww = lay.widths[px.id];
      out.push('<g class="node" id="' + xmlEsc(px.id) + '">');
      out.push('<rect x="' + (px.cx - ww.w / 2) + '" y="8" width="' + ww.w + '" height="28" rx="6" fill="' + pal.nodeBg + '" stroke="' + pal.nodeStroke + '" stroke-width="1.2"/>');
      out.push(nodeTextSvg(px.cx, 22, ww.lines, pal.nodeFg));
      out.push("</g>");
      out.push('<line x1="' + px.cx + '" y1="36" x2="' + px.cx + '" y2="' + (h - 12) + '" stroke="' + pal.dashed + '" stroke-width="1" stroke-dasharray="4 4" opacity="0.7"/>');
    }
    for (var r = 0; r < lay.rows.length; r++) {
      var row = lay.rows[r];
      if (row.type === "msg") {
        var msg = row.msg;
        var x1 = lay.cxOf[msg.from], x2 = lay.cxOf[msg.to];
        var color = msg.dashed ? pal.dashed : pal.edge;
        if (msg.from === msg.to) {
          out.push('<path d="M' + x1 + "," + row.y + ' h26 a6,6 0 0 1 6,6 v8 a6,6 0 0 1 -6,6 h-20" fill="none" stroke="' + color + '" stroke-width="1.3" marker-end="url(#dg-arrow)"/>');
          out.push('<text x="' + (x1 + 40) + '" y="' + (row.y + 10) + '" font-size="11.5" font-family="' + xmlEsc(FONT_FAMILY) + '" fill="' + pal.edgeLabelFg + '">' + xmlEsc(msg.text) + "</text>");
        } else {
          var dir = x2 > x1 ? 1 : -1;
          out.push('<line x1="' + x1 + '" y1="' + row.y + '" x2="' + (x2 - dir * 8) + '" y2="' + row.y + '" stroke="' + color + '" stroke-width="1.3"' + (msg.dashed ? ' stroke-dasharray="5 4"' : "") + ' marker-end="url(#dg-arrow)"/>');
          out.push('<text x="' + ((x1 + x2) / 2) + '" y="' + (row.y - 5) + '" text-anchor="middle" font-size="11.5" font-family="' + xmlEsc(FONT_FAMILY) + '" fill="' + pal.edgeLabelFg + '">' + xmlEsc(msg.text) + "</text>");
        }
      } else {
        var note = row.note;
        var nx1 = lay.cxOf[note.over[0]], nx2 = lay.cxOf[note.over[note.over.length - 1]];
        if (nx2 < nx1) { var t = nx1; nx1 = nx2; nx2 = t; }
        var tw2 = textWidth(labelLines(note.text)) + 14;
        var cxm = (nx1 + nx2) / 2;
        var bx = Math.max(4, cxm - tw2 / 2), bw = Math.min(tw2, w - bx - 4);
        out.push('<rect x="' + bx + '" y="' + (row.y - 14) + '" width="' + bw + '" height="24" rx="4" fill="' + pal.subBg + '" stroke="' + pal.subStroke + '" stroke-width="1"/>');
        out.push('<text x="' + cxm + '" y="' + (row.y + 2) + '" text-anchor="middle" font-size="11.5" font-family="' + xmlEsc(FONT_FAMILY) + '" fill="' + pal.subFg + '">' + xmlEsc(note.text) + "</text>");
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + " " + h + '" width="' + w + '" height="' + h +
      '" class="dg-svg dg-sequence">' + arrowDefs() + out.join("") + "</svg>";
  }

  function renderSvg(src) {
    var doc = parse(src);
    if (doc.kind === "sequence") return renderSequence(doc);
    return renderFlow(doc);
  }

  /** 与 mermaid.render 同形:resolve {svg: 字符串},调用方 o.svg || o 的解构保持不变。 */
  function render(id, src) {
    try {
      return Promise.resolve({ svg: renderSvg(String(src || "")) });
    } catch (e) { return Promise.reject(e); }
  }

  function run(opts) {
    var nodes = (opts && opts.nodes) || [];
    try {
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var src = el.getAttribute("data-src") != null ? el.getAttribute("data-src") : el.textContent;
        el.innerHTML = renderSvg(String(src || ""));
        el.removeAttribute("data-mermaid-lazy");
        el.classList.add("dg-done");
      }
      return Promise.resolve(true);
    } catch (e) { return Promise.reject(e); }
  }

  return { render: render, run: run, configure: configure, _parse: parse, _renderSvg: renderSvg, _labelLines: labelLines };
});
