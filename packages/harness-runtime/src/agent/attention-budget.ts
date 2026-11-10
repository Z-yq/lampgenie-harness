/**
 * M183 注意力预算与静默优先(机制矩阵 #183 missing)。
 *
 * 能替团队干活的 agent 也能浪费整个团队注意力:每条外发消息(确认/聊天/路由 note/
 * 跨 ticket note/提问)都在消耗注意力,噪声还会用更多消息解释。本模块给外发消息定四条
 * 硬约束:①必须有用途(confirm/result/decision/blocked)②硬长度上限(词口径)③提问必须
 * 结构化且一次只问一个具体问题④同文在窗口内不重复外发。
 *
 * 词口径:CJK 字符每字 1 词;拉丁/数字按空白切分,每个连续片段 1 词(数字串同样 1 词)。
 * 这是注意力口径而非 token 口径——中文一行字比一个英文单词更贵,不能按字符数一刀切。
 *
 * 纯函数 + 进程内去重表(可注入 now),不读写 journal/文件,便于直测与接线。
 */

/** 外发消息的用途:每条消息必须能回答「它替谁做了什么」。 */
export type OutboundPurpose = "confirm" | "result" | "decision" | "blocked";

/** 外发消息形态(决定长度预算)。 */
export type OutboundKind = "confirm" | "chat" | "route-note" | "cross-ticket-note" | "ask";

/** 各形态硬长度上限(词)。confirm 记为「1 句」,落地为 40 词硬上限。 */
export const OUTBOUND_WORD_LIMITS: Readonly<Record<OutboundKind, number>> = {
  confirm: 40,
  chat: 100,
  "route-note": 30,
  "cross-ticket-note": 100,
  ask: 120,
};

/** 去重窗口缺省 10 分钟。 */
export const DEFAULT_DEDUPE_WINDOW_MS = 10 * 60_000;

/** 提问的结构化要素上限。 */
export const ASK_WORD_LIMIT = OUTBOUND_WORD_LIMITS.ask;

const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u;
const WORDISH = /[\p{L}\p{N}]/u;

/** 词口径计数:CJK 每字 1 词;拉丁/数字按空白切,每片段 1 词。 */
export function countWords(text: string): number {
  const s = String(text ?? "");
  let words = 0;
  let run = "";
  const flushRun = () => {
    if (run && WORDISH.test(run)) words++;
    run = "";
  };
  for (const ch of s) {
    if (CJK_CHAR.test(ch)) {
      flushRun();
      words++;
    } else if (/\s/.test(ch)) {
      flushRun();
    } else {
      run += ch;
    }
  }
  flushRun();
  return words;
}

/** 按词口径截断到 limit 词并补省略号;未超预算原样返回(不静默丢内容,也不无谓改写)。 */
export function truncateToBudget(text: string, kind: OutboundKind): string {
  return truncateToWords(text, OUTBOUND_WORD_LIMITS[kind]);
}

/** 显式 limit 版(提问等动态预算用);limit<=0 → 只留省略号。 */
export function truncateToWords(text: string, limit: number): string {
  const s = String(text ?? "");
  if (countWords(s) <= limit) return s;
  if (!(limit > 0)) return "…";
  const chars = Array.from(s);
  let words = 0;
  let lastGood = 0;
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i]!;
    if (CJK_CHAR.test(ch)) {
      words++;
      i++;
      if (words <= limit) lastGood = i;
      else break;
    } else if (/\s/.test(ch)) {
      i++;
      if (words <= limit) lastGood = i;
    } else {
      let j = i;
      while (j < chars.length && !CJK_CHAR.test(chars[j]!) && !/\s/.test(chars[j]!)) j++;
      const run = chars.slice(i, j).join("");
      const has = WORDISH.test(run);
      i = j;
      if (has) {
        words++;
        if (words <= limit) lastGood = j;
        else break;
      } else if (words <= limit) {
        lastGood = j;
      }
    }
  }
  return chars.slice(0, lastGood).join("").trimEnd() + "…";
}

/** 规范化文本:折白、去首尾空白、小写(去重与 hash 共用口径)。 */
export function normalizeOutboundText(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** FNV-1a 32 位,十六进制。只为去重键服务,不做密码学安全承诺。 */
export function hashOutboundText(text: string): string {
  const s = normalizeOutboundText(text);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ── 去重:进程内 Map(normalized hash → 上次通过时间)──
const dedupeState = new Map<string, number>();

/** 单测隔离用:清空进程内去重表(生产路径不调用)。 */
export function resetAttentionDedupe(): void {
  dedupeState.clear();
}

export interface ValidateOutboundInput {
  kind: OutboundKind;
  purpose?: OutboundPurpose | string;
  text: string;
  /** 与 text 同属一条外发消息的附带问题(计入词数与空检查)。 */
  questions?: string[];
  /** 显式去重键覆盖(缺省=规范化 text 的 hash)。 */
  key?: string;
  /** 去重窗口毫秒;<=0 = 关闭去重(路由 note 之类不该跨请求去重)。 */
  windowMs?: number;
  /** 可注入时钟(单测用)。 */
  now?: number;
}

export type OutboundErrorCode =
  | "OUTBOUND_NO_PURPOSE"
  | "OUTBOUND_EMPTY"
  | "OUTBOUND_TOO_LONG"
  | "OUTBOUND_DUPLICATE"
  | "OUTBOUND_UNKNOWN_KIND";

export type ValidateOutboundResult =
  | { ok: true; words: number; text: string }
  | { ok: false; code: OutboundErrorCode; words?: number; limit?: number; truncated?: string };

const PURPOSES: ReadonlySet<string> = new Set(["confirm", "result", "decision", "blocked"]);
const KINDS: ReadonlySet<string> = new Set(["confirm", "chat", "route-note", "cross-ticket-note", "ask"]);

/** 外发消息四门:有用途 / 非空 / 不超预算 / 窗口内不重复。 */
export function validateOutbound(input: ValidateOutboundInput): ValidateOutboundResult {
  const kind = String(input.kind ?? "");
  if (!KINDS.has(kind)) return { ok: false, code: "OUTBOUND_UNKNOWN_KIND" };
  const k = kind as OutboundKind;
  const purpose = String(input.purpose ?? "").trim();
  if (!purpose || !PURPOSES.has(purpose)) return { ok: false, code: "OUTBOUND_NO_PURPOSE" };
  const body = String(input.text ?? "");
  const fullText = input.questions?.length ? [body, ...input.questions.map(String)].join("\n") : body;
  if (!fullText.trim()) return { ok: false, code: "OUTBOUND_EMPTY" };
  const words = countWords(fullText);
  const limit = OUTBOUND_WORD_LIMITS[k];
  if (words > limit) {
    return { ok: false, code: "OUTBOUND_TOO_LONG", words, limit, truncated: truncateToWords(fullText, limit) };
  }
  const windowMs = input.windowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
  const now = input.now ?? Date.now();
  const key = input.key ?? hashOutboundText(fullText);
  const last = dedupeState.get(key);
  if (windowMs > 0 && last !== undefined && now - last < windowMs) {
    return { ok: false, code: "OUTBOUND_DUPLICATE", words };
  }
  if (windowMs > 0) dedupeState.set(key, now);
  return { ok: true, words, text: fullText };
}

// ── 结构化提问:恰好一个问号 + 编号选项或「字段:」填空 + 不超 120 词 ──

export type QuestionErrorCode = "OUTBOUND_EMPTY" | "ASK_MULTIPLE_QUESTIONS" | "ASK_NOT_STRUCTURED" | "OUTBOUND_TOO_LONG";

export type ValidateQuestionResult =
  | { ok: true; words: number }
  | { ok: false; code: QuestionErrorCode; words?: number; limit?: number; truncated?: string };

/** 结构化判据:编号选项(1. / A. / 「选项」字样)或「字段:」填空之一。 */
export function looksStructured(text: string): boolean {
  const s = String(text ?? "");
  if (/(^|\s|[（(])(?:\d{1,2}[.、)）]|[A-Za-z][.、)）])(\s|$|[（(])/m.test(s)) return true;
  if (/选项/.test(s)) return true;
  if (/^.{0,24}[：:]\s*\S/m.test(s)) return true;
  return false;
}

/** 提问校验:一次只问一个具体问题,且问题本身给出回答的形状。
 *  问号数量必须恰好为 1:0 个(不是问题)与 ≥2 个(多问题)同码拒绝。 */
export function validateStructuredQuestion(question: string): ValidateQuestionResult {
  const q = String(question ?? "");
  if (!q.trim()) return { ok: false, code: "OUTBOUND_EMPTY" };
  const marks = (q.match(/[?？]/g) ?? []).length;
  if (marks !== 1) return { ok: false, code: "ASK_MULTIPLE_QUESTIONS", words: countWords(q) };
  if (!looksStructured(q)) return { ok: false, code: "ASK_NOT_STRUCTURED", words: countWords(q) };
  const words = countWords(q);
  if (words > ASK_WORD_LIMIT) {
    return { ok: false, code: "OUTBOUND_TOO_LONG", words, limit: ASK_WORD_LIMIT, truncated: truncateToWords(q, ASK_WORD_LIMIT) };
  }
  return { ok: true, words };
}

// ── 接线用薄包装(纯函数,gateway 只做「调用 + 落 journal」)──

export interface AskUserPayloadLike {
  question: string;
  options?: string[];
  context?: string;
}

export type GuardedAsk =
  | { ok: true; words: number; question: string; options?: string[]; context?: string }
  | { ok: false; code: string; message: string };

/** ask_user 入口门:结构化 + 用途 decision。把 options 编号并入校验文本——
 *  工具本就把 options 作为结构化选择项,不该因为 question 句子里没写「1.」而误杀。 */
export function guardAskUserPayload(payload: AskUserPayloadLike): GuardedAsk {
  const question = String(payload.question ?? "");
  const options = payload.options?.map(String);
  const structuredText = options?.length
    ? question + "\n" + options.map((o, i) => `${i + 1}. ${o}`).join("\n")
    : question;
  const q = validateStructuredQuestion(structuredText);
  if (!q.ok) return { ok: false, code: q.code, message: askHint(q.code) };
  const o = validateOutbound({ kind: "ask", purpose: "decision", text: structuredText });
  if (!o.ok) return { ok: false, code: o.code, message: askHint(o.code) };
  return {
    ok: true,
    words: o.words,
    question,
    ...(options?.length ? { options } : {}),
    ...(payload.context ? { context: String(payload.context) } : {}),
  };
}

function askHint(code: string): string {
  return `错误:${code}——一次只问一个具体问题,给编号选项或字段填空`;
}

export interface GuardedText {
  text: string;
  blocked?: { code: string; kind: string; words: number };
}

/** 路由 note(父代答子代理的 reason / 路由备注)门:有界 30 词,超长截断,不拦任务。 */
export function guardRouteNote(note: string): GuardedText {
  const text = String(note ?? "");
  if (!text.trim()) return { text };
  const v = validateOutbound({ kind: "route-note", purpose: "decision", text, windowMs: 0 });
  if (v.ok) return { text };
  if (v.code === "OUTBOUND_TOO_LONG" && v.truncated) {
    return { text: v.truncated, blocked: { code: v.code, kind: "route-note", words: v.words ?? countWords(text) } };
  }
  return { text, blocked: { code: v.code, kind: "route-note", words: v.words ?? countWords(text) } };
}

/** 终端交付文案门:标记 purpose=result,按 chat 预算校验;超长截断但绝不拦任务。 */
export function guardTerminalNotice(summary: string | undefined): GuardedText {
  const text = String(summary ?? "");
  if (!text.trim()) return { text };
  const v = validateOutbound({ kind: "chat", purpose: "result", text });
  if (v.ok) return { text };
  if (v.code === "OUTBOUND_TOO_LONG" && v.truncated) {
    return { text: v.truncated, blocked: { code: v.code, kind: "chat", words: v.words ?? countWords(text) } };
  }
  return { text, blocked: { code: v.code, kind: "chat", words: v.words ?? countWords(text) } };
}
