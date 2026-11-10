/**
 * step-1029:context.intake 面板最小渲染(tip-line)。
 * 形态:panel-artifact.test.ts 同款「从 PAGE 抽函数源码 + new Function 沙箱」,不起浏览器。
 * 断言只看用户点名的四项(时间/工具/原量→入上下文量/策略)与落盘路径是否呈现,不锁 HTML 细节。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { servePanel } from "../src/panel.js";

const NL = "\n";
function extractFn(html: string, name: string): string {
  const head = "function " + name + "(";
  const i = html.indexOf(head);
  expect(i, "未找到函数 " + name).toBeGreaterThan(0);
  let depth = 0, started = false, j = i;
  for (; j < html.length; j++) {
    const c = html[j];
    if (c === "{") { depth++; started = true; }
    else if (c === "}") { depth--; if (started && depth === 0) { j++; break; } }
  }
  return html.slice(i, j);
}
function escSrc(html: string): string {
  const i = html.indexOf("function esc(s)");
  expect(i, "未找到 esc").toBeGreaterThan(0);
  let depth = 0, started = false, j = i;
  for (; j < html.length; j++) {
    const c = html[j];
    if (c === "{") { depth++; started = true; }
    else if (c === "}") { depth--; if (started && depth === 0) { j++; break; } }
  }
  return html.slice(i, j);
}

let panel: { close: () => void };
let html = "";

beforeAll(async () => {
  panel = servePanel(7897, () => {});
  await new Promise((r) => setTimeout(r, 100));
  const res = await fetch("http://127.0.0.1:7897/");
  html = await res.text();
});
afterAll(() => { panel?.close(); });

describe("context.intake 面板渲染(tip-line)", () => {
  it("页面脚本里有 intake 取数与渲染函数,并挂在决策卡流里", () => {
    expect(html).toContain("function trajIntakeItems(");
    expect(html).toContain("function trajBoardIntakeCardHtml(");
    expect(html).toContain('e.kind === "context.intake"');
    expect(html).toContain("trajBoardState.intakes = trajIntakeItems(events)");
    expect(html).toContain("trajBoardIntakeCardHtml(intakes[ii].ev");
  });

  it("渲染出:工具 / 原量→入上下文量 / 策略 / 时间 + 落盘路径", () => {
    const fnSrc = [
      "const esc=" + escSrc(html) + ";",
      "function trajNumOrNull(v){ const n = Number(v); return Number.isFinite(n) ? n : null; }",
      "function fmtTokens(n){ return String(n); }",
      extractFn(html, "trajBoardIntakeCardHtml") + NL,
      "return trajBoardIntakeCardHtml;",
    ].join(NL);
    const render = new Function(fnSrc)() as (ev: unknown, n: number) => string;
    const out = render({
      seq: 42,
      time: 1_793_940_000_000,
      payload: {
        tool: "grep",
        chars: 30_137,
        keptChars: 4_587,
        digestChars: 0,
        chunks: 16,
        keptChunks: 3,
        droppedChunks: 13,
        policy: "chunk-select",
        scorer: "deterministic",
        durationMs: 12,
        dumpPath: "/repo/.genie/tool-dumps/call_00_abc-grep.txt",
      },
    }, 1);
    expect(out).toContain('class="tip-line"');
    expect(out).toContain("grep");
    expect(out).toContain("30137 → 4587 字符");
    expect(out).toContain("chunk-select");
    expect(out).toContain("call_00_abc-grep.txt");
    expect(out).toContain("切块 16 / 保留 3 / 筛掉 13");
  });

  it("dump 写失败 → 显式写「全文未能落盘」,不假装有路径", () => {
    const render = new Function([
      "const esc=" + escSrc(html) + ";",
      "function trajNumOrNull(v){ const n = Number(v); return Number.isFinite(n) ? n : null; }",
      extractFn(html, "trajBoardIntakeCardHtml") + NL,
      "return trajBoardIntakeCardHtml;",
    ].join(NL))() as (ev: unknown, n: number) => string;
    const out = render({
      seq: 7, time: 1_793_940_000_000,
      payload: { tool: "terminal", chars: 50_000, keptChars: 4_000, chunks: 9, keptChunks: 2, droppedChunks: 7, policy: "fallback", dumpError: "EACCES" },
    }, 1);
    expect(out).toContain("全文未能落盘");
    expect(out).toContain("EACCES");
  });
});
