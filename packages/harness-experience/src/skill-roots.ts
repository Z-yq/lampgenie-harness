/**
 * 技能根解析(n5 多根发现,照 ZCode `apps/zcode-cli/packages/adapters/src/skills/roots.ts`
 * 的「多根 + priority 每级 +10」语义,裁到本仓的两级形态):
 *   user    `<home>/.genie/experiences`        priority 10
 *   project `<projectRoot>/.genie/experiences` priority 20
 *
 * 为什么需要多根:此前单根固定在 `<repo>/.genie/experiences`,用户级手写技能没有落点
 * (要么塞进仓库、要么塞进内置常量)。多根后读路径看全部根(priority 高者赢),
 * 写路径落最高优先级根(project)——见 store.ts `ExperienceStore.fromRoots`。
 *
 * 纪律:home 为空 / 家目录或其技能目录不存在(容器、CI 无家目录)→ 跳过该根,
 * 不凭空造出用户根目录;project 根始终保留(它是写路径,store 构造时会 mkdir)。
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface SkillRoot {
  /** 技能根绝对路径(其下直接是 `<category>/<name>/SKILL.md`)。 */
  dir: string;
  scope: "user" | "project";
  /** 每级 +10(ZCode PRIORITY_STEP);数值大者优先,同名技能高优先级根覆盖低优先级。 */
  priority: number;
}

/** 每级优先级步长(与 ZCode PRIORITY_STEP 对齐)。 */
export const SKILL_PRIORITY_STEP = 10;
/** 技能根相对命名空间(`<base>/.genie/experiences`)。 */
const SKILL_ROOT_SEGMENTS = [".genie", "experiences"] as const;

export interface SkillRootOptions {
  /** 项目根(通常是 repoRoot())。 */
  projectRoot: string;
  /** 用户家目录;缺省 `os.homedir()`。传 "" / null = 明确不要 user 根(测试/受限环境)。 */
  home?: string | null;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 解析技能根(纯同步,零网络):顺序 user → project,每级 priority += 10。
 * 返回顺序即 priority 升序(低→高),读路径按 priority 降序取第一个命中。
 */
export function resolveSkillRoots(opts: SkillRootOptions): SkillRoot[] {
  const roots: SkillRoot[] = [];
  let priority = 0;
  const nextPriority = () => {
    priority += SKILL_PRIORITY_STEP;
    return priority;
  };

  const home = opts.home === undefined ? homedir() : opts.home;
  if (home && home.trim().length > 0) {
    const homeDir = resolve(home);
    const userRoot = join(homeDir, ...SKILL_ROOT_SEGMENTS);
    // 家目录或家目录下的技能目录不存在 = 该环境没有用户级技能 → 跳过(不 mkdir)
    if (existsSync(homeDir) && isDirectory(userRoot)) {
      roots.push({ dir: resolve(userRoot), scope: "user", priority: nextPriority() });
    }
  }

  const projectRoot = resolve(join(opts.projectRoot, ...SKILL_ROOT_SEGMENTS));
  // 项目根恰好等于用户根(项目就在家目录下且同 .genie)时不重复登记
  if (!roots.some((r) => r.dir === projectRoot)) {
    roots.push({ dir: projectRoot, scope: "project", priority: nextPriority() });
  }
  return roots;
}
