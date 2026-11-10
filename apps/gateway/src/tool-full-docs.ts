/**
 * 工具面全量说明(2026-10-31 token 轮:工具面瘦身)。
 *
 * **为什么存在**:工具 `description` 每步随 tools 参数重发,是全任务最贵的固定成本。此前
 * board_upsert 把全部规则(17 段中文,约 2000 字符)内联在 description 里,而 tool_view 的摘要+
 * 指路机制因此形同虚设(指路的目标就是正文自己)。现在 wire description 只留**必须常驻**的部分
 * (工具干什么 / action 四值 / P0 accept 硬约束),完整规则搬到这里,由 `tool_view(name=...)`
 * 按需取——与 `tool-view.ts` 的设计意图一致(用时再看,像 MCP)。
 *
 * **口径**:本表是**唯一**被移除内容的去处。改 wire description 删掉的规则段必须落在这里,
 * 否则就是丢信息。`tool_view` 优先返回本表的全文(其次返回工具自身 description)。
 */
import type { Tool } from "@lampgenie/runtime/agent/loop";

/** board_upsert 全量说明书(从 wire description 原样搬出,内容未改)。 */
export const BOARD_UPSERT_FULL_DOC = [
  "设计白板=让人读懂现有代码/内容怎么走的逻辑图(逻辑为主,改动为辅):code/test 板的主形态是**现状控制流程图**——start(触发)→编号步骤(现有代码里真实存在的步骤)→decision/loop→end(结果出口);其它板型节点=现有模块/函数/页面区块。边=控制流/真实调用/数据。**改动不是节点,是节点上的 change 徽标**(keep/modify/add/delete+before)。不画 agent 的实施计划步骤(「写测试/跑验证/实现 X」留在 step.md)、不画执行进度(进度归 task_phase/todo_write)。",
  "**节点**:节点=现有代码/内容里真实存在的一步(不是 agent 的待办);label 名词短语;summary 实现细节≤40字;group 业务阶段泳道;change=add/modify/delete/keep(keep=纯读不动,绝大多数节点;改动只作徽标,不另开节点);modify/delete 填 before 写现状;kind 按件类型;code/test 板必须写 start/end/decision(流程图骨架),其它板型的入口/出口由面板按入度/出度识别,不要 start/end 占位。",
  "**并行写者**:同一会话多个 planner 节点 id 必须带唯一前缀(a1-/b1-),禁 n1.. 撞车。",
  "**成板节奏**:骨架≤9节点,中大型二版丰满;小任务一次到位。",
  "**symbolRef**:先用 code_sense 查真实符号,file/line/anchor(签名行文本);禁止臆造。edges 来自真实调用关系,方向=调用方→被调方,label 写数据格式/触发条件。",
  "**flow**:code/test 板的每个步骤节点必填 2~4 行代码级动作(函数名+参数+条件+写入/广播),面板渲染成卡内代码框;判断点写 branch(cond+then·else),遍历/重试写 loop(over+body)。不搬执行进度。",
  "**代码级落目标**:节点可标 phase(P0/P1/P2,P0=本轮会动的节点)+targets+accept[{cmd,expect,type,note}]+evidence[{cmd,ok,output}]。accept 只对 modify/add/delete 节点要求,keep 节点免 accept;phase=P0 必须有非空 accept(cmd 非空),否则整板拒收。P0 全绿前 status 不得 done。",
  "**动作**:upsert 整板覆盖;evidence 回填验收;audit 只读核对(可 format=json),P0 覆盖率<100% 不宣称完成;prune 清零痕迹残留(缺省 dryRun,需 dryRun:false+confirm:true)。",
  "**与仓库的关系(全板型硬要求)**:每个步骤节点必须标清在仓库里的落点——targets=「仓库相对路径#符号名」、change=keep(纯读不动,写明这是哪个函数)/modify(现有这段要改,必填 before)/add(这里现在没有、要新增)/delete(要删);summary 读出「这是仓库里哪一段现有逻辑」,不写抽象动词。不改的现有函数标 keep,不许把复用标成 add;全 keep 板(纯读逻辑)是合格交付。",
  "**其它板型(非 code/test)**:**现状逻辑图 + 改动徽标**——只画被本次任务牵动的现有链路/区块/章节,不另画一层「计划步骤」;要改的节点打 change 徽标(modify 必填 before 写现状一行),并用 edges 显式连接上下游;每个带徽标的节点回答:改哪里(targets+symbolRef)/在哪个流程(上游→本节点→下游)/改什么(change+before)/内部怎么走(flow)。",
  "**通用硬规则(全板型)**:① symbolRef 禁臆造,先 code_sense 查证,audit 须 linked;targets 非空(模板节点除外)。② modify/delete 必带 before;不可逆改动挂风险节点或回滚 accept。③ 步骤序号 01→02;边显式 label(方向=依赖/数据流);boardType/scale 显式。④ 根因/结论/瓶颈/评分必须有证据入边(label 写证据 file:line/日志/实测)。⑤ 数字/时间承诺带单位/日期,禁「尽快/后续/适当」。⑥ 每条链路有 verify 终点、上游可回溯下游可达、无孤儿。⑦ P0 accept 四类 command/browser/manual/negative,每条带 expect;验证类板型至少 1 条 negative。",
  "**板型/规模**:boardType=code/test/docs/ui/ui-func/fault/refactor/perf/data/contract/deploy/research/orchestration/matrix;scale=S/M/L。**类型画法不在描述里**:按 boardType 调 skill_view(category=\"board\", name=\"<boardType>/draw\") 取该类画法;交板前调 .../audit 自检。禁止凭记忆背 13 类规则。",
  "**板型一致性门**:audit 的 typeIssues 为空才算合格;逐类清单见 <boardType>/audit skill。",
  "**accept 四类**:command(命令+期望)/browser(点哪里→看到什么)/manual(人工清单+截图标准)/negative(不得出现占位/echo/llm=off/禁用态漏画)。",
  "**产品/桌面/安装/打包**:必须挂 P0 冒烟节点(启动→配置→真实任务→负面断言);打包类开工挂 P1 环境预检。",
  "**页面/应用类**:docKind=page 的布局/控件/浮层/多屏规范见 skill_view(category=\"board\", name=\"ui/draw\");UI+功能见 ui-func/draw。",
  "**参数细则**:action=upsert 需 title+nodes;evidence 用 nodeId(单节点)或 evidenceByNode(键=节点 id,值=证据数组,批量);audit 可 all=true 扫本会话全部板;prune 缺省 dryRun=true(只报不删),真删要 dryRun:false+confirm:true。targetTaskId 只允许本任务板/分区板 `<taskId>-<scope>`;scope=并行写者前缀(节点 id 自动加 `${scope}-`,主 agent 不填);template=smoke(旅程冒烟 P0,产品/安装类必挂)/preflight(打包预检 P1)。",
  "**参数细则·节点**:id 短且唯一(edges 引用它);kind 只能取枚举值(枚举外整板拒收),页面板用 page/section/component/nav;label ≤30 字名词短语(超长拒收);summary 必填 ≤40 字不复述 label;group=业务阶段泳道(如「01 采集」);before=改动前形态(modify/delete 必填);targets=要改的文件/符号清单;accept[{cmd 必填,expect,type=command|browser|manual|negative,note}];evidence[{cmd 逐字对齐 accept.cmd,ok,output≤2000字,note}]。symbolRef{name,file,line,anchor(签名行文本,行漂移重定位)};edges[{from,to,kind=call|data|verify|nav|contains,label 写数据格式/触发条件}];flow[{type=step|branch|loop,text,cond,over,then,else,body}]。",
].join("\n");

/** 工具名 → tool_view 返回的全量说明(未列出的工具直接返回其 wire description)。 */
export const TOOL_FULL_DOCS: Readonly<Record<string, string>> = {
  board_upsert: BOARD_UPSERT_FULL_DOC,
  change_surface: [
    "**全链路变更面(概念足迹)**:替换/迁移/下线/重命名一个概念(消息名、journal kind、配置键、面板文案、资源名、测试断言、文档章节)时,用它一次列全落点并在收尾证明「没有残留」。",
    "",
    "**action=scan**:`concept`=被替换的概念词或符号名(多个用逗号分隔,如 `SuperAgent,dh-video`)。返回 markdown checklist,每行 `- [ ] <category> <file>:<line> — <文本>`;同时在 journal 落一条 `custom/change.surface`(含命中 id 集)。**plan-gate 在替换/迁移类任务里要求它先在场**,否则写文件/派子代理被拒。",
    "**scan 同时生成链路图**:分层(层名/层内节点)+ 上下游边 + 建议改动顺序;代码索引可用时边里含调用链,索引不可用则如实标注降级原因(降级不算失败,但不能当链路图在场)。**plan-gate 除清单外还要求链路图在场**:旧清单/手造清单(无链路图)会被单独拒(rule=plan-gate/change-chain),重新 scan 一次同一概念即可补上。",
    "**action=audit**:`resolutions` 逐条给去向:`{file, line?, status: resolved|removed|keep-legacy, reason?}`。`keep-legacy` 必须带 ≥4 字 `reason`(无理由=未处理)。返回 `passed`(0 unexplained)/未通过 + 剩余清单;落 `custom/change.audit`。",
    "**audit 的 verify 证据**:可带 `verify={e2e:[{command,passed,output?}],negatives:[{assertion,passed,evidence?}]}`(e2e ≤10 条、negatives ≤20 条);hard 模式要求两组都非空且全 passed。**语义孤儿检查**:`resolutions` 涉及的文件跑确定性反模式六维,hard 模式要求零 warning;hard 模式下审计不满足会拒绝静默完成(回执判 failed)。",
    "**action=status**:看本任务当前盘点(概念/命中数/分类计数)与上次审计结论。",
    "**action=exempt**:确无链路影响时显式豁免,`reason` 必填(≥8 字),落 `custom/change.exempt`——不许静默跳过。",
    "",
    "**分类口径**(11 类,先路径后模式):protocol=packages/protocol;journal=事件 kind 常量行;config=genie.config/schema/env 名;symbol=其余源码;ui=panel.ts 与 apps/*/ui;assets=资源文件与 assets 目录;deploy=部署脚本/CI/Dockerfile/k8s;db=迁移/schema SQL;i18n=语言包/locale;tests=test/spec;docs=docs/tasks/designs/AGENTS。",
    "**边界**:按字面量出现判定(拼接串/变量中转不认);排除 node_modules/dist/.genie/vendor/.git;二进制与 >1.5MB 文件不读;缺省 grep 通道(整仓毫秒级),`engine=walk` 是降级档。",
    "",
    "**推荐节奏**:plan 阶段 scan → 逐条给去向 → 一次改完 → 汇报前 audit;未通过就继续改,别只改 UI 就收。",
  ].join("\n"),
};

/** 取某工具的全量说明;无专档=回落到工具自身 description。 */
export function fullDocFor(toolName: string, fallbackDescription: string): string {
  return TOOL_FULL_DOCS[toolName] ?? fallbackDescription;
}