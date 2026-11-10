/** 编排层(2026-10-25 重构):原 board-accept.validateChangeContract 的 N:1 收敛。
 * 分支语义逐字保留:workflow 短路、page 判定、skipDesign、boardType 缺省风险、模板豁免。 */
import type { BoardContractIssue, BoardNodeT, EdgeLike } from "./shared.js";
import { BOARD_RISK_TYPES, CONTRACT_SKIP_KINDS, NON_TARGET_KINDS, isTemplateNode } from "./shared.js";
import { scanFlowContract } from "./rules/flow.js";
import { pageContractIssues } from "./rules/page.js";
import { riskContractIssues } from "./rules/risk.js";
import { boardLevelIssues } from "./rules/board-level.js";

export function validateChangeContract(
  nodes: BoardNodeT[],
  docKind?: string,
  edges?: EdgeLike[],
  opts: { boardType?: string; scale?: string } = {},
): { ok: boolean; issues: BoardContractIssue[] } {
  if (docKind === "workflow") return { ok: true, issues: [] };
  const boardType = opts.boardType;
  const isPage = docKind === "page" || boardType === "ui" || boardType === "ui-func";
  const skipDesign = isPage || boardType === "fault" || boardType === "docs" || boardType === "research" || boardType === "matrix";
  const issues: BoardContractIssue[] = [];
  for (const n of nodes) {
    if (String(n.id).startsWith("ph-")) continue;
    if (CONTRACT_SKIP_KINDS.has(String(n.kind))) continue;
    const id = String(n.id);
    const label = String(n.label ?? id);
    const problems: string[] = [];
    // 2026-10-29(用户口径「画的是计划而不是代码逻辑」):keep = 纯读现有逻辑的逻辑快照,
    // 不改代码就没有可验收的东西,不再要求 P0 accept;modify/add/delete 仍必须有。
    if (n.phase === "P0" && String(n.change ?? "") !== "keep") {
      for (const [i, a] of (n.accept ?? []).entries()) {
        if (!String(a?.cmd ?? "").trim()) problems.push(`P0 accept ${i + 1} 缺 cmd`);
        if (!String(a?.expect ?? "").trim()) problems.push(`P0 accept ${i + 1} 缺 expect(期望结果/观察标准)`);
        if (!a?.type) problems.push(`P0 accept ${i + 1} 未标 type(命令/浏览器/人工/负面断言)`);
      }
    }
    if (!isPage) {
      const symName = String(n.symbolRef?.name ?? "").trim();
      if (symName && !/^[A-Za-z_$][A-Za-z0-9_$.:#-]*$/.test(symName)) {
        problems.push(`symbolRef.name 不是合法符号名(${symName})——先 code_sense 查真名再填`);
      }
      if (!skipDesign && !isTemplateNode(id)) {
        const change = n.change ?? "modify";
        if ((change === "modify" || change === "delete") && !String(n.before ?? "").trim()) {
          problems.push(`${change} 缺 before(原来是什么样)`);
        }
        const hasTargets = Array.isArray(n.targets) && n.targets.some((t) => String(t).trim() !== "");
        const codeTarget = !NON_TARGET_KINDS.has(String(n.kind));
        if (codeTarget && change !== "keep" && !hasTargets && !String(n.symbolRef?.name ?? "").trim()) {
          problems.push(`${change} 缺 targets/symbolRef(改哪里未说清)`);
        }
      }
      if (!skipDesign || boardType === "fault" || boardType === "docs" || boardType === "research" || boardType === "matrix") {
        scanFlowContract(n.flow, "", problems);
      }
    }
    if (problems.length > 0) issues.push({ nodeId: id, label, problems });
  }
  if (isPage) {
    issues.push(...pageContractIssues(nodes, edges));
  } else {
    if (boardType === undefined || BOARD_RISK_TYPES.has(boardType)) issues.push(...riskContractIssues(nodes));
    if (edges) {
      const explicit = edges.filter((e) => e.virtual !== true);
      const noLabel = explicit.filter((e) => !String(e.label ?? "").trim());
      if (noLabel.length > 0) {
        issues.push({ nodeId: "(edges)", label: "显式边", problems: [`${noLabel.length} 条显式边缺 label(数据格式/触发条件)`] });
      }
    }
  }
  issues.push(...boardLevelIssues(nodes, boardType, opts.scale));
  return { ok: issues.length === 0, issues };
}
