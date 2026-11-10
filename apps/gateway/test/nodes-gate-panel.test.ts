/**
 * step-1042 节点 Fleet + 关卡 Gate 丰满测试。
 * 覆盖:①纯函数(pickLanAddress LAN 推导/riskOfTool 启发式/sampleLoad 界内)②broker 决议 ring
 * +onSettle(offline 不入账)③nodes.dispatch nodeId 精确钉选④真实 WS 网关:假节点注册→nodes.changed
 * 广播→node.exec 真路由(dispatch 下发→result 回流→node.exec.result)、离线显式错、local 照旧任务链、
 * permission.history 形状⑤协议新消息⑥面板/源码静态契约(Fleet/Gate 区块+WS 泵新分支+统一应答口)。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import { parseClientMessage, ServerMessage, PROTOCOL_VERSION } from "@lampgenie/protocol";
import { createGatewayApp } from "../src/app.js";
import { pickLanAddress } from "../src/remote-wizard.js";
import { sampleLoad } from "../src/load-sample.js";
import { riskOfTool } from "../src/agent-wiring.js";
import { PermissionBroker } from "../src/permission-broker.js";
import { NodeRegistry } from "../src/nodes.js";
import { servePanel } from "../src/panel.js";

// ── ① 纯函数 ──────────────────────────────────────────────────────────────────
describe("step-1042 纯函数(LAN 推导/风险启发/负载采样)", () => {
  it("pickLanAddress:私网段优先;env 一票覆盖;无命中回退 127.0.0.1", () => {
    const ifaces = [
      { name: "lo", address: "127.0.0.1", internal: true, family: "IPv4" },
      { name: "eth0", address: "192.168.1.10", internal: false, family: "IPv4" },
      { name: "docker0", address: "172.17.0.1", internal: false, family: "IPv4" },
      { name: "ext", address: "8.8.8.8", internal: false, family: "IPv4" },
    ];
    expect(pickLanAddress(ifaces)).toBe("192.168.1.10"); // 私网优先于公网
    expect(pickLanAddress([{ name: "ext", address: "8.8.8.8", internal: false, family: "IPv4" }])).toBe("8.8.8.8"); // 无私网取首个非 internal
    expect(pickLanAddress(ifaces, "gw.example.com")).toBe("gw.example.com"); // env 一票覆盖
    expect(pickLanAddress([{ name: "lo", address: "127.0.0.1", internal: true, family: "IPv4" }])).toBe("127.0.0.1"); // 全无=回退
  });
  it("riskOfTool:写/执行族 high;只读族 low;其余 medium(只影响展示,不改审批行为)", () => {
    expect(riskOfTool("edit_file")).toBe("high");
    expect(riskOfTool("terminal")).toBe("high");
    expect(riskOfTool("annotate_submit")).toBe("high");
    expect(riskOfTool("read_file")).toBe("low");
    expect(riskOfTool("code_sense")).toBe("low");
    expect(riskOfTool("spawn_subagent")).toBe("medium");
    expect(riskOfTool("")).toBe("medium");
  });
  it("sampleLoad:cpu/mem ∈ [0,1],runningTasks 透传", () => {
    const s = sampleLoad(3);
    expect(s.cpu).toBeGreaterThanOrEqual(0);
    expect(s.cpu).toBeLessThanOrEqual(1);
    expect(s.mem).toBeGreaterThanOrEqual(0);
    expect(s.mem).toBeLessThanOrEqual(1);
    expect(s.runningTasks).toBe(3);
  });
});

// ── ② broker 决议 ring + onSettle ─────────────────────────────────────────────
describe("step-1042 broker 历史面(onSettle + recent ring)", () => {
  it("panel 应答与超时都入账并触发 onSettle;offline/policy 直通不入账;history 截尾", async () => {
    const b = new PermissionBroker(80);
    const seen: { requestId: string; by: string }[] = [];
    b.onSettle = (item) => seen.push({ requestId: item.requestId, by: item.by });
    b.online = true;
    const p1 = b.ask({ requestId: "r1", sessionId: "s1", tool: "terminal", summary: "rm -rf build" });
    b.respond("r1", "reject");
    const o1 = await p1;
    expect(o1.decision).toBe("reject");
    const p2 = b.ask({ requestId: "r2", sessionId: "s2", tool: "edit_file", summary: "写文件" });
    const o2 = await p2; // 80ms 超时自动拒
    expect(o2.by).toBe("timeout");
    expect(b.history().map((h) => h.requestId)).toEqual(["r1", "r2"]);
    expect(seen.map((s) => s.requestId)).toEqual(["r1", "r2"]);
    expect(b.history()[0].settledAt).toBeGreaterThanOrEqual(b.history()[0].since);
    // offline:不广播不挂起 → 不入账(用户从未见过这条 ask)
    b.online = false;
    await b.ask({ requestId: "r3", sessionId: "s3", tool: "x", summary: "y" });
    expect(b.history().map((h) => h.requestId)).toEqual(["r1", "r2"]);
    // limit 截尾
    expect(b.history(1).map((h) => h.requestId)).toEqual(["r2"]);
  });
});

// ── ③ nodes.dispatch nodeId 精确钉选 ──────────────────────────────────────────
describe("step-1042 nodes.dispatch nodeId 钉选(node.exec 真路由地基)", () => {
  it("nodeId 命中在线节点;钉选不在线节点=null;不钉选照旧负载最低优先", () => {
    const nodes = new NodeRegistry();
    nodes.register({ nodeId: "n1", capabilities: ["shell"], reachability: ["lan"] });
    nodes.register({ nodeId: "n2", capabilities: ["shell"], reachability: ["lan"] });
    nodes.heartbeat("n1", { cpu: 0.1, mem: 0.2, runningTasks: 5 }); // n1 负载(排序键=runningTasks)高
    nodes.heartbeat("n2", { cpu: 0.9, mem: 0.5, runningTasks: 0 }); // n2 runningTasks=0 → 不钉选时优先
    expect(nodes.dispatch({ nodeId: "n1" })?.nodeId).toBe("n1"); // 钉选无视负载排序
    expect(nodes.dispatch({})?.nodeId).toBe("n2"); // 不钉选=负载最低优先
    expect(nodes.dispatch({ nodeId: "ghost" })).toBeNull();
  });
});

// ── ④ 真实 WS 网关:假节点全链 ─────────────────────────────────────────────────
describe("step-1042 node.exec 真路由 + nodes.changed(真实 WS 网关)", () => {
  const ROOT = mkdtempSync(join(tmpdir(), "nodes-gate-ws-"));
  const OLD_ROOT = process.env.GENIE_REPO_ROOT;
  const PORT = 7963;
  afterAll(async () => {
    if (OLD_ROOT === undefined) delete process.env.GENIE_REPO_ROOT;
    else process.env.GENIE_REPO_ROOT = OLD_ROOT;
    try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
  });
  it("假节点注册→主 WS 收 nodes.changed;node.exec 下发→假节点收 dispatch→回流→node.exec.result;离线显式错;local 照旧任务链", async () => {
    process.env.GENIE_REPO_ROOT = ROOT;
    const app = createGatewayApp({ port: PORT, journalDir: join(ROOT, ".genie", "journals") });
    const mk = async () => {
      const ws = new WebSocket("ws://127.0.0.1:" + PORT);
      const inbox: Record<string, unknown>[] = [];
      ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
      await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
      return { ws, inbox };
    };
    const main = await mk();
    const wait = async (box: Record<string, unknown>[], pred: (m: Record<string, unknown>) => boolean, label: string, timeout = 20_000) => {
      const t0 = Date.now();
      for (;;) {
        const hit = box.find(pred);
        if (hit) return hit;
        if (Date.now() - t0 > timeout) throw new Error("等待超时: " + label);
        await new Promise((r) => setTimeout(r, 40));
      }
    };
    // 假节点连接并注册
    const node = await mk();
    node.ws.send(JSON.stringify({ v: 1, type: "node.register", nodeId: "win-pc", capabilities: ["shell"], reachability: ["lan"] }));
    await wait(node.inbox, (m) => m.type === "node.registered", "node.registered");
    // 主 WS 收到 nodes.changed(注册广播)
    await wait(main.inbox, (m) => m.type === "nodes.changed", "nodes.changed on register");
    // 主 WS 拉清单:win-pc 在场且在线
    main.ws.send(JSON.stringify({ v: 1, type: "nodes.list" }));
    const listed = await wait(main.inbox, (m) => m.type === "nodes.list.result", "nodes.list.result");
    const row = (listed.nodes as { nodeId: string; online: boolean; load: { cpu: number } }[]).find((n) => n.nodeId === "win-pc");
    expect(row?.online).toBe(true);
    // node.exec → 假节点收 dispatch → 回流 → node.exec.result
    main.ws.send(JSON.stringify({ v: 1, type: "node.exec", nodeId: "win-pc", command: "echo hi-on-node" }));
    const dispatch = await wait(node.inbox, (m) => m.type === "node.task.dispatch", "dispatch");
    expect(String(dispatch.instruction)).toBe("echo hi-on-node");
    node.ws.send(JSON.stringify({ v: 1, type: "node.task.result", nodeId: "win-pc", taskId: dispatch.taskId, ok: true, output: "hi-on-node" }));
    const execRes = await wait(main.inbox, (m) => m.type === "node.exec.result", "node.exec.result");
    expect(execRes.ok).toBe(true);
    expect(String(execRes.output)).toContain("hi-on-node");
    expect(execRes.nodeId).toBe("win-pc");
    // 离线节点:显式错(不假装已派)
    main.ws.send(JSON.stringify({ v: 1, type: "node.exec", nodeId: "ghost", command: "x" }));
    const err = await wait(main.inbox, (m) => m.type === "error" && m.code === "node-offline", "NodeOffline");
    expect(String(err.message)).toContain("ghost");
    // local 照旧走任务链(task.submitted,targetNode=local)
    main.ws.send(JSON.stringify({ v: 1, type: "node.exec", nodeId: "local", command: "本机命令" }));
    const submitted = await wait(main.inbox, (m) => m.type === "task.submitted", "task.submitted local");
    expect((submitted.task as { targetNode?: string }).targetNode).toBe("local");
    // permission.history 形状(无决议=空数组回包;ring 语义由 broker 单测锁)
    main.ws.send(JSON.stringify({ v: 1, type: "permission.history", limit: 20 }));
    const hist = await wait(main.inbox, (m) => m.type === "permission.history.result", "permission.history.result");
    expect(Array.isArray(hist.items)).toBe(true);
    main.ws.close(); node.ws.close();
    void app;
  }, 45_000);
});

// ── ⑤ 协议新消息 ──────────────────────────────────────────────────────────────
describe("step-1042 协议:nodes/permission 新消息", () => {
  it("permission.history 入站;nodes.changed/permission.resolved/permission.history.result/node.exec.result 出站", () => {
    expect(parseClientMessage('{"v":1,"type":"permission.history","limit":20}')?.type).toBe("permission.history");
    expect(parseClientMessage('{"v":1,"type":"permission.history","limit":0}')).toBeNull(); // limit 正整数约束
    expect(ServerMessage.safeParse({ v: PROTOCOL_VERSION, type: "nodes.changed" }).success).toBe(true);
    expect(ServerMessage.safeParse({ v: PROTOCOL_VERSION, type: "permission.resolved", requestId: "r1", decision: "allow-once", by: "timeout" }).success).toBe(true);
    expect(ServerMessage.safeParse({ v: PROTOCOL_VERSION, type: "permission.resolved", requestId: "r1", decision: "other" }).success).toBe(false);
    expect(ServerMessage.safeParse({ v: PROTOCOL_VERSION, type: "permission.history.result", items: [] }).success).toBe(true);
    expect(ServerMessage.safeParse({ v: PROTOCOL_VERSION, type: "node.exec.result", nodeId: "n1", ok: true, output: "hi" }).success).toBe(true);
    expect(ServerMessage.safeParse({ v: PROTOCOL_VERSION, type: "node.exec.result", nodeId: "n1" }).success).toBe(false); // ok 必填
  });
});

// ── ⑥ 面板/源码静态契约 ──────────────────────────────────────────────────────
describe("step-1042 面板静态契约(Fleet/Gate 区块+WS 泵+统一应答口)+源码锚", () => {
  const PORT = 7964;
  const panel = servePanel(PORT, () => { /* 纯静态 */ });
  let pageHtml = "";
  let wiringSrc = "";
  beforeAll(async () => {
    pageHtml = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
    wiringSrc = readFileSync(fileURLToPath(new URL("../src/agent-wiring.ts", import.meta.url)), "utf8");
  });
  afterAll(() => { try { panel.close(); } catch { /* 忽略 */ } });
  it("Gate 视图:头部计数/批量按钮/TTL/会话链接/最近决定/空态用户文案", () => {
    for (const id of ["approvalsCount"]) expect(pageHtml).toContain(`id="${id}"`);
    for (const s of ["id=\"apAllowAll\"", "id=\"apRejectAll\"", "data-apopen", "gate-ttl", "最近决定(", "自动拒绝(fail-closed:宁拒不悬)", "permRespondUnified"]) {
      expect(pageHtml).toContain(s);
    }
  });
  it("Fleet 视图:概要/节点卡/命令下发/输出回显/远程项目/接入指引", () => {
    for (const s of ["data-nodeexec", "data-nodecmd", "data-nodeout", "data-remotedeploy", "nodesOpenRemote", "接入新节点", "远程项目", "nodeOutHtml", "nodes.changed"]) {
      expect(pageHtml).toContain(s);
    }
    expect(pageHtml).toContain('m.type === "node.exec.result"'); // WS 泵新分支
    expect(pageHtml).toContain('m.type === "permission.resolved"');
    expect(pageHtml).toContain('m.type === "nodes.changed"');
    expect(pageHtml).toContain('m.type === "permission.history.result"');
    expect(pageHtml).toContain("timeoutMs: m.timeoutMs || 60000"); // ask 入队带 TTL
  });
  it("agent-wiring:主链路两处 ask 已接 riskOfTool(不再硬编码 medium)", () => {
    expect(wiringSrc).toContain("riskOfTool(call.name)");
    expect(wiringSrc).toContain("risk: riskOfTool(tool)");
    expect(wiringSrc).not.toContain('risk: "medium"');
  });
});
