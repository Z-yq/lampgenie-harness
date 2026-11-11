/**
 * 变更意图分类的「可更正路径」(。
 * classifyChangeScope 是纯词表启发式,必然误判:显式小改标记只能压住一部分
 * (`改成` 既能是全链路换代也能是单点改值)。本模块给 agent 一条显式更正通道——
 * agent 说「这条其实是 surface/normal」→ 落 journal `custom/change.scope.correction`
 * → plan-gate 立即按更正后的结论判定(不再等下一轮),未更正则旧行为逐字不变。
 * 纯逻辑:零 IO、不改入参、不 throw、确定性(同一输入同一输出)。
 * journal 只由调用方(change_surface action=classify)写;本模块只负责结构与读取。
 */

export const CHANGE_SCOPE_KINDS = ["surface", "normal"] as const;
export type ChangeScopeKind = (typeof CHANGE_SCOPE_KINDS)[number];

/** 事件类型名(落 journal 的 payload.type,也是回执里的 audit 标记)。 */
export const CHANGE_SCOPE_CORRECTION_TYPE = "change.scope.correction";

/** 自动分类结果(只取本模块需要的两维)。 */
export interface ChangeScopeBase {
  scope: ChangeScopeKind;
  matched: string[];
}

/** 一条合法更正。by/reason 非空,at 是毫秒时间戳。 */
export interface ChangeScopeCorrection {
  scope: ChangeScopeKind;
  by: string;
  reason: string;
  at: number;
}

/** 更正后的判定(含来源与更正者,便于审计回读)。 */
export interface CorrectedChangeScope {
  ok: true;
  scope: ChangeScopeKind;
  matched: [];
  source: "corrected";
  correctedBy: string;
  correctedReason: string;
  correctedAt: number;
}

export type ChangeScopeCorrectionResult = CorrectedChangeScope | { ok: false; code: "INVALID" };

const REASON_MAX = 300;

/** 合法取值原样返回,否则 null(不做大小写/别名宽松,避免把拼错当更正)。 */
export function normalizeChangeScopeKind(v: unknown): ChangeScopeKind | null {
  return v === "surface" || v === "normal" ? v : null;
}

/** 更正对象规整:结构坏的返回 null(读取侧跳过,不 throw)。 */
export function normalizeChangeScopeCorrection(v: unknown): ChangeScopeCorrection | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const scope = normalizeChangeScopeKind(o.scope);
  if (!scope) return null;
  if (typeof o.by !== "string" || !o.by.trim()) return null;
  if (typeof o.reason !== "string" || !o.reason.trim()) return null;
  if (typeof o.at !== "number" || !Number.isFinite(o.at)) return null;
  return { scope, by: o.by.trim(), reason: o.reason.trim(), at: o.at };
}

/**
 * 把更正应用到自动分类结果上。
 * 合法 → 新对象(scope 被覆盖、matched 清空=不再是启发式命中,source=corrected);不改 base。
 * by/reason 空或结构非法 → `{ok:false, code:"INVALID"}`(不 throw,调用方据此拒绝并回执)。
 */
export function applyChangeScopeCorrection(
  base: ChangeScopeBase,
  correction: unknown): ChangeScopeCorrectionResult {
  const c = normalizeChangeScopeCorrection(correction);
  if (!c) return { ok: false, code: "INVALID" };
  if (c.reason.length > REASON_MAX) return { ok: false, code: "INVALID" };
 // base 只读(保留形参语义:方案是「在自动分类结果上覆盖」,不是「用更正替换任务指令」)。
  void base;
  return {
    ok: true,
    scope: c.scope,
    matched: [],
    source: "corrected",
    correctedBy: c.by,
    correctedReason: c.reason,
    correctedAt: c.at,
  };
}

/** journal `custom` 事件的 payload:稳定形状(回放与读取共用同一口径)。 */
export function changeScopeCorrectionEvent(correction: ChangeScopeCorrection): {
  type: typeof CHANGE_SCOPE_CORRECTION_TYPE;
  scope: ChangeScopeKind;
  by: string;
  reason: string;
  at: number;
} {
  return {
    type: CHANGE_SCOPE_CORRECTION_TYPE,
    scope: correction.scope,
    by: correction.by,
    reason: correction.reason,
    at: correction.at,
  };
}

/** 读 journal 事件时的最小形状(区别于 runtime 的 JournalEvent,测试可造字面量)。 */
export interface ChangeScopeCorrectionEventLike {
  kind?: string;
  sessionId?: string;
  payload?: unknown;
}

/**
 * 本会话最近一条合法更正;没有则 null。
 * - 只认 kind=custom(缺 kind 的测试字面量也接受)且 payload.type 匹配的事件;
 * - 结构坏的跳过(不抛、不中断扫描),取最后一条合法者(=重复更正以后者为准)。
 */
export function readChangeScopeCorrection(
  events: readonly ChangeScopeCorrectionEventLike[],
  sessionId: string): ChangeScopeCorrection | null {
  if (!Array.isArray(events)) return null;
  let found: ChangeScopeCorrection | null = null;
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    if (e.kind !== undefined && e.kind !== "custom") continue;
    if (e.sessionId !== undefined && e.sessionId !== sessionId) continue;
    const p = e.payload;
    if (!p || typeof p !== "object" || Array.isArray(p)) continue;
    const o = p as Record<string, unknown>;
    if (o.type !== CHANGE_SCOPE_CORRECTION_TYPE) continue;
    const c = normalizeChangeScopeCorrection(o);
    if (!c) continue;
    found = c;
  }
  return found;
}

/**
 * 纪律切换提示(回执带一句,让 agent 立刻知道下一步该干什么):
 * - surface → normal:不再要求全链路盘点,但收尾审计标记仍在;
 * - normal → surface:先 change_surface scan 再改;
 * - 无变化(含 previous 缺省)= 空串。
 */
export function disciplineHintFor(scope: ChangeScopeKind, previousScope?: ChangeScopeKind): string {
  if (!previousScope || previousScope === scope) return "";
  if (scope === "normal") {
    return "已降级为普通变更：不再要求全链路盘点，但仍需收尾审计标记";
  }
  return "已升级为全链路变更：先 change_surface scan 再改";
}
