import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { servePanel } from "../src/panel.js";
import { PANEL_SRC as src } from "./panel-source.js";

// 追踪 Trace 看板「只有一个数据窗口」契约守卫:
// 现状病灶 = 统计区 #sw-slot(max-height:44%;overflow:auto)与 turn 树 #track-body(overflow:auto)
// 各自独立滚动,视觉上把卡切成上下两个数据窗口;且 status-widget 内还重复渲染一个「任 务」块。
// 期望 = 唯一滚动落在卡自身,统计区是可选头部块(无数据不占位),「任务」= 最后一个数据块:
// 一级 turn → 二级五阶段 → 三级阶段任务(note)。

describe("追踪 Trace:单数据窗口 + turn 三层树", () => {
  it("面板结构:两区都不自带滚动/高度上限,统计区无数据时隐藏", async () => {
    const p = servePanel(7898, () => {});
    const html = await (await fetch("http://127.0.0.1:7898/")).text();
    await p.close();

    const slotTag = /<div id="sw-slot"[^>]*>/.exec(html);
    const bodyTag = /<div id="track-body"[^>]*>/.exec(html);
    expect(slotTag, "缺 #sw-slot 节点").not.toBeNull();
    expect(bodyTag, "缺 #track-body 节点").not.toBeNull();
    for (const [name, tag] of [["sw-slot", slotTag![0]], ["track-body", bodyTag![0]]] as const) {
      expect(tag, name + " 不应再带 overflow(避免第二个滚动窗口)").not.toContain("overflow");
      expect(tag, name + " 不应再带 max-height(避免把卡切成两半)").not.toContain("max-height");
    }
    // 统计区空态不占位:sw-active 才显示(status-widget 自己切)
    expect(html).toContain("#sw-slot{display:none");
    expect(html).toContain("#sw-slot.sw-active{display:block}");

    // 脚本仍可解析(结构改动不破页面)
    for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      expect(() => new Script(m[1] ?? "")).not.toThrow();
    }
  });

  it("status-widget:不再重复渲染「任 务」块,且脚本语法合法", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "../src/assets/status-widget.js"), "utf-8");
    expect(() => new Script(src), "status-widget.js 语法错误").not.toThrow();
    // 任务数据归 turn 树唯一所有:widget 里出现「任 务」标题=重复数据窗口回归
    // (注:sw-task 类名仍被「工 作 流」区复用,不能拿它判重复)
    expect(src).not.toContain("任 务");
    expect(src).not.toContain("sw-hd-t\">任 务");
  });

  it("turn 树渲染:三条层级(一级 turn / 二级五阶段 / 三级阶段任务)齐备", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    // 一级
    expect(src).toContain('class="tk-turn"');
    // 二级:恒定五阶
    expect(src).toContain('const PH = ["understand", "plan", "implement", "verify", "close"]');
    expect(src).toContain('class="tk-ph"');
    // 三级:阶段任务
    expect(src).toContain('class="tk-notes"');
    expect(src).toContain('class="tk-note');
    // 「任务」分组标题在任务区内(最后一个数据块的命名)
    expect(src).toContain('<div class="tk-hd"><span class="tk-hd-t">任 务</span></div>');
  });
});
