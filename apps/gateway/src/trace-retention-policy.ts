/**
 * 轨迹保留判定(纯逻辑,零 IO)——,。
 * 为什么需要这一层:`llm-trace-retention` 原来只按「空间」清理(每 session 200 份 + 全树 512MB)。
 * 但轨迹还有「价值」维度,两条硬需求逼出钉扎(pin):
 * ① **RSI 夜间挖掘窗口**:夜间挖掘按近 N 天(缺省 7)的轨迹跑,窗口内的轨迹是挖掘的**输入数据**——
 * 份数/总量清理把它删了,当晚挖掘就无料可挖,RSI 的「经验回流」整条链断在原料上。所以窗口内的
 * 轨迹必须留到挖掘跑完(时间维度,与磁盘余量无关)。
 * ② **证据钉扎**:证据图谱(EvidenceSource.sessionId)引用的轨迹是审计回溯的原始现场;删掉=证据
 * 链断,后续「这条结论凭什么」不可复核。引用关系比时间更硬,优先级最高。
 * 设计纪律:
 * - **零 IO**:文件枚举/stat 留在调用方(prune / 迁移),本模块只做判定,便于逐条单测。
 * - **不 throw**:轨迹清理是旁路,判定层抛错会把「清理失败」放大成「主链失败」;任何脏输入都折叠成
 * 可预期的 verdict(拿不准时倾向 keep——宁可不删,不静默删掉可能被引用的现场)。
 * - **确定性**:同输入同输出(排序用路径字典序,不依赖 readdir 顺序)。
 * - **不可变**:入参只读,返回新对象,便于调用方按快照复算与审计。
 */

/** 保留判定码(稳定码:调用方/日志/测试按码断言,不解析文案)。 */
export const TRACE_RETENTION_CODES = ["KEEP", "DROP", "PIN_EVIDENCE", "PIN_WINDOW"] as const;

export type TraceRetentionCode = (typeof TRACE_RETENTION_CODES)[number];

/** 挖掘窗口缺省天数(与 env `GENIE_LLM_TRACE_MINING_WINDOW_DAYS` 缺省一致)。 */
export const DEFAULT_MINING_WINDOW_DAYS = 7;

const DAY_MS = 86_400_000;

/** 证据 session 集合:接受 Set 或数组(调用方可能来自 JSON,不必强行转 Set)。 */
export type EvidenceSessionBag = ReadonlySet<string> | readonly string[];

export interface MiningWindowInput {
  now?: number;
 /** 窗口天数;undefined=缺省 7,非法/<=0 → 窗口起点=now(等价于「窗口不覆盖任何文件」)。 */
  days?: number;
}

/**
 * 挖掘窗口起点(epochMs):epoch >= 起点 = 落在窗口内。
 * - days 未给 → 缺省 7 天;
 * - days 非法(NaN/Infinity)或 <=0 → 返回 now(不做窗口保护,靠证据钉扎兜底);
 * - now 非法 → 用 Date.now。
 */
export function miningWindowStart(input: MiningWindowInput = {}): number {
  const rawNow = Number(input.now);
  const now = Number.isFinite(rawNow) ? rawNow : Date.now();
  if (input.days === undefined) return now - DEFAULT_MINING_WINDOW_DAYS * DAY_MS;
  const days = Number(input.days);
  if (!Number.isFinite(days) || days <= 0) return now;
  return now - days * DAY_MS;
}

function hasSession(evidenceSessions: EvidenceSessionBag | undefined, sessionId: string): boolean {
  if (!evidenceSessions || typeof sessionId !== "string" || sessionId === "") return false;
  const maybeSet = evidenceSessions as ReadonlySet<string>;
  if (typeof maybeSet.has === "function") return maybeSet.has(sessionId);
  return Array.isArray(evidenceSessions) ? evidenceSessions.includes(sessionId) : false;
}

export interface RetentionVerdictInput {
  sessionId: string;
 /** 轨迹写盘时刻(文件名末段 ms;取不到回退 mtime)。 */
  epoch: number;
 /** 判定时刻(窗口起点缺失时的兜底)。 */
  now?: number;
 /** 挖掘窗口起点(epochMs)。 */
  windowStart?: number;
 /** 被证据图谱引用的 sessionId 集合。 */
  evidenceSessions?: EvidenceSessionBag;
}

export interface RetentionVerdict {
  keep: boolean;
  pin: boolean;
  code: TraceRetentionCode;
  reason: string;
}

/**
 * 单文件判定。优先级:证据引用 > 挖掘窗口 > DROP。
 * - 证据引用:pin=true,code=PIN_EVIDENCE(即使远早于窗口,也必须留);
 * - 窗口内(epoch >= windowStart,边界含等号):pin=true,code=PIN_WINDOW;
 * - 其余:DROP。
 */
export function retentionVerdict(input: RetentionVerdictInput): RetentionVerdict {
  const sessionId = typeof input?.sessionId === "string" ? input.sessionId : "";
  const evidenceSessions = input?.evidenceSessions;
  if (hasSession(evidenceSessions, sessionId)) {
    return { keep: true, pin: true, code: "PIN_EVIDENCE", reason: "evidence-source" };
  }
  const rawEpoch = Number(input?.epoch);
  const epoch = Number.isFinite(rawEpoch) ? rawEpoch : 0;
  const rawStart = Number(input?.windowStart);
  const rawNow = Number(input?.now);
  const windowStart = Number.isFinite(rawStart) ? rawStart : Number.isFinite(rawNow) ? rawNow : 0;
  if (epoch >= windowStart) return { keep: true, pin: true, code: "PIN_WINDOW", reason: "mining-window" };
  return { keep: false, pin: false, code: "DROP", reason: "outside-window" };
}

/** planRetention 的输入文件(调用方已 stat/枚举完,本层不碰磁盘)。 */
export interface RetentionFileEntry {
  path: string;
  sessionId: string;
  epoch: number;
}

export interface PlanRetentionOptions {
  now?: number;
  windowStart?: number;
 /** 未给 windowStart 时用它算窗口(缺省 7 天)。 */
  days?: number;
  evidenceSessions?: EvidenceSessionBag;
}

export interface RetentionPlan {
 /** 保留(含 pinned)。 */
  keep: string[];
 /** 淘汰(与 pinned 互斥,绝不含 pinned)。 */
  drop: string[];
 /** 钉扎路径(pin=true 的子集,已排序)。 */
  pinned: string[];
 /** 钉扎原因:PIN_EVIDENCE / PIN_WINDOW。 */
  pinnedReason: Record<string, string>;
}

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 批量判定:按 verdict 分流成 keep/drop/pinned。drop 里不会出现 pinned。
 * 输出三组都按路径字典序排序(同输入同输出,便于审计与快照比对)。
 */
export function planRetention(
  files: readonly RetentionFileEntry[],
  opts: PlanRetentionOptions = {},
): RetentionPlan {
  const rawNow = Number(opts?.now);
  const now = Number.isFinite(rawNow) ? rawNow : Date.now();
  const rawStart = Number(opts?.windowStart);
  const windowStart = Number.isFinite(rawStart) ? rawStart : miningWindowStart({ now, days: opts?.days });

  const keep: string[] = [];
  const drop: string[] = [];
  const pinned: string[] = [];
  const reasons = new Map<string, string>();

  const list = Array.isArray(files) ? files : [];
  for (const f of list) {
    if (!f || typeof f.path !== "string") continue;
    const v = retentionVerdict({
      sessionId: String(f.sessionId ?? ""),
      epoch: Number(f.epoch),
      now,
      windowStart,
      evidenceSessions: opts?.evidenceSessions,
    });
    if (v.keep) {
      keep.push(f.path);
      if (v.pin) {
        pinned.push(f.path);
        reasons.set(f.path, v.reason);
      }
    } else {
      drop.push(f.path);
    }
  }

  keep.sort(byPath);
  drop.sort(byPath);
  pinned.sort(byPath);
  const pinnedReason: Record<string, string> = {};
  for (const p of pinned) pinnedReason[p] = reasons.get(p) ?? "mining-window";

  return { keep, drop, pinned, pinnedReason };
}

/**
 * 路径段净化:去掉分隔符/`..`/控制字符,防 `../` 逃出证据区(迁移目标由文件名派生,
 * 文件名理论上来自本仓写入,但迁移是好东西,不该成为路径穿越的写入原语)。
 */
function safeSegment(raw: unknown, fallback: string): string {
  const s = String(raw ?? "")
    .replace(/[\u0000-\u001f]/g, "_")
    .replace(/[\\/]+/g, "_")
    .replace(/\.\./g, "_")
    .trim();
  const cleaned = s.replace(/^\.+/, "_");
  if (cleaned === "") return fallback;
  return cleaned.slice(0, 120);
}

/**
 * 迁移目标路径:`<root>/.genie/evidence/traces/<safe session>/<safe name>`。
 * 证据区与轨迹区同根不同目录——迁移=把「被引用的现场」副本放进证据区,原处文件仍被 pin,
 * 不搬走(清理器不删它,是否删除由人决定)。
 */
export function migratePathFor(root: string, sessionId: string, name: string): string {
  const base = String(root ?? "").replace(/[\\/]+$/, "");
  const parts = [".genie", "evidence", "traces", safeSegment(sessionId, "_session"), safeSegment(name, "_trace.json")];
  return base === "" ? parts.join("/") : `${base}/${parts.join("/")}`;
}
