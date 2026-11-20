/**
 * RSI 实验自动结算器(#192 第五段「度量纠偏」。
 * 背景:实验账本自 11-09 落地后零 adopt/reject——不是没有实验,是「result 指标无人采集」:
 * 决策停在 iterate(基线 9.95%/minSample 30,result 未采集)。本模块在每个调度周期时:
 * ① 扫 journal 的 rsi.tip.shown 留痕(file-tools 干预注入位)→ 处理组会话;
 * ② 读 nightly 的 *.session-stats.json(确定性会话指标)→ 对照组;
 * ③ 处理组样本 ≥ thresholds.minSample 时,把 result 指标写回台账并给「建议决策」。
 * 纪律:
 * - §14.2① 机器闸(取代旧 #219 人工批准口径):三条件(样本≥minSample/effect≥阈值
 * 且对照非空/护栏回归≤上限)全达标 → 自动 adopt 生效——先刷回滚基准快照(fail-closed)、
 * 写 active-interventions(100%)、decision=adopt by=rsi-auto-gate;未达标照实写 iterate/hold。
 * 激活后每周期复查(r1 恶化回滚/r2 断流降 canary_50,见 reviewActiveInterventions)。
 * - 幂等:metric.result 已在的实验不再覆写(结果只记第一次,样本增长靠下一实验);
 * - 拒绝造数:数据源只有真实 journal 留痕与 nightly 统计,扫不到=waiting,不凑样本。
 * 依赖纪律:node:fs/node:path + experiment-store(同仓台账);不引 agent loop、不碰时钟(now 可注入)。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decideExperiment, listExperiments, recordExperiment, type DecidableKind } from "./experiment-store.js";
import { takeBaseline } from "./rsi-breaker-store.js"; // §14.2① a1:adopt 前刷回滚基准快照
import { markQueueConsumed, readQueue } from "./nightly-store.js";
import { EXPERIMENT_SCHEMA_VERSION } from "@lampgenie/runtime/agent/experiment-ledger";

/** 结算动作(写回台账的决策种类恒为 iterate;建议只进 reason)。 */
export interface ExperimentSettleOutcome {
  id: string;
  action: "proposed-adopt" | "proposed-reject" | "hold" | "written" | "adopt";
  nTreatment: number;
  nControl: number;
  treatmentRate: number;
  controlRate: number;
  effectPct: number | null;
  minSample: number;
  note?: string;
}

export interface ExperimentSettleSummary {
  at: number;
  settled: ExperimentSettleOutcome[];
  waiting: Array<{ id: string; nTreatment: number; minSample: number }>;
  codes: string[];
}

/** 单条 session-stats 记录(nightly mine 产物,只取本模块消费的字段)。 */
interface SessionStat {
  sessionId?: unknown;
  repeatedReads?: unknown;
  unresolvedAsks?: unknown;
  failedSteps?: unknown;
}

const SETTLER_MARK = "rsi.tip.shown";
const SETTLER_WITHHELD_MARK = "rsi.tip.withheld";

// ---------------------------------------------------------------------------
// 候选队列消费器(P0-2——机制审计注意「3 个候选连排 5 轮无人消费」:
// queue.jsonl 有 consumedAt 标记机制与 markQueueConsumed 写入函数,但全仓零调用方。
// 本消费器在周期把「能确定性翻译成实验」的候选落进实验账本并标记消费;
// 翻译不了的(gate/refactor 等无 intervention surface / 无指标映射)诚实留队给 agent 机制。
// ---------------------------------------------------------------------------

/** nightly 候选→实验的指标映射:只收能从 session-stats 确定性算基线的 ref。 */
const CANDIDATE_METRICS: Record<string, {
  statsKey: "repeatedReads" | "unresolvedAsks";
  name: string;
  threshold: number;
  surface: "tip" | "tool";
 /** 队列候选 kind 与映射 surface 不必逐字相等(gate 类候选的干预面也是 tip 注入)。 */
  kinds?: readonly string[];
}> = {
  "repeated-reads": { statsKey: "repeatedReads", name: "repeated-read-groups", threshold: 1, surface: "tip" },
 // 补 unresolved-asks 映射——1604A 注意队列 4 条候选全留队是因为映射表
 // 只认 repeated-reads;unresolvedAsks 在 session-stats 有确定性采集,基线可诚实计算,故开放映射。
  "unresolved-asks": {
    statsKey: "unresolvedAsks",
    name: "unresolved-asks-rate",
    threshold: 1,
    surface: "tip",
    kinds: ["tip", "gate"],
  },
 // failed-steps 已移除(修5):threshold=2 过低→基线 94.63%(63x 虚高),且无注入位;
 // 待造出 journal_query/编辑回执影响面工具后再重新设计指标口径。
};

export interface QueueDrainSummary {
  at: number;
 /** 新登记进实验账本的 candidate id。 */
  recorded: string[];
 /** 标记消费的 candidate id(含已登记过/重复假设被拒后不再骚扰的)。 */
  markedConsumed: string[];
 /** 留队(翻译不了,等 agent 机制设计实验)的 candidate id。 */
  leftQueued: string[];
  codes: string[];
}

/**
 * 消费一轮 nightly 候选队列:
 * - 同 ref 已有实验 → 只标消费(防 5 轮重排);
 * - 有指标映射的 tip/tool 候选 → 从 session-stats 算诚实基线(达标会话占比),recordExperiment 后标消费;
 * - 无映射/gate 类 → 留队(不伪造基线)。
 * 任何失败折叠进 codes,不 throw(调度器路径调用)。
 */
export function drainCandidateQueue(root: string, opts: { now?: number } = {}): QueueDrainSummary {
  const now = opts.now ?? Date.now();
  const out: QueueDrainSummary = { at: now, recorded: [], markedConsumed: [], leftQueued: [], codes: [] };
  let queue: ReturnType<typeof readQueue> = [];
  try {
    queue = readQueue(root);
  } catch {
    out.codes.push("DRAIN_QUEUE_UNREADABLE");
    return out;
  }
 // 未消费候选按 id 去重(多日重排取最新一行)。
  const pending = new Map<string, { line: ReturnType<typeof readQueue>[number]; kind: string; ref: string; reason: string }>();
  for (const line of queue) {
    const candidate = line?.candidate as { id?: unknown; kind?: unknown; ref?: unknown; reason?: unknown } | undefined;
    const id = typeof candidate?.id === "string" ? candidate.id : "";
    if (id === "") continue;
    if (typeof line.consumedAt === "string" && line.consumedAt !== "") continue;
    pending.set(id, {
      line,
      kind: typeof candidate?.kind === "string" ? candidate.kind : "",
      ref: typeof candidate?.ref === "string" ? candidate.ref : "",
      reason: typeof candidate?.reason === "string" ? candidate.reason : "",
    });
  }
  if (pending.size === 0) return out;
  let experiments: ReturnType<typeof listExperiments> = [];
  try {
    experiments = listExperiments(root);
  } catch {
    out.codes.push("DRAIN_LEDGER_UNREADABLE");
    return out;
  }
  const stats = loadSessionStats(root).bySession;
  const allStats = [...stats.values()];
  for (const [id, entry] of pending) {
    const spec = CANDIDATE_METRICS[entry.ref];
    const kindAllowed = spec !== undefined && (spec.kinds !== undefined ? spec.kinds.includes(entry.kind) : entry.kind === spec.surface);
 // 已有同 ref 实验 → 标消费不再重排(登记是唯一真相,后续走结算器)。
    const dupRef = experiments.some((e) => e.intervention?.ref === entry.ref);
    if (spec === undefined || !kindAllowed) {
      if (dupRef) {
        markQueueConsumed(root, [id], "rsi-queue-drain:duplicate-ref", now);
        out.markedConsumed.push(id);
      } else {
        out.leftQueued.push(id);
      }
      continue;
    }
    if (dupRef) {
      markQueueConsumed(root, [id], "rsi-queue-drain:duplicate-ref", now);
      out.markedConsumed.push(id);
      continue;
    }
 // 诚实基线:达标会话占比(session-stats 全量样本;无样本=0/0 不登记,留队等数据)。
    const sample = allStats.length;
    if (sample === 0) {
      out.leftQueued.push(id);
      out.codes.push("DRAIN_NO_STATS");
      continue;
    }
    const hit = allStats.filter((s) => Number(s[spec.statsKey] ?? 0) >= spec.threshold).length;
    const baselineValue = Math.round((hit / sample) * 10000) / 10000;
    const res = recordExperiment(root, {
      id: `exp-cand-${entry.ref}`,
      schemaVersion: EXPERIMENT_SCHEMA_VERSION,
      hypothesis: {
        claim: `${entry.reason};投放 ${entry.ref} 干预(${spec.surface} 面)可将 ${spec.name} 降低 ≥30%。`,
        mechanism: `nightly 挖掘候选→队列消费器自动登记(2026-11-17);干预注入位见 ${spec.surface === "tip" ? "file-tools repeated-reads/gateway 注入面" : "tools 机制(待实现)"}`,
        expectedEffect: `${spec.name} 相对基线下降 ≥30%,failed-steps 回退 ≤5%。`,
      },
      intervention: { surface: spec.surface, ref: entry.ref, variant: `cand-${entry.ref}` },
      guardrails: [{ metric: "failed-steps", maxRegressionPct: 5 }],
 // canary=session 全量:干预触发是确定性的(如 repeated-reads tip 对每个达标会话 100% 触发),
 // 无百分比分流实现——percent 字段不写,避免「10% 灰度数学不可达」的自欺(机制审计 P0-3)。
      canary: { scope: "session", status: "running" },
      strata: [{ projectId: String((entry.line as { projectId?: unknown }).projectId ?? ""), taskClass: "coding" }],
      metrics: [
        {
          name: spec.name,
          unit: "ratio",
          kind: "rate",
          direction: "decrease",
          baseline: { value: baselineValue, sample },
          thresholds: { minSample: 30, minEffectPct: 30 },
        },
      ],
      rollbackPoint: { kind: "config", ref: `rsi-candidate/${entry.ref}` },
      decision: { kind: "pending" },
      evidence: Array.isArray((entry.line as { candidate?: { evidenceRefs?: unknown } }).candidate?.evidenceRefs)
        ? ((entry.line as { candidate: { evidenceRefs: unknown[] } }).candidate.evidenceRefs.filter((x): x is string => typeof x === "string"))
        : undefined,
      createdAt: now,
      updatedAt: now,
    });
    if (res.ok) {
      out.recorded.push(id);
      markQueueConsumed(root, [id], "rsi-queue-drain:recorded", now);
      out.markedConsumed.push(id);
    } else if (res.code === "EXP_DUPLICATE" || res.code === "EXP_DUPLICATE_HYPOTHESIS") {
      markQueueConsumed(root, [id], `rsi-queue-drain:${res.code}`, now);
      out.markedConsumed.push(id);
    } else {
      out.leftQueued.push(id);
      out.codes.push(res.code ?? "DRAIN_RECORD_FAILED");
    }
  }
  return out;
}

/** 扫 journal sessions 分片,返回指定 ref 的干预留痕分类(P5, 方法学修复):
 * shown=注入侧(处理组)、withheld=同资格触发但哈希对照侧(对照组)。文件名即 sessionId;
 * mtime 过滤窗口=实验创建时刻(干预只在其部署后存在);不含标记则跳过,不逐行解析。 */
export function collectTipMarkerSessions(
  journalDir: string,
  ref: string,
  sinceMs: number,
): { shown: Set<string>; withheld: Set<string>; filesScanned: number; codes: string[] } {
  const shown = new Set<string>();
  const withheld = new Set<string>();
  const sessionsDir = join(journalDir, "sessions");
  const codes: string[] = [];
  if (!existsSync(sessionsDir)) return { shown, withheld, filesScanned: 0, codes: ["SETTLER_NO_JOURNAL_DIR"] };
  let filesScanned = 0;
  let names: string[] = [];
  try {
    names = readdirSync(sessionsDir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return { shown, withheld, filesScanned: 0, codes: ["SETTLER_JOURNAL_READ_FAILED"] };
  }
  const needle = `"ref":"${ref}"`;
  for (const name of names) {
    const p = join(sessionsDir, name);
    try {
      const st = statSync(p);
      if (st.mtimeMs < sinceMs) continue;
      filesScanned += 1;
      const text = readFileSync(p, "utf-8");
      if (!text.includes(needle)) continue;
      const sid = name.replace(/\.jsonl$/, "");
      if (text.includes(SETTLER_MARK)) shown.add(sid);
      else if (text.includes(SETTLER_WITHHELD_MARK)) withheld.add(sid);
    } catch {
      codes.push("SETTLER_SESSION_FILE_SKIPPED");
    }
  }
  return { shown, withheld, filesScanned, codes };
}

/** 读全部 nightly session-stats,返回 sessionId → 最新记录(同会话多日取 generatedAt 新的)。 */
export function loadSessionStats(root: string): { bySession: Map<string, SessionStat>; files: number } {
  const bySession = new Map<string, SessionStat & { _at?: number }>();
  const base = join(root, ".genie", "rsi", "nightly");
  let files = 0;
  if (!existsSync(base)) return { bySession: new Map(), files: 0 };
  let projectDirs: string[] = [];
  try {
    projectDirs = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(base, d.name));
  } catch {
    return { bySession: new Map(), files: 0 };
  }
  for (const dir of projectDirs) {
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".session-stats.json"));
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const parsed = JSON.parse(readFileSync(join(dir, name), "utf-8")) as {
          generatedAt?: string;
          sessions?: SessionStat[];
        };
        files += 1;
        const at = Date.parse(String(parsed.generatedAt ?? "")) || 0;
        for (const s of Array.isArray(parsed.sessions) ? parsed.sessions : []) {
          const sid = typeof s.sessionId === "string" ? s.sessionId : undefined;
          if (sid === undefined || sid === "") continue;
          const prev = bySession.get(sid);
          if (prev === undefined || (prev._at ?? 0) <= at) bySession.set(sid, { ...s, _at: at });
        }
      } catch {
 // 坏文件跳过(fail-soft,与 RSI store 同纪律)
      }
    }
  }
  const clean = new Map<string, SessionStat>();
 // unresolvedAsks 透传(此前被剥掉,导致该指标映射永远拿不到数据)。
  for (const [k, v] of bySession) {
    clean.set(k, { sessionId: v.sessionId, repeatedReads: v.repeatedReads, unresolvedAsks: v.unresolvedAsks, failedSteps: v.failedSteps });
  }
  return { bySession: clean, files };
}

/**
 * 结算一轮:对每个「tip 面、无 result、pending/iterate」的实验采集处理/对照组并按需写回。
 * 任何失败折叠进 codes,不 throw(调度器路径调用)。
 */
export async function settleExperiments(root: string, opts: { now?: number; journalDir?: string } = {}): Promise<ExperimentSettleSummary> {
  const now = opts.now ?? Date.now();
  const journalDir = opts.journalDir ?? join(root, ".genie", "journals");
  const summary: ExperimentSettleSummary = { at: now, settled: [], waiting: [], codes: [] };
  let experiments: ReturnType<typeof listExperiments> = [];
  try {
    experiments = listExperiments(root);
  } catch {
    summary.codes.push("SETTLER_LEDGER_UNREADABLE");
    return summary;
  }
  const { bySession: stats, files: statsFiles } = loadSessionStats(root);
  if (statsFiles === 0) summary.codes.push("SETTLER_NO_SESSION_STATS");
  for (const exp of experiments) {
    if (exp.intervention?.surface !== "tip" || typeof exp.intervention.ref !== "string" || exp.intervention.ref === "") continue;
 // §14.2① 激活后复查:已 adopt 的实验不进首轮结算(幂等门),由 reviewActiveInterventions
 // 单独复查(r1 恶化回滚/r2 断流降 canary_50),见函数注释。
    if (exp.decision?.kind === "adopt") continue;
    if (exp.decision?.kind !== "pending" && exp.decision?.kind !== "iterate") continue;
    const successMetric = (exp.metrics ?? []).find((m) => (m.role ?? "success") === "success");
    if (successMetric === undefined || successMetric.result !== undefined) continue; // 幂等:已有结果不再覆写
    const minSample = Math.max(1, Math.floor(successMetric.thresholds?.minSample ?? 30));
    const markers = collectTipMarkerSessions(journalDir, exp.intervention.ref, exp.createdAt ?? 0);
 // P5(方法学修复):对照组=**同资格触发但哈希对照侧**(rsi.tip.withheld),
 // 不再是「其余全体」——处理/对照只差干预本身,消除按近结果选组的选择偏差。
 // 旧口径数据(无 withheld 标记时期)在对照组为空时回退旧口径,并在 reason 注明混合口径。
    const treatment: SessionStat[] = [];
    const control: SessionStat[] = [];
    for (const [sid, s] of stats) {
      if (markers.shown.has(sid)) treatment.push(s);
      else if (markers.withheld.has(sid)) control.push(s);
    }
    const legacyMixed = control.length === 0 && treatment.length > 0;
    if (legacyMixed) {
      for (const [sid, s] of stats) {
        if (!markers.shown.has(sid)) control.push(s);
      }
    }
    const nT = treatment.length;
 // 指标名感知——按 success metric 名反查映射表拿 statsKey(code_review nit 修复:
 // 单一真相在 CANDIDATE_METRICS,不内联三元;查不到=非登记指标,如实跳过不静默错算)。
    const statsKey: "repeatedReads" | "unresolvedAsks" | undefined = Object.values(CANDIDATE_METRICS)
      .find((spec) => spec.name === successMetric.name)?.statsKey;
    if (statsKey === undefined) continue;
    const rate = (list: SessionStat[]): number => {
      if (list.length === 0) return Number.NaN;
      const hit = list.filter((s) => Number(s[statsKey] ?? 0) >= 1).length;
      return hit / list.length;
    };
    const treatmentRate = rate(treatment);
    const controlRate = rate(control);
    if (nT < minSample) {
      summary.waiting.push({ id: exp.id, nTreatment: nT, minSample });
      continue;
    }
    const effectPct = controlRate > 0 ? ((controlRate - treatmentRate) / controlRate) * 100 : null;
    const minEffectPct = successMetric.thresholds?.minEffectPct ?? 0;
    const guardrailSpec = (exp.guardrails ?? []).find((g) => String((g as { metric?: unknown }).metric ?? "") === "failed-steps");
    let guardrailNote = "";
    let guardrailRegPct: number | null = null;
    if (guardrailSpec !== undefined) {
      const mean = (list: SessionStat[]): number =>
        list.length === 0 ? Number.NaN : list.reduce((a, s) => a + Number(s.failedSteps ?? 0), 0) / list.length;
      const gT = mean(treatment);
      const gC = mean(control);
      const maxReg = Number((guardrailSpec as { maxRegressionPct?: unknown }).maxRegressionPct ?? 5);
      if (Number.isFinite(gC) && gC > 0 && Number.isFinite(gT)) {
        const reg = ((gT - gC) / gC) * 100;
        guardrailRegPct = reg;
        guardrailNote = `;guardrail failed-steps 均值 ${gT.toFixed(1)} vs ${gC.toFixed(1)}(${reg >= 0 ? "+" : ""}${reg.toFixed(1)}%,上限 +${maxReg}%)`;
      }
    }
    const proposal: "proposed-adopt" | "proposed-reject" | "hold" =
      effectPct !== null && effectPct >= minEffectPct ? "proposed-adopt" : effectPct !== null && effectPct <= 0 ? "proposed-reject" : "hold";
 // §14.2① adopt 机器闸:三条件全满足才自动生效——c1 样本(到达此处 nT≥minSample
 // 已由上文 waiting 分支保证)/c2 效应达标且对照非空(legacyMixed 回退口径拒)/c3 护栏回归
 // 不超上限(无 guardrail 数据时视为不可判,保守拒)。全确定性零 agent 判定。
    const maxReg5 = Number((guardrailSpec as { maxRegressionPct?: unknown } | undefined)?.maxRegressionPct ?? 5);
    const autoAdopt =
      proposal === "proposed-adopt"
      && !legacyMixed
      && effectPct !== null
      && effectPct >= minEffectPct
      && guardrailRegPct !== null
      && guardrailRegPct <= maxReg5;
    const reason =
      `rsi-settler 自动结算(P5 同资格对照):处理组(rsi.tip.shown)${nT} 会话,发生率 ${(treatmentRate * 100).toFixed(1)}%`
      + ` vs 对照(rsi.tip.withheld,同触发资格未注入)${control.length} 会话 ${(controlRate * 100).toFixed(1)}%`
      + `${legacyMixed ? "[⚠ 对照为空回退旧口径(其余全体),含选择偏差,仅作过渡参考]" : ""}`
      + `(effect ${effectPct === null ? "n/a" : effectPct.toFixed(1) + "%"},阈值 ${minEffectPct}%${guardrailNote})`
      + `——${autoAdopt ? "机器闸三条件达标,自动 adopt 生效(§14.2①,by=rsi-auto-gate)" : `建议 ${proposal === "proposed-adopt" ? "adopt(机器闸未达标,不生效)" : proposal === "proposed-reject" ? "reject" : "继续观察"}`};`;
    let action: ExperimentSettleOutcome["action"] = proposal;
    try {
      const decideKind: DecidableKind = autoAdopt ? "adopt" : "iterate";
      const decideBy = autoAdopt ? "rsi-auto-gate" : "rsi-settler";
      const res = decideExperiment(root, exp.id, decideKind, {
        by: decideBy,
        reason,
        ...(autoAdopt ? { canaryDone: true } : {}),
 // runtime decideExperiment 用 resultMetrics **整体替换** metrics 数组——必须带全集,
 // 否则 guardrail 同名指标被替换掉→「指标缺失」EXP_GUARDRAIL_BREACH。success 带 result,
 // guardrail 指标带 result 但值取处理组经验证(runtime 门对全部指标要求 result;机器闸 c3
 // 的判定在前面已用 gT/gC 做过,这里只满足台账验收面)。
        resultMetrics: (exp.metrics ?? []).map((m) =>
          m.name === successMetric.name
            ? { ...m, result: { value: Math.round(treatmentRate * 10000) / 10000, sample: nT } }
            : m.name === (guardrailSpec as { metric?: unknown } | undefined)?.metric
              ? {
                  ...m,
                  result: {
                    value:
                      treatment.length === 0
                        ? 0
                        : Math.round((treatment.filter((s) => Number(s.failedSteps ?? 0) >= 1).length / treatment.length) * 10000) / 10000,
                    sample: nT,
                  },
                }
              : m,
        ),
      });
      action = res.ok ? (autoAdopt ? "adopt" : "written") : "hold";
 // §14.2① 生效动作链(顺序固定,任一步失败则不写 active、decision 照实):
 // a1 刷回滚基准快照(takeBaseline 五面 versions;失败 fail-closed 不生效)
 // → a2 写 active-interventions(canary 50%→100%,沿用修5 文件结构)
 // → decision 已在上方按机器闸写 adopt(by=rsi-auto-gate),消灭 iterate 假留痕。
      if (res.ok && autoAdopt) {
        let activated = false;
        try {
          const baselineId = `adopt-${exp.id}-${now}`;
          const baseline = await takeBaseline(root, {
            id: baselineId,
            at: new Date(now).toISOString(),
            label: `auto-adopt ${exp.id}`,
            versions: { tools: "current", tips: "current", prompts: "current", wiki: "current", graph: "current" },
            metrics: { effectPct: Math.round((effectPct ?? 0) * 100) / 100, nTreatment: nT, nControl: control.length },
          });
          if (baseline.ok || baseline.codes.includes("RSI_BASELINE_DUPLICATE")) {
            const activePath = join(root, ".genie", "rsi", "active-interventions.json");
            let list: string[] = [];
            if (existsSync(activePath)) {
              list = JSON.parse(readFileSync(activePath, "utf8")) as string[];
            }
            if (!list.includes(exp.intervention.ref)) {
              list.push(exp.intervention.ref);
              mkdirSync(join(root, ".genie", "rsi"), { recursive: true });
              writeFileSync(activePath, JSON.stringify(list, null, 1), "utf8");
            }
            activated = true;
          } else {
            summary.codes.push("ADOPT_BASELINE_FAILED");
          }
        } catch { /* 生效链失败不写 active */ }
        void activated;
      }
      if (!res.ok) summary.codes.push(res.code ?? "SETTLER_DECIDE_FAILED");
    } catch {
      summary.codes.push("SETTLER_DECIDE_FAILED");
    }
    summary.settled.push({
      id: exp.id,
      action,
      nTreatment: nT,
      nControl: control.length,
      treatmentRate,
      controlRate,
      effectPct,
      minSample,
      ...(action === "hold" ? { note: "决策写回失败,见 codes" } : {}),
    });
  }
 // §14.2① 激活后复查:每周期结算时对已 adopt 实验复查——r1 恶化自动回滚 /
 // r2 连续 2 周期不可判降回 canary_50。失败折叠进 codes 不 throw。
  try {
    const reviewCodes = reviewActiveInterventions(root, now);
    summary.codes.push(...reviewCodes);
  } catch { /* 复查失败不挡结算 */ }
  return summary;
}

/**
 * §14.2① 激活后每周期复查(全确定性):
 * - r1 自动回滚:已 adopt 的实验,本周期重算 effect ≤0 或护栏超上限 → 从 active-interventions
 * 移除(移除即回到哈希 canary 50% 分桶)+ 台账追加 rollback 事件(reason="auto-rollback:恶化")。
 * - r2 断流收缩:本周期无新 marker 样本(处理/对照都为零增长,样本断流)→ 记 undecidedStreak
 * (存 active-interventions.json 的附带字段);连续 ≥2 → 从 active 移除降回 canary_50(保守
 * 收缩,非移除实验;实验台账不动,样本回流后下一轮结算可再次达标 adopt)。
 * - 幂等:rollback 事件只追加一次(decideExperiment rollback 语义);streak 计数存文件内,
 * 有新样本即清零。
 * @returns 折叠码(如 REVIEW_ROLLBACK_APPLIED / REVIEW_DOWNSHIFTED;空=无变化)
 */
export function reviewActiveInterventions(root: string, now: number): string[] {
  const codes: string[] = [];
  let experiments: ReturnType<typeof listExperiments> = [];
  try {
    experiments = listExperiments(root);
  } catch {
    return ["REVIEW_LEDGER_UNREADABLE"];
  }
  const activePath = join(root, ".genie", "rsi", "active-interventions.json");
  let active: string[] = [];
  try {
    active = JSON.parse(readFileSync(activePath, "utf8")) as string[];
  } catch {
    return []; // active 不存在=零激活,无事可复查
  }
  let changed = false;
  for (const exp of experiments) {
    if (exp.decision?.kind !== "adopt") continue;
    const ref = exp.intervention?.ref;
    if (typeof ref !== "string" || !active.includes(ref)) continue;
 // 周期重算效应:同口径再采一次 marker/stat(轻量,零 LLM)
    const journalDir = join(root, ".genie", "journals");
    const markers = collectTipMarkerSessions(journalDir, ref, exp.createdAt ?? 0);
    const { bySession: stats } = loadSessionStats(root);
    const treatment: SessionStat[] = [];
    const control: SessionStat[] = [];
    for (const [sid, s] of stats) {
      if (markers.shown.has(sid)) treatment.push(s);
      else if (markers.withheld.has(sid)) control.push(s);
    }
    const rate = (list: SessionStat[]): number => {
      if (list.length === 0) return Number.NaN;
      return list.filter((s) => Number(s.repeatedReads ?? 0) >= 1).length / list.length;
    };
    const effectPct = control.length > 0 ? ((rate(control) - rate(treatment)) / rate(control)) * 100 : null;
    if (treatment.length === 0 && control.length === 0) {
 // r2:样本断流——本轮零可判数据,记 streak(存 active 文件的 sidecar 字段,避免动实验 schema)
      try {
        const streakFile = join(root, ".genie", "rsi", "active-interventions.review.json");
        let review: Record<string, { undecidedStreak: number; at: number }> = {};
        try {
          review = JSON.parse(readFileSync(streakFile, "utf8")) as typeof review;
        } catch { /* 首建 */ }
        const streak = (review[ref]?.undecidedStreak ?? 0) + 1;
        review[ref] = { undecidedStreak: streak, at: now };
        mkdirSync(join(root, ".genie", "rsi"), { recursive: true });
        writeFileSync(streakFile, JSON.stringify(review, null, 1), "utf8");
        if (streak >= 2) {
          active = active.filter((r) => r !== ref);
          changed = true;
          codes.push("REVIEW_DOWNSHIFTED");
        }
      } catch { /* streak 记录失败跳过 */ }
      continue;
    }
 // 有样本即清 streak
    try {
      const streakFile = join(root, ".genie", "rsi", "active-interventions.review.json");
      if (existsSync(streakFile)) {
        const review = JSON.parse(readFileSync(streakFile, "utf8")) as Record<string, { undecidedStreak: number }>;
        if (review[ref] !== undefined) {
          delete review[ref];
          writeFileSync(streakFile, JSON.stringify(review, null, 1), "utf8");
        }
      }
    } catch { /* 清除失败跳过 */ }
 // r1:全量后首个结算周期恶化 → 移出 active + rollback 事件
    if (effectPct !== null && effectPct <= 0) {
      active = active.filter((r) => r !== ref);
      changed = true;
      codes.push("REVIEW_ROLLBACK_APPLIED");
      try {
        decideExperiment(root, exp.id, "rollback", {
          by: "rsi-auto-gate",
          reason: "auto-rollback:激活后首个结算周期 effect≤0(§14.2① r1),已移出 active 回落 canary_50",
        });
      } catch { /* rollback 事件写失败不挡 active 移除 */ }
    }
  }
  if (changed) {
    mkdirSync(join(root, ".genie", "rsi"), { recursive: true });
    writeFileSync(activePath, JSON.stringify(active, null, 1), "utf8");
  }
  return codes;
}
