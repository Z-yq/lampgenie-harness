/**
 * 错误码契约测试(错误语义统一第一批)。
 *
 * 锁住三条面(白板节点 batch1a-contract-test 的 accept):
 *  ①ErrorCode 全集每个 code 在面板 ERR_TEXT 里都有文案(文案表完备,不靠人肉对齐);
 *  ②未登记 code 走兜底文案「未知错误(<code>):<原文>」,且已登记 code 会带上服务端原文;
 *  ③error 帧 schema 按 Q1 过渡方案:登记码正常收,未登记字符串仍放行(不炸旧调用点)。
 *
 * 单源纪律:ERR_TEXT 只在 `src/error-text.ts` 手写一次,panel.ts 用同一份表(JSON + 函数源码)
 * 注入浏览器侧。所以本用例除了断言模块导出,还要从真实面板 HTML 里断言注入表与模块导出一致
 * ——防止有人日后在 panel.ts 里抄出第二份表(那会让服务端断言与线上渲染脱钩)。
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ErrorCode, ERROR_CODE_VALUES, ErrorCodeSchema } from "@lampgenie/protocol";
import { ERR_TEXT, errorText, errorDiagnostic } from "../src/error-text.js";
import { servePanel } from "../src/panel.js";

const NL = String.fromCharCode(10);

async function withPanel<T>(port: number, fn: (html: string) => T | Promise<T>): Promise<T> {
  const srv = servePanel(port, () => { /* 纯静态:不接 WS */ });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    return await fn(await res.text());
  } finally {
    await srv.close();
  }
}

describe("错误码枚举 + 文案表契约", () => {
  it("①ErrorCode 全集每个 code 都有非空人话文案(模块侧)", () => {
    expect(ERROR_CODE_VALUES.length).toBeGreaterThan(30);
    for (const code of ERROR_CODE_VALUES) {
      const text = ERR_TEXT[code];
      expect(typeof text, "缺文案:" + code).toBe("string");
      expect(text.length, "文案为空:" + code).toBeGreaterThan(1);
      // 文案必须与 code 不同(否则等于没翻译,回落到「自造字符串直接显示」)
      expect(text).not.toBe(code);
    }
  });

  it("①'面板真实注入的表/函数与模块同源,且注入代码真实可跑(单源,无第二份手抄表)", async () => {
    await withPanel(7982, (html) => {
      // 表以 `const ERR_TEXT={...}` 形式落在 PAGE 模板里(紧邻 PROVIDER_PRESETS 注入点)
      expect(html).toContain("const ERR_TEXT={");
      for (const code of ERROR_CODE_VALUES) {
        // JSON.stringify 后的键值对原样出现在模板里(键含引号,值转义由 JSON 保证)
        const pair = JSON.stringify(code) + ":" + JSON.stringify(ERR_TEXT[code]);
        expect(html.includes(pair), "面板未注入文案:" + code + " => " + pair).toBe(true);
      }
      // 执行注入片段(取到 errorDiagnostic 声明结尾):面板侧跑的必须就是模块侧同一份实现。
      // 这是对「单源」的行为级断言——抄第二份手写表/改一边不改另一边都会在这里炸。
      const start = html.indexOf("const ERR_TEXT={");
      const end = html.indexOf("};", html.indexOf("const errorDiagnostic=", start)) + 2;
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const snippet = html.slice(start, end);
      const factory = new Function(snippet + ";return {ERR_TEXT,errorText,errorDiagnostic};") as () => {
        ERR_TEXT: Record<string, string>;
        errorText: (code: unknown, message?: unknown) => string;
        errorDiagnostic: (code: unknown, message: unknown, sessionId?: unknown, traceId?: unknown) => string;
      };
      const browserSide = factory();
      for (const code of ERROR_CODE_VALUES) expect(browserSide.ERR_TEXT[code], code).toBe(ERR_TEXT[code]);
      expect(Object.keys(browserSide.ERR_TEXT).length).toBe(ERROR_CODE_VALUES.length);
      expect(browserSide.errorText("no-such-code", "原样")).toBe(errorText("no-such-code", "原样"));
      expect(browserSide.errorText(ErrorCode.HandlerCrash, "boom")).toBe(errorText(ErrorCode.HandlerCrash, "boom"));
      expect(browserSide.errorDiagnostic("board-invalid", "x", "s1", "t1")).toBe(errorDiagnostic("board-invalid", "x", "s1", "t1"));
      // 反向守卫:panel.ts 里不允许出现第二份错误文案表(只允许注入变量)
      expect(html).not.toContain("const ERR_TEXT2");
    });
  });

  it("②未知 code 走兜底文案;已登记 code 带上服务端原文", () => {
    const unknown = errorText("no-such-code-xyz", "服务端原样细节");
    expect(unknown.startsWith("未知错误(")).toBe(true);
    expect(unknown).toContain("no-such-code-xyz");
    expect(unknown).toContain("服务端原样细节");
    // 无 code:同样兜底,不返回空白
    expect(errorText("", "")).toContain("未知错误(");
    // 已登记 code:人话 + 原文细节(原文不丢,Q5 本地运行不脱敏)
    const known = errorText(ErrorCode.NotImplemented, "MCP 未启用");
    expect(known).toBe(ERR_TEXT[ErrorCode.NotImplemented] + " — MCP 未启用");
    expect(errorText(ErrorCode.HandlerCrash)).toBe(ERR_TEXT[ErrorCode.HandlerCrash]);
    // 原型链上的键不能被当成已登记 code(hasOwnProperty 守卫)
    expect(errorText("constructor", "x").startsWith("未知错误(")).toBe(true);
  });

  it("②'复制诊断摘要含 code/message/sessionId(+traceId 若存在)", () => {
    const noTrace = errorDiagnostic("board-invalid", "白板不合法", "s1");
    expect(noTrace.split(NL)).toEqual(["code: board-invalid", "message: 白板不合法", "sessionId: s1"]);
    const withTrace = errorDiagnostic("board-invalid", "白板不合法", "s1", "t-42");
    expect(withTrace).toContain("traceId: t-42");
    expect(errorDiagnostic(undefined, undefined, undefined)).toContain("code: (none)");
  });

  it("③error 帧 schema:登记码通过,未登记字符串仍放行(Q1 过渡 union)", () => {
    const frame = (code: string) => ({ v: 1, type: "error", code, message: "x" });
    // 登记码
    for (const code of ERROR_CODE_VALUES) expect(ErrorCodeSchema.safeParse(code).success, code).toBe(true);
    // 未登记字符串:过渡期放行(不炸旧调用点),但类型层面已收窄
    expect(ErrorCodeSchema.safeParse("legacy-unlisted-code").success).toBe(true);
    // 非字符串拒绝
    expect(ErrorCodeSchema.safeParse(123).success).toBe(false);
    expect(ErrorCodeSchema.safeParse(null).success).toBe(false);
    const ServerMessage = z.union([
      z.object({ v: z.literal(1), type: z.literal("error"), code: ErrorCodeSchema, message: z.string() }),
    ]);
    expect(ServerMessage.safeParse(frame(ErrorCode.InvalidMessage)).success).toBe(true);
    expect(ServerMessage.safeParse(frame("legacy-unlisted-code")).success).toBe(true);
  });

  it("③'线上字符串值不变:枚举值必须与改造前的裸串逐字一致(前端判串零漂移)", () => {
    // 面板/网关内联分支仍按这些字面量判串,枚举改名会静默打断展示链
    const frozen = [
      "invalid-message", "handler-crash", "not-implemented", "unknown-task",
      "board-invalid", "file-write-denied", "term-failed", "voice-unavailable",
      "plan-goal-mutex", "invalid-message", "models-list-failed", "cfg-set-failed",
      "sense-failed", "wiki-list-failed", "memory-failed", "issue-missing",
    ];
    for (const value of frozen) {
      expect(ERROR_CODE_VALUES as readonly string[]).toContain(value);
    }
  });
});
