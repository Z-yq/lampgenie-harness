/**
 * git 执行形态单测:WSL 项目(UNC cwd)必须回发行版内执行,
 * 不能用 Windows git 隔着 \\wsl.localhost 共享操作 Linux 仓库(行尾/权限语义会错)。
 */
import { describe, it, expect } from "vitest";
import { gitInvocationFor } from "../src/git-service.js";

describe("gitInvocationFor", () => {
  it("普通 Windows 路径 → 本地 git + cwd", () => {
    expect(gitInvocationFor("E:\\workship\\genie", ["status", "--porcelain"])).toEqual({
      cmd: "git", args: ["status", "--porcelain"], mode: "host",
    });
  });

  it("WSL UNC → wsl.exe --exec git(参数原样,含空格)", () => {
    expect(gitInvocationFor("\\\\wsl.localhost\\Ubuntu\\home\\u\\proj", ["commit", "-m", "msg with space"])).toEqual({
      cmd: "wsl.exe",
      args: ["-d", "Ubuntu", "--cd", "/home/u/proj", "--exec", "git", "commit", "-m", "msg with space"],
      mode: "wsl",
    });
  });

  it("POSIX 路径(Linux 网关)→ 本地 git", () => {
    expect(gitInvocationFor("/home/u/proj", ["log", "-1"]).mode).toBe("host");
  });
});