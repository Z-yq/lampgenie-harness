import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const GATEWAY = join(HERE, "..", "..");
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const hasChrome = existsSync(CHROME);

// E2E:临时端口本地实例(不碰 7700),真实 trace 副本 + MemoryJournal 合成会话。
describe.skipIf(!hasChrome)("E2E 轨迹看板逐次决策", () => {
  it("卡片/默认展开/长正文不截断/思考截断/实时追加/0 pageerror", () => {
    const out = execFileSync(process.execPath, ["--import", "tsx", "test/ui/tracecards.spec.mjs"], {
      cwd: GATEWAY,
      timeout: 180_000,
      encoding: "utf8",
      env: { ...process.env, CHROME_BIN: CHROME, SELF_PORT: "7802" },
    });
    process.stdout.write(out);
    expect(out).not.toContain("FAIL ");
    expect(out).toContain("all checks passed");
  }, 200_000);
});
