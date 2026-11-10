/**
 * 权限 pill 首同步诚实化(2026-10-19 用户实报:「每次进入网页,每次询问和真实值都对不上,
 * 点开后都是 √ 完全访问」)。复现机理:首帧 pill 渲染 localStorage 种子(本机上次选择),
 * 服务端 cfg.get 回包(约 150-400ms 后)才把真值同步进来——种子若已被其他客户端/浏览器 e2e
 * 改掉,用户先看到自己的旧选择、随即被无声翻转,菜单 √ 落在服务端值上=「对不上」体感。
 * 源结构锁:①同步中半透明态 ②首同步分叉 toast ③title 提示。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(__dirname, "../src/panel.ts"), "utf-8");

describe("permPill 首同步诚实化(源结构锁)", () => {
  it("① 同步中态:.mode-pill.sync 半透明样式+pillRender 按 permSynced 摘挂", () => {
    expect(src).toContain(".mode-pill.sync{opacity:.5");
    expect(src).toContain('classList.toggle("sync", !permSynced)');
    expect(src).toContain("let permSynced = false;");
  });

  it("② 首同步分叉 toast:服务端真值≠本机种子时明说(不再无声翻转)", () => {
    expect(src).toContain("权限模式按服务端真实值同步为「");
    expect(src).toContain("与你本机上次选择不同");
  });

  it("③ 首包到达转确认态:permSynced=true+pillRender;title 带同步中提示", () => {
    expect(src).toContain("if (!permSynced) { permSynced = true; pillRender(); }");
    expect(src).toContain("同步服务端真实值中");
  });
});
