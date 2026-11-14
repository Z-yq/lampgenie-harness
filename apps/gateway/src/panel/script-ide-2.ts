/**
 * 面板分片:script-ide-2(逐字自 panel.ts PAGE 模板搬移, 拆分)。
 * 模板约束沿袭:不得出现裸反引号与 ${。
 */
export const PANEL_JS_IDE_2 = `// ----  IDE 深化(VSCode P0):命令面板 / 查找替换 / 面包屑 / IDE 快捷键 / 文件操作 / 状态栏 ----
// 全部收敛在 #view-ide 域内:快捷键走独立 capture 监听 + dataset.view!=="ide" 守卫,
// 非 IDE 视图的 Ctrl+Shift+P(ccOpen)/Ctrl+Shift+F(fitAll)语义零改。
let ideCursor = { line: 1, col: 1, sel: 0 };
let ideWordWrap = false, ideMinimapOn = false, ideTaBound = false;
let ideFindQuery = "", ideFindHits = [];
let ideNewFiles = new Set();      // 正在新建/另存为的路径(file.write 回包据此接管:失效树+开标签)
let ideCmdItems = [], ideCmdHot = 0, ideCmdMode = "all";
/** 状态栏分段渲染:Ln/Col、选区字符数、语言、缩进、编码、EOL、脏态、行数;主文本仍走 ideStatus(t)。 */
function ideStatusSet() {
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v || ""; };
  const t = ideActive >= 0 && ideActive < ideTabs.length ? ideTabs[ideActive] : null;
  ideTaCursorBind();
  if (!t) {
    set("ideStPos", ""); set("ideStSel", ""); set("ideStLang", ""); set("ideStIndent", "");
    set("ideStEnc", ""); set("ideStEol", ""); set("ideStDirty", ""); set("ideStCount", "");
    ideCrumbRender(); return;
  }
  const content = String(t.content == null ? "" : t.content);
  const lines = content ? content.split("\\n").length : 0;
  let indent = "空格:4", eol = "LF";
  if (t.model && t.model.getOptions) {
    const o = t.model.getOptions() || {};
    if (o.insertSpaces === false) indent = "制表:" + (o.tabSize || 4);
    else if (o.tabSize) indent = "空格:" + o.tabSize;
  }
  if (t.model && t.model.getEOL && t.model.getEOL() === "\\r\\n") eol = "CRLF";
  set("ideStPos", "Ln " + ideCursor.line + ", Col " + ideCursor.col);
  set("ideStSel", ideCursor.sel > 0 ? "已选 " + ideCursor.sel + " 字符" : "");
  set("ideStLang", t.mode === "img" ? "image" : ideLangOf(t.path));
  set("ideStIndent", indent);
  set("ideStEnc", "UTF-8");
  set("ideStEol", eol);
  set("ideStDirty", t.dirty ? "● 未保存" : "");
  set("ideStCount", lines + " 行 · " + content.length + " 字符");
  ideCrumbRender();
}
/** textarea 回退态的行列跟踪(只在首渲绑一次;Monaco 就绪后走 onDidChangeCursorPosition)。 */
function ideTaCursorBind() {
  const ta = $("ideEdit");
  if (!ta || ideTaBound) return;
  ideTaBound = true;
  const upd = () => {
    const upto = String(ta.value || "").slice(0, ta.selectionStart || 0);
    const nl = upto.split("\\n");
    ideCursor.line = nl.length;
    ideCursor.col = (nl[nl.length - 1] || "").length + 1;
    ideCursor.sel = ta.selectionEnd > ta.selectionStart ? ta.selectionEnd - ta.selectionStart : 0;
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v || ""; };
    set("ideStPos", "Ln " + ideCursor.line + ", Col " + ideCursor.col);
    set("ideStSel", ideCursor.sel > 0 ? "已选 " + ideCursor.sel + " 字符" : "");
  };
  ta.addEventListener("keyup", upd);
  ta.addEventListener("click", upd);
}
/** 面包屑:项目名 / 目录… / 文件(每段可点:目录=展开并滚到树行,文件=激活);右侧语言+行列。 */
function ideCrumbRender() {
  const box = $("ideCrumb");
  if (!box) return;
  const t = ideActive >= 0 && ideActive < ideTabs.length ? ideTabs[ideActive] : null;
  if (!t || !ideRoot) { box.innerHTML = ""; return; }
 // 路径段归一化:abs 路径(标签 path 被外部改过的残留)剥掉项目根前缀只留相对段,与根无公共前缀时按段名兜底
  const rootP = ideRoot.path;
  let rel = String(t.path || "");
  if (rel.startsWith(rootP + "/")) rel = rel.slice(rootP.length + 1);
  else if (rel.startsWith("/")) {
    const a = rootP.split("/"), b = rel.split("/");
    let k = 0;
    while (k < a.length && k < b.length - 1 && a[k] === b[k]) k++;
    rel = b.slice(k).join("/") || b[b.length - 1] || rel;
  }
  const parts = rel.split("/");
  const segs = ['<span class="cb-seg" data-cb-abs="' + esc(ideRoot.path) + '" title="' + esc(ideRoot.path) + '">' + esc(ideRoot.label) + "</span>"];
  let acc = "";
  for (let i = 0; i < parts.length; i++) {
    acc = acc ? acc + "/" + parts[i] : parts[i];
    segs.push('<span class="cb-sep">›</span>');
    if (i === parts.length - 1) segs.push('<span class="cb-seg last" data-cb-file="' + esc(rel) + '">' + esc(parts[i]) + "</span>");
    else segs.push('<span class="cb-seg" data-cb-abs="' + esc(ideAbsOf(acc)) + '" title="' + esc(ideAbsOf(acc)) + '">' + esc(parts[i]) + "</span>");
  }
  segs.push('<span class="cb-right"><b>' + esc(t.mode === "img" ? "image" : ideLangOf(t.path)) + "</b><b>Ln " + ideCursor.line + ", Col " + ideCursor.col + "</b>" +
    (t.dirty ? '<b style="color:var(--warn)">● 未保存</b>' : "") + "</span>");
  box.innerHTML = segs.join("");
  for (const el of box.querySelectorAll("[data-cb-abs]")) el.onclick = () => ideCrumbGotoDir(el.dataset.cbAbs);
  for (const el of box.querySelectorAll("[data-cb-file]")) el.onclick = () => ideOpenFile(el.dataset.cbFile);
}
/** 面包屑目录段:逐级展开到该目录 + 清缓存 + 滚到树行。 */
function ideCrumbGotoDir(abs) {
  if (!ideRoot || !abs) return;
  const rel = ideRel(abs);
  if (rel && rel !== abs) {
    let acc = ideRoot.path;
    for (const p of rel.split("/")) { acc = acc + "/" + p; ideExpanded.add(acc); }
  }
  dirCache.delete(abs); filesPending.delete(abs);
  ideTreeRender();
  const rows = $("ideTree").querySelectorAll(".ft-row");
  for (const r of rows) if (r.dataset.abs === abs && r.scrollIntoView) { r.scrollIntoView({ block: "center" }); break; }
}
/** 目录缓存失效(自身+祖先链):文件增删改名后树必须重拉,否则显示陈旧条目。 */
function ideInvalidate(abs) {
  const stop = ideRoot ? ideRoot.path : "";
  let p = String(abs || "");
  while (p && (!stop || p.length >= stop.length)) {
    dirCache.delete(p); filesPending.delete(p);
    if (p === stop) break;
    const i = p.lastIndexOf("/");
    if (i <= 0) break;
    p = p.slice(0, i);
  }
 // 被删/改名目录的深层缓存一并丢弃
  for (const k of [...dirCache.keys()]) if (abs && k.indexOf(abs + "/") === 0) dirCache.delete(k);
  ideTreeRender();
}
function ideInvalidateParent(rel) {
  const seg = String(rel || "").split("/");
  seg.pop();
  ideInvalidate(seg.length ? ideAbsOf(seg.join("/")) : (ideRoot ? ideRoot.path : ""));
}
/** 行定位(t.line):revealLineInCenter + 选中整行 + 整行高亮装饰。 */
const cfRevealLog = []; // 行号定位留痕(标签路径 + 请求行),供浏览器实测断言
function ideRevealLine(t) {
  if (t && t.revealLine) cfRevealLog.push({ path: t.path, line: Number(t.revealLine), monaco: !!ideMonaco });
  if (!ideMonaco || !t || !t.model || !t.revealLine) return;
  const M = ideMonaco, ln = Math.min(Math.max(1, Number(t.revealLine) || 1), t.model.getLineCount());
  t.revealLine = 0;
  try {
    M.editor.revealLineInCenter(ln);
    M.editor.setSelection(new M.monaco.Range(ln, 1, ln, t.model.getLineMaxColumn(ln)));
    if (t.decoIds && t.model.deltaDecorations) t.model.deltaDecorations(t.decoIds, []);
    t.decoIds = t.model.deltaDecorations([], [{ range: new M.monaco.Range(ln, 1, ln, 1), options: { isWholeLine: true, className: "ide-hit-line" } }]);
  } catch (e) { /* 模型已换/编辑器未就绪:定位失败不影响打开 */ }
}
// ---- 命令面板(Ctrl+Shift+P / Ctrl+P):文件模糊匹配 + IDE 命令,↑↓ Enter Esc ----
const IDE_COMMANDS = [
  { id: "goto", title: "转到文件…", key: "Ctrl+P", group: "导航", run: () => ideCmdOpen("files") },
  { id: "save", title: "保存当前文件", key: "Ctrl+S", group: "文件", run: () => ideSaveNow() },
  { id: "save-as", title: "另存为…", key: "", group: "文件", run: () => ideSaveAs() },
  { id: "close", title: "关闭当前标签", key: "Ctrl+W", group: "标签", run: () => ideCloseActive() },
  { id: "close-others", title: "关闭其他标签", key: "", group: "标签", run: () => ideCloseOthers() },
  { id: "new-file", title: "新建文件", key: "Ctrl+Shift+N", group: "文件", run: () => ideNewFile("") },
  { id: "new-dir", title: "新建文件夹", key: "", group: "文件", run: () => ideNewDir("") },
  { id: "rename", title: "重命名当前文件", key: "F2", group: "文件", run: () => ideRenameActive() },
  { id: "delete", title: "删除当前文件", key: "", group: "文件", run: () => ideDeleteActive() },
  { id: "refresh", title: "刷新文件树", key: "", group: "文件", run: () => { if (ideRoot) { invalidateTreeCache(ideRoot.path); ideScmRefresh(); ideTreeRender(); toast("文件树已刷新"); } } },
  { id: "wordwrap", title: "切换自动换行", key: "Alt+Z", group: "视图", run: () => ideToggleWordWrap() },
  { id: "minimap", title: "切换 minimap", key: "", group: "视图", run: () => ideToggleMinimap() },
  { id: "theme", title: "切换主题", key: "Ctrl+Shift+L", group: "视图", run: () => { cycleTheme(); ideMonacoThemeSync(); } },
  { id: "find", title: "在当前文件查找", key: "Ctrl+F", group: "查找", run: () => ideFindInFile(false) },
  { id: "find-replace", title: "在当前文件替换", key: "Ctrl+H", group: "查找", run: () => ideFindInFile(true) },
  { id: "search-all", title: "全项目搜索", key: "Ctrl+Shift+F", group: "查找", run: () => ideFindOpen() },
 // 第二批(VSCode 对齐):活动栏五面板直达(全真 run)
  { id: "view-tree", title: "切换到文件树", key: "Ctrl+Shift+E", group: "视图", run: () => ideActSwitch("tree") },
  { id: "view-scm", title: "切换到源代码管理", key: "", group: "视图", run: () => ideActSwitch("scm") },
  { id: "view-problems", title: "切换到问题", key: "", group: "视图", run: () => ideActSwitch("problems") },
  { id: "view-terminal", title: "切换到终端", key: "Ctrl+\`", group: "视图", run: () => ideTermToggle() },
  { id: "view-outline", title: "切换到大纲", key: "Ctrl+Shift+O", group: "视图", run: () => ideActSwitch("outline") },
 // (板 5a7bb5d2):HTML 双态预览直达——当前标签非 html 时 toast 提示不切换
  { id: "ide.preview", title: "预览当前 HTML", key: "", group: "视图", run: () => {
      const t = ideActive >= 0 && ideActive < ideTabs.length ? ideTabs[ideActive] : null;
      if (!t || t.mode !== "edit" || !ideIsHtml(t.path)) { toast("仅 .html/.htm 文件支持预览"); return; }
      idePvSet(t, "preview");
    } },
];
/** 当前项目在树缓存里已知的文件清单(懒加载友好:只取已加载的目录)。 */
function ideFileList() {
  const out = [];
  if (ideRoot) {
    const seen = new Set();
    const walk = (abs) => {
      if (seen.has(abs)) return;
      seen.add(abs);
      const entries = dirCache.get(abs);
      if (!entries) return;
      for (const en of entries) {
        const child = abs + "/" + en.name;
        if (en.kind === "dir") { if (en.name === ".git" || en.name === "node_modules" || en.name === "dist") continue; walk(child); }
        else out.push(ideRel(child));
      }
    };
    walk(ideRoot.path);
  }
  for (const f of ideSearchFallbackFiles) if (out.indexOf(f) < 0) out.push(f);
  return out;
}
let ideSearchFallbackFiles = [];
/** 模糊子序列打分(0=不匹配;连续命中/路径段首字符加分)。 */
function ideFuzzy(q, s) {
  if (!q) return 1;
  const a = String(q).toLowerCase(), b = String(s).toLowerCase();
  let i = 0, score = 0, streak = 0;
  for (let j = 0; j < b.length && i < a.length; j++) {
    if (b[j] === a[i]) { i++; streak++; score += 1 + streak; if (j === 0 || b[j - 1] === "/" || b[j - 1] === ".") score += 5; }
    else streak = 0;
  }
  return i === a.length ? score : 0;
}
function ideCmdOpen(mode) {
  const box = $("ideCmd");
  if (!box) return;
  ideCmdMode = mode || "all";
  ideCmdHot = 0;
  box.classList.add("on");
  $("ideCmdQ").value = ideCmdMode === "cmd" ? "> " : "";
  ideCmdRender();
  $("ideCmdQ").focus();
  $("ideCmdQ").select();
}
function ideCmdClose() { const box = $("ideCmd"); if (box) box.classList.remove("on"); }
function ideCmdRender() {
  const list = $("ideCmdList");
  if (!list) return;
  const raw = $("ideCmdQ").value.trim();
  const cmdOnly = ideCmdMode === "cmd" || raw.charAt(0) === ">";
  const q = (cmdOnly ? raw.replace(/^>\\s*/, "") : raw).toLowerCase();
  const items = [];
  if (!cmdOnly) {
    const files = ideFileList().map((f) => ({ f: f, s: ideFuzzy(q, f) })).filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.f.length - b.f.length).slice(0, 40);
    for (const x of files) items.push({ kind: "file", title: x.f, key: "", tag: "文件", run: () => ideOpenFile(x.f) });
    if (!files.length && q) ideGotoFallback(q); // 树未加载到的深层文件:files.search 兜底
  }
  for (const c of IDE_COMMANDS) {
    if (q && c.title.toLowerCase().indexOf(q) < 0 && c.id.indexOf(q) < 0 && String(c.group || "").toLowerCase().indexOf(q) < 0) continue;
    items.push({ kind: "cmd", title: c.title, key: c.key || "", tag: c.group || "命令", run: c.run });
  }
  ideCmdItems = items;
  if (ideCmdHot >= items.length) ideCmdHot = Math.max(0, items.length - 1);
  list.innerHTML = items.length
    ? items.map((it, i) => '<div class="ide-cmd-item' + (i === ideCmdHot ? " hot" : "") + '" data-ci="' + i + '">' +
        '<span class="ci-g">' + esc(it.tag) + '</span><span class="ci-t">' + esc(it.title) + '</span><span class="ci-k">' + esc(it.key) + "</span></div>").join("")
    : '<div class="cc-empty">没有匹配的条目</div>';
  const meta = $("ideCmdMeta");
  if (meta) meta.textContent = (cmdOnly ? "命令 " : "文件/命令 ") + items.length;
  for (const el of list.querySelectorAll("[data-ci]")) el.onclick = () => ideCmdExec(Number(el.dataset.ci));
}
function ideCmdExec(i) {
  const it = ideCmdItems[i];
  if (!it) return;
  ideCmdClose();
  try { it.run(); } catch (e) { console.warn("[ide] 命令执行失败", e); }
}
/** 转到文件兜底:一次性监听 files.result(不动全局 files.result 分支,避免与 @ 提及/命令中心互相干扰)。 */
function ideGotoFallback(q) {
  if (!ws || ws.readyState !== 1) return;
  const h = (ev) => {
    let m = null;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (!m || m.type !== "files.result") return;
    ws.removeEventListener("message", h);
    ideSearchFallbackFiles = (m.files || []).slice(0, 40);
    if ($("ideCmd").classList.contains("on")) ideCmdRender();
  };
  ws.addEventListener("message", h);
  wsSafeSend(JSON.stringify({ v: 1, type: "files.search", query: q }));
}
// ---- 全项目内容搜索(Ctrl+Shift+F):fs.grep → 文件:行:片段,点击定位 ----
function ideFindOpen() {
  const box = $("ideFind");
  if (!box) return;
  box.classList.add("on");
  const q = $("ideFindQ");
  if (q) { q.focus(); q.select(); }
}
function ideFindClose() { const box = $("ideFind"); if (box) box.classList.remove("on"); }
function ideFindSearch() {
  const qi = $("ideFindQ");
  const q = qi ? qi.value.trim() : "";
  const meta = $("ideFindMeta");
  if (!q) { if (meta) meta.textContent = ""; $("ideFindRes").innerHTML = ""; return; }
  ideFindQuery = q;
  if (meta) meta.textContent = "搜索中…";
  wsSafeSend(JSON.stringify({ v: 1, type: "fs.grep", query: q, regex: !!($("ideFindRe") && $("ideFindRe").checked), maxResults: 200, ...(ideRoot && ideRoot.pid ? { projectId: ideRoot.pid } : {}) }));
}
function ideFindRender(m) {
  if (!m || String(m.query || "") !== ideFindQuery) return; // 迟到回包丢弃(连续输入不覆盖新结果)
  const hits = Array.isArray(m.matches) ? m.matches : [];
  ideFindHits = hits;
  const meta = $("ideFindMeta");
  if (meta) meta.textContent = m.error ? "失败:" + String(m.error).slice(0, 60) : hits.length + " 命中" + (m.truncated ? "(已截断)" : "");
  const host = $("ideFindRes");
  if (!host) return;
  if (m.error) { host.innerHTML = '<div class="cc-empty">' + esc(String(m.error)) + "</div>"; return; }
  if (!hits.length) { host.innerHTML = '<div class="cc-empty">没有匹配</div>'; return; }
  const byFile = new Map();
  for (const h of hits) { const a = byFile.get(h.path) || []; a.push(h); byFile.set(h.path, a); }
  const rows = [];
  for (const [p, arr] of byFile) {
    rows.push('<div class="ide-find-file">' + esc(p) + " (" + arr.length + ")</div>");
    for (const h of arr) rows.push('<div class="ide-find-hit" data-fp="' + esc(h.path) + '" data-fl="' + Number(h.line) + '" title="' + esc(h.text) + '">' +
      '<span class="fh-loc">' + Number(h.line) + ":</span> " + esc(String(h.text || "").slice(0, 120)) + "</div>");
  }
  host.innerHTML = rows.join("");
  for (const el of host.querySelectorAll(".ide-find-hit")) el.onclick = () => { ideOpenFile(el.dataset.fp, { line: Number(el.dataset.fl) }); };
}
// ---- Monaco 编辑增强(Ctrl+F/Ctrl+H 走 Monaco find widget;wordWrap / minimap / 主题同步) ----
function ideFindInFile(replace) {
  const ed = ideMonaco && ideMonaco.editor;
  if (!ed) { toast("Monaco 未就绪,先用侧栏全项目搜索(Ctrl+Shift+F)", true); return; }
  const act = ed.getAction(replace ? "editor.action.startFindReplaceAction" : "actions.find");
  if (act) act.run();
}
function ideToggleWordWrap() {
  ideWordWrap = !ideWordWrap;
  if (ideMonaco) ideMonaco.editor.updateOptions({ wordWrap: ideWordWrap ? "on" : "off" });
  toast("自动换行 " + (ideWordWrap ? "开" : "关"));
  ideStatus("自动换行 " + (ideWordWrap ? "开" : "关"));
}
function ideToggleMinimap() {
  ideMinimapOn = !ideMinimapOn;
  if (ideMonaco) ideMonaco.editor.updateOptions({ minimap: { enabled: ideMinimapOn } });
  toast("minimap " + (ideMinimapOn ? "开" : "关"));
  ideStatus("minimap " + (ideMinimapOn ? "开" : "关"));
}
function ideMonacoThemeSync() {
  if (!ideMonaco) return;
  try { ideMonaco.monaco.editor.setTheme(document.body.classList.contains("light") ? "vs" : "genie"); } catch (e) { /* 主题切换失败不改编辑内容 */ }
}
// ---- 文件操作(新建/重命名/删除):走 fs.mkdir / fs.write / fs.rename / fs.remove;成功失效 dirCache ----
function ideActiveTab() { return ideActive >= 0 && ideActive < ideTabs.length ? ideTabs[ideActive] : null; }
function ideCloseActive() { if (ideActiveTab()) ideClose(ideActive); }
function ideCloseOthers() {
  const keep = ideActiveTab();
  if (!keep) return;
  for (let i = ideTabs.length - 1; i >= 0; i--) {
    if (ideTabs[i] === keep) continue;
    const t = ideTabs[i];
    if (t.dirty && !window.confirm("「" + t.name + "」有未保存的修改,关闭将丢弃。确认关闭?")) continue;
    t.dirty = false;
    ideClose(i);
  }
  ideStatus("已关闭其他标签");
}
function ideNewFile(dirRel) {
  uiPrompt("新建文件(相对项目根路径;父目录须已存在):", dirRel ? ideRel(dirRel) + "/" : "").then((v) => {
    if (v === null) return;
    const rel = String(v).trim().replace(/^\\/+/, "");
    if (!rel) return;
    ideNewFiles.add(rel);
    wsSafeSend(JSON.stringify({ v: 1, type: "file.write", path: rel, content: "", ...(ideRoot && ideRoot.pid ? { projectId: ideRoot.pid } : {}) }));
  });
}
function ideNewDir(dirRel) {
  uiPrompt("新建文件夹(相对项目根路径):", dirRel ? ideRel(dirRel) + "/" : "").then((v) => {
    if (v === null) return;
    const rel = String(v).trim().replace(/^\\/+/, "");
    if (!rel) return;
    wsSafeSend(JSON.stringify({ v: 1, type: "fs.mkdir", path: rel, ...(ideRoot && ideRoot.pid ? { projectId: ideRoot.pid } : {}) }));
  });
}
function ideRename(rel) {
  if (!rel) return;
  uiPrompt("重命名为(相对项目根的路径):", rel).then((v) => {
    if (v === null) return;
    const to = String(v).trim().replace(/^\\/+/, "");
    if (!to || to === rel) return;
    wsSafeSend(JSON.stringify({ v: 1, type: "fs.rename", from: rel, to: to, ...(ideRoot && ideRoot.pid ? { projectId: ideRoot.pid } : {}) }));
  });
}
function ideRenameActive() { const t = ideActiveTab(); if (t) ideRename(t.path); }
function ideDeleteActive() { const t = ideActiveTab(); if (t) ideDelete(t.path, false); }
function ideDelete(rel, isDir) {
  const hit = ideTabs.filter((t) => t.path === rel || t.path.indexOf(rel + "/") === 0);
  const dirtyN = hit.filter((t) => t.dirty).length;
  const msg = dirtyN
    ? "「" + rel + "」有 " + dirtyN + " 个标签存在未保存修改,删除将一并丢弃(不可恢复)。确认删除?"
    : "确认删除「" + rel + "」?" + (isDir ? "(目录递归删除,不可恢复)" : "(不可恢复)");
  uiConfirm(msg, { tone: "danger" }).then((ok) => {
    if (!ok) return;
    wsSafeSend(JSON.stringify({ v: 1, type: "fs.remove", path: rel, ...(isDir ? { recursive: true } : {}), ...(ideRoot && ideRoot.pid ? { projectId: ideRoot.pid } : {}) }));
  });
}
function ideSaveAs() {
  const t = ideActiveTab();
  if (!t || t.mode !== "edit") { toast("当前标签不可另存为", true); return; }
  uiPrompt("另存为(相对项目根的路径):", t.path).then((v) => {
    if (v === null) return;
    const rel = String(v).trim().replace(/^\\/+/, "");
    if (!rel || rel === t.path) return;
    ideNewFiles.add(rel);
    wsSafeSend(JSON.stringify({ v: 1, type: "file.write", path: rel, content: t.content, ...(ideRoot && ideRoot.pid ? { projectId: ideRoot.pid } : {}) }));
  });
}
/** 标签跟随重命名:改 path/name,重建 model(URI 换新,内容与脏态保留)。 */
function ideRenameTabs(from, to) {
  let touched = false;
  for (const t of ideTabs) {
    if (t.path !== from && t.path.indexOf(from + "/") !== 0) continue;
    t.path = to + t.path.slice(from.length);
    t.name = t.path.split("/").pop() || t.path;
    if (t.model) {
      try { if (ideMonaco && ideMonaco.editor.getModel() === t.model) ideMonaco.editor.setModel(null); t.model.dispose(); } catch (e) { /* 已释放 */ }
      t.model = null;
    }
    t.orig = t.content;
    touched = true;
  }
  if (!touched) return;
  ideTabsRender();
  if (ideActive >= 0) ideBodyRender();
}
/** 标签跟随删除:命中路径的标签全关(脏态已在删除确认里一次性确认,这里不再二次弹)。 */
function ideCloseTabsUnder(rel) {
  const idx = [];
  ideTabs.forEach((t, i) => { if (t.path === rel || t.path.indexOf(rel + "/") === 0) idx.push(i); });
  for (let k = idx.length - 1; k >= 0; k--) {
    const t = ideTabs[idx[k]];
    if (!t) continue;
    t.dirty = false;
    ideClose(idx[k]);
  }
}
/** fs.mkdir/remove/rename/grep 回包统一入口(ok:false 走 toast,不刷新树)。 */
function ideFsResult(m) {
  const type = String(m && m.type || "");
  if (type === "fs.mkdir.result") {
    if (!m.ok) { toast("新建文件夹失败:" + String(m.error || "未知原因").slice(0, 90), true); return true; }
    toast("已新建目录 " + m.path);
    ideInvalidateParent(m.path);
    return true;
  }
  if (type === "fs.remove.result") {
    if (!m.ok) { toast("删除失败:" + String(m.error || "未知原因").slice(0, 90), true); return true; }
    toast("已删除 " + m.path);
    ideCloseTabsUnder(m.path);
    ideInvalidateParent(m.path);
    return true;
  }
  if (type === "fs.rename.result") {
    if (!m.ok) { toast("重命名失败:" + String(m.error || "未知原因").slice(0, 90), true); return true; }
    toast("已重命名 " + m.from + " → " + m.to);
    ideRenameTabs(m.from, m.to);
    ideInvalidateParent(m.from);
    ideInvalidateParent(m.to);
    return true;
  }
  if (type === "fs.grep.result") { ideFindRender(m); return true; }
  return false;
}
/** 新建/另存为的 file.write 回包接管(命中即失效树并开标签,不落到「保存中标签」分支)。 */
function ideNewFileResult(m) {
  const rel = String(m.path || "");
  if (!ideNewFiles.has(rel)) return false;
  ideNewFiles.delete(rel);
  if (!m.ok) { toast("新建失败:" + rel, true); return true; }
  toast("已新建 " + rel);
  ideInvalidateParent(rel);
  ideOpenFile(rel);
  return true;
}
// ---- 第二批(VSCode 对齐):活动栏 / SCM / Diff / 问题 / 终端 / 大纲 ----
// 活动栏五面板:tree/scm/problems/outline 占侧栏(互斥显示,记忆在 localStorage);terminal=底部抽屉开关。
// SCM 数据走既有 git.status/git.commit;diff 原文走 git.show(requestId 路由);诊断/终端走新消息(后端并行实现)。
let ideActCur = "tree";          // 当前侧栏面板(tree/scm/problems/outline)
let ideScmStatus = [];           // git.status 缓存 [{file,label,staged}]
let ideScmChanged = new Set();   // 改动路径集合(树角标数据源)
let ideScmBranch = "";
let ideDiffEditor = null;        // Monaco DiffEditor 懒建复用(随标签 display 切换,不销毁)
let ideProbAll = {};             // path → [{line,col,severity,message,code}](问题面板聚合)
let ideTerm = { sessionId: null, cursor: null, timer: 0, seq: 0, inflight: false, inflightAt: 0 };
let ideReqSeq = 0;
const ideReqMap = new Map();     // requestId → 回包处理(git.show / lsp.diagnostics / term.session.*)
function ideReqId(prefix) { return "ide-" + prefix + "-" + (++ideReqSeq); }
function ideActiveTab() { return ideActive >= 0 && ideActive < ideTabs.length ? ideTabs[ideActive] : null; }

/** 活动栏切换:silent=true 只同步显示(页面加载恢复记忆,不发刷新请求)。 */
function ideActSwitch(act, silent) {
  ideActCur = act === "terminal" ? ideActCur : (["tree", "scm", "problems", "outline"].indexOf(act) >= 0 ? act : "tree");
  localStorage.setItem("zh:ide-act", ideActCur);
  const side = { tree: "ideTree", scm: "ideScm", problems: "ideProblems", outline: "ideOutline" };
  for (const k in side) { const el = $(side[k]); if (el) el.style.display = k === ideActCur ? "" : "none"; }
  const bar = $("ideActBar");
  if (bar) for (const el of bar.querySelectorAll(".ide-act")) if (el.dataset.act !== "terminal") el.classList.toggle("on", el.dataset.act === ideActCur);
  const title = { tree: "资源管理器", scm: "源代码管理", problems: "问题", outline: "大纲" }[ideActCur];
  const tt = $("ideTreeTitle"); if (tt && title) tt.textContent = title;
  if (!silent) {
    if (ideActCur === "scm") ideScmRefresh();
    if (ideActCur === "problems") { ideProbRender(); ideDiagRequest(ideTabs.filter((t) => t.mode === "edit").map((t) => t.path)); }
    if (ideActCur === "outline") ideOutlineScan();
  }
}
(function ideActWire() { // 活动栏图标绑定:terminal=抽屉开关不占侧栏;其余互斥切换
  const bar = $("ideActBar");
  if (!bar) return;
  for (const el of bar.querySelectorAll(".ide-act")) {
    el.onclick = () => { const a = el.dataset.act; if (a === "terminal") ideTermToggle(); else ideActSwitch(a); };
  }
  try { const saved = localStorage.getItem("zh:ide-act"); if (saved && saved !== "tree") ideActSwitch(saved, true); } catch (e) { /* 记忆失效=默认树 */ }
})();

// ---- SCM:git.status 缓存 → 改动列表(点击开 diff)+ commit(message 空前端拒) ----
function ideScmClassify(label) {
  const l = String(label || "").trim();
  if (!l) return "M";
  if (l.indexOf("?") >= 0) return "U";
  if (l.indexOf("D") >= 0) return "D";
  if (l.indexOf("A") >= 0) return "A";
  return "M";
}
function ideScmLetter(path) {
  const hit = ideScmStatus.find((c) => c.file === path);
  const k = hit ? ideScmClassify(hit.label) : "M";
  return k === "A" ? "U" : k; // 树角标收敛为 M/U/D
}
function ideScmOnStatus(m) { // git.status.result 双消费:主 Git 面板照旧,这里喂 IDE 缓存+树角标
  ideScmStatus = (m && m.changes) || [];
  ideScmChanged = new Set(ideScmStatus.map((c) => String(c.file || "")));
  ideScmBranch = m && !m.norepo ? String(m.branch || "") : "";
  ideScmRenderList();
  ideTreeRender(); // 树角标随之刷新(幂等)
}
function ideScmRefresh() {
  if (!ideRoot) { ideScmStatus = []; ideScmChanged = new Set(); ideScmRenderList(); return; }
  wsSafeSend(JSON.stringify({ v: 1, type: "git.status", ...(ideRoot.pid ? { projectId: ideRoot.pid } : {}) }));
}
function ideScmRenderList() {
  const list = $("ideScmList");
  if (!list) return;
  const meta = $("ideScmMeta");
  if (meta) meta.textContent = ideScmStatus.length + " 个改动" + (ideScmBranch ? " · ⎇ " + ideScmBranch : "");
  list.innerHTML = ideScmStatus.length
    ? ideScmStatus.map((c, i) => {
        const k = ideScmClassify(c.label);
        return '<div class="ide-p-row" data-scm="' + esc(c.file) + '" data-i="' + i + '" title="' + esc(c.file) + '">' +
          '<span class="ide-scm-label ide-scm-' + k + '">' + k + '</span><span style="overflow:hidden;text-overflow:ellipsis">' + esc(c.file) + "</span></div>";
      }).join("")
    : '<div class="cc-empty">工作区干净<br><span style="font-size:11px">保存文件后此处列出改动;点击开 diff</span></div>';
  for (const el of list.querySelectorAll("[data-scm]")) el.onclick = () => ideDiffOpen(el.dataset.scm);
}
$("ideScmCommit").onclick = () => {
  const msg = String($("ideScmMsg").value || "").trim();
  if (!msg) { toast("提交信息不能为空", true); $("ideScmMsg").focus(); return; } // 空 message 前端拒
  if (!ideRoot) { toast("无活动项目,不可提交", true); return; }
  wsSafeSend(JSON.stringify({ v: 1, type: "git.commit", message: msg, ...(ideRoot.pid ? { projectId: ideRoot.pid } : {}) }));
  ideStatus("提交请求已发送");
  setTimeout(ideScmRefresh, 900); // 提交后回拉状态(改动清空/角标消失)
};

// ---- Diff:双栏 DiffEditor(Monaco 在场)→ 回退 LCS 行级着色(+绿/-红) ----
function ideDiffOpen(rel) {
  if (!ideRoot) { toast("无活动项目,不可 diff", true); return; }
  const nm = String(rel).split("/").pop() || rel;
  let t = ideTabs.find((x) => x.path === rel && x.mode === "diff");
  if (t) ideActivate(ideTabs.indexOf(t));
  else { t = { path: rel, name: nm + "(diff)", content: "", orig: "", dirty: false, saving: false, mode: "diff", roReason: "", diffData: { orig: null, mod: null } }; ideTabs.push(t); ideActivate(ideTabs.length - 1); }
  if (!ideMonaco && !ideMonacoFailed) ideMonacoLoad().then(() => { if (ideActiveTab() === t) ideDiffRender(); });
  if (t.diffData.orig == null) { // 原文=git.show HEAD;error/新文件 → 空串(全增)
    const rid = ideReqId("diff");
    ideReqMap.set(rid, (m2) => {
      const t2 = ideTabs.find((x) => x.path === rel && x.mode === "diff");
      if (!t2) return;
      t2.diffData.orig = m2 && typeof m2.content === "string" ? m2.content : "";
      if (ideActiveTab() === t2) ideDiffRender();
    });
    wsSafeSend(JSON.stringify({ v: 1, type: "git.show", requestId: rid, projectId: ideRoot.pid, path: rel, ref: "HEAD" }));
  }
  if (t.diffData.mod == null) { // 修改=磁盘内容:开着编辑标签→其缓冲;否则 file.read 拉磁盘
    const sib = ideTabs.find((x) => x.path === rel && x.mode === "edit");
    if (sib) t.diffData.mod = String(sib.content == null ? "" : sib.content);
    else wsSafeSend(JSON.stringify({ v: 1, type: "file.read", path: rel, full: true, projectId: ideRoot.pid }));
  }
  ideDiffRender();
}
function ideScmOnShow(m) { // git.show 回包兜底(requestId 丢失/后端按 type 回)
  const t = ideTabs.find((x) => x.mode === "diff" && x.path === String(m.path || "") && x.diffData && x.diffData.orig == null);
  if (!t) return;
  t.diffData.orig = typeof m.content === "string" ? m.content : "";
  if (ideActiveTab() === t) ideDiffRender();
}
function ideDiffEnsure() {
  const M = ideMonaco;
  if (!M || !M.monaco || !M.monaco.editor || typeof M.monaco.editor.createDiffEditor !== "function") return null;
  if (ideDiffEditor) return ideDiffEditor;
  let host = $("ideDiffHost");
  if (!host) { ideBodySkeleton(); host = $("ideDiffHost"); }
  if (!host) return null;
  try { ideDiffEditor = M.monaco.editor.createDiffEditor(host, { readOnly: true, renderSideBySide: true, automaticLayout: true, minimap: { enabled: false } }); }
  catch (e) { ideDiffEditor = null; }
  return ideDiffEditor;
}
/** LCS 行级 diff(回退渲染;Monaco 缺席/API 不可用时)。返回 [{s,c,p}] 或 null(过大)。 */
function ideDiffLcs(a, b) {
  const n = a.length, m = b.length;
  if (n * m > 1200000) return null;
  const w = m + 1, dp = new Array((n + 1) * w).fill(0);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ s: a[i], c: "", p: " " }); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { out.push({ s: a[i], c: "d-del", p: "-" }); i++; }
    else { out.push({ s: b[j], c: "d-add", p: "+" }); j++; }
  }
  while (i < n) { out.push({ s: a[i], c: "d-del", p: "-" }); i++; }
  while (j < m) { out.push({ s: b[j], c: "d-add", p: "+" }); j++; }
  return out;
}
function ideDiffRender() {
  const t = ideActiveTab();
  if (!t || t.mode !== "diff") return;
  const d = t.diffData || (t.diffData = { orig: null, mod: null });
  if (d.orig == null || d.mod == null) { $("ideRo").innerHTML = ic("clock") + " diff 读取中…"; ideBodyShow("ro"); return; }
  const diffEd = ideDiffEnsure();
  if (diffEd) {
    const M = ideMonaco;
    if (!t.diffOrigModel) t.diffOrigModel = M.monaco.editor.createModel(String(d.orig), ideLangOf(t.path), M.monaco.Uri.file("/__diff__/head/" + t.path));
    else if (t.diffOrigModel.getValue() !== d.orig) t.diffOrigModel.setValue(d.orig);
    if (!t.diffModModel) t.diffModModel = M.monaco.editor.createModel(String(d.mod), ideLangOf(t.path), M.monaco.Uri.file("/__diff__/disk/" + t.path));
    else if (t.diffModModel.getValue() !== d.mod) t.diffModModel.setValue(d.mod);
    try { diffEd.setModel({ original: t.diffOrigModel, modified: t.diffModModel }); ideBodyShow("diff"); diffEd.layout(); } catch (e) { /* 模型冲突=回退着色 */ }
    ideStatus(t.path + " · diff(HEAD ↔ 工作区)");
    return;
  }
  const rows = ideDiffLcs(String(d.orig).split("\\n"), String(d.mod).split("\\n"));
  $("ideRo").innerHTML = rows
    ? rows.map((r) => '<div class="' + r.c + '">' + esc(r.p + r.s) + "</div>").join("") || '<div class="cc-empty">无差异</div>'
    : '<div class="cc-empty">文件过大,diff 着色降级为并排只读</div>';
  ideBodyShow("ro");
  ideStatus(t.path + " · diff(回退着色)");
}

// ---- 问题:lsp.diagnostics → 列表 + setModelMarkers("ide");点击 ideRevealLine ----
function ideDiagRequest(paths) {
  if (!ideRoot || !paths || !paths.length) return;
  const list = paths.slice(0, 8).map(String).filter(Boolean);
  if (!list.length) return;
  const rid = ideReqId("diag");
  ideReqMap.set(rid, (m) => ideProbMerge(m, list));
  wsSafeSend(JSON.stringify({ v: 1, type: "lsp.diagnostics", requestId: rid, projectId: ideRoot.pid, paths: list }));
}
function ideProbMerge(m, asked) {
  const byPath = {};
  for (const d0 of (m && m.diagnostics) || []) {
    const p = String(d0.path || ""); if (!p) continue;
    (byPath[p] = byPath[p] || []).push({ line: Number(d0.line) || 1, col: Number(d0.col) || 1, severity: d0.severity === "warning" ? "warning" : "error", message: String(d0.message || ""), code: d0.code });
  }
  for (const p of asked || []) ideProbAll[p] = byPath[p] || []; // 请求过的 path 全量替换(空结果=清零)
  ideProbRender();
  ideProbMarkers();
}
function ideProbRender() {
  const list = $("ideProbList");
  if (!list) return;
  const rows = [];
  for (const p in ideProbAll) for (const d of ideProbAll[p] || [])
    rows.push({ path: p, d: d });
  rows.sort((a, b) => (a.d.severity === b.d.severity ? a.path.localeCompare(b.path) : a.d.severity === "error" ? -1 : 1));
  const meta = $("ideProbMeta");
  if (meta) meta.textContent = rows.length + " 个问题";
  list.innerHTML = rows.length
    ? rows.map((r) => '<div class="ide-p-row" data-p="' + esc(r.path) + '" data-l="' + r.d.line + '" title="' + esc(r.d.message) + '">' +
        '<span class="ide-scm-label ' + (r.d.severity === "warning" ? "ide-dg-warn" : "ide-dg-err") + '">' + r.d.severity + '</span>' +
        "<span>" + esc(r.path + ":" + r.d.line + ":" + r.d.col + " " + r.d.message).slice(0, 200) + "</span></div>").join("")
    : '<div class="cc-empty">暂无诊断<br><span style="font-size:11px">打开文件 / Ctrl+S 保存成功后刷新</span></div>';
  for (const el of list.querySelectorAll("[data-p]")) el.onclick = () => ideOpenFile(el.dataset.p, { line: Number(el.dataset.l) || 1 });
}
function ideProbMarkers() { // 当前激活文件同步进 Monaco 标记(owner="ide")
  if (!ideMonaco) return;
  const t = ideActiveTab();
  if (!t || !t.model) return;
  const list = ideProbAll[t.path] || [];
  const sev = { error: 8, warning: 4 };
  try {
    ideMonaco.monaco.editor.setModelMarkers(t.model, "ide", list.map((d) => ({
      severity: sev[d.severity] || 8,
      startLineNumber: d.line, startColumn: d.col, endLineNumber: d.line, endColumn: d.col + 1,
      message: d.message + (d.code ? " (" + d.code + ")" : ""),
    })));
  } catch (e) { /* markers 设置失败不影响面板 */ }
}

// ---- 终端:底部抽屉 Ctrl+\`;term.session.open/send/read/close;500ms 轮询;无假回显 ----
function ideTermToggle(force) {
  const el = $("ideTerm");
  if (!el) return;
  const open = force != null ? !!force : el.style.display === "none";
  el.style.display = open ? "" : "none";
  const bar = $("ideActBar");
  if (bar) { const ic2 = bar.querySelector('[data-act="terminal"]'); if (ic2) ic2.classList.toggle("on", open); }
  if (open) { ideTermEnsure(); const inp = $("ideTermIn"); if (inp) inp.focus(); }
  else ideTermPollStop(); // 隐藏停轮询;会话保留(再开续读)
}
function ideTermOut(s) {
  const el = $("ideTermOut");
  if (!el) return;
  el.textContent += ideTermAnsi(s);
  if (el.textContent.length > 200000) el.textContent = el.textContent.slice(-190000); // 输出上限 200KB
}
function ideTermAnsi(s) { // 纯文本展示:剥 ANSI 转义与其余控制符(保留 LF/TAB/CR)
  return String(s == null ? "" : s)
    .replace(/\\x1b\\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\\x1b\\][^\\x07\\x1b]*(\\x07|\\x1b\\\\)?/g, "")
    .replace(/[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f]/g, "");
}
function ideTermEnsure() {
  if (!ideRoot) { ideTermOut("\\n(无活动项目,终端不可用)\\n"); return; }
  if (ideTerm.sessionId) { ideTermPollStart(); return; }
  const rid = ideReqId("term-open");
  ideReqMap.set(rid, (m) => {
    if (m && m.error) { ideTermOut("\\n(终端会话建立失败:" + String(m.error || m.message || "未知").slice(0, 120) + ")\\n"); ideTerm.sessionId = null; return; }
    ideTerm.sessionId = String((m && m.sessionId) || "");
    ideTerm.cursor = m && m.cursor != null ? m.cursor : null;
    ideTermOut("\\n(已连接终端会话 " + ideTerm.sessionId.slice(0, 8) + "…)\\n");
    ideTermPollStart();
  });
  wsSafeSend(JSON.stringify({ v: 1, type: "term.session.open", requestId: rid, cwd: ideRoot.path, cols: 100, rows: 24, projectId: ideRoot.pid }));
}
function ideTermPollStart() { if (ideTerm.timer) return; ideTermPollKick(); ideTerm.timer = setInterval(ideTermPollKick, 500); }
function ideTermPollStop() { if (ideTerm.timer) { clearInterval(ideTerm.timer); ideTerm.timer = 0; } ideTerm.inflight = false; }
function ideTermPollKick() {
  if (!ideTerm.sessionId || !ws || ws.readyState !== 1) return;
  if (ideTerm.inflight && Date.now() - ideTerm.inflightAt < 5000) return;
  ideTerm.inflight = true; ideTerm.inflightAt = Date.now();
  const rid = ideReqId("term-read");
  ideReqMap.set(rid, (m) => {
    ideTerm.inflight = false;
    if (m && m.error) return;
    if (m && m.cursor != null) ideTerm.cursor = m.cursor;
    const data = String((m && m.data) || "");
    if (data) ideTermOut(data);
  });
  try { wsSafeSend(JSON.stringify({ v: 1, type: "term.session.read", requestId: rid, sessionId: ideTerm.sessionId, ...(ideTerm.cursor != null ? { cursor: ideTerm.cursor } : {}) })); }
  catch (e) { ideTerm.inflight = false; }
}
function ideTermOnResult(m) { // 后端按 type 回包(requestId 未回显)的兜底路由
  if (m && m.error) return;
  const t = String(m.type || "");
  if (t.indexOf("open") >= 0 && m.sessionId && !ideTerm.sessionId) {
    ideTerm.sessionId = String(m.sessionId);
    ideTerm.cursor = m.cursor != null ? m.cursor : null;
    ideTermPollStart();
    return;
  }
  if (typeof m.data === "string") { if (m.cursor != null) ideTerm.cursor = m.cursor; if (m.data) ideTermOut(m.data); }
}
$("ideTermIn").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const line = String($("ideTermIn").value || "");
  $("ideTermIn").value = "";
  if (!line.trim()) return;
  if (!ideTerm.sessionId) { ideTermOut("\\n(未连接,忽略输入)\\n"); return; } // 禁止假回显:输出只来自 read
  const rid = ideReqId("term-send");
  ideReqMap.set(rid, () => {});
  wsSafeSend(JSON.stringify({ v: 1, type: "term.session.send", requestId: rid, sessionId: ideTerm.sessionId, data: line + "\\n" }));
  ideTermPollKick(); // 发完立即拉,不等下一拍
});
$("ideTermClose").onclick = () => ideTermToggle(false);
window.addEventListener("beforeunload", () => { // 尽力关闭会话(不 await)
  if (ideTerm.sessionId) {
    try { wsSafeSend(JSON.stringify({ v: 1, type: "term.session.close", requestId: ideReqId("term-close"), sessionId: ideTerm.sessionId })); } catch (e) { /* 页面卸载尽力而为 */ }
  }
});

// ---- 大纲:TS/JS(含 tsx/jsx/mts/cts)正则抽符号;其它语言禁用态;Ctrl+Shift+O 优先 Monaco quickOutline ----
const IDE_OUTLINE_EXT = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"]);
let ideOutlineSyms = [];
function ideOutlineExtOf(rel) { const nm = String(rel || "").split("/").pop() || ""; const i = nm.lastIndexOf("."); return i < 0 ? "" : nm.slice(i + 1).toLowerCase(); }
function ideOutlineScan() {
  const t = ideActiveTab();
  const ext = t ? ideOutlineExtOf(t.path) : "";
  if (!t || t.mode !== "edit" || !IDE_OUTLINE_EXT.has(ext)) {
    ideOutlineSyms = [];
    ideOutlineRender();
    return;
  }
  const src = String(t.model && ideMonaco ? t.model.getValue() : (t.content || ""));
  ideOutlineSyms = [];
  const re = /^[ \\t]*(?:export[ \\t]+)?(?:default[ \\t]+)?(?:async[ \\t]+)?(function\\*?|class|interface|type|enum|const)[ \\t]+([A-Za-z_$][\\w$]*)/gm;
  let mm;
  while ((mm = re.exec(src))) {
    const line = src.slice(0, mm.index).split("\\n").length;
    ideOutlineSyms.push({ kind: mm[1].replace(/\\*$/, ""), name: mm[2], line: line });
  }
  ideOutlineRender();
}
function ideOutlineRender() {
  const list = $("ideOutlineList");
  if (!list) return;
  const t = ideActiveTab();
  const q = String(($("ideOutlineQ") && $("ideOutlineQ").value) || "").toLowerCase();
  if (!t || t.mode !== "edit" || !IDE_OUTLINE_EXT.has(ideOutlineExtOf(t.path))) {
    list.innerHTML = '<div class="cc-empty">' + (t && t.mode === "edit" ? "大纲仅支持 TS/JS(当前文件不支持)" : "打开 TS/JS 文件后展示符号") + "</div>";
    return;
  }
  const rows = ideOutlineSyms.filter((s) => !q || s.name.toLowerCase().indexOf(q) >= 0);
  list.innerHTML = rows.length
    ? rows.map((s, i) => '<div class="ide-p-row" data-ol="' + i + '"><span class="ide-scm-label" style="color:var(--faint)">' + esc(s.kind) + '</span><span>' + esc(s.name) + "</span><span style='margin-left:auto;color:var(--faint)'>" + s.line + "</span></div>").join("")
    : '<div class="cc-empty">无匹配符号</div>';
  for (const el of list.querySelectorAll("[data-ol]")) el.onclick = () => { const s = rows[Number(el.dataset.ol)]; if (!s) return; const t2 = ideActiveTab(); if (!t2) return; t2.revealLine = s.line; ideRevealLine(t2); };
}
$("ideOutlineQ").oninput = () => ideOutlineRender();
function ideOutlineQuick() { // Ctrl+Shift+O:Monaco quickOutline 优先;不可用回退大纲面板(模糊筛选)
  const t = ideActiveTab();
  if (!t || t.mode !== "edit" || !IDE_OUTLINE_EXT.has(ideOutlineExtOf(t.path))) { toast("大纲仅支持 TS/JS 文件"); return; }
  const M = ideMonaco;
  if (M && M.editor && typeof M.editor.getAction === "function") {
    const act = M.editor.getAction("editor.action.quickOutline");
    if (act && act.run) { try { const r = act.run(); if (r && typeof r.then === "function") return; } catch (e) { /* 落回退 */ } }
  }
  ideActSwitch("outline");
  const q = $("ideOutlineQ");
  if (q) { q.value = ""; ideOutlineScan(); q.focus(); }
}
/** Monaco 当前选区行号区间({from,to});编辑器未就绪、无选区或任何异常一律返回 null。 */
function ideSelLineRange() {
  try {
    const ed = (ideMonaco && ideMonaco.editor) ? ideMonaco.editor : (window.__ideMonacoEditor || null);
    if (!ed || typeof ed.getSelection !== "function") return null;
    const sel = ed.getSelection();
    if (!sel || sel.isEmpty()) return null;
    const a = sel.startLineNumber, b = sel.endLineNumber;
    if (!a || !b) return null;
    return { from: Math.min(a, b), to: Math.max(a, b) };
  } catch (e) { return null; }
}
/** 把 IDE 里的文件/目录送进聊天窗:mode="ref" 正文引用(fileRefBar 出 chip);mode="att" 附件 chip。
 * 附件直塞服务端绝对路径(树里的 abs 就是盘上真路径),不复制到 .genie/uploads;
 * 发送仍走既有 task.submit + attachments 通道,协议零改。 */
function ideAddToChat(abs, rel, isDir, mode) {
  if (!rel) return;
  const nm = String(rel).split("/").pop() || rel;
  if (mode === "att") {
    if (pendingAtts.length >= ATT_MAX_COUNT) { toast("附件最多 " + ATT_MAX_COUNT + " 个", true); return; }
 // 类型/上限与上传通道同源判定(attKind 按扩展名兜底:图片走视觉通道、文档走解析器、代码走文本)
    const k = attKind(nm, "");
    if (!k) { toast("该类型不支持作为附件:" + nm, true); return; }
    const cut = abs.lastIndexOf("/");
    const list = cut > 0 ? dirCache.get(abs.slice(0, cut)) : null;
    const ent = list ? list.find((x) => x.name === nm) : null;
    const size = ent && ent.size ? ent.size : 0;
    if (size && size > attLimitOf(k)) { toast("附件超限:" + nm + " 实际 " + attSize(size) + ",上限 " + attSize(attLimitOf(k)), true); return; }
    if (pendingAtts.some((a) => a.path === abs)) toast("该文件已在待发附件里");
    else {
 // 不写死 mime:留空让客户端 attKind 与服务端 classifyAttachment 都按扩展名判型,
 // 否则 png/zip 被标成 text/plain 后按 utf8 读成乱码。
      pendingAtts.push({ name: nm, path: abs, ...(size ? { size } : {}), kind: k });
      attRender();
      toast("已加入待发附件:" + nm);
    }
  } else {
    const inp = $("instruction");
    let tok = buildFileMention(rel, isDir ? "dir" : "file");
    if (tok && !isDir) { const rg = ideSelLineRange(); if (rg) tok += " (L" + rg.from + "-L" + rg.to + ")"; }
    if (inp && tok) inp.value = (inp.value.trim() + " " + tok).trim() + " ";
  }
  switchView("chat"); autoGrow(); saveDraft(); fileRefRender(); renderSendBtn(); $("instruction").focus();
}
// ---- 文件树右键菜单(目录:新建文件/新建文件夹/重命名/删除/刷新此目录 + 添加到聊天窗;文件:添加到聊天窗/作为附件添加/打开/重命名/删除/复制路径) ----
function ideRowMenu(abs, rel, isDir, x, y) {
  const items = [];
  if (isDir) {
    items.push({ label: "添加到聊天窗", act: () => ideAddToChat(abs, rel, true, "ref") });
    items.push({ label: "新建文件…", act: () => ideNewFile(abs) });
    items.push({ label: "新建文件夹…", act: () => ideNewDir(abs) });
    items.push({ label: "重命名…", act: () => ideRename(rel) });
    items.push({ label: "删除目录", act: () => ideDelete(rel, true) });
    items.push({ label: "刷新此目录", act: () => { invalidateTreeCache(abs); ideTreeRender(); toast("已刷新 " + rel); } });
  } else {
    items.push({ label: "添加到聊天窗", act: () => ideAddToChat(abs, rel, false, "ref") });
    items.push({ label: "作为附件添加", act: () => ideAddToChat(abs, rel, false, "att") });
    items.push({ label: "打开", act: () => ideOpenFile(rel) });
    items.push({ label: "重命名…", act: () => ideRename(rel) });
    items.push({ label: "删除", act: () => ideDelete(rel, false) });
    items.push({ label: "复制路径", act: () => copyText(rel) });
  }
  openMenuAt(items, x, y);
}
$("ideNewFile").onclick = () => ideNewFile("");
$("ideNewDir").onclick = () => ideNewDir("");
$("ideFindClose").onclick = () => ideFindClose();
$("ideFindQ").oninput = () => { ideFindQuery = $("ideFindQ").value.trim(); };
$("ideFindQ").onkeydown = (e) => {
  if (e.key === "Enter") { e.preventDefault(); ideFindSearch(); }
  else if (e.key === "Escape") { e.preventDefault(); ideFindClose(); }
};
$("ideFindRe").onchange = () => { if ($("ideFindQ").value.trim()) ideFindSearch(); };
$("ideCmdQ").oninput = () => { ideCmdHot = 0; ideCmdRender(); };
$("ideCmd").onclick = (e) => { if (e.target === $("ideCmd")) ideCmdClose(); };
// IDE 域快捷键三监听器(capture,彼此职责分离:①命令面板键盘 ②IDE 动作键 ③搜索面板键盘)。
// 每个都以 dataset.view!=="ide" 早退:非 IDE 视图的 Ctrl+Shift+P(ccOpen)/Ctrl+Shift+F(fitAll)语义零改。
document.addEventListener("keydown", (e) => {
  if (document.body.dataset.view !== "ide") return; // ① 命令面板键盘域守卫
  if (keyCapturing) return; // 设置页录制快捷键时让位
  const cmdBox = $("ideCmd");
  if (!cmdBox || !cmdBox.classList.contains("on")) return;
  if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); ideCmdClose(); return; }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault(); e.stopImmediatePropagation();
    if (!ideCmdItems.length) return;
    ideCmdHot = (ideCmdHot + (e.key === "ArrowDown" ? 1 : ideCmdItems.length - 1)) % ideCmdItems.length;
    ideCmdRender();
    return;
  }
  if (e.key === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); ideCmdExec(ideCmdHot); return; }
}, true);
document.addEventListener("keydown", (e) => {
  if (document.body.dataset.view !== "ide") return; // ② IDE 动作快捷键域守卫
  if (keyCapturing) return;
  const cmdBox = $("ideCmd");
  if (cmdBox && cmdBox.classList.contains("on")) {
 // 命令面板开着:除 ↑↓/Enter/Esc(上面那个监听器)外,单字符输入归输入框
    if (e.key.length === 1 || e.key === "Backspace") return;
  }
  const ctrl = e.ctrlKey || e.metaKey;
  const key = String(e.key || "").toLowerCase();
 // Ctrl+S 保存(IDE 视图内全局:树/标签条有焦点时也要能存;旧实现只认编辑区焦点)
  if (ctrl && key === "s" && !e.altKey) { e.preventDefault(); e.stopImmediatePropagation(); ideSaveNow(); return; }
  if (hitKey(e, "ide-command-palette")) { e.preventDefault(); e.stopImmediatePropagation(); cmdBox && cmdBox.classList.contains("on") ? ideCmdClose() : ideCmdOpen("all"); return; }
  if (hitKey(e, "ide-goto-file")) { e.preventDefault(); e.stopImmediatePropagation(); ideCmdOpen("files"); return; }
  if (hitKey(e, "ide-search")) { e.preventDefault(); e.stopImmediatePropagation(); ideFindOpen(); return; }
  if (hitKey(e, "ide-rename")) { e.preventDefault(); e.stopImmediatePropagation(); ideRenameActive(); return; }
  if (hitKey(e, "ide-new-file")) { e.preventDefault(); e.stopImmediatePropagation(); ideNewFile(""); return; }
  if (hitKey(e, "ide-close-tab")) { e.preventDefault(); e.stopImmediatePropagation(); ideCloseActive(); return; }
  if (hitKey(e, "ide-wordwrap")) { e.preventDefault(); e.stopImmediatePropagation(); ideToggleWordWrap(); return; }
  if (hitKey(e, "ide-terminal")) { e.preventDefault(); e.stopImmediatePropagation(); ideTermToggle(); return; }
  if (hitKey(e, "ide-outline")) { e.preventDefault(); e.stopImmediatePropagation(); ideOutlineQuick(); return; }
 // Ctrl+F / Ctrl+H:不拦,交 Monaco 自己的 find widget(addCommand 已绑)
  if (ctrl && (key === "f" || key === "h") && !e.shiftKey) { if ($("ideFind").classList.contains("on")) ideFindClose(); return; }
}, true);
document.addEventListener("keydown", (e) => {
  if (document.body.dataset.view !== "ide") return; // ③ 全项目搜索面板键盘域守卫
  const panel = $("ideFind");
  if (!panel || !panel.classList.contains("on")) return;
  if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); ideFindClose(); return; }
  if (e.key === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); ideFindSearch(); return; }
}, true);
window.addEventListener("resize", applyTaskMask);
// 项目/时间/分组 视图切换(复刻 ZCode organizeBy project|chronological + F3 自定义分组,持久化)
function setOrganize(o) {
  organize = o; localStorage.setItem("zh:sb-organize", o);
  $("tt-proj").classList.toggle("on", o === "project");
  $("tt-time").classList.toggle("on", o === "time");
  $("tt-group").classList.toggle("on", o === "group");
  renderSidebar();
}
$("tt-proj").onclick = () => setOrganize("project");
$("tt-time").onclick = () => setOrganize("time");
$("tt-group").onclick = () => setOrganize("group");
setOrganize(organize);
function renderSortBtn() { $("tt-sort").textContent = settings.sortBy === "created" ? "创建" : "更新"; $("tt-sort").classList.toggle("on", settings.sortBy === "created"); }
$("tt-sort").onclick = () => {
  settings.sortBy = settings.sortBy === "created" ? "updated" : "created";
  localStorage.setItem("zh:sort", settings.sortBy);
  renderSortBtn(); renderSidebar();
};
renderSortBtn();
applySettings();
beautifyAllSelects(); // 全量原生 select 镜像接管(动态注入走 MutationObserver)
wireSettings();
setSection(settingsSection);
switchView("chat");
// ---- 仓库 Wiki:左页导航 + 右 markdown(引用可点回源)+ 页内 mermaid ----
let wikiManifest = null, wikiCurrentPage = "";
const WIKI_GROUPS = [["overview", "概览"], ["flow", "全仓流程"], ["structure", "结构"], ["modules", "模块"], ["entrypoints", "入口"], ["graph", "依赖图"], ["guide", "语义指南"], ["features", "功能拆解"], ["algo", "关键流程"]];
function wikiLoad() {
  $("wikiMeta").textContent = "加载中…";
  wsSafeSend(JSON.stringify({ v: 1, type: "wiki.list", ...(activeProjectId ? { projectId: activeProjectId } : {}) }));
}
function wikiOpenPage(id) {
  if (!id) return;
  wikiCurrentPage = id;
  const rows = $("wikiNav").querySelectorAll(".wiki-page");
  for (let i = 0; i < rows.length; i++) rows[i].classList.toggle("on", rows[i].getAttribute("data-page") === id);
  $("wikiMd").innerHTML = '<div class="cc-empty loading">加载中…</div>';
  $("wikiPageTitle").textContent = "";
  $("wikiPageCites").textContent = "";
  wsSafeSend(JSON.stringify({ v: 1, type: "wiki.get", page: id, ...(activeProjectId ? { projectId: activeProjectId } : {}) }));
}
function wikiRenderManifest(m) {
  wikiManifest = m || null;
  const nav = $("wikiNav");
  if (!m || !m.pages || m.pages.length === 0) {
    $("wikiMeta").textContent = "未生成";
    nav.innerHTML = '<div class="cc-empty">该仓库还没有 wiki</div>';
    $("wikiPageTitle").textContent = "";
    $("wikiPageCites").textContent = "";
    $("wikiMd").innerHTML = '<div class="wiki-empty-note">点右上「重建」生成 wiki。确定性骨架不需要 LLM;配置 LLM 后生成带引用回查的叙述页。<br>存储:.genie/wiki/&lt;repo&gt;/</div>';
    return false;
  }
  const audit = m.citationAudit || {};
  const sha = m.gitHead ? String(m.gitHead).slice(0, 10) : "无 sha";
  const llmOn = !!(m.llm && m.llm.enabled);
  const flowInfo = m.flow ? " · 流程 " + m.flow.nodes + "节点/" + m.flow.edges + "边(" + (m.flow.source === "index" ? "符号级" : "词法级") + ")" : "";
  $("wikiMeta").textContent = (m.repo || "") + " · " + m.pages.length + " 页 · " + (llmOn ? "LLM " + ((m.llm.pages || []).length) + " 页" : "确定性骨架") + " · git " + sha + " · 引用 " + (audit.passed || 0) + "/" + (audit.checked || 0) + flowInfo;
  const bySec = {};
  for (const p of m.pages) { if (!bySec[p.section]) bySec[p.section] = []; bySec[p.section].push(p); }
  let html = "";
  for (const g of WIKI_GROUPS) {
    const arr = bySec[g[0]] || [];
    if (!arr.length) continue;
    html += '<div class="wiki-group"><div class="wiki-group-t">' + esc(g[1]) + '</div>';
    for (const p of arr) {
      html += '<div class="wiki-page' + (p.id === wikiCurrentPage ? ' on' : '') + '" data-page="' + esc(p.id) + '" title="' + esc(p.title) + '"><span class="wiki-page-t">' + esc(p.title) + '</span><span class="wiki-refs">' + ((p.citations || []).length) + '</span></div>';
    }
    html += '</div>';
  }
  nav.innerHTML = html;
  return true;
}
function wikiRenderMarkdown(md) {
  const host = $("wikiMd");
  host.innerHTML = mdToHtml(md || "", "");
  mmRenderIn(host); // mermaid 围栏懒加载出图(改版,与消息流同语义)
  artRenderIn(host); // html/svg 图卡挂载(同一钩子位置)
  host.scrollTop = 0;
}
function wikiOpenFirst() {
  if (!wikiManifest || !wikiManifest.pages || !wikiManifest.pages.length) return;
  let id = wikiCurrentPage;
  if (!id || !wikiManifest.pages.some(function(p) { return p.id === id; })) id = "overview";
  if (!wikiManifest.pages.some(function(p) { return p.id === id; })) id = wikiManifest.pages[0].id;
  wikiOpenPage(id);
}
function wikiRebuildClick(force) {
  const send = function() {
    $("wikiRebuild").disabled = true;
    $("wikiForce").disabled = true;
    $("wikiMeta").textContent = force ? "强制重建中…(LLM 叙述页可能数十秒)" : "重建中…";
    wsSafeSend(JSON.stringify({ v: 1, type: "wiki.rebuild", refresh: !!force, ...(activeProjectId ? { projectId: activeProjectId } : {}) }));
  };
  if (force) uiConfirm("强制重建会忽略缓存并重新调用 LLM 生成叙述页(可能数十秒),继续?", { tone: "warning" }).then(function(ok) { if (ok) send(); });
  else send();
}
$("wikiRefresh").onclick = function() { wikiLoad(); };
$("wikiRebuild").onclick = function() { wikiRebuildClick(false); };
$("wikiForce").onclick = function() { wikiRebuildClick(true); };
$("wikiNav").onclick = function(e) {
  const row = e.target && e.target.closest ? e.target.closest(".wiki-page") : null;
  if (row) wikiOpenPage(row.getAttribute("data-page"));
};
// 模块页 → 代码档案结构 tab 对应模块(ppDetail 选中右侧模块列表;模块不在档案数据中=只切 tab)
$("wikiToStructure").onclick = function() {
  const mod = this.getAttribute("data-mod") || "";
  projectSetTab("structure", true);
  if (mod) {
 // 档案模块名与 wiki 模块名可能不同粒度(packages/alpha vs alpha):按全名→末段→包含 三级匹配
    try {
      const mods = (ppData && ppData.modules) || [];
      const hit = mods.find(function(m) { return m.name === mod; })
        || mods.find(function(m) { return m.name === mod.split("/").pop(); })
        || mods.find(function(m) { return mod.indexOf(m.name) >= 0; });
      if (hit) ppDetail(hit.name);
    } catch (e) { /* 档案数据未就绪:只切 tab */ }
    const el = $("ppDetail");
    if (el) el.scrollIntoView({ block: "nearest" });
  }
};

async function senseRun() {
  const q = $("sense-q").value.trim();
  if (!q) return;
  $("sense-status").textContent = "分析中…"; $("sense-detail").textContent = ""; $("sense-mermaid").textContent = "……";
 // 项目级 code-sense:查询挂激活项目根(无项目服务端回退 harness 根)
  wsSafeSend(JSON.stringify({ v: 1, type: "sense.query", query: q, mode: $("sense-mode").value, ...(activeProjectId ? { projectId: activeProjectId } : {}) }));
}
$("sense-go").onclick = senseRun;
// ---- 洞察产物带入白板(可编辑语义板;服务端 board.fromsense 重新按源生成) ----
let senseLastResult = null;
$("senseToBoard").onclick = () => {
  if (!currentSid) { toast("先进入一个会话", true); return; }
  const r = senseLastResult;
  if (!r) { toast("先跑一次分析", true); return; }
  let source = "", query = "";
  if (r.callchain && r.sequence) { source = "sequence"; query = r.callchain.center.name; }
  else if (r.architecture && (r.architecture.nodes || []).length) source = "archmap";
  else if (r.pageflow && r.pageflow.pages && r.pageflow.pages.length) source = "pageflow";
  else if (r.modules && r.modules.length) source = "modulemap";
  if (!source) { toast("当前剖面无可转换产物", true); return; }
  wsSafeSend(JSON.stringify({ v: 1, type: "board.fromsense", sessionId: currentSid, source, ...(query ? { query } : {}), ...(activeProjectId ? { projectId: activeProjectId } : {}) }));
  toast("生成语义板中…");
};
// ---- 评审遗留(行级回写店:sticky 跨轮消费视图 ----
function revStoreLoad() {
  wsSafeSend(JSON.stringify({ v: 1, type: "review.store.get", ...(activeProjectId ? { projectId: activeProjectId } : {}) }));
}
let revStoreData = null; // 最近一次 review.store.result(注入勾选的数据源)
function revStoreRender(m) {
  const body = $("revStoreBody");
  if (!body) return;
  revStoreData = m;
  if (!m.open.length && !m.resolved.length) {
    body.innerHTML = '<div class="cc-empty">店为空:该项目尚无评审发现(或从未跑过评审)</div>';
    return;
  }
 // open 区可注入(单条钮+勾选批量);resolved 已解决不再注入。
  const row = (c, i, inj) =>
    '<div class="rev-card" data-file="' + esc(c.path) + '" data-line="' + Number(c.line || 1) + '">' +
    (inj ? '<input type="checkbox" class="rev-sel" data-i="' + i + '" title="勾选后可批量注入">' : "") +
    '<span class="rev-sev ' + esc(String(c.severity || "info")) + '">' + ((c.severity === "warning") ? ic("warn") : (c.severity === "nit") ? ic("dot") : "") + esc(String(c.severity || "info").toUpperCase()) + "</span>" +
    '<span class="rev-loc">' + esc(c.path) + ":" + Number(c.line || 1) + (c.rule ? " · " + esc(c.rule) : "") + "</span>" +
    '<span style="flex:1;min-width:0"><div class="rev-title">' + esc(String(c.message || "").slice(0, 140)) + "</div>" +
    (c.repostCount ? '<div class="rev-detail">复现 ' + Number(c.repostCount) + " 次</div>" : "") + "</span>" +
    (inj ? '<button class="rev-inj rev-inj-store" data-i="' + i + '" title="把这条评论注入聊天窗,交 agent 修复">' + ic("inject") + "修复</button>" : "") + "</div>";
  body.innerHTML =
    '<div style="font-size:11px;color:var(--muted);margin:4px 0">开放 ' + m.open.length + " · 已解决 " + m.resolved.length + " · 根: " + esc(m.root) + "</div>" +
    (m.open.length
      ? '<div class="rev-store-bar"><button id="revInjSel" disabled>' + ic("inject") + ' 注入选中(0)</button><button id="revInjAll">' + ic("inject") + " 全部注入(" + m.open.length + ")</button></div>"
      : "") +
    m.open.map((c, i) => row(c, i, true)).join("") +
    (m.resolved.length
      ? '<details style="margin-top:6px"><summary style="cursor:pointer;font-size:11px;color:var(--muted)">已解决 ' + m.resolved.length + " 条(不再复现,保留历史)</summary>" + m.resolved.map((c, i) => row(c, i, false)).join("") + "</details>"
      : "");
  const selBtn = $("revInjSel"), allBtn = $("revInjAll");
  if (selBtn) selBtn.onclick = () => revInjectStoreSelected();
  if (allBtn) allBtn.onclick = () => revInjectOpen(revStoreData.open.map(revStoreItem), "回写店全部开放评论", null);
}
// ---- 评审评论一键回注聊天窗 ----
// 店条目 → 注入载荷形态(message 同时承载 title;rule 保留)
function revStoreItem(c) {
  return { file: String(c.path || ""), line: Number(c.line || 1), severity: String(c.severity || "info"), title: String(c.message || "").slice(0, 140), detail: "", rule: c.rule ? String(c.rule) : "" };
}
// 会话卡注入钮入口(click 委托先于 fvOpen 拦到这里)
function revInjectFromBtn(btn) {
  if (btn.classList.contains("rev-inj-store")) {
    if (!revStoreData) { toast("回写店数据未加载", true); return; }
    const c = revStoreData.open[Number(btn.dataset.i)];
    if (c) revInjectOpen([revStoreItem(c)], "回写店单条", null);
    return;
  }
  const src = revSrcCache[btn.dataset.rev];
  if (!src || !src.items.length) { toast("评论数据已过期(会话已重渲染),请重试", true); return; }
  if (btn.classList.contains("rev-inj-all")) { revInjectOpen(src.items, "会话评论卡整批", src.sid); return; }
  const it = src.items[Number(btn.dataset.i)];
  if (it) revInjectOpen([it], "会话评论卡单条", src.sid);
}
function revInjectStoreSelected() {
  if (!revStoreData) return;
  const picks = [...$("revStoreBody").querySelectorAll(".rev-sel:checked")].map((el) => revStoreData.open[Number(el.dataset.i)]).filter(Boolean);
  if (!picks.length) { toast("先勾选要注入的评论", true); return; }
  revInjectOpen(picks.map(revStoreItem), "回写店勾选 " + picks.length + " 条", null);
}
function revSelCount() {
  const n = $("revStoreBody") ? $("revStoreBody").querySelectorAll(".rev-sel:checked").length : 0;
  const b = $("revInjSel");
  if (b) { b.innerHTML = ic("inject") + " 注入选中(" + n + ")"; b.disabled = n === 0; }
}
document.addEventListener("change", (e) => { if (e.target && e.target.classList && e.target.classList.contains("rev-sel")) revSelCount(); });
// 会话 label:该会话最近任务标题(无则 sid 本体)——注入目标指示/成功回执共用
function sidLabel(sid) {
  if (!sid) return "";
  const ts = [...tasks.values()].filter((t) => t.sessionId === sid);
  if (ts.length) return rowTitle(ts[ts.length - 1]).slice(0, 24);
  return sid;
}
let revInjPending = null; // {items, sourceLabel, ownerSid}
function revInjectOpen(items, sourceLabel, ownerSid) {
  items = (items || []).filter((x) => x && x.file && x.title);
  if (!items.length) { toast("没有可注入的评论", true); return; }
  revInjPending = { items, sourceLabel, ownerSid: ownerSid || null };
 // 目标会话选项:评论所属会话(存在且≠当前时置顶)/当前会话/新会话
  const opts = [];
  if (ownerSid && ownerSid !== currentSid) opts.push({ v: ownerSid, label: '评论所属会话「' + sidLabel(ownerSid) + "」" });
  if (currentSid) opts.push({ v: currentSid, label: '当前会话「' + sidLabel(currentSid) + "」" });
  opts.push({ v: "web-" + Date.now(), label: "新会话" });
  $("revInjBody").innerHTML =
    '<div class="rij-count">' + esc(sourceLabel) + " · 共 " + items.length + " 条</div>" +
    items.slice(0, 3).map((it) => '<div class="rij-item">[' + esc(String(it.severity || "info").toUpperCase()) + "] " + esc(it.file) + ":" + Number(it.line || 1) + " " + esc(String(it.title).slice(0, 60)) + "</div>").join("") +
    (items.length > 3 ? '<div class="rij-more">… 其余 ' + (items.length - 3) + " 条不预览,注入指令中含全量</div>" : "") +
    '<div class="rij-target">注入目标会话:</div>' +
    opts.map((o, i) => '<label class="rij-opt"><input type="radio" name="revInjTarget" value="' + esc(o.v) + '"' + (i === 0 ? " checked" : "") + ">" + esc(o.label) + "</label>").join("") +
    '<input class="rij-note" id="revInjNote" placeholder="附言(可选,拼进指令尾部)" autocomplete="off">' +
    '<button class="rij-go" id="revInjGo">注入 → 交 agent 逐条修复</button>';
  $("revInjMask").classList.add("on");
  $("revInjGo").onclick = () => {
    const sel = $("revInjBody").querySelector('input[name="revInjTarget"]:checked');
    const target = sel ? sel.value : null;
    if (!target) { toast("请选择目标会话", true); return; }
    const note = $("revInjNote").value.trim();
    const p = revInjPending;
 // 幂等键:目标会话+评论键集(同批重发/双击不重复立任务,服务端 TaskSupervisor 幂等)
    const key = "revinj:" + target + ":" + p.items.map((x) => x.file + ":" + x.line + ":" + x.title.slice(0, 24)).join(",").slice(0, 400);
    wsSafeSend(JSON.stringify({ v: 1, type: "review.inject", sessionId: target, items: p.items, ...(note ? { note } : {}), idempotencyKey: key, source: p.sourceLabel, ...(activeProjectId ? { projectId: activeProjectId } : {}) }));
    $("revInjMask").classList.remove("on");
    revInjPending = null;
  };
}
$("revInjCancel").onclick = () => { $("revInjMask").classList.remove("on"); revInjPending = null; };
$("revInjMask").onclick = (e) => { if (e.target === $("revInjMask")) { $("revInjMask").classList.remove("on"); revInjPending = null; } };
$("revStoreRefresh").onclick = () => revStoreLoad();
$("sense-q").onkeydown = (e) => { if (e.key === "Enter") senseRun(); };
// 关系图节点点击下钻( v4:点节点=以该节点为新 query 的 debug 剖面)——
// 渲染器严格 XML 转义(archmap 的 LLM 产物不可放宽),经 g 元素 id 对照结果内 nodes 表
function bindSenseDrill(host, nodes) {
  const byId = {};
  for (const n of nodes) byId[n.id] = n.name;
  host.querySelectorAll("svg g.node").forEach(function (el) {
    const segs = String(el.id || "").split("-");
    let nid = byId[el.id] ? el.id : null;
    for (let i = 0; !nid && i < segs.length; i++) if (byId[segs[i]]) nid = segs[i];
    if (!nid) return;
    el.style.cursor = "pointer";
    el.setAttribute("data-drill", byId[nid]);
    el.addEventListener("click", function () {
      $("sense-q").value = byId[nid];
      $("sense-mode").value = "debug";
      senseRun();
    });
  });
}
$("exp-refresh").onclick = () => { $("exp-body").style.display = "none"; wsSafeSend(JSON.stringify({ v: 1, type: "exp.list" })); };
// 自动化卡片 → 提交为任务(主 agent 调 run_workflow);JSON 参数先本地校验
function submitWf(text) {
  const sid = "wf-" + Date.now();
  currentSid = sid;
  wsSafeSend(JSON.stringify({ v: 1, type: "task.submit", sessionId: sid, instruction: text, idempotencyKey: "wf-" + Date.now() + "-" + Math.floor(Math.random() * 1e6), ...(activeProjectId ? { projectId: activeProjectId } : {}) }));
  switchView("chat"); render();
}
function wfJsonArgs(inputId, errId, expectArrayItemKeys) {
  const el = $(inputId), err = $(errId);
  el.classList.remove("bad"); err.style.display = "none";
  let v;
  try { v = JSON.parse(el.value.trim()); } catch (e) { el.classList.add("bad"); err.style.display = "block"; return null; }
  if (!Array.isArray(v) || !v.length || typeof v[0] !== "object" || !expectArrayItemKeys.every((k) => k in v[0])) {
    el.classList.add("bad"); err.style.display = "block"; return null;
  }
  return JSON.stringify(v);
}
$("wf-unit").onclick = () => submitWf('使用 run_workflow 工具执行模板 "unit-tests"(自动发现 packages/* 并逐包跑测试,失败包给出根因分析),args 用空对象 {}');
$("wf-func").onclick = () => {
  const raw = wfJsonArgs("wf-func-args", "wf-func-err", ["name", "run"]);
  if (raw) submitWf('使用 run_workflow 工具执行模板 "functional-test",args=' + raw);
  else $("wf-func-args").focus();
};
$("wf-algo").onclick = () => {
  const raw = wfJsonArgs("wf-algo-args", "wf-algo-err", ["id", "input", "expect"]);
  if (raw) submitWf('使用 run_workflow 工具执行模板 "algo-eval",args=' + raw);
  else $("wf-algo-args").focus();
};

// ==================== 无限画布外壳接线 ====================
// 界面改成无限画布,各模块=画布上的卡片,最左侧=快速定位栏,卡片可自由移动/缩放。
// 本段只做「桥接」:卡片规格(对应 #view-* 节点)+ 激活(复用 switchViewActivate)+ 尺寸重算
// (白板/对话等「可见即量尺寸」类补偿)+ 形态切换收尾。视图内部逻辑零改写。
// 命名约定(质感轮):title = 「中文意象 + 英文锚点」——中文保语义一眼可辨,英文锚一两个字收气质;
// tag = 卡片副标,「·」分隔的职能词。侧栏按钮/各视图 vw-title/经典态 header(VIEW_NAMES)都以本表为单一来源,
// 防回归守卫在 test/panel-card-naming.test.ts(改这里必须同步那三处,漏一处测试红)。
const CV_CARDS = [
  { name: "chat", node: "view-tasks", title: "会话流 Chat", tag: "任务即对话", x: 0, y: 0, w: 900, h: 640 },
  { name: "term", node: "view-term", title: "命令台 Shell", tag: "Ctrl+J 直达", x: 0, y: 680, w: 760, h: 440 },
  { name: "git", node: "view-git", title: "Git", tag: "提交 · 快照 · 分支", x: 0, y: 1160, w: 760, h: 520 },
  { name: "files", node: "view-files", title: "文件树 Files", tag: "项目目录全景", x: 0, y: 1720, w: 640, h: 520 },
  { name: "ide", node: "view-ide", title: "编辑器 IDE", tag: "树 · 标签 · 编辑", x: 0, y: 2280, w: 1100, h: 760 },
  { name: "board", node: "view-board", title: "白板 Sketch", tag: "先画后改 · 任务草图", x: 940, y: 0, w: 980, h: 680 },
  { name: "project", node: "view-project", title: "代码档案 Atlas", tag: "架构 · 模块 · 总路线", x: 940, y: 720, w: 980, h: 720 },
  { name: "sense", node: "view-sense", title: "代码透镜 Lens", tag: "符号 · 影响 · 剖面", x: 1960, y: 0, w: 760, h: 560 },
  { name: "wf", node: "view-wf", title: "自动化 Flows", tag: "run_workflow · 确定性编排", x: 1960, y: 600, w: 720, h: 520 },
  { name: "exp", node: "view-exp", title: "经验库 Memo", tag: "Hermes 沉淀 · 开工回顾", x: 1960, y: 1160, w: 720, h: 460 },
  { name: "team", node: "view-team", title: "团队 Crew", tag: "成员 · Issue · 看板", x: 2760, y: 0, w: 900, h: 620 },
  { name: "nodes", node: "view-nodes", title: "节点 Fleet", tag: "注册表 · 负载 · 远程执行", x: 2760, y: 660, w: 640, h: 420 },
  { name: "approvals", node: "view-approvals", title: "关卡 Gate", tag: "挂起权限 · 批量放行", x: 2760, y: 1120, w: 640, h: 380 },
  { name: "market", node: "view-market", title: "插件市场 Market", tag: "资产包 · 安装即接线", x: 2760, y: 1540, w: 720, h: 520 },
  { name: "browser", node: "view-browser", title: "网页 Webview", tag: "面板内嵌 · 新窗口兜底", x: 3660, y: 0, w: 820, h: 560 },
  { name: "sys", node: "view-sys", title: "配置台 Config", tag: "模型 · 主题 · 快捷键", x: 3660, y: 600, w: 820, h: 720 },
 // n3 看板融合:「分身 Agents」卡已删——注册/运行态/终态/失败原因(reap)/模型/会话短码
 // 全部并入「子agent会话流」左栏条目(同一对象 agentId,两块看板数据 100% 重合,用户用户反馈「重复」)。
  { name: "subchat", node: "view-subchat", title: "子代理会话流", tag: "分身注册 · 消息流", x: 4520, y: 0, w: 780, h: 900 },
  { name: "track", node: "view-track", title: "追踪 Trace", tag: "召回审途 · 五阶段", x: 4520, y: 520, w: 760, h: 900 },
 // 轨迹拆成独立看板视图(逐次决策 + 事件账本 + 泳道,数据源 = histEvents)。
 // 坐标紧邻 track 卡右移一格(y 同排);世界边界见 canvas-shell.js 缩放下限注释。
  { name: "traj", node: "view-traj", title: "轨迹 Trail", tag: "决策 · 账本 · 泳道", x: 5320, y: 520, w: 900, h: 900 },
  { name: "usage", node: "view-usage", title: "吞吐 Telemetry", tag: "token · 调用 · 缓存", x: 4520, y: 1180, w: 720, h: 460 },
 // Super Agent 指挥台(独立画布卡:持久聊天渲染区+调度看板四区;经典侧栏 act-super 同名同串)。
 // 卡宽 900→1400(三栏 56+280+1fr+聊天360 至少要 ~1200 才能中栏≥500;旧卡右键「恢复到默认位置」即取本表新几何)。
  { name: "super", node: "view-super", title: "指挥台 Super", tag: "调度 · 看板 · 联调", x: 5320, y: 1460, w: 1400, h: 760 },
];
// CV_VIEW_OF_CARD 已在文件上方(画布外壳段落,7182)统一定义——本段复用,不再重复声明(重复 const 会抛 SyntaxError)。
// cvActivated / cvSessionSid 同理由上段(onSessionChange 区)声明:openSession 启动恢复会先用到,此处不再重复声明。
/** 卡片第一次进入视口/被聚焦时激活对应视图:只拉数据(loadViewData),**不改视图身份**。
 * 身份由「焦点卡」(onFocus)改,否则多卡并行进入视口时身份会被后进视口的那张改掉,
 * 切回经典布局就会显示错的页面(经验证:焦点在代码档案,切经典却回到文件视图)。 */
function canvasActivateCard(card) {
  const name = cvCardName(card); // n3 别名回退:旧卡名 subagents/agents → subchat
  const view = CV_VIEW_OF_CARD[name];
  if (!view) return;
  const key = cvActKey(currentSid, view);
 // 画布新鲜度:卡在视口外时收到的 board.changed 只记脏标;滚回视口必须补拉一次。
  const dirty = view === "board" && bdViewDirty;
  if (dirty) bdViewDirty = false;
  if (cvActivated.has(key) && !dirty) return;
  cvActivated.add(key);
  try { loadViewData(view, currentSid); } catch (err) { console.warn("[canvas] 卡片取数失败", view, err); }
}
/** 卡片尺寸变化后的重算(「可见即量尺寸」类视图必须补偿,否则量到 0 或错位)。
 * 这些补偿是"锦上添花"型:单个视图重算失败不该阻断画布交互,故 catch 后 warn 留痕(fail-visible but non-fatal)。
 * 二期补充:顶部 header 隐藏后画布可用尺寸整体变化,含表格/图/时序的视图都要再拉一次布局,
 * 否则会停在 header 还在时的旧尺寸(规划稿风险 3)。 */
function canvasAfterResize(name) {
  if (name === "board") { try { wbResize(); } catch (e) { console.warn("[canvas] 白板尺寸重算失败", e); } return; }
  if (name === "chat") {
    try { applyTaskMask(); } catch (e) { console.warn("[canvas] 对话滚动遮罩重算失败", e); }
    const body = $("chatBody");
    const st = $("view-tasks");
 // 原来贴底看最新消息的,缩放后仍贴底(否则窗口变窄重排会把最新一条挤走)
    if (st && body && st.scrollHeight - st.scrollTop - st.clientHeight < 120) st.scrollTop = st.scrollHeight;
    return;
  }
  if (name === "term") { const tb = $("termBody"); if (tb) tb.scrollTop = tb.scrollHeight; return; }
  if (name === "project") { try { if (ppData) ppRender(ppData); } catch (e) { console.warn("[canvas] 代码档案重排失败", e); } return; }
 // 重渲即可自适应新尺寸的视图(纯 render 函数,无副作用):
  if (name === "git") { try { gitLoad(); } catch (e) { console.warn("[canvas] Git 重排失败", e); } return; }
  if (name === "files") { try { filesRender(); } catch (e) { console.warn("[canvas] 文件树重排失败", e); } return; }
  if (name === "approvals") { try { renderApprovals(); } catch (e) { console.warn("[canvas] 审批重排失败", e); } return; }
  if (name === "team") { try { if (viewLive("dash")) dashRender(); else renderP2pStrip(); } catch (e) { console.warn("[canvas] 团队重排失败", e); } return; }
  if (name === "exp") { try { renderExp(); } catch (e) { console.warn("[canvas] 经验库重排失败", e); } return; }
  if (name === "super") { try { supRenderBoard(); } catch (e) { console.warn("[canvas] 指挥台重排失败", e); } return; } // 卡内重排后看板四区重渲(聊天区 flex 自适应无需补偿)
}
const CV_BRIDGE = {
  specs: CV_CARDS,
  activate: canvasActivateCard,
  resized: canvasAfterResize,
 /** 画布焦点变化 → 面板的「当前视图」身份跟着走(mainView/dataset/侧栏点亮)。
 * 这是切回经典布局时显示哪一页的唯一依据,必须每次焦点都同步,不能只在首次激活时同步。 */
  onFocus(card) {
 // 身份只随「画布态」的焦点走。经典形态下画布内部的 focus 回调(如首屏 40ms 恒落对话卡
 // 的定时器在退出画布后仍触发)会把恢复的视图身份洗回 chat——经验证刷新落在指挥台后 bodyView 被洗成
 // chat。经典布局的身份唯一出口是 switchViewActivate,此处一律不同步。
    if (!canvasActive()) return;
    const view = CV_VIEW_OF_CARD[card];
 // 画布焦点=当前使用面:Super 卡聚焦时立即拉 rsi.status 并起 15s 轮询(否则画布里健康屏
 // 永远停在「正在加载」;经典布局的 rsiPollSync 只在 switchView 时触发,画布 focus 不走那里)。
    try { rsiPollSync(view === "super" || view === "dream" || view === "rsi" || view === "task" ? "super" : "canvas-other"); } catch (e) { /* 轮询失败不影响焦点 */ }
    if (!view || view === mainView) return;
 // 子标签身份保护(「看板呢」注意):team 卡承载 team/dash/issues 三子标签,
 // 焦点落在 team 卡≠用户点了「成员」——切子标签后 showCard→focus 回调会把身份洗回 team,
 // viewLive("dash") 恒假 → 看板数据到了也被渲染守卫全吞(永久空板)。dash/issues 身份只随子标签点击切换。
 // RSI-PLACE 同理:RSI 看板是指挥台卡第二子标签,焦点回 super 卡不得把身份洗净。
    if (view === "team" && (mainView === "dash" || mainView === "issues")) return;
    if (view === "super" && mainView === "rsi") return;
    if (view === "super" && mainView === "rsichat") return; // SUPER-CHAT 同理:会话Chat 也是指挥台子标签,焦点不得洗身份
    setViewIdentity(view); // 身份唯一出口:mainView/sessionStorage/dataset/导航点亮一次到位
  },
  onMode(mode, initial) {
 // 经典→画布:把焦点切回原视图对应卡片;画布→经典:补回经典 .on 态(单视图焦点)。
 // 这里吞异常=有意:形态切换是纯 UI 动作,任一侧失败都不该让面板卡死;失败已入 console.warn 留痕。
    if (mode === "classic") {
      try { switchViewActivate(mainView || "chat"); } catch (e) { console.warn("[canvas] 经典布局恢复焦点失败", e); }
      if (!initial) toast("已切回经典单视图布局");
      return;
    }
    if (!initial) toast("已切到无限画布布局 · 双击卡片打开,拖动标题移动");
 // 画布形态专属收尾:①连接状态下沉到定位栏(header 已隐藏,否则用户失去连没连上的信号)
 // ②卡片状态点按真实数据点亮 ③(仅手动切换时)回到上次焦点卡 + 触发一轮尺寸重算
    cvConn(!!(ws && ws.readyState === 1), ws && ws.readyState === 1 ? "已连接" : "连接中…");
    try { cvStatusRefresh(); } catch (e) { console.warn("[canvas] 状态点刷新失败", e); }
    if (initial) { // 启动恢复:取景交给画布首屏逻辑(恒落对话卡),但首次进画布给一次操作提示
      try {
        if (!localStorage.getItem("zh:cv-hint")) {
          localStorage.setItem("zh:cv-hint", "1");
          setTimeout(function () { try { toast("画布模式:双击卡片打开,拖动标题移动,滚轮缩放"); } catch (e) { /* 忽略 */ } }, 900);
        }
      } catch (e) { /* 隐私模式:忽略 */ }
      return;
    }
    setTimeout(function () {
      try { CanvasShell.focus(mainView && CARD_OF_VIEW[mainView] ? CARD_OF_VIEW[mainView] : "chat", { keepView: true }); }
      catch (e) { console.warn("[canvas] 画布布局恢复焦点失败", e); }
 // header 隐藏后画布整体变高:让每张已激活的卡再量一次尺寸(n6 键=sid|card,按 view 去重)
      const resized = new Set();
      for (const key of cvActivated) { const cut = String(key).lastIndexOf("|"); if (cut > 0) resized.add(String(key).slice(cut + 1)); }
      for (const view of resized) {
        try { canvasAfterResize(view); } catch (e) { /* 单视图重算失败不阻断 */ }
      }
    }, 60);
  },
};
// 无边框桌面窗口控制:只认 preload 注入的 genieWindow;浏览器里整块不显示。
(function initDesktopWindowChrome() {
  const api = window.genieWindow;
  if (!api || !api.isDesktop) return;
  document.body.classList.add("desktop-shell");
  const host = $("winControls");
  if (!host) return;
  const btnMin = host.querySelector('[data-win="min"]');
  const btnMax = host.querySelector('[data-win="max"]');
  const btnClose = host.querySelector('[data-win="close"]');
  const dragBar = $("winDragBar");
  const paintMax = (max) => {
    if (!btnMax) return;
    btnMax.classList.toggle("is-max", !!max);
    btnMax.title = max ? "还原" : "最大化";
    btnMax.setAttribute("aria-label", max ? "还原" : "最大化");
  };
  if (btnMin) btnMin.onclick = () => { void api.minimize(); };
  if (btnMax) btnMax.onclick = async () => { try { paintMax(await api.toggleMaximize()); } catch (e) { /* 窗口已销毁 */ } };
  if (btnClose) btnClose.onclick = () => { void api.close(); };
  if (dragBar) dragBar.ondblclick = async () => { try { paintMax(await api.toggleMaximize()); } catch (e) { /* 窗口已销毁 */ } };
  try { api.isMaximized().then(paintMax).catch(() => {}); } catch (e) { /* 旧壳无此方法 */ }
  if (api.onMaximizeChange) api.onMaximizeChange(paintMax);
})();

// ---- 启动恢复(块尾执行;原位置见 navHist 上方注释)----
// ①补放启动视图(savedView 当时只置 dataset 不发消息,避免 CONNECTING 期 send 抛);
// ②重放早到缓存的 hello 帧(onmessage 守卫缓存),走正常 hello 恢复(openSession 里的
// refreshHist/导航此时全部安全)。WS 未开时 onopen 的 hello 会自然兜底,此处仅处理早到帧。
if (startViewPending) switchView(startViewPending);
if (window.__pendingHello && window.__pendingHello.type === "hello") {
  const ph = window.__pendingHello; window.__pendingHello = null;
  (ph.tasks || []).forEach((t) => tasks.set(t.id, t));
  render();
  if (savedSid) openSession(savedSid); // pendingHello 已置空=天然一次性
  if (savedView && savedView !== "chat") switchView(savedView); // 还原用户视图(白板/IDE 刷新恢复依赖)
}
// 声明全部落位后主动刷新一次团队面(窗口期内发的 team.status 会被启动守卫丢弃且无重试;
// 此处补发=eval 完成即有权威快照,用户秒点团队视图也不落空)
try { wsSafeSend(JSON.stringify({ v: 1, type: "team.status" })); } catch (_) {}

// 画布提示出口:资产侧用 window.__cvToast,避免资产直接依赖面板的 toast 实现(资产可单独加载)
window.__cvToast = function (text) { try { toast(String(text)); } catch (e) { console.warn("[canvas]", text); } };
if (window.CanvasShell && window.CanvasShell.init) {
 // 启动恢复:刷新前在指挥台(super 族三栏)时,直接落经典形态——必须在 init 读档(zh:cv-mode)
 // **之前**写 classic:init 即按存档恢复 classic,不触发 enterCanvas/首屏「恒落对话卡」取景(否则 40ms 后
 // 身份/取景被拽回 chat,恢复的 super 卡留在视口外 x=5736,经验证 bodyView 被洗成 chat)。写档后形态与
 // 用户显式切经典一致,再进画布仍走 Ctrl+Shift+C。
  const svStart = startViewPending === "rsi" || startViewPending === "dream" || startViewPending === "task" ? "super" : startViewPending;
  if (svStart === "super") { try { localStorage.setItem("zh:cv-mode", "classic"); } catch (e) { /* 隐私模式:init 会按内存默认走画布,switchView 的运行时守卫再兜底 */ } }
  try { window.CanvasShell.init(CV_BRIDGE); } catch (e) { console.warn("[canvas] init 失败,退回经典布局", e); }
 // 启动取景交给画布自己(首屏恒落对话卡:freshStart 后用户第一眼必须有输入框);
 // 这里若再按 mainView 聚焦回去,会把画布刚摆好的对话卡取景顶掉(经验证首屏 chat 卡仍在视口外)。
} else {
 // 资产未加载(404/旧缓存):留在经典布局,面板功能不受影响
  document.body.classList.remove("cv-shell");
}
</script>
`;
