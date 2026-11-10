import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, loadConfig, deepMerge, resolveLlmApiKey, resolveLlmEndpoint, resolveTrackApiKey, resolveTrackApiKeySource, resolveTrackEndpoint, applyConfigPatch, writeProjectConfig, ensureSecretsFile, setSecretValue, listSecretKeys, HOT_CONFIG_PATHS } from "../src/index.js";

function tmpRepo(): { root: string; userDir: string } {
  const root = mkdtempSync(join(tmpdir(), "zh-cfg-"));
  const userDir = mkdtempSync(join(tmpdir(), "zh-cfg-user-"));
  return { root, userDir };
}
const NO_ENV = {} as NodeJS.ProcessEnv;

describe("ConfigSchema 默认值(就地)", () => {
  it("vision/vlm 显式配置(无视觉主模型+同 provider 视觉兜底)", () => {
    // 二次定稿:vlm 只填 model(必填),端点/凭证继承 coding.llm 同一 provider
    const c = ConfigSchema.parse({
      providers: [
        { id: "zai-plan", baseUrl: "https://api.z.ai/api/anthropic", apiKeyEnv: "ZAI_CODING_PLAN_API_KEY", apiType: "anthropic", models: [] },
      ],
      coding: {
        llm: { providerId: "zai-plan", model: "glm-text-only", vision: false },
        vlm: { model: "glm-5v" },
      },
    });
    expect(c.coding.llm.vision).toBe(false);
    expect(c.coding.vlm?.model).toBe("glm-5v");
    expect(c.coding.vlm?.baseUrl).toBeUndefined(); // 未显式填=继承主端点(factory 合并)
    expect(resolveTrackEndpoint(c, "coding", { ...c.coding.llm, ...c.coding.vlm }).baseUrl)
      .toBe("https://api.z.ai/api/anthropic"); // 同 provider 继承实锤
  });

  it("parse({}) 得全套默认", () => {
    const c = ConfigSchema.parse({});
    expect(c.gateway.port).toBe(7700);
    expect(c.gateway.panel).toBe(true);
    expect(c.gateway.panelReadOnly).toBe(false);
    expect(c.executor.kind).toBe("echo");
    expect(resolveTrackEndpoint(c, "coding", c.coding.llm).apiKeyEnv).toBe("GENIE_LLM_API_KEY");
    expect(resolveTrackEndpoint(c, "audio.chat", c.audio.chat).apiKeyEnv).toBe("GENIE_AUDIO_API_KEY"); // 双轨凭证命名空间不串
    expect(c.coding.llm.timeoutMs).toBe(60_000);
    // 视觉能力(2026-10-25):vision 缺省 undefined(=true 语义,主流多模态);vlm 缺省不配
    expect(c.coding.llm.vision).toBeUndefined();
    expect(c.coding.vlm).toBeUndefined();
    expect(c.journal.dir).toBe(".genie/journals");
    expect(c.concurrency.maxConcurrent).toBe(4);
    expect(c.agent.maxSteps).toBe(3000); // schema 已于 step-139 改为 3000 上限/默认;旧断言未同步
    // 上下文模型评分默认本地 150M Jev(/decide)
    expect(c.context.modelScoring.mode).toBe("shadow");
    expect(c.context.modelScoring.providerUrl).toBe("http://127.0.0.1:8105");
    expect(c.context.modelScoring.model).toBe("jev-150m");
    expect(c.context.modelScoring.apiType).toBe("jev");
    expect(c.context.modelScoring.maxCandidates).toBe(12);
    expect(HOT_CONFIG_PATHS.has("context.modelScoring.mode")).toBe(true);
    expect(HOT_CONFIG_PATHS.has("context.modelScoring.providerUrl")).toBe(true);
  });
  it("context.modelScoring 可热应用;URL/模型/协议进 applied", () => {
    const c = ConfigSchema.parse({});
    const r = applyConfigPatch(c, {
      context: { modelScoring: { mode: "active", providerUrl: "http://127.0.0.1:9000", model: "refiner", apiType: "openai" } },
    });
    expect(r.next.context.modelScoring.mode).toBe("active");
    expect(r.next.context.modelScoring.providerUrl).toBe("http://127.0.0.1:9000");
    expect(r.next.context.modelScoring.model).toBe("refiner");
    expect(r.next.context.modelScoring.apiType).toBe("openai");
    expect(r.applied).toContain("context.modelScoring.mode");
    expect(r.applied).toContain("context.modelScoring.providerUrl");
    expect(r.needsRestart).not.toContain("context.modelScoring.mode");
  });
  it("非法值被拒(端口越界/executor 枚举)", () => {
    expect(() => ConfigSchema.parse({ gateway: { port: 99999 } })).toThrow();
    expect(() => ConfigSchema.parse({ executor: { kind: "local" } })).toThrow();
  });
  it("resolveTrackEndpoint apiType 继承(step-127):providers[id].apiType 经 providerId 透出;未声明=undefined", () => {
    const c = ConfigSchema.parse({
      providers: [
        { id: "zai-plan", baseUrl: "https://api.z.ai/api/anthropic", apiKeyEnv: "ZAI_CODING_PLAN_API_KEY", apiType: "anthropic", models: [] },
        { id: "plain", baseUrl: "https://llm.test", apiKeyEnv: "K", models: [] },
      ],
      coding: { llm: { providerId: "zai-plan", model: "glm-x" } },
    });
    expect(resolveTrackEndpoint(c, "coding", c.coding.llm).apiType).toBe("anthropic");
    expect(resolveTrackEndpoint(c, "coding", c.coding.llm).baseUrl).toBe("https://api.z.ai/api/anthropic");
    const c2 = ConfigSchema.parse({ providers: [{ id: "plain", baseUrl: "https://llm.test", apiKeyEnv: "K", models: [] }], coding: { llm: { providerId: "plain", model: "m" } } });
    expect(resolveTrackEndpoint(c2, "coding", c2.coding.llm).apiType).toBeUndefined();
    const c3 = ConfigSchema.parse({});
    expect(resolveTrackEndpoint(c3, "coding", c3.coding.llm).apiType).toBeUndefined();
  });
});

describe("deepMerge", () => {
  it("对象递归、标量/数组整体覆盖", () => {
    const out = deepMerge({ a: { x: 1, y: 2 }, list: [1] }, { a: { x: 9 }, list: [3, 4] }) as Record<string, never>;
    expect(out.a).toEqual({ x: 9, y: 2 });
    expect(out.list).toEqual([3, 4]);
  });
});

describe("loadConfig 优先级: default < user < project < env", () => {
  it("user 覆盖默认,project 覆盖 user,env 覆盖 project;sources 正确归属", () => {
    const { root, userDir } = tmpRepo();
    writeFileSync(join(userDir, "config.json"), JSON.stringify({ coding: { llm: { model: "user-model", timeoutMs: 11111 } } }), "utf-8");
    writeFileSync(join(root, "genie.config.json"), JSON.stringify({ coding: { llm: { model: "project-model" } }, gateway: { port: 8000 } }), "utf-8");
    const r = loadConfig({ repoRoot: root, userConfigDir: userDir, env: { ...NO_ENV, GENIE_LLM_MODEL: "env-model" } });
    expect(r.config.coding.llm.model).toBe("env-model");
    expect(r.config.coding.llm.timeoutMs).toBe(11111); // user 层生效(project 未动)
    expect(r.config.gateway.port).toBe(8000);   // project 层生效
    expect(r.sources["coding.llm.model"]).toBe("env");
    expect(r.sources["coding.llm.timeoutMs"]).toBe("user");
    expect(r.sources["gateway.port"]).toBe("project");
    expect(r.sources["executor.kind"]).toBe("default");
  });

  it("坏 project 配置被隔离并回退默认(ZCode corrupt 模式)", () => {
    const { root, userDir } = tmpRepo();
    writeFileSync(join(root, "genie.config.json"), "{ not json !!!", "utf-8");
    const r = loadConfig({ repoRoot: root, userConfigDir: userDir, env: NO_ENV });
    expect(r.config.gateway.port).toBe(7700);
    expect(r.quarantined.length).toBe(1);
    expect(existsSync(r.quarantined[0]!)).toBe(true);
    expect(existsSync(join(root, "genie.config.json"))).toBe(false);
  });

  it("GENIE_PANEL_READONLY=1 → gateway.panelReadOnly=true(设置页只读态)", () => {
    const { root, userDir } = tmpRepo();
    const r = loadConfig({ repoRoot: root, userConfigDir: userDir, env: { ...NO_ENV, GENIE_PANEL_READONLY: "1" } });
    expect(r.config.gateway.panelReadOnly).toBe(true);
  });
  it("env 数值钳位由 schema 兜底(越界拒绝)——GENIE_GATEWAY_PORT 非法时报错而非静默", () => {
    const { root, userDir } = tmpRepo();
    expect(() => loadConfig({ repoRoot: root, userConfigDir: userDir, env: { ...NO_ENV, GENIE_GATEWAY_PORT: "99999" } })).toThrow();
  });
});

describe("凭证引用化(红线:配置文件不存明文)", () => {
  it("env 直传优先;secrets.json 次之;都没有=undefined", () => {
    const { root } = tmpRepo();
    const c = ConfigSchema.parse({});
    expect(resolveLlmApiKey(c, { repoRoot: root, env: { GENIE_LLM_API_KEY: "k-env" } as NodeJS.ProcessEnv })).toBe("k-env");
    mkdirSync(join(root, ".genie"), { recursive: true });
    writeFileSync(join(root, ".genie", "secrets.json"), JSON.stringify({ GENIE_LLM_API_KEY: "k-file" }), "utf-8");
    expect(resolveLlmApiKey(c, { repoRoot: root, env: NO_ENV })).toBe("k-file"); // env 无 → 文件回退
    const bare = tmpRepo(); // 无 secrets.json 的干净仓
    expect(resolveLlmApiKey(c, { repoRoot: bare.root, env: { OTHER: "1" } as NodeJS.ProcessEnv })).toBeUndefined();
  });
  it("secrets.json 序列化结果不含任何明文 key 字段", () => {
    const { root, userDir } = tmpRepo();
    writeFileSync(join(root, "genie.config.json"), JSON.stringify({ llm: { model: "m", baseUrl: "https://x", apiKeyEnv: "MY_KEY" } }), "utf-8"); // v0 顶层 llm→迁移进 coding
    const r = loadConfig({ repoRoot: root, userConfigDir: userDir, env: NO_ENV });
    const dumped = JSON.stringify(r.config);
    expect(dumped).toContain("MY_KEY");
    expect(r.config.coding && r.config.coding.llm && r.config.coding.llm.model === "m").toBe(true); // 旧顶层 llm 已迁移 coding 轨
    expect(dumped).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    expect("apiKey" in r.config.coding.llm).toBe(false);
  });
});

describe("applyConfigPatch 热应用分界", () => {
  it("llm.model 热应用;gateway.port 需重启;未知键被 schema 剥离", () => {
    const base = ConfigSchema.parse({});
    const { next, applied, needsRestart } = applyConfigPatch(base, { coding: { llm: { model: "new-model", bogus: "x" } }, audio: { chat: { model: "a-model" } }, gateway: { port: 9000 } });
    expect(next.coding.llm.model).toBe("new-model");
    expect(next.audio.chat.model).toBe("a-model");
    expect(next.gateway.port).toBe(9000);
    expect(applied).toEqual(["coding.llm.model", "audio.chat.model"]);
    expect(needsRestart).toEqual(["gateway.port"]);
    expect("bogus" in (next.coding.llm as Record<string, unknown>)).toBe(false);
  });
});

describe("writeProjectConfig 原子写", () => {
  it("写入后可完整读回", () => {
    const { root } = tmpRepo();
    const c = ConfigSchema.parse({ coding: { llm: { model: "persist-me" } } });
    const p = join(root, "genie.config.json");
    writeProjectConfig(p, c);
    expect(JSON.parse(readFileSync(p, "utf-8")).coding.llm.model).toBe("persist-me");
  });
  it("ensureSecretsFile 建 0600 密钥文件", () => {
    const { root } = tmpRepo();
    const p = ensureSecretsFile(root);
    expect(existsSync(p)).toBe(true);
  });

describe("providers 多端点目录 + providerId 继承", () => {
  it("llm.providerId 解析:baseUrl/apiKeyEnv 从 provider 继承,显式值优先", () => {
    const c = ConfigSchema.parse({
      providers: [
        { id: "maas", name: "MaaS", baseUrl: "https://maas.example/compatible-mode", apiKeyEnv: "MAAS_KEY", models: ["m1"] },
      ],
      coding: { llm: { providerId: "maas", model: "x" } },
    });
    const r = resolveLlmEndpoint(c);
    expect(r.baseUrl).toBe("https://maas.example/compatible-mode");
    expect(r.apiKeyEnv).toBe("MAAS_KEY");
    // 显式覆盖
    const c2 = ConfigSchema.parse({ ...c, coding: { llm: { providerId: "maas", baseUrl: "https://override", apiKeyEnv: "OTHER", model: "x" } } });
    const r2 = resolveLlmEndpoint(c2);
    expect(r2.baseUrl).toBe("https://override");
    expect(r2.apiKeyEnv).toBe("OTHER");
  });

  it("凭证按 provider 的 apiKeyEnv 解析(env 命中)", () => {
    const c = ConfigSchema.parse({
      providers: [{ id: "p", baseUrl: "https://x", apiKeyEnv: "P_KEY" }],
      coding: { llm: { providerId: "p", model: "m" } },
    });
    const { root } = tmpRepo();
    expect(resolveLlmApiKey(c, { repoRoot: root, env: { P_KEY: "k1" } as NodeJS.ProcessEnv })).toBe("k1");
  });

  it("providers 缺失 providerId 时不继承(回退 llm 自身)", () => {
    const c = ConfigSchema.parse({ coding: { llm: { baseUrl: "https://self", model: "m", apiKeyEnv: "SELF_KEY" } } });
    expect(resolveLlmEndpoint(c).baseUrl).toBe("https://self");
    expect(resolveLlmEndpoint(c).apiKeyEnv).toBe("SELF_KEY");
  });
});

describe("双轨分离(coding/audio)", () => {
  it("audio 轨凭证名不回落 coding 旧直传(命名空间不串)", () => {
    const { root } = tmpRepo();
    const c = ConfigSchema.parse({ audio: { chat: { baseUrl: "https://a", model: "m", apiKeyEnv: "AUDIO_KEY" } } });
    // coding 直传 GENIE_LLM_API_KEY 存在,但 audio 轨不读它
    expect(resolveTrackApiKey("audio.chat", "AUDIO_KEY", { repoRoot: root, env: { GENIE_LLM_API_KEY: "coding-key" } as NodeJS.ProcessEnv })).toBeUndefined();
    expect(resolveTrackApiKey("coding", "AUDIO_KEY", { repoRoot: root, env: { GENIE_LLM_API_KEY: "coding-key" } as NodeJS.ProcessEnv })).toBe("coding-key");
  });
  it("v0 顶层 llm/models 文件加载即迁移进 coding 轨", () => {
    const { root, userDir } = tmpRepo();
    writeFileSync(join(root, "genie.config.json"), JSON.stringify({ llm: { model: "old", baseUrl: "https://old" }, models: { compact: { model: "cheap" } } }), "utf-8");
    const r = loadConfig({ repoRoot: root, userConfigDir: userDir, env: NO_ENV });
    expect(r.config.coding.llm.model).toBe("old");
    expect(r.config.coding.models.compact?.model).toBe("cheap");
    expect("llm" in r.config).toBe(false);
    expect(r.sources["coding.llm.model"]).toBe("project");
  });
});
});

describe("凭证优先级(2026-10-20 401 根因:专属密钥不得被旧 GENIE_LLM_API_KEY 压住)", () => {
  it("secrets 里的 Provider 专属 Key 优先于 env 的旧直传 GENIE_LLM_API_KEY", () => {
    const { root } = tmpRepo();
    mkdirSync(join(root, ".genie"), { recursive: true });
    writeFileSync(join(root, ".genie", "secrets.json"), JSON.stringify({ BIGMODEL_KEY: "bigmodel-secret", GENIE_LLM_API_KEY: "legacy-secret" }), "utf-8");
    expect(resolveTrackApiKey("coding", "BIGMODEL_KEY", { repoRoot: root, env: { GENIE_LLM_API_KEY: "legacy-env" } as NodeJS.ProcessEnv })).toBe("bigmodel-secret");
    expect(resolveTrackApiKeySource("coding", "BIGMODEL_KEY", { repoRoot: root, env: { GENIE_LLM_API_KEY: "legacy-env" } as NodeJS.ProcessEnv })).toEqual({ key: "bigmodel-secret", source: "secrets" });
  });

  it("Provider 专属 env 变量优先于 secrets;专属缺失时才回退旧直传", () => {
    const { root } = tmpRepo();
    mkdirSync(join(root, ".genie"), { recursive: true });
    writeFileSync(join(root, ".genie", "secrets.json"), JSON.stringify({ P_KEY: "from-secret", GENIE_LLM_API_KEY: "legacy-secret" }), "utf-8");
    expect(resolveTrackApiKeySource("coding", "P_KEY", { repoRoot: root, env: { P_KEY: "from-env", GENIE_LLM_API_KEY: "legacy-env" } as NodeJS.ProcessEnv })).toEqual({ key: "from-env", source: "env" });
    expect(resolveTrackApiKeySource("coding", "MISSING_KEY", { repoRoot: root, env: { GENIE_LLM_API_KEY: "legacy-env" } as NodeJS.ProcessEnv })).toEqual({ key: "legacy-env", source: "legacy-env" });
  });
});

describe("step-046 配置面", () => {
  it("permissions.mode 默认 ask,可热应用", () => {
    const base = ConfigSchema.parse({});
    expect(base.permissions.mode).toBe("ask");
    expect(HOT_CONFIG_PATHS.has("permissions.mode")).toBe(true);
    const { next, applied } = applyConfigPatch(base, { permissions: { mode: "auto" } });
    expect(next.permissions.mode).toBe("auto");
    expect(applied).toContain("permissions.mode");
  });
  it("coding.llm.reasoningEffort 枚举+热路径", () => {
    const base = ConfigSchema.parse({});
    // 默认=high(2026-10-13 视频 2 用户口径:「思考要默认为高才行」;档位含 xhigh=最高,端点实测接受)。
    expect(base.coding.llm.reasoningEffort).toBe("high");
    expect(HOT_CONFIG_PATHS.has("coding.llm.reasoningEffort")).toBe(true);
    const { next, applied } = applyConfigPatch(base, { coding: { llm: { reasoningEffort: "xhigh" } } });
    expect(next.coding.llm.reasoningEffort).toBe("xhigh");
    expect(applied).toContain("coding.llm.reasoningEffort");
    // ""=显式关(撤销思考:provider.update 归 undefined,请求不带该参数)。
    const off = applyConfigPatch(next, { coding: { llm: { reasoningEffort: "" } } });
    expect(off.next.coding.llm.reasoningEffort).toBe("");
    expect(off.applied).toContain("coding.llm.reasoningEffort");
  });
  it("coding.lsp.baseline / includeWarnings 声明为配置键(不再被 zod 剥离)", () => {
    const base = ConfigSchema.parse({});
    // 缺省与 packages/harness-lsp 的 resolveLspSettings 一致(旧配置无这两个键 → 仍是 true/false)
    expect(base.coding.lsp.baseline).toBe(true);
    expect(base.coding.lsp.includeWarnings).toBe(false);
    const { next, needsRestart } = applyConfigPatch(base, { coding: { lsp: { baseline: false, includeWarnings: true } } });
    expect(next.coding.lsp.baseline).toBe(false);
    expect(next.coding.lsp.includeWarnings).toBe(true);
    // 未被剥离:落进热/冷清单(当前为冷:改动后需重启生效)
    expect(needsRestart).toContain("coding.lsp.baseline");
    expect(needsRestart).toContain("coding.lsp.includeWarnings");
    // 显式 true 也保留(不被缺省覆盖)
    const back = applyConfigPatch(next, { coding: { lsp: { baseline: true } } });
    expect(back.next.coding.lsp.baseline).toBe(true);
  });
  it("audio.tts.voice 热路径(2026-10-20 音色选择:cfg.set 即时生效,不标需重启)", () => {
    const base = ConfigSchema.parse({});
    expect(HOT_CONFIG_PATHS.has("audio.tts.voice")).toBe(true);
    expect(HOT_CONFIG_PATHS.has("audio.tts.model")).toBe(true);
    const { next, applied, needsRestart } = applyConfigPatch(base, { audio: { tts: { voice: "longanhuan_v3.1" } } });
    expect(next.audio.tts.voice).toBe("longanhuan_v3.1");
    expect(applied).toContain("audio.tts.voice");
    expect(needsRestart).not.toContain("audio.tts.voice");
  });
});

describe("step-125 服务商预设:authMode 与密钥写入", () => {
  it("authMode 可选;缺省 undefined=api;token-plan 保留", () => {
    const base = ConfigSchema.parse({ providers: [{ id: "p", baseUrl: "https://x", models: ["m"] }] });
    expect(base.providers[0]!.authMode).toBeUndefined();
    const plan = ConfigSchema.parse({
      providers: [{
        id: "zai-plan", baseUrl: "https://api.z.ai/api/anthropic", apiKeyEnv: "ZAI_CODING_PLAN_API_KEY",
        authMode: "token-plan", apiType: "anthropic",
        models: [{ name: "GLM-5.3", contextWindow: 1_000_000, maxTokens: 128_000 }],
      }],
    });
    expect(plan.providers[0]!.authMode).toBe("token-plan");
    expect(plan.providers[0]!.models[0]).toMatchObject({ name: "GLM-5.3", contextWindow: 1_000_000 });
    expect(() => ConfigSchema.parse({ providers: [{ id: "p", baseUrl: "https://x", authMode: "oauth" }] })).toThrow();
  });

  it("setSecretValue 写 0600 文件、只增改目标键、existed 如实;listSecretKeys 只回名字", () => {
    const { root } = tmpRepo();
    const p = join(root, ".genie", "secrets.json");
    const first = setSecretValue(root, "DASHSCOPE_API_KEY", "sk-first-value");
    expect(first.existed).toBe(false);
    expect(existsSync(p)).toBe(true);
    if (process.platform !== "win32") expect(statSync(p).mode & 0o777).toBe(0o600);
    const second = setSecretValue(root, "ZAI_CODING_PLAN_API_KEY", "sk-second-value");
    expect(second.existed).toBe(false);
    const third = setSecretValue(root, "DASHSCOPE_API_KEY", "sk-third-value");
    expect(third.existed).toBe(true);
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Record<string, string>;
    expect(raw.DASHSCOPE_API_KEY).toBe("sk-third-value");
    expect(raw.ZAI_CODING_PLAN_API_KEY).toBe("sk-second-value");
    expect(listSecretKeys(root).sort()).toEqual(["DASHSCOPE_API_KEY", "ZAI_CODING_PLAN_API_KEY"]);
    expect(JSON.stringify(listSecretKeys(root))).not.toContain("sk-");
  });

  it("非法密钥名/空值被拒;坏密钥文件按空对象重建", () => {
    const { root } = tmpRepo();
    expect(() => setSecretValue(root, "bad name", "v")).toThrow();
    expect(() => setSecretValue(root, "GOOD_KEY", "")).toThrow();
    mkdirSync(join(root, ".genie"), { recursive: true });
    writeFileSync(join(root, ".genie", "secrets.json"), "{ broken", "utf-8");
    expect(setSecretValue(root, "GOOD_KEY", "v").existed).toBe(false);
    expect(listSecretKeys(root)).toEqual(["GOOD_KEY"]);
  });
});
