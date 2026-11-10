/**
 * 配置加载(四参考仓共性模式的落地):
 * 优先级(低→高): 代码默认 < 用户级 ~/.lampgenie-harness/config.json < 项目级 <repo>/genie.config.json < env(GENIE_*)
 *   — ZCode CLI(System<User<Project<Env<Cli)/qwen(config.env<.env<.env.local<process.env)同构
 * 坏文件容错: JSON 解析失败 → 隔离为 *.corrupt-<ts> 并回退上一层(ZCode setting.json.corrupt 模式),不拖垮启动
 * 凭证解析: env[apiKeyEnv] > <repo>/.genie/secrets.json(0600,dsh .credentials.yaml 模式);返回 apiKeyRef 描述而非明文进配置
 * env 数值带钳位(schema min/max 兜底,qwen numberSetting 模式)
 */
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ConfigSchema, HOT_CONFIG_PATHS, migrateLegacyConfig, type Config } from "./schema.js";

export interface LoadedConfig {
  config: Config;
  /** 每个最终键的来源层(default|user|project|env),供设置页呈现。 */
  sources: Record<string, string>;
  /** 实际读取的项目级配置文件路径。 */
  projectPath: string;
  /** 坏文件隔离记录(如有)。 */
  quarantined: string[];
}

function readJsonSafe(p: string): { ok: true; value: unknown } | { ok: false } {
  if (!existsSync(p)) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(readFileSync(p, "utf-8")) };
  } catch {
    return { ok: false };
  }
}

/** 深合并(plain object 递归,数组/标量整体覆盖)——ZCode mergeConfigs/dsh patch 同语义。 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return base;
  if (typeof base !== "object" || base === null || Array.isArray(base) || typeof patch !== "object" || Array.isArray(patch)) {
    return patch as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

function flattenSources(obj: unknown, prefix: string, out: Record<string, string>, layer: string): void {
  if (typeof obj !== "object" || obj === null) return;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? prefix + "." + k : k;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) flattenSources(v, key, out, layer);
    else out[key] = layer;
  }
}

/** env 覆盖层(GENIE_*);数值/布尔解析失败保持沉默由 schema 默认兜底。 */
function envOverrides(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  const num = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));
  if (env.GENIE_GATEWAY_PORT !== undefined) o.gateway = { ...(o.gateway ?? {}), port: num(env.GENIE_GATEWAY_PORT) };
  if (env.GENIE_PANEL !== undefined) o.gateway = { ...(o.gateway ?? {}), panel: env.GENIE_PANEL !== "0" };
  if (env.GENIE_PANEL_READONLY !== undefined) o.gateway = { ...(o.gateway ?? {}), panelReadOnly: env.GENIE_PANEL_READONLY === "1" || env.GENIE_PANEL_READONLY === "true" };
  if (env.GENIE_EXECUTOR !== undefined) o.executor = { kind: env.GENIE_EXECUTOR };
  // coding 轨(GENIE_LLM_* 兼容旧名)
  const llm: Record<string, unknown> = {};
  if (env.GENIE_LLM_BASE_URL) llm.baseUrl = env.GENIE_LLM_BASE_URL;
  if (env.GENIE_LLM_MODEL) llm.model = env.GENIE_LLM_MODEL;
  if (env.GENIE_LLM_TIMEOUT_MS !== undefined) llm.timeoutMs = num(env.GENIE_LLM_TIMEOUT_MS);
  if (env.GENIE_LLM_MAX_TOKENS !== undefined) llm.maxTokens = num(env.GENIE_LLM_MAX_TOKENS);
  if (Object.keys(llm).length) o.coding = { ...(o.coding ?? {}), llm };
  // audio 轨(主 agent:chat 大脑/ASR/TTS)
  const oAudio = (o.audio ?? {}) as Record<string, Record<string, unknown>>;
  const achat: Record<string, unknown> = {};
  if (env.GENIE_AUDIO_CHAT_BASE_URL) achat.baseUrl = env.GENIE_AUDIO_CHAT_BASE_URL;
  if (env.GENIE_AUDIO_CHAT_MODEL) achat.model = env.GENIE_AUDIO_CHAT_MODEL;
  if (env.GENIE_AUDIO_CHAT_TIMEOUT_MS !== undefined) achat.timeoutMs = num(env.GENIE_AUDIO_CHAT_TIMEOUT_MS);
  if (Object.keys(achat).length) oAudio.chat = achat;
  if (env.GENIE_AUDIO_ASR_MODEL) oAudio.asr = { ...(oAudio.asr ?? {}), model: env.GENIE_AUDIO_ASR_MODEL };
  if (env.GENIE_AUDIO_TTS_MODEL) oAudio.tts = { ...(oAudio.tts ?? {}), model: env.GENIE_AUDIO_TTS_MODEL, ...(env.GENIE_AUDIO_TTS_VOICE ? { voice: env.GENIE_AUDIO_TTS_VOICE } : {}) };
  if (oAudio.asr || oAudio.tts || achat) o.audio = oAudio;
  if (env.GENIE_JOURNAL_DIR !== undefined) o.journal = { dir: env.GENIE_JOURNAL_DIR === "" ? null : env.GENIE_JOURNAL_DIR };
  if (env.GENIE_COMPACT_THRESHOLD_TOKENS !== undefined) o.agent = { ...(o.agent ?? {}), compactThresholdTokens: num(env.GENIE_COMPACT_THRESHOLD_TOKENS) };
  const cc: Record<string, unknown> = {};
  if (env.GENIE_TASK_MAX_CONCURRENT !== undefined) cc.maxConcurrent = num(env.GENIE_TASK_MAX_CONCURRENT);
  if (env.GENIE_TASK_MAX_CONCURRENT_PER_OWNER !== undefined) cc.maxConcurrentPerOwner = num(env.GENIE_TASK_MAX_CONCURRENT_PER_OWNER);
  if (env.GENIE_TASK_MAX_CONCURRENT_SYSTEM !== undefined) cc.maxConcurrentSystem = num(env.GENIE_TASK_MAX_CONCURRENT_SYSTEM);
  if (Object.keys(cc).length) o.concurrency = cc;
  return o;
}

export interface LoadOptions {
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  /** 覆盖用户级目录(测试)。 */
  userConfigDir?: string;
}

export function loadConfig(opts: LoadOptions): LoadedConfig {
  const env = opts.env ?? process.env;
  const userPath = join(opts.userConfigDir ?? join(homedir(), ".lampgenie-harness"), "config.json");
  const projectPath = join(opts.repoRoot, "genie.config.json");
  const quarantined: string[] = [];

  let merged: Record<string, unknown> = {};
  const sources: Record<string, string> = {};
  for (const [layer, path] of [["user", userPath], ["project", projectPath]] as const) {
    const r = readJsonSafe(path);
    if (!r.ok) {
      // 存在但解析失败 → 隔离 + 回退(ZCode corrupt 模式)
      if (existsSync(path)) {
        const iso = new Date().toISOString().replace(/[:.]/g, "-");
        const qp = path + ".corrupt-" + iso;
        try { renameSync(path, qp); quarantined.push(qp); } catch { /* 只读环境跳过隔离 */ }
      }
      continue;
    }
    // v0 顶层 llm/models → coding 轨迁移(schema.migrateLegacyConfig)
    const migrated = migrateLegacyConfig(r.value);
    merged = deepMerge(merged, migrated) as Record<string, unknown>;
    flattenSources(migrated, "", sources, layer);
  }

  const envO = envOverrides(env);
  merged = deepMerge(merged, envO) as Record<string, unknown>;
  flattenSources(envO, "", sources, "env");

  const config = ConfigSchema.parse(merged);
  // env 直传 key 不属于 schema——从 merged 剥离(parse 会 strip 未知键)
  // 默认层来源补标:文件/env 都没出现的键 = default(只填缺失,不覆盖已归属层)
  const defaults = ConfigSchema.parse({});
  const defaultSources: Record<string, string> = {};
  flattenSources(defaults, "", defaultSources, "default");
  for (const k of Object.keys(defaultSources)) if (!(k in sources)) sources[k] = "default";
  return { config, sources, projectPath, quarantined };
}

/** 轨内端点解析(providerId 继承,ZCode defaultModelSelection 语义):
 * endpoint.baseUrl/apiKeyEnv 未显式给出时从 providers[id] 继承;apiKeyEnv 兜底名按轨区分
 * (coding=GENIE_LLM_API_KEY,audio.chat=GENIE_AUDIO_API_KEY)——双轨凭证命名空间不串。
 * apiType(运行时适配):同样从 providers[id] 继承(端点协议随端点走,
 * 与 baseUrl/apiKeyEnv 同语义);无 providerId/条目未声明=undefined=chat。 */
export type TrackName = "coding" | "audio.chat" | "audio.asr" | "audio.tts";
const TRACK_DEFAULT_KEY: Record<TrackName, string> = {
  coding: "GENIE_LLM_API_KEY",
  "audio.chat": "GENIE_AUDIO_API_KEY",
  "audio.asr": "GENIE_AUDIO_API_KEY",
  "audio.tts": "GENIE_AUDIO_API_KEY",
};
export function resolveTrackEndpoint(config: Config, track: TrackName, ref: { baseUrl?: string; providerId?: string; apiKeyEnv?: string }): { baseUrl?: string; apiKeyEnv: string; apiType?: "chat" | "responses" | "anthropic" } {
  const p = ref.providerId ? config.providers.find((x) => x.id === ref.providerId) : undefined;
 // 协议继承门槛(生产环境 404 根治):ref.baseUrl 显式且 ≠provider.baseUrl(典型=env 层
  // GENIE_LLM_BASE_URL 换端点)时,apiType 不再从 providerId 继承——否则 anthropic 协议打到
 // OpenAI 兼容端点(经验证 MAAS /v1/messages 必 404 空体)。想继承协议请只写 providerId
  // (baseUrl 留空=完全继承)或保持 baseUrl 与 provider 一致。
  const baseDiverged = ref.baseUrl !== undefined && ref.baseUrl !== p?.baseUrl;
  return {
    baseUrl: ref.baseUrl ?? p?.baseUrl,
    apiKeyEnv: ref.apiKeyEnv ?? p?.apiKeyEnv ?? TRACK_DEFAULT_KEY[track],
    apiType: baseDiverged ? undefined : p?.apiType,
  };
}
/** 兼容入口:coding 轨。 */
export function resolveLlmEndpoint(config: Config): { baseUrl?: string; apiKeyEnv: string } {
  return resolveTrackEndpoint(config, "coding", config.coding.llm);
}

export type ApiKeySource = "env" | "secrets" | "legacy-env" | "legacy-secrets" | "none";

export interface ResolvedApiKey {
  key?: string;
  /** 值来源(排查用;值本身永不落日志)。legacy-*=旧 GENIE_LLM_API_KEY 兜底。 */
  source: ApiKeySource;
}

function readSecrets(repoRoot: string): Record<string, unknown> {
  const secretsPath = join(repoRoot, ".genie", "secrets.json");
  if (!existsSync(secretsPath)) return {};
  try {
    const j = JSON.parse(readFileSync(secretsPath, "utf-8")) as Record<string, unknown>;
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {}; // 坏密钥文件=无凭证
  }
}

const legacyFallbackWarned = new Set<string>();

/**
 * 凭证解析(按轨),返回来源。优先级(修正):
 *   ① env[envName]     —— 该 Provider 的专属环境变量
 *   ② secrets[envName] —— 本机密钥文件里的专属密钥
 *   ③ coding 旧直传兜底 GENIE_LLM_API_KEY(env → secrets),**仅当前两者都没有时**
 * 旧实现先看 env.GENIE_LLM_API_KEY 再看 secrets,导致「Switch 到智谱端点时拿到的仍是阿里云
 * 的 GENIE_LLM_API_KEY」→ 401「令牌已过期或验证不正确」(用户用户反馈的最新 session 失败)。
 * Provider 专属密钥一旦存在就必须优先,env 的通用旧键只能做最后的兼容兜底。
 * 双轨红线:audio 轨不回落 coding 旧直传——命名空间不串。
 */
export function resolveTrackApiKeySource(track: TrackName, envName: string, opts: { repoRoot: string; env?: NodeJS.ProcessEnv }): ResolvedApiKey {
  const env = opts.env ?? process.env;
  if (env[envName]) return { key: env[envName], source: "env" };
  const secrets = readSecrets(opts.repoRoot);
  const stored = secrets[envName];
  if (typeof stored === "string" && stored) return { key: stored, source: "secrets" };
  if (track !== "coding" || envName === "GENIE_LLM_API_KEY") return { source: "none" };
  // 旧直传兜底:只在专属键缺失时启用;点名警告一次,避免「静默拿错钥匙」再次发生。
  if (env.GENIE_LLM_API_KEY) {
    if (!legacyFallbackWarned.has(envName)) {
      legacyFallbackWarned.add(envName);
      console.warn(`[config] 凭证回退:${envName} 未在 env/secrets.json 配置,改用 GENIE_LLM_API_KEY(兼容旧配置;请补专属密钥)`);
    }
    return { key: env.GENIE_LLM_API_KEY, source: "legacy-env" };
  }
  const legacyStored = secrets.GENIE_LLM_API_KEY;
  if (typeof legacyStored === "string" && legacyStored) {
    if (!legacyFallbackWarned.has(envName)) {
      legacyFallbackWarned.add(envName);
      console.warn(`[config] 凭证回退:${envName} 未配置,改用 secrets.json 的 GENIE_LLM_API_KEY(兼容旧配置;请补专属密钥)`);
    }
    return { key: legacyStored, source: "legacy-secrets" };
  }
  return { source: "none" };
}

/** 凭证解析(按轨):返回明文(仅装配用,不落日志)。 */
export function resolveTrackApiKey(track: TrackName, envName: string, opts: { repoRoot: string; env?: NodeJS.ProcessEnv }): string | undefined {
  return resolveTrackApiKeySource(track, envName, opts).key;
}
/** 兼容入口:coding 轨凭证。 */
export function resolveLlmApiKey(config: Config, opts: { repoRoot: string; env?: NodeJS.ProcessEnv }): string | undefined {
  return resolveTrackApiKey("coding", resolveLlmEndpoint(config).apiKeyEnv, opts);
}

/** 原子写项目级配置(tmp+rename;hermes atomic_config_write 模式)。 */
export function writeProjectConfig(projectPath: string, config: Config): void {
  const tmp = projectPath + ".tmp-" + Date.now();
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf-8");
  renameSync(tmp, projectPath);
}

/** cfg.set 补丁应用:返回热应用键与需重启键(平坦点路径:llm.model)。 */
export function applyConfigPatch(config: Config, patch: Record<string, unknown>): { next: Config; applied: string[]; needsRestart: string[] } {
  const merged = deepMerge(config, patch);
  const next = ConfigSchema.parse(merged);
  const touched: string[] = [];
  const walk = (obj: unknown, prefix: string) => {
    if (typeof obj !== "object" || obj === null) return;
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? prefix + "." + k : k;
      if (typeof v === "object" && v !== null && !Array.isArray(v)) walk(v, p);
      else touched.push(p);
    }
  };
  walk(patch, "");
  // 被 schema 剥离的未知键(如 llm.bogus)不进热/冷清单——按 next 实际存在性过滤
  const existsIn = (obj: unknown, path: string): boolean => {
    let cur: unknown = obj;
    for (const seg of path.split(".")) {
      if (typeof cur !== "object" || cur === null || !(seg in (cur as Record<string, unknown>))) return false;
      cur = (cur as Record<string, unknown>)[seg];
    }
    return true;
  };
  const real = touched.filter((p) => existsIn(next, p));
  const applied = real.filter((p) => HOT_CONFIG_PATHS.has(p));
  const needsRestart = real.filter((p) => !HOT_CONFIG_PATHS.has(p));
  return { next, applied, needsRestart };
}

/** secrets.json 初始化(0600)。 */
export function ensureSecretsFile(repoRoot: string): string {
  const dir = join(repoRoot, ".genie");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const p = join(dir, "secrets.json");
  if (!existsSync(p)) {
    writeFileSync(p, "{}\n", "utf-8");
    chmodSync(p, 0o600);
  }
  return p;
}

/** 读取 secrets.json 的键名(只返回名字,绝不返回值;设置页「是否已存在」用)。 */
export function listSecretKeys(repoRoot: string): string[] {
  const p = join(repoRoot, ".genie", "secrets.json");
  if (!existsSync(p)) return [];
  try {
    const j = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
    if (!j || typeof j !== "object" || Array.isArray(j)) return [];
    return Object.keys(j).filter((k) => typeof j[k] === "string").sort();
  } catch {
    return [];
  }
}

/** 写入一个密钥到 .genie/secrets.json(0600,原子 tmp+rename; 预设一键接入)。
 * 只更新目标键,保留其它键;坏文件按空对象重建。返回值只含「是否覆盖了已有值」。
 * 红线:值不落配置、不入日志、不回包回显。 */
export function setSecretValue(repoRoot: string, name: string, value: string): { existed: boolean } {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw new Error("密钥名非法(字母/数字/下划线,且不以数字开头)");
  if (typeof value !== "string" || !value.trim() || value.length > 4096) throw new Error("密钥为空或过长");
  const dir = join(repoRoot, ".genie");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const p = join(dir, "secrets.json");
  let obj: Record<string, unknown> = {};
  if (existsSync(p)) {
    try {
      const j = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
      if (j && typeof j === "object" && !Array.isArray(j)) obj = j;
    } catch { /* 坏密钥文件=重建(与读取侧「坏文件=无凭证」同语义) */ }
  }
  const existed = typeof obj[name] === "string" && obj[name] !== "";
  obj[name] = value;
  const tmp = p + ".tmp-" + Date.now();
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, p);
  try { chmodSync(p, 0o600); } catch { /* 非 POSIX 环境降级 */ }
  return { existed };
}

/** 模型元数据查找(ZCode 模型管理语义:按模型名在 providers[].models 里查
 * contextWindow/maxTokens;条目兼容旧字符串形态。找不到=null(调用方走轨级回退)。 */
export function modelMetaOf(
  config: Config,
  model: string | undefined): { contextWindow?: number; maxTokens?: number } | null {
  if (!model) return null;
  for (const p of config.providers ?? []) {
    for (const m of p.models ?? []) {
      const name = typeof m === "string" ? m : m.name;
      if (name !== model) continue;
      if (typeof m === "string") return null;
      return { contextWindow: m.contextWindow, maxTokens: m.maxTokens };
    }
  }
  return null;
}

/** 读取一个密钥值( web.search 配置层用;env 优先,secrets 回退)。
 * 只在本机进程内消费,值不落日志/回包——与 resolveTrackApiKey 同红线。 */
export function readSecretValue(repoRoot: string, name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env[name];
  if (typeof fromEnv === "string" && fromEnv) return fromEnv;
  const v = readSecrets(repoRoot)[name];
  return typeof v === "string" && v ? v : undefined;
}
