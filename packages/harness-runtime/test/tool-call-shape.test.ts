/**
 * 工具调用参数历史定形单测:
 * edit_file 的大 new_string/old_string 在 message.agent 历史副本里被压成 head+tail+dump 指针,
 * 参数仍是合法 JSON;执行面原对象不动。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shapeToolCallsForHistory } from "../src/agent/tool-call-shape.js";

const big = (n: number, ch = "x") => ch.repeat(n);

describe("shapeToolCallsForHistory", () => {
  it("edit_file 大字段:new_string/old_string 定形,dump 落全文,控制字段不动", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shape-args-"));
    try {
      const call = {
        id: "c1", name: "edit_file",
        arguments: JSON.stringify({
          path: "src/a.ts", replace_all: false,
          old_string: big(10_000, "o"),
          new_string: big(20_000, "n"),
        }),
      };
      const originalArgs = call.arguments;
      const out = await shapeToolCallsForHistory([call], {
        budgetTokens: 500, dumpDir: dir, goal: "改 a.ts", sessionId: "s1", turn: 1, step: 2,
      });
      expect(out.records).toHaveLength(1);
      const shaped = JSON.parse(out.calls[0]!.arguments) as Record<string, unknown>;
      expect(shaped.path).toBe("src/a.ts"); // 控制字段原样
      expect(shaped.replace_all).toBe(false);
      expect(String(shaped.new_string).length).toBeLessThan(3_000);
 // old_string 是后续 edit 的匹配锚:不压(避免下一次编辑找不到原文)
      expect(String(shaped.old_string)).toBe(big(10_000, "o"));
      expect(shaped.new_string).not.toBe(big(20_000, "n"));
      const meta = shaped._shaped as { fields: Array<{ field: string; policy: string; dump?: string }> };
      expect(meta.fields.map((f) => f.field)).toEqual(["new_string"]);
      for (const f of meta.fields) {
        expect(f.dump).toBeTruthy();
        expect(existsSync(String(f.dump))).toBe(true);
      }
 // dump 内容是原文,不是定形版
      const nf = meta.fields.find((f) => f.field === "new_string")!;
      expect(readFileSync(String(nf.dump), "utf8")).toBe(big(20_000, "n"));
 // 原调用参数对象不被修改
      expect(call.arguments).toBe(originalArgs);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("低于阈值/无大字段:原引用返回(零改动)", async () => {
    const tiny = { id: "c2", name: "edit_file", arguments: JSON.stringify({ path: "a", new_string: "x" }) };
    const out = await shapeToolCallsForHistory([tiny], {
      budgetTokens: 500, goal: "g", sessionId: "s", turn: 1, step: 1,
    });
    expect(out.records).toHaveLength(0);
    expect(out.calls[0]).toBe(tiny);
  });

  it("14 个 edit_file 批量(各 4k 字符):历史参数总量压到步预算量级", async () => {
    const calls = Array.from({ length: 14 }, (_, i) => ({
      id: `c${i}`, name: "edit_file",
      arguments: JSON.stringify({ path: `src/f${i}.ts`, new_string: big(4_000, String.fromCharCode(97 + (i % 26))) }),
    }));
    const originalTotal = calls.reduce((a, c) => a + c.arguments.length, 0);
    const out = await shapeToolCallsForHistory(calls, {
 // 调用方按本步 1500 tok / 14 调用均分 → 每调用约 107 tok
      budgetTokens: Math.floor(1_500 / 14), goal: "批量编辑", sessionId: "s14", turn: 1, step: 1,
    });
    const shapedTotal = out.calls.reduce((a, c) => a + c.arguments.length, 0);
    expect(out.records).toHaveLength(14);
    expect(shapedTotal).toBeLessThan(originalTotal / 5); // 至少压到 1/5
    for (const c of out.calls) {
      const o = JSON.parse(c.arguments) as Record<string, unknown>;
      expect(o.path).toMatch(/^src\/f\d+\.ts$/); // 控制字段保留
      expect(o._shaped).toBeTruthy();
    }
  });

  it("无 dumpDir 也能定形:保留 head/tail + 未落盘标记,JSON 合法", async () => {
    const call = { id: "c3", name: "write_file", arguments: JSON.stringify({ path: "a.md", content: big(8_000, "z") }) };
    const out = await shapeToolCallsForHistory([call], {
      budgetTokens: 400, goal: "g", sessionId: "s", turn: 1, step: 3,
    });
    const shaped = JSON.parse(out.calls[0]!.arguments) as Record<string, unknown>;
    expect(String(shaped.content).length).toBeLessThan(2_000);
    expect(String(shaped.content)).toContain("参数已定形");
    expect(shaped._shaped).toBeTruthy();
  });
});