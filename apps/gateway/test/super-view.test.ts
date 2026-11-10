/**
 * Super Agent 指挥台测试。
 * 背景(用户主诉「7700 super agent 无法聊天」的四个注意断点,本文件逐项锁回归):
 *   ① 聊天无持久化——widget 气泡内存态,刷新/重启即丢;此处锁「真实轮次完成 ⇒ journal 会话文件在盘」
 * (取证口径:.genie/llm-trace/super:<date> 目录是 companion.test.ts 的测试运行,生产环境从未跑过轮);
 *   ② widget 不消费 error 帧——失败时「思考中…」永不消失(super-console.js 静态断言);
 *   ③ super.turn.done 单发发起 socket——第二标签页等不到回复(真实 WS 双客户端断言广播);
 *   ④ 指挥台无独立聊天渲染区与看板(面板 PAGE 静态契约:#view-super + 四区 + 路由/WS 泵接线)。
 * 附:spawn_task group 透传与 task_resend 保组(联调聚类)、list_nodes 工具(跨机联调查对端)。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { FileJournal } from "@lampgenie/core";
import { EchoChildBackend } from "@lampgenie/executors";
import { servePanel } from "../src/panel.js";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import {
  runSuperAgentTurn, buildSuperAgentTools, superSessionId, type SuperAgentDeps,
} from "../src/super-agent.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { ProjectRegistry } from "../src/projects.js";
import { MemoryStore } from "@lampgenie/runtime/agent/soul-memory";

const fakeLlm = (reply = "测试回复文本") => ({ async chat() { return { content: reply }; } });

function deps(over: Partial<SuperAgentDeps> = {}): SuperAgentDeps & { taskManager: TaskSupervisor; projects: ProjectRegistry } {
  return {
    journal: new FileJournal(join(mkdtempSync(join(tmpdir(), "sup-deps-")), "gateway.jsonl"), { writeBehind: true, sharded: true }),
    taskManager: new TaskSupervisor(),
    projects: new ProjectRegistry(null),
    llm: fakeLlm(),
    ...over,
  };
}

// ── ① 磁盘持久化回归(生产环境同参 FileJournal;轮次完成⇒字节在盘) ─────────────────────
describe(" super 轮次磁盘持久化(FileJournal 生产环境同参)", () => {
  const OLD_ROOT = process.env.GENIE_REPO_ROOT;
  const ROOT = mkdtempSync(join(tmpdir(), "sup-disk-"));
  afterAll(() => {
    if (OLD_ROOT === undefined) delete process.env.GENIE_REPO_ROOT;
    else process.env.GENIE_REPO_ROOT = OLD_ROOT;
    try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
  });
  it("runSuperAgentTurn 完成 ⇒ sessions/super:<今日>.jsonl 在盘且可回读全轮事件", async () => {
    process.env.GENIE_REPO_ROOT = ROOT; // soul/llm-trace/repoRoot 全部指向临时根,不污染真仓
    const journalDir = join(ROOT, ".genie", "journals");
    mkdirSync(journalDir, { recursive: true });
    const journal = new FileJournal(join(journalDir, "gateway.jsonl"), { writeBehind: true, sharded: true });
    const d = deps({ journal });
    const soulStore = new MemoryStore(join(ROOT, ".genie", "soul", "memories-test"));
    const out = await runSuperAgentTurn(d, "现在有哪些工作区在干什么?", soulStore);
    expect(out.text).toContain("测试回复文本");
    const sid = superSessionId();
    const file = join(journalDir, "sessions", `${sid}.jsonl`);
    expect(existsSync(file), "轮次完成后会话文件必须已落盘(write-behind flush 兜底)").toBe(true);
    const evs = journal.readSession(sid);
    expect(evs.some((e) => e.kind === "turn.start")).toBe(true);
    expect(evs.some((e) => e.kind === "message.user")).toBe(true);
    expect(evs.some((e) => e.kind === "message.agent")).toBe(true);
    // 二次实例从盘回读(重启后历史可回放——view 聊天区持久化的根基)
    const journal2 = new FileJournal(join(journalDir, "gateway.jsonl"), { writeBehind: true, sharded: true });
    const again = journal2.readSession(sid);
    expect(again.some((e) => e.kind === "message.user")).toBe(true);
  }, 60_000);
});

// ── ② spawn_task group 透传 / task_resend 保组 / list_nodes ────────────────────────
describe(" 联调最小组件(group 透传 + list_nodes)", () => {
  function toolMap(d: SuperAgentDeps & { taskManager: TaskSupervisor }) {
    const soulStore = new MemoryStore(join(process.cwd(), ".genie", "soul", "memories-test"));
    return new Map(buildSuperAgentTools(d, soulStore).map((t) => [t.name, t] as [string, (typeof buildSuperAgentTools)[number]]));
  }
  it("spawn_task 带 group ⇒ Task.group 落表(看板按组聚类);task_resend 保持同组", async () => {
    const d = deps();
    const tools = toolMap(d);
    const r = await tools.get("spawn_task")!.execute({ instruction: "起本地 web 服务", projectId: "__harness__", title: "起服务", group: "联调-web" });
    expect(r).toContain("已派出任务");
    expect(r).toContain("联调-web");
    const t = d.taskManager.list().find((x) => x.title === "起服务");
    expect(t?.group).toBe("联调-web");
    d.taskManager.setState(d.taskManager.get(t!.id)!, "failed", "boom");
    const r2 = await tools.get("task_resend")!.execute({ query: "起服务", note: "再试一次" });
    expect(r2).toContain("已重发为新任务");
    const nt = d.taskManager.list().find((x) => x.title === "起服务(重发)");
    expect(nt?.group).toBe("联调-web");
  });
  it("list_nodes:注入返回节点清单;未注入如实告知不假造", async () => {
    const d1 = deps({ listNodes: () => [
      { nodeId: "win-pc", online: true, capabilities: ["shell"], reachability: ["lan"], runningTasks: 1 },
      { nodeId: "linux-srv", online: false, capabilities: [], reachability: [], runningTasks: 0 },
    ] });
    const out = JSON.parse(await toolMap(d1).get("list_nodes")!.execute({}) as string) as { id: string; online: boolean }[];
    expect(out.map((n) => n.id)).toEqual(["win-pc", "linux-srv"]);
    expect(out[0].online).toBe(true);
    const d2 = deps();
    expect(await toolMap(d2).get("list_nodes")!.execute({})).toContain("未接线");
  });
});

// ── ③ 真实 WS 网关:super.turn 双客户端广播(turn.user 与 turn.done 都到第二个客户端) ──
describe(" super.turn 双客户端广播(真实 WS 网关,echo 执行器+假 LLM)", () => {
  const WS_ROOT = mkdtempSync(join(tmpdir(), "sup-ws-"));
  const OLD_ROOT = process.env.GENIE_REPO_ROOT;
  const PORT = 7961;
  let app: GatewayApp | null = null;
  afterAll(async () => {
    if (OLD_ROOT === undefined) delete process.env.GENIE_REPO_ROOT;
    else process.env.GENIE_REPO_ROOT = OLD_ROOT;
    try { rmSync(WS_ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
  });
  it("客户端 A 发 super.turn ⇒ A、B 都收到 turn.user 与 turn.done;done 帧落盘可回放", async () => {
    process.env.GENIE_REPO_ROOT = WS_ROOT;
    app = createGatewayApp({
      port: PORT,
      executor: new EchoChildBackend(),
      journalDir: join(WS_ROOT, ".genie", "journals"),
      llm: fakeLlm("广播回复:已派出,完成会告诉你。") as never,
    });
    const mkClient = async () => {
      const ws = new WebSocket("ws://127.0.0.1:" + PORT);
      const inbox: Record<string, unknown>[] = [];
      ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
      await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
      return { ws, inbox };
    };
    const a = await mkClient();
    const b = await mkClient();
    a.ws.send(JSON.stringify({ v: 1, type: "super.turn", text: "现在系统状态如何?" }));
    const wait = async (box: Record<string, unknown>[], pred: (m: Record<string, unknown>) => boolean, label: string, timeout = 30_000) => {
      const t0 = Date.now();
      for (;;) {
        const hit = box.find(pred);
        if (hit) return hit;
        if (Date.now() - t0 > timeout) throw new Error("等待超时: " + label);
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    // turn.user:两端都到(既有行为,回归锚)
    await wait(a.inbox, (m) => m.type === "super.turn.user", "A turn.user");
    await wait(b.inbox, (m) => m.type === "super.turn.user", "B turn.user");
 // turn.done: 修复点——B(第二标签页)此前永远收不到
    const doneA = await wait(a.inbox, (m) => m.type === "super.turn.done", "A turn.done");
    const doneB = await wait(b.inbox, (m) => m.type === "super.turn.done", "B turn.done");
    expect(String(doneA.text)).toBe(String(doneB.text));
    a.ws.close(); b.ws.close();
    // journal 回放:轮次事件在盘(跨重启历史可回放)
    const sid = superSessionId();
    const file = join(WS_ROOT, ".genie", "journals", "sessions", `${sid}.jsonl`);
    expect(existsSync(file), "真实网关轮次完成后 journal 会话文件必须在盘").toBe(true);
    expect(readFileSync(file, "utf8")).toContain("现在系统状态如何?");
  }, 60_000);
});

// ── ④ 面板/资产/服务端源码静态契约 ────────────────────────────────────────────────
describe(" 指挥台 view 静态契约(面板 PAGE + widget + server 源码)", () => {
  const PORT = 7962;
  const panel = servePanel(PORT, () => { /* 不需要 WS */ });
  let pageHtml = "";
  let widgetJs = "";
  let serverSrc = "";
  beforeAll(async () => {
    pageHtml = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
    widgetJs = readFileSync(fileURLToPath(new URL("../src/assets/super-console.js", import.meta.url)), "utf8");
    serverSrc = readFileSync(fileURLToPath(new URL("../src/server.ts", import.meta.url)), "utf8");
  });
  afterAll(() => { try { panel.close(); } catch { /* 忽略 */ } });

  it("PAGE:#view-super 存在,聊天渲染区+composer+看板四区+侧栏入口齐备", () => {
    expect(pageHtml).toContain('id="view-super"');
    for (const id of ["superChatBody", "superInput", "superSend", "super-refresh", "superSidDay",
      "supInbox", "supProjects", "supActive", "supHealth", "supInboxCnt", "supActiveCnt"]) {
      expect(pageHtml).toContain(`id="${id}"`);
    }
    expect(pageHtml).toContain('id="act-super"');
    expect(pageHtml).toContain("待你处理"); // 看板①(人先行)
    expect(pageHtml).toContain("工作区 × 任务"); // 看板②
    expect(pageHtml).toContain("活跃任务流"); // 看板③
    expect(pageHtml).toContain("系统健康"); // 看板④
  });
  it("PAGE:路由接线(画布卡注册/loadViewData 分支/WS 泵早退/事件入口/卡内重排)", () => {
 // 二轮:画布卡注册——CV_CARDS + CV_VIEW_OF_CARD + 托盘映射
    expect(pageHtml).toContain('{ name: "super", node: "view-super", title: "指挥台 Super"');
    expect(pageHtml).toContain('usage: "usage", super: "super"'); // CV_VIEW_OF_CARD
    expect(pageHtml).toContain('super: "act-super"'); // CV_TRAY_ACT(画布托盘点亮)
    expect(pageHtml).toContain('if (name === "super") superViewLoad()');
    expect(pageHtml).toContain('if (name === "super") { try { supRenderBoard(); }'); // canvasAfterResize 卡内重排
    expect(pageHtml).toContain('m.type === "super.turn.done"'); // WS 泵早退分支
    expect(pageHtml).toContain('"genie:open-super"');
    expect(pageHtml).toContain('super: "指挥台 Super"'); // VIEW_NAMES(与 CV_CARDS.title 同串)
    // 聊天渲染区核心函数在场
    expect(pageHtml).toContain("function supApplyHistory");
    expect(pageHtml).toContain("function superOnMsg");
    expect(pageHtml).toContain("function supSend");
    expect(pageHtml).toContain('type: "super.turn", text }'); // 发送载荷
    expect(pageHtml).toContain('type: "ask.user.answer", requestId: it.requestId'); // 回答动作与 widget 同协议
    // 画布卡内布局:单列竖排(聊天上/看板下),经典宽屏双列
    expect(pageHtml).toContain("body.cv-shell #superLayout{grid-template-columns:1fr");
  });
  it("widget:error 帧显式消费 + 打开指挥台入口(super-failed 才渲染,无关错误不抢)", () => {
    expect(widgetJs).toContain('case "error"');
    expect(widgetJs).toContain("dropWait()");
    expect(widgetJs).toContain("super-failed");
    expect(widgetJs).toContain('data-act="open-view"');
    expect(widgetJs).toContain('window.switchView === "function"');
  });
  it("server:super.turn.done 已改广播(第二标签页可见);error 仍单发发起端", () => {
    expect(serverSrc).toContain('opts.broadcast?.({ v: PROTOCOL_VERSION, type: "super.turn.done"');
    expect(serverSrc).toContain('safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.SuperFailed');
  });
});
