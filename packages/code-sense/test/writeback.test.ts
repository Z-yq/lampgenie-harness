import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, loadStore, saveStore, normalizeMessage, findingKey, GitNoteWriteback, type ReviewCommentStore } from "../src/review/writeback";
import type { Finding } from "../src/review/index";

const F1: Finding = { file: "a.ts", line: 10, severity: "warning", title: "竞态风险", detail: "并发未加锁" };
const F2: Finding = { file: "b.ts", line: 3, severity: "nit", title: "命名", detail: "不符驼峰" };
const F3: Finding = { file: "c.ts", line: 7, severity: "blocker", title: "凭证", detail: "私钥入库", scenario: "提交即泄露" };

function tmpStore(): string {
  return join(mkdtempSync(join(tmpdir(), "gh-wb-")), ".genie", "review-comments.json");
}

describe("Review 行级回写(sticky/增量/幂等)", () => {
  it("纯函数 apply:首轮全发;重发同轮零新增", () => {
    const empty: ReviewCommentStore = { version: 1, comments: [] };
    const r1 = apply(empty, [F1, F2, F3], 1_000);
    expect(r1.report.posted).toHaveLength(3);
    expect(r1.report.changed).toBe(true);
    expect(r1.store.comments.map((c) => c.path).sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(r1.store.comments.every((c) => c.postedAt === 1_000)).toBe(true);
    // 入参未被 mutate(纯函数)
    expect(empty.comments).toHaveLength(0);
    // 同一批 findings 再 apply:全部 unchanged
    const r2 = apply(r1.store, [F1, F2, F3], 2_000);
    expect(r2.report.posted).toHaveLength(0);
    expect(r2.report.unchanged).toBe(3);
    expect(r2.report.changed).toBe(false);
    expect(r2.store.comments).toHaveLength(3);
  });

  it("稳定键:空白/换行差异不换键;行号/规则差异换键", () => {
    const k1 = findingKey({ file: "a.ts", line: 10, rule: "race", message: "并发  未加锁\n" });
    const k2 = findingKey({ file: "a.ts", line: 10, rule: "race", message: "并发 未加锁" });
    expect(k1).toBe(k2);
    expect(k1).not.toBe(findingKey({ file: "a.ts", line: 11, rule: "race", message: "并发 未加锁" }));
    expect(k1).not.toBe(findingKey({ file: "a.ts", line: 10, rule: "style", message: "并发 未加锁" }));
    expect(normalizeMessage("  a\n  b  ")).toBe("a b");
  });

  it("发现消失 → resolvedAt 标记不删除;复现 → 解除标记不重复;再消失再标记", () => {
    const { store } = apply({ version: 1, comments: [] }, [F1, F2], 1_000);
    // F1 消失
    const r2 = apply(store, [F2], 2_000);
    expect(r2.report.resolved.map((c) => c.path)).toEqual(["a.ts"]);
    expect(r2.report.changed).toBe(true);
    const resolved = r2.store.comments.find((c) => c.path === "a.ts")!;
    expect(resolved.resolvedAt).toBe(2_000);
    expect(r2.store.comments).toHaveLength(2); // 不删除
    // F1 复现:解除标记,无重复
    const r3 = apply(r2.store, [F1, F2], 3_000);
    expect(r3.report.reopened.map((c) => c.path)).toEqual(["a.ts"]);
    expect(r3.report.posted).toHaveLength(0);
    expect(r3.store.comments).toHaveLength(2);
    const revived = r3.store.comments.find((c) => c.path === "a.ts")!;
    expect(revived.resolvedAt).toBeUndefined();
    expect(revived.repostCount).toBe(1);
    // 再消失:再标记(resolved 重新计算,不叠加多条)
    const r4 = apply(r3.store, [F2], 4_000);
    expect(r4.report.resolved.map((c) => c.path)).toEqual(["a.ts"]);
    expect(r4.store.comments.filter((c) => c.path === "a.ts")).toHaveLength(1);
  });

  it("GitNoteWriteback:首轮落盘;同输入重跑零 diff(不落盘);双重保存字节一致", async () => {
    const path = tmpStore();
    const wb = new GitNoteWriteback(path);
    const r1 = wb.sync([F1, F2], 1_000);
    expect(r1.posted).toHaveLength(2);
    const bytes1 = readFileSync(path, "utf-8");
    // 同输入重跑:零变化不落盘
    const r2 = wb.sync([F1, F2], 5_000);
    expect(r2.posted).toHaveLength(0);
    expect(r2.unchanged).toBe(2);
    expect(r2.changed).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe(bytes1); // updatedAt 也没动(零 diff)
    // 双重保存同 store:字节一致(确定性序列化)
    const store = loadStore(path);
    saveStore(path, store);
    saveStore(path, store);
    expect(readFileSync(path, "utf-8")).toBe(bytes1);
  });

  it("损坏/缺失店文件 → 全新空店起步,不抛错", () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-wb2-"));
    const path = join(dir, "broken.json");
    writeFileSync(path, "{not json");
    const wb = new GitNoteWriteback(path);
    const r = wb.sync([F1], 1_000);
    expect(r.posted).toHaveLength(1); // 从零重建,不猜
    const loaded = loadStore(join(dir, "missing.json"));
    expect(loaded.comments).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
