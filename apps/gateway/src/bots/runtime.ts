/**
 * Bot 任务路由/终态回推。
 * 入站消息 → 会话映射(稳定 sessionId)→ taskManager.submit;任务进入终态后
 * 把 task.result 回推到原会话。命令:/help /status /stop /new。
 * 形态:
 * - 每个机器人一条长轮询(Telegram/微信)或零循环(飞书/Lark 走 webhook);
 * - 同一会话同时只跑一条任务(忙时提示 /stop);不同会话互不影响;
 * - allowUserIds 白名单(空=不限制,面板已提示风险);
 * - 平台重投按 messageId/文本+时间窗去重。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TERMINAL_STATES, type Journal, type Task } from "@lampgenie/core";
import type { BotProviderId } from "@lampgenie/protocol";
import type { ProjectRegistry } from "../projects.js";
import type { TaskSupervisor } from "../task-manager.js";
import { botSessionIdFor, type BotStore } from "./store.js";
import { botConversationKey, type BotAdapter, type BotConfig, type BotInboundMessage, type BotReplyTarget } from "./types.js";

interface TaskOrigin {
  botId: string;
  conversationKey: string;
  target: BotReplyTarget;
}

export interface BotRuntimeDeps {
  store: BotStore;
  taskManager: TaskSupervisor;
  projects: ProjectRegistry;
  journal: Journal;
  adapters: Record<BotProviderId, BotAdapter>;
  root: string;
  log?: (line: string) => void;
}

const DEDUPE_TTL_MS = 5 * 60_000;
const MAX_REPLY_CHARS: Record<BotProviderId, number> = {
  telegram: 3500,
  weixin: 1500,
  feishu: 6000,
  lark: 6000,
};

export class BotRuntime {
  private loops = new Map<string, AbortController>();
 /** 会话 → 当前任务 id。 */
  private active = new Map<string, string>();
 /** 任务 id → 回推目标。 */
  private origins = new Map<string, TaskOrigin>();
 /** 平台重投去重:key → 时间戳。 */
  private seen = new Map<string, number>();
  private epochs: Record<string, number> | undefined;
  private readonly stateFile: string;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: BotRuntimeDeps) {
    this.log = deps.log ?? ((line) => console.error(line));
    this.stateFile = join(deps.root, ".genie", "bots-state.json");
    deps.taskManager.onChange((task) => {
      if (TERMINAL_STATES.has(task.state)) void this.onTerminal(task);
    });
  }

 /** 启动所有启用机器人的收消息循环(重复调用先停后起)。 */
  start(): void {
    this.stop();
    for (const bot of this.deps.store.list()) {
      if (!bot.enabled) continue;
      const adapter = this.deps.adapters[bot.provider];
      if (!adapter?.start) continue;
      const ac = new AbortController();
      this.loops.set(bot.id, ac);
      try {
        adapter.start(
          bot,
          this.deps.store.secretsOf(bot),
          (msg) => { void this.handleInbound(bot.id, msg); },
          ac.signal,
        );
      } catch (err) {
        this.loops.delete(bot.id);
        this.markError(bot.id, err);
      }
    }
  }

  stop(): void {
    for (const ac of this.loops.values()) ac.abort();
    this.loops.clear();
  }

  async reload(): Promise<void> {
    this.start();
  }

 /** webhook 类渠道(飞书/Lark)也走同一入口。 */
  async handleInbound(botId: string, msg: BotInboundMessage): Promise<void> {
    const bot = this.deps.store.get(botId);
    if (!bot || !bot.enabled) return;
    const text = String(msg.text ?? "").trim();
    if (!text) return;
    const allow = bot.allowUserIds ?? [];
    if (allow.length > 0 && !allow.includes(msg.userId)) {
      this.log(`[bots] 拒绝非白名单用户 bot=${bot.id} user=${msg.userId.slice(0, 40)}`);
      return;
    }
    if (this.isDuplicate(bot.id, msg, text)) return;
    const target: BotReplyTarget = {
      userId: msg.userId,
      chatType: msg.chatType,
      ...(msg.chatId ? { chatId: msg.chatId } : {}),
      ...(msg.contextToken ? { contextToken: msg.contextToken } : {}),
    };
    const conversationKey = botConversationKey(bot.id, msg);
    if (text.startsWith("/")) {
      await this.handleCommand(bot, conversationKey, target, text);
      return;
    }
    const activeId = this.active.get(conversationKey);
    if (activeId) {
      const cur = this.deps.taskManager.get(activeId);
      if (cur && !TERMINAL_STATES.has(cur.state)) {
        await this.send(bot, target, `上一条任务还在执行(${cur.state},${shortId(cur.id)})。完成后会回复;发送 /stop 可取消。`);
        return;
      }
      this.active.delete(conversationKey);
    }
    const sessionId = this.sessionOf(conversationKey);
    const projectId = this.projectOf(bot);
    const firstLine = text.split("\n")[0]!.replace(/\s+/g, " ").slice(0, 40);
    let task: Task;
    try {
      task = this.deps.taskManager.submit("user", sessionId, text, {
        ...(projectId ? { projectId } : {}),
        title: `[${bot.name}] ${firstLine}`,
        submittedBy: "bot",
      });
    } catch (err) {
      await this.send(bot, target, `提交任务失败:${String((err as Error)?.message || err).slice(0, 200)}`);
      return;
    }
    this.active.set(conversationKey, task.id);
    this.origins.set(task.id, { botId: bot.id, conversationKey, target });
    this.log(`[bots] 入站 bot=${bot.id} provider=${bot.provider} task=${task.id} session=${sessionId}`);
    await this.send(bot, target, `已收到,开始执行(${shortId(task.id)})。完成后我会把结果发回来;发送 /status 看进度,/stop 取消。`);
  }

  private async handleCommand(bot: BotConfig, conversationKey: string, target: BotReplyTarget, raw: string): Promise<void> {
    const [cmdRaw, ...rest] = raw.split(/\s+/);
    const cmd = (cmdRaw ?? "").toLowerCase();
    if (cmd === "/help" || cmd === "/start" || cmd === "/?") {
      await this.send(bot, target, [
        `我是 ${bot.name},可以远程驱动 Genie 工作区。`,
        "直接发一段任务描述即可;命令:",
        "/status  查看当前任务",
        "/stop    取消当前任务",
        "/new     开启新会话(上下文重新开始)",
        "/help    显示本帮助",
      ].join("\n"));
      return;
    }
    if (cmd === "/status") {
      const taskId = this.active.get(conversationKey);
      const task = taskId ? this.deps.taskManager.get(taskId) : undefined;
      if (!task) {
        await this.send(bot, target, "当前没有执行中的任务。直接发任务描述即可。");
        return;
      }
      const elapsed = Math.max(0, Date.now() - (task.startedAt ?? task.createdAt));
      await this.send(bot, target, [
        `任务 ${shortId(task.id)} · ${task.state}`,
        `标题:${task.title ?? task.instruction.slice(0, 60)}`,
        `已运行:${Math.round(elapsed / 1000)}s`,
      ].join("\n"));
      return;
    }
    if (cmd === "/stop") {
      const taskId = this.active.get(conversationKey);
      const task = taskId ? this.deps.taskManager.get(taskId) : undefined;
      if (!task || TERMINAL_STATES.has(task.state)) {
        this.active.delete(conversationKey);
        await this.send(bot, target, "当前没有可取消的任务。");
        return;
      }
      this.deps.taskManager.setState(task, "cancelled", "用户通过 Bot 停止");
 // 终态回推由 onTerminal 统一发,避免双消息。
      return;
    }
    if (cmd === "/new") {
      const key = conversationKey;
      const next = (this.epochsOf()[key] ?? 0) + 1;
      this.epochsOf()[key] = next;
      this.persistEpochs();
      this.active.delete(key);
      await this.send(bot, target, `已开启新会话(${botSessionIdFor(key, next).slice(0, 10)}…),上下文重新开始。`);
      return;
    }
    const extra = rest.join(" ").trim();
    await this.send(bot, target, `未知命令 ${cmd}。发 /help 查看可用命令${extra ? "" : ""}。`);
  }

  private async onTerminal(task: Task): Promise<void> {
    const origin = this.origins.get(task.id);
    if (!origin) return;
    this.origins.delete(task.id);
    if (this.active.get(origin.conversationKey) === task.id) this.active.delete(origin.conversationKey);
    const bot = this.deps.store.get(origin.botId);
    if (!bot) return;
    const head = task.state === "done" ? "【完成】" : task.state === "cancelled" ? "【已停止】" : "【失败】";
    const title = task.title ?? task.instruction.split("\n")[0]!.slice(0, 60);
    const body = String(task.result ?? "").trim() || (task.state === "done" ? "任务已完成(无文本结果)。" : "任务未成功完成。");
    await this.send(bot, origin.target, `${head}${title}\n\n${body}`);
  }

  private async send(bot: BotConfig, target: BotReplyTarget, text: string): Promise<void> {
    const adapter = this.deps.adapters[bot.provider];
    if (!adapter) return;
    const limit = MAX_REPLY_CHARS[bot.provider] ?? 3000;
    const clipped = text.length > limit ? text.slice(0, limit) + "\n…(已截断,完整结果见桌面面板)" : text;
    try {
      await adapter.send(bot, this.deps.store.secretsOf(bot), target, clipped);
      this.deps.store.patchRuntime(bot.id, { lastError: null });
    } catch (err) {
      this.markError(bot.id, err);
    }
  }

  private markError(botId: string, err: unknown): void {
    const msg = String((err as Error)?.message || err).slice(0, 300);
    this.log(`[bots] bot=${botId} 运行错误:${msg}`);
    try {
      this.deps.store.patchRuntime(botId, { lastError: msg });
    } catch { /* 配置写失败不影响主链 */ }
  }

  private projectOf(bot: BotConfig): string | undefined {
    if (!bot.projectId) return undefined;
    const hit = this.deps.projects.list().some((p) => p.id === bot.projectId && p.availability === "available");
    if (!hit) {
      this.log(`[bots] bot=${bot.id} 配置的项目 ${bot.projectId} 不可用,回退当前激活项目`);
      return undefined;
    }
    return bot.projectId;
  }

  private sessionOf(conversationKey: string): string {
    return botSessionIdFor(conversationKey, this.epochsOf()[conversationKey] ?? 0);
  }

  private isDuplicate(botId: string, msg: BotInboundMessage, text: string): boolean {
    const now = Date.now();
    for (const [k, t] of this.seen) if (now - t > DEDUPE_TTL_MS) this.seen.delete(k);
    const rawKey = msg.messageId
      ? `${botId}:${msg.messageId}`
      : `${botId}:${msg.chatId ?? msg.userId}:${createHash("sha1").update(text).digest("hex").slice(0, 12)}`;
    const prev = this.seen.get(rawKey);
    if (prev !== undefined && now - prev < DEDUPE_TTL_MS) return true;
    this.seen.set(rawKey, now);
    if (this.seen.size > 1000) {
      const oldest = [...this.seen.entries()].sort((a, b) => a[1] - b[1]).slice(0, 200);
      for (const [k] of oldest) this.seen.delete(k);
    }
    return false;
  }

  private epochsOf(): Record<string, number> {
    if (this.epochs) return this.epochs;
    this.epochs = {};
    try {
      if (existsSync(this.stateFile)) {
        const parsed = JSON.parse(readFileSync(this.stateFile, "utf-8")) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof v === "number" && Number.isFinite(v) && v >= 0) this.epochs[k] = v;
          }
        }
      }
    } catch { /* 坏状态文件=从零开始 */ }
    return this.epochs;
  }

  private persistEpochs(): void {
    try {
      const dir = dirname(this.stateFile);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = this.stateFile + ".tmp-" + Date.now();
      writeFileSync(tmp, JSON.stringify(this.epochsOf(), null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
      renameSync(tmp, this.stateFile);
    } catch (err) {
      this.log(`[bots] 会话状态落盘失败:${String((err as Error)?.message || err).slice(0, 200)}`);
    }
  }
}

function shortId(id: string): string {
  return id.slice(0, 8);
}