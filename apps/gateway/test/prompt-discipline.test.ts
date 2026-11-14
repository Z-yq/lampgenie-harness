/**
 * 04 主轨减步纪律(token 成本优化第一轮):SYSTEM_PLAN 里五条行为规格必须逐字在场,
 * 且不得写成「务必/尽量/努力/高度重视」这类口号(口号不可验收,规格可验收)。
 * 背景经验证:重复读板 1,437 轮 + 仪式 churn 700 轮 + 同一校验命令重跑 108 次 + 被拒原样重试 31 对。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SYSTEM } from "../src/agent-wiring.js";

// 拆分后实现搬到 agent-wiring/*,负面断言挂聚合源(barrel 只 20 行会空转绿)
import { AGENT_WIRING_SRC } from "./panel-source.js";

describe("五条减步纪律在编码轨 system 提示词里且含关键约束词", () => {
  it("①实施序列 + 同一文件一次 read 到够用", () => {
    expect(SYSTEM).toContain("开工前先写实施序列");
    expect(SYSTEM).toContain("同一文件一次 read 到够用为止");
    expect(SYSTEM).toContain("不重读已读文件");
  });

  it("②board_read 同板 rev 未变不重读,读完下一步直接用", () => {
    expect(SYSTEM).toContain("board_read");
    expect(SYSTEM).toContain("rev 未变不重读");
    expect(SYSTEM).toContain("不追加一次确认读");
  });

  it("③同一校验命令最多重跑一次,且重跑前该轮必须已有改动", () => {
    expect(SYSTEM).toContain("同一校验命令最多重跑一次");
    expect(SYSTEM).toContain("重跑前该轮必须已有代码或配置改动");
  });

  it("④被拒先读 reason 再换路径,禁止原样重试", () => {
    expect(SYSTEM).toContain("先读返回的 reason 再换路径");
    expect(SYSTEM).toContain("禁止原样重试同一命令");
  });

  it("⑤工具步内不写进度叙述,进度只在轮末总结或轮首声明", () => {
    expect(SYSTEM).toContain("工具调用步内不写进度叙述");
    expect(SYSTEM).toContain("轮末");
  });

  it("总增量克制(每步都注入的固定税):五条合起来 < 300 字符", () => {
    const i = SYSTEM.indexOf("减步纪律");
    expect(i).toBeGreaterThan(0);
    const block = SYSTEM.slice(i, SYSTEM.indexOf("轮首声明", i) + "轮首声明".length);
    expect(block.length).toBeGreaterThan(0);
    expect(block.length).toBeLessThan(300);
  });
});

describe("negative:纪律不写成口号", () => {
  it("agent-wiring.ts 里没有「务必/尽量/努力/高度重视」", () => {
    const src = AGENT_WIRING_SRC;
    const hits = src.match(/务必|尽量|努力|高度重视/g) ?? [];
    expect(hits).toEqual([]);
  });
});
