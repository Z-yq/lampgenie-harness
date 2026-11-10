/**
 * 本地虚拟组织 CLI( §3):可重复创建/idempotent 的演示团队 + demo git 项目。
 * 用法:
 *   node --experimental-strip-types scripts/team-demo.ts seed    # 建组织(二次运行零写入)
 *   node --experimental-strip-types scripts/team-demo.ts status  # 只读查看
 *   node --experimental-strip-types scripts/team-demo.ts clean   # 一键清理(poc: 只删 demo- 数据)
 * 根目录缺省 = <repo>/.genie/team(与内嵌 relay 同根,推上去后 relay 30s 轮询自动吸收进团队页)。
 * 加 --dry-run 只打印将做的动作(clean 用);加 --root=<path> 指定别的根(测试用)。
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupVirtualTeam, seedVirtualTeam, virtualTeamStatus } from "../apps/gateway/src/team-demo.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

function argOf(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

const cmd = process.argv[2] ?? "status";
const root = argOf("root") ?? join(repoRoot, ".genie", "team");

async function main(): Promise<number> {
  if (cmd === "seed") {
    const r = await seedVirtualTeam({ root });
    console.log(`[seed] root=${root}`);
    console.log(`  created(${r.created.length}): ${r.created.join(", ") || "-"}`);
    console.log(`  skipped(${r.skipped.length}): ${r.skipped.join(", ") || "-"}`);
    for (const m of r.members) console.log(`  member ${m.username} role=${m.role} roleId=${m.roleId} fp=${m.fingerprint}`);
    console.log(`  project ${r.project.id} commits=${r.project.commits} repo=${r.project.repoUrl}`);
    return 0;
  }
  if (cmd === "clean") {
    const r = await cleanupVirtualTeam({ root });
    console.log(`[clean] removed(${r.removed.length}): ${r.removed.join(", ") || "-"}`);
    return 0;
  }
  if (cmd === "status") {
    const s = await virtualTeamStatus({ root });
    console.log(`[status] root=${root}`);
    console.log(`  present=${s.present} project=${s.project ?? "-"}`);
    console.log(`  members(${s.members.length}): ${s.members.join(", ") || "-"}`);
    return 0;
  }
  console.error(`未知子命令: ${cmd}(可用 seed|status|clean)`);
  return 2;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(`[team-demo] 失败: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
