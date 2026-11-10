/**
 * 树刷新契约测试:dirCache 子树失效。
 * 背景:四个刷新入口(#ideRefresh / #sbFtRefresh / 命令面板「刷新文件树」/ 右键「刷新此目录」)
 * 原本只删根键,展开中的子目录缓存仍在 → 刷新后看不到新条目。
 * 覆盖:
 *  ①treeCacheKeysUnder 纯函数:根键/子键/兄弟键/remote 伪根/空 root/前缀陷阱(/a 不匹配 /ab)
 *  ②invalidateTreeCache 行为:清子树(含在飞 filesPending),兄弟与无关键保留
 *  ③静态断言:四个入口都调 invalidateTreeCache,#ideRefresh 与命令面板同时刷 SCM
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

/** 在隔离作用域里真跑树缓存两函数(注入 dirCache/filesPending)。 */
function loadTreeCache(html: string) {
  const src = extractFn(html, "treeCacheKeysUnder") + "\n" + extractFn(html, "invalidateTreeCache");
  const dirCache = new Map<string, unknown>();
  const filesPending = new Set<string>();
  const factory = new Function(
    "dirCache", "filesPending",
    src + "\nreturn { treeCacheKeysUnder, invalidateTreeCache };",
  ) as (d: Map<string, unknown>, p: Set<string>) => {
    treeCacheKeysUnder: (keys: Iterable<string>, rootAbs: string) => string[];
    invalidateTreeCache: (rootAbs: string) => void;
  };
  return { api: factory(dirCache, filesPending), dirCache, filesPending };
}

describe("树刷新:dirCache 子树失效", () => {
  it("①treeCacheKeysUnder:根键 + 后代键,兄弟与无关键不命中", async () => {
    await withPanel(7931, (html) => {
      const { api } = loadTreeCache(html);
      const keys = ["/p", "/p/a", "/p/a/b", "/p2", "/p2/x", "/p-ab", "/p/a2", "/other"];
      expect(api.treeCacheKeysUnder(keys, "/p")).toEqual(["/p", "/p/a", "/p/a/b", "/p/a2"]);
      // 前缀陷阱:/p 不得命中 /p2、/p-ab
      expect(api.treeCacheKeysUnder(keys, "/p")).not.toContain("/p2");
      expect(api.treeCacheKeysUnder(keys, "/p")).not.toContain("/p-ab");
      // 子目录为根:只清其子树
      expect(api.treeCacheKeysUnder(keys, "/p/a")).toEqual(["/p/a", "/p/a/b"]);
      // 空 root = 空集(不做全清)
      expect(api.treeCacheKeysUnder(keys, "")).toEqual([]);
      expect(api.treeCacheKeysUnder(keys, null as unknown as string)).toEqual([]);
    });
  });

  it("②remote 伪根键按字符串前缀匹配,不被本地 path 规范化破坏", async () => {
    await withPanel(7932, (html) => {
      const { api } = loadTreeCache(html);
      const keys = ["remote://pid1", "remote://pid1/src", "remote://pid1/src/a.ts", "remote://pid10", "remote://pid1x/y", "/local/p"];
      expect(api.treeCacheKeysUnder(keys, "remote://pid1")).toEqual(["remote://pid1", "remote://pid1/src", "remote://pid1/src/a.ts"]);
      expect(api.treeCacheKeysUnder("remote://pid1".split(""), "remote://pid1")).toEqual([]); // 非法入参不炸
    });
  });

  it("③invalidateTreeCache:清子树缓存与在飞标记,兄弟保留且展开态无关", async () => {
    await withPanel(7933, (html) => {
      const { api, dirCache, filesPending } = loadTreeCache(html);
      for (const k of ["/p", "/p/a", "/p/a/b", "/p2", "/p2/x"]) dirCache.set(k, []);
      for (const k of ["/p", "/p/a/b", "/p2/x"]) filesPending.add(k);
      api.invalidateTreeCache("/p");
      expect([...dirCache.keys()].sort()).toEqual(["/p2", "/p2/x"]);
      expect([...filesPending]).toEqual(["/p2/x"]);
      // 再刷一次空操作不抛
      api.invalidateTreeCache("/p");
      expect([...dirCache.keys()].sort()).toEqual(["/p2", "/p2/x"]);
    });
  });

  it("④四个刷新入口统一走 invalidateTreeCache,旧单键 delete 已消失", async () => {
    await withPanel(7934, (html) => {
      const calls = html.match(/invalidateTreeCache\(/g) || [];
      // 1 处定义 + 4 处调用
      expect(calls.length).toBeGreaterThanOrEqual(5);
      expect(html).toContain("function invalidateTreeCache(");

      // 入口一:IDE 刷新按钮(含 SCM 角标刷新)
      const ideBtn = html.match(/\$\("ideRefresh"\)\.onclick = [^\n]+/)?.[0] || "";
      expect(ideBtn).toContain("invalidateTreeCache(ideRoot.path)");
      expect(ideBtn).toContain("ideScmRefresh()");
      expect(ideBtn).toContain("ideTreeRender()");
      expect(ideBtn).not.toContain("dirCache.delete(");

      // 入口二:侧栏文件树滑入层
      const sbBtn = html.match(/\$\("sbFtRefresh"\)\.onclick = [^\n]+/)?.[0] || "";
      expect(sbBtn).toContain("invalidateTreeCache(sbFt.path)");
      expect(sbBtn).toContain("renderSbFt()");
      expect(sbBtn).not.toContain("dirCache.delete(");

      // 入口三:命令面板「刷新文件树」
      const cmd = html.match(/\{ id: "refresh", title: "刷新文件树"[^\n]+/)?.[0] || "";
      expect(cmd).toContain("invalidateTreeCache(ideRoot.path)");
      expect(cmd).toContain("ideScmRefresh()");
      expect(cmd).not.toContain("dirCache.delete(");

      // 入口四:右键「刷新此目录」
      const ctx = html.match(/\{ label: "刷新此目录"[^\n]+/)?.[0] || "";
      expect(ctx).toContain("invalidateTreeCache(abs)");
      expect(ctx).toContain('toast("已刷新 " + rel)');
      expect(ctx).not.toContain("dirCache.delete(");

      // 目录浏览器的「刷新」保持全清语义(dirCache.clear),不被本改动波及
      expect(html).toContain('$("filesRefresh").onclick = () => { dirCache.clear();');
    });
  });
});
