/**
 * 安装态 bin 符号链接主守卫回归。
 * npm/pnpm 安装后 .bin/codesense 是指向包内 dist/cli.js 的符号链接;
 * Node 对主入口默认 realpath 化 import.meta.url,而 argv[1] 保留链接路径——
 * isMainEntry 不做 realpath 比对时主守卫静默不触发(进程零输出 exit 0,
 * tarball 安装经验证注意:--help/version/garbage 全部静默 exit 0)。
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { isMainEntry } from "../src/serve.js";

describe("isMainEntry 符号链接形态", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("argv[1] 是指向真实入口的符号链接 → 仍判定为主入口", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs109-link-"));
    dirs.push(dir);
    const real = join(dir, "cli.js");
    writeFileSync(real, "// fixture\n");
    const link = join(dir, "codesense");
    symlinkSync(real, link);
    // 模拟 Node 主入口语义:import.meta.url=realpath,argv[1]=链接路径
    const metaUrl = pathToFileURL(real).href;
    const saved = process.argv[1];
    try {
      process.argv[1] = link;
      expect(isMainEntry(metaUrl)).toBe(true);
    } finally {
      process.argv[1] = saved;
    }
  });

  it("直路径形态不变(开发态 node dist/cli.js 回归锚)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs109-direct-"));
    dirs.push(dir);
    const real = join(dir, "cli.js");
    writeFileSync(real, "// fixture\n");
    const metaUrl = pathToFileURL(real).href;
    const saved = process.argv[1];
    try {
      process.argv[1] = real;
      expect(isMainEntry(metaUrl)).toBe(true);
    } finally {
      process.argv[1] = saved;
    }
  });

  it("无关路径不误判为主入口", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs109-other-"));
    dirs.push(dir);
    const real = join(dir, "cli.js");
    const other = join(dir, "other.js");
    writeFileSync(real, "// a\n");
    writeFileSync(other, "// b\n");
    const metaUrl = pathToFileURL(real).href;
    const saved = process.argv[1];
    try {
      process.argv[1] = other;
      expect(isMainEntry(metaUrl)).toBe(false);
    } finally {
      process.argv[1] = saved;
    }
  });
});
