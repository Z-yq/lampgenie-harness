/**
 * 会话 worker 入口(设计参考 ZCode(致谢):一会话一进程)。argv[2]=描述符文件路径。
 * 进程内自建完整 agent 栈(loadConfig+factory 纯函数:LLM/executor/项目表/记忆;文件态凭证
 * .genie/secrets.json+env 均可直接读),journal/权限/MCP/面板问答经 IPC 代理到 gateway;
 * 子代理(递归 LlmLoopBackend)、terminal PTY、文件工具、sense-index 在本进程内跑——
 * 重活不落 gateway 事件循环,会话间进程隔离。
 * 生命周期工程学抄 sense-index-worker:ppid 看门狗 + disconnect 自退双保险;任务终态即退出。
 * IPC 基座/ProxyJournal/代理工厂在 session-worker-lib.ts(可单测)。
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { JournalEvent } from "@lampgenie/core";
import type { LlmProvider } from "@lampgenie/runtime/agent/loop";
import type { TaskState, Task } from "@lampgenie/core/task/task";
import { loadConfig } from "@lampgenie/core";
import { buildExecutorFromConfig, buildModelProviders, buildAudioChatFromConfig } from "./factory.js";
import { createSessionModelStore, createSessionModelFace } from "./session-model.js";
import { TaskSupervisor } from "./task-manager.js";
import { ProjectRegistry } from "./projects.js";
import { setRuntimePromptProvider, wireAgentLoop } from "./agent-wiring.js";
import { resolvePromptForSessionSync, resolvePromptOverrideSync } from "./prompt-runtime.js"; // #209:worker 进程内的提示词覆盖( v2 会话钉扎)
import { createMemoryWiring } from "@lampgenie/memory";
import type { SessionWorkerSpec, HostMessage } from "./session-worker-protocol.js";
import { SESSION_WORKER_PROTOCOL_VERSION } from "./session-worker-protocol.js";
import { request, notify, ProxyJournal, makePermissionProxy, makeWfAskProxy, makeAskUserProxy, makeMcpProxy, handleHostResponse, setHostDead } from "./session-worker-lib.js";
import { postTerminalInflight } from "./agent-wiring.js";
import { installCrashGuards } from "./process-guards.js";
import { setPermissionMode } from "./permission-mode.js";

// 子进程标记:agent-wiring 的 goal 续跑守卫(本地 submit 网关不可见+退出截杀,续跑由网关发起)
process.env.GENIE_SESSION_WORKER_CHILD = "1";
const STARTED_AT = Date.now();

/** 启动阶段上报:阶段完成后 notify startup.progress —— host 侧阶段租约据此判卡点。
 * 纯观测,不改任务主流程;IPC 断(host 已死)时吞掉,由 disconnect 自退兜底。 */
function reportStartupStage(stage: "config" | "executor" | "providers" | "loop-ready"): void {
  try { notify({ t: "startup.progress", stage, at: Date.now() }); } catch { /* IPC 断=disconnect 兜底 */ }
}

// ---- 生命周期:父进程绑定(抄 sense-index-worker)----
function parentAlive(): boolean {
  try { process.kill(process.ppid ?? 0, 0); return true; } catch { return false; }
}
const exitParentLost = (): void => {
  console.error("[session-worker] 父进程失联,自退");
  setHostDead();
  process.exit(3);
};
process.on("disconnect", exitParentLost);
setInterval(() => { if (!parentAlive()) exitParentLost(); }, 2000).unref();
// 心跳(冻结治理,协议 v2):30s 一跳,只证「事件循环活着」——与工具/LLM 忙闲无关
// (长 LLM 调用/长命令/等待人工都是异步 await,心跳照发)。host 侧冻结探针
// (GENIE_SESSION_WORKER_FREEZE_MS,缺省 180s)无心跳+无任何上行 → 判事件循环冻结(典型:
// 9p 同步 IO 停顿)→ SIGTERM→SIGKILL 收割 + 任务翻 failed 可续——防四 loop 同冻 35 分钟无人收。
// 放 crashGuards 之前:装配期(loadConfig 读文件)的停顿同样被覆盖。
setInterval(() => { try { notify({ t: "hb", pid: process.pid }); } catch { /* IPC 断=disconnect 兜底 */ } }, 30_000).unref();
// 进程级崩溃保活:worker 早先只挂 unhandledRejection,任何一个漏网的
// uncaughtException(典型:工具层 socket 'error' 无人监听)都会让整个 worker code=1 退出,
// 同 worker 下的主 agent 与所有在跑子代理一起被收尸。与 gateway 主进程(main.ts)同纪律:
// 响亮记录后保活,业务错误仍在各自工具返回里 fail-visible。
installCrashGuards({ tag: "session-worker" });

let proxyJournalRef: ProxyJournal | null = null;
let ownTmRef: TaskSupervisor | null = null;
function cancelOwnTask(): void {
  // 经本地 TaskSupervisor 状态机走(wireAgentLoop onChange → loop.cancel)
  try { ownTmRef?.list().forEach((t) => { if (t.state === "running" || t.state === "queued") ownTmRef!.setState(t, "cancelled", "task.cancel(gateway)"); }); } catch { /* 尽力 */ }
}

// ---- host 消息处理 ----
process.on("message", (msg: HostMessage) => {
  if (!msg || typeof msg !== "object") return;
  switch (msg.t) {
    case "res":
      handleHostResponse(msg);
      break;
    case "cancel": {
      // reason 形态:task.cancel | subagent:<agentId>
      if (typeof msg.reason === "string" && msg.reason.startsWith("subagent:")) {
        const aid = msg.reason.slice("subagent:".length);
        const bg = (globalThis as { __bgAgents?: Map<string, { cancel?: () => unknown }> }).__bgAgents;
        try { bg?.get(aid)?.cancel?.(); } catch { /* 尽力 */ }
        return;
      }
      cancelOwnTask();
      break;
    }
    case "model.reload":
      // worker 生命周期=单任务;新任务由 host 重新 fork(装配期读最新配置)。当前任务继续。
      notify({ t: "log", line: "收到模型热切通知(本任务继续用当前 provider,新任务自动用新配置)" });
      break;
    case "journal.events":
      proxyJournalRef?.ingestRemote(msg.events as JournalEvent[]);
      break;
    default:
      break;
  }
});

// ---- 主流程 ----
async function main(): Promise<void> {
  const specPath = process.argv[2];
  if (!specPath) { console.error("[session-worker] 缺描述符参数"); process.exit(2); }
  const spec = JSON.parse(readFileSync(specPath, "utf-8")) as SessionWorkerSpec;
  // 协议版本握手(三轮复审 ④:抄 ACP initialize fail-visible——半重建状态显式报错,不静默错译)
  if (spec.protocolVersion !== SESSION_WORKER_PROTOCOL_VERSION) {
    console.error(`[session-worker] 协议版本不匹配: spec=${spec.protocolVersion} worker=${SESSION_WORKER_PROTOCOL_VERSION}(gateway/worker dist 半重建)`);
    notify({ t: "task.state", taskId: spec.task?.id ?? "(unknown)", state: "failed", error: `会话 worker 协议版本不匹配(host=${spec.protocolVersion}, worker=${SESSION_WORKER_PROTOCOL_VERSION})——重建 gateway dist 后重启(两 bundle 必须同批构建)` });
    process.exit(2);
  }
  const root = spec.repoRoot;
 // #209:worker 是独立进程、独立模块实例——主进程 createGatewayApp 注入的 provider
 // 不会带过来;这里按 worker 的 root 再注入一次,任务开工才读得到提示词版本覆盖。
 // v2 会话钉扎:同会话按 pins.json 的首钉版本解析(与主进程同一份数据面)。
 // #209:worker 是独立进程、独立模块实例——主进程 createGatewayApp 注入的 provider
 // 不会带过来;这里按 worker 的 root 再注入一次,任务开工才读得到提示词版本覆盖。
 // v2 会话钉扎:同会话按 pins.json 的首钉版本解析(与主进程同一份数据面)。
  setRuntimePromptProvider((key, sessionId) =>
    sessionId ? resolvePromptForSessionSync(root, sessionId, key) : resolvePromptOverrideSync(root, key),
  );


  const loaded = loadConfig({ repoRoot: root });
  const config = loaded.config;
 // 权限模式装载(复审 P1:main.ts 同款——缺这行 worker 恒 ask,
  // 配置 auto/readonly/plan 的用户在 worker 任务上语义漂移)
  setPermissionMode(config.permissions?.mode);
 // 阶段进度上报(只看不拦)——host 侧租约据此判「卡在哪一段」。
  reportStartupStage("config");
  const executor = buildExecutorFromConfig(config);
  reportStartupStage("executor");
  const modelProviders = buildModelProviders(config, root, loaded.sources);
  const audioChat = buildAudioChatFromConfig(config, root, loaded.sources);
  reportStartupStage("providers");
  let llm = modelProviders.main ?? audioChat;
 // per-session 主模型覆盖(用户用户反馈「会话内模型切换没生效」根因修复:进程内模式 runWithAgent
  // 已接 sessionModels,本 worker 子进程只读全局配置、不读 session-models.json——会话覆盖在 fork
  // 时整体丢失)。装配期按 spec.task.sessionId 派生独立 provider,语义与 agent-wiring runWithAgent 一致:
  // worker 单任务生命周期,捕获启动时引用=该任务全程模型(运行中切模型不热切当前任务,新任务重 fork 读最新);
  // 覆盖表损坏/派生失败 fail-soft warn 回退全局 llm,不挂任务。
  // m1:角色轨(子代理/压缩/评审)同跟随会话覆盖;m3:contextWindow 按会话模型重算(无 meta 回退 spec 值)。
  let models: { compact?: LlmProvider; review?: LlmProvider; subagent?: LlmProvider; digest?: LlmProvider } = {
    compact: modelProviders.compact, review: modelProviders.review, subagent: modelProviders.subagent, digest: modelProviders.digest,
  };
  let contextWindow = spec.contextWindow;
  try {
    const face = createSessionModelFace(config, root, createSessionModelStore(root));
    const override = face.resolve(spec.task.sessionId);
    if (override) {
      const derived = face.derive(spec.task.sessionId, override);
      if (derived) {
        llm = derived;
        console.log(`[session-worker] 会话 ${spec.task.sessionId} 使用覆盖模型 ${override.providerId ?? "(全局路由)"}/${override.model}${override.effort !== undefined ? ` effort=${override.effort || "(off)"}` : ""}`);
      } else {
        console.warn(`[session-worker] 会话 ${spec.task.sessionId} 覆盖 ${override.model} 派生失败,本任务回退全局 llm`);
      }
      const roleModels = face.deriveRoleModels(spec.task.sessionId, override);
      if (roleModels) models = { ...models, ...roleModels };
      const ovWindow = face.contextWindowFor(override);
      if (ovWindow !== undefined) contextWindow = ovWindow;
      // m7:effort 已随 derive 的合并视图进 provider(implementationEffort),此处不再另存。
    }
  } catch (err) {
    console.warn(`[session-worker] per-session 覆盖读取异常(回退全局 llm):`, String(err).slice(0, 160));
  }
 // 压缩阈值口径自证(死亡螺旋复盘用):contextWindow 在此丢失会退化到
 // compactThresholdTokens 兜底(经验证 24000),配合 floor 护栏已无螺旋风险,但口径必须可见。
  console.log(`[session-worker] 压缩口径: spec.contextWindow=${spec.contextWindow} 生效=${contextWindow}`);
  if (!llm || !executor) {
    notify({ t: "task.state", taskId: spec.task.id, state: "failed", error: `worker 装配失败(llm=${llm ? "on" : "off"},executor=${executor?.kind ?? "off"})——检查 genie.config.json` });
    process.exit(2);
  }

  const journal = new ProxyJournal(spec.task.sessionId);
  proxyJournalRef = journal;
  await journal.seed();

  // 本地 TaskSupervisor:单一任务;onChange 镜像上行(终态)/驱动 wireAgentLoop。
  // 注入:TaskSupervisor.inject 原样入表(restore 会把非终态强翻 cancelled,且状态机禁 done→queued
 // 迁移——线上冒烟验证);随后 drain 走 queued→running 正常状态机触发 wireAgentLoop。
  const tm = new TaskSupervisor();
  ownTmRef = tm;
  let task: Task;
  try {
    task = tm.inject({ ...spec.task, state: "queued" as TaskState } as Task);
  } catch (err) {
    notify({ t: "task.state", taskId: spec.task.id, state: "failed", error: `worker 任务注入失败:${String(err).slice(0, 160)}` });
    process.exit(2);
  }
  // 本进程子代理注册表(agent-wiring 模块置位的 globalThis;scheduleExit 的存活判定读它)
  const bg = (globalThis as { __bgAgents?: Map<string, { outputFile: string; status: string; sessionId: string; title?: string; model?: string; lastEventAt?: number; deadlineAt?: number; spawnedAt?: number; cancel?: () => unknown }> }).__bgAgents;
  tm.onChange((t) => {
    notify({ t: "task.state", taskId: t.id, state: t.state, result: t.result });
    if (["done", "failed", "cancelled"].includes(t.state)) {
 // 终态落盘对账(晚间事故:gateway 消息处理被巨型会话轮询饿死 200s+,
      // worker 正常交稿 exit(0) 时在途 IPC 消息随通道关闭丢失→exit 收割把已完成任务误判
      // 「异常退出」。终态同时落盘,host 侧 exit/freeze 收割前回读——完成的就按完成记)。
      try {
        writeFileSync(
          join(root, ".genie", "session-workers", `${t.id}.terminal.json`),
          JSON.stringify({ taskId: t.id, state: t.state, result: String(t.result ?? "").slice(0, 128_000), at: Date.now(), pid: process.pid }),
          "utf-8",
        );
      } catch { /* 落盘失败不挡退出路径(uplink 仍是主通道) */ }
      scheduleExit();
    }
  });
 /** 退出策略( P0 修复;三轮复审 ① 补后台子代理):等 ①tm 空闲 ②终态收尾
   *  (distill/记忆学习/goal 判定)落定 ③本会话子代理全部终态——三者齐备才退。
   *  ZCode 铁律「父终态不终止子代理」:进程内模式后台子代理可跨任务存活,worker 必须等它们
   *  真终态;收尾悬挂仍走 180s 兜底,但子代理在跑时不强退(它们是真工作,不是悬挂)。 */
  function scheduleExit(): void {
    const t0 = Date.now();
    const timer = setInterval(() => {
      const idle = tm.list().every((t) => !["running", "queued", "blocked"].includes(t.state));
      const bgIdle = !bg || bg.size === 0 || [...bg.values()].every((en) => en.status !== "running");
      const hooksDone = postTerminalInflight(spec.task.sessionId) === 0 || Date.now() - t0 > 180_000;
      if (idle && bgIdle && hooksDone) {
        clearInterval(timer);
        setTimeout(() => process.exit(0), 150); // 尾批 journal flush 宽限
      }
    }, 500);
    timer.unref?.();
  }

  const projects = new ProjectRegistry(root, null); // 只读用(工作目录解析);写面在 gateway
  if (spec.projects) projects.restore(spec.projects.entries, spec.projects.activeProjectId); // P0:与网关同源,防 taskRoot 回落错根
  const memoryWiring = createMemoryWiring({
    root: join(root, ".genie", "memory"),
    llmCall: async ({ system, user }: { system: string; user: string }) => {
      // m1:记忆蒸馏/学习轨同跟随会话覆盖(压缩轨已派生;未配置=回退本任务主 llm)
      const res = await (models.compact ?? llm).chat([{ role: "system", content: system }, { role: "user", content: user }], []);
      return res.content;
    },
  });

 // R5( ready 超时注意):boot 曾硬等 mcp.tools IPC 往返——网关事件循环停顿时(索引重建
 // 压 9p,经验证 session.status 3-9s × 90s)这个 await 等不到应答,worker 30s ready 超时被判死。
  // 改 5s 竞速:等不到=无 MCP 工具降级启动(mcp 代理对缺工具本就 fail-visible),不把生死押在
  // 网关的响应能力上。
  const mcpTools = await Promise.race([
    request<{ serverId: string; serverName: string; name: string; description: string }[]>("mcp.tools", {}).catch(() => []),
    new Promise<[]>((resolve) => { setTimeout(() => resolve([]), 5_000).unref?.(); }),
  ]);
  wireAgentLoop(
    tm, journal, llm, executor, undefined, // nodes:远程节点表 gateway 权威,worker 不接(v1)
    models,
    undefined, projects,
    makePermissionProxy(spec.task.sessionId) as never,
    makeWfAskProxy() as never,
    makeAskUserProxy() as never,
    makeMcpProxy(mcpTools) as never,
    {
      enabled: () => spec.browser.enabled, allowDomains: () => spec.browser.allowDomains,
      ...(spec.browser.idleMinutes != null ? { idleMinutes: () => spec.browser.idleMinutes! } : {}),
      ...(spec.browser.profile ? { profile: () => spec.browser.profile! } : {}),
      ...(spec.browser.profileDir ? { profileDir: () => spec.browser.profileDir! } : {}),
      ...(spec.browser.headless != null ? { headless: () => spec.browser.headless! } : {}),
    },
    (sessionId, ev) => notify({ t: "stream", sessionId, ev }),
    memoryWiring as never,
    undefined, // auxLlm:gateway 的辅助轨实例不可跨进程;worker 内 wiring 回退主轨(与未配置同行为)
    config as never,
    contextWindow);

  // R4-2(四轮复审):远程节点任务在 worker 模式 fail-visible——nodes 表是网关权威,worker
  // 无表会静默跳过分派守卫(错执行位置);不假装已派,显式失败指路。
  if (spec.task.targetNode || (Array.isArray(spec.task.resourceTags) && spec.task.resourceTags.length > 0)) {
    notify({ t: "task.state", taskId: spec.task.id, state: "failed", error: "远程节点任务(targetNode/resourceTags)暂不支持会话 worker 模式:节点表与委派通道是网关权威。请去掉资源标签重派,或配置 agent.sessionWorker=false 走进程内模式。" });
    setTimeout(() => process.exit(2), 150);
    return;
  }

  reportStartupStage("loop-ready");
  notify({ t: "ready", pid: process.pid });
  // pid 登记(F5-3:sense-index 同款——gateway 崩溃后的孤儿判定/清扫描可对账;退出即清)
  try {
    mkdirSync(join(root, ".genie", "session-workers"), { recursive: true });
    writeFileSync(join(root, ".genie", "session-workers", `${spec.task.id}.run.json`), JSON.stringify({ pid: process.pid, startedAt: STARTED_AT, taskId: spec.task.id, sessionId: spec.task.sessionId, protocolVersion: SESSION_WORKER_PROTOCOL_VERSION }), "utf-8");
    process.on("exit", () => { try { rmSync(join(root, ".genie", "session-workers", `${spec.task.id}.run.json`), { force: true }); } catch { /* 尽力 */ } });
  } catch { /* 登记失败不影响运行 */ }
  await journal.catchUp(); // R4-1:种子→ready 窗口的 gateway 侧事件按水位补拉(键去重)
  tm.drain(); // 空表起步:queued → running(合法迁移),触发 wireAgentLoop 的 onChange

  // 子代理注册表镜像:bg(上方已声明)→ 2s 快照上行。
  const mirrorTimer = setInterval(() => {
    if (!bg || bg.size === 0) return;
    const entries: { agentId: string; outputFile: string; status: string; sessionId: string; title?: string; model?: string; lastEventAt?: number; deadlineAt?: number }[] = [];
    for (const [agentId, en] of bg) {
      entries.push({ agentId, outputFile: en.outputFile, status: en.status, sessionId: en.sessionId, title: en.title, model: en.model, lastEventAt: en.lastEventAt, deadlineAt: en.deadlineAt });
    }
    notify({ t: "subagent.mirror", entries });
  }, 2000);
  mirrorTimer.unref?.();
}

main().catch((err) => {
  console.error("[session-worker] 主流程异常", err);
  notify({ t: "task.state", taskId: "(unknown)", state: "failed", error: String(err).slice(0, 400) });
  process.exit(1);
});
