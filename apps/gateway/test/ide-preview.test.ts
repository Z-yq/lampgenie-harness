/** step-1024(板 5a7bb5d2)节点 01/05:/ide/preview 静态预览沙箱路由 —— 白名单 MIME + no-store + 字节一致,
 *  以及负面守卫组(越界 404 / 白名单外 415 / >2MB 413 / 非 GET 404,均不返回文件内容)。
 *  路径形 URL(/ide/preview/<rel>?pid=…)是特性而非偶然:iframe 文档内 style.css/app.js 相对引用
 *  按文档 URL 解析天然回到本路由(query 形会解析成 /style.css——板风险 4)。风格照抄 office-ooxml.test.ts。
 *  跑法:cd apps/gateway && pnpm exec vitest run test/ide-preview.test.ts(负面组:-t 守卫)。 */
import { describe, it, expect, afterAll } from "vitest";
import { servePanel } from "../src/panel.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "idepreview-"));
const PROJ = join(TMP_ROOT, "proj");
const PID = "pv-spec";
mkdirSync(PROJ, { recursive: true });

const PORT = 7941;
const BASE = "http://127.0.0.1:" + PORT;
const panel = servePanel(PORT, () => { /* 不需要 WS */ }, {
  ideProjectRoot: (pid?: string) => (pid === PID ? PROJ : undefined),
});

afterAll(async () => {
  await panel.close();
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
});

const pvUrl = (rel: string, pid = PID) => BASE + "/ide/preview/" + pid + "/" + rel.split("/").map(encodeURIComponent).join("/");

describe("/ide/preview 静态预览:白名单 MIME + no-store + 字节一致", () => {
  it("html/css/js/svg 各自 MIME 正确;Cache-Control no-store;body 与磁盘字节一致(无注入包装)", async () => {
    const html = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><h1>标题</h1><script src="app.js"></script></body></html>';
    const css = "h1{color:red}";
    const js = "console.log('pv')";
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>';
    writeFileSync(join(PROJ, "index.html"), html, "utf-8");
    writeFileSync(join(PROJ, "style.css"), css, "utf-8");
    writeFileSync(join(PROJ, "app.js"), js, "utf-8");
    writeFileSync(join(PROJ, "icon.svg"), svg, "utf-8");
    await new Promise((r) => setTimeout(r, 120));

    const r1 = await fetch(pvUrl("index.html"));
    expect(r1.status).toBe(200);
    expect(r1.headers.get("content-type")).toContain("text/html");
    expect(r1.headers.get("cache-control")).toBe("no-store");
    expect(await r1.text()).toBe(html); // 磁盘字节原样(不注入脚本/不包装)

    const r2 = await fetch(pvUrl("style.css"));
    expect(r2.status).toBe(200);
    expect(r2.headers.get("content-type")).toContain("text/css");
    expect(r2.headers.get("cache-control")).toBe("no-store");
    expect(await r2.text()).toBe(css);

    const r3 = await fetch(pvUrl("app.js"));
    expect(r3.status).toBe(200);
    expect(r3.headers.get("content-type")).toContain("text/javascript");
    expect(await r3.text()).toBe(js);

    const r4 = await fetch(pvUrl("icon.svg"));
    expect(r4.status).toBe(200);
    expect(r4.headers.get("content-type")).toContain("image/svg+xml");
    expect(await r4.text()).toBe(svg);

    // 相对引用解析回归(板风险 4 闭环):文档 URL 为 /ide/preview/<pid>/index.html → style.css 相对解析
    // 保留 pid 路径前缀(相对解析不继承 query,故 pid 在路径段;真发请求且 200)
    const relUrl = new URL("style.css", new URL(pvUrl("index.html"))).toString();
    expect(relUrl).toContain("/ide/preview/" + PID + "/style.css");
    const rr = await fetch(relUrl);
    expect(rr.status).toBe(200);
    expect(await rr.text()).toBe(css);
  }, 30_000);
});

describe("/ide/preview 守卫(负面组)", () => {
  it("越界 ../ → 404;.git 段 → 404;.py/.exe → 415;>2MB → 413;POST → 404;均不返回文件内容", async () => {
    writeFileSync(join(PROJ, "guard.py"), "print('secret-py')\n", "utf-8");
    writeFileSync(join(PROJ, "tool.exe"), "MZsecret", "utf-8");
    mkdirSync(join(PROJ, ".git"), { recursive: true });
    writeFileSync(join(PROJ, ".git", "secret.html"), "<h1>SECRET</h1>", "utf-8");
    writeFileSync(join(PROJ, "big.html"), "B" + "x".repeat(2 * 1024 * 1024), "utf-8"); // 2097153B(>2MB 触发线)
    await new Promise((r) => setTimeout(r, 120));

    // 越界:..%2F 编码段(裸 ../../ 会被 URL 规范化掉根本到不了路由;编码后才真正打到沙箱判定)→ 404
    const esc1 = await fetch(BASE + "/ide/preview/" + PID + "/..%2F..%2Fetc%2Fpasswd");
    expect(esc1.status).toBe(404);
    expect(await esc1.text()).not.toContain("root:");
    // .git 段拒(路由把 403 统一落 404,不泄漏判定细节)→ 404 且不回内容
    const esc2 = await fetch(BASE + "/ide/preview/" + PID + "/.git%2Fsecret.html");
    expect(esc2.status).toBe(404);
    expect(await esc2.text()).not.toContain("SECRET");
    // 不存在的白名单内文件 → 404
    const miss = await fetch(pvUrl("missing.html"));
    expect(miss.status).toBe(404);
    // 白名单外后缀 → 415,不回文件内容
    const bad1 = await fetch(pvUrl("guard.py"));
    expect(bad1.status).toBe(415);
    expect(await bad1.text()).not.toContain("secret-py");
    const bad2 = await fetch(pvUrl("tool.exe"));
    expect(bad2.status).toBe(415);
    expect(await bad2.text()).not.toContain("MZsecret");
    // >2MB(2097153B)→ 413,不回文件内容
    const big = await fetch(pvUrl("big.html"));
    expect(big.status).toBe(413);
    expect((await big.text()).indexOf("xxxx")).toBe(-1);
    // 仅 GET:POST 落 404 且响应体为空(不返回文件内容)
    const post = await fetch(pvUrl("index.html"), { method: "POST" });
    expect(post.status).toBe(404);
    expect((await post.text()).length).toBe(0);
  }, 30_000);
});
