/**
 * 系统提醒来源登记。
 * 为什么提醒也要封闭登记:提醒文本是「注入给模型的高权指令」,过去散落在 loop / read-file-state /
 * parent-ask-broker 里靠字符串拼接,带来三个真实问题:
 * 1) 来源无法审计——面板与 journal 只看到一段 `<system-reminder>`,说不清是哪条机制注的;
 * 2) 未知来源静默生效——任何代码路径随手拼个标签就能给模型下指令,出了坏指令无从追责;
 * 3) 注入通道不统一——provider 不支持 MCS(mid-conversation system)时,散落的 system 块
 * 没人负责降级,只能靠每个调用点自己记得合并。
 * 因此这里把「谁能注提醒」收成两张**封闭表**(persisted / per-request):表外的 source 一律
 * fail-closed,不产文本。为什么未知 source 必须 fail-closed:登记表是白名单,未登记意味着这次
 * 注入没有 descriptor(没有通道 / 生命周期 / 可见性口径),放行等于让任意字符串以 system 身份
 * 进入模型上下文;提醒丢了可以下一步重注,错误指令进了历史就再也收不回来——宁可这条提醒丢失。
 * 本模块纯逻辑零 IO:不读 config、不落 journal、不碰时钟与模型名,保证确定性与可测性。
 */

/** 持久化提醒源(写进 system 面,跨轮仍在;由系统提示组装侧消费)。 */
export const PERSISTED_REMINDER_SOURCES = ["todo", "goal", "board", "approval", "memory"] as const;

/** 每请求提醒源(ephemeral,每步现算、不落 journal;由 loop 每步组装消息时注入)。 */
export const EPHEMERAL_REMINDER_SOURCES = ["read-files", "timebox", "trajectory", "pending-questions", "tip", "productive-nudge"] as const;

export type PersistedReminderSource = (typeof PERSISTED_REMINDER_SOURCES)[number];
export type EphemeralReminderSource = (typeof EPHEMERAL_REMINDER_SOURCES)[number];
export type ReminderSource = PersistedReminderSource | EphemeralReminderSource;

/** 提醒注入通道:system=系统面,user=随请求下发的用户面消息。 */
export type ReminderChannel = "system" | "user";
/** 生命周期:persisted=跨轮持久,ephemeral=每请求现算。 */
export type ReminderLifecycle = "persisted" | "ephemeral";
/** provider 可见性:always=任何 provider 都能收到;mcs-only=只有支持 MCS 的 provider 才按 system 面投递。 */
export type ReminderProviderVisibility = "always" | "mcs-only";

export interface ReminderDescriptor {
  readonly channel: ReminderChannel;
  readonly lifecycle: ReminderLifecycle;
 /** 合并时的稳定排序号(小在前):保证同一组提醒在任何调用点顺序一致。 */
  readonly order: number;
  readonly providerVisibility: ReminderProviderVisibility;
 /** 证据/遥测标签:journal 与面板据此标记「这条提醒来自哪条机制」。 */
  readonly evidenceLabel: string;
}

/** 全部已登记来源(两张表的并集;不另写一份枚举)。 */
export const REMINDER_SOURCES: readonly ReminderSource[] = Object.freeze([
  ...PERSISTED_REMINDER_SOURCES,
  ...EPHEMERAL_REMINDER_SOURCES,
] as ReminderSource[]);

const descriptor = (
  channel: ReminderChannel,
  lifecycle: ReminderLifecycle,
  order: number,
  providerVisibility: ReminderProviderVisibility,
  evidenceLabel: string): ReminderDescriptor => Object.freeze({ channel, lifecycle, order, providerVisibility, evidenceLabel });

/**
 * descriptor 表:与来源表**逐项对应**(测试锁死),order 唯一且递增。
 * persisted 走 system 面 → providerVisibility=mcs-only(不支持 MCS 时不能作为中途 system 块投递,
 * 必须由 mergeReminders 合并成用户面一条);ephemeral 走 user 面 → always。
 */
const DESCRIPTOR_TABLE: Readonly<Record<ReminderSource, ReminderDescriptor>> = Object.freeze({
  todo: descriptor("system", "persisted", 1, "mcs-only", "todo-reminder"),
  goal: descriptor("system", "persisted", 2, "mcs-only", "goal-reminder"),
  board: descriptor("system", "persisted", 3, "mcs-only", "board-reminder"),
  approval: descriptor("system", "persisted", 4, "mcs-only", "approval-reminder"),
  memory: descriptor("system", "persisted", 5, "mcs-only", "memory-reminder"),
  "read-files": descriptor("user", "ephemeral", 6, "always", "read-files-reminder"),
  timebox: descriptor("user", "ephemeral", 7, "always", "timebox-reminder"),
  trajectory: descriptor("user", "ephemeral", 8, "always", "trajectory-reminder"),
  "pending-questions": descriptor("user", "ephemeral", 9, "always", "pending-questions-reminder"),
  tip: descriptor("user", "ephemeral", 10, "always", "tip"),
 // 修复:产出纪律硬提醒(子代理连续 N 步零实质产出)原为 llm-loop-backend 就地拼接,
 // 收进登记表后与其它提醒同走 fail-closed / 统一转义;order 紧跟 tip。
  "productive-nudge": descriptor("user", "ephemeral", 11, "always", "产出纪律"),
});

/** 来源是否已登记(白名单查询;不做模糊匹配)。 */
export function isReminderSource(source: unknown): source is ReminderSource {
  return typeof source === "string" && Object.prototype.hasOwnProperty.call(DESCRIPTOR_TABLE, source);
}

/** 取 descriptor;未知来源→null(fail-closed 的第一道闸,调用方据此拒绝产出提醒)。 */
export function reminderDescriptor(source: unknown): ReminderDescriptor | null {
  if (!isReminderSource(source)) return null;
  return DESCRIPTOR_TABLE[source];
}

/** 提醒文本总长上限(字符数);超限显式失败而不是截断,避免把半句话喂给模型。 */
export const REMINDER_MAX_CHARS = 4000;

/** 外层 reminder 标签固定形态(与旧拼接实现逐字节一致)。 */
const REMINDER_OPEN = "<system-reminder>";
const REMINDER_CLOSE = "</system-reminder>";

/** 嵌套 system-reminder 标签(大小写不敏感、允许属性与标签内空白)。 */
const NESTED_TAG_RE = /<\/?system-reminder\b[^>]*>/gi;

/** 把嵌套标签的尖括号转义掉,其它 HTML 一律不动(只治本机制自己的注入语法)。 */
function escapeNestedTags(body: string): string {
  return body.replace(NESTED_TAG_RE, (tag) => tag.replace(/</g, "&lt;").replace(/>/g, "&gt;"));
}

/** 合并态用:直接剥掉内层 reminder 标签(外层结构里留着会伪造嵌套块)。 */
function stripNestedTags(body: string): string {
  return body.replace(NESTED_TAG_RE, "");
}

export type RenderReminderFailure = "UNKNOWN_SOURCE" | "EMPTY_BODY" | "TOO_LONG";

export type RenderReminderResult =
  | { ok: true; text: string }
  | { ok: false; code: RenderReminderFailure };

export interface RenderReminderOptions {
 /** 默认 true=转义 body 里嵌套的 reminder 标签;对已清洗的 body 显式传 false,避免双重处理。 */
  escapeNested?: boolean;
 /**
 * true=单行形态 `<system-reminder>body</system-reminder>`。
 * 仅为兼容既有时间盒提醒的逐字节形态而存在;缺省 false(多行形态)。
 */
  inline?: boolean;
}

/**
 * 渲染一条系统提醒。失败一律返回 `{ok:false,code}`,永不 throw(提醒层故障不得打断主链)。
 * 成功文本与旧实现逐字节一致:`<system-reminder>\n{body}\n</system-reminder>`。
 */
export function renderSystemReminder(
  source: unknown,
  body: unknown,
  opts: RenderReminderOptions = {},
): RenderReminderResult {
  if (!isReminderSource(source)) return { ok: false, code: "UNKNOWN_SOURCE" };
  if (typeof body !== "string" || body.trim().length === 0) return { ok: false, code: "EMPTY_BODY" };
  const safe = opts.escapeNested === false ? body : escapeNestedTags(body);
  const text = opts.inline === true
    ? `${REMINDER_OPEN}${safe}${REMINDER_CLOSE}`
    : `${REMINDER_OPEN}\n${safe}\n${REMINDER_CLOSE}`;
  if (text.length > REMINDER_MAX_CHARS) return { ok: false, code: "TOO_LONG" };
  return { ok: true, text };
}

export interface ReminderItem {
  readonly source: string;
  readonly body: string;
}

export interface MergeRemindersOptions {
 /** provider 是否支持中途 system 注入(MCS);缺省按不支持处理(fail-closed)。 */
  readonly supportsMcs?: boolean;
 /** 当前历史里是否存在合法的 MCS 锚点(可插入 system 块的位置);缺省按没有处理。 */
  readonly hasLegalAnchor?: boolean;
}

export interface MergeRemindersResult {
  readonly texts: string[];
 /** true=整组合并成了一条用户面提醒;false=逐条包装。 */
  readonly merged: boolean;
 /** 被拒收的来源(未登记 / 空 body / 超长),供调用方留痕。 */
  readonly skipped: string[];
}

/** 合并态前缀:整组提醒压成 user 面一条时,用一个可检索的前缀替代内层标签。 */
const MERGED_PREFIX = "[系统提醒] ";

/**
 * 归并一组提醒:
 * - 全部按 descriptor.order 排序(同一组输入在任何调用点顺序一致);
 * - 未登记来源→skipped(fail-closed,绝不产出文本);
 * - provider 不支持 MCS,或历史里没有合法锚点→**整组**合并成一条 user reminder
 * (`[系统提醒] ` 前缀 + 段间空行,去掉内层标签)——逐条投递会让中途 system 块失效;
 * - 否则逐条包装;空输入→texts=[](不产空块)。
 * 不修改入参、不 throw。
 */
export function mergeReminders(
  items: readonly ReminderItem[],
  opts: MergeRemindersOptions = {},
): MergeRemindersResult {
  const skipped: string[] = [];
  const ordered: { source: ReminderSource; body: string; order: number }[] = [];
  for (const item of items ?? []) {
    const source = item?.source;
    const body = item?.body;
    const desc = reminderDescriptor(source);
    if (!desc) {
      skipped.push(typeof source === "string" ? source : "");
      continue;
    }
    if (typeof body !== "string" || body.trim().length === 0) {
      skipped.push(source as string);
      continue;
    }
    ordered.push({ source: source as ReminderSource, body, order: desc.order });
  }
  if (ordered.length === 0) return { texts: [], merged: false, skipped };
 // 排序副本,不动入参;localeCompare 只兜同 order 的异常输入。
  const sorted = [...ordered].sort((a, b) => a.order - b.order || a.source.localeCompare(b.source));
  if (opts.supportsMcs !== true || opts.hasLegalAnchor !== true) {
    const body = sorted.map((item) => stripNestedTags(item.body).trim()).join("\n\n");
    return { texts: [MERGED_PREFIX + body], merged: true, skipped };
  }
  const texts: string[] = [];
  for (const item of sorted) {
    const rendered = renderSystemReminder(item.source, item.body);
    if (rendered.ok) texts.push(rendered.text);
    else skipped.push(item.source);
  }
  return { texts, merged: false, skipped };
}

/**
 * 显式 MCS 能力位登记表(键=能力位 id,**不是模型名**)。
 * 当前为空:仓内没有任何 provider 声明支持中途 system 注入。
 * 接入方拿到 provider 的显式能力位后在此登记一处,全仓判定随之一处生效。
 */
const MCS_CAPABILITY_BITS: Readonly<Record<string, true>> = Object.freeze({});

/**
 * provider 是否支持 MCS——**单点判定**。
 * 只认显式能力位;模型名里出现 mcs 之类的字面猜测一律不算(名字不是能力,猜错会把 system 块
 * 投进不支持中途注入的 provider,整轮请求失败)。缺省 false。
 */
export function providerSupportsMcs(capabilityBit?: string): boolean {
  if (typeof capabilityBit !== "string" || capabilityBit.length === 0) return false;
  return Object.prototype.hasOwnProperty.call(MCS_CAPABILITY_BITS, capabilityBit)
    && MCS_CAPABILITY_BITS[capabilityBit] === true;
}
