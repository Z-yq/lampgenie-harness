/** 规则 2(1:1 迁移):页面板状态覆盖 + 交互 nav 落点。纯函数,零 IO。 */
import type { BoardContractIssue, BoardNodeT, EdgeLike } from "../shared.js";

export function pageContractIssues(nodes: BoardNodeT[], edges?: EdgeLike[]): BoardContractIssue[] {
  const issues: BoardContractIssue[] = [];
  const text = nodes
    .map((n) => `${n.label ?? ""} ${n.summary ?? ""} ${JSON.stringify(n.flow ?? [])}`)
    .join(" ");
  if (!["空态", "加载", "错误", "禁用", "权限"].some((k) => text.includes(k))) {
    issues.push({ nodeId: "(board)", label: "整板", problems: ["页面板未画空态/加载中/错误/禁用/权限不足(只画 happy path)"] });
  }
  const hasInteraction = nodes.some(
    (n) => ["component", "section"].includes(String(n.kind)) || /按钮|点击|提交|选择|弹窗|下拉|切换/.test(`${n.label ?? ""} ${n.summary ?? ""}`),
  );
  const navEdges = (edges ?? []).filter((e) => (e.kind ?? "call") === "nav");
  if (hasInteraction && edges && navEdges.length === 0) {
    issues.push({ nodeId: "(board)", label: "整板", problems: ["交互节点没有 nav 边指向逻辑节点(UI 与逻辑两张皮)"] });
  }
  const navNoLabel = navEdges.filter((e) => !String(e.label ?? "").trim());
  if (navNoLabel.length > 0) {
    issues.push({ nodeId: "(edges)", label: "nav 边", problems: [`${navNoLabel.length} 条 nav 边缺触发条件 label`] });
  }
  return issues;
}
