/**
 * gateway 侧会话检索适配:journal 级单例索引 + `session_search` 工具。
 * 索引本体在 @lampgenie/runtime/session/search(纯 TS,不依赖 gateway)。
 * 单例按 Journal 对象隔离(WeakMap):同一 gateway 的 agent 工具与面板 WS 共用一份索引;
 * 测试临时 journal 不会串到生产实例。configure 只登记缓存路径,首次查询才构建。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Journal } from "@lampgenie/core";
import type { Tool } from "@lampgenie/runtime/agent/loop";
import { SessionSearchIndex } from "@lampgenie/runtime/session/search";
import { buildContextCapsule, budgetCapsule, renderCapsule } from "@lampgenie/runtime/session/context-capsule";
import { request, ProxyJournal } from "./session-worker-lib.js";

interface Entry {
  index: SessionSearchIndex | null;
  cacheFile?: string;
}

const registry = new WeakMap<Journal, Entry>();

/** 登记缓存位置(随 journalDir 隔离;不传=纯内存)。必须在首次查询前调用。 */
export function configureSessionSearch(journal: Journal, options: { cacheFile?: string } = {}): void {
  registry.set(journal, { index: null, ...(options.cacheFile ? { cacheFile: options.cacheFile } : {}) });
}

/** 取(或懒创建)该 journal 的会话检索索引。 */
export function getSessionSearchIndex(journal: Journal): SessionSearchIndex {
  let entry = registry.get(journal);
  if (!entry) {
    entry = { index: null };
    registry.set(journal, entry);
  }
  if (!entry.index) {
    entry.index = new SessionSearchIndex(journal, entry.cacheFile ? { cacheFile: entry.cacheFile } : {});
  }
  return entry.index;
}

/** 进程收尾:只关已创建的索引(没查过就不创建),flush 缓存并退订。 */
export function closeSessionSearch(journal: Journal): void {
  const entry = registry.get(journal);
  if (!entry?.index) return;
  entry.index.close();
  entry.index = null;
}

/** 供 createGatewayApp 使用的默认缓存路径(随 journalDir 走)。 */
export function defaultSessionSearchCacheFile(journalDir: string | undefined): string | undefined {
  return journalDir ? join(journalDir, "session-search-index.json") : undefined;
}

interface SessionSearchArgs {
  action?: "discover" | "scroll" | "read" | "capsule";
  query?: string;
  sessionId?: string;
  cursor?: string | number;
  seq?: number;
  fromSeq?: number;
  limit?: number;
  window?: number;
  after?: string | number;
  before?: string | number;
  source?: string;
  excludeSessionIds?: string[];
  includeCurrent?: boolean;
 /** capsule:优先保留与这些词相关的决策/文件/阻塞(可选)。 */
  focus?: string;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : fallback;
}

/** 模型偶尔把 seq/cursor 传成字符串:统一收成整数,非法=undefined。 */
function asInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/**
 * capsule 全文落盘目录:随 journalDir(缓存文件的父目录)隔离;无缓存文件时落系统 tmp。
 * 为什么落盘:摘要只有预算内的骨架,模型真要引用原文时凭 spill 指针回读,不必二次检索。
 */
function capsuleSpillDir(journal: Journal): string {
  const entry = registry.get(journal);
  const base = entry?.cacheFile ? dirname(entry.cacheFile) : tmpdir();
  return join(base, "capsules");
}

/** 写全文;失败返回 null(只丢指针,摘要照给)。 */
function writeCapsuleSpill(journal: Journal, sessionId: string, text: string): string | null {
  try {
    const dir = capsuleSpillDir(journal);
 // sessionId 可能来自模型/远端:文件名只留安全字符,绝不直接拼路径。
    const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "session";
    const file = join(dir, `${safe}-${Date.now()}.txt`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, text, { encoding: "utf8", mode: 0o600 });
    return file;
  } catch {
    return null;
  }
}

/**
 *  action=capsule:取该会话事件 → 构建胶囊 → 预算裁剪 → 全文写 spill → 返回 JSON。
 * gateway 工具路径与 session-worker-host 的 RPC 透传共用这一份实现,不复制两套逻辑。
 * 整段 fail-soft:任何异常都收敛成错误文本,不打断 agent loop。
 */
export function runSessionSearchCapsule(journal: Journal, args: { sessionId?: unknown; focus?: unknown }): string {
  const sessionId = String(args?.sessionId ?? "").trim();
  if (!sessionId) return "session_search 错误:capsule 需要 sessionId(可先用 action=discover 找)";
  try {
    const events = getSessionSearchIndex(journal).sessionEvents(sessionId, { limit: 5000 });
    const capsule = buildContextCapsule({
      sessionId,
      events,
      focus: typeof args?.focus === "string" ? args.focus : "",
    });
    const budgeted = budgetCapsule(capsule);
    const spill = writeCapsuleSpill(journal, sessionId, renderCapsule(capsule));
    return JSON.stringify({ sessionId, capsule: budgeted.text, omitted: budgeted.omitted, spill });
  } catch (err) {
    return `session_search 错误: ${String(err).slice(0, 200)}`;
  }
}

/**
 * `session_search` 工具(只读):discover / scroll / read / capsule。
 * 返回 JSON 文本;错误以「session_search 错误: …」文本返回(fail-soft,不打断 loop)。
 */
export function sessionSearchTool(journal: Journal, currentSessionId?: string): Tool {
  return {
    name: "session_search",
    description:
      "Full-text search and recall over session history: finds keywords in the journals of all past sessions (not content already visible in the current conversation). " +
      "Call it first when the user asks \"how did we fix that last time / before\". " +
      "action=discover: empty query = list of recent sessions; otherwise returns related sessions (sessionId/title/time/hit snippets/hit count); automated sessions are down-weighted, never hidden. " +
      "action=scroll: takes sessionId, plus query to page through hits inside that session (cursor = next page), or seq to see the window around one event. " +
      "action=read: takes sessionId + fromSeq (default from the start) + limit to page through raw session text. " +
      "action=capsule: takes sessionId and returns a budgeted summary (objective/decisions/files/blockers/nextStep) with per-source budget, two-stage trimming and an omitted count; the full untrimmed text is written to a spill file whose path is returned as `spill` (null if the write failed). " +
      "Typical flow: discover → best.seq → scroll(sessionId, seq) for context → read for more raw text. " +
      "sessionId values from the result can be reused in later tool calls or shown to the user.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["discover", "scroll", "read", "capsule"], description: "Default: discover" },
        query: { type: "string", description: "Keywords (any language or digits; space separates several keyword groups). With scroll = search inside the session; empty = browse recent sessions" },
        sessionId: { type: "string", description: "Session id (required for scroll/read/capsule; found in discover results)" },
        cursor: { type: "string", description: "Paging cursor for scroll (nextCursor from the previous page)" },
        seq: { type: "number", description: "scroll = event anchor (best.seq from discover); read = start fromSeq" },
        fromSeq: { type: "number", description: "read: starting seq (default 0 = from the beginning)" },
        limit: { type: "number", description: "Result count (defaults: discover 5, scroll 5, read 8; max 50)" },
        window: { type: "number", description: "Context window for scroll (N events before and after; default 2, max 10)" },
        after: { type: "string", description: "discover: lower time bound — ISO date or relative duration (7d/24h/2w)" },
        before: { type: "string", description: "discover: upper time bound (exclusive) — ISO date or relative duration" },
        source: { type: "string", description: "discover: filter by origin — user/automation/subagent/companion/system (comma separated)" },
        excludeSessionIds: { type: "array", items: { type: "string" }, description: "Session ids to exclude as already seen (max 50)" },
        includeCurrent: { type: "boolean", description: "discover: include the current session (default false — history recall looks at past sessions only)" },
        focus: { type: "string", description: "capsule: optional keywords; matching decisions/files/blockers are kept first" },
      },
      required: [],
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(args: unknown): Promise<string> {
      const a = (args ?? {}) as SessionSearchArgs;
      const action =
        a.action === "scroll" || a.action === "read" || a.action === "capsule" ? a.action : "discover";
 // session-worker 进程:ProxyJournal 只含本会话副本,历史会话全部不可见
 // (注意 stats docs=2/lastSeq=414263)。经既有 IPC RPC 代理到 gateway 真 journal 只读执行,
      // 零写冲突;host 缺席(单跑 worker 调试)=fail-soft 错误文本。
      if (journal instanceof ProxyJournal) {
        try {
          return await request<string>("session.search", { op: action, args: a, currentSessionId });
        } catch (err) {
          return `session_search 错误: ${String(err).slice(0, 200)}`;
        }
      }
      if (action === "capsule") return runSessionSearchCapsule(journal, a);
      try {
        const index = getSessionSearchIndex(journal);
        if (action === "scroll") {
          const sessionId = String(a.sessionId ?? "").trim();
          if (!sessionId) return "session_search 错误:scroll 需要 sessionId(可先用 action=discover 找)";
          const window = clampInt(a.window, 2, 0, 10);
          const seq = asInt(a.seq);
          const result = index.scroll(sessionId, {
            ...(a.query ? { query: String(a.query) } : {}),
            ...(a.cursor !== undefined ? { cursor: a.cursor } : {}),
            ...(seq !== undefined ? { seq } : {}),
            limit: clampInt(a.limit, 5, 1, 20),
            before: window,
            after: window,
          });
          return JSON.stringify(result);
        }
        if (action === "read") {
          const sessionId = String(a.sessionId ?? "").trim();
          if (!sessionId) return "session_search 错误:read 需要 sessionId(可先用 action=discover 找)";
          const fromSeq = asInt(a.fromSeq) ?? asInt(a.seq) ?? 0;
          const result = index.read(sessionId, { fromSeq, limit: clampInt(a.limit, 8, 1, 30) });
          return JSON.stringify(result);
        }
        const exclude = [...(Array.isArray(a.excludeSessionIds) ? a.excludeSessionIds : [])].filter(
          (id): id is string => typeof id === "string" && id.length > 0);
        if (currentSessionId && !a.includeCurrent) exclude.push(currentSessionId);
        const result = index.discover(String(a.query ?? ""), {
          limit: clampInt(a.limit, 5, 1, 20),
          ...(a.after !== undefined ? { after: a.after } : {}),
          ...(a.before !== undefined ? { before: a.before } : {}),
          ...(a.source ? { source: a.source } : {}),
          ...(exclude.length ? { excludeSessionIds: exclude } : {}),
        });
        return JSON.stringify(result);
      } catch (err) {
        return `session_search 错误: ${String(err).slice(0, 200)}`;
      }
    },
  };
}
