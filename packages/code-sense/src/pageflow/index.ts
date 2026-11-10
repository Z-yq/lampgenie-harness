/**
 * pageflow( §6.5:路由表→组件树→交互边→意图解析。
 * 支持:React Router 配置对象/JSX <Link>/纯 HTML 多页;Vue Router(二期):
 * createRouter({routes}) 配置对象 + <router-link to> 边 + useRouter().push 编程式跳转。
 * tier:TSX=semantic / 纯 HTML=structural / 动态拼接=inferred。
 */
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";

/** 把 <script src> 相对引用解析为仓库相对路径(./ 与 ../ 词法归一;越出根的保留原样)。 */
function normalizeSrc(pageDir: string, src: string): string {
  return posix.normalize(pageDir ? posix.join(pageDir, src) : src);
}

export interface PageNode { id: string; route: string; file: string; components: string[] }
export interface PageEdge {
  from: string;
  kind: "navigates" | "opens-modal" | "submits" | "external";
  to: string;
  trigger: string;
  evidence: { path: string; line: number };
  tier: "semantic" | "structural" | "inferred";
}
export interface PageFlowResult {
  pages: PageNode[];
  edges: PageEdge[];
  mermaid: string;
  /** 路由层是否检出(SPA 无路由表→组件+事件图降级)。 */
  routerDetected: boolean;
}

/** 纯 HTML 多页 + <a href>/<form>/<button onclick+location>。structural 档。 */
export async function parseHtmlPages(root: string, files: string[]): Promise<PageFlowResult> {
  const pages: PageNode[] = [];
  const edges: PageEdge[] = [];
  for (const f of files.filter((x) => /\.(html?)$/.test(x))) {
    const text = await readFile(join(root, f), "utf-8").catch(() => "");
    if (!text) continue;
    const route = f.replace(/index\.html?$/, "").replace(/\.html?$/, "") || "/";
    // 入口脚本(Electron/Vite 多窗口常态):<script src="./src/main.tsx"> → 组件树的根,
    // 此前 components 恒空——ZCode 这类无路由 Electron 应用页面流只剩光秃秃的页面清单
    const components: string[] = [];
    const pageDir = f.split("/").slice(0, -1).join("/");
    for (const m of text.matchAll(/<script[^>]+src="([^"]+)"/g)) {
      const src = m[1]!;
      if (/^(https?:)?\/\//.test(src)) continue;
      const resolved = normalizeSrc(pageDir, src);
      if (/\.(tsx?|jsx?)$/.test(resolved) && !components.includes(resolved)) components.push(resolved);
    }
    pages.push({ id: f, route, file: f, components });
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // <a href="x.html">
      for (const m of line.matchAll(/<a[^>]+href="([^"#][^"]*)"/g)) {
        const href = m[1]!;
        edges.push({
          from: f, kind: href.startsWith("http") ? "external" : "navigates",
          to: href.replace(/^\.\//, ""),
          trigger: `链接[${line.match(/>([^<]{1,12})</)?.[1] ?? href}]`,
          evidence: { path: f, line: i + 1 },
          tier: "structural",
        });
      }
      // fetch(...) → submits
      if (/fetch\s*\(/.test(line)) {
        const url = /fetch\s*\(\s*["'`]([^"'`]+)/.exec(line)?.[1] ?? "(动态)";
        edges.push({
          from: f, kind: "submits", to: url,
          trigger: `fetch 调用`,
          evidence: { path: f, line: i + 1 },
          tier: url === "(动态)" ? "inferred" : "structural",
        });
      }
      // location.href= / window.open
      const nav = /(?:location\.href\s*=\s*|window\.open\s*\(\s*)["'`]([^"'`]+)/.exec(line);
      if (nav) {
        edges.push({
          from: f, kind: "navigates", to: nav[1]!,
          trigger: "编程式跳转",
          evidence: { path: f, line: i + 1 },
          tier: "structural",
        });
      }
    }
  }
  return { pages, edges, mermaid: toMermaid(pages, edges), routerDetected: pages.length > 0 };
}

/** TS/TSX:React Router 路由对象 + <Link to>/navigate() 调用。semantic 档。 */
export async function parseReactRoutes(root: string, files: string[]): Promise<PageFlowResult> {
  const pages: PageNode[] = [];
  const edges: PageEdge[] = [];
  for (const f of files.filter((x) => /\.[jt]sx?$/.test(x))) {
    const text = await readFile(join(root, f), "utf-8").catch(() => "");
    if (!text) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // path: "/x" + element/component (路由配置形态)
      const routeDef = /["'](\/[\w\-/:.]*)["']\s*,?\s*(?:element|component)/.exec(line)
        ?? /(?:path|route)\s*[=:]\s*["'](\/[\w\-/:.]*)["']/.exec(line);
      if (routeDef) {
        pages.push({ id: f, route: routeDef[1]!, file: f, components: [] });
      }
      // <Link to="/x">
      for (const m of line.matchAll(/<Link[^>]+to="([^"]+)"/g)) {
        edges.push({
          from: f, kind: "navigates", to: m[1]!,
          trigger: `<Link to>`,
          evidence: { path: f, line: i + 1 }, tier: "semantic",
        });
      }
      // navigate("/x") / router.push("/x")
      const nav = /(?:navigate|router\.push)\s*\(\s*["']([^"']+)/.exec(line);
      if (nav) {
        edges.push({
          from: f, kind: "navigates", to: nav[1]!,
          trigger: "编程式跳转",
          evidence: { path: f, line: i + 1 },
          tier: nav[1]!.includes("${") ? "inferred" : "semantic",
        });
      }
    }
  }
  return { pages, edges, mermaid: toMermaid(pages, edges), routerDetected: pages.length > 0 };
}

/** Vue:Vue Router 路由配置 + <router-link to> + useRouter.push(二期)。semantic 档。 */
export async function parseVueRoutes(root: string, files: string[]): Promise<PageFlowResult> {
  const pages: PageNode[] = [];
  const edges: PageEdge[] = [];
  for (const f of files.filter((x) => /\.[jt]sx?$|\.vue$/.test(x))) {
    const text = await readFile(join(root, f), "utf-8").catch(() => "");
    if (!text) continue;
    // .vue SFC 也收;路由配置出现在 js/ts(.vue 的 <script> 块少见含路由表,收进来无害)
    const lines = text.split("\n");
    let inRouter = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (/createRouter\s*\(/.test(line)) inRouter = true;
      // routes: [ { path: "/x", component: X } ](配置对象形态;嵌套缩进内 path 行都算)
      const routeDef = /(?<!\w)path\s*:\s*["'](\/[\w\-/:.]*)["']/.exec(line);
      if (routeDef && (inRouter || /routes/.test(lines.slice(Math.max(0, i - 30)).join("")))) {
        pages.push({ id: f, route: routeDef[1]!, file: f, components: [] });
      }
      if (inRouter && /]\s*\)\s*;?\s*$/.test(line) && !/path\s*:/.test(line)) inRouter = false;
 // <router-link to="/x">(to 绑定动态→inferred)
      for (const m of line.matchAll(/<router-link[^>]+:?to="([^"]+)"/g)) {
        const to = m[1]!;
        edges.push({
          from: f, kind: "navigates", to,
          trigger: "<router-link to>",
          evidence: { path: f, line: i + 1 },
          tier: to.includes("${") || /^\//.test(to) === false && /\$|\+/.test(to) ? "inferred" : "semantic",
        });
      }
      // useRouter().push("/x") / router.push("/x")
      const nav = /(?:router|Route)\.(?:push|replace)\s*\(\s*["'`]([^"'`]+)/.exec(line);
      if (nav) {
        edges.push({
          from: f, kind: "navigates", to: nav[1]!,
          trigger: "router.push 编程式跳转",
          evidence: { path: f, line: i + 1 },
          tier: nav[1]!.includes("${") ? "inferred" : "semantic",
        });
      }
    }
  }
  return { pages, edges, mermaid: toMermaid(pages, edges), routerDetected: pages.length > 0 };
}

/** 组合:HTML+React+Vue 同跑;目标 URL 对照路由表解析(动态→原样+inferred)。 */
export async function pageFlow(root: string, files: string[]): Promise<PageFlowResult> {
  const [html, react, vue] = await Promise.all([parseHtmlPages(root, files), parseReactRoutes(root, files), parseVueRoutes(root, files)]);
  const pages = [...html.pages, ...react.pages, ...vue.pages];
  const routeTable = new Map(pages.map((p) => [p.route, p.id]));
  const resolve = (e: PageEdge): PageEdge => {
    if (e.kind === "navigates" && routeTable.has(e.to)) {
      return { ...e, to: routeTable.get(e.to)! };
    }
    return e;
  };
  const edges = [...html.edges, ...react.edges, ...vue.edges].map(resolve);
  const dedup = [...new Map(edges.map((e) => [`${e.from}|${e.kind}|${e.to}|${e.trigger}|${e.evidence.line}`, e])).values()];
  return { pages, edges: dedup, mermaid: toMermaid(pages, dedup), routerDetected: html.routerDetected || react.routerDetected || vue.routerDetected };
}

function toMermaid(pages: PageNode[], edges: PageEdge[]): string {
  const lines = ["flowchart TD"];
  for (const p of pages) lines.push(`  ${safe(p.id)}["${p.route}"]`);
  for (const e of edges) {
    const arrow = e.tier === "inferred" ? "-.->" : "-->";
    lines.push(`  ${safe(e.from)} ${arrow}|${e.kind}: ${e.trigger}| ${safe(e.to)}`);
  }
  return lines.join("\n");
}

function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_");
}
