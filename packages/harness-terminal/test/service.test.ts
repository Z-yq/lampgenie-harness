import { afterAll, describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TerminalSessionService } from "../src/service.js";
import type { TerminalAuditEvent, TerminalServiceOptions } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", ".."); // lampgenie-harness 根
const services: TerminalSessionService[] = [];

function make(opts: TerminalServiceOptions = {}): TerminalSessionService {
  const service = new TerminalSessionService({ closeGraceMs: 400, ...opts });
  services.push(service);
  return service;
}

afterAll(async () => {
  await Promise.allSettled(services.map((service) => service.dispose()));
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("TerminalSessionService", () => {
  it("两个会话不同 cwd:各自 pwd 正确、list 按 owner 隔离", async () => {
    const service = make();
    const a = await service.open("owner-a", { cwd: join(root, "packages"), name: "pkgs" });
    const b = await service.open("owner-b", { cwd: join(root, "apps"), name: "apps" });
    const aPwd = await service.send("owner-a", a.id, { command: "pwd" });
    const bPwd = await service.send("owner-b", b.id, { command: "pwd" });
    expect(aPwd.output.trim()).toBe(join(root, "packages"));
    expect(bPwd.output.trim()).toBe(join(root, "apps"));
    expect(service.list("owner-a").map((s) => s.id)).toEqual([a.id]);
    expect(service.list("owner-b").map((s) => s.id)).toEqual([b.id]);
    await service.close("owner-a", a.id);
    await service.close("owner-b", b.id);
  }, 20_000);

  it("增量语义:send 只回本条命令输出;read 按 cursor 只回新增(不重复回传)", async () => {
    const service = make();
    const s = await service.open("o", { cwd: root });
    const first = await service.send("o", s.id, { command: "echo 1" });
    expect(first.output.trim()).toBe("1");
    // send 已消费到 cursor;缺省 read 无新输出(不重复回传)
    const idle = await service.read("o", s.id);
    expect(idle.output).toBe("");
    expect(idle.cursor).toBe(first.cursor);
    const second = await service.send("o", s.id, { command: "echo 2" });
    expect(second.output.trim()).toBe("2");
    expect(second.output).not.toContain("1");
    // 显式从第一条的 cursor 读:只含后续新增(echo 2),不含 echo 1
    const delta = await service.read("o", s.id, { cursor: first.cursor });
    expect(delta.output.trim()).toBe("2");
    expect(delta.output).not.toContain("1");
    await service.close("o", s.id);
  }, 20_000);

  it("长驻后台进程:后续命令可用;close 后进程组无残留", async () => {
    const service = make();
    const s = await service.open("o", { cwd: root });
    const bg = await service.send("o", s.id, { command: "sleep 300 & echo BGPID:$!" });
    const pid = Number(/BGPID:(\d+)/.exec(bg.output)?.[1]);
    expect(pid).toBeGreaterThan(0);
    const after = await service.send("o", s.id, { command: "echo still-alive; pwd" });
    expect(after.output).toContain("still-alive");
    expect(after.output).toContain(root);
    expect(alive(pid), "关闭前后台进程应存活").toBe(true);
    await service.close("o", s.id);
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(pid), "close 后进程组应被清理").toBe(false);
  }, 20_000);

  it("空闲回收:超过 idleTimeout 自动 close 并从 registry 移除", async () => {
    const service = make({ idleTimeoutMs: 80, reaperIntervalMs: 20 });
    const s = await service.open("o", { cwd: root });
    expect(service.list("o")).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 400));
    expect(service.list("o")).toHaveLength(0);
    const pid = s.pid;
    if (pid) expect(alive(pid), "回收后 shell 进程应退出").toBe(false);
  }, 20_000);

  it("owner 越权:他人 send/read/close 全部 FOREIGN_SESSION", async () => {
    const service = make();
    const s = await service.open("owner-a", { cwd: root });
    await expect(service.send("owner-b", s.id, { command: "echo hacked" })).rejects.toMatchObject({
      code: "FOREIGN_SESSION",
    });
    await expect(service.read("owner-b", s.id)).rejects.toMatchObject({ code: "FOREIGN_SESSION" });
    await expect(service.close("owner-b", s.id)).rejects.toMatchObject({ code: "FOREIGN_SESSION" });
    expect(service.list("owner-b")).toEqual([]);
    // 原 owner 不受影响
    const ok = await service.send("owner-a", s.id, { command: "echo owner-ok" });
    expect(ok.output).toContain("owner-ok");
    await service.close("owner-a", s.id);
  }, 20_000);

  it("命名唯一与每 owner 上限", async () => {
    const service = make({ maxSessionsPerOwner: 1 });
    const s = await service.open("o", { cwd: root, name: "dev" });
    await expect(service.open("o", { cwd: root, name: "dev" })).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
    });
    // 上限判定先于重名,放宽上限单独验证重名。
    const service2 = make({ maxSessionsPerOwner: 3 });
    const x = await service2.open("o", { cwd: root, name: "dev" });
    await expect(service2.open("o", { cwd: root, name: "dev" })).rejects.toMatchObject({
      code: "DUPLICATE_NAME",
    });
    await service.close("o", s.id);
    await service2.close("o", x.id);
  }, 20_000);

  it("命令超时:返回 timeout + 部分输出;会话仍可用(命令在后台跑完后可继续)", async () => {
    const service = make();
    const s = await service.open("o", { cwd: root });
    const timed = await service.send("o", s.id, { command: "echo before-timeout; sleep 1; echo after-timeout", timeoutMs: 200 });
    expect(timed.waitReason).toBe("timeout");
    expect(timed.output).toContain("before-timeout");
    const next = await service.send("o", s.id, { command: "echo next-ok", timeoutMs: 5000 });
    expect(next.waitReason).toBe("completed");
    expect(next.output).toContain("next-ok");
    await service.close("o", s.id);
  }, 20_000);

  it("pipe 模式(无 tty 回退)命令与增量读可用", async () => {
    const service = make({ shellMode: "pipe" });
    const s = await service.open("o", { cwd: root });
    expect(s.shell).toBe("pipe");
    const out = await service.send("o", s.id, { command: "pwd; echo pipe-ok" });
    expect(out.waitReason).toBe("completed");
    expect(out.output).toContain("pipe-ok");
    expect(out.output).toContain(root);
    await service.close("o", s.id);
  }, 20_000);

  it("NO_SESSION 自愈:旧 id(已 close)+ 同 owner 有存活会话 → 自动切换并前置说明", async () => {
    const service = make();
    const old = await service.open("owner-a", { cwd: root, name: "old" });
    await service.close("owner-a", old.id);
    const fresh = await service.open("owner-a", { cwd: root, name: "fresh" });
    const healed = await service.send("owner-a", old.id, { command: "echo healed-ok" });
    expect(healed.sessionId).toBe(fresh.id);
    expect(healed.output).toContain("已自动切换");
    expect(healed.output).toContain(fresh.id);
    expect(healed.output).toContain("healed-ok");
    // read 同样自愈
    const healedRead = await service.read("owner-a", old.id, { waitMs: 100 });
    expect(healedRead.sessionId).toBe(fresh.id);
    expect(healedRead.output).toContain("已自动切换");
    await service.close("owner-a", fresh.id);
  }, 20_000);

  it("NO_SESSION 不自愈:旧 id(已 close)且该 owner 无存活会话 → 提示先 term.open 新建", async () => {
    const service = make();
    const old = await service.open("owner-a", { cwd: root });
    await service.close("owner-a", old.id);
    await expect(service.send("owner-a", old.id, { command: "echo nope" })).rejects.toMatchObject({
      code: "NO_SESSION",
      message: expect.stringContaining("请先 term.open"),
    });
    // 从未属于该 owner 的 id:保留原文案
    await expect(service.send("owner-a", "term_never_exists", { command: "echo nope" })).rejects.toMatchObject({
      code: "NO_SESSION",
      message: expect.not.stringContaining("请先 term.open"),
    });
  }, 20_000);

  it("不自愈负断言:其它 owner 的存活 sessionId → FOREIGN_SESSION", async () => {
    const service = make();
    const mine = await service.open("owner-b", { cwd: root });
    const s = await service.open("owner-a", { cwd: root });
    await expect(service.send("owner-b", s.id, { command: "echo hacked" })).rejects.toMatchObject({
      code: "FOREIGN_SESSION",
    });
    await expect(service.read("owner-b", s.id)).rejects.toMatchObject({ code: "FOREIGN_SESSION" });
    // 他人已关闭的 id 也不因自愈被借用
    await service.close("owner-a", s.id);
    await expect(service.send("owner-b", s.id, { command: "echo hacked" })).rejects.toMatchObject({
      code: "NO_SESSION",
    });
    const ok = await service.send("owner-b", mine.id, { command: "echo own-ok" });
    expect(ok.output).toContain("own-ok");
    await service.close("owner-b", mine.id);
  }, 20_000);

  it("审计:open/send/denied/close 落 sink,命令原文在案", async () => {
    const events: TerminalAuditEvent[] = [];
    const service = make({ audit: (e) => events.push(e) });
    const s = await service.open("owner-a", { cwd: root, name: "audited" });
    await service.send("owner-a", s.id, { command: "echo audit-me" });
    await expect(service.send("owner-b", s.id, { command: "echo nope" })).rejects.toBeTruthy();
    await service.close("owner-a", s.id);
    expect(events.map((e) => e.action)).toEqual(["open", "send", "denied", "close"]);
    const send = events.find((e) => e.action === "send")!;
    expect(send.command).toBe("echo audit-me");
    expect(send.sessionId).toBe(s.id);
    expect(send.owner).toBe("owner-a");
    expect(send.durationMs).toBeGreaterThanOrEqual(0);
  }, 20_000);
});
