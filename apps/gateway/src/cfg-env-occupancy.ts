/**
 * cfg.set 的 env 占用甄别(用户用户反馈「面板切了 glm-5.3-flash,轨迹还是 deepseek」根因配套):
 * loadConfig 的合并序=user→project→**env 最后压顶**——进程环境里残留的 GENIE_LLM_MODEL/BASE_URL
 * 会把项目配置的 coding.llm.* 永久盖住:不重启=跨端点热路径冷项不切;重启=env 层又赢。「重启生效」
 * 徽标在此场景是假话,必须升格为「env 占用,重启也不生效」。
 * sources=loadConfig 的逐键来源表("user"|"project"|"env"|"default");applied=本次补丁落定的键。
 * 只报 env 层占用的键(其它层语义不受影响)。
 */
export function envOccupiedOf(applied: string[], sources: Record<string, string> | undefined): string[] {
  if (!sources) return [];
  return applied.filter((p) => sources[p] === "env");
}

/**
 * 遗留 GENIE_LLM_* 污染甄别。两类伤害:
 *  - MODEL/BASE_URL 在 loadConfig 的 env 层直接压顶;
 *  - API_KEY 是旧直传兜底:当路由使用 Provider 专属 keyEnv 且该专属变量不在 env 时,
 *    旧实现会把它当成该 Provider 的钥匙(智谱端点 + 阿里云 Key → 401「令牌已过期或验证不正确」)。
 * 返回会实际影响当前路由的变量名(值不读、不传、不落日志)。
 */
export function legacyEnvContamination(env: NodeJS.ProcessEnv, routeKeyEnv?: string): string[] {
  const out: string[] = [];
  if (env.GENIE_LLM_MODEL) out.push("GENIE_LLM_MODEL");
  if (env.GENIE_LLM_BASE_URL) out.push("GENIE_LLM_BASE_URL");
  if (env.GENIE_LLM_API_KEY) {
    // 专属 keyEnv 在 env 里有值时它会赢,旧键不会劫持;否则旧键可能被回退使用。
    if (!routeKeyEnv || routeKeyEnv === "GENIE_LLM_API_KEY" || !env[routeKeyEnv]) out.push("GENIE_LLM_API_KEY");
  }
  return out;
}

/** env 占用的人话提示(徽标/审计共用):点名要清的环境变量名。 */
export function envOccupiedHint(paths: string[]): string {
  const vars = new Set<string>();
  for (const p of paths) {
    if (p === "coding.llm.baseUrl") vars.add("GENIE_LLM_BASE_URL");
    else if (p === "coding.llm.model") vars.add("GENIE_LLM_MODEL");
    else if (p === "coding.llm.timeoutMs") vars.add("GENIE_LLM_TIMEOUT_MS");
    else if (p === "coding.llm.maxTokens") vars.add("GENIE_LLM_MAX_TOKENS");
    else if (p === "coding.llm.apiKeyEnv") vars.add("GENIE_LLM_API_KEY(旧直传兜底)");
    else if (p.startsWith("audio.chat.baseUrl")) vars.add("GENIE_AUDIO_CHAT_BASE_URL");
    else if (p.startsWith("audio.chat.model")) vars.add("GENIE_AUDIO_CHAT_MODEL");
  }
  return vars.size ? `env 占用(${[...vars].join("/")}),重启也不生效——需从网关进程环境清除` : "env 占用,重启也不生效";
}
