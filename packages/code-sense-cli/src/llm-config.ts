/**
 * llm-config( P2 / §3):打包 CLI 的 LLM 凭证解析链。
 * 解析链(定稿):显式 flag > env 三件套(GENIE_LLM_BASE_URL/MODEL/API_KEY,与 gateway
 * factory/review-llm 同名同源)> 配置文件 ~/.codesense/config.json > 无 LLM(确定性降级)。
 * 凭证红线( §1):
 *  - 配置文件写入即 chmod 600、目录 0700;apiKey 永不出现在任何输出(maskKey=****+尾4);
 *  - env/flag 不落盘(flag 是一次性覆盖,显式传参语义);
 *  - 缺凭证的语义请求=fail-visible(LlmConfigError),不静默降级成无语义结果冒充成功。
 * ask-file 中继(宿主零配置形态):config 配 llm.askFile.dir 后,CLI 语义请求写
 * ask-<id>.json 进目录并轮询 answer-<id>.json(120s 超时),宿主 agent(codex/trae 里
 * 的编码 agent)读题作答;超时/坏答案=抛错走确定性降级,不留陈旧占位。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SenseLlm } from "@lampgenie/code-sense/sensing/index";

export interface LlmConfig {
  baseURL: string;
  model: string;
  apiKey: string;
}

/**
 * chat 端点归一(fix S137-1):baseUrl 可能自带 /v1(官方预设/面板预设都常见),
 * 无条件拼 `/v1/chat/completions` 会得到 `/v1/v1/chat/completions` → 端点 404。
 * 剥尾斜杠与尾 /v1 后再拼,三形态(带 /v1、不带、带尾斜杠)都命中。
 * 注:与 harness-runtime 的 openai-provider.chatCompletionsUrl 同规则(本包不依赖 runtime,故各自持有)。
 */
export function chatCompletionsUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1/chat/completions";
}

export type ResolvedLlm =
  | { kind: "direct"; cfg: LlmConfig; source: "flag" | "env" | "config" }
  | { kind: "ask-file"; dir: string };

/** 配置/凭证形态错误(fail-visible;CLI 捕获后 exit 2)。 */
export class LlmConfigError extends Error {}

// ---- 配置文件(~/.codesense/config.json;与 registry.json 同目录) ----

export function codesenseDir(): string {
  return join(homedir(), ".codesense");
}

export function configPath(): string {
  return join(codesenseDir(), "config.json");
}

export interface ConfigFile {
  llm?: {
    baseURL?: string;
    model?: string;
    apiKey?: string;
    askFile?: { dir?: string };
  };
  /** 其它顶层键原样保留(config 是通用用户配置面,不窄化 schema)。 */
  [key: string]: unknown;
}

/** 读配置文件:缺失=null;JSON 坏=LlmConfigError(如用户反馈,不静默吞)。 */
export function readConfigFile(path: string = configPath()): ConfigFile | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ConfigFile;
  } catch (err) {
    throw new LlmConfigError(`配置文件解析失败: ${path}(${String(err).slice(0, 120)};修复或删除该文件)`);
  }
}

/** 写配置文件:整体读-改-写,保留其它顶层键;目录 0700、文件 600。 */
export function writeConfigFile(cfg: ConfigFile, path: string = configPath()): void {
  mkdirSync(codesenseDir(), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

const LLM_KEYS = new Set(["llm.baseURL", "llm.model", "llm.apiKey"]);

export function isLlmKey(key: string): boolean {
  return LLM_KEYS.has(key) || key === "llm.askFile.dir";
}

/** set 单键(merge 写)。 */
export function setConfigKey(key: string, value: string, path: string = configPath()): void {
  if (!isLlmKey(key)) throw new LlmConfigError(`未知配置键: ${key}(支持: ${[...LLM_KEYS, "llm.askFile.dir"].join(", ")})`);
  const cfg = readConfigFile(path) ?? {};
  cfg.llm ??= {};
  if (key === "llm.baseURL") cfg.llm.baseURL = value;
  else if (key === "llm.model") cfg.llm.model = value;
  else if (key === "llm.apiKey") cfg.llm.apiKey = value;
  else {
    cfg.llm.askFile ??= {};
    cfg.llm.askFile.dir = value;
  }
  writeConfigFile(cfg, path);
}

/** unset 单键(键不存在=如实 false)。 */
export function unsetConfigKey(key: string, path: string = configPath()): boolean {
  if (!isLlmKey(key)) throw new LlmConfigError(`未知配置键: ${key}`);
  const cfg = readConfigFile(path);
  if (!cfg?.llm) return false;
  let gone = false;
  if (key === "llm.baseURL" && cfg.llm.baseURL !== undefined) { delete cfg.llm.baseURL; gone = true; }
  else if (key === "llm.model" && cfg.llm.model !== undefined) { delete cfg.llm.model; gone = true; }
  else if (key === "llm.apiKey" && cfg.llm.apiKey !== undefined) { delete cfg.llm.apiKey; gone = true; }
  else if (key === "llm.askFile.dir" && cfg.llm.askFile?.dir !== undefined) { delete cfg.llm.askFile.dir; gone = true; }
  if (gone) writeConfigFile(cfg, path);
  return gone;
}

// ---- 脱敏(凭证红线:任何输出只用 maskKey 形态) ----

export function maskKey(key: string | undefined): string {
  if (!key) return "(未设置)";
  if (key.length <= 4) return "****";
  return "****" + key.slice(-4);
}

// ---- 解析链(flag > env > config > none) ----

export interface ResolveOpts {
  flags?: Partial<LlmConfig>;
  env?: NodeJS.ProcessEnv;
  /** 注入配置文件内容(测试用;缺省读 configPath())。 */
  configFile?: ConfigFile | null;
}

/** env 三件套判定(与 reviewLlmFromEnv 同语义:全缺=null;部分缺=抛)。 */
function fromEnv(env: NodeJS.ProcessEnv): LlmConfig | null {
  const baseURL = env.GENIE_LLM_BASE_URL;
  const model = env.GENIE_LLM_MODEL;
  const apiKey = env.GENIE_LLM_API_KEY;
  if (!baseURL && !model && !apiKey) return null;
  if (!baseURL || !model) throw new LlmConfigError("GENIE_LLM_BASE_URL 与 GENIE_LLM_MODEL 必须同时设置");
  if (!apiKey) throw new LlmConfigError("GENIE_LLM_BASE_URL/MODEL 已设置但缺 GENIE_LLM_API_KEY(env 三件套补齐,或 unset 后走 codesense config)");
  return { baseURL, model, apiKey };
}

function fromConfig(cfgFile: ConfigFile | null): { cfg?: LlmConfig; askFile?: string } {
  const llm = cfgFile?.llm;
  if (!llm) return {};
  const out: { cfg?: LlmConfig; askFile?: string } = {};
  if (llm.askFile?.dir) out.askFile = llm.askFile.dir;
  const { baseURL, model, apiKey } = llm;
  if (baseURL || model || apiKey) {
    const missing = [!baseURL && "llm.baseURL", !model && "llm.model", !apiKey && "llm.apiKey"].filter(Boolean);
    if (missing.length > 0) {
      throw new LlmConfigError(`配置文件凭证不完整,缺 ${missing.join(" / ")}——codesense config set 补齐,或 codesense config unset llm.* 清掉半套配置`);
    }
    out.cfg = { baseURL: baseURL!, model: model!, apiKey: apiKey! };
  }
  return out;
}

/** 解析 LLM 配置:返回 null=无任何 LLM 形态(调用方确定性降级/显式报错)。 */
export function resolveLlmConfig(opts: ResolveOpts = {}): ResolvedLlm | null {
  const f = opts.flags;
  if (f && (f.baseURL || f.model || f.apiKey)) {
    const missing = [!f.baseURL && "baseURL", !f.model && "model", !f.apiKey && "apiKey"].filter(Boolean);
    if (missing.length > 0) throw new LlmConfigError(`flag 凭证不完整,缺 ${missing.join(" / ")}(--base-url/--model/--api-key 三件套一起给)`);
    return { kind: "direct", cfg: f as LlmConfig, source: "flag" };
  }
  const envCfg = fromEnv(opts.env ?? process.env);
  if (envCfg) return { kind: "direct", cfg: envCfg, source: "env" };
  const file = opts.configFile !== undefined ? opts.configFile : readConfigFile();
  const fc = fromConfig(file);
  if (fc.cfg) return { kind: "direct", cfg: fc.cfg, source: "config" };
  if (fc.askFile) return { kind: "ask-file", dir: fc.askFile };
  return null;
}

/** 语义层必用形态:无 LLM=抛 LlmConfigError(fail-visible,exit 2)。 */
export function requireSenseLlm(opts: ResolveOpts = {}): SenseLlm {
  const r = resolveLlmConfig(opts);
  if (!r) {
    throw new LlmConfigError(
      "语义层需要 LLM(三选一):①codesense config set llm.baseURL/llm.model/llm.apiKey;②GENIE_LLM_* env;③codesense config set llm.askFile.dir <目录>(宿主 agent 应答中继)",
    );
  }
  if (r.kind === "ask-file") return makeAskFileLlm(r.dir);
  return makeSenseLlm(r.cfg);
}

// ---- 直连适配器(OpenAI 兼容 chat;与 makeReviewLlm 同构,SenseLlm 契约) ----

export function makeSenseLlm(cfg: LlmConfig, opts: { timeoutMs?: number } = {}): SenseLlm {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  // baseUrl 归一(fix S137-1):预设常自带 /v1,旧实现会拼成 /v1/v1/chat/completions → 404。
  const endpoint = chatCompletionsUrl(cfg.baseURL);
  return {
    async generate(prompt: string): Promise<string> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({ model: cfg.model, messages: [{ role: "user", content: prompt }] }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`语义 LLM HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== "string") throw new Error("语义 LLM 响应缺 choices[0].message.content");
        return content;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// ---- ask-file 中继(宿主零配置形态; §3.2 形态②) ----

export interface AskFileProtocol {
  /** CLI 写:语义问题。 */
  ask: { id: string; prompt: string; createdAt: number; timeoutSec: number; schemaHint?: string };
  /** 宿主写:纯 JSON 字符串答案(与 schema 提示一致;原样回灌管线)。 */
  answer: string;
}

export function makeAskFileLlm(dir: string, opts: { timeoutMs?: number; pollMs?: number; idFactory?: () => string } = {}): SenseLlm {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const pollMs = opts.pollMs ?? 250;
  const idFactory = opts.idFactory ?? (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  return {
    async generate(prompt: string): Promise<string> {
      mkdirSync(dir, { recursive: true });
      const id = idFactory();
      const askPath = join(dir, `ask-${id}.json`);
      const answerPath = join(dir, `answer-${id}.json`);
      const schemaHint = /输出 JSON\(schema:\s*(\{[^\n]*\})/.exec(prompt)?.[1];
      writeFileSync(askPath, JSON.stringify({ id, prompt, schemaHint, createdAt: Date.now(), timeoutSec: Math.round(timeoutMs / 1000) }, null, 2), { mode: 0o600 });
      try {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (existsSync(answerPath)) {
            let content: string;
            try {
              content = readFileSync(answerPath, "utf-8");
            } finally {
              rmSync(answerPath, { force: true });
              rmSync(askPath, { force: true });
            }
            const parsed = (JSON.parse(content) as { answer?: string } | string);
            const answer = typeof parsed === "string" ? parsed : parsed.answer;
            if (typeof answer !== "string" || !answer.trim()) {
              throw new Error(`ask-file 应答缺 answer 字段(${answerPath} 已消费并删除)`);
            }
            return answer;
          }
          await new Promise((r) => setTimeout(r, pollMs));
        }
        rmSync(askPath, { force: true }); // 超时:撤题,不留陈旧占位
        throw new Error(`ask-file 中继超时(${Math.round(timeoutMs / 1000)}s):宿主未应答 ask-${id}.json(目录 ${dir})`);
      } catch (err) {
        rmSync(askPath, { force: true });
        rmSync(answerPath, { force: true });
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
