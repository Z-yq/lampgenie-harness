/**
 * teamai hooks 采用判定层测试:映射规则表(可/不可采用+等价建议)+ adoptTeamaiHook 落盘。
 * 样例对齐真实团队仓形态(event=PreToolUse/matcher="Bash|Write|Edit"/python3 拦截密钥,claude 语义 exit 2 阻断)。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookStore } from "../src/hooks.js";
import { mapTeamaiHookToOurs, adoptTeamaiHook } from "../src/teamai-hooks.js";
import type { TeamaiHook } from "@lampgenie/runtime/team/teamai-bridge";

/** 真实样例:claude PreToolUse 工具闸拦截密钥(exit 2 阻断)。 */
const SECRET_GUARD: TeamaiHook = {
  id: "block-secret-leak",
  description: "拦截密钥外泄",
  event: "PreToolUse",
  matcher: "Bash|Write|Edit",
  tools: ["Bash", "Write", "Edit"],
  command: "python3 hooks/block_secret.py",
};

const LIFECYCLE: TeamaiHook = {
  id: "notify-done",
  description: "任务完成通知",
  event: "task.done",
  matcher: "",
  tools: [],
  command: "curl -s http://hook.example/notify",
};

describe("mapTeamaiHookToOurs(映射规则表)", () => {
  it("PreToolUse 密钥拦截:不可采用,给出 permission deny 等价建议(机器可读)", () => {
    const m = mapTeamaiHookToOurs(SECRET_GUARD);
    expect(m.adoptable).toBe(false);
    expect(m.reason).toContain("claude PreToolUse 工具闸");
    expect(m.reason).toContain("无等价执行点");
    expect(m.reason).toContain("等价安全面是 permission 规则(.genie/permissions.json deny 规则)");
    expect(m.reason).toContain("已给出建议规则");
    expect(m.suggestion).toBeUndefined();
    expect(m.permissionSuggestion).toEqual({
      permission: "bash",
      pattern: "*",
      action: "deny",
      note: "teamai hook:block-secret-leak 等价(密钥防护已由凭据红线承担)",
    });
  });

  it("PreToolUse 无密钥拦截意图:不可采用且不硬造建议(需人工评估)", () => {
    const m = mapTeamaiHookToOurs({ ...SECRET_GUARD, id: "fmt-check", description: "格式检查", command: "python3 hooks/fmt_check.py" });
    expect(m.adoptable).toBe(false);
    expect(m.permissionSuggestion).toBeUndefined();
    expect(m.reason).toContain("需人工评估");
  });

  it("PostToolUse 同属工具闸族:无等价执行点,不给 PreToolUse 专属的 deny 建议", () => {
    const m = mapTeamaiHookToOurs({ ...SECRET_GUARD, event: "PostToolUse" });
    expect(m.adoptable).toBe(false);
    expect(m.reason).toContain("claude PostToolUse 工具闸");
    expect(m.permissionSuggestion).toBeUndefined();
  });

  it("生命周期型命中 HOOK_EVENTS:可采纳 + {name,event,command} 建议(命令原样保留)", () => {
    const m = mapTeamaiHookToOurs(LIFECYCLE);
    expect(m.adoptable).toBe(true);
    expect(m.permissionSuggestion).toBeUndefined();
    expect(m.suggestion).toEqual({ name: "teamai:notify-done", event: "task.done", command: "curl -s http://hook.example/notify" });
  });

  it("SessionStart 等未知事件:如实标注无等价,不硬造映射", () => {
    const m = mapTeamaiHookToOurs({ id: "warmup", description: "会话预热", event: "SessionStart", matcher: "", tools: [], command: "python3 warm.py" });
    expect(m.adoptable).toBe(false);
    expect(m.suggestion).toBeUndefined();
    expect(m.permissionSuggestion).toBeUndefined();
    expect(m.reason).toContain("SessionStart");
    expect(m.reason).toContain("不硬造映射");
  });
});

describe("adoptTeamaiHook(采用落盘,失败显式不静默降级)", () => {
  it("可采用:写入 HookStore 并落盘(重开 store 可读回)", () => {
    const file = join(mkdtempSync(join(tmpdir(), "teamai-hooks-")), "hooks.json");
    const store = new HookStore(file);
    const r = adoptTeamaiHook(store, LIFECYCLE);
    expect(r.ok).toBe(true);
    const listed = store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.name).toBe("teamai:notify-done");
    expect(listed[0]!.event).toBe("task.done");
    // 落盘验证:同一文件重开一个 store 读回。
    const reopened = new HookStore(file).list();
    expect(reopened).toHaveLength(1);
    expect(reopened[0]!.command).toBe("curl -s http://hook.example/notify");
  });

  it("不可采用:显式失败附原因与等价建议,store 零写入", () => {
    const file = join(mkdtempSync(join(tmpdir(), "teamai-hooks-")), "hooks.json");
    const store = new HookStore(file);
    const r = adoptTeamaiHook(store, SECRET_GUARD);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("不可采用 teamai hook block-secret-leak");
    expect(r.detail).toContain("permission 规则");
    expect(r.detail).toContain("teamai hook:block-secret-leak 等价");
    expect(store.list()).toHaveLength(0);
  });

  it("未知事件:显式失败附不硬造映射理由", () => {
    const store = new HookStore(join(mkdtempSync(join(tmpdir(), "teamai-hooks-")), "hooks.json"));
    const r = adoptTeamaiHook(store, { id: "warmup", description: "", event: "SessionStart", matcher: "", tools: [], command: "python3 warm.py" });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("SessionStart");
    expect(store.list()).toHaveLength(0);
  });
});
