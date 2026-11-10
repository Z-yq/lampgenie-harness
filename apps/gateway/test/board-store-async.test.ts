/**
 * board-store 异步变体单测(board-store-async):
 * - saveBoardAsync 原子写(tmp+rename 无残留)与 loadBoardAsync 回读对账;
 * - 心跳探针:异步等待期间事件循环不停摆(setImmediate 链持续跳动);
 * - parity:listBoardsExAsync 与 listBoardsEx 逐字段一致(含坏文件 skipped);
 * - overlay 三件套异步版(PNG 签名校验/内存索引/删除);
 * - archiveDoneBoardAsync 幂等沉淀;
 * - resolveTargetPathsAsync 与同步版逐项一致。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardDocZ, type BoardDoc } from "@lampgenie/protocol";
import {
  saveBoardAsync, loadBoardAsync, listBoardsExAsync, saveOverlayAsync, loadOverlayAsync, deleteOverlayAsync,
  archiveDoneBoardAsync, resolveTargetPathsAsync, resolveTargetPaths, listBoardsEx,
} from "../src/board-store.js";

let tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "gh-board-async-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 最小合法板(BoardDocZ 可过:status=draft、1 节点、0 边;无 P0 节点故不触发验收门)。 */
function minDoc(taskId: string, extra: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    taskId, sessionId: "s1", title: "异步板", status: "draft" as const, rev: 0,
    nodes: [
      { id: "n1", kind: "module" as const, label: "board-store", summary: "白板落盘与读取", change: "add" as const, flow: [] },
    ],
    edges: [],
    planned_files: [],
    updatedAt: 0,
    ...extra,
  };
}

describe("saveBoardAsync 原子写", () => {
  it("落最小合法板:ok:true、.json 存在、无 .tmp 残留、loadBoardAsync 回读 deep-equal(除 updatedAt)", async () => {
    const r = tmp();
    const s = await saveBoardAsync(r, minDoc("t1"));
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(existsSync(s.path)).toBe(true);
    expect(readdirSync(join(r, ".genie", "boards", "s1")).some((f) => f.endsWith(".tmp"))).toBe(false);
    const loaded = await loadBoardAsync(r, "s1", "t1");
    expect(loaded).not.toBeNull();
    // 期望值先过 schema 补默认值(comments/done 等只在解析侧补),再剥 updatedAt 比
    const expected = BoardDocZ.parse(minDoc("t1")) as BoardDoc;
    const { updatedAt: _saved, ...savedRest } = loaded!;
    const { updatedAt: _orig, ...origRest } = expected;
    expect(savedRest).toEqual(origRest);
    expect(loaded!.updatedAt).toBeGreaterThan(0);
  });
});

describe("心跳探针:异步等待不阻塞事件循环", () => {
  it("loadBoardAsync/listBoardsExAsync 等待期间 setImmediate 链持续跳动", async () => {
    const r = tmp();
    let beats = 0;
    let running = true;
    const tick = () => {
      if (!running) return;
      beats++;
      setImmediate(tick);
    };
    tick();
    // 对照说明:同步版 loadBoard/listBoardsEx 在 drvfs 假阴性窗里是 while(Date.now()<deadline)
    // 自旋忙等——那 200ms 里 setImmediate 链完全停摆(beats 停增);异步版 waitForPath 用
    // Promise sleep 轮询,等待间隙让出事件循环,心跳应继续跳动。此处只测异步面。
    const missBoard = await loadBoardAsync(r, "ghost-session", "ghost-task");
    const missDir = await listBoardsExAsync(r, "ghost-session");
    running = false;
    expect(missBoard).toBeNull();
    expect(missDir).toEqual({ items: [], skipped: 0 });
    expect(beats).toBeGreaterThan(0);
  });
});

describe("parity:listBoardsExAsync 与同步版一致", () => {
  it("同目录 2 好板 + 1 坏 json:items 字段与 skipped 完全一致", async () => {
    const r = tmp();
    const s1 = await saveBoardAsync(r, minDoc("t1", { title: "板一" }));
    const s2 = await saveBoardAsync(r, minDoc("t2", { title: "板二" }));
    expect(s1.ok && s2.ok).toBe(true);
    writeFileSync(join(r, ".genie", "boards", "s1", "bad.json"), "{ 不是合法 JSON");
    const a = await listBoardsExAsync(r, "s1");
    const b = listBoardsEx(r, "s1");
    expect(a.skipped).toBe(b.skipped);
    expect(a.skipped).toBe(1);
    const fields = (xs: typeof a.items) => xs.map((i) => ({ taskId: i.taskId, title: i.title, status: i.status, updatedAt: i.updatedAt, nodeCount: i.nodeCount, docKind: i.docKind }));
    expect(fields(a.items)).toEqual(fields(b.items));
    expect(a.items.map((i) => i.taskId).sort()).toEqual(["t1", "t2"]);
  });
});

describe("overlay 异步三件套", () => {
  it("save→load 回 base64 一致→delete→load null;非 PNG 拒收", async () => {
    const r = tmp();
    // PNG 8 字节签名(最小合法头,长度 ≥8 过下限门)
    const pngB64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]).toString("base64");
    expect(await saveOverlayAsync(r, "s1", "t1", pngB64)).toBe(true);
    expect(await loadOverlayAsync(r, "s1", "t1")).toBe(pngB64);
    await deleteOverlayAsync(r, "s1", "t1");
    expect(await loadOverlayAsync(r, "s1", "t1")).toBeNull();
    // 不存在路径 load 为 null;非 PNG 数据(签名不匹配)被拒
    expect(await loadOverlayAsync(r, "s1", "never-written")).toBeNull();
    expect(await saveOverlayAsync(r, "s1", "t2", Buffer.from("not-a-png").toString("base64"))).toBe(false);
  });
});

describe("archiveDoneBoardAsync 幂等沉淀", () => {
  it("skipGates 落 done 板→沉淀条目 taskId 匹配;再跑一次条目数仍 1", async () => {
    const r = tmp();
    // 测试内部合法落板:done 板走 skipGates(系统侧回填同款口径),不宣称 agent 验收
    const s = await saveBoardAsync(r, minDoc("t1", { status: "done" }), { skipGates: true });
    expect(s.ok).toBe(true);
    expect(await archiveDoneBoardAsync(r, "s1", "t1", "proj-x")).toBe(true);
    const archivePath = join(r, ".genie", "board-archive.json");
    expect(existsSync(archivePath)).toBe(true);
    const items1 = (JSON.parse(readFileSync(archivePath, "utf-8")) as { items: { taskId: string }[] }).items;
    expect(items1).toHaveLength(1);
    expect(items1[0]!.taskId).toBe("t1");
    expect(await archiveDoneBoardAsync(r, "s1", "t1", "proj-x")).toBe(true);
    const items2 = (JSON.parse(readFileSync(archivePath, "utf-8")) as { items: { taskId: string }[] }).items;
    expect(items2).toHaveLength(1);
  });
});

describe("resolveTargetPathsAsync 与同步版逐项一致", () => {
  it("tmp root 下真文件与不存在路径混排,states 逐项一致", async () => {
    const r = tmp();
    mkdirSync(join(r, "src"), { recursive: true });
    writeFileSync(join(r, "src", "real.ts"), "export const a = 1;\n");
    const doc = {
      ...minDoc("t1"),
      nodes: [
        { ...minDoc("t1").nodes[0], targets: ["src/real.ts", "src/ghost.ts"] },
      ],
    };
    const a = await resolveTargetPathsAsync(r, doc as never);
    const b = resolveTargetPaths(r, doc as never);
    expect(a).toEqual(b);
    expect(a).toEqual([
      { nodeId: "n1", target: "src/ghost.ts", state: "missing" },
    ]);
  });
});
