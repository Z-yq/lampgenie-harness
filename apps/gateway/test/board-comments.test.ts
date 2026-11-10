/**
 * 白板评论待办链路:评论 → 登记 pending → agent loop tips 注入一次即消费。
 * 设计板 n5「评论唤醒」验收:不自动开轮,但下一轮一定看见。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import WebSocket from "ws";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  notePendingComment, takePendingComments, peekPendingComments,
  clearPendingComments, renderPendingCommentsBlock,
} from "../src/board-comments.js";
import { saveBoard, loadBoard } from "../src/board-store.js";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import { EchoChildBackend } from "@lampgenie/executors";
import { repoRoot } from "../src/repo-root.js";

beforeEach(() => clearPendingComments());

describe("白板评论待办(注入即消费)", () => {
  it("登记后 peek 可见、take 取走一次后清空(不重复刷屏)", () => {
    notePendingComment({ sessionId: "s1", taskId: "bd1", nodeId: "n1", text: "这个模块拆细一点" });
    expect(peekPendingComments("s1")).toHaveLength(1);
    const first = takePendingComments("s1");
    expect(first.map((c) => c.text)).toEqual(["这个模块拆细一点"]);
    expect(takePendingComments("s1")).toEqual([]);
  });

  it("会话隔离:别的会话的评论不串进来", () => {
    notePendingComment({ sessionId: "s1", taskId: "bd1", nodeId: "n1", text: "A" });
    notePendingComment({ sessionId: "s2", taskId: "bd1", nodeId: "n1", text: "B" });
    expect(takePendingComments("s1").map((c) => c.text)).toEqual(["A"]);
    expect(takePendingComments("s2").map((c) => c.text)).toEqual(["B"]);
  });

  it("同节点同文本去重(双击评论不产生两条提示);空文本不登记", () => {
    notePendingComment({ sessionId: "s1", taskId: "bd1", nodeId: "n1", text: "改" });
    notePendingComment({ sessionId: "s1", taskId: "bd1", nodeId: "n1", text: "改" });
    notePendingComment({ sessionId: "s1", taskId: "bd1", nodeId: "n1", text: "   " });
    expect(peekPendingComments("s1")).toHaveLength(1);
  });

  it("上限 20 条,超出丢最旧", () => {
    for (let i = 0; i < 25; i++) notePendingComment({ sessionId: "s1", taskId: "bd1", nodeId: "n" + i, text: "c" + i });
    const list = peekPendingComments("s1");
    expect(list).toHaveLength(20);
    expect(list[0]!.nodeId).toBe("n5");
    expect(list[19]!.nodeId).toBe("n24");
  });

  it("渲染块含板/节点/评论正文 + 行动指令;空列表返回 null 不注入空壳", () => {
    notePendingComment({ sessionId: "s1", taskId: "bd1", nodeId: "n2", text: "把关系画出来" });
    const block = renderPendingCommentsBlock(takePendingComments("s1"))!;
    expect(block).toContain("白板新评论");
    expect(block).toContain("bd1");
    expect(block).toContain("n2");
    expect(block).toContain("把关系画出来");
    expect(block).toContain("board_read");
    expect(renderPendingCommentsBlock([])).toBeNull();
  });

  it("超长评论截断到 200 字符(不把整段塞进上下文)", () => {
    notePendingComment({ sessionId: "s1", taskId: "bd1", nodeId: "n1", text: "x".repeat(500) });
    const block = renderPendingCommentsBlock(takePendingComments("s1"))!;
    expect(block).toContain("…");
    expect(block.length).toBeLessThan(700);
  });
});

/**
 * c1 评论「编辑/删除」:board.comment 的 op=update/delete 按 index 改/删同节点已有评论。
 * 这条链只在 server WS 层(board-comments.ts 是 pending 内存表),故照 board.test.ts:605 的 WS 回路写法。
 */
describe("白板评论编辑/删除(c1:按 index 改/删,持久化形状不变)", () => {
  const PORT = 7931;
  const SID = "vitest-bcmt-edit-" + Date.now();
  const TID = "tc1";
  let app: GatewayApp | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
    rmSync(join(repoRoot(), ".genie", "boards", SID), { recursive: true, force: true });
  });
  const wait = (inbox: Record<string, unknown>[], pred: (m: Record<string, unknown>) => boolean, tag = "") =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const cursor = inbox.length;
      const t = setTimeout(() => reject(new Error("等消息超时 " + tag)), 9000);
      const poll = setInterval(() => {
        const hit = inbox.slice(cursor).find(pred);
        if (hit) { clearTimeout(t); clearInterval(poll); resolve(hit); }
      }, 30);
    });
  type CmtDoc = { rev: number; nodes: { id: string; comments?: string[] }[] };
  /** 起一块带 3 条评论的板 + 连 WS(三个用例共用)。 */
  async function setup() {
    const rr = repoRoot();
    const r = saveBoard(rr, {
      version: 1 as const, taskId: TID, sessionId: SID, title: "评论改删", status: "draft" as const, rev: 0,
      nodes: [
        {
          id: "n1", kind: "function" as const, label: "模块A", summary: "做A", change: "add" as const, flow: [],
          comments: ["第一条", "第二条", "第三条"],
        },
        { id: "n2", kind: "function" as const, label: "模块B", summary: "做B", change: "add" as const, flow: [], comments: [] },
      ],
      edges: [], planned_files: [], updatedAt: 0,
    });
    expect(r.ok).toBe(true);
    app = createGatewayApp({ port: PORT, executor: new EchoChildBackend() });
    const ws = new WebSocket("ws://127.0.0.1:" + PORT);
    const inbox: Record<string, unknown>[] = [];
    ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
    await new Promise((res) => ws.on("open", res));
    return { ws, inbox, rr };
  }

  it("update 按索引替换:条目数不变、其余顺序不变,rev+1 且不登记未处理评论", async () => {
    const { ws, inbox, rr } = await setup();
    ws.send(JSON.stringify({ v: 1, type: "board.comment", sessionId: SID, taskId: TID, nodeId: "n1", op: "update", index: 1, text: "  第二条改过  " }));
    const got = await wait(inbox, (m) => m.type === "board.doc" && (m.doc as CmtDoc).rev === 1, "update ack");
    const doc = got.doc as CmtDoc;
    // 就地替换:长度不变(没有新增条目),前后顺序不动
    expect(doc.nodes[0]!.comments).toEqual(["第一条", "第二条改过", "第三条"]);
    const disk = loadBoard(rr, SID, TID);
    expect(disk?.nodes[0]?.comments).toEqual(["第一条", "第二条改过", "第三条"]);
    expect(disk?.rev).toBe(1);
    // 改评论不是「新待办」:pending 计数不涨(append 才会 +1)
    expect(peekPendingComments(SID)).toHaveLength(0);
    ws.close();
  }, 25000);

  it("delete 按索引移除:条数 -1,其余顺序不变,盘上同步,rev+1", async () => {
    const { ws, inbox, rr } = await setup();
    ws.send(JSON.stringify({ v: 1, type: "board.comment", sessionId: SID, taskId: TID, nodeId: "n1", op: "delete", index: 1 }));
    const got = await wait(inbox, (m) => m.type === "board.doc" && (m.doc as CmtDoc).rev === 1, "delete ack");
    const doc = got.doc as CmtDoc;
    expect(doc.nodes[0]!.comments).toEqual(["第一条", "第三条"]);
    const disk = loadBoard(rr, SID, TID);
    expect(disk?.nodes[0]?.comments).toEqual(["第一条", "第三条"]);
    expect(peekPendingComments(SID)).toHaveLength(0);
    ws.close();
  }, 25000);

  it("index 越界(update/delete 均)→ comment-index-out-of-range 且盘上未变(rev 不前移)", async () => {
    const { ws, inbox, rr } = await setup();
    ws.send(JSON.stringify({ v: 1, type: "board.comment", sessionId: SID, taskId: TID, nodeId: "n1", op: "update", index: 9, text: "越界" }));
    const e1 = await wait(inbox, (m) => m.type === "error" && m.code === "comment-index-out-of-range", "update oob");
    expect(e1.code).toBe("comment-index-out-of-range");
    ws.send(JSON.stringify({ v: 1, type: "board.comment", sessionId: SID, taskId: TID, nodeId: "n1", op: "delete", index: 3 }));
    const e2 = await wait(inbox, (m) => m.type === "error" && m.code === "comment-index-out-of-range", "delete oob");
    expect(e2.code).toBe("comment-index-out-of-range");
    // 不动盘:评论原样 + rev 仍为 0(没有落任何一次变更)
    const disk = loadBoard(rr, SID, TID);
    expect(disk?.nodes[0]?.comments).toEqual(["第一条", "第二条", "第三条"]);
    expect(disk?.rev).toBe(0);
    ws.close();
  }, 25000);
});
