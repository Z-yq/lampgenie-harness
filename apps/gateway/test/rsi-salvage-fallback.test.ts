/**
 * RESULT_MISSING 兜底:done 但 agent 没写 result.json 时,从 journal 最终回复
 * 代写(cohort/negativeKb 实况);解析不出条目保留 RESULT_MISSING(禁编造)。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseResultItemsFromText, settleRunRecord } from "../src/rsi-agent-runner.js";
import { finishRun, getRun, resultFilePath, startRun } from "../src/rsi-mechanism-store.js";

describe("parseResultItemsFromText(纯函数)", () => {
  it("裸 JSON 数组行 → 提取合法条目;非法 status 丢弃", () => {
    const text = [
      "前言",
      '[{"id":"k1","title":"一次通过率下降","summary":"42%→31%","status":"bad","detail":"证据 A","evidence":["sessionId:s1"]}]',
      '[{"title":"无状态条目","status":"不是状态"}]',
    ].join("\n");
    const items = parseResultItemsFromText(text);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "k1", title: "一次通过率下降", status: "bad", source: "agent" });
  });
  it("```json 围栏里的 {items:[…]} → 提取", () => {
    const text = '结论:\n```json\n{"items":[{"id":"n1","title":"死路两条","status":"warn","summary":"xx"}]}\n```\n收尾';
    const items = parseResultItemsFromText(text);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "n1", status: "warn" });
  });
  it("散文/空文本 → 0 条(禁编造)", () => {
    expect(parseResultItemsFromText("我看了台账,没什么问题。")).toEqual([]);
    expect(parseResultItemsFromText("")).toEqual([]);
  });
});

describe("settleRunRecord ③(RESULT_MISSING 兜底代写)", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "rsi-salvage-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("done + 无 result 文件 + journal 终回有条目 → 代写 result.json + SALVAGED_FROM_REPLY", async () => {
    await startRun(root, { mechanismId: "cohort", runId: "run_cohort_x", taskId: "t-sal", sessionId: "rsi" });
    await finishRun(root, "cohort", "run_cohort_x", "done");
    const events = [
      { kind: "task.start", payload: { id: "t-sal" } },
      {
        kind: "message.agent",
        payload: {
          text: '汇总:\n[{"id":"c1","title":"一次通过率 42%","summary":"比上轮降 11pct","status":"warn","detail":"cohort 68 行对比","evidence":["sessionId:s2"]}]\n已分析会话: (无)',
        },
      },
    ];
    const res = await settleRunRecord(
      { root, readSession: () => events },
      { id: "cohort", title: "一次通过率" },
      (await getRun(root, "cohort", "run_cohort_x"))!,
    );
    expect(res.run.quality?.issues.some((i) => i.code === "SALVAGED_FROM_REPLY")).toBe(true);
    const salvaged = JSON.parse(await readFile(resultFilePath(root, "cohort", "run_cohort_x"), "utf8")) as {
      items: unknown[];
      salvage: string;
    };
    expect(salvaged.items.length).toBeGreaterThan(0);
    expect(salvaged.salvage).toBe("journal-final-reply");
  });

  it("done + 无 result 文件 + journal 空终回 → 保留 RESULT_MISSING 0 分", async () => {
    await startRun(root, { mechanismId: "tools", runId: "run_tools_x", taskId: "t-sal", sessionId: "rsi" });
    await finishRun(root, "tools", "run_tools_x", "done");
    const events = [{ kind: "task.start", payload: { id: "t-sal" } }]; // 无 message.agent
    const res = await settleRunRecord(
      { root, readSession: () => events },
      { id: "tools", title: "数据工具" },
      (await getRun(root, "tools", "run_tools_x"))!,
    );
    expect(res.run.quality?.issues[0]?.code).toBe("RESULT_MISSING");
    expect(res.run.quality?.score).toBe(0);
  });
});
