/**
 * 关键事实台账(facts ledger):压缩前从消息里确定性抽取「丢了会让 harness 变笨」的锚点。
 *
 * 设计边界:
 * - 只抽取,不生成。错误/堆栈、失败测试、path:line、关键命令/路径/pattern 用规则抓;
 *   叙事摘要仍交给 autoCompact 的摘要模型。
 * - 优先保错误:错误行先入账,再测试/路径/动作;跨类别按首次出现去重。
 * - 有硬上限(总字符/条数/单行长度),避免台账自己变成新的上下文膨胀源。
 * - 跳过 microcompact 生成的占位行(它们不是事实,只是折叠说明)。
 *
 * 用途:autoCompact 把它注入摘要提示与 compact.done,压缩后模型仍能看到逐字锚点;
 * 未来也可作为 shadow 语义打分的候选特征。
 */
import type { Message } from "./loop";

/** 台账总字符上限(占上下文预算的一小部分,不喧宾夺主)。 */
const MAX_TOTAL_CHARS = 3_000;
/** 单行上限(错误/路径通常短;超长行只保留前段)。 */
const MAX_LINE_CHARS = 240;
/** 各类别最多保留条数(错误优先给更多配额)。 */
const MAX_ERRORS = 16;
const MAX_TESTS = 8;
const MAX_PATHS = 10;
const MAX_ACTIONS = 6;

/** 错误/异常/失败信号;宁可多保(误判只会多留一条事实,不会丢)。 */
const ERROR_RE = /(?:Traceback \(most recent call last\)|^\s*E\s+|AssertionError|\b(?:Error|ERROR|FATAL|CRITICAL|PANIC)\b|\b[1-9]\d*\s+failed\b|\bexit code\s*[:=]?\s*[1-9]\d*|\bcommand failed\b|\bException\b)/i;
/** 测试结果锚点(失败优先,但通过行也保留少量用于「跑过什么」)。 */
const TEST_RE = /(?:\bFAILED\b|\bnot ok\b|\bPASSED\b|✗|×)/;
/** path:line / file:line:col;覆盖常见源码与配置后缀。 */
const PATH_RE = /\b(?:[A-Za-z]:)?[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|rs|rb|php|c|cc|cpp|h|hpp|md|json|ya?ml|toml|sql|sh):\d+\b/;

export interface FactsLedger {
  /** 可直接注入提示/落 journal 的台账文本;无事实时为空串。 */
  text: string;
  /** 实际入账行数(观测/测试用)。 */
  lineCount: number;
}

function clipLine(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > MAX_LINE_CHARS ? trimmed.slice(0, MAX_LINE_CHARS - 1) + "…" : trimmed;
}

function isMicrocompactPlaceholder(line: string): boolean {
  return line.startsWith("[工具结果已") || line.startsWith("[超大工具结果已外置:");
}

/** 从 assistant toolCalls 抽动作锚点:工具名 + command/path/pattern 等关键字。 */
function actionLine(call: { name: string; arguments: string }): string {
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(call.arguments);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    return call.name;
  }
  const keys = ["command", "path", "file_path", "pattern", "query", "target"];
  const parts: string[] = [];
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      parts.push(`${key}=${value.trim().slice(0, 120)}`);
    }
  }
  return parts.length > 0 ? `${call.name} ${parts.join(" ")}` : call.name;
}

/**
 * 构建事实台账。纯函数:同一批消息恒得同一结果,便于测试与 journal 复核。
 */
export function buildFactsLedger(messages: readonly Message[]): FactsLedger {
  const errors: string[] = [];
  const tests: string[] = [];
  const paths: string[] = [];
  const actions: string[] = [];
  const seen = new Set<string>();

  const add = (bucket: string[], raw: string): void => {
    const line = clipLine(raw);
    if (!line || isMicrocompactPlaceholder(line) || seen.has(line)) return;
    seen.add(line);
    bucket.push(line);
  };

  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls?.length) {
      for (const call of message.toolCalls) add(actions, actionLine(call));
    }
    const text = String(message.content ?? "");
    if (!text) continue;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || isMicrocompactPlaceholder(line)) continue;
      if (ERROR_RE.test(line)) add(errors, line);
      else if (TEST_RE.test(line)) add(tests, line);
      else if (PATH_RE.test(line)) add(paths, line);
    }
  }

  const sections: string[] = [];
  if (errors.length > 0) sections.push("[错误/异常]\n" + errors.slice(0, MAX_ERRORS).join("\n"));
  if (tests.length > 0) sections.push("[测试结果]\n" + tests.slice(0, MAX_TESTS).join("\n"));
  if (paths.length > 0) sections.push("[关键路径]\n" + paths.slice(0, MAX_PATHS).join("\n"));
  if (actions.length > 0) sections.push("[动作锚点]\n" + actions.slice(0, MAX_ACTIONS).join("\n"));

  let text = sections.join("\n\n");
  if (text.length > MAX_TOTAL_CHARS) {
    text = text.slice(0, MAX_TOTAL_CHARS - 16) + "\n…(台账截断)";
  }
  return { text, lineCount: sections.reduce((n, s) => n + s.split("\n").length - 1, 0) };
}
