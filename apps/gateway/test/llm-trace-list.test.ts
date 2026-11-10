/**
 * 丢事件自愈(2026-11):轨迹文件已落盘、journal 却没入账的 LLM 调用 → 合成行(synth)。
 *
 * 两块契约:
 *  ①纯函数 mergeSynthRows(从面板源码抽取,口径与 panel-usage-normalize.test.ts 一致):
 *    以 rows[].traceFile 为「已入账」集合,把 files 里多出来的调用插入并按 turn/step 重排;
 *  ②服务端 GET /api/llm-trace/list?sid=<sid>:列 call-*.json 元数据;目录不存在 → {ok:true,files:[]}(不 500);
 *    非法 sid 拒绝;单文件解析失败跳过(GENIE_REPO_ROOT 指向 tmpdir,不碰真实仓)。
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { servePanel } from "../src/panel.js";

const NL = String.fromCharCode(10);
const TMP = mkdtempSync(join(tmpdir(), "llm-trace-list-"));
const OLD_ROOT = process.env.GENIE_REPO_ROOT;

afterAll(() => {
  if (OLD_ROOT === undefined) delete process.env.GENIE_REPO_ROOT;
  else process.env.GENIE_REPO_ROOT = OLD_ROOT;
  try { rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 清理失败无关 */ }
});

/** 从面板 HTML 里切出顶层函数源码(花括号配平;与 panel-usage-normalize.test.ts 同口径)。 */
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

function loadMergeFn(html: string): (rows: unknown[], files: unknown[]) => any[] {
  const src = extractFn(html, "mergeSynthRows");
  // eslint-disable-next-line no-new-func
  return new Function(src + NL + "return mergeSynthRows;")() as (rows: unknown[], files: unknown[]) => any[];
}

const DIR = "/repo/.genie/llm-trace/sess-x";

/** 已入账行(journal 侧摘要形状)。 */
function row(i: number, turn: number, step: number, file: string): Record<string, unknown> {
  return {
    seq: 100 + i, idx: i, turn: turn, kind: "model", label: "claude-sonnet", summary: "t" + turn + "s" + step,
    durationMs: 1000, inputTokens: 1000 + i, cachedTokens: 900, outputTokens: 20, status: "ok",
    traceFile: file, stepNo: step, tools: [],
  };
}

/** 接口层文件元数据形状(= GET /api/llm-trace/list 的单条)。 */
function meta(i: number, turn: number, step: number, file: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    file: file, turn: turn, step: step, model: "claude-sonnet", durationMs: 1200 + i,
    usage: { inputTokens: 5000 + i, cachedTokens: 4000, outputTokens: 33 },
    responseHead: "第 " + i + " 次调用的响应开头",
    toolCalls: ["read_file"],
    ...over,
  };
}

describe("丢事件自愈:mergeSynthRows", () => {
  it("①21 行已入账 + 23 个文件 → 23 行、其中 2 行 synth,字段取自文件元数据", async () => {
    await withPanel(7977, (html) => {
      const merge = loadMergeFn(html);
      const rows: Record<string, unknown>[] = [];
      const files: Record<string, unknown>[] = [];
      for (let i = 1; i <= 21; i++) {
        const f = DIR + "/call-" + String(i).padStart(4, "0") + "-t" + (1 + Math.floor((i - 1) / 7)) + "s" + (((i - 1) % 7) + 1) + "-1.json";
        const turn = 1 + Math.floor((i - 1) / 7);
        const step = ((i - 1) % 7) + 1;
        rows.push(row(i, turn, step, f));
        files.push(meta(i, turn, step, f));
      }
      // 22/23:文件已落盘但 journal 未入账(turn 3 的 s2/s3)
      const f22 = DIR + "/call-0022-t3s2-2.json";
      const f23 = DIR + "/call-0023-t3s3-2.json";
      files.push(meta(22, 3, 2, f22));
      files.push(meta(23, 3, 3, f23));

      const out = merge(rows, files);
      expect(out.length).toBe(23);
      const synth = out.filter((r) => r && r.synth === true);
      expect(synth.length).toBe(2);
      const s1 = synth[0];
      expect(s1.traceFile).toBe(f22);
      expect(s1.turn).toBe(3);
      expect(s1.stepNo).toBe(2);
      expect(s1.kind).toBe("llm");
      expect(s1.label).toBe("claude-sonnet");
      expect(s1.summary).toBe("第 22 次调用的响应开头");
      expect(s1.inputTokens).toBe(5022);
      expect(s1.cachedTokens).toBe(4000);
      expect(s1.outputTokens).toBe(33);
      expect(s1.durationMs).toBe(1222);
      expect(Array.isArray(s1.tools) ? s1.tools[0] : null).toBe("read_file");
      expect(synth[1].traceFile).toBe(f23);
      expect(synth[1].stepNo).toBe(3);
      // 已入账行原样保留(不重复、不改数字),idx 按数组次序重排
      const kept = out.filter((r) => !r.synth);
      expect(kept.length).toBe(21);
      expect(kept[0].inputTokens).toBe(1001);
      for (let i = 0; i < out.length; i++) expect(out[i].idx).toBe(i + 1);
      // 排序:turn 升序、同 turn 内 step 升序;同 turn/step 时合成行排在已入账行之后
      const turn = 3;
      const keyOf = (r: any) => Number(r && r.turn) * 100 + Number(r && r.stepNo === undefined ? 99 : r.stepNo);
      for (let i = 1; i < out.length; i++) expect(keyOf(out[i])).toBeGreaterThanOrEqual(keyOf(out[i - 1]));
      const posS1 = out.findIndex((r) => r.traceFile === f22);
      const posRealT3S2 = out.findIndex((r) => !r.synth && Number(r.turn) === turn && Number(r.stepNo) === 2);
      expect(posRealT3S2).toBeGreaterThan(-1);
      expect(posS1).toBeGreaterThan(posRealT3S2);
      expect(Number(out[posS1].seq)).toBe(Number(out[posRealT3S2].seq)); // 合成行 seq 对齐相邻已入账行(剪枝卡/卡号对账)
      // 无新增文件(全部已入账)→ 原数组原样返回
      expect(merge(rows, files.slice(0, 21)).length).toBe(21);
      expect(merge(rows, []).length).toBe(21);
      expect(merge([], files).length).toBe(23);
    });
  }, 30_000);
});

describe("丢事件自愈:GET /api/llm-trace/list", () => {
  it("②列 call-*.json 元数据;目录不存在 → 空数组不 500;非法 sid 拒绝;坏文件跳过", async () => {
    process.env.GENIE_REPO_ROOT = TMP;
    const sid = "web:1";
    const dir = join(TMP, ".genie", "llm-trace", sid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "call-0001-t1s0-1.json"), JSON.stringify({
      ts: 1, sessionId: sid, turn: 1, step: 0, model: "claude-sonnet", durationMs: 1500,
      request: { messages: [] },
      response: { content: "改了 panel.ts 的汇总条", toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }], usage: { inputTokens: 56240, cachedTokens: 53376, outputTokens: 120 } },
    }));
    writeFileSync(join(dir, "call-0002-t1s1-2.json"), JSON.stringify({
      ts: 2, turn: 1, step: 1, model: "claude-sonnet", durationMs: 900, response: { content: "x".repeat(200), toolCalls: [] },
    }));
    writeFileSync(join(dir, "call-0003-broken.json"), "{ not json");
    writeFileSync(join(dir, "notes.txt"), "不是调用文件");

    await withPanel(7978, async () => {
      const ok = await fetch("http://127.0.0.1:7978/api/llm-trace/list?sid=" + encodeURIComponent(sid));
      expect(ok.status).toBe(200);
      const j = await ok.json();
      expect(j.ok).toBe(true);
      expect(j.files.length).toBe(2); // 坏文件/非 call-* 跳过
      const a = j.files[0];
      expect(a.file.endsWith("call-0001-t1s0-1.json")).toBe(true);
      expect(a.turn).toBe(1);
      expect(a.step).toBe(0);
      expect(a.model).toBe("claude-sonnet");
      expect(a.durationMs).toBe(1500);
      expect(a.usage).toEqual({ inputTokens: 56240, cachedTokens: 53376, outputTokens: 120 });
      expect(a.responseHead).toBe("改了 panel.ts 的汇总条");
      expect(a.toolCalls).toEqual(["read_file"]);
      const b = j.files[1];
      expect(String(b.responseHead).length).toBe(80); // responseHead 截 80
      expect(b.usage).toEqual({ inputTokens: 0, cachedTokens: 0, outputTokens: 0 });

      // 目录不存在 → 空数组,不是 500
      const none = await fetch("http://127.0.0.1:7978/api/llm-trace/list?sid=no-such-session");
      expect(none.status).toBe(200);
      const jn = await none.json();
      expect(jn.ok).toBe(true);
      expect(jn.files).toEqual([]);

      // 非法 sid:路径穿越 / 绝对路径 / 空 → 400
      for (const bad of ["..", "../../etc", "a/b", ""]) {
        const r = await fetch("http://127.0.0.1:7978/api/llm-trace/list?sid=" + encodeURIComponent(bad));
        expect(r.status, "非法 sid 应 400:" + bad).toBe(400);
      }
    });
  }, 30_000);

  it("③面板源码含 /api/llm-trace/list 接线,且合并结果参与渲染(源码级断言)", async () => {
    await withPanel(7979, (html) => {
      expect(html).toContain("/api/llm-trace/list?sid=");
      expect(html).toContain("function trajBoardSynthHeal");
      expect(html).toContain("mergeSynthRows(");
      expect(html).toContain("tb-synth");
      expect(html).toContain(".lt-sus");
    });
  }, 30_000);
});
