/**
 * 读传递原语单测( D3:跨 agent 读重叠 17.5% 治理):
 * ①行段登记与合并(同文件多窗读→单条目合并行段;乱序/相邻拼缝);
 * ②renderParentReadBlock(任务书块:≤8 文件/700 字符上限、空清单 null 零注入);
 * ③renderParentReadHint(交叠命中出尾注/不命中零尾注/无行段条目视为全文)。
 * 跨 agent 集成(spawn 注入+子读尾注)见 apps/gateway/test/read-handoff.test.ts。
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  clearReadFiles, recordFileRead, readFilesOf,
  renderParentReadBlock, renderParentReadHint,
  MAX_HANDOFF_BLOCK_CHARS, MAX_HANDOFF_BLOCK_FILES,
} from "../src/agent/read-file-state";

const sessions: string[] = [];
const sid = () => { const s = `rh-${Math.random().toString(36).slice(2)}`; sessions.push(s); return s; };
afterEach(() => { for (const s of sessions.splice(0)) clearReadFiles(s); });

describe("recordFileRead 行段(2026-11-05 读传递)", () => {
  it("同文件多次分窗读 → 单条目、行段合并升序", () => {
    const s = sid();
    recordFileRead(s, "a.ts", 1000, 1, [{ off: 100, end: 199 }]);
    recordFileRead(s, "a.ts", 1000, 2, [{ off: 500, end: 599 }]);
    recordFileRead(s, "a.ts", 1000, 3, [{ off: 200, end: 299 }]); // 与 100-199 相邻拼缝
    const es = readFilesOf(s);
    expect(es).toHaveLength(1);
    expect(es[0]!.ranges).toEqual([{ off: 100, end: 299 }, { off: 500, end: 599 }]);
  });
  it("不传 ranges=旧行为(无行段字段,视为全文)", () => {
    const s = sid();
    recordFileRead(s, "b.ts", 1000);
    expect(readFilesOf(s)[0]!.ranges).toBeUndefined();
  });
});

describe("renderParentReadBlock(spawn 任务书注入块)", () => {
  it("空清单=null(零注入)", () => {
    expect(renderParentReadBlock([])).toBeNull();
    expect(renderParentReadBlock(undefined)).toBeNull();
  });
  it("正常清单:逐文件行段+mtime;文件数>上限只列最近 N 个", () => {
    const s = sid();
    for (let i = 0; i < MAX_HANDOFF_BLOCK_FILES + 3; i++) recordFileRead(s, `f${i}.ts`, 1000 + i, i + 1, [{ off: 1 + i, end: 9 + i }]);
    const block = renderParentReadBlock(readFilesOf(s))!;
    expect(block).toContain("<父会话已读提示>");
    expect(block).toContain("勿再整读");
    expect(block).toContain(`只列最近 ${MAX_HANDOFF_BLOCK_FILES} 个`);
    // readAt 新→旧 → 首行是最后登记的文件
    expect(block.split("\n")[2]).toContain(`f${MAX_HANDOFF_BLOCK_FILES + 2}.ts`);
  });
  it("体积上限:超长行段列表截断且闭合标签保留", () => {
    const s = sid();
    const long = "x".repeat(120);
    for (let i = 0; i < MAX_HANDOFF_BLOCK_FILES; i++) recordFileRead(s, `${long}-${i}.ts`, 1000, i + 1, [{ off: 1, end: 5 }]);
    const block = renderParentReadBlock(readFilesOf(s))!;
    expect(block.length).toBeLessThanOrEqual(MAX_HANDOFF_BLOCK_CHARS + "…(截断)</父会话已读提示>".length);
    expect(block.endsWith("</父会话已读提示>")).toBe(true);
  });
});

describe("renderParentReadHint(子读尾注)", () => {
  it("行段交叠命中 → 尾注含路径与行段", () => {
    const s = sid();
    recordFileRead(s, "src/loop.ts", 1000, 1, [{ off: 100, end: 199 }]);
    const hint = renderParentReadHint(readFilesOf(s), "src/loop.ts", 150, 249);
    expect(hint).toContain("(已读提示:src/loop.ts 行段 100-199");
    expect(hint).toContain("勿再整读");
  });
  it("行段不交叠 → null(零尾注)", () => {
    const s = sid();
    recordFileRead(s, "src/loop.ts", 1000, 1, [{ off: 100, end: 199 }]);
    expect(renderParentReadHint(readFilesOf(s), "src/loop.ts", 500, 599)).toBeNull();
  });
  it("父读别的文件 → null;旧条目无行段=视为全文(任何窗口都命中)", () => {
    const s = sid();
    recordFileRead(s, "a.ts", 1000, 1);
    expect(renderParentReadHint(readFilesOf(s), "b.ts", 1, 10)).toBeNull();
    expect(renderParentReadHint(readFilesOf(s), "a.ts", 9_000, 9_999)).toContain("全文");
  });
  it("无清单 → null", () => {
    expect(renderParentReadHint(undefined, "a.ts", 1, 10)).toBeNull();
    expect(renderParentReadHint([], "a.ts", 1, 10)).toBeNull();
  });
});
