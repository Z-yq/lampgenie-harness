import { describe, it, expect } from "vitest";
import type { Task } from "@lampgenie/protocol";
import { taskIndexOf, taskIndexList } from "../src/task-index.js";

/**
 * 列表载荷索引化:hello/task.list/task.changed 只发 TaskIndex。
 * 这里锁两件事:①注意规模下帧长有界且远小于全文(机制性断言,不靠单点魔法数);
 * ②投影白名单——正文/凭证类字段一个都不许漏进列表帧。
 */

function task(n: number, opts: { instruction?: string; result?: string } = {}): Task {
 // 注意规模:数百任务 × 每条 instruction/result 各 2000 字符;标题走中文 30 字(真实用户输入口径)。
  const title = "帮我检查网关服务的启动日志并汇总异常原因报告整理文档提交审阅"; // 中文 30 字
  const instruction = opts.instruction ?? `${title}\n${"细节说明".repeat(500)}`.slice(0, 2000);
  const result = opts.result ?? "输出结果".repeat(500).slice(0, 2000);
  return {
    id: `task-${String(n).padStart(4, "0")}-abcdefgh`,
    sessionId: `sess-${n}`,
    instruction,
    state: n % 7 === 0 ? "failed" : n % 3 === 0 ? "running" : "done",
    createdAt: 1_700_000_000_000 + n,
    updatedAt: 1_700_000_000_000 + n,
    result,
    projectId: `/repo/p${n % 5}`,
    group: n % 4 === 0 ? "批次" : undefined,
    pinned: n % 11 === 0 ? true : undefined,
    archived: n % 13 === 0 ? true : undefined,
    titleCustom: n % 17 === 0 ? true : undefined,
    startedAt: 1_700_000_000_000 + n,
  };
}

describe("taskIndexList 载荷索引化", () => {
  const list = Array.from({ length: 623 }, (_, i) => task(i));

  it("623 条实测确认规模:索引帧 ≤256KB 且 ≤ 全文的 25%", () => {
    const indexJson = JSON.stringify(taskIndexList(list));
    const fullJson = JSON.stringify(list);
    // 诊断输出:断言失败时能直接看到实际字节数,便于校准。
    console.log(`[task-index] 623 条索引帧=${indexJson.length}B 全文帧=${fullJson.length}B 占比=${(indexJson.length / fullJson.length * 100).toFixed(1)}%`);
    expect(fullJson.length).toBeGreaterThan(2_000_000); // 前提:全文规模确实到 2MB 量级(否则比例断言无意义)
    expect(indexJson.length).toBeLessThanOrEqual(256 * 1024);
    expect(indexJson.length).toBeLessThanOrEqual(fullJson.length * 0.25);
  });

  it("逐条投影不含正文/凭证类字段", () => {
    const BANNED = ["instruction", "result", "error", "attachments", "resourceTags", "idempotencyKey", "credentialRef", "targetNode"];
    for (const idx of taskIndexList(list)) {
      for (const k of BANNED) expect(Object.prototype.hasOwnProperty.call(idx, k), `索引不得含 ${k}`).toBe(false);
    }
  });

  it("保留索引所需字段(含 optional 字段透传)", () => {
    const idx = taskIndexOf(list[0]!);
    for (const k of ["id", "sessionId", "state", "updatedAt", "createdAt", "title"]) {
      expect(idx[k as keyof typeof idx], `缺字段 ${k}`).toBeDefined();
    }
    // list[0]:projectId 有、group/pinned/archived/titleCustom 无(n%4/n%11/n%13/n%17 均不命中)
    expect(idx.projectId).toBe("/repo/p0");
    expect(idx.startedAt).toBeDefined();
    expect(idx.id).toBe(list[0]!.id);
    expect(idx.sessionId).toBe(list[0]!.sessionId);
    expect(idx.state).toBe(list[0]!.state);
    expect(idx.updatedAt).toBe(list[0]!.updatedAt);
    expect(idx.createdAt).toBe(list[0]!.createdAt);
    // 带 optional 的那条:index 4(group)/44(pinned+group)/52(archived+group)/68(titleCustom+group)
    const withOpt = taskIndexOf(list[4]!);
    expect(withOpt.group).toBe("批次");
    const pinned = taskIndexOf(list[44]!);
    expect(pinned.pinned).toBe(true);
    const archived = taskIndexOf(list[52]!);
    expect(archived.archived).toBe(true);
    const custom = taskIndexOf(list[68]!);
    expect(custom.titleCustom).toBe(true);
  });

  it("title 派生口径:单行短句/多行首行/>40 截断/空指令回落 id", () => {
    const base = { id: "abcdef1234567890", sessionId: "s", state: "done" as const, createdAt: 1, updatedAt: 1 };
    // 单行短句(无 title)→ 该句
    expect(taskIndexOf({ ...base, instruction: "修一下登录页的重定向" }).title).toBe("修一下登录页的重定向");
    // 多行 → 首行(首行内空白压缩)
    expect(taskIndexOf({ ...base, instruction: "第一行摘要\n第二行细节\n第三行" }).title).toBe("第一行摘要");
    // >40 字符 → 40 + "…"
    const long = "这是一条非常长的任务说明用于检验标题截断口径是否按四十字符执行且带省略号后缀并且还需要再补几个字凑够超长";
    const t = taskIndexOf({ ...base, instruction: long }).title;
    expect(t.length).toBe(41);
    expect(t.endsWith("…")).toBe(true);
    expect(t.slice(0, 40)).toBe(long.slice(0, 40));
    // 空 instruction 且无 title → id 前 8 位
    expect(taskIndexOf({ ...base, instruction: "   " }).title).toBe("abcdef12");
    // 显式 title 优先
    expect(taskIndexOf({ ...base, title: "用户命名", instruction: "别的内容" }).title).toBe("用户命名");
  });
});