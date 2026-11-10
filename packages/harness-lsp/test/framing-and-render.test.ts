import { describe, it, expect } from "vitest";
import { decodeFrames } from "./helpers.js";
import { MessageDecoder, encodeMessage } from "../src/framing.js";
import { applyTextEdits } from "../src/format.js";
import { renderDiagnostics } from "../src/diagnose.js";
import type { DiagnosticItem } from "../src/types.js";

describe("LSP framing", () => {
  it("encode/decode 往返;分片到达按 Content-Length 拼回", () => {
    const a = encodeMessage({ jsonrpc: "2.0", id: 1, method: "initialize" });
    const b = encodeMessage({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: "file:///x", diagnostics: [] } });
    const joined = Buffer.concat([a, b]);
    const decoder = new MessageDecoder(1024 * 1024);
    expect(decoder.push(joined.subarray(0, 7))).toEqual([]);
    const out = [...decoder.push(joined.subarray(7, 29)), ...decoder.push(joined.subarray(29))];
    expect(out).toHaveLength(2);
    expect((out[0] as { method: string }).method).toBe("initialize");
    expect((out[1] as { method: string }).method).toBe("textDocument/publishDiagnostics");
  });

  it("超上限消息拒绝(坏 server 不能吃穿内存)", () => {
    expect(() => new MessageDecoder(8).push(Buffer.from("Content-Length: 9\r\n\r\n{}"))).toThrow(/exceeds/);
    expect(() => new MessageDecoder(8).push(Buffer.from("Content-Length: abc\r\n\r\n{}"))).toThrow(/invalid/);
  });

  it("helper 自检:测试自身解码可用", () => {
    const frames = decodeFrames(encodeMessage({ jsonrpc: "2.0", id: 2, result: null }));
    expect(frames).toEqual([{ jsonrpc: "2.0", id: 2, result: null }]);
  });
});

describe("applyTextEdits", () => {
  it("按位置倒序应用,多行偏移正确", () => {
    const text = "line1\nline2\nline3";
    const out = applyTextEdits(text, [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "L1" },
      { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } }, newText: "L3" },
    ]);
    expect(out).toBe("L1\nline2\nL3");
  });

  it("空编辑=原文", () => {
    expect(applyTextEdits("x", [])).toBe("x");
  });
});

describe("renderDiagnostics", () => {
  const d = (line: number, severity: DiagnosticItem["severity"], code: string | number, message: string): DiagnosticItem =>
    ({ line, column: 1, severity, code, message });

  it("缺省只回灌 ERROR;includeWarnings 才带 warning;排序;格式 L行:列 级别 码: 消息", () => {
    const items = [
      d(5, "error", "TS2322", "bad type"),
      d(2, "warning", "TS6133", "unused"),
      d(9, "hint", "H1", "noise"),
      d(1, "info", "I1", "noise2"),
    ];
    expect(renderDiagnostics("src/a.ts", items, 20)).toBe('<diagnostics file="src/a.ts">\nL5:1 error TS2322: bad type\n</diagnostics>');
    expect(renderDiagnostics("src/a.ts", items, 20, { includeWarnings: true })).toBe(
      '<diagnostics file="src/a.ts">\nL2:1 warning TS6133: unused\nL5:1 error TS2322: bad type\n</diagnostics>',
    );
  });

  it("无 error=null(不追加文本);超上限注明", () => {
    expect(renderDiagnostics("a.ts", [d(1, "hint", "H", "x")])).toBeNull();
    const block = renderDiagnostics("a.ts", [d(1, "error", "E1", "a"), d(2, "error", "E2", "b"), d(3, "error", "E3", "c")], 2);
    expect(block).toContain("…(+1 more)");
  });
});
