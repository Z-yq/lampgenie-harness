import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";
import { PROVIDER_PRESETS, type PresetModel } from "../src/provider-presets.js";

const nameOf = (m: PresetModel) => (typeof m === "string" ? m : m.name);

/** 服务商预设目录 + 一键接入 + 隐私清理的结构回归。 */
describe(" 服务商预设目录", () => {
  it("覆盖要求的服务商,每种模式有真实 URL/Key 引用/模型(本地与自定义例外)", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    for (const id of [
      "dashscope", "dashscope-intl", "deepseek", "moonshot", "zai", "bigmodel", "openrouter",
      "openai", "anthropic", "xai", "minimax", "siliconflow", "ollama", "lmstudio", "vllm", "custom",
    ]) {
      expect(ids, "缺少预设:" + id).toContain(id);
    }
    expect(PROVIDER_PRESETS.length).toBe(16);
    for (const p of PROVIDER_PRESETS) {
      expect(Object.keys(p.modes).length, p.id + " 至少一种接入方式").toBeGreaterThan(0);
      for (const [modeKey, mode] of Object.entries(p.modes)) {
        if (!mode) continue;
        if (!p.local && !p.custom) {
          expect(mode.baseUrl, p.id + "/" + modeKey + " baseUrl").toMatch(/^https?:\/\//);
          expect(mode.apiKeyEnv, p.id + "/" + modeKey + " apiKeyEnv").toMatch(/^[A-Z][A-Z0-9_]+$/);
          expect(mode.models.length, p.id + "/" + modeKey + " 模型").toBeGreaterThan(0);
        }
      }
    }
  });

  it("双模式:智谱系 API 与 Token 套餐端点/凭证/模型可不同;无套餐有说明", () => {
    for (const id of ["zai", "bigmodel"]) {
      const p = PROVIDER_PRESETS.find((x) => x.id === id)!;
      expect(p.modes.api).toBeTruthy();
      expect(p.modes["token-plan"]).toBeTruthy();
      expect(p.modes.api!.baseUrl).not.toBe(p.modes["token-plan"]!.baseUrl);
      expect(p.modes.api!.apiKeyEnv).not.toBe(p.modes["token-plan"]!.apiKeyEnv);
      expect(p.modes["token-plan"]!.apiType).toBe("anthropic");
      expect(p.modes["token-plan"]!.models.map(nameOf).sort()).toEqual(["GLM-5.3", "GLM-5.3-Flash"]);
    }
    const dashscope = PROVIDER_PRESETS.find((x) => x.id === "dashscope")!;
    expect(dashscope.modes["token-plan"]).toBeUndefined();
    expect(dashscope.planNote).toContain("无");
  });

  it("本地服务 http 且无 Key;自定义渠道保留;预设模型元数据真实携带", () => {
    for (const id of ["ollama", "lmstudio", "vllm"]) {
      const p = PROVIDER_PRESETS.find((x) => x.id === id)!;
      expect(p.local).toBe(true);
      expect(p.modes.api!.baseUrl).toMatch(/^http:\/\/localhost:/);
      expect(p.modes.api!.apiKeyEnv).toBe("");
    }
    expect(PROVIDER_PRESETS.find((x) => x.id === "custom")!.custom).toBe(true);
    const qwen = PROVIDER_PRESETS.find((x) => x.id === "dashscope")!.modes.api!.models.find((m) => nameOf(m) === "qwen3.7-flash");
    expect(qwen).toMatchObject({ contextWindow: 1_000_000, maxTokens: 131_072 });
    const glmPlan = PROVIDER_PRESETS.find((x) => x.id === "zai")!.modes["token-plan"]!.models[0];
    expect(glmPlan).toMatchObject({ name: "GLM-5.3", contextWindow: 1_000_000 });
  });
});

describe(" 设置页面板结构", () => {
  it("预设对话框/双模式/密钥状态/隐私脱敏标记在;绝对路径与内部 .genie 文案不在设置页", async () => {
    const panel = servePanel(7896, () => {});
    try {
      await new Promise((r) => setTimeout(r, 100));
      const res = await fetch("http://127.0.0.1:7896/");
      expect(res.status).toBe(200);
      const html = await res.text();
      for (const marker of [
        "preset-card", "pc-models", "pp-modes", "pp-mode", "Token 套餐", "无 Token 套餐",
        "cfg.secret.status", "cfg.secret.set", "redactPaths", "pathBasename",
        "覆盖并添加", 'class="prov-auth', "高级:自定义 baseUrl / 模型 / 协议",
      ]) {
        expect(html, "缺少标记:" + marker).toContain(marker);
      }
      // 隐私红线:配置路径不再输出 projectPath;设置区内部 .genie 文件名已清。
      expect(html).not.toContain('"文件:" + cfgView.projectPath');
      expect(html).not.toContain(".genie/agents");
      expect(html).not.toContain(".genie/commands");
      expect(html).not.toContain(".genie/hooks.json");
      expect(html).not.toContain(".genie/experiences");
    } finally {
      await panel.close();
    }
  });
});
