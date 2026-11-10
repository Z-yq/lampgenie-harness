/**
 * shell 抽象( K4 / P1-6)单测:命令原文 → (可执行文件, 参数) 的纯函数决策面。
 * 锚点:win32 默认降级 cmd.exe /d /s /c;POSIX 默认 bash -lc;GENIE_SHELL_BIN 覆盖语义
 * (bash 类走 -lc、cmd 类走 /d /s /c);带空格/引号的命令原样透传;shell 缺位有可读提示。
 */
import { describe, it, expect, afterEach } from "vitest";
import { shellInvocation, shellErrorHint, SHELL_MISSING_HINT } from "../src/shell-invocation.js";

const savedShellBin = process.env.GENIE_SHELL_BIN;
afterEach(() => {
  if (savedShellBin === undefined) delete process.env.GENIE_SHELL_BIN;
  else process.env.GENIE_SHELL_BIN = savedShellBin;
});

describe("shellInvocation 平台默认", () => {
  it("win32 默认 → cmd.exe /d /s /c,并给出降级 hint", () => {
    delete process.env.GENIE_SHELL_BIN;
    const inv = shellInvocation("dir", { platform: "win32" });
    expect(inv.cmd).toBe("cmd.exe");
    expect(inv.args).toEqual(["/d", "/s", "/c", "dir"]);
    expect(inv.hint).toBeTruthy();
    expect(inv.hint).toContain("GENIE_SHELL_BIN");
  });

  it("linux 默认 → bash -lc(与旧行为一致,无 hint)", () => {
    delete process.env.GENIE_SHELL_BIN;
    const inv = shellInvocation("ls -la", { platform: "linux" });
    expect(inv.cmd).toBe("bash");
    expect(inv.args).toEqual(["-lc", "ls -la"]);
    expect(inv.hint).toBeUndefined();
  });

  it("darwin 同 linux → bash -lc", () => {
    delete process.env.GENIE_SHELL_BIN;
    expect(shellInvocation("pwd", { platform: "darwin" })).toMatchObject({ cmd: "bash", args: ["-lc", "pwd"] });
  });
});

describe("GENIE_SHELL_BIN 覆盖", () => {
  it("= /usr/bin/bash → 该路径 + -lc", () => {
    process.env.GENIE_SHELL_BIN = "/usr/bin/bash";
    const inv = shellInvocation("echo hi", { platform: "win32" }); // 覆盖优先于平台默认
    expect(inv.cmd).toBe("/usr/bin/bash");
    expect(inv.args).toEqual(["-lc", "echo hi"]);
  });

  it("Windows Git-Bash 路径(反斜杠)→ 认 bash,走 -lc", () => {
    process.env.GENIE_SHELL_BIN = "C:\\Program Files\\Git\\bin\\bash.exe";
    const inv = shellInvocation("echo hi", { platform: "win32" });
    expect(inv.cmd).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(inv.args).toEqual(["-lc", "echo hi"]);
  });

  it("指向 cmd 风格 shell → /d /s /c", () => {
    process.env.GENIE_SHELL_BIN = "C:\\Windows\\System32\\cmd.exe";
    const inv = shellInvocation("dir", { platform: "linux" }); // 覆盖优先于平台默认
    expect(inv.cmd).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(inv.args).toEqual(["/d", "/s", "/c", "dir"]);
  });

  it("opts.shellBin 优先于 env,且空白值视同未设(回落平台默认)", () => {
    process.env.GENIE_SHELL_BIN = "/usr/bin/bash";
    expect(shellInvocation("x", { platform: "win32", shellBin: "C:\\bin\\cmd.exe" })).toMatchObject({
      cmd: "C:\\bin\\cmd.exe", args: ["/d", "/s", "/c", "x"],
    });
    process.env.GENIE_SHELL_BIN = "   ";
    expect(shellInvocation("x", { platform: "win32" })).toMatchObject({ cmd: "cmd.exe", args: ["/d", "/s", "/c", "x"] });
  });
});

describe("命令原文透传", () => {
  it("含空格/引号/重定向/&& 的命令原样作为最后一个参数,不被改写", () => {
    delete process.env.GENIE_SHELL_BIN;
    const cmd = `echo "a b" > 'out file.txt' && grep -n "x y" f.ts`;
    const posix = shellInvocation(cmd, { platform: "linux" });
    expect(posix.args).toEqual(["-lc", cmd]);
    const win = shellInvocation(cmd, { platform: "win32" });
    expect(win.args).toEqual(["/d", "/s", "/c", cmd]);
  });

  it("空命令也让 shell 自己判(不抛错)", () => {
    delete process.env.GENIE_SHELL_BIN;
    expect(shellInvocation("", { platform: "linux" })).toMatchObject({ cmd: "bash", args: ["-lc", ""] });
  });
});

describe("WSL 项目 cwd(2026-10-27:命令回发行版内执行)", () => {
  it("win32 + WSL UNC cwd → wsl.exe --cd <posix> bash -lc(优先于 GENIE_SHELL_BIN)", () => {
    process.env.GENIE_SHELL_BIN = "C:\\Program Files\\Git\\bin\\bash.exe";
    const inv = shellInvocation("pwd && ls", { platform: "win32", cwd: "\\\\wsl.localhost\\Ubuntu\\home\\u\\proj" });
    expect(inv).toMatchObject({
      cmd: "wsl.exe",
      mode: "wsl",
      args: ["-d", "Ubuntu", "--cd", "/home/u/proj", "--exec", "bash", "-lc", "pwd && ls"],
    });
    expect(inv.hint).toContain("Ubuntu");
  });

  it("win32 + 普通盘符 cwd → 仍走原 shell(不误切 WSL)", () => {
    delete process.env.GENIE_SHELL_BIN;
    const inv = shellInvocation("dir", { platform: "win32", cwd: "E:\\workship\\genie" });
    expect(inv).toMatchObject({ cmd: "cmd.exe", args: ["/d", "/s", "/c", "dir"] });
    expect(inv.mode).toBeUndefined();
  });

  it("linux 平台即便 cwd 是 UNC 形态也不切(网关本体在 Linux 时语义未变)", () => {
    delete process.env.GENIE_SHELL_BIN;
    const inv = shellInvocation("ls", { platform: "linux", cwd: "\\\\wsl.localhost\\Ubuntu\\home\\u" });
    expect(inv).toMatchObject({ cmd: "bash", args: ["-lc", "ls"] });
  });

  it("wsl.exe 缺失时提示指向 WSL(不是「装 Git for Windows」)", () => {
    const inv = shellInvocation("ls", { platform: "win32", cwd: "\\\\wsl.localhost\\Ubuntu\\home\\u" });
    const hint = shellErrorHint(Object.assign(new Error("spawn wsl.exe ENOENT"), { code: "ENOENT" }), inv);
    expect(hint).toContain("wsl.exe");
    expect(hint).not.toContain("Git for Windows");
  });
});

describe("shellErrorHint(ENOENT 人话提示)", () => {
  it("ENOENT → 带 Git for Windows / GENIE_SHELL_BIN 提示,并标明缺的是哪个 shell", () => {
    const err = Object.assign(new Error("spawn bash ENOENT"), { code: "ENOENT" });
    const hint = shellErrorHint(err, shellInvocation("x", { platform: "linux" }));
    expect(hint).toContain(SHELL_MISSING_HINT);
    expect(hint).toContain("bash");
  });

  it("非 ENOENT 错误 → undefined(调用点按原错误处理)", () => {
    expect(shellErrorHint(Object.assign(new Error("boom"), { code: 1 }))).toBeUndefined();
    expect(shellErrorHint(null)).toBeUndefined();
  });
});