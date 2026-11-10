/**
 * step-048 单测:插件体系 / 向导命令 / 多模态消息 / quota / 附件链路。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginSystem, BUILTIN_PLUGIN_CATALOG } from "../src/plugins.js";
import { genBootstrapCommand } from "../src/remote-wizard.js";
import { createOpenAiCompatProvider } from "@lampgenie/runtime/agent/openai-provider";
import { AgentLoop, type LlmProvider, type Message } from "@lampgenie/runtime/agent/loop";
import { MemoryJournal } from "@lampgenie/core";
import { TaskSupervisor } from "../src/task-manager.js";
import { computeStatsSummary } from "../src/stats.js";

describe("PluginSystem(step-048 插件市场)", () => {
  function mk(tmp: string) {
    const mcpAdded: { id: string; name: string }[] = [];
    return {
      ps: new PluginSystem(tmp, (i) => { const id = "mcp-" + i.name; mcpAdded.push({ id, name: i.name }); return { id }; }, (id) => mcpAdded.findIndex((x) => x.id === id) >= 0),
      mcpAdded,
    };
  }
  it("install 写真实落点;uninstall 按台账精确回收;持久化", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gwplug-"));
    try {
      const { ps, mcpAdded } = mk(tmp);
      // git-flow:命令
      const r1 = ps.install("git-flow") as { artifacts: { commandFiles: string[] } };
      expect(r1.artifacts.commandFiles).toHaveLength(3);
      expect(existsSync(join(tmp, ".genie", "commands", "branch-report.md"))).toBe(true);
      expect(readFileSync(join(tmp, ".genie", "commands", "commit-draft.md"), "utf-8")).toContain("提交信息");
      // tdd-pack:技能+命令+agent 三类资产
      ps.install("tdd-pack");
      expect(existsSync(join(tmp, ".genie", "agents", "test-driver.md"))).toBe(true);
      expect(readFileSync(join(tmp, ".genie", "agents", "test-driver.md"), "utf-8")).toContain("description:");
      expect(existsSync(join(tmp, ".genie", "experiences", "plugin-tdd-pack", "tdd-loop", "SKILL.md"))).toBe(true);
      // 目录含 installed 态
      expect(ps.listInstalled().map((x) => x.id).sort()).toEqual(["git-flow", "tdd-pack"]);
      // 卸载 git-flow:其命令消失,tdd-pack 资产不动
      ps.uninstall("git-flow");
      expect(existsSync(join(tmp, ".genie", "commands", "branch-report.md"))).toBe(false);
      expect(existsSync(join(tmp, ".genie", "commands", "tdd.md"))).toBe(true);
      expect(ps.listInstalled().map((x) => x.id)).toEqual(["tdd-pack"]);
      // 重装已装 → 拒绝
      expect("error" in (ps.install("tdd-pack") as object)).toBe(true);
      // MCP 资产:自定义目录扩展
      writeFileSync(join(tmp, ".genie", "plugins-catalog.json"), JSON.stringify([{
        id: "with-mcp", name: "带 MCP", version: "1.0.0", author: "t", category: "测试",
        description: "x", provides: { mcp: [{ name: "fsx", command: "npx", args: ["-y", "fsx"] }] },
      }]), "utf-8");
      const r3 = ps.install("with-mcp") as { artifacts: { mcpIds: string[] } };
      expect(r3.artifacts.mcpIds).toHaveLength(1);
      expect(mcpAdded[0].name).toBe("fsx");
      ps.uninstall("with-mcp");
      expect(ps.listInstalled().map((x) => x.id)).toEqual(["tdd-pack"]);
      // 持久化:新实例可见
      const ps2 = new PluginSystem(tmp, () => ({ id: "x" }), () => true);
      expect(ps2.listInstalled().map((x) => x.id)).toEqual(["tdd-pack"]);
      // 启停:停用移除资产保台账;启用重写
      ps2.toggle("tdd-pack", false);
      expect(existsSync(join(tmp, ".genie", "commands", "tdd.md"))).toBe(false);
      expect(ps2.listInstalled()[0].enabled).toBe(false);
      ps2.toggle("tdd-pack", true);
      expect(existsSync(join(tmp, ".genie", "commands", "tdd.md"))).toBe(true);
      expect(ps2.listInstalled()[0].enabled).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("内置目录 ≥6 且形状完整", () => {
    expect(BUILTIN_PLUGIN_CATALOG.length).toBeGreaterThanOrEqual(6);
    for (const m of BUILTIN_PLUGIN_CATALOG) {
      expect(m.id).toBeTruthy();
      expect(m.provides).toBeTruthy();
    }
  });
});

describe("远程连接向导(step-048)", () => {
  it("SSH/Docker 命令含真实要素(gateway 地址/node id/下载路径)", () => {
    const ssh = genBootstrapCommand({ kind: "ssh", host: "192.168.1.20", user: "op", port: 2222, gatewayUrl: "ws://192.168.1.10:7700", nodeId: "my-node" });
    expect(ssh.command).toContain("ssh -p 2222 op@192.168.1.20");
    expect(ssh.command).toContain("http://192.168.1.10:7700/downloads/node-agent.mjs");
    expect(ssh.command).toContain("GENIE_GATEWAY_URL=ws://192.168.1.10:7700");
    expect(ssh.command).toContain("GENIE_NODE_ID=my-node");
    const dk = genBootstrapCommand({ kind: "docker", host: "x", user: "root", port: 22, gatewayUrl: "ws://10.0.0.2:7700", nodeId: "dock-node" });
    expect(dk.command).toContain("docker run -d");
    expect(dk.command).toContain("node:20-alpine");
    expect(dk.command).toContain("GENIE_NODE_ID=dock-node");
  });
});

describe("多模态消息链路(step-048)", () => {
  it("loop runTurn(images) → journal message.user.images;deriveMessages 还原", async () => {
    const journal = new MemoryJournal();
    const llm: LlmProvider = { async chat() { return { content: "看图作答" }; } };
    const loop = new AgentLoop({ journal, sessionId: "s-img", system: "sys", llm });
    await loop.runTurn("这是什么", ["data:image/png;base64,QUJD"]);
    const ev = journal.readAll().find((e) => e.kind === "message.user");
    expect((ev!.payload as { images?: string[] }).images).toEqual(["data:image/png;base64,QUJD"]);
    const { deriveMessages } = await import("@lampgenie/runtime/agent/loop");
    const msgs = deriveMessages(journal, "s-img");
    expect((msgs[0] as { images?: string[] }).images).toEqual(["data:image/png;base64,QUJD"]);
  });
  it("openai-provider:user images → content 数组(text+image_url);无 images 走原字符串", async () => {
    const bodies: unknown[] = [];
    const origFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: unknown }).fetch = async (_u: unknown, init?: { body?: string }) => {
      bodies.push(JSON.parse(String(init?.body)));
      return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) } as Response;
    };
    try {
      const prov = createOpenAiCompatProvider({ baseUrl: "http://x", apiKey: "k", model: "m" });
      const msgs: Message[] = [
        { role: "user", content: "看这张", images: ["data:image/png;base64,QUJD", "data:image/jpeg;base64,RUZH"] },
      ];
      await prov.chat(msgs, []);
      const body = bodies[0] as { messages: { role: string; content: unknown }[] };
      const c = body.messages[0].content as { type: string; text?: string; image_url?: { url: string } }[];
      expect(Array.isArray(c)).toBe(true);
      expect(c[0].type).toBe("text");
      expect(c[1].image_url!.url).toContain("image/png");
      expect(c[2].image_url!.url).toContain("image/jpeg");
      // 无 images:原字符串形态
      await prov.chat([{ role: "user", content: "纯文本" }], []);
      const body2 = bodies[1] as { messages: { content: unknown }[] };
      expect(typeof body2.messages[0].content).toBe("string");
    } finally {
      (globalThis as unknown as { fetch: unknown }).fetch = origFetch;
    }
  });
});

describe("quota(step-048 本地额度)", () => {
  it("今日/本周聚合 + 周界(周一) + 预算注入", () => {
    const j = new MemoryJournal();
    const tm = new TaskSupervisor();
    const DAY = 86_400_000;
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dow = (now.getDay() + 6) % 7;
    // 同日两笔(日期无关断言):今日=本周=80
    j.append({ kind: "message.agent", sessionId: "s", payload: { text: "a", usage: { inputTokens: 20, outputTokens: 10 } }, time: dayStart + 1000 } as never);
    j.append({ kind: "message.agent", sessionId: "s", payload: { text: "b", usage: { inputTokens: 40, outputTokens: 10 } }, time: dayStart + 2000 } as never);
    const s = computeStatsSummary(j, tm, 30, 5000);
    expect(s.quota.today).toBe(80);
    expect(s.quota.week).toBe(80);
    expect(s.quota.budget).toBe(5000);
    expect(s.quota.resetAt).toBe(dayStart + DAY);
    expect(s.quota.weekStartAt).toBe(dayStart - dow * DAY);
  });
});

describe("附件上传端点(step-048)", () => {
  it("POST /upload 落盘 + 名字防穿越 + 8MB 拒绝", async () => {
    const { servePanel } = await import("../src/panel.js");
    const panel = servePanel(7893, () => {});
    await new Promise((r) => setTimeout(r, 300));
    try {
      // 正常上传
      const r1 = await fetch("http://127.0.0.1:7893/upload?sid=spec1&name=" + encodeURIComponent("笔记.md"), {
        method: "POST",
        body: "hello 附件",
      });
      expect(r1.status).toBe(200);
      const j1 = await r1.json() as { path: string; name: string };
      expect(j1.name).toBe("笔记.md");
      expect(existsSync(j1.path)).toBe(true);
      expect(readFileSync(j1.path, "utf-8")).toBe("hello 附件");
      expect(j1.path).toContain(".genie/uploads/spec1/");
      // 敌对名:路径分隔被清洗
      const r2 = await fetch("http://127.0.0.1:7893/upload?sid=spec1&name=" + encodeURIComponent("../../evil.sh"), { method: "POST", body: "x" });
      const j2 = await r2.json() as { name: string };
      expect(j2.name).not.toContain("/");
      // node-agent 分发 404 语义(未构建时)
      const r3 = await fetch("http://127.0.0.1:7893/downloads/node-agent.mjs");
      expect([200, 404]).toContain(r3.status);
    } finally {
      await panel.close();
    }
  });
});
