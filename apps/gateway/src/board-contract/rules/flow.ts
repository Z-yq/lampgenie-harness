/** 规则 1(1:1 自 board-accept.ts 迁移):flow step/branch/loop 完整性。纯函数,零 IO。 */
import type { BoardNodeT } from "../shared.js";

export function scanFlowContract(steps: BoardNodeT["flow"], at: string, problems: string[]): void {
  for (const [i, f] of (steps ?? []).entries()) {
    const here = `${at}${i + 1}`;
    if (f.type === "branch") {
      if (!String(f.cond ?? "").trim()) problems.push(`flow ${here} 是 branch 但缺 cond`);
      const hasBranch = (Array.isArray(f.then) && f.then.length > 0) || (Array.isArray(f.else) && f.else.length > 0);
      if (!hasBranch) problems.push(`flow ${here} 是 branch 但 then/else 都为空(分支去向未写)`);
    }
    if (f.type === "loop") {
      if (!String(f.over ?? "").trim()) problems.push(`flow ${here} 是 loop 但缺 over`);
      if (!Array.isArray(f.body) || f.body.length === 0) problems.push(`flow ${here} 是 loop 但缺 body(循环体未写)`);
    }
    if (f.type === "step" && !String(f.text ?? "").trim()) problems.push(`flow ${here} 是 step 但缺 text`);
    for (const [name, arr] of [["then", f.then], ["else", f.else], ["body", f.body]] as const) {
      if (Array.isArray(arr) && arr.length > 0) scanFlowContract(arr, `${here}.${name}.`, problems);
    }
  }
}
