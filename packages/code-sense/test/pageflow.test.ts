import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeSense } from "../src/index";
import { pageFlow, parseReactRoutes } from "../src/pageflow/index";

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "gh-ui-"));
  mkdirSync(join(dir, "pages"), { recursive: true });
  writeFileSync(join(dir, "index.html"), [
    '<a href="about.html">关于</a>',
    '<button onclick="go()">去设置</button>',
    '<script>function go(){ location.href = "settings.html"; }',
    'fetch("/api/tasks", {method:"POST"});</script>',
  ].join("\n"));
  writeFileSync(join(dir, "about.html"), '<a href="index.html">首页</a>');
  return dir;
}

describe("D14 纯 HTML 页面流", () => {
  it("navigates/external/submits 边,evidence 指 html 行号", async () => {
    const dir = fixture();
    const r = await pageFlow(dir, ["index.html", "about.html"]);
    expect(r.pages).toHaveLength(2);
    const kinds = r.edges.map((e) => e.kind);
    expect(kinds).toContain("navigates");
    expect(kinds).toContain("submits");
    const nav = r.edges.find((e) => e.to === "settings.html")!;
    expect(nav.trigger).toContain("跳转");
    expect(nav.tier).toBe("structural");
    expect(nav.evidence.line).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });
  it("code_sense(mode=ui) 接线", async () => {
    const dir = fixture();
    const r = await codeSense(dir, "页面跳转", { mode: "ui" });
    expect(r.pageflow).toBeTruthy();
    expect(r.pageflow!.edges.length).toBeGreaterThanOrEqual(3);
    expect(r.pageflow!.mermaid).toContain("flowchart TD");
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});

describe("D15 React fixture", () => {
  it("路由配置+<Link to> 抽出 navigates 边 tier=semantic", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-react-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/router.tsx"), [
      'const routes = [',
      '  { path: "/", element: <Home /> },',
      '  { path: "/settings", element: <Settings /> },',
      "];",
    ].join("\n"));
    writeFileSync(join(dir, "src/home.tsx"), '<Link to="/settings">设置</Link>\nexport function Home(){ return null }');
    const r = await parseReactRoutes(dir, ["src/router.tsx", "src/home.tsx"]);
    expect(r.pages.map((p) => p.route)).toEqual(["/", "/settings"]);
    const link = r.edges.find((e) => e.trigger === "<Link to>")!;
    expect(link.tier).toBe("semantic");
    expect(link.to).toBe("/settings");
    // 目标对照路由表解析(组合层)
    const full = await pageFlow(dir, ["src/router.tsx", "src/home.tsx"]);
    const resolved = full.edges.find((e) => e.trigger === "<Link to>")!;
    expect(resolved.to).toBe("src/router.tsx"); // /settings 已解析到路由定义页
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("D16 auto 判定 ui", () => {
  it("「页面跳转」query → ui 剖面", async () => {
    const dir = fixture();
    const r = await codeSense(dir, "页面跳转关系", {});
    expect(r.mode).toBe("ui");
    expect(r.autoDecision?.picked).toBe("ui");
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});

describe("ZC-5 入口脚本组件(Electron/Vite 多窗口形态)", () => {
  it("<script src> 解析为页面入口组件,外链跳过", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-ui-src-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "index.html"), [
      "<html><body>",
      '<script type="module" src="./src/main.tsx"></script>',
      '<script src="https://cdn.example.com/lib.js"></script>',
      "</body></html>",
    ].join("\n"));
    writeFileSync(join(dir, "src", "main.tsx"), "export function Main() { return null }\n");
    const r = await codeSense(dir, "页面流", { mode: "ui" });
    const page = r.pageflow?.pages.find((p) => p.file === "index.html");
    expect(page?.components).toEqual(["src/main.tsx"]);
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});
