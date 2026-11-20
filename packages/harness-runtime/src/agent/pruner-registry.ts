/**
 * ContextPruner 声明层(缺口#31, 审计「独立杂项」件3)。
 * 这是一层**纯声明的注册表**:把 context-economy 里所有会裁/会压上下文的机制收进一个
 * 统一接口,元数据(区/作用段/是否改已发出字节/持久化/幂等)按 04-mechanisms.md §4.1.8.1
 * 契约总表填写。**绑实现是后续迁移**——现在 PRUNER_REGISTRY 里的 plan/apply 是桩,
 * 返回空计划,不动任何真实消息。
 * 为什么先做声明层:审计发现八个裁剪器散在六个文件里,「哪个工具会改已发出字节」
 * 「哪个幂等」这类问题只能翻文档对表格,没有机器可读的一处真相。声明层先把契约
 * 固化为可断言的数据(见 test/pruner-registry.test.ts 的「热区件 mutatesEmittedBytes
 * 全 false」等结构性断言),后续迁移实现时接口不许再漂。
 * 禁 enum:全部用字符串字面量联合(与仓内风格一致,--experimental-strip-types 直跑)。
 */

/** 裁剪器作用的上下文区:热(写入前)/温(冻结区后)/冷(全区兜底)。 */
export type PrunerZone = "hot" | "warm" | "cold";

/** 作用段(04-mechanisms.md §4.1.8.1「作用段」列的归一化取值)。 */
export type PrunerSegment =
  | "increment" /** 增量:结果进历史之前 */
  | "tail" /** 已发出·尾部 */
  | "middle" /** 温区/中段(冻结区之后) */
  | "frozen" /** 冻结区边界 */
  | "all-head"; /** head 全区兜底 */

/** 结果持久化方式:none=不落盘(ephemeral);artifact=全文落盘;journal=事件留痕。 */
export type PrunerPersistence = "none" | "artifact" | "journal";

/**
 * 统一裁剪器接口(声明层):plan 只算不动手,apply 才动手且必须带 audit。
 * input/plan 故意是 unknown——各机制的输入形状差异大(消息数组/单条 content/配置),
 * 声明层不强行归一,由迁移后的实现各自 narrow 并校验。
 */
export interface ContextPruner {
  id: string;
  zone: PrunerZone;
  segment: PrunerSegment;
 /** 是否改「已经发给过 provider 的字节」。false=可常态化跑;true=必须过经济门/保命动作。 */
  mutatesEmittedBytes: boolean;
  persists: PrunerPersistence;
 /** 幂等:同样输入必然同样输出(append-only 成立的形态)。 */
  idempotent: boolean;
  plan(input: unknown): { targets: string[]; savedTokens: number; breakCostTokens: number; skipped?: string };
  apply(plan: unknown): { messages: unknown[]; audit: Record<string, unknown> };
}

/** 桩实现:声明层不绑实现,plan/apply 返回零效果并显式说明 skipped(不装成真裁了)。 */
function stubPlan(skipped: string): ContextPruner["plan"] {
  return () => ({ targets: [], savedTokens: 0, breakCostTokens: 0, skipped });
}

function stubApply(): ContextPruner["apply"] {
  return () => ({ messages: [], audit: { stub: true } });
}

/**
 * 八件元数据(顺序 = 契约总表行序;每行依据附后):
 * - big-intake:热·增量·未发出 → 首次定形不算改已发出字节;全文落 .genie/tool-dumps;
 * 同输入同输出(切块/评分确定性)→ idempotent。
 * - spill:热·增量·未发出;全文落 .genie/spill;同 content 同定形 → idempotent。
 * - head-tail-refine(H3 尾区幂等精炼):热·已发出尾部单条;**逐字节幂等**;不落盘。
 * - microcompact(W1 组清理):温·中段;仅 reset/growth-spurt 时动已发出字节 → true;
 * journal 留 context.prune;非重放安全(依赖 policyState 时钟)→ idempotent=false。
 * - model-scoring(W2 jev-150m):温·中段候选;只产决策不改字节;journal 留
 * context.model.score;同候选集同评分 → idempotent。
 * - context-prune(W3):温·已发出历史(可跨冻结区);一次性、受控破前缀 → true;
 * journal 留 context.path.abandoned;一次性路径声明不可重放 → idempotent=false。
 * - age(C4 按龄,缺口#30 守卫见 microcompact-age.ts):冷·最老完整组;ephemeral 只换
 * 本次请求、不回写历史,但**本次请求前缀会变** → mutatesEmittedBytes=true(契约总表
 * 「否(ephemeral)」指不回写;本字段按「请求字节是否变」取 true,见文件头§4.1.8.1 注);
 * 仅留痕 microcompact.age;不回写 → 下次 derive 原样 → idempotent。
 * - auto-compact(C1):冷·all-head;写新基线 → true;compact.start/done/skipped 留痕;
 * 压缩后历史换轨 → idempotent=false。
 */
export const PRUNER_REGISTRY: ContextPruner[] = [
  {
    id: "big-intake",
    zone: "hot",
    segment: "increment",
    mutatesEmittedBytes: false,
    persists: "artifact",
    idempotent: true,
    plan: stubPlan("registry-metadata-only"),
    apply: stubApply(),
  },
  {
    id: "spill",
    zone: "hot",
    segment: "increment",
    mutatesEmittedBytes: false,
    persists: "artifact",
    idempotent: true,
    plan: stubPlan("registry-metadata-only"),
    apply: stubApply(),
  },
  {
    id: "head-tail-refine",
    zone: "hot",
    segment: "tail",
    mutatesEmittedBytes: false,
    persists: "none",
    idempotent: true,
    plan: stubPlan("registry-metadata-only"),
    apply: stubApply(),
  },
  {
    id: "microcompact",
    zone: "warm",
    segment: "middle",
    mutatesEmittedBytes: true,
    persists: "journal",
    idempotent: false,
    plan: stubPlan("registry-metadata-only"),
    apply: stubApply(),
  },
  {
    id: "model-scoring",
    zone: "warm",
    segment: "middle",
    mutatesEmittedBytes: false,
    persists: "journal",
    idempotent: true,
    plan: stubPlan("registry-metadata-only"),
    apply: stubApply(),
  },
  {
    id: "context-prune",
    zone: "warm",
    segment: "middle",
    mutatesEmittedBytes: true,
    persists: "journal",
    idempotent: false,
    plan: stubPlan("registry-metadata-only"),
    apply: stubApply(),
  },
  {
    id: "age",
    zone: "cold",
    segment: "middle",
    mutatesEmittedBytes: true,
    persists: "journal",
    idempotent: true,
    plan: stubPlan("registry-metadata-only"),
    apply: stubApply(),
  },
  {
    id: "auto-compact",
    zone: "cold",
    segment: "all-head",
    mutatesEmittedBytes: true,
    persists: "journal",
    idempotent: false,
    plan: stubPlan("registry-metadata-only"),
    apply: stubApply(),
  },
];

/** 按 id 查(缺 null,不 throw)。 */
export function findPruner(id: string): ContextPruner | null {
  return PRUNER_REGISTRY.find((p) => p.id === id) ?? null;
}
