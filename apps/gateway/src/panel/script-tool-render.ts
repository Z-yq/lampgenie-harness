/**
 * 面板主脚本分片:script-tool-render(逐字自 panel.ts PAGE 模板搬移, 拆分)。
 * 模板约束沿袭:不得出现反引号与 ${;行内换行不得写裸转义。
 */
export const PANEL_JS_TOOL_RENDER = `// 工具调用卡(折叠+参数+结果;ZCode ToolCallBlocks 裁剪)
// fixH16(渲染官 H):旧 toolCard(裸名+raw 参数 JSON+「tool」徽标)退役——非分组工具全部走
// toolCallCard 统一合并卡(图标+动词+参数摘要+状态徽标+专属结果体);调用点:主循环/子代理工作区。
// 工具结果正文渲染( A:fc 返回乱码修复)。取证四源:①协议标签残留(只 esc 不清洗,闭合标签原样可见)
// ②终端控制字符(孤立 CR 进度覆盖行粘成一坨)③fc JSON 返回单行平铺不可读 ④超长 4000 硬截断无提示。
// 修法:cleanToolText 清洗→JSON 探测美化(代码块呈现)→4000 预览+原生 details「展开全文」(免 JS、重渲染存活)。
// (注释铁律再证:页面模板层注释里禁写反斜杠转义——本注释首版含 CR 转义符,被模板吃成真回车把注释截成裸语句。)
const TR_PREVIEW_CHARS = 4000, TR_CAP_CHARS = 40000, TR_JSON_DETECT_MAX = 200000;
function scrubCtrlChars(s) {
  var NL = String.fromCharCode(10), TAB = String.fromCharCode(9), CR = String.fromCharCode(13);
  var out = "";
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i), code = s.charCodeAt(i);
    if (c === CR) { if (s.charAt(i + 1) !== NL) out += NL; continue; } // 孤立 CR 转 LF(进度覆盖行变可读行);CRLF 只留 LF
    if (code === 127 || (code < 32 && c !== NL && c !== TAB)) continue; // 其余 C0/DEL 控制字符剔除
    out += c;
  }
  return out;
}
function cleanToolText(s) { return scrubCtrlChars(scrubProtocolLines(String(s || ""))); }
function prettyToolJson(txt) {
  var t = txt.trim();
  if (t.length === 0 || t.length > TR_JSON_DETECT_MAX) return null; // 超大串不 parse(主线程卡顿面)
  var c0 = t.charAt(0);
  if (c0 !== "{" && c0 !== "[") return null;
  try { return JSON.stringify(JSON.parse(t), null, 2); } catch (e) { return null; }
}
function toolResultCard(content, q, toks, name, argsRaw, detKey) {
  const raw = cleanToolText(content);
 // fixH19(渲染官 H):孤儿结果(调用卡缺席/子代理文本)带工具名时同样吃专属渲染;
 // 无名调用方(subagent.result 文本等)保持原通用形态,零变化。
  const inner = name ? toolResultBody(name, argsRaw, content, q, toks, false) : trGenericBody(raw, q, toks);
 // err 判定收窄(审计 R2 用户反馈:echo 回显的角色提示词中后部含「失败」字样被误判 err)——
 // 本仓工具真实错误都把标记放在结果开头(错误:…/[browser 失败]…),清洗后仍只看开头窗口。
  const isErr = name ? toolResIsErr(name, content) : /错误|失败|error/i.test(raw.trim().slice(0, 60));
  const m = name ? toolMetaOf(name) : null;
 // 折叠态 key:优先调用 id(跨重渲染稳定);无 id 退回「工具名+参数头」。
  const detK = "tool-res:" + (String(detKey || "") || (name || "") + ":" + String(argsRaw || "").slice(0, 80));
  return '<details class="tool-card' + (isErr ? " tc-fail" : "") + '" data-det-key="' + esc(detK) + '"><summary>' +
    '<span>' + ic("sub") + (m ? " " + esc(m.v) : "") + ' 结果</span><span class="tc-args">' + hl(esc(raw.slice(0, 60)), q) + '</span>' +
    '<span class="tc-state ' + (isErr ? "tc-err" : "tc-ok") + '">' + (isErr ? "err" : "ok") + '</span></summary>' +
    '<div class="tc-body">' + inner + '</div></details>';
}
// fixH9:通用结果正文(原 toolResultCard 主体抽离,专属渲染的兜底共用)——
// JSON 探测美化(代码块)/纯文本行块;超长 4000 预览+details 展开全文;read_file toks 语义着色保留。
// JSON 分支独立板色(is-json)+ 键/字符串/数值/布尔分色(jsonLineHtml),不再黑白一片。
const JSON_BS = String.fromCharCode(92), JSON_DQ = String.fromCharCode(34);
// 从起始引号位置找未转义的收尾引号(JSON.stringify 产物的 \" 转义要跳过)
function jsonStrEnd(s, i) {
  for (let j = i + 1; j < s.length; j++) {
    const c = s.charAt(j);
    if (c === JSON_BS) { j++; continue; }
    if (c === JSON_DQ) return j;
  }
  return -1;
}
// 单段值着色:字符串→js,数字→jn,true/false/null→jb,其余原样
function jsonValueHtml(s) {
  const t = String(s || "");
  if (!t) return "";
  const tr = t.trim();
  if (!tr) return esc(t);
  if (tr.charAt(0) === JSON_DQ) {
    const e = jsonStrEnd(t, t.indexOf(JSON_DQ));
    if (e > 0) return '<span class="js">' + esc(t.slice(0, e + 1)) + "</span>" + esc(t.slice(e + 1));
    return esc(t);
  }
  if (tr === "true," || tr === "false," || tr === "null," || tr === "true" || tr === "false" || tr === "null") return '<span class="jb">' + esc(t) + "</span>";
  const c0 = tr.charAt(0);
  if (c0 === "-" || (c0 >= "0" && c0 <= "9")) return '<span class="jn">' + esc(t) + "</span>";
  return esc(t);
}
// 单行 JSON 着色:缩进 + "key": + 值 三段;非键行按值/结构行处理
function jsonLineHtml(line) {
  const t = String(line);
  if (!t.trim()) return "&nbsp;";
  const qi = t.indexOf(JSON_DQ);
  if (qi >= 0 && t.slice(0, qi).trim() === "") {
    const e = jsonStrEnd(t, qi);
    if (e > 0) {
      const after = t.slice(e + 1);
      const colon = after.indexOf(":");
      if (colon >= 0 && after.slice(0, colon).trim() === "") {
        return esc(t.slice(0, qi)) + '<span class="jk">' + esc(t.slice(qi, e + 1)) + "</span>" +
          esc(after.slice(0, colon + 1)) + jsonValueHtml(after.slice(colon + 1));
      }
      return esc(t.slice(0, qi)) + '<span class="js">' + esc(t.slice(qi, e + 1)) + "</span>" + esc(after);
    }
  }
  return jsonValueHtml(t);
}
function jsonLinesBlock(txt) {
  const NL = String.fromCharCode(10);
  return '<div class="code-wrap is-json"><div class="code-bar"><span class="code-lang">json</span></div><pre class="code">' +
    txt.split(NL).map((l) => '<span class="cl">' + jsonLineHtml(l) + "</span>").join("") + "</pre></div>";
}
function trGenericBody(raw, q, toks) {
  const pretty = prettyToolJson(raw);
  const txt = pretty !== null ? pretty : raw;
  const NL = String.fromCharCode(10);
  let more = "";
  if (txt.length > TR_PREVIEW_CHARS) {
    const rest = txt.slice(TR_PREVIEW_CHARS, TR_CAP_CHARS);
    more = '<details class="tr-more"><summary>展开全文(共 ' + txt.length + " 字符" + (txt.length > TR_CAP_CHARS ? ",超出部分已截断" : "") + ')</summary><div class="tc-body tr-full">' + esc(rest) + "</div></details>";
  }
 // 纯文本正文统一代码块形态(与 JSON 分支/toolCard 同风格,不再裸 div)——
 // code-bar 行数头 + .cl 逐行块;行间裸换行在 tr-lines 容器(white-space:normal)折叠,HTML 内保留真实换行。
 // toks 在场=read_file 源码行块语义着色(JSON 美化分支不着色——美化文本非源码原文)。
  return pretty !== null
    ? jsonLinesBlock(txt)
    : citeText(codeLinesBlock(txt.slice(0, TR_PREVIEW_CHARS), q, 0, toks) + more);
}
// ---- fixH10:工具人话渲染层(渲染官 H)----
// 用户用户反馈「终端/工具结果没渲染效果;read_file 调用与结果没渲染效果」。统一框架:
// 调用卡=图标+人话动词+参数摘要+状态徽标(运行中/完成/失败·耗时);结果体=按工具专属结构呈现,
// 不再黑底 JSON 墙/纯文本平铺。全部零反斜杠(页面模板层纪律),解析失败逐级回落 trGenericBody。
const TOOL_META = {
  read_file: { v: "读取", i: "file" }, write_file: { v: "写入", i: "file" }, edit_file: { v: "编辑", i: "file" },
  grep: { v: "搜索", i: "search" }, glob: { v: "匹配", i: "search" }, list_dir: { v: "列目录", i: "folder" },
  run_cmd: { v: "执行", i: "run" }, terminal: { v: "终端", i: "run" },
  code_index: { v: "代码索引", i: "search" }, code_sense: { v: "代码感知", i: "search" }, code_review: { v: "代码评审", i: "check" },
  board_upsert: { v: "更新白板", i: "grid" }, board_read: { v: "读白板", i: "grid" }, todo_write: { v: "记录计划", i: "check" },
  spawn_subagent: { v: "派子代理", i: "sub" }, task_output: { v: "取回结果", i: "sub" }, answer_subagent: { v: "答复", i: "sub" },
  skill_view: { v: "查看技能", i: "file" }, experience_fold: { v: "沉淀经验", i: "file" }, session_search: { v: "检索会话", i: "search" },
  run_workflow: { v: "运行工作流", i: "play" }, web_search: { v: "网搜", i: "search" }, web_fetch: { v: "抓取网页", i: "arrow-right" },
  browser: { v: "浏览器", i: "arrow-right" }, task_phase: { v: "进入阶段", i: "check" },
};
function toolMetaOf(name) { return TOOL_META[String(name || "").toLowerCase()] || null; }
// 强制独立成卡的工具(有专属结果体,埋进探索/更改组会被折叠吞掉):catOf 命中也拆出来单卡渲染。
const TOOL_SOLO = { code_index: 1, code_sense: 1, code_review: 1, board_upsert: 1, board_read: 1, todo_write: 1 };
function toolSoloOf(name) { return !!TOOL_SOLO[String(name || "").toLowerCase()]; }
function parseArgs(raw) { try { return JSON.parse(String(raw || "{}")); } catch (e) { return null; } }
function firstLineOf(s) { return String(s || "").split(String.fromCharCode(10))[0] || ""; }
function clip(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n) + "…" : s; }
/** 消息构型速览(修复):llm.trace 行此前把 messageRoles 全量 join——一条 143 条消息的
 * 调用会渲成几十行 assistant→tool→…,整行被撑爆(用户用户反馈「路径渲染全失效」)。这里只放构型:
 * 连续同角色压成 a×N;段数超限保留头尾、中间省略;附总条数。全量只进 title。 */
function roleShape(arr, maxSeg) {
  const ab = { system: "s", user: "u", assistant: "a", tool: "t" };
  const list = Array.isArray(arr) ? arr : [];
  const segs = [];
  for (const x of list) {
    const r = ab[String(x)] || String(x);
    const last = segs[segs.length - 1];
    if (last && last.r === r) last.n++;
    else segs.push({ r: r, n: 1 });
  }
  const one = (x) => (x.n > 1 ? x.r + "×" + x.n : x.r);
  const cap = maxSeg || 6;
  const head = segs.length <= cap ? segs : segs.slice(0, Math.max(1, cap - 3));
  const tail = segs.length <= cap ? [] : segs.slice(-2);
  return (segs.length > cap ? head.map(one).join("→") + "→…→" + tail.map(one).join("→") : head.map(one).join("→")) +
    (list.length > cap ? " · " + list.length + " 条消息" : "");
}
// 参数摘要(人话):按工具取关键字段,失败回落旧口径(query/instructions/target/…)。header 只放一行。
function toolArgSum(name, argsRaw) {
  const n = String(name || "");
  const o = parseArgs(argsRaw);
  if (!o || typeof o !== "object") return String(argsRaw || "").slice(0, 90);
  const p = (k) => String(o[k] === undefined ? "" : o[k]);
  if (n === "read_file") {
    let s = p("path") || "(未指定路径)";
    const off = Number(o.offset) || 0, lim = Number(o.limit) || 0;
    if (off > 0 && lim > 0) s += " · 行 " + (off + 1) + "-" + (off + lim);
    else if (lim > 0) s += " · 前 " + lim + " 行";
    return s;
  }
  if (n === "write_file") { const c = String(o.content === undefined ? "" : o.content); return p("path") + " · " + c.length + " 字符"; }
  if (n === "edit_file") { return p("path") + (p("old_string") ? " · 替换 1 处" : ""); }
  if (n === "grep" || n === "glob") { return p("pattern") || p("glob") || p("path") || "(空)"; }
  if (n === "list_dir") return p("path") || ".";
  if (n === "run_cmd") return clip(p("command"), 90);
  if (n === "terminal") return clip(p("command") || (p("action") ? p("action") + (o.sessionId ? " · " + String(o.sessionId).slice(-8) : "") : ""), 90);
  if (n === "code_index") return p("action") + (p("target") ? " " + p("target") : "");
  if (n === "code_sense") return p("mode") + (p("query") ? " · " + clip(p("query"), 60) : "");
  if (n === "board_upsert") return clip(p("title") || (Array.isArray(o.nodes) ? o.nodes.length + " 节点" : ""), 60);
  if (n === "board_read") return clip(p("title"), 60);
  if (n === "todo_write") return (Array.isArray(o.items) ? o.items.length : "?") + " 项计划";
  if (n === "spawn_subagent") return clip(p("title") || p("agentType"), 70);
  if (n === "session_search") return clip(p("query") || p("action"), 70);
  if (n === "skill_view" || n === "experience_fold") return clip(p("name") || p("query") || p("category"), 70);
  if (n === "run_workflow") { const sc = String(o.script || ""); return sc ? "脚本 " + sc.split(String.fromCharCode(10)).length + " 行" : clip(p("name"), 60); }
  if (n === "web_fetch" || n === "web_search" || n === "browser") return clip(p("url") || p("query") || p("action"), 90);
  if (n === "code_review") return "本任务变更深审";
  if (n === "task_phase") {
 // 此前对话流只显「task_phase 完成」,阶段与 note 全丢——补成「进入阶段 · 规划 — xxx」。
 // 卡头动词已是「进入阶段」(TOOL_META),摘要里不再重复该词,只留阶段名与 note。
    const ph = p("phase") || "?";
    if (o.skip === true) return "不涉及 · " + (PHASE_CN[ph] || ph) + (p("note") ? " — " + clip(p("note"), 70) : "");
    return (PHASE_CN[ph] || ph) + (p("note") ? " — " + clip(p("note"), 70) : "");
  }
  const legacy = o.query || o.instructions || o.target || o.name || o.template;
  return clip(String(legacy || ""), 90);
}
// 错误判定:开头窗口(与既有 isErr 口径一致)+ run_cmd 退出码非零 + terminal JSON ok:false/exitCode!==0
// + 工具层拒绝(status:"rejected"/denied):plan-gate 拦下时的回执是 {"status":"rejected",...},
// 不以「错误」开头,旧口径判成「完成」→ 对话流里绿色「完成」盖住「其实没执行」。
// 零正则(页面模板层纪律:模板里写反斜杠会被吃,正则必碎)——按字段 JSON.parse 判定,解析不出再退字面量查找。
function gateRejectOf(content) {
  const t = String(content || "");
  if (t.indexOf("rejected") < 0 && t.indexOf("denied") < 0) return null;
  let o = null;
  try { o = JSON.parse(t); } catch (e) { o = null; }
  const st = o && typeof o === "object" ? String(o.status || "") : "";
  if (st === "rejected" || st === "denied") return { reason: String(o.reason || o.message || o.detail || "工具层拒绝") };
 // 非纯 JSON(前面带说明文字)时按字面量兜底:只认「"status" 紧跟 : 紧跟 "rejected/denied"」的紧邻形态
  if (t.indexOf('"status":"rejected"') >= 0 || t.indexOf('"status":"denied"') >= 0 ||
      t.indexOf('"status": "rejected"') >= 0 || t.indexOf('"status": "denied"') >= 0) return { reason: "工具层拒绝" };
  return null;
}
function toolResIsErr(name, content) {
  const t = String(content || "").trim();
  if (!t) return false;
  if (gateRejectOf(t)) return true;
  const head = t.slice(0, 60);
  if (head.indexOf("错误") === 0 || head.indexOf("失败") === 0 || head.indexOf("[browser 失败]") === 0) return true;
  const hu = head.toUpperCase();
  if (hu.indexOf("ERROR") === 0 || hu.indexOf("ERR:") === 0) return true;
  const n = String(name || "").toLowerCase();
  if (n === "run_cmd" && t.indexOf("(退出码非零") >= 0) return true;
  if (n === "terminal" || n === "run_workflow") {
    const o = parseArgs(t);
    if (o && typeof o === "object") {
      if (o.ok === false) return true;
      const ec = o.exitCode === undefined ? null : o.exitCode;
      if (ec !== null && ec !== 0) return true;
    }
  }
  return false;
}
function trChip(txt, cls, title) { return '<span class="tr-chip' + (cls ? " " + cls : "") + '"' + (title ? ' title="' + esc(title) + '"' : "") + ">" + txt + "</span>"; }
function trChipB(label, val) { return trChip(esc(label) + " <b>" + esc(String(val)) + "</b>"); }
// 行块预览+N 行截断(专属体通用):compact=组内 12 行,独立卡 40 行;超出走 tr-more 展开全文(免 JS)。
// opts 透传 codeLinesBlock(终端类输出=kind:'term' → 独立板色 + 行级调子 + 失败红板)。
/** 终端转轮动画帧折叠:tqdm/npm/构建器在管道里会吐几十上百帧「⠋⠙⠹⠸」单字符行,
 * 在聊天流里就是一片乱码点阵。连续 ≥3 帧折叠成一行注记(帧内容无信息量,只保留计数)。
 * 判定收窄:行首是盲文点阵字符(U+2800..U+28FF)且去掉盲文/空白后剩余 ≤4 字符(纯转轮帧)。
 * 去重(经验证缺陷:相邻行出现多个相同折叠注记,刷屏):
 * ① 空行分隔的帧流并段——转轮流里的空行无信息量,「帧-空行-帧」算同一段,不再各折各的;
 * ② 连续两个注记(中间只隔空行)合并为一个、帧数累加;
 * ③ 输入里已是注记的行同样走合并通道(重复折叠幂等:已折文本再折不增殖);
 * ④ 帧数按盲文字符数计——回车符把多帧拼进一行的原始流按实际帧数累计。 */
function foldTermFrames(txt) {
  const NL = String.fromCharCode(10);
  const TAG_HEAD = "（已折叠 ";
  const TAG_TAIL = " 帧转轮动画）";
  const lines = String(txt).split(NL);
  const isFrame = (l) => {
    const s = String(l).trim();
    if (!s) return false;
    const c0 = s.charCodeAt(0);
    if (c0 < 0x2800 || c0 > 0x28ff) return false;
    let rest = "";
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0x2800 && c <= 0x28ff) continue;
      rest += s.charAt(i);
    }
    return rest.trim().length <= 4;
  };
 // 一行里的帧数 = 盲文字符数(正常一帧一行=1;回车符把多帧拼进一行时按实际计)
  const frameCountOf = (l) => {
    let n = 0;
    for (let i = 0; i < l.length; i++) {
      const c = l.charCodeAt(i);
      if (c >= 0x2800 && c <= 0x28ff) n++;
    }
    return n;
  };
 // 已是折叠注记的行 → 帧数;不是注记 → -1(与「注记但计数非法」区分:都当 -1 处理)
  const tagCountOf = (l) => {
    const s = String(l);
    if (s.indexOf(TAG_HEAD) !== 0) return -1;
    const e = s.indexOf(TAG_TAIL, TAG_HEAD.length);
    if (e < 0) return -1;
    const n = Number(s.slice(TAG_HEAD.length, e));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : -1;
  };
 // 注记入栈:尾部已是注记(中间只隔空行)→ 合并累加并丢掉中间空行;否则原样追加
  const pushTag = (out, n) => {
    let k = out.length - 1;
    while (k >= 0 && out[k].trim() === "") k--;
    const prev = k >= 0 ? tagCountOf(out[k]) : -1;
    if (prev > 0) {
      out[k] = TAG_HEAD + (prev + n) + TAG_TAIL;
      out.length = k + 1;
      return;
    }
    out.push(TAG_HEAD + n + TAG_TAIL);
  };
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const tc = tagCountOf(lines[i]);
    if (tc > 0) { pushTag(out, tc); i++; continue; }
    if (!isFrame(lines[i])) { out.push(lines[i]); i++; continue; }
    let j = i, n = 0;
    while (j < lines.length) {
      const tj = tagCountOf(lines[j]);
      if (tj > 0) { n += tj; j++; continue; }
      if (isFrame(lines[j])) { n += frameCountOf(lines[j]); j++; continue; }
      if (lines[j].trim() === "") {
 // 前瞻:空行后仍是帧/注记 → 并入同一段(转轮流里的空行无信息量,是重复注记的根源)
        let k = j + 1;
        while (k < lines.length && lines[k].trim() === "") k++;
        if (k < lines.length && (tagCountOf(lines[k]) > 0 || isFrame(lines[k]))) { j = k; continue; }
      }
      break;
    }
    if (n >= 3) pushTag(out, n);
    else for (let k = i; k < j; k++) out.push(lines[k]);
    i = j;
  }
  return out.join(NL);
}
function trBlockPreview(txt, q, compact, opts) {
  const NL = String.fromCharCode(10);
  const cap = compact ? 12 : 40;
  const src = opts && opts.kind === "term" ? foldTermFrames(txt) : String(txt);
  const lines = String(src).split(NL);
  const shown = lines.slice(0, cap).join(NL);
  let more = "";
  if (lines.length > cap) {
    const rest = lines.slice(cap).join(NL).slice(0, TR_CAP_CHARS);
    more = '<details class="tr-more"><summary>展开全文(共 ' + lines.length + " 行" + (String(txt).length > TR_CAP_CHARS ? ",超出部分已截断" : "") + ')</summary><div class="tc-body tr-full">' + esc(rest) + "</div></details>";
  }
  return codeLinesBlock(shown, q, lines.length, null, opts) + more;
}
// fixH10a:read_file——路径 chip+行窗信息+既有语义着色行块(toks 链路原样保留)。
function trReadFile(argsRaw, txt, q, toks, compact) {
  const o = parseArgs(argsRaw) || {};
  const path = String(o.path || "");
  const NL = String.fromCharCode(10);
  const lines = String(txt).split(NL);
 // 尾行行号(结果自带 6 字符行号前缀+TAB;取最大可见行号做「读到第 N 行」徽标)
  let lastLn = 0;
  const TAB = String.fromCharCode(9);
  for (let i = lines.length - 1; i >= 0 && lastLn === 0; i--) {
    const l = lines[i] || "";
    if (l.length >= 7 && l.charAt(6) === TAB) {
      const num = Number(l.slice(0, 6).trim()); if (num > 0) lastLn = num;
    }
  }
  const cap = compact ? 14 : 40;
  let more = "";
  if (lines.length > cap) {
    const rest = lines.slice(cap).join(NL).slice(0, TR_CAP_CHARS);
    more = '<details class="tr-more"><summary>展开全部 ' + lines.length + ' 行</summary><div class="tc-body tr-full">' + esc(rest) + "</div></details>";
  }
  const chips = '<div class="tr-chips">' + (path ? trChip(ic("file") + " " + esc(path)) : "") + trChipB("行数", lines.length) + (lastLn ? trChipB("至行", lastLn) : "") + "</div>";
  return chips + codeLinesBlock(lines.slice(0, cap).join(NL), q, lines.length, toks) + more;
}
// fixH10b:edit_file——结果摘要 chip + old/new_string 迷你 diff(+/- 行计数徽标)+ 诊断块。
function trEditFile(argsRaw, txt, q, compact) {
  const NL = String.fromCharCode(10);
  const o = parseArgs(argsRaw) || {};
 // 诊断块剥离:<diagnostics …> 起到结尾,单独 warn 行呈现
  let diag = "", body = txt;
  const di = txt.indexOf("<diagnostics");
  if (di >= 0) { diag = txt.slice(di); body = txt.slice(0, di).trim(); }
  const headline = firstLineOf(body); // 已编辑 path:替换 N 处(A → B 字符)。
  const oldS = String(o.old_string || ""), newS = String(o.new_string || "");
  const ols = oldS.split(NL), nls = newS.split(NL); // fixH:提到 if 外(chips 的 +/- 计数在块外使用,块级 const 越界=ReferenceError)
  let diffHtml = "";
  if (oldS || newS) {
    const cap = compact ? 8 : 24; // 单侧行上限(组内更紧凑)
    let rows = "";
    for (let i = 0; i < ols.length && i < cap; i++) rows += '<span class="td-mrow del">- ' + hl(esc(ols[i]), q) + "</span>";
    for (let i = 0; i < nls.length && i < cap; i++) rows += '<span class="td-mrow add">+ ' + hl(esc(nls[i]), q) + "</span>";
    const over = (ols.length > cap ? ols.length - cap : 0) + (nls.length > cap ? nls.length - cap : 0);
    if (rows) diffHtml = '<div class="td-mini">' + rows + (over > 0 ? '<span class="td-mrow" style="color:var(--faint)">… 其余 ' + over + " 行(展开参数可见)</span>" : "") + "</div>";
  }
  const chips = '<div class="tr-chips">' + (o.path ? trChip(ic("file") + " " + esc(String(o.path))) : "") +
    (nls.length ? trChipB("+", nls.length) : "") + (ols.length ? trChipB("-", ols.length) : "") +
    (diag ? trChip(ic("warn") + " 有诊断", "note") : "") + "</div>";
  let diagHtml = "";
  if (diag) diagHtml = diagRender(diag, q);
  return chips + diffHtml + (headline ? '<div class="tr-empty">' + hl(esc(headline), q) + "</div>" : "") + diagHtml;
}
// fixC-D2(用户用户反馈):<diagnostics> 块渲染——旧实现把 XML 标签行一起原样裸露
// (<diagnostics file=...> 与 </diagnostics> 显示为文本)。剥离标签,file 属性行做标题,
// 内容行(L1513:38 error TS2694 ...)按「行号+级别+码」着色。零正则转义(模板层纪律)。
function diagRender(diag, q) {
  const NL = String.fromCharCode(10);
  const lines = diag.split(NL).map((l) => l.trim()).filter(Boolean);
  let file = "";
  const rows = [];
  for (const l of lines) {
    if (l.startsWith("<diagnostics")) {
      const i = l.indexOf("file=");
      if (i >= 0) { const rest = l.slice(i + 5).replace(/^["']/, "").replace(/["'>].*$/, ""); file = rest; }
      continue;
    }
    if (l.startsWith("</diagnostics")) continue;
    const m = l.indexOf("error ") >= 0 ? "err" : l.indexOf("warning ") >= 0 ? "warn" : "note";
    rows.push('<div class="diag-row dg-' + m + '">' + hl(esc(l), q) + "</div>");
  }
  if (!rows.length) return "";
 // 诊断块走独立板(diag-box)——整块淡红底+左红条,与正文段落区分;硬编码 rgba 换 --surf-fail(浅色主题不再出暗块)
  const hasErr = rows.join("").indexOf("dg-err") >= 0;
  return '<div class="diag-box' + (hasErr ? " has-err" : "") + '">' +
    (file ? '<div class="diag-hd">' + ic("warn") + " 诊断 " + esc(file) + "</div>" : "") +
    rows.join("") + "</div>";
}
// fixH10c:write_file——路径+字符量 chip+诊断块(与 edit 同链)。
function trWriteFile(argsRaw, txt, q, compact) {
  const NL = String.fromCharCode(10);
  const o = parseArgs(argsRaw) || {};
  const headline = firstLineOf(txt); // 已写入/已创建 path(N 字符)
  let diag = "";
  const di = txt.indexOf("<diagnostics");
  if (di >= 0) diag = txt.slice(di);
  const chips = '<div class="tr-chips">' + (o.path ? trChip(ic("file") + " " + esc(String(o.path))) : "") +
    (String(o.content || "").length ? trChipB("写入", String(o.content).length + " 字符") : "") +
    (diag ? trChip(ic("warn") + " 有诊断", "note") : "") + "</div>";
  let diagHtml = "";
  if (diag) diagHtml = diagRender(diag, q);
 // fixC-D3:旧实现漏拼 diagHtml——write_file 的诊断块渲染出来就被丢弃(用户用户反馈裸露的另一半根因)
  return chips + (headline ? '<div class="tr-empty">' + hl(esc(headline), q) + "</div>" : "") + diagHtml;
}
// grep 行解析:rel:LINE: text(第二冒号后跟空格;中段纯数字)。尾注行(已达上限/共 N 条)单独摘出。
function grParseContentLine(l) {
  const i1 = l.indexOf(":");
  if (i1 <= 0) return null;
  const i2 = l.indexOf(":", i1 + 1);
  if (i2 <= i1 + 1) return null;
  const num = l.slice(i1 + 1, i2);
  if (!/^[0-9]+$/.test(num)) return null;
  if (l.charAt(i2 + 1) !== " ") return null;
  return { f: l.slice(0, i1), ln: Number(num), t: l.slice(i2 + 2) };
}
// fixH10d:grep——命中 N 处·M 文件摘要+文件分组(文件头+行号预览,每文件 head 若干)。
function trGrep(argsRaw, txt, q, compact) {
  const NL = String.fromCharCode(10);
  const o = parseArgs(argsRaw) || {};
  const mode = String(o.output_mode || "content");
  const lines = String(txt).split(NL).filter((l) => l.trim());
  if (lines.length === 1 && lines[0].indexOf("零命中") >= 0) return '<div class="tr-empty">' + ic("search") + " 零命中</div>";
  let noteTxt = "";
  const hits = [];
  const counts = [];
  for (const l of lines) {
    if (l.indexOf("(已达上限") === 0 || l.indexOf("(共 ") === 0) { noteTxt = l; continue; }
    if (mode === "content") { const h = grParseContentLine(l); if (h) hits.push(h); else counts.push(l); }
    else counts.push(l);
  }
  if (mode === "content" && hits.length) {
    const byFile = [];
    const idxOf = new Map();
    for (const h of hits) {
      let gi = idxOf.get(h.f);
      if (gi === undefined) { gi = byFile.length; byFile.push({ f: h.f, rows: [] }); idxOf.set(h.f, gi); }
      byFile[gi].rows.push(h);
    }
    const perFile = compact ? 3 : 6;
    let rows = "";
    for (const g of byFile) {
 // 每文件成一块板(gr-blk),命中行在板内——搜索结果是「成组的证据」不是散句
      let blk = '<div class="gr-file">' + ic("file") + " " + esc(g.f) + " <span style='color:var(--faint)'>· " + g.rows.length + " 处</span></div>";
      for (const h of g.rows.slice(0, perFile)) blk += '<div class="gr-hit"><span class="gr-ln">' + h.ln + '</span><span class="gr-tx">' + hl(esc(clip(h.t, 160)), q) + "</span></div>";
      if (g.rows.length > perFile) blk += '<div class="tr-empty" style="padding-left:36px">… 另 ' + (g.rows.length - perFile) + " 处(展开全文可见)</div>";
      rows += '<div class="gr-blk">' + blk + "</div>";
    }
    let more = "";
    const total = hits.length;
    if (noteTxt) rows += '<div class="tr-empty">' + esc(noteTxt) + "</div>";
    if (total > 60) {
      more = '<details class="tr-more"><summary>展开全文(原始结果)</summary><div class="tc-body tr-full">' + esc(txt.slice(0, TR_CAP_CHARS)) + "</div></details>";
    }
    return '<div class="tr-chips">' + trChipB("命中", hits.length + " 处") + trChipB("文件", byFile.length) +
      (o.pattern ? trChip("模式 " + esc(clip(String(o.pattern), 40))) : "") + "</div>" + rows + more;
  }
 // files_with_matches / count / 解析失败:文件行+计数
  if (counts.length) {
    const cap = compact ? 8 : 24;
    let rows = "";
    for (const l of counts.slice(0, cap)) {
      const ci = l.lastIndexOf(":");
      const isCnt = ci > 0 && /^[0-9]+$/.test(l.slice(ci + 1));
      rows += '<div class="dir-row">' + ic("file") + "<span>" + hl(esc(ci > 0 && isCnt ? l.slice(0, ci) : l), q) + "</span>" +
        (isCnt ? '<span class="dir-meta">' + Number(l.slice(ci + 1)) + " 处</span>" : "") + "</div>";
    }
    let more = "";
    if (counts.length > cap) more = '<details class="tr-more"><summary>展开全部 ' + counts.length + ' 条</summary><div class="tc-body tr-full">' + esc(counts.slice(cap).join(NL)) + "</div></details>";
    return '<div class="tr-chips">' + trChipB("文件", counts.length) + (o.pattern ? trChip("模式 " + esc(clip(String(o.pattern), 40))) : "") + "</div>" + rows +
      (noteTxt ? '<div class="tr-empty">' + esc(noteTxt) + "</div>" : "") + more;
  }
  return "";
}
// fixH10e:glob——N 个匹配+文件行。
function trGlob(argsRaw, txt, q, compact) {
  const NL = String.fromCharCode(10);
  const o = parseArgs(argsRaw) || {};
  const lines = String(txt).split(NL).filter((l) => l.trim());
  if (lines.length === 1 && lines[0].indexOf("零命中") >= 0) return '<div class="tr-empty">' + ic("search") + " 零命中</div>";
  let noteTxt = "";
  const files = [];
  for (const l of lines) {
    if (l.indexOf("(共 ") === 0) { noteTxt = l; continue; }
    files.push(l);
  }
  if (!files.length) return "";
  const cap = compact ? 8 : 24;
  const rows = files.slice(0, cap).map((f) => '<div class="dir-row">' + ic("file") + "<span>" + hl(esc(f), q) + "</span></div>").join("");
  let more = "";
  if (files.length > cap) more = '<details class="tr-more"><summary>展开全部 ' + files.length + ' 条</summary><div class="tc-body tr-full">' + esc(files.slice(cap).join(NL)) + "</div></details>";
  return '<div class="tr-chips">' + trChipB("匹配", files.length) + (o.pattern ? trChip("模式 " + esc(clip(String(o.pattern), 40))) : "") + "</div>" + rows +
    (noteTxt ? '<div class="tr-empty">' + esc(noteTxt) + "</div>" : "") + more;
}
// fixH10f:list_dir——目录/文件图标行+计数。
function trListDir(argsRaw, txt, q, compact) {
  const NL = String.fromCharCode(10);
  const o = parseArgs(argsRaw) || {};
  const lines = String(txt).split(NL).filter((l) => l.trim());
  let nd = 0, nf = 0;
  const rows = lines.map((l) => {
    const isD = l.indexOf("[d] ") === 0, isF = l.indexOf("[f] ") === 0;
    if (isD) nd++; else if (isF) nf++;
    const nm = isD || isF ? l.slice(4) : l;
    return '<div class="dir-row">' + ic(isD ? "folder" : "file") + "<span>" + hl(esc(nm), q) + "</span>" +
      (isD ? '<span class="dir-meta">目录</span>' : isF ? '<span class="dir-meta">文件</span>' : "") + "</div>";
  }).join("");
  if (!rows) return "";
  return '<div class="tr-chips">' + (o.path ? trChip(ic("folder") + " " + esc(String(o.path))) : "") +
    (nd ? trChipB("目录", nd) : "") + (nf ? trChipB("文件", nf) : "") + "</div>" + rows;
}
// fixH10g:run_cmd——exit 徽标(非零红)+stdout/stderr 输出行块(长输出截断+展开)。
// 输出走终端板(is-term:独立底色+行级错误/警告/命令行调子;非零退出码整板红边)。
function trRunCmd(argsRaw, txt, q, compact) {
  const NL = String.fromCharCode(10);
  const o = parseArgs(argsRaw) || {};
  const nonzero = txt.indexOf("(退出码非零") >= 0;
  if (txt.trim() === "(无输出)") return '<div class="tr-chips">' + exitBadge(nonzero ? 1 : 0) + (o.command ? trChip(esc(clip(String(o.command), 70))) : "") + '</div><div class="tr-empty">(无输出)</div>';
 // stderr 区段标红行;退出码非零注记单独呈现在 chips
  let note = "";
  const nz = txt.indexOf("(退出码非零");
  if (nz >= 0) { const nl2 = txt.indexOf(NL, nz); note = nl2 > 0 ? txt.slice(nz, nl2) : txt.slice(nz); }
  const chips = '<div class="tr-chips">' + exitBadge(nonzero ? 1 : 0) + (o.command ? trChip(esc(clip(String(o.command), 70)), "", String(o.command)) : "") + (note ? trChip(ic("warn") + " " + esc(note), "note") : "") + "</div>";
  return chips + trBlockPreview(txt, q, compact, { kind: "term", fail: nonzero });
}
function exitBadge(code) {
  const c = Number(code);
  const z = c === 0;
  return '<span class="tc-exit ' + (z ? "z" : "n") + '">exit ' + (z ? "0" : c) + "</span>";
}
// fixH10h:terminal——JSON 结构(exitCode/waitReason/output)结构化;status=running 显示运行中。
function trTerminal(argsRaw, txt, q, compact) {
  const o = parseArgs(txt);
  if (!o || typeof o !== "object") return trRunCmd(argsRaw, txt, q, compact); // 非 JSON 回执按 run_cmd 口径
  const NL = String.fromCharCode(10);
  const chips = [];
  const ec = o.exitCode === undefined || o.exitCode === null ? null : Number(o.exitCode);
  if (o.status === "running" && ec === null) chips.push(trChip(ic("run") + " 会话运行中", "note"));
  else chips.push(exitBadge(ec === null ? 0 : ec));
  if (o.waitReason) chips.push(trChip("等待 " + esc(String(o.waitReason))));
  const ao = parseArgs(argsRaw) || {};
  const cmd = String(ao.command || ao.cmd || "");
  if (cmd) chips.push(trChip(esc(clip(cmd, 70)), "", cmd));
  else if (ao.action === "send" && ao.input) chips.push(trChip(esc(clip(String(ao.input), 70))));
  else if (ao.action) chips.push(trChip("动作 " + esc(String(ao.action))));
  if (o.sessionId) chips.push(trChip("会话 " + esc(String(o.sessionId).slice(-10))));
  const out = String(o.output || "");
  const ec2 = o.exitCode === undefined || o.exitCode === null ? 0 : Number(o.exitCode);
 // 终端会话输出同样走终端板(非零退出码=红板)
  return '<div class="tr-chips">' + chips.join("") + "</div>" + (out ? trBlockPreview(out, q, compact, { kind: "term", fail: ec2 !== 0 }) : "");
}
// fixH10i:code_sense——首行画像 chips+grep 命中/降级注记结构化。
function trCodeSense(argsRaw, txt, q, compact) {
  const NL = String.fromCharCode(10);
  const lines = String(txt).split(NL);
  const head = lines[0] || "";
  const chips = [];
  const hm = head.split("·");
  for (const seg of hm) {
    const s = seg.trim();
    if (!s || s.indexOf("[code_sense") === 0) continue;
    chips.push(trChip(esc(s)));
  }
  if (!chips.length && head) chips.push(trChip(esc(clip(head, 60))));
  const rest = lines.slice(1);
 // 命中行形态: path:line | text(code-sense 输出)/ path:line: text(grep 降级)
  const hits = [], notes = [];
  for (const l of rest) {
    const t = l.trim();
    if (!t) continue;
    if (t.indexOf("[降级]") === 0 || t.indexOf("[code_sense") === 0) { notes.push(t); continue; }
    const bar = t.indexOf(" | ");
    const g = grParseContentLine(t);
    if (bar > 0) { const pre = t.slice(0, bar); const ci = pre.lastIndexOf(":"); if (ci > 0) { hits.push({ f: pre.slice(0, ci), ln: pre.slice(ci + 1), t: t.slice(bar + 3) }); continue; } }
    if (g) { hits.push(g); continue; }
    notes.push(t);
  }
  let rows = "";
  if (hits.length) {
    const cap = compact ? 6 : 14;
    rows = hits.slice(0, cap).map((h) => '<div class="gr-hit"><span class="gr-ln">' + esc(String(h.ln)) + '</span><span class="gr-tx">' + hl(esc(clip(h.t, 140)), q) + "</span></div>").join("");
    if (hits.length > cap) rows += '<div class="tr-empty" style="padding-left:36px">… 另 ' + (hits.length - cap) + " 条(展开全文可见)</div>";
  }
  let noteHtml = "";
  if (notes.length) noteHtml = notes.slice(0, 4).map((t) => '<div class="tr-empty">' + hl(esc(clip(t, 160)), q) + "</div>").join("");
  let more = "";
  if (hits.length > 60 || txt.length > TR_PREVIEW_CHARS * 2) more = '<details class="tr-more"><summary>展开全文(原始结果)</summary><div class="tc-body tr-full">' + esc(txt.slice(0, TR_CAP_CHARS)) + "</div></details>";
  return '<div class="tr-chips">' + chips.join("") + (hits.length ? trChipB("命中", hits.length) : "") + "</div>" + rows + noteHtml + more;
}
// fixH10j:code_index——未找到/影响面/调用链等文本形态:首行高亮+其余行块。
function trCodeIndex(argsRaw, txt, q, compact) {
  const o = parseArgs(argsRaw) || {};
  const NL = String.fromCharCode(10);
  const lines = String(txt).split(NL);
  if (!txt.trim()) return "";
  if (txt.indexOf("未找到符号") === 0 || txt.indexOf("未找到") === 0) return '<div class="tr-empty">' + ic("warn") + " " + hl(esc(firstLineOf(txt)), q) + "</div>";
  const head = firstLineOf(txt);
  const rest = lines.slice(1).join(NL).trim();
  const chips = '<div class="tr-chips">' + trChip(esc(String(o.action || "query")) + (o.target ? " <b>" + esc(String(o.target)) + "</b>" : "")) + "</div>";
  return chips + '<div style="color:var(--text);font-size:var(--fs-code-sm);line-height:var(--lh-code);margin:2px 0 4px">' + hl(esc(head), q) + "</div>" + (rest ? trBlockPreview(rest, q, compact) : "");
}
// fixH10k:code_review——统计首行+[sev] file:line title 行分级徽标。
function crSevCls(sev) {
  const s = String(sev || "").toLowerCase();
  if (["blocker", "critical", "error", "fail", "p0"].indexOf(s) >= 0) return "hi";
  if (["warning", "high", "p1", "warn"].indexOf(s) >= 0) return "mid";
  return "";
}
function trCodeReview(argsRaw, txt, q, compact) {
  const NL = String.fromCharCode(10);
  const lines = String(txt).split(NL);
  const head = firstLineOf(txt); // LLM 深审 N 轮+grace 确认 N 条(…)
  const findings = [];
  let other = [];
  for (const l of lines.slice(1)) {
    const t = l.trim();
    if (!t) continue;
    if (t.charAt(0) === "[") {
      const j = t.indexOf("]");
      if (j > 1) { findings.push({ sev: t.slice(1, j), body: t.slice(j + 1).trim() }); continue; }
    }
    other.push(l);
  }
  const chips = '<div class="tr-chips">' + trChip(ic("check") + " " + esc(clip(head, 70)), findings.length ? "" : "good") +
    (findings.length ? trChipB("发现", findings.length) : trChip("无遗留发现", "good")) +
    (compact ? trChip("findings 见下方评论组(可注入修复)", "note") : "") + "</div>";
  const cap = compact ? 4 : 10;
  let rows = "";
  findings.slice(0, cap).forEach((f) => {
 // body 形态1 file:line: title — detail;形态2 file:line title — detail(行号后无冒号);其余按 — 分割
    let loc = "", title = f.body;
    const m = grParseContentLine(f.body);
    if (m) { loc = m.f + ":" + m.ln; title = m.t; }
    else {
      const c1 = f.body.indexOf(":");
      if (c1 > 0) {
        const rest2 = f.body.slice(c1 + 1);
        const sp2 = rest2.indexOf(" ");
        const digits = sp2 > 0 ? rest2.slice(0, sp2) : "";
        if (/^[0-9]+$/.test(digits)) { loc = f.body.slice(0, c1) + ":" + digits; title = rest2.slice(sp2 + 1); }
      }
      if (!loc) { const dash = f.body.indexOf(" — "); if (dash > 0) { loc = f.body.slice(0, dash).trim(); title = f.body.slice(dash + 3); } }
    }
    const dd = title.indexOf(" — ");
    const tMain = dd > 0 ? title.slice(0, dd) : title;
    const tSub = dd > 0 ? title.slice(dd + 3) : "";
    rows += '<div class="cr-row"><span class="cr-sev ' + crSevCls(f.sev) + '">' + esc(String(f.sev).toUpperCase()) + "</span>" +
      (loc ? '<span class="cr-loc">' + esc(loc) + "</span>" : "") +
      '<span class="cr-tx"><b>' + hl(esc(tMain), q) + "</b>" + (tSub ? '<div class="tr-empty" style="padding:0">' + hl(esc(clip(tSub, 220)), q) + "</div>" : "") + "</span></div>";
  });
  if (findings.length > cap) rows += '<div class="tr-empty" style="padding-left:2px">… 另 ' + (findings.length - cap) + " 条(展开全文可见)</div>";
  let more = "";
  if (findings.length > cap || other.length) more = '<details class="tr-more"><summary>展开全文(原始评审输出)</summary><div class="tc-body tr-full">' + esc(txt.slice(0, TR_CAP_CHARS)) + "</div></details>";
  return chips + rows + more;
}
// fixH10l:board_upsert/board_read——板名+节点/边计数+节点行(kind chip+label+摘要)。
function trBoard(name, argsRaw, txt, q, compact) {
  const NL = String.fromCharCode(10);
  const lines = String(txt).split(NL);
  const head = firstLineOf(txt);
  const chips = [];
  const tm = head.match(/[0-9]+/g);
 // 「title」N 节点/M 边(rev R,状态 s) / (页面结构板 · 状态 draft · rev 15 · 11 节点/12 边)
  const qm = head.indexOf("「"), qe = head.indexOf("」");
  const title = qm >= 0 && qe > qm ? head.slice(qm + 1, qe) : "";
  if (title) chips.push(trChip(ic("grid") + " " + esc(clip(title, 50))));
  const ni = head.indexOf("节点"), bi = head.indexOf("边");
  if (ni > 0 && tm) {
    const nodeN = Number(tm[tm.length - (bi > 0 ? 2 : 1)]) || 0;
    const edgeN = bi > 0 ? Number(tm[tm.length - 1]) || 0 : 0;
    if (nodeN) chips.push(trChipB("节点", nodeN));
    if (edgeN) chips.push(trChipB("边", edgeN));
  }
  const rv = head.indexOf("rev");
  if (rv >= 0) { const seg = head.slice(rv).split(/[^0-9]/).filter(Boolean)[0]; if (seg) chips.push(trChip("rev " + esc(seg))); }
  const st = head.indexOf("状态");
  if (st >= 0) { const seg = head.slice(st + 2).split(/[ ·)、]/).filter(Boolean)[0]; if (seg) chips.push(trChip("状态 " + esc(seg))); }
  chips.push(trChip("面板白板视图可见", "note"));
  const cap = compact ? 6 : 14;
  let rows = "";
  let shown = 0;
  for (const l of lines.slice(1)) {
    const t = l.trim();
    if (t.indexOf("- [") !== 0) continue;
    if (shown >= cap) break;
    shown++;
    const k1 = t.indexOf("["), k2 = t.indexOf("]");
    const kind = k1 >= 0 && k2 > k1 ? t.slice(k1 + 1, k2) : "";
    let rest = k2 > 0 ? t.slice(k2 + 1).trim() : t;
    const at = rest.indexOf(" @"); // fixH:先按「 @(x,y)」切(坐标前缀),无坐标再按尾随 (change) 切
    let label = rest, tail = "";
    if (at > 0) { label = rest.slice(0, at).trim(); tail = rest.slice(at + 1); }
    else { const par = rest.lastIndexOf("("); if (par > 0) { label = rest.slice(0, par).trim(); tail = rest.slice(par); } }
    rows += '<div class="bd-row"><span class="bd-kind">' + esc(kind) + '</span><span class="bd-tx"><b>' + hl(esc(clip(label, 60)), q) + "</b>" +
      (tail ? ' <span style="color:var(--faint)">' + esc(tail) + "</span>" : "") + "</span></div>";
  }
  let more = "";
  const totalNodes = lines.filter((l) => l.trim().indexOf("- [") === 0).length;
  if (totalNodes > cap) more = '<details class="tr-more"><summary>展开全部 ' + totalNodes + ' 个节点</summary><div class="tc-body tr-full">' + esc(lines.slice(1).join(NL).slice(0, TR_CAP_CHARS)) + "</div></details>";
  return '<div class="tr-chips">' + chips.join("") + "</div>" + rows + more + (rows ? "" : '<div class="tr-empty">' + hl(esc(head), q) + "</div>");
}
// fixH10m:todo_write——n/m 进度条+逐条状态行(数据源=调用参数 items;结果行做摘要)。
function trTodo(argsRaw, txt, q, compact) {
  const o = parseArgs(argsRaw) || {};
  const items = Array.isArray(o.items) ? o.items : [];
  const head = firstLineOf(txt); // 已记录计划 N 项(X 完成/Y 进行中)
  if (!items.length) return head ? '<div class="tr-empty">' + hl(esc(head), q) + "</div>" : "";
  let nd = 0, np = 0;
  for (const it of items) { const st = String((it && it.status) || ""); if (st === "completed" || st === "done") nd++; else if (st === "in_progress") np++; }
  const meter = '<div class="todo-meter">' + items.map((it) => { const st = String((it && it.status) || ""); return '<i class="' + (st === "completed" || st === "done" ? "d" : st === "in_progress" ? "p" : "") + '"></i>'; }).join("") + "</div>";
  const cap = compact ? 5 : 12;
  const rows = items.slice(0, cap).map((it) => {
    const st = String((it && it.status) || "");
    const done = st === "completed" || st === "done";
    const prog = st === "in_progress";
    return '<div class="todo-row' + (done ? " d" : prog ? " p" : "") + '"><span class="td-mark">' + (done ? ic("check") : prog ? ic("run") : ic("dot")) + "</span>" +
      '<span class="td-tx">' + hl(esc(clip(String((it && it.content) || ""), 120)), q) + "</span>" +
      (prog ? '<span class="dir-meta">进行中</span>' : done ? '<span class="dir-meta">完成</span>' : "") + "</div>";
  }).join("") + (items.length > cap ? '<div class="tr-empty">… 另 ' + (items.length - cap) + " 项</div>" : "");
  return '<div class="tr-chips">' + trChipB("计划", nd + "/" + items.length) + (np ? trChipB("进行中", np) : "") + "</div>" + meter + rows +
    (head ? '<div class="tr-empty">' + hl(esc(head), q) + "</div>" : "");
}
// fixH10n:session_search——mode/query/计数 chips+结果行(标题+会话+分)。
function trSessionSearch(argsRaw, txt, q, compact) {
  const o = parseArgs(txt);
  if (!o || typeof o !== "object") return "";
  const chips = [];
  if (o.mode) chips.push(trChip("模式 " + esc(String(o.mode))));
  if (o.query) chips.push(trChip("查询 " + esc(clip(String(o.query), 40))));
  if (o.totalMatches !== undefined) chips.push(trChipB("命中", o.totalMatches));
  else if (o.count !== undefined) chips.push(trChipB("会话", o.count));
  if (o.tookMs !== undefined) chips.push(trChip(Number(o.tookMs) + "ms"));
  if (o.session && o.session.title) chips.push(trChip(esc(clip(String(o.session.title), 44))));
  const res = Array.isArray(o.results) ? o.results : [];
  const cap = compact ? 3 : 6;
  const rows = res.slice(0, cap).map((r) => '<div class="dir-row">' + ic("file") + "<span>" + hl(esc(clip(String(r.title || r.sessionId || ""), 100)), q) + "</span>" +
    (r.score !== undefined ? '<span class="dir-meta">分 ' + Number(r.score).toFixed(1) + (r.hits ? " · " + r.hits + " 命中" : "") + "</span>" : "") + "</div>").join("");
  let more = "";
  if (String(txt).length > 4000) more = '<details class="tr-more"><summary>展开全文(原始 JSON)</summary><div class="tc-body tr-full">' + esc(txt.slice(0, TR_CAP_CHARS)) + "</div></details>";
  return '<div class="tr-chips">' + (chips.length ? chips.join("") : trChip("检索")) + "</div>" + rows + more;
}
// fixH10:结果体总分发(每工具专属;解析不出→通用体兜底,绝不空白)。
function toolResultBody(name, argsRaw, content, q, toks, compact) {
  const n = String(name || "").toLowerCase();
  const txt = cleanToolText(content);
  let out = "";
  try {
    if (n === "read_file") out = trReadFile(argsRaw, txt, q, toks, compact);
    else if (n === "edit_file") out = trEditFile(argsRaw, txt, q, compact);
    else if (n === "write_file") out = trWriteFile(argsRaw, txt, q, compact);
    else if (n === "grep") out = trGrep(argsRaw, txt, q, compact);
    else if (n === "glob") out = trGlob(argsRaw, txt, q, compact);
    else if (n === "list_dir") out = trListDir(argsRaw, txt, q, compact);
    else if (n === "run_cmd") out = trRunCmd(argsRaw, txt, q, compact);
    else if (n === "terminal") out = trTerminal(argsRaw, txt, q, compact);
    else if (n === "code_sense") out = trCodeSense(argsRaw, txt, q, compact);
    else if (n === "code_index") out = trCodeIndex(argsRaw, txt, q, compact);
    else if (n === "code_review") out = trCodeReview(argsRaw, txt, q, compact);
    else if (n === "board_upsert" || n === "board_read") out = trBoard(n, argsRaw, txt, q, compact);
    else if (n === "todo_write") out = trTodo(argsRaw, txt, q, compact);
    else if (n === "session_search") out = trSessionSearch(argsRaw, txt, q, compact);
  } catch (e) { out = ""; } // 专属体异常=回落通用体(渲染永不因解析炸)
  if (!out) out = trGenericBody(txt, q, toks);
  return out;
}
// fixH11:统一调用+结果合并卡(取代旧 toolCard 裸参数形态):头=图标+动词+参数摘要+状态(运行中/完成/失败·耗时);
// 体=专属结果渲染;结果未达(执行中)=运行中态+调用参数折叠。res={content,durationMs}。opts.compact=紧凑体
// (code_review 且同流已有 review.findings 交互组时:卡内只留统计摘要,findings 走交互组,免双份)。
function toolCallCard(c, q, res, toks, opts) {
  const name = String(c.name || "");
  const m = toolMetaOf(name);
  const sum = toolArgSum(name, c.arguments);
  const gate = res ? gateRejectOf(res.content) : null; // plan-gate/权限层拒绝:红显「被拒」而非绿「完成」
  let err = false, stCls = "tc-run", stTxt = "运行中", durTxt = "";
  if (res) {
    err = !!gate || toolResIsErr(name, res.content);
    stCls = err ? "tc-err" : "tc-ok";
    stTxt = gate ? "被拒" + (gate.reason.indexOf("plan-gate") >= 0 ? " · plan-gate" : "") : err ? "失败" : "完成";
    const d = Number(res.durationMs || 0);
    if (d > 0) durTxt = " · " + (d >= 6000 ? fmtDur(d) : d + "ms");
  }
  const headName = m ? '<span class="tc-verb" title="' + esc(name) + '">' + esc(m.v) + "</span>" : '<span>» ' + hl(esc(name), q) + "</span>";
 // 折叠态 key:调用 id 跨重渲染稳定(轮询/流式回包都不会变);无 id 的旧形态退回「工具名+参数头」。
  const detK = "tool-call:" + (String(c.id || "") || name + ":" + String(c.arguments || "").slice(0, 80));
  const bodyHtml = res
    ? (gate ? '<div class="tr-empty">被工具层拒绝,未执行。' + (gate.reason ? "<br>原因:" + esc(gate.reason) : "") + "</div>" : "") + toolResultBody(name, c.arguments, res.content, q, toks, !!(opts && opts.compact))
    : '<div class="tr-empty">' + ic("run") + " 执行中,结果未返回…</div>" +
      '<details class="tr-more"><summary>调用参数</summary><div class="tc-body tr-full">' + hl(esc(String(c.arguments).slice(0, 2000)), q) + "</div></details>";
  return '<details class="tool-card' + (res && err ? " tc-fail" : "") + '" data-det-key="' + esc(detK) + '"><summary>' +
    (m ? '<span class="tc-ic">' + ic(m.i) + "</span>" : "") + headName +
    '<span class="tc-args">' + hl(esc(String(sum)).slice(0, 100), q) + '</span>' +
    '<span class="tc-state ' + stCls + '">' + stTxt + durTxt + "</span></summary>" +
    '<div class="tc-body">' + bodyHtml + "</div></details>";
}
// ---- 语义着色(数据源=journal tool.tokens 事件,file-tools.ts read_file 旁路发射)----
// tool.tokens 事件预扫:toolCallId → payload。histEvents 同会话只增(水位法增量扫描);
// 会话切换/全量重放(首事件 seq 变化)/截断(长度小于水位)时重置重建。map 仅渲染面消费。
let tokScanSid = null, tokScanN = 0, tokScanSeq0;
const tokByCall = new Map();
function toolTokensScan() {
  if (!histEvents) return;
  const s0 = histEvents.length ? (histEvents[0].seq || 0) : -1;
  if (tokScanSid !== currentSid || s0 !== tokScanSeq0 || histEvents.length < tokScanN) {
    tokByCall.clear(); tokScanSid = currentSid; tokScanSeq0 = s0; tokScanN = 0;
  }
  for (; tokScanN < histEvents.length; tokScanN++) {
    const e = histEvents[tokScanN];
    if (e && e.kind === "tool.tokens" && e.payload && e.payload.toolCallId)
      tokByCall.set(String(e.payload.toolCallId), e.payload);
  }
}
function toolTokensOf(ev) {
  if (!ev || ev.kind !== "tool.result") return null;
  const p = tokByCall.get(String((ev.payload || {}).toolCallId || ""));
  if (!p || !Array.isArray(p.tokens) || p.tokens.length === 0) return null;
  return p; // {toolCallId,path,language,tokens[]}
}
// fixH14:合并卡取语义 tokens 的入口(卡渲染点在 message.agent 侧,手上只有 callId——与 toolTokensOf 同源)。
function toolTokensOfId(callId) {
  const p = tokByCall.get(String(callId || ""));
  if (!p || !Array.isArray(p.tokens) || p.tokens.length === 0) return null;
  return p;
}
// dataType → 家族色(bool/str/num);结构体/自定义/容器/未知= null(落 --tok-var)。
// 词表按词切分匹配(黑名单要按特征不按词,P-15 同源纪律:词边界防子串污染;此处容器词优先短路,
// dict[str,int] 不因含 str/int 误入 str/num 家族)。
function tkWords(dt) { return String(dt).split(/[^A-Za-z0-9_]+/).filter(Boolean); }
function tkFamilyOf(dt) {
  if (!dt) return null;
  const ws = tkWords(dt);
  if (!ws.length) return null;
  const has = (set) => ws.some((w) => set.indexOf(w) >= 0);
  if (has(["dict", "map", "vector", "list", "set", "tuple", "hashmap", "unordered_map", "Record", "object"])) return null;
  if (has(["bool", "_Bool", "boolean", "Boolean"])) return "bool";
  if (has(["char", "wchar_t", "char16_t", "char32_t", "string", "str", "String", "unicode"])) return "str";
  if (has(["int", "long", "short", "float", "double", "size_t", "ssize_t", "unsigned", "signed", "byte", "number", "Number", "bigint",
    "usize", "isize", "uint", "int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64", "uintptr", "intptr",
    "float32", "float64", "complex"])) return "num";
  return null;
}
function tkClassOf(t) {
  const k = String(t.kind || "");
  if (k === "function" || k === "method") return "tk-func";
  if (k === "enumMember") return "tk-enum";
  if (k === "class" || k === "struct" || k === "enum" || k === "interface" || k === "type") return "tk-type";
  const fam = tkFamilyOf(t.dataType); // variable/property:声明类型家族分色(VS Code 式「类型即颜色」)
  return fam ? "tk-" + fam : "tk-var";
}
function tkIsPtr(t) { const d = String(t.dataType || ""); return d.indexOf("*") >= 0 || d.indexOf("[") >= 0; } // 指针/数组标记(点线下划线+title 悬浮声明类型)
// 行号 → 该行 tokens(按 character 升序);token.line=文件 1-based 行号(SemanticTokenFile 契约)
function tkLineMap(tokens) {
  const m = new Map();
  if (!Array.isArray(tokens)) return m;
  for (const t of tokens) {
    const ln = Number(t && t.line) || 0;
    if (ln <= 0) continue;
    if (!m.has(ln)) m.set(ln, []);
    m.get(ln).push(t);
  }
  for (const arr of m.values()) arr.sort((a, b) => (Number(a.character) || 0) - (Number(b.character) || 0));
  return m;
}
// 行内 token 切片:span 外原文 esc(hl 搜索高亮保留),span 内 <span class="tk-*">。
// 越界/负值/重叠保护(len<=0、c<pos、c+len>行长——截断行/异常数据零渲染风险)。
function tkLineHtml(rowText, toks, q) {
  let out = "", pos = 0;
  for (const t of toks) {
    const c = Number(t.character) || 0, len = Number(t.length) || 0;
    if (len <= 0 || c < pos || c + len > rowText.length) continue;
    out += hl(esc(rowText.slice(pos, c)), q);
    const dt = t.dataType ? ' title="' + esc(String(t.dataType)) + '"' : "";
    out += '<span class="' + tkClassOf(t) + (tkIsPtr(t) ? " tk-ptr" : "") + '"' + dt + ">" + hl(esc(rowText.substr(c, len)), q) + "</span>";
    pos = c + len;
  }
  out += hl(esc(rowText.slice(pos)), q);
  return out;
}
// 单行渲染入口:read_file 行形态=6 字符右对齐行号+TAB+源行(file-tools.ts 同一格式)。无行号/
// 该行无 token=原 hl(esc) 形态逐字不变(降级路径);有 token=行号前缀走 tk-lnno 调子+内容切片。
function tkRowHtml(l, tmap, q) {
  const TAB = String.fromCharCode(9);
  const fallback = hl(esc(l), q) || "&nbsp;";
  if (l.length >= 7 && l.charAt(6) === TAB) {
    const numTxt = l.slice(0, 6).trim();
    const rowNo = Number(numTxt);
    if (numTxt !== "" && String(rowNo) === numTxt && rowNo > 0) {
      const toks = tmap.get(rowNo);
      if (toks && toks.length) return '<span class="tk-lnno">' + esc(l.slice(0, 6)) + "</span>" + TAB + (tkLineHtml(l.slice(7), toks, q) || "&nbsp;");
    }
  }
  return fallback;
}
// 工具结果行块:code-bar 行数头 + .cl 逐行 span(display:block 承担换行)。
// 行间以裸换行连接——容器 .tr-lines white-space:normal 折叠之(不进 pre,避免 pre 内文本节点再断行),
// HTML 字符串保留真实换行(mdrender t2 的 CR 转行断言依赖)。totalLines>显示行数时头标注「前 N 行/共 M 行」。
// toks(toolTokensOf 产物)在场=逐行语义切片+语言名入头;缺席=原形态零变化(优雅降级)。
// opts.kind 决定板式与行级调子——term=终端输出(近黑板+绿调+exit 失败红板),
// code=源码,text=通用文本(零变化兜底)。行级调子只在无 toks 时挂(语义着色优先,防双色打架)。
// (页面模板禁写含反斜杠的正则字面量,行调子判定一律走 indexOf,见 lineToneOf)
function lineToneOf(l, kind) {
 // 行调子只对终端/命令输出生效(kind=term):源码与通用文本里 error/失败 是常态,误标红=噪音
  if (kind !== "term") return "";
  const s = String(l);
  const t = s.trim();
  if (!t) return "";
  const low = t.toLowerCase();
 // 命令行($ xxx / > xxx / PS> / C:\ ... >)——只认行首符号,避免正文里出现 $ 误判
  if (t.charAt(0) === "$" || (t.charAt(0) === ">" && t.charAt(1) === " ")) return "tl-cmd";
 // 错误:err/error/fail/failed/失败/错误/异常/panic/退出码非零/TypeError 等
  if (low.indexOf("error") >= 0 || low.indexOf("failed") >= 0 || low.indexOf("failure") >= 0 ||
      low.indexOf("panic") >= 0 || low.indexOf("exception") >= 0 || low.indexOf("traceback") >= 0 ||
      t.indexOf("错误") >= 0 || t.indexOf("失败") >= 0 || t.indexOf("异常") >= 0 ||
      t.indexOf("退出码非零") >= 0 || low.indexOf("err ") === 0 || low.indexOf("err:") === 0) return "tl-err";
  if (low.indexOf("warn") >= 0 || t.indexOf("警告") >= 0) return "tl-warn";
 // 终端提示行(以 # 或 // 开头的注释/说明)——kind=term 才降调,其它 kind 不猜
  if (kind === "term" && (t.indexOf("//") === 0 || t.charAt(0) === "#")) return "tl-dim";
  return "";
}
function codeLinesBlock(txt, q, totalLines, toks, opts) {
  const NL = String.fromCharCode(10);
  const lines = String(txt).split(NL);
  const n = Number(totalLines) > lines.length ? Number(totalLines) : lines.length;
  const tmap = toks ? tkLineMap(toks.tokens) : null;
  const kind = (opts && opts.kind) || "";
  const kindTag = kind === "term" ? "输出" : toks ? String(toks.language || "") : "text";
  const label = kindTag + " · " +
    (n === lines.length ? n + " 行" : "前 " + lines.length + " 行 / 共 " + n + " 行");
  const wrapCls = "code-wrap" + (kind === "term" ? " is-term" : kind === "code" ? " is-code" : "") + (opts && opts.fail ? " tc-fail" : "");
  const body = lines.map((l) => {
    const tone = tmap ? "" : lineToneOf(l, kind); // 语义 token 在场时行调子让位
    return '<span class="cl' + (tone ? " " + tone : "") + '">' + (tmap ? tkRowHtml(l, tmap, q) : (hl(esc(l), q) || "&nbsp;")) + "</span>";
  }).join(NL);
  return '<div class="' + wrapCls + '"><div class="code-bar"><span class="code-lang">' + esc(label) + '</span></div>' +
    '<div class="tc-body tr-lines">' + body + "</div></div>";
}
// 分组项结构化(截图红框主因):explore 组项预览原为 esc 平铺 div(.tg-args white-space:normal
// =多行输出塌缩成一段流式裸文本;单条不成组时整段直接裸排消息流)。 改为:工具名+参数行头 +
// codeLinesBlock 行块。fixH15(渲染官 H):组项升级统一框架——图标+人话动词+参数摘要+完成/失败徽标 +
// 按工具专属结果体(grep 命中分组/编辑 diff/终端 exit 徽标…),不再「raw 名+raw 参数+纯文本行块」。
function tgResultItem(name, argsRaw, content, q, toks) {
  const m = toolMetaOf(name);
  const sum = toolArgSum(name, argsRaw);
  const err = toolResIsErr(name, content);
  const head = '<div class="tg-head">' +
    (m ? '<span class="tc-ic">' + ic(m.i) + "</span>" : "") +
    '<span class="tg-name"' + (m ? ' title="' + esc(String(name || "")) + '"' : "") + ">" + esc(m ? m.v : String(name || "")) + "</span>" +
    '<span class="tg-args">' + hl(esc(String(sum)).slice(0, 110), q) + "</span>" +
    '<span class="tg-st ' + (err ? "err" : "ok") + '">' + (err ? "失败" : "完成") + "</span></div>";
  return '<div class="tg-item' + (err ? " tc-fail" : "") + '">' + head + toolResultBody(name, argsRaw, content, q, toks, true) + "</div>";
}

// ---- 子代理过程卡(B):spawn 处内联,任务书摘要/状态/耗时/实时尾随 ----
// 形态决策:内联卡而非聚合面板——spawn 点即用户注意力所在,聚合计数已有 statusbar「子代理 n(运行 m)」
// chip 承担;数据通道=session.status 既有 3s 轮询的 subagentList(服务端读后台注册表+output.txt 尾部),
// 不造新协议。角色提取用 indexOf(页面模板禁反斜杠,\w 形正则会被转义吃掉——旧 roleM 正则即此伤)。
function subagentRoleOf(instructions) {
  const s = String(instructions || "");
  const head = "【子智能体角色:";
  const i = s.indexOf(head);
  if (i < 0) return "worker";
  const rest = s.slice(i + head.length);
  const j = rest.indexOf("】");
  const name = (j >= 0 ? rest.slice(0, j) : rest.slice(0, 24)).trim();
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : "worker";
}
function lines0Of(s) { return String(s || "").split(String.fromCharCode(10))[0] || ""; }
// 角色身份色(提取共享:过程卡/等待聚合卡/子代理目录三处同源,免漂移)
function subagentRoleColor(role) { return { worker: "#6fae7a", explore: "#c9a25e", judge: "#7a9cc9", "test-analyst": "#c98f5e", planner: "#9b7ad9", "ppt-master": "#d98a5e" }[role] || "#8a8a8a"; }
// 角色显示名:planner → 「规划」;:ppt-master → 「演示」;其余沿用英文名(不制造回归)。
function subagentRoleName(role) { return role === "planner" ? "规划" : role === "ppt-master" ? "演示" : role; }
// 摘要行(提取共享):title 参数优先;否则在【任务书】后找**含内容动词的行**(目标/负责/巡检…),
// 跳过多份任务书共享的纪律前言(「只读…严禁…」)——并列子 agent 首行雷同=卡片无法区分(用户经验证反馈)。
function subagentLabelOf(title, instructions) {
  const instr = String(instructions || "");
  const cardTitle = String(title || "");
  let firstLine = "";
  if (!cardTitle) {
    const taskMark = instr.indexOf("【任务书】");
    const body = taskMark >= 0 ? instr.slice(taskMark + 5) : instr;
    const verbs = ["目标", "负责", "巡检", "调查", "实现", "修复", "分析", "审查", "整理", "汇总", "产出", "排查", "核对"];
    for (const ln of body.split(String.fromCharCode(10))) {
      const t = ln.trim();
      if (!t || t.indexOf("【") === 0) continue;
      if (t.indexOf("禁") >= 0) continue;
      let hit = false;
      for (const v of verbs) { if (t.indexOf(v) >= 0) { hit = true; break; } }
      if (hit) { firstLine = t; break; }
    }
    if (!firstLine) { for (const ln of body.split(String.fromCharCode(10))) { if (ln.indexOf("【") !== 0 && ln.trim()) { firstLine = ln; break; } } }
  }
  return String(cardTitle || firstLine || lines0Of(instr)).slice(0, 40);
}
function subagentCardHtml(ev, resByAgent, bgByAgent, q) {
  const p = ev.payload || {};
  const agentId = String(p.agentId || "");
  const key = agentId || "s" + String(ev.seq === undefined ? "" : ev.seq);
  const live = agentId ? subagentLive[agentId] : null;
  const res = agentId ? resByAgent.get(agentId) : null;
  const isBg = agentId ? bgByAgent.has(agentId) : false;
  const role = subagentRoleOf(p.instructions);
  const roleColor = subagentRoleColor(role);
  let st, cls, durTxt = "";
  if (live && live.status === "running") { st = isBg ? "后台运行中" : "运行中"; cls = "run"; if (ev.time) durTxt = " · 已工作 " + fmtDur(Date.now() - ev.time); }
  else if (live && (live.status === "completed" || live.status === "failed")) {
    st = live.status === "completed" ? "完成" : "失败"; cls = live.status === "completed" ? "ok" : "fail";
    if (res && res.time && ev.time) durTxt = " · 用时 " + fmtDur(res.time - ev.time);
  }
  else if (res) { st = res.ok ? "完成" : "失败"; cls = res.ok ? "ok" : "fail"; if (res.time && ev.time) durTxt = " · 用时 " + fmtDur(res.time - ev.time); }
  else if (isBg) { st = "后台运行中"; cls = "run"; if (ev.time) durTxt = " · 已工作 " + fmtDur(Date.now() - ev.time); }
  else { st = "已结束"; cls = "end"; }
  const instr = String(p.instructions || "");
  const firstLine = subagentLabelOf(p.title, instr);
  let body = '<div class="sub-task">' + esc(instr) + "</div>";
  if (live && live.status === "running" && live.tail) body += '<div class="sub-tail">' + esc(String(live.tail).slice(-1200)) + "</div>";
  else if (res && res.text) body += '<div class="sub-tail">' + esc(res.text) + "</div>";
  else if (live && live.tail && String(live.tail).indexOf("[result") >= 0) body += '<div class="sub-tail">' + esc(String(live.tail).slice(-1200)) + "</div>"; // journal 终态未达时的实时兜底(输出文件尾已带 [result] 行)
  else if (cls !== "run") body += '<div class="sub-tail">(历史会话或服务已重启:实时过程不可回放,结果见 ' + ic("sub") + ' 结果卡)</div>';
  const pref = subCardUser.get(key);
  const openAttr = (pref !== undefined ? pref : cls === "run") ? " open" : "";
 // 过程卡「工作区」钮——消息流内就地开该子代理的工作区 tab(与目录条目行同一 data-subws 委托);
 // agentId 缺席(异常态 key 回退)不渲染按钮,不造假入口。
  const cardWsBtn = agentId ? '<button class="sc-ws" data-subws="' + esc(agentId) + '" title="打开该子代理的工作区 tab(完整动作/消息流)">工作区</button>' : "";
  return '<details class="tool-card sub-card" data-agent="' + esc(key) + '"' + openAttr + "><summary>" +
    '<span class="sub-dot' + (cls === "run" ? " run" : "") + '" style="background:' + roleColor + '"></span>' +
    '<span>» 子代理 ' + esc(subagentRoleName(role)) + '</span><span class="tc-args">' + hl(esc(firstLine), q) + "</span>" +
    '<span class="sub-st ' + cls + '">' + esc(st + durTxt) + "</span>" + cardWsBtn + "</summary>" +
    '<div class="tc-body">' + body + "</div></details>";
}

// task_output 轮询聚合卡(刷屏治理):主 agent 等子代理收割时,每对 task_output 调用+结果
// 不再逐对出卡——同 agentId 全部对聚合成一张卡:运行中=「等待中 · 已工作 Xs · 轮询 N 次」+实时 tail;
// 终态翻绿「完成 · 用时 Ns」。数据源=journal 事件对(历史会话重放同语义)+subagentLive(3s 注册表轮询)。
function taskWaitCardHtml(agentId, info, resByAgent, bgByAgent, spawnInfo, q) {
  const spawn = spawnInfo.get(agentId) || null;
  const live = subagentLive[agentId] || null;
  const res = resByAgent.get(agentId) || null;
  const isBg = bgByAgent.has(agentId);
  const role = spawn ? subagentRoleOf(spawn.instructions) : "worker";
  const label = (spawn ? subagentLabelOf(spawn.title, spawn.instructions) : "") || agentId.slice(-10);
  const startAt = (spawn && spawn.time) || (info && info.firstTime) || 0;
  const pollN = info ? info.count : 0;
  let st, cls, durTxt = "";
 // 判定优先级:journal 终态(subagent.result)> 注册表终态 > 运行中(live/后台/轮询快照)> 已结束(历史)
  if (res) { st = res.ok ? "完成" : "失败"; cls = res.ok ? "ok" : "fail"; if (res.time && startAt) durTxt = " · 用时 " + fmtDur(res.time - startAt); }
  else if (live && (live.status === "completed" || live.status === "failed")) { st = live.status === "completed" ? "完成" : "失败"; cls = live.status === "completed" ? "ok" : "fail"; }
  else if ((live && live.status === "running") || isBg || (info && info.lastStatus === "running")) {
    st = "等待中"; cls = "run";
    if (startAt) durTxt = " · 已工作 " + fmtDur(Date.now() - startAt);
    if (pollN > 1) durTxt += " · 轮询 " + pollN + " 次";
  }
  else { st = "已结束"; cls = "end"; if (pollN) durTxt = " · 轮询 " + pollN + " 次"; }
  let body = "";
  if (spawn && spawn.instructions) body += '<div class="sub-task">' + esc(String(spawn.instructions)) + "</div>";
  const tail = (live && live.tail) || (info && info.lastTail) || "";
  if (cls === "run" && tail) body += '<div class="sub-tail">' + esc(String(tail).slice(-1200)) + "</div>";
  else if (res && res.text) body += '<div class="sub-tail">' + esc(res.text) + "</div>";
  else if (tail && String(tail).indexOf("[result") >= 0) body += '<div class="sub-tail">' + esc(String(tail).slice(-1200)) + "</div>";
  else if (cls !== "run") body += '<div class="sub-tail">(历史会话或服务已重启:实时过程不可回放)</div>';
  if (pollN > 1) body += '<div class="sub-polls">已聚合 ' + pollN + " 次轮询(task_output 调用与结果对并入本卡,不再逐条刷屏)</div>";
  const pref = subCardUser.get(agentId);
  const openAttr = (pref !== undefined ? pref : cls === "run") ? " open" : "";
  return '<details class="tool-card sub-card sub-wait ' + cls + '" data-agent="' + esc(agentId) + '"' + openAttr + "><summary>" +
    '<span class="sub-dot' + (cls === "run" ? " run" : "") + '" style="background:' + subagentRoleColor(role) + '"></span>' +
    '<span>» 等待子代理 ' + esc(subagentRoleName(role)) + '</span><span class="tc-args">' + hl(esc(label), q) + "</span>" +
    '<span class="sub-st ' + cls + '">' + esc(st + durTxt) + "</span>" +
    '<button class="sc-ws" data-subws="' + esc(agentId) + '" title="打开该子代理的工作区 tab(完整动作/消息流)">工作区</button></summary>' +
    '<div class="tc-body">' + body + "</div></details>";
}

// 权限审批( B2):ask→对话框;倒计时到点自动拒(服务端同计时,fail-closed 兜底)
let permCurrent = null, permTimer = null;
function permShow(m) {
  permCurrent = m;
  $("permTool").textContent = "工具:" + (m.tool || "?") + " · 风险:" + (m.risk || "medium");
  $("permSum").textContent = String(m.summary || "");
  const secs = Math.round((m.timeoutMs || 60000) / 1000);
 // C 文案对齐:落盘规则经 C9 归一(permission-store addAlwaysAllowRule 非 * pattern 一律存
 // 工具级 "*"),摘要首词形态(如 subagent[safe-cmd])从未真实落盘——展示改成与实落一致的 tool[*]。
 // 只动展示;permAlways 的提交面(pattern=摘要首词,服务端归一)保持原语义不动。
  $("permMeta").textContent = secs + " 秒无应答自动拒绝 · 总是允许将写规则:" + (m.tool || "?") + "[*]";
  $("permDialog").classList.add("on");
  clearInterval(permTimer);
  let left = secs;
  permTimer = setInterval(() => {
    left--;
    if (left <= 0) { clearInterval(permTimer); permHide(); }
    else $("permMeta").textContent = left + " 秒无应答自动拒绝 · 总是允许写规则:" + (permCurrent ? ((permCurrent.tool || "?") + "[*]") : "?");
  }, 1000);
}
function permHide() { $("permDialog").classList.remove("on"); clearInterval(permTimer); permCurrent = null; }
/** 统一应答口:发送+清 Gate 队列+关 modal+状态点;后续 permission.resolved 广播再把
 * 其它标签页/指挥台面收敛(旧实现 modal 应答不清 approvalQueue → Gate 残行点击报 UnknownAsk)。 */
function permRespondUnified(requestId, decision, rule) {
  wsSafeSend(JSON.stringify({ v: 1, type: "permission.respond", requestId, decision, ...(rule ? { rule } : {}) }));
  approvalQueue.delete(requestId);
  if (typeof renderApprovals === "function" && viewLive("approvals")) { try { renderApprovals(); } catch (_) {} }
  if (permCurrent && permCurrent.requestId === requestId) permHide();
  try { cvStatusRefresh(); } catch (_) {}
}
function permRespond(decision) {
  if (!permCurrent) return;
  permRespondUnified(permCurrent.requestId, decision);
}
$("selSide").onclick = () => { const m = $("selMenu"); m.style.display = "none"; sideToSuper("主线选中文本", m.dataset.txt || ""); };
$("selQuote").onclick = () => { const m = $("selMenu"); m.style.display = "none"; $("instruction").value = ($("instruction").value + " " + m.dataset.txt).trim(); autoGrow(); saveDraft(); $("instruction").focus(); };
$("permAllow").onclick = () => permRespond("allow-once");
$("permDeny").onclick = () => permRespond("reject");
$("permAlways").onclick = () => {
  if (!permCurrent) return;
  const pattern = String(permCurrent.summary || "").split(" ")[0] || "*";
  permRespondUnified(permCurrent.requestId, "allow-always", { permission: permCurrent.tool || "subagent", pattern });
};

let histLastHtml = null; // 上次写入的 chatBody HTML(T1 幂等:相同=跳过写入;直写 chatBody 的分支须置 null 失效;页面脚本禁 TS 标注)
let histLastParts = null; // 上次写入的逐块 HTML(增量渲染:与本次 parts 做前缀+后缀匹配,只替换差异区间;任何绕过 renderHistory 的 chatBody 直写都必须置 null)
// fixE22:长会话顶窗渲染(T6 登记:auto-7fa17d29 kids=729 全量 innerHTML,首帧 1.1s+滚动 longtask)。
// 语义:窗口只裁「上方更老的段」(<mfWinLo 的 parts 以零高占位渲染,journal 索引与事件遍历不变——
// turnOutcome/预扫/分组状态机照常全量重放,只是不生成重型 HTML);尾部恒真(粘底追新天然成立)。
// 上方哨兵「加载更早」+滚动接近顶部自动扩展(MF_WIN_STEP 步进,占位↔真内容按高度差回补 scrollTop)。
// 查找态(findQuery)强制全量:占位段无 mark 可命中,N 处计数与跳转必须全量;会话切换才重新定窗。
let mfWinLo = 0;         // 顶窗下界(parts 索引;0=全量=旧行为,小会话零变化)
let mfWinSk = false;     // 骨架态:大会话首帧先全占位趟计数(毫秒级),再按 n-N 定窗真渲染(openSession 置位)
let mfWinShiftFrom = -1; // 扩展渲染的高度回补基准(winExtend 记 scrollHeight,写入后按差值回补;>=0=本帧走回补路径)
const MF_WIN_N = 72;     // 初始窗口段数(生产环境大会话均块高 ~167px:≈13 屏;实测 96 段写入 310-470ms,72 段留足 <500ms 首帧余量)
const MF_WIN_STEP = 16;  // 上翻扩展步长(段数;96 段步进实测单次扩展 56-79ms 仍过 longtask 阈,16 段压入阈下)
const MF_EVT_BIG = 600;  // 起窗事件阈值(会话事件数>此值才窗口化;以下全量渲染=完全旧路径)
const MSG_PH = '<div class="msg-ph" hidden></div>';
// fixE23:renderHistory 预扫记忆化——预扫(tool.result 去重集/子代理状态机/task_output 聚合/resByCall)是纯函数于
// histEvents;3s 轮询/流式 60ms 节拍/diffstat 连环重渲之间 journal 多半未变,引用+长度双键命中=零重扫。
// 事件追加(push 保引用但长度变)与换会话(新引用)自动失效;骨架趟与真趟共享同一份。
let mfScanRef = null;
let mfScanLen = -1;
let mfScanData = null;
let codeCopyDelegated = false; // code-copy 委托一次性守卫(此前每次渲染重复挂监听)
let replyMoreDelegated = false; // fixT6:长汇报展开/收起委托一次性守卫(同 code-copy 语义)
// ── 增量渲染工具(滚动稳定):parts 每项=单根元素,逐块对位后只动差异区间——
// 未变节点身份存活=展开态/滚动位置/已渲染内容不丢,消除整列 innerHTML 重建的抖动源。 ──
function mfRoot(html) {
  const t = document.createElement("template");
  t.innerHTML = html;
  return t.content.firstElementChild;
}
function mfQA(roots, sel) { // 跨本次写入根集合的选择器(增量路径只绑新节点,旧节点绑定已存活)
  const out = [];
  for (const r of roots) out.push(...r.querySelectorAll(sel));
  return out;
}
// 展开态兜底:原先按「根序号 + 根内 details 序号」回放,parts 数量一变
// (加载更多历史/窗口哨兵/流式占位)序号即错位,用户刚点开的卡会被按别人的序号开合。
// 现改为按 detOpen 的稳定 key 采集+回填(与序号解耦)。
function openIdxOf(root) {
  detCaptureIn(root);
  return [];
}
function mfPatch(body, oldParts, newParts) {
  const min = Math.min(oldParts.length, newParts.length);
  let p = 0;
  while (p < min && oldParts[p] === newParts[p]) p++;
  let s = 0;
  while (s < min - p && oldParts[oldParts.length - 1 - s] === newParts[newParts.length - 1 - s]) s++;
  const delN = oldParts.length - s - p;
  const addParts = newParts.slice(p, newParts.length - s);
  for (let i = 0; i < delN; i++) openIdxOf(body.children[p + i]); // 被删节点的开合态先收进总账(按 key,不按序号)
  for (let i = 0; i < delN; i++) body.children[p].remove();
  const ref = body.children[p] || null;
  const frag = document.createDocumentFragment();
  const roots = [];
  for (let i = 0; i < addParts.length; i++) {
    const el = mfRoot(addParts[i]);
    if (!el) throw new Error("mfPatch: part is not single-root"); // 兜底触发全量重建(退化为旧行为,不劣化)
    roots.push(el);
    frag.appendChild(el);
  }
  body.insertBefore(frag, ref);
  for (const r of roots) detBindIn(r); // 新节点按总账回填 open(增量补丁不再按同位序号回放)
  return { roots, appendedOnly: p === oldParts.length && oldParts.length < newParts.length };
}
function mfFirstVisible(vt) {
  const body = $("chatBody");
  const vTop = vt.getBoundingClientRect().top;
  for (let i = 0; i < body.children.length; i++) {
    if (body.children[i].getBoundingClientRect().bottom > vTop + 1) return body.children[i];
  }
  return null;
}
function mfCaptureOpenAll(body) {
  const rec = [];
  for (let i = 0; i < body.children.length; i++) {
    const idx = openIdxOf(body.children[i]);
    if (idx.length) rec.push([i, idx]);
  }
  return rec;
}
// 子代理过程卡(B):live 状态/尾随来自 session.status 轮询的 subagentList(3s 既有轮询);
// subCardUser=用户手动开合意图(优先于「运行中默认展开」),重渲染后状态存活。
const subagentLive = {}; // agentId → { status, tail }
const subCardUser = new Map(); // key → true/false(用户 toggle 过的展开意图)
// ── 折叠态总账(「折叠自己开/关」根因修复)──
// 面板所有看板的可折叠区统一走一张总账:用户手动开合意图按稳定 key 存 detOpen,
// 数据回包重渲染(innerHTML 整列重建 / 增量 patch / 新卡插入)后由 MutationObserver 对
// 新插入的 details 按 key 回填 open。禁止再按 DOM 现值判定折叠态——那正是「点开它,
// 下一帧轮询回包它自己又关上」的根因。key 优先取生成侧写死的 data-det-key(与内容变化
// 无关),缺省用身份路径:最近带身份属性的祖先 + 自身 tag.class + 同型兄弟序号。
const detOpen = new Map(); // key → true/false(只记用户手动 toggle 过的)
const DET_ID_ATTRS = ["data-det-key", "data-agent", "data-trace-card", "data-tkturn", "data-sid", "data-intake-seq", "data-key", "id"];
function detClassOf(n) { return typeof n.className === "string" ? n.className.trim().split(/ +/).sort().join(".") : ""; }
function detPathOf(d) {
  const parts = [];
  let n = d;
  let depth = 0;
  while (n && n.nodeType === 1 && depth < 8) {
    const cls = detClassOf(n);
    const tag = n.tagName.toLowerCase() + (cls ? "." + cls : "");
    let anchor = "";
    for (let i = 0; i < DET_ID_ATTRS.length; i++) {
      const v = n.getAttribute(DET_ID_ATTRS[i]);
      if (v) { anchor = tag + "[" + DET_ID_ATTRS[i] + "=" + v + "]"; break; }
    }
    if (anchor) { parts.unshift(anchor); break; } // 命中身份锚:路径到此为止(不依赖外层序号)
    const parent = n.parentElement;
    let nth = 0;
    if (parent) for (const sib of parent.children) { if (sib === n) break; if (sib.tagName === n.tagName && detClassOf(sib) === cls) nth++; }
    parts.unshift(tag + "#" + nth);
    n = parent;
    depth++;
  }
  return parts.join(">");
}
function detKeyOf(d) { return d.getAttribute("data-det-key") || detPathOf(d); }
function detOnToggle(ev) {
  const d = ev && (ev.currentTarget || ev.target);
  if (!d || d.tagName !== "DETAILS") return;
  detOpen.set(detKeyOf(d), d.open);
}
/** 新插入的子树:绑 toggle 采集(一次)+ 按总账回填 open。 */
function detBindIn(root) {
  if (!root || root.nodeType !== 1) return;
  const list = root.tagName === "DETAILS" ? [root] : [];
  if (root.querySelectorAll) for (const d of root.querySelectorAll("details")) list.push(d);
  for (const d of list) {
    if (!d.__detBound) { d.__detBound = true; d.addEventListener("toggle", detOnToggle); }
    const k = detKeyOf(d);
    if (detOpen.has(k) && d.open !== !!detOpen.get(k)) d.open = !!detOpen.get(k);
  }
}
/** 重建前把现存节点的开合态收进总账(整列重建/增量 patch 都靠它兜住用户意图)。 */
function detCaptureIn(root) {
  if (!root || !root.querySelectorAll) return;
  for (const d of root.querySelectorAll("details")) detOpen.set(detKeyOf(d), d.open);
}
function detWatch() {
  if (typeof MutationObserver !== "function" || !document.body) return;
  const mo = new MutationObserver((recs) => {
    for (const r of recs) for (const n of r.addedNodes) if (n && n.nodeType === 1) detBindIn(n);
  });
  mo.observe(document.body, { childList: true, subtree: true });
}
detWatch();
// B3( F1 面板侧缓解):模型偶发把上下文结构标签(</tool_result>/<tool_message> 等)整行驼出——
// 仅由协议标签开头的行不展示;上游内容清洗在各自域(子代理出口已做,主模型侧属提示词域)。
// 实现零反斜杠:页面模板层连注释里的反斜杠转义都会被吃掉并把注释截成裸语句(PAGE 转义族,注释也不例外)。
function scrubProtocolLines(t) {
  var NL = String.fromCharCode(10);
  var tags = ["<tool_result>", "</tool_result>", "<tool_message>", "</tool_message>", "<tool_call>", "</tool_call>", "<task_serialism>", "</task_serialism>", "<task_advisor>", "</task_advisor>", "<system-提示>", "</system-提示>"];
  var lines = String(t || "").split(NL).filter(function (ln) {
    var s = ln.replace(/^\u0020+/, "").replace(/\u0020+$/, "");
    if (s.charAt(0) !== "<" || s.charAt(s.length - 1) !== ">") return true;
    for (var i = 0; i < tags.length; i++) if (s.indexOf(tags[i]) === 0) return false;
    return true;
  });
 // 行中残留剥离(渲染修复):协议标签嵌在行中(非整行)也驼出成乱码——整行过滤后,再把标签本体从行内移除。
  var stripped = lines.map(function (ln) {
    var s = ln;
    for (var i = 0; i < tags.length; i++) s = s.split(tags[i]).join("");
    return s;
  });
  return stripAnsi(stripped.join(NL));
}
// ANSI 转义清洗(乱码源:run_cmd 终端输出的色码/控制序列原样渲染成乱符号):ESC [ 参数 终止字节(@-~)。
function stripAnsi(s) {
  var ESC = String.fromCharCode(27);
  var out = "", i = 0;
  while (i < s.length) {
    if (s.charAt(i) === ESC) {
      i++;
      if (s.charAt(i) === "[") {
        i++;
        while (i < s.length) { var cc = s.charCodeAt(i); if (cc >= 64 && cc <= 126) { i++; break; } i++; }
      }
      continue;
    }
    out += s.charAt(i); i++;
  }
  return out;
}
// ---- user 消息 slash chip 渲染(主会话 message.user 与子代理工作区 steer 共用) ----
// 首行 "/name args" → .slash-chip(name)+sc-args;raw 前缀合流的模板 remainder 与当前注册表展开式逐字相等时
// 隐藏(模板=面板自己合成的任务书,展示层只呈现用户所说的 raw 形态—— display/text 分账同精神);
// 不相等(用户手打多行正文/注册表文本已改/自定义 body 已编辑)=原样呈现零丢失。非 "/" 文本=hl(esc) 原路。
// 旧 journal 兼容:纯模板开头(非 "/")不进本分支;/goal 单行原文(无 remainder)形态不变。
function userSlashTemplateOf(nm, args) {
  const c = SLASH_COMMANDS.find((x) => x.value.toLowerCase() === nm);
 // n3:提交侧模板已改为 cmdExpand 展开($ARGUMENTS/$N),展示侧必须用同一展开式比对,
 // 否则「有占位符的自定义命令」发送后模板体会被当成用户手打正文原样展示。
  if (c && c.kind === "send" && c.expand) return cmdTemplateOf(c, String(args || ""));
  if (c && c.value === "workflow") return workflowBody(String(args || ""));
  if (c && c.value === "init") return initBody(String(args || ""));
  const custom = customCommands.find((x) => x.name.toLowerCase() === nm);
  if (custom) return cmdExpand(String(custom.body || ""), String(args || ""));
  return null;
}
// ---- 文件引用(对齐 ref/zcode:mentionMarkdown 的 [label](./path) 载体 + FileDisplayInline chip)----
// 零反斜杠纪律:PAGE 是 TS 模板字符串,浏览器端脚本里所有正则/转义都会被模板层吃掉,故全部手工扫描。
/** 仓内相对路径规范化:逐个剥 "./" 前缀(不用正则)。 */
function relOfPath(p) {
  let s = String(p || "").trim();
  while (s.slice(0, 2) === "./") s = s.slice(2);
  return s;
}
/** 发送用的引用载体:[文件名](./仓内相对路径);kind=dir 时补尾斜杠(ref buildFileMentionMarkdown 同形)。 */
function buildFileMention(rel, kind) {
  let r = relOfPath(rel);
  const isDir = kind === "dir" || kind === "directory" || r.slice(-1) === "/";
  while (r.slice(-1) === "/") r = r.slice(0, -1);
  if (!r) return "";
  const segs = r.split("/");
  const label = String(segs[segs.length - 1] || r).split("[").join("").split("]").join("");
  return "[" + label + "](./" + r + (isDir ? "/" : "") + ")";
}
/** 文件引用 chip:图标+文件名+目录弱提示;data-file=仓内相对路径,点击在 IDE 打开。 */
function fileChipHtml(label, dest) {
  const d = String(dest || "");
  const isDir = d.slice(-1) === "/";
  const rel = isDir ? d.slice(0, -1) : d;
  const nm = esc(String(label || rel.split("/").pop() || rel));
  const cut = rel.lastIndexOf("/");
  const dirPart = cut > 0 ? '<span class="fc-dir">' + esc(rel.slice(0, cut)) + "</span>" : "";
  return '<span class="file-chip" data-file="' + esc(rel) + '"' + (isDir ? ' data-dir="1"' : "") +
    ' role="button" tabindex="0" title="' + esc(rel + (isDir ? "/ (目录)" : " · 点击在 IDE 打开")) + '">' +
    '<span class="fc-ic">' + (isDir ? "▸" : "▤") + '</span><span class="fc-nm">' + nm + "</span>" + dirPart + "</span>";
}
/** 正文 → 文件 chip:识别 [label](./path) 与旧消息里的裸 @path;其余文本逐字 esc(不吞字)。 */
function fileMentionHtml(text, q) {
  const s = String(text == null ? "" : text);
  let out = "", i = 0;
  while (i < s.length) {
    const c = s.charAt(i);
    if (c === "[") {
      const close = s.indexOf("](", i + 1);
      const end = close === -1 ? -1 : s.indexOf(")", close + 2);
      if (close > 0 && end > 0) {
        const label = s.slice(i + 1, close);
        const dest = s.slice(close + 2, end);
        if (dest && dest.indexOf(" ") < 0 && dest.indexOf("://") < 0 && (dest.indexOf("/") >= 0 || dest.indexOf(".") >= 0)) {
          out += fileChipHtml(label, relOfPath(dest));
          i = end + 1;
          continue;
        }
      }
    }
    if (c === "@" && (i === 0 || s.charAt(i - 1) <= " ")) {
      let j = i + 1;
      while (j < s.length && s.charAt(j) > " ") j++;
      const tok = s.slice(i + 1, j);
      if (tok && (tok.indexOf("/") >= 0 || tok.indexOf(".") >= 0)) {
        out += fileChipHtml(tok.split("/").pop(), relOfPath(tok));
        i = j;
        continue;
      }
    }
    out += esc(c);
    i++;
  }
  return out;
}
/** 扫描正文文件引用(与 fileMentionHtml 同一判定,额外返文本区间):[{label,dest,dir,start,end}]。 */
function fileRefsInText(text) {
  const s = String(text == null ? "" : text);
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s.charAt(i);
    if (c === "[") {
      const close = s.indexOf("](", i + 1);
      const end = close === -1 ? -1 : s.indexOf(")", close + 2);
      if (close > 0 && end > 0) {
        const label = s.slice(i + 1, close);
        const raw = s.slice(close + 2, end);
        if (raw && raw.indexOf(" ") < 0 && raw.indexOf("://") < 0 && (raw.indexOf("/") >= 0 || raw.indexOf(".") >= 0)) {
          out.push({ label: label, dest: relOfPath(raw), dir: raw.slice(-1) === "/", start: i, end: end + 1 });
          i = end + 1;
          continue;
        }
      }
    }
    if (c === "@" && (i === 0 || s.charAt(i - 1) <= " ")) {
      let j = i + 1;
      while (j < s.length && s.charAt(j) > " ") j++;
      const tok = s.slice(i + 1, j);
      if (tok && (tok.indexOf("/") >= 0 || tok.indexOf(".") >= 0)) {
        out.push({ label: tok.split("/").pop(), dest: relOfPath(tok), dir: tok.slice(-1) === "/", start: i, end: j });
        i = j;
        continue;
      }
    }
    i++;
  }
  return out;
}
/** 输入区引用条:正文里的文件引用同步成 chip(与聊天气泡同一形态;× = 从正文移除该引用)。
 * 与 skill 的 chip 同观感:用户在输入框里就看得见「引用了哪个文件」,而不是一坨路径文本。 */
function fileRefRender() {
  const bar = $("fileRefBar"), inp = $("instruction");
  if (!bar || !inp) return;
  const refs = fileRefsInText(inp.value);
  if (!refs.length) { bar.style.display = "none"; bar.innerHTML = ""; return; }
  bar.style.display = "flex";
  bar.innerHTML = refs.map((r, i) => fileChipHtml(r.label, r.dest + (r.dir ? "/" : "")) +
    '<span data-frx="' + i + '" title="移除该引用" style="cursor:pointer;color:var(--faint);margin:0 6px 0 -2px">×</span>').join("");
  for (const x of bar.querySelectorAll("[data-frx]")) x.onclick = () => fileRefDrop(Number(x.getAttribute("data-frx")));
}
/** 从正文移除第 idx 个文件引用(连带的空格一并收掉,不留双空格)。 */
function fileRefDrop(idx) {
  const inp = $("instruction");
  const r = fileRefsInText(inp.value)[idx];
  if (!r) return;
  let before = inp.value.slice(0, r.start), after = inp.value.slice(r.end);
  while (before.slice(-1) === " ") before = before.slice(0, -1);
  while (after.slice(0, 1) === " ") after = after.slice(1);
  inp.value = before && after ? before + " " + after : before + after;
  saveDraft(); autoGrow(); fileRefRender(); renderSendBtn();
  inp.focus();
}
/** 文件 chip 点击(事件委托一次,覆盖输入区条与聊天流气泡):文件→IDE 打开;目录→文件树展开。 */
document.addEventListener("click", (e) => {
  const el = e.target && e.target.closest ? e.target.closest(".file-chip") : null;
  if (!el) return;
  e.preventDefault();
  e.stopPropagation();
  const rel = el.getAttribute("data-file") || "";
  if (!rel) return;
  try {
    if (el.getAttribute("data-dir") === "1") { filesExpanded.add(rel); switchView("files"); filesRender(); }
    else { ideOpenFile(rel); }
  } catch (err) { toast("打开失败:" + rel, true); }
});
function userSlashHtml(utext, q) {
  const s = String(utext || "");
 // 伪 chip :只有「已知命令」(内置注册表/自定义命令)才进 chip 渲染。普通正文碰巧
 // 以 "/" 开头(典型:「已有 text 从头打 / + 原文」没匹配上命令就回车发了)按普通文本渲染,
 // 不再把整段首行吞进 chip(此前=名字是整句话的假红 chip,渲染 bug 注意)。
  let knownSlash = null;
  if (s.startsWith("/")) {
    const nl0 = s.indexOf(String.fromCharCode(10));
    const first0 = nl0 === -1 ? s : s.slice(0, nl0);
    const sp0 = first0.indexOf(" ");
    const nm0 = (sp0 === -1 ? first0.slice(1) : first0.slice(1, sp0)).toLowerCase();
    if (nm0) {
      knownSlash = SLASH_COMMANDS.find((x) => x.value.toLowerCase() === nm0) ||
        customCommands.find((x) => x.name.toLowerCase() === nm0) || null;
    }
  }
  if (!knownSlash) {
 // 含文件引用的正文走 chip 还原(纯文本路径零改动,仍走原高亮链路)
    if (s.indexOf("[") < 0 && s.indexOf("@") < 0) return sketchifyHtml(hl(esc(s), q));
    return fileMentionHtml(s, q);
  }
 // (跨线修复:PAGE 模板字面量吃反斜杠转义——首版换行转义落在页面成真实换行,
 // 字符串断行=整个脚本块 SyntaxError 全灭;fromCharCode(10) 是本文件既有约定)
  const nl = s.indexOf(String.fromCharCode(10));
  const first = nl === -1 ? s : s.slice(0, nl);
  const sp = first.indexOf(" ");
  const name = sp === -1 ? first.slice(1) : first.slice(1, sp);
  const args = sp === -1 ? "" : first.slice(sp + 1);
  const rest = nl === -1 ? "" : s.slice(nl + 1);
  let body = "";
  if (rest.trim()) {
    const tpl = name ? userSlashTemplateOf(name.toLowerCase(), args) : null;
 // (跨线修复:首版正则的空白类+换行转义同被模板吃掉→正则跨行 SyntaxError;
 // 等价语义=剥前导空白再剥一个换行,字符类+fromCharCode 形态)
    const shown = tpl && rest.trim() === tpl ? "" : rest.replace(/^[\u0020\t]+/, "").replace(String.fromCharCode(10), "");
    if (shown) body = '<div class="u-slash-body">' + sketchifyHtml(hl(esc(shown), q)) + "</div>";
  }
  return '<span class="slash-chip"><span class="sc-icon">/</span> ' + esc(name) +
    (args ? ' <span class="sc-args">' + sketchifyHtml(esc(args)) + "</span>" : "") + "</span>" + body;
}
// fixT6 P2:超长 agent 汇报折叠。「展开全文」态按键存 Set——renderHistory 是增量重渲染(每 60ms 流式拉取
// / 每 1.5s 轮询),不存则展开状态每次被重置。键优先用事件 seq(journal 稳定唯一);无 seq(注入/乐观事件)
// 回落内容指纹(review nit:纯指纹会让两段相同长汇报共享展开态)。
const replyOpen = new Set();
function replyKeyOf(ev, text) {
  const seq = ev && ev.seq;
  if (seq !== undefined && seq !== null) return "s" + String(seq);
  const s = String(text); return s.length + ":" + s.slice(0, 40) + "|" + s.slice(-40);
}
/** agent 正文块:超长(>1200 字符 或 >28 行)给折叠壳 + 「展开全文」按钮;短文本原样(零变化)。 */
function replyBlockHtml(ev, q) {
  const p = ev.payload || {}; // review nit:统一守卫(payload 缺席时下方 llmMs/text 取值不再互不一致)
  const text = String(scrubProtocolLines(p.text) || "");
 // 元信息(fixT6 P2):时间戳/LLM 耗时以 title 承载——聊天流不该被元信息刷屏,但详情要可查(经验证此前两者全不可见)
  const t0 = ev.time ? new Date(ev.time).toLocaleTimeString() : "";
  const ms = Number(p.llmMs || 0);
  const title = (t0 ? "回复时间 " + t0 : "") + (ms > 0 ? (t0 ? " · " : "") + "LLM " + Math.round(ms / 1000) + "s" : "");
  const body = '<div class="task-reply"' + (title ? ' title="' + esc(title) + '"' : "") + ">" + mdToHtml(text, q) + "</div>";
  const long = text.length > 1200 || text.split(String.fromCharCode(10)).length > 28;
  if (!long) return body;
  const k = replyKeyOf(ev, text);
 // 含表格的终态回复默认展开(2026-10-20):表格被折进「展开全文」后用户只看到按钮,
 // 统计/清单类结论(表格形态)最需要一眼可见。文本里出现表格分隔行即认(与 mdToHtml 判定同源)。
  const hasTable = text.indexOf("| ---") >= 0 || text.indexOf("|---") >= 0;
  const isOpen = replyOpen.has(k) || hasTable;
  return '<div class="reply-wrap reply-long' + (isOpen ? " open" : "") + '" data-reply-k="' + esc(k) + '">' + body +
    '<button class="reply-more" data-reply-toggle="' + esc(k) + '">' + (isOpen ? "收起" : "展开全文") + "</button></div>";
}
/**
 * 首启引导卡(新用户经验证):空会话 + 缺模型/项目时,给两条直达路径。
 * 只缺什么显示什么;都齐了返回空串(纯「该会话暂无记录」)。
 */
function firstRunCardHtml() {
  const hasModel = !!modelSwitchGlobalModel();
  const hasProject = Array.isArray(projects) && projects.length > 0;
  if (hasModel && hasProject) return "";
  const step = (num, key, label, hint) =>
    '<button type="button" class="fr-step" data-onboard="' + key + '"><b>' + num + "</b><span>" + label +
    (hint ? '<span style="color:var(--faint)"> · ' + hint + "</span>" : "") + "</span></button>";
  const done = (num, label) => '<div class="fr-step" disabled><b>' + num + "</b><span>" + label + '</span><span class="fr-done">已完成</span></div>';
  return '<div class="first-run-card">'
    + '<div class="fr-title">开始使用 Genie Harness</div>'
    + '<div class="fr-sub">三步就能跑起来:接入模型 → 添加项目 → 在下方输入一句需求。全部在本机,凭证只写入本地密钥文件。</div>'
    + '<div class="fr-steps">'
    + (hasModel ? done("1", "接入模型") : step("1", "model", "接入模型", "填 API Key 即可,支持 DeepSeek/百炼/OpenAI 等"))
    + (hasProject ? done("2", "添加项目") : step("2", "project", "添加项目", "打开本地文件夹或连接 WSL/SSH"))
    + (hasModel ? step("3", "task", "输入需求", "在下方输入框说一句话,Enter 发送") : '<div class="fr-step" disabled><b>3</b><span>输入需求 · 先完成第 1 步</span></div>')
    + "</div></div>";
}
`;
