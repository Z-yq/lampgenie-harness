/**
 * 权限预设(M180「权限预设原子绑定与会话钉扎」):预设名 → 权限集合的**唯一真源**。
 *
 * 语义:
 * - 权限不再只是一个 mode 枚举,而是三旋钮 (sandbox, approval, mode) 的组合;预设名是它的紧凑名字。
 * - `PRESETS` 是静态表(纯数据);`custom`/`auto` 是**保留名**,不是表行:
 *   · `custom` = 用户在面板自由调的旋钮组合(不可作为表行,客户端不可覆盖表行);
 *   · `auto`   = 启动缺省别名,解析为 `defaultPreset`(缺省 workspace-write)。
 * - `defaultPreset ?? preset ?? "workspace-write"` 决定启动口径;非法名字 **fail-closed**(抛
 *   UnknownPresetError),绝不静默降级成 ask(权限放宽必须是用户显式动作)。
 * - 会话钉扎(pin):任务开工时把当时的全局预设落成本会话快照;此后全局漂移不影响已开工会话。
 * - 子代理:恒 approval=never(免审),sandbox 继承父 pin。
 *
 * 本模块是纯函数 + 一个进程内「当前预设名」状态(启动 set、cfg.set 成功后 set、开工读取);
 * 不做 IO(唯一副作用是 pinSession 写 journal,由调用方注入)。
 */
import type { Journal } from "@lampgenie/core";
import { permissionMode, type PermissionMode } from "./permission-mode.js";

export type { PermissionMode };

/** 沙箱口径:full=无围栏;workspace=只允许项目目录内读写;readonly=一律不写。 */
export type Sandbox = "full" | "workspace" | "readonly";
/** 审批口径:never=不弹审批直接放行;on-request=命中规则时面板在线征求;plan=规划态(只读)。 */
export type Approval = "never" | "on-request" | "plan";

/** 预设表行(纯数据,不可写)。 */
export interface PresetSpec {
  sandbox: Sandbox;
  approval: Approval;
  mode: PermissionMode;
}

/** 保留名:custom=自定义组合(非表行,客户端不可覆盖);auto=启动缺省别名。 */
export const CUSTOM_PRESET = "custom";
export const AUTO_PRESET = "auto";
/** 未配置 preset/defaultPreset 时的启动缺省。 */
export const DEFAULT_STARTUP_PRESET = "workspace-write";

/** 五档预设(静态表;`Object.freeze` 防止运行期被误改)。 */
export const PRESETS: Readonly<Record<string, PresetSpec>> = Object.freeze({
  "full-access": { sandbox: "full", approval: "never", mode: "auto" },
  "workspace-write": { sandbox: "workspace", approval: "on-request", mode: "workspace" },
  ask: { sandbox: "full", approval: "on-request", mode: "ask" },
  "read-only": { sandbox: "readonly", approval: "never", mode: "readonly" },
  plan: { sandbox: "readonly", approval: "plan", mode: "plan" },
});

export const PRESET_NAMES: readonly string[] = Object.freeze(Object.keys(PRESETS));

/** 非法/未知预设名(fail-closed 出口;启动与 cfg.set 两个入口共用)。 */
export class UnknownPresetError extends Error {
  readonly code = "UNKNOWN_PRESET" as const;
  readonly preset: string;
  constructor(preset: unknown) {
    const shown = typeof preset === "string" ? preset : String(preset);
    super(`未知权限预设 "${shown}"(可用:${PRESET_NAMES.join(" / ")};保留名 ${CUSTOM_PRESET}/${AUTO_PRESET})`);
    this.name = "UnknownPresetError";
    this.preset = shown;
  }
}

function normalizeName(name: unknown): string {
  return typeof name === "string" ? name.trim() : "";
}

/** 解析后的预设:`custom=true` 时三旋钮由调用方现状决定,故不带旋钮。 */
export type ResolvedPreset =
  | { custom: true; preset: string }
  | { custom: false; preset: string; sandbox: Sandbox; approval: Approval; mode: PermissionMode };

/** 预设名 → 权限集合。custom→{custom:true};auto→递归解析 defaultPreset;未知/空→抛。 */
export function resolvePreset(name: string | undefined | null, defaultPreset: string = DEFAULT_STARTUP_PRESET): ResolvedPreset {
  const n = normalizeName(name);
  if (!n) throw new UnknownPresetError(name ?? "");
  if (n === CUSTOM_PRESET) return { custom: true, preset: CUSTOM_PRESET };
  if (n === AUTO_PRESET) {
    // auto=启动缺省别名:解析为 defaultPreset;defaultPreset 也是 auto(自指)→ 收敛到内置缺省,不死循环。
    const fallback = normalizeName(defaultPreset);
    if (!fallback || fallback === AUTO_PRESET) return resolvePreset(DEFAULT_STARTUP_PRESET, DEFAULT_STARTUP_PRESET);
    return resolvePreset(fallback, fallback);
  }
  const row = PRESETS[n];
  if (!row) throw new UnknownPresetError(n);
  return { custom: false, preset: n, sandbox: row.sandbox, approval: row.approval, mode: row.mode };
}

/** 旋钮投影回预设名(反向映射):命中表内某行→该行名,否则 custom。 */
export function foldProjection(knobs: { sandbox?: string; approval?: string }): string {
  const sandbox = normalizeName(knobs?.sandbox);
  const approval = normalizeName(knobs?.approval);
  if (!sandbox || !approval) return CUSTOM_PRESET;
  for (const name of PRESET_NAMES) {
    const row = PRESETS[name]!;
    if (row.sandbox === sandbox && row.approval === approval) return name;
  }
  return CUSTOM_PRESET;
}

/** 旋钮三元组(apply/pin 的公共入参)。 */
export interface PermissionKnobs {
  preset: string;
  sandbox: Sandbox;
  approval: Approval;
  mode: PermissionMode;
}

export type PresetKnob = "sandbox" | "approval" | "mode";

/**
 * 非 custom 预设的 sandbox/approval(custom 用 ask 口径兜底:custom 的真实旋钮由调用方现状决定,
 * 这里是「没有现状可参考」时(如 pin 记录)的收敛值)。
 */
export function presetKnobsOf(name: string): { sandbox: Sandbox; approval: Approval } {
  const n = normalizeName(name);
  const row = n && n !== CUSTOM_PRESET && n !== AUTO_PRESET ? PRESETS[n] : undefined;
  return row ? { sandbox: row.sandbox, approval: row.approval } : { sandbox: "full", approval: "on-request" };
}

/**
 * 原子应用预设:算出 next 相对 current 的真实差异(applied=值真的变了的旋钮名),
 * custom 保留 current 三旋钮只把 preset 置成 custom。调用方按 applied 一次性落地=原子。
 */
export function applyPreset(current: PermissionKnobs, nextName: string): PermissionKnobs & { applied: PresetKnob[]; changed: boolean } {
  const n = normalizeName(nextName);
  if (!n) throw new UnknownPresetError(nextName);
  if (n === CUSTOM_PRESET) {
    return { ...current, preset: CUSTOM_PRESET, applied: [], changed: current.preset !== CUSTOM_PRESET };
  }
  const next = resolvePreset(n);
  if (next.custom) throw new UnknownPresetError(n); // 不可达(custom 已在上方返回)
  const applied: PresetKnob[] = [];
  if (next.sandbox !== current.sandbox) applied.push("sandbox");
  if (next.approval !== current.approval) applied.push("approval");
  if (next.mode !== current.mode) applied.push("mode");
  return {
    preset: next.preset,
    sandbox: next.sandbox,
    approval: next.approval,
    mode: next.mode,
    applied,
    changed: applied.length > 0 || current.preset !== next.preset,
  };
}

/** 会话权限钉扎记录(journal payload 形态)。 */
export interface SessionPermissionPin {
  preset: string;
  sandbox: Sandbox;
  approval: Approval;
  mode: PermissionMode;
  at: number;
}

const PIN_TYPE = "session.permission.pin";

/** 从 journal 找该会话已有的 pin(倒序取最近一条;非 custom 事件不认)。 */
function findPin(journal: Journal, sessionId: string): SessionPermissionPin | undefined {
  let events: ReturnType<Journal["readAll"]>;
  try {
    events = journal.readAll();
  } catch {
    return undefined;
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind !== "custom" || e.sessionId !== sessionId) continue;
    const payload = e.payload as (Partial<SessionPermissionPin> & { type?: string }) | null | undefined;
    if (!payload || payload.type !== PIN_TYPE) continue;
    return {
      preset: String(payload.preset ?? ""),
      sandbox: (payload.sandbox ?? "full") as Sandbox,
      approval: (payload.approval ?? "on-request") as Approval,
      mode: (payload.mode ?? "ask") as PermissionMode,
      at: Number(payload.at ?? 0),
    };
  }
  return undefined;
}

/**
 * 会话钉扎(幂等):已有本会话 pin → 原样返回且不写;否则落一条
 * {kind:"custom",sessionId,payload:{type:"session.permission.pin",preset,sandbox,approval,mode,at}}。
 */
export function pinSession(journal: Journal, sessionId: string, presetName: string): { pin: SessionPermissionPin; written: boolean } {
  const existing = findPin(journal, sessionId);
  if (existing) return { pin: existing, written: false };
  const n = normalizeName(presetName) || DEFAULT_STARTUP_PRESET;
  const resolved = resolvePreset(n); // 未知/空→抛(钉扎不许钉一个不存在的预设)
  const pin: SessionPermissionPin = resolved.custom
    ? { preset: CUSTOM_PRESET, sandbox: "full", approval: "on-request", mode: permissionMode(), at: Date.now() }
    : { preset: resolved.preset, sandbox: resolved.sandbox, approval: resolved.approval, mode: resolved.mode, at: Date.now() };
  journal.append({ kind: "custom", sessionId, payload: { type: PIN_TYPE, ...pin } });
  return { pin, written: true };
}

/** 会话生效权限:pin 优先(source=pin);无 pin 按 fallback 预设现算(source=default)。 */
export function resolveSessionPermission(
  journal: Journal,
  sessionId: string,
  fallbackPreset: string = DEFAULT_STARTUP_PRESET,
): SessionPermissionPin & { pinned: boolean; source: "pin" | "default" } {
  const pinned = findPin(journal, sessionId);
  if (pinned) return { ...pinned, pinned: true, source: "pin" };
  const n = normalizeName(fallbackPreset) || DEFAULT_STARTUP_PRESET;
  const resolved = resolvePreset(n);
  const knobs = resolved.custom
    ? { preset: CUSTOM_PRESET, sandbox: "full" as Sandbox, approval: "on-request" as Approval, mode: permissionMode() }
    : { preset: resolved.preset, sandbox: resolved.sandbox, approval: resolved.approval, mode: resolved.mode };
  return { ...knobs, at: 0, pinned: false, source: "default" };
}

/**
 * 续跑补种:只补 pin 里缺失(undefined/空串)的字段,已有值绝不覆盖(钉扎是快照,续跑不得改写)。
 */
export function seedResume(
  pin: SessionPermissionPin,
  durableFacts?: { sandbox?: string; approval?: string; mode?: string },
): { pin: SessionPermissionPin; filled: string[] } {
  const next: SessionPermissionPin = { ...pin };
  const filled: string[] = [];
  const fill = (key: "sandbox" | "approval" | "mode"): void => {
    const cur = normalizeName(next[key]);
    if (cur) return; // 已有值不覆盖
    const fact = normalizeName(durableFacts?.[key]);
    if (!fact) return;
    (next as unknown as Record<string, unknown>)[key] = fact;
    filled.push(key);
  };
  fill("sandbox");
  fill("approval");
  fill("mode");
  return { pin: next, filled };
}

/** 子代理权限:恒 approval=never(免审),sandbox 继承父 pin(无 pin=full)。 */
export function childPermission(parentPin?: { sandbox?: string } | null): { approval: Approval; sandbox: Sandbox; preset: string } {
  const sandbox = normalizeName(parentPin?.sandbox) as Sandbox | "";
  return { approval: "never", sandbox: sandbox || "full", preset: "delegated-child" };
}

/** 启动期解析结果(三旋钮 + 冲突告警;告警不许静默)。 */
export interface StartupPreset extends PermissionKnobs {
  warnings: string[];
}

/**
 * 启动期预设解析:`defaultPreset ?? preset ?? "workspace-write"`;未知即抛(调用方 fail-closed)。
 * `permissions.mode` 与预设 mode 不一致时 preset 优先,并把冲突写进 warnings(不可静默丢弃)。
 * custom 启动口径:沙箱/审批取 ask 口径,审批模式沿用配置里的 permissions.mode(缺省 ask)。
 */
export function resolveStartupPreset(perms?: { preset?: string; defaultPreset?: string; mode?: string }): StartupPreset {
  const name = normalizeName(perms?.defaultPreset) || normalizeName(perms?.preset) || DEFAULT_STARTUP_PRESET;
  const resolved = resolvePreset(name);
  const warnings: string[] = [];
  const configuredMode = normalizeName(perms?.mode);
  if (resolved.custom) {
    const mode = (configuredMode || "ask") as PermissionMode;
    return { preset: CUSTOM_PRESET, sandbox: "full", approval: "on-request", mode, warnings };
  }
  if (configuredMode && configuredMode !== resolved.mode) {
    warnings.push(`permissions.mode=${configuredMode} 与 preset=${resolved.preset}(mode=${resolved.mode})冲突,preset 优先`);
  }
  return { preset: resolved.preset, sandbox: resolved.sandbox, approval: resolved.approval, mode: resolved.mode, warnings };
}

// —— 进程内当前预设名(main 启动 set、app cfg.set 成功后 set、agent-wiring 开工读取)——
let currentPreset: string = DEFAULT_STARTUP_PRESET;

export function currentPresetName(): string {
  return currentPreset;
}

export function setCurrentPresetName(name: string): void {
  const n = normalizeName(name);
  currentPreset = n || DEFAULT_STARTUP_PRESET;
}
