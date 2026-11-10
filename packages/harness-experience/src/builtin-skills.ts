/**
 * 内置技能(纯 prompt 方法论,从 ref 参考仓移植;每条注明出处与 license):
 * - hermes-agent(MIT): tdd/systematic-debugging/simplify-code/codebase-inspection
 * - ZCode(Linux 基线,取方法论): web-gui-tester 之 GUI 黑盒测试法
 * - ZCode dynamic-workflows(Apache 系生态) 适配为我们的 run_workflow 编写指南
 * 机制:与 experience store 的 SKILL.md 同格式;索引注入时用户同名经验**覆盖**内置
 * (ZCode「内置打底,用户/项目同名可覆盖」模式);category 固定 builtin。
 */
export interface BuiltinSkill {
  category: "builtin";
  name: string;
  description: string;
  body: string;
}

import { OFFICE_SKILLS } from "./office-skills.js";
import { DECK_SKILLS } from "./deck-skills.js";

export const BUILTIN_SKILLS: BuiltinSkill[] = [...OFFICE_SKILLS, ...DECK_SKILLS,
  {
    category: "builtin",
    name: "tdd",
    description: "测试驱动开发:红-绿-重构循环,先写失败测试再实现",
    body: `# 测试驱动开发(TDD)
出处:hermes-agent skills/software-development/test-driven-development(MIT)。

## 何时用
新功能、bug 修复(先用测试复现)、行为契约明确的任何改动。

## 流程
1. 红:写一个**会失败**的最小测试,精确描述预期行为;跑一次确认失败(失败原因=断言而非环境)。
2. 绿:写**恰好让测试通过**的最少实现——不多写一行;跑通。
3. 重构:在绿灯保护下清理;每步重构后测试必须保持绿。
4. 循环:下一个行为回到 1。

## 红线
- 不许先写实现再补测试(那是事后测试,不是 TDD)。
- 一次只红一个测试;多个红=步子太大,回退拆小。
- 重构与新增行为绝不混在同一个循环里。`,
  },
  {
    category: "builtin",
    name: "systematic-debugging",
    description: "系统化调试:先复现→二分定位→最小修复,禁 shotgun 乱试",
    body: `# 系统化调试
出处:hermes-agent skills/software-development/systematic-debugging(MIT)。

## 流程
1. 复现:构造最小可靠复现(脚本/测试);不能稳定复现就先解决复现问题。
2. 观察:收集实际行为与期望行为的**精确差异**;读日志/输出原文,不凭记忆。
3. 假设:列出 2-3 个候选根因,按可能性排序。
4. 二分定位:用最小实验逐个排除(加日志/断点/删代码);每步只验证一个假设。
5. 根因确认后写**最小修复**;用最初的最小复现验证修复,并确认无回归。

## 红线
- 禁 shotgun:不许同时改多处"试试看"——每轮改动必须可归因。
- 修复前必须能解释根因;解释不通=没找到根因。
- 修复与重构分开;顺手清理另开改动。`,
  },
  {
    category: "builtin",
    name: "simplify-code",
    description: "代码简化:删重复/收窄职责/降嵌套,行为不变",
    body: `# 代码简化
出处:hermes-agent skills/software-development/simplify-code(MIT)。

## 何时不做
- 没有测试覆盖的热路径(先补测试再简化)。
- 临时代码/即将删除的代码。

## 手法(按收益排序)
1. 删重复:相同逻辑 ≥2 处 → 提函数;仅此一处 → 不抽象。
2. 删死代码:无引用的定义直接删(git 记得住)。
3. 收窄:函数做一件事;参数超过 4 个考虑收拢为对象。
4. 降嵌套:早返回卫语句替代深 if;循环体超 30 行提取。
5. 命名:名字说清意图后,注释通常可以删。

## 验证
每步简化后测试必须全绿;行为变化=不是简化,是改动,停下。`,
  },
  {
    category: "builtin",
    name: "codebase-inspection",
    description: "陌生代码库勘察:先地图后细节,读调用方不读实现猜",
    body: `# 代码库勘察
出处:hermes-agent skills/software-development/codebase-inspection(MIT)。

## 流程
1. 先地图:架构总览(模块/依赖方向)→ 目标区域的入口点(路由/导出/CLI)。
2. 再定位:从**调用方**找线索——谁调用它、传什么、期待什么返回;不从实现内部猜。
3. 后细节:只精读当前任务相关的函数;其余按需。
4. 记录:边读边记「文件:行 → 一句话职责」,最后汇总成链路。

## 红线
- 不通读整个目录——按调用链走。
- 证据优先:结论必须落到 文件:行;推断明确标「推断」。
- 测试文件是最好的行为文档,优先读。`,
  },
  {
    category: "builtin",
    name: "gui-blackbox-testing",
    description: "GUI 黑盒测试:纯界面操作验证功能,不读服务端代码",
    body: `# GUI 黑盒测试方法论
出处:ZCode browser-use-plugin skills/web-gui-tester(方法论部分)。

## 原则
- 把被测页当黑盒:只通过「看到什么→点什么→该发生什么」验证;不依赖服务端实现。
- 每步断言三件事:目标元素可见、交互生效(状态/URL/DOM 变化)、无 JS 报错。

## 流程
1. 写用例:每条=「前置状态 + 操作序列 + 预期结果」,预期必须可观察。
2. 执行:一步步来;每步后截图或取 DOM 证据。
3. 失败处理:先分辨「功能坏了」vs「选择器过期」;后者修选择器,前者记缺陷。
4. 收尾:全部截图与结论归档;失败项给最小复现步骤。

## 红线
- 禁止为了通过测试修改产品行为(除非用例本身错了,需显式说明)。
- 断言禁止「页面没报错就算过」——必须有正向可观察信号。`,
  },
  {
    category: "builtin",
    name: "workflow-authoring",
    description: "run_workflow 编写指南:模板参数/子智能体类型/报告纪律",
    body: `# run_workflow 编写指南
出处:ZCode dynamic-workflows 技能,适配本仓 run_workflow 工具(templates: unit-tests/functional-test/algo-eval)。

## 何时用 workflow 而不是直接 spawn
- 任务是**标准化循环**(逐包跑测试/逐例判分/逐场景验证)且想确定性复跑。
- 需要把「模型自由发挥」压到最小:模板里的控制流由代码保证,模型只在指定缝里说话。

## 用模板
- unit-tests:自动发现 packages/* 逐包跑测试;失败包自动派 test-analyst 分析根因。
- functional-test:args.scenarios=[{name,run}] 逐场景执行命令+确定性验证。
- algo-eval:args.cases=[{id,input,expect}] 逐例派 judge 判分,聚合命中率。

## 纪律
- judge 的期望必须写成可判定的标准(具体输入→具体期望),禁「合理的回答」这类模糊期望。
- 场景命令必须无副作用或幂等;需要清理的在同场景里做。
- 报告只汇总事实(通过/失败/根因),不复读过程。`,
  },
];

/** 用户/项目同名经验覆盖内置(键=category/name;experience index 条目不含 builtin 同名者才保留内置)。 */
export function mergeSkillIndex(userIndex: { category: string; name: string; description: string }[]): { category: string; name: string; description: string }[] {
  const userKeys = new Set(userIndex.map((x) => `${x.category}/${x.name}`));
  const builtinNotOverridden = BUILTIN_SKILLS
    .filter((b) => !userKeys.has(`builtin/${b.name}`) && !userKeys.has(`coding/${b.name}`))
    .map((b) => ({ category: b.category, name: b.name, description: b.description }));
  return [...userIndex, ...builtinNotOverridden];
}

/** 过滤被停用的内置技能(面板技能分区开关;.genie/skills-disabled.json)。 */
export function mergeSkillIndexWith(userIndex: { category: string; name: string; description: string }[], disabledBuiltins: string[]): { category: string; name: string; description: string }[] {
  const off = new Set(disabledBuiltins);
  const userKeys = new Set(userIndex.map((x) => `${x.category}/${x.name}`));
  const builtinNotOverridden = BUILTIN_SKILLS
    .filter((b) => !off.has(b.name) && !userKeys.has(`builtin/${b.name}`) && !userKeys.has(`coding/${b.name}`))
    .map((b) => ({ category: b.category, name: b.name, description: b.description }));
  return [...userIndex, ...builtinNotOverridden];
}

export function builtinSkillBody(name: string): string | null {
  return BUILTIN_SKILLS.find((b) => b.name === name)?.body ?? null;
}
