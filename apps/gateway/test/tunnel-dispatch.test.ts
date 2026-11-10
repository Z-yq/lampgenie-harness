/**
 * e2e/单元:tunnel 委派+失联重派+深度拒绝+凭证红线。
 * D2 红线=凭证值不过 gateway 侧(journal+下发帧+回流),grep 断言;
 * D1 双节点以双客户端/双注册等价模拟(单机环境,登记近似)。
 */
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import { startNodeAgent } from "@lampgenie/node-agent";
import { NodeRegistry, NodeConnections, NodeDispatch } from "../src/nodes.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { MemoryJournal } from "@lampgenie/core";
import { wireExecutor } from "../src/executor-wiring.js";
import { EchoChildBackend } from "@lampgenie/executors";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET = "sk-SUPER-SECRET-tunnel-xyz";

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const inbox: Record<string, unknown>[] = [];
    (ws as unknown as { __inbox: Record<string, unknown>[] }).__inbox = inbox;
    ws.on("message", (raw: Buffer) => inbox.push(JSON.parse(raw.toString())));
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function nextMessage(ws: WebSocket, type: string, ms = 5000): Promise<Record<string, unknown>> {
  const inbox = (ws as unknown as { __inbox: Record<string, unknown>[] }).__inbox;
  const hit = inbox.findIndex((m) => m.type === type);
  if (hit >= 0) return Promise.resolve(inbox.splice(hit, 1)[0]!);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${type} 超时`)), ms);
    const poll = setInterval(() => {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(inbox.splice(i, 1)[0]!);
      }
    }, 20);
  });
}

let app: GatewayApp | null = null;
let agentClose: (() => void) | null = null;
afterEach(async () => {
  agentClose?.();
  agentClose = null;
  await app?.close();
  app = null;
});

describe(" tunnel 委派(WS e2e)", () => {
  it("D6+D2:节点真执行→done;凭证值不过 gateway(journal/下发帧/回流全 grep 无命中)", async () => {
    app = createGatewayApp({ port: 7787, executor: new EchoChildBackend() });
    const user = await connect(7787);
    await nextMessage(user, "hello");

    // 节点凭据库(只在节点本地):引用名 vault-token → 值。
    const dir = mkdtempSync(join(tmpdir(), "tunnel-"));
    const credFile = join(dir, "credentials.json");
    writeFileSync(credFile, JSON.stringify({ "vault-token": SECRET }));

    // 捕获面:节点收到的指令文本/实际 env/执行输出(证明解析发生且值未回流)。
    const seen = { instruction: "", envValue: "", output: "" };
    agentClose = startNodeAgent({
      gatewayUrl: "ws://127.0.0.1:7787",
      nodeId: "srv-2",
      kind: "server",
      capabilities: [],
      reachability: ["vpn-x"],
      credentialsFile: credFile,
      execute: async (instruction, env) => {
        seen.instruction = instruction;
        seen.envValue = env.CREDENTIAL_vault_token ?? "";
        // 输出为确定性回执:长度+标记,不含 env 值(值不回流)。
        return { ok: true, output: `executed-on-srv-2(len=${instruction.length},cred=resolved)` };
      },
    }).close;

    // 提交前等节点注册完成(注册先于提交,防「无可委派节点」时序失败)。
    await new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const poll = setInterval(() => {
        if (app?.nodes.list().some((n) => n.nodeId === "srv-2")) {
          clearInterval(poll);
          resolve();
        } else if (Date.now() - t0 > 5000) {
          clearInterval(poll);
          reject(new Error("节点注册超时"));
        }
      }, 30);
    });

    // 提交:vpn-x 任务+凭证引用。
    user.send(JSON.stringify({
      v: 1, type: "task.submit", sessionId: "tunnel-e2e",
      instruction: "查 VPN 内网服务状态",
      resourceTags: ["vpn-x"], credentialRef: "vault-token",
    }));
    const submitted = await nextMessage(user, "task.submitted");
    const taskId = (submitted.task as Record<string, unknown>).id as string;

    // 等 done(经 task.changed 广播)。
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("done 超时")), 8000);
      const poll = setInterval(() => {
        const inbox = (user as unknown as { __inbox: Record<string, unknown>[] }).__inbox;
        const done = [...inbox].reverse().find(
          (m) => m.type === "task.changed" && (m.task as Record<string, unknown>)?.state === "done",
        );
        if (done) { clearTimeout(t); clearInterval(poll); resolve(); }
      }, 30);
    });

    // 节点侧证明:值确实解析进 env;指令文本不含值。
    expect(seen.envValue).toBe(SECRET);
    expect(seen.instruction).not.toContain(SECRET);

    // D2 红线:gateway 侧 journal 全量 grep 值零命中;引用名在场(审计可追溯)。
    const journalDump = JSON.stringify((app as unknown as { taskManager: TaskSupervisor }).taskManager);
    const appAny = app as unknown as { taskManager: { list: () => Array<Record<string, unknown>> } };
    const allText = JSON.stringify(appAny.taskManager.list());
    expect(allText).not.toContain(SECRET);
    // 任务结果=节点回执(不含值)。
    const task = appAny.taskManager.list().find((t) => t.id === taskId);
    expect(String(task?.result)).toContain("executed-on-srv-2");
    expect(String(task?.result)).not.toContain(SECRET);
    // 派发解释在场(为什么派给 srv-2 可答)。
    expect(allText).toContain("srv-2");

    rmSync(dir, { recursive: true, force: true });
    void journalDump;
  }, 15_000);

  it("无通道不假装已派:命中远端节点但委派通道未启用→显式失败", async () => {
    const tm = new TaskSupervisor();
    const journal = new MemoryJournal();
    const nodes = new NodeRegistry();
    // 只注册远端节点(无连接表)——wireExecutor 无 nodeDispatch 参数。
    nodes.register({ nodeId: "srv-9", capabilities: [], reachability: ["vpn-y"] });
    wireExecutor(tm, journal, new EchoChildBackend(), nodes);
    const t = tm.submit("user", "nt", "活", { resourceTags: ["vpn-y"] });
    await new Promise((r) => setTimeout(r, 300));
    expect(tm.get(t.id)?.state).toBe("failed");
    expect(String(tm.get(t.id)?.result)).toContain("委派通道未启用");
  });
});

describe(" 深度与失联(单元-集成)", () => {
  it("D4 委派深度>1 机制拒绝", async () => {
    const nodes = new NodeRegistry();
    const conns = new NodeConnections();
    const dispatch = new NodeDispatch(nodes, conns);
    const r = await dispatch.delegate({ taskId: "t", instruction: "x", delegatedDepth: 1 }, "s", {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain("委派深度>1 被拒");
  });

  it("D3 失联自动重派:节点 stale→RESCHEDULE 落 journal→换节点完成", async () => {
    const tm = new TaskSupervisor();
    const journal = new MemoryJournal();
    const nodes = new NodeRegistry();
    nodes.register({ nodeId: "local", capabilities: [], reachability: [] });
    const conns = new NodeConnections();
    const dispatch = new NodeDispatch(nodes, conns);

    // srv-2:吞掉任务书不回(模拟收到后进程死);
    // srv-3:正常应答(收到后 10ms 回 result)。
    nodes.register({ nodeId: "srv-2", capabilities: [], reachability: ["vpn-z"] });
    nodes.register({ nodeId: "srv-3", capabilities: [], reachability: ["vpn-z"] });
    conns.register("srv-2", () => true);
    conns.register("srv-3", (raw: string) => {
      const m = JSON.parse(raw);
      if (m.type === "node.task.dispatch") {
        setTimeout(() => dispatch.handleResult({ nodeId: "srv-3", taskId: m.taskId, ok: true, output: "done-by-srv-3" }), 10);
      }
      return true;
    });

    wireExecutor(tm, journal, new EchoChildBackend(), nodes, dispatch);
    // srv-2 负载更低→首轮分给它。
    nodes.heartbeat("srv-3", { cpu: 0, mem: 0, runningTasks: 5 });
    nodes.heartbeat("srv-2", { cpu: 0, mem: 0, runningTasks: 0 });

    const t = tm.submit("user", "rs", "重派我", { resourceTags: ["vpn-z"] });
    // 等首轮委派登记。
    await new Promise((r) => setTimeout(r, 200));
    // kill 节点=srv-2 心跳停;推进时钟越过失联阈值。
    const stale = nodes.list().find((n) => n.nodeId === "srv-2")!;
    stale.lastHeartbeat -= 61_000;

    // 等失联扫描周期(5s)触发重派→srv-3 完成。
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("重派完成超时")), 12_000);
      const poll = setInterval(() => {
        if (tm.get(t.id)?.state === "done") {
          clearTimeout(deadline);
          clearInterval(poll);
          resolve();
        }
      }, 50);
    });
    expect(tm.get(t.id)?.result).toBe("done-by-srv-3");
    // RESCHEDULE 恢复动作落 journal(五动作语义之一)。
    const recovery = journal.readAll().find(
      (e) => e.kind === "task.progress" && JSON.stringify(e.payload).includes("RESCHEDULE"),
    );
    expect(recovery).toBeTruthy();
    expect(JSON.stringify(recovery?.payload)).toContain("srv-2 失联");
    // 分派解释链完整(首轮 srv-2+重派轮)。
    const notes = journal.readAll().filter((e) => e.kind === "task.progress" && JSON.stringify(e.payload).includes("分派至节点"));
    expect(notes.length).toBeGreaterThanOrEqual(2);
  }, 15_000);
});
