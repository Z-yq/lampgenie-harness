/**
 * 提示词版本运行时消费侧(补齐 mechanisms.md #209「提示词覆盖治理」的运行面)。
 * 背景:此前 `.genie/rsi/prompts/book.json` 只有 store + 状态页读取,`systemForTaskClass` 永远返回
 * 常量 SYSTEM/SYSTEM_LITE——RSI/用户的提示词版本在真实运行里不生效。本模块提供**同步**解析
 * (任务开工时读一次小文件),由 app 装配注入 loop-support 的 provider。
 * 安全口径:
 * - 只认 revision > 1 的**显式覆盖**;revision 1 是 `dump-builtin-prompts` 当时的内置快照,
 * 系统提示常量早已演进,拿它覆盖等于把模型锁在旧提示词上(比不接更坏)。
 * - 空文本 / 超长(>200k 字符)/ 解析失败 / 文件损坏 → undefined(回退当前内置常量,不 throw)。
 * - 会话钉扎(v2:首次为某会话解析某 key 时,把当时的覆盖 revision 写进
 * `pins.json`(与 store 的 pinSession 同一份数据面);之后该会话即使跨多个任务/续跑,
 * 也按钉住的 revision 解析——中途保存的新版本从**下一个新会话**起生效,正在跑的会话不被切轴。
 * 只钉 revision>1 的覆盖:没有覆盖时走内置常量(编译期常量,进程内天然稳定,无需钉)。
 * pins 文件按会话数封顶(见 MAX_PROMPT_PIN_SESSIONS),主进程与 worker 并发写靠原子 rename;
 * 极端竞态最多丢一次「新会话首钉」,该会话下一次解析会补钉,不产生错误提示词。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { normalizePromptBook, resolve } from "@lampgenie/runtime/agent/prompt-version";
import { promptBookPath, promptPinsPath } from "./prompt-version-store.js";

/** 当前有内置常量的提示词 key(只有 coding 两档;qa/office 是常量拼接,不在此列)。 */
export type RuntimePromptKey = "system.coding" | "system.coding.lite";

/** 单条提示词覆盖的长度上限:超过视为异常(防把整个文件/日志误存成提示词)。 */
export const MAX_PROMPT_OVERRIDE_CHARS = 200_000;

/**
 * 同步解析一个 key 的生效覆盖文本。
 * 返回 undefined = 没有显式覆盖(调用方继续用内置常量)。
 * 纯读文件,无缓存:文件小(<1MB),每任务一次;用户保存后**下一次开工立即生效**。
 */
export function resolvePromptOverrideSync(root: string, key: RuntimePromptKey): string | undefined {
  const res = resolveCurrent(root, key);
  return res.text;
}

/** 钉扎文件里单个会话的形状(与 store 的 SessionPromptPins 同构;这里做宽松读)。 */
interface SessionPinRow {
  sessionId: string;
  createdAt: number;
  revisions: Record<string, number>;
}

/** pins.json 会话数封顶:防止长寿命数据根无限膨胀(每次新会话首钉都会整体重写该文件)。 */
export const MAX_PROMPT_PIN_SESSIONS = 500;

function saneOverrideText(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  if (text.trim() === "" || text.length > MAX_PROMPT_OVERRIDE_CHARS) return undefined;
  return text;
}

function readBookSync(root: string): unknown {
  try {
    return JSON.parse(readFileSync(promptBookPath(root), "utf8")) as unknown;
  } catch {
    return undefined; // 文件不存在/损坏:回退内置常量
  }
}

function resolveCurrent(root: string, key: RuntimePromptKey): { text?: string; revision?: number } {
  const raw = readBookSync(root);
  if (raw === undefined) return {};
  try {
    const book = normalizePromptBook(raw);
    const res = resolve(book, key);
 // 注意:成功码是 PROMPT_RESOLVED(codes 非空 ≠ 失败);只认 text 是否存在。
    if (typeof res.revision !== "number" || res.revision <= 1) return {}; // 只认显式覆盖
    const text = saneOverrideText(res.text);
    if (text === undefined) return {};
    return { text, revision: res.revision };
  } catch {
    return {};
  }
}

function readPinSessions(root: string): Map<string, SessionPinRow> {
  const out = new Map<string, SessionPinRow>();
  try {
    const raw = JSON.parse(readFileSync(promptPinsPath(root), "utf8")) as
      | { sessions?: Record<string, unknown> }
      | null;
    const sessions = raw?.sessions;
    if (!sessions || typeof sessions !== "object") return out;
    for (const [sid, value] of Object.entries(sessions)) {
      const item = (value ?? {}) as Partial<SessionPinRow>;
      if (!item.revisions || typeof item.revisions !== "object") continue;
      const revisions: Record<string, number> = {};
      for (const [k, rev] of Object.entries(item.revisions)) {
        if (typeof rev === "number" && Number.isFinite(rev)) revisions[k] = rev;
      }
      out.set(sid, {
        sessionId: sid,
        createdAt: typeof item.createdAt === "number" && Number.isFinite(item.createdAt) ? item.createdAt : 0,
        revisions,
      });
    }
  } catch {
 // 文件不存在/损坏:视为空钉扎表(首钉会整体重建)
  }
  return out;
}

/** 原子写 pins.json(与 store 同款 tmp+rename;失败静默——钉不住只是回到「读最新」,不是错误态)。 */
function writePinSessions(root: string, sessions: Map<string, SessionPinRow>): void {
  const file = promptPinsPath(root);
  const entries = [...sessions.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_PROMPT_PIN_SESSIONS);
  const pruned: Record<string, SessionPinRow> = {};
  for (const row of entries) pruned[row.sessionId] = row;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    writeFileSync(tmp, `${JSON.stringify({ schema: 1, sessions: pruned }, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
  } catch {
 // 写失败(只读盘/权限):不 throw,调用方继续用解析出的文本
  }
}

/** 按钉住的 revision 解析;revision 已被 prune/文本异常 → undefined(调用方回落 current)。 */
function resolvePinned(root: string, key: RuntimePromptKey, revision: number): string | undefined {
  const raw = readBookSync(root);
  if (raw === undefined) return undefined;
  try {
    const book = normalizePromptBook(raw);
    const res = resolve(book, key, { revision });
    if (res.revision !== revision) return undefined; // 钉住的版本已不存在(prune/换书)
    return saneOverrideText(res.text);
  } catch {
    return undefined;
  }
}

/**
 * 会话钉扎解析(v2):同会话同 key 永远拿到首次解析时的覆盖版本。
 * - 已钉且版本仍存在 → 按钉住 revision 返回(中途保存的新版不影响本会话);
 * - 未钉且当前有覆盖(revision>1)→ 返回文本并落钉;
 * - 无覆盖/坏书/钉住的版本已失效 → 回落 current 语义(与 resolvePromptOverrideSync 一致)。
 * sessionId 为空 → 直接读最新(兼容旧调用方)。
 */
export function resolvePromptForSessionSync(root: string, sessionId: string, key: RuntimePromptKey): string | undefined {
  const sid = String(sessionId ?? "").trim();
  if (sid === "") return resolvePromptOverrideSync(root, key);

  const sessions = readPinSessions(root);
  const pinned = sessions.get(sid);
  const pinnedRevision = pinned?.revisions[key];
  if (typeof pinnedRevision === "number" && pinnedRevision > 1) {
    const text = resolvePinned(root, key, pinnedRevision);
    if (text !== undefined) return text;
 // 钉住的版本失效:落到下方 current 逻辑并刷新钉(旧钉不留死轴)
  }

  const current = resolveCurrent(root, key);
  if (current.text === undefined || current.revision === undefined) return undefined;
  const row: SessionPinRow = pinned ?? { sessionId: sid, createdAt: Date.now(), revisions: {} };
  row.revisions[key] = current.revision;
  sessions.set(sid, row);
  writePinSessions(root, sessions); // 走到这里说明 book 可读且有覆盖,pins 写失败也只是回到「读最新」
  return current.text;
}
