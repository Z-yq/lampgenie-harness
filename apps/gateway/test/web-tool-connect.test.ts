/**
 * 事故回归:web_search 打崩 session-worker。
 * 现场:未配搜索 provider → web_search 走 DuckDuckGo HTML 兜底 → 域名解析到本机
 * 无路由的 IPv6 → 旧 pinnedLookup 同步回调让 https 在 TLS 未装配好时同步建连,
 * setServername 抛 TypeError → 半建成 socket 泄漏 → 其 'error'(ENETUNREACH) 无人监听
 * → 进程级 uncaughtException → session-worker code=1,主 agent 与所有子代理一起被收尸。
 * 判定口径:子进程跑真实 fetchPublicPage,hostname + 注入不可达公网 IPv6(免 DNS 依赖,
 * 且必须走 lookup——IP 字面量覆盖不到缺陷):
 * ①错误以 WebToolError 收敛(RESULT:caught),②进程不得因未捕获异常退出
 * (exitCode=0,stderr 无 UNCAUGHT / uncaughtException / Emitted 'error')。
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const fixture = resolve(here, "fixtures/web-fetch-unreachable.ts");

function runFixture(timeoutMs = 25_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ["--import", "tsx", fixture], {
      cwd: pkgRoot,
      env: { ...process.env, NODE_OPTIONS: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (b: Buffer) => { out += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { out += b.toString(); });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveRun({ code: -1, out: out + "\n[test] timeout" });
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolveRun({ code, out });
    });
  });
}

describe("web_fetch/web_search 连接层:不可达地址不得打死进程", () => {
  it("不可达公网 IPv6 抓取 → WebToolError 收敛 + 子进程存活", async () => {
    const r = await runFixture();
    expect(r.out).toContain("RESULT:caught");
    expect(r.code).toBe(0);
  }, 40_000);

  it("负面断言:不出现进程级未捕获异常(UNCAUGHT / uncaughtException / Emitted 'error')", async () => {
    const r = await runFixture();
    expect(r.out).not.toContain("UNCAUGHT");
    expect(r.out).not.toContain("uncaughtException");
    expect(r.out).not.toContain("Emitted 'error' event");
  }, 40_000);
});
