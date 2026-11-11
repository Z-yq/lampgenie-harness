/**
 * 通知发射器:一次产出「结构化 payload + 人读文本 + GUI 投影」。
 * 为什么文本不能由 payload 反解析:文本是给人看的句子,会被本地化/改写/截断(GUI 里换行、
 * 推送里单行),一旦下游要拿真实字段就必须靠字符串解析——字段顺序、单位、截断都会让解析
 * 静默漂移,且改动文案即等于改动协议。所以这里三面同源:payload 保留结构化原值(机器消费),
 * text 与人读句子同源派生,gui 从同一份结构化字段派生(不从 text 反解析)。
 * 契约:
 * - kind 是封闭注册表(NOTIFICATION_KINDS);未知 kind → UNKNOWN_KIND 且不产出 notification(fail-closed);
 * - 每 kind 有必填字段表,缺失/类型错 → INVALID;
 * - 纯函数:零 IO、不 throw(内部兜底)、不读时钟/随机数(确定性)、不改入参、返回值深冻结(不可变)。
 */

/** 通知 kind 封闭注册表(唯一权威;新增 kind 必须同时补必填字段表与文案派生)。 */
export const NOTIFICATION_KINDS = [
  "task.done",
  "task.failed",
  "task.blocked",
  "subagent.final",
  "ask.pending",
  "security.alert",
  "team.activity",
  "custom",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** 结果码:OK=产出成功;UNKNOWN_KIND=kind 不在注册表(fail-closed);INVALID=字段不合规。 */
export type NotifyCode = "OK" | "UNKNOWN_KIND" | "INVALID";

export type GuiSeverity = "info" | "warn" | "error";

/** GUI 投影(面板/系统通知卡片用;由结构化字段派生,不从 text 反解析)。 */
export interface NotificationGui {
  title: string;
  body: string;
  severity: GuiSeverity;
}

export interface Notification {
  kind: NotificationKind;
 /** 结构化原值(深拷贝+深冻结,调用方后续改动不影响已产出的通知)。 */
  payload: Readonly<Record<string, unknown>>;
 /** 稳定人读句(中文,含关键字段)。 */
  text: string;
  gui: NotificationGui;
}

export type BuildResult =
  | { ok: true; code: "OK"; notification: Notification }
  | { ok: false; code: Exclude<NotifyCode, "OK">; reason: string };

export interface BuildOptions {
 /** 收窄本次可用 kind 集合(必须取自 NOTIFICATION_KINDS;交集外的 kind 仍 fail-closed)。 */
  kinds?: readonly string[];
}

/** 每 kind 的必填字段(值必须是 string;标识字段允许空串,空串是数据事实不是缺失)。 */
const REQUIRED_FIELDS: Record<Exclude<NotificationKind, "custom">, readonly string[]> = {
  "task.done": ["taskId", "sessionId", "status"],
  "task.failed": ["taskId", "sessionId", "status"],
  "task.blocked": ["taskId", "sessionId", "reason"],
  "subagent.final": ["agentId", "status", "summary"],
  "ask.pending": ["askId", "question"],
  "security.alert": ["message"],
  "team.activity": ["projectId", "category", "type"],
};

const SEVERITIES: readonly GuiSeverity[] = ["info", "warn", "error"];
const TEXT_MAX = 500;
const SUMMARY_MAX = 200;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clonePlain(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clonePlain);
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = clonePlain(val);
    return out;
  }
  return v;
}

function freezeDeep<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    for (const k of Object.keys(v as object)) freezeDeep((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function severityOf(v: unknown, fallback: GuiSeverity): GuiSeverity {
  return typeof v === "string" && (SEVERITIES as readonly string[]).includes(v)
    ? (v as GuiSeverity)
    : fallback;
}

function clip(s: string, max: number): string {
  const oneLine = s.replace(/\s*\n\s*/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/** 从同源结构化字段派生 text 与 gui(两者共用一次取值,不互相解析)。 */
function describe(kind: NotificationKind, p: Readonly<Record<string, unknown>>): { text: string; gui: NotificationGui } {
  switch (kind) {
    case "task.done": {
      const taskId = str(p.taskId);
      const sessionId = str(p.sessionId);
      const status = str(p.status);
      return {
        text: clip(`任务 ${taskId} 已完成(${status};会话 ${sessionId})`, TEXT_MAX),
        gui: { title: "任务完成", body: `${taskId} · ${status}`, severity: "info" },
      };
    }
    case "task.failed": {
      const taskId = str(p.taskId);
      const status = str(p.status);
      const error = str(p.error);
      return {
        text: clip(`任务 ${taskId} 失败(${status})${error ? `:${error}` : ""}`, TEXT_MAX),
        gui: { title: "任务失败", body: `${taskId} · ${error || status}`, severity: "error" },
      };
    }
    case "task.blocked": {
      const taskId = str(p.taskId);
      const reason = str(p.reason);
      return {
        text: clip(`任务 ${taskId} 受阻塞:${reason}`, TEXT_MAX),
        gui: { title: "任务受阻", body: `${taskId} · ${reason}`, severity: "warn" },
      };
    }
    case "subagent.final": {
      const agentId = str(p.agentId);
      const status = str(p.status);
      const summary = str(p.summary);
      return {
        text: clip(`子代理 ${agentId} ${status}:${summary}`, TEXT_MAX),
        gui: {
          title: `子代理 ${status}`,
          body: `${agentId} · ${summary}`,
          severity: status === "failed" || status === "error" ? "error" : "info",
        },
      };
    }
    case "ask.pending": {
      const askId = str(p.askId);
      const question = str(p.question);
      return {
        text: clip(`待确认(${askId}):${question}`, TEXT_MAX),
        gui: { title: "需要你确认", body: question, severity: "warn" },
      };
    }
    case "security.alert": {
      const message = str(p.message);
      return {
        text: clip(`安全告警:${message}`, TEXT_MAX),
        gui: { title: "安全告警", body: message, severity: severityOf(p.severity, "error") },
      };
    }
    case "team.activity": {
      const projectId = str(p.projectId);
      const category = str(p.category);
      const type = str(p.type);
      const summary = str(p.summary);
      const scope = projectId ? `(${projectId})` : "";
      const risky = /fail|error|block|deny/i.test(type);
      return {
        text: clip(`团队活动:${category}/${type}${scope}${summary ? ` — ${summary}` : ""}`, TEXT_MAX),
        gui: {
          title: `团队活动 · ${type}`,
          body: summary || `${category}/${type}${scope}`,
          severity: risky ? "warn" : "info",
        },
      };
    }
    case "custom": {
      const label = str(p.label);
      const detail = str(p.detail) || str(p.summary);
      return {
        text: clip(detail ? `${label}:${detail}` : label, TEXT_MAX),
        gui: { title: label, body: detail || label, severity: severityOf(p.severity, "info") },
      };
    }
  }
}

/**
 * 构造通知:一次产出结构化 payload + 人读文本 + GUI 投影。
 * 不 throw;失败只回 {ok:false, code, reason},不产出 notification(fail-closed)。
 */
export function buildNotification(kind: string, data?: unknown, opts?: BuildOptions): BuildResult {
  try {
 // 双重 fail-closed:先查封闭注册表(未登记一律拒),再查调用方收窄集合(收窄只减不增)。
    const narrowed = opts?.kinds;
    if (
      typeof kind !== "string" ||
      !(NOTIFICATION_KINDS as readonly string[]).includes(kind) ||
      (narrowed !== undefined && !narrowed.includes(kind))
    ) {
      return { ok: false, code: "UNKNOWN_KIND", reason: `未知通知 kind:${String(kind)}` };
    }
    if (!isPlainObject(data)) {
      return { ok: false, code: "INVALID", reason: "data 必须是普通对象" };
    }
    const payload = freezeDeep(clonePlain(data)) as Readonly<Record<string, unknown>>;
    if (kind === "custom") {
      if (typeof payload.label !== "string" || !payload.label.trim()) {
        return { ok: false, code: "INVALID", reason: "custom 至少需要非空 label" };
      }
    } else {
      for (const field of REQUIRED_FIELDS[kind as Exclude<NotificationKind, "custom">]) {
        if (typeof payload[field] !== "string") {
          return { ok: false, code: "INVALID", reason: `缺少必填字段 ${field}(kind=${kind})` };
        }
      }
    }
    const { text, gui } = describe(kind as NotificationKind, payload);
    return {
      ok: true,
      code: "OK",
      notification: Object.freeze({ kind: kind as NotificationKind, payload, text, gui: Object.freeze(gui) }),
    };
  } catch (err) {
    return { ok: false, code: "INVALID", reason: err instanceof Error ? err.message : String(err) };
  }
}

export type NotifyChannel = "text" | "gui" | "webhook";

/** 按渠道投影:文本渠道只要句子,GUI 渠道只要卡片投影,webhook 保持结构化原值+句子。 */
export function renderForChannel(
  notification: Notification,
  channel: NotifyChannel): string | NotificationGui | Readonly<Record<string, unknown>> {
  switch (channel) {
    case "text":
      return notification.text;
    case "gui":
      return notification.gui;
    case "webhook":
      return freezeDeep({ kind: notification.kind, ...notification.payload, text: notification.text });
    default:
 // 渠道未知时退回人读句:任何渠道至少能显示一句话,不抛错。
      return notification.text;
  }
}

/** 一行摘要(日志/推送用):`[kind] text`,单行且 ≤200 字。 */
export function summarizeNotification(notification: Notification): string {
  try {
    return clip(`[${notification.kind}] ${notification.text}`, SUMMARY_MAX);
  } catch {
    return "";
  }
}
