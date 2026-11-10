/**
 * 上下文构成归因。
 * 回答「上下文快满时到底是谁占的」:按固定 8 类把**本次请求**的输入拆开记账
 * (system 提示 / 工具定义 / 规则 / 技能清单 / MCP / 子代理定义 / 记忆 / 对话历史)。
 * 口径(硬约束):
 *  - chars = 文本/JSON 的**逐字长度**,不做推断(exact);tokens 一律 `rawTokens` 本地估算
 *    (source 恒为 "local_estimate",不乘 provider 标定系数、不读 provider usage)。
 *  - 总量与闸门只用 provider usage;本模块的 breakdown 只做展示,不参与任何 compact/闸门决策。
 *  - 零值语义:字段 undefined = 未配置(configured=false,chars/tokens=0);显式 ""/[] = 已配置的
 *    真实 0(configured=true,chars/tokens=0)——两者在表格里显示不同。
 *  - 本模块永不抛:非法输入退化为 0 值配置态。
 */
import { rawTokens } from "./token-estimate";

/** 固定 8 类(顺序即表格顺序)。 */
export const CONTEXT_BREAKDOWN_KEYS = [
  "system_prompt",
  "tool_definitions",
  "rules",
  "skills",
  "mcp",
  "subagent_definitions",
  "memory",
  "conversation",
] as const;

export type ContextBreakdownKey = (typeof CONTEXT_BREAKDOWN_KEYS)[number];

/** 人类可读标签(面板/CLI 共用;未配置时展示侧追加后缀)。 */
export const CONTEXT_BREAKDOWN_LABELS: Record<ContextBreakdownKey, string> = {
  system_prompt: "system 提示",
  tool_definitions: "工具定义",
  rules: "规则/AGENTS.md",
  skills: "技能清单",
  mcp: "MCP",
  subagent_definitions: "子代理定义",
  memory: "记忆",
  conversation: "对话历史",
};

export interface ContextBreakdownEntry {
  key: ContextBreakdownKey;
  label: string;
  /** 逐字字符数(exact)。 */
  chars: number;
  /** 本地分词器估算 token(rawTokens;非 provider 标定值)。 */
  tokens: number;
  /** tokens 的来源:本模块恒为 "local_estimate"(chars 始终 exact)。 */
  source: "exact" | "local_estimate";
  /** false = 调用方未提供该输入(区别于「提供了但为空」)。 */
  configured: boolean;
}

export interface ContextBreakdownInput {
  /** 送进 provider 的 system 全文。 */
  systemText?: string;
  rulesText?: string;
  skillsText?: string;
  mcpText?: string;
  subagentText?: string;
  memoryText?: string;
  /** 工具定义(按 JSON.stringify 计 chars/tokens)。 */
  toolDefs?: readonly unknown[];
  /** 对话消息(role/content/toolCalls/reasoning…;汇总进 conversation)。 */
  messages?: readonly unknown[];
}

export interface ContextBreakdown {
  entries: ContextBreakdownEntry[];
  total: { chars: number; tokensEstimate: number };
}

/** 安全 JSON 化:循环引用/异常一律退化为 ""(不抛)。 */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** 一条消息的文本投影(角色+内容+工具调用+思考;媒体按原始字符串长度计)。 */
function messageText(m: unknown): string {
  if (typeof m === "string") return m;
  if (!m || typeof m !== "object") return m === undefined || m === null ? "" : String(m);
  const o = m as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof o["role"] === "string") parts.push(o["role"]);
  if (typeof o["content"] === "string") parts.push(o["content"]);
  if (typeof o["toolCallId"] === "string") parts.push(o["toolCallId"]);
  if (typeof o["reasoning"] === "string") parts.push(o["reasoning"]);
  if (Array.isArray(o["toolCalls"])) {
    for (const c of o["toolCalls"]) {
      if (!c || typeof c !== "object") continue;
      const call = c as Record<string, unknown>;
      parts.push(String(call["name"] ?? ""), String(call["arguments"] ?? ""));
    }
  }
  if (Array.isArray(o["images"])) {
    for (const img of o["images"]) if (typeof img === "string") parts.push(img);
  }
  const audio = o["audio"];
  if (audio && typeof audio === "object" && typeof (audio as { data?: unknown }).data === "string") {
    parts.push(String((audio as { data: string }).data));
  }
  return parts.join("\n");
}

function textEntry(key: ContextBreakdownKey, text: string | undefined): ContextBreakdownEntry {
  const configured = text !== undefined;
  const chars = configured ? text.length : 0;
  return {
    key,
    label: CONTEXT_BREAKDOWN_LABELS[key],
    chars,
    tokens: configured ? rawTokens(text) : 0,
    source: "local_estimate",
    configured,
  };
}

function toolEntry(defs: readonly unknown[] | undefined): ContextBreakdownEntry {
  const configured = defs !== undefined;
  // 显式空数组 = 已配置的真实 0(不把 JSON "[]" 的 2 个字符算成占用)。
  const json = configured && defs.length > 0 ? safeJson(defs) : "";
  return {
    key: "tool_definitions",
    label: CONTEXT_BREAKDOWN_LABELS.tool_definitions,
    chars: json.length,
    tokens: configured ? rawTokens(json) : 0,
    source: "local_estimate",
    configured,
  };
}

function conversationEntry(messages: readonly unknown[] | undefined): ContextBreakdownEntry {
  const configured = messages !== undefined;
  let chars = 0;
  let tokens = 0;
  if (configured) {
    for (const m of messages) {
      const text = messageText(m);
      chars += text.length;
      tokens += rawTokens(text);
    }
  }
  return {
    key: "conversation",
    label: CONTEXT_BREAKDOWN_LABELS.conversation,
    chars,
    tokens,
    source: "local_estimate",
    configured,
  };
}

/** 8 类拆分(顺序固定)。 */
export function buildContextBreakdown(input: ContextBreakdownInput): ContextBreakdown {
  const safe: ContextBreakdownInput = input ?? {};
  const entries: ContextBreakdownEntry[] = [
    textEntry("system_prompt", safe.systemText),
    toolEntry(safe.toolDefs),
    textEntry("rules", safe.rulesText),
    textEntry("skills", safe.skillsText),
    textEntry("mcp", safe.mcpText),
    textEntry("subagent_definitions", safe.subagentText),
    textEntry("memory", safe.memoryText),
    conversationEntry(safe.messages),
  ];
  let chars = 0;
  let tokensEstimate = 0;
  for (const e of entries) {
    chars += e.chars;
    tokensEstimate += e.tokens;
  }
  return { entries, total: { chars, tokensEstimate } };
}

/** 显示宽度(CJK 全角按 2 列,便于终端表格对齐)。 */
function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

function padRight(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

function padLeft(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - displayWidth(text))) + text;
}

/**
 * 文本表(类别/字符/估算 tok/占比%)。占比按 tokens 计;全 0 时回退 chars;两者全 0 显示 "-"。
 * 未配置类别在标签后标「(未配置)」,与「已配置但为 0」区分。
 */
export function renderBreakdownTable(entries: readonly ContextBreakdownEntry[]): string {
  const totalTokens = entries.reduce((n, e) => n + e.tokens, 0);
  const totalChars = entries.reduce((n, e) => n + e.chars, 0);
  const pctOf = (e: ContextBreakdownEntry): string => {
    if (totalTokens > 0) return ((e.tokens / totalTokens) * 100).toFixed(1);
    if (totalChars > 0) return ((e.chars / totalChars) * 100).toFixed(1);
    return "-";
  };
  const rows: string[][] = [
    ["类别", "字符", "估算 tok", "占比%"],
    ...entries.map((e) => [
      e.configured ? e.label : `${e.label}(未配置)`,
      String(e.chars),
      String(e.tokens),
      pctOf(e),
    ]),
    ["合计", String(totalChars), String(totalTokens), totalTokens > 0 || totalChars > 0 ? "100.0" : "-"],
  ];
  const widths = [0, 0, 0, 0];
  for (const row of rows) {
    for (let i = 0; i < widths.length; i += 1) {
      widths[i] = Math.max(widths[i] ?? 0, displayWidth(row[i] ?? ""));
    }
  }
  return rows
    .map((row) =>
      [padRight(row[0] ?? "", widths[0] ?? 0), padLeft(row[1] ?? "", widths[1] ?? 0), padLeft(row[2] ?? "", widths[2] ?? 0), padLeft(row[3] ?? "", widths[3] ?? 0)].join("  "),
    )
    .join("\n");
}
