/**
 * WSL 桥单测(2026-10-27):UNC 解析 / 命令形态拼装(纯函数面)。
 * 真机(WSL 发行版)行为由 tasks/step-1007-wsl-connection/evidence 下的 Windows 实测覆盖。
 */
import { describe, it, expect } from "vitest";
import {
  parseWslPath, wslUncFor, wslShellInvocation, wslPtyInvocation, wslGitInvocation,
  wslSupported, wslErrorHint, listWslDistros, wslAnchors, __resetWslCache,
} from "../src/wsl.js";

describe("parseWslPath", () => {
  it("wsl.localhost / wsl$ / 正斜杠三种写法都认", () => {
    expect(parseWslPath("\\\\wsl.localhost\\Ubuntu\\home\\u\\proj")).toEqual({ distro: "Ubuntu", posix: "/home/u/proj" });
    expect(parseWslPath("\\\\wsl$\\Ubuntu\\home\\u\\proj")).toEqual({ distro: "Ubuntu", posix: "/home/u/proj" });
    expect(parseWslPath("//wsl.localhost/Ubuntu/home/u/proj")).toEqual({ distro: "Ubuntu", posix: "/home/u/proj" });
  });

  it("发行版根本身 / 尾斜杠 → posix 根", () => {
    expect(parseWslPath("\\\\wsl.localhost\\Ubuntu")).toEqual({ distro: "Ubuntu", posix: "/" });
    expect(parseWslPath("\\\\wsl.localhost\\Ubuntu\\")).toEqual({ distro: "Ubuntu", posix: "/" });
    expect(parseWslPath("\\\\wsl.localhost\\Ubuntu\\home\\")).toEqual({ distro: "Ubuntu", posix: "/home" });
  });

  it("普通 Windows 路径 / UNC / POSIX → null", () => {
    expect(parseWslPath("E:\\workship\\genie")).toBeNull();
    expect(parseWslPath("\\\\server\\share\\x")).toBeNull();
    expect(parseWslPath("/home/u/proj")).toBeNull();
    expect(parseWslPath("")).toBeNull();
  });
});

describe("wslUncFor", () => {
  it("POSIX → 标准 UNC(统一 wsl.localhost,根不带尾斜杠)", () => {
    expect(wslUncFor("Ubuntu", "/home/u")).toBe("\\\\wsl.localhost\\Ubuntu\\home\\u");
    expect(wslUncFor("Ubuntu", "/")).toBe("\\\\wsl.localhost\\Ubuntu");
    expect(wslUncFor("Ubuntu", "home/u")).toBe("\\\\wsl.localhost\\Ubuntu\\home\\u");
  });

  it("与 parseWslPath 互逆", () => {
    const p = "\\\\wsl.localhost\\Ubuntu\\home\\u\\proj";
    const loc = parseWslPath(p)!;
    expect(wslUncFor(loc.distro, loc.posix)).toBe(p);
  });
});

describe("wsl.exe 调用形态", () => {
  it("命令经发行版内 bash -lc;--cd 携带 POSIX cwd(不是 UNC)", () => {
    expect(wslShellInvocation("Ubuntu", "/home/u/proj", "pwd && ls -la")).toEqual({
      cmd: "wsl.exe",
      args: ["-d", "Ubuntu", "--cd", "/home/u/proj", "--exec", "bash", "-lc", "pwd && ls -la"],
    });
  });

  it("交互终端:bash --norc --noprofile", () => {
    expect(wslPtyInvocation("Ubuntu", "/home/u")).toEqual({
      cmd: "wsl.exe",
      args: ["-d", "Ubuntu", "--cd", "/home/u", "--exec", "bash", "--norc", "--noprofile"],
    });
  });

  it("git:argv 直传(不经过 shell;含空格文件名安全)", () => {
    expect(wslGitInvocation("Ubuntu", "/home/u/proj", ["commit", "-m", "a b"])).toEqual({
      cmd: "wsl.exe",
      args: ["-d", "Ubuntu", "--cd", "/home/u/proj", "--exec", "git", "commit", "-m", "a b"],
    });
  });

  it("非法/缺失 posix 回落到根", () => {
    expect(wslShellInvocation("Ubuntu", "", "x").args.slice(0, 4)).toEqual(["-d", "Ubuntu", "--cd", "/"]);
  });
});

describe("平台门控与提示", () => {
  it("只有 win32 启用 WSL 桥", () => {
    expect(wslSupported("win32")).toBe(true);
    expect(wslSupported("linux")).toBe(false);
    expect(wslSupported("darwin")).toBe(false);
  });

  it("非 Windows 平台枚举/锚点直接空(不 spawn)", async () => {
    __resetWslCache();
    expect(await listWslDistros({ platform: "linux" })).toEqual([]);
    expect(await wslAnchors({ platform: "linux" })).toEqual([]);
  });

  it("wsl.exe 缺失 / 发行版不存在 / git 缺失 → 人话提示", () => {
    expect(wslErrorHint(Object.assign(new Error("spawn wsl.exe ENOENT"), { code: "ENOENT" }))).toContain("wsl.exe");
    expect(wslErrorHint(new Error("There is no distribution with the supplied name"))).toContain("发行版不存在");
    expect(wslErrorHint(new Error("bash: line 1: git: command not found"), "Ubuntu")).toContain("没有 git");
    expect(wslErrorHint(new Error("boom"))).toBeUndefined();
  });
});