/**
 * review --deep 的 LLM 适配层(零新增依赖,fetch 直调)。
 * 凭证链(与 sensing/api 语义层同构):
 *   显式 flag(--base-url/--model/--api-key)> env 三件套(GENIE_LLM_BASE_URL/MODEL/API_KEY,
 *   与 gateway factory.buildLlmFromEnv 同名同源)> 配置文件 ~/.codesense/config.json
 *   > ask-file 中继(宿主零配置:CLI 写 ask-*.json,宿主 agent 答 answer-*.json,120s 超时撤题)。
 * 解析本体在 llm-config.ts(消费不改);本文件只做 ReviewLlm 契约(chat)与 SenseLlm 契约
 * (generate)之间的适配。纪律:--deep 缺凭证=fail-visible(调用方 exit 2),不静默降级成确定性层。
 */
import type { ReviewLlm } from "@lampgenie/code-sense/review";
import { chatCompletionsUrl, makeAskFileLlm, resolveLlmConfig, type ResolveOpts } from "./llm-config.js";

export interface ReviewLlmEnv {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** 从 env 读深审凭证;三件套缺一=null;BASE_URL/MODEL 在场但缺 KEY=抛(同 buildLlmFromEnv 语义)。
 * 起 CLI 主链路改走 resolveReviewLlm(完整凭证链);本函数保留为程序化兼容面
 * (index.ts 导出)——只读 env 一档,不覆盖 config/ask-file。 */
export function reviewLlmFromEnv(env: NodeJS.ProcessEnv = process.env): ReviewLlmEnv | null {
  const baseUrl = env.GENIE_LLM_BASE_URL;
  const model = env.GENIE_LLM_MODEL;
  const apiKey = env.GENIE_LLM_API_KEY;
  if (!baseUrl && !model && !apiKey) return null;
  if (!baseUrl || !model) {
    throw new Error("GENIE_LLM_BASE_URL 与 GENIE_LLM_MODEL 必须同时设置(深审 --deep)");
  }
  if (!apiKey) {
    throw new Error("GENIE_LLM_BASE_URL/MODEL 已设置但缺 GENIE_LLM_API_KEY");
  }
  return { baseUrl, model, apiKey };
}

/** 组 ReviewLlm:POST {baseUrl}/v1/chat/completions(OpenAI 兼容,与 harness openai-provider
 * 同构——baseUrl 带不带 /v1 都行,经 chatCompletionsUrl 归一),单条 user 消息,120s 超时。 */
export function makeReviewLlm(cfg: ReviewLlmEnv, opts: { timeoutMs?: number } = {}): ReviewLlm {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const endpoint = chatCompletionsUrl(cfg.baseUrl);
  return {
    async chat(prompt: string): Promise<{ content: string }> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify({
            model: cfg.model,
            messages: [{ role: "user", content: prompt }],
          }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`深审 LLM HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== "string") {
          throw new Error("深审 LLM 响应缺 choices[0].message.content");
        }
        return { content };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// ---- 凭证链接入:flag > env > config > ask-file,与 sensing/api 语义层同构 ----

export interface ResolvedReviewLlm {
  llm: ReviewLlm;
  /** 生效档位:flag / env / config(direct 三形态)/ ask-file(宿主应答中继)。 */
  source: "flag" | "env" | "config" | "ask-file";
}

/** 深审 LLM 解析:走 resolveLlmConfig 完整凭证链;返回 null=无任何 LLM 形态
 * (调用方 fail-visible exit 2)。部分凭证形态错=LlmConfigError 上抛(CLI 捕获 exit 2)。 */
export function resolveReviewLlm(opts: ResolveOpts = {}, llmOpts: { timeoutMs?: number } = {}): ResolvedReviewLlm | null {
  const r = resolveLlmConfig(opts);
  if (!r) return null;
  if (r.kind === "ask-file") return { llm: makeAskFileReviewLlm(r.dir, llmOpts), source: "ask-file" };
  return {
    llm: makeReviewLlm({ baseUrl: r.cfg.baseURL, model: r.cfg.model, apiKey: r.cfg.apiKey }, llmOpts),
    source: r.source,
  };
}

/** ask-file 中继的 ReviewLlm 适配:协议实现复用 llm-config.makeAskFileLlm(SenseLlm 契约),
 * 本层只做 generate→chat 的契约形转换(与 sensing 同一 ask/answer 文件协议,120s 超时撤题)。 */
export function makeAskFileReviewLlm(dir: string, opts: { timeoutMs?: number; pollMs?: number; idFactory?: () => string } = {}): ReviewLlm {
  const inner = makeAskFileLlm(dir, opts);
  return {
    async chat(prompt: string): Promise<{ content: string }> {
      return { content: await inner.generate(prompt) };
    },
  };
}
