/**
 * 连接向导服务端面(2026-10-27,用户口径「先连接 WSL/SSH,连接过程中装 server,确认无误后由 server
 * 返回文件路径,再选项目目录」):wsl.list / wsl.test / wsl.browse / ssh.browse 的形态与平台门控。
 * Windows 实机全链(部署+ping+浏览)由 tasks/step-1007-wsl-connection/evidence 覆盖。
 */
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import { setSshRunnerForTest, type SshRunResult } from "../src/ssh-ops.js";

let app: GatewayApp | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
  setSshRunnerForTest(undefined);
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

function nextMessage(ws: WebSocket, type: string, ms = 10_000, after = 0): Promise<Record<string, unknown>> {
  const inbox = (ws as unknown as { __inbox: Record<string, unknown>[] }).__inbox;
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setTimeout(() => { clearInterval(poll); reject(new Error("等待 " + type + " 超时")); }, ms);
    const poll = setInterval(() => {
      const hits = inbox.filter((m) => m.type === type);
      if (hits.length > after) { clearInterval(poll); clearTimeout(timer); resolve(hits[after]!); }
      else if (Date.now() - t0 > ms) { clearInterval(poll); clearTimeout(timer); reject(new Error("等待 " + type + " 超时")); }
    }, 20);
    timer.unref?.();
  });
}

describe("连接向导服务端面", () => {
  it("wsl.list:非 Windows 平台返回空发行版列表(带 platform)", async () => {
    app = createGatewayApp({ port: 7795 });
    const ws = await connect(7795);
    await nextMessage(ws, "project.list.result");
    ws.send(JSON.stringify({ v: 1, type: "wsl.list" }));
    const m = await nextMessage(ws, "wsl.list.result");
    expect(m.platform).toBe(process.platform);
    expect(m.distros).toEqual([]);
    ws.close();
  }, 20_000);

  it("wsl.test / wsl.browse:非 Windows 明确拒绝(不借 interop)", async () => {
    app = createGatewayApp({ port: 7795 });
    const ws = await connect(7795);
    await nextMessage(ws, "project.list.result");
    ws.send(JSON.stringify({ v: 1, type: "wsl.test", distro: "Ubuntu" }));
    const t = await nextMessage(ws, "wsl.test.result");
    expect(t.ok).toBe(false);
    expect(String(t.error)).toContain("Windows");
    ws.send(JSON.stringify({ v: 1, type: "wsl.browse", distro: "Ubuntu", path: "/home" }));
    const b = await nextMessage(ws, "wsl.browse.result");
    expect(String(b.error)).toContain("Windows");
    ws.close();
  }, 20_000);

  it("ssh.browse:目录由工作区服务(远端执行器)返回,parent 为 POSIX 父目录", async () => {
    setSshRunnerForTest(async (_r, command) => {
      // 通道探测/部署探测 → 未部署;shim → 无;ls 走 shell 回退
      if (command.includes("agent-stdio")) return { ok: true, stdout: "no\n", stderr: "" } as SshRunResult;
      if (command.includes("test -f")) return { ok: true, stdout: "no\n", stderr: "" } as SshRunResult;
      if (command.includes("ls -1Ap")) return { ok: true, stdout: "proj/\nREADME.md\n", stderr: "" } as SshRunResult;
      return { ok: true, stdout: "", stderr: "" } as SshRunResult;
    });
    app = createGatewayApp({ port: 7795 });
    const ws = await connect(7795);
    await nextMessage(ws, "project.list.result");
    ws.send(JSON.stringify({ v: 1, type: "ssh.browse", host: "10.0.0.9", port: 22, username: "u", path: "/home/u" }));
    const m = await nextMessage(ws, "ssh.browse.result");
    expect(m.path).toBe("/home/u");
    expect(m.parent).toBe("/home");
    expect(m.entries).toEqual([{ name: "proj", kind: "dir" }, { name: "README.md", kind: "file" }]);
    ws.close();
  }, 20_000);
});
