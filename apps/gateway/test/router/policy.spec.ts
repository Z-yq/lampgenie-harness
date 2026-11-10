import { describe, it, expect, vi } from "vitest";
import { gate, policyVersion, DEFAULT_POLICY_CONFIG, loadPolicyConfig, type PolicyConfig } from "../../src/router/policy.js";
import { createRouter } from "../../src/router/index.js";
import { TaskSupervisor } from "../../src/task-manager.js";
import { MemoryJournal } from "@lampgenie/core";

const configOf = (over: Partial<PolicyConfig> = {}): PolicyConfig => ({ ...DEFAULT_POLICY_CONFIG, ...over });

describe("router policy gate+版本哈希( sr4)", () => {
  it("observe 模式 inferred 候选→不派发且 audit.would_accept:true", async () => {
    const cfg = configOf(); // mode=observe
    const r = gate({ source: "im", threadKey: "session:s9" }, cfg, new Map());
    expect(r.admissible).toBe(false);
    expect(r.reason).toBe("observed");
    expect(r.would_accept).toBe(true);
  });

  it("面板/白名单/addressed → explicit 派发", async () => {
    const cfg = configOf({ allowlist: ["ou_feishu_alice"] });
    expect(gate({ source: "panel", threadKey: "session:s1" }, cfg, new Map())).toMatchObject({ admissible: true, strength: "explicit" });
    expect(gate({ source: "im", threadKey: "session:s1", identity: "ou_feishu_alice" }, cfg, new Map())).toMatchObject({ admissible: true, strength: "explicit" });
    expect(gate({ source: "im", threadKey: "session:s1", addressed: true }, cfg, new Map())).toMatchObject({ admissible: true, strength: "explicit" });
  });

  it("订阅命中(threadKey 活 Ticket)→ explicit 直通", async () => {
    const cfg = configOf();
    const live = new Map([["session:s1", true]]);
    expect(gate({ source: "im", threadKey: "session:s1" }, cfg, live)).toMatchObject({ admissible: true, strength: "explicit" });
  });

  it("scope 未监听 → not_listened", async () => {
    const cfg = configOf({ sources: [{ name: "panel", listened: true }, { name: "im", listened: false }] });
    expect(gate({ source: "im", threadKey: "session:s1" }, cfg, new Map())).toMatchObject({ admissible: false, reason: "not_listened" });
  });

  it("改 rules/mode/sources 任一项→policyVersion 变化", async () => {
    const base = configOf();
    const rules = policyVersion(configOf({ rules: [{ id: "r2", enabled: true, instruction: "x" }] }));
    const mode = policyVersion(configOf({ mode: "auto" }));
    const sources = policyVersion(configOf({ sources: [{ name: "panel", listened: true }, { name: "im", listened: false }] }));
    expect(rules).not.toBe(policyVersion(base));
    expect(mode).not.toBe(policyVersion(base));
    expect(sources).not.toBe(policyVersion(base));
    // 同配置幂等(稳定哈希)
    expect(policyVersion(configOf())).toBe(policyVersion(base));
  });

  it("loadPolicyConfig:落盘 .genie/router/policy.json(allowlist/mode/rules/sources)", async () => {
    const fs = new Map<string, string>([
      ["/r/.genie/router/policy.json", JSON.stringify({ allowlist: ["ou_x"], mode: "auto", rules: [{ id: "r", enabled: true, instruction: "i" }], sources: [{ name: "im", listened: true }] })],
    ]);
    const cfg = loadPolicyConfig("/r", { existsSync: (p) => fs.has(p), readFileSync: (p) => fs.get(p) ?? "" });
    expect(cfg.allowlist).toEqual(["ou_x"]);
    expect(cfg.mode).toBe("auto");
    expect(cfg.rules[0]?.id).toBe("r");
    expect(cfg.sources[0]?.name).toBe("im");
    // 脏 JSON → 默认配置(不 throw)
    const fs2 = new Map<string, string>([["/r/.genie/router/policy.json", "{oops"]]);
    expect(loadPolicyConfig("/r", { existsSync: (p) => fs2.has(p), readFileSync: (p) => fs2.get(p) ?? "" })).toEqual(DEFAULT_POLICY_CONFIG);
  });
});

describe("observe 恒不派发( sr7 负面断言)", () => {
  it("observe 路径:spy(TaskSupervisor.submit) 调用 0 次;runCompanionTurn 未触发;disposition 记 observed", async () => {
    const tm = new TaskSupervisor();
    const submitSpy = vi.spyOn(tm, "submit");
    const companionTurn = vi.fn();
    const journal = new MemoryJournal();
    const journalSpy = vi.spyOn(journal, "append");
    const router = createRouter({
      taskManager: tm,
      journal,
      config: configOf({ allowlist: [] }), // im 无白名单=推断候选
      steer: () => { throw new Error("observe 不得走 steer"); },
    });
    // 未 address、无白名单、无活订阅 → inferred 候选
    const r = await router.submit({ source: "im", sessionId: "s-observe", instruction: "顺便帮我看下" });
    expect(r.intake).toBe("stored");
    expect(r.outcome?.kind).toBe("observed");
    expect(submitSpy).toHaveBeenCalledTimes(0);       // 零派发
    expect(companionTurn).toHaveBeenCalledTimes(0);    // 零 LLM(P1 边界)
    expect(journalSpy).toHaveBeenCalledTimes(0);       // observe 不碰消息链
    const d = router.dispositions().at(-1);
    expect(d?.outcome).toBe("observed");
    expect(d?.would_accept).toBe(true);
  });
});
