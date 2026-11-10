/**
 * 公共任务收尾聚合(///// 唯一实现。
 * 背景:主 agent 收尾段已实现六条机制,但子代理(LlmLoopBackend)与 super agent 的收尾
 * 完全没接(机制接线审计 partial)。本模块把六条机制的「聚合 + 落事件 + 提示渲染」收成
 * 一处,三条链(main/subagent/super)复用同一实现,避免三份口径分叉。
 * 模式差异:
 * - main:保留既有语义——hard 模式可经 `retryTurn` 补跑一轮,仍不满足则返回 hardFail
 *   (由调用方 setState failed);warn 模式把警告追加进 finalText。
 * - subagent / super:warn-only,绝不 hardFail、绝不补跑;终稿追加紧凑「## 收尾审计」段
 *   (仅非 na 项,≤1200 字;全 na 不追加)。
 * 幂等:同一 journal + session + task + 事件 type 只落一次(模块级 WeakMap);主 agent 的
 * 收尾分两段调用(终态路径 + finally)也不会重复落事件。补跑后的二次记录用 keySuffix 区分。
 */
import {
  computeChangeLedger,
  type ChangeBaseline,
  type ChangeLedger,
} from "./turn-change-ledger.js";
import { computeGuidanceMetrics, type GuidanceMetrics, type GuidanceMetricsEvent } from "./guidance-metrics.js";
import {
  computeVerifyLedger,
  renderVerifyRetryPrompt,
  renderVerifyLedgerWarning,
  type VerifyLedger,
  type VerifyLedgerEvent,
} from "./verification-ledger.js";
import {
  auditCitations,
  readCitations,
  renderCitationRetryPrompt,
  renderCitationWarning,
  shouldAuditCitations,
  type CitationJournal,
} from "./citation-ledger.js";
import {
  readDeliverables,
  renderDeliverableWarning,
  renderDeliverables,
  verifyDeliverables,
  type DeliverableJournal,
  type DeliverableRecord,
  type VerifiedDeliverable,
} from "./deliverables.js";
import {
  buildCompletionAudit,
  type CompletionAudit,
  type CompletionFacts,
} from "./completion-audit.js";

export type CloseoutMode = "main" | "subagent" | "super";
export type CloseoutState = "done" | "failed" | "cancelled";
export type CloseoutStep = "m16" | "m23" | "m107" | "m169" | "m170" | "m5";

/** 收尾事件聚合所需的最小 journal 面(测试可直接喂假 journal)。 */
export interface CloseoutEvent {
  seq?: number;
  kind: string;
  time?: number;
  payload?: unknown;
}

export interface CloseoutJournal {
  append(e: { kind: string; sessionId: string; payload?: unknown; idempotencyKey?: string }): unknown;
  readAll(): CloseoutEvent[];
  readSession(sessionId: string, sinceSeq?: number): CloseoutEvent[];
}

export interface CloseoutCitationsFact {
  inScope: boolean;
  registered: number;
  missing: number;
}

export interface CloseoutReport {
  changeLedger?: ChangeLedger;
  guidance?: GuidanceMetrics;
  verify?: VerifyLedger;
  citations?: CloseoutCitationsFact;
  deliverables?: { declared: DeliverableRecord[]; checked: VerifiedDeliverable[] };
  completion?: CompletionAudit;
}

export interface CloseoutHardFail {
  kind: "verify" | "citation" | "completion";
  reason: string;
}

export interface TaskCloseoutInput {
  journal: CloseoutJournal;
  sessionId: string;
  taskId: string;
  /** 任务根(验证账本相对路径展示 / 交付物路径解析根)。 */
  root: string;
  /** 任务窗口起点水位:`journal.readSession(sessionId, taskStartSeq)`。 */
  taskStartSeq: number;
  state: CloseoutState;
  finalText: string;
  taskClass?: string;
  instruction?: string;
 /**  基线;无基线(git 失败/未采集)时该段跳过。 */
  baseline?: ChangeBaseline | null;
 /** 主 agent 已采集的白板事实( board 行)。 */
  boardFacts?: CompletionFacts["board"];
 /** 主 agent 已采集的全链路审计事实( change 行)。 */
  changeFacts?: CompletionFacts["change"];
 /** 主 agent 已采集的变更账本事实( change-ledger 行;sub/super 由  段自算)。 */
  ledgerFacts?: CompletionFacts["ledger"];
  mode: CloseoutMode;
  /** 仅 main 生效:hard 机制开关(modes 优先于 hardFlags)。 */
  hardFlags?: { changeAudit?: boolean; verifyOnStop?: boolean; completionAudit?: boolean; citationAudit?: boolean };
  /** 已解析的机制策略(off/warn/hard),缺省按 hardFlags 推导为 warn。 */
  modes?: { verify?: string; citation?: string; completion?: string };
  /** main hard 补跑:把提示喂回 loop.runTurn;缺省=不补跑,按现状判定。 */
  retryTurn?: (prompt: string) => Promise<string | null | undefined>;
  /** 限定本次执行的机制段(缺省:main=m107/m169/m170/m5;sub/super=全部六项)。 */
  steps?: readonly CloseoutStep[];
}

export interface TaskCloseoutResult {
  finalText: string;
  report: CloseoutReport;
  hardFail?: CloseoutHardFail;
  /** 本次实际落盘的事件 type(补跑二次记录带 `#retry` 后缀)。 */
  appendedEvents: string[];
}

/** 收尾审计段硬上限(字符)。 */
export const CLOSEOUT_SECTION_MAX = 1200;

const STATUS_ICON: Record<string, string> = { pass: "✅", warn: "⚠", fail: "❌", na: "–" };

/** 模块级幂等表:同一 journal 对象 + session + task + type(+suffix)只落一次。 */
const ONCE = new WeakMap<object, Set<string>>();

function onceSet(journal: CloseoutJournal): Set<string> {
  let s = ONCE.get(journal as unknown as object);
  if (!s) {
    s = new Set<string>();
    ONCE.set(journal as unknown as object, s);
  }
  return s;
}

/** 落一条 custom 事件(同 key 只落一次);返回事件 type,跳过/失败返回 null。 */
function appendOnce(
  journal: CloseoutJournal,
  sessionId: string,
  taskId: string,
  type: string,
  payload: Record<string, unknown>,
  suffix = "",
): string | null {
  const key = `${sessionId}|${taskId}|${type}${suffix ? `|${suffix}` : ""}`;
  const set = onceSet(journal);
  if (set.has(key)) return null;
  set.add(key);
  try {
    journal.append({ kind: "custom", sessionId, payload: { type, taskId, ...payload } });
  } catch {
    return null; // 留痕失败不影响收尾
  }
  return suffix ? `${type}#${suffix}` : type;
}

/** sub/super 的紧凑收尾段:只列非 na 项,总长 ≤ CLOSEOUT_SECTION_MAX;全 na 返回 ""。 */
export function renderCloseoutSection(audit: CompletionAudit): string {
  const lines = audit.items
    .filter((i) => i.status !== "na")
    .map((i) => `- ${STATUS_ICON[i.status] ?? "·"} ${i.label}:${i.detail}`);
  if (!lines.length) return "";
  const text = ["## 收尾审计", ...lines].join("\n");
  return text.length > CLOSEOUT_SECTION_MAX ? `${text.slice(0, CLOSEOUT_SECTION_MAX - 1)}…` : text;
}

const DEFAULT_STEPS: Record<CloseoutMode, readonly CloseoutStep[]> = {
  main: ["m107", "m169", "m170", "m5"],
  subagent: ["m16", "m23", "m107", "m169", "m170", "m5"],
  super: ["m16", "m23", "m107", "m169", "m170", "m5"],
};

/** 跑一次任务收尾聚合。不抛错(各段内部吞异常,收尾路径不被打断)。 */
export async function runTaskCloseout(input: TaskCloseoutInput): Promise<TaskCloseoutResult> {
  const { journal, sessionId, taskId, root, taskStartSeq, state, mode } = input;
  const steps = input.steps ?? DEFAULT_STEPS[mode];
  const has = (s: CloseoutStep) => steps.includes(s);
  const verifyMode = input.modes?.verify ?? (input.hardFlags?.verifyOnStop ? "hard" : "warn");
  const citationMode = input.modes?.citation ?? (input.hardFlags?.citationAudit ? "hard" : "warn");
  const completionMode = input.modes?.completion ?? (input.hardFlags?.completionAudit ? "hard" : "warn");

  let finalText = String(input.finalText ?? "");
  const report: CloseoutReport = {};
  const appendedEvents: string[] = [];
  const push = (t: string | null) => {
    if (t) appendedEvents.push(t);
  };
  const addText = (t: string) => {
    if (t && t.trim()) finalText = `${finalText}\n\n${t}`;
  };
  const events = () => journal.readSession(sessionId, taskStartSeq);

 // ──  轮末变更账本 ────────────────────────────────────────────────
  if (has("m16") && input.baseline) {
    try {
      const led = await computeChangeLedger({
        root,
        baseline: input.baseline,
        endEvents: events() as unknown as VerifyLedgerEvent[],
      });
      report.changeLedger = led;
      push(appendOnce(journal, sessionId, taskId, "turn.change-ledger", {
        state,
        mode: led.mode,
        baselineCount: led.baselineCount,
        changed: led.changed,
        unknown: led.unknown,
        oversized: led.oversized,
        truncated: led.truncated,
      }));
    } catch {
      /* 账本失败不影响终态 */
    }
  }

 // ──  指导可度量 ──────────────────────────────────────────────────
  if (has("m23")) {
    try {
      const gm = computeGuidanceMetrics(events() as unknown as GuidanceMetricsEvent[]);
      report.guidance = gm;
      push(appendOnce(journal, sessionId, taskId, "guidance.metrics", {
        state,
        tips: gm.tips,
        counters: gm.counters,
        rates: gm.rates,
      }));
    } catch {
      /* 指标汇总失败不影响终态 */
    }
  }

 // ── 任务级验证账本 ─────────────────────────────────────────────
  if (has("m107") && verifyMode !== "off") {
    try {
      let ledger = computeVerifyLedger(events() as unknown as VerifyLedgerEvent[], root);
      report.verify = ledger;
      push(appendOnce(journal, sessionId, taskId, "verify.ledger", {
        stale: ledger.stale,
        reason: ledger.reason,
        verificationCount: ledger.verificationCount,
        lastVerification: ledger.lastVerification,
        writesAfter: ledger.writesAfter,
      }));
      if (ledger.stale && mode === "main" && verifyMode === "hard") {
        if (input.retryTurn) {
          push(appendOnce(journal, sessionId, taskId, "verify.ledger.retry", {
            reason: ledger.reason,
            files: ledger.writesAfter.map((w) => w.file),
          }));
          try {
            const out = await input.retryTurn(renderVerifyRetryPrompt(ledger));
            if (out) finalText = out;
          } catch {
            /* 二次 runTurn 不安全时直接按现状判定 */
          }
          ledger = computeVerifyLedger(events() as unknown as VerifyLedgerEvent[], root);
          report.verify = ledger;
          push(appendOnce(journal, sessionId, taskId, "verify.ledger", {
            stale: ledger.stale,
            reason: ledger.reason,
            verificationCount: ledger.verificationCount,
            lastVerification: ledger.lastVerification,
            writesAfter: ledger.writesAfter,
          }, "retry"));
        }
        if (ledger.stale) {
          const detail = ledger.reason === "no-verification"
            ? "改了代码但没有任何验证命令"
            : `最近一次验证之后又改了 ${ledger.writesAfter.length} 个代码文件:${ledger.writesAfter.map((w) => w.file).join("、")}`;
          const reason = `未通过验证账本(${detail};补跑一轮后仍 stale)`;
          push(appendOnce(journal, sessionId, taskId, "verify.ledger.hard-fail", {
            reason: reason.slice(0, 400),
            writesAfter: ledger.writesAfter,
          }));
          // 代码改动不回滚(与 changeAudit hard 同型);任务终态如实 failed,不许静默 done。
          return { finalText, report, appendedEvents, hardFail: { kind: "verify", reason } };
        }
      } else if (ledger.stale) {
        addText(renderVerifyLedgerWarning(ledger));
      }
    } catch {
      /* 验证账本失败不影响终态 */
    }
  }

 // ── 研究引用账本 ───────────────────────────────────────────────
  if (has("m169") && citationMode !== "off") {
    try {
      const records = readCitations(journal as unknown as CitationJournal, sessionId, taskId);
      const inScope = shouldAuditCitations({
        taskClass: input.taskClass,
        instruction: input.instruction,
        registeredCount: records.length,
      });
      if (!inScope) {
        report.citations = { inScope: false, registered: records.length, missing: 0 };
      } else {
        let ca = auditCitations(finalText, records);
        report.citations = { inScope: true, registered: records.length, missing: ca.missing.length };
        push(appendOnce(journal, sessionId, taskId, "citation.audit", {
          registered: ca.registered.length,
          cited: ca.cited,
          missing: ca.missing,
          unused: ca.unused,
          registeredUrls: ca.registered.map((r) => r.url).slice(0, 20),
        }));
        if (ca.missing.length && mode === "main" && citationMode === "hard") {
          if (input.retryTurn) {
            push(appendOnce(journal, sessionId, taskId, "citation.audit.retry", { missing: ca.missing }));
            try {
              const out = await input.retryTurn(renderCitationRetryPrompt(ca));
              if (out) finalText = out;
            } catch {
              /* 二次 runTurn 不安全:直接按现状判定 */
            }
            ca = auditCitations(
              finalText,
              readCitations(journal as unknown as CitationJournal, sessionId, taskId),
            );
            report.citations = { inScope: true, registered: ca.registered.length, missing: ca.missing.length };
            push(appendOnce(journal, sessionId, taskId, "citation.audit", {
              registered: ca.registered.length,
              cited: ca.cited,
              missing: ca.missing,
              unused: ca.unused,
              registeredUrls: ca.registered.map((r) => r.url).slice(0, 20),
            }, "retry"));
          }
          if (ca.missing.length) {
            const detail = ca.missing.map((n) => `[${n}]`).join("");
            const reason = `未通过引用账本(正文引用 ${detail} 未登记/越界;补跑一轮后仍缺)`;
            push(appendOnce(journal, sessionId, taskId, "citation.audit.hard-fail", {
              reason: reason.slice(0, 400),
              missing: ca.missing,
            }));
            // 引用可后续补(与 changeAudit hard 同型):任务终态如实 failed,不许静默 done。
            return { finalText, report, appendedEvents, hardFail: { kind: "citation", reason } };
          }
        }
        addText(renderCitationWarning(ca));
      }
    } catch {
      /* 引用账本失败不影响收尾 */
    }
  }

 // ── 交付物核对 ─────────────────────────────────────────────────
  if (has("m170")) {
    try {
      const declared = readDeliverables(journal as unknown as DeliverableJournal, sessionId, taskId);
      const checked = verifyDeliverables(declared);
      report.deliverables = { declared, checked };
      if (declared.length) {
        push(appendOnce(journal, sessionId, taskId, "deliverable.verified", { items: checked }));
        addText(renderDeliverables(checked));
        addText(renderDeliverableWarning(checked));
      }
    } catch {
      /* 核对失败不影响收尾 */
    }
  }

 // ──  完成审计 ─────────────────────────────────────────────────────
  if (has("m5") && completionMode !== "off") {
    try {
      const collect = (): CompletionFacts => {
        const facts: CompletionFacts = {};
        if (input.boardFacts) facts.board = input.boardFacts;
        try {
          const l = computeVerifyLedger(events() as unknown as VerifyLedgerEvent[], root);
          facts.verify = {
            stale: l.stale,
            reason: l.reason,
            writes: l.codeWriteCount,
            verificationCount: l.verificationCount,
          };
        } catch {
          /* 该行 na */
        }
        try {
          const declared = readDeliverables(journal as unknown as DeliverableJournal, sessionId, taskId);
          const checked = verifyDeliverables(declared);
          facts.deliverables = { declared: declared.length, missing: checked.filter((d) => !d.ok).length };
        } catch {
          /* 该行 na */
        }
        if (input.changeFacts) facts.change = input.changeFacts;
        try {
          const records = readCitations(journal as unknown as CitationJournal, sessionId, taskId);
          const ca = auditCitations(finalText, records);
          const inScope = input.modes?.citation === "off"
            ? false
            : shouldAuditCitations({
              taskClass: input.taskClass,
              instruction: input.instruction,
              registeredCount: records.length,
            });
          facts.citations = { inScope, registered: records.length, missing: ca.missing.length };
        } catch {
          /* 该行 na */
        }
        const ledgerFact = input.ledgerFacts
          ?? (report.changeLedger
            ? {
              changed: report.changeLedger.changed.length,
              unknown: report.changeLedger.unknown.length,
              oversized: report.changeLedger.oversized.length,
            }
            : undefined);
        if (ledgerFact) facts.ledger = ledgerFact;
        return facts;
      };

      let cAudit = buildCompletionAudit(collect());
      report.completion = cAudit;
      const recordCompletion = (a: CompletionAudit, suffix = "") =>
        push(appendOnce(journal, sessionId, taskId, "completion.audit", {
          passed: a.passed,
          warnings: a.warnings,
          fails: a.fails,
          items: a.items.map((i) => ({ id: i.id, status: i.status, label: i.label, detail: i.detail })),
          ...(suffix ? { retried: true } : {}),
        }, suffix));
      recordCompletion(cAudit);

      if (mode === "main") {
        addText(cAudit.rendered);
        if (completionMode === "hard" && !cAudit.passed) {
          const failLines = cAudit.items.filter((i) => i.status === "fail").map((i) => `${i.label}:${i.detail}`);
          let retryErr = "";
          if (input.retryTurn) {
            push(appendOnce(journal, sessionId, taskId, "completion.audit.retry", { fails: failLines }));
            try {
              const retryOut = await input.retryTurn(
                `[完成审计补跑] 收尾记分卡未通过,以下项缺什么补什么,补齐后重新汇报:\n${failLines.map((l) => `- ${l}`).join("\n")}`,
              );
              if (retryOut) finalText = retryOut;
            } catch (e: unknown) {
              // 二次 runTurn 不安全(消息历史/循环状态不允许):跳过补跑,直接按现状判定。
              retryErr = String(e instanceof Error ? e.message : e).slice(0, 200);
            }
            cAudit = buildCompletionAudit(collect());
            report.completion = cAudit;
            recordCompletion(cAudit, "retry");
          }
          if (!cAudit.passed) {
            const stillFails = cAudit.items.filter((i) => i.status === "fail").map((i) => `${i.label}:${i.detail}`);
            const reason = `未通过完成审计(${stillFails.join(";")}${retryErr ? `;补跑失败:${retryErr}` : ";补跑一轮后仍不满足"})`;
            push(appendOnce(journal, sessionId, taskId, "completion.audit.hard-fail", {
              reason: reason.slice(0, 400),
              items: stillFails,
            }));
            // 与 changeAudit/citation 的 hard 同型:交付物缺失等可后续补,但终态如实 failed。
            return { finalText, report, appendedEvents, hardFail: { kind: "completion", reason } };
          }
          if (cAudit.rendered) addText(cAudit.rendered);
        }
      } else {
        // sub/super:warn-only,紧凑「## 收尾审计」段(全 na 不追加)。
        addText(renderCloseoutSection(cAudit));
      }
    } catch {
      /* 完成审计失败不影响终态 */
    }
  }

  return { finalText, report, appendedEvents };
}
