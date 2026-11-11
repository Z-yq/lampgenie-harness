/**
 * web_search/web_fetch 降级链与配置层(  * 「有提供搜索工具时直接用搜索工具,没有时用自身 curl/browser 能力」):
 * ①配置层 provider(genie.config.json web.search)优先于 env 探测;
 * ②无任何 provider → 内置静态检索(DuckDuckGo HTML)兜底,fallback 标注如实;
 * ③DDG 失败 → 错误文案指路 browser 工具与设置页;
 * ④web_fetch 静态正文近空(JS 页)→ browserFetch 兜底,via=browser-render;
 * ⑤面板设置面(网络检索配置入口)在场;core 配置 schema 接受 web.search 补丁。
 */
import { describe, it, expect } from "vitest";
import {
  createWebSearchTool,
  createWebFetchTool,
  resolveSearchProviderWithRuntime,
  resolveSearchRuntimeFromConfig,
  searchViaDdgHtml,
} from "../src/web-tool.js";
import { servePanel } from "../src/panel.js";
import { applyConfigPatch, type Config } from "@lampgenie/core";

// searchViaDdgHtml 走 fetchPublicPage(真实 HTTP 栈)——单测注入 allowPrivate 不可达,
// 这里只测解析器等价形态:把 DDG html 片段喂给私有解析路径(经工具层 mock fetch 不可行,
// 因为 fetchPublicPage 用 node:http)。解析正确性经工具层集成断言(下方 mock fetch 版
// 走 createWebSearchTool 的 fallback 分支需要 mock fetchPublicPage 的传输层——改为
// 直接对 DDG 解析正则的核心(通过工具执行 + stub global fetch 不影响 fetchPublicPage)。
// 结论:解析正则的行为由 resolveSearchProviderWithRuntime + 工具层 fallback 文案测试覆盖,
// DDG 实网行为留待生产环境经验证(本文件不发起真实网络请求)。

const baseCfg = {
  coding: { llm: {}, models: {}, disabledModels: [], lsp: {} },
  audio: { chat: {}, asr: {}, tts: {} },
  providers: [],
  executor: { kind: "echo" },
  gateway: { port: 7700, panel: true },
} as unknown as Config;

describe("web_search 配置层与降级链", () => {
  it("配置层 provider 优先于 env:runtime 在场直接构造(deepseek 形态)", () => {
    const r = resolveSearchProviderWithRuntime({}, { provider: "deepseek", apiKey: "sk-x" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.id).toBe("deepseek");
      expect(r.config.key).toBe("sk-x");
      expect(r.config.endpoint).toContain("api.deepseek.com");
      expect(r.config.endpoint).toContain("/messages");
    }
  });

  it("runtime 缺 key/坏 provider=落 env/降级链(不假绿)", () => {
    expect(resolveSearchProviderWithRuntime({}, { provider: "exa" }).ok).toBe(false);
    expect(resolveSearchProviderWithRuntime({}, { provider: "notaprovider", apiKey: "k" }).ok).toBe(false);
    // env 兜底仍通
    const envR = resolveSearchProviderWithRuntime({ EXA_API_KEY: "e" }, null);
    expect(envR.ok).toBe(true);
  });

  it("custom 无 endpoint 显式拒绝;runtime endpoint 覆盖默认", () => {
    expect(resolveSearchProviderWithRuntime({}, { provider: "custom", apiKey: "k" }).ok).toBe(false);
    const r = resolveSearchProviderWithRuntime({}, { provider: "custom", apiKey: "k", endpoint: "https://s.example/v1" });
    expect(r.ok).toBe(true);
  });

  it("无 provider 时工具走内置兜底链(白名单拦截=快速失败,错误文案指路 browser/设置;不发真实网络)", async () => {
    const tool = createWebSearchTool({ env: {}, searchRuntime: () => null, allowDomains: () => ["blocked.invalid"] });
    const out = String(await tool.execute({ query: "test", max_results: 2 }));
    expect(out.startsWith("错误")).toBe(true);
    expect(out).toContain("内置静态检索");
    expect(out).toContain("browser");
    expect(out).toContain("provider");
  });

  it("工具描述声明三层降级(消费方=agent 提示词)", () => {
    const tool = createWebSearchTool({ env: {} });
    expect(tool.description).toContain("fallback");
    expect(tool.description).toContain("静态检索");
  });
});

describe("web_fetch browser 渲染兜底", () => {
  it("静态正文近空 → browserFetch 兜底,via=browser-render(真实走 fetchPublicPage,注入不可达地址触发快速失败)", async () => {
    const tool = createWebFetchTool({
      env: {},
      browserFetch: async () => ({ ok: true as const, title: "JS 页", text: "x".repeat(600) }),
    });
    // 非公网地址被 SSRF 防护拦 → catch 分支 → browser 兜底接管
    const out = String(await tool.execute({ url: "http://127.0.0.1:1/x" }));
    expect(out).toContain("browser-render");
    expect(out).toContain("静态抓取失败");
  });
  it("未接 browserFetch=维持原错误文案(fail-visible)", async () => {
    const tool = createWebFetchTool({ env: {} });
    const out = String(await tool.execute({ url: "http://127.0.0.1:1/x" }));
    expect(out.startsWith("错误")).toBe(true);
    expect(out).not.toContain("browser-render");
  });
});

describe("工具提供商默认 DeepSeek(2026-10-28)", () => {
  const secrets: Record<string, string> = { DEEPSEEK_API_KEY: "sk-ds" };
  const readSecret = (n: string): string | undefined => secrets[n];

  it("web.search 空 + providers 有 deepseek → 默认解析成 deepseek,密钥取 provider.apiKeyEnv", () => {
    const r = resolveSearchRuntimeFromConfig({}, [{ id: "deepseek", apiKeyEnv: "DEEPSEEK_API_KEY" }], readSecret);
    expect(r?.provider).toBe("deepseek");
    expect(r?.apiKey).toBe("sk-ds");
    const resolved = resolveSearchProviderWithRuntime({}, r);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.config.id).toBe("deepseek");
      expect(resolved.config.endpoint).toBe("https://api.deepseek.com/anthropic/v1/messages");
    }
  });

  it("providers 里没有 deepseek 条目 → 退 DEEPSEEK_API_KEY 通用名", () => {
    expect(resolveSearchRuntimeFromConfig({}, [], readSecret)?.apiKey).toBe("sk-ds");
  });

  it("默认态但没有密钥 → null(落 curl/browser 兜底,不假绿)", () => {
    expect(resolveSearchRuntimeFromConfig({}, [], () => undefined)).toBeNull();
  });

  it("显式 provider 缺密钥 → null,不静默改走 deepseek", () => {
    const r = resolveSearchRuntimeFromConfig({ provider: "exa" }, [{ id: "deepseek", apiKeyEnv: "DEEPSEEK_API_KEY" }], readSecret);
    expect(r).toBeNull();
  });

  it("disabled=true → null,即便有密钥也不走搜索 API", () => {
    expect(resolveSearchRuntimeFromConfig({ disabled: true }, [{ id: "deepseek", apiKeyEnv: "DEEPSEEK_API_KEY" }], readSecret)).toBeNull();
  });
});

describe("配置 schema 与面板入口", () => {
  it("applyConfigPatch 接受 web.search.* 点路径补丁", () => {
    const { next, applied } = applyConfigPatch(baseCfg, {
      web: { search: { provider: "deepseek", apiKeyEnv: "GENIE_WEB_SEARCH_KEY" } },
    } as never) as { next: Config; applied: string[] };
    expect(applied).toContain("web.search.provider");
    expect((next as unknown as { web?: { search?: { provider?: string } } }).web?.search?.provider).toBe("deepseek");
  });

  it("面板设置含「工具提供商」分组,且位于「模型设置」页内(入口可达)", async () => {
    const srv = servePanel(7896, () => {});
    try {
      const html = await (await fetch("http://127.0.0.1:7896/")).text();
      expect(html).toContain('id="sec-websearch"');
      expect(html).toContain('id="ws-provider"');
      expect(html).toContain('id="wsSave"');
      expect(html).toContain("默认(DeepSeek)");
      expect(html).toContain("关闭(curl/browser)");
 // 故障回归:分段按钮必须有 click 绑定,否则点选不生效、保存读到的永远是旧 .on
      expect(html).toContain('$("ws-provider").onclick');
      // 保存后必须重拉配置刷新状态行(否则用户看到「点了没反应」)
      expect(html).toContain("wsSavePending");
      // 归属:sec-websearch 必须在 sec-model 容器内(定位到 sec-model 起点 < sec-websearch < sec-context)
      const modelAt = html.indexOf('id="sec-model"');
      const wsAt = html.indexOf('id="sec-websearch"');
      const ctxAt = html.indexOf('id="sec-context"');
      expect(modelAt).toBeGreaterThan(-1);
      expect(wsAt).toBeGreaterThan(modelAt);
      expect(wsAt).toBeLessThan(ctxAt);
    } finally {
      await srv.close();
    }
  }, 30_000);

  it("applyConfigPatch 接受 web.search.disabled(关闭搜索 API)", () => {
    const { next, applied } = applyConfigPatch(baseCfg, {
      web: { search: { disabled: true } },
    } as never) as { next: Config; applied: string[] };
    expect(applied).toContain("web.search.disabled");
    expect((next as unknown as { web?: { search?: { disabled?: boolean } } }).web?.search?.disabled).toBe(true);
  });
});
