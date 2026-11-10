/**
 * 权限预设原子绑定与会话钉扎 —— 契约测试。
 * 覆盖:① 5 档映射/auto 别名/custom/未知抛错 ② applyPreset 差量与自定义 ③ pin 幂等与优先级
 * ④ seedResume 补种不覆盖 ⑤ 子代理 delegated-child ⑥ 启动解析 fail-closed ⑦ cfg.set 纯函数语义(先校验后落地)
 * ⑧ 接线:pin 事件形状 + 子代理 asker 放行且不弹 broker。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import {
  PRESETS,
  UnknownPresetError,
  applyPreset,
  childPermission,
  currentPresetName,
  foldProjection,
  pinSession,
  resolvePreset,
  resolveSessionPermission,
  resolveStartupPreset,
  seedResume,
  setCurrentPresetName,
} from "../src/permission-presets.js";
import { permissionMode, setPermissionMode } from "../src/permission-mode.js";
import { makeSubagentPermissionAsker } from "../src/agent-wiring.js";

beforeEach(() => {
  setPermissionMode("ask");
  setCurrentPresetName("workspace-write");
  delete process.env.GENIE_SUBAGENT_ASK;
});

describe("resolvePreset:表/保留名/未知", () => {
  it("5 档预设的 mode 映射与三旋钮一致", () => {
    expect(Object.keys(PRESETS).sort()).toEqual(["ask", "full-access", "plan", "read-only", "workspace-write"]);
    const expectMode: Record<string, string> = {
      "full-access": "auto",
      "workspace-write": "workspace",
      ask: "ask",
      "read-only": "readonly",
      plan: "plan",
    };
    for (const [name, mode] of Object.entries(expectMode)) {
      const r = resolvePreset(name);
      expect(r.preset).toBe(name);
      expect(r.custom).toBe(false);
      if (!r.custom) {
        expect(r.mode).toBe(mode);
        expect(["full", "workspace", "readonly"]).toContain(r.sandbox);
        expect(["never", "on-request", "plan"]).toContain(r.approval);
      }
    }
    // 表行的具体值(安全口径锚定,防误改)
    expect(PRESETS["full-access"]).toEqual({ sandbox: "full", approval: "never", mode: "auto" });
    expect(PRESETS["read-only"]).toEqual({ sandbox: "readonly", approval: "never", mode: "readonly" });
    expect(PRESETS.plan).toEqual({ sandbox: "readonly", approval: "plan", mode: "plan" });
  });

  it("auto=启动缺省别名,解析为 defaultPreset(缺省 workspace-write);可传别的缺省", () => {
    const r = resolvePreset("auto");
    expect(r.preset).toBe("workspace-write");
    expect(r.custom).toBe(false);
    expect(resolvePreset("auto", "plan").preset).toBe("plan");
    expect(resolvePreset("auto", "auto").custom).toBe(false); // auto=auto 自指→回缺省,不静默死循环
  });

  it("custom 是保留名:返回 {custom:true},不是表行", () => {
    const r = resolvePreset("custom");
    expect(r).toEqual({ custom: true, preset: "custom" });
    expect(PRESETS.custom).toBeUndefined();
    expect(PRESETS.auto).toBeUndefined();
  });

  it("未知/空预设名 → UnknownPresetError(code=UNKNOWN_PRESET),名字写进消息", () => {
    expect(() => resolvePreset("nope")).toThrow(UnknownPresetError);
    try {
      resolvePreset("nope");
      throw new Error("应当抛出");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownPresetError);
      expect((err as UnknownPresetError).code).toBe("UNKNOWN_PRESET");
      expect((err as UnknownPresetError).name).toBe("UnknownPresetError");
      expect((err as Error).message).toContain("nope");
      expect((err as UnknownPresetError).preset).toBe("nope");
    }
    expect(() => resolvePreset("")).toThrow(UnknownPresetError);
    expect(() => resolvePreset(undefined)).toThrow(UnknownPresetError);
  });

  it("foldProjection:命中表行→预设名,否则 custom", () => {
    expect(foldProjection({ sandbox: "full", approval: "never" })).toBe("full-access");
    expect(foldProjection({ sandbox: "workspace", approval: "on-request" })).toBe("workspace-write");
    expect(foldProjection({ sandbox: "readonly", approval: "plan" })).toBe("plan");
    expect(foldProjection({ sandbox: "workspace", approval: "never" })).toBe("custom");
    expect(foldProjection({})).toBe("custom");
  });
});

describe("applyPreset:差量 + 原子口径", () => {
  const wsWrite = { preset: "workspace-write", sandbox: "workspace" as const, approval: "on-request" as const, mode: "workspace" as const };

  it("同 preset → applied=[] 且 changed=false(幂等)", () => {
    const r = applyPreset(wsWrite, "workspace-write");
    expect(r.applied).toEqual([]);
    expect(r.changed).toBe(false);
    expect(r).toMatchObject({ preset: "workspace-write", sandbox: "workspace", approval: "on-request", mode: "workspace" });
  });

  it("workspace-write → full-access:sandbox/approval 都进 applied(差异旋钮全列)", () => {
    const r = applyPreset(wsWrite, "full-access");
    expect(r.applied).toContain("sandbox");
    expect(r.applied).toContain("approval");
    expect(r.applied).toEqual(["sandbox", "approval", "mode"]);
    expect(r.changed).toBe(true);
    expect(r).toMatchObject({ preset: "full-access", sandbox: "full", approval: "never", mode: "auto" });
  });

  it("current={sandbox:full,approval:on-request} → full-access 只有 approval 变(applied 精确)", () => {
    const r = applyPreset({ preset: "ask", sandbox: "full", approval: "on-request", mode: "auto" }, "full-access");
    expect(r.applied).toEqual(["approval"]);
    expect(r.changed).toBe(true);
    expect(r).toMatchObject({ preset: "full-access", sandbox: "full", approval: "never", mode: "auto" });
  });

  it("custom:保留 current 三旋钮,只把 preset 置 custom", () => {
    const r = applyPreset({ preset: "ask", sandbox: "workspace", approval: "plan", mode: "plan" }, "custom");
    expect(r).toMatchObject({ preset: "custom", sandbox: "workspace", approval: "plan", mode: "plan" });
    expect(r.applied).toEqual([]);
    expect(r.changed).toBe(true); // preset 名变了
    const again = applyPreset({ preset: "custom", sandbox: "workspace", approval: "plan", mode: "plan" }, "custom");
    expect(again.applied).toEqual([]);
    expect(again.changed).toBe(false);
  });

  it("未知 preset → 抛(不会半应用)", () => {
    expect(() => applyPreset(wsWrite, "nope")).toThrow(UnknownPresetError);
  });
});

describe("pinSession / resolveSessionPermission:会话钉扎", () => {
  it("幂等:两次只一个事件,第二次 written=false", () => {
    const j = new MemoryJournal();
    const first = pinSession(j, "s1", "read-only");
    expect(first.written).toBe(true);
    const second = pinSession(j, "s1", "full-access");
    expect(second.written).toBe(false);
    expect(second.pin.preset).toBe("read-only");
    const pins = j.readAll().filter((e) => (e.payload as { type?: string } | undefined)?.type === "session.permission.pin");
    expect(pins).toHaveLength(1);
  });

  it("pin 优先于全局;改全局后旧会话留旧值,新会话取新 default", () => {
    const j = new MemoryJournal();
    pinSession(j, "old-session", "read-only");
    // 用户把全局预设切到 full-access(等价 cfg.set 后 setCurrentPresetName)
    setCurrentPresetName("full-access");
    const oldOne = resolveSessionPermission(j, "old-session", currentPresetName());
    expect(oldOne.source).toBe("pin");
    expect(oldOne.pinned).toBe(true);
    expect(oldOne.preset).toBe("read-only");
    expect(oldOne.mode).toBe("readonly");
    const newOne = resolveSessionPermission(j, "new-session", currentPresetName());
    expect(newOne.source).toBe("default");
    expect(newOne.pinned).toBe(false);
    expect(newOne.preset).toBe("full-access");
    expect(newOne.mode).toBe("auto");
  });

  it("未知 fallback → 抛(fail-closed,不静默当 ask)", () => {
    expect(() => resolveSessionPermission(new MemoryJournal(), "s1", "nope")).toThrow(UnknownPresetError);
    expect(() => pinSession(new MemoryJournal(), "s1", "nope")).toThrow(UnknownPresetError);
  });
});

describe("seedResume:续跑补种不覆盖", () => {
  it("已有 sandbox 不覆盖,filled 只含缺失项", () => {
    const pin = { preset: "workspace-write", sandbox: "workspace" as const, approval: "on-request" as const, mode: "workspace" as const, at: 1 };
    const r = seedResume({ ...pin, approval: "" as unknown as "on-request" }, { sandbox: "readonly", approval: "never", mode: "auto" });
    expect(r.pin.sandbox).toBe("workspace"); // 已有值不覆盖
    expect(r.pin.approval).toBe("never"); // 空串=缺失 → 补种
    expect(r.pin.mode).toBe("workspace"); // 已有值不覆盖
    expect(r.filled).toEqual(["approval"]);
  });

  it("全缺失 → filled 三项;无 durableFacts → 一个都不填", () => {
    const bare = { preset: "custom", sandbox: "" as never, approval: "" as never, mode: "" as never, at: 0 };
    expect(seedResume(bare, { sandbox: "full", approval: "plan", mode: "plan" }).filled).toEqual(["sandbox", "approval", "mode"]);
    expect(seedResume(bare).filled).toEqual([]);
  });
});

describe("childPermission / resolveStartupPreset", () => {
  it("childPermission:approval=never,sandbox 继承父 pin", () => {
    expect(childPermission({ sandbox: "readonly" })).toEqual({ approval: "never", sandbox: "readonly", preset: "delegated-child" });
    expect(childPermission(undefined)).toEqual({ approval: "never", sandbox: "full", preset: "delegated-child" });
  });

  it("启动:缺省=workspace-write;defaultPreset 优先于 preset;未知→抛", () => {
    expect(resolveStartupPreset(undefined).preset).toBe("workspace-write");
    expect(resolveStartupPreset({}).preset).toBe("workspace-write");
    expect(resolveStartupPreset({ preset: "plan" })).toMatchObject({ preset: "plan", sandbox: "readonly", mode: "plan", warnings: [] });
    expect(resolveStartupPreset({ preset: "plan", defaultPreset: "read-only" }).preset).toBe("read-only");
    expect(() => resolveStartupPreset({ defaultPreset: "nope" })).toThrow(UnknownPresetError);
    expect(() => resolveStartupPreset({ preset: "nope" })).toThrow(UnknownPresetError);
  });

  it("mode 与 preset 冲突 → warnings 非空且点名,preset 优先", () => {
    const r = resolveStartupPreset({ preset: "read-only", mode: "auto" });
    expect(r.mode).toBe("readonly");
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toContain("permissions.mode=auto");
    expect(r.warnings[0]).toContain("read-only");
    // 不冲突时无告警
    expect(resolveStartupPreset({ preset: "read-only", mode: "readonly" }).warnings).toEqual([]);
  });
});

describe("cfg.set 纯函数语义:先校验后落地,失败不改任何 state", () => {
  it("未知 preset 抛且当前 preset/mode 不变", () => {
    setCurrentPresetName("ask");
    setPermissionMode("ask");
    const before = { preset: currentPresetName(), mode: permissionMode() };
    let thrown: unknown;
    try {
      resolvePreset("nope"); // cfg.set 包装层的预校验
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnknownPresetError);
    expect(currentPresetName()).toBe(before.preset);
    expect(permissionMode()).toBe(before.mode);
  });

  it("同一 preset 重复 apply = 幂等(applied 空 → 不落 journal)", () => {
    const j = new MemoryJournal();
    const cur = { preset: currentPresetName(), sandbox: "workspace" as const, approval: "on-request" as const, mode: "workspace" as const };
    const r1 = applyPreset(cur, "workspace-write");
    if (r1.applied.length > 0 || r1.preset !== cur.preset) j.append({ kind: "custom", sessionId: "system", payload: { type: "permission.preset.applied" } });
    expect(j.readAll()).toHaveLength(0);
    setCurrentPresetName(r1.preset);
    const r2 = applyPreset({ preset: "workspace-write", sandbox: "workspace", approval: "on-request", mode: "workspace" }, "workspace-write");
    expect(r2.applied).toEqual([]);
    expect(r2.changed).toBe(false);
  });
});

describe("接线:pin 事件形状 + 子代理 delegated-child 免审", () => {
  it("pinSession 落 custom 事件,payload 形状固定", () => {
    const j = new MemoryJournal();
    pinSession(j, "s-shape", "plan");
    const ev = j.readAll().find((e) => (e.payload as { type?: string } | undefined)?.type === "session.permission.pin");
    expect(ev).toBeTruthy();
    expect(ev!.kind).toBe("custom");
    expect(ev!.sessionId).toBe("s-shape");
    const p = ev!.payload as Record<string, unknown>;
    expect(p.type).toBe("session.permission.pin");
    expect(p.preset).toBe("plan");
    expect(p.sandbox).toBe("readonly");
    expect(p.approval).toBe("plan");
    expect(p.mode).toBe("plan");
    expect(typeof p.at).toBe("number");
  });

  it("子代理 asker:approval=never → 放行,by 含 delegated-child,且不弹 broker", async () => {
    const j = new MemoryJournal();
    pinSession(j, "s-child", "workspace-write");
    let brokerCalls = 0;
    const asker = makeSubagentPermissionAsker({
      sessionId: "s-child",
      journal: j,
      broker: {
        async ask() {
          brokerCalls += 1;
          return { decision: "reject" as const, by: "panel" };
        },
      },
    });
    await expect(asker("subagent", "写 .genie/report.md")).resolves.toBe(true);
    expect(brokerCalls).toBe(0);
    const gate = j.readAll().find((e) => e.kind === "permission.gate");
    expect(gate).toBeTruthy();
    const payload = gate!.payload as { effect?: string; by?: string; tool?: string };
    expect(payload.effect).toBe("allowed");
    expect(payload.tool).toBe("subagent");
    expect(String(payload.by)).toContain("delegated-child");
    expect(String(payload.by)).toContain("approval=never");
    // sandbox 继承父 pin(workspace-write → workspace)
    expect(String(payload.by)).toContain("sandbox=workspace");
  });

  it("既有优先级零回归:mode=readonly 仍先拒绝(不问 broker)", async () => {
    const j = new MemoryJournal();
    setPermissionMode("readonly");
    let brokerCalls = 0;
    const asker = makeSubagentPermissionAsker({
      sessionId: "s-ro",
      journal: j,
      broker: { async ask() { brokerCalls += 1; return { decision: "allow-once" as const, by: "panel" }; } },
    });
    await expect(asker("subagent", "写文件")).resolves.toBe(false);
    expect(brokerCalls).toBe(0);
    expect((j.readAll().find((e) => e.kind === "permission.gate")!.payload as { by?: string }).by).toBe("mode-readonly");
  });
});
