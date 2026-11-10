/**
 * 外部事件源登记簿的落盘层(source store):kind / instance / claim / 事件流水的唯一 IO 面。
 *
 * 落盘布局(硬约定):单文件 `<root>/.genie/rsi/sources.json`,内容
 * `{ version, kinds, instances, claims, events, nextSeq }` —— 事件流水与 `nextSeq` 同一个快照持久化,
 * 重启后 replay 水位与 seq 续得上(nextSeq 是流水的续号锚点,不能只活在内存里)。
 *
 * 语义全在 packages/harness-runtime/src/agent/source-registry.ts(纯逻辑零 IO,已全绿);
 * 本文件只负责 IO:读盘 → 调 runtime 纯函数 → 内容确有变化才原子写回(tmp + rename),
 * 失败一律零变更、绝不 throw(热加载:每次调用都重读盘,进程内不缓存 registry)。
 *
 * 依赖纪律:只 import node:fs / node:path + 两跳解析的 runtime 模块;不 import agent loop、
 * 不 import gateway 其它业务模块。全部导出函数同步签名(顶层 await 解析 runtime)。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 字段类型(与 runtime 的 SourceFieldType 一致)。 */
export type SourceFieldType = "string" | "number" | "boolean" | "object" | "array";

/** 字段归属:event.payload(缺省)还是实例 config。 */
export interface SourceFieldSpec {
  name: string;
  type: SourceFieldType;
  required?: boolean;
  in?: "event" | "config";
}

export interface SourceEvent {
  type: string;
  payload?: Record<string, unknown>;
  at?: number;
}

export interface SourceHealthSpec {
  key: string;
  ttlMs?: number;
}

/** kind 的结构化视图(函数型 find 落盘会丢,读完是纯描述对象,属正常)。 */
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
  codes?: string[];
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

/** sources.json 的文件形状(version 供未来迁移用)。 */
export interface SourcesFile {
  version: number;
  kinds: Record<string, SourceKind>;
  instances: Record<string, SourceInstance>;
  claims: Record<string, string>;
  events: SourceEventRecord[];
  nextSeq: number;
}

/** 落盘层的 IO 码(业务码仍来自 runtime 的 SOURCE_*)。 */
const SOURCE_WRITE_FAILED = "SOURCE_WRITE_FAILED";
const SOURCES_VERSION = 1;

type UnknownRecord = Record<string, unknown>;

/** runtime 面(只声明用到的部分;签名以 source-registry.ts 为准)。 */
interface SourceRuntime {
  createRegistry(): SourceRegistry;
  registerKind(
    registry: SourceRegistry,
    kind: unknown,
  ): { ok: boolean; code: string; codes: string[]; kind?: SourceKind; reason?: string };
  registerInstance(
    registry: SourceRegistry,
    input: { id: string; kind: string; config?: Record<string, unknown>; enabled?: boolean },
  ): { ok: boolean; code: string; codes: string[]; instance?: SourceInstance; reason?: string };
  writeEvent(
    registry: SourceRegistry,
    input: { instanceId: string; event: SourceEvent; at?: number },
  ): { ok: boolean; code: string; seq?: number; record?: SourceEventRecord; reason?: string };
  replay(
    registry: SourceRegistry,
    input: { instanceId?: string; fromSeq?: number },
  ): { ok: boolean; code: string; events: SourceEventRecord[]; reason?: string };
  healthClaim(
    registry: SourceRegistry,
    input: { instanceId: string; key: string },
  ): { ok: boolean; code: string; claimId?: string; reason?: string };
  listEnabled(registry: SourceRegistry): SourceInstance[];
}

let sourceRuntime: SourceRuntime | undefined;

/** 两跳解析 source-registry(打包产物无源码时回落 src .ts,与 data-tool-store 同模式)。 */
async function loadSourceRuntime(): Promise<SourceRuntime> {
  if (sourceRuntime) return sourceRuntime;
  const spec = "@lampgenie/runtime/agent/source-registry";
  try {
    sourceRuntime = (await import(spec)) as unknown as SourceRuntime;
  } catch {
    const srcUrl = new URL("../../../packages/harness-runtime/src/agent/source-registry.ts", import.meta.url).href;
    sourceRuntime = (await import(srcUrl)) as unknown as SourceRuntime;
  }
  return sourceRuntime;
}

const rt = await loadSourceRuntime();

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 登记簿文件路径:`<root>/.genie/rsi/sources.json`。 */
export function sourcesPath(root: string): string {
  return join(root, ".genie", "rsi", "sources.json");
}

/** 空态:nextSeq 0 表示「还没写过」,首条事件由 runtime 折成 seq=1。 */
function emptyRegistry(): SourceRegistry {
  return { kinds: {}, instances: {}, claims: {}, events: [], nextSeq: 0 };
}

function readTextOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** 把任意外部形状收敛成合法 registry;认不出就整体当空态(坏文件不阻断读取)。 */
function normalizeRegistry(value: unknown): SourceRegistry | undefined {
  if (!isRecord(value)) return undefined;
  const registry = emptyRegistry();
  if (isRecord(value["kinds"])) registry.kinds = value["kinds"] as Record<string, SourceKind>;
  if (isRecord(value["instances"])) registry.instances = value["instances"] as Record<string, SourceInstance>;
  if (isRecord(value["claims"])) registry.claims = value["claims"] as Record<string, string>;
  if (Array.isArray(value["events"])) registry.events = value["events"] as SourceEventRecord[];
  const nextSeq = value["nextSeq"];
  if (typeof nextSeq === "number" && Number.isFinite(nextSeq) && nextSeq > 0) registry.nextSeq = Math.trunc(nextSeq);
  // instance.claims 缺失会让 runtime 的覆盖语义拿到 undefined,补齐成空数组。
  for (const instance of Object.values(registry.instances)) {
    if (isRecord(instance) && !Array.isArray(instance.claims)) instance.claims = [];
  }
  return registry;
}

/** 读登记簿:文件不存在 / 坏 JSON / 形状不认识 → 空 registry(不抛)。 */
export function loadSources(root: string): SourceRegistry {
  const raw = readTextOrUndefined(sourcesPath(root));
  if (raw === undefined) return emptyRegistry();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return emptyRegistry();
  }
  return normalizeRegistry(parsed) ?? emptyRegistry();
}

/** 原子写:mkdir(recursive) + 临时文件 + rename;失败清理 tmp、返回 ok:false(不 throw)。 */
export function saveSources(root: string, registry: SourceRegistry): { ok: boolean; path: string; error?: string } {
  const path = sourcesPath(root);
  const file: SourcesFile = {
    version: SOURCES_VERSION,
    kinds: registry.kinds ?? {},
    instances: registry.instances ?? {},
    claims: registry.claims ?? {},
    events: Array.isArray(registry.events) ? registry.events : [],
    nextSeq: typeof registry.nextSeq === "number" && Number.isFinite(registry.nextSeq) ? registry.nextSeq : 0,
  };
  const content = `${JSON.stringify(file, null, 2)}\n`;
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
    return { ok: true, path };
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* 清理失败不影响结论 */
    }
    return { ok: false, path, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 内容指纹:只有内容真的变了才写盘(非法输入零变更 → 不碰文件)。 */
function fingerprint(registry: SourceRegistry): string {
  return JSON.stringify({
    kinds: registry.kinds,
    instances: registry.instances,
    claims: registry.claims,
    events: registry.events,
    nextSeq: registry.nextSeq,
  });
}

/** 有变化才落盘;写盘失败折成 SOURCE_WRITE_FAILED(业务码保持原样)。 */
function persist(
  root: string,
  registry: SourceRegistry,
  before: string,
): { ok: boolean; code?: string; path: string; error?: string } {
  const path = sourcesPath(root);
  if (fingerprint(registry) === before) return { ok: true, path };
  const saved = saveSources(root, registry);
  if (!saved.ok) {
    return { ok: false, code: SOURCE_WRITE_FAILED, path, error: saved.error ?? "落盘失败" };
  }
  return { ok: true, path };
}

/** 登记一个 kind:校验失败零变更(连文件都不创建)。 */
export function registerSourceKind(
  root: string,
  kind: unknown,
): { ok: boolean; code: string; codes: string[]; path: string; kind?: SourceKind; reason?: string } {
  const registry = loadSources(root);
  const before = fingerprint(registry);
  const result = rt.registerKind(registry, kind);
  const saved = persist(root, registry, before);
  if (!saved.ok) {
    return { ok: false, code: saved.code ?? SOURCE_WRITE_FAILED, codes: [saved.code ?? SOURCE_WRITE_FAILED], path: saved.path, reason: saved.error };
  }
  return { ok: result.ok, code: result.code, codes: result.codes, path: saved.path, kind: result.kind, reason: result.reason };
}

/** 注册实例:未知 kind / config 非法 / claim 冲突 → ok:false 但实例以 enabled:false 落库(可观测)。 */
export function registerSourceInstance(
  root: string,
  input: { id: string; kind: string; config?: Record<string, unknown>; enabled?: boolean },
): { ok: boolean; code: string; codes: string[]; path: string; instance?: SourceInstance; reason?: string } {
  const registry = loadSources(root);
  const before = fingerprint(registry);
  const result = rt.registerInstance(registry, input);
  const saved = persist(root, registry, before);
  if (!saved.ok) {
    return { ok: false, code: saved.code ?? SOURCE_WRITE_FAILED, codes: [saved.code ?? SOURCE_WRITE_FAILED], path: saved.path, reason: saved.error };
  }
  return {
    ok: result.ok,
    code: result.code,
    codes: result.codes,
    path: saved.path,
    instance: result.instance,
    reason: result.reason,
  };
}

/** 写一条事件(nextSeq 一并落盘,重启后 seq 续号)。 */
export function writeSourceEvent(
  root: string,
  input: { instanceId: string; event: { type: string; payload?: Record<string, unknown>; at?: number }; at?: number },
): { ok: boolean; code: string; seq?: number; record?: SourceEventRecord; path: string; reason?: string } {
  const registry = loadSources(root);
  const before = fingerprint(registry);
  const result = rt.writeEvent(registry, input);
  const saved = persist(root, registry, before);
  if (!saved.ok) {
    return { ok: false, code: saved.code ?? SOURCE_WRITE_FAILED, path: saved.path, reason: saved.error };
  }
  return { ok: result.ok, code: result.code, seq: result.seq, record: result.record, path: saved.path, reason: result.reason };
}

/** 重放(只读,不写盘):seq > fromSeq(缺省 0),可按 instanceId 过滤。 */
export function replaySource(
  root: string,
  input: { instanceId?: string; fromSeq?: number },
): { ok: boolean; code: string; events: SourceEventRecord[]; path: string; reason?: string } {
  const registry = loadSources(root);
  const result = rt.replay(registry, input);
  return { ok: result.ok, code: result.code, events: result.events, path: sourcesPath(root), reason: result.reason };
}

/** 健康认领(全局 claim 占位,成功才写盘)。 */
export function claimSourceHealth(
  root: string,
  input: { instanceId: string; key: string },
): { ok: boolean; code: string; claimId?: string; path: string; reason?: string } {
  const registry = loadSources(root);
  const before = fingerprint(registry);
  const result = rt.healthClaim(registry, input);
  const saved = persist(root, registry, before);
  if (!saved.ok) {
    return { ok: false, code: saved.code ?? SOURCE_WRITE_FAILED, path: saved.path, reason: saved.error };
  }
  return { ok: result.ok, code: result.code, claimId: result.claimId, path: saved.path, reason: result.reason };
}

/** 汇总报表:kind / 启用 / 未启用 / claim / 事件计数 + 稳定文本(便于人工看与断言)。 */
export function reportSources(root: string): {
  ok: boolean;
  kinds: string[];
  enabled: string[];
  disabled: string[];
  claims: string[];
  events: number;
  nextSeq: number;
  text: string;
  path: string;
} {
  const path = sourcesPath(root);
  const registry = loadSources(root);
  const kinds = Object.keys(registry.kinds).sort();
  const enabled = rt.listEnabled(registry).map((instance) => instance.id).sort();
  const enabledSet = new Set(enabled);
  const disabled = Object.keys(registry.instances)
    .filter((id) => !enabledSet.has(id))
    .sort();
  const claims = Object.keys(registry.claims).sort();
  const events = registry.events.length;
  const { nextSeq } = registry;
  const list = (items: string[]): string => (items.length === 0 ? "(无)" : items.join(", "));
  const claimList = claims.map((key) => `${key} -> ${registry.claims[key] ?? ""}`);
  const lines = [
    `path: ${path}`,
    `kinds(${kinds.length}): ${list(kinds)}`,
    `enabled(${enabled.length}): ${list(enabled)}`,
    `disabled(${disabled.length}): ${list(disabled)}`,
    `claims(${claims.length}): ${list(claimList)}`,
    `events: ${events}`,
    `nextSeq: ${nextSeq}`,
  ];
  return { ok: true, kinds, enabled, disabled, claims, events, nextSeq, text: `${lines.join("\n")}\n`, path };
}
