/**
 * 评审数据引用孤儿检查(board-store 边引用完整性同律):
 * 幻觉路径拒收/越界行号夹紧/deleted 文件 diff 独引/回写店孤儿对账。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFindingRefs, sweepStoreOrphans } from "../src/review/review-orphans";
import type { Finding } from "../src/review/index";
import type { ReviewTarget } from "../src/review/index";
import type { ReviewCommentStore } from "../src/review/writeback";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gh-orphans-"));
  writeFileSync(join(dir, "real.ts"), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n"));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "a.ts"), "x = 1\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function target(paths: string[]): ReviewTarget {
  return {
    kind: "uncommitted",
    files: paths.map((p) => ({ path: p, status: "deleted", diffText: "" })),
    totalLines: 0,
    truncated: false,
  };
}

function f(file: string, line = 1): Finding {
  return { file, line, severity: "warning", title: "t", detail: "d" };
}

describe("checkFindingRefs()", () => {
  it("工作树文件收录;越界行号夹到文件末行并计数", () => {
 // 契约:findings 必须在变更集内(target 列出受审文件)
    const r = checkFindingRefs(dir, target(["real.ts", "sub/a.ts"]), [f("real.ts", 10), f("real.ts", 9999), f("sub/a.ts", 0)]);
    expect(r.kept).toHaveLength(3);
    expect(r.orphans).toHaveLength(0);
    expect(r.clamped).toBe(2); // 9999→50,0→1
    expect(r.kept[0]!.line).toBe(10);
    expect(r.kept[1]!.line).toBe(50);
    expect(r.kept[2]!.line).toBe(1);
  });

  it("幻觉路径(两处都不在)拒收并 fail-visible;绝对路径/.. 越界拒收", () => {
    const r = checkFindingRefs(dir, target([]), [f("phantom.ts"), f("/etc/passwd"), f("../outside.ts")]);
    expect(r.kept).toHaveLength(0);
    expect(r.orphans).toHaveLength(3);
    expect(r.orphans[0]!.reason).toContain("不存在");
    expect(r.orphans[1]!.reason).toContain("越界");
    expect(r.orphans[2]!.reason).toContain("越界");
  });

  it("deleted 文件:不在工作树但在审查目标 → 收录并计 diffOnly", () => {
    const r = checkFindingRefs(dir, target(["legacy.ts"]), [f("legacy.ts")]);
    expect(r.kept).toHaveLength(1);
    expect(r.diffOnly).toBe(1);
    expect(r.orphans).toHaveLength(0);
  });

  it("路径逃出仓根(符号链接形态)拒收", () => {
    // real.ts 存在,但用 .. 拼出仓外等价路径 → 越界拒收
    const r = checkFindingRefs(dir, target([]), [f("sub/../real.ts")]);
    expect(r.orphans).toHaveLength(1);
    expect(r.orphans[0]!.reason).toContain("越界");
  });
});

describe("sweepStoreOrphans(,只报不删)", () => {
  it("文件已删/改名的条目记为孤儿;存量条目不被修改", () => {
    const store: ReviewCommentStore = {
      version: 1,
      comments: [
        { key: "aaa", path: "real.ts", line: 3, message: "m1", severity: "nit", postedAt: 1 },
        { key: "bbb", path: "gone.ts", line: 2, message: "m2", severity: "nit", postedAt: 2, resolvedAt: 3 },
      ],
    };
    const r = sweepStoreOrphans(dir, store);
    expect(r.missingFile).toHaveLength(1);
    expect(r.missingFile[0]!.key).toBe("bbb");
    expect(store.comments).toHaveLength(2); // 只报不删
  });
});

describe("变更集范围(2026-10-20 只审本 session 修改内容)", () => {
  it("存在但不在变更集的文件 → 范围外剔除(计数),不进 findings", () => {
    const r = checkFindingRefs(dir, target(["sub/a.ts"]), [f("real.ts"), f("sub/a.ts")]);
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0]!.file).toBe("sub/a.ts");
    expect(r.outOfScope).toBe(1);
    expect(r.orphans).toHaveLength(0);
  });
  it("幻觉路径仍按孤儿拒收(范围过滤不掩盖幻觉)", () => {
    const r = checkFindingRefs(dir, target([]), [f("phantom.ts")]);
    expect(r.orphans).toHaveLength(1);
    expect(r.outOfScope).toBe(0);
  });
  it("回写店孤儿对账也按变更集过滤:", () => {
    const store = { comments: [
      { key: "k1", path: "sub/a.ts", line: 1, body: "x" },
      { key: "k2", path: "gone.ts", line: 2, body: "y" },
    ] } as unknown as ReviewCommentStore;
    const scoped = sweepStoreOrphans(dir, store, new Set(["gone.ts"]));
    expect(scoped.missingFile.map((m) => m.path)).toEqual(["gone.ts"]);
    const unscoped = sweepStoreOrphans(dir, store);
    expect(unscoped.missingFile.length).toBeGreaterThanOrEqual(1);
  });
});
