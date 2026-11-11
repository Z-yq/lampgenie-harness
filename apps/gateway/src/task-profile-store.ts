/**
 * 任务档案持久层(gateway 侧)#:把 task-profile 的纯逻辑落到 `<root>/.genie/task-profiles.json`。
 * 为什么必须是可审计的落盘文件:档案决定「某类任务用哪些工具/多少步/哪个模型」,它的变更
 * 与解析结果都要能回放(谁在什么时候把 coding 的 maxSteps 从 120 改成 80)。因此:
 * - 写盘原子(写 tmp 再 rename),写后重读比对——「写成功了吗」是可复核断言,不是默认真理;
 * - 坏 JSON / 坏条目 fail-closed:坏 JSON 整文件判 INVALID(不再猜测内容),坏条目被剔除并
 * 计入 parseErrors,读侧拿到的永远是「能安全应用」的子集。
 * 依赖纪律:node:fs / node:path;runtime 纯逻辑按仓内既有套路两跳惰性解析:
 * ① 带 `--conditions=development` 的运行时(vitest)走包导出 src 入口;
 * ② 裸 tsx / dist 缺该文件时回退到仓内源文件(new URL,避免静态 .ts specifier 触发 TS5097)。
 * 不静态 import runtime 的 task-profile:gateway 的 tsc 走 runtime dist,新文件未 build 会 TS2307。
 * 除参数错误外不 throw:IO/校验失败一律折叠成稳定码。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ApplyProfileResult,
  ProfileBase,
  ProfileIssue,
  ResolveTaskProfileInput,
  ResolveTaskProfileResult,
  TaskProfile,
} from "@lampgenie/runtime/agent/task-profile";

/** store 层自产失败码(runtime 码沿用 PROFILE_* 字面量,见 runtime 模块)。 */
export const TASK_PROFILE_STORE_CODES = [
  "TASK_PROFILE_STORE_ERROR",
  "TASK_PROFILE_WRITE_VERIFY_FAILED",
] as const;

export type TaskProfileStoreCode = (typeof TASK_PROFILE_STORE_CODES)[number];

/** 落盘 schema 版本:字段语义变化时递增。 */
export const TASK_PROFILES_VERSION = 1;

/** 文件形状:{ v, profiles }。对外导出供测试/CLI 断言(schema 是公开契约)。 */
export interface TaskProfilesFileLike {
  v: number;
  profiles: TaskProfile[];
}

type TaskProfilesFile = TaskProfilesFileLike;

/** runtime 面(惰性解析,见文件头依赖纪律)。 */
interface ProfileRuntime {
  validateProfile(input: unknown): ProfileIssue[];
  resolveTaskProfile(profiles: readonly TaskProfile[], input: ResolveTaskProfileInput): ResolveTaskProfileResult;
  applyProfile(base: ProfileBase, profile: TaskProfile): ApplyProfileResult;
}

let profileRuntime: ProfileRuntime | undefined;

/** 两跳解析 runtime 模块(见文件头依赖纪律)。 */
async function loadProfileRuntime(): Promise<ProfileRuntime> {
  if (profileRuntime) return profileRuntime;
  const spec = "@lampgenie/runtime/agent/task-profile";
  try {
    profileRuntime = (await import(spec)) as ProfileRuntime;
  } catch {
    const srcUrl = new URL("../../../packages/harness-runtime/src/agent/task-profile.ts", import.meta.url).href;
    profileRuntime = (await import(srcUrl)) as ProfileRuntime;
  }
  return profileRuntime;
}

/** 档案文件路径:`<root>/.genie/task-profiles.json`。 */
export function taskProfilesPath(root: string): string {
  return join(root, ".genie", "task-profiles.json");
}

/** 原子写:先写 `<file>.tmp-<pid>-<rand>` 再 rename;写后重读比对。 */
function writeAtomic(file: string, content: string): { ok: boolean; code?: string; reason?: string } {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, file);
  } catch (error) {
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true });
    } catch {
 /* 清理失败不掩盖原始错误 */
    }
    return { ok: false, code: "TASK_PROFILE_STORE_ERROR", reason: `写 ${file} 失败:${String((error as { code?: string }).code ?? error)}` };
  }
  try {
    if (readFileSync(file, "utf8") !== content) {
      return { ok: false, code: "TASK_PROFILE_WRITE_VERIFY_FAILED", reason: `写后重读不一致:${file}` };
    }
  } catch (error) {
    return {
      ok: false,
      code: "TASK_PROFILE_WRITE_VERIFY_FAILED",
      reason: `写后重读失败:${String((error as { code?: string }).code ?? error)}`,
    };
  }
  return { ok: true };
}

/** 读取结果。code:PROFILE_OK / PROFILE_INVALID / TASK_PROFILE_STORE_ERROR。 */
export interface TaskProfilesLoad {
  ok: boolean;
  code: string;
  profiles: TaskProfile[];
 /** 坏形状/坏条目计数(坏 JSON 记 1)。 */
  parseErrors: number;
  path: string;
  error?: string;
 /** 被剔除条目的校验问题(带 index)。 */
  issues?: Array<ProfileIssue & { index: number }>;
}

/** 读档案文件。缺失=空表(合法);坏 JSON/坏形状=INVALID(不猜测);坏条目剔除并计数。 */
export async function loadTaskProfiles(root: string): Promise<TaskProfilesLoad> {
  const path = taskProfilesPath(root);
  const rt = await loadProfileRuntime();
  if (!existsSync(path)) {
    return { ok: true, code: "PROFILE_OK", profiles: [], parseErrors: 0, path };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return {
      ok: false,
      code: "TASK_PROFILE_STORE_ERROR",
      profiles: [],
      parseErrors: 0,
      path,
      error: String((error as { code?: string }).code ?? error),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, code: "PROFILE_INVALID", profiles: [], parseErrors: 1, path, error: `JSON 解析失败:${String(error).slice(0, 160)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, code: "PROFILE_INVALID", profiles: [], parseErrors: 1, path, error: "文件顶层必须是对象" };
  }
  const file = parsed as Partial<TaskProfilesFile>;
  if (!Array.isArray(file.profiles)) {
    return { ok: false, code: "PROFILE_INVALID", profiles: [], parseErrors: 1, path, error: "profiles 必须是数组" };
  }
  const profiles: TaskProfile[] = [];
  const issues: Array<ProfileIssue & { index: number }> = [];
  let parseErrors = file.v === TASK_PROFILES_VERSION ? 0 : 1;
  file.profiles.forEach((entry, index) => {
    const entryIssues = rt.validateProfile(entry);
    if (entryIssues.length === 0) {
      profiles.push(entry as TaskProfile);
    } else {
      parseErrors += 1;
      for (const issue of entryIssues) issues.push({ ...issue, index });
    }
  });
  return { ok: true, code: "PROFILE_OK", profiles, parseErrors, path, ...(issues.length > 0 ? { issues } : {}) };
}

/** 写盘结果。 */
export interface TaskProfilesWrite {
  ok: boolean;
  code: string;
  path?: string;
  reason?: string;
  issues?: ProfileIssue[];
}

/** 全量落盘(先整体校验,任何一份非法即拒绝写:不做半份覆盖)。 */
export async function saveTaskProfiles(root: string, profiles: readonly TaskProfile[]): Promise<TaskProfilesWrite> {
  const rt = await loadProfileRuntime();
  const path = taskProfilesPath(root);
  if (!Array.isArray(profiles)) {
    return { ok: false, code: "PROFILE_INVALID", reason: "profiles 必须是数组" };
  }
  const issues: ProfileIssue[] = [];
  for (const p of profiles) issues.push(...rt.validateProfile(p));
  if (issues.length > 0) return { ok: false, code: "PROFILE_INVALID", issues, path };
  const file: TaskProfilesFile = { v: TASK_PROFILES_VERSION, profiles: profiles.map((p) => ({ ...p })) };
  const written = writeAtomic(path, JSON.stringify(file, null, 2) + "\n");
  if (!written.ok) return { ok: false, code: written.code ?? "TASK_PROFILE_STORE_ERROR", path, reason: written.reason };
  return { ok: true, code: "PROFILE_OK", path };
}

/** 新增档案(create-only:同 id 已存在=CONFLICT,不隐式覆盖)。 */
export async function addTaskProfile(
  root: string,
  profile: TaskProfile,
  opts?: { now?: number },
): Promise<{ ok: boolean; code: string; profile?: TaskProfile; issues?: ProfileIssue[]; reason?: string; path?: string }> {
  const rt = await loadProfileRuntime();
  const issues = rt.validateProfile(profile);
  if (issues.length > 0) return { ok: false, code: "PROFILE_INVALID", issues, path: taskProfilesPath(root) };
  const loaded = await loadTaskProfiles(root);
  if (!loaded.ok) return { ok: false, code: loaded.code, reason: loaded.error, path: loaded.path };
  if (loaded.profiles.some((p) => p.id === profile.id)) {
    return { ok: false, code: "PROFILE_CONFLICT", reason: `档案已存在:${profile.id}(create-only,不隐式覆盖)`, path: loaded.path };
  }
  const entry: TaskProfile = {
    ...profile,
    updatedAt: typeof opts?.now === "number" ? opts.now : typeof profile.updatedAt === "number" ? profile.updatedAt : Date.now(),
  };
  const saved = await saveTaskProfiles(root, [...loaded.profiles, entry]);
  if (!saved.ok) return { ok: false, code: saved.code, issues: saved.issues, reason: saved.reason, path: saved.path };
  return { ok: true, code: "PROFILE_OK", profile: entry, path: saved.path };
}

/** 删除档案;不存在=NOT_FOUND。 */
export async function removeTaskProfile(root: string, id: string): Promise<{ ok: boolean; code: string; removed?: TaskProfile; path?: string; reason?: string }> {
  const loaded = await loadTaskProfiles(root);
  if (!loaded.ok) return { ok: false, code: loaded.code, reason: loaded.error, path: loaded.path };
  const hit = loaded.profiles.find((p) => p.id === id);
  if (!hit) return { ok: false, code: "PROFILE_NOT_FOUND", reason: `档案不存在:${id}`, path: loaded.path };
  const saved = await saveTaskProfiles(root, loaded.profiles.filter((p) => p.id !== id));
  if (!saved.ok) return { ok: false, code: saved.code, reason: saved.reason, path: saved.path };
  return { ok: true, code: "PROFILE_OK", removed: hit, path: saved.path };
}

/** 列表(读侧容错:坏条目剔除后仍返回可用的那部分)。 */
export async function listTaskProfiles(
  root: string): Promise<{ ok: boolean; code: string; profiles: TaskProfile[]; count: number; parseErrors: number; path: string; error?: string }> {
  const loaded = await loadTaskProfiles(root);
  return {
    ok: loaded.ok,
    code: loaded.code,
    profiles: loaded.profiles,
    count: loaded.profiles.length,
    parseErrors: loaded.parseErrors,
    path: loaded.path,
    ...(loaded.error ? { error: loaded.error } : {}),
  };
}

/** 单条查看。 */
export async function showTaskProfile(root: string, id: string): Promise<{ ok: boolean; code: string; profile?: TaskProfile; path: string; reason?: string }> {
  const loaded = await loadTaskProfiles(root);
  if (!loaded.ok) return { ok: false, code: loaded.code, path: loaded.path, reason: loaded.error };
  const hit = loaded.profiles.find((p) => p.id === id);
  if (!hit) return { ok: false, code: "PROFILE_NOT_FOUND", path: loaded.path, reason: `档案不存在:${id}` };
  return { ok: true, code: "PROFILE_OK", profile: hit, path: loaded.path };
}

/** 按 (taskClass, profileId?) 解析。坏文件=PROFILE_INVALID(fail-closed,不猜测)。 */
export async function resolveTaskProfileAt(
  root: string,
  input: ResolveTaskProfileInput): Promise<ResolveTaskProfileResult & { path?: string }> {
  const loaded = await loadTaskProfiles(root);
  const path = loaded.path;
  if (!loaded.ok) {
    return { ok: false, code: "PROFILE_INVALID", reason: loaded.error ?? "档案文件不可用", path };
  }
  const rt = await loadProfileRuntime();
  return { ...rt.resolveTaskProfile(loaded.profiles, input), path };
}

/** 应用档案(供装配侧/CLI 复用同一份纯逻辑;profile 未校验时由调用方决定是否先校验)。 */
export async function applyTaskProfile(base: ProfileBase, profile: TaskProfile): Promise<ApplyProfileResult> {
  const rt = await loadProfileRuntime();
  return rt.applyProfile(base, profile);
}

/** 报告(可审计计数;byTaskClass 固定四键,缺省 0)。 */
export interface TaskProfilesReport {
  ok: boolean;
  code: string;
  path: string;
  total: number;
  byTaskClass: Record<string, number>;
 /** 有 model / tools / skills / maxSteps / presetRevision 的档案数。 */
  with: { model: number; tools: number; skills: number; maxSteps: number; presetRevision: number };
  latestUpdatedAt?: number;
  parseErrors: number;
  error?: string;
}

/** 汇总报告。 */
export async function reportTaskProfiles(root: string): Promise<TaskProfilesReport> {
  const loaded = await loadTaskProfiles(root);
  const byTaskClass: Record<string, number> = { coding: 0, office: 0, qa: 0, "*": 0 };
  const withCounts = { model: 0, tools: 0, skills: 0, maxSteps: 0, presetRevision: 0 };
  let latest: number | undefined;
  for (const p of loaded.profiles) {
    byTaskClass[p.taskClass] = (byTaskClass[p.taskClass] ?? 0) + 1;
    if (p.model) withCounts.model += 1;
    if (p.tools) withCounts.tools += 1;
    if (p.skills) withCounts.skills += 1;
    if (typeof p.maxSteps === "number") withCounts.maxSteps += 1;
    if (typeof p.presetRevision === "string") withCounts.presetRevision += 1;
    if (typeof p.updatedAt === "number" && (latest === undefined || p.updatedAt > latest)) latest = p.updatedAt;
  }
  return {
    ok: loaded.ok,
    code: loaded.code,
    path: loaded.path,
    total: loaded.profiles.length,
    byTaskClass,
    with: withCounts,
    ...(latest !== undefined ? { latestUpdatedAt: latest } : {}),
    parseErrors: loaded.parseErrors,
    ...(loaded.error ? { error: loaded.error } : {}),
  };
}
