/**
 * RSI 域消息:rsi.status 快照 + 机制治理面(RSI-MECH)。
 * 自 index.ts(2941 行)按域拆分,逐字搬移。
 */
import { z } from "zod";
import { Envelope } from "./core.js";
// [CROSS-IMPORTS]
// ---- RSI 状态只读快照(rsi.status; 面板「团队」页)----
// 纯请求-响应,无连接级主动推送。结构由协议自持(不跨包引用 apps/gateway 的实现),
// 字段与 apps/gateway/src/rsi-status.ts 的 RsiStatusSection 保持一致:
// id/title/ok/code?/metrics[{label,value,unit?,tone?}]/warnings[]。
/** 单条指标;value 放宽为 string|number,tone 放宽为 string(配色语义由面板解释)。 */
export const RsiStatusMetricZ = z.object({
  label: z.string(),
  value: z.union([z.string(), z.number()]),
  unit: z.string().optional(),
  tone: z.string().optional(),
});
export type RsiStatusMetric = z.infer<typeof RsiStatusMetricZ>;
/** 单条机制结果条目( RSI-MECH:覆盖层投影后的一条结果,可编辑/删除)。
 * id 是覆盖层稳定键(agent 结果带 `<runId>:` 前缀);source 标来源,parent 据此区分「改过的视图层」与「原生台账」。 */
export const RsiResultItemZ = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  detail: z.string().optional(),
  status: z.enum(["ok", "warn", "bad", "info"]).optional(),
  source: z.enum(["agent", "code", "manual"]).optional(),
  at: z.number().optional(),
});
export type RsiResultItem = z.infer<typeof RsiResultItemZ>;
/** 一次运行的成本核算( RSI-SESSION-COST):token 来自该任务窗口内的 llm.trace 上报值,
 * 金额由 core 单价表算;**单价缺失时 amountCny=null 且 missing 列出缺价段**,绝不按 0 冒充。 */
export const RsiRunCostZ = z.object({
  inputTokens: z.number(),
  cachedTokens: z.number(),
  cacheCreationTokens: z.number().optional(),
  outputTokens: z.number(),
  totalTokens: z.number(),
 /** 窗口内最后一次 llm.trace 上报的模型名(缺=provider 未暴露)。 */
  model: z.string().optional(),
 /** 金额(元);null=单价缺失(面板显示「单价缺失」)。 */
  amountCny: z.number().nullable(),
 /** 单价缺失的段名(cacheRead/cacheWrite/inputMiss/output;整模型无价时四段全列)。 */
  missing: z.array(z.string()),
});
export type RsiRunCost = z.infer<typeof RsiRunCostZ>;
/** 本次运行的会话分析计划与结果(候选=派单时列给 agent 的,analyzed=最终回复里认账且命中候选的)。 */
export const RsiRunAnalysisZ = z.object({
  windowDays: z.number(),
  candidates: z.array(z.object({
    sessionId: z.string(),
    projectId: z.string().optional(),
    lastActiveAt: z.number().optional(),
  })),
  analyzed: z.array(z.object({
    sessionId: z.string(),
    projectId: z.string().optional(),
  })),
});
export type RsiRunAnalysis = z.infer<typeof RsiRunAnalysisZ>;
/** 机制最近一次运行的摘要(agent 任务)。 */
export const RsiMechanismRunInfoZ = z.object({
  runId: z.string().optional(),
  taskId: z.string().optional(),
  status: z.enum(["running", "done", "failed"]),
 /** 任务真实状态(queued/running/…):排队时 status 仍是 running,面板据此显示「排队中」。 */
  taskState: z.string().optional(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  error: z.string().optional(),
 /** 本次运行花了多少(旧网关不带=面板不显示成本行)。 */
  cost: RsiRunCostZ.optional(),
 /** 本次运行分析了哪些会话(旧网关不带=面板不显示分析行)。 */
  analysis: RsiRunAnalysisZ.optional(),
});
export type RsiMechanismRunInfo = z.infer<typeof RsiMechanismRunInfoZ>;
/** 单个 RSI 检查项(ok=false 时 code 给机器可读原因,warnings 给人读提示)。
 * 增可选 enabled/driver/items/run(旧网关不带这些字段仍能 parse)。 */
export const RsiStatusSectionZ = z.object({
  id: z.string(),
  title: z.string(),
  ok: z.boolean(),
  code: z.string().optional(),
  metrics: z.array(RsiStatusMetricZ),
  warnings: z.array(z.string()),
 /** 机制开关(缺省=未上报,面板按启用渲染)。 */
  enabled: z.boolean().optional(),
 /** 驱动方式:agent=派 agent 任务;code=沿用确定性代码/CLI。 */
  driver: z.enum(["agent", "code"]).optional(),
 /** 结果条目(覆盖层投影后;缺省=未上报)。 */
  items: z.array(RsiResultItemZ).optional(),
 /** 最近一次运行摘要。 */
  run: RsiMechanismRunInfoZ.optional(),
});
export type RsiStatusSection = z.infer<typeof RsiStatusSectionZ>;
/** 客户端请求:空载荷(无字段)。 */
export const RsiStatusQuery = Envelope.extend({ type: z.literal("rsi.status") });
export const RsiStatusResult = Envelope.extend({
  type: z.literal("rsi.status.result"),
 /** 采集时刻(ms epoch)。 */
  at: z.number(),
  sections: z.array(RsiStatusSectionZ),
 /** 汇总:ok=true 的项数 / warnings 总数(面板直接展示,不重算)。 */
  okCount: z.number(),
  warnCount: z.number(),
});

// ---- RSI 机制治理面( RSI-MECH):开关 / 驱动 / 运行 / 结果条目改删 ----
// 全部请求-响应,不主动推;旧 rsi.status 不变,新能力是新增型。
export const RsiMechanismSet = Envelope.extend({
  type: z.literal("rsi.mechanism.set"),
  id: z.string(),
  enabled: z.boolean().optional(),
  driver: z.enum(["agent", "code"]).optional(),
});
export const RsiMechanismSetResult = Envelope.extend({
  type: z.literal("rsi.mechanism.set.result"),
  ok: z.boolean(),
  id: z.string(),
  enabled: z.boolean().optional(),
  driver: z.enum(["agent", "code"]).optional(),
  reason: z.string().optional(),
});
export const RsiMechanismRun = Envelope.extend({
  type: z.literal("rsi.mechanism.run"),
  id: z.string(),
});
export const RsiMechanismRunResult = Envelope.extend({
  type: z.literal("rsi.mechanism.run.result"),
  ok: z.boolean(),
  id: z.string(),
  runId: z.string().optional(),
  taskId: z.string().optional(),
  sessionId: z.string().optional(),
  reason: z.string().optional(),
});
export const RsiItemUpdate = Envelope.extend({
  type: z.literal("rsi.item.update"),
  mechanismId: z.string(),
  itemId: z.string(),
  title: z.string().optional(),
  summary: z.string().optional(),
  detail: z.string().optional(),
  status: z.enum(["ok", "warn", "bad", "info"]).optional(),
});
export const RsiItemDelete = Envelope.extend({
  type: z.literal("rsi.item.delete"),
  mechanismId: z.string(),
  itemId: z.string(),
  reason: z.string().optional(),
});
export const RsiItemResult = Envelope.extend({
  type: z.literal("rsi.item.result"),
  ok: z.boolean(),
  mechanismId: z.string(),
  itemId: z.string(),
  reason: z.string().optional(),
 /** 改删后的最新条目投影(面板直接替换,不必再拉一拍)。 */
  items: z.array(RsiResultItemZ).optional(),
});
