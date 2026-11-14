#!/usr/bin/env tsx
/**
 * 生产入口:配置经多层合并(default < ~/.lampgenie-harness/config.json < genie.config.json < env GENIE_*)
 * 构造 executor 与 LLM;面板 HTTP+WS 同端口。验收入口 = 本文件(不是测试装配)。
 */
import { loadConfig, writeProjectConfig, applyConfigPatch, resolveTrackApiKey, resolveCodingModelRoute, modelMetaOf, setSecretValue, listSecretKeys, FileJournal, type Config } from "@lampgenie/core";
import { createGatewayApp, type GatewayApp } from "./app.js";
import { servePanel } from "./panel.js";
import { buildExecutorFromConfig, buildModelProviders, buildAudioChatFromConfig, buildLlmFromConfig } from "./factory.js";
import { createSessionModelStore } from "./session-model.js";
import { reconcileCodingRoute, reconcileRoleRoute, resolveModelSwitch, resolveRoleSwitch, type EffectiveModel } from "./model-switch.js";
import { envOccupiedOf, envOccupiedHint, legacyEnvContamination } from "./cfg-env-occupancy.js";
import { buildSessionExport } from "./session-export-full.js";
import { setPermissionMode } from "./permission-mode.js";
import { resolveStartupPreset, setCurrentPresetName } from "./permission-presets.js";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, isAbsolute } from "node:path";
import type { Server } from "node:http";
import { repoRoot } from "./repo-root.js";
import { acquireInstanceLock, releaseInstanceLock } from "./instance-lock.js";
import { clearGatewayPid, formatExitLog, gatewayPidPath, writeGatewayPid } from "./gateway-pid.js";
import { journalArchiveDirOf } from "./journal-maintenance.js";
import { modelsCredentialMissing, modelsEndpointMissing, modelsUnknownProvider, modelsUpstreamFailure } from "./models-errors.js";
import { Model150mSupervisor } from "./model-service-supervisor.js";
import { loadEnvFile } from "./env-file.js";
import { resolveTeamMode, seedRegistryProjects } from "./team-embedded.js";

const root = repoRoot();
// .env 加载:repoRoot/.env 此前对 gateway 是死文件(RELAY_URL 写了从未生效,
// 团队页恒空注意)。只填进程 env 未占用的键——外部显式 env 优先,行为面不回退。
loadEnvFile(join(root, ".env"));
// fixE1(生产环境 P1 启动卡死):启动阶段耗时打点——下次「端口在听但不响应」一眼可见卡在哪段。
const bootT0 = Date.now();
// 稳定性批:pid 文件写点收归网关自己(此前只有外部重启脚本写,重启不经过脚本就永远旧 pid);
// 退出日志记录来源(signal/exit)、pid/ppid/uptime/活跃任务——外部 SIGINT 反复杀网关时一眼定位。
const gatewayPidFile = gatewayPidPath(root);
const startedBy = process.env.GENIE_STARTED_BY || undefined;
let lifecycleApp: GatewayApp | undefined;
/** 活跃任务(running/queued/blocked)计数+分布;网关装配中/异常时 active=-1(日志记 ?)。 */
function activeTaskStats(): { active: number; states: string } {
  try {
    const tasks = lifecycleApp?.taskManager.list() ?? [];
    const live = tasks.filter((t) => t.state === "running" || t.state === "queued" || t.state === "blocked");
    const by: Record<string, number> = {};
    for (const t of live) by[t.state] = (by[t.state] ?? 0) + 1;
    return { active: live.length, states: Object.entries(by).map(([k, v]) => `${k}:${v}`).join(",") };
  } catch {
    return { active: -1, states: "" };
  }
}
function logLifecycleExit(reason: "signal" | "exit", extra: { signal?: string; code?: number } = {}): void {
  const s = activeTaskStats();
  console.log(formatExitLog({
    reason,
    ...extra,
    pid: process.pid,
    ppid: process.ppid,
    uptimeMs: Date.now() - bootT0,
    activeTasks: s.active,
    ...(s.states ? { taskStates: s.states } : {}),
    ...(startedBy ? { startedBy } : {}),
  }));
}
// B1 进程级兜底:ws 消息分发已逐连接兜底,这里是最后防线——本地面板服务可用性优先,
// 响亮记录(stderr→日志文件)后保活,不静默、不吞业务错误(业务层错误仍在各自连接内回 error 帧)。
// 异常日志也带进程指纹(pid/ppid/uptime/活跃任务),与退出日志同一组字段,排障可直接对表。
function anomalyTag(): string {
  const s = activeTaskStats();
  return `pid=${process.pid} ppid=${process.ppid} uptimeMs=${Date.now() - bootT0} activeTasks=${s.active < 0 ? "?" : s.active}`;
}
process.on("uncaughtException", (err) => {
  console.error(`[gateway] uncaughtException 保活(${anomalyTag()}):`, err instanceof Error ? (err.stack || err.message) : String(err).slice(0, 400));
});
process.on("unhandledRejection", (reason) => {
  console.error(`[gateway] unhandledRejection 保活(${anomalyTag()}):`, String(reason).slice(0, 400));
});
const loaded = loadConfig({ repoRoot: root });
const bootConfigMs = Date.now() - bootT0; // fixE1:config 装配耗时(多层合并+预设解析)
const config = loaded.config;
// 根因可见化:进程 env 里的 GENIE_LLM_* 会在 loadConfig 的 env 层压顶(且旧凭证回退会把
// GENIE_LLM_API_KEY 当成任何 Provider 的钥匙)。模型切换失效时这是第一嫌疑,启动即响亮点名。
const legacyEnv = legacyEnvContamination(process.env);
if (legacyEnv.length) {
  console.warn(
    `[gateway] ⚠ 检测到遗留模型环境变量 ${legacyEnv.join(" / ")}——它们会覆盖面板里的模型/端点/凭证;` +
    `请从启动环境清除(GENIE_LLM_MODEL/BASE_URL/API_KEY 均不需要,凭证放 .genie/secrets.json)`,
  );
}
// 审计日志(config.change 产生点;默认 $HOME/audit/,与 session journal 分离)。
const { AuditLog } = await import("@lampgenie/runtime/security/audit-log");
const auditLog = new AuditLog();

// cfg.set 服务端处理器:热应用(模型名/超时/maxTokens)+持久化到项目级配置文件
function handleCfgSet(patch: Record<string, unknown>): {
  applied: string[];
  needsRestart: string[];
  envOccupied: string[];
 /** 跨端点热切补丁(用户用户反馈「切阿里云还是 GLM」):provider.update 本身支持
   *  baseUrl/apiKey/apiType,但面板只发 providerId/apiKeyEnv(引用名)——这里在 config 已合并后
   *  把新端点/凭证/协议解析成 update 可吃的具体值,让跨 Provider 切换也立即生效。 */
  hotLlm?: Record<string, unknown>;
  /** 实际生效选择(面板展示;绝不含密钥值)。 */
  effective?: EffectiveModel;
  warning?: string;
  routeError?: string;
  /** 角色 provider 热切补丁(含 apiKey,仅供 app.ts 内部 update;绝不随回包下发)。 */
  roleHot?: Record<string, Record<string, unknown>>;
} {
  const { next, applied, needsRestart } = applyConfigPatch(config, patch);
  const touched = [...applied, ...needsRestart];
  const roleHot: Record<string, Record<string, unknown>> = {};
  const roleWarnings: string[] = [];
  const roleErrors: string[] = [];

 // 选择即 Provider Registry——先把 coding.llm 的陈旧路由校正到「拥有该模型的 Provider」,
  // 再解析热切参数。模型名单独变更(面板只发 model)也不会再落到旧端点/旧凭证上。
  let switchRes: ReturnType<typeof resolveModelSwitch> | undefined;
  const codingTouched = touched.some((p) => p.startsWith("coding.llm."));
  const modelsTouched = touched.some((p) => p.startsWith("coding.models."));
  if (codingTouched || modelsTouched) {
    // 角色补丁也要先把主轨 route 校正到 Registry 真值——否则「role 继承主轨」会继承一份陈旧路由。
    const reconciled = reconcileCodingRoute(next).changed;
    if (codingTouched) {
 // 轨级 maxTokens 残留钳制:模型切换(pill 只发 model)不清轨级 maxTokens,
      // 旧模型的大值(如 deepseek 384000)会打进新端点触发 400 [1210] max_tokens 参数非法。
      // 切换未显式带 maxTokens 且轨级值超过新模型 meta 上限时,顺手把配置修回上限——显式
      // 带了则尊重用户输入(运行时由 resolveRequestMaxTokens 规则④兜底钳制)。
      const modelSwitched = touched.includes("coding.llm.model");
      const patchLlm = (patch?.coding as { llm?: { maxTokens?: unknown } } | undefined)?.llm;
      const explicitMax = typeof patchLlm?.maxTokens === "number";
      if (modelSwitched && !explicitMax && typeof next.coding.llm.maxTokens === "number") {
        const meta = modelMetaOf(next, next.coding.llm.model ?? "");
        if (meta?.maxTokens && next.coding.llm.maxTokens > meta.maxTokens) {
          const oldMax = next.coding.llm.maxTokens;
          next.coding.llm.maxTokens = meta.maxTokens;
          if (!applied.includes("coding.llm.maxTokens")) applied.push("coding.llm.maxTokens");
          roleWarnings.push(`模型切换:maxTokens ${oldMax} 超过「${next.coding.llm.model}」上限 ${meta.maxTokens},已自动钳制(旧模型残留值)`);
        }
      }
      switchRes = resolveModelSwitch(next, root);
      for (const p of reconciled) {
        if (switchRes.hotLlm) {
          // 本次 provider.update 会带上校正后的 baseUrl/key/协议 → 路由键同样算热应用。
          if (!applied.includes(p)) applied.push(p);
          const i = needsRestart.indexOf(p);
          if (i >= 0) needsRestart.splice(i, 1);
        } else if (!needsRestart.includes(p)) {
          needsRestart.push(p);
        }
      }
    }
  }
 // 角色模型同源:role 只配 model 时也按模型拥有者解析端点/协议/凭证,不再继承旧主轨端点。
 // voice(语音任务书同进本循环:reconcile 归属路由;其 roleHot 无 provider 实例可 update,
  // app.ts 不消费——服务端每次 voice.draft 现读 live config,这里只负责把归属写对+报 routeError。
  for (const role of ["compact", "review", "subagent", "digest", "voice"] as const) {
    if (!touched.some((p) => p.startsWith(`coding.models.${role}.`))) continue;
    const reconciled = reconcileRoleRoute(next, role)?.changed ?? [];
    const rr = resolveRoleSwitch(next, root, role);
    for (const p of reconciled) {
      if (rr?.hot) {
        if (!applied.includes(p)) applied.push(p);
        const i = needsRestart.indexOf(p);
        if (i >= 0) needsRestart.splice(i, 1);
      } else if (!needsRestart.includes(p)) {
        needsRestart.push(p);
      }
    }
    if (rr?.hot) roleHot[role] = rr.hot;
    if (rr?.warning) roleWarnings.push(rr.warning);
    if (rr?.routeError) roleErrors.push(rr.routeError);
  }
 // env 占用甄别(模型切换失效注意):这些键被进程 env 层压住,重启也不生效——
  // 面板徽标必须说实话,否则「已写入 · 重启生效」是永远兑现不了的假话。
 // 冷项(providerId/baseUrl/apiKeyEnv)也要查——此前只看 applied,env 压住路由时完全不可见。
  const envOccupied = envOccupiedOf([...applied, ...needsRestart], loaded.sources);
  // 凭证真的走了旧直传兜底(+ 环境里还有 GENIE_LLM_API_KEY)才算被劫持;专属密钥已解析到就不误报。
  const cred = switchRes?.effective?.credentialSource;
  if ((cred === "legacy-env" || cred === "legacy-secrets") && process.env.GENIE_LLM_API_KEY && !envOccupied.includes("coding.llm.apiKeyEnv")) {
    envOccupied.push("coding.llm.apiKeyEnv");
  }
  // 原子写盘(即使全热也要持久化,重启后一致)
  try {
    writeProjectConfig(loaded.projectPath, next);
  } catch (err) {
 // 用户用户反馈(权限模式选了不生效):写盘失败静默吞=「热应用成功但重启回弹」的元凶
    // ——降级可用,但必须可见(audit 明细),不许无痕。
    auditLog.append(
      { actor: { kind: "user", device: "panel" }, action: "config.change", target: { type: "config-key", id: applied.join(",") || "(no-op)" }, result: "error", source_ip_scope: "lan" },
      { applied, needsRestart, warn: "配置写盘失败(只读环境?重启后将回弹): " + String(err).slice(0, 120) },
    );
  }
  Object.assign(config, next);
 // 审计:config.change( §6;明细只入 hash)。
  auditLog.append(
    { actor: { kind: "user", device: "panel" }, action: "config.change", target: { type: "config-key", id: applied.join(",") || "(no-op)" }, result: applied.length ? "ok" : "error", source_ip_scope: "lan" },
    {
      applied, needsRestart,
      ...(envOccupied.length ? { warn: envOccupiedHint(envOccupied) } : {}),
      ...(switchRes?.hotLlm ? { hotLlm: true } : {}),
      ...(switchRes?.effective ? { effective: switchRes.effective } : {}),
    },
  );
  const warnings = [switchRes?.warning, ...roleWarnings].filter(Boolean) as string[];
  const errors = [switchRes?.routeError, ...roleErrors].filter(Boolean) as string[];
  return {
    applied, needsRestart, envOccupied,
    ...(switchRes?.hotLlm ? { hotLlm: switchRes.hotLlm } : {}),
    ...(switchRes?.effective ? { effective: switchRes.effective } : {}),
    ...(Object.keys(roleHot).length ? { roleHot } : {}),
    ...(warnings.length ? { warning: warnings.join(";") } : {}),
    ...(errors.length ? { routeError: errors.join(";") } : {}),
  };
}

const executor = buildExecutorFromConfig(config);
// 权限模式启动装载:ask 缺省;面板下拉 cfg.set permissions.mode 热改。
// 预设解析 fail-closed——permissions.preset/defaultPreset 引用非法的预设名时**拒绝启动**并点名,
// 绝不静默降级成 ask(权限放宽/收窄必须是用户的显式动作);启动口径 defaultPreset ?? preset ?? workspace-write。
// mode 与 preset 的 mode 冲突由 resolveStartupPreset 给 warnings(preset 优先),这里逐条打印,不许静默。
const startupPreset = (() => {
  try {
    return resolveStartupPreset(config.permissions);
  } catch (err) {
    console.error(`[gateway] ✗ 权限预设非法,拒绝启动:${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    throw err; // 不可达(process.exit 已终止);仅为类型
  }
})();
setPermissionMode(startupPreset.mode);
setCurrentPresetName(startupPreset.preset);
for (const w of startupPreset.warnings) console.warn(`[gateway] ⚠ ${w}`);
const modelProviders = buildModelProviders(config, root, loaded.sources); // coding 轨(vibe coding/工具/压缩)
// 主 agent 大脑 = audio 轨 chat(「主管理进程」/07 链路);未配置显式回退 coding 轨并打标
// (audio.chat 未配置时回退 coding=显式降级,journal/sysMeta 可观测;配置即走语音轨,不是凭证混轨——key 仍各轨各解析)
const audioChat = buildAudioChatFromConfig(config, root, loaded.sources);
// 轨道分工( super agent 指挥台):对话大脑 = coding 主模型(modelProviders.main);
// audio.chat 只保留两个用途:①coding 未配置时的 llm 回退 ②ASR(voice.transcribe 语音转写,
// app.ts 用同一 provider 一次 chat 调用)。不再有「语音直入大脑」/语音回播链路。
const llm = modelProviders.main ?? audioChat;
const llmTrack = modelProviders.main ? "coding" : (audioChat ? "audio.chat(coding 未配置回退)" : "off");

// 端点模型列表(设置页模型选择器;qwen/ZCode 模型下拉同语义):GET {baseUrl}/v1/models
// providerId 指定时按该 provider 的端点/凭证拉(测试连接=验证 URL+key 是否可用)
/** baseUrl 末尾已带版本段(/v1)时不再重复拼;兼容预设(含 /v1)与旧配置(不含 /v1)两种形态。 */
function endpointPath(baseUrl: string, suffix: string): string {
  const b = baseUrl.replace(/\/+$/, "");
  return /\/v\d+$/.test(b) ? `${b}${suffix}` : `${b}/v1${suffix}`;
}
/** 模型列表/探活失败文案共用:状态码 → 人话短提示(面板状态行可直接显示)。 */
function statusHintOf(status: number): string {
  if (status === 401) return "凭证无效?";
  if (status === 403) return "无权限?";
  if (status === 404) return "模型或端点路径不存在?";
  if (status === 429) return "限流";
  if (status >= 500) return "端点异常";
  return "请求失败";
}
/** 响应体摘录取前 ~120 字并压成单行(否则面板状态行被多行 body 撑爆)。 */
function briefBody(text: string, max = 120): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}
async function listModels(providerId?: string): Promise<string[]> {
  const provider = providerId ? config.providers.find((p) => p.id === providerId) : undefined;
 // 失败面拆成可操作错误码(models-no-provider / not-configured / no-credential /
  // upstream-failed),server.ts 用 modelsErrorOf 原样映射;成功路径回包不变。
  if (providerId && !provider) throw modelsUnknownProvider(providerId);
 // 设置页是「Coding 模型管理」——无 providerId 时必须按 coding 轨拉取,
  // 不能因为 audio.chat(语音输入/回退轨)已配置就去拉语音端点(旧实现会把 qwen 模型混进 coding 目录)。
  const codingRoute = resolveCodingModelRoute(config, config.coding.llm);
  const baseUrl = provider ? provider.baseUrl : codingRoute.baseUrl;
  const apiType = provider ? (provider.apiType ?? "chat") : (codingRoute.apiType ?? "chat");
  if (!baseUrl) throw modelsEndpointMissing({ providerCount: config.providers.length, ...(providerId ? { providerId } : {}) });
  const apiKeyEnv = provider ? (provider.apiKeyEnv || "GENIE_LLM_API_KEY") : codingRoute.apiKeyEnv;
  const key = resolveTrackApiKey("coding", apiKeyEnv, { repoRoot: root });
  if (!key) throw modelsCredentialMissing(apiKeyEnv);
 // anthropic 兼容端点两种凭证头都认(智谱经验证 Bearer 可用,x-api-key 亦兼容),同时带上最稳。
  const headers: Record<string, string> = { authorization: `Bearer ${key}` };
  if (apiType === "anthropic") headers["x-api-key"] = key;
  const url = endpointPath(baseUrl, "/models");
  let res: Response;
  try {
    res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const name = (err as { name?: unknown } | undefined)?.name;
    const timedOut = name === "TimeoutError" || name === "AbortError";
    throw modelsUpstreamFailure({
      baseUrl,
      detail: timedOut ? "请求超时(15s):检查网络/代理或 baseUrl 是否可达" : `不可达:${String(err).slice(0, 120)}`,
    });
  }
  if (!res.ok) {
    // 人话化:端点+状态码+原因(凭证/路径/权限)+响应体摘要;不把 apiKey 写进 message。
    const body = briefBody(await res.text().catch(() => ""));
    const hint = res.status === 401 ? "(凭证无效?)" : res.status === 404 ? "(端点路径 /v1/models 不存在?)" : res.status === 403 ? "(无权限?)" : "";
    throw modelsUpstreamFailure({ baseUrl, detail: `返回 HTTP ${res.status}${hint}${body ? ` ${body}` : ""}` });
  }
  let data: { data?: { id?: string }[] };
  try {
    data = (await res.json()) as { data?: { id?: string }[] };
  } catch {
    throw modelsUpstreamFailure({ baseUrl, detail: "响应不是合法 JSON(检查 baseUrl 是否指向 OpenAI 兼容端点 /v1)" });
  }
  return (data.data ?? []).map((m) => m.id ?? "").filter(Boolean).sort();
}

/** 单模型探活( F4):设置页模型列表逐项「测」——解析端点/凭证后发一次最小 chat(max_tokens=1)。
 * 判定口径:HTTP 2xx 且 choices 存在=可用;401/404/余额类错误=不可用(错误短文案带回面板)。 */
async function probeModel(model: string, providerId?: string): Promise<{ ok: boolean; ms: number; error?: string }> {
  const t0 = Date.now();
  try {
    const provider = providerId ? config.providers.find((p) => p.id === providerId) : undefined;
    if (providerId && !provider) throw new Error(`未知 provider: ${providerId}`);
    // 探活尊重「显式 Provider」(目标就是验证这条端点);无 providerId 时按模型拥有者解析 coding 路由。
    const route = provider
      ? { baseUrl: provider.baseUrl, apiKeyEnv: provider.apiKeyEnv || "GENIE_LLM_API_KEY", apiType: provider.apiType ?? "chat" }
      : resolveCodingModelRoute(config, { ...config.coding.llm, model });
    const baseUrl = route.baseUrl;
    const apiType = route.apiType ?? "chat";
    if (!baseUrl) throw new Error("端点未配置");
    const key = resolveTrackApiKey("coding", route.apiKeyEnv, { repoRoot: root });
    if (!key) throw new Error("凭证不可解析");
 // 协议分派:anthropic/responses 端点不能用 chat/completions 探活(会假阴性 404)。
    let url: string, headers: Record<string, string>, body: unknown;
    if (apiType === "anthropic") {
      url = endpointPath(baseUrl, "/messages");
      headers = { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" };
      body = { model, max_tokens: 1, messages: [{ role: "user", content: "1" }] };
    } else if (apiType === "responses") {
      url = endpointPath(baseUrl, "/responses");
      headers = { "content-type": "application/json", authorization: `Bearer ${key}` };
      body = { model, input: [{ role: "user", content: "1" }], max_output_tokens: 1 };
    } else {
      url = endpointPath(baseUrl, "/chat/completions");
      headers = { "content-type": "application/json", authorization: `Bearer ${key}` };
      body = { model, messages: [{ role: "user", content: "1" }], max_tokens: 1 };
    }
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      const detail = briefBody(await res.text().catch(() => ""));
      // 404 前置 model_not_found 关键字(面板/上游按关键字识别「模型不存在」,不必解析中文)。
      const prefix = res.status === 404 ? "model_not_found: " : "";
      const error = `${prefix}HTTP ${res.status} ${statusHintOf(res.status)}:模型「${model}」在端点 ${baseUrl}${detail ? ` ${detail}` : ""}`;
      return { ok: false, ms: Date.now() - t0, error };
    }
    const data = (await res.json()) as { choices?: unknown[]; content?: unknown[]; output?: unknown[]; object?: string };
    const ok = apiType === "anthropic"
      ? Array.isArray(data.content)
      : apiType === "responses"
        ? data.object === "response" || Array.isArray(data.output)
        : Array.isArray(data.choices);
    return { ok, ms: Date.now() - t0, ...(ok ? {} : { error: "响应无有效内容(" + apiType + ")" }) };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: String(err).slice(0, 140) };
  }
}

const port = config.gateway.port;
const journalDir = config.journal.dir ?? undefined;
// journal 是持久数据,相对路径必须锚定仓根——否则不同 cwd 启动的实例各写各的文件,
// 历史数据「消失」(经验证:apps/gateway cwd 启动 → apps/gateway/.genie/journals 小文件,token 追踪全空)。
const journalDirAbs = journalDir && !isAbsolute(journalDir) ? join(root, journalDir) : journalDir;
const panelEnabled = config.gateway.panel;

// fixE1(生产环境 P1「重启后端口在听但 HTTP 长时间 000」):先发起 listen 再做启动重活。
// 原顺序 createGatewayApp(内含 journal 全量同步加载/任务回放/收编等)整体先于 servePanel——
// journal 慢(慢盘/杀软扫描/规模增长)时端口迟迟不 bind,curl 只见 000;且期间事件循环被
// 同步加载占死,bind 后也无法应答。现把端口绑定提前到 app 构建之前:端口先就绪,重活期间
// 到达的连接在内核侧排队,循环一空即应答;WS 在 app 就绪后补挂(面板自带 3s 退避重连,无感)。
let bootServer: Server | undefined;
let appReady: GatewayApp | undefined;
if (panelEnabled) {
  servePanel(port, (httpServer) => {
    bootServer = httpServer;
    if (appReady) appReady.attachWs(httpServer); // listening 回调晚于 app 就绪的理论路径
  }, {
 // 会话完整导出(「日志下载就应该下载完全的内容」):journal 全事件+LLM 全量轨迹+子代理轨迹。
    // app 在 servePanel 之后创建,journal 经闭包延迟取(请求时才求值)。
    sessionExport: (sid) => {
      if (!appReady) throw new Error("网关装配中,journal 未就绪");
      return buildSessionExport({
        sessionId: sid,
        events: appReady.journal.readSession(sid),
        traceRoot: join(root, ".genie", "llm-trace"),
      });
    },
    // IDE 图片预览:/ide/asset 按项目根沙箱取图(pid 显式优先,缺省 active;app 未就绪=暂无根)
    ideProjectRoot: (pid) => {
      if (!appReady) return undefined;
      try {
 // 远程项目(SSH/WSL)的根 = identity(resolveWorkdir 对 remote: 回退 harness,
        // 会让图片预览 404);本地项目 path 本身就是 realpath。
        const projects = appReady.projects;
        const id = pid || projects.activeId();
        const proj = projects.list().find((x) => x.id === id);
        return proj?.path ?? projects.resolveWorkdir(id) ?? undefined;
      } catch (e) { return undefined; }
    },
  });
  console.log(`[gateway] panel: http://127.0.0.1:${port}(端口先就绪,装配中)`);
}
// 单实例锁:同一 journal 目录被两个进程同写 → seq 重复 → 重启去重丢事件 →
// 历史缺 assistant 消息只剩 tool 结果 → LLM 400。第二个实例直接拒绝启动(陈旧锁自动回收)。
const lockPath = journalDirAbs ? join(journalDirAbs, "gateway.lock") : undefined;
if (lockPath) {
  const lock = acquireInstanceLock(lockPath);
  if (!lock.ok) {
    const extra = lock.reason === "stale-unremovable" || lock.reason === "lock-unreadable"
      ? `\n  ${lock.detail ?? ""}`
      : "";
    console.error(
      `[gateway] 拒绝启动:journal 已被另一实例占用(pid=${lock.holderPid ?? "?"},dir=${journalDirAbs},reason=${lock.reason ?? "held"})。\n` +
      `  双写同一 journal 会造成 seq 重复与事件丢失(LLM 400 的根因)。先停掉旧实例再启动;` +
      `确认是陈旧锁(进程已死/PID 被复用)会自动回收,也可手动删除 ${lockPath}。${extra}`,
    );
    process.exit(1);
  }
  if (lock.reclaimedPid !== undefined) {
    console.log(`[gateway] 已回收陈旧锁:原持有 pid=${lock.reclaimedPid}(进程已退出/PID 被复用/锁内容损坏)`);
  }
  process.on("exit", () => releaseInstanceLock(lockPath));
}
// fault 冷启动修复:journal 全量同步重放(经验证 28k+ 行/59s boot)移到 createGatewayApp 之前,
// 用 loadChunked 分片读/解析/入账并让出事件循环;任务/会话数据在 app 装配前已就绪,恢复语义不变。
let bootJournal: FileJournal | undefined;
let bootJournalMs = 0;
if (journalDirAbs) {
  const t0 = Date.now();
  bootJournal = new FileJournal(`${journalDirAbs}/gateway.jsonl`, {
    writeBehind: true,
    sharded: true,
    deferLoad: true,
 // 存储维护:归档会话放在 journalDir 之外,冷启动只扫 sessions/,
 // 归档文件只在 readSession 冷读兜底时按需解析(经验证 178 文件/813MB → boot 逐文件 load 近 6min)。
    archiveDir: journalArchiveDirOf(journalDirAbs),
  });
  await bootJournal.loadChunked();
  bootJournalMs = Date.now() - t0;
  console.log(`[gateway] journal 分片加载完成 ${bootJournal.length} 行,用时 ${bootJournalMs}ms`);
}
const bootApp0 = Date.now();
// per-session 主模型覆盖(白板「per-session 主模型」):load-once store——首次读盘缓存,后续 set 内存+落盘同文件。
const sessionModels = createSessionModelStore(root);
const app: GatewayApp = createGatewayApp({
  port,
  journalDir: journalDirAbs,
  ...(bootJournal ? { journal: bootJournal } : {}),
  executor,
  llm,
  useExternalHttp: panelEnabled,
  concurrency: config.concurrency,
  config,
  configSources: loaded.sources,
  configProjectPath: loaded.projectPath,
  onConfigSet: handleCfgSet,
 // 预设一键接入——Key 只写 .genie/secrets.json(0600),不进配置/日志/回包。
  onSecretSet: (name: string, value: string) => setSecretValue(root, name, value),
  listSecrets: () => listSecretKeys(root),
 // Super 的 sys_restart 计划性重启(生产入口才启用;测试/嵌入不传=未接线)。
  allowSelfRestart: true,
 // super agent 对话模型 = coding 主任务模型(companionLlm/companionTrack 已删除,
  // config.companion.track 被忽略并打日志);audio.chat 只服务 ASR(voice.transcribe)与 coding 未配置回退。
  // per-session 覆盖(session-models.json)按既有机制自然跟随主轨。
  llmTrack,
 // 主模型上下文窗口(轨对齐:audio.chat 优先,回退 coding.llm)
 // ZCode 模型管理语义:上下文窗口优先取选中模型的条目元数据,轨级字段回退
  contextWindow: modelMetaOf(config, config.audio.chat.model || config.coding.llm.model)?.contextWindow
    ?? (config.audio.chat as { contextWindow?: number }).contextWindow
    ?? (config.coding as { llm?: { contextWindow?: number } }).llm?.contextWindow,
  models: modelProviders.compact || modelProviders.review || modelProviders.subagent || modelProviders.digest
    ? {
        ...(modelProviders.compact ? { compact: modelProviders.compact } : {}),
        ...(modelProviders.review ? { review: modelProviders.review } : {}),
        ...(modelProviders.subagent ? { subagent: modelProviders.subagent } : {}),
        ...(modelProviders.digest ? { digest: modelProviders.digest } : {}),
      }
    : undefined,
  listModels,
 // aux 轨=coding 主provider(archLlm/压缩/记忆 llmCall 不再占 realtime 会话);探活注入。
  ...(modelProviders.main ? { auxLlm: modelProviders.main } : {}),
  probeModel,
  // per-session 主模型覆盖(白板「per-session 主模型」):load-once store 注入。
  sessionModels,
});
appReady = app;
lifecycleApp = app;
// 归档冷读开关:装配完成(journal 已加载/任务恢复/漂移修复等内部回读已结束)→ listen 之前
// 显式开启。此后只有显式用户读会话才回读 sessions-archive,boot 期归档零额外 IO(经验证归档 422MB 时
// 内部 readSession 逐个 sid 回读把 29 个归档文件全 parse,进程 6 分钟仍在装配)。
(app.journal as { enableArchiveReads?: () => void }).enableArchiveReads?.();
const bootAppMs = Date.now() - bootApp0;
if (panelEnabled) {
  // 同端口:HTTP 面板 + WS(app 就绪后把 gateway WS 挂到已 listen 的 server 上)
  if (bootServer) app.attachWs(bootServer);
} else {
  app.listenStandalone();
}
// pid 文件:listen 之后、装配完成时写——外部守护/安全重启器/排障读到的永远是
// 「当前真正在服务的进程」。写失败只告警不阻断(只读数据根仍可服务)。
if (writeGatewayPid(gatewayPidFile)) {
  console.log(`[gateway] pid 文件已写入: ${gatewayPidFile}(pid=${process.pid}${startedBy ? `,startedBy=${startedBy}` : ""})`);
} else {
  console.warn(`[gateway] pid 文件写入失败(只读数据根?): ${gatewayPidFile}`);
}

// watchdog 生命周期闭环(冻结治理):①启动即清 stop 标记——网关已在跑,不存在
// 还需要压住 watchdog 的受控重启(残留标记只会让守护失明);②watchdog 缺席时自动武装
// (detached setsid 子进程,脚本自身 flock 单实例,重复武装零成本;GENIE_WATCHDOG_AUTOARM=0 关)。
// 修的洞:重启流程死在半路(注意:「重建后重启 gateway」的任务 SIGINT 停掉网关时
// 把自己的宿主 worker 也带走,重建孤儿完成后再无人拉起;watchdog 自 10-28 起就没在跑)→
// 不变量变成「网关活着 ⇒ watchdog 在岗」,网关下次被杀必有人救。
{
  const stopMarker = join(root, ".genie", "gateway.watchdog.stop");
  const wdScript = join(root, ".genie", "gateway-watchdog.sh");
  try { rmSync(stopMarker, { force: true }); } catch { /* 清不掉无害 */ }
  if (process.env.GENIE_WATCHDOG_AUTOARM !== "0" && existsSync(wdScript)) {
    try {
      const wd = spawn("bash", [wdScript], { detached: true, stdio: "ignore", cwd: root });
      wd.unref();
      console.log(`[gateway] watchdog 自动武装(脚本在岗校验由 flock 单实例保证): ${wdScript}`);
    } catch (err) {
      console.warn(`[gateway] watchdog 自动武装失败(继续裸跑): ${String(err).slice(0, 120)}`);
    }
  }
}

console.log(`[gateway] listening on :${port} (panel=${panelEnabled}, executor=${executor?.kind ?? "none"}, llm=${llm ? "on" : "off"} · 轨=${llmTrack})`);
console.log(`[gateway] journal: ${journalDir ?? "(memory)"} · config: ${loaded.projectPath} (default<user<project<env)`);
console.log(`[gateway] boot: config ${bootConfigMs}ms · app-build ${bootAppMs}ms(journal 加载耗时见 [journal] 行) · 总就绪 ${Date.now() - bootT0}ms`); // fixE1
if (loaded.quarantined.length) console.warn(`[gateway] 配置文件损坏已隔离: ${loaded.quarantined.join(", ")}`);

// 内置 150M 模型服务:网关托管生命周期(boot 探活/拉起,异常重启,SIGINT/SIGTERM 回收)。
// 非阻塞:模型加载慢不拖住 7700 面板;缺模型只告警,shadow 评分 fail-soft。
const modelService = new Model150mSupervisor({
  repoRoot: root,
  config,
  log: (line) => console.log(line),
});
(globalThis as { __model150m?: unknown }).__model150m = modelService;
void modelService.start();

// 团队面三态(团队页空态修复):外部 relay(env 指向非本机)/内嵌自举(缺省:
// 本机 .genie/team 起单 org relay+bare 团队仓+owner 种子,gateway 自连)/off(GENIE_TEAM_RELAY=off)。
// 红线不变:relay 不可达=静默降级——本地任务/Git 全不受影响。
const teamMode = resolveTeamMode(process.env);
if (teamMode.kind !== "off") {
  const { TeamView } = await import("./team-view.js");
  const { loadOrCreateIdentity } = await import("@lampgenie/runtime/identity/identity");
  const identityDir = process.env.RELAY_IDENTITY_DIR ?? join(root, ".genie", "identity");
  loadOrCreateIdentity(identityDir);
  let teamUrls = TeamView.urlsFromEnv();
  if (teamMode.kind === "embedded") {
    const { startEmbeddedTeam } = await import("./team-embedded.js");
    const handle = await startEmbeddedTeam({ root, port: teamMode.port, log: (l) => console.log(l) });
    if (handle) {
      (globalThis as { __teamRelayEmbedded?: unknown }).__teamRelayEmbedded = handle;
      teamUrls = [`ws://127.0.0.1:${handle.port}`];
      console.log(`[gateway] team relay: 内嵌自举 :${handle.port}(owner=${handle.boot.member},团队仓=${handle.teamRepoUrl})`);
 // 全项目绑定种子(「团队页只有 lampgenie-harness」):注册表每个有 origin 的本地项目都进 roster。
      void seedRegistryProjects(handle, app.projects.list())
        .then((wrote) => { if (wrote.length > 0) console.log(`[gateway] team relay: 项目绑定种子 ${wrote.length} 项(${wrote.slice(0, 6).join(", ")})`); })
        .catch((err) => console.log(`[gateway] team relay: 项目绑定种子失败(团队页其余面不受影响):${String(err).slice(0, 140)}`));
    } else {
      // 端口被占:可能外部 relay 已在该端口——按原地址连,连不上面板如实显示 disconnected
      console.log(`[gateway] team relay: 内嵌端口 :${teamMode.port} 被占,按外部 relay 地址连接`);
    }
  } else {
    console.log(`[gateway] team relay: ${teamUrls.length} org(s) 连接中(外部)`);
  }
  if (teamUrls.length > 0) {
    const teamView = new TeamView({
      urls: teamUrls,
      identityDir,
      log: (l) => console.log(l),
    });
    (globalThis as { __teamView?: unknown }).__teamView = teamView;
    void teamView;
  }
}

let shuttingDown = false;
let exitLogged = false;
/** 退出日志只记一次(signal 已记则 exit 不重复;反之 exit 兜住 process.exit/代码路径退出)。 */
function logExitOnce(reason: "signal" | "exit", extra: { signal?: string; code?: number } = {}): void {
  if (exitLogged) return;
  exitLogged = true;
  logLifecycleExit(reason, extra);
}
const shutdown = async (signal: string) => {
  if (shuttingDown) {
    console.warn(`[gateway] 已在关闭中,忽略重复信号 ${signal}(pid=${process.pid})`);
    return;
  }
  shuttingDown = true;
 // 来源可见化:外部 SIGINT/SIGTERM 反复杀网关时,日志要能直接回答
  // 「谁在什么时候杀的」——信号名+pid/ppid+运行时长+活跃任务(有在跑任务时杀=会丢任务)。
  logExitOnce("signal", { signal });
  console.log("\n[gateway] shutting down...");
  try {
    await modelService.stop();
  } catch (err) {
    console.error("[gateway] 内置 150M 服务停止失败:", String(err).slice(0, 200));
  }
  // 内嵌团队 relay 关停(relay 周期器已 unref 不钉进程;显式 close 断 WS 连接更干净)。
  try {
    const emb = (globalThis as { __teamRelayEmbedded?: { close(): Promise<void> } }).__teamRelayEmbedded;
    if (emb) await emb.close();
  } catch { /* 关停 fail-soft */ }
  await app.close();
  process.exit(0);
};
process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGHUP", () => { void shutdown("SIGHUP"); });
// 兜底:任何退出路径(含 process.exit(1)/事件循环自然结束)都清理自己的 pid 文件并留一行指纹。
// clearGatewayPid 只在内容仍是本进程 pid 时删除,不会误删继任者的 pid 文件。
process.on("exit", (code) => {
  if (clearGatewayPid(gatewayPidFile)) console.log(`[gateway] pid 文件已清理: ${gatewayPidFile}`);
  logExitOnce("exit", { code });
});
