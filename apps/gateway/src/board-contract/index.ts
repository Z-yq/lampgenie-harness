/** 变更契约规则集统一出口(重构;board-accept.ts 保留兼容转发)。 */
export { validateChangeContract } from "./validate.js";
export type { BoardContractIssue, BoardNodeT, EdgeLike } from "./shared.js";
export { scanFlowContract } from "./rules/flow.js";
export { pageContractIssues } from "./rules/page.js";
export { riskContractIssues } from "./rules/risk.js";
export { boardLevelIssues } from "./rules/board-level.js";
export { validateBoardTypeConformance, renderTypeConformanceIssues, typeConformancePass, typeConformanceLines } from "./rules/type-conformance.js";
