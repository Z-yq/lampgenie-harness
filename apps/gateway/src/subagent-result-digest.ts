/**
 * 子代理终态「可投递正文」摘要(2026-10-30):此前终态通知只有 300 字摘要 + 指针
 * (task_output agentId=…),主 agent 必然再发一次请求取正文——每次子代理完成额外吃一次
 * 完整 LLM 往返。本模块把 output.txt 的正文(最后一个 [result ...] 段之后)直接塞进
 * message.system,主模型下一 step 即读到结果本体;指针只在「正文被截断/为空」时补。
 *
 * 三个旋钮(全部 env 可调,非法值一律退缺省):
 *  - GENIE_SUBAGENT_INJECT_MAX(缺省 4000;0=关闭注入 → 退化旧行为「摘要+指针」)
 *  - GENIE_SUBAGENT_INJECT_BATCH_MAX(缺省 8000;单条 message.system 的正文总上限)
 *  - GENIE_SUBAGENT_INJECT_MERGE_MS(缺省 500;0=关闭合并窗口,每条立即投递)
 *
 * 纯函数(extractDeliverableText / buildFinalNoticeText)与投递器(deliverFinalNotice)分置:
 * 前者可直测,后者只管去重 + 合并窗口 + journal.append。
 */
import type { Journal } from "@lampgenie/core";

export const DEFAULT_SUBAGENT_INJECT_MAX = 4_000;
export const DEFAULT_SUBAGENT_INJECT_BATCH_MAX = 8_000;
export const DEFAULT_SUBAGENT_INJECT_MERGE_MS = 500;
/** 截断标记:模型看到它就明白全文在 output.txt,需要时再 task_output 补查。 */
export const TRUNCATED_MARK = "…(已截断,全文见 output.txt)";

function envNum(name: string, def: number): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** 单条注入正文上限;>0=开,0=关闭注入(退化旧行为:摘要+指针)。非法值按约定=0。 */
export function subagentInjectMaxChars(): number {
  const n = envNum("GENIE_SUBAGENT_INJECT_MAX", DEFAULT_SUBAGENT_INJECT_MAX);
  return n !== undefined && n > 0 ? Math.floor(n) : 0;
}

/** 单条 message.system 的正文总上限(多子代理合并时共享);非法/<=0 退缺省。 */
export function subagentInjectBatchMax(): number {
  const n = envNum("GENIE_SUBAGENT_INJECT_BATCH_MAX", DEFAULT_SUBAGENT_INJECT_BATCH_MAX);
  return n !== undefined && n > 0 ? Math.floor(n) : DEFAULT_SUBAGENT_INJECT_BATCH_MAX;
}

/** 终态合并窗口毫秒;0=关闭合并(每条立即投递);非法值退缺省。 */
export function subagentInjectMergeMs(): number {
  const n = envNum("GENIE_SUBAGENT_INJECT_MERGE_MS", DEFAULT_SUBAGENT_INJECT_MERGE_MS);
  return n !== undefined && n >= 0 ? Math.floor(n) : DEFAULT_SUBAGENT_INJECT_MERGE_MS;
}

/** 从 output.txt 全文提取「可投递正文」:剥掉 [progress] 心跳行,取最后一个 [result ...] 段之后的内容;
 *  无 [result] 标记则取去掉 progress 行后的尾部。maxChars<=0 = 关闭注入(返回空正文)。
 *  truncated=true 时 text 末尾带 TRUNCATED_MARK。 */
export function extractDeliverableText(outputText: string, maxChars: number): { text: string; truncated: boolean } {
  if (!(maxChars > 0)) return { text: "", truncated: false };
  const lines = String(outputText ?? "")
    .split(/\r?\n/)
    .filter((l) => !/^\s*\[(progress|心跳)\]/.test(l));
  let resultIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*\[result\b/.test(lines[i]!)) {
      resultIdx = i;
      break;
    }
  }
  let seg: string;
  if (resultIdx >= 0) {
    const first = lines[resultIdx]!.replace(/^\s*\[result[^\]]*\]\s*/, "");
    seg = [first, ...lines.slice(resultIdx + 1)].join("\n");
  } else {
    seg = lines.join("\n");
  }
  const body = seg.trim();
  if (!body) return { text: "", truncated: false };
  if (body.length <= maxChars) return { text: body, truncated: false };
  // 有 [result] 段时截头(结论在前);无标记时保留尾部(最近的输出更有信息量)。
  const cut = resultIdx >= 0 ? body.slice(0, maxChars) : body.slice(body.length - maxChars);
  return { text: cut.trimEnd() + TRUNCATED_MARK, truncated: true };
}

/** 一条终态通知的输入(纯数据,便于单测)。 */
export interface FinalNoticeItem {
  agentId: string;
  /** 终态标签:完成 / 失败 / deadline 收割 / 死讯 … */
  label: string;
  /** 子代理终态文本(全文,内部只取前 summaryChars 字做标题行)。 */
  summary: string;
  /** output.txt 全文;给了才抽正文,没给=只有摘要+指针。 */
  outputText?: string;
  /** 单条正文上限覆盖(缺省取 subagentInjectMaxChars())。 */
  maxChars?: number;
  /** 强制只给指针(死讯/无正文可投的终态)。 */
  pointerOnly?: boolean;
}

function oneLine(s: string): string {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

/** 拼装 message.system 文本(纯函数):每条一段「[后台子代理 <id> <label>] <摘要>」+ 正文 + 指针。
 *  正文总长受 batchMax 约束(多条按剩余预算均分);截断/无正文时补指针。 */
export function buildFinalNoticeText(
  items: FinalNoticeItem[],
  opts: { batchMax?: number; summaryChars?: number } = {},
): string {
  const batchMax = opts.batchMax ?? subagentInjectBatchMax();
  const summaryChars = opts.summaryChars ?? 300;
  let remaining = batchMax > 0 ? batchMax : Number.POSITIVE_INFINITY;
  const blocks = items.map((it, i) => {
    const maxChars = it.maxChars ?? subagentInjectMaxChars();
    const left = items.length - i;
    const budget = remaining === Number.POSITIVE_INFINITY ? maxChars : Math.min(maxChars, Math.floor(remaining / left));
    const ext = it.pointerOnly || it.outputText === undefined
      ? { text: "", truncated: false }
      : extractDeliverableText(it.outputText, Math.max(budget, 0));
    remaining -= ext.text.length;
    const head = `[后台子代理 ${it.agentId} ${it.label}] ${oneLine(it.summary).slice(0, summaryChars)}`;
    const needPointer = it.pointerOnly === true || ext.text.length === 0 || ext.truncated;
    return head + (ext.text ? "\n\n" + ext.text : "") + (needPointer ? `\n(全文:task_output agentId="${it.agentId}")` : "");
  });
  return blocks.join("\n\n");
}

// ── 投递器:去重(终态正文一次)+ 合并窗口(同批终态合并成一条 message.system)──
/** 已投递键:sessionId + ":" + agentId(不同会话的同名 agentId 各投一次)。 */
const delivered = new Set<string>();
/** 合并窗口内的待投递条目(按 sessionId 分组)。 */
const pending = new Map<string, FinalNoticeItem[]>();
const mergeTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** 只去重「终态正文投递」;subagent.result 等事实源事件由调用方无条件写,不经此处。 */
export function deliverFinalNotice(
  journal: Pick<Journal, "append">,
  sessionId: string,
  item: FinalNoticeItem,
  opts: { mergeMs?: number; batchMax?: number } = {},
): boolean {
  const key = `${sessionId}:${item.agentId}`;
  if (delivered.has(key)) return false;
  delivered.add(key);
  const mergeMs = opts.mergeMs ?? subagentInjectMergeMs();
  const flush = () => {
    mergeTimers.delete(sessionId);
    const items = pending.get(sessionId);
    pending.delete(sessionId);
    if (!items?.length) return;
    try {
      journal.append({
        kind: "message.system",
        sessionId,
        payload: { text: buildFinalNoticeText(items, opts.batchMax !== undefined ? { batchMax: opts.batchMax } : {}) },
      });
    } catch {
      /* 通知失败不影响子代理收尾 */
    }
  };
  if (!(mergeMs > 0)) {
    pending.set(sessionId, [item]);
    flush();
    return true;
  }
  const buf = pending.get(sessionId);
  if (buf) buf.push(item);
  else pending.set(sessionId, [item]);
  if (!mergeTimers.has(sessionId)) {
    const t = setTimeout(flush, mergeMs);
    t.unref?.();
    mergeTimers.set(sessionId, t);
  }
  return true;
}

/** 单测隔离用:清空去重表与待投递缓冲(生产路径不调用)。 */
export function resetSubagentDeliveryStateForTest(): void {
  for (const t of mergeTimers.values()) {
    try { clearTimeout(t); } catch { /* ignore */ }
  }
  mergeTimers.clear();
  pending.clear();
  delivered.clear();
}

/** 去重表只读探针(单测断言「只投一次」)。 */
export function wasFinalNoticeDelivered(sessionId: string, agentId: string): boolean {
  return delivered.has(`${sessionId}:${agentId}`);
}
