/**
 * 命中率告警落账去重( §4.6.2 缺口2)。
 * 断言:不达标要落 prefix.cache.warn、达标不落、同一严重度不重复刷、升级要再落。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { notePrefixCacheHealth, resetPrefixCacheAlerts } from "../src/prefix-cache-alert";

const health = (verdict: string, calls = 10) => ({
  verdict, hitRate: verdict === "ok" ? 0.99 : 0.97, target: 0.985, block: 0.95,
  calls, inputTokens: 1000, cachedTokens: verdict === "ok" ? 990 : 970, reason: "test",
});

describe("prefix-cache-alert", () => {
  beforeEach(() => resetPrefixCacheAlerts());

  it("低于目标(warn)→ 落一条 prefix.cache.warn,payload 带判定依据", () => {
    const journal = new MemoryJournal();
    expect(notePrefixCacheHealth("s1", health("warn"), journal)).toBe(true);
    const evs = journal.readAll().filter((e) => e.kind === "prefix.cache.warn");
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload).toMatchObject({ verdict: "warn", target: 0.985, calls: 10 });
  });

  it("高于阈值(ok)→ 不落告警;样本不足(insufficient)→ 也不落", () => {
    const journal = new MemoryJournal();
    expect(notePrefixCacheHealth("s2", health("ok"), journal)).toBe(false);
    expect(notePrefixCacheHealth("s2", health("insufficient"), journal)).toBe(false);
    expect(journal.readAll().filter((e) => e.kind === "prefix.cache.warn")).toHaveLength(0);
  });

  it("同一严重度不重复刷(面板每 2s 拉一次);升级到 block 才再落一条", () => {
    const journal = new MemoryJournal();
    expect(notePrefixCacheHealth("s3", health("warn"), journal)).toBe(true);
    expect(notePrefixCacheHealth("s3", health("warn"), journal)).toBe(false);
    expect(notePrefixCacheHealth("s3", health("warn"), journal)).toBe(false);
    expect(notePrefixCacheHealth("s3", health("block"), journal)).toBe(true);
    expect(journal.readAll().filter((e) => e.kind === "prefix.cache.warn")).toHaveLength(2);
  });

  it("恢复达标后可再次被告警(水位归零),不同会话互不影响", () => {
    const journal = new MemoryJournal();
    notePrefixCacheHealth("s4", health("warn"), journal);
    notePrefixCacheHealth("s4", health("ok"), journal);
    expect(notePrefixCacheHealth("s4", health("warn"), journal)).toBe(true);
    expect(notePrefixCacheHealth("s5", health("warn"), journal)).toBe(true);
    expect(journal.readAll().filter((e) => e.kind === "prefix.cache.warn")).toHaveLength(3);
  });

  it("无 journal 时只走判定不落账(不炸)", () => {
    expect(notePrefixCacheHealth("s6", health("block"), undefined)).toBe(false);
  });
});