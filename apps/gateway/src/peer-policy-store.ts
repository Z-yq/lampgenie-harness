/**
 * #179 Peer 级访问快照(生产侧):把 peer-policy 的纯判定落到 .genie/rsi 下两个 JSON 文件。
 * 为什么两份文件(而不是一份):
 *   - `peer-policies.json` 是**只读策略**(谁写的?人/配置;读多次、改得少),
 *   - `peer-snapshots.json` 是**运行期快照**(每个 principal 一份 baseline + follow 流),
 *     每次 snapshot/reload/invalidate/applyFollow 都要整份重写。合并成一份会让策略读被快照写牵连。
 * 数据面:
 * - `<root>/.genie/rsi/peer-policies.json`
 *   `{"v":1,"methods":["msg.send"],"policies":[{"kind":"member","condition":"method-in:msg.send"}]}`
 * - `<root>/.genie/rsi/peer-snapshots.json`
 *   `{"v":1,"peers":{"<principalId>":PeerSnapshot}}`
 * 写入纪律:**原子写**(同目录临时文件 + rename)。快照是「上一次允许了什么」的唯一凭据,
 * 半个文件写进去(进程被杀/磁盘满)比重连时没有快照更糟:读侧会把它当坏文件,全部授权消失。
 * 目录 `<root>/.genie/rsi` 首次写入时必须 mkdir recursive(该目录当前不存在)。
 * 读纪律:**坏条目只计数不 throw**(坏 JSON / v 不对 / 策略项非法 / 快照条目畸形),
 * 一条坏不让整份文件失效 —— 与 rsi-injection-store 的坏行口径一致。
 * 依赖纪律:node:fs / node:path + runtime 纯逻辑。runtime 的值走惰性 URL 动态 import
 * (`.ts` 显式后缀:`node --experimental-strip-types` 下静态包名 import 会解析到 dist,
 * 而 CLI 场景没有 development 条件);`import type` 静态引用**只为类型**。
 * 参数错误(TypeError,principal 非空 id + 合法 kind)是唯一允许 throw 的情形;
 * IO 失败一律折叠成稳定码返回,不 throw。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  PeerDecision,
  PeerListEntry,
  PeerListResult,
  PeerPolicySpec,
  PeerSnapshot,
  PeerSnapshotResult,
  PolicySet,
  Principal,
  PrincipalKind,
} from "@lampgenie/runtime/agent/peer-policy";

/**
 * 惰性解析 runtime 的纯逻辑模块(与 rsi-injection-store 同一跑法)。
 */
type PeerModule = {
  resolvePeerPolicies: typeof import("@lampgenie/runtime/agent/peer-policy").resolvePeerPolicies;
  decide: typeof import("@lampgenie/runtime/agent/peer-policy").decide;
  listAllows: typeof import("@lampgenie/runtime/agent/peer-policy").listAllows;
  snapshotFor: typeof import("@lampgenie/runtime/agent/peer-policy").snapshotFor;
  reloadSnapshot: typeof import("@lampgenie/runtime/agent/peer-policy").reloadSnapshot;
  invalidate: typeof import("@lampgenie/runtime/agent/peer-policy").invalidate;
  mergeReconnect: typeof import("@lampgenie/runtime/agent/peer-policy").mergeReconnect;
};

let peerModule: PeerModule | undefined;

async function loadPeer(): Promise<PeerModule> {
  if (peerModule) return peerModule;
  const srcUrl = new URL(
    "../../../packages/harness-runtime/src/agent/peer-policy.ts",
    import.meta.url).href;
  peerModule = (await import(srcUrl)) as PeerModule;
  return peerModule;
}

/** 文件格式版本(两份 JSON 的 `v`;与 runtime 的 PEER_POLICY_VERSION 对齐)。 */
export const PEER_FILE_VERSION = 1;

/** store 层自产的稳定码(判定码沿用 runtime 的 PEER_CODES)。 */
export const PEER_STORE_CODES = ["PEER_STORE_READ_FAILED", "PEER_STORE_WRITE_FAILED"] as const;

export type PeerStoreCode = (typeof PEER_STORE_CODES)[number];

export const PRINCIPAL_KIND_VALUES = ["owner", "member", "viewer", "relay", "group"] as const;

export interface PeerPolicyPaths {
  dir: string;
  policyFile: string;
  snapshotFile: string;
}

export function peerPolicyPaths(root: string): PeerPolicyPaths {
  const dir = join(root, ".genie", "rsi");
  return { dir, policyFile: join(dir, "peer-policies.json"), snapshotFile: join(dir, "peer-snapshots.json") };
}

function assertRoot(root: string): void {
  if (typeof root !== "string" || !root.trim()) throw new TypeError("root 必填(非空字符串)");
}

/** principal 校验:非空 id + 合法 kind;这是唯一允许 throw 的入口校验。 */
function assertPrincipal(principal: unknown): Principal {
  if (typeof principal !== "object" || principal === null) throw new TypeError("principal 必填");
  const id = (principal as { id?: unknown }).id;
  if (typeof id !== "string" || !id.trim()) throw new TypeError("principal.id 必填(非空字符串)");
  const kind = (principal as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !(PRINCIPAL_KIND_VALUES as readonly string[]).includes(kind)) {
    throw new TypeError(`principal.kind 非法:${String(kind)}`);
  }
  return { id: id.trim(), kind: kind as PrincipalKind };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(file: string): { ok: boolean; value?: unknown; missing: boolean } {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { ok: false, missing: true };
  }
  try {
    return { ok: true, value: JSON.parse(text), missing: false };
  } catch {
    return { ok: false, missing: false };
  }
}

export interface PeerPolicyFile {
  file: string;
  policySet: PolicySet;
  /** 坏策略项 / 坏文件计数量(跳过,不 throw)。 */
  corrupt: number;
  /** 文件缺失(不等同于坏文件:缺文件是正常初始状态,不计 corrupt)。 */
  missing: boolean;
}

function emptyPolicySet(): PolicySet {
  return { policies: [], methods: [] };
}

/**
 * 读策略文件。缺文件 / 坏 JSON / v 不对 / 策略项非法 → 跳过并计 corrupt(缺文件不计)。
 * 缺文件返回空 PolicySet:此时除 owner 外一律 DENY_NO_POLICY(见 peer-policy 的 decide)。
 */
export async function readPeerPolicyFile(root: string, fileOverride?: string): Promise<PeerPolicyFile> {
  assertRoot(root);
  const file = typeof fileOverride === "string" && fileOverride.trim()
    ? fileOverride
    : peerPolicyPaths(root).policyFile;
  const peer = await loadPeer();
  const read = readJson(file);
  if (read.missing) return { file, policySet: emptyPolicySet(), corrupt: 0, missing: true };
  if (!read.ok) return { file, policySet: emptyPolicySet(), corrupt: 1, missing: false };
  const raw = read.value;
  if (!isPlainObject(raw)) return { file, policySet: emptyPolicySet(), corrupt: 1, missing: false };
  if (raw.v !== PEER_FILE_VERSION) return { file, policySet: emptyPolicySet(), corrupt: 1, missing: false };

  let corrupt = 0;
  const methods: string[] = [];
  if (Array.isArray(raw.methods)) {
    for (const method of raw.methods) {
      if (typeof method === "string" && method.trim()) methods.push(method.trim());
      else corrupt++;
    }
  } else if (raw.methods !== undefined) {
    corrupt++;
  }

  const specs: PeerPolicySpec[] = [];
  if (Array.isArray(raw.policies)) {
    for (const item of raw.policies) {
      if (!isPlainObject(item) || typeof item.kind !== "string" || !(PRINCIPAL_KIND_VALUES as readonly string[]).includes(item.kind)) {
        corrupt++;
        continue;
      }
      const spec: PeerPolicySpec = { kind: item.kind as PrincipalKind };
      if (typeof item.role === "string") spec.role = item.role;
      if (typeof item.binding === "string") spec.binding = item.binding;
      if (typeof item.condition === "string") spec.condition = item.condition;
      specs.push(spec);
    }
  } else if (raw.policies !== undefined) {
    corrupt++;
  }

  const policies = peer.resolvePeerPolicies(specs);
  return { file, policySet: { policies, methods }, corrupt, missing: false };
}

export interface PeerSnapshotFile {
  file: string;
  peers: Record<string, PeerSnapshot>;
  corrupt: number;
  missing: boolean;
}

function isSnapshot(value: unknown): value is PeerSnapshot {
  if (!isPlainObject(value)) return false;
  if (typeof value.principalId !== "string") return false;
  if (!isPlainObject(value.baseline)) return false;
  for (const verdict of Object.values(value.baseline)) {
    if (typeof verdict !== "boolean") return false;
  }
  if (!Array.isArray(value.follow)) return false;
  for (const follow of value.follow) {
    if (!isPlainObject(follow)) return false;
    if (typeof follow.at !== "string" || typeof follow.method !== "string") return false;
    if (typeof follow.allow !== "boolean") return false;
  }
  return true;
}

/** 读快照文件:坏条目计 corrupt 后跳过;整份坏 → 空 peers(不 throw)。 */
export async function readPeerSnapshots(root: string): Promise<PeerSnapshotFile> {
  assertRoot(root);
  const file = peerPolicyPaths(root).snapshotFile;
  const read = readJson(file);
  if (read.missing) return { file, peers: {}, corrupt: 0, missing: true };
  if (!read.ok) return { file, peers: {}, corrupt: 1, missing: false };
  const raw = read.value;
  if (!isPlainObject(raw) || raw.v !== PEER_FILE_VERSION) return { file, peers: {}, corrupt: 1, missing: false };
  if (!isPlainObject(raw.peers)) return { file, peers: {}, corrupt: 1, missing: false };

  const peers: Record<string, PeerSnapshot> = {};
  let corrupt = 0;
  for (const [key, value] of Object.entries(raw.peers)) {
    if (!isSnapshot(value)) {
      corrupt++;
      continue;
    }
    peers[key] = {
      principalId: value.principalId,
      baseline: { ...value.baseline },
      follow: value.follow.map((f) => ({ at: f.at, method: f.method, allow: f.allow })),
    };
  }
  return { file, peers, corrupt, missing: false };
}

export interface PeerWriteResult {
  ok: boolean;
  file: string;
  code?: PeerStoreCode;
  /** 写入时的风险提示(不改变 ok,例如临时文件清理失败)。 */
  risks?: string[];
}

/**
 * 原子写快照文件:同目录临时文件 + rename。
 * 首次写入需 mkdir recursive(.genie/rsi 当前不存在);任何 IO 失败折叠成 PEER_STORE_WRITE_FAILED。
 */
export async function writePeerSnapshots(
  root: string,
  peers: Record<string, PeerSnapshot>,
): Promise<PeerWriteResult> {
  assertRoot(root);
  const paths = peerPolicyPaths(root);
  const payload = { v: PEER_FILE_VERSION, peers: isPlainObject(peers) ? peers : {} };
  const temp = `${paths.snapshotFile}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    renameSync(temp, paths.snapshotFile);
    return { ok: true, file: paths.snapshotFile };
  } catch {
    const risks: string[] = [];
    try {
      rmSync(temp, { force: true });
    } catch {
      risks.push(`临时文件清理失败:${temp}`);
    }
    return { ok: false, file: paths.snapshotFile, code: "PEER_STORE_WRITE_FAILED", ...(risks.length ? { risks } : {}) };
  }
}

export interface PeerDecideOptions {
  principal: Principal;
  method: string;
  args?: unknown;
  role?: string;
  /** 覆盖策略文件路径(单测/多租户策略)。 */
  policyFile?: string;
}

export interface PeerDecideResult extends PeerDecision {
  file: string;
  corrupt: number;
}

/** 纯判定,不落盘(每次读策略文件,不做缓存:策略改动后立刻生效)。 */
export async function decidePeer(root: string, options: PeerDecideOptions): Promise<PeerDecideResult> {
  assertRoot(root);
  const principal = assertPrincipal(options?.principal);
  const method = typeof options?.method === "string" ? options.method : "";
  const peer = await loadPeer();
  const policy = await readPeerPolicyFile(root, options?.policyFile);
  const decision = peer.decide(policy.policySet, {
    principal,
    method,
    args: options?.args,
    ...(typeof options?.role === "string" ? { role: options.role } : {}),
  });
  return { ...decision, file: policy.file, corrupt: policy.corrupt };
}

export interface PeerListOptions {
  principal: Principal;
  items: readonly unknown[];
  /** item → method 的映射;缺省取 item.method(字符串)。 */
  methodOf?: (item: unknown, index: number) => string;
  args?: unknown;
  role?: string;
  policyFile?: string;
}

export interface PeerListStoreResult extends PeerListResult {
  file: string;
  corrupt: number;
}

function defaultMethodOf(item: unknown): string {
  if (!isPlainObject(item)) return "";
  return typeof item.method === "string" ? item.method : "";
}

/** 批量独立判定(一项失败不影响其它项),不落盘。 */
export async function listPeerAllows(root: string, options: PeerListOptions): Promise<PeerListStoreResult> {
  assertRoot(root);
  const principal = assertPrincipal(options?.principal);
  const items = Array.isArray(options?.items) ? options.items : [];
  const methodOf = typeof options?.methodOf === "function" ? options.methodOf : defaultMethodOf;
  const peer = await loadPeer();
  const policy = await readPeerPolicyFile(root, options?.policyFile);
  const result = peer.listAllows(policy.policySet, {
    principal,
    items,
    methodOf,
    args: options?.args,
    ...(typeof options?.role === "string" ? { role: options.role } : {}),
  });
  return { ...result, file: policy.file, corrupt: policy.corrupt };
}

export interface PeerSnapshotOptions {
  principal: Principal;
  policyFile?: string;
  at?: string;
  role?: string;
}

export interface PeerSnapshotStoreResult extends PeerSnapshotResult {
  /** 快照落盘文件(不是策略文件)。 */
  file: string;
  written: boolean;
  risks?: string[];
}

async function persist(
  root: string,
  snapshot: PeerSnapshot): Promise<{ file: string; written: boolean; risks?: string[] }> {
  const existing = await readPeerSnapshots(root);
  const peers = { ...existing.peers, [snapshot.principalId]: snapshot };
  const written = await writePeerSnapshots(root, peers);
  const risks: string[] = [];
  if (existing.corrupt > 0) risks.push(`坏快照条目 ${existing.corrupt} 条已跳过`);
  if (!written.ok) risks.push(written.code ?? "PEER_STORE_WRITE_FAILED");
  return { file: written.file, written: written.ok, ...(risks.length ? { risks } : {}) };
}

/** 生成快照并落盘(principal 级整份替换,其它 principal 的条目保留)。 */
export async function snapshotPeer(
  root: string,
  options: PeerSnapshotOptions): Promise<PeerSnapshotStoreResult> {
  assertRoot(root);
  const principal = assertPrincipal(options?.principal);
  const peer = await loadPeer();
  const policy = await readPeerPolicyFile(root, options?.policyFile);
  const { snapshot, code } = peer.snapshotFor(policy.policySet, principal, options?.at, options?.role);
  const saved = await persist(root, snapshot);
  return { snapshot, code, ...saved };
}

/** 完全重载:全新 baseline,旧 follow 清空,然后落盘。 */
export async function reloadPeer(root: string, options: PeerSnapshotOptions): Promise<PeerSnapshotStoreResult> {
  assertRoot(root);
  const principal = assertPrincipal(options?.principal);
  const peer = await loadPeer();
  const policy = await readPeerPolicyFile(root, options?.policyFile);
  const { snapshot, code } = peer.reloadSnapshot(policy.policySet, principal, options?.at);
  const saved = await persist(root, snapshot);
  return { snapshot, code, ...saved };
}

/**
 * 策略失效:有既有快照 → 按当前策略重算 principal 级 baseline 并清空 follow;
 * 没有既有快照 → 等价一次 fresh snapshot(首次即失效,结果一致)。
 */
export async function invalidatePeer(
  root: string,
  options: PeerSnapshotOptions): Promise<PeerSnapshotStoreResult> {
  assertRoot(root);
  const principal = assertPrincipal(options?.principal);
  const peer = await loadPeer();
  const policy = await readPeerPolicyFile(root, options?.policyFile);
  const existing = await readPeerSnapshots(root);
  const current = existing.peers[principal.id];
  const result = current
    ? peer.invalidate(current, policy.policySet, options?.at, principal)
    : peer.snapshotFor(policy.policySet, principal, options?.at, options?.role);
  const saved = await persist(root, result.snapshot);
  return { snapshot: result.snapshot, code: result.code, ...saved };
}

/** 重连:保留最后一份快照(follow 原样),不重算;无既有快照时才 fresh。 */
export async function mergeReconnectPeer(
  root: string,
  options: PeerSnapshotOptions): Promise<PeerSnapshotStoreResult> {
  assertRoot(root);
  const principal = assertPrincipal(options?.principal);
  const peer = await loadPeer();
  const policy = await readPeerPolicyFile(root, options?.policyFile);
  const existing = await readPeerSnapshots(root);
  const current = existing.peers[principal.id];
  const result = current
    ? peer.mergeReconnect(current)
    : peer.snapshotFor(policy.policySet, principal, options?.at, options?.role);
  const saved = await persist(root, result.snapshot);
  return { snapshot: result.snapshot, code: result.code, ...saved };
}

export interface PeerPolicyReport {
  policyFile: string;
  snapshotFile: string;
  /** 策略条数(合法项)。 */
  policies: number;
  /** 坏策略项 / 坏文件计数。 */
  corruptPolicies: number;
  /** 策略声明的方法全量条数。 */
  methods: number;
  /** 快照里出现过的 principal 数。 */
  peers: number;
  /** baseline 中明确 true 的授权项总数。 */
  allow: number;
  /** baseline 中明确 false 的授权项总数。 */
  deny: number;
  /**
   * 算不出来的授权项总数:policySet.methods 里存在、但该 principal 的 baseline 里没有的项
   * (POLICY_FAILED 会让授权从快照中消失,这里正是它的投影)。
   */
  fail: number;
  /** 全部 follow 项里最晚的 at;没有 follow 则为 ""。 */
  lastAt: string;
  corruptSnapshots: number;
  risks: string[];
}

/** 只读投影报告(不写回、不重算、坏条目只计数)。 */
export async function reportPeerPolicies(root: string): Promise<PeerPolicyReport> {
  assertRoot(root);
  const policy = await readPeerPolicyFile(root);
  const snapshots = await readPeerSnapshots(root);
  const methods = policy.policySet.methods;

  let allow = 0;
  let deny = 0;
  let fail = 0;
  let lastAt = "";
  for (const snapshot of Object.values(snapshots.peers)) {
    for (const verdict of Object.values(snapshot.baseline)) {
      if (verdict) allow++;
      else deny++;
    }
    for (const method of methods) {
      if (!(method in snapshot.baseline)) fail++;
    }
    for (const follow of snapshot.follow) {
      if (follow.at > lastAt) lastAt = follow.at;
    }
  }

  const risks: string[] = [];
  if (policy.corrupt > 0) risks.push(`坏策略项 ${policy.corrupt} 条已跳过`);
  if (snapshots.corrupt > 0) risks.push(`坏快照条目 ${snapshots.corrupt} 条已跳过`);
  if (policy.missing) risks.push("策略文件缺失(仅 owner 放行)");

  return {
    policyFile: policy.file,
    snapshotFile: snapshots.file,
    policies: policy.policySet.policies.length,
    corruptPolicies: policy.corrupt,
    methods: methods.length,
    peers: Object.keys(snapshots.peers).length,
    allow,
    deny,
    fail,
    lastAt,
    corruptSnapshots: snapshots.corrupt,
    risks,
  };
}

/** 供 CLI 打印 entries(仅类型收敛,避免调用方自己拼字面量)。 */
export function entryMethod(entry: PeerListEntry): string {
  return typeof entry?.method === "string" ? entry.method : "";
}
