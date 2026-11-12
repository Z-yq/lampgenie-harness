/**
 * 面板主脚本分片:script-traj(逐字自 panel.ts PAGE 模板搬移, 拆分)。
 * 模板约束沿袭:不得出现反引号与 ${;行内换行不得写裸转义。
 */
export const PANEL_JS_TRAJ = `// ===================== 轨迹看板(全屏 overlay 事件账本) =====================
// 纯前端形态:数据源=histEvents(会话重放事件,已在场),建模层 buildTrajRows/groupTrajTurns/summarizeTraj/
// filterTrajRows/capTrajRows/fmtTokens/fmtDuration 由 panel-traj-model.ts 源码注入(PAGE 无法 import)。
// 渲染函数一律纯函数(只依赖 esc + 注入的格式化函数),面板测试可从 PAGE 抽源码 new Function 求值断言。
let trajBoardState = { pane: "decisions", mode: "all", lmode: "sequence", q: "", sel: -1, rows: [], turns: [], view: [], files: [], ord: {}, filesKey: "", prunes: [] };
// 逐次决策视图:卡体全文按需拉取;缓存 key=轨迹文件绝对路径(相邻卡的 prev 复用同一份)。
const trajTraceCache = new Map(); // path -> {state:"loading"|"ok"|"err", data?, err?}
const trajExpanded = new Set();   // 已展开的轨迹文件路径
const TRAJ_EXPAND_ALL_MAX = 30;   // 「全部展开」单次上限(不一次拉上百个文件)
let trajBoardInitDone = false;    // 本次打开会话只自动展开最新卡一次(不覆盖用户手动收起)
let trajDashPullAt = 0, trajDashPullTimer = 0; // 看板在场时 dashboard.changed 驱动的增量拉史节流水位(尾沿补拉)

/** 数值取证(非法/缺失/非正数一律 null,渲染层据此回退旧口径,不出 undefined/NaN)。 */
function trajNumOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
/**
 * 行级 usage 归并(估算口径补到决策行上)。
 * 数据源=histEvents 的 llm.trace payload(estimatedInputTokens / estimatedCachedTokens /
 * usageSuspect / usageAnomaly),按 payload.file 建 Map 后补到对应决策行。
 * 旧 journal 没有这些字段 → 行不变(渲染层继续走上报口径);不改原行对象(账本视图共享同一批行)。
 */
function decorateTrajUsage(rows, events) {
  const src = Array.isArray(rows) ? rows : [];
  const evs = Array.isArray(events) ? events : [];
  const byFile = new Map();
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i];
    if (!e || e.kind !== "llm.trace") continue;
    const p = e.payload && typeof e.payload === "object" ? e.payload : {};
    const f = p.file ? String(p.file) : "";
    if (!f) continue;
    const inEst = trajNumOrNull(p.estimatedInputTokens);
    const cacheEst = trajNumOrNull(p.estimatedCachedTokens);
    const sus = p.usageSuspect === true;
    const anom = typeof p.usageAnomaly === "string" && p.usageAnomaly ? p.usageAnomaly : "";
    if (inEst === null && cacheEst === null && !sus && !anom) continue;
    byFile.set(f, { inEst: inEst, cacheEst: cacheEst, sus: sus, anom: anom });
  }
  if (!byFile.size) return src.slice();
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const r = src[i];
    const f = r && r.traceFile ? String(r.traceFile) : "";
    const u = f ? byFile.get(f) : null;
    if (!r || !u) { out.push(r); continue; }
    const next = Object.assign({}, r);
    if (u.inEst !== null) next.inputTokensEst = u.inEst;
    if (u.cacheEst !== null) next.cachedTokensEst = u.cacheEst;
    if (u.sus) next.usageSuspect = true;
    if (u.anom) next.usageAnomaly = u.anom;
    out.push(next);
  }
  return out;
}
/** 汇总合计:主口径=LLM API 经验证 usage(repInput/repCached,全行求和);
 * 估算只作次级(estInput/estCached,仅统计带估算的行);suspect 单独计数(0 时不出现「异常」项)。 */
function trajBoardUsageTotals(rows) {
  const src = Array.isArray(rows) ? rows : [];
  let estRows = 0, estInput = 0, estCached = 0, repInput = 0, repCached = 0, suspect = 0;
  for (let i = 0; i < src.length; i++) {
    const r = src[i];
    if (!r) continue;
    if (r.usageSuspect) suspect++;
    repInput += trajNumOrNull(r.inputTokens) || 0;
    repCached += trajNumOrNull(r.cachedTokens) || 0;
    const ie = trajNumOrNull(r.inputTokensEst);
    if (ie === null) continue;
    estRows++;
    estInput += ie;
    estCached += trajNumOrNull(r.cachedTokensEst) || 0;
  }
  return { estRows: estRows, estInput: estInput, estCached: estCached, repInput: repInput, repCached: repCached, suspect: suspect };
}
/** 轨迹看板自愈(2026-11):以 rows[].traceFile 为「journal 已入账」集合,
 * files(/api/llm-trace/list 的元数据)里不在集合中的调用 → 合成行(synth:true,复制 TrajRow 形状),
 * 按 turn/step 排序插入,并按数组次序重排 idx(synth 行补 seq=相邻已入账行的 seq,便于剪枝卡/卡号对齐)。
 * 纯函数、自足(不引外部 helper):测试按源码抽取口径直接求值。 */
function mergeSynthRows(rows, files) {
  const src = Array.isArray(rows) ? rows : [];
  const fl = Array.isArray(files) ? files : [];
  const known = {};
  for (let i = 0; i < src.length; i++) {
    const f = src[i] && src[i].traceFile ? String(src[i].traceFile) : "";
    if (f) known[f] = true;
  }
  const num = function (v) {
    if (v === undefined || v === null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const extra = [];
  for (let i = 0; i < fl.length; i++) {
    const m = fl[i];
    if (!m) continue;
    const f = m.file ? String(m.file) : "";
    if (!f || known[f]) continue;
    known[f] = true;
    const u = m.usage && typeof m.usage === "object" ? m.usage : {};
    const tc = Array.isArray(m.toolCalls) ? m.toolCalls.map(function (x) { return String(x); }) : [];
    const head = m.responseHead ? String(m.responseHead) : "";
    extra.push({
      kind: "llm", label: m.model ? String(m.model) : "llm",
      summary: head || "轨迹文件已落盘,journal 未入账",
      traceFile: f, turn: num(m.turn) || 0, stepNo: num(m.step),
      durationMs: num(m.durationMs),
      inputTokens: num(u.inputTokens), cachedTokens: num(u.cachedTokens), outputTokens: num(u.outputTokens),
      tools: tc, status: "ok", synth: true,
    });
  }
  if (!extra.length) return src.slice();
  const all = src.concat(extra);
 // 稳定排序:turn → step(缺 step 视为最后);同 turn/step 时已入账行恒在合成行之前(Node sort 稳定)。
  const stepOf = function (r) {
    const v = r && r.stepNo;
    return v === undefined || v === null ? Infinity : Number(v);
  };
  const synthRank = function (r) { return r && r.synth ? 1 : 0; };
  all.sort(function (a, b) {
    return (Number(a && a.turn || 0) - Number(b && b.turn || 0))
      || (stepOf(a) - stepOf(b)) || (synthRank(a) - synthRank(b));
  });
  for (let i = 0; i < all.length; i++) {
    const r = all[i];
    if (!r) continue;
    r.idx = i + 1;
    if (r.synth) {
 // 锚点=前一条已入账行(合成行落在两条 journal 事件之间;取前一事件 seq 才不会把后续 prune/intake 提前 flush 到本行之前)。
      let s = null;
      for (let j = i - 1; j >= 0 && s === null; j--) if (all[j] && all[j].seq !== undefined) s = Number(all[j].seq);
      for (let j = i + 1; j < all.length && s === null; j++) if (all[j] && all[j].seq !== undefined) s = Number(all[j].seq);
      r.seq = s === null ? i + 1 : s;
    }
  }
  return all;
}
/** 汇总条(10 项口径=summarizeTraj;缓存命中率一位小数百分比)。
 * 主口径一律=API 经验证(repInput/repCached):输入=API 合计,命中率=cached/input,input=0 → 「—」;
 * 估算只作次级一项「估算(触发用)」(仅 estRows>0 时出现);「异常 N」仅 N>0。
 * 第 2 参 u 缺省/旧调用方 → 逐字回退到旧的 a.inputTokens / a.cacheHitRate 形态。 */
function trajBoardSumHtml(s, u) {
  const a = s || {};
  const hasU = !!(u && typeof u === "object");
  const f = function (k, v) { return "<span>" + k + "<b>" + esc(v) + "</b></span>"; };
  const repIn = hasU ? Number(u.repInput) || 0 : Number(a.inputTokens) || 0;
  const repCached = hasU ? Number(u.repCached) || 0 : Number(a.cachedTokens) || 0;
  const inputH = hasU
    ? f("输入", repIn > 0 ? fmtTokens(repIn) : "—")
    : f("输入", fmtTokens(a.inputTokens));
  const hitH = hasU
    ? f("缓存命中率", repIn > 0 ? ((repCached / repIn) * 100).toFixed(1) + "%" : "—")
    : f("缓存命中率", (Number(a.cacheHitRate || 0) * 100).toFixed(1) + "%");
  const estH = hasU && Number(u.estRows) > 0 ? f("估算(触发用)", fmtTokens(u.estInput)) : "";
  const susH = hasU && Number(u.suspect) > 0 ? f("异常", u.suspect) : "";
  return f("调用数", a.calls) + f("轮数", a.turns) + inputH + f("输出", fmtTokens(a.outputTokens))
    + hitH + estH + f("工具数", a.tools) + f("错误数", a.errors) + f("墙钟", fmtDuration(a.wallMs))
    + f("本地评分", a.localScores) + f("剪枝", a.prunes) + susH;
}
/** 轮头:第 N 轮 · 墙钟 · 调用数 · 工具直方图(名称×次数,最多 6 个)。 */
function trajBoardTurnHeadHtml(t) {
  const hist = (t && t.toolHistogram ? t.toolHistogram : []).slice(0, 6)
    .map(function (h) { return esc(h.name) + "×" + Number(h.count || 0); }).join(" · ");
  return '<div class="tb-trhead">第 ' + Number(t && t.turn || 0) + " 轮"
    + '<span class="h">墙钟 ' + esc(fmtDuration(Number(t && t.wallMs || 0))) + " · 调用 " + Number(t && t.calls || 0) + "</span>"
    + (hist ? '<span class="h">' + hist + "</span>" : "") + "</div>";
}
/** 单行:8 列(# / 类型 / 摘要 / 耗时 / 输入 / 缓存 / 输出 / 状态)。错误行的错误文本并入摘要(可见、可搜)。 */
function trajBoardRowHtml(r) {
  const sum = r.error ? (r.summary ? r.summary + " · " + r.error : r.error) : r.summary;
  const st = r.status === "error" ? '<span class="st err">错误</span>'
    : r.status === "pending" ? '<span class="st pending">待</span>' : '<span class="st">ok</span>';
  const cell = function (v, f) { return '<span class="' + (f ? "d" : "t") + '">' + (v === undefined || v === null ? "-" : esc(f ? fmtDuration(v) : fmtTokens(v))) + "</span>"; };
  return '<div class="tb-row' + (r.status === "error" ? " err" : "") + '" data-idx="' + Number(r.idx) + '"'
    + ' title="' + esc(sum || "") + '">'
    + '<span class="n">' + Number(r.idx) + "</span>"
    + '<span class="k">' + esc(r.kind) + "</span>"
    + '<span class="s">' + esc(sum || "") + (r.synth ? ' <span class="tb-synth" title="轨迹文件已落盘但 journal 未入账">synth</span>' : "") + "</span>"
    + cell(r.durationMs, true) + cell(r.inputTokens) + cell(r.cachedTokens) + cell(r.outputTokens)
    + "<span>" + st + "</span></div>";
}
/** 行表:表头 + 轮分组。>1500 行只渲染最近 1500 行且**显式提示**(不静默截断)。 */
function trajBoardTableHtml(rows, turns) {
  const cap = capTrajRows(rows || []);
  const byTurn = {};
  (turns || []).forEach(function (t) { if (t) byTurn[Number(t.turn)] = t; });
  let html = "";
  if (cap.truncated) {
    html += '<div class="tb-warn">仅显示最近 ' + TRAJ_ROW_CAP + " 行(共 " + cap.total + " 行);完整数据请查看轨迹文件</div>";
  }
  html += '<div class="tb-hd"><span class="n">#</span><span class="k">类型</span><span class="s">摘要</span>'
    + '<span class="t">耗时</span><span class="t">输入</span><span class="t">缓存</span><span class="t">输出</span>'
    + '<span class="st">状态</span></div>';
  if (!cap.rows.length) return html + '<div class="tb-empty">没有匹配的行</div>';
  let curTurn = null;
 // 行表默认折叠 —— 每轮一个 <details>(无 open),点开才看到明细行;
 // .tb-trbody 用 content-visibility:auto,屏外组浏览器跳过布局/绘制。表头与轮头始终可见。
  const groups = [];
  cap.rows.forEach(function (r) {
    if (!groups.length || groups[groups.length - 1].turn !== r.turn) groups.push({ turn: r.turn, rows: [] });
    groups[groups.length - 1].rows.push(r);
  });
  groups.forEach(function (g) {
    const head = byTurn[g.turn] ? trajBoardTurnHeadHtml(byTurn[g.turn]) : '<div class="tb-trhead">第 ' + Number(g.turn) + " 轮</div>";
    html += '<details class="tb-rowfold" data-trfold="' + Number(g.turn) + '">'
      + '<summary class="tb-trsum">' + head + '<span class="tb-trnum">' + g.rows.length + " 行(点击展开)</span></summary>"
      + '<div class="tb-trbody">' + g.rows.map(trajBoardRowHtml).join("") + "</div></details>";
  });
  return html;
}
/** 右侧 inspector:选中行全部字段;错误文本单独一行(可选中复制)。 */
function trajBoardInspHtml(r) {
  if (!r) return '<span class="ihint">点一行看明细</span>';
  const row = function (k, v) { return '<div class="r"><span class="k">' + k + '</span><span class="v">' + esc(v === undefined || v === null || v === "" ? "-" : v) + "</span></div>"; };
  let html = row("序号 seq", r.seq) + row("轮", r.turn) + row("类型", r.kind) + row("标签", r.label)
    + row("摘要", r.summary)
    + row("耗时", r.durationMs === undefined ? "-" : fmtDuration(r.durationMs))
    + row("输入", r.inputTokens === undefined ? "-" : fmtTokens(r.inputTokens))
    + row("缓存", r.cachedTokens === undefined ? "-" : fmtTokens(r.cachedTokens))
    + row("输出", r.outputTokens === undefined ? "-" : fmtTokens(r.outputTokens))
    + (r.inputTokensEst === undefined || r.inputTokensEst === null ? "" : row("估算(触发用)", fmtTokens(r.inputTokensEst)))
    + (r.synth ? row("来源", "synth(轨迹文件已落盘,journal 未入账)") : "")
    + row("状态", r.status === "error" ? "错误" : r.status === "pending" ? "待结果" : "ok")
    + row("工具名", r.toolName) + row("toolCallId", r.toolCallId);
  if (r.error) html += '<div class="errtext">错误文本:' + esc(r.error) + "</div>";
  return html;
}
/** ===== 逐次决策视图(每次 llm.trace 一张卡,卡体懒加载全文) ===== */
/** 思考截断字数(thinking 可截断,正式 content 与入参必须完整)。 */
const TRAJ_THINK_CAP = 600;
/** 视图过滤:全部/模型=全部决策;工具=有工具调用;错误=失败决策;q 搜模型/摘要/工具名。 */
function filterDecisionRows(rows, mode, q) {
  const src = Array.isArray(rows) ? rows : [];
  const query = String(q || "").trim().toLowerCase();
  return src.filter(function (r) {
    if (!r || !r.traceFile) return false;
    const tools = Array.isArray(r.tools) ? r.tools : [];
    if (mode === "tool" && !tools.length) return false;
    if (mode === "error" && r.status !== "error") return false;
    if (!query) return true;
    return [r.label, r.summary, tools.join(" ")].join(" ").toLowerCase().indexOf(query) >= 0;
  });
}
/** 上一条决策的轨迹文件(公共前缀比较基准);首条返回空串。 */
function trajBoardPrevFile(file) {
  const files = trajBoardState.files || [];
  const at = files.indexOf(String(file || ""));
  return at > 0 ? files[at - 1] : "";
}
/** 卡片状态:是否展开 + 全文缓存态(纯读缓存,不发请求)。 */
function trajBoardCardState(file) {
  const key = String(file || "");
  if (!trajExpanded.has(key)) return { expanded: false };
  const hit = trajTraceCache.get(key);
  if (!hit) return { expanded: true, loading: true };
  if (hit.state === "loading") return { expanded: true, loading: true };
  if (hit.state === "err") return { expanded: true, err: hit.err };
  const prevKey = trajBoardPrevFile(key);
  const prevHit = prevKey ? trajTraceCache.get(prevKey) : null;
  return { expanded: true, trace: hit.data, prevTrace: prevHit && prevHit.state === "ok" ? prevHit.data : null };
}
/** 干条:只读 journal 摘要,零额外请求。 */
function trajBoardCardHeadHtml(r, n, expanded) {
  const bits = [];
  bits.push('<span class="n">#' + Number(n) + "</span>");
  bits.push('<span class="pos">' + esc("t" + Number(r.turn || 0) + " s" + (r.stepNo === undefined ? "-" : Number(r.stepNo))) + "</span>");
  bits.push('<span class="model">' + esc(r.label || "llm") + "</span>");
  if (r.synth) bits.push('<span class="tb-synth" title="轨迹文件已落盘但 journal 未入账(合成行,数据取自 trace 文件)">synth(未落journal)</span>');
  const durs = [];
  if (r.durationMs !== undefined) durs.push("耗时 " + fmtDuration(r.durationMs));
  if (r.ttftMs !== undefined) durs.push("首字 " + fmtDuration(r.ttftMs));
  if (durs.length) bits.push('<span class="num">' + esc(durs.join(" / ")) + "</span>");
  const toks = [];
 // 主数字一律 = LLM API 经验证 usage(input 缺/0 → 「输入 —」且不出命中%);本地估算只作次级「估算 Z(触发用)」。
 // usageSuspect 只出徽标,绝不改写主数字(经验证 85.8% 就显示 85.8%)。
 // 数值取证内联(不引外 helper):卡头是 panel-trace-full 抽取集里被单独求值的函数,必须自足。
  const estOf = function (v) {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const inEst = estOf(r.inputTokensEst);
  const inRep = estOf(r.inputTokens);
  const cachedRep = estOf(r.cachedTokens);
  if (inRep !== null && inRep > 0) {
    const cacheTxt = cachedRep !== null && cachedRep > 0
      ? "(缓存 " + fmtTokens(cachedRep) + ",命中 " + ((cachedRep / inRep) * 100).toFixed(1) + "%)" : "";
    toks.push("输入 " + fmtTokens(inRep) + " tok" + cacheTxt);
  } else {
 // 缺值/0/非数 → 主数字「—」(绝不写 0%,也不拿估算顶主位)。
    toks.push("输入 —");
  }
  if (inEst !== null && inEst > 0) toks.push("估算 " + fmtTokens(inEst) + "(触发用)");
  if (r.outputTokens !== undefined) toks.push("输出 " + fmtTokens(r.outputTokens) + " tok");
  if (toks.length) bits.push('<span class="num">' + esc(toks.join(" · ")) + "</span>");
  if (r.usageSuspect) {
    const why = r.usageAnomaly ? String(r.usageAnomaly) : "上游 usage 与本步输入不自洽";
    bits.push('<span class="tb-suspect" title="' + esc(why) + '">上游usage异常</span>');
  }
  const tools = Array.isArray(r.tools) ? r.tools : [];
  bits.push('<span class="tools">' + (tools.length ? "工具:" + esc(tools.slice(0, 6).join(", ")) + (tools.length > 6 ? " +" + (tools.length - 6) : "") : "无工具调用") + "</span>");
  if (r.status === "error") bits.push('<span class="bad">错误</span>');
  bits.push('<span class="fold">' + (expanded ? "收起" : "展开全文") + "</span>");
  return bits.join("");
}
/** 思考:超过 600 字截断并给明确标记(正文与工具参数不截断)。 */
function trajBoardThinkHtml(s) {
  const t = String(s || "");
  if (!t) return "";
  if (t.length <= TRAJ_THINK_CAP) return '<pre class="tb-c-pre think">' + esc(t) + "</pre>";
  return '<pre class="tb-c-pre think">' + esc(t.slice(0, TRAJ_THINK_CAP)) + "</pre>"
    + '<div class="tb-c-trunc">…(思考已截断,共 ' + t.length + " 字;完整内容见原始 trace 文件)</div>";
}
/** 工具参数:JSON 尽量美化;非 JSON 原样全文。 */
function trajBoardArgsText(v) {
  if (v === undefined || v === null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 1) || "";
  if (typeof v !== "string" || !s) return s;
  try { return JSON.stringify(JSON.parse(s), null, 1); } catch (e) { return s; }
}
/** 卡体(纯函数):已命中前缀一行省略 + 未命中消息逐条全文 + 输出全文 + thinking 截断 + 错误全文。 */
function trajBoardBodyHtml(r, trace, prevTrace) {
  const t = trace && typeof trace === "object" ? trace : {};
  const req = t.request && typeof t.request === "object" ? t.request : {};
  const msgs = Array.isArray(req.messages) ? req.messages : [];
  const prevMsgs = prevTrace && prevTrace.request && Array.isArray(prevTrace.request.messages) ? prevTrace.request.messages : [];
  const split = splitCachedInput(prevMsgs, msgs);
  let html = '<div class="tb-c-sec">未命中输入</div>';
  if (split.hitCount > 0) {
    html += '<div class="tb-c-hit">已命中前缀:' + Number(split.hitCount) + " 条 / 约 " + esc(fmtTokens(split.hitTokens)) + " tok(已省略)</div>";
  } else {
    html += '<div class="tb-c-hit">已命中前缀:0 条' + (prevMsgs.length ? "(与上一次请求无公共前缀)" : "(首调或无上一次请求)") + "</div>";
  }
  if (!split.miss.length) html += '<div class="tb-c-none">无未命中消息(本次请求与上一次完全相同)</div>';
  for (let i = 0; i < split.miss.length; i++) {
    const raww = split.miss[i];
    const mo = raww && typeof raww === "object" ? raww : { content: String(raww === undefined ? "" : raww) };
    const role = String(mo.role || "?");
    const text = msgTextOf(mo);
    const idx = Number(split.hitCount) + i + 1;
    const head = '<div class="h"><span class="role">' + esc(role) + '</span><span>#' + idx + "</span><span>约 " + esc(fmtTokens(approxTokens(text + role))) + " tok</span>"
      + (mo.toolCallId ? "<span>" + esc(String(mo.toolCallId)) + "</span>" : "") + "</div>";
    if (role === "system" && text.length > 400) {
      html += '<div class="tb-c-msg sys">' + head + '<details class="tb-c-det"><summary>system 提示词全文(完整 ' + text.length + ' 字,点击展开)</summary><pre class="tb-c-pre">' + esc(text) + "</pre></details></div>";
    } else if (text.length > 400) {
 // 正文默认折叠(<details> 无 open),点开才渲染成片 read
      html += '<div class="tb-c-msg">' + head + '<details class="tb-c-det"><summary>' + esc(role) + ' 正文(完整 ' + text.length + ' 字,点击展开)</summary><pre class="tb-c-pre">' + esc(text) + "</pre></details></div>";
    } else {
      html += '<div class="tb-c-msg' + (role === "system" ? " sys" : "") + '">' + head + '<pre class="tb-c-pre">' + esc(text) + "</pre></div>";
    }
  }
  const resp = t.response && typeof t.response === "object" ? t.response : {};
  const content = typeof resp.content === "string" ? resp.content : resp.content && typeof resp.content === "object" ? JSON.stringify(resp.content, null, 1) : "";
  html += '<div class="tb-c-sec">输出</div>';
  html += content
    ? (content.length > 400
      ? '<details class="tb-c-det"><summary>输出全文(完整 ' + content.length + ' 字,点击展开)</summary><pre class="tb-c-pre out">' + esc(content) + "</pre></details>"
      : '<pre class="tb-c-pre out">' + esc(content) + "</pre>")
    : '<div class="tb-c-none">(无文本输出)</div>';
  const calls = Array.isArray(resp.toolCalls) ? resp.toolCalls : [];
  for (let i = 0; i < calls.length; i++) {
    const co = calls[i] && typeof calls[i] === "object" ? calls[i] : {};
    const argText = trajBoardArgsText(co.arguments);
    html += '<div class="tb-c-msg"><div class="h"><span class="role">toolCall</span><span>#' + (i + 1) + "</span><span>" + esc(String(co.name || "")) + "</span>"
      + (co.id ? "<span>" + esc(String(co.id)) + "</span>" : "") + '</div><details class="tb-c-det"><summary>参数(完整 ' + argText.length + ' 字,点击展开)</summary><pre class="tb-c-pre">' + esc(argText) + "</pre></details></div>";
  }
  const think = trajBoardThinkHtml(resp.reasoning);
  if (think) html += '<div class="tb-c-sec">思考</div>' + think;
  const errTxt = r && r.error ? String(r.error) : t.error ? String(t.error) : "";
  if (errTxt) html += '<div class="tb-c-sec">错误</div><pre class="tb-c-pre err">' + esc(errTxt) + "</pre>";
  const meta = ["turn " + Number(t.turn === undefined ? (r && r.turn) || 0 : t.turn), "step " + (t.step === undefined ? "-" : Number(t.step)), String(t.model || (r && r.label) || "?"), t.ts ? new Date(Number(t.ts)).toLocaleString() : ""].join(" · ");
  html += '<div class="tb-c-none">' + esc(meta) + "</div>";
  const file = r && r.traceFile ? String(r.traceFile) : "";
  html += '<div class="tb-c-foot">原始 trace 文件:<span class="p">' + esc(file || "(无文件指针)") + "</span>"
    + (file ? '<span class="tb-c-copy" data-traj-copy="' + esc(file) + '">复制路径</span>' : "") + "</div>";
  return html;
}
/** 单卡 HTML(卡体只在展开时挂载;未缓存=占位,由 trajBoardMountBodies 触发拉取)。 */
function trajBoardCardHtml(r, n, st) {
  const s = st || {};
  const file = String(r.traceFile || "");
  let html = '<div class="tb-card' + (r.status === "error" ? " err" : "") + '" data-trace-card="' + Number(r.idx) + '" data-trace-file="' + esc(file) + '">'
    + '<div class="tb-c-head">' + trajBoardCardHeadHtml(r, n, !!s.expanded) + "</div>";
  if (!s.expanded) return html + "</div>";
  if (s.loading) return html + '<div class="tb-c-body"><div class="tb-c-loading">正文加载中…(按需拉取 trace 文件)</div></div></div>';
  if (s.err) return html + '<div class="tb-c-body"><div class="tb-c-none">全文读取失败:' + esc(String(s.err)) + "</div></div></div>";
  if (s.trace) return html + '<div class="tb-c-body">' + trajBoardBodyHtml(r, s.trace, s.prevTrace) + "</div></div>";
  return html + '<div class="tb-c-body"><div class="tb-c-loading">正文未就绪</div></div></div>';
}
/** 从事件流取 context.prune(只有真剪枝事件才落卡;没有=空数组,不凭空多一张卡)。 */
function trajPruneItems(events) {
  const evs = Array.isArray(events) ? events : [];
  const out = [];
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i];
    if (e && e.kind === "context.prune") out.push({ seq: Number(e.seq) || 0, ev: e });
  }
  return out;
}
/**
 * context.prune 独立卡。剪枝不是 LLM 决策,不能伪装成决策卡(无干条 token/工具),
 * 只给:时间 / 压了几项 / 省多少 tok / 原因,payload 有 policy 才显示(当前 loop 不上报就省略,不造假)。
 */
function trajBoardPruneCardHtml(ev, n) {
  const e = ev && typeof ev === "object" ? ev : {};
  const p = e.payload && typeof e.payload === "object" ? e.payload : {};
  const at = trajNumOrNull(e.time);
  let timeTxt = "-";
  if (at !== null && at > 0) {
    try { timeTxt = new Date(at).toLocaleTimeString(); } catch (err) { timeTxt = "-"; }
  }
  const items = Array.isArray(p.items) ? p.items.length : 1;
  const saved = trajNumOrNull(p.savedTokens);
  const reason = p.reason === undefined || p.reason === null ? "" : String(p.reason);
  const policy = p.policy === undefined || p.policy === null ? "" : String(p.policy);
  const bits = [];
  bits.push('<span class="n">#p' + Number(n) + "</span>");
  bits.push('<span class="pos">prune</span>');
  bits.push('<span class="model">上下文剪枝</span>');
  bits.push('<span class="lbl">时间</span><span class="num">' + esc(timeTxt) + "</span>");
  bits.push('<span class="lbl">压缩</span><span class="num">压 ' + Number(items) + " 项</span>");
  if (saved !== null && saved > 0) bits.push('<span class="lbl">节省</span><span class="num">省 ' + esc(fmtTokens(saved)) + " tok</span>");
  bits.push('<span class="lbl">原因</span><span class="tools">' + esc(reason || "(未上报)") + "</span>");
  if (policy) bits.push('<span class="lbl">policy</span><span class="tools">' + esc(policy) + "</span>");
  return '<div class="tb-card tb-prune" data-prune-seq="' + Number(e.seq || 0) + '">'
    + '<div class="tb-c-head">' + bits.join("") + "</div></div>";
}
/** 从事件流取 context.intake(大结果入口闸门);没有=空数组,不凭空多卡。 */
function trajIntakeItems(events) {
  const evs = Array.isArray(events) ? events : [];
  const out = [];
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i];
    if (e && e.kind === "context.intake") out.push({ seq: Number(e.seq) || 0, ev: e });
  }
  return out;
}
/**
 * context.intake 最小渲染(tip-line 形态,不抢决策卡的视觉权重)。
 * 只给用户点名要的四项:时间 / 工具 / 原量→入上下文量 / 策略(+落盘路径)。
 */
function trajBoardIntakeCardHtml(ev, n) {
  const e = ev && typeof ev === "object" ? ev : {};
  const p = e.payload && typeof e.payload === "object" ? e.payload : {};
  const at = trajNumOrNull(e.time);
  let timeTxt = "-";
  if (at !== null && at > 0) {
    try { timeTxt = new Date(at).toLocaleTimeString(); } catch (err) { timeTxt = "-"; }
  }
  const tool = p.tool === undefined || p.tool === null ? "-" : String(p.tool);
  const policy = p.policy === undefined || p.policy === null ? "-" : String(p.policy);
  const chars = trajNumOrNull(p.chars);
  const keptChars = trajNumOrNull(p.keptChars);
  const digestChars = trajNumOrNull(p.digestChars);
  const inChars = (digestChars !== null && digestChars > 0) ? digestChars : (keptChars === null ? null : keptChars);
  const sizeTxt = (chars === null ? "?" : String(chars)) + " → " + (inChars === null ? "?" : String(inChars)) + " 字符";
  const chunks = trajNumOrNull(p.chunks);
  const keptChunks = trajNumOrNull(p.keptChunks);
  const dropped = trajNumOrNull(p.droppedChunks);
  const dumpPath = p.dumpPath === undefined || p.dumpPath === null ? "" : String(p.dumpPath);
  const bits = [];
  bits.push('<span class="tl-tag">intake #' + Number(n) + "</span>");
  bits.push('<span class="tl-keys">' + esc(tool) + "</span>");
  bits.push(esc(sizeTxt));
  bits.push('<span class="tl-tag">' + esc(policy) + "</span>");
  bits.push('<span class="tl-meta">' + esc(timeTxt) + "</span>");
  const body = []
    .concat(chunks === null ? [] : ["切块 " + Number(chunks) + " / 保留 " + Number(keptChunks === null ? 0 : keptChunks) + " / 筛掉 " + Number(dropped === null ? 0 : dropped)])
    .concat(p.scorer ? ["打分器:" + String(p.scorer)] : [])
    .concat(p.durationMs ? ["耗时:" + Number(p.durationMs) + "ms"] : [])
    .concat(dumpPath ? ["全文:" + dumpPath] : ["全文未能落盘" + (p.dumpError ? "(" + String(p.dumpError) + ")" : "")])
    .join("<br>");
  return '<details class="tip-line" data-intake-seq="' + Number(e.seq || 0) + '"><summary>' + bits.join("")
    + '</summary><div class="tl-body">' + esc(body) + "</div></details>";
}
/** 决策列表(轮分组头复用账本表口径)。context.prune 按 seq 与决策卡合流成独立卡。 */
function trajBoardCardsHtml(rows) {
  const src = Array.isArray(rows) ? rows : [];
  const mode = trajBoardState.mode || "all";
  const sideFiltered = mode === "tool" || mode === "error" || String(trajBoardState.q || "").trim();
  const prunes = sideFiltered
    ? [] : (Array.isArray(trajBoardState.prunes) ? trajBoardState.prunes.slice() : [])
      .sort(function (a, b) { return Number(a && a.seq || 0) - Number(b && b.seq || 0); });
 // context.intake 与 context.prune 同为旁路事件卡,合成一条按 seq 的流(不改各自渲染)。
  const intakes = sideFiltered
    ? [] : (Array.isArray(trajBoardState.intakes) ? trajBoardState.intakes.slice() : [])
      .sort(function (a, b) { return Number(a && a.seq || 0) - Number(b && b.seq || 0); });
  if (!src.length && !prunes.length && !intakes.length) return '<div class="tb-empty">没有匹配的决策</div>';
  const ord = trajBoardState.ord || {};
  const byTurn = {};
  (trajBoardState.turns || []).forEach(function (t) { if (t) byTurn[Number(t.turn)] = t; });
  let html = '<div class="tb-warn">共 ' + src.length + " 次 LLM 决策(按发生顺序平铺;全部默认折叠,点卡头才拉取并展开正文)"
    + (prunes.length ? " · 另有 " + prunes.length + " 次上下文剪枝" : "")
    + (intakes.length ? " · " + intakes.length + " 次大结果闸门" : "") + "</div>";
  let curTurn = null, pn = 0, pi = 0, inum = 0, ii = 0;
  const flushPrunes = function (upto) {
    while (pi < prunes.length && Number(prunes[pi] && prunes[pi].seq || 0) <= upto) {
      pn++;
      html += trajBoardPruneCardHtml(prunes[pi].ev, pn);
      pi++;
    }
    while (ii < intakes.length && Number(intakes[ii] && intakes[ii].seq || 0) <= upto) {
      inum++;
      html += trajBoardIntakeCardHtml(intakes[ii].ev, inum);
      ii++;
    }
  };
  for (let i = 0; i < src.length; i++) {
    const r = src[i];
    flushPrunes(Number(r.seq === undefined ? -1 : r.seq));
    if (r.turn !== curTurn) {
      curTurn = r.turn;
      html += byTurn[r.turn] ? trajBoardTurnHeadHtml(byTurn[r.turn]) : '<div class="tb-trhead">第 ' + Number(r.turn) + " 轮</div>";
    }
    html += trajBoardCardHtml(r, ord[String(r.traceFile || "")] || i + 1, trajBoardCardState(String(r.traceFile || "")));
  }
  flushPrunes(Infinity);
  return html;
}
// ===== 泳道 pane(从 status-widget.js 移植为 PAGE 内纯函数,唯一数据源 = histEvents)=====
// 事件形状 { seq, kind, time, sessionId, payload };time 由 journal 落盘时补,老会话事件可能没有 time
// → 坐标一律按 seq 兜底,绝不产出 NaN/空轴(退化路径有负面断言)。
/** 工具失败归因中文标签(origin 由 loop 落账 tool.result.payload.error.origin)。 */
const TRAJ_LANE_ERR_LABEL = { "unknown-tool": "未知工具", "timeout": "超时", "threw": "抛错", "aborted": "已取消", "denied": "被拒" };
/** 模型短名:去厂商前缀(取最后一个 / 之后),超 14 字符截 12 + 「…」;非字符串→空串(调用方据此不显示)。 */
function trajLaneShortModel(m) {
  if (typeof m !== "string") return "";
  let s = m.trim();
  const i = s.lastIndexOf("/");
  if (i >= 0) s = s.slice(i + 1);
  if (!s) return "";
  return s.length > 14 ? s.slice(0, 12) + "…" : s;
}
function trajLaneFmtMs(ms) {
  return ms >= 10000 ? Math.round(ms / 1000) + "s" : ms >= 1000 ? (Math.round(ms / 100) / 10) + "s" : ms + "ms";
}
/** 单条事件 → 泳道记录(lane/cls/label/sub/dur/err/full);返回 null = 不进泳道(tool.call 与 result 合并展示)。 */
function trajLaneRecord(e) {
  const p = (e && e.payload) || {};
  const kind = String((e && e.kind) || "");
  switch (kind) {
    case "message.user": return { lane: "message", cls: "user", label: "用户", sub: String(p.text || "").slice(0, 40), dur: 0 };
    case "message.agent": {
      const tok = p.usage ? " · " + (p.usage.totalTokens != null ? p.usage.totalTokens : (p.usage.inputTokens || 0) + (p.usage.outputTokens || 0)) + "tok" : "";
      const mdl = trajLaneShortModel(p.model);
      const rec = {
        lane: "message", cls: "", label: "AI " + (p.llmMs != null ? trajLaneFmtMs(p.llmMs) : "") + (mdl ? " · " + mdl : ""),
        sub: String(p.text || "").slice(0, 40) + tok, dur: typeof p.llmMs === "number" ? p.llmMs : 0,
        err: /错误|error/i.test(String(p.text || "")),
      };
      if (mdl) rec.full = String(p.model); // 完整名只进 title,不占版面
      return rec;
    }
    case "tool.result": {
      const terr = p.error && typeof p.error === "object" ? p.error : null;
      const errTag = terr && terr.origin ? TRAJ_LANE_ERR_LABEL[terr.origin] || terr.origin : "";
      const isErr = !!terr || /^错误/.test(String(p.content || ""));
      return { lane: "tool", cls: "", label: p.name || "tool", sub: trajLaneFmtMs(p.durationMs || 0) + (errTag ? " · " + errTag : ""), dur: p.durationMs || 0, err: isErr };
    }
    case "tool.call": return null; // 与 tool.result 合并展示(配对纪律),避免泳道重复
    case "todo.updated": return { lane: "system", cls: "", label: "todo", sub: (p.items || []).length + " 项", dur: 0 };
    case "subagent.spawn": {
      const spm = trajLaneShortModel(p.model);
      const srec = { lane: "system", cls: "", label: "spawn", sub: (spm ? spm + " · " : "") + String(p.instructions || "").slice(0, 24), dur: 0 };
      if (spm) srec.full = String(p.model);
      return srec;
    }
    case "workflow.run.start": return { lane: "system", cls: "", label: "wf", sub: String(p.wfId || ""), dur: 0 };
    default:
      if (kind.indexOf("compact.") === 0) return { lane: "system", cls: "", label: "压缩", sub: "", dur: 0 };
      return null;
  }
}
/** 聚合摘要(只读):事件分布 + 最慢工具 + 工具错误计数。空事件→空串(整区不占版面)。
 * 口径说明:数据源是本会话 histEvents,与服务端 trace.query 的 summary 无关(该协议本轮只删前端消费者)。 */
function trajLaneSumHtml(events) {
  const evs = Array.isArray(events) ? events : [];
  if (!evs.length) return "";
  const kc = {}, tools = {};
  let errs = 0;
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i] || {};
    const kind = String(e.kind || "");
    kc[kind] = (kc[kind] || 0) + 1;
    if (kind !== "tool.result") continue;
    const p = e.payload || {};
    const nm = String(p.name || "tool");
    const t = tools[nm] || (tools[nm] = { name: nm, max: 0, count: 0, err: 0 });
    t.count++;
    const d = Number(p.durationMs) || 0;
    if (d > t.max) t.max = d;
    if (p.error || /^错误/.test(String(p.content || ""))) { t.err++; errs++; }
  }
  const kHead = Object.keys(kc).sort(function (a, b) { return kc[b] - kc[a]; }).slice(0, 5)
    .map(function (k) { return esc(k) + " " + kc[k]; }).join(" · ");
  const slow = Object.keys(tools).map(function (k) { return tools[k]; })
    .sort(function (a, b) { return b.max - a.max; }).slice(0, 3)
    .map(function (t) {
      return "<span" + (t.err ? ' class="err"' : "") + ">" + esc(t.name) + " " + esc(trajLaneFmtMs(t.max)) + " ×" + t.count + "</span>";
    }).join(" · ");
  const rows = [];
  rows.push('<span class="k">事件分布</span><span>' + (kHead || "—") + " · 共 " + evs.length + " 条"
    + (errs ? ' · <span class="err">工具错误 ' + errs + " 次</span>" : "") + "</span>");
  rows.push('<span class="k">最慢工具</span><span>' + (slow || "无工具事件") + "</span>");
  return rows.join("");
}
/** 三泳道 HTML(工具/消息/系统三轨 + turn 分隔线);mode = sequence|duration|time。 */
function trajLaneHtml(events, mode) {
  const all = Array.isArray(events) ? events : [];
  const evs = all.slice(-500); // 无虚拟化:与 trace.query 的 limit=500 同口径,超限截断并在注脚标注
  const m = mode === "time" || mode === "duration" ? mode : "sequence";
  const at = function (e) { const t = Number(e && e.time); return isFinite(t) && t > 0 ? t : Number((e && e.seq) || 0); };
  const t0 = evs.length ? at(evs[0]) : 0, t1 = evs.length ? at(evs[evs.length - 1]) : 1;
  const recs = [], turns = [];
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i] || {};
    if (e.kind === "turn.start") turns.push({ idx: recs.length, turn: (e.payload || {}).turn });
    const r = trajLaneRecord(e);
    if (r) recs.push({ r: r, e: e, i: recs.length });
  }
  const W = Math.max(recs.length * 96, 320), H = Math.max(t1 - t0, 1);
  function xOf(rec) {
    if (m === "time") return 8 + ((at(rec.e) - t0) / H) * (W - 100);
    return rec.i * 96 + 8; // sequence / duration:横向同序列(duration 用块内底边条表达时长)
  }
  const laneHtml = ["tool", "message", "system"].map(function (lane) {
    const inner = [];
    for (let j = 0; j < recs.length; j++) {
      const rec = recs[j];
      if (rec.r.lane !== lane) continue;
      const x = Math.max(0, Math.round(xOf(rec)));
      const durBar = (m === "duration" && rec.r.dur > 0)
        ? '<span class="dur" style="width:' + Math.min(74, Math.max(6, Math.round(rec.r.dur / 30))) + 'px"></span>' : "";
      inner.push('<div class="sw-rec ' + rec.r.cls + (rec.r.err ? " err" : "") + '" style="left:' + x + 'px" title="'
        + esc(rec.r.label + " " + rec.r.sub + (rec.r.full ? " · " + rec.r.full : "")) + '">'
        + esc(rec.r.label) + "<br>" + esc(rec.r.sub) + durBar + "</div>");
    }
 // turn 边界竖线(以 turn.start 之后的记录序定位;无记录时整条不画)
    const lines = turns.map(function (t) {
      const anchor = recs[t.idx] || recs[0];
      if (!anchor) return "";
      return '<div class="sw-turn" style="left:' + Math.max(0, Math.round(xOf(anchor)) - 12) + 'px"><span>T' + esc(String(t.turn)) + "</span></div>";
    }).join("");
    const name = lane === "tool" ? "工 具" : lane === "message" ? "消 息" : "系 统";
    return '<div class="sw-lane" data-lane="' + lane + '"><div class="sw-lane-label">' + name
      + '</div><div style="position:relative;width:' + W + 'px">' + lines + inner.join("") + "</div></div>";
  }).join("");
  const note = '<div class="tb-empty">' + (evs.length < all.length ? "本地超 500 已截断(显示最近 " + evs.length + ") · " : "")
    + recs.length + " 条记录 · 泳道模式=" + m + "</div>";
  return laneHtml + note;
}
/** 重渲:按 pane 分派(逐次决策=卡片;事件账本=行表;泳道=三轨 + 聚合摘要)。 */
function trajBoardRenderRows() {
  const pane = trajBoardState.pane === "ledger" ? "ledger" : trajBoardState.pane === "lanes" ? "lanes" : "decisions";
  const cardsHost = $("trajCardsHost"), rowsHost = $("trajRowsHost"), insp = $("trajInsp");
  const lanesHost = $("trajLanesHost"), laneSum = $("trajLaneSum"), laneBar = $("trajLaneBar");
  if (cardsHost) cardsHost.style.display = pane === "decisions" ? "block" : "none";
  if (rowsHost) rowsHost.style.display = pane === "ledger" ? "block" : "none";
  if (insp) insp.style.display = pane === "ledger" ? "block" : "none";
  if (lanesHost) lanesHost.style.display = pane === "lanes" ? "block" : "none";
  if (laneBar) laneBar.style.display = pane === "lanes" ? "flex" : "none";
  if (laneSum) laneSum.style.display = "none";
  if (pane === "lanes") {
    const box = $("trajLanesBox");
    if (box) box.innerHTML = trajLaneHtml(histEvents, trajBoardState.lmode);
    const sumHtml = trajLaneSumHtml(histEvents);
    if (laneSum) { laneSum.innerHTML = sumHtml; laneSum.style.display = sumHtml ? "flex" : "none"; }
    trajBoardState.view = [];
    return;
  }
  const rows = filterTrajRows(trajBoardState.rows, trajBoardState.mode, trajBoardState.q);
  if (pane === "ledger") {
    trajBoardState.view = rows;
    if (!rowsHost) return;
    rowsHost.innerHTML = trajBoardTableHtml(rows, groupTrajTurns(rows));
    trajBoardMarkSel();
    return;
  }
  const cards = filterDecisionRows(trajBoardState.rows, trajBoardState.mode, trajBoardState.q);
  trajBoardState.view = cards;
  if (!cardsHost) return;
  const keep = cardsHost.scrollTop;
  cardsHost.innerHTML = trajBoardCardsHtml(cards);
  cardsHost.scrollTop = keep;
  trajBoardMountBodies();
}
/** 展开态里还没拿到全文的卡:逐个拉(单卡最多 2 个文件:本卡 + 上一条用于前缀比较;缓存命中不重拉)。 */
function trajBoardMountBodies() {
  const host = $("trajCardsHost");
  if (!host) return;
  const cards = host.querySelectorAll("[data-trace-file]");
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const file = card.getAttribute("data-trace-file") || "";
    if (!file || !trajExpanded.has(file)) continue;
    const body = card.querySelector(".tb-c-body");
    if (!body || body.getAttribute("data-mounted") === "1") continue;
    body.setAttribute("data-mounted", "1");
    trajBoardLoadNeighborhood(file, function () { trajBoardPatchCard(card.getAttribute("data-trace-card") || ""); });
  }
}
/** 拉全文(带缓存与在飞等待;失败也结算,由调用方渲染错误态)。 */
function trajBoardFetchTrace(file, cb) {
  const key = String(file || "");
  const done = function (rec) { if (cb) cb(rec); };
  if (!key) { done({ state: "err", err: "无文件指针" }); return; }
  const hit = trajTraceCache.get(key);
  if (hit && hit.state === "loading") { (hit.waiters = hit.waiters || []).push(done); return; }
  if (hit) { done(hit); return; }
  const rec = { state: "loading", waiters: [done] };
  trajTraceCache.set(key, rec);
  const settle = function (next) {
    rec.state = next.state; rec.data = next.data; rec.err = next.err;
    const ws = rec.waiters || [];
    rec.waiters = [];
    for (let i = 0; i < ws.length; i++) { try { ws[i](rec); } catch (e) { /* 渲染回调异常不扩散 */ } }
  };
  try {
    fetch("/api/llm-trace?path=" + encodeURIComponent(key)).then(function (resp) {
      if (!resp.ok) return resp.text().then(function (txt) { throw new Error("HTTP " + resp.status + " " + String(txt || "").slice(0, 160)); });
      return resp.json();
    }).then(function (data) { settle({ state: "ok", data: data }); })
      .catch(function (e) { settle({ state: "err", err: String((e && e.message) || e).slice(0, 200) }); });
  } catch (e) {
    settle({ state: "err", err: String((e && e.message) || e).slice(0, 200) });
  }
}
/** 本卡 + 上一条(前缀比较基准);两者都结算后才回调。 */
function trajBoardLoadNeighborhood(file, cb) {
  const jobs = [String(file || "")];
  const prev = trajBoardPrevFile(file);
  if (prev) jobs.push(prev);
  let left = jobs.length;
  const tick = function () { left--; if (left <= 0 && cb) cb(); };
  for (let i = 0; i < jobs.length; i++) trajBoardFetchTrace(jobs[i], tick);
}
/** 就地重画一张卡(不整表重渲,保住滚动与其它展开卡)。 */
function trajBoardPatchCard(idx) {
  const host = $("trajCardsHost");
  if (!host) return;
  const rows = trajBoardState.view || [];
  let row = null;
  for (let i = 0; i < rows.length; i++) if (Number(rows[i].idx) === Number(idx)) { row = rows[i]; break; }
  if (!row) return;
  const kids = host.children;
  for (let i = 0; i < kids.length; i++) {
    const el = kids[i];
    if (Number(el.getAttribute("data-trace-card")) !== Number(idx)) continue;
    const ord = trajBoardState.ord || {};
    const tmp = document.createElement("div");
    tmp.innerHTML = trajBoardCardHtml(row, ord[String(row.traceFile || "")] || 1, trajBoardCardState(String(row.traceFile || "")));
    const next = tmp.firstElementChild;
    if (next && el.parentNode) el.parentNode.replaceChild(next, el);
    trajBoardMountBodies();
    return;
  }
}
/** 点卡头:展开/收起(收起即释放 DOM,避免多张 2MB 卡体同时挂着)。 */
function trajBoardToggleCard(idx) {
  const rows = trajBoardState.view || [];
  let row = null;
  for (let i = 0; i < rows.length; i++) if (Number(rows[i].idx) === Number(idx)) { row = rows[i]; break; }
  if (!row) return;
  const file = String(row.traceFile || "");
  if (!file) { toast("这一行没有轨迹文件指针", "warn"); return; }
  if (trajExpanded.has(file)) trajExpanded.delete(file); else trajExpanded.add(file);
  trajBoardPatchCard(idx);
}
/** 全部展开:当前可见范围内前 30 张(每张按需拉取,避免一次拉上百个文件)。 */
function trajBoardExpandAll() {
  const rows = trajBoardState.view || [];
  if (!rows.length) return;
  const n = Math.min(rows.length, TRAJ_EXPAND_ALL_MAX);
  for (let i = 0; i < n; i++) if (rows[i].traceFile) trajExpanded.add(String(rows[i].traceFile));
  trajBoardRenderRows();
  toast("已展开 " + n + " 张卡" + (rows.length > n ? "(共 " + rows.length + " 张,单次上限 " + TRAJ_EXPAND_ALL_MAX + ")" : ""));
}
/** 实时:histEvents 增长后由会话增量入口调用;仅当用户已在底部才自动滚底。 */
function trajBoardLiveSync() {
  const box = $("trajBoard");
  if (!box || box.style.display === "none" || !histEvents) return;
  const files = [];
  for (let i = 0; i < histEvents.length; i++) {
    const e = histEvents[i];
    if (e && e.kind === "llm.trace" && e.payload && e.payload.file) files.push(String(e.payload.file));
  }
  const key = files.join("|");
  if (key === (trajBoardState.filesKey || "")) return;
  const host = $("trajCardsHost");
  const atBottom = host ? host.scrollTop + host.clientHeight >= host.scrollHeight - 12 : true;
 // 新决策=新卡:只刷新卡头列表,不自动展开、不拉全文(默认折叠,不主动展示详情)
  const prevFiles = trajBoardState.filesKey ? String(trajBoardState.filesKey).split("|") : [];
  const added = files.filter(function (f) { return prevFiles.indexOf(f) < 0; });
  trajBoardRefresh();
  if (added.length && atBottom && host) host.scrollTop = host.scrollHeight;
}
/** 看板是否在场(overlay 打开)。dashboard.changed 拉史只在在场时发生,关着=零额外请求。 */
function trajBoardOn() {
  const b = $("trajBoard");
  return !!(b && b.style.display !== "none");
}
/** 选中态高亮 + inspector 填充(data-idx 用的是 r.idx 原值,截断后仍可回指)。 */
function trajBoardMarkSel() {
  const host = $("trajRowsHost");
  if (!host) return;
  const idx = trajBoardState.sel;
  const rows = host.querySelectorAll(".tb-row");
  for (let i = 0; i < rows.length; i++) {
    const on = Number(rows[i].getAttribute("data-idx")) === idx;
    if (on) rows[i].classList.add("sel"); else rows[i].classList.remove("sel");
  }
  const hit = trajBoardState.rows.filter(function (r) { return Number(r.idx) === idx; })[0];
  $("trajInsp").innerHTML = trajBoardInspHtml(hit);
}
/** 打开时取快照:histEvents 为 null=会话重放还在路上 → 空态「事件加载中」。 */
function trajBoardRefresh() {
  const box = $("trajBoard");
  if (!box) return;
  const sid = currentSid ? String(currentSid) : "";
  $("trajBoardSid").textContent = sid ? sid.slice(0, 22) : "草稿态(无会话)";
  $("trajBoardSid").title = sid || "草稿态没有会话 id";
  $("trajInsp").innerHTML = trajBoardInspHtml(null);
  if (!histEvents) {
    $("trajBoardSum").innerHTML = "";
    $("trajRowsHost").innerHTML = '<div class="tb-empty">事件加载中</div>';
 // 泳道 pane 同源兜底:事件未到不渲染半截泳道(空串=整区不占版面)
    if ($("trajLanesBox")) $("trajLanesBox").innerHTML = "";
    if ($("trajLaneSum")) { $("trajLaneSum").innerHTML = ""; $("trajLaneSum").style.display = "none"; }
    trajBoardState.rows = []; trajBoardState.turns = []; trajBoardState.view = []; trajBoardState.sel = -1; trajBoardState.prunes = []; trajBoardState.intakes = [];
    return;
  }
  const events = histEvents || [];
 // 行级估算口径(次级,「估算 Z(触发用)」)与 context.prune 独立卡数据源 —— 都从同一批 histEvents 取,零额外请求。
  const rows = decorateTrajUsage(buildTrajRows(events), events);
  trajBoardState.prunes = trajPruneItems(events);
  trajBoardState.intakes = trajIntakeItems(events);
  trajBoardState.sel = -1;
  trajBoardApplyRows(rows);
  trajBoardSynthHeal(rows);
}
/** 把一批行装配进看板状态并渲染一次(原 refresh 尾段;自愈合并后同口径再渲一次)。 */
function trajBoardApplyRows(rows) {
  const src = Array.isArray(rows) ? rows : [];
  const turns = groupTrajTurns(src);
  trajBoardState.rows = src;
  trajBoardState.turns = turns;
 // 决策卡顺序表:全量 llm.trace 的文件序列 —— 卡号、上一条(前缀比较基准)、实时去重都用它。
  const files = [], ord = {};
  let nth = 0;
  for (let i = 0; i < src.length; i++) {
    const f = src[i] && src[i].traceFile ? String(src[i].traceFile) : "";
    if (!f) continue;
    nth++;
    files.push(f);
    if (ord[f] === undefined) ord[f] = nth; else ord[f] = ord[f]; // 同文件重复(重放)只认首个序号
  }
  trajBoardState.files = files;
  trajBoardState.ord = ord;
  trajBoardState.filesKey = files.join("|");
 // 看板所有内容默认折叠,不主动展示详情 ——
 // 自动展开最新卡会立刻拉取 2MB 级 trace 全文并整片塞进 DOM,打开面板即卡死界面。
 // 现在只有用户点卡头(trajBoardToggleCard)或点「全部展开」才渲染正文。
  trajBoardInitDone = true;
  $("trajBoardSum").innerHTML = trajBoardSumHtml(summarizeTraj(src, turns), trajBoardUsageTotals(src));
  trajBoardRenderRows();
}
/** 丢事件自愈(2026-11):journal 里没入账、但 trace 文件已落盘的调用 → 合成行补进看板(synth 标记)。
 * 只在「文件数 > 已入账数」时合并重渲一次;接口不可用/无新文件 → 静默,不影响既有渲染。 */
function trajBoardSynthHeal(rows) {
  const sid = currentSid ? String(currentSid) : "";
  if (!sid || typeof fetch !== "function") return;
  const src = Array.isArray(rows) ? rows : [];
  let accounted = 0;
  for (let i = 0; i < src.length; i++) if (src[i] && src[i].traceFile) accounted++;
  const key = sid + ":" + accounted;
  if (trajBoardState.synthKey === key) return;
  trajBoardState.synthKey = key;
  fetch("/api/llm-trace/list?sid=" + encodeURIComponent(sid)).then(function (resp) {
    return resp && resp.ok ? resp.json() : null;
  }).then(function (j) {
    const files = j && Array.isArray(j.files) ? j.files : [];
    if (!files.length || files.length <= accounted) return;
    if (String(currentSid || "") !== sid) return; // 期间切了会话:本次结果丢弃
    const base = trajBoardState.rows || src;
    const merged = mergeSynthRows(base, files);
    if (merged.length === base.length) return;
    trajBoardApplyRows(merged);
  }).catch(function () { /* 静默:自愈失败不影响原有渲染 */ });
}
/** 进入轨迹视图后的补偿:停在最新决策(滚动位置;视图身份/显隐由 switchView 统一管)。
 * 原全屏 overlay 的打开/关闭/Esc/遮罩关闭分支已删——视图常驻,
 * 「关闭」等价于切到别的视图,不再有 display 开关与 body 滚动锁。 */
function trajViewFocusLatest() {
  const host = $("trajCardsHost");
  if (host && trajBoardState.pane === "decisions") host.scrollTop = host.scrollHeight;
}
// ---- 入口 1:composer「轨迹」pill(改走视图路由,不再开浮层)----
$("trajBoardBtn").onclick = () => { switchView("traj"); trajViewFocusLatest(); };
// ---- 入口 2:轨迹卡 summary 的「看板」(capture 阶段拦下:不能触发 details 展开)----
document.addEventListener("click", function (e) {
  const t = e.target;
  if (!t || !t.closest) return;
  const open = t.closest("[data-traj-open]");
  if (!open) return;
  e.preventDefault();
  e.stopPropagation();
  switchView("traj");
  trajViewFocusLatest();
}, true);
// ---- 入口 3:视图头「刷新」(数据源=histEvents,重渲零额外请求)----
$("trajViewRefresh").onclick = () => trajBoardRefresh();
// ---- 过滤 chip / 搜索(纯前端重渲)----
(function trajBoardBindFilters() {
  const chips = document.querySelectorAll("[data-traj-mode]");
  for (let i = 0; i < chips.length; i++) {
    chips[i].onclick = function () {
      const mode = this.getAttribute("data-traj-mode") || "all";
      trajBoardState.mode = mode;
      for (let j = 0; j < chips.length; j++) chips[j].classList.toggle("on", chips[j] === this);
      trajBoardRenderRows();
    };
  }
  $("trajSearch").oninput = function () {
    trajBoardState.q = this.value || "";
    trajBoardRenderRows();
  };
  $("trajCopyPath").onclick = function () {
 // 前端没有 journal 绝对路径变量(那是服务端东西),复制当前会话 id;草稿态没有 id 就明说。
    const sid = currentSid ? String(currentSid) : "";
    if (!sid) { toast("草稿态没有会话 id:先发一条消息再复制", "warn"); return; }
    try {
      navigator.clipboard.writeText(sid);
      toast("已复制会话 id:" + sid);
    } catch (e) { toast("复制失败:剪贴板不可用,手动选中会话 id", true); }
  };
 // 视图切换:逐次决策(默认) / 事件账本(原行表)
  const panes = document.querySelectorAll("[data-traj-pane]");
  for (let i = 0; i < panes.length; i++) {
    panes[i].onclick = function () {
      const pane = this.getAttribute("data-traj-pane") || "decisions";
      trajBoardState.pane = pane === "ledger" ? "ledger" : pane === "lanes" ? "lanes" : "decisions";
      for (let j = 0; j < panes.length; j++) panes[j].classList.toggle("on", panes[j] === this);
 // 默认折叠,切 pane 不再补展开最新卡(展开=拉 2MB 全文,面板卡死)
      trajBoardRenderRows();
    };
  }
  const ea = $("trajExpandAll");
  if (ea) ea.onclick = function () { trajBoardExpandAll(); };
 // 泳道三模式( Q5:sequence|duration|time 全保留)——纯前端重渲,不吃服务端协议。
  const lmodes = document.querySelectorAll("[data-traj-lmode]");
  for (let i = 0; i < lmodes.length; i++) {
    lmodes[i].onclick = function () {
      const m = this.getAttribute("data-traj-lmode") || "sequence";
      trajBoardState.lmode = m === "duration" || m === "time" ? m : "sequence";
      for (let j = 0; j < lmodes.length; j++) lmodes[j].classList.toggle("on", lmodes[j] === this);
      trajBoardRenderRows();
    };
  }
})();
// ---- 决策卡:点卡头展开/收起;复制原始 trace 文件路径(事件委托)----
$("trajCardsHost").onclick = function (e) {
  const t = e.target;
  if (!t || !t.closest) return;
  const cp = t.closest("[data-traj-copy]");
  if (cp) {
    const p = cp.getAttribute("data-traj-copy") || "";
    try { navigator.clipboard.writeText(p); toast("已复制轨迹文件路径:" + p.slice(-52)); }
    catch (err) { toast("复制失败:剪贴板不可用,手动选中路径", true); }
    return;
  }
  const head = t.closest(".tb-c-head");
  if (!head) return;
  const card = head.closest ? head.closest("[data-trace-card]") : null;
  if (!card) return;
  const idx = card.getAttribute("data-trace-card");
  if (idx === null || idx === "") return;
  trajBoardToggleCard(Number(idx));
};
// ---- 行点击:高亮 + inspector(事件委托,行表重渲后无需重绑)----
$("trajRowsHost").onclick = function (e) {
  const t = e.target;
  const el = t && t.closest ? t.closest(".tb-row") : null;
  if (!el) return;
  trajBoardState.sel = Number(el.getAttribute("data-idx"));
  trajBoardMarkSel();
};
`;
