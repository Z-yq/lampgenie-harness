/**
 * 源码级改进提案通道:归一化/判重键/建提案/判重/合并/流转/发版/发版核对/取代/知识面投影/渲染。
 * 全部纯数据 + 固定时间戳,不碰文件与真实时钟。
 */
import { describe, expect, it } from "vitest";
import {
  CHANGE_REQUEST_VERSION,
  CHANGE_REQ_CODES,
  CHANGE_REQ_CREATED,
  CHANGE_REQ_DUPLICATED,
  CHANGE_REQ_INVALID,
  CHANGE_REQ_MERGED,
  CHANGE_REQ_REJECTED,
  CHANGE_REQ_STATUS_UNCHANGED,
  CHANGE_REQ_STILL_OBSERVED,
  CHANGE_REQ_SUPERSEDED,
  CHANGE_REQ_TRANSITION_INVALID,
  CHANGE_REQ_VERIFIED,
  createProposal,
  findDuplicate,
  mergeProposal,
  markShipped,
  normalizeTitle,
  proposalKey,
  renderProposalMarkdown,
  supersede,
  toGraphNode,
  transition,
  verifyAfterRelease,
} from "../src/agent/change-request.ts";
import type { ChangeRequest } from "../src/agent/change-request.ts";

const T0 = 1_700_000_000_000;
const T1 = 1_700_000_100_000;
const T2 = 1_700_000_200_000;
const T3 = 1_700_000_300_000;

const MODULE = "apps/gateway/src/change-request-store.ts";

/** 一条合法的 bug 提案(带证据与复现)。 */
function bugInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Export drops the last row",
    kind: "bug",
    target: { module: MODULE, symbol: "exportMarkdown" },
    evidenceRefs: ["ev-1"],
    reproSteps: ["run exportMarkdown with 3 rows"],
    expectedBehavior: "all rows are exported",
    observedBehavior: "the last row is missing",
    impact: { files: ["apps/gateway/src/change-request-store.ts"], blastRadius: "single store" },
    ...overrides,
  };
}

/** 直接造一条可参与判重/流转的提案(失败即抛,证明前置合法)。 */
function mustCreate(overrides: Record<string, unknown> = {}, at = T0): ChangeRequest {
  const res = createProposal(bugInput(overrides), { at });
  if (!res.request) throw new Error(`createProposal failed: ${res.codes.join(",")}`);
  return res.request;
}

describe("CHANGE_REQ_CODES 与版本", () => {
  it("版本常量为 1", () => {
    expect(CHANGE_REQUEST_VERSION).toBe(1);
  });

  it("稳定码数组恰好 10 个且顺序固定", () => {
    expect(CHANGE_REQ_CODES).toEqual([
      "CHANGE_REQ_INVALID",
      "CHANGE_REQ_CREATED",
      "CHANGE_REQ_DUPLICATED",
      "CHANGE_REQ_MERGED",
      "CHANGE_REQ_TRANSITION_INVALID",
      "CHANGE_REQ_STATUS_UNCHANGED",
      "CHANGE_REQ_STILL_OBSERVED",
      "CHANGE_REQ_VERIFIED",
      "CHANGE_REQ_SUPERSEDED",
      "CHANGE_REQ_REJECTED",
    ]);
  });
});

describe("normalizeTitle", () => {
  it("小写并按键把拉丁按词切 token", () => {
    expect(normalizeTitle("Export DROPS rows")).toEqual(["drops", "export", "rows"]);
  });

  it("标点分支等于分隔符", () => {
    expect(normalizeTitle("export-drops,rows!")).toEqual(["drops", "export", "rows"]);
  });

  it("CJK 连续段按 2 字 shingle", () => {
    expect(normalizeTitle("导出丢失行")).toEqual(["出丢", "丢失", "导" + "出", "失行"].sort());
  });

  it("CJK 单字段用单字", () => {
    expect(normalizeTitle("坑")).toEqual(["坑"]);
  });

  it("混合拉丁与 CJK 各自成 token", () => {
    expect(normalizeTitle("Export 丢失")).toEqual(["export", "丢失"]);
  });

  it("去重并排序", () => {
    expect(normalizeTitle("rows rows export")).toEqual(["export", "rows"]);
  });

  it("空串与非字符串返回空数组", () => {
    expect(normalizeTitle("   ")).toEqual([]);
    expect(normalizeTitle(undefined)).toEqual([]);
    expect(normalizeTitle(42)).toEqual([]);
  });
});

describe("proposalKey", () => {
  it("16 位 hex 且稳定", () => {
    const key = proposalKey(bugInput());
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(proposalKey(bugInput())).toBe(key);
  });

  it("大小写与标点等价时同键", () => {
    const a = proposalKey(bugInput({ expectedBehavior: "All rows are exported" }));
    const b = proposalKey(bugInput({ expectedBehavior: "all-rows,are exported!" }));
    expect(a).toBe(b);
  });

  it("module / symbol / kind 不同则键不同", () => {
    const base = proposalKey(bugInput());
    expect(proposalKey(bugInput({ target: { module: "other.ts", symbol: "exportMarkdown" } }))).not.toBe(base);
    expect(proposalKey(bugInput({ target: { module: MODULE, symbol: "other" } }))).not.toBe(base);
    expect(proposalKey(bugInput({ kind: "improvement" }))).not.toBe(base);
  });

  it("非法输入不抛", () => {
    expect(proposalKey(null)).toMatch(/^[0-9a-f]{16}$/);
    expect(proposalKey({})).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("createProposal", () => {
  it("最小合法输入产出 proposed + rsi + 时间戳 + cr- 前缀 id", () => {
    const res = createProposal(bugInput(), { at: T0 });
    expect(res.codes).toEqual([CHANGE_REQ_CREATED]);
    const request = res.request!;
    expect(request.status).toBe("proposed");
    expect(request.provenance).toBe("rsi");
    expect(request.createdAt).toBe(T0);
    expect(request.updatedAt).toBe(T0);
    expect(request.id).toBe(`cr-${request.dedupeKey}`);
    expect(request.dedupeKey).toBe(proposalKey(bugInput()));
  });

  it("缺 title → INVALID", () => {
    expect(createProposal(bugInput({ title: "  " }), { at: T0 }).codes).toEqual([CHANGE_REQ_INVALID]);
  });

  it("缺 target.module → INVALID", () => {
    expect(createProposal(bugInput({ target: { symbol: "x" } }), { at: T0 }).codes).toEqual([CHANGE_REQ_INVALID]);
  });

  it("缺 expectedBehavior / observedBehavior → INVALID", () => {
    expect(createProposal(bugInput({ expectedBehavior: "" }), { at: T0 }).codes).toEqual([CHANGE_REQ_INVALID]);
    expect(createProposal(bugInput({ observedBehavior: "" }), { at: T0 }).codes).toEqual([CHANGE_REQ_INVALID]);
  });

  it("bug 无证据 → INVALID", () => {
    expect(createProposal(bugInput({ evidenceRefs: [] }), { at: T0 }).codes).toEqual([CHANGE_REQ_INVALID]);
  });

  it("bug 无复现步骤 → INVALID", () => {
    expect(createProposal(bugInput({ reproSteps: [] }), { at: T0 }).codes).toEqual([CHANGE_REQ_INVALID]);
  });

  it("非 bug 允许没有证据与复现", () => {
    const res = createProposal(bugInput({ kind: "improvement", evidenceRefs: [], reproSteps: [] }), { at: T0 });
    expect(res.codes).toEqual([CHANGE_REQ_CREATED]);
    expect(res.request!.kind).toBe("improvement");
  });

  it("非空 id 沿用", () => {
    const res = createProposal(bugInput({ id: "cr-custom" }), { at: T0 });
    expect(res.request!.id).toBe("cr-custom");
  });

  it("kind 非法 → INVALID", () => {
    expect(createProposal(bugInput({ kind: "nitpick" }), { at: T0 }).codes).toEqual([CHANGE_REQ_INVALID]);
  });

  it("provenance 非法 → INVALID,human 则沿用", () => {
    expect(createProposal(bugInput({ provenance: "robot" }), { at: T0 }).codes).toEqual([CHANGE_REQ_INVALID]);
    expect(createProposal(bugInput({ provenance: "human" }), { at: T0 }).request!.provenance).toBe("human");
  });

  it("缺省 at 走 Date.now()", () => {
    const before = Date.now();
    const res = createProposal(bugInput());
    expect(res.request!.createdAt).toBeGreaterThanOrEqual(before);
  });

  it("impact / symbol / commit 原样带过", () => {
    const request = mustCreate({ target: { module: MODULE, symbol: "s", commit: "abc123" } });
    expect(request.target).toEqual({ module: MODULE, symbol: "s", commit: "abc123" });
    expect(request.impact.files).toEqual(["apps/gateway/src/change-request-store.ts"]);
    expect(request.impact.blastRadius).toBe("single store");
  });

  it("非对象输入不抛", () => {
    expect(createProposal(undefined).codes).toEqual([CHANGE_REQ_INVALID]);
    expect(createProposal("nope").codes).toEqual([CHANGE_REQ_INVALID]);
  });
});

describe("findDuplicate", () => {
  it("同 dedupeKey(不同 id)→ 命中 dedupeKey", () => {
    const existing = mustCreate({ id: "cr-first" });
    const candidate = createProposal(bugInput({ id: "cr-second" }), { at: T1 }).request!;
    expect(candidate.dedupeKey).toBe(existing.dedupeKey);
    const res = findDuplicate([existing], candidate);
    expect(res.reason).toBe("dedupeKey");
    expect(res.match!.id).toBe("cr-first");
    expect(res.codes).toEqual([CHANGE_REQ_DUPLICATED]);
  });

  it("只有自己(同 id)时不算重复", () => {
    const existing = mustCreate();
    const res = findDuplicate([existing], existing);
    expect(res.match).toBeUndefined();
    expect(res.codes).toEqual([]);
  });

  it("同 module 且标题高度相似 → 命中 similarity", () => {
    const existing = mustCreate();
    const candidate = createProposal(
      bugInput({
        title: "Export drops the last row silently",
        expectedBehavior: "every row is preserved on export",
        observedBehavior: "row count is one short",
      }),
      { at: T1 },
    ).request!;
    expect(candidate.dedupeKey).not.toBe(existing.dedupeKey);
    const res = findDuplicate([existing], candidate);
    expect(res.reason).toBe("similarity");
    expect(res.codes).toEqual([CHANGE_REQ_DUPLICATED]);
  });

  it("同 module 但主题不同 → 不重复", () => {
    const existing = mustCreate();
    const candidate = createProposal(
      bugInput({
        title: "Retry storm in queue",
        expectedBehavior: "retries back off exponentially",
        observedBehavior: "queue melts",
        evidenceRefs: ["ev-2"],
      }),
      { at: T1 },
    ).request!;
    expect(findDuplicate([existing], candidate).codes).toEqual([]);
  });

  it("不同 module 即使标题相同 → 不重复(键不同)", () => {
    const existing = mustCreate();
    const candidate = createProposal(bugInput({ target: { module: "apps/other.ts", symbol: "exportMarkdown" } }), {
      at: T1,
    }).request!;
    expect(findDuplicate([existing], candidate).codes).toEqual([]);
  });

  it("空池 / 非法入参不抛", () => {
    const candidate = createProposal(bugInput(), { at: T1 }).request!;
    expect(findDuplicate([], candidate).codes).toEqual([]);
    expect(findDuplicate("nope", candidate).codes).toEqual([CHANGE_REQ_INVALID]);
    expect(findDuplicate([], { id: "x" }).codes).toEqual([CHANGE_REQ_INVALID]);
  });
});

describe("mergeProposal", () => {
  it("证据去重合并 + 复现追加去重", () => {
    const existing = mustCreate();
    const candidate = mustCreate({ evidenceRefs: ["ev-1", "ev-2"], reproSteps: ["run exportMarkdown with 3 rows", "check count"] }, T1);
    const merged = mergeProposal(existing, candidate, { at: T2 });
    expect(merged.codes).toEqual([CHANGE_REQ_MERGED]);
    expect(merged.request!.evidenceRefs).toEqual(["ev-1", "ev-2"]);
    expect(merged.request!.reproSteps).toEqual(["run exportMarkdown with 3 rows", "check count"]);
  });

  it("观察行为不同则追加补充、相同则不追加", () => {
    const existing = mustCreate();
    const other = mustCreate({ observedBehavior: "two rows are missing" }, T1);
    const merged = mergeProposal(existing, other, { at: T2 });
    expect(merged.request!.observedBehavior).toBe("the last row is missing | 补充: two rows are missing");
    const same = mergeProposal(existing, mustCreate({}, T1), { at: T2 });
    expect(same.request!.observedBehavior).toBe("the last row is missing");
  });

  it("impact 缺字段补齐", () => {
    const existing = mustCreate({ impact: {} });
    const candidate = mustCreate({ impact: { files: ["a.ts"], users: "gateway", blastRadius: "wide" } }, T1);
    const merged = mergeProposal(existing, candidate, { at: T2 });
    expect(merged.request!.impact).toEqual({ files: ["a.ts"], users: "gateway", blastRadius: "wide" });
  });

  it("id/status/dedupeKey 不变,updatedAt 刷新", () => {
    const existing = mustCreate();
    const merged = mergeProposal(existing, mustCreate({}, T1), { at: T2 }).request!;
    expect(merged.id).toBe(existing.id);
    expect(merged.status).toBe("proposed");
    expect(merged.dedupeKey).toBe(existing.dedupeKey);
    expect(merged.createdAt).toBe(T0);
    expect(merged.updatedAt).toBe(T2);
  });

  it("非法入参返回 INVALID", () => {
    expect(mergeProposal(null, mustCreate()).codes).toEqual([CHANGE_REQ_INVALID]);
  });
});

describe("transition", () => {
  it("proposed→accepted 成功并写 lastTransition", () => {
    const res = transition(mustCreate(), "accepted", { by: "lead", note: "排期", at: T1 });
    expect(res.codes).toEqual([]);
    expect(res.request!.status).toBe("accepted");
    expect(res.request!.updatedAt).toBe(T1);
    expect(res.request!.lastTransition).toEqual({ to: "accepted", by: "lead", note: "排期", at: T1 });
  });

  it("accepted→scheduled→shipped 合法", () => {
    const accepted = transition(mustCreate(), "accepted", { at: T1 }).request!;
    const scheduled = transition(accepted, "scheduled", { at: T2 }).request!;
    expect(scheduled.status).toBe("scheduled");
    expect(transition(scheduled, "shipped", { at: T3 }).request!.status).toBe("shipped");
  });

  it("proposed→shipped 非法", () => {
    const request = mustCreate();
    const res = transition(request, "shipped", { at: T1 });
    expect(res.codes).toEqual([CHANGE_REQ_TRANSITION_INVALID]);
    expect(res.request!.status).toBe("proposed");
  });

  it("同状态 → STATUS_UNCHANGED", () => {
    expect(transition(mustCreate(), "proposed", { at: T1 }).codes).toEqual([CHANGE_REQ_STATUS_UNCHANGED]);
  });

  it("→rejected 追加 REJECTED 码", () => {
    const res = transition(mustCreate(), "rejected", { by: "lead", at: T1 });
    expect(res.codes).toEqual([CHANGE_REQ_REJECTED]);
    expect(res.request!.status).toBe("rejected");
  });

  it("→superseded 追加 SUPERSEDED 码", () => {
    expect(transition(mustCreate(), "superseded", { at: T1 }).codes).toEqual([CHANGE_REQ_SUPERSEDED]);
  });

  it("终态不可再流转", () => {
    const rejected = transition(mustCreate(), "rejected", { at: T1 }).request!;
    expect(transition(rejected, "accepted", { at: T2 }).codes).toEqual([CHANGE_REQ_TRANSITION_INVALID]);
  });

  it("未知目标状态 → TRANSITION_INVALID", () => {
    expect(transition(mustCreate(), "archived", { at: T1 }).codes).toEqual([CHANGE_REQ_TRANSITION_INVALID]);
    expect(transition(mustCreate(), 7, { at: T1 }).codes).toEqual([CHANGE_REQ_TRANSITION_INVALID]);
  });

  it("非法 request → INVALID", () => {
    expect(transition({}, "accepted").codes).toEqual([CHANGE_REQ_INVALID]);
  });
});

describe("markShipped", () => {
  it("accepted 状态可发版并写 release", () => {
    const accepted = transition(mustCreate(), "accepted", { at: T1 }).request!;
    const res = markShipped(accepted, { version: "0.9.0", at: T2 });
    expect(res.codes).toEqual([]);
    expect(res.request!.status).toBe("shipped");
    expect(res.request!.release).toEqual({ version: "0.9.0", at: T2 });
    expect(res.request!.updatedAt).toBe(T2);
  });

  it("version 为空 → TRANSITION_INVALID 且原样返回", () => {
    const accepted = transition(mustCreate(), "accepted", { at: T1 }).request!;
    const res = markShipped(accepted, { version: "  ", at: T2 });
    expect(res.codes).toEqual([CHANGE_REQ_TRANSITION_INVALID]);
    expect(res.request!.status).toBe("accepted");
    expect(res.request!.release).toBeUndefined();
  });

  it("proposed / rejected 状态不可发版", () => {
    expect(markShipped(mustCreate(), { version: "1.0.0", at: T1 }).codes).toEqual([CHANGE_REQ_TRANSITION_INVALID]);
    const rejected = transition(mustCreate(), "rejected", { at: T1 }).request!;
    expect(markShipped(rejected, { version: "1.0.0", at: T2 }).codes).toEqual([CHANGE_REQ_TRANSITION_INVALID]);
  });
});

describe("verifyAfterRelease", () => {
  function shipped(): ChangeRequest {
    const accepted = transition(mustCreate(), "accepted", { at: T1 }).request!;
    return markShipped(accepted, { version: "0.9.0", at: T2 }).request!;
  }

  it("仍可观察 → 退回 accepted + STILL_OBSERVED", () => {
    const res = verifyAfterRelease(shipped(), { observed: true, note: "还在丢", at: T3 });
    expect(res.codes).toEqual([CHANGE_REQ_STILL_OBSERVED]);
    expect(res.request!.status).toBe("accepted");
    expect(res.request!.verification).toEqual({ checkedAt: T3, stillObserved: true, note: "还在丢" });
    expect(res.request!.updatedAt).toBe(T3);
  });

  it("确认修好 → 保持 shipped + VERIFIED", () => {
    const res = verifyAfterRelease(shipped(), { observed: false, at: T3 });
    expect(res.codes).toEqual([CHANGE_REQ_VERIFIED]);
    expect(res.request!.status).toBe("shipped");
    expect(res.request!.verification).toEqual({ checkedAt: T3, stillObserved: false });
  });

  it("非 shipped 状态不可核对", () => {
    expect(verifyAfterRelease(mustCreate(), { observed: true, at: T1 }).codes).toEqual([CHANGE_REQ_TRANSITION_INVALID]);
  });

  it("observed 非布尔 → INVALID", () => {
    expect(verifyAfterRelease(shipped(), { observed: "yes" as unknown as boolean, at: T3 }).codes).toEqual([
      CHANGE_REQ_INVALID,
    ]);
  });
});

describe("supersede", () => {
  it("写 superseded + supersededBy + updatedAt", () => {
    const res = supersede(mustCreate(), { byId: "cr-next", at: T1 });
    expect(res.codes).toEqual([CHANGE_REQ_SUPERSEDED]);
    expect(res.request!.status).toBe("superseded");
    expect(res.request!.supersededBy).toBe("cr-next");
    expect(res.request!.updatedAt).toBe(T1);
  });

  it("缺 byId → INVALID 且不改状态", () => {
    const res = supersede(mustCreate(), { at: T1 });
    expect(res.codes).toEqual([CHANGE_REQ_INVALID]);
    expect(res.request!.status).toBe("proposed");
  });
});

describe("toGraphNode", () => {
  it("未修状态 → direction 0.5", () => {
    const node = toGraphNode(mustCreate())!;
    expect(node.kind).toBe("direction");
    expect(node.confidence).toBe(0.5);
    expect(node.associations.module).toBe(MODULE);
    expect(node.associations.symbol).toBe("exportMarkdown");
    expect(node.associations.decision).toBe(mustCreate().id);
    expect(node.statement).toContain("观察「");
    expect(node.statement).toContain("期望「");
  });

  it("scheduled 仍是 direction", () => {
    const accepted = transition(mustCreate(), "accepted", { at: T1 }).request!;
    const scheduled = transition(accepted, "scheduled", { at: T2 }).request!;
    expect(toGraphNode(scheduled)!.kind).toBe("direction");
  });

  it("shipped → anti-pattern 0.35", () => {
    const accepted = transition(mustCreate(), "accepted", { at: T1 }).request!;
    const shipped = markShipped(accepted, { version: "0.9.0", at: T2 }).request!;
    const node = toGraphNode(shipped)!;
    expect(node.kind).toBe("anti-pattern");
    expect(node.confidence).toBe(0.35);
  });

  it("shipped 且核对确认修好(stillObserved=false)→ 0.2", () => {
    const accepted = transition(mustCreate(), "accepted", { at: T1 }).request!;
    const shipped = markShipped(accepted, { version: "0.9.0", at: T2 }).request!;
    const still = verifyAfterRelease(shipped, { observed: false, at: T3 }).request!;
    expect(toGraphNode(still)!.confidence).toBe(0.2);
  });

  it("superseded / rejected → null", () => {
    expect(toGraphNode(supersede(mustCreate(), { byId: "x", at: T1 }).request!)).toBeNull();
    expect(toGraphNode(transition(mustCreate(), "rejected", { at: T1 }).request!)).toBeNull();
    expect(toGraphNode(null)).toBeNull();
  });
});

describe("renderProposalMarkdown", () => {
  it("含一级标题、摘要、证据链、复现步骤、影响面、期望/观察、状态行", () => {
    const md = renderProposalMarkdown(mustCreate());
    expect(md.startsWith("# Export drops the last row")).toBe(true);
    for (const section of ["## 摘要", "## 证据链", "- ev-1", "## 复现步骤", "1. run exportMarkdown with 3 rows"]) {
      expect(md).toContain(section);
    }
    for (const section of ["## 影响面", "`apps/gateway/src/change-request-store.ts`", "single store"]) {
      expect(md).toContain(section);
    }
    expect(md).toContain("## 期望行为");
    expect(md).toContain("## 观察行为");
    expect(md).toContain("## 状态");
    expect(md).toContain("`proposed`");
    expect(md).not.toContain("## 发版核对");
  });

  it("有 release 与 verification 时出现发版核对段", () => {
    const accepted = transition(mustCreate(), "accepted", { at: T1 }).request!;
    const shipped = markShipped(accepted, { version: "0.9.0", at: T2 }).request!;
    const verified = verifyAfterRelease(shipped, { observed: false, note: "干净", at: T3 }).request!;
    const md = renderProposalMarkdown(verified);
    expect(md).toContain("`0.9.0`");
    expect(md).toContain(new Date(T2).toISOString());
    expect(md).toContain("## 发版核对");
    expect(md).toContain("- 备注:干净");
    expect(md).toContain("最近流转");
  });

  it("空证据链/空复现步骤给出占位且不抛", () => {
    const request = createProposal(bugInput({ kind: "improvement", evidenceRefs: [], reproSteps: [] }), { at: T0 })
      .request!;
    const md = renderProposalMarkdown(request);
    expect(md).toContain("(未附证据)");
    expect(md).toContain("_无_");
  });

  it("非法输入返回空串", () => {
    expect(renderProposalMarkdown(undefined)).toBe("");
    expect(renderProposalMarkdown({ id: "x" })).toBe("");
  });
});
