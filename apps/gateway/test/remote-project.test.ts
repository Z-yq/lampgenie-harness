/**
 * 远程项目(remote:ssh identity)单测:构造/解析/去重/注册表语义 + WS project.add 面板路径。
 * (ZCode packages/shared/src/remote-workspace-identity.ts 对齐)。
 */
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRemoteSshIdentity,
  parseRemoteSshProject,
  remoteProjectLabel,
  probeRemoteSsh,
} from "../src/remote-project.js";
import { ProjectRegistry, HARNESS_PROJECT_ID } from "../src/projects.js";
import { createGatewayApp, type GatewayApp } from "../src/app.js";

let app: GatewayApp | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

function connect(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox: Record<string, unknown>[] = [];
  (ws as unknown as { __inbox: Record<string, unknown>[] }).__inbox = inbox;
  ws.on("message", (raw: Buffer) => inbox.push(JSON.parse(raw.toString())));
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function nextMessage(ws: WebSocket, type: string, ms = 5000, after = 0): Promise<Record<string, unknown>> {
  const inbox = (ws as unknown as { __inbox: Record<string, unknown>[] }).__inbox;
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = setInterval(() => {
      const matches = inbox.filter((m) => m.type === type);
      if (matches.length > after) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve(matches[after]!);
      } else if (Date.now() - t0 > ms) {
        clearInterval(poll);
        clearTimeout(timer);
        reject(new Error(`等待第 ${after + 1} 条 ${type} 超时(现${matches.length})`));
      }
    }, 20);
    const timer = setTimeout(() => reject(new Error(`等待 ${type} 超时`)), ms);
    timer.unref?.();
  });
}

describe("remote:ssh identity 构造/解析", () => {
  it("构造+解析对偶:path 归一、host 小写、port 数字", () => {
    const id = buildRemoteSshIdentity("10.10.18.72", 22, "zhongyuqi", "/home/zhongyuqi/");
    expect(id).toBe("remote:ssh:10.10.18.72:22:zhongyuqi:/home/zhongyuqi");
    const p = parseRemoteSshProject(id);
    expect(p).not.toBeNull();
    expect(p!.host).toBe("10.10.18.72");
    expect(p!.port).toBe(22);
    expect(p!.username).toBe("zhongyuqi");
    expect(p!.workspacePath).toBe("/home/zhongyuqi");
    expect(p!.identity).toBe(id);
  });

  it("大写 host 归一为小写;收尾斜杠与多斜杠折叠", () => {
    const id = buildRemoteSshIdentity("Host.Example.COM", 2222, "u1", "//a//b//");
    expect(id).toBe("remote:ssh:host.example.com:2222:u1:/a/b");
  });

  it("非法形态返回 null(fail-closed)", () => {
    expect(parseRemoteSshProject("/local/path")).toBeNull();
    expect(parseRemoteSshProject("remote:ssh:host")).toBeNull();
    expect(parseRemoteSshProject("remote:ssh:host:abc:user:/x")).toBeNull();
    expect(parseRemoteSshProject("remote:ssh:host:0:user:/x")).toBeNull();
    expect(parseRemoteSshProject("remote:ssh:host:70000:user:/x")).toBeNull();
    expect(parseRemoteSshProject("remote:ssh:host:22:user:relative")).toBeNull();
    expect(parseRemoteSshProject("remote:docker:container/path")).toBeNull();
  });

  it("path 段含冒号仍可解析(authority 逐段消费)", () => {
    const p = parseRemoteSshProject("remote:ssh:h1:22:u1:/a:b/c");
    expect(p).not.toBeNull();
    expect(p!.workspacePath).toBe("/a:b/c");
  });

  it("label = host:尾段路径", () => {
    expect(remoteProjectLabel(parseRemoteSshProject("remote:ssh:10.10.18.72:22:zhongyuqi:/home/zhongyuqi")!)).toBe("10.10.18.72:zhongyuqi");
  });
});

describe("ProjectRegistry 远程 add 语义", () => {
  it("add 远程 identity:入册 + unverified;重复添加=幂等返回同一条目", () => {
    const dir = mkdtempSync(join(tmpdir(), "genie-remote-"));
    try {
      const file = join(dir, "projects.json");
      const reg = new ProjectRegistry("/harness", file);
      const id = "remote:ssh:10.10.18.72:22:zhongyuqi:/home/zhongyuqi";
      const r1 = reg.add(id);
      expect(r1.ok).toBe(true);
      if (r1.ok) {
        expect(r1.project.path).toBe(id);
        expect(r1.project.label).toBe("10.10.18.72:zhongyuqi");
        expect(r1.project.availability).toBe("unavailable-remote-unverified");
      }
      const r2 = reg.add("remote:ssh:10.10.18.72:22:zhongyuqi:/home/zhongyuqi/");
      expect(r2.ok).toBe(true);
      if (r1.ok && r2.ok) expect(r2.project.id).toBe(r1.project.id);
      // 本地路径语义不回归:相对路径仍拒。
      expect(reg.add("relative/path")).toEqual({ ok: false, reason: "必须是绝对路径" });
      // resolveWorkdir:远程项目回退 harness 根(available 也一样——远程 identity 不是本地目录)。
      if (r1.ok) {
        const e = reg.list().find((p) => p.id === r1.project.id)!;
        e.availability = "available";
        expect(reg.resolveWorkdir(e.id)).toBe("/harness");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("load 重启路径:远程条目不本地 statSync,保持 unverified", () => {
    const dir = mkdtempSync(join(tmpdir(), "genie-remote-"));
    try {
      const file = join(dir, "projects.json");
      const reg1 = new ProjectRegistry("/harness", file);
      reg1.add("remote:ssh:9.9.9.9:22:u:/x");
      const reg2 = new ProjectRegistry("/harness", file);
      const e = reg2.list().find((p) => p.path === "remote:ssh:9.9.9.9:22:u:/x");
      expect(e?.availability).toBe("unavailable-remote-unverified");
      expect(reg2.list().length).toBe(2); // harness + 远程
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persist 结构:harness 本体仍在,默认激活不漂移", () => {
    const dir = mkdtempSync(join(tmpdir(), "genie-remote-"));
    try {
      const file = join(dir, "projects.json");
      const reg = new ProjectRegistry("/harness", file);
      reg.add("remote:ssh:1.2.3.4:22:u:/p");
      const raw = JSON.parse(readFileSync(file, "utf-8")) as { projects: { id: string }[]; activeProjectId: string };
      expect(raw.projects.some((p) => p.id === HARNESS_PROJECT_ID)).toBe(true);
      expect(raw.activeProjectId).toBe(HARNESS_PROJECT_ID);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("WS project.add 远程路径", () => {
  it("remote: 前缀跳过本地可达性校验,入册并广播 project.list.result", async () => {
    app = createGatewayApp({ port: 7797 });
    const ws = await connect(7797);
    await nextMessage(ws, "project.list.result"); // 连接即推的初始清单(第 1 条)
    const id = "remote:ssh:10.10.18.72:22:zhongyuqi-test:/home/zhongyuqi";
    ws.send(JSON.stringify({ v: 1, type: "project.add", path: id }));
    // 探测 1.2s 后会再广播一次(unreachable 回写);等待第 3 条=探测回写后的稳定态。
    const afterProbe = (await nextMessage(ws, "project.list.result", 15_000, 2)) as { projects: { path: string; availability: string; id: string }[] };
    const mine = afterProbe.projects.find((p) => p.path === id);
    expect(mine).toBeDefined();
    expect(["unavailable-remote-unverified", "unavailable-remote-unreachable"]).toContain(mine!.availability);
    // 本地路径语义不回归:相对路径仍被前置校验拒。
    ws.send(JSON.stringify({ v: 1, type: "project.add", path: "relative/x" }));
    const err = await nextMessage(ws, "error");
    expect(String((err as { message?: string }).message ?? "")).toContain("必须是绝对路径");
    // 清理(测试实例 journalDir 缺省=不落盘,不会污染仓内数据;移除后广播的清单里应无 id)。
    ws.send(JSON.stringify({ v: 1, type: "project.remove", projectId: mine!.id }));
    const afterRm = (await nextMessage(ws, "project.list.result", 15_000, 3)) as { projects: { path: string }[] };
    expect(afterRm.projects.some((p) => p.path === id)).toBe(false);
    ws.close();
  }, 30_000);
});

describe("probeRemoteSsh", () => {
  it("ssh 失败→false 不抛错;成功→true(exec 注入短路,不真连网)", async () => {
    const p = parseRemoteSshProject("remote:ssh:10.10.18.72:22:zhongyuqi:/home/zhongyuqi")!;
    // 探活(-V)恒成功;真探测阶段抛错=远端不可达 → false。
    const fail = await probeRemoteSsh(p, { password: "x", exec: async (cmd, args) => {
      if (args[0] === "-V") return { stdout: "sshpass 1.06", stderr: "" };
      throw new Error("ssh 不可达");
    } });
    expect(fail).toBe(false);
    // 全成功 → true;且断言命令面:sshpass -e ssh ... test -d(密码走 env 不进 argv)。
    let seen: { cmd: string; args: string[]; env?: Record<string, string> } | null = null;
    const ok = await probeRemoteSsh(p, { password: "secret", exec: async (cmd, args, o) => {
      if (args[0] === "-V") return { stdout: "sshpass 1.06", stderr: "" };
      seen = { cmd, args, env: o.env };
      return { stdout: "", stderr: "" };
    } });
    expect(ok).toBe(true);
    expect(seen!.cmd).toBe("sshpass");
    expect(seen!.args.join(" ")).toContain("test -d");
    expect(JSON.stringify(seen!.args)).not.toContain("secret");
    expect(seen!.env?.SSHPASS).toBe("secret");
  });
});
