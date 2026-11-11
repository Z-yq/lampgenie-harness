/**
 * RSI 只读聚合器(collectRsiStatus):12 区顺序 / UNAVAILABLE 降级 / 注入 readers /
 * 区级异常隔离 / metrics 上限 / tone 合法性 / 确定性 / 只读性。
 * 全部用例只写 os.tmpdir 下的临时目录,绝不碰仓库 .genie。
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RSI_SECTION_IDS,
  RSI_SECTION_TITLES,
  collectRsiStatus,
  type RsiStatusReaders,
  type RsiStatusSection,
} from "../src/rsi-status";

const tempDirs: string[] = [];

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsi-status-"));
  tempDirs.push(root);
  return root;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

function byId(sections: RsiStatusSection[], id: string): RsiStatusSection {
  const found = sections.find((section) => section.id === id);
  if (found === undefined) throw new Error(`missing section ${id}`);
  return found;
}

const NONE: Partial<RsiStatusReaders> = {};

describe("collectRsiStatus:结构与顺序", () => {
  it("12 区齐全且顺序固定,title 全为中文短名", async () => {
    const root = await freshRoot();
    const out = await collectRsiStatus({ root, readers: NONE });
    expect(out.sections.map((section) => section.id)).toEqual([
      "nightly",
      "evidence",
      "experiments",
      "cost",
      "injection",
      "tools",
      "changeRequests",
      "cohort",
      "negativeKb",
      "prompts",
      "atlas",
      "pathology",
    ]);
    expect(out.sections.length).toBe(12);
    for (const section of out.sections) {
      expect(section.title).toBe(RSI_SECTION_TITLES[section.id as (typeof RSI_SECTION_IDS)[number]]);
      expect(section.title.trim().length).toBeGreaterThan(0);
      expect(Array.isArray(section.metrics)).toBe(true);
      expect(Array.isArray(section.warnings)).toBe(true);
    }
  });

  it("okCount/warnCount 之和恒为 12", async () => {
    const root = await freshRoot();
    const out = await collectRsiStatus({ root, readers: NONE });
    expect(out.okCount + out.warnCount).toBe(12);
  });

  it("同一 now 两次调用结果一致(确定性)", async () => {
    const root = await freshRoot();
    const a = await collectRsiStatus({ root, now: 1700000000000, readers: NONE });
    const b = await collectRsiStatus({ root, now: 1700000000000, readers: NONE });
    expect(a.at).toBe(1700000000000);
    expect(b.at).toBe(a.at);
    expect(b).toEqual(a);
  });

  it("now 缺省用 Date.now", async () => {
    const root = await freshRoot();
    const before = Date.now();
    const out = await collectRsiStatus({ root, readers: NONE });
    const after = Date.now();
    expect(out.at).toBeGreaterThanOrEqual(before);
    expect(out.at).toBeLessThanOrEqual(after);
  });

  it("journal 可选:传与不传结果相同", async () => {
    const root = await freshRoot();
    const withJournal = await collectRsiStatus({ root, now: 1, journal: { any: "thing" }, readers: NONE });
    const without = await collectRsiStatus({ root, now: 1, readers: NONE });
    expect(withJournal).toEqual(without);
  });
});

describe("collectRsiStatus:空 store 降级", () => {
  it("临时空目录下 12 区全 UNAVAILABLE 且不 throw", async () => {
    const root = await freshRoot();
    const out = await collectRsiStatus({ root, readers: NONE });
    expect(out.okCount).toBe(0);
    expect(out.warnCount).toBe(12);
    for (const section of out.sections) {
      expect(section.ok).toBe(false);
      expect(section.code).toBe("UNAVAILABLE");
      expect(section.metrics).toEqual([]);
      expect(section.warnings.length).toBeGreaterThan(0);
    }
  });

  it("缺省 reader 跑完不创建任何目录/文件(只读)", async () => {
    const root = await freshRoot();
    await collectRsiStatus({ root, readers: NONE });
    expect(await readdir(root)).toEqual([]);
  });

  it("空 root 字符串也不 throw", async () => {
    const out = await collectRsiStatus({ root: "", readers: NONE });
    expect(out.sections.length).toBe(12);
    expect(out.okCount).toBe(0);
  });

  it("nightly 目录存在但无 run → 该区 ok:true 且运行数为 0", async () => {
    const root = await freshRoot();
    await mkdir(join(root, ".genie", "rsi", "nightly"), { recursive: true });
    const out = await collectRsiStatus({ root, now: 1, readers: NONE });
    const nightly = byId(out.sections, "nightly");
    expect(nightly.ok).toBe(true);
    expect(nightly.metrics.find((metric) => metric.label === "运行数")?.value).toBe(0);
    expect(out.warnCount).toBeGreaterThan(0);
  });
});

describe("collectRsiStatus:注入 readers", () => {
  it("三个 ok + 一个 warn → okCount 3 / warnCount 9", async () => {
    const root = await freshRoot();
    const out = await collectRsiStatus({
      root,
      now: 1,
      readers: {
        nightly: () => ({ ok: true, metrics: [{ label: "运行数", value: 2 }], warnings: [] }),
        evidence: () => ({ ok: true, metrics: [{ label: "节点", value: 7 }] }),
        experiments: async () => ({ ok: true, metrics: [{ label: "总数", value: 3 }] }),
        cost: () => ({ ok: false, code: "BREAKER_PAUSED", metrics: [{ label: "熔断", value: "paused", tone: "bad" }] }),
      },
    });
    expect(out.okCount).toBe(3);
    expect(out.warnCount).toBe(9);
    expect(byId(out.sections, "cost").code).toBe("BREAKER_PAUSED");
  });

  it("只注入一区:其余区仍为 UNAVAILABLE", async () => {
    const root = await freshRoot();
    const out = await collectRsiStatus({
      root,
      now: 1,
      readers: { prompts: () => ({ ok: true, metrics: [{ label: "活跃版本", value: 4, unit: "个" }] }) },
    });
    expect(byId(out.sections, "prompts").ok).toBe(true);
    expect(byId(out.sections, "prompts").metrics[0]).toEqual({ label: "活跃版本", value: 4, unit: "个", tone: "ok" });
    for (const section of out.sections) {
      if (section.id === "prompts") continue;
      expect(section.code).toBe("UNAVAILABLE");
    }
  });

  it("单区 throw 被隔离:该区 ERROR,其它区照常", async () => {
    const root = await freshRoot();
    const out = await collectRsiStatus({
      root,
      now: 1,
      readers: {
        cost: () => {
          throw new Error("boom");
        },
        cohort: () => ({ ok: true, metrics: [{ label: "交付数", value: 1 }] }),
      },
    });
    const cost = byId(out.sections, "cost");
    expect(cost.ok).toBe(false);
    expect(cost.code).toBe("ERROR");
    expect(cost.warnings[0]).toBe("boom");
    expect(byId(out.sections, "cohort").ok).toBe(true);
    expect(out.sections.length).toBe(12);
  });

  it("异常文本截断到 160 字", async () => {
    const root = await freshRoot();
    const out = await collectRsiStatus({
      root,
      now: 1,
      readers: {
        atlas: () => {
          throw new Error("x".repeat(500));
        },
      },
    });
    expect(byId(out.sections, "atlas").warnings[0]?.length).toBe(160);
  });

  it("reader 返回 undefined / 空对象 / null → UNAVAILABLE", async () => {
    const root = await freshRoot();
    const out = await collectRsiStatus({
      root,
      now: 1,
      readers: {
        nightly: () => undefined,
        evidence: () => ({}),
        tools: () => null,
      },
    });
    for (const id of ["nightly", "evidence", "tools"]) {
      expect(byId(out.sections, id).ok).toBe(false);
      expect(byId(out.sections, id).code).toBe("UNAVAILABLE");
    }
  });

  it("reader 返回 ok:false + 自定义 code → code 保留", async () => {
    const root = await freshRoot();
    const out = await collectRsiStatus({
      root,
      now: 1,
      readers: { cohort: () => ({ ok: false, code: "NO_DATA", metrics: [{ label: "交付数", value: 0, tone: "warn" }] }) },
    });
    const cohort = byId(out.sections, "cohort");
    expect(cohort.ok).toBe(false);
    expect(cohort.code).toBe("NO_DATA");
    expect(cohort.metrics[0]?.tone).toBe("warn");
  });

  it("ok:true 时不下发 code", async () => {
    const root = await freshRoot();
    const out = await collectRsiStatus({ root, now: 1, readers: { prompts: () => ({ ok: true, code: "SHOULD_DROP" }) } });
    expect(byId(out.sections, "prompts").code).toBeUndefined();
  });
});

describe("collectRsiStatus:metrics 归一", () => {
  it("metrics 超过 8 条被截断", async () => {
    const root = await freshRoot();
    const many = Array.from({ length: 12 }, (_unused, index) => ({ label: `m${index}`, value: index }));
    const out = await collectRsiStatus({ root, now: 1, readers: { evidence: () => ({ ok: true, metrics: many }) } });
    const metrics = byId(out.sections, "evidence").metrics;
    expect(metrics.length).toBe(8);
    expect(metrics[7]?.label).toBe("m7");
  });

  it("tone 只允许 ok/warn/bad,缺省或非法值归 ok", async () => {
    const root = await freshRoot();
    const out = await collectRsiStatus({
      root,
      now: 1,
      readers: {
        injection: () => ({
          ok: true,
          metrics: [
            { label: "a", value: 1 },
            { label: "b", value: 1, tone: "weird" as "ok" },
            { label: "c", value: 1, tone: "bad" },
            { label: "d", value: 1, tone: "warn" },
          ],
        }),
      },
    });
    const tones = byId(out.sections, "injection").metrics.map((metric) => metric.tone);
    expect(tones).toEqual(["ok", "ok", "bad", "warn"]);
    for (const section of out.sections) {
      for (const metric of section.metrics) expect(["ok", "warn", "bad"]).toContain(metric.tone);
    }
  });

  it("value 归一为 string|number(boolean/NaN/对象/undefined)", async () => {
    const root = await freshRoot();
    const out = await collectRsiStatus({
      root,
      now: 1,
      readers: {
        negativeKb: () => ({
          ok: true,
          metrics: [
            { label: "num", value: 5 },
            { label: "bool", value: true },
            { label: "nan", value: Number.NaN },
            { label: "text", value: "12" },
            { label: "none", value: undefined },
            { label: "obj", value: { a: 1 } as unknown as string },
          ],
        }),
      },
    });
    const metrics = byId(out.sections, "negativeKb").metrics;
    expect(metrics.map((metric) => metric.label)).toEqual(["num", "bool", "nan", "text", "obj"]);
    expect(metrics[0]?.value).toBe(5);
    expect(metrics[1]?.value).toBe("true");
    expect(metrics[2]?.value).toBe("NaN");
    expect(metrics[3]?.value).toBe("12");
    expect(typeof metrics[4]?.value).toBe("string");
    for (const metric of metrics) expect(["string", "number"]).toContain(typeof metric.value);
  });

  it("label 缺失或空串的 metric 被丢弃", async () => {
    const root = await freshRoot();
    const out = await collectRsiStatus({
      root,
      now: 1,
      readers: {
        changeRequests: () => ({
          ok: true,
          metrics: [{ value: 1 }, { label: "  ", value: 2 }, { label: "保留", value: 3 }] as { label: string; value: number }[],
        }),
      },
    });
    expect(byId(out.sections, "changeRequests").metrics).toEqual([{ label: "保留", value: 3, tone: "ok" }]);
  });

  it("warnings 非数组被忽略,单条超 160 字被截断", async () => {
    const root = await freshRoot();
    const out = await collectRsiStatus({
      root,
      now: 1,
      readers: {
        pathology: () => ({ ok: true, warnings: "not-array" as unknown as string[] }),
        atlas: () => ({ ok: false, code: "CONFLICTS", warnings: ["y".repeat(300)] }),
      },
    });
    expect(byId(out.sections, "pathology").warnings).toEqual([]);
    expect(byId(out.sections, "atlas").warnings).toEqual(["y".repeat(160)]);
  });

  it("非对象返回值也被折成 UNAVAILABLE", async () => {
    const root = await freshRoot();
    const out = await collectRsiStatus({
      root,
      now: 1,
      readers: { tools: () => "oops" as unknown as undefined },
    });
    expect(byId(out.sections, "tools").code).toBe("UNAVAILABLE");
  });
});
