/**
 * 面板轨迹卡(J1 2026-11 token 轮)渲染测试:喂一条 task.trajectory 事件,验真身渲染出来的 HTML。
 *
 * 做法取自 panel-subagent-merge.test.ts 的同族手法:面板是单 HTML 模板字符串,浏览器侧函数在源码里,
 * 这里从 GET / 拿到的真实 HTML 中**抽取 trajCardHtml 函数源码**,用 new Function 求值后喂假 payload
 * —— 断言的是「真函数真渲染」,不是源码里有没有这几个字。
 *
 * 覆盖:summary 四要素(步数/工具类别数/并行百分比/错误数)、子目标+阶段行、工具分布 top6 归一、
 * token 曲线(polyline)、负面(无 phase/subgoal 时不出空行标记)。
 * 零反斜杠纪律:断言全用 includes 字面串。
 */
import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";

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

/** 面板侧 esc 同语义(抽取段依赖它,见 panel.ts 里 esc 定义)。 */
function escT(s: unknown): string {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function loadRenderer(html: string): (tp: unknown, series: unknown[]) => string {
  const src = extractFn(html, "trajCardHtml");
  // eslint-disable-next-line no-new-func
  return new Function("esc", src + String.fromCharCode(10) + "return trajCardHtml;")(
    escT,
  ) as (tp: unknown, series: unknown[]) => string;
}

describe("面板轨迹卡(J1):task.trajectory → 折叠画像卡", () => {
  it("summary 四要素 + 子目标/阶段行 + 工具分布 + token 曲线", async () => {
    await withPanel(7961, (html) => {
      const render = loadRenderer(html);
      const out = render({
        step: 12,
        steps: 12,
        calls: 20,
        tools: { read_file: 8, grep: 4, edit_file: 2 },
        parallelRate: 0.25,
        errors: 3,
        retries: 1,
        tokensSpent: 42_000,
        phase: "implement",
        subgoal: "改 e2e 断言",
      }, [
        { step: 4, tokensSpent: 10_000 },
        { step: 8, tokensSpent: 25_000 },
        { step: 12, tokensSpent: 42_000 },
      ]);
      // 卡片本体:折叠容器 + 标签
      expect(out).toContain('class="traj-line"');
      expect(out).toContain('class="tj-tag"');
      // 摘要行只留 标签/token/看板(用户反馈 2026-11-06:第 N 步·工具 N 类·并行%·错误 N 整行不需要)
      expect(out).not.toContain("tj-meta");
      expect(out).not.toContain("第 12 步");
      expect(out).not.toContain("工具 3 类");
      expect(out).not.toContain("并行 25%");
      expect(out).not.toContain("错误 3");
      // 保留项:标签 + token 三数 + 看板入口
      expect(out).toContain("入 42");
      expect(out).toContain('data-traj-open="1"');
      // 阶段 + 子目标一行
      expect(out).toContain("阶段 implement");
      expect(out).toContain("改 e2e 断言");
      // 工具分布:top 归一(read_file 8 → 100%,grep 4 → 50%,edit_file 2 → 25%)
      expect(out).toContain('class="traj-bar"');
      expect(out).toContain('width:100%');
      expect(out).toContain('width:50%');
      expect(out).toContain('width:25%');
      // token 曲线
      expect(out).toContain("<polyline points=");
      expect(out).toContain('width="260"');
      // 子目标行不是空标记时应带内容
      expect(out).toContain('class="tj-sub"');
    });
  }, 30_000);

  it("负面:无 phase/subgoal 时不出空行标记(tj-sub 整块不渲染)", async () => {
    await withPanel(7962, (html) => {
      const render = loadRenderer(html);
      const out = render({ step: 5, steps: 5, tools: { read_file: 5 }, parallelRate: 0, errors: 0, tokensSpent: 900 }, []);
      expect(out).toContain('class="traj-line"');
      expect(out).not.toContain('class="tj-sub"');
      // 子目标为空串时同样不出空行
      const out2 = render({ step: 6, steps: 6, tools: {}, parallelRate: 0, errors: 0, tokensSpent: 1_200, phase: "", subgoal: "" }, []);
      expect(out2).not.toContain('class="tj-sub"');
      // 无工具 → 不出空条带;单点曲线 → 不画(无曲线信息)
      expect(out2).not.toContain('class="traj-bars"');
      expect(out2).not.toContain("<polyline");
      // 四项摘要已删(2026-11-06 用户反馈),不再出现任何「工具 N 类」字样
      expect(out2).not.toContain("工具 0 类");
      expect(out2).not.toContain("tj-meta");
    });
  }, 30_000);

  it("接入点存在:会话流 if 链里有 task.trajectory 分支且在 tip.injected 之前", async () => {
    await withPanel(7963, (html) => {
      const iTraj = html.indexOf('ev.kind === "task.trajectory"');
      const iTip = html.indexOf('ev.kind === "tip.injected"');
      expect(iTraj).toBeGreaterThan(0);
      expect(iTip).toBeGreaterThan(0);
      expect(iTraj).toBeLessThan(iTip); // 轨迹卡不被 tips 折叠行吞掉
      expect(html).toContain("trajCardHtml(tj, trajSeries.slice())");
      // 累积序列在事件循环外声明(全量重渲/增量渲染两趟都完整)
      expect(html.indexOf("const trajSeries = [];")).toBeLessThan(iTraj);
      // CSS 与 tip-line 同族
      expect(html).toContain(".traj-line{");
      expect(html).toContain(".traj-line .traj-bar i{");
    });
  }, 30_000);
});
