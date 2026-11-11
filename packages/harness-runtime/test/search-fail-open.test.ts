/**
 * 会话检索缓存 fail-open:主/影双读双写 + breadcrumb 溯源 + journal 线性扫描降级。
 * 为什么要有这些用例:缓存是**派生数据**,journal 才是唯一事实源。缓存坏掉/半写/版本漂移
 * 时检索必须仍然可用(退到影子副本 → 退到全量重建 → 退到线性扫描),且每一步都留痕。
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal, type Journal } from "@lampgenie/core";
import { SessionSearchIndex } from "../src/session/search.js";
import { scanJournalFallback, writeShadowPair } from "../src/session/search-shadow.js";

const NOW = Date.parse("2026-10-16T00:00:00Z");

interface Paths {
  dir: string;
  cacheFile: string;
  shadowFile: string;
  breadcrumbFile: string;
}

function seed(): MemoryJournal {
  const journal = new MemoryJournal();
  journal.append({ kind: "message.user", sessionId: "sess-a", payload: { text: "部署网关到 staging 环境" }, time: NOW - 5000 });
  journal.append({ kind: "message.agent", sessionId: "sess-a", payload: { text: "已部署 Deploy 完成,日志见 deploy.log" }, time: NOW - 4000 });
  journal.append({ kind: "tool.result", sessionId: "sess-a", payload: { name: "bash", content: "deploy ok" }, time: NOW - 3000 });
  journal.append({ kind: "message.user", sessionId: "sess-b", payload: { text: "白板节点布局怎么调整" }, time: NOW - 2000 });
  journal.append({ kind: "task.done", sessionId: "sess-b", payload: { instruction: "部署脚本怎么跑", result: "已跑通 deploy 脚本" }, time: NOW - 1000 });
  return journal;
}

/** 让 readAll 前 times 次抛错(模拟构建期读盘失败),之后恢复正常。 */
function flakyJournal(journal: MemoryJournal, times: number): Journal {
  let remaining = times;
  const wrapper = {
    append: (event: never) => journal.append(event),
    appendMany: (events: never[]) => journal.appendMany(events),
    readAll: (sinceSeq?: number) => {
      if (remaining > 0) {
        remaining -= 1;
        throw new Error("journal readAll 失败");
      }
      return journal.readAll(sinceSeq);
    },
    readSession: (sessionId: string, sinceSeq?: number) => journal.readSession(sessionId, sinceSeq),
    subscribe: (listener: never) => journal.subscribe(listener),
    get length() {
      return journal.length;
    },
  };
  return wrapper as unknown as Journal;
}

let paths: Paths | null = null;

function makePaths(): Paths {
  const dir = mkdtempSync(join(tmpdir(), "search-fail-open-"));
  paths = {
    dir,
    cacheFile: join(dir, "session-search-index.json"),
    shadowFile: join(dir, "session-search-index.json.shadow"),
    breadcrumbFile: join(dir, "session-search-index.json.breadcrumb.json"),
  };
  return paths;
}

afterEach(() => {
  if (paths) {
    rmSync(paths.dir, { recursive: true, force: true });
    paths = null;
  }
});

function indexOn(journal: Journal, p: Paths): SessionSearchIndex {
  return new SessionSearchIndex(journal, {
    cacheFile: p.cacheFile,
    shadowFile: p.shadowFile,
    breadcrumbFile: p.breadcrumbFile,
    now: () => NOW,
    cacheDebounceMs: 0,
  });
}

/** 建一次索引并落盘(生成主/影/breadcrumb),返回统计。 */
function buildAndFlush(journal: Journal, p: Paths): SessionSearchIndex {
  const index = indexOn(journal, p);
  index.stats();
  expect(index.flush()).toBe(true);
  index.close();
  return indexOn(journal, p);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value), "utf-8");
}

function breadcrumbOf(p: Paths): Record<string, unknown> {
  return readJson(p.breadcrumbFile);
}

/** 一份形状合法、但内容被改过的 payload(用于构造 shape/stale 变体)。 */
function payloadOf(p: Paths): Record<string, unknown> {
  return readJson(p.cacheFile);
}

describe("会话检索 fail-open:主/影双读", () => {
  it("主缓存坏 JSON 时回退影子副本,cache.source=shadow", () => {
    const p = makePaths();
    buildAndFlush(seed(), p);
    writeFileSync(p.cacheFile, "{ 这不是 JSON", "utf-8");
    const index = indexOn(seed(), p);
    const stats = index.stats();
    expect(stats.cache.source).toBe("shadow");
    expect(stats.cache.loaded).toBe(true);
    expect(stats.cache.hit).toBe(true);
  });

  it("回退影子时仍然能 discover 命中", () => {
    const p = makePaths();
    buildAndFlush(seed(), p);
    writeFileSync(p.cacheFile, "", "utf-8");
    const index = indexOn(seed(), p);
    const result = index.discover("部署", { limit: 5 });
    expect(result.count).toBeGreaterThan(0);
    expect(result.results[0]?.best?.snippet).toContain("部署");
  });

  it("回退影子时 breadcrumb 记录 source=shadow 与 primary:json", () => {
    const p = makePaths();
    buildAndFlush(seed(), p);
    writeFileSync(p.cacheFile, "null trailing", "utf-8");
    const index = indexOn(seed(), p);
    index.stats();
    const crumb = breadcrumbOf(p);
    expect(crumb.source).toBe("shadow");
    expect(String(crumb.reason)).toContain("primary:json");
  });

  it("主缓存完好时 source=primary 且不降级", () => {
    const p = makePaths();
    buildAndFlush(seed(), p);
    writeFileSync(p.shadowFile, "{ 影子坏了", "utf-8");
    const index = indexOn(seed(), p);
    const stats = index.stats();
    expect(stats.cache.source).toBe("primary");
    expect(stats.degraded).toBe(false);
    expect(stats.fallbackReason ?? null).toBeNull();
  });

  it("主/影都坏时全量重建并仍能命中", () => {
    const p = makePaths();
    buildAndFlush(seed(), p);
    writeFileSync(p.cacheFile, "坏", "utf-8");
    writeFileSync(p.shadowFile, "也坏", "utf-8");
    const index = indexOn(seed(), p);
    const stats = index.stats();
    expect(stats.cache.source).toBe("rebuild");
    expect(stats.cache.loaded).toBe(false);
    expect(index.discover("白板").count).toBe(1);
    expect(stats.docs).toBeGreaterThan(0);
  });

  it("都坏重建时 breadcrumb.reason 记录两份失败原因", () => {
    const p = makePaths();
    buildAndFlush(seed(), p);
    writeFileSync(p.cacheFile, "坏", "utf-8");
    writeFileSync(p.shadowFile, "也坏", "utf-8");
    indexOn(seed(), p).stats();
    const crumb = breadcrumbOf(p);
    expect(crumb.source).toBe("rebuild");
    expect(String(crumb.reason)).toContain("primary:json");
    expect(String(crumb.reason)).toContain("shadow:json");
  });
});

describe("会话检索 fail-open:validate 契约(shape/stale)", () => {
  it("validate 判 shape:版本号不符 → 回退影子", () => {
    const p = makePaths();
    buildAndFlush(seed(), p);
    writeJson(p.cacheFile, { ...payloadOf(p), v: 2 });
    indexOn(seed(), p).stats();
    const crumb = breadcrumbOf(p);
    expect(crumb.source).toBe("shadow");
    expect(String(crumb.reason)).toContain("primary:shape");
  });

  it("validate 判 shape:docs 非数组 → 回退影子", () => {
    const p = makePaths();
    buildAndFlush(seed(), p);
    writeJson(p.cacheFile, { ...payloadOf(p), docs: "不是数组" });
    const stats = indexOn(seed(), p).stats();
    expect(stats.cache.source).toBe("shadow");
    expect(String(breadcrumbOf(p).reason)).toContain("primary:shape");
  });

  it("validate 判 stale:lastSeq 越界 → 回退影子", () => {
    const p = makePaths();
    buildAndFlush(seed(), p);
    writeJson(p.cacheFile, { ...payloadOf(p), lastSeq: 999 });
    const stats = indexOn(seed(), p).stats();
    expect(stats.cache.source).toBe("shadow");
    expect(String(breadcrumbOf(p).reason)).toContain("primary:stale");
  });

  it("validate 判 stale:lastTime 与 journal 对不上 → 回退影子", () => {
    const p = makePaths();
    buildAndFlush(seed(), p);
    writeJson(p.cacheFile, { ...payloadOf(p), lastTime: 42 });
    const stats = indexOn(seed(), p).stats();
    expect(stats.cache.source).toBe("shadow");
    expect(String(breadcrumbOf(p).reason)).toContain("primary:stale");
  });

  it("主缓存被判定不可用但影子可用时仍能 discover", () => {
    const p = makePaths();
    buildAndFlush(seed(), p);
    writeJson(p.cacheFile, { ...payloadOf(p), v: 99 });
    const index = indexOn(seed(), p);
    expect(index.discover("deploy").count).toBeGreaterThan(0);
  });
});

describe("会话检索 fail-open:breadcrumb 与双写", () => {
  it("flush 后主缓存/影子缓存/breadcrumb 三文件都在", () => {
    const p = makePaths();
    buildAndFlush(seed(), p);
    expect(existsSync(p.cacheFile)).toBe(true);
    expect(existsSync(p.shadowFile)).toBe(true);
    expect(existsSync(p.breadcrumbFile)).toBe(true);
  });

  it("breadcrumb 字段合法(v/at/source/docs/sessions/lastSeq)", () => {
    const p = makePaths();
    const index = buildAndFlush(seed(), p);
    const crumb = breadcrumbOf(p);
    expect(crumb.v).toBe(1);
    expect(crumb.at).toBe(NOW);
    expect(crumb.source).toBe("rebuild");
    expect(crumb.docs).toBe(index.stats().docs);
    expect(crumb.sessions).toBe(index.stats().sessions);
    expect(typeof crumb.lastSeq).toBe("number");
  });

  it("双写与 breadcrumb 都不留 .tmp 残留", () => {
    const p = makePaths();
    buildAndFlush(seed(), p);
    const leftovers = readdirSync(p.dir).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("两份都写失败时不覆盖既有 breadcrumb", () => {
    const p = makePaths();
    const blockedPrimary = join(p.dir, "blocked-primary");
    const blockedShadow = join(p.dir, "blocked-shadow");
    mkdirSync(blockedPrimary, { recursive: true });
    mkdirSync(blockedShadow, { recursive: true });
    writeFileSync(p.breadcrumbFile, "KEEP-ME", "utf-8");
    const result = writeShadowPair(blockedPrimary, blockedShadow, p.breadcrumbFile, { docs: [], sessions: [], lastSeq: 0 });
    expect(result.ok).toBe(false);
    expect(readFileSync(p.breadcrumbFile, "utf-8")).toBe("KEEP-ME");
  });

  it("两份都写失败时 written 为空且 ok=false", () => {
    const p = makePaths();
    const blockedPrimary = join(p.dir, "blocked-a");
    const blockedShadow = join(p.dir, "blocked-b");
    mkdirSync(blockedPrimary, { recursive: true });
    mkdirSync(blockedShadow, { recursive: true });
    const result = writeShadowPair(blockedPrimary, blockedShadow, null, { docs: [] });
    expect(result.written).toEqual([]);
    expect(result.breadcrumb).toBeUndefined();
  });

  it("一份写失败另一份成功时 ok=true 并写 breadcrumb", () => {
    const p = makePaths();
    const blockedPrimary = join(p.dir, "blocked-one");
    mkdirSync(blockedPrimary, { recursive: true });
    const result = writeShadowPair(blockedPrimary, p.shadowFile, p.breadcrumbFile, { docs: [1], sessions: [], lastSeq: 7 }, {
      source: "shadow",
      now: () => NOW,
    });
    expect(result.ok).toBe(true);
    expect(result.written).toEqual(["shadow"]);
    const crumb = breadcrumbOf(p);
    expect(crumb.source).toBe("shadow");
    expect(crumb.lastSeq).toBe(7);
    expect(crumb.docs).toBe(1);
  });
});

describe("线性扫描兜底 scanJournalFallback", () => {
  it("英文大小写不敏感", () => {
    const scan = scanJournalFallback(seed().readAll(), "DEPLOY");
    expect(scan.hits.length).toBeGreaterThan(0);
    expect(scan.hits.every((hit) => hit.text.toLowerCase().includes("deploy"))).toBe(true);
  });

  it("中文按原子串命中", () => {
    const scan = scanJournalFallback(seed().readAll(), "白板节点");
    expect(scan.hits.length).toBe(1);
    expect(scan.hits[0]?.sessionId).toBe("sess-b");
  });

  it("空 query 返回安全空态", () => {
    const scan = scanJournalFallback(seed().readAll(), "   ");
    expect(scan.hits).toEqual([]);
    expect(scan.scanned).toBe(0);
    expect(scan.tookMs).toBe(0);
  });

  it("空事件返回安全空态", () => {
    const scan = scanJournalFallback([], "部署");
    expect(scan.hits).toEqual([]);
    expect(scan.scanned).toBe(0);
    expect(scan.tookMs).toBe(0);
  });

  it("snippet 取命中前后各 40 字", () => {
    const journal = new MemoryJournal();
    journal.append({
      kind: "message.user",
      sessionId: "sess-long",
      payload: { text: `${"a".repeat(200)}needle${"b".repeat(200)}` },
      time: NOW,
    });
    const scan = scanJournalFallback(journal.readAll(), "needle");
    const snippet = scan.hits[0]!.snippet;
    expect(snippet).toContain("needle");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBe(1 + 40 + "needle".length + 40 + 1);
  });

  it("maxDocs 限制命中条数", () => {
    const journal = new MemoryJournal();
    for (let i = 0; i < 10; i++) {
      journal.append({ kind: "message.user", sessionId: `sess-${i}`, payload: { text: `ticket ${i} 排障` }, time: NOW - i * 1000 });
    }
    const scan = scanJournalFallback(journal.readAll(), "排障", { maxDocs: 3 });
    expect(scan.hits.length).toBe(3);
  });

  it("scanned 统计扫描过的事件数", () => {
    const scan = scanJournalFallback(seed().readAll(), "不存在的词");
    expect(scan.hits).toEqual([]);
    expect(scan.scanned).toBe(5);
  });

  it("tool.result 拼 name 后文本可命中", () => {
    const scan = scanJournalFallback(seed().readAll(), "bash");
    expect(scan.hits.length).toBe(1);
    expect(scan.hits[0]?.kind).toBe("tool.result");
  });
});

describe("会话检索 fail-open:degraded 三形态", () => {
  it("构建期异常不外抛且标记 degraded", () => {
    const p = makePaths();
    const index = indexOn(flakyJournal(seed(), 1), p);
    expect(() => index.stats()).not.toThrow();
    const stats = index.stats();
    expect(stats.degraded).toBe(true);
    expect(String(stats.fallbackReason)).toContain("journal readAll 失败");
    expect(stats.cache.source).toBe("fallback");
  });

  it("构建期异常时写 breadcrumb source=fallback", () => {
    const p = makePaths();
    indexOn(flakyJournal(seed(), 1), p).stats();
    const crumb = breadcrumbOf(p);
    expect(crumb.source).toBe("fallback");
    expect(String(crumb.reason)).toContain("journal readAll 失败");
  });

  it("degraded discover 走线性扫描并给出降级提示", () => {
    const p = makePaths();
    const index = indexOn(flakyJournal(seed(), 1), p);
    const result = index.discover("部署", { limit: 5 });
    expect(result.mode).toBe("discover");
    expect(result.count).toBeGreaterThan(0);
    expect(result.message).toContain("索引降级:使用 journal 线性扫描");
    expect(result.stats.cache.source).toBe("fallback");
    expect(result.results[0]?.best?.snippet).toContain("部署");
  });

  it("degraded scroll 命中事件标 anchor", () => {
    const p = makePaths();
    const index = indexOn(flakyJournal(seed(), 1), p);
    const result = index.scroll("sess-a", { query: "部署" });
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.some((event) => event.anchor === true)).toBe(true);
    expect(result.totalMatches).toBeGreaterThan(0);
    expect(result.message).toContain("索引降级");
  });

  it("degraded scroll 无 query 时返回该会话前 limit 条", () => {
    const p = makePaths();
    const index = indexOn(flakyJournal(seed(), 1), p);
    const result = index.scroll("sess-a", { limit: 2 });
    expect(result.events.length).toBe(2);
    expect(result.events[0]?.seq).toBe(0);
    expect(result.session?.sessionId).toBe("sess-a");
  });

  it("degraded read 按 fromSeq/limit 分页", () => {
    const p = makePaths();
    const index = indexOn(flakyJournal(seed(), 1), p);
    const first = index.read("sess-a", { fromSeq: 0, limit: 2 });
    expect(first.events.length).toBe(2);
    expect(first.total).toBe(3);
    expect(first.done).toBe(false);
    expect(first.nextSeq).toBe(2);
    const second = index.read("sess-a", { fromSeq: 2, limit: 2 });
    expect(second.events.length).toBe(1);
    expect(second.done).toBe(true);
    expect(second.nextSeq).toBeNull();
    expect(second.message).toContain("索引降级");
  });

  it("degraded read/scroll 未知会话返回空结果不抛", () => {
    const p = makePaths();
    const index = indexOn(flakyJournal(seed(), 1), p);
    const read = index.read("sess-missing", {});
    expect(read.session).toBeNull();
    expect(read.events).toEqual([]);
    expect(read.total).toBe(0);
    const scroll = index.scroll("sess-missing", {});
    expect(scroll.session).toBeNull();
    expect(scroll.events).toEqual([]);
  });

  it("journal 持续读失败时三形态都不抛", () => {
    const p = makePaths();
    const index = indexOn(flakyJournal(seed(), 999), p);
    expect(() => index.discover("部署")).not.toThrow();
    expect(() => index.scroll("sess-a", { query: "部署" })).not.toThrow();
    expect(() => index.read("sess-a", {})).not.toThrow();
    expect(index.stats().cache.source).toBe("fallback");
  });
});

describe("会话检索 fail-open:正常路径回归与 stats", () => {
  it("正常路径 discover 命中", () => {
    const p = makePaths();
    const index = indexOn(seed(), p);
    const result = index.discover("白板");
    expect(result.count).toBe(1);
    expect(result.results[0]?.sessionId).toBe("sess-b");
    expect(index.stats().degraded).toBe(false);
  });

  it("正常路径 scroll 带 query 标 anchor", () => {
    const p = makePaths();
    const index = indexOn(seed(), p);
    const result = index.scroll("sess-a", { query: "部署" });
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.some((event) => event.anchor === true)).toBe(true);
    expect(result.message ?? "").not.toContain("索引降级");
  });

  it("正常路径 read 分页游标", () => {
    const p = makePaths();
    const index = indexOn(seed(), p);
    const first = index.read("sess-a", { fromSeq: 0, limit: 2 });
    expect(first.events.length).toBe(2);
    expect(first.done).toBe(false);
    expect(first.nextSeq).toBe(2);
    expect(index.read("sess-a", { fromSeq: 2, limit: 2 }).done).toBe(true);
  });

  it("stats.cache.source 四态各一次", () => {
    const p = makePaths();
    buildAndFlush(seed(), p);
    expect(indexOn(seed(), p).stats().cache.source).toBe("primary");
    writeFileSync(p.cacheFile, "坏", "utf-8");
    expect(indexOn(seed(), p).stats().cache.source).toBe("shadow");
    writeFileSync(p.shadowFile, "也坏", "utf-8");
    expect(indexOn(seed(), p).stats().cache.source).toBe("rebuild");
    const degradedDir = mkdtempSync(join(tmpdir(), "search-fail-open-degraded-"));
    try {
      const degradedPaths: Paths = {
        dir: degradedDir,
        cacheFile: join(degradedDir, "index.json"),
        shadowFile: join(degradedDir, "index.json.shadow"),
        breadcrumbFile: join(degradedDir, "index.json.breadcrumb.json"),
      };
      expect(indexOn(flakyJournal(seed(), 1), degradedPaths).stats().cache.source).toBe("fallback");
    } finally {
      rmSync(degradedDir, { recursive: true, force: true });
    }
  });

  it("stats.cache.breadcrumb 为 string 或 null", () => {
    const p = makePaths();
    const withBreadcrumb = indexOn(seed(), p);
    withBreadcrumb.stats();
    expect(typeof withBreadcrumb.stats().cache.breadcrumb).toBe("string");
    const noCacheIndex = new SessionSearchIndex(seed(), { now: () => NOW });
    const stats = noCacheIndex.stats();
    expect(stats.cache.breadcrumb).toBeNull();
    expect(stats.cache.file).toBeNull();
  });
});
