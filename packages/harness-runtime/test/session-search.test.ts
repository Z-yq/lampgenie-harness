/**
 * step-115 会话全文检索:倒排/三形态/增量/自动化降权/缓存回填。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal, FileJournal } from "@lampgenie/core";
import { SessionSearchIndex, tokenizeForIndex, planQuery } from "../src/session/search.js";

const NOW = Date.parse("2026-10-16T00:00:00Z");

function seed(): MemoryJournal {
  const j = new MemoryJournal();
  j.append({ kind: "message.user", sessionId: "sess-a", payload: { text: "白板节点布局怎么调整?permission 冲突排查记录" }, time: NOW - 2 * 86_400_000 });
  j.append({ kind: "message.agent", sessionId: "sess-a", payload: { text: "先看 board-page-layout.js,再改白板节点坐标" }, time: NOW - 2 * 86_400_000 + 1000 });
  j.append({ kind: "tool.result", sessionId: "sess-a", payload: { name: "grep", content: "permission-broker.ts 命中 permission 关键字" }, time: NOW - 2 * 86_400_000 + 2000 });
  j.append({ kind: "message.user", sessionId: "sess-b", payload: { text: "部署脚本怎么跑?terminal 会话保持 cwd" }, time: NOW - 60_000 });
  j.append({ kind: "task.done", sessionId: "sess-b", payload: { instruction: "部署脚本怎么跑?", result: "已用 terminal 跑通 deploy" }, time: NOW - 30_000 });
  return j;
}

describe("session search(step-115)", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; }
  });

  it("分词:中文 unigram+bigram,英文复合词+子词", () => {
    const tokens = tokenizeForIndex("白板 permission step-111");
    expect(tokens.has("白") && tokens.has("板") && tokens.has("白板")).toBe(true);
    expect(tokens.has("permission")).toBe(true);
    expect(tokens.has("step-111") && tokens.has("step") && tokens.has("111")).toBe(true);
    const plan = planQuery("会话检索");
    expect(plan.terms.map((t) => t.token)).toEqual(expect.arrayContaining(["会话", "检索"]));
    expect(plan.terms.some((t) => t.token === "会")).toBe(false);
  });

  it("discover:命中片段含词,按词频/时间排序", () => {
    const index = new SessionSearchIndex(seed(), { now: () => NOW });
    const r = index.discover("白板", { limit: 5 });
    expect(r.count).toBe(1);
    expect(r.results[0]?.sessionId).toBe("sess-a");
    expect(r.results[0]?.best?.snippet).toContain("«白板»");
    expect(r.results[0]?.hits).toBeGreaterThanOrEqual(2);
    const p = index.discover("permission", { limit: 5 });
    expect(p.results[0]?.sessionId).toBe("sess-a");
    expect(p.results[0]?.best?.snippet).toContain("«permission»");
    index.close();
  });

  it("scroll:discover 的 best.seq 能定位上下文;read 能分页读原文", () => {
    const index = new SessionSearchIndex(seed(), { now: () => NOW });
    const d = index.discover("permission", { limit: 1 });
    const best = d.results[0]?.best;
    expect(best).toBeTruthy();
    const s = index.scroll("sess-a", { seq: best!.seq, before: 1, after: 1 });
    expect(s.events.some((e) => e.anchor)).toBe(true);
    expect(s.events.some((e) => e.text.includes("permission"))).toBe(true);
    const scoped = index.scroll("sess-a", { query: "白板", limit: 5, before: 1, after: 1 });
    expect(scoped.totalMatches).toBeGreaterThan(0);
    expect(scoped.events.some((e) => e.anchor && e.text.includes("白板"))).toBe(true);
    const read = index.read("sess-a", { fromSeq: 0, limit: 2 });
    expect(read.events.length).toBe(2);
    expect(read.nextSeq).not.toBeNull();
    const next = index.read("sess-a", { fromSeq: read.nextSeq!, limit: 2 });
    expect(next.events[0]?.seq).toBeGreaterThan(read.events[1]!.seq);
    index.close();
  });

  it("增量:append 后立即可搜(不用重建)", () => {
    const journal = seed();
    const index = new SessionSearchIndex(journal, { now: () => NOW });
    index.ensureBuilt();
    journal.append({ kind: "message.user", sessionId: "sess-new", payload: { text: "增量标记 zq-live-42 立刻可搜" }, time: NOW });
    const r = index.discover("zq-live-42", { limit: 3 });
    expect(r.results[0]?.sessionId).toBe("sess-new");
    expect(r.results[0]?.best?.snippet).toContain("«zq-live-42»");
    index.close();
  });

  it("自动化会话降权但可检索;用户会话同分优先", () => {
    const j = new MemoryJournal();
    j.append({ kind: "message.user", sessionId: "web-user", payload: { text: "permission 配置 冲突 排查" }, time: NOW });
    j.append({ kind: "message.user", sessionId: "auto-1a2b3c4d", payload: { text: "permission 配置 冲突 排查" }, time: NOW });
    j.append({ kind: "message.user", sessionId: "auto-only", payload: { text: "auto-only-token 定时巡检" }, time: NOW });
    const index = new SessionSearchIndex(j, { now: () => NOW });
    const r = index.discover("permission 配置", { limit: 5 });
    expect(r.results[0]?.sessionId).toBe("web-user");
    const auto = r.results.find((x) => x.sessionId === "auto-1a2b3c4d");
    expect(auto?.source).toBe("automation");
    expect(auto?.demoted).toBe(true);
    const only = index.discover("auto-only-token", { limit: 5 });
    expect(only.results[0]?.sessionId).toBe("auto-only");
    index.close();
  });

  it("时间过滤:after/before 与相对时长", () => {
    const index = new SessionSearchIndex(seed(), { now: () => NOW });
    expect(index.discover("部署", { limit: 5, after: "1d" }).count).toBe(1);
    expect(index.discover("部署", { limit: 5, after: "10d" }).count).toBe(1);
    expect(index.discover("白板", { limit: 5, before: "1d" }).count).toBe(1);
    expect(index.discover("白板", { limit: 5, after: "1d" }).count).toBe(0);
    index.close();
  });

  it("缓存:二次构建命中且只补增量", () => {
    dir = mkdtempSync(join(tmpdir(), "s115-test-"));
    const file = join(dir, "gateway.jsonl");
    const cacheFile = join(dir, "session-search-index.json");
    const first = new FileJournal(file);
    first.append({ kind: "message.user", sessionId: "sess-c", payload: { text: "缓存命中白板第一次" } });
    const a = new SessionSearchIndex(first, { cacheFile, now: () => NOW });
    a.ensureBuilt();
    expect(a.stats().docs).toBe(1);
    expect(a.flush()).toBe(true);
    a.close();

    const second = new FileJournal(file);
    second.append({ kind: "message.user", sessionId: "sess-c", payload: { text: "缓存增量 permission 第二次" } });
    const b = new SessionSearchIndex(second, { cacheFile, now: () => NOW });
    b.ensureBuilt();
    const stats = b.stats();
    expect(stats.cache.hit).toBe(true);
    expect(stats.docs).toBe(2);
    expect(b.discover("permission", { limit: 3 }).results[0]?.sessionId).toBe("sess-c");
    b.close();
  });
});
