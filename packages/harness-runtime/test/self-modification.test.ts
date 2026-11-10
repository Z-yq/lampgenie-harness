/**
 * RSI #196 自我修改安全门:六件套 / 审批矩阵 / 结论优先级 / 冻结 hash / 执行计划 / 码表快照 / 零 IO 纪律。
 * 全纯函数直测,不触 IO(唯一例外:读源码文本断言依赖纪律)。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FROZEN_FIELDS,
  MODIFICATION_SURFACES,
  SELF_MOD_CODES,
  SELF_MOD_SCHEMA_VERSION,
  applyPlan,
  canonicalModificationJson,
  compileRollback,
  evaluateSelfModification,
  freezeSelfModification,
  frozenModificationValue,
  verifySelfModification,
} from "../src/agent/self-modification";
import type { ModificationRequest, SelfModPolicy } from "../src/agent/self-modification";

type Overrides = { [K in keyof ModificationRequest]?: unknown };

const surfaces = [...MODIFICATION_SURFACES];

/** 六件套齐全的基准请求(owner 作者、无 approver、不可逆=false、无风险旗)。 */
function baseRequest(overrides: Overrides = {}): ModificationRequest {
  const base = {
    id: "mod-1",
    schemaVersion: SELF_MOD_SCHEMA_VERSION,
    surface: "tool",
    targetRef: "tool:read_file",
    variant: "v2",
    summary: "提升 read_file 超时",
    author: { kind: "owner", id: "owner-1" },
    evidence: { experimentId: "exp-1", diffSummary: "改 12 行", testsRun: "vitest run read-file" },
    impact: { files: ["src/tool/read.ts"], scanRef: "code-sense:read_file" },
    dryRun: { command: "npx vitest run test/read-file.test.ts", ok: true, at: 1 },
    canary: { scope: "session", size: 1 },
    rollback: { kind: "flag", ref: "flag:read_timeout" },
    ownerName: "genie",
    irreversible: false,
    riskFlags: [] as string[],
    createdAt: 1,
    updatedAt: 1,
    decision: { kind: "pending" },
  };
  return { ...base, ...overrides } as unknown as ModificationRequest;
}

/** 按 surface 给出该面合法的 rollback kind。 */
function surfaceRollback(surface: string): { kind: string; ref: string } {
  if (surface === "code") return { kind: "commit", ref: "abc1234" };
  if (surface === "config") return { kind: "snapshot", ref: "cfg-snap-1" };
  return { kind: "flag", ref: "flag:read_timeout" };
}

/** 该 surface 六件套齐全的合法请求。 */
function validRequest(surface: string): ModificationRequest {
  return baseRequest({ surface, rollback: surfaceRollback(surface) });
}

function evalu(overrides: Overrides = {}, policy: SelfModPolicy = {}) {
  return evaluateSelfModification(baseRequest(overrides), policy);
}

describe("六件套:六类 surface 全覆盖", () => {
  it.each(surfaces)("%s surface 六件套齐全 + owner 作者无 approver → allow", (surface) => {
    const ev = evaluateSelfModification(validRequest(surface));
    expect(ev.decision).toBe("allow");
    expect(ev.codes).toEqual([]);
  });

  it.each(surfaces)("%s surface 缺 evidence 全部 id 引用 → MOD_EVIDENCE_MISSING", (surface) => {
    const ev = evaluateSelfModification(baseRequest({ surface, rollback: surfaceRollback(surface), evidence: {} }));
    expect(ev.codes).toContain("MOD_EVIDENCE_MISSING");
    expect(ev.decision).toBe("deny");
  });

  it.each(["code", "config"])("%s surface 有 evidence id 但缺 diffSummary 与 testsRun → MOD_EVIDENCE_MISSING", (surface) => {
    const ev = evaluateSelfModification(
      baseRequest({ surface, rollback: surfaceRollback(surface), evidence: { experimentId: "exp-1" } }),
    );
    expect(ev.codes).toEqual(["MOD_EVIDENCE_MISSING"]);
    expect(ev.decision).toBe("deny");
  });

  it("code surface 只给 diffSummary(无 testsRun)→ 通过", () => {
    const ev = evaluateSelfModification(
      baseRequest({ surface: "code", rollback: { kind: "commit", ref: "abc" }, evidence: { experimentId: "e", diffSummary: "改 3 行" } }),
    );
    expect(ev.codes).toEqual([]);
    expect(ev.decision).toBe("allow");
  });

  it("config surface 只给 testsRun(无 diffSummary)→ 通过", () => {
    const ev = evaluateSelfModification(
      baseRequest({ surface: "config", rollback: { kind: "config", ref: "cfg-key" }, evidence: { hypothesisId: "hyp-1", testsRun: "vitest run cfg" } }),
    );
    expect(ev.codes).toEqual([]);
  });

  it("evidence.traceBatchKeys / graphNodeIds 单条即算证据 id", () => {
    expect(evalu({ evidence: { traceBatchKeys: ["tb-1"] } }).codes).toEqual([]);
    expect(evalu({ evidence: { graphNodeIds: ["g-1"] } }).codes).toEqual([]);
  });

  it.each(["code", "config"])("%s surface 缺 impact.files 且缺 scanRef → MOD_IMPACT_MISSING", (surface) => {
    const ev = evaluateSelfModification(baseRequest({ surface, rollback: surfaceRollback(surface), impact: {} }));
    expect(ev.codes).toEqual(["MOD_IMPACT_MISSING"]);
    expect(ev.decision).toBe("deny");
  });

  it("code surface 只给 impact.scanRef → 通过;impact.files 为空数组时仍按缺省算", () => {
    expect(
      evaluateSelfModification(baseRequest({ surface: "code", rollback: { kind: "flag", ref: "f" }, impact: { scanRef: "code-sense:x" } })).codes).toEqual([]);
    expect(evaluateSelfModification(baseRequest({ surface: "code", rollback: { kind: "flag", ref: "f" }, impact: { files: [] } })).codes).toEqual([
      "MOD_IMPACT_MISSING",
    ]);
  });

  it("tool surface 不要求 impact(缺 impact 也放行)", () => {
    expect(evalu({ impact: {} }).codes).toEqual([]);
  });
});

describe("dry-run 两码互斥", () => {
  it("dryRun 整个缺失 → MOD_DRYRUN_MISSING", () => {
    const ev = evalu({ dryRun: undefined });
    expect(ev.codes).toEqual(["MOD_DRYRUN_MISSING"]);
    expect(ev.decision).toBe("deny");
  });

  it("dryRun.command 为空白 → MOD_DRYRUN_MISSING", () => {
    expect(evalu({ dryRun: { command: "   ", ok: true, at: 1 } }).codes).toEqual(["MOD_DRYRUN_MISSING"]);
  });

  it("有 command 但 ok=false → MOD_DRYRUN_FAILED(不出现 MISSING)", () => {
    const ev = evalu({ dryRun: { command: "npx vitest run x", ok: false, at: 1 } });
    expect(ev.codes).toEqual(["MOD_DRYRUN_FAILED"]);
    expect(ev.codes).not.toContain("MOD_DRYRUN_MISSING");
  });

  it("command 缺失且 ok=false → 只出 MISSING(两码互斥)", () => {
    const ev = evalu({ dryRun: { command: "", ok: false, at: 1 } });
    expect(ev.codes).toEqual(["MOD_DRYRUN_MISSING"]);
    expect(ev.codes).not.toContain("MOD_DRYRUN_FAILED");
  });
});

describe("canary", () => {
  it("canary 缺失 → MOD_CANARY_MISSING", () => {
    const ev = evalu({ canary: undefined });
    expect(ev.codes).toEqual(["MOD_CANARY_MISSING"]);
  });

  it("canary.scope 非法 → MOD_CANARY_MISSING", () => {
    expect(evalu({ canary: { scope: "global", size: 1 } }).codes).toEqual(["MOD_CANARY_MISSING"]);
  });

  it.each([0, -3])("canary.size=%i → MOD_CANARY_MISSING", (size) => {
    expect(evalu({ canary: { scope: "session", size } }).codes).toEqual(["MOD_CANARY_MISSING"]);
  });

  it.each(["session", "project", "percent"])("canary.scope=%s 且 size>0 → 放行", (scope) => {
    expect(evalu({ canary: { scope, size: 5 } }).codes).toEqual([]);
  });

  it("policy.requireCanary=false 时缺 canary 也放行", () => {
    const ev = evalu({ canary: undefined }, { requireCanary: false });
    expect(ev.codes).toEqual([]);
    expect(ev.decision).toBe("allow");
  });
});

describe("rollback point 与 surface 配对", () => {
  it("rollback.ref 为空白 → MOD_ROLLBACK_MISSING", () => {
    expect(evalu({ rollback: { kind: "flag", ref: "  " } }).codes).toEqual(["MOD_ROLLBACK_MISSING"]);
  });

  it("rollback 整个缺失 → MOD_ROLLBACK_MISSING", () => {
    expect(evalu({ rollback: undefined }).codes).toEqual(["MOD_ROLLBACK_MISSING"]);
  });

  it.each(["config", "snapshot"])("code surface 用 rollback.kind=%s → MOD_ROLLBACK_MISSING", (kind) => {
    const ev = evaluateSelfModification(baseRequest({ surface: "code", rollback: { kind, ref: "r-1" } }));
    expect(ev.codes).toEqual(["MOD_ROLLBACK_MISSING"]);
    expect(ev.decision).toBe("deny");
  });

  it.each(["commit", "flag"])("config surface 用 rollback.kind=%s → MOD_ROLLBACK_MISSING", (kind) => {
    const ev = evaluateSelfModification(baseRequest({ surface: "config", rollback: { kind, ref: "r-1" } }));
    expect(ev.codes).toEqual(["MOD_ROLLBACK_MISSING"]);
  });

  it.each(["commit", "flag"])("code surface 用 rollback.kind=%s → 通过", (kind) => {
    expect(evaluateSelfModification(baseRequest({ surface: "code", rollback: { kind, ref: "r-1" } })).codes).toEqual([]);
  });

  it.each(["config", "snapshot"])("config surface 用 rollback.kind=%s → 通过", (kind) => {
    expect(evaluateSelfModification(baseRequest({ surface: "config", rollback: { kind, ref: "r-1" } })).codes).toEqual([]);
  });

  it("非 code/config surface 不限制 rollback.kind", () => {
    for (const kind of ["commit", "flag", "config", "snapshot"]) {
      expect(evalu({ surface: "tip", rollback: { kind, ref: "r-1" } }).codes).toEqual([]);
    }
  });
});

describe("结构性 deny", () => {
  it.each(["bogus", ""])("surface=%s 非法 → MOD_SURFACE_INVALID 且 deny", (surface) => {
    const ev = evalu({ surface });
    expect(ev.codes).toEqual(["MOD_SURFACE_INVALID"]);
    expect(ev.decision).toBe("deny");
  });

  it("targetRef 为空白 → MOD_TARGET_MISSING 且 deny", () => {
    const ev = evalu({ targetRef: "   " });
    expect(ev.codes).toEqual(["MOD_TARGET_MISSING"]);
    expect(ev.decision).toBe("deny");
  });

  it("summary 为空 → MOD_SUMMARY_MISSING 且 deny", () => {
    const ev = evalu({ summary: "" });
    expect(ev.codes).toEqual(["MOD_SUMMARY_MISSING"]);
    expect(ev.decision).toBe("deny");
  });

  it("author.id 为空 → MOD_AUTHOR_MISSING 且 deny", () => {
    const ev = evalu({ author: { kind: "owner", id: " " } });
    expect(ev.codes).toEqual(["MOD_AUTHOR_MISSING"]);
    expect(ev.decision).toBe("deny");
  });

  it("ownerName 为空 → MOD_OWNER_MISSING 且 deny", () => {
    const ev = evalu({ ownerName: "  " });
    expect(ev.codes).toEqual(["MOD_OWNER_MISSING"]);
    expect(ev.decision).toBe("deny");
  });

  it("多处结构缺失按 SELF_MOD_CODES 顺序合并输出", () => {
    const ev = evalu({ surface: "bogus", targetRef: "", summary: "", ownerName: "" });
    expect(ev.codes).toEqual([
      "MOD_SURFACE_INVALID",
      "MOD_TARGET_MISSING",
      "MOD_SUMMARY_MISSING",
      "MOD_OWNER_MISSING",
    ]);
    expect(ev.decision).toBe("deny");
  });
});

describe("审批矩阵", () => {
  it("rsi 作者 + 无 approver → MOD_RSI_NEEDS_HUMAN,need-approval", () => {
    const ev = evalu({ author: { kind: "rsi", id: "rsi-1" } });
    expect(ev.codes).toEqual(["MOD_RSI_NEEDS_HUMAN"]);
    expect(ev.decision).toBe("need-approval");
  });

  it("rsi 作者 + approver.kind=owner → AGENT_APPROVAL_FORBIDDEN + RSI_NEEDS_HUMAN,need-approval", () => {
    const ev = evalu({ author: { kind: "rsi", id: "rsi-1" }, approver: { kind: "owner", id: "owner-9", at: 1 } });
    expect(ev.codes).toEqual(["MOD_RSI_NEEDS_HUMAN", "MOD_AGENT_APPROVAL_FORBIDDEN"]);
    expect(ev.decision).toBe("need-approval");
  });

  it("rsi 作者 + approver.kind=agent → 同样被拒(非人类审批)", () => {
    const ev = evalu({ author: { kind: "rsi", id: "rsi-1" }, approver: { kind: "agent", id: "agent-9" } });
    expect(ev.codes).toContain("MOD_AGENT_APPROVAL_FORBIDDEN");
    expect(ev.codes).toContain("MOD_RSI_NEEDS_HUMAN");
    expect(ev.decision).toBe("need-approval");
  });

  it("rsi 作者 + human approver(id≠author) → allow", () => {
    const ev = evalu({ author: { kind: "rsi", id: "rsi-1" }, approver: { kind: "human", id: "human-1" } });
    expect(ev.codes).toEqual([]);
    expect(ev.decision).toBe("allow");
  });

  it("approver.id === author.id → MOD_SELF_APPROVAL,need-approval", () => {
    const ev = evalu({ author: { kind: "owner", id: "owner-1" }, approver: { kind: "human", id: "owner-1" } });
    expect(ev.codes).toEqual(["MOD_SELF_APPROVAL"]);
    expect(ev.decision).toBe("need-approval");
  });

  it("irreversible + 无 approver → MOD_IRREVERSIBLE_NEEDS_HUMAN", () => {
    const ev = evalu({ irreversible: true });
    expect(ev.codes).toEqual(["MOD_IRREVERSIBLE_NEEDS_HUMAN"]);
    expect(ev.decision).toBe("need-approval");
  });

  it("irreversible + approver.kind=owner → MOD_IRREVERSIBLE_NEEDS_HUMAN", () => {
    const ev = evalu({ irreversible: true, approver: { kind: "owner", id: "owner-9" } });
    expect(ev.codes).toEqual(["MOD_IRREVERSIBLE_NEEDS_HUMAN"]);
  });

  it("irreversible + approver.kind=human → allow", () => {
    const ev = evalu({ irreversible: true, approver: { kind: "human", id: "human-1" } });
    expect(ev.codes).toEqual([]);
    expect(ev.decision).toBe("allow");
  });

  it("riskFlags 非空 + 无 approver → MOD_RISK_UNREVIEWED", () => {
    const ev = evalu({ riskFlags: ["touches-auth"] });
    expect(ev.codes).toEqual(["MOD_RISK_UNREVIEWED"]);
    expect(ev.decision).toBe("need-approval");
  });

  it("riskFlags 非空 + approver.kind=owner → MOD_RISK_UNREVIEWED", () => {
    expect(evalu({ riskFlags: ["touches-auth"], approver: { kind: "owner", id: "owner-9" } }).codes).toEqual([
      "MOD_RISK_UNREVIEWED",
    ]);
  });

  it("riskFlags 非空 + approver.kind=human → allow", () => {
    expect(evalu({ riskFlags: ["touches-auth"], approver: { kind: "human", id: "human-1" } }).codes).toEqual([]);
  });

  it("agent 作者 + 无 approver(默认 policy)→ allow", () => {
    const ev = evalu({ author: { kind: "agent", id: "agent-1" } });
    expect(ev.codes).toEqual([]);
    expect(ev.decision).toBe("allow");
  });

  it("agent 作者 + 无 approver + allowAgentSelfApprove=false → need-approval(MOD_RISK_UNREVIEWED)", () => {
    const ev = evalu({ author: { kind: "agent", id: "agent-1" } }, { allowAgentSelfApprove: false });
    expect(ev.codes).toEqual(["MOD_RISK_UNREVIEWED"]);
    expect(ev.decision).toBe("need-approval");
  });

  it("owner 作者 + 无 approver → allow", () => {
    expect(evaluateSelfModification(baseRequest()).decision).toBe("allow");
  });

  it("approver.id 为空 = 未提供审批(按缺失路径判)", () => {
    const ev = evalu({ author: { kind: "rsi", id: "rsi-1" }, approver: { kind: "human", id: "  " } });
    expect(ev.codes).toEqual(["MOD_RSI_NEEDS_HUMAN"]);
    expect(ev.decision).toBe("need-approval");
  });
});

describe("结论优先级与码序", () => {
  it("同时缺 evidence 与缺审批 → deny(结构性优先)", () => {
    const ev = evalu({ surface: "tool", evidence: {}, author: { kind: "rsi", id: "rsi-1" } });
    expect(ev.decision).toBe("deny");
    expect(ev.codes).toContain("MOD_EVIDENCE_MISSING");
    expect(ev.codes).toContain("MOD_RSI_NEEDS_HUMAN");
  });

  it("只有审批类问题 → need-approval", () => {
    const ev = evalu({ author: { kind: "rsi", id: "rsi-1" } });
    expect(ev.decision).toBe("need-approval");
  });

  it("codes 顺序恒按 SELF_MOD_CODES 声明序(非发现序)", () => {
    const ev = evalu({ surface: "code", rollback: { kind: "commit", ref: "abc" }, evidence: {}, impact: {}, author: { kind: "rsi", id: "rsi-1" } });
    expect(ev.codes).toEqual(["MOD_EVIDENCE_MISSING", "MOD_IMPACT_MISSING", "MOD_RSI_NEEDS_HUMAN"]);
    const idx = ev.codes.map((code) => SELF_MOD_CODES.indexOf(code));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(ev.decision).toBe("deny");
  });

  it("同一码不重复入 codes(evidence 双分支只出一条)", () => {
    const ev = evalu({ surface: "code", rollback: { kind: "commit", ref: "abc" }, evidence: {} });
    expect(ev.codes.filter((code) => code === "MOD_EVIDENCE_MISSING")).toHaveLength(1);
    expect(ev.details.filter((d) => d.startsWith("MOD_EVIDENCE_MISSING:"))).toHaveLength(1);
  });
});

describe("终态决策不可再评", () => {
  it.each(["allow", "deny", "need-approval"])("decision.kind=%s → MOD_DECISION_FINAL 且 deny", (kind) => {
    const ev = evalu({ decision: { kind, at: 2, codes: [] } });
    expect(ev.codes).toEqual(["MOD_DECISION_FINAL"]);
    expect(ev.decision).toBe("deny");
  });

  it("decision.kind=rolled-back 允许再评(不产生 MOD_DECISION_FINAL)", () => {
    const ev = evalu({ decision: { kind: "rolled-back", at: 2 } });
    expect(ev.codes).not.toContain("MOD_DECISION_FINAL");
    expect(ev.decision).toBe("allow");
  });

  it("decision.kind=pending → 正常评估", () => {
    const ev = evalu({ decision: { kind: "pending" } });
    expect(ev.codes).toEqual([]);
    expect(ev.decision).toBe("allow");
  });
});

describe("冻结 canonical hash", () => {
  it("同一对象两次冻结 hash 相同且为 64 位十六进制", () => {
    const req = baseRequest();
    const a = freezeSelfModification(req);
    const b = freezeSelfModification(req);
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.frozen).toBe(b.frozen);
  });

  it("冻结面字段重排(顶层键序)不影响 hash", () => {
    const asc = baseRequest();
    const desc = {
      riskFlags: [],
      irreversible: false,
      rollback: { kind: "flag", ref: "flag:read_timeout" },
      dryRun: { command: "npx vitest run test/read-file.test.ts", ok: true, at: 1 },
      impact: { files: ["src/tool/read.ts"], scanRef: "code-sense:read_file" },
      evidence: { experimentId: "exp-1", diffSummary: "改 12 行", testsRun: "vitest run read-file" },
      summary: "提升 read_file 超时",
      variant: "v2",
      targetRef: "tool:read_file",
      surface: "tool",
    };
    expect(freezeSelfModification(desc as unknown as ModificationRequest).hash).toBe(freezeSelfModification(asc).hash);
  });

  it("嵌套对象键序(shallow clone 重组)不影响 hash", () => {
    const req = baseRequest();
    const cloned = { ...req, evidence: { testsRun: "vitest run read-file", diffSummary: "改 12 行", experimentId: "exp-1" } } as ModificationRequest;
    expect(freezeSelfModification(cloned).hash).toBe(freezeSelfModification(req).hash);
  });

  it("数组顺序参与 hash:evidence.traceBatchKeys 换序 → hash 变", () => {
    const req = baseRequest();
    const swapped = {
      ...req,
      evidence: { ...req.evidence, traceBatchKeys: ["tb-a", "tb-b"] },
      riskFlags: [] as string[],
    };
    const swapped2 = {
      ...req,
      evidence: { ...req.evidence, traceBatchKeys: ["tb-b", "tb-a"] },
      riskFlags: [] as string[],
    };
    expect(freezeSelfModification(swapped as ModificationRequest).hash).not.toBe(
      freezeSelfModification(swapped2 as ModificationRequest).hash);
  });

  it.each([
    { name: "summary", mutate: (r: ModificationRequest) => ({ ...r, summary: "换了个说法" }) },
    { name: "targetRef", mutate: (r: ModificationRequest) => ({ ...r, targetRef: "tool:write_file" }) },
    { name: "irreversible", mutate: (r: ModificationRequest) => ({ ...r, irreversible: true }) },
    { name: "riskFlags", mutate: (r: ModificationRequest) => ({ ...r, riskFlags: ["touches-auth"] }) },
  ])("变更面 $name 改动 → hash 变", ({ mutate }) => {
    const req = baseRequest();
    const before = freezeSelfModification(req).hash;
    const after = freezeSelfModification(mutate(req)).hash;
    expect(after).not.toBe(before);
  });

  it.each([
    { name: "canary", mutate: (r: ModificationRequest) => ({ ...r, canary: { scope: "percent", size: 50 } }) },
    { name: "id", mutate: (r: ModificationRequest) => ({ ...r, id: "mod-999" }) },
    { name: "ownerName", mutate: (r: ModificationRequest) => ({ ...r, ownerName: "someone-else" }) },
    { name: "decision", mutate: (r: ModificationRequest) => ({ ...r, decision: { kind: "allow", at: 9 } }) },
    { name: "approver", mutate: (r: ModificationRequest) => ({ ...r, approver: { kind: "human", id: "h-1" } }) },
  ])("非冻结面 $name 改动 → hash 不变", ({ mutate }) => {
    const req = baseRequest();
    expect(freezeSelfModification(mutate(req)).hash).toBe(freezeSelfModification(req).hash);
  });

  it("frozenModificationValue 只收 FROZEN_FIELDS 且缺省字段不收", () => {
    const frozen = frozenModificationValue(baseRequest({ canary: undefined }));
    expect(Object.keys(frozen).sort()).toEqual([...FROZEN_FIELDS].filter((k) => k !== "canary").sort());
    expect(Object.keys(frozen).every((k) => (FROZEN_FIELDS as readonly string[]).includes(k))).toBe(true);
    expect("canary" in frozen).toBe(false);
    expect("id" in frozen).toBe(false);
    expect("ownerName" in frozen).toBe(false);
    expect("decision" in frozen).toBe(false);
  });

  it("canonicalModificationJson:键升序、undefined 丢弃、数组保序", () => {
    expect(canonicalModificationJson({ b: 1, a: undefined, c: [1, "x"] })).toBe('{"b":1,"c":[1,"x"]}');
    expect(canonicalModificationJson({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');
  });

  it("canonicalModificationJson:非有限数字降级为 null", () => {
    expect(canonicalModificationJson({ n: Number.NaN })).toBe('{"n":null}');
    expect(canonicalModificationJson([1, undefined])).toBe("[1,null]");
  });

  it("verifySelfModification:正确 hash → match:true", () => {
    const req = baseRequest();
    const { hash } = freezeSelfModification(req);
    const res = verifySelfModification(hash, req);
    expect(res.match).toBe(true);
    expect(res.hash).toBe(hash);
    expect(res.code).toBeUndefined();
  });

  it("verifySelfModification:错误 hash → match:false + MOD_HASH_MISMATCH", () => {
    const req = baseRequest();
    const res = verifySelfModification("f".repeat(64), req);
    expect(res.match).toBe(false);
    expect(res.code).toBe("MOD_HASH_MISMATCH");
  });

  it("verifySelfModification:空 hash / 空白 hash → match:false", () => {
    const req = baseRequest();
    for (const bad of ["", "   "]) {
      const res = verifySelfModification(bad, req);
      expect(res.match).toBe(false);
      expect(res.code).toBe("MOD_HASH_MISMATCH");
    }
  });

  it("verifySelfModification:冻结后改 summary → match:false", () => {
    const req = baseRequest();
    const { hash } = freezeSelfModification(req);
    expect(verifySelfModification(hash, { ...req, summary: "偷改" }).match).toBe(false);
  });
});

describe("applyPlan 六步顺序", () => {
  it("步骤严格为 freeze→dry-run→canary→apply→verify→rollback-ready", () => {
    const plan = applyPlan(baseRequest());
    expect(plan.map((step) => step.step)).toEqual(["freeze", "dry-run", "canary", "apply", "verify", "rollback-ready"]);
    expect(plan).toHaveLength(6);
  });

  it("irreversible=false → apply.reversible=true", () => {
    const apply = applyPlan(baseRequest({ irreversible: false })).find((step) => step.step === "apply");
    expect(apply?.reversible).toBe(true);
  });

  it("irreversible=true → apply.reversible=false", () => {
    const apply = applyPlan(baseRequest({ irreversible: true })).find((step) => step.step === "apply");
    expect(apply?.reversible).toBe(false);
  });

  it("每步都带 note,dry-run/canary/rollback-ready 反映请求内容", () => {
    const plan = applyPlan(baseRequest());
    expect(plan.every((step) => step.note.length > 0)).toBe(true);
    expect(plan[1].note).toContain("npx vitest run test/read-file.test.ts");
    expect(plan[2].note).toContain("session×1");
    expect(plan[5].note).toContain("flag:read_timeout");
  });
});

describe("compileRollback", () => {
  it("commit → action 含 `git revert` 且 ref 原样出现", () => {
    const action = compileRollback(baseRequest({ rollback: { kind: "commit", ref: "abc1234" } }));
    expect(action.action).toContain("git revert");
    expect(action.action).toContain("abc1234");
    expect(action.kind).toBe("commit");
    expect(action.ref).toBe("abc1234");
  });

  it.each([
    { kind: "flag", expect: "关闭开关 flag:x" },
    { kind: "config", expect: "恢复配置快照 cfg-1" },
    { kind: "snapshot", expect: "恢复快照 snap-1" },
  ])("kind=$kind → 对应描述文本", ({ kind, expect: text }) => {
    const ref = kind === "config" ? "cfg-1" : kind === "snapshot" ? "snap-1" : "flag:x";
    const action = compileRollback(baseRequest({ rollback: { kind, ref } }));
    expect(action.action).toBe(text);
    expect(action.ref).toBe(ref);
  });

  it("reversible 跟随 irreversible:不可逆 → false", () => {
    expect(compileRollback(baseRequest({ irreversible: false })).reversible).toBe(true);
    expect(compileRollback(baseRequest({ irreversible: true })).reversible).toBe(false);
  });

  it("rollback 缺失时降级为 flag 且 ref 为空串(不抛)", () => {
    const action = compileRollback(baseRequest({ rollback: undefined }));
    expect(action.kind).toBe("flag");
    expect(action.ref).toBe("");
  });
});

describe("码表与常量快照", () => {
  it("SELF_MOD_CODES 长度 18 且逐字等于清单", () => {
    expect(SELF_MOD_CODES).toHaveLength(18);
    expect([...SELF_MOD_CODES]).toEqual([
      "MOD_SURFACE_INVALID",
      "MOD_TARGET_MISSING",
      "MOD_SUMMARY_MISSING",
      "MOD_AUTHOR_MISSING",
      "MOD_OWNER_MISSING",
      "MOD_EVIDENCE_MISSING",
      "MOD_IMPACT_MISSING",
      "MOD_DRYRUN_MISSING",
      "MOD_DRYRUN_FAILED",
      "MOD_CANARY_MISSING",
      "MOD_ROLLBACK_MISSING",
      "MOD_SELF_APPROVAL",
      "MOD_RSI_NEEDS_HUMAN",
      "MOD_AGENT_APPROVAL_FORBIDDEN",
      "MOD_IRREVERSIBLE_NEEDS_HUMAN",
      "MOD_RISK_UNREVIEWED",
      "MOD_HASH_MISMATCH",
      "MOD_DECISION_FINAL",
    ]);
  });

  it("SELF_MOD_SCHEMA_VERSION === 1", () => {
    expect(SELF_MOD_SCHEMA_VERSION).toBe(1);
  });

  it("MODIFICATION_SURFACES 恰为六项且顺序固定", () => {
    expect([...MODIFICATION_SURFACES]).toEqual(["tool", "tip", "prompt", "skill", "code", "config"]);
    expect([...MODIFICATION_SURFACES]).toHaveLength(6);
  });

  it("所有返回码都来自 SELF_MOD_CODES(无越界码)", () => {
    const ev = evalu({ surface: "code", evidence: {}, impact: {}, dryRun: undefined, canary: undefined, rollback: undefined, author: { kind: "rsi", id: "" } });
    for (const code of ev.codes) expect(SELF_MOD_CODES).toContain(code);
  });
});

describe("纯逻辑零 IO 纪律", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/agent/self-modification.ts", import.meta.url)), "utf8");

  it("只 import node:crypto(唯一 import)", () => {
    const modules = [...source.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    expect(modules).toEqual(["node:crypto"]);
  });

  it("不含 node:fs / node:path / agent-loop 依赖,也不直接调用读写 API", () => {
    expect(source).not.toMatch(/from\s+"node:(fs|path|os)"/);
    expect(source).not.toMatch(/agent-loop/);
    expect(source).not.toMatch(/\b(readFileSync|writeFileSync|createReadStream|createWriteStream)\b/);
  });
});
