/**
 * 深审策略闸( O1):确定性层(含反模式)跑完之后才决定要不要烧 LLM。
 * 经验证:深审跑满 8 分钟时间盒且零新增 findings(确定性层已 6→3 无 blocker)——
 * 「默认一定深审」在干净小变更上纯烧钱,故给出 auto 档并按证据自动跳过。
 * 三档语义:
 *  - always:恒定深审(CLI `--deep` / 既有调用方未传 policy 的旧行为);
 *  - never :恒定不深审(fast 复跑,秒级零 LLM);
 *  - auto  :免费层无 blocker 且变更集小(totalLines ≤ AUTO_DEEP_MAX_LINES 且 files ≤ AUTO_DEEP_MAX_FILES)
 *            → 跳过并显式写进 summary;否则照常深审。
 * 注意 findings severity 只有 blocker/warning/nit 三档(见 index.ts Finding)——
 * 任务口径里的「blocker/high」在本引擎等价于最高档 blocker。
 */
export type LlmPolicy = "auto" | "always" | "never";

/** auto 档的小变更门槛(行数)。 */
export const AUTO_DEEP_MAX_LINES = 1200;
/** auto 档的小变更门槛(文件数)。 */
export const AUTO_DEEP_MAX_FILES = 20;

export interface DeepDecisionMeta {
  /** 变更集文件数。 */
  files: number;
  /** 变更集总行数。 */
  totalLines: number;
  /** 免费层(确定性+反模式)blocker 条数。 */
  blocking: number;
}

/** 纯函数:策略 + 变更集元信息 → 是否真的调 LLM 深审 + 可读说明。 */
export function decideDeepReview(policy: LlmPolicy, m: DeepDecisionMeta): { run: boolean; note: string } {
  if (policy === "always") return { run: true, note: "深审强制(deep:true / policy=always)" };
  if (policy === "never") return { run: false, note: "深审跳过(fast:true / policy=never:确定性层 only,零 LLM)" };
  const small = m.totalLines <= AUTO_DEEP_MAX_LINES && m.files <= AUTO_DEEP_MAX_FILES;
  if (m.blocking === 0 && small) {
    return { run: false, note: "深审跳过(auto:确定性 0 blocker 且变更集小;需深审传 deep:true)" };
  }
  const why = m.blocking > 0
    ? `确定性层 ${m.blocking} 条 blocker`
    : `变更集 ${m.files} 文件/${m.totalLines} 行超小变更门(${AUTO_DEEP_MAX_FILES} 文件/${AUTO_DEEP_MAX_LINES} 行)`;
  return { run: true, note: `深审照常(auto:${why})` };
}