/**
 * CLI 参数体验单测(step-092):
 *  - expandTilde:波浪号自展(~/非 shell 调用形态 shell 不代展开);
 *  - vars/tokens 缺文件预检:完整解析路径 + 仓内同名建议(替代 deep 层 slice(0,80) 截断的半截 ENOENT);
 *  - 显式 --root 不存在 fail-visible(exit 2,不再静默滑向零仓全 miss);
 *  - file 指令与 vars/tokens 形态一致:绝对路径落在仓内=相对化(tilde 同展)。
 * 夹具=临时 HOME + 临时仓(产物全落临时目录,零仓内影响)。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { runCli, type CliIo } from "../src/cli.js";
import { parseArgs, expandTilde } from "../src/args.js";

let fakeHome = "";
let repo = "";
let prevHome = "";
let prevUserProfile = "";

const C_SRC = [
  "#include <stdlib.h>",
  "struct Frame { int w; int h; };",
  "static int counter = 0;",
  "const char* version = \"1.0\";",
  "struct Frame global_frame;",
  "int main(void) { return counter; }",
].join("\n");

function capture(): { io: CliIo; out: () => string; err: () => string } {
  const o: string[] = [];
  const e: string[] = [];
  return {
    io: { out: (s) => (o.push(s), undefined), err: (s) => (e.push(s), undefined) },
    out: () => o.join("\n"),
    err: () => e.join("\n"),
  };
}

beforeAll(() => {
  prevHome = process.env.HOME ?? "";
  prevUserProfile = process.env.USERPROFILE ?? "";
  fakeHome = mkdtempSync(join(tmpdir(), "csargs-home-"));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  // 夹具仓:深度嵌套的真实文件(供同名建议命中)+ 无 .git 也可(root 显式给定不走发现)
  repo = mkdtempSync(join(tmpdir(), "csargs-repo-"));
  mkdirSync(join(repo, "modules", "imgproc", "src"), { recursive: true });
  writeFileSync(join(repo, "modules", "imgproc", "src", "color_lab.cpp"), C_SRC);
});

afterAll(() => {
  process.env.HOME = prevHome;
  process.env.USERPROFILE = prevUserProfile;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("expandTilde(参数面波浪号自展)", () => {
  it("~ 与 ~/x 展开到主目录;~user 与普通路径原样", () => {
    expect(expandTilde("~")).toBe(homedir());
    expect(expandTilde("~/a/b")).toBe(join(homedir(), "a/b"));
    expect(expandTilde("~\\a")).toBe(join(homedir(), "a")); // Windows 反斜杠形态
    expect(expandTilde("~user/x")).toBe("~user/x"); // 只有裸 ~ 与 ~/ 前缀才展开
    expect(expandTilde("/abs/path")).toBe("/abs/path");
    expect(expandTilde("rel/path")).toBe("rel/path");
    expect(expandTilde("")).toBe("");
  });

  it("parseArgs 回归锚:--root value / --root=value / 布尔开关与位置参数互不吞", () => {
    const p = parseArgs(["vars", "--root", "/some/dir", "src/x.cpp", "--json"]);
    expect(p.flags.root).toBe("/some/dir");
    expect(p._).toEqual(["vars", "src/x.cpp"]);
    expect(p.flags.json).toBe(true);
    const p2 = parseArgs(["file", "--root=/some/dir", "a.ts"]);
    expect(p2.flags.root).toBe("/some/dir");
    expect(p2._).toEqual(["file", "a.ts"]);
  });
});

describe("vars/tokens 参数形态(step-092 DoD 两形态都通)", () => {
  it("vars --root <波浪号(引号包裹不展开)> → 展开后命中夹具", async () => {
    mkdirSync(join(fakeHome, "tildefix", "modules", "imgproc", "src"), { recursive: true });
    writeFileSync(join(fakeHome, "tildefix", "modules", "imgproc", "src", "color_lab.cpp"), C_SRC);
    const r = capture();
    const code = await runCli(["vars", "--root", "~/tildefix", "modules/imgproc/src/color_lab.cpp"], r.io);
    expect(code).toBe(0);
    expect(r.out()).toContain("color_lab.cpp");
    expect(r.out()).toContain("counter");
  });

  it("vars --root <绝对路径> 同一夹具同结果(两形态等价)", async () => {
    const r = capture();
    const code = await runCli(["vars", "--root", join(fakeHome, "tildefix"), "modules/imgproc/src/color_lab.cpp"], r.io);
    expect(code).toBe(0);
    expect(r.out()).toContain("counter");
  });

  it("vars 文件参数=波浪号路径(相对 root 外→单文件根)", async () => {
    const r = capture();
    const code = await runCli(["vars", "--root", repo, "~/tildefix/modules/imgproc/src/color_lab.cpp"], r.io);
    expect(code).toBe(0);
    expect(r.out()).toContain("counter");
  });
});

describe("缺文件诊断(step-092:完整路径+同名建议,替代半截 ENOENT)", () => {
  it("vars 缺文件:文本面含完整解析路径 + 仓内同名建议,exit 1", async () => {
    const r = capture();
    const code = await runCli(["vars", "--root", repo, "src/color_lab.cpp"], r.io);
    expect(code).toBe(1);
    const text = r.out();
    expect(text).toContain("文件不存在");
    expect(text).toContain(join(repo, "src", "color_lab.cpp")); // 完整路径,不再被截断
    expect(text).toContain("modules/imgproc/src/color_lab.cpp"); // 同名建议指到真身
    expect(text).not.toMatch(/ENOENT/); // 半截 ENOENT 幻象不再外泄
  });

  it("vars --json 缺文件:结构化 error+suggestions", async () => {
    const r = capture();
    const code = await runCli(["vars", "--root", repo, "src/color_lab.cpp", "--json"], r.io);
    expect(code).toBe(1);
    const j = JSON.parse(r.out());
    expect(j.error).toContain(join(repo, "src", "color_lab.cpp"));
    expect(j.suggestions).toContain("modules/imgproc/src/color_lab.cpp");
  });

  it("tokens 缺文件同族同诊断", async () => {
    const r = capture();
    const code = await runCli(["tokens", "--root", repo, "src/color_lab.cpp"], r.io);
    expect(code).toBe(1);
    expect(r.out()).toContain("文件不存在");
    expect(r.out()).toContain("modules/imgproc/src/color_lab.cpp");
  });
});

describe("root 预检(step-092 fail-visible)", () => {
  it("显式 --root 不存在:exit 2 + 人话(不再静默零仓)", async () => {
    const r = capture();
    const code = await runCli(["vars", "--root", join(tmpdir(), "csargs-nope-xyz"), "x.cpp"], r.io);
    expect(code).toBe(2);
    expect(r.err()).toContain("root 不存在");
    expect(r.err()).toContain("csargs-nope-xyz");
  });
});

describe("file 指令形态一致(绝对路径相对化 + tilde)", () => {
  it("file --json 绝对路径(仓内)→ 相对路径命中索引", async () => {
    const r = capture();
    const init = capture();
    expect(await runCli(["index", "--register", "--json", repo], init.io)).toBe(0);
    const abs = join(repo, "modules", "imgproc", "src", "color_lab.cpp");
    const code = await runCli(["file", "--root", repo, abs, "--json"], r.io);
    expect(code).toBe(0);
    const j = JSON.parse(r.out());
    expect(j.path).toBe("modules/imgproc/src/color_lab.cpp");
    expect((j.symbols ?? []).length).toBeGreaterThan(0);
  }, 120_000);
});
