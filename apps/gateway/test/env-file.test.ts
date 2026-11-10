// .env 加载器:受控解析/不覆盖进程 env/注释与引号。
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile } from "../src/env-file.js";

describe("loadEnvFile", () => {
  it("解析 KEY=VALUE;注释/空行跳过;引号剥离", () => {
    const dir = mkdtempSync(join(tmpdir(), "envfile-"));
    try {
      const p = join(dir, ".env");
      writeFileSync(p, [
        "# coding 轨注释",
        "",
        "RELAY_URL=ws://127.0.0.1:7870",
        "QUOTED=\"hello world\"",
        "SINGLE='v'",
        "  SPACED =  trim me  ",
        "BAD LINE WITHOUT EQ",
        "=NOKEY",
        "1BAD=x",
      ].join("\n"));
      const env: Record<string, string> = {};
      const applied = loadEnvFile(p, env);
      expect(env.RELAY_URL).toBe("ws://127.0.0.1:7870");
      expect(env.QUOTED).toBe("hello world");
      expect(env.SINGLE).toBe("v");
      expect(env.SPACED).toBe("trim me");
      expect(applied.sort()).toEqual(["QUOTED", "RELAY_URL", "SINGLE", "SPACED"]);
      expect("BAD" in env).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("进程 env 已占用的键不覆盖;文件不存在返回空", () => {
    const dir = mkdtempSync(join(tmpdir(), "envfile2-"));
    try {
      const p = join(dir, ".env");
      writeFileSync(p, "A=from-file\nB=from-file\n");
      const env: Record<string, string> = { A: "from-process" };
      loadEnvFile(p, env);
      expect(env.A).toBe("from-process");
      expect(env.B).toBe("from-file");
      expect(loadEnvFile(join(dir, "missing.env"), env)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
