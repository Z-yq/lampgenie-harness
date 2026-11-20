import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateShadow,
  foundryPath,
  listCandidates,
  mine,
  observe,
  register,
  report,
  retire,
  startShadow,
} from "../src/tool-foundry-store";

/** 每个用例独立临时 root:绝不碰仓库 .genie。 */
function tmpRoot(tag = "tf-store"): string {
  return mkdtempSync(join(tmpdir(), `${tag}-`));
}

/** 读 raw 行(用于断言「有没有落行」)。 */
function rawLines(root: string): string[] {
  const path = foundryPath(root);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "");
}

const SIGNATURE = "gh pr diff --stat && pnpm test";

function observationInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    signature: SIGNATURE,
    steps: ["gh pr diff --stat", "pnpm test"],
    cost: { tokens: 1000, wallMs: 5000, toolCalls: 5 },
    kind: "command-sequence",
    sessionId: "s-1",
    projectId: "p-1",
    success: true,
    ...overrides,
  };
}

/** 落地一组达标观测:2 project / 2 session / 4 次,3 成功 1 失败(timeout)。 */
function seedQualifying(root: string, signature = SIGNATURE): void {
  const seeds: Record<string, unknown>[] = [
    { sessionId: "s-1", projectId: "p-1", success: true },
    { sessionId: "s-2", projectId: "p-1", success: true },
    { sessionId: "s-1", projectId: "p-2", success: true },
    { sessionId: "s-2", projectId: "p-2", success: false, failureMode: "timeout" },
  ];
  for (const seed of seeds) {
    const result = observe(root, observationInput({ signature, ...seed }));
    expect(result.ok).toBe(true);
  }
}

/** mine 首个候选的 id(签名 → 确定性哈希,由 runtime 产出)。 */
function firstCandidateId(root: string): string {
  const result = mine(root);
  const candidate = result.candidates?.[0];
  expect(candidate).toBeDefined();
  return candidate!.id;
}

describe("tool-foundry-store:observe", () => {
  it("① 合法观察落一行 observation,投影可读", () => {
    const root = tmpRoot();
    const result = observe(root, observationInput());
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual(["FOUNDRY_OBSERVED"]);
    expect(result.observation?.signature).toBe(SIGNATURE);
    expect(rawLines(root)).toHaveLength(1);

    const summary = report(root);
    expect(summary.observations).toBe(1);
    expect(summary.badLines).toBe(0);
  });

  it("② 非法观察回 FOUNDRY_INVALID 且不落行", () => {
    const root = tmpRoot();
    const bad = observe(root, { signature: SIGNATURE, steps: [] });
    expect(bad.ok).toBe(false);
    expect(bad.codes).toEqual(["FOUNDRY_INVALID"]);
    expect(typeof bad.reason).toBe("string");
    expect(rawLines(root)).toHaveLength(0);
    expect(existsSync(foundryPath(root))).toBe(false);
  });

  it("③ root 非字符串 → TypeError", () => {
    expect(() => observe(undefined as unknown as string, observationInput())).toThrow(TypeError);
    expect(() => foundryPath(42 as unknown as string)).toThrow(TypeError);
  });
});

describe("tool-foundry-store:mine", () => {
  it("④ 达标分组落 1 个候选(frequency/sessions/projects/failureModes 正确)", () => {
    const root = tmpRoot();
    seedQualifying(root);
    const result = mine(root);
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual(["FOUNDRY_CANDIDATE"]);
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates![0]!;
    expect(candidate.sourceSignature).toBe(SIGNATURE);
    expect(candidate.frequency).toBe(4);
    expect(candidate.sessions).toBe(2);
    expect(candidate.projects).toEqual(["p-1", "p-2"]);
    expect(candidate.failureModes).toEqual(["timeout"]);
    expect(candidate.status).toBe("candidate");
    expect(candidate.estimatedSavings.tokens).toBe(2400); // round(4000 * 0.6)
    expect(candidate.estimatedSavings.toolCalls).toBe(16); // 20 - 4
    expect(rawLines(root)).toHaveLength(5); // 4 observation + 1 candidate
  });

  it("⑤ 门槛不足 → FOUNDRY_NO_CANDIDATE 且不写候选行", () => {
    const root = tmpRoot();
    observe(root, observationInput({ sessionId: "s-1" }));
    observe(root, observationInput({ sessionId: "s-2" }));
    const result = mine(root);
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual(["FOUNDRY_NO_CANDIDATE"]);
    expect(result.candidates).toEqual([]);
    expect(result.discarded).toContainEqual({ signature: SIGNATURE, reason: "low-frequency" });
    expect(rawLines(root)).toHaveLength(2);
  });

  it("⑥ 重复挖掘 → already-mined,不重复追加", () => {
    const root = tmpRoot();
    seedQualifying(root);
    expect(mine(root).candidates).toHaveLength(1);
    const linesAfterFirst = rawLines(root).length;

    const second = mine(root);
    expect(second.codes).toEqual(["FOUNDRY_NO_CANDIDATE"]);
    expect(second.candidates).toEqual([]);
    expect(second.discarded).toContainEqual({ signature: SIGNATURE, reason: "already-mined" });
    expect(rawLines(root)).toHaveLength(linesAfterFirst);
    expect(listCandidates(root)).toHaveLength(1);
  });

  it("⑦ retired 后再次挖掘 → DUPLICATE 且一行不写", () => {
    const root = tmpRoot();
    seedQualifying(root);
    const id = firstCandidateId(root);
    expect(retire(root, id, { reason: "被原生工具取代" }).ok).toBe(true);
    const before = rawLines(root).length;

    const again = mine(root);
    expect(again.ok).toBe(false);
    expect(again.codes).toEqual(["FOUNDRY_DUPLICATE"]);
    expect(again.duplicateSignatures).toEqual([SIGNATURE]);
    expect(rawLines(root)).toHaveLength(before);
    expect(listCandidates(root)).toHaveLength(1);
  });
});

describe("tool-foundry-store:候选查询与影子段", () => {
  it("⑧ listCandidates 按创建序,status 过滤生效", () => {
    const root = tmpRoot();
    seedQualifying(root, SIGNATURE);
    seedQualifying(root, "git log --oneline | head -20");
    const mined = mine(root);
    expect(mined.candidates).toHaveLength(2);
    const ids = mined.candidates!.map((entry) => entry.id);

    expect(listCandidates(root).map((entry) => entry.id)).toEqual(ids);
    expect(listCandidates(root, { status: "candidate" })).toHaveLength(2);
    expect(listCandidates(root, { status: "shadow" })).toHaveLength(0);

    expect(startShadow(root, ids[0]!).ok).toBe(true);
    expect(listCandidates(root, { status: "shadow" }).map((entry) => entry.id)).toEqual([ids[0]!]);
    expect(listCandidates(root, { status: "candidate" })).toHaveLength(1);
  });

  it("⑨ startShadow 成功落 shadow:start 行;非 candidate 状态 → INVALID", () => {
    const root = tmpRoot();
    seedQualifying(root);
    const id = firstCandidateId(root);

    const started = startShadow(root, id);
    expect(started.ok).toBe(true);
    expect(started.codes).toEqual(["FOUNDRY_SHADOW_STARTED"]);
    expect(started.candidate?.status).toBe("shadow");
    expect(started.candidate?.shadow).toEqual({ runs: 0, successes: 0 });
    expect(rawLines(root).some((line) => line.includes('"op":"start"'))).toBe(true);

    // 已在 shadow 中,再 start 一次 → runtime 拒绝(INVALID),不落行。
    const again = startShadow(root, id);
    expect(again.ok).toBe(false);
    expect(again.codes).toEqual(["FOUNDRY_INVALID"]);
  });

  it("⑩ evaluateShadow 2/3 → SHADOW_FAIL 并落 rejected 状态", () => {
    const root = tmpRoot();
    seedQualifying(root);
    const id = firstCandidateId(root);
    startShadow(root, id);

    const evaluated = evaluateShadow(root, id, { runs: 3, successes: 2 });
    expect(evaluated.ok).toBe(false);
    expect(evaluated.codes).toEqual(["FOUNDRY_SHADOW_FAIL"]);
    expect(evaluated.candidate?.status).toBe("rejected");
    expect(listCandidates(root, { status: "rejected" })).toHaveLength(1);
    expect(listCandidates(root, { status: "rejected" })[0]?.shadow).toMatchObject({ runs: 3, successes: 2 });

    const evaluateLine = rawLines(root).find((line) => line.includes('"op":"evaluate"'));
    expect(evaluateLine).toContain('"status":"rejected"');
  });

  it("⑪ evaluateShadow 3/3 → SHADOW_PASS(ok:true)", () => {
    const root = tmpRoot();
    seedQualifying(root);
    const id = firstCandidateId(root);
    startShadow(root, id);

    const evaluated = evaluateShadow(root, id, { runs: 3, successes: 3 });
    expect(evaluated.ok).toBe(true);
    expect(evaluated.codes).toEqual(["FOUNDRY_SHADOW_PASS"]);
    expect(evaluated.candidate?.shadow).toEqual({ runs: 3, successes: 3 });
    expect(listCandidates(root, { status: "shadow" })[0]?.shadow?.successes).toBe(3);
  });

  it("⑫ evaluateShadow 样本不足 → LOW_REUSE(ok:false,仍是 shadow)", () => {
    const root = tmpRoot();
    seedQualifying(root);
    const id = firstCandidateId(root);
    startShadow(root, id);

    const evaluated = evaluateShadow(root, id, { runs: 2, successes: 2 });
    expect(evaluated.ok).toBe(false);
    expect(evaluated.codes).toEqual(["FOUNDRY_LOW_REUSE"]);
    expect(listCandidates(root, { status: "shadow" })[0]?.shadow).toEqual({ runs: 2, successes: 2 });
  });

  it("⑬ register 未 approve → NEEDS_APPROVAL 不落行;approve → registered + dataToolSpec", () => {
    const root = tmpRoot();
    seedQualifying(root);
    const id = firstCandidateId(root);
    startShadow(root, id);
    evaluateShadow(root, id, { runs: 3, successes: 3 });
    const before = rawLines(root).length;

    const denied = register(root, id, { approved: false });
    expect(denied.ok).toBe(false);
    expect(denied.codes).toEqual(["FOUNDRY_NEEDS_APPROVAL"]);
    expect(rawLines(root)).toHaveLength(before);

    const approved = register(root, id, { approved: true });
    expect(approved.ok).toBe(true);
    expect(approved.codes).toEqual(["FOUNDRY_REGISTERED"]);
    expect(approved.dataToolSpec?.name).toBe(listCandidates(root)[0]?.name);
    expect(approved.dataToolSpec?.layer).toBe("data");
    expect(rawLines(root)).toHaveLength(before + 1);
    expect(listCandidates(root, { status: "registered" })[0]?.dataToolSpec?.registeredBy).toBe("rsi");
  });

  it("⑭ retire 成功落 retired 行;重复 retire → DUPLICATE 且不追加", () => {
    const root = tmpRoot();
    seedQualifying(root);
    const id = firstCandidateId(root);

    const retired = retire(root, id, { reason: "改由原生脚本承担" });
    expect(retired.ok).toBe(true);
    expect(retired.codes).toEqual(["FOUNDRY_RETIRED"]);
    const before = rawLines(root).length;
    expect(rawLines(root)[before - 1]).toContain('"reason":"改由原生脚本承担"');

    const again = retire(root, id, { reason: "再下线一次" });
    expect(again.ok).toBe(false);
    expect(again.codes).toEqual(["FOUNDRY_DUPLICATE"]);
    expect(rawLines(root)).toHaveLength(before);
    expect(listCandidates(root, { status: "retired" })).toHaveLength(1);
  });
});

describe("tool-foundry-store:report / 坏行 / not-found", () => {
  it("⑮ report 汇总 byStatus / 总节省(剔除 retired) / failureModes", () => {
    const root = tmpRoot();
    seedQualifying(root, SIGNATURE);
    seedQualifying(root, "pnpm lint --fix");
    const mined = mine(root);
    expect(mined.candidates).toHaveLength(2);
    const keepId = mined.candidates![0]!.id;
    const dropId = mined.candidates![1]!.id;

    const before = report(root);
    expect(before.total).toBe(2);
    expect(before.byStatus).toEqual({ candidate: 2 });
    expect(before.observations).toBe(8);
    expect(before.failureModes).toEqual([{ mode: "timeout", count: 2 }]);

    expect(retire(root, dropId, { reason: "重复" }).ok).toBe(true);
    const after = report(root);
    expect(after.byStatus).toEqual({ candidate: 1, retired: 1 });
    expect(after.estimatedSavings.tokens).toBeLessThan(before.estimatedSavings.tokens);
    expect(after.estimatedSavings.toolCalls).toBeLessThan(before.estimatedSavings.toolCalls);
    expect(listCandidates(root, { status: "candidate" })[0]?.id).toBe(keepId);
  });

  it("⑯ 坏行(垃圾 JSON / 未知 type / 缺 v)不 throw 且计入 badLines", () => {
    const root = tmpRoot();
    seedQualifying(root);
    firstCandidateId(root);
    const path = foundryPath(root);
    const extra = [
      "not-json-at-all",
      JSON.stringify({ type: "observation", at: 1 }),
      JSON.stringify({ v: 1, type: "unknown-kind", at: 1 }),
      JSON.stringify({ v: 1, type: "shadow", at: 1, op: "start", id: "cand_missing" }),
      JSON.stringify({ v: 1, type: "candidate", at: 1, candidate: { id: "x", status: "weird" } }),
    ].join("\n");
    writeFileSync(path, `${readFileSync(path, "utf8")}${extra}\n`, "utf8");

    const summary = report(root);
    expect(summary.badLines).toBe(5);
    expect(summary.total).toBe(1);
    expect(listCandidates(root)).toHaveLength(1);
    expect(() => mine(root)).not.toThrow();
  });

  it("⑰ 不存在的 id → 各操作均 not-found(FOUNDRY_INVALID)", () => {
    const root = tmpRoot();
    const missing = "cand_does_not_exist";
    for (const result of [
      startShadow(root, missing),
      evaluateShadow(root, missing, { runs: 3, successes: 3 }),
      register(root, missing, { approved: true }),
      retire(root, missing, { reason: "x" }),
    ]) {
      expect(result.ok).toBe(false);
      expect(result.codes).toEqual(["FOUNDRY_INVALID"]);
      expect(result.reason).toBe("candidate-not-found");
      expect(result.candidate).toBeUndefined();
    }
    expect(rawLines(root)).toHaveLength(0);
  });

  it("⑱ 空 root 库:report 全零、mine 回 NO_CANDIDATE(缺文件不算坏行)", () => {
    const root = tmpRoot("tf-store-empty");
    const summary = report(root);
    expect(summary).toEqual({
      total: 0,
      byStatus: {},
      estimatedSavings: { tokens: 0, toolCalls: 0 },
      failureModes: [],
      observations: 0,
      badLines: 0,
    });
    expect(mine(root).codes).toEqual(["FOUNDRY_NO_CANDIDATE"]);
  });

  it("⑲ opts 类型非法 → TypeError(参数错误才 throw)", () => {
    const root = tmpRoot();
    expect(() => mine(root, [] as unknown as { minOccurrences?: number })).toThrow(TypeError);
    expect(() => register(root, "cand_x", null as unknown as { approved: boolean })).toThrow(TypeError);
    expect(() => evaluateShadow(root, "cand_x", undefined as unknown as { runs: number; successes: number })).toThrow(
      TypeError,
    );
  });

  it("⑳ 全部落盘都在 root/.genie/rsi/foundry.jsonl 且追加不覆盖既有内容", () => {
    const root = tmpRoot();
    expect(foundryPath(root)).toBe(join(root, ".genie", "rsi", "foundry.jsonl"));
    seedQualifying(root);
    const firstLine = rawLines(root)[0];
    firstCandidateId(root);
    expect(rawLines(root)[0]).toBe(firstLine);
    expect(rawLines(root)).toHaveLength(5);

    mkdirSync(join(root, ".genie", "rsi"), { recursive: true });
    expect(existsSync(foundryPath(root))).toBe(true);
  });
});
