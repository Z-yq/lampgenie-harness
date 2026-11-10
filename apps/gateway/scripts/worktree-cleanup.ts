#!/usr/bin/env tsx
/**
 * 统一 worktree 清理命令:
 *   tsx apps/gateway/scripts/worktree-cleanup.ts list    --repo <repo>
 *   tsx apps/gateway/scripts/worktree-cleanup.ts remove  --repo <repo> --id <agentId> [--delete-branch]
 *   tsx apps/gateway/scripts/worktree-cleanup.ts cleanup --repo <repo> [--ttl-hours 168] [--dry-run]
 * 默认保留分支(任务书:分支供人工合并);--delete-branch 才删本服务创建的 genie/ 分支。
 */
import { WorktreeService } from "../src/worktree-service.js";

function usage(): string {
  return [
    "用法:",
    "  tsx apps/gateway/scripts/worktree-cleanup.ts list    --repo <repo>",
    "  tsx apps/gateway/scripts/worktree-cleanup.ts remove  --repo <repo> --id <agentId> [--delete-branch]",
    "  tsx apps/gateway/scripts/worktree-cleanup.ts cleanup --repo <repo> [--ttl-hours 168] [--dry-run]",
    "",
    "repo 必须是 git 仓内绝对路径;也可用环境变量 GENIE_WORKTREE_REPO。",
  ].join("\n");
}

function argOf(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]!;
    if (item === name) return argv[i + 1];
    if (item.startsWith(`${name}=`)) return item.slice(name.length + 1);
  }
  return undefined;
}

async function main(): Promise<void> {
  const [, , cmdRaw = "list", ...rest] = process.argv;
  const cmd = cmdRaw.toLowerCase();
  const repo = argOf(rest, "--repo") ?? process.env.GENIE_WORKTREE_REPO;
  if (!repo) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  const service = new WorktreeService();
  try {
    if (cmd === "list") {
      const infos = await service.list({ cwd: repo });
      console.log(JSON.stringify(infos, null, 2));
      return;
    }
    if (cmd === "remove") {
      const id = argOf(rest, "--id");
      const path = argOf(rest, "--path");
      if (!id && !path) throw new Error("remove 需要 --id 或 --path");
      const out = await service.remove({
        cwd: repo,
        ...(id ? { id } : {}),
        ...(path ? { path } : {}),
        deleteBranch: rest.includes("--delete-branch"),
      });
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    if (cmd === "cleanup") {
      const hoursRaw = Number(argOf(rest, "--ttl-hours") ?? "168");
      const hours = Number.isFinite(hoursRaw) && hoursRaw >= 0 ? hoursRaw : 168;
      const out = await service.cleanup({ cwd: repo, ttlMs: hours * 3_600_000, dryRun: rest.includes("--dry-run") });
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    console.error(`未知子命令 ${cmdRaw}\n\n${usage()}`);
    process.exitCode = 2;
  } catch (err) {
    console.error(`[worktree] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

void main();
