/**
 * 面板分片:script-ide-1(逐字自 panel.ts PAGE 模板搬移, 拆分)。
 * 模板约束沿袭:不得出现裸反引号与 ${。
 */
export const PANEL_JS_IDE_1 = `// ----  B/C:#view-ide 编辑器视图(树 + 多标签 + Monaco 编辑区 + 保存流) ----
// 文件树复用 #sbFt 的懒展开(dirCache + fs.list,filesPending 防重发),根=活动项目工作区;
// 文件点击发 file.read {path:相对路径, full:true} 开标签(binary/tooLarge/missing 守卫不建编辑模型)。
// C 部分:首次打开文本文件才动态注入 vs/loader.js(AMD)挂 Monaco,一文件一 model(monaco.Uri.file);
// 加载失败回退 textarea 保底;保存=file.write 全文覆盖写(Ctrl+S/按钮,回包清脏/失败保脏)。
let ideTabs = [];        // [{path,name,content,orig,dirty,saving,mode:"edit"|"ro"|"loading",roReason,model?,mdView?:"preview"|"source"(仅 md 标签,逐标签持有)}]
let ideActive = -1;      // 激活标签下标
let ideRoot = null;      // {pid,label,path} 活动项目根
let ideExpanded = null;  // Set<absPath> 展开目录
let ideMonaco = null;        // Monaco 就绪句柄 {editor,monaco};null=未就绪(加载中/失败回退 textarea)
let ideMonacoPending = null; // loader.js 动态注入 Promise(并发去重)
let ideMonacoFailed = false; // 加载失败标志(本会话不再重试;textarea 可用性保底)
let ideProgSet = false;      // 程序化 setValue 守卫(标签切换同步/保存回显不误标脏)
// IDE 图片预览扩展名白名单(与服务端 /ide/asset 路由同源口径;svg 经 <img> 展示不执行脚本)。
// 命中即不走 file.read(二进制嗅探必回 binary),改挂 #ideImg 层 <img> 直连 /ide/asset。
const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"]);
function ideIsImg(rel) {
  const nm = String(rel || "").split("/").pop() || "";
  const i = nm.lastIndexOf(".");
  if (i < 0 || i === nm.length - 1) return false;
  return IMG_EXT.has(nm.slice(i + 1).toLowerCase());
}
// Office 预览扩展名(与服务端 OFFICE_DOC_EXT 同源口径; 板 ide-o1/o2)。
// 命中即不走 file.read(zip 二进制必回 binary),改挂 #ideOffice 层,AST 由 /ide/office 现场解析。
const OFFICE_EXT = new Set(["pptx", "docx"]);
function ideIsOffice(rel) {
  const nm = String(rel || "").split("/").pop() || "";
  const i = nm.lastIndexOf(".");
  if (i < 0 || i === nm.length - 1) return false;
  return OFFICE_EXT.has(nm.slice(i + 1).toLowerCase());
}
/** office 标签的文档类型(pptx|docx;非 Office 返回空串)。 */
function ideOfficeKind(rel) {
  const nm = String(rel || "").split("/").pop() || "";
  const i = nm.lastIndexOf(".");
  if (i < 0 || i === nm.length - 1) return "";
  const ext = nm.slice(i + 1).toLowerCase();
  return OFFICE_EXT.has(ext) ? ext : "";
}
// 媒体层扩展名白名单(与服务端 ideAssetKind 同源口径; 媒体地基)。
// 命中即不走 file.read(二进制嗅探必回 binary、>2MB 必回 tooLarge,极小 mp3 首 8KB 无 NUL 还会被当文本塞 Monaco),
// 改挂 #ideMedia 层 <video>/<audio> 直连 /ide/asset(字节走 HTTP Range)。
const MEDIA_VID_EXT = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);
const MEDIA_AUD_EXT = new Set(["mp3", "wav", "m4a", "aac", "ogg", "oga", "flac", "opus"]);
function ideMediaKind(rel) {
  const nm = String(rel || "").split("/").pop() || "";
  const i = nm.lastIndexOf(".");
  if (i < 0 || i === nm.length - 1) return "";
  const ext = nm.slice(i + 1).toLowerCase();
  if (MEDIA_VID_EXT.has(ext)) return "video";
  if (MEDIA_AUD_EXT.has(ext)) return "audio";
  return "";
}
function ideNorm(p) { let s = String(p || ""); while (s.endsWith("/")) s = s.slice(0, -1); return s; }
/** (板 5a7bb5d2):HTML 文件判定(.html/.htm)——只有这类标签有「编辑|预览」双态。 */
function ideIsHtml(rel) {
  const nm = String(rel || "").split("/").pop() || "";
  const i = nm.lastIndexOf(".");
  if (i < 0 || i === nm.length - 1) return false;
  const ext = nm.slice(i + 1).toLowerCase();
  return ext === "html" || ext === "htm";
}
/** Markdown 文件判定(.md/.markdown);只有这类标签有「预览|源码」概念。 */
function ideIsMd(rel) {
  const ext = (String(rel || "").split(".").pop() || "").toLowerCase();
  return ext === "md" || ext === "markdown";
}
/** 头部「预览|源码」分段钮同步:仅 markdown 文本标签显示,并标亮该标签自己的 mdView。 */
function ideMdSegSync(t) {
  const seg = $("ideMdSeg");
  if (!seg) return;
  const on = !!(t && t.mode === "edit" && ideIsMd(t.path));
  seg.style.display = on ? "flex" : "none";
  if (!on) return;
  const v = t.mdView === "source" ? "source" : "preview";
  for (const b of seg.querySelectorAll("button")) b.classList.toggle("on", b.dataset.md === v);
}
/** IDE md 预览 io:相对路径按 md 文件目录折疓 ../. → /ide/asset?path=&pid=(项目根沙箱;
 * 越出项目根=拒绝渲染);http(s) 原样放行;视频扩展名产 <video controls>;相对 .md 链接产
 * data-ide-mdlink 由 #ideMdHost 事件委托 ideOpenFile 开新标签。仅 md 预览传此 io——聊天流
 * mdToHtml 默认通道零变(仍仅 /uploads? 图与 http 链接)。 */
function ideMdAssetUrl(raw, mdPath) {
 // 不再在客户端预折叠 ../(裸相对路径同目录图会被折成根相对 → 打到项目根,404)。
 // 现在原样带 path + from=<md 相对路径>,服务端 /ide/asset 按「from 目录 → 项目根 → 绝对(根内)」
 // 候选链解析;沙箱/越界判定也收到服务端(realpath + isPathInside),前端只做协议过滤。
  const r = String(raw || "");
  if (r.indexOf("http://") === 0 || r.indexOf("https://") === 0 || r.indexOf("//") === 0 || r.indexOf("data:") === 0) return null;
  const p = mdImgSrc(r);
  if (!p || p.charAt(0) === "#") return null;
  const from = String(mdPath || "").split(String.fromCharCode(92)).join("/");
  return "/ide/asset?path=" + encodeURIComponent(p) + "&from=" + encodeURIComponent(from) + "&pid=" + encodeURIComponent(ideRoot ? ideRoot.pid : "");
}
/** 相对 md 目录折叠 ../. 得到项目内相对路径(越出项目根=null);外链/锚点/内联返回 null。
 * 起**不再**用于图片 asset URL(那条已改 from= 服务端候选链);
 * 仍被 io.link 的项目内 .md 链接解析复用,故保留。 */
function ideMdRelPath(raw, mdPath) {
  const r = String(raw || "");
  if (r.indexOf("http://") === 0 || r.indexOf("https://") === 0 || r.indexOf("//") === 0 || r.indexOf("#") === 0 || r.indexOf("data:") === 0) return null;
  const base = String(mdPath || "").split("/"); base.pop(); // md 所在目录
  const parts = base.concat(r.split("?")[0].split("#")[0].split("/"));
  const st = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") { if (st.length) st.pop(); else return null; } // 越出项目根:拒绝
    else st.push(p);
  }
  return st.length ? st.join("/") : null;
}
function ideMdIo(t) {
  const VID = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);
  const ext = (s) => { const a = String(s || "").split("?")[0].split("/").pop() || ""; const i = a.lastIndexOf("."); return i >= 0 ? a.slice(i + 1).toLowerCase() : ""; };
  return {
    media: (srcRaw) => { if (!VID.has(ext(srcRaw))) return null; const u = ideMdAssetUrl(srcRaw, t.path); return u ? '<video class="md-video" controls preload="metadata" src="' + u + '"></video>' : null; },
    img: (srcRaw, alt) => {
      const r = String(srcRaw || "");
 // 不用 loading="lazy":预览态图片常在半屏以下,懒加载会让人以为"没渲染";单文档图片量小,直接取。
      if (r.indexOf("http://") === 0 || r.indexOf("https://") === 0) return '<img class="md-img" src="' + r + '" alt="' + alt + '">'; // 外链图原样(IDE 预览放开)
      if (r.indexOf("//") === 0 || r.indexOf("data:") === 0 || r.indexOf("#") === 0) return null; // 协议相对/内联/锚点:回退默认
      const u = ideMdAssetUrl(r, t.path);
      return u ? '<img class="md-img" src="' + u + '" alt="' + alt + '">' : null;
    },
link: (urlRaw, text, innerHtml) => {
      const u = String(urlRaw || "");
      const body = typeof innerHtml === "string" ? innerHtml : text; // 可点击图片:原样输出内层 <img>/<video>
      if (u.indexOf("#") === 0) return '<a href="' + u + '">' + body + "</a>"; // 页内锚点:默认 href
      if (u.indexOf("http://") === 0 || u.indexOf("https://") === 0 || u.indexOf("//") === 0 || u.indexOf("data:") === 0) return null; // 外链已被 http 分支接走;其余回退
      const rel = ideMdRelPath(u, t.path); // 按 md 所在目录解析(裸相对路径直接开标签会落到项目根=打不开)
      if (!rel) return null;
      return '<a href="javascript:void 0" class="md-link" data-ide-mdlink="' + esc(rel) + '">' + body + "</a>"; // 项目内相对链接:委托开新标签
    },
  };
}
/** 头部「编辑|预览」分段钮同步(板 5a7bb5d2):仅 html 编辑标签显示,并标亮该标签自己的 pvView。 */
function idePvSegSync(t) {
  const seg = $("idePvSeg");
  if (!seg) return;
  const on = !!(t && t.mode === "edit" && ideIsHtml(t.path));
  seg.style.display = on ? "flex" : "none";
  if (!on) return;
  const v = t.pvView === "preview" ? "preview" : "edit";
  for (const b of seg.querySelectorAll("button")) b.classList.toggle("on", b.dataset.pv === v);
}
function ideRel(abs) { return ideRoot && abs.startsWith(ideRoot.path + "/") ? abs.slice(ideRoot.path.length + 1) : abs; }
function ideAbsOf(rel) { if (!ideRoot) return String(rel || ""); return ideRoot.path + "/" + String(rel || "").replace(/^\\/+/, ""); }
/** 状态条主文本(旧语义:单文本写入; 起落到 #ideStMain 段,其余分段由 ideStatusSet 渲染)。 */
function ideStatus(t) {
  const el = $("ideStMain");
  if (el) el.textContent = t;
  else { const box = $("ideStatus"); if (box) box.textContent = t; }
  ideStatusSet();
}
function ideTabsRender() {
  const bar = $("ideTabs");
  bar.innerHTML = ideTabs.map((t, i) =>
    '<span class="ide-tab' + (i === ideActive ? " on" : "") + '" data-ide-tab="' + i + '" title="' + esc(t.path) + '">' +
    '<span class="tab-ic">' + fileIcon(t.path) + "</span>" +
    '<span class="dirty">' + (t.dirty ? "● " : "") + "</span>" + esc(t.name) + '<span class="x" data-ide-x="' + i + '" title="关闭">×</span></span>').join("");
  for (const el of bar.querySelectorAll(".ide-tab")) el.onclick = (e) => { if (e.target.closest("[data-ide-x]")) return; ideActivate(Number(el.dataset.ideTab)); };
  for (const el of bar.querySelectorAll("[data-ide-x]")) el.onclick = (e) => { e.stopPropagation(); ideClose(Number(el.dataset.ideX)); };
}
/** Monaco 语言映射(按扩展名;未列出的扩展名=纯文本,monaco 自身也能识别一部分,这里显式收敛)。 */
function ideLangOf(rel) {
  const ext = (rel.split(".").pop() || "").toLowerCase();
  const M = { ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", js: "javascript", mjs: "javascript",
    cjs: "javascript", jsx: "javascript", json: "json", jsonc: "json", md: "markdown", markdown: "markdown", css: "css",
    scss: "scss", less: "less", html: "html", htm: "html", xml: "xml", svg: "xml", py: "python", go: "go", rs: "rust",
    sh: "shell", bash: "shell", zsh: "shell", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", sql: "sql", java: "java",
    c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", rb: "ruby", php: "php", lua: "lua", pl: "perl", r: "r",
    swift: "swift", kt: "kotlin", txt: "plaintext", log: "plaintext" };
  return M[ext] || "plaintext";
}
/** Monaco 动态加载(首开文本文件才注入;失败置 ideMonacoFailed 回退 textarea 保底,状态条提示)。 */
function ideMonacoLoad() {
  if (ideMonaco) return Promise.resolve(ideMonaco);
  if (ideMonacoPending) return ideMonacoPending;
  if (ideMonacoFailed) return Promise.resolve(null);
  ideMonacoPending = new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "/assets/vendor/monaco/vs/loader.js";
    s.onload = () => {
      const req = window.require;
      if (!req || !req.config) { ideMonacoFailed = true; ideMonacoPending = null; resolve(null); return; }
      req.config({ paths: { vs: "/assets/vendor/monaco/vs" } });
      window.MonacoEnvironment = { // 同源 worker:必须用 blob: URL(data: URL 是不透明源,importScripts 解析不到面板静态路径)
        getWorkerUrl: function () {
 // MonacoEnvironment.baseUrl 需指到 vs 的父目录(worker 内部再拼 "vs/language/typescript/tsWorker.js")
          const vsDir = location.origin + "/assets/vendor/monaco/vs/";
          const base = location.origin + "/assets/vendor/monaco/";
          const src = "self.MonacoEnvironment={baseUrl:" + JSON.stringify(base) + "};" +
            "importScripts(" + JSON.stringify(vsDir + "base/worker/workerMain.js") + ");";
          return URL.createObjectURL(new Blob([src], { type: "application/javascript" }));
        },
      };
      req(["vs/editor/editor.main"], () => {
        const monaco = window.monaco;
        if (!monaco || !monaco.editor) { ideMonacoFailed = true; ideMonacoPending = null; resolve(null); return; }
        monaco.editor.defineTheme("genie", { // 面板同源暗色(bronze 色系)主题;light 模式面板回 'vs'
          base: "vs-dark", inherit: true,
          rules: [
            { token: "comment", foreground: "6b5c4a", fontStyle: "italic" },
            { token: "keyword", foreground: "c98f45" },
            { token: "string", foreground: "9dc48b" },
            { token: "number", foreground: "d9a05b" },
            { token: "type", foreground: "e0c089" },
          ],
          colors: {
            "editor.background": "#0d0a07",
            "editor.foreground": "#ece1d1",
            "editorLineNumber.foreground": "#6b5c4a",
            "editorLineNumber.activeForeground": "#c98f45",
            "editor.lineHighlightBackground": "#181008",
            "editorCursor.foreground": "#c98f45",
            "editor.selectionBackground": "#3a2a15",
            "editorIndentGuide.background1": "#241a10",
            "editorGutter.background": "#0d0a07",
          },
        });
 // 挂到骨架里预先存在的 #ideMonacoHost(不存在则新建并纳入骨架;避免每次渲染重建 DOM 摘掉 monaco 节点)
        ideBodySkeleton();
        const host = $("ideMonacoHost") || document.createElement("div");
        if (!host.id) { host.className = "ide-monaco"; host.id = "ideMonacoHost"; $("ideBody").appendChild(host); }
 // Monaco lineHeight 单位=px(不是倍数);20 ≈ 12.5 × --lh-code(1.6),与 .ide-edit 同比例
        const ed = monaco.editor.create(host, {
          value: "", language: "plaintext", theme: document.body.classList.contains("light") ? "vs" : "genie",
          fontFamily: getComputedStyle(document.body).getPropertyValue("--mono") || "ui-monospace, monospace",
          fontSize: 12.5, lineHeight: 20, letterSpacing: 0, tabSize: 4, readOnly: true, automaticLayout: true,
          minimap: { enabled: ideMinimapOn }, scrollBeyondLastLine: false, renderWhitespace: "selection",
 // 查找/替换:find widget 预填选区、多行选区范围内查找;wrap/minimap 受命令面板开关控制
          wordWrap: ideWordWrap ? "on" : "off",
          find: { seedSearchStringFromSelection: "always", autoFindInSelection: "multiline" },
          suggestOnTriggerCharacters: true, multiCursorModifier: "alt", formatOnPaste: false, tabCompletion: "off",
        });
 // 查找/替换快捷键:交给 Monaco 自己的 find widget(Ctrl+F 查找 / Ctrl+H 替换),
 // 面板 keydown 对本域不放行 Ctrl+F/Ctrl+H(见下方 IDE 域快捷键监听),避免旧 findBar 抢键。
        ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF, () => { const a = ed.getAction("actions.find"); if (a) a.run(); });
        ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyH, () => { const a = ed.getAction("editor.action.startFindReplaceAction"); if (a) a.run(); });
 // 光标/选区 → 状态条 Ln/Col + 已选字符数
        ed.onDidChangeCursorPosition((ev) => {
          if (!ev || !ev.position) return;
          ideCursor.line = ev.position.lineNumber;
          ideCursor.col = ev.position.column;
          const sel = ed.getSelection();
          const mdl = ed.getModel();
          ideCursor.sel = sel && mdl && !sel.isEmpty() ? mdl.getValueInRange(sel).length : 0;
          ideStatusSet();
        });
        ed.onDidChangeCursorSelection(() => {
          const sel = ed.getSelection();
          const mdl = ed.getModel();
          ideCursor.sel = sel && mdl && !sel.isEmpty() ? mdl.getValueInRange(sel).length : 0;
          ideStatusSet();
        });
        ed.onDidChangeModelContent(() => {
          if (ideProgSet) return; // 程序化换值(切标签同步/保存回显)不算编辑
          const cur = ideActive >= 0 && ideActive < ideTabs.length ? ideTabs[ideActive] : null;
          if (!cur || cur !== ed.getModel().__ideTab) return;
          cur.content = ed.getValue();
          if (!cur.dirty) { cur.dirty = true; ideTabsRender(); }
          ideSaveSync();
          ideStatus(cur.path + " ● 未保存");
        });
        ideMonaco = { editor: ed, monaco: monaco };
        try { window.__ideMonacoReady = true; window.__ideMonacoEditor = ed; } catch (e) { /* 测试钩子(仅 spec 用) */ }
        ideMonacoPending = null;
        resolve(ideMonaco);
      }, () => { ideMonacoFailed = true; ideMonacoPending = null; ideStatus("Monaco 加载失败,已回退纯文本编辑"); resolve(null); });
    };
    s.onerror = () => { ideMonacoFailed = true; ideMonacoPending = null; ideStatus("Monaco 加载失败(vs/loader.js 不可达),已回退纯文本编辑"); resolve(null); };
    document.head.appendChild(s);
  });
  return ideMonacoPending;
}
/** 编辑区骨架:只建一次(欢迎/只读/蒙纳哥挂载点/文本兜底/图片预览五层,display 切换)。
 * 反复 innerHTML 会摘除 Monaco 的 dom 节点再挂回,触发 appendChild(非 Node) 异常。 */
function ideBodySkeleton() {
  if ($("ideBody").querySelector("#ideEdit")) return;
  const box = $("ideBody");
  box.innerHTML =
    '<div class="ide-welcome" id="ideWelcome">从左侧选择文件打开<br><span style="font-size:11px">标签可多开;改动未保存关闭会确认</span></div>' +
    '<div class="ide-ro" id="ideRo" style="display:none"></div>' +
    '<div class="ide-monaco" id="ideMonacoHost" style="display:none"></div>' +
    '<div class="ide-md" id="ideMdHost" style="display:none"></div>' +
    '<div class="ide-monaco" id="ideDiffHost" style="display:none"></div>' +
    '<div class="ide-img" id="ideImg" style="display:none">' +
      '<div class="ide-img-scroll" id="ideImgScroll"><div class="ide-img-stage" id="ideImgStage"><img id="ideImgEl" alt="图片预览" draggable="false"></div></div>' +
      '<div class="ide-img-bar" id="ideImgBar">' +
        '<button class="ide-img-btn" data-ide-z="out" title="缩小(滚轮向下)">−</button>' +
        '<span class="ide-img-pct" id="ideImgPct" title="点击适应窗口">100%</span>' +
        '<button class="ide-img-btn" data-ide-z="in" title="放大(滚轮向上)">+</button>' +
        '<button class="ide-img-btn" data-ide-z="z50" title="50%">50%</button>' +
        '<button class="ide-img-btn" data-ide-z="z100" title="100%">100%</button>' +
        '<button class="ide-img-btn" data-ide-z="z200" title="200%">200%</button>' +
        '<button class="ide-img-btn" data-ide-z="one" title="原始大小 1:1(双击图片切换)">1:1</button>' +
        '<button class="ide-img-btn" data-ide-z="fit" title="适应窗口(双击图片切换)">适</button>' +
        '<button class="ide-img-btn" data-ide-z="vreset" title="复位 1:1 + 平移归零(任务B,与画布 HUD 同语义)">复位</button>' +
      '</div>' +
    '</div>' +
    '<div class="ide-media" id="ideMedia" style="display:none"></div>' +
    '<div class="ide-preview" id="idePreview" style="display:none"><iframe id="idePreviewFrame" title="HTML 预览" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe></div>' +
    '<div class="ide-office-wrap" id="ideOfficeWrap" style="display:none">' +
      '<div class="ide-office-bar" id="ideOfficeBar">' +
        '<button class="io-b" id="ideOfficeEditBtn" type="button" title="编辑文本(只改文字,不动版式/图片/格式)">' + "编辑文本" + '</button>' +
        '<button class="io-b" id="ideOfficeSaveBtn" type="button" title="保存文本改动(Ctrl+S)" style="display:none">保存</button>' +
        '<button class="io-b" id="ideOfficeCancelBtn" type="button" title="放弃本次文本改动" style="display:none">取消编辑</button>' +
        '<span class="io-hint" id="ideOfficeHint"></span>' +
      '</div>' +
      '<div class="ide-office" id="ideOffice"></div>' +
    '</div>' +
    '<textarea class="ide-edit" id="ideEdit" style="display:none" spellcheck="false" autocomplete="off" autocapitalize="off" wrap="off"></textarea>';
  $("ideEdit").addEventListener("input", () => {
    const cur = ideActive >= 0 && ideActive < ideTabs.length ? ideTabs[ideActive] : null;
    if (!cur || cur.mode !== "edit") return;
    cur.content = $("ideEdit").value;
    if (!cur.dirty) { cur.dirty = true; ideTabsRender(); }
    ideSaveSync();
    ideStatus(cur.path + " ● 未保存");
  });
  $("ideMdHost").addEventListener("click", (e) => { // :预览内项目相对链接(data-ide-mdlink)→开 IDE 标签;外链/锚点走默认行为
    const a = e.target && e.target.closest ? e.target.closest("[data-ide-mdlink]") : null;
    if (!a) return;
    e.preventDefault();
    ideOpenFile(a.getAttribute("data-ide-mdlink") || "");
  });
  ideOfficeWire(); // P2:office 工具条按钮(骨架内动态创建,只能在这里绑)
}
/** 只显一层(welcome/ro/monaco/md/diff/ta/img/media/office),其余隐藏。
 * office 显的是 wrap(工具条 + 预览层),#ideOffice 仍是渲染 host(U+工具条同进退)。 */
function ideBodyShow(which) {
  const m = { welcome: "ideWelcome", ro: "ideRo", monaco: "ideMonacoHost", md: "ideMdHost", diff: "ideDiffHost", ta: "ideEdit", img: "ideImg", media: "ideMedia", office: "ideOfficeWrap", preview: "idePreview" };
  for (const k in m) { const el = $(m[k]); if (el) el.style.display = k === which ? "" : "none"; }
  ideOfficeBarSync(which);
}
// ---- IDE 图片查看器:滚轮/按钮缩放、拖动平移、双击「适应↔1:1」(仅图片层;每标签记住缩放与滚动位置) ----
const IDE_IMG_MIN = 0.02, IDE_IMG_MAX = 16; // 2%–1600%
let ideImgWired = false;
function ideImgActive() {
  const t = ideActive >= 0 && ideActive < ideTabs.length ? ideTabs[ideActive] : null;
  const box = $("ideImg");
  return !!(t && t.mode === "img" && box && box.style.display !== "none");
}
function ideImgNat() {
  const el = $("ideImgEl");
  return el ? { w: el.naturalWidth || 0, h: el.naturalHeight || 0 } : { w: 0, h: 0 };
}
function ideImgSave(scale, fit) {
  const t = ideActive >= 0 && ideActive < ideTabs.length ? ideTabs[ideActive] : null;
  if (t && t.mode === "img") { t.imgScale = scale; t.imgFit = !!fit; }
}
/** 按比例落尺寸 + 百分比 + 可拖拽态;不读容器(fit/锚点缩放各自负责滚动位置)。 */
function ideImgPaint(scale, fit) {
  const el = $("ideImgEl"); if (!el) return;
  const n = ideImgNat(); if (!n.w || !n.h) return;
  const s = Math.min(IDE_IMG_MAX, Math.max(IDE_IMG_MIN, Number(scale) || 1));
  el.style.width = Math.max(1, Math.round(n.w * s)) + "px";
  el.style.height = Math.max(1, Math.round(n.h * s)) + "px";
  el.dataset.scale = String(s);
  const pct = $("ideImgPct"); if (pct) pct.textContent = Math.round(s * 100) + "%";
  const scroll = $("ideImgScroll"), wrap = $("ideImg");
  if (scroll && wrap) wrap.classList.toggle("zoomed", s * n.w > scroll.clientWidth - 31 || s * n.h > scroll.clientHeight - 31);
  ideImgSave(s, fit);
}
/** 适应窗口:不超过 100%(小图不放大),居中;容器不可见(宽高≈0)时跳过,避免切视图时把尺寸压成 1px。 */
function ideImgFitNow() {
  const scroll = $("ideImgScroll"), el = $("ideImgEl");
  if (!scroll || !el) return;
  if (scroll.clientWidth < 2 || scroll.clientHeight < 2) return;
  const n = ideImgNat(); if (!n.w || !n.h) return;
  const bw = Math.max(1, scroll.clientWidth - 32), bh = Math.max(1, scroll.clientHeight - 32);
  const s = Math.min(1, bw / n.w, bh / n.h);
  ideImgPaint(s, true);
  scroll.scrollLeft = Math.max(0, (scroll.scrollWidth - scroll.clientWidth) / 2);
  scroll.scrollTop = Math.max(0, (scroll.scrollHeight - scroll.clientHeight) / 2);
  const t = ideActive >= 0 && ideActive < ideTabs.length ? ideTabs[ideActive] : null;
  if (t && t.mode === "img") { t.imgSx = scroll.scrollLeft; t.imgSy = scroll.scrollTop; }
}
/** 屏幕 px / 布局 px:IDE 视图在画布世界里会被整体缩放(cvWorldShell transform),滚轮锚点/拖动/媒体时间轴点击都按该系数换算。 */
function ideScreenScaleOf(el) {
  if (!el || !el.offsetWidth) return 1;
  const w = el.getBoundingClientRect().width;
  return w > 0 ? w / el.offsetWidth : 1;
}
function ideImgScreenScale() {
  return ideScreenScaleOf($("ideImgEl"));
}
/** 以视口内某点(clientX/Y)为锚缩放:保持光标下的图片内容不动;不传锚点=只改尺寸。
 * 任务B:锚点数学改走 diagram-viewport 引擎(window.DiagramViewport.zoomAtPoint,
 * 资产缺席时 dvZoomAtPoint 就地兜底同式)——「光标下内容点屏幕位移=0」不变式与画布/图容器同一口径。
 * 引擎返回的落点只用于倍率守卫(next 值),滚动位置换算仍走本容器的 scroll 模型(k=画布缩放系数)。 */
function ideImgZoomTo(scale, clientX, clientY) {
  const scroll = $("ideImgScroll"), el = $("ideImgEl");
  if (!scroll || !el) return;
  const n = ideImgNat(); if (!n.w || !n.h) return;
  const cur = parseFloat(el.dataset.scale || "0") || (el.clientWidth / n.w) || 1;
  const lib = dvLib();
  const tIn = { scale: cur, translateX: scroll.scrollLeft, translateY: scroll.scrollTop };
  const tOut = (lib && lib.zoomAtPoint) ? lib.zoomAtPoint(tIn, { x: clientX, y: clientY }, Number(scale) || cur) : dvZoomAtPoint(tIn, { x: clientX, y: clientY }, Number(scale) || cur);
  const next = Math.min(IDE_IMG_MAX, Math.max(IDE_IMG_MIN, Number(tOut.scale) || cur));
  if (Math.abs(next - cur) < 0.0005) return;
  let px = null, py = null;
  if (clientX != null && clientY != null) {
    const r0 = el.getBoundingClientRect();
    px = clientX - r0.left; py = clientY - r0.top;
  }
  ideImgPaint(next, false);
  if (px != null) {
    const r1 = el.getBoundingClientRect();
    const k = ideImgScreenScale() || 1; // 屏幕位移 → 滚动位移(画布缩放时 k≠1)
    scroll.scrollLeft += ((r1.left + px * (next / cur)) - clientX) / k;
    scroll.scrollTop += ((r1.top + py * (next / cur)) - clientY) / k;
  }
  ideImgViewSave();
}
/** 任务B:IDE 图片查看器复位——1:1 + 平移归零(与画布 HUD 复位同语义);顺带存标签态。 */
function ideImgReset() {
  const scroll = $("ideImgScroll"), el = $("ideImgEl");
  if (!scroll || !el) return;
  ideImgPaint(1, false);
  scroll.scrollLeft = 0;
  scroll.scrollTop = 0;
  ideImgViewSave();
}
/** 滚动位置落标签(缩放/复位/拖拽共用出口;激活标签非图片层时静默)。 */
function ideImgViewSave() {
  const scroll = $("ideImgScroll");
  const t = ideActive >= 0 && ideActive < ideTabs.length ? ideTabs[ideActive] : null;
  if (t && t.mode === "img" && scroll) { t.imgSx = scroll.scrollLeft; t.imgSy = scroll.scrollTop; }
}
function ideImgWire() {
  if (ideImgWired) return;
  ideImgWired = true;
  const bar = $("ideImgBar"), scroll = $("ideImgScroll"), el = $("ideImgEl");
  if (bar) bar.addEventListener("click", (e) => {
    const b = e.target && e.target.closest ? e.target.closest("[data-ide-z]") : null;
    if (!b) return;
    const r = scroll ? scroll.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const cur = parseFloat((el && el.dataset.scale) || "1") || 1;
    if (b.dataset.ideZ === "in") ideImgZoomTo(cur * 1.25, cx, cy);
    else if (b.dataset.ideZ === "out") ideImgZoomTo(cur / 1.25, cx, cy);
    else if (b.dataset.ideZ === "z50") ideImgZoomTo(0.5, cx, cy); // 任务B:档位(50/100/200,视口中心锚)——与画布 HUD 同组语义
    else if (b.dataset.ideZ === "z100") ideImgZoomTo(1, cx, cy);
    else if (b.dataset.ideZ === "z200") ideImgZoomTo(2, cx, cy);
    else if (b.dataset.ideZ === "one") ideImgZoomTo(1, cx, cy);
    else if (b.dataset.ideZ === "vreset") ideImgReset(); // 任务B:复位=1:1 + 平移归零(与画布 zoomReset 同语义)
    else if (b.dataset.ideZ === "fit") ideImgFitNow();
  });
  const pct = $("ideImgPct");
  if (pct) pct.onclick = () => ideImgFitNow();
  if (scroll) {
    scroll.addEventListener("wheel", (e) => {
      if (!ideImgActive()) return;
      e.preventDefault();
      const cur = parseFloat((el && el.dataset.scale) || "1") || 1;
      const k = e.deltaMode === 1 ? 0.05 : 0.0015;
      ideImgZoomTo(cur * Math.exp(-e.deltaY * k), e.clientX, e.clientY);
    }, { passive: false });
    let drag = null;
    scroll.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || !ideImgActive()) return;
      if (e.target && e.target.closest && e.target.closest(".ide-img-bar")) return;
      if (!(scroll.scrollWidth > scroll.clientWidth + 1 || scroll.scrollHeight > scroll.clientHeight + 1)) return;
      drag = { x: e.clientX, y: e.clientY, sl: scroll.scrollLeft, st: scroll.scrollTop, k: ideImgScreenScale() || 1 };
      const w = $("ideImg"); if (w) w.classList.add("dragging");
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      const k = drag.k || 1; // 鼠标位移是屏幕 px,滚动是布局 px(画布缩放时换算)
      scroll.scrollLeft = drag.sl - (e.clientX - drag.x) / k;
      scroll.scrollTop = drag.st - (e.clientY - drag.y) / k;
    });
    window.addEventListener("mouseup", () => {
      if (!drag) return;
      drag = null;
      const w = $("ideImg"); if (w) w.classList.remove("dragging");
      const t = ideActive >= 0 && ideActive < ideTabs.length ? ideTabs[ideActive] : null;
      if (t && t.mode === "img") { t.imgSx = scroll.scrollLeft; t.imgSy = scroll.scrollTop; }
    });
    scroll.addEventListener("scroll", () => {
      const t = ideActive >= 0 && ideActive < ideTabs.length ? ideTabs[ideActive] : null;
      if (t && t.mode === "img") { t.imgSx = scroll.scrollLeft; t.imgSy = scroll.scrollTop; }
    }, { passive: true });
    if (typeof ResizeObserver !== "undefined") {
      try {
        new ResizeObserver(() => {
          const t = ideActive >= 0 && ideActive < ideTabs.length ? ideTabs[ideActive] : null;
          if (t && t.mode === "img" && t.imgFit && ideImgActive()) ideImgFitNow();
        }).observe(scroll);
      } catch (e) { /* 老内核无 ResizeObserver:不影响缩放按钮/滚轮 */ }
    }
  }
  if (el) el.addEventListener("dblclick", () => {
    const n = ideImgNat(); if (!n.w || !n.h || !scroll) return;
    const r = scroll.getBoundingClientRect();
    const cur = parseFloat(el.dataset.scale || "0") || 1;
    const bw = Math.max(1, scroll.clientWidth - 32), bh = Math.max(1, scroll.clientHeight - 32);
    const fit = Math.min(1, bw / n.w, bh / n.h);
    if (Math.abs(cur - fit) < 0.01) ideImgZoomTo(1, r.left + r.width / 2, r.top + r.height / 2);
    else ideImgFitNow();
  });
}
// ---- IDE 媒体层(第六层:<video>/<audio> 直连 /ide/asset(Range);音频附「频谱」canvas(assets/ide-spectrum.js) ----
function ideMediaActive() {
  const t = ideActive >= 0 && ideActive < ideTabs.length ? ideTabs[ideActive] : null;
  const box = $("ideMedia");
  return !!(t && t.mode === "media" && box && box.style.display !== "none");
}
function ideMediaEl() {
  const host = $("ideMedia");
  return host ? host.querySelector("video, audio") : null;
}
function ideMediaHint(txt) {
  const el = $("ideMediaHint");
  if (el) el.textContent = txt || "";
}
/** 停频谱(切标签/关标签/换媒体必调):IdeSpectrum.detach 停 rAF,顺带暂停隐藏层里的播放器(不让音频在后台响)。 */
function ideMediaDetach() {
  try { if (window.IdeSpectrum && window.IdeSpectrum.detach) window.IdeSpectrum.detach(); } catch (e) { /* 频谱件未加载/已卸载 */ }
  const host = $("ideMedia");
  if (!host) return;
  host.dataset.spec = "0";
  for (const m of host.querySelectorAll("video, audio")) { try { m.pause(); } catch (e) { /* 已移除 */ } }
  const cv = host.querySelector("canvas");
  if (cv) cv.style.display = "none";
  const btn = host.querySelector("[data-ide-spec]");
  if (btn) btn.classList.remove("on");
}
/** 释放 Office 层(切/关标签必调):IdeOffice.clear 清渲染 DOM 并解绑 ResizeObserver/keydown
 * (ide-office.js 的 bindCleanup 挂在 host 上,不 clear 就常驻 = 每次开文档漏一份监听)。
 * dataset.sig 保留:再激活同一文档时 office 分支用缓存 t.officeAst 立即重渲,不重复打 /ide/office。 */
function ideOfficeDetach() {
  const host = $("ideOffice");
  if (!host) return;
  const lib = window.IdeOffice;
  if (lib && typeof lib.clear === "function") { try { lib.clear(host); } catch (e) { /* 组件未加载/已卸载 */ } }
  for (const t of ideTabs) { t.officeEdit = false; t.officeSaving = false; } // 编辑态与保存中标记随层释放一并失效
}
/** 频谱开关:attach({canvas, media}) 交给 assets/ide-spectrum.js(离线 decodeAudioData+AnalyserNode);再点 detach。 */
function ideMediaSpecToggle(cv, m) {
  const host = $("ideMedia");
  if (!host || !cv || !m) return;
  if (host.dataset.spec === "1") { ideMediaDetach(); ideMediaHint("频谱已停"); return; }
  if (!(window.IdeSpectrum && window.IdeSpectrum.attach)) { ideMediaHint("频谱组件未加载(assets/ide-spectrum.js)"); return; }
  cv.style.display = "";
  host.dataset.spec = "1";
  const btn = host.querySelector("[data-ide-spec]");
  if (btn) btn.classList.add("on");
  try {
    const p = window.IdeSpectrum.attach({ canvas: cv, media: m });
    ideMediaHint("点画布定位时间轴");
    if (p && typeof p.catch === "function") {
      p.catch(() => { host.dataset.spec = "0"; cv.style.display = "none"; ideMediaHint("该格式无法解码"); });
    }
    if (p && typeof p.then === "function") {
      p.then((r) => { if (r && r.ok === false) ideMediaHint("频谱降级:" + (r.reason || "不可用") + "(仍可播放)"); }).catch(() => { /* 已在上面兜住 */ });
    }
  } catch (e) { host.dataset.spec = "0"; cv.style.display = "none"; ideMediaHint("该格式无法解码"); }
}
/** 画布点击/拖动定位:屏幕 px → 布局 px(ideScreenScaleOf = 画布世界缩放系数)→ 比例 → currentTime。
 * 只认 #ideMedia 里的 canvas;▸video / ▸audio 原生控件(含滚轮/音量)一概不拦不 preventDefault。 */
function ideMediaSeekTo(e, cvOpt) {
  const cv = cvOpt || (e.target && e.target.closest ? e.target.closest("canvas") : null);
  if (!cv) return false;
  const m = ideMediaEl();
  if (!m) return false;
  const r = cv.getBoundingClientRect();
  const k = ideScreenScaleOf(cv) || 1; // 屏幕 px / 布局 px(与图片层同一换算)
  const w = cv.offsetWidth || (r.width / k) || 0;
  if (!w || !r.width) return false;
  const frac = Math.min(1, Math.max(0, ((e.clientX - r.left) / k) / w));
  const dur = Number(m.duration);
  if (!isFinite(dur) || dur <= 0) { ideMediaHint("时长未知(先播一次再点)"); return false; }
  try { m.currentTime = frac * dur; } catch (err) { return false; }
  ideMediaHint("定位 " + (Math.round(frac * dur * 10) / 10) + "s / " + (Math.round(dur * 10) / 10) + "s(" + Math.round(frac * 1000) / 10 + "%)");
  return true;
}
let ideMediaWired = false;
function ideMediaWire() {
  if (ideMediaWired) return;
  ideMediaWired = true;
  const host = $("ideMedia");
  if (!host) return;
  let scrubCv = null;
  host.addEventListener("click", (e) => {
    if (!ideMediaActive()) return;
    const btn = e.target && e.target.closest ? e.target.closest("[data-ide-spec]") : null;
    if (btn) { ideMediaSpecToggle(host.querySelector("canvas"), ideMediaEl()); return; }
    if (ideMediaSeekTo(e)) e.preventDefault();
  });
 // 频谱 canvas 上按住拖动 = 连续定位(scrubbing);指针移出 canvas 仍按起始画布换算
  host.addEventListener("mousedown", (e) => {
    if (!ideMediaActive() || e.button !== 0) return;
    const cv = e.target && e.target.closest ? e.target.closest("canvas") : null;
    if (!cv) return;
    scrubCv = cv;
    e.preventDefault();
    ideMediaSeekTo(e, cv);
  });
  window.addEventListener("mousemove", (e) => { if (scrubCv) ideMediaSeekTo(e, scrubCv); });
  window.addEventListener("mouseup", () => { scrubCv = null; });
 // 滚轮只在频谱 canvas 上响应(±1s 微调);<video>/<audio> 原生控件区一概不拦(不 preventDefault、不改音量/进度)
  host.addEventListener("wheel", (e) => {
    if (!ideMediaActive()) return;
    const cv = e.target && e.target.closest ? e.target.closest("canvas") : null;
    if (!cv) return; // 不在 canvas 上:完全交还给原生控件/页面滚动
    const m = ideMediaEl();
    if (!m || !isFinite(Number(m.duration)) || Number(m.duration) <= 0) return;
    e.preventDefault();
    const step = e.deltaY > 0 ? 1 : -1; // 向下=后退,向上=前进(各 1 秒)
    try { m.currentTime = Math.min(Number(m.duration), Math.max(0, Number(m.currentTime || 0) + step)); } catch (err) { return; }
  }, { passive: false });
}
/** 编辑区渲染:Monaco 可用→model 切换(一文件一 model,Uri.file(项目内相对路径)防串号);
 * 加载中/失败→textarea 保底(B 部分语义)。binary/tooLarge/missing 只读提示不建模型(B 语义不动)。 */
function ideBodyRender() {
  ideBodySkeleton();
  const t = ideActive >= 0 && ideActive < ideTabs.length ? ideTabs[ideActive] : null;
  ideMdSegSync(t);
  idePvSegSync(t);
  if (!t || t.mode !== "media") ideMediaDetach(); // 切走媒体层:停频谱 rAF + 暂停隐藏播放器(不空转、不在后台出声)
  if (!t) { ideBodyShow("welcome"); ideSaveSync(); return; }
  if (t.mode === "loading") { $("ideRo").innerHTML = ic("clock") + " 读取中…"; ideBodyShow("ro"); ideSaveSync(); return; }
  if (t.mode === "ro") {
    $("ideRo").innerHTML = ic("warn") + " " + esc(t.roReason) + "<br><span style='font-size:11px'>只读,不进编辑器</span>";
    ideBodyShow("ro"); ideStatus(t.path + " · 只读"); ideSaveSync(); return;
  }
  if (t.mode === "img") { // 图片预览:<img> 直连 /ide/asset(项目根沙箱);缩放/平移由 ideImg* 查看器负责
    const el = $("ideImgEl");
    ideBodyShow("img"); // 先显层:fit 需要真实容器宽高(隐藏层 clientWidth=0)
    if (el) {
      ideImgWire();
      const q = "/ide/asset?path=" + encodeURIComponent(t.path) + (ideRoot ? "&pid=" + encodeURIComponent(ideRoot.pid) : "");
      const changed = el.getAttribute("data-src") !== q;
      if (changed) { // 换图:清缩放,等真图解码后 fit
        el.setAttribute("data-src", q);
        el.dataset.path = t.path;
        el.dataset.scale = "0";
        el.style.width = ""; el.style.height = "";
        const pct = $("ideImgPct"); if (pct) pct.textContent = "…";
        el.src = q;
      }
      el.onload = () => {
        const cur = ideActive >= 0 && ideActive < ideTabs.length ? ideTabs[ideActive] : null;
        if (!cur || cur.mode !== "img" || cur.path !== el.dataset.path) return; // 快速切标签时旧图加载回调不串台
        if (cur.imgScale > 0 && !cur.imgFit) {
          ideImgPaint(cur.imgScale, false);
          const sc = $("ideImgScroll");
          if (sc) { sc.scrollLeft = cur.imgSx || 0; sc.scrollTop = cur.imgSy || 0; }
        } else ideImgFitNow();
      };
      el.onerror = () => { t.mode = "ro"; t.roReason = "图片不可读(不存在/越界/过大)"; ideBodyRender(); };
      if (!changed && el.complete && el.naturalWidth) { // 同图再激活:恢复该标签记住的缩放/滚动位置
        if (t.imgScale > 0 && !t.imgFit) {
          ideImgPaint(t.imgScale, false);
          const sc = $("ideImgScroll");
          if (sc) { sc.scrollLeft = t.imgSx || 0; sc.scrollTop = t.imgSy || 0; }
        } else ideImgFitNow();
      }
    }
    ideStatus(t.path + " · 图片预览"); ideSaveSync(); return;
  }
  if (t.mode === "media") { // 媒体层:<video>/<audio> 直连 /ide/asset(Range 拖进度条);音频附频谱 canvas
    const host = $("ideMedia");
    ideBodyShow("media");
    if (host) {
      ideMediaWire();
      const q = "/ide/asset?path=" + encodeURIComponent(t.path) + (ideRoot ? "&pid=" + encodeURIComponent(ideRoot.pid) : "");
      const sig = (t.mediaKind === "video" ? "video" : "audio") + "|" + q;
      if (host.dataset.sig !== sig) { // 换媒体才重建元素:同一标签再激活(改主题/切回来)不打断播放进度
        ideMediaDetach();
        host.dataset.sig = sig;
        const src = ' src="' + esc(q) + '"';
        host.innerHTML = t.mediaKind === "audio"
          ? '<div class="ide-media-audio"><audio controls preload="metadata"' + src + '></audio>' +
            '<div class="ide-media-bar"><button class="ide-img-btn" data-ide-spec="1" title="频谱(离线分析;长音频自动降级为仅播放)">频谱</button><span class="ide-media-hint" id="ideMediaHint"></span></div>' +
            '<canvas class="ide-media-spec" id="ideMediaSpec" width="1200" height="140" style="display:none"></canvas></div>'
          : '<video controls preload="metadata"' + src + '></video>';
        const m0 = host.querySelector("video, audio");
        if (m0) m0.onerror = () => { ideMediaHint("浏览器不支持该容器/编码(如 mkv/hevc)"); };
      }
    }
    ideStatus(t.path + " · " + (t.mediaKind === "audio" ? "音频" : "视频") + " · /ide/asset");
    ideSaveSync();
    return;
  }
  if (t.mode === "office") { // Office 预览(板 ide-o1/o2):AST 由 /ide/office 现场解析,渲染交 assets/ide-office.js
    const host = $("ideOffice");
    ideBodyShow("office");
    if (host) {
      const q = "/ide/office?path=" + encodeURIComponent(t.path) + (ideRoot ? "&pid=" + encodeURIComponent(ideRoot.pid) : "");
 // 切回同一文档:ideOfficeDetach 已 clear 掉 DOM 与监听,但 AST 还在(t.officeAst)——直接从缓存重渲,
 // 不重打 /ide/office(128MB 级文档的解析代价不该为一次标签切换再付一遍)。
      if (host.dataset.sig === q && !host.firstChild && t.officeAst && window.IdeOffice && typeof window.IdeOffice.render === "function") {
        try { window.IdeOffice.render({ host: host, ast: t.officeAst, docPath: t.path, pid: ideRoot ? ideRoot.pid : "" }); ideSaveSync(); return; }
        catch (e) { /* 重渲失败走下面完整取数路径 */ }
      }
      if (host.dataset.sig !== q) { // 换文档才重取(同标签再激活不重解析,省一次大文件读盘)
        host.dataset.sig = q;
        host.innerHTML = "";
        t.officeEdit = false; t.officeSaving = false; t.officeAst = null; // 换文档:编辑态与缓存的 AST 一并失效
        if (host.dataset) host.dataset.ioEdit = "0"; // 取消 ide-office 的编辑标记(新文档不带 contenteditable)
        const fail = (msg) => {
          const cur0 = ideActive >= 0 && ideActive < ideTabs.length ? ideTabs[ideActive] : null;
          if (!cur0 || cur0.mode !== "office" || cur0.path !== t.path) return; // 快速切标签:过期失败不落层
          host.innerHTML = '<div class="ide-office-hint">' + ic("warn") + " " + esc(msg) + "</div>";
          ideStatus(t.path + " · " + msg);
        };
        const lib = window.IdeOffice;
        if (!lib || typeof lib.render !== "function") { fail("预览组件未加载(assets/ide-office.js)"); ideSaveSync(); return; }
        ideStatus(t.path + " · 解析中…");
        fetch(q)
          .then((rsp) => rsp.ok ? rsp.json() : rsp.text().then((tx) => { throw new Error(String(tx || ("HTTP " + rsp.status)).slice(0, 160)); }))
          .then((ast) => {
            const cur1 = ideActive >= 0 && ideActive < ideTabs.length ? ideTabs[ideActive] : null;
            if (!cur1 || cur1.mode !== "office" || cur1.path !== t.path) return; // 快速切标签:过期响应不落层
            host.innerHTML = "";
            let done = null;
            try { done = lib.render({ host: host, ast: ast, docPath: t.path, pid: ideRoot ? ideRoot.pid : "" }); }
            catch (e) { done = { ok: false, reason: String((e && e.message) || e) }; }
            if (!done || done.ok === false) { fail("渲染失败:" + String((done && done.reason) || "未知原因")); return; }
            t.officeAst = ast; // 取消编辑要重渲,缓存住 AST(不为此再打一次 /ide/office)
            ideStatus(t.path + " · " + (ast && ast.kind === "pptx" ? "PPTX" : "DOCX") + " 预览" + (done.count ? " · " + done.count + (ast && ast.kind === "pptx" ? " 页" : " 块") : ""));
          })
          .catch((e) => { fail("解析失败:" + String((e && e.message) || e)); });
      }
    }
    ideSaveSync();
    return;
  }
  if (t.mode === "diff") { ideDiffRender(); ideSaveSync(); return; } // diff 标签:双栏 DiffEditor(不可用回退 +/-着色)
 // (板 5a7bb5d2)HTML 预览态:mode 仍是 "edit"(保存链照旧取 t.content,Ctrl+S 可用),
 // Monaco 层换 iframe 直连 /ide/preview/<pid>/<rel>(pid 在路径段=子资源相对引用天然带回项目沙箱)。
  if (ideIsHtml(t.path) && t.pvView === "preview") { idePreviewRender(); return; }
 // markdown 预览:mode 仍是 "edit"(保存链 ideSaveNow 照旧按 t.mode==="edit" 取 t.content,预览态 Ctrl+S 不受影响),
 // 只把 Monaco 层 display:none(模型不 dispose、不 setValue),渲染进 #ideMdHost;切回源码由下面 monaco 分支 setModel 恢复。
  if (ideIsMd(t.path) && t.mdView !== "source") {
    const host = $("ideMdHost");
    if (host) {
      if (t.model && t.dirty) { try { t.content = t.model.getValue(); } catch (e) { /* 模型已释放:沿用 t.content */ } } // 源码刚改过→取模型现值,预览不吃旧内容
      host.innerHTML = mdToHtml(t.content, "", ideMdIo(t)); // q=""=不做搜索命中高亮(聊天侧用法;预览无命中词);io=相对图/视频/链接重写
      mmRenderIn(host); // mermaid 围栏懒加载出图(与消息流 :8876 / wiki :25598 同语义;漏调=占位卡永久卡「渲染中…」)
      artRenderIn(host); // html/svg 图卡挂载(同一钩子位置)
    }
    ideBodyShow("md");
    ideStatus(t.path + (t.dirty ? " ● 未保存" : "") + " · Markdown 预览 · " + String(t.content).length + " 字符");
    ideSaveSync();
    return;
  }
  if (ideMonaco) {
    const M = ideMonaco;
    let mdl = t.model;
    if (!mdl) {
      const uri = M.monaco.Uri.file((ideRoot ? "/" + ideRoot.pid : "") + "/" + t.path); // 项目内路径唯一键(根换不重开标签=内容不变,复用)
      mdl = M.monaco.editor.getModel(uri) || M.monaco.editor.createModel(t.content, ideLangOf(t.path), uri);
      mdl.__ideTab = t;
      t.model = mdl;
      t.orig = t.content;
    } else if (!t.dirty && mdl.getValue() !== t.content) { ideProgSet = true; try { mdl.setValue(t.content); } finally { ideProgSet = false; } } // 回退期在 textarea 改过又切回(未脏=外部重读;程序化不算编辑)
    if (M.editor.getModel() !== mdl) M.editor.setModel(mdl);
    M.editor.updateOptions({ readOnly: false, wordWrap: ideWordWrap ? "on" : "off", minimap: { enabled: ideMinimapOn } });
    ideBodyShow("monaco");
    try { M.editor.layout(); } catch (e) { /* 尺寸未定;automaticLayout 兜底 */ }
    ideRevealLine(t); // 搜索结果点击:revealLineInCenter + 选中整行 + 高亮
    ideStatus(t.path + (t.dirty ? " ● 未保存" : "") + " · " + String(t.content).length + " 字符 · " + ideLangOf(t.path));
    ideSaveSync();
    return;
  }
  $("ideEdit").value = t.content; // 标签切换=换绑内容;textarea 换值不触发 input(dirty 不误标)
  $("ideEdit").readOnly = false;
  ideBodyShow("ta");
  ideStatus(t.path + (t.dirty ? " ● 未保存" : "") + " · " + String(t.content).length + " 字符" + (ideMonacoFailed ? " · Monaco 未加载,纯文本模式" : ""));
  ideSaveSync();
}
function ideActivate(i) {
  if (i < 0 || i >= ideTabs.length) return;
  if (i === ideActive) return;
 // Office 编辑态切走会丢弃未保存文本(ideOfficeDetach 清 DOM,切回按缓存 AST 重渲=改动没了)——与 ideClose 同口径先确认
  const cur = ideActive >= 0 && ideActive < ideTabs.length ? ideTabs[ideActive] : null;
  if (cur && cur.mode === "office" && cur.officeEdit && cur.dirty && !window.confirm("「" + cur.name + "」有未保存的文本修改,切换标签将丢弃。确认切换?")) return;
  ideMediaDetach(); // 切标签先停频谱/暂停媒体(ideBodyRender 也会兜一次;这里覆盖同层重入)
  ideOfficeDetach(); // 切标签释放 Office 层(clear 解绑 ResizeObserver/keydown,不释放会每次开文档漏一份监听)
  ideActive = i;
  ideTabsRender();
  ideBodyRender();
}
/** 关标签:脏标签 confirm 后丢弃;关的是激活标签 → 激活相邻(优先右/尾);全关回欢迎页。 */
function ideClose(i) {
  const t = ideTabs[i];
  if (!t) return;
  if (t.dirty && !window.confirm("「" + t.name + "」有未保存的修改,关闭将丢弃。确认关闭?")) return;
  if (t.model && ideMonaco) { try { ideMonaco.monaco.editor.setModelMarkers(t.model, "ide", []); } catch (e) { /* 清标记失败不影响关闭 */ } } // 先清 Monaco 标记再释放模型
  if (ideDiffEditor && (t.diffOrigModel || t.diffModModel)) { try { ideDiffEditor.setModel(null); } catch (e) { /* 已隐藏 */ } } // diff 编辑器脱离已释放模型
  if (t.model && ideMonaco) { try { if (ideMonaco.editor.getModel() === t.model) ideMonaco.editor.setModel(null); t.model.dispose(); } catch (e) { /* 模型已释放 */ } t.model = null; }
  if (t.diffOrigModel) { try { t.diffOrigModel.dispose(); } catch (e) { /* 已释放 */ } t.diffOrigModel = null; } // diff 双模型一并释放
  if (t.diffModModel) { try { t.diffModModel.dispose(); } catch (e) { /* 已释放 */ } t.diffModModel = null; }
  if (t.mode === "edit" && ideProbAll[t.path]) { ideProbAll[t.path] = []; ideProbRender(); } // 关标签清问题面板
  if (t.mode === "media" && ideTabs[ideActive] === t) ideMediaDetach(); // 关媒体标签:停频谱 rAF + 释放播放器(不空转)
  if (t.mode === "office" && ideTabs[ideActive] === t) ideOfficeDetach(); // 关 Office 标签:clear 解绑 ResizeObserver/keydown 并清渲染 DOM
  ideTabs.splice(i, 1);
  if (ideActive >= ideTabs.length) ideActive = ideTabs.length - 1;
  else if (i < ideActive) ideActive = ideActive - 1;
  ideTabsRender();
  ideBodyRender();
  ideStatus(ideTabs.length ? "关闭 " + t.path : "标签已清空");
}
function ideOpenFile(rel, opts2) {
  const hit = ideTabs.findIndex((t) => t.path === rel);
  if (hit >= 0) { // 去重:重复打开=复用标签并激活;带 line 时定位到该行(搜索结果点击)
    ideActivate(hit);
    if (opts2 && opts2.line) { const t0 = ideTabs[hit]; t0.revealLine = Number(opts2.line); if (ideTabs[ideActive] === t0) ideRevealLine(t0); }
    ideStatusSet(); // 复用点击也刷分段(ideActivate 同标签早退时,面包屑/状态栏不滞留旧标签内容)
    return;
  }
  const nm = rel.split("/").pop() || rel;
  const mk = ideMediaKind(rel);
  if (mk) { // 媒体:file.read 必回 binary/tooLarge(极小 mp3 首 8KB 无 NUL 还会被当文本塞 Monaco),
 // 一律不发 —— 直接建 media 标签,字节由 #ideMedia 里 <video>/<audio> 走 /ide/asset HTTP(Range)取。
    ideTabs.push({ path: rel, name: nm, content: "", orig: "", dirty: false, saving: false, mode: "media", mediaKind: mk, roReason: "" });
    ideActivate(ideTabs.length - 1);
    ideStatus(rel + (mk === "audio" ? " · 音频" : " · 视频"));
    return;
  }
  if (ideIsImg(rel)) { // 图片:二进制嗅探必拦,不走 file.read——直接挂 #ideImg 预览层(字节经 /ide/asset HTTP 取)
    ideTabs.push({ path: rel, name: nm, content: "", orig: "", dirty: false, saving: false, mode: "img", roReason: "", imgScale: 0, imgFit: true, imgSx: 0, imgSy: 0 });
    ideActivate(ideTabs.length - 1);
    ideStatus(rel + " · 图片预览");
    return;
  }
  if (ideIsOffice(rel)) { // Office:pptx/docx 是 zip 二进制,file.read 必回 binary——不发,建 office 标签,
 // AST 由 /ide/office 现场解析后交 assets/ide-office.js 渲染(window.IdeOffice 缺失→层内降级文案)。
    const ok = ideOfficeKind(rel);
    ideTabs.push({ path: rel, name: nm, content: "", orig: "", dirty: false, saving: false, mode: "office", officeKind: ok, roReason: "", officeEdit: false, officeSaving: false, officeAst: null });
    ideActivate(ideTabs.length - 1);
    ideStatus(rel + (ok === "pptx" ? " · PPTX 预览" : " · DOCX 预览"));
    return;
  }
  ideTabs.push({ path: rel, name: nm, content: "", orig: "", dirty: false, saving: false, mode: "loading", roReason: "", mdView: ideIsMd(rel) ? "preview" : "", pvView: ideIsHtml(rel) ? "edit" : "", revealLine: opts2 && opts2.line ? Number(opts2.line) : 0 });
  ideActivate(ideTabs.length - 1);
  ideMonacoLoad().then(() => { const t2 = ideTabs.find((x) => x.path === rel); if (t2 && ideTabs[ideActive] === t2 && t2.mode === "edit") ideBodyRender(); }); // 就绪(挂 Monaco)或失败(落 textarea)都重渲一次
  ideStatus("读取 " + rel);
  wsSafeSend(JSON.stringify({ v: 1, type: "file.read", path: rel, full: true, ...(ideRoot && ideRoot.pid ? { projectId: ideRoot.pid } : {}) }));
}
/** file.read.result(full)回填:按 path 匹配 loading 标签;binary/tooLarge/missing → 只读提示不建编辑模型。 */
function ideRenderRead(m) {
  const rel = String(m.path || "");
  const t = ideTabs.find((x) => x.path === rel && x.mode === "loading");
  if (!t) {
    const dwait = ideTabs.find((x) => x.path === rel && x.mode === "diff" && x.diffData && x.diffData.mod == null); // diff 标签等磁盘内容(file.read 管道复用)
    if (dwait && typeof m.content === "string" && !m.binary && !m.missing) { dwait.diffData.mod = m.content; if (ideActiveTab() === dwait) ideDiffRender(); }
    return false;
  }
  if (m.binary) { t.mode = "ro"; t.roReason = "二进制文件"; }
  else if (m.tooLarge) { t.mode = "ro"; t.roReason = "文件过大(>2MB)"; }
  else if (m.missing) { t.mode = "ro"; t.roReason = "文件不可读(不存在/越界)"; }
  else { t.mode = "edit"; t.content = String(m.content ?? ""); t.orig = t.content; t.dirty = false; t.saving = false; ideDiagRequest([t.path]); ideOutlineScan(); } // 打开 TS 文件即请求诊断 + 扫大纲
  if (ideTabs[ideActive] === t) ideBodyRender();
  else if (t.mode === "ro") { const i = ideTabs.indexOf(t); if (i >= 0) ideActivate(i); }
  return true;
}
function ideTreeRender() {
  const tree = $("ideTree");
  if (!ideRoot) { tree.innerHTML = '<div class="cc-empty">无活动项目<br><span style="font-size:11px">在侧栏点项目桶头「IDE」或先激活一个项目</span></div>'; return; }
  const rows = [];
  const walk = (abs, depth) => {
    const entries = dirCache.get(abs);
    if (!entries) {
      rows.push('<div class="ft-row" style="padding-left:' + (10 + depth * 14) + 'px"><span class="chev">…</span><span class="ic"></span><span class="nm">加载中</span></div>');
      if (!filesPending.has(abs)) { filesPending.add(abs); wsSafeSend(JSON.stringify({ v: 1, type: "fs.list", path: abs, showHidden: true })); }
      return;
    }
    const indent = "padding-left:" + (10 + depth * 14) + "px";
    for (const en of entries) {
      const childAbs = abs + "/" + en.name;
      if (en.kind === "dir") {
        const open = ideExpanded.has(childAbs);
        rows.push('<div class="ft-row dir" data-abs="' + esc(childAbs) + '" style="' + indent + '"><span class="chev">' + (open ? ic("chev-down") : ic("chev-right")) + '</span><span class="ic">' + ic("folder") + '</span><span class="nm">' + esc(en.name) + "</span></div>");
        if (open) walk(childAbs, depth + 1);
      } else {
        const openRel = ideRel(childAbs);
        const on = ideTabs.some((t) => t.path === openRel);
        const badge = ideScmChanged.has(openRel) ? '<span class="ft-badge">' + esc(ideScmLetter(openRel)) + "</span>" : ""; // SCM 状态角标(M/U/D)
        rows.push('<div class="ft-row file' + (on ? " sel" : "") + '" data-abs="' + esc(childAbs) + '" data-rel="' + esc(openRel) + '" style="' + indent + '"><span class="chev"></span><span class="ic">' + fileIcon(en.name) + '</span><span class="nm">' + esc(en.name) + "</span>" + badge + "</div>");
      }
    }
  };
  walk(ideRoot.path, 0);
  tree.innerHTML = rows.join("") || '<div class="cc-empty">(空目录)</div>';
  for (const el of tree.querySelectorAll(".ft-row.dir")) {
    el.onclick = () => { const a = el.dataset.abs; if (ideExpanded.has(a)) ideExpanded.delete(a); else ideExpanded.add(a); ideTreeRender(); };
 // 右键:目录=新建文件/新建文件夹/重命名/删除/刷新此目录
    el.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); ideRowMenu(el.dataset.abs, ideRel(el.dataset.abs), true, e.clientX, e.clientY); };
  }
  for (const el of tree.querySelectorAll(".ft-row.file")) {
    el.onclick = () => ideOpenFile(el.dataset.rel);
 // 右键:文件=打开/重命名/删除/复制路径
    el.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); ideRowMenu(el.dataset.abs, el.dataset.rel, false, e.clientX, e.clientY); };
  }
}
/** 树根解析:activeProject 注册表优先,缺省 harness 兜底(file.read/fs.list 沙箱=服务端活动项目根)。 */
function ideRootOf(preferPid) {
  const pid = (preferPid && projectById(preferPid)) ? preferPid : (activeProjectId && projectById(activeProjectId) ? activeProjectId : "__harness__");
  const p = projectById(pid);
  if (p && p.path) return { pid: pid, label: p.label || pid, path: ideNorm(p.path) };
  return null;
}
/** 打开 IDE 视图:切换/聚焦(画布=showCard+focus,经典=switchView)+ 立树。
 * preferPid:桶头点击时 project.activate 尚未回包,显式指定目标项目(否则树根落到旧 activeProject)。 */
function ideOpen(preferPid) {
  switchView("ide");
  ideLoad(preferPid);
  ideScmRefresh(); // 进 IDE 即拉 SCM(改动列表+树角标)
}
/** 树初始化/重载:树根变化换 Set;同根保留展开态(刷新按钮显式清)。 */
function ideLoad(preferPid, overrideRoot) {
  const r = overrideRoot || ideRootOf(preferPid);
  if (!r) { ideRoot = null; ideExpanded = null; $("ideTreeTitle").textContent = "资源管理器"; ideTreeRender(); ideStatus("无活动项目"); return; }
  const changed = !ideRoot || ideRoot.path !== r.path;
  ideRoot = r;
  if (changed || !ideExpanded) { ideExpanded = new Set([r.path]); dirCache.delete(r.path); filesPending.delete(r.path); }
  $("ideTreeTitle").textContent = r.label;
  ideTreeRender();
}
$("ideRefresh").onclick = () => { if (ideRoot) { invalidateTreeCache(ideRoot.path); ideScmRefresh(); ideTreeRender(); } };
/** 保存按钮态同步:仅激活标签 dirty 且未在保存中可用;保存中置 loading 防重复发。 */
function ideSaveSync() {
  const b = $("ideSave");
  if (!b) return;
  const t = ideActive >= 0 && ideActive < ideTabs.length ? ideTabs[ideActive] : null;
  b.disabled = !(t && t.mode === "edit" && t.dirty && !t.saving); // 保存中置灰(loading 态防重复发)
  b.textContent = t && t.saving ? "保存中…" : "保存";
}
/** 保存:file.write 全文覆盖写(首版无锁/无冲突检测,协议拍板);发出置 saving 防重复,回包清/保脏。 */
function ideSaveNow() {
  const t = ideActive >= 0 && ideActive < ideTabs.length ? ideTabs[ideActive] : null;
  if (t && t.mode === "office") { // Office 编辑态:Ctrl+S 走文本回写(不误触发文本标签的 file.write 保存链)
    if (!t.officeEdit) return;
    ideOfficeSaveNow();
    return;
  }
  if (!t || t.mode !== "edit" || !t.dirty || t.saving) return;
  t.saving = true;
  ideSaveSync();
  ideStatus("保存 " + t.path + "…");
 // ideRoot 无 pid(异常态)时用活动项目兜底——远程项目保存绝不能回落本地路径
  const pid0 = (ideRoot && ideRoot.pid) || activeProjectId;
  wsSafeSend(JSON.stringify({ v: 1, type: "file.write", path: t.path, content: t.content, ...(pid0 ? { projectId: pid0 } : {}) }));
}
/** file.write.result 回包:ok→清脏+toast bytes;error→toast 报 reason 脏保留(server 拒绝走 error 帧兜底同款)。 */
function ideSaveResult(m) {
  const rel = String(m.path || "");
  const t = ideTabs.find((x) => x.path === rel && x.saving);
  if (!t) return;
  t.saving = false;
  if (m.ok) {
    t.dirty = false;
    t.content = m.content ?? t.content; // 注入路径
    t.orig = t.content;
    if (t.model && ideMonaco && ideMonaco.editor.getModel() === t.model && t.model.getValue() !== t.content) { ideProgSet = true; try { t.model.setValue(t.content); } finally { ideProgSet = false; } } // 注入路径回显(不算编辑)
    toast("已保存 " + rel + (m.bytes ? "(" + m.bytes + " bytes)" : ""));
    ideStatus("已保存 " + rel + (m.bytes ? "(" + m.bytes + " bytes)" : ""));
    ideScmRefresh(); // 保存成功 → 拉最新 SCM 状态(改动列表/树角标)
    ideDiagRequest([rel]); // Ctrl+S 保存成功 → 刷新该文件诊断
    idePreviewKick(t); // html 预览态保存成功 → iframe 换 r=Date.now 重载(板节点 03)
  } else {
    toast("保存失败:" + rel + " — " + String(m.reason || m.error || "未知原因").slice(0, 90), true);
    ideStatus("保存失败 " + rel + " ● 未保存保留");
  }
  if (ideTabs[ideActive] === t) ideBodyRender();
  ideTabsRender();
}
function BufferShim(s) { let n = 0; const str = String(s); for (let i = 0; i < str.length; i++) { const c = str.codePointAt(i); n += c > 0xffff ? 4 : (c > 0x7ff ? 3 : (c > 0x7f ? 2 : 1)); if (c > 0xffff) i++; } return n; }
/** server 沙箱拒绝走通用 error 帧(code=file-write-denied,无 path):找 saving 中标签保脏报错。 */
function ideSaveDenied(m) {
  const t = ideTabs.find((x) => x.saving);
  if (!t) return;
  t.saving = false;
  errToast(m, "保存失败 " + t.path);
  ideStatus("保存失败 " + t.path + " ● 未保存保留");
  if (ideTabs[ideActive] === t) ideBodyRender();
  ideTabsRender();
}
$("ideSave").onclick = () => ideSaveNow();
// ── Office 文本回写 P2(板节点「OOXML 文本回写」):编辑态 UI ──
/** 保存路径选择:**服务端处理**(发 ide.office.edit 让服务端读原文件 → rewriteOfficeText → 写回)。
 * 理由:浏览器端要自己拼 zip 得先经 /ide/asset 拿 10MB 级原始字节(该路由走 Range/200 全量),
 * 再在页面里引 zip 库 + XML 重打包 —— 内存翻倍且 Range 拼字节易错;服务端一行 readFileSync 就够。 */
function ideOfficeTab() {
  const t = ideActive >= 0 && ideActive < ideTabs.length ? ideTabs[ideActive] : null;
  return t && t.mode === "office" && t.officeKind ? t : null;
}
/** 工具条态同步(仅 office 层可见时按标签状态亮按钮)。 */
function ideOfficeBarSync(which) {
  const bar = $("ideOfficeBar"); if (!bar) return;
  const t = ideOfficeTab();
  const inEdit = !!(t && t.officeEdit);
  const eBtn = $("ideOfficeEditBtn"), sBtn = $("ideOfficeSaveBtn"), cBtn = $("ideOfficeCancelBtn"), hint = $("ideOfficeHint");
  const editable = which === "office" && !!t && !t.roReason;
  if (eBtn) { eBtn.style.display = inEdit ? "none" : ""; eBtn.disabled = !editable; }
  if (sBtn) { sBtn.style.display = inEdit ? "" : "none"; sBtn.disabled = !!(t && t.officeSaving); sBtn.textContent = t && t.officeSaving ? "保存中…" : "保存"; }
  if (cBtn) { cBtn.style.display = inEdit ? "" : "none"; cBtn.disabled = !!(t && t.officeSaving); }
  if (hint) hint.textContent = inEdit ? "编辑态:只改文字,不动版式/图片/表格格式(Ctrl+S 保存)" : "";
}
/** 进入编辑态:给渲染出的文本节点挂 contenteditable(定位属性 data-io-edit 由 ide-office 输出)。 */
function ideOfficeEditOn() {
  const t = ideOfficeTab(); if (!t) return;
  const host = $("ideOffice"); const lib = window.IdeOffice;
  if (!host || !lib || typeof lib.setEdit !== "function") { toast("预览组件未就绪,无法编辑", true); return; }
  const n = lib.setEdit(host, true);
  if (!n) { lib.setEdit(host, false); toast("本文档没有可编辑文本(图片/图表/表格不支持)", true); return; }
  t.officeEdit = true;
  t.dirty = false; // 进编辑态尚未改动(改动由 input 事件标脏)
  ideTabsRender();
  ideOfficeBarSync("office");
  ideStatus(t.path + " · 文本编辑态(" + n + " 处可编辑)");
}
/** 取消编辑:重新 render 丢弃改动(不重取 AST,直接用当前缓存的 ast)。 */
function ideOfficeEditOff() {
  const t = ideOfficeTab(); if (!t) return;
  t.officeEdit = false;
  t.dirty = false;
  ideTabsRender();
  const host = $("ideOffice"); const lib = window.IdeOffice;
  if (host && lib && typeof lib.setEdit === "function") { try { lib.setEdit(host, false); } catch (e) { /* 关编辑态失败仍继续重渲 */ } } // 关标记+清 store(改动即丢弃)
  if (host && t.officeAst && lib && typeof lib.render === "function") {
    try { lib.clear(host); } catch (e) { /* 清场失败仍继续重渲 */ }
    try { lib.render({ host: host, ast: t.officeAst, docPath: t.path, pid: ideRoot ? ideRoot.pid : "" }); } catch (e) { /* 渲染失败由下次 fetch 兜 */ }
  }
  ideOfficeBarSync("office");
  ideStatus(t.path + " · 已取消编辑");
}
/** 收集 dirty 段落 → 组 edits[](只有真改过的回传,未改的不动原文)。 */
function ideOfficeCollect(t) {
  const host = $("ideOffice"); const lib = window.IdeOffice;
  if (!host || !lib || typeof lib.collectEdits !== "function") return [];
  const raw = lib.collectEdits(host) || [];
  const out = [];
  for (const it of raw) {
    const key = String((it && it.key) || "");
    const text = String((it && it.text) || "");
    let m = /^slide:(\\d+):shape:(\\d+)$/.exec(key);
    if (m) { out.push({ slideIndex: Number(m[1]), shapeIndex: Number(m[2]), text: text }); continue; }
    m = /^block:(\\d+)$/.exec(key);
    if (m) { out.push({ blockIndex: Number(m[1]), text: text }); continue; }
  }
  return out;
}
/** 保存:服务端处理路径(不发二进制,只发「哪一段换成什么文本」)。 */
function ideOfficeSaveNow() {
  const t = ideOfficeTab(); if (!t || !t.officeEdit || t.officeSaving) return false;
  const edits = ideOfficeCollect(t);
  if (!edits.length) { toast("没有文本改动"); return true; }
  t.officeSaving = true;
  ideOfficeBarSync("office");
  ideStatus("保存文本改动 " + t.path + "…");
  const pid0 = (ideRoot && ideRoot.pid) || activeProjectId;
  wsSafeSend(JSON.stringify({ v: 1, type: "ide.office.edit", path: t.path, edits: edits, ...(pid0 ? { pid: pid0 } : {}) }));
  return true;
}
/** ide.office.edit.result 回包:ok→清编辑态 + toast + 重取 /ide/office 刷新预览;失败→toast 并保编辑态。 */
function ideOfficeEditResult(m) {
  const rel = String(m.path || "");
  const t = ideTabs.find((x) => x.path === rel && x.mode === "office" && x.officeSaving);
  if (!t) return;
  t.officeSaving = false;
  if (m.ok) {
    t.officeEdit = false;
    t.dirty = false;
    const host = $("ideOffice");
    if (host) {
      const lib = window.IdeOffice;
      if (lib && typeof lib.setEdit === "function") { try { lib.setEdit(host, false); } catch (e) { /* 关编辑态失败仍继续刷新 */ } } // 清编辑标记与本地 store(改动已落盘)
      if (lib && typeof lib.clear === "function") { try { lib.clear(host); } catch (e) { /* ignore */ } }
      host.innerHTML = ""; host.dataset.sig = "";
    } // 清 sig → ideBodyRender 重新 fetch
    toast("已保存文本改动 " + rel + (m.bytes ? "(" + m.bytes + " 字节)" : ""));
    ideStatus("已保存 " + rel);
    ideTabsRender();
    if (ideTabs[ideActive] === t) ideBodyRender();
    return;
  }
  toast("保存失败:" + rel + " — " + String(m.error || "未知原因").slice(0, 110), true);
  ideStatus("保存失败 " + rel + " · 编辑态保留");
  ideOfficeBarSync("office");
  ideTabsRender();
}
/** 工具条按钮绑定(skeleton 动态创建 → 在这里绑,幂等;顶层的 $("ideSave") 是静态 HTML 才可直接绑)。 */
function ideOfficeWire() {
  const e = $("ideOfficeEditBtn"), s = $("ideOfficeSaveBtn"), c = $("ideOfficeCancelBtn");
  if (e && !e.dataset.wired) { e.dataset.wired = "1"; e.onclick = () => ideOfficeEditOn(); }
  if (s && !s.dataset.wired) { s.dataset.wired = "1"; s.onclick = () => ideOfficeSaveNow(); }
  if (c && !c.dataset.wired) { c.dataset.wired = "1"; c.onclick = () => ideOfficeEditOff(); }
  const host = $("ideOffice");
  if (host && !host.dataset.editWired) { // 编辑态输入 → 标脏(标签条 ● 与关闭确认都靠 t.dirty)
    host.dataset.editWired = "1";
    host.addEventListener("input", () => {
      const t = ideOfficeTab();
      if (!t || !t.officeEdit || t.dirty) return;
      t.dirty = true;
      ideTabsRender();
      ideStatus(t.path + " ● 文本未保存");
    });
  }
}
// markdown「预览|源码」分段钮(仅 md 标签可见;切回源码不重建编辑器,只让 ideBodyRender 走 monaco 分支)
for (const b of $("ideMdSeg").querySelectorAll("button")) b.onclick = () => {
  const t = ideActive >= 0 && ideActive < ideTabs.length ? ideTabs[ideActive] : null;
  if (!t || t.mode !== "edit" || !ideIsMd(t.path)) return;
  t.mdView = b.dataset.md === "source" ? "source" : "preview";
  ideBodyRender();
};
// (板 5a7bb5d2)HTML「编辑|预览」分段钮(仅 html 编辑标签可见;切预览不销毁 Monaco 模型,切回恢复)
for (const b of $("idePvSeg").querySelectorAll("button")) b.onclick = () => {
  const t = ideActive >= 0 && ideActive < ideTabs.length ? ideTabs[ideActive] : null;
  if (!t || t.mode !== "edit" || !ideIsHtml(t.path)) return;
  idePvSet(t, b.dataset.pv === "preview" ? "preview" : "edit");
};
/** 切 html 标签显示态(编辑|预览)。切走预览前把 Monaco 模型现值收回 t.content(保脏判定/保存链吃最新文本)。 */
function idePvSet(t, view) {
  if (!t || !ideIsHtml(t.path) || t.mode !== "edit") return;
  const to = view === "preview" ? "preview" : "edit";
  if (to === "preview" && t.model && ideMonaco && t.dirty) { try { t.content = t.model.getValue(); } catch (e) { /* 模型已释放:沿用 t.content */ } } // 源码刚改过→预览不吃旧内容
  t.pvView = to;
  ideBodyRender();
}
/** HTML 预览层渲染。iframe.src=/ide/preview/<pid>/<rel>?r=<戳> —— pid 放路径段是关键:
 * 相对引用(style.css/app.js)按文档 URL 解析不继承 query,pid 在路径段才能让子资源请求仍带回项目沙箱;
 * r=时间戳 + 服务端 no-store 保证每次都是磁盘最新字节(保存后重载即出新内容)。 */
function idePreviewRender() {
  const t = ideActive >= 0 && ideActive < ideTabs.length ? ideTabs[ideActive] : null;
  const host = $("idePreview");
  const fr = $("idePreviewFrame");
  if (!t || !t.mode || t.mode !== "edit" || !ideIsHtml(t.path) || !host || !fr) { if (host) host.style.display = "none"; return; }
  const pid = ideRoot ? ideRoot.pid : "";
  const q = "/ide/preview/" + encodeURIComponent(pid) + "/" + String(t.path).split("/").map(encodeURIComponent).join("/") + "?r=" + Date.now();
  ideBodyShow("preview");
  if (fr.getAttribute("data-src") !== q) {
    fr.setAttribute("data-src", q);
    fr.src = q;
  }
  ideStatus(t.path + (t.dirty ? " ● 未保存" : "") + " · HTML 预览 · 保存后自动刷新");
  ideSaveSync();
}
/** 保存成功后预览刷新(板节点 03):当前标签是 html 且预览态开 → iframe 同 URL 换 r=Date.now 重载。 */
function idePreviewKick(t) {
  if (!t || t.mode !== "edit" || !ideIsHtml(t.path) || t.pvView !== "preview") return;
  if (ideTabs[ideActive] !== t) return; // 只刷当前可见的预览标签
  const fr = $("idePreviewFrame");
  if (!fr) return;
  const q = "/ide/preview/" + encodeURIComponent(ideRoot ? ideRoot.pid : "") + "/" + String(t.path).split("/").map(encodeURIComponent).join("/") + "?r=" + Date.now();
  fr.setAttribute("data-src", q);
  fr.src = q;
}
// ── 双中心布局:拖拽条 + Monaco 重排 + 刷新还原 + 入口按钮 ──
/** 右栏尺寸变化后踹一脚 Monaco editor.layout(automaticLayout 对 display:none→flex 的折叠恢复有盲区)。 */
function ideLayoutKick() {
  try { if (ideMonaco && ideMonaco.editor) ideMonaco.editor.layout(); } catch (e) { /* 编辑器未就绪:忽略 */ }
}
(() => {
 // 刷新还原:开合态与栏宽从 localStorage 恢复(≤1400 默认折叠:视口不够宽不强撑双栏)
  if (dualReadLS(DUAL_LS_OPEN, "0") === "1") {
    if (window.innerWidth > 1400) dualToggle(true);
    else dualWriteLS(DUAL_LS_OPEN, "0"); // 窄屏:保得开但本次不展开
  }
 // 拖拽分隔条:pointer 拖拽写 --dual-chatw(夹紧 360 ~ 视口-280);双击=收起右栏
  const sp = $("dualSplit");
  if (sp) {
    sp.ondblclick = () => dualToggle(false);
    sp.addEventListener("pointerdown", (ev) => {
      if (!dualOpen) return;
      ev.preventDefault();
      sp.classList.add("drag");
      const move = (e2) => {
        const max = window.innerWidth - DUAL_IDE_MIN;
        const w = Math.max(DUAL_CHAT_MIN, Math.min(max, e2.clientX));
        document.documentElement.style.setProperty("--dual-chatw", w + "px");
      };
      const up = () => {
        sp.classList.remove("drag");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        const cur = document.documentElement.style.getPropertyValue("--dual-chatw") || "";
        const w = Number(String(cur).replace("px", "").trim());
        if (w >= DUAL_CHAT_MIN) dualWriteLS(DUAL_LS_W, String(w));
        ideLayoutKick();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }
 // IDE 头部入口:vw-head 右缘加「双栏」切换钮(id=ideDualBtn);点它=开/收右栏(不动视图身份)
  const head = document.querySelector("#view-ide .vw-head");
  if (head) {
    const btn = document.createElement("button");
    btn.className = "vw-act"; btn.id = "ideDualBtn";
    btn.title = "与会话流并排(双中心布局;再点收起)";
    btn.textContent = "双栏";
    btn.onclick = (e3) => { e3.stopPropagation(); dualToggle(); };
    head.appendChild(btn);
  }
 // 右栏自适应兜底:ide-body 尺寸变化(拖拽/窗口缩放)→ editor.layout
  const body = $("ideBody");
  if (body && window.ResizeObserver) new ResizeObserver(() => ideLayoutKick()).observe(body);
})();
`;
