import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectAntipatterns, ANTIPATTERN_DIMENSION } from "../src/review/antipatterns";
import { collectReviewTarget } from "../src/review/index";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gh-anti-"));
  const g = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir });
  g("init -q"); g("config user.email t@t"); g("config user.name t");
  writeFileSync(join(dir, "base.ts"), "export const base = 1;\n");
  g("add ."); g('commit -qm init');
  return dir;
}
function stage(dir: string): void { execSync("git add -A", { cwd: dir }); }

describe("反模式八类(确定性层)", () => {
  it("孤独逻辑:新增导出全仓零引用", async () => {
    const dir = repo();
    writeFileSync(join(dir, "orphan.ts"), "export function lonelyHelper(x: number) { return x + 1; }\n");
    stage(dir);
    const t = await collectReviewTarget(dir);
    const r = await detectAntipatterns(dir, t);
    expect(r.some((f) => f.title.includes("孤独逻辑") && f.title.includes("lonelyHelper"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("另起炉灶:通用能力名(唯一引用也不报,复用信号只在孤立即重名)——验证不误报", async () => {
    const dir = repo();
    writeFileSync(join(dir, "u.ts"), "export function deepCopy<T>(x: T): T { return JSON.parse(JSON.stringify(x)); }\nexport function useDeepCopy() { return deepCopy({ a: 1 }); }\n");
    stage(dir);
    const t = await collectReviewTarget(dir);
    const r = await detectAntipatterns(dir, t);
    // deepCopy 被 u.ts 自身调用(grep 排除定义文件后 0 引用?)——此处 useDeepCopy 在同文件被排除,应报孤独或另起炉灶之一
    expect(r.some((f) => f.title.includes("孤独逻辑") || f.title.includes("另起炉灶"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("丢三落四:实现改了同名测试没动", async () => {
    const dir = repo();
    writeFileSync(join(dir, "svc.ts"), "export const svc = 1;\n");
    writeFileSync(join(dir, "svc.test.ts"), "test('svc', () => {});\n");
    execSync("git add -A && git commit -qm with-test", { cwd: dir });
    appendFileSync(join(dir, "svc.ts"), "export const svc2 = 2;\n");
    stage(dir);
    const t = await collectReviewTarget(dir);
    const r = await detectAntipatterns(dir, t);
    expect(r.some((f) => f.title.includes("丢三落四"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("虚假测试:弱断言主导", async () => {
    const dir = repo();
    writeFileSync(join(dir, "x.test.ts"), [
      "test('a', () => { expect(1).toBeTruthy(); });",
      "test('b', () => { expect(2).toBeTruthy(); });",
      "test('c', () => { expect(3).toBeDefined(); });",
    ].join("\n"));
    stage(dir);
    const t = await collectReviewTarget(dir);
    const r = await detectAntipatterns(dir, t);
    expect(r.some((f) => f.title.includes("虚假测试"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("作弊:mock 被测对象本身(blocker)", async () => {
    const dir = repo();
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/api.ts"), "export function call() { return 1; }\n");
    writeFileSync(join(dir, "src/api.test.ts"), 'vi.mock("./api");\ntest("x", () => {});\n');
    stage(dir);
    const t = await collectReviewTarget(dir);
    const r = await detectAntipatterns(dir, t);
    const cheat = r.find((f) => f.title.includes("作弊"));
    expect(cheat).toBeTruthy();
    expect(cheat!.severity).toBe("blocker");
    rmSync(dir, { recursive: true, force: true });
  });

  it("补丁式屎山:纯叠加+条件堆叠", async () => {
    const dir = repo();
    const lines = ["export function handle(x: string) {"];
    for (let i = 0; i < 8; i++) lines.push(`  if (x === "case${i}") { return ${i}; }`);
    for (let i = 0; i < 6; i++) lines.push(`  if (x.includes("t${i}") && x.length > ${i}) { return -${i}; }`);
    lines.push("  return 0;", "}");
    writeFileSync(join(dir, "h.ts"), lines.join("\n") + "\n");
    stage(dir);
    const t = await collectReviewTarget(dir);
    const r = await detectAntipatterns(dir, t);
    expect(r.some((f) => f.title.includes("补丁式屎山"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("作弊:期望值与实现字面量串通", async () => {
    const dir = repo();
    writeFileSync(join(dir, "calc.ts"), 'export function compute() { return "TOTAL-9A3F-RESULT"; }\n');
    writeFileSync(join(dir, "calc.test.ts"), 'import { compute } from "./calc";\ntest("t", () => { expect(compute()).toBe("TOTAL-9A3F-RESULT"); });\n');
    stage(dir);
    const t = await collectReviewTarget(dir);
    const r = await detectAntipatterns(dir, t);
    expect(r.some((f) => f.title.includes("作弊") && f.title.includes("期望值"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("prompt 维度:八类话术进 REVIEW_PROMPT", () => {
    expect(ANTIPATTERN_DIMENSION).toContain("另起炉灶");
    expect(ANTIPATTERN_DIMENSION).toContain("孤独逻辑");
    expect(ANTIPATTERN_DIMENSION).toContain("丢三落四");
    expect(ANTIPATTERN_DIMENSION).toContain("换头不换尾");
    expect(ANTIPATTERN_DIMENSION).toContain("虚假测试");
    expect(ANTIPATTERN_DIMENSION).toContain("作弊");
    expect(ANTIPATTERN_DIMENSION).toContain("补丁式屎山");
    expect(ANTIPATTERN_DIMENSION).toContain("治标不治本");
  });
});

describe("孤儿逻辑加强(,vibe coding 家族)", () => {
  it("仅测试接线:模块只有测试引用、生产链路零调用", async () => {
    const dir = repo();
    writeFileSync(join(dir, "fresh.ts"), "export function freshThing(x: number) { return x * 2; }\n");
    writeFileSync(join(dir, "fresh.test.ts"), 'import { freshThing } from "./fresh";\ntest("t", () => { expect(freshThing(2)).toBe(4); });\n');
    stage(dir);
    const t = await collectReviewTarget(dir);
    const r = await detectAntipatterns(dir, t);
    const f = r.find((x) => x.title.includes("仅测试接线") && x.title.includes("freshThing"));
    expect(f).toBeTruthy();
    expect(f!.severity).toBe("nit");
    rmSync(dir, { recursive: true, force: true });
  });

  it("类型孤儿:export interface 全仓零引用也报", async () => {
    const dir = repo();
    writeFileSync(join(dir, "types.ts"), "export interface NeverUsed { a: number }\n");
    stage(dir);
    const t = await collectReviewTarget(dir);
    const r = await detectAntipatterns(dir, t);
    expect(r.some((x) => x.title.includes("孤独逻辑") && x.title.includes("NeverUsed"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("孤儿事件:emit 无监听 / on 无发出者", async () => {
    const dir = repo();
    writeFileSync(join(dir, "bus.ts"), [
      'import { EventEmitter } from "node:events";',
      "const bus = new EventEmitter();",
      'bus.emit("widget-reflow-done", {});',
      'bus.on("ghost-signal", () => {});',
    ].join("\n"));
    stage(dir);
    const t = await collectReviewTarget(dir);
    const r = await detectAntipatterns(dir, t);
    expect(r.some((x) => x.title.includes("孤儿事件") && x.title.includes("widget-reflow-done"))).toBe(true);
    expect(r.some((x) => x.title.includes("孤儿监听") && x.title.includes("ghost-signal"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("双胞胎实现:diff 内两处函数体逐行相同", async () => {
    const dir = repo();
    const body = (name: string) => [
      `export function ${name}(a: number, b: number): number {`,
      "  const s = a + b;",
      "  if (s > 10) { return s - 1; }",
      "  return s * 2;",
      "}",
    ].join("\n");
    writeFileSync(join(dir, "twin1.ts"), body("calcAlpha") + "\n");
    writeFileSync(join(dir, "twin2.ts"), body("calcBeta") + "\n");
    stage(dir);
    const t = await collectReviewTarget(dir);
    const r = await detectAntipatterns(dir, t);
    expect(r.some((x) => x.title.includes("双胞胎实现") && x.title.includes("calcAlpha") && x.title.includes("calcBeta"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("空 catch:异常静默吞掉(治标不治本确定性形态)", async () => {
    const dir = repo();
    writeFileSync(join(dir, "risky.ts"), 'export async function load() {\n  try { return JSON.parse("{}"); } catch (e) {}\n}\n');
    stage(dir);
    const t = await collectReviewTarget(dir);
    const r = await detectAntipatterns(dir, t);
    expect(r.some((x) => x.title.includes("空 catch"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("换头不换尾加强:参数个数变更且调用方不在 diff → warning", async () => {
    const dir = repo();
    writeFileSync(join(dir, "sign.ts"), [
      "export function greet(name: string) { return name; }",
    ].join("\n"));
    execSync("git add -A && git commit -qm v1", { cwd: dir });
    // 改签名:1 参 → 2 参;无任何调用方进 diff
    writeFileSync(join(dir, "sign.ts"), [
      "export function greet(name: string, greeting: string) { return greeting + name; }",
    ].join("\n"));
    stage(dir);
    const t = await collectReviewTarget(dir);
    const r = await detectAntipatterns(dir, t);
    const f = r.find((x) => x.title.includes("换头不换尾") && x.title.includes("greet"));
    expect(f).toBeTruthy();
    expect(f!.severity).toBe("warning");
    rmSync(dir, { recursive: true, force: true });
  });
});
