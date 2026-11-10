/**
 * /ide/asset `from=<md 相对路径>` 候选链契约测试。
 * 前端 md 预览不再预折叠 ../,改把 md 自身相对路径放进 from;服务端按
 * ①from 所在目录 + path ②项目根 + path ③path 绝对(仅根内) 逐候选 realpath + isPathInside,
 * 越界候选跳过(第一个越界不得否掉后续合法候选),全失败时越界者优先 403、否则 404。
 * 做法照抄 test/panel-ide-asset.test.ts:临时项目根 + 真 servePanel 实例 + 真 HTTP 断言。
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { servePanel } from "../src/panel.js";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "genie-ide-asset-from-"));
const PID = "vitest-ide-from";
const PROJ = join(TMP_ROOT, PID);
mkdirSync(join(PROJ, "docs", "sub"), { recursive: true });

// 同目录优先:docs/pic.png(111 字节)与根 pic.png(222 字节)内容长度不同即可区分
writeFileSync(join(PROJ, "docs", "x.md"), "# 文档\n");
writeFileSync(join(PROJ, "docs", "pic.png"), Buffer.alloc(111, 1));
writeFileSync(join(PROJ, "pic.png"), Buffer.alloc(222, 2));
writeFileSync(join(PROJ, "docs", "sub", "pic.png"), Buffer.alloc(333, 3));
writeFileSync(join(PROJ, "rootonly.png"), Buffer.alloc(44, 4));
// 项目根之外的媒体(绝对路径候选必须被根围栏拒)
writeFileSync(join(TMP_ROOT, "outside.png"), Buffer.alloc(55, 5));

const PORT = 7938;
const BASE = "http://127.0.0.1:" + PORT;
const panel = servePanel(PORT, () => { /* 不需要 WS */ }, {
  ideProjectRoot: (pid?: string) => (pid === PID ? PROJ : undefined),
});

afterAll(async () => {
  await panel.close();
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响判定 */ }
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 组 URL;参数顺序 path→from→pid(与前端 ideMdAssetUrl 同口径,便于 diff)。 */
const url = (rel: string, from?: string, pid = PID) =>
  BASE + "/ide/asset?path=" + encodeURIComponent(rel) + (from === undefined ? "" : "&from=" + encodeURIComponent(from)) + "&pid=" + pid;

describe("/ide/asset?from= 候选链", () => {
  it("①from 目录优先:path=pic.png&from=docs/x.md → docs/pic.png(111),不是根 pic.png(222)", async () => {
    await wait(120);
    const r = await fetch(url("pic.png", "docs/x.md"));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(Number(r.headers.get("content-length"))).toBe(111);
    expect((await r.arrayBuffer()).byteLength).toBe(111);
  });

  it("②from 目录无此文件 → 回退项目根:path=rootonly.png&from=docs/x.md → 200(44)", async () => {
    await wait(120);
    const r = await fetch(url("rootonly.png", "docs/x.md"));
    expect(r.status).toBe(200);
    expect(Number(r.headers.get("content-length"))).toBe(44);
  });

  it("②b 无 from(旧调用形态)→ 根相对解析不变:path=pic.png → 222", async () => {
    await wait(120);
    const r = await fetch(url("pic.png"));
    expect(r.status).toBe(200);
    expect(Number(r.headers.get("content-length"))).toBe(222);
  });

  it("③绝对路径(根内):path=<PROJ>/docs/sub/pic.png → 200(333)", async () => {
    await wait(120);
    const r = await fetch(url(join(PROJ, "docs", "sub", "pic.png"), "docs/x.md"));
    expect(r.status).toBe(200);
    expect(Number(r.headers.get("content-length"))).toBe(333);
  });

  it("③b from 子目录:path=sub/pic.png&from=docs/x.md → 200(333)", async () => {
    await wait(120);
    const r = await fetch(url("sub/pic.png", "docs/x.md"));
    expect(r.status).toBe(200);
    expect(Number(r.headers.get("content-length"))).toBe(333);
  });

  it("Windows 盘符形态 E:/x/y.png 不炸(非 500):落到 403/404", async () => {
    await wait(120);
    for (const p of ["E:/x/y.png", "E:\\x\\y.png"]) {
      const r = await fetch(url(p, "docs/x.md"));
      expect([403, 404], p).toContain(r.status);
      expect(await r.text(), p).not.toContain("ENOENT");
    }
  });

  it("负例:../../etc/passwd → 403;根外绝对媒体不外流;全不存在 → 404", async () => {
    await wait(120);
    const d1 = await fetch(url("../../etc/passwd", "docs/x.md"));
    expect(d1.status).toBe(403);
    // 根外绝对路径:候选①(根+path)不存在、候选③越界被否 → 按口径落 403/404,关键是绝不返回内容
    const d2 = await fetch(url(join(TMP_ROOT, "outside.png"), "docs/x.md"));
    expect([403, 404]).toContain(d2.status);
    expect(d2.headers.get("content-type") || "").not.toContain("image/png"); // 错误响应,绝不当图片流回
    expect(await d2.text()).not.toContain("outside.png");
    const d3 = await fetch(url("nope.png", "docs/x.md"));
    expect(d3.status).toBe(404);
    expect(await d3.text()).toContain("图片不存在");
    // 非图片/媒体后缀仍按白名单先拒(不受 from 影响)
    const d4 = await fetch(url("x.md", "docs/x.md"));
    expect(d4.status).toBe(403);
    // 缺 path / 项目不存在
    expect((await fetch(BASE + "/ide/asset?from=docs/x.md&pid=" + PID)).status).toBe(400);
    expect((await fetch(url("pic.png", "docs/x.md", "no-such-proj"))).status).toBe(400);
  });

  it("越界候选否不掉后续合法候选:docs 内软链出根 + 根内同名真文件 → 取根内真文件", async () => {
    await wait(120);
    const fs = await import("node:fs");
    writeFileSync(join(PROJ, "escape-link.png"), Buffer.alloc(66, 6));
    try { fs.symlinkSync(join(TMP_ROOT, "outside.png"), join(PROJ, "docs", "escape-link.png")); } catch (e) { /* 平台不支持软链则跳过 */ }
    if (!fs.lstatSync(join(PROJ, "docs", "escape-link.png")).isSymbolicLink()) return;
    // ①docs/escape-link.png 是软链(realpath 后根外)→ 跳过;②根内 escape-link.png 是真文件 → 200(66)
    const r = await fetch(url("escape-link.png", "docs/x.md"));
    expect(r.status).toBe(200);
    expect(Number(r.headers.get("content-length"))).toBe(66);
    // 无 from 时唯一候选就是那条软链 → 越界 → 403(既有口径不回归)
    const r2 = await fetch(url("escape.png", "docs/x.md"));
    expect([403, 404]).toContain(r2.status);
  });
});
