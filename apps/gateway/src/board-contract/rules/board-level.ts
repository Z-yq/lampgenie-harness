/** 规则 4(1:1 迁移):重复 label/规模/重构泳道/故障链段。纯函数,零 IO。 */
import type { BoardContractIssue, BoardNodeT } from "../shared.js";
import { isTemplateNode } from "../shared.js";

export function boardLevelIssues(nodes: BoardNodeT[], boardType?: string, scale?: string): BoardContractIssue[] {
  const issues: BoardContractIssue[] = [];
  const byLabel = new Map<string, string[]>();
  for (const n of nodes) {
    const id = String(n.id);
    if (String(n.id).startsWith("ph-") || isTemplateNode(id)) continue;
    const label = String(n.label ?? "").trim();
    if (!label) continue;
    const arr = byLabel.get(label) ?? [];
    arr.push(id);
    byLabel.set(label, arr);
  }
  const dup = [...byLabel.entries()].filter(([, ids]) => ids.length > 1);
  if (dup.length > 0) {
    const detail = dup.slice(0, 4).map(([label, ids]) => `「${label}」${ids.join("/")}`).join(";");
    issues.push({ nodeId: "(board)", label: "整板", problems: [`${dup.length} 组重复 label(疑似换 id 重画/两版并板;请 prune 或合并):${detail}`] });
  }
  if (scale === "S" && nodes.length > 3) {
    issues.push({ nodeId: "(board)", label: "整板", problems: [`scale=S 但板有 ${nodes.length} 节点(应为 1~3 节点一次到位)`] });
  }
  if (scale === "M" && nodes.length > 9) {
    issues.push({ nodeId: "(board)", label: "整板", problems: [`scale=M 骨架超过 9 节点(当前 ${nodes.length};请精简或标 L 两版)`] });
  }
  if (boardType === "refactor") {
    const groups = nodes.map((n) => String(n.group ?? "")).filter(Boolean);
    if (!groups.some((g) => g.includes("现状")) || !groups.some((g) => g.includes("目标"))) {
      issues.push({ nodeId: "(board)", label: "整板", problems: ["重构板缺现状层/目标层泳道(group 需含「现状」「目标」;否则双图在画布上分不开)"] });
    }
  }
  if (boardType === "fault") {
    const text = nodes.map((n) => `${n.group ?? ""} ${n.label ?? ""} ${n.summary ?? ""}`).join(" ");
    const stages = [["复现"], ["异常", "观测"], ["假设"], ["根因"], ["修复"], ["防复发", "回归"]];
    const missing = stages.filter((alts) => !alts.some((k) => text.includes(k))).map((alts) => alts[0]);
    if (missing.length > 0) {
      issues.push({ nodeId: "(board)", label: "整板", problems: [`故障链缺段:${missing.join("/")}(价值在推理链,6 段都要有)`] });
    }
  }
  return issues;
}
