/** 仓根解析:环境变量 > 向上找 pnpm-workspace.yaml > cwd。
 * bundle 部署形态下 cwd 可能是任意目录(R4 后实测:apps/gateway 下启动导致 sense root 错位)。 */
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

export function repoRoot(): string {
  if (process.env.GENIE_REPO_ROOT) return process.env.GENIE_REPO_ROOT;
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}
