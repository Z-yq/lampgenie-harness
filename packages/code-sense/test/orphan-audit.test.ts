/**
 * orphan-audit 测试(设计稿 14.2):
 * 四类检测(孤独导出/仅测试接线/孤儿事件/双胞胎)+ 干净负例,临时目录全链路。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanOrphans, renderOrphans } from "../src/sensing/orphan-audit.js";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "orphan-audit-"));
  mkdirSync(join(root, "src"), { recursive: true });
 // lonely-export:导出后全仓零引用(且非入口文件)
  writeFileSync(join(root, "src", "lonely.ts"), "export function neverUsedAnywhere(x: number): number {\n  return x + 1;\n}\n");
 // 正常引用对照(非 lonely):被另一个生产文件消费
  writeFileSync(join(root, "src", "healthy.ts"), "export function usedEverywhere(): string {\n  return \"ok\";\n}\n");
  writeFileSync(join(root, "src", "consumer.ts"), "import { usedEverywhere } from \"./healthy.js\";\nexport function caller(): string {\n  return usedEverywhere();\n}\n");
 // test-only:只有测试文件引用
  writeFileSync(join(root, "src", "testonly.ts"), "export function onlyTested(a: string): string {\n  return a.trim();\n}\n");
  writeFileSync(join(root, "src", "testonly.test.ts"), "import { onlyTested } from \"./testonly.js\";\nit(\"works\", () => { expect(onlyTested(\" x \")).toBe(\"x\"); });\n");
 // twins:两个函数体逐行相同(体≥3 行归一化行;签名行不计入)
  writeFileSync(join(root, "src", "twin-a.ts"),
    "export function twinOne(v: number): number {\n  const doubled = v * 2;\n  const plus = doubled + 1;\n  return plus;\n}\n");
  writeFileSync(join(root, "src", "twin-b.ts"),
    "export function twinTwo(v: number): number {\n  const doubled = v * 2;\n  const plus = doubled + 1;\n  return plus;\n}\n");
 // 孤儿事件:emit 无监听 + on 无发出
  writeFileSync(join(root, "src", "bus.ts"), "export const bus = { handlers: new Map(), emit(n: string) {}, on(n: string, f: () => void) {} };\nexport function fire(): void {\n  bus.emit(\"orphan-happened\");\n  bus.on(\"never-emitted\", () => {});\n}\n");
 // 干净模块:唯一导出被仓内消费,零 finding 负例
  mkdirSync(join(root, "clean"), { recursive: true });
  writeFileSync(join(root, "clean", "mod.ts"), "export const VERSION = \"1.0.0\";\n");
  writeFileSync(join(root, "clean", "use.ts"), "import { VERSION } from \"./mod.js\";\nconst label = \"v\" + VERSION;\nconsole.log(label);\n");
});

afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* tmpdir 清理尽力 */ }
});

describe("scanOrphans(全仓形态,设计 14.2)", () => {
  it("lonely-export:零引用导出命中(按 title 定位),入口文件豁免", async () => {
    const r = await scanOrphans(root);
    const hit = r.findings.find((f) => f.kind === "lonely-export" && f.title.includes("neverUsedAnywhere"));
    expect(hit).toBeDefined();
    expect(hit!.file).toBe("src/lonely.ts");
  });

  it("test-only:引用全部来自测试文件命中", async () => {
    const r = await scanOrphans(root);
    const hit = r.findings.find((f) => f.kind === "test-only");
    expect(hit).toBeDefined();
    expect(hit!.title).toContain("onlyTested");
  });

  it("twins:函数体逐行相同的第二份命中并点名第一份", async () => {
    const r = await scanOrphans(root);
    const hit = r.findings.find((f) => f.kind === "twins");
    expect(hit).toBeDefined();
    expect(hit!.title).toContain("twin");
    expect(hit!.detail).toContain("twinOne");
  });

  it("orphan-event:emit 无监听 与 on 无发出 双向命中", async () => {
    const r = await scanOrphans(root);
    const events = r.findings.filter((f) => f.kind === "orphan-event");
    expect(events.some((e) => e.title.includes("orphan-happened"))).toBe(true);
    expect(events.some((e) => e.title.includes("never-emitted"))).toBe(true);
  });

  it("target 前缀收窄:clean 模块零 finding(导出被仓内消费)", async () => {
    const r = await scanOrphans(root, "clean");
    expect(r.findings.length).toBe(0);
    expect(r.scope).toContain("clean");
  });

  it("negative:被正常消费的导出不命中 lonely/test-only", async () => {
    const r = await scanOrphans(root);
    expect(r.findings.some((f) => f.title.includes("usedEverywhere"))).toBe(false);
    expect(r.findings.some((f) => f.title.includes("VERSION"))).toBe(false);
  });

  it("renderOrphans 文本含标题行与已知边界;knownLimits 恒在场", async () => {
    const r = await scanOrphans(root);
    const text = renderOrphans(r);
    expect(text).toContain("孤儿审计");
    expect(text).toContain("孤独导出");
    expect(text).toContain("已知边界");
    expect(r.knownLimits.length).toBeGreaterThan(0);
 // clean 负例路径:零发现文案
    const clean = renderOrphans(await scanOrphans(root, "clean"));
    expect(clean).toContain("零发现");
  });
});
