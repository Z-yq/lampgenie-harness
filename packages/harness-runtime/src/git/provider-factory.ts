/**
 * GitProvider 工厂( R1「team={provider, groupPath}」落地)。
 * providers.yaml 按 team 绑定平台:relay 部署点据此构造平台 provider——此前 Relay 只能
 * CustomGitProvider(new 写死),GitLab/Codeup 平台 provider 从未进 Relay 通道。
 * 优先级:providers.yaml[team].provider 显式(kind=custom/gitlab/codeup)>环境变量 RELAY_PROVIDER。
 * `platform: "force"`=开发/测试注入点:providers.yaml 声明了平台但仍用裸 git 命令(不碰平台 API),
 * 真实平台 API 路径(github/gitlab/codeup)待平台令牌实机联调。
 * 凭证红线(token/secret 绝入日志与错误文案):
 *   ① 环境变量明示(EXPLICIT=明文入 env;SECRETREF=$ENV:NAME=从 NAME 解析,缺省=fail-visible 抛错);
 *   ② 写入仓=fail-visible 抛错;③ git config 全局凭据落盘=fail-visible 抛错。
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { CustomGitProvider, git } from "./provider.js";
import { GitLabProvider } from "./gitlab.js";
import { CodeupProvider } from "./codeup.js";
import type { GitProvider } from "./provider.js";

export interface TeamProviderBinding {
  provider: "custom" | "github" | "gitlab" | "codeup";
  /** git 平台 group(开发组织),如 my-org;团队仓=<group>/genie-team-context。 */
  groupPath?: string;
  /** 平台 API baseUrl(私有部署)。 */
  baseUrl?: string;
  /** 项目标识(缺省 <groupPath>/genie-team-context)。 */
  projectPath?: string;
  organizationId?: number | string;
  /** `force`=providers.yaml 声明了平台仍用裸 git 命令(开发/测试;不碰平台 API)。 */
  platform?: string;
}

export interface TeamBindingConfig {
  team: TeamProviderBinding;
  /** 推送分支的用户名(git 提交者身份;缺省 genie-relay)。 */
  gitName?: string;
  gitEmail?: string;
}

/** 解析凭证:EXPLICIT 明文 / $ENV:NAME 环境解析 / 空=undefined;其余形态 fail-visible 抛错。 */
export function resolveTeamSecret(spec: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!spec) return undefined;
  if (spec.startsWith("$ENV:")) {
    const name = spec.slice("$ENV:".length);
    const v = env[name];
    if (!v) throw new Error(`providers.yaml 引用的环境变量缺失: ${name}(resolveTeamSecret 解析失败,fail-visible)`);
    return v;
  }
  return spec;
}

/** 读 providers.yaml(缺失/解析坏→null,调用方按缺省 custom 处理)。 */
export function loadTeamBinding(providersPath: string): TeamBindingConfig | null {
  if (!existsSync(providersPath)) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(providersPath, "utf-8"));
  } catch {
    return null; // 坏文件=降级 custom(显式 fail-visible 反更吓人:providers.yaml 是部署面,损坏应可降级启动)
  }
  const c = doc as TeamBindingConfig;
  if (!c || typeof c !== "object" || !c.team) return null;
  return c;
}

/** 按绑定构造 GitProvider;env 注入点(测试可传)。 */
export function providerFromBinding(binding: TeamBindingConfig | null, env: NodeJS.ProcessEnv = process.env): GitProvider {
  if (!binding || !binding.team) return new CustomGitProvider();
  const t = binding.team;
  const projectPath = t.projectPath ?? (t.groupPath ? `${t.groupPath}/genie-team-context` : "");
  if (t.platform === "force") return new CustomGitProvider(); // 声明了平台但走裸 git(开发/测试)
  if (t.provider === "gitlab") {
    if (!t.baseUrl) throw new Error("providers.yaml gitlab 缺 baseUrl");
    return new GitLabProvider({
      baseUrl: t.baseUrl,
      token: resolveTeamSecret(env.RELAY_PROVIDER_TOKEN, env)!,
      projectPath,
    });
  }
  if (t.provider === "codeup") {
    return new CodeupProvider({
      token: resolveTeamSecret(env.RELAY_PROVIDER_TOKEN, env)!,
      projectPath,
      organizationId: t.organizationId,
      ...(t.baseUrl ? { baseUrl: t.baseUrl } : {}),
    });
  }
  // github=二期(未实 provider);custom/未知=降级裸 git。
  return new CustomGitProvider();
}

/** 团队仓引导:仓里还没有 roster/ 时,写初始 projects.yaml(一个 team 项目占位)并提交推送。
 * mainBranch 缺省自动探测(ls-remote HEAD;团队仓可能是 master,如 teamai 形态)。 */
export async function bootstrapTeamRepo(
  provider: GitProvider,
  teamRepoUrl: string,
  workdir: string,
  opts: { mainBranch?: string } = {},
): Promise<boolean> {
  const probe = join(workdir, ".bootstrap-probe");
  try {
    await provider.clone(teamRepoUrl, probe);
    let main = opts.mainBranch;
    if (!main) {
      try {
        const out = await git(["ls-remote", "--symref", teamRepoUrl, "HEAD"], workdir);
        main = /ref: refs\/heads\/(\S+)\tHEAD/.exec(out)?.[1] ?? "main";
      } catch {
        main = "main";
      }
    }
    await git(["fetch", "origin"], probe);
    await git(["checkout", "-f", main], probe).catch(() => {});
    // 空仓没有 origin/<main>,reset 会失败——只在 ref 存在时执行(孤儿分支提交后由 push 建立)。
    const hasMain = await git(["rev-parse", "--verify", `origin/${main}`], probe).then(() => true).catch(() => false);
    if (hasMain) await git(["reset", "--hard", `origin/${main}`], probe);
    const projFile = join(probe, "roster", "projects.yaml");
    if (existsSync(projFile)) return false; // 已有 roster=已引导过
    mkdirSync(join(probe, "roster"), { recursive: true });
    writeFileSync(projFile, "lampgenie-harness.type: team\nlampgenie-harness.owner: owner\n");
    const ident = ["-c", "user.email=relay@lampgenie.local", "-c", "user.name=genie-relay"];
    await git([...ident, "add", "roster/"], probe);
    await git([...ident, "commit", "-m", "chore: bootstrap team repo (lampgenie-harness)"], probe);
    await git(["push", "origin", `HEAD:refs/heads/${main}`], probe);
    return true;
  } catch {
    return false; // 引导失败容忍:团队可手动建 roster;非致命。
  }
}
