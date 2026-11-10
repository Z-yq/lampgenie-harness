/**
 * 轨迹病理件持久层:检测落盘 / 候选不入目录 / 形态登记幂等 / 目录投影 / tip 门路由 / 报表 / 坏行容忍。
 * 全部用例只写 os.tmpdir() 下的临时目录,绝不碰仓库 .genie。
 */
import { afterAll, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PathologyTrace } from "@lampgenie/runtime/agent/trajectory-pathology";
import {
  detect,
  listForms,
  pathologyLedgerPath,
  registerForm,
  reportPathology,
  route,
} from "../src/pathology-store";

const T0 = 1_700_000_000_000;
const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pathology-store-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

/** 读台账原始行(空行剔除;文件未创建视为空台账)。 */
async function ledgerLines(root: string): Promise<Record<string, unknown>[]> {
  let text = "";
  try {
    text = await readFile(pathologyLedgerPath(root), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** reversal(同文件 A→B→A→B)+ re-entry(同 tool 3 连):命中 oscillation。 */
function oscillationTrace(): PathologyTrace {
  return {
    edits: [
      { at: T0, file: "a.ts", beforeHash: "A", afterHash: "B" },
      { at: T0 + 1, file: "a.ts", beforeHash: "B", afterHash: "A" },
      { at: T0 + 2, file: "a.ts", beforeHash: "A", afterHash: "B" },
    ],
    steps: [
      { at: T0 + 10, tool: "read_file" },
      { at: T0 + 20, tool: "read_file" },
      { at: T0 + 30, tool: "read_file" },
    ],
  };
}

/** overlap(两会话文件相交)+ fanout(变更节点扇出 3):命中 parallel-clash。 */
function parallelClashTrace(): PathologyTrace {
  return {
    sessions: [
      { id: "s1", files: ["a.ts", "b.ts"] },
      { id: "s2", files: ["b.ts", "c.ts"] },
    ],
    steps: [
      { at: T0, file: "a.ts" },
      { at: T0 + 10, file: "b.ts" },
    ],
    changeNodes: [{ at: T0, fanoutEdges: 3 }],
  };
}

/** overlap + decay(读到过期内容):目录里没有对应形态,应给 1 条候选。 */
function candidateTrace(): PathologyTrace {
  return {
    sessions: [
      { id: "s1", files: ["a.ts", "b.ts"] },
      { id: "s2", files: ["b.ts", "c.ts"] },
    ],
    steps: [
      { at: T0, file: "a.ts" },
      { at: T0 + 10, file: "b.ts" },
    ],
    reads: [{ at: T0, ref: "doc.md", expired: true }],
  };
}

describe("detect", () => {
  it("reversal+re-entry 命中 oscillation 并展开 tip/decision-gate/tool", async () => {
    const root = await tempRoot();
    const result = detect(root, oscillationTrace(), { at: T0 });
    expect(result.ok).toBe(true);
    expect(result.codes).toContain("PATHOLOGY_MATCHED");
    expect(result.matched.map((m) => m.formId)).toEqual(["oscillation"]);
    expect(result.matched[0].matchedSignature).toEqual(["reversal", "re-entry"]);
    const carriers = (result.interventions ?? []).flatMap((i) => i.carriers);
    expect(carriers).toContain("tip");
    expect(carriers).toContain("decision-gate");
    expect(carriers).toContain("tool");
    expect(result.primitives.reversal.hit).toBe(true);
    expect(result.primitives["re-entry"].count).toBeGreaterThanOrEqual(1);
  });

  it("parallel-clash 请求 tip 被 tip 门拒:码含 TIP_FORBIDDEN、carriers 无 tip", async () => {
    const root = await tempRoot();
    const result = detect(root, parallelClashTrace(), { requestTip: true });
    expect(result.matched.map((m) => m.formId)).toEqual(["parallel-clash"]);
    expect(result.codes).toContain("PATHOLOGY_TIP_FORBIDDEN");
    const interventions = result.interventions ?? [];
    expect(interventions.length).toBe(1);
    expect(interventions[0].tipAllowed).toBe(false);
    expect(interventions[0].carriers).toEqual(["claim-lock", "search-scope"]);
    expect(interventions[0].carriers).not.toContain("tip");
  });

  it("overlap+decay 无命中形态但有 1 条候选,且候选不入目录", async () => {
    const root = await tempRoot();
    const result = detect(root, candidateTrace());
    expect(result.matched).toEqual([]);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].signature).toEqual(["overlap", "decay"]);
    expect(result.candidates[0].familySuggestion).toBe("waste");
    expect(result.codes).toContain("PATHOLOGY_NEW_CANDIDATE");
    const listed = listForms(root);
    expect(listed.total).toBe(8);
    expect(listed.registered).toBe(0);
  });

  it("每次 detect 追加一行 jsonl(type=detect,evidence 不落盘)", async () => {
    const root = await tempRoot();
    detect(root, oscillationTrace(), { at: T0 });
    detect(root, candidateTrace(), { at: T0 + 1 });
    const lines = await ledgerLines(root);
    expect(lines.length).toBe(2);
    expect(lines[0].type).toBe("detect");
    expect(lines[0].at).toBe(T0);
    expect(JSON.stringify(lines[0])).not.toContain("evidence");
    expect(lines[1].type).toBe("detect");
  });
});

describe("registerForm / listForms", () => {
  it("新组合登记成功:formId 以 custom- 开头,目录 9 条且 registered=1", async () => {
    const root = await tempRoot();
    const registered = registerForm(root, {
      family: "evolution-chain",
      signature: ["fanout", "decay"],
      description: "扇出后引用过期口径",
    });
    expect(registered.ok).toBe(true);
    expect(registered.duplicate).toBe(false);
    expect(registered.formId?.startsWith("custom-")).toBe(true);
    const listed = listForms(root);
    expect(listed.registered).toBe(1);
    expect(listed.total).toBe(9);
    expect(listed.forms[8].id).toBe(registered.formId);
    expect((await ledgerLines(root)).length).toBe(1);
  });

  it("重复组合登记:duplicate=true 且不写盘", async () => {
    const root = await tempRoot();
    const first = registerForm(root, {
      family: "evolution-chain",
      signature: ["fanout", "decay"],
    });
    const before = (await ledgerLines(root)).length;
    const second = registerForm(root, {
      family: "evolution-chain",
      signature: ["fanout", "decay"],
    });
    expect(second.ok).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(second.formId).toBe(first.formId);
    expect((await ledgerLines(root)).length).toBe(before);
  });

  it("登记既有内置签名同样判重复(不新增行)", async () => {
    const root = await tempRoot();
    const dup = registerForm(root, {
      family: "rework-chain",
      signature: ["re-entry", "reversal"],
    });
    expect(dup).toMatchObject({ ok: true, duplicate: true, formId: "oscillation" });
    expect((await ledgerLines(root)).length).toBe(0);
  });

  it("非法签名(含未知原语)返回 INVALID_INPUT 且不写盘", async () => {
    const root = await tempRoot();
    const result = registerForm(root, {
      family: "waste",
      signature: ["nope"],
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("PATHOLOGY_STORE_INVALID_INPUT");
    expect(result.codes).toContain("PATHOLOGY_INVALID");
    expect((await ledgerLines(root)).length).toBe(0);
  });

  it("空目录 listForms 给默认 8 条内置形态", async () => {
    const root = await tempRoot();
    const listed = listForms(root);
    expect(listed.ok).toBe(true);
    expect(listed.total).toBe(8);
    expect(listed.registered).toBe(0);
    expect(listed.badLines).toBe(0);
    expect(listed.forms.map((f) => f.id)).toEqual([
      "oscillation",
      "patch-pileup",
      "contract-drift",
      "dead-end-spin",
      "repeat-exploration",
      "parallel-clash",
      "blind-spot",
      "rule-bloat",
    ]);
  });
});

describe("route", () => {
  it("oscillation 允许 tip:carriers 含 tip 且 tipAllowed=true", async () => {
    const root = await tempRoot();
    const routed = route(root, "oscillation", { requestTip: true });
    expect(routed.ok).toBe(true);
    expect(routed.tipAllowed).toBe(true);
    expect(routed.codes).toEqual([]);
    expect(routed.carriers.map((c) => c.carrier)).toContain("tip");
  });

  it("parallel-clash 请求 tip → ok:false + TIP_FORBIDDEN,carriers 恰为认领锁/检索范围", async () => {
    const root = await tempRoot();
    const routed = route(root, "parallel-clash", { requestTip: true });
    expect(routed.ok).toBe(false);
    expect(routed.code).toBe("PATHOLOGY_TIP_FORBIDDEN");
    expect(routed.codes).toContain("PATHOLOGY_TIP_FORBIDDEN");
    expect(routed.carriers.map((c) => c.carrier)).toEqual([
      "claim-lock",
      "search-scope",
    ]);
    expect(routed.carriers.every((c) => c.detail.length > 0)).toBe(true);
  });

  it("已登记形态可按 formId 路由,未知 formId 给 FORM_NOT_FOUND", async () => {
    const root = await tempRoot();
    const registered = registerForm(root, {
      family: "evolution-chain",
      signature: ["fanout", "decay"],
    });
    const routed = route(root, registered.formId ?? "");
    expect(routed.ok).toBe(true);
    expect(routed.formId).toBe(registered.formId);
    expect(routed.carriers.length).toBeGreaterThan(0);

    const missing = route(root, "no-such-form");
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe("PATHOLOGY_FORM_NOT_FOUND");
    expect(missing.carriers).toEqual([]);
  });
});

describe("reportPathology", () => {
  it("坏行只计数:badLines=2、totalLines 正确、其余统计不受影响", async () => {
    const root = await tempRoot();
    detect(root, oscillationTrace());
    const path = pathologyLedgerPath(root);
    await appendFile(path, "{bad json\n", "utf8");
    await appendFile(path, `${JSON.stringify({ v: 2, type: "detect", at: T0 })}\n`, "utf8");
    detect(root, candidateTrace());
    const report = reportPathology(root);
    expect(report.ok).toBe(true);
    expect(report.badLines).toBe(2);
    expect(report.totalLines).toBe(4);
    expect(report.matches).toEqual({ oscillation: 1 });
    expect(report.byFamily).toEqual({ "rework-chain": 1 });
    expect(report.byCarrier).toEqual({
      "decision-gate": 1,
      tip: 1,
      tool: 1,
    });
    expect(report.candidates).toEqual([
      { signature: ["overlap", "decay"], familySuggestion: "waste", seen: 1 },
    ]);
  });

  it("候选按签名去重累计 seen,登记形态的载体计入 byCarrier", async () => {
    const root = await tempRoot();
    detect(root, candidateTrace());
    detect(root, candidateTrace());
    registerForm(root, {
      family: "statistics",
      signature: ["fanout", "decay"],
      interventions: [{ carrier: "checklist", detail: "扇出与过期项进清单" }],
    });
    const report = reportPathology(root);
    expect(report.candidates.length).toBe(1);
    expect(report.candidates[0].seen).toBe(2);
    expect(report.byCarrier).toEqual({ checklist: 1 });
    expect(report.matches).toEqual({});
    expect(report.byFamily).toEqual({});
  });

  it("空目录报表给全 0 与空对象,不抛", async () => {
    const root = await tempRoot();
    const report = reportPathology(root);
    expect(report.ok).toBe(true);
    expect(report.totalLines).toBe(0);
    expect(report.badLines).toBe(0);
    expect(report.byFamily).toEqual({});
    expect(report.byCarrier).toEqual({});
    expect(report.matches).toEqual({});
    expect(report.candidates).toEqual([]);
  });
});

describe("参数校验与路径", () => {
  it("root 为空白串时五个 API 都返回 INVALID_INPUT 且不抛", async () => {
    expect(() => detect("", oscillationTrace())).not.toThrow();
    const detected = detect("", oscillationTrace());
    expect(detected.ok).toBe(false);
    expect(detected.code).toBe("PATHOLOGY_STORE_INVALID_INPUT");
    expect(detected.matched).toEqual([]);
    expect(detected.candidates).toEqual([]);
    expect(Object.keys(detected.primitives)).toEqual([
      "re-entry",
      "reversal",
      "fanout",
      "overlap",
      "dangling",
      "decay",
    ]);

    const registered = registerForm("", {
      family: "waste",
      signature: ["dangling", "decay"],
    });
    expect(registered.ok).toBe(false);
    expect(registered.code).toBe("PATHOLOGY_STORE_INVALID_INPUT");

    expect(listForms("").ok).toBe(false);
    const routed = route("", "oscillation");
    expect(routed.ok).toBe(false);
    expect(routed.code).toBe("PATHOLOGY_STORE_INVALID_INPUT");
    expect(reportPathology("").ok).toBe(false);
  });

  it("pathologyLedgerPath 拼成 <root>/.genie/rsi/pathology.jsonl", () => {
    expect(pathologyLedgerPath("/tmp/x")).toBe(
      join("/tmp/x", ".genie", "rsi", "pathology.jsonl"),
    );
    expect(pathologyLedgerPath("/tmp/x")).toMatch(
      /\.genie[/\\]rsi[/\\]pathology\.jsonl$/,
    );
  });
});
