/**
 * fileIndex 同步 walk 时间预算。
 * 9p/网络盘上全仓 walk 曾分钟级卡死事件循环(连接预热+首查同路径);
 * 预算尽=部分结果+短 TTL,后续调用继续长全——同步 API 与语义不变。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileIndex, fileIndexReset } from "../src/file-index.js";

let dir: string;

beforeEach(() => {
  fileIndexReset();
  dir = mkdtempSync(join(tmpdir(), "genie-fileidx-"));
  // 40 目录 × 10 文件 = 400 文件(足以让 0 预算走不完、大预算全量)
  for (let i = 0; i < 40; i++) {
    const sub = join(dir, "d" + String(i).padStart(2, "0"));
    mkdirSync(sub);
    for (let j = 0; j < 10; j++) writeFileSync(join(sub, "f" + j + ".ts"), "x");
  }
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("fileIndex 时间预算", () => {
  it("预算尽=部分结果且被标记;小预算结果 ⊆ 全量", () => {
    const partial = fileIndex(dir, 0); // 预算 0:立刻截断
    const full = (() => { fileIndexReset(); return fileIndex(dir, 60_000); })();
    expect(partial.length).toBeLessThan(full.length);
    for (const f of partial) expect(full).toContain(f);
    expect(full.length).toBe(400);
  });

  it("部分结果走短 TTL,过期后调用继续补全;完整结果走正常 TTL", () => {
    const first = fileIndex(dir, 0);
    expect(fileIndex(dir, 60_000)).toBe(first); // 短 TTL 内:命中部分缓存(引用相等)
    // 不等待真实 TTL——用 reset 模拟过期后的下一次调用
    fileIndexReset();
    const full = fileIndex(dir, 60_000);
    expect(full.length).toBe(400);
    expect(fileIndex(dir, 60_000)).toBe(full); // 完整缓存正常 TTL
  });

  it("GENIE_FILEINDEX_BUDGET_MS 缺省走 2s 预算(环境变量可覆盖)", () => {
    const before = process.env.GENIE_FILEINDEX_BUDGET_MS;
    process.env.GENIE_FILEINDEX_BUDGET_MS = "0";
    try {
      const partial = fileIndex(dir);
      expect(partial.length).toBeLessThan(400);
    } finally {
      if (before === undefined) delete process.env.GENIE_FILEINDEX_BUDGET_MS;
      else process.env.GENIE_FILEINDEX_BUDGET_MS = before;
    }
  });
});
