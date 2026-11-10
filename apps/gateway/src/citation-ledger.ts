/**
 * 研究引用账本(cite_source + 收尾引用校验。
 * 口径(机制 #169):研究稿里的 [n] 编号不许来自模型记忆——
 *  1) 编号只由 cite_source 工具给出:先在**本会话 journal** 里找到该 URL 的 web_fetch 调用与
 *     成功结果(非错误),否则拒绝登记(「先抓再引」);
 *  2) 每条登记必须附一段**逐字出现在抓取文本里**的引文(归一化空白后逐字比对,不做模糊、
 *     区分大小写),否则拒绝(引文是「这条编号确实来自这段文本」的凭据);
 *  3) 同一 taskId 内按登记顺序连续编号(n 从 1 起);同 url+quote 重复登记幂等返回原 n;
 *  4) 交付前收尾审计:正文出现的 [n] 必须在账本里(missing=未登记/越界);已登记但正文没引用
 *     只算 info(unused,不报警)。模型知识标 [unverified],不占编号。
 * 事件:`custom/citation.registered`(append-only,sourceToolCallId 指回抓取证据)与
 * `custom/citation.audit`(收尾结论,agent-wiring 落)。
 */
import type { Tool } from "@lampgenie/runtime/agent/loop";
import { isFailedToolResult } from "./verification-ledger.js";

export const CITE_SOURCE_TOOL_NAME = "cite_source";

/** journal 事件最小面(测试可直接喂普通对象)。 */
export interface CitationJournalEvent {
  kind: string;
  sessionId?: string;
  payload?: unknown;
  seq?: number;
  time?: number;
}

/** journal 面最小接口(测试注入假 journal);readSession 可选(缺席退化为 readAll 过滤)。 */
export interface CitationJournal {
  append(e: { kind: "custom"; sessionId: string; payload: Record<string, unknown>; idempotencyKey?: string }): unknown;
  readAll(): CitationJournalEvent[];
  readSession?(sessionId: string, fromSeq?: number): CitationJournalEvent[];
}

export interface CitationRecord {
  taskId: string;
  n: number;
  url: string;
  quote: string;
  title?: string;
  /** 证据:登记时命中的 web_fetch 调用 id(账本可回溯到抓取事件)。 */
  sourceToolCallId?: string;
  at: number;
  seq?: number;
}

export interface CitationAudit {
  /** 本任务已登记引用(按编号升序)。 */
  registered: CitationRecord[];
  /** 正文出现且已登记的编号(升序、去重)。 */
  cited: number[];
  /** 正文出现但账本没有的编号(未登记/越界),升序去重。 */
  missing: number[];
  /** 已登记但正文未引用(info,不报警)。 */
  unused: number[];
}

/** 引文长度闸(trim 后字符数)。 */
export const CITE_QUOTE_MIN = 10;
export const CITE_QUOTE_MAX = 500;

/** 归一化 URL:scheme/host 小写、去末尾斜杠、丢 hash;不可解析时退回原文去尾斜杠。 */
export function normalizeUrl(raw: string): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return s.replace(/\/+$/, "");
  }
}

/** 归一化空白:连续空白压成单空格并 trim(引文与抓取文本同一口径)。 */
export function normalizeWhitespace(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function payloadOf(e: CitationJournalEvent): Record<string, unknown> {
  return (e.payload && typeof e.payload === "object" ? e.payload : {}) as Record<string, unknown>;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 本 session 的事件(优先 readSession,缺省全量过滤)。 */
function sessionEvents(journal: CitationJournal, sessionId: string): CitationJournalEvent[] {
  if (typeof journal.readSession === "function") {
    try {
      return journal.readSession(sessionId, 0);
    } catch {
      /* 退回 readAll */
    }
  }
  return journal.readAll().filter((e) => e.sessionId === sessionId);
}

/** web_fetch 回执正文:JSON 时取 content 字段(静态抓取与 browser-render 兜底同形),否则原文。 */
export function extractFetchedText(content: unknown): string {
  const raw = typeof content === "string" ? content : String(content ?? "");
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const o = JSON.parse(trimmed) as { content?: unknown };
      if (typeof o.content === "string") return o.content;
    } catch {
      /* 非 JSON:按原文 */
    }
  }
  return raw;
}

/** 本会话里该 URL 最近一次成功的 web_fetch(调用 id + 抓取正文);没有 → null。 */
export function findFetchedText(
  events: readonly CitationJournalEvent[],
  url: string): { toolCallId: string; text: string; seq: number } | null {
  const target = normalizeUrl(url);
  if (!target) return null;
  const calls = new Set<string>();
  for (const e of events) {
    if (e.kind !== "tool.call") continue;
    const p = payloadOf(e);
    if (String(p.name ?? "") !== "web_fetch") continue;
    const id = String(p.toolCallId ?? "");
    if (!id) continue;
    const a = parseArgs(p.arguments);
    const callUrl = typeof a.url === "string" ? a.url : "";
    if (!callUrl || normalizeUrl(callUrl) !== target) continue;
    calls.add(id);
  }
  if (!calls.size) return null;
  let best: { toolCallId: string; text: string; seq: number } | null = null;
  for (const e of events) {
    if (e.kind !== "tool.result") continue;
    const p = payloadOf(e);
    const id = String(p.toolCallId ?? "");
    if (!calls.has(id)) continue;
    if (isFailedToolResult(p.content, p.error)) continue;
    const seq = Number(e.seq) || 0;
    if (best && seq < best.seq) continue;
    best = { toolCallId: id, text: extractFetchedText(p.content), seq };
  }
  return best;
}

/** 本任务已登记引用(按编号升序;同 n 只留首条)。 */
export function readCitations(journal: CitationJournal, sessionId: string, taskId: string): CitationRecord[] {
  const byN = new Map<number, CitationRecord>();
  for (const e of sessionEvents(journal, sessionId)) {
    if (e.kind !== "custom") continue;
    const p = payloadOf(e);
    if (String(p.type ?? "") !== "citation.registered") continue;
    if (String(p.taskId ?? "") !== taskId) continue;
    const n = Number(p.n);
    if (!Number.isFinite(n) || n <= 0 || byN.has(n)) continue;
    byN.set(n, {
      taskId,
      n,
      url: String(p.url ?? ""),
      quote: String(p.quote ?? ""),
      ...(typeof p.title === "string" && p.title ? { title: p.title } : {}),
      ...(typeof p.sourceToolCallId === "string" && p.sourceToolCallId ? { sourceToolCallId: p.sourceToolCallId } : {}),
      at: typeof p.at === "number" ? p.at : 0,
      ...(typeof e.seq === "number" ? { seq: e.seq } : {}),
    });
  }
  return [...byN.values()].sort((a, b) => a.n - b.n);
}

/** 正文引用审计:markers=[n];missing=出现但无登记(含越界),unused=登记未被引用(info)。 */
export function auditCitations(finalText: string, registered: readonly CitationRecord[]): CitationAudit {
  const nums = new Set<number>();
  for (const m of String(finalText ?? "").matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) nums.add(n);
  }
  const regNums = new Set(registered.map((r) => r.n));
  const cited = [...nums].filter((n) => regNums.has(n)).sort((a, b) => a - b);
  const missing = [...nums].filter((n) => !regNums.has(n)).sort((a, b) => a - b);
  const unused = [...regNums].filter((n) => !nums.has(n)).sort((a, b) => a - b);
  return { registered: [...registered].sort((a, b) => a.n - b.n), cited, missing, unused };
}

/**
 * 收尾审计作用域判据(收窄):coding 终稿里的 `[1]` 常是数组/脚注/编号,
 * 全类别审计会把它们当「未登记引用」误报。口径:agent 已明确用了账本(有登记)任何类别都审计;
 * office/qa 默认审计;指令命中研究/调研词也审计;其余(coding/普通任务)且无登记 → 不审计。
 */
export interface CitationScopeInput {
  taskClass?: string;
  instruction?: string;
  registeredCount?: number;
}

const CITATION_RESEARCH_HINTS = /研究|调研|调查|综述|文献|参考资料|论文|报告|白皮书|查一下|搜集|对比分析/;

export function shouldAuditCitations(input: CitationScopeInput): boolean {
  const registeredCount = Number(input?.registeredCount ?? 0);
  if (Number.isFinite(registeredCount) && registeredCount > 0) return true;
  const cls = String(input?.taskClass ?? "");
  if (cls === "office" || cls === "qa") return true;
  return CITATION_RESEARCH_HINTS.test(String(input?.instruction ?? ""));
}

/** 收尾警告(missing>0 才出;unused 不报警)。 */
export function renderCitationWarning(audit: CitationAudit): string {
  if (!audit.missing.length) return "";
  const nums = audit.missing.map((n) => `[${n}]`).join("");
  return `[引用账本] 正文引用 ${nums} 未登记/越界(账本只有 ${audit.registered.length} 条)——引用编号只能由 cite_source 返回,模型知识请标 [unverified]。`;
}

/** hard 模式补跑指令(runTurn 系统消息)。 */
export function renderCitationRetryPrompt(audit: CitationAudit): string {
  const nums = audit.missing.map((n) => `[${n}]`).join("");
  return `[引用账本补跑] 正文里的 ${nums} 没有登记来源。对每个编号对应的来源先 web_fetch 抓到正文,再 cite_source(url, quote=逐字出现在抓取文本里的片段) 拿正式编号;正文改用返回的 [n];没有检索证据的推断改写为模型知识并标 [unverified]。`;
}

export interface CiteSourceToolOptions {
  journal: CitationJournal;
  sessionId: string;
  taskId: string;
}

/** cite_source 工具:登记一个「已抓取 + 引文逐字可验」的来源,返回连续编号。 */
export function makeCiteSourceTool(opts: CiteSourceToolOptions): Tool {
  const { journal, sessionId, taskId } = opts;
  return {
    name: CITE_SOURCE_TOOL_NAME,
    description:
      "登记一条研究引用并拿到正文编号 [n]。参数:url(必填,http/https,必须先在本会话 web_fetch 抓过)、"
      + `quote(必填,${CITE_QUOTE_MIN}~${CITE_QUOTE_MAX} 字,必须逐字出现在该次抓取的正文里,区分大小写、可归一化空白)、title(可选)。`
      + "编号按本任务登记顺序从 1 连续分配;正文只许用本工具返回的 [n],没有检索证据的推断标 [unverified]。"
      + "未抓取/引文不匹配一律拒绝(编号不能来自记忆)。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "来源 URL(http/https;须本会话已 web_fetch 成功抓到)" },
        quote: { type: "string", description: `逐字引文(${CITE_QUOTE_MIN}~${CITE_QUOTE_MAX} 字;必须出现在抓取正文中,区分大小写)` },
        title: { type: "string", description: "来源标题(可选,便于正文出处行)" },
      },
      required: ["url", "quote"],
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async execute(args: unknown) {
      const a = (args ?? {}) as { url?: unknown; quote?: unknown; title?: unknown };
      const url = typeof a.url === "string" ? a.url.trim() : "";
      if (!url) return "错误: cite_source 需要 url";
      if (!/^https?:\/\//i.test(url)) return `错误: url 必须是 http(s):${url}`;
      const quote = typeof a.quote === "string" ? a.quote.trim() : "";
      if (!quote) return "错误: cite_source 需要 quote(逐字出现在抓取文本里的片段)";
      if (quote.length < CITE_QUOTE_MIN) return `错误: 引文过短(${quote.length} 字 < ${CITE_QUOTE_MIN})——请复制足以定位的原句`;
      if (quote.length > CITE_QUOTE_MAX) return `错误: 引文过长(${quote.length} 字 > ${CITE_QUOTE_MAX})——请缩短到一段原句`;

      const events = sessionEvents(journal, sessionId);
      const fetched = findFetchedText(events, url);
      if (!fetched) {
        return `错误: 未在本会话抓到该 URL(${url}),先 web_fetch 再 cite_source(编号不能来自记忆)`;
      }
      const nq = normalizeWhitespace(quote);
      const nt = normalizeWhitespace(fetched.text);
      if (!nt.includes(nq)) {
        return `错误: 引文未在抓取文本出现,请缩短/逐字复制(区分大小写;抓取正文 ${nt.length} 字、引文 ${nq.length} 字)。`;
      }

      const existing = readCitations(journal, sessionId, taskId);
      const urlKey = normalizeUrl(url);
      const dup = existing.find((r) => normalizeUrl(r.url) === urlKey && normalizeWhitespace(r.quote) === nq);
      if (dup) return `已登记引用 [${dup.n}] ${dup.url}(同一 url+引文重复登记,编号不变)`;

      const n = existing.reduce((m, r) => Math.max(m, r.n), 0) + 1;
      const title = typeof a.title === "string" ? a.title.trim().slice(0, 200) : "";
      const at = Date.now();
      try {
        journal.append({
          kind: "custom",
          sessionId,
          payload: {
            type: "citation.registered",
            taskId,
            n,
            url,
            quote,
            ...(title ? { title } : {}),
            sourceToolCallId: fetched.toolCallId,
            at,
          },
        });
      } catch {
        return `错误: 引用登记落 journal 失败([${n}] ${url})——重试一次;仍失败如实汇报。`;
      }
      return `已登记引用 [${n}] ${url}${title ? `(《${title}》)` : ""}——正文用 [${n}],别自行改号`;
    },
  };
}
