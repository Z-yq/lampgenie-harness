/**
 * 设计沉淀单测:done 板 → 项目级沉淀索引(board-archive.json)。
 * 覆盖:登记形状(files=节点 symbolRef.file 去重)/upsert 幂等/读容错/项目过滤/
 *       收官链路组合(finalize→archiveDoneBoard)/WS 回路(board.archive.list)/app 收官钩子集成。
 */
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveBoard, loadBoard, loadBoardArchive, boardArchiveFor, archiveBoard, archiveDoneBoard, finalizeBoardOnTaskDone, boardArchivePath } from "../src/board-store.js";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import type { BoardDoc } from "@lampgenie/protocol";
import { repoRoot } from "../src/repo-root.js";

const doneDoc = (over: Partial<BoardDoc> = {}): BoardDoc => ({
  version: 1,
  taskId: "t1",
  sessionId: "s1",
  title: "给白板加语义流程",
  status: "done",
  rev: 3,
  nodes: [
    { id: "n1", kind: "function", label: "wbRender", summary: "渲染", change: "modify", done: true, comments: [],
      symbolRef: { name: "wbRender", file: "src/a.ts", line: 3 }, flow: [] },
    { id: "n2", kind: "module", label: "board-store", summary: "存储", change: "add", done: false, comments: [],
      symbolRef: { name: "board-store", file: "src/a.ts", line: 90 }, flow: [] },
    { id: "n3", kind: "note", label: "备注", summary: "无代码连接", change: "keep", done: false, comments: [], flow: [] },
  ],
  edges: [],
  planned_files: ["src/a.ts"],
  updatedAt: 1700000000000,
  ...over,
});

let tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "gh-barc-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("archiveBoard 登记(upsert 幂等)", () => {
  it("只收 done 板;files=节点 symbolRef.file 去重;条目形状完整", () => {
    const r = tmp();
    expect(archiveBoard(r, doneDoc(), "p1")).toBe(true);
    // draft/implementing 是活草图,不沉淀
    expect(archiveBoard(r, doneDoc({ status: "draft" }), "p1")).toBe(false);
    expect(archiveBoard(r, doneDoc({ status: "implementing" }), "p1")).toBe(false);
    const items = loadBoardArchive(r);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sessionId: "s1", taskId: "t1", projectId: "p1", title: "给白板加语义流程", status: "done", nodeCount: 3 });
    expect(items[0].files).toEqual(["src/a.ts"]); // n1/n2 同文件去重;n3 无 symbolRef 不进
    expect(typeof items[0].archivedAt).toBe("number");
  });
  it("重复登记同键覆盖不重复(重启/钩子重放幂等),最新内容生效", () => {
    const r = tmp();
    archiveBoard(r, doneDoc(), "p1");
    archiveBoard(r, doneDoc({ title: "改名后的板", rev: 9, updatedAt: 1800000000000 }), "p1");
    const items = loadBoardArchive(r);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("改名后的板");
    expect(items[0].updatedAt).toBe(1800000000000);
  });
});

describe("loadBoardArchive 读容错", () => {
  it("缺文件/坏 JSON → 空数组不炸", () => {
    const r = tmp();
    expect(loadBoardArchive(r)).toEqual([]);
    const { mkdirSync: mk } = require("node:fs");
    mk(join(r, ".genie"), { recursive: true });
    writeFileSync(boardArchivePath(r), "{not json");
    expect(loadBoardArchive(r)).toEqual([]);
  });
  it("boardArchiveFor 按项目过滤;updatedAt 倒序", () => {
    const r = tmp();
    archiveBoard(r, doneDoc({ taskId: "t1", updatedAt: 100 }), "p1");
    archiveBoard(r, doneDoc({ taskId: "t2", sessionId: "s2", updatedAt: 300 }), "p2");
    archiveBoard(r, doneDoc({ taskId: "t3", sessionId: "s3", updatedAt: 200 }), "p1");
    expect(boardArchiveFor(r, "p1").map((x) => x.taskId)).toEqual(["t3", "t1"]);
    expect(boardArchiveFor(r, "p2").map((x) => x.taskId)).toEqual(["t2"]);
    expect(boardArchiveFor(r, "p-none")).toEqual([]);
  });
});

describe("收官链路组合(finalize 回填 → archiveDoneBoard)", () => {
  it("archiveDoneBoard:盘上 done 板登记;非 done/板不存在 → false;回填置 done 后可沉淀", async () => {
    const r = tmp();
    saveBoard(r, doneDoc({ status: "implementing" }));
    expect(archiveDoneBoard(r, "s1", "t1", "p1")).toBe(false); // 未收官不沉淀
    // finalize 回填(diffstatFn 注入,sha 非 null 走正常对账路径)会置 status=done
    const rr = await finalizeBoardOnTaskDone({ storeRoot: r, sessionId: "s1", taskId: "t1", workdir: r, sha: "fake-snapshot-sha",
      diffstatFn: async () => ({ files: [{ path: "src/a.ts" }], total: { files: 1, add: 2, del: 0 } }) });
    expect(rr.backfilled).toBe(true);
    expect(loadBoard(r, "s1", "t1")?.status).toBe("done");
    expect(archiveDoneBoard(r, "s1", "t1", "p1")).toBe(true);
    expect(boardArchiveFor(r, "p1")).toHaveLength(1);
    expect(archiveDoneBoard(r, "s1", "ghost", "p1")).toBe(false);
  });
});

// ---- 生产语义面(repoRoot 存取,用完即清/快照还原) ----
const rr = repoRoot();
const sidA = "vitest-barc-" + Date.now();
let archiveBackup: string | null = null;
function cleanupArchive(): void {
  try {
    if (archiveBackup === null) {
      // 测试前索引不存在 → 测试后删除测试条目形态=还原为不存在
      const items = loadBoardArchive(rr).filter((it) => !it.sessionId.startsWith("vitest-barc-"));
      const p = boardArchivePath(rr);
      if (items.length === 0 && existsSync(p)) rmSync(p);
      else if (items.length > 0) writeFileSync(p, JSON.stringify({ version: 1, items }, null, 1));
    } else writeFileSync(boardArchivePath(rr), archiveBackup, "utf-8");
  } catch { /* 尽力还原 */ }
}

describe("WS 回路(board.archive.list)", () => {
  let app: GatewayApp | null = null;
  afterEach(async () => { await app?.close(); app = null; cleanupArchive(); rmSync(join(rr, ".genie", "boards", sidA), { recursive: true, force: true }); });
  it("存 done 板→登记→查询回条目;projectId 过滤;空项目回空表", async () => {
    archiveBackup = existsSync(boardArchivePath(rr)) ? readFileSync(boardArchivePath(rr), "utf-8") : null;
    saveBoard(rr, doneDoc({ sessionId: sidA, taskId: "ta1", title: "沉淀验收板" }));
    expect(archiveDoneBoard(rr, sidA, "ta1", "__harness__")).toBe(true);
    rmSync(join(rr, ".genie", "boards", sidA), { recursive: true, force: true });
    app = createGatewayApp({ port: 7821 });
    const ws = new WebSocket("ws://127.0.0.1:7821");
    const inbox: Record<string, unknown>[] = [];
    ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
    await new Promise((r) => ws.on("open", r));
    const wait = (pred: (m: Record<string, unknown>) => boolean) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const cursor = inbox.length;
        const t = setTimeout(() => reject(new Error("等消息超时")), 8000);
        const poll = setInterval(() => {
          const hit = inbox.slice(cursor).find(pred);
          if (hit) { clearTimeout(t); clearInterval(poll); resolve(hit); }
        }, 30);
      });
    ws.send(JSON.stringify({ v: 1, type: "board.archive.list", projectId: "__harness__" }));
    const got = await wait((m) => m.type === "board.archive.result" && (m.projectId as string) === "__harness__");
    const items = got.items as { sessionId: string; taskId: string; title: string; files: string[] }[];
    const mine = items.find((i) => i.sessionId === sidA);
    expect(mine && mine.title).toBe("沉淀验收板");
    expect(mine && mine.files).toEqual(["src/a.ts"]);
    // 项目过滤:别的项目查不到
    ws.send(JSON.stringify({ v: 1, type: "board.archive.list", projectId: "p-other" }));
    const got2 = await wait((m) => m.type === "board.archive.result" && (m.projectId as string) === "p-other");
    expect((got2.items as unknown[]).some((i) => (i as { sessionId: string }).sessionId === sidA)).toBe(false);
    ws.close();
  }, 20000);
});

describe("app 收官钩子集成(任务 done → 自动沉淀)", () => {
  let app: GatewayApp | null = null;
  afterEach(async () => { await app?.close(); app = null; cleanupArchive(); rmSync(join(rr, ".genie", "boards", sidA), { recursive: true, force: true }); });
  it("deferred executor:任务收尾前置板 → done 后索引出现条目(projectId 缺省归 __harness__)", async () => {
    archiveBackup = existsSync(boardArchivePath(rr)) ? readFileSync(boardArchivePath(rr), "utf-8") : null;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const backend = {
      kind: "barc-deferred",
      async spawn(spec: { taskId: string }, onEvent: (e: Record<string, unknown>) => void) {
        await gate;
        onEvent({ type: "result", result: { ok: true, finalText: "ok" } });
        return { taskId: spec.taskId, cancel: async () => {}, steer: async () => true, respondPermission: async () => {} };
      },
    } as never;
    app = createGatewayApp({ port: 7822, executor: backend });
    const t = app.taskManager.submit("user", sidA, "做一版有白板设计的改造");
    // 任务卡在 running(gate):此刻按任务 id 造 done 板(生产=agent 实施中画板收官置 done)
    saveBoard(rr, doneDoc({ sessionId: sidA, taskId: t.id, title: "钩子沉淀板" }));
    release!();
    // 收官钩子是异步链(diffstat→回填→登记):轮询索引直到条目出现。
 // 窗口 20s:diffstat 跑在慢盘 drvfs 的真实仓根,负载下秒级抖动经验证存在(生产是异步钩,不涉及时序)。
    const t0 = Date.now();
    let hit: { title: string; projectId: string } | null = null;
    while (Date.now() - t0 < 20000) {
      hit = boardArchiveFor(rr, "__harness__").find((x) => x.sessionId === sidA && x.taskId === t.id) ?? null;
      if (hit) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(hit && hit.title).toBe("钩子沉淀板");
    expect(hit && hit.projectId).toBe("__harness__");
    // 幂等:钩子不会给同一任务登记第二条(upsert 同键)
    expect(boardArchiveFor(rr, "__harness__").filter((x) => x.sessionId === sidA && x.taskId === t.id)).toHaveLength(1);
  }, 25000);
});
