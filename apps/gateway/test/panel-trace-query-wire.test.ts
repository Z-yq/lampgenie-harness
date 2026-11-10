/**
 * 轨迹数据面接线守卫(改写)。
 * 历史:轨迹曾是 status-widget.js 里的「#sw-trace 全屏浮层」,数据由服务端 `trace.query` 提供
 * (openTrace → sendTraceQuery → trace.query.result → renderTrace)。 把轨迹拆成面板内
 * 独立视图 #view-traj,唯一数据源改为前端已在场的 **histEvents(会话重放事件)**,零额外请求;
 * 前端消费者整段删除,服务端 `trace.query` 协议保留(本轮禁服务端改动)。
 * 因此本文件从「前端浮层接线」改为双向守卫:
 *   ① 前端净身:status-widget.js 不得再含 sw-trace / openTrace / renderTrace / traceState / sendTraceQuery;
 *   ② 协议保留:服务端 server.ts 的 trace.query 处理分支仍在(只删前端消费者,不删协议);
 *   ③ 新宿主契约:panel.ts 的泳道渲染只吃 histEvents(不引用 trace.query / summary)。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WIDGET = fileURLToPath(new URL("../src/assets/status-widget.js", import.meta.url));
const PANEL = fileURLToPath(new URL("../src/panel.ts", import.meta.url));
const SERVER = fileURLToPath(new URL("../src/server.ts", import.meta.url));

const widget = readFileSync(WIDGET, "utf8");
const panel = readFileSync(PANEL, "utf8");
const server = readFileSync(SERVER, "utf8");

describe("① 前端浮层已摘除", () => {
  it("status-widget.js 不含 sw-trace 浮层与全套函数", () => {
    for (const dead of ["sw-trace", "sw-open-trace", "openTrace", "renderTrace", "traceState", "sendTraceQuery", "pendingTraceQuery", "ensureTraceLayer", "debouncedTraceQuery"]) {
      expect(widget, "status-widget.js 仍残留已删符号:" + dead).not.toContain(dead);
    }
  });

  it("status-widget.js 不再发 trace.query、也不消费 trace.query.result(取数只经 PAGE 函数)", () => {
    expect(widget).not.toContain('"trace.query"');
    expect(widget).not.toContain("trace.query.result");
    // 反向守卫:widget 不得直读 histEvents(面板顶层 let 不是 window 属性,跨脚本读会 TDZ/静默回落)
    expect(widget).not.toContain("histEvents");
  });

  it("追踪统计仍保留(sw-bar/sw-card/轮询不动)", () => {
    expect(widget).toContain("task.list");
    expect(widget).toContain("trace.stats");
    expect(widget).toContain("session.status");
  });
});

describe("② 服务端 trace.query 协议保留(只删前端消费者)", () => {
  it("server.ts 仍有 trace.query 分支与回包", () => {
    expect(server).toContain('case "trace.query"');
    expect(server).toContain("trace.query.result");
  });
});

describe("③ 泳道宿主契约:只吃 histEvents", () => {
  it("panel.ts 泳道渲染函数以 events 入参,不引用 trace.query", () => {
    const start = panel.indexOf("function trajLaneHtml(");
    expect(start, "缺 trajLaneHtml(泳道渲染核心未迁入 panel.ts)").toBeGreaterThan(0);
    const seg = panel.slice(start, start + 2600);
    expect(seg).toContain("(events, mode)");
    expect(seg).not.toContain('"trace.query"');
    expect(seg).not.toContain("traceState");
    expect(seg).toContain('["tool", "message", "system"]');
  });

  it("刷新入口走 PAGE 函数:loadViewData('traj') → trajBoardRefresh", () => {
    expect(panel).toContain('if (name === "traj") { trajBoardInitDone = false; trajBoardRefresh(); }');
  });
});
