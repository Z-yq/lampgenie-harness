/**
 * 人改板 → 派活只传变更集(2026-10)+ 按节点选区派发 单测:
 * 背景:board.continue 旧实现把整板 nodes.slice(0,30) 全塞给 agent(无 diff、>30 静默截断),
 * 人只改了 2 个节点也得让 agent 重读整板。修法:
 * ① board.save 记录人工改动集 doc.humanEdits({ids, rev, changes});
 * ② board.continue 优先=人选区 msg.nodeIds,其次=humanEdits.ids,都没有才回退整板(指令显式注明);
 * ③ 变更节点每行后加「改动:」概括(字段级摘要由 server 侧比较得出);
 * ④ 派发成功即清空 humanEdits(避免同一次人工改动被反复派下去);
 * ⑤ 幂等键带选区(同一 rev 下不同选区是两个意图,不能被 C7 去重掉)。
 */
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { saveBoard, loadBoard, computeHumanEdits } from "../src/board-store.js";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import { EchoChildBackend } from "@lampgenie/executors";
import { repoRoot } from "../src/repo-root.js";

/** 三节点基线板:A节点/B节点/C节点(名字刻意互不为子串,便于断言「派发集只含哪些」)。 */
function baseDoc(sessionId: string, taskId: string) {
  return {
    version: 1 as const, taskId, sessionId, title: "变更集派发板", status: "draft" as const, rev: 0,
    nodes: [
      { id: "a", kind: "module" as const, label: "A节点", summary: "做A", change: "add" as const, flow: [] },
      { id: "b", kind: "module" as const, label: "B节点", summary: "做B", change: "add" as const, flow: [] },
      { id: "c", kind: "module" as const, label: "C节点", summary: "做C", change: "add" as const, flow: [] },
    ],
    edges: [], planned_files: [], updatedAt: 0,
  };
}

let apps: GatewayApp[] = [];
const sids: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const sid of sids.splice(0)) rmSync(join(repoRoot(), ".genie", "boards", sid), { recursive: true, force: true });
});

function newSid(tag: string): string {
  const sid = `vitest-board-delta-${tag}-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  sids.push(sid);
  return sid;
}

const wait = (inbox: Record<string, unknown>[], pred: (m: Record<string, unknown>) => boolean, tag = "", ms = 20000) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const cursor = inbox.length;
    const t = setTimeout(() => reject(new Error("等消息超时 " + tag)), ms);
    const poll = setInterval(() => {
      const hit = inbox.slice(cursor).find(pred);
      if (hit) { clearTimeout(t); clearInterval(poll); resolve(hit); }
    }, 30);
  });

/** 起一个真实 gateway + 一条 WS(照 board.test.ts 的轻量风格,不造重型 mock)。 */
async function connect(port: number): Promise<{ ws: WebSocket; inbox: Record<string, unknown>[] }> {
  const app = createGatewayApp({ port, executor: new EchoChildBackend() });
  apps.push(app);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox: Record<string, unknown>[] = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
  await new Promise((r) => ws.on("open", r));
  return { ws, inbox };
}

/** 发一条 board.save(人改板)并等 board.doc 回执,返回落盘后的板(含 humanEdits)。 */
async function humanSave(
  ws: WebSocket, inbox: Record<string, unknown>[], sid: string, tid: string, doc: Record<string, unknown>, baseRev: number): Promise<{ rev: number; humanEdits?: { ids: string[]; rev: number; changes?: Record<string, string[]> } }> {
  ws.send(JSON.stringify({ v: 1, type: "board.save", sessionId: sid, taskId: tid, doc, baseRev }));
  const got = await wait(inbox, (m) => m.type === "board.doc" && (m.doc as { rev?: number })?.rev === baseRev + 1, "board.save");
  return got.doc as { rev: number; humanEdits?: { ids: string[]; rev: number; changes?: Record<string, string[]> } };
}

/** 发 board.continue(可带选区),返回注入给 agent 的指令。
 * 游标在 send **之前**取:被幂等去重时服务端仍会重发 task.submitted(同一个任务 id),
 * 所以这里不能过滤「已见过的 id」——只取本次 send 之后到达的回执。 */
async function continueBoard(
  ws: WebSocket, inbox: Record<string, unknown>[], sid: string, tid: string, nodeIds?: string[],
): Promise<{ instruction: string; taskId: string }> {
  const cursor = inbox.length;
  ws.send(JSON.stringify({ v: 1, type: "board.continue", sessionId: sid, taskId: tid, ...(nodeIds ? { nodeIds } : {}) }));
  const got = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("等消息超时 board.continue")), 20000);
    const poll = setInterval(() => {
      const hit = inbox.slice(cursor).find((m) => m.type === "task.submitted");
      if (hit) { clearTimeout(deadline); clearInterval(poll); resolve(hit); }
    }, 30);
  });
  const task = got.task as { id: string; instruction: string };
  return { instruction: task.instruction, taskId: task.id };
}

describe("computeHumanEdits(纯函数:字段比较口径)", () => {
  const prev = baseDoc("s", "t").nodes;
  it("新增节点与语义字段变化都算;pos/done 变化不算;评论文本变化算", () => {
    // 只拖位置 + 推进度 → 不算人工改动(画布回写 vs agent 进度,不是设计变更)
    expect(computeHumanEdits(prev, [{ ...prev[0]!, pos: { x: 9, y: 9 }, done: true }], 1).ids).toEqual([]);
    // 改 summary + 新增 d → 两条,顺序=入参顺序
    const r = computeHumanEdits(prev, [{ ...prev[0]!, summary: "做A2" }, prev[1]!, prev[2]!, { id: "d", label: "D", summary: "dd" }], 7);
    expect(r.ids).toEqual(["a", "d"]);
    expect(r.rev).toBe(7);
    expect(r.changes.a).toEqual(["summary"]);
    expect(r.changes.d).toEqual(["新增节点"]);
    // 评论变化也算(人整板保存时带进来的评论文本)
    expect(computeHumanEdits(prev, [{ ...prev[0]!, comments: ["这里要改"] }], 1).ids).toEqual(["a"]);
  });
});

describe("人改板 → 派活只传变更集(board.continue)", () => {
  it("① 人改 2 个节点后保存:续作指令只含这 2 个节点(不含未改节点),每个带「改动:」行", async () => {
    const sid = newSid("d1");
    const rr = repoRoot();
    expect(saveBoard(rr, baseDoc(sid, "td1")).ok).toBe(true);
    const { ws, inbox } = await connect(7841);
    // 人改板:a 改 label+summary,c 只改 summary(经 board.save,带 baseRev 乐观锁)
    const base = baseDoc(sid, "td1");
    const doc = await humanSave(ws, inbox, sid, "td1", {
      ...base,
      nodes: [
        { ...base.nodes[0]!, label: "A节点改", summary: "做A改" },
        base.nodes[1]!,
        { ...base.nodes[2]!, summary: "做C改" },
      ],
    }, 0);
    expect(doc.rev).toBe(1);
    expect(doc.humanEdits?.ids).toEqual(["a", "c"]); // 变更集:只有人真改过的两个
    expect(loadBoard(rr, sid, "td1")?.humanEdits?.ids).toEqual(["a", "c"]);
    const { instruction } = await continueBoard(ws, inbox, sid, "td1");
    expect(instruction).toContain("A节点改");
    expect(instruction).toContain("做C改"); // c 只改了 summary(label 仍是「C节点」)
    expect(instruction).toContain("C节点");
    expect(instruction).not.toContain("B节点"); // 未改节点不派
    expect(instruction).toContain("人工改动的 2 个节点");
    expect(instruction).toContain("改动:label/summary 有改动");
    expect(instruction).toContain("改动:summary 有改动");
    ws.close();
  }, 20000);

  it("② 无人工改动(旧板/直接落盘)→ 回退整板派发,指令注明「整板派发」", async () => {
    const sid = newSid("d2");
    expect(saveBoard(repoRoot(), baseDoc(sid, "td2")).ok).toBe(true);
    const { ws, inbox } = await connect(7842);
    const { instruction } = await continueBoard(ws, inbox, sid, "td2");
    expect(instruction).toContain("整板派发");
    expect(instruction).toContain("未检测到人工改动");
    for (const label of ["A节点", "B节点", "C节点"]) expect(instruction).toContain(label);
    expect(instruction).not.toContain("改动:"); // 整板派发不编造「改动」行
    ws.close();
  }, 20000); // drvfs 高载下任务立起可超 9s,与 ①④⑤ 同口径(默认 5s 单跑实测 5.6s 贴线)

  it("③ 显式传 nodeIds(选区派发)→ 以选区为准,优先于 humanEdits", async () => {
    const sid = newSid("d3");
    const rr = repoRoot();
    expect(saveBoard(rr, baseDoc(sid, "td3")).ok).toBe(true);
    const { ws, inbox } = await connect(7843);
    const base = baseDoc(sid, "td3");
    const doc = await humanSave(ws, inbox, sid, "td3", {
      ...base, nodes: [{ ...base.nodes[0]!, summary: "做A改" }, base.nodes[1]!, base.nodes[2]!],
    }, 0);
    expect(doc.humanEdits?.ids).toEqual(["a"]); // 板上记着人工改动 a
    const { instruction } = await continueBoard(ws, inbox, sid, "td3", ["b"]); // 人从界面选了 b
    expect(instruction).toContain("B节点");
    expect(instruction).not.toContain("A节点"); // humanEdits 里的 a 不派
    expect(instruction).toContain("选区派发");
    expect(instruction).not.toContain("整板派发");
    ws.close();
  }, 20000); // 同②:drvfs 高载下任务立起可超 9s,与 ①④⑤ 同口径

  it("④ 派发成功即清空 humanEdits:再派一次回退整板", async () => {
    const sid = newSid("d4");
    const rr = repoRoot();
    expect(saveBoard(rr, baseDoc(sid, "td4")).ok).toBe(true);
    const { ws, inbox } = await connect(7844);
    const base = baseDoc(sid, "td4");
    await humanSave(ws, inbox, sid, "td4", {
      ...base, nodes: [{ ...base.nodes[0]!, summary: "做A改" }, base.nodes[1]!, base.nodes[2]!],
    }, 0);
    const first = await continueBoard(ws, inbox, sid, "td4");
    expect(first.instruction).toContain("人工改动的 1 个节点");
    expect(first.instruction).not.toContain("B节点");
    // 清空落盘(rev 不变:清空是记账不是改板)
    const after = loadBoard(rr, sid, "td4");
    expect(after?.humanEdits).toEqual({ ids: [], rev: 1 });
    expect(after?.rev).toBe(1);
    // 再派一次:无人工改动 → 整板
    const second = await continueBoard(ws, inbox, sid, "td4");
    expect(second.taskId).not.toBe(first.taskId);
    expect(second.instruction).toContain("整板派发");
    expect(second.instruction).toContain("B节点");
    ws.close();
  }, 25000);

  it("⑤ 幂等键:同 rev 同选区只开一个任务;同 rev 不同选区各开一个", async () => {
    const sid = newSid("d5");
    expect(saveBoard(repoRoot(), baseDoc(sid, "td5")).ok).toBe(true);
    const { ws, inbox } = await connect(7845);
    const one = await continueBoard(ws, inbox, sid, "td5", ["b"]);
    const again = await continueBoard(ws, inbox, sid, "td5", ["b"]); // 双击/重发同选区
    expect(again.taskId).toBe(one.taskId); // 幂等去重:只立一个任务
    const other = await continueBoard(ws, inbox, sid, "td5", ["a", "c"]); // 同 rev 另一个选区
    expect(other.taskId).not.toBe(one.taskId); // 不同选区=不同意图,放行
    // 选区排序后拼进键:顺序不同的同一选区仍去重
    const reordered = await continueBoard(ws, inbox, sid, "td5", ["c", "a"]);
    expect(reordered.taskId).toBe(other.taskId);
    ws.close();
  }, 25000);
});