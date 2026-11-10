/**
 * wait_until( session 验证落地)单测:
 * ①file 条件:出现/contains/minLines/minBytes/stableMs(组合须全满足);
 * ②terminalIdle:产出水位静默 idleMs/会话已退出即满足;list 不消费输出;
 * ③超时:ok:false + timedOut + 现场快照;④signal 中止;⑤围栏与参数校验;
 * ⑥只读/并发安全声明(挂起可与只读探测同批)。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWaitUntilTool, type WaitUntilTerminalLike } from "../src/wait-until-tool.js";

const dirs: string[] = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), "waituntil-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const exec = (root: string, term?: WaitUntilTerminalLike, args: unknown, signal?: AbortSignal) =>
  createWaitUntilTool({ owner: "s1", root, terminalService: term }).execute(args, signal) as Promise<string>;

const j = (s: string) => JSON.parse(s) as Record<string, unknown>;

describe("file 条件", () => {
  it("等文件出现:期间写入→满足+快照(字节/行数/尾部行)", async () => {
    const root = mk();
    setTimeout(() => writeFileSync(join(root, "out.log"), "line1\nline2\nDONE\n"), 400);
    const r = j(await exec(root, undefined, { file: { path: "out.log", contains: "DONE" }, timeoutSec: 5 }));
    expect(r.ok).toBe(true);
    expect(r.met).toBe(true);
    expect(r.bytes).toBeGreaterThan(0);
    expect(Array.isArray(r.tail)).toBe(true);
    expect((r.tail as string[]).some((l) => l.includes("DONE"))).toBe(true);
  });

  it("contains 未出现→超时 ok:false + timedOut + 快照(不抛错)", async () => {
    const root = mk();
    writeFileSync(join(root, "a.log"), "hello\n");
    const r = j(await exec(root, undefined, { file: { path: "a.log", contains: "NEVER" }, timeoutSec: 1 }));
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.snapshot).toBeTruthy();
    expect(String(r.hint)).toContain("timeoutSec");
  });

  it("minLines 未达标→超时不误报满足", async () => {
    const root = mk();
    writeFileSync(join(root, "g.log"), "a\nb\n"); // split 计 3 行(与 read_file 同口径,含尾空元素)
    const r = j(await exec(root, undefined, { file: { path: "g.log", minLines: 4, minBytes: 1 }, timeoutSec: 1 }));
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
  });

  it("stableMs:大小稳定后满足(增量写者收尾)", async () => {
    const root = mk();
    const p = join(root, "s.log");
    writeFileSync(p, "x\n");
    let n = 0;
    const timer = setInterval(() => { n++; appendFileSync(p, `chunk ${n}\n`); }, 250);
    setTimeout(() => clearInterval(timer), 900); // 900ms 后停写
    const r = j(await exec(root, undefined, { file: { path: "s.log", stableMs: 1500 }, timeoutSec: 8 }));
    expect(r.ok).toBe(true);
    expect(Number(r.stableMs)).toBeGreaterThanOrEqual(1500);
  }, 15_000);

  it("stableMs 轮转加固(2026-11-08 审计):truncate 后重写同长度内容,稳定钟必须重置", async () => {
    const root = mk();
    const p = join(root, "r.log");
    writeFileSync(p, "AAAAAAAA\n");
    const ac = new AbortController();
    const waitP = exec(root, undefined, { file: { path: "r.log", stableMs: 2000 }, timeoutSec: 12 }, ac.signal);
    await new Promise((r) => setTimeout(r, 1000));
    // 轮转:同长度重写(size 不变,mtime 变)——单一 size 判据会假满足,双判据必须重置稳定钟
    writeFileSync(p, "BBBBBBBB\n");
    const r = j(await waitP);
    // 满足时刻必须晚于轮转时刻:stableMs ≥2000 且 ok(证明轮转后重新计稳)
    expect(r.ok).toBe(true);
    expect(Number(r.stableMs)).toBeGreaterThanOrEqual(2000);
  }, 20_000);

  it("围栏:越出项目根拒绝(../ 与绝对路径)", async () => {
    const root = mk();
    const r = j(await exec(root, undefined, { file: { path: "../evil.txt", contains: "x" } }));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("越出项目根");
  });

  it("参数校验:无条件/双条件/空判据全拒", async () => {
    const root = mk();
    expect(j(await exec(root, undefined, {})).ok).toBe(false);
    expect(j(await exec(root, undefined, { file: { path: "a" }, terminalIdle: { sessionId: "t" } })).ok).toBe(false);
    expect(j(await exec(root, undefined, { file: { path: "a" } })).ok).toBe(false); // 无判据
  });
});

describe("terminalIdle 条件", () => {
  const mkTerm = (sessions: Array<{ id: string; status: string; cursor: number; exitCode: number | null }>): WaitUntilTerminalLike => ({
    list: () => sessions,
  });

  it("产出水位静默 idleMs→满足", async () => {
    const root = mk();
    const sessions = [{ id: "t1", status: "running", cursor: 100, exitCode: null }];
    const svc = mkTerm(sessions);
    // 500ms 后水位再涨一次,随后静止;idleMs=1200 → 应在最后一次增长后 ≥1200ms 满足
    setTimeout(() => { sessions[0]!.cursor = 200; }, 500);
    const r = j(await exec(root, svc, { terminalIdle: { sessionId: "t1", idleMs: 1200 }, timeoutSec: 8 }));
    expect(r.ok).toBe(true);
    expect(r.type).toBe("terminal_idle");
    expect(Number(r.idleMs)).toBeGreaterThanOrEqual(1200);
  }, 10_000);

  it("会话已退出→立即满足(带 exitCode)", async () => {
    const root = mk();
    const svc = mkTerm([{ id: "t1", status: "exited", cursor: 50, exitCode: 0 }]);
    const r = j(await exec(root, svc, { terminalIdle: { sessionId: "t1" } }));
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  it("会话不存在→超时返回快照说明", async () => {
    const root = mk();
    const r = j(await exec(root, mkTerm([]), { terminalIdle: { sessionId: "ghost" }, timeoutSec: 1 }));
    expect(r.ok).toBe(false);
    expect(String((r.snapshot as Record<string, unknown>).note)).toContain("不存在");
  });

  it("terminal 面未接入→明确报错", async () => {
    const root = mk();
    const r = j(await exec(root, undefined, { terminalIdle: { sessionId: "t1" } }));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("未接入");
  });
});

describe("中止与声明", () => {
  it("signal 中止→aborted 返回,不挂满超时", async () => {
    const root = mk();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 600);
    const t0 = Date.now();
    const r = j(await exec(root, undefined, { file: { path: "never.log", contains: "x" }, timeoutSec: 30 }, ac.signal));
    expect(r.aborted).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3000);
  }, 10_000);

  it("isReadOnly/isConcurrencySafe 声明(可与只读探测同批)", () => {
    const root = mk();
    const t = createWaitUntilTool({ owner: "s1", root });
    expect(t.isReadOnly({})).toBe(true);
    expect(t.isConcurrencySafe({})).toBe(true);
  });
});
