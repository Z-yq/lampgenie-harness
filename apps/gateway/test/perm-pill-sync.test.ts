/**
 * 权限 pill 首同步诚实化(用户用户反馈:「每次进入网页,每次询问和真实值都对不上,
 * 点开后都是 √ 完全访问」)。复现机理:首帧 pill 渲染 localStorage 种子(本机上次选择),
 * 服务端 cfg.get 回包(约 150-400ms 后)才把真值同步进来——种子若已被其他客户端/浏览器 e2e
 * 改掉,用户先看到自己的旧选择、随即被无声翻转,菜单 √ 落在服务端值上=「对不上」体感。
 * 源结构锁:①同步中半透明态 ②首同步分叉 toast ③title 提示。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PANEL_SRC } from "./panel-source.js";

const src = PANEL_SRC;

describe("permPill 首同步诚实化(源结构锁;(②):pill 已删,权限模式不再在输入条展示;返工轮维持)", () => {
  it("① permPill UI 已删除:输入条不再出现该胶囊(删除锁,不得复活)", () => {
    expect(src).not.toContain('id="permPill"');
    expect(src).not.toContain('$("permPill")');
  });

  it("② 首同步分叉 toast:服务端真值≠本机种子时明说(不再无声翻转;ws-router 通道保留)", () => {
    expect(src).toContain("权限模式按服务端真实值同步为「");
    expect(src).toContain("与你本机上次选择不同");
  });

  it("③ 首包到达转确认态:permSynced=true 通道仍在(判定链不随 UI 删除而断)", () => {
    expect(src).toContain("if (!permSynced) { permSynced = true; pillRender(); }");
  });
});
