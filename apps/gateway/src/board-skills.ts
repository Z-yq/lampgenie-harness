/**
 * 板型分阶段技能:13 类任务图 + matrix 变体,每类拆 collect→draw→audit。
 * 目的:planner 判定 boardType 后只加载对应类型的三个阶段技能(约 3~6KB),
 * 不再把 13 类规则一次性塞进 planner 系统提示/board_upsert 描述(旧口径约 30KB)。
 * 内容与 board-contract/type-conformance.ts、board-type-profile.js 的确定性规则同源;
 * 这里是给模型的操作说明,校验仍以代码门为准。
 * 名称约定:skill_view(category="board", name="<type>/<stage>"),stage=collect|draw|audit。
 */

export const BOARD_SKILL_STAGES = ["collect", "draw", "audit"] as const;
export type BoardSkillStage = (typeof BOARD_SKILL_STAGES)[number];

export const BOARD_SKILL_TYPES = [
  "code", "test", "docs", "ui", "ui-func", "fault", "refactor", "perf",
  "data", "contract", "deploy", "research", "orchestration", "matrix", "composition",
] as const;
export type BoardSkillType = (typeof BOARD_SKILL_TYPES)[number];

export interface BoardTypeSkill {
  type: BoardSkillType;
  label: string;
  /** 判定线索:planner 在没有明确 boardType 时按这条选类。 */
  trigger: string;
  stages: Record<BoardSkillStage, string>;
}

const COMMON = "通用硬规则见 planner 规范 §硬规则(1-7);本阶段只做本阶段的事,不越界。";

/** 文档体裁库(通用机制:
 * 文档(PPT/报告)的内容需求千差万别,机制不写死任何一种——每种体裁=一组**必答维度**
 * (读者读完必须在文档里得到回答的问题)。collect 判体裁→把必答维度映射成章(对纲);
 * draw 按纲组织两层(章→页);audit/类型门按维度别名查覆盖,缺维度点名。
 * **新增一种文档类型 = 加一个条目**,判型/画板/门检/画像全链自动生效,机制代码零改动。 */
export interface DocGenreDimension {
  key: string;
  label: string;
  /** 必答问题:读者必须在这一维度得到回答的一句话。 */
  question: string;
  /** 覆盖别名:章/页 label+summary 命中任一别名 = 该维度有落点(可多章合并,不可缺席)。 */
  aliases: string[];
  /** 内容提示:这一维度的页该怎么写(描述类维度要求实读后写组件/步骤清单)。 */
  hint: string;
}
export interface DocGenre {
  key: string;
  label: string;
  /** 判定线索:planner 从任务书/读者/用途判体裁。 */
  trigger: string;
  /** 结论根定位:整份文档最终要回答的一句话(结论根按它写)。 */
  verdictHint: string;
  dimensions: DocGenreDimension[];
}

export const DOC_GENRES: Record<string, DocGenre> = {
  "review-solution": {
    key: "review-solution",
    label: "方案/设计评审",
    trigger: "评审一个系统/服务/功能的设计方案:先让读者看懂它是什么、怎么设计的,再评设计好坏",
    verdictHint: "该方案能不能过/怎么改才过(一句可判定断言)",
    dimensions: [
      { key: "positioning", label: "定位与目标", question: "这是干什么的?解决什么问题?给谁用?", aliases: ["定位", "目标", "是什么", "用途", "解决", "背景", "职责"], hint: "系统定位页:一句定位+目标用户/场景;实读 README/入口后写,不抄任务书" },
      { key: "architecture", label: "总体架构", question: "架构长什么样?分几层?有哪些组件/模块?", aliases: ["架构", "分层", "组件", "模块", "结构", "拓扑", "组成"], hint: "实读后列组件清单(≥3 个,各一句职责)——禁「详见代码」" },
      { key: "pipeline", label: "核心流程/pipeline", question: "数据/请求怎么流?处理步骤是什么?", aliases: ["流程", "pipeline", "管道", "数据流", "链路", "时序", "步骤"], hint: "pipeline 页:步骤枚举(≥3 步,用 → 串联,写真实函数/消息名);多链路就多页" },
      { key: "decisions", label: "关键设计决策", question: "为什么这么设计?有哪些取舍/替代方案?", aliases: ["决策", "取舍", "选型", "权衡", "设计考虑", "替代"], hint: "每条决策=选择+理由+代价;实读不出取舍就实读配置/注释佐证" },
      { key: "risks", label: "问题与风险", question: "设计里有什么问题/风险/缺口?", aliases: ["问题", "风险", "缺陷", "隐患", "缺口", "瓶颈"], hint: "每条风险带证据(file:line/实测)+影响面" },
      { key: "conclusion", label: "结论与建议", question: "方案过不过?怎么改?优先级是什么?", aliases: ["结论", "建议", "改进", "行动", "下一步", "优先级"], hint: "结论回扣 verdictHint;建议可执行(改什么/先做哪个)" },
    ],
  },
  "review-code": {
    key: "review-code",
    label: "代码/质量评审",
    trigger: "评审已有代码的质量:安全/健壮性/测试/耦合等维度找问题",
    verdictHint: "代码能不能合入/发布,先修什么(一句可判定断言)",
    dimensions: [
      { key: "scope", label: "评审范围与方法", question: "评了哪些代码?怎么评的?", aliases: ["范围", "方法", "对象", "样本"], hint: "模块清单+实读方式(读了哪些/怎么扫的)" },
      { key: "findings", label: "质量发现", question: "安全/健壮性/测试/耦合各有什么问题?", aliases: ["发现", "安全", "密码", "健壮", "测试", "耦合", "异常", "覆盖"], hint: "每条发现带证据 file:line+影响面;按严重度排" },
      { key: "risks", label: "风险分级", question: "问题多严重?哪些阻塞发布?", aliases: ["风险", "分级", "严重", "阻塞", "优先"], hint: "分级(阻塞/高/中/低)+每级判断依据" },
      { key: "conclusion", label: "结论与修复建议", question: "能不能合入?先修什么?", aliases: ["结论", "修复", "建议", "合入", "发布"], hint: "结论回扣 verdictHint;修复建议可执行" },
    ],
  },
  research: {
    key: "research",
    label: "调研/选型",
    trigger: "对比多个候选方案,给出选择与理由",
    verdictHint: "选哪个、为什么(一句可判定断言)",
    dimensions: [
      { key: "problem", label: "问题与约束", question: "要解决什么问题?有哪些约束?", aliases: ["问题", "约束", "需求", "背景"], hint: "问题定义+硬约束清单" },
      { key: "candidates", label: "候选方案", question: "有哪些候选?", aliases: ["候选", "方案", "选项", "备选"], hint: "每个候选一句定位+来源" },
      { key: "comparison", label: "对比与评估", question: "按什么维度比?比出来怎么样?", aliases: ["对比", "评估", "维度", "权重", "打分"], hint: "对比维度逐个说,数据/实测优先" },
      { key: "recommendation", label: "推荐与理由", question: "选哪个?为什么?放弃了什么?", aliases: ["推荐", "选择", "理由", "放弃"], hint: "推荐+理由+放弃理由" },
      { key: "risks", label: "风险与未知", question: "选型有什么风险/没验证的假设?", aliases: ["风险", "未知", "待验证", "假设"], hint: "未知显式标「未知」,禁编" },
    ],
  },
  summary: {
    key: "summary",
    label: "项目/阶段总结",
    trigger: "回顾一段工作:做了什么、结果如何、学到什么",
    verdictHint: "这段工作的整体成色与最大教训(一句可判定断言)",
    dimensions: [
      { key: "goal", label: "目标回顾", question: "当初要做什么?", aliases: ["目标", "计划", "回顾", "初衷"], hint: "原始目标逐条列" },
      { key: "results", label: "结果与数据", question: "实际做成了什么?数字是什么?", aliases: ["结果", "数据", "完成", "指标", "交付"], hint: "结果带数字/口径" },
      { key: "deviation", label: "偏差分析", question: "哪里和计划不一样?为什么?", aliases: ["偏差", "差异", "问题", "延期"], hint: "偏差+根因" },
      { key: "lessons", label: "经验教训", question: "学到什么?什么做法要沉淀/避免?", aliases: ["经验", "教训", "沉淀", "收获"], hint: "可复用的写法,不是感想" },
      { key: "next", label: "下一步", question: "接下来做什么?", aliases: ["下一步", "后续", "计划"], hint: "可执行行动+owner" },
    ],
  },
  guide: {
    key: "guide",
    label: "接入/操作指南",
    trigger: "教读者把某东西跑起来/用起来",
    verdictHint: "读者照做能不能跑通(一句可判定断言)",
    dimensions: [
      { key: "prereq", label: "前置条件", question: "跑之前要准备什么?", aliases: ["前置", "依赖", "要求", "准备", "环境"], hint: "依赖/版本/配置逐条列" },
      { key: "steps", label: "操作步骤", question: "一步一步怎么做?", aliases: ["步骤", "操作", "安装", "部署", "启动"], hint: "步骤有序号、可复制执行" },
      { key: "examples", label: "示例", question: "有没有能照抄的例子?", aliases: ["示例", "例子", "演示", "样例"], hint: "最小可运行示例" },
      { key: "faq", label: "常见问题与回滚", question: "出错了怎么办?怎么回滚?", aliases: ["常见问题", "FAQ", "回滚", "故障", "排查"], hint: "报错→原因→处置" },
    ],
  },
  generic: {
    key: "generic",
    label: "通用文档(兜底)",
    trigger: "不好归类的文档:目的→主体→结论",
    verdictHint: "读者读完应该记住/做什么(一句可判定断言)",
    dimensions: [
      { key: "purpose", label: "目的与背景", question: "为什么有这份文档?", aliases: ["目的", "背景", "为什么"], hint: "一段话说清动机" },
      { key: "body", label: "主体内容", question: "核心要讲的内容是什么?", aliases: ["现状", "主体", "内容", "方案", "架构", "流程"], hint: "按 MECE 分章" },
      { key: "conclusion", label: "结论与行动", question: "读者读完做什么?", aliases: ["结论", "行动", "建议"], hint: "结论先行+行动清单" },
    ],
  },
};

/** 体裁索引(docs/collect 注入;planner 判体裁用)。 */
export function docGenreIndex(): string {
  return Object.values(DOC_GENRES).map((g) => {
    const dims = g.dimensions.map((d) => d.label).join("/");
    return `${g.key}=${g.label}(${dims})`;
  }).join(" ; ");
}

export const BOARD_TYPE_SKILLS: Record<BoardSkillType, BoardTypeSkill> = {
  code: {
    type: "code",
    label: "代码开发",
    trigger: "功能/修复/排障修复/接口实现等要改代码的变更",
    stages: {
      collect: `${COMMON}
# code · collect(先查清再画)
- **主形态=控制流程图(flow)**:code 板默认画 flow(start/decision/end),读者要能顺着 start→步骤→decision 是/否→end 读懂代码怎么走、动的是仓库里哪段现有逻辑。C4 分层(architecture)与 dataflow 只在用户**明确要求「架构全景」**时用,不是 collect 首选项,更不要画成一张模块卡片清单。
- **先查清现有链路再画,不要凭想象编步骤**:用 code_sense action=flow(level=function/file,拿控制流骨架与分组)与 code_sense action=branches(target=文件,拿 if/elif/else 条件、循环、每个分支直接调用的函数——回答「这个调用在什么条件下发生」)拉**真实控制流与决策点**作素材;code_sense action=symbol 拿入口函数与上下游 caller/callee。素材里没有的步骤,不许画。
- 用 code_sense 查目标符号(name/file/line/anchor、上游 callers、下游 callees)与双向影响面/关联测试。
- **画流程前先查现有代码的落点(决定 keep 还是 modify 的硬前提)**:code_sense action=symbol(定义+调用者+被调者)与 action=impact(双向调用闭包+受影响文件+关联测试)——列出①现有调用方②现有被调方③可复用点(该功能是否已有函数,复用它就标 keep,不要新写 add)。把这些写进步骤节点的 targets 与 summary。
- 现状层每个节点写清:目标文件/符号、所属业务链路、上游 caller、下游 callee、数据/事件格式。
- C4 要素(仅在用户明确要求「架构全景」时收集):Person(用户/外部角色)、System(外部系统)、Container(进程/服务/网关)、Component(函数/模块)、Store(DB/文件/缓存);summary 用「[Component: TypeScript] 职责」形式,边 label 用「动作 [协议/数据]」(如「安装插件 [WS/JSON]」「读取候选 [JSON]」)。
- 每个 modify/delete 收集 before(原行为或原代码锚点);新增能力写 add 理由;**若该功能已有函数,必须标 keep 并写出复用哪个函数,不许标 add 重复造**;新能力无上游显式标「入口/新增」。默认 flow 骨架必须含 start+end+≥1 decision,规模 M/L 主线 8~12 节点(最多 14)。
- 收集每个步骤的 flow 素材(默认形态必须填):关键步骤、if/else 的 cond、每支输出、写入/广播目标;抽象动词不算素材。
- **flow 形态先按方法/阶段分组**:每组是一个真实方法或阶段(如「01 installPlugin()」/「02 registerPluginAssets()」),收集组内 2~5 个代码级动作(函数名+参数+写入/广播/返回),组间调用关系记成边。不要全板只用一个 group。
- flow 行必须能直接写成代码动作:如「copyAssets(pluginDir, distDir)」「if (skillAssets.length === 0) return」;不要写「优化逻辑」「处理数据」这类叙述。
- 找到主入口(触发事件)和主出口(用户可见结果);每个分支出口单独一个 end(如「保持旧两组」),不要把所有结果并成一个 end。
- 记录关联测试文件与可执行命令(单元/UI/回归)。
- **节点只收「现有代码里真实存在的一步」**(入口函数/分支/循环体/出口);「写测试」「跑验证」「更新文档」「实现 X」「修复 Y」这类仓库里并不存在的动作**不进板**,留在 step.md。
- panel.ts 等内联 script:code_sense 不索引内联函数,用 code_sense 的字面量引用面 + read_file 取证;symbolRef 用真实 owner(如 PAGE)或真实 JS 函数名 + 精确 anchor,禁编造带空格/括号的符号名。
- rename/纯重构与功能变更分开收集,不混进同一张板。
- **逐分支穷举(硬要求)**:主画函数用 code_sense action=branches 拿到**全部** \`if/else if/switch/while/for\` 与**每一个 \`return\`**;逐个列出所有 **early-return(提前返回)** 分支及条件(如「\`lastRead.get(key)===rev && !scan.compacted\` → \`n>=2\` 直接返回命中缓存」「\`n>=3\` 返回『已连续 N 次重读』全文兜底」)。素材清单里没列出的分支,draw 阶段不可能画出来——最复杂的 dedup/计数/兜底分支往往就丢在这一步,不是丢在画的时候。`,
      draw: `${COMMON}
# code · draw
- **板首主题节点(必须先画)**:id 以 theme 开头(如 theme-1,或 group=主题),一句话断言「这流程在系统里干什么用 + 本次改哪一环」,不写步骤。只有一串步骤卡、读者看完不知道这流程干什么用的板判不合格;主题节点是现状描述(change=keep),不受「keep 必须带结构化锚」约束(它不指向具体代码段)。
- **主形态=现状控制流程图(flow,默认)**:start(触发)→步骤→decision 是/否→end(结果),读者要能顺着读**现有代码现在怎么走**、哪一步本轮要动。节点=现有代码里真实存在的步骤;change=keep 是**默认值**(纯读不改,绝大多数节点),要改的节点才打 modify(+before 一行现状)/add/delete——**改动是节点上的徽标,不是节点**;不新增「计划步骤」节点。C4(architecture)与 dataflow 只在用户**明确要求「架构全景」**时用;C4 图例仍随主图自动生成,但不再是默认形态。
- **每步必须挂「与仓库现有代码的关系」(硬要求,缺一条即重画)**:步骤节点 targets 写「仓库相对路径#符号名」(如 packages/gateway/src/x.ts#createServer;或 targets 路径 + symbolRef{file,name});change 必填——keep=复用现有函数不改(卡内写明复用哪个函数)/modify=改已有(modify/delete 必填 before)/add=新增/delete=删。summary 要读出「这在仓库里是哪一段现有逻辑」(如「改 createServer 里读 timeout 的那行」),不写「优化逻辑」这类抽象动词。
- 节点 kind 映射:步骤用 function/module,分支用 decision,流程起终点用 start/end(flow 形态必用),存储/DB/文件用 io,外部系统用 tool/http;summary 必须「[类型: 技术] 职责」(如「[Component: TypeScript] 斜杠候选过滤」)。
- **可读性硬约束(示例图标准)**:主图只画「主线步骤 + 决策分叉 + 结果出口」,目标 8~12 个主节点、≤14 条主边;超过就把次要细节收进 group 或拆图,不要把 16+ 节点和 30+ 边糊在一张图里。
- **验收/风险/测试/回滚/根因/非锚点现状细节不进主图**:节点 group/label 含「根因/验收/风险/测试/回归/回滚」;面板会把它们和非锚点现状节点剥离到右侧栏,主图只留变更与直接锚点。主图不要给这些节点画 verify 边(会变成噪声)。
- 节点 summary ≤60 字,边 label ≤24 字;长代码行号/证据放 accept/evidence 或 cell 明细,不放进主图卡片。
- group 用方法/阶段命名(如「01 board_upsert()」「02 校验 gate」),不要写「现状层/变更层」:flow 板按方法边界分组,变更类型由每个节点的 change 表达,不靠泳道表达。
- 变更节点 label 带 01→02→…;change=add/modify/delete/keep;modify/delete 必填 before。
- 每个变更节点回答四件事:targets+symbolRef、上游→本节点→下游、change+before、内部 flow。
- 节点 kind 映射:C4 组件/函数用 function/module,外部系统用 tool/http,人员/入口用 agent,存储/DB/文件用 io,分支用 decision,流程起终点用 start/end(flow 形态才用)。summary 必须「[类型: 技术] 职责」(如「[Component: TypeScript] 斜杠候选过滤」)。
- **flow 形态(主形态,示例图标准)**:start(触发)→编号步骤(function/module)→decision(cond+then/else)→end(结果)。硬要求:
  - **一条主线**:start→步骤→decision→主 end 必须是一条前向链,主线节点同一条基线;分支只从 decision 出,不要每个步骤都分叉。
  - **group=方法/阶段容器**:如「01 installPlugin()」「02 registerAssets()」「03 slashCandidates()」;每组 2~5 个节点,组与组之间用 call/data 边连接。全板一个 group = 没有方法边界,不算合格。
  - **每个步骤节点 flow 写 2~4 行代码级动作**(函数名+参数+条件+写入/广播);面板直接把 flow 渲染成节点里的代码框(最多 4 行、每行 58 字)。没有 flow 的步骤卡只能显示 summary,读不出代码逻辑。
  - **decision(每个判断都必须 Y/N 完整)**:flow 写「{type:"branch",cond,then:[{type:"step",text}],else:[...]}」;出边必须恰好一对「是：…」「否：…」,**每条分支边都要有 label**;两支都要落到主流程节点/end 或明确汇合点,不能悬空,**不能落到会被面板剥离到侧栏的影响面/验收/风险 note**(否则渲染后该分支直接消失)。
  - **逐分支穷举/每个 early-return 都有出口(硬要求)**:函数体里每一条 early-return 必须在板上有一条**出口边或 decision 分支**;若某条件没画,该分支上的行为(含兜底文案/计数/降级)就永远不上板。**自检算式:主要 \`return\` 数 ≤ 板上出口边数,否则漏画**——把数出来的 return 逐个点名对上某条出口边,对不上就补 decision,不要靠一句 summary 概括(如「dedup 渲染板文本」等于没画)。
  - **start 只写触发**:start 节点只写**触发**——谁在什么条件下调用它(如「board_read 被 tool loop 调用」「board_upsert 收到 action=audit」)。函数体的收参/初始化/定 root/异常捕获/动态 import **下沉**到第一个步骤节点或独立 decision;**不要把这些塞进 start**(把四件事合成一张 start 卡,读者读不出「进 execute 第一件事是什么」)。
  - **flow 行号必须现取(硬要求)**:flow 行里出现的 \`:NNNN\` 行号**写之前必须当场 \`grep -n '<该行代码片段>' <file>\` 取**,禁止凭记忆或凭上一轮勘察的值;取不到就不写行号,只写函数名。
  - 主线边 label 写事件/数据(如「git.ok [WS]」「候选 4 组 [JSON]」),分支边写「是/否」;不要写「下一步」。
  - **主图 8~12 个节点**:影响面/验收/风险/回滚不放进主线;放独立 group(「03 影响面」/「04 验收」/「05 风险」),面板会剥离到右侧栏。
  - 正交连线(横平竖直)由面板自动生成;不要手写 pos,节点声明顺序就是主线顺序。
  - 反模式(出现即重画):**模块清单式**(全 function 卡 + call 边,无 start/decision);6 个步骤一条直线却没有 decision(没画逻辑);**步骤 targets 指向不存在的路径**;**复用已有函数却标 add**;**节点是 agent 的待办而非代码里存在的东西**(「写测试」「跑验证」「实现 X」「修复 Y」);**用「实现/修复/添加/重构」当 label**(抽象动词,应写现有函数名与它在做什么);**flow 行不是真实函数调用形**(写「处理数据」「优化逻辑」或「我会去做…」);全板一个 group;decision 出边无「是/否」;分支没有 end;把验收/风险塞进主线;节点 16+。
- **与仓库现有代码的关系必须在卡上可读**:每个步骤节点 targets=「仓库相对路径#符号名」,change 标明 keep/modify/add/delete;summary 读出「改的是哪个函数里的哪一段」,读者不看代码也知道动的是现有逻辑还是新写。
- 边 label 必须「动作 [协议/数据]」(如「安装插件 [WS/JSON]」「读取命令 [文件]」);call 实线、data 虚线、verify 点线;decision 出边写「是/否」。
- flow 用 step.text + branch(cond/then/else);then/else 子项必须是 {type:"step",text} 对象。
- 影响面:每个变更节点至少一条非变更入边(上游 caller);每条变更链至少一条 verify 到 acceptance 或带 tests:path:line 的边。
- 目标函数 flow 展开关键步骤与 if/else;rename/纯重构单独板。
- 边只允许 call/data/verify;禁 nav/contains/同组次序;无孤儿。
- P0 accept 用 command/browser/manual/negative,每条带 expect;至少 1 条 negative;多模块/迁移用 scale=L。面板会自动出 C4 图例(类型/技术/关系线型)。`,
      audit: `${COMMON}
# code · audit(交板前逐条)
- **主题节点**:板首主题节点在不在(id 以 theme 开头或 group=主题,一句话讲清「这流程干什么用 + 本次改哪一环」)?缺=不合格。
- **keep 节点锚是否挂对地方**:锚必须挂在 targets/symbolRef 上——写进 summary 的 file:line 不算(画布上渲染不出来,读者看不见)。主题节点(theme-*/group=主题)豁免这一条。
- **可读性**:主架构图(排除验收/风险/测试/回滚)≤12 个节点、≤16 条边;节点 summary ≤60 字、边 label ≤24 字;超了先删细节/拆图,不要交一张糊图。
- **验收/风险分离**:验收/风险/测试/回滚节点必须放对应 group;主图与它们之间不要画大量 verify 边(面板右侧栏展示)。
- **flow 可读性(逐条)**:①主线是否一条前向链(start→…→主 end),有没有断点/回头线;②每个步骤 flow 是否 ≥2 行代码级动作,有没有「优化/处理/校验」空话;③group 是否是方法/阶段且每组 2~5 节点,有没有全板一个 group;④**每个 decision 是否恰好一对「是：…」「否：…」、每条出边都有 label、两支都落主流程节点/end(不落侧栏 note)**;⑤主图是否 ≤12 节点、验收/风险是否已移出主线。
- **节点级落目标(逐条)**:①每个步骤节点 targets 非空且是**已存在的仓库相对路径**(如 packages/apps/src/x.ts,可带 #符号名),指向不存在路径=不合格;②每个步骤节点 change 必填四值之一(keep/modify/add/delete);③**复用已有函数却标 add=不合格**(collect 阶段用 code_sense symbol/impact 查过现有调用方/被调用方/可复用点,已有就直接 keep 并写明函数名)。
- **形态判定**:板里没有 start+end+至少一个 decision = 模块清单式,不合格,必须重画成 flow(不是补几张卡能救)。
- **行号抽查(必做,抽查 3 条)**:抽查 3 条带行号的 flow 行,用 \`grep -n\` 核对;任一不符 → **重画**(不是就地改:行号漂移说明整段没核对过,别处行号同样可疑)。
- **分支反向核对(逐函数)**:每个 \`return\` 语句都能在板上找到对应出口;\`grep -c 'return ' <函数范围>\` 与板上出口边数比对,板上出口少 = 漏画 early-return 分支(重画,不要只补一句 summary)。最关键的是 dedup/计数/兜底这类最复杂分支必须各自成 decision。
- **start 只写触发(反向查)**:start 卡里若出现收参/初始化/定 root/异常捕获/动态 import 等函数体动作 = 不合格,下沉到第一个步骤节点或独立 decision。
- **现状真实性(逐节点问一遍)**:这一步骤**现在真的在仓库代码里存在吗**?(能在 targets 指向的文件里读到对应函数/分支/循环)——不存在就是计划,删掉或改写成代码动作;整块板读下来应该是「现有代码怎么走 + 哪几步要改」,不是「agent 打算做什么」。
- **改动只作徽标**:keep 节点占绝大多数且免 accept;只有 modify/add/delete 节点需要 targets+before(+P0 的 accept)。出现「为待办单开的节点」= 不合格。
- 每个现状/变更节点有 symbolRef 且 linked(anchor 与 line 实读一致),targets 全非空。
- 每个 modify/delete 有 before;每个变更节点有非变更入边;每条变更链到 acc-* verify 终点。
- c01-c04 类目标函数有 flow,且 branch 有 cond/then/else、子项是 step 对象。
- 关联测试文件已落边(label 含 tests:path:line 或 acceptance.targets);无 nav/布局边;无孤儿。
- 跑 board_upsert action=audit format=json;contractIssues 与 typeIssues 必须为空。
- 纯规划态 P0 0/N 正常;evidence 未回填不得把 status 置 done。`,
    },
  },
  test: {
    type: "test",
    label: "测试",
    trigger: "测试设计/用例/回归/缺陷复现等测试流程",
    stages: {
      collect: `${COMMON}
# test · collect(测试任务画纯 code flow,boardType=code;不画用例卡)
- 用 code_sense 查被测符号:入口函数、上游 caller、下游 callee;测试文件与可执行命令。
- 收集被测链路的真实代码动作:夹具/setup(造什么数据、装什么插件,含边界输入)、触发操作(调哪个函数/发哪条消息)、断言点(expect 的可判定文本)。
- 收集失败路径:非法输入/异常分支的 expect 与排查顺序;收集回归锚(既有测试文件+可执行命令)。
- 不收集「用例卡」:测了什么、怎么测全在主线步骤里,一层 flow 讲完。`,
      draw: `${COMMON}
# test · draw(纯 code flow,与 code/draw 的 flow 形态同一套规则;boardType=code)
- **主线=测试执行流**:start(运行 spec/触发)→ 夹具步骤(代码)→ 被测操作步骤(代码)→ 断言 decision(expect 作 cond)→ 通过 end / 失败定位 end。读者顺着主线就能看到「测了什么、怎么测、怎么判」。
- **被测链路必须逐函数展开(硬要求)**:每张卡=链路上的**一个**真实函数/handler(如 handleMessage case → PluginSystem.install 校验 → install 落盘 → 面板 git.ok 分支 → mergedCommandList → CommandStore.listWithDiagnostics → renderCmds → slashUpdate → slashFilter),flow 行写该函数内的真实代码动作(含条件判断);**禁止把 3 个以上函数合并成一张「被测链路」卡**——那等于没画,读者看不出测了哪些 code flow。函数名/文件用 code_sense 查实,卡数按链路实际函数数走,宁多勿糊。
- group=方法/阶段容器,按「层」分(如「01 夹具」「02 server: plugins.install」「03 装后刷新」「05 面板消费 slashFilter」「06 断言」),每组 2~5 个节点;被测函数决策密集处照 code/draw 展开 decision+是/否。
- 每个步骤 flow 写 2~4 行代码级动作;**断言相关步骤的 flow 行必须写 expect 原文**(如 expect(menu).toContain('hi')),失败定位步骤写排查顺序(先看哪个回包/再查哪个函数)。
- 测试数据三态(正常/边界/异常)融进主线:夹具卡写正常输入,decision 的否支/失败定位写边界与异常 expect;不单独成组、不画用例卡清单。
- decision 出边「是：…」「否：…」,每条有 label,两支都落 end/主流程,不落侧栏 note。
- 影响面/回归锚放侧栏 group(「04 影响面」「05 回归锚」),回归锚带可执行命令;verify 边连被测段。
- P0 accept 用 command(跑测试命令)+negative(失败路径),每条带 expect。
- 反模式(出现即重画):把测试画成用例卡片清单/映射层;六段流程图(数据→执行→被测→判定→断言→回归两张皮);decision 无是/否;断言不写 expect;节点 16+。`,
      audit: `${COMMON}
# test · audit(交板前逐条)
- 复用 code/audit 的 flow 可读性五条:主线前向链/步骤 ≥2 行代码级动作/group 方法化/decision 是否完整。
- **被测链路展开度**:数一数主线覆盖了几个真实函数——每张卡应对应一个函数/handler;发现「一张卡 summary 里塞了 3+ 个函数名」= 没展开,拆卡。
- 测试特有:①断言 decision 的 cond 是可判定 expect 文本,禁「验证正确」;②关键被测段至少一条步骤 flow 含 expect 原文;③至少一条 negative(异常/失败路径)在 accept 或失败分支;④回归锚在侧栏且带可执行命令;⑤**无用例卡层**(出现即合并回主线)。
- 跑 board_upsert action=audit format=json;contractIssues 与 typeIssues 必须为空。`,
    },
  },
  docs: {
    type: "docs",
    label: "文档/PPT",
    trigger: "文档、报告、PPT、说明、方案等非代码产出",
    stages: {
      collect: `${COMMON}
# docs · collect(三步:判体裁→对纲→两层规划)
- **第一步 判体裁(强制)**:从任务书/读者/用途判定文档体裁(docGenre),对不上就选 generic。体裁=必答维度集,决定大骨架必须覆盖什么:
  ${docGenreIndex()}
- **第二步 对纲(体裁的每个必答维度都要有落点)**:把体裁的必答维度逐个映射成章(或明确并入哪章)——一个维度都不能缺席;读者读完必须能回答每个维度的必答问题。描述类维度(定位/架构/流程/pipeline)必须实读后用自己的话写出**组件清单(≥3 个,各一句职责)或步骤清单(≥3 步,用 → 串联,写真实函数/消息名)**,禁「详见代码」;评审/风险类维度每条带证据 file:line。
- **第三步 两层规划**:结论根(按体裁 verdictHint 写,一句可判定断言)→ 大骨架(章=断言标题,4~8 章)→ 逐章丰富(每章 1~6 页,一页一论点,页 summary=要点+证据)。证据多就多拆页,不要一页塞 5 个论点。
- 目标文件/输出格式;证据来源文件清单(页 targets 用)。`,
      draw: `${COMMON}
# docs · draw(PPT=两层:章(section)→页(page);体裁对纲)
- **落板带 docGenre**:board_upsert 传 docGenre=<collect 判定的体裁 key>(类型门按它查维度覆盖;缺省=不查,但缺维度是硬伤)。
- **第一层大骨架**:结论根(kind=aggregate,label=体裁 verdictHint 的回答,总评断言句)+ 章节(kind=section,label=章断言句,带序号 01/02/…,章 summary 标注「回答维度:<维度 label>」);章之间 data 边按汇报顺序推进;结论根被 data 边指向(结论先行)。
- **第二层分页丰富**:每章页 kind=page(页标题=断言句),**页与章用 contains 边**表达归属;页 summary=该页要点+证据(file:line/数据)。描述类维度(定位/架构/流程)的页必须写组件/步骤清单(≥3 项,pipeline 用 → 串联),禁一句话带过。
- **体裁覆盖自查(逐维度)**:对照体裁必答维度,每个维度至少一个章/页落点且真的回答了必答问题——「架构章只写了『分层清晰』却没列组件」= 没回答;「流程页没写步骤」= 没回答。
- 文档板不画代码级节点(function/tool/http/llm);代码事实放页 summary/证据;页 targets 写证据来源文件。每章标 Diátaxis(explanation 为主)。
- 反模式:质量发现代替方案描述(方案评审里没有架构/流程页=没回答「这是干什么的」);章节清单不分页;空词标题(概述/背景/分析)。`,
      audit: `${COMMON}
# docs · audit
- **体裁覆盖(逐维度)**:对照 docGenre 的必答维度,每个维度有章/页落点且回答了必答问题(架构有组件清单、pipeline 有步骤枚举、风险有证据);缺维度=回炉。
- **两层齐全**:唯一结论根(data 指向);章 ≥3 且每章 ≥1 个 page(contains);页总数 ≥ 章数;页标题断言句。
- 无代码级节点;章间 data 链连通;每章 Diátaxis 已标。
- 跑 board_upsert action=audit(format=json);contractIssues 与 typeIssues 为空。`,
    },
  },
  ui: {
    type: "ui",
    label: "纯 UI",
    trigger: "只画页面/交互/控件布局,不含业务代码逻辑",
    stages: {
      collect: `${COMMON}
# ui · collect
- 设备形态:APP/小程序/网页/桌面;屏幕列表与每屏职责。
- 布局区域:顶部导航/菜单栏/工具栏/侧栏/主区/页脚/底部操作条/弹窗/抽屉/下拉。
- 控件:按钮类型(primary/secondary/danger/text/icon/toggle/input/select/tab/card/FAB)、放置位置、触发结果。
- 浮层:弹窗/底部抽屉/右侧抽屉/下拉菜单的形态、内部控件、打开/关闭方式。
- 五态:空/加载/错误/禁用/只读,分别是否出现在哪屏/哪个控件。
- 多屏导航:每屏至少一条跨屏 nav 进出;跨屏箭头落目标页大框或浮层边框。
- 纯 UI 不收集代码 targets/symbolRef/业务逻辑。`,
      draw: `${COMMON}
# ui · draw
- docKind=page;节点 kind=page/section/component/nav;设备/布局区域/控件类型写进 label/summary;page.summary 写一屏职责,设备写进标题/summary。
- **禁止用 n1→n2→n3 流程链代替页面结构**:UI 页面必须 page/section/component 分层;默认结果态只画结果卡,添加/编辑过程收进弹窗/抽屉组件;五态单独成节点。
- 跨屏跳转:触发控件→目标 page 大框,label「跳转：X」;弹窗/抽屉/下拉→独立浮层节点,label「弹出：X」,箭头落浮层边框;浮层位置写居中/贴边/下拉贴触发。
- 浮层内部控件用 contains;确认/取消再连后续页或关闭。
- 常驻 tab 用 nav 节点→page(移动端屏底 tab,网页/桌面浏览器顶栏 tab);主路径屏标「主线」;每屏可达,无孤屏。
- 五态单独成节点;纯 UI 禁 targets/symbolRef/逻辑节点。
- 边用 nav/contains(纯 UI),不要画 call/data 业务边。`,
      audit: `${COMMON}
# ui · audit
- docKind=page;page/section/component 分层;设备/布局区域/控件类型可见。
- 每个跨屏触发控件有 nav;浮层独立节点且 contains 内部控件;跳页箭头落 page 大框。
- 五态齐全;每屏至少一条 nav 进出;纯 UI 无代码 targets/symbolRef。
- 跑 board_upsert action=audit;typeIssues 为空。`,
    },
  },
  "ui-func": {
    type: "ui-func",
    label: "UI+功能",
    trigger: "页面/控件交互要落到真实业务逻辑/接口/数据",
    stages: {
      collect: `${COMMON}
# ui-func · collect
- 先按 ui 收集页面/控件/浮层/五态。
- 每个交互控件找出逻辑入口(handler/route/调用点)与上下游 call/data。
- 收集逻辑节点的 symbolRef/callers/callees、数据格式、错误分支。
- 收集 UI 状态回连:成功/失败/空/加载/禁用/只读各自回哪屏哪个控件。
- 收集关联测试(UI e2e + 逻辑单测)。`,
      draw: `${COMMON}
# ui-func · draw
- 在纯 UI 的布局/控件/设备/元素锚点基础上,同一张板加逻辑层;每个交互控件 nav 到逻辑节点(逐控件≥1 出边)。
- 逻辑节点之间 call/data,编号 01→02;链终止于 data 节点或回连 UI 状态。
- 错误分支回连 UI 状态;UI/逻辑双向可达;边类型匹配(UI→逻辑 nav,逻辑→逻辑 call/data)。
- 五态保留;不许 UI 与逻辑两张皮。
- 逻辑节点必须有 symbolRef/targets;P0 accept 覆盖端到端旅程。`,
      audit: `${COMMON}
# ui-func · audit
- 每个交互控件有 nav 到逻辑;逻辑链终止于 data/回连 UI;错误分支回 UI。
- UI 与逻辑双向可达,边类型正确;五态在列;无两张皮。
- 逻辑节点 symbolRef linked/targets 非空;跑 board_upsert action=audit;typeIssues 为空。`,
    },
  },
  fault: {
    type: "fault",
    label: "排障",
    trigger: "线上/本地故障、报错、性能异常等根因排查",
    stages: {
      collect: `${COMMON}
# fault · collect
- 复现条件:环境/版本/输入/频率;最小可靠复现。
- 观测异常:日志原文/指标/trace/截图/file:line,不是转述。
- 候选假设 ≥2,每个可证伪;排除假设留依据。
- 根因证据:file:line/日志/实测,写死具体根因,禁「预期/待定/写结论」占位。
- 修复点:change + targets;防复发:可执行动作 + owner。
- accept:negative(复现不再出现/错误分支)+ command(回归)。`,
      draw: `${COMMON}
# fault · draw
- 六段:01 复现条件→02 观测异常→03 候选假设≥2→04 根因→05 修复→06 防复发(owner)。
- 链节点用 change=keep/note,不标 modify(避免被要求 before)。
- 根因节点必须有证据入边(label 写 file:line/日志/实测);排除假设留依据。
- 修复点与根因分开;防复发有可执行动作+owner。
- accept 至少 1 条 negative 与 1 条 command。`,
      audit: `${COMMON}
# fault · audit
- 六段齐全;假设≥2;根因有证据入边且不是占位;排除依据/owner 在列。
- 修复点与根因分开;accept 有 negative+command。
- 跑 board_upsert action=audit;typeIssues 为空。`,
    },
  },
  refactor: {
    type: "refactor",
    label: "重构/迁移",
    trigger: "重构、迁移、替换、纯结构调整(行为不变或受控变更)",
    stages: {
      collect: `${COMMON}
# refactor · collect
- 现状结构/目标结构;1:1/N:1 映射关系(无映射标「纯新增」)。
- 三步:expand(新旧并存)→migrate(逐消费方)→contract(零读取后删旧)。
- 兼容窗口:起止/触发条件;过渡构件标「迁完删除」。
- 回滚触发条件与验证;基线测试/回归命令。
- 现状/目标双泳道各自符号与调用关系。`,
      draw: `${COMMON}
# refactor · draw
- group 必须含「现状」「目标」两条泳道;映射边 1:1/N:1;纯新增显式标。
- 三步独立编号(01 expand→02 migrate→03 contract);兼容窗口独立节点;过渡件标迁完删除。
- 回滚节点/触发条件;禁 big bang、禁只画目标层。
- 每步有 verify/回归测试锚点;P0 accept command+negative。`,
      audit: `${COMMON}
# refactor · audit
- 双泳道在;映射或纯新增标注;三步编号;兼容窗口;过渡件删除说明;回滚触发。
- 无 big bang;测试回归锚在;跑 board_upsert action=audit;typeIssues 为空。`,
    },
  },
  perf: {
    type: "perf",
    label: "性能",
    trigger: "性能优化、基线、瓶颈、容量、延迟/吞吐",
    stages: {
      collect: `${COMMON}
# perf · collect(先量准再画;主形态=控制流程图,不是模块卡清单)
- **主形态=控制流程图(flow,硬要求)**:perf 板默认画 flow,骨架必须是
  \`start(触发:某操作变慢/某指标超阈 → 用户可见现象) → 采样与基线 → 定位瓶颈 → 改动 → 复测 → decision(达到目标?) → end\`。
  读者要能顺着 start→步骤→decision 是/否→end 读懂「谁变慢了→怎么量到的→慢在哪一行→改了什么→复测是否达标」。三张并列模块卡(基线卡/瓶颈卡/改动卡)不是 perf 板,是目录清单。
- 用 code_sense 查瓶颈落点的现有符号(name/file/line、上游 callers、下游 callees)与影响面/关联测试:profiling 只能告诉你热函数名,落点还要查实现。
- **start 的触发条件必须可判定**:谁变慢/哪个指标超阈/用户看到什么现象(如「board_upsert 落盘 P95 从 120ms 涨到 850ms,画布保存转圈 3s」),禁「需要性能优化」。
- **采样与基线**:环境(机器/核数/Node 版本)、数据量(板数/节点数/并发)、采样方式(warmup 次数/样本数/取分位的方法)、**数字+单位+百分位(P50/P95/P99)**。基线是这条流程的第一段实测,不是一句口号。
- **定位瓶颈**:profiling/火焰图/USE/慢查询 trace/bench 对比;必须给到 file:line 或函数名(如「profiler 热点 62% 在 \`readBoardState()\` apps/gateway/src/x.ts:142」),只说「全量扫描」不算证据。
- **改动**:改哪段现有代码(仓库相对路径#符号名)、keep/modify/add;写出改动与指标之间的因果假设(改这个判定为什么会少扫 N 倍)。
- **复测**:同环境同口径再测一遍,写清复测命令与口径参数;复测点不是「应该会更快」,是又一组数字。
- **目标/阈值**:数字+单位+百分位;验收阈值 ≤ 目标(目标 P95 ≤ 300ms,验收阈值就不能是 P95 ≤ 400ms);同环境同口径。
- **decision(达到目标?)**:出边恰好一对「是：达标」/「否：未达标」;「否」回到改动或定位瓶颈(允许回边,表达再优化一轮),「是」到 end——decision 不是装饰,是这一回合的判定点。
- 每个步骤的 flow 素材:关键函数名+参数+条件(如「readBoardState(ws)」「if (cache.has(id)) return cache.get(id)」)——抽象动词(优化/处理/加速)不算素材。
- **group 用阶段名**:如「01 采样与基线」「02 定位瓶颈」「03 改动」「04 复测」「05 验收」,每组 2~5 个节点;全板一个 group 不合格。
- 收集 CI/监控门禁(阈值固化到 bench 门禁/监控告警);可执行 benchmark 命令与其命令行 expect(含数字阈值)。
- 反模式(出现即重画):3 张并列模块卡(基线/瓶颈/改动)、0 条边、没有 decision、没有 start/end、数字没单位/没百分位、把验收塞进主线。`,
      draw: `${COMMON}
# perf · draw(主形态=控制流程图,与 code/draw 同体例,保留 perf 特有硬要求)
- **一条主线**:start(触发)→ 采样与基线 → 定位瓶颈(证据)→ 改动 → 复测 → decision(达到目标?)→ end(达标上线)/否支回改动或定位。读者顺着主线能读完一个完整的优化回合。
- **节点 kind 映射**:步骤用 function/module,判断用 decision,起终点用 start/end(必用),存储/文件/DB 用 io,采测工具用 tool。summary 写「[类型: 技术] 职责」(如「[Component: Node] 采样与基线」)。
- **group=阶段容器**:如「01 采样与基线」「02 定位瓶颈」「03 改动」「04 复测」,每组 2~5 个节点,组间用 call/data 边连接。全板一个 group = 没有阶段边界,不合格。
- **每个步骤节点 flow 写 2~4 行代码级动作**(函数名+参数+条件):面板把 flow 渲染成卡内代码框;没有 flow 的步骤卡只显示摘要,读不出改的是哪段代码。禁「优化逻辑」「处理数据」这类叙述。
- **步骤节点必须挂仓库落点**:targets 写被改/被查的仓库相对路径(可带 #符号名),change 必填 keep(复用现有函数,写明复用哪个)/modify(改已有,必填 before)/add(新增);瓶颈定位卡 targets 写热点的文件#符号。
- **decision(达到目标?)出边必须恰好一对「是：…」「否：…」**:每条分支边都要有 label;「是：达标(≤P95 300ms)」落 end,「否：未达标」**必须回到「改动」或「定位瓶颈」节点(允许回边,表达再优化一轮)**,不许悬空、不许落会被面板剥离到侧栏的验收/风险 note。
- 基线/目标/阈值都带**数字+单位+百分位**(如「P95 850ms → 300ms」);只给百分比或「快了一倍」不算口径(P50/P95/P99 三档里选清用哪档);基线/复测/验收同口径同环境,**验收阈值 ≤ 目标**。
- 改动→指标用 verify 边显式连;CI/监控门禁节点(阈值固化到门禁,否则收益随提交流失)放侧栏 group(「05 验收」),不塞进主线。
- **主图 ≤12 个节点**:调研记录、影响面、风险、回滚细节放侧栏 group;节点声明顺序就是主线顺序,不手写 pos。
- P0 accept:至少 1 条 command(bench 命令)且 expect 含数字阈值;至少 1 条 negative(回退/超阈/过载不 OOM);复测命令写进 command 的 cmd。
- 反模式(出现即重画):**3 张并列模块卡(基线/瓶颈/改动)**、**0 条边**、**没有 decision**、**没有 start/end**、数字没单位/没百分位、把验收塞进主线、decision 无是/否、否支悬空、全板一个 group。`,
      audit: `${COMMON}
# perf · audit(交板前逐条)
- **形态判定(先判这个)**:板里有没有 start + end + 至少一个 decision?没有 = 模块清单式,不合格,**必须重画成流程**(不是补几张卡能救)。
- **flow 可读性五条**:①主线是否一条前向链(start→采样与基线→定位瓶颈→改动→复测→decision→end),有没有断点;②每个步骤 flow 是否 ≥2 行代码级动作(函数名+参数+条件),有没有「优化/处理/加速」空话;③group 是否阶段化且每组 2~5 节点,有没有全板一个 group;④decision(达到目标?)是否恰好一对「是：…」「否：…」、每条出边有 label、否支回到改动/定位(回边合法)不悬空;⑤主图是否 ≤12 节点、验收/风险是否已移出主线。
- **perf 特有数字口径**:基线/目标/复测都是「数字+单位+百分位(P50/P95/P99)」;只给百分比或「快了很多」判不出慢尾,不算合格;验收阈值 ≤ 目标;基线、复测、验收同环境同口径;瓶颈有 profiling/火焰图/trace 证据(file:line 或函数名)。
- **节点级落点**:每个步骤 targets 非空且是已存在的仓库相对路径,change 四值必填;瓶颈定位卡指向真实热点文件#符号;modify 有 before。
- **验收/门禁**:改动→指标有 verify 边;CI/监控门禁节点在(阈值固化);accept 至少 1 条 command 且 expect 含数字阈值;至少 1 条 negative(回退/超阈)。
- **反模式清单(出现即重画)**:①3 张并列模块卡(基线/瓶颈/改动);②0 条边;③没有 decision;④没有 start/end;⑤数字没单位/没百分位;⑥把验收塞进主线。命中任意一条就回 draw 重画,不要只补字段。
- 跑 board_upsert action=audit format=json;contractIssues 与 typeIssues 必须为空。`,
    },
  },
  data: {
    type: "data",
    label: "数据/批处理",
    trigger: "数据管道、批处理、脚本、ETL、导入导出",
    stages: {
      collect: `${COMMON}
# data · collect
- 输入/清洗转换/输出;字段与数据格式。
- 幂等策略三选一:分区 overwrite / delete-insert / upsert;禁裸 append。
- dry-run/样本量 N;质量断言(unique/not_null/accepted_values/引用完整性/新鲜度)。
- 脏数据隔离 quarantine/DLQ + triage;部分失败/重跑/backfill 入口。
- 验收命令与负面场景(重复跑/脏数据/部分失败)。`,
      draw: `${COMMON}
# data · draw
- 输入→清洗/转换→输出 data 流;质量断言在输出之前。
- 幂等策略节点;dry-run+样本量;quarantine/DLQ+triage;部分失败/重跑/backfill 入口。
- 输出前后关系用 data 边;每条链有 verify 终点。
- accept command(含样本量/幂等)+ negative(脏数据/重复跑/部分失败)。`,
      audit: `${COMMON}
# data · audit
- 幂等三选一;dry-run/样本量;质量断言;隔离/triage;部分失败/重跑/回填。
- 输出前质量门;accept command+negative;typeIssues 为空。`,
    },
  },
  contract: {
    type: "contract",
    label: "接口/协议契约",
    trigger: "API/消息/字段/版本变更、弃用、兼容性",
    stages: {
      collect: `${COMMON}
# contract · collect
- 字段级 add/modify/delete + before(旧字段/旧语义)。
- semver 判定(同 major 禁删改;改名=删+加并存)。
- 全量消费者具名(服务/客户端/测试/脚本),不能只写「相关方」。
- 弃用窗口带日期;每条 breaking ≥1 条迁移路径。
- Tolerant Reader/契约测试;验收命令与负面(旧客户端/缺字段)。`,
      draw: `${COMMON}
# contract · draw
- 字段表节点(字段级 add/modify/delete+before);版本/semver 节点;消费者清单;弃用日期窗口。
- 每条 breaking 有迁移路径;Tolerant Reader/契约测试节点。
- 禁「待 glob/待定/TBD」占位;accept command+negative(旧版本/缺字段/未知字段)。`,
      audit: `${COMMON}
# contract · audit
- 字段级变更+before;semver;全消费者;弃用日期;迁移路径;无占位。
- 契约测试/negative 在;跑 board_upsert action=audit;typeIssues 为空。`,
    },
  },
  deploy: {
    type: "deploy",
    label: "部署/打包",
    trigger: "部署、打包、安装器、发布、环境/回滚",
    stages: {
      collect: `${COMMON}
# deploy · collect
- 环境拓扑(机器/服务/端口/依赖)与 artifact 版本。
- preflight 每项:检查命令 + 通过判据。
- 发布策略(rolling/蓝绿/canary)+观察窗/放量条件。
- smoke P0 用户旅程(启动→配置→真实任务)+≥1 负面断言;smoke 必须接线到发布步骤。
- 回滚触发阈值 + 验证命令。
- accept command(安装/启动/冒烟)+browser(面板/UI)。`,
      draw: `${COMMON}
# deploy · draw
- 环境拓扑→preflight→发布步骤→smoke→回滚;preflight/smoke 不合并。
- smoke P0 旅程与发布步骤显式连边;回滚有阈值+验证。
- artifact 版本、观察窗/放量写清;accept command+browser。
- 模板/smoke 节点 targets 可空,但 P0 accept 必须有 expect。`,
      audit: `${COMMON}
# deploy · audit
- preflight 判据;发布策略/观察窗;smoke P0 旅程+negative;smoke 接线;回滚阈值。
- preflight/smoke 未合并;accept command+browser;typeIssues 为空。`,
    },
  },
  research: {
    type: "research",
    label: "调研/选型",
    trigger: "调研、选型、方案比较、候选评估",
    stages: {
      collect: `${COMMON}
# research · collect
- 决策问题与候选 ≥2;候选的适用条件。
- 维度(成本/风险/可维护性/性能等)+ 权重;权重来源/口径可见。
- 每格证据来源+可信度;无证据标「未知」,不编。
- 每个被拒候选的放弃理由;结论推荐+理由。
- 禁止先写结论再补证据。`,
      draw: `${COMMON}
# research · draw
- 候选×维度矩阵(节点/表格视图);权重可见、加权分可复算。
- 每格证据+可信度;无证据=未知;结论=推荐+理由。
- 每个被拒候选至少一条放弃理由边;研究板不套风险/回滚规则。
- 矩阵用 boardType=research(或 matrix),候选/维度/权重/未知/放弃理由齐全。`,
      audit: `${COMMON}
# research · audit
- 候选≥2;维度/权重可见可复算;每格证据/可信度/未知;被拒理由;结论推荐。
- 禁结论先行补证/机械总分;跑 board_upsert action=audit;typeIssues 为空。`,
    },
  },
  orchestration: {
    type: "orchestration",
    label: "Agent 编排",
    trigger: "多 agent/子代理编排、派发、并行、失败回收",
    stages: {
      collect: `${COMMON}
# orchestration · collect
- 每个 agent 四字段:职责/输入 schema/输出 schema/工具面。
- 派发条件+传参;跨仓/跨进程桥接点(协议/文件/HTTP)。
- 每个非叶节点失败分支:timeout 预算向下收缩/retry+jitter+cap/非幂等不重试/补偿降级。
- fan-out 必 fan-in,并行终态→聚合;大载荷共享存储引用。
- 验收:编排拓扑+真实派发+失败回收+终态。`,
      draw: `${COMMON}
# orchestration · draw
- agent 拓扑节点(四字段);派发边带触发条件/参数;跨仓桥接点标注。
- 每个非叶节点有失败分支;timeout/retry jitter+cap/非幂等/补偿写清。
- fan-out 必须有 fan-in 聚合;大载荷走共享存储引用。
- 禁过度编排/无限重试;accept command+negative(超时/失败/重试)。`,
      audit: `${COMMON}
# orchestration · audit
- agent 四字段;派发条件/参数;失败分支;fan-in;共享存储;无无限重试。
- 跑 board_upsert action=audit;typeIssues 为空。`,
    },
  },
  matrix: {
    type: "matrix",
    label: "决策矩阵",
    trigger: "候选×维度比较(研究/选型的矩阵视图)",
    stages: {
      collect: `${COMMON}
# matrix · collect
- 候选清单(≥2)与决策问题。
- 维度/权重(来源、口径、可复算);每格证据/可信度;无证据标未知。
- 每个被拒候选的放弃理由。`,
      draw: `${COMMON}
# matrix · draw
- boardType=matrix;候选×维度矩阵视图;每格文本=证据/结论。
- 权重可见、加权分可复算;未知格显式写「未知」;结论=推荐+放弃理由。
- 不套风险/回滚(矩阵是决策视图)。`,
      audit: `${COMMON}
# matrix · audit
- 候选/维度/权重/证据/未知/放弃理由齐全;结论推荐;跑 board_upsert action=audit;typeIssues 为空。`,
    },
  },
  composition: {
    type: "composition",
    label: "作业思路",
    trigger: "办公/产出类任务:写 PPT、汇报、写文章、调研报告——要先定主题/受众/结构/章节再动笔",
    stages: {
      collect: `${COMMON}
# composition · collect(作业思路:先答六问,再画板)
- **六问(逐条答,答不出就别落板)**:
  1) **主题是什么**——一句话说清这份东西到底要证明/交付什么(不是「关于 X 的汇报」这种话题名)。
  2) **受众是谁**——谁读、他关心什么、他读之前已知什么(决定详略与术语深度)。
  3) **表达结构是什么**——总-分-总 / 问题-分析-结论 / 现状-方案-收益 / 时间线 / 对照,选一种并说明为何适配受众。
  4) **要几章**——章数(≥2),每章一个独立主张,不是按素材堆。
  5) **每章主题是什么**——每章一句可判定主张(如「现状链路有 3 处串行阻塞」),不写「背景/概述」这类空词。
  6) **章与章之间是什么关系、顺序如何**——相邻两章是承接/递进/并列/对照/因果中的哪一种,为什么这个顺序读者更好懂。
- **本板不画执行步骤、不写 targets/symbolRef/before**:作业思路板描述「成品长什么样」,不是「我怎么去做」;不要出现「先查资料→再写初稿→最后校对」这类似 TODO 序列。
- 素材/证据留到具体章节的内容里(章 summary 里可带 file:line/数据来源),不要单独铺证据节点阵。`,
      draw: `${COMMON}
# composition · draw(六问 → 节点)
- **主题节点**:一个 note 承载主题,\`node t1 note keep "主题" | <一句话主题断言>\`。
- **受众**:写清在节点 summary 里(「受众:…(关心什么/已知什么)」)——可挂在 t1 上,也可单独一个 note;读者不看任务书也能看出这是写给谁的。
- **章节节点**:逐章落 section,**至少 2 章**,label 带序号,summary 是本章一句主张:
  \`node s1 section keep "01 <章标题>" | <本章一句主张>\`
  \`node s2 section keep "02 <章标题>" | <本章一句主张>\`
- **章间关系**:相邻章用 data 边(->>)并写关系词,\`edge s1 ->> s2 : 递进\`;关系词只允许 **承接 / 递进 / 并列 / 对照 / 因果** 五选一,禁 call/verify,也不改 edge kind 枚举。
- 章数 ≥2;首章承担「为什么读这份东西」,末章落在结论/行动;并列关系的章可多条边指向同一结论章。
- 不写 targets/symbolRef/before/accept 里的命令(本板不是代码变更板);docKind 用缺省 design。`,
      audit: `${COMMON}
# composition · audit(交板前逐条)
- **主题**:有且只有一个主题节点,且是一句断言(不是话题名)。
- **受众**:至少一个节点的 summary 写了「受众:…」,看得出写给谁、关心什么。
- **章节 ≥2**:每个 section 的 label 带序号、summary 是本章主张(非「背景/概述」空词)。
- **关系边**:每对相邻章节都有 data 边且 label 是承接/递进/并列/对照/因果之一;缺关系词的边补上或删掉。
- **无代码字段**:全板无 targets/symbolRef/before/accept 命令、无 function/tool/http 等代码级节点、无执行步骤序列。
- 跑 board_upsert action=audit;typeIssues 为空。`,
    },
  },
};

/** 解析 "code/collect" 或 "code:collect";非法返回 null。 */
export function parseBoardSkillName(name: string): { type: BoardSkillType; stage: BoardSkillStage } | null {
  const raw = String(name || "").trim().toLowerCase();
  const m = /^([a-z][a-z-]*)[/:]([a-z]+)$/.exec(raw);
  if (!m) return null;
  const type = m[1] as BoardSkillType;
  const stage = m[2] as BoardSkillStage;
  if (!BOARD_SKILL_TYPES.includes(type)) return null;
  if (!BOARD_SKILL_STAGES.includes(stage)) return null;
  return { type, stage };
}

export function boardSkillBody(type: string, stage: string): string | null {
  const t = String(type || "").toLowerCase() as BoardSkillType;
  const s = String(stage || "").toLowerCase() as BoardSkillStage;
  if (!BOARD_SKILL_TYPES.includes(t)) return null;
  if (!BOARD_SKILL_STAGES.includes(s)) return null;
  return BOARD_TYPE_SKILLS[t].stages[s] ?? null;
}

/** 精简索引(注入 planner 系统提示;不含任何一类画法正文)。 */
export function boardSkillIndex(): string {
  const rows = BOARD_SKILL_TYPES.map((t) => `${t}=${BOARD_TYPE_SKILLS[t].label}(${BOARD_TYPE_SKILLS[t].trigger})`).join(" / ");
  return [
    `板型技能(category="board",name="<type>/<stage>"):${rows}`,
    `每类三阶段:collect(收集必备信息)→draw(画法与结构)→audit(交板自检)。先判定 boardType,只加载该类的这三份,禁止一次加载全部。`,
  ].join("\n");
}

/** 所有技能名(测试/索引用)。 */
export function boardSkillNames(): string[] {
  return BOARD_SKILL_TYPES.flatMap((t) => BOARD_SKILL_STAGES.map((s) => `${t}/${s}`));
}
