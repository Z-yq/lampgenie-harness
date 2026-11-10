import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryAppRoutes, renderAppRoutes } from "../src/pageflow/approutes";
import { codeSense } from "../src/index";

/** senseB22:app 路由画像单测(自写 switchView 族 SPA 的路由表提取)。 */

const FIXTURE = [
  "const PAGE = `<!doctype html><html><body>",
  "<div id=\"view-board\"></div>",
  "<div id=\"view-chat\" class=\"on\"></div>",
  "<script>",
  "function switchView(name) {",
  "  document.body.dataset.view = name;",
  "  if (name === \"board\") { boardRefresh(); overlayPull(); }",
  "  if (name === \"git\") gitLoad();",
  "  $(\"act-board\").onclick = () => switchView(\"board\");",
  "  function openAll() { switchView(\"board\"); }",
  "  function boardRefresh() { renderBoardCanvas(); }",
  "  function renderBoardCanvas() {}",
  "  function overlayPull() {}",
  "  function gitLoad() {}",
  "  openAll();",
  "}",
  "</script>",
  "</body></html>`;",
  "export function serve(): number { return 0; }",
  "",
].join("\n");

describe("senseB22 app 路由画像(queryAppRoutes)", () => {
  it("路由器/视图清单/打开函数/入口渲染函数全链提取", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-rt-"));
    try {
      writeFileSync(join(dir, "panel.ts"), FIXTURE);
      const r = await queryAppRoutes(dir, ["panel.ts"]);
      // 路由器:switchView(名字族 + dataset.view 体信号双命中)
      expect(r.router).toEqual({ name: "switchView", file: "panel.ts", line: 5 });
      // 视图清单:守卫字面量(board/git)∪ 调用点 ∪ id="view-*" 属性(chat)
      const views = r.routes.map((x) => x.view).sort();
      expect(views).toEqual(["board", "chat", "git"]);
      // 打开函数:act-board 触发(模块级接线在函数体内→enclosing=openAll? 接线在 switchView
      // 函数体内是 fixture 形态;真实 panel 在顶层。此处 openAll 是具名打开函数)
      const board = r.routes.find((x) => x.view === "board")!;
      expect(board.opens.length).toBeGreaterThan(0);
      expect(board.opens.some((o) => o.fn === "openAll" || o.fn === "(模块级)")).toBe(true);
      // 入口渲染:守卫分支内调用(boardRefresh/overlayPull;不含路由器自身/DOM 噪声)
      expect(board.entries.map((e) => e.name).sort()).toEqual(["boardRefresh", "overlayPull"]);
      // 入口函数行号=定义行(boardRefresh 定义在 fixture 第 11 行)
      expect(board.entries.find((e) => e.name === "boardRefresh")!.line).toBe(11);
      const git = r.routes.find((x) => x.view === "git")!;
      expect(git.entries.map((e) => e.name)).toEqual(["gitLoad"]);
      // 渲染文本面:路由器行 + 视图 + 入口
      const text = renderAppRoutes(r);
      expect(text).toContain("switchView @ panel.ts:5");
      expect(text).toContain("board");
      expect(text).toContain("boardRefresh:11");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("无路由器:显式降级,不猜", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-rt2-"));
    try {
      writeFileSync(join(dir, "plain.ts"), "const T = `<script>function a() { b(); }</script>`;\n");
      const r = await queryAppRoutes(dir, ["plain.ts"]);
      expect(r.router).toBeNull();
      expect(r.degraded.some((d) => d.includes("未检出路由器"))).toBe(true);
      const text = renderAppRoutes(r);
      expect(text).toContain("未检出路由器");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("ui mode 并入:codeSense(mode=ui) 返回 routes 画像", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-rt3-"));
    try {
      writeFileSync(join(dir, "panel.ts"), FIXTURE);
      const r = await codeSense(dir, "页面路由", { mode: "ui" });
      expect(r.mode).toBe("ui");
      expect(r.routes?.router?.name).toBe("switchView");
      expect(r.routes?.routes.some((x) => x.view === "board")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
