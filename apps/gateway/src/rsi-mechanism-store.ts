/**
 * RSI 机制开关 + 结果覆盖层的持久层( P0-2)。
 * 分层红线:
 * - 目录与 brief 的**唯一真相**是 runtime 的 `@lampgenie/runtime/agent/rsi-mechanisms`
 * (12 条 spec / 12 个标题 / 数据源);本文件只做 IO、原子落盘与投影,不复制任何目录文案。
 * - 只写 `<root>/.genie/rsi/mechanisms.json`、`<root>/.genie/rsi/results.jsonl`、
 * `<root>/.genie/rsi/agent-runs/<mechanismId>/…`;不改任何既有 `*-store.ts` 的台账。
 * - 除参数错误(root/id 形状不对)外不 throw:IO/投影失败一律折叠成稳定码返回。
 * 磁盘布局:
 * .genie/rsi/mechanisms.json { [mechanismId]: RsiMechanismState }
 * .genie/rsi/results.jsonl 覆盖层事件(append-only,逐行 JSON)
 * .genie/rsi/agent-runs/<mech>/<runId>.json 一次 agent 运行记录
 * .genie/rsi/agent-runs/<mech>/<runId>.result.json agent 写的结果 {"items":[…]}
 * 两层结果模型(为什么要两层):
 * - **基础层**是 agent 每次运行的真实产物(`<runId>.result.json`):只增不改,runId 隔离并发,
 * 同一机制连点两次 run 不会互相覆盖。
 * - **覆盖层**是人的动作(改标题/改状态/删除),落 `results.jsonl`,按行序重放;
 * `update` 打 patch、`delete` 置墓碑。人永远不需要改 agent 的原始产物,审计链完整。
 * 容错口径(全部经验证有断言):
 * - `mechanisms.json` 缺失或损坏 → 返回 12 条 catalog 缺省(**不写盘**);文件缺条目 → 补齐。
 * - `results.jsonl` 坏行(JSON 坏 / 缺 type / 缺 itemId)→ 跳过,一行坏不整文件失效。
 * - run 记录坏文件 → listRuns 跳过;`<runId>.result.json` 坏或形状不对 → []。
 */
import { appendFile, mkdir, open, readFile, readdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  RSI_MECHANISMS,
  RSI_MECHANISM_IDS,
  RSI_RESULT_STATUSES,
  mechanismSpec,
  type RsiMechanismDriver,
  type RsiMechanismId,
  type RsiResultStatus,
} from "@lampgenie/runtime/agent/rsi-mechanisms";
// RSI 产出注入安全边界(#197):agent 结果文本进面板/聊天卡前统一转义控制标签,
// 轨迹里的 `<system>`/`<|…|>` 不能借结果条目升级成指令。纯函数,runtime 既有实现。
import { escapeControlTags } from "@lampgenie/runtime/agent/rsi-injection-guard";

/** 机制结果条目的来源(agent 产物 / 代码派生 / 人工新增)。 */
export const RSI_RESULT_SOURCES = ["agent", "code", "manual"] as const;

export type RsiResultSource = (typeof RSI_RESULT_SOURCES)[number];

/** 单机制结果条数上限(与 step 稿的 N=50 一致)。 */
export const MAX_RESULT_ITEMS = 50;

/** 标题/摘要落盘截断上限。 */
const MAX_TEXT = 300;

/** 稳定码(只有这些会出现在 reason 里,调用方按码分支,不解析文案)。 */
export const RSI_MECHANISM_STORE_CODES = [
  "UNKNOWN_MECHANISM",
  "ITEM_NOT_FOUND",
  "INVALID_PATCH",
  "WRITE_FAILED",
] as const;

export type RsiMechanismStoreCode = (typeof RSI_MECHANISM_STORE_CODES)[number];

// ------------------------------------------------------------------ 形状

export interface RsiMechanismState {
  id: string;
  enabled: boolean;
  driver: "agent" | "code";
  updatedAt: number;
  by?: string;
}

export interface RsiResultItem {
  id: string;
  mechanismId: string;
  title: string;
  summary: string;
  detail?: string;
 /** 质量契约 v2:每条结论必须带证据/影响/建议(旧条目无这些字段,向后兼容)。 */
  evidence?: string;
  impact?: string;
  action?: string;
  status?: RsiResultStatus;
  source?: RsiResultSource;
  runId?: string;
  at: number;
  deleted?: boolean;
}

/** 单次运行的结果质量评估(拒绝流水账;由 rsi-quality 纯函数计算,随 run 落盘)。 */
export interface RsiRunQuality {
  items: number;
  evidenced: number;
  impacted: number;
  actionable: number;
  shallow: number;
  duplicates: number;
  overLimit: boolean;
  score: number;
  issues: { code: string; itemId?: string; note: string }[];
}

export type RsiResultEventType = "upsert" | "update" | "delete";

export interface RsiResultEventInput {
  type: RsiResultEventType;
  mechanismId: string;
  itemId: string;
  item?: Partial<RsiResultItem>;
  patch?: {
    title?: string;
    summary?: string;
    detail?: string;
    evidence?: string;
    impact?: string;
    action?: string;
    status?: RsiResultStatus;
  };
  by?: string;
  at?: number;
}

export interface RsiRunCostRecord {
  inputTokens: number;
  cachedTokens: number;
  cacheCreationTokens?: number;
  outputTokens: number;
  totalTokens: number;
  model?: string;
 /** 金额(元);null=单价缺失(不按 0 冒充)。 */
  amountCny: number | null;
 /** 缺价段名(cacheRead/cacheWrite/inputMiss/output)。 */
  missing: string[];
}

export interface RsiRunAnalysisRecord {
  windowDays: number;
  candidates: { sessionId: string; projectId?: string; lastActiveAt?: number }[];
  analyzed: { sessionId: string; projectId?: string }[];
}

export interface RsiRunRecord {
  runId: string;
  mechanismId: string;
  taskId?: string;
  sessionId?: string;
  status: "running" | "done" | "failed";
  startedAt: number;
  finishedAt?: number;
  error?: string;
 /** 本次运行成本( RSI-SESSION-COST;旧 run 文件无此字段)。 */
  cost?: RsiRunCostRecord;
 /** 本次运行的会话分析计划与认账结果(同一批:派单时写 candidates,收尾时补 analyzed)。 */
  analysis?: RsiRunAnalysisRecord;
 /** 自动调度周期 id( RSI-SELF-DRIVE;手动运行/旧数据无此字段)。 */
  cycleId?: string;
 /** 本次运行是重试哪一次 run(缺省=首次运行)。 */
  retryOf?: string;
 /** 已被自动重试的次数(重试后写在旧记录上;上限由调度器策略控制)。 */
  retryCount?: number;
 /** 本次 token 预算(0/缺省=未设预算)。 */
  budgetTokens?: number;
 /** 实验配额因子(ROI downshift 的 experimentQuotaFactor 首次有了消费方——
 * experiments 机制的任务书按它限「最多转入多少条候选」;只在 <1 时记录)。 */
  experimentQuotaFactor?: number;
 /** 收尾判定:总 token 超过预算(true 时调度器会追加一条 warn 结果并暂停本周期)。 */
  budgetExceeded?: boolean;
 /** 收尾判定:注入了候选会话但 agent 一个都没认账(轨迹类机制的质量门)。 */
  analysisMissing?: boolean;
 /** 结果质量评估(质量契约 v2;旧记录无此字段)。 */
  quality?: RsiRunQuality;
}

/** 重放出来的条目:多一个 `synthetic`(由 update/delete 在缺失基础上造出的占位,不并入基础层)。 */
interface ReplayItem extends RsiResultItem {
  synthetic?: boolean;
}

// ------------------------------------------------------------------ 基础工具

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asPool(value: unknown): RsiMechanismDriver | undefined {
  return value === "agent" || value === "code" ? value : undefined;
}

function asStatus(value: unknown): RsiResultStatus | undefined {
  return typeof value === "string" && (RSI_RESULT_STATUSES as readonly string[]).includes(value)
    ? (value as RsiResultStatus)
    : undefined;
}

function asSource(value: unknown): RsiResultSource | undefined {
  return typeof value === "string" && (RSI_RESULT_SOURCES as readonly string[]).includes(value)
    ? (value as RsiResultSource)
    : undefined;
}

function truncate(text: string, limit = MAX_TEXT): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

/** RSI 产出文本的统一净化:先剥掉 agent 自带的「权威前缀」(只能由系统加),再转义控制标签。 */
const RSI_AUTHORITY_PREFIX = "[RSI 生成·非系统权威]";
function sanitizeRsiText(text: string): string {
  const body = text.startsWith(RSI_AUTHORITY_PREFIX) ? text.slice(RSI_AUTHORITY_PREFIX.length).trimStart() : text;
  return escapeControlTags(body).text;
}

function assertRoot(root: string): string {
  if (typeof root !== "string" || root.trim() === "") throw new TypeError("root 必须是非空目录路径");
  return root;
}

function rsiDir(root: string): string {
  return join(root, ".genie", "rsi");
}

/** 机制开关文件:`<root>/.genie/rsi/mechanisms.json`。 */
export function mechanismsPath(root: string): string {
  return join(rsiDir(root), "mechanisms.json");
}

/** 结果覆盖层台账:`<root>/.genie/rsi/results.jsonl`。 */
export function resultsPath(root: string): string {
  return join(rsiDir(root), "results.jsonl");
}

/** 运行记录目录:`<root>/.genie/rsi/agent-runs`(带 mechanismId 时下钻一层)。 */
export function runsDir(root: string, mechanismId?: string): string {
  const base = join(rsiDir(root), "agent-runs");
  return mechanismId === undefined ? base : join(base, mechanismId);
}

/** 一次运行记录文件:`<root>/.genie/rsi/agent-runs/<mech>/<runId>.json`。 */
export function runFilePath(root: string, mechanismId: string, runId: string): string {
  return join(runsDir(root, mechanismId), `${runId}.json`);
}

/** agent 该写的结果文件:`<root>/.genie/rsi/agent-runs/<mech>/<runId>.result.json`。 */
export function resultFilePath(root: string, mechanismId: string, runId: string): string {
  return join(runsDir(root, mechanismId), `${runId}.result.json`);
}

/** 原子写:同目录 `.tmp` → fsync → rename(跨分区 rename 不原子,所以 tmp 必须同目录)。 */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

/** 追加一行(行内不留换行;父目录自动建)。 */
async function appendLine(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

async function readTextOrEmpty(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

// ------------------------------------------------------------------ 机制开关

function defaultState(id: RsiMechanismId): RsiMechanismState {
  const spec = RSI_MECHANISMS[id];
  return { id, enabled: spec.defaultEnabled, driver: spec.defaultDriver, updatedAt: 0 };
}

function readStateEntry(key: string, raw: unknown): RsiMechanismState | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.enabled !== "boolean") return undefined;
  const driver = asPool(raw.driver);
  if (!driver) return undefined;
  const updatedAt = asNumber(raw.updatedAt) ?? 0;
  const by = asString(raw.by);
  return by === undefined ? { id: key, enabled: raw.enabled, driver, updatedAt } : { id: key, enabled: raw.enabled, driver, updatedAt, by };
}

/**
 * 读机制开关。文件缺失 / 坏 / 形状不对 → 12 条 catalog 缺省(**不写盘**:缺失文件不该被读操作
 * 顺手创建,否则「用户从没动过开关」与「用户把所有开关关掉」在盘上长得一样)。
 * 文件存在但缺条目 → 用 catalog 缺省补齐。
 */
export async function loadMechanisms(root: string): Promise<Record<string, RsiMechanismState>> {
  const base = assertRoot(root);
  const text = await readTextOrEmpty(mechanismsPath(base));
  let parsed: unknown;
  if (text.trim() !== "") {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  const raw = isRecord(parsed) ? (isRecord(parsed.mechanisms) ? parsed.mechanisms : parsed) : {};
  const out: Record<string, RsiMechanismState> = {};
  for (const [key, value] of Object.entries(raw)) {
    const entry = readStateEntry(key, value);
    if (entry) out[key] = entry;
  }
  for (const id of RSI_MECHANISM_IDS) {
    if (!out[id]) out[id] = defaultState(id);
  }
  return out;
}

/** 改一个机制的开关/驱动。未知 id → UNKNOWN_MECHANISM;非法 patch → INVALID_PATCH。 */
export async function setMechanism(
  root: string,
  id: string,
  patch: { enabled?: boolean; driver?: "agent" | "code" },
  by?: string): Promise<{ ok: boolean; reason?: string; mechanism?: RsiMechanismState }> {
  const base = assertRoot(root);
  const spec = mechanismSpec(id);
  if (!spec) return { ok: false, reason: "UNKNOWN_MECHANISM" };
  const wanted = isRecord(patch) ? patch : {};
  if (wanted.enabled !== undefined && typeof wanted.enabled !== "boolean") {
    return { ok: false, reason: "INVALID_PATCH" };
  }
  const driver = wanted.driver === undefined ? undefined : asPool(wanted.driver);
  if (wanted.driver !== undefined && driver === undefined) return { ok: false, reason: "INVALID_PATCH" };

  const states = await loadMechanisms(base);
  const prev = states[spec.id] ?? defaultState(spec.id);
  const next: RsiMechanismState = {
    id: spec.id,
    enabled: typeof wanted.enabled === "boolean" ? wanted.enabled : prev.enabled,
    driver: driver ?? prev.driver,
    updatedAt: Date.now(),
  };
  const byText = asString(by);
  if (byText !== undefined) next.by = byText;
  states[spec.id] = next;
  try {
    await writeJsonAtomic(mechanismsPath(base), states);
  } catch {
    return { ok: false, reason: "WRITE_FAILED" };
  }
  return { ok: true, mechanism: next };
}

// ------------------------------------------------------------------ 覆盖层事件

/** 追加一条覆盖层事件(append-only,mkdir 自动;不做行数校验——事件本身就是审计事实)。 */
export async function appendResultEvent(root: string, ev: RsiResultEventInput): Promise<void> {
  const base = assertRoot(root);
  const type = ev?.type;
  if (type !== "upsert" && type !== "update" && type !== "delete") {
    throw new TypeError("appendResultEvent: type 必须是 upsert | update | delete");
  }
  const mechanismId = asString(ev.mechanismId);
  if (!mechanismId) throw new TypeError("appendResultEvent: mechanismId 必须是非空字符串");
  const itemId = asString(ev.itemId);
  if (!itemId) throw new TypeError("appendResultEvent: itemId 必须是非空字符串");
  const line: Record<string, unknown> = { v: 1, type, mechanismId, itemId, at: asNumber(ev.at) ?? Date.now() };
  if (isRecord(ev.item)) line.item = ev.item;
  if (isRecord(ev.patch)) line.patch = ev.patch;
  const by = asString(ev.by);
  if (by !== undefined) line.by = by;
  await appendLine(resultsPath(base), line);
}

function itemFromPartial(mechanismId: string, itemId: string, raw: Record<string, unknown>, at: number): ReplayItem {
  const item: ReplayItem = {
    id: itemId,
    mechanismId,
    title: truncate(typeof raw.title === "string" ? raw.title : itemId),
    summary: truncate(typeof raw.summary === "string" ? raw.summary : ""),
    at: asNumber(raw.at) ?? at,
  };
  const detail = asString(raw.detail);
  if (detail !== undefined) item.detail = detail;
 // 质量四件套(旧条目没有这些字段,读取侧保持 undefined)。
  const evidence = asString(raw.evidence);
  if (evidence !== undefined) item.evidence = truncate(evidence);
  const impact = asString(raw.impact);
  if (impact !== undefined) item.impact = truncate(impact);
  const action = asString(raw.action);
  if (action !== undefined) item.action = truncate(action);
  const status = asStatus(raw.status);
  if (status !== undefined) item.status = status;
  const source = asSource(raw.source);
  if (source !== undefined) item.source = source;
  const runId = asString(raw.runId);
  if (runId !== undefined) item.runId = runId;
  if (raw.deleted === true) item.deleted = true;
  return item;
}

function applyPatchTo(item: ReplayItem, patch: Record<string, unknown>, at: number): ReplayItem {
  const next: ReplayItem = { ...item, at };
  if (typeof patch.title === "string") next.title = truncate(patch.title);
  if (typeof patch.summary === "string") next.summary = truncate(patch.summary);
  if (typeof patch.detail === "string") next.detail = patch.detail;
  if (typeof patch.evidence === "string") next.evidence = truncate(patch.evidence);
  if (typeof patch.impact === "string") next.impact = truncate(patch.impact);
  if (typeof patch.action === "string") next.action = truncate(patch.action);
  const status = asStatus(patch.status);
  if (status !== undefined) next.status = status;
  if (patch.deleted === true) next.deleted = true;
  return next;
}

/** 重放事件行:坏行(JSON 坏 / 缺 type / 缺 id)跳过;同 id later wins。 */
function replayEvents(text: string, mechanismId?: string): Map<string, ReplayItem> {
  const map = new Map<string, ReplayItem>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const type = asString(parsed.type);
    const mech = asString(parsed.mechanismId);
    const itemId = asString(parsed.itemId);
    if (!type || !mech || !itemId) continue;
    if (mechanismId !== undefined && mech !== mechanismId) continue;
    const at = asNumber(parsed.at) ?? 0;
    const prev = map.get(itemId);
    if (type === "upsert") {
      map.set(itemId, itemFromPartial(mech, itemId, isRecord(parsed.item) ? parsed.item : {}, at));
      continue;
    }
    if (type === "update") {
      const patch: Record<string, unknown> = {
        ...(isRecord(parsed.item) ? parsed.item : {}),
        ...(isRecord(parsed.patch) ? parsed.patch : {}),
      };
      if (prev) {
        map.set(itemId, applyPatchTo(prev, patch, at));
      } else {
        const seed: ReplayItem = { ...applyPatchTo({ id: itemId, mechanismId: mech, title: itemId, summary: "", at }, patch, at), synthetic: true };
        map.set(itemId, seed);
      }
      continue;
    }
    if (type === "delete") {
      if (prev) {
        map.set(itemId, { ...prev, deleted: true, at: at === 0 ? prev.at : at });
      } else {
        map.set(itemId, {
          id: itemId,
          mechanismId: mech,
          title: itemId,
          summary: "",
          at,
          deleted: true,
          synthetic: true,
        });
      }
    }
  }
  return map;
}

function stripInternal(item: ReplayItem): RsiResultItem {
  const { synthetic: _synthetic, ...rest } = item;
  return rest;
}

/**
 * 投影覆盖层(重放 results.jsonl):upsert 建/替换、update 打 patch(不存在则建占位)、
 * delete 置墓碑。默认过滤 deleted,按 at 升序返回。
 */
export async function projectResults(
  root: string,
  mechanismId?: string,
  opts?: { includeDeleted?: boolean },
): Promise<RsiResultItem[]> {
  const base = assertRoot(root);
  const text = await readTextOrEmpty(resultsPath(base));
  const map = replayEvents(text, mechanismId === undefined ? undefined : mechanismId);
  const includeDeleted = opts?.includeDeleted === true;
  const items: RsiResultItem[] = [];
  for (const item of map.values()) {
    if (item.deleted === true && !includeDeleted) continue;
    items.push(stripInternal(item));
  }
  items.sort((a, b) => a.at - b.at);
  return items;
}

/** 改一条结果(覆盖层 update)。投影里没有(或只有墓碑)→ ITEM_NOT_FOUND。 */
export async function updateResultItem(
  root: string,
  mechanismId: string,
  itemId: string,
  patch: {
    title?: string;
    summary?: string;
    detail?: string;
    evidence?: string;
    impact?: string;
    action?: string;
    status?: RsiResultStatus;
  },
  by?: string): Promise<{ ok: boolean; reason?: string; item?: RsiResultItem }> {
  const base = assertRoot(root);
  const mech = asString(mechanismId);
  if (!mech) throw new TypeError("updateResultItem: mechanismId 必须是非空字符串");
  const target = asString(itemId);
  if (!target) throw new TypeError("updateResultItem: itemId 必须是非空字符串");
  const map = replayEvents(await readTextOrEmpty(resultsPath(base)), mech);
  const prev = map.get(target);
  if (!prev || prev.deleted === true) return { ok: false, reason: "ITEM_NOT_FOUND" };
  if (!isRecord(patch)) return { ok: false, reason: "INVALID_PATCH" };
  try {
    await appendResultEvent(base, { type: "update", mechanismId: mech, itemId: target, patch, by });
  } catch {
    return { ok: false, reason: "WRITE_FAILED" };
  }
  const next = applyPatchTo(prev, patch, Date.now());
  return { ok: true, item: stripInternal(next) };
}

/** 删一条结果(覆盖层 delete,落墓碑可 includeDeleted 复核)。 */
export async function deleteResultItem(
  root: string,
  mechanismId: string,
  itemId: string,
  by?: string,
  reason?: string): Promise<{ ok: boolean; reason?: string }> {
  const base = assertRoot(root);
  const mech = asString(mechanismId);
  if (!mech) throw new TypeError("deleteResultItem: mechanismId 必须是非空字符串");
  const target = asString(itemId);
  if (!target) throw new TypeError("deleteResultItem: itemId 必须是非空字符串");
  const map = replayEvents(await readTextOrEmpty(resultsPath(base)), mech);
  const prev = map.get(target);
  if (!prev || prev.deleted === true) return { ok: false, reason: "ITEM_NOT_FOUND" };
  try {
    await appendResultEvent(base, {
      type: "delete",
      mechanismId: mech,
      itemId: target,
      by: asString(by),
      at: Date.now(),
      ...(asString(reason) === undefined ? {} : { item: { detail: asString(reason) } }),
    });
  } catch {
    return { ok: false, reason: "WRITE_FAILED" };
  }
  return { ok: true };
}

// ------------------------------------------------------------------ 运行记录

/** 生成 runId:时间戳 base36 + 随机后缀(fs 合法、按字典序近似按时间序)。 */
export function newRunId(now?: number): string {
  const at = asNumber(now) ?? Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `run_${at.toString(36)}_${rand}`;
}

/** 起一次运行:落 `<mech>/<runId>.json`,status=running。 */
export async function startRun(
  root: string,
  input: {
    mechanismId: string;
    taskId?: string;
    sessionId?: string;
    runId?: string;
 /** 派单时的会话分析计划(候选名单;analyzed 收尾时才填)。 */
    analysis?: RsiRunAnalysisRecord;
 /** 自动调度周期 id / 重试来源 / token 预算( RSI-SELF-DRIVE)。 */
    cycleId?: string;
    retryOf?: string;
    budgetTokens?: number;
 /** 实验配额因子(experiments 机制的降频入参;缺省=不设限)。 */
    experimentQuotaFactor?: number;
  },
): Promise<RsiRunRecord> {
  const base = assertRoot(root);
  const mechanismId = asString(input?.mechanismId);
  if (!mechanismId) throw new TypeError("startRun: mechanismId 必须是非空字符串");
  const explicitRunId = asString(input.runId);
  const record: RsiRunRecord = {
 // 显式 runId:调用方(agent 运行器)必须先把 runId 写进任务书的结果路径,再落运行记录。
    runId: explicitRunId ?? newRunId(),
    mechanismId,
    status: "running",
    startedAt: Date.now(),
  };
  const taskId = asString(input.taskId);
  if (taskId !== undefined) record.taskId = taskId;
  const sessionId = asString(input.sessionId);
  if (sessionId !== undefined) record.sessionId = sessionId;
  const analysis = parseAnalysisRecord(input.analysis);
  if (analysis !== undefined) record.analysis = analysis;
 // RSI-SELF-DRIVE:周期/重试/预算三字段(旧调用不传=不写,旧行为不变)。
  const cycleId = asString(input.cycleId);
  if (cycleId !== undefined) record.cycleId = cycleId;
  const retryOf = asString(input.retryOf);
  if (retryOf !== undefined) record.retryOf = retryOf;
  if (typeof input.budgetTokens === "number" && Number.isFinite(input.budgetTokens) && input.budgetTokens > 0) {
    record.budgetTokens = Math.floor(input.budgetTokens);
  }
 // 实验配额只在降频(<1)时记录:配额=1 等于没降频,写了只会噪声。
  if (
    typeof input.experimentQuotaFactor === "number" && Number.isFinite(input.experimentQuotaFactor)
    && input.experimentQuotaFactor > 0 && input.experimentQuotaFactor < 1
  ) {
    record.experimentQuotaFactor = input.experimentQuotaFactor;
  }
  await writeJsonAtomic(runFilePath(base, mechanismId, record.runId), record);
  return record;
}

/** 记一次自动重试(在旧记录上 +1;读写原子,失败静默交给调用方的兜底)。 */
export async function markRunRetried(root: string, mechanismId: string, runId: string): Promise<void> {
  const base = assertRoot(root);
  const mech = asString(mechanismId);
  const id = asString(runId);
  if (!mech || !id) throw new TypeError("markRunRetried: mechanismId/runId 必须是非空字符串");
  const existing = await readRunFile(base, mech, id);
  if (!existing) return;
  existing.retryCount = (existing.retryCount ?? 0) + 1;
  await writeJsonAtomic(runFilePath(base, mech, id), existing);
}

/** 结束一次运行(记录不存在时按最小记录补写,不让收尾丢事件)。 */
export async function finishRun(
  root: string,
  mechanismId: string,
  runId: string,
  status: "done" | "failed",
  error?: string,
 /** 收尾时补落的成本/分析/质量门(可选;缺省=保留 run 文件里已有的值,兼容旧调用)。 */
  extra?: {
    cost?: RsiRunCostRecord;
    analysis?: RsiRunAnalysisRecord;
    finishedAt?: number;
 /** RSI-SELF-DRIVE:预算超限/分析未认账两条收尾判定。 */
    budgetExceeded?: boolean;
    analysisMissing?: boolean;
 /** 质量契约 v2:一次运行的结果质量评估。 */
    quality?: RsiRunQuality;
  },
): Promise<void> {
  const base = assertRoot(root);
  const mech = asString(mechanismId);
  if (!mech) throw new TypeError("finishRun: mechanismId 必须是非空字符串");
  const id = asString(runId);
  if (!id) throw new TypeError("finishRun: runId 必须是非空字符串");
  if (status !== "done" && status !== "failed") throw new TypeError("finishRun: status 必须是 done | failed");
 // 补账路径(finishedAt 已定)必须保留真实收尾时刻,不能改写成「这次轮询的时刻」。
  const finishedAt = asNumber(extra?.finishedAt) ?? Date.now();
  const existing = await readRunFile(base, mech, id);
  const record: RsiRunRecord = existing
    ? { ...existing, status, finishedAt }
    : { runId: id, mechanismId: mech, status, startedAt: Date.now(), finishedAt };
  const errorText = asString(error);
  if (errorText !== undefined) record.error = errorText;
  const cost = parseCostRecord(extra?.cost);
  if (cost !== undefined) record.cost = cost;
  const analysis = parseAnalysisRecord(extra?.analysis);
  if (analysis !== undefined) record.analysis = analysis;
 // 显式布尔落盘:false 也写(=「已判定,不超限/未缺失」),否则每次 rsi.status 都会重算一次。
  if (typeof extra?.budgetExceeded === "boolean") record.budgetExceeded = extra.budgetExceeded;
  if (typeof extra?.analysisMissing === "boolean") record.analysisMissing = extra.analysisMissing;
  const quality = parseQualityRecord(extra?.quality);
  if (quality !== undefined) record.quality = quality;
  await writeJsonAtomic(runFilePath(base, mech, id), record);
}

/** 成本记录净化:token 全是有限非负数,amountCny 允许 null(单价缺失),missing 只留字符串。 */
function parseCostRecord(raw: unknown): RsiRunCostRecord | undefined {
  if (!isRecord(raw)) return undefined;
  const inputTokens = asNumber(raw.inputTokens);
  const cachedTokens = asNumber(raw.cachedTokens);
  const outputTokens = asNumber(raw.outputTokens);
  const totalTokens = asNumber(raw.totalTokens);
  if (inputTokens === undefined || cachedTokens === undefined || outputTokens === undefined || totalTokens === undefined) {
    return undefined;
  }
  const amountRaw = raw.amountCny;
  const amountCny = amountRaw === null ? null : asNumber(amountRaw);
  if (amountCny === undefined) return undefined;
  const missing = Array.isArray(raw.missing) ? raw.missing.filter((m): m is string => typeof m === "string") : [];
  const cost: RsiRunCostRecord = { inputTokens, cachedTokens, outputTokens, totalTokens, amountCny, missing };
  const cacheCreationTokens = asNumber(raw.cacheCreationTokens);
  if (cacheCreationTokens !== undefined) cost.cacheCreationTokens = cacheCreationTokens;
  const model = asString(raw.model);
  if (model !== undefined) cost.model = model;
  return cost;
}

/** 分析记录净化:候选/认账都只留 sessionId 合法的行(坏行丢弃,不整条记录失效)。 */
function parseAnalysisRecord(raw: unknown): RsiRunAnalysisRecord | undefined {
  if (!isRecord(raw)) return undefined;
  const windowDays = asNumber(raw.windowDays);
  const rows = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => isRecord(row)) : [];
  const candidates: RsiRunAnalysisRecord["candidates"] = [];
  for (const row of rows(raw.candidates)) {
    const sessionId = asString(row.sessionId);
    if (sessionId === undefined) continue;
    const candidate: RsiRunAnalysisRecord["candidates"][number] = { sessionId };
    const projectId = asString(row.projectId);
    if (projectId !== undefined) candidate.projectId = projectId;
    const lastActiveAt = asNumber(row.lastActiveAt);
    if (lastActiveAt !== undefined) candidate.lastActiveAt = lastActiveAt;
    candidates.push(candidate);
  }
  const analyzed: RsiRunAnalysisRecord["analyzed"] = [];
  for (const row of rows(raw.analyzed)) {
    const sessionId = asString(row.sessionId);
    if (sessionId === undefined) continue;
    const entry: RsiRunAnalysisRecord["analyzed"][number] = { sessionId };
    const projectId = asString(row.projectId);
    if (projectId !== undefined) entry.projectId = projectId;
    analyzed.push(entry);
  }
  if (windowDays === undefined && candidates.length === 0 && analyzed.length === 0) return undefined;
  return { windowDays: windowDays ?? 3, candidates, analyzed };
}

/** 质量记录净化:计数只留非负有限数,score 0~100,issues 只留 code+note(上限 20)。 */
function parseQualityRecord(raw: unknown): RsiRunQuality | undefined {
  if (!isRecord(raw)) return undefined;
  const count = (key: string): number => {
    const v = asNumber(raw[key]);
    return v === undefined || v < 0 ? 0 : Math.floor(v);
  };
  const score = Math.max(0, Math.min(100, count("score")));
  const issues: RsiRunQuality["issues"] = [];
  if (Array.isArray(raw.issues)) {
    for (const row of raw.issues) {
      if (!isRecord(row)) continue;
      const code = asString(row.code);
      const note = asString(row.note);
      if (code === undefined || note === undefined) continue;
      const itemId = asString(row.itemId);
      issues.push({ code, note: truncate(note, 200), ...(itemId === undefined ? {} : { itemId }) });
      if (issues.length >= 20) break;
    }
  }
  return {
    items: count("items"),
    evidenced: count("evidenced"),
    impacted: count("impacted"),
    actionable: count("actionable"),
    shallow: count("shallow"),
    duplicates: count("duplicates"),
    overLimit: raw.overLimit === true,
    score,
    issues,
  };
}

function parseRunRecord(mechanismId: string, raw: unknown): RsiRunRecord | undefined {
  if (!isRecord(raw)) return undefined;
  const runId = asString(raw.runId);
  if (!runId) return undefined;
  const status = raw.status;
  if (status !== "running" && status !== "done" && status !== "failed") return undefined;
  const record: RsiRunRecord = {
    runId,
    mechanismId: asString(raw.mechanismId) ?? mechanismId,
    status,
    startedAt: asNumber(raw.startedAt) ?? 0,
  };
  const taskId = asString(raw.taskId);
  if (taskId !== undefined) record.taskId = taskId;
  const sessionId = asString(raw.sessionId);
  if (sessionId !== undefined) record.sessionId = sessionId;
  const finishedAt = asNumber(raw.finishedAt);
  if (finishedAt !== undefined) record.finishedAt = finishedAt;
  const error = asString(raw.error);
  if (error !== undefined) record.error = error;
  const cost = parseCostRecord(raw.cost);
  if (cost !== undefined) record.cost = cost;
  const analysis = parseAnalysisRecord(raw.analysis);
  if (analysis !== undefined) record.analysis = analysis;
 // RSI-SELF-DRIVE(旧记录无这些字段,读取侧保持 undefined)。
  const cycleId = asString(raw.cycleId);
  if (cycleId !== undefined) record.cycleId = cycleId;
  const retryOf = asString(raw.retryOf);
  if (retryOf !== undefined) record.retryOf = retryOf;
  const retryCount = asNumber(raw.retryCount);
  if (retryCount !== undefined) record.retryCount = retryCount;
  const budgetTokens = asNumber(raw.budgetTokens);
  if (budgetTokens !== undefined) record.budgetTokens = budgetTokens;
  const experimentQuotaFactor = asNumber(raw.experimentQuotaFactor);
  if (experimentQuotaFactor !== undefined) record.experimentQuotaFactor = experimentQuotaFactor;
  if (typeof raw.budgetExceeded === "boolean") record.budgetExceeded = raw.budgetExceeded;
  if (typeof raw.analysisMissing === "boolean") record.analysisMissing = raw.analysisMissing;
  const quality = parseQualityRecord(raw.quality);
  if (quality !== undefined) record.quality = quality;
  return record;
}

async function readRunFile(root: string, mechanismId: string, runId: string): Promise<RsiRunRecord | undefined> {
  const text = await readTextOrEmpty(runFilePath(root, mechanismId, runId));
  if (text.trim() === "") return undefined;
  try {
    return parseRunRecord(mechanismId, JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** 一次运行记录;不存在 / 坏文件 → undefined。 */
export async function getRun(root: string, mechanismId: string, runId: string): Promise<RsiRunRecord | undefined> {
  const base = assertRoot(root);
  const mech = asString(mechanismId);
  if (!mech) throw new TypeError("getRun: mechanismId 必须是非空字符串");
  const id = asString(runId);
  if (!id) throw new TypeError("getRun: runId 必须是非空字符串");
  return readRunFile(base, mech, id);
}

async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".result.json"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** 扫目录列运行记录(坏文件跳过),按 startedAt 升序。 */
export async function listRuns(root: string, mechanismId?: string): Promise<RsiRunRecord[]> {
  const base = assertRoot(root);
  const mech = mechanismId === undefined ? undefined : asString(mechanismId);
  if (mechanismId !== undefined && !mech) throw new TypeError("listRuns: mechanismId 必须是非空字符串");
  const runs: RsiRunRecord[] = [];
  if (mech !== undefined) {
    const dir = runsDir(base, mech);
    for (const name of await listJsonFiles(dir)) {
      const text = await readTextOrEmpty(join(dir, name));
      if (text.trim() === "") continue;
      try {
        const record = parseRunRecord(mech, JSON.parse(text));
        if (record) runs.push(record);
      } catch {
        continue;
      }
    }
  } else {
    let dirs: string[] = [];
    try {
      const entries = await readdir(runsDir(base), { withFileTypes: true });
      dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    } catch {
      dirs = [];
    }
    for (const dir of dirs) {
      for (const name of await listJsonFiles(join(runsDir(base), dir))) {
        const text = await readTextOrEmpty(join(runsDir(base), dir, name));
        if (text.trim() === "") continue;
        try {
          const record = parseRunRecord(dir, JSON.parse(text));
          if (record) runs.push(record);
        } catch {
          continue;
        }
      }
    }
  }
  runs.sort((a, b) => a.startedAt - b.startedAt);
  return runs;
}

// ------------------------------------------------------------------ agent 结果文件

/** 归一化 agent 给的 item id:去掉空白/非法字符,保证 `<runId>:<id>` 全局唯一且可点。 */
function normalizeItemId(raw: string, index: number): string {
  const text = raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return text === "" ? `i${index}` : text;
}

/**
 * 结果文件路径自愈(经验证):agent 偶发把 runId 抄错一位(如 run_mwewx6py → run_mwewxpy),
 * 结果写到相邻文件名,主流程读不到 → 本轮零产出且质量被误判为空(实际 5 条高质量结论)。
 * 口径:期望文件存在 → found;否则在**同机制目录**找 mtime ≥ 开始时刻的 `*.result.json`,
 * 唯一候选才 rename 成期望名(多候选不猜,避免把别人的结果算到本轮)。只挪结果文件,不碰 run 记录。
 */
export async function salvageResultFile(
  root: string,
  mechanismId: string,
  runId: string,
  startedAt: number): Promise<{ found: boolean; movedFrom?: string; error?: string }> {
  const base = assertRoot(root);
  const mech = asString(mechanismId);
  const id = asString(runId);
  if (!mech || !id) return { found: false, error: "INVALID" };
  const expected = resultFilePath(base, mech, id);
  try {
    await stat(expected);
    return { found: true };
  } catch {
 // 继续找相邻候选
  }
  const dir = runsDir(base, mech);
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".result.json") && name !== `${id}.result.json`);
  } catch {
    return { found: false };
  }
  const cutoff = startedAt - 5_000;
  const candidates: { name: string; mtimeMs: number }[] = [];
  for (const name of names) {
    try {
      const info = await stat(join(dir, name));
      if (info.isFile() && info.mtimeMs >= cutoff) candidates.push({ name, mtimeMs: info.mtimeMs });
    } catch {
 // 单个文件 stat 失败不影响其它候选
    }
  }
  if (candidates.length === 0) return { found: false };
  if (candidates.length > 1) return { found: false, error: "AMBIGUOUS" };
  const picked = candidates[0]!;
  try {
    await rename(join(dir, picked.name), expected);
    return { found: true, movedFrom: picked.name };
  } catch {
    return { found: false, error: "MOVE_FAILED" };
  }
}

/**
 * 读一次运行的结果文件(`{items:[…]}`,由 agent 按 brief 写出)。
 * 坏文件 / 缺字段 → [];id 缺省 `i<index>`;全局 id = `<runId>:<normalized>`;
 * title/summary 截断 ≤300 字;status 非法省略;at = 文件 mtime(取不到用 Date.now)。
 */
export async function readRunResults(root: string, mechanismId: string, runId: string): Promise<RsiResultItem[]> {
  const base = assertRoot(root);
  const mech = asString(mechanismId);
  if (!mech) throw new TypeError("readRunResults: mechanismId 必须是非空字符串");
  const id = asString(runId);
  if (!id) throw new TypeError("readRunResults: runId 必须是非空字符串");
  const file = resultFilePath(base, mech, id);
  let at = Date.now();
  try {
    at = (await stat(file)).mtimeMs;
  } catch {
 // 文件不存在 → 交给下面的读空文本处理
  }
  const text = await readTextOrEmpty(file);
  if (text.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const rawItems = isRecord(parsed) && Array.isArray(parsed.items) ? parsed.items : undefined;
  if (!rawItems) return [];
  const items: RsiResultItem[] = [];
  rawItems.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const normalized = normalizeItemId(typeof raw.id === "string" ? raw.id : "", index);
    const item: RsiResultItem = {
      id: `${id}:${normalized}`,
      mechanismId: mech,
      title: truncate(sanitizeRsiText(typeof raw.title === "string" && raw.title.trim() !== "" ? raw.title : normalized)),
      summary: truncate(sanitizeRsiText(typeof raw.summary === "string" ? raw.summary : "")),
      at,
      source: asSource(raw.source) ?? "agent",
      runId: id,
    };
    const detail = asString(raw.detail);
    if (detail !== undefined) item.detail = sanitizeRsiText(detail);
 // 质量四件套字段(旧结果文件没有=undefined;有则同样过注入边界)。
    const evidence = asString(raw.evidence);
    if (evidence !== undefined) item.evidence = truncate(sanitizeRsiText(evidence));
    const impact = asString(raw.impact);
    if (impact !== undefined) item.impact = truncate(sanitizeRsiText(impact));
    const action = asString(raw.action);
    if (action !== undefined) item.action = truncate(sanitizeRsiText(action));
    const status = asStatus(raw.status);
    if (status !== undefined) item.status = status;
    items.push(item);
  });
  return items;
}

// ------------------------------------------------------------------ 合并视图

/**
 * 机制结果 = 基础层(该机制所有 runs 的产物合并) + 覆盖层(results.jsonl)。
 * 覆盖层规则:
 * - update / delete 命中基础 itemId → 直接生效(delete 从基础层摘除);
 * - upsert 的新条目(含人工新增)并入;
 * - 覆盖层里「update 造出的占位」「delete 造出的孤儿墓碑」不并入基础层 —— 否则一次误点 update
 * 就会在结果卡上凭空长出一条空壳条目。
 * 输出:items 按 at 降序、上限 MAX_RESULT_ITEMS;run = 最近一次运行记录;overlayApplied = 真正
 * 生效的覆盖层条目数(命中基础 + 并入新增,不含孤儿墓碑)。
 */
export async function collectMechanismItems(
  root: string,
  mechanismId: string): Promise<{ items: RsiResultItem[]; run?: RsiRunRecord; overlayApplied: number }> {
  const base = assertRoot(root);
  const mech = asString(mechanismId);
  if (!mech) throw new TypeError("collectMechanismItems: mechanismId 必须是非空字符串");
  const runs = await listRuns(base, mech);
  const index = new Map<string, RsiResultItem>();
  for (const run of runs) {
    for (const item of await readRunResults(base, mech, run.runId)) index.set(item.id, item);
  }
  const overlay = replayEvents(await readTextOrEmpty(resultsPath(base)), mech);
  let overlayApplied = 0;
  for (const [itemId, entry] of overlay) {
    const hit = index.has(itemId);
    if (entry.deleted === true) {
      if (hit) {
        index.delete(itemId);
        overlayApplied += 1;
      }
      continue;
    }
    if (hit || entry.synthetic !== true) {
      index.set(itemId, stripInternal(entry));
      overlayApplied += 1;
    }
  }
  const items = [...index.values()].sort((a, b) => b.at - a.at).slice(0, MAX_RESULT_ITEMS);
  const last = runs.length > 0 ? runs[runs.length - 1] : undefined;
  return last === undefined ? { items, overlayApplied } : { items, run: last, overlayApplied };
}
