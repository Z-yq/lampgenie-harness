/**
 * fault 冷启动回归门(2026-10-25):28k+ 行 journal 用 FileJournal.loadChunked() 分片加载,
 * 事件循环在解析/入账期间能拿到 tick(不被同步全量重放独占);入账语义与同步 load 一致:
 * 全量行数、会话索引、seq 续写、task.deleted 墓碑仍在。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileJournal } from "@lampgenie/core";

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "gh-journal-chunk-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("journal loadChunked(28k 行夹具)", () => {
  it("分片加载让出事件循环;全量行/会话索引/seq 续写/墓碑保留", async () => {
    const root = tmp();
    mkdirSync(join(root, "sessions"), { recursive: true });
    const n = 28_000;
    const lines: string[] = [];
    for (let i = 1; i <= n; i++) {
      lines.push(JSON.stringify({
        seq: i, time: 1_700_000_000_000 + i, sessionId: "s-big",
        kind: "message.user", payload: { text: `event-${i}` },
      }));
    }
    // 墓碑事件必须随分片加载保留(应用层回放据此不复活已删任务)
    lines.push(JSON.stringify({
      seq: n + 1, time: 1_700_000_000_000 + n + 1, sessionId: "s-big",
      kind: "task.deleted", payload: { taskIds: ["deleted-task"] },
    }));
    writeFileSync(join(root, "sessions", "big.jsonl"), lines.join("\n") + "\n", "utf-8");

    const j = new FileJournal(join(root, "gateway.jsonl"), { deferLoad: true });
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 5);
    try {
      await j.loadChunked();
    } finally {
      clearInterval(timer);
    }

    // 2026-11-05 热窗(g2):length 语义 = 下一个 seq(seqHigh+1),不再是事件条数——
    // 热窗下冷会话事件不驻留,events.length 无法当水位用;server.ts seqBefore / search 增量都用它。
    // 夹具 seq 1..n 加墓碑 n+1 → 水位 n+2;事件条数仍要看 readAll/readSession。
    expect(j.length).toBe(n + 2);
    expect(j.readAll()).toHaveLength(n + 1);
    expect(j.readSession("s-big")).toHaveLength(n + 1);
    expect(j.readAll()[0]?.seq).toBe(1);
    expect(j.readAll().some((e) => e.kind === "task.deleted")).toBe(true);
    // 加载期间事件循环至少拿到 3 次 tick(同步 load 会接近 0)
    expect(ticks).toBeGreaterThanOrEqual(3);
    // seq 水位续写:新事件不得与历史 seq 相撞
    const next = j.append({ sessionId: "s-big", kind: "message.user", payload: { text: "after-load" } });
    expect(next.seq).toBe(n + 2);
  }, 30_000);
});
