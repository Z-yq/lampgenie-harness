/**
 * 把虚拟组织发布进「正在运行的内嵌 relay」团队仓(designs/30 §3 的落地执行器)。
 *
 * 为什么需要它:内嵌 relay(:7870/gateway)自己的克隆目录 `.genie/team/relay/team-clone`
 * 每 30s 做一次 `checkout -f` + `reset --hard origin/main`;直接在它里面写文件会和轮询互踩。
 * 所以本脚本先在临时 root 里 seed 出一套完整组织,再把 **demo 相关文件** 合并进真实 bare 仓
 * (独立克隆 + commit + push),relay 下一轮轮询自然吸收,无需重启网关。
 *
 * 用法:
 *   node --experimental-strip-types scripts/team-demo-publish.ts seed
 *   node --experimental-strip-types scripts/team-demo-publish.ts status
 *   node --experimental-strip-types scripts/team-demo-publish.ts clean
 *   --root=<path> 覆盖真实团队根(缺省 <repo>/.genie/team);--project=<id> 缺省 demo-app
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupVirtualTeam, seedVirtualTeam, virtualTeamStatus } from "../apps/gateway/src/team-demo.ts";
import { parseYamlLite, stringifyYamlLite, type YamlValue } from "../packages/harness-runtime/src/team/yaml-lite.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

function argOf(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

const cmd = process.argv[2] ?? "status";
const root = argOf("root") ?? join(repoRoot, ".genie", "team");
const projectId = argOf("project") ?? "demo-app";
const bareDir = join(root, "team-repo.git");

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, GIT_AUTHOR_NAME: "demo-kai", GIT_AUTHOR_EMAIL: "demo-kai@example.invalid", GIT_COMMITTER_NAME: "demo-kai", GIT_COMMITTER_EMAIL: "demo-kai@example.invalid" },
  });
}

function gitTry(args: string[], cwd: string): string | null {
  try { return git(args, cwd); } catch { return null; }
}

/** 把 staging 克隆里的 demo 资源合并进真实团队仓克隆(非 demo 文件一律不动)。 */
function mergeDemoFiles(fromClone: string, toClone: string): string[] {
  const touched: string[] = [];
  const copyFile = (rel: string) => {
    const src = join(fromClone, rel);
    const dst = join(toClone, rel);
    mkdirSync(dirname(dst), { recursive: true });
    const next = readFileSync(src);
    const same = existsSync(dst) && readFileSync(dst).equals(next);
    if (same) return;
    writeFileSync(dst, next);
    touched.push(rel);
  };
  const copyTree = (relDir: string) => {
    const src = join(fromClone, relDir);
    if (!existsSync(src)) return;
    for (const f of readdirSync(src)) {
      const p = join(src, f);
      if (statSync(p).isDirectory()) copyTree(join(relDir, f));
      else copyFile(join(relDir, f));
    }
  };

  for (const f of ["teamai.yaml", "culture.md", "roster/roles.yaml"]) if (existsSync(join(fromClone, f))) copyFile(f);
  copyTree("skills/demo");
  copyTree("rules/demo");
  copyTree("docs");
  const membersSrc = join(fromClone, "roster", "members");
  if (existsSync(membersSrc)) for (const f of readdirSync(membersSrc)) if (f.startsWith("demo-")) copyFile(join("roster", "members", f));

  // projects.yaml:保留真实仓已有的非 demo 键,只并 demo 项目的三键(repo 指向真实根下的 bare)
  const projectsFile = join(toClone, "roster", "projects.yaml");
  let flat: Record<string, YamlValue> = {};
  if (existsSync(projectsFile)) {
    try { flat = parseYamlLite(readFileSync(projectsFile, "utf-8")); } catch { flat = {}; }
  }
  const prev = JSON.stringify(flat);
  flat[`${projectId}.type`] = "team";
  flat[`${projectId}.repo`] = join(root, "demo-projects", `${projectId}.git`);
  flat[`${projectId}.owner`] = "demo-kai";
  mkdirSync(dirname(projectsFile), { recursive: true });
  writeFileSync(projectsFile, stringifyYamlLite(flat));
  if (JSON.stringify(flat) !== prev || !existsSync(join(toClone, "roster", "projects.yaml"))) touched.push("roster/projects.yaml");
  return touched;
}

async function seedLive(): Promise<number> {
  if (!existsSync(join(bareDir, "HEAD"))) {
    console.error(`[publish] 真实团队仓不存在:${bareDir}(先启动一次 gateway 让内嵌 relay 自举)`);
    return 1;
  }
  const staging = mkdtempSync(join(tmpdir(), "vt-publish-"));
  const work = join(staging, "stage");
  let publish: string;
  try {
    await seedVirtualTeam({ root: work, projectId });
    // demo 项目落到真实根(projects.yaml 里写的是真实绝对路径)
    const realDemo = join(root, "demo-projects");
    mkdirSync(realDemo, { recursive: true });
    cpSync(join(work, "demo-projects"), realDemo, { recursive: true });
    if (!existsSync(join(realDemo, `${projectId}.git`, "HEAD"))) {
      // bare 被复制后 remote 指向仍可用;工作仓 origin 需要指向真实 bare 路径
      gitTry(["remote", "set-url", "origin", join(realDemo, `${projectId}.git`)], join(realDemo, projectId));
    }

    publish = join(staging, "publish-clone");
    git(["clone", "-q", bareDir, publish], staging);
    const touched = mergeDemoFiles(join(work, "relay", "team-clone"), publish);
    if (touched.length === 0) {
      console.log("[publish] 无变化(幂等命中),团队仓未提交");
      return 0;
    }
    git(["add", "-A"], publish);
    git(["commit", "-q", "-m", `chore(demo-team): 发布虚拟组织(${touched.length} 个文件 / demo-app 项目绑定)`], publish);
    git(["push", "-q", "origin", "HEAD:main"], publish);
    console.log(`[publish] 已推送 ${touched.length} 个文件到 ${bareDir} main:`);
    for (const t of touched) console.log(`  + ${t}`);
    console.log("[publish] 内嵌 relay 下一轮轮询(≤30s)自动吸收;团队页刷新即可见");
    return 0;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function cleanLive(): Promise<number> {
  const staging = mkdtempSync(join(tmpdir(), "vt-clean-"));
  const work = join(staging, "stage");
  try {
    // 先在真实团队仓克隆里摘掉 demo 资源(不碰 relay 自己的克隆)
    const publish = join(staging, "publish-clone");
    if (!existsSync(join(bareDir, "HEAD"))) {
      console.error(`[publish] 真实团队仓不存在:${bareDir}`);
      return 1;
    }
    git(["clone", "-q", bareDir, publish], staging);
    const removed: string[] = [];
    const rmPath = (rel: string) => {
      const p = join(publish, rel);
      if (!existsSync(p)) return;
      rmSync(p, { recursive: true, force: true });
      removed.push(rel);
    };
    const membersDir = join(publish, "roster", "members");
    if (existsSync(membersDir)) for (const f of readdirSync(membersDir)) if (f.startsWith("demo-")) rmPath(join("roster", "members", f));
    for (const d of ["skills/demo", "rules/demo"]) rmPath(d);
    for (const f of ["teamai.yaml", "culture.md"]) rmPath(f);
    const docsDir = join(publish, "docs");
    if (existsSync(docsDir)) for (const f of readdirSync(docsDir)) if (f.startsWith("demo")) rmPath(join("docs", f));
    const projectsFile = join(publish, "roster", "projects.yaml");
    if (existsSync(projectsFile)) {
      const flat = parseYamlLite(readFileSync(projectsFile, "utf-8"));
      let changed = false;
      for (const k of Object.keys(flat)) {
        if (!k.startsWith(`${projectId}.`)) continue;
        if (k === `${projectId}.repo` && !String(flat[k]).includes("demo-projects")) continue;
        delete flat[k];
        changed = true;
      }
      if (changed) {
        writeFileSync(projectsFile, stringifyYamlLite(flat));
        removed.push("roster/projects.yaml(demo 键)");
      }
    }
    if (removed.length) {
      git(["add", "-A"], publish);
      git(["commit", "-q", "-m", "chore(demo-team): 清理虚拟组织(demo- 成员/资源/项目绑定)"], publish);
      git(["push", "-q", "origin", "HEAD:main"], publish);
    }
    // 真实 demo-projects 目录(工作仓 + bare)整删
    const realDemo = join(root, "demo-projects");
    if (existsSync(realDemo)) { rmSync(realDemo, { recursive: true, force: true }); removed.push("demo-projects/"); }
    // staging 侧同逻辑跑一遍,保证与单测语义一致(幂等入口复用)
    await cleanupVirtualTeam({ root: work, projectId });
    console.log(`[clean] removed(${removed.length}): ${removed.join(", ") || "-"}`);
    return 0;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function statusLive(): Promise<number> {
  const s = await virtualTeamStatus({ root });
  const staged = mkdtempSync(join(tmpdir(), "vt-status-"));
  try {
    const publish = join(staged, "c");
    if (existsSync(join(bareDir, "HEAD"))) {
      git(["clone", "-q", bareDir, publish], staged);
      console.log(`[status] team-repo=${bareDir}`);
      console.log(git(["ls-tree", "-r", "--name-only", "HEAD"], publish).split("\n").filter(Boolean).map((p) => `  ${p}`).join("\n"));
      const projectsFile = join(publish, "roster", "projects.yaml");
      if (existsSync(projectsFile)) console.log(`[status] projects.yaml:\n${readFileSync(projectsFile, "utf-8")}`);
    }
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
  console.log(`[status] local-root=${root} present=${s.present} project=${s.project ?? "-"} members=${s.members.join(",") || "-"}`);
  return 0;
}

const main = cmd === "seed" ? seedLive : cmd === "clean" ? cleanLive : cmd === "status" ? statusLive : null;
if (!main) {
  console.error(`未知子命令: ${cmd}(可用 seed|status|clean)`);
  process.exit(2);
}
(main as () => Promise<number>)().then((c) => process.exit(c)).catch((e) => {
  console.error(`[publish] 失败: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
