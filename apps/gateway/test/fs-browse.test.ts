/**
 * step-056 服务端目录浏览(fs-browse):目录列表/锚点/打开命令选择。
 * 「选目录弹 Windows 对话框」根治的服务端件——浏览器侧 webkitdirectory 只能拿
 * Windows 相对路径,gateway 在 WSL 必须由服务端列目录才能看到 /home 真实路径。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDir, openCommandFor, browseAnchors, openPath } from "../src/fs-browse.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "genie-fsbrowse-"));
  mkdirSync(join(dir, "b-dir"));
  mkdirSync(join(dir, "a-dir"));
  mkdirSync(join(dir, ".hidden-dir"));
  writeFileSync(join(dir, "c.txt"), "x");
  writeFileSync(join(dir, ".dotfile"), "x");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("listDir", () => {
  it("目录在前、名称升序;默认跳过点文件", () => {
    const r = listDir(dir);
    expect(r.entries.map((e) => e.name)).toEqual(["a-dir", "b-dir", "c.txt"]);
    expect(r.entries[0]!.kind).toBe("dir");
    expect(r.entries[2]!.kind).toBe("file");
    expect(r.parent).toBeTruthy();
  });

  it("showHidden=true 点文件/点目录出现", () => {
    const r = listDir(dir, true);
    const names = r.entries.map((e) => e.name);
    expect(names).toContain(".hidden-dir");
    expect(names).toContain(".dotfile");
  });

  it("根目录 parent=null;mtime/size 有值", () => {
    const r = listDir("/");
    expect(r.parent).toBeNull();
    const withMeta = listDir(dir).entries.find((e) => e.name === "c.txt")!;
    expect(withMeta.size).toBe(1);
    expect(withMeta.mtime).toBeGreaterThan(0);
    utimesSync(join(dir, "c.txt"), new Date(), new Date(1_700_000_000_000));
    expect(listDir(dir).entries.find((e) => e.name === "c.txt")!.mtime).toBe(1_700_000_000_000);
  });

  it("非法输入:相对路径/文件路径 抛错(服务端转 fs.list.result.error)", () => {
    expect(() => listDir("")).toThrow();
    expect(() => listDir("rel/path")).toThrow(/绝对路径/);
    expect(() => listDir(join(dir, "c.txt"))).toThrow(/不是目录/);
    expect(() => listDir(join(dir, "不存在"))).toThrow();
  });
});

describe("openCommandFor(纯函数)", () => {
  it("linux+/mnt/* → explorer.exe 直达(Windows 盘挂载)", () => {
    expect(openCommandFor("linux", "/mnt/e/work", false)).toEqual({ cmd: "explorer.exe", args: ["/mnt/e/work"] });
  });
  it("linux+WSL 原生路径 → wslview 优先", () => {
    expect(openCommandFor("linux", "/home/u/p", true)).toEqual({ cmd: "wslview", args: ["/home/u/p"] });
  });
  it("darwin/win32 形态", () => {
    expect(openCommandFor("darwin", "/tmp/x", true)).toEqual({ cmd: "open", args: ["-R", "/tmp/x"] });
    expect(openCommandFor("win32", "C:\\x", false)).toEqual({ cmd: "explorer.exe", args: ["C:\\x"] });
  });
});

describe("openPath / browseAnchors", () => {
  it("非法路径拒绝且不 spawn", () => {
    expect(openPath("rel").ok).toBe(false);
    expect(openPath(join(dir, "不存在")).ok).toBe(false);
  });
  it("锚点:home/root/cwd 全绝对路径", () => {
    const a = browseAnchors();
    for (const p of [a.home, a.root, a.cwd]) expect(p.startsWith("/")).toBe(true);
  });
});
