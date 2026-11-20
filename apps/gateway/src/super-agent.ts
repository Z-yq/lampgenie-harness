/**
 * super agent 指挥台(更名 audio/companion agent → super agent;
 * 起旧 companion 链整体替换为指挥台后端链):
 * - 会话:sessionId 固定 "super"(聊天为主工作区;journal 复用,零新存储;旧 super: 日卷与
 * companion: 前缀 journal 只读不迁移,app.ts history 过滤与 journal kind 双认都靠它们);
 * - system 每轮重组:SOUL+记忆块(soul 双库,super agent 专有)+用户偏好摘要+ 全局状态摘要
 *   (工作区/最近任务/活跃 todo)+ 近期系统注入(通知/转接)+ 调度纪律;
 * - 工具:调度六件 + 任务全生命周期件(task_status/cancel/resend/result/resume + recall_tasks)
 * + relay_answer(ask_user 双通道答复回交)+ 系统管理七件(sys_status/sys_config/sys_provider/
 * sys_logs/sys_restart/sys_restart_queue/sys_rsi,/1560/1561/1584 全系统管理者;密钥值通道刻意不注入——Key 永不进对话/journal);
 * - 动手永远派给 coding 轨(唯一不动手边界);其余操作(取消/增删工作区/改派)直接执行+事后说明;
 * - SuperAgentChannel:ask_user 转接(coding agent 提问经指挥台转述)+ 任务状态播报
 *   (journal/广播 super.notice;interrupted/blocked/failed 额外发 super.inbox.changed);
 * - 无音频链路:语音输入走 voice.transcribe(ASR→文本),回复只有文本,无 audioB64 回传。
 */
import { join } from "node:path";
import { readFileSync, statSync } from "node:fs";
import type { Journal, Task } from "@lampgenie/core";
import type { SuperInboxItem } from "@lampgenie/protocol";
import { AgentLoop, type LlmProvider, type Tool } from "@lampgenie/runtime/agent/loop";
import { MemoryStore, buildSoulPreamble } from "@lampgenie/runtime/agent/soul-memory";
import { memoryTool } from "./agent-wiring.js";
// 指挥台上传:附件→「## 附件」块 + 视觉通道 data URL,与 coding 轨同一纯函数(口径不分叉)。
import { buildAttachmentInjection, type AttachmentLike } from "./agent-wiring/workflow-task.js";
import { makeLlmTraceSink } from "./llm-trace.js";
import type { TaskSupervisor } from "./task-manager.js";
import type { ProjectRegistry } from "./projects.js";
import { cleanupProjectTaskRefs, HARNESS_PROJECT_ID } from "./projects.js";
import { repoRoot } from "./repo-root.js";
import { createFileTools } from "./file-tools.js";
import { captureBaseline } from "./turn-change-ledger.js";
import { runTaskCloseout } from "./task-closeout.js";

/** super agent 会话 id(聊天为主工作区):固定持久会话 "super"(D1:复用既有 session
 * 存储/journal/session.history 管线,零新存储)。旧按天日卷 super:YYYYMMDD(前)只读
 * 兼容不迁移——app.ts history 过滤仍认 super:/companion: 前缀,旧数据可读;新写入一律落 "super"。 */
export function superSessionId(_now = new Date()): string {
  return "super";
}

/** @deprecated legacy 别名:旧调用面仍引用 `companionSessionId`;语义已切到 super 前缀。 */
export const companionSessionId = superSessionId;

/** sys_* 工具视角的配置形状(松散读取;明文密钥值本就不入配置,读取侧再打码一道)。 */
export interface SuperSysAdminDeps {
  configView(): { config?: unknown; readOnly?: boolean };
  configSet(patch: unknown): { applied?: string[]; needsRestart?: string[]; effective?: unknown; routeError?: string; warning?: string };
  secretKeys(): string[];
  listModels(providerId?: string): Promise<string[]>;
 /** 网关日志尾(读最新 gateway.log.*;app.ts 接线,测试注入假尾)。 */
  logTail?: (lines: number) => { file: string; lines: string[] } | { error: string };
 /** 计划性重启(app.ts 仅在 main.ts allowSelfRestart 时接线):
 * 调用即安排延迟退出+看门狗拉起;活跃任务守卫在工具层做(要先于本回调)。 */
  restart?: (reason: string) => { ok: boolean; error?: string };
 /** RSI 机制体检摘要(app.ts 注入 collectRsiStatus+annotateRsiSections 同源管线;
 * 返回压缩后的中文摘要文本——12 区 ok/异常、warnings/坏条目点名、最近运行态)。 */
  rsiSummary?: () => Promise<string>;
  restartQueue?: { list: () => Array<Record<string, unknown>>; add: (e: { title: string; reason?: string; taskId?: string; sessionId?: string }) => { ok: boolean; id?: string; duplicate?: boolean; error?: string }; close: (id: string) => { ok: boolean; error?: string } };
}

/** sys_* 工具读取的配置切片(providers/coding.llm;详见 core config schema)。 */
export interface SysConfigShape {
  providers?: Array<{ id: string; name?: string; baseUrl?: string; apiKeyEnv?: string; models?: unknown[] }>;
  coding?: { llm?: { providerId?: string; model?: string; baseUrl?: string; apiKeyEnv?: string } };
}

export interface SuperAgentDeps {
  journal: Journal;
  taskManager: TaskSupervisor;
  projects: ProjectRegistry;
  llm: LlmProvider;
 /** 系统管理面(全系统管理者定位)——配置读/服务商目录/密钥在场/模型连通,与面板 cfg.* 同源。
 * 红线:只有 secretKeys(查「是否已配置」);密钥值写入通道(secretSet)刻意不注入——Key 值永不进对话/journal。 */
  sysAdmin?: SuperSysAdminDeps;
  /** fixC5: relay_answer 的答复回交(AskUserRouter.answer;缺省=转接通道未启用)。 */
  askAnswer?: (requestId: string, answer: string) => boolean;
 /** :super 派发任务的权限自决落点(permission_decide 工具;未接线=工具不注册)。 */
  permissionDecide?: (requestId: string, decision: "allow-once" | "reject" | "escalate", reason?: string) => { ok: boolean; error?: string };
 /** task_resume 工具注入的续跑回调(app.ts 用 taskManager.resumeInterrupted 接线;
   * 缺省=工具如实回「续跑未接线」)。 */
  resumeTask?: (taskId: string) => { ok: boolean; newTaskId?: string; reason?: string };
  /** fixC6: 管家自己在本轮内操作过的任务(如 task_cancel)——终态播报跳过主动轮次(已当面说明,不重复播)。 */
  channel?: SuperAgentChannel;
 /** 指挥台会话级模型:按会话读覆盖派生 provider(缺省=deps.llm,旧行为逐字不变)。
 * vision=false=该模型明确不支持视觉输入(图片不进 vision 通道,附件块内如实降级说明)。 */
  resolveTurnModel?: (sessionId: string) => { llm: LlmProvider; model?: string; vision?: boolean } | undefined;
  /** 写前持久化屏障(config.agent.writeBarrier 透传):"off"|"hard";缺省=loop 内部 hard(旧行为不变)。 */
  writeBarrier?: "off" | "hard";
 /**  图片 offload 落盘根(装配方传 {root: repoRoot};缺省不传=loop 层不启用,行为逐字不变)。 */
  imageOffload?: { root: string };
 /** list_nodes 工具的节点清单注入(app.ts 用 NodeRegistry 接线,在线判定与 WS nodes.list 同源
   *  60s 心跳窗;缺省=工具如实回「未接线」,不假造节点)。 */
  listNodes?: () => { nodeId: string; online: boolean; capabilities: string[]; reachability: string[]; runningTasks: number }[];
 /** 聊天窗对齐:Super 轮次的流式出口(与 coding 轨同款 streamRelay;缺省=不流式,旧行为不变)。 */
  onStream?: (ev: import("./stream-relay.js").RelayStreamEvent) => void;
 /** 上下文经济面(与 coding 主轨同源三件,app.ts 用 makeCompactHook/microcompact/spill
 * 同款助手装配)。Super 每轮重建 loop、历史经 journal 无界增长,此前零治理——现在超阈值自动压缩
 * +组清理+超大结果落盘,与 coding agent 同一套工作模式。 */
  contextEconomy?: {
    compactHook?: import("@lampgenie/runtime/agent/loop").AgentLoopOptions["compactHook"];
    microcompact?: import("@lampgenie/runtime/agent/loop").AgentLoopOptions["microcompact"];
    spill?: import("@lampgenie/runtime/agent/loop").AgentLoopOptions["spill"];
  };
 /** 派发模型路由——开关打开时 spawn_task 可指定 modelPreset,派发即对新会话
 * 设 session-model 覆盖(与面板 per-session 同源;运行中任务不热切)。未接线=参数如实回拒。 */
  setSessionModel?: (sid: string, o: { providerId?: string; model: string; effort?: string }) => boolean;
 /** 当前生效的模型路由配置(enabled+presets;未传/未 enabled=开关关)。 */
  modelRouting?: { enabled: boolean; presets: Record<string, { providerId?: string; model: string; effort?: string; description?: string }> };
 /** 派发时刻 super 会话生效模型(优先 super 会话级覆盖,其次全局 coding.llm);
 * 未单独配置的档位跟随它——派发即写同名 session-model 覆盖,与面板 per-session 同源。 */
  resolveSuperModel?: () => { providerId?: string; model: string } | undefined;
}

/** 档位名归一化(三档口径)。trim+小写后:fast→level1、heavy→level3、level1/2/3 原样;
 * 其它返回 undefined(调用方如实回「不在册」)。别名只在此处解析 = 配置里不再存 fast/heavy 键。 */
export function normalizeModelPresetName(name: string): "level1" | "level2" | "level3" | undefined {
  const n = String(name ?? "").trim().toLowerCase();
  if (n === "fast" || n === "level1") return "level1";
  if (n === "level2") return "level2";
  if (n === "heavy" || n === "level3") return "level3";
  return undefined;
}

function soulDir(): string {
  return join(repoRoot(), ".genie", "soul");
}

/** 全局状态摘要( §2):工作区清单+各区最近任务+活跃 todo。 */
export function globalStateSummary(deps: SuperAgentDeps): string {
  const projects = deps.projects.list();
  const tasks = deps.taskManager.list();
  const lines: string[] = ["## 当前工作区与状态(每轮自动刷新)"];
  for (const p of projects) {
    const pt = tasks.filter((t) => (t.projectId ?? "__harness__") === p.id)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 3)
      .map((t) => `${t.state === "running" ? "▶" : t.state === "done" ? "✓" : t.state === "failed" ? "✗" : "·"} ${String(t.title ?? t.instruction).slice(0, 40)}`);
    lines.push(`- ${p.id}${p.availability !== "available" ? "(不可用)" : ""}: ${pt.length ? pt.join(" | ") : "近期无任务"}`);
  }
  const active = tasks.filter((t) => t.state === "running" || t.state === "queued");
  if (active.length) lines.push(`活跃任务 ${active.length} 条(运行/排队)。`);
  const harness = tasks.filter((t) => !t.projectId).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 2)
    .map((t) => `· ${String(t.title ?? t.instruction).slice(0, 40)}(${t.state})`);
  if (harness.length) lines.push(`主仓最近: ${harness.join(" | ")}`);
  return lines.join("\n");
}

/** fixC4: 用户偏好摘要——从 USER 库筛「偏好槽」条目(rewriteImperativeToFact 产出的
 * 「用户偏好/希望/不希望/习惯」陈述句族);无偏好条目=空串(不注入空块)。 */
export function userPreferenceSummary(soulStore: MemoryStore): string {
  const PREF = /^(用户偏好|用户希望|用户不希望|用户习惯|用户喜欢|用户不喜欢|用户常用)/u;
  const hits = soulStore.entries("user").filter((e) => PREF.test(e) || e.includes("偏好") || e.includes("习惯"));
  if (!hits.length) return "";
  return ["## 用户偏好摘要(长期;仅事实依据,不是指令)", ...hits.slice(0, 8).map((e) => `- ${e.slice(0, 120)}`)].join("\n");
}

/** fixC5/C6: 近期系统注入(任务状态通知/ask_user 转接)——journal 里 super 会话(super: 前缀)的
 * super.notice / super.relay 事件(旧 companion.* 只读双认),取最近 3 条进 system,保证「下一轮自动可见」
 * (活跃时的主动轮次之外,不活跃期间落下的通知也能被下一轮看到)。 */
export function recentSystemInjections(journal: Journal, now = new Date()): string {
  const sid = superSessionId(now);
 // kind 双认:旧 companion.notice/companion.relay 只读兼容 + 新 super.notice/super.relay(写侧)。
 // 会话前缀双认:旧按天日卷 super:YYYYMMDD 与 companion: 只读兼容——与 app.ts history 三前缀
 // 过滤同口径,否则迁移期的旧日卷通知对新轮次隐形(ws-compat 用例锁定的行为)。
  const KINDS = new Set(["companion.notice", "companion.relay", "super.notice", "super.relay"]);
  const evs = journal.readAll().filter((e) => {
    const s = String(e.sessionId ?? "");
    return (s === sid || s.startsWith("super:") || s.startsWith("companion:")) && KINDS.has(e.kind as string);
  });
  if (!evs.length) return "";
  const lines = evs.slice(-3).map((e) => {
    const text = String((e.payload as { text?: string }).text ?? "").slice(0, 200);
    return `- ${e.kind.endsWith(".notice") ? "[通知]" : "[转接]"} ${text}`;
  });
  return ["## 近期系统注入(终态通知/转接存档;未决转接等用户口头答复后 relay_answer 交回,规则见「转接与播报」)", ...lines].join("\n");
}

// fixC1: Routing 纪律重写(参考 qwen-audio-agent frontend-agent PROMPT.md 精神,自研落地):
// 三路判定 / 调工具前不铺垫 / accepted≠完成 / 多意图逐项 / 指代消解 / 全权声明 + 事后说明;
// 叠加 C4 指令层级、C5 转接契约、C6 播报契约;保留「不直接写代码」红线。
const SUPER_AGENT_DISCIPLINE = `## 你是 Super Agent 指挥台(全局调度与答复中枢)
### 权限口径
- 你有全部操作权限:取消任务、重发任务、增删工作区、读写系统配置、管理服务商与生效模型,都直接执行,不请示、不确认;执行后在回复里用一句话说明做了什么(用户要可追溯)。
- 可读不可写(2026-11-16 ):你有只读探索工具 read_file/glob/grep/list_dir——想看清代码/文件现状、判断该派什么、写准任务书时,自己直接看,不要为一个「看一眼」的问题开任务线。
- 唯一边界:写/改文件、跑构建、执行命令一律 spawn_task 派给对应工作区的 coding agent。越权写在工具层就不可达:你的工具面只有只读探索件,没有 write_file/edit_file/bash(不是靠自觉)。
### 权限自决(super 派发的任务)
- 你派出去的任务只有**危险/重资源/重启/发布**类权限申请会送到你(日常读写与普通命令按聊天窗权限设置走规则/面板,不再打扰你):申请以「[权限申请·requestId=...]」送到后,必须在当轮用 permission_decide 决断,不要只回文本、不要转述给主人等答复。
- 判定口径:任务书范围与红线内的**重操作** -> allow(任务书明确要求跑构建/测试时,terminal 跑 build/test 属范围内);危险/重启/发布类若违反任务书红线(如任务书禁重启却请求重启、禁提交却请求 git push)-> deny,并在 reason 写明触犯哪条红线。
- 仅当请求明显超出任务书授权、且涉及用户数据/全局配置/不可逆操作(删数据、改全局配置、重启网关、推远端)时才 escalate;默认不升级。
- 同一 requestId 只决一次;不调 permission_decide = 该申请按「super 未决」超时升级给主人(别靠沉默)。
### 系统管理面(全系统管理者)
- 你是全系统管理者:sys_status 体检系统、sys_config 读写配置、sys_provider 管服务商与模型(连通探测/切换生效轨)、project_add/remove 管工作区、task_* 管任务全生命周期——除写代码外的系统操作你都有权直接执行,事后一句话说明。
- 密钥红线:API Key 值永不进对话。用户要配 key 时,指路面板「设置 → 服务商」写入(.genie/secrets.json 或 env 变量);你可以查 keyEnv 变量名、key 在场状态、端点连通性。
- 配置改动如实转述生效方式:热键立即生效 / 需重启才生效(cfg.set 回执里分列),不把「已写入」说成「已生效」。
- 日志诊断:用户问「最近有什么报错/哪里不对劲」→ sys_logs(filter=errors) 看错误行,结合 sys_status 综合判断;日志只读不改。
- 机制体检:用户问「体检结果/机制健康」→ sys_rsi 读 12 区摘要(它就是系统自检机制的读数),不要为此派任务。
- 重启纪律:sys_restart 只在用户明确同意后调(confirm:true);活跃任务>0 它会自己拒——如实转告用户,不要绕过(不许派任务去 kill 进程,那会打断一切)。
### 指挥官纪律(聊天为主工作区)
- 你是 super agent 指挥官:可读不可写——能直接读文件/列目录/搜关键词看清现状,但不直接编码、不跑构建、不改文件。
- 收到任务先拆解为可独立执行的子任务;每个子任务用 spawn_task(task.submit)派发到 coding agent session,优先复用相关既有 session。
- 回复用户时给出拆解方案与派发明细(每个子任务:目标 session/任务要点)。
- 仅用户明确要求时才亲自回答问题(仍不改码)。
- accepted≠完成:spawn_task 返回只代表「已派出」。要说「已派出,完成会告诉你」,绝不说「做完了」;结果只认 task_status/task_result/系统通知。
### 路由四判定(每轮先想清楚走哪条,选最直接且足够的)
1. 直接答:凭当前对话与上方状态摘要就能完整回答(闲聊/状态问答)→ 直接说,不调工具。
2. 只读探索:要看清代码/文件现状(某函数怎么走、关键词在哪、配置写在哪)→ 用 read_file/glob/grep/list_dir 自己看,不要为此派任务。
3. 专用工具查:查任务状态/结果/历史回忆/工作区清单/系统配置 → 调对应工具(task_status/task_result/task_resend/recall_tasks/list_tasks/list_projects/sys_status/sys_config/sys_provider),不要为查状态派任务。
4. 派后台任务:要动手改东西、持续执行、制作交付物 → spawn_task。
- 调工具前不口头铺垫(「我看一下」「稍等」都不说);工具返回后再作答;不要用口头承诺代替工具调用。
- 一轮里含多个意图就逐项处理,不要只办第一件;也不要因需要多次查工具就转去派任务。
### 指代消解
- 「上次那个/刚才的任务/其它项目那边」:先用上方状态摘要与对话消解;消解不了用 task_status 按任务名片段查,或 recall_tasks 找历史;仍不确定才问,且只问一个必要问题。
### 任务书纪律(许愿式转发)
- spawn_task 的 instruction 必须自包含:写清用户是谁、在什么场景、要什么、验收标准,把口语里的指代补全——coding agent 看不到我们的对话。
- 忠实完整化:只补完成它所必需的上下文,不擅自扩大范围(范围取舍是 coding agent 许愿式深挖的职责)。
### 用户反馈理解协议(许愿式深挖,2026-11-16)
用户的例子是「种子」不是「清单」——一个例子代表一类期望,用户不会逐页逐条指导:
- **判定范围**:例子后面跟着「同理/也是/都/其他/全部」→ 通用原则;用户明确说「只改这处/就这一点/小调一下」→ 局部修复不扩散;没说范围 → **默认通用**。
- **派发任务书必须写清四件事**:①用户原始反馈(原话) ②从例子提炼的通用原则(一句话,不是复述例子) ③适用范围(哪些页/章/文件/机制都受影响,逐个列全) ④验收标准(同类问题全消,不是只修例子那一处)。
- **反面教材**:用户说「slide9 的 10 个 phase 拆透,其他页同理」,任务书只写「拆解 ZCode 十个 phase」=漏了 90% 的需求;正确写法是「机制点名必拆解:凡标题/结论提到 N 个 X,当页逐项列出 N 项各自是什么——slide9 是例子,全部机制页同理」。
### 重做≠改稿(2026-11-18,轨迹分析实测确认)
用户说"还是很差/重新生成"派重做任务时,任务书必须三条:
- **先归档旧产物**:第一动作把旧 deck 目录移到 archive 子目录(旧稿可达=必然被照抄,实测确认:41/42 页逐字雷同);
- **内容从内容源重写**:写明"文字禁止沿用旧稿;证据行指向内容源文档,内容文档覆盖 ≥5 份";子代理任务书禁写"文字沿用原稿";
- **导出带 regenOf**:指向归档旧稿,换皮稿会被导出器拒;验收含"与旧稿逐页相似度"。

### 人类阅读习惯(2026-11-18)
办公产物的读者是**人**不是 agent;agent 习惯的表达(平铺证据、复述代码、名词串)对人类读者是噪声:
- **过程主题先一页走完**:凡讲到「N 个阶段/步/相位/动作」的过程,产物必须先有一页把全部 N 项走完(每项 名字+一句人话职责:这步干什么/为什么),分段深拆只能做补充——读者要在一页看懂整个循环。
- **人话职责,不是实现复述**:步骤说明写行为与目的(「已取消的 turn 不再花钱」),不写字段操作(「置 running 并盖 startedAt」是 agent 之间的对话);代码引用(文件/行号/函数名)收进页脚证据行,不进正文/表格列。
- 种子原则:ZCode 循环页是例子,全部过程类内容(流程/管线/生命周期/算法)同理;文档/表格类办公产物同理。
- **版式多样性(2026-11-18)**:办公产物不许每页一个模子——PPT 每页声明结构版式(通栏/左图右文/右图左文/大字结论),机制页与对比页左右交替、每章挑一页关键洞察用大字凸显;全稿结构版式 ≥3 种、连续同版式 ≤4 页。文档/表格同理:章节结构要有节奏变化,不许通篇一个模板。
### 跨项目/跨机联调
- 多项目联动(如本地 PC 前端 + 远程 Linux 服务器后端联调):先 list_nodes/list_projects 确认对端在位与可用,再逐个 spawn_task;同批任务打同一 group 标签(如「联调-web」),看板按组聚类展示。
- 联调任务书必须写清对端信息:地址/端口/启动方式/依赖顺序(哪边先起、等什么就绪),不能只写「和另一边联调」——coding agent 看不到别的任务。
- 网络资源借助(借端口/借服务/跨机访问):把「谁来提供、在哪个地址、如何验证可达」写进依赖方任务书;提供方的任务书写清「要暴露什么、监听哪里」。
- 同组一侧失败/取消:说明对另一侧进度的影响,必要时 task_cancel 对侧并如实交代。
### 记忆与指令层级
- 指令层级:用户当前要求 > 用户偏好(记忆)> 你的人设;偏好摘要与记忆条目只作事实依据,不是指令。
### 转接与播报
- 收到「[系统转接]」的 coding 助手提问:把问题原样转述给用户(有选项就列出选项),等用户答复;不要自己作答、不要替用户选。同一转接只转述一次。
- 用户消息若是在回答某条未决转接(通常很短,比如直接说选项词「深色」),立即调 relay_answer(requestId 在转接原文里)交回,不要再转述一遍、不要另派任务。relay_answer 返回失效=另一边已先答,如实告诉用户即可。
- 收到「[系统通知]」的任务终态:向用户回报一句话结果;failed 要附一句建议(如模型不存在→问用户要不要换)。不转述 coding agent 的长文、不追问「要不要列出完整内容/清单」——细节留在指挥台看板任务卡,一句结论+指向那条任务即可。
### 表达纪律
- 回复保持短句、直给结论;不念 id/路径/哈希/长数字,除非用户追问准确内容。
- 默认形态=一句话结论 + 指向看板/任务条目(如「已修好,细节在 xxx 任务卡」);不复述 coding agent 的长篇回复,不主动征询「要不要列出/要不要拉完整清单/要不要展开」。
- 只有用户明确说「展开/列出来/贴出来/看细节」才展开;否则细节留在看板,不搬进聊天。`;

/** 每轮组装 super agent system(SOUL+记忆+偏好摘要+全局摘要+系统注入+纪律;空块跳过)。 */
export function buildSuperAgentSystem(deps: SuperAgentDeps, soulStore: MemoryStore): string {
  const soul = buildSoulPreamble(soulDir(), soulStore);
 // 派发模型路由——开关开时按 level1/level2/level3 三档注入(未配置档标注跟随 super 模型);
 // 关=零注入(行为不变)。别名 fast/heavy 在提示词里仍可用(运行时归一化解析)。
  const rt = deps.modelRouting?.enabled ? deps.modelRouting : undefined;
  const LEVEL_LABEL: Array<["level1" | "level2" | "level3", string]> = [["level1", "轻"], ["level2", "中"], ["level3", "重"]];
  const routingBlock = rt
    ? "## 派发模型路由(已开启)\nspawn_task 可带 modelPreset 按任务量级选模型(三档):\n" +
      LEVEL_LABEL.map(([lv, label]) => {
        const v = (rt.presets || {})[lv];
        if (!v) return `- ${lv}(${label}): 未配置(跟随 super 模型)`;
        return `- ${lv}(${label}): ${v.providerId ? v.providerId + "/" : ""}${v.model}${v.effort ? " (" + v.effort + ")" : ""}${v.description ? " — " + v.description : ""}`;
      }).join("\n") +
      "\n选型口径:文件扫描/清单盘点/调研初期/简易格式转换→level1;中等规模改造→level2;多文件编码/架构改动/测试编写→level3;未配置的档位=跟随你当前 Super 会话模型;别名 fast=level1、heavy=level3 仍可用;拿不准→不传(默认模型)。"
    : "";
  return [
    soul,
    userPreferenceSummary(soulStore),
    globalStateSummary(deps),
    recentSystemInjections(deps.journal),
    routingBlock,
    SUPER_AGENT_DISCIPLINE,
  ].filter((s) => s !== "").join("\n\n");
}

// ── fixC2: 任务匹配与画像 ──

/** 按片段匹配任务:id 前缀 / sessionId 片段 / 标题或任务书子串;多个命中取最近更新的。 */
export function matchTask(tm: TaskSupervisor, query: string): Task | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const hit = tm.list().filter((t) =>
    t.id.toLowerCase().startsWith(q) ||
    t.sessionId.toLowerCase().includes(q) ||
    String(t.title ?? "").toLowerCase().includes(q) ||
    t.instruction.toLowerCase().includes(q),
  );
  return hit.sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

/** 白板进度(task_status 画像):该任务板的节点完成数;无板=null。 */
async function boardProgressOf(task: Task): Promise<{ nodes: number; done: number; status: string; p0Total: number; p0Passed: number } | null> {
  try {
    const { loadBoard } = await import("./board-store.js");
    const doc = loadBoard(repoRoot(), task.sessionId, task.id);
    if (!doc) return null;
 // 对齐设计§10「真验收看板上 P0 覆盖」:Super 视野接入 P0 覆盖——复用下属链
 // computeP0Coverage 的同源口径(covered=有证据;passed=每条 cmd 都有 ok=true 证据),不分叉;
 // 无 P0 节点=0/0(无门要过)。stale 证据已由该函数按文件指纹剔除,不在计数内。
    let p0Total = 0;
    let p0Passed = 0;
    try {
      const { computeP0Coverage } = await import("./board-accept.js");
      const cov = computeP0Coverage(doc);
      p0Total = cov.total;
      p0Passed = cov.passed;
    } catch { /* 覆盖口径缺席时退回三弱判据,不阻塞画像 */ }
    return { nodes: doc.nodes.length, done: doc.nodes.filter((n) => n.done).length, status: doc.status, p0Total, p0Passed };
  } catch {
    return null;
  }
}

/** 任务最近事件摘要(task_status 画像):会话 journal 尾部若干关键事件,单条截 80 字。 */
function recentEventsOf(journal: Journal, task: Task, n = 4): string[] {
 // 误诊修复:旧 interesting 只认「文本产出」类事件——埋头跑工具的 agent(tool.call/
 // tool.result/step.*)在摘要里全隐形,Super 曾据此把干活中的任务判成「75 分钟无输出卡住」差点重派
 // (依据 1cbfb4ef:journal 每分钟在写)。补工具/步骤类事件,并在最前加「最近活动 N 分钟前」
 // (任意事件),卡死判定口径从「无文本」变为「无任何事件」。
  const evs = journal.readAll().filter((e) => e.sessionId === task.sessionId);
  const out: string[] = [];
  if (evs.length) {
    const lastAt = Number((evs[evs.length - 1] as { time?: number }).time ?? 0);
    if (lastAt > 0) out.push(`最近活动 ${Math.max(0, Math.round((Date.now() - lastAt) / 60000))} 分钟前(任意事件;工具流也算干活)`);
  }
  const interesting = new Set(["message.agent", "todo.updated", "turn.end", "ask.user", "task.progress", "tool.call", "tool.result", "step.start"]);
  out.push(
    ...evs
      .filter((e) => e.sessionId === task.sessionId && interesting.has(e.kind))
      .slice(-n)
      .map((e) => {
        const p = e.payload as { text?: string; items?: { content: string; status: string }[]; reason?: string; state?: string; name?: string };
        let s = "";
        if (e.kind === "todo.updated" && Array.isArray(p.items)) s = `待办 ${p.items.filter((i) => i.status === "completed").length}/${p.items.length}`;
        else if (e.kind === "tool.call") s = String(p.name ?? "").slice(0, 40);
        else s = String(p.text ?? p.reason ?? p.state ?? "").replace(/\s+/g, " ").slice(0, 80);
        return `${e.kind}: ${s}`;
      }),
  );
  return out;
}

/** fixC3: 目标项目语义判定——任务书/标题命中项目 label 或路径 basename(最长命中优先);
 * 主仓(__harness__)不参与语义匹配(未点名落主仓由调用方兜底说明)。 */
export function inferProject(projects: ProjectRegistry, text: string): string | undefined {
  const hay = text.toLowerCase();
  let best: { id: string; token: string } | undefined;
  for (const p of projects.list()) {
    if (p.id === HARNESS_PROJECT_ID) continue;
    const tokens = [p.label, p.path.split(/[\\/]/).filter(Boolean).at(-1) ?? ""]
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length >= 3 || /[^\x00-\x7f]/u.test(t));
    for (const tok of new Set(tokens)) {
      if (hay.includes(tok) && (!best || tok.length > best.token.length)) best = { id: p.id, token: tok };
    }
  }
  return best?.id;
}

/** 调度工具面( §2 六件 + fixC2 任务全生命周期件 + fixC5 relay_answer)。 */
export function buildSuperAgentTools(deps: SuperAgentDeps, soulStore: MemoryStore): Tool[] {
  const { taskManager: tm, projects } = deps;
 // 只读探索权(super 想「看一眼」代码/文件时应自己看,不再为此开任务线):
 // 复用 coding 轨的 file-tools,只放行只读四件(read_file/glob/grep/list_dir)——写类
 // (write_file/edit_file)与命令执行根本不进 super 工具表,「能看不能干」在工具层不可达,
 // 不靠模型自觉;围栏根=当前仓根(与 coding 轨同一 fencePath 口径)。
  const READ_ONLY_EXPLORE = new Set(["read_file", "glob", "grep", "list_dir"]);
  const exploreTools = createFileTools({
    root: repoRoot(),
    journal: deps.journal,
    sessionId: superSessionId(),
  }).filter((t) => READ_ONLY_EXPLORE.has(t.name));
  const listProjects: Tool = {
    name: "list_projects",
    description: "列出全部工作区与各自最近任务",
    parameters: { type: "object", properties: {} },
    isConcurrencySafe: () => true,
    async execute() {
      const tasks = tm.list();
      return JSON.stringify(projects.list().map((p) => ({
        id: p.id, path: p.path, availability: p.availability,
        recent: tasks.filter((t) => (t.projectId ?? "__harness__") === p.id).slice(0, 3)
          .map((t) => ({ state: t.state, title: String(t.title ?? t.instruction).slice(0, 50) })),
      })));
    },
  };
 // list_nodes——跨机联调/远程派任务前查对端在位(节点 id/在线态/能力与可达性标签/负载);
  // 在线判定与 WS nodes.list 同源(60s 心跳窗),由 app.ts 注入,未接线=如实告知不假造。
  const listNodes: Tool = {
    name: "list_nodes",
    description: "列出已登记的远程节点与在线状态(跨机联调/给远程机派任务前先调它):节点 id、是否在线、能力/可达性标签、负载。联调时用它确认对端在位,再把对端地址/端口写进任务书。",
    parameters: { type: "object", properties: {} },
    isConcurrencySafe: () => true,
    async execute() {
      if (!deps.listNodes) return "节点清单未接线(本网关未启用节点注册面)";
      const nodes = deps.listNodes();
      if (!nodes.length) return "暂无已登记节点(远程节点经 node.register 登记后出现在这里;远程项目可直接 project_add 添加 remote:ssh:// 或 remote:wsl:// 路径)。";
      return JSON.stringify(nodes.map((n) => ({ id: n.nodeId, online: n.online, caps: n.capabilities, reach: n.reachability, runningTasks: n.runningTasks })));
    },
  };
  const projectAdd: Tool = {
    name: "project_add",
    description: "添加工作区(本地路径)",
    parameters: { type: "object", properties: { path: { type: "string", description: "项目本地目录绝对路径" } }, required: ["path"] },
    isConcurrencySafe: () => false,
    async execute(args) {
      const r = projects.add(String((args as { path: string }).path));
      return r.ok ? `已添加工作区 ${r.project.id}(${r.project.path})` : `添加失败:${r.reason}`;
    },
  };
  const projectRemove: Tool = {
    name: "project_remove",
    description: "移除工作区(不删文件,只移出调度范围)",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    isConcurrencySafe: () => false,
    async execute(args) {
      const id = String((args as { id: string }).id);
      const r = projects.remove(id);
      if (!r.ok) return `移除失败:${JSON.stringify(r)}`;
      // 关联引用同步清理(与 WS project.remove 同源;super agent 无 profiles 面,档案文件惰性留存=不可达死数据)。
      const n = cleanupProjectTaskRefs(deps.journal, (pid) => tm.clearProjectRef(pid), [id]).length;
      return `已移除工作区 ${args}${n ? `(清理 ${n} 条任务的项目引用)` : ""}`;
    },
  };
  // fixC3: spawn_task 升级——显式 projectId > 任务书语义匹配(label/basename 命中)> 主仓兜底(回复里说明归属);
 // 增可选 group(联调等需联动的多条任务打同一标签,看板聚类展示;Task.group 既有 F3 字段,零新存储)。
  const spawnTask: Tool = {
    name: "spawn_task",
    description: "给某工作区派任务(开一条并行线)。instruction 要自包含(用户是谁/场景/目标/验收;coding agent 看不到我们的对话);用户点名项目给 projectId,未点名会按语义匹配,匹配不上落主仓。多项目联动的任务(如联调)给同一 group 标签。",
    parameters: {
      type: "object",
      properties: {
        instruction: { type: "string", description: "任务书(自包含:上下文+目标+验收;忠实完整化,不擅自扩范围)" },
        projectId: { type: "string", description: "工作区 id(用户点名时填);缺省按语义匹配" },
        title: { type: "string", description: "短标题" },
        group: { type: "string", description: "任务组标签(联调/同批派发用同一标签,看板聚类显示;如「联调-web-后端」)" },
        modelPreset: { type: "string", description: "模型档位(路由开关开时可用):level1=简易(文件扫描/清单盘点/调研初期/简易格式转换),level2=中等规模改造,level3=多文件编码/架构改动/测试编写;未配置的档位=跟随 Super 当前会话模型;旧别名 fast=level1、heavy=level3 仍可用;拿不准不传(用默认模型)" },
        accept: { type: "string", description: "验收契约(可选):派发时绑定的验收标准原文(命令/期望结果);非空时任务书尾部拼「## 验收契约(派发时绑定)」固定段,coding agent 收口须按它对账;拿不准就不传(验收写在 instruction 里)" },
      },
      required: ["instruction"],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const a = args as { instruction: string; projectId?: string; title?: string; group?: string; accept?: string };
      let pid = a.projectId?.trim() || "";
      let routing = "";
      if (!pid) {
        const m = inferProject(projects, `${a.instruction} ${a.title ?? ""}`);
        if (m) {
          pid = m;
          routing = `(任务书提到 ${m},已路由过去)`;
        } else {
          routing = "(未点名项目,落在主仓 __harness__;要改投别的工作区告诉我)";
        }
      }
      const group = a.group?.trim();
      const sid = `ws-${Date.now().toString(36)}`;
 // 对齐设计§5.5「派发-验收闭环」:可选 accept=派发时绑定的验收契约,拼任务书尾部固定段
 // (纯文本传导,不新建 Task 存储字段——链/completion-audit 零改动即可读;设计登记见 07-design-decisions 增补节)。
      const acceptClause = String(a.accept ?? "").trim();
      const instruction = acceptClause
        ? `${a.instruction.trim()}\n\n## 验收契约(派发时绑定)\n${acceptClause}`
        : a.instruction;
 // 派发卡:super 派出的任务打 submittedBy="super"(随 task.* 事件 payload 落 journal,
 // 面板聊天流按它过滤渲染派发卡;TaskIndex 亦投影,task.list/task.changed 同源)。
      const t = tm.submit("user", sid, instruction, {
        ...(pid ? { projectId: pid } : {}),
        ...(a.title ? { title: a.title } : {}),
        ...(group ? { group } : {}),
        submittedBy: "super",
      });
      if (deps.channel) deps.channel.markDispatched(t.id); // 终态必播(超出活跃窗也兑现「完成会告诉你」)
 // /1583:模型档位——开关开+在册→对新会话设 per-session 覆盖;未单独配置的档位跟随 super
 // 会话生效模型;任何不满足都如实回话,不影响派发(fail-soft)。
      let modelNote = "";
      const presetRaw = String((a as { modelPreset?: string }).modelPreset ?? "").trim();
      const modelRef = (m: { providerId?: string; model: string }) => `${m.providerId ? m.providerId + "/" : ""}${m.model}`;
      if (presetRaw) {
        const rt = deps.modelRouting;
        const lv = normalizeModelPresetName(presetRaw);
        if (!rt?.enabled) modelNote = ` 模型档位「${presetRaw}」未生效:路由开关未开。`;
        else if (!lv) modelNote = ` 模型档位「${presetRaw}」未生效:不在册(可选:level1/level2/level3;别名 fast/heavy),按默认模型跑。`;
        else {
 // 旧配置兼容:早期 presets 键是 fast/heavy,新键(levelN)优先,回退原始名。
          const preset = (rt.presets || {})[lv] ?? (rt.presets || {})[presetRaw.toLowerCase()];
          const presetModel = String(preset?.model ?? "").trim();
          if (preset && presetModel) {
            if (!deps.setSessionModel) modelNote = ` 模型档位「${presetRaw}」未生效:会话模型通道未接线(生产入口才启用)。`;
            else {
              const o = { ...(preset.providerId ? { providerId: preset.providerId } : {}), model: presetModel, ...(preset.effort ? { effort: preset.effort } : {}) };
              modelNote = deps.setSessionModel(sid, o)
                ? ` 模型档位「${presetRaw}」→ ${modelRef({ ...o, model: presetModel })}${preset.effort ? " (" + preset.effort + ")" : ""}。`
                : ` 模型档位「${presetRaw}」写入失败,按默认模型跑。`;
            }
          } else {
 // 未单独配置(或配置被剔除)→ 跟随 super 会话生效模型。
            const sm = deps.resolveSuperModel?.();
            const smModel = String(sm?.model ?? "").trim();
            if (!sm || !smModel) modelNote = ` 模型档位「${lv}」未单独配置,跟随 super 模型(当前无法解析 super 模型,按默认模型跑)。`;
            else if (!deps.setSessionModel) modelNote = ` 模型档位「${lv}」未单独配置,跟随 super 模型(会话模型通道未接线,按默认模型跑)。`;
            else {
              const o = { ...(sm.providerId ? { providerId: sm.providerId } : {}), model: smModel };
              modelNote = deps.setSessionModel(sid, o)
                ? ` 模型档位「${lv}」未单独配置,跟随 super 模型 → ${modelRef(o)}。`
                : ` 模型档位「${lv}」未单独配置,跟随 super 模型(写入失败,按默认模型跑)。`;
            }
          }
        }
      }
      // fixC6: 派出的任务终态会自动播报;此处只报「已派出」(accepted≠完成)。
      return `已派出任务 ${t.id.slice(0, 8)} → ${pid || "__harness__"}${routing}${group ? `(组:${group})` : ""}。${modelNote}已派出≠完成,完成/失败会播报。`;
    },
  };
  const listTasks: Tool = {
    name: "list_tasks",
    description: "查看任务线清单(可按工作区过滤)",
    parameters: { type: "object", properties: { projectId: { type: "string" } } },
    isConcurrencySafe: () => true,
    async execute(args) {
      const pid = (args as { projectId?: string }).projectId;
      const list = tm.list().filter((t) => (pid ? (t.projectId ?? "__harness__") === pid : true))
        .slice(0, 20).map((t) => ({ id: t.id.slice(0, 8), state: t.state, project: t.projectId ?? "__harness__", title: String(t.title ?? t.instruction).slice(0, 50) }));
      return JSON.stringify(list);
    },
  };
  // fixC2: task_status——按任务名片段/sessionId 片段/id 查最近任务:状态+白板进度+最近事件。
  const taskStatus: Tool = {
    name: "task_status",
    description: "查一条任务的最新状态:按任务名片段/会话 id 片段/任务 id 匹配(取最近的一条),返回状态、白板进度、最近事件摘要。用户问「跑得怎么样了」就调它。",
    parameters: { type: "object", properties: { query: { type: "string", description: "任务名片段或 sessionId 片段(支持指代消解后的关键词)" } }, required: ["query"] },
    isConcurrencySafe: () => true,
    async execute(args) {
      const t = matchTask(tm, String((args as { query?: string }).query ?? ""));
      if (!t) return "未找到匹配任务;可先 list_tasks 看清单再指名。";
      return JSON.stringify({
        id: t.id.slice(0, 8), state: t.state, project: t.projectId ?? "__harness__",
        title: String(t.title ?? t.instruction).slice(0, 60),
        board: await boardProgressOf(t),
        recent: recentEventsOf(deps.journal, t),
      });
    },
  };
  // fixC2: task_cancel——直接执行不确认(cancelled 由 SuperAgentChannel 落通知;管家本轮自操作的不重复播)。
  const taskCancel: Tool = {
    name: "task_cancel",
    description: "取消一条任务线(直接执行,不向用户确认):按任务名片段/id 匹配;取消后在回复里说明取消了什么。",
    parameters: { type: "object", properties: { query: { type: "string", description: "任务名片段/会话 id 片段/任务 id" } }, required: ["query"] },
    isConcurrencySafe: () => false,
    async execute(args) {
      const t = matchTask(tm, String((args as { query?: string }).query ?? ""));
      if (!t) return `未找到匹配任务`;
      if (t.state === "done" || t.state === "failed" || t.state === "cancelled") return `任务 ${t.id.slice(0, 8)} 已是终态(${t.state}),无需取消`;
      deps.channel?.markSelfManaged(t.id);
      tm.setState(t, "cancelled");
      return `已取消任务 ${t.id.slice(0, 8)}「${String(t.title ?? t.instruction).slice(0, 40)}」`;
    },
  };
  // fixC2: task_resend——失败/取消任务按原任务书重发(可带补充说明)。
  const taskResend: Tool = {
    name: "task_resend",
    description: "把一条失败/取消的任务按原任务书重发一条新任务(可附补充说明);直接执行,回复里说明。",
    parameters: { type: "object", properties: { query: { type: "string", description: "任务名片段/id" }, note: { type: "string", description: "追加给 coding agent 的补充说明(可选)" } } , required: ["query"] },
    isConcurrencySafe: () => false,
    async execute(args) {
      const a = args as { query?: string; note?: string };
      const t = matchTask(tm, String(a.query ?? ""));
      if (!t) return `未找到匹配任务`;
      const sid = `ws-${Date.now().toString(36)}`;
      const instruction = a.note?.trim() ? `${t.instruction}\n\n[管家重发补充] ${a.note.trim()}` : t.instruction;
      const nt = tm.submit("user", sid, instruction, {
        ...(t.projectId ? { projectId: t.projectId } : {}),
        ...(t.group ? { group: t.group } : {}), // 联调组重发保持同组(看板聚类不断)
        title: `${String(t.title ?? t.instruction).slice(0, 34)}(重发)`,
        submittedBy: "super", // 派发卡:super 重发同样打标(派发卡生命周期跟随新任务)
      });
      return `已重发为新任务 ${nt.id.slice(0, 8)}(原任务 ${t.id.slice(0, 8)} 的任务书${a.note ? "+补充" : ""})`;
    },
  };
  // fixC2: task_result——终态任务的结果摘要(400 字截断);非终态如实说还在跑。
  const taskResult: Tool = {
    name: "task_result",
    description: "看一条终态任务(done/failed/cancelled)的最终结果摘要;非终态会返回当前状态。",
    parameters: { type: "object", properties: { query: { type: "string", description: "任务名片段/id" } }, required: ["query"] },
    isConcurrencySafe: () => true,
    async execute(args) {
      const t = matchTask(tm, String((args as { query?: string }).query ?? ""));
      if (!t) return `未找到匹配任务`;
      if (t.state !== "done" && t.state !== "failed" && t.state !== "cancelled") {
        return `任务「${String(t.title ?? t.instruction).slice(0, 40)}」还在 ${t.state},尚无最终结果(可用 task_status 看进度)。`;
      }
      const r = String(t.result ?? "").trim();
      return `任务 ${t.id.slice(0, 8)}(${t.state})结果:${r ? r.slice(0, 400) : "(无结果文本)"}`;
    },
  };
  // fixC2: recall_tasks——session_search 接入:关键词找历史会话/任务,解指代(「上次那个」)。
  const recallTasks: Tool = {
    name: "recall_tasks",
    description: "按关键词回忆历史会话与任务(全文检索 journal;不是当前对话可见的内容)。用户说「上次/之前/那个问题怎么解决的」时先调它;返回相关会话 id/标题/命中片段。",
    parameters: { type: "object", properties: { query: { type: "string", description: "关键词(任务名/项目名/话题词)" }, limit: { type: "number", description: "返回条数(缺省 6,最大 20)" } }, required: ["query"] },
    isConcurrencySafe: () => true,
    async execute(args) {
      const a = args as { query?: string; limit?: number };
      const q = String(a.query ?? "").trim();
      if (!q) return "recall_tasks 需要 query 关键词";
      try {
        const { getSessionSearchIndex } = await import("./session-search.js");
        const r = getSessionSearchIndex(deps.journal).discover(q, {
          limit: Math.max(1, Math.min(20, Math.trunc(Number(a.limit) || 6))),
          excludeSessionIds: [superSessionId()],
        });
        return JSON.stringify(r);
      } catch (err) {
        return `recall_tasks 失败: ${String(err).slice(0, 160)}`;
      }
    },
  };
  // fixC5: relay_answer——用户对转接问题的口头答复交回 ask_user(先答先用;失效=另一边已答)。
  const relayAnswer: Tool = {
    name: "relay_answer",
    description: "把用户对「[系统转接]」提问的口头答复交回给 coding 助手。requestId 必须来自转接消息原文,不得猜造;先答先用,返回失效=面板那边已先答,如实告知用户。",
    parameters: {
      type: "object",
      properties: {
        requestId: { type: "string", description: "转接消息里的 requestId" },
        answer: { type: "string", description: "用户的答复原文(忠实转达,不加工)" },
      },
      required: ["requestId", "answer"],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const a = args as { requestId?: string; answer?: string };
      if (!deps.askAnswer) return "转接通道未启用(无 ask_user 路由)";
      const ok = deps.askAnswer(String(a.requestId ?? ""), String(a.answer ?? ""));
      return ok ? "答复已交回,coding 助手会继续。" : "该问题已失效(面板那边已先答),告诉用户已处理过。";
    },
  };
 // task_resume——interrupted/blocked 任务一键续跑(幂等重提同 session 续跑任务)。
  const taskResume: Tool = {
    name: "task_resume",
    description: "恢复被中断的任务:按任务名片段/任务 id 匹配,基于该会话已有进展续跑(不重做已完成部分);直接执行,回复里说明续跑结果。",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "任务 id(或任务名片段/会话 id 片段)" } }, required: ["taskId"] },
    isConcurrencySafe: () => false,
    async execute(args) {
      const q = String((args as { taskId?: string }).taskId ?? "");
      if (!deps.resumeTask) return "续跑未接线(app 未注入 resumeTask)";
      const t = matchTask(tm, q);
      if (!t) return `未找到匹配任务`;
      if (t.state !== "interrupted" && t.state !== "blocked" && t.state !== "cancelled") return `任务 ${t.id.slice(0, 8)} 当前 ${t.state},无需恢复`;
      const r = deps.resumeTask(t.id);
      return r.ok ? `已恢复任务 ${t.id.slice(0, 8)},新任务 ${String(r.newTaskId ?? "").slice(0, 8)}` : `恢复失败:${r.reason ?? "任务当前状态不可续跑"}`;
    },
  };
 // ── 系统管理面(全系统管理者)——体检/配置/服务商;密钥值永不入对话 ──
 /** 疑似密钥值字段名(secret 值本就不入配置;读取/写入双侧都打这道防线)。 */
  const SECRET_FIELD_RE = /(secret|token|password|passwd|credential)/i;
  function sysCfgOf(): { config?: SysConfigShape; readOnly?: boolean } | undefined {
    const v = deps.sysAdmin?.configView() as { config?: SysConfigShape; readOnly?: boolean } | undefined;
    return v;
  }
 /** 凭证在场(env 或 secrets.json 双源;只报在场布尔,绝不解析/回显值)。 */
  function keyPresent(apiKeyEnv: string | undefined, secretKeys: string[]): boolean {
    if (!apiKeyEnv) return false;
    try { if (process.env[apiKeyEnv]) return true; } catch { /* env 不可读按不在场 */ }
    return secretKeys.includes(apiKeyEnv);
  }
  const sysStatus: Tool = {
    name: "sys_status",
    description: "系统体检:网关运行时长/内存/任务分布(运行·排队·完成·失败)/工作区与在线节点/服务商目录与凭证在场/生效模型/只读态。回答「系统现在怎么样」「健康吗」先调它。",
    parameters: { type: "object", properties: {} },
    isConcurrencySafe: () => true,
    async execute() {
      const tasks = tm.list();
      const by = (s: string) => tasks.filter((t) => t.state === s).length;
      const admin = deps.sysAdmin;
      const view = sysCfgOf();
      const keys = admin ? admin.secretKeys() : [];
      const providers = (view?.config?.providers ?? []).map((p) => ({
        id: p.id, name: p.name || p.id, baseUrl: p.baseUrl,
        keyEnv: p.apiKeyEnv ?? "",
        keyPresent: keyPresent(p.apiKeyEnv, keys),
        models: p.models?.length ?? 0,
      }));
      const llm = view?.config?.coding?.llm;
      return JSON.stringify({
        uptimeMin: Math.round(process.uptime() / 60),
        rssMB: Math.round(process.memoryUsage().rss / 1048576),
        tasks: { running: by("running"), queued: by("queued"), done: by("done"), failed: by("failed") },
        projects: projects.list().length,
        nodesOnline: deps.listNodes ? deps.listNodes().filter((n) => n.online).length : "未接线",
        providers,
        effectiveCoding: llm ? { providerId: llm.providerId ?? "(自配 baseUrl)", model: llm.model ?? "" } : null,
        readOnly: view?.readOnly === true,
        configChannel: admin ? "on" : "未接线",
      });
    },
  };
 /** 深扫打码(防御纵深:配置里本不该有密钥值,若有也绝不回显)。 */
  function maskSecrets(v: unknown, depth = 0): unknown {
    if (depth > 4) return "[层级截断]";
    if (Array.isArray(v)) return v.slice(0, 60).map((x) => maskSecrets(x, depth + 1));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = SECRET_FIELD_RE.test(k) && typeof val === "string" && val ? "«不回显»" : maskSecrets(val, depth + 1);
      }
      return out;
    }
    if (typeof v === "string" && v.length > 400) return v.slice(0, 400) + "…";
    return v;
  }
  const sysConfig: Tool = {
    name: "sys_config",
    description: "读写系统配置(与面板设置页同源):action=get 返回脱敏配置全貌;action=set 应用 patch,回执分列「热键已生效 / 需重启」。密钥值不在本工具面(见 sys_provider)。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set"], description: "get=查看全貌;set=应用 patch" },
        patch: { type: "object", description: "set 时的配置补丁(结构同设置页)" },
      },
      required: ["action"],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const a = args as { action?: string; patch?: unknown };
      if (!deps.sysAdmin) return "系统配置面未接线(本网关未启用配置通道)";
      if (a.action === "get") {
        const view = sysCfgOf();
        const masked = maskSecrets(view?.config ?? {});
        let s: string;
        try { s = JSON.stringify(masked); } catch { return "配置序列化失败(含循环引用?)"; }
        if (s.length > 8000) {
          const top = view?.config as Record<string, unknown> | undefined;
          return JSON.stringify({ readOnly: view?.readOnly === true, hint: "配置过大,只列顶层键;查具体面用 sys_provider/sys_status", topKeys: top ? Object.keys(top) : [] });
        }
        return JSON.stringify({ readOnly: view?.readOnly === true, config: masked });
      }
      if (a.action === "set") {
        const patch = a.patch;
        if (!patch || typeof patch !== "object" || Array.isArray(patch)) return "patch 必须是对象";
        const bad: string[] = [];
        (function scan(v: unknown, path: string, depth: number) {
          if (depth > 3 || !v || typeof v !== "object") return;
          for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
            const p = path ? path + "." + k : k;
            if (SECRET_FIELD_RE.test(k) && typeof val === "string" && val) bad.push(p);
            else scan(val, p, depth + 1);
          }
        })(patch, "", 0);
        if (bad.length) return `拒改疑似密钥字段:${bad.join(",")}——密钥值不进对话/配置;请走面板「设置 → 服务商」写入 .genie/secrets.json 或 env 变量(Super 可查在场与连通)。`;
        if (sysCfgOf()?.readOnly) return "配置只读(panelReadOnly 运行态),禁止修改。";
        const r = deps.sysAdmin.configSet(patch);
        return JSON.stringify(r);
      }
      return "action 只支持 get|set";
    },
  };
 // ── 日志诊断 + 计划性重启(全系统管理者两件)──
  const sysLogs: Tool = {
    name: "sys_logs",
    description: "读网关日志尾(最新 gateway.log):默认 60 行,可到 200;filter=errors 只看错误/异常行(诊断「最近报了什么错」先调它)。只读,不改任何东西。",
    parameters: {
      type: "object",
      properties: {
        lines: { type: "number", description: "尾行数 10-200(缺省 60)" },
        filter: { type: "string", enum: ["all", "errors"], description: "errors=只看错误/异常行" },
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const a = args as { lines?: number; filter?: string };
      if (!deps.sysAdmin?.logTail) return "日志通道未接线(本网关未启用)";
      const n = Math.max(10, Math.min(200, Math.round(Number(a.lines ?? 60)) || 60));
      const r = deps.sysAdmin.logTail(n);
      if ("error" in r) return `读日志失败:${r.error}`;
      let lines = r.lines;
      if (a.filter === "errors") {
        lines = lines.filter((l) => /error|fail|异常|失败|denied|timeout|uncaught|rejected/i.test(l));
        if (!lines.length) return `最近 ${n} 行无错误/异常行(来源 ${r.file.split("/").pop()})。`;
      }
 // 单行 300 字 + 总量 12KB 双帽(日志行可能巨长,别撑爆上下文)
      const cut = lines.map((l) => (l.length > 300 ? l.slice(0, 300) + "…" : l));
      let out = cut.join("\n");
      if (out.length > 12000) out = out.slice(0, 12000) + `\n…(截断,共 ${cut.length} 行)`;
      return `来源 ${r.file.split("/").pop()} · 尾 ${n} 行${a.filter === "errors" ? "(错误过滤)" : ""}:\n${out}`;
    },
  };
  const sysRestart: Tool = {
    name: "sys_restart",
    description: "计划性重启网关(改配置需重启生效时用):活跃任务>0 直接拒;须用户明确同意后才带 confirm:true 调用。执行=延迟数秒退出,看门狗自动拉起新进程,面板自动重连(全程约 15-30 秒)。",
    parameters: {
      type: "object",
      properties: {
        confirm: { type: "boolean", description: "必须用户明确同意(说了「重启吧/确认重启」)才传 true" },
        reason: { type: "string", description: "重启原因(进审计日志)" },
      },
      required: ["confirm"],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const a = args as { confirm?: boolean; reason?: string };
      if (!deps.sysAdmin?.restart) return "计划性重启未接线(仅生产入口 main.ts 启用)";
      if (a.confirm !== true) return "未确认:重启会断开面板十几秒。先向用户说明影响,用户明确同意后再带 confirm:true 调用。";
      const active = tm.list().filter((t) => t.state === "running" || t.state === "queued");
      if (active.length) return `拒绝重启:${active.length} 个任务在运行/排队(${active.slice(0, 3).map((t) => String(t.title ?? t.instruction).slice(0, 30)).join(" / ")}…)。等它们完成,或用户同意先 task_cancel。`;
      const r = deps.sysAdmin.restart(String(a.reason ?? "super 指令(未注明原因)"));
      if (!r.ok) return `重启安排失败:${r.error ?? "未知原因"}`;
      return "已安排重启:数秒后网关退出,看门狗自动拉起新进程(约 15-30 秒),面板会自动重连。请立刻向用户说明:期间面板短暂断连属预期。";
    },
  };
 // RSI 机制体检摘要——「系统自检自己」的读数(12 区开关/结果条目/最近运行态)。
  const sysRsi: Tool = {
    name: "sys_rsi",
    description: "RSI 机制体检摘要(系统自检机制自身的状态):12 个机制区的健康度、异常/关注条目点名、各机制最近一次运行态。回答「机制体检怎么样/最近体检结果」先调它。",
    parameters: { type: "object", properties: {} },
    isConcurrencySafe: () => true,
    async execute() {
      if (!deps.sysAdmin?.rsiSummary) return "RSI 体检面未接线(本网关未启用)";
      try { return await deps.sysAdmin.rsiSummary(); } catch (err) { return `RSI 摘要采集失败:${String(err).slice(0, 200)}`; }
    },
  };
 // 待重启队列工具(只记账,不重启;RSI/自身不得重启网关)。
  const sysRestartQueue: Tool = {
    name: "sys_restart_queue",
    description: "待重启队列:修复已完成但需重启网关才生效的条目。派发同类修复前先 action=list,避免同一状态点重复派发;action=add 入队;action=close 确认生效后关闭。RSI/自身不得重启网关——重启仍需用户明确同意后走 sys_restart。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "close"], description: "list=看队列;add=入队;close=关闭" },
        id: { type: "string", description: "close 的条目 id" },
        title: { type: "string", description: "add 的标题(状态点;同状态点已有 pending 会去重)" },
        reason: { type: "string", description: "add 的原因" },
        taskId: { type: "string", description: "关联任务 id(可选)" },
        sessionId: { type: "string", description: "关联会话 id(可选)" },
      },
      required: ["action"],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const a = args as { action?: string; id?: string; title?: string; reason?: string; taskId?: string; sessionId?: string };
      const face = deps.sysAdmin?.restartQueue;
      if (!face) return "待重启队列未接线(本网关未启用)";
      const action = String(a.action ?? "").trim();
      if (action === "list") {
        const rows = face.list();
        return rows.length === 0 ? "待重启队列为空(没有等待重启生效的修复)。" : JSON.stringify(rows);
      }
      if (action === "add") {
        const title = String(a.title ?? "").trim();
        if (!title) return "title 必填";
        const r = face.add({ title, ...(a.reason ? { reason: String(a.reason) } : {}), ...(a.taskId ? { taskId: String(a.taskId) } : {}), ...(a.sessionId ? { sessionId: String(a.sessionId) } : {}) });
        if (!r.ok) return "入队失败:" + String(r.error ?? "未知原因");
        return r.duplicate === true ? "同状态点已有待重启条目(" + String(r.id) + "),未重复入队。" : "已入待重启队列:" + String(r.id);
      }
      if (action === "close") {
        const id = String(a.id ?? "").trim();
        if (!id) return "id 必填";
        const r = face.close(id);
        return r.ok ? "已关闭待重启条目:" + id : "关闭失败:" + String(r.error ?? "未知原因");
      }
      return "action 只支持 list|add|close";
    },
  };
  const sysProvider: Tool = {
    name: "sys_provider",
    description: "服务商与模型管理(与设置页同源):action=list 目录+凭证在场+生效轨;action=probe 连通探测(拉模型清单);action=set 写服务商条目(name/baseUrl/apiKeyEnv 变量名/模型目录),setEffective 可同时切 coding 生效轨。密钥值写入只走面板设置页——Super 不受理 key 值(防入对话/journal),其余字段都可配。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "probe", "set"], description: "list=目录;probe=连通;set=写条目" },
        providerId: { type: "string", description: "probe/set 的服务商 id" },
        entry: { type: "object", description: "set 时的条目字段:name/baseUrl/apiKeyEnv(环境变量名,非 key 值)/models(模型名字符串数组)" },
        setEffective: { type: "boolean", description: "set 时同时把 coding 生效轨切到该服务商" },
        model: { type: "string", description: "setEffective 时的生效模型(缺省=目录首个)" },
      },
      required: ["action"],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const a = args as { action?: string; providerId?: string; entry?: { name?: string; baseUrl?: string; apiKeyEnv?: string; models?: string[] }; setEffective?: boolean; model?: string };
      if (!deps.sysAdmin) return "系统配置面未接线(本网关未启用配置通道)";
      const view = sysCfgOf();
      const keys = deps.sysAdmin.secretKeys();
      if (a.action === "list") {
        const llm = view?.config?.coding?.llm;
        return JSON.stringify({
          providers: (view?.config?.providers ?? []).map((p) => ({
            id: p.id, name: p.name || p.id, baseUrl: p.baseUrl,
            keyEnv: p.apiKeyEnv ?? "", keyPresent: keyPresent(p.apiKeyEnv, keys),
            models: (p.models ?? []).map((m) => (typeof m === "string" ? m : String((m as { name?: string }).name ?? ""))).slice(0, 30),
          })),
          effectiveCoding: llm ? { providerId: llm.providerId ?? "(自配 baseUrl)", model: llm.model ?? "", baseUrl: llm.baseUrl ?? "" } : null,
          hint: "密钥值写入走面板「设置 → 服务商」;probe 可测连通。",
        });
      }
      if (a.action === "probe") {
        const pid = String(a.providerId ?? "").trim();
        const target = view?.config?.providers?.find((p) => p.id === pid);
        if (!pid || !target) return `未找到服务商 ${pid || "(空)"};先 action=list 看目录。`;
        try {
          const ids = await deps.sysAdmin.listModels(pid);
          return JSON.stringify({ ok: true, providerId: pid, models: ids.slice(0, 50) });
        } catch (err) {
          return JSON.stringify({ ok: false, providerId: pid, error: String(err).slice(0, 200) });
        }
      }
      if (a.action === "set") {
        const id = String(a.providerId ?? "").trim();
        const entry = a.entry ?? {};
        if (!id) return "providerId 必填";
        if (!entry.baseUrl && !entry.models?.length && !entry.apiKeyEnv && !entry.name) return "entry 至少给 name/baseUrl/apiKeyEnv/models 之一";
        if (entry.apiKeyEnv && (entry.apiKeyEnv.length > 64 || /\s/.test(entry.apiKeyEnv) || /^(sk-|gx-|bearer)/i.test(entry.apiKeyEnv))) {
          return "apiKeyEnv 只接受环境变量名(如 DASHSCOPE_API_KEY);检测到疑似密钥值——密钥值永不进对话,请走面板「设置 → 服务商」。";
        }
        if (view?.readOnly) return "配置只读(panelReadOnly 运行态),禁止修改。";
        const old = view?.config?.providers ?? [];
        const idx = old.findIndex((p) => p.id === id);
        const fallback: NonNullable<SysConfigShape["providers"]>[number] = { id, baseUrl: "" };
        const base: NonNullable<SysConfigShape["providers"]>[number] = (idx >= 0 ? old[idx] : undefined) ?? fallback;
        const merged: NonNullable<SysConfigShape["providers"]>[number] = {
          id,
          name: entry.name ?? base.name ?? id,
          baseUrl: entry.baseUrl ?? base.baseUrl,
          ...(entry.apiKeyEnv ? { apiKeyEnv: entry.apiKeyEnv } : base.apiKeyEnv ? { apiKeyEnv: base.apiKeyEnv } : {}),
          ...(entry.models?.length ? { models: entry.models } : base.models?.length ? { models: base.models } : {}),
        };
        const providers = idx >= 0 ? old.map((p, i) => (i === idx ? merged : p)) : [...old, merged];
        const patch: Record<string, unknown> = { providers };
        if (a.setEffective) {
          const model = String(a.model ?? (entry.models ?? [])[0] ?? (merged.models ?? [])[0] ?? "");
          if (!model || typeof model !== "string") return "setEffective 需要模型:给 model 或 entry.models";
          patch.coding = { llm: { providerId: id, baseUrl: merged.baseUrl, ...(merged.apiKeyEnv ? { apiKeyEnv: merged.apiKeyEnv } : {}), model } };
        }
        const r = deps.sysAdmin.configSet(patch);
        return JSON.stringify(r);
      }
      return "action 只支持 list|probe|set";
    },
  };
 // super 派发任务的权限自决(未接线=不注册,super 拿不到该工具也就无法越权替用户点头)。
  const permissionDecideTool: Tool | undefined = deps.permissionDecide
    ? {
        name: "permission_decide",
        description: "对 coding agent 的权限申请立刻作决定(requestId 来自「[权限申请·requestId=...]」原文,不得猜造)。decision: allow=任务书范围与红线内批准;deny=违反红线或越出任务书授权(须在 reason 写清理由);escalate=仅当明显超出任务书授权且涉及用户数据/全局配置/不可逆操作时升级给主人。同一 requestId 只决一次;不调本工具=该申请按「super 未决」升级给主人。",
        parameters: {
          type: "object",
          properties: {
            requestId: { type: "string", description: "申请原文里的 requestId" },
            decision: { type: "string", enum: ["allow", "deny", "escalate"], description: "allow=批准;deny=拒绝(必须给理由);escalate=升级给主人(仅越权且涉用户数据/全局配置/不可逆操作)" },
            reason: { type: "string", description: "一句话理由(deny 必填;会回灌到任务会话与指挥台留痕)" },
          },
          required: ["requestId", "decision"],
        },
        isConcurrencySafe: () => false,
        async execute(args) {
          const a = args as { requestId?: string; decision?: string; reason?: string };
          const map: Record<string, "allow-once" | "reject" | "escalate"> = { allow: "allow-once", deny: "reject", escalate: "escalate" };
          const d = map[String(a.decision ?? "").trim().toLowerCase()];
          if (!d) return "decision 必须是 allow / deny / escalate";
          const r = deps.permissionDecide!(String(a.requestId ?? "").trim(), d, String(a.reason ?? "").slice(0, 300));
          if (!r.ok) return `未决失败:${r.error ?? "申请已失效"}(可能已超时升级给主人)`;
          return d === "escalate" ? "已升级给主人,等待用户答复" : d === "allow-once" ? "已批准,coding agent 继续执行" : "已拒绝,coding agent 收到拒绝理由";
        },
      }
    : undefined;
  return [...exploreTools, listProjects, listNodes, projectAdd, projectRemove, spawnTask, listTasks, taskStatus, taskCancel, taskResend, taskResult, recallTasks, taskResume, relayAnswer, ...(permissionDecideTool ? [permissionDecideTool] : []), sysStatus, sysConfig, sysProvider, sysLogs, sysRestart, sysRsi, sysRestartQueue, memoryTool(soulStore)];
}

// ── fixC5/C6: super agent 活跃跟踪 + 转接/播报通道 ──

/** super agent 指挥台活跃窗口:最近一次 super.turn / voice.transcribe 之后的这段时间内
 * 视为活跃(转接与终态播报的主动轮次触发判据)。 */
export const SUPER_AGENT_ACTIVE_WINDOW_MS = 10 * 60_000;

export class SuperAgentActivity {
  private lastAt = 0;
  mark(): void { this.lastAt = Date.now(); }
  active(now = Date.now()): boolean { return now - this.lastAt < SUPER_AGENT_ACTIVE_WINDOW_MS; }
}

/** fixC6: 失败播报建议(确定性映射;模型仍会按上下文组织口语)。 */
export function failureAdvice(result: string): string {
  const r = result.toLowerCase();
  if (/model_not_found|model not found|模型不存在|does not exist/.test(r)) return "建议:像是模型不存在——问用户要不要换模型。";
  if (/401|unauthorized|api key|apikey|凭证|鉴权/.test(r)) return "建议:像凭证问题——问用户是否检查 API Key。";
  if (/429|rate.?limit|限流|quota/.test(r)) return "建议:像限流——可稍后用重发。";
  if (/timeout|超时|etimedout/.test(r)) return "建议:像超时——可用重发给它再来一次。";
  return "建议:可用任务结果看详情,或重发给它再来一次。";
}

/** fixC6: 终态播报文本(结果摘要 200 字;failed 附建议)。 */
export function buildTaskNotice(task: Task): string {
  const title = String(task.title ?? task.instruction).slice(0, 40);
  const result = String(task.result ?? "").replace(/\s+/g, " ").slice(0, 200);
  const head = `[系统通知] 任务「${title}」已${task.state === "done" ? "完成" : task.state === "failed" ? "失败" : "取消"}`;
  if (task.state === "failed") return `${head}:${result || "(无失败信息)"} ${failureAdvice(String(task.result ?? ""))}`;
  return `${head}:${result || "(无结果摘要)"}`;
}

/** fixC5: 转接文本(requestId 必须在原文里——relay_answer 回交要用)。 */
export function buildRelayText(p: { requestId: string; question: string; options?: string[]; context?: string }): string {
  const opts = p.options?.length ? `\n选项:${p.options.join(" / ")}` : "";
  const ctx = p.context ? `\n背景:${String(p.context).slice(0, 300)}` : "";
  return `[系统转接·requestId=${p.requestId}] coding 助手在任务里向用户提问:\n问题:${p.question}${opts}${ctx}\n请把问题原样转述给用户(有选项念选项),等用户口头答复,不要自己作答。若对话里已有用户的口头回答,直接调 relay_answer 交回。`;
}

/** :权限申请注入正文(super 自决入口;requestId 原样保留,permission_decide 要用它)。 */
export function buildPermissionAskText(input: { requestId: string; taskId?: string; tool: string; summary: string; risk?: string; brief?: string }): string {
  const head = `[权限申请·requestId=${input.requestId}] 你派发的任务${input.taskId ? `(${input.taskId.slice(0, 8)})` : ""}的 coding agent 请求权限,需要你自决:`;
  const lines = [
    `- 工具:${input.tool}`,
    `- 申请内容:${String(input.summary ?? "").slice(0, 300)}`,
    `- 风险级:${input.risk ?? "medium"}`,
  ];
  if (input.brief) lines.push(`- 任务书(节选,范围与红线依据):${String(input.brief).slice(0, 1500)}`);
  lines.push(`按「权限自决」策略立刻调 permission_decide(requestId=${input.requestId}, decision=allow|deny|escalate, reason=...)。不决 = 按「super 未决」升级给主人。`);
  return [head, ...lines].join("\n");
}

export interface SuperAgentChannelOptions {
  activity: SuperAgentActivity;
  broadcast: (msg: Record<string, unknown>) => void;
}

/**
 * super agent 通道——任务状态播报 + ask_user 转接(起出站只发 super.*)。
 * - 通知/转接一律落 journal(super.notice / super.relay,super 会话)——
 *   buildSuperAgentSystem 的「近期系统注入」块让下一轮自动可见;
 * - 同时广播协议消息(super.notice / super.relay)给指挥台面板;
 * - 任务进 interrupted/blocked/failed 时额外广播 super.inbox.changed(廉价触发,面板重拉 inbox);
 * - super agent 活跃(最近 SUPER_AGENT_ACTIVE_WINDOW_MS 内有 turn)→ 主动出一轮指挥台轮次
 *   (输入=通知/转接文本)→ 一句话播报/转述 → super.turn.done 推面板;
 * - 轮次串行化:同一时刻至多一个 super agent 轮次在跑(journal 事件不交错)。
 */
export class SuperAgentChannel {
  private seen = new Set<string>();
  private selfManaged = new Set<string>();
 /** spawn_task 派出的任务 id(终态必播;播完/终态即删,防泄漏)。 */
  private dispatched = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: SuperAgentDeps,
    private readonly soulStore: MemoryStore,
    private readonly opts: SuperAgentChannelOptions,
  ) {
    this.deps.channel = this;
  }

  /** 管家本轮内自己操作过的任务(如 task_cancel):终态通知照落,但跳过主动播报轮次(已当面说明)。 */
  markSelfManaged(taskId: string): void {
    this.selfManaged.add(taskId);
    if (this.selfManaged.size > 200) this.selfManaged.clear();
  }

 /** 亲自派出的任务(spawn_task)——终态**必播**,不随活跃窗(10min)过期。
 * 依据:d791e18b 画布走查跑 32 分钟,Super 09:44 后无轮次,10:06 done 时 activity 已过期 →
 * 静默,违背纪律承诺「已派出,完成会告诉你」;notice/feed 仍在,但聊天窗无人说话。 */
  markDispatched(taskId: string): void {
    this.dispatched.add(taskId);
    if (this.dispatched.size > 500) this.dispatched.clear();
  }

  /** 可能触发 inbox 变化的终态(契约 §2:interrupted/blocked/failed 额外廉价触发)。 */
  private static readonly INBOX_STATES = new Set(["interrupted", "blocked", "failed"]);

  onTaskChanged(task: Task): void {
    const terminal = task.state === "done" || task.state === "failed" || task.state === "cancelled";
    if (!terminal && !SuperAgentChannel.INBOX_STATES.has(task.state)) return;
    const key = `${task.id}:${task.state}`;
    if (this.seen.has(key)) return; // fixC6: 同任务同状态只播一次
    this.seen.add(key);
    if (this.seen.size > 2000) this.seen.clear();
    const text = buildTaskNotice(task);
    this.deps.journal.append({ kind: "super.notice", sessionId: superSessionId(), payload: { taskId: task.id, state: task.state, text } });
    this.opts.broadcast({ v: 1, type: "super.notice", text, taskId: task.id, state: task.state });
 // 消息体化:任务终态通知也广播结构化事件帧(旧 super.notice 之外加发,兼容回退)。
    this.opts.broadcast({ v: 1, type: "super.event", kind: "notice", sessionId: superSessionId(), taskId: task.id, payload: { state: task.state, summary: text.slice(0, 400) } });
    if (SuperAgentChannel.INBOX_STATES.has(task.state)) this.opts.broadcast({ v: 1, type: "super.inbox.changed" });
    if (!terminal) return;
    const selfManaged = this.selfManaged.has(task.id);
    this.selfManaged.delete(task.id);
    const promised = this.dispatched.delete(task.id); // 亲自派出的任务终态必播(承诺优先于活跃窗)
    if (selfManaged || (!promised && !this.opts.activity.active())) return;
    void this.serialize(() => this.announce(text, { event: { kind: "notice", taskId: task.id } }));
  }

  relayAsk(p: { requestId: string; sessionId: string; question: string; options?: string[]; context?: string }): void {
    const text = buildRelayText(p);
    this.deps.journal.append({ kind: "super.relay", sessionId: superSessionId(), payload: { requestId: p.requestId, text } });
    this.opts.broadcast({
      v: 1, type: "super.relay", requestId: p.requestId, sessionId: p.sessionId,
      question: String(p.question).slice(0, 800),
      ...(p.options?.length ? { options: p.options.slice(0, 6) } : {}),
      ...(p.context ? { context: String(p.context).slice(0, 1200) } : {}),
    });
 // 消息体化:转接也广播结构化事件帧(旧 super.relay 之外加发,兼容回退)。
    this.opts.broadcast({
      v: 1, type: "super.event", kind: "relay", sessionId: p.sessionId, requestId: p.requestId,
      payload: { question: String(p.question).slice(0, 800), ...(p.options?.length ? { options: p.options.slice(0, 6) } : {}), ...(p.context ? { context: String(p.context).slice(0, 1200) } : {}) },
    });
    if (!this.opts.activity.active()) return;
    void this.serialize(() => this.announce(text, { event: { kind: "relay", requestId: p.requestId } }));
  }

 /** :super 派发任务的权限申请 -> 排队跑一轮自决(忙时排队不并发;
 * 超时/未决/异常由 SuperApprovalRouter 升级转用户,不静默)。 */
  requestPermissionDecision(
    input: { requestId: string; taskId?: string; sessionId: string; tool: string; summary: string; risk?: string; brief?: string },
    onDelivered?: () => boolean,
  ): Promise<void> {
    const text = buildPermissionAskText(input);
    const notice = `[super 审批] 任务 ${input.taskId ? input.taskId.slice(0, 8) : input.sessionId.slice(0, 12)} 申请 ${input.tool}:${String(input.summary ?? "").slice(0, 80)}(super 自决中)[rid=${input.requestId}]`;
 // 修正:送达回执与「自决中」留痕都必须落在**轮次真正开始**的时刻(本 job 内)。
 // 旧实现写在入队处:排队期(super 串行队列,经验证 70~163s)就宣告「自决中」,且决策窗从入队起算,
 // 导致 super 的合法 allow 撞「申请已失效」。onDelivered 返回 false=排队期间已升级/已决:
 // 跳过本申请,不向 super 注入过期申请、不白跑一轮 LLM。
    return this.serialize(async () => {
      if (onDelivered && !onDelivered()) return;
      try {
        this.deps.journal.append({ kind: "super.notice", sessionId: superSessionId(), payload: { text: notice, ...(input.taskId ? { taskId: input.taskId } : {}), state: "permission" } });
      } catch { /* 留痕失败不碰主链 */ }
      this.opts.broadcast({ v: 1, type: "super.notice", text: notice, ...(input.taskId ? { taskId: input.taskId } : {}), state: "permission" });
 // 消息体化:结构化事件帧(旧 super.notice 之外加发,旧客户端按旧帧渲染=兼容回退)。
      this.opts.broadcast({
        v: 1, type: "super.event", kind: "permission-ask", sessionId: input.sessionId, requestId: input.requestId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        payload: { tool: input.tool, summary: String(input.summary ?? ""), risk: String(input.risk ?? ""), ...(input.brief ? { brief: String(input.brief).slice(0, 400) } : {}) },
      });
      await runSuperAgentTurn(this.deps, text, this.soulStore, {
        event: { kind: "permission-ask", requestId: input.requestId, tool: input.tool, risk: input.risk ?? "" },
      });
    });
  }

 /** fixC5: 用户轮次也进串行队列——与播报/转述轮次互斥(经验证竞态:用户对转接的答复与
   * 管家转述轮次并发跑,两边互相看不见,答复轮把转述复读一遍而没走 relay_answer)。
 * 音频入参已删除(语音先走 voice.transcribe → 文本 → 本方法)。 */
  turn(text: string, attachments?: AttachmentLike[]): Promise<string> {
    return this.serialize(async () => (await runSuperAgentTurn(this.deps, text, this.soulStore, { attachments })).text);
  }

  private serialize<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job);
    this.queue = run.catch(() => { /* fail-soft:单次播报失败不断链 */ });
    return run;
  }

  private async announce(input: string, opts: { event?: Record<string, unknown> } = {}): Promise<void> {
    try {
      const r = await runSuperAgentTurn(this.deps, input, this.soulStore, opts.event ? { event: opts.event } : {});
      this.opts.broadcast({ v: 1, type: "super.turn.done", text: r.text, sessionId: superSessionId() });
    } catch (err) {
      this.opts.broadcast({ v: 1, type: "error", code: "super-announce-failed", message: String(err).slice(0, 200) });
    }
  }
}

/** 跑一轮 super agent 对话(每轮重建 loop=全局摘要常新;journal 连续性由 sessionId 保证)。
 * 附件随轮次透传(与 coding 轨同一注入纯函数);会话级模型覆盖经 resolveTurnModel 派生。 */
export async function runSuperAgentTurn(
  deps: SuperAgentDeps,
  text: string,
  soulStore: MemoryStore,
  opts: { attachments?: AttachmentLike[]; event?: Record<string, unknown> } = {},
): Promise<{ text: string }> {
  const sid = superSessionId();
  const turnModel = deps.resolveTurnModel?.(sid);
 // 附件注入:文本/文档=路径进「## 附件」块;图片=进视觉通道(buildAttachmentInjection 自带超限/超张数原因行)。
  const atts = opts.attachments ?? [];
  const injected = atts.length
    ? buildAttachmentInjection(atts, (p) => readFileSync(p), { sizeOf: (p) => statSync(p).size })
    : { block: "", visionImages: [] as string[] };
 // 视觉降级不静默:模型明确无视觉能力时图片不进通道(否则整轮 400),块内如实写原因并保留路径。
  const hasImage = atts.some((a) => String(a.mime ?? "").startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(a.name));
  const visionOff = turnModel?.vision === false && hasImage;
  const visionImages = visionOff ? [] : injected.visionImages;
  const degradeNote = visionOff
    ? "\n- [视觉降级] 当前模型 " + String(turnModel?.model ?? "(会话模型)") + " 不支持视觉输入:图片未进视觉通道,仅保留文件路径(需要内容时用 read_attachment 等工具读取)。"
    : "";
  const instruction = atts.length ? text + injected.block + degradeNote : text;
  const loop = new AgentLoop({
    journal: deps.journal,
    sessionId: sid,
    system: buildSuperAgentSystem(deps, soulStore),
    llm: turnModel?.llm ?? deps.llm,
 // super agent 轨同享 LLM 轨迹(全量 messages+响应,.genie/llm-trace/)。
    llmTrace: makeLlmTraceSink(deps.journal),
    tools: buildSuperAgentTools(deps, soulStore),
 // 上下文经济面(coding 同源):超阈自动压缩/组清理/超大结果落盘。
    ...(deps.contextEconomy?.compactHook ? { compactHook: deps.contextEconomy.compactHook } : {}),
    ...(deps.contextEconomy?.microcompact ? { microcompact: deps.contextEconomy.microcompact } : {}),
    ...(deps.contextEconomy?.spill ? { spill: deps.contextEconomy.spill } : {}),
    maxSteps: 6,
    // 写前持久化屏障(config.agent.writeBarrier):undefined 不写键 → loop 缺省 hard,行为同旧版。
    ...(deps.writeBarrier ? { writeBarrier: deps.writeBarrier } : {}),
 //  图片 offload:管家轮次也可能带图(视觉输入),与 coding 轨同根落盘 .genie/image-offload/。
    ...(deps.imageOffload ? { imageOffload: deps.imageOffload } : {}),
 // Super 轮次流式(与 coding 轨同款 relay;缺省不传=旧行为)
    ...(deps.onStream ? { onStream: deps.onStream } : {}),
  });
 // 收尾聚合(/////):与主 agent 同一实现;super 轮次 warn-only,
  // 绝不 hardFail,终稿只追加紧凑「## 收尾审计」段(全 na 不追加)。
  const startSeq = deps.journal.length;
  // 基线采集与 runTurn 并发(git status 在大仓上秒级;不阻塞用户轮次)。
  const baselinePromise = captureBaseline(repoRoot()).catch(() => null);
  const out = await loop.runTurn(
    instruction,
    visionImages.length ? visionImages : undefined,
 // 消息体化:event 在场=系统来源输入(权限自决/转接/通知)→ loop 落 message.system
 // (payload:{ text, event }),不再伪装用户消息;用户直发 turn 不传 event=照旧 message.user。
    opts.event ? { event: opts.event } : undefined,
  );
 // 落盘兜底:轮内事件(turn.start/message.user/message.agent)依赖 write-behind 的
  // microtask 批冲刷(正常毫秒级落盘)。11-09 取证口径修正:.genie/llm-trace/super:<date> 目录实为
 // companion.test.ts 的测试运行(假 LLM 固定回复文本与 trace 逐字同源),生产环境从未跑过真实 super 轮;
  // 轮末显式 flush 一次,把「轮次完成⇒字节在盘」变成确定性不变量,防重启窗口丢尾批
  // (best-effort,失败不碰主链;MemoryJournal 无此方法,no-op)。
  try {
    (deps.journal as { flush?: () => void }).flush?.();
  } catch { /* 兜底失败不影响轮次返回 */ }
  try {
    const baseline = await baselinePromise;
    const closeout = await runTaskCloseout({
      journal: deps.journal,
      sessionId: superSessionId(),
      taskId: superSessionId(),
      root: repoRoot(),
      taskStartSeq: startSeq,
      state: "done",
      finalText: out,
      mode: "super",
      ...(baseline ? { baseline } : {}),
    });
    return { text: closeout.finalText };
  } catch {
    return { text: out };
  }
}

// ── 指挥台 inbox 聚合 ──

/** inbox 数据源(显式传入,不给 super-agent 引入 router/permission/task-manager 之外的依赖面)。 */
export interface SuperInboxSources {
  /** ask_user 挂起清单(AskUserRouter.pending(),旧者在前)。 */
  asks?: { requestId: string; sessionId: string; question: string; options?: string[]; since: number }[];
  /** 权限审批挂起(PermissionBroker.pendingList())。 */
  permissions?: { requestId: string; sessionId: string; tool: string; summary: string; risk: string; since: number }[];
  /** 任务全量(TaskSupervisor.list());从中取 interrupted/blocked 与近 24h failed。 */
  tasks?: Task[];
  /** 当前时刻(测试注入)。 */
  now?: number;
}

const INBOX_ACTION: Record<string, string[]> = {
  ask: ["answer", "dismiss"],
  permission: ["approve", "dismiss"],
  interrupted: ["resume", "open"],
  blocked: ["resume", "open"],
  failed: ["open", "dismiss"],
};

const clip = (s: string, n: number): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** 聚合指挥台待处理清单(契约 §2):ask/permission/interrupted/blocked 在前按 since 升序,
 * failed 在末尾按 since 降序;总数上限 limit(默认 30)。 */
export function buildSuperInbox(
  deps: Pick<SuperAgentDeps, "taskManager">,
  sources: SuperInboxSources = {},
  limit = 30,
): SuperInboxItem[] {
  const now = sources.now ?? Date.now();
  const head: SuperInboxItem[] = [];
  const failed: SuperInboxItem[] = [];
  const actions = (kind: string) => (INBOX_ACTION[kind] ?? ["open"]) as ("answer" | "approve" | "open" | "resume" | "dismiss")[];

  for (const a of sources.asks ?? []) {
    head.push({
      id: `ask-${a.requestId}`, kind: "ask",
      title: clip(a.question, 60),
      summary: clip(`${a.options?.length ? `选项:${a.options.join(" / ")} · ` : ""}会话 ${a.sessionId}`, 200),
      since: a.since, sessionId: a.sessionId, requestId: a.requestId, actions: actions("ask"),
      ...(a.options?.length ? { options: a.options.slice(0, 6) } : {}),
    });
  }
  for (const p of sources.permissions ?? []) {
    head.push({
      id: `perm-${p.requestId}`, kind: "permission",
      title: clip(`需要授权:${p.tool}`, 60),
      summary: clip(`${p.risk ? `[${p.risk}] ` : ""}${p.summary} · 会话 ${p.sessionId}`, 200),
      since: p.since, sessionId: p.sessionId, requestId: p.requestId, actions: actions("permission"),
    });
  }
  const tasks = sources.tasks ?? deps.taskManager.list();
  for (const t of tasks) {
    const label = clip(String(t.title ?? t.instruction), 60);
    if (t.state === "interrupted" || t.state === "blocked") {
      head.push({
        id: `task-${t.id}`, kind: t.state,
        title: clip(`任务${t.state === "interrupted" ? "被中断" : "受阻"}:${label}`, 60),
        summary: clip(`会话 ${t.sessionId}${t.projectId ? ` · 工作区 ${t.projectId}` : ""}`, 200),
        since: t.updatedAt, sessionId: t.sessionId, taskId: t.id, actions: actions(t.state),
      });
    } else if (t.state === "failed" && now - t.updatedAt <= 24 * 3600_000) {
      failed.push({
        id: `task-${t.id}`, kind: "failed",
        title: clip(`任务失败:${label}`, 60),
        summary: clip(`会话 ${t.sessionId}${t.result ? ` · ${String(t.result)}` : ""}`, 200),
        since: t.updatedAt, sessionId: t.sessionId, taskId: t.id, actions: actions("failed"),
      });
    }
  }
  head.sort((a, b) => a.since - b.since);
  failed.sort((a, b) => b.since - a.since);
  return [...head, ...failed].slice(0, Math.max(0, limit));
}

// ── 更名兼容别名(双写期):audio/companion agent → super agent;旧调用面
// (agent-wiring/test/e2e 等)不改不破;旧名删除时点随 U3 拍板(下一面板版本发布后)。──
export type CompanionDeps = SuperAgentDeps;
export { SuperAgentActivity as CompanionActivity };
export { SuperAgentChannel as CompanionChannel };
export { runSuperAgentTurn as runCompanionTurn };
export { buildSuperAgentSystem as buildCompanionSystem };
export { buildSuperAgentTools as buildCompanionTools };
