/**
 * F2 always-allow:规则存取(合并/冲突/回读)+热加载+ask 咨询优先级(e2e)。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addAlwaysAllowRule, loadPermissionsConfig, loadRulesHot, permissionsFile } from "../src/permission-store.js";
import { matchPermissionRule, permissionRulesFromConfig } from "@lampgenie/core";
import { TaskSupervisor } from "../src/task-manager.js";
import { MemoryJournal } from "@lampgenie/core";
import { wireExecutor } from "../src/executor-wiring.js";
import { PermissionBroker } from "../src/permission-broker.js";
import { repoRoot } from "../src/repo-root.js";

describe("permission-store(F2)", () => {
  const dirs: string[] = [];
  const mk = () => {
    const d = mkdtempSync(join(tmpdir(), "permstore-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("addAlwaysAllowRule:归一为工具级通配(C9 语义:非通配 pattern 一律存 *,防误锁);幂等;与 deny 冲突拒绝", () => {
    const root = mk();
    const a = addAlwaysAllowRule(root, "subagent", "npm test");
    expect(a.ok).toBe(true);
    // 幂等重写
    expect(addAlwaysAllowRule(root, "subagent", "npm test").ok).toBe(true);
    // 第二个非通配 pattern 也归一到 *(工具级放行,字符串形态)
    addAlwaysAllowRule(root, "subagent", "git push");
    const cfg = loadPermissionsConfig(root);
    expect(cfg.subagent).toBe("allow");
    // 显式通配 pattern 保留原样
    addAlwaysAllowRule(root, "code_sense", "*");
    expect(loadPermissionsConfig(root).code_sense).toBe("allow");
    // deny 冲突(通配语义):已有 "*":deny → 任何 allow-always 都撞 deny
    writeFileSync(permissionsFile(root), JSON.stringify({ subagent: { "*": "deny" } }));
    const r = addAlwaysAllowRule(root, "subagent", "rm -rf");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("冲突");
  });

  it("C9: 摘要首词 pattern 归一为工具级通配——evaluatePermission(call.name,'*') 必须命中(防误锁)", async () => {
    const root = mk();
    // 面板「总是允许」真实入参:pattern=摘要首词(如 safe-cmd)
    const r = addAlwaysAllowRule(root, "subagent", "safe-cmd");
    expect(r.ok).toBe(true);
    const rules = loadRulesHot(root);
    // agent loop 工具闸门修复后评估路径:精确工具名 miss → 剥前缀试类别名(loop.ts C9 同款双候选)
    const { evaluatePermission } = await import("@lampgenie/core");
    const direct = evaluatePermission("spawn_subagent", "*", [rules]);
    const rule = direct.action !== "ask" ? direct : evaluatePermission("subagent", "*", [rules]);
    expect(rule.action).toBe("allow"); // 修复前=ask → fail-closed 把整个工具锁死
    // 回归锚:类别名直评也必须 allow(规则存通配)
    expect(evaluatePermission("subagent", "*", [rules]).action).toBe("allow");
  });

  it("loadRulesHot:mtime 变更后热加载(下一次读取即新规则)", () => {
    const root = mk();
    expect(loadRulesHot(root)).toEqual([]);
    addAlwaysAllowRule(root, "subagent", "npm *");
    const rules = loadRulesHot(root);
    expect(rules.some((r) => r.permission === "subagent" && r.pattern === "npm *")).toBe(true);
    // 再改:mtime 变→重读
    writeFileSync(permissionsFile(root), JSON.stringify({ subagent: "deny" }));
    const file = permissionsFile(root);
    const now = new Date();
    utimesSync(file, now, new Date(now.getTime() + 2000)); // mtime 必变(同毫秒写回陷阱)
    expect(loadRulesHot(root).some((r) => r.action === "deny")).toBe(true);
  });
});

describe("matchPermissionRule 语义", () => {
  const rules = permissionRulesFromConfig({ subagent: { "npm test": "allow", "rm *": "deny" }, code_sense: "allow" });
  it("前缀命中/全匹配/未命中", () => {
    expect(matchPermissionRule(rules, "subagent", "npm test --watch")?.action).toBe("allow");
    expect(matchPermissionRule(rules, "subagent", "rm -rf /tmp")?.action).toBe("deny");
    expect(matchPermissionRule(rules, "code_sense", "任意")?.action).toBe("allow");
    expect(matchPermissionRule(rules, "memory", "x")).toBeUndefined();
  });
});

describe("ask 咨询优先级 e2e(规则>面板,真实 wireExecutor 路径)", () => {
  it("仓级规则 allow 命中→rule-allowed 落 journal 不广播;清理后回退 fail-closed", async () => {
    const { existsSync, writeFileSync, rmSync: rmf } = await import("node:fs");
    const rulesFile = join(repoRoot(), ".genie", "permissions.json");
    const existedBefore = existsSync(rulesFile);
    const backup = existedBefore ? (await import("node:fs")).readFileSync(rulesFile, "utf-8") : null;
    try {
      (await import("node:fs")).mkdirSync(join(repoRoot(), ".genie"), { recursive: true });
      writeFileSync(rulesFile, JSON.stringify({ subagent: { "safe-cmd": "allow" } }));
      const { loadRulesHot } = await import("../src/permission-store.js");
      loadRulesHot(repoRoot()); // 预热缓存(mtime 基线)

      type AskEvent = { type: string; requestId?: string; summary?: string; risk?: string };
      const backend = {
        kind: "rule-e2e",
        async spawn(_spec: unknown, onEvent: (e: AskEvent) => void) {
          onEvent({ type: "permission-ask", requestId: "rq-rule", summary: "safe-cmd --flag", risk: "low" });
          onEvent({ type: "result", result: { ok: true, finalText: "done" } });
          return { taskId: "t", cancel: async () => {}, steer: async () => true, respondPermission: async () => {} };
        },
      };
      const broker = new PermissionBroker(9999);
      broker.online = true;
      const asked: unknown[] = [];
      broker.attach((m) => asked.push(m)); // 规则命中时不应广播
      const tm = new TaskSupervisor();
      const j = new MemoryJournal();
      wireExecutor(tm, j, backend as never, undefined, undefined, undefined, broker);
      tm.submit("user", "rule-e2e", "危险活");
      await new Promise((r) => setTimeout(r, 400));
      const gates = j.readAll().filter((e) => e.kind === "permission.gate").map((e) => e.payload as { effect: string; by: string });
      expect(gates.some((g) => g.effect === "allowed" && g.by.startsWith("rule-allowed"))).toBe(true);
      expect(asked).toHaveLength(0); // 未落面板
    } finally {
      if (backup !== null) writeFileSync(rulesFile, backup);
      else if (!existedBefore && existsSync(rulesFile)) rmf(rulesFile);
    }
  }, 10_000);
});
