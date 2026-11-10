/**
 * 任务卡进度段契约(panel 侧栏任务行):后端可选 task.progress = {phase?,step?,note?,at?}
 * 经 task.index 下发,前端 tasks Map 无类型 → 全防御式读取。零协议改动、零后端改动。
 * 取码 harness 照抄 panel-ide-deep.test.ts / panel.test.ts:servePanel 取真实面板 HTML,
 * extractFn 花括号配平切出函数源码,new Function 求值后按真实行为断言(不 mock DOM)。
 */
import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";

/** 从面板 HTML 里切出顶层函数源码(花括号配平)。 */
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
  const srv = servePanel(port, () => { /* 不需要 WS */ });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    return await fn(await res.text());
  } finally {
    await srv.close();
  }
}

/** 求值面板里的进度段 helper(依赖 esc + 阈值常量 + 停滞文案)。 */
function evalHelpers(html: string) {
  const src =
    "const esc = " + extractFn(html, "esc") + ";" +
    "const TP_STALL_MS = " + /const TP_STALL_MS = ([^;]+);/.exec(html)![1] + ";" +
    extractFn(html, "taskStallMin") + extractFn(html, "taskStallCn") +
    extractFn(html, "taskStallLevel") + extractFn(html, "taskProgressHtml") +
    extractFn(html, "taskMetaHtml") + extractFn(html, "stallAttr") + extractFn(html, "indicator") +
    "; return { taskProgressHtml, taskStallLevel, taskStallMin, taskMetaHtml, indicator };";
  return new Function(src)() as {
    taskProgressHtml: (t: unknown, now: number) => string;
    taskStallLevel: (t: unknown, now: number) => string;
    taskStallMin: (t: unknown, now: number) => number;
    taskMetaHtml: (t: unknown, now: number) => string;
    indicator: (t: unknown, now: number) => string;
  };
}

const NOW = 1_700_000_000_000;
const MIN = 60000;
const task = (extra: Record<string, unknown>) => ({ id: "t1", state: "running", title: "跑一下", ...extra });

describe("① 进度三段:阶段 / 第 N 步 / 停滞", () => {
  it("running + {phase:verify,step:3,at:now-5min} → 三段齐全且走 tp-warn(3≤5<10)", async () => {
    await withPanel(7898, (html) => {
      const h = evalHelpers(html);
      const out = h.taskProgressHtml(task({ progress: { phase: "verify", step: 3, at: NOW - 5 * MIN } }), NOW);
      expect(out).toContain("阶段 verify");
      expect(out).toContain("第 3 步");
      expect(out).toContain("停滞 5 分");
      expect(out).toContain(" · ");           // 分段连接符
      expect(out).toContain("tp-warn");       // 橙
      expect(out).not.toContain("tp-stall");
      expect(out.startsWith('<span class="t-progress ')).toBe(true);
    });
  });

  it("at=now-15min → tp-stall(红);at=now-1min → 无「停滞」字样且无额外色阶类", async () => {
    await withPanel(7899, (html) => {
      const h = evalHelpers(html);
      const stall = h.taskProgressHtml(task({ progress: { phase: "verify", at: NOW - 15 * MIN } }), NOW);
      expect(stall).toContain("停滞 15 分");
      expect(stall).toContain("tp-stall");
      expect(h.taskStallLevel(task({ progress: { at: NOW - 15 * MIN } }), NOW)).toBe("tp-stall");
      // 1 分钟 → 未到 3 分钟阈值:无停滞段,只剩阶段段且无色阶类
      const fresh = h.taskProgressHtml(task({ progress: { phase: "verify", at: NOW - MIN } }), NOW);
      expect(fresh).not.toContain("停滞");
      expect(fresh).not.toContain("tp-warn");
      expect(fresh).not.toContain("tp-stall");
      expect(fresh).toBe('<span class="t-progress">阶段 verify</span>');
    });
  });

  it("停滞 ≥60 分转小时且保留一位小数", async () => {
    await withPanel(7900, (html) => {
      const h = evalHelpers(html);
      const out = h.taskProgressHtml(task({ progress: { at: NOW - 72 * MIN } }), NOW);
      expect(out).toContain("停滞 1.2 小时");
      expect(out).toContain("tp-stall");
    });
  });
});

describe("② 状态门:仅 running/queued/blocked 有进度段", () => {
  it("state=done + 同样 progress → 逐字空串(旧行为不变)", async () => {
    await withPanel(7901, (html) => {
      const h = evalHelpers(html);
      const p = { phase: "verify", step: 3, at: NOW - 15 * MIN };
      expect(h.taskProgressHtml(task({ state: "done", progress: p }), NOW)).toBe("");
      expect(h.taskMetaHtml(task({ state: "done", progress: p }), NOW)).toBe("");
      // failed/cancelled/interrupted 同样零变化
      for (const st of ["failed", "cancelled", "interrupted"]) {
        expect(h.taskProgressHtml(task({ state: st, progress: p }), NOW)).toBe("");
        expect(h.taskMetaHtml(task({ state: st, progress: p }), NOW)).toBe("");
      }
    });
  });

  it("三态无 progress → 状态词兜底 排队中/运行中/阻塞中", async () => {
    await withPanel(7902, (html) => {
      const h = evalHelpers(html);
      expect(h.taskMetaHtml(task({ state: "running" }), NOW)).toBe('<span class="t-progress">运行中</span>');
      expect(h.taskMetaHtml(task({ state: "queued" }), NOW)).toBe('<span class="t-progress">排队中</span>');
      expect(h.taskMetaHtml(task({ state: "blocked" }), NOW)).toBe('<span class="t-progress">阻塞中</span>');
    });
  });
});

describe("③ 防御式读取:脏字段不抛错、零变化", () => {
  it("progress 缺席 / 非对象 → 空串;step 为字符串、at=NaN、at=0、at>now 安全降级", async () => {
    await withPanel(7903, (html) => {
      const h = evalHelpers(html);
      expect(h.taskProgressHtml(task({}), NOW)).toBe("");
      expect(h.taskProgressHtml(task({ progress: null }), NOW)).toBe("");
      expect(h.taskProgressHtml(task({ progress: "oops" }), NOW)).toBe("");
      expect(h.taskProgressHtml(undefined, NOW)).toBe("");
      // step 非数 → 只丢这一段
      expect(h.taskProgressHtml(task({ progress: { step: "abc" } }), NOW)).toBe("");
      expect(h.taskProgressHtml(task({ progress: { phase: "x", step: "abc" } }), NOW)).toBe('<span class="t-progress">阶段 x</span>');
      // at=NaN / at=0 → 无停滞段(不抛错)
      expect(() => h.taskProgressHtml(task({ progress: { at: NaN } }), NOW)).not.toThrow();
      expect(h.taskProgressHtml(task({ progress: { at: NaN } }), NOW)).toBe("");
      expect(h.taskProgressHtml(task({ progress: { at: 0 } }), NOW)).toBe("");
      // 未来时间戳 at>now → 不算停滞,不出现负数分钟
      const future = h.taskProgressHtml(task({ progress: { at: NOW + 10 * MIN } }), NOW);
      expect(future).toBe("");
      expect(future).not.toContain("-");
      // step 为负/0 → 丢段
      expect(h.taskProgressHtml(task({ progress: { step: 0 } }), NOW)).toBe("");
      expect(h.taskProgressHtml(task({ progress: { step: -2 } }), NOW)).toBe("");
      // now 非法 → 退回 Date.now(),不抛错
      expect(() => h.taskProgressHtml(task({ progress: { at: NOW - 15 * MIN } }), NaN)).not.toThrow();
    });
  });
});

describe("④ note 只作 title;emoji 门", () => {
  it("note 出现在 title 属性里,不出现在可见文本", async () => {
    await withPanel(7904, (html) => {
      const h = evalHelpers(html);
      const out = h.taskProgressHtml(task({ progress: { phase: "verify", step: 2, note: "等 CI 回执" } }), NOW);
      expect(out).toContain('title="等 CI 回执"');
      const visible = out.replace(/<span[^>]*>/, "").replace("</span>", "");
      expect(visible).not.toContain("等 CI 回执");
      expect(visible).toBe("阶段 verify · 第 2 步");
      // 无 note → 不带空 title
      expect(h.taskProgressHtml(task({ progress: { phase: "verify" } }), NOW)).not.toContain("title=");
    });
  });

  it("indicator:running 停滞 ≥10 分加 title/aria-label,<10 分与旧 DOM 逐字一致", async () => {
    await withPanel(7905, (html) => {
      const h = evalHelpers(html);
      expect(h.indicator(task({ progress: { at: NOW - 20 * MIN } }), NOW)).toBe(
        '<span class="t-dot running" title="停滞 20 分无进展" aria-label="停滞 20 分无进展"></span>',
      );
      // 未停滞 / 无 progress / 非 running → 与旧输出逐字一致
      expect(h.indicator(task({}), NOW)).toBe('<span class="t-dot running"></span>');
      expect(h.indicator(task({ progress: { at: NOW - MIN } }), NOW)).toBe('<span class="t-dot running"></span>');
      expect(h.indicator(task({ state: "queued", progress: { at: NOW - 20 * MIN } }), NOW)).toBe('<span class="t-dot queued"></span>');
      expect(h.indicator(task({ state: "failed" }), NOW)).toBe('<span class="t-dot failed"></span>');
      expect(h.indicator(task({ state: "done" }), NOW)).toBe('<span class="t-dot done"></span>');
    });
  });

  it("产物零 emoji(白名单口径同 panel.test.ts)", async () => {
    await withPanel(7906, (html) => {
      const h = evalHelpers(html);
      const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{2300}-\u{23FF}]/u;
      const ALLOW = new Set(["✓", "✗", "✕", "→", "←", "↑", "↓", "↵", "⇤", "⇥", "↳", "⎇", "■", "»", "…", "⚠", "☰", "♥", "⚙", "⌕", "⌄", "◇", "▶", "●", "▤", "◈", "▣", "✂"]);
      const outs = [
        h.taskProgressHtml(task({ progress: { phase: "verify", step: 3, note: "n", at: NOW - 15 * MIN } }), NOW),
        h.taskMetaHtml(task({ state: "queued" }), NOW),
        h.indicator(task({ progress: { at: NOW - 15 * MIN } }), NOW),
      ];
      const bad = outs.join("").split("").filter((ch) => EMOJI.test(ch) && !ALLOW.has(ch));
      expect(bad, "进度段含 emoji: " + [...new Set(bad)].join(" ")).toEqual([]);
    });
  });
});
