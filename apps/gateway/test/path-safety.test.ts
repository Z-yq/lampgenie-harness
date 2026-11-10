/**
 * 路径围栏单测(2026-10-27):Windows 端口径。
 * 锚点:旧实现 `startsWith(root + "/")` 在 win32 realpath(反斜杠)下恒 false,
 * 导致 IDE 文件读/图片取数/嵌套写被误判越界;本判定必须两种方言都正确。
 */
import { describe, it, expect } from "vitest";
import { isPathInside } from "../src/path-safety.js";
import { win32, posix } from "node:path";

describe("isPathInside · POSIX", () => {
  it("根内/根自身/尾斜杠 → true", () => {
    expect(isPathInside("/repo", "/repo/a.ts", posix)).toBe(true);
    expect(isPathInside("/repo/", "/repo/a/b.ts", posix)).toBe(true);
    expect(isPathInside("/repo", "/repo", posix)).toBe(true);
    expect(isPathInside("/repo/", "/repo/", posix)).toBe(true);
  });

  it("越界/兄弟前缀/上层 → false", () => {
    expect(isPathInside("/repo", "/repo2/a.ts", posix)).toBe(false);
    expect(isPathInside("/repo", "/etc/passwd", posix)).toBe(false);
    expect(isPathInside("/repo/sub", "/repo/a.ts", posix)).toBe(false);
  });

  it("名字以两个点开头不算逃逸", () => {
    expect(isPathInside("/repo", "/repo/..env", posix)).toBe(true);
    // POSIX 下反斜杠是合法文件名字符,不当作分隔符
    expect(isPathInside("/repo", "/repo/..\\x", posix)).toBe(true);
  });
});

describe("isPathInside · Windows(2026-10-27 实锤)", () => {
  it("盘符路径:反斜杠子项 → true(旧 startsWith(root+'/') 在这里全 false)", () => {
    expect(isPathInside("E:\\workship\\genie", "E:\\workship\\genie\\README.md", win32)).toBe(true);
    expect(isPathInside("E:\\workship\\genie\\", "E:\\workship\\genie\\a\\b.ts", win32)).toBe(true);
    expect(isPathInside("E:\\workship\\genie", "E:\\workship\\genie", win32)).toBe(true);
  });

  it("大小写不敏感(Windows 语义)", () => {
    expect(isPathInside("E:\\WorkShip\\Genie", "e:\\workship\\genie\\a.ts", win32)).toBe(true);
  });

  it("跨盘符/兄弟目录/上层 → false", () => {
    expect(isPathInside("E:\\repo", "D:\\repo\\a.ts", win32)).toBe(false);
    expect(isPathInside("E:\\repo", "E:\\repo2\\a.ts", win32)).toBe(false);
    expect(isPathInside("E:\\repo\\sub", "E:\\repo\\a.ts", win32)).toBe(false);
    expect(isPathInside("E:\\repo", "E:\\repo\\..\\x", win32)).toBe(false);
  });

  it("WSL UNC:同发行版内 → true,跨发行版/跨 share → false", () => {
    const root = "\\\\wsl.localhost\\Ubuntu\\home\\u\\proj";
    expect(isPathInside(root, root + "\\src\\a.ts", win32)).toBe(true);
    expect(isPathInside(root, "\\\\wsl.localhost\\Ubuntu\\home\\u\\other\\a.ts", win32)).toBe(false);
    expect(isPathInside(root, "\\\\wsl$\\Ubuntu\\home\\u\\proj\\a.ts", win32)).toBe(false); // 不同 share 名
  });

  it("混合分隔符(面板/浏览器拼出来的正斜杠)→ true", () => {
    expect(isPathInside("\\\\wsl.localhost\\Ubuntu\\home\\u\\proj", "\\\\wsl.localhost/Ubuntu/home/u/proj/a.ts", win32)).toBe(true);
  });
});