/**
 * 基因提示的历史反事实回放(设想「回放验证——唯一能挡住
 * “听起来很对、实际没用”的废话的门」的最小可运行形态)。
 * 问题:开工简报的「本模块历史缺陷基因」注入臂已上线(defectGenes→matchedDefectGenes),
 * 前瞻 A/B(gene.brief.shown 标记)要等数据积累。回放版现在就能回答:**把提示放回历史
 * build 会话开工的那一刻,它会命中吗?命中的类别对吗?**
 * 方法(确定性,零 LLM):
 * - 对每条 rework 链(classification=rework):取 build 会话的**完整首条用户消息**
 * (与生产注入同一文本口径),跑 matchedDefectGenes;
 * - **leave-one-out 防循环泄漏**:基因聚合自链本身——被回放的链自己贡献的
 * (defectClass, logicalKey) 基因必须从匹配池剔除,否则是拿答案找答案;
 * - 读出:wouldShow(提示会出现的链数)/ classMatch(提示类别覆盖实际缺陷类)/ 精确率,
 * preventable 子集单列(注入臂的目标人群)。
 * 判读:matchRate 低 = 注入臂在历史分布上不精确,先修匹配/类别映射再谈前瞻 A/B——
 * 这正是设想说的「无法回放验证的总结只能当观察记录」。
 * 依赖纪律:node:fs + atlas-harvest(纯匹配)+ rework-chain(台账读);纯函数核心可直测。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { matchedDefectGenes } from "./atlas-harvest.js";
import { readReworkChains, type ReworkChainLine } from "./rework-chain.js";
import type { DefectGene } from "@lampgenie/runtime/agent/direction-atlas";

export interface ReplayChainInput {
  chain: ReworkChainLine;
 /** build 会话的完整首条用户消息(生产注入同口径);缺文本=跳过并计数。 */
  buildText: string | undefined;
}

export interface ReplayResult {
 /** 参与回放的 rework 链数(drift 不参与——注入臂不针对演进)。 */
  chains: number;
 /** 不可判类的链数(defectClass=uncategorized:按定义无提示语可命中,不进精确率分母——
 * 精确模式注意:两模式 miss 全是它,分母污染让读数失真)。 */
  unmeasurable: number;
 /** build 文本缺失(会话文件不在/无首条用户消息)的链数。 */
  missingBuildText: number;
 /** 提示会出现(matchedDefectGenes 非空)的链数。 */
  wouldShow: number;
 /** 提示类别覆盖实际缺陷类(shownClasses ∋ chain.defectClass)。 */
  classMatch: number;
 /** classMatch / wouldShow(注入臂精确率;wouldShow=0 时为 null,诚实)。 */
  matchRate: number | null;
  preventable: { chains: number; wouldShow: number; classMatch: number; matchRate: number | null };
 /** 未命中的代表样本(修匹配用;≤5 条)。 */
  misses: Array<{ buildSession: string; chainClass: string; shownClasses: string[] }>;
 /** 命中的代表样本(≤3 条,佐证)。 */
  hits: Array<{ buildSession: string; chainClass: string; shownClasses: string[] }>;
}

/**
 * 纯核心:给定链+各自 build 文本+**全量基因**,做 leave-one-out 回放。
 * 剔除规则:回放链 c 时,基因池里剔除所有与 c 同 (defectClass, logicalKey) 的链所贡献的基因
 * ——即该 (类,模块) 只有 c 自己撑着时不许用(c 的 fix 是它唯一的证据来源=循环)。
 */
/**
 * 从台账链派生基因池(证据完备视图;快照是它的投影)——按 (defectClass, module) 聚合,
 * 与 nightly ingest 同口径。精确 leave-one-out 用它:剔除**链身份**而非整个 (类,模块) 键。
 */
export function genesFromChains(chains: readonly ReworkChainLine[]): DefectGene[] {
  const agg = new Map<string, DefectGene>();
  for (const c of chains) {
    if (c.classification !== "rework" || c.defectClass === "uncategorized") continue;
    const id = `gene-${c.defectClass}-${c.logicalKey}`;
    const g = agg.get(id) ?? { id, defectClass: c.defectClass, module: c.path, count: 0, lastAt: new Date(c.at).toISOString() };
    g.count += 1;
    agg.set(id, g);
  }
  return [...agg.values()];
}

/** 链身份键(精确 leave-one-out 的剔除单位:同一条返工事实,不是同键全家)。 */
function chainIdentity(c: ReworkChainLine): string {
  return `${c.buildSession}\u0000${c.fixSession}\u0000${c.logicalKey}\u0000${c.defectClass}`;
}

/**
 * 精确 leave-one-out 回放(v2:证据源=台账链本身(快照基因是其投影);
 * 剔除被回放链的**自身身份**——同键的其它链(不同 fix 事件)仍贡献证据,不再保守全家剔除。
 * 与 replayGeneHints(快照口径,生产注入视角)并列:precise 回答「证据充分时臂的精度上限」,
 * snapshot 回答「生产当前注入的实际精度」。
 */
export function replayGeneHintsPrecise(
  inputs: readonly ReplayChainInput[],
  allChains: readonly ReworkChainLine[],
): ReplayResult {
  const byIdentity = new Map<string, ReworkChainLine>();
  for (const c of allChains) byIdentity.set(chainIdentity(c), c);
  const results: ReplayResult[] = [];
  for (const input of inputs) {
 // 池 = 全部链减去本链身份(以及与其同 fix 事件的重复行——同身份即同事件)
    const poolChains = allChains.filter((c) => chainIdentity(c) !== chainIdentity(input.chain));
    const pool = genesFromChains(poolChains);
    const single = replayGeneHints([input], pool, { skipPoolFilter: true });
    results.push(single);
  }
 // 合并(计数直加;率重算)
  const merged: ReplayResult = {
    chains: results.reduce((s, r) => s + r.chains, 0),
    unmeasurable: results.reduce((s, r) => s + r.unmeasurable, 0),
    missingBuildText: results.reduce((s, r) => s + r.missingBuildText, 0),
    wouldShow: results.reduce((s, r) => s + r.wouldShow, 0),
    classMatch: results.reduce((s, r) => s + r.classMatch, 0),
    matchRate: null,
    preventable: {
      chains: results.reduce((s, r) => s + r.preventable.chains, 0),
      wouldShow: results.reduce((s, r) => s + r.preventable.wouldShow, 0),
      classMatch: results.reduce((s, r) => s + r.preventable.classMatch, 0),
      matchRate: null,
    },
    misses: results.flatMap((r) => r.misses).slice(0, 5),
    hits: results.flatMap((r) => r.hits).slice(0, 3),
  };
  merged.matchRate = merged.wouldShow > 0 ? merged.classMatch / merged.wouldShow : null;
  merged.preventable.matchRate = merged.preventable.wouldShow > 0 ? merged.preventable.classMatch / merged.preventable.wouldShow : null;
  return merged;
}

export function replayGeneHints(
  inputs: readonly ReplayChainInput[],
  allGenes: readonly DefectGene[],
  opts: { skipPoolFilter?: boolean } = {},
): ReplayResult {
  const reworkInputs = inputs.filter((i) => i.chain.classification === "rework");
  const result: ReplayResult = {
    chains: reworkInputs.length,
    unmeasurable: 0,
    missingBuildText: 0,
    wouldShow: 0,
    classMatch: 0,
    matchRate: null,
    preventable: { chains: 0, wouldShow: 0, classMatch: 0, matchRate: null },
    misses: [],
    hits: [],
  };
  for (const input of reworkInputs) {
    const isPreventable = input.chain.attribution.verdict === "preventable";
    if (isPreventable) result.preventable.chains += 1;
 // 不可判类:uncategorized 无提示语,按定义不可能 classMatch——单列,不污染精确率分母。
    if (input.chain.defectClass === "uncategorized") {
      result.unmeasurable += 1;
      continue;
    }
    if (input.buildText === undefined || input.buildText.trim() === "") {
      result.missingBuildText += 1;
      continue;
    }
 // leave-one-out:剔除本 (defectClass, logicalKey) 的基因(模块按链的 logicalKey 匹配基因 module 后缀)。
 // skipPoolFilter:精确模式(precise)已在链身份层剔除过,内层不再重复过滤(否则把同键他链贡献也剔掉)。
    const pool = opts.skipPoolFilter === true ? allGenes : allGenes.filter((g) => {
      const sameClass = g.defectClass === input.chain.defectClass;
      const moduleTouches = g.module.endsWith(input.chain.logicalKey.split("/").pop() ?? "") || g.module.includes(input.chain.logicalKey);
      return !(sameClass && moduleTouches);
    });
    const shown = matchedDefectGenes({ defectGenes: pool }, input.buildText);
    if (shown.length === 0) continue;
    result.wouldShow += 1;
    if (isPreventable) result.preventable.wouldShow += 1;
    const shownClasses = [...new Set(shown.map((s) => s.defectClass))];
    if (shownClasses.includes(input.chain.defectClass)) {
      result.classMatch += 1;
      if (isPreventable) result.preventable.classMatch += 1;
      if (result.hits.length < 3) result.hits.push({ buildSession: input.chain.buildSession, chainClass: input.chain.defectClass, shownClasses });
    } else if (result.misses.length < 5) {
      result.misses.push({ buildSession: input.chain.buildSession, chainClass: input.chain.defectClass, shownClasses });
    }
  }
  result.matchRate = result.wouldShow > 0 ? result.classMatch / result.wouldShow : null;
  result.preventable.matchRate = result.preventable.wouldShow > 0 ? result.preventable.classMatch / result.preventable.wouldShow : null;
  return result;
}

/** 读 build 会话完整首条用户消息(与生产注入同口径:任务指令原文)。 */
export function readFirstUserText(journalDir: string, sessionId: string): string | undefined {
  let text: string | undefined;
  try {
    for (const raw of readFileSync(join(journalDir, "sessions", `${sessionId}.jsonl`), "utf8").split("\n")) {
      if (raw.trim() === "") continue;
      let event: { kind?: unknown; payload?: { text?: unknown } };
      try {
        event = JSON.parse(raw) as { kind?: unknown; payload?: { text?: unknown } };
      } catch {
        continue;
      }
      if (event.kind === "message.user" && typeof event.payload?.text === "string" && event.payload.text.trim() !== "") {
        text = event.payload.text;
        break;
      }
    }
  } catch {
    return undefined; // 会话文件不存在
  }
  return text;
}

export interface RunReplayResult extends ReplayResult {
  ok: boolean;
  ledgerLines: number;
}

/** IO 包装:读台账+快照基因,跑回放。台账/快照缺失 → ok:false(调用方如实折叠)。 */
export function runGeneReplay(root: string, projectId: string, journalDir: string): RunReplayResult {
  const ledger = readReworkChains(root);
  let genes: DefectGene[] = [];
  try {
    const snapshot = JSON.parse(readFileSync(join(root, ".genie", "rsi", "atlas", `${projectId}.json`), "utf8")) as { defectGenes?: DefectGene[] };
    genes = Array.isArray(snapshot.defectGenes) ? snapshot.defectGenes : [];
  } catch {
    return { ...emptyReplay(), ok: false, ledgerLines: ledger.chains.length };
  }
  const inputs = ledger.chains.map((chain) => ({ chain, buildText: readFirstUserText(journalDir, chain.buildSession) }));
  const replay = replayGeneHints(inputs, genes);
  return { ...replay, ok: true, ledgerLines: ledger.chains.length };
}

function emptyReplay(): ReplayResult {
  return {
    chains: 0, unmeasurable: 0, missingBuildText: 0, wouldShow: 0, classMatch: 0, matchRate: null,
    preventable: { chains: 0, wouldShow: 0, classMatch: 0, matchRate: null },
    misses: [], hits: [],
  };
}

/** 渲染为 note 一行(nightly/CLI 消费)。 */
export function renderReplayNote(r: ReplayResult): string {
  const rate = r.matchRate === null ? "n/a" : `${Math.round(r.matchRate * 100)}%`;
  const pRate = r.preventable.matchRate === null ? "n/a" : `${Math.round(r.preventable.matchRate * 100)}%`;
  return `geneReplay: chains=${r.chains}(unmeas=${r.unmeasurable}) wouldShow=${r.wouldShow} classMatch=${r.classMatch}(${rate}) | preventable=${r.preventable.chains} show=${r.preventable.wouldShow} match=${r.preventable.classMatch}(${pRate})`;
}

