/**
 * 权限模式第 5 档 workspace 单测(与 file-tools.test.ts 同风格):
 * ①五档合法值 setPermissionMode 往返;非法值/undefined 归一 ask;
 * ②文件围栏分档:auto=完全访问(绝对路径/.. 越界放行,可落盘项目外);workspace=只能碰项目根内
 *   (项目外绝对路径被拒且不落盘,根内可写——writeDeniedByMode 只拒 readonly/plan);
 * ③既有严格档(ask/readonly)对项目外仍拒(防回归)。
 * 每个用例 afterEach 复原 "ask",不污染其它用例。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { permissionMode, setPermissionMode, type PermissionMode } from "../src/permission-mode.js";
import { createFileTools, fencePath } from "../src/file-tools.js";
import { MemoryJournal } from "@lampgenie/core";
import type { Tool } from "@lampgenie/runtime/agent/loop";

const dirs: string[] = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), "permmode-")); dirs.push(d); return d; };

/** 项目外探针路径(绝对路径,落在临时目录外)。 */
const outsidePath = () => join(tmpdir(), `genie-auto-probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.txt`);

afterEach(() => {
  setPermissionMode("ask");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function toolsOf(root: string) {
  const journal = new MemoryJournal();
  const tools: Tool[] = createFileTools({ root, journal, sessionId: "perm-mode-t1" });
  const byName = new Map<string, Tool>(tools.map((t) => [t.name, t] as [string, Tool]));
  return { journal, exec: (name: string, args: unknown) => byName.get(name)!.execute(args) as Promise<string> };
}

describe("权限模式取值", () => {
  it("五档合法值逐一往返", () => {
    const modes: PermissionMode[] = ["ask", "auto", "workspace", "readonly", "plan"];
    for (const m of modes) {
      setPermissionMode(m);
      expect(permissionMode()).toBe(m);
    }
  });

  it("非法值 \"x\" 与 undefined 归一 ask", () => {
    setPermissionMode("workspace");
    setPermissionMode("x");
    expect(permissionMode()).toBe("ask");
    setPermissionMode("auto");
    setPermissionMode(undefined);
    expect(permissionMode()).toBe("ask");
  });
});

describe("围栏分档:auto=完全访问 / workspace=项目内", () => {
  it("auto 下项目外绝对路径被围栏放行且可落盘", async () => {
    const root = mk();
    const target = outsidePath();
    setPermissionMode("auto");
    expect(fencePath(root, target)).not.toBeNull();
    const { exec } = toolsOf(root);
    const out = await exec("write_file", { path: target, content: "auto-probe" });
    expect(out).not.toContain("越出项目根");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("auto-probe");
    rmSync(target, { force: true });
  });

  it("workspace 下项目外绝对路径被拒且不落盘", async () => {
    const root = mk();
    const target = outsidePath();
    setPermissionMode("workspace");
    expect(fencePath(root, target)).toBeNull();
    expect(fencePath(root, "../outside.txt")).toBeNull();
    const { exec } = toolsOf(root);
    const out = await exec("write_file", { path: target, content: "should-not-land" });
    expect(out).toContain("越出项目根");
    expect(existsSync(target)).toBe(false);
  });

  it("workspace 下项目根内路径可写(不被 writeDeniedByMode 拦)", async () => {
    const root = mk();
    setPermissionMode("workspace");
    const { journal, exec } = toolsOf(root);
    const out = await exec("write_file", { path: "src/a.txt", content: "inside" });
    expect(out).not.toContain("不允许修改文件");
    const abs = join(root, "src", "a.txt");
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, "utf-8")).toBe("inside");
    // workspace 不走只读/规划闸:无 permission.gate 拒绝事件
    expect(journal.readAll().filter((e) => e.kind === "permission.gate")).toHaveLength(0);
  });

  it("既有严格档(ask/readonly)对项目外仍然拒", async () => {
    const root = mk();
    const target = outsidePath();
    for (const mode of ["ask", "readonly"] as const) {
      setPermissionMode(mode);
      expect(fencePath(root, target)).toBeNull();
      const { exec } = toolsOf(root);
      const out = await exec("write_file", { path: target, content: "nope" });
      expect(out).toMatch(/越出项目根|不允许修改文件/);
      expect(existsSync(target)).toBe(false);
    }
  });
});
