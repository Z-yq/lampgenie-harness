/**
 * 测试(096 评测缺口):
 * ③ RC-B3 关联测试跨深度通道:测试在 3 跳外(ValidateFlagGroups 形态)也能定位,
 *    标 beyondDepth 并单列「跨深度」组;「未发现」措辞带深度外未穷尽的诚实尾巴;
 * ⑤ RC-B5 弃边可见化:同名消歧弃边进索引 dropped 台账 → impact 渲染「弃边与不可见」段
 *    (数量+原因+样本)+ 同名多定义头进 impact 面;旧索引无台账字段=如实「旧索引无此字段」。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildC2fIndex, queryImpact, renderImpact, type C2fIndex } from "@lampgenie/code-sense";

let ws = "";
let index: C2fIndex;

beforeAll(async () => {
  ws = mkdtempSync(join(tmpdir(), "cs-099-"));
  mkdirSync(join(ws, "src"), { recursive: true });
  mkdirSync(join(ws, "test"), { recursive: true });
  // 链:target ← midB ← midA ← testDeep(d3 测试,096 ValidateFlagGroups 形态:
  // 专属测试经 Execute→execute→ValidateFlagGroups 3 跳触达,≤d2 闭包看不见)
  writeFileSync(join(ws, "src", "core.ts"), [
    "export function target(x: number): number { return x; }",
    "",
  ].join("\n"));
  writeFileSync(join(ws, "src", "mid.ts"), [
    "import { target } from \"./core\";",
    "export function midB(): number { return target(1); }",
    "export function midA(): number { return midB(); }",
    "",
  ].join("\n"));
  writeFileSync(join(ws, "test", "deep.test.ts"), [
    "import { midA } from \"../src/mid\";",
    "export function testDeep(): void { midA(); }",
    "",
  ].join("\n"));
  // d1 直接测试(对照组不被跨深度通道破坏)
  writeFileSync(join(ws, "test", "direct.test.ts"), [
    "import { target } from \"../src/core\";",
    "export function testDirect(): void { target(9); }",
    "",
  ].join("\n"));
  // 无测试孤立函数(「未发现」措辞锚)
  writeFileSync(join(ws, "src", "orphan.ts"), [
    "import { target } from \"./core\";",
    "export function orphanFn(): number { return target(0); }",
    "",
  ].join("\n"));
  index = await buildC2fIndex(ws);
}, 120_000);

afterAll(() => { rmSync(ws, { recursive: true, force: true }); }, 60_000);

describe(" RC-B3:关联测试跨深度通道", () => {
  it("3 跳外的专属测试被定位,标 beyondDepth,d1 直接测试语义不动", () => {
    const r = queryImpact(index, "target", { depth: 2 });
    const direct = r.tests.filter((t) => t.via === "call" && t.depth === 1 && !t.beyondDepth);
    const beyond = r.tests.filter((t) => t.beyondDepth);
    expect(direct.map((t) => t.name)).toContain("testDirect");      // d1 语义不动
    expect(beyond.map((t) => t.name)).toContain("testDeep");        // d3 跨深度补出(096 假阴性根治)
    expect(beyond[0]!.depth).toBe(3);
  });

  it("渲染四组分列:直接/间接/跨深度/import;跨深度行带标注", () => {
    const text = renderImpact(queryImpact(index, "target", { depth: 2 }));
    expect(text).toMatch(/关联测试\(\d+\):直接 \d+ \/ 间接 \d+ \/ 跨深度 \d+ \/ import 通道 \d+/);
    expect(text).toContain("(d3,跨深度) test/deep.test.ts");
  });

  it("「未发现」措辞:三通道全空时带深度外未穷尽尾巴,不再是无条件旧口径", () => {
    const text = renderImpact(queryImpact(index, "orphanFn", { depth: 2 }));
    expect(text).toContain("关联测试: 未发现");
    expect(text).toContain("跨深度延伸");
    expect(text).toContain("未穷尽");
    // 旧口径(096 判定为误导的原始形态)不再出现
    expect(text).not.toContain("闭包与 import 通道均无测试路径文件——改动不受测试直接保护");
  });
});

describe(" RC-B5:弃边可见化", () => {
  it("同名消歧弃边进索引台账(dropped),impact 渲染弃边段带数量+原因+同名头", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-099-drop-"));
    mkdirSync(join(dir, "m"), { recursive: true });
    // 两个同名 has_access 定义(has_access 锚形态)+ 一个裸名调用方(候选被消歧闸弃边)
    writeFileSync(join(dir, "m", "a.py"), [
      "def has_access(obj, user):",
      "    return True",
      "",
    ].join("\n"));
    writeFileSync(join(dir, "m", "b.py"), [
      "def has_access(obj, user):",
      "    return False",
      "",
    ].join("\n"));
    // 调用点在第三个文件:本文件无定义但有 import 证据(`from m.a import has_access`,
    // redash test_permissions.py 形态)→ 跨文件候选 → 2 定义非唯一弃边
    writeFileSync(join(dir, "m", "c.py"), [
      "from m.a import has_access",
      "",
      "def caller_site():",
      "    return has_access({}, None)",
      "",
    ].join("\n"));
    const idx = await buildC2fIndex(dir);
    // 台账落盘
    expect(idx.dropped).toBeDefined();
    const entry = idx.dropped!["has_access"];
    expect(entry).toBeDefined();
    expect(entry!.count).toBeGreaterThanOrEqual(1);
    expect(Object.keys(entry!.reasons).join(";")).toContain("同名候选非唯一");
    // impact 渲染:弃边段恒在场 + 数量与原因
    const text = renderImpact(queryImpact(idx, "has_access", { depth: 2 }));
    expect(text).toContain("弃边与不可见");
    expect(text).toMatch(/同名调用候选构建期被弃 \d+ 处/);
    expect(text).toContain("同名候选非唯一");
    // 同名多定义头进 impact 面(096:此前只在 symbol 面)
    expect(text).toContain("⚠ 同名定义 2 处");
    rmSync(dir, { recursive: true, force: true });
  });

  it("无弃边时弃边段如实「无记录」;旧索引(无 dropped 字段)如实标注", () => {
    const r = queryImpact(index, "target", { depth: 2 });
    const text = renderImpact(r);
    // 本夹具 target 无弃边:台账字段在(新索引)但该名无记录
    expect(text).toContain("弃边与不可见");
    // 旧索引模拟:剥离 dropped/importers → 双降级文案齐备
    const old: C2fIndex = JSON.parse(JSON.stringify(index)) as C2fIndex;
    delete old.dropped;
    delete old.importers;
    const oldText = renderImpact(queryImpact(old, "target", { depth: 2 }));
    expect(oldText).toContain("旧格式索引:import 通道不可用");
    expect(oldText).toContain("构建期弃边台账=旧索引无此字段");
  });
});
