/**
 * 命令围栏单测(fenceCommand,workspace=工作区内档):
 * ①workspace 下命令文本里的项目外绝对路径/越界 .. 段被拒(含 `cat /etc/hostname`、`rm -rf /tmp/x`);
 * ②workspace 下常规项目内命令放行(pnpm test / git status / cat src/foo.ts / ls -la / node scripts/x.mjs);
 * ③对称断言:auto(完全访问)与 ask/readonly/plan 四档对同一条越界命令一律返回 null(零回归,不得误拦);
 * ④围栏根用 temp 目录(与 taskRoot 一致),不依赖仓库真实路径。
 * 每个用例前后复原 setPermissionMode("ask")——权限模式是进程级单例,漏复原会污染同文件后续用例。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fenceCommand } from "../src/file-tools.js";
import { setPermissionMode } from "../src/permission-mode.js";

let root = "";

beforeEach(() => {
  setPermissionMode("ask");
  root = mkdtempSync(join(tmpdir(), "cmdfence-"));
});

afterEach(() => {
  setPermissionMode("ask");
  rmSync(root, { recursive: true, force: true });
});

describe("fenceCommand(workspace=工作区内)", () => {
  beforeEach(() => setPermissionMode("workspace"));

  it("项目外绝对路径被拒", () => {
    expect(fenceCommand("cat /etc/hostname", root)).toContain("/etc/hostname");
    expect(fenceCommand("rm -rf /tmp/x", root)).toContain("/tmp/x");
    // 混合命令里挑出越界 token 也拦
    expect(fenceCommand("ls && cat /etc/passwd", root)).toContain("/etc/passwd");
    expect(fenceCommand("echo a | tee /tmp/log", root)).toContain("/tmp/log");
  });

  it("越界 .. 段被拒", () => {
    expect(fenceCommand("ls ../outside", root)).not.toBeNull();
    expect(fenceCommand("cat ../outside/secret.txt", root)).not.toBeNull();
  });

  it("项目内命令放行(不误伤日常命令)", () => {
    for (const cmd of [
      "pnpm test",
      "git status",
      "cat src/foo.ts",
      "ls -la",
      "node scripts/x.mjs",
      "git commit -m 'fix: a b'",
      "cd packages/core && pnpm build",
      "cat src/../src/foo.ts", // .. 段但 resolve 后仍在根内
      `ls ${root}`, // 根内绝对路径
      // 重定向到系统 I/O 黑洞是 shell 日常写法,不构成越权(实测最易误伤的一条)
      "pnpm test 2>/dev/null",
      "npx vitest run test/a.test.ts > /dev/null 2>&1",
      // 引号内含空白的散文(提交说明/echo 文案)不是路径参数
      'git commit -m "fix: 参考 /tmp/x 的日志"',
      'echo "见 /etc/hosts 的说明"',
    ]) {
      expect({ cmd, reason: fenceCommand(cmd, root) }).toEqual({ cmd, reason: null });
    }
  });

  it("重定向落盘:项目内放行、项目外拒绝", () => {
    expect(fenceCommand("pnpm test > out.log", root)).toBeNull();
    expect(fenceCommand("pnpm test > /tmp/out.log", root)).toContain("/tmp/out.log");
    expect(fenceCommand("cat src/a.ts >> ../out.log", root)).not.toBeNull();
  });

  it("能力边界如实登记:解释器级逃逸不拦(纯文本启发式上限)", () => {
    // 引号包裹的完整命令整串按散文跳过 —— 已知边界,断言现状避免后人误以为已封死
    expect(fenceCommand('bash -c "cat /etc/hostname"', root)).toBeNull();
    // 反证:以下两种反而被 token 切分捕获(比预期更严,如实记录)
    expect(fenceCommand("cat $(echo /etc/hostname)", root)).toContain("/etc/hostname");
    expect(fenceCommand("cd / && ls", root)).toContain("/"); // `cd /` 单独 token 即被挡
  });
});

describe("fenceCommand 四档零回归", () => {
  it("auto(完全访问):同一条越界命令返回 null", () => {
    setPermissionMode("auto");
    expect(fenceCommand("cat /etc/hostname", root)).toBeNull();
    expect(fenceCommand("rm -rf /tmp/x", root)).toBeNull();
    expect(fenceCommand("ls ../outside", root)).toBeNull();
  });

  it("ask/readonly/plan:同一条越界命令返回 null", () => {
    for (const mode of ["ask", "readonly", "plan"] as const) {
      setPermissionMode(mode);
      expect({ mode, reason: fenceCommand("cat /etc/hostname", root) }).toEqual({ mode, reason: null });
    }
  });
});
