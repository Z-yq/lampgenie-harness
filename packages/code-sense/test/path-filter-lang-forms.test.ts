/**
 * path-filter 语言族识别(2026-10-25):Rust/C#/Ruby/PHP 接入 adapter 后补的测试文件命名形态,
 * 同时锁定「不得误伤」——小写 latest/contest 之类不判测试。
 */
import { describe, it, expect } from "vitest";
import { isTestPath } from "../src/path-filter";

describe("isTestPath:新接入语言族形态", () => {
  it("Rust: _test.rs(目录 tests/ 已有通用规则)", () => {
    expect(isTestPath("src/parser_test.rs")).toBe(true);
    expect(isTestPath("src/parser.rs")).toBe(false);
  });

  it("Ruby: _spec.rb / _test.rb", () => {
    expect(isTestPath("spec/models/user_spec.rb")).toBe(true);
    expect(isTestPath("lib/user_test.rb")).toBe(true);
    expect(isTestPath("lib/user.rb")).toBe(false);
  });

  it("C#: Tests?.cs;小写 test 结尾的单词不误判", () => {
    expect(isTestPath("src/FooTests.cs")).toBe(true);
    expect(isTestPath("src/FooTest.cs")).toBe(true);
    expect(isTestPath("src/Contest.cs")).toBe(false); // 小写 t,不是约定后缀
    expect(isTestPath("src/Program.cs")).toBe(false);
  });

  it("PHP: Tests?.php;小写 test 结尾的单词不误判", () => {
    expect(isTestPath("tests/FooTest.php")).toBe(true);
    expect(isTestPath("src/FooTests.php")).toBe(true);
    expect(isTestPath("src/latest.php")).toBe(false);
  });

  it("既有语言口径不变(回归锚)", () => {
    expect(isTestPath("tests/a.py")).toBe(true);
    expect(isTestPath("x_test.go")).toBe(true);
    expect(isTestPath("src/UserTest.java")).toBe(true);
    expect(isTestPath("web/a.spec.ts")).toBe(true);
    expect(isTestPath("web/main.ts")).toBe(false);
  });
});
