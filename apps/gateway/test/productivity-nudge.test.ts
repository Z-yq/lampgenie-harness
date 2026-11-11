/**
 * 修复验收:产出纪律硬提醒改走 reminder-source 的 productive-nudge 登记源,
 * 输出必须与旧字符串拼接**逐字节一致**(零行为变化),且失败回退仍产出旧完整串。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderSystemReminder } from "@lampgenie/runtime/agent/reminder-source";
import { buildProductiveNudge, PRODUCTIVE_NUDGE_STEPS, PRODUCTIVE_SUBSTANTIVE_CHARS } from "../src/llm-loop-backend";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const src = (rel: string): string => readFileSync(`${ROOT}${rel}`, "utf-8");

/** 旧实现逐字节 golden(原字符串拼接形态,原样保留作对照)。 */
const legacyNudge = (idleSteps: number): string =>
  "<system-reminder>[产出纪律] 已连续 " + idleSteps + " 步只调工具、未输出任何文本结论。"
  + "现在立刻用一段文字写出:①已完成什么(带 file:line 证据)②结论是什么 ③还差什么。"
  + "写完再决定是否继续查。禁止再开新勘察方向。</system-reminder>";

describe("productive-nudge:输出逐字节等价", () => {
  it("buildProductiveNudge 在 25/50/75/100 步上与旧拼接完全一致", () => {
    for (const n of [25, 50, 75, 100]) {
      expect(buildProductiveNudge(n), `idleSteps=${n}`).toBe(legacyNudge(n));
    }
  });

  it("与 renderSystemReminder(\"productive-nudge\", body, {inline:true, escapeNested:false}) 同源", () => {
    const full = legacyNudge(30);
    const body = full.slice("<system-reminder>".length, full.length - "</system-reminder>".length);
    expect(renderSystemReminder("productive-nudge", body, { inline: true, escapeNested: false })).toEqual({
      ok: true,
      text: buildProductiveNudge(30),
    });
  });

  it("body 里不含嵌套 reminder 标签(外层标签只由登记源产出一次)", () => {
    const text = buildProductiveNudge(25);
    expect(text.match(/<system-reminder>/g)?.length).toBe(1);
    expect(text.match(/<\/system-reminder>/g)?.length).toBe(1);
    expect(text.startsWith("<system-reminder>[产出纪律] ")).toBe(true);
    expect(text.endsWith("禁止再开新勘察方向。</system-reminder>")).toBe(true);
  });

  it("节奏与判据常量未动(25 步 / 200 字)", () => {
    expect(PRODUCTIVE_NUDGE_STEPS).toBe(25);
    expect(PRODUCTIVE_SUBSTANTIVE_CHARS).toBe(200);
  });
});

describe("productive-nudge:接线锚点", () => {
  const LOOPBACK_SRC = src("apps/gateway/src/llm-loop-backend.ts");

  it("llm-loop-backend 引入 reminder-source 并以 productive-nudge 源渲染", () => {
    expect(LOOPBACK_SRC).toContain('from "@lampgenie/runtime/agent/reminder-source"');
    expect(LOOPBACK_SRC).toContain('renderSystemReminder("productive-nudge", body, { inline: true, escapeNested: false })');
  });

  it("ok 分支用登记源文本,失败分支回退旧完整串(不 throw、不改行为)", () => {
    expect(LOOPBACK_SRC).toContain('return rendered.ok ? rendered.text : "<system-reminder>" + body + "</system-reminder>"');
  });

  it("旧的就地拼接已删(函数体不再以 <system-reminder> 字面量开头)", () => {
    expect(LOOPBACK_SRC).not.toContain('return "<system-reminder>[产出纪律] 已连续 " + idleSteps');
  });
});
