import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { WorkflowEngine, createWorld, isLoaderError, runErrorPrefix } from "../src/engine";
import { renderTemplate } from "../src/templates";
import { z } from "zod";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

describe("D1 双 agent 编排", () => {
  it("facade agent().ask 真派发,report 聚合", async () => {
    const j = new MemoryJournal();
    const calls: string[] = [];
    const e = new WorkflowEngine({
      root: ROOT, journal: j, workflowId: "wf-1", executor: null as never,
      dispatch: async (instr) => { calls.push(instr); return `结果:${instr.slice(0, 10)}`; },
    });
    const r = await e.run(`
      const a = await agent("analyst").ask("分析模块A");
      const b = await agent("reviewer").ask("评审模块B");
      report({ a, b });
    `);
    expect(r.ok).toBe(true);
    expect(r.items[0]).toEqual({ a: "结果:分析模块A", b: "结果:评审模块B" });
    expect(calls).toHaveLength(2);
  });
});

describe("D2 确定性门控", () => {
  it("world.run 白名单命令真跑(vitest 单包);越权拒", async () => {
    const w = createWorld(ROOT);
    const r = await w.run("ls packages/core/src", {});
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("journal");
    await expect(w.run("rm -rf /")).rejects.toThrow(/白名单拒绝/);
  }, 30_000);
  it("world.read/glob", async () => {
    const w = createWorld(ROOT);
    const t = await w.read("packages/core/src/task/task.ts");
    expect(t).toContain("TaskState");
    const g = await w.glob("packages/core/src/**/*.ts");
    expect(g.length).toBeGreaterThan(3);
    await expect(w.read("../../etc/passwd")).rejects.toThrow(/越界/);
  });
});

describe("D3 journal-first + resume", () => {
  it("同 inputHash 二次运行缓存命中(dispatch 计数不增);改 input 重派", async () => {
    const j = new MemoryJournal();
    let count = 0;
    const mk = () => new WorkflowEngine({
      root: ROOT, journal: j, workflowId: "wf-r", executor: null as never,
      dispatch: async () => { count++; return "ok"; },
    });
    const script = `const x = await agent("a").ask("固定输入"); report({ x });`;
    await mk().run(script);
    expect(count).toBe(1);
    // 二次:resume 引擎重放 journal → 缓存命中
    const r2 = await mk().run(script);
    expect(count).toBe(1); // 不重派
    expect(r2.items[0]).toEqual({ x: "ok" });
    // journal 里 ask 事件存在
    expect(j.readAll().filter((e) => e.kind === "workflow.ask").length).toBeGreaterThanOrEqual(1);
  });
});

describe("D4 失败保留", () => {
  it("中途 throw,已 report 的 items 在 partial 结果", async () => {
    const j = new MemoryJournal();
    const e = new WorkflowEngine({
      root: ROOT, journal: j, workflowId: "wf-f", executor: null as never,
      dispatch: async () => "ok",
    });
    const r = await e.run(`
      report({ step: 1, done: true });
      report({ step: 2, done: true });
      throw new Error("第三步炸了");
    `);
    expect(r.ok).toBe(false);
    expect(r.partial).toBe(true);
    expect(r.items).toHaveLength(2); // 已 report 的保留
    expect(r.error).toContain("第三步炸了");
  });
});

describe("D5 结构化输出", () => {
  it("schema 校验:坏输出重试(真重派)→好输出过;两坏则抛且 journal 留痕", async () => {
    const j = new MemoryJournal();
    let call = 0;
    const e = new WorkflowEngine({
      root: ROOT, journal: j, workflowId: "wf-s", executor: null as never,
      dispatch: async () => { call++; return call === 1 ? "不是json" : '{"pass":true,"reason":"r"}'; },
      schemas: { verdict: z.object({ pass: z.boolean(), reason: z.string() }) },
    });
    const r = await e.run(`
      const v = await agent("judge").ask("判定", { schema: schemas.verdict });
      report({ v });
    `);
    expect(r.ok).toBe(true);
    expect(call).toBe(2); // 第一次坏→重派
    expect(r.items[0]).toEqual({ v: { pass: true, reason: "r" } });
    // 两坏场景
    const j2 = new MemoryJournal();
    let call2 = 0;
    const e2 = new WorkflowEngine({
      root: ROOT, journal: j2, workflowId: "wf-s2", executor: null as never,
      dispatch: async () => { call2++; return "还是不是json"; },
      schemas: { verdict: z.object({ pass: z.boolean() }) },
    });
    const r2 = await e2.run(`await agent("j").ask("x", { schema: schemas.verdict });`);
    expect(r2.ok).toBe(false);
    expect(call2).toBe(2);
    expect(j2.readAll().some((ev) => (ev.payload as { schemaError?: string }).schemaError)).toBe(true);
  });
});

describe("D6 沙箱", () => {
  it("require/process 不可得;静态禁令拒源文本", async () => {
    const j = new MemoryJournal();
    const e = new WorkflowEngine({
      root: ROOT, journal: j, workflowId: "wf-sb", executor: null as never,
      dispatch: async () => "ok",
    });
    // 静态禁令
    const r1 = await e.run(`const f = require("fs");`);
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain("静态禁令");
    // vm 内拿不到 process
    const r2 = await e.run(`
      let leaked = false;
      try { void (globalThis as any).process; leaked = true; } catch { }
      report({ leaked: typeof (globalThis as any).process !== "undefined" });
    `);
    expect(r2.items[0]).toEqual({ leaked: false });
  });
});

describe("D8 esbuild 加载器错误分类(生产环境缺陷回归)", () => {
  it("加载/部署类错误不被标成「语法错误」,真语法错误仍是「语法错误」", async () => {
 // 生产环境经验证的加载失败原文(dist/gateway.mjs 内联 esbuild 时第一条 100% 命中)
    for (const msg of [
      "ReferenceError: __filename is not defined",
      "Error: The esbuild JavaScript API cannot be bundled. Please mark the \"esbuild\" package as external",
      "Error: Cannot find module 'esbuild'",
      "Error: Cannot find module 'esbuild'(加载到的模块不含 transform)",
      'Error: Cannot start service: Host version "0.24.2" does not match binary version "0.21.5"',
    ]) {
      expect(isLoaderError(new Error(msg))).toBe(true);
      expect(runErrorPrefix(new Error(msg))).toBe("esbuild 加载失败"); // 断言 run catch 的前缀映射本身
    }
    expect(isLoaderError(new Error("Unexpected token ')'"))).toBe(false);

    // 误判护栏:esbuild 语法错误会回显出错源码行;脚本里含 "Cannot find module" 字样也不得被判成加载失败
    const echoed = new Error("Transform failed with 1 error:\nsrc.ts:1:12: ERROR: Unterminated string literal\n  const s = \"Cannot find module`");
    expect(isLoaderError(echoed)).toBe(false);
    expect(runErrorPrefix(echoed)).toBe("语法错误");

    // 真语法错误 → 仍是「语法错误」前缀(不被加载器分类误伤)
    const e = new WorkflowEngine({ root: ROOT, journal: new MemoryJournal(), workflowId: "wf-err", executor: null as never, dispatch: async () => "ok" });
    const r = await e.run(`const a = ;`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^语法错误:/);
  });
});
