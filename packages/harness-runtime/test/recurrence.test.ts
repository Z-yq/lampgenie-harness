// @ts-nocheck — recurrence.nextRunAt 的行为锚:DST 边界 + 追赶语义 + 时区容错。
// 这些用例先于重写存在,作为重构的行为 oracle。
import { describe, it, expect } from "vitest";
import { nextRunAt, tidyRecurrence, tidyTimeZone } from "../src/task/recurrence";

const DAY = 86_400_000;

describe("recurrence 基础语义", () => {
  it("once 恒返回 null(不重复)", () => {
    expect(nextRunAt(Date.now() - DAY, "once")).toBe(null);
  });
  it("非法时间输入返回 null", () => {
    expect(nextRunAt(Number.NaN, "daily")).toBe(null);
    expect(nextRunAt(Date.now(), "daily", { now: Number.NaN })).toBe(null);
  });
  it("tidyRecurrence 收敛未知词到 once;tidyTimeZone 收敛非法时区到 UTC", () => {
    expect(tidyRecurrence(" weekly ")).toBe("weekly");
    expect(tidyRecurrence("nonsense")).toBe("once");
    expect(tidyTimeZone("Asia/Shanghai")).toBe("Asia/Shanghai");
    expect(tidyTimeZone("Not/AZone")).toBe("UTC");
    expect(tidyTimeZone("")).toBe("UTC");
  });
  it("daily:未来时刻原样返回该时刻;过去时刻追赶到今天/明天的同一壁钟时刻", () => {
    const now = Date.UTC(2026, 0, 15, 12, 0, 0); // 12:00 UTC
    const future = now + 3 * DAY;
    expect(nextRunAt(future, "daily", { now })).toBe(future);
    const past = Date.UTC(2026, 0, 10, 12, 0, 0);
    const next = nextRunAt(past, "daily", { now });
    // 追赶后必须严格大于 now,且落在 UTC 12:00 壁钟
    expect(next).toBeGreaterThan(now);
    expect(new Date(next).toISOString()).toContain("T12:00:00");
  });
  it("weekly:按 7 天步进追赶", () => {
    const now = Date.UTC(2026, 0, 15, 12, 0, 0);
    const start = Date.UTC(2026, 0, 5, 9, 0, 0); // 10 天前的周四 09:00
    const next = nextRunAt(start, "weekly", { now });
    expect(next).toBeGreaterThan(now);
    expect(new Date(next).getUTCUTCDay?.call?.(new Date(next)) ?? new Date(next).getUTCDay()).toBe(new Date(start).getUTCDay());
    expect(new Date(next).toISOString()).toContain("T09:00:00");
  });
});

describe("recurrence DST 边界(纽约时区)", () => {
 // 2026 年美国夏令时:3 月第二个周日02:30 本不存在(跳变);11 月第一个周日01:30 出现两次(重复)。
  it("跳变时刻(03-08 02:30 local):past 追赶后应落到合法时刻且严格前进", () => {
    // 目标壁钟 02:30 -05:00(EST);3/8 起 EDT。选 now 在 3/8 之后。
    const now = Date.UTC(2026, 2, 9, 12, 0, 0);
    const start = Date.UTC(2026, 0, 1, 7, 30, 0); // 02:30 EST = 07:30 UTC
    const next = nextRunAt(start, "daily", { now, timeZone: "America/New_York" });
    expect(next).toBeGreaterThan(now);
    // 跳变后 02:30 本地不存在:实现应取「跳变后第一个合法时刻」(前移),不回拨、不返回不存在时刻
    const inZone = new Date(next).toLocaleString("en-US", { timeZone: "America/New_York" });
    expect(inZone).toMatch(/3\/9\/2026|3\/10\/2026/);
  });
  it("重复时刻(11-01 01:30 local)取第一次出现(更早的 UTC 瞬间)", () => {
    // 01:30 EDT = 05:30 UTC;01:30 EST = 06:30 UTC。重复小时取最早。
    const now = Date.UTC(2026, 10, 1, 4, 0, 0); // 11-01 04:00 UTC,在第一次 01:30(05:30Z)之前
    const start = Date.UTC(2026, 9, 1, 5, 30, 0); // 历史上的 01:30(10 月仍 EDT)
    const next = nextRunAt(start, "daily", { now, timeZone: "America/New_York" });
    expect(next).toBe(Date.UTC(2026, 10, 1, 5, 30, 0));
  });
});

describe("recurrence weekdays 语义", () => {
  it("周末被跳过:周五的 daily 改 weekdays 追赶后落到周一", () => {
 // 是周五(UTC)。now=周六 12:00,目标壁钟 09:00(已过)。
    const now = Date.UTC(2026, 0, 17, 12, 0, 0); // 周六
    const start = Date.UTC(2026, 0, 16, 9, 0, 0); // 周五 09:00
    const next = nextRunAt(start, "weekdays", { now });
    const day = new Date(next).getUTCDay();
    expect([1, 2, 3, 4, 5]).toContain(day); // 不是周末
    expect(next).toBe(Date.UTC(2026, 0, 19, 9, 0, 0)); // 周一 09:00
  });
  it("weekdays 最多跨一个周末即产出结果(8 次尝试上限的护栏)", () => {
    const now = Date.UTC(2026, 0, 17, 0, 0, 0); // 周六凌晨
    const start = Date.UTC(2026, 0, 16, 9, 0, 0); // 周五 09:00
    const next = nextRunAt(start, "weekdays", { now });
    expect(next).toBe(Date.UTC(2026, 0, 19, 9, 0, 0)); // 周一 09:00
  });
});
