/**
 * 客户端协议探测与能力协商(纯逻辑,零 IO)。
 * 背景:WS 分发过去只有  的 clientMode allowlist(连接类型级),缺少「协议能力协商」:
 * 客户端不知道服务端装配了哪些能力面(hello 里没有 health 位),服务端也不知道客户端支持
 * 哪些 op;未知 type 落到协议解析层 invalid-message,既没有稳定码也没有可操作文案。
 * 本模块只做数据层判定,供 gateway 两处接线使用:
 * 1) hello:服务端自报 capabilities{contractVersion, ops, health};
 * 2) 分发门:每连接一份 negotiated,分发前 checkDispatch。
 * 三条不可动摇的口径(实现即口径,改口径先改这里):
 * - legacy 必须默认全放行。线上面板/脚本/第三方观察者都没有声明过能力集;若「没声明=全拒」,
 * 一次网关升级就能把全部旧客户端打成 0 功能。缺声明 → mode=legacy、acceptedOps=服务端全量,
 * 旧客户端只看 type 的既有行为逐字不变。
 * - 声明后 fail-closed。客户端一旦显式声明 supportedOps,它就是在承诺「我只用这些」;此时调用
 * 未声明 op 是契约违背(客户端 bug 或降级不完整),静默放行只会把错误推到更难定位的下游,
 * 所以 negotiated 连接调未声明 op 一律 unsupported-op,让调用方当场上报。
 * - 未知高版本不能放大权限。contractVersion > 当前服务端版本时,不能把「我不认识的版本」当成
 * 「它要什么就给什么」:高版本可能包含服务端还没有的 op,按声明放行等于让客户端自授权。
 * 正确做法是继续按当前服务端能力集的交集放行(宁少不多),回执里如用户反馈版本差。
 * 纪律:不 throw、不读环境/文件/时间、不改入参、返回对象冻结、排序用 code-unit 比较(确定性)。
 */

/**
 * 服务端能力命名空间封闭清单(按 type 的第一段)。
 * 口径:必须覆盖 apps/gateway/src/server.ts 中 `case "<ns>.<...>":` 的首段全集
 * (由 apps/gateway/test/capability-negotiation.test.ts 的源码对拍用例守着:任何新 case
 * 段没并进来,该用例直接红)。补齐前的 21 段只覆盖了一部分面板通道,voice/exp/team/issue/
 * browser/sys 等既有通道未编目 → negotiated 连接调它们会落回「已知通道」分支 fail-open。
 * 另外保留早期版本声明过、server.ts 内没有同名 case 的旧段(terminal/code/perm/relay/
 * plugin/skill/telemetry):删掉会让声明过它们的旧客户端从 legacy 放行变成 unsupported-op,
 * 属无收益的破坏性收窄。残留别名(plugins/plugin、skills/skill、term/terminal、
 * permission/perm)一律按各自字面段编目,不做前缀合并。
 * 顺序 = code-unit 升序(确定性;acceptedOps 复用它作为服务端顺序)。
 */
export const SERVER_CAPABILITY_OPS = [
  "agents",
  "annotate",
  "archive",
  "ask",
  "automation",
  "board",
  "browser",
  "cfg",
  "checkpoint",
  "client",
  "code",
  "commands",
  "companion",
  "dashboard",
  "exp",
  "file",
  "files",
  "fs",
  "git",
  "goal",
  "hooks",
  "ide",
  "issue",
  "lsp",
  "mcp",
  "meeting",
  "memory",
  "models",
  "node",
  "nodes",
  "perm",
  "permission",
  "plan",
  "plugin",
  "plugins",
  "profile",
  "project",
  "queue",
  "relay",
  "remote",
  "review",
  "rsi",
  "sense",
  "session",
  "skill",
  "skills",
  "ssh",
  "stats",
  "subagent",
  "subagents",
  "super",
  "sys",
  "task",
  "team",
  "teamai",
  "telemetry",
  "term",
  "terminal",
  "trace",
  "track",
  "usage",
  "voice",
  "wiki",
  "wizard",
  "workers",
  "workflow",
  "wsl",
] as const;

export type ServerCapabilityOp = (typeof SERVER_CAPABILITY_OPS)[number];

const SERVER_OP_SET: ReadonlySet<string> = new Set(SERVER_CAPABILITY_OPS);

/** 协商契约版本:只增不减(服务端可兼容低版本客户端,但不回收旧版本语义)。 */
export const CAPABILITY_CONTRACT_VERSION = 1;

/**
 * 分发门/协商回执用的稳定线上字符串(本模块内部判定只用这两个常量,值即线上值)。
 * 两个值已登记进协议 ErrorCode(UnsupportedOp/UnknownMethod)并有 error-text 文案;
 * 这里保留字符串常量是为了「判定层不依赖协议包」——回帧时由 gateway 映射成 ErrorCode.*。
 */
export const DISPATCH_ERROR_CODES = {
  unknownMethod: "unknown-method",
  unsupportedOp: "unsupported-op",
} as const;

export type DispatchErrorCode = (typeof DISPATCH_ERROR_CODES)[keyof typeof DISPATCH_ERROR_CODES];

// ---------------------------------------------------------------- 健康位

/** 服务端实装能力位(装配了才为 true;由 gateway 按 deps 实际装配情况传)。 */
export interface HealthBitInput {
  readonly ws: boolean;
  readonly journal: boolean;
  readonly llm: boolean;
  readonly modelScoring: boolean;
  readonly terminal: boolean;
  readonly memory: boolean;
}

/** 固定顺序 = 确定性输出(不依赖对象键序/入参顺序)。 */
const HEALTH_BIT_ORDER = ["ws", "journal", "llm", "modelScoring", "terminal", "memory"] as const;

/**
 * 只列出为 true 的位,按固定顺序。未知/缺省一律视为 false(不臆测能力)。
 * 返回冻结数组:调用方不能就地改服务端自报的能力面。
 */
export function healthBits(input: Partial<HealthBitInput> | null | undefined): readonly string[] {
  const src = input ?? {};
  const out: string[] = [];
  for (const bit of HEALTH_BIT_ORDER) if (src[bit] === true) out.push(bit);
  return Object.freeze(out);
}

// ---------------------------------------------------------------- op 提取

/**
 * 取第一个 "." 前的段;空串/不含点/未知段 → null。
 * 无点即无命名空间(如 "ping"/"task_output"),这类通道由网关按既有白名单处理,不属能力协商面。
 */
export function capabilityOpOf(type: unknown): string | null {
  if (typeof type !== "string") return null;
  const dot = type.indexOf(".");
  if (dot <= 0) return null;
  const op = type.slice(0, dot);
  return SERVER_OP_SET.has(op) ? op : null;
}

/**
 * 从一批 type 字面量里提取命名空间集合(去重 + code-unit 升序;非字符串/空/无点一律剔除)。
 * 刻意**不按封闭清单过滤**:对拍用例要的正是「源里出现了哪些段」,包含未编目的段才能报出漏项。
 */
export function capabilityOpsOfTypes(types: Iterable<unknown>): readonly string[] {
  const out = new Set<string>();
  for (const type of types) {
    if (typeof type !== "string") continue;
    const dot = type.indexOf(".");
    if (dot <= 0) continue;
    out.add(type.slice(0, dot));
  }
  return Object.freeze([...out].sort());
}

// ---------------------------------------------------------------- 协商

export type CapabilityMode = "legacy" | "negotiated";
export type NegotiationCode = "LEGACY" | "OK" | "CONTRACT_TOO_OLD" | "NO_OPS";

export interface NegotiatedCapabilities {
  readonly mode: CapabilityMode;
 /** 本连接被放行的 op 命名空间(服务端顺序=确定性;legacy=服务端全量)。 */
  readonly acceptedOps: readonly string[];
 /** 客户端声明了但服务端不认识/未编目的 op(去重排序)。 */
  readonly rejectedOps: readonly string[];
 /** 被丢弃的声明键名与坏/重复 op 名(去重排序)。 */
  readonly droppedKeys: readonly string[];
  readonly code: NegotiationCode;
}

/** 声明的已知键(不在表内的键 = 未知键,丢弃并在 droppedKeys 回报)。 */
const KNOWN_DECLARATION_KEYS: ReadonlySet<string> = new Set(["supportedOps", "contractVersion", "requiredOps"]);

function sortedUnique(items: Iterable<string>): string[] {
  return [...new Set(items)].sort();
}

function freezeNegotiation(
  mode: CapabilityMode,
  acceptedOps: readonly string[],
  rejectedOps: readonly string[],
  droppedKeys: readonly string[],
  code: NegotiationCode): NegotiatedCapabilities {
  return Object.freeze({
    mode,
    acceptedOps: Object.freeze([...acceptedOps]),
    rejectedOps: Object.freeze(sortedUnique(rejectedOps)),
    droppedKeys: Object.freeze(sortedUnique(droppedKeys)),
    code,
  });
}

/**
 * 客户端能力声明协商。声明面故意收 unknown(坏字段由这里判,而不是协议解析层通用 invalid-message):
 * - 缺 declared / 缺 supportedOps / supportedOps 非数组 → legacy,acceptedOps=serverOps 全量,code=LEGACY;
 * - supportedOps 存在 → 与 serverOps 求交集(服务端顺序);未知 op 进 rejectedOps+droppedKeys,重复进 droppedKeys;
 * - contractVersion 非数字 → 丢弃(记 droppedKeys.contractVersion,按未声明版本处理);
 * - contractVersion < current → CONTRACT_TOO_OLD(仍按交集放行基础 op);
 * - contractVersion > current → OK,仍按当前交集(未知高版本不放大权限,见文件头);
 * - supportedOps 声明了但交集为空 → NO_OPS(accepted 为空 = 所有非 client 通道拒)。
 */
export function negotiateClientCapabilities(
  declared: unknown,
  opts: { readonly serverOps: readonly string[]; readonly currentContractVersion: number },
): NegotiatedCapabilities {
  const serverOps = (opts.serverOps ?? []).filter((op): op is string => typeof op === "string" && op.length > 0);
  const serverSet = new Set(serverOps);
  const droppedKeys: string[] = [];

  const record: Record<string, unknown> | null =
    declared !== null && typeof declared === "object" && !Array.isArray(declared)
      ? (declared as Record<string, unknown>)
      : null;

  if (record) {
 // 未知键丢弃(不回显值,只回报键名)——新客户端多带的字段不会让整条声明被拒。
    for (const key of Object.keys(record)) if (!KNOWN_DECLARATION_KEYS.has(key)) droppedKeys.push(key);
  }

  const rawVersion = record?.contractVersion;
  let contractVersion: number | undefined;
  if (rawVersion !== undefined) {
    if (typeof rawVersion === "number" && Number.isFinite(rawVersion)) contractVersion = rawVersion;
    else droppedKeys.push("contractVersion"); // 非数字版本=坏字段,丢弃而不猜语义
  }

  const rawSupported = record?.supportedOps;
  if (rawSupported === undefined || rawSupported === null) {
    return freezeNegotiation("legacy", serverOps, [], droppedKeys, "LEGACY");
  }
  if (!Array.isArray(rawSupported)) {
 // 字段在但类型坏:按「未声明」处理(legacy 全放行,不因坏字段把旧客户端打死),同时回报丢弃。
    droppedKeys.push("supportedOps");
    return freezeNegotiation("legacy", serverOps, [], droppedKeys, "LEGACY");
  }

  const seen = new Set<string>();
  const declaredOps: string[] = [];
  for (const raw of rawSupported) {
    if (typeof raw !== "string" || raw.length === 0) {
      droppedKeys.push("supportedOps"); // 非字符串/空串条目丢弃(按字段名记一次)
      continue;
    }
    if (seen.has(raw)) {
      droppedKeys.push(raw); // 重复声明:保留第一次,后续丢弃
      continue;
    }
    seen.add(raw);
    declaredOps.push(raw);
  }

  const acceptedOps = serverOps.filter((op) => seen.has(op)); // 服务端顺序 = 确定性
  const rejectedOps = declaredOps.filter((op) => !serverSet.has(op));
  for (const op of rejectedOps) droppedKeys.push(op); // 未知 op 同时进 rejectedOps 与 droppedKeys

  const code: NegotiationCode =
    acceptedOps.length === 0
      ? "NO_OPS" // 声明了但一个都不在服务端能力集:全拒(比 CONTRACT_TOO_OLD 更严格,优先)
      : contractVersion !== undefined && contractVersion < opts.currentContractVersion
        ? "CONTRACT_TOO_OLD"
        : "OK";

  return freezeNegotiation("negotiated", acceptedOps, rejectedOps, droppedKeys, code);
}

/** 未声明客户端的缺省协商结果(每连接缺省用它;服务端启动即可复用同一冻结对象)。 */
export const LEGACY_NEGOTIATION: NegotiatedCapabilities = negotiateClientCapabilities(undefined, {
  serverOps: SERVER_CAPABILITY_OPS,
  currentContractVersion: CAPABILITY_CONTRACT_VERSION,
});

// ---------------------------------------------------------------- 分发门

export type DispatchCheckCode = "OK" | "UNKNOWN_METHOD" | "UNSUPPORTED_OP";

export interface DispatchCheck {
  readonly allow: boolean;
  readonly code: DispatchCheckCode;
}

/**
 * 分发前判定:
 * - type 非字符串/空/无点/op 不在封闭清单 → UNKNOWN_METHOD(网关据此回 unknown-method,不再静默);
 * - client.* 是引导命名空间(client.mode / client.capabilities 必须自举,否则声明 NO_OPS 后无法再协商)→ 恒放行;
 * - legacy → 已知 op 放行(旧客户端零变化);
 * - negotiated 且 op 不在 acceptedOps → UNSUPPORTED_OP(fail-closed)。
 */
export function checkDispatch(input: {
  readonly type: unknown;
  readonly negotiated: NegotiatedCapabilities;
}): DispatchCheck {
  const type = input?.type;
  if (typeof type !== "string" || type.length === 0) return Object.freeze({ allow: false, code: "UNKNOWN_METHOD" });
  const op = capabilityOpOf(type);
  if (op === null) return Object.freeze({ allow: false, code: "UNKNOWN_METHOD" });
 // client 命名空间恒放行(自举通道):能力集再小也要能重新协商回来。
  if (op === "client") return Object.freeze({ allow: true, code: "OK" });
  const negotiated = input.negotiated;
  if (!negotiated || negotiated.mode !== "negotiated") return Object.freeze({ allow: true, code: "OK" });
  return negotiated.acceptedOps.includes(op)
    ? Object.freeze({ allow: true, code: "OK" })
    : Object.freeze({ allow: false, code: "UNSUPPORTED_OP" });
}

// ---------------------------------------------------------------- 摘要

/** 一行摘要(≤200 字;回执与日志共用,不含 op 全名单以免长帧)。 */
export function describeCapabilities(negotiated: NegotiatedCapabilities): string {
  const label = negotiated.mode === "legacy" ? "legacy 全量放行" : "已协商";
  const text =
    `能力协商(${label}):code=${negotiated.code};` +
    `接受 ${negotiated.acceptedOps.length} 个 op;拒绝 ${negotiated.rejectedOps.length} 个;` +
    `丢弃 ${negotiated.droppedKeys.length} 个键/op`;
  return text.slice(0, 200);
}
