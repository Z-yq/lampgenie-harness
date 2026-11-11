/**
 * 子代理嵌套深度 + 工具面收敛(纯逻辑、零 IO、不 throw、确定性)。
 * 为什么深度不能信参数(模块的核心前提):如果 spawn_subagent 的深度取自调用方自报
 * (`requestedDepth` / 「我是第几层」),那么任何一个被提示词污染、或刻意规避派发纪律的子代理,
 * 只要把自报深度写成 0 就能无限往下嵌套——既绕开父代理的审批链,也让「深度上限」变成装饰。
 * 唯一可信的事实是  registry 里已经落盘的父子链(agentId → parentId):链由系统在派发时写入,
 * 子代理改不了历史记录。所以本模块只沿链推导深度,`requestedDepth` 仅用于日志对照(标注不采信)。
 * 工具面同理:子代理的 deny 不是「角色自己说了算」,而是父 deny ∪ profile deny ∪ 系统默认 deny
 * (主 agent 独占工具)+ primary-only 工具 的并集收敛——只收紧、不放宽。
 */

/** 深度判定码(不引入 enum;常量表即全量取值)。 */
export const DEPTH_CODES = ["OK", "DEPTH_EXCEEDED", "INVALID", "CYCLE"] as const;
export type DepthCode = (typeof DEPTH_CODES)[number];

/** 根主 agent 深度 0;子代理 1 / 孙 2 / 曾孙 3;再往下(>3)一律拒绝。 */
export const MAX_SUBAGENT_DEPTH = 3;

/** 链上最多走 100 个节点;超过视为 registry 脏数据(INVALID),防止坏记录拖死主流程。 */
const MAX_CHAIN_NODES = 100;

/** 系统级子代理默认 deny:todowrite / task 是主 agent 独占面,子代理调用会绕过派发纪律与白板规划。 */
export const DEFAULT_SUBAGENT_DENY: readonly string[] = Object.freeze(["todowrite", "task"]);

/**
 * 主 agent 独占工具清单(primary-only):子代理调用一律 deny。
 * 现状:仓内尚无集中的 primary-only 清单(派发类工具在子代理工具池结构上就不给),
 * 故显式空数组;将来清单时只改这一处,convergeDeny 会自动纳入。
 */
export const PRIMARY_ONLY_TOOLS: readonly string[] = Object.freeze([]);

/** 参与深度推导的最小记录形状(SubagentRecord 的子集,避免反向依赖 registry)。 */
export interface DepthRecord {
  agentId: string;
  parentId?: string;
}

export interface DepthChain {
  ok: boolean;
 /** 到根的父链跳数(根/未知节点=0)。 */
  depth: number;
  code: DepthCode;
 /** 从被查节点向上的链(叶→根);未知节点只有自身。 */
  chain: string[];
}

export interface SpawnDepthInput {
 /** registry 记录快照(本次 spawn 的新记录必须尚未在里面)。 */
  records?: readonly DepthRecord[];
 /** 派发者的 agentId(通常是当前 task.id)。 */
  parentId?: string;
 /** 调用方自报深度:只写进 reason 做对照,绝不参与判定。 */
  requestedDepth?: number;
 /** 覆盖上限(缺省 MAX_SUBAGENT_DEPTH;仅供测试/未来分级)。 */
  maxDepth?: number;
}

export interface SpawnDepthVerdict {
  ok: boolean;
 /** 本次 spawn 后子代理的深度(= 父深度 + 1)。 */
  depth: number;
  code: DepthCode;
  reason: string;
}

export interface ConvergeDenyInput {
 /** 父会话有效规则里的 deny 工具名集。 */
  parentDeny?: readonly string[];
 /** 子角色 profile 自带的 deny 工具名集(profile 无独立 deny 字段时传空)。 */
  childDeny?: readonly string[];
 /** primary-only 工具清单(子代理调用一律 deny)。 */
  primaryOnly?: readonly string[];
 /** 调用者本人是否 primary(主 agent)。true 时 primary-only 不再进 deny(主 agent 本就该有)。 */
  isPrimaryOnly?: boolean;
 /** 调用者类别:subagent(缺省)/ primary;primary 等价 isPrimaryOnly=true。 */
  kind?: string;
}

export interface ConvergeDenyResult {
 /** 确定性排序去重后的最终 deny。 */
  deny: string[];
 /** 每个来源各自的贡献(同样排序去重),便于审计「这条 deny 是谁加的」。 */
  sources: { parent: string[]; child: string[]; default: string[]; primary: string[] };
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") continue;
    const t = x.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** 确定性排序:ASCII 序(不依赖 locale,跨机器可复现)。 */
function sortedUnique(list: readonly string[]): string[] {
  return [...new Set(strList(list))].sort();
}

/** records → agentId → parentId 索引(重复 agentId 取首条,保证确定性)。 */
function indexRecords(records: readonly DepthRecord[] | undefined): Map<string, string | undefined> {
  const index = new Map<string, string | undefined>();
  if (!Array.isArray(records)) return index;
  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    const id = typeof r.agentId === "string" ? r.agentId.trim() : "";
    if (!id || index.has(id)) continue;
    const parent = typeof r.parentId === "string" && r.parentId.trim() ? r.parentId.trim() : undefined;
    index.set(id, parent);
  }
  return index;
}

/**
 * 沿 parentId 链推导 agentId 的深度(根=0)。
 * - 记录缺席 → 视为根(深度 0):顶层 task.id 本就不在 registry 里;
 * - 父记录缺席(指向未知 id)→ 停在该处,深度按已走过的跳数;
 * - 成环 → CYCLE(不 throw,不死循环);
 * - 链超过 MAX_CHAIN_NODES → INVALID(脏数据)。
 * 入参不被修改;同一输入必得同一结果。
 */
export function depthOfRecords(records: readonly DepthRecord[] | undefined, agentId: string): DepthChain {
  const id = typeof agentId === "string" ? agentId.trim() : "";
  if (!id) return { ok: false, depth: 0, code: "INVALID", chain: [] };
  const index = indexRecords(records);
  const chain: string[] = [id];
  const visited = new Set<string>([id]);
  let cur = id;
  let depth = 0;
  for (;;) {
    const parent = index.get(cur);
 // 记录缺席或链到头:当前节点即根。
    if (parent === undefined) return { ok: true, depth, code: "OK", chain };
    if (visited.has(parent)) {
      chain.push(parent);
      return { ok: false, depth, code: "CYCLE", chain };
    }
    depth += 1;
    if (depth > MAX_CHAIN_NODES) return { ok: false, depth, code: "INVALID", chain };
    visited.add(parent);
    chain.push(parent);
    cur = parent;
  }
}

/** 链的可读渲染(根→叶),错误文本里给用户看。 */
function chainText(chain: readonly string[]): string {
  return [...chain].reverse().join(" → ");
}

/**
 * spawn 前深度裁决:只用链推导。depth+1 > MAX_SUBAGENT_DEPTH → DEPTH_EXCEEDED;
 * 父链成环/脏数据 → CYCLE/INVALID(同样拒绝,失败方向必须是「不派发」)。
 * requestedDepth 不参与判定,只用来在 reason 里点明「自报值不予采信」。
 */
export function spawnDepthVerdict(input: SpawnDepthInput): SpawnDepthVerdict {
  const parentId = typeof input?.parentId === "string" ? input.parentId.trim() : "";
  const requested = typeof input?.requestedDepth === "number" && Number.isFinite(input.requestedDepth) ? input.requestedDepth : undefined;
  if (!parentId) {
    return { ok: false, depth: 0, code: "INVALID", reason: "parentId 为空:无法从父子链推导深度,拒绝派发" };
  }
  const parent = depthOfRecords(input.records, parentId);
  const parentText = parent.chain.length ? chainText(parent.chain) : parentId;
  if (parent.code === "CYCLE") {
    return { ok: false, depth: 0, code: "CYCLE", reason: `父子链成环(${parentText}):registry 记录异常,拒绝派发` };
  }
  if (parent.code === "INVALID") {
    return { ok: false, depth: 0, code: "INVALID", reason: `父子链超长/非法(已走 ${parent.depth} 层,上限 ${MAX_CHAIN_NODES}):拒绝派发` };
  }
  const max = typeof input.maxDepth === "number" && Number.isFinite(input.maxDepth) ? input.maxDepth : MAX_SUBAGENT_DEPTH;
  const depth = parent.depth + 1;
  const distrust = requested !== undefined && requested !== parent.depth
    ? `(调用方自报 depth=${requested} 不予采信,按链推导父深度 ${parent.depth})`
    : "";
  if (depth > max) {
    return {
      ok: false,
      depth,
      code: "DEPTH_EXCEEDED",
      reason: `子代理嵌套深度超上限 ${max}:链 ${parentText}(父深度 ${parent.depth})+ 本次 = ${depth}${distrust};请由父代理自己完成或收拢任务`,
    };
  }
  return {
    ok: true,
    depth,
    code: "OK",
    reason: `深度 OK:链 ${parentText}(父深度 ${parent.depth})+ 本次 = ${depth}(上限 ${max})${distrust}`,
  };
}

/**
 * 子代理 deny 收敛:effective = 父 deny ∪ 子角色 deny ∪ 系统默认 deny ∪ primary-only。
 * 纯并集——只会收紧,任何一路都无法把别的路由的 deny 抵消掉。
 * 主 agent 视角(kind="primary"/isPrimaryOnly)不追加 primary-only:它本就该拥有这些工具。
 */
export function convergeDeny(input: ConvergeDenyInput): ConvergeDenyResult {
  const parent = sortedUnique(input?.parentDeny ?? []);
  const child = sortedUnique(input?.childDeny ?? []);
  const def = sortedUnique(DEFAULT_SUBAGENT_DENY);
  const isPrimary = input?.isPrimaryOnly === true || String(input?.kind ?? "").toLowerCase() === "primary";
  const primary = isPrimary ? [] : sortedUnique(input?.primaryOnly ?? []);
  const deny = [...new Set([...parent, ...child, ...def, ...primary])].sort();
  return { deny, sources: { parent, child, default: def, primary } };
}

/**
 * 冷启动续跑的会话键:`child:<原 taskId>`。
 * resume_agent 用同一个键续跑原 child 会话(而不是新开一个),键由原 taskId 派生,天然稳定可复现;
 * 同一原任务多次续跑落在同一键上,轨迹/日志可顺着一个键读完。
 */
export function resumeSessionKey(taskId: string): string {
  const id = typeof taskId === "string" ? taskId.trim() : "";
  return `child:${id}`;
}
