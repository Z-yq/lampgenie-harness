/**
 * review.inject(评审评论一键回注聊天窗:WS 往返——
 * 注入 → review.inject.result{sessionId,taskId,count} + task.submitted;
 * 任务指令含逐条 file:line/severity/title/detail;journal 落 review.inject 事件;
 * 同 idempotencyKey 重发不重复立任务(同 board.continue 语义)。
 */
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import { EchoChildBackend } from "@lampgenie/executors";

let app: GatewayApp | null = null;
let journalDir: string | null = null;
afterEach(async () => {
  await app?.close(); app = null;
  if (journalDir) { rmSync(journalDir, { recursive: true, force: true }); journalDir = null; }
});

async function wsCollect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox: Record<string, unknown>[] = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
  await new Promise((r) => ws.on("open", r));
  return { ws, inbox };
}
async function waitFor(inbox: Record<string, unknown>[], type: string, cursor = 0) {
  for (let i = 0; i < 80; i++) {
    const hit = inbox.slice(cursor).find((m) => m.type === type);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

describe("review.inject", () => {
  it("注入 → result + task.submitted;指令含逐条定位;journal 落 review.inject", async () => {
    journalDir = mkdtempSync(join(tmpdir(), "gh-revinject-"));
    app = createGatewayApp({ port: 7803, executor: new EchoChildBackend(), journalDir });
    const { ws, inbox } = await wsCollect(7803);
    ws.send(JSON.stringify({
      v: 1, type: "review.inject", sessionId: "sess-A", idempotencyKey: "revinj-t1",
      source: "chat-findings",
      items: [
        { file: "src/a.ts", line: 12, severity: "blocker", title: "疑似凭证入库", detail: "diff 中出现 API key 形态", rule: "credential" },
        { file: "src/b.ts", line: 3, severity: "nit", title: "调试输出残留" },
      ],
    }));
    const res = await waitFor(inbox, "review.inject.result");
    expect(res).toBeTruthy();
    expect(res!.sessionId).toBe("sess-A");
    expect(res!.count).toBe(2);
    expect(typeof res!.taskId).toBe("string");
    const submitted = await waitFor(inbox, "task.submitted");
    expect(submitted).toBeTruthy();
    const task = submitted!.task as { id: string; sessionId: string; instruction: string };
    expect(task.sessionId).toBe("sess-A");
    expect(task.id).toBe(res!.taskId);
    // 指令形态:批次头 + 编号 + file:line + severity + title + detail + rule + 复查要求
    expect(task.instruction).toContain("【按评审评论修复】");
    expect(task.instruction).toContain("2 条发现");
    expect(task.instruction).toContain("1. [BLOCKER] src/a.ts:12 — 疑似凭证入库");
    expect(task.instruction).toContain("详情:diff 中出现 API key 形态");
    expect(task.instruction).toContain("规则:credential");
    expect(task.instruction).toContain("2. [NIT] src/b.ts:3 — 调试输出残留");
    expect(task.instruction).toContain("code_review");
    // journal 落 review.inject 事件
    const events = app!.journal.readAll().filter((e) => e.kind === "review.inject");
    expect(events).toHaveLength(1);
    const p = events[0]!.payload as { count: number; files: string[]; source: string; taskId: string; targetSessionId: string };
    expect(p.count).toBe(2);
    expect(p.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(p.source).toBe("chat-findings");
    expect(p.taskId).toBe(task.id);
    expect(p.targetSessionId).toBe("sess-A");
    ws.close();
  }, 20_000);

  it("幂等:同 idempotencyKey 重发只立一个任务", async () => {
    journalDir = mkdtempSync(join(tmpdir(), "gh-revinject-idem-"));
    app = createGatewayApp({ port: 7804, executor: new EchoChildBackend(), journalDir });
    const { ws, inbox } = await wsCollect(7804);
    const msg = {
      v: 1, type: "review.inject", sessionId: "sess-B", idempotencyKey: "revinj-idem-1",
      items: [{ file: "x.ts", line: 1, title: "t" }],
    };
    ws.send(JSON.stringify(msg));
    const r1 = await waitFor(inbox, "review.inject.result");
    expect(r1).toBeTruthy();
    ws.send(JSON.stringify(msg));
    // 第二次也回执(同一任务 id),但任务清单不新增
    const r2 = await waitFor(inbox, "review.inject.result", inbox.indexOf(r1!) + 1);
    expect(r2).toBeTruthy();
    expect(r2!.taskId).toBe(r1!.taskId);
    const tasks = app!.taskManager.list().filter((t) => t.sessionId === "sess-B");
    expect(tasks).toHaveLength(1);
    ws.close();
  }, 20_000);

  it("非法载荷(空 items)被协议层拒收", async () => {
    journalDir = mkdtempSync(join(tmpdir(), "gh-revinject-bad-"));
    app = createGatewayApp({ port: 7805, executor: new EchoChildBackend(), journalDir });
    const { ws, inbox } = await wsCollect(7805);
    ws.send(JSON.stringify({ v: 1, type: "review.inject", sessionId: "s", idempotencyKey: "k", items: [] }));
    const err = await waitFor(inbox, "error");
    expect(err).toBeTruthy();
    expect(String(err!.code)).toContain("invalid");
    ws.close();
  }, 20_000);
});
