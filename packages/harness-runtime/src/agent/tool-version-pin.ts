/**
 * 工具版本钉扎(Tool Version Pin,#207,纯逻辑零 IO)。
 *
 * 为什么需要「钉扎」:自我改进循环(RSI)会持续改写工具,#192 的工具热升级协议解决的是
 * 「新版怎么安全上线」,而本模块解决的是另一个方向的坑——**一次会话跑到一半,工具被换掉了**。
 * 同一批 trace 里前半段用 v1 的入参、后半段用 v2 的 schema,回放时无法判断那次失败是模型错还是
 * 工具语义变了。所以会话开启时把「此刻每个工具的版本」快照成一份不可变清单(open),
 * 会话内所有调用都按这份清单记录版本;升级必须显式确认(confirmed)且留痕(upgrades),
 * 会话关闭(closed)后清单只读——但**历史调用仍要能按当时版本回放**,这是排查的最后一根绳子。
 *
 * 设计取舍:
 * - 钉的是「会话」而不是「进程」:进程级钉扎会让一次升级把在跑的会话全废掉;
 * - 升级不做自动迁移:applyUpgrade 只要求 confirmed,不做 schema 推断——升级后老调用靠
 *   checkCompatibility 报 breaking、靠 argHintsForReplay 给非阻断提示,把判断权留给人;
 * - 历史回放失败必须显式报码(TOOL_PIN_SCHEMA_MISSING),绝不静默返回 current schema,
 *   否则「回放成功」会变成一种假象。
 *
 * 依赖纪律:零 import(不碰 fs/net/path/node:*),不 import agent loop 与 gateway;
 * 时间一律由调用方以数字时间戳传入,非法时记 0(不读时钟,同一输入永远同一输出);
 * 全部函数纯函数:不 throw、不改入参、返回值深拷贝。
 */

/** 钉扎契约 schema 版本:字段语义变化时递增,读取方据此迁移。 */
export const TOOL_PIN_VERSION = 1;

/** 宽松 JSON Schema 视图:只关心顶层 type/properties/required,其余字段原样透传。 */
export type JSONSchemaObject = {
  type?: string;
  properties?: Record<string, any>;
  required?: string[];
  [k: string]: unknown;
};

/** catalog 里的一个工具:latest 是此刻推荐的版本,versions 是可钉的版本白名单,schemas 按版本存在才可回放。 */
export interface ToolCatalogEntry {
  latest: string;
  versions: string[];
  schemas?: Record<string, JSONSchemaObject>;
}

/** 工具目录:工具名 → 条目。 */
export type ToolCatalog = Record<string, ToolCatalogEntry>;

/** 一条升级留痕:by 是触发者标识,confirmed 恒为 true(未确认的升级根本不会落在这里)。 */
export interface SessionToolPinsUpgrade {
  at: number;
  tool: string;
  from: string;
  to: string;
  by: string;
  confirmed: boolean;
}

/** 一次会话的钉扎清单:open 期间可变(经由纯函数返回新对象),closed 后只读但照常可解析。 */
export interface SessionToolPins {
  sessionId: string;
  createdAt: number;
  versions: Record<string, string>;
  status: "open" | "closed";
  upgrades: SessionToolPinsUpgrade[];
}

/** 一条工具调用记录:version 是「调用时刻按钉扎解析出的版本」,回放与血缘都靠它。 */
export interface ToolCallRecord {
  callId: string;
  sessionId: string;
  tool: string;
  version: string;
  args: Record<string, unknown>;
  at: number;
  traceBatchKey?: string;
}

/** 非法输入(空 id、畸形结构、坏参数):唯一入口级失败码。 */
export const TOOL_PIN_INVALID = "TOOL_PIN_INVALID";
/** 会话清单创建成功:至少钉住了一个工具。 */
export const TOOL_PIN_CREATED = "TOOL_PIN_CREATED";
/** 目录里没有该工具(或版本不在白名单、latest 缺失):钉不上,但不算致命。 */
export const TOOL_PIN_UNKNOWN_TOOL = "TOOL_PIN_UNKNOWN_TOOL";
/** 会话已关闭:不再接受新调用与新升级,只接受解析与回放。 */
export const TOOL_PIN_SESSION_LOCKED = "TOOL_PIN_SESSION_LOCKED";
/** 升级缺少显式确认:RSI 不能自己把在跑的会话升级掉。 */
export const TOOL_PIN_CONFIRM_REQUIRED = "TOOL_PIN_CONFIRM_REQUIRED";
/** 升级已生效并留痕。 */
export const TOOL_PIN_UPGRADED = "TOOL_PIN_UPGRADED";
/** 两版 schema 之间存在破坏性变更(属性删除/类型变化/新增必填)。 */
export const TOOL_PIN_INCOMPATIBLE = "TOOL_PIN_INCOMPATIBLE";
/** 命中了 renameMap 声明的改名:属于提示,单独出现时不阻断。 */
export const TOOL_PIN_RENAME_HINT = "TOOL_PIN_RENAME_HINT";
/** 缺少某版本的 schema:历史回放无法进行(必须显式报码,不许回落 current)。 */
export const TOOL_PIN_SCHEMA_MISSING = "TOOL_PIN_SCHEMA_MISSING";
/** 历史回放按记录版本解析到了 schema。 */
export const TOOL_PIN_REPLAY_RESOLVED = "TOOL_PIN_REPLAY_RESOLVED";
/** 调用记录已按钉扎版本落账。 */
export const TOOL_PIN_CALL_RECORDED = "TOOL_PIN_CALL_RECORDED";

/** 码表只读数组(冻结语义):上游可整体遍历/断言,勿写字面量。 */
export const TOOL_PIN_CODES = [
  TOOL_PIN_INVALID,
  TOOL_PIN_CREATED,
  TOOL_PIN_UNKNOWN_TOOL,
  TOOL_PIN_SESSION_LOCKED,
  TOOL_PIN_CONFIRM_REQUIRED,
  TOOL_PIN_UPGRADED,
  TOOL_PIN_INCOMPATIBLE,
  TOOL_PIN_RENAME_HINT,
  TOOL_PIN_SCHEMA_MISSING,
  TOOL_PIN_REPLAY_RESOLVED,
  TOOL_PIN_CALL_RECORDED,
] as const;

/** Record 形态 renameMap 没有 reason 字段,统一用这句中文说明,避免上游读到 undefined。 */
const RECORD_RENAME_REASON = "renameMap(Record 形态)声明改名:旧字段名在新版 schema 中已不存在,改用新字段名";

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFinite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 只拷贝字符串值的版本表(畸形输入里的非字符串项直接丢弃,而不是让它污染下游)。 */
function cloneVersions(versions: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(versions)) return out;
  for (const [name, version] of Object.entries(versions)) {
    if (typeof version === "string") out[name] = version;
  }
  return out;
}

/** 递归深拷贝(只认数组/纯对象/原始值):schema、args 都是 JSON 结构,用它保证入参不被下游改写。 */
function deepCopy<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => deepCopy(item)) as unknown as T;
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = deepCopy(item);
    return out as unknown as T;
  }
  return value;
}

function cloneUpgrades(upgrades: unknown): SessionToolPinsUpgrade[] {
  if (!Array.isArray(upgrades)) return [];
  const out: SessionToolPinsUpgrade[] = [];
  for (const item of upgrades) {
    if (!isRecord(item)) continue;
    out.push({
      at: toFinite(item["at"], 0),
      tool: typeof item["tool"] === "string" ? item["tool"] : "",
      from: typeof item["from"] === "string" ? item["from"] : "",
      to: typeof item["to"] === "string" ? item["to"] : "",
      by: typeof item["by"] === "string" ? item["by"] : "",
      confirmed: item["confirmed"] === true,
    });
  }
  return out;
}

/** 深拷贝一份 pins(畸形输入退化成空清单而不是 throw):所有「返回副本」的分支共用。 */
function clonePins(pins: unknown): SessionToolPins {
  const source = isRecord(pins) ? pins : {};
  const status = source["status"] === "closed" ? "closed" : "open";
  return {
    sessionId: typeof source["sessionId"] === "string" ? source["sessionId"] : "",
    createdAt: toFinite(source["createdAt"], 0),
    versions: cloneVersions(source["versions"]),
    status,
    upgrades: cloneUpgrades(source["upgrades"]),
  };
}

/** pins 的版本表里该工具是否被钉住(非空字符串才算)。 */
function pinnedVersion(pins: unknown, tool: string): string | undefined {
  const source = isRecord(pins) ? pins : {};
  const versions = source["versions"];
  if (!isRecord(versions)) return undefined;
  const version = versions[tool];
  return nonEmpty(version) ? version : undefined;
}

/** resolveVersion 的结果外壳:未命中时 version 缺省,调用方按 codes 判定。 */
export interface ResolveVersionResult {
  version?: string;
  codes: string[];
}

/**
 * 按钉扎清单解析某工具此刻应使用的版本。
 * closed 会话照常解析——关会话只禁止「新调用/新升级」,不禁回放与读取。
 */
export function resolveVersion(pins: unknown, tool: unknown): ResolveVersionResult {
  if (!isRecord(pins) || !isRecord(pins["versions"])) return { codes: [TOOL_PIN_INVALID] };
  if (!nonEmpty(tool)) return { codes: [TOOL_PIN_INVALID] };
  const version = pinnedVersion(pins, tool);
  if (version === undefined) return { codes: [TOOL_PIN_UNKNOWN_TOOL] };
  return { version, codes: [] };
}

export interface CreateSessionPinsInput {
  sessionId: string;
  catalog: ToolCatalog;
  overrides?: Record<string, string>;
  at?: number;
}

export interface CreateSessionPinsResult {
  pins: SessionToolPins;
  codes: string[];
}

/**
 * 开启会话:把 catalog 里每个工具按 `overrides[name] ?? latest` 快照一份。
 * overrides 给了目录里没有的工具、或给的版本不在 versions 白名单里,都不钉该工具并报 UNKNOWN_TOOL
 * ——宁可少钉一个,也不要钉一个不存在的版本让回放整段失真。
 */
export function createSessionPins(input: unknown): CreateSessionPinsResult {
  const source = isRecord(input) ? input : {};
  const sessionId = source["sessionId"];
  const at = toFinite(source["at"], 0);
  const empty: SessionToolPins = { sessionId: nonEmpty(sessionId) ? sessionId : "", createdAt: at, versions: {}, status: "open", upgrades: [] };
  const catalog = source["catalog"];
  if (!nonEmpty(sessionId) || !isRecord(catalog)) return { pins: empty, codes: [TOOL_PIN_INVALID] };

  const overrides = isRecord(source["overrides"]) ? (source["overrides"] as Record<string, unknown>) : {};
  const versions: Record<string, string> = {};
  const codes: string[] = [];

  for (const [name, entry] of Object.entries(catalog)) {
    if (!isRecord(entry)) {
      codes.push(TOOL_PIN_UNKNOWN_TOOL);
      continue;
    }
    const latest = entry["latest"];
    if (!nonEmpty(latest)) {
      codes.push(TOOL_PIN_UNKNOWN_TOOL);
      continue;
    }
    const override = overrides[name];
    if (override !== undefined && !nonEmpty(override)) {
      codes.push(TOOL_PIN_UNKNOWN_TOOL);
      continue;
    }
    const target = nonEmpty(override) ? override : latest;
    const allowed = entry["versions"];
    if (Array.isArray(allowed) && allowed.length > 0 && !allowed.some((v) => v === target)) {
      codes.push(TOOL_PIN_UNKNOWN_TOOL);
      continue;
    }
    versions[name] = target;
  }

  // override 指向目录外的工具:单独报一次,避免「以为钉了其实没钉」。
  for (const name of Object.keys(overrides)) {
    if (!Object.prototype.hasOwnProperty.call(catalog, name)) codes.push(TOOL_PIN_UNKNOWN_TOOL);
  }

  if (Object.keys(versions).length > 0) codes.unshift(TOOL_PIN_CREATED);
  return { pins: { ...empty, versions }, codes };
}

export interface RecordCallInput {
  callId: string;
  tool: string;
  args?: Record<string, unknown>;
  at?: number;
  traceBatchKey?: string;
}

export interface RecordCallResult {
  call?: ToolCallRecord;
  codes: string[];
}

/**
 * 记一次调用:版本号不是调用方给的,而是按钉扎现算的——这正是钉扎的意义,模型无从绕过。
 * closed 会话直接拒绝(TOOL_PIN_SESSION_LOCKED),不开新账。
 */
export function recordCall(pins: unknown, input: unknown): RecordCallResult {
  const call = isRecord(input) ? input : {};
  if (!nonEmpty(call["callId"]) || !nonEmpty(call["tool"])) return { codes: [TOOL_PIN_INVALID] };
  if (!isRecord(pins)) return { codes: [TOOL_PIN_INVALID] };
  if (pins["status"] !== "open") return { codes: [TOOL_PIN_SESSION_LOCKED] };

  const resolved = resolveVersion(pins, call["tool"]);
  if (resolved.version === undefined) {
    return { codes: resolved.codes.length > 0 ? resolved.codes : [TOOL_PIN_UNKNOWN_TOOL] };
  }

  const rawArgs = call["args"];
  if (rawArgs !== undefined && !isRecord(rawArgs)) return { codes: [TOOL_PIN_INVALID] };

  const record: ToolCallRecord = {
    callId: call["callId"],
    sessionId: typeof pins["sessionId"] === "string" ? pins["sessionId"] : "",
    tool: call["tool"],
    version: resolved.version,
    args: rawArgs === undefined ? {} : deepCopy(rawArgs as Record<string, unknown>),
    at: toFinite(call["at"], 0),
  };
  if (nonEmpty(call["traceBatchKey"])) record.traceBatchKey = call["traceBatchKey"];
  return { call: record, codes: [TOOL_PIN_CALL_RECORDED] };
}

export interface ApplyUpgradeInput {
  tool: string;
  to: string;
  by: string;
  at?: number;
  confirmed?: boolean;
}

export interface ApplyUpgradeResult {
  pins: SessionToolPins;
  codes: string[];
}

/**
 * 会话内升级:必须 confirmed === true 且留痕,否则原样返回副本 + 拒绝码。
 * 不做任何自动迁移——升级后能否兼容由 checkCompatibility / argHintsForReplay 说话。
 */
export function applyUpgrade(pins: unknown, input: unknown): ApplyUpgradeResult {
  const copy = clonePins(pins);
  const upgrade = isRecord(input) ? input : {};

  if (copy.status !== "open") return { pins: copy, codes: [TOOL_PIN_SESSION_LOCKED] };
  if (upgrade["confirmed"] !== true) return { pins: copy, codes: [TOOL_PIN_CONFIRM_REQUIRED] };

  const tool = upgrade["tool"];
  if (!nonEmpty(tool)) return { pins: copy, codes: [TOOL_PIN_INVALID] };
  const from = copy.versions[tool];
  if (!nonEmpty(from)) return { pins: copy, codes: [TOOL_PIN_UNKNOWN_TOOL] };

  const to = upgrade["to"];
  const by = upgrade["by"];
  if (!nonEmpty(to) || !nonEmpty(by) || to === from) return { pins: copy, codes: [TOOL_PIN_INVALID] };

  copy.versions[tool] = to;
  copy.upgrades.push({ at: toFinite(upgrade["at"], 0), tool, from, to, by, confirmed: true });
  return { pins: copy, codes: [TOOL_PIN_UPGRADED] };
}

/** 破坏性变更条目:path 是属性名(只比较顶层 properties/required)。 */
export interface BreakingChange {
  kind: "property-removed" | "type-changed" | "required-added";
  path: string;
  from?: string;
  to?: string;
}

/** 改名提示:renameMap 声明且判据成立时给出。 */
export interface RenameHint {
  from: string;
  to: string;
  reason?: string;
}

/** renameMap 的两种写法:数组(可带 reason)与 Record(from→to)。 */
export type RenameMapInput = Array<{ from: string; to: string; reason?: string }> | Record<string, string>;

export interface CheckCompatibilityInput {
  recordedVersion: string;
  currentVersion: string;
  oldSchema?: JSONSchemaObject;
  newSchema?: JSONSchemaObject;
  renameMap?: RenameMapInput;
}

export interface CheckCompatibilityResult {
  compatible: boolean;
  codes: string[];
  renameHints: RenameHint[];
  breakingChanges: BreakingChange[];
}

function schemaProperties(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) return {};
  const props = schema["properties"];
  return isRecord(props) ? props : {};
}

function schemaRequired(schema: unknown): string[] {
  if (!isRecord(schema)) return [];
  const required = schema["required"];
  if (!Array.isArray(required)) return [];
  return required.filter((item): item is string => typeof item === "string");
}

function typeOfProperty(prop: unknown): string | undefined {
  if (!isRecord(prop)) return undefined;
  const type = prop["type"];
  return typeof type === "string" ? type : undefined;
}

function normalizeRenameMap(renameMap: unknown): RenameHint[] {
  const out: RenameHint[] = [];
  if (Array.isArray(renameMap)) {
    for (const item of renameMap) {
      if (!isRecord(item)) continue;
      const from = item["from"];
      const to = item["to"];
      if (!nonEmpty(from) || !nonEmpty(to)) continue;
      const reason = nonEmpty(item["reason"]) ? item["reason"] : undefined;
      out.push(reason === undefined ? { from, to } : { from, to, reason });
    }
    return out;
  }
  if (isRecord(renameMap)) {
    for (const [from, to] of Object.entries(renameMap)) {
      if (!nonEmpty(from) || !nonEmpty(to)) continue;
      out.push({ from, to, reason: RECORD_RENAME_REASON });
    }
  }
  return out;
}

/**
 * 判断记录版本与当前版本是否兼容(只看顶层 properties/required)。
 * 三类破坏性变更都要报:删属性会让老参数被静默丢弃,改 type 会让老参数被判错,
 * 新增必填会让老调用直接失败。renameMap 命中只算提示(可单独出现),与 breaking 并存时两条码都给。
 */
export function checkCompatibility(input: unknown): CheckCompatibilityResult {
  const source = isRecord(input) ? input : {};
  const oldSchema = source["oldSchema"];
  const newSchema = source["newSchema"];
  if (!isRecord(oldSchema) || !isRecord(newSchema)) {
    return { compatible: false, codes: [TOOL_PIN_SCHEMA_MISSING], renameHints: [], breakingChanges: [] };
  }

  const recordedVersion = source["recordedVersion"];
  const currentVersion = source["currentVersion"];
  const sameVersion = nonEmpty(recordedVersion) && nonEmpty(currentVersion) && recordedVersion === currentVersion;

  const oldProps = schemaProperties(oldSchema);
  const newProps = schemaProperties(newSchema);
  const breakingChanges: BreakingChange[] = [];

  if (!sameVersion) {
    for (const [path, oldProp] of Object.entries(oldProps)) {
      if (!Object.prototype.hasOwnProperty.call(newProps, path)) {
        const from = typeOfProperty(oldProp);
        breakingChanges.push(from === undefined ? { kind: "property-removed", path } : { kind: "property-removed", path, from });
        continue;
      }
      const from = typeOfProperty(oldProp);
      const to = typeOfProperty(newProps[path]);
      if (from !== undefined && to !== undefined && from !== to) {
        breakingChanges.push({ kind: "type-changed", path, from, to });
      }
    }

    const oldRequired = new Set(schemaRequired(oldSchema));
    for (const path of schemaRequired(newSchema)) {
      const bothSides = Object.prototype.hasOwnProperty.call(oldProps, path) && Object.prototype.hasOwnProperty.call(newProps, path);
      if (!oldRequired.has(path) && bothSides) breakingChanges.push({ kind: "required-added", path });
    }
  }

  const renameHints: RenameHint[] = [];
  for (const candidate of normalizeRenameMap(source["renameMap"])) {
    const hasOld = Object.prototype.hasOwnProperty.call(oldProps, candidate.from);
    const oldGone = !Object.prototype.hasOwnProperty.call(newProps, candidate.from);
    const newThere = Object.prototype.hasOwnProperty.call(newProps, candidate.to);
    if (hasOld && oldGone && newThere) renameHints.push(deepCopy(candidate));
  }

  if (breakingChanges.length > 0) {
    const codes = [TOOL_PIN_INCOMPATIBLE];
    if (renameHints.length > 0) codes.push(TOOL_PIN_RENAME_HINT);
    return { compatible: false, codes, renameHints, breakingChanges };
  }
  if (renameHints.length > 0) return { compatible: true, codes: [TOOL_PIN_RENAME_HINT], renameHints, breakingChanges };
  return { compatible: true, codes: [], renameHints, breakingChanges };
}

export interface ReplayCallResult {
  schema?: JSONSchemaObject;
  codes: string[];
}

/**
 * 历史回放:按「记录时刻的版本」取 schema,取不到就显式报 SCHEMA_MISSING。
 * 绝不回落到 latest——回放用错 schema 会把「工具变了」误判成「模型错了」。
 */
export function replayCall(call: unknown, catalog: unknown): ReplayCallResult {
  if (!isRecord(call) || !nonEmpty(call["tool"]) || !nonEmpty(call["version"])) return { codes: [TOOL_PIN_INVALID] };
  if (!isRecord(catalog) || !Object.prototype.hasOwnProperty.call(catalog, call["tool"])) {
    return { codes: [TOOL_PIN_UNKNOWN_TOOL] };
  }
  const entry = catalog[call["tool"]];
  if (!isRecord(entry)) return { codes: [TOOL_PIN_UNKNOWN_TOOL] };
  const schemas = entry["schemas"];
  if (!isRecord(schemas) || !Object.prototype.hasOwnProperty.call(schemas, call["version"])) {
    return { codes: [TOOL_PIN_SCHEMA_MISSING] };
  }
  const schema = schemas[call["version"]];
  if (!isRecord(schema)) return { codes: [TOOL_PIN_SCHEMA_MISSING] };
  return { schema: deepCopy(schema as JSONSchemaObject), codes: [TOOL_PIN_REPLAY_RESOLVED] };
}

/** 回放提示:非阻断,只告诉人「这次回放和现在的能力面差在哪」。 */
export interface ReplayArgHint {
  kind: "version-newer" | "required-added" | "property-removed";
  path?: string;
  note: string;
}

export interface ArgHintsResult {
  hints: ReplayArgHint[];
}

/**
 * 回放时的参数提示(非阻断):记录版本与 latest 相同时无话可说;schema 缺失也不猜。
 * 有差异时先给一条 version-newer 说明版本已经前移,再列出新增必填与被删属性(可能改名)。
 */
export function argHintsForReplay(call: unknown, catalog: unknown): ArgHintsResult {
  if (!isRecord(call) || !nonEmpty(call["tool"]) || !nonEmpty(call["version"])) return { hints: [] };
  if (!isRecord(catalog) || !Object.prototype.hasOwnProperty.call(catalog, call["tool"])) return { hints: [] };
  const entry = catalog[call["tool"]];
  if (!isRecord(entry)) return { hints: [] };
  const latest = entry["latest"];
  if (!nonEmpty(latest)) return { hints: [] };
  const version = call["version"];
  if (version === latest) return { hints: [] };

  const schemas = entry["schemas"];
  if (!isRecord(schemas)) return { hints: [] };
  const oldSchema = schemas[version];
  const newSchema = schemas[latest];
  if (!isRecord(oldSchema) || !isRecord(newSchema)) return { hints: [] };

  const hints: ReplayArgHint[] = [
    { kind: "version-newer", path: call["tool"], note: `记录版本 ${version} 已非当前 latest ${latest},回放结果按旧版语义理解` },
  ];

  const oldProps = schemaProperties(oldSchema);
  const newProps = schemaProperties(newSchema);
  const oldRequired = new Set(schemaRequired(oldSchema));
  for (const path of schemaRequired(newSchema)) {
    if (!oldRequired.has(path)) {
      hints.push({ kind: "required-added", path, note: `新版 ${latest} 已将 ${path} 标为必填,旧调用可能缺该参数` });
    }
  }
  for (const path of Object.keys(oldProps)) {
    if (!Object.prototype.hasOwnProperty.call(newProps, path)) {
      hints.push({ kind: "property-removed", path, note: `旧版字段 ${path} 在新版中已不存在,可能改名,检查 rename 提示` });
    }
  }
  return { hints };
}

export interface PinEnvelope {
  toolVersions: Record<string, string>;
  generation: number;
}

/**
 * 投影成信封上的一小段:调用链路上只带「版本表 + 契约代数」,不带会话状态与升级史,
 * 免得把内部账本塞进每条 trace。generation 固定 TOOL_PIN_VERSION,读取方据此判断能否解析。
 */
export function pinForEnvelope(pins: unknown): PinEnvelope {
  return { toolVersions: cloneVersions(isRecord(pins) ? pins["versions"] : undefined), generation: TOOL_PIN_VERSION };
}
