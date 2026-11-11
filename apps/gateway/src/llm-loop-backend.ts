/**
 * 进程内 LLM 子代理后端(用户追问「没拷 ZCode 成熟逻辑」的:
 * ZCode Agent 工具的本质=再起一个带受限只读工具集的子 agent loop——harness 自己就有
 * AgentLoop,包成本后端即可,spawn_subagent 不再依赖外部 CLI/echo 占位)。
 * 只读工具集(read_file/list_dir/grep)+ roots 约束;readonly 语义天然满足。
 * 权限传递:装配方注入父会话有效规则(permissionRules)与审批链(onPermissionAsk),
 * 子 loop 工具调用过与主 agent 同语义的闸门——deny 拦/ask 走审批,无规则=不设闸(行为同旧版)。
 */
import type { LlmProvider } from "@lampgenie/runtime/agent/loop";
import { expandToolTokens, toolGrantMatched, writePathAllowed } from "@lampgenie/runtime/agent/agent-profiles";
import { renderSubagentHeavyOpDiscipline } from "@lampgenie/runtime/agent/system-composer";
import type { SubagentBackend, SubagentEvent, SubagentHandle, TaskResult, TaskSpec } from "@lampgenie/executors";
import { AgentLoop, type Message } from "@lampgenie/runtime/agent/loop";
import { checkRepeatRead, recordFileRead, readFilesOf, renderParentReadHint, type ReadFileEntry } from "@lampgenie/runtime/agent/read-file-state";
import { renderSystemReminder } from "@lampgenie/runtime/agent/reminder-source";
import { makeLlmTraceSink } from "./llm-trace.js";
import { attachToolView } from "./tool-view.js";
import { permissionMode } from "./permission-mode.js";
import { shellErrorHint, shellInvocation } from "./shell-invocation.js";
import { fenceCommand } from "./file-tools.js";
// 输入边界防御:子代理读/写入口与主 agent 同源(设备/伪文件→stat special→denylist→binary→read;
// 单行 clamp;编辑比例守卫)——子代理是同一进程里的第二条 read/write 通道,不能只锁主 agent。
import { BINARY_PROBE_BYTES, checkEditRatio, clampLine, looksBinaryBytes, readGuardPath, readHeadBytes } from "./input-boundary.js";
import { guardGitCommand, subagentGitBlockReason } from "./git-guard.js";
import { MemoryJournal } from "@lampgenie/core";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, isAbsolute, resolve, sep } from "node:path";
import type { DiagnosticItem, LspSettings } from "@lampgenie/lsp";
import { SENSE_TOOL_NAME } from "./sense-tool.js";
import { boardSkillIndex } from "./board-skills.js";
import { captureBaseline } from "./turn-change-ledger.js";
import { runTaskCloseout } from "./task-closeout.js";
import { DELIVERABLE_TOOL_NAME, makeDeliverableTool } from "./deliverables.js";
import { CITE_SOURCE_TOOL_NAME, makeCiteSourceTool } from "./citation-ledger.js";

/** code_sense 调用手册(explore 等只读子代理用户反馈「拿着 code_sense 只会用 grep」后补)。
 * 注入条件=code_sense 实际在授予工具面(与 skillGranted 同款门控);内容与 sense-tool.ts 的
 * action/mode 双面严格同源——手册列的动作必须全部可用,列了不可用的动作=诱导报错调用。 */
/** planner 板规范(分阶段技能化):只注入调度器+通用硬规则+板型索引;
 * 13 类画法拆到 board-skills.ts 的 <type>/collect|draw|audit,planner 判定 boardType 后
 * 用 skill_view(category="board") 按需加载——不再把所有类型规则一次性塞进系统提示。 */
export const PLANNER_BOARD_SPEC = [
  "planner 板规范(板的第一个职责=让人读懂现有代码/内容**现在怎么走**;code/test 板的主形态是「现状控制流程图 + 改动徽标」,不是模块清单、更不是 agent 的计划步骤树。你的实施计划写在 step.md,不上板):",
  "- **先判型,再按需加载(强制)**:开工先判定 boardType 与 scale;然后只加载该类型的三阶段技能:① skill_view(category=\"board\", name=\"<boardType>/collect\") 收集必备信息;② 同名 /draw 取画法与结构;③ 同名 /audit 交板前自检。未加载对应 skill 就画板=违规;禁止一次加载全部类型/凭记忆背 13 类规则。",
  "- **板型索引**:" + boardSkillIndex(),
  "- 板工具机制:落板前 tool_view(board_upsert) 看参数;板型画法不在工具描述里,按上面 board skill 加载;P0 节点必须带 accept;收尾 board_upsert action=audit 核对;P0 覆盖<100% 不宣称完成。",
  "- **code/test 板=现状控制流程图,不是模块清单、也不是计划步骤树**:主线 start(触发:用户动作/入口函数)→编号步骤(function)→decision(出边「是：…」「否：…」)/loop→end(结果出口);节点=现有代码里真实存在的步骤,每个步骤 flow 写 2~4 行**现有代码**动作(真实函数名+参数+条件+写入/广播),不是「我要做什么」。只有 function 卡 + call 边、无 start/decision 的模块清单式板判不合格,必须重画。骨架 ≤9 节点但必须含 start+end+≥1 decision,规模 M/L 主线 8~12 节点(最多 14);有真实遍历/重试用 loop;decision 出边不得指向会被面板剥离到侧栏的 note/aggregate/io 节点。禁把「写测试/跑验证/更新文档/实现 X/修复 Y」这类仓库里不存在的待办写成节点——它们留在 step.md。",
  "- **板首必须有主题节点(code 板强制校验;其它板型强烈建议)**:板的第一个节点讲清「这个大流程在系统里是干什么用的」+「本次开发内容改的是其中哪一环」——id 用 theme 开头或 group=主题,渲染时置顶横贯;只有一串步骤卡、读者看完不知道这流程干什么用的板判不合格。主题节点是现状描述(change=keep),不受 keep 节点「必须带结构化锚」约束(它不指向具体代码段)。",
  "- **change=节点上的改动徽标,不是节点**:步骤节点 targets 写「仓库相对路径#符号名」(如 packages/gateway/src/x.ts#createServer;或 targets 路径 + symbolRef{file,name});change 必填——keep=纯读不动(**绝大多数节点**,默认值)/modify=现有这段要改(必填 before 写现状一行)/add=这里现在没有、要新增/delete=要删。改动不是独立的节点,是画在对应现状节点上的标记;summary 要读出「这在仓库里是哪一段现有逻辑」,不写抽象动词。全 keep 板(纯读逻辑)是合格交付。accept 只对 modify/add/delete 节点要求,keep 节点免 accept;P0 语义=本轮会动的节点。",
  "- **其它板型**(docs/ui/data/contract/deploy/research…):同样以**现状**为主——只画被本次任务牵动的现有链路/区块/章节,不另画一层「计划步骤」;要改的地方用 change 徽标标在对应现状节点上,每个带徽标的节点回答四件事:①改哪里(targets+symbolRef)②在哪个流程(上游→本节点→下游)③改什么(change;modify/delete 必填 before 写现状)④内部怎么走(flow,分支写 cond+then/else)。有先后依赖的现有步骤 label 带序号(01 采集→02 处理)。",
  "- **通用硬规则(全板型;新板必须显式标 boardType/scale)**:① symbolRef 禁臆造,必先用 code_sense 查证,audit 须 linked(漂移刷行号);targets 非空(模板节点除外)。② modify/delete 必带 before(原行为/原代码锚点);不可逆改动必挂风险节点或回滚 accept。③ 步骤序号 01→02;边必须显式 label(方向=依赖/数据流向);boardType/scale 显式。④ 断言类节点(根因/结论/瓶颈/评分/推荐)必须有证据入边(verify/data,label 写「证据:file:line/日志/实测」),「合理的故事」不算证据。⑤ 数字/时间承诺(基线/阈值/窗口/日期/预算)必须带单位或日期+口径,禁「尽快/后续/适当」。⑥ 每条链路有可验证终点(verify 边落点);上游可回溯、下游可达,无孤儿节点。⑦ P0 accept 四类 command/browser/manual/negative,每条带 expect;含验证语义的板型至少 1 条负面断言。",
  "- **三阶段职责**:collect=查事实(目标文件/符号/上下游/数据格式/测试/现状 before),不画;draw=按该类结构画节点/边/flow/accept/scale;audit=linked/before/证据入边/链终点/无孤儿/typeIssues 逐条核对。",
  "- P0 节点(=本轮会动的节点)照挂 accept(命令/浏览器/人工/负面四类,每条标 type;命令类带 expect),keep 节点免 accept;每落实一个模块立刻 action=evidence 回填;用户对节点的评论必须在下一轮逐条回应,不得忽略。",
  "- **composition 板型(办公/产出类:汇报/PPT/文章/调研报告)=作业思路板**:boardType=\"composition\",节点=主题/受众/章节(章用 kind:\"section\",≥2 章,含主题/受众合计 ≥3 节点),边=章间关系(kind:data,label 写关系词:承接/递进/并列/对照/因果)+顺序。**不画执行步骤**——「先查资料→再写初稿→再校对」这类待办留在 step.md。composition 是表达结构不是代码契约,不出命令级 accept。",
  "- **确实没有开发内容 → 不要硬凑 todo 板**:纯环境探查/纯格式转换/纯问答任务不落板;硬凑一块「先看A→再改B」的 todo 板既过不了 plan-gate 也污染白板——用 **board_upsert 传 exemptReason=\"<为什么本任务没有开发内容/表达结构>\"(20~200 字)留痕豁免**;不许用豁免掩盖本该画的内容板。",
  "- **写文章/汇报类六问(动笔前逐条作答;六问的答案就是 composition 板的节点与边)**:主题是什么 / 受众是谁 / 表达结构是什么 / 要几章 / 每章内容主题是什么 / 章与章之间什么关系、顺序如何。",
  "- 降级诚实:你超时/失败/板为空时,主 agent 会内联规划(板照画、accept 照挂)并显式标注「planner 降级」——不许在结果里假装完整规划过。",
  "- 交板自检:按 <boardType>/audit 逐条;board_upsert/audit 的 contractIssues 与 typeIssues 必须清零;P0 规划态 0/N 正常,evidence 未回填不得 done;换 id 重画先用 action=prune 清旧节点,禁止两版并板。",
  "- 现状层自动预填:board_upsert 传 action=\"skeleton\"+symbols=[code_sense 查到的符号名]——工具从索引快照生成 keep 节点(锚已三态核验 linked)+真实 call 边;你只在回执底版上补变更层(add/modify 节点带 targets/before),不要手抄 file:line",
].join("\n");

export const SUBAGENT_CODE_SENSE_PLAYBOOK = [
  "code_sense 调用手册(代码认知优先于 grep/整读文件——静态索引毫秒级且已含调用关系;先查再读,零命中/索引缺席时才降级 grep 复核):",
  "- 认识项目:action=project(技术栈/框架指纹/入口/目录拓扑)→ mode=plan(架构主线+模块导读);入口清单 action=entrypoints(开工上下文通常已注入,复查才用)。",
  "- 符号关系:action=symbol,target=符号名(定义+调用者+被调者一次拿全);要调用链时序/更深闭包再上 mode=debug(query=符号名)。",
  "- 牵连/影响:action=impact,target=符号名(双向调用闭包+受影响文件+关联测试——回答「改这里会动哪里」的唯一入口)。",
  "- 字符串标识/配置键/消息 type:action=refs,target=字面量(按语境列 case/eq/object-key/宏/文档全部引用点,命中带所在分支标注——删字符串标识时 symbol/impact 全空,必须走这里)。",
  "- 条件/循环关系:action=branches,target=文件相对路径(if/elif/else 条件文本+while/for/switch 循环+三元,每个分支带直接调用的函数与所属函数——回答「这个调用在什么条件下发生」)。",
  "- 文件与变量:action=file(文件符号表);action=vars(变量类型分组清单)。",
  "- 领域画像:mode=api(HTTP 接口表面)/mode=state(状态机)/mode=algo(算法模块);本系统 WS 消息协议用 action=wire(union↔收发点/孤儿对账)。",
  "- 陌生仓/命名不确定:mode=explore(query 给具体关键词,标识符/术语,中英各试一次)。",
  "纪律:mode=debug 的 query 必须是代码符号名(禁目录/文件名/自然语言,传错=零命中);action 在场时 mode 忽略;索引可能过期(输出带过期提示时,关键结论用 grep 复核);报告引用一律带 file:line(工具输出已带,直接回链不要改写)。",
].join("\n");

/**
 * 编辑后检查( /):子代理 write/edit 与主 agent 同语义;包不可用=静默跳过。
 * baseline/baselineText:写前采集的基线诊断与旧内容(delta 只报新增;不传=旧行为全量报告)。
 */
async function editCheckSuffixSafe(
  root: string,
  absPath: string,
  settings?: LspSettings,
  baseline?: DiagnosticItem[] | null,
  baselineText?: string): Promise<string> {
  if (!settings || settings.enabled === false) return ""; // 低层缺省关闭:零装载开销
  try {
    const mod = await import("@lampgenie/lsp");
    return await mod.editCheckSuffix({ root, absPath, settings, baseline, baselineText });
  } catch {
    return "";
  }
}

/**
 * 写前 baseline 采集(与主 agent file-tools 同序):必须在 writeFileSync **之前**调用
 * —— tsc 兜底按磁盘内容建 program,落盘后采集到的是新内容。
 * @returns undefined=不做 delta(低层关闭 / baseline:false);{baseline:null}=采集失败(库标不可用,不阻塞写)。
 */
async function editBaselineSafe(
  root: string,
  absPath: string,
  prevText: string | undefined,
  settings?: LspSettings): Promise<{ baseline: DiagnosticItem[] | null; baselineText: string } | undefined> {
  if (!settings || settings.enabled === false) return undefined;
  if (settings.baseline === false) return undefined;
  if (prevText === "") return { baseline: [], baselineText: "" }; // 新文件:基线为空(不探测)
  if (prevText === undefined) return { baseline: null, baselineText: "" }; // 旧文本读不到=如实不可用
  try {
    const mod = await import("@lampgenie/lsp");
    return { baseline: await mod.collectBaselineDiagnostics({ root, absPath, text: prevText, settings }), baselineText: prevText };
  } catch {
    return { baseline: null, baselineText: prevText };
  }
}


// ---- 串台守卫:结果与任务书的相关度确定性评分;共享模型端点的服务端会话串扰
// 会把「别人的回答」喂给子代理——检测到即自动重派一次并标注,主 agent 不再需要人工判串台。 ----

/** 停用词(任务书脚手架词,不参与特征)。 */
const GUARD_STOP = new Set(["任务书", "只读", "禁止", "子代理", "子智能体", "验收", "标准", "输出", "报告", "工具", "完成", "必须", "目标", "背景", "要求", "工作", "目录", "文件", "代码", "仓库", "当前", "以下", "根据", "需要", "查清", "逐条", "给出", "证据", "路径", "命令", "修改", "任何", "不要", "操作", "探索", "定位", "相关", "重点", "回答", "结构", "模式", "确保", "使用", "调用", "具体", "最后", "以及", "并且", "或者", "然后", "关于", "这个", "那个", "they", "the", "and", "for", "with", "this", "that", "from", "into", "your", "task", "tool", "read", "write", "report"]);

/** 特征提取:CJK 二元组 + 拉丁词(≥3 字符),停用词滤除。 */
export function relevanceTokens(text: string): Set<string> {
  const out = new Set<string>();
  const t = String(text ?? "").slice(0, 2_000);
  for (const w of t.match(/[a-zA-Z][a-zA-Z0-9_.-]{2,}/g) ?? []) out.add(w.toLowerCase());
  const cjk = t.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  for (const seg of cjk) {
    for (let i = 0; i + 2 <= seg.length; i++) out.add(seg.slice(i, i + 2));
  }
  for (const w of [...out]) if (GUARD_STOP.has(w)) out.delete(w);
  return out;
}

/**
 * 串台判定:任务书特征在结果中的覆盖率。任务书特征 ≥6 且覆盖率 <0.15 → 判串台。
 * 纯确定性;阈值偏保守(误判一次重派的代价=多等一轮;漏判的代价=父 agent 拿垃圾)。
 */
/** 协议泄漏:模型把内部机制当正文输出——DSML 工具标签/think 推理段/任务书复述。 */
export function isProtocolLeak(instructions: string, result: string): boolean {
  const r = String(result ?? "");
  if (!r) return false;
  if (r.includes("｜DSML｜") || r.includes("<｜DSML｜")) return true;
  if (/<think>|<\/think>/.test(r)) return true;
  // 任务书头部复述:结果以任务书前 60 字的骨架开头(模型复读任务书而非执行)。
  const head = String(instructions ?? "").replace(/\s+/g, "").slice(0, 60);
  if (head.length >= 24 && r.replace(/\s+/g, "").includes(head)) return true;
  // 提示词形态(同域串扰的伪装形态):泄漏的是「另一段任务提示词」——满篇提问与作答要求,
  // 而报告的形态是给结论。≥2 个提示词标记且无报告标记 → 判泄漏。
  const promptMarkers = ["问题：", "回答要求", "重点回答", "请回答", "请给出可复现", "仓库路径：", "作答", "下述问题"];
  const reportMarkers = ["结论", "做了什么", "发现", "报告", "建议", "证据"];
  const pm = promptMarkers.filter((m) => r.includes(m)).length;
  const rm = reportMarkers.some((m) => r.includes(m));
  if (pm >= 3) return true; // 强提示词形态(要求句密集)即使带「结论」字样也是提示词(要求里常写「最后给结论」)
  if (pm >= 2 && !rm) return true;
  return false;
}

export function isCrosstalk(instructions: string, result: string): boolean {
  const task = relevanceTokens(instructions);
  if (task.size < 6) return false; // 任务书太短无法判定,宁纵勿枉
  const res = relevanceTokens(result);
  let hit = 0;
  for (const tok of task) if (res.has(tok)) hit++;
  return hit / task.size < 0.15;
}

/** 子代理是否已真实落板(串台守卫豁免判据)。
 * planner 的产出物是白板本身,终稿通常只是「板 id+节点数+分层」的短摘要;任务书长(3000+ 字)时
 * 词面覆盖率天然低于 0.15,会被 isCrosstalk 误杀并触发一次全量重派(经验证 planner 被误判后重跑,
 * 重复落板/拖长任务)。判据取子 loop 的**工具回执**(board_upsert 成功),不是模型自述——重派前
 * 已经落板即证明工作与任务书相关。 */
export function hasBoardWriteEvidence(entries: readonly { kind?: string; payload?: unknown }[]): boolean {
  for (const e of entries) {
    if (e.kind !== "tool.result") continue;
    const p = (e.payload ?? {}) as { name?: unknown; content?: unknown };
    if (String(p.name ?? "") !== "board_upsert") continue;
    const content = String(p.content ?? "");
    if (content.includes("设计白板已更新") && !/拒收|拒绝|失败/.test(content)) return true;
  }
  return false;
}

/** 产出纪律强制提醒节奏( P1-4):连续 N 步「只调工具、未输出任何文本」即向子 loop 注入
 * 一次硬提醒(与 deadlineWarn 同一 ephemeral 通道)。注意:两个 explore 子代理分别跑满 140 步 /
 * 263 次工具调用、45 步 / 50 次工具调用,**零文本产出**被时间盒收割——全部预算花在勘察上。
 * 只提醒节奏可配,判据与通道固定;已产出过文本=永不提醒(不打断正常推进)。 */
export const PRODUCTIVE_NUDGE_STEPS = 25;

/** 「实质产出」的最小字符数(修永久锁):一行「我来看看」也算文本,不能当产出。
 * 经验证:今日 18 个大 run(≥25 调用)里 16 个的「有文本步」占比 <15%,但旧判据用
 *  `seenText=true` 永久关闭 → 一行短文就把闸门焊死,一个都不会触发。 */
export const PRODUCTIVE_SUBSTANTIVE_CHARS = 200;

/** 产出纪律提醒 body(不含外层 reminder 标签;外层由登记源渲染,标签语法只此一处定义)。 */
function productiveNudgeBody(idleSteps: number): string {
  return "[产出纪律] 已连续 " + idleSteps + " 步只调工具、未输出任何文本结论。"
    + "现在立刻用一段文字写出:①已完成什么(带 file:line 证据)②结论是什么 ③还差什么。"
    + "写完再决定是否继续查。禁止再开新勘察方向。";
}

/** 强制产出提醒文本(与 task 口径同源:三段式 + 禁开新勘察方向)。
 * 走 reminder-source 的 productive-nudge 源(inline 形态,tip 之后);body 是固定文本,
 * 显式 escapeNested:false 避免双重处理。失败(理论不可达)回退旧完整串,零行为变化。 */
export function buildProductiveNudge(idleSteps: number): string {
  const body = productiveNudgeBody(idleSteps);
  const rendered = renderSystemReminder("productive-nudge", body, { inline: true, escapeNested: false });
  return rendered.ok ? rendered.text : "<system-reminder>" + body + "</system-reminder>";
}

/** 串台守卫兜底:从子 journal 事件流里逐条筛选「可用 agent 文本」。
 * 修:旧实现先拼接再整体判相关性,而拼接的末条往往就是刚被判串台的那份终稿 →
 * 同一把尺子再量一遍必然还是串台,**结构上不可能救回**(经验证真实 GLM 端到端任务仍打印
 *  「疑似串台…自动重派」,15 个 -retry 目录 / 230 次调用继续产生)。
 *  改为**逐条筛选**:每条 message.agent 文本单独过 isCrosstalk/isProtocolLeak,只有通过的才进候选;
 *  这样中间那些有实质产出的段落能留下,被污染的终稿被丢掉。 */
export function pickUsableAgentText(
  instructions: string,
  entries: readonly { kind?: string; payload?: unknown }[],
  limit = 3): { text: string; kept: number; dropped: number } {
  const kept: string[] = [];
  let dropped = 0;
  for (const e of entries) {
    if (e.kind !== "message.agent") continue;
    const t = String(((e.payload ?? {}) as { text?: unknown }).text ?? "").trim();
    if (!t) continue;
    if (isCrosstalk(instructions, t) || isProtocolLeak(instructions, t)) {
      dropped++;
      continue;
    }
    kept.push(t);
  }
  return { text: kept.slice(-limit).join("\n\n").trim(), kept: kept.length, dropped };
}

/** 串台守卫兜底(旧接口保留):只取最后几条非空 agent 文本,不做筛选。 */
export function collectUsableAgentText(entries: readonly { kind?: string; payload?: unknown }[], limit = 3): string {
  const texts: string[] = [];
  for (const e of entries) {
    if (e.kind !== "message.agent") continue;
    const t = String(((e.payload ?? {}) as { text?: unknown }).text ?? "").trim();
    if (t) texts.push(t);
  }
  return texts.slice(-limit).join("\n\n").trim();
}

/**
 * 串台兜底的"工作证据"判据(修「兜底永不生效」)。
 * 旧出口判据用 `!isCrosstalk(instructions, joined)` —— 但 joined 的末条往往就是刚被判串台的
 * 那份终稿,同一把尺子再量一遍必然还是串台,结构上不可能救回。经验证:真实 GLM 端到端任务日志
 * 仍打印「疑似串台…自动重派」,15 个 -retry 目录 / 230 次调用继续产生。
 * 新判据改成看**做过多少活**:成功的工具回执数(排掉错误/拒绝/超时)。理由:文本相关性只是词面
 * 覆盖率,任务书长或术语改写时天然偏低;但"这一轮确实跑了 N 个工具且成功"是硬证据。
 * 判据本身不放宽——协议泄漏仍一律重派,工作证据只替代"相关性"这一维。
 */
export function countToolWorkEvidence(entries: readonly { kind?: string; payload?: unknown }[]): { okTools: number; names: string[] } {
  const names: string[] = [];
  for (const e of entries) {
    if (e.kind !== "tool.result") continue;
    const p = (e.payload ?? {}) as { name?: unknown; content?: unknown };
    const content = String(p.content ?? "");
    if (!content) continue;
    // 明确的失败/拒绝形态不计工作量
    if (/^\s*\{\s*"ok"\s*:\s*false/.test(content)) continue;
    if (/拒收|拒绝|已被拦截|plan-gate|权限不足|执行超时/.test(content.slice(0, 200))) continue;
    names.push(String(p.name ?? "?"));
  }
  return { okTools: names.length, names };
}

/** 串台兜底放行的最小成功工具回执数(低于此仍重派:零星调用不足以证明完成了任务)。 */
export const CROSSTALK_GUARD_MIN_TOOLS = 3;

/** 串台兜底放行的最小可用文本字符数(一段话)。
 * 修:原为 200,但**逐条筛选后**剩下的往往只有中间那一段(经验证测试样例 ~145 字),
 *  200 会把「确实有可用产出」判成没有。120 仍是完整段落,足以承载结论。 */
export const CROSSTALK_GUARD_MIN_CHARS = 120;

export interface LlmLoopBackendOptions {
  llm: LlmProvider;
 /** 子代理单任务最大步数(缺省 1000,与主 agent 一致—— 取消强制结束,等自然结束信号)。 */
  maxSteps?: number;
  /** 写前持久化屏障(config.agent.writeBarrier 透传):"off"|"hard";缺省=loop 内部 hard(不改变现有行为)。
   *  首跑与串台重派两个 loop 必须同值(否则重派轮屏障口径与首轮不一致)。 */
  writeBarrier?: "off" | "hard";
  /** 工具扫描根约束(harness 根+激活项目根)。 */
  roots: string[];
 /** 子代理角色(完整机制移植:ZCode 按类型分工具集)。explore/judge/test-analyst=只读;worker/general=读+写+bash。 */
  role?: string;
  /** worker bash/write 的工作目录(=任务 workdir)。 */
  workdir?: string;
 /**  图片 offload 落盘根(provider 报图片预算/尺寸错误时 data URL 落 `<root>/.genie/image-offload/`)。
   *  缺省 = 子代理工作目录(workdir ?? roots[0]),与 bash/write 围栏同根;装配方(agent-wiring)传
   *  {root: repoRoot()} 与主 loop 同根。首跑与串台重派两个 loop 必须同值。 */
  imageOffload?: { root: string };
  /** 防死阈值:journal 零新增持续超过该时长→强制退出+卡点报告(缺省 600s;测试注入小值)。 */
  stallTimeoutMs?: number;
 /** spawn deadline(机制1,「子代理容易卡住不返回」根治):到点强制收割——
   * 子 loop 收中止信号,已有产出打包为部分结果交付(ok=true,finalText 显式标注「deadline 收割」),
   * 与用户取消(丢弃,ok=false cancelled)语义分离。0/缺省=不限时。 */
  deadlineMs?: number;
  /** deadline 触发后等待 loop 自行落终态的宽限(缺省 5s;挂死调用不响应 abort 时的二级保险;测试注入小值)。 */
  deadlineGraceMs?: number;
  /** 产出纪律强制提醒节奏(P1-4):连续 N 步零文本产出即注入一次硬提醒;
   * 缺省 PRODUCTIVE_NUDGE_STEPS(25);0=关闭(行为同旧版)。 */
  productiveNudgeSteps?: number;
  /** 无产出预警阈值(机制3):超过该时长无任何新工具调用→output.txt 写 [warn] 行
   * (task_output 侧另有 stale 标记,见 agent-wiring 注册表 lastEventAt)。缺省 20 分钟。 */
  staleWarnMs?: number;
  /** 心跳节流间隔(机制2):每个 step/tool 节点的进度行至多该间隔一条(慢盘防写放大)。缺省 2s。 */
  heartbeatMs?: number;
 /** 子代理权限闸门规则(权限传递):父会话有效规则快照——已允许的传递下去;
   * 缺省=不设闸(父无规则时行为与旧版一致)。此前本后端完全忽略 TaskSpec.permissionRules,
   * deny 规则对进程内子代理形同虚设(「derived」journal 事件只是仪式)。 */
  permissionRules?: import("@lampgenie/core").PermissionRule[];
  /** 子工具 ask 命中的审批回调(true=放行;拒绝/异常=按拒绝 fail-closed)。
   * 缺省=ask 按 deny 兜底(进程内子代理无自带审批面,链路由装配方注入)。 */
  onPermissionAsk?: (tool: string, summary: string) => Promise<boolean>;
 /** 父子 ask-answer:重操作(build/install/全量测试/递归批处理)命中时向父 agent 申请。
   * 提供时子 loop 闸门配 heavyOp{callerIsSubagent:true,onHeavyAsk→本回调}——绕过 allow 规则强制审批,
   * 超时/拒绝=按拒绝(fail-closed,由 broker 侧裁决);缺席=无重操作闸(行为同旧版)。 */
  parentAsk?: (input: { taskId: string; role: string; tool: string; command: string; match: import("@lampgenie/core").HeavyOpMatch }) =>
    Promise<{ approved: boolean; reason?: string; by: string }>;
 /** 读传递( D3 跨 agent 读重叠治理):父会话已读清单键。提供时子 read_file ①登记改
   * 相对 roots[0] 路径并双写父键(父与兄弟子代理共享已读事实);②读前查父清单行段交叠,命中→
   * 结果尾注「勿再整读」。缺席=旧行为(绝对路径单写子键)。 */
  parentReadSession?: string;
 /** 子 loop 事件回调(子代理工作区):每个子 journal 事件在既有心跳拦截器同一挂点上
   * 裁剪后回调给装配方(装配方以 subagent.event append 进主 journal);本后端不持主 journal 引用,
   * 保持后端与主会话解耦。缺省=不回调(行为同旧版)。 */
  onLoopEvent?: (e: { kind: string; payload: Record<string, unknown> }) => void;
 /** 流式旁路(对齐 coding agent):子 loop 的 llm-begin/delta/end + tool-begin/end
   * 走与主 agent 相同的 streamSink(会话 id=subagent-<taskId>),面板子代理工作区实时打字;
   * 不落 journal(终态仍由 message.agent/tool.result 持久)。 */
  onStream?: (e: import("@lampgenie/runtime/agent/loop").AgentStreamEvent) => void;
 /** 上下文治理(对齐 coding agent):与主 loop 共用同一 compactHook / microcompact
   * 配置——长子代理不再无界增长上下文(此前子 loop 永不压缩,主轨有压缩)。 */
  compactHook?: import("@lampgenie/runtime/agent/loop").AgentLoopOptions["compactHook"];
  microcompact?: import("@lampgenie/runtime/agent/loop").AgentLoopOptions["microcompact"];
  /** 写时定形 spill(2026-11 token 轮 02):与主 loop 同源——工具结果进历史前超阈落盘定形,
   * 之后永不改写(否则长子代理照旧每步重写历史中段、打碎提示前缀缓存)。缺省不配置=零变化。 */
  spill?: import("@lampgenie/runtime/agent/loop").AgentLoopOptions["spill"];
 /** 大结果入口闸门:与主 loop 同源注入(否则子代理照旧把大结果整段灌进上下文)。 */
  bigIntake?: import("@lampgenie/runtime/agent/loop").AgentLoopOptions["bigIntake"];
  /** 增长突增软阈值(tokens):子代理与主 loop 同源;0/缺省=关闭。 */
  growthSpurtTokens?: import("@lampgenie/runtime/agent/loop").AgentLoopOptions["growthSpurtTokens"];
  /** 上下文模型评分(Phase 1/2):子代理与主 loop 同源。 */
  modelScoring?: import("@lampgenie/runtime/agent/loop").AgentLoopOptions["modelScoring"];
 /** 工具白名单(profile.tools 升级为执行白名单的单一下发口)。
   * 支持:具体工具名 / 组别名(read|write|exec|code_sense,agent-profiles.SUBAGENT_TOOL_GROUPS 展开)/
   * "*"(内置全集,不含 MCP)/ "mcp" 或 "mcp__<server>[__<tool>]" 前缀(显式开启 MCP 下发)。
   * 在场=按白名单过滤工具池(内置池+extraTools);缺席/空=角色二分兜底(行为同旧版,extraTools 不参与)。 */
  toolWhitelist?: string[];
  /** 注入工具池(wiring 层构建的有状态工具实例:code_sense/code_index/skill_view/MCP 桥)。
   * 仅白名单在场时参与装配(按 toolGrantMatched 过滤);权限语义与主 agent 同(不豁免闸门)。 */
  extraTools?: import("@lampgenie/runtime/agent/loop").Tool[];
  /** 技能索引文本(granted 含 skill_view 时追加进子代理系统提示——模型由此知道可读的技能名)。
   * 由装配方构建(与主 agent 索引同源);缺席=只给工具不给索引(模型无从得知名字)。 */
  skillIndexText?: string;
 /** 编辑后 LSP 诊断/保存格式化(coding.lsp);缺省=关闭(低层语义,生产由装配方注入)。 */
  lsp?: LspSettings;
 /** 写盘围栏(来自 profile.writeGlobs):在场时 write_file/edit_file 只允许命中这些
   *  glob(相对 workdir),越界直接拒绝并说明允许范围。典型=planner 只能写规划稿
 * <slug>/step.md——即使模型越权也不落盘(提示词约束之外的第二道锁)。 */
  writeGlobs?: string[];
}

/** 子 loop 事件裁剪(工作区入账形态,dashboard 面板 subagent.event 渲染的数据契约):
 * journal 是全会话共享的 append-only 流,子代理逐事件全文入账=慢盘写放大+主会话拉史增重——
 * 只保留工作区渲染所需字段,长文本按字段语义截断。纯函数,单测锚定。 */
export function trimSubLoopEvent(kind: string, p: Record<string, unknown>): Record<string, unknown> {
  const s = (v: unknown, n: number) => String(v ?? "").slice(0, n);
  switch (kind) {
    case "tool.call":
      return { toolCallId: s(p.toolCallId, 80), name: s(p.name, 80), arguments: s(p.arguments, 400) };
    case "tool.result":
      return { toolCallId: s(p.toolCallId, 80), name: s(p.name, 80), content: s(p.content, 2000), durationMs: Number(p.durationMs ?? 0) };
    case "message.agent": {
      const calls = Array.isArray(p.toolCalls) ? (p.toolCalls as Record<string, unknown>[]) : [];
      const u = (p.usage ?? null) as Record<string, unknown> | null;
      return {
        text: s(p.text, 8000),
        turn: Number(p.turn ?? 0), step: Number(p.step ?? 0), llmMs: Number(p.llmMs ?? 0),
 // 模型名(成本核算):子代理用量要按它自己的模型计费,不能混进主轨单价。
        ...(typeof p.model === "string" && p.model ? { model: s(p.model, 120) } : {}),
        ...(p.reasoning ? { reasoning: s(p.reasoning, 4000) } : {}),
        ...(u ? { usage: {
          inputTokens: Number(u.inputTokens ?? 0), outputTokens: Number(u.outputTokens ?? 0),
          ...(u.totalTokens !== undefined ? { totalTokens: Number(u.totalTokens) } : {}),
          ...(u.cachedTokens !== undefined ? { cachedTokens: Number(u.cachedTokens) } : {}),
 // 缓存写入量(成本第三段;仅 Anthropic 原生口径下发)
          ...(u.cacheCreationTokens !== undefined ? { cacheCreationTokens: Number(u.cacheCreationTokens) } : {}),
        } } : {}),
        ...(calls.length ? { toolCalls: calls.slice(0, 12).map((c) => ({ id: s(c.id, 80), name: s(c.name, 80), arguments: s(c.arguments, 200) })) } : {}),
      };
    }
    case "message.user":
      return { text: s(p.text, 2000) };
 // LLM 轨迹指针:此前落 default→{raw:"…"},面板无法渲染/复制轨迹路径。
    // 与主会话 llm.trace 同构的结构化摘要(全文仍在 .genie/llm-trace/subagent-<taskId>*/call-*.json)。
    case "llm.trace":
      return {
        file: s(p.file, 500),
        turn: Number(p.turn ?? 0), step: Number(p.step ?? 0),
        model: s(p.model, 120), durationMs: Number(p.durationMs ?? 0),
        ...(p.ttftMs !== undefined ? { ttftMs: Number(p.ttftMs) } : {}),
        ...(p.usage ? { usage: p.usage as Record<string, unknown> } : {}),
        ...(p.error ? { error: s(p.error, 600) } : {}),
        ...(Array.isArray(p.messageRoles) ? { messageRoles: (p.messageRoles as unknown[]).slice(0, 40).map((x) => s(x, 20)) } : {}),
        ...(typeof p.systemHead === "string" ? { systemHead: s(p.systemHead, 120) } : {}),
        ...(Array.isArray(p.toolCalls) ? { toolCalls: (p.toolCalls as unknown[]).slice(0, 20).map((x) => s(x, 60)) } : {}),
      };
    case "step.start":
      return { turn: Number(p.turn ?? 0), step: Number(p.step ?? 0) };
    case "step.end":
      return { turn: Number(p.turn ?? 0), step: Number(p.step ?? 0), reason: s(p.reason, 60),
        ...(p.detail ? { detail: s(p.detail, 160) } : {}), ...(p.error ? { error: s(p.error, 300) } : {}) };
    case "turn.start":
      return { turn: Number(p.turn ?? 0) };
    case "turn.end":
      return { turn: Number(p.turn ?? 0), reason: s(p.reason, 60) };
    case "permission.gate":
      return { tool: s(p.tool, 80), effect: s(p.effect, 40), by: s(p.by, 160) };
    // 子代理上下文治理审计:此前落 default raw(可在 subagent.event 里看到但不可结构化查询)。
    // 与主 journal 的 context.prune/growth/model.score 保持同名同字段子集。
    case "context.prune":
      return {
        reason: s(p.reason, 60),
        compacted: Number(p.compacted ?? 0),
        savedTokens: Number(p.savedTokens ?? 0),
        growthSpurt: p.growthSpurt === true,
        items: (Array.isArray(p.items) ? p.items : []).slice(0, 20).map((it) => {
          const x = (it ?? {}) as Record<string, unknown>;
          return {
            toolCallId: s(x.toolCallId, 80), tool: s(x.tool, 60), where: s(x.where, 300),
            action: s(x.action, 30), originalChars: Number(x.originalChars ?? 0), newChars: Number(x.newChars ?? 0),
          };
        }),
      };
    case "context.growth":
      return {
        growth: Number(p.growth ?? 0), rawContextTokens: Number(p.rawContextTokens ?? 0),
        previousContextTokens: Number(p.previousContextTokens ?? 0), keepRecent: Number(p.keepRecent ?? 0),
      };
    case "context.model.score":
      return {
        step: Number(p.step ?? 0), mode: s(p.mode, 20), providerUrl: s(p.providerUrl, 300),
        goalChars: Number(p.goalChars ?? 0), candidateCount: Number(p.candidateCount ?? 0),
        previewChars: Number(p.previewChars ?? 0), questionCount: Number(p.questionCount ?? 0),
        ...(p.requestBytes !== undefined ? { requestBytes: Number(p.requestBytes) } : {}),
        durationMs: Number(p.durationMs ?? 0),
        decisions: (Array.isArray(p.decisions) ? p.decisions : []).slice(0, 20).map((d) => {
          const x = (d ?? {}) as Record<string, unknown>;
          return { id: s(x.id, 80), tool: s(x.tool, 60), where: s(x.where, 300), keepCall: Number(x.keepCall ?? 0), keepResult: Number(x.keepResult ?? 0), confidence: Number(x.confidence ?? 0) };
        }),
        ...(p.error ? { error: s(p.error, 400) } : {}),
      };
    default: {
      let flat = ""; try { flat = JSON.stringify(p) ?? ""; } catch { flat = ""; }
      return { raw: flat.slice(0, 400) };
    }
  }
}

const MAX_FILE_BYTES = 120 * 1024;
const MAX_GREP_HITS = 60;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".genie", ".zcode", ".agents", "ref", "devlog", "vendor", "coverage", ".next"]); // 与 file-index 对齐(子代理扫描面=主链路扫描面)

/** 子代理读类工具名(全部声明 isReadOnly=权限闸门豁免,与主 agent 文件六件套读类同语义)。 */
export const SUBAGENT_READ_TOOLS = ["read_file", "glob", "grep", "list_dir"] as const;
/** 子代理写/执行类工具名(过权限闸门;file.write 类别别名经 loop TASK_OUTPUT_ALIAS 覆盖写两件)。 */
export const SUBAGENT_WRITE_TOOLS = ["write_file", "edit_file", "run_cmd"] as const;

/** 工具执行统一帽(冻结治理):缺省 600s——防「单工具无限挂死拖住整个 agent」
 * (WSL 9p 停顿注意:同步文件读冻住事件循环,主 agent+全部子代理一起停摆 35 分钟)。
 *  generous 值:terminal 上限 600s 恰好贴帽;文件/检索类正常操作秒级,帽只是最后防线。 */
export const TOOL_TIMEOUT_CAP_MS = Number(process.env.GENIE_TOOL_TIMEOUT_MS ?? 600_000);
/** 自管豁免清单:这些工具自身已有完备等待/超时语义,统一帽会误杀合法长等——
 *  spawn_subagent(wait:true 挂到子代理终态,有 deadlineMin)/answer_subagent(等子代理应答)/
 *  ask_user(等人,天然无界)/task_output(等后台子代理产出)/terminal(waitReason=timeout 自管)/
 *  run_cmd(命令执行自管)/code_sense(冷根索引构建分钟级,有失败冷却语义)/
 *  code_review(LLM 评审分钟级,provider 自带超时)/run_workflow(工作流引擎自管)/
 *  import_meeting(LLM 解析)/wait_until(条件等待,自带 timeoutSec≤600)。 */
const SELF_MANAGED_TIMEOUT_TOOLS = new Set([
  "spawn_subagent", "answer_subagent", "ask_user", "task_output", "terminal", "run_cmd",
  "code_sense", "code_review", "run_workflow", "import_meeting", "wait_until",
]);
/** 装配期打标:自管工具 timeoutMs=0(豁免),其余继承 AgentLoopOptions.toolTimeoutMs。 */
export function withToolDeadlineDefaults<T extends { name: string; timeoutMs?: number }>(tools: T[]): T[] {
  if (!(TOOL_TIMEOUT_CAP_MS > 0)) return tools; // 帽关(GENIE_TOOL_TIMEOUT_MS=0)=零行为变化
  return tools.map((t) => (SELF_MANAGED_TIMEOUT_TOOLS.has(t.name) ? { ...t, timeoutMs: 0 } : t));
}

export function llmLoopReadOnlyTools(roots: string[], readState?: Map<string, number>, readSessionRef?: { value: string }, parentReadSession?: string) {
  const guard = (p: unknown) => {
    const abs = resolve(String(p ?? ""));
    return roots.some((r) => abs === r || abs.startsWith(r + sep)) ? abs : null;
  };
  const walk = (dir: string, out: string[], depth = 0): void => {
    if (out.length > 4000 || depth > 8) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
      const full = join(dir, name);
      let st; try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, out, depth + 1);
      else if (/\.(ts|tsx|js|jsx|mjs|cjs|json|md|py|go|java|html|css|vue)$/.test(name)) out.push(full);
      if (out.length > 4000) return;
    }
  };
  return [
    {
      name: "read_file",
 // 与主 agent 对齐:补 offset/limit 分窗(旧实现只能读前 120KB——1.1MB 的 panel.ts
 // 永远读不全,经验证同一文件同参重读 9 次);并把读取登记进「已读清单」,loop 每步注入
      // 「文件未变不要整读」提醒(旧实现只有主 agent 登记,子代理无此提醒)。
      description: "读取一个文本文件(≤120KB/次,可分窗)。路径必须在仓库内。大文件先 grep 定位,再用 offset/limit 分窗读。**要看多个文件(或多个区间)就在同一步并发发多条 read_file**(本工具无状态),别一步只读一个文件——每次往返都会重发整段上下文。",
      parameters: { type: "object", properties: {
        path: { type: "string", description: "文件绝对路径或仓库相对路径(一次只看一个文件;多文件请同一步并发多条调用)" },
        offset: { type: "number", description: "起始行号(1-based)。只在文件过大需要分窗读时提供" },
        limit: { type: "number", description: "读取行数(缺省 800,上限 2000)" },
        force: { type: "boolean", description: "该文件未变且行段已在你的上下文时强制重新注入正文(缺省省略重复读取、只回短提示)" },
      }, required: ["path"] },
      isReadOnly: () => true,
      async execute(args: unknown) {
        const a = (args ?? {}) as { path?: string; offset?: number; limit?: number; force?: boolean };
        const abs = guard(a.path);
        if (!abs) return "错误:路径缺失或越出仓库根";
 // 输入边界防御:realpath 归一 → ①设备/伪文件 → ②stat special → ③denylist
        // (必须在 readFileSync 之前;missing 交给下面的既有 try 分支,保持原有错误文案)
        const guarded = await readGuardPath(abs);
        if (!guarded.ok && guarded.kind === "denied") return guarded.reason;
 // 编辑保鲜读侧( ZCode ReadFileState):记录读取时刻 mtime,write/edit 据此拒盲写。
        let mtimeMs = 0;
        try { if (existsSync(abs)) { mtimeMs = statSync(abs).mtimeMs; if (readState) readState.set(abs, mtimeMs); } } catch { /* 状态记录失败不阻塞读 */ }
        try {
          // ④binary 先于 ⑤read:只嗅探前缀(8000B),命中直接拒读,不整读大二进制
          const head = await readHeadBytes(abs, BINARY_PROBE_BYTES);
          if (looksBinaryBytes(head)) return "错误:疑似二进制文件,拒绝读取: " + abs + "(read_file 只读文本;图片用 view_image)";
          const text = readFileSync(abs).toString("utf-8");
          const all = text.split("\n");
          const offset = Math.max(1, Math.min(Number(a.offset) || 1, all.length));
          const limit = Math.min(Math.max(Number(a.limit) || 800, 1), 2000);
          const end = Math.min(offset - 1 + limit, all.length);
 // 单行 clamp:超 2000 字符按「…(+N 字符已截断)」截断,标记计入 2000 额度
          let body = all.slice(offset - 1, end).map((l) => clampLine(l)).join("\n");
          const truncated = body.length > MAX_FILE_BYTES;
          if (truncated) body = body.slice(0, MAX_FILE_BYTES);
 // 已读登记(供 loop 的「已读清单/别整读」提醒;与主 agent 同语义)。读传递( D3):
          // ①路径改相对 roots[0](与主 agent 同键——主侧 file-tools 登记 relDisplay(root,abs) 相对路径,
          //   旧实现登记绝对路径,父/子/兄弟清单键永远对不上);②带行段双写父会话键(父与兄弟子代理
          //   共享已读事实,兄弟互相可见);③读前查父清单行段交叠,命中→结果尾注「勿再整读」
          //   (必须在登记前查,否则本子代理刚写的行段会自查自中)。
          let handoffHint: string | null = null;
          let relForState = abs;
          try {
            const r0 = relative(roots[0] ?? process.cwd(), abs);
            relForState = !r0 || r0.startsWith("..") || isAbsolute(r0) ? abs.split(sep).join("/") : r0.split(sep).join("/");
          } catch { /* 相对化失败退回绝对路径(键不齐但不阻塞) */ }
          try {
            if (parentReadSession) handoffHint = renderParentReadHint(readFilesOf(parentReadSession), relForState, offset, end);
          } catch { /* 提示层登记失败不阻塞读 */ }
 // 重复读取去重:判重键=该子代理自己的 readSessionRef(父键/兄弟已读不算本子
          // 上下文,否则子代理会看不到正文);判定必须在登记前(否则本次窗口自查自中)。
          if (!a.force && readSessionRef?.value && mtimeMs) {
            try {
              // exactWindow=true:同窗口重读才省略(子窗口照常注正文,不吞模型点名要的行段)
              const v = checkRepeatRead(readSessionRef.value, relForState, mtimeMs, offset, end, true);
              if (v.duplicate) {
                const rangeText = offset <= 1 && end >= all.length ? "全文" : `${offset}-${end}`;
                return `[重复读取·已省略] ${relForState} 自第 ${v.readCount} 次读取后未变,请求行段(${rangeText})已在上文;要精确原文用 offset/limit 指定未覆盖窗口,或 force=true 重新注入`
                  + "\n(共 " + all.length + " 行;本次显示 " + offset + "-" + end + ")" + (handoffHint ? "\n" + handoffHint : "");
              }
            } catch { /* 判定失败不阻塞读 */ }
          }
          try {
            if (readSessionRef?.value && mtimeMs) {
              recordFileRead(readSessionRef.value, relForState, mtimeMs, Date.now(), [{ off: offset, end }]);
              if (parentReadSession) recordFileRead(parentReadSession, relForState, mtimeMs, Date.now(), [{ off: offset, end }]);
            }
          } catch { /* 提示层登记失败不阻塞读 */ }
          return body + (truncated ? "\n…(单次超 120KB 截断,缩小 limit 或继续分窗)" : "") + "\n(共 " + all.length + " 行;本次显示 " + offset + "-" + end + ")" + (handoffHint ? "\n" + handoffHint : "");
        } catch (err) { return "错误:" + String(err).slice(0, 150); }
      },
    },
    {
 // H1 六件套对齐——子代理读面补 glob(按改动时间新→旧,与主 agent glob 同语义)。
      name: "glob",
      description: "按模式匹配仓库内文件路径(* 不跨目录,** 跨目录,? 单字符,{a,b} 枚举;结果按修改时间新→旧,≤200 条)。路径必须在仓库内。",
      parameters: { type: "object", properties: {
        pattern: { type: "string", description: "glob 模式(如 src/**/*.ts、*.json)" },
        path: { type: "string", description: "起始子目录(缺省仓库根)" },
      }, required: ["pattern"] },
      isReadOnly: () => true,
      async execute(args: unknown) {
        const a = (args ?? {}) as { pattern?: string; path?: string };
        const pattern = String(a.pattern ?? "").trim();
        if (!pattern) return "错误:pattern 必填";
        const base = a.path ? guard(a.path) : roots[0];
        if (!base) return "错误:path 缺失或越出仓库根";
        const { globToRegExp } = await import("./file-tools.js");
        const bare = !pattern.includes("/");
        const matchers = pattern.includes("{")
          ? (function expand(p: string): string[] {
              const m2 = p.match(/\{([^{}]+)\}/);
              if (!m2 || m2.index === undefined || !m2[1]) return [p];
              return m2[1].split(",").flatMap((alt) => expand(p.slice(0, m2.index!) + alt + p.slice(m2.index! + m2[0].length)));
            })(pattern).map(globToRegExp)
          : [globToRegExp(pattern)];
        // glob 走全文件遍历(与主 agent glob 同语义:文件名匹配不限扩展名;grep 仍限代码扩展名面)
        const all: string[] = [];
        const walkAll = (dir: string, depth = 0): void => {
          if (all.length > 4000 || depth > 8) return;
          let entries: string[];
          try { entries = readdirSync(dir); } catch { return; }
          for (const name of entries) {
            if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
            const full = join(dir, name);
            let st; try { st = statSync(full); } catch { continue; }
            if (st.isDirectory()) walkAll(full, depth + 1);
            else all.push(full);
            if (all.length > 4000) return;
          }
        };
        walkAll(base);
        const hits: { full: string; mtime: number }[] = [];
        for (const f of all) {
          const rel = f.slice(base.length + 1).replace(/\\/g, "/");
          const name = rel.split("/").pop() ?? "";
          if (matchers.some((re) => re.test(rel) || (bare && re.test(name)))) {
            try { hits.push({ full: f, mtime: statSync(f).mtimeMs }); } catch { /* 条目消失容忍 */ }
          }
        }
        if (hits.length === 0) return "(零命中)";
        hits.sort((x, y) => y.mtime - x.mtime);
        return hits.slice(0, 200).map((h) => h.full).join("\n") + (hits.length > 200 ? `\n(共 ${hits.length} 条,只列前 200;缩小 pattern)` : "");
      },
    },
    {
      name: "list_dir",
      description: "列出一个目录的直接子项([d] 目录/[f] 文件)。",
      parameters: { type: "object", properties: { path: { type: "string", description: "目录路径" } }, required: ["path"] },
      isReadOnly: () => true,
      async execute(args: unknown) {
        const abs = guard((args as { path?: string }).path);
        if (!abs) return "错误:路径缺失或越出仓库根";
        try {
          return readdirSync(abs).map((n) => { try { return (statSync(join(abs, n)).isDirectory() ? "[d] " : "[f] ") + n; } catch { return n; } }).join("\n");
        } catch (err) { return "错误:" + String(err).slice(0, 150); }
      },
    },
    {
      name: "grep",
      description: "在仓库文本文件里做内容检索(正则或关键词),返回 文件:行号:内容(≤60 条)。多个关键词用 alternation 合并成一次检索(a|b|c,preferred over 换关键词反复重撞);要扫多个不相关位置时同一步并发发多条 grep。",
      parameters: { type: "object", properties: {
        pattern: { type: "string", description: "正则或字面关键词(标识符/API 名/中英术语;多关键词用 a|b|c 合并成一次检索)" },
        path: { type: "string", description: "检索起始目录(缺省仓库根)" },
      }, required: ["pattern"] },
      isReadOnly: () => true,
      async execute(args: unknown) {
        const a = (args ?? {}) as { pattern?: string; path?: string };
        if (!a.pattern) return "错误:pattern 必填";
        let re: RegExp;
        try { re = new RegExp(a.pattern, "i"); } catch { re = new RegExp(a.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
        const base = guard(a.path ?? roots[0]) ?? roots[0] ?? process.cwd();
        const files: string[] = [];
 // 修复:path 允许是文件(主 agent grep 同语义)。旧实现只按目录 readdir,
        // 传文件时 readdirSync 抛 ENOTDIR 被 walk 静默吞掉→返回「(零命中)」,模型以为没匹配、
 // 换 pattern 反复重试(经验证探针:两个 explore 的 155 次调用里 68 次是这种空结果)。
        let baseStat: ReturnType<typeof statSync> | null = null;
        try { baseStat = statSync(base); } catch { baseStat = null; }
        if (!baseStat) return "错误:检索路径不存在: " + base;
        if (baseStat.isFile()) files.push(base);
        else walk(base, files);
        const hits: string[] = [];
        for (const f of files) {
          if (hits.length >= MAX_GREP_HITS) break;
          let text: string;
          try {
            if (statSync(f).size > 1_000_000) continue;
            text = readFileSync(f, "utf-8");
          } catch { continue; }
          const ls = text.split("\n");
          for (let i = 0; i < ls.length && hits.length < MAX_GREP_HITS; i++) {
            if (re.test(ls[i]!)) hits.push(`${f.replace(/\\/g, "/")}:${i + 1}: ${ls[i]!.trim().slice(0, 200)}`);
          }
        }
        return hits.length ? hits.join("\n") : "(零命中)";
      },
    },
  ];
}

/** 子代理 run_cmd 命令围栏(planner 板节点 04):workspace 档下拦「命令文本里直接写出工作目录外路径」。
 *  实现单一来源=file-tools 的 fenceCommand(与主 agent terminal 工具同一套口径,避免两处启发式分叉);
 *  本函数只是「根=workdir」的薄包装,保留导出供既有单测与调用点使用。
 *  能力边界见 fenceCommand 头注(纯文本启发式:`cd /` 后相对路径、$()/反引号、脚本内跳转不截获)。 */
export function fenceRunCmd(cmd: string, workdir: string): string | null {
  return fenceCommand(cmd, workdir);
}

/** worker/general 的写与执行工具(ZCode general-purpose 全工具语义):write_file/edit_file/run_cmd。
 * 编辑保鲜( ZCode ReadFileState 语义):覆写/编辑已存在文件前必须先 read_file 且读后未被外部改动——防盲写覆盖。
 * edit_file(补齐):精确字面替换,与主 agent edit_file 同语义(old 唯一命中/replace_all)。 */
function workerWriteTools(workdir: string, readState?: Map<string, number>, lsp?: LspSettings, writeGlobs?: string[]) {
 // 写盘围栏:相对 workdir 的路径命中声明 glob 才允许写;越界给出允许范围,便于模型自我纠正。
  const fenceError = (abs: string): string | null => {
    if (!writeGlobs || writeGlobs.length === 0) return null;
    const root = resolve(workdir);
    const rel = abs.startsWith(root) ? abs.slice(root.length).replace(/^[\\/]+/, "").replace(/\\/g, "/") : "";
    if (rel && writePathAllowed(rel, writeGlobs)) return null;
    return "错误:写盘越界——本角色只允许写 [" + writeGlobs.join(", ") + "],目标 " + (rel || abs) + " 不在白名单内(规划产物只能落规划稿路径;业务代码请交给父代理实施)。";
  };
  const assertFreshForWrite = (abs: string): string | null => {
    if (!existsSync(abs)) return null; // 新建文件无需先读
    const cur = statSync(abs).mtimeMs;
    const seen = readState?.get(abs);
    if (seen === undefined) return "错误:目标文件已存在但本会话未读过——先 read_file 它(编辑保鲜,防盲写覆盖),或确认这是要新建覆盖的场景后用 read_file 确认现状再写。";
    if (cur !== seen) return "错误:目标文件在读取后被外部修改过(mtime 变化)——重新 read_file 拿到最新内容再写。";
    return null;
  };
  const runOne = async (args: unknown) => {
    const a = (args ?? {}) as { command?: string; timeoutSec?: number };
    const cmd = String(a.command ?? "").trim();
    if (!cmd) return "错误:command 必填";
    // 命令围栏(planner 板节点 04):workspace 档下命令文本出现工作目录外路径就不起进程——
    // 非 null 即拒绝,与原返回形状一致(字符串,前缀「错误:」),UI 直接显示拒因。
    const fenced = fenceRunCmd(cmd, workdir);
    if (fenced) return "错误:" + fenced + "(workspace 模式只允许操作工作目录内的文件;需要越界请在完全访问模式执行)";
 // git 破坏命令硬拦(g1:11-05 有子代理 git stash,把全仓 142 个未提交文件收走、
    // 工作树回退成"什么都没改"的假象。子代理**任何档位**都不许 git 写/破坏操作(按解析后的子命令判定),
    // 写盘/切换/清理由父代理(main agent)操作。runOne 拿不到 journal,故不留审计(职责在主 agent 面)。
    const gitVerdict = guardGitCommand(cmd);
    if (gitVerdict && (gitVerdict.destructive || gitVerdict.write)) return "错误:" + subagentGitBlockReason(gitVerdict);
    const { execFile } = await import("node:child_process");
    const timeoutMs = Math.min(Math.max(Number(a.timeoutSec) || 120, 5), 600) * 1000;
    // Windows 无 bash:shell 选择统一走 shellInvocation(win32=cmd.exe /d /s /c;GENIE_SHELL_BIN 可覆盖为 Git-Bash)。
    // WSL 项目(UNC cwd)自动切 wsl.exe,命令回到发行版内执行。
    const inv = shellInvocation(cmd, { cwd: workdir });
    try {
      const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((res, rej) => {
        execFile(inv.cmd, inv.args, { cwd: inv.mode === "wsl" ? undefined : workdir, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, so, se) => {
          if (err && (err as { code?: unknown }).code === undefined) return rej(err);
          const hint = shellErrorHint(err, inv);
          res({ stdout: String(so ?? ""), stderr: String(se ?? "") + (hint ? "\n" + hint : "") + (err ? `\n(退出码非零:${String((err as { code?: unknown }).code)})` : "") });
        });
      });
      const out = (stdout + (stderr ? "\n[stderr]\n" + stderr : "")).trim();
      return out.slice(0, 100_000) || "(无输出)";
    } catch (err) {
      return "错误:" + String(err).slice(0, 200);
    }
  };
  return [
    {
      name: "write_file",
      description: "把完整内容写入一个文件(自动创建父目录)。修改已有文件请优先 read 后整体重写。写入后若有 LSP,会做保存格式化并附 <diagnostics> 诊断块(无错不追加)。",
      parameters: { type: "object", properties: {
        path: { type: "string", description: "目标文件绝对路径或仓库相对路径" },
        content: { type: "string", description: "完整文件内容" },
      }, required: ["path", "content"] },
      async execute(args: unknown) {
        const a = (args ?? {}) as { path?: string; content?: string };
        const abs = resolve(String(a.path ?? ""));
        if (!abs.startsWith(resolve(workdir))) return "错误:路径越出工作目录";
        const fenced = fenceError(abs);
        if (fenced) return fenced;
 // 编辑保鲜写侧( ZCode ReadFileState):已存在文件必须本会话读过且读后未被外部改。
        let prevText: string | undefined = ""; // 新文件:基线为空
        if (existsSync(abs)) {
          const cur = statSync(abs).mtimeMs;
          const seen = readState?.get(abs);
          if (seen === undefined) return "错误:目标文件已存在但本会话未读过——先 read_file 它再写(编辑保鲜,防盲写覆盖;确认要整体重建时 read_file 一次即放行)。";
          if (cur !== seen) return "错误:目标文件在读取后被外部修改过——重新 read_file 拿最新内容再写。";
          try { prevText = readFileSync(abs, "utf-8"); } catch { prevText = undefined; } // 读不到=baseline 如实不可用
        }
        try {
          const { mkdirSync, writeFileSync } = await import("node:fs");
 // baseline 必须在落盘前采集(旧内容);采集失败标 unavailable,不阻塞写。
          const base = await editBaselineSafe(workdir, abs, prevText, lsp);
          mkdirSync(join(abs, ".."), { recursive: true });
          writeFileSync(abs, String(a.content ?? ""), "utf-8");
          const suffix = await editCheckSuffixSafe(workdir, abs, lsp, base?.baseline, base?.baselineText);
          readState?.set(abs, statSync(abs).mtimeMs); // 格式化可能改写文件
          return "已写入 " + abs + "(" + String(a.content ?? "").length + " 字符)" + suffix;
        } catch (err) { return "错误:" + String(err).slice(0, 150); }
      },
    },
    {
      name: "run_cmd",
      description: "在任务工作目录执行一条 bash 命令(构建/测试/git 等;超时上限 600s,输出截断 100KB)。build/install/全量测试等重操作会被父代理闸门拦截审批——如实等待批准或按拒绝处理;被拒绝后不得拆分命令或换等价命令绕行,改走更轻的替代路径并在报告说明。",
      parameters: { type: "object", properties: {
        command: { type: "string", description: "命令(Windows 走 cmd.exe /d /s /c,可用 GENIE_SHELL_BIN 覆盖)" },
        timeoutSec: { type: "number", description: "超时秒数(5-600,缺省 120)" },
      }, required: ["command"] },
      async execute(args: unknown) { return await runOne(args); },
    },
    {
 // 六件套对齐——精确字面替换编辑(主 agent edit_file 同语义;编辑保鲜读侧共享)。
      name: "edit_file",
      description: "对文件做精确字面替换编辑(old_string 逐字匹配,缺省要求唯一命中;replace_all 全替)。编辑前先 read_file 该文件。成功后做保存格式化与诊断(<diagnostics> 块;格式化可能改空白/引号,后续编辑需重新 read)。",
      parameters: { type: "object", properties: {
        path: { type: "string", description: "目标文件绝对路径或仓库相对路径" },
        old_string: { type: "string", description: "要替换的原文(逐字精确)" },
        new_string: { type: "string", description: "替换后的新文(空串=删除匹配)" },
        replace_all: { type: "boolean", description: "替换全部命中(缺省 false=必须唯一)" },
      }, required: ["path", "old_string", "new_string"] },
      async execute(args: unknown) {
        const a = (args ?? {}) as { path?: string; old_string?: string; new_string?: string; replace_all?: boolean };
        const abs = resolve(String(a.path ?? ""));
        if (!abs.startsWith(resolve(workdir))) return "错误:路径越出工作目录";
        const fenced = fenceError(abs);
        if (fenced) return fenced;
        if (!a.old_string) return "错误:old_string 不能为空(新建文件用 write_file)";
        if (a.old_string === a.new_string) return "错误:old_string 与 new_string 相同,是空操作";
 // 编辑比例守卫:与主 agent edit_file 同源,防放宽匹配后静默删大段
        const ratioDenied = checkEditRatio(a.old_string, a.new_string ?? "");
        if (ratioDenied) return ratioDenied;
        if (!existsSync(abs)) return "错误:文件不存在: " + abs;
        const stale = assertFreshForWrite(abs);
        if (stale) return stale;
        let text: string;
        try { text = readFileSync(abs, "utf-8"); } catch (err) { return "错误:" + String(err).slice(0, 150); }
        const occurrences = text.split(a.old_string).length - 1;
        if (occurrences === 0) return "错误:old_string 在文件中未找到(逐字匹配,注意空白与换行;重新 read_file 后精确抄写)。";
        if (occurrences > 1 && a.replace_all !== true) {
          return `错误:old_string 命中 ${occurrences} 处,缺省只允许唯一命中。确认要全替时传 replace_all=true,或把 old_string 扩到含前后文使其唯一。`;
        }
        const replaced = a.replace_all === true ? text.split(a.old_string).join(a.new_string ?? "") : text.replace(a.old_string, a.new_string ?? "");
        try {
          const { writeFileSync } = await import("node:fs");
 // 已读出的旧 text 直接作 baselineText;采集在落盘前(同主 agent file-tools)。
          const base = await editBaselineSafe(workdir, abs, text, lsp);
          writeFileSync(abs, replaced, "utf-8");
          const suffix = await editCheckSuffixSafe(workdir, abs, lsp, base?.baseline, base?.baselineText);
          readState?.set(abs, statSync(abs).mtimeMs); // 格式化可能改写文件
          const n = a.replace_all === true ? occurrences : 1;
          return `已编辑 ${abs}:替换 ${n} 处(${text.length} → ${replaced.length} 字符)。` + suffix;
        } catch (err) { return "错误:" + String(err).slice(0, 150); }
      },
    },
  ];
}

export class LlmLoopBackend implements SubagentBackend {
  readonly kind = "llm-loop";

  constructor(private readonly opts: LlmLoopBackendOptions) {}

  async spawn(spec: TaskSpec, onEvent: (e: SubagentEvent) => void): Promise<SubagentHandle> {
    const spawnAt = Date.now(); // 时间盒起点(deadlineAt 收敛提醒的计时基准)
 // LSP 检查器预热:子代理装配时后台加载 typescript,首条编辑不吃模块冷启动。
    if (this.opts.lsp && this.opts.lsp.enabled !== false) {
      void import("@lampgenie/lsp").then((m) => m.warmTypeScriptChecker()).catch(() => { /* fail-soft */ });
    }
 // 父中止传播( ZCode createSubagentTaskAbortController 语义):父 loop 取消→子代理一并取消。
    if (spec.parentSignal) {
      spec.parentSignal.addEventListener("abort", () => {
        cancelled = true;
        try { loop?.cancel("parent-abort"); } catch { /* 未建 loop 时由下方建后检查 */ }
      }, { once: true });
    }
    const roots = this.opts.roots.length ? this.opts.roots : [spec.workdir];
 //  图片 offload:缺省落盘根 = 子代理工作目录(与 bash/write 围栏同根);装配方可覆盖。
    // 首跑与串台重派共用这一份(两个 loop 同值,避免重派轮行为分叉)。
    const imageOffload = this.opts.imageOffload ?? { root: this.opts.workdir ?? roots[0] ?? process.cwd() };
    // 子代理 journal(steering 介质 + 收尾事件面):提前到工具装配前,deliverable/cite_source 要写入它。
    const subJournal = new MemoryJournal();
 // 收尾聚合:所有终态(done/failed/cancelled/deadline/stall/串台重派)统一走
    // task-closeout(mode:"subagent",warn-only);同一 spawn 只收尾一次,finalText 写回结果。
    const closeoutSessionId = "subagent-" + spec.taskId;
    const closeoutRoot = this.opts.workdir ?? roots[0] ?? process.cwd();
    const closeoutStartSeq = subJournal.length;
 //  基线必须在动手前建(git status 基线),否则末态对比恒为空。
    const closeoutBaseline = captureBaseline(closeoutRoot).catch(() => null);
    let closeoutPromise: Promise<TaskResult> | null = null;
    const finalizeResult = (r: TaskResult): Promise<TaskResult> => {
      if (!closeoutPromise) {
        closeoutPromise = (async () => {
          try {
            const baseline = await closeoutBaseline;
            const cout = await runTaskCloseout({
              journal: subJournal,
              sessionId: closeoutSessionId,
              taskId: spec.taskId,
              root: closeoutRoot,
              taskStartSeq: closeoutStartSeq,
              state: r.ok ? "done" : r.error?.kind === "cancelled" ? "cancelled" : "failed",
              finalText: String(r.finalText ?? ""),
              instruction: String(spec.instructions ?? ""),
              mode: "subagent",
              ...(baseline ? { baseline } : {}),
            });
            return { ...r, finalText: cout.finalText };
          } catch {
            return r;
          }
        })();
      }
      return closeoutPromise;
    };
    // 角色解析(ZCode AgentType 语义):worker/general=全工具(读+写+bash);explore/judge/test-analyst=只读。
    const role = String(this.opts.role ?? "worker").toLowerCase();
    const writeRole = role === "worker" || role === "general" || role === "general-purpose";
    const roleLabel: Record<string, string> = {
      worker: "通用执行子 agent", explore: "只读探索子 agent", judge: "评审判分子 agent",
      "test-analyst": "测试失败分析子 agent", general: "通用子 agent",
 // 规划角色(需求深挖→骨架→白板落板→DoD/风险),不写业务代码
      planner: "规划子 agent",
 // 演示文稿产出角色(判型→结构→页级正文→质量门导出)
      "ppt-master": "演示文稿子 agent",
    };
    const sharedReadState = new Map<string, number>(); // 编辑保鲜读侧表(读/写工具共享
    // 子 loop sessionId 引用:工具构造早于 loop 实例化,读文件登记需要运行时拿到它(供「已读清单」提醒)。
    const readSessionRef = { value: "" };
 // 工具装配(一处声明、执行面真实生效):
    // 白名单在场=工具池过滤(声明源=profile.tools,组别名经 expandToolTokens 展开;extraTools 一并过滤);
    // 缺席/空=角色二分兜底(粗粒度保底,行为同旧版;extraTools 不参与兜底)。
    const whitelist = this.opts.toolWhitelist?.length ? expandToolTokens(this.opts.toolWhitelist) : undefined;
    const pool = [
      ...llmLoopReadOnlyTools(roots, sharedReadState, readSessionRef, this.opts.parentReadSession),
      ...workerWriteTools(this.opts.workdir ?? roots[0] ?? process.cwd(), sharedReadState, this.opts.lsp, this.opts.writeGlobs),
      ...(this.opts.extraTools ?? []),
    ];
    const tools = whitelist
      ? pool.filter((t) => toolGrantMatched(t.name, whitelist))
      : writeRole
        ? pool.filter((t) => !(this.opts.extraTools ?? []).includes(t as never))
        : // fixC-D1(用户用户反馈):读角色子代理默认带上注入池里的只读感知工具
          // (code_sense/code_index/skill_view——isReadOnly 声明者)——旧实现只给
          // read_file/glob/grep/list_dir 四件,子代理查代码结构只能 grep(毫秒索引不可达);
          // 写角色维持排除(动手者不背认知工具,认知由父代理或读代理承担)。
          pool.filter((t) => (SUBAGENT_READ_TOOLS as readonly string[]).includes(t.name) || (this.opts.extraTools ?? []).includes(t as never) && !!(t as { isReadOnly?: () => boolean }).isReadOnly?.());
 // 空工具面门禁:白名单已声明但展开后与工具池零交集=装配错配(profile.tools 拼错/
    // 组别名打错)。此时 provider 不带 tools 字段=子代理退化为纯文本对话且静默——「工具未配置」的
    // 唯一可达形态。fail-visible:spawn 即抛,错误回父 agent,不带病启动裸 loop。
    if (whitelist && tools.length === 0) {
      throw new Error(
        "子代理工具面为空:白名单声明 [" + (this.opts.toolWhitelist ?? []).join(",") +
        "] 展开后 [" + whitelist.join(",") + "] 与工具池零交集(池:" + pool.map((t) => t.name).join("/") +
        ")。检查 .genie/agents/*.md 的 tools 声明或 agentType 拼写( fail-visible,不启动纯文本子代理)",
      );
    }
 // 收尾机制数据面:写角色挂 deliverable(声明交付物→)、有 web_fetch 的角色
 // 挂 cite_source(登记引用→);只读角色不挂写工具。journal 用子代理自己的 subJournal。
    {
      const writeFace = tools.some((t) => (SUBAGENT_WRITE_TOOLS as readonly string[]).includes(t.name));
      if (writeFace && !tools.some((t) => t.name === DELIVERABLE_TOOL_NAME)) {
        tools.push(makeDeliverableTool({
          journal: subJournal,
          sessionId: closeoutSessionId,
          taskId: spec.taskId,
          root: closeoutRoot,
        }));
      }
      if (tools.some((t) => t.name === "web_fetch") && !tools.some((t) => t.name === CITE_SOURCE_TOOL_NAME)) {
        tools.push(makeCiteSourceTool({ journal: subJournal, sessionId: closeoutSessionId, taskId: spec.taskId }));
      }
    }
    const grantedNames = tools.map((t) => t.name);
    const canWrite = tools.some((t) => (SUBAGENT_WRITE_TOOLS as readonly string[]).includes(t.name));
    const skillGranted = grantedNames.includes("skill_view");
 // 工具面契约统一:子代理与主 loop 同款——长描述摘要化 + 大 schema 工具延迟
    // 加载(用时 tool_view 激活)。此前子代理面保留原文长描述/全量 schema,两侧策略不一致
 // (经验证子代理 15 工具里 code_sense/terminal/browser/session_search 均超 240 字符)。
 // :子代理工具面与主面同款上下文投影(此前这里只有静态描述)。
 // - agentType=本子代理角色(planner/explore/worker…),只留痕不参与判定;
 // - permissionMode 取本进程权威源(与主面 agent-wiring 同源 permission-mode),plan/readonly 下
 // 写类工具描述带只读前缀;
 // - availableTools=本子代理实际工具名单:委派类描述据此只列真实可调的 agent——子代理池里通常
 // 没有 agent 名,于是描述变成「当前无可委派 agent」,不会把自己/兄弟角色列成可委派对象。
 // 只换 wire 描述(projectToolsForContext 派生新对象),工具集合/白名单/execute 一律不动。
    const wireTools = attachToolView(tools, {
      contract: {
        agentType: role,
        permissionMode: permissionMode(),
        availableTools: tools.map((t) => t.name),
      },
    });
 // 权限传递:父会话有效规则快照进子 loop 闸门(onAsk 回调→装配方审批链;缺省 ask=fail-closed deny)。
 // parentAsk 在场时叠加 heavyOp 重操作闸(绕过 allow 规则强制父 agent 审批)——
    // 两者可独立在场(无规则也有重操作闸;rules??[] 已在 loop 侧加固)。
    const childPermission = this.opts.permissionRules?.length || this.opts.parentAsk
      ? {
          rules: this.opts.permissionRules ?? [],
          ...(this.opts.parentAsk
            ? {
                heavyOp: {
                  callerIsSubagent: true,
                  onHeavyAsk: async (call: { name: string; arguments: string }, match: import("@lampgenie/core").HeavyOpMatch) => {
                    let command = "";
                    try { command = String((JSON.parse(call.arguments ?? "{}") as { command?: string }).command ?? ""); } catch { /* 解析失败按空命令走拒绝 */ }
                    return (await this.opts.parentAsk!({ taskId: spec.taskId, role, tool: call.name, command, match })).approved;
                  },
                },
              }
            : {}),
          ...(this.opts.onPermissionAsk
            ? {
                onAsk: async (call: { name: string; arguments: string }) =>
                  await this.opts.onPermissionAsk!(call.name, String(call.arguments ?? "").replace(/\s+/g, " ").slice(0, 120)),
              }
            : {}),
        }
      : undefined;
    onEvent({ type: "ready" });
    // 工具面快照进进度行(output.txt 心跳可见=真实运行取证面;whitelist 缺席时标 fallback)
    onEvent({
      type: "progress",
      note: "工具面[" + (this.opts.toolWhitelist?.length ? "declared" : "fallback") + "]:" + grantedNames.join("/"),
      pct: 5,
    });
    onEvent({ type: "progress", note: "子代理调查中", pct: 30 });

    let cancelled = false;
    let deadlineHit = false;
    let loop: AgentLoop | undefined;
    // 变量前置声明:abort 监听器在 loop 创建前也可能触发(竞态安全)。
    if (spec.parentSignal?.aborted) cancelled = true;
 // 防死 watchdog:不设强制时限,等 loop 自然结束信号;仅
    // 「journal 零新增持续超过阈值(缺省 600s)」才强制退出——卡点报告回给父 agent(卡在哪/最后输出/步数)。
    const STALL_MS = Math.max(this.opts.stallTimeoutMs ?? 600_000, 1_000);
    let lastActivity = Date.now();
 // ---- 机制2/3:心跳判活 + 无产出预警的状态面 ----
    const startedAtMs = Date.now();
    let lastToolAt = startedAtMs; // 最近一次工具调用/返回(journal tool.call|tool.result)
    let toolCallsDone = 0;
    let lastHeartbeatAt = 0; // 0=首条必发
    let lastWarnAt = 0;
    const HEARTBEAT_MS = Math.max(this.opts.heartbeatMs ?? 2_000, 100); // 节流≥2s(缺省;慢盘写放大治理,测试可注小值)
    const WARN_MS = Math.max(this.opts.staleWarnMs ?? 20 * 60_000, 250);
    const hhmmss = (t: number) => {
      const d = new Date(t);
      return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, "0")).join(":");
    };
    // 心跳 flush(机制2):每个 step/tool 节点一行(时间戳+工具名+一句话)——主 agent 与人由此判活。
    // 此前 output.txt 只有 [started]+一条粗粒度 progress,2 小时不更新=死活不可判。
    const heartbeat = (detail: string, force = false) => {
      const now = Date.now();
      if (!force && now - lastHeartbeatAt < HEARTBEAT_MS) return;
      lastHeartbeatAt = now;
      try { onEvent({ type: "progress", note: `[心跳 ${hhmmss(now)}] ${detail}` }); } catch { /* 心跳失败不影响执行 */ }
    };
 // holder 对象:闭包内赋值的 string 变量会被 CFA 收窄成 never( goal 同族),属性赋值不收窄
    const stall: { report: string | null } = { report: null };
    let stepsDone = 0;
    let lastAction = "(尚未开始)";
    let lastAgentText = "";
    let settled = false;
 // ---- P1-4 产出纪律强制提醒(修永久锁)----
    // 判据=该 step 的 message.agent.payload.text **不足实质产出**(空或 < PRODUCTIVE_SUBSTANTIVE_CHARS);
    // step 号取自事件 payload,同 step 多次 message.agent(空响应重试)只计一次。
    // 旧实现用 `seenText` 永久关闭:任何一行非空文本(「我来看看」)就焊死闸门 →
 // 经验证今日 18 个大 run 里 16 个「有文本步 <15%」却一个都不触发。现在改为**循环计数**:
    // 实质产出才清零,零星短文不清零(短文本身不算交付物)。
    const NUDGE_STEPS = Math.max(this.opts.productiveNudgeSteps ?? PRODUCTIVE_NUDGE_STEPS, 0);
    const productive: { pending: number; lastStep: number; nudgedAt: number } = { pending: 0, lastStep: -1, nudgedAt: 0 };
    // 注入侧:把「连续 N 步无实质产出」翻成一次性提醒文本(step 组装消息时被 tips 钩子取走,ephemeral 不落 journal)。
    // 节奏=每再攒满 N 步提醒一次(25/50/75…),不是每步刷。
    const takeProductiveNudge = (): string | null => {
      if (!NUDGE_STEPS || productive.pending - productive.nudgedAt < NUDGE_STEPS) return null;
      productive.nudgedAt = productive.pending;
      return buildProductiveNudge(productive.pending);
    };
    const rawAppend = subJournal.append.bind(subJournal) as (e: never) => void;
    (subJournal as unknown as { append: (e: { kind?: string; payload?: Record<string, unknown> }) => void }).append = (e) => {
      lastActivity = Date.now();
      const p = (e.payload ?? {}) as Record<string, unknown>;
      if (e.kind === "step.end") stepsDone++;
      if (e.kind === "step.start") lastAction = "第 " + String(p.step ?? "?") + " 步开始";
      if (e.kind === "tool.result") lastAction = "工具返回 " + JSON.stringify(p).slice(0, 160);
      if (e.kind === "step.end") lastAction = "第 " + String(p.step ?? "?") + " 步结束(" + String(p.reason ?? "") + ")";
      if (e.kind === "message.agent" && typeof p.text === "string") {
        lastAgentText = p.text.slice(-400);
        const stepNo = typeof p.step === "number" ? p.step : -1;
        // 实质产出(≥200 字)才清零;零星短文不清零也不算「已产出」——旧实现见非空文本即永久关闸
 // (经验证 18 个大 run 里 16 个「有文本步 <15%」却全不触发)。
        const substantive = p.text.trim().length >= PRODUCTIVE_SUBSTANTIVE_CHARS;
        if (substantive) {
          productive.pending = 0;
          productive.nudgedAt = 0;
          productive.lastStep = stepNo;
        } else if (stepNo !== productive.lastStep) {
          productive.lastStep = stepNo;
          productive.pending++;
        }
      }
      // 机制2/3:工具活动登记 + 节流心跳(时间戳+工具名+一句话)
      if (e.kind === "tool.call") {
        lastToolAt = Date.now();
        toolCallsDone++;
        heartbeat("调用 " + String(p.name ?? "?") + "(" + String(p.arguments ?? "").replace(/\s+/g, " ").slice(0, 60) + ")", lastHeartbeatAt === 0);
      } else if (e.kind === "tool.result") {
        lastToolAt = Date.now();
        heartbeat(String(p.name ?? "工具") + " 返回(" + String(p.durationMs ?? 0) + "ms):" + String(p.content ?? "").replace(/\s+/g, " ").slice(0, 80));
      } else if (e.kind === "step.start") {
        heartbeat("第 " + String(p.step ?? "?") + " 步开始(模型思考中)");
      } else if (e.kind === "step.end") {
        heartbeat("第 " + String(p.step ?? "?") + " 步结束(" + String(p.reason ?? "") + ")");
      } else if (e.kind === "message.agent") {
        const calls = Array.isArray(p.toolCalls) ? p.toolCalls.length : 0;
        heartbeat("模型输出 " + String(p.text ?? "").length + " 字" + (calls ? `,发起 ${calls} 个工具调用` : ""));
      }
 // 子代理工作区入账:同一拦截点上裁剪回调(装配方 append 主 journal 为
      // subagent.event)——G2 心跳机制原样保留,本块只增不改;失败静默,入账绝不阻塞子代理执行。
      if (this.opts.onLoopEvent && e.kind) {
        try { this.opts.onLoopEvent({ kind: String(e.kind), payload: trimSubLoopEvent(String(e.kind), p) }); } catch { /* 入账失败不影响子代理 */ }
      }
      rawAppend(e as never);
    };
    // steering(ZCode 机制移植):向运行中的子 agent 中途注入指令,下个 step 生效。
    const steer = (text: string): boolean => {
      if (cancelled || !loop) return false;
      subJournal.append({ kind: "message.user", sessionId: "subagent-" + spec.taskId, payload: { text: `[steer] ${text}` } });
      return true;
    };
 // ---- 机制1:spawn deadline 强制收割(狗food:152min 无一交卷,提示词时间盒被无视)----
    // 到点=子 loop 收中止信号 + 部分结果打包交付(ok=true,finalText 显式标注);收割不是 fail。
    const DEADLINE_MS = Math.max(this.opts.deadlineMs ?? 0, 0);
    const GRACE_MS = Math.max(this.opts.deadlineGraceMs ?? 5_000, 100);
    // 部分结果打包:已有输出(步数/工具调用/最后动作/最后模型文本)=交付物,不编造成完整结论。
    const packagePartial = (): TaskResult & { note?: string } => {
      const ranMin = Math.max(1, Math.round((Date.now() - startedAtMs) / 60_000));
      const lines = [
        `[deadline 收割] 时间盒(${Math.round(DEADLINE_MS / 60_000)} 分钟)已到(实际运行 ${ranMin} 分钟),以下为已完成的部分进展(非最终结论):`,
        `- 已完成 ${stepsDone} 步 / ${toolCallsDone} 次工具调用。`,
        `- 最后动作:${lastAction.slice(0, 200)}。`,
        lastAgentText ? `- 最后输出摘录:${lastAgentText.slice(0, 800)}` : "- (尚无模型文本输出)",
        "如需完整结果:请拆小任务书或带更长 deadlineMin 重派。",
      ];
      return { ok: true, finalText: lines.join("\n"), note: "[deadline] 部分结果(时间盒到,交付已有进展;非完整任务结论)" };
    };
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineGraceTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanupTimers = () => {
      clearInterval(watchdogRef.t);
      clearInterval(warnRef.t);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (deadlineGraceTimer) clearTimeout(deadlineGraceTimer);
    };
    if (DEADLINE_MS > 0) {
      deadlineTimer = setTimeout(() => {
        if (settled || cancelled || stall.report || deadlineHit) return;
        deadlineHit = true;
        try { onEvent({ type: "progress", note: `[deadline] 时间盒到(${Math.round(DEADLINE_MS / 60_000)} 分钟),收割部分结果` }); } catch { /* 通知失败不阻塞 */ }
        try { loop?.cancel("deadline-reached"); } catch { /* 已结束 */ }
        // 二级保险(与 stall watchdog 同形态):挂死的 LLM 调用不响应 abort 时,grace 后直接交付部分结果。
        deadlineGraceTimer = setTimeout(() => {
          if (settled || !deadlineHit) return;
          settled = true;
          cleanupTimers();
          onEvent({ type: "progress", note: "deadline 收割完成(部分结果交付)", pct: 100 });
          void finalizeResult(packagePartial()).then((r) => {
            try { onEvent({ type: "result", result: r }); } catch { /* 通知失败不阻塞 */ }
          });
        }, GRACE_MS);
        deadlineGraceTimer.unref?.();
      }, DEADLINE_MS);
      deadlineTimer.unref?.();
    }
    const resultPromise = (async (): Promise<TaskResult> => {
 // 系统提示按实际授予工具面生成:只读横幅=写类不在 granted;技能索引导读=skill_view 在场。
      const subSystem = [
        `你是 lampgenie-harness 的${roleLabel[role] ?? "子 agent"}(${role},独立上下文,与主 agent 不共享历史)。`,
        "执行纪律:第一步就用工具动手做任务书;你自己就是执行者——禁止把任务转述回去、禁止说『请自行探索/请先阅读』、禁止输出与执行无关的元话语。",
        canWrite
          ? "用提供的工具(读文件/检索/写文件/编辑/命令)完整完成任务——任务书验收标准全满足才算完成。"
          : "只读模式:禁止创建/修改任何文件,禁止执行写操作;用只读工具完成调查后输出报告。",
 // 父子 ask-answer:写/执行角色注入重操作纪律(build 类先申请;拒绝后不绕行)。
        ...(canWrite ? [renderSubagentHeavyOpDiscipline()] : []),
        ...(skillGranted && this.opts.skillIndexText
          ? ["可用 skill_view(category,name) 读技能/经验全文——可读清单如下,按名字调用,不要凭空猜名:\n" + this.opts.skillIndexText]
          : []),
 // planner 角色专属板规范(变更契约图口径——planner 必然画板,别的角色零注入)。
        ...(role === "planner" ? [PLANNER_BOARD_SPEC] : []),
 // code_sense 在授予面=注入调用手册——explore 等只读子代理的主生产力工具,
 // 不教用法就会退化成「拿着 code_sense 只会 grep」(用户用户反馈)。写角色默认不带,不注入。
        ...(grantedNames.includes(SENSE_TOOL_NAME) ? [SUBAGENT_CODE_SENSE_PLAYBOOK] : []),
        "完成后回复简明报告:做了什么/关键产出(带 文件:行号)/任何偏离任务书的地方;失败就如实说失败,不编造成功。",
        "回复里禁止出现任何内部协议标记(<think>、DSML 参数标签等)与任务书原文复述——那不是给用户看的内容。",
        "绝不主动创建文档文件(*.md/README);除非任务书明确要求。",
      ].join("\n");
      const toolSuffix = `(工作目录:${spec.workdir};可用工具:${grantedNames.join("/")})`;
      const loopSessionId = "subagent-" + spec.taskId;
      readSessionRef.value = loopSessionId; // 读文件登记键(「已读清单/别整读」提醒的数据源)
      loop = new AgentLoop({
        // 子代理上下文独立:不经主 journal(append no-op/readAll 空)
        // 真 MemoryJournal(steering 介质):steer() 向其追加用户消息,loop 下一个 step 重导出即见。
        journal: subJournal,
        sessionId: loopSessionId,
        // 写前持久化屏障(与主 agent 同源):undefined 不写键 → loop 缺省 hard,旧行为不变。
        ...(this.opts.writeBarrier ? { writeBarrier: this.opts.writeBarrier } : {}),
 // 时间盒收敛提醒——剩余 ≤2 分钟时注入一次临时提醒,强制「先输出结论、别再检索」。
 // 注意:两个 explore 用满 9 分钟时间盒、76 步、零文本产出(收割时只有「尚无模型文本输出」)。
        ...(this.opts.deadlineMs && this.opts.deadlineMs > 0
          ? { deadlineAt: spawnAt + this.opts.deadlineMs, deadlineWarnMs: Math.min(120_000, Math.round(this.opts.deadlineMs * 0.2)) }
          : {}),
        system: subSystem,
        llm: this.opts.llm,
 // 子代理轨迹照落文件(subJournal 是内存件,指针事件 no-op——文件面 ls 可发现)。
        llmTrace: makeLlmTraceSink(subJournal),
 // 与 coding agent 同构——流式打字机 + 同一套上下文压缩配置。
        ...(this.opts.onStream ? { onStream: this.opts.onStream } : {}),
        // P1-4 产出纪律强制提醒:每步组装消息时取一次「连续零文本步数已满 N」的硬提醒(ephemeral 不落
 // journal,与 deadlineWarn/todo 提醒同机制)。注意:两个 explore 跑满 140 步/263 次工具调用零文本。
        ...(NUDGE_STEPS > 0 ? { tips: () => takeProductiveNudge() } : {}),
        ...(this.opts.compactHook ? { compactHook: this.opts.compactHook } : {}),
        ...(this.opts.microcompact ? { microcompact: this.opts.microcompact } : {}),
        // 写时定形 spill(2026-11 token 轮 02):子代理与主 loop 同源注入。
        ...(this.opts.spill ? { spill: this.opts.spill } : {}),
 //  图片 offload:与主 loop 同一套(缺省根=workdir;装配方传 repoRoot)。
        imageOffload,
        ...(this.opts.bigIntake ? { bigIntake: this.opts.bigIntake } : {}),
        ...(this.opts.growthSpurtTokens !== undefined ? { growthSpurtTokens: this.opts.growthSpurtTokens } : {}),
        ...(this.opts.modelScoring ? { modelScoring: this.opts.modelScoring } : {}),
        tools: withToolDeadlineDefaults(wireTools) as never,
 // 执行 deadline 帽(冻结治理):自管工具豁免,其余 600s;详见 withToolDeadlineDefaults。
        ...(TOOL_TIMEOUT_CAP_MS > 0 ? { toolTimeoutMs: TOOL_TIMEOUT_CAP_MS } : {}),
        maxSteps: this.opts.maxSteps ?? 3000,
        ...(childPermission ? { permission: childPermission } : {}),
      });
      const out0 = await loop.runTurn(spec.instructions + "\n\n" + toolSuffix);
      if (deadlineHit) {
        // 机制1:deadline 收割=交付已有进展(ok=true + 显式部分结果标注);与用户取消(丢弃)语义分离。
 // 注意:收割触发的 cancel 会让 runTurn 以 cancelled 返回——此时 out0 若非空也只是
        // 「最后一个完成 step 的模型文本」,不是任务完成;统一走部分结果打包(其中已含最后输出摘录)。
        return packagePartial() as TaskResult & { note?: string };
      }
      if (cancelled) {
        if (stall.report) return { ok: false, finalText: stall.report, error: { kind: "stalled", detail: stall.report.slice(0, 200) } };
        return { ok: false, finalText: out0, error: { kind: "cancelled" } };
      }
 // F2(验收):空 finalText 会让父代理拿到「(子 agent 未返回结果)」并开始瞎猜——
      // 清洗协议标签残渣;仍空则从子 journal 提取最后助手文本/错误,给父代理可用的诊断性结果。
      let out = String(out0 ?? "")
        .replace(/<\/?(tool_result|tool_message|task_serialism|system-提示)[^>]*>/g, "")
        .replace(/<think>[\s\S]*?<\/think>/g, "")
        .trim();
      if (!out) {
        let lastErr = "";
        let lastText = "";
        try {
          for (const e of subJournal.readAll() as { kind?: string; payload?: Record<string, unknown> }[]) {
            const p = (e.payload ?? {}) as Record<string, unknown>;
            if (e.kind === "step.end" && p.error) lastErr = String(p.error).slice(0, 300);
            if (e.kind === "message.agent" && p.text) lastText = String(p.text).slice(0, 600);
          }
        } catch { /* 诊断尽力而为 */ }
        if (lastText) out = lastText;
        else {
          out = `(子代理未产出最终文本${lastErr ? ";最后错误:" + lastErr : ";已达步数上限或模型未给终稿"})`;
          return { ok: false, finalText: out, error: { kind: lastErr ? "backend-crash" : "budget-exhausted", detail: out.slice(0, 200) } };
        }
      }
 // 串台/协议泄漏守卫:首跑结果与任务书无关或泄内部协议 → 自动重派一次,标注后返回。
      // 已真实落板的子代理不走文本相关性判据:planner 的终稿=短摘要,长任务书下必然低覆盖(误杀)。
      const wroteBoard = hasBoardWriteEvidence(subJournal.readAll() as { kind?: string; payload?: unknown }[]);
      if (!wroteBoard && (isCrosstalk(spec.instructions, out) || isProtocolLeak(spec.instructions, out))) {
 // P1-5 串台重派前置兜底(修「兜底永不生效」):
        // 旧实现用 `!isCrosstalk(instructions, joined)` 做出口判据——但 joined 的末条往往就是
        // 刚被判串台的那份终稿,同一把尺子再量一遍必然还是串台 → **结构上不可能救回**。
 // 经验证:真实 GLM 端到端任务日志仍打印「疑似串台…自动重派」,15 个 -retry 目录/230 次调用。
        // 修法两条**并行**出口(判据本身不放宽,协议泄漏仍一律重派):
        //   ① 逐条筛:每条 message.agent 单独过 isCrosstalk/isProtocolLeak,通过的留下——
        //      中间有实质产出的段落能救回,被污染的终稿被丢掉(这是旧版想干但干不成的事);
        //   ② 工作证据:这一轮确实做了活(成功工具回执 ≥ CROSSTALK_GUARD_MIN_TOOLS 且产出够长)
        //      时,词面相关性低可能只是任务书长/术语改写,不该整轮重跑。
        const entries = subJournal.readAll() as { kind?: string; payload?: unknown }[];
        const picked = pickUsableAgentText(spec.instructions, entries);
        const work = countToolWorkEvidence(entries);
        const salvaged = picked.text.length >= CROSSTALK_GUARD_MIN_CHARS
          && (!isProtocolLeak(spec.instructions, picked.text) || work.okTools >= CROSSTALK_GUARD_MIN_TOOLS);
        if (salvaged) {
          onEvent({
            type: "progress",
            note: `[crosstalk-guard] 首跑终稿被判可疑,但子 journal 有可用产出(${picked.text.length} 字,筛掉 ${picked.dropped} 段;成功工具回执 ${work.okTools} 个),直接采用(未重派)`,
            pct: 70,
          });
          return {
            ok: true,
            finalText: picked.text + "\n\n[串台守卫] 首跑结果被判为可疑,但子 journal 内有可用产出"
              + `(筛选保留 ${picked.kept} 段、丢弃 ${picked.dropped} 段),已直接采用(未重派)。`,
            note: "[crosstalk-guard] 采用子 journal 产出,省一轮重派",
          } as TaskResult & { note?: string };
        }
        onEvent({
          type: "progress",
          note: `疑似串台(结果与任务书无关),自动重派[guard: okTools=${work.okTools} 可用文本=${picked.text.length}字 筛掉=${picked.dropped}]`,
          pct: 60,
        });
        const retry = new AgentLoop({
          journal: subJournal,
          sessionId: "subagent-" + spec.taskId + "-retry",
          // 写前持久化屏障:重派 loop 与首跑同值(同一 this.opts.writeBarrier)。
          ...(this.opts.writeBarrier ? { writeBarrier: this.opts.writeBarrier } : {}),
          system: [
            `你是 lampgenie-harness 的${roleLabel[role] ?? "子 agent"}(${role},独立上下文)。`,
            "上一轮结果与任务书无关(疑似模型服务端串扰)已被丢弃;请只依据本任务书重新完成调查/执行。",
            "完成后回复简明报告;失败就如实说失败,不编造成功。",
          ].join("\n"),
          llm: this.opts.llm,
          llmTrace: makeLlmTraceSink(subJournal), // 重派轨迹同落(-retry 后缀目录)
          ...(this.opts.onStream ? { onStream: this.opts.onStream } : {}),
          ...(this.opts.compactHook ? { compactHook: this.opts.compactHook } : {}),
          ...(this.opts.microcompact ? { microcompact: this.opts.microcompact } : {}),
          ...(this.opts.spill ? { spill: this.opts.spill } : {}),
 //  图片 offload:重派 loop 与首跑同值(同一 imageOffload)。
          imageOffload,
        ...(this.opts.bigIntake ? { bigIntake: this.opts.bigIntake } : {}),
          ...(this.opts.growthSpurtTokens !== undefined ? { growthSpurtTokens: this.opts.growthSpurtTokens } : {}),
          ...(this.opts.modelScoring ? { modelScoring: this.opts.modelScoring } : {}),
          tools: withToolDeadlineDefaults(wireTools) as never,
 // 执行 deadline 帽(冻结治理):自管工具豁免,其余 600s;详见 withToolDeadlineDefaults。
        ...(TOOL_TIMEOUT_CAP_MS > 0 ? { toolTimeoutMs: TOOL_TIMEOUT_CAP_MS } : {}),
          maxSteps: this.opts.maxSteps ?? 3000,
          ...(childPermission ? { permission: childPermission } : {}),
        });
        // 重派同样受 spawn deadline 约束:旧实现只把 loop 指向首跑,deadline 到点 cancel 的是已结束的
 // 旧 loop,重派变成无人收割的长跑(经验证 planner 误判重派后卡住,父 agent 一直等)。
        loop = retry;
        const out1 = await retry.runTurn(spec.instructions + "\n\n" + toolSuffix);
        if (deadlineHit) return packagePartial() as TaskResult & { note?: string };
        const cleaned1 = String(out1 ?? "").replace(/<\/??(tool_result|tool_message|task_serialism)[^>]*>/g, "").trim();
        return { ok: true, finalText: cleaned1 || out, note: `[串台守卫] 首跑结果与任务书无关已丢弃并自动重派;本结果为重派产出${cleaned1 ? "" : "(重派仍空,回退首跑)"}\n` + (cleaned1 || out) } as TaskResult & { note?: string };
      }
      return { ok: true, finalText: out };
    })();

    // watchdog:周期=min(15s, 阈值/4);触发=cancel loop;cancel 后 10s 未落终态(挂死的
    // LLM 调用不响应 abort)→ 二级保险直接产出结果事件,父 agent 不被拖死。
    // deadlineHit 已触发时不抢跑(收割路径有自己的 grace 保险,终态=部分结果而非 stalled)。
    const watchdogRef: { t?: ReturnType<typeof setInterval> } = {};
    const warnRef: { t?: ReturnType<typeof setInterval> } = {};
    const watchdog = setInterval(() => {
      if (cancelled || deadlineHit || stall.report || settled) return;
      if (Date.now() - lastActivity <= STALL_MS) return;
      const silentSec = Math.round((Date.now() - lastActivity) / 1000);
      stall.report = [
        "子代理防死强制退出:已 " + silentSec + " 秒无任何动静(超过 " + Math.round(STALL_MS / 1000) + "s 阈值)。",
        "已完成 " + stepsDone + " 步;卡点:最后动作=" + lastAction + "。",
        lastAgentText ? "最后输出摘录:" + lastAgentText : "(无任何模型输出——大概率挂在 LLM 调用或首个工具前)。",
      ].join("\n");
      cancelled = true;
      try { loop?.cancel("stall-watchdog:600s 无动静"); } catch { /* 已结束 */ }
      setTimeout(() => {
        if (settled || !stall.report) return;
        settled = true;
        cleanupTimers();
        onEvent({ type: "progress", note: "防死强制退出", pct: 100 });
        const stalled: TaskResult = { ok: false, finalText: stall.report, error: { kind: "stalled", detail: stall.report.slice(0, 200) } };
        void finalizeResult(stalled).then((r) => {
          try { onEvent({ type: "result", result: r }); } catch { /* 通知失败不阻塞 */ }
        });
      }, 10_000);
    }, Math.max(250, Math.min(15_000, Math.floor(STALL_MS / 4))));
    watchdog.unref?.();
    watchdogRef.t = watchdog;
    // 机制3:无产出预警(缺省 20min 无新工具调用)——[warn] 行进 output.txt;重复预警按同阈值间隔,
    // 有新工具活动即自然静默。主 agent 侧另有 task_output 的 stale 标记(注册表 lastEventAt,wiring 层)。
    warnRef.t = setInterval(() => {
      if (settled || cancelled || deadlineHit) return;
      const now = Date.now();
      if (now - lastToolAt <= WARN_MS || now - lastWarnAt < WARN_MS) return;
      lastWarnAt = now;
      const silentMin = Math.max(1, Math.round((now - lastToolAt) / 60_000));
      try {
        onEvent({ type: "progress", note: `[warn] 无进展 ${silentMin} 分钟(自上次工具调用 ${hhmmss(lastToolAt)});如已卡死可 steer 或重派` });
      } catch { /* 预警失败不阻塞 */ }
    }, Math.max(250, Math.min(30_000, Math.floor(WARN_MS / 4))));
    warnRef.t.unref?.();

    void resultPromise.then(async (r) => {
      // deadline grace 可能已先交付部分结果(重派/挂死调用不响应 abort);此处不得二次落终态。
      if (settled) return;
      settled = true;
      cleanupTimers();
      const finalized = await finalizeResult(r);
      onEvent({ type: "progress", note: "完成", pct: 100 });
      onEvent({ type: "result", result: finalized });
    }).catch(async (err) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      const failed = await finalizeResult({ ok: false, finalText: "", error: { kind: "backend-crash", detail: String(err).slice(0, 200) } });
      onEvent({ type: "result", result: failed });
    });

    return {
      taskId: spec.taskId,
      async cancel() { cancelled = true; try { loop?.cancel("subagent cancel"); } catch { /* 已结束 */ } },
      async steer(text: string) { return steer(String(text ?? "").trim()); },
      async respondPermission() { /* 只读工具集无权限请求 */ },
    } as SubagentHandle;
  }
}
