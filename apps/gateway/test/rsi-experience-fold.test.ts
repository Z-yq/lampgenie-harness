/**
 * nightly 经验蒸馏质量门 + settle 折叠( W2)。
 * 钉住:① 样例候选过门 fold 成功;② 垃圾拒绝(短 body/坏类目/坏 name/无证据/超长 description);
 * ③ 同名同内容跳过(version 不涨);④ 同名异内容 fold-in(version+1);⑤ 每晚上限截断(≤5);
 * ⑥ failed run 零折叠;⑦ settle 重入幂等(标记防重复 fold);⑧ 缺省不注入 store 零行为差异。
 * 全部用例只写 os.tmpdir 下的临时根,绝不碰仓库 .genie 与真实经验库。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExperienceStore } from "@lampgenie/experience";
import {
  EXPERIENCE_FOLD_MAX_PER_NIGHT,
  assessExperienceCandidate,
  foldExperiencesFromResults,
  selectExperienceCandidates,
} from "../src/rsi-experience-gate.js";
import { settleRunRecord } from "../src/rsi-agent-runner.js";
import { getRun, type RsiRunRecord } from "../src/rsi-mechanism-store.js";

const BODY =
  "场景:夜间定向跑 vitest 时 workspace exports 解析到陈旧 dist,报 TS2307。做法:调试用 NODE_OPTIONS=--conditions=development 让 exports 指向 src。坑:验收命令仍须逐字跑,调试口径与验收口径分开记录,不能混报成功。";
const BODY_V2 = `${BODY} 补充:板面命令与实际执行命令不一致时,报告里必须如实注明差异。`;
const DESC = "定向 vitest 用 development 条件解析 src,避免陈旧 dist";

function expItem(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    id: "exp-1",
    title: "exp:coding/vitest-conditions-flag",
    summary: DESC,
    detail: BODY,
    evidence: "sessionId:sess-1; taskId:task-1",
    ...overrides,
  };
}

let root: string;
let store: ExperienceStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rsi-exp-fold-"));
  store = new ExperienceStore(join(root, "skills"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 写一条 nightly run 记录 + 结果文件(形状与 rsi-mechanism-store 磁盘布局一致)。 */
function writeRun(runId: string, status: "done" | "failed", items: Record<string, string>[]): RsiRunRecord {
  const dir = join(root, ".genie", "rsi", "agent-runs", "nightly");
  mkdirSync(dir, { recursive: true });
  const record: RsiRunRecord = {
    runId,
    mechanismId: "nightly",
    status,
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_001_000,
    ...(status === "failed" ? { error: "task interrupted" } : {}),
  };
  writeFileSync(join(dir, `${runId}.json`), JSON.stringify(record), "utf8");
  writeFileSync(join(dir, `${runId}.result.json`), JSON.stringify({ items }), "utf8");
  return record;
}

describe("质量门(纯函数)", () => {
  it("样例候选过门:refs 解析出 sessionId/taskId", () => {
    const verdict = assessExperienceCandidate(expItem());
    expect(verdict.codes).toEqual([]);
    expect(verdict.candidate).toMatchObject({
      category: "coding",
      name: "vitest-conditions-flag",
      description: DESC,
      refs: ["sessionId:sess-1", "taskId:task-1"],
    });
  });

  it("垃圾拒绝:短 body / 坏类目 / 坏 name / 无证据 / 超长 description 各断言", () => {
    expect(assessExperienceCandidate(expItem({ detail: "太短" })).codes).toContain("SHORT_BODY");
    expect(assessExperienceCandidate(expItem({ title: "exp:marketing/vitest-conditions-flag" })).codes).toContain("BAD_CATEGORY");
    expect(assessExperienceCandidate(expItem({ title: "exp:coding/Vitest_Flag" })).codes).toContain("BAD_NAME");
    expect(assessExperienceCandidate(expItem({ evidence: "台账里有一些痕迹" })).codes).toContain("NO_EVIDENCE");
    expect(assessExperienceCandidate(expItem({ summary: "长".repeat(61) })).codes).toContain("LONG_DESCRIPTION");
    const selection = selectExperienceCandidates([
      expItem({ id: "bad-1", detail: "太短" }),
      expItem({ id: "bad-2", title: "exp:marketing/vitest-conditions-flag" }),
      expItem({ id: "bad-3", title: "exp:coding/Vitest_Flag" }),
      expItem({ id: "bad-4", evidence: "" }),
      { id: "plain", title: "普通结论项", summary: "不是经验" },
    ]);
    expect(selection.accepted).toHaveLength(0);
    expect(selection.rejected).toHaveLength(4); // 普通结论项 NOT_EXPERIENCE 不算拒绝
  });
});

describe("折叠编排(store fold-in)", () => {
  it("样例候选 fold 成功:v1 落库,正文可读回", async () => {
    const outcome = await foldExperiencesFromResults(store, [expItem()]);
    expect(outcome).toMatchObject({ folded: 1, skipped: 0, rejected: 0, truncated: 0, errors: [] });
    const fm = store.read("coding", "vitest-conditions-flag");
    expect(fm?.version).toBe(1);
    expect(fm?.description).toBe(DESC);
    expect(store.readBody("coding", "vitest-conditions-flag")).toContain("场景:");
  });

  it("同名同内容跳过:version 不涨(防版本空转)", async () => {
    await foldExperiencesFromResults(store, [expItem()]);
    const second = await foldExperiencesFromResults(store, [expItem()]);
    expect(second).toMatchObject({ folded: 0, skipped: 1 });
    expect(store.read("coding", "vitest-conditions-flag")?.version).toBe(1);
  });

  it("同名异内容 fold-in:version+1", async () => {
    await foldExperiencesFromResults(store, [expItem()]);
    const second = await foldExperiencesFromResults(store, [expItem({ detail: BODY_V2 })]);
    expect(second).toMatchObject({ folded: 1, skipped: 0 });
    expect(store.read("coding", "vitest-conditions-flag")?.version).toBe(2);
    expect(store.readBody("coding", "vitest-conditions-flag")).toContain("补充:");
  });

  it("每晚上限截断:7 条合格候选只 fold 5,truncated=2", async () => {
    const items = Array.from({ length: 7 }, (_, i) =>
      expItem({ id: `exp-${i}`, title: `exp:coding/cap-test-${i}` }),
    );
    const selection = selectExperienceCandidates(items);
    expect(selection.accepted).toHaveLength(EXPERIENCE_FOLD_MAX_PER_NIGHT);
    expect(selection.truncated).toBe(2);
    const outcome = await foldExperiencesFromResults(store, items);
    expect(outcome.folded).toBe(5);
    expect(outcome.truncated).toBe(2);
    expect(store.read("coding", "cap-test-5")).toBeNull();
  });
});

describe("settle 主链(nightly run)", () => {
  it("done run:读结果项 → 质量门 → fold,标记落 run 记录", async () => {
    const record = writeRun("run-fold-1", "done", [expItem()]);
    const settled = await settleRunRecord({ root, experienceStore: store }, { id: "nightly", title: "夜间任务" }, record);
    expect(settled.warnings).toEqual([]);
    expect(settled.run.experienceFold).toMatchObject({ folded: 1, skipped: 0, rejected: 0, truncated: 0 });
    expect(store.read("coding", "vitest-conditions-flag")?.version).toBe(1);
    const persisted = await getRun(root, "nightly", "run-fold-1");
    expect(persisted?.experienceFold?.folded).toBe(1);
  });

  it("settle 重入幂等:第二次不重复 fold,version 不涨", async () => {
    const record = writeRun("run-fold-2", "done", [expItem()]);
    const first = await settleRunRecord({ root, experienceStore: store }, { id: "nightly", title: "夜间任务" }, record);
    const second = await settleRunRecord({ root, experienceStore: store }, { id: "nightly", title: "夜间任务" }, first.run);
    expect(second.run.experienceFold).toEqual(first.run.experienceFold);
    expect(store.read("coding", "vitest-conditions-flag")?.version).toBe(1);
  });

  it("failed/interrupted run 零折叠", async () => {
    const record = writeRun("run-fold-3", "failed", [expItem()]);
    const settled = await settleRunRecord({ root, experienceStore: store }, { id: "nightly", title: "夜间任务" }, record);
    expect(settled.run.experienceFold).toBeUndefined();
    expect(store.read("coding", "vitest-conditions-flag")).toBeNull();
  });

  it("缺省不注入 store:零行为差异(不折叠、无标记)", async () => {
    const record = writeRun("run-fold-4", "done", [expItem()]);
    const settled = await settleRunRecord({ root }, { id: "nightly", title: "夜间任务" }, record);
    expect(settled.run.experienceFold).toBeUndefined();
    expect(store.read("coding", "vitest-conditions-flag")).toBeNull();
  });

  it("非 nightly 机制 done run 不折叠", async () => {
    const dir = join(root, ".genie", "rsi", "agent-runs", "evidence");
    mkdirSync(dir, { recursive: true });
    const record: RsiRunRecord = {
      runId: "run-fold-5",
      mechanismId: "evidence",
      status: "done",
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_001_000,
    };
    writeFileSync(join(dir, "run-fold-5.json"), JSON.stringify(record), "utf8");
    writeFileSync(join(dir, "run-fold-5.result.json"), JSON.stringify({ items: [expItem()] }), "utf8");
    const settled = await settleRunRecord({ root, experienceStore: store }, { id: "evidence", title: "证据图" }, record);
    expect(settled.run.experienceFold).toBeUndefined();
    expect(store.read("coding", "vitest-conditions-flag")).toBeNull();
  });
});
