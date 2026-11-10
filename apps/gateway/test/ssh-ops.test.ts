/**
 * SSH 远程操作层单测(2026-10-26,ZCode remote workspace 切片):
 * 路径围栏/ls 解析与截断/read 二进制判定与截断/exec 输出限流/错误归一(setSshRunnerForTest 注入)。
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  remoteFencePath, remoteLs, remoteRead, remoteExec,
  setSshRunnerForTest, REMOTE_LS_MAX_ENTRIES, REMOTE_READ_MAX_BYTES,
  type SshRunResult,
} from "../src/ssh-ops.js";
import type { RemoteSshProject } from "../src/remote-project.js";

const remote: RemoteSshProject = {
  kind: "ssh", host: "srv", port: 22, username: "u",
  workspacePath: "/home/u/proj", identity: "remote:ssh:srv:22:u:/home/u/proj",
};

function stub(impl: (command: string) => Partial<SshRunResult>): void {
  setSshRunnerForTest(async (_r, command) => {
    const r = impl(command);
    return { ok: r.ok ?? true, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ...(r.error ? { error: r.error } : {}) } as SshRunResult;
  });
}
afterEach(() => setSshRunnerForTest(undefined));

describe("remoteFencePath(远程路径围栏)", () => {
  it("相对路径解析到工作区内;根=workspacePath", () => {
    expect(remoteFencePath(remote, "src/a.ts")).toBe("/home/u/proj/src/a.ts");
    expect(remoteFencePath(remote, "./b/")).toBe("/home/u/proj/b");
    expect(remoteFencePath(remote, ".")).toBe("/home/u/proj");
  });
  it("绝对路径/.. 上跳拒绝", () => {
    expect(remoteFencePath(remote, "/etc/passwd")).toBeNull();
    expect(remoteFencePath(remote, "../outside")).toBeNull();
    expect(remoteFencePath(remote, "a/../../escape")).toBeNull();
    expect(remoteFencePath(remote, "")).toBeNull();
  });
});

describe("remoteLs", () => {
  it("ls -1Ap 输出解析:[d]/[f] 条目", async () => {
    stub((cmd) => {
      if (!cmd.includes("ls -1Ap")) return { ok: false, stderr: "unexpected" };
      return { stdout: "src/\nREADME.md\npackage.json\n" };
    });
    const r = await remoteLs(remote, ".");
    expect("entries" in r).toBe(true);
    if ("entries" in r) {
      expect(r.entries).toEqual([
        { name: "src", kind: "dir" },
        { name: "README.md", kind: "file" },
        { name: "package.json", kind: "file" },
      ]);
      expect(r.truncated).toBe(false);
    }
  });
  it("命令构造:围栏路径进单引号;head 限流在位", async () => {
    let seen = "";
    stub((cmd) => { seen = cmd; return { stdout: "" }; });
    await remoteLs(remote, "a b/c"); // 含空格路径
    expect(seen).toContain("ls -1Ap '/home/u/proj/a b/c'");
    expect(seen).toContain(`head -n ${REMOTE_LS_MAX_ENTRIES + 1}`);
  });
  it("执行失败:归一错误透传", async () => {
    stub(() => ({ ok: false, stderr: "Permission denied, please try again." }));
    const r = await remoteLs(remote, ".");
    expect("error" in r && r.error).toContain("认证失败");
  });
});

describe("remoteRead", () => {
  it("base64 读回解码;二进制(NUL)拒读", async () => {
    stub((cmd) => {
      if (cmd.includes("bin.dat")) return { stdout: Buffer.from([0x41, 0x00, 0x42]).toString("base64") };
      return { stdout: Buffer.from("你好 remote", "utf-8").toString("base64") };
    });
    const okr = await remoteRead(remote, "note.md");
    expect("content" in okr && okr.content).toBe("你好 remote");
    const bin = await remoteRead(remote, "bin.dat");
    expect("binary" in bin && bin.binary).toBe(true);
  });
  it("超限截断如实标注", async () => {
    stub(() => ({ stdout: Buffer.alloc(REMOTE_READ_MAX_BYTES + 10, 0x61).toString("base64") }));
    const r = await remoteRead(remote, "big.txt");
    expect("truncated" in r && r.truncated).toBe(true);
    expect("content" in r && r.content?.length).toBe(REMOTE_READ_MAX_BYTES);
  });
});

describe("remoteExec", () => {
  it("cwd=workspacePath;输出超限截断", async () => {
    let seen = "";
    stub((cmd) => { seen = cmd; return { stdout: "x".repeat(REMOTE_READ_MAX_BYTES + 5) }; });
    const r = await remoteExec(remote, "ls");
    expect(seen).toContain("cd '/home/u/proj'");
    expect("truncated" in r && r.truncated).toBe(true);
    expect("stdout" in r && r.stdout.length).toBe(REMOTE_READ_MAX_BYTES);
  });
  it("无输出=空串(「(无输出)」文案归 agent 工具层)", async () => {
    stub(() => ({ stdout: "" }));
    const r = await remoteExec(remote, "true");
    expect("stdout" in r && r.stdout).toBe("");
    expect("error" in r).toBe(false);
  });
});

describe("复查补:私钥/写/连接复用(2026-10-26)", () => {
  it("resolveSshPrivateKey:无 secrets 键=undefined(不误报)", async () => {
    const { resolveSshPrivateKey } = await import("../src/ssh-ops.js");
    expect(resolveSshPrivateKey(remote)).toBeUndefined();
  });
  it("remoteWrite:命令构造含 base64 -d 写入+mkdir 父目录+回读校验", async () => {
    let seen = "";
    stub((cmd) => { seen = cmd; return { stdout: "12\n" }; });
    const { remoteWrite } = await import("../src/ssh-ops.js");
    const r = await remoteWrite(remote, "src/new.md", "hello 内容ok!");
    expect("bytes" in r && r.bytes).toBe(12);
    expect(seen).toContain("mkdir -p");
    expect(seen).toContain("base64 -d");
    expect(seen).toContain("wc -c");
  });
  it("remoteWrite:回读校验失败如实报错", async () => {
    stub(() => ({ stdout: "not-a-number" }));
    const { remoteWrite } = await import("../src/ssh-ops.js");
    const r = await remoteWrite(remote, "a.txt", "x");
    expect("error" in r).toBe(true);
  });
  it("remoteWrite:内容超限拒绝(256KB)", async () => {
    stub(() => ({ stdout: "" }));
    const { remoteWrite } = await import("../src/ssh-ops.js");
    const r = await remoteWrite(remote, "big.txt", "x".repeat(256 * 1024 + 1));
    expect("error" in r && r.error).toContain("超限");
  });
});
