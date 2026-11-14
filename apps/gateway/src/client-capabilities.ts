/**
 *  能力暴露 allowlist(机制矩阵 #72)。
 * 现状问题(机制 #72「能力暴露 allowlist」):server.ts 的 WS 分发是
 * 一个 190 case 的巨型 switch——服务注册即对所有连接类型开放,denylist 漏一个就是越权;
 * 只读消费者(监控/看板)也能调写/终端;UI 隐藏但 RPC 仍可调。
 * 这里把「谁能调什么」收敛成三张显式白名单(不是 denylist):
 * - panel:  当前 switch 全部既有 channel(面板 legacy 消费者零变化;测试对拍 server.ts case 集合)
 * - readonly: 只读子集(监控/看板/外部只读观察者)
 * - agent:  task/session/permission 最小集(外部 agent 连接,无 cfg.set / git 写 / 终端 / 插件安装)
 * 两条硬规则:
 * 1. 表外 channel / 未知 type 一律拒(新 channel 默认拒绝,必须显式登记才算「已审阅能力」)。
 * 2. 高权限 channel 再走 per-method 判定(cfg.set 只允许白名单顶层键、git 写按档位)。
 */

export const CLIENT_MODES = ["panel", "readonly", "agent"] as const;
export type ClientMode = (typeof CLIENT_MODES)[number];
/** 未声明 mode 的连接=panel(legacy 消费者零变化)。 */
export const DEFAULT_CLIENT_MODE: ClientMode = "panel";

export function isClientMode(v: unknown): v is ClientMode {
  return typeof v === "string" && (CLIENT_MODES as readonly string[]).includes(v);
}

/** 引导/保活通道:三档连接都允许(client.mode 自身必须可自举,否则 readonly 连接无法降级;ping 保活)。 */
export const UNIVERSAL_CHANNELS: ReadonlySet<string> = new Set(["client.mode", "ping"]);

/**
 * panel = server.ts handleMessage 全部既有 case(显式列出,顺序与源码一致)。
 * 漏登记=面板功能静默 403,多登记=表外放行;两侧都由 client-capabilities.test.ts 解析源码对拍。
 */
export const PANEL_CHANNELS: readonly string[] = [
  "task.submit",
  "annotate.submit",
  "annotate.record",
  "voice.draft",
  "task.rename",
  "task.pin",
  "task.archive",
  "task.delete",
  "task.deleteSession",
  "archive.clear",
  "task.cancel",
  "task.resume",
  "task.schedule",
  "task.schedule.cancel",
  "queue.dispatch.now",
  "queue.remove",
  "task.list",
  "task.detail.get",
  "meeting.import",
  "meeting.schedule",
  "team.status",
  "teamai.pull",
  "teamai.push",
  "teamai.inspect",
  "teamai.contribute",
  "teamai.remove",
  "team.invite",
  "issue.list",
  "issue.create",
  "issue.update",
  "issue.comment",
  "issue.sync",
  "issue.confirm.dispatch",
  "team.p2p.status",
  "team.p2p.send",
  "permission.pending",
  "permission.history", // 关卡 Gate 历史面
  "task.group",
  "exp.distill",
  "checkpoint.list",
  "checkpoint.restore",
  "goal.set",
  "goal.get",
  "session.compact",
  "plan.approve",
  "task_output",
  "session.export",
  "trace.stats",
  "trace.query",
  "profile.file",
  "companion.turn",
  "super.turn",
  "companion.history",
  "super.history",
  "super.inbox",
  "session.status",
  "session.history",
  "dashboard.sessions",
  "dashboard.trends",
  "subagent.cancel",
  "session.fork",
  "node.register",
  "permission.respond",
  "git.commitmsg",
  "profile.get",
  "profile.rebuild",
  "profile.plan.upsert",
  "profile.plan.remove",
  "profile.plan.apply",
  "profile.sense.get",
  "plugins.list",
  "plugins.install",
  "plugins.uninstall",
  "plugins.toggle",
  "voice.tts",
  "voice.list",
  "voice.transcribe",
  "workers.list",
  "subagents.list",
  "track.view",
  "usage.view",
  "nodes.list",
  "node.exec",
  "wizard.gen",
  "agents.list",
  "skills.list",
  "skills.disableBuiltin",
  "commands.catalog",
  "commands.list",
  "commands.upsert",
  "commands.remove",
  "hooks.list",
  "hooks.upsert",
  "hooks.update",
  "hooks.remove",
  "mcp.list",
  "mcp.upsert",
  "mcp.update",
  "mcp.remove",
  "mcp.test",
  "memory.view",
  "term.exec",
  "term.cancel",
  "exp.disable",
  "checkpoint.preview",
  "checkpoint.rewind",
  "task.diffstat",
  "task.filediff",
  "models.probe",
  "stats.summary",
  "automation.list",
  "automation.create",
  "automation.update",
  "automation.delete",
  "automation.run",
  "ask.user.answer",
  "workflow.answer",
  "files.search",
  "session.search",
  "file.read",
  "file.write",
  "ide.office.edit",
  "git.status",
  "git.diff",
  "git.branches",
  "git.checkout",
  "git.commit",
  "git.log",
  "git.push",
  "git.pull",
  "ssh.key.import",
  "ssh.config.list",
  "ssh.test",
  "wsl.list",
  "wsl.test",
  "wsl.browse",
  "ssh.browse",
  "remote.ls",
  "remote.deploy",
  "remote.read",
  "project.add",
  "project.remove",
  "project.activate",
  "project.list",
  "project.rename",
  "fs.list",
  "fs.open",
  "fs.mkdir",
  "fs.remove",
  "fs.rename",
  "fs.grep",
  "lsp.diagnostics",
  "term.session.open",
  "term.session.send",
  "term.session.read",
  "term.session.close",
  "git.show",
  "node.task.result",
  "node.heartbeat",
  "sense.query",
  "wiki.list",
  "wiki.get",
  "wiki.rebuild",
  "review.store.get",
  "review.inject",
  "board.list",
  "board.archive.list",
  "browser.view.open",
  "browser.view.close",
  "browser.view.command",
  "client.surface",
  "board.get",
  "board.diagram",
  "board.save",
  "board.continue",
  "board.workflow.compile",
  "board.workflow.run",
  "board.overlay.save",
  "board.overlay.get",
  "board.comment",
  "board.fromcode",
  "board.fromsense",
  "exp.list",
  "exp.view",
  "exp.remove",
  "sys.meta",
  "cfg.get",
  "cfg.secret.status",
  "cfg.secret.set",
  "cfg.set",
  "models.list",
  "session.model.set",
  "session.model.get",
  "session.owner.get",
  "rsi.status",
  "rsi.mechanism.set",
  "rsi.mechanism.run",
  "rsi.item.update",
  "rsi.item.delete",
 // RSI-SELF-DRIVE:自动周期配置/快照/手动推一拍(写面,仅 panel)。
  "rsi.scheduler.get",
  "rsi.scheduler.set",
  "rsi.scheduler.run",
  "ping",
];

/**
 * readonly = 只读/观察面:列表/详情/统计/看板/日志/诊断。
 * 明确不含:task.submit(写)、task.cancel(控制)、cfg.set/cfg.secret.set(配置)、
 * file.write/fs.* 写、term.*(任意命令执行)、git.commit/push/pull/checkout(写)、
 * plugins.install、board.save/board.comment(写板)、browser.view.command(控制面板)。
 */
export const READONLY_CHANNELS: readonly string[] = [
  // 任务/会话观察
  "task.list",
  "task.detail.get",
  "task.diffstat",
  "task.filediff",
  "task_output",
  "session.status",
  "session.history",
  "session.search",
  "session.export",
  "session.model.get",
  "session.owner.get",
  // 统计/轨迹
  "trace.stats",
  "trace.query",
  "track.view",
  "usage.view",
  "stats.summary",
  "dashboard.sessions",
  "dashboard.trends",
  // git 只读
  "git.status",
  "git.diff",
  "git.branches",
  "git.log",
  "git.show",
  "git.commitmsg",
  // 资源/配置观察
  "models.list",
  "models.probe",
  "plugins.list",
  "cfg.get",
  "cfg.secret.status",
  "sys.meta",
  // 白板只读
  "board.list",
  "board.get",
  "board.diagram",
  "board.archive.list",
  "board.overlay.get",
  // 团队/经验/指挥台
  "team.status",
  "team.p2p.status",
  "exp.list",
  "exp.view",
  "super.inbox",
  "super.history",
  "companion.history",
  // 审批与权限观察(只读 pending 列表+最近决定,不能 respond)
  "permission.pending",
  "permission.history", // 关卡 Gate 历史面(只读)
  // 目录/代码感知只读
  "workers.list",
  "subagents.list",
  "nodes.list",
  "agents.list",
  "skills.list",
  "commands.catalog",
  "commands.list",
  "hooks.list",
  "mcp.list",
  "memory.view",
  "automation.list",
  "project.list",
  "fs.list",
  "fs.open",
  "fs.grep",
  "files.search",
  "lsp.diagnostics",
  "sense.query",
  "wiki.list",
  "wiki.get",
  "review.store.get",
  "checkpoint.list",
  "checkpoint.preview",
  "issue.list",
  "profile.get",
  "profile.sense.get",
  "profile.file",
  "ssh.config.list",
  "wsl.list",
  "ssh.browse",
  "wsl.browse",
  "remote.ls",
];

/**
 * agent = 外部 agent 连接最小集:task.* / session.* / permission.*(含 ask/workflow 应答)。
 * 不含:cfg.set、cfg.secret.set、git.commit/push/pull、term.*、file.write、plugins.*、
 * board.save、browser.view.command 等面板控制与高权限写面。
 */
export const AGENT_CHANNELS: readonly string[] = [
  // task.*(提交/控制/查询)
  "task.submit",
  "task.cancel",
  "task.resume",
  "task.rename",
  "task.pin",
  "task.archive",
  "task.delete",
  "task.deleteSession",
  "archive.clear",
  "task.list",
  "task.detail.get",
  "task.group",
  "task_output",
  "task.diffstat",
  "task.filediff",
  // session.*
  "session.status",
  "session.history",
  "session.search",
  "session.export",
  "session.compact",
  "session.fork",
  "session.model.get",
  "session.model.set",
  "session.owner.get",
  // permission.*(+ 对 agent 提问的应答)
  "permission.pending",
  "permission.respond",
  "ask.user.answer",
  "workflow.answer",
];

/** 每档的显式集合(UNIVERSAL 在所有档位上并集生效)。 */
export const CHANNEL_ALLOWLIST: Readonly<Record<ClientMode, ReadonlySet<string>>> = {
  panel: new Set(PANEL_CHANNELS),
  readonly: new Set(READONLY_CHANNELS),
  agent: new Set(AGENT_CHANNELS),
};

/**
 * cfg.set 允许的顶层键真源 = packages/core/src/config/schema.ts 的 ConfigSchema 顶层键
 * (测试对拍 schema,漂移即失败)。未知顶层键一律拒——面板设置页只写这些块。
 */
export const CFG_SET_TOP_LEVEL_KEYS: readonly string[] = [
  "gateway",
  "executor",
  "coding",
  "context",
  "audio",
  "providers",
  "tasks",
  "journal",
  "experience",
  "concurrency",
  "browser",
  "web",
  "permissions",
  "annotate",
  "agent",
];

const CFG_SET_KEY_SET: ReadonlySet<string> = new Set(CFG_SET_TOP_LEVEL_KEYS);

/** 高权限 channel 的 mode 分层:git 写只给 panel(readonly/agent 的表里本就没有,双保险)。 */
export const PANEL_ONLY_CHANNELS: ReadonlySet<string> = new Set([
  "git.commit",
  "git.push",
  "git.pull",
  "git.checkout",
]);

/**
 * channel 级判定:表内且 mode 合法才放行。
 * 未知 channel(表外)、未知 mode、"__proto__"/"constructor" 之类原型键一律 false。
 */
export function isChannelAllowed(mode: unknown, channel: unknown): boolean {
  if (!isClientMode(mode)) return false;
  if (typeof channel !== "string" || !channel) return false;
  if (UNIVERSAL_CHANNELS.has(channel)) return true;
  return CHANNEL_ALLOWLIST[mode].has(channel);
}

/**
 * per-method 判定(高权限 channel 二次校验);非高权限 channel 通过 channel 判定后即 true。
 * - cfg.set:patch 必须是普通对象,且每个顶层键都在 CFG_SET_TOP_LEVEL_KEYS 内(未知键拒)。
 * - git.commit/push/pull/checkout:仅 panel(PANEL_ONLY_CHANNELS)。
 */
export function isMethodAllowed(mode: unknown, channel: unknown, args?: unknown): boolean {
  if (!isChannelAllowed(mode, channel)) return false;
  const ch = channel as string;
  if (PANEL_ONLY_CHANNELS.has(ch)) return mode === "panel";
  if (ch === "cfg.set") {
    const patch = (args as { patch?: unknown } | null | undefined)?.patch;
    if (patch === undefined || patch === null) return false;
    if (typeof patch !== "object" || Array.isArray(patch)) return false;
    for (const key of Object.keys(patch as Record<string, unknown>)) {
      if (!CFG_SET_KEY_SET.has(key)) return false;
    }
    return true;
  }
  return true;
}
