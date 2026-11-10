/**
 * 系统上下文代。
 * 改前基线:loop.ts 的节 diff 只有「sha 相等/不等」二元判定 + 「名单里没有就删」——
 *  ① 没有 per-source 的 key + codec,只能对文本算 sha;
 *  ② removal 三态缺失:`unavailable`(源暂时读不到)与 `absent`(源明确不存在)同归「不一致」,
 *     于是「一次读失败」会被当成「这一节被删除」;
 *  ③ 基线冻结在 node0,压缩越过基线后没有「重开代」的手段。
 * 本模块把三态判定、单块合成、代重开做成纯函数,可独立测试;loop.ts 只做最小接线
 * (systemSectionDelta),node0 冻结基线与 journal 节基线语义保持不变。
 * 关键不变量:
 *  - 基线**永不原地改写**:update 只进 block,`next.entries[key]` 仍是旧基线(否则下一轮 diff
 *    变空 → 模型静默收不到变更,见 loop.ts systemSectionDelta 的长注释)。
 *  - `unavailable` 绝不产出 `removed`(保留旧值,等下次读到再说)。
 *  - `absent` 只有**明确消失**才算删除:调用方必须真的拿到 `{status:"absent"}`;「源没出现在
 *    本次 sources 列表里」不构成删除信号(reconcile 不替调用方推断)。
 */

/** 结构化编解码:值 ↔ 基线文本。文本节可直接用 TEXT_CODEC;结构化源(JSON/表格)自行实现。 */
export interface SystemContextCodec<T> {
  encode(value: T): string;
  decode(text: string): T;
}

/** 一次加载的结果三态。`unavailable`=暂时读不到(保留旧值);`absent`=明确不存在(可删)。 */
export type SystemContextLoad<T> =
  | { status: "ok"; value: T }
  | { status: "unavailable" }
  | { status: "absent" };

export interface SystemContextSource<T> {
  /** 稳定键(节名 / 文件名 / 概念名)。renderSystemContextBlock 按它字典序排序。 */
  key: string;
  codec: SystemContextCodec<T>;
  load(): Promise<SystemContextLoad<T>>;
}

export interface SystemContextEntry {
  /** 基线文本(encode 后的全文)。journal 侧只持久化 sha 时可为空串。 */
  text: string;
  /** 基线指纹(FNV-1a)。 */
  sha: string;
}

export interface SystemContextState {
  /** 代:压缩越过基线后 openNewGeneration +1。 */
  generation: number;
  /** 基线取定时的序号(journal seq / 代序号),用于审计「这一代基于哪一刻」。 */
  baselineSeq: number;
  /** 基线集合:key → {text, sha}。只有基线,**不含**本轮更新内容。 */
  entries: Record<string, SystemContextEntry>;
}

export type SystemContextOpKind = "baseline" | "update" | "removed" | "kept-unavailable" | "unchanged";

export interface SystemContextOp {
  key: string;
  kind: SystemContextOpKind;
  /** 本次要下发的文本:baseline/update=节片段,removed=移除声明行。
   *  unchanged/kept-unavailable 不带(它们不进 block)。 */
  text?: string;
}

export interface ReconcileResult {
  /** 下一状态(基线语义:只有 baseline 新增与 removed 剔除会改它,update 不改)。 */
  next: SystemContextState;
  /** 单块合成文本(无变化="")。 */
  block: string;
  /** 逐 key 的判定结果(含不进 block 的 unchanged/kept-unavailable)。 */
  ops: SystemContextOp[];
}

/** 文本节的恒等编解码(系统提示节本身就是文本,codec 只负责边界)。 */
export const TEXT_CODEC: SystemContextCodec<string> = {
  encode: (v) => v,
  decode: (t) => t,
};

/** 内容指纹。**不用 node:crypto** —— 只需「内容变没变」的等价判定,非加密用途;
 *  FNV-1a 32 位足够且零依赖(与原 loop.ts sectionSha 逐字一致)。碰撞后果可控:
 *  撞了=该节变更没被下发,下一次内容变化仍会命中。 */
export function sectionSha(content: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** 渲染一个「新出现 / 已变更」的节片段。
 *  内容已经以 `## ` 开头(允许前导空白/换行)时不再加 `## key`——此时内容自带语义标题,
 * key 只是内部 diff 的键,不必暴露给模型(避免双层标题:经验证 `## date` + `## 当前日期`)。
 *  与原 loop.ts renderSectionDelta 逐字一致。 */
function renderSection(key: string, content: string): string {
  const trimmed = content.replace(/^\s+/, "");
  if (trimmed.startsWith("## ")) return trimmed;
  return `## ${key}\n${content}`;
}

/** 移除声明:**显式**告诉模型「这节没了」。只发「未列出的小节保持原样」会留下已失效的旧目标/
 *  旧模式;省 token 不能以行为退化为代价。与原 loop.ts 逐字一致。 */
function renderRemoved(key: string): string {
  return `## ${key}\n(本节已移除,不再生效)`;
}

/**
 * 三态 reconcile。
 *  ok + sha 与基线一致   → unchanged(不进 block)
 *  ok + sha 不同         → update(进 block;基线**不**原地改写)
 *  unavailable           → kept-unavailable(保留旧值/旧基线,**绝不**产出 removed)
 *  absent 且基线有该 key  → removed(明确消失才算删除,并从基线剔除)
 *  absent 且基线无该 key  → 从未存在,不产出 op
 *  基线无该 key 的首次 ok → baseline(进 block:该 key 出现得比基线晚,模型尚未见过)
 *  load() 抛错按 unavailable 处理(一次读失败 ≠ 删除)。
 *  同一 key 重复给多次:首个胜出(顺序确定性)。
 *  基线里有、本次 sources 里没有的 key:不产出任何 op——「没问它」不是「它没了」。
 */
export async function reconcileSystemContext<T>(
  state: SystemContextState,
  sources: readonly SystemContextSource<T>[],
): Promise<ReconcileResult> {
  const nextEntries: Record<string, SystemContextEntry> = { ...state.entries };
  const ops: SystemContextOp[] = [];
  const seen = new Set<string>();
  for (const src of sources) {
    if (seen.has(src.key)) continue;
    seen.add(src.key);
    let loaded: SystemContextLoad<T>;
    try {
      loaded = await src.load();
    } catch {
      loaded = { status: "unavailable" };
    }
    const base = state.entries[src.key];
    if (loaded.status === "unavailable") {
      ops.push({ key: src.key, kind: "kept-unavailable" });
      continue;
    }
    if (loaded.status === "absent") {
      if (!base) continue; // 从未存在:无 op
      delete nextEntries[src.key];
      ops.push({ key: src.key, kind: "removed", text: renderRemoved(src.key) });
      continue;
    }
    const text = src.codec.encode(loaded.value);
    const sha = sectionSha(text);
    if (!base) {
      nextEntries[src.key] = { text, sha };
      ops.push({ key: src.key, kind: "baseline", text: renderSection(src.key, text) });
      continue;
    }
    if (base.sha === sha) {
      ops.push({ key: src.key, kind: "unchanged" });
      continue;
    }
    // update:基线不原地改写(见文件头不变量)。
    ops.push({ key: src.key, kind: "update", text: renderSection(src.key, text) });
  }
  return {
    next: { generation: state.generation, baselineSeq: state.baselineSeq, entries: nextEntries },
    block: renderSystemContextBlock(ops),
    ops,
  };
}

/** 单块合成:只取要下发的三种 op,按 key **字典序**稳定排序,空 = ""。
 *  排序让同一组变更在不同调用顺序下产出逐字节相同的文本(前缀缓存友好)。 */
export function renderSystemContextBlock(ops: readonly SystemContextOp[]): string {
  return ops
    .filter((op) => op.kind === "baseline" || op.kind === "update" || op.kind === "removed")
    .filter((op) => typeof op.text === "string" && op.text.length > 0)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((op) => op.text as string)
    .join("\n\n");
}

/** 当前基线的渲染文本(按 keysInOrder 拼接;**只含确实在基线里的 key**)。
 *  openNewGeneration 的「基线=当前渲染文本」即指它。 */
export function renderGenerationBaseline(state: SystemContextState, keysInOrder: readonly string[]): string {
  const out: string[] = [];
  for (const key of keysInOrder) {
    const e = state.entries[key];
    if (e) out.push(e.text);
  }
  return out.join("\n\n");
}

/**
 * 压缩越过基线后重开新代:generation+1,基线收窄为 keysInOrder 指定的条目(即「当前渲染文本」
 * 的组成),其余条目丢弃(它们不属于这一代基线)。
 * baselineSeq 缺省 = 上一代 +1(模块内无 journal,用单调代序号充当时钟);接线方有真实
 * journal seq 时显式传入。
 */
export function openNewGeneration(
  state: SystemContextState,
  keysInOrder: readonly string[],
  baselineSeq?: number): SystemContextState {
  const entries: Record<string, SystemContextEntry> = {};
  for (const key of keysInOrder) {
    const e = state.entries[key];
    if (e) entries[key] = { text: e.text, sha: e.sha };
  }
  return {
    generation: state.generation + 1,
    baselineSeq: baselineSeq ?? state.baselineSeq + 1,
    entries,
  };
}
