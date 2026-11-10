import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { todoTool } from "../src/agent-wiring.js";

const todoEvents = (journal: MemoryJournal) => journal.readAll().filter((e) => e.kind === "todo.updated");

describe(" todo_write 严格整表纪律", () => {
  it("空 items / 缺 items → 失败且不落 journal", async () => {
    const journal = new MemoryJournal();
    const tool = todoTool(journal, "s1");
    const a = await tool.execute({ items: [] });
    const b = await tool.execute({});
    expect(a).toContain("[todo_write] items 不能为空");
    expect(b).toContain("[todo_write] items 不能为空");
    expect(todoEvents(journal)).toHaveLength(0);
  });

  it("空 content → 失败并点名下标", async () => {
    const journal = new MemoryJournal();
    const tool = todoTool(journal, "s2");
    const out = await tool.execute({ items: [
      { content: "第一步", status: "pending" },
      { content: "   ", status: "pending" },
    ] });
    expect(out).toContain("[todo_write]");
    expect(out).toContain("items[1].content 不能为空");
    expect(todoEvents(journal)).toHaveLength(0);
  });

  it("超长 content(>120 字)→ 失败不截断", async () => {
    const journal = new MemoryJournal();
    const tool = todoTool(journal, "s3");
    const long = "字".repeat(121);
    const out = await tool.execute({ items: [{ content: long, status: "pending" }] });
    expect(out).toContain("items[0].content 超长");
    expect(todoEvents(journal)).toHaveLength(0);
  });

  it("重复 content(trim 后相同)→ 失败并点名两条", async () => {
    const journal = new MemoryJournal();
    const tool = todoTool(journal, "s4");
    const out = await tool.execute({ items: [
      { content: "回归", status: "pending" },
      { content: " 回归 ", status: "in_progress" },
    ] });
    expect(out).toContain("content 重复");
    expect(out).toContain("items[0]");
    expect(out).toContain("items[1]");
    expect(todoEvents(journal)).toHaveLength(0);
  });

  it("未知 status → 失败不静默归 pending", async () => {
    const journal = new MemoryJournal();
    const tool = todoTool(journal, "s5");
    const out = await tool.execute({ items: [{ content: "回归", status: "乱写" }] });
    expect(out).toContain('items[0].status 非法("乱写")');
    expect(todoEvents(journal)).toHaveLength(0);
  });

  it("未知键 → 失败并点名键与下标", async () => {
    const journal = new MemoryJournal();
    const tool = todoTool(journal, "s6");
    const out = await tool.execute({ items: [{ content: "回归", status: "pending", priority: "P0" }] });
    expect(out).toContain('[todo_write] items[0] 含未知键 "priority"');
    expect(todoEvents(journal)).toHaveLength(0);
  });

  it("2 个 in_progress 默认拒绝(说明进度失真与配置项)", async () => {
    const journal = new MemoryJournal();
    const tool = todoTool(journal, "s7");
    const out = await tool.execute({ items: [
      { content: "甲", status: "in_progress" },
      { content: "乙", status: "in_progress" },
    ] });
    expect(out).toContain("[todo_write]");
    expect(out).toContain("2 项 in_progress");
    expect(out).toContain("多个进行中会让进度失真");
    expect(out).toContain("agent.todoAllowParallelInProgress=true");
    expect(todoEvents(journal)).toHaveLength(0);
  });

  it("allowParallelInProgress=true → 2 个 in_progress 通过", async () => {
    const journal = new MemoryJournal();
    const tool = todoTool(journal, "s8", { allowParallelInProgress: true });
    const out = await tool.execute({ items: [
      { content: "甲", status: "in_progress" },
      { content: "乙", status: "in_progress" },
      { content: "丙", status: "completed" },
    ] });
    expect(out).toContain("已记录计划 3 项(1 完成/2 进行中)");
    const ev = todoEvents(journal);
    expect(ev).toHaveLength(1);
    expect((ev[0]!.payload as { items: unknown[] }).items).toHaveLength(3);
  });

  it("合法整表替换 → journal 内容与入参一致(completed 保留)", async () => {
    const journal = new MemoryJournal();
    const tool = todoTool(journal, "s9");
    const first = [
      { content: "步骤一", status: "completed" },
      { content: "步骤二", status: "in_progress" },
      { content: "步骤三", status: "pending" },
    ] as const;
    expect(await tool.execute({ items: first })).toContain("已记录计划 3 项(1 完成/1 进行中)");
    // 整表替换:第二次提交只保留入参内容(旧条目全部消失)
    const second = [
      { content: "步骤一", status: "completed" },
      { content: "新步骤", status: "in_progress" },
    ];
    expect(await tool.execute({ items: second })).toContain("已记录计划 2 项(1 完成/1 进行中)");
    const ev = todoEvents(journal);
    expect(ev).toHaveLength(2);
    expect((ev[1]!.payload as { items: unknown }).items).toEqual(second);
  });

  it("错误回执统一前缀且 ≤600 字", async () => {
    const journal = new MemoryJournal();
    const tool = todoTool(journal, "s10");
    const outs = [
      await tool.execute({ items: [] }),
      await tool.execute({ items: [{ content: "", status: "pending" }] }),
      await tool.execute({ items: [{ content: "字".repeat(200), status: "pending" }] }),
      await tool.execute({ items: [{ content: "x", status: "nope" }] }),
      await tool.execute({ items: [{ content: "x", status: "pending", extra: 1 }] }),
      await tool.execute({ items: [
        { content: "x", status: "in_progress" },
        { content: "y", status: "in_progress" },
      ] }),
    ];
    for (const out of outs) {
      expect(out.startsWith("[todo_write]")).toBe(true);
      expect(out.length).toBeLessThanOrEqual(600);
    }
    expect(todoEvents(journal)).toHaveLength(0);
  });
});
