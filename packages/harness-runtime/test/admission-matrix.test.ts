/**
 * 准入矩阵纯逻辑直测(零 IO):7 格结论、explicitGrant 优先级、invalid fail-closed、
 * traces 全量不短路、确定性与不可变。
 */
import { describe, expect, it } from "vitest";
import {
  ADMISSION_MATRIX,
  ADMISSION_MATRIX_VERSION,
  ADMISSION_MODES,
  ADMISSION_RULE_IDS,
  evaluateAdmission,
  isAdmissionMode,
  summarizeAdmission,
  type AdmissionInput,
  type AdmissionMode,
} from "../src/agent/admission-matrix.ts";

const base = (over: Partial<AdmissionInput> = {}): AdmissionInput => ({
  listed: false,
  addressed: false,
  mode: "observe",
  explicitGrant: false,
  source: "im",
  ...over,
});

describe("7 格矩阵:listed/unlisted × addressed/unaddressed × mode", () => {
  it("A) listed+addressed+observe → admit explicit(addressed,mode 不参与)", () => {
    const r = evaluateAdmission(base({ listed: true, addressed: true, mode: "observe" }));
    expect(r.decision).toMatchObject({ admit: true, strength: "explicit", reason: "addressed", ruleId: "listed-addressed" });
  });

  it("A2) listed+addressed+auto → 同一格 listed-addressed(auto 不改结论)", () => {
    const r = evaluateAdmission(base({ listed: true, addressed: true, mode: "auto" }));
    expect(r.decision.ruleId).toBe("listed-addressed");
    expect(r.decision.strength).toBe("explicit");
  });

  it("B) listed+unaddressed+observe → not admit observed + wouldAccept", () => {
    const r = evaluateAdmission(base({ listed: true, mode: "observe" }));
    expect(r.decision).toMatchObject({
      admit: false,
      strength: "none",
      reason: "observed",
      ruleId: "listed-unaddressed-observe",
      wouldAccept: true,
    });
  });

  it("C) listed+unaddressed+auto → admit inferred", () => {
    const r = evaluateAdmission(base({ listed: true, mode: "auto" }));
    expect(r.decision).toMatchObject({ admit: true, strength: "inferred", reason: "mode_auto", ruleId: "listed-unaddressed-auto" });
    expect(r.decision.wouldAccept).toBeUndefined();
  });

  it("C2) listed+unaddressed+allow → admit explicit(配置允许)", () => {
    const r = evaluateAdmission(base({ listed: true, mode: "allow" }));
    expect(r.decision).toMatchObject({ admit: true, strength: "explicit", reason: "mode_allow", ruleId: "listed-unaddressed-allow" });
  });

  it("D) unlisted+addressed → not admit unlisted(点名不能绕过白名单)", () => {
    const r = evaluateAdmission(base({ listed: false, addressed: true, mode: "auto" }));
    expect(r.decision).toMatchObject({ admit: false, strength: "none", reason: "unlisted", ruleId: "unlisted-addressed" });
    expect(r.decision.wouldAccept).toBeUndefined();
  });

  it("D2) unlisted+unaddressed+allow → not admit unlisted(配置允许也不越白名单)", () => {
    const r = evaluateAdmission(base({ listed: false, addressed: false, mode: "allow" }));
    expect(r.decision).toMatchObject({ admit: false, reason: "unlisted", ruleId: "unlisted-unaddressed" });
  });

  it("source 不参与格位选择:panel 与 im 同输入同结论", () => {
    const a = evaluateAdmission(base({ listed: true, mode: "auto", source: "panel" }));
    const b = evaluateAdmission(base({ listed: true, mode: "auto", source: "im" }));
    expect(a.decision).toEqual(b.decision);
  });
});

describe("explicitGrant:优先于 listed 判定", () => {
  it("E) explicitGrant + unlisted → admit explicit(explicit_grant)", () => {
    const r = evaluateAdmission(base({ listed: false, addressed: false, mode: "observe", explicitGrant: true }));
    expect(r.decision).toMatchObject({ admit: true, strength: "explicit", reason: "explicit_grant", ruleId: "explicit-grant" });
  });

  it("E2) explicitGrant 压过 listed+unaddressed+observe 的 observed 结论", () => {
    const r = evaluateAdmission(base({ listed: true, mode: "observe", explicitGrant: true }));
    expect(r.decision.ruleId).toBe("explicit-grant");
    expect(r.decision.admit).toBe(true);
  });

  it("E3) explicitGrant 不豁免非法 mode:invalid 优先(fail-closed)", () => {
    const r = evaluateAdmission(base({ explicitGrant: true, mode: "bogus" as unknown as AdmissionMode }));
    expect(r.decision).toMatchObject({ admit: false, reason: "invalid", ruleId: "invalid-input" });
  });
});

describe("invalid / 缺字段 → fail-closed", () => {
  it("F) 未知 mode → invalid,strength=none", () => {
    const r = evaluateAdmission(base({ mode: "sometimes" as unknown as AdmissionMode }));
    expect(r.decision).toMatchObject({ admit: false, strength: "none", reason: "invalid", ruleId: "invalid-input" });
  });

  it("F2) 缺 mode(undefined)→ invalid", () => {
    const r = evaluateAdmission({ listed: true, addressed: true, explicitGrant: false, source: "im" } as unknown as AdmissionInput);
    expect(r.decision.reason).toBe("invalid");
  });

  it("F3) listed 非布尔 → invalid", () => {
    const r = evaluateAdmission(base({ listed: "yes" as unknown as boolean }));
    expect(r.decision.reason).toBe("invalid");
  });

  it("F4) addressed 缺字段 → invalid", () => {
    const r = evaluateAdmission({ listed: true, mode: "auto", explicitGrant: false, source: "im" } as unknown as AdmissionInput);
    expect(r.decision.reason).toBe("invalid");
  });

  it("F5) 空 source → invalid", () => {
    const r = evaluateAdmission(base({ source: "" }));
    expect(r.decision.reason).toBe("invalid");
  });

  it("F6) 非对象 / null 入参不 throw,按 invalid 处理", () => {
    expect(() => evaluateAdmission(null as unknown as AdmissionInput)).not.toThrow();
    expect(evaluateAdmission(null as unknown as AdmissionInput).decision.reason).toBe("invalid");
    expect(evaluateAdmission({} as AdmissionInput).decision.admit).toBe(false);
  });
});

describe("traces:逐条评估、不短路", () => {
  it("G) traces 覆盖全部 ruleId 且顺序固定(长度=规则数)", () => {
    const r = evaluateAdmission(base({ listed: true, mode: "auto" }));
    expect(r.traces.map((t) => t.ruleId)).toEqual([...ADMISSION_RULE_IDS]);
    expect(r.traces).toHaveLength(ADMISSION_RULE_IDS.length);
  });

  it("G2) 网格格位只命中一格", () => {
    const r = evaluateAdmission(base({ listed: true, mode: "allow" }));
    expect(r.traces.filter((t) => t.matched)).toHaveLength(1);
  });

  it("G3) 不短路:invalid+explicitGrant 同时命中,两条 rules 都被评估", () => {
    const r = evaluateAdmission(base({ explicitGrant: true, mode: "bogus" as unknown as AdmissionMode }));
    const matched = r.traces.filter((t) => t.matched).map((t) => t.ruleId);
    expect(matched).toContain("invalid-input");
    expect(matched).toContain("explicit-grant");
 // 最终判定仍取 fail-closed 的 invalid(优先级最高),而不是被后面的 explicit 翻盘。
    expect(r.decision.ruleId).toBe("invalid-input");
  });

  it("G4) 未命中规则不带 decision 字段,命中规则带", () => {
    const r = evaluateAdmission(base({ listed: false, addressed: true }));
    for (const t of r.traces) {
      if (t.matched) expect(t.decision).toBeDefined();
      else expect(t.decision).toBeUndefined();
    }
  });

  it("G5) 最终 decision 就是命中格位 trace 上的 decision", () => {
    const r = evaluateAdmission(base({ listed: true, addressed: true }));
    const hit = r.traces.find((t) => t.matched);
    expect(hit?.decision).toBe(r.decision);
  });

  it("traces 长度不受命中数量影响:单命中与双命中都是全量", () => {
    const single = evaluateAdmission(base({ listed: true, mode: "auto" }));
    const double = evaluateAdmission(base({ listed: false, addressed: false }));
    expect(single.traces).toHaveLength(double.traces.length);
  });
});

describe("确定性、不可变、版本", () => {
  it("同输入两次结果逐字相等(确定性)", () => {
    const input = base({ listed: true, addressed: true, mode: "auto" });
    expect(evaluateAdmission(input)).toEqual(evaluateAdmission(input));
  });

  it("不改写入参:冻结入参后照常评估", () => {
    const input = Object.freeze(base({ listed: true, mode: "allow" }));
    expect(() => evaluateAdmission(input)).not.toThrow();
    expect(input).toEqual(base({ listed: true, mode: "allow" }));
  });

  it("返回值全冻结:decision / traces / 每条 trace / 整体结果", () => {
    const r = evaluateAdmission(base({ listed: true }));
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.decision)).toBe(true);
    expect(Object.isFrozen(r.traces)).toBe(true);
    for (const t of r.traces) expect(Object.isFrozen(t)).toBe(true);
  });

  it("矩阵常量冻结且共 7 格,ruleId 唯一,与实跑结果一致", () => {
    expect(Object.isFrozen(ADMISSION_MATRIX)).toBe(true);
    expect(ADMISSION_MATRIX).toHaveLength(7);
    expect(new Set(ADMISSION_MATRIX.map((c) => c.ruleId)).size).toBe(7);
    for (const cell of ADMISSION_MATRIX) {
      const listed = cell.listed === "*" ? false : cell.listed;
      const addressed = cell.addressed === "*" ? false : cell.addressed;
      const mode = (cell.mode === "*" ? "observe" : cell.mode) as AdmissionMode;
      const explicitGrant = cell.ruleId === "explicit-grant";
      const r = evaluateAdmission({ listed, addressed, mode, explicitGrant, source: "im" });
      expect({ ruleId: r.decision.ruleId, admit: r.decision.admit, strength: r.decision.strength, reason: r.decision.reason }).toEqual({
        ruleId: cell.ruleId,
        admit: cell.admit,
        strength: cell.strength,
        reason: cell.reason,
      });
    }
  });

  it("版本常量:matrixVersion 与导出常量逐字一致", () => {
    const r = evaluateAdmission(base());
    expect(r.matrixVersion).toBe(ADMISSION_MATRIX_VERSION);
    expect(ADMISSION_MATRIX_VERSION).toBe("m187/v1");
  });

  it("isAdmissionMode 只认三个枚举值", () => {
    for (const mode of ADMISSION_MODES) expect(isAdmissionMode(mode)).toBe(true);
    expect(isAdmissionMode("bogus")).toBe(false);
    expect(isAdmissionMode(undefined)).toBe(false);
  });
});

describe("summarizeAdmission:人读摘要", () => {
  it("包含每条 ruleId 与命中计数,且确定性", () => {
    const r = evaluateAdmission(base({ listed: true, mode: "auto" }));
    const s = summarizeAdmission(r.traces);
    for (const id of ADMISSION_RULE_IDS) expect(s).toContain(id);
    expect(s).toContain(`rules=${ADMISSION_RULE_IDS.length}`);
    expect(s).toContain("matched=1");
    expect(summarizeAdmission(r.traces)).toBe(s);
  });

  it("命中格位显示 admit/deny + reason", () => {
    const r = evaluateAdmission(base({ listed: true }));
    expect(summarizeAdmission(r.traces)).toContain("listed-unaddressed-observe:deny/observed");
  });

  it("空 traces 不 throw", () => {
    expect(() => summarizeAdmission([])).not.toThrow();
    expect(summarizeAdmission([])).toContain("rules=0");
  });
});
