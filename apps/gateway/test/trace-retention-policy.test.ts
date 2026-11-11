/**
 * 轨迹保留判定(纯逻辑层)。
 * 为什么单独测:窗口/证据两套钉扎规则是「删不删」的唯一裁决,它一旦错,后果不对称——
 * 判 DROP 判错=证据链断(不可恢复),判 keep 判错=多占磁盘(可回收)。所以逐条钉死:
 * ① 窗口起点语义(days 缺省/非法/<=0);② 三态优先级(证据 > 窗口 > DROP);③ 边界含等号;
 * ④ plan 分流(drop 绝不含 pinned)、确定性与不可变;⑤ migratePath 的路径穿越防护。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MINING_WINDOW_DAYS,
  TRACE_RETENTION_CODES,
  migratePathFor,
  miningWindowStart,
  planRetention,
  retentionVerdict,
} from "../src/trace-retention-policy.js";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

describe("miningWindowStart(挖掘窗口起点)", () => {
  it("days 缺省 = 7 天(DEFAULT_MINING_WINDOW_DAYS 与之一致)", () => {
    expect(DEFAULT_MINING_WINDOW_DAYS).toBe(7);
    expect(miningWindowStart({ now: NOW })).toBe(NOW - 7 * DAY);
    expect(miningWindowStart({ now: NOW, days: undefined })).toBe(NOW - 7 * DAY);
  });

  it("显式 days 生效(3 天)", () => {
    expect(miningWindowStart({ now: NOW, days: 3 })).toBe(NOW - 3 * DAY);
  });

  it("days=0 → 窗口起点=now(窗口不覆盖任何文件)", () => {
    expect(miningWindowStart({ now: NOW, days: 0 })).toBe(NOW);
  });

  it("days<0 → 窗口起点=now", () => {
    expect(miningWindowStart({ now: NOW, days: -5 })).toBe(NOW);
  });

  it("days 非法(NaN/Infinity)→ 窗口起点=now,不抛", () => {
    expect(miningWindowStart({ now: NOW, days: Number.NaN })).toBe(NOW);
    expect(miningWindowStart({ now: NOW, days: Number.POSITIVE_INFINITY })).toBe(NOW);
  });

  it("now 非法 → 回落到 Date.now(),仍在缺省窗口内", () => {
    const before = Date.now();
    const ws = miningWindowStart({ now: Number.NaN });
    const after = Date.now();
    expect(ws).toBeGreaterThanOrEqual(before - 7 * DAY);
    expect(ws).toBeLessThanOrEqual(after - 7 * DAY);
  });

  it("无参调用不抛(缺省 7 天)", () => {
    const before = Date.now();
    const ws = miningWindowStart();
    expect(ws).toBeGreaterThanOrEqual(before - 7 * DAY - 5);
  });
});

describe("TRACE_RETENTION_CODES", () => {
  it("四码齐全且顺序稳定(调用方按码断言)", () => {
    expect([...TRACE_RETENTION_CODES]).toEqual(["KEEP", "DROP", "PIN_EVIDENCE", "PIN_WINDOW"]);
  });
});

describe("retentionVerdict(单文件三态)", () => {
  const windowStart = NOW - 7 * DAY;

  it("证据引用 → PIN_EVIDENCE(远早于窗口也留)", () => {
    const v = retentionVerdict({
      sessionId: "web-evd",
      epoch: windowStart - 365 * DAY,
      now: NOW,
      windowStart,
      evidenceSessions: new Set(["web-evd"]),
    });
    expect(v).toMatchObject({ keep: true, pin: true, code: "PIN_EVIDENCE", reason: "evidence-source" });
  });

  it("窗口边界 epoch === windowStart → PIN_WINDOW(含等号)", () => {
    const v = retentionVerdict({ sessionId: "web-a", epoch: windowStart, now: NOW, windowStart });
    expect(v).toMatchObject({ keep: true, pin: true, code: "PIN_WINDOW", reason: "mining-window" });
  });

  it("窗口外 1ms → DROP", () => {
    const v = retentionVerdict({ sessionId: "web-a", epoch: windowStart - 1, now: NOW, windowStart });
    expect(v).toMatchObject({ keep: false, pin: false, code: "DROP", reason: "outside-window" });
  });

  it("证据优先于窗口(两者都满足时报 PIN_EVIDENCE)", () => {
    const v = retentionVerdict({
      sessionId: "web-evd",
      epoch: NOW - 1000,
      now: NOW,
      windowStart,
      evidenceSessions: new Set(["web-evd"]),
    });
    expect(v.code).toBe("PIN_EVIDENCE");
  });

  it("证据集用数组形态同样命中", () => {
    const v = retentionVerdict({
      sessionId: "web-evd",
      epoch: 0,
      now: NOW,
      windowStart,
      evidenceSessions: ["web-evd", "other"],
    });
    expect(v.code).toBe("PIN_EVIDENCE");
  });

  it("空 sessionId 不会被证据集误命中(即使集合里有空串)", () => {
    const v = retentionVerdict({
      sessionId: "",
      epoch: 0,
      now: NOW,
      windowStart,
      evidenceSessions: new Set([""]),
    });
    expect(v.code).toBe("DROP");
  });

  it("脏输入不抛:epoch 非数按 0 处理(有 now 时判 DROP);全缺时保守 keep", () => {
    const v = retentionVerdict({ sessionId: "x", epoch: Number.NaN, now: NOW } as never);
    expect(v.code).toBe("DROP");
 // 连 now/windowStart 都没有:窗口起点退化成 0、epoch 也退化成 0 → 边界相等=窗口内,
 // 拿不准时倾向 keep(不静默删掉可能被引用的现场),这是有意的保守退化。
    const v2 = retentionVerdict({} as never);
    expect(v2).toMatchObject({ keep: true, pin: true, code: "PIN_WINDOW" });
  });
});

describe("planRetention(批量分流)", () => {
  const windowStart = NOW - 7 * DAY;
  const files = [
    { path: "/t/s-evd/call-0001-t1s0-100.json", sessionId: "s-evd", epoch: 100 },
    { path: "/t/s-evd/call-0002-t1s0-200.json", sessionId: "s-evd", epoch: 200 },
    { path: "/t/s-win/call-0003-t1s0-" + (NOW - 1000) + ".json", sessionId: "s-win", epoch: NOW - 1000 },
    { path: "/t/s-old/call-0004-t1s0-300.json", sessionId: "s-old", epoch: 300 },
  ];

  it("三组分流正确:drop 不含 pinned,keep 含 pinned", () => {
    const plan = planRetention(files, { now: NOW, windowStart, evidenceSessions: new Set(["s-evd"]) });
    expect(plan.pinned).toEqual([files[0]!.path, files[1]!.path, files[2]!.path]);
    expect(plan.drop).toEqual([files[3]!.path]);
    expect(plan.keep).toEqual([files[0]!.path, files[1]!.path, files[2]!.path]);
    for (const p of plan.pinned) expect(plan.drop).not.toContain(p);
  });

  it("pinnedReason 按原因分类", () => {
    const plan = planRetention(files, { now: NOW, windowStart, evidenceSessions: new Set(["s-evd"]) });
    expect(plan.pinnedReason[files[0]!.path]).toBe("evidence-source");
    expect(plan.pinnedReason[files[1]!.path]).toBe("evidence-source");
    expect(plan.pinnedReason[files[2]!.path]).toBe("mining-window");
    expect(plan.pinnedReason[files[3]!.path]).toBeUndefined();
  });

  it("确定性:输入顺序不同,输出逐字相同(路径字典序)", () => {
    const a = planRetention(files, { now: NOW, windowStart, evidenceSessions: new Set(["s-evd"]) });
    const b = planRetention([...files].reverse(), { now: NOW, windowStart, evidenceSessions: new Set(["s-evd"]) });
    expect(b).toEqual(a);
  });

  it("不可变:入参数组与元素不被改动", () => {
    const snapshot = JSON.parse(JSON.stringify(files));
    const frozen = Object.freeze(files.map((f) => Object.freeze({ ...f })));
    planRetention(frozen, { now: NOW, windowStart });
    expect(JSON.parse(JSON.stringify(files))).toEqual(snapshot);
  });

  it("空输入 → 三组空 + 空原因表", () => {
    const plan = planRetention([], { now: NOW, windowStart });
    expect(plan).toEqual({ keep: [], drop: [], pinned: [], pinnedReason: {} });
  });

  it("未给 windowStart 时用 days 计算窗口(缺省 7 天)", () => {
    const plan = planRetention(files, { now: NOW, evidenceSessions: new Set(["s-evd"]) });
 // files[3] epoch=300 远在窗口外且无引用 → DROP
    expect(plan.drop).toEqual([files[3]!.path]);
  });

  it("非法条目(缺 path)被跳过,不抛", () => {
    const plan = planRetention([{ path: 123 } as never, null as never, files[3]!], { now: NOW, windowStart });
    expect(plan.drop).toEqual([files[3]!.path]);
  });
});

describe("migratePathFor(证据区迁移目标)", () => {
  it("基本形态:<root>/.genie/evidence/traces/<session>/<name>", () => {
    expect(migratePathFor("/repo", "web-a", "call-0001-t1s0-123.json")).toBe(
      "/repo/.genie/evidence/traces/web-a/call-0001-t1s0-123.json",
    );
  });

  it("`../` 穿越被净化(sessionId)", () => {
    const p = migratePathFor("/repo", "../../etc", "call-1-t1s0-1.json");
    expect(p.startsWith("/repo/.genie/evidence/traces/")).toBe(true);
    expect(p.split("/")).not.toContain("..");
  });

  it("文件名带分隔符/绝对路径不逃出证据区", () => {
    const p = migratePathFor("/repo", "web-a", "../../../etc/passwd");
    expect(p.startsWith("/repo/.genie/evidence/traces/web-a/")).toBe(true);
    expect(p.split("/")).not.toContain("..");
  });

  it("空 session/name 用占位段,不产生空路径段", () => {
    const p = migratePathFor("/repo", "", "");
    expect(p).toBe("/repo/.genie/evidence/traces/_session/_trace.json");
  });

  it("root 末尾分隔符被归一(不产生双斜杠)", () => {
    expect(migratePathFor("/repo/", "s", "n.json")).toBe("/repo/.genie/evidence/traces/s/n.json");
  });
});
