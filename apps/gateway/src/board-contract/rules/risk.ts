/** 规则 3(1:1 迁移):不可逆改动/回滚体检。纯函数,零 IO。 */
import type { BoardContractIssue, BoardNodeT } from "../shared.js";

export function riskContractIssues(nodes: BoardNodeT[]): BoardContractIssue[] {
  const changed = nodes.filter((n) => (n.change ?? "modify") !== "keep");
  const text = changed.map((n) => `${n.label ?? ""} ${n.summary ?? ""} ${n.before ?? ""}`).join(" ");
  const irreversible = changed.some((n) => (n.change ?? "modify") === "delete")
    || /数据迁移|迁移|权限模型|协议.*破坏|破坏性变更/.test(text);
  if (!irreversible) return [];
  const hasRisk = nodes.some((n) => /风险|回滚/.test(`${n.label ?? ""} ${n.summary ?? ""}`));
  const hasRollbackAccept = nodes.some((n) =>
    (n.accept ?? []).some((a) => /回滚|rollback|回退/i.test(`${a.cmd ?? ""} ${a.expect ?? ""} ${a.note ?? ""}`)),
  );
  if (hasRisk || hasRollbackAccept) return [];
  return [{ nodeId: "(board)", label: "整板", problems: ["检测到不可逆改动(delete/迁移/权限/协议破坏)但未见风险节点或回滚验证(P0 accept)"] }];
}
