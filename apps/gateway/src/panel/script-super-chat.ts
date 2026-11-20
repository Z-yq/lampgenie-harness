/**
 * 面板主脚本分片:script-super-chat(指挥台聊天窗增强)。
 * 三件事:①附件(文件/图片/视频;拖拽+点击+粘贴;发送后进 super 轮次)②右键「添加到指挥台」
 * (上下文芯片 → 发送前言块 + 文件类同时作附件)③聊天窗内会话级模型切换(sessionId="super")。
 * 模板约束沿袭:不得出现反引号与 ${;行内换行不得写裸转义。
 * 与任务聊天窗的附件状态(pendingAtts)完全隔离:这里用 supPendingAtts,绝不复用同一状态。
 */
export const PANEL_JS_SUPER_CHAT = `// ---- 2026-11-16 指挥台聊天窗:附件 / 上下文引用 / 会话级模型 ----
var supPendingAtts = []; // [{name,path,mime,size,kind,preview}]
var supRefs = [];        // [{kind:"file"|"dir"|"task", label, path, taskId}]
var supUploadBusy = 0;   // 在途上传数(发送键禁用态与提示用)
var SUP_ATT_MAX = 8;     // 单入口选择上限;发送时 box+ref 合并按协议上限 12 截断(script-submit.ts supSend)
var SUP_REF_MAX = 8;
function supChatAtts() { if (!Array.isArray(supPendingAtts)) supPendingAtts = []; return supPendingAtts; }
function supChatRefs() { if (!Array.isArray(supRefs)) supRefs = []; return supRefs; }
/** 发送给服务端的附件字段(协议 super.turn.attachments 同构;不带 preview 等本地字段)。 */
function supAttPayload() {
  return supChatAtts().map(function (a) { return { name: a.name, path: a.path, mime: a.mime, size: a.size }; });
}
function supAttClear() { supPendingAtts = []; supAttRender(); }
function supRefClear() { supRefs = []; supRefRender(); }
/** 附件芯片条:缩略图(图片)/类型标识 + 文件名 + 大小 + 单个删除。 */
function supAttRender() {
  var bar = document.getElementById("supAtts");
  if (!bar) return;
  var list = supChatAtts();
  bar.style.display = list.length ? "flex" : "none";
  bar.innerHTML = list.map(function (a, i) {
    var thumb = "";
    if (a.kind === "image" && a.preview) thumb = '<img class="sup-at-thumb" src="' + a.preview + '" alt="">';
    else thumb = '<span class="sup-at-ico">' + esc(String(a.kind === "video" ? "VID" : (attTag(a.name, a.mime) || "FILE"))) + "</span>";
    return '<span class="sup-at" data-i="' + i + '" title="' + esc(String(a.path || "")) + '">' + thumb +
      '<span class="sup-at-n">' + esc(String(a.name || "")) + "</span>" +
      '<span class="sup-at-s">' + esc(attSize(a.size || 0)) + "</span>" +
      '<button class="sup-at-x" data-supattdel="' + i + '" title="移除该附件">×</button></span>';
  }).join("");
  var dels = bar.querySelectorAll("[data-supattdel]");
  for (var i = 0; i < dels.length; i++) {
    dels[i].onclick = function () {
      var idx = Number(this.getAttribute("data-supattdel"));
      supChatAtts().splice(idx, 1);
      supAttRender();
    };
  }
  supAttCountRender(list.length);
}
/** 附件计数徽标(P2-2③):「附」键右上角显示已选附件数;0 个时隐藏(不占位)。 */
function supAttCountRender(n) {
  var cnt = document.getElementById("supAttCount");
  if (!cnt) return;
  var num = Number(n) || 0;
  cnt.textContent = String(num);
  cnt.setAttribute("data-count", String(num));
  cnt.style.display = num ? "inline-block" : "none";
  var btn = document.getElementById("supAttBtn");
  if (btn) btn.title = num
    ? "已选 " + num + " 个附件(上限 " + SUP_ATT_MAX + ");点击继续添加,或拖拽/粘贴"
    : "添加附件(文件/图片/视频;也可拖拽或粘贴)";
}
/** 单个文件入队:类型/上限预检(与服务端 /upload 同口径)→ 图片/视频出本地预览 → POST /upload。 */
function supAttAdd(file) {
  if (!file) return;
  if (supChatAtts().length + supUploadBusy >= SUP_ATT_MAX) { toast("附件最多 " + SUP_ATT_MAX + " 个", true); return; }
  var kind = attKind(file.name, file.type || "");
  if (!kind) { toast("该类型不支持作为附件:" + file.name, true); return; }
  var lim = attLimitOf(kind);
  if (file.size && file.size > lim) { toast("附件超限:" + file.name + "(实际 " + attSize(file.size) + ",上限 " + attSize(lim) + ")", true); return; }
  if (!file.size) { toast("空文件无法作为附件:" + file.name, true); return; }
  var post = function (preview) { supAttPost(file, kind, preview); };
  if (kind === "image" || kind === "video") {
    var r = new FileReader();
    r.onload = function () { post(String(r.result || "")); };
    r.onerror = function () { post(""); };
    r.readAsDataURL(file);
  } else post("");
}
/** 正文上传:落 .genie/uploads/super/(与任务轨同一端点,不新起服务);失败给可重试提示。 */
function supAttPost(file, kind, preview) {
  supUploadBusy++;
  fetch("/upload?sid=super&name=" + encodeURIComponent(file.name), { method: "POST", body: file })
    .then(function (x) {
      return x.json().catch(function () { return { error: "HTTP " + x.status }; }).then(function (j) {
        if (!x.ok && j && !j.error) j.error = "HTTP " + x.status;
        return j;
      });
    })
    .then(function (j) {
      supUploadBusy--;
      if (!j || j.error) { toast("上传失败:" + String((j && j.error) || "未知错误") + "(可重新拖入或选择同一文件重试)", true); return; }
      supChatAtts().push({ name: file.name, path: j.path, mime: file.type || "application/octet-stream", size: file.size || j.size || 0, kind: kind, preview: preview || "" });
      supAttRender();
      toast("附件就绪:" + file.name + "(" + attSize(file.size || 0) + ")");
    })
    .catch(function (e) {
      supUploadBusy--;
      toast("上传中断:" + String((e && e.message) || e).slice(0, 100) + "(可重新拖入或选择该文件重试)", true);
    });
}
/** 右键「添加到指挥台」:引用型上下文(不改任何既有数据模型;内存态,不落盘)。 */
function supRefAdd(ref) {
  if (!ref || !ref.label) return;
  var key = String(ref.path || ref.taskId || ref.label);
  var list = supChatRefs();
  if (list.some(function (r) { return String(r.path || r.taskId || r.label) === key; })) { toast("已在指挥台上下文:" + ref.label); return; }
  if (list.length >= SUP_REF_MAX) { toast("上下文最多 " + SUP_REF_MAX + " 条,先移除几条", true); return; }
  list.push(ref);
  supRefRender();
  if (typeof switchView === "function") switchView("super");
  toast("已加入指挥台上下文:" + String(ref.label).slice(0, 40));
}
function supRefRender() {
  var bar = document.getElementById("supRefs");
  if (!bar) return;
  var list = supChatRefs();
  bar.style.display = list.length ? "flex" : "none";
  bar.innerHTML = list.map(function (r, i) {
    var tag = r.kind === "task" ? "任务" : r.kind === "dir" ? "目录" : "文件";
    return '<span class="sup-ref" data-i="' + i + '" title="' + esc(String(r.path || r.taskId || r.label)) + '">' +
      '<span class="sup-ref-tag">' + tag + "</span>" +
      '<span class="sup-ref-n">' + esc(String(r.label).slice(0, 60)) + "</span>" +
      '<button class="sup-ref-x" data-suprefdel="' + i + '" title="移除该上下文">×</button></span>';
  }).join("");
  var dels = bar.querySelectorAll("[data-suprefdel]");
  for (var i = 0; i < dels.length; i++) {
    dels[i].onclick = function () {
      supChatRefs().splice(Number(this.getAttribute("data-suprefdel")), 1);
      supRefRender();
    };
  }
}
/** 发送前言块:让 super 明确「这句是在引用什么」;与「添加到聊天」的 @ 引用语义互补。 */
function supRefPrefix() {
  var list = supChatRefs();
  if (!list.length) return "";
  var lines = list.map(function (r) {
    if (r.kind === "task") return "【指挥台上下文·任务】" + String(r.taskId || "") + " " + String(r.label || "");
    if (r.kind === "dir") return "【指挥台上下文·目录】" + String(r.path || "") + "(目录;需要时列目录读)";
    return "【指挥台上下文·文件】" + String(r.path || "");
  });
  return lines.join("\\n") + "\\n\\n";
}
/** 文件类 ref 同时作为附件(这样 super 真能读/看图,而不只是看见一串路径)。 */
function supRefAsAtts() {
  return supChatRefs().filter(function (r) { return r.kind === "file" && r.path; }).map(function (r) {
    return { name: String(r.label || r.path), path: String(r.path) };
  });
}
/** 模型 pill:会话级覆盖(sessionModelOverride.get("super"))优先,否则全局默认。 */
function supModelGlobal() {
  var cfg = cfgView && cfgView.config ? cfgView.config : null;
  return String((cfg && cfg.coding && cfg.coding.llm && cfg.coding.llm.model) || "");
}
function supModelEffective() {
  var ov = sessionModelOverride.get("super");
  var m = (ov && ov.model) || supModelGlobal();
  return { model: m, override: !!(ov && ov.model), providerId: String((ov && ov.providerId) || "") };
}
function supModelPillRender() {
  var el = document.getElementById("supModelPill");
  if (!el) return;
  var eff = supModelEffective();
  var label = eff.model || "(未配)";
  el.textContent = "模型 " + (label.length > 22 ? label.slice(0, 21) + "…" : label) + (eff.override ? " ·会话" : " ·默认");
  el.title = eff.override
    ? "本会话(指挥台 super)模型覆盖:" + eff.model + (eff.providerId ? "(端点 " + eff.providerId + ")" : "") + ";点击切换(只影响指挥台会话,不改全局默认)"
    : "指挥台会话当前跟随全局默认模型:" + (eff.model || "(未配)") + ";点击切换(只影响指挥台会话,不改全局默认)";
  supModelDotRender(eff);
}
/** 模型可用性判定:ok=模型名能在配置端点目录里解析到;warn=有模型名但目录里查不到(端点/模型未登记);err=未配模型。 */
function supModelAvailState(eff) {
  if (!eff || !eff.model) return "err";
  var cfg = cfgView && cfgView.config ? cfgView.config : null;
  var provs = (cfg && cfg.providers) || [];
  for (var i = 0; i < provs.length; i++) {
    var p = provs[i] || {};
    var ms = p.models || [];
    for (var j = 0; j < ms.length; j++) {
      var mm = ms[j];
      var nm = typeof mm === "string" ? mm : String((mm && mm.name) || "");
      if (nm && nm === eff.model) return "ok";
    }
  }
  return "warn";
}
/** 模型 pill 前的状态点(P2-2①):颜色随可用性 ok/warn/err;几何与底色内联兜底,待 CSS 落地可只留 class。 */
function supModelDotRender(eff) {
  var dot = document.getElementById("supModelDot");
  if (!dot) return;
  var e0 = eff || supModelEffective();
  var st = supModelAvailState(e0);
  dot.className = "sup-dot " + st;
  dot.setAttribute("data-state", st);
  dot.style.width = "7px";
  dot.style.height = "7px";
  dot.style.borderRadius = "50%";
  dot.style.display = "inline-block";
  dot.style.flex = "0 0 auto";
  dot.style.background = st === "ok" ? "var(--green,#9dc08b)" : st === "warn" ? "var(--warn,#d9b36c)" : "var(--red,#e08a7a)";
  dot.title = st === "ok" ? "模型可用:" + String(e0.model || "") + "(端点已登记)"
    : st === "warn" ? "模型可用性未知:配置目录里没有该模型(检查 设置 → 模型端点)"
    : "模型不可用:尚未配置任何模型端点(设置 → 模型)";
}
/** 打开模型菜单:与任务聊天窗同源同形态(modelMenuOpen 两级导航+渐变滑块+zoom clamp);
 * sid="super" 固定会话(staged/effort/跟随全局全走既有通道),supPillFit 兜底缩放重夹紧。 */
function supModelMenuOpen() {
  var anchor = document.getElementById("supModelPill");
  if (!anchor) return;
  try { modelMenuOpen(undefined, { anchorId: "supModelPill", sid: "super" }); } catch (e) { toast("模型菜单打开失败:" + String((e && e.message) || e).slice(0, 80), true); }
  try { supPillFit(anchor); window.__supMenuAnchorId = "supModelPill"; } catch (e) { /* 忽略 */ }
}
/* 旧实现下半段(pillMenuOpen 调用块)同批移除;新实现见上方 supModelMenuOpen */
/** 入口接线(幂等:__supChatWired 守卫;由本分片末尾与 supCtxWire 各调一次)。 */
function supChatWire() {
  var btn = document.getElementById("supAttBtn");
  var inp = document.getElementById("supAttInput");
  if (btn && inp && !btn.__supAtt) {
    btn.__supAtt = true;
    btn.onclick = function () { inp.click(); };
    inp.onchange = function () {
      for (var i = 0; i < inp.files.length; i++) supAttAdd(inp.files[i]);
      inp.value = "";
    };
  }
  var box = document.getElementById("superComposer");
  if (box && !box.__supDrop) {
    box.__supDrop = true;
    box.addEventListener("dragover", function (e) {
      var types = (e.dataTransfer && e.dataTransfer.types) || [];
      if ([].indexOf.call(types, "Files") >= 0) { e.preventDefault(); box.classList.add("sup-drop"); }
    });
    box.addEventListener("dragleave", function () { box.classList.remove("sup-drop"); });
    box.addEventListener("drop", function (e) {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault();
      e.stopPropagation(); // 防 document 级 drop 把同一文件再加进任务聊天窗附件
      box.classList.remove("sup-drop");
      for (var i = 0; i < e.dataTransfer.files.length; i++) supAttAdd(e.dataTransfer.files[i]);
    });
  }
  var ta = document.getElementById("superInput");
  if (ta && !ta.__supPaste) {
    ta.__supPaste = true;
    ta.addEventListener("paste", function (e) {
      var items = (e.clipboardData || {}).items || [];
      var took = false;
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (!it || it.kind !== "file") continue;
        var ty = String(it.type || "");
        if (ty.indexOf("image/") !== 0 && ty.indexOf("video/") !== 0) continue;
        var f = it.getAsFile();
        if (f) { supAttAdd(f); took = true; }
      }
      if (took) e.preventDefault();
    });
  }
  var pill = document.getElementById("supModelPill");
  if (pill && !pill.__supModel) { pill.__supModel = true; pill.onclick = function () { supModelMenuOpen(); }; }
  supAttRender();
  supRefRender();
  supModelPillRender();
}
setTimeout(function () { try { supChatWire(); } catch (e) { /* 面板未就绪:supCtxWire 处会再试一次 */ } try { newTaskTopbarWire(); } catch (e) { /* 同上:DOM 未就绪时下一拍再连 */ } }, 0);
/** P2-1 顶栏「新建任务」入口(web 面板):按钮 #tbNewTask 点击走**既有** newDraft(与侧栏 #act-new
 * onclick、命令中心 newtask /new、WS menu-command "new-task" 同一链路,不新写业务)。
 * 快捷键 Ctrl+N / Cmd+N 已在既有 keymap 里(script-chat-cite.ts hitKey "new-task" → preventDefault → newDraft;
 * descOf 把 meta 归一成 ctrl,故 meta/ctrl 均可),本处不重复绑定——重复会连打两次 newDraft。
 * desktop 壳已有独立入口(应用菜单 文件→新建任务),按任务书不重复添加:桌面壳内隐藏本按钮。 */
function newTaskTopbarWire() {
  var btn = document.getElementById("tbNewTask");
  if (!btn || btn.__newTaskWired) return;
  btn.__newTaskWired = true;
  btn.onclick = function () { if (typeof newDraft === "function") newDraft(); };
  var desk = !!(window.genieWindow && window.genieWindow.isDesktop);
  btn.setAttribute("data-desktop-hidden", desk ? "1" : "0");
  if (desk) btn.style.display = "none";
}
try { newTaskTopbarWire(); } catch (e) { /* 顶栏入口接线失败不影响面板 */ }
`;
