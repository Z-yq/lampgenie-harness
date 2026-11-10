/**
 * 轨迹病理:六原语检测 / 形态匹配 / 形态登记 / tip 门 / 干预计划优先级 / 审计行 / 目录渲染 / 非法输入。
 * 全部纯数据 + 固定时间戳常量,不碰文件与真实时钟。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CATALOG,
  DEFAULT_MIN_REPEATS,
  DEFAULT_WINDOW_MS,
  INTERVENTION_CARRIERS,
  PATHOLOGY_CODE_LIST,
  PATHOLOGY_CODES,
  PATHOLOGY_FAMILIES,
  PATHOLOGY_PRIMITIVES,
  PATHOLOGY_VERSION,
  buildInterventionPlan,
  detectPrimitives,
  matchForms,
  registerForm,
  renderCatalog,
  routeInterventions,
  toAuditRows,
} from "../src/agent/trajectory-pathology.ts";
import type {
  PathologyForm,
  PathologyPrimitive,
  PathologyTrace,
} from "../src/agent/trajectory-pathology.ts";

const T0 = 1_700_000_000_000;
const W = DEFAULT_WINDOW_MS;

function form(id: string): PathologyForm {
  const found = DEFAULT_CATALOG.find((f) => f.id === id);
  if (!found) throw new Error(`missing form ${id}`);
  return found;
}

describe("常量与导出面", () => {
  it("版本 / 窗口 / 阈值是约定值", () => {
    expect(PATHOLOGY_VERSION).toBe(1);
    expect(DEFAULT_WINDOW_MS).toBe(1_800_000);
    expect(DEFAULT_MIN_REPEATS).toBe(3);
  });

  it("原语顺序固定,族与载体枚举完整", () => {
    expect(PATHOLOGY_PRIMITIVES).toEqual([
      "re-entry",
      "reversal",
      "fanout",
      "overlap",
      "dangling",
      "decay",
    ]);
    expect(PATHOLOGY_FAMILIES).toEqual([
      "rework-chain",
      "evolution-chain",
      "waste",
      "coordination",
      "statistics",
      "meta",
    ]);
    expect(INTERVENTION_CARRIERS.length).toBe(15);
    expect(INTERVENTION_CARRIERS[0]).toBe("tip");
  });

  it("稳定码清单覆盖 7 个码", () => {
    expect(PATHOLOGY_CODE_LIST.length).toBe(7);
    expect(PATHOLOGY_CODE_LIST).toContain(PATHOLOGY_CODES.MATCHED);
    expect(PATHOLOGY_CODE_LIST).toContain(PATHOLOGY_CODES.INVALID);
  });

  it("默认目录 8 形态且只有 oscillation 允许 tip", () => {
    expect(DEFAULT_CATALOG.map((f) => f.id)).toEqual([
      "oscillation",
      "patch-pileup",
      "contract-drift",
      "dead-end-spin",
      "repeat-exploration",
      "parallel-clash",
      "blind-spot",
      "rule-bloat",
    ]);
    expect(
      DEFAULT_CATALOG.filter((f) => f.tipAllowed).map((f) => f.id),
    ).toEqual(["oscillation"]);
  });

  it("硬约束:[overlap,decay] 不命中任何内置形态", () => {
    for (const f of DEFAULT_CATALOG) {
      const contained = f.signature.every(
        (p) => p === "overlap" || p === "decay",
      );
      expect(contained).toBe(false);
    }
    expect(matchForms(["overlap", "decay"]).matched).toEqual([]);
  });
});

describe("re-entry", () => {
  it("同 tool 窗口内 3 次命中并给证据", () => {
    const trace: PathologyTrace = {
      steps: [
        { at: T0, tool: "read_file" },
        { at: T0 + 1_000, tool: "read_file" },
        { at: T0 + 2_000, tool: "read_file" },
      ],
    };
    const hit = detectPrimitives(trace)["re-entry"];
    expect(hit.hit).toBe(true);
    expect(hit.count).toBe(1);
    expect(hit.evidence[0]).toBe(`re-entry tool:read_file x3/${W}ms`);
  });

  it("窗口外不计数", () => {
    const trace: PathologyTrace = {
      steps: [
        { at: T0, tool: "read_file" },
        { at: T0 + 10, tool: "read_file" },
        { at: T0 + W + 11, tool: "read_file" },
      ],
    };
    const hit = detectPrimitives(trace)["re-entry"];
    expect(hit.hit).toBe(false);
    expect(hit.count).toBe(0);
    expect(hit.evidence).toEqual([]);
  });

  it("默认阈值 3 次时 2 次不命中,阈值降到 2 才命中", () => {
    const trace: PathologyTrace = {
      steps: [
        { at: T0, file: "a.ts" },
        { at: T0 + 5, file: "a.ts" },
      ],
    };
    expect(detectPrimitives(trace)["re-entry"].hit).toBe(false);
    const tuned = detectPrimitives(trace, { minRepeats: 2 })["re-entry"];
    expect(tuned.hit).toBe(true);
    expect(tuned.evidence[0]).toBe(`re-entry file:a.ts x2/${W}ms`);
  });

  it("key 优先级 tool > file > argsHash", () => {
    const trace: PathologyTrace = {
      steps: [
        { at: T0, tool: "grep", file: "a.ts", argsHash: "h1" },
        { at: T0 + 1, tool: "grep", file: "a.ts", argsHash: "h1" },
        { at: T0 + 2, tool: "grep", file: "a.ts", argsHash: "h1" },
        { at: T0 + 3, argsHash: "h2" },
        { at: T0 + 4, argsHash: "h2" },
        { at: T0 + 5, argsHash: "h2" },
      ],
    };
    const hit = detectPrimitives(trace)["re-entry"];
    expect(hit.hit).toBe(true);
    expect(hit.evidence).toContain(`re-entry tool:grep x3/${W}ms`);
    expect(hit.evidence).toContain(`re-entry args:h2 x3/${W}ms`);
    expect(hit.count).toBe(2);
  });
});

describe("reversal", () => {
  it("同文件编辑回到旧状态命中并给出 A→B→A 证据", () => {
    const trace: PathologyTrace = {
      edits: [
        { at: T0, file: "a.ts", beforeHash: "A", afterHash: "B" },
        { at: T0 + 1, file: "a.ts", beforeHash: "B", afterHash: "A" },
        { at: T0 + 2, file: "a.ts", beforeHash: "A", afterHash: "B" },
      ],
    };
    const hit = detectPrimitives(trace).reversal;
    expect(hit.hit).toBe(true);
    expect(hit.evidence[0]).toBe("reversal file:a.ts A→B→A");
    expect(hit.count).toBeGreaterThanOrEqual(1);
  });

  it("编辑次数不足 3 次时回环不算命中", () => {
    const trace: PathologyTrace = {
      edits: [
        { at: T0, file: "a.ts", beforeHash: "A", afterHash: "B" },
        { at: T0 + 1, file: "a.ts", beforeHash: "B", afterHash: "A" },
      ],
    };
    expect(detectPrimitives(trace).reversal.hit).toBe(false);
  });

  it("决策 A,B,A 只算 1 次反转,不达阈值不命中", () => {
    const trace: PathologyTrace = {
      steps: [
        { at: T0, decision: "A" },
        { at: T0 + 1, decision: "B" },
        { at: T0 + 2, decision: "A" },
      ],
    };
    const hit = detectPrimitives(trace).reversal;
    expect(hit.count).toBe(1);
    expect(hit.hit).toBe(false);
  });

  it("带 file 的 A,B,A 只按一次反复计数(不与全局重复相加)", () => {
    const trace: PathologyTrace = {
      steps: [
        { at: T0, file: "a.ts", decision: "A" },
        { at: T0 + 1, file: "a.ts", decision: "B" },
        { at: T0 + 2, file: "a.ts", decision: "A" },
      ],
    };
    const hit = detectPrimitives(trace).reversal;
    expect(hit.count).toBe(1);
    expect(hit.hit).toBe(false);
  });

  it("两个文件各自 A,B,A 合计 2 次反转命中", () => {
    const trace: PathologyTrace = {
      steps: [
        { at: T0, file: "a.ts", decision: "A" },
        { at: T0 + 1, file: "a.ts", decision: "B" },
        { at: T0 + 2, file: "a.ts", decision: "A" },
        { at: T0 + 3, file: "b.ts", decision: "C" },
        { at: T0 + 4, file: "b.ts", decision: "D" },
        { at: T0 + 5, file: "b.ts", decision: "C" },
      ],
    };
    const hit = detectPrimitives(trace).reversal;
    expect(hit.count).toBe(2);
    expect(hit.hit).toBe(true);
  });

  it("决策 A,B,A,B 累计 2 次反转命中", () => {
    const trace: PathologyTrace = {
      steps: [
        { at: T0, decision: "A" },
        { at: T0 + 1, decision: "B" },
        { at: T0 + 2, decision: "A" },
        { at: T0 + 3, decision: "B" },
      ],
    };
    const hit = detectPrimitives(trace).reversal;
    expect(hit.hit).toBe(true);
    expect(hit.count).toBe(2);
  });

  it("空 decision 串被忽略", () => {
    const trace: PathologyTrace = {
      steps: [
        { at: T0, decision: "A" },
        { at: T0 + 1, decision: "" },
        { at: T0 + 2, decision: "B" },
        { at: T0 + 3, decision: "A" },
        { at: T0 + 4, decision: "B" },
      ],
    };
    const hit = detectPrimitives(trace).reversal;
    expect(hit.hit).toBe(true);
    expect(hit.count).toBe(2);
  });
});

describe("fanout", () => {
  it("变更节点扇出边 ≥2 命中", () => {
    const hit = detectPrimitives({
      changeNodes: [{ at: T0, fanoutEdges: 3 }],
    }).fanout;
    expect(hit.hit).toBe(true);
    expect(hit.count).toBe(1);
    expect(hit.evidence[0]).toBe(`fanout change-node @${T0} edges=3`);
  });

  it("扇出边只有 1 不命中", () => {
    const hit = detectPrimitives({
      changeNodes: [{ at: T0, fanoutEdges: 1 }],
    }).fanout;
    expect(hit.hit).toBe(false);
  });

  it("一次编辑后同文件 ≥2 次失败命中", () => {
    const trace: PathologyTrace = {
      edits: [{ at: T0, file: "a.ts", beforeHash: "A", afterHash: "B" }],
      steps: [
        { at: T0 + 100, tool: "write_file", file: "a.ts", ok: false },
        { at: T0 + 200, tool: "write_file", file: "a.ts", ok: false },
      ],
    };
    const hit = detectPrimitives(trace).fanout;
    expect(hit.hit).toBe(true);
    expect(hit.count).toBe(1);
    expect(hit.evidence[0]).toBe(`fanout edit a.ts @${T0} → 2 fix edges`);
  });

  it("只有 1 次失败不命中", () => {
    const trace: PathologyTrace = {
      edits: [{ at: T0, file: "a.ts", beforeHash: "A", afterHash: "B" }],
      steps: [{ at: T0 + 100, file: "a.ts", ok: false }],
    };
    expect(detectPrimitives(trace).fanout.hit).toBe(false);
  });
});

describe("overlap", () => {
  it("文件相交且时间重叠命中", () => {
    const trace: PathologyTrace = {
      sessions: [
        { id: "s1", files: ["a.ts", "b.ts"] },
        { id: "s2", files: ["b.ts", "c.ts"] },
      ],
      steps: [
        { at: T0, file: "a.ts" },
        { at: T0 + 10, file: "b.ts" },
      ],
    };
    const hit = detectPrimitives(trace).overlap;
    expect(hit.hit).toBe(true);
    expect(hit.count).toBe(1);
    expect(hit.evidence[0]).toBe("overlap b.ts: s1∩s2");
  });

  it("文件相交但时间不重叠不命中", () => {
    const trace: PathologyTrace = {
      sessions: [
        { id: "s1", files: ["a.ts", "x.ts"] },
        { id: "s2", files: ["a.ts", "y.ts"] },
      ],
      steps: [
        { at: T0, file: "x.ts" },
        { at: T0 + 10 * W, file: "y.ts" },
      ],
    };
    expect(detectPrimitives(trace).overlap.hit).toBe(false);
  });

  it("无文件交集不命中", () => {
    const trace: PathologyTrace = {
      sessions: [
        { id: "s1", files: ["a.ts"] },
        { id: "s2", files: ["z.ts"] },
      ],
    };
    expect(detectPrimitives(trace).overlap.hit).toBe(false);
  });

  it("区间不可得时视为重叠", () => {
    const trace: PathologyTrace = {
      sessions: [
        { id: "s1", files: ["a.ts"] },
        { id: "s2", files: ["a.ts", "b.ts"] },
      ],
    };
    const hit = detectPrimitives(trace).overlap;
    expect(hit.hit).toBe(true);
    expect(hit.count).toBe(1);
  });

  it("会话不足 2 个不命中", () => {
    expect(
      detectPrimitives({ sessions: [{ id: "s1", files: ["a.ts"] }] }).overlap
        .hit).toBe(false);
  });
});

describe("dangling", () => {
  it("提问未回答命中", () => {
    const hit = detectPrimitives({ asks: [{ at: T0, id: "q1" }] }).dangling;
    expect(hit.hit).toBe(true);
    expect(hit.evidence[0]).toBe("dangling ask q1 unresolved");
  });

  it("已回答的提问不命中", () => {
    expect(
      detectPrimitives({ asks: [{ at: T0, id: "q1", resolvedAt: T0 + 5 }] })
        .dangling.hit).toBe(false);
  });

  it("失败后同文件无成功步骤命中", () => {
    const trace: PathologyTrace = {
      steps: [{ at: T0, tool: "write_file", file: "a.ts", ok: false }],
    };
    const hit = detectPrimitives(trace).dangling;
    expect(hit.hit).toBe(true);
    expect(hit.evidence[0]).toBe(
      "dangling step tool:write_file a.ts ok=false no fix",
    );
  });

  it("失败后同文件有成功步骤不命中", () => {
    const trace: PathologyTrace = {
      steps: [
        { at: T0, tool: "write_file", file: "a.ts", ok: false },
        { at: T0 + 10, tool: "write_file", file: "a.ts", ok: true },
      ],
    };
    expect(detectPrimitives(trace).dangling.hit).toBe(false);
  });

  it("成功发生在别的文件时仍算悬空", () => {
    const trace: PathologyTrace = {
      steps: [
        { at: T0, tool: "write_file", file: "a.ts", ok: false },
        { at: T0 + 10, tool: "write_file", file: "b.ts", ok: true },
      ],
    };
    expect(detectPrimitives(trace).dangling.hit).toBe(true);
  });
});

describe("decay", () => {
  it("读到过期内容命中", () => {
    const hit = detectPrimitives({
      reads: [{ at: T0, ref: "doc.md", expired: true }],
    }).decay;
    expect(hit.hit).toBe(true);
    expect(hit.evidence).toContain("decay read doc.md expired");
  });

  it("同一 ref 重复读 3 次命中", () => {
    const hit = detectPrimitives({
      reads: [
        { at: T0, ref: "doc.md" },
        { at: T0 + 1, ref: "doc.md" },
        { at: T0 + 2, ref: "doc.md" },
      ],
    }).decay;
    expect(hit.hit).toBe(true);
    expect(hit.count).toBe(1);
    expect(hit.evidence).toContain("decay read doc.md x3");
  });

  it("同一 ref 只读 2 次不命中", () => {
    const hit = detectPrimitives({
      reads: [
        { at: T0, ref: "doc.md" },
        { at: T0 + 1, ref: "doc.md" },
      ],
    }).decay;
    expect(hit.hit).toBe(false);
  });

  it("不同 version 分开计数", () => {
    const hit = detectPrimitives({
      reads: [
        { at: T0, ref: "doc.md", version: "v1" },
        { at: T0 + 1, ref: "doc.md", version: "v2" },
        { at: T0 + 2, ref: "doc.md", version: "v3" },
      ],
    }).decay;
    expect(hit.hit).toBe(false);
  });
});

describe("空轨迹与非法输入", () => {
  it("空 trace 六原语全 false", () => {
    const result = detectPrimitives({});
    for (const p of PATHOLOGY_PRIMITIVES) {
      expect(result[p]).toEqual({ hit: false, evidence: [], count: 0 });
    }
  });

  it("undefined / null trace 不抛且全 false", () => {
    for (const trace of [undefined, null]) {
      const result = detectPrimitives(trace as PathologyTrace | undefined);
      expect(PATHOLOGY_PRIMITIVES.every((p) => result[p].hit === false)).toBe(
        true);
    }
  });

  it("steps 非数组等非法形状按空数组处理", () => {
    const broken = {
      steps: "oops",
      edits: 42,
      asks: null,
      reads: {},
      sessions: "x",
      changeNodes: 7,
    } as unknown as PathologyTrace;
    const result = detectPrimitives(broken);
    expect(
      PATHOLOGY_PRIMITIVES.every(
        (p) => result[p].hit === false && result[p].count === 0),
    ).toBe(true);
  });
});

describe("matchForms", () => {
  it("reversal+re-entry 命中 oscillation", () => {
    const primitives: PathologyPrimitive[] = ["reversal", "re-entry"];
    const result = matchForms(primitives);
    expect(result.matched.length).toBe(1);
    expect(result.matched[0].form.id).toBe("oscillation");
    expect(result.matched[0].matchedSignature).toEqual([
      "reversal",
      "re-entry",
    ]);
    expect(result.matched[0].extraPrimitives).toEqual([]);
    expect(result.codes).toEqual([PATHOLOGY_CODES.MATCHED]);
  });

  it("含额外原语时按 id 字典序并给出 extraPrimitives", () => {
    const result = matchForms(["fanout", "re-entry", "reversal"]);
    expect(result.matched.map((m) => m.form.id)).toEqual([
      "oscillation",
      "patch-pileup",
    ]);
    expect(result.matched[0].extraPrimitives).toEqual(["fanout"]);
    expect(result.matched[1].extraPrimitives).toEqual(["reversal"]);
    expect(result.candidates).toEqual([]);
  });

  it("overlap+fanout 命中 parallel-clash", () => {
    const result = matchForms(["fanout", "overlap"]);
    expect(result.matched.map((m) => m.form.id)).toEqual(["parallel-clash"]);
    expect(result.codes).toEqual([PATHOLOGY_CODES.MATCHED]);
  });

  it("[overlap,decay] 命中为空且恰好 1 条候选", () => {
    const result = matchForms(["decay", "overlap"]);
    expect(result.matched).toEqual([]);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].signature).toEqual(["overlap", "decay"]);
    expect(result.candidates[0].familySuggestion).toBe("waste");
    expect(result.candidates[0].reason).toContain("overlap+decay");
    expect(result.codes).toEqual([PATHOLOGY_CODES.NEW_CANDIDATE]);
  });

  it("活跃原语不足 2 且无命中给 NO_MATCH", () => {
    const result = matchForms(["re-entry"]);
    expect(result.matched).toEqual([]);
    expect(result.candidates).toEqual([]);
    expect(result.codes).toEqual([PATHOLOGY_CODES.NO_MATCH]);
  });

  it("Record 形式只取 hit=true 的原语", () => {
    const hits = detectPrimitives({
      steps: [
        { at: T0, tool: "read_file" },
        { at: T0 + 1, tool: "read_file" },
        { at: T0 + 2, tool: "read_file" },
      ],
      changeNodes: [{ at: T0, fanoutEdges: 2 }],
    });
    const result = matchForms(hits);
    expect(result.matched.map((m) => m.form.id)).toEqual(["patch-pileup"]);
    expect(result.matched[0].extraPrimitives).toEqual([]);
  });

  it("空 primitives 给 NO_MATCH 不抛", () => {
    const result = matchForms({} as Record<PathologyPrimitive, never>);
    expect(result.matched).toEqual([]);
    expect(result.codes).toEqual([PATHOLOGY_CODES.NO_MATCH]);
  });

  it("族建议按 reversal→decay→fanout→overlap 顺序判定", () => {
    expect(
      matchForms(["reversal", "decay"]).candidates[0].familySuggestion).toBe("evolution-chain");
    expect(
      matchForms(["reversal", "dangling"]).candidates[0].familySuggestion).toBe("rework-chain");
    expect(matchForms(["fanout", "decay"]).candidates[0].familySuggestion).toBe(
      "coordination",
    );
    expect(
      matchForms(["dangling", "overlap"]).candidates[0].familySuggestion).toBe("waste");
    expect(
      matchForms(["decay", "re-entry"]).candidates[0].familySuggestion).toBe("statistics");
  });
});

describe("registerForm", () => {
  it("签名集合相等返回既有形态且目录不变", () => {
    const result = registerForm(DEFAULT_CATALOG, {
      family: "rework-chain",
      signature: ["re-entry", "reversal"],
    });
    expect(result.codes).toEqual([PATHOLOGY_CODES.FORM_DUPLICATE]);
    expect(result.form.id).toBe("oscillation");
    expect(result.catalog.length).toBe(DEFAULT_CATALOG.length);
  });

  it("新组合生成 custom-8hex 且同输入两次同 id", () => {
    const a = registerForm(DEFAULT_CATALOG, {
      family: "waste",
      signature: ["overlap", "decay"],
    });
    const b = registerForm(DEFAULT_CATALOG, {
      family: "waste",
      signature: ["decay", "overlap"],
    });
    expect(a.codes).toEqual([PATHOLOGY_CODES.FORM_REGISTERED]);
    expect(a.form.id).toMatch(/^custom-[0-9a-f]{8}$/);
    expect(b.form.id).toBe(a.form.id);
    expect(a.catalog.length).toBe(DEFAULT_CATALOG.length + 1);
    expect(a.form.builtin).toBe(false);
    expect(a.form.tipAllowed).toBe(false);
    expect(a.form.interventions.map((i) => i.carrier)).toEqual([
      "world-model",
      "capability-index",
      "negative-kb",
    ]);
    expect(a.form.interventions[0].detail).toBe("新组合需人工确认干预载体");
  });

  it("规范化后判重:乱序与重复项等价", () => {
    const result = registerForm(DEFAULT_CATALOG, {
      family: "rework-chain",
      signature: ["re-entry", "reversal", "re-entry"] as PathologyPrimitive[],
    });
    expect(result.codes).toEqual([PATHOLOGY_CODES.FORM_DUPLICATE]);
    expect(result.form.id).toBe("oscillation");
  });

  it("rework-chain 新形态默认允许 tip 且按族给默认载体", () => {
    const result = registerForm(DEFAULT_CATALOG, {
      family: "rework-chain",
      signature: ["reversal", "overlap"],
    });
    expect(result.codes).toEqual([PATHOLOGY_CODES.FORM_REGISTERED]);
    expect(result.form.tipAllowed).toBe(true);
    expect(result.form.interventions.map((i) => i.carrier)).toEqual([
      "tip",
      "decision-gate",
      "tool",
    ]);
  });

  it("空签名 / 未知原语 / 未知族返回 INVALID 占位", () => {
    const empty = registerForm(DEFAULT_CATALOG, {
      family: "waste",
      signature: [],
    });
    expect(empty.codes).toEqual([PATHOLOGY_CODES.INVALID]);
    expect(empty.form).toEqual({
      id: "",
      family: "statistics",
      signature: [],
      description: "",
      interventions: [],
      tipAllowed: false,
      builtin: false,
    });
    expect(empty.catalog.length).toBe(DEFAULT_CATALOG.length);

    const unknownPrimitive = registerForm(DEFAULT_CATALOG, {
      family: "waste",
      signature: ["nope"] as unknown as PathologyPrimitive[],
    });
    expect(unknownPrimitive.codes).toEqual([PATHOLOGY_CODES.INVALID]);

    const mixedUnknown = registerForm(DEFAULT_CATALOG, {
      family: "waste",
      signature: ["re-entry", "nope"] as unknown as PathologyPrimitive[],
    });
    expect(mixedUnknown.codes).toEqual([PATHOLOGY_CODES.INVALID]);
    expect(mixedUnknown.form.id).toBe("");
    expect(mixedUnknown.catalog.length).toBe(DEFAULT_CATALOG.length);

    const unknownFamily = registerForm(DEFAULT_CATALOG, {
      family: "nope" as never,
      signature: ["re-entry", "decay"],
    });
    expect(unknownFamily.codes).toEqual([PATHOLOGY_CODES.INVALID]);
  });
});

describe("routeInterventions tip 门", () => {
  it("oscillation 请求 tip 时保留 tip", () => {
    const routed = routeInterventions(form("oscillation"), {
      requestTip: true,
    });
    expect(routed.tipAllowed).toBe(true);
    expect(routed.carriers.map((c) => c.carrier)).toEqual([
      "tip",
      "decision-gate",
      "tool",
    ]);
    expect(routed.codes).toEqual([]);
  });

  it("parallel-clash 请求 tip 被拒并给 TIP_FORBIDDEN", () => {
    const routed = routeInterventions(form("parallel-clash"), {
      requestTip: true,
    });
    expect(routed.tipAllowed).toBe(false);
    expect(routed.carriers.map((c) => c.carrier)).toEqual([
      "claim-lock",
      "search-scope",
    ]);
    expect(routed.codes).toEqual([PATHOLOGY_CODES.TIP_FORBIDDEN]);
  });

  it("未请求 tip 时禁 tip 形态也不返回 tip", () => {
    const routed = routeInterventions(form("parallel-clash"));
    expect(routed.carriers.some((c) => c.carrier === "tip")).toBe(false);
    expect(routed.codes).toEqual([]);
  });
});

describe("buildInterventionPlan", () => {
  it("rework-chain 优先级 tip=1 / decision-gate=2 / tool=3", () => {
    const plan = buildInterventionPlan(
      { form: form("oscillation") },
      { requestTip: true },
    );
    expect(plan.steps.map((s) => [s.carrier, s.priority])).toEqual([
      ["tip", 1],
      ["decision-gate", 2],
      ["tool", 3],
    ]);
    expect(plan.experimentRequired).toBe(true);
    expect(plan.codes).toEqual([]);
  });

  it("evolution-chain 优先级 refactor-task=1 / contract-ledger=2 / invariant-assert=3", () => {
    const plan = buildInterventionPlan({ form: form("patch-pileup") });
    expect(plan.steps.map((s) => [s.carrier, s.priority])).toEqual([
      ["refactor-task", 1],
      ["contract-ledger", 2],
      ["invariant-assert", 3],
    ]);
    expect(plan.experimentRequired).toBe(true);
  });

  it("其它族按 carriers 顺序 1..n", () => {
    const plan = buildInterventionPlan({ form: form("blind-spot") });
    expect(plan.steps.map((s) => [s.carrier, s.priority])).toEqual([
      ["checklist", 1],
      ["targeted-tool", 2],
    ]);
  });

  it("族内未知载体从 4 起顺序后排", () => {
    const custom: PathologyForm = {
      id: "custom-aaaaaaaa",
      family: "rework-chain",
      signature: ["fanout", "dangling"],
      description: "x",
      interventions: [
        { carrier: "checklist", detail: "a" },
        { carrier: "pruning-budget", detail: "b" },
      ],
      tipAllowed: false,
      builtin: false,
    };
    const plan = buildInterventionPlan({ form: custom });
    expect(plan.steps.map((s) => s.priority)).toEqual([4, 5]);
  });

  it("非法 match 返回空 steps 与 INVALID", () => {
    const plan = buildInterventionPlan({} as { form: PathologyForm });
    expect(plan.steps).toEqual([]);
    expect(plan.experimentRequired).toBe(true);
    expect(plan.codes).toEqual([PATHOLOGY_CODES.INVALID]);
  });

  it("禁 tip 形态即使请求 tip 也拿不到 tip 且带 TIP_FORBIDDEN", () => {
    const plan = buildInterventionPlan(
      { form: form("parallel-clash") },
      { requestTip: true },
    );
    expect(plan.steps.some((s) => s.carrier === "tip")).toBe(false);
    expect(plan.codes).toEqual([PATHOLOGY_CODES.TIP_FORBIDDEN]);
  });
});

describe("toAuditRows", () => {
  it("按 formId 字典序并遵守 tip 门", () => {
    const rows = toAuditRows([
      { form: form("parallel-clash") },
      { form: form("oscillation") },
    ]);
    expect(rows.map((r) => r.formId)).toEqual([
      "oscillation",
      "parallel-clash",
    ]);
    expect(rows[0].carriers).toEqual(["tip", "decision-gate", "tool"]);
    expect(rows[0].tipAllowed).toBe(true);
    expect(rows[1].carriers).toEqual(["claim-lock", "search-scope"]);
    expect(rows[1].tipAllowed).toBe(false);
  });

  it("禁 tip 形态的 tip 干预被剔除", () => {
    const custom: PathologyForm = {
      id: "custom-bbbbbbbb",
      family: "waste",
      signature: ["decay", "overlap"],
      description: "x",
      interventions: [
        { carrier: "tip", detail: "a" },
        { carrier: "checklist", detail: "b" },
      ],
      tipAllowed: false,
      builtin: false,
    };
    const rows = toAuditRows([{ form: custom }]);
    expect(rows[0].carriers).toEqual(["checklist"]);
  });

  it("空输入返回空数组", () => {
    expect(toAuditRows([])).toEqual([]);
    expect(
      toAuditRows(undefined as unknown as { form: PathologyForm }[]),
    ).toEqual([]);
  });
});

describe("renderCatalog", () => {
  it("默认目录首行给 8 形态与 tipAllowed 计数", () => {
    const lines = renderCatalog().split("\n");
    expect(lines[0]).toBe("pathology catalog v1 forms=8 tipAllowed=1");
    expect(lines.length).toBe(9);
  });

  it("每行格式为 id / family / 签名 / 载体 / tip", () => {
    const lines = renderCatalog().split("\n");
    expect(lines).toContain(
      "- oscillation [rework-chain] reversal+re-entry → tip,decision-gate,tool tip=true",
    );
    expect(lines).toContain(
      "- parallel-clash [coordination] overlap+fanout → claim-lock,search-scope tip=false",
    );
    expect(lines.filter((l) => l.startsWith("- ")).length).toBe(8);
  });

  it("自定义目录按 form id 排序并重算计数", () => {
    const text = renderCatalog([form("parallel-clash"), form("oscillation")]);
    const lines = text.split("\n");
    expect(lines[0]).toBe("pathology catalog v1 forms=2 tipAllowed=1");
    expect(lines[1].startsWith("- oscillation")).toBe(true);
    expect(lines[2].startsWith("- parallel-clash")).toBe(true);
  });
});
