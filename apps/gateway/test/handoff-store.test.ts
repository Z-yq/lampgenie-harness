/**
 * 交接台账的持久层:落盘行格式、重放重建 registry、重复登记拒收、交接拒收不落盘、
 * 退出盘点与委派分桶的报表口径、坏行容忍。
 * 全部用例只写 os.tmpdir() 下的临时目录,绝不碰仓库 .genie。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  delegate,
  handoff,
  handoffPath,
  inventory,
  loadHandoff,
  registerAgent,
  registerProcess,
  reportHandoff,
} from "../src/handoff-store";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "handoff-store-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function lines(): string[] {
  try {
    return readFileSync(handoffPath(root), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
  } catch {
    return [];
  }
}

/** 建一个 owner=a1 的进程 p1(连同 a1 的 agent 行)。 */
function seed(): void {
  registerAgent(root, { id: "a1", maxHandoffs: 3 });
  registerProcess(root, { id: "p1", owner: "a1", purpose: "watch CI" });
}

/** 直接写台账内容(先用坏行/历史行铺底时用;目录不存在就建)。 */
function writeLines(rows: unknown[]): void {
  const path = handoffPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${rows.map((row) => (typeof row === "string" ? row : JSON.stringify(row))).join("\n")}\n`, "utf8");
}

describe("路径与空台账", () => {
  it("台账落在 <root>/.genie/rsi/handoff.jsonl", () => {
    expect(handoffPath(root)).toBe(join(root, ".genie", "rsi", "handoff.jsonl"));
  });

  it("文件不存在时重放成空台账(不 throw)", () => {
    const ledger = loadHandoff(root);
    expect(ledger.totalLines).toBe(0);
    expect(ledger.parseErrors).toBe(0);
    expect(Object.keys(ledger.registry.processes)).toEqual([]);
    expect(Object.keys(ledger.registry.agents)).toEqual([]);
  });

  it("root 非法时抛参数错误(唯一允许 throw 的入口)", () => {
    expect(() => handoffPath("")).toThrow(/root/);
  });
});

describe("注册代理与进程", () => {
  it("registerAgent 追加一行,重放可见", () => {
    const result = registerAgent(root, { id: "a1", maxHandoffs: 5 });
    expect(result.ok).toBe(true);
    expect(lines()).toHaveLength(1);
    const line = JSON.parse(lines()[0]!);
    expect(line).toMatchObject({ v: 1, type: "agent", id: "a1", maxHandoffs: 5 });
    expect(loadHandoff(root).registry.agents.a1?.maxHandoffs).toBe(5);
  });

  it("同 id 重复登记 → HANDOFF_DUPLICATE,且不追加行", () => {
    seed();
    const before = lines().length;
    const again = registerAgent(root, { id: "a1", maxHandoffs: 9 });
    expect(again.ok).toBe(false);
    expect(again.code).toBe("HANDOFF_DUPLICATE");
    expect(lines()).toHaveLength(before);
    expect(loadHandoff(root).registry.agents.a1?.maxHandoffs).toBe(3);
  });

  it("registerAgent 空白 id → HANDOFF_INVALID_INPUT,不落盘", () => {
    const result = registerAgent(root, { id: "  " });
    expect(result.code).toBe("HANDOFF_INVALID_INPUT");
    expect(lines()).toHaveLength(0);
  });

  it("registerProcess 自动登记 owner,重放得到进程与代理", () => {
    const result = registerProcess(root, { id: "p1", owner: "a1", purpose: "ci" });
    expect(result.ok).toBe(true);
    const ledger = loadHandoff(root);
    expect(ledger.registry.processes.p1).toMatchObject({ owner: "a1", handoffs: 0, purpose: "ci" });
    expect(ledger.registry.agents.a1?.maxHandoffs).toBe(3);
    expect(ledger.counts.agent).toBe(1);
    expect(ledger.counts.process).toBe(1);
  });

  it("同 id 重复登记进程 → HANDOFF_DUPLICATE", () => {
    seed();
    const again = registerProcess(root, { id: "p1", owner: "a2" });
    expect(again.code).toBe("HANDOFF_DUPLICATE");
    expect(loadHandoff(root).registry.processes.p1?.owner).toBe("a1");
  });
});

describe("handoff 落盘与语义拒收", () => {
  it("成功交接追加 handoff 行,重放 owner 翻转、handoffs=1", () => {
    seed();
    const result = handoff(root, { processId: "p1", fromAgent: "a1", toAgent: "a2", purpose: "长跑" });
    expect(result.ok).toBe(true);
    expect(result.code).toBe("HANDOFF_HANDED_OFF");
    const ledger = loadHandoff(root);
    expect(ledger.registry.processes.p1).toMatchObject({
      owner: "a2",
      handoffs: 1,
      purpose: "长跑",
      handedOffFrom: ["a1"],
    });
    expect(ledger.handoffs).toHaveLength(1);
    expect(ledger.handoffs[0]).toMatchObject({ processId: "p1", fromAgent: "a1", toAgent: "a2" });
  });

  it("缺 purpose → HANDOFF_PURPOSE_REQUIRED,台账一行都不增加", () => {
    seed();
    const before = lines().length;
    const result = handoff(root, { processId: "p1", fromAgent: "a1", toAgent: "a2" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("HANDOFF_PURPOSE_REQUIRED");
    expect(lines()).toHaveLength(before);
  });

  it("非 owner 交接 → HANDOFF_NOT_OWNER,owner 不变", () => {
    seed();
    const result = handoff(root, { processId: "p1", fromAgent: "a9", toAgent: "a2", purpose: "抢" });
    expect(result.code).toBe("HANDOFF_NOT_OWNER");
    expect(loadHandoff(root).registry.processes.p1?.owner).toBe("a1");
  });

  it("进程不存在 → HANDOFF_MISSING_PROCESS", () => {
    const result = handoff(root, { processId: "ghost", fromAgent: "a1", toAgent: "a2", purpose: "x" });
    expect(result.code).toBe("HANDOFF_MISSING_PROCESS");
  });

  it("累计 3 次交接后第 4 次 → HANDOFF_LIMIT,不落第 4 行", () => {
    seed();
    handoff(root, { processId: "p1", fromAgent: "a1", toAgent: "a2", purpose: "1" });
    handoff(root, { processId: "p1", fromAgent: "a2", toAgent: "a1", purpose: "2" });
    handoff(root, { processId: "p1", fromAgent: "a1", toAgent: "a2", purpose: "3" });
    const before = lines().length;
    const fourth = handoff(root, { processId: "p1", fromAgent: "a2", toAgent: "a1", purpose: "4" });
    expect(fourth.ok).toBe(false);
    expect(fourth.code).toBe("HANDOFF_LIMIT");
    expect(lines()).toHaveLength(before);
    expect(loadHandoff(root).registry.processes.p1?.handoffs).toBe(3);
  });
});

describe("退出盘点与委派分桶", () => {
  it("inventory 落一行并返回 handedOff", () => {
    seed();
    handoff(root, { processId: "p1", fromAgent: "a1", toAgent: "a2", purpose: "交接" });
    const result = inventory(root, "a1", { unreadCompletions: 4 });
    expect(result.ok).toBe(true);
    expect(result.inventory.handedOff).toEqual(["p1"]);
    expect(result.inventory.unreadCompletions).toBe(4);
    expect(result.stored).toBe(true);
    const ledger = loadHandoff(root);
    expect(ledger.counts.inventory).toBe(1);
    expect(ledger.inventories[0]).toMatchObject({ agentId: "a1", handedOff: ["p1"], unreadCompletions: 4 });
  });

  it("inventory 空白 agent → HANDOFF_INVALID_INPUT 且不落盘", () => {
    const before = lines().length;
    const result = inventory(root, " ");
    expect(result.code).toBe("HANDOFF_INVALID_INPUT");
    expect(lines()).toHaveLength(before);
  });

  it("delegate 4 任务 2 组 → 2 条聚合消息,并落一行 delegate", () => {
    const result = delegate(root, {
      tasks: [
        { id: "t1", group: "g1", agentId: "a1" },
        { id: "t2", group: "g2", agentId: "a2" },
        { id: "t3", group: "g1", agentId: "a3" },
        { id: "t4", group: "g2", agentId: "a4" },
      ],
      concurrency: 4,
    });
    expect(result.ok).toBe(true);
    expect(result.joined.count).toBe(2);
    expect(result.joins.map((join) => join.bucket)).toEqual(["g1", "g2"]);
    // 每桶一条消息,不是每任务一条
    expect(result.joined.messages).toHaveLength(2);
    expect(result.plan.concurrency).toBe(4);
    const ledger = loadHandoff(root);
    expect(ledger.delegations[0]).toMatchObject({
      concurrency: 4,
      joinOrder: ["g1", "g2"],
      buckets: { g1: ["t1", "t3"], g2: ["t2", "t4"] },
    });
  });

  it("delegate 带真实结果时消息反映失败", () => {
    const result = delegate(root, {
      tasks: [
        { id: "t1", group: "g1", agentId: "a1" },
        { id: "t2", group: "g1", agentId: "a2" },
      ],
      concurrency: 1,
      results: [
        { taskId: "t1", group: "g1", ok: true },
        { taskId: "t2", group: "g1", ok: false, output: "tsc" },
      ],
    });
    expect(result.joins).toHaveLength(1);
    expect(result.joins[0]?.failed).toBe(1);
    expect(result.joins[0]?.message).toContain("t2 失败(tsc)");
  });

  it("delegate 分桶不改变并发计费(concurrency=1 时 slots 仍 1)", () => {
    const result = delegate(root, {
      tasks: [
        { id: "t1", group: "g1", agentId: "a1" },
        { id: "t2", group: "g2", agentId: "a2" },
      ],
      concurrency: 1,
    });
    expect(result.plan.concurrency).toBe(1);
    expect(result.plan.slots).toBe(1);
  });

  it("report 汇总 owner 分布与孤儿进程", () => {
    seed();
    handoff(root, { processId: "p1", fromAgent: "a1", toAgent: "a2", purpose: "x" });
    inventory(root, "a1");
    // 手工追加一条 owner 已不存在的进程行,模拟代理被清出注册表的历史
    writeFileSync(
      handoffPath(root),
      `${readFileSync(handoffPath(root), "utf8")}${JSON.stringify({
        v: 1,
        type: "process",
        at: 1,
        id: "ghost",
        owner: "gone",
      })}\n`,
      "utf8",
    );
    const report = reportHandoff(root);
    expect(report.agents).toBe(2);
    expect(report.processes).toBe(2);
    expect(report.handoffs).toBe(1);
    expect(report.owners).toEqual({ a2: 1, gone: 1 });
    expect(report.orphaned).toEqual(["ghost"]);
    expect(report.handedOff.a1).toEqual(["p1"]);
    expect(report.codes).toContain("HANDOFF_INVENTORY");
  });
});

describe("坏行容忍与 append-only", () => {
  it("坏 JSON / 版本不符 / 未知 type 只计入 parseErrors,好行照常重放", () => {
    writeLines([
      "not-json",
      { v: 2, type: "agent", at: 1, id: "a2" },
      { v: 1, type: "mystery", at: 1 },
      { v: 1, type: "agent", at: 1, id: "a1", maxHandoffs: 3 },
    ]);
    const ledger = loadHandoff(root);
    expect(ledger.totalLines).toBe(4);
    expect(ledger.parseErrors).toBe(3);
    expect(ledger.registry.agents.a1?.maxHandoffs).toBe(3);
    expect(ledger.registry.agents.a2).toBeUndefined();
  });

  it("重放遇到非法交接只记 replayRejects,不回滚后续行", () => {
    writeLines([
      { v: 1, type: "process", at: 1, id: "p1", owner: "a1" },
      {
        v: 1,
        type: "handoff",
        at: 2,
        processId: "p1",
        fromAgent: "a9",
        toAgent: "a2",
        purpose: "抢",
      },
      {
        v: 1,
        type: "handoff",
        at: 3,
        processId: "p1",
        fromAgent: "a1",
        toAgent: "a2",
        purpose: "正规",
      },
    ]);
    const ledger = loadHandoff(root);
    expect(ledger.replayRejects).toBe(1);
    expect(ledger.handoffs).toHaveLength(1);
    expect(ledger.registry.processes.p1?.owner).toBe("a2");
    expect(ledger.registry.processes.p1?.handoffs).toBe(1);
  });

  it("append-only:多次操作后每行都保留(总行数=各操作行数之和)", () => {
    seed();
    handoff(root, { processId: "p1", fromAgent: "a1", toAgent: "a2", purpose: "x" });
    inventory(root, "a1");
    delegate(root, { tasks: [{ id: "t1", group: "g1", agentId: "a1" }], concurrency: 1 });
    expect(lines()).toHaveLength(5);
    expect(loadHandoff(root).counts).toEqual({
      agent: 1,
      process: 1,
      handoff: 1,
      delegate: 1,
      inventory: 1,
    });
  });
});
