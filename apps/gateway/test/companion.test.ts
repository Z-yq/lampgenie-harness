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

describe("协议:super 命令(step-1033 指挥台;companion.* 入站兼容)", () => {
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

describe("step-1033 指挥台 inbox 聚合(buildSuperInbox)", () => {
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
    expect(sid).toMatch(/^super:\d{8}$/);
    const evs = d.journal.readAll().filter((e) => e.sessionId === sid);
    expect(evs.some((e) => e.kind === "message.user")).toBe(true);
    expect(evs.some((e) => e.kind === "message.agent")).toBe(true);
    expect(evs.some((e) => e.kind === "turn.start")).toBe(true);
  }, 90_000);
});
