/**
 * 输入边界防御:read guard 顺序 + 单行 2000 clamp + 编辑比例守卫。
 * 覆盖(机制口径:「输入边界防御」):
 * ①/proc/self/environ 泄密路径被拒;②/dev/zero 设备路径被拒;③symlink 指向 /proc 被 realpath 归一后拒;
 * ④FIFO 在 open 前被 stat special 拒(不挂死);⑤600KB 单行 clamp 到 ≤2000 且带「…(+N 字符已截断)」;
 * ⑥大段删除(>20 行且 new 空)被 edit-ratio-guard 拒并提示 write_file。
 * 设备/伪文件类用例走 permission auto(完全访问):围栏放开后守卫仍必须拦住——
 * 路径围栏与「进程级风险」是两道独立的闸。
 */
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileTools } from "../src/file-tools.js";
import type { Tool } from "@lampgenie/runtime/agent/loop";
import { setPermissionMode } from "../src/permission-mode.js";
import { MemoryJournal } from "@lampgenie/core";
import {
  EDIT_RATIO_MIN_DELETED_LINES,
  MAX_LINE_CHARS,
  checkEditRatio,
  clampLine,
  deletedLineCount,
  readGuardPath,
} from "../src/input-boundary.js";

const dirs: string[] = [];
const mk = () => {
  const d = mkdtempSync(join(tmpdir(), "input-boundary-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  setPermissionMode("ask");
});
afterAll(() => setPermissionMode("ask"));

function exec(root: string) {
  const tools: Tool[] = createFileTools({ root, journal: new MemoryJournal(), sessionId: "input-boundary" });
  const byName = new Map<string, Tool>(tools.map((t) => [t.name, t]));
  return (name: string, args: unknown) => byName.get(name)!.execute(args) as Promise<string>;
}

describe("read guard 顺序(归一 → 设备/伪文件 → stat special → denylist)", () => {
  it("/proc/self/environ 被拒(伪文件系统,绝不到 open)", async () => {
    const root = mk();
    setPermissionMode("auto"); // 完全访问:围栏放开,只剩守卫这一道闸
    const text = await exec(root)("read_file", { path: "/proc/self/environ" });
    expect(text).toContain("拒绝读取");
    expect(text).toMatch(/设备\/管道\/伪文件系统路径\(\/proc\//);
    expect(text.includes("拒绝读取后仍读到内容")).toBe(false);
  });

  it("/dev/zero 被拒(读它会无限产出零字节并挂死)", async () => {
    const root = mk();
    setPermissionMode("auto");
    const text = await exec(root)("read_file", { path: "/dev/zero" });
    expect(text).toMatch(/拒绝读取:设备\/管道\/伪文件系统路径/);
    expect(text).not.toMatch(/^\s*1\t/); // 没有返回任何行号行
  });

  it("symlink 指向 /proc 被拒(守卫先 realpath 归一,围栏放开的 auto 模式也逃不掉)", async () => {
    const root = mk();
    const link = join(root, "innocent.txt");
    try {
      symlinkSync("/proc/self/environ", link);
    } catch {
      return; // 平台不支持符号链接(Windows 无权限):跳过
    }
    setPermissionMode("auto");
    const text = await exec(root)("read_file", { path: "innocent.txt" });
    expect(text).toContain("拒绝读取");
    expect(text).toMatch(/伪文件系统路径/);
  });

  it("FIFO 被拒(open 之前用 stat isFIFO 拦下,不阻塞)", async () => {
    const root = mk();
    const fifo = join(root, "pipe.txt");
    try {
      execFileSync("mkfifo", [fifo]);
    } catch {
      return; // 无 mkfifo(Windows):跳过
    }
    setPermissionMode("auto");
    const text = await exec(root)("read_file", { path: "pipe.txt" });
    expect(text).toMatch(/拒绝读取:设备\/管道\/伪文件路径\(FIFO 管道/);
  });

  it("守卫可单独调用:普通文件放行并给出真实路径与大小(目录不在此拒)", async () => {
    const root = mk();
    writeFileSync(join(root, "a.txt"), "hello");
    const ok = await readGuardPath(join(root, "a.txt"));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.realPath.endsWith("a.txt")).toBe(true);
      expect(ok.size).toBe(5);
    }
    mkdirSync(join(root, "sub"));
    const dir = await readGuardPath(join(root, "sub"));
    expect(dir.ok).toBe(true); // 目录留给调用方的 isFile 判定(错误文案零漂移)
  });
});

describe("单行 2000 clamp(标记计入额度)", () => {
  it("600KB 单行读出来 ≤2000 字符且带截断标记", async () => {
    const root = mk();
    writeFileSync(join(root, "huge.txt"), "x".repeat(600 * 1024) + "\n第二行\n");
    const text = await exec(root)("read_file", { path: "huge.txt" });
    const first = text.split("\n")[0]!;
    // 行号前缀(6 位 + tab)之外的正文必须 ≤2000
    const body = first.replace(/^\s*\d+\t/, "");
    expect(body.length).toBeLessThanOrEqual(MAX_LINE_CHARS);
    expect(body).toContain("字符已截断");
    expect(body).toMatch(/…\(\+\d+ 字符已截断\)$/);
    expect(text).toContain("第二行"); // clamp 只作用于超长行,不吞后续行
  });

  it("clampLine 纯函数:超长含标记总长 ≤ 上限,短行原样返回", () => {
    const long = "中".repeat(5000);
    const out = clampLine(long);
    expect(out.length).toBeLessThanOrEqual(MAX_LINE_CHARS);
    expect(out).toMatch(/…\(\+\d+ 字符已截断\)$/);
    expect(clampLine("短行")).toBe("短行");
    // 代理对不被切半(孤立代理会让上游 JSON 解析 400)
    const emoji = "🎙".repeat(3000);
    const cut = clampLine(emoji);
    const last = cut.charCodeAt(cut.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });
});

describe("编辑比例守卫 edit-ratio-guard", () => {
  it("大段删除(>20 行且 new 空)被拒,原文未改,提示改用 write_file", async () => {
    const root = mk();
    const file = join(root, "big.ts");
    const lines = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`);
    writeFileSync(file, lines.join("\n") + "\n");
    const call = exec(root);
    await call("read_file", { path: "big.ts" }); // 编辑保鲜要求先读
    const denied = await call("edit_file", { path: "big.ts", old_string: lines.join("\n") + "\n", new_string: "" });
    expect(denied).toContain("edit-ratio-guard");
    expect(denied).toContain("write_file");
    expect(readFileSync(file, "utf-8")).toBe(lines.join("\n") + "\n");
  });

  it("纯函数边界:删行 ≤ 阈值放行;new 保留大半内容(改写)放行;空串大段删拒", () => {
    const old20 = Array.from({ length: EDIT_RATIO_MIN_DELETED_LINES }, (_, i) => `l${i}`).join("\n");
    expect(deletedLineCount(old20, "")).toBe(EDIT_RATIO_MIN_DELETED_LINES);
    expect(checkEditRatio(old20, "")).toBeNull(); // 恰好等于阈值:不拦(> 才拦)
    const old21 = Array.from({ length: EDIT_RATIO_MIN_DELETED_LINES + 1 }, (_, i) => `l${i}`).join("\n");
    expect(checkEditRatio(old21, "")).toContain("edit-ratio-guard");
    // 改写而非删除:删 30 行但 new 长度 ≥ old 一半 → 放行
    const rewritten = Array.from({ length: 30 }, (_, i) => `// 新实现 ${i} 说明文字够长一些`).join("\n");
    expect(rewritten.length).toBeGreaterThanOrEqual(old21.length * 0.5);
    expect(checkEditRatio(old21, rewritten)).toBeNull();
  });
});
