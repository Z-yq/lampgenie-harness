/**
 * board-quality-card.spec.cjs 的 vitest 规范化 runner(骨架照抄 slash.spec.test.ts):
 * spec 本体是 node 直跑的 chromium 探针(自带 PASS/FAIL 输出,非 vitest 断言),且
 * `require("../../src/panel.ts")` 是 TS——node 直跑必须 `--import tsx`。
 * 故本文件不 import spec,而是子进程直跑它,断言退出码 0 且 stdout 无 "FAIL "。
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = "/usr/bin/google-chrome";
const hasChrome = existsSync(CHROME);
// 无头浏览器缺席(如 WSL/CI 无 chrome 环境)→ 整文件 skip 并如实标注原因,不伪装通过。
const maybe = hasChrome ? describe : describe.skip;

maybe("board-quality-card.spec.cjs(node --import tsx 直跑 chromium 探针)", () => {
  it("退出码 0 且 stdout 无 FAIL", () => {
    const gatewayDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."); // apps/gateway
    let out = "";
    try {
      out = execFileSync(process.execPath, ["--import", "tsx", "test/ui/board-quality-card.spec.cjs"], {
        cwd: gatewayDir,
        timeout: 120_000,
        encoding: "utf8",
      });
    } catch (e) {
      const err = e as { status?: number; signal?: string; stdout?: string; message: string };
      // spec 内 check() 失败→exit 1 且输出带 "FAIL <名>";环境崩(超时/找不到 chrome)→signal/message。
      throw new Error(
        `board-quality-card.spec.cjs 失败:status=${err.status} signal=${err.signal}\n` +
        `stdout 尾部:\n${String(err.stdout ?? "").slice(-3000)}\nmessage:${err.message.slice(0, 300)}`,
      );
    }
    expect(out, "stdout 应无 FAIL 行,实际:\n" + out.slice(-3000)).not.toContain("FAIL ");
  }, 150_000);
});
