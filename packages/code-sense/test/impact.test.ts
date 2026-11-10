/**
 * impact 改动影响面查询测试(step-066):
 * ① 闭包正确性:链 midB→midA→coreUtil 的逐跳 dN 标注与深度截断;
 * ② 签名分节:新索引带 sig,renderSignature 输出参数与返回类型;
 * ③ 受影响文件:调用通道+import 通道双通道(纯 import 无调用边也入清单);
 * ④ 关联测试定位:直接(d1)/间接(dN)/import 通道三分列;
 * ⑤ 向后兼容:旧格式索引(无 sig/importers)不崩,对应分节显式降级;
 * ⑥ 深层封顶:d1 恒完整(A4 同语义),d≥2 每层 ≤24 且截断如实标注。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildC2fIndex, saveIndex, loadIndex, queryImpact, renderImpact, type C2fIndex } from "@lampgenie/code-sense";

let ws = "";
let index: C2fIndex;

beforeAll(async () => {
  ws = mkdtempSync(join(tmpdir(), "csimpact-"));
  mkdirSync(join(ws, "src"), { recursive: true });
  mkdirSync(join(ws, "test"), { recursive: true });
  writeFileSync(join(ws, "src", "core.ts"), [
    "export function coreUtil(x: number): string { return \"v\" + x; }",
    "export class Engine {",
    "  start(): void { this.stepOne(); }",
    "  stepOne(): void {}",
    "}",
    "",
  ].join("\n"));
  // app.ts import coreUtil 但只调用 Engine(纯 import 通道文件;new Engine 是 Engine 的调用边)
  writeFileSync(join(ws, "src", "app.ts"), [
    "import { coreUtil, Engine } from \"./core\";",
    "import { midB } from \"./mid\";",
    "export function mainApp(): void { midB(); }",
    "export function makeEngine(): Engine { return new Engine(); }",
    "export const unusedImport = typeof coreUtil;",
    "",
  ].join("\n"));
  writeFileSync(join(ws, "src", "mid.ts"), [
    "import { coreUtil } from \"./core\";",
    "export function midA(): string { return coreUtil(1); }",
    "export function midB(): string { return midA(); }",
    "",
  ].join("\n"));
  writeFileSync(join(ws, "test", "core.test.ts"), [
    "import { coreUtil } from \"../src/core\";",
    "export function testCoreUtil(): void { coreUtil(9); }",
    "",
  ].join("\n"));
  writeFileSync(join(ws, "test", "mid.test.ts"), [
    "import { midA } from \"../src/mid\";",
    "export function testMidA(): void { midA(); }",
    "",
  ].join("\n"));
  // 纯 import 通道的测试文件:import core.ts 但只经 Engine 间接触达(不构成 coreUtil 的调用边)
  writeFileSync(join(ws, "test", "engine.test.ts"), [
    "import { Engine } from \"../src/core\";",
    "export function testEngineStart(): void { const e = new Engine(); e.start(); }",
    "",
  ].join("\n"));
  saveIndex(ws, await buildC2fIndex(ws));
  index = loadIndex(ws)!;
}, 180_000);

afterAll(() => { rmSync(ws, { recursive: true, force: true }); }, 60_000);

describe("impact 闭包与签名", () => {
  it("双向闭包逐跳标注:d1 直接关系完整,d2 间接层带深度", () => {
    const r = queryImpact(index, "coreUtil", { depth: 2 });
    expect(r.definitions).toHaveLength(1);
    const d = r.definitions[0]!;
    // 上游:midA(d1) ← midB(d2);深度 2 截住 mainApp(d3)
    const callerNames = d.callers.map((c) => `${c.name}@d${c.depth}`);
    expect(callerNames).toContain("midA@d1");
    expect(callerNames).toContain("midB@d2");
    expect(callerNames.join(",")).not.toContain("mainApp");
    // 下游:coreUtil 是叶子,无下游
    expect(d.callees).toHaveLength(0);
    // 汇总计数
    expect(r.summary.directCallers).toBeGreaterThanOrEqual(2);
    expect(r.summary.transitiveCallers).toBeGreaterThanOrEqual(1);
  });

  it("签名分节:新索引带完整参数与返回类型", () => {
    const r = queryImpact(index, "coreUtil");
    expect(r.definitions[0]!.signature).toBe("(x: number): string");
  });

  it("方法签名与类圆心:Engine.start 拿到方法签名;闭包含同类 stepOne", () => {
    const r = queryImpact(index, "Engine.start");
    expect(r.definitions).toHaveLength(1);
    expect(r.definitions[0]!.signature).toBe("(): void");
    expect(r.definitions[0]!.callees.map((c) => c.name)).toContain("Engine.stepOne");
  });
});

describe("impact 受影响文件与关联测试", () => {
  it("双通道:调用通道(闭包触达)+import 通道(纯 import 无调用边)都在清单", () => {
    const r = queryImpact(index, "coreUtil", { depth: 2 });
    const files = new Map(r.files.map((f) => [f.file, f]));
    // src/mid.ts:midA 调 coreUtil → 调用通道
    expect(files.get("src/mid.ts")?.viaCall).toBe(true);
    // src/app.ts:import coreUtil 但无调用边 → 纯 import 通道
    expect(files.get("src/app.ts")?.viaImport).toBe(true);
    expect(files.get("src/app.ts")?.viaCall).toBe(false);
    // import 通道可用性
    expect(r.importChannel).toBe(true);
  });

  it("关联测试三分列:直接调用(d1)/间接(d2)/import 通道", () => {
    const r = queryImpact(index, "coreUtil", { depth: 2 });
    const direct = r.tests.filter((t) => t.via === "call" && t.depth === 1);
    const indirect = r.tests.filter((t) => t.via === "call" && t.depth > 1);
    const viaImport = r.tests.filter((t) => t.via === "import");
    expect(direct.map((t) => t.name)).toContain("testCoreUtil");     // test/core.test.ts 直接调
    expect(indirect.map((t) => t.name)).toContain("testMidA");       // test/mid.test.ts 经 midA(d2)
    // import 通道:test/engine.test.ts import core.ts 但对 coreUtil 无调用边(new Engine/e.start
    // 都连 Engine 类)→ 只能靠 import 通道发现
    expect(viaImport.map((t) => t.file)).toContain("test/engine.test.ts");
    expect(r.summary.testCount).toBe(r.tests.length);
  });
});

describe("impact 向后兼容(旧格式索引)", () => {
  it("剥离 sig/importers 后不崩:签名降级标注、import 通道关闭、调用通道照常", () => {
    const old: C2fIndex = JSON.parse(JSON.stringify(index)) as C2fIndex;
    for (const n of old.nodes) delete n.sig;
    delete old.importers;
    const r = queryImpact(old, "coreUtil", { depth: 2 });
    expect(r.definitions).toHaveLength(1);
    expect(r.definitions[0]!.signature).toBeUndefined();  // 签名降级(不假报)
    expect(r.importChannel).toBe(false);                  // import 通道关闭
    const files = new Map(r.files.map((f) => [f.file, f]));
    expect(files.get("src/mid.ts")?.viaCall).toBe(true);  // 调用通道照常
    expect(files.has("src/app.ts")).toBe(false);          // 纯 import 文件消失(通道没了,非假装在)
    const text = renderImpact(r);
    expect(text).toContain("签名: 未索引");
    expect(text).toContain("旧格式索引:import 通道不可用");
  });
});

describe("impact 深层封顶(d1 恒完整)", () => {
  it("35 个直接调用方 + 每个一层间接:depth=2 时 d1=35 全量、d2 封顶 24、truncated=true", async () => {
    const ws2 = mkdtempSync(join(tmpdir(), "csimpact2-"));
    mkdirSync(join(ws2, "src"), { recursive: true });
    const lines: string[] = ["export function hub(): number { return 1; }"];
    for (let i = 0; i < 35; i++) {
      lines.push(`export function direct${i}(): number { return hub() + ${i}; }`);
      lines.push(`export function parent${i}(): number { return direct${i}() + 1; }`);
    }
    writeFileSync(join(ws2, "src", "fan.ts"), lines.join("\n") + "\n");
    const idx2 = await buildC2fIndex(ws2);
    const r = queryImpact(idx2, "hub", { depth: 2 });
    expect(r.summary.directCallers).toBe(35);      // d1 完整,不被深层封顶回噬(A4)
    expect(r.summary.transitiveCallers).toBe(24);  // d2 每层封顶
    expect(r.truncated).toBe(true);
    const text = renderImpact(r);
    expect(text).toContain("直接 35 + 间接 24");
    expect(text).toContain("闭包深层每层 24 条封顶已截断");
    rmSync(ws2, { recursive: true, force: true });
  }, 120_000);
});

describe("renderSignature 与未命中", () => {
  it("未命中符号:definitions 空,不抛错", () => {
    const r = queryImpact(index, "no_such_symbol_xyz");
    expect(r.definitions).toHaveLength(0);
    expect(r.summary.directCallers).toBe(0);
  });

  it("renderImpact 汇总行含四通道计数", () => {
    const r = queryImpact(index, "coreUtil", { depth: 2 });
    const text = renderImpact(r);
    expect(text).toContain("改动影响面: coreUtil");
    expect(text).toContain("受影响文件(");
    expect(text).toContain("关联测试(");
    expect(text).toContain("汇总: 直接调用方");
  });
});
