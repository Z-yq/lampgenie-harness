/**
 * 任务档案(Task Profile)纯逻辑 #:按任务类别解析一份「装配策略」,并把策略应用到
 * 工具面/步数/技能/模型四个面。**零 IO、不 throw、不可变、确定性**——读写档案由
 * gateway 的 task-profile-store 负责,本模块只做判断。
 * 为什么需要档案:同一套 harness 对 coding / office / qa 三类任务该用不同的工具白名单、
 * 步数上限、技能子集与模型档位;这些差异现在散落在提示词与人工约定里,既不可审计也不可
 * 按任务覆盖。档案把「这类任务该装配成什么样」变成一条可命名、可回放、可显式指定的记录。
 * 稳定码(PROFILE_CODES):
 * - OK 解析成功且命中唯一档案;
 * - INVALID 选中的档案自身不合法(校验 issues 非空)——fail-closed,调用方回退默认;
 * - NOT_FOUND 显式 profileId 不存在——fail-closed,不回退到 taskClass 猜测;
 * - NO_MATCH taskClass 与 "*" 都没有匹配;
 * - CONFLICT 同一匹配键命中多份档案,按 updatedAt 取最新并在 reason 里点名(不静默丢弃)。
 * 应用语义(applyProfile):
 * - tools:deny 优先(先删 deny),allow 非空即白名单(再取交);不新增 base 里没有的工具,
 * allow 里点名但 base 没有的记进 ignored;输出保持 base 原顺序。
 * - maxSteps:档案值覆盖 base。
 * - skills:allow 非空 → 过滤 base(保持原顺序);base 缺失时记 ignored 不臆造。
 * - model:档案 model 覆盖 base。
 * - presetRevision:只记录,不参与装配。
 * 返回 { base(深拷贝), applied(实际生效项), ignored(点名但无法生效的项) }。
 */

/** 档案协议稳定码(字面量公开契约,store / CLI / 装配侧按此断言)。 */
export const PROFILE_CODES = {
  OK: "PROFILE_OK",
  INVALID: "PROFILE_INVALID",
  NOT_FOUND: "PROFILE_NOT_FOUND",
  NO_MATCH: "PROFILE_NO_MATCH",
  CONFLICT: "PROFILE_CONFLICT",
} as const;

export type ProfileCode = (typeof PROFILE_CODES)[keyof typeof PROFILE_CODES];

/** 档案可适配的任务类别;"*" = 任意类别的兜底档案。 */
export const PROFILE_TASK_CLASSES = ["coding", "office", "qa", "*"] as const;
export type ProfileTaskClass = (typeof PROFILE_TASK_CLASSES)[number];

/** maxSteps 合法区间(与主 loop 的上限口径同源:1..3000)。 */
export const PROFILE_MAX_STEPS_MIN = 1;
export const PROFILE_MAX_STEPS_MAX = 3000;

/** 档案 id 的 slug 约束:小写字母/数字开头,允许 . _ -,长度 1..64。 */
export const PROFILE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** 模型选择面(与 gateway 的 SessionModelOverride 同形,便于直接派生 provider)。 */
export interface TaskProfileModel {
  providerId?: string;
  model: string;
  effort?: string;
}

/** 工具面开关:allow 非空即白名单;deny 恒优先。 */
export interface TaskProfileTools {
  allow?: string[];
  deny?: string[];
}

/** 技能面:allow 非空即白名单(名称支持 `name` 与 `category/name`)。 */
export interface TaskProfileSkills {
  allow?: string[];
}

/** 一条任务档案。updatedAt 只在冲突消解时使用(毫秒时间戳,缺省=0)。 */
export interface TaskProfile {
  id: string;
  name?: string;
  taskClass: ProfileTaskClass;
  model?: TaskProfileModel;
  tools?: TaskProfileTools;
  maxSteps?: number;
  skills?: TaskProfileSkills;
  presetRevision?: string;
  description?: string;
 /** 最后写入时刻(毫秒);冲突时按它取最新,相同则取数组中靠后者。 */
  updatedAt?: number;
}

/** 校验问题(空数组 = 合法)。 */
export interface ProfileIssue {
  code: string;
  field: string;
  message: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/** 校验单份档案(入参可为 unknown:落盘文件里的条目同样走这里)。返回 issues[],空=合法。 */
export function validateProfile(input: unknown): ProfileIssue[] {
  const issues: ProfileIssue[] = [];
  if (!isRecord(input)) {
    return [{ code: PROFILE_CODES.INVALID, field: "", message: "档案必须是对象" }];
  }
  const p = input as Partial<TaskProfile>;
  if (!isNonEmptyString(p.id)) {
    issues.push({ code: PROFILE_CODES.INVALID, field: "id", message: "id 必须是非空字符串" });
  } else if (!PROFILE_ID_RE.test(p.id)) {
    issues.push({ code: PROFILE_CODES.INVALID, field: "id", message: `id 必须是 slug(小写字母/数字开头,允许 . _ -,≤64):${p.id}` });
  }
  if (!PROFILE_TASK_CLASSES.includes(p.taskClass as ProfileTaskClass)) {
    issues.push({ code: PROFILE_CODES.INVALID, field: "taskClass", message: `taskClass 必须是 ${PROFILE_TASK_CLASSES.join("/")} 之一` });
  }
  if (p.name !== undefined && typeof p.name !== "string") {
    issues.push({ code: PROFILE_CODES.INVALID, field: "name", message: "name 必须是字符串" });
  }
  if (p.description !== undefined && typeof p.description !== "string") {
    issues.push({ code: PROFILE_CODES.INVALID, field: "description", message: "description 必须是字符串" });
  }
  if (p.presetRevision !== undefined && typeof p.presetRevision !== "string") {
    issues.push({ code: PROFILE_CODES.INVALID, field: "presetRevision", message: "presetRevision 必须是字符串" });
  }
  if (p.updatedAt !== undefined && !(typeof p.updatedAt === "number" && Number.isFinite(p.updatedAt))) {
    issues.push({ code: PROFILE_CODES.INVALID, field: "updatedAt", message: "updatedAt 必须是有限数字" });
  }
 // model:有的话 model.model 必填非空;providerId/effort 出现即须字符串。
  if (p.model !== undefined) {
    if (!isRecord(p.model)) {
      issues.push({ code: PROFILE_CODES.INVALID, field: "model", message: "model 必须是对象" });
    } else {
      const m = p.model as Partial<TaskProfileModel>;
      if (!isNonEmptyString(m.model)) {
        issues.push({ code: PROFILE_CODES.INVALID, field: "model.model", message: "model.model 必须是非空字符串" });
      }
      if (m.providerId !== undefined && typeof m.providerId !== "string") {
        issues.push({ code: PROFILE_CODES.INVALID, field: "model.providerId", message: "model.providerId 必须是字符串" });
      }
      if (m.effort !== undefined && typeof m.effort !== "string") {
        issues.push({ code: PROFILE_CODES.INVALID, field: "model.effort", message: "model.effort 必须是字符串" });
      }
    }
  }
 // tools:allow/deny 必须是字符串数组且去重后不重叠(deny 优先,不重叠才能让白名单语义清晰)。
  const allowTools = validStringList(p.tools?.allow, "tools.allow", issues);
  const denyTools = validStringList(p.tools?.deny, "tools.deny", issues);
  if (allowTools && denyTools) {
    const denySet = new Set(denyTools);
    const overlap = allowTools.filter((t) => denySet.has(t));
    if (overlap.length > 0) {
      issues.push({ code: PROFILE_CODES.INVALID, field: "tools", message: `allow/deny 不允许重叠:${overlap.join(",")}` });
    }
  }
  if (p.tools !== undefined && !isRecord(p.tools)) {
    issues.push({ code: PROFILE_CODES.INVALID, field: "tools", message: "tools 必须是对象" });
  }
 // skills:allow 字符串去重(重复会让「白名单命中次数」失真,直接判不合法)。
  if (p.skills !== undefined) {
    if (!isRecord(p.skills)) {
      issues.push({ code: PROFILE_CODES.INVALID, field: "skills", message: "skills 必须是对象" });
    } else {
      const list = validStringList((p.skills as Partial<TaskProfileSkills>).allow, "skills.allow", issues);
      if (list) {
        const dup = list.filter((v, i) => list.indexOf(v) !== i);
        if (dup.length > 0) {
          issues.push({ code: PROFILE_CODES.INVALID, field: "skills.allow", message: `skills.allow 存在重复项:${[...new Set(dup)].join(",")}` });
        }
      }
    }
  }
  if (p.maxSteps !== undefined) {
    const n = p.maxSteps;
    if (typeof n !== "number" || !Number.isInteger(n) || n < PROFILE_MAX_STEPS_MIN || n > PROFILE_MAX_STEPS_MAX) {
      issues.push({
        code: PROFILE_CODES.INVALID,
        field: "maxSteps",
        message: `maxSteps 必须是 ${PROFILE_MAX_STEPS_MIN}..${PROFILE_MAX_STEPS_MAX} 的整数`,
      });
    }
  }
  return issues;
}

/** 校验一个字符串数组字段(缺省=undefined 合法;返回原始列表供上层判重)。 */
function validStringList(v: unknown, field: string, issues: ProfileIssue[]): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    issues.push({ code: PROFILE_CODES.INVALID, field, message: `${field} 必须是字符串数组` });
    return undefined;
  }
  const out: string[] = [];
  for (const item of v) {
    if (!isNonEmptyString(item)) {
      issues.push({ code: PROFILE_CODES.INVALID, field, message: `${field} 含非字符串/空项` });
      continue;
    }
    out.push(item);
  }
  return out;
}

/** 解析输入。 */
export interface ResolveTaskProfileInput {
 /** 当前任务类别(coding/office/qa;未知类别只会命中 "*")。 */
  taskClass: string;
 /** 显式档案 id(优先级最高;不存在=NOT_FOUND,不回退猜测)。 */
  profileId?: string;
}

/** 解析结果。ok=true 时 profile 必有值(含 CONFLICT 的胜出者)。 */
export interface ResolveTaskProfileResult {
  ok: boolean;
  code: ProfileCode;
  profile?: TaskProfile;
  reason?: string;
 /** 选中档案的校验问题(OK 时为空;INVALID 时非空)。 */
  issues?: ProfileIssue[];
}

/** 比较两份档案谁「更新」:updatedAt 大的新;相同时取数组中靠后者(稳定且确定)。 */
function newerThan(a: { profile: TaskProfile; index: number }, b: { profile: TaskProfile; index: number }): boolean {
  const ua = typeof a.profile.updatedAt === "number" ? a.profile.updatedAt : 0;
  const ub = typeof b.profile.updatedAt === "number" ? b.profile.updatedAt : 0;
  if (ua !== ub) return ua > ub;
  return a.index > b.index;
}

/** 从候选里挑最新的一份;多份时返回 reason。 */
function pickLatest(candidates: TaskProfile[]): { picked: TaskProfile; conflict: boolean; reason?: string } {
  const indexed = candidates.map((profile, index) => ({ profile, index }));
  let best = indexed[0]!;
  for (const item of indexed.slice(1)) {
    if (newerThan(item, best)) best = item;
  }
  const conflict = indexed.length > 1;
  return {
    picked: best.profile,
    conflict,
    ...(conflict
      ? { reason: `同一匹配命中 ${indexed.length} 份档案(${indexed.map((x) => x.profile.id).join(",")}),按 updatedAt 取最新 ${best.profile.id}` }
      : {}),
  };
}

/**
 * 解析档案:
 * 1) 显式 profileId 存在 → 用它(同 id 多份=CONFLICT 取最新);不存在=NOT_FOUND;
 * 2) 否则 taskClass 精确匹配;无 → "*";再无 → NO_MATCH;
 * 3) 同键多份=CONFLICT,按 updatedAt 取最新并记 reason;
 * 4) 选中档案校验不过=INVALID(fail-closed,不应用半份档案)。
 */
export function resolveTaskProfile(
  profiles: readonly TaskProfile[],
  input: ResolveTaskProfileInput): ResolveTaskProfileResult {
  const list = Array.isArray(profiles) ? profiles.filter((p) => isRecord(p) && typeof p.id === "string") : [];
  let candidates: TaskProfile[];
  let conflict = false;
  let reason: string | undefined;
  if (isNonEmptyString(input.profileId)) {
    candidates = list.filter((p) => p.id === input.profileId);
    if (candidates.length === 0) {
      return { ok: false, code: PROFILE_CODES.NOT_FOUND, reason: `显式档案不存在:${input.profileId}` };
    }
  } else {
    const cls = typeof input.taskClass === "string" ? input.taskClass : "";
    candidates = list.filter((p) => p.taskClass === cls);
    if (candidates.length === 0) candidates = list.filter((p) => p.taskClass === "*");
    if (candidates.length === 0) {
      return { ok: false, code: PROFILE_CODES.NO_MATCH, reason: `无匹配档案:taskClass=${cls} 且无 "*" 兜底` };
    }
  }
  if (candidates.length > 1) {
    const picked = pickLatest(candidates);
    conflict = picked.conflict;
    reason = picked.reason;
    candidates = [picked.picked];
  }
  const profile = candidates[0]!;
  const issues = validateProfile(profile);
  if (issues.length > 0) {
    return { ok: false, code: PROFILE_CODES.INVALID, profile, issues, reason: issues.map((i) => i.message).join(";") };
  }
  return conflict
    ? { ok: true, code: PROFILE_CODES.CONFLICT, profile, reason }
    : { ok: true, code: PROFILE_CODES.OK, profile };
}

/** 应用前的装配基线(只读;函数内部深拷贝后使用)。 */
export interface ProfileBase {
  tools?: string[];
  maxSteps?: number;
  skills?: string[];
  model?: TaskProfileModel;
}

/** 实际生效的项(只含真被档案改写的字段)。 */
export interface AppliedProfile {
 /** 过滤后的工具名(仅当 base.tools 与 profile.tools 同时存在)。 */
  tools?: string[];
  toolsAllow?: string[];
  toolsDeny?: string[];
  maxSteps?: number;
 /** 过滤后的技能名(仅当 base.skills 与 skills.allow 同时存在)。 */
  skills?: string[];
  model?: TaskProfileModel;
  presetRevision?: string;
}

/** 应用结果:base 为深拷贝(调用方原对象不被修改),ignored 为点名但无法生效的项。 */
export interface ApplyProfileResult {
  base: ProfileBase;
  applied: AppliedProfile;
  ignored: string[];
}

function copyModel(m: TaskProfileModel | undefined): TaskProfileModel | undefined {
  if (!m) return undefined;
  return {
    model: m.model,
    ...(m.providerId !== undefined ? { providerId: m.providerId } : {}),
    ...(m.effort !== undefined ? { effort: m.effort } : {}),
  };
}

/** 去重且保持首次出现顺序(防御性:校验已拦重复,但 apply 可能收到未校验对象)。 */
function uniq(list: readonly string[] | undefined): string[] {
  if (!list) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== "string" || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * 把档案应用到装配基线。纯函数:不修改入参,返回深拷贝的 base + applied + ignored。
 * 语义见文件头「应用语义」。不 throw——畸形档案按「没有该项」处理。
 */
export function applyProfile(base: ProfileBase, profile: TaskProfile): ApplyProfileResult {
  const copy: ProfileBase = {
    ...(base.tools !== undefined ? { tools: [...base.tools] } : {}),
    ...(base.maxSteps !== undefined ? { maxSteps: base.maxSteps } : {}),
    ...(base.skills !== undefined ? { skills: [...base.skills] } : {}),
    ...(base.model !== undefined ? { model: copyModel(base.model) } : {}),
  };
  const applied: AppliedProfile = {};
  const ignored: string[] = [];
  const tools = profile.tools;
  if (tools && (tools.allow !== undefined || tools.deny !== undefined)) {
    const allow = uniq(tools.allow);
    const deny = uniq(tools.deny);
    const denySet = new Set(deny);
    const allowSet = allow.length > 0 ? new Set(allow) : null;
    if (copy.tools === undefined) {
      ignored.push("tools:base-missing");
    } else {
      const baseSet = new Set(copy.tools);
      for (const a of allow) if (!baseSet.has(a)) ignored.push(`tools.allow:${a}`);
 // deny 优先:即使同时出现在 allow 里也删(校验层已拦重叠,这里防御未校验对象)。
      const kept = copy.tools.filter((t) => !denySet.has(t) && (allowSet === null || allowSet.has(t)));
      applied.tools = kept;
    }
    if (allow.length > 0) applied.toolsAllow = allow;
    if (deny.length > 0) applied.toolsDeny = deny;
  }
  if (typeof profile.maxSteps === "number" && Number.isInteger(profile.maxSteps) && profile.maxSteps >= PROFILE_MAX_STEPS_MIN && profile.maxSteps <= PROFILE_MAX_STEPS_MAX) {
    applied.maxSteps = profile.maxSteps;
  }
  const skillAllow = uniq(profile.skills?.allow);
  if (skillAllow.length > 0) {
    if (copy.skills === undefined) {
      ignored.push("skills:base-missing");
    } else {
      const baseSet = new Set(copy.skills);
      for (const s of skillAllow) if (!baseSet.has(s)) ignored.push(`skills.allow:${s}`);
      applied.skills = copy.skills.filter((s) => skillAllow.includes(s));
    }
  }
  const model = copyModel(profile.model);
  if (model) applied.model = model;
  if (typeof profile.presetRevision === "string") applied.presetRevision = profile.presetRevision;
  return { base: copy, applied, ignored };
}
