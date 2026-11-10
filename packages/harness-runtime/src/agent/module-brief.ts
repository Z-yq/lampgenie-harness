/**
 * 模块简报(module-brief):把一个模块的身份 / 契约 / 一层直接依赖 / 公开入口 / 允许边
 * 压成一份有界 markdown 简报,让 agent 不必下读实现正文就能建立模块认知。
 * 设计约束(与 tool-upgrade-protocol 同风格):
 * - 纯逻辑:零 IO、无时间戳、无随机;同输入多次调用结果逐字节相等。
 * - 不抛异常:非法输入走稳定码 BRIEF_INVALID + 最小 brief。
 * - 输出只含符号与位置,绝不贴实现正文。
 */

export const MODULE_BRIEF_VERSION = 1;

/** 输入非法(非对象 / identity 缺 name 或 path)。 */
export const BRIEF_INVALID = "BRIEF_INVALID";
/** 成功产出简报(任何合法输入都带)。 */
export const BRIEF_BUILT = "BRIEF_BUILT";
/** 模块契约缺失。 */
export const BRIEF_CONTRACT_MISSING = "BRIEF_CONTRACT_MISSING";
/** identity.owner 缺失。 */
export const BRIEF_OWNER_MISSING = "BRIEF_OWNER_MISSING";
/** identity.layer 缺失。 */
export const BRIEF_LAYER_MISSING = "BRIEF_LAYER_MISSING";
/** 模块未被托管(managed=false)。 */
export const BRIEF_UNMANAGED = "BRIEF_UNMANAGED";
/** 至少一个直接依赖缺契约(码只出现一次)。 */
export const BRIEF_DEP_CONTRACT_MISSING = "BRIEF_DEP_CONTRACT_MISSING";
/** 依赖或入口被截断。 */
export const BRIEF_TRUNCATED = "BRIEF_TRUNCATED";
/** 截断后仍超 maxChars。 */
export const BRIEF_TOO_LARGE = "BRIEF_TOO_LARGE";

/** 码的规范顺序(输出按此排序,保证确定性)。 */
const CODE_ORDER: readonly string[] = [
  BRIEF_INVALID,
  BRIEF_BUILT,
  BRIEF_CONTRACT_MISSING,
  BRIEF_OWNER_MISSING,
  BRIEF_LAYER_MISSING,
  BRIEF_UNMANAGED,
  BRIEF_DEP_CONTRACT_MISSING,
  BRIEF_TRUNCATED,
  BRIEF_TOO_LARGE,
];

export interface ModuleIdentity {
  name: string;
  path: string;
  packageName?: string;
  description?: string;
  owner?: string;
  layer?: string;
  managed: boolean;
}

export interface ContractRef {
  path?: string;
  summary?: string;
  present: boolean;
}

export interface DepRef {
  name: string;
  path?: string;
  packageName?: string;
  description?: string;
  contractPresent: boolean;
  layer?: string;
  allowedEdge?: boolean;
}

export type EntryKind = "export" | "class" | "function" | "const";

export interface EntryRef {
  file: string;
  line: number;
  symbol: string;
  kind: EntryKind;
}

export interface AllowedEdge {
  from: string;
  to: string;
  reason?: string;
}

export interface ModuleBrief {
  identity: ModuleIdentity;
  contract: ContractRef;
  deps: DepRef[];
  entries: EntryRef[];
  allowedEdges: AllowedEdge[];
  missing: string[];
  rendered: string;
  chars: number;
}

/** 宽松依赖输入:字段类型不做编译期承诺,由 buildBrief 归一化。 */
export interface LooseDepInput {
  name?: unknown;
  path?: unknown;
  packageName?: unknown;
  description?: unknown;
  contractPresent?: unknown;
  layer?: unknown;
  allowedEdge?: unknown;
  contract?: unknown;
}

/** 宽松入口输入:形状由 assertEntryShape 裁决。 */
export interface LooseEntryInput {
  file?: unknown;
  line?: unknown;
  symbol?: unknown;
  kind?: unknown;
}

/** buildBrief 的输入:identity 必填(可只给 name/path),其余可省。 */
export interface BriefInput {
  identity: Partial<ModuleIdentity>;
  contract?: ContractRef | { text?: string; present?: boolean; path?: string; summary?: string } | string;
  deps?: LooseDepInput[];
  entries?: LooseEntryInput[];
  allowedEdges?: AllowedEdge[];
}

export interface BriefOptions {
  maxChars?: number;
  maxDeps?: number;
  maxEntries?: number;
}

export interface BriefResult {
  brief: ModuleBrief;
  codes: string[];
}

const DEFAULT_MAX_CHARS = 2400;
const DEFAULT_MAX_DEPS = 8;
const DEFAULT_MAX_ENTRIES = 12;
/** 契约摘要字符上限。 */
const SUMMARY_MAX = 160;

const ENTRY_KINDS: readonly string[] = ["export", "class", "function", "const"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function positiveIntOr(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const int = Math.floor(value);
  return int >= 0 ? int : fallback;
}

function normalizeOptions(opts?: BriefOptions): Required<BriefOptions> {
  const raw = isRecord(opts) ? opts : {};
  const maxChars = positiveIntOr(raw.maxChars, DEFAULT_MAX_CHARS);
  return {
    maxChars: maxChars > 0 ? maxChars : DEFAULT_MAX_CHARS,
    maxDeps: positiveIntOr(raw.maxDeps, DEFAULT_MAX_DEPS),
    maxEntries: positiveIntOr(raw.maxEntries, DEFAULT_MAX_ENTRIES),
  };
}

function sortCodes(codes: string[]): string[] {
  const unique = Array.from(new Set(codes));
  return unique.sort((a, b) => {
    const ra = CODE_ORDER.indexOf(a);
    const rb = CODE_ORDER.indexOf(b);
    return (ra < 0 ? CODE_ORDER.length : ra) - (rb < 0 ? CODE_ORDER.length : rb);
  });
}

/**
 * 入口形状校验:file 非空 string、line 正整数、symbol 非空 string。
 * 不抛异常、不猜缺省。kind 不在本函数职责内(由 buildBrief 归一化)。
 */
export function assertEntryShape(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  if (nonEmptyString(entry.file) === undefined) return false;
  if (typeof entry.line !== "number" || !Number.isInteger(entry.line) || entry.line <= 0) return false;
  if (nonEmptyString(entry.symbol) === undefined) return false;
  return true;
}

/**
 * 契约摘要:取首个非标题段落(跳过 `#` 标题、空行、HTML 注释),压平换行。
 * ≤160 字;超出取前 160 加「…」。空 / 纯标题 / 非字符串 → undefined(不猜)。
 */
export function summarizeContract(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, "");
  if (withoutComments.trim().length === 0) return undefined;
  const lines = withoutComments.split(/\r?\n/);
  const paragraph: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(trimmed);
  }
  if (paragraph.length === 0) return undefined;
  const flat = paragraph.join(" ").replace(/\s+/g, " ").trim();
  if (flat.length === 0) return undefined;
  return flat.length <= SUMMARY_MAX ? flat : `${flat.slice(0, SUMMARY_MAX)}…`;
}

function entryLine(entry: EntryRef): string {
  return `- ${entry.symbol} — ${entry.file}:${entry.line}`;
}

function depLine(dep: DepRef): string {
  const where = dep.path ? ` @ ${dep.path}` : "";
  return `- ${dep.name}${where} — 契约:${dep.contractPresent ? "已就绪" : "缺失"}`;
}

/**
 * 简报渲染(纯 markdown):五章固定顺序 —— ①身份 ②契约 ③直接依赖 ④入口 ⑤允许边。
 * buildBrief 内部必须走这里,不做第二份渲染实现。
 */
export function renderBrief(brief: ModuleBrief): string {
  const id = brief.identity;
  const lines: string[] = [];

  lines.push(`# 模块简报:${id.name.length > 0 ? id.name : "未知模块"}`);
  lines.push("");

  lines.push("## ① 身份");
  lines.push(`- name: ${id.name.length > 0 ? id.name : "缺失"}`);
  lines.push(`- path: ${id.path.length > 0 ? id.path : "缺失"}`);
  if (id.packageName) lines.push(`- package: ${id.packageName}`);
  if (id.description) lines.push(`- description: ${id.description}`);
  lines.push(`- owner: ${id.owner ? id.owner : "缺失"}`);
  lines.push(`- layer: ${id.layer ? id.layer : "缺失"}`);
  lines.push(`- managed: ${id.managed ? "true" : "false"}`);
  lines.push("");

  lines.push("## ② 契约");
  if (brief.contract.present) {
    if (brief.contract.path) lines.push(`- 位置: ${brief.contract.path}`);
    lines.push(`- 摘要: ${brief.contract.summary ? brief.contract.summary : "摘要未提供"}`);
  } else {
    lines.push("- 缺失(明示):未声明契约,也未提供契约文本;契约面不可用");
  }
  lines.push("");

  lines.push("## ③ 直接依赖");
  if (brief.deps.length === 0) {
    lines.push("- 无直接依赖");
  } else {
    for (const dep of brief.deps) lines.push(depLine(dep));
  }
  lines.push("");

  lines.push("## ④ 入口");
  if (brief.entries.length === 0) {
    lines.push("- 无公开入口或未解析");
  } else {
    for (const entry of brief.entries) lines.push(entryLine(entry));
  }
  lines.push("");

  lines.push("## ⑤ 允许边");
  if (brief.allowedEdges.length === 0) {
    lines.push("- 无");
  } else {
    for (const edge of brief.allowedEdges) {
      const reason = edge.reason ? ` (${edge.reason})` : "";
      lines.push(`- ${edge.from} → ${edge.to}${reason}`);
    }
  }

  return lines.join("\n");
}

/** 最小 brief(非法输入时返回):空 deps/entries、无码之外的信息。 */
function minimalBrief(reason: string): ModuleBrief {
  const brief: ModuleBrief = {
    identity: { name: "", path: "", managed: false },
    contract: { present: false },
    deps: [],
    entries: [],
    allowedEdges: [],
    missing: [reason],
    rendered: "",
    chars: 0,
  };
  const rendered = renderBrief(brief);
  brief.rendered = rendered;
  brief.chars = rendered.length;
  return brief;
}

interface LooseContract {
  present?: unknown;
  summary?: unknown;
  text?: unknown;
  path?: unknown;
}

function readContract(raw: unknown): ContractRef {
  if (typeof raw === "string") {
    const summary = summarizeContract(raw);
    return summary ? { present: true, summary } : { present: false };
  }
  if (!isRecord(raw)) return { present: false };
  const loose = raw as LooseContract;
  const summary = nonEmptyString(loose.summary);
  const path = nonEmptyString(loose.path);
  const present = loose.present === true;
  const fromText = present ? undefined : summarizeContract(loose.text);
  const resolved = present ? summary : (summary ?? fromText);
  const contract: ContractRef = { present: present || resolved !== undefined };
  if (path) contract.path = path;
  if (resolved) contract.summary = resolved;
  return contract;
}

function readDep(raw: unknown): DepRef | undefined {
  if (!isRecord(raw)) return undefined;
  const loose = raw as LooseDepInput;
  const name = nonEmptyString(loose.name);
  if (!name) return undefined;
  const nested = isRecord(loose.contract) ? (loose.contract as LooseContract) : undefined;
  let contractPresent = loose.contractPresent === true || nested?.present === true;
  if (!contractPresent && nested) contractPresent = summarizeContract(nested.text) !== undefined;
  const dep: DepRef = { name, contractPresent };
  const path = nonEmptyString(loose.path);
  if (path) dep.path = path;
  const packageName = nonEmptyString(loose.packageName);
  if (packageName) dep.packageName = packageName;
  const description = nonEmptyString(loose.description);
  if (description) dep.description = description;
  const layer = nonEmptyString(loose.layer);
  if (layer) dep.layer = layer;
  if (loose.allowedEdge === true || loose.allowedEdge === false) dep.allowedEdge = loose.allowedEdge;
  return dep;
}

function readEntry(raw: unknown): EntryRef | undefined {
  if (!assertEntryShape(raw)) return undefined;
  const loose = raw as LooseEntryInput;
  const kind = nonEmptyString(loose.kind);
  return {
    file: (loose.file as string).trim(),
    line: loose.line as number,
    symbol: (loose.symbol as string).trim(),
    kind: kind !== undefined && ENTRY_KINDS.includes(kind) ? (kind as EntryKind) : "export",
  };
}

function readEdges(raw: unknown): AllowedEdge[] {
  if (!Array.isArray(raw)) return [];
  const edges: AllowedEdge[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const from = nonEmptyString(item.from);
    const to = nonEmptyString(item.to);
    if (!from || !to) continue;
    const edge: AllowedEdge = { from, to };
    const reason = nonEmptyString(item.reason);
    if (reason) edge.reason = reason;
    edges.push(edge);
  }
  return edges;
}

/**
 * 构建模块简报。章节顺序固定;码覆盖契约/owner/layer/managed/依赖契约/截断/超预算。
 * 非法输入返回 codes=[BRIEF_INVALID] 与空 deps/entries 的最小 brief,绝不抛异常。
 */
export function buildBrief(input: unknown, opts?: BriefOptions): BriefResult {
  try {
    const options = normalizeOptions(opts);
    const raw = isRecord(input) ? input : undefined;
    const identityRaw = raw && isRecord(raw.identity) ? raw.identity : undefined;
    const name = identityRaw ? nonEmptyString(identityRaw.name) : undefined;
    const path = identityRaw ? nonEmptyString(identityRaw.path) : undefined;
    if (!identityRaw || !name || !path) {
      return { brief: minimalBrief("输入非法:需要 identity.name 与 identity.path 非空字符串"), codes: [BRIEF_INVALID] };
    }

    const codes: string[] = [BRIEF_BUILT];
    const missing: string[] = [];

    const identity: ModuleIdentity = { name, path, managed: identityRaw.managed === true };
    const packageName = nonEmptyString(identityRaw.packageName);
    if (packageName) identity.packageName = packageName;
    const description = nonEmptyString(identityRaw.description);
    if (description) identity.description = description;
    const owner = nonEmptyString(identityRaw.owner);
    if (owner) identity.owner = owner;
    const layer = nonEmptyString(identityRaw.layer);
    if (layer) identity.layer = layer;

    if (!owner) {
      codes.push(BRIEF_OWNER_MISSING);
      missing.push("owner 缺失:未声明归属负责人/团队");
    }
    if (!layer) {
      codes.push(BRIEF_LAYER_MISSING);
      missing.push("layer 缺失:未声明所属分层");
    }
    if (!identity.managed) {
      codes.push(BRIEF_UNMANAGED);
      missing.push("未托管:managed=false,该模块不在托管边界内");
    }

    const contract = readContract(raw?.contract);
    if (!contract.present) {
      codes.push(BRIEF_CONTRACT_MISSING);
      missing.push("契约缺失:未声明契约,也未提供可摘要的契约文本");
    }

    const deps: DepRef[] = [];
    const depsRaw = Array.isArray(raw?.deps) ? (raw?.deps as unknown[]) : [];
    for (const item of depsRaw) {
      const dep = readDep(item);
      if (!dep) continue;
      deps.push(dep);
      if (!dep.contractPresent) {
        if (!codes.includes(BRIEF_DEP_CONTRACT_MISSING)) codes.push(BRIEF_DEP_CONTRACT_MISSING);
        missing.push(`依赖契约缺失: ${dep.name}`);
      }
    }

    const entries: EntryRef[] = [];
    const entriesRaw = Array.isArray(raw?.entries) ? (raw?.entries as unknown[]) : [];
    for (const item of entriesRaw) {
      const entry = readEntry(item);
      if (entry) {
        entries.push(entry);
      } else {
        const label = isRecord(item) && nonEmptyString(item.symbol) ? nonEmptyString(item.symbol) : undefined;
        missing.push(`入口形状非法:${label ?? "<未知>"}`);
      }
    }

    const allowedEdges = readEdges(raw?.allowedEdges);

    const droppedDeps: DepRef[] = [];
    const droppedEntries: EntryRef[] = [];
    if (deps.length > options.maxDeps) {
      codes.push(BRIEF_TRUNCATED);
      droppedDeps.push(...deps.splice(options.maxDeps));
    }
    if (entries.length > options.maxEntries) {
      codes.push(BRIEF_TRUNCATED);
      droppedEntries.push(...entries.splice(options.maxEntries));
    }
    for (const dep of droppedDeps) {
      if (!dep.contractPresent) missing.push(`依赖契约缺失: ${dep.name}(已截断,契约状态未知)`);
    }

    const brief: ModuleBrief = { identity, contract, deps, entries, allowedEdges, missing, rendered: "", chars: 0 };

    const compose = (): string => {
      const base = renderBrief(brief);
      const notes: string[] = [];
      if (droppedDeps.length > 0) notes.push(`…已截断 ${droppedDeps.length} 个依赖(契约状态未知)`);
      if (droppedEntries.length > 0) notes.push(`…已截断 ${droppedEntries.length} 个入口`);
      return notes.length > 0 ? `${base}\n${notes.join("\n")}` : base;
    };

    let rendered = compose();
    // 超预算:先截依赖尾部,再截入口尾部;每次只丢一个,直到收敛或无可丢。
    while (rendered.length > options.maxChars) {
      const droppedDep = brief.deps.pop();
      if (droppedDep) {
        droppedDeps.push(droppedDep);
        if (!codes.includes(BRIEF_TRUNCATED)) codes.push(BRIEF_TRUNCATED);
        if (!droppedDep.contractPresent) missing.push(`依赖契约缺失: ${droppedDep.name}(已截断,契约状态未知)`);
        rendered = compose();
        continue;
      }
      const droppedEntry = brief.entries.pop();
      if (droppedEntry) {
        droppedEntries.push(droppedEntry);
        if (!codes.includes(BRIEF_TRUNCATED)) codes.push(BRIEF_TRUNCATED);
        rendered = compose();
        continue;
      }
      break;
    }
    if (rendered.length > options.maxChars) {
      codes.push(BRIEF_TOO_LARGE);
      rendered = `${rendered}\n已超预算 maxChars=${options.maxChars}`;
    }

    brief.rendered = rendered;
    brief.chars = rendered.length;
    return { brief, codes: sortCodes(codes) };
  } catch {
    return { brief: minimalBrief("输入非法:简报构建过程中遇到不可读输入"), codes: [BRIEF_INVALID] };
  }
}

/**
 * 深挖指路:已知 dep 且有 path 用 path,否则用 depName 原文。纯指路,不做任何读取。
 */
export function expandHint(brief: ModuleBrief, depName: string): string {
  const known = brief.deps.find((dep) => dep.name === depName);
  const target = known && known.path ? known.path : depName;
  return `如需更深:module-brief --module ${target}`;
}
