/**
 * browser 工具(control-browser 对齐版)测试:
 * ① SPA 渲染等待(用户经验证回归,兼容旧 {action:"text",url} 形态);
 * ② 交互全链:open→snapshot(ref 清单)→act(fill/click/selectOption,ref 定位)→cua 坐标→shot→tabs;
 * ③ 门禁:域名白名单拒绝;ref 随导航过期提示;close 回收。
 * 本地起真 HTTP 服务 + 真 chromium(CHROME_PATH / /usr/bin/google-chrome)。
 */
import { describe, it, expect, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { createBrowserTool } from "../src/browser-tool.js";

let server: import("node:http").Server;
let port = 0;
const SPA_HTML = `<!DOCTYPE html><html><head><title>渲染测试页</title></head><body><div id="app"></div>
<script>setTimeout(function(){document.getElementById("app").innerText = "这是延迟渲染的白皮书正文内容,共一段用于验证等待逻辑生效";}, 800);</script></body></html>`;

/** 交互页:输入框(placeholder)/下拉/按钮(点击写结果区)/延迟正文——覆盖 act 与 cua 全形态。 */
const APP_HTML = `<!DOCTYPE html><html><head><title>交互测试页</title></head><body>
<h1>表单标题</h1>
<div id="app"></div>
<input id="name" placeholder="输入名字">
<select id="color"><option value="red">红</option><option value="blue">蓝</option></select>
<button id="go" onclick="document.getElementById('out').innerText='已提交:'+document.getElementById('name').value+'/'+document.getElementById('color').value">提交</button>
<a id="nav" href="/">回首页</a>
<div id="out"></div>
<script>setTimeout(function(){document.getElementById("app").innerText="延迟正文渲染完成";}, 400);</script>
</body></html>`;

const tool = createBrowserTool("/tmp", { enabled: () => true, allowDomains: () => ["127.0.0.1"] } as never);

/** 从 snapshot 文本行解析 ref:「e3 input "输入名字" @10,20」→ {ref:"e3", x:10, y:20} */
function parseElement(out: string, tagPattern: RegExp): { ref: string; x: number; y: number } | null {
  for (const line of out.split("\n")) {
    const m = line.match(/^e(\d+) (\S+).* @(\d+),(\d+)/);
    if (m && new RegExp(tagPattern).test(m[2]!)) return { ref: "e" + m[1], x: Number(m[3]), y: Number(m[4]) };
  }
  return null;
}

afterAll(async () => {
  await tool.execute({ action: "close", scope: "all" }).catch(() => {});
  await new Promise<void>((r) => server.close(() => r()));
});

describe("browser 工具", () => {
  it("SPA 渲染等待:旧形态 {action:text,url} 兼容,延迟正文等到(不再瞬断空页面)", async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(req.url === "/app" ? APP_HTML : SPA_HTML);
    });
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as { port: number }).port;
    const out = String(await tool.execute({ action: "text", url: `http://127.0.0.1:${port}/` }));
    expect(out).toContain("渲染测试页");
    expect(out).toContain("白皮书正文内容");
    expect(out).not.toContain("(空页面)");
  }, 30_000);

  it("交互全链:open→snapshot→act(fill/click/selectOption)→cua 坐标→shot→tabs", async () => {
    // ① open:拿 tabId+元素清单(同域 127.0.0.1 复用/新开均可,取返回的 tab)
    const opened = String(await tool.execute({ action: "open", url: `http://127.0.0.1:${port}/app` }));
    expect(opened).toContain("已打开");
    expect(opened).toMatch(/\[tab t\d+\]/);
    const tabId = opened.match(/\[tab (t\d+)\]/)![1]!;

    // ② snapshot:ref 清单里能找到 input/button/select
    const snap = String(await tool.execute({ action: "snapshot", tab: tabId }));
    expect(snap).toContain("交互测试页");
    const input = parseElement(snap, /^input$/);
    const button = parseElement(snap, /^button$/);
    const select = parseElement(snap, /^select$/);
    expect(input).toBeTruthy();
    expect(button).toBeTruthy();
    expect(select).toBeTruthy();

    // ③ act:ref 定位 fill 输入框 + selectOption 下拉 + click 提交 → 结果区联动
    const filled = String(await tool.execute({ action: "act", tab: tabId, ref: input!.ref, op: "fill", value: "精灵" }));
    expect(filled).toContain("fill ✓");
    const chosen = String(await tool.execute({ action: "act", tab: tabId, ref: select!.ref, op: "selectOption", label: "蓝" }));
    expect(chosen).toContain("selectOption ✓");
    const clicked = String(await tool.execute({ action: "act", tab: tabId, ref: button!.ref, op: "click" }));
    expect(clicked).toContain("click ✓");
    const after = String(await tool.execute({ action: "eval", tab: tabId, expr: "document.getElementById('out').innerText" }));
    expect(after).toContain("已提交:精灵/blue");

    // ④ cua 坐标路:snapshot 拿到的按钮中心坐标直接点(再提交一次,值不变仍应成功)
    const cuad = String(await tool.execute({ action: "cua", tab: tabId, op: "click", x: button!.x + 5, y: button!.y + 5 }));
    expect(cuad).toContain("cua click ✓");

    // ⑤ shot:截图落盘
    const shot = String(await tool.execute({ action: "shot", tab: tabId }));
    const path = shot.match(/截图已存:(\S+\.png)/)?.[1];
    expect(path).toBeTruthy();
    expect(existsSync(path!)).toBe(true);

    // ⑥ tabs:在场清单含本 tab
    const tabsOut = String(await tool.execute({ action: "tabs" }));
    expect(tabsOut).toContain(tabId);
    expect(tabsOut).toContain("交互测试页");
  }, 60_000);

  it("域名白名单:非白名单主机被拒(localhost ≠ 127.0.0.1)", async () => {
    const out = String(await tool.execute({ action: "open", url: `http://localhost:${port}/` }));
    expect(out).toContain("域名不在白名单");
  });

  it("ref 过期:act 触发页面导航后,旧 ref 提示重新 snapshot", async () => {
    const opened = String(await tool.execute({ action: "open", url: `http://127.0.0.1:${port}/app` }));
    expect(opened).toContain("交互测试页");
    const snap = String(await tool.execute({ action: "snapshot" }));
    const input = parseElement(snap, /^input$/);
    const link = parseElement(snap, /^a$/);
    expect(input).toBeTruthy();
    expect(link).toBeTruthy();
    // 点击链接 → 页面导航到 / → 旧 ref(来自 /app 快照)过期
    const clicked = String(await tool.execute({ action: "act", ref: link!.ref, op: "click" }));
    expect(clicked).toContain("页面已导航");
    const stale = String(await tool.execute({ action: "act", ref: input!.ref, op: "fill", value: "x" }));
    expect(stale).toContain("过期");
    expect(stale).toContain("snapshot");
  }, 30_000);

  it("close all:tab 回收,后续操作给出在场清单空提示", async () => {
    const out = String(await tool.execute({ action: "close", scope: "all" }));
    expect(out).toMatch(/已关闭全部 \d+ 个 tab/);
    const none = String(await tool.execute({ action: "snapshot" }));
    expect(none).toContain("无可用 tab");
  });
});
