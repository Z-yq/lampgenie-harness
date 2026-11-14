/**
 * 面板主脚本分片:script-admin(逐字自 panel.ts PAGE 模板搬移, 拆分)。
 * 模板约束沿袭:不得出现反引号与 ${;行内换行不得写裸转义。
 */
export const PANEL_JS_ADMIN = `let secretSeq = 0, secretWaiters = {};
// 本次页面会话内记住密钥末4位(仅用于 UI 掩码展示;不落盘、不回传完整值)
const secretLast4 = {};
function secretStatus(names) {
  return new Promise(function (resolve) {
    const rid = "ss" + (++secretSeq);
    secretWaiters[rid] = resolve;
    wsSafeSend(JSON.stringify({ v: 1, type: "cfg.secret.status", rid: rid, names: names || [] }));
    setTimeout(function () { if (secretWaiters[rid]) { delete secretWaiters[rid]; resolve({ ok: false, error: "状态查询超时" }); } }, 6000);
  });
}
function secretSet(name, value) {
  return new Promise(function (resolve) {
    const rid = "sw" + (++secretSeq);
    secretWaiters[rid] = resolve;
    wsSafeSend(JSON.stringify({ v: 1, type: "cfg.secret.set", rid: rid, name: name, value: value }));
    setTimeout(function () { if (secretWaiters[rid]) { delete secretWaiters[rid]; resolve({ ok: false, error: "写入超时" }); } }, 8000);
  });
}
function presetModeList(pp) {
  const out = [];
  if (pp.modes && pp.modes.api) out.push({ key: "api", label: "API 调用", mode: pp.modes.api });
  if (pp.modes && pp.modes["token-plan"]) out.push({ key: "token-plan", label: "Token 套餐", mode: pp.modes["token-plan"] });
  return out;
}
function presetPrimaryMode(pp) {
  const list = presetModeList(pp);
  return list.length ? list[0] : { key: "api", label: "API 调用", mode: { baseUrl: "", apiKeyEnv: "", models: [] } };
}
function presetModelName(mm) { return typeof mm === "string" ? mm : String((mm && mm.name) || ""); }
function parsePresetModels(text) {
  const out = [], seen = {};
  const raw = String(text || "").split(String.fromCharCode(10)).join(",").split(",");
  for (const p of raw) {
    const s = p.trim();
    if (!s || seen[s]) continue;
    seen[s] = 1; out.push(s);
  }
  return out;
}
function uniqueProviderId(base) {
  const b = String(base || "provider").replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "provider";
  let id = b, n = 2;
  while ((provDraft || []).some(function (p) { return p.id === id; })) { id = b + "-" + n; n++; }
  return id;
}
function presetDialog(pp) {
  return new Promise(function (resolve) {
    const mask = document.createElement("div");
    mask.className = "uid-mask";
    const modes = presetModeList(pp);
    const modeCards = modes.map(function (x) {
      return '<div class="pp-mode" data-mode="' + x.key + '">' +
        '<div class="pm-top"><span class="pm-radio"></span><span>' + esc(x.label) + '</span></div>' +
        '<div class="pm-url">' + esc(x.mode.baseUrl || "(手填)") + '</div>' +
        '<div class="pm-meta">' + ((x.mode.models || []).length) + ' 个预置模型' + (x.mode.apiType === "anthropic" ? ' · Anthropic 协议' : '') + '</div>' +
        (x.mode.note ? '<div class="pm-note">' + esc(x.mode.note) + '</div>' : '') +
        '</div>';
    }).join("") + (pp.planNote && !(pp.modes && pp.modes["token-plan"])
      ? '<div class="pp-mode disabled"><div class="pm-top"><span class="pm-radio"></span><span>Token 套餐</span></div><div class="pm-meta">无 Token 套餐</div><div class="pm-note">' + esc(pp.planNote) + '</div></div>'
      : "");
    const isCustom = !!pp.custom;
    const isLocal = !!pp.local;
    mask.innerHTML =
      '<div class="uid-box pp-box" role="dialog" aria-modal="true">' +
      '<div class="uid-kicker">服务商预设 · 一键接入</div>' +
      '<h3>' + esc(pp.name) + '</h3>' +
      '<div class="pp-sub">系统已预置端点与模型,只需填写 API Key。凭证只写入本机密钥文件,不显示、不上传、不进配置文件。</div>' +
      '<div class="pp-label">接入方式</div>' +
      '<div class="pp-modes" data-role="modes">' + modeCards + '</div>' +
      '<div class="pp-label">端点</div>' +
      '<div class="pp-url" data-role="url"></div>' +
      '<div class="pp-label" data-role="keylabel">API Key</div>' +
      '<input class="pp-key" type="password" data-role="key" autocomplete="new-password" spellcheck="false" placeholder="粘贴 API Key">' +
      '<div class="pp-hint" data-role="keyhint"></div>' +
      '<div class="pp-warn" data-role="warn"></div>' +
      '<details class="pp-adv" data-role="adv"' + (isCustom ? " open" : "") + '><summary>高级:自定义 baseUrl / 模型 / 协议</summary>' +
      '<div class="pp-adv-body">' +
      '<label class="wide">baseUrl<input data-role="advUrl" autocomplete="off" spellcheck="false"></label>' +
      '<label>Provider id<input data-role="advId" autocomplete="off" spellcheck="false"></label>' +
      '<label>显示名<input data-role="advName" autocomplete="off" spellcheck="false"></label>' +
      '<label>接口协议<select data-role="advType"><option value="chat">Chat(OpenAI 兼容,可执行)</option><option value="responses">Responses(仅记录)</option><option value="anthropic">Anthropic(仅记录)</option></select></label>' +
      '<label>凭证引用名<input data-role="advKeyEnv" autocomplete="off" spellcheck="false"></label>' +
      '<label class="wide">模型 ID(逗号或换行分隔)<textarea data-role="advModels" rows="3" spellcheck="false"></textarea></label>' +
      '</div></details>' +
      '<label class="pp-def"><input type="checkbox" data-role="setDefault" checked> 同时设为默认主模型(路由切换重启生效)</label>' +
      '<div class="pp-status" data-role="status"></div>' +
      '<div class="pp-foot"><button class="uid-cancel" data-role="cancel">取消</button><button class="uid-ok" data-role="ok">添加</button></div>' +
      '</div>';
    document.body.appendChild(mask);
    const q = function (role) { return mask.querySelector('[data-role="' + role + '"]'); };
    const elUrl = q("url"), elKey = q("key"), elKeyLabel = q("keylabel"), elHint = q("keyhint"), elWarn = q("warn"), elStatus = q("status");
    const elAdvUrl = q("advUrl"), elAdvId = q("advId"), elAdvName = q("advName"), elAdvType = q("advType"), elAdvKeyEnv = q("advKeyEnv"), elAdvModels = q("advModels");
    let active = presetPrimaryMode(pp);
    let keyExists = {};
    const keyEnvs = modes.map(function (x) { return x.mode.apiKeyEnv; }).filter(Boolean);
    if (isLocal) { elKey.style.display = "none"; elKeyLabel.style.display = "none"; elHint.textContent = "本地服务无需 API Key;填写 baseUrl 后从本机拉取模型。"; }
    if (isCustom) {
      elHint.textContent = "私有网关/未收录服务商:手填 baseUrl、Key 与模型;Key 可留空,稍后由环境变量提供。";
      elAdvId.value = uniqueProviderId("custom");
      elAdvName.value = pp.name;
    }
    const syncKeyHint = function () {
      const env = elAdvKeyEnv.value;
      elHint.textContent = isLocal ? "本地服务无需 API Key;填写 baseUrl 后从本机拉取模型。"
        : "将写入本机密钥名 " + (env || "(未命名)") + ";只保存在本地密钥文件,不回传、不进配置。";
      elWarn.className = "pp-warn" + (keyExists[env] ? " on" : "");
      elWarn.textContent = keyExists[env] ? "该密钥名已存在,继续将覆盖同名密钥。" : "";
      if (q("ok")) q("ok").textContent = keyExists[env] ? "覆盖并添加" : "添加";
    };
    const sync = function () {
      const md = active.mode || {};
      elUrl.textContent = md.baseUrl || "(在高级中手填 baseUrl)";
      elAdvUrl.value = md.baseUrl || "";
      elAdvType.value = md.apiType || "chat";
 // 主题化 select 镜像:程序化改值不触发 change,镜像按钮会停留在旧协议文案(经验证 Token 套餐仍显示 Chat)。
      try { if (typeof beautifySelect === "function") beautifySelect(elAdvType); elAdvType.dispatchEvent(new Event("change", { bubbles: true })); } catch (e) {}
      elAdvKeyEnv.value = md.apiKeyEnv || (isLocal ? "" : "CUSTOM_API_KEY");
      elAdvId.value = elAdvId.value || uniqueProviderId(pp.id + (active.key === "token-plan" ? "-plan" : ""));
      elAdvName.value = elAdvName.value || (pp.name + (active.key === "token-plan" ? " · Token 套餐" : ""));
      elAdvModels.value = (md.models || []).map(presetModelName).join(", ");
      elKeyLabel.textContent = active.key === "token-plan" ? "套餐 API Key" : "API Key";
      syncKeyHint();
      for (const c of mask.querySelectorAll(".pp-mode")) c.classList.toggle("on", c.dataset.mode === active.key);
      if (md.note) { elStatus.textContent = md.note; elStatus.className = "pp-status"; }
      else { elStatus.textContent = ""; elStatus.className = "pp-status"; }
    };
    for (const c of mask.querySelectorAll(".pp-mode[data-mode]")) {
      c.onclick = function () {
        const hit = modes.find(function (x) { return x.key === c.dataset.mode; });
        if (!hit) return;
        active = hit;
        elAdvId.value = ""; elAdvName.value = "";
        sync();
      };
    }
    elAdvKeyEnv.addEventListener("input", syncKeyHint);
    elAdvUrl.addEventListener("input", function () { elUrl.textContent = elAdvUrl.value || "(手填)"; });
    if (keyEnvs.length) {
      secretStatus(keyEnvs).then(function (r) {
        for (const it of (r.items || [])) keyExists[it.name] = !!it.exists;
        syncKeyHint();
      });
    }
    const done = function (v) { if (!mask.isConnected) return; mask.remove(); document.removeEventListener("keydown", onKey, true); resolve(v); };
    const onKey = function (e) { if (e.key === "Escape") { e.preventDefault(); done(null); } };
    document.addEventListener("keydown", onKey, true);
    q("cancel").onclick = function () { done(null); };
    mask.onclick = function (e) { if (e.target === mask) done(null); };
    q("ok").onclick = async function () {
      const key = elKey.value.trim();
      const baseUrl = elAdvUrl.value.trim();
      const keyEnv = elAdvKeyEnv.value.trim();
      const modelsText = elAdvModels.value.trim();
      const modelList = parsePresetModels(modelsText);
      if (!baseUrl) { elStatus.textContent = "baseUrl 不能为空"; elStatus.className = "pp-status bad"; return; }
      if (!isLocal && !isCustom && !key) { elStatus.textContent = "请填写 API Key"; elStatus.className = "pp-status bad"; return; }
      if (!isLocal && !isCustom && !keyEnv) { elStatus.textContent = "凭证引用名不能为空"; elStatus.className = "pp-status bad"; return; }
      if (!isLocal && !isCustom && !modelList.length) { elStatus.textContent = "至少保留一个预置模型"; elStatus.className = "pp-status bad"; return; }
      const modeModels = (active.mode.models || []);
      const models = modelList.map(function (name) {
        const src = modeModels.find(function (mm) { return presetModelName(mm) === name; });
        return src && typeof src === "object" ? Object.assign({}, src) : name;
      });
      const id = uniqueProviderId(elAdvId.value.trim() || pp.id);
      const name = elAdvName.value.trim() || pp.name;
      const apiType = elAdvType.value !== "chat" ? elAdvType.value : undefined;
      q("ok").disabled = true;
      if (key) {
        elStatus.textContent = "写入本机密钥…"; elStatus.className = "pp-status";
        const sr = await secretSet(keyEnv, key);
        if (!mask.isConnected) return; // 用户已在写入期间取消:密钥可留,但不再创建 Provider
        if (!sr || !sr.ok) {
          elStatus.textContent = "密钥写入失败:" + ((sr && sr.error) || "未知错误"); elStatus.className = "pp-status bad";
          q("ok").disabled = false;
          return;
        }
        if (key.length >= 4) secretLast4[keyEnv] = key.slice(-4);
      }
      const provider = { id: id, name: name, baseUrl: baseUrl };
      if (!isLocal && keyEnv) provider.apiKeyEnv = keyEnv;
      provider.authMode = active.key === "token-plan" ? "token-plan" : "api";
      if (apiType) provider.apiType = apiType;
      provider.models = models;
      if (!provDraft) provDraft = [];
      provDraft.push(provider);
      const patch = { providers: provDraft.slice() };
      if (q("setDefault").checked && models.length) {
        const first = models[0];
        const firstMeta = typeof first === "object" ? first : { name: first };
        patch.coding = { llm: { providerId: id, baseUrl: baseUrl, apiKeyEnv: keyEnv || "GENIE_LLM_API_KEY", model: firstMeta.name } };
        if (firstMeta.contextWindow) patch.coding.llm.contextWindow = firstMeta.contextWindow;
        if (firstMeta.maxTokens) patch.coding.llm.maxTokens = firstMeta.maxTokens;
      }
      wsSafeSend(JSON.stringify({ v: 1, type: "cfg.set", patch: patch }));
      done({ ok: true, id: id, name: name, keyWritten: !!key, setDefault: !!patch.coding });
    };
    sync();
    if (!isLocal) elKey.focus();
  });
}
function renderProvPresets() {
  const host = $("provPresets");
  if (!host) return;
  host.innerHTML = PROVIDER_PRESETS.map(function (pp, i) {
    const modes = presetModeList(pp);
    const hasPlan = !!(pp.modes && pp.modes["token-plan"]);
    const tag = pp.custom ? '<span class="pc-tag local">自定义</span>'
      : pp.local ? '<span class="pc-tag local">本地</span>'
      : hasPlan ? '<span class="pc-tag plan">可套餐</span>'
      : '<span class="pc-tag">API</span>';
    const mode = presetPrimaryMode(pp).mode || {};
    const url = mode.baseUrl || (pp.custom ? "手填 baseUrl / Key / 模型" : "(手填)");
    const count = (mode.models || []).length;
    return '<div class="preset-card" data-i="' + i + '"><div class="pc-top"><span class="pc-name">' + esc(pp.name) + "</span>" + tag + "</div>" +
      '<div class="pc-url">' + esc(url) + "</div>" +
      '<div class="pc-models">' + (pp.custom ? "自定义渠道" : pp.local ? "本地模型 · 无需 Key" : count + " 个预置模型" + (hasPlan ? " · 支持 Token 套餐" : " · 无套餐")) + "</div></div>";
  }).join("");
  for (const el of host.querySelectorAll(".preset-card")) {
    el.onclick = async function () {
      if (modelSwitchReadOnly()) { toast("配置只读:无法添加服务商", true); return; }
      const pp = PROVIDER_PRESETS[Number(el.dataset.i)];
      if (!pp) return;
      const r = await presetDialog(pp);
      if (!r || !r.ok) return;
      renderProviders();
      renderModelList(); closeProviderModal();
      toast("已添加 " + r.name + (r.keyWritten ? " · 密钥已写入本机" : "") + (r.setDefault ? " · 默认主模型重启生效" : ""));
      wsSafeSend(JSON.stringify({ v: 1, type: "cfg.get" }));
    };
  }
}
// ---- / 模型目录(Provider 目录 ∪ 端点拉取 ∪ 自定义;能力徽标/元数据/设主模型/启停) ----
let lastModelIds = [];
function disabledModels() {
  const c = (cfgView && cfgView.config && cfgView.config.coding) || {};
  return Array.isArray(c.disabledModels) ? c.disabledModels : [];
}
/** 当前主模型实际生效的 provider id(显式 providerId > baseUrl 匹配 > 包含该模型的 provider)。 */
function currentProviderIdOf(llm) {
  if (llm && llm.providerId) return llm.providerId;
  if (!provDraft || !provDraft.length) return "";
  if (llm && llm.baseUrl) { const p = provDraft.find((x) => x.baseUrl === llm.baseUrl); if (p) return p.id; }
  if (llm && llm.model) { const p = provDraft.find((x) => (x.models || []).some((mm) => modelNameOf(mm) === llm.model)); if (p) return p.id; }
  return "";
}
/** 模型行落库对象:已有 Provider 条目直接返回;仅存在于拉取列表/当前值时挂到默认 Provider 下。 */
function ensureEntryFor(name) {
  const e = modelEntryByName(name);
  if (e && e.provider) return { pv: e.provider, it: ensureModelObject(e.provider, name) };
  if (!provDraft || !provDraft.length) return null;
  const pv = provDraft[defaultProviderIndex()];
  return pv ? { pv, it: ensureModelObject(pv, name) } : null;
}
function setMainModel(name, providerId) {
  const c = (cfgView && cfgView.config) || {};
  const llm = (c.coding && c.coding.llm) || {};
 // 同名模型可能出现在多家目录:优先用行内 provider(服务端仍会按 Registry 复核)。
  const pv = providerId ? (provDraft || []).find((x) => x.id === providerId) : null;
  const e = pv ? { provider: pv } : modelEntryByName(name);
  const patch = { coding: { llm: { model: name } } };
 // 跨 Provider 选模型时同步端点/凭证引用(服务端会热切;同 Provider 只改模型)。
  if (e && e.provider && e.provider.id !== currentProviderIdOf(llm)) {
    patch.coding.llm.providerId = e.provider.id;
    patch.coding.llm.baseUrl = e.provider.baseUrl;
    patch.coding.llm.apiKeyEnv = e.provider.apiKeyEnv || "GENIE_LLM_API_KEY";
  }
  wsSafeSend(JSON.stringify({ v: 1, type: "cfg.set", patch }));
  const badge = $("role-main-badge");
  if (badge) { badge.textContent = "应用中…"; badge.className = "sd cfg-wait"; }
  toast("主模型 → " + name + "(已提交,等待服务端确认…)");
}
// 模型逐一探活状态( F4):model → {pending} | {ok,ms,error};renderModelList 从这里渲染徽标。
const modelProbe = {};
let probeQueue = [], probeActive = 0, probeDone = 0, probeTotal = 0;
function probePump() {
  while (probeActive < 3 && probeQueue.length) {
    const e = probeQueue.shift();
    probeActive++;
    modelProbe[e.name] = { pending: true };
    wsSafeSend(JSON.stringify({ v: 1, type: "models.probe", model: e.name, ...(e.provider ? { providerId: e.provider.id } : {}) }));
  }
  renderModelList();
  const btn = $("models-probe-all");
  if (btn) btn.textContent = probeQueue.length || probeActive ? "检测中 " + probeDone + "/" + probeTotal : "全部检测";
}
function renderModelList() {
  const host = $("modelList");
  if (!host) return;
  const entries = modelCatalogEntries();
  const cnt = $("model-dir-count");
  if (cnt) cnt.textContent = entries.length ? entries.length + " 个模型" : "(空)";
  if (!entries.length) { host.innerHTML = '<div class="cc-empty">尚无模型 —— 先添加 Provider 或拉取模型列表</div>'; return; }
  const off = disabledModels();
  host.innerHTML = entries.map((e) => {
    const dis = off.indexOf(e.name) >= 0;
    const pr = modelProbe[e.name];
    const it = e.entry || {};
    const chip = pr ? (pr.pending ? '<span class="mr-tag mr-probe">测中…</span>'
      : pr.ok ? '<span class="mr-tag mr-ok" title="最小调用往返 ' + pr.ms + 'ms">可用 ' + pr.ms + 'ms</span>'
      : '<span class="mr-tag mr-bad" title="' + esc(redactPaths(pr.error || "")) + '">不可用</span>') : "";
    return '<div class="cm-mrow' + (dis ? " off" : "") + '" data-id="' + esc(e.name) + '">' +
      '<span class="cm-mname" title="' + esc(e.name) + '">' + esc(e.name) + '</span>' +
      '<span class="cm-mprov">' + esc(e.provider ? (e.provider.name || e.provider.id) : (e.current ? "当前配置" : "未登记")) + '</span>' +
      capBadge(it, "supportsToolCall", "工具") + capBadge(it, "supportsImage", "图像") +
      '<input class="num-in cm-cw" placeholder="上下文" value="' + (it.contextWindow || "") + '">' +
      '<input class="num-in cm-mt" placeholder="最大输出" value="' + (it.maxTokens || "") + '">' +
      chip +
      (dis ? '<span class="mr-tag r">已停用</span>' : "") +
      '<button data-act="setmain" title="设为 coding.llm.model(同 Provider 热生效)">设为主模型</button>' +
      '<button data-act="probe" title="对该模型发一次最小调用">测</button>' +
      '<button data-act="toggle">' + (dis ? "启用" : "停用") + "</button></div>";
  }).join("");
  for (const row of host.querySelectorAll(".cm-mrow")) {
    const id = row.dataset.id;
    const e = entries.find((x) => x.name === id);
    if (!e) continue;
    for (const b of row.querySelectorAll(".cap-chip")) b.onclick = () => {
      const slot = ensureEntryFor(id);
      if (!slot || !slot.it) { toast("先添加 Provider 再标记能力", true); return; }
      cycleCap(slot.it, b.dataset.cap); sendProviders(); renderModelList();
    };
    const cw = row.querySelector(".cm-cw");
    if (cw) cw.onchange = () => {
      const slot = ensureEntryFor(id);
      if (!slot || !slot.it) { toast("先添加 Provider 再编辑元数据", true); return; }
      const v = Number(cw.value); slot.it.contextWindow = v > 0 ? v : undefined;
      sendProviders(); renderModelList();
    };
    const mt = row.querySelector(".cm-mt");
    if (mt) mt.onchange = () => {
      const slot = ensureEntryFor(id);
      if (!slot || !slot.it) { toast("先添加 Provider 再编辑元数据", true); return; }
      const v = Number(mt.value); slot.it.maxTokens = v > 0 ? v : undefined;
      sendProviders(); renderModelList();
    };
    const sm = row.querySelector("button[data-act=setmain]");
    if (sm) sm.onclick = () => setMainModel(id, e.provider ? e.provider.id : "");
    const pb = row.querySelector("button[data-act=probe]");
    if (pb) pb.onclick = () => {
      if (modelProbe[id] && modelProbe[id].pending) return;
      modelProbe[id] = { pending: true }; renderModelList(); probeActive++; probeDone++; probeTotal++;
      wsSafeSend(JSON.stringify({ v: 1, type: "models.probe", model: id, ...(e.provider ? { providerId: e.provider.id } : {}) }));
    };
    const tg = row.querySelector("button[data-act=toggle]");
    if (tg) tg.onclick = () => {
      const cur = disabledModels().slice();
      const i = cur.indexOf(id);
      if (i >= 0) cur.splice(i, 1); else cur.push(id);
      wsSafeSend(JSON.stringify({ v: 1, type: "cfg.set", patch: { coding: { disabledModels: cur } } }));
      toast("模型 " + id + (i >= 0 ? " 已启用" : " 已停用(不进快切/下拉)"));
    };
  }
}
// ---- 管理面渲染器(子智能体/技能/命令/钩子/MCP/记忆) ----
let customCommands = [];
function mgrRow(name, src, desc, meta, acts) {
  return '<div class="mgr-row"><span class="m-name">' + esc(name) + '</span>' +
    (src ? '<span class="m-src">' + esc(src) + "</span>" : "") +
    '<span class="m-desc" title="' + esc(desc) + '">' + esc(desc) + "</span>" +
    (meta ? '<span class="m-meta">' + esc(meta) + "</span>" : "") +
    (acts || "") + "</div>";
}
function renderAgents(m) {
  const host = $("agentsView");
  if (!host) return;
  const items = (m && m.agents) || [];
  host.innerHTML = items.length
    ? items.map((a) => mgrRow(a.name, a.builtin ? "内置" : "用户", a.description || "", (a.tools && a.tools.length ? a.tools.length + " 个工具" : "全部工具"), '<button data-act="view">角色提示</button>')).join("")
    : '<div class="cc-empty">无子智能体</div>';
  const rows = host.querySelectorAll(".mgr-row");
  items.forEach((a, i) => {
    const b = rows[i] && rows[i].querySelector("button");
    if (b) b.onclick = () => { const NL = String.fromCharCode(10); uiAlert(a.systemPrompt || a.description || "", { title: "【" + a.name + "】" }); };
  });
}
function renderSkills(m) {
  const host = $("skillsView");
  if (!host) return;
  const items = (m && m.items) || [];
  const dis = (m && m.disabled) || [];
  const disKeys = new Set(dis.map((x) => x.category + "/" + x.name));
  const builtin = items.filter((x) => x.category === "builtin");
  const user = items.filter((x) => x.category !== "builtin");
  let html = '<div class="mgr-head">内置 · ' + builtin.length + "</div>";
  html += builtin.length ? builtin.map((x) => mgrRow(x.name, "内置", x.description, "", '<button data-act="toggle" data-name="' + esc(x.name) + '">' + (disKeys.has("builtin/" + x.name) ? "启用" : "停用") + "</button>")).join("") : '<div class="cc-empty">无</div>';
  html += '<div class="mgr-head">用户/项目 · ' + user.length + "</div>";
  html += user.length ? user.map((x) => mgrRow(x.name, x.category, x.description, "", '<button data-act="toggle" data-name="' + esc(x.name) + '" data-cat="' + esc(x.category) + '">' + (disKeys.has(x.category + "/" + x.name) ? "启用" : "停用") + "</button>")).join("") : '<div class="cc-empty">无(主 agent 用 experience_fold 沉淀)</div>';
  host.innerHTML = html;
  for (const b of host.querySelectorAll("button[data-act=toggle]")) {
    b.onclick = () => {
      const name = b.dataset.name;
      const cat = b.dataset.cat || "builtin";
// 乐观翻转(竞态修复):9p 慢写致 ack 可迟 >800ms(WSL 经验证 860ms),按闭包旧态连点会发出同向值——
 // 以按钮当前文字为准先翻,目标态由它推导;权威列表回来照常覆盖。
        const wasDisabled = b.textContent.includes("启用");
        b.textContent = wasDisabled ? "停用" : "启用";
        if (cat === "builtin") {
          wsSafeSend(JSON.stringify({ v: 1, type: "skills.disableBuiltin", name, disabled: !wasDisabled }));
        } else {
          wsSafeSend(JSON.stringify({ v: 1, type: "exp.disable", category: cat, name, disabled: !wasDisabled }));
        }
    };
  }
}
function renderCmds(m) {
  const host = $("cmdsView");
  if (!host) return;
 // 修:commands.list.result 现为「内置 + 自定义」合并流(catalog 语义),
 // 这里必须只收自定义项——否则设置页会把内置命令当用户命令列出(还带删除按钮),
 // 斜杠面板 custom 组也会重复一遍,且 /help 一类会误走 custom 模板展开路径。
  customCommands = ((m && m.commands) || []).filter((c) => c && c.source !== "builtin");
  const diags = (m && m.diagnostics) || [];
  host.innerHTML = (customCommands.length
    ? customCommands.map((c) => mgrRow("/" + c.name, "自定义",
      String(c.description || c.body || "").split(String.fromCharCode(10))[0].slice(0, 80),
      c.inputHint ? "<" + esc(c.inputHint) + ">" : "",
      '<button data-act="del" data-name="' + esc(c.name) + '">删除</button>')).join("")
    : '<div class="cc-empty">尚无自定义命令——下方新建后,/ 菜单即可调用</div>') +
    diags.map((d) => '<div class="cc-empty" style="color:#e0a97a">' + esc(String(d.message || "").slice(0, 160)) + "</div>").join("");
  for (const b of host.querySelectorAll("button[data-act=del]")) {
    b.onclick = () => { uiConfirm("删除命令 /" + b.dataset.name + "?", { tone: "danger" }).then((ok) => { if (ok) wsSafeSend(JSON.stringify({ v: 1, type: "commands.remove", name: b.dataset.name })); }); };
  }
}
function renderHooks(m) {
  const host = $("hooksView");
  if (!host) return;
  const items = (m && m.hooks) || [];
  host.innerHTML = items.length
    ? items.map((h) => mgrRow(h.name, h.event, h.command, h.lastRunAt ? "上次 " + (h.lastOk ? ic("check", "ok") : ic("fail", "bad")) + " " + ago2(h.lastRunAt) : "未跑过", '<button data-act="toggle" data-id="' + esc(h.id) + '">' + (h.enabled ? "停用" : "启用") + '</button><button class="danger" data-act="del" data-id="' + esc(h.id) + '">删除</button>')).join("")
    : '<div class="cc-empty">尚无钩子——任务开始/完成/失败时在项目根执行命令(30s 超时)</div>';
  for (const b of host.querySelectorAll("button[data-act]")) {
    b.onclick = () => {
      const id = b.dataset.id;
      if (b.dataset.act === "del") { uiConfirm("删除该钩子?", { tone: "danger" }).then((ok) => { if (ok) wsSafeSend(JSON.stringify({ v: 1, type: "hooks.remove", id })); }); }
 // 乐观翻转(同族竞态):按钮文字为准,慢 ack 期间连点不重发同向值。
      else { const wasEnabled = b.textContent.includes("停用"); b.textContent = wasEnabled ? "启用" : "停用"; wsSafeSend(JSON.stringify({ v: 1, type: "hooks.update", id, enabled: !wasEnabled })); }
    };
  }
}
function renderMcp(m) {
  const host = $("mcpView");
  if (!host) return;
  const items = (m && m.servers) || [];
  const st = (m && m.status) || {};
  host.innerHTML = items.length
    ? items.map((sv) => {
        const s = st[sv.id] || {};
        const dot = s.ok === true ? "ok" : s.ok === false ? "bad" : "wait";
        const stTxt = s.ok === true ? "已连接 · " + (s.tools || 0) + " 工具" : s.ok === false ? "连接失败:" + String(s.error || "").slice(0, 40) : (sv.enabled ? "待测" : "已停用");
        return mgrRow(sv.name, "stdio", sv.command + " " + (sv.args || []).join(" "), stTxt, '<span class="dot ' + dot + '"></span><button data-act="test" data-id="' + esc(sv.id) + '">测试</button><button data-act="toggle" data-id="' + esc(sv.id) + '">' + (sv.enabled ? "停用" : "启用") + '</button><button class="danger" data-act="del" data-id="' + esc(sv.id) + '">删除</button>');
      }).join("")
    : '<div class="cc-empty">尚未添加外部工具服务——在下方填写命令即可接入,接入后助手可直接使用</div>';
  for (const b of host.querySelectorAll("button[data-act]")) {
    b.onclick = () => {
      const id = b.dataset.id;
      if (b.dataset.act === "test") { b.textContent = "测试中…"; wsSafeSend(JSON.stringify({ v: 1, type: "mcp.test", id })); }
      else if (b.dataset.act === "del") { uiConfirm("删除该 MCP 服务器?", { tone: "danger" }).then((ok) => { if (ok) wsSafeSend(JSON.stringify({ v: 1, type: "mcp.remove", id })); }); }
      else { const sv = items.find((x) => x.id === id); wsSafeSend(JSON.stringify({ v: 1, type: "mcp.update", id, enabled: !sv.enabled })); }
    };
  }
}
function renderMemory(m) {
  const host = $("memoryView");
  if (!host) return;
  const d = m || {};
  const used = d.usage || {};
  const NL = String.fromCharCode(10);
  host.innerHTML = '<div class="mem-box">' +
    '<div class="kv"><span class="k">用户画像(user)</span><span class="v">' + (used.user ? used.user.used + "/" + used.user.limit + " 字符" : "-") + "</span>" +
    '<span class="k">环境笔记(memory)</span><span class="v">' + (used.memory ? used.memory.used + "/" + used.memory.limit + " 字符" : "-") + "</span>" +
    '<span class="k">根目录</span><span class="v">' + esc(String(d.root || "")) + "</span></div>" +
    "<h4>用户画像</h4><pre>" + esc(String(d.user || "(空)")) + "</pre>" +
    "<h4>环境笔记</h4><pre>" + esc(String(d.memory || "(空)")) + "</pre></div>";
}
function renderProxyKv(m) {
  const host = $("proxy-kv");
  if (!host) return;
  const px = (m && m.proxy) || {};
  host.innerHTML = [["HTTPS_PROXY", px.https], ["HTTP_PROXY", px.http], ["NO_PROXY", px.no]].map(([k, v]) => '<span class="k">' + k + '</span><span class="v">' + (v ? esc(String(v)) : "(未设置)") + "</span>").join("");
}
// ---- 项目档案(架构图管线视图) ----
let ppId = null, ppData = null, ppSel = null;
// 代码档案 tab:结构(架构图/模块/演进)| 文件钻取 | Wiki 文档。
// 默认结构;wiki tab 首次点击/切项目后进入时懒加载(只读 manifest,不自动生成)。
function projectSetTab(tab, skipWikiLoad) {
  projectTab = tab === "files" || tab === "wiki" || tab === "roadmap" ? tab : "structure";
  const view = $("view-project");
  view.dataset.tab = projectTab;
  const btns = view.querySelectorAll(".pp-tab");
  for (let i = 0; i < btns.length; i++) btns[i].classList.toggle("on", btns[i].getAttribute("data-ptab") === projectTab);
  const panes = view.querySelectorAll(".pp-tabpane");
  for (let i = 0; i < panes.length; i++) panes[i].classList.toggle("on", panes[i].getAttribute("data-ptab") === projectTab);
  document.body.classList.toggle("pp-wiki-tab", viewLive("project") && projectTab === "wiki");
  if (projectTab === "wiki" && !skipWikiLoad) wikiLoad();
  if (projectTab === "roadmap") roadmapLoad();
}
$("ppTabs").onclick = function(e) {
  const b = e.target && e.target.closest ? e.target.closest(".pp-tab") : null;
  if (b) projectSetTab(b.getAttribute("data-ptab"));
};

function openProfile(pid) {
  ppId = pid;
  ppSel = null;
  const p = projectById(pid);
  $("ppTitle").textContent = (p ? p.label : pid) + " · 代码档案 Atlas";
  projectSetTab("structure", true); // 先归位 tab:避免 switchView 按旧 tab=wiki 触发多余 wiki.list
  switchView("project");
  ppRender({ state: "pending", progress: 0, stage: "请求中", modules: [], edges: [], mermaid: "", stats: { files: 0, lines: 0, languages: {}, projectState: "" }, recentChanges: [], newModules: [] });
  ppOwnerNote(pid);
  wsSafeSend(JSON.stringify({ v: 1, type: "profile.get", projectId: pid }));
  wsSafeSend(JSON.stringify({ v: 1, type: "profile.file", projectId: pid })); // 文件清单
  arcQuery(); // 设计沉淀索引:档案打开即拉,列表+反查角标数据源
}
/** n9 代码档案作用域说明:当前展示的是「会话归属项目」还是回退的 activeProjectId。
 * 用户用户反馈「切了会话,档案还是上一个项目」——卡头必须写清来源,不能让人以为是当前会话数据。 */
function ppOwnerNote(pid) {
  const el = $("ppOwner");
  if (!el) return;
  const sid = currentSid || "";
  if (!sid) { el.style.display = "none"; el.innerHTML = ""; return; }
  el.style.display = "";
  if (!sessionOwnerState(sid)) {
 // 归属未知:先按 activeProjectId 渲染(不阻塞),同时补一次 session.owner.get(幂等)
    el.innerHTML = '会话归属查询中 · 暂显示当前项目 <b>' + esc(pid || "") + "</b>";
    ownerPull(sid);
    return;
  }
  const owner = sessionOwnerOf(sid);
  if (owner) el.innerHTML = "会话归属项目:<b>" + esc(owner) + "</b>";
  else el.innerHTML = '该会话<b class="pp-own-warn">无归属项目</b> · 显示当前项目 <b>' + esc(pid || "") + "</b>";
}
/** n9 sid→projectId 缓存与查询状态(三态:undefined=未查 / null=服务端明确无归属 / string=归属项目)。
 * 通道 session.owner.get / session.owner.result 由服务端另一路实现;前端按契约收发并有防御(未知回包先 pending)。 */
const sessionOwnerMap = new Map();
let arcOwnerPending = false; // 档案取数是否在等会话归属回包(等回包时先按 activeProjectId 渲染,回包再切)
function sessionOwnerState(sid) { return sessionOwnerMap.has(sid) ? "known" : "unknown"; }
function sessionOwnerOf(sid) { return sessionOwnerMap.has(sid) ? sessionOwnerMap.get(sid) : null; }
function sessionOwnerPending(sid) { return sessionOwnerMap.has(sid) ? false : !!sid; }
function ownerPull(sid) { if (sid && ws && ws.readyState === 1) wsSafeSend(JSON.stringify({ v: 1, type: "session.owner.get", sessionId: sid })); }
/** n9 档案/看板取数时的项目选择:会话归属项目优先,缺席回退 activeProjectId(并让卡头标注回退)。 */
function ownerProjectId() {
  const sid = currentSid || "";
  if (sid && sessionOwnerMap.has(sid)) {
    const pid = sessionOwnerMap.get(sid);
    if (pid) return pid;
    return activeProjectId || "__harness__"; // 明确无归属:回退当前项目(卡头已标「该会话无归属项目」)
  }
  return activeProjectId || "__harness__";
}
function ppRender(d) {
  ppData = d;
  $("ppState").textContent = d.state === "done" ? "完成" : d.state === "running" ? "分析中" : d.state === "failed" ? "失败" : "排队";
  $("ppState").className = "pp-state " + d.state;
  $("ppBar").style.width = (d.progress || 0) + "%";
  $("ppPct").textContent = d.state === "done"
    ? (d.stats ? d.stats.files + " 文件 · " + d.stats.lines + " 行 · " + (d.modules || []).length + " 模块 · " + (d.edges || []).length + " 依赖边" : "")
    : (d.progress || 0) + "% · " + (d.stage || "");
 // 架构图
  const g = $("ppGraph");
  if (d.mermaid && window.OwnDiagram) {
    OwnDiagram.render("ppgraph", d.mermaid).then((o) => {
      g.innerHTML = '<div class="gv">' + (o && o.svg ? o.svg : o) + "</div>";
      bindZoomPan(g, g.querySelector(".gv"), g.querySelector("svg"));
 // 节点点选=选中模块(金色高亮+邻接淡化,右侧详情展开;再点恢复)——选中就是黄色高亮状态
      const svg = g.querySelector("svg");
      if (svg) {
        svg.style.maxWidth = "none";
        svg.querySelectorAll(".node").forEach((el) => {
          el.style.cursor = "pointer";
          el.addEventListener("click", (ev) => {
            ev.stopPropagation();
            const txt = el.textContent || "";
            const hit = (d.modules || []).find((m) => txt.indexOf(m.name) >= 0);
            if (!hit) return;
            const again = ppSel === hit.name;
            ppDetail(again ? null : hit.name);
 // 高亮:选中金色,邻接亮,其余淡化;再点全恢复
            const keep = new Set([hit.name]);
            if (!again) (d.edges || []).forEach((e) => { if (e.from === hit.name) keep.add(e.to); if (e.to === hit.name) keep.add(e.from); });
            svg.querySelectorAll(".node").forEach((x) => {
              const t = x.textContent || "";
              const on = !again && [...keep].some((k) => t.indexOf(k) >= 0);
              x.style.opacity = (!again && !on) ? 0.15 : "";
              x.style.filter = on ? "drop-shadow(0 0 6px rgba(216,163,84,.8))" : "";
            });
          });
        });
      }
    }).catch(() => { g.innerHTML = '<div class="cc-empty">架构图渲染失败:' + esc(String(d.mermaid).slice(0, 80)) + "</div>"; });
  } else {
    g.innerHTML = '<div class="cc-empty">' + (d.state === "done" ? "无图(项目过小?)" : "构建中…" + (d.stage ? "(" + d.stage + ")" : "")) + "</div>";
  }
 // 模块列表(带过滤)
  ppRenderMods();
 // 演进
  const ch = $("ppChanges");
  const rcs = d.recentChanges || [];
  ch.innerHTML = rcs.length ? rcs.slice(0, 10).map((c) =>
    '<div class="pp-ch"><span class="pc-t">' + esc(c.title.slice(0, 44)) + '</span>' +
    (c.modules && c.modules.length ? ' · <span class="pc-m">' + esc(c.modules.join(",").slice(0, 40)) + "</span>" : "") +
    (c.files ? " · " + c.files + " 文件 +" + c.add + " -" + c.del : "") +
    '<div style="color:var(--faint);font-size:9.5px;margin-top:2px">' + new Date(c.at).toLocaleString() + "</div></div>").join("")
    : '<div class="cc-empty">暂无变更记录(任务完成即记录模块演进)</div>';
  planRender();
}
/** 图容器缩放/平移通用绑定(质量轮:滚轮以鼠标为中心/空白拖拽/位移阈值兼容节点点选)
 * 任务B:缩放/平移数学改走 diagram-viewport 引擎(window.DiagramViewport,资产缺席时
 * 就地内联同式兜底)——锚点缩放不变式「光标下内容点屏幕位移=0」由引擎保证;另挂双指捏合
 * (pointer 距离→scale/中心移→pan,与 canvas-shell pinchToView 同口径)。每容器一份闭包状态,
 * 多查看器实例互不串扰。 */
function dvLib() {
  return (typeof window !== "undefined" && window.DiagramViewport) || null;
}
/** 引擎缺席兜底:与 diagram-viewport.js 同式的纯数学(资产没加载也不退化)。 */
function dvZoomAtPoint(t, p, ns) {
  const lib = dvLib();
  if (lib && lib.zoomAtPoint) return lib.zoomAtPoint(t, p, ns);
  const cur = (Number.isFinite(t.scale) && t.scale > 0) ? t.scale : 1;
  const next = Math.min(4, Math.max(0.25, Number.isFinite(ns) ? ns : cur));
  const wx = (p.x - t.translateX) / cur, wy = (p.y - t.translateY) / cur;
  return { scale: next, translateX: p.x - wx * next, translateY: p.y - wy * next };
}
function bindZoomPan(view, layer, svg) {
  if (!view || !layer) return;
  view.style.overflow = "hidden";
  view.style.position = "relative";
  view.style.cursor = "grab";
  layer.style.transformOrigin = "0 0";
  if (svg) svg.style.maxWidth = "none";
  let sc = 1, tx = 0, ty = 0, drag = null;
 /** 引擎 transform {scale,translateX,translateY} ⇄ 旧 {sc,tx,ty} 互转(非有限值不落,防 NaN 进 style)。 */
  const toT = () => ({ scale: sc, translateX: tx, translateY: ty });
  const fromT = (t) => {
    if (Number.isFinite(t.scale)) sc = t.scale;
    if (Number.isFinite(t.translateX)) tx = t.translateX;
    if (Number.isFinite(t.translateY)) ty = t.translateY;
  };
  const apply = () => {
    if (!Number.isFinite(sc) || !Number.isFinite(tx) || !Number.isFinite(ty)) { sc = 1; tx = 0; ty = 0; } // NaN 守卫:非法 transform 不写 style
    layer.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + sc + ")";
  };
 // 双指捏合(任务B):距变→scale(引擎 zoomAtPoint 以当前双指中心为锚)、心移→pan;起手取消单指拖拽
  let pts = {}, pinch = null;
  const ptsList = () => Object.keys(pts).map((k) => pts[k]);
  const pinchStart = () => {
    const p = ptsList();
    if (p.length < 2) return;
    drag = null;
    const dx = p[1].x - p[0].x, dy = p[1].y - p[0].y;
    const d0 = Math.sqrt(dx * dx + dy * dy);
    if (!(d0 > 8)) return; // 两指几乎重合:距离噪声大,不起捏合
    const vr = view.getBoundingClientRect();
    pinch = { d0, c0x: (p[0].x + p[1].x) / 2 - vr.left, c0y: (p[0].y + p[1].y) / 2 - vr.top, t0: toT() };
  };
  const pinchMove = () => {
    if (!pinch) return;
    const p = ptsList();
    if (p.length < 2) { pinch = null; return; }
    const dx = p[1].x - p[0].x, dy = p[1].y - p[0].y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (!Number.isFinite(d) || !(pinch.d0 > 0)) return;
    const vr = view.getBoundingClientRect();
    const c1x = (p[0].x + p[1].x) / 2 - vr.left, c1y = (p[0].y + p[1].y) / 2 - vr.top;
 // 起始中心 c0 下的世界点在当前中心 c1 下重投影(与 canvas-shell pinchToView 同式,经引擎钳域)
    const s0 = Number.isFinite(pinch.t0.scale) && pinch.t0.scale > 0 ? pinch.t0.scale : 1;
    const wx = (pinch.c0x - pinch.t0.translateX) / s0;
    const wy = (pinch.c0y - pinch.t0.translateY) / s0;
    const ns = Math.min(4, Math.max(0.25, s0 * (d / pinch.d0)));
    fromT({ scale: ns, translateX: c1x - wx * ns, translateY: c1y - wy * ns });
    apply();
  };
  view.addEventListener("pointerdown", (e) => {
    pts[e.pointerId] = { x: e.clientX, y: e.clientY };
    if (Object.keys(pts).length >= 2) pinchStart();
  });
  const pinchTrack = (e) => {
    if (!Object.prototype.hasOwnProperty.call(pts, e.pointerId)) return;
    pts[e.pointerId] = { x: e.clientX, y: e.clientY };
    pinchMove();
  };
  const pinchEnd = (e) => {
    if (!Object.prototype.hasOwnProperty.call(pts, e.pointerId)) return;
    delete pts[e.pointerId];
    if (pinch && Object.keys(pts).length < 2) pinch = null;
  };
  view.addEventListener("pointermove", pinchTrack);
  view.addEventListener("pointerup", pinchEnd);
  view.addEventListener("pointercancel", pinchEnd);
  view.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = layer.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    fromT(dvZoomAtPoint(toT(), { x: mx, y: my }, sc * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); // 引擎:光标锚点缩放(钳 0.25~4)
    apply();
  }, { passive: false });
  view.addEventListener("mousedown", (e) => { drag = { x: e.clientX, y: e.clientY, tx, ty, moved: false }; });
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    if (pinch) { drag = null; return; } // 捏合进行中:单指拖拽让位
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && dx * dx + dy * dy < 9) return;
    if (!drag.moved) { drag.moved = true; view.style.cursor = "grabbing"; }
    tx = drag.tx + dx; ty = drag.ty + dy;
    apply();
  });
  window.addEventListener("mouseup", () => { drag = null; view.style.cursor = "grab"; });
}
function ppRenderMods() {
  const host = $("ppMods");
  if (!host || !ppData) return;
  const q = ($("ppSearch").value || "").trim().toLowerCase();
  const mods = (ppData.modules || []).filter((m) => !q || m.name.toLowerCase().includes(q) || (m.keyFiles || []).some((f) => f.toLowerCase().includes(q)));
  host.innerHTML = mods.length ? mods.slice(0, 60).map((m) =>
    '<div class="pp-mod' + (ppSel === m.name ? " on" : "") + '" data-m="' + esc(m.name) + '"><span class="pm-n">' + esc(m.name) + (m.addedAt ? '<span class="pm-new">新</span>' : "") + "</span>" +
    '<div class="pm-d">' + esc(String(m.desc).slice(0, 70)) + "</div></div>").join("")
    : '<div class="cc-empty">无匹配模块</div>';
  for (const el of host.querySelectorAll(".pp-mod")) el.onclick = () => ppDetail(el.dataset.m);
  if (ppSel) ppDetail(ppSel);
}
function ppDetail(name) {
  ppSel = name;
  for (const el of $("ppMods").querySelectorAll(".pp-mod")) el.classList.toggle("on", !!name && el.dataset.m === name);
  if (!name) { $("ppDetail").innerHTML = '<div class="cc-empty">点模块查看详情(再点图上模块收起)</div>'; return; }
  const m = (ppData.modules || []).find((x) => x.name === name);
  if (!m) { $("ppDetail").innerHTML = ""; return; }
  const rvs = (ppData.edges || []).filter((e) => e.from === name).map((e) => e.to);
  const by = (ppData.edges || []).filter((e) => e.to === name).map((e) => e.from);
  const newTag = m.addedAt ? ' <span class=pm-new>新·' + new Date(m.addedAt).toLocaleDateString() + '</span>' : '';
  const kf = (m.keyFiles || []).map(esc).join('<br/>');
  const gh = (ppData.gitHistory || []).find((x) => x.module === name);
  const gitHtml = gh && gh.commits && gh.commits.length
    ? '<br/>最近提交(' + (gh.commits30d || 0) + '/30天):' + gh.commits.slice(0, 4).map((c) => '<div class=git-line>' + new Date(c.at).toLocaleDateString() + ' · ' + esc(c.author) + ' · ' + esc(String(c.subject).slice(0, 40)) + ' <span style="font-family:var(--mono)">' + esc(c.sha) + '</span></div>').join("") 
    : '';
  $("ppDetail").innerHTML = '<div class=pp-detail><b>' + esc(name) + '</b>' + newTag +
    '<br/>' + esc(m.desc) +
    '<br/>依赖(' + rvs.length + '): ' + (rvs.join('、') || '无') +
    '<br/>被依赖(' + by.length + '): ' + (by.join('、') || '无') +
    gitHtml +
    '<br/>代表文件(点→函数级 code2flow 图):<div class=kd>' +
    (m.keyFiles || []).map((f) => '<span class="kf-link" data-f="' + esc(f) + '" style="cursor:pointer;text-decoration:underline dotted">' + esc(f) + '</span>').join('<br/>') + '</div></div>';
  for (const el of $("ppMods").querySelectorAll(".pp-mod")) el.classList.toggle("on", el.dataset.m === name);
 // 单图同构下钻:代表文件点击→ppf 函数级视图自动选中并拉取(code_index 同源数据)
  for (const el of $("ppDetail").querySelectorAll(".kf-link")) {
    el.onclick = () => {
      const f = el.dataset.f;
      ppfCur = f;
      $("ppfGraphWrap").style.display = "none";
      projectSetTab("files", true); // 结构→文件钻取( tab 化;原 scrollIntoView 在隐藏 pane 上无效)
      wsSafeSend(JSON.stringify({ v: 1, type: "profile.file", projectId: ppId, file: f }));
      const box = $("ppf");
      if (box) box.scrollIntoView({ behavior: "smooth", block: "start" });
    };
  }
}
$("ppSearch").oninput = () => ppRenderMods();
$("ppRebuild").onclick = () => { if (ppId) { wsSafeSend(JSON.stringify({ v: 1, type: "profile.rebuild", projectId: ppId })); toast("重建启动(进度条刷新)"); } };
// ---- 规划态(全量开发):图上编辑→任务书→执行 ----
function planRender() {
  if (!ppData) return;
  const plan = ppData.plan || [];
  const names = (ppData.modules || []).map((m) => m.name);
 // 规划面板可见性
  $("ppPlan").style.display = planOpen || plan.length ? "flex" : "none";
 // 下拉
  const opts = (arr) => arr.map((x) => '<option value="' + esc(x) + '">' + esc(x) + "</option>").join("");
  $("planDelSel").innerHTML = opts(names);
  $("planDepFrom").innerHTML = opts(names.concat(plan.filter((x) => x.kind === "add-module").map((x) => x.name)));
  $("planDepTo").innerHTML = $("planDepFrom").innerHTML;
 // 清单
  const kindTxt = { "add-module": "新增", "remove-module": "移除", "add-dep": "依赖" };
  $("planList").innerHTML = plan.length ? plan.map((x) => {
    const label = x.kind === "add-dep" ? x.from + " → " + x.to : x.name;
    const note = x.note || x.reason || "";
    return '<div class="plan-item"><span style="color:var(--green)">' + kindTxt[x.kind] + '</span><b style="color:var(--text);font-weight:400">' + esc(label) + "</b>" + (note ? '<span style="color:var(--faint)">' + esc(String(note).slice(0, 30)) + "</span>" : "") + '<span class="pi-x" data-id="' + esc(x.id) + '" title="移除">' + ic("x") + "</span></div>";
  }).join("") : '<div style="font-size:10.5px;color:var(--faint)">暂无规划项——用上方三行在图上加模块/删模块/连依赖</div>';
  for (const x of $("planList").querySelectorAll(".pi-x")) x.onclick = () => wsSafeSend(JSON.stringify({ v: 1, type: "profile.plan.remove", projectId: ppId, id: x.dataset.id }));
}
let planOpen = false;
$("ppPlanBtn").onclick = () => { planOpen = !planOpen; planRender(); };
function planItem(kind, extra) {
  return Object.assign({ id: "pl-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e4), kind, createdAt: Date.now() }, extra);
}
$("planAddGo").onclick = () => {
  const name = $("planAddName").value.trim();
  const note = $("planAddNote").value.trim();
  if (!name) { toast("填模块名", true); return; }
  wsSafeSend(JSON.stringify({ v: 1, type: "profile.plan.upsert", projectId: ppId, item: planItem("add-module", { name, note }) }));
  $("planAddName").value = ""; $("planAddNote").value = "";
};
$("planDelGo").onclick = () => {
  const name = $("planDelSel").value;
  if (!name) return;
  wsSafeSend(JSON.stringify({ v: 1, type: "profile.plan.upsert", projectId: ppId, item: planItem("remove-module", { name, reason: $("planDelReason").value.trim() }) }));
  $("planDelReason").value = "";
};
$("planDepGo").onclick = () => {
  const from = $("planDepFrom").value, to = $("planDepTo").value;
  if (!from || !to || from === to) { toast("选两端且不同", true); return; }
  wsSafeSend(JSON.stringify({ v: 1, type: "profile.plan.upsert", projectId: ppId, item: planItem("add-dep", { from, to, note: "" }) }));
};
$("planApply").onclick = () => {
  if (!(ppData && (ppData.plan || []).length)) { toast("无规划项", true); return; }
  const n = ppData.plan.length;
  uiConfirm("按 " + n + " 项规划生成任务书并派发执行?(图上规划即契约;任务完成后架构图自动重建比对)").then((ok) => {
    if (!ok) return;
    wsSafeSend(JSON.stringify({ v: 1, type: "profile.plan.apply", projectId: ppId }));
    planOpen = false;
  });
};
// ---- 文件与函数钻取(每个文件的每个函数 + 调用关系图) ----
let ppfFilesList = [];
let ppfCur = null;
function ppfEsc(x) { return String(x == null ? "" : x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function ppfFiltered() {
  const q = ($("ppfSearch") && $("ppfSearch").value || "").trim().toLowerCase();
  return q ? ppfFilesList.filter((f) => f.toLowerCase().includes(q)) : ppfFilesList;
}
function ppfRenderFiles() {
  const box = $("ppfFiles");
  const list = ppfFiltered();
  box.innerHTML = list.length
    ? list.map((f) => '<div class="ppf-fitem' + (f === ppfCur ? " on" : "") + '" data-f="' + ppfEsc(f) + '" title="' + ppfEsc(f) + '">' + ppfEsc(f) + "</div>").join("")
    : '<div class="cc-empty">无匹配文件</div>';
  for (const el of box.querySelectorAll(".ppf-fitem")) {
    el.onclick = () => {
      ppfCur = el.dataset.f;
      for (const x of box.querySelectorAll(".ppf-fitem")) x.classList.toggle("on", x === el);
      $("ppfFns").innerHTML = '<div class="cc-empty">解析中…</div>';
      wsSafeSend(JSON.stringify({ v: 1, type: "profile.file", projectId: ppId, file: ppfCur }));
    };
  }
}
function ppfOnData(m) {
  if (m.mode === "files") { ppfFilesList = m.files || []; ppfRenderFiles(); return; }
  if (m.mode === "symbols") { ppfLast = m; ppfRenderFns(m); }
}
// 八期定位:代码档案=项目静态基座知识(工作流画布式组织化呈现);白板=一次代码改动的临时任务草图。
// 档案模块画布 ← fileToModules;「带入白板」=静态→任务草稿的单向桥。
let ppfModules = null; // 当前文件模块数据(fileToModules 形态)
function ppfRenderFns(m) {
  const syms = m.symbols || [], edges = m.edges || [];
  const kinds = m.kinds || {};
  ppfModules = m.modules || null;
  const KD = { trunk: "入", leaf: "叶", regular: "fn" };
 // 反查角标:按 symbolRef.file 匹配沉淀索引(同文件的全部行共享文件级计数,入口轻)
  const bcnt = arcBadgeCount(m.file);
  const bBadge = bcnt ? '<span class="arc-badge" data-arcfile="' + ppfEsc(m.file) + '" title="' + bcnt + ' 块设计板碰过这个文件——点击在设计沉淀区反查">' + bcnt + " 设计</span>" : "";
  $("ppfHint").textContent = m.file + " · " + syms.length + " 个函数 · " + edges.length + " 条调用";
  const rows = [];
  if (ppfModules && ppfModules.nodes && ppfModules.nodes.length) {
    rows.push('<div class="ppf-fn" data-mod="1"><span class="kd kd2-trunk">模</span> 模块画布 <span class="ln">' + ppfModules.nodes.length + " 模块 · " + (ppfModules.edges || []).length + " 调用边</span>" + bBadge + "</div>");
  }
  rows.push('<div class="ppf-fn" data-all="1"><span class="kd">整</span> 全文件调用图 <span class="ln">' + syms.length + " 函数 " + edges.length + " 边</span>" + bBadge + "</div>");
  for (const s2 of syms) {
    const k2 = kinds[s2.id];
    const badge = k2 ? '<span class="kd kd2-' + k2.kind + '">' + (KD[k2.kind] || "fn") + '</span>' : '<span class="kd">' + ppfEsc(s2.kind.slice(0, 3)) + "</span>";
    const deg = k2 ? ' <span class="ln">出' + k2.outCount + "/入" + k2.inCount + "</span>" : "";
    rows.push('<div class="ppf-fn" data-id="' + ppfEsc(s2.id) + '">' + badge + " " + ppfEsc(s2.name) + (s2.container ? ' <span class="ct">·' + ppfEsc(s2.container) + "</span>" : "") + ' <span class="ln">:' + s2.line + "</span>" + deg + bBadge + "</div>");
  }
  $("ppfFns").innerHTML = rows.join("");
  for (const el of $("ppfFns").querySelectorAll(".ppf-fn")) {
    if (el.dataset.mod) { el.onclick = () => ppfModuleCanvas(m); continue; }
    el.onclick = () => ppfDrawGraph(m, el.dataset.all ? null : el.dataset.id);
  }
  for (const b of $("ppfFns").querySelectorAll(".arc-badge")) b.onclick = (e) => { e.stopPropagation(); arcFilterFile(b.dataset.arcfile); };
}
/** 八期:档案模块画布(只读呈现+带入白板桥)——复用 cv-node 卡形态与工作流类型配色。 */
function ppfModuleCanvas(m) {
  const mods = ppfModules;
  if (!mods || !mods.nodes || !mods.nodes.length) { toast("该文件无模块数据", true); return; }
 // 分层布局(与白板画布同款 dagre-lite 简化:按边最长路径)
  const pos = new Map();
  const W = 256, H = 130;
  const ids = mods.nodes.map((n) => n.id);
  const out = new Map(ids.map((i) => [i, []])), indeg = new Map(ids.map((i) => [i, 0]));
  for (const e of mods.edges || []) { if (out.has(e.from) && indeg.has(e.to)) { out.get(e.from).push(e.to); indeg.set(e.to, indeg.get(e.to) + 1); } }
  const level = new Map(ids.map((i) => [i, 0]));
  let q = ids.filter((i) => (indeg.get(i) || 0) === 0);
  const seen = new Set();
  while (q.length) {
    const nxt = [];
    for (const id of q) {
      if (seen.has(id)) continue;
      seen.add(id);
      for (const to of out.get(id) || []) { level.set(to, Math.max(level.get(to) || 0, (level.get(id) || 0) + 1)); indeg.set(to, (indeg.get(to) || 1) - 1); if ((indeg.get(to) || 0) <= 0) nxt.push(to); }
    }
    q = nxt;
  }
  for (const id of ids) if (!seen.has(id)) level.set(id, 0);
  const byLevel = new Map();
  for (const id of ids) { const l = level.get(id) || 0; if (!byLevel.has(l)) byLevel.set(l, []); byLevel.get(l).push(id); }
  for (const [l, arr] of byLevel) arr.forEach((id, i) => pos.set(id, { x: 16 + l * W, y: 14 + i * H }));
  let maxX = 0, maxY = 0;
  for (const p of pos.values()) { maxX = Math.max(maxX, p.x + 230); maxY = Math.max(maxY, p.y + 120); }
  let svg = '<svg class="bf-cv-edges" width="' + Math.max(maxX + 60, 500) + '" height="' + Math.max(maxY + 60, 300) + '"><defs><marker id="ppfarrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8a7a5a"/></marker></defs>';
  for (const e of mods.edges || []) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x + 216, y1 = a.y + 30, x2 = b.x, y2 = b.y + 30;
    const dx = Math.max(36, (x2 - x1) / 2);
    svg += '<path class="bfe-' + (e.kind || "call") + '" d="M ' + x1 + " " + y1 + " C " + (x1 + dx) + " " + y1 + ", " + (x2 - dx) + " " + y2 + ", " + x2 + " " + y2 + '" marker-end="url(#ppfarrow)"/>';
  }
  svg += "</svg>";
  const cards = mods.nodes.map((n) => {
    const p = pos.get(n.id) || { x: 0, y: 0 };
    const nb = arcBadgeCount(String(n.symbolRef && n.symbolRef.file));
    return '<div class="cv-node" style="left:' + p.x + "px;top:" + p.y + 'px">' +
      '<span class="cv-port in"></span><span class="cv-port out"></span>' +
      '<div class="cv-head"><span class="cv-kind cv-k-' + esc(n.kind) + '" title="' + esc((CV_KIND_NAME && CV_KIND_NAME[n.kind]) || n.kind) + '">' + ((CV_KIND_ICON && CV_KIND_ICON[n.kind]) || "?") + "</span>" +
      '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(n.label) + "</span>" +
      '<span class="bd-tag keep">静态</span></div>' +
      '<div class="cv-sum">' + esc(n.summary) + "</div>" +
      '<div class="cv-foot"><span class="cv-dot none" title="档案节点(静态)"></span><span>' + esc(String(n.symbolRef.file).split("/").slice(-1)[0] + ":" + n.symbolRef.line) + "</span>" +
      '<span class="ln">出' + n.outCount + "/入" + n.inCount + "</span>" +
      (nb ? '<span class="arc-badge" data-arcfile="' + esc(String(n.symbolRef.file)) + '" title="' + nb + ' 块设计板碰过这个文件——点击在设计沉淀区反查">' + nb + " 设计</span>" : "") + "</div></div>";
  }).join("");
  const cross = (mods.crossFileTargets || []).slice(0, 8).map((c) => esc(c.name) + "(" + esc(String(c.file).split("/").slice(-1)[0]) + ")").join(" · ");
  $("ppfGraphWrap").style.display = "flex";
  $("ppfGTitle").textContent = "模块画布:" + m.file;
  $("ppfMermaid").innerHTML = '<div class="bf-canvas" style="min-height:300px"><div class="bf-cv-world" style="position:absolute">' + svg + cards + "</div></div>" +
    '<div style="display:flex;gap:8px;align-items:center;padding:8px 2px 2px;flex-wrap:wrap">' +
    '<button class="vw-act" id="ppfToBoard" style="border-color:var(--bronze)">带入白板做任务草稿</button>' +
    '<span class="bd-meta">把这份静态模块图转成白板草稿(可在其上评论/编辑/按板续作发起代码任务)</span>' +
    (cross ? '<span class="bd-meta">跨文件调用:' + cross + "</span>" : "") + "</div>";
  const btn = $("ppfToBoard");
  if (btn) btn.onclick = () => {
    if (!currentSid) { toast("先进入一个会话再带入白板", true); return; }
    wsSafeSend(JSON.stringify({ v: 1, type: "board.fromcode", sessionId: currentSid, file: m.file, ...(activeProjectId ? { projectId: activeProjectId } : {}) }));
    toast("已生成任务草稿板,切到白板查看");
    switchView("board");
  };
 // 反查:模块卡角标 → 设计沉淀区按文件过滤
  for (const b of $("ppfMermaid").querySelectorAll(".arc-badge")) b.onclick = (e) => { e.stopPropagation(); arcFilterFile(b.dataset.arcfile); };
}
/** 关系图:聚焦函数=自身+文件内上下游(互调实线)+跨文件被调(虚线外部节点);null=整文件全部边。 */
function ppfDrawGraph(m, focusId) {
  const syms = m.symbols || [], edges = m.edges || [];
  const byId = new Map(syms.map((s2) => [s2.id, s2]));
  let use = edges;
  if (focusId) use = edges.filter((e) => e.from === focusId || e.to === focusId);
  const nodes = new Map(); // id -> label
  const nodeId = (raw, fallback) => "n" + Math.abs([...String(raw)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)).toString(36);
  const addNode = (raw, label, ext) => { const id = nodeId(raw); const key = id + (ext ? "x" : ""); nodes.set(key, { label, ext }); return key; };
  const lines = ["flowchart LR"];
  const seen = new Set();
  for (const e of use) {
    const fromS = byId.get(e.from);
    const fk = addNode(e.from, fromS ? fromS.name + " :" + fromS.line : e.fromName, false);
    const tgt = byId.get(e.to);
    const tk = e.crossFile ? addNode(e.to + "|x", (e.toName || e.to).split(".").pop() + " (跨文件)", true) : addNode(e.to, (tgt ? tgt.name + " :" + tgt.line : (e.toName || e.to)), false);
    const dedup = fk + ">" + tk + ":" + e.line;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    lines.push("  " + fk + '["' + ppfEsc(nodes.get(fk).label) + '"]');
    lines.push("  " + tk + (e.crossFile ? '(["' : '["') + ppfEsc(nodes.get(tk).label) + '"]' + (e.crossFile ? ")" : ""));
    lines.push("  " + fk + (e.crossFile ? " -.-> " : " --> ") + "|" + e.line + "| " + tk);
  }
  if (focusId && !use.length) {
    const s2 = byId.get(focusId);
    lines.push('  iso["' + ppfEsc((s2 || {}).name || focusId) + " :" + ((s2 || {}).line ?? "") + ' (无调用边)"]');
  }
  $("ppfGraphWrap").style.display = "flex";
  $("ppfGTitle").textContent = focusId ? "调用关系:" + ((byId.get(focusId) || {}).name || focusId) : "全文件调用关系:" + m.file;
  const el = $("ppfMermaid");
  el.innerHTML = "";
  if (lines.length <= 1) { el.innerHTML = '<div class="cc-empty">该范围无调用边</div>'; return; }
 // code2flow 分类着色(有 kinds 时):入=trunk 棕/叶=leaf 绿
  const kk = m.kinds || {};
  const trunkIds = [], leafIds = [];
  for (const s2 of syms) {
    const k2 = kk[s2.id];
    if (!k2) continue;
    const nodeKey = "n" + Math.abs([...String(s2.id)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)).toString(36);
    if (k2.kind === "trunk") trunkIds.push(nodeKey);
    else if (k2.kind === "leaf") leafIds.push(nodeKey);
  }
  let tail = lines.join(NL);
  if (trunkIds.length) tail += NL + "  class " + trunkIds.join(",") + " c2fTrunk";
  if (leafIds.length) tail += NL + "  class " + leafIds.join(",") + " c2fLeaf";
  if (trunkIds.length || leafIds.length) tail += NL + "  classDef c2fTrunk fill:#8a5a2a,stroke:#c98f45,color:#fff" + NL + "  classDef c2fLeaf fill:#3a5a3a,stroke:#7ec98f,color:#b8e0b8";
  OwnDiagram.render("ppfm" + Date.now() % 1e6, tail).then((o) => {
    el.innerHTML = '<div class="gv">' + (o && o.svg ? o.svg : String(o)) + "</div>";
    bindZoomPan(el, el.querySelector(".gv"), el.querySelector("svg")); // 文件级小图同享缩放/平移
  }).catch(() => { el.innerHTML = "<pre style='font-size:9px;color:var(--faint)'>" + ppfEsc(tail) + "</pre>"; });
}
$("ppfGClose").onclick = () => { if (arcOpen) { arcClose(); return; } $("ppfGraphWrap").style.display = "none"; };

// ---- 设计沉淀(done 板 → 项目级设计记忆) ----
// 定位口径:白板=一次代码改动的临时任务草图(动态);代码档案=项目静态基座知识。
// 任务收官(done)时最终板承载的设计决策沉淀为项目级索引(board-archive.json,服务端 board-store),
// 这里呈现:done 板列表(标题/日期/节点数/关联文件)→ 点击=只读 Dify 画布(泛化 renderBoardCanvas,
// 不复制渲染代码);函数行/模块卡按 symbolRef.file 反查「哪些设计板碰过它」(轻角标)。
let arcItems = [];        // 沉淀索引条目(board.archive.result)
let arcFileFilter = null; // 反查过滤:按 symbolRef.file
let arcOpen = false, arcSid = "", arcTaskId = ""; // 只读画布当前板(board.doc 分流标记)
let ppfLast = null;       // 最近一次 symbols 数据(索引到达后重渲函数行补角标)
function arcQuery() { const pid = ppId || activeProjectId; if (pid && ws && ws.readyState === 1) wsSafeSend(JSON.stringify({ v: 1, type: "board.archive.list", projectId: pid })); }
function arcDate(ts) { try { return new Date(ts).toLocaleDateString(); } catch (e) { return ""; } }
function arcBadgeCount(file) { return file ? arcItems.filter((e) => (e.files || []).includes(file)).length : 0; }
/** 反查入口(角标点击):按文件过滤沉淀区并滚到可见。 */
function arcFilterFile(file) {
  arcFileFilter = file;
  arcRender();
  projectSetTab("structure", true); // tab 化:沉淀列表在结构 tab,反查后切过去(否则在隐藏 pane 里滚不到)
  const b = $("arcBody");
  if (b) b.scrollIntoView({ block: "nearest" });
}
function arcRender() {
  const host = $("arcBody");
  if (!host) return;
  const list = arcFileFilter ? arcItems.filter((e) => (e.files || []).includes(arcFileFilter)) : arcItems;
  const head = arcFileFilter
    ? '<div class="arc-filter">反查:碰过 <b>' + ppfEsc(String(arcFileFilter).split("/").slice(-1)[0]) + '</b> 的设计板<button class="vw-act" id="arcFilterClear">清除过滤</button></div>'
    : "";
  host.innerHTML = head + (list.length
    ? list.map((it) => '<div class="arc-item" data-arcsid="' + ppfEsc(it.sessionId) + '" data-arctask="' + ppfEsc(it.taskId) + '" title="' + ppfEsc((it.files || []).join(String.fromCharCode(10)) || "无关联文件") + '">' +
        '<div class="arc-t">' + ppfEsc(it.title) + "</div>" +
        '<div class="arc-m"><span class="bd-tag lk-linked">' + ppfEsc(it.status === "done" ? "已落实" : it.status) + "</span><span>" + arcDate(it.updatedAt) + "</span><span>" + it.nodeCount + " 节点</span><span>关联 " + (it.files || []).length + " 文件</span></div></div>").join("")
    : '<div class="cc-empty">' + (arcFileFilter ? "没有设计板碰过这个文件" : "暂无沉淀——任务收官时,done 白板自动登记为项目设计记忆") + "</div>");
  const clr = $("arcFilterClear");
  if (clr) clr.onclick = () => { arcFileFilter = null; arcRender(); };
  for (const el of host.querySelectorAll(".arc-item")) {
    el.onclick = () => {
      const it = arcItems.find((x) => x.sessionId === el.dataset.arcsid && x.taskId === el.dataset.arctask);
      if (it) arcOpenEntry(it);
    };
  }
}
/** 打开一块沉淀板:只读画布放进 ppf 灯箱;板全文走既有 board.get 通道(doc+连接三态一次拿全)。 */
let arcPrevTab = ""; // tab 化:灯箱宿主在「文件钻取」pane,打开时临时切过去,关闭后回原 tab
function arcOpenEntry(it) {
  if (bfOpen) bfToggle(false); // 画布全局单活:浮窗宿主先让位(内部把画布搬回大白板宿主)
  if (!arcOpen) arcPrevTab = projectTab;
  projectSetTab("files", true);
  arcOpen = true; arcSid = it.sessionId; arcTaskId = it.taskId;
  const bg = $("boardGraph");
  if (bg) bg.innerHTML = '<div class="cc-empty">画布正在档案「设计沉淀」灯箱中展示(只读)——关闭灯箱回到这里</div>'; // 单 cvHost 纪律(同 bdHome 浮窗指路牌)
  $("ppfGraphWrap").style.display = "flex";
  $("ppfGTitle").textContent = "设计沉淀(只读):" + it.title;
  $("ppfMermaid").innerHTML = '<div id="arcCv" style="position:relative;height:min(60vh,520px);min-height:340px;border:1px solid var(--border-soft);border-radius:10px;overflow:hidden"><div class="cc-empty">加载板…</div></div>' +
    '<div style="padding:6px 2px 0;display:flex;gap:10px;flex-wrap:wrap"><span class="bd-meta">沉淀于任务收官 · ' + it.nodeCount + " 节点 · 关联文件 " + (it.files || []).length + " 个</span>" +
    '<span class="bd-meta">只读快照——要改设计请回白板,要续码用「按板续作」</span></div>';
  if (ws && ws.readyState === 1) wsSafeSend(JSON.stringify({ v: 1, type: "board.get", sessionId: it.sessionId, taskId: it.taskId }));
}
/** 沉淀板的 board.doc 分流:只读渲染进灯箱宿主,不碰会话板全局(boardDoc/boardTaskId/boardLinks)。 */
function arcOnDoc(m) {
  const host = $("arcCv");
  if (!host) return;
  if (!m.doc) { host.innerHTML = '<div class="cc-empty">板不存在(已删除?)</div>'; return; }
  renderBoardCanvas(m.doc, { readonly: true, host, links: m.links || [] });
}
function arcClose() {
  arcOpen = false; arcSid = ""; arcTaskId = "";
  $("ppfGraphWrap").style.display = "none";
  $("ppfMermaid").innerHTML = "";
  cvRo = false; // 兜底复位(renderBoard 内 renderBoardCanvas 会按渲染重置;这里防 renderBoard 早退留下 ro 旗)
  renderBoard(); // 恢复大白板画布宿主(cvActiveHost 回位;无板=空态指引)
  if (arcPrevTab && arcPrevTab !== "files") projectSetTab(arcPrevTab, true); // 回打开前的 tab(通常=结构,沉淀列表所在)
  arcPrevTab = "";
}
$("arcRefresh").onclick = () => arcQuery();
$("ppfSearch").oninput = () => ppfRenderFiles();
$("ppWindow").onclick = () => { if (ppId) window.open("/profile?p=" + encodeURIComponent(ppId), "_blank"); };
$("projRow").title = "点击 → 新建任务(草稿);项目行「档案」→ 项目档案";

// ---- 插件市场 / 内嵌浏览器 / 账号额度 / 引导 / 附件 / 远程向导 ----
// ── 插件市场 ──
let mktCatalog = [];
const MKT_SOURCE_LABEL = { official: "官方", builtin: "内置", user: "自建" };
// 市场图标加载失败回退:首字母徽标(替代 <img>;回退字符走 data-fb,避免内联引号转义坑)
function mktIconFallback(img) {
  const s = document.createElement("span");
  s.className = "mkt-icon mkt-icon-fb";
  s.textContent = (img.dataset && img.dataset.fb) || "?";
  if (img.parentNode) img.parentNode.replaceChild(s, img);
}
function mktRender() {
  const host = $("mktGrid");
  if (!host) return;
  host.innerHTML = mktCatalog.length ? mktCatalog.map((m) => {
    const p = m.provides || {};
    const prov = [];
    if ((p.commands || []).length) prov.push("<b>" + p.commands.length + "</b> 命令");
    if ((p.skills || []).length) prov.push("<b>" + p.skills.length + "</b> 技能");
    if ((p.agents || []).length) prov.push("<b>" + p.agents.length + "</b> 子智能体");
    if ((p.mcp || []).length) prov.push("<b>" + p.mcp.length + "</b> MCP");
 // 官方市场条目:provides 安装时才展开,清单阶段用 componentTypes 预告组件构成
    if (m.source === "official" && !prov.length && (m.componentTypes || []).length)
      prov.push((m.componentTypes || []).map((t) => "<b>" + esc(t) + "</b>").join(" · "));
    const srcBadge = m.source ? '<span class="mkt-src mkt-src-' + esc(m.source) + '">' + (MKT_SOURCE_LABEL[m.source] || m.source) + "</span>" : "";
 // 图标对齐 ZCode 市场:官方包本地 icon.png;无图标(内置/用户/404)回退首字母徽标
    const initial = esc((m.name || m.id || "?").trim().slice(0, 1).toUpperCase());
    const iconHtml = m.icon
      ? '<img class="mkt-icon" src="/assets/' + esc(m.icon) + '" alt="" loading="lazy" data-fb="' + initial + '" onerror="mktIconFallback(this)">'
      : '<span class="mkt-icon mkt-icon-fb">' + initial + "</span>";
    return '<div class="mkt-card' + (m.installed ? " on" : "") + '" data-id="' + esc(m.id) + '">' +
      '<div class="mkt-head">' + iconHtml + '<span class="mkt-name">' + esc(m.name) + '</span><span class="mkt-pkg">' + esc(m.id) + '</span><span class="mkt-ver">v' + esc(m.version) + '</span><span class="mkt-cat">' + esc(m.category) + "</span>" + srcBadge + "</div>" +
      '<div class="mkt-desc">' + esc(m.description) + "</div>" +
      '<div class="mkt-prov">' + (prov.join(" · ") || "无资产") + "</div>" +
      '<div class="mkt-btns">' +
      (m.installed
        ? '<button data-act="toggle">' + (m.enabled ? "停用" : "启用") + '</button><button class="danger" data-act="uninstall">卸载</button>'
        : '<button data-act="install">安装</button>') +
      "</div></div>";
  }).join("") : '<div class="cc-empty">目录为空(可在本地扩展)</div>';
  for (const card of host.querySelectorAll(".mkt-card")) {
    for (const b of card.querySelectorAll("button")) {
      b.onclick = () => {
        const id = card.dataset.id;
        const act = b.dataset.act;
        if (act === "install") {
          const m = mktCatalog.find((x) => x.id === id);
 // 官方市场包:第三方资产落地+MCP 注册,安装前使用者授权确认
          if (m && m.source === "official") {
            const comps = (m.componentTypes || []).join("/") || "资产包";
            uiConfirm("安装官方插件 " + m.name + " v" + m.version + "?\\n将分发:" + comps + "(命令/技能/子智能体按包落地,MCP 服务器注册到网关)\\n来源:ZCode 官方市场", { tone: "info" })
              .then((ok) => { if (ok) wsSafeSend(JSON.stringify({ v: 1, type: "plugins.install", id })); else b.textContent = "安装"; });
          } else {
            wsSafeSend(JSON.stringify({ v: 1, type: "plugins.install", id }));
          }
        }
        else if (act === "uninstall") { uiConfirm("卸载该插件?(其资产将被精确回收)", { tone: "danger" }).then((ok) => { if (ok) wsSafeSend(JSON.stringify({ v: 1, type: "plugins.uninstall", id })); }); }
        else { const m = mktCatalog.find((x) => x.id === id); wsSafeSend(JSON.stringify({ v: 1, type: "plugins.toggle", id, enabled: !m.enabled })); }
        b.textContent = "…";
        setTimeout(() => wsSafeSend(JSON.stringify({ v: 1, type: "plugins.list" })), 500);
      };
    }
  }
  const inst = $("mktInstalled");
  if (inst) {
    const ins = mktCatalog.filter((x) => x.installed);
    inst.innerHTML = ins.length ? ins.map((m) => mgrRow(m.name, m.enabled ? "启用中" : "已停用", m.description, "v" + m.version, "")).join("") : '<div class="cc-empty">无</div>';
  }
}
$("mktRefresh").onclick = () => wsSafeSend(JSON.stringify({ v: 1, type: "plugins.list" }));
// ── 内置浏览器 ──
function isHttpUrl(u) { return u.indexOf("http://") === 0 || u.indexOf("https://") === 0; }
function brGo() {
  let u = $("brUrl").value.trim();
  if (!u) return;
  if (!isHttpUrl(u)) u = "https://" + u;
  $("brUrl").value = u;
  $("brFrame").src = u;
}
$("brGo").onclick = brGo;
$("brUrl").onkeydown = (e) => { if (e.key === "Enter") brGo(); };
$("brExt").onclick = () => { let u = $("brUrl").value.trim(); if (u) window.open(isHttpUrl(u) ? u : "https://" + u, "_blank"); };
$("browser-open-view").onclick = () => switchView("browser");
/* ---- 内置浏览器视图(移植 ZCode UnifiedBrowserView;宿主只做 WS 桥 + 挂载) ---- */
let gbvMounted = false;
function gbvSend(payload) { wsSafeSend(JSON.stringify({ v: 1, ...payload })); }
function brMount() {
  var G = window.GenieBrowserView; var host = $("gbvHost");
  if (!G || !host || gbvMounted) return;
  try {
    G.mount(host, {
      send: gbvSend,
      openExternal: function (u) { if (!u) return; window.open(u, "_blank", "noopener"); },
    });
    gbvMounted = true;
  } catch (e) { if ($("brNote")) $("brNote").textContent = "内置浏览器视图加载失败:" + (e && e.message ? e.message : e); }
}
function brSubscribe() { brMount(); gbvSend({ type: "browser.view.open" }); if ($("brNote")) $("brNote").textContent = "已请求连接:等待 agent 侧打开页面…"; }
function brUnsubscribe() { gbvSend({ type: "browser.view.close" }); if ($("brNote")) $("brNote").textContent = "已断开截图流。"; }
/** iframe 兜底开关:旧形态零改动保留(#brFrame 恒在,#brLegacyBar 显隐即可)。 */
function brLegacyToggle() {
  var bar = $("brLegacyBar"); var fr = $("brFrame");
  if (!bar || !fr) return;
  var show = bar.hasAttribute("hidden");
  if (show) { bar.removeAttribute("hidden"); fr.removeAttribute("hidden"); if ($("brUrl")) $("brUrl").focus(); }
  else { bar.setAttribute("hidden", ""); fr.setAttribute("hidden", ""); }
}
if ($("brOpenView")) $("brOpenView").onclick = brSubscribe;
if ($("brCloseView")) $("brCloseView").onclick = brUnsubscribe;
if ($("brLegacy")) $("brLegacy").onclick = brLegacyToggle;
// ── 浏览器控制设置(cfg 持久化) ──
function browserCfgRender() {
  const c = (cfgView && cfgView.config && cfgView.config.browser) || {};
  const on = c.enabled === true;
  for (const b of $("set-browser").querySelectorAll("button")) b.classList.toggle("on", (b.dataset.v === "on") === on);
  const inp = $("browser-domains");
  if (document.activeElement !== inp) inp.value = (c.allowDomains || []).join(",");
}
$("set-browser") && $("set-browser").querySelectorAll("button").forEach((b) => {
  b.onclick = () => {
    const on = b.dataset.v === "on";
    wsSafeSend(JSON.stringify({ v: 1, type: "cfg.set", patch: { browser: { enabled: on } } }));
    toast("browser 工具" + (on ? "已启用(热生效)" : "已停用"));
    setTimeout(refreshModelPill, 400);
  };
});
$("browser-domains-apply").onclick = () => {
  const ds = $("browser-domains").value.split(",").map((x) => x.trim()).filter(Boolean);
  wsSafeSend(JSON.stringify({ v: 1, type: "cfg.set", patch: { browser: { allowDomains: ds } } }));
  toast("域名白名单 → " + (ds.length ? ds.join(",") : "全允许"));
};
// ── 账号与额度 ──
function acctRender() {
  const host = $("acctId");
  if (!host) return;
  sendOrQueue({ v: 1, type: "nodes.list" });
}
function acctRenderNodes(m) {
  const host = $("acctId");
  if (!host) return;
  const id = m.identity || {};
  host.innerHTML = '<span class="id-badge">身份:<b>' + esc(id.mode || "本地") + "</b></span>" +
    (id.fingerprint ? '<span class="id-badge">指纹 <b>' + esc(id.fingerprint) + "</b>(ed25519)</span>" : "") +
    '<span class="id-badge">套餐:<b>自托管</b>(无计费)</span>';
}
function quotaRender() {
  const host = $("quotaCards");
  if (!host || !statsCache || !statsCache.data) return;
  const q = statsCache.data.quota;
  if (!q) return;
  const pct = q.budget > 0 ? Math.min(100, Math.round((q.week / q.budget) * 100)) : 0;
  const fmtK2 = (n) => (n >= 1e8 ? (n / 1e8).toFixed(2) + "亿" : n >= 10000 ? (n / 1e4).toFixed(1) + "万" : String(n));
  host.innerHTML =
    '<div class="quota-card"><div class="qv">' + fmtK2(q.today) + '</div><div class="qk">今日 token</div><div class="qr">每天 ' + new Date(q.resetAt).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" }) + ' 重置</div></div></div>' +
    '<div class="quota-card"><div class="qv">' + fmtK2(q.week) + '</div><div class="qk">本周 token</div><div class="qr">周起 ' + new Date(q.weekStartAt).toLocaleDateString() + (q.budget > 0 ? " · 预算 " + fmtK2(q.budget) : "") + '</div>' +
    (q.budget > 0 ? '<div class="quota-bar"><i class="' + (pct >= 100 ? "over" : "") + '" style="width:' + pct + '%"></i></div><div class="qr">' + pct + "%" + (pct >= 100 ? " · 已超预算" : "") + "</div>" : "") + "</div>";
  const inp = $("quota-budget");
  if (inp && document.activeElement !== inp && q.budget >= 0) inp.value = String(q.budget);
}
$("quota-apply").onclick = () => {
  const v = Math.max(0, parseInt($("quota-budget").value) || 0);
  wsSafeSend(JSON.stringify({ v: 1, type: "cfg.set", patch: { quota: { weeklyTokens: v } } }));
  toast("周预算 → " + (v ? v + " token" : "不设限"));
  setTimeout(() => { statsCache = null; statsFetch(true); }, 500);
};
// ── 远程连接向导 + 节点表 + 电脑控制 ──
function wizGen(kind) {
  const host = $("wiz-host").value.trim();
  if (kind === "ssh" && !host) { toast("先填主机地址", true); return; }
  wsSafeSend(JSON.stringify({ v: 1, type: "wizard.gen", kind, host, user: $("wiz-user").value.trim() || "root", port: Number($("wiz-port").value) || 22, nodeId: $("wiz-nodeid").value.trim() || "remote-node" }));
}
$("wiz-ssh").onclick = () => wizGen("ssh");
// SSH 凭证管理:密码→secrets 精确键+一键连通测试;面板绝不回显密码
$("sshcred-save").onclick = () => {
  const host = $("sshcred-host").value.trim();
  const user = $("sshcred-user").value.trim();
  const port = Number($("sshcred-port").value.trim()) || 22;
  const pass = $("sshcred-pass").value;
  if (!host || !user || !pass) { toast("主机/用户/密码都要填", true); return; }
  const key = "GENIE_SSH_" + host.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_" + user.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  sshCredPending = { host, user, port };
  $("sshCredOut").textContent = "写入 secrets(" + key + ")并测试连接…";
  wsSafeSend(JSON.stringify({ v: 1, type: "cfg.secret.set", name: key, value: pass, rid: "sshcred" }));
  $("sshcred-pass").value = "";
};
let sshCredPending = null;
$("wiz-docker").onclick = () => wizGen("docker");
// ── 审批中心(二期, §0「审批不阻断」整页形态;
// 丰满:风险标签/TTL 倒计时/会话链接/批量操作/最近决定/统一应答口) ──
let approvalQueue = new Map();
let approvalHistory = []; // 最近决定(broker 内存 ring 回包;重启即失,持久化登记后续)
const GATE_RISK_ZH = { low: "低", medium: "中", high: "高" };
/** 决议来源中文标签(permission.resolved.by / history.by)。 */
function gateByZh(by) {
  return { panel: "面板", timeout: "超时自动拒", offline: "离线自动拒", policy: "会话策略直通", "object-changed": "对象复核失败", "object-snapshot-failed": "对象快照失败" }[String(by)] || String(by || "?");
}
function gateRowHtml(a) {
  const risk = String(a.risk || "medium");
  const left = Math.max(0, Math.ceil((a.since + (a.timeoutMs || 60000) - Date.now()) / 1000));
  return '<div class="sup-row" data-aprow="' + esc(a.requestId) + '">' +
    '<div class="sup-row-h"><span class="sup-badge' + (risk === "high" ? " failed" : "") + '">风险' + esc(GATE_RISK_ZH[risk] || risk) + '</span>' +
    '<span class="sup-it" style="font-weight:600">' + esc(a.tool) + '</span>' +
    '<span class="sup-mono">' + esc(ago2(a.since)) + '</span>' +
    '<span class="gate-ttl" data-ttl="' + esc(a.requestId) + '" data-deadline="' + (a.since + (a.timeoutMs || 60000)) + '">' + left + "s</span></div>" +
    '<div class="sup-sum">' + esc(a.summary) + '</div>' +
    '<div class="sup-acts">' +
    '<button class="sup-btn pri" data-rid="' + esc(a.requestId) + '" data-dec="allow-once">允许一次</button>' +
    '<button class="sup-btn" data-rid="' + esc(a.requestId) + '" data-dec="allow-always">总是允许</button>' +
    '<button class="sup-btn" data-rid="' + esc(a.requestId) + '" data-dec="reject">拒绝</button>' +
    (a.sessionId ? '<button class="sup-btn mut" data-apopen="' + esc(a.sessionId) + '" title="打开对应会话">会话</button>' : "") +
    "</div></div>";
}
function renderApprovals() {
  const host = $("approvals-body");
  if (!host) return;
  const asks = [...approvalQueue.values()].sort((a, b) => a.since - b.since);
  const cnt = $("approvalsCount");
  if (cnt) cnt.textContent = asks.length ? "· 待处理 " + asks.length : "";
  const parts = [];
  if (asks.length) {
    parts.push('<div class="sup-acts" style="margin-bottom:8px;align-items:center">' +
      '<button class="sup-btn pri" id="apAllowAll">全部允许一次(' + asks.length + ')</button>' +
      '<button class="sup-btn" id="apRejectAll">全部拒绝</button>' +
      '<span class="sup-mono">不处理的请求 ' + Math.round((asks[0].timeoutMs || 60000) / 1000) + ' 秒后自动拒绝(fail-closed)</span></div>');
  }
  parts.push(asks.length
    ? asks.map(gateRowHtml).join("")
    : '<div class="sup-empty">没有挂起审批。coding agent 需要授权时,请求会实时出现在这里;' +
      Math.round(60000 / 1000) + ' 秒内未处理会被自动拒绝(fail-closed:宁拒不悬)。</div>');
 // 最近决定:本页生命周期内的真实收敛记录(broker 内存 ring;重启清零)。
  parts.push('<details class="sup-sec" style="margin-top:8px"><summary class="sup-sec-h" style="cursor:pointer">最近决定(' + approvalHistory.length + ')</summary><div class="sup-list" style="margin-top:6px">' +
    (approvalHistory.length
      ? approvalHistory.slice().reverse().map((h) => '<div class="sup-row"><div class="sup-row-h">' +
          '<span class="sup-badge' + (h.decision === "allow-once" ? "" : " failed") + '">' + (h.decision === "allow-once" ? "允许" : "拒绝") + '</span>' +
          '<span class="sup-it">' + esc(h.tool) + " · " + esc(supClip(h.summary, 64)) + '</span>' +
          '<span class="sup-mono">' + esc(gateByZh(h.by)) + " · " + esc(ago2(h.settledAt)) + '</span>' +
          (h.sessionId ? '<button class="sup-btn mut" data-apopen="' + esc(h.sessionId) + '">会话</button>' : "") +
          "</div></div>").join("")
      : '<div class="sup-empty">还没有决议记录(打开本视图后产生的决定会记在这里;重启后清零)。</div>') +
    "</div></details>");
  host.innerHTML = parts.join("");
  const allowAll = $("apAllowAll");
  if (allowAll) allowAll.onclick = () => { for (const a of [...approvalQueue.values()]) permRespondUnified(a.requestId, "allow-once"); };
  const rejAll = $("apRejectAll");
  if (rejAll) rejAll.onclick = () => uiConfirm("拒绝全部 " + approvalQueue.size + " 条挂起审批?对应工具调用会立即失败(fail-closed)。", { tone: "danger" }).then((ok) => {
    if (ok) for (const a of [...approvalQueue.values()]) permRespondUnified(a.requestId, "reject");
  });
}
// TTL 倒计时逐秒刷新(只改文本不整面重渲,避免打断选择/焦点;≤10s 变红)。
setInterval(() => {
  if (!viewLive("approvals")) return;
  document.querySelectorAll("#approvals-body [data-ttl]").forEach((el) => {
    const dl = Number(el.getAttribute("data-deadline") || 0);
    const left = Math.max(0, Math.ceil((dl - Date.now()) / 1000));
    el.textContent = left + "s";
    el.classList.toggle("hot", left <= 10);
  });
}, 1000);
// 事件委托(模板转义族坑:内联 onclick 转义已三踩,一律 data 属性+委托)
document.addEventListener("click", (e) => {
  const b = e.target && e.target.closest ? e.target.closest("button[data-rid]") : null;
  if (b) {
    const requestId = b.getAttribute("data-rid");
    const decision = b.getAttribute("data-dec");
    const a = approvalQueue.get(requestId);
    permRespondUnified(requestId, decision, decision === "allow-always" && a ? { permission: a.tool, pattern: "*" } : undefined);
    return;
  }
  const open = e.target && e.target.closest ? e.target.closest("button[data-apopen]") : null;
  if (open) { const sid = open.getAttribute("data-apopen"); if (sid) openSession(sid); }
});
$("approvals-refresh").onclick = () => { wsSafeSend(JSON.stringify({ v: 1, type: "permission.pending" })); wsSafeSend(JSON.stringify({ v: 1, type: "permission.history", limit: 20 })); };
// 三卡「刷新」:发出查询即垫 loading 态——
// 此前点刷新后旧内容原样停着,用户无法判断是「没数据」还是「还没回来」。
function bd3Loading(hostId, text) {
  const el = $(hostId);
  if (el) el.innerHTML = '<div class="cc-empty loading">' + esc(text) + "</div>";
}
$("subchat-refresh").onclick = () => subMsgRender(); // 双栏骨架常驻:不垫 loading(会掀掉 #subchat-list/#subchat-pane 宿主),重渲本身即时;n3 融合后并承担原分身卡「刷新」职责(目录态随 session.status 轮询)
$("track-refresh").onclick = () => { bd3Loading("track-body", "读取任务追踪…"); trackPull(); };
$("usage-refresh").onclick = () => { bd3Loading("usage-body", "读取用量统计…"); wsSafeSend(JSON.stringify({ v: 1, type: "usage.view" })); };

// ── 运行看板(参考项目 dashboard 融合:会话状态灯/趋势/干预/子代理/权限拒绝/板角标) ──
// 数据源=journal(服务端 dashboard-collector/trends 纯函数折算);推送=WS dashboard.changed
// (journal 订阅节流广播),取数=dashboard.sessions/trends 拉模型——ref 的独立 HTTP+SSE
// server 与端口在此收编进既有 WS 总线,功能面 1:1。
// 作用域(每项目一块看板:不再持久化——
// 进看板子标签即锁定当前激活项目(dashLockScope);可临时切换全部/其他项目/未归属(手动选择后
// 本页会话内保持);项目注册表变化时若仍在自动挡则跟随新项目。会话级内存态,刷新后重新锁定。
let dashScope = "all";
let dashScopeAuto = true; // true=跟随当前项目(进看板/项目切换时重锁);手动切换作用域后翻 false
/** n9 看板作用域锁定:会话归属项目优先(ownerProjectId),缺席回退 activeProjectId——与档案卡同口径,
 * 避免「切了会话,看板还是上一个项目的账」。手动选过作用域(dashScopeAuto=false)则不覆写。 */
function dashLockScope() { if (!dashScopeAuto) return; dashScope = ownerProjectId() === "__harness__" ? (activeProjectId || "all") : ownerProjectId(); }
let dashScopeLive = "all";
let dashSessions = null;   // null=未首载(区别于空数组=确实无会话)
let dashTrends = null;
let dashArchive = [];      // C:设计沉淀索引(board.archive.list 全量;按 sessionId 数条目)
let dashPushAt = 0;
let dashReloadTimer = null;
// n6 兜底重拉:dashboard.changed 到达时白板/追踪视图在场也要跟着重拉(不只靠 board.changed)。
// 白板侧 1000ms 节流水位 + 尾沿补拉(bdDashPullTimer);追踪卡 800ms 尾沿防抖(trackDashTimer)。
let bdDashPullAt = 0;
let bdDashPullTimer = null;
let trackDashTimer = null;
// n7 手动压缩可见性:压缩请求在途标记(收到 session.compact.result 或 20s 超时清除)。
let compactPending = false;
let compactPendingTimer = null;
// 板 n3:压缩进行中标记(session.compact.status phase=started 置位,终态帧清除);
// 存在时 renderHistory 在流尾追加「正在压缩上下文…」行,压缩期间面板即时有反馈(不再只有按钮忙态)。
let compactInflight = null;
let dashSel = null;        // 详情抽屉当前会话
let dashTrack = "";        // 轨道过滤(客户端;''=全部)
let dashBarMode = localStorage.getItem("zh:dash-bar") || "tokens"; // 趋势柱:tokens|llm
const DASH_STATUS = { running: ["运行中", "run"], waiting_for_input: ["等输入", "wait"], error: ["出错", "err"], idle: ["空闲", "idle"], stopped: ["已结束", "stop"] };
/** 看板「仅当前会话」档的哨兵值(与项目档互斥;项目 id 不会长成这个名字)。 */
const SESSION_SCOPE = "__session__";
function sessionScopeOn() { return dashScope === SESSION_SCOPE; }
function dashWsSend(obj) { if (ws.readyState === 1) wsSafeSend(JSON.stringify(obj)); } // 重连窗(CONNECTING)静默跳过:看板是旁观面,丢了下个周期自愈
function dashSend() {
 // 会话档:__session__ 不是项目 id(服务端只认 projectId),按「全部」取数后前端按 sid 过滤
  const pid = dashScope === "all" || dashScope === SESSION_SCOPE ? null : dashScope;
  dashWsSend({ v: 1, type: "dashboard.sessions", projectId: pid });
  dashWsSend({ v: 1, type: "dashboard.trends", projectId: pid });
}
function dashLoad() { dashSend(); dashWsSend({ v: 1, type: "board.archive.list" }); }
function dashNum(n) { return new Intl.NumberFormat().format(Number(n) || 0); }
function dashDur(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m";
}
function dashAgo(ts) {
  const ms = Date.now() - (Number(ts) || 0);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 5000) return "刚刚";
  return (ms < 60000 ? Math.floor(ms / 1000) + "s" : ms < 3600000 ? Math.floor(ms / 60000) + "m" : Math.floor(ms / 3600000) + "h") + "前";
}
function dashWhen(ts) { const d = new Date(Number(ts) || 0); return isNaN(d.getTime()) ? "—" : d.toLocaleString(); }
// 会话轨道(sessionId 前缀=来源;ref「AI tool」列的本地对应物)
function dashTrackOf(sid) {
  if (/^wf-/.test(sid)) return "workflow";
  if (/^companion/.test(sid)) return "companion";
  if (/^web-/.test(sid)) return "web";
  if (/^smoke-/.test(sid)) return "smoke";
  if (/^team:/.test(sid)) return "team"; // fixD6:P2P 观测事件独立轨(不混进任务轨)
  return "任务";
}
function dashProjectLabel(pid) {
  if (!pid) return "未归属";
  const p = (projects || []).find((x) => x.id === pid);
  return p ? p.label : pid.slice(0, 8);
}
function dashFmtTrend(value, kind) {
  if (value === null || value === undefined) return dashTrends ? "—" : "…";
  if (kind === "pct") return Math.round(value * 100) + "%";
  if (kind === "dur") return dashDur(value);
  return (Number(value) || 0).toFixed(1);
}
function dashMetricCard(title, key, kind) {
  const cur = dashTrends ? dashTrends.current[key] : null;
  const prev = dashTrends ? dashTrends.previous[key] : null;
  const prevTxt = dashTrends ? (prev === null || prev === undefined ? "无终态会话" : dashFmtTrend(prev, kind)) : "…";
  return '<div class="dash-card"><div class="dash-card-t">' + esc(title) + "</div>" +
    '<div class="dash-big">' + dashFmtTrend(cur, kind) + "</div>" +
    '<div class="dash-sub">前7天:' + esc(prevTxt) + "</div></div>";
}
function dashBarChart() {
  const daily = (dashTrends && dashTrends.daily) || [];
  if (!daily.length) return '<div class="dash-card"><div class="dash-card-t">近14天无终态会话</div></div>';
  const val = (b) => dashBarMode === "llm" ? (b.llmMs || 0) : (b.tokensIn || 0) + (b.tokensOut || 0);
  const max = Math.max(1, ...daily.map(val));
  const bars = daily.map((b) => {
    const h = Math.round((val(b) / max) * 100);
    const tip = b.day + " · 会话" + b.sessionsEnded + " · token " + dashNum((b.tokensIn || 0) + (b.tokensOut || 0)) + " · LLM " + dashDur(b.llmMs || 0);
    return '<div class="dash-bar" style="height:' + Math.max(h, 2) + '%" title="' + esc(tip) + '"></div>';
  }).join("");
  return '<div class="dash-card"><div class="dash-card-t">近14天 ' + (dashBarMode === "llm" ? "LLM耗时" : "token") +
    ' <span class="dash-bar-toggle"><button class="vw-act' + (dashBarMode === "tokens" ? " on" : "") + '" data-dashbar="tokens">token</button>' +
    '<button class="vw-act' + (dashBarMode === "llm" ? " on" : "") + '" data-dashbar="llm">耗时</button></span></div>' +
    '<div class="dash-bars">' + bars + "</div>" +
    '<div class="dash-sub">' + esc(daily[0].day) + " ~ " + esc(daily[daily.length - 1].day) + "</div></div>";
}
function dashRow(s) {
  const st = DASH_STATUS[s.status] || [s.status, ""];
  const iv = s.interventions || {};
  const sa = s.subagents || { spawned: 0, results: 0, failed: 0 };
  const hasArc = dashArchive.some((a) => a.sessionId === s.sessionId);
  const end = s.stoppedAt || Date.now();
  const runtime = dashDur(end - s.startedAt);
  return '<tr class="dash-row' + (s.status === "stopped" || s.status === "error" ? " row-ended" : "") + '" data-dashsid="' + esc(s.sessionId) + '">' +
    '<td><div class="dash-prompt">' + esc(s.promptSummary || "(无用户消息)") + "</div>" +
    '<div class="dash-meta">' + esc(dashDur(s.durationMs)) + " · " + esc(dashAgo(s.lastActivity)) + " · 末工具 " + esc(s.lastTool || "—") + " · 全程 " + esc(runtime) + "</div></td>" +
    "<td>" + esc(dashProjectLabel(s.projectId)) + '<div class="dash-meta">' + esc(dashTrackOf(s.sessionId)) + (s.taskState ? " · " + esc(s.taskState) : "") + "</div></td>" +
    '<td class="dash-st-' + st[1] + '">' + esc(st[0]) + "</td>" +
    "<td>" + dashNum(s.promptCount) + '<div class="dash-meta">' + dashNum(s.turns) + "轮/" + dashNum(s.toolCalls) + "工具</div></td>" +
    '<td title="打断 ' + (iv.interrupt || 0) + " · 拒绝 " + (iv.denied || 0) + " · 纠正 " + (iv.correction || 0) + '">' + dashNum(s.interventionCount) + "</td>" +
    '<td title="入 ' + dashNum(s.tokens.input) + " / 出 " + dashNum(s.tokens.output) + '">' + dashNum(s.tokens.total) + "</td>" +
    '<td title="派 ' + sa.spawned + " / 收 " + sa.results + " / 败 " + (sa.failed || 0) + '">' + dashNum(sa.spawned) + (sa.failed ? '<span class="dash-bad"> 败' + sa.failed + "</span>" : "") + "</td>" +
    "<td>" + dashNum(s.boards || 0) + (hasArc ? '<span class="dash-arc" title="有已沉淀板">沉</span>' : "") + "</td>" +
    '<td><button class="vw-act" data-dashdetail="' + esc(s.sessionId) + '">详情</button></td></tr>';
}
/** 会话档:起作用域=仅当前会话时
 * 只留当前 sid 的行;无选中会话=空表(不回落显示别的会话,避免误读)。 */
function dashScoped(list) {
  const all = list || [];
  if (!sessionScopeOn()) return all;
  const sid = currentSid || "";
  return sid ? all.filter((s) => s.sessionId === sid) : [];
}
/** 看板会话档作用域判定见上面 SESSION_SCOPE/sessionScopeOn(声明前移到 dashSend 之前防 TDZ)。 */
function dashTable() {
  if (dashSessions === null) return '<div class="cc-empty">加载看板中…</div>';
  const scoped = dashScoped(dashSessions);
  const rows = scoped.filter((s) => !dashTrack || dashTrackOf(s.sessionId) === dashTrack);
  if (!rows.length) return '<div class="cc-empty">' + (dashScope === "__session__" && !currentSid ? "当前没有选中会话——在对话卡提一个需求后,这里只显示该会话"
    : scoped.length ? "当前过滤无会话" : "暂无活跃会话——跑一个任务,状态灯会实时亮起") + "</div>";
  const active = rows.filter((s) => s.status !== "stopped" && s.status !== "error");
  const ended = rows.filter((s) => s.status === "stopped" || s.status === "error");
  const sec = (title, list) => list.length ? '<section class="dash-sec"><div class="dash-sec-h">' + esc(title) + ' <span class="dash-cnt">' + list.length + "</span></div>" +
    '<div class="dash-scroll"><table class="dash-table"><thead><tr><th>首条指令 / 活动</th><th>项目 / 轨道</th><th>状态</th><th>轮次</th><th title="打断+拒绝+纠正">干预</th><th>Token</th><th title="派生/回收/失败">子代理</th><th title="白板更新(沉=有已沉淀板)">板</th><th></th></tr></thead><tbody>' +
    list.map(dashRow).join("") + "</tbody></table></div></section>" : "";
  return sec("活跃", active) + sec("近期结束", ended);
}
function dashDenialStrip() {
  const denied = [];
  for (const s of dashScoped(dashSessions)) for (const d of s.denials || []) denied.push({ ...d, sessionId: s.sessionId });
  denied.sort((a, b) => b.time - a.time);
  const top = denied.slice(0, 5);
  if (!top.length) return "";
  return '<div class="dash-denials"><b>最近权限拒绝</b>' + top.map((d) =>
    '<span class="dash-denial" title="' + esc(d.sessionId + " · " + (d.by || "")) + '">' + esc(d.tool || "?") + " · " + esc(dashAgo(d.time)) + "</span>").join("") + "</div>";
}
function dashRender() {
  if (!viewLive("dash")) return;
 // 作用域下拉:全部 + 项目注册表 + 未归属(ref workspace select 对应物;数据源=项目注册表)
  const sel = $("dashScope");
  const opts = ['<option value="all">全部</option>', '<option value="__session__">仅当前会话</option>']
    .concat((projects || []).map((p) => '<option value="' + esc(p.id) + '">' + esc(p.label) + "</option>"))
    .concat(['<option value="unassigned">未归属</option>']);
  sel.innerHTML = opts.join("");
  sel.value = dashScope;
  if (sel.value !== dashScope) { dashScope = "all"; sel.value = "all"; } // 项目被移除后残留作用域回退全部
 // 顶卡(ref overview 三卡对应物:会话/经验库/干预与拒绝)
  const live = dashScoped(dashSessions);
  const running = live.filter((s) => s.status === "running").length;
  const waiting = live.filter((s) => s.status === "waiting_for_input").length;
  const tokens = live.reduce((sum, s) => sum + (s.tokens.total || 0), 0);
  const denied = live.reduce((sum, s) => sum + ((s.interventions || {}).denied || 0), 0);
  const ivAll = live.reduce((sum, s) => sum + (s.interventionCount || 0), 0);
  $("dash-cards").innerHTML =
    '<div class="dash-card"><div class="dash-card-t">本机会话</div><div class="dash-big">' + (dashSessions === null ? "…" : dashNum(live.length)) + "</div>" +
    '<div class="dash-sub">运行 ' + dashNum(running) + " · 等输入 " + dashNum(waiting) + "</div></div>" +
    '<div class="dash-card"><div class="dash-card-t">经验库条目</div><div class="dash-big">' + dashNum((expItems || []).length) + '</div><div class="dash-sub">沉淀复用的团队上下文</div></div>' +
    '<div class="dash-card"><div class="dash-card-t">干预 / 拒绝</div><div class="dash-big">' + dashNum(ivAll) + "</div>" +
    '<div class="dash-sub">权限拒绝 ' + dashNum(denied) + " · token " + dashNum(tokens) + "</div></div>";
 // 趋势区(ref trendPanel 7天 vs 前7天 + C 阶段柱状图)
  $("dash-trend").innerHTML =
    '<div class="dash-card-grid">' +
    dashMetricCard("轮次 / 会话", "avgPrompts", "number") +
    dashMetricCard("成功率", "successRate", "pct") +
    dashMetricCard("纠正率", "correctionRate", "pct") +
    dashMetricCard("平均耗时", "avgDurationMs", "dur") +
    "</div>" +
    dashBarChart();
 // 会话表(活跃/近期结束两组,ref 同结构)
  const trackOpts = ["", "任务", "workflow", "companion", "web", "smoke", "team"].map((t) =>
    '<option value="' + t + '"' + (dashTrack === t ? " selected" : "") + ">" + (t ? t : "全部轨道") + "</option>").join("");
  $("dash-body").innerHTML = dashDenialStrip() +
    '<div class="dash-sec-h">会话 <select id="dashTrackSel" style="background:transparent;border:1px solid var(--border-soft);color:var(--text);border-radius:8px;font-size:11px;padding:2px 6px">' + trackOpts + "</select>" +
    ' <span class="dash-live" id="dashLiveDot">' + (dashPushAt && Date.now() - dashPushAt < 15000 ? "实时" : "轮询") + "</span></div>" +
    dashTable();
  $("dashLive").textContent = "会话状态灯 · 近7天趋势 · " + (dashPushAt && Date.now() - dashPushAt < 15000 ? "实时推送中" : "等待变更推送");
}
// 详情抽屉(ref session-dialog 对应物:活动/干预/token/全部轮次/末条输出/拒绝/子代理/白板)
function dashDetail(sid) {
  const s = (dashSessions || []).find((x) => x.sessionId === sid);
  if (!s) return;
  dashSel = sid;
  const iv = s.interventions || {};
  const sa = s.subagents || { spawned: 0, results: 0, failed: 0, backgrounded: 0 };
  const sec = (t, body) => "<section><h4>" + esc(t) + "</h4>" + body + "</section>";
  $("dashDetailBody").innerHTML =
    '<h3 class="dash-d-title">' + esc(s.promptSummary || "(无用户消息)") + "</h3>" +
    '<div class="dash-meta">' + esc(dashProjectLabel(s.projectId)) + " · " + esc(dashTrackOf(s.sessionId)) + " · " + esc(DASH_STATUS[s.status] ? DASH_STATUS[s.status][0] : s.status) + (s.taskState ? " · 任务" + esc(s.taskState) : "") + "</div>" +
    sec("活动", '<p class="dash-meta">' + esc(s.sessionId) + "</p><p>开始:" + esc(dashWhen(s.startedAt)) + "<br>最近活动:" + esc(dashWhen(s.lastActivity)) + "<br>活跃时长:" + esc(dashDur(s.durationMs)) + " · 末工具:" + esc(s.lastTool || "—") + "</p>") +
    sec("干预", "<p>打断:" + dashNum(iv.interrupt) + " · 权限拒绝:" + dashNum(iv.denied) + " · 纠正式追问:" + dashNum(iv.correction) + "</p>" +
      ((s.denials || []).length ? '<p class="dash-meta">' + s.denials.map((d) => esc((d.tool || "?") + "·" + dashAgo(d.time))).join(" / ") + "</p>" : "")) +
    sec("Token / 耗时", "<p>输入:" + dashNum(s.tokens.input) + " · 输出:" + dashNum(s.tokens.output) + " · 合计:" + dashNum(s.tokens.total) + "<br>LLM 累计:" + dashDur(s.llmMs) + " · 工具调用:" + dashNum(s.toolCalls) + "</p>") +
    sec("子代理 / 白板", "<p>派生:" + dashNum(sa.spawned) + " · 回收:" + dashNum(sa.results) + " · 失败:" + dashNum(sa.failed) + " · 转后台:" + dashNum(sa.backgrounded) + "<br>白板更新:" + dashNum(s.boards) + " 次 · 沉淀板:" + dashNum(dashArchive.filter((a) => a.sessionId === s.sessionId).length) + " 块</p>") +
    sec("用户轮次(" + dashNum(s.promptCount) + ")", (s.prompts || []).map((p, i) => '<p class="dash-prompt"><b>' + (i + 1) + ".</b> " + esc(p) + "</p>").join("") + (s.promptCount ? "" : '<p class="dash-meta">无</p>')) +
    sec("末条 AI 输出", '<p class="dash-md">' + esc(s.stoppedOutput || "(暂无输出)") + "</p>");
  $("dashDrawer").classList.add("open");
}
function dashDetailClose() { $("dashDrawer").classList.remove("open"); dashSel = null; }
$("dashScope").onchange = () => { dashScope = $("dashScope").value || "all"; dashScopeAuto = false; dashLoad(); }; // 手动切换=脱离自动锁定
$("dash-refresh").onclick = () => dashLoad();
// 事件委托(模板转义族坑:内联 onclick 禁用,一律 data 属性+委托;行点击=开详情,按钮不受影响)
document.addEventListener("click", (e) => {
  if (!e.target || !e.target.closest) return;
  const bar = e.target.closest("[data-dashbar]");
  if (bar) { dashBarMode = bar.getAttribute("data-dashbar"); localStorage.setItem("zh:dash-bar", dashBarMode); dashRender(); return; }
  const det = e.target.closest("[data-dashdetail]");
  if (det) { dashDetail(det.getAttribute("data-dashdetail")); return; }
  if (e.target.closest("[data-dashclose]")) { dashDetailClose(); return; }
  const tr = e.target.closest("tr.dash-row");
  if (tr && !e.target.closest("button")) dashDetail(tr.getAttribute("data-dashsid"));
});
document.addEventListener("change", (e) => {
  if (e.target && e.target.id === "dashTrackSel") { dashTrack = e.target.value || ""; dashRender(); }
});
// 详情抽屉 ESC 关闭
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && dashSel) dashDetailClose(); });
// 30s 趋势自刷新(ref setInterval loadTrends 对应物)+ 15s 对账(状态灯超时窗到期自愈,ref 15s reconcile 同语义)
setInterval(() => { if (viewLive("dash") && !document.hidden) dashWsSend({ v: 1, type: "dashboard.trends", projectId: dashScope === "all" ? null : dashScope }); }, 30000);
setInterval(() => { if (viewLive("dash") && !document.hidden) dashLoad(); }, 15000);
// 实时徽标衰减(推送停了就从「实时」回落「轮询」,不撒谎)
setInterval(() => { if (viewLive("dash")) { const el = $("dashLiveDot"); if (el) el.textContent = dashPushAt && Date.now() - dashPushAt < 15000 ? "实时" : "轮询"; } }, 5000);

// ── 团队视图 ──
const TEAM_STATE_LABEL = { online: "在线", coding: "写码中", reviewing: "评审中", away: "离开", dnd: "勿扰", offline: "离线" };
function renderTeam(orgs, projectTeam, projectTeams) {
  const host = $("team-orgs");
  if (!host) return;
  lastTeamOrgs = orgs;
 // 项目绑定团队分区(git remote ↔ roster projects.repo → 真成员在线态 + git 贡献者候选)
 // 扩全项目:projectTeams=全部可见项目各一份(此前只画激活项目=「团队页只有 harness」);
 // 旧网关无 projectTeams 字段时回退激活项单卡。
  let projectHtml = "";
  {
    const list = (Array.isArray(projectTeams) && projectTeams.length) ? projectTeams : (projectTeam && projectTeam.label ? [projectTeam] : []);
    if (!list.length) {
      projectHtml = '<div class="cc-empty" style="text-align:left">项目团队:暂无可见项目——先在项目面板添加/激活项目,团队命令将绑定其 git 成员</div>';
    } else {
      projectHtml = list.map((pt) => {
        const bound = pt.bound;
        const members = [];
        for (const src of pt.sources || []) for (const mm of src.members || []) members.push({ ...mm, org: src.url });
        const cand = pt.candidates || [];
        const memberRows = members.length
          ? members.map((p) => {
              const dot = { online: "#6fae7a", coding: "#6fae7a", reviewing: "#c9a25e", away: "#9a8f7a", dnd: "#c0564f", offline: "#555" }[p.state] || "#555";
              return '<div class="mgr-row"><span style="width:8px;height:8px;border-radius:50%;background:' + dot + ';flex-shrink:0"></span>' +
                '<span class="m-name">' + esc(p.username) + '</span><span class="m-desc">' + (TEAM_STATE_LABEL[p.state] || esc(p.state)) + '</span>' +
                '<span class="m-meta">' + esc(String(p.fingerprint).slice(0, 12)) + "</span></div>";
            }).join("")
          : '<div class="cc-empty">该项目暂无已入册成员在线(roster projects 未含本项目)</div>';
        const candRows = cand.slice(0, 12).map((c) =>
          '<div class="mgr-row"><span class="m-name">' + esc(c.name) + '</span><span class="m-desc">' + esc(c.email || "-") + '</span><span class="m-meta">' + c.commits + " 次提交 · 候选</span></div>").join("");
        return '<div class="tcard" style="border-left:2px solid var(--bronze);padding:10px 12px;background:rgba(201,143,69,.05)">' +
          '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap">' +
          '<b style="font-size:12.5px">项目团队:' + esc(pt.label) + "</b>" +
          '<span style="font-size:9.5px;color:' + (bound ? "var(--bronze)" : "var(--faint)") + '">' + (bound ? "已绑定 roster 项目 " + esc(pt.projectId || "") : "未绑定 roster(仅候选视图;登记后可上线)") + "</span>" +
          (pt.remoteUrl ? '<span style="font-size:9px;color:var(--faint)">' + esc(String(pt.remoteUrl).slice(0, 48)) + "</span>" : '<span style="font-size:9px;color:var(--faint)">非 git 目录/无 origin</span>') +
          "</div>" +
          "<div style='font-size:9px;letter-spacing:1px;color:var(--faint);margin:6px 0 2px'>真 成 员(" + members.length + ")</div>" + memberRows +
          "<div style='font-size:9px;letter-spacing:1px;color:var(--faint);margin:10px 0 2px'>git 贡 献 者 候 选(" + cand.length + ")</div>" +
          (candRows || '<div class="cc-empty">无提交历史或非 git 目录</div>') +
          "</div>";
      }).join('<div style="height:8px"></div>');
    }
  }
 // teamai 团队仓资产分区(八类 Execution 资产计数+规则/技能索引;secrets 只显示 key 数)
  let teamaiHtml = "";
  {
    const t = typeof lastTeamaiRaw === "object" && lastTeamaiRaw ? lastTeamaiRaw : null;
    if (!t || !t.meta || (!t.rules?.length && !t.skills?.length && !t.envVars?.length && !t.hooks?.length && !(t.roles && t.roles.length) && !(t.learnings && t.learnings.length))) {
      teamaiHtml = "";
    } else {
      const meta = t.meta;
      const ruleRows = (t.rules || []).map((r) =>
        '<div class="mgr-row"><span class="m-name">rules/' + esc(r.name) + '</span><span class="m-desc">' + (r.enforced ? "强制注入" : "索引按需") + '</span><span class="m-meta">' + (String(r.body || "").length) + " 字</span></div>").join("");
      const skillRows = (t.skills || []).map((sk) =>
        '<div class="mgr-row"><span class="m-name">' + esc(sk.name) + '</span><span class="m-desc">' + esc((sk.description || "").slice(0, 50)) + '</span><span class="m-meta">' + esc((sk.contributors || []).join(",")) + "</span></div>").join("");
      const envRows = (t.envVars || []).map((v) =>
        '<div class="mgr-row"><span class="m-name">' + esc(v.key) + '</span><span class="m-desc">' + esc(v.description || "") + '</span><span class="m-meta">' + (v.value ? esc(v.value) : "-") + "</span></div>").join("");
      const hookRows = (t.hooks || []).map((h) =>
        '<div class="mgr-row"><span class="m-name">' + esc(h.id) + '</span><span class="m-desc">' + esc(h.event) + " " + esc(h.matcher || "") + '</span><span class="m-meta">tools: ' + esc((h.tools || []).join(",")) + "</span></div>").join("");
      const learnRows = (t.learnings || []).map((l, i) =>
        '<div class="mgr-row"><span class="m-name">' + esc(l.title || l.path) + '</span><span class="m-desc">' + esc((l.author || "") + (l.date ? " · " + l.date : "")) + '</span><span class="m-meta">' + esc((l.tags || []).join(",")) + ' <button class="vw-act" data-learn="' + i + '">看</button></span></div>').join("");
 // 角色卡( teamai 移植):ref roles 语义 = 资源命名空间集合,与 member.role 权限位不同源
      const roleRows = (t.roles || []).map((r) =>
        '<div class="mgr-row"><span class="m-name">' + esc(r.id) + '</span><span class="m-desc">' + esc(r.name || "") + (r.description ? " · " + esc(String(r.description).slice(0, 40)) : "") + '</span><span class="m-meta">skills ' + ((r.skills || []).length) + " · rules " + ((r.rules || []).length) + "</span></div>").join("");
 // 成员→角色映射(relay digest.memberRoles;旧网关无此字段=不显示徽标,不报错)
      const NL2 = String.fromCharCode(10);
      const sec = (title, rows, empty) => "<div style='font-size:9px;letter-spacing:1px;color:var(--faint);margin:8px 0 2px'>" + title + "</div>" + (rows || empty);
      teamaiHtml = '<div class="tcard" style="border-left:2px solid var(--bronze);padding:10px 12px;background:rgba(255,255,255,.02)">' +
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">' +
        '<b style="font-size:12.5px">teamai 团队仓' + (meta.team ? ":" + esc(meta.team) : "") + "</b>" +
        '<span style="font-size:9px;color:var(--faint)">skills ' + (t.skills || []).length + " · rules " + (t.rules || []).length + " · docs " + (t.docs || []).length + " · env " + (t.envVars || []).length + "(secrets " + (t.secretKeys || []).length + " 仅键名) · hooks " + (t.hooks || []).length + " · roles " + (t.roles || []).length + " · learnings " + (t.learnings || []).length + "</span>" +
        '<button class="vw-act" id="teamaiPullBtn" style="margin-left:auto">teamai pull</button></div>' +
        (meta.description ? '<div style="font-size:10px;color:var(--faint);margin-bottom:4px">' + esc(meta.description) + "</div>" : "") +
        sec("规 则", ruleRows, '<div class="cc-empty">无</div>') +
        sec("共 享 技 能", skillRows, '<div class="cc-empty">无</div>') +
        sec("角 色(资源命名空间)", roleRows, '<div class="cc-empty">roster/roles.yaml 未定义角色</div>') +
        sec("环 境 变 量", envRows, "") +
        sec("Hooks(claude 系形态,展示不自动安装)", hookRows, "") +
        sec("Learnings(团队学习沉淀,含上游分支)", learnRows, '<div class="cc-empty">暂无</div>') +
        "</div>";
    }
  }
  host.innerHTML = projectHtml + teamaiHtml + (orgs.length
    ? orgs.map((o) => {
        const memberRoles = (typeof lastTeamaiRaw === "object" && lastTeamaiRaw && lastTeamaiRaw.memberRoles) || {};
        const stateColor = { ready: "var(--bronze)", connecting: "var(--muted)", authenticating: "var(--muted)", disconnected: "#8a5a5a", rejected: "#c0564f" }[o.state] || "var(--muted)";
        const cards = (o.presence || []).map((p) => {
          const dot = { online: "#6fae7a", coding: "#6fae7a", reviewing: "#c9a25e", away: "#9a8f7a", dnd: "#c0564f", offline: "#555" }[p.state] || "#555";
          const taskLine = p.state === "coding" ? "在写代码" : p.state === "reviewing" ? "在评审" : "";
 // 角色徽标取自团队仓 roster roles(roleId),与权限位 role 分开显示,避免同名字段混淆
          const rid = memberRoles[p.username];
          const roleChip = rid ? ' <span style="font-size:9px;padding:0 4px;border:1px solid var(--bronze);border-radius:3px;color:var(--bronze)">' + esc(String(rid)) + "</span>" : "";
          return '<div class="mgr-row"><span style="width:8px;height:8px;border-radius:50%;background:' + dot + ';flex-shrink:0"></span>' +
            '<span class="m-name">' + esc(p.username) + roleChip + '</span>' +
            '<span class="m-desc">' + (TEAM_STATE_LABEL[p.state] || esc(p.state)) + (taskLine ? " · " + taskLine : "") + "</span>" +
            '<span class="m-meta">活跃 ' + ago2(p.lastActiveAt) + " · " + esc(String(p.fingerprint).slice(0, 12)) + "</span></div>";
        }).join("");
        const acts = (o.activity || []).slice(0, 12).map((e) =>
          '<div class="mgr-row"><span class="m-name">' + esc(e.userId) + '</span><span class="m-desc">' + esc(e.summary) + '</span><span class="m-meta">' + ago2(e.ts) + "</span></div>").join("");
        return '<div class="tcard" data-org="' + esc(o.url) + '" style="border-left:2px solid ' + stateColor + ';padding:10px 12px;background:rgba(255,255,255,.02)">' +
          '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' +
          '<b style="font-size:12.5px">' + esc(o.member ? o.member.username : "(未认证)") + "</b>" +
          '<span style="font-size:9px;color:var(--faint)">' + esc(o.url) + '</span>' +
          '<span style="font-size:9.5px;color:' + stateColor + '">' + (o.state === "ready" ? "已连接" : o.state === "rejected" ? "鉴权被拒" : o.state === "disconnected" ? "不可达(本地不受影响)" : o.state) + "</span>" +
          '<button class="vw-act" data-orginvite="' + esc(o.url) + '" style="margin-left:auto">邀请</button></div>' +
          "<div style='font-size:9px;letter-spacing:1px;color:var(--faint);margin:6px 0 2px'>成 员(" + (o.presence || []).length + ")</div>" + (cards || '<div class="cc-empty">暂无成员在线</div>') +
          "<div style='font-size:9px;letter-spacing:1px;color:var(--faint);margin:10px 0 2px'>活 动 流</div>" + (acts || '<div class="cc-empty">暂无活动</div>') +
          "</div>";
      }).join("")
    : '<div class="cc-empty">团队 relay 未启用——配置 RELAY_URL(单 org)或 RELAY_URLS(多 org,逗号分隔)后重启;红线:relay 不可达=本地功能零影响</div>');
}
document.addEventListener("click", (e) => {
  const b = e.target && e.target.closest ? e.target.closest("button[data-orginvite]") : null;
  if (!b) return;
  teamInviteFlow(b.getAttribute("data-orginvite"));
});
document.addEventListener("click", (e) => {
  if (e.target && e.target.id === "teamaiPullBtn") {
    wsSafeSend(JSON.stringify({ v: 1, type: "teamai.pull" }));
    toast("teamai pull:已触发团队仓重拉");
  }
  const lb = e.target && e.target.closest ? e.target.closest("button[data-learn]") : null;
  if (lb) {
    const i = Number(lb.getAttribute("data-learn"));
    const t = typeof lastTeamaiRaw === "object" && lastTeamaiRaw ? lastTeamaiRaw : null;
    const l = (t && t.learnings || [])[i];
    if (l) uiAlert(String(l.body || "").slice(0, 6000), { title: "【" + (l.title || l.path) + "】" + (l.author ? " · " + l.author + " · " + (l.date || "") : "") });
  }
});
// 邀请绑定激活项目(兑换后的 roster 条目自动带 projects,不由兑换者申报)
let lastProjectTeam = null;
let lastProjectTeams = null; // :全项目绑定切片(team.status.result.projectTeams)
let pendingShare = null;
function lastTeamaiDigest() {
  return lastTeamOrgs && lastTeamaiRaw ? lastTeamaiRaw : null;
}
let lastTeamaiRaw = null;
function inviteProjects() {
  if (lastProjectTeam && lastProjectTeam.projectId) return [lastProjectTeam.projectId];
  if (typeof activeProjectId !== "undefined" && activeProjectId && activeProjectId !== "__harness__") return [activeProjectId];
  return undefined;
}
function teamInviteFlow(orgUrl, presetName) {
  const projects = inviteProjects();
  if (presetName !== undefined) {
    if (!orgUrl) { toast("无已连接 org(relay 未启用)", true); return; }
    wsSafeSend(JSON.stringify({ v: 1, type: "team.invite", orgUrl, displayName: presetName, ...(projects ? { projects } : {}) }));
    return;
  }
  uiPrompt("被邀请人显示名(可选,直接确定=匿名邀请):", "", { allowEmpty: true }).then((name) => {
    if (name === null) return;
    wsSafeSend(JSON.stringify({ v: 1, type: "team.invite", orgUrl, ...(name ? { displayName: name } : {}), ...(projects ? { projects } : {}) }));
  });
}
window.__teamInvite = function (orgUrl) {
  uiPrompt("被邀请人显示名(可选,直接确定=匿名邀请):", "", { allowEmpty: true }).then((name) => {
    if (name === null) return;
    const projects = inviteProjects();
    wsSafeSend(JSON.stringify({ v: 1, type: "team.invite", orgUrl, ...(name ? { displayName: name } : {}), ...(projects ? { projects } : {}) }));
  });
  const projects = inviteProjects();
  wsSafeSend(JSON.stringify({ v: 1, type: "team.invite", orgUrl, ...(name ? { displayName: name } : {}), ...(projects ? { projects } : {}) }));
};
$("team-refresh").onclick = () => wsSafeSend(JSON.stringify({ v: 1, type: "team.status" }));
$("team-invite").onclick = () => {
  const tv = lastTeamOrgs[0];
  if (tv) teamInviteFlow(tv.url);
  else toast("无已连接 org", true);
};
let lastTeamOrgs = [];
// ── fixD5:Issue 看板(团队视图「Issue」子标签;三列 todo/doing/done + HTML5 拖拽写回通道 + 项目/指派筛选) ──
let issueCache = {};        // projectId → issues[](双通道归一后的记录)
let issueChan = {};         // projectId → 通道画像(mode/degradedReason/host/repo)
let issueSelf = "";         // 本机 P2P 用户名(指派给自己的卡=确认派发按钮)
let lastP2pStatus = null;   // team.p2p.status 快照(成员可达性/via)
let lastP2pInbound = null;  // 最近一条入站 P2P 消息(team.p2p.message 实时帧)
let p2pInboundLog = [];     // 入站消息流水(最多 20 条;面板状态条与标题提示用)
const ISSUE_COLS = { todo: "待办", doing: "进行中", done: "已完成" };
function issueProjectIds() {
  const ids = (projects || []).map((p) => p.id);
  if (!ids.length || ids.indexOf("__harness__") === -1) ids.unshift("__harness__");
  return ids;
}
function issueBoardLoad(silent) {
  for (const pid of issueProjectIds()) wsSafeSend(JSON.stringify({ v: 1, type: "issue.list", projectId: pid }));
  wsSafeSend(JSON.stringify({ v: 1, type: "team.p2p.status" }));
  if (!silent) toast("issue 看板:已请求刷新");
}
function issueIngest(pid, issues, channel) {
  if (pid) { issueCache[pid] = issues || []; if (channel) issueChan[pid] = channel; }
  if (viewLive("issues")) renderIssueBoard();
}
function issueProjectLabel(pid) { const p = (projects || []).find((x) => x.id === pid); return (p && p.label) || (pid === "__harness__" ? "harness" : String(pid).slice(0, 8)); }
function issueProjectColor(pid) { let h = 0; for (let i = 0; i < String(pid).length; i++) h = (h * 31 + String(pid).charCodeAt(i)) % 360; return "hsl(" + h + ",45%,55%)"; }
function issueFiltered() {
  const fp = $("issueFp").value || "all", fa = $("issueFa").value || "all";
  const out = [];
  for (const pid of Object.keys(issueCache)) {
    if (fp !== "all" && pid !== fp) continue;
    for (const it of issueCache[pid] || []) {
      if (fa !== "all" && (it.assignee || "") !== fa) continue;
      out.push(Object.assign({}, it, { pid: pid }));
    }
  }
  return out.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}
function renderIssueBoard() {
  const all = issueFiltered();
 // 筛选条:项目(全部/各项目)+指派人(从当前数据收集);重建保持已选。
  const curFp = $("issueFp").value || "all", curFa = $("issueFa").value || "all";
  const pOpts = ['<option value="all">全部项目</option>'].concat((projects || []).map((p) => '<option value="' + esc(p.id) + '">' + esc(p.label) + "</option>")).join("");
  const assignees = {};
  for (const pid of Object.keys(issueCache)) for (const it of issueCache[pid] || []) if (it.assignee) assignees[it.assignee] = 1;
  if (issueSelf) assignees[issueSelf] = 1;
  const aOpts = ['<option value="all">全部指派</option>'].concat(Object.keys(assignees).sort().map((a) => '<option value="' + esc(a) + '">' + esc(a) + "</option>")).join("");
  $("issueFp").innerHTML = pOpts; $("issueFp").value = [].some.call($("issueFp").options, (o) => o.value === curFp) ? curFp : "all";
  $("issueFa").innerHTML = aOpts; $("issueFa").value = [].some.call($("issueFa").options, (o) => o.value === curFa) ? curFa : "all";
 // 通道标签:显示当前筛选项目的通道(降级时带原因)。
  const tagPid = ($("issueFp").value !== "all" ? $("issueFp").value : null) || (activeProjectId || "__harness__");
  const ch = issueChan[tagPid];
  $("issueChanTag").textContent = !ch ? "通道:…" : ch.mode === "repo"
    ? "通道:仓内自建 .genie/issues" + (ch.degradedReason ? "(已降级:" + String(ch.degradedReason).slice(0, 60) + ")" : "(原生通道未配置,零配置共享)") + " · git 提交即多人共享"
    : "通道:" + ch.mode + " 原生(" + (ch.repo || "") + ")";
 // 三列渲染:卡片(项目色点+标题+正文摘要+指派+任务关联+评数;指派自己且未派=「派任务」确认按钮)。
  for (const col of Object.keys(ISSUE_COLS)) {
    const cards = all.filter((it) => (it.status || "todo") === col);
    $("issueCnt" + (col === "todo" ? "Todo" : col === "doing" ? "Doing" : "Done")).textContent = "(" + cards.length + ")";
    const host = document.querySelector(".issue-cards[data-col='" + col + "']");
    if (!host) continue;
    host.innerHTML = cards.length ? cards.map((it) => {
      const canDispatch = issueSelf && (it.assignee || "") === issueSelf && !it.taskId && it.status !== "done";
      const bodyBrief = String(it.body || "").slice(0, 90);
      return '<div class="issue-card" draggable="true" data-num="' + it.number + '" data-pid="' + esc(it.pid) + '" title="' + esc(issueProjectLabel(it.pid)) + ' #' + it.number + '">' +
        '<div style="display:flex;gap:6px;align-items:flex-start">' +
        '<span style="width:8px;height:8px;border-radius:50%;background:' + issueProjectColor(it.pid) + ';flex-shrink:0;margin-top:4px"></span>' +
        '<b style="font-size:11.5px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">' + esc("#" + it.number + " " + it.title) + "</b></div>" +
        (bodyBrief ? '<div style="font-size:10px;color:var(--faint)">' + esc(bodyBrief) + "</div>" : "") +
        '<div style="display:flex;align-items:center;gap:6px;margin-top:4px;flex-wrap:wrap">' +
        '<span style="font-size:9.5px;color:var(--faint)">' + esc(it.assignee ? "@" + it.assignee : "未指派") + "</span>" +
        (it.taskId ? '<span style="font-size:9.5px;color:var(--bronze)" title="任务 ' + esc(it.taskId) + '">任务 ' + esc(String(it.taskId).slice(0, 8)) + "</span>" : "") +
        '<span style="font-size:9.5px;color:var(--faint)">' + ((it.comments || []).length) + " 评</span>" +
        (canDispatch ? '<button class="vw-act" data-issue-dispatch="' + it.number + '" data-issue-pid="' + esc(it.pid) + '" style="margin-left:auto" title="确认后提交任务(不自动跑);终态自动回写 issue 评论">派任务</button>' : "") +
        "</div></div>";
    }).join("") : '<div class="cc-empty">无</div>';
  }
  renderP2pStrip();
}
// P2P 状态条(fixD3:成员直连可达性;离线=relay 兜底/离线队列水位)。
// fixD6:降级原因(mm.err)与积压明细(status.offlineQueueItems)直接可见——此前只有「离线队列 N 条」,
// 用户看不到「为什么降级、积压了哪几条」,也不好判断该不该等补发。
function renderP2pStrip() {
  const host = $("p2pStrip");
  if (!host) return;
  const st = lastP2pStatus;
  if (!st || !st.self) { host.innerHTML = ""; return; }
  issueSelf = st.self.username || "";
  const rows = (st.members || []).map((mm) => {
    const dot = mm.state === "self" ? "var(--bronze)" : mm.state === "online" ? "#6fae7a" : mm.state === "offline" ? "#8a5a5a" : "#9a8f7a";
    const errTip = mm.err ? ' title="' + esc(mm.err) + '"' : "";
    return '<span style="display:inline-flex;align-items:center;gap:5px;font-size:10px;color:var(--muted);border:1px solid var(--border-soft);border-radius:8px;padding:2px 8px"' + errTip + ">" +
      '<span style="width:7px;height:7px;border-radius:50%;background:' + dot + '"></span>' + esc(mm.username) +
      '<span style="color:var(--faint)">' + esc(mm.host + ":" + mm.port + " · " + (mm.state === "self" ? "本机" : "via " + mm.via)) + "</span>" +
      (mm.err ? '<span style="color:#8a5a5a">' + esc("!" + String(mm.err).slice(0, 40)) + "</span>" : "") + "</span>";
  }).join("");
  const q = st.offlineQueue || 0;
  const qItems = (st.offlineQueueItems || []).slice(-3).map((x) => "#" + String(x.id).slice(-6) + "→" + x.to).join(" ");
 // 收件面:优先用实时帧流水(team.p2p.message),status 的 lastInbound 作为首帧兜底
 // (页面刚打开时实时帧可能已错过)。
  const live = p2pInboundLog[0] || null;
  const latestFrom = live ? live.from : (st.lastInbound ? st.lastInbound.from : "");
  const latestDup = live ? live.duplicate : !!(st.lastInbound && st.lastInbound.duplicate);
  const latestText = live ? live.text : (st.lastInbound ? String(st.lastInbound.text || "") : "");
  const inboundTip = p2pInboundLog.slice(0, 5).map((x) => x.from + ": " + x.text).join(String.fromCharCode(10)) || latestText; // 模板层吃单反斜杠(换行转义会变成真换行→整段脚本 SyntaxError;仓规:用 fromCharCode)
  host.innerHTML = rows +
    (q ? '<span style="font-size:10px;color:var(--faint)" title="' + esc(qItems) + '">离线队列 ' + q + " 条(对端在线自动补发)" + (qItems ? " · " + esc(qItems) : "") + "</span>" : "") +
    (latestFrom ? '<span style="font-size:10px;color:var(--faint)" title="' + esc(inboundTip) + '">最近收件:' + esc(latestFrom) + (latestDup ? "(重复已吸收)" : "") + (p2pInboundLog.length ? " · 共 " + p2pInboundLog.length + " 条" : "") + "</span>" : "");
}
// 拖拽:卡片 dragstart(带 pid:num),列 drop → issue.update(status) 写回通道+广播刷新。
document.addEventListener("dragstart", (e) => {
  const card = e.target && e.target.closest ? e.target.closest(".issue-card") : null;
  if (!card) return;
  e.dataTransfer.setData("text/plain", card.getAttribute("data-pid") + ":" + card.getAttribute("data-num"));
  card.style.opacity = "0.45";
});
document.addEventListener("dragend", (e) => {
  const card = e.target && e.target.closest ? e.target.closest(".issue-card") : null;
  if (card) card.style.opacity = "";
});
document.addEventListener("dragover", (e) => {
  const col = e.target && e.target.closest ? e.target.closest(".issue-col") : null;
  if (col) e.preventDefault();
});
document.addEventListener("drop", (e) => {
  const col = e.target && e.target.closest ? e.target.closest(".issue-col") : null;
  if (!col) return;
  e.preventDefault();
  const data = e.dataTransfer.getData("text/plain") || "";
  const idx = data.lastIndexOf(":");
  if (idx < 1) return;
  const pid = data.slice(0, idx), num = Number(data.slice(idx + 1));
  const status = col.getAttribute("data-col");
  if (!pid || !num || !ISSUE_COLS[status]) return;
  wsSafeSend(JSON.stringify({ v: 1, type: "issue.update", projectId: pid, number: num, status: status }));
  toast("issue #" + num + " → " + ISSUE_COLS[status] + "(写回通道)");
});
// 确认派发(fixD4 分发桥面板面):确认对话框 → issue.confirm.dispatch → task.submit(该 issue 所属项目)。
document.addEventListener("click", (e) => {
  const b = e.target && e.target.closest ? e.target.closest("button[data-issue-dispatch]") : null;
  if (!b) return;
  const num = Number(b.getAttribute("data-issue-dispatch")), pid = b.getAttribute("data-issue-pid");
  const it = (issueCache[pid] || []).find((x) => x.number === num);
  if (!it) return;
  uiConfirm("确认派发 issue #" + num + "「" + String(it.title || "").slice(0, 40) + "」为任务?(不自动跑其余 issue;终态自动回写评论)", { tone: "warning" }).then((ok) => {
    if (!ok) return;
    wsSafeSend(JSON.stringify({ v: 1, type: "issue.confirm.dispatch", projectId: pid, number: num }));
  });
});
$("issueFp").onchange = renderIssueBoard;
$("issueFa").onchange = renderIssueBoard;
$("issueSyncBtn").onclick = () => {
  const pid = $("issueFp").value !== "all" ? $("issueFp").value : (activeProjectId || "__harness__");
  wsSafeSend(JSON.stringify({ v: 1, type: "issue.sync", projectId: pid }));
};
$("issueNewBtn").onclick = () => {
  uiPrompt("issue 标题:", "", {}).then((title) => {
    if (!title) return;
    uiPrompt("正文(可空):", "", { allowEmpty: true }).then((body) => {
      if (body === null) return;
      uiPrompt("指派人(用户名,可空=不指派;指派自己=面板可确认派发):", "", { allowEmpty: true }).then((assignee) => {
        if (assignee === null) return;
        const pid = $("issueFp").value !== "all" ? $("issueFp").value : (activeProjectId || "__harness__");
        wsSafeSend(JSON.stringify({ v: 1, type: "issue.create", projectId: pid, title: title, body: body || "", ...(assignee ? { assignee: assignee } : {}) }));
        toast("issue 已提交(通道:" + ((issueChan[pid] || {}).mode || "…") + ")");
      });
    });
  });
};
// fixD5 结束
let lastGoalState = null;
// /goal set 待派发任务(审计:goal.set 必须等服务端 ack 再派任务——此前 fire-and-forget,
// plan 互斥/超长被拒时任务照派成孤儿;且草稿态 goal.set 落 __new__ 幻影会话与任务会话错位)
let goalPendingDispatch = null;
// invalid-message 去重(session.owner.get 版本错位事故教训):面板消息被旧网关拒收时
// 逐 sid/逐次重发都会回 error 帧——同码 30s 只 toast 一次,防刷屏。
let invalidMsgToastAt = 0;

// ── Plan 审批卡(ZCode ExitPlanMode 审批交互) ──
let planApproval = null;
function renderPlanApproval() {
  let host = $("planApprovalCard");
  if (!host) {
    host = document.createElement("div");
    host.id = "planApprovalCard";
    host.setAttribute("style", "margin:10px 0;padding:10px 12px;border:1px solid var(--bronze);border-radius:10px;background:rgba(201,162,94,.06)");
    const stream = document.querySelector("#view-tasks .chat-col") || document.body;
    stream.appendChild(host);
  }
  if (!planApproval) { host.remove(); return; }
  host.innerHTML =
    '<div style="font-size:11px;letter-spacing:1px;color:var(--bronze);margin-bottom:6px">实 施 计 划 待 审 批</div>' +
    '<div style="font-size:11.5px;color:var(--text);max-height:140px;overflow-y:auto;white-space:pre-wrap">' + esc(String(planApproval.excerpt)) + '</div>' +
    '<div style="display:flex;gap:8px;margin-top:8px">' +
    '<button class="vw-act" data-planact="approve">批准并实施</button>' +
    '<button class="vw-act" data-planact="feedback">给反馈修订</button>' +
    '</div>';
}
document.addEventListener("click", (e) => {
  const b = e.target && e.target.closest ? e.target.closest("button[data-planact]") : null;
  if (!b || !planApproval) return;
  const act = b.getAttribute("data-planact");
  if (act === "approve") {
    wsSafeSend(JSON.stringify({ v: 1, type: "plan.approve", sessionId: planApproval.sessionId, taskId: planApproval.taskId, decision: "approve" }));
    planApproval = null; renderPlanApproval();
  } else {
    uiPrompt("计划反馈(将作为修订指引,保持 Plan 模式):", "", { allowEmpty: true }).then((fb) => {
      if (fb === null) return;
      wsSafeSend(JSON.stringify({ v: 1, type: "plan.approve", sessionId: planApproval.sessionId, taskId: planApproval.taskId, decision: "feedback", ...(fb ? { feedback: fb } : {}) }));
      planApproval = null; renderPlanApproval();
    });
  }
});

// ── 总路线 tab(原侧栏「总线路」一级视图并入代码档案) ──
// 定位:code-sense 的项目开发宗旨面(为什么存在/主线能力/偏离提示)+ 原总线路任务漏斗。
// 数据源:sense 画像走 profile.sense.get(读/生成 .genie/sense-index/profile.json);漏斗走 tasks 内存表。
let rmData = null, rmBusy = false;

function roadmapLoad(generate) {
  if (rmBusy) return;
  rmBusy = true;
  const pid = ppId || activeProjectId || "__harness__";
  wsSafeSend(JSON.stringify({ v: 1, type: "profile.sense.get", projectId: pid, ...(generate ? { generate: true } : {}) }));
  renderRoadmapFunnel();
}
function roadmapRender(m) {
  rmData = m;
  const host = $("rmBody");
  if (!host) return;
  const meta = [];
  if (m.root) meta.push(m.root);
  if (m.exists) {
    if (m.maturity) meta.push("成熟度 " + m.maturity);
    if (m.builtAt) meta.push("生成于 " + new Date(m.builtAt).toLocaleString());
    if (m.stale) meta.push("! 源码已变动,建议重新生成");
  } else {
    meta.push("画像尚未生成");
  }
  $("rmMeta").textContent = meta.join(" · ");
  if (!m.exists) {
    host.innerHTML = '<div class="cc-empty">' + esc(m.llmState && m.llmState.reason ? m.llmState.reason : "点「生成总路线」按需构建") + "</div>";
    return;
  }
  const parts = [];
  const srcLabel = m.purposeSource === "llm" ? "模型解读 · 证据锚=下方事实" : m.purposeSource === "readme" ? "README 首段(确定性)" : "清单描述(确定性)";
  parts.push('<div class="rm-sec-t">开发宗旨 · ' + esc(srcLabel) + "</div>");
  parts.push(m.purpose
    ? '<div class="rm-purpose-line">' + esc(m.purpose) + "</div>"
    : '<div class="cc-empty">无 purpose 候选(README/清单均缺失)</div>');
  if ((m.capabilities || []).length) {
    parts.push('<div class="rm-sec-t">主线能力(改动应服务于此)</div>');
    parts.push(m.capabilities.map((c) => '<div class="rm-item"><span class="rm-k">能力</span><span>' + esc(c) + "</span></div>").join(""));
  }
  if ((m.driftWarnings || []).length) {
    parts.push('<div class="rm-sec-t">偏离主线提示(命中先向用户确认)</div>');
    parts.push(m.driftWarnings.map((d) => '<div class="rm-item rm-drift"><span class="rm-k">提示</span><span>' + esc(d) + "</span></div>").join(""));
  }
  if (m.llmState && m.llmState.status !== "ok") {
 // 降级显式:LLM 缺席/失败不静默——确定性骨架仍在,明文说清缺的是什么
    parts.push('<div class="rm-facts">[降级] purpose 语义层:' + esc(m.llmState.status) + (m.llmState.reason ? " · " + esc(m.llmState.reason) : "") + "</div>");
  }
  const sk = m.skeleton;
  if (sk) {
    const facts = [];
    if (sk.domain) facts.push("领域: " + sk.domain);
    if ((sk.techStack || []).length) facts.push("技术栈: " + sk.techStack.map((t) => t.language + "×" + t.files).join(", "));
    if ((sk.frameworks || []).length) facts.push("框架: " + sk.frameworks.map((f) => f.name + "@" + f.evidence.file + ":" + f.evidence.line).join(", "));
    if ((sk.entrypoints || []).length) facts.push("入口: " + sk.entrypoints.slice(0, 6).join(" | "));
    if ((sk.topoNotes || []).length) facts.push("目录: " + sk.topoNotes.join(", "));
    for (const d of sk.degraded || []) facts.push("[降级] " + d.layer + ": " + d.reason);
 // fixE21:16a5b77 起本行裸换行转义被模板层吃成真实换行=页面脚本整块 SyntaxError(面板全灭;注释里写反斜杠转义同样会被吃,连注释一起截断)——fromCharCode(10) 是本文件既有纪律。
    if (facts.length) parts.push('<div class="rm-facts">' + esc(facts.join(String.fromCharCode(10))) + "</div>");
  }
  host.innerHTML = parts.join("");
}

function renderRoadmapFunnel() {
  const host = $("rmFunnel");
  if (!host) return;
  const all = [...tasks.values()];
  const byProject = new Map();
  for (const t of all) {
    const k = t.projectId || "(无项目)";
    if (!byProject.has(k)) byProject.set(k, { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, blocked: 0, recent: [] });
    const b = byProject.get(k);
    b[t.state] = (b[t.state] || 0) + 1;
    if (b.recent.length < 5) b.recent.push(t);
  }
  const rows = [...byProject.entries()].map(([pid, b]) => {
    const total = b.queued + b.running + b.done + b.failed + b.cancelled + b.blocked;
    const donePct = total ? Math.round((b.done / total) * 100) : 0;
    const bar = '<div style="height:5px;background:rgba(255,255,255,.06);border-radius:3px;overflow:hidden;margin:6px 0">' +
      '<div style="height:100%;width:' + donePct + '%;background:var(--bronze)"></div></div>';
    const chips = ["queued", "running", "blocked", "done", "failed", "cancelled"].filter((k2) => b[k2]).map((k2) =>
      '<span style="font-size:9.5px;margin-right:8px;color:var(--faint)">' + ({ queued: "排队", running: "在跑", blocked: "阻塞", done: "完成", failed: "失败", cancelled: "取消" }[k2]) + " <b style='color:var(--text)'>" + b[k2] + "</b></span>").join("");
    const recentList = b.recent.map((t) => '<div style="font-size:10.5px;color:var(--faint);margin:2px 0;display:flex;align-items:center;gap:4px">' + (t.state === "running" ? ic("run", "ok") : t.state === "done" ? ic("check", "ok") : t.state === "failed" ? ic("x", "bad") : ic("dot", "mut")) + "<span>" + esc(t.title || String(t.instruction || "").slice(0, 50)) + "</span></div>").join(""); // tasks 是索引条目,instruction 可能缺席(无 title 时不得裸取)
    return '<div class="tcard" style="padding:10px 12px;background:rgba(255,255,255,.02)">' +
      '<div style="display:flex;align-items:center;gap:8px"><b style="font-size:12.5px">' + esc(pid) + '</b><span style="font-size:9.5px;color:var(--faint)">' + total + " 个任务 · " + donePct + "% 完成</span></div>" + bar +
      "<div style='margin:2px 0 4px'>" + chips + "</div>" + recentList + "</div>";
  }).join("");
  host.innerHTML = rows || '<div class="cc-empty">暂无任务——总线路随任务创建实时点亮(:异步优先,提交即入队)</div>';
}
$("rmFunnelRefresh").onclick = () => renderRoadmapFunnel();
$("rmRefresh").onclick = () => { rmData = null; roadmapLoad(); };
$("rmGen").onclick = () => {
  const b = $("rmGen");
  if (b.disabled) return;
  b.disabled = true;
  $("rmBody").innerHTML = '<div class="cc-empty loading">生成中:确定性骨架 + purpose 语义层(无 LLM 时仅骨架)…</div>';
  roadmapLoad(true);
 // 生成链路尽头在 profile.sense.result 回执里复位;兜底 60s 防按钮永久禁用
  setTimeout(() => { b.disabled = false; }, 60000);
};

// ── 节点视图(二期;数据同 nodes.list) ──
// ── 节点 Fleet(丰满:概要/真实负载/能力与可达性 chips/命令下发+输出回显/远程项目/接入指引;
// 旧版=一列只读 mgr-row,负载恒零,命令要绕设置页)──
const nodeExecOut = new Map(); // nodeId → 最近一次 node.exec 结果(卡内回显;重启即失)
function nodeOutHtml(id) {
  const o = nodeExecOut.get(id);
  if (!o) return "";
  return '<div class="sup-mono" style="margin:4px 0 2px">' + (o.ok ? "✓" : "✗") + " " + esc(o.cmd) +
    " · " + esc(ago2(o.at)) + (o.durationMs !== undefined ? " · " + Math.round(o.durationMs / 100) / 10 + "s" : "") + "</div>" +
    '<div class="sup-row" style="white-space:pre-wrap;max-height:160px;overflow:auto;font-family:var(--mono,ui-monospace,monospace);font-size:11px">' +
    esc(String(o.output || o.error || "(无输出)").slice(0, 2000)) + "</div>";
}
function nodesViewRender(m) {
  const host = $("nodes-body");
  if (!host) return;
  const list = m.nodes || [];
  const idn = m.identity || {};
  const online = list.filter((n) => n.online);
 // 远程项目(面板 projects 状态聚合;availability 由服务端启动探测/重连优化回写)
  const remotes = (Array.isArray(projects) ? projects : []).filter((p) => p.path && /^remote:(ssh|wsl):/.test(String(p.path)));
  const remBad = remotes.filter((p) => p.availability && p.availability !== "available");
  const html = [];
 // ① 概要行:身份/在线/远程项目健康(借鉴 dsh-superagent「健康态不占位」:全绿时不展开细目)
  html.push('<div class="sup-sec"><div class="sup-row-h" style="flex-wrap:wrap;gap:10px">' +
    '<span class="sup-badge">' + esc(idn.mode || "本地") + "</span>" +
    (idn.fingerprint ? '<span class="sup-mono" title="本机身份指纹(.genie/identity)">指纹 ' + esc(idn.fingerprint) + "</span>" : "") +
    '<span class="sup-mono">节点 ' + online.length + "/" + list.length + " 在线</span>" +
    (remotes.length ? '<span class="sup-mono">远程项目 ' + (remotes.length - remBad.length) + "/" + remotes.length + " 可用" + (remBad.length ? "(" + esc(remBad.map((p) => p.label || p.id).join(", ")) + " 不可用)" : "") + "</span>" : "") +
    "</div></div>");
 // ② 节点卡
  if (!list.length) html.push('<div class="sup-empty">尚无节点。本机 local 由网关注册;远程机用下方「接入新节点」的向导命令接入,注册成功会实时出现在这里。</div>');
  for (const n of list) {
    const cpu = Math.round((n.load.cpu || 0) * 100);
    const mem = Math.round((n.load.mem || 0) * 100);
    const caps = (n.capabilities || []).map((c) => '<span class="sup-badge">' + esc(c) + "</span>").join("");
    const reach = (n.reachability || []).map((r) => '<span class="sup-badge" style="color:var(--muted,#a08e78)">' + esc(r) + "</span>").join("");
    html.push('<div class="sup-sec" data-node="' + esc(n.nodeId) + '">' +
      '<div class="sup-row-h"><span class="sup-badge' + (n.online ? "" : " failed") + '">' + (n.online ? "在线" : "失联") + '</span>' +
      '<span class="sup-it" style="font-weight:600">' + esc(n.nodeId) + '</span>' +
      '<span class="sup-mono" title="' + esc(new Date(n.lastHeartbeat).toLocaleString()) + '">心跳 ' + esc(ago2(n.lastHeartbeat)) + "</span></div>" +
      (caps || reach ? '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:5px">' + caps + reach + "</div>"
        : '<div class="sup-empty" style="margin-top:4px">无能力/可达性标签(node-agent 用 GENIE_NODE_CAPS / GENIE_NODE_REACH 上报;本机用 GENIE_LOCAL_CAPABILITIES)</div>') +
      '<div style="display:flex;gap:14px;margin-top:6px;font-size:11px;color:var(--muted,#a08e78)">' +
      "<span>cpu " + cpu + '%</span><span>mem ' + mem + '%</span><span>执行中 ' + (n.load.runningTasks || 0) + "</span></div>" +
      '<div class="sup-answer" style="margin-top:6px">' +
      '<input placeholder="' + (n.online ? "对本节点下发命令…" : "节点失联,命令会失败") + '" data-nodecmd="' + esc(n.nodeId) + '" autocomplete="off" spellcheck="false">' +
      '<button class="sup-btn pri" data-nodeexec="' + esc(n.nodeId) + '"' + (n.online ? "" : " disabled") + ">执行</button></div>" +
      '<div data-nodeout="' + esc(n.nodeId) + '">' + nodeOutHtml(n.nodeId) + "</div>" +
      "</div>");
  }
 // ③ 远程项目区(availability+一键重连优化;数据=projects 状态,动作=既有 remote.deploy)
  if (remotes.length) {
    html.push('<div class="sup-sec"><div class="sup-sec-h">远程项目</div>');
    for (const p of remotes) {
      html.push('<div class="sup-row" style="margin-bottom:5px"><div class="sup-row-h">' +
        '<span class="sup-badge' + (p.availability && p.availability !== "available" ? " failed" : "") + '">' + esc(p.availability || "?") + "</span>" +
        '<span class="sup-it">' + esc(p.label || p.id) + '</span>' +
        '<button class="sup-btn" data-remotedeploy="' + esc(p.id) + '" title="部署/升级远端工作区服务并验证连通(remote.deploy)">重新连接优化</button></div></div>');
    }
    html.push("</div>");
  }
 // ④ 接入指引(不重复建设向导:设置-远程连接已有完整生成/测试链)
  html.push('<div class="sup-sec"><div class="sup-row-h" style="flex-wrap:wrap;gap:8px"><span class="sup-empty" style="flex:1 1 auto">接入新节点:向导会生成一条可直接执行的引导命令(SSH/Docker),node-agent 注册成功即实时出现在上面;跨机场景网关地址自动取本机 LAN IP(可用环境变量 GENIE_PUBLIC_HOST 覆盖)。</span>' +
    '<button class="sup-btn pri" id="nodesOpenRemote">打开设置-远程连接</button></div></div>');
  host.innerHTML = html.join("");
}
// Fleet 事件委托(一次绑定;行内命令下发/重连优化/深链设置)
document.getElementById("nodes-body").addEventListener("click", (e) => {
  const t = e.target;
  if (!t || !t.closest) return;
  const exec = t.closest("[data-nodeexec]");
  if (exec) {
    const id = exec.getAttribute("data-nodeexec");
    const inp = document.querySelector('[data-nodecmd="' + id + '"]');
    const cmd = inp ? String(inp.value || "").trim() : "";
    if (!cmd) { toast("先输入要下发的命令", true); return; }
    const prev = nodeExecOut.get(id) || {};
    nodeExecOut.set(id, { ...prev, cmd });
    wsSafeSend(JSON.stringify({ v: 1, type: "node.exec", nodeId: id, command: cmd }));
    toast("已下发到节点 " + id + "(结果会回显在卡内)");
    return;
  }
  const dep = t.closest("[data-remotedeploy]");
  if (dep) { wsSafeSend(JSON.stringify({ v: 1, type: "remote.deploy", projectId: dep.getAttribute("data-remotedeploy") })); toast("远端环境部署/验证中…(完成会提示)"); return; }
  if (t.closest("#nodesOpenRemote")) { switchView("sys"); setSection("remote"); return; }
});
document.getElementById("nodes-body").addEventListener("keydown", (e) => {
  const inp = e.target;
  if (inp && inp.dataset && inp.dataset.nodecmd && e.key === "Enter") {
    e.preventDefault();
    const btn = inp.parentNode.querySelector("[data-nodeexec]");
    if (btn) btn.click();
  }
});
$("nodes-refresh").onclick = () => wsSafeSend(JSON.stringify({ v: 1, type: "nodes.list" }));
`;
