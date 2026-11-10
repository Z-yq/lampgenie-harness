/**
 * 权限传递对拍:
 * ①主 loop 门「写入×评估」形态对拍——面板 always-allow 写入的规则形态被 buildMainLoopPermission/loop 闸门真实命中;
 * ②模式矩阵(auto/ask/readonly/plan × broker 有无)——mode=ask+broker 挂 onAsk 审批链(此前 ask 被静默 deny
 * 且无任何审批入口,生产环境 journal 注意 97 次拒);
 * ③子代理继承——LlmLoopBackend 注入父会话规则快照(此前完全忽略,deny 形同虚设、child 无闸),
 *   deny 拦/ask 审批/无规则不设闸(行为与旧版一致);
 * ④asker 审批链 env>mode>规则>broker>fail-closed(C9 对拍形态:规则文件形态 × matchPermissionRule 读法)。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addAlwaysAllowRule, permissionsFile } from "../src/permission-store.js";
import { buildMainLoopPermission, makeSubagentPermissionAsker, loadPermissionRules } from "../src/agent-wiring.js";
import { LlmLoopBackend } from "../src/llm-loop-backend.js";
import { setPermissionMode } from "../src/permission-mode.js";
import { AgentLoop, type AgentLoopOptions, type Tool, type LlmProvider } from "@lampgenie/runtime/agent/loop";
import { MemoryJournal, type PermissionRule } from "@lampgenie/core";

type PermOption = NonNullable<AgentLoopOptions["permission"]>;

const dirs: string[] = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), "permpass-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** gates 序列化(effect/by)。 */
const gateTags = (j: MemoryJournal) =>
  (j.readAll().filter((e) => e.kind === "permission.gate").map((e) => e.payload as { effect: string; by: string })).map((g) => `${g.effect}/${g.by}`);

/** 最小工具:execute 落盘标记,断言「真的执行了」。 */
function probeTool(name: string, log: string[]): Tool {
  return {
    name, description: "探针", parameters: { type: "object", properties: {} },
    async execute() { log.push(name); return "executed"; },
  };
}

/** 单工具一 turn:llm 首步发该工具调用,次步。 */
async function runOneTool(name: string, perm: PermOption, sessionId: string) {
  const journal = new MemoryJournal();
  const executed: string[] = [];
  let i = 0;
  const llm = {
    async chat() {
      i++;
      if (i === 1) return { content: "", toolCalls: [{ id: "c1", name, arguments: "{}" }] };
      return { content: "done" };
    },
  };
  await new AgentLoop({ journal, sessionId, system: "s", llm, tools: [probeTool(name, executed)], permission: perm }).runTurn("做");
  return { journal, executed };
}

describe("主 loop 门:写入×评估 形态对拍(C9 对拍形态)", () => {
  afterEach(() => setPermissionMode("ask"));

  it("面板 always-allow 写入形态(addAlwaysAllowRule 归一)→ 主 loop 闸门命中工具直通", async () => {
    setPermissionMode("ask");
    const root = mk();
    // 面板实参 pattern=摘要首词;store 归一存 *;规则 permission 可为类别名或精确工具名
    addAlwaysAllowRule(root, "code_sense", "调用链");
    addAlwaysAllowRule(root, "spawn_subagent", "任意首词");
    const perm = buildMainLoopPermission(loadPermissionRules(root)!, undefined, { sessionId: "s1", journal: new MemoryJournal() });
    expect(perm.askMode).toBe("deny"); // mode=ask 无 broker:ask 兜底仍是 fail-closed
    expect(perm.onAsk).toBeUndefined();
    expect((await runOneTool("code_sense", perm, "s1")).executed).toEqual(["code_sense"]);
    expect((await runOneTool("spawn_subagent", perm, "s2")).executed).toEqual(["spawn_subagent"]);
  });

  it("subagent 类别规则同时放行派发与收割(task_output 别名)——后台流不再半途断死", async () => {
    setPermissionMode("ask");
    const root = mk();
    addAlwaysAllowRule(root, "subagent", "safe-cmd"); // C9 原始案例形态
    const perm = buildMainLoopPermission(loadPermissionRules(root)!, undefined, { sessionId: "s3", journal: new MemoryJournal() });
    expect((await runOneTool("spawn_subagent", perm, "s3a")).executed).toEqual(["spawn_subagent"]);
    expect((await runOneTool("task_output", perm, "s3b")).executed).toEqual(["task_output"]);
  });

  it("未命中规则+mode=ask+无 broker → fail-closed 拒绝(by=ask-default),修复不放宽", async () => {
    setPermissionMode("ask");
    const root = mk();
    mkdirSync(join(root, ".genie"), { recursive: true });
    writeFileSync(permissionsFile(root), JSON.stringify({ code_sense: "allow" }));
    const perm = buildMainLoopPermission(loadPermissionRules(root)!, undefined, { sessionId: "s4", journal: new MemoryJournal() });
    const { journal, executed } = await runOneTool("memory", perm, "s4");
    expect(executed).toEqual([]); // 未允许的工具不执行
    expect(gateTags(journal)).toContain("denied/ask-default");
  });
});

describe("主 loop 权限模式矩阵", () => {
  afterEach(() => { setPermissionMode("ask"); delete process.env.GENIE_PERM_ASK_MODE; });
  const rules: PermissionRule[] = [{ permission: "memory", pattern: "*", action: "ask" }];
  const broker = { ask: async () => ({ decision: "allow-once" as const, by: "panel" }) };

  it("auto→askMode=allow 且无 onAsk(完全访问,行为不变);readonly/plan→deny 无 onAsk(拒绝语义不放宽)", () => {
    setPermissionMode("auto");
    const auto = buildMainLoopPermission(rules, broker, { sessionId: "m1", journal: new MemoryJournal() });
    expect(auto.askMode).toBe("allow");
    expect(auto.onAsk).toBeUndefined();
    for (const mode of ["readonly", "plan"] as const) {
      setPermissionMode(mode);
      const p = buildMainLoopPermission(rules, broker, { sessionId: "m2", journal: new MemoryJournal() });
      expect(p.askMode).toBe("deny");
      expect(p.onAsk).toBeUndefined();
    }
  });

  it("ask+broker→挂 onAsk;ask 无 broker→无 onAsk(即时 fail-closed);ask+GENIE_PERM_ASK_MODE=allow→env 快路径无 onAsk", () => {
    setPermissionMode("ask");
    expect(typeof buildMainLoopPermission(rules, broker, { sessionId: "m3", journal: new MemoryJournal() }).onAsk).toBe("function");
    expect(buildMainLoopPermission(rules, undefined, { sessionId: "m4", journal: new MemoryJournal() }).onAsk).toBeUndefined();
    process.env.GENIE_PERM_ASK_MODE = "allow";
    const env = buildMainLoopPermission(rules, broker, { sessionId: "m5", journal: new MemoryJournal() });
    expect(env.askMode).toBe("allow");
    expect(env.onAsk).toBeUndefined();
  });

  it("onAsk 端到端:ask 工具→broker 收到审批(tool=真实工具名)→放行执行+双 journal 事件;拒绝→审批文案 fail-closed", async () => {
    setPermissionMode("ask");
    const asks: { requestId: string; sessionId: string; tool: string; summary: string }[] = [];
    const j = new MemoryJournal();
    const perm = buildMainLoopPermission(rules, { ask: async (i) => { asks.push(i); return { decision: "allow-once", by: "panel" }; } }, { sessionId: "m6", journal: j });
    // 双 journal:审批链明细进 ctx journal;loop 闸门结算进 loop 自己的 journal(runOneTool 返回)。
    const r6 = await runOneTool("memory", perm, "m6");
    expect(r6.executed).toEqual(["memory"]);
    expect(asks).toHaveLength(1);
    expect(asks[0]!.tool).toBe("memory");
    expect(asks[0]!.sessionId).toBe("m6");
    expect(gateTags(j)).toContain("allowed/panel-approved");
    expect(gateTags(r6.journal)).toContain("allowed/ask-approved");

    const j2 = new MemoryJournal();
    const perm2 = buildMainLoopPermission(rules, { ask: async () => ({ decision: "reject", by: "panel" }) }, { sessionId: "m7", journal: j2 });
    const { executed, journal } = await runOneTool("memory", perm2, "m7");
    expect(executed).toEqual([]);
    expect(journal.readAll().some((e) => e.kind === "tool.result" && String((e.payload as { content: string }).content).includes("被权限审批拒绝"))).toBe(true);
    expect(gateTags(j2)).toContain("denied/panel-denied");
  });
});

describe("子代理权限继承(LlmLoopBackend 此前完全忽略规则——收口对拍)", () => {
 /** 脚本化 LLM:首步写文件,次步;instructions 短句避开串台重派守卫。 */
  function scriptLlm(dir: string): LlmProvider {
    let i = 0;
    return {
      async chat() {
        i++;
        if (i === 1) return { content: "", toolCalls: [{ id: "w1", name: "write_file", arguments: JSON.stringify({ path: join(dir, "out.txt"), content: "hello" }) }] };
        return { content: "done" };
      },
    };
  }

  async function runBackend(dir: string, opts: { permissionRules?: PermissionRule[]; onPermissionAsk?: (tool: string, summary: string) => Promise<boolean> }) {
    const backend = new LlmLoopBackend({ llm: scriptLlm(dir), roots: [dir], workdir: dir, stallTimeoutMs: 3000, ...opts });
    let result: { ok: boolean; finalText?: string } | undefined;
    await backend.spawn({ taskId: "t1", instructions: "写文件", workdir: dir, permissions: "sandbox" }, (e) => {
      if (e.type === "result") result = e.result;
    });
    for (let t = 0; t < 200 && !result; t++) await new Promise((r) => setTimeout(r, 50));
    if (!result) throw new Error("子代理 10s 未收敛");
    return result;
  }

  it("deny 规则下传:子代理 write_file 被拦(文件不落盘)——此前 deny 对进程内子代理形同虚设", async () => {
    const dir = mk();
    const asked: unknown[] = [];
    await runBackend(dir, {
      permissionRules: [{ permission: "write_file", pattern: "*", action: "deny" }],
      onPermissionAsk: async (...a) => { asked.push(a); return true; },
    });
    expect(existsSync(join(dir, "out.txt"))).toBe(false);
    expect(asked).toHaveLength(0); // deny 不进审批
  });

  it("ask 规则+审批链:放行→文件落盘且回调收到(write_file, 参数摘要);拒绝→不落盘(fail-closed)", async () => {
    const dir = mk();
    const seen: [string, string][] = [];
    await runBackend(dir, {
      permissionRules: [{ permission: "write_file", pattern: "*", action: "ask" }],
      onPermissionAsk: async (tool, summary) => { seen.push([tool, summary]); return true; },
    });
    expect(existsSync(join(dir, "out.txt"))).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBe("write_file");
    expect(seen[0]![1]).toContain("out.txt"); // 摘要带参数(面板卡片可见)

    const dir2 = mk();
    await runBackend(dir2, {
      permissionRules: [{ permission: "write_file", pattern: "*", action: "ask" }],
      onPermissionAsk: async () => false,
    });
    expect(existsSync(join(dir2, "out.txt"))).toBe(false);
  });

  it("无规则不设闸:行为与旧版一致(文件直落)", async () => {
    const dir = mk();
    await runBackend(dir, {});
    expect(existsSync(join(dir, "out.txt"))).toBe(true);
  });
});

describe("子代理工具 ask 审批链(env>mode>规则>broker>fail-closed)", () => {
  afterEach(() => { setPermissionMode("ask"); delete process.env.GENIE_SUBAGENT_ASK; });

  const asker = (over: Partial<Parameters<typeof makeSubagentPermissionAsker>[0]> = {}) => {
    const j = new MemoryJournal();
    return { j, run: makeSubagentPermissionAsker({ sessionId: "a1", journal: j, ...over }) };
  };

  it("env allow-once 最高;mode auto 次之;readonly 直接拒", async () => {
    process.env.GENIE_SUBAGENT_ASK = "allow-once";
    const a = asker();
    expect(await a.run("write_file", "path=x")).toBe(true);
    expect(gateTags(a.j)).toContain("allowed/env-allow-once");
    delete process.env.GENIE_SUBAGENT_ASK;

    setPermissionMode("auto");
    const b = asker();
    expect(await b.run("write_file", "path=x")).toBe(true);
    expect(gateTags(b.j)).toContain("allowed/mode-auto(完全访问)");

    setPermissionMode("readonly");
    const c = asker();
    expect(await c.run("write_file", "path=x")).toBe(false);
    expect(gateTags(c.j)).toContain("denied/mode-readonly");
  });

  it("规则对拍(C9 形态):归一后的 subagent[*]=allow 被摘要链命中;前缀 deny 仍拦;规则 root 可注入隔离生产环境", async () => {
    setPermissionMode("ask");
    const root = mk();
    mkdirSync(join(root, ".genie"), { recursive: true });
    writeFileSync(permissionsFile(root), JSON.stringify({ subagent: { "rm *": "deny", "*": "allow" } }));
    const a = asker({ rulesRoot: root });
    expect(await a.run("write_file", "path=/tmp/x")).toBe(true);
    expect(gateTags(a.j)).toContain("allowed/rule-allowed:subagent[*]");
    const b = asker({ rulesRoot: root });
    expect(await b.run("subagent", "rm -rf /tmp/x")).toBe(false);
    expect(gateTags(b.j)).toContain("denied/rule-denied");
  });

  it("无规则:broker 决定(面板摘要带子工具名);无 broker=fail-closed(auto-fail-closed 不放宽)", async () => {
    setPermissionMode("ask");
    const root = mk(); // 空根:无规则文件
    const asks: { tool: string; summary: string }[] = [];
    const a = asker({ rulesRoot: root, broker: { ask: async (i) => { asks.push({ tool: i.tool, summary: i.summary }); return { decision: "reject", by: "panel" }; } } });
    expect(await a.run("write_file", "path=/etc/passwd")).toBe(false);
    expect(gateTags(a.j)).toContain("denied/panel-denied");
    expect(asks[0]!.tool).toBe("subagent");
    expect(asks[0]!.summary).toContain("write_file"); // 面板卡片可见子工具

    const b = asker({ rulesRoot: root });
    expect(await b.run("write_file", "path=/etc/passwd")).toBe(false);
    expect(gateTags(b.j)).toContain("denied/auto-fail-closed");
  });
});
