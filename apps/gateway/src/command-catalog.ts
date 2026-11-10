/**
 * 内置命令目录(2026-10,对齐 ZCode「内置命令目录 = 唯一权威」语义)。
 *
 * 真源说明:
 * - 名字与中文描述照抄 apps/gateway/src/panel.ts 的 `SLASH_COMMANDS`(面板 UI 注册表);
 *   服务端这份是权威目录,面板/CLI/WS 客户端都以本表为准(catalog 走 commands.catalog)。
 * - 面板数组实有 24 条;`teamai` 是 slashTypedSubmit 里真实分派的分支(c.value === "teamai")
 *   但数组漏项,这里补进目录 → 面板现有面共 25 条。
 * - 再补 ZCode 有而本仓库缺的:help / skill / model / new(别名 clear)/ resume(必做 5 条),
 *   以及 rewind / fork / mode(r3;面板均已接到既有通道——checkpoint 流/session.fork 两段式/cfg.set)。
 *   其余(mcp / plugins / login / logout)留 TODO:本仓库相应能力尚未接到命令面
 *   (login/logout=ZCode 账号体系专属,无账号不做),等落地后再入目录,避免「目录里有、执行不了」的假指令。
 *
 * 冲突语义:RESERVED_COMMAND_NAMES 里的名字自定义命令不得覆盖——CommandStore.list() 命中同名
 * 只给 warning 诊断并从自定义列表剔除(内置优先,见 commands-store.ts)。
 */

export type BuiltinCommandSource = "builtin";

export interface BuiltinCommand {
  name: string;
  description: string;
  inputHint?: string;
  source: BuiltinCommandSource;
  /** 用法行(/goal <目标>|clear|pause|resume 形态);help 列表展示用。 */
  usage?: string;
  /** 展开说明(多行,help <name> 展示用)。 */
  details?: string[];
}

export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  // ---- 面板 SLASH_COMMANDS 现役(照抄 panel.ts:17872-17901 的名字与 desc) ----
  { name: "newtask", source: "builtin", description: "新建任务(草稿)", usage: "/newtask" },
  { name: "sense", source: "builtin", description: "代码档案(架构图/模块/演进;原代码洞察合一)", usage: "/sense" },
  { name: "review", source: "builtin", description: "提交代码审查任务(四维度 findings)", inputHint: "补充审查重点(可空),Enter 发送…", usage: "/review [审查重点]" },
  { name: "test", source: "builtin", description: "提交标准化测试任务(workflow 编排)", inputHint: "补充测试范围(可空),Enter 发送…", usage: "/test [测试范围]" },
  { name: "wf", source: "builtin", description: "自动化工作流", usage: "/wf" },
  { name: "exp", source: "builtin", description: "经验库(Hermes 沉淀)", usage: "/exp" },
  { name: "addproject", source: "builtin", description: "添加项目(本地路径)", usage: "/addproject" },
  { name: "sys", source: "builtin", description: "系统设置", usage: "/sys" },
  { name: "search", source: "builtin", description: "搜索任务(命令中心)", usage: "/search" },
  { name: "side", source: "builtin", description: "侧聊管家(焦点移到右侧聊天窗,发往 super agent)", usage: "/side" },
  { name: "light", source: "builtin", description: "切换浅色主题(暖纸)", usage: "/light" },
  { name: "dark", source: "builtin", description: "切换深色主题(鎏金夜,默认)", usage: "/dark" },
  { name: "theme", source: "builtin", description: "循环切换主题(鎏金夜/暖纸/砂陶松影/流光玻璃/橄榄赤陶/蓝调梅影/薄墨/跟随系统)", usage: "/theme" },
  { name: "theme-sand", source: "builtin", description: "主题 → 砂陶松影(暖砂/陶土/松绿)", usage: "/theme-sand" },
  { name: "theme-glass", source: "builtin", description: "主题 → 流光玻璃(玻璃拟态)", usage: "/theme-glass" },
  { name: "theme-olive", source: "builtin", description: "主题 → 橄榄赤陶(灰紫/赤陶/橄榄)", usage: "/theme-olive" },
  { name: "theme-plum", source: "builtin", description: "主题 → 蓝调梅影(奶油/梅紫/板岩蓝)", usage: "/theme-plum" },
  { name: "theme-ink", source: "builtin", description: "主题 → 薄墨(极简高对比)", usage: "/theme-ink" },
  { name: "goal", source: "builtin", description: "查看/设置会话目标(/goal <目标>|clear|pause|resume)", inputHint: "目标内容(或 clear / pause / replace <新目标>)…", usage: "/goal [<目标>|clear|pause|resume]", details: ["无参=查看当前目标", "clear=清除;pause=暂停保留目标;resume=恢复"] },
  { name: "workflow", source: "builtin", description: "设计并启动工作流(/workflow <要完成的事>;无参开自动化视图)", inputHint: "要完成的事(空=打开自动化视图)…", usage: "/workflow [要完成的事]" },
  { name: "compact", source: "builtin", description: "压缩当前会话(/compact [摘要指示])", inputHint: "压缩指示(可空)…", usage: "/compact [摘要指示]" },
  { name: "init", source: "builtin", description: "创建/更新工作区 AGENTS.md(/init [补充说明])", inputHint: "补充说明(可空)…", usage: "/init [补充说明]" },
  { name: "plan", source: "builtin", description: "切换 Plan 规划模式(/plan [顺带派的任务])", inputHint: "顺带要派的任务(空=仅切 Plan 模式)…", usage: "/plan [任务]" },
  { name: "team", source: "builtin", description: "团队(/team [invite <名>|sync|share [心得>|status])", inputHint: "invite <名> | sync | share [名] | status…", usage: "/team [invite <名>|sync|share [名]|status]" },
  // teamai:slashTypedSubmit 有真实分派分支(c.value === "teamai"),但 SLASH_COMMANDS 数组漏项;补进权威目录。
  { name: "teamai", source: "builtin", description: "团队经验仓(拉取/推送共享资产)", inputHint: "pull | push | share <名>…", usage: "/teamai [pull|push|share <名>]" },

  // ---- ZCode 有而本仓库缺的(必做 5 条) ----
  {
    name: "help",
    source: "builtin",
    description: "显示命令清单与用法(/help [命令名])",
    inputHint: "命令名(可空=全量清单)…",
    usage: "/help [命令名]",
    details: ["无参=列出全部内置与自定义命令", "/help <命令名>=该命令的用法与说明"],
  },
  {
    name: "skill",
    source: "builtin",
    description: "查看/调用技能(/skill [list|<技能名>])",
    inputHint: "list 或技能名…",
    usage: "/skill [list|<技能名>]",
    details: ["list=技能索引(分类/名称/描述)", "/skill <名>=按名调用该技能"],
  },
  {
    name: "model",
    source: "builtin",
    description: "查看/切换当前会话主模型(/model [模型名])",
    inputHint: "模型名(空=列出可用模型)…",
    usage: "/model [模型名]",
    details: ["无参=列出当前 provider 的可用模型", "/model <名>=为当前会话覆盖主模型"],
  },
  {
    name: "new",
    source: "builtin",
    description: "新建会话(别名 clear:清空当前会话上下文)",
    usage: "/new",
    details: ["等价于 /clear;与 /newtask(新建任务草稿)不同,本命令开一个新会话"],
  },
  {
    name: "resume",
    source: "builtin",
    description: "恢复历史会话(/resume [会话 id|最近])",
    inputHint: "会话 id(空=最近会话)…",
    usage: "/resume [会话 id|最近]",
    details: ["无参=列出最近会话供选择", "/resume <id>=切到该会话继续"],
  },

  // ---- r3:再补 ZCode 有而本仓库缺的 rewind / fork / mode(全部复用面板既有通道) ----
  {
    name: "rewind",
    source: "builtin",
    description: "回滚工作区到此任务前(/rewind [taskId];复用快照预览+确认流)",
    inputHint: "[taskId](空=最近一个任务)…",
    usage: "/rewind [taskId]",
    details: ["无参=对最近一个任务发 checkpoint.preview(预览+确认后回滚)", "/rewind <taskId>=对该任务回滚", "快照后新增的未跟踪文件保留"],
  },
  {
    name: "fork",
    source: "builtin",
    description: "分叉会话并重派指令(/fork [sessionId];继承原会话上下文)",
    inputHint: "[sessionId](空=当前会话)…",
    usage: "/fork [sessionId]",
    details: ["无参=分叉当前会话(取该会话最近一条任务的指令重派)", "/fork <sessionId>=分叉指定会话", "两段式:session.fork 继承上下文 → 新会话派指令"],
  },
  {
    name: "mode",
    source: "builtin",
    description: "查看/切换权限模式(/mode <ask|auto|workspace|readonly|plan>)",
    inputHint: "ask|auto|workspace|readonly|plan(空=查看当前)…",
    usage: "/mode [ask|auto|workspace|readonly|plan]",
    details: ["无参=toast 当前权限模式", "/mode <值>=cfg.set permissions.mode 热生效(与权限 pill 同通道)", "workspace=工作区内:只读写当前项目目录内的文件,项目外路径被拒;命令/终端执行同样限在项目目录内", "plan 与会话 goal 互斥:服务端校验如实透传错误回包"],
  },

  // TODO(未入目录,等能力落地):mcp / plugins / login / logout(login/logout=ZCode 账号体系专属,本仓库无账号不做)
];

/** 内置命令名保留集:自定义命令不得同名覆盖(命中即 warning 诊断 + 从自定义列表剔除)。 */
export const RESERVED_COMMAND_NAMES: Set<string> = new Set(BUILTIN_COMMANDS.map((c) => c.name));

/** 按名取内置命令(catalog 查询;名字大小写不敏感)。 */
export function findBuiltinCommand(name: string): BuiltinCommand | undefined {
  const n = String(name ?? "").trim().replace(/^\/+/, "").toLowerCase();
  if (!n) return undefined;
  return BUILTIN_COMMANDS.find((c) => c.name === n);
}
