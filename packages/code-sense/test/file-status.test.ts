/**
 * 文件级状态表(全覆盖):扫描面每个源文件都有去向,不再有「未解释的缺失」。
 *  - indexed:有符号;
 *  - symbol-less:已扫描且解析成功,但没有可索引的顶层声明(barrel/副作用脚本/测试用例);
 *  - skipped:解析守卫/结构档跳过(带原因);
 *  - error:装载失败(带原因)。
 * 同时校验 saveIndex 落 meta.json 的计数口径(scanned = indexed + symbolLess + skipped + error)。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildC2fIndex, saveIndex } from "../src/callgraph/c2f";
import { readIndexMeta } from "../src/callgraph/index-meta";

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "gh-filestatus-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("fileStatus 全覆盖(扫描面每文件一条去向)", () => {
  it("indexed / symbol-less / skipped 三态齐全,计数与扫描面闭合", async () => {
    const root = tmp();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "normal.ts"), "export function foo() { return 1; }\n");
    writeFileSync(join(root, "src", "barrel.ts"), 'export { foo } from "./normal";\n');
    writeFileSync(join(root, "src", "side-effect.ts"), 'console.log("boot");\n');
    // 压缩产物启发(单行 40KB → 平均行长 > 2000):解析守卫跳过
    writeFileSync(join(root, "src", "min.ts"), `export const X = "${"a".repeat(40_000)}";\n`);

    const idx = await buildC2fIndex(root);
    const st = idx.fileStatus!;
    expect(st["src/normal.ts"]?.status).toBe("indexed");
    expect(st["src/barrel.ts"]?.status).toBe("symbol-less");
    expect(st["src/side-effect.ts"]?.status).toBe("symbol-less");
    expect(st["src/min.ts"]?.status).toBe("skipped");
    expect(st["src/min.ts"]?.reason).toContain("压缩产物");
    // 扫描面闭合:每个被扫描文件都有状态
    expect(idx.srcCount).toBeGreaterThanOrEqual(4);
    expect(Object.keys(st).length).toBe(idx.srcCount);

    // meta 计数:scanned = indexed + symbolLess + skipped + error
    saveIndex(root, idx);
    const meta = readIndexMeta(root)!;
    const c = meta.fileStatus!;
    expect(c.scanned).toBe(Object.keys(st).length);
    expect(c.indexed + c.symbolLess + c.skipped + c.error).toBe(c.scanned);
    expect(c.indexed).toBeGreaterThanOrEqual(1);
    expect(c.symbolLess).toBeGreaterThanOrEqual(2);
    expect(c.skipped).toBeGreaterThanOrEqual(1);
  }, 60_000);
});