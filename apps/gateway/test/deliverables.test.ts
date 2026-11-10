/**
 * M170 交付物声明账本(deliverable,2026-11-07)。
 *
 * A. 工具层:真实临时目录下登记成功 / 拒绝(不存在、目录、符号链接、空路径)/ journal 落账 / 幂等不膨胀 / 回执与 schema;
 * B. 纯函数:readDeliverables 回读、verifyDeliverables 核对(删除、变成目录)、renderDeliverables 段与缺失警告;
 * C. 收尾钩子(agent-wiring):done 追加「## 交付物」段并落 deliverable.verified;failed 不发布。
 */
import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayApp } from "../src/app.js";
import { buildExecutorFromConfig } from "../src/factory.js";
import { acquireEnvLock, releaseEnvLock } from "./support/env-lock.js";
import {
  DELIVERABLE_TOOL_NAME,
  makeDeliverableTool,
  readDeliverables,
  verifyDeliverables,
  renderDeliverables,
  renderDeliverableWarning,
  type DeliverableJournal,
} from "../src/deliverables.js";

// ---- 假 journal(带 idempotencyKey 语义:同键不新增行,返回既有事件——与真实 journal 同口径) ----
interface Ev { kind: string; sessionId: string; payload: Record<string, unknown>; seq?: number; idempotencyKey?: string }
function fakeJournal() {
  const evs: Ev[] = [];
  const byKey = new Map<string, Ev>();
  const j: DeliverableJournal & { evs: Ev[] } = {
    evs,
    append(e) {
      if (e.idempotencyKey) {
        const hit = byKey.get(e.idempotencyKey);
        if (hit) return hit;
        const created = { ...e, seq: evs.length + 1 } as Ev;
        evs.push(created);
        byKey.set(e.idempotencyKey, created);
        return created;
      }
      const created = { ...e, seq: evs.length + 1 } as Ev;
      evs.push(created);
      return created;
    },
    readAll() { return evs; },
  };
  return j;
}

const tmpDirs: string[] = [];
afterAll(() => { for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "genie-dlv-"));
  tmpDirs.push(d);
  return d;
}

describe("deliverable 工具", () => {
  it("普通文件:登记成功、回执带绝对路径与字节数、journal 落 deliverable.declared", async () => {
    const root = tmpDir();
    writeFileSync(join(root, "report.md"), "hello", "utf-8");
    const j = fakeJournal();
    const tool = makeDeliverableTool({ journal: j, sessionId: "s1", taskId: "t1", root });
    expect(tool.name).toBe(DELIVERABLE_TOOL_NAME);
    const out = await tool.execute({ path: "report.md", note: "周报" });
    expect(out).toContain("已登记交付物:");
    expect(out).toContain("report.md");
    expect(out).toContain("(5 bytes)");
    expect(j.evs.length).toBe(1);
    const p = j.evs[0]!.payload;
    expect(p.type).toBe("deliverable.declared");
    expect(p.taskId).toBe("t1");
    expect(p.inputPath).toBe("report.md");
    expect(String(p.processPath).endsWith("report.md")).toBe(true);
    expect(p.size).toBe(5);
    expect(typeof p.mtimeMs).toBe("number");
    expect(p.note).toBe("周报");
    // schema 断言:path 必填,只有 path/note 两个属性
    const params = tool.parameters as { required?: string[]; properties?: Record<string, unknown> };
    expect(params.required).toEqual(["path"]);
    expect(Object.keys(params.properties ?? {}).sort()).toEqual(["note", "path"]);
  });

  it("不存在 / 目录 / 符号链接 / 空路径 → 拒绝且不落 declared", async () => {
    const root = tmpDir();
    mkdirSync(join(root, "out"));
    writeFileSync(join(root, "real.txt"), "x", "utf-8");
    symlinkSync(join(root, "real.txt"), join(root, "link.txt"));
    const j = fakeJournal();
    const tool = makeDeliverableTool({ journal: j, sessionId: "s1", taskId: "t1", root });

    expect(await tool.execute({ path: "nope.md" })).toContain("错误:文件不存在");
    expect(await tool.execute({ path: "out" })).toContain("错误:不是普通文件");
    expect(await tool.execute({ path: "link.txt" })).toContain("错误:不接受符号链接");
    expect(await tool.execute({ path: "   " })).toContain("错误:path 不能为空");
    expect(await tool.execute({})).toContain("错误:path 不能为空");
    expect(j.evs.length, "拒绝的登记绝不能落 declared").toBe(0);
  });

  it("重复 declare 同一文件:幂等(不新增行),刷新 size/note", async () => {
    const root = tmpDir();
    const f = join(root, "deck.pptx");
    writeFileSync(f, "a", "utf-8");
    const j = fakeJournal();
    const tool = makeDeliverableTool({ journal: j, sessionId: "s1", taskId: "t1", root });
    await tool.execute({ path: "deck.pptx" });
    writeFileSync(f, "abcdef", "utf-8");
    const out2 = await tool.execute({ path: "deck.pptx", note: "第二版" });
    expect(out2).toContain("(6 bytes)");
    expect(j.evs.length).toBe(1);
    const p = j.evs[0]!.payload;
    expect(p.size).toBe(6);
    expect(p.note).toBe("第二版");
    expect(readDeliverables(j, "s1", "t1").length).toBe(1);
  });

  it("绝对路径与相对路径指向同一文件只算一份", async () => {
    const root = tmpDir();
    const f = join(root, "img.png");
    writeFileSync(f, "png", "utf-8");
    const j = fakeJournal();
    const tool = makeDeliverableTool({ journal: j, sessionId: "s1", taskId: "t1", root });
    await tool.execute({ path: "img.png" });
    await tool.execute({ path: f });
    expect(j.evs.length).toBe(1);
  });
});

describe("回读 / 核对 / 渲染", () => {
  it("readDeliverables 只取本会话本任务的声明", async () => {
    const root = tmpDir();
    writeFileSync(join(root, "a.md"), "1", "utf-8");
    writeFileSync(join(root, "b.md"), "2", "utf-8");
    const j = fakeJournal();
    await makeDeliverableTool({ journal: j, sessionId: "s1", taskId: "t1", root }).execute({ path: "a.md" });
    await makeDeliverableTool({ journal: j, sessionId: "s1", taskId: "t2", root }).execute({ path: "b.md" });
    await makeDeliverableTool({ journal: j, sessionId: "s2", taskId: "t1", root }).execute({ path: "b.md" });
    const list = readDeliverables(j, "s1", "t1");
    expect(list.length).toBe(1);
    expect(list[0]!.inputPath).toBe("a.md");
  });

  it("声明后删除 → missing;声明后变成目录 → not-file;仍在 → ok + size", async () => {
    const root = tmpDir();
    writeFileSync(join(root, "gone.md"), "x", "utf-8");
    writeFileSync(join(root, "gone2.md"), "x", "utf-8");
    writeFileSync(join(root, "stay.md"), "ok!", "utf-8");
    const j = fakeJournal();
    const tool = makeDeliverableTool({ journal: j, sessionId: "s1", taskId: "t1", root });
    for (const p of ["gone.md", "gone2.md", "stay.md"]) await tool.execute({ path: p });

    unlinkSync(join(root, "gone.md"));
    unlinkSync(join(root, "gone2.md"));
    mkdirSync(join(root, "gone2.md"));

    const items = verifyDeliverables(readDeliverables(j, "s1", "t1"));
    const byPath = new Map<string, (typeof items)[number]>(items.map((i) => [i.path, i] as const));
    const gone = byPath.get(join(root, "gone.md"))!;
    const gone2 = byPath.get(join(root, "gone2.md"))!;
    const stay = byPath.get(join(root, "stay.md"))!;
    expect(gone.ok).toBe(false);
    expect(gone.reason).toBe("missing");
    expect(gone2.ok).toBe(false);
    expect(gone2.reason).toBe("not-file");
    expect(stay.ok).toBe(true);
    expect(stay.size).toBe(3);
  });

  it("renderDeliverables 生成「## 交付物」段并点名缺失;全在时无警告", () => {
    const items = [
      { path: "/p/a.md", ok: true, size: 12 },
      { path: "/p/b.md", ok: false, reason: "missing" as const },
    ];
    const seg = renderDeliverables(items);
    expect(seg.startsWith("## 交付物")).toBe(true);
    expect(seg).toContain("/p/a.md — 存在(12 bytes)");
    expect(seg).toContain("/p/b.md — 缺失(文件不存在)");
    expect(renderDeliverableWarning(items)).toContain("[交付物] 声明后缺失/变更:/p/b.md");
    expect(renderDeliverableWarning([items[0]!])).toBe("");
    expect(renderDeliverables([])).toBe("");
  });
});

// ---- C. 收尾钩子(agent-wiring) ----
beforeAll(async () => { await acquireEnvLock("deliverables"); }, 240_000);
afterAll(() => { releaseEnvLock("deliverables"); });

type App = ReturnType<typeof createGatewayApp>;
const gwApps: App[] = [];
afterEach(async () => {
  for (const a of gwApps.splice(0)) await a.close();
  delete process.env.GENIE_VERIFY_ON_STOP;
});

const INSTRUCTION = "产出周报";
type Append = (e: { kind: string; sessionId: string; payload: Record<string, unknown> }) => void;

async function runScenario(s: { sid: string; seed: (sid: string, append: Append, taskId: string) => void; failOnFirstTurn?: boolean }): Promise<{ state: string; result: string; app: App }> {
  let appRef: App;
  let step = 0;
  const app = createGatewayApp({
    port: 0,
    llm: {
      async chat() {
        if (step++ === 0) {
          // 真实 taskId 是收尾核对 declared 的匹配键(readDeliverables 按 taskId 过滤)。
          const tid = appRef.taskManager.list().find((x) => x.sessionId === s.sid)?.id ?? "";
          s.seed(s.sid, (e) => { appRef.journal.append(e as never); }, tid);
          if (s.failOnFirstTurn) throw new Error("provider boom");
          return { content: "终稿" };
        }
        return { content: "终稿" };
      },
    } as never,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  appRef = app;
  gwApps.push(app);
  app.taskManager.submit("user", s.sid, INSTRUCTION);
  for (let k = 0; k < 240; k++) {
    const t = app.taskManager.list().find((x) => x.sessionId === s.sid);
    if (t && (t.state === "done" || t.state === "failed")) return { state: t.state, result: String(t.result ?? ""), app };
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("任务未在时限内终态");
}

/** 声明事件(收尾只按 processPath 核对,不必走工具)。 */
const declared = (sid: string, taskId: string, processPath: string, inputPath: string, append: Append) =>
  append({
    kind: "custom", sessionId: sid,
    payload: { type: "deliverable.declared", taskId, inputPath, processPath, size: 2, mtimeMs: 1, at: Date.now() },
  });

describe("收尾交付物核对(agent-wiring)", () => {
  it("done + 有声明 → 追加「## 交付物」段、落 deliverable.verified;文件在则无警告", async () => {
    const root = tmpDir();
    const f = join(root, "report.md");
    writeFileSync(f, "hi", "utf-8");
    const r = await runScenario({ sid: "dlv-done-1", seed: (sid, append, tid) => declared(sid, tid, f, "report.md", append) });
    expect(r.state).toBe("done");
    expect(r.result).toContain("## 交付物");
    expect(r.result).toContain("report.md");
    expect(r.result).toContain("存在");
    expect(r.result).not.toContain("[交付物]");
    const types = r.app.journal.readAll()
      .filter((e) => e.kind === "custom" && e.sessionId === "dlv-done-1")
      .map((e) => String((e.payload as { type?: string }).type ?? ""));
    expect(types).toContain("deliverable.verified");
  }, 120_000);

  it("done + 声明后删文件 → 段内点名缺失并追加警告", async () => {
    const root = tmpDir();
    const f = join(root, "gone.pptx");
    writeFileSync(f, "x", "utf-8");
    unlinkSync(f);
    const r = await runScenario({ sid: "dlv-done-2", seed: (sid, append, tid) => declared(sid, tid, f, "gone.pptx", append) });
    expect(r.state).toBe("done");
    expect(r.result).toContain("缺失(文件不存在)");
    expect(r.result).toContain("[交付物] 声明后缺失/变更");
  }, 120_000);

  it("未声明 → 不追加「## 交付物」段", async () => {
    const r = await runScenario({ sid: "dlv-done-3", seed: () => { /* 无声明 */ } });
    expect(r.state).toBe("done");
    expect(r.result).not.toContain("## 交付物");
  }, 120_000);

  it("failed → 不发布交付物段(即使有声明)", async () => {
    const root = tmpDir();
    const f = join(root, "report2.md");
    writeFileSync(f, "hi", "utf-8");
    const r = await runScenario({
      sid: "dlv-failed-1",
      seed: (sid, append, tid) => declared(sid, tid, f, "report2.md", append),
      failOnFirstTurn: true,
    });
    expect(r.state).toBe("failed");
    expect(r.result).not.toContain("## 交付物");
  }, 120_000);
});
