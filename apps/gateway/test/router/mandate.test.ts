import { describe, it, expect } from "vitest";
import { TaskSupervisor } from "../../src/task-manager.js";
import { MemoryJournal } from "@lampgenie/core";
import { createRouter } from "../../src/router/index.js";
import { DEFAULT_POLICY_CONFIG, type PolicyConfig } from "../../src/router/policy.js";

const configOf = (over: Partial<PolicyConfig> = {}): PolicyConfig => ({ ...DEFAULT_POLICY_CONFIG, ...over });

describe("step-0145 P3 Mandate:不可变授权凭证 + revalidate", () => {
  it("explicit 派发产 mandate 挂 Ticket + 随行落 audit;版本未变 revalidate 放行", async () => {
    const tm = new TaskSupervisor();
    const router = createRouter({ taskManager: tm, journal: new MemoryJournal(), config: configOf() });
    const r = await router.submit({ source: "panel", sessionId: "s1", instruction: "写个 README" });
    expect(r.outcome?.kind).toBe("dispatched");
    const ticket = router.tickets().at(-1)!;
    expect(ticket.mandate).toMatchObject({ strength: "explicit" });
    expect(ticket.mandate?.policyVersion).toBe(router.policyVersion());
    // 审计行无凭证字段
    const d = router.dispositions().find((x) => x.outcome === "dispatched");
    expect(d?.mandate).toBeDefined();
    const line = JSON.stringify(d);
    expect(line).not.toMatch(/token|secret|apiKey|credential/i);
  });

  it("改 rules → policyVersion 变 → 恢复时 revalidate false → Ticket closed + revalidate_failed 审计", async () => {
    const files = new Map<string, string>();
    const io = {
      existsSync: (p: string) => files.has(p),
      readFileSync: (p: string) => files.get(p) ?? "",
      mkdirSync: () => {},
      appendFileSync: (p: string, d: string) => { files.set(p, (files.get(p) ?? "") + d); },
      writeFileSync: (p: string, d: string) => { files.set(p, d); },
    };
    const tm = new TaskSupervisor();
    const c1 = configOf();
    const r1 = createRouter({ taskManager: tm, journal: new MemoryJournal(), config: c1, root: "/tmp/rm1", io });
    await r1.submit({ source: "panel", sessionId: "s1", instruction: "x" });
    expect(r1.tickets().filter((t) => t.phase === "open")).toHaveLength(1);
    // 模拟重启 + policy 变更(rules 加一条)
    const c2 = configOf({ rules: [...DEFAULT_POLICY_CONFIG.rules, { id: "r-new", enabled: true, description: "新规则" } as never] });
    const r2 = createRouter({ taskManager: tm, journal: new MemoryJournal(), config: c2, root: "/tmp/rm1", io });
    expect(r2.tickets().filter((t) => t.phase === "open")).toHaveLength(0);
    const auditText = files.get("/tmp/rm1/.genie/router/audit.jsonl") ?? "";
    expect(auditText).toContain("revalidate_failed");
  });

  it("版本未变重启 → open Ticket 保留(订阅直通存活)", async () => {
    const files = new Map<string, string>();
    const io = {
      existsSync: (p: string) => files.has(p),
      readFileSync: (p: string) => files.get(p) ?? "",
      mkdirSync: () => {},
      appendFileSync: (p: string, d: string) => { files.set(p, (files.get(p) ?? "") + d); },
      writeFileSync: (p: string, d: string) => { files.set(p, d); },
    };
    const tm = new TaskSupervisor({ maxConcurrent: 1, maxConcurrentPerOwner: 1 });
    const cfg = configOf();
    const r1 = createRouter({ taskManager: tm, journal: new MemoryJournal(), config: cfg, root: "/tmp/rm2", io });
    await r1.submit({ source: "panel", sessionId: "s1", instruction: "跑个构建" });
    const r2 = createRouter({ taskManager: tm, journal: new MemoryJournal(), config: cfg, root: "/tmp/rm2", io });
    expect(r2.tickets().filter((t) => t.phase === "open")).toHaveLength(1);
  });
});
