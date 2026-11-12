/**
 * 面板主脚本分片:script-providers(逐字自 panel.ts PAGE 模板搬移, 拆分)。
 * 模板约束沿袭:不得出现反引号与 ${;行内换行不得写裸转义。
 */
export const PANEL_JS_PROVIDERS = `// =====  Coding 模型设置:Provider 编辑 / 能力徽标 / 角色下拉 =====
let provDraft = null; // null=未加载
let provTestState = {}; // id -> {ok,bad,msg} 测试连接状态(内存态,重绘不丢)
let lastTestId = null;
let provEditId = null;
function sendProviders() {
  if (provDraft) wsSafeSend(JSON.stringify({ v: 1, type: "cfg.set", patch: { providers: provDraft } }));
}
function apiTypeOf(pv) { const t = pv && pv.apiType; return t === "responses" || t === "anthropic" ? t : "chat"; }
function apiTypeLabel(t) { return t === "responses" ? "Responses" : t === "anthropic" ? "Anthropic" : "Chat"; }
function parseHeadersText(text) {
  const out = {};
  for (const line of String(text || "").split(String.fromCharCode(10))) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf(":");
    if (i <= 0) continue;
    const k = s.slice(0, i).trim(), v = s.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}
function headersText(obj) { return Object.entries(obj || {}).map(([k, v]) => k + ": " + v).join(String.fromCharCode(10)); }
function modelEntry(mm) { return typeof mm === "string" ? { name: mm } : (mm || {}); }
function modelNameOf(mm) { return typeof mm === "string" ? mm : String((mm && mm.name) || ""); }
function ensureModelObject(pv, name) {
  if (!pv) return null;
  pv.models = pv.models || [];
  let idx = pv.models.findIndex((mm) => modelNameOf(mm) === name);
  if (idx < 0) { pv.models.push({ name }); idx = pv.models.length - 1; }
  if (typeof pv.models[idx] === "string") pv.models[idx] = { name: pv.models[idx] };
  return pv.models[idx];
}
function defaultProviderIndex() {
  const c = (cfgView && cfgView.config) || {};
  const llm = (c.coding && c.coding.llm) || {};
  if (!provDraft || !provDraft.length) return 0;
  if (llm.providerId) { const i = provDraft.findIndex((p) => p.id === llm.providerId); if (i >= 0) return i; }
  if (llm.baseUrl) { const i = provDraft.findIndex((p) => p.baseUrl === llm.baseUrl); if (i >= 0) return i; }
  return 0;
}
/** 已启用模型目录:providers[].models(对象/字符串归一)∪ 最近拉取列表 ∪ 当前配置值;按名称去重。 */
function modelCatalogEntries() {
  const out = [], seen = new Set();
  for (const pv of (provDraft || [])) {
    for (const mm of (pv.models || [])) {
      const name = modelNameOf(mm);
      if (!name || seen.has(name)) continue;
      seen.add(name); out.push({ name, provider: pv, entry: modelEntry(mm) });
    }
  }
  for (const id of lastModelIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id); out.push({ name: id, provider: null, entry: null });
  }
  const c = (cfgView && cfgView.config) || {};
  const llm = (c.coding && c.coding.llm) || {};
  const md = (c.coding && c.coding.models) || {};
  for (const name of [llm.model, md.subagent && md.subagent.model, md.compact && md.compact.model, md.review && md.review.model]) {
    if (name && !seen.has(name)) { seen.add(name); out.push({ name, provider: null, entry: null, current: true }); }
  }
  return out;
}
function modelEntryByName(name) { return modelCatalogEntries().find((e) => e.name === name) || null; }
function capState(v) { return v === true ? "on" : v === false ? "off" : "unknown"; }
function capTitle(v) { return v === true ? "支持(点击改为不支持)" : v === false ? "不支持(点击改为未标注)" : "未标注(点击标记为支持)"; }
function capChip(entry, key, label) {
  const v = entry ? entry[key] : undefined;
  return '<button type="button" class="cap-chip ' + capState(v) + '" data-cap="' + key + '" title="' + label + ":" + capTitle(v) + '">' + label + "</button>";
}
function cycleCap(entry, key) {
  const v = entry[key];
  entry[key] = v === undefined ? true : v === false ? undefined : false;
}
/** 模型目录展示用:仅 true 显示徽标(未知/false 不显示,避免把未知说成能力)。 */
function capBadge(entry, key, label) {
  return entry && entry[key] === true ? '<span class="mr-tag cap-badge" title="已标注支持' + label + '">' + label + "</span>" : "";
}

function renderProviders() {
  if (!provDraft) return;
  const cur = (cfgView && cfgView.config && cfgView.config.coding && cfgView.config.coding.llm) || {};
  const box = $("prov-list");
  if (!box) return;
  box.innerHTML = provDraft.length ? provDraft.map((pv, i) => {
    const editing = provEditId === pv.id;
    const t = apiTypeOf(pv);
    return '<div class="prov-card" data-i="' + i + '">' +
      '<div class="prov-head"><span class="prov-id">' + esc(pv.id) + '</span>' +
      (pv.name ? '<span class="prov-name">' + esc(pv.name) + '</span>' : '') +
      (cur.providerId === pv.id ? '<span class="prov-def">默认</span>' : '') +
      '<span class="prov-proto' + (t === "chat" ? "" : " warn") + '" title="' + (t === "chat" ? "OpenAI chat 协议(当前可执行)" : "已保存配置,运行时尚不支持该协议") + '">' + apiTypeLabel(t) + '</span>' +
      (pv.authMode === "token-plan"
        ? '<span class="prov-auth plan" title="Token 套餐 / 订阅额度">Token 套餐</span>'
        : '<span class="prov-auth" title="按量 API Key(缺省)">API 调用</span>') +
      '<div class="prov-acts">' +
        '<button class="prov-act" data-a="edit">' + (editing ? "收起" : "编辑") + '</button>' +
        '<button class="prov-act" data-a="test" title="测连通性与端点可见模型数,不改动目录">测试连接</button>' +
        '<button class="prov-act" data-a="fetch" title="从端点拉取全部模型,合并进目录">拉取模型</button>' +
        '<button class="prov-act" data-a="def">设为默认</button>' +
        '<button class="prov-act" data-a="del">删除</button>' +
      '</div></div>' +
      '<div class="prov-url">' + esc(pv.baseUrl) + (pv.apiKeyEnv ? ' · 密钥 ' + esc(pv.apiKeyEnv) + (secretLast4[pv.apiKeyEnv] ? ' · ••••' + esc(secretLast4[pv.apiKeyEnv]) : '') : '') +
        (pv.headers && Object.keys(pv.headers).length ? '<span style="white-space:nowrap"> · 自定义头 ' + Object.keys(pv.headers).length + " 条</span>" : "") + '</div>' +
      (editing ? '<div class="prov-edit">' +
        '<label>显示名<input class="pe-name" value="' + esc(pv.name || "") + '"></label>' +
        '<label>API Key 环境变量名<input class="pe-key" value="' + esc(pv.apiKeyEnv || "") + '" placeholder="如 DASHSCOPE_API_KEY"></label>' +
        '<label>接入方式<select class="pe-auth">' +
          '<option value="api"' + (pv.authMode === "token-plan" ? "" : " selected") + '>API 调用(按量)</option>' +
          '<option value="token-plan"' + (pv.authMode === "token-plan" ? " selected" : "") + '>Token 套餐(订阅)</option>' +
        '</select></label>' +
        '<label class="pe-wide">baseUrl<input class="pe-url" value="' + esc(pv.baseUrl || "") + '"></label>' +
        '<label>接口协议<select class="pe-type">' +
          '<option value="chat"' + (t === "chat" ? " selected" : "") + '>Chat(OpenAI 兼容,可执行)</option>' +
          '<option value="responses"' + (t === "responses" ? " selected" : "") + '>Responses(仅记录)</option>' +
          '<option value="anthropic"' + (t === "anthropic" ? " selected" : "") + '>Anthropic(仅记录)</option>' +
        '</select></label>' +
        '<label>模型目录<div class="sd">' + ((pv.models || []).length) + ' 个条目</div></label>' +
        '<label class="pe-wide">自定义请求头(每行 Key: Value;密钥请用上方 API Key 字段)<textarea class="pe-headers" rows="2" placeholder="X-Org-Id: team-a">' + esc(headersText(pv.headers)) + '</textarea></label>' +
        '<div class="prov-edit-foot"><button class="prov-act" data-a="save">保存</button><button class="prov-act" data-a="cancel">取消</button><span class="sd pe-hint">端点/协议/请求头的改动,重启网关后对运行中的会话生效</span></div>' +
      '</div>' : "") +
      (() => { const s = provTestState[pv.id]; if (s) return '<div class="prov-test ' + (s.ok ? "ok" : "bad") + '">' + esc(redactPaths(s.msg)) + '</div>'; return '<div class="prov-test" data-t="' + i + '">' + (pv.models && pv.models.length ? "已收录 " + pv.models.length + " 个模型" : "未拉取模型列表") + '</div>'; })() +
      '<div class="prov-models">' +
        (pv.models && pv.models.length
          ? pv.models.map((mm, mi) => {
              const it = modelEntry(mm);
              return '<div class="pv-mrow" data-p="' + i + '" data-m="' + mi + '">' +
                '<span class="pv-mname">' + esc(it.name) + '</span>' +
                capChip(it, "supportsToolCall", "工具") + capChip(it, "supportsImage", "图像") +
                '<input class="num-in pv-mcw" placeholder="上下文" style="width:84px" value="' + (it.contextWindow || "") + '">' +
                '<input class="num-in pv-mmt" placeholder="最大输出" style="width:84px" value="' + (it.maxTokens || "") + '">' +
                '<button class="prov-act" data-a="mdel">删</button>' +
 // 单价覆盖(元/百万 token):内置默认价来自 model-prices.ts,这里填的优先。
 // 留空=用内置表;填 0=确认免费;只看 authMode=api 的端点出金额(套餐不计费)。
                '<div class="pv-prow" title="单价(元/百万 token);留空=用内置价目表。缓存写入多数厂商不单列,留空即可">' +
                  '<span class="pv-pl">单价</span>' +
                  '<input class="num-in pv-pcr" placeholder="缓存命中" style="width:70px" value="' + (it.price && it.price.cacheRead != null ? it.price.cacheRead : "") + '">' +
                  '<input class="num-in pv-pcw" placeholder="缓存写入" style="width:70px" value="' + (it.price && it.price.cacheWrite != null ? it.price.cacheWrite : "") + '">' +
                  '<input class="num-in pv-pim" placeholder="未命中" style="width:70px" value="' + (it.price && it.price.inputMiss != null ? it.price.inputMiss : "") + '">' +
                  '<input class="num-in pv-pou" placeholder="输出" style="width:70px" value="' + (it.price && it.price.output != null ? it.price.output : "") + '">' +
                '</div>' +
                '</div>';
            }).join("")
          : '<div class="prov-test">还没有模型 —— 点上方「拉取模型」,或在下方手动添加</div>') +
      '</div>' +
      '<div class="pv-madd"><input class="num-in pv-newname" placeholder="模型名" style="width:140px"><input class="num-in pv-newcw" placeholder="上下文" style="width:84px"><input class="num-in pv-newmt" placeholder="最大输出" style="width:84px"><button class="prov-act" data-a="madd">+ 添加模型</button></div>' +
    '</div>';
  }).join("") : '<div class="cc-empty">还没有供应商 —— 点「+ 添加供应商」,从预设一键接入</div>';

 // 模型行交互(/元数据编辑/删除/能力徽标三态)
  for (const row of box.querySelectorAll(".pv-mrow")) {
    const pi = Number(row.dataset.p), mi = Number(row.dataset.m);
    const pv = provDraft[pi];
    if (!pv) continue;
    const it = ensureModelObject(pv, modelNameOf(pv.models[mi]));
    if (!it) continue;
    for (const b of row.querySelectorAll(".cap-chip")) b.onclick = () => { cycleCap(it, b.dataset.cap); sendProviders(); renderProviders(); };
    const cw = row.querySelector(".pv-mcw");
    if (cw) cw.onchange = () => { const v = Number(cw.value); it.contextWindow = v > 0 ? v : undefined; sendProviders(); renderProviders(); };
    const mt = row.querySelector(".pv-mmt");
    if (mt) mt.onchange = () => { const v = Number(mt.value); it.maxTokens = v > 0 ? v : undefined; sendProviders(); renderProviders(); };
 // 单价覆盖:四个输入框任一改动即整组写回;全空=删掉 price(回落内置表)。
    const priceInputs = { cacheRead: ".pv-pcr", cacheWrite: ".pv-pcw", inputMiss: ".pv-pim", output: ".pv-pou" };
    const priceEls = Object.entries(priceInputs).map(([k, sel]) => [k, row.querySelector(sel)]);
    const onPriceChange = () => {
      const next = {};
      for (const [k, el] of priceEls) {
        if (!el) continue;
        const raw = String(el.value || "").trim();
        if (raw === "") continue; // 留空=用内置表该段
        const v = Number(raw);
        if (!Number.isFinite(v) || v < 0) { toast("单价必须是非负数字:" + raw, true); return; }
        next[k] = v;
      }
      if (Object.keys(next).length === 0) delete it.price;
      else it.price = next;
      sendProviders();
      renderProviders();
    };
    for (const [, el] of priceEls) if (el) el.onchange = onPriceChange;
    const del = row.querySelector('[data-a="mdel"]');
    if (del) del.onclick = () => { pv.models.splice(mi, 1); sendProviders(); renderProviders(); };
  }
  for (const add of box.querySelectorAll(".pv-madd")) {
    const card = add.closest(".prov-card");
    const pi = Number(card ? card.dataset.i : -1);
    const btn = add.querySelector('[data-a="madd"]');
    if (!btn) continue;
    btn.onclick = () => {
      const pv = provDraft[pi];
      if (!pv) return;
      const name = add.querySelector(".pv-newname").value.trim();
      if (!name) return;
      if ((pv.models || []).some((mm) => modelNameOf(mm) === name)) { toast("模型已存在:" + name, true); return; }
      const cw = Number(add.querySelector(".pv-newcw").value) || undefined;
      const mt = Number(add.querySelector(".pv-newmt").value) || undefined;
      pv.models = pv.models || [];
      pv.models.push({ name, ...(cw ? { contextWindow: cw } : {}), ...(mt ? { maxTokens: mt } : {}) });
      sendProviders(); renderProviders();
    };
  }
  for (const card of box.querySelectorAll(".prov-card")) {
    const i = Number(card.dataset.i);
    const pv = provDraft[i];
    if (!pv) continue;
    const acts = card.querySelector(".prov-acts");
    const bind = (a, fn) => { const b = acts.querySelector('[data-a="' + a + '"]'); if (b) b.onclick = fn; };
    bind("edit", () => { provEditId = provEditId === pv.id ? null : pv.id; renderProviders(); });
    bind("test", () => {
      lastTestId = pv.id;
      provTestState[lastTestId] = { ok: false, bad: false, msg: "测试中…" };
      renderProviders();
      wsSafeSend(JSON.stringify({ v: 1, type: "models.list", providerId: lastTestId, probeOnly: true })); // 只读探测,不合并目录
    });
    bind("fetch", () => {
      lastTestId = pv.id;
      provTestState[lastTestId] = { ok: false, bad: false, msg: "拉取目录中…" };
      renderProviders();
      wsSafeSend(JSON.stringify({ v: 1, type: "models.list", providerId: lastTestId }));
    });
    bind("def", () => {
      const patch = { coding: { llm: { providerId: pv.id, baseUrl: pv.baseUrl, apiKeyEnv: pv.apiKeyEnv || "GENIE_LLM_API_KEY" } } };
      wsSafeSend(JSON.stringify({ v: 1, type: "cfg.set", patch }));
      toast("已设为默认 Provider:" + pv.id + "(冷项,重启生效)");
    });
    bind("del", () => { provDraft.splice(i, 1); if (provEditId === pv.id) provEditId = null; sendProviders(); renderProviders(); });
    if (provEditId === pv.id) {
      const save = card.querySelector('[data-a="save"]');
      const cancel = card.querySelector('[data-a="cancel"]');
      if (save) save.onclick = () => {
        const name = card.querySelector(".pe-name").value.trim();
        const url = card.querySelector(".pe-url").value.trim();
        if (!url) { toast("baseUrl 不能为空", true); return; }
        pv.name = name;
        pv.baseUrl = url;
        const key = card.querySelector(".pe-key").value.trim();
        if (key) pv.apiKeyEnv = key; else delete pv.apiKeyEnv;
        const type = card.querySelector(".pe-type").value;
        if (type === "chat") delete pv.apiType; else pv.apiType = type;
        const auth = card.querySelector(".pe-auth");
        if (auth && auth.value === "token-plan") pv.authMode = "token-plan"; else delete pv.authMode;
        const headers = parseHeadersText(card.querySelector(".pe-headers").value);
        if (Object.keys(headers).length) pv.headers = headers; else delete pv.headers;
        provEditId = null;
        sendProviders(); renderProviders();
        toast("Provider 已保存:" + pv.id + "(冷项,重启生效;测试连接可立即验证)");
      };
      if (cancel) cancel.onclick = () => { provEditId = null; renderProviders(); };
    }
  }
 // 自定义模型归属 Provider 下拉
  const np = $("cm-new-prov");
  if (np && provDraft.length) {
    np.innerHTML = provDraft.map((p, i) => '<option value="' + i + '">' + esc((p.name || p.id) + "(" + p.id + ")") + '</option>').join("");
    const keep = np.value;
    np.value = keep && provDraft[Number(keep)] ? keep : String(Math.max(0, Math.min(defaultProviderIndex(), provDraft.length - 1)));
  }
  renderModelList();
  renderRoleSelects();
}
function setProviderModal(open) {
  const mask = $("prov-modal-mask");
  if (!mask) return;
  mask.hidden = !open;
  if (open) {
    setTimeout(() => {
      const first = mask.querySelector("summary, button, input, select");
      if (first && first.focus) { try { first.focus(); } catch (e) { /* 忽略 */ } }
    }, 30);
  }
}
function closeProviderModal() { setProviderModal(false); }
$("prov-add-open").onclick = () => setProviderModal(true);
$("prov-modal-close").onclick = closeProviderModal;
$("prov-modal-mask").onclick = (e) => { if (e.target === $("prov-modal-mask")) closeProviderModal(); };
document.addEventListener("keydown", (e) => {
  const mask = $("prov-modal-mask");
  if (e.key === "Escape" && mask && !mask.hidden) { e.preventDefault(); closeProviderModal(); }
});
$("prov-add").onclick = () => {
  const id = $("prov-id").value.trim(), url = $("prov-url").value.trim();
  if (!id || !url) return;
  if (provDraft === null) provDraft = [];
  if (provDraft.some((x) => x.id === id)) { $("models-status").textContent = "id 已存在:" + id; return; }
  const type = $("prov-type").value;
  provDraft.push({ id, name: $("prov-name").value.trim(), baseUrl: url, apiKeyEnv: $("prov-key").value.trim() || undefined, ...(type !== "chat" ? { apiType: type } : {}), models: [] });
  for (const el of [$("prov-id"), $("prov-name"), $("prov-url"), $("prov-key")]) el.value = "";
  $("prov-type").value = "chat";
  sendProviders(); renderProviders(); closeProviderModal();
};

// 角色模型下拉:数据源=providers[].models ∪ 最近拉取列表 ∪ 当前值;写同一 cfg 字段
const ROLE_DEFS = [
  { id: "role-main", key: "main", badge: "role-main-badge", empty: "(未配置)", label: "主模型" },
  { id: "role-subagent", key: "subagent", badge: "role-subagent-badge", empty: "(默认使用主模型)", label: "子代理模型" },
  { id: "role-compact", key: "compact", badge: "role-compact-badge", empty: "(默认使用主模型)", label: "压缩模型" },
  { id: "role-digest", key: "digest", badge: "role-digest-badge", empty: "(默认回退压缩模型)", label: "提炼模型" },
  { id: "role-review", key: "review", badge: "role-review-badge", empty: "(不配置=仅确定性层)", label: "评审模型" },
  { id: "role-voice", key: "voice", badge: "role-voice-badge", empty: "(未配置=语音任务书不可用)", label: "语音任务书模型" },
];
function roleCurrent(c, key) {
  const llm = (c.coding && c.coding.llm) || {};
  const md = (c.coding && c.coding.models) || {};
  if (key === "main") return llm.model || "";
  return (md[key] && md[key].model) || "";
}
function renderRoleSelects() {
  const c = (cfgView && cfgView.config) || {};
  const entries = modelCatalogEntries();
  const off = disabledModels();
  for (const def of ROLE_DEFS) {
    const sel = $(def.id);
    if (!sel) continue;
    const cur = roleCurrent(c, def.key);
 // 语音任务书只认 omni 多模态(音频 input_audio):下拉只列名字含 omni 的模型(大小写不敏感);
 // 目录里没有 omni = 显式提示项;已配置的非 omni 旧值作保底项仍显示(配置不许被静默吞掉),
 // 但可选集里不会出现其它非 omni 模型。其余五个角色走原全量目录,不受影响。
    const omniOnly = def.key === "voice";
    const pool = omniOnly ? entries.filter((e) => /omni/i.test(String(e.name || ""))) : entries;
    const curIsOmni = /omni/i.test(String(cur || ""));
    const seen = new Set();
    let html = '<option value="">' + esc(def.empty) + '</option>';
    if (omniOnly && !pool.length) html += '<option value="__no_omni__" disabled>' + esc("(目录中无 omni 模型)") + '</option>';
    for (const e of pool) {
      if (!e.name || seen.has(e.name) || off.indexOf(e.name) >= 0) continue;
      seen.add(e.name);
      const hint = e.provider ? " · " + (e.provider.name || e.provider.id) : "";
      html += '<option value="' + esc(e.name) + '">' + esc(e.name + hint) + '</option>';
    }
    if (cur && !seen.has(cur)) {
      const suffix = omniOnly && !curIsOmni ? " · (当前值,非 omni,请更换)" : " · (当前,未登记)";
      html += '<option value="' + esc(cur) + '">' + esc(cur + suffix) + '</option>';
    }
    if (sel.innerHTML !== html) sel.innerHTML = html;
    sel.value = cur;
  }
}
function roleProviderId(def, c) {
  const md = (c.coding && c.coding.models) || {};
  const ref = (def.key !== "main" && md[def.key]) || {};
  if (ref.providerId) return ref.providerId;
  if (ref.baseUrl) {
    const p = (provDraft || []).find((x) => x.baseUrl === ref.baseUrl);
    if (p) return p.id;
  }
  return currentProviderIdOf((c.coding && c.coding.llm) || {});
}
/** 角色/主模型补丁:模型属于当前生效 Provider 时只写 model(热);跨 Provider 同步 route(冷,重启切换)。 */
function rolePatch(def, model) {
  const c = (cfgView && cfgView.config) || {};
  const e = model ? modelEntryByName(model) : null;
  if (def.key === "main") {
    const patch = { coding: { llm: { model } } };
    const curPid = currentProviderIdOf((c.coding && c.coding.llm) || {});
    if (e && e.provider && e.provider.id !== curPid) {
      patch.coding.llm.providerId = e.provider.id;
      patch.coding.llm.baseUrl = e.provider.baseUrl;
      patch.coding.llm.apiKeyEnv = e.provider.apiKeyEnv || "GENIE_LLM_API_KEY";
    }
    return patch;
  }
  const patch = { coding: { models: { [def.key]: { model } } } };
  const rolePid = roleProviderId(def, c);
  const mainPid = currentProviderIdOf((c.coding && c.coding.llm) || {});
 // 角色已绑定非主 Provider:该角色模型变更一律带 route(冷项,避免把新模型热切到仍在跑的主端点);
 // 同 Provider 角色保持 model-only(热)。选到别家 Provider 时同步目标 route。
  const routePv = rolePid && mainPid && rolePid !== mainPid
    ? (e && e.provider ? e.provider : (provDraft || []).find((x) => x.id === rolePid))
    : (e && e.provider && e.provider.id !== rolePid ? e.provider : null);
  if (routePv) {
    patch.coding.models[def.key].providerId = routePv.id;
    patch.coding.models[def.key].baseUrl = routePv.baseUrl;
    patch.coding.models[def.key].apiKeyEnv = routePv.apiKeyEnv || "GENIE_LLM_API_KEY";
  }
  return patch;
}
for (const def of ROLE_DEFS) {
  const sel = $(def.id);
  if (!sel) continue;
  sel.onchange = () => {
    const v = sel.value;
    const c = (cfgView && cfgView.config) || {};
    const cur = roleCurrent(c, def.key);
    if (v === cur) return;
    if (def.key === "main" && !v) { sel.value = cur; return; }
    const badge = $(def.badge);
    if (badge) { badge.textContent = "应用中…"; badge.className = "sd cfg-wait"; }
    const patch = rolePatch(def, v);
    wsSafeSend(JSON.stringify({ v: 1, type: "cfg.set", patch }));
    toast(def.label + " → " + (v || def.empty) + "(已提交,等待服务端确认…)");
  };
}
// 运行配置组:生效配置+来源层标记(default<user<project<env);模型可热切
function renderCfg() {
  if (!cfgView) return;
  const c = cfgView.config || {};
  const src = (k) => { const s = (cfgView.sources || {})[k]; return s ? " (" + s + ")" : ""; };
  const cl = (c.coding && c.coding.llm) || {};
  const md = (c.coding && c.coding.models) || {};
  $("cfg-mt").value = cl.maxTokens != null ? String(cl.maxTokens) : "";
  renderRoleSelects();
  renderEffortSeg();
  const au = c.audio || {};
  $("a-chat-model").value = (au.chat && au.chat.model) || "";
  $("a-chat-url").value = (au.chat && au.chat.baseUrl) || "";
  $("a-asr-prov").value = (au.asr && au.asr.provider) || "";
  $("a-asr-model").value = (au.asr && au.asr.model) || "";
  $("a-tts-prov").value = (au.tts && au.tts.provider) || "";
  $("a-tts-model").value = (au.tts && au.tts.model) || "";
  $("a-tts-voice").value = (au.tts && au.tts.voice) || "";
  $("audio-track").textContent = "当前对话轨道:" + (sysMeta.llmTrack || "(未标注)");
  $("cfg-path").textContent = "配置来源:内置默认 < 用户级 < 项目级 < 环境变量";
  const cc = c.concurrency || {};
  const ag = c.agent || {};
  const rows = [
    ["coding.llm.baseUrl", (cl.baseUrl || "(未配置)") + src("coding.llm.baseUrl")],
    ["coding.llm.apiKeyEnv", (cl.apiKeyEnv || "(轨默认 GENIE_LLM_API_KEY)") + src("coding.llm.apiKeyEnv")],
    ["coding.llm.timeoutMs", (cl.timeoutMs ?? "-") + "ms" + src("coding.llm.timeoutMs")],
    ["coding.models.subagent", ((md.subagent && md.subagent.model) || "(默认使用主模型)") + src("coding.models.subagent.model")],
    ["coding.models.compact", ((md.compact && md.compact.model) || "(默认使用主模型)") + src("coding.models.compact.model")],
    ["coding.models.digest", ((md.digest && md.digest.model) || "(默认回退压缩模型)") + src("coding.models.digest.model")],
    ["coding.models.review", ((md.review && md.review.model) || "(未配置=仅确定性层)") + src("coding.models.review.model")],
    ["coding.models.voice", ((md.voice && md.voice.model) || "(未配置=语音任务书不可用)") + src("coding.models.voice.model")],
    ["executor.kind", (c.executor && c.executor.kind || "-") + src("executor.kind")],
 // journal.dir 不在模型区展示(板 mm-page 负面断言:不暴露本机路径/目录键)
    ["并发 全局/每用户/系统", [(cc.maxConcurrent ?? "-"), (cc.maxConcurrentPerOwner ?? "-"), (cc.maxConcurrentSystem ?? "-")].join(" / ") + src("concurrency.maxConcurrent")],
    ["agent.maxSteps", (ag.maxSteps ?? "-") + src("agent.maxSteps")],
    ["压缩阈值 tokens", (ag.compactThresholdTokens ?? "-") + src("agent.compactThresholdTokens")],
  ];
  $("cfg-kv").innerHTML = rows.map((r) => '<span class="k">' + esc(r[0]) + '</span><span class="v">' + esc(redactPaths(String(r[1]))) + '</span>').join(NL);
 // 自动归档阈值:cfg.set tasks.autoArchiveDays(0=关)
  const archRow = '<span class="k">自动归档(天)</span><span class="v"><input id="cfg-arch" style="width:60px;background:transparent;border:1px solid var(--border-soft);border-radius:6px;color:var(--text);font-size:10px;padding:2px 6px" value="' + ((cfgView && cfgView.config && cfgView.config.tasks && cfgView.config.tasks.autoArchiveDays) || 0) + '"></span>';
  $("cfg-kv").innerHTML += NL + archRow;
  const archEl = $("cfg-arch");
  if (archEl) archEl.onchange = () => {
    const v = Math.max(0, Math.floor(Number(archEl.value) || 0));
    archEl.value = String(v);
    wsSafeSend(JSON.stringify({ v: 1, type: "cfg.set", patch: { tasks: { autoArchiveDays: v } } }));
    toast("自动归档阈值=" + (v ? v + " 天" : "关闭") + "(清扫每小时/下轮生效)");
  };
}
function bindCfgApply(inputId, btnId, badgeId, makePatch, allowEmpty) {
  if (!$(inputId) || !$(btnId) || !$(badgeId)) return; // 缺元素跳过该项(此前炸整面板初始化,所有交互全死)
  const run = () => {
    const v = $(inputId).value.trim();
    if (!v && !allowEmpty) return;
    $(badgeId).textContent = "应用中…"; $(badgeId).className = "sd cfg-wait";
    wsSafeSend(JSON.stringify({ v: 1, type: "cfg.set", patch: makePatch(v) }));
  };
  $(btnId).onclick = run;
  $(inputId).onkeydown = (e) => { if (e.key === "Enter") run(); };
}
bindCfgApply("cfg-mt", "cfg-mt-apply", "cfg-mt-badge",
  (v) => ({ coding: { llm: { maxTokens: v ? Number(v) : 0 } } }), true);

bindCfgApply("a-chat-model", "a-chat-apply", "a-chat-badge", (v) => ({ audio: { chat: { model: v } } }), true);

$("a-chat-url-apply").onclick = () => {
  const v = $("a-chat-url").value.trim();
  $("a-chat-url-badge").textContent = "应用中…";
  wsSafeSend(JSON.stringify({ v: 1, type: "cfg.set", patch: { audio: { chat: v ? { baseUrl: v } : { baseUrl: "" } } } }));
};
$("a-asr-apply").onclick = () => {
  $("a-asr-badge").textContent = "应用中…";
  wsSafeSend(JSON.stringify({ v: 1, type: "cfg.set", patch: { audio: { asr: { provider: $("a-asr-prov").value.trim(), model: $("a-asr-model").value.trim() } } } }));
};
$("a-tts-apply").onclick = () => {
  $("a-tts-badge").textContent = "应用中…";
  wsSafeSend(JSON.stringify({ v: 1, type: "cfg.set", patch: { audio: { tts: { provider: $("a-tts-prov").value.trim(), model: $("a-tts-model").value.trim(), voice: $("a-tts-voice").value.trim() } } } }));
};
$("models-probe-all").onclick = () => {
 // 全部检测( F4):队列并发 3 逐个真实探活;进度写按钮文字,徽标逐行落地。
 // 检测对象=模型目录(Provider 条目 ∪ 拉取列表),按条目归属 provider 探活。
  const entries = modelCatalogEntries();
  if (!entries.length) { $("models-status").textContent = "模型目录为空"; return; }
  probeDone = 0; probeTotal = entries.length; probeActive = 0;
  probeQueue = entries.slice();
  for (const e of probeQueue) modelProbe[e.name] = undefined;
  probePump();
};
$("models-fetch").onclick = () => {
  $("models-status").textContent = "拉取中…";
  wsSafeSend(JSON.stringify({ v: 1, type: "models.list" }));
};
// 添加自定义模型(写默认 Provider 的 models[];立即进入角色下拉与模型目录)
$("cm-new-add").onclick = () => {
  const name = $("cm-new-name").value.trim();
  const status = $("cm-new-status");
  if (!name) { status.textContent = "模型名不能为空"; return; }
  if (!provDraft || !provDraft.length) { status.textContent = "先添加 Provider"; return; }
  const idx = Number($("cm-new-prov").value);
  const pv = provDraft[idx] || provDraft[defaultProviderIndex()];
  if (!pv) { status.textContent = "先添加 Provider"; return; }
  if ((pv.models || []).some((mm) => modelNameOf(mm) === name)) { status.textContent = "已存在:" + name; return; }
  const cw = Number($("cm-new-cw").value) || undefined;
  const mt = Number($("cm-new-mt").value) || undefined;
  pv.models = pv.models || [];
  pv.models.push({ name, ...(cw ? { contextWindow: cw } : {}), ...(mt ? { maxTokens: mt } : {}) });
  sendProviders(); renderProviders(); renderModelList(); renderRoleSelects();
  $("cm-new-name").value = ""; $("cm-new-cw").value = ""; $("cm-new-mt").value = "";
  status.textContent = "已添加:" + name + " → " + pv.id;
};

function renderSys() {
  const rows = [];
  for (const [k, v] of Object.entries(sysMeta)) {
    if (k === "startedAt") {
      const up = Math.max(0, Math.floor((Date.now() - Number(v)) / 60000));
      rows.push('<span class="k">运行时长</span><span class="v">' + (up >= 60 ? Math.floor(up / 60) + " 小时 " + (up % 60) + " 分" : up + " 分钟") + '</span>');
    } else {
 // 隐私:路径类值只给末段/脱敏,不暴露本机绝对路径。
      const val = k === "repoRoot" ? pathBasename(v) : redactPaths(String(v));
      rows.push('<span class="k">' + esc(k) + '</span><span class="v">' + esc(val) + '</span>');
    }
  }
  const list = [...tasks.values()];
  const c2 = (s) => list.filter((t) => t.state === s).length;
  rows.push('<span class="k">任务</span><span class="v">' + list.length + ' 条(运行 ' + c2("running") + ' / 完成 ' + c2("done") + ' / 失败 ' + (c2("failed") + c2("cancelled")) + ')</span>');
  if (projState) rows.push('<span class="k">项目扫描</span><span class="v">' + esc(projState) + '</span>');
  if (sysMeta.journalEvents !== undefined) rows.push('<span class="k">事件日志</span><span class="v">' + sysMeta.journalEvents + ' 条(启动时点)</span>');
  if (Array.isArray(sysMeta.tools)) rows.push('<span class="k">主 agent 工具</span><span class="v">' + sysMeta.tools.length + ' 个</span>');
  $("sys-kv").innerHTML = rows.join(NL);
  $("sys-proj").textContent = "本机数据 · 模型服务" + (sysMeta.llm === "on" ? "正常" : "(" + (sysMeta.llm || "?") + ")");
  $("uSub").textContent = "已连接 · 模型服务 " + (sysMeta.llm === "on" ? "正常" : (sysMeta.llm || "?")) + " · " + (sysMeta.executor === "echo-child" ? "内置执行器" : (sysMeta.executor || "…"));
  const root = String(sysMeta.repoRoot || "").split("/").filter(Boolean);
 // 项目清单已水化时以项目名为准;新用户没有可见项目时保持空态,不回显根目录名。
  if (!projects.length) $("projName").textContent = "尚未打开项目";
}
let expDisabled = [];
function renderExp() {
  $("exp-list").innerHTML = expItems.length
    ? expItems.map((x, i) =>
        '<div class="exp-item" data-i="' + i + '"><div><span class="exp-cat">' + esc(x.category) + '</span><span class="exp-name">' + esc(x.name) + '</span></div>' +
        '<div class="exp-desc">' + esc(x.description) + '</div></div>').join("")
    : '<div class="cc-empty">经验库为空 —— 任务完成后主 agent 自动沉淀</div>';
  if (expDisabled.length) {
    $("exp-list").innerHTML += '<div class="cc-empty" style="text-align:left">已禁用(' + expDisabled.length + ",不注入):</div>" +
      expDisabled.map((x, i) => '<div class="exp-item" data-d="' + i + '"><div><span class="exp-cat">' + esc(x.category) + '</span><span class="exp-name">' + esc(x.name) + '</span></div><button class="tm-item" style="font-size:9px;padding:1px 7px;color:var(--green)">恢复</button></div>').join("");
    for (const el of $("exp-list").querySelectorAll(".exp-item[data-d]")) {
      const btn = el.querySelector("button");
      if (btn) btn.onclick = (e) => {
        e.stopPropagation();
        const x = expDisabled[Number(el.dataset.d)];
        wsSafeSend(JSON.stringify({ v: 1, type: "exp.disable", category: x.category, name: x.name, disabled: false }));
      };
    }
  }
  for (const el of $("exp-list").querySelectorAll(".exp-item")) {
    el.onclick = () => {
      const x = expItems[Number(el.dataset.i)];
      wsSafeSend(JSON.stringify({ v: 1, type: "exp.view", category: x.category, name: x.name }));
    };
 // 禁用按钮(禁用后不再注入新任务;恢复入口在底部)
    const btn = document.createElement("button");
    btn.textContent = "禁用";
    btn.className = "tm-item";
    btn.style.cssText = "font-size:9px;padding:1px 7px;color:var(--red)";
    btn.onclick = (e) => {
      e.stopPropagation();
      const x = expItems[Number(el.dataset.i)];
      uiConfirm("禁用经验 " + x.category + "/" + x.name + "?(不再注入;底部可恢复)").then((ok) => {
        if (ok) wsSafeSend(JSON.stringify({ v: 1, type: "exp.disable", category: x.category, name: x.name, disabled: true }));
      });
    };
    el.appendChild(btn);
 // 删除按钮(「经验库应当可以删除」):物理删目录、不可逆,二次确认。
    const del = document.createElement("button");
    del.textContent = "删除";
    del.className = "tm-item";
    del.style.cssText = "font-size:9px;padding:1px 7px;color:var(--red);margin-left:4px";
    del.onclick = (e) => {
      e.stopPropagation();
      const x = expItems[Number(el.dataset.i)];
      uiConfirm("删除经验 " + x.category + "/" + x.name + "?(物理删除目录,不可恢复)").then((ok) => {
        if (ok) wsSafeSend(JSON.stringify({ v: 1, type: "exp.remove", category: x.category, name: x.name }));
      });
    };
    el.appendChild(del);
  }
}
function log() {}
// ── 流式消息(ZCode 流式消息展示) ──
// 服务端旁路 stream 消息:llm-begin/delta(打字机)/end(终稿)+ tool-begin/end(执行中卡)。
// 草稿块只存在于内存渲染;真 message.agent/tool.result 经增量拉取到达后让位(去重),终态由 journal 承接。
let stStream = null; // {sid, text, reasoning, done, tools:[{callId,name,durationMs,running}]}
let stTid = 0, stPullT = 0;
let ssChgTid = 0; // fixF2: session.status.changed 回拉 debounce 句柄(150ms,连发只落末次)
function stThrottle() { if (stTid) return; stTid = setTimeout(() => { stTid = 0; renderHistory(); }, 60); }
function stPullEnsure() {
 // 流期间周期增量拉取 journal:已完成的中间块/工具卡实时转正(不只等 task 状态变化)。
 // fixF2: 1.5s→3s——流式期间 stPull 每拍都触发服务端 session.status 全量重算(F1 前的卡顿源
 // 之一);3s 配合 F1 索引+sinceSeq 增量游标(refreshHist 带水位),转正时延感知不变(流式
 // 正文仍由 stream 消息实时驱动,这里只转正已完成块)。
  if (stPullT) return;
  stPullT = setInterval(() => {
    if (!stStream) { clearInterval(stPullT); stPullT = 0; return; }
    refreshHist();
  }, 3000);
}
function stReset(sid) { stStream = { sid: sid, text: "", reasoning: "", done: false, tools: [] }; }
// ── 子代理流式(子代理与 coding agent 同构)──
// 子 loop 的 stream 事件 sid=subagent-<taskId>(与主 agent 同一 streamSink);按 sid 存草稿,
// 子代理工作区渲染时经事件 taskId 归属到 agent。真 subagent.event message.agent 到达即让位。
const subStreams = new Map(); // sid -> {text, reasoning, done, tools:[], startedAt}
let subStTid = 0;
function subStThrottle() { if (subStTid) return; subStTid = setTimeout(() => { subStTid = 0; if (subWsActive) renderHistory(); }, 60); }
/** 该 agent 的活跃草稿:从其事件里取 taskId→sid,取最近一条有内容的草稿。 */
function subAgentDraftOf(agentEvents) {
  let best = null;
  for (const ev of agentEvents) {
    const sid = "subagent-" + String((ev.payload || {}).taskId || "");
    if (!sid || sid === "subagent-") continue;
    const d = subStreams.get(sid);
    if (d && (!best || d.startedAt > best.startedAt)) best = d;
  }
  return best;
}
function onStreamEv(m) {
  if (!m) return;
 // 子代理流(sid=subagent-*):进 subStreams,激活的工作区实时渲染;不碰主会话 stStream。
  if (String(m.sessionId || "").indexOf("subagent-") === 0) {
    const ev = m.ev || {};
    if (ev.type === "llm-begin") { subStreams.set(m.sessionId, { text: "", reasoning: "", done: false, tools: [], startedAt: Date.now() }); subStThrottle(); return; }
    let d = subStreams.get(m.sessionId);
    if (!d) { d = { text: "", reasoning: "", done: false, tools: [], startedAt: Date.now() }; subStreams.set(m.sessionId, d); }
    if (ev.type === "llm-delta") {
      if (ev.text) d.text += ev.text;
      if (ev.reasoning) d.reasoning += ev.reasoning;
      d.done = false;
      subStThrottle();
    } else if (ev.type === "llm-end") {
      d.done = true;
      if (ev.text) d.text = ev.text;
      subStThrottle();
    } else if (ev.type === "tool-begin") {
      d.tools.push({ callId: ev.callId, name: ev.name, durationMs: 0, running: true });
      subStThrottle();
    } else if (ev.type === "tool-progress") {
      const t = d.tools.find((x) => x.callId === ev.callId);
      if (t) { t.note = ev.note; subStThrottle(); }
    } else if (ev.type === "tool-end") {
      const t = d.tools.find((x) => x.callId === ev.callId);
      if (t) { t.running = false; t.durationMs = ev.durationMs || 0; t.note = ""; }
      subStThrottle();
    }
    return;
  }
  if (m.sessionId !== currentSid) return; // 非当前会话不渲染(终态由该会话 history 承接)
  const ev = m.ev || {};
  if (ev.type === "llm-begin") { stReset(m.sessionId); renderHistory(); refreshHist(); stPullEnsure(); }
  else if (ev.type === "llm-delta") {
    if (!stStream) stReset(m.sessionId);
    if (ev.text) stStream.text += ev.text;
    if (ev.reasoning) stStream.reasoning += ev.reasoning;
    stStream.done = false;
    stThrottle();
  }
  else if (ev.type === "llm-end") {
    if (stStream) { stStream.done = true; if (ev.text) stStream.text = ev.text; }
    renderHistory(); refreshHist(); // 终稿已落 journal(message.agent)→立即拉取转正
  }
  else if (ev.type === "tool-begin") {
    if (!stStream) { stReset(m.sessionId); stStream.done = true; }
    stStream.tools.push({ callId: ev.callId, name: ev.name, durationMs: 0, running: true });
    renderHistory();
  }
  else if (ev.type === "tool-progress") {
 // fixC-D4:长工具阶段进度(code_review 深审等)——运行中行实时显示 note,防「以为挂了」
    if (stStream) {
      const t = stStream.tools.find((x) => x.callId === ev.callId);
      if (t) { t.note = ev.note; renderHistory(); }
    }
  }
  else if (ev.type === "tool-end") {
    if (stStream) {
      const t = stStream.tools.find((x) => x.callId === ev.callId);
      if (t) { t.running = false; t.durationMs = ev.durationMs || 0; t.note = ""; }
      renderHistory();
    }
  }
}
function wsOnOpen() { lastPong = Date.now(); $("status").className = "d on"; $("conn").textContent = "已连接";
  try { renderModelSwitch(); refreshSecretKeyState(true); } catch (e) { /* 首帧页面未就绪时忽略 */ }
  cvConn(true, "已连接");
  wsSafeSend(JSON.stringify({ v: 1, type: "sys.meta" }));
  wsSafeSend(JSON.stringify({ v: 1, type: "exp.list" }));
  wsSafeSend(JSON.stringify({ v: 1, type: "cfg.get" }));
  if (rcAttempt > 0) { // 重连成功(非首连):清退避计数+撤角标+增量重放。hello(任务历史)由服务端
 // 重连后自动重推(onmessage merge);当前会话走 session.history sinceSeq 水位补断连窗口的新事件,
 // seq 去重=重复重连不产生重复卡(幂等);DOM/视图全程不动,不再整页刷新。
    const n = rcAttempt; rcAttempt = 0; svcBanner(false);
 // 会话Chat 退役;super 聊天重连由既有 hello/super.history 重放追平(此处无额外态)
    $("conn").textContent = "已连接 · 重连成功(第 " + n + " 次尝试)";
    setTimeout(() => { if (String($("conn").textContent).indexOf("重连成功") >= 0) $("conn").textContent = "已连接"; }, 4000);
    refreshHist(); render();
    cvConn(true, "已连接(重连成功)");
 // 重放追平(步进):断连窗口的任务在重连后仍可能在写 journal(快照/长尾),单次拉取会跑在
 // 写入前面;主会话无工作区 tab 时 dashboard.changed 不触发拉史(设计如此)——补两拍增量追平。
    [1500, 4000].forEach((ms) => setTimeout(() => { try { if (ws && ws.readyState === 1 && currentSid) refreshHist(); } catch (e) { /* 追平失败由常规通道兜底 */ } }, ms));
    try { if (viewLive("board")) boardRefresh(); } catch (e) { /* 板视图恢复失败不影响连接态 */ }
  }
}
function wsOnClose() {
  try { renderModelSwitch(); } catch (e) { /* 重连期间页面可能未就绪 */ }
  $("status").className = "d";
  if (rcTimer) { clearTimeout(rcTimer); rcTimer = 0; }
  if (rcAttempt >= RC_MAX) {
 // 保底(语义不删):连续 N 次重连失败 → 探活等待+恢复后 reload。
    svcWaitRestart(); return;
  }
  const base = Math.max(1, Number(settings.reconnect) || 3);
  const delay = Math.min(30, base * Math.pow(2, rcAttempt)); // 指数退避:3,6,12,24,30,30(封顶 30s)
  rcAttempt++;
  $("conn").textContent = "重连中 · 第 " + rcAttempt + " 次(" + delay + "s 后)";
  cvConn(false, "重连中 · 第 " + rcAttempt + " 次");
 // 重连中角标:会话内容/DOM 原样保留,重连成功就地增量重放(替代 location.reload 整页刷新,
 //; 的盲 reload 撞裸错误页问题随之消失——不再主动刷新)。
  svcBanner(true, "连接断开 · 自动重连中(第 " + rcAttempt + "/" + RC_MAX + " 次,约 " + delay + "s 后)——会话内容已保留");
  rcTimer = setTimeout(() => { rcTimer = 0; connectWs(); }, delay * 1000);
 // 会话Chat 退役,断连错误态由 super 聊天重连重放承担(rsiChatNoteErr 已空实现)
}
function wireWs() {
  if (!ws) return;
  ws.onopen = wsOnOpen; ws.onclose = wsOnClose; ws.onmessage = wsOnMessage;
  ws.addEventListener("open", () => { const q = wsQueue.splice(0); for (const p of q) { try { ws.send(p); } catch (e) { /* 冲刷失败丢弃 */ } } }); // 队列在开连时冲刷(含重连冲刷;原版注册在 onopen 内=open 已过后注册,冲刷永不上板, 顺修)
}
`;
