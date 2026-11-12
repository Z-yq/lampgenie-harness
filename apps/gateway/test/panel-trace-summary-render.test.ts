/**
 * 轨迹「聚合摘要区」与「模型名可见」回归(真跑逻辑,不是字符匹配)。
 * 变更:轨迹从 status-widget.js 的全屏浮层 + 服务端 trace.query.summary,
 * 改为面板内独立视图 #view-traj,聚合摘要由**本会话 histEvents 现场聚合**(trajLaneSumHtml)。
 * 因此本文件从 panel.ts 抽取真实函数段求值(不再是 status-widget.js),验的是真身:
 * 若将来这段被重构/移动,这里会显式报「抽取失败」而不是静默通过。
 * 覆盖:事件分布(按 kind 降序前 5)、最慢工具(前 3 + 错误着色 + 错误计数)、
 * 空事件→空串(空态不占版面)、XSS 转义、shortModel 去前缀/截断、message.agent 模型名可见。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PANEL_SRC } from "./panel-source.js";

const SRC = PANEL_SRC;
const START = "function trajLaneShortModel(";
const END = "/** 三泳道 HTML";

function esc(s: unknown): string {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface Api {
  trajLaneRecord: (e: { kind: string; payload: unknown }) => { lane: string; label?: string; sub?: string; full?: string; err?: boolean } | null;
  trajLaneShortModel: (m: unknown) => string;
  trajLaneSumHtml: (events: unknown) => string;
}

/** 抽 panel.ts 里 trajLaneShortModel..trajLaneHtml 之前这段(recordOf/摘要/短模型名三者同域)。 */
function loadApi(): Api {
  const text = SRC;
  const i = text.indexOf(START);
  const j = text.indexOf(END);
  if (i < 0 || j < 0 || j <= i) throw new Error("抽取失败:panel.ts trajLaneShortModel..trajLaneHtml 段定位不到(函数被移动/重命名)");
  // eslint-disable-next-line no-new-func
  const factory = new Function("esc", `${text.slice(i, j)}\nreturn { trajLaneRecord: trajLaneRecord, trajLaneShortModel: trajLaneShortModel, trajLaneSumHtml: trajLaneSumHtml };`) as (e: typeof esc) => Api;
  return factory(esc);
}

const api = loadApi();

const T = (seq: number, kind: string, payload: unknown, time?: number) => ({ seq, kind, time: time === undefined ? seq * 10 : time, sessionId: "s1", payload });

describe("轨迹泳道聚合摘要(行为级:抽 panel.ts 真实代码段求值)", () => {
  it("事件分布按 kind 降序 + 最慢工具前 3(含错误着色与错误计数)", () => {
    const out = api.trajLaneSumHtml([
      T(1, "tool.result", { name: "bash", content: "ok", durationMs: 12345 }),
      T(2, "tool.result", { name: "grep", content: "错误:权限不足", durationMs: 4100 }),
      T(3, "tool.result", { name: "bash", content: "ok", durationMs: 900 }),
      T(4, "tool.result", { name: "read_file", content: "ok", durationMs: 300 }),
      T(5, "tool.result", { name: "edit_file", content: "ok", durationMs: 120 }),
      T(6, "message.agent", { text: "好" }),
      T(7, "message.user", { text: "改" }),
    ]);
    expect(out).toContain("事件分布");
    expect(out).toContain("最慢工具");
    expect(out).toContain("tool.result 5");
    // fmtMs:≥10000ms 只保留整数秒 → 12345ms 显示 12s;4100ms → 4.1s
    expect(out).toContain("12s");
    expect(out).toContain("4.1s");
    expect(out).toContain('class="err"'); // 有错误的工具带错误样式
    expect(out).toContain("工具错误 1 次");
    // 最慢工具只取前 3(bash/grep/bash → count 合并 → 第 3 位是 read_file,edit_file 落选)
    expect(out).not.toContain("edit_file");
  });

  it("空事件 → 空串(整区不占版面)", () => {
    expect(api.trajLaneSumHtml([])).toBe("");
    expect(api.trajLaneSumHtml(null)).toBe("");
  });

  it("负面:工具名/kind 含 HTML 时全部转义,不得出现可执行标签", () => {
    const out = api.trajLaneSumHtml([
      T(1, "<img src=x onerror=alert(1)>", {}),
      T(2, "tool.result", { name: "<script>alert(1)</script>", content: "ok", durationMs: 5 }),
    ]);
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;");
  });

  it("无工具事件时不空白:显式写「无工具事件」", () => {
    const out = api.trajLaneSumHtml([T(1, "message.user", { text: "hi" })]);
    expect(out).toContain("事件分布");
    expect(out).toContain("无工具事件");
  });
});

describe("轨迹泳道模型名可见(行为级)", () => {
  it("trajLaneShortModel:去厂商前缀 / 超 14 截 12 + … / 空值给空串", () => {
    expect(api.trajLaneShortModel("openai-compat/gpt-5.1")).toBe("gpt-5.1");
    expect(api.trajLaneShortModel("gpt-5")).toBe("gpt-5");
    expect(api.trajLaneShortModel("claude-sonnet-4-6-v2")).toBe("claude-sonne…");
    expect(api.trajLaneShortModel("abcdefghijklmn")).toBe("abcdefghijklmn");
    expect(api.trajLaneShortModel("")).toBe("");
    expect(api.trajLaneShortModel("   ")).toBe("");
    expect(api.trajLaneShortModel(undefined)).toBe("");
    expect(api.trajLaneShortModel(42 as unknown as string)).toBe("");
  });

  it("message.agent 带 model:副标题可见短名,完整名走 full(hover 用)", () => {
    const r = api.trajLaneRecord({ kind: "message.agent", payload: { text: "好的", llmMs: 2100, usage: { totalTokens: 1200 }, model: "openai-compat/gpt-5.1" } });
    expect(r?.lane).toBe("message");
    expect(r?.label).toContain("gpt-5.1");
    expect(r?.label).toContain("2.1s");
    expect(r?.sub).toContain("1200tok");
    expect(r?.full).toBe("openai-compat/gpt-5.1");
  });

  it("message.agent 无 model:label 不含空分隔符,full 不出现", () => {
    const r = api.trajLaneRecord({ kind: "message.agent", payload: { text: "好的", llmMs: 800 } });
    expect(r?.label).toBe("AI 800ms");
    expect(r?.full).toBeUndefined();
  });

  it("tool.call 与 tool.result 配对纪律:tool.call 不进泳道(返回 null)", () => {
    expect(api.trajLaneRecord({ kind: "tool.call", payload: { name: "x" } })).toBeNull();
  });
});
