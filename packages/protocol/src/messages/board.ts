/**
 * 语义白板域消息:BoardDocZ/BoardNodeZ 等 schema 与 board.* 消息。
 * 自 index.ts(2941 行)按域拆分,逐字搬移。
 */
import { z } from "zod";
import { Envelope } from "./core.js";
// [CROSS-IMPORTS]
// ---- 语义流程白板:agent 先画后改的设计白板;节点连接 code-index ----
/** 语义流程编码:函数框内的步骤(step 顺序/branch 分支/loop 循环),递归。 */
export type BoardFlowStep = {
  type: "step" | "branch" | "loop";
  text?: string;
  cond?: string;
  over?: string;
  then?: BoardFlowStep[];
  else?: BoardFlowStep[];
  body?: BoardFlowStep[];
};
export const BoardFlowStepZ: z.ZodType<BoardFlowStep> = z.lazy(() =>
  z.object({
    type: z.enum(["step", "branch", "loop"]),
    text: z.string().max(300).optional(),
    cond: z.string().max(200).optional(),
    over: z.string().max(120).optional(),
    then: z.array(BoardFlowStepZ).max(20).optional(),
    else: z.array(BoardFlowStepZ).max(20).optional(),
    body: z.array(BoardFlowStepZ).max(20).optional(),
  }),
);
/** 节点→code-index 符号连接:名字+签名行文本锚(行号会漂移,锚可重定位)。 */
export const BoardSymbolRefZ = z.object({
  repo: z.string().max(80).optional(),
  name: z.string().min(1).max(200),
  file: z.string().max(400).optional(),
  line: z.number().int().positive().optional(),
  anchor: z.string().max(300).optional(),
});
/** 工作流板节点参数(wf-* 节点的类型化配置;全可选=旧节点零破坏,编译期按 kind 校验必填):
 * wf-script/wf-test 用 command+timeoutMs;wf-agent 用 actor+instructions;
 * wf-condition 用 cond(JS 表达式,变量域 R["<nodeId>"]);wf-notify 用 message。 */
export const BoardNodeWfZ = z.object({
  command: z.string().max(2000).optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  actor: z.string().max(60).optional(),
  instructions: z.string().max(4000).optional(),
  cond: z.string().max(500).optional(),
  message: z.string().max(1000).optional(),
});
/** 代码级落目标:节点上的可执行验收契约(accept=怎么写才算过;evidence=跑过的证据)。
 * 背景注意:桌面 exe 任务板上「首启引导」节点有 DoD 文案但既没实现也没人核对,交付 llm=off/echo 被吐槽
 * 「根本不干活」——根因=节点无验收绑定、完工无证据门。
 * 全字段可选:旧板(起的所有板)无这些字段照常解析,旧客户端零影响。 */
export const BoardAcceptZ = z.object({
 /** 可执行验收:命令或明确的验证动作(如 `pnpm vitest run test/x.test.ts`、`启动 exe 截图确认无 API Key 引导`)。 */
  cmd: z.string().min(1).max(500),
 /** 期望输出/行为片段(命不中=不通过)。 */
  expect: z.string().max(300).optional(),
 /** 验收类型(变更契约图四类):command=命令/browser=浏览器/manual=人工检查/negative=负面断言。
 * 可选以兼容旧板;agent 新落板时应显式标类型(板校验会软提示缺 type)。 */
  type: z.enum(["command", "browser", "manual", "negative"]).optional(),
 /** 为什么验收这一条(可选说明)。 */
  note: z.string().max(300).optional(),
});
export type BoardAccept = z.infer<typeof BoardAcceptZ>;
/** 证据落账时捕获的目标文件指纹:文件在证据之后被改动/消失 → 该证据视为过期,
 * 不再算覆盖、节点不算 passed。旧 evidence 无 files 字段 = 不做任何 stale 判定(向后兼容,逐字不变)。 */
export const BoardEvidenceFileZ = z.object({
 /** 捕获时解析出的绝对路径(读时直接 stat,不依赖调用方再传根)。 */
  path: z.string().min(1).max(400),
  mtimeMs: z.number(),
  size: z.number(),
 /** 代码文本且 ≤512KB 才有;内容变而 mtime/size 恰好未变时靠它识别。 */
  sha256: z.string().max(64).optional(),
});
export type BoardEvidenceFile = z.infer<typeof BoardEvidenceFileZ>;
/** 证据记录:agent 回填「这条 accept 跑过了,结果如何」;at 由服务端补(客户端传值被覆盖)。 */
export const BoardEvidenceZ = z.object({
 /** 对应 BoardAccept.cmd 原文(按 cmd 匹配验收项;不做模糊匹配)。 */
  cmd: z.string().min(1).max(500),
  ok: z.boolean(),
  at: z.number().default(0),
  note: z.string().max(300).optional(),
 /** 经验证输出摘录(截断,防巨型日志撑爆板)。 */
  output: z.string().max(2000).optional(),
 /** 落账时目标文件指纹(≤12;由 board-store 写盘路径捕获,客户端传值不生效)。 */
  files: z.array(BoardEvidenceFileZ).max(12).optional(),
 /** 指纹捕获时刻(毫秒)。 */
  capturedAt: z.number().optional(),
});
export type BoardEvidence = z.infer<typeof BoardEvidenceZ>;
export const BoardNodeZ = z.object({
  id: z.string().min(1).max(60),
 /** 六期工作流语义:module/function=代码件;llm=模型调用;tool=工具/外部系统;io=输入/输出;decision=判断分支;note=备注。 */
 /** 七期工作流全类型集:io≈Start/Answer,decision≈IfElse,aggregate≈VariableAggregator,
 * retrieval≈KnowledgeRetrieval,classifier≈QuestionClassifier;module/function/note=代码世界原生件。 */
 /** 页面结构板族:page=页面(线框)/section=区块/component=组件/nav=导航条。 */
 /** 工作流板可执行节点族(docKind=workflow 专用,映射 harness-workflow 引擎能力):
 * wf-script=world.run 白名单命令/wf-test=world.run+断言 report/wf-agent=agent.ask 子代理/
 * wf-condition=条件分支(出边 label 真/假)/wf-parallel=并发 fan-out(Promise.all)/
 * wf-notify=report 成果登记。参数配置走 wf 字段(见 BoardNodeWfZ)。 */
  kind: z.enum([
    "module", "function", "decision", "note", "llm", "tool", "io",
    "start", "end", "http", "template", "aggregate", "loop", "retrieval", "classifier", "agent",
    "page", "section", "component", "nav",
    "wf-script", "wf-test", "wf-agent", "wf-condition", "wf-parallel", "wf-notify",
  ]).default("function"),
  label: z.string().min(1).max(160),
 /** 这个模块干什么用(用户核心诉求,强制非空)。 */
  summary: z.string().min(1).max(500),
 /** fixH3 领域阶段名(白板泳道分组,如「01 采集」「02 处理」「03 输出」):按业务阶段编号,
 * 不是技术分层;面板流动布局按它画虚线泳道框。缺省=按阶段前缀/kind 族回退分组。 */
  group: z.string().max(80).optional(),
 /** 改动前的形态(「原来是什么」;modify/delete 节点应填,add/keep 可空)。 */
  before: z.string().max(500).optional(),
 /** 原来是什么→改成什么:add 新增/modify 修改/delete 删除/keep 仅涉及不改。 */
  change: z.enum(["add", "modify", "delete", "keep"]).default("modify"),
 /** 模块完成标记(五期实时面板):agent 每落实一个模块即置 true,面板实时出进度。 */
  done: z.boolean().default(false),
 /** 用户评论(查看态追加,服务端 board.comment 合并;「按板续作」会带进指令)。 */
  comments: z.array(z.string().max(500)).max(20).default([]),
  symbolRef: BoardSymbolRefZ.optional(),
 /** 纯文件链(模块/页面/架构节点的入口文件)——只驱动画布「文件链」与档案跳转,
 * 不参与 symbolRef 三态判定(这些节点没有符号语义)。 */
  fileRef: z.string().max(400).optional(),
  flow: z.array(BoardFlowStepZ).max(40).default([]),
 /** 工作流板节点参数(wf-* 节点;design/page 板节点无此字段)。 */
  wf: BoardNodeWfZ.optional(),
 /** 代码级落目标:优先级档。P0=必做(必须带 accept 才允许落板;完工须有证据);
 * P1/P2=余力项(不强制 accept)。缺省=undefined(旧板/未标档节点,不参与 P0 校验与覆盖率)。 */
  phase: z.enum(["P0", "P1", "P2"]).optional(),
 /** 这个节点要改的文件/符号清单(验收目标面;evidence/覆盖率核对据此说「改到哪了」)。 */
  targets: z.array(z.string().max(400)).max(30).optional(),
 /** 可执行验收契约(P0 节点非空强制):每条 cmd 怎么跑、期望什么。 */
  accept: z.array(BoardAcceptZ).max(12).optional(),
 /** 验收证据:agent 回填每条 accept 的执行结果(at 由服务端补)。 */
  evidence: z.array(BoardEvidenceZ).max(24).optional(),
  pos: z.object({ x: z.number(), y: z.number() }).optional(),
});
export const BoardDocZ = z.object({
 /** 板文档版本:1=旧板;2= 迁移脚本升级版(字段仍按可选读取,零新必填)。
 * 用 union 而非硬切 2:滚动窗口内新旧网关都能读;写入方(upsert)仍写 1,迁移脚本显式写 2。 */
  version: z.union([z.literal(1), z.literal(2)]),
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
  title: z.string().min(1).max(200),
  status: z.enum(["draft", "implementing", "done"]).default("draft"),
 /** 板类型(页面结构板):design=模块/流程设计板(缺省,向后兼容旧板);
 * page=页面结构板——节点=页面/区块/组件(线框形态),边=导航/包含,规划类任务产物;
 * workflow=工作流板——节点=wf-* 可执行步骤(参数走 wf 字段),边=执行顺序/
 * 分支(label 真/假),「编译执行」把画布编译成 harness-workflow 脚本运行。 */
  docKind: z.enum(["design", "page", "workflow"]).optional(),
 /** 任务板型(变更契约图):板校验按板型切换规则——code/test/docs/ui/ui-func/
 * fault(故障链,不要求代码变更 before)/refactor(要求现状/目标泳道)/perf/data/
 * contract/deploy/research/orchestration。缺省=undefined(旧板按通用 design 规则软校验)。
 * composition=办公/产出类任务(写 PPT/汇报/文章/调研报告)的「作业思路板」:
 * 章节节点复用 kind:"section",章间关系用 data 边(->>)的 label 关系词(承接/递进/并列/对照/因果)
 * 表达,不引入新的 edge kind。 */
  boardType: z.enum([
    "code", "test", "docs", "ui", "ui-func", "fault", "refactor", "perf",
    "data", "contract", "deploy", "research", "orchestration",
 // 更多板型:matrix=候选×维度决策矩阵(复用 research 矩阵规则与表格视图)。
    "matrix",
 // composition=作业思路板(主题/受众/结构/章节/章间关系;不画执行步骤)。
    "composition",
  ]).optional(),
 /** 规模分级:S=1~3 节点一次到位/M=骨架≤9/L=多模块/迁移两版+风险回滚。
 * 可选以兼容旧板;planner 新落板应显式标注,板校验据此提示规模超标。 */
  scale: z.enum(["S", "M", "L"]).optional(),
 /** 文档体裁(docs 板):board-skills DOC_GENRES 的 key(review-solution/
 * review-code/research/summary/guide/generic)。可选;类型门按体裁必答维度查覆盖。 */
  docGenre: z.string().min(2).max(40).optional(),
 /** 乐观锁:每次写入 +1,人/agent 并发改板防互相覆盖。 */
  rev: z.number().int().nonnegative().default(0),
 /** 符号解析根(任务项目 workdir;link 解析与索引查询用)。 */
  root: z.string().max(500).optional(),
  nodes: z.array(BoardNodeZ).min(1).max(60),
  edges: z.array(z.object({
    from: z.string(), to: z.string(),
 /** 页面结构板:nav=页面间导航(箭头+触发器标签)/contains=包含(区块属于页面,无线头)。 */
    kind: z.enum(["call", "data", "verify", "nav", "contains"]).default("call"),
    label: z.string().max(120).optional(),
 /** 用户虚拟边(画布拖拽/编辑态人工加的连线)——与 agent code_index 验证边显式区分,
 * 虚线渲染+导出标注+续作指令注明「待核实」。缺省 false=验证边。 */
    virtual: z.boolean().optional(),
  })).max(120).default([]),
  planned_files: z.array(z.string().max(400)).max(60).default([]),
 /** 任务完成时从 checkpoint diffstat 回填(计划 vs 实际对账)。 */
  actual_files: z.array(z.string().max(400)).max(60).optional(),
 /** 人改板变更集(2026-10):人经 board.save 改板时服务端比对前一版,
 * 记下「人这次动了哪些节点」;「按板续作」据此只派变更集(不再整板塞给 agent)。
 * ids 去重且保持入参顺序;rev=记录这次变更集时的板 rev(派发后清空为 ids:[], rev 更新为最新)。
 * 全字段可选/带 default:旧板(无此字段)照常解析,旧客户端零影响。 */
  humanEdits: z.object({
    ids: z.array(z.string().max(60)).max(60).default([]),
    rev: z.number().int().nonnegative().default(0),
 /** 每个变更节点的字段级改动摘要(如 {n1:["label","summary"]}),「按板续作」拼「改动:」行用;
 * 缺省=change 明细未记录(只按 ids 派发)。 */
    changes: z.record(z.array(z.string().max(40)).max(12)).optional(),
  }).optional(),
  updatedAt: z.number().default(0),
});
export type BoardDoc = z.infer<typeof BoardDocZ>;
/** 符号连接三态:linked=已连接/moved=行漂移(已按锚重定位)/broken=断链。 */
export const BoardLinkStateZ = z.object({
  nodeId: z.string(),
  state: z.enum(["linked", "moved", "broken"]),
  file: z.string().optional(),
  line: z.number().int().optional(),
  note: z.string().optional(),
});
export type BoardLinkState = z.infer<typeof BoardLinkStateZ>;
export const BoardGet = Envelope.extend({
  type: z.literal("board.get"),
 /** 会话必填(server 无 sid 即拒);taskId 缺省=会话最新板。 */
  sessionId: z.string().min(1),
  taskId: z.string().min(1).optional(),
});
export const BoardList = Envelope.extend({ type: z.literal("board.list"), sessionId: z.string().min(1) });
/** 白板出图请求:把一块板渲染成 SVG(taskId 缺省=会话最新板)。 */
export const BoardDiagramRequest = Envelope.extend({
  type: z.literal("board.diagram"),
  sessionId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  theme: z.enum(["light", "dark"]).optional(),
 /** 出图前视图态过滤(大板看不清时的服务端裁剪;不改板数据):
 * writers=只留这些写者前缀的节点(空/缺省=不过滤),foldGroups=按 group 折叠大分组,
 * foldMin=折叠阈值(组内节点数 >= 该值才折叠,缺省 5)。见 apps/gateway/src/board-filter.ts。 */
  filter: z.object({
    writers: z.array(z.string()).max(40).optional(),
    foldGroups: z.boolean().optional(),
    foldMin: z.number().int().min(2).max(60).optional(),
  }).optional(),
});
export type BoardDiagramRequest = z.infer<typeof BoardDiagramRequest>;
/** 白板出图回包:svg 为 `<svg ...>` 全文,diagnostics 为 flowkit 编译/导出诊断。 */
export const BoardDiagramResult = Envelope.extend({
  type: z.literal("board.diagram.result"),
  sessionId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  ok: z.boolean(),
  svg: z.string().default(""),
  diagnostics: z.array(z.object({
    line: z.number().default(0),
    code: z.string(),
    severity: z.string(),
    message: z.string(),
  })).default([]),
  elapsedMs: z.number().default(0),
 /** ok=false 时的失败码(board-not-found / 渲染失败原文)。 */
  error: z.string().optional(),
});
export type BoardDiagramResult = z.infer<typeof BoardDiagramResult>;
// P3 人参与编辑(二期):人改板=改设计不改码;rev 乐观锁,冲突回 board.conflict。
export const BoardSave = Envelope.extend({
  type: z.literal("board.save"),
  sessionId: z.string().min(1),
  taskId: z.string().min(1),
  doc: BoardDocZ,
  baseRev: z.number().int().nonnegative(),
});
/** 按板续作:把当前白板编成后续指令发回原会话(新任务)。 */
export const BoardContinue = Envelope.extend({
  type: z.literal("board.continue"),
  sessionId: z.string().min(1),
  taskId: z.string().min(1),
  note: z.string().max(2000).optional(),
 /** 人从界面选区派发时带的节点 id 集:优先于 doc.humanEdits.ids(选区派发只派这几个节点);
 * 缺省=按 doc.humanEdits.ids;两者都无=回退整板(旧板/无人工改动)。 */
  nodeIds: z.array(z.string().max(60)).max(60).optional(),
});
/** 手绘批注层(每任务一张 PNG,dataURL base64;上限防巨型涂鸦)。 */
export const BoardOverlaySave = Envelope.extend({
  type: z.literal("board.overlay.save"),
  sessionId: z.string().min(1),
  taskId: z.string().min(1),
  dataB64: z.string().max(5_600_000),
});
/** 手绘批注层拉取(会话级落盘:无语义板时 taskId=__session__,笔迹跟会话走,换浏览器/刷新不丢)。 */
export const BoardOverlayGet = Envelope.extend({
  type: z.literal("board.overlay.get"),
  sessionId: z.string().min(1),
  taskId: z.string().min(1),
});
/** 节点评论(五期):查看态追加,服务端合并(免 rev 冲突,agent 并发更新板也不丢评论)。
 * c1(编辑/删除):op 缺省 append 保持旧语义;update/delete 按 index 定位**同节点已有评论**
 * (node.comments 仍是纯字符串数组,持久化形状不变),index 由面板按当前渲染顺序给出。 */
export const BoardComment = Envelope.extend({
  type: z.literal("board.comment"),
  sessionId: z.string().min(1),
  taskId: z.string().min(1),
  nodeId: z.string().min(1),
 /** append/update 必带(非空,服务端再 trim+截断 500);delete 不需要正文。 */
  text: z.string().min(1).max(500).optional(),
 /** append=追加(缺省,向后兼容);update=按 index 改;delete=按 index 删。 */
  op: z.enum(["append", "update", "delete"]).optional(),
 /** update/delete 必填(0 基,指向该节点 comments 的下标)。 */
  index: z.number().int().min(0).optional(),
});
/** 从代码生成模块图(七期):code-sense 整理 file 的符号为工作流模块节点+真实调用边,落成一块新板。 */
export const BoardFromCode = Envelope.extend({
  type: z.literal("board.fromcode"),
  sessionId: z.string().min(1),
  file: z.string().min(1).max(400),
  projectId: z.string().min(1).optional(),
});
/** code-sense 分析产物直接生成可编辑语义板。
 * source=modulemap(全仓模块依赖)/archmap(LLM 架构图,无 LLM 显式降级)/sequence(符号静态时序,需 query)/pageflow(页面流)。 */
export const BoardFromSense = Envelope.extend({
  type: z.literal("board.fromsense"),
  sessionId: z.string().min(1),
  source: z.enum(["modulemap", "archmap", "sequence", "pageflow", "decision"]),
 /** sequence=符号名;pageflow/modulemap 可空(全仓);archmap=意图描述(可空走缺省)。
 * decision=符号名(query)或文件相对路径(file)或函数名(fn),三者至少一个。 */
  query: z.string().max(300).optional(),
 /** decision:符号名/函数名(query 亦可);file=源文件相对路径(与 symbol 组合定位函数)。 */
  symbol: z.string().max(300).optional(),
  fn: z.string().max(300).optional(),
  file: z.string().max(400).optional(),
  projectId: z.string().min(1).optional(),
});
/** 设计沉淀查询:任务收官的 done 板项目级索引;代码档案「设计沉淀」区数据源。
 * 板全文不走此消息——点击条目由面板复用 board.get(sessionId,taskId) 拿 doc+links。 */
export const BoardArchiveList = Envelope.extend({
  type: z.literal("board.archive.list"),
  projectId: z.string().min(1).optional(),
});
/** 工作流板编译(只编译不跑):画布 doc→harness-workflow 脚本;错误 fail-visible 列出。 */
export const BoardWorkflowCompile = Envelope.extend({
  type: z.literal("board.workflow.compile"),
  sessionId: z.string().min(1),
  taskId: z.string().min(1),
});
/** 工作流板编译执行:编译通过即异步运行(引擎真跑),进度走 board.workflow.progress 广播,
 * 终态 board.workflow.result 广播;编译失败直接回 run.result(errors)。 */
export const BoardWorkflowRun = Envelope.extend({
  type: z.literal("board.workflow.run"),
  sessionId: z.string().min(1),
  taskId: z.string().min(1),
});

// 会话分叉(ZCode session-fork 语义移植,refs: ZCode):新会话完整继承原会话上下文事件。