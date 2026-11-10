/**
 * teamai hooks 采用判定层(designs/24 追记):claude 形态钩子 → 我们的任务生命周期钩子体系。
 * 纪律:如实映射不硬造——claude 的工具闸(PreToolUse/PostToolUse)在我们的任务生命周期事件
 * (task.start/done/fail/cancel)里无等价执行点,不硬造执行语义;我们的等价安全面是
 * permission 规则(.genie/permissions.json deny 规则),对可识别的密钥拦截类钩子给出机器可读建议;
 * 生命周期型事件只有命中我们 HOOK_EVENTS 才可真正采用(命令语义同形:bash -lc 在项目根跑)。
 * 采用=写入 HookStore;不可采用=显式失败并附原因与等价建议,绝不静默降级。
 */
import { HOOK_EVENTS, type HookEvent, type HookStore } from "./hooks.js";
import type { TeamaiHook } from "@lampgenie/runtime/team/teamai-bridge";

/** permission deny 规则建议(机器可读:形态对齐 .genie/permissions.json 的 {permission:{pattern:action}} + note 说明)。 */
export interface PermissionDenySuggestion {
  permission: string;
  pattern: string;
  action: "deny";
  note: string;
}

/** 单条 teamai hook 的采用判定结果。 */
export interface TeamaiHookMapping {
  adoptable: boolean;
  /** 判定理由(用户可见:能否采用、我们的什么机制已覆盖)。 */
  reason: string;
  /** adoptable=true 时给出:可直接写入 HookStore 的建议。 */
  suggestion?: { name: string; event: HookEvent; command: string };
  /** adoptable=false 但有等价安全面时给出:permission deny 规则建议(不自动落盘,人工评估)。 */
  permissionSuggestion?: PermissionDenySuggestion;
}

/** claude 工具闸事件族(Pre 拦截/Post 观察;我们的任务生命周期无等价执行点)。 */
const TOOL_GATE_RE = /^(Pre|Post)ToolUse$/;
/** 密钥拦截意图启发式:key|token|secret|password 词形,扫 hook 自述字段(id/description/command)。 */
const SECRET_INTENT_RE = /\b(key|token|secret|password)\b/i;
/** matcher 中的工具名(claude matcher 形态:"Bash|Write|Edit")。 */
const GUARDED_TOOLS_RE = /\b(Write|Edit|Bash)\b/;

/** 映射判定(纯函数):可/不可采用 + 理由 + 建议(钩子或 permission deny 规则)。 */
export function mapTeamaiHookToOurs(h: TeamaiHook): TeamaiHookMapping {
  // 生命周期型:事件命中我们的枚举才可采用(命令执行语义同形,不换语义)。
  if (HOOK_EVENTS.includes(h.event as HookEvent)) {
    const event = h.event as HookEvent;
    return {
      adoptable: true,
      reason: `事件 ${event} 命中我们的任务生命周期事件(${HOOK_EVENTS.join("/")}),可直接采用`,
      suggestion: { name: "teamai:" + (h.id || "hook"), event, command: h.command },
    };
  }
  // 工具闸族:无等价执行点;PreToolUse 的密钥拦截意图给 permission deny 建议。
  if (TOOL_GATE_RE.test(h.event)) {
    const base = `claude ${h.event} 工具闸:我们的任务生命周期事件(${HOOK_EVENTS.join("/")})无等价执行点;我们的等价安全面是 permission 规则(.genie/permissions.json deny 规则)`;
    if (h.event === "PreToolUse" && GUARDED_TOOLS_RE.test(h.matcher || "") && SECRET_INTENT_RE.test(`${h.id} ${h.description} ${h.command}`)) {
      return {
        adoptable: false,
        reason: base + ";已给出建议规则",
        permissionSuggestion: {
          permission: "bash",
          pattern: "*",
          action: "deny",
          note: `teamai hook:${h.id} 等价(密钥防护已由凭据红线承担)`,
        },
      };
    }
    return { adoptable: false, reason: base + ";未识别出可自动转换的等价规则,需人工评估" };
  }
  // 其余(SessionStart/UserPromptSubmit/Stop/…):无对应,如实标注不硬造。
  return {
    adoptable: false,
    reason: `claude 事件 ${h.event || "(空)"} 在我们的任务生命周期事件(${HOOK_EVENTS.join("/")})中无等价,不硬造映射`,
  };
}

/** 采用:可采用才写入 HookStore 落盘;不可采用=显式失败附原因(绝不静默降级)。 */
export function adoptTeamaiHook(store: HookStore, hook: TeamaiHook): { ok: boolean; detail: string } {
  const mapped = mapTeamaiHookToOurs(hook);
  if (!mapped.adoptable || !mapped.suggestion) {
    const extra = mapped.permissionSuggestion
      ? ";等价建议(人工评估后落 .genie/permissions.json):" + JSON.stringify(mapped.permissionSuggestion)
      : "";
    return { ok: false, detail: `不可采用 teamai hook ${hook.id}:${mapped.reason}${extra}` };
  }
  const r = store.add(mapped.suggestion);
  if (r && "error" in r) return { ok: false, detail: `采用失败 teamai hook ${hook.id}:${r.error}` };
  return { ok: true, detail: `已采用 teamai hook ${hook.id} → ${mapped.suggestion.name}(${mapped.suggestion.event},钩子 id ${r.id})` };
}
