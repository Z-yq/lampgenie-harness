/**
 * 团队活动周报聚合( §1 #23 / §2.7):按成员/类别降序 + 字典序稳定排序。
 */
import { describe, expect, it } from "vitest";
import { teamActivityDigest } from "../src/team/team-activity-digest.js";
import type { ActivityEvent } from "@lampgenie/protocol";

const ev = (ts: number, userId: string, category: ActivityEvent["category"], type = "x"): ActivityEvent => ({
  ts, userId, projectId: "p1", category, type, summary: "s",
});

describe("teamActivityDigest", () => {
  it("过滤 ts>=sinceTs,perMember/perCategory 计数降序 + 同数按 key 字典序", () => {
    const events: ActivityEvent[] = [
      ev(100, "bob", "task"),
      ev(200, "alice", "task"),
      ev(300, "alice", "teamai"),
      ev(400, "bob", "teamai"),
      ev(500, "bob", "doc"),
      ev(50, "carol", "task"), // 早于 sinceTs,应被过滤
    ];
    const d = teamActivityDigest(events, 100);
    expect(d.total).toBe(5);
    expect(d.perMember).toEqual([{ userId: "bob", count: 3 }, { userId: "alice", count: 2 }]);
    // task=2 / teamai=2 并列,同数按字典序 task < teamai;doc=1 最后
    expect(d.perCategory).toEqual([{ category: "task", count: 2 }, { category: "teamai", count: 2 }, { category: "doc", count: 1 }]);
  });

  it("边界:空事件/全部早于 sinceTs → 全 0;sinceTs 含等号", () => {
    expect(teamActivityDigest([], 0)).toEqual({ perMember: [], perCategory: [], total: 0 });
    expect(teamActivityDigest([ev(10, "a", "task")], 11).total).toBe(0);
    expect(teamActivityDigest([ev(10, "a", "task")], 10).total).toBe(1);
  });

  it("同计数时键序确定性(输入顺序不影响输出)", () => {
    const a = teamActivityDigest([ev(1, "zoe", "node"), ev(1, "amy", "build")], 0);
    const b = teamActivityDigest([ev(1, "amy", "build"), ev(1, "zoe", "node")], 0);
    expect(a).toEqual(b);
    expect(a.perMember).toEqual([{ userId: "amy", count: 1 }, { userId: "zoe", count: 1 }]);
  });
});
