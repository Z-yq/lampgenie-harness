/**
 * WSL 远程工作区(2026-10-27):与 SSH 同构的「发行版内装 server」形态单测。
 * 锚点:UNC→identity 转换、identity 构造/解析、wsl.exe 命令形态、通道 spawn 参数、
 * 远端执行器按 kind 分流、remoteLs 经通道/回退链在 WSL 项目上工作(注入执行器,不真跑 wsl)。
 */
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import {
  buildRemoteWslIdentity, parseRemoteWslProject, parseRemoteProject, remoteWslFromUncPath, remoteProjectLabel,
  type RemoteWslProject,
} from "../src/remote-project.js";
import { wslCommandFor, setWslRunnerForTest, remoteFencePath, remoteLs, type SshRunResult } from "../src/ssh-ops.js";
import { channelSpawnArgs } from "../src/remote-channel.js";

const wsl: RemoteWslProject = {
  kind: "wsl",
  distro: "Ubuntu",
  workspacePath: "/home/u/proj",
  identity: "remote:wsl:Ubuntu:/home/u/proj",
};

afterEach(() => setWslRunnerForTest(undefined));

function stubWsl(impl: (command: string) => Partial<SshRunResult>): void {
  setWslRunnerForTest(async (_r, command) => {
    const r = impl(command);
    return { ok: r.ok ?? true, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ...(r.error ? { error: r.error } : {}) } as SshRunResult;
  });
}

describe("remote:wsl identity", () => {
  it("构造/解析对偶:path 归一、发行版原名保留", () => {
    const id = buildRemoteWslIdentity("Ubuntu-22.04", "/home/u/proj/");
    expect(id).toBe("remote:wsl:Ubuntu-22.04:/home/u/proj");
    expect(parseRemoteWslProject(id)).toMatchObject({ kind: "wsl", distro: "Ubuntu-22.04", workspacePath: "/home/u/proj", identity: id });
  });

  it("非法形态拒绝", () => {
    expect(parseRemoteWslProject("remote:wsl:Ubuntu")).toBeNull();     // 缺路径
    expect(parseRemoteWslProject("remote:wsl::/x")).toBeNull();        // 缺发行版
    expect(parseRemoteWslProject("remote:wsl:Ub:,/:x")).toBeNull();    // 发行版含非法字符
    expect(parseRemoteWslProject("remote:ssh:h:22:u:/x")).toBeNull();
    expect(() => buildRemoteWslIdentity("Ub:/x", "/")).toThrow();     // 构造侧同样拒绝(供调用方捕获)
  });

  it("统一解析分派 SSH/WSL;label 带 WSL:发行版", () => {
    expect(parseRemoteProject("remote:wsl:Ubuntu:/home/u/proj")?.kind).toBe("wsl");
    expect(parseRemoteProject("remote:ssh:h:22:u:/x")?.kind).toBe("ssh");
    expect(parseRemoteProject("E:\\proj")).toBeNull();
    expect(remoteProjectLabel(wsl)).toBe("WSL:Ubuntu:proj");
  });

  it("UNC → identity(添加项目自动转换;wsl.localhost 与旧 wsl$ 都认)", () => {
    expect(remoteWslFromUncPath("\\\\wsl.localhost\\Ubuntu\\home\\u\\proj")?.identity).toBe("remote:wsl:Ubuntu:/home/u/proj");
    expect(remoteWslFromUncPath("\\\\wsl$\\Ubuntu\\home\\u\\proj\\")?.identity).toBe("remote:wsl:Ubuntu:/home/u/proj");
    expect(remoteWslFromUncPath("E:\\proj")).toBeNull();
    expect(remoteWslFromUncPath("/home/u/proj")).toBeNull();
  });
});

describe("wsl.exe 形态与通道 spawn", () => {
  it("远程命令:bash -lc,命令原文透传", () => {
    expect(wslCommandFor("Ubuntu", "ls -la && echo 'a b'")).toEqual({
      cmd: "wsl.exe", args: ["-d", "Ubuntu", "--exec", "bash", "-lc", "ls -la && echo 'a b'"],
    });
  });

  it("通道 spawn:argv 直传 node 脚本与 workspace(不经 shell)", () => {
    expect(channelSpawnArgs(wsl, "/home/u/.genie/agent-stdio.mjs")).toEqual({
      cmd: "wsl.exe",
      args: ["-d", "Ubuntu", "--exec", "node", "/home/u/.genie/agent-stdio.mjs", "/home/u/proj"],
    });
  });

  it("SSH 通道参数保持旧形态(远端 shell 执行 node)", () => {
    const ssh = { kind: "ssh" as const, host: "h", port: 22, username: "u", workspacePath: "/home/u/p", identity: "remote:ssh:h:22:u:/home/u/p" };
    const inv = channelSpawnArgs(ssh, "$HOME/.genie/agent-stdio.mjs");
    expect(inv.cmd).toBe("ssh");
    expect(inv.args[inv.args.length - 1]).toBe("node $HOME/.genie/agent-stdio.mjs '/home/u/p'");
  });
});

describe("WSL 远端执行(注入执行器,不真跑 wsl.exe)", () => {
  it("路径围栏:相对路径解析到 workspace 内;.. 拒绝", () => {
    expect(remoteFencePath(wsl, "src/a.ts")).toBe("/home/u/proj/src/a.ts");
    expect(remoteFencePath(wsl, "../x")).toBeNull();
  });

  it("remoteLs:通道不可用→shim 不可用→shell 回退(wsl.exe 执行 ls)", async () => {
    const seen: string[] = [];
    stubWsl((cmd) => {
      seen.push(cmd);
      if (cmd.includes("agent-stdio")) return { stdout: "no\n" };            // 未部署
      if (cmd.includes("test -f")) return { stdout: "no\n" };                // 无 shim
      if (cmd.includes("ls -1Ap")) return { stdout: "src/\nREADME.md\n" };
      return { stdout: "" };
    });
    const r = await remoteLs(wsl, ".");
    expect("entries" in r).toBe(true);
    if ("entries" in r) {
      expect(r.entries).toEqual([{ name: "src", kind: "dir" }, { name: "README.md", kind: "file" }]);
    }
    expect(seen.some((c) => c.includes("ls -1Ap '/home/u/proj'"))).toBe(true);
  });
});
describe("WS project.add:WSL UNC 自动登记为远端工作区", () => {
  let app: GatewayApp | null = null;
  afterEach(async () => { await app?.close(); app = null; });

  function nextMessage(ws: WebSocket, type: string, ms = 15_000, after = 0): Promise<Record<string, unknown>> {
    const inbox = (ws as unknown as { __inbox: Record<string, unknown>[] }).__inbox;
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const timer = setTimeout(() => { clearInterval(poll); reject(new Error("等待 " + type + " 超时")); }, ms);
      const poll = setInterval(() => {
        const hits = inbox.filter((m) => m.type === type);
        if (hits.length > after) { clearInterval(poll); clearTimeout(timer); resolve(hits[after]!); }
        else if (Date.now() - t0 > ms) { clearInterval(poll); clearTimeout(timer); reject(new Error("等待 " + type + " 超时")); }
      }, 20);
    });
  }

  it("UNC 路径入册后 path=remote:wsl:<distro>:<posix>(服务端自动转换)", async () => {
    app = createGatewayApp({ port: 7796 });
    const ws = new WebSocket("ws://127.0.0.1:7796");
    const inbox: Record<string, unknown>[] = [];
    (ws as unknown as { __inbox: Record<string, unknown>[] }).__inbox = inbox;
    ws.on("message", (raw: Buffer) => inbox.push(JSON.parse(raw.toString())));
    await new Promise<void>((res, rej) => { ws.on("open", () => res()); ws.on("error", rej); });
    await nextMessage(ws, "project.list.result");
    ws.send(JSON.stringify({ v: 1, type: "project.add", path: "\\\\wsl.localhost\\Ubuntu\\home\\u\\proj" }));
    const list = (await nextMessage(ws, "project.list.result", 15_000, 1)) as { projects: { path: string; availability: string; id: string }[] };
    const mine = list.projects.find((p) => p.path === "remote:wsl:Ubuntu:/home/u/proj");
    expect(mine, JSON.stringify(list.projects)).toBeDefined();
    expect(["unavailable-remote-unverified", "unavailable-remote-unreachable"]).toContain(mine!.availability);
    ws.send(JSON.stringify({ v: 1, type: "project.remove", projectId: mine!.id }));
    ws.close();
  }, 30_000);
});

describe("存量迁移:0.0.5 的 UNC 项目 → remote:wsl", () => {
  it("load 读盘即转换并回写(path/label/availability)", async () => {
    const { mkdtempSync, rmSync, writeFileSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { ProjectRegistry } = await import("../src/projects.js");
    const dir = mkdtempSync(join(tmpdir(), "genie-wsl-migrate-"));
    try {
      const file = join(dir, "projects.json");
      writeFileSync(file, JSON.stringify({
        projects: [{ id: "p1", path: "\\\\wsl.localhost\\Ubuntu\\home\\u\\proj", label: "proj", availability: "available", addedAt: 1 }],
        activeProjectId: "p1",
      }));
      const reg = new ProjectRegistry("/harness", file);
      const e = reg.list().find((p) => p.id === "p1")!;
      expect(e.path).toBe("remote:wsl:Ubuntu:/home/u/proj");
      expect(e.label).toBe("WSL:Ubuntu:proj");
      expect(e.availability).toBe("unavailable-remote-unverified");
      // 回写验证:磁盘上已是新 identity
      const persisted = JSON.parse(readFileSync(file, "utf-8")) as { projects: { path: string }[] };
      expect(persisted.projects.find((x) => x.path === "remote:wsl:Ubuntu:/home/u/proj")).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
