/**
 *  展示层:legacy 错误码别名先归一化再取人话文案。
 * 锁住四条面(白板 n3/n4 的 accept):
 * G) `errorText("companion-failed")` 出的是 canonical 的文案(不再出现「(legacy companion 错误码)」)
 * S) 归一与 protocol 兼容登记表同源:每条 COMPAT_WINDOWS 的 legacy 与 canonical 文案逐字相同
 * P) 面板注入形态(函数 toString 后在**没有** protocol 模块的作用域里跑)不抛、ERR_TEXT 键数不变
 * T) 旧契约不回归:未登记 code 仍兜底「未知错误(」、canonical 文案未变、ERR_TEXT 仍是全量表
 * 注意:errorText 的源码会被 panel.ts 用 toString 注入浏览器侧,所以本文件的 P 用例是用
 * `new Function` 复刻那个「无 compat 符号」环境 —— 归一别名必须是函数体内内联字面量,
 * 不能引用任何模块级绑定(bundler 会把 import 改写成属性访问,浏览器侧直接 ReferenceError)。
 */
import { describe, it, expect } from "vitest";
import {
  COMPAT_WINDOWS,
  ERROR_CODE_VALUES,
  ErrorCode,
} from "@lampgenie/protocol";
import {
  ERR_TEXT,
  ERR_UNKNOWN_PREFIX,
  LEGACY_TEXT_ALIAS,
  errorText,
  errorTextWithCompat,
} from "../src/error-text.js";

const LEGACY_OK = "companion-failed";
const CANON_OK = "super-failed";
const LEGACY_ANNOUNCE = "companion-announce-failed";
const CANON_ANNOUNCE = "super-announce-failed";

describe("errorText:legacy 别名归一(展示层)", () => {
  it("G) legacy 别名出 canonical 人话,不再命中「(legacy companion 错误码)」文案", () => {
    const legacy = errorText(LEGACY_OK);
    expect(legacy).toBe(ERR_TEXT[ErrorCode.SuperFailed]);
    expect(legacy).toBe("指挥台对话失败");
    expect(legacy).not.toContain("legacy");
    expect(errorText(LEGACY_ANNOUNCE)).toBe(ERR_TEXT[ErrorCode.SuperAnnounceFailed]);
    expect(errorText(LEGACY_ANNOUNCE)).not.toContain("legacy");
  });

  it("G') legacy + 服务端原文:文案是 canonical 的,原文照出(不被吞)", () => {
    expect(errorText(LEGACY_OK, "上游 502")).toBe("指挥台对话失败 — 上游 502");
    expect(errorText(LEGACY_OK, "")).toBe("指挥台对话失败");
 // message 超长仍按既有口径截到 300 字
    const long = "x".repeat(400);
    expect(errorText(LEGACY_OK, long).endsWith("x".repeat(300))).toBe(true);
  });

  it("S) 同源:登记表每条 legacy 的文案与其 canonical 逐字相同(归一表没有第二份手抄)", () => {
    expect(COMPAT_WINDOWS.length).toBeGreaterThanOrEqual(2);
    for (const entry of COMPAT_WINDOWS) {
      expect(errorText(entry.legacy), entry.legacy).toBe(errorText(entry.canonical));
      expect(ERR_TEXT[entry.canonical as ErrorCode], entry.canonical).toBeTruthy();
    }
    expect(errorText(LEGACY_OK)).toBe(errorText(CANON_OK));
    expect(errorText(LEGACY_ANNOUNCE)).toBe(errorText(CANON_ANNOUNCE));
  });

  it("T) 旧契约不回归:未登记码兜底、canonical 文案与改造前逐字相同", () => {
    const unknown = errorText("no-such-code-xyz", "服务端原样细节");
    expect(unknown.startsWith(ERR_UNKNOWN_PREFIX)).toBe(true);
    expect(unknown).toContain("no-such-code-xyz");
    expect(unknown).toContain("服务端原样细节");
    expect(errorText(ErrorCode.NotImplemented, "MCP 未启用")).toBe(ERR_TEXT[ErrorCode.NotImplemented] + " — MCP 未启用");
    expect(errorText(ErrorCode.HandlerCrash)).toBe(ERR_TEXT[ErrorCode.HandlerCrash]);
 // 原型链键不被当成已登记 code
    expect(errorText("constructor", "x").startsWith(ERR_UNKNOWN_PREFIX)).toBe(true);
 // 空 code 仍兜底,不返回空白
    expect(errorText("", "")).toContain(ERR_UNKNOWN_PREFIX);
  });

  it("T') ERR_TEXT 表未被双读改写:键数=ErrorCode 全集,legacy 两条仍在表里(不删历史键)", () => {
    expect(Object.keys(ERR_TEXT).length).toBe(ERROR_CODE_VALUES.length);
    for (const code of ERROR_CODE_VALUES) expect(typeof ERR_TEXT[code], code).toBe("string");
 // legacy 键保留(表是 Record<ErrorCode,string>,删键会 tsc 报错);值仍是它们自己的说明文案
    expect(ERR_TEXT[ErrorCode.CompanionFailed]).toContain("legacy");
    expect(ERR_TEXT[ErrorCode.CompanionAnnounceFailed]).toContain("legacy");
 // ErrorCode 值本身不许改(线上字符串零漂移)
    expect(ErrorCode.CompanionFailed).toBe(LEGACY_OK);
    expect(ErrorCode.CompanionAnnounceFailed).toBe(LEGACY_ANNOUNCE);
  });

  it("P) 面板注入形态:toString() 出来的 errorText 在无 protocol 符号的作用域里不抛且归一照样生效", () => {
 // 复刻 panel.ts 的注入形态(只注入 ERR_TEXT/ERR_UNKNOWN_PREFIX + 函数源码,没有 compat 模块)
    const factory = new Function(
      "ERR_TEXT",
      "ERR_UNKNOWN_PREFIX",
      "return (" + errorText.toString() + ");",
    ) as (table: unknown, prefix: string) => (code: unknown, message?: unknown) => string;
    const browserSide = factory(ERR_TEXT, ERR_UNKNOWN_PREFIX);
 // 不抛:别名是函数体内联字面量,不引用任何模块级绑定
    expect(() => browserSide(LEGACY_OK)).not.toThrow();
    expect(() => browserSide("no-such-code", "原样")).not.toThrow();
 // 注入形态里 legacy 别名同样归一(不靠 Node 侧符号)
    expect(browserSide(LEGACY_OK)).toBe(ERR_TEXT[ErrorCode.SuperFailed]);
    expect(browserSide(LEGACY_ANNOUNCE)).toBe(ERR_TEXT[ErrorCode.SuperAnnounceFailed]);
 // 未登记码在两侧行为一致(归一不影响 passthrough)
    expect(browserSide("no-such-code", "原样")).toBe(errorText("no-such-code", "原样"));
    expect(browserSide(ErrorCode.HandlerCrash, "boom")).toBe(errorText(ErrorCode.HandlerCrash, "boom"));
 // 源码不得引用 protocol 绑定:bundler 会把 import 改写成 `xxx.yyy` 属性访问,浏览器侧直接 ReferenceError
    expect(String(errorText)).not.toContain("resolveErrorCodeCompat");
    expect(String(errorText)).not.toContain("COMPAT_WINDOWS");
 // 但表里每条 canonical 文案在注入侧仍可正常产出
    for (const entry of COMPAT_WINDOWS) expect(browserSide(entry.canonical)).toBe(ERR_TEXT[entry.canonical as ErrorCode]);
  });

  it("S') 交叉断言:LEGACY_TEXT_ALIAS 与登记表双向一致,errorTextWithCompat 与 errorText 结论逐字相同", () => {
    expect(LEGACY_TEXT_ALIAS).toEqual(Object.fromEntries(COMPAT_WINDOWS.map((e) => [e.legacy, e.canonical])));
    expect(Object.isFrozen(LEGACY_TEXT_ALIAS)).toBe(true);
    for (const entry of COMPAT_WINDOWS) {
 // 表里新增别名而内联字面量漏写 → 这里立刻红
      expect(errorText(entry.legacy, "x"), entry.legacy).toBe(errorText(entry.canonical, "x"));
      expect(errorTextWithCompat(entry.legacy, "x"), entry.legacy).toBe(errorText(entry.canonical, "x"));
 // 窗口后(now 已过下线日)结论不变:归一与时间无关,只是 phase 变化
      expect(errorTextWithCompat(entry.legacy, "x", "2027-06-01T00:00:00.000Z")).toBe(errorText(entry.canonical, "x"));
    }
 // 未登记码:两条路径都原样兜底/出文案
    expect(errorTextWithCompat("no-such-code")).toBe(errorText("no-such-code"));
    expect(errorTextWithCompat(ErrorCode.NotImplemented, "m")).toBe(errorText(ErrorCode.NotImplemented, "m"));
  });

  it("P') 归一为纯查询:重复调用同一 code 结果恒定(无隐藏状态)", () => {
    const first = errorText(LEGACY_OK, "x");
    for (let i = 0; i < 3; i += 1) expect(errorText(LEGACY_OK, "x")).toBe(first);
    expect(errorText(LEGACY_OK, "x")).toBe(errorText(CANON_OK, "x"));
  });
});
