import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
// bq5 板质量基线表:纯函数 aggregateBoardQuality 的 fixture 单测。
// fixture 全部用相对 nowMs 的时间戳构造,窗口逻辑可精确断言。
import { describe, expect, it } from "vitest";
import { aggregateBoardQuality } from "../src/board-quality-baseline.js";

const NOW = 1793840000000; // 固定基准,毫秒
const HOUR = 3600000;
const DAY = 86400000;

function ev(kind: string, payload: Record<string, unknown>, dtMs: number, sessionId = "s1"): string {
  return JSON.stringify({ seq: 1, kind, sessionId, time: NOW + dtMs, payload });
}

function audit(overrides: Record<string, unknown> = {}, dtMs = -HOUR): string {
  const base: Record<string, unknown> = {
    taskId: "t1",
    boardType: "code",
    ok: true,
    grand: { total: 10, passed: 9, rate: 0.9 },
    planQuality: {
      nodes: 12,
      contentNodes: 8,
      anchorDensity: 0.6,
      p0: { passed: 2, total: 3, rate: 2 / 3 },
    },
    issueCounts: { contract: 1, type: 0, symbol: 2, target: 1 },
    skeletonPrefilled: 3,
    snapshotFp: "aabbccddeeff0011",
    auditPath: "/tmp/x.json",
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return ev("board.audit", base, dtMs);
}

function skel(overrides: Record<string, unknown> = {}, dtMs = -HOUR): string {
  const base: Record<string, unknown> = {
    taskId: "t1",
    boardId: "b1",
    status: "ok",
    generated: 10,
    landedCount: 8,
    elidedRate: 0.2,
    dropped: { broken: 1, movedUnresolved: 0, targetMissing: 1, targetOutside: 0, nodesDropped: 2 },
  };
  Object.assign(base, overrides);
  return ev("board.skeleton", base, dtMs);
}

function quality(taskId: string, skeleton: Record<string, unknown> | undefined, dtMs = -HOUR): string {
  const payload: Record<string, unknown> = { type: "task.quality", taskId, planQuality: {} };
  if (skeleton) payload.skeleton = skeleton;
  return ev("custom", payload, dtMs);
}

describe("aggregateBoardQuality 板型质量表", () => {
  it("①两板型(code/ui)各 audits/ok率/issue 均次/P0 覆盖均值精确断言", () => {
    const lines = [
      audit({ taskId: "a1" }, -2 * HOUR),
      // 第二条 code:ok=false、issueCounts 不同、P0 4/4、锚密度 0.8
      audit(
        {
          taskId: "a2",
          ok: false,
          issueCounts: { contract: 0, type: 1, symbol: 0, target: 3 },
          planQuality: {
            nodes: 10,
            contentNodes: 6,
            anchorDensity: 0.8,
            p0: { passed: 4, total: 4, rate: 1 },
          },
        },
        -HOUR,
      ),
      ev(
        "board.audit",
        {
          taskId: "a3",
          boardType: "ui",
          ok: true,
          grand: { total: 5, passed: 5, rate: 1 },
          planQuality: {
            nodes: 6,
            contentNodes: 4,
            anchorDensity: 0.5,
            p0: { passed: 1, total: 2, rate: 0.5 },
          },
          issueCounts: { contract: 2, type: 0, symbol: 0, target: 0 },
        },
        -HOUR,
      ),
    ];
    const md = aggregateBoardQuality(lines, NOW, 7);
    // code:audits=2 ok率=0.5 契约均次=(1+0)/2=0.5 板型门=(0+1)/2=0.5 幻影=(2+0)/2=1 targets=(1+3)/2=2
    // P0 覆盖均值=(2/3+1)/2≈0.833 锚密度均值=(0.6+0.8)/2=0.7
    expect(md).toContain("| code | 2 | 0.5 | 0.5 | 0.5 | 1 | 2 | 0.833 | 0.7 |");
    // ui:audits=1 ok率=1 契约均次=2 P0=1/2=0.5 锚密度=0.5
    expect(md).toContain("| ui | 1 | 1 | 2 | 0 | 0 | 0 | 0.5 | 0.5 |");
    expect(md).toContain("## 板型质量");
    expect(md).toContain(
      "| 板型 | audits | ok率 | 契约均次 | 板型门均次 | 幻影均次 | targets均次 | P0覆盖均值 | 锚密度均值 |",
    );
  });

  it("②grand.total=0 的审计不进覆盖率均值但进 audits", () => {
    const lines = [
      audit({ taskId: "a1" }, -2 * HOUR), // P0=2/3
      // grand.total=0:P0 覆盖不计,但 audits 计入;锚密度 0.9 仍计
      audit(
        {
          taskId: "a2",
          grand: { total: 0, passed: 0, rate: 0 },
          planQuality: {
            nodes: 3,
            contentNodes: 1,
            anchorDensity: 0.9,
            p0: { passed: 0, total: 0, rate: 0 },
          },
        },
        -HOUR,
      ),
    ];
    const md = aggregateBoardQuality(lines, NOW, 7);
    // audits=2(第二条 grand.total=0 也计入);ok/issueCounts 未覆盖用默认值→均次=默认值本身
    // P0 覆盖均值只算第一条=2/3≈0.667;锚密度=(0.6+0.9)/2=0.75
    expect(md).toContain("| code | 2 | 1 | 1 | 0 | 2 | 1 | 0.667 | 0.75 |");
  });

  it("③窗口外旧事件被剔除", () => {
    const lines = [
      audit({ taskId: "old" }, -8 * DAY), // 8 天前,7 天窗口外
      audit({ taskId: "new" }, -HOUR),
    ];
    const md = aggregateBoardQuality(lines, NOW, 7);
    expect(md).toContain("| code | 1 |");
    expect(md).not.toContain("| code | 2 |");
  });

  it("⑥boardType 缺省 \"(无板型)\"", () => {
    const md = aggregateBoardQuality([audit({ boardType: undefined }, -HOUR)], NOW, 7);
    expect(md).toContain("| (无板型) | 1 |");
  });

  it("⑦畸形行(非 JSON/缺字段)跳过不抛", () => {
    const lines = [
      "not-json{{{",
      "",
      "   ",
      JSON.stringify({ seq: 1, kind: "board.audit" }), // 无 payload/time → 窗口外剔除
      JSON.stringify({ seq: 1, kind: "unknown.kind", time: NOW, payload: {} }),
      JSON.stringify({ seq: 1, kind: "board.skeleton", time: NOW }), // 无 payload → 当 0 处理
      JSON.stringify([1, 2, 3]), // 非对象
      audit({ taskId: "a1" }, -HOUR),
    ];
    expect(() => aggregateBoardQuality(lines, NOW, 7)).not.toThrow();
    const md = aggregateBoardQuality(lines, NOW, 7);
    expect(md).toContain("| code | 1 |");
  });
});

describe("aggregateBoardQuality 骨架遥测", () => {
  it("使用率/采纳率/剔除率/rejected 次数精确断言", () => {
    const lines = [
      skel({ taskId: "t1", elidedRate: 0.2 }, -3 * HOUR),
      skel({ taskId: "t1", status: "rejected", elidedRate: 0.99 }, -2 * HOUR), // rejected 不进剔除率
      skel({ taskId: "t2", elidedRate: 0.4 }, -HOUR),
      quality("t1", { generated: 10, survived: 5, adoptionRate: 0.5 }, -2 * HOUR),
      quality("t2", undefined, -HOUR), // t2 无 skeleton → 采纳率只算 t1
    ];
    const md = aggregateBoardQuality(lines, NOW, 7);
    // 骨架任务数=去重{t1,t2}=2;结算任务数={t1,t2}=2 → 使用率=1
    // 采纳率=t1 唯一一条 0.5;剔除率=ok 事件 (0.2+0.4)/2=0.3;rejected=1
    expect(md).toContain("| 使用率 | 1 |");
    expect(md).toContain("| 采纳率 | 0.5 |");
    expect(md).toContain("| 剔除率 | 0.3 |");
    expect(md).toContain("| rejected 次数 | 1 |");
    expect(md).toContain("| 骨架任务数 | 2 |");
    expect(md).toContain("| 结算任务数 | 2 |");
  });
});

describe("aggregateBoardQuality 边界", () => {
  it("④采纳率取任务最新 task.quality(同 taskId 两条不同 adoptionRate,取后者)", () => {
    const lines = [
      quality("t1", { generated: 10, survived: 2, adoptionRate: 0.2 }, -3 * HOUR),
      quality("t1", { generated: 10, survived: 8, adoptionRate: 0.8 }, -HOUR), // 最新
      quality("t2", { generated: 6, survived: 3, adoptionRate: 0.5 }, -HOUR),
    ];
    const md = aggregateBoardQuality(lines, NOW, 7);
    // 采纳率=(0.8+0.5)/2=0.65
    expect(md).toContain("| 采纳率 | 0.65 |");
    expect(md).toContain("| 结算任务数 | 2 |");
  });

  it("⑤零事件空表不抛且含说明行", () => {
    expect(() => aggregateBoardQuality([], NOW, 7)).not.toThrow();
    const md = aggregateBoardQuality([], NOW, 7);
    expect(md).toContain("窗口内无事件");
    expect(md).toContain("## 板型质量");
    expect(md).toContain("| 指标 | 数值 |");
    expect(md).toContain("| 使用率 | n/a |");
  });
});

describe("默认 journal 目录发现(2026-11-05 实测缺陷:", () => {
  // 实测现场:apps/gateway/.genie/journals 是 10-18 残留(只有旧 gateway.jsonl+shots/),
  // 真源在仓根 .genie/journals(global.jsonl)。只判"目录存在"会把数据源指错并静默出空表。
  it("⑧cwd 向上有多个候选时,优先含 global.jsonl/sessions 数据者(而非最近的空壳)", () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), "gh-bq-default-"));
    try {
      const sub = path.join(root, "apps", "gateway");
      const stale = path.join(sub, ".genie", "journals"); // 近但无当轮数据
      const live = path.join(root, ".genie", "journals"); // 远但真源
      fs.mkdirSync(stale, { recursive: true });
      fs.writeFileSync(path.join(stale, "gateway.jsonl"), "{}\n", "utf8");
      fs.mkdirSync(path.join(live, "sessions"), { recursive: true });
      fs.writeFileSync(path.join(live, "global.jsonl"), "", "utf8");
      const script = path.resolve("src/board-quality-baseline.ts");
      const r = spawnSync(process.execPath, ["--experimental-strip-types", script, "--days", "7"], {
        cwd: sub,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env },
      });
      // 该 node 不支持 --experimental-strip-types 时跳过断言(本机默认 v20;环境要求 v24 跑 CLI)
      if (/bad option: --experimental-strip-types/.test(String(r.stderr ?? ""))) {
        expect(true).toBe(true);
        return;
      }
      expect(String(r.stdout)).toContain(`数据源目录:\`${live}\``);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
