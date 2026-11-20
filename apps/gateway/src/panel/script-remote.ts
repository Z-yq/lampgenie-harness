/**
 * 面板主脚本分片:远程控制 Remote + Bot Channels。
 * 对应左栏 act-nodes(内部视图 id 仍是 nodes)：
 * - 左卡:一次性配对二维码(remote.control.*),状态轮询/复制链接/停止/重启;
 * - 右卡:微信/飞书/Lark/Telegram 四个 Bot Channel + 机器人管理弹窗
 * (bots.list/upsert/remove/test/weixin.begin/poll)。
 * 模板约束沿袭:不得出现反引号与 ${;动态文本一律 esc。
 */
export const PANEL_JS_REMOTE = `
// ==================== 远程控制 Remote + Bot Channels ====================
var RC_PROVIDERS = [
  { id: "weixin", title: "微信" },
  { id: "feishu", title: "飞书", region: "中国" },
  { id: "lark", title: "Lark", region: "全球" },
  { id: "telegram", title: "Telegram" }
];
var rcStatus = null, rcStarted = false, rcUserStopped = false, rcPollTimer = 0, rcQrRendered = "";
var rcb = { open: false, provider: "weixin", bots: [], channels: [], selected: "", mode: "empty", wx: null, wxTimer: 0, msg: "", msgOk: false, busy: false };

function rcProvider(id) {
  for (var i = 0; i < RC_PROVIDERS.length; i++) if (RC_PROVIDERS[i].id === id) return RC_PROVIDERS[i];
  return { id: id, title: id };
}
function rcStateOfBot(b) {
  if (!b || !b.enabled) return false;
  if (b.provider === "telegram" || b.provider === "weixin") return !!(b.secrets && b.secrets.token);
  return !!(b.appId && b.secrets && b.secrets.appSecret && b.secrets.verification);
}
function rcRenderBotCards(channels) {
  if (!Array.isArray(channels)) return;
  for (var i = 0; i < channels.length; i++) {
    var c = channels[i];
    var el = document.querySelector('[data-rcbotstate="' + c.id + '"]');
    if (!el) continue;
    el.textContent = c.configured ? "已接入" : (c.bots > 0 ? (c.detail === "已停用" ? "已停用" : "待配置") : "未接入");
    el.classList.toggle("ok", !!c.configured);
    el.title = c.detail || "";
  }
}
function rcRender() {
  var m = rcStatus || { state: "idle", clients: 0 };
  var state = m.state || "idle";
  var label = $("rcStateLabel"), tag = $("rcStateTag"), detail = $("rcDetail"), toggle = $("rcToggle"), copy = $("rcCopy"), qr = $("rcQrBox"), warn = $("rcWarn");
  if (!label) return;
  if (state === "connected") {
    label.textContent = "手机已连接";
    tag.textContent = "在线"; tag.className = "rc-tag live";
    detail.textContent = "手机正在远程控制当前工作区(" + (m.clients || 1) + " 台在线)。关闭手机页面后回到等待状态。";
    toggle.textContent = "停止"; toggle.className = "rc-btn rc-toggle";
  } else if (state === "waiting") {
    label.textContent = "等待手机连接";
    tag.textContent = "已就绪"; tag.className = "rc-tag wait";
    detail.textContent = "用手机相机扫码,或在手机上打开链接。配对链接 " + (m.expiresAt ? "将在 " + new Date(m.expiresAt).toLocaleTimeString() + " 过期" : "有效") + "。";
    toggle.textContent = "停止"; toggle.className = "rc-btn rc-toggle";
  } else {
    label.textContent = "未启动";
    tag.textContent = m.expired ? "已过期" : "已停止"; tag.className = "rc-tag";
    detail.textContent = m.expired ? "配对已过期,点击启动生成新的二维码。" : "点击启动生成一次性配对二维码。";
    toggle.textContent = "启动"; toggle.className = "rc-btn pri rc-toggle";
  }
  copy.disabled = !m.connectUrl;
  if (m.qrSvg && state !== "idle") {
 // 只在二维码内容变化时重建 DOM(2s 轮询不回写同一份 SVG,避免闪烁)
    if (m.qrSvg !== rcQrRendered) { qr.innerHTML = m.qrSvg; rcQrRendered = m.qrSvg; }
  } else if (rcQrRendered !== "") {
    qr.innerHTML = '<div class="rc-qr-empty"><span>二维码</span><b>启动后显示</b></div>';
    rcQrRendered = "";
  }
  if (m.warning) { warn.hidden = false; warn.textContent = m.warning; }
  else { warn.hidden = true; warn.textContent = ""; }
  rcRenderBotCards(m.botChannels || []);
}
function rcPollStart() {
  if (rcPollTimer) return;
  rcPollTimer = setInterval(function () {
    if (viewLive("nodes")) wsSafeSend(JSON.stringify({ v: 1, type: "remote.control.status" }));
  }, 2000);
}
function rcPollStop() {
  if (rcPollTimer) { clearInterval(rcPollTimer); rcPollTimer = 0; }
}
function rcEnsure() {
  rcPollStart();
  if (!rcStarted && !rcUserStopped) {
    rcStarted = true;
    wsSafeSend(JSON.stringify({ v: 1, type: "remote.control.start" }));
    return;
  }
  wsSafeSend(JSON.stringify({ v: 1, type: "remote.control.status" }));
}
function rcCopyText(text, okText) {
  if (!text) return;
  var done = function () { toast(okText || "已复制"); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function () { rcCopyFallback(text, done); });
  } else {
    rcCopyFallback(text, done);
  }
}
function rcCopyFallback(text, done) {
  try {
    var ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
    done();
  } catch (e) { toast("复制失败,请手动选择链接", true); }
}
document.getElementById("nodes-body").addEventListener("click", function (e) {
  var t = e.target;
  if (!t || !t.closest) return;
  if (t.closest("#rcToggle")) {
    var st = rcStatus || { state: "idle" };
    if (st.state === "idle") {
      rcUserStopped = false; rcStarted = true;
      wsSafeSend(JSON.stringify({ v: 1, type: "remote.control.start" }));
    } else {
      rcUserStopped = true;
      wsSafeSend(JSON.stringify({ v: 1, type: "remote.control.stop" }));
    }
    return;
  }
  if (t.closest("#rcCopy")) {
    rcCopyText((rcStatus || {}).connectUrl, "配对链接已复制");
    return;
  }
  var botBtn = t.closest("[data-rcbot]");
  if (botBtn) { rcbOpen(botBtn.getAttribute("data-rcbot")); return; }
  if (t.closest("#rcBotsManage")) { rcbOpen(rcb.provider || "weixin"); return; }
});
$("nodes-refresh").onclick = function () {
  wsSafeSend(JSON.stringify({ v: 1, type: "remote.control.status" }));
  wsSafeSend(JSON.stringify({ v: 1, type: "bots.list" }));
};

// ---- 机器人管理弹窗 ----
function rcbOpen(provider) {
  rcb.open = true;
  rcb.provider = provider || "weixin";
  rcb.selected = ""; rcb.mode = "empty"; rcb.msg = ""; rcb.msgOk = false;
  rcb.wx = null;
  if (rcb.wxTimer) { clearInterval(rcb.wxTimer); rcb.wxTimer = 0; }
  $("rcBotsMask").hidden = false;
  wsSafeSend(JSON.stringify({ v: 1, type: "bots.list" }));
  rcbRender();
}
function rcbClose() {
  rcb.open = false;
  rcb.wx = null;
  if (rcb.wxTimer) { clearInterval(rcb.wxTimer); rcb.wxTimer = 0; }
  $("rcBotsMask").hidden = true;
}
function rcbBotsOfProvider() {
  return (rcb.bots || []).filter(function (b) { return b.provider === rcb.provider; });
}
function rcbSelectedBot() {
  for (var i = 0; i < (rcb.bots || []).length; i++) if (rcb.bots[i].id === rcb.selected) return rcb.bots[i];
  return null;
}
function rcbRender() {
  if (!rcb.open) return;
  rcbRenderTabs();
  rcbRenderList();
  rcbRenderForm();
}
function rcbRenderTabs() {
  var host = $("rcbTabs");
  if (!host) return;
  var html = "";
  for (var i = 0; i < RC_PROVIDERS.length; i++) {
    var p = RC_PROVIDERS[i];
    var ch = null;
    for (var j = 0; j < (rcb.channels || []).length; j++) if (rcb.channels[j].id === p.id) ch = rcb.channels[j];
    var state = ch ? (ch.configured ? "· 已接入" : (ch.bots > 0 ? "· 待配置" : "")) : "";
    html += '<button class="rcb-tab' + (rcb.provider === p.id ? " on" : "") + '" data-rcbtab="' + p.id + '">' + esc(p.title) + (p.region ? ' <span class="rc-bot-region">' + esc(p.region) + "</span>" : "") + '<span style="color:var(--faint);font-size:10px"> ' + esc(state) + "</span></button>";
  }
  host.innerHTML = html;
}
function rcbRenderList() {
  var host = $("rcbList");
  if (!host) return;
  var bots = rcbBotsOfProvider();
  if (!bots.length) {
    host.innerHTML = '<div class="cc-empty" style="padding:14px 8px">该渠道还没有机器人。</div>';
    return;
  }
  var html = "";
  for (var i = 0; i < bots.length; i++) {
    var b = bots[i];
    var ready = rcStateOfBot(b);
    html += '<div class="rcb-item' + (rcb.selected === b.id ? " on" : "") + '" data-rcbbot="' + esc(b.id) + '">' +
      '<span class="n"><span class="st' + (ready ? " on" : "") + '"></span>' + esc(b.name) + "</span>" +
      '<span class="m"><span>' + (b.enabled ? "启用" : "停用") + "</span><span>" + (ready ? "就绪" : (b.lastError ? "错误" : "待配置")) + "</span></span>" +
      "</div>";
  }
  host.innerHTML = html;
}
function rcbRow(label, control, hint) {
  return '<div class="rcb-row"><label>' + esc(label) + "</label>" + control + "</div>" + (hint ? '<div class="rcb-hint">' + esc(hint) + "</div>" : "");
}
function rcbInput(id, type, placeholder, value) {
  return '<input id="' + id + '" type="' + type + '" placeholder="' + esc(placeholder || "") + '" value="' + esc(value || "") + '" autocomplete="off" spellcheck="false">';
}
function rcbProjectSelect(pid) {
  var out = '<select id="rcbF-project"><option value="">跟随当前项目</option>';
  for (var i = 0; i < (typeof projects !== "undefined" ? projects.length : 0); i++) {
    var p = projects[i];
    out += '<option value="' + esc(p.id) + '"' + (p.id === pid ? " selected" : "") + ">" + esc(p.label || p.id) + "</option>";
  }
  return out + "</select>";
}
function rcbRenderForm() {
  var host = $("rcbForm");
  if (!host) return;
  var meta = rcProvider(rcb.provider);
  var bot = rcbSelectedBot();
  var html = '<div style="font-family:var(--serif);font-size:14px;color:var(--brand);letter-spacing:1px;margin-bottom:6px">' + esc(meta.title) + " Bot</div>";
  html += '<div class="rcb-hint">' + (rcb.provider === "weixin" ? "微信走 iLink 扫码接入;扫码成功后 bot_token 只写入本机 secrets.json。" :
    rcb.provider === "telegram" ? "在 @BotFather 创建机器人拿 Bot Token;长轮询,无需公网回调。" :
      "飞书/Lark 开放平台创建应用,事件订阅指向下方 Webhook;Verification Token 必填(安全校验)。") + "</div>";
  if (rcb.mode === "empty") {
    html += '<div class="rcb-empty cc-empty">' + (rcb.provider === "weixin"
      ? "点下方「扫码接入微信」用手机微信扫码,机器人会自动落库。"
      : "点左下角「新建机器人」填写凭证。") + "</div>";
    html += '<div class="rcb-actions"><button class="rc-btn pri" data-rcbact="new">' + (rcb.provider === "weixin" ? "扫码接入微信" : "新建机器人") + "</button></div>";
    host.innerHTML = html;
    return;
  }
  if (rcb.msg) html += '<div class="rcb-status ' + (rcb.msgOk ? "ok" : "bad") + '">' + esc(rcb.msg) + "</div>";
  if (rcb.provider === "weixin" && rcb.mode === "new") {
    html += rcbWxQrHtml();
    html += '<div class="rcb-actions"><button class="rc-btn pri" data-rcbact="wxbegin">' + (rcb.wx ? "重新生成二维码" : "扫码接入微信") + "</button>" +
      (rcb.wx && rcb.wx.status === "scanned" ? '<span class="rcb-status ok" style="margin:0">已扫码,请在手机上确认</span>' : "") + "</div>";
    host.innerHTML = html;
    return;
  }
  var name = bot ? bot.name : (meta.title + "机器人");
  html += rcbRow("机器人名称", rcbInput("rcbF-name", "text", "例如 我的飞书机器人", name));
  html += rcbRow("默认项目", rcbProjectSelect(bot ? bot.projectId : ""));
  html += rcbRow("允许用户 id", rcbInput("rcbF-allow", "text", "逗号分隔;留空=任何人可对话(不推荐)", bot && bot.allowUserIds ? bot.allowUserIds.join(",") : ""), "平台用户 id(飞书 open_id / Telegram user id / 微信 wxid);留空时任何能发消息的人都能驱动 agent。");
  html += '<div class="rcb-row"><label>状态</label><select id="rcbF-enabled"><option value="1"' + (!bot || bot.enabled ? " selected" : "") + '>启用</option><option value="0"' + (bot && !bot.enabled ? " selected" : "") + ">停用</option></select></div>";
  if (rcb.provider === "weixin") {
    html += rcbWxQrHtml();
    if (bot) {
      html += '<div class="rcb-hint">凭证:' + (bot.secrets && bot.secrets.token ? "已配置 bot token" : "未配置") + (bot.providerUserId ? " · 自身 id " + esc(bot.providerUserId) : "") + "</div>";
      html += '<div class="rcb-actions"><button class="rc-btn pri" data-rcbact="wxbegin">重新扫码接入</button></div>';
    }
  } else if (rcb.provider === "telegram") {
    html += rcbRow("Bot Token", rcbInput("rcbF-token", "password", bot && bot.secrets && bot.secrets.token ? "已配置(••••,留空不修改)" : "123456:ABC…"), "只写入 .genie/secrets.json,永不回显。");
    if (bot && bot.username) html += '<div class="rcb-hint">当前机器人:' + esc(bot.username) + "</div>";
  } else {
    html += rcbRow("App ID", rcbInput("rcbF-appid", "text", "cli_xxx", bot ? bot.appId : ""));
    html += rcbRow("App Secret", rcbInput("rcbF-appsecret", "password", bot && bot.secrets && bot.secrets.appSecret ? "已配置(••••,留空不修改)" : "应用 App Secret"));
    html += rcbRow("Verification Token", rcbInput("rcbF-verify", "password", bot && bot.secrets && bot.secrets.verification ? "已配置(••••,留空不修改)" : "事件订阅 Verification Token"));
    html += rcbRow("Encrypt Key(可选)", rcbInput("rcbF-encrypt", "password", bot && bot.secrets && bot.secrets.encrypt ? "已配置(••••,留空不修改)" : "事件加密 Key"));
    html += rcbRow("Bot Open ID(可选)", rcbInput("rcbF-openid", "text", "ou_xxx", bot ? bot.botOpenId : ""));
    if (bot && bot.webhookUrl) {
      html += '<div class="rcb-row"><label>Webhook</label><input id="rcbF-hook" type="text" readonly value="' + esc(bot.webhookUrl) + '"><button class="rc-btn" data-rcbact="copyhook">复制</button></div>' +
        '<div class="rcb-hint">把该地址填到飞书/Lark 开放平台「事件订阅」回调地址;需公网可达(或用隧道转发到本机 ' + esc(String(bot.webhookUrl).split("/webhook/")[0]) + ")。</div>";
    }
  }
  if (bot && bot.lastError) html += '<div class="rcb-status bad">最近错误:' + esc(bot.lastError) + "</div>";
  html += '<div class="rcb-actions">';
  html += '<button class="rc-btn pri" data-rcbact="save"' + (rcb.busy ? " disabled" : "") + ">保存</button>";
  if (bot) {
    html += '<button class="rc-btn" data-rcbact="test"' + (rcb.busy ? " disabled" : "") + ">测试</button>";
    html += '<button class="rc-btn rcb-danger" data-rcbact="delete"' + (rcb.busy ? " disabled" : "") + ">删除</button>";
  }
  html += '<button class="rc-btn" data-rcbact="cancel">取消</button></div>';
  host.innerHTML = html;
}
function rcbWxQrHtml() {
  if (!rcb.wx) return "";
  if (rcb.wx.status === "loading") return '<div class="rcb-wxqr"><div class="cc-empty loading">正在生成微信二维码…</div></div>';
  if (rcb.wx.status === "error") return '<div class="rcb-wxqr"><div class="rcb-status bad" style="margin:0">' + esc(rcb.wx.error || "生成失败") + "</div></div>";
  if (rcb.wx.status === "expired") return '<div class="rcb-wxqr"><div class="rcb-status bad" style="margin:0">二维码已过期,请重新生成。</div></div>';
  var qr = rcb.wx.qrSvg ? rcb.wx.qrSvg : (rcb.wx.qrImageUrl ? '<img src="' + esc(rcb.wx.qrImageUrl) + '" alt="微信登录二维码">' : "");
  var state = rcb.wx.status === "scanned" ? "已扫码,请在手机上确认" : "等待扫码";
  return '<div class="rcb-wxqr">' + qr + '<div class="rcb-hint" style="margin:6px 0 0">' + esc(state) + "</div></div>";
}
function rcbCollect() {
  var out = {
    v: 1,
    type: "bots.upsert",
    provider: rcb.provider,
    name: (($("rcbF-name") || {}).value || "").trim(),
    enabled: (($("rcbF-enabled") || {}).value || "1") === "1"
  };
  if (rcb.selected) out.id = rcb.selected;
  var proj = $("rcbF-project"); if (proj && proj.value) out.projectId = proj.value;
  var allow = $("rcbF-allow");
  if (allow && allow.value.trim()) out.allowUserIds = allow.value.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  var tok = $("rcbF-token"); if (tok && tok.value.trim()) out.token = tok.value.trim();
  var appid = $("rcbF-appid"); if (appid && appid.value.trim()) out.appId = appid.value.trim();
  var appsec = $("rcbF-appsecret"); if (appsec && appsec.value.trim()) out.appSecret = appsec.value.trim();
  var verify = $("rcbF-verify"); if (verify && verify.value.trim()) out.verificationToken = verify.value.trim();
  var enc = $("rcbF-encrypt"); if (enc && enc.value.trim()) out.encryptKey = enc.value.trim();
  var oid = $("rcbF-openid"); if (oid && oid.value.trim()) out.botOpenId = oid.value.trim();
  return out;
}
function rcbSetMsg(text, ok) {
  rcb.msg = text || ""; rcb.msgOk = !!ok;
  var status = document.querySelector("#rcbForm .rcb-status");
  if (status && rcb.msg) { status.textContent = rcb.msg; status.className = "rcb-status " + (ok ? "ok" : "bad"); }
  else rcbRenderForm();
}
/** 保存/测试/删除进行中:只插一条状态并禁用按钮,不重渲表单(否则用户刚填的凭证会被清空)。 */
function rcbSetBusy(text) {
  rcb.busy = true;
  var host = $("rcbForm");
  if (!host) return;
  var status = host.querySelector(".rcb-status");
  if (!status) {
    status = document.createElement("div");
    status.className = "rcb-status";
    var actions = host.querySelector(".rcb-actions");
    if (actions && actions.parentNode === host) host.insertBefore(status, actions);
    else host.appendChild(status);
  }
  status.className = "rcb-status";
  status.textContent = text;
  host.querySelectorAll("[data-rcbact]").forEach(function (b) { b.disabled = true; });
}
function rcbClearBusy() {
  rcb.busy = false;
  var host = $("rcbForm");
  if (host) host.querySelectorAll("[data-rcbact]").forEach(function (b) { b.disabled = false; });
}
function rcbStartWxPoll(interval) {
  if (rcb.wxTimer) clearInterval(rcb.wxTimer);
  rcb.wxTimer = setInterval(function () {
    if (!rcb.open || !rcb.wx || !rcb.wx.qrCode) { clearInterval(rcb.wxTimer); rcb.wxTimer = 0; return; }
    wsSafeSend(JSON.stringify({ v: 1, type: "bots.weixin.poll", qrCode: rcb.wx.qrCode }));
  }, Math.max(2000, (interval || 3) * 1000));
}
document.getElementById("rcBotsMask").addEventListener("click", function (e) {
  if (e.target && e.target.id === "rcBotsMask") rcbClose();
});
$("rcbClose").onclick = rcbClose;
$("rcbNew").onclick = function () {
  if (rcb.provider === "weixin") {
    rcb.mode = "new"; rcb.selected = ""; rcb.wx = null; rcb.msg = ""; rcbRender();
    wsSafeSend(JSON.stringify({ v: 1, type: "bots.weixin.begin" }));
    rcb.wx = { status: "loading" }; rcbRender();
  } else {
    rcb.mode = "new"; rcb.selected = ""; rcb.msg = ""; rcbRender();
  }
};
document.getElementById("rcbTabs").addEventListener("click", function (e) {
  var t = e.target && e.target.closest ? e.target.closest("[data-rcbtab]") : null;
  if (!t) return;
  rcb.provider = t.getAttribute("data-rcbtab");
  rcb.selected = ""; rcb.mode = "empty"; rcb.msg = ""; rcb.wx = null;
  rcbRender();
});
document.getElementById("rcbList").addEventListener("click", function (e) {
  var t = e.target && e.target.closest ? e.target.closest("[data-rcbbot]") : null;
  if (!t) return;
  rcb.selected = t.getAttribute("data-rcbbot");
  rcb.mode = "edit"; rcb.msg = "";
  rcbRender();
});
document.getElementById("rcbForm").addEventListener("click", function (e) {
  var t = e.target && e.target.closest ? e.target.closest("[data-rcbact]") : null;
  if (!t) return;
  var act = t.getAttribute("data-rcbact");
  if (act === "new") { $("rcbNew").click(); return; }
  if (act === "cancel") { rcb.selected = ""; rcb.mode = "empty"; rcb.msg = ""; rcbRender(); return; }
  if (act === "wxbegin") {
    rcb.wx = { status: "loading" }; rcbRender();
    wsSafeSend(JSON.stringify({ v: 1, type: "bots.weixin.begin" }));
    return;
  }
  if (act === "copyhook") {
    var hook = $("rcbF-hook");
    if (hook) rcCopyText(hook.value, "Webhook 地址已复制");
    return;
  }
  if (act === "delete") {
    if (!rcb.selected) return;
    if (!confirm("删除这个机器人?凭证键会保留在 secrets.json(平台侧仍可继续使用)。")) return;
    rcbSetBusy("删除中…");
    wsSafeSend(JSON.stringify({ v: 1, type: "bots.remove", id: rcb.selected }));
    return;
  }
  if (act === "test") {
    if (!rcb.selected) return;
    rcbSetBusy("测试中…");
    wsSafeSend(JSON.stringify({ v: 1, type: "bots.test", id: rcb.selected }));
    return;
  }
  if (act === "save") {
    var body = rcbCollect();
    if (!body.name) { rcbSetMsg("机器人名称不能为空", false); return; }
    rcbSetBusy("保存中…");
    wsSafeSend(JSON.stringify(body));
    return;
  }
});
function rcbOnList(m) {
  rcb.bots = Array.isArray(m.bots) ? m.bots : [];
  rcb.channels = Array.isArray(m.channels) ? m.channels : [];
  rcRenderBotCards(rcb.channels);
  var still = false;
  for (var i = 0; i < rcb.bots.length; i++) if (rcb.bots[i].id === rcb.selected) still = true;
  if (!still && rcb.selected) { rcb.selected = ""; rcb.mode = "empty"; }
  if (rcb.mode === "edit" && rcb.selected) { /* 保持 */ }
  rcbRender();
}
function rcbOnUpsert(m) {
  rcb.busy = false;
  if (m && m.ok) {
    rcb.selected = m.bot ? m.bot.id : rcb.selected;
    rcb.mode = "edit";
    rcb.msg = "已保存。"; rcb.msgOk = true;
    toast("机器人已保存");
    wsSafeSend(JSON.stringify({ v: 1, type: "bots.list" }));
    wsSafeSend(JSON.stringify({ v: 1, type: "remote.control.status" }));
  } else {
    rcb.busy = false;
    rcbSetMsg((m && m.error) || "保存失败", false);
    rcbClearBusy();
  }
}
function rcbOnRemove(m) {
  rcb.busy = false;
  if (m && m.ok) {
    rcb.selected = ""; rcb.mode = "empty"; rcb.msg = "已删除。"; rcb.msgOk = true;
    toast("机器人已删除");
    wsSafeSend(JSON.stringify({ v: 1, type: "bots.list" }));
    wsSafeSend(JSON.stringify({ v: 1, type: "remote.control.status" }));
  } else {
    rcb.busy = false;
    rcbSetMsg((m && m.error) || "删除失败", false);
    rcbClearBusy();
  }
}
function rcbOnTest(m) {
  rcb.busy = false;
  rcb.msg = m && m.message ? String(m.message) : (m && m.ok ? "连接正常" : "测试失败");
  rcb.msgOk = !!(m && m.ok);
  if (m && m.username) rcb.msg += " · " + m.username;
  rcbSetMsg(rcb.msg, rcb.msgOk);
  rcbClearBusy();
  wsSafeSend(JSON.stringify({ v: 1, type: "bots.list" }));
}
function rcbOnWxBegin(m) {
  if (!m || !m.ok) {
    rcb.wx = { status: "error", error: (m && m.error) || "生成二维码失败" };
    rcbRenderForm();
    return;
  }
  rcb.wx = { status: "pending", qrCode: m.qrCode, qrSvg: m.qrSvg || "", qrImageUrl: m.qrImageUrl || "" };
  rcbRenderForm();
  rcbStartWxPoll(m.interval || 3);
}
function rcbOnWxPoll(m) {
  if (!rcb.wx) return;
  if (!m) return;
  if (m.status === "success") {
    if (rcb.wxTimer) { clearInterval(rcb.wxTimer); rcb.wxTimer = 0; }
    rcb.wx = null;
    rcb.busy = false;
    toast("微信机器人已接入");
    if (m.bot) { rcb.selected = m.bot.id; rcb.mode = "edit"; rcb.provider = "weixin"; }
    rcb.msg = "微信机器人已接入。"; rcb.msgOk = true;
    wsSafeSend(JSON.stringify({ v: 1, type: "bots.list" }));
    wsSafeSend(JSON.stringify({ v: 1, type: "remote.control.status" }));
    rcbRender();
    return;
  }
  if (m.status === "expired" || m.status === "error") {
    if (rcb.wxTimer) { clearInterval(rcb.wxTimer); rcb.wxTimer = 0; }
    rcb.wx = { status: m.status, error: m.error || "" };
    rcbRenderForm();
    return;
  }
  if (rcb.wx.status === m.status) return;
  rcb.wx.status = m.status;
 // 轮询只改状态行,不整表重渲(否则每 3s 重建二维码 SVG,出现闪烁)
  var hint = document.querySelector("#rcbForm .rcb-wxqr .rcb-hint");
  if (hint && (m.status === "pending" || m.status === "scanned")) {
    hint.textContent = m.status === "scanned" ? "已扫码,请在手机上确认" : "等待扫码";
    return;
  }
  rcbRenderForm();
}
/** WS 路由入口:返回 true=本分片已处理。 */
function rcHandleMessage(m) {
  if (!m || !m.type) return false;
  if (m.type === "remote.control.status.result") { rcStatus = m; rcRender(); return true; }
  if (m.type === "remote.control.changed") {
    if (viewLive("nodes")) wsSafeSend(JSON.stringify({ v: 1, type: "remote.control.status" }));
    if (rcb.open) wsSafeSend(JSON.stringify({ v: 1, type: "bots.list" }));
    return true;
  }
  if (m.type === "bots.list.result") {
    if (rcb.open) rcbOnList(m); else { rcRenderBotCards(m.channels); rcb.channels = m.channels || []; rcb.bots = m.bots || []; }
    return true;
  }
  if (m.type === "bots.upsert.result") { if (rcb.open) rcbOnUpsert(m); return true; }
  if (m.type === "bots.remove.result") { if (rcb.open) rcbOnRemove(m); return true; }
  if (m.type === "bots.test.result") { if (rcb.open) rcbOnTest(m); return true; }
  if (m.type === "bots.weixin.begin.result") { if (rcb.open) rcbOnWxBegin(m); return true; }
  if (m.type === "bots.weixin.poll.result") { if (rcb.open) rcbOnWxPoll(m); return true; }
  if (m.type === "bots.changed") {
    if (rcb.open) wsSafeSend(JSON.stringify({ v: 1, type: "bots.list" }));
    wsSafeSend(JSON.stringify({ v: 1, type: "remote.control.status" }));
    return true;
  }
  return false;
}
rcRender();
`;