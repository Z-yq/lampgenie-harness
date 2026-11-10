/**
 * M153 工具注册身份治理(纯逻辑,零依赖:本文件不 import 任何模块)。
 *
 * 目的:工具面上的「身份」只有一套真源。builtin / mcp / plugin / alias / subagent 五类来源
 * 登记到同一个 ToolIdentityRegistry,冲突按固定优先级裁决,而不是靠装配顺序谁后谁覆盖:
 * - 保留名(read_file/write_file/... )只许 builtin 占用,插件/MCP 同名一律拒绝(否则影子工具可劫持核心行为);
 * - 非 alias 同名二次注册 → DUPLICATE_NAME;
 * - alias 只许一跳解引用,且不许遮蔽保留名/已注册真名/已有 alias(防「换个名字等价于替换」)。
 * loop 的未知工具分支用 describeUnknownTool 给出可达候选(前缀优先 + 编辑距离),让模型能自我纠错。
 */

/** 保留工具名:核心工具面身份,只允许 builtin 来源登记。 */
export const RESERVED_TOOL_NAMES: readonly string[] = [
  "read_file",
  "write_file",
  "edit_file",
  "apply_patch",
  "list_dir",
  "glob",
  "grep",
  "terminal",
  "todo_write",
  "task_phase",
  "task_output",
  "board_upsert",
  "board_read",
  "board_export_pptx",
  "ask_user",
  "steer",
  "spawn_subagent",
  "session_search",
  "code_sense",
  "result_read",
];

/** 注册来源。builtin=引擎自带;mcp=MCP 服务端工具;plugin=插件;alias=别名;subagent=子代理专属。 */
export type ToolSource = "builtin" | "mcp" | "plugin" | "alias" | "subagent";

/** 一条注册记录(name=对外名;canonical 仅 alias 使用;ownerId 非空表示「按 owner 授权」)。 */
export interface ToolRegistration {
  name: string;
  source: ToolSource;
  canonical?: string;
  ownerId?: string;
}

/** 拒绝码:注册失败的六种确定性原因(fail-closed,不做自动改名/覆盖)。 */
export type IdentityErrorCode =
  | "INVALID_NAME"
  | "RESERVED_NAME_REJECTED"
  | "DUPLICATE_NAME"
  | "SHADOW_REJECTED"
  | "CANONICAL_MISSING"
  | "ALIAS_TO_ALIAS";

export type RegisterResult =
  | { ok: true; registration: ToolRegistration; idempotent?: true }
  | { ok: false; code: IdentityErrorCode; message: string };

/** 解析结果(alias 已解引用):toolName 是实际执行目标名,registration 是「查到的这条注册」。 */
export interface ResolvedTool {
  toolName: string;
  source: ToolSource;
  registration: ToolRegistration;
  authorized: boolean;
}

/** 未知工具建议(loop 错误框用;reachableFrom 是可达候选,最多 3 个)。 */
export interface UnknownToolSuggestion {
  code: "UNKNOWN_TOOL";
  message: string;
  reachableFrom: string[];
}

/** 合法名:1~128 个字母/数字/下划线/点/冒号/连字符(MCP 的 mcp__server__tool 也在此范围内)。 */
const NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/** override 键分隔符:用 \u0000 避免 ownerId/toolName 里出现分隔符时串键。 */
const OVERRIDE_SEP = "\u0000";

/** 小写编辑距离(用于未知工具候选排序)。 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[b.length]!;
}

/**
 * 工具身份注册表:纯内存,不做 IO;装配方登记完工具面后用它裁决冲突。
 * 内部两张表:非 alias 真名表 + alias 表(有序数组同时保留全部注册,供 list() 原样返回)。
 */
export class ToolIdentityRegistry {
  /** 全部注册项(含 alias),按登记顺序。 */
  private readonly all: ToolRegistration[] = [];
  /** 非 alias 注册:name → registration。 */
  private readonly canonicalByName = new Map<string, ToolRegistration>();
  /** alias 注册:name → registration。 */
  private readonly aliasByName = new Map<string, ToolRegistration>();
  /** 按 owner 的授权覆盖:ownerId\u0000toolName。 */
  private readonly overrides = new Set<string>();

  /** 登记一个工具身份;规则顺序即优先级(幂等判定在任何冲突判定之前)。 */
  register(reg: ToolRegistration): RegisterResult {
    const name = reg.name;

    // 1) 名不合法:空串/超长/含非法字符。
    if (!NAME_PATTERN.test(name)) {
      return { ok: false, code: "INVALID_NAME", message: `工具名非法:${JSON.stringify(name)}(要求 /^[A-Za-z0-9_.:-]{1,128}$/)` };
    }

    // 2) 同一 owner 的同一身份重复登记 → 幂等成功(装配方重复挂载同一别名不算冲突)。
    // 注意:ownerId 缺省的公共注册不享受幂等——同名二次注册一律按冲突处理(内置工具面重复挂载是真 bug,
    // 必须暴露并剔除,不能被幂等悄悄吞掉)。
    if (reg.ownerId !== undefined) {
      const same = this.all.find(
        (r) => r.name === name && r.source === reg.source && r.canonical === reg.canonical && r.ownerId === reg.ownerId,
      );
      if (same) return { ok: true, registration: same, idempotent: true };
    }

    if (reg.source !== "alias") {
      // 3) 保留名:非 builtin 来源不许占用核心工具名。
      if (RESERVED_TOOL_NAMES.includes(name) && reg.source !== "builtin") {
        return {
          ok: false,
          code: "RESERVED_NAME_REJECTED",
          message: `保留工具名不允许 ${reg.source} 来源注册:${name}(保留名仅限 builtin)`,
        };
      }
      // 5) 真名重复:同名已登记(非 alias)。
      if (this.canonicalByName.has(name)) {
        return { ok: false, code: "DUPLICATE_NAME", message: `工具名已注册:${name}(来源 ${this.canonicalByName.get(name)!.source})` };
      }
      // 5b) 该名已被 alias 占用:先注册者占名。否则非 alias 注册会在 resolve() 里压住 alias,
      // 造成 alias 撤销后仍被这条影子真名顶替(别名失效)。
      if (this.aliasByName.has(name)) {
        return {
          ok: false,
          code: "DUPLICATE_NAME",
          message: `工具名已被 alias 占用:${name}(先注册者占名)`,
        };
      }
      const entry: ToolRegistration = { ...reg };
      this.all.push(entry);
      this.canonicalByName.set(name, entry);
      return { ok: true, registration: entry };
    }

    // 4) alias:必须指向已注册真身;只许一跳;不许遮蔽任何既有身份。
    if (!reg.canonical) {
      return { ok: false, code: "CANONICAL_MISSING", message: `alias 缺少 canonical 目标:${name}` };
    }
    const target = this.canonicalByName.get(reg.canonical) ?? this.aliasByName.get(reg.canonical);
    if (!target) {
      return { ok: false, code: "CANONICAL_MISSING", message: `alias 目标未注册:${name} → ${reg.canonical}` };
    }
    if (target.source === "alias" || this.aliasByName.has(reg.canonical)) {
      return { ok: false, code: "ALIAS_TO_ALIAS", message: `alias 只允许一跳:${name} → ${reg.canonical}(目标本身是 alias)` };
    }
    if (RESERVED_TOOL_NAMES.includes(name) || this.canonicalByName.has(name) || this.aliasByName.has(name)) {
      return {
        ok: false,
        code: "SHADOW_REJECTED",
        message: `alias 名不得遮蔽既有工具身份:${name}(保留名/已注册真名/已有 alias)`,
      };
    }
    const aliasEntry: ToolRegistration = { ...reg };
    this.all.push(aliasEntry);
    this.aliasByName.set(name, aliasEntry);
    return { ok: true, registration: aliasEntry };
  }

  /** 解析对外名:alias 一跳解引用到 canonical;未注册返回 null。 */
  resolve(name: string): ResolvedTool | null {
    const alias = this.aliasByName.get(name);
    if (alias) {
      // 按登记期校验,canonical 必然存在且是本身份。
      const target = this.canonicalByName.get(alias.canonical!);
      if (!target) return null;
      return {
        toolName: target.name,
        source: target.source,
        registration: alias,
        authorized: this.authorizedFor(alias, target.name),
      };
    }
    const reg = this.canonicalByName.get(name);
    if (!reg) return null;
    return { toolName: reg.name, source: reg.source, registration: reg, authorized: this.authorizedFor(reg, reg.name) };
  }

  /** 全部注册项(含 alias,副本)。 */
  list(): ToolRegistration[] {
    return this.all.map((r) => ({ ...r }));
  }

  /** 查原始注册项(不做 alias 解引用);未注册 null。 */
  inspect(name: string): ToolRegistration | null {
    const reg = this.canonicalByName.get(name) ?? this.aliasByName.get(name);
    return reg ? { ...reg } : null;
  }

  /** 给某 owner 授权访问某工具(ownerId 未登记的注册不受此影响)。 */
  grantOverride(ownerId: string, toolName: string): void {
    this.overrides.add(`${ownerId}${OVERRIDE_SEP}${toolName}`);
  }

  /** 撤销某 owner 对某工具的授权。 */
  revokeOverride(ownerId: string, toolName: string): void {
    this.overrides.delete(`${ownerId}${OVERRIDE_SEP}${toolName}`);
  }

  /**
   * 注销某 owner:删除其全部 alias 注册与全部 override,返回被删 alias 名(真名注册不在此处撤销)。
   */
  unregister(ownerId: string): string[] {
    const removed: string[] = [];
    for (const r of this.all) if (r.source === "alias" && r.ownerId === ownerId) removed.push(r.name);
    if (removed.length > 0) {
      const gone = new Set(removed);
      for (let i = this.all.length - 1; i >= 0; i--) if (gone.has(this.all[i]!.name) && this.all[i]!.source === "alias") this.all.splice(i, 1);
      for (const n of gone) this.aliasByName.delete(n);
    }
    const prefix = `${ownerId}${OVERRIDE_SEP}`;
    for (const key of [...this.overrides]) if (key.startsWith(prefix)) this.overrides.delete(key);
    return removed;
  }

  /** 授权判定:无 ownerId(公共工具)恒可;有 ownerId 必须显式 override。 */
  isAuthorized(ownerId: string | undefined, toolName: string): boolean {
    if (ownerId === undefined) return true;
    return this.overrides.has(`${ownerId}${OVERRIDE_SEP}${toolName}`);
  }

  private authorizedFor(reg: ToolRegistration, toolName: string): boolean {
    return reg.ownerId === undefined ? true : this.overrides.has(`${reg.ownerId}${OVERRIDE_SEP}${toolName}`);
  }
}

/**
 * 未知工具纠错建议:候选排序「前缀相近优先,其次小写编辑距离」,取前 3。
 * 无可用工具时明确告知(而不是给空列表让模型瞎猜)。
 */
export function describeUnknownTool(name: string, available: string[]): UnknownToolSuggestion {
  const uniq = [...new Set(available.filter((n) => typeof n === "string" && n.length > 0))];
  if (uniq.length === 0) {
    return { code: "UNKNOWN_TOOL", message: `未知工具 ${name};可达:(当前无工具)`, reachableFrom: [] };
  }
  const lower = name.toLowerCase();
  const ranked = uniq
    .map((candidate) => {
      const prefixRank = candidate.startsWith(name) || name.startsWith(candidate) ? 0 : 1;
      return { candidate, prefixRank, distance: levenshtein(lower, candidate.toLowerCase()) };
    })
    .sort((a, b) => (a.prefixRank - b.prefixRank) || (a.distance - b.distance) || a.candidate.localeCompare(b.candidate));
  const top = ranked.slice(0, 3).map((r) => r.candidate);
  return { code: "UNKNOWN_TOOL", message: `未知工具 ${name};可达:${top.join(", ")}`, reachableFrom: top };
}
