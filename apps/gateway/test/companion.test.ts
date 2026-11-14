import { describe, it, expect } from "vitest";
import { parseClientMessage, ServerMessage, PROTOCOL_VERSION } from "@lampgenie/protocol";
import {
  superSessionId, buildSuperAgentSystem, buildSuperAgentTools, runSuperAgentTurn, globalStateSummary,
  matchTask, inferProject, buildTaskNotice, buildRelayText, userPreferenceSummary,
  SuperAgentActivity, SuperAgentChannel, buildSuperInbox, type SuperAgentDeps,
} from "../src/super-agent.js";
import type { Task } from "@lampgenie/core";
import { TaskSupervisor } from "../src/task-manager.js";
import { ProjectRegistry } from "../src/projects.js";
import { MemoryStore } from "@lampgenie/runtime/agent/soul-memory";
import { MemoryJournal } from "@lampgenie/core";
import { loadSoul, DEFAULT_SOUL_MD } from "@lampgenie/runtime/agent/soul-memory";
import { join } from "node:path";

/** 播报轮次异步跑(spawn 返回≠完成),且轮末收尾含 git 基线/账本耗时:轮询等终态事件。 */
const waitFor = async (fn: () => boolean, timeoutMs = 90_000): Promise<void> => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("协议:super 命令(指挥台;companion.* 入站兼容)", () => {
  it("super.* 受理;companion.* 入站仍受理(deprecated)", () => {
    expect(parseClientMessage('{"v":1,"type":"super.turn","text":"在干什么"}')?.type).toBe("super.turn");
    expect(parseClientMessage('{"v":1,"type":"super.history"}')?.type).toBe("super.history");
    expect(parseClientMessage('{"v":1,"type":"super.inbox","limit":5}')?.type).toBe("super.inbox");
    expect(parseClientMessage('{"v":1,"type":"voice.transcribe","audioB64":"AAA="}')?.type).toBe("voice.transcribe");
    expect(parseClientMessage('{"v":1,"type":"companion.turn","text":"在干什么"}')?.type).toBe("companion.turn");
    expect(parseClientMessage('{"v":1,"type":"companion.history"}')?.type).toBe("companion.history");
    expect(parseClientMessage('{"type":"super.turn","text":"x"}')).toBeNull();
  });
  it("voice.speak 已从 ClientMessage 联合移除(音频不再直入大脑)", () => {
    expect(parseClientMessage('{"v":1,"type":"voice.speak","audioB64":"AAA="}')).toBeNull();
  });
});

describe("协议:super 广播消息(出站只发 super.*)", () => {
  it("super.turn.user / super.turn.done 进 ServerMessage 联合;缺 text 拒绝", () => {
    const ok = ServerMessage.safeParse({ v: PROTOCOL_VERSION, type: "super.turn.user", text: "现在在干什么?" });
    expect(ok.success).toBe(true);
    const bad = ServerMessage.safeParse({ v: PROTOCOL_VERSION, type: "super.turn.user" });
    expect(bad.success).toBe(false);
    const done = ServerMessage.safeParse({ v: PROTOCOL_VERSION, type: "super.turn.done", text: "主仓 1 条", sessionId: "super:20261029" });
    expect(done.success).toBe(true);
  });
  it("voice.transcribe.result / super.inbox.changed / super.notice / super.inbox.result 在联合里", () => {
    expect(ServerMessage.safeParse({ v: PROTOCOL_VERSION, type: "voice.transcribe.result", text: "你好" }).success).toBe(true);
    expect(ServerMessage.safeParse({ v: PROTOCOL_VERSION, type: "super.inbox.changed" }).success).toBe(true);
    expect(ServerMessage.safeParse({ v: PROTOCOL_VERSION, type: "super.notice", text: "任务完成", taskId: "t1", state: "done" }).success).toBe(true);
    const inbox = ServerMessage.safeParse({ v: PROTOCOL_VERSION, type: "super.inbox.result", ts: 1, items: [{ id: "ask-1", kind: "ask", title: "做多大?", summary: "会话 ws-1", since: 1, actions: ["answer"] }] });
    expect(inbox.success).toBe(true);
  });
});

describe("协议:legacy companion.* 服务端消息仍在联合(服务端不再发出)", () => {
  it("companion.relay 进联合;缺 requestId/question 拒绝", () => {
    const ok = ServerMessage.safeParse({ v: PROTOCOL_VERSION, type: "companion.relay", requestId: "ask-1", sessionId: "s-1", question: "做多大?", options: ["全量", "最小"] });
    expect(ok.success).toBe(true);
    const bad = ServerMessage.safeParse({ v: PROTOCOL_VERSION, type: "companion.relay", sessionId: "s-1", question: "x" });
    expect(bad.success).toBe(false);
  });
  it("companion.notice 进联合;text 必填,taskId/state 可选", () => {
    const ok = ServerMessage.safeParse({ v: PROTOCOL_VERSION, type: "companion.notice", text: "任务「x」已完成", taskId: "t1", state: "done" });
    expect(ok.success).toBe(true);
    const bad = ServerMessage.safeParse({ v: PROTOCOL_VERSION, type: "companion.notice" });
    expect(bad.success).toBe(false);
  });
});

function deps(llmReply = "好的,我看了一下,主仓刚完成一个任务。"): SuperAgentDeps & { taskManager: TaskSupervisor; projects: ProjectRegistry; journal: MemoryJournal } {
  const taskManager = new TaskSupervisor();
  const projects = new ProjectRegistry(null);
  const journal = new MemoryJournal();
  return { taskManager, projects, journal, llm: { async chat() { return { content: llmReply }; } } };
}

describe("companion system 组装(D3 + fixC1/C4)", () => {
  it("含 SOUL/记忆块/工作区清单/最近任务/调度纪律;coding 轨不再含记忆块(P4)", () => {
    const d = deps();
    const soulStore = new MemoryStore(join(process.cwd(), ".genie", "soul", "memories-test"));
    const sys = buildSuperAgentSystem(d, soulStore);
    expect(sys).toContain(loadSoul(join(process.cwd(), ".genie", "soul")).content || DEFAULT_SOUL_MD);
    expect(sys).toContain("当前工作区与状态");
    expect(sys).toContain("Super Agent 指挥台");
    expect(sys).toContain("__harness__");
    // 全局摘要含最近任务
    d.taskManager.submit("user", "s-x", "修复登录 bug", { title: "修登录" });
    expect(globalStateSummary(d)).toContain("修登录");
  });
  it("fixC1: Routing 纪律四要素(三路判定/不铺垫/accepted≠完成/多意图)+指代消解+全权声明", () => {
    const d = deps();
    const soulStore = new MemoryStore(join(process.cwd(), ".genie", "soul", "memories-test"));
    const sys = buildSuperAgentSystem(d, soulStore);
    expect(sys).toContain("路由三判定");
    expect(sys).toContain("直接答");
    expect(sys).toContain("专用工具查");
    expect(sys).toContain("派后台任务");
    expect(sys).toContain("调工具前不口头铺垫");
    expect(sys).toContain("accepted≠完成");
    expect(sys).toContain("逐项处理");
    expect(sys).toContain("指代消解");
    expect(sys).toContain("直接执行"); // 全权:操作不请示
    expect(sys).toContain("不直接写代码"); // 红线保留
    expect(sys).toContain("指令层级"); // fixC4
  });
  it("fixC4: 用户偏好摘要——USER 库偏好句注入,非偏好句与环境笔记不进该块", () => {
    const dir = join(process.cwd(), ".genie", "soul", "memories-pref-test-" + Date.now());
    const soulStore = new MemoryStore(dir);
    soulStore.add("user", "用户偏好用中文回复");
    soulStore.add("user", "住在杭州,养了一只猫");
    soulStore.add("memory", "项目用 pnpm");
    const block = userPreferenceSummary(soulStore);
    expect(block).toContain("用户偏好用中文回复");
    expect(block).not.toContain("养了一只猫");
    expect(block).not.toContain("pnpm");
    expect(buildSuperAgentSystem(deps(), soulStore)).toContain("用户偏好摘要");
  });
});

describe("调度工具面(D2 六件 + fixC2 生命周期件)", () => {
  async function toolMap(d: ReturnType<typeof deps>, extra?: Partial<SuperAgentDeps>) {
    const soulStore = new MemoryStore(join(process.cwd(), ".genie", "soul", "memories-test"));
    const merged: SuperAgentDeps = { ...d, ...extra };
    return new Map(buildSuperAgentTools(merged, soulStore).map((t) => [t.name, t] as [string, (typeof buildSuperAgentTools)[number]]));
  }
  it("六件保留:project_add/spawn_task/list_projects/list_tasks/task_cancel(升级)/project_remove", async () => {
    const d = deps();
    const tools = await toolMap(d);
    // project_add
    const add = await tools.get("project_add")!.execute({ path: process.cwd() });
    expect(add).toContain("已添加工作区");
    // spawn_task 带 projectId
    const spawn = await tools.get("spawn_task")!.execute({ instruction: "梳理调用链", projectId: "__harness__", title: "梳理调用链" });
    expect(spawn).toContain("已派出任务");
    const spawned = d.taskManager.list().find((t) => t.title === "梳理调用链");
    expect(spawned?.projectId).toBe("__harness__");
    // list_projects 含该任务
    const list = await tools.get("list_projects")!.execute({});
    expect(String(list)).toContain("梳理调用链");
    // list_tasks / task_cancel(fixC2:按 id 前缀同样可取消)
    const lt = JSON.parse(await tools.get("list_tasks")!.execute({})) as { id: string; state: string }[];
    expect(lt.some((x) => x.state === "queued" || x.state === "running")).toBe(true);
    const cancel = await tools.get("task_cancel")!.execute({ query: spawned!.id.slice(0, 8) });
    expect(cancel).toContain("已取消任务");
    // project_remove
    const pid = d.projects.list().find((p) => p.id !== "__harness__")!.id;
    expect(await tools.get("project_remove")!.execute({ id: pid })).toContain("已移除工作区");
  });
  it("fixC3: spawn_task 语义路由——任务书点名工作区自动路由;未点名落主仓并说明", async () => {
    const d = deps();
    d.projects.add(process.cwd()); // label=basename(cwd)
    const label = d.projects.list().find((p) => p.id !== "__harness__")!.label;
    const tools = await toolMap(d);
    const r1 = await tools.get("spawn_task")!.execute({ instruction: `帮我在 ${label} 里加一个部署脚本检查`, title: "部署检查" });
    expect(r1).toContain("已派出任务");
    const routed = d.taskManager.list().find((t) => t.title === "部署检查");
    expect(routed?.projectId).toBe(d.projects.list().find((p) => p.id !== "__harness__")!.id);
    expect(r1).toContain("已派出≠完成"); // accepted≠完成的工具侧回执
    const r2 = await tools.get("spawn_task")!.execute({ instruction: "随便看看主仓结构", title: "看结构" });
    expect(r2).toContain("__harness__");
    expect(r2).toContain("未点名项目");
  });
  it("fixC3: inferProject 最长命中优先且主仓不参与", () => {
    const d = deps();
    expect(inferProject(d.projects, "harness 主仓的任务")).toBeUndefined();
  });
  it("fixC2: task_status 按名片段匹配——状态+白板+最近事件;task_result 终态摘要 400 字截断", async () => {
    const d = deps();
    const t0 = d.taskManager.submit("user", "ws-a", "修复语音桥延迟", { title: "修桥" });
    d.journal.append({ kind: "message.agent", sessionId: "ws-a", payload: { text: "已定位到桥侧 flush" } });
    const done = d.taskManager.setState(d.taskManager.get(t0.id)!, "done", "x".repeat(600));
    const tools = await toolMap(d);
    const st = JSON.parse(await tools.get("task_status")!.execute({ query: "修桥" }) as string);
    expect(st.state).toBe("done");
    expect(st.title).toContain("修桥");
    expect(JSON.stringify(st.recent)).toContain("桥侧 flush");
    const r = await tools.get("task_result")!.execute({ query: "修桥" });
    expect(r).toContain("(done)结果:");
    expect((r as string).length).toBeLessThan(500); // 400 字截断生效
    // 非终态任务
    d.taskManager.submit("user", "ws-b", "跑通回归", { title: "回归" });
    const r2 = await tools.get("task_result")!.execute({ query: "回归" });
    expect(r2).toContain("尚无最终结果");
  });
  it("fixC2: task_resend 按原任务书重发(带补充);task_cancel 终态任务不重复取消", async () => {
    const d = deps();
    const t0 = d.taskManager.submit("user", "ws-c", "修A", { title: "修A" });
    d.taskManager.setState(d.taskManager.get(t0.id)!, "failed", "model_not_found");
    const tools = await toolMap(d);
    const r = await tools.get("task_resend")!.execute({ query: "修A", note: "模型已换成 x" });
    expect(r).toContain("已重发为新任务");
    const nt = d.taskManager.list().filter((t) => t.id !== t0.id && t.instruction.includes("修A"));
    expect(nt.length).toBe(1);
    expect(nt[0]!.instruction).toContain("模型已换成 x");
    // 原任务(failed)按会话 id 片段定位→终态不重复取消;新任务(queued)可正常取消
    const again = await tools.get("task_cancel")!.execute({ query: "ws-c" });
    expect(again).toContain("已是终态");
    const cancelNew = await tools.get("task_cancel")!.execute({ query: "修A(重发)" });
    expect(cancelNew).toContain("已取消任务");
  });
  it("fixC2: recall_tasks 接 session_search——关键词找历史会话", async () => {
    const d = deps();
    d.journal.append({ kind: "message.user", sessionId: "ws-old", payload: { text: "帮我把番茄识别的阈值调到 5.0" } });
    d.journal.append({ kind: "message.agent", sessionId: "ws-old", payload: { text: "已调,kitchen 组 5.0" } });
    const tools = await toolMap(d);
    const r = JSON.parse(await tools.get("recall_tasks")!.execute({ query: "番茄 阈值" }) as string);
    const s = JSON.stringify(r);
    expect(s).toContain("ws-old");
  });
  it("fixC5: relay_answer 回交——成功/失效(先答先用)", async () => {
    const d = deps();
    const answered: [string, string][] = [];
    const tools = await toolMap(d, { askAnswer: (rid, ans) => { answered.push([rid, ans]); return answered.length === 1; } });
    const ok = await tools.get("relay_answer")!.execute({ requestId: "ask-1", answer: "选全量" });
    expect(ok).toContain("已交回");
    const stale = await tools.get("relay_answer")!.execute({ requestId: "ask-1", answer: "再答" });
    expect(stale).toContain("已失效");
  });
  it("fixC2: matchTask 多命中取最近更新", async () => {
    const d = deps();
    const a = d.taskManager.submit("user", "w1", "同名任务早期", { title: "同名任务" });
    d.taskManager.setState(d.taskManager.get(a.id)!, "done", "r1");
    await new Promise((r) => setTimeout(r, 6)); // updatedAt 毫秒级,拉开时间序
    const b = d.taskManager.submit("user", "w2", "同名任务晚期", { title: "同名任务" });
    expect(matchTask(d.taskManager, "同名任务")!.id).toBe(b.id);
    expect(matchTask(d.taskManager, "w1")!.id).toBe(a.id);
    expect(matchTask(d.taskManager, "")).toBeUndefined();
  });
});

describe("fixC6: 终态播报通道(SuperAgentChannel)", () => {
  function channel(llmReply = "任务完成了,跟你说过会播报。") {
    const d = deps(llmReply);
    const soulStore = new MemoryStore(join(process.cwd(), ".genie", "soul", "memories-test"));
    const activity = new SuperAgentActivity();
    const sent: Record<string, unknown>[] = [];
    const ch = new SuperAgentChannel(d, soulStore, { activity, broadcast: (m) => sent.push(m) });
    return { d, soulStore, activity, sent, ch };
  }
  function doneTask(tm: TaskSupervisor, title: string, state: "done" | "failed" | "cancelled" = "done", result = "结果摘要"): Task {
    const t = tm.submit("user", `ws-${title}`, `指令-${title}`, { title });
    return tm.setState(tm.get(t.id)!, state, result);
  }

  it("终态注入 journal+广播;同任务同状态只播一次(节流)", async () => {
    const { d, sent, ch } = channel();
    const t = doneTask(d.taskManager, "任务甲");
    ch.onTaskChanged(t);
    ch.onTaskChanged(t); // 重复(如 rename 再 emit)不再播
    const notices = sent.filter((m) => m.type === "super.notice");
    expect(notices.length).toBe(1);
    const evs = d.journal.readAll().filter((e) => e.kind === "super.notice");
    expect(evs.length).toBe(1);
    expect(String((evs[0]!.payload as { text: string }).text)).toContain("任务甲");
  });
  it("非终态不播;failed 播报带建议(model_not_found→换模型)", () => {
    const { d, sent, ch } = channel();
    const running = d.taskManager.submit("user", "ws-r", "还在跑", { title: "还在跑" });
    ch.onTaskChanged(running);
    expect(sent.length).toBe(0);
    const f = doneTask(d.taskManager, "任务乙", "failed", "Error: model_not_found qwen-max");
    ch.onTaskChanged(f);
    const notice = sent.find((m) => m.type === "super.notice") as { text: string };
    expect(notice.text).toContain("已失败");
    expect(notice.text).toContain("换模型"); // failureAdvice 命中
  });
  it("活跃→主动出一轮播报(super.turn.done);不活跃→只留痕不出轮", async () => {
    const { d, activity, sent, ch } = channel("播报:任务丁完成了。");
    // 不活跃:不触发轮次
    ch.onTaskChanged(doneTask(d.taskManager, "任务丙"));
    await new Promise((r) => setTimeout(r, 30));
    expect(sent.some((m) => m.type === "super.turn.done")).toBe(false);
    // 活跃:标记后触发
    activity.mark();
    ch.onTaskChanged(doneTask(d.taskManager, "任务丁"));
    await waitFor(() => sent.some((m) => m.type === "super.turn.done"));
    const done = sent.find((m) => m.type === "super.turn.done") as { text: string };
    expect(done.text).toContain("任务丁完成");
    // 播报轮次的输入落 super 会话(message.user 可见)
    const sid = superSessionId();
    expect(d.journal.readAll().some((e) => e.sessionId === sid && e.kind === "message.user" && String((e.payload as { text?: string }).text).includes("[系统通知]"))).toBe(true);
  }, 90_000);
  it("管家自操作(task_cancel)→通知照落但不重复播报轮次", async () => {
    const { d, activity, sent, ch } = channel();
    activity.mark();
    const t = doneTask(d.taskManager, "任务戊", "cancelled", "user-cancel");
    ch.markSelfManaged(t.id);
    ch.onTaskChanged(t);
    await new Promise((r) => setTimeout(r, 30));
    expect(sent.some((m) => m.type === "super.notice")).toBe(true);
    expect(sent.some((m) => m.type === "super.turn.done")).toBe(false);
  });
});

describe("fixC5: ask_user 转接(SuperAgentChannel.relayAsk)", () => {
  it("落 journal(super.relay)+广播 super.relay;活跃→指挥台出一轮转述", async () => {
    const d = deps("转述:coding 助手问你要全量还是最小?");
    const soulStore = new MemoryStore(join(process.cwd(), ".genie", "soul", "memories-test"));
    const activity = new SuperAgentActivity();
    const sent: Record<string, unknown>[] = [];
    const ch = new SuperAgentChannel(d, soulStore, { activity, broadcast: (m) => sent.push(m) });
    activity.mark();
    ch.relayAsk({ requestId: "ask-9", sessionId: "ws-x", question: "按完整推断范围做还是只做字面举例?", options: ["完整范围", "只做字面"], context: "任务书提到三个模块" });
    await waitFor(() => sent.some((m) => m.type === "super.turn.done"));
    const relay = sent.find((m) => m.type === "super.relay") as { requestId: string; question: string; options?: string[] };
    expect(relay.requestId).toBe("ask-9");
    expect(relay.options).toEqual(["完整范围", "只做字面"]);
    const done = sent.find((m) => m.type === "super.turn.done") as { text: string };
    expect(done.text).toContain("coding 助手问");
    const evs = d.journal.readAll().filter((e) => e.kind === "super.relay");
    expect(evs.length).toBe(1);
    expect(String((evs[0]!.payload as { text: string }).text)).toContain("requestId=ask-9");
    // 下一轮 system 可见(fixC5/C6 的「近期系统注入」块)
    expect(buildSuperAgentSystem(d, soulStore)).toContain("requestId=ask-9");
  }, 90_000);
  it("不活跃→只留痕,不出轮(面板问答条仍是第一通道)", async () => {
    const d = deps();
    const soulStore = new MemoryStore(join(process.cwd(), ".genie", "soul", "memories-test"));
    const sent: Record<string, unknown>[] = [];
    const ch = new SuperAgentChannel(d, soulStore, { activity: new SuperAgentActivity(), broadcast: (m) => sent.push(m) });
    ch.relayAsk({ requestId: "ask-8", sessionId: "ws-y", question: "要不要带附件?" });
    await new Promise((r) => setTimeout(r, 30));
    expect(sent.some((m) => m.type === "super.relay")).toBe(true);
    expect(sent.some((m) => m.type === "super.turn.done")).toBe(false);
  });
  it("buildRelayText 带 requestId/选项;buildTaskNotice failed 附建议、done 不附", () => {
    expect(buildRelayText({ requestId: "r1", question: "Q", options: ["a", "b"] })).toContain("requestId=r1");
    expect(buildTaskNotice({ id: "t", sessionId: "s", instruction: "i", state: "failed", result: "model_not_found", createdAt: 0, updatedAt: 0 } as Task)).toContain("建议");
    expect(buildTaskNotice({ id: "t", sessionId: "s", instruction: "i", state: "done", result: "ok", createdAt: 0, updatedAt: 0 } as Task)).not.toContain("建议:");
  });
});

describe(" 指挥台 inbox 聚合(buildSuperInbox)", () => {
  it("ask/permission/interrupted/blocked/failed 五类各一;排序 head 升序 + failed 末尾降序", () => {
    const d = deps();
    const now = Date.UTC(2026, 9, 29, 12, 0, 0);
    const tInt = d.taskManager.submit("user", "ws-i", "被中断的任务书", { title: "被中断的" });
    d.taskManager.setState(d.taskManager.get(tInt.id)!, "interrupted");
    const tBlocked = d.taskManager.submit("user", "ws-b", "阻塞任务书", { title: "阻塞的" });
    d.taskManager.setState(d.taskManager.get(tBlocked.id)!, "blocked");
    const tFailed = d.taskManager.submit("user", "ws-f", "失败任务书", { title: "失败的" });
    d.taskManager.setState(d.taskManager.get(tFailed.id)!, "failed", "Error: boom");
    const items = buildSuperInbox({ taskManager: d.taskManager }, {
      now,
      asks: [{ requestId: "ask-1", sessionId: "ws-a", question: "做多大范围?", options: ["全量", "最小"], since: 300 }],
      permissions: [{ requestId: "perm-1", sessionId: "ws-p", tool: "shell", summary: "rm -rf build", risk: "high", since: 400 }],
      tasks: d.taskManager.list(),
    });
    const kinds = items.map((i) => i.kind);
    expect(kinds).toContain("ask");
    expect(kinds).toContain("permission");
    expect(kinds).toContain("interrupted");
    expect(kinds).toContain("blocked");
    expect(kinds).toContain("failed");
    // id 稳定口径
    expect(items.find((i) => i.kind === "ask")!.id).toBe("ask-ask-1");
    expect(items.find((i) => i.kind === "permission")!.id).toBe("perm-perm-1");
    expect(items.find((i) => i.kind === "interrupted")!.id).toBe(`task-${tInt.id}`);
    // 排序:head 按 since 升序,failed 在末尾
    const failedIdx = kinds.indexOf("failed");
    expect(failedIdx).toBe(kinds.length - 1);
    const headSince = items.slice(0, failedIdx).map((i) => i.since);
    expect([...headSince].sort((a, b) => a - b)).toEqual(headSince);
    // actions 按契约
    expect(items.find((i) => i.kind === "ask")!.actions).toContain("answer");
    expect(items.find((i) => i.kind === "permission")!.actions).toContain("approve");
    expect(items.find((i) => i.kind === "interrupted")!.actions).toContain("resume");
  });
  it("limit 截断(默认 30,显式 limit 生效);24h 外 failed 不入 inbox", () => {
    const d = deps();
    const now = Date.UTC(2026, 9, 29, 12, 0, 0);
    const t = d.taskManager.submit("user", "ws-old", "很老的失败任务", { title: "老失败" });
    d.taskManager.setState(d.taskManager.get(t.id)!, "failed", "old");
    const asks = Array.from({ length: 5 }, (_, i) => ({ requestId: `a${i}`, sessionId: "ws", question: `问题${i}`, since: 100 + i }));
    expect(buildSuperInbox({ taskManager: d.taskManager }, { now, asks, tasks: [] }).length).toBe(5);
    expect(buildSuperInbox({ taskManager: d.taskManager }, { now, asks, tasks: [] }, 2).length).toBe(2);
    // now 前进 25h:该 failed 落后于 24h 窗口 → 不入
    expect(buildSuperInbox({ taskManager: d.taskManager }, { now: Date.now() + 25 * 3600_000, asks: [], tasks: d.taskManager.list() }).length).toBe(0);
  });
  it("标题/摘要按契约截断(≤60 / ≤200)", () => {
    const d = deps();
    const items = buildSuperInbox({ taskManager: d.taskManager }, {
      asks: [{ requestId: "a", sessionId: "ws", question: "长".repeat(300), since: 1 }],
      tasks: [],
    });
    expect(items[0]!.title.length).toBeLessThanOrEqual(60);
    expect(items[0]!.summary.length).toBeLessThanOrEqual(200);
  });
});

describe("companion 全轮(D1)", () => {
  it("runSuperAgentTurn:journal 落 super agent sid,返回文本", async () => {
    const d = deps();
    const soulStore = new MemoryStore(join(process.cwd(), ".genie", "soul", "memories-test"));
    const out = await runSuperAgentTurn(d, "现在有哪些工作区在干什么?", soulStore);
    expect(out.text).toContain("主仓");
    const sid = superSessionId();
    expect(sid).toBe("super"); // 固定持久会话 "super"(旧按天日卷格式退役)
    const evs = d.journal.readAll().filter((e) => e.sessionId === sid);
    expect(evs.some((e) => e.kind === "message.user")).toBe(true);
    expect(evs.some((e) => e.kind === "message.agent")).toBe(true);
    expect(evs.some((e) => e.kind === "turn.start")).toBe(true);
  }, 90_000);
});

describe("系统管理面(全系统管理者:sys_status/sys_config/sys_provider)", () => {
  interface FakeCfg { providers: Array<Record<string, unknown>>; coding?: { llm?: Record<string, unknown> }; webSearch?: { enabled?: boolean } }
  function sysDeps(mutate?: (c: FakeCfg) => void, seen?: { patch?: unknown }) {
    const base: FakeCfg = {
      providers: [
        { id: "maas-bj", name: "百炼", baseUrl: "https://dashscope.example/v1", apiKeyEnv: "DASHSCOPE_API_KEY", models: ["qwen-max", "qwen-plus"] },
        { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.example/v1", models: [] },
      ],
      coding: { llm: { providerId: "maas-bj", model: "qwen-plus", baseUrl: "https://dashscope.example/v1" } },
    };
    if (mutate) mutate(base);
    const d = deps();
    d.sysAdmin = {
      configView: () => ({ config: base, readOnly: false }),
      configSet: (patch) => { if (seen) seen.patch = patch; return { applied: ["providers"], needsRestart: [] }; },
      secretKeys: () => ["DASHSCOPE_API_KEY"],
      listModels: async (providerId) => { if (providerId === "maas-bj") return ["qwen-max", "qwen-plus", "qwen-turbo"]; throw new Error("401 unauthorized"); },
    };
    return { d, base };
  }
  async function tm2(d: SuperAgentDeps) {
    const soulStore = new MemoryStore(join(process.cwd(), ".genie", "soul", "memories-test"));
    return new Map(buildSuperAgentTools(d, soulStore).map((t) => [t.name, t] as [string, (typeof buildSuperAgentTools)[number]]));
  }
  it("三件在场;未接线时如实回话不假造", async () => {
    const bare = deps();
    const tools = await tm2(bare);
    expect(tools.has("sys_status")).toBe(true);
    expect(tools.has("sys_config")).toBe(true);
    expect(tools.has("sys_provider")).toBe(true);
    expect(String(await tools.get("sys_config")!.execute({ action: "get" }))).toContain("未接线");
    expect(String(await tools.get("sys_provider")!.execute({ action: "list" }))).toContain("未接线");
  });
  it("sys_status:任务分布/服务商凭证在场(env+secrets 双源)/生效模型/只读态", async () => {
    const { d } = sysDeps();
    d.taskManager.submit("user", "s-1", "修 A", { title: "A" });
    const r = JSON.parse(String(await (await tm2(d)).get("sys_status")!.execute({})));
    expect(r.tasks.running + r.tasks.queued + r.tasks.done).toBeGreaterThanOrEqual(1);
    expect(r.providers).toHaveLength(2);
    expect(r.providers[0]).toMatchObject({ id: "maas-bj", keyEnv: "DASHSCOPE_API_KEY", keyPresent: true, models: 2 });
    expect(r.providers[1].keyPresent).toBe(false);
    expect(r.effectiveCoding).toMatchObject({ providerId: "maas-bj", model: "qwen-plus" });
    expect(r.readOnly).toBe(false);
    expect(String(r.uptimeMin)).toMatch(/^\d+$/);
  });
  it("sys_config:get 打码密钥字段;set 拒疑似密钥值、透传补丁回执", async () => {
    const { d } = sysDeps((c) => { (c.providers[0] as Record<string, unknown>).secret = "sk-xxx"; });
    const tools = await tm2(d);
    const got = String(await tools.get("sys_config")!.execute({ action: "get" }));
    expect(got).toContain("«不回显»");
    expect(got).not.toContain("sk-xxx");
 // set:密钥值字段直接拒
    const refused = String(await tools.get("sys_config")!.execute({ action: "set", patch: { webSearch: { apiToken: "sk-live-123" } } }));
    expect(refused).toContain("拒改疑似密钥字段");
    expect(refused).toContain("webSearch.apiToken");
 // set:正常补丁透传,回执带 applied
    const seen: { patch?: unknown } = {};
    const { d: d2 } = sysDeps(undefined, seen);
    const okr = JSON.parse(String(await (await tm2(d2)).get("sys_config")!.execute({ action: "set", patch: { webSearch: { enabled: true } } })));
    expect(okr.applied).toContain("providers"); // 夹具回执固定值;断言透传链路在
    expect((seen.patch as Record<string, unknown>).webSearch).toEqual({ enabled: true });
  });
  it("sys_provider:list 目录+模型名归一;probe 成功/失败如实;set 增量合并并可切生效轨;apiKeyEnv 拒 key 值", async () => {
    const seen: { patch?: unknown } = {};
    const { d } = sysDeps(undefined, seen);
    const tools = await tm2(d);
    const list = JSON.parse(String(await tools.get("sys_provider")!.execute({ action: "list" })));
    expect(list.providers[0].models).toEqual(["qwen-max", "qwen-plus"]);
    expect(list.effectiveCoding.model).toBe("qwen-plus");
    const probeOk = JSON.parse(String(await tools.get("sys_provider")!.execute({ action: "probe", providerId: "maas-bj" })));
    expect(probeOk).toMatchObject({ ok: true, providerId: "maas-bj" });
    expect(probeOk.models).toContain("qwen-turbo");
    const probeBad = JSON.parse(String(await tools.get("sys_provider")!.execute({ action: "probe", providerId: "deepseek" })));
    expect(probeBad.ok).toBe(false);
    expect(probeBad.error).toContain("401");
 // apiKeyEnv 传疑似 key 值 → 拒
    const refused = String(await tools.get("sys_provider")!.execute({ action: "set", providerId: "x", entry: { baseUrl: "https://x/v1", apiKeyEnv: "sk-abc123" } }));
    expect(refused).toContain("疑似密钥值");
 // set:新条目 + setEffective 切生效轨(模型取目录首个)
    const r = JSON.parse(String(await tools.get("sys_provider")!.execute({
      action: "set", providerId: "volc", setEffective: true,
      entry: { name: "火山", baseUrl: "https://ark.example/v1", apiKeyEnv: "ARK_API_KEY", models: ["doubao-pro"] },
    })));
    expect(r.applied).toContain("providers");
    const patch = seen.patch as { providers: Array<Record<string, unknown>>; coding?: { llm?: Record<string, unknown> } };
    expect(patch.providers).toHaveLength(3); // 旧 2 + 新 1(增量合并不覆盖旧表)
    const added = patch.providers.find((p) => p.id === "volc") as Record<string, unknown>;
    expect(added).toMatchObject({ name: "火山", baseUrl: "https://ark.example/v1", apiKeyEnv: "ARK_API_KEY", models: ["doubao-pro"] });
    expect(patch.coding!.llm).toMatchObject({ providerId: "volc", model: "doubao-pro", baseUrl: "https://ark.example/v1", apiKeyEnv: "ARK_API_KEY" });
 // set:已存在条目按 id 合并(改名不丢 baseUrl/models)
    const { d: d3 } = sysDeps(undefined, seen);
    await (await tm2(d3)).get("sys_provider")!.execute({ action: "set", providerId: "deepseek", entry: { name: "深度求索" } });
    const patch2 = seen.patch as { providers: Array<Record<string, unknown>> };
    const ds = patch2.providers.find((p) => p.id === "deepseek") as Record<string, unknown>;
    expect(ds.name).toBe("深度求索");
    expect(ds.baseUrl).toBe("https://api.deepseek.example/v1");
  });
  it("纪律文本:全系统管理者口径 + 密钥红线在场", () => {
    const soulStore = new MemoryStore(join(process.cwd(), ".genie", "soul", "memories-test"));
    const sys = buildSuperAgentSystem(deps(), soulStore);
    expect(sys).toContain("系统管理面");
    expect(sys).toContain("全系统管理者");
    expect(sys).toContain("API Key 值永不进对话");
    expect(sys).toContain("不把「已写入」说成「已生效」");
  });
});

describe("系统管理面二期(sys_logs/sys_restart)", () => {
  function sysDeps2(extra: Partial<NonNullable<SuperAgentDeps["sysAdmin"]>>, taskStates: string[] = []) {
    const d = deps();
    for (const st of taskStates) {
      const t = d.taskManager.submit("user", "s-" + st, "任务 " + st, { title: st });
      if (st === "running") (t as unknown as { state: string }).state = "running";
    }
    d.sysAdmin = {
      configView: () => ({ config: {}, readOnly: false }),
      configSet: () => ({ applied: [] }),
      secretKeys: () => [],
      listModels: async () => [],
      ...extra,
    };
    return d;
  }
  async function tm3(d: SuperAgentDeps) {
    const soulStore = new MemoryStore(join(process.cwd(), ".genie", "soul", "memories-test"));
    return new Map(buildSuperAgentTools(d, soulStore).map((t) => [t.name, t] as [string, (typeof buildSuperAgentTools)[number]]));
  }
  it("sys_logs:未接线如实;错误过滤/行数钳制/单行截断", async () => {
    const bare = deps();
    expect(String(await (await tm3(bare)).get("sys_logs")!.execute({}))).toContain("未接线");
    const lines = ["[ok] boot fine", "[error] ECONNREFUSED 127.0.0.1:8105", "[warn] x".repeat(400), "[gateway] uncaught TypeError boom"];
    const d = sysDeps2({ logTail: (n) => ({ file: "/x/.genie/logs/gateway.log.1-2", lines: lines.slice(-n) }) });
    const tools = await tm3(d);
    const all = String(await tools.get("sys_logs")!.execute({ lines: 999 }));
    expect(all).toContain("gateway.log.1-2");
    expect(all).toContain("boot fine");
    expect(all).toContain("…"); // 超长行截断
    const errs = String(await tools.get("sys_logs")!.execute({ filter: "errors" }));
    expect(errs).toContain("ECONNREFUSED");
    expect(errs).toContain("uncaught TypeError");
    expect(errs).not.toContain("boot fine");
    expect(errs).not.toContain("[warn]");
  });
  it("sys_restart:未接线/未确认/活跃任务三道门 + 确认后接线回调与审计话术", async () => {
    const bare = deps();
    expect(String(await (await tm3(bare)).get("sys_restart")!.execute({ confirm: true }))).toContain("未接线");
    const calls: string[] = [];
    const d = sysDeps2({ restart: (reason) => { calls.push(reason); return { ok: true }; } });
    const tools = await tm3(d);
 // ① 未确认 → 指引先征得用户同意
    const noConfirm = String(await tools.get("sys_restart")!.execute({ reason: "配置生效" }));
    expect(noConfirm).toContain("未确认");
    expect(calls).toHaveLength(0);
 // ② 活跃任务 → 拒(即使确认)
    const dRunning = sysDeps2({ restart: (r) => { calls.push(r); return { ok: true }; } }, ["running"]);
    const tools2 = await tm3(dRunning);
    const refused = String(await tools2.get("sys_restart")!.execute({ confirm: true, reason: "配置生效" }));
    expect(refused).toContain("拒绝重启");
    expect(calls).toHaveLength(0);
 // ③ 确认 + 0 活跃 → 执行并带看门狗/重连话术
    const ok = String(await tools.get("sys_restart")!.execute({ confirm: true, reason: "模型配置生效" }));
    expect(ok).toContain("已安排重启");
    expect(ok).toContain("看门狗");
    expect(calls).toEqual(["模型配置生效"]);
 // ④ 回调失败如实透传
    const dFail = sysDeps2({ restart: () => ({ ok: false, error: "复核竞态" }) });
    const fail = String(await (await tm3(dFail)).get("sys_restart")!.execute({ confirm: true }));
    expect(fail).toContain("重启安排失败:复核竞态");
  });
  it("纪律文本:日志诊断与重启纪律在场", () => {
    const soulStore = new MemoryStore(join(process.cwd(), ".genie", "soul", "memories-test"));
    const sys = buildSuperAgentSystem(deps(), soulStore);
    expect(sys).toContain("sys_logs");
    expect(sys).toContain("重启纪律");
    expect(sys).toContain("不许派任务去 kill 进程");
  });
});

describe("sys_rsi(RSI 机制体检摘要)", () => {
  it("未接线如实;摘要文本透传;采集异常如实报错", async () => {
    const soulStore = new MemoryStore(join(process.cwd(), ".genie", "soul", "memories-test"));
    const mk = async (rsi?: () => Promise<string>) => {
      const d = deps();
      d.sysAdmin = { configView: () => ({}), configSet: () => ({ applied: [] }), secretKeys: () => [], listModels: async () => [], ...(rsi ? { rsiSummary: rsi } : {}) };
      return new Map(buildSuperAgentTools(d, soulStore).map((t) => [t.name, t] as [string, (typeof buildSuperAgentTools)[number]]));
    };
    const bare = await mk();
    expect(String(await bare.get("sys_rsi")!.execute({}))).toContain("未接线");
    const ok = await mk(async () => "RSI 机制体检摘要:10/12 区正常\n- 区A(异常) — 异常条目 1:某问题\n- 区B");
    const r = String(await ok.get("sys_rsi")!.execute({}));
    expect(r).toContain("10/12 区正常");
    expect(r).toContain("区A(异常)");
    const boom = await mk(async () => { throw new Error("journal busy"); });
    expect(String(await boom.get("sys_rsi")!.execute({}))).toContain("采集失败");
    expect(String(await boom.get("sys_rsi")!.execute({}))).toContain("journal busy");
  });
  it("纪律文本:机制体检路由锚在场", () => {
    const sys = buildSuperAgentSystem(deps(), new MemoryStore(join(process.cwd(), ".genie", "soul", "memories-test")));
    expect(sys).toContain("sys_rsi");
    expect(sys).toContain("系统自检机制");
  });
});

describe("派发承诺——亲自派出的任务终态必播(不随活跃窗过期)", () => {
  it("spawn_task 登记 markDispatched;超窗终态仍播报;播后集合清空", async () => {
    const soulStore = new MemoryStore(join(process.cwd(), ".genie", "soul", "memories-test"));
    const d = deps();
    const activity = new SuperAgentActivity();
    const announced: string[] = [];
    const ch = new SuperAgentChannel(d, soulStore, {
      activity,
      broadcast: (m) => { if ((m as { type?: string }).type === "super.turn.done") announced.push(String((m as { text?: string }).text ?? "")); },
    });
    const tools = new Map(buildSuperAgentTools({ ...d, channel: ch }, soulStore).map((t) => [t.name, t] as [string, (typeof buildSuperAgentTools)[number]]));
 // ① spawn_task 派出 → markDispatched 登记
    const r = String(await tools.get("spawn_task")!.execute({ instruction: "测试任务甲", title: "甲" }));
    expect(r).toContain("已派出任务");
    const t0 = d.taskManager.list().find((t) => String(t.title) === "甲")!;
    expect(t0).toBeTruthy();
 // ② 活跃窗完全过期(最后活跃在 1 小时前)→ 终态仍要播(承诺优先)
    activity.mark();
    const stale = new Date(Date.now() - 3600_000).getTime();
 // @ts-expect-error 测试注入:把 lastAt 拨回 1 小时前
    (activity as unknown as { lastAt: number }).lastAt = stale;
    expect(activity.active()).toBe(false); // 前置:活跃窗确实已过期
 // 直接走通道终态路径:模拟任务完成(TaskManager finish 走 onChange 链)
 // @ts-expect-error 测试注入:调用私有 finish 太重,直接触发 onTaskChanged 等价终态
    (d.taskManager as unknown as { listeners?: Set<(t: unknown) => void> });
 // TaskManager 完成:submit 后立即置 done 会走 notify;用任务对象克隆置 done 直推 onTaskChanged
    ch.onTaskChanged({ ...t0, state: "done", result: "ok" } as never);
    await new Promise((res) => setTimeout(res, 50)); // notice 同步落
    const notices = d.journal.readAll().filter((e) => e.kind === "super.notice" && String((e.payload as { taskId?: string }).taskId ?? "").startsWith(t0.id.slice(0, 8)));
    expect(notices.length).toBe(1);
 // ③ 未派出且超窗的外部任务 → 不播(notice 照落)
    const ext = d.taskManager.submit("user", "s-ext", "外部任务乙", { title: "乙" });
    ch.onTaskChanged({ ...ext, state: "done", result: "ok" } as never);
    for (let i = 0; i < 80 && announced.length === 0; i++) await new Promise((res) => setTimeout(res, 500)); // 播报轮=真实 AgentLoop(假 LLM),秒级
    const extNotices = d.journal.readAll().filter((e) => e.kind === "super.notice" && String((e.payload as { taskId?: string }).taskId ?? "") === ext.id);
    expect(extNotices.length).toBe(1); // notice 落了
    expect(announced.length).toBe(1); // 但只有派发任务甲触发了播报轮(乙超窗未派出→静默)
    expect(typeof announced[0]).toBe("string"); // 播报文本由 LLM 生成(夹具假回复),只断言播报轮发生
  }, 60_000);
});

describe("Super 上下文经济面(coding 同源)", () => {
  it("contextEconomy 三件透传 AgentLoop(compactHook 每步被调,sessionId=super)", async () => {
    const d = deps();
    const hookCalls: Array<{ sid: string; opts?: { reason?: string } }> = [];
    d.contextEconomy = {
      compactHook: async (j, sid, opts) => { hookCalls.push({ sid, opts }); },
      microcompact: { thresholdTokens: 1000 },
      spill: { dir: "/tmp/super-spill-test" },
    };
    const soulStore = new MemoryStore(join(process.cwd(), ".genie", "soul", "memories-test"));
    const r = await runSuperAgentTurn(d, "只回一句话", soulStore);
    expect(r.text.length).toBeGreaterThan(0);
    expect(hookCalls.length).toBeGreaterThanOrEqual(1); // loop 每步前调 hook(由实现方判定阈值)
    expect(hookCalls[0].sid).toBe("super");
  }, 60_000);
  it("未注入=零行为差异(hook 不被调,轮次照常)", async () => {
    const d = deps(); // 不带 contextEconomy
    const soulStore = new MemoryStore(join(process.cwd(), ".genie", "soul", "memories-test"));
    const r = await runSuperAgentTurn(d, "只回一句话", soulStore);
    expect(r.text.length).toBeGreaterThan(0);
  }, 60_000);
});
