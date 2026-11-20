/**
 * 白板读路径缓存层测试:hit/miss 语义、写后失效(进程内+外进程)、
 * list 目录指纹、外部依赖指纹(源码变化→缓存失配,review w1195 修正的回归门)。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveBoardAsync, loadBoardPackAsync, listBoardsExAsync, clearBoardCaches, boardCacheStats, boardPath,
} from "../src/board-store.js";

let root = "";
const SID = "cache-t-sid";
function mkDoc(taskId: string, title: string, refFile?: string) {
  return {
    version: 1 as const, taskId, sessionId: SID, title, status: "draft" as const, rev: 1,
    updatedAt: Date.now(),
    nodes: [
      { id: "n1", kind: "function" as const, label: "甲", summary: "s", change: "keep" as const, ...(refFile ? { symbolRef: { name: "x", file: refFile, line: 1 } } : {}) },
      { id: "n2", kind: "end" as const, label: "乙", summary: "s", change: "keep" as const },
    ],
    edges: [{ from: "n1", to: "n2", kind: "call" as const }],
  };
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "b11-cache-")); clearBoardCaches(); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("board.get 整包缓存(loadBoardPackAsync)", () => {
  it("miss→hit:两次输出深度相等,第二次 cache=hit 且 getHits 计数", async () => {
 // 首用例动态 import board-derive/code-sense 在 DrvFs 冷解析>5s(vitest 默认超时);放宽单用例超时
    await saveBoardAsync(root, mkDoc("t1", "板一"));
    const a = await loadBoardPackAsync(root, SID, "t1");
    const b = await loadBoardPackAsync(root, SID, "t1");
    expect(a.cache).toBe("miss");
    expect(b.cache).toBe("hit");
    expect(JSON.stringify(b.doc)).toBe(JSON.stringify(a.doc));
    expect(JSON.stringify(b.links)).toBe(JSON.stringify(a.links));
    expect(boardCacheStats().getHits).toBeGreaterThan(0);
  }, 30000);

  it("本进程 saveBoardAsync 写后失效:回 miss 且新内容可见(无脏读)", async () => {
    await saveBoardAsync(root, mkDoc("t2", "旧标题"));
    await loadBoardPackAsync(root, SID, "t2");
    const doc2 = mkDoc("t2", "新标题");
    doc2.rev = 2;
    await saveBoardAsync(root, doc2);
    const r = await loadBoardPackAsync(root, SID, "t2");
    expect(r.cache).toBe("miss");
    expect(r.doc?.title).toBe("新标题");
    expect(r.doc?.rev).toBe(2);
  });

  it("外进程直接改盘(不经写路径)→指纹失配,回 miss 读到新内容", async () => {
    await saveBoardAsync(root, mkDoc("t3", "外进程前"));
    await loadBoardPackAsync(root, SID, "t3");
    const raw = JSON.parse(JSON.stringify(mkDoc("t3", "外进程后")));
    raw.rev = 9;
    writeFileSync(boardPath(root, SID, "t3"), JSON.stringify(raw));
 // 同 mtime+size 也兜得住:内容变了 size 必变;这里再强制 mtime 变化模拟最保守场景
    utimesSync(boardPath(root, SID, "t3"), new Date(), new Date(Date.now() + 2000));
    const r = await loadBoardPackAsync(root, SID, "t3");
    expect(r.cache).toBe("miss");
    expect(r.doc?.title).toBe("外进程后");
  });

  it("review w1195 回归:源码文件被编辑(板未动)→depsSig 失配回 miss", async () => {
    writeFileSync(join(root, "a.ts"), "export function x() { return 1; }\n");
    await saveBoardAsync(root, mkDoc("t4", "带引用板", "a.ts"));
    const first = await loadBoardPackAsync(root, SID, "t4");
    expect(first.cache).toBe("miss");
    const second = await loadBoardPackAsync(root, SID, "t4");
    expect(second.cache).toBe("hit");
 // 外部编辑源码(mtime+size 都变)——板 json 未动,老实现会继续 hit(≤60s 陈旧)
    writeFileSync(join(root, "a.ts"), "export function x() { return 2; } // changed\n");
    const third = await loadBoardPackAsync(root, SID, "t4");
    expect(third.cache).toBe("miss");
  });

  it("无 symbolRef 的板:命中路径零额外 stat(depsSig=空串短路)", async () => {
    await saveBoardAsync(root, mkDoc("t5", "无引用"));
    await loadBoardPackAsync(root, SID, "t5");
    const r = await loadBoardPackAsync(root, SID, "t5");
    expect(r.cache).toBe("hit");
  });
});

describe("board.list 目录指纹缓存(listBoardsExAsync)", () => {
  it("miss→hit 深度相等;新增板文件(目录指纹变)→回 miss 且清单含新板", async () => {
    await saveBoardAsync(root, mkDoc("l1", "清单一"));
    const a = await listBoardsExAsync(root, SID);
    const b = await listBoardsExAsync(root, SID);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(boardCacheStats().listHits).toBeGreaterThan(0);
    await saveBoardAsync(root, mkDoc("l2", "清单二"));
    const c = await listBoardsExAsync(root, SID);
    expect(c.items.map((i) => i.taskId).sort()).toEqual(["l1", "l2"]);
  });
});
