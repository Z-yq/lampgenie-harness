/**
 * 负面知识库(死路账本):稳定 id → 记账/去重 → 可解释检索 → 规划注入 → 翻案/过期 →
 * 与正面经验合并 → 放弃会话候选 → 图谱投影。
 * 全部纯数据 + 固定时间戳常量,不碰文件与真实时钟。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_RETRIEVE_LIMIT,
  NEGKB_ALREADY_REVIVED,
  NEGKB_CODES,
  NEGKB_DUPLICATE,
  NEGKB_INVALID,
  NEGKB_MATCH,
  NEGKB_NO_MATCH,
  NEGKB_RECORDED,
  NEGKB_REVIVED,
  NEGATIVE_KB_VERSION,
  deadEndIdOf,
  expireDeadEnds,
  formatDeadEndBlock,
  injectAtPlanning,
  mergeWithPositive,
  normalizePlan,
  recordDeadEnd,
  retrieveDeadEnds,
  reviveDeadEnd,
  suggestFromAbandons,
  toGraphNode,
  tokenize,
} from "../src/agent/negative-knowledge.ts";
import type { AbandonSession, DeadEndHit, DeadEndRecord, FailureEvidence } from "../src/agent/negative-knowledge.ts";

const T0 = 1_700_000_000_000;
const HEX16 = /^[0-9a-f]{16}$/;

function ev(detail = "token store rejected", at = T0): FailureEvidence {
  return { kind: "error", detail, at };
}

function rec(over: Partial<DeadEndRecord> = {}): DeadEndRecord {
  return {
    id: "r-1",
    plan: "migrate auth to session tokens",
    context: {},
    failureEvidence: [ev()],
    scope: { keywords: [] },
    confidence: 0.8,
    evidenceRefs: [],
    status: "active",
    corrections: [],
    createdAt: T0,
    ...over,
  };
}

function hit(record: DeadEndRecord, score = 3, reasons: string[] = ["keyword:auth"]): DeadEndHit {
  return { record, score, reasons };
}

function session(over: Partial<AbandonSession> = {}): AbandonSession {
  return { planText: "fix login", abandoned: true, at: T0, ...over };
}

describe("常量与口径", () => {
  it("schema 版本为 1", () => {
    expect(NEGATIVE_KB_VERSION).toBe(1);
  });

  it("稳定码数组固定顺序且与常量字面量一致", () => {
    expect(NEGKB_CODES).toEqual([
      "NEGKB_INVALID",
      "NEGKB_RECORDED",
      "NEGKB_DUPLICATE",
      "NEGKB_MATCH",
      "NEGKB_NO_MATCH",
      "NEGKB_EXPIRED",
      "NEGKB_REVIVED",
      "NEGKB_ALREADY_REVIVED",
      "NEGKB_LOW_CONFIDENCE",
    ]);
    expect([NEGKB_INVALID, NEGKB_RECORDED, NEGKB_DUPLICATE, NEGKB_MATCH, NEGKB_NO_MATCH]).toEqual([
      "NEGKB_INVALID",
      "NEGKB_RECORDED",
      "NEGKB_DUPLICATE",
      "NEGKB_MATCH",
      "NEGKB_NO_MATCH",
    ]);
    expect(NEGKB_REVIVED).toBe("NEGKB_REVIVED");
    expect(NEGKB_ALREADY_REVIVED).toBe("NEGKB_ALREADY_REVIVED");
  });

  it("缺省门槛与上限为公开常量", () => {
    expect(DEFAULT_MIN_CONFIDENCE).toBe(0.5);
    expect(DEFAULT_RETRIEVE_LIMIT).toBe(5);
  });

  it("normalizePlan 做 trim + 空白折叠 + 小写", () => {
    expect(normalizePlan("  Fix \n\t Auth   Bug ")).toBe("fix auth bug");
    expect(normalizePlan("")).toBe("");
    expect(normalizePlan("   ")).toBe("");
  });

  it("tokenize 切 ASCII 词并取 CJK 二元组", () => {
    expect(tokenize("Migrate Auth-2 token")).toEqual(["migrate", "auth", "2", "token"]);
    expect(tokenize("认证模块")).toEqual(["认证", "证模", "模块"]);
    expect(tokenize("单")).toEqual(["单"]);
    expect(tokenize("")).toEqual([]);
  });
});

describe("deadEndIdOf 稳定幂等", () => {
  it("两次调用相等且为 16 位 hex", () => {
    const a = deadEndIdOf({ plan: "Fix Auth", scope: { keywords: ["auth"] } });
    const b = deadEndIdOf({ plan: "Fix Auth", scope: { keywords: ["auth"] } });
    expect(a).toBe(b);
    expect(a).toMatch(HEX16);
  });

  it("scope 字段/keywords 顺序无关", () => {
    const a = deadEndIdOf({
      plan: "fix auth",
      scope: { taskClass: "bugfix", module: "gateway", keywords: ["auth", "token"] },
    });
    const b = deadEndIdOf({
      plan: "fix auth",
      scope: { keywords: ["token", "auth"], module: "gateway", taskClass: "bugfix" },
    });
    expect(a).toBe(b);
  });

  it("scope 缺失等价于空 scope", () => {
    expect(deadEndIdOf({ plan: "fix auth" })).toBe(deadEndIdOf({ plan: "fix auth", scope: {} }));
    expect(deadEndIdOf({ plan: "fix auth", scope: { keywords: [] } })).toBe(deadEndIdOf({ plan: "fix auth" }));
  });

  it("plan 大小写与空白不影响 id", () => {
    expect(deadEndIdOf({ plan: "  FIX   Auth " })).toBe(deadEndIdOf({ plan: "fix auth" }));
  });

  it("不同 plan / 不同 scope 得到不同 id", () => {
    expect(deadEndIdOf({ plan: "fix auth" })).not.toBe(deadEndIdOf({ plan: "fix login" }));
    expect(deadEndIdOf({ plan: "fix auth", scope: { module: "a" } })).not.toBe(
      deadEndIdOf({ plan: "fix auth", scope: { module: "b" } }),
    );
  });
});

describe("recordDeadEnd 记账", () => {
  it("plan 为空 → INVALID,无 record", () => {
    const r = recordDeadEnd({ plan: "", failureEvidence: [ev()] });
    expect(r.ok).toBe(false);
    expect(r.codes).toEqual([NEGKB_INVALID]);
    expect(r.record).toBeUndefined();
  });

  it("plan 仅空白 / 非字符串 → INVALID", () => {
    expect(recordDeadEnd({ plan: "   ", failureEvidence: [ev()] }).codes).toEqual([NEGKB_INVALID]);
    const bad = recordDeadEnd({ plan: 42 as unknown as string, failureEvidence: [ev()] });
    expect(bad.ok).toBe(false);
    expect(bad.codes).toEqual([NEGKB_INVALID]);
  });

  it("没有失败证据(缺省或空数组或全是坏证据)→ INVALID", () => {
    expect(recordDeadEnd({ plan: "fix auth" }).codes).toEqual([NEGKB_INVALID]);
    expect(recordDeadEnd({ plan: "fix auth", failureEvidence: [] }).codes).toEqual([NEGKB_INVALID]);
    const junk = recordDeadEnd({
      plan: "fix auth",
      failureEvidence: [{ kind: "nope", detail: "x", at: T0 } as unknown as FailureEvidence],
    });
    expect(junk.codes).toEqual([NEGKB_INVALID]);
  });

  it("正常记账字段齐全且 plan 规范化", () => {
    const r = recordDeadEnd(
      { plan: "  Fix   Auth Bug ", failureEvidence: [ev("k8s 拒绝")], scope: { keywords: ["Auth"] }, evidenceRefs: ["trace:1"] },
      { now: T0 },
    );
    expect(r.ok).toBe(true);
    expect(r.codes).toEqual([NEGKB_RECORDED]);
    const record = r.record as DeadEndRecord;
    expect(record.plan).toBe("Fix Auth Bug");
    expect(record.id).toBe(deadEndIdOf({ plan: "Fix Auth Bug", scope: { keywords: ["auth"] } }));
    expect(record.id).toMatch(HEX16);
    expect(record.status).toBe("active");
    expect(record.corrections).toEqual([]);
    expect(record.scope.keywords).toEqual(["auth"]);
    expect(record.evidenceRefs).toEqual(["trace:1"]);
    expect(record.failureEvidence[0]?.detail).toBe("k8s 拒绝");
    expect(record.createdAt).toBe(T0);
  });

  it("confidence 缺省 0.6,越界钳到 0..1", () => {
    const base = { plan: "fix auth", failureEvidence: [ev()] };
    expect(recordDeadEnd(base, { now: T0 }).record?.confidence).toBe(0.6);
    expect(recordDeadEnd({ ...base, confidence: 1.5 }, { now: T0 }).record?.confidence).toBe(1);
    expect(recordDeadEnd({ ...base, confidence: -3 }, { now: T0 }).record?.confidence).toBe(0);
  });

  it("createdAt 显式值优先于 opts.now", () => {
    const r = recordDeadEnd({ plan: "fix auth", failureEvidence: [ev()], createdAt: T0 - 5000 }, { now: T0 });
    expect(r.record?.createdAt).toBe(T0 - 5000);
  });

  it("invalidWhen / alternative / expiresAt 仅在有值时落字段", () => {
    const plain = recordDeadEnd({ plan: "fix auth", failureEvidence: [ev()] }, { now: T0 }).record as DeadEndRecord;
    expect(plain.invalidWhen).toBeUndefined();
    expect(plain.alternative).toBeUndefined();
    expect(plain.expiresAt).toBeUndefined();

    const rich = recordDeadEnd(
      {
        plan: "fix auth",
        failureEvidence: [ev()],
        invalidWhen: ["认证服务迁到 v2"],
        alternative: "改用 https",
        expiresAt: T0 + 1000,
      },
      { now: T0 },
    ).record as DeadEndRecord;
    expect(rich.invalidWhen).toEqual(["认证服务迁到 v2"]);
    expect(rich.alternative).toBe("改用 https");
    expect(rich.expiresAt).toBe(T0 + 1000);
  });

  it("同 id 已存在 → DUPLICATE 并回既有记录", () => {
    const first = recordDeadEnd({ plan: "fix auth", failureEvidence: [ev()], scope: { keywords: ["auth"] } }, { now: T0 });
    const second = recordDeadEnd(
      { plan: "FIX  AUTH", failureEvidence: [ev("另一次失败")], scope: { keywords: ["auth"] } },
      { now: T0 + 10, existing: [first.record as DeadEndRecord] },
    );
    expect(second.ok).toBe(false);
    expect(second.codes).toEqual([NEGKB_DUPLICATE]);
    expect(second.record?.id).toBe(first.record?.id);
    expect(second.record?.failureEvidence[0]?.detail).toBe("token store rejected");
  });

  it("既有记录已 expired 时仍返回 DUPLICATE(幂等不复活)", () => {
    const first = recordDeadEnd({ plan: "fix auth", failureEvidence: [ev()] }, { now: T0 }).record as DeadEndRecord;
    const dup = recordDeadEnd(
      { plan: "fix auth", failureEvidence: [ev()] },
      { now: T0 + 10, existing: [{ ...first, status: "expired" }] },
    );
    expect(dup.codes).toEqual([NEGKB_DUPLICATE]);
    expect(dup.record?.status).toBe("expired");
  });
});

describe("retrieveDeadEnds 检索与评分", () => {
  it("关键词交集每个 +2,reasons 带 keyword", () => {
    const r = retrieveDeadEnds([rec({ id: "kw", scope: { keywords: ["auth", "token"] } })], {
      keywords: ["auth", "nope"],
    });
    expect(r.codes).toEqual([NEGKB_MATCH]);
    expect(r.hits.map((h) => h.score)).toEqual([2]);
    expect(r.hits[0]?.reasons).toEqual(["keyword:auth"]);
  });

  it("module 精确匹配 +3(记录侧大小写/空白归一)", () => {
    const r = retrieveDeadEnds([rec({ id: "mod", scope: { keywords: [], module: " Gateway " } })], { module: "gateway" });
    expect(r.hits.map((h) => h.score)).toEqual([3]);
    expect(r.hits[0]?.reasons).toEqual(["module:gateway"]);
  });

  it("记录 context.module 也参与 module 匹配", () => {
    const r = retrieveDeadEnds([rec({ id: "ctx-mod", context: { module: "gateway" } })], { module: "gateway" });
    expect(r.hits.map((h) => h.score)).toEqual([3]);
  });

  it("taskClass 精确匹配 +3", () => {
    const r = retrieveDeadEnds([rec({ id: "tc", scope: { keywords: [], taskClass: "bugfix" } })], { taskClass: "BugFix" });
    expect(r.hits.map((h) => h.score)).toEqual([3]);
    expect(r.hits[0]?.reasons).toEqual(["taskClass:bugfix"]);
  });

  it("plan 文本 token 重叠每个 +1(区分于关键词)", () => {
    const r = retrieveDeadEnds([rec({ id: "po" })], { planText: "session migration auth" });
    expect(r.hits.map((h) => h.score)).toEqual([2]);
    expect(r.hits[0]?.reasons).toEqual(["plan-overlap:2"]);
  });

  it("CJK plan 走二元组重叠", () => {
    const r = retrieveDeadEnds([rec({ id: "cjk", plan: "重构 认证 模块" })], { planText: "认证模块" });
    expect(r.hits.map((h) => h.score)).toEqual([2]);
    expect(r.hits[0]?.reasons).toEqual(["plan-overlap:2"]);
  });

  it("四类命中叠加:关键词 2 + module 3 + taskClass 3 = 8", () => {
    const r = retrieveDeadEnds(
      [rec({ id: "all", scope: { keywords: ["auth"], module: "gateway", taskClass: "bugfix" } })],
      { keywords: ["auth"], module: "gateway", taskClass: "bugfix" },
    );
    expect(r.hits[0]?.score).toBe(8);
    expect(r.hits[0]?.reasons).toEqual(["keyword:auth", "module:gateway", "taskClass:bugfix"]);
  });

  it("置信度门:缺省 0.5 过滤 0.4,自定义门槛放行", () => {
    const records = [
      rec({ id: "low", scope: { keywords: ["auth"] }, confidence: 0.4 }),
      rec({ id: "high", scope: { keywords: ["auth"] }, confidence: 0.8 }),
    ];
    expect(retrieveDeadEnds(records, { keywords: ["auth"] }).hits.map((h) => h.record.id)).toEqual(["high"]);
    expect(retrieveDeadEnds(records, { keywords: ["auth"] }, { minConfidence: 0.2 }).hits.map((h) => h.record.id)).toEqual([
      "high",
      "low",
    ]);
  });

  it("过期过滤:expiresAt <= now 不返回,> now 返回", () => {
    const records = [rec({ id: "exp", scope: { keywords: ["auth"] }, expiresAt: T0 + 100 })];
    expect(retrieveDeadEnds(records, { keywords: ["auth"] }, { now: T0 + 200 }).codes).toEqual([NEGKB_NO_MATCH]);
    expect(retrieveDeadEnds(records, { keywords: ["auth"] }, { now: T0 + 100 }).codes).toEqual([NEGKB_NO_MATCH]);
    expect(retrieveDeadEnds(records, { keywords: ["auth"] }, { now: T0 + 50 }).hits.length).toBe(1);
  });

  it("状态过滤:expired 不召回,revived 召回", () => {
    const records = [
      rec({ id: "gone", scope: { keywords: ["auth"] }, status: "expired" }),
      rec({ id: "back", scope: { keywords: ["auth"] }, status: "revived" }),
    ];
    expect(retrieveDeadEnds(records, { keywords: ["auth"] }).hits.map((h) => h.record.id)).toEqual(["back"]);
  });

  it("limit 缺省 5,显式 limit 生效", () => {
    const records = Array.from({ length: 7 }, (_, i) => rec({ id: `r-${i}`, scope: { keywords: ["auth"] } }));
    expect(retrieveDeadEnds(records, { keywords: ["auth"] }).hits.length).toBe(5);
    expect(retrieveDeadEnds(records, { keywords: ["auth"] }, { limit: 2 }).hits.length).toBe(2);
  });

  it("排序:score 降序、同分 id 升序", () => {
    const records = [
      rec({ id: "b", scope: { keywords: ["auth"] } }),
      rec({ id: "c", scope: { keywords: ["auth", "token"] } }),
      rec({ id: "a", scope: { keywords: ["auth"] } }),
    ];
    const hits = retrieveDeadEnds(records, { keywords: ["auth", "token"] }).hits;
    expect(hits.map((h) => h.record.id)).toEqual(["c", "a", "b"]);
    expect(hits.map((h) => h.score)).toEqual([4, 2, 2]);
  });

  it("零分不召回 → NO_MATCH + 空 hits", () => {
    const r = retrieveDeadEnds([rec({ id: "x" })], { keywords: ["zzz"] });
    expect(r.hits).toEqual([]);
    expect(r.codes).toEqual([NEGKB_NO_MATCH]);
  });

  it("空 records / 空 query 都安全", () => {
    expect(retrieveDeadEnds([], { keywords: ["auth"] }).codes).toEqual([NEGKB_NO_MATCH]);
    expect(retrieveDeadEnds([rec({ id: "x" })], {}).codes).toEqual([NEGKB_NO_MATCH]);
    expect(retrieveDeadEnds(null as unknown as DeadEndRecord[], { keywords: ["a"] }).hits).toEqual([]);
  });

  it("非法记录(非对象/缺 id/缺 plan)被跳过", () => {
    const records = [
      null,
      undefined,
      42,
      "nope",
      {},
      { id: "", plan: "fix auth" },
      { id: "no-plan", plan: "" },
      rec({ id: "ok", scope: { keywords: ["auth"] } }),
    ] as unknown as DeadEndRecord[];
    const r = retrieveDeadEnds(records, { keywords: ["auth"] });
    expect(r.hits.map((h) => h.record.id)).toEqual(["ok"]);
    expect(r.codes).toEqual([NEGKB_MATCH]);
  });

  it("命中项携带 alternative(无替代则不落字段)", () => {
    const withAlt = retrieveDeadEnds(
      [rec({ id: "alt", scope: { keywords: ["auth"] }, alternative: "改用 https" })],
      { keywords: ["auth"] },
    );
    expect(withAlt.hits[0]?.alternative).toBe("改用 https");
    const withoutAlt = retrieveDeadEnds([rec({ id: "plain", scope: { keywords: ["auth"] } })], {
      keywords: ["auth"],
    });
    expect(withoutAlt.hits[0]?.alternative).toBeUndefined();
    expect("alternative" in (withoutAlt.hits[0] as DeadEndHit)).toBe(false);
  });
});

describe("injectAtPlanning 规划期注入", () => {
  const deadEnd = rec({
    id: "inj",
    plan: "deploy via ssh",
    failureEvidence: [ev("ssh key rejected")],
    scope: { keywords: ["deploy"] },
  });

  it("格式:此路不通 / 原因 / 替代(无替代写 暂无)", () => {
    expect(formatDeadEndBlock(deadEnd)).toBe("此路不通:deploy via ssh|原因:ssh key rejected|替代:暂无");
    const { blocks } = injectAtPlanning([deadEnd], { keywords: ["deploy"] });
    expect(blocks).toEqual(["此路不通:deploy via ssh|原因:ssh key rejected|替代:暂无"]);
  });

  it("有替代时写入替代文本", () => {
    const withAlt = { ...deadEnd, alternative: "改用 https" };
    expect(formatDeadEndBlock(withAlt)).toBe("此路不通:deploy via ssh|原因:ssh key rejected|替代:改用 https");
  });

  it("摘要超长按 60 字截断", () => {
    const long = rec({
      id: "long",
      plan: "a".repeat(100),
      failureEvidence: [ev("b".repeat(100))],
      scope: { keywords: ["x"] },
    });
    expect(formatDeadEndBlock(long)).toBe(`此路不通:${"a".repeat(60)}|原因:${"b".repeat(60)}|替代:暂无`);
  });

  it("无命中 → blocks 空数组", () => {
    const r = injectAtPlanning([deadEnd], { keywords: ["zzz"] });
    expect(r.blocks).toEqual([]);
    expect(r.hits).toEqual([]);
  });

  it("maxChars 只整条加入,超预算即停(不截断单条)", () => {
    const a = rec({ id: "r-a", plan: "alpha", failureEvidence: [ev("fail a")], scope: { keywords: ["shared"] } });
    const b = rec({ id: "r-b", plan: "beta", failureEvidence: [ev("fail b")], scope: { keywords: ["shared"] } });
    const blockA = "此路不通:alpha|原因:fail a|替代:暂无";
    const blockB = "此路不通:beta|原因:fail b|替代:暂无";
    const both = injectAtPlanning([a, b], { keywords: ["shared"] }, { maxChars: 10_000 });
    expect(both.blocks).toEqual([blockA, blockB]);

    const onlyFirst = injectAtPlanning([a, b], { keywords: ["shared"] }, { maxChars: blockA.length + blockB.length - 1 });
    expect(onlyFirst.blocks).toEqual([blockA]);
  });

  it("预算少于首条时仍保留首条(保证有输出)", () => {
    const r = injectAtPlanning([deadEnd], { keywords: ["deploy"] }, { maxChars: 1 });
    expect(r.blocks.length).toBe(1);
    expect(r.blocks[0]).toBe("此路不通:deploy via ssh|原因:ssh key rejected|替代:暂无");
  });

  it("minConfidence 影响注入内容", () => {
    const low = { ...deadEnd, confidence: 0.3 };
    expect(injectAtPlanning([low], { keywords: ["deploy"] }).blocks).toEqual([]);
    expect(injectAtPlanning([low], { keywords: ["deploy"] }, { minConfidence: 0.1 }).blocks.length).toBe(1);
  });
});

describe("reviveDeadEnd 翻案", () => {
  it("expired → revived,追加纠正,清 expiresAt", () => {
    const input = rec({ status: "expired", expiresAt: T0 + 10 });
    const r = reviveDeadEnd(input, { by: "human", reason: "凭证已就位", newEvidence: "trace:9", at: T0 + 20 });
    expect(r.codes).toEqual([NEGKB_REVIVED]);
    expect(r.record.status).toBe("revived");
    expect(r.record.expiresAt).toBeUndefined();
    expect(r.record.corrections).toEqual([{ at: T0 + 20, by: "human", reason: "凭证已就位", newEvidence: "trace:9" }]);
  });

  it("active → revived", () => {
    const r = reviveDeadEnd(rec({ status: "active" }), { by: "ops", reason: "依赖升级", at: T0 });
    expect(r.codes).toEqual([NEGKB_REVIVED]);
    expect(r.record.status).toBe("revived");
    expect(r.record.corrections.length).toBe(1);
    expect(r.record.corrections[0]?.newEvidence).toBeUndefined();
  });

  it("已 revived → 原样返回 + ALREADY_REVIVED", () => {
    const input = rec({ status: "revived", corrections: [{ at: T0, by: "a", reason: "b" }] });
    const r = reviveDeadEnd(input, { by: "c", reason: "d", at: T0 + 1 });
    expect(r.codes).toEqual([NEGKB_ALREADY_REVIVED]);
    expect(r.record).toBe(input);
    expect(r.record.corrections.length).toBe(1);
  });

  it("不改入参(返回新对象)", () => {
    const input = rec({ status: "expired", expiresAt: T0 });
    const r = reviveDeadEnd(input, { by: "human", reason: "失效", at: T0 + 5 });
    expect(input.status).toBe("expired");
    expect(input.expiresAt).toBe(T0);
    expect(input.corrections).toEqual([]);
    expect(r.record).not.toBe(input);
    expect(r.record.failureEvidence).toBe(input.failureEvidence);
  });

  it("非法 record → INVALID 且不抛", () => {
    const r = reviveDeadEnd(null as unknown as DeadEndRecord, { by: "a", reason: "b" });
    expect(r.codes).toEqual([NEGKB_INVALID]);
  });
});

describe("expireDeadEnds 过期扫描", () => {
  it("只把未过期且到期的置 expired,已 expired 不重复列", () => {
    const records = [
      rec({ id: "due", expiresAt: T0 }),
      rec({ id: "already", expiresAt: T0 - 10, status: "expired" }),
      rec({ id: "later", expiresAt: T0 + 1000 }),
      rec({ id: "forever" }),
    ];
    const r = expireDeadEnds(records, T0);
    expect(r.expired).toEqual(["due"]);
    expect(r.records.map((x) => x.status)).toEqual(["expired", "expired", "active", "active"]);
    expect(r.records.map((x) => x.id)).toEqual(["due", "already", "later", "forever"]);
  });

  it("返回新数组且不改入参", () => {
    const input = [rec({ id: "due", expiresAt: T0 })];
    const r = expireDeadEnds(input, T0);
    expect(input[0]?.status).toBe("active");
    expect(r.records).not.toBe(input);
  });

  it("无到期记录时 expired 为空且原样返回项", () => {
    const input = [rec({ id: "forever" })];
    const r = expireDeadEnds(input, T0 + 10_000);
    expect(r.expired).toEqual([]);
    expect(r.records[0]).toBe(input[0]);
  });

  it("非数组输入安全", () => {
    const r = expireDeadEnds(undefined as unknown as DeadEndRecord[], T0);
    expect(r).toEqual({ expired: [], records: [] });
  });
});

describe("mergeWithPositive 与正面经验合并", () => {
  const deadHit = hit(rec({ id: "d1", scope: { keywords: ["auth"] } }), 3);

  it("死路在前、正面在后", () => {
    const r = mergeWithPositive(
      { hits: [deadHit] },
      [
        { name: "p1", keywords: ["auth"] },
        { name: "p2", keywords: ["other"] },
      ],
    );
    expect(r.ordered.length).toBe(3);
    expect(r.ordered[0]?.source).toBe("dead-end");
    expect((r.ordered[0] as { record: DeadEndRecord }).record.id).toBe("d1");
    expect(r.ordered[1]?.source).toBe("positive");
    expect(r.ordered[2]?.source).toBe("positive");
  });

  it("正面项与死路关键词有交集 → 追加 note", () => {
    const r = mergeWithPositive({ hits: [deadHit] }, [{ name: "p1", keywords: ["auth", "jwt"] }]);
    expect(r.notes).toEqual(["有正面经验可用,先看死路原因:d1"]);
  });

  it("plan 文本交集也算(不只 keywords)", () => {
    const r = mergeWithPositive({ hits: [deadHit] }, [{ plan: "Auth migration done" }]);
    expect(r.notes.length).toBe(1);
  });

  it("无交集 → notes 为空", () => {
    const r = mergeWithPositive({ hits: [deadHit] }, [{ name: "p2", keywords: ["unrelated"] }]);
    expect(r.notes).toEqual([]);
  });

  it("空输入安全", () => {
    const r = mergeWithPositive({ hits: [] }, []);
    expect(r.ordered).toEqual([]);
    expect(r.notes).toEqual([]);
  });
});

describe("suggestFromAbandons 放弃候选", () => {
  it("同 plan 放弃达到 minSessions 默认 2 → 生成候选", () => {
    const { candidates } = suggestFromAbandons({
      sessions: [
        session({ at: T0 }),
        session({ at: T0 + 10, reason: "依赖缺失" }),
        session({ planText: "other plan", at: T0 + 20, abandoned: false }),
      ],
    });
    expect(candidates.length).toBe(1);
    const c = candidates[0] as DeadEndRecord;
    expect(c.status).toBe("active");
    expect(c.confidence).toBe(0.7);
    expect(c.failureEvidence.length).toBe(2);
    expect(c.failureEvidence[0]).toEqual({ kind: "abandon", detail: "session 放弃", at: T0 });
    expect(c.failureEvidence[1]?.detail).toBe("依赖缺失");
    expect(c.evidenceRefs).toEqual([]);
    expect(c.corrections).toEqual([]);
    expect(c.scope.keywords).toEqual(["fix", "login"]);
    expect(c.id).toBe(deadEndIdOf({ plan: "fix login", scope: c.scope }));
  });

  it("不足 minSessions 不生成", () => {
    const one = suggestFromAbandons({ sessions: [session()] });
    expect(one.candidates).toEqual([]);
    const strict = suggestFromAbandons({ sessions: [session(), session({ at: T0 + 1 })] }, { minSessions: 3 });
    expect(strict.candidates).toEqual([]);
  });

  it("非 abandoned 会话不计入", () => {
    const r = suggestFromAbandons({
      sessions: [session({ abandoned: false }), session({ at: T0 + 1, abandoned: false })],
    });
    expect(r.candidates).toEqual([]);
  });

  it("n 次放弃置信度按 0.5+0.1n 且封顶 0.8", () => {
    const three = suggestFromAbandons({
      sessions: [session(), session({ at: T0 + 1 }), session({ at: T0 + 2 })],
    });
    expect(three.candidates[0]?.confidence).toBe(0.8);
    const many = suggestFromAbandons({
      sessions: Array.from({ length: 6 }, (_, i) => session({ at: T0 + i })),
    });
    expect(many.candidates[0]?.confidence).toBe(0.8);
  });

  it("按规范化 planText 分组(大小写/空白等价)", () => {
    const r = suggestFromAbandons({ sessions: [session({ planText: "Fix Login" }), session({ planText: "  fix   login " })] });
    expect(r.candidates.length).toBe(1);
    expect(r.candidates[0]?.failureEvidence.length).toBe(2);
  });

  it("keywords 取 plan token 前 5 个", () => {
    const r = suggestFromAbandons({
      sessions: [session({ planText: "a b c d e f g" }), session({ planText: "a b c d e f g", at: T0 + 1 })],
    });
    expect(r.candidates[0]?.scope.keywords).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("空/非法输入安全", () => {
    expect(suggestFromAbandons({ sessions: [] }).candidates).toEqual([]);
    expect(suggestFromAbandons({ sessions: [null, 1, "x"] as unknown as AbandonSession[] }).candidates).toEqual([]);
    expect(suggestFromAbandons(undefined as unknown as { sessions: AbandonSession[] }).candidates).toEqual([]);
  });
});

describe("toGraphNode 图谱投影", () => {
  it("结构稳定:id 前缀 + anti-pattern + label/summary/weight/refs", () => {
    const node = toGraphNode(
      rec({
        id: "abc123",
        plan: "deploy via ssh",
        failureEvidence: [ev("ssh key rejected")],
        alternative: "改用 https",
        confidence: 0.7,
        evidenceRefs: ["trace:1", "trace:2"],
      }),
    );
    expect(node).toEqual({
      id: "negkb:abc123",
      kind: "anti-pattern",
      label: "deploy via ssh",
      summary: "原因:ssh key rejected;替代:改用 https",
      weight: 0.7,
      refs: ["trace:1", "trace:2"],
    });
  });

  it("label 取 plan 前 60 字,无替代写 暂无", () => {
    const node = toGraphNode(rec({ id: "x", plan: "y".repeat(100) }));
    expect(node.label).toBe("y".repeat(60));
    expect(node.summary).toBe("原因:token store rejected;替代:暂无");
  });

  it("非法 record 不抛", () => {
    const node = toGraphNode(undefined as unknown as DeadEndRecord);
    expect(node.id).toBe("negkb:");
    expect(node.kind).toBe("anti-pattern");
    expect(node.weight).toBe(0);
    expect(node.refs).toEqual([]);
  });
});
