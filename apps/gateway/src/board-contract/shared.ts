/** 变更契约校验的共享类型/常量(2026-10-25 重构:rules/ + 编排层;原 board-accept.ts 内联)。 */
import type { BoardDoc } from "@lampgenie/protocol";

export type BoardNodeT = BoardDoc["nodes"][number];

export interface BoardContractIssue {
  nodeId: string;
  label: string;
  problems: string[];
}

export type EdgeLike = {
  from: string;
  to: string;
  kind?: string;
  label?: string;
  virtual?: boolean;
};

/** 阶段泳道(ph-*)不是设计节点,结构性注记(note/start/end)不是变更目标——自检跳过。 */
export const CONTRACT_SKIP_KINDS = new Set(["note", "start", "end"]);
/** 用户旅程冒烟/打包预检是验收节点,不是代码变更目标:不套 before/targets/flow。 */
export const CONTRACT_SKIP_IDS = new Set(["smoke", "preflight"]);
/** 非代码目标件(判断/页面结构)不要求 targets/symbolRef。 */
export const NON_TARGET_KINDS = new Set(["note", "start", "end", "decision", "page", "section", "component", "nav"]);
/** 风险/回滚规则只约束会改变现有系统的板型;故障链/调研/文档不是变更实施板。 */
export const BOARD_RISK_TYPES = new Set(["code", "refactor", "perf", "data", "contract", "deploy"]);

/** smoke/preflight 模板节点(含 pkg-smoke 这类前缀)不是代码变更目标。 */
export function isTemplateNode(id: string): boolean {
  return CONTRACT_SKIP_IDS.has(id) || /(^|[-_])smoke$/.test(id) || /(^|[-_])preflight$/.test(id);
}
