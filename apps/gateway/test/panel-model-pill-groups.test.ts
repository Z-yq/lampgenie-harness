import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";

/** step-132 模型快切菜单:provider 两层分组(ZCode ModelConfigSelect 语义)的结构回归。
 * 真 UI 在 panel.ts 模板字符串内(浏览器侧),这里锁关键面不丢:两级渲染函数/直展组与折叠组
 * 双标记/二级面板 + 返回行/sticky footer/视觉徽标真源/两级判定常量/端点一致性补丁。 */
describe("step-132 模型菜单 provider 两层分组", () => {
  const fetchHtml = async (port: number) => {
    const panel = servePanel(port, () => {});
    try {
      await new Promise((r) => setTimeout(r, 100));
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
      return await res.text();
    } finally {
      await panel.close();
    }
  };

  it("两级渲染函数与新增 CSS(二级面板/sticky footer/组徽标/视觉·未验证标记)在模板里", async () => {
    const html = await fetchHtml(7896);
    for (const marker of [
      // 新增渲染函数(两层级 + 视觉能力 + 组徽标)
      "function modelMenuOpen(fallbackIds)",
      "function modelMenuHtml(groups, current, subKey)",
      "function modelMenuBind(el, groups, current, subKey)",
      "function modelMenuFit(el)",
      "function modelItemHtml(it, current)",
      "function modelVisionCapable(name, entry)",
      "function modelProviderBadge(p)",
      "function presetOfProvider(p)",
      "function endpointModelGroup(list, cur)",
      "MODEL_VISION_NAME_HINTS",
      // 新增 CSS 类
      ".pill-menu .pm-badge{", ".pill-menu .pm-badge.plan{", ".pill-menu .pm-badge.local{",
      ".pill-menu .pm-chev{", ".pill-menu .pm-vis{", ".pill-menu .pm-unv{",
      ".pill-menu .pm-back{", ".pill-menu .pm-lv2 .pm-head{", ".pill-menu .pm-ghead{",
      ".pill-menu .pm-foot.sticky{",
      'el.className = "pill-menu model-menu"',
    ]) {
      expect(html, "缺少标记:" + marker).toContain(marker);
    }
    // 零反斜杠纪律(浏览器侧字符串字面量不被转义):判定用 includes、无正则字面量
    expect(html).toContain('n.includes(h)');
    expect(html).toContain('base.includes("localhost")');
  });

  it("按 provider 分层:直展组 / 折叠组 / 二级面板(‹ 返回)双标记都在", async () => {
    const html = await fetchHtml(7897);
    for (const marker of [
      // 直展组(含当前选中模型的 provider):组标题 + 组内模型平铺
      'class="pm-grp direct" data-g="',
      // 折叠组:一级一行(label + 徽标 + 若含当前项 ✓ + chevron)
      'class="pm-grp folded" data-g="',
      'data-act="group" data-g="',
      'class="pm-chev">',
      // 二级面板:原位切换 + 顶部「‹ 返回」
      'class="pm-grp pm-lv2" data-g="',
      'data-act="back"',
      "‹ 返回",
      'ic("chev-right", "pm-flip")',
      // 折叠组判定 + 一级直接展开判定
      "directItems: hit", "containsCurrent: hit",
      // 折叠组排序:含当前项的 provider 置顶
      "groups.sort((a, b) => (b.containsCurrent ? 1 : 0) - (a.containsCurrent ? 1 : 0))",
      // 键盘可达:折叠组行/返回行 tabindex + Enter/Space
      'data-act="group" data-g="\' + esc(g.key) + \'" tabindex="0"',
      'e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar"',
    ]) {
      expect(html, "缺少标记:" + marker).toContain(marker);
    }
    // 组徽标只用配置能证实的维度:套餐/本地/自定义/API——不编造账号类型
    expect(html).toContain('return { label: "套餐", cls: "plan" };');
    expect(html).toContain('return { label: "本地", cls: "local" };');
    expect(html).toContain('return { label: "自定义", cls: "custom" };');
    expect(html).toContain('return { label: "API", cls: "api" };');
    expect(html, "不得编造账号类型徽标").not.toContain('label: "个人"');
    expect(html, "不得编造账号类型徽标").not.toContain('label: "Free"');
  });

  it("判定逻辑纯函数化自测(视觉能力真源 / 两层分组 / 组徽标 / 未验证标注 / providerId 随项)", async () => {
    const html = await fetchHtml(7899);
    /** 从面板模板里抽出顶层函数源码(浏览器侧不可 import;本文件是单文件模板+内嵌脚本)。 */
    const sliceTopFn = (header: string) => {
      const i = html.indexOf(header);
      expect(i, "找不到函数:" + header).toBeGreaterThan(0);
      const j = html.indexOf("\n}\n", i);
      expect(j, header + " 未闭合").toBeGreaterThan(i);
      return html.slice(i, j + 2);
    };
    const hints = html.slice(html.indexOf("const MODEL_VISION_NAME_HINTS = ["), html.indexOf("];\n", html.indexOf("const MODEL_VISION_NAME_HINTS = [")) + 3);
    const src = [
      hints,
      sliceTopFn("function modelVisionCapable("),
      sliceTopFn("function presetOfProvider("),
      sliceTopFn("function modelProviderBadge("),
      sliceTopFn("function pillMenuModelGroups("),
      sliceTopFn("function modelItemHtml("),
      sliceTopFn("function modelMenuHtml("),
    ].join("\n");
    const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const ic = (n: string, c?: string) => '<svg class="icn' + (c ? " " + c : "") + '" data-icon="' + n + '"></svg>';
    type Item = { value: string; name: string; sub: string; providerId: string; unverified: boolean; vision: boolean; visionInferred: boolean };
    type Group = { key: string; label: string; labelBadge: string; directItems: boolean; containsCurrent: boolean; items: Item[] };
    const buildFn = new Function(
      "PROVIDER_PRESETS", "cfgView", "disabledModels", "verifiedModels", "modelEntryByName", "esc", "ic",
      src + "\nreturn { modelVisionCapable, modelProviderBadge, pillMenuModelGroups, modelMenuHtml };",
    ) as (presets: unknown, cfgView: unknown, off: () => string[], verified: Set<string>, byName: (n: string) => unknown, esc: (s: unknown) => string, ic: (n: string, c?: string) => string) => {
      modelVisionCapable: (n: string, e: unknown) => { vision: boolean; inferred: boolean };
      modelProviderBadge: (p: unknown) => { label: string; cls: string };
      pillMenuModelGroups: (cur: string) => Group[];
      modelMenuHtml: (groups: Group[], cur: string, subKey: string) => string;
    };
    const PRESETS = [
      { id: "zai", name: "智谱", modes: { api: { baseUrl: "https://open.bigmodel.cn/api/paas/v4" }, "token-plan": { baseUrl: "https://x/v4" } } },
      { id: "ollama", name: "Ollama", local: true, modes: { api: { baseUrl: "http://localhost:11434" } } },
      { id: "custom", name: "自定义", custom: true, modes: { api: { baseUrl: "https://x/v1" } } },
    ];
    const cfg = {
      providers: [
        { id: "zai", name: "智谱", baseUrl: "https://open.bigmodel.cn/api/paas/v4", authMode: "token-plan",
          models: [{ name: "GLM-5.3", supportsImage: false }, { name: "GLM-5V-Turbo" }, "GLM-4V-Flash"] },
        { id: "ollama", name: "Ollama", baseUrl: "http://localhost:11434", models: ["qwen3-vl-plus", "llama3.3"] },
        { id: "custom-x", name: "私有网关", baseUrl: "https://gw.internal/v1", models: [{ name: "my-model", supportsImage: true }] },
      ],
    };

    /** 简易构造:恒定 PRESETS / cfg,按用例给停用清单与已验证集合。 */
    const mk = (off: string[], verified: string[]) => buildFn(PRESETS, { config: cfg }, () => off, new Set(verified), () => null, esc, ic);

    // A1 视觉能力:supportsImage 权威 > 命名推断(注明 inferred)> false/不命中=不打
    const v1 = mk([], []);
    expect(v1.modelVisionCapable("my-model", { supportsImage: true })).toEqual({ vision: true, inferred: false });
    expect(v1.modelVisionCapable("any", { supportsImage: false })).toEqual({ vision: false, inferred: false });
    expect(v1.modelVisionCapable("GLM-5V-Turbo", { name: "GLM-5V-Turbo" })).toEqual({ vision: true, inferred: true });
    expect(v1.modelVisionCapable("qwen3-vl-plus", "qwen3-vl-plus")).toEqual({ vision: true, inferred: true });
    expect(v1.modelVisionCapable("gpt-4o-mini", null)).toEqual({ vision: true, inferred: true });
    expect(v1.modelVisionCapable("deepseek-v4.1-flash", null)).toEqual({ vision: false, inferred: false });
    expect(v1.modelVisionCapable("glm-4.6", null)).toEqual({ vision: false, inferred: false });

    // 组徽标:只用配置可证实的维度(套餐 / 本地 / 自定义 / API)
    expect(v1.modelProviderBadge(cfg.providers[0])).toEqual({ label: "套餐", cls: "plan" });
    expect(v1.modelProviderBadge(cfg.providers[1])).toEqual({ label: "本地", cls: "local" });
    expect(v1.modelProviderBadge(cfg.providers[2])).toEqual({ label: "自定义", cls: "custom" });
    expect(v1.modelProviderBadge({ id: "x", baseUrl: "https://api.example/v1" })).toEqual({ label: "API", cls: "api" });

    // A2 两层分组:含当前项的 provider 直展+置顶;其它折叠;providerId/视觉/未验证随项
    const g = v1.pillMenuModelGroups("GLM-5V-Turbo");
    expect(g.map((x) => x.key)).toEqual(["zai", "ollama", "custom-x"]);
    expect(g[0]).toMatchObject({ label: "智谱", labelBadge: "套餐", directItems: true, containsCurrent: true });
    expect(g[0].items.map((x) => x.value)).toEqual(["GLM-5.3", "GLM-5V-Turbo", "GLM-4V-Flash"]);
    expect(g[0].items.map((x) => x.providerId)).toEqual(["zai", "zai", "zai"]);
    expect(g[0].items.map((x) => x.vision)).toEqual([false, true, true]); // 未标注的 GLM-5V-Turbo 按命名推断
    expect(g[1]).toMatchObject({ directItems: false, containsCurrent: false, labelBadge: "本地" });
    expect(g[2]).toMatchObject({ directItems: false, labelBadge: "自定义" });
    expect(g[1].items.find((x) => x.value === "qwen3-vl-plus")!.visionInferred).toBe(true);

    // fixT7 未验证语义:verifiedModels 非空时,不在集合里的项标 unverified(信息不丢)
    const g2 = mk([], ["GLM-5.3"]).pillMenuModelGroups("GLM-5.3");
    expect(g2[0].items.find((x) => x.value === "GLM-5.3")!.unverified).toBe(false);
    expect(g2[0].items.find((x) => x.value === "GLM-5V-Turbo")!.unverified).toBe(true);
    expect(g2[2].items[0].unverified).toBe(true);

    // disabledModels 剔除
    const g3 = mk(["GLM-5.3", "llama3.3"], []).pillMenuModelGroups("GLM-5V-Turbo");
    expect(g3[0].items.map((x) => x.value)).toEqual(["GLM-5V-Turbo", "GLM-4V-Flash"]);
    expect(g3[1].items.map((x) => x.value)).toEqual(["qwen3-vl-plus"]);

    // 当前模型不在任何 provider 目录 → 「当前」兜底组(directItems,providerId 空=不误改路由)
    const g4 = mk([], []).pillMenuModelGroups("手填模型");
    expect(g4[0]).toMatchObject({ key: "@current", label: "当前", directItems: true, containsCurrent: true });
    expect(g4[0].items).toEqual([{ value: "手填模型", name: "手填模型", sub: "", providerId: "", vision: false, visionInferred: false, unverified: false }]);
    expect(g4.length).toBe(4);

    // A3 两级 HTML:一级=直展组平铺 + 折叠组单行(chevron) + sticky footer;二级=原位面板 + ‹ 返回
    const l1 = v1.modelMenuHtml(g, "GLM-5V-Turbo", "");
    expect(l1).toContain('<div class="pm-grp direct" data-g="zai">');
    expect(l1).toContain('<div class="pm-head pm-ghead">智谱 <span class="pm-badge plan">套餐</span></div>');
    expect(l1).toContain('<div class="pm-grp folded" data-g="ollama">');
    expect(l1).toContain('<div class="pm-item pm-ghead" data-act="group" data-g="ollama" tabindex="0">');
    expect(l1).toContain('<span class="pm-chev"><svg class="icn" data-icon="chev-right"></svg></span>');
    expect(l1).toContain('<div class="pm-foot sticky"><div class="pm-item" data-act="foot">');
    expect(l1, "一级不出现二级面板标记").not.toContain("pm-lv2");
    expect(l1, "直展组项平铺=一级即可见").toContain('data-v="GLM-4V-Flash" data-pid="zai"');
    const l2 = v1.modelMenuHtml(g, "GLM-5V-Turbo", "ollama");
    expect(l2).toContain('<div class="pm-grp pm-lv2" data-g="ollama">');
    expect(l2).toContain('<div class="pm-item pm-back" data-act="back" tabindex="0">');
    expect(l2).toContain("‹ 返回");
    expect(l2).toContain('<span class="pm-sub">Ollama · 本地</span>');
    expect(l2).toContain('data-v="qwen3-vl-plus" data-pid="ollama"');
    expect(l2, "二级只列该组模型").not.toContain("GLM-5.3");
    expect(l2, "footer 在二级同样置底").toContain('<div class="pm-foot sticky">');
    // 折叠组行 ✓ 语义:根据配置可证实的「当前主模型 / 角色模型(压缩·评审·子代理)」是否落在该端点
    const cfgRole = JSON.parse(JSON.stringify(cfg)) as typeof cfg & { coding: unknown };
    cfgRole.coding = { models: { compact: { model: "llama3.3" } } };
    const gRole = buildFn(PRESETS, { config: cfgRole }, () => [], new Set<string>(), () => null, esc, ic).pillMenuModelGroups("GLM-5V-Turbo");
    expect(gRole.find((x) => x.key === "ollama")).toMatchObject({ directItems: false, selectedHint: "含你正在用的角色模型(压缩/评审/子代理)" });
    const l1b = v1.modelMenuHtml(gRole, "GLM-5V-Turbo", "");
    expect(l1b).toContain('data-act="group" data-g="ollama" tabindex="0"><span class="pm-ck" title="含你正在用的角色模型(压缩/评审/子代理)"><svg class="icn" data-icon="check"></svg></span>');
    expect(l1b, "不含在用的模型/主模型的折叠组不打 ✓").toContain('<div class="pm-item pm-ghead" data-act="group" data-g="custom-x" tabindex="0"><span class="pm-ck" title="">');

    // 无 providers 且当前模型为空(未配置模型)→ 空数组(入口走 models.list 端点拉取兜底)
    const emptyCfg = buildFn(PRESETS, { config: { providers: [] } }, () => [], new Set<string>(), () => null, esc, ic);
    expect(emptyCfg.pillMenuModelGroups("")).toEqual([]);
    // providers 为空但已有当前模型 → 仅「当前」兜底组(不发模型拉取,不覆盖用户已有选择)
    expect(emptyCfg.pillMenuModelGroups("留存的模型")[0].key).toBe("@current");
  });

  it("fixT7「未验证」语义保留 + A4 端点一致性:模型项带 providerId 且 cfg.set 同时落 providerId/model", async () => {
    const html = await fetchHtml(7898);
    // 未验证语义不丢(标在项上,不再拆两批组)
    expect(html).toContain("unverified: !(verifiedModels.size === 0 || verifiedModels.has(name))");
    expect(html).toContain('class="pm-unv"');
    expect(html).toContain("端点未确认提供该模型");
    // 选中项带 providerId(2026-10-29:随 session.model.set 直接透传,服务端按 Provider Registry
    // 解析端点/凭证——前端不再拼 cfg.set patch,「模型新端点旧」一类问题在服务端预检解决)
    expect(html).toContain("function pillPickModel(v, providerId)");
    expect(html).toContain("...(providerId ? { providerId: providerId } : {})");
    // per-session 通道:选择落到 targetSid(会话或草稿预设),不发 cfg.set
    expect(html).toContain("const targetSid = currentSid || draftSidOf();");
    expect(html).toContain('type: "session.model.set", sessionId: targetSid, model: v');
    expect(html).not.toContain("patch: { coding: { llm: llm } }");
    expect(html, "调用点把项的 providerId 带进选择").toContain('pillPickModel(it.dataset.v, it.dataset.pid || "")');
    expect(html).toContain('data-pid="');
    // 视觉徽标真源:supportsImage===true 权威 / false 不打 / 未标注按命名推断并注明
    expect(html).toContain("if (entry && entry.supportsImage === true) return { vision: true, inferred: false };");
    expect(html).toContain("if (entry && entry.supportsImage === false) return { vision: false, inferred: false };");
    expect(html).toContain("按命名推断(条目未标注 supportsImage)");
    // 一级 footer「管理模型」sticky 且沿用既有跳转
    expect(html).toContain("switchView(\"sys\"); setSection(\"model\");");
    // 端点拉取兜底清单也走两级渲染器(不再另起一层菜单)
    expect(html).toContain("function modelMenuOpen(fallbackIds)");
    expect(html).toContain("// step-132:兜底清单也走两级渲染器(同一套直展组/折叠组 + sticky footer 语义)\n      modelMenuOpen(list);");
    // 既有通用渲染器未被改动(4 个无关调用方依赖其签名/行为)
    expect(html).toContain("function pillMenuOpen(anchor, groups, current, onPick, footLabel, footGo) {");
    expect(html).toContain("function pillOpenMenu() { modelMenuOpen(); }");
  });
});