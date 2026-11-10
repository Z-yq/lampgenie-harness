/**
 * feature-boundary 纯函数专项:分层判定 / 三层证据缺失码 / drift / owner 缺口 / E2E 闸门。
 * 只测纯逻辑(零 IO),断言具体值,不做 snapshot。
 */
import { describe, it, expect } from "vitest";
import {
  buildImpactBrief,
  canWriteE2E,
  FB_CODES,
  type CodeRef,
  type ImpactBrief,
  type SemanticFeature,
  type UISurface,
} from "../src/agent/feature-boundary.ts";

const ACCEPTED = { by: "po-zhang", at: "2026-10-29T10:00:00.000Z" };

const ref = (id: string, module: string, symbol: string, extra: Partial<CodeRef> = {}): CodeRef => ({
  id,
  module,
  file: `src/${module}.ts`,
  symbol,
  depth: 1,
  ...extra,
});

const surface = (s: Partial<UISurface> & { id: string }): UISurface => ({
  name: s.name ?? s.id,
  featureId: s.featureId ?? "f1",
  steps: s.steps ?? {},
  ...s,
});

const feature = (s: Partial<SemanticFeature> & { id: string }): SemanticFeature => ({
  name: s.name ?? s.id,
  entries: s.entries ?? [],
  dataFlows: s.dataFlows ?? [],
  ...s,
});

/** 合法最小场景:一个入口 + 覆盖它的 surface + 匹配它的 codeRef(三层齐全)。 */
const cleanInput = (accepted?: { by: string; at: string }) => {
  const base = {
    feature: feature({ id: "f-order", entries: ["submitOrder"] }),
    surfaces: [
      surface({
        id: "s-order",
        name: "下单页",
        featureId: "f-order",
        steps: { draft: "draftOrder", submit: "submitOrder" },
        authoritativeOwner: "team-order",
      }),
    ],
    codeRefs: [ref("c-order", "submitOrder", "submitOrder")],
  };
  return accepted ? { ...base, acceptedSemantics: accepted } : base;
};

const build = (input: unknown): ImpactBrief => buildImpactBrief(input as never);

const levels = (brief: ImpactBrief): Array<[string, string]> => brief.items.map((i) => [i.target, i.level]);
const itemOf = (brief: ImpactBrief, target: string) => brief.items.find((i) => i.target === target);

describe("非法入参 → FB_INVALID 短路", () => {
  it("feature 缺失:不抛,返回空简报", () => {
    const brief = build({ surfaces: [], codeRefs: [] });
    expect(brief).toEqual({
      featureId: "",
      items: [],
      driftCandidates: [],
      unresolvedOwners: [],
      depth3Required: false,
      codes: ["FB_INVALID"],
    });
  });

  it("feature.id 为空串 → 非法", () => {
    const brief = build({ feature: feature({ id: "" }), surfaces: [], codeRefs: [] });
    expect(brief.codes).toEqual(["FB_INVALID"]);
    expect(brief.featureId).toBe("");
  });

  it("feature.id 全空白 → 非法但 featureId 原样回填", () => {
    const brief = build({ feature: feature({ id: "   " }), surfaces: [], codeRefs: [] });
    expect(brief.codes).toEqual(["FB_INVALID"]);
    expect(brief.featureId).toBe("   ");
  });

  it("entries 非数组 → 非法", () => {
    const brief = build({ feature: { id: "f1", name: "n", entries: "submitOrder" }, surfaces: [], codeRefs: [] });
    expect(brief.codes).toEqual(["FB_INVALID"]);
    expect(brief.featureId).toBe("f1");
    expect(brief.depth3Required).toBe(false);
  });

  it("重复 codeRef id → 非法", () => {
    const brief = build({
      feature: feature({ id: "f1" }),
      surfaces: [],
      codeRefs: [ref("dup", "A", "a"), ref("dup", "B", "b")],
    });
    expect(brief.codes).toEqual(["FB_INVALID"]);
    expect(brief.items).toEqual([]);
  });

  it("codeRef.depth 不在 {1,2} → 非法", () => {
    const brief = build({
      feature: feature({ id: "f1" }),
      surfaces: [],
      codeRefs: [{ ...ref("c3", "A", "a"), depth: 3 as unknown as 1 }],
    });
    expect(brief.codes).toEqual(["FB_INVALID"]);
  });
});

describe("items 分层:入口 / 写流 / 读流 / 去重", () => {
  it("entry → must 且三层证据齐全", () => {
    const brief = buildImpactBrief(cleanInput());
    expect(brief.items).toHaveLength(1);
    expect(brief.items[0]).toEqual({
      target: "entry:submitOrder",
      level: "must",
      rationale: expect.stringContaining("必须"),
      evidence: { semantic: "feature:f-order#entry:submitOrder", surface: "s-order", code: "codeRef:c-order" },
    });
    expect(brief.codes).toEqual(["FB_BUILT", "FB_E2E_BLOCKED"]);
  });

  it("写数据流 → must", () => {
    const brief = buildImpactBrief({
      feature: feature({ id: "f1", dataFlows: [{ from: "OrderService", to: "OrderRepo", kind: "write" }] }),
      surfaces: [],
      codeRefs: [ref("c-svc", "OrderService", "orderService"), ref("c-repo", "OrderRepo", "orderRepo")],
    });
    expect(itemOf(brief, "flow:OrderService->OrderRepo")?.level).toBe("must");
    expect(itemOf(brief, "flow:OrderService->OrderRepo")?.evidence).toEqual({
      semantic: "feature:f1#dataFlow:OrderService->OrderRepo",
      code: "codeRef:c-svc",
    });
    expect(brief.codes).toContain("FB_MISSING_SURFACE");
  });

  it("读数据流 → evidence(仅静态可达)", () => {
    const brief = buildImpactBrief({
      feature: feature({ id: "f1", dataFlows: [{ from: "Reader", to: "Store", kind: "read" }] }),
      surfaces: [],
      codeRefs: [ref("c-reader", "Reader", "reader"), ref("c-store", "Store", "store")],
    });
    expect(itemOf(brief, "flow:Reader->Store")?.level).toBe("evidence");
    expect(itemOf(brief, "flow:Reader->Store")?.rationale).toContain("只读");
  });

  it("相同 target 去重且保留首次出现顺序", () => {
    const brief = buildImpactBrief({
      feature: feature({ id: "f1", entries: ["a", "a", "b"] }),
      surfaces: [],
      codeRefs: [ref("c1", "a", "a"), ref("c2", "b", "b")],
    });
    expect(brief.items.map((i) => i.target)).toEqual(["entry:a", "entry:b"]);
  });

  it("不同 codeRef 命中同一 module:symbol → 只保留一个 code item", () => {
    const brief = buildImpactBrief({
      feature: feature({ id: "f1" }),
      surfaces: [],
      codeRefs: [ref("x1", "M", "s", { depth: 2 }), ref("x2", "M", "s", { depth: 2 })],
    });
    const codeItems = brief.items.filter((i) => i.target.startsWith("code:"));
    expect(codeItems).toHaveLength(1);
    expect(codeItems[0]?.target).toBe("code:M:s");
    expect(codeItems[0]?.evidence.code).toBe("codeRef:x1");
  });
});

describe("其余 codeRef 定级优先级", () => {
  it("symbol 命中 schema 关键词 → invariant", () => {
    const brief = buildImpactBrief({
      feature: feature({ id: "f1" }),
      surfaces: [],
      codeRefs: [ref("c-schema", "user", "UserSchema")],
    });
    const item = itemOf(brief, "code:user:UserSchema");
    expect(item?.level).toBe("invariant");
    expect(item?.rationale).toContain("不变量");
  });

  it("file 以 .schema.ts 结尾 → invariant", () => {
    const brief = buildImpactBrief({
      feature: feature({ id: "f1" }),
      surfaces: [],
      codeRefs: [ref("c-meta", "orderMeta", "orderMeta", { file: "src/orderMeta.schema.ts" })],
    });
    expect(itemOf(brief, "code:orderMeta:orderMeta")?.level).toBe("invariant");
  });

  it("invariant 优先于 conditional(dependsOn 也命中)", () => {
    const brief = buildImpactBrief({
      feature: feature({ id: "f1", dependsOn: ["OrderProtocol"] }),
      surfaces: [],
      codeRefs: [ref("c-proto", "OrderProtocol", "orderProtocol")],
    });
    expect(itemOf(brief, "code:OrderProtocol:orderProtocol")?.level).toBe("invariant");
  });

  it("被 ≥2 个不同 featureId 的 surface 共享 → should", () => {
    const brief = buildImpactBrief({
      feature: feature({ id: "f1" }),
      surfaces: [
        surface({ id: "s-a", featureId: "f1", steps: { draft: "SharedPicker" } }),
        surface({ id: "s-b", featureId: "f2", steps: { submit: "SharedPicker" } }),
      ],
      codeRefs: [ref("c-shared", "SharedPicker", "sharedPicker")],
    });
    const item = itemOf(brief, "code:SharedPicker:sharedPicker");
    expect(item?.level).toBe("should");
    expect(item?.evidence.semantic).toBe("feature:f1#module:SharedPicker");
    expect(item?.evidence.surface).toBe("s-a");
  });

  it("dependsOn 命中 → conditional", () => {
    const brief = buildImpactBrief({
      feature: feature({ id: "f1", dependsOn: ["auditClient"] }),
      surfaces: [],
      codeRefs: [ref("c-audit", "auditClient", "auditClient")],
    });
    expect(itemOf(brief, "code:auditClient:auditClient")?.level).toBe("conditional");
    expect(itemOf(brief, "code:auditClient:auditClient")?.rationale).toContain("dependsOn");
  });

  it("仅被「只有 draft」的 surface 覆盖 → conditional", () => {
    const brief = buildImpactBrief({
      feature: feature({ id: "f1" }),
      surfaces: [surface({ id: "s-draft", featureId: "f1", steps: { draft: "Prefill" } })],
      codeRefs: [ref("c-prefill", "Prefill", "prefill")],
    });
    const item = itemOf(brief, "code:Prefill:prefill");
    expect(item?.level).toBe("conditional");
    expect(item?.rationale).toContain("可选流");
  });

  it("被有 submit 的 surface 覆盖但不是入口/端点 → evidence", () => {
    const brief = buildImpactBrief({
      feature: feature({ id: "f1" }),
      surfaces: [surface({ id: "s-full", featureId: "f1", steps: { draft: "d", validate: "v", submit: "s" } })],
      codeRefs: [ref("c-widget", "s", "s")],
    });
    expect(itemOf(brief, "code:s:s")?.level).toBe("evidence");
  });

  it("未知 codeRef → evidence 且缺 semantic 层(不猜)", () => {
    const brief = buildImpactBrief({
      feature: feature({ id: "f1" }),
      surfaces: [],
      codeRefs: [ref("c-helper", "InternalHelper", "internalHelper")],
    });
    const item = itemOf(brief, "code:InternalHelper:internalHelper");
    expect(item?.level).toBe("evidence");
    expect(item?.evidence).toEqual({ code: "codeRef:c-helper" });
    expect(item?.evidence.semantic).toBeUndefined();
    expect(brief.codes).toContain("FB_MISSING_SEMANTIC");
  });

  it("evidence 档 rationale 显式标注最弱", () => {
    const brief = buildImpactBrief({
      feature: feature({ id: "f1" }),
      surfaces: [],
      codeRefs: [ref("c-helper", "InternalHelper", "internalHelper")],
    });
    expect(itemOf(brief, "code:InternalHelper:internalHelper")?.rationale).toContain("最弱");
  });
});

describe("三层证据缺失码", () => {
  it("无 surface → FB_MISSING_SURFACE", () => {
    const brief = buildImpactBrief({
      feature: feature({ id: "f-order", entries: ["submitOrder"] }),
      surfaces: [],
      codeRefs: [ref("c-order", "submitOrder", "submitOrder")],
    });
    expect(brief.items[0]?.evidence.surface).toBeUndefined();
    expect(brief.codes).toEqual(["FB_BUILT", "FB_MISSING_SURFACE", "FB_E2E_BLOCKED"]);
  });

  it("无 code → FB_MISSING_CODE(并因入口无 module 命中产生 drift B)", () => {
    const brief = buildImpactBrief({
      feature: feature({ id: "f-order", entries: ["submitOrder"] }),
      surfaces: [
        surface({
          id: "s-order",
          featureId: "f-order",
          steps: { submit: "submitOrder" },
          authoritativeOwner: "team-order",
        }),
      ],
      codeRefs: [],
    });
    expect(brief.items[0]?.evidence.code).toBeUndefined();
    expect(brief.codes).toEqual(["FB_BUILT", "FB_MISSING_CODE", "FB_DRIFT", "FB_E2E_BLOCKED"]);
    expect(brief.driftCandidates).toEqual([{ target: "entry:submitOrder", reason: "语义图声明但 depth1/2 codeRef 未见" }]);
  });

  it("多缺层组合:去重且升序排列", () => {
    const brief = buildImpactBrief({
      feature: feature({ id: "f-mix", entries: ["a", "b"] }),
      surfaces: [],
      codeRefs: [ref("c-helper", "Helper", "helper")],
    });
    expect(brief.codes).toEqual([
      "FB_BUILT",
      "FB_MISSING_CODE",
      "FB_MISSING_SEMANTIC",
      "FB_MISSING_SURFACE",
      "FB_DRIFT",
      "FB_E2E_BLOCKED",
    ]);
    expect(brief.items.map((i) => i.target)).toEqual(["entry:a", "entry:b", "code:Helper:helper"]);
  });
});

describe("driftCandidates", () => {
  const driftAInput = () => ({
    feature: feature({ id: "f1", entries: ["submitOrder"] }),
    surfaces: [surface({ id: "s-orphan", featureId: "f1", steps: { submit: "submitOrder" } })],
    codeRefs: [ref("c-order", "submitOrder", "submitOrder")],
  });

  it("drift A:surface 缺 owner 但 code 侧有候选", () => {
    const brief = buildImpactBrief(driftAInput());
    expect(brief.driftCandidates).toEqual([
      { target: "surface:s-orphan", reason: "surface 未声明 authoritativeOwner,code 侧有候选 owner" },
    ]);
    expect(brief.codes).toContain("FB_DRIFT");
    expect(brief.unresolvedOwners).toEqual([]);
  });

  it("drift B:entry 在 codeRef 里找不到 module", () => {
    const brief = buildImpactBrief({
      feature: feature({ id: "f1", entries: ["ghostEntry"] }),
      surfaces: [],
      codeRefs: [ref("c-x", "Other", "other")],
    });
    expect(brief.driftCandidates).toContainEqual({ target: "entry:ghostEntry", reason: "语义图声明但 depth1/2 codeRef 未见" });
  });

  it("drift B:flow 端点未见 → 同一 flow 只报一次", () => {
    const brief = buildImpactBrief({
      feature: feature({ id: "f1", dataFlows: [{ from: "Svc", to: "Repo", kind: "write" }] }),
      surfaces: [],
      codeRefs: [ref("c-svc", "Svc", "svc")],
    });
    const flowDrifts = brief.driftCandidates.filter((d) => d.target === "flow:Svc->Repo");
    expect(flowDrifts).toHaveLength(1);
    expect(flowDrifts[0]?.reason).toBe("语义图声明但 depth1/2 codeRef 未见");
  });

  it("无 drift 时不追加 FB_DRIFT", () => {
    const brief = buildImpactBrief(cleanInput());
    expect(brief.driftCandidates).toEqual([]);
    expect(brief.codes).not.toContain("FB_DRIFT");
  });
});

describe("owner 缺口与 depth3Required", () => {
  it("非关键 owner 缺失 → unresolvedOwners 有值但 depth3Required=false", () => {
    const brief = buildImpactBrief({
      feature: feature({ id: "f1", entries: ["submitOrder"] }),
      surfaces: [surface({ id: "s-browse", featureId: "f1", steps: { draft: "browseList" } })],
      codeRefs: [ref("c-order", "submitOrder", "submitOrder")],
    });
    expect(brief.unresolvedOwners).toEqual(["surface:s-browse"]);
    expect(brief.depth3Required).toBe(false);
    expect(brief.codes).toContain("FB_UNRESOLVED_OWNER");
    expect(brief.codes).not.toContain("FB_DEPTH3_REQUIRED");
  });

  it("关键 submit owner 缺失 → depth3Required=true", () => {
    const brief = buildImpactBrief({
      feature: feature({ id: "f1", entries: ["go"] }),
      surfaces: [surface({ id: "s-submit", featureId: "f1", steps: { submit: "other" } })],
      codeRefs: [ref("c-go", "go", "go")],
    });
    expect(brief.unresolvedOwners).toEqual(["surface:s-submit"]);
    expect(brief.depth3Required).toBe(true);
    expect(brief.codes).toContain("FB_DEPTH3_REQUIRED");
  });

  it("surface 对应 entries[0] 且缺 owner → depth3Required=true", () => {
    const brief = buildImpactBrief({
      feature: feature({ id: "f1", entries: ["home"] }),
      surfaces: [surface({ id: "home", featureId: "f1", steps: { draft: "homeDraft" } })],
      codeRefs: [ref("c-init", "homeInit", "homeInit")],
    });
    expect(brief.unresolvedOwners).toEqual(["surface:home"]);
    expect(brief.depth3Required).toBe(true);
  });

  it("有 authoritativeOwner → unresolvedOwners 为空且无 UNRESOLVED_OWNER 码", () => {
    const brief = buildImpactBrief(cleanInput());
    expect(brief.unresolvedOwners).toEqual([]);
    expect(brief.codes).not.toContain("FB_UNRESOLVED_OWNER");
  });
});

describe("canWriteE2E 闸门", () => {
  it("未验收语义 → false 且 codes 以 E2E_BLOCKED 收尾", () => {
    const brief = buildImpactBrief(cleanInput());
    expect(canWriteE2E(brief)).toBe(false);
    expect(brief.codes.at(-1)).toBe("FB_E2E_BLOCKED");
  });

  it("验收后 → true 且 codes 以 E2E_ALLOWED 收尾", () => {
    const brief = buildImpactBrief(cleanInput(ACCEPTED));
    expect(canWriteE2E(brief)).toBe(true);
    expect(brief.codes).toEqual(["FB_BUILT", "FB_E2E_ALLOWED"]);
  });

  it("must 缺层即使已验收 E2E 仍阻塞", () => {
    const brief = buildImpactBrief({
      feature: feature({ id: "f1", entries: ["go"] }),
      surfaces: [surface({ id: "s1", featureId: "f1", steps: { submit: "go" }, authoritativeOwner: "team" })],
      codeRefs: [],
      acceptedSemantics: ACCEPTED,
    });
    expect(canWriteE2E(brief)).toBe(false);
    expect(brief.codes.at(-1)).toBe("FB_E2E_BLOCKED");
  });

  it("只有非 must 项缺层时不阻塞", () => {
    const brief = buildImpactBrief({
      feature: feature({ id: "f1" }),
      surfaces: [],
      codeRefs: [ref("c-helper", "Helper", "helper")],
      acceptedSemantics: ACCEPTED,
    });
    expect(brief.items.every((i) => i.level !== "must")).toBe(true);
    expect(canWriteE2E(brief)).toBe(true);
    expect(brief.codes).toEqual(["FB_BUILT", "FB_MISSING_SEMANTIC", "FB_MISSING_SURFACE", "FB_E2E_ALLOWED"]);
  });

  it("canWriteE2E 与 codes 中的 FB_E2E_ALLOWED 严格等价(多场景)", () => {
    const fixtures: unknown[] = [
      cleanInput(),
      cleanInput(ACCEPTED),
      { feature: feature({ id: "f1", entries: ["go"] }), surfaces: [], codeRefs: [] },
      { feature: feature({ id: "f1" }), surfaces: [], codeRefs: [ref("c1", "Helper", "helper")] },
      {
        feature: feature({ id: "f1", entries: ["go"], dependsOn: ["dep"] }),
        surfaces: [surface({ id: "s1", featureId: "f1", steps: { submit: "go" } })],
        codeRefs: [ref("c1", "go", "go", { depth: 2 }), ref("c2", "dep", "dep")],
        acceptedSemantics: ACCEPTED,
      },
    ];
    for (const fixture of fixtures) {
      const brief = build(fixture);
      expect(canWriteE2E(brief)).toBe(brief.codes.includes("FB_E2E_ALLOWED"));
    }
  });
});

describe("稳定契约:码表 / 顺序 / 空数据 / 幂等 / 不抛", () => {
  it("FB_CODES 值即字面量", () => {
    expect(FB_CODES).toEqual({
      INVALID: "FB_INVALID",
      BUILT: "FB_BUILT",
      MISSING_SEMANTIC: "FB_MISSING_SEMANTIC",
      MISSING_SURFACE: "FB_MISSING_SURFACE",
      MISSING_CODE: "FB_MISSING_CODE",
      DRIFT: "FB_DRIFT",
      UNRESOLVED_OWNER: "FB_UNRESOLVED_OWNER",
      DEPTH3_REQUIRED: "FB_DEPTH3_REQUIRED",
      E2E_BLOCKED: "FB_E2E_BLOCKED",
      E2E_ALLOWED: "FB_E2E_ALLOWED",
    });
  });

  it("codes 顺序固定:BUILT→缺层→DRIFT→OWNER→DEPTH3→E2E", () => {
    const brief = buildImpactBrief({
      feature: feature({ id: "f1", entries: ["go"] }),
      surfaces: [surface({ id: "s-nokey", featureId: "f1", steps: { submit: "go" } })],
      codeRefs: [ref("c-zzz", "zzz", "zzz")],
    });
    expect(brief.codes).toEqual([
      "FB_BUILT",
      "FB_MISSING_CODE",
      "FB_MISSING_SEMANTIC",
      "FB_MISSING_SURFACE",
      "FB_DRIFT",
      "FB_UNRESOLVED_OWNER",
      "FB_DEPTH3_REQUIRED",
      "FB_E2E_BLOCKED",
    ]);
  });

  it("空数据 → 空 items,仅 BUILT + E2E_BLOCKED", () => {
    const brief = buildImpactBrief({ feature: feature({ id: "f-empty" }), surfaces: [], codeRefs: [] });
    expect(brief.items).toEqual([]);
    expect(brief.driftCandidates).toEqual([]);
    expect(brief.unresolvedOwners).toEqual([]);
    expect(brief.depth3Required).toBe(false);
    expect(brief.codes).toEqual(["FB_BUILT", "FB_E2E_BLOCKED"]);
  });

  it("幂等:两次调用深相等", () => {
    const input = cleanInput(ACCEPTED);
    expect(buildImpactBrief(input)).toEqual(buildImpactBrief(input));
  });

  it("semanticsAccepted 原样透传", () => {
    const accepted = { by: "qa-li", at: "2026-10-29T11:22:33.000Z" };
    const brief = buildImpactBrief(cleanInput(accepted));
    expect(brief.semanticsAccepted).toEqual(accepted);
    expect(buildImpactBrief(cleanInput()).semanticsAccepted).toBeUndefined();
  });

  it("野输入不抛异常", () => {
    const wild: unknown[] = [
      undefined,
      null,
      42,
      "feature",
      {},
      { feature: null },
      { feature: { id: "f1" } },
      { feature: { id: "f1", entries: [] }, surfaces: null, codeRefs: null },
      { feature: feature({ id: "f1", entries: ["go"] }), surfaces: [null], codeRefs: [null] },
    ];
    for (const input of wild) {
      expect(() => build(input)).not.toThrow();
      expect(Array.isArray(build(input).codes)).toBe(true);
    }
  });

  it("非法输入的 featureId 用 String(feature?.id ?? \"\") 兜底", () => {
    expect(build({ feature: { id: 7, entries: [] } }).featureId).toBe("7");
    expect(build(undefined).featureId).toBe("");
  });

  it("空 featureId 非法时 items 一律为空(不产出半份清单)", () => {
    const brief = build({ feature: feature({ id: "" , entries: ["go"] }), surfaces: [], codeRefs: [] });
    expect(brief.items).toEqual([]);
    expect(brief.codes).toEqual(["FB_INVALID"]);
  });

  it("levels 集合只含契约中的五档", () => {
    const brief = buildImpactBrief({
      feature: feature({ id: "f1", entries: ["go"], dataFlows: [{ from: "A", to: "B", kind: "read" }], dependsOn: ["dep"] }),
      surfaces: [surface({ id: "s1", featureId: "f1", steps: { submit: "go" }, authoritativeOwner: "t" })],
      codeRefs: [ref("c-go", "go", "go"), ref("c-a", "A", "a"), ref("c-b", "B", "b"), ref("c-dep", "dep", "dep")],
    });
    const allowed = ["must", "should", "conditional", "invariant", "evidence"];
    expect(levels(brief).every(([, level]) => allowed.includes(level))).toBe(true);
  });
});
