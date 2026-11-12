/**
 * 面板主脚本分片:script-voice-cite(逐字自 panel.ts PAGE 模板搬移, 拆分;含转义反引号 \\` 原样保留)。
 * 模板约束沿袭:除转义反引号外不得出现裸反引号与 ${。
 */
export const PANEL_JS_VOICE_CITE = `// ---- 语音任务书(2026-11-08):◎ 录音 → voice.draft → coding.models.voice 整理 → 回填输入区 ----
// 会话绑定语义:撰写锁按 sessionId 存Map;A 会话撰写中,A 的输入区只读+「任务书撰写中」,
// 切到 B 可正常输入,切回 A 仍未完成则继续锁;结果到达时 A 不在前台→暂存,openSession 回 A 时自动填入。
// 未配置 coding.models.voice=功能不可用(点击指路模型设置,不静默降级)。
const VOICE_REC_MAX_MS = 120 * 1000;   // 单条录音上限 120s,到点自动 stop(与截图标注录音同口径)
const VOICE_MAX_BYTES = 8 * 1024 * 1024; // >8MB 服务端拒收(WS 帧/端点上限),客户端先拦
function voiceLockKey(sid) { return sid || "__new__"; }
function voiceLocked(sid) { return voiceDraftBySid.has(voiceLockKey(sid)); }
function voiceSupported() { return !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia); }
function voiceFmt(sec) { const s = Math.max(0, Math.floor(sec || 0)); return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2); }
function renderVoiceState() {
  const el = $("instruction");
  const btn = $("voiceBtn");
  const rec = !!voiceRec;
  if (btn) {
    btn.classList.toggle("rec", rec);
    btn.textContent = rec ? "■" : "◎";
    btn.title = rec ? "录音中 " + voiceFmt(voiceRec.seconds) + " · 再点一次结束,AI 整理成任务书"
      : "语音输入:点击开始录音,再点一次结束 → AI 整理成任务书填入输入框";
  }
  if (!el) return;
  const locked = voiceLocked(currentSid);
  el.readOnly = locked;
  const cmp = document.querySelector(".composer");
  if (cmp) cmp.classList.toggle("voice-wait", locked);
  if (locked) el.placeholder = "任务书撰写中,请稍候…(完成后自动填入,期间本会话不能输入)";
  else if (rec && !inChip) el.placeholder = "录音中 " + voiceFmt(voiceRec.seconds) + "…再点 ◎ 结束,AI 整理成任务书";
}
function voiceRecTick() {
  if (!voiceRec) return;
  const el = Date.now() - voiceRec.startedAt;
  voiceRec.seconds = Math.floor(el / 1000);
  if (el >= VOICE_REC_MAX_MS) { voiceRecStop(); return; }
  renderVoiceState();
}
function voiceRecStart() {
  if (!voiceSupported()) { toast("当前环境不支持录音(缺 MediaRecorder 或麦克风权限)", 1); return; }
  if (voiceRec) return;
  if (voiceLocked(currentSid)) { toast("本会话任务书撰写中,请稍候…"); return; }
  const sidRaw = currentSid || "";
  let mime = "";
  const cands = ["audio/webm;codecs=opus", "audio/webm"];
  for (let ci = 0; ci < cands.length && !mime; ci++) {
    try { if (!window.MediaRecorder.isTypeSupported || window.MediaRecorder.isTypeSupported(cands[ci])) mime = cands[ci]; } catch (e) { /* 探测失败=当不支持 */ }
  }
  navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
    if (voiceRec) { try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* 已停 */ } return; }
    let mr;
    try { mr = new window.MediaRecorder(stream, mime ? { mimeType: mime } : {}); } catch (e) { mr = new window.MediaRecorder(stream); }
    voiceRec = { mr: mr, chunks: [], mime: mime || "", stream: stream, startedAt: Date.now(), timer: null, seconds: 0, sid: sidRaw };
    mr.ondataavailable = function (ev) { if (voiceRec && ev.data && ev.data.size > 0) voiceRec.chunks.push(ev.data); };
    mr.onstop = function () { voiceRecFinish(); };
    try { mr.start(); } catch (e) {
      voiceRec = null;
      try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e2) { /* 已停 */ }
      toast("录音启动失败:" + String(e && e.message || e).slice(0, 80), 1); return;
    }
    voiceRec.timer = setInterval(voiceRecTick, 500);
    renderVoiceState();
  }).catch(function (err) {
    toast("麦克风不可用:" + String(err && err.message || err).slice(0, 100), 1);
  });
}
function voiceRecStop() {
  if (!voiceRec) return;
  if (voiceRec.timer) { clearInterval(voiceRec.timer); voiceRec.timer = null; }
  try { if (voiceRec.mr.state !== "inactive") voiceRec.mr.stop(); } catch (e) { /* 已停 */ }
}
function voiceRecFinish() {
  const R = voiceRec; voiceRec = null;
  if (!R) return;
  if (R.timer) { clearInterval(R.timer); R.timer = null; }
  try { R.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* 已停 */ }
  renderVoiceState();
  let blob = null;
  try { blob = R.chunks.length ? new Blob(R.chunks, { type: R.mime || "audio/webm" }) : null; } catch (e) { blob = null; }
  R.chunks = [];
  if (!blob || blob.size === 0) { toast("没录到声音,再试一次", 1); return; }
  if (blob.size > VOICE_MAX_BYTES) { toast("录音过大(" + Math.round(blob.size / 1024 / 1024) + "MB > 8MB),请缩短时长", 1); return; }
  const reader = new FileReader();
  reader.onerror = function () { toast("录音读取失败,再试一次", 1); };
  reader.onload = function () {
    const dataUrl = String(reader.result || "");
    if (dataUrl.indexOf("data:audio/") !== 0) { toast("录音编码异常,再试一次", 1); return; }
    const lockKey = voiceLockKey(R.sid);
 // 跨会话草稿归位(体验经验证修复):录音期间切到别的会话再点停止,输入框是
 // 别会话的草稿——并进任务书的文字必须取录音所属会话自己的草稿(localStorage draftKey,
 // openSession 切走时 saveDraft 已落),不能读当前输入框(会串话)。
    let draftText = "";
    if (voiceLockKey(currentSid) === lockKey) draftText = String($("instruction").value || "").trim();
    else { try { draftText = String(localStorage.getItem("zh:draft:" + (R.sid || "__new__")) || "").trim(); } catch (e) { draftText = ""; } }
    const payload = JSON.stringify({ v: 1, type: "voice.draft", sessionId: R.sid, audioUrl: dataUrl, ...(draftText ? { draftText: draftText.slice(0, 20000) } : {}) }); // 20000=协议上限
 // 可达性判据与 wsSafeSend 同口径:open=直发;connecting=入队(重连后送达,回执可达);
 // 其它(closing/未连过)=-帧必丢,不锁不发,用户可直接重试(旧实现先锁后发,丢帧=永久锁死)。
    let deliverable = false;
    try { deliverable = ws.readyState === 1 || ws.readyState === 0 || (ws.readyState === 3 && rcAttempt > 0); } catch (e) { deliverable = false; }
    if (!deliverable) { toast("连接未就绪,录音未发送;内容已丢弃,可重新录音", 1); return; }
    wsSafeSend(payload);
    voiceDraftBySid.set(lockKey, true);
    renderSendBtn(); // 锁立即生效(readOnly+placeholder+按钮守卫)
 // 兜底闹钟:server 端最长 120s 超时+网络余量;超时仍锁=回执丢了(掉线/重连丢帧),
 // 解锁让用户可重试——写入侧丢帧会被这里兜住,不再永久锁死。
    if (voiceDraftTimer) clearTimeout(voiceDraftTimer);
    voiceDraftTimer = setTimeout(function () {
      if (!voiceDraftBySid.has(lockKey)) return;
      voiceDraftBySid.delete(lockKey);
      toast("任务书撰写无回执(连接中断或超时),已解锁;可重新录音", 1);
      if (voiceLockKey(currentSid) === lockKey) renderSendBtn();
    }, 180000);
    toast("录音已发送,AI 正在结合项目情况撰写任务书…");
  };
  reader.readAsDataURL(blob);
}
$("voiceBtn").onclick = function () {
  if (!voiceSupported()) { toast("当前环境不支持录音(缺 MediaRecorder 或麦克风权限)", 1); return; }
  if (voiceRec) { voiceRecStop(); return; }
  if (voiceLocked(currentSid)) { toast("本会话任务书撰写中,请稍候…"); return; }
  voiceRecStart();
};
/** voice.draft.result 回执:解锁+回填(前台直接写输入框;后台暂存,openSession 时 voiceStashApply)。 */
function voiceDraftResult(m) {
  const k = voiceLockKey(m.sessionId);
  if (voiceDraftTimer) { clearTimeout(voiceDraftTimer); voiceDraftTimer = null; } // 回执到达,摘兜底闹钟
  voiceDraftBySid.delete(k);
  if (!m.ok) { toast(m.message || "任务书撰写失败", 1); renderSendBtn(); return; }
  const text = String(m.text || "");
  if (!text) { toast("任务书撰写返回为空", 1); renderSendBtn(); return; }
  if (voiceLockKey(currentSid) === k) {
    if (inChip) chipUnmount(false); // 指令 chip 挂着时回填会视觉错位(chip 占位符盖住正文),先摘
    $("instruction").value = text;
    autoGrow(); saveDraft();
    toast("任务书已写入输入框,可修改后发送");
  } else {
    voiceStash.set(k, text);
    toast("任务书撰写完成(当前在其它会话,切回后自动填入)");
  }
  renderSendBtn();
}
/** 会话切回:暂存的任务书回填该会话输入框(撰写期间输入被锁,不存在用户新草稿被覆盖)。 */
function voiceStashApply() {
  const k = voiceLockKey(currentSid);
  if (!voiceStash.has(k)) return;
  const text = String(voiceStash.get(k) || "");
  voiceStash.delete(k);
  if (!text) return;
  if (inChip) chipUnmount(false); // 同上:chip 态回填先摘 chip
  $("instruction").value = text;
  autoGrow(); saveDraft();
  toast("任务书已填入(语音撰写完成)");
}
// ---- F4 file:line citation:file.ext:123 → 可点击引用(纯字符类正则,禁反斜杠转义) ----
// 单引号字符串+零反斜杠:模板层转义铁律。
const CITE_RE = new RegExp('(^|[ ([{">(]|<br>|</code>)((?:[A-Za-z0-9_/.-]*[.][A-Za-z0-9]+)):([0-9]+)', 'g');
function citeText(html) {
 // 已转义文本上叠加引用;避开 URL(http 的冒号前是字母+斜杠组合不匹配——扩展名+冒号+数字形态唯一性足够)。
  return html.replace(CITE_RE, function(all, pre, file, line) {
    if (file.indexOf("http") === 0) return all;
    return pre + '<a class="cite" data-path="' + file + '" data-line="' + line + '">' + file + ":" + line + "</a>";
  });
}
let fvTargetLine = 1, fvTargetPath = "";
function fvOpen(path, line) {
  fvTargetPath = path || "";
  fvTargetLine = line || 1;
  $("fvPath").textContent = path + ":" + fvTargetLine;
  $("fvBody").innerHTML = '<div style="padding:14px;color:var(--faint)">读取中…</div>';
 // 引用→代码档案文件钻取跳转链:档案视图内才露出(其它视图保留纯预览)
  $("fvDrill").style.display = (ppId && viewLive("project")) ? "" : "none";
  $("fileViewer").classList.add("on");
  wsSafeSend(JSON.stringify({ v: 1, type: "file.read", path: path, line: fvTargetLine }));
}
$("fvClose").onclick = () => $("fileViewer").classList.remove("on");
$("fvDrill").onclick = function() {
  const f = fvTargetPath;
  if (!f) return;
  $("fileViewer").classList.remove("on");
  projectSetTab("files", true);
  ppfCur = f;
  $("ppfGraphWrap").style.display = "none";
  wsSafeSend(JSON.stringify({ v: 1, type: "profile.file", projectId: ppId, file: f }));
  const box = $("ppf");
  if (box) box.scrollIntoView({ block: "nearest" });
};
$("fileViewer").onclick = (e) => { if (e.target === $("fileViewer")) $("fileViewer").classList.remove("on"); };
document.addEventListener("click", (e) => {
 // 聊天正文里的文件路径(裸路径/markdown 相对链接)→ IDE;其它视图行为不变
  const cfA = e.target.closest ? e.target.closest("a.chat-file") : null;
  if (cfA) { e.preventDefault(); openPathInIde(cfA.dataset.path, Number(cfA.dataset.line) || 0); return; }
  const a = e.target.closest ? e.target.closest("a.cite") : null;
  if (a) {
    e.preventDefault();
 // 聊天容器内的引用改走 IDE(含子代理工作区,#chatBody 共用);wiki/代码档案等视图保留旧浮层钻取
    if (a.closest && a.closest("#chatBody")) { openPathInIde(a.dataset.path, Number(a.dataset.line) || 0); return; }
    fvOpen(a.dataset.path, Number(a.dataset.line)); return;
  }
 // 评审注入钮:必须在 .rev-card 分支之前拦截(钮在卡内,closest 会命中卡而误开文件查看器);
 // summary 内的「全部注入」还要 preventDefault 阻止 details 折叠。
  const inj = e.target.closest ? e.target.closest(".rev-inj,.rev-inj-all") : null;
  if (inj) { e.preventDefault(); revInjectFromBtn(inj); return; }
 // 回写店勾选框:点击只勾选,不触发卡的文件查看器。
  if (e.target.closest && e.target.closest(".rev-sel")) return;
  const card = e.target.closest ? e.target.closest(".rev-card") : null;
  if (card) fvOpen(card.dataset.file, Number(card.dataset.line));
});
// ---- 聊天正文里的文件路径 → IDE 打开(后置 DOM 链接化;PAGE 零反斜杠纪律) ----
// 只做「渲染后补锚」:mdToHtml / mdInlineScan / renderCodeBlock / 代码围栏分支零改动。
// 锚 = <a class="chat-file" data-path data-line>,点击委托见上方 document click → openPathInIde。
const CF_BS = String.fromCharCode(92), CF_BT = String.fromCharCode(96);
const CF_DQ = String.fromCharCode(34), CF_SQ = String.fromCharCode(39);
const CF_NL = String.fromCharCode(10), CF_CR = String.fromCharCode(13), CF_TAB = String.fromCharCode(9);
const CF_EXT = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "md", "py", "go", "java", "c", "h", "cc", "cpp", "hpp", "rs", "rb", "php", "css", "scss", "html", "sh", "yaml", "yml", "toml", "ini", "txt", "csv", "svg", "png", "jpg", "jpeg", "gif", "webp", "pdf", "docx", "pptx", "xlsx"]);
const CF_SKIP_TAG = { a: 1, script: 1, style: 1, textarea: 1, button: 1, input: 1, select: 1 };
function cfIsPathChar(c) {
  const k = c.charCodeAt(0);
  if ((k >= 48 && k <= 57) || (k >= 65 && k <= 90) || (k >= 97 && k <= 122)) return true;
  return c === "_" || c === "." || c === "-" || c === "/" || c === "~";
}
function cfIsDigit(c) { const k = c.charCodeAt(0); return k >= 48 && k <= 57; }
/** 扩展名白名单命中(末段 .ext)。 */
function cfExtOk(tok) {
  const dot = tok.lastIndexOf(".");
  if (dot <= 0 || dot === tok.length - 1) return false;
  return CF_EXT.has(tok.slice(dot + 1).toLowerCase());
}
/** 尾部 :行号 → {path, line};只在扩展名命中时认行号(避免 12:30 / v1.2.3 误判)。 */
function cfSplitLine(s0) {
  const s = String(s0 == null ? "" : s0);
  const i = s.lastIndexOf(":");
  if (i <= 0) return { path: s, line: 0 };
  const tail = s.slice(i + 1);
  if (!tail || tail.length > 6) return { path: s, line: 0 };
  for (let k = 0; k < tail.length; k++) if (!cfIsDigit(tail.charAt(k))) return { path: s, line: 0 };
  const head = s.slice(0, i);
  if (!cfExtOk(head)) return { path: s, line: 0 };
  return { path: head, line: Number(tail) };
}
/** URL 区间(整段不参与链接化):协议头之后到下一个空白/标签边界。 */
function cfUrlRanges(s) {
  const low = s.toLowerCase();
  const heads = ["http://", "https://", "ftp://", "mailto:"];
  const out = [];
  for (const h of heads) {
    let p = low.indexOf(h);
    while (p >= 0) {
      let e = p;
      while (e < s.length) {
        const c = s.charAt(e);
        if (c === " " || c === CF_TAB || c === CF_NL || c === CF_CR || c === "<" || c === ">" || c === CF_DQ || c === CF_SQ) break;
        e++;
      }
      out.push([p, e]);
      p = low.indexOf(h, e);
    }
  }
  return out;
}
function cfInRanges(ranges, a, b) {
  for (const r of ranges) if (a < r[1] && b > r[0]) return true;
  return false;
}
/** markdown 相对链接 [label](path) → {label, path, line, end} 或 null(外链/锚点不接)。 */
function cfReadMdLink(s, i) {
  let j = i + 1, depth = 1;
  while (j < s.length && depth > 0) {
    const c = s.charAt(j);
    if (c === "[") depth++;
    else if (c === "]") depth--;
    if (depth === 0) break;
    j++;
  }
  if (depth !== 0) return null;
  const label = s.slice(i + 1, j);
  if (s.charAt(j + 1) !== "(") return null;
  let k = j + 2, dep2 = 1;
  while (k < s.length && dep2 > 0) {
    const c2 = s.charAt(k);
    if (c2 === "(") dep2++;
    else if (c2 === ")") dep2--;
    if (dep2 === 0) break;
    k++;
  }
  if (dep2 !== 0) return null;
  let target = s.slice(j + 2, k).trim();
  const sp = target.indexOf(" ");
  if (sp > 0) target = target.slice(0, sp);
  const low = target.toLowerCase();
  if (!target || target.charAt(0) === "#" || low.indexOf("http") === 0 || low.indexOf("//") === 0 || low.indexOf("mailto:") === 0) return null;
  const cut = cfSplitLine(target);
  if (!cfExtOk(cut.path)) return null;
  return { label: label || cut.path, path: cut.path, line: cut.line, end: k + 1 };
}
/** 纯扫描(DOM 无关,可单测):text → [{t:"text",v} | {t:"path",v,line} | {t:"link",label,path,line}]。
 * noMd=true(pre/code 内):只链裸路径,不解析 markdown 字面。 */
function cfScanText(text, noMd) {
  const s = String(text == null ? "" : text);
  const out = [];
  const urls = cfUrlRanges(s);
  let buf = "", i = 0;
  const flush = () => { if (buf) { out.push({ t: "text", v: buf }); buf = ""; } };
  while (i < s.length) {
    const ch = s.charAt(i);
    if (!noMd && ch === "[") {
      const lk = cfReadMdLink(s, i);
      if (lk && !cfInRanges(urls, i, lk.end)) { flush(); out.push({ t: "link", label: lk.label, path: lk.path, line: lk.line }); i = lk.end; continue; }
    }
    if (cfIsPathChar(ch)) {
      const prev = i > 0 ? s.charAt(i - 1) : "";
      const prev2 = i > 1 ? s.slice(i - 2, i) : "";
      const dotOk = ch !== "." || s.charAt(i + 1) === "/";
 // 左边界排除:URL 片段(//)、协议尾(/)、markdown 链接目标字面(](中文冒号“改这里:apps/x.ts”仍可链
      if ((!prev || !cfIsPathChar(prev)) && prev2 !== "//" && prev2 !== ":/" && prev2 !== "](" && dotOk) {
        let j = i;
        while (j < s.length && cfIsPathChar(s.charAt(j))) j++;
        let tok = s.slice(i, j);
        let line = 0;
        if (s.charAt(j) === ":") {
          let k = j + 1, num = "";
          while (k < s.length && cfIsDigit(s.charAt(k))) { num += s.charAt(k); k++; }
          if (num && num.length <= 6 && cfExtOk(tok) && !cfIsPathChar(s.charAt(k))) { line = Number(num); j = k; }
        }
        while (tok.length > 1) {
          const tc = tok.charAt(tok.length - 1);
          if (tc === "." || tc === "-" || tc === "~") { tok = tok.slice(0, -1); j--; } else break;
        }
        if (tok.length >= 4 && cfExtOk(tok) && !cfInRanges(urls, i, j)) {
          flush(); out.push({ t: "path", v: tok, line: line }); i = j; continue;
        }
      }
    }
    buf += ch; i++;
  }
  flush();
  return out;
}
/** 单个文本节点 → 片段;已包裹(a.chat-file 内)/容器标签内跳过(幂等)。 */
function cfLinkifyNode(tx) {
  const p = tx.parentNode;
  if (!p || !p.ownerDocument) return 0;
  const el = p.nodeType === 1 ? p : null;
  const tag = el ? String(el.nodeName || "").toLowerCase() : "";
  if (CF_SKIP_TAG[tag]) return 0;
  if (el && el.closest && el.closest("a.chat-file")) return 0;
  if (el && el.closest && el.closest(".llm-trace-line")) return 0;
  const text = tx.nodeValue || "";
  if (text.length < 4 || text.indexOf(".") < 0) return 0;
  const inCode = !!(el && el.closest && el.closest("pre,code"));
  const parts = cfScanText(text, inCode);
  let hitn = 0;
  for (const pt of parts) if (pt.t !== "text") { hitn++; break; }
  if (!hitn) return 0;
  const doc = p.ownerDocument;
  const frag = doc.createDocumentFragment();
  for (const pt of parts) {
    if (pt.t === "text") { frag.appendChild(doc.createTextNode(pt.v)); continue; }
    const a = doc.createElement("a");
    const path = pt.t === "link" ? pt.path : pt.v;
    a.className = "chat-file";
    a.setAttribute("data-path", path);
    if (pt.line) a.setAttribute("data-line", String(pt.line));
    a.setAttribute("title", path + (pt.line ? ":" + pt.line : "") + " · 在 IDE 打开");
    a.textContent = pt.t === "link" ? pt.label : (pt.v + (pt.line ? ":" + pt.line : ""));
    frag.appendChild(a);
  }
  p.replaceChild(frag, tx);
  return 1;
}
/** 把 rootEl 内所有文本节点里的文件路径包成 a.chat-file;返回包裹次数。 */
function linkifyFilePaths(rootEl) {
  const root = rootEl || $("chatBody");
  if (!root || !root.ownerDocument) return 0;
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 4, null);
  const list = [];
  let n = walker.nextNode();
  while (n) { list.push(n); n = walker.nextNode(); }
  let made = 0;
  for (const tx of list) { try { made += cfLinkifyNode(tx); } catch (e) { /* 单节点失败不影响其余 */ } }
  return made;
}
// MutationObserver:#chatBody 子代理工作区复用同一容器,故一处挂钩两处生效;debounce 60ms。
let cfObs = null, cfTimer = 0;
const cfQueue = [];
function cfPump() {
  cfTimer = 0;
  const q = cfQueue.splice(0, cfQueue.length);
  if (!q.length) return;
  const box = $("chatBody");
  if (!box) return;
  if (cfObs) cfObs.disconnect(); // 自改动不回头触发(处理期断开,结束再挂)
  try { for (const nd of q) { if (!nd || !nd.isConnected) continue; linkifyFilePaths(nd.nodeType === 1 ? nd : nd.parentNode); } }
  finally { if (cfObs) cfObs.observe(box, { childList: true, subtree: true, characterData: true }); }
}
function cfKick(nd) {
  if (!nd) return;
  cfQueue.push(nd);
  if (!cfTimer) cfTimer = setTimeout(cfPump, 60);
}
function cfObserveChat() {
  const box = $("chatBody");
  if (!box || typeof MutationObserver === "undefined" || cfObs) return;
  cfObs = new MutationObserver((recs) => {
    for (const r of recs) {
      if (r.type === "characterData") { cfKick(r.target.parentNode); continue; }
      const add = r.addedNodes || [];
      for (let k = 0; k < add.length; k++) cfKick(add[k]);
    }
  });
  cfObs.observe(box, { childList: true, subtree: true, characterData: true });
  linkifyFilePaths(box);
  window.__chatFile = { scan: cfScanText, linkify: () => linkifyFilePaths($("chatBody")), resolve: cfResolvePath, open: openPathInIde,
    count: () => { const b = $("chatBody"); return b ? b.querySelectorAll("a.chat-file").length : 0; },
    lastOpen: () => cfLastOpen,
    cands: () => cfRootCands(),
    probeLog: () => cfProbeLog,
    revealLog: () => cfRevealLog,
    ide: () => ({ view: document.body.dataset.view || "", active: ideActive, root: ideRoot ? ideRoot.pid : "",
      tabs: ideTabs.map((t) => ({ path: t.path, mode: t.mode, reveal: t.revealLine })) }) };
}
/** 路径归一:去包裹引号/反引号/尖括号、反斜杠转斜杠、去尾标点。 */
function cfNormPath(raw) {
  let s = String(raw == null ? "" : raw).trim();
  let guard = 0;
  for (;;) {
    const before = s;
    if (s.length >= 2) {
      const a = s.charAt(0), b = s.charAt(s.length - 1);
      if ((a === CF_DQ && b === CF_DQ) || (a === CF_SQ && b === CF_SQ) || (a === CF_BT && b === CF_BT) || (a === "<" && b === ">")) s = s.slice(1, -1).trim();
    }
    s = s.split(CF_BS).join("/");
    for (;;) {
      const c = s.charAt(s.length - 1);
      if (c === "." || c === "," || c === ";" || c === "?" || c === "!" || c === ")" || c === "]") { s = s.slice(0, -1); continue; }
      break;
    }
    guard++;
    if (s === before || guard > 6) break;
  }
  return s;
}
/** 可用的项目根:可见 projects + harness 根(sysMeta.repoRoot;purpose=conversation 时不在 projects 里)。 */
function cfRootCands() {
  const out = [], seen = {};
  const push = (pid, label, p) => {
    if (!pid || seen[pid]) return;
    const r = ideNorm(cfNormPath(p));
    if (!r) return;
    seen[pid] = 1;
    out.push({ pid: pid, label: label || pid, path: r });
  };
  for (const p of (Array.isArray(projects) ? projects : [])) if (p && p.path) push(p.id, p.label, p.path);
  if (sysMeta && sysMeta.repoRoot) push("__harness__", "harness", sysMeta.repoRoot);
  return out;
}
function cfRelSafe(rel) {
  if (!rel) return false;
  const segs = rel.split("/");
  for (const sg of segs) if (sg === "..") return false;
  return true;
}
/** 路径 → {pid, label, root, rel, line} 或 null(不在已注册项目内/越界)。 */
function cfResolvePath(raw) {
  const cut = cfSplitLine(cfNormPath(raw));
  const p = cut.path;
  if (!p) return null;
  const cands = cfRootCands();
  const drive = p.length > 2 && p.charAt(1) === ":" && p.charAt(2) === "/";
  if (p.charAt(0) === "/" || drive) {
    let best = null;
    for (const c of cands) {
      if (p === c.path) continue;
      if (p.indexOf(c.path + "/") === 0 && (!best || c.path.length > best.path.length)) best = c;
    }
    if (!best) return null;
    const rel = p.slice(best.path.length + 1);
    if (!cfRelSafe(rel)) return null;
    return { pid: best.pid, label: best.label, root: best.path, rel: rel, line: cut.line };
  }
  let base = null;
  if (ideRoot && ideRoot.path) base = { pid: ideRoot.pid || "__harness__", label: ideRoot.label || "", root: ideNorm(ideRoot.path) };
  if (!base) { const r0 = ideRootOf(); if (r0) base = { pid: r0.pid, label: r0.label || "", root: ideNorm(r0.path) }; }
  if (!base) { for (const c of cands) if (c.pid === "__harness__") { base = { pid: c.pid, label: c.label, root: c.path }; break; } }
  if (!base) return null;
  let rel = p;
  while (rel.indexOf("./") === 0) rel = rel.slice(2);
  while (rel.charAt(0) === "/") rel = rel.slice(1);
  if (!rel || !cfRelSafe(rel)) return null;
  return { pid: base.pid, label: base.label, root: base.root, rel: rel, line: cut.line };
}
/** 打开:视图不在 IDE 先切;目标 pid 与当前 ideRoot 不同则先立根再开标签;行号交给 ideOpenFile。 */
function cfOpenNow(hit, line) {
  try {
    if (!viewLive("ide")) switchView("ide");
    if (!ideRoot || ideRoot.pid !== hit.pid) {
      ideLoad(hit.pid, { pid: hit.pid, label: hit.label || hit.pid, path: hit.root });
      ideScmRefresh();
    }
  } catch (e) { console.warn("[chat-file] 切换 IDE 失败", e); }
  ideOpenFile(hit.rel, line ? { line: Number(line) } : undefined);
}
const cfProbes = new Map(); // dirAbs -> {hit, name, at}
const cfProbeLog = []; // 探针留痕(浏览器实测诊断用):{dir,cached,res,hit}
function cfProbeNote(o) { cfProbeLog.push(o); if (cfProbeLog.length > 40) cfProbeLog.shift(); }
/** 点击入口:解析归属 → 目录存在性探针 → 命中才动 IDE(缺失只 toast,不改 IDE 状态)。 */
let cfLastOpen = null;
function openPathInIde(raw, line) {
  const hit = cfResolvePath(raw);
  cfLastOpen = { raw: String(raw == null ? "" : raw), hit: hit, line: Number(line) || 0 };
  if (!hit) { toast("打不开 " + String(raw == null ? "" : raw).slice(0, 90) + " · 不在已注册项目内", true); return false; }
  const ln = Number(line) > 0 ? Number(line) : (hit.line || 0);
  const cut = hit.rel.lastIndexOf("/");
  const dirRel = cut > 0 ? hit.rel.slice(0, cut) : "";
  const name = cut > 0 ? hit.rel.slice(cut + 1) : hit.rel;
  const dirAbs = hit.root + (dirRel ? "/" + dirRel : "");
  const cached = dirCache.get(dirAbs);
  if (cached) {
    let okFile = false;
    for (const en of cached) if (en && en.name === name && en.kind !== "dir") { okFile = true; break; }
    cfProbeNote({ dir: dirAbs, cached: true, res: okFile ? "open" : "missing" });
    if (!okFile) { toast("打不开 " + hit.rel + ":文件不存在", true); return false; }
    cfOpenNow(hit, ln);
    return true;
  }
  cfProbeNote({ dir: dirAbs, cached: false, res: "probe" });
  cfProbes.set(dirAbs, { hit: hit, name: name, at: Date.now(), line: ln });
  wsSafeSend(JSON.stringify({ v: 1, type: "fs.list", path: dirAbs }));
  return true;
}
/** fs.list.result 探针钩子(分发器在 dirCache 落盘后调用):命中 → 存在则开 IDE,缺失只 toast。 */
function cfProbeHit(m) {
  if (!cfProbes.size) return false;
  const key = String(m.path || "");
  const rec = cfProbes.get(key);
  if (!rec) return false;
  cfProbes.delete(key);
  if (Date.now() - rec.at > 15000) return true;
  const entries = Array.isArray(m.entries) ? m.entries : [];
  let okFile = false;
  for (const en of entries) if (en && en.name === rec.name && en.kind !== "dir") { okFile = true; break; }
  cfProbeNote({ dir: key, cached: false, res: okFile ? "open" : "missing", n: entries.length });
  if (!okFile) { toast("打不开 " + rec.hit.rel + ":文件不存在或在项目外", true); return true; }
  cfOpenNow(rec.hit, rec.line || 0);
  return true;
}
// 初次全量:脚本尾部 DOM 已就绪;之后由 observer 增量处理(历史重渲/流式补丁/子代理工作区)。
setTimeout(() => { try { cfObserveChat(); } catch (e) { console.warn("[chat-file] 初始化失败", e); } }, 0);

function fvRender(m) {
  if (m.missing) { $("fvBody").innerHTML = '<div style="padding:14px;color:var(--red)">' + (m.unavailable ? "项目目录不可用:只读保护(恢复目录或重新添加项目后可读)" : "文件不可读(不存在/越界/二进制)") + "</div>"; return; }
  const lines = String(m.content).split(String.fromCharCode(10));
  $("fvBody").innerHTML = lines.map((l, i) => {
    const ln = m.startLine + i;
    return '<div class="fv-line' + (ln === fvTargetLine ? " hl" : "") + '"><span class="ln">' + ln + "</span><span>" + esc(l) + "</span></div>";
  }).join("");
  const hl = $("fvBody").querySelector(".fv-line.hl");
  if (hl) hl.scrollIntoView({ block: "center" });
}

// ---- @ 文件提及(ZCode fileMentionProvider 移植) ----
let mentionOpen = false, mentionItems = [], mentionHot = 0, mentionTokenStart = -1, mentionQuerySeq = 0, mentionDebounce = null, mentionTrigger = "@";
let mentionMeta = []; // #/$ 触发符的元数据(任务/经验对象),@ 为纯路径串
const MENTION_TRIGGERS = "@#$";
function mentionToken(text, caret) {
 // 光标前回扫 token(手工扫描,禁正则转义):触发符(@文件/#会话/$技能)前是边界,token 内无空白。
  let i = caret - 1;
  while (i >= 0) {
    const c = text.charAt(i);
    if (MENTION_TRIGGERS.indexOf(c) >= 0) {
      if (i === 0 || text.charAt(i - 1) <= " ") return { start: i, trigger: c, query: text.slice(i + 1, caret) };
      return null;
    }
    if (c <= " ") return null;
    i--;
  }
  return null;
}
function mentionRender() {
  const box = $("mentionMenu");
  if (!mentionOpen || mentionItems.length === 0) { box.style.display = "none"; box.innerHTML = ""; return; }
  box.style.display = "";
  const kindLabel = mentionTrigger === "@" ? "文件" : mentionTrigger === "#" ? "会话" : "经验";
  box.innerHTML = mentionItems.map((f, i) =>
    '<div class="sc-item' + (i === mentionHot ? " hot" : "") + '" data-i="' + i + '">' +
    '<span class="sc-name">' + mentionTrigger + '</span><span class="sc-desc">' + esc(f.label || f) + '</span>' +
    '<span class="sc-kind">' + kindLabel + '</span></div>').join("");
  for (const el of box.querySelectorAll(".sc-item")) {
    el.onclick = () => mentionExec(Number(el.dataset.i));
    el.onmouseenter = () => { mentionHot = Number(el.dataset.i); mentionRender(); };
  }
}
function mentionExec(i) {
  const item = mentionItems[i];
  if (!item) return;
 // 插入体:@=文件引用载体 [文件名](./路径)(与 skill 一样做特殊渲染,气泡里还原成 chip);
 // #=会话参考(指令摘要);$=经验参考(category/name)。
  const f = typeof item === "string" ? buildFileMention(item, item.slice(-1) === "/" ? "dir" : "file")
    : mentionTrigger === "#" ? "(参考会话:" + (item.label || "").slice(0, 40) + ")"
    : mentionTrigger === "@" ? buildFileMention(item.path || item.rel || item.label || "", "file")
    : "(参考经验:" + item.category + "/" + item.name + ")";
  const el = $("instruction");
  const caret = el.selectionStart ?? el.value.length;
  const after = el.value.slice(caret);
  el.value = el.value.slice(0, mentionTokenStart) + f + " " + after;
  mentionClose();
  el.focus();
  const pos = mentionTokenStart + f.length + 1;
  el.setSelectionRange(pos, pos);
  saveDraft(); autoGrow(); fileRefRender();
}
function mentionClose() { mentionOpen = false; mentionItems = []; mentionHot = 0; mentionTokenStart = -1; $("mentionMenu").style.display = "none"; }
function mentionUpdate() {
  const el = $("instruction");
  const tok = mentionToken(el.value, el.selectionStart ?? el.value.length);
  if (!tok) { mentionClose(); return; }
  mentionOpen = true;
  mentionTokenStart = tok.start;
  mentionTrigger = tok.trigger;
  mentionHot = 0;
  if (tok.trigger === "@") {
    clearTimeout(mentionDebounce);
    mentionDebounce = setTimeout(() => {
      wsSafeSend(JSON.stringify({ v: 1, type: "files.search", query: tok.query }));
    }, 120);
  } else if (tok.trigger === "#") {
 // 会话提及:本地任务清单子串过滤(标题/指令),插入为上下文参考。
    const q = tok.query.toLowerCase();
    mentionMeta = [...tasks.values()]
      .filter((t) => !q || rowTitle(t).toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 9)
      .map((t) => ({ label: rowTitle(t).slice(0, 46), task: t }));
    mentionItems = mentionMeta;
    mentionRender();
  } else {
 // 技能提及:经验库索引(exp.list 已周期可得;未加载即拉)。
    const q = tok.query.toLowerCase();
    const pool = expItems.length ? expItems : [];
    mentionMeta = pool
      .filter((x) => !q || (x.category + "/" + x.name + " " + x.description).toLowerCase().includes(q))
      .slice(0, 9);
    mentionItems = mentionMeta.map((x) => ({ label: x.category + "/" + x.name + " — " + (x.description || "").slice(0, 30), category: x.category, name: x.name }));
    mentionRender();
  }
  if (tok.trigger === "@" && mentionItems.length === 0) mentionRender();
}

$("instruction").addEventListener("input", () => { if (inChip) { saveDraft(); autoGrow(); renderSendBtn(); return; } slashUpdate(); saveDraft(); autoGrow(); mentionUpdate(); cmdChipUpdate(); renderSendBtn(); fileRefRender(); });
$("instruction").onkeydown = (e) => {
 // IME 守卫(ref app-input-pane.tsx:35-38 键绑定语义):中文输入法组词期间 Enter 是「选词/确认候选」,
 // 不是提交——isComposing(或老口径 keyCode===229)时提前放行,覆盖 chip/mention/slash/主提交全部 Enter 路径,
 // 防选词回车误发送。Shift+Enter 换行保持既有(textarea 默认行为,无需处理)。
  if (e.isComposing || e.keyCode === 229) return;
 // chip 态优先——Enter 发送(执行指令逻辑)/Backspace 空参摘 chip/Esc 取消;
 // 其余按键不进 palette/历史导航/@mention 分派(chip 态输入框承载的是参数,不是命令文本)。
  if (inChip) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); chipSubmit(); return; }
    if (e.key === "Escape") { e.preventDefault(); chipUnmount(false); autoGrow(); return; }
    if (e.key === "Backspace" && !$("instruction").value && ($("instruction").selectionStart === 0)) { e.preventDefault(); chipUnmount(true); autoGrow(); return; }
    return;
  }
  if (mentionOpen && mentionItems.length > 0) {
    if (e.key === "ArrowDown") { e.preventDefault(); mentionHot = (mentionHot + 1) % mentionItems.length; mentionRender(); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); mentionHot = (mentionHot - 1 + mentionItems.length) % mentionItems.length; mentionRender(); return; }
    if (e.key === "Enter") { e.preventDefault(); mentionExec(mentionHot); return; }
    if (e.key === "Escape") { e.preventDefault(); mentionClose(); return; }
  }
  if (slashOpen && slashItems.length > 0) {
    if (e.key === "ArrowDown") { e.preventDefault(); slashHot = (slashHot + 1) % slashItems.length; slashRender(); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); slashHot = (slashHot - 1 + slashItems.length) % slashItems.length; slashRender(); return; }
    if (e.key === "Enter") {
 // 视频:输入已完整命中命令且带参数时,Enter 走 typed 提交(参数直达处理函数)——
 // 原先菜单无条件吞 Enter,「/goal 修好X」被 slashExec 降级成无参查询且静默=「技能没有被用上」的直接体感。
      const v0 = $("instruction").value.trim();
      if (v0 === "/") { e.preventDefault(); return; } // 裸斜杠不执行首项(审计 C7:此前 "/" + Enter 误触 newtask)
      if (slashTypedMatch(v0) && v0.includes(" ")) { slashClose(); /* 落到下方 Enter=submit */ }
      else { e.preventDefault(); slashExec(slashHot); return; }
    }
    if (e.key === "Escape") { e.preventDefault(); slashClose(); return; }
  }
 // n4④:空结果(slashOpen 但 slashItems 为空)时面板仍显示空态文案——Esc 仍要能关,不能被下方的
 // 查找条/其它 Esc 分支抢走(空态是本次改造新增的可视状态,关闭通道必须配套)。
  if (slashOpen && e.key === "Escape") { e.preventDefault(); slashClose(); return; }
 // 输入历史↑↓(空输入或历史浏览态才接管;ZCode PromptHistoryPlugin 语义)
  if (e.key === "ArrowUp" && ($("instruction").value === "" || histNav >= 0)) {
    if (promptHist.length) { e.preventDefault(); histNav = histNav < 0 ? promptHist.length - 1 : Math.max(0, histNav - 1); $("instruction").value = promptHist[histNav]; autoGrow(); }
    return;
  }
  if (e.key === "ArrowDown" && histNav >= 0) {
    e.preventDefault();
    histNav = histNav + 1;
    if (histNav >= promptHist.length) { histNav = -1; $("instruction").value = ""; slashClose(); } // :程序化清空同口径收起面板
    else $("instruction").value = promptHist[histNav];
    autoGrow(); return;
  }
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); return; }
  if (e.key === "Escape" && findQuery) { findBarClose(); return; }
};
restoreDraft();
renderSendBtn();
// 启动恢复守卫(用户报错三连:Still in CONNECTING/__restored TDZ/navHist TDZ):
// savedView 恢复与 hello 恢复都会经 openSession/switchView 发 WS 消息、碰 navHist/__restored。
// ①WS 可能仍在 CONNECTING:发前守卫;②hello 可能在顶层声明(7484/7717 行)执行前到达(TDZ):
// 恢复动作统一推迟到声明全部落位之后(脚本末尾统一触发),不在中间裸调。
const startViewPending = savedView || null;
if (savedView) { document.body.dataset.view = savedView; }
// 导航按钮: 点已在位的=停留(ZCode workspaceMainView 语义,不弹回)
// 合一入口(侧栏入口直达项目档案视图。
function openProfileEntry() {
 // n9/B7 作用域:有会话时**优先会话归属项目**(session.owner.get → session.owner.result 缓存的 sid→projectId);
 // 归属未知=先按 activeProjectId 渲染并置 arcOwnerPending(回包到达后自动按归属项目重取);
 // 归属明确为 null → ownerProjectId 已回退 activeProjectId,卡头 ppOwnerNote 标「该会话无归属项目」。
  const sid = currentSid || "";
  let pid;
  if (sid && sessionOwnerState(sid) === "known") pid = ownerProjectId();
  else if (sid) { pid = activeProjectId || "__harness__"; arcOwnerPending = true; ownerPull(sid); }
  else pid = ppId || (document.querySelector("[data-prof]") && document.querySelector("[data-prof]").dataset.prof) || activeProjectId || "__harness__";
  openProfile(pid);
}
$("act-sense").onclick = () => openProfileEntry();
$("act-wf").onclick = () => switchView("wf");
$("act-exp").onclick = () => switchView("exp");
// 团队/节点/审批中心(此前只有静态 HTML 无 onclick=死按钮;switchView 内已带各自数据拉取)
$("act-team").onclick = () => switchView("team");
$("teamTabMembers").onclick = () => switchView("team");
$("teamTabIssues").onclick = () => switchView("issues"); // fixD5:Issue 看板子标签(三列拖拽+筛选+确认派发)
$("teamTabDash").onclick = () => switchView("dash"); // 看板子标签(运行看板收编
$("act-super").onclick = () => superOpen(); // 指挥台(画布态自动退经典后进视图)
$("act-rsi").onclick = () => switchView("rsi"); // 做梦视图入口(机制卡+全量运行;rsi 内部视图名)
/** 全量运行:按最近一拍 rsiLast 逐个发 rsi.mechanism.run(只发已启用机制;服务端
 * startMechanismRun 自带运行中拒绝;rsiRender 把运行中态同步成按钮禁用防重入)。发出后回聊天段看做梦卡。 */
function rsiRunAllFire() {
  const btn = $("rsiRunAll");
  if (btn && btn.disabled) return; // 防重入(运行中)
  const secs = (rsiLast && Array.isArray(rsiLast.sections) ? rsiLast.sections : []) || [];
  let n = 0;
  for (const s of secs) {
    const id = rsiSecId(s || {});
    const en = rsiOptMerge(id, rsiSecEnabled(s || {}), rsiSecDriver(s || {})).en;
    if (!id || !en) continue; // 只跑已启用机制
    rsiPending[id] = Date.now();
    wsSafeSend(JSON.stringify({ v: 1, type: "rsi.mechanism.run", id }));
    n++;
  }
  if (!n) { toast("没有已启用的机制可运行", true); return; }
  rsiRerender();
  toast("已逐个发出 " + n + " 个机制运行(做梦卡将在聊天流出现)");
  switchView("super"); // 回聊天段:做梦开始/完成卡由服务端注入 super 会话并广播
}
$("rsiRunAll").onclick = () => rsiRunAllFire(); // 全量运行:逐个 startMechanismRun(已启用机制;运行中禁用防重入)
$("act-nodes").onclick = () => switchView("nodes");
$("act-approvals").onclick = () => switchView("approvals");
$("act-subchat").onclick = () => switchView("subchat"); // 画布形态专属(经典 CSS 隐藏按钮);switchView 聚焦对应卡;n3 融合后原「分身 Agents」入口并入此卡
// n3 别名兼容:旧布局/旧书签/旧键盘序列仍可能送来 subagents —— 一律回退到子agent会话流,不白屏。
function cvAliasView(name) { return name === "subagents" || name === "agents" ? "subchat" : name; }
$("act-track").onclick = () => switchView("track");
$("act-usage").onclick = () => switchView("usage");
$("uGear").onclick = () => switchView("sys");
$("uAva").onclick = () => switchView("sys");
$("act-new").onclick = newDraft;
// act-term / act-files 左栏按钮已撤:终端走 Ctrl+J(KEYMAP open-terminal);文件走侧栏桶头「文件树」滑入层与项目右键「查看文件」
$("projRow").onclick = newDraft; // ZCode 项目头点击=草稿导航(handleWorkspaceOpenChange)
// quick-row 快捷卡已移除(视频与侧栏入口重复,没有必要)——经验库/自动化走侧栏 act-exp/act-wf。
// 复刻 ZCode 命令中心
let ccHist = JSON.parse(localStorage.getItem("zh:cc-hist") || "[]");
function ccOpen() { $("cc").classList.add("on"); $("cc-q").value = ""; ccRender(); $("cc-q").focus(); }
function ccPushHist(q) {
  if (!q) return;
  ccHist = ccHist.filter((x) => x !== q); ccHist.push(q);
  if (ccHist.length > 20) ccHist.shift();
  localStorage.setItem("zh:cc-hist", JSON.stringify(ccHist));
}
function ccClose() { ccPushHist($("cc-q").value.trim()); $("cc").classList.remove("on"); }
let ccScope = "all"; // all | cmd | file | session(ZCode >命令/#会话/@文件;#并入 all 主域)
/** 会话搜索结果渲染:服务端 session.search.result;«» 转高亮,点行进会话。 */
function ccSessionRender(m) {
  if (!$("cc").classList.contains("on") || !$("cc-q").value.trim().startsWith("#")) return;
 // 迟到回包守卫:查询已变成别的词时丢弃(连续输入时旧响应不覆盖新结果)。
  const liveQ = $("cc-q").value.trim().slice(1).trim().toLowerCase();
  if (String(m.query || "").trim().toLowerCase() !== liveQ) return;
  const r = m.result || {};
  if (r.error) { $("cc-list").innerHTML = '<div class="cc-empty">' + esc(String(r.error)) + "</div>"; return; }
  const rows = Array.isArray(r.results) ? r.results : [];
  if (!rows.length) {
    const q = $("cc-q").value.trim().slice(1).trim();
    $("cc-list").innerHTML = '<div class="cc-empty">' + (q ? "没有匹配的会话" : "还没有可浏览的历史会话") + "</div>";
    return;
  }
  $("cc-list").innerHTML = rows.map((row, i) => {
    const best = row.best || {};
    const snip = esc(String(best.snippet || "")).replace(/«/g, "<mark>").replace(/»/g, "</mark>");
    const src = row.source === "automation" ? "自动" : row.source === "subagent" ? "子代理" : row.source === "companion" ? "陪伴" : "";
    const badge = src ? '<span class="cc-badge">' + esc(src) + (row.demoted ? " · 降权" : "") + "</span>" : row.demoted ? '<span class="cc-badge">降权</span>' : "";
    return '<div class="cc-item cc-sess' + (i === 0 ? " hot" : "") + '" data-sid="' + esc(row.sessionId) + '">' +
      '<span class="ct">' + esc(row.title || row.sessionId) + badge + "</span>" +
      '<span class="cc-meta">' + esc(ago(row.lastAt || Date.now())) + " · " + Number(row.hits || 0) + " 命中</span>" +
      '<span class="cc-snip">' + (snip || esc(row.sessionId)) + "</span></div>";
  }).join("");
  for (const el of $("cc-list").querySelectorAll(".cc-item")) el.onclick = () => { openSession(el.dataset.sid); ccClose(); };
}
function ccRender() {
  const raw = $("cc-q").value.trim();
  const low = raw.toLowerCase();
  ccScope = raw.startsWith(">") ? "cmd" : raw.startsWith("#") ? "session" : raw.startsWith("@") ? "file" : "all";
  const q = (ccScope === "all" ? raw : raw.slice(1)).trim().toLowerCase();
  ccHot = 0;
  let html = "";
 // 画布形态:命令中心兼「模块跳转」——输入模块名/关键词直接飞到对应卡片(无限画布)
  const cardHits = (ccScope === "all" && q && canvasActive() && window.CanvasShell && CanvasShell.titles)
    ? CanvasShell.titles().filter((t) => String(t.title).toLowerCase().indexOf(q) >= 0 || String(t.name).toLowerCase().indexOf(q) >= 0)
    : [];
  const cardHtml = cardHits.map((t, i) => '<div class="cc-item cc-card' + (i === 0 && ccScope === "all" ? " hot" : "") + '" data-card="' + esc(t.name) + '">' +
    '<span class="ct">⧉ ' + esc(t.title) + '</span><span class="t-time">定位卡片</span></div>').join("");
  if (ccScope === "cmd") {
    const cmds = SLASH_COMMANDS.filter((c) => !q || c.value.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q) || c.kw.some((k) => k.toLowerCase().includes(q)));
    html = cmds.length ? cmds.map((c, i) => '<div class="cc-item' + (i === 0 ? " hot" : "") + '" data-cmd="' + esc(c.value) + '"><span class="ct">/' + esc(c.value) + '</span><span class="t-time">' + esc(c.desc) + '</span></div>').join("") : '<div class="cc-empty">没有匹配的命令</div>';
  } else if (ccScope === "session") {
    if (!q) {
      html = '<div class="cc-empty">输入关键词搜索全部历史会话(最近会话 · 自动化会话降权)</div>';
      wsSafeSend(JSON.stringify({ v: 1, type: "session.search", query: "", limit: 12 }));
    } else {
      html = '<div class="cc-empty">会话搜索中…</div>';
      wsSafeSend(JSON.stringify({ v: 1, type: "session.search", query: q, limit: 12 }));
    }
  } else if (ccScope === "file") {
    html = '<div class="cc-empty">文件搜索中…(回车发送查询)</div>';
    wsSafeSend(JSON.stringify({ v: 1, type: "files.search", query: q }));
  } else if (!q && ccHist.length) {
    html = '<div class="cc-empty" style="text-align:left">最近搜索:</div>' + ccHist.slice(-8).reverse().map((h, i) => '<div class="cc-item" data-hist="' + esc(h) + '"><span class="ct">' + esc(h) + '</span><span class="t-time">历史</span></div>').join("");
  } else if (!q) {
    html = '<div class="cc-empty">输入搜索;> 命令 · @ 文件 · 直接搜任务</div>';
  } else {
    const list = [...tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt)
      .filter((t) => !q || rowTitle(t).toLowerCase().includes(q) || String(t.instruction || "").toLowerCase().includes(q)).slice(0, 20);
    html = list.length
      ? list.map((t, i) => '<div class="cc-item' + (i === 0 && !cardHits.length ? " hot" : "") + '" data-sid="' + esc(t.sessionId) + '">' + indicator(t) +
          '<span class="ct">' + esc(rowTitle(t)) + '</span><span class="t-time">' + ago(t.updatedAt) + '</span></div>').join("")
      : (cardHits.length ? "" : '<div class="cc-empty">没有匹配的任务</div>');
  }
 // 模块卡片命中置顶(画布形态):输入模块名回车即飞到那张卡
  if (cardHits.length && ccScope === "all") html = cardHtml + html;
  $("cc-list").innerHTML = html;
  for (const el of $("cc-list").querySelectorAll(".cc-item")) {
    el.onclick = () => {
      if (el.dataset.card) { // 模块域:定位到画布上的卡片(画布形态专属)
        cvKeyCall(function () { CanvasShell.showCard(el.dataset.card); CanvasShell.focus(el.dataset.card, { zoom: true }); }, null);
        ccClose(); return;
      }
      if (el.dataset.cmd) { // >命令域:等价选中斜杠指令
        ws.send === undefined; const c = SLASH_COMMANDS.find((x) => x.value === el.dataset.cmd);
 // 参数/发送类与 palette 同语义——进输入框 chip 占位;ui 纯动作=即执行。
        const ck = slashChipKind(c);
        if (c && ck) { switchView("chat"); $("instruction").value = ""; chipMount(c, ck, ""); }
        else if (c && c.kind === "ui") c.run();
        else if (c) { $("instruction").value = c.expand ? c.expand() : ""; switchView("chat"); $("instruction").focus(); }
      } else if (el.dataset.hist) { $("cc-q").value = el.dataset.hist; ccRender(); return; }
      else if (el.dataset.file) { // @文件域:插入输入框
        $("instruction").value = ($("instruction").value + " " + el.dataset.file).trim() + " ";
        switchView("chat"); $("instruction").focus();
      } else openSession(el.dataset.sid);
      ccClose();
    };
  }
}
$("act-search").onclick = ccOpen;
$("cc-q").oninput = ccRender;
$("cc").onclick = (e) => { if (e.target === $("cc")) ccClose(); };
// ---- F5 快捷键自定义:zh:keymap(action-id → 组合描述,如 "ctrl+shift+k") ----
// 中心 keymap + matchKey/hitKey:自定义绑定优先;未自定义回退文档默认(键面标注的 Alt 备选由 hitKey 第三参承担)。
const KEYMAP_LS = "zh:keymap";
const KEY_DEFAULTS = {
  "open-search": "ctrl+k",
  "new-task": "ctrl+n",
  "toggle-sidebar": "ctrl+b",
  "open-settings": "ctrl+,",
  "toggle-theme": "ctrl+shift+l",
  "model-menu": "ctrl+m",
  "open-terminal": "ctrl+j",
  "open-browser": "ctrl+alt+b",
 // IDE 域快捷键(仅 #view-ide 内由 IDE capture 监听拦截;非 IDE 视图仍按原键位走上面的全局动作)
  "ide-command-palette": "ctrl+shift+p",
  "ide-goto-file": "ctrl+p",
  "ide-search": "ctrl+shift+f",
  "ide-rename": "f2",
  "ide-new-file": "ctrl+shift+n",
  "ide-close-tab": "ctrl+w",
  "ide-wordwrap": "alt+z",
 // 第二批(VSCode 对齐):终端抽屉 Ctrl+\`(仅 IDE 域)与大纲 Ctrl+Shift+O
  "ide-terminal": "ctrl+\`",
  "ide-outline": "ctrl+shift+o",
};
const KEY_ACTIONS = [
  { id: "open-search", desc: "打开命令中心(任务 · @文件 · #会话 · $技能 · >命令)" },
  { id: "new-task", desc: "新建任务(空白会话)" },
  { id: "toggle-sidebar", desc: "收起/展开侧栏" },
  { id: "open-settings", desc: "打开设置" },
  { id: "toggle-theme", desc: "循环切换主题(8 套)" },
  { id: "model-menu", desc: "打开模型菜单(快切主模型)" },
  { id: "open-terminal", desc: "切换终端(浏览器占用时 Alt J)" },
  { id: "open-browser", desc: "打开内嵌浏览器" },
 // IDE 域动作(仅 #view-ide 内生效,由 IDE capture 监听拦截;非 IDE 视图不劫持原键位)
  { id: "ide-command-palette", desc: "IDE:命令面板(转到文件 / IDE 命令)" },
  { id: "ide-goto-file", desc: "IDE:快速转到文件" },
  { id: "ide-search", desc: "IDE:全项目内容搜索(替换)" },
  { id: "ide-rename", desc: "IDE:重命名当前文件" },
  { id: "ide-new-file", desc: "IDE:新建文件" },
  { id: "ide-close-tab", desc: "IDE:关闭当前标签" },
  { id: "ide-wordwrap", desc: "IDE:切换自动换行" },
  { id: "ide-terminal", desc: "IDE:开关底部终端(Ctrl+\`)" },
  { id: "ide-outline", desc: "IDE:大纲(Ctrl+Shift+O,跳符号)" },
];
let keymap = {};
try { const km = JSON.parse(localStorage.getItem(KEYMAP_LS) || "{}"); if (km && typeof km === "object") keymap = km; } catch (e) { keymap = {}; }
function descOf(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  const k = String(e.key || "").toLowerCase();
  if (k && k !== "control" && k !== "alt" && k !== "shift" && k !== "meta") parts.push(k);
  return parts.join("+");
}
function keyLabel(desc) {
  return String(desc || "").split("+").filter(Boolean).map((p) => {
    if (p === "ctrl") return "Ctrl";
    if (p === "alt") return "Alt";
    if (p === "shift") return "Shift";
    if (p === " ") return "Space";
    return p.length === 1 ? p.toUpperCase() : p;
  }).join(" + ");
}
function matchKey(e, actionId) {
  const custom = keymap[actionId];
  if (custom) return descOf(e) === String(custom).toLowerCase();
  const def = KEY_DEFAULTS[actionId];
  return !!def && descOf(e) === def;
}
function hitKey(e, actionId, altFallback) {
  if (matchKey(e, actionId)) return true;
  if (keymap[actionId]) return false; // 已自定义:文档默认与 Alt 备选一并让位
  return !!altFallback && e.altKey && e.key.toLowerCase() === altFallback;
}
let keyCapturing = false;
function keyCapture(actionId) {
  if (keyCapturing) return;
  keyCapturing = true;
  toast("按下新的快捷键组合(Esc 取消)…");
  const fn = (e) => {
    e.preventDefault(); e.stopPropagation();
    if (e.key === "Escape") { document.removeEventListener("keydown", fn, true); keyCapturing = false; return; }
    const desc = descOf(e);
    const k = String(e.key || "").toLowerCase();
    const isFn = k.length > 1 && k.charAt(0) === "f" && k.charCodeAt(1) >= 48 && k.charCodeAt(1) <= 57;
    if (!desc || (!desc.includes("+") && !isFn)) { toast("请用带修饰键的组合(如 Ctrl+J)或 F1-F12", true); return; }
    document.removeEventListener("keydown", fn, true);
    keyCapturing = false;
 // 冲突:同组合的其它自定义绑定让位
    for (const other of Object.keys(keymap)) if (other !== actionId && String(keymap[other]).toLowerCase() === desc) delete keymap[other];
    keymap[actionId] = desc;
    localStorage.setItem(KEYMAP_LS, JSON.stringify(keymap));
    toast(actionId + " → " + keyLabel(desc));
    keymapRender();
  };
  document.addEventListener("keydown", fn, true);
}
function keymapRender() {
  const host = $("kbdCustomRows");
  if (!host) return;
  host.innerHTML = KEY_ACTIONS.map((a) => {
    const cur = keyLabel(keymap[a.id] || KEY_DEFAULTS[a.id] || "");
    const custom = !!keymap[a.id];
    return '<tr data-action="' + a.id + '"><td>' + esc(cur) + '</td><td>' + esc(a.desc) + '</td>' +
      '<td style="white-space:nowrap;padding-left:10px"><button class="vw-act kbd-set" data-action="' + a.id + '">自定义</button>' +
      (custom ? ' <button class="vw-act kbd-clr" data-action="' + a.id + '">默认</button>' : "") + '</td></tr>';
  }).join("");
  for (const b of host.querySelectorAll(".kbd-set")) b.onclick = () => keyCapture(b.dataset.action);
  for (const b of host.querySelectorAll(".kbd-clr")) b.onclick = () => {
    delete keymap[b.dataset.action];
    localStorage.setItem(KEYMAP_LS, JSON.stringify(keymap));
    keymapRender();
    toast(b.dataset.action + " 已恢复默认键位");
  };
}
$("kbdReset").onclick = () => {
  keymap = {};
  localStorage.removeItem(KEYMAP_LS);
  keymapRender();
  toast("快捷键已全部恢复默认");
};
keymapRender();
// Ctrl+K / Ctrl+N / Ctrl+B(复刻 ZCode shortcutCommands)
document.addEventListener("keydown", (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (ctrl && e.shiftKey && key === "p") { e.preventDefault(); $("cc").classList.contains("on") ? ccClose() : ccOpen(); return; }
  if (hitKey(e, "open-search")) { e.preventDefault(); $("cc").classList.contains("on") ? ccClose() : ccOpen(); return; }
  if (hitKey(e, "new-task")) { e.preventDefault(); newDraft(); return; }
  if (hitKey(e, "toggle-sidebar")) { e.preventDefault(); toggleSidebar(); return; }
  if (hitKey(e, "open-settings")) { e.preventDefault(); switchView("sys"); setSection("general"); return; }
  if (hitKey(e, "toggle-theme")) { e.preventDefault(); cycleTheme(); return; }
  if (hitKey(e, "model-menu")) { e.preventDefault(); refreshModelPill(); $("modelPill").click(); return; }
  if ((ctrl && key === "t") || (e.altKey && key === "t")) { e.preventDefault(); $("effortPill").click(); return; }
  if (hitKey(e, "open-terminal", "j")) { e.preventDefault(); switchView(viewLive("term") ? "chat" : "term"); return; }
  if (hitKey(e, "open-browser", "b")) { e.preventDefault(); switchView("browser"); return; }
 // Ctrl+W 关标签已随 tabbar 五件套删除(冗余收敛)
  if (ctrl && key === "o") { e.preventDefault(); ccOpenProjects(); return; }
  if (ctrl && e.shiftKey && (e.key === "[" || e.key === "{")) { e.preventDefault(); cycleSession(-1); return; }
  if (ctrl && e.shiftKey && (e.key === "]" || e.key === "}")) { e.preventDefault(); cycleSession(1); return; }
  if (ctrl && (e.key === "[" || e.key === "{")) { e.preventDefault(); navBack(); return; }
  if (ctrl && (e.key === "]" || e.key === "}")) { e.preventDefault(); navForward(); return; }
 // 画布快捷键:优先作用于画布视口;画布不可用/调用失败时回落到经典实现(缩放=界面缩放),
 // 失败必须留痕(console.warn),不静默吞——画布资产 404 时这是唯一的排障线索。
  if (ctrl && (e.key === "=" || e.key === "+")) { e.preventDefault(); cvKeyCall(function () { CanvasShell.zoomStep(1); }, zoomStep.bind(null, 1)); return; }
  if (ctrl && e.key === "-") { e.preventDefault(); cvKeyCall(function () { CanvasShell.zoomStep(-1); }, zoomStep.bind(null, -1)); return; }
  if (ctrl && e.key === "0") { e.preventDefault(); cvKeyCall(function () { CanvasShell.fitAll(); }, zoomReset); return; }
 // 画布形态独占键(Ctrl+Shift+C 经典/画布互切;Ctrl+Shift+F 全卡入画)——只改形态,不动数据
  if (ctrl && e.shiftKey && key === "c") {
    e.preventDefault();
    try { CanvasShell.toggleMode(); } catch (err) { console.warn("[canvas] 形态切换失败(资产未加载?)", err); toast("画布资产不可用,已留在经典布局", true); }
    return;
  }
  if (ctrl && e.shiftKey && key === "f") { e.preventDefault(); cvKeyCall(function () { CanvasShell.fitAll(); }, null); return; }
  if (e.key === "Escape") { ccClose(); return; }
  if ($("cc").classList.contains("on")) {
    const items = [...$("cc-list").querySelectorAll(".cc-item")];
    if (!items.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[ccHot].classList.remove("hot");
      ccHot = (ccHot + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      items[ccHot].classList.add("hot");
    }
    if (e.key === "Enter") { e.preventDefault(); items[ccHot].click(); }
  }
});
// ---- 快捷键实现(Ctrl+Shift+L 主题 / Ctrl+Shift+[ ] 任务轮换 / Ctrl+[ ] 导航历史 / Ctrl+±/0 缩放) ----
function cycleTheme() {
 // 全主题循环(dark→light→sand→glass→olive→plum→ink→system→dark)
  const order = ["dark", "light", "sand", "glass", "olive", "plum", "ink", "system"];
  const i = Math.max(0, order.indexOf(settings.theme));
  settings.theme = order[(i + 1) % order.length];
  localStorage.setItem("zh:theme", settings.theme);
  applySettings();
  const th = THEMES.find((t) => t.key === settings.theme);
  toast("主题 → " + (th ? th.name : settings.theme === "system" ? "跟随系统" : settings.theme));
}
// 启动恢复在 navHist 声明后统一执行(见 navHist 上方块)——此处原裸调 switchView 已上移。
let navHist = [], navIdx = -1;
window.__navReady = true; // 启动期守卫标志(顶层声明全部落位;wsOnMessage 用它替代 typeof navHist——let-TDZ 上 typeof 会抛)
// 启动恢复(挪到块尾):原位置在 navHist 之后、但 IDE 模块(ideRoot 等
// 顶层 let,约 290 行后)之前——恢复视图=ide 时 ideLoad 读 ideRoot 命中 let-TDZ,
// 用户反馈「Cannot access 'ideRoot' before initialization」。整块后移,保证块内全部
// 顶层声明落位后才恢复视图;navReady 标志仍在此处先置(wsOnMessage 早到帧守卫只认它)。
function navPush(sid) {
 // 导航历史(后退/前进):连续相同不重复入栈;截断前进分支。
  if (navHist[navIdx] === sid) return;
  navHist = navHist.slice(0, navIdx + 1);
  navHist.push(sid);
  if (navHist.length > 40) { navHist.shift(); }
  navIdx = navHist.length - 1;
}
function navBack() {
  if (navIdx <= 0) { toast("已在最早(历史 " + (navIdx + 1) + "/" + navHist.length + ")", true); return; }
  navIdx--;
  const sid = navHist[navIdx];
  if (sid) openSession(sid); else newDraft();
}
function navForward() {
  if (navIdx >= navHist.length - 1) { toast("已是最新", true); return; }
  navIdx++;
  const sid = navHist[navIdx];
  if (sid) openSession(sid); else newDraft();
}
function cycleSession(dir) {
 // 上一个/下一个任务:按最近更新排序的任务会话轮换。
 // 轮换复用 runFirstCmp(3.1 单调时间线:running 置顶+createdAt 稳定层,
 // 非 running 按 updatedAt)——旧实现裸按 updatedAt 排序,流式事件刷 updatedAt 会让轮换顺序跳变。
  const sids = [];
  const bySess = new Map();
  for (const t of [...tasks.values()].sort(runFirstCmp)) {
    if (!bySess.has(t.sessionId)) bySess.set(t.sessionId, t);
  }
  for (const t of bySess.values()) if (!sids.includes(t.sessionId)) sids.push(t.sessionId);
  if (!sids.length) { toast("暂无任务", true); return; }
  const cur = currentSid ? sids.indexOf(currentSid) : -1;
  const next = cur < 0 ? (dir > 0 ? 0 : sids.length - 1) : (cur + dir + sids.length) % sids.length;
  openSession(sids[next]);
}
function zoomStep(d) {
  const steps = [0.8, 0.9, 1, 1.1, 1.25, 1.5];
  const i = steps.indexOf(Number(settings.zoom));
  let j = i < 0 ? steps.indexOf(1) : i + d;
  j = Math.min(steps.length - 1, Math.max(0, j));
  settings.zoom = steps[j];
  localStorage.setItem("zh:zoom", String(settings.zoom));
  applySettings();
  toast("界面缩放 " + Math.round(settings.zoom * 100) + "%");
}
function zoomReset() { settings.zoom = 1; localStorage.setItem("zh:zoom", "1"); applySettings(); toast("界面缩放 100%"); }
// 命令中心 · 项目作用域(Ctrl+O):列出项目,点选即切换激活项目。
function ccOpenProjects() {
  ccOpen();
  ccRenderProjects();
}
function ccRenderProjects() {
  const host = $("cc-list");
  host.innerHTML = projects.length
    ? projects.map((p, i) => '<div class="cc-item' + (i === 0 ? " hot" : "") + '" data-pid="' + esc(p.id) + '"><span class="ct">' + esc(p.label || p.id) + (p.id === activeProjectId ? "(当前)" : "") + '</span><span class="t-time">' + esc(String(p.path || "").slice(0, 40)) + "</span></div>").join("")
    : '<div class="cc-empty">暂无项目(侧栏「添加项目」)</div>';
  ccHot = 0;
  for (const el of host.querySelectorAll(".cc-item")) el.onclick = () => { wsSafeSend(JSON.stringify({ v: 1, type: "project.activate", projectId: el.dataset.pid })); ccClose(); };
}
sendOrQueue2 = () => {};
renderProvPresets();
setTimeout(() => { wsSafeSend(JSON.stringify({ v: 1, type: "automation.list" })); refreshModelPill(); sendOrQueue({ v: 1, type: "commands.list" }); }, 800);
// 侧栏显隐 + 宽度拖拽(复刻 ZCode WorkspaceShellLayout: CSS 变量 + localStorage;收起时藏拖拽柄)
function toggleSidebar() {
  const hid = document.body.classList.toggle("sb-hidden");
  $("sidebar").classList.toggle("hidden", hid);
  localStorage.setItem("zh:sb-hidden", hid ? "1" : "0");
}
$("sbToggle").onclick = toggleSidebar;
// 折叠细轨(ZCode WorkspaceSidebarCollapsedRail):logo 悬停换面板图标,点击回展开;隐藏态新建入口
$("sbRailToggle").onclick = toggleSidebar;
$("sbRailNew").onclick = () => { toggleSidebar(); newDraft(); };
// 窄聊天窗自动收起(ZCode WorkspaceShellLayout: 会话宽 <360px → 收侧栏;仅自动收起,永不自动展开;300ms 防抖)
(() => {
  let t = 0;
  window.addEventListener("resize", () => {
    if (t) return;
    t = setTimeout(() => {
      t = 0;
      if (document.body.classList.contains("sb-hidden") || window.innerWidth <= 860) return;
      const sb = document.getElementById("sidebar").getBoundingClientRect();
      const scc = document.getElementById("superConsole");
      const avw = scc ? scc.getBoundingClientRect().width : 0;
      if (window.innerWidth - (sb.width || 0) - avw < 360) toggleSidebar();
    }, 300);
  });
})();
if (localStorage.getItem("zh:sb-hidden") === "1") { document.body.classList.add("sb-hidden"); $("sidebar").classList.add("hidden"); }
(() => {
  const saved = Number(localStorage.getItem("zh:sb-width"));
 // 窄窗(≤860px)走媒体查询的图标条模式:用户保存的宽度是内联样式会压过媒体查询,这里让位。
  const sbwApply = () => {
    if (window.innerWidth <= 860) document.documentElement.style.removeProperty("--sbw");
    else if (saved >= 200 && saved <= 420) document.documentElement.style.setProperty("--sbw", saved + "px");
  };
  sbwApply();
  window.addEventListener("resize", sbwApply);
  let dragging = false;
  const sbMax = () => Math.max(264, Math.round(window.innerWidth * 0.5)); // ZCode: 上限=容器 50%,下限 264
  $("sbDrag").addEventListener("pointerdown", (e) => { dragging = true; document.body.classList.add("sb-resizing"); e.preventDefault(); });
  window.addEventListener("pointermove", (e) => {
    if (!dragging) return;
 // 拖拽中只写 CSS 变量(ZCode: 不触发重排;pointerup 才持久化)
    const w = Math.min(sbMax(), Math.max(264, e.clientX));
    document.documentElement.style.setProperty("--sbw", w + "px");
  });
  window.addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("sb-resizing");
    localStorage.setItem("zh:sb-width", String(parseInt(getComputedStyle(document.documentElement).getPropertyValue("--sbw")) || 264));
  });
 // 键盘调宽(ZCode: Arrow ±16,Home=下限,End=上限;每次持久化)
  const d = $("sbDrag");
  d.tabIndex = 0;
  d.setAttribute("role", "separator");
  d.setAttribute("aria-label", "侧栏宽度");
  d.addEventListener("keydown", (e) => {
    const cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--sbw")) || 264;
    let w = null;
    if (e.key === "ArrowLeft") w = cur - 16;
    else if (e.key === "ArrowRight") w = cur + 16;
    else if (e.key === "Home") w = 264;
    else if (e.key === "End") w = sbMax();
    if (w === null) return;
    e.preventDefault();
    w = Math.min(sbMax(), Math.max(264, w));
    document.documentElement.style.setProperty("--sbw", w + "px");
    localStorage.setItem("zh:sb-width", String(w));
  });
})();
// 桶/分区拖拽排序机构(ZCode workspaceSidebarDrag 剪裁:vertical-only、ghost 宽度锁定、只位移不缩放)
let sbDrag2 = null; // {kind:"bucket"|"sec", id, ghost, head, tgt, before}
function startSidebarDrag(kind, id, head, e) {
  const r = head.getBoundingClientRect();
  const ghost = document.createElement("div");
  ghost.id = "sbDragGhost";
  const lab = head.querySelector(".bh-label");
  ghost.textContent = lab ? lab.textContent : "";
  ghost.style.left = r.left + "px";
  ghost.style.width = r.width + "px";
  ghost.style.top = e.clientY - 13 + "px";
  document.body.appendChild(ghost);
  head.classList.add("dragging");
  if (kind === "bucket") { // 拖拽中活动桶强制收起(ZCode resolveWorkspaceDragExpanded):只藏本桶行,不动后续桶
    let s2 = head.nextElementSibling;
    while (s2 && !s2.classList.contains("t-bh")) {
      if (s2.classList.contains("t-row") || s2.classList.contains("t-more")) s2.classList.add("dragging-hide");
      s2 = s2.nextElementSibling;
    }
  }
  sbDrag2 = { kind, id, ghost, head, tgt: null, before: false };
}
window.addEventListener("pointermove", (e) => {
  if (!sbDrag2) return;
  sbDrag2.ghost.style.top = e.clientY - 13 + "px";
  const sel = sbDrag2.kind === "sec" ? ".sb-sec" : ".t-bh[data-pid]";
  const heads = [...document.querySelectorAll("#taskList " + sel)].filter((h2) => h2 !== sbDrag2.head);
  for (const h2 of heads) h2.classList.remove("drop-before", "drop-after");
  sbDrag2.tgt = null;
  for (const h2 of heads) {
    const r2 = h2.getBoundingClientRect();
    if (e.clientY >= r2.top - 4 && e.clientY <= r2.bottom + 4) {
      sbDrag2.before = e.clientY < r2.top + r2.height / 2;
      h2.classList.add(sbDrag2.before ? "drop-before" : "drop-after");
      sbDrag2.tgt = h2;
      break;
    }
  }
});
window.addEventListener("pointerup", () => {
  if (!sbDrag2) return;
  const d2 = sbDrag2;
  sbDrag2 = null;
  if (d2.ghost) d2.ghost.remove();
  d2.head.classList.remove("dragging");
  for (const h2 of document.querySelectorAll("#taskList .dragging-hide")) h2.classList.remove("dragging-hide");
  for (const h2 of document.querySelectorAll("#taskList .drop-before, #taskList .drop-after")) h2.classList.remove("drop-before", "drop-after");
  if (d2.tgt) {
    if (d2.kind === "bucket") {
      const ids = [...document.querySelectorAll("#taskList .t-bh[data-pid]")].map((h2) => h2.dataset.pid).filter(Boolean);
      const from = ids.indexOf(d2.id), to = ids.indexOf(d2.tgt.dataset.pid);
      if (from >= 0 && to >= 0 && from !== to) {
        ids.splice(to, 0, ids.splice(from, 1)[0]);
        projectOrder = ids.concat(projectOrder.filter((x) => !ids.includes(x)));
        persistProjectOrder();
      }
    } else {
      const tid = d2.tgt.dataset.sec;
      if (tid && tid !== d2.id) {
        const rest = purpose.order.filter((x) => x !== d2.id);
        const at = rest.indexOf(tid);
        rest.splice(d2.before ? at : at + 1, 0, d2.id);
        purpose.order = rest;
        persistPurpose();
      }
    }
    renderSidebar();
  }
});
// 桶头分区把手挂拖拽(project 桶在 renderSidebar 内挂;purpose 分区头在此挂一次)
function wireSecGrips() {
  for (const g of document.querySelectorAll("#taskList .sb-sec .bh-grip")) {
    if (g.dataset.wired) continue;
    g.dataset.wired = "1";
    g.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      startSidebarDrag("sec", g.closest(".sb-sec").dataset.sec, g.closest(".sb-sec"), e);
    });
  }
}
// 全部展开/收起(ZCode collapse-all:全开→一键收起;有收起→一键展开)
$("tt-fold").onclick = () => {
  const keys = lastBucketKeys;
  if (!keys.length) return;
  const allOpen = keys.every((k) => !bucketCollapsed.has(k));
  for (const k of keys) { if (allOpen) bucketCollapsed.add(k); else bucketCollapsed.delete(k); }
  localStorage.setItem("zh:bucket-collapse", JSON.stringify([...bucketCollapsed]));
  renderSidebar();
};
$("taskList").addEventListener("scroll", applyTaskMask, { passive: true });
// ---- 侧栏文件树滑入层(ZCode WorkspaceFileTree 深拷贝 ----
// 桶头「文件树」→ project.activate(fvOpen 沙箱=激活项目根)→ 树层自右滑入;目录懒加载走 fs.list/dirCache;
// 文件点击 fvOpen 预览、右键 filesMenu;Esc/返回关闭;刷新清该根缓存。
let sbFt = null; // {pid,label,path,expanded:Set<abs>}
function sbFtNorm(p) { let s = String(p || ""); while (s.endsWith("/")) s = s.slice(0, -1); return s; }
function sbFtRel(abs) { const prefix = sbFt.path + "/"; return abs.startsWith(prefix) ? abs.slice(prefix.length) : abs; }
function sbFtOpen(pid) {
  const p = projectById(pid);
  if (!p || !p.path) { toast("该项目无可用目录"); return; }
  sbFt = { pid, label: p.label || pid, path: sbFtNorm(p.path), expanded: new Set([sbFtNorm(p.path)]) };
  wsSafeSend(JSON.stringify({ v: 1, type: "project.activate", projectId: pid }));
  $("sbFtTitle").textContent = sbFt.label + " · 文件树";
  $("sidebar").classList.add("ft-open");
  renderSbFt();
}
function sbFtClose() { sbFt = null; $("sidebar").classList.remove("ft-open"); }
function renderSbFt() {
  if (!sbFt) return;
  const rows = [];
  const walk = (abs, depth) => {
    const entries = dirCache.get(abs);
    if (!entries) {
      rows.push('<div class="ft-row" style="padding-left:' + (10 + depth * 14) + 'px"><span class="ic">…</span><span class="nm">加载中</span></div>');
      if (!filesPending.has(abs)) { filesPending.add(abs); wsSafeSend(JSON.stringify({ v: 1, type: "fs.list", path: abs, showHidden: true })); }
      return;
    }
    const indent = "padding-left:" + (10 + depth * 14) + "px";
    for (const en of entries) {
      const childAbs = abs + "/" + en.name;
      if (en.kind === "dir") {
        const open = sbFt.expanded.has(childAbs);
        rows.push('<div class="ft-row dir" data-abs="' + esc(childAbs) + '" style="' + indent + '"><span class="chev">' + (open ? ic("chev-down") : ic("chev-right")) + '</span><span class="ic">' + ic("folder") + '</span><span class="nm">' + esc(en.name) + "</span></div>");
        if (open) walk(childAbs, depth + 1);
      } else {
        rows.push('<div class="ft-row file" data-abs="' + esc(childAbs) + '" style="' + indent + '"><span class="chev"></span><span class="ic">' + ic("file") + '</span><span class="nm">' + esc(en.name) + "</span></div>");
      }
    }
  };
  walk(sbFt.path, 0);
  const tree = $("sbFtTree");
  tree.innerHTML = rows.join("") || '<div class="cc-empty">(空目录)</div>';
  for (const el of tree.querySelectorAll(".ft-row.dir")) {
    el.onclick = () => { const a = el.dataset.abs; if (sbFt.expanded.has(a)) sbFt.expanded.delete(a); else sbFt.expanded.add(a); renderSbFt(); };
    el.oncontextmenu = (e) => { e.preventDefault(); filesMenu(el.dataset.abs, sbFtRel(el.dataset.abs), true, e.clientX, e.clientY); };
  }
  for (const el of tree.querySelectorAll(".ft-row.file")) {
    el.onclick = () => fvOpen(sbFtRel(el.dataset.abs), 1); // file.read 沙箱=激活项目根(打开树时已激活)
    el.oncontextmenu = (e) => { e.preventDefault(); filesMenu(el.dataset.abs, sbFtRel(el.dataset.abs), false, e.clientX, e.clientY); };
  }
}
$("sbFtBack").onclick = sbFtClose;
$("sbFtRefresh").onclick = () => { if (sbFt) { invalidateTreeCache(sbFt.path); renderSbFt(); } };
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && sbFt) sbFtClose(); });`;
