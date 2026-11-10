/**
 * 已读文件状态 Map(「同文件读第二遍」机制层;入口语义参考 ZCode
 * packages/core/src/tool/read-file-state.ts 的状态键 + mtime 归一化思路,持久化面不复刻)。
 * 提示词层已有「同文件读第二遍=信号」的纪律,但没有机制面事实可查:模型只能凭记忆判断
 * 「这个文件我读过没有」,重读死循环(microcompact.ts 头注登记的 read_file×31 注意)根因之一。
 * 本模块补机制层:
 * - **登记**:read_file 执行成功时把 {path, mtimeMs, readAt} 记进 per-session 内存 Map
 *   (session 隔离;进程内生命周期与 loop 一致,不落 journal——纯提示层事实,不是会话真相)。
 * - **注入**:loop 每步组装消息时(与 todo reminder 同一注入点)把清单渲染成
 *   ephemeral `<system-reminder>` 块(不落 journal,与 todo 提醒同语义)。
 * - **上限**:清单超 MAX_REMINDER_FILES 只列最近 N 个(防提醒块随会话线性膨胀)。
 * 归一化(照 ZCode 思路,不照抄实现):
 * - path:统一 `/` 分隔 + trim——同一文件经不同写法(反斜杠/尾随空白)命中同一条目;
 *   键用相对路径(工具已按根内相对路径展示),不做真实路径 resolve(围栏已由 file-tools 保证)。
 * - mtimeMs:Math.floor(去亚毫秒抖动)——「文件未变」的判据是整数毫秒相等(ZCode
 *   normalizeReadFileStateMtimeMs 同语义)。
 */

/** 单条已读记录:path 相对项目根(已归一化)、mtimeMs 读时刻文件 mtime(取整)、readAt 读取时刻。 */
export interface ReadFileEntry {
  path: string;
  mtimeMs: number;
  readAt: number;
 /** 已读行段(合并后,升序):读传递( D3 复测)——主 agent 已读片段是子代理「勿重读」的依据。 */
  ranges?: Array<{ off: number; end: number }>;
 /** 本会话累计读取次数(重复读取去重:每次 recordFileRead +1;缺省(旧数据)=按 1 次算。 */
  readCount?: number;
}

/** 已注入视觉台账条目(重复读取去重·图片面):同 session+相对路径+mtime 只注入一次。 */
export interface ImageReadEntry {
  path: string;
  mtimeMs: number;
  injectedAt: number;
  count: number;
}

/** 提醒块最多列出的文件数(超出只列最近 N 个,防膨胀)。 */
export const MAX_REMINDER_FILES = 15;

/** 注册表保留的会话数上限(LRU:超限淘汰最久未登记的会话,防长跑进程内存无界增长)。 */
export const MAX_TRACKED_SESSIONS = 64;

/** 读传递任务书块上限(字符):防反向膨胀——注入成本必须远小于它省下的重读 token(D3 经验证 17.5%/25k tok)。 */
export const MAX_HANDOFF_BLOCK_CHARS = 700;
/** 读传递任务书块最多列出的文件数。 */
export const MAX_HANDOFF_BLOCK_FILES = 8;

/** 无限行段的哨兵末端(缺省读=全文件)。 */
export const RANGE_END_INF = Number.POSITIVE_INFINITY;

/** per-session 注册表:sessionId → (归一化 path → 条目)。Map 迭代序=登记时间序(LRU 用)。 */
const sessions = new Map<string, Map<string, ReadFileEntry>>();

/** 已注入视觉台账:sessionId → (归一化 path → 条目)。与读文件台账分开(判据同样是 path+mtime)。 */
const imageSessions = new Map<string, Map<string, ImageReadEntry>>();

/** path 归一化:统一 `/` 分隔 + trim(仅形态归一,不做 resolve)。 */
export function normalizeReadPath(filePath: string): string {
  return String(filePath ?? "").trim().replace(/\\/g, "/");
}

/** mtime 归一化:去亚毫秒抖动,「未变」判据是取整后相等。 */
export function normalizeReadMtime(mtimeMs: number | undefined): number {
  return Math.floor(Number(mtimeMs) || 0);
}

/**
 * 登记一次成功读取(同 path 覆盖为最新 mtime/readAt:读同一文件两次只留最新一条)。
 * 返回归一化后的条目(便于调用方/测试断言)。
 * ranges 入参(读传递):缺省=旧行为(无行段信息,视为全文件);传入则与既有行段
 * 合并去重(升序、相邻段拼缝),供「父已读哪些片段」的跨 agent 传递。
 */
export function recordFileRead(sessionId: string, filePath: string, mtimeMs: number, readAt: number = Date.now(), ranges?: Array<{ off: number; end: number }>): ReadFileEntry {
  const path = normalizeReadPath(filePath);
  const prev = sessions.get(sessionId)?.get(path);
  const entry: ReadFileEntry = {
    path,
    mtimeMs: normalizeReadMtime(mtimeMs),
    readAt,
    readCount: (prev?.readCount ?? 0) + 1,
    ...(ranges && ranges.length ? { ranges: mergeRanges([...(prev?.ranges ?? []), ...ranges]) } : {}),
  };
  let m = sessions.get(sessionId);
  if (!m) { m = new Map(); }
  else sessions.delete(sessionId); // 重新插到迭代序末尾=本会话最近仍活跃(LRU 依据)
  m.set(path, entry);
  sessions.set(sessionId, m);
  while (sessions.size > MAX_TRACKED_SESSIONS) {
    const oldest = sessions.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    clearReadFiles(oldest); // 淘汰最久未登记的会话(提示层事实,丢清单不影响任何真相)
  }
  return entry;
}

/** 行段合并:升序排序、重叠/相邻(拼缝 1 行)合并;off≥1 钳制。 */
function mergeRanges(ranges: Array<{ off: number; end: number }>): Array<{ off: number; end: number }> {
  const norm = ranges
    .map((r) => ({ off: Math.max(1, Math.floor(r.off || 1)), end: Math.floor(r.end ?? Number.POSITIVE_INFINITY) || Number.POSITIVE_INFINITY }))
    .filter((r) => r.end >= r.off)
    .sort((a, b) => a.off - b.off);
  const out: Array<{ off: number; end: number }> = [];
  for (const r of norm) {
    const last = out[out.length - 1];
    if (last && r.off <= last.end + 1) last.end = Math.max(last.end, r.end); // 重叠或相邻拼缝
    else out.push({ ...r });
  }
  return out;
}

/** 读会话已读清单(readAt 新→旧);无记录=空数组。 */
export function readFilesOf(sessionId: string): ReadFileEntry[] {
  const m = sessions.get(sessionId);
  if (!m || m.size === 0) return [];
  return [...m.values()].sort((a, b) => b.readAt - a.readAt);
}

// ---- 重复读取去重(同文件同 mtime 同行段已在上下文,不再重复注入正文) ----
// 判据(纯函数,无副作用):同 path + 归一化 mtime 相等 + 请求行段 [off,end] 已被登记 ranges
// 完全覆盖(end=RANGE_END_INF 视为到文件尾;条目无 ranges=旧数据,视为全文已覆盖)。
// 只判「是否重复」,是否真的省略注入由调用方(force/首读/父键口径)决定。

/** 请求行段是否被已登记行段完全覆盖(旧数据无 ranges=全文已读)。 */
export function rangeCovered(ranges: ReadonlyArray<{ off: number; end: number }> | undefined, off: number, end: number): boolean {
  const wantOff = Math.max(1, Math.floor(Number(off) || 1));
  const wantEnd = Number.isFinite(end) ? Math.floor(end) : RANGE_END_INF;
  const rs = ranges && ranges.length > 0 ? ranges : [{ off: 1, end: RANGE_END_INF }];
  // r.end>=wantEnd 同时覆盖「有限段覆盖有限请求」与「INF 段覆盖任意请求」(Infinity>=Infinity 成立)。
  return rs.some((r) => r.off <= wantOff && r.end >= wantEnd);
}

/** 去重判定结果:duplicate=是否命中重复;readCount=该文件在本会话已读次数(给「第 N 次读取」用)。 */
export interface RepeatReadVerdict {
  duplicate: boolean;
  readCount: number;
}

/** 判重(读前调用;不登记任何东西):同 path + 同归一化 mtime + 行段已覆盖 → duplicate。
 * exactWindow=true(工具面用):要求请求窗口与某条已登记窗口「完全一致」才判重复——
 * 更保守,绝不吞模型点名要的子窗口(既有 file-tools 行为:整读后再读 5-7 仍返回正文)。 */
export function checkRepeatRead(
  sessionId: string,
  filePath: string,
  mtimeMs: number,
  off: number,
  end: number,
  exactWindow = false): RepeatReadVerdict {
  const entry = sessions.get(sessionId)?.get(normalizeReadPath(filePath));
  if (!entry) return { duplicate: false, readCount: 0 };
  const readCount = entry.readCount ?? 1; // 旧数据(无 readCount 字段)按已读 1 次算
  if (normalizeReadMtime(entry.mtimeMs) !== normalizeReadMtime(mtimeMs)) return { duplicate: false, readCount };
  if (!exactWindow) return { duplicate: rangeCovered(entry.ranges, off, end), readCount };
  const wantOff = Math.max(1, Math.floor(Number(off) || 1));
  const wantEnd = Number.isFinite(end) ? Math.floor(end) : RANGE_END_INF;
  const rs = entry.ranges && entry.ranges.length > 0 ? entry.ranges : [{ off: 1, end: RANGE_END_INF }];
  return { duplicate: rs.some((r) => r.off === wantOff && r.end === wantEnd), readCount };
}

/** 图片台账判重:同 path + 同归一化 mtime → seen(已注入过视觉通道)。 */
export function checkImageInjected(sessionId: string, filePath: string, mtimeMs: number): { seen: boolean; count: number } {
  const entry = imageSessions.get(sessionId)?.get(normalizeReadPath(filePath));
  if (!entry) return { seen: false, count: 0 };
  return { seen: normalizeReadMtime(entry.mtimeMs) === normalizeReadMtime(mtimeMs), count: entry.count };
}

/** 登记一次成功注入视觉通道的图片(同 path 覆盖为最新 mtime/count 递增)。 */
export function recordImageInjected(sessionId: string, filePath: string, mtimeMs: number, injectedAt: number = Date.now()): ImageReadEntry {
  const path = normalizeReadPath(filePath);
  let m = imageSessions.get(sessionId);
  const prev = m?.get(path);
  const entry: ImageReadEntry = { path, mtimeMs: normalizeReadMtime(mtimeMs), injectedAt, count: (prev?.count ?? 0) + 1 };
  if (!m) { m = new Map(); imageSessions.delete(sessionId); } // 重新插到迭代序末尾(LRU 依据)
  else imageSessions.delete(sessionId);
  m.set(path, entry);
  imageSessions.set(sessionId, m);
  while (imageSessions.size > MAX_TRACKED_SESSIONS) {
    const oldest = imageSessions.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    imageSessions.delete(oldest); // 图片台账同样是提示层事实,丢清单不影响任何真相
  }
  return entry;
}

/** 清该会话的图片台账(clearReadFiles 内部同用)。 */
export function clearInjectedImages(sessionId: string): void {
  imageSessions.delete(sessionId);
}

/** 会话回收(LRU 淘汰路径调用;测试清理同用):丢掉该会话清单(含图片台账),提前释放。 */
export function clearReadFiles(sessionId: string): void {
  sessions.delete(sessionId);
  imageSessions.delete(sessionId);
}

// ---- 读传递( D3 复测 17.5% 跨 agent 读重叠治理) ----
// 父会话已读事实(含行段)→ 子代理两类触达:
//  ① spawn 时随任务书注入(renderParentReadBlock):哪些文件哪些行段父已读过+引用指引;
//  ② 子代理 read_file 命中交叠时尾注(renderParentReadHint)。
// 数据源=进程内 per-session 注册表本体(readFilesOf):spawn 面与子读面同进程直查,不另设快照
// 缓存——父清单 spawn 后继续增长,后来派发的兄弟子代理自动看到最新事实。env GENIE_READ_HANDOFF=off
// 由调用方判定(机制层保持纯函数,不读 env)。

/** 行段人话(无限末端=「尾」)。 */
function fmtRangeEnd(end: number): string {
  return Number.isFinite(end) ? String(end) : "尾";
}

/** 渲染行段摘要:至多 3 段,超出折叠为「+N 段」。 */
function fmtRanges(ranges: Array<{ off: number; end: number }> | undefined): string {
  if (!ranges || ranges.length === 0) return "全文";
  const head = ranges.slice(0, 3).map((r) => `${r.off}-${fmtRangeEnd(r.end)}`).join(",");
  return ranges.length > 3 ? head + ",+" + (ranges.length - 3) + "段" : head;
}

/**
 * 读传递任务书块(spawn 注入;上限 MAX_HANDOFF_BLOCK_CHARS≈175 tok 防反向膨胀——对经验证
 * 25k tok/6.88h 重叠量,注入/收益比 <1%)。空清单=null(零注入)。
 */
export function renderParentReadBlock(entries: ReadonlyArray<ReadFileEntry> | undefined): string | null {
  if (!entries || entries.length === 0) return null;
  const lines = entries.slice(0, MAX_HANDOFF_BLOCK_FILES).map((e) => `- ${e.path}:行段 ${fmtRanges(e.ranges)}(mtime=${e.mtimeMs || "?"})`);
  const more = entries.length - Math.min(entries.length, MAX_HANDOFF_BLOCK_FILES);
  const text = [
    "<父会话已读提示>",
    "以下文件片段父会话(主 agent)本轮已读过;任务书引用的结论优先采用,勿再整读这些文件——确需核实时只读未覆盖的行段(offset/limit 局部读):",
    ...lines,
    ...(more > 0 ? [`(共 ${entries.length} 个,只列最近 ${MAX_HANDOFF_BLOCK_FILES} 个)`] : []),
    "</父会话已读提示>",
  ].join("\n");
  return text.length > MAX_HANDOFF_BLOCK_CHARS ? text.slice(0, MAX_HANDOFF_BLOCK_CHARS) + "…(截断)</父会话已读提示>" : text;
}

/**
 * 子读命中父(或经父键共享的兄弟)已读行段交叠时的尾注(读时触达:文件+行段级)。
 * 交叠判据=行区间交叠≥1 行;无行段信息的条目视为全文已读(旧数据兼容)。返回 null=不命中/无数据。
 */
export function renderParentReadHint(entries: ReadonlyArray<ReadFileEntry> | undefined, path: string, off: number, end: number): string | null {
  if (!entries) return null;
  const p = normalizeReadPath(path);
  const hit = entries.find((e) => e.path === p);
  if (!hit) return null;
  const rs = hit.ranges && hit.ranges.length > 0 ? hit.ranges : [{ off: 1, end: Number.POSITIVE_INFINITY }];
  const overlap = rs.some((r) => Math.max(off, r.off) < Math.min(end, Number.isFinite(r.end) ? r.end : end));
  if (!overlap) return null;
  return `(已读提示:${hit.path} 行段 ${fmtRanges(hit.ranges)} 父会话/兄弟代理已读(mtime=${hit.mtimeMs || "?"}),该片段上游要点已在任务书或兄弟结论里——引用结论即可,勿再整读;确需核实只读未覆盖行段)`;
}

/** 相对时间(人话,不引外部依赖):刚刚 / N 分钟前 / N 小时前 / N 天前。 */
function relativeTime(readAt: number, now: number): string {
  const ms = Math.max(0, now - readAt);
  if (ms < 60_000) return "刚刚";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return min + " 分钟前";
  const hour = Math.floor(min / 60);
  if (hour < 24) return hour + " 小时前";
  return Math.floor(hour / 24) + " 天前";
}

/**
 * 已读文件提醒块(ephemeral,不落 journal;由 loop 每步组装消息时注入)。
 * 无已读记录=null(不产生空提醒,与 buildTodoReminder 同契约)。now 可注入(测试确定性)。
 */
export function buildReadFilesReminder(sessionId: string, now: number = Date.now()): string | null {
  const all = readFilesOf(sessionId);
  if (all.length === 0) return null;
  const shown = all.slice(0, MAX_REMINDER_FILES);
  const more = all.length - shown.length;
  return [
    "<system-reminder>",
    "本会话已读文件清单(按读取时间新→旧):",
    ...shown.map((e) => `- ${e.path}(${relativeTime(e.readAt, now)})`),
    ...(more > 0 ? [`(共 ${all.length} 个,只列最近 ${MAX_REMINDER_FILES} 个)`] : []),
    "重读前先看清单:文件未变就不要整读,要细节用 offset/limit 局部读。",
    "</system-reminder>",
  ].join("\n");
}