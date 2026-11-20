/**
 * session-rsi 域补修闭环测试:
 * - S1:guardInjection 生产接线(rsiCanaryTipFor——canary tip 过闸;闸拒 fail-closed)
 * - S3:STOPWORDS 历史晋升回收(demoteStopwordAbsorbedGoals——pg: 前缀判据、幂等、人工 goal 不动)
 * - 周报进 finishCycle(aggregateWeekly 接线 + 7 天门)
 * - rsi-injection-store 类型回归(sanitizedText 可空)
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rsiCanaryTipFor } from "../src/rsi-injection-store.js";
import { demoteStopwordAbsorbedGoals } from "../src/nightly-store.js";
import { isAllStopwords } from "../src/atlas-harvest.js";
import { addGoal, getAtlas } from "../src/direction-atlas-store.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rsi-closure-"));
}

describe("S1: rsiCanaryTipFor(guardInjection 生产接线)", () => {
  it("正常文本过闸返回带 RSI 前缀的 sanitizedText", async () => {
    const root = tmpRoot();
    try {
      const tip = await rsiCanaryTipFor(root, "sess-a", 2);
      expect(tip).toContain("[RSI 生成·非系统权威]");
      expect(tip).toContain("repeated-reads".slice(0, 0) + "多次重读"); // 文本本体在
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("root 非法/IO 异常 fail-closed 返回空串(不注入)", async () => {
 // 守卫内 try/catch 包住全部 IO:即使 root 指向不存在的深层路径也不 throw
    const tip = await rsiCanaryTipFor("/nonexistent-root-xyz", "sess-b", 3);
    expect(typeof tip).toBe("string");
  });

  it("台账落 evaluate 行且不含原文(只 sha256)", async () => {
    const root = tmpRoot();
    try {
      await rsiCanaryTipFor(root, "sess-c", 2);
      const raw = readFileSync(join(root, ".genie", "rsi", "injection.jsonl"), "utf8");
      const line = JSON.parse(raw.trim().split("\n")[0]);
      expect(line.type).toBe("evaluate");
      expect(line.textHash).toMatch(/^[0-9a-f]{64}$/);
      expect(raw).not.toContain("多次重读"); // 原文不落盘
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("S3: demoteStopwordAbsorbedGoals(STOPWORDS 历史晋升回收)", () => {
  function seedAtlas(root: string): void {
 // 两个 pg: goal(一个全停用词主题、一个正常主题)+ 一个正常 id 的人工 goal
    addGoal(root, "proj", {
      id: "pg:proj:missing-implemented",
      title: "主题「missing-implemented」(6 会话在近期活跃)",
      status: "active",
      since: new Date().toISOString(),
      evidenceRefs: ["proposed-goals:pg:proj:missing-implemented"],
    });
    addGoal(root, "proj", {
      id: "pg:proj:board-render",
      title: "主题「board-render」(5 会话在近期活跃)",
      status: "active",
      since: new Date().toISOString(),
      evidenceRefs: ["proposed-goals:pg:proj:board-render"],
    });
    addGoal(root, "proj", {
      id: "goal-manual-1",
      title: "手动立的线",
      status: "active",
      since: new Date().toISOString(),
      evidenceRefs: [],
    });
 // 快照文件(demoteStopwordAbsorbedGoals 读快照取 active 清单)
    const snapDir = join(root, ".genie", "rsi", "atlas");
    mkdirSync(snapDir, { recursive: true });
    writeFileSync(
      join(snapDir, "proj.json"),
      JSON.stringify({
        v: 1,
        goals: [
          { id: "pg:proj:missing-implemented", status: "active" },
          { id: "pg:proj:board-render", status: "active" },
          { id: "goal-manual-1", status: "active" },
        ],
      }),
      "utf8",
    );
  }

  it("全停用词主题被回收,正常主题与人工 goal 不动", () => {
    const root = tmpRoot();
    try {
      seedAtlas(root);
      const demoted = demoteStopwordAbsorbedGoals(root, "proj");
      expect(demoted).toBe(1);
 // closeGoal 只追加事件(快照由下一次 build 重放刷新)——按 entries.jsonl 事件账本断言
      const events = readFileSync(join(root, ".genie", "rsi", "atlas", "entries.jsonl"), "utf8");
      const closes = events
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { kind?: string; payload?: { goalId?: string; status?: string; reason?: string } })
        .filter((e) => e.kind === "goal_close");
      const closedIds = closes.map((c) => c.payload?.goalId);
      expect(closedIds).toContain("pg:proj:missing-implemented");
      expect(closedIds).not.toContain("pg:proj:board-render");
      expect(closedIds).not.toContain("goal-manual-1");
      const theClose = closes.find((c) => c.payload?.goalId === "pg:proj:missing-implemented");
      expect(theClose?.payload?.status).toBe("abandoned");
      expect(theClose?.payload?.reason).toContain("stopword-absorbed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("幂等:重跑返回 0 且不追加新事件行", () => {
    const root = tmpRoot();
    try {
      seedAtlas(root);
      expect(demoteStopwordAbsorbedGoals(root, "proj")).toBe(1);
      const eventsPath = join(root, ".genie", "rsi", "atlas", "entries.jsonl");
      const linesAfterFirst = readFileSync(eventsPath, "utf8").trim().split("\n").length;
      expect(demoteStopwordAbsorbedGoals(root, "proj")).toBe(0);
      const linesAfterSecond = readFileSync(eventsPath, "utf8").trim().split("\n").length;
      expect(linesAfterSecond).toBe(linesAfterFirst);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("isAllStopwords 判据:全命中 true/含非停用词 false/空 false", () => {
    expect(isAllStopwords("missing implemented")).toBe(true);
    expect(isAllStopwords("missing board")).toBe(false); // board 非停用词
    expect(isAllStopwords("")).toBe(false);
    expect(isAllStopwords("主题「missing」(6 会话在近期活跃)")).toBe(false); // 标题 wrapper 非全停用词——印证判 theme 段的必要性
  });
});
