import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { servePanel } from "../src/panel.js";

/** IDE 媒体地基(2026-10-28 /ide/asset):Range(206/416/accept-ranges)+ 媒体类型白名单 + 沙箱不回归。
 *  - 范式抄 test/panel-attachments.test.ts 的 /uploads Range 用例(临时面板实例 + 真 HTTP 断言);
 *  - 项目根用临时目录(绝不在真实仓里造媒体文件),pid 固定 "vitest-ide";
 *  - 图片行为逐字不变(image/png + 无 Range 也带 accept-ranges),媒体(视频/音频)按后缀给 content-type。 */
const TMP_ROOT = mkdtempSync(join(tmpdir(), "genie-ide-asset-"));
const PID = "vitest-ide";
const PROJ = join(TMP_ROOT, PID);
mkdirSync(PROJ, { recursive: true });

const PORT = 7926;
const BASE = "http://127.0.0.1:" + PORT;
const panel = servePanel(PORT, () => { /* 不需要 WS */ }, {
  ideProjectRoot: (pid?: string) => (pid === PID ? PROJ : undefined),
});

afterAll(async () => {
  await panel.close();
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响判定 */ }
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const url = (rel: string, pid = PID) => BASE + "/ide/asset?path=" + encodeURIComponent(rel) + "&pid=" + pid;

/** 造真文件(媒体内容无所谓:这里锁的是路由行为,不是解码)。 */
function mk(name: string, size: number): void {
  writeFileSync(join(PROJ, name), Buffer.alloc(size, 7));
}
mk("shot.png", 8);
mk("clip.mp4", 64 * 1024);
mk("song.mp3", 4096);
mk("voice.wav", 2048);
mk("pod.m4a", 2048);
mk("web.webm", 2048);
mk("code.ts", 64);
mk("data.json", 64);
writeFileSync(join(PROJ, "evil.exe"), "MZ");
mkdirSync(join(PROJ, "sub"), { recursive: true });
writeFileSync(join(PROJ, "sub", "deep.mp4"), Buffer.alloc(1024, 1));

describe("/ide/asset:Range 支持(板 ide-m1)", () => {
  it("bytes=0-1023 → 206 + content-range;尾部 → 206;越界 → 416;无 Range → 200 + accept-ranges", async () => {
    await wait(120);
    const r1 = await fetch(url("clip.mp4"), { headers: { Range: "bytes=0-1023" } });
    expect(r1.status).toBe(206);
    expect(r1.headers.get("content-range")).toBe("bytes 0-1023/65536");
    expect(r1.headers.get("content-length")).toBe("1024");
    expect(r1.headers.get("accept-ranges")).toBe("bytes");
    expect((await r1.arrayBuffer()).byteLength).toBe(1024);

    const r2 = await fetch(url("clip.mp4"), { headers: { Range: "bytes=65530-" } });
    expect(r2.status).toBe(206);
    expect(r2.headers.get("content-range")).toBe("bytes 65530-65535/65536");
    expect((await r2.arrayBuffer()).byteLength).toBe(6);

    const r3 = await fetch(url("clip.mp4"), { headers: { Range: "bytes=999999-" } });
    expect(r3.status).toBe(416);
    expect(r3.headers.get("content-range")).toBe("bytes */65536");

    const r4 = await fetch(url("clip.mp4"));
    expect(r4.status).toBe(200);
    expect(r4.headers.get("accept-ranges")).toBe("bytes");
    expect(r4.headers.get("content-length")).toBe("65536");
    expect((await r4.arrayBuffer()).byteLength).toBe(65536);

    // 安全头不因 Range 分支丢失(CSP/nosniff 一律不动)
    expect(r1.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r1.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(r4.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("图片无 Range 行为逐字不变(image/png + 200),Range 也能拿到 206", async () => {
    await wait(120);
    const g = await fetch(url("shot.png"));
    expect(g.status).toBe(200);
    expect(g.headers.get("content-type")).toBe("image/png");
    expect((await g.arrayBuffer()).byteLength).toBe(8);
    const g2 = await fetch(url("shot.png"), { headers: { Range: "bytes=0-3" } });
    expect(g2.status).toBe(206);
    expect(g2.headers.get("content-range")).toBe("bytes 0-3/8");
  });
});

describe("/ide/asset:媒体类型白名单(板 ide-m2)", () => {
  it("mp4/mp3/wav/m4a/webm 各自 200 + 正确 content-type", async () => {
    await wait(120);
    const cases: Array<[string, string]> = [
      ["clip.mp4", "video/mp4"],
      ["web.webm", "video/webm"],
      ["song.mp3", "audio/mpeg"],
      ["voice.wav", "audio/wav"],
      ["pod.m4a", "audio/mp4"],
    ];
    for (const [name, mime] of cases) {
      const r = await fetch(url(name));
      expect(r.status, name).toBe(200);
      expect(r.headers.get("content-type"), name).toBe(mime);
      expect(r.headers.get("accept-ranges"), name).toBe("bytes");
    }
  });

  it("子目录内媒体同样可取(路径拼在项目根下)", async () => {
    await wait(120);
    const r = await fetch(url("sub/deep.mp4"));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("video/mp4");
  });

  it("negative:.ts/.json/.exe 仍 403,响应体含「仅图片/媒体」", async () => {
    await wait(120);
    for (const name of ["code.ts", "data.json", "evil.exe"]) {
      const r = await fetch(url(name));
      expect(r.status, name).toBe(403);
      expect(await r.text(), name).toContain("仅图片/媒体");
    }
  });

  it("negative:path=/etc/hostname、../../secret、含 .. 一律 403 且不读盘", async () => {
    await wait(120);
    const secrets = [join(TMP_ROOT, "secret.mp4"), join(TMP_ROOT, "secret.png")];
    for (const p of secrets) writeFileSync(p, "SECRET-DO-NOT-READ");
    // 系统路径(不在项目根、也不在白名单后缀)
    const d1 = await fetch(url("/etc/hostname"));
    expect(d1.status).toBe(403);
    expect(await d1.text()).toContain("仅图片/媒体");
    // 词法穿越:即便落到项目根外真实存在的媒体文件也拒
    const d2 = await fetch(url("../../secret.mp4"));
    expect(d2.status).toBe(403);
    // 项目根内回折(../ 出现在任意位置即拒)
    const d3 = await fetch(url("sub/../clip.mp4"));
    expect(d3.status).toBe(403);
    expect(await d3.text()).toContain("越界");
    // 绝对路径指向根外真媒体:join 归入项目根 → 404(不读盘、不回内容)
    const d4 = await fetch(url(secrets[0]));
    expect([403, 404]).toContain(d4.status);
    expect(await d4.text()).not.toContain("SECRET-DO-NOT-READ");
    // 软链逃逸:项目根内软链指向根外 → realpath 后不 in root → 403(平台不支持软链则跳过)
    try { symlinkSync(secrets[1], join(PROJ, "escape.png")); } catch (e) { /* 跳过 */ }
    if (existsSync(join(PROJ, "escape.png"))) {
      const d5 = await fetch(url("escape.png"));
      expect(d5.status).toBe(403);
      const body5 = await d5.text();
      expect(body5).toContain("项目根之外");
      expect(body5).not.toContain("SECRET-DO-NOT-READ");
    }
    // 缺 path / 项目不存在
    const e1 = await fetch(BASE + "/ide/asset?pid=" + PID);
    expect(e1.status).toBe(400);
    const e2 = await fetch(url("clip.mp4", "no-such-proj"));
    expect(e2.status).toBe(400);
  });
});

describe("/ide/asset:媒体层前端接线(板 ide-m3/m4,页面源码断言)", () => {
  it("骨架/显示映射/渲染分支/频谱 detach/坐标换算齐", async () => {
    await wait(120);
    const html = await (await fetch(BASE + "/")).text();
    expect(html).toContain('id="ideMedia"'); // 宿主层
    expect(html).toContain('media: "ideMedia"'); // ideBodyShow 映射
    expect(html).toContain("function ideMediaKind(");
    expect(html).toContain('t.mode === "media"'); // ideBodyRender 分支
    expect(html).toContain('<video controls preload="metadata"'); // 视频直连 /ide/asset
    expect(html).toContain("<audio controls");
    expect(html).toContain("window.IdeSpectrum.attach(");
    expect(html).toContain("window.IdeSpectrum.detach()");
    expect(html).toContain("function ideMediaDetach(");
    expect(html).toContain("function ideScreenScaleOf("); // 画布缩放换算(ideImgScreenScale 复用同源)
    expect(html).toContain("function ideMediaSeekTo(");
    // 画布坐标:点击/拖动只在频谱 canvas 上生效(先 closest("canvas") 才换算),滚轮也只在 canvas 上响应
    expect(html).toContain('e.target.closest("canvas")');
    expect(html).toContain('host.addEventListener("wheel"');
    expect(html).toContain("passive: false");
    // 媒体标签绝不再发 file.read:media 分支在 ideOpenFile 里先于 file.read 发包
    const iMedia = html.indexOf("const mk = ideMediaKind(rel)");
    const iRead = html.indexOf('type: "file.read", path: rel, full: true', iMedia);
    expect(iMedia).toBeGreaterThan(0);
    expect(iRead).toBeGreaterThan(iMedia);
    // 频谱资产引用(另一路 worker 产 assets/ide-spectrum.js;这里只锁引用,不锁文件内容)
    expect(html).toContain('/assets/ide-spectrum.js');
  });
});
