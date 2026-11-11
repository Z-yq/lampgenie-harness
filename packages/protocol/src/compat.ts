/**
 * 协议/数据兼容(partial → implemented):legacy 错误码封闭登记表 + 读侧归一/投影助手。
 * 为什么单独成模块:`index.ts` 里的两条 legacy code(`companion-failed` / `companion-announce-failed`)
 * 此前只有 `@deprecated` 注释 ——「legacy→canonical 映射 / 双读窗口起点 / 下线截止」没有任何
 * 机器可读的出处,服务端发码与展示层出文案只能各自记忆。本模块把这份记忆收成一张**封闭表**
 * (`COMPAT_WINDOWS`),再在表上提供四个纯函数:
 * - resolveErrorCodeCompat 读侧归一:legacy → canonical,并给出 deprecated/phase/sunsetAt
 * - projectErrorCodeForClient 按客户端契约版本投影:老客户端窗口内回 legacy 原文,新客户端/窗口后回 canonical
 * - assertCompatRegistry 表自检:legacy 唯一、canonical 在 ErrorCode 值集合内、sunsetAt>since、status 与时间一致
 * - describeCompatWindow 一行摘要(卡片/日志用)
 * 纪律(与  任务书一致):
 * - 纯逻辑零 IO:不读文件、不 import 其它模块(避免与 index.ts 循环依赖)、自己不取 Date.now
 * ——时间一律由调用方通过 `now` 注入,同一 now 同一输出。
 * - 不 throw:任何奇怪入参(null/undefined/非字符串/空串/非法日期)都走「原样 passthrough」或收敛到
 * fail-closed 的 canonical,调用方不需要 try/catch。
 * - 不可变:表、表的每一项、所有返回结构全部 Object.freeze。
 * - 服务端发码不在本模块范围:本轮只提供读侧归一与投影助手(供后续消费)。
 * 版本策略(机器可读):
 * - 窗口: 起双读(`since`),2027-05-09 下线(`sunsetAt`)。
 * - 消费者契约版本门槛:`CANONICAL_CONTRACT_VERSION = 2`。客户端 contractVersion < 2 或缺失 = 老客户端:
 * 窗口内投影回 legacy 原文(旧面板/旧节点不改也能读懂);>= 2 = 新客户端,直接拿 canonical。
 * - 窗口后(now >= sunsetAt)无论客户端新旧一律 canonical:旧码不再下发。
 */

/** 归一后所处的阶段:active=未登记码原样 / dual-read=窗口内双读 / sunset=已过下线日。 */
export type CompatPhase = "active" | "dual-read" | "sunset";

/** 登记表里一条窗口的声明状态(与 now 的一致性由 assertCompatRegistry 校验)。 */
export type CompatStatus = "dual-read" | "sunset";

/** 一条 legacy→canonical 的兼容窗口。日期一律 `YYYY-MM-DD`(UTC 零点),机器可读。 */
export interface CompatWindowEntry {
 /** 旧码(线上历史字符串,逐字保留)。 */
  readonly legacy: string;
 /** 新码(必须存在于 ErrorCode 的值集合里)。 */
  readonly canonical: string;
 /** 双读窗口起点(含)。 */
  readonly since: string;
 /** 下线截止日(含):now >= 该日即只发 canonical。 */
  readonly sunsetAt: string;
 /** 一行原因(为什么要换码,写给人看)。 */
  readonly reason: string;
 /** 表声明的状态:dual-read(窗口内)/ sunset。 */
  readonly status: CompatStatus;
}

/** 客户端契约版本门槛:低于此值或缺失 = 老客户端,窗口内投影回 legacy 原文。 */
export const CANONICAL_CONTRACT_VERSION = 2;

/** 时间入参:毫秒时间戳 / Date / ISO 字符串;缺省由调用方注入(本模块不取系统时间)。 */
export type CompatClock = number | Date | string | undefined;

/** 需要「现在」的助手的公共参数。 */
export interface CompatOptions {
  readonly now?: CompatClock;
}

/** 投影参数:客户端契约版本 + 现在。 */
export interface ProjectOptions extends CompatOptions {
 /** 客户端自报的契约版本;缺失/null 视为老客户端。 */
  readonly clientContractVersion?: number | null;
}

/** resolveErrorCodeCompat 的返回(冻结对象)。 */
export interface CompatResolution {
 /** 归一后的码:登记码=canonical;未登记码=入参原文。 */
  readonly code: string;
 /** 入参是否是 legacy 别名(登记表命中即 true,窗口内与窗口后都 true)。 */
  readonly deprecated: boolean;
  readonly phase: CompatPhase;
 /** 登记码才带:下线截止日 `YYYY-MM-DD`。 */
  readonly sunsetAt?: string;
 /** 登记码才带:换码原因。 */
  readonly reason?: string;
}

/** assertCompatRegistry 的返回(冻结对象,issues 已确定性排序)。 */
export interface CompatRegistryReport {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

const DAY_MS = 86_400_000;

/**
 * 封闭登记表(唯一出处)。表本身与每一项都冻结:任何调用方都无法在运行期改写兼容口径。
 * 新增 legacy 别名 = 在这里加一条(同时把 ErrorCode 里的值留着,不删历史串)。
 */
const RAW_COMPAT_WINDOWS: readonly CompatWindowEntry[] = [
  {
    legacy: "companion-announce-failed",
    canonical: "super-announce-failed",
    since: "2026-11-09",
    sunsetAt: "2027-05-09",
    reason: "super agent 指挥台链取代 companion 链,新链只发 super-announce-failed",
    status: "dual-read",
  },
  {
    legacy: "companion-failed",
    canonical: "super-failed",
    since: "2026-11-09",
    sunsetAt: "2027-05-09",
    reason: "super agent 指挥台链取代 companion 链,新链只发 super-failed",
    status: "dual-read",
  },
];

/** 冻结的登记表(对外唯一入口)。 */
export const COMPAT_WINDOWS: readonly CompatWindowEntry[] = Object.freeze(
  RAW_COMPAT_WINDOWS.map((entry) => Object.freeze({ ...entry })),
);

/** 日期 → 毫秒;无法解析返回 NaN(调用方按 fail-closed 处理,不 throw)。 */
function toTime(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : Number.NaN;
  }
  if (typeof value === "string" && value.trim()) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : Number.NaN;
  }
  return Number.NaN;
}

/** 取「现在」:缺省/非法 → NaN(不读系统时钟,保证确定性)。 */
function nowOf(opts?: CompatOptions): number {
  return toTime(opts && opts.now);
}

/** 任意入参 → 线上字符串(不 throw:null/undefined → "")。 */
function toCode(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : String(value);
}

/** 按 legacy 列查登记项(未命中 = 未登记码)。 */
function findWindowByLegacy(code: string): CompatWindowEntry | undefined {
  for (const entry of COMPAT_WINDOWS) if (entry.legacy === code) return entry;
  return undefined;
}

/**
 * 读侧归一:legacy → canonical。
 * - 未登记码(含 canonical 本身)→ `{code: 原样, deprecated:false, phase:"active"}`
 * - 登记码且 now < sunsetAt → `{code: canonical, deprecated:true, phase:"dual-read", sunsetAt, reason}`
 * - 登记码且 now >= sunsetAt → `{code: canonical, deprecated:true, phase:"sunset", sunsetAt, reason}`
 * now 缺失/不可解析时按「窗口内」处理(phase=dual-read;码仍归一为 canonical,绝不回落 legacy)。
 */
export function resolveErrorCodeCompat(code: string, opts?: CompatOptions): CompatResolution {
  const raw = toCode(code);
  const entry = findWindowByLegacy(raw);
  if (!entry) return Object.freeze({ code: raw, deprecated: false, phase: "active" as const });
  const sunset = toTime(entry.sunsetAt);
  const now = nowOf(opts);
  const sunsetPassed = Number.isFinite(sunset) ? now >= sunset : true;
  return Object.freeze({
    code: entry.canonical,
    deprecated: true,
    phase: sunsetPassed ? ("sunset" as const) : ("dual-read" as const),
    sunsetAt: entry.sunsetAt,
    reason: entry.reason,
  });
}

/**
 * 按客户端契约版本投影:同一份内部码,给不同代客户端看不同的线上字符串。
 * - 非登记码(既不是 legacy 也不是登记表里的 canonical)→ 原样返回
 * - 老客户端(clientContractVersion < 2 或缺失)且窗口内 → legacy 原文
 * - 新客户端(>= 2)或窗口后 → canonical
 * 登记表的 canonical 输入同样会被投影(新客户端拿回 canonical,老客户端降回 legacy),
 * 这样服务端升级后即使已经改发新码,老客户端也不会看到陌生码。
 */
export function projectErrorCodeForClient(code: string, opts?: ProjectOptions): string {
  const raw = toCode(code);
  let entry: CompatWindowEntry | undefined;
  for (const item of COMPAT_WINDOWS) {
    if (item.legacy === raw || item.canonical === raw) {
      entry = item;
      break;
    }
  }
  if (!entry) return raw;
  const sunset = toTime(entry.sunsetAt);
  const sunsetPassed = Number.isFinite(sunset) ? nowOf(opts) >= sunset : true;
  if (sunsetPassed) return entry.canonical;
  const declared = opts ? opts.clientContractVersion : undefined;
  const version = typeof declared === "number" && Number.isFinite(declared) ? declared : -1;
  return version >= CANONICAL_CONTRACT_VERSION ? entry.canonical : entry.legacy;
}

/**
 * 兼容登记表自检(可跑在契约测试/CI 里)。
 * 校验项:legacy 非空且不重复、canonical 非空且存在于 ErrorCode 值集合、legacy≠canonical、
 * canonical 不是另一条的 legacy、since/sunsetAt 可解析且 sunsetAt > since、status 与 now 一致、
 * reason 非空。问题逐条确定性排序(字典序),ok 只在 issues 为空时成立。
 * `entries` 可选(默认 COMPAT_WINDOWS):测试用它注入坏表验证各条校验分支。
 */
export function assertCompatRegistry(
  errorCodeValues: readonly string[],
  opts?: CompatOptions,
  entries?: readonly CompatWindowEntry[],
): CompatRegistryReport {
  return assertCompatEntries(entries ?? COMPAT_WINDOWS, errorCodeValues, opts);
}

/** assertCompatRegistry 的可注入版本(entries 由调用方给,便于负例测试)。 */
export function assertCompatEntries(
  entries: readonly CompatWindowEntry[],
  errorCodeValues: readonly string[],
  opts?: CompatOptions): CompatRegistryReport {
  const issues: string[] = [];
  const values = new Set<string>((Array.isArray(errorCodeValues) ? errorCodeValues : []).filter((v) => typeof v === "string"));
  const list = Array.isArray(entries) ? entries : [];
  const legacySet = new Set<string>();
  for (const entry of list) if (entry && typeof entry.legacy === "string") legacySet.add(entry.legacy);
  const now = nowOf(opts);

  for (const entry of list) {
    if (!entry || typeof entry !== "object") {
      issues.push("entry is not an object");
      continue;
    }
    const legacy = typeof entry.legacy === "string" ? entry.legacy : "";
    const canonical = typeof entry.canonical === "string" ? entry.canonical : "";
    const tag = legacy || "(empty legacy)";
    if (!legacy.trim()) issues.push("empty legacy (canonical " + (canonical || "(empty)") + ")");
    if (!canonical.trim()) issues.push("empty canonical: " + tag);
    if (legacy && canonical && legacy === canonical) issues.push("legacy equals canonical: " + legacy);
    if (canonical && !values.has(canonical)) issues.push("canonical not in ErrorCode values: " + canonical + " (legacy " + tag + ")");
    if (canonical && canonical !== legacy && legacySet.has(canonical)) issues.push("canonical is itself a legacy alias: " + canonical);
    const since = toTime(entry.since);
    const sunset = toTime(entry.sunsetAt);
    if (!Number.isFinite(since)) issues.push("unparsable since: " + tag + " -> " + String(entry.since));
    if (!Number.isFinite(sunset)) issues.push("unparsable sunsetAt: " + tag + " -> " + String(entry.sunsetAt));
    if (Number.isFinite(since) && Number.isFinite(sunset) && !(sunset > since)) issues.push("sunsetAt not after since: " + tag);
    if (entry.status !== "dual-read" && entry.status !== "sunset") issues.push("unknown status: " + tag + " -> " + String(entry.status));
    const sunsetPassed = Number.isFinite(sunset) ? now >= sunset : false;
    if (entry.status === "dual-read" && sunsetPassed) {
      issues.push("status mismatch: " + tag + " declared dual-read but sunsetAt " + String(entry.sunsetAt) + " already passed");
    }
    if (entry.status === "sunset" && !sunsetPassed) {
      issues.push("status mismatch: " + tag + " declared sunset but sunsetAt " + String(entry.sunsetAt) + " still in the future");
    }
    if (typeof entry.reason !== "string" || !entry.reason.trim()) issues.push("empty reason: " + tag);
  }

 // legacy 重复:逐项点名,不依赖 Set 遍历顺序
  const seen = new Set<string>();
  for (const entry of list) {
    const legacy = entry && typeof entry.legacy === "string" ? entry.legacy : "";
    if (!legacy) continue;
    if (seen.has(legacy)) issues.push("duplicate legacy: " + legacy);
    seen.add(legacy);
  }

  const sorted = Object.freeze([...issues].sort());
  return Object.freeze({ ok: sorted.length === 0, issues: sorted });
}

/**
 * 一行摘要(卡片/日志):`companion-failed → super-failed | dual-read 至 下线(剩 N 天) | reason`
 * 窗口后写「已下线」,日期不可解析写「sunsetAt 不可解析」。单行、无换行符、同 now 同输出。
 */
export function describeCompatWindow(entry: CompatWindowEntry, now?: CompatClock): string {
  const legacy = entry && typeof entry.legacy === "string" ? entry.legacy : "";
  const canonical = entry && typeof entry.canonical === "string" ? entry.canonical : "";
  const reason = entry && typeof entry.reason === "string" ? entry.reason : "";
  const sinceLabel = entry && typeof entry.since === "string" ? entry.since : "(无 since)";
  const sunsetLabel = entry && typeof entry.sunsetAt === "string" ? entry.sunsetAt : "(无 sunsetAt)";
  const head = (legacy || "(空)") + " → " + (canonical || "(空)");
  const sunset = toTime(entry && entry.sunsetAt);
  if (!Number.isFinite(sunset)) return head + " | " + sunsetLabel + " 不可解析 | " + reason;
  const n = toTime(now);
  if (Number.isFinite(n) && n >= sunset) return head + " | 已于 " + sunsetLabel + " 下线(自 " + sinceLabel + " 双读) | " + reason;
  const days = Number.isFinite(n) ? Math.ceil((sunset - n) / DAY_MS) : Number.NaN;
  const remain = Number.isFinite(days) ? "剩 " + String(days) + " 天" : "剩余天数未知";
  return head + " | 自 " + sinceLabel + " 双读,至 " + sunsetLabel + " 下线(" + remain + ") | " + reason;
}
