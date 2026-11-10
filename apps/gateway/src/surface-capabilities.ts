/**
 * M167 表面/通道能力包(2026-11-08)。
 *
 * 问题(矩阵 #167 missing):不同「表面」(面板 / SMS / 手机 / 语音)的渲染与交互能力不同,
 * 但 agent 对所有表面输出同一形态:给 SMS 发 markdown 表格、宣称不能发文件、向无 UI 表面
 * 暴露面板工具、同一任务在弱表面语义静默变化。
 *
 * 口径(纯函数层,不碰 IO;可被测试与真实运行时共用):
 *   1. 客户端用 client.surface 声明能力位 {rendersMarkdown,maxChars,mediaKinds,hasUI};
 *   2. resolveSurfaceCaps:缺席 = LEGACY(当前面板行为,逐位兜底),有任一字段 = source client;
 *      maxChars clamp 500..1_000_000,mediaKinds 只留白名单;
 *   3. outputContract:按能力位拼「输出契约」注入主 agent instruction;legacy 返回空串(零变化);
 *   4. filterToolsForSurface:hasUI=false 时剔除 GUI 专属工具(面板/白板/审批/浏览器);
 *   5. degradeForSurface:最终输出超 maxChars → 截断 + 显式降级标记(不静默);legacy 不降级。
 *
 * 红线:legacy(没有任何声明)必须与改动前行为逐字一致 —— 契约空串、工具原样、不降级。
 */

export type SurfaceSource = "client" | "legacy";

export interface SurfaceCaps {
  rendersMarkdown: boolean;
  maxChars: number;
  mediaKinds: string[];
  hasUI: boolean;
  source: SurfaceSource;
}

/** 媒体类型白名单(未知类型丢弃,防客户端塞任意字符串进契约)。 */
export const SURFACE_MEDIA_KINDS = ["image", "file", "audio", "video", "link"] as const;
export type SurfaceMediaKind = (typeof SURFACE_MEDIA_KINDS)[number];

export const SURFACE_MAX_CHARS_MIN = 500;
export const SURFACE_MAX_CHARS_MAX = 1_000_000;

/** 当前面板行为(用户无声明时逐位沿用);source=legacy 是零变化的判据。 */
export const LEGACY_CAPS: SurfaceCaps = Object.freeze({
  rendersMarkdown: true,
  maxChars: 100_000,
  mediaKinds: [...SURFACE_MEDIA_KINDS],
  hasUI: true,
  source: "legacy",
}) as SurfaceCaps;

const CAP_FIELDS = ["rendersMarkdown", "maxChars", "mediaKinds", "hasUI"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasCapField(raw: Record<string, unknown>): boolean {
  return CAP_FIELDS.some((k) => Object.prototype.hasOwnProperty.call(raw, k) && raw[k] !== undefined);
}

function clampMaxChars(n: number): number {
  const r = Math.round(n);
  if (r < SURFACE_MAX_CHARS_MIN) return SURFACE_MAX_CHARS_MIN;
  if (r > SURFACE_MAX_CHARS_MAX) return SURFACE_MAX_CHARS_MAX;
  return r;
}

function normalizeMediaKinds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...LEGACY_CAPS.mediaKinds];
  const allowed = new Set<string>(SURFACE_MEDIA_KINDS);
  const out: string[] = [];
  for (const m of raw) {
    if (typeof m !== "string") continue;
    const v = m.trim().toLowerCase();
    // 未知媒体类型丢弃(不是错误),重复去重。
    if (!allowed.has(v) || out.includes(v)) continue;
    out.push(v);
  }
  return out;
}

/**
 * 解析能力位(宽松口径):字段缺失/类型不对 → 该字段取 LEGACY;有任一字段 → source=client。
 * 已知边界:maxChars 非有限数 → LEGACY(不猜),数值越界 → clamp。
 */
export function resolveSurfaceCaps(raw: unknown): SurfaceCaps {
  const r = isRecord(raw) ? raw : {};
  const rendersMarkdown = typeof r.rendersMarkdown === "boolean" ? r.rendersMarkdown : LEGACY_CAPS.rendersMarkdown;
  const hasUI = typeof r.hasUI === "boolean" ? r.hasUI : LEGACY_CAPS.hasUI;
  const maxChars = typeof r.maxChars === "number" && Number.isFinite(r.maxChars)
    ? clampMaxChars(r.maxChars)
    : LEGACY_CAPS.maxChars;
  const mediaKinds = Array.isArray(r.mediaKinds) ? normalizeMediaKinds(r.mediaKinds) : [...LEGACY_CAPS.mediaKinds];
  return {
    rendersMarkdown,
    maxChars,
    mediaKinds,
    hasUI,
    source: hasCapField(r) ? "client" : "legacy",
  };
}

/**
 * 严格校验客户端上报的字段类型(只判类型,不判值域):server 用它把坏字段变成
 * surface.result {ok:false,error} 且不落账;resolveSurfaceCaps 的宽松兜底只服务读侧。
 */
export function validateSurfaceRaw(raw: unknown): { ok: true } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: "invalid-surface:not-an-object" };
  if (raw.rendersMarkdown !== undefined && typeof raw.rendersMarkdown !== "boolean") {
    return { ok: false, error: "invalid-surface:rendersMarkdown" };
  }
  if (raw.hasUI !== undefined && typeof raw.hasUI !== "boolean") {
    return { ok: false, error: "invalid-surface:hasUI" };
  }
  if (raw.maxChars !== undefined && (typeof raw.maxChars !== "number" || !Number.isFinite(raw.maxChars))) {
    return { ok: false, error: "invalid-surface:maxChars" };
  }
  if (raw.mediaKinds !== undefined && (!Array.isArray(raw.mediaKinds) || raw.mediaKinds.some((m) => typeof m !== "string"))) {
    return { ok: false, error: "invalid-surface:mediaKinds" };
  }
  return { ok: true };
}

/**
 * 输出契约(注入 instruction 的文本块)。
 * - legacy → ""(不注入;面板行为逐字不变)
 * - 弱表面(rendersMarkdown=false)→ 纯文本/禁表格/禁围栏
 * - 强表面 → 允许 markdown/表格/代码块
 * 所有非 legacy 表面都带 maxChars 与允许媒体类型。
 */
export function outputContract(caps: SurfaceCaps): string {
  if (caps.source === "legacy") return "";
  const lines: string[] = ["## 表面输出契约(系统按客户端能力位自动注入)"];
  if (caps.rendersMarkdown) {
    lines.push("- 本表面支持 markdown:可用标题、列表、表格、代码块。");
  } else {
    lines.push("- 本表面为纯文本:禁 markdown 表格、禁标题(#)、禁代码围栏(```);列表用「- 」行前缀。");
  }
  lines.push(`- 单条输出 ≤ ${caps.maxChars} 字符(超出会被截断并显式标记降级)。`);
  if (caps.mediaKinds.length > 0) {
    lines.push(`- 只引用本表面允许的媒体类型:${caps.mediaKinds.join(" / ")};其它媒体不要输出引用或路径。`);
  } else {
    lines.push("- 本表面不支持任何媒体附件:不要输出图片/文件/音视频引用。");
  }
  if (!caps.hasUI) {
    lines.push("- 本表面无交互 UI:不要调用 ask_user / 白板 / 浏览器等 GUI 工具;需要人工确认的事直接在文本里说明。");
  }
  return lines.join("\n");
}

/**
 * GUI 专属工具(无 UI 表面必须剔除)。依据:
 * - ask_user / browser:直接依赖面板问答条与浏览器视图;
 * - board_upsert / board_read / board_export_pptx:白板渲染 + 面板白板视图(无 UI 表面看不到);
 * - deliverable 不在内(它只登记路径,弱表面仍可产出文件清单)。
 */
export const GUI_ONLY_TOOLS: readonly string[] = [
  "ask_user",
  "board_upsert",
  "board_read",
  "board_export_pptx",
  "browser",
];
const GUI_ONLY_SET = new Set<string>(GUI_ONLY_TOOLS);

/** hasUI=true 原样返回;false 剔除 GUI_ONLY_TOOLS 并把被剔除的工具名列出(留痕用)。 */
export function filterToolsForSurface<T extends { name: string }>(
  tools: readonly T[],
  caps: SurfaceCaps,
): { tools: T[]; filtered: string[] } {
  if (caps.hasUI) return { tools: [...tools], filtered: [] };
  const filtered: string[] = [];
  const kept = tools.filter((t) => {
    if (GUI_ONLY_SET.has(t.name)) {
      filtered.push(t.name);
      return false;
    }
    return true;
  });
  return { tools: kept, filtered };
}

export interface DegradeResult {
  text: string;
  degraded: boolean;
  originalChars: number;
  degradedChars: number;
}

/**
 * 显式降级:超 maxChars → 截断到上限并追加标记(标记本身不静默吞掉,是可见证据)。
 * legacy(没有任何客户端声明)不降级:保持改动前行为逐字不变。
 */
export function degradeForSurface(text: string, caps: SurfaceCaps): DegradeResult {
  const originalChars = text.length;
  if (caps.source === "legacy" || originalChars <= caps.maxChars) {
    return { text, degraded: false, originalChars, degradedChars: originalChars };
  }
  const marker = `\n\n[已降级:超出表面上限 ${caps.maxChars} 字符;完整内容见会话记录]`;
  const out = text.slice(0, caps.maxChars) + marker;
  return { text: out, degraded: true, originalChars, degradedChars: out.length };
}

// ── journal 侧(读最新声明 / 写 task.surface·surface.degraded)─────────────────

export interface SurfaceJournalLike {
  readSession(sessionId: string, sinceSeq?: number): ReadonlyArray<{ kind: string; sessionId: string; payload: unknown }>;
  append(event: { kind: string; sessionId: string; payload: unknown }): unknown;
}

function payloadType(payload: unknown): string {
  return isRecord(payload) && typeof payload.type === "string" ? payload.type : "";
}

/** 该 session 最后一条 session.surface 的能力位;无声明 = LEGACY(零变化)。 */
export function readSessionSurfaceCaps(journal: Pick<SurfaceJournalLike, "readSession">, sessionId: string): SurfaceCaps {
  let last: unknown = null;
  try {
    for (const e of journal.readSession(sessionId)) {
      if (e.kind === "custom" && payloadType(e.payload) === "session.surface") {
        last = (e.payload as { caps?: unknown }).caps;
      }
    }
  } catch { /* 读失败按 LEGACY＝不改变现状 */ }
  return last === null ? { ...LEGACY_CAPS, mediaKinds: [...LEGACY_CAPS.mediaKinds] } : resolveSurfaceCaps(last);
}

export type ClientSurfaceDeclare =
  | { ok: true; caps: SurfaceCaps }
  | { ok: false; error: string };

/**
 * server 侧 client.surface 处理(校验 → 落 journal → 回包体)。
 * sessionId 必填(简化:声明绑定到具体会话,最新一条为准);坏字段 ok:false 且不落账。
 */
export function handleClientSurfaceDeclare(
  msg: Record<string, unknown>,
  journal: SurfaceJournalLike,
  now: number = Date.now(),
): ClientSurfaceDeclare {
  const sid = typeof msg.sessionId === "string" ? msg.sessionId.trim() : "";
  if (!sid) return { ok: false, error: "invalid-surface:sessionId" };
  const capsRaw = {
    ...(msg.rendersMarkdown !== undefined ? { rendersMarkdown: msg.rendersMarkdown } : {}),
    ...(msg.maxChars !== undefined ? { maxChars: msg.maxChars } : {}),
    ...(msg.mediaKinds !== undefined ? { mediaKinds: msg.mediaKinds } : {}),
    ...(msg.hasUI !== undefined ? { hasUI: msg.hasUI } : {}),
  };
  const valid = validateSurfaceRaw(capsRaw);
  if (!valid.ok) return { ok: false, error: valid.error };
  const caps = resolveSurfaceCaps(capsRaw);
  try {
    journal.append({
      kind: "custom",
      sessionId: sid,
      payload: { type: "session.surface", sessionId: sid, caps, at: now },
    });
  } catch (err) {
    return { ok: false, error: "surface-journal-failed:" + String(err).slice(0, 120) };
  }
  return { ok: true, caps };
}

export interface TaskSurfacePlan<T extends { name: string }> {
  caps: SurfaceCaps;
  contract: string;
  tools: T[];
  filtered: string[];
  /** 一次落账的 task.surface 载荷。 */
  journalPayload: Record<string, unknown>;
}

/**
 * 开工接线(主 loop 装配前调一次):读能力位 → 输出契约 → 工具过滤 → task.surface 载荷。
 * agent-wiring 只用它算,append 由调用方做(与既有 journal 失败容忍口径一致)。
 */
export function planTaskSurface<T extends { name: string }>(
  journal: Pick<SurfaceJournalLike, "readSession">,
  sessionId: string,
  taskId: string,
  tools: readonly T[],
): TaskSurfacePlan<T> {
  const caps = readSessionSurfaceCaps(journal, sessionId);
  const contract = outputContract(caps);
  const filteredResult = filterToolsForSurface(tools, caps);
  return {
    caps,
    contract,
    tools: filteredResult.tools,
    filtered: filteredResult.filtered,
    journalPayload: {
      type: "task.surface",
      taskId,
      sessionId,
      caps: { ...caps, mediaKinds: [...caps.mediaKinds] },
      source: caps.source,
      filteredTools: filteredResult.filtered,
      contractApplied: contract.length > 0,
    },
  };
}

/** 收尾接线:降级最终输出;真的降了才落 surface.degraded(可审计,不静默)。 */
export function degradeFinalFor(
  journal: Pick<SurfaceJournalLike, "append">,
  sessionId: string,
  taskId: string,
  caps: SurfaceCaps,
  text: string,
): { text: string; degraded: boolean } {
  const d = degradeForSurface(text, caps);
  if (d.degraded) {
    try {
      journal.append({
        kind: "custom",
        sessionId,
        payload: {
          type: "surface.degraded",
          taskId,
          originalChars: d.originalChars,
          maxChars: caps.maxChars,
          degradedChars: d.degradedChars,
        },
      });
    } catch { /* 留痕失败不改变降级结果 */ }
  }
  return { text: d.text, degraded: d.degraded };
}
