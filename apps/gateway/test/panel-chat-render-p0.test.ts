/**
 * chat-render-p0.spec.cjs 的 vitest 规范化 runner( P0-1..P0-5)。
 * 同 slate:spec 本体是 node 直跑的 chromium 探针(自带 PASS/FAIL 输出),且
 * `require("../../src/panel.ts")` 是 TS——node 直跑必须 `--import tsx`(gateway tsconfig rootDir=src
 * 不含 test/,vitest 内联 require 会崩)。故这里不 import spec,而是逐项子进程直跑(ITEM 环境变量选一项),
 * 断言退出码 0 且 stdout 无 "FAIL "。逐项隔离:一项的 DOM 副作用不影响下一项。
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = "/usr/bin/google-chrome";
const hasChrome = existsSync(CHROME);
// 无头浏览器缺席(如 CI 无 chrome)→ 整文件 skip 并如实标注原因,不伪装通过。
const maybe = hasChrome ? describe : describe.skip;

const gatewayDir = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // apps/gateway

function runSpec(item: string): string {
  let out = "";
  try {
    out = execFileSync(process.execPath, ["--import", "tsx", "test/ui/chat-render-p0.spec.cjs"], {
      cwd: gatewayDir,
      timeout: 120_000,
      encoding: "utf8",
      env: { ...process.env, ITEM: item },
    });
  } catch (e) {
    const err = e as { status?: number; signal?: string; stdout?: string; stderr?: string; message: string };
    throw new Error(
      `${item} 探针失败:status=${err.status} signal=${err.signal}\n` +
        `stdout 尾部:\n${String(err.stdout ?? "").slice(-3000)}\n` +
        `stderr 尾部:\n${String(err.stderr ?? "").slice(-1500)}\nmessage:${err.message.slice(0, 300)}`,
    );
  }
  return out;
}

maybe("chat-render-p0.spec.cjs(node --import tsx 直跑 chromium 探针,逐项)", () => {
  const cases = ["P0-1", "P0-2", "P0-3", "P0-4", "P0-5"] as const;
  for (const item of cases) {
    it(`${item} 退出码 0 且 stdout 无 FAIL`, () => {
      const out = runSpec(item);
      expect(out, `${item} stdout 应至少有一条 PASS:\n` + out.slice(-2000)).toContain("PASS ");
      expect(out, `${item} stdout 应无 FAIL 行,实际:\n` + out.slice(-3000)).not.toContain("FAIL ");
    }, 150_000);
  }
});