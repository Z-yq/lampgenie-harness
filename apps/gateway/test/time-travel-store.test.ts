/**
 * 时间旅行 IO 层单测:内容寻址快照/恢复/删除/缺 blob/越界/fork 截断。
 * 全部在 /tmp 临时根内跑(不碰仓库工作区)。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { MemoryJournal, type Journal } from "@lampgenie/core";
import { TimeTravelStore } from "../src/time-travel-store.js";

let root = "";
let store: TimeTravelStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "m117-store-"));
  store = new TimeTravelStore({ root });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

async function write(rel: string, text: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text);
}

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(root, rel), "utf8");
}

async function exists(rel: string): Promise<boolean> {
  return fs.access(path.join(root, rel)).then(() => true).catch(() => false);
}

describe("capture(计划→读盘→内容寻址 blob→manifest)", () => {
  it("拍 3 个文件(含不存在):existed 标记正确、越界路径被跳过、blob 落盘", async () => {
    await write("a.txt", "AAA");
    await write("dir/b.txt", "BBB");
    const r = await store.capture("s1", "t1s1", root, ["a.txt", "dir/b.txt", "missing.txt", "../escape.txt"]);
    expect(r.ok).toBe(true);
    const files = r.manifest!.files;
    expect(files.map((f) => [f.path, f.existed])).toEqual([
      ["a.txt", true],
      ["dir/b.txt", true],
      ["missing.txt", false],
    ]);
    expect(r.skipped!.some((s) => s.reason === "outside-root")).toBe(true);
    const a = files.find((f) => f.path === "a.txt")!;
    expect(a.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(await fs.readFile(store.blobPath(a.sha!), "utf8")).toBe("AAA");
  });

  it("同内容两文件只存一份 blob(内容寻址)", async () => {
    await write("x.txt", "SAME");
    await write("y.txt", "SAME");
    const r = await store.capture("s1", "t1s1", root, ["x.txt", "y.txt"]);
    const shas = r.manifest!.files.map((f) => f.sha);
    expect(shas[0]).toBe(shas[1]);
    const blobs = await fs.readdir(path.join(root, ".genie", "time-travel", "blobs"));
    expect(blobs).toEqual([shas[0]]);
  });

  it("manifest 落 <session>/<stepId>.json", async () => {
    await write("a.txt", "A");
    await store.capture("s1", "t1s1", root, ["a.txt"]);
    const text = await fs.readFile(path.join(root, ".genie", "time-travel", "s1", "t1s1.json"), "utf8");
    expect(JSON.parse(text).files[0].path).toBe("a.txt");
  });

  it("preview 列出 manifest 文件;没有 manifest 返回 fail-soft code", async () => {
    await write("a.txt", "A");
    await store.capture("s1", "t1s1", root, ["a.txt"]);
    const p = await store.preview("s1", "t1s1");
    expect(p.ok).toBe(true);
    expect(p.files.map((f) => f.path)).toEqual(["a.txt"]);
    const miss = await store.preview("s1", "t9s9");
    expect(miss).toEqual({ ok: false, files: [], code: "MANIFEST_MISSING" });
  });
});

describe("restore(写回/删除/缺 blob/越界)", () => {
  it("改/删/建之后恢复:内容与存在性复原", async () => {
    await write("a.txt", "ORIGINAL-A");
    await write("b.txt", "ORIGINAL-B");
    const cap = await store.capture("s1", "t1s1", root, ["a.txt", "b.txt", "new.txt"]);
    expect(cap.ok).toBe(true);
 // 工具执行:改 a、删 b、建 new
    await write("a.txt", "CHANGED-A");
    await fs.unlink(path.join(root, "b.txt"));
    await write("new.txt", "CREATED");
    const r = await store.restore("s1", "t1s1");
    expect(r.ok).toBe(true);
    expect(r.restored).toBe(2);
    expect(r.deleted).toBe(1);
    expect(await read("a.txt")).toBe("ORIGINAL-A");
    expect(await read("b.txt")).toBe("ORIGINAL-B");
    expect(await exists("new.txt")).toBe(false);
  });

  it("blob 缺失:进 missing,不写目标文件", async () => {
    await write("a.txt", "ORIGINAL");
    const cap = await store.capture("s1", "t1s1", root, ["a.txt"]);
    const sha = cap.manifest!.files[0].sha!;
    await fs.unlink(store.blobPath(sha));
    await write("a.txt", "CHANGED");
    const r = await store.restore("s1", "t1s1");
    expect(r.ok).toBe(true);
    expect(r.restored).toBe(0);
    expect(r.missing).toEqual(["a.txt"]);
    expect(await read("a.txt")).toBe("CHANGED");
  });

  it("manifest 里的越界路径被跳过(不动 root 外文件)", async () => {
    const outside = path.join(os.tmpdir(), `m117-outside-${process.pid}.txt`);
    await fs.writeFile(outside, "SAFE");
    const manifestFile = store.manifestPath("s1", "t1s1");
    await fs.mkdir(path.dirname(manifestFile), { recursive: true });
    await fs.writeFile(manifestFile, JSON.stringify({
      v: 1, sessionId: "s1", stepId: "t1s1", at: Date.now(), root,
      files: [{ path: "../" + path.basename(outside), existed: false }],
      skipped: [],
    }));
    const r = await store.restore("s1", "t1s1");
    expect(r.deleted).toBe(0);
    expect(await fs.readFile(outside, "utf8")).toBe("SAFE");
    await fs.unlink(outside).catch(() => {});
  });

  it("没有 manifest 返回 fail-soft code,不 throw", async () => {
    const r = await store.restore("s1", "nope");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("MANIFEST_MISSING");
  });
});

describe("forkEvents(截断复制/压缩边界)", () => {
  function buildJournal(): MemoryJournal {
    const j = new MemoryJournal();
    j.append({ kind: "message.user", sessionId: "s1", payload: { text: "u1" } });
    j.append({ kind: "message.agent", sessionId: "s1", payload: { text: "a1" } });
    j.append({ kind: "compact.done", sessionId: "s1", payload: { tail: ["m1", "m2"] } });
    j.append({ kind: "message.user", sessionId: "s1", payload: { text: "u2" } });
    j.append({ kind: "task.start", sessionId: "s1", payload: { taskId: "t" } });
    j.append({ kind: "message.agent", sessionId: "s1", payload: { text: "a2" } });
    return j;
  }

  it("atSeq 截断事件,之后的 compact.done 一并丢弃", async () => {
    const j = buildJournal();
    const all = j.readAll();
    const cutSeq = all.find((e) => e.kind === "message.agent" && e.payload!.text === "a1")!.seq;
    const s = new TimeTravelStore({ root, journal: j });
    const r = await s.forkEvents("s1", cutSeq, "fork-1");
    expect(r.ok).toBe(true);
    expect(r.copied).toBe(2);
    expect(r.dropped).toBe(4);
    const forked = j.readSession("fork-1");
    expect(forked.map((e) => e.kind)).toEqual(["message.user", "message.agent"]);
 // 继承事件保留 time/payload(seq 由 journal 重分配)
    expect(forked[0]!.payload).toEqual({ text: "u1" });
  });

  it("排除集不复制(任务生命周期噪声),但仍按 seq 截断", async () => {
    const j = buildJournal();
    const all = j.readAll();
    const cutSeq = all[all.length - 1]!.seq;
    const s = new TimeTravelStore({ root, journal: j });
    const r = await s.forkEvents("s1", cutSeq, "fork-2", new Set(["task.start"]));
    expect(r.copied).toBe(5);
    expect(j.readSession("fork-2").some((e) => e.kind === "task.start")).toBe(false);
  });

  it("异常/无 journal 返回 fail-soft code,不 throw", async () => {
    const s = new TimeTravelStore({ root });
    const r = await s.forkEvents("s1", 5, "fork-3");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("JOURNAL_MISSING");
  });
});

describe("边界校验(journal 在场时 stepId 必须真实存在)", () => {
  function buildJournal(): MemoryJournal {
    const j = new MemoryJournal();
    j.append({ kind: "step.start", sessionId: "s1", payload: { turn: 1, step: 1 } });
    j.append({ kind: "message.agent", sessionId: "s1", payload: { text: "a1" } });
    return j;
  }

  it("合法 stepId(journal 有 t1s1):preview/restore 照常通过", async () => {
    await write("a.txt", "A");
    const s = new TimeTravelStore({ root, journal: buildJournal() });
    const cap = await s.capture("s1", "t1s1", root, ["a.txt"]);
    expect(cap.ok).toBe(true);
    const p = await s.preview("s1", "t1s1");
    expect(p.ok).toBe(true);
    expect(p.files.map((f) => f.path)).toEqual(["a.txt"]);
    const r = await s.restore("s1", "t1s1");
    expect(r.ok).toBe(true);
  });

  it("不存在的 stepId → BOUNDARY_NOT_FOUND(preview 与 restore 同码)", async () => {
    const s = new TimeTravelStore({ root, journal: buildJournal() });
    const p = await s.preview("s1", "t9s9");
    expect(p).toEqual({ ok: false, files: [], code: "BOUNDARY_NOT_FOUND" });
    const r = await s.restore("s1", "t9s9");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("BOUNDARY_NOT_FOUND");
    expect(r.restored).toBe(0);
  });

  it("无 journal 保持旧行为:未知 stepId 走 MANIFEST_MISSING", async () => {
    const p = await store.preview("s1", "t9s9");
    expect(p).toEqual({ ok: false, files: [], code: "MANIFEST_MISSING" });
  });

  it("journal 读取异常 → JOURNAL_ERROR,不 throw", async () => {
    const broken = { readAll() { throw new Error("journal boom"); } } as unknown as Journal;
    const s = new TimeTravelStore({ root, journal: broken });
    const p = await s.preview("s1", "t1s1");
    expect(p).toEqual({ ok: false, files: [], code: "JOURNAL_ERROR" });
    const r = await s.restore("s1", "t1s1");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("JOURNAL_ERROR");
  });
});

describe("truncateMessages(只删对话:落事件/幂等/码表)", () => {
 /** step.start(1)+message.user(2)+message.agent(3):末条消息 seq=3。 */
  function conv(): MemoryJournal {
    const j = new MemoryJournal();
    j.append({ kind: "step.start", sessionId: "s1", payload: { turn: 1, step: 1 } });
    j.append({ kind: "message.user", sessionId: "s1", payload: { text: "u1" } });
    j.append({ kind: "message.agent", sessionId: "s1", payload: { text: "a1" } });
    return j;
  }

  function truncates(j: MemoryJournal): { boundarySeq: unknown; at: unknown; seq: number }[] {
    return j.readAll()
      .filter((e) => e.kind === "custom" && (e.payload as { type?: string }).type === "session.truncate")
      .map((e) => ({
        boundarySeq: (e.payload as { boundarySeq?: unknown }).boundarySeq,
        at: (e.payload as { at?: unknown }).at,
        seq: e.seq,
      }));
  }

  it("OK:落 custom{type,boundarySeq,at},返回 OK", async () => {
    const j = conv();
    const s = new TimeTravelStore({ root, journal: j });
    const r = await s.truncateMessages("s1", 1);
    expect(r).toEqual({ ok: true, code: "OK" });
    const rows = truncates(j);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.boundarySeq).toBe(1);
    expect(typeof rows[0]!.at).toBe("number");
 // 截断事件必须晚于 boundary(区间右端点)
    expect(rows[0]!.seq).toBeGreaterThan(1);
  });

  it("幂等键:同一 boundary 重复调用只落一条事件", async () => {
    const j = conv();
    const s = new TimeTravelStore({ root, journal: j });
    expect((await s.truncateMessages("s1", 1)).ok).toBe(true);
    expect((await s.truncateMessages("s1", 1)).ok).toBe(true);
    expect(truncates(j)).toHaveLength(1);
  });

  it("不同 boundary 各落一条(区间叠加,不是后写覆盖)", async () => {
    const j = new MemoryJournal();
    for (const text of ["u1", "a1", "u2", "a2"]) {
      j.append({ kind: text.startsWith("u") ? "message.user" : "message.agent", sessionId: "s1", payload: { text } });
    }
    const s = new TimeTravelStore({ root, journal: j });
    expect((await s.truncateMessages("s1", 1)).ok).toBe(true);
    expect((await s.truncateMessages("s1", 2)).ok).toBe(true);
    expect(truncates(j).map((t) => t.boundarySeq)).toEqual([1, 2]);
  });

  it("INVALID:0/负数/超最大 seq → 不写事件", async () => {
    const j = conv();
    const s = new TimeTravelStore({ root, journal: j });
    for (const bad of [0, -2, 99]) {
      expect(await s.truncateMessages("s1", bad)).toEqual({ ok: false, code: "INVALID" });
    }
    expect(truncates(j)).toHaveLength(0);
  });

  it("NO_BOUNDARY:无消息事件 / boundary 等于末条消息 seq → 不写事件", async () => {
    const noMsg = new MemoryJournal();
    noMsg.append({ kind: "turn.start", sessionId: "s1", payload: { turn: 1 } });
    noMsg.append({ kind: "step.start", sessionId: "s1", payload: { turn: 1, step: 1 } });
    const s1 = new TimeTravelStore({ root, journal: noMsg });
    expect(await s1.truncateMessages("s1", 1)).toEqual({ ok: false, code: "NO_BOUNDARY" });
    expect(truncates(noMsg)).toHaveLength(0);

    const j = conv();
    const lastMsgSeq = j.readAll().filter((e) => e.kind.startsWith("message.")).at(-1)!.seq;
    const s2 = new TimeTravelStore({ root, journal: j });
    expect(await s2.truncateMessages("s1", lastMsgSeq)).toEqual({ ok: false, code: "NO_BOUNDARY" });
    expect(truncates(j)).toHaveLength(0);
  });

  it("store 无 journal 且未传参 → JOURNAL_MISSING(不 throw)", async () => {
    expect(await store.truncateMessages("s1", 1)).toEqual({ ok: false, code: "JOURNAL_MISSING" });
  });

  it("显式传入 journal 优先于 store 持有的 journal", async () => {
    const held = conv();
    const explicit = conv();
    const s = new TimeTravelStore({ root, journal: held });
    expect(await s.truncateMessages("s1", 1, explicit)).toEqual({ ok: true, code: "OK" });
    expect(truncates(explicit)).toHaveLength(1);
    expect(truncates(held)).toHaveLength(0);
  });

  it("journal 异常 → TRUNCATE_FAILED:*,不 throw", async () => {
    const broken = { readAll() { throw new Error("boom"); } } as unknown as Journal;
    const s = new TimeTravelStore({ root, journal: broken });
    const r = await s.truncateMessages("s1", 1);
    expect(r.ok).toBe(false);
    expect(r.code.startsWith("TRUNCATE_FAILED:")).toBe(true);
  });

  it("append 抛错(只读 journal)→ TRUNCATE_FAILED:*,不 throw", async () => {
    const readOnly = {
      readAll: () => conv().readAll(),
      append() { throw new Error("append denied"); },
    } as unknown as Journal;
    const s = new TimeTravelStore({ root, journal: readOnly });
    const r = await s.truncateMessages("s1", 1);
    expect(r.ok).toBe(false);
    expect(r.code.startsWith("TRUNCATE_FAILED:")).toBe(true);
  });
});
