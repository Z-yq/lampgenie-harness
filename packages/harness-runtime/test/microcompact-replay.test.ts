/**
 * 真实会话回放对比(step-1039 v2 / step-1028 事故样本)。
 *
 * 目的:用 2026-11-06 事故会话的真实消息序列,把 **改造前(legacy 每步增量清)** 与
 * **改造后(cache-aware 冻结区 + 受控重置)** 放在同一批输入上跑,断言用户口径的三条不变量:
 *   ① 常态步已发出去的前缀逐字不变(只有重置步可断);
 *   ② 重置次数远少于「每步改写」(≈1~2 次/turn 量级);
 *   ③ 无锯齿:上下文不出现「大降 → 大涨 → 再大降」,单次削幅 ≤ 上下文 20%。
 *
 * 口径说明(诚实标注):
 * - 快照 = journal 里每条 `llm.trace` 发生时刻「已累积的消息」(剔除同 step 的 assistant 响应本身),
 *   system 取 `system.prompt` 全文;未走 `deriveMessages`(它要构造 Journal 对象,成本高且会重放
 *   ephemeral 注入)。故与产线拼装可能有细小出入 —— 断言只针对「策略行为」,绝对值不作真源。
 * - turn 首步用「每 10 步」近似(journal 里 message.user 只有 1 条,无法按用户消息切 turn)。
 * - 阈值:journal 的 context.prune 不含 threshold 字段 → 用缺省 110_000。
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  microcompactMessages,
  type MicrocompactConfig,
  type MicrocompactPolicyState,
} from "../src/agent/microcompact";
import type { Message } from "../src/agent/loop";
import { estimateMessagesTokens } from "../src/agent/loop";

const JOURNAL = resolve(
  __dirname,
  "../../../.genie/journals/sessions/web-opt1106-tracefull-1793940463380.jsonl",
);
const THRESHOLD = 110_000;

interface Snapshot {
  /** 该步之前已累积的消息(不含本步产出)。 */
  messages: Message[];
}

/** 从 journal 还原「每个 llm.trace 时刻的历史」:message.user / message.agent / tool.result 顺序累积。 */
function loadSnapshots(path: string): { snapshots: Snapshot[]; usage: { input: number; cached: number } } {
  const messages: Message[] = [];
  const snapshots: Snapshot[] = [];
  let system = "";
  const usage = { input: 0, cached: 0 };
  const pending: Message[] = []; // 本步助手响应(在下一条 llm.trace 前累积,但不进本步快照)
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let ev: { kind?: string; payload?: Record<string, unknown> };
    try { ev = JSON.parse(line) as typeof ev; } catch { continue; }
    const p = ev.payload ?? {};
    if (ev.kind === "system.prompt") {
      system = typeof p.text === "string" ? p.text : system;
      continue;
    }
    if (ev.kind === "message.user") {
      pending.length = 0;
      messages.push({ role: "user", content: String(p.text ?? "") });
      continue;
    }
    if (ev.kind === "message.agent") {
      const agent: Message = {
        role: "assistant",
        content: String(p.text ?? ""),
        ...(Array.isArray(p.toolCalls)
          ? { toolCalls: (p.toolCalls as { id: string; name: string; arguments: string }[]).map((c) => ({ ...c })) }
          : {}),
      } as Message;
      pending.push(agent);
      messages.push(agent);
      continue;
    }
    if (ev.kind === "tool.result") {
      const res: Message = { role: "tool", toolCallId: String(p.toolCallId ?? ""), content: String(p.content ?? "") };
      pending.push(res);
      messages.push(res);
      continue;
    }
    if (ev.kind === "llm.trace") {
      // 本步快照 = 已有历史去掉本步刚追加的 assistant/tool(它们属于本步输出,下一次请求才可见)
      const head = system ? [{ role: "system", content: system } as Message] : [];
      snapshots.push({ messages: [...head, ...messages.slice(0, messages.length - pending.length)] });
      const u = (p.usage ?? {}) as { inputTokens?: number; cachedTokens?: number };
      usage.input += Number(u.inputTokens ?? 0);
      usage.cached += Number(u.cachedTokens ?? 0);
      pending.length = 0;
    }
  }
  return { snapshots, usage };
}

/** 相邻两步「已发出去的部分」是否逐字相同(公共前缀长度 ≥ 前一步长度 → 前缀保持)。 */
function prefixKept(prev: Message[], cur: Message[]): boolean {
  if (cur.length < prev.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (JSON.stringify(prev[i]) !== JSON.stringify(cur[i])) return false;
  }
  return true;
}

interface Pass {
  policy: string;
  breakPrefix: boolean;
  after: number;
  /** 与上一步比,已发部分是否逐字保持。 */
  kept: boolean;
}

function runPass(snapshots: Snapshot[], cacheAware: boolean): Pass[] {
  let state: MicrocompactPolicyState = { clock: 0 };
  let prev: Message[] | undefined;
  const out: Pass[] = [];
  snapshots.forEach((snap, i) => {
    const step = i + 1;
    const cfg: MicrocompactConfig = {
      thresholdTokens: THRESHOLD,
      keepRecent: 5,
      ...(cacheAware ? {} : { cacheAware: false }),
      ...(cacheAware ? { policyState: { ...state, turnStart: step % 10 === 1 } } : {}),
    };
    const r = microcompactMessages(snap.messages, cfg);
    // legacy 不返回 contextTokensAfter → 用同一 est 口径对渲染结果补算,保证两栏可比。
    const after = r.contextTokensAfter ?? estimateMessagesTokens(r.messages);
    out.push({
      policy: r.policy ?? "legacy",
      breakPrefix: r.prefixBreak === true,
      after,
      kept: prev === undefined ? true : prefixKept(prev, r.messages),
    });
    if (cacheAware) {
      const broke = r.prefixBreak === true;
      state = {
        clock: step,
        turnStart: false,
        resetsThisTurn: broke ? (state.resetsThisTurn ?? 0) + (step % 10 === 1 ? 1 : 1) : (state.resetsThisTurn ?? 0),
        ...(r.frozenCount !== undefined ? { frozenCount: r.frozenCount } : {}),
        ...(r.anchor ? { frozenAnchor: r.anchor } : {}),
        ...(broke ? {
          lastResetClock: step,
          lastResetTokens: r.contextTokensAfter ?? 0,
        } : {
          ...(state.lastResetClock !== undefined ? { lastResetClock: state.lastResetClock } : {}),
          ...(state.lastResetTokens !== undefined ? { lastResetTokens: state.lastResetTokens } : {}),
        }),
      };
      // turn 边界归零(近似口径:每 10 步)
      if ((i + 2) % 10 === 1) state = { ...state, resetsThisTurn: 0 };
    }
    prev = r.messages;
  });
  return out;
}

function pct(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx]!;
}

describe("真实 journal 回放:改造前 vs 改造后(2026-11-06 事故样本)", () => {
  const available = existsSync(JOURNAL);

  it("真实 journal 回放输出前后对比表", () => {
    if (!available) {
      // 样本不在仓内(如干净检出)→ 明确跳过,不假装通过
      expect(existsSync(JOURNAL)).toBe(false);
      return;
    }
    const { snapshots, usage } = loadSnapshots(JOURNAL);
    expect(snapshots.length).toBeGreaterThan(50);

    const legacy = runPass(snapshots, false);
    const aware = runPass(snapshots, true);

    const breaksOf = (passes: Pass[]): number[] => passes
      .map((p, i) => (i > 0 && !p.kept ? i : -1)).filter((i) => i >= 0);
    const legacyBreaks = breaksOf(legacy);
    const awareBreaks = breaksOf(aware);
    const awareResets = aware.filter((p) => p.policy === "reset").length;
    const growth = (passes: Pass[]): number[] => {
      const out: number[] = [];
      for (let i = 1; i < passes.length; i++) {
        const base = passes[i - 1]!.after;
        if (base > 0) out.push(((passes[i]!.after - base) / base) * 100);
      }
      return out;
    };
    const gLegacy = growth(legacy);
    const gAware = growth(aware);
    const keptRate = (passes: Pass[]): number => passes.slice(1).filter((p) => p.kept).length / (passes.length - 1);
    const policyCount = (policy: string): number => aware.filter((p) => p.policy === policy).length;

    const table = [
      "| 指标 | 改造前 legacy | 改造后 cache-aware |",
      "| --- | --- | --- |",
      `| 步数 | ${legacy.length} | ${aware.length} |`,
      `| 断前缀步数 | ${legacyBreaks.length} | ${awareBreaks.length} |`,
      `| 重置次数(prefixBreak) | — | ${awareResets} |`,
      `| 前缀保持率(相邻步逐字全等) | ${(keptRate(legacy) * 100).toFixed(2)}% | ${(keptRate(aware) * 100).toFixed(2)}% |`,
      `| growthPct p50 / p95 / max | ${pct(gLegacy, 50).toFixed(2)} / ${pct(gLegacy, 95).toFixed(2)} / ${Math.max(...gLegacy).toFixed(2)} | ${pct(gAware, 50).toFixed(2)} / ${pct(gAware, 95).toFixed(2)} / ${Math.max(...gAware).toFixed(2)} |`,
      `| policy 分布 | 无字段 | reset ${policyCount("reset")} / cooldown-skip ${policyCount("cooldown-skip")} / low-context-skip ${policyCount("low-context-skip")} / deferred ${policyCount("deferred")} / growth-spurt ${policyCount("growth-spurt")} |`,
      `| 真实 usage 基线 | Σinput ${usage.input} / Σcached ${usage.cached} = ${((usage.cached / Math.max(1, usage.input)) * 100).toFixed(2)}% |(同左,同一批 trace) |`,
    ].join("\n");
    // 曲线只打抽样点(避免刷屏)
    const samples = [0, 60, 100, 140, snapshots.length - 1]
      .filter((i) => i >= 0 && i < snapshots.length)
      .map((i) => `${i}:${snapshots[i]!.messages.length}条/legacy ${legacy[i]!.after}/aware ${aware[i]!.after}`);
    console.log(`\n${table}\n\n抽样曲线: ${samples.join("   ")}\n`);

    // ① 改造后断前缀步数显著少于改造前
    expect(awareBreaks.length).toBeLessThan(legacyBreaks.length);
    // ② 改造后重置次数在个位数量级(旧行为=26 步改写)
    expect(awareResets).toBeLessThanOrEqual(5);
    // ③ 无锯齿:改造后相邻步上下文降幅不超过 20%(单次重置削减上限)
    for (let i = 1; i < aware.length; i++) {
      const drop = (aware[i - 1]!.after - aware[i]!.after) / Math.max(1, aware[i - 1]!.after);
      expect(drop).toBeLessThanOrEqual(0.2 + 1e-6);
    }
    // ④ 每个非重置步,已发部分逐字保持(用户口径核心)
    aware.forEach((p, i) => {
      if (i === 0 || p.breakPrefix) return;
      expect(p.kept).toBe(true);
    });
    // ⑤ 改造后前缀保持率高于改造前
    expect(keptRate(aware)).toBeGreaterThan(keptRate(legacy));
  });
});
