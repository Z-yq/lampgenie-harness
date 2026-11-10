/**
 * Source Registry:邮件/IM/日历这类「外部事件源」的登记簿与事件流水(纯逻辑零 IO)。
 * 为什么需要它:agent 要消费外部事件源,但「源」有三件事必须先与具体连接实现解耦,才谈得上可测与可持久化:
 *   1) 形状(kind)——字段契约(必填/类型/归属 event 还是 config)、事实、权限策略、
 *      线程与频道寻址方式、健康键,先登记再谈连接;
 *   2) 实例(instance)——某个 kind 的一份具体配置:是否启用、占用了哪些全局声明(claims);
 *   3) 事件流(events)——写面只允许走 createSourceContext().write,统一校验后落 seq 递增的流水;
 *      重启后靠 registry 的 JSON 快照重放,seq 从 nextSeq 续上,不重复不跳号。
 * 怎么做:
 *   - registerKind / registerInstance 全量校验通过才改 registry(「非法输入零变更」是硬约束),
 *     非法输入只返回稳定码、绝不 throw;保留名(core / system / reserved:*)不给外部占用;
 *     未知 kind 的实例仍落库但 enabled:false,方便 report 观测,而不是静默丢弃;
 *   - writeEvent 是唯一写面:实例存在且启用 → event.type 非空 → 必填字段类型校验 →
 *     policy(deny 优先、allow 非空须命中)→ 落 seq(registry.nextSeq 自增);
 *   - replay 按 seq > fromSeq(缺省 0)读回,可按 instanceId 过滤,ok 时码恒为 SOURCE_REPLAYED;
 *   - healthClaim 用扁平 claimId(`health:<key>`)在全局 claims 里占位,
 *     同键被任何实例(含自己)重复声明都判 SOURCE_HEALTH_CLAIM_DUPLICATE;
 *   - sourceScope 是只读视图:频道地址、线程寻址(payload 字段优先,回退 kind.find)、
 *     facts/policy/environment 透传,供连接层查表;
 *   - createSourceContext 把写面收成一个对象,调用方拿不到裸 registry 的写入口。
 * 依赖纪律:本文件零外部依赖(无 import),不读写文件/网络/环境;时间一律由调用方传入
 * (input.at,其次 event.at),缺省 0,绝不读 Date.now,保证同一输入永远同一输出。
 * 所有函数输入非法只返回稳定码、绝不 throw,且不改入参(只把入参复制进 registry)。
 * 禁 enum / namespace / 装饰器。
 */

/** 稳定码(固定顺序,便于自动化按码断言)。 */
export const SOURCE_CODES = [
  "SOURCE_INVALID",
  "SOURCE_RESERVED_NAME",
  "SOURCE_DUPLICATE_KIND",
  "SOURCE_UNKNOWN_KIND",
  "SOURCE_CONFIG_INVALID",
  "SOURCE_CLAIM_CONFLICT",
  "SOURCE_ENABLED",
  "SOURCE_DISABLED",
  "SOURCE_WROTE",
  "SOURCE_REPLAYED",
  "SOURCE_HEALTH_CLAIMED",
  "SOURCE_HEALTH_CLAIM_DUPLICATE",
] as const;

export type SourceCode = (typeof SOURCE_CODES)[number];

/** 字段类型(与 typeof / Array.isArray 一一对应,不做隐式转换)。 */
export type SourceFieldType = "string" | "number" | "boolean" | "object" | "array";

/** 类型枚举的运行时清单(校验用,顺序即报错展示顺序)。 */
const SOURCE_FIELD_TYPES: readonly SourceFieldType[] = ["string", "number", "boolean", "object", "array"];

/** 字段归属:event.payload(缺省)还是实例 config。 */
export interface SourceFieldSpec {
  name: string;
  type: SourceFieldType;
  required?: boolean;
  in?: "event" | "config";
}

/** 一次外部事件:type 必有,payload 承载字段,at 可由来源自带。 */
export interface SourceEvent {
  type: string;
  payload?: Record<string, unknown>;
  at?: number;
}

/** 健康键:ttlMs 由调用方决定过期口径,本模块只做声明去重。 */
export interface SourceHealthSpec {
  key: string;
  ttlMs?: number;
}

export interface SourceKind {
  kind: string;
  identity: string;
  title: string;
  schema: string;
  fields: SourceFieldSpec[];
  facts: Record<string, string | number | boolean>;
  health: SourceHealthSpec;
  scope?: { threadField?: string; channelField?: string };
  channel?: { address: string };
  threadContext?: { field: string };
  find?: (event: SourceEvent) => string | undefined;
  policy?: { allow?: string[]; deny?: string[] };
  environment?: Record<string, string>;
}

export interface SourceInstance {
  id: string;
  kind: string;
  config: Record<string, unknown>;
  enabled: boolean;
  claims: string[];
  health?: { claimed: string[] };
  codes?: SourceCode[];
  reason?: string;
}

export interface SourceEventRecord {
  seq: number;
  instanceId: string;
  kind: string;
  schema: string;
  type: string;
  payload: Record<string, unknown>;
  at: number;
}

export interface SourceRegistry {
  kinds: Record<string, SourceKind>;
  instances: Record<string, SourceInstance>;
  claims: Record<string, string>;
  events: SourceEventRecord[];
  nextSeq: number;
}

/** 保留 kind:核心/系统内部源,以及 reserved: 前缀的命名空间。 */
const RESERVED_KINDS: readonly string[] = ["core", "system"];
const RESERVED_PREFIX = "reserved:";

/** 健康声明的 claimId 前缀(schema 变更时改这里,与 healthClaim 的幂等绑死)。 */
const HEALTH_CLAIM_PREFIX = "health:";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasOwn(target: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function isFieldType(value: unknown): value is SourceFieldType {
  return typeof value === "string" && (SOURCE_FIELD_TYPES as readonly string[]).includes(value);
}

/** 类型匹配:number 只认有限数,object 只认普通对象(数组不算 object)。 */
function typeMatches(value: unknown, type: SourceFieldType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    default:
      return false;
  }
}

/** 只接受全字符串数组;非法返回 undefined(调用方决定是 CONFIG_INVALID 还是忽略)。 */
function copyStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    out.push(item);
  }
  return out;
}

function normalizeFields(value: unknown): SourceFieldSpec[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: SourceFieldSpec[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) return undefined;
    const name = item["name"];
    const type = item["type"];
    if (!isNonEmptyString(name)) return undefined;
    if (!isFieldType(type)) return undefined;
    const requiredRaw = item["required"];
    if (requiredRaw !== undefined && typeof requiredRaw !== "boolean") return undefined;
    const inRaw = item["in"];
    if (inRaw !== undefined && inRaw !== "event" && inRaw !== "config") return undefined;
    // 规范化:required 落成布尔、in 缺省补 "event"(查询方不必再猜)。
    out.push({ name, type, required: requiredRaw === true, in: inRaw === "config" ? "config" : "event" });
  }
  return out;
}

function normalizeFacts(value: unknown): Record<string, string | number | boolean> | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" || typeof item === "boolean") {
      out[key] = item;
      continue;
    }
    if (typeof item === "number" && Number.isFinite(item)) {
      out[key] = item;
      continue;
    }
    return undefined;
  }
  return out;
}

function normalizeHealth(value: unknown): SourceHealthSpec | undefined {
  if (!isPlainObject(value)) return undefined;
  const key = value["key"];
  if (!isNonEmptyString(key)) return undefined;
  const ttlRaw = value["ttlMs"];
  if (ttlRaw !== undefined && !(typeof ttlRaw === "number" && Number.isFinite(ttlRaw) && ttlRaw >= 0)) return undefined;
  return typeof ttlRaw === "number" ? { key, ttlMs: ttlRaw } : { key };
}

function normalizePolicy(value: unknown): SourceKind["policy"] {
  if (!isPlainObject(value)) return undefined;
  const allow = copyStringArray(value["allow"]);
  const deny = copyStringArray(value["deny"]);
  if (allow === undefined && deny === undefined) return undefined;
  const policy: { allow?: string[]; deny?: string[] } = {};
  if (allow !== undefined) policy.allow = allow;
  if (deny !== undefined) policy.deny = deny;
  return policy;
}

function normalizeEnvironment(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeScope(value: unknown): SourceKind["scope"] {
  if (!isPlainObject(value)) return undefined;
  const threadField = value["threadField"];
  const channelField = value["channelField"];
  const scope: { threadField?: string; channelField?: string } = {};
  if (typeof threadField === "string") scope.threadField = threadField;
  if (typeof channelField === "string") scope.channelField = channelField;
  return scope.threadField === undefined && scope.channelField === undefined ? undefined : scope;
}

/** 把任意外部输入规范化成 SourceKind;任一处不合法返回 undefined(调用方回 SOURCE_INVALID)。 */
function normalizeKind(value: unknown): SourceKind | undefined {
  if (!isPlainObject(value)) return undefined;
  const kind = value["kind"];
  const identity = value["identity"];
  const title = value["title"];
  const schema = value["schema"];
  if (!isNonEmptyString(kind) || !isNonEmptyString(identity) || !isNonEmptyString(title) || !isNonEmptyString(schema)) {
    return undefined;
  }
  const fields = normalizeFields(value["fields"]);
  if (!fields) return undefined;
  const facts = normalizeFacts(value["facts"]);
  if (!facts) return undefined;
  const health = normalizeHealth(value["health"]);
  if (!health) return undefined;

  const normalized: SourceKind = { kind, identity, title, schema, fields, facts, health };
  // 可选块:形状不合法的可选块直接略过(必填五件已在上面把住),不让装饰性字段污染主契约。
  const scope = normalizeScope(value["scope"]);
  if (scope) normalized.scope = scope;
  const channel = value["channel"];
  if (isPlainObject(channel) && typeof channel["address"] === "string") normalized.channel = { address: channel["address"] };
  const threadContext = value["threadContext"];
  if (isPlainObject(threadContext) && typeof threadContext["field"] === "string") {
    normalized.threadContext = { field: threadContext["field"] };
  }
  const find = value["find"];
  if (typeof find === "function") normalized.find = find as (event: SourceEvent) => string | undefined;
  const policy = normalizePolicy(value["policy"]);
  if (policy) normalized.policy = policy;
  const environment = normalizeEnvironment(value["environment"]);
  if (environment) normalized.environment = environment;
  return normalized;
}

function isReservedKind(kind: string): boolean {
  return RESERVED_KINDS.includes(kind) || kind.startsWith(RESERVED_PREFIX);
}

/** 空的登记簿:nextSeq 从 1 开始,保证第一条事件 seq=1。 */
export function createRegistry(): SourceRegistry {
  return { kinds: {}, instances: {}, claims: {}, events: [], nextSeq: 1 };
}

/** 登记一个 kind:全量校验 → 保留名 → 重复 → 落库;任一步失败 registry 零变更。 */
export function registerKind(
  registry: SourceRegistry,
  kind: unknown): { ok: boolean; code: SourceCode; codes: SourceCode[]; kind?: SourceKind; reason?: string } {
  if (isPlainObject(kind) && isNonEmptyString(kind["kind"]) && isReservedKind(kind["kind"])) {
    return {
      ok: false,
      code: "SOURCE_RESERVED_NAME",
      codes: ["SOURCE_RESERVED_NAME"],
      reason: `kind 名为保留名: ${kind["kind"]}`,
    };
  }
  const normalized = normalizeKind(kind);
  if (!normalized) {
    return { ok: false, code: "SOURCE_INVALID", codes: ["SOURCE_INVALID"], reason: "kind 形状非法(字段/事实/健康键未通过校验)" };
  }
  if (registry.kinds[normalized.kind]) {
    return {
      ok: false,
      code: "SOURCE_DUPLICATE_KIND",
      codes: ["SOURCE_DUPLICATE_KIND"],
      kind: registry.kinds[normalized.kind],
      reason: `kind 已登记,拒绝覆盖: ${normalized.kind}`,
    };
  }
  registry.kinds[normalized.kind] = normalized;
  return { ok: true, code: "SOURCE_ENABLED", codes: ["SOURCE_ENABLED"], kind: normalized };
}

/** 实例化一个 kind:未知 kind / config 不合契约 / claim 冲突一律落库但 enabled:false。 */
export function registerInstance(
  registry: SourceRegistry,
  input: { id: string; kind: string; config?: Record<string, unknown>; enabled?: boolean },
): { ok: boolean; code: SourceCode; codes: SourceCode[]; instance?: SourceInstance; reason?: string } {
  const raw: unknown = input;
  if (!isPlainObject(raw)) {
    return { ok: false, code: "SOURCE_INVALID", codes: ["SOURCE_INVALID"], reason: "instance 输入必须是普通对象" };
  }
  const id = raw["id"];
  const kindName = raw["kind"];
  if (!isNonEmptyString(id) || !isNonEmptyString(kindName)) {
    return { ok: false, code: "SOURCE_INVALID", codes: ["SOURCE_INVALID"], reason: "instance.id / instance.kind 必须是非空字符串" };
  }
  const configRaw = raw["config"];
  const config: Record<string, unknown> = isPlainObject(configRaw) ? { ...configRaw } : {};
  const wantedEnabled = raw["enabled"] !== false;

  const kind = registry.kinds[kindName];
  if (!kind) {
    const instance: SourceInstance = {
      id,
      kind: kindName,
      config,
      enabled: false,
      claims: [],
      codes: ["SOURCE_UNKNOWN_KIND"],
      reason: `kind 未登记: ${kindName}`,
    };
    registry.instances[id] = instance;
    return { ok: false, code: "SOURCE_UNKNOWN_KIND", codes: ["SOURCE_UNKNOWN_KIND"], instance, reason: instance.reason };
  }

  // 1) config 契约:in==="config" 且 required 的字段必须在 config 中且类型匹配。
  const problems: string[] = [];
  if (configRaw !== undefined && !isPlainObject(configRaw)) problems.push("config 必须是普通对象");
  for (const field of kind.fields) {
    if (field.in !== "config" || field.required !== true) continue;
    if (!hasOwn(config, field.name)) {
      problems.push(`config 缺少必填字段 ${field.name}`);
      continue;
    }
    if (!typeMatches(config[field.name], field.type)) problems.push(`config 字段 ${field.name} 类型应为 ${field.type}`);
  }
  // 2) claims 形状(与 config 同一次校验,避免半合法状态)。
  const claimsRaw = config["claims"];
  let requestedClaims: string[] = [];
  if (claimsRaw !== undefined) {
    const list = copyStringArray(claimsRaw);
    if (list === undefined) problems.push("config.claims 必须是字符串数组");
    else requestedClaims = list;
  }

  if (problems.length > 0) {
    const instance: SourceInstance = {
      id,
      kind: kindName,
      config,
      enabled: false,
      claims: [],
      codes: ["SOURCE_CONFIG_INVALID"],
      reason: problems.join("; "),
    };
    registry.instances[id] = instance;
    return { ok: false, code: "SOURCE_CONFIG_INVALID", codes: ["SOURCE_CONFIG_INVALID"], instance, reason: instance.reason };
  }

  // 3) claim 冲突:全局扁平命名空间,被别的实例占着的 key 一律不许抢。
  const conflicts = requestedClaims.filter((key) => {
    const owner = registry.claims[key];
    return owner !== undefined && owner !== id;
  });
  if (conflicts.length > 0) {
    const instance: SourceInstance = {
      id,
      kind: kindName,
      config,
      enabled: false,
      claims: [],
      codes: ["SOURCE_CLAIM_CONFLICT"],
      reason: `claim 已占用: ${conflicts.join(", ")}`,
    };
    registry.instances[id] = instance;
    return { ok: false, code: "SOURCE_CLAIM_CONFLICT", codes: ["SOURCE_CLAIM_CONFLICT"], instance, reason: instance.reason };
  }

  // 4) 覆盖语义:同 id 重复注册先归还自己此前占的 key(幂等),再按本次意愿重新占。
  for (const [key, owner] of Object.entries(registry.claims)) {
    if (owner === id) delete registry.claims[key];
  }
  const claims = wantedEnabled ? Array.from(new Set(requestedClaims)) : [];
  if (wantedEnabled) {
    for (const key of claims) registry.claims[key] = id;
  }
  const code: SourceCode = wantedEnabled ? "SOURCE_ENABLED" : "SOURCE_DISABLED";
  const instance: SourceInstance = {
    id,
    kind: kindName,
    config,
    enabled: wantedEnabled,
    claims,
    codes: [code],
    reason: wantedEnabled ? undefined : "注册时显式 enabled:false",
  };
  registry.instances[id] = instance;
  return { ok: true, code, codes: [code], instance };
}

/** 唯一写面:实例存在且启用 → 类型校验 → policy → 落 seq 递增流水。at 缺省 0。 */
export function writeEvent(
  registry: SourceRegistry,
  input: { instanceId: string; event: SourceEvent; at?: number },
): { ok: boolean; code: SourceCode; seq?: number; record?: SourceEventRecord; reason?: string } {
  const raw: unknown = input;
  if (!isPlainObject(raw)) {
    return { ok: false, code: "SOURCE_INVALID", reason: "write 输入必须是普通对象" };
  }
  const instanceId = raw["instanceId"];
  if (!isNonEmptyString(instanceId)) {
    return { ok: false, code: "SOURCE_INVALID", reason: "instanceId 必须是非空字符串" };
  }
  const instance = registry.instances[instanceId];
  if (!instance) {
    return { ok: false, code: "SOURCE_INVALID", reason: `实例未注册: ${instanceId}` };
  }
  if (!instance.enabled) {
    return { ok: false, code: "SOURCE_DISABLED", reason: `实例未启用: ${instanceId}` };
  }
  const kind = registry.kinds[instance.kind];
  if (!kind) {
    return { ok: false, code: "SOURCE_INVALID", reason: `实例 ${instanceId} 的 kind 未登记: ${instance.kind}` };
  }

  const eventRaw = raw["event"];
  if (!isPlainObject(eventRaw)) {
    return { ok: false, code: "SOURCE_INVALID", reason: "event 必须是普通对象" };
  }
  const type = eventRaw["type"];
  if (!isNonEmptyString(type)) {
    return { ok: false, code: "SOURCE_INVALID", reason: "event.type 必须是非空字符串" };
  }
  const payloadRaw = eventRaw["payload"];
  if (payloadRaw !== undefined && !isPlainObject(payloadRaw)) {
    return { ok: false, code: "SOURCE_INVALID", reason: "event.payload 必须是普通对象" };
  }
  const payload: Record<string, unknown> = isPlainObject(payloadRaw) ? { ...payloadRaw } : {};

  for (const field of kind.fields) {
    if (field.in === "config" || field.required !== true) continue;
    if (!hasOwn(payload, field.name)) {
      return { ok: false, code: "SOURCE_INVALID", reason: `payload 缺少必填字段 ${field.name}` };
    }
    if (!typeMatches(payload[field.name], field.type)) {
      return { ok: false, code: "SOURCE_INVALID", reason: `payload 字段 ${field.name} 类型应为 ${field.type}` };
    }
  }

  const policy = kind.policy;
  if (policy?.deny && policy.deny.includes(type)) {
    return { ok: false, code: "SOURCE_INVALID", reason: `policy deny 命中事件类型 ${type}` };
  }
  if (policy?.allow && policy.allow.length > 0 && !policy.allow.includes(type)) {
    return { ok: false, code: "SOURCE_INVALID", reason: `policy allow 未包含事件类型 ${type}` };
  }

  const seq = isFiniteNumber(registry.nextSeq) && registry.nextSeq > 0 ? Math.trunc(registry.nextSeq) : 1;
  const atInput = raw["at"];
  const eventAt = eventRaw["at"];
  const at = isFiniteNumber(atInput) ? atInput : isFiniteNumber(eventAt) ? eventAt : 0;
  const record: SourceEventRecord = { seq, instanceId, kind: instance.kind, schema: kind.schema, type, payload, at };
  registry.events.push(record);
  registry.nextSeq = seq + 1;
  return { ok: true, code: "SOURCE_WROTE", seq, record };
}

function cloneRecord(record: SourceEventRecord): SourceEventRecord {
  return { ...record, payload: { ...record.payload } };
}

/** 重放:返回 seq > fromSeq(缺省 0)的事件;可按 instanceId 过滤;ok 时码恒为 SOURCE_REPLAYED。 */
export function replay(
  registry: SourceRegistry,
  input: { instanceId?: string; fromSeq?: number },
): { ok: boolean; code: SourceCode; events: SourceEventRecord[]; reason?: string } {
  const raw: unknown = input;
  const opts: Record<string, unknown> = isPlainObject(raw) ? raw : {};
  const fromSeqRaw = opts["fromSeq"];
  const fromSeq = isFiniteNumber(fromSeqRaw) ? fromSeqRaw : 0;
  const instanceIdRaw = opts["instanceId"];
  let instanceId: string | undefined;
  if (instanceIdRaw !== undefined) {
    if (!isNonEmptyString(instanceIdRaw)) {
      return { ok: false, code: "SOURCE_INVALID", events: [], reason: "instanceId 必须是非空字符串" };
    }
    if (!registry.instances[instanceIdRaw]) {
      return { ok: false, code: "SOURCE_INVALID", events: [], reason: `实例未注册: ${instanceIdRaw}` };
    }
    instanceId = instanceIdRaw;
  }
  const events = registry.events
    .filter((record) => record.seq > fromSeq)
    .filter((record) => instanceId === undefined || record.instanceId === instanceId)
    .map(cloneRecord);
  return { ok: true, code: "SOURCE_REPLAYED", events };
}

/** 健康声明:扁平 claimId(`health:<key>`),同键重复声明(含自己)= DUPLICATE。 */
export function healthClaim(
  registry: SourceRegistry,
  input: { instanceId: string; key: string },
): { ok: boolean; code: SourceCode; claimId?: string; reason?: string } {
  const raw: unknown = input;
  if (!isPlainObject(raw)) {
    return { ok: false, code: "SOURCE_INVALID", reason: "healthClaim 输入必须是普通对象" };
  }
  const instanceId = raw["instanceId"];
  const key = raw["key"];
  if (!isNonEmptyString(instanceId) || !isNonEmptyString(key)) {
    return { ok: false, code: "SOURCE_INVALID", reason: "instanceId / key 必须是非空字符串" };
  }
  const instance = registry.instances[instanceId];
  if (!instance) {
    return { ok: false, code: "SOURCE_INVALID", reason: `实例未注册: ${instanceId}` };
  }
  const claimId = `${HEALTH_CLAIM_PREFIX}${key}`;
  const claimedBefore = instance.health?.claimed;
  const owner = registry.claims[claimId];
  if (owner !== undefined || (Array.isArray(claimedBefore) && claimedBefore.includes(claimId))) {
    const by = owner ?? instanceId;
    return {
      ok: false,
      code: "SOURCE_HEALTH_CLAIM_DUPLICATE",
      claimId,
      reason: by === instanceId ? `健康键重复声明: ${key}` : `健康键已被实例 ${by} 占用: ${key}`,
    };
  }
  registry.claims[claimId] = instanceId;
  const claimed = Array.isArray(claimedBefore) ? [...claimedBefore, claimId] : [claimId];
  registry.instances[instanceId] = { ...instance, health: { claimed } };
  return { ok: true, code: "SOURCE_HEALTH_CLAIMED", claimId };
}

/** 让实例失效:enabled:false + 归还它占的 claim;之后写入一律 SOURCE_DISABLED。 */
export function invalidateInstance(
  registry: SourceRegistry,
  id: string): { ok: boolean; code: SourceCode; instance?: SourceInstance; reason?: string } {
  if (!isNonEmptyString(id)) {
    return { ok: false, code: "SOURCE_INVALID", reason: "id 必须是非空字符串" };
  }
  const instance = registry.instances[id];
  if (!instance) {
    return { ok: false, code: "SOURCE_INVALID", reason: `实例未注册: ${id}` };
  }
  for (const [key, owner] of Object.entries(registry.claims)) {
    if (owner === id) delete registry.claims[key];
  }
  const codes: SourceCode[] = Array.isArray(instance.codes) ? [...instance.codes, "SOURCE_DISABLED"] : ["SOURCE_DISABLED"];
  const next: SourceInstance = { ...instance, enabled: false, codes, reason: `实例已失效: ${id}` };
  registry.instances[id] = next;
  return { ok: true, code: "SOURCE_DISABLED", instance: next };
}

/** 当前启用中的实例(按注册顺序)。 */
export function listEnabled(registry: SourceRegistry): SourceInstance[] {
  return Object.values(registry.instances).filter((instance) => instance.enabled === true);
}

export interface SourceScope {
  has(id: string): boolean;
  enabled(id: string): boolean;
  instance(id: string): SourceInstance | undefined;
  kind(id: string): SourceKind | undefined;
  channel(id: string): string | undefined;
  thread(id: string, event: SourceEvent): string | undefined;
  find(id: string, event: SourceEvent): string | undefined;
  facts(id: string): Record<string, unknown>;
  policy(id: string): SourceKind["policy"];
  environment(id: string): Record<string, string> | undefined;
  instances(): SourceInstance[];
}

/** 只读视图:连接层按实例 id 查频道/线程/facts/policy/environment,拿不到写入口。 */
export function sourceScope(registry: SourceRegistry): SourceScope {
  const kindOf = (id: string): SourceKind | undefined => {
    const instance = registry.instances[id];
    return instance ? registry.kinds[instance.kind] : undefined;
  };
  return {
    has(id: string): boolean {
      return typeof id === "string" && Object.prototype.hasOwnProperty.call(registry.instances, id);
    },
    enabled(id: string): boolean {
      return registry.instances[id]?.enabled === true;
    },
    instance(id: string): SourceInstance | undefined {
      return registry.instances[id];
    },
    kind(id: string): SourceKind | undefined {
      return kindOf(id);
    },
    channel(id: string): string | undefined {
      return kindOf(id)?.channel?.address;
    },
    thread(id: string, event: SourceEvent): string | undefined {
      const kind = kindOf(id);
      if (!kind) return undefined;
      const field = kind.threadContext?.field;
      const payload = isPlainObject(event?.payload) ? event.payload : undefined;
      if (field && payload) {
        const fromPayload = payload[field];
        if (isNonEmptyString(fromPayload)) return fromPayload;
      }
      if (typeof kind.find !== "function") return undefined;
      const found = kind.find(event);
      return isNonEmptyString(found) ? found : undefined;
    },
    find(id: string, event: SourceEvent): string | undefined {
      const kind = kindOf(id);
      return typeof kind?.find === "function" ? kind.find(event) : undefined;
    },
    facts(id: string): Record<string, unknown> {
      const facts = kindOf(id)?.facts;
      return facts ? { ...facts } : {};
    },
    policy(id: string): SourceKind["policy"] {
      const policy = kindOf(id)?.policy;
      return policy ? { ...policy } : undefined;
    },
    environment(id: string): Record<string, string> | undefined {
      const environment = kindOf(id)?.environment;
      return environment ? { ...environment } : undefined;
    },
    instances(): SourceInstance[] {
      return Object.values(registry.instances);
    },
  };
}

export interface SourceContext {
  write(input: { instanceId: string; event: SourceEvent; at?: number }): ReturnType<typeof writeEvent>;
  replay(input: { instanceId?: string; fromSeq?: number }): ReturnType<typeof replay>;
  healthClaim(input: { instanceId: string; key: string }): ReturnType<typeof healthClaim>;
  scope(): SourceScope;
  listEnabled(): SourceInstance[];
}

/** 唯一写面:把 registry 包成上下文,write 内部委托 writeEvent(无第二套写入逻辑)。 */
export function createSourceContext(registry: SourceRegistry): SourceContext {
  return {
    write(input: { instanceId: string; event: SourceEvent; at?: number }): ReturnType<typeof writeEvent> {
      return writeEvent(registry, input);
    },
    replay(input: { instanceId?: string; fromSeq?: number }): ReturnType<typeof replay> {
      return replay(registry, input);
    },
    healthClaim(input: { instanceId: string; key: string }): ReturnType<typeof healthClaim> {
      return healthClaim(registry, input);
    },
    scope(): SourceScope {
      return sourceScope(registry);
    },
    listEnabled(): SourceInstance[] {
      return listEnabled(registry);
    },
  };
}
