/**
 * 本地虚拟组织自举(团队移植第三段):「demo 团队 + demo git 项目 + 一键清理」。
 * 目标:一条命令在本机得到一个**可被真实消费**的最小团队仓——4 名 demo- 前缀成员
 * (owner/dev/dev/reviewer)、三角色定义、每角色至少 1 条规则 + 1 个技能、团队元信息与文化,
 * 外加一个有 2 次真实提交的 demo git 项目(bare 镜像作 origin,projects.yaml 注册)。
 * 团队页/资产面板/项目绑定因此可以在离线环境里端到端演示,演示结束再一条命令清干净。
 * 契约( §2.1 布局 / §3 虚拟组织):
 * - 根目录 `<root>/`:team-repo.git(bare)、relay/team-clone(工作克隆)、demo-projects/<id>(真仓)
 *   与 demo-projects/<id>.git(bare origin)。
 * - 成员文件字段沿用自有 yaml-lite(扁平 key:value + 块式列表),新增 roleId(≠ 权限位 role)。
 * - roles.yaml 用块式列表自拼字符串(不走 W2 的 parseRolesYaml,互不耦合)。
 * 幂等纪律:所有内容由**纯函数**从 options 生成(不含当前时间/随机数),逐文件比对字节;
 * 内容相同即 skip,内容有差异才写,因此第二次 seed 零写入、零提交、零 push。
 * 全部入口只吃显式 options(不读 env),测试可直接指向临时目录。
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseYamlLite, stringifyYamlLite, type YamlValue } from "@lampgenie/runtime/team/yaml-lite";
import { fingerprintOf, loadOrCreateIdentity } from "@lampgenie/runtime/identity/identity";

const execFileP = promisify(execFile);

/** 提交身份:显式 -c,不依赖(也不写入)任何全局 git config。 */
const IDENT = ["-c", "user.name=demo-kai", "-c", "user.email=demo-kai@demo.genie.local"];
/** 固定注册时间:内容必须可复现,二次 seed 才能逐字节相同(幂等硬约束)。 */
const SEEDED_AT = "2026-10-29T00:00:00.000Z";
/** demo 数据统一前缀:清理按它整体识别,非 demo 数据一律不动。 */
const DEMO_PREFIX = "demo-";
const DEFAULT_TEAM_NAME = "demo-虚拟团队";
const DEFAULT_PROJECT_ID = "demo-app";

export interface VirtualTeamOptions {
  /** 团队目录根,例如 `<repo>/.genie/team`。 */
  root: string;
  /** 团队名(写入 teamai.yaml 的 team 字段),缺省 "demo-虚拟团队"。 */
  teamName?: string;
  /** demo 项目 id(目录名 / roster 键 / 仓库名),缺省 "demo-app"。 */
  projectId?: string;
}

export interface VirtualTeamReport {
  /** 本次真实写入的相对路径 / 动作(幂等重跑时为空)。 */
  created: string[];
  /** 内容已一致、跳过的相对路径 / 动作。 */
  skipped: string[];
  members: { username: string; role: string; roleId: string; fingerprint: string }[];
  project: { id: string; repoUrl: string; commits: number };
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

/** 探测式 git:失败返回 null(不用于「必须成功」的写操作)。 */
async function gitTry(args: string[], cwd: string): Promise<string | null> {
  try {
    return await git(args, cwd);
  } catch {
    return null;
  }
}

/** 指纹:sha256("demo:"+username) 前 32 hex(契约 §3,可离线复算)。 */
export function demoFingerprint(username: string): string {
  return createHash("sha256").update(`demo:${username}`).digest("hex").slice(0, 32);
}

interface TeamPaths {
  root: string;
  teamBareDir: string;
  relayDir: string;
  cloneDir: string;
  demoBase: string;
  projectWork: string;
  projectBare: string;
}

function resolvePaths(opts: VirtualTeamOptions, projectId: string): TeamPaths {
  const root = opts.root;
  const relayDir = join(root, "relay");
  const demoBase = join(root, "demo-projects");
  return {
    root,
    teamBareDir: join(root, "team-repo.git"),
    relayDir,
    cloneDir: join(relayDir, "team-clone"),
    demoBase,
    projectWork: join(demoBase, projectId),
    projectBare: join(demoBase, `${projectId}.git`),
  };
}

/** 内容写盘:字节相同 = skip;不同(含缺失)= 写入并记 created。返回是否真写入。 */
function writeIfChanged(
  file: string,
  content: string,
  rel: string,
  created: string[],
  skipped: string[],
): boolean {
  if (existsSync(file)) {
    try {
      if (readFileSync(file, "utf-8") === content) {
        skipped.push(rel);
        return false;
      }
    } catch {
      /* 读失败按「需写入」处理 */
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, "utf-8");
  created.push(rel);
  return true;
}

/** 有暂存差异才提交(空提交禁止:幂等要求零噪音)。 */
async function commitIfStaged(cwd: string, message: string): Promise<boolean> {
  const staged = ((await gitTry(["diff", "--cached", "--name-only"], cwd)) ?? "").trim();
  if (!staged) return false;
  await git([...IDENT, "commit", "-m", message], cwd);
  return true;
}

/** 本地 HEAD 与 origin/main 不一致才 push(返回是否 push)。 */
async function syncPush(cwd: string): Promise<boolean> {
  const local = ((await gitTry(["rev-parse", "HEAD"], cwd)) ?? "").trim();
  if (!local) return false;
  const remote = ((await gitTry(["rev-parse", "--verify", "origin/main"], cwd)) ?? "").trim();
  if (remote === local) return false;
  const branch = ((await gitTry(["symbolic-ref", "--short", "HEAD"], cwd)) ?? "").trim() || "main";
  await git([...IDENT, "push", "-u", "origin", branch], cwd);
  return true;
}

// ---- 内容(全部纯函数:同样的 options 必得同样的字节) ----

const MEMBER_SPECS = [
  { username: "demo-kai", displayName: "Demo Kai(负责人)", role: "owner", roleId: "owner" },
  { username: "demo-lin", displayName: "Demo Lin(开发)", role: "member", roleId: "dev" },
  { username: "demo-rui", displayName: "Demo Rui(开发)", role: "member", roleId: "dev" },
  { username: "demo-mei", displayName: "Demo Mei(评审)", role: "reviewer", roleId: "reviewer" },
] as const;

function memberYaml(spec: (typeof MEMBER_SPECS)[number], projectId: string): string {
  const fingerprint = demoFingerprint(spec.username);
  return stringifyYamlLite({
    username: spec.username,
    displayName: spec.displayName,
    fingerprint,
    keys: [fingerprint],
    role: spec.role,
    roleId: spec.roleId,
    projects: [projectId],
    invitedBy: spec.role === "owner" ? "lampgenie-harness" : "demo-kai",
    registeredAt: SEEDED_AT,
    revoked: false,
  });
}

function teamaiYaml(teamName: string, projectId: string): string {
  return [
    `team: ${teamName}`,
    `description: 本地自举的演示团队 —— 4 名 demo- 前缀成员、三角色(owner/dev/reviewer)、3 条规则、3 个技能与 1 个真实 git 项目(demo-projects/${projectId})`,
    "reviewers:",
    "  - demo-mei",
    "sharing:",
    "  rules:",
    "    enforced:",
    "      - demo-typescript",
    "",
  ].join("\n");
}

function cultureMd(teamName: string, projectId: string): string {
  return `# ${teamName} 团队文化

## 我们为什么存在

这个团队是一份**可运行的最小组织样本**:它证明团队仓里的每一样东西(成员、角色、规则、技能、
项目绑定)都能被工具真实读取并执行,而不是一份写得好看的空壳。所有成员、项目都带 \`demo-\`
前缀,就是为了能一条命令创建、一条命令抹掉,不留残渣。

## 三条文化约定

1. **小步提交,动机先行。** 一个提交只讲一件事,提交信息第一行写"为什么",第二行起写"改了什么"。
   评审者先看动机再看 diff。
2. **规则是给人看的,不是给检查器看的。** \`rules/demo/\` 下的每条规则都必须能回答"违反时会发生什么",
   答不上来的规则就该删掉。
3. **评审是协作,不是投票。** \`demo-mei\` 负责守门,但任何成员都可以在评审里说"这里我不懂",
   说"不懂"不扣分,假装懂了才扣分。

## 协作节奏

- 每个工作日结束前把进行中的工作写进提交或草稿分支,第二天从现状继续,不靠记忆。
- 阻塞超过半天,直接在团队活动流里点名 \`demo-kai\`,不憋着。
- \`${projectId}\` 是用来练手的项目:在这里犯错的成本被刻意设计为 0,所以请在这里把流程走熟。

## 我们不做什么

不做无人阅读的文档;不做无人执行的规则;不做占位符。任何写着 TODO 的东西都视为缺陷。
`;
}

function rolesYaml(): string {
  return [
    "# 角色定义(契约 §2.1 块式列表):id 用于成员 roleId 引用,skills/rules 指向团队仓内资产名。",
    "# 注意 roleId ≠ 权限位 role(owner/reviewer/member),两者分字段,不得合并。",
    "roles:",
    "  - id: owner",
    "    name: 负责人",
    "    description: 团队仓与项目绑定的最终责任人,负责发布与冲突裁决",
    "    skills: [demo-onboarding]",
    "    rules: [demo-release]",
    "  - id: dev",
    "    name: 开发",
    "    description: 实现与自测,按类型规则产出可评审的小提交",
    "    skills: [demo-code-style, demo-onboarding]",
    "    rules: [demo-typescript]",
    "  - id: reviewer",
    "    name: 评审",
    "    description: 守门与知识扩散,负责评审闭环与阻塞分级",
    "    skills: [demo-review-loop]",
    "    rules: [demo-review-checklist]",
    "",
  ].join("\n");
}

function ruleFiles(): Record<string, string> {
  return {
    "rules/demo/demo-typescript.md": `# demo-typescript —— 团队 TypeScript 硬规则

适用范围:\`demo-projects/\` 下所有 TypeScript 代码,以及团队仓里任何可执行脚本。

## 规则

1. **严格模式全开。** \`tsconfig.json\` 必须含 \`"strict": true\`;不得用 \`// @ts-ignore\` 或
   \`as any\` 绕过类型错误,确有第三方类型缺陷时用 \`// @ts-expect-error\` 并在下一行写明原因。
2. **导入写真实扩展名。** 本项目以 \`"type": "module"\` 运行,相对导入一律写 \`.js\`
   (源码是 \`.ts\`,运行时解析 \`.js\`),否则 \`node --experimental-strip-types\` 直接崩。
3. **导出收敛。** 每个模块只导出它要暴露的东西;内部工具函数不导出,避免把实现细节固化成 API。

## 违反时会发生什么

评审 \`demo-mei\` 直接打回,不进入讨论;连续两次同类问题,该成员下一次提交必须先在本规则文件里
补一条自查项再申请评审。
`,
    "rules/demo/demo-review-checklist.md": `# demo-review-checklist —— 评审清单

评审者在 \`demo-mei\` 之外的人也可以评,但**合入**需要 \`demo-mei\` 的一个 \`approve\`。

## 评什么(按顺序,任何一项不过就停在那一项)

1. **动机可读**:提交信息能否让没参与的人明白"为什么改"?
2. **范围最小**:有没有夹带无关重构、格式化噪音、被注释掉的旧代码?
3. **可回滚**:这次改动能否单独 revert 而不牵连别的东西?
4. **测试对应**:新行为是否有对应的断言?没有测试时,提交信息里是否写清了"手验步骤"?
5. **规则一致**:是否符合 \`rules/demo/demo-typescript.md\`?

## 回应时限

- 评审请求 4 小时内给第一次回应(可以是"我明天上午看",但不能没有回应)。
- 阻塞级问题(数据错误/安全问题)立刻指出,不走清单顺序。

## 分级

| 级别 | 含义 | 处理 |
|---|---|---|
| blocking | 必须改才能合 | 作者改完重新请求 |
| suggestion | 建议,可另开提交 | 作者自决 |
| question | 需求/实现有疑问 | 作者必须答复,可不改代码 |
`,
    "rules/demo/demo-release.md": `# demo-release —— 发布流程

发布人 = \`demo-kai\`(roleId=owner)。demo 项目的"发布"指把 \`demo-projects/<id>\` 的一次提交
推到它的 bare origin 并在团队活动流里说明。

## 步骤

1. **前置检查**:目标分支本地 \`git status --porcelain\` 必须为空;演示项目允许脏工作区,
   但发布前必须先把改动落成提交。
2. **跑一次真实执行**:在 \`demo-projects/<id>\` 下执行 \`npm start -- release-check\`,
   必须看到问候语输出,不能只看测试绿灯。
3. **推送**:提交信息格式 \`release: <一句话范围>\`;推送后确认
   \`git rev-parse origin/main\` 与本地 \`HEAD\` 相同。
4. **告知**:在团队活动流贴提交哈希与验证命令输出。
5. **回滚**:出错就 \`git revert <hash>\` 生成反向提交,**禁止** 强推或 reset 已推送的历史。

## 禁止

- 禁止在工作时间之外(团队无值班约定时)单独发布。
- 禁止跳过第 2 步——"看起来没问题"不算验证。
`,
  };
}

function skillFiles(): Record<string, string> {
  return {
    "skills/demo/demo-onboarding/SKILL.md": `---
name: demo-onboarding
description: "新成员 30 分钟内读完团队文化与规则,并在本地跑通 demo 项目的一次真实提交"
---

# demo-onboarding

## 何时用

- 刚加入 demo 团队,还没读过 \`culture.md\`。
- 需要在本地把 demo 项目跑起来给团队演示。

## 步骤

1. 克隆团队仓,依次读 \`culture.md\`、\`teamai.yaml\`、\`roster/roles.yaml\`,确认自己的 \`roleId\`。
2. 读所属角色在 \`rules/demo/\` 下的规则,把硬规则抄进编辑器配置(不是抄进脑子)。
3. 克隆 demo 项目仓,执行 \`npm start -- <你的名字>\`,看到问候语即跑通。
4. 提交一次 \`docs/\` 改动:一个主题、提交信息写清动机,再按评审清单自查后请求评审。

## 验收标准

- demo 项目在本地能输出问候语;
- 第一次提交只有一个主题,提交信息能让没参与的人看懂动机;
- 能说出自己 roleId 对应的规则文件名。
`,
    "skills/demo/demo-code-style/SKILL.md": `---
name: demo-code-style
description: "demo 团队 TypeScript 写法:纯函数优先、显式依赖、错误可见,附正反例"
---

# demo-code-style

## 何时用

准备给 \`demo-projects/\` 加新模块,或者评审里看到"这函数怎么这么难测"的时候。

## 四条写法

1. **纯函数优先。** 输入输出只由参数决定,时间/随机/env 从外面传进来。这样测试不用 mock 时间。
   反例:\`function stamp() { return new Date().toISOString() }\`
   正例:\`function stamp(now: Date) { return now.toISOString() }\`
2. **依赖显式。** 需要路径就传 path,需要 git 就传 cwd;不要在函数体里读 \`process.env\`。
3. **错误可见。** 失败要么上抛带上下文的 \`Error\`,要么返回明确的结果结构;禁止 \`catch {}\` 静默吞。
4. **命名说清"做什么"。** \`seedDemoProject\` 好过 \`handle2\`;\`writeIfChanged\` 已经把幂等写进名字里了。

## 自查三个问题

- 这个函数能在测试里被调用 10 次而结果一致吗?
- 出错时调用方能区分"没变化"和"失败了"吗?
- 删掉这个函数,谁会发现?答不上来就是死代码。
`,
    "skills/demo/demo-review-loop/SKILL.md": `---
name: demo-review-loop
description: "评审闭环:谁评审、评什么、多久回应、阻塞分级与作者侧响应模板"
---

# demo-review-loop

## 何时用

你要提交评审,或者别人请你评审。

## 作者侧

提交评审前先自问:动机写清了吗?范围最小吗?有测试或手验步骤吗?三个都答"是"再点请求评审。
请求里附一句期望:"请重点看 X,我担心 Y" —— 让评审者知道该往哪看。

## 评审者侧

按 \`rules/demo/demo-review-checklist.md\` 的五项顺序看,任何一项不过就停在那一项,不要一次抛 20 条。
每条意见标注级别(blocking / suggestion / question),作者据此决定改不改。

## 回应时限与升级

- 4 小时内第一次回应,哪怕是"我明天上午看"。
- 24 小时无回应,作者在团队活动流点名 \`demo-mei\`,并把提交标记为"等待评审"而不是自己合入。

## 闭环标准

一次评审算闭环 = 所有 blocking 已解决 + 至少一条 suggestion 被明确处理(采纳或说明不采纳原因)。
评审记录不写"LGTM"就完事——写清你实际验证了什么。
`,
  };
}

function docsFiles(teamName: string, projectId: string): Record<string, string> {
  return {
    "docs/demo-team-guide.md": `# ${teamName} 使用指南(演示用)

本文件由 \`seedVirtualTeam()\` 生成,用于演示团队仓 \`docs/\` 目录与 \`docs/demo*\` 清理规则。

## 一次完整的演示流程

1. \`seedVirtualTeam({ root })\` —— 建 bare 团队仓、工作克隆、4 名成员、三角色、3 条规则、3 个技能,
   并在 \`demo-projects/${projectId}\` 建一个有 2 次真实提交的 git 项目,bare 镜像作 origin。
2. 起 gateway/relay,团队页应看到 4 名成员与 1 个项目团队。
3. \`virtualTeamStatus({ root })\` —— 确认 \`present: true\`、4 名成员、当前项目 id。
4. \`cleanupVirtualTeam({ root })\` —— 删 demo- 成员与全部 demo 资产,提交并推送团队仓;
   非 demo 数据(例如你自己注册的成员)原样保留。

## 为什么时间戳写死

成员 \`registeredAt\` 使用固定常量 \`${SEEDED_AT}\`,这样重复 seed 的内容逐字节相同,
二次执行零提交。"演示数据"不需要真实时间,需要的是可复现。
`,
  };
}

function demoProjectFiles(projectId: string): Record<string, string> {
  return {
    "README.md": `# ${projectId}

demo 虚拟组织自举出来的最小可运行项目:一个 TypeScript 纯函数 + 一个入口脚本。

## 跑起来

\`\`\`bash
node --experimental-strip-types src/main.ts 世界
\`\`\`

## 它证明什么

- \`demo-projects/${projectId}.git\` 是可以真实 push/clone 的 bare 仓(团队项目绑定的 origin);
- 团队仓 \`roster/projects.yaml\` 里的 \`${projectId}.repo\` 指向它,团队页因此能显示"项目有成员";
- 至少两次真实提交,\`git log --oneline\` 可读,幂等重跑不会产生空提交。
`,
    "package.json": `{
  "name": "${projectId}",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node --experimental-strip-types src/main.ts"
  }
}
`,
    ".gitignore": `node_modules/
dist/
*.log
`,
    "src/main.ts": `/**
 * ${projectId} 入口:虚拟组织演示项目的最小实现(团队仓第二次提交的内容)。
 * 全部逻辑是纯函数 + 显式参数:没有任何 env / 时间 / 随机依赖,便于演示与自查。
 */

export interface GreetingOptions {
  /** 被问候者;空白串回退 "world"。 */
  name: string;
  /** 语言,缺省中文。 */
  locale?: "zh" | "en";
}

/** 生成问候语(纯函数)。 */
export function greet(opts: GreetingOptions): string {
  const name = opts.name.trim() || "world";
  return opts.locale === "en" ? \`Hello, \${name}!\` : \`你好,\${name}!\`;
}

const target = process.argv[2] ?? "demo";
process.stdout.write(\`\${greet({ name: target })}\\n\`);
`,
  };
}

// ---- seed ----

/** demo 项目仓:bare origin + 真仓 + ≥2 次真实提交(幂等:内容相同零提交)。 */
async function seedDemoProject(opts: {
  paths: TeamPaths;
  projectId: string;
  created: string[];
  skipped: string[];
}): Promise<number> {
  const { paths: p, projectId, created, skipped } = opts;
  const relWork = `demo-projects/${projectId}`;
  const relBare = `demo-projects/${projectId}.git`;

  // 1) bare origin
  if (!existsSync(join(p.projectBare, "HEAD"))) {
    mkdirSync(p.projectBare, { recursive: true });
    try {
      await git(["init", "--bare", "-b", "main", p.projectBare], p.demoBase);
    } catch {
      // 老 git 无 -b
      await git(["init", "--bare", p.projectBare], p.demoBase);
      await gitTry(["symbolic-ref", "HEAD", "refs/heads/main"], p.projectBare);
    }
    created.push(relBare);
  } else {
    skipped.push(relBare);
  }

  // 2) 工作仓
  if (!existsSync(join(p.projectWork, ".git"))) {
    mkdirSync(p.projectWork, { recursive: true });
    try {
      await git(["init", "-b", "main", p.projectWork], p.demoBase);
    } catch {
      await git(["init", p.projectWork], p.demoBase);
      await gitTry(["symbolic-ref", "HEAD", "refs/heads/main"], p.projectWork);
    }
    created.push(relWork);
  } else {
    skipped.push(relWork);
  }

  // 3) 文件内容(逐字节比对)
  for (const [rel, content] of Object.entries(demoProjectFiles(projectId))) {
    writeIfChanged(join(p.projectWork, rel), content, `${relWork}/${rel}`, created, skipped);
  }

  // 4) origin 指向 bare
  const origin = ((await gitTry(["remote", "get-url", "origin"], p.projectWork)) ?? "").trim();
  if (!origin) {
    await git(["remote", "add", "origin", p.projectBare], p.projectWork);
    created.push(`${relWork}:remote-add`);
  } else if (origin !== p.projectBare) {
    await git(["remote", "set-url", "origin", p.projectBare], p.projectWork);
    created.push(`${relWork}:remote-set`);
  }

  // 5) 提交:首次建仓分两次真实提交(骨架 + 入口);之后仅内容变化时补一次
  const headCount = Number((((await gitTry(["rev-list", "--count", "HEAD"], p.projectWork)) ?? "0").trim()) || "0");
  let committed = false;
  if (headCount === 0) {
    await git(["add", "--", "README.md", ".gitignore", "package.json"], p.projectWork);
    committed = (await commitIfStaged(p.projectWork, "chore: bootstrap demo 项目骨架(README/package/.gitignore)")) || committed;
    await git(["add", "-A"], p.projectWork);
    committed = (await commitIfStaged(p.projectWork, "feat: 加入 greet 入口(src/main.ts)")) || committed;
    if (committed) created.push(`${relWork}:commits`);
  } else {
    const dirty = ((await gitTry(["status", "--porcelain"], p.projectWork)) ?? "").trim().length > 0;
    if (dirty) {
      await git(["add", "-A"], p.projectWork);
      if (await commitIfStaged(p.projectWork, "chore: 同步 demo 项目文件内容")) {
        committed = true;
        created.push(`${relWork}:commits`);
      }
    }
    if (!committed) skipped.push(`${relWork}:commits`);
  }

  // 6) push(bare origin 落后才推)
  if (await syncPush(p.projectWork)) created.push(`${relWork}:push`);
  else skipped.push(`${relWork}:push`);

  return Number((((await gitTry(["rev-list", "--count", "HEAD"], p.projectWork)) ?? "0").trim()) || "0");
}

/**
 * 自举虚拟组织:bare 团队仓 → 工作克隆 → demo 项目(git) → 团队资产落盘 → 提交并推送。
 * 幂等:第二次起 created 为空(内容逐字节相同),团队仓零提交、demo 仓零空提交。
 */
export async function seedVirtualTeam(opts: VirtualTeamOptions): Promise<VirtualTeamReport> {
  const projectId = opts.projectId?.trim() || DEFAULT_PROJECT_ID;
  const teamName = opts.teamName?.trim() || DEFAULT_TEAM_NAME;
  const p = resolvePaths(opts, projectId);
  const created: string[] = [];
  const skipped: string[] = [];

  mkdirSync(p.root, { recursive: true });

  // 1) bare 团队仓
  if (!existsSync(join(p.teamBareDir, "HEAD"))) {
    mkdirSync(p.teamBareDir, { recursive: true });
    try {
      await git(["init", "--bare", "-b", "main", p.teamBareDir], p.root);
    } catch {
      await git(["init", "--bare", p.teamBareDir], p.root);
      await gitTry(["symbolic-ref", "HEAD", "refs/heads/main"], p.teamBareDir);
    }
    created.push("team-repo.git");
  } else {
    skipped.push("team-repo.git");
  }

  // 2) 工作克隆(空 bare 也合法:clone 后首次提交即建 main)
  if ((await gitTry(["rev-parse", "--git-dir"], p.cloneDir)) === null) {
    mkdirSync(p.relayDir, { recursive: true });
    await git(["clone", p.teamBareDir, p.cloneDir], p.relayDir);
    created.push("relay/team-clone");
  } else {
    skipped.push("relay/team-clone");
  }

  // 3) demo git 项目(真仓 + bare origin + 真实提交)
  const commits = await seedDemoProject({ paths: p, projectId, created, skipped });

  // 4) 团队仓内容(全部在克隆目录里生成)
  const c = p.cloneDir;
  writeIfChanged(join(c, "teamai.yaml"), teamaiYaml(teamName, projectId), "teamai.yaml", created, skipped);
  writeIfChanged(join(c, "culture.md"), cultureMd(teamName, projectId), "culture.md", created, skipped);
  writeIfChanged(join(c, "roster", "roles.yaml"), rolesYaml(), "roster/roles.yaml", created, skipped);
  for (const spec of MEMBER_SPECS) {
    writeIfChanged(
      join(c, "roster", "members", `${spec.username}.yaml`),
      memberYaml(spec, projectId),
      `roster/members/${spec.username}.yaml`,
      created,
      skipped);
  }
  for (const [rel, content] of Object.entries(ruleFiles())) writeIfChanged(join(c, rel), content, rel, created, skipped);
  for (const [rel, content] of Object.entries(skillFiles())) writeIfChanged(join(c, rel), content, rel, created, skipped);
  for (const [rel, content] of Object.entries(docsFiles(teamName, projectId))) {
    writeIfChanged(join(c, rel), content, rel, created, skipped);
  }

  // 5) roster/projects.yaml(扁平 <id>.type/.repo/.owner;保留非 demo 既有键)
  const projectsFile = join(c, "roster", "projects.yaml");
  let flat: Record<string, YamlValue> = {};
  if (existsSync(projectsFile)) {
    try {
      flat = parseYamlLite(readFileSync(projectsFile, "utf-8"));
    } catch {
      /* 坏文件按空表重写本键 */
    }
  }
  flat[`${projectId}.type`] = "team";
  flat[`${projectId}.repo`] = p.projectBare;
  flat[`${projectId}.owner`] = "demo-kai";
  writeIfChanged(projectsFile, stringifyYamlLite(flat), "roster/projects.yaml", created, skipped);

  // 6) 提交 + 推送团队仓(无差异零提交)
  if (created.length > 0 && (await git(["status", "--porcelain"], c)).trim().length > 0) {
    await git(["add", "-A"], c);
    const committed = await commitIfStaged(
      c,
      `chore(demo-team): 自举虚拟组织(${MEMBER_SPECS.length} 名成员 / 3 角色 / 3 规则 / 3 技能 / 1 demo 项目)`,
    );
    if (committed) created.push("team-repo:commit");
    if (await syncPush(c)) created.push("team-repo:push");
  } else {
    skipped.push("team-repo:commit");
    skipped.push("team-repo:push");
  }

  return {
    created,
    skipped,
    members: MEMBER_SPECS.map((s) => ({
      username: s.username,
      role: s.role,
      roleId: s.roleId,
      fingerprint: demoFingerprint(s.username),
    })),
    project: { id: projectId, repoUrl: p.projectBare, commits },
  };
}

// ---- 真身份入册(把 seed 的「展示态」成员换成能被 relay 验签的真成员) ----

export interface EnrollMembersOptions {
  /** 团队目录根(seed 的 root,例如 `<repo>/.genie/team`)。 */
  root: string;
  /** 要入册的成员用户名;缺省=roster/members 里现有 `demo-` 前缀成员。 */
  usernames?: string[];
  /** 身份目录根;每个成员用 `<identityDir>/<username>` 存一套 ed25519 密钥。缺省 `<root>/identities`。 */
  identityDir?: string;
}

export interface EnrollMembersReport {
  members: { username: string; fingerprint: string; role: string; roleId: string; changed: boolean }[];
  /** 本次真正改写并提交的成员(幂等重跑为空)。 */
  changed: string[];
}

/**
 * yaml-lite 是单行受控子集(禁止多行字符串),而 PEM 本体含换行。落盘时把换行转义成字面
 * `\n` 两个字符(仍是单行 key:value),读回时反转义还原**逐字节相同**的 PEM——这样
 * `fingerprintOf(还原后的 PEM)` 能与成员 yaml 里的 fingerprint 对上,幂等判定才成立。
 */
function encodePem(pem: string): string {
  return pem.replace(/\r\n/g, "\n").replace(/\n/g, "\\n");
}

function decodePem(encoded: string): string {
  return encoded.replace(/\\n/g, "\n");
}

/**
 * 把 demo 成员换成真 ed25519 身份(sole production-code change of 虚拟组织协作流):
 * 保留 displayName/role/roleId/projects/invitedBy/registeredAt/revoked,fingerprint 改成公钥派生指纹,
 * keys 登记该指纹,新增 publicKey=PEM。**不改 seedVirtualTeam 的任何行为**(它仍写 demo 指纹)。
 * 幂等:yaml 里的 publicKey 已能派生出与本地身份一致的指纹 → 跳过(不覆盖、不换钥匙),
 * 因此二次调用不会把已入册成员从 roster.keys 里踢出去。
 */
export async function enrollRealMembers(opts: EnrollMembersOptions): Promise<EnrollMembersReport> {
  const p = resolvePaths({ root: opts.root }, DEFAULT_PROJECT_ID);
  const membersDir = join(p.cloneDir, "roster", "members");
  if (!existsSync(membersDir)) {
    throw new Error(`enrollRealMembers: 团队工作克隆缺失(${membersDir}),先跑 seedVirtualTeam`);
  }
  const identityDir = opts.identityDir ?? join(opts.root, "identities");

  // 以 origin/main 为基线(只做快进,不改写历史):relay/他人可能已推过提交。
  await gitTry(["fetch", "origin"], p.cloneDir);
  const dirty = ((await gitTry(["status", "--porcelain"], p.cloneDir)) ?? "").trim();
  const local = ((await gitTry(["rev-parse", "HEAD"], p.cloneDir)) ?? "").trim();
  const remote = ((await gitTry(["rev-parse", "--verify", "origin/main"], p.cloneDir)) ?? "").trim();
  if (remote && local && remote !== local && dirty.length === 0) {
    await gitTry(["merge", "--ff-only", "origin/main"], p.cloneDir);
  }

  const usernames =
    opts.usernames ??
    readdirSync(membersDir)
      .filter((f) => f.startsWith(DEMO_PREFIX) && f.endsWith(".yaml"))
      .map((f) => f.slice(0, -".yaml".length))
      .sort();

  const report: EnrollMembersReport = { members: [], changed: [] };

  for (const username of usernames) {
    const file = join(membersDir, `${username}.yaml`);
    const identity = loadOrCreateIdentity(join(identityDir, username));
    let raw: Record<string, YamlValue> = {};
    if (existsSync(file)) {
      try {
        raw = parseYamlLite(readFileSync(file, "utf-8"));
      } catch {
        /* 手编坏 yaml 按空表重建(只保留能解析出来的字段) */
      }
    }
    const storedPub = typeof raw.publicKey === "string" ? decodePem(raw.publicKey) : "";
    const storedFp = typeof raw.fingerprint === "string" ? raw.fingerprint : "";
    const alreadyEnrolled =
      storedPub.length > 0 && fingerprintOf(storedPub) === identity.fingerprint && storedFp === identity.fingerprint;

    const entry = {
      username,
      fingerprint: identity.fingerprint,
      role: String(raw.role ?? (username === "demo-mei" ? "reviewer" : username === "demo-kai" ? "owner" : "member")),
      roleId: String(raw.roleId ?? ""),
      changed: !alreadyEnrolled,
    };
    report.members.push(entry);
    if (alreadyEnrolled) continue;

    const next: Record<string, YamlValue> = {
      username: String(raw.username ?? username),
      displayName: String(raw.displayName ?? username),
      fingerprint: identity.fingerprint,
      keys: [identity.fingerprint],
      publicKey: encodePem(identity.publicKeyPem),
      role: entry.role,
    };
    if (raw.roleId !== undefined) next.roleId = String(raw.roleId);
    next.projects = Array.isArray(raw.projects) ? raw.projects.map(String) : [];
    if (raw.invitedBy !== undefined) next.invitedBy = String(raw.invitedBy);
    next.registeredAt = String(raw.registeredAt ?? SEEDED_AT);
    next.revoked = raw.revoked === true;
    writeFileSync(file, stringifyYamlLite(next), "utf-8");
    report.changed.push(username);
  }

  // 有变化才提交推送(无变化=零提交,保持幂等)。
  if (report.changed.length > 0) {
    await git(["add", "-A"], p.cloneDir);
    const staged = ((await gitTry(["diff", "--cached", "--name-only"], p.cloneDir)) ?? "").trim();
    if (staged) {
      await git([...IDENT, "commit", "-m", `roster: 演示成员换真 ed25519 身份(${report.changed.join(", ")})`], p.cloneDir);
      await syncPush(p.cloneDir);
    }
  }
  return report;
}

// ---- 清理 ----

/**
 * 一键清理:删 demo- 前缀成员、skills/demo、rules/demo、docs/demo*、projects.yaml 里指向
 * demo-projects 的绑定、整个 demo-projects/(含 bare origin),提交并推送团队仓。
 * 幂等:无 demo 数据时 removed 为空且不抛错;非 demo 数据一个都不动。
 */
export async function cleanupVirtualTeam(opts: VirtualTeamOptions): Promise<{ removed: string[] }> {
  const projectId = opts.projectId?.trim() || DEFAULT_PROJECT_ID;
  const p = resolvePaths(opts, projectId);
  const removed: string[] = [];

  if (existsSync(p.cloneDir)) {
    const membersDir = join(p.cloneDir, "roster", "members");
    if (existsSync(membersDir)) {
      for (const f of readdirSync(membersDir).sort()) {
        if (f.startsWith(DEMO_PREFIX) && f.endsWith(".yaml")) {
          rmSync(join(membersDir, f), { force: true });
          removed.push(`roster/members/${f}`);
        }
      }
    }
    for (const dir of ["skills/demo", "rules/demo"]) {
      const abs = join(p.cloneDir, dir);
      if (existsSync(abs)) {
        rmSync(abs, { recursive: true, force: true });
        removed.push(dir);
      }
    }
    const docsDir = join(p.cloneDir, "docs");
    if (existsSync(docsDir)) {
      for (const f of readdirSync(docsDir).sort()) {
        if (f.startsWith("demo")) {
          rmSync(join(docsDir, f), { recursive: true, force: true });
          removed.push(`docs/${f}`);
        }
      }
    }
    // demo 项目绑定(repo 指向 <root>/demo-projects/ 的键=纯 demo 数据)
    const projectsFile = join(p.cloneDir, "roster", "projects.yaml");
    if (existsSync(projectsFile)) {
      try {
        const flat = parseYamlLite(readFileSync(projectsFile, "utf-8"));
        const ids = new Set<string>();
        for (const [k, v] of Object.entries(flat)) {
          const m = /^(.+)\.repo$/.exec(k);
          if (m && String(v).startsWith(p.demoBase)) ids.add(m[1]!);
        }
        if (ids.size > 0) {
          for (const id of ids) for (const suffix of ["type", "repo", "owner"]) delete flat[`${id}.${suffix}`];
          writeFileSync(projectsFile, stringifyYamlLite(flat), "utf-8");
          for (const id of [...ids].sort()) removed.push(`roster/projects.yaml:${id}`);
        }
      } catch {
        /* 坏 projects.yaml 不 clobber */
      }
    }
    if (removed.length > 0) {
      await git(["add", "-A"], p.cloneDir);
      const committed = await commitIfStaged(p.cloneDir, "chore(demo-team): 清理虚拟组织 demo 数据");
      if (committed) removed.push("team-repo:commit");
      if (await syncPush(p.cloneDir)) removed.push("team-repo:push");
    }
  }

  if (existsSync(p.demoBase)) {
    rmSync(p.demoBase, { recursive: true, force: true });
    removed.push("demo-projects");
  }

  return { removed };
}

// ---- 状态(只读) ----

/** 只读状态:present = 工作克隆在;members = 成员文件名;project = 当前注册的 demo 项目 id。 */
export async function virtualTeamStatus(
  opts: VirtualTeamOptions): Promise<{ present: boolean; members: string[]; project: string | null }> {
  const projectId = opts.projectId?.trim() || DEFAULT_PROJECT_ID;
  const p = resolvePaths(opts, projectId);
  if (!existsSync(p.cloneDir)) return { present: false, members: [], project: null };

  const membersDir = join(p.cloneDir, "roster", "members");
  const members = existsSync(membersDir)
    ? readdirSync(membersDir)
        .filter((f) => f.endsWith(".yaml"))
        .map((f) => f.slice(0, -".yaml".length))
        .sort()
    : [];

  let project: string | null = null;
  const projectsFile = join(p.cloneDir, "roster", "projects.yaml");
  if (existsSync(projectsFile)) {
    try {
      const flat = parseYamlLite(readFileSync(projectsFile, "utf-8"));
      const ids = Object.keys(flat)
        .filter((k) => k.endsWith(".type"))
        .map((k) => k.slice(0, -".type".length));
      project = ids.includes(projectId) ? projectId : (ids.sort()[0] ?? null);
    } catch {
      project = null;
    }
  }
  return { present: true, members, project };
}
