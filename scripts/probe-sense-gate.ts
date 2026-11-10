/**
 * code_sense 预算闸/子仓识别探针(2026-11-02 立;2026-11-08 随「git 仓根不拆包」更新)。
 *
 * 期望:
 *  - 本仓根是 git 仓 → rootScanVerdict 放行(有构建 meta 时走 index-meta 快路,免 9p 全仓 walk);
 *  - detectWorkspaceRepos 返回 []——apps/*、packages/* 是 workspace 包,不是独立子仓
 *    (旧行为会拆出 17 个包级索引,跨包 impact 被切断);
 *  - 非 git 工作区根(多仓混布)仍按标记发现子仓(由 orient-budget-gate 单测覆盖)。
 *
 * 跑法:node --experimental-strip-types scripts/probe-sense-gate.ts(或 npx tsx)
 */
import { rootScanVerdict, detectWorkspaceRepos } from "../apps/gateway/src/sense-root-gate.ts";

const root = new URL("..", import.meta.url).pathname.replace(/\/+$/, ""); // 与 gateway repoRoot 同口径(无尾斜杠;indexDir 按字符串 hash)
const verdict = await rootScanVerdict(root);
const repos = await detectWorkspaceRepos(root);
console.log("root:", root);
console.log("verdict:", JSON.stringify(verdict));
console.log("repos(" + repos.length + "):", repos.map((r) => r.name).join(", ") || "(none)");
if (!verdict.ok) {
  console.error("FAIL: 预算闸拒绝本仓:", verdict.reason);
  process.exit(1);
}
if (repos.length !== 0) {
  console.error("FAIL: git 仓根被拆成子仓:", repos.map((r) => r.name).join(","));
  process.exit(1);
}
console.log("PASS: 闸放行(" + verdict.files + " 源文件,source=" + (verdict.source ?? "walk") + ")+ git 仓根单根(repos=0)");
