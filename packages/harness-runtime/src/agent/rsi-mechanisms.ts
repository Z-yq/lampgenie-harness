/**
 * RSI 12 机制的目录 + agent 任务 brief(纯逻辑,零 IO)。
 * 为什么要有这一层:
 * - 现状 12 个机制全由 gateway 侧的确定性代码 + `scripts/*.mts` 算,产出只有计数与阈值判定;
 * 是「机制应当用 agent 做,代码只做采集/校验」,所以需要一份**机制无关**的目录:
 * 每个机制一条 spec(标题/目标/数据源/期望结果),派单时由 brief 把它翻成给 agent 的任务书。
 * - 标题必须与 `apps/gateway/src/rsi-status.ts` 的 `RSI_SECTION_TITLES` 逐字一致:面板与
 * 派单文案共用一份中文短名,漂移会让用户在两个入口看到两个名字。单测硬断言全等,防漂移。
 * - dataSources 一律是 **root 相对路径**,且必须是 store 里真实存在的常量(grep 自各 `*-store.ts`),
 * 不允许写「想象中的台账」——agent 拿到不存在的路径就会编数字。
 * 红线:
 * - 零 IO:不读文件 / 不碰时钟 / 不读环境。root 只做字符串拼接(brief 里给绝对路径)。
 * - 绝不 throw:未知 id(以及缺字段的 opts)返回一段说明文本,让调用方把原因透给用户。
 * - 不 mutate 入参,不共享可变状态(`RSI_MECHANISMS` 与数据源数组都是只读意图,调用方不得改)。
 */

/** 12 个机制的固定 id 与顺序(= 协议面 sections 的顺序,与 rsi-status.ts 的 RSI_SECTION_IDS 全等)。 */
export const RSI_MECHANISM_IDS = [
  "nightly",
  "evidence",
  "experiments",
  "cost",
  "injection",
  "tools",
  "changeRequests",
  "cohort",
  "negativeKb",
  "prompts",
  "atlas",
  "pathology",
] as const;

export type RsiMechanismId = (typeof RSI_MECHANISM_IDS)[number];

/** 驱动方式:agent = 派 agent 任务按 brief 分析;code = 现有确定性代码/CLI。 */
export type RsiMechanismDriver = "agent" | "code";

/** 结果条目状态(与 brief 里逐字给出的 schema 同一枚举)。 */
export const RSI_RESULT_STATUSES = ["ok", "warn", "bad", "info"] as const;

export type RsiResultStatus = (typeof RSI_RESULT_STATUSES)[number];

/** 一个机制的目录条目。 */
export interface RsiMechanismSpec {
  id: RsiMechanismId;
 /** 中文短名,必须与 rsi-status.ts 的 RSI_SECTION_TITLES 逐字一致。 */
  title: string;
 /** 一句话目标:agent 要做成什么判断。 */
  goal: string;
 /** 只读数据源(root 相对路径,取自各 store 的路径常量)。 */
  dataSources: string[];
 /** 本机制期望产出的结果条目(一句话)。 */
  resultHint: string;
 /** 缺省驱动方式。 */
  defaultDriver: RsiMechanismDriver;
 /** 缺省开关。 */
  defaultEnabled: boolean;
 /** 是否需要在运行前注入「待分析会话」候选池(轨迹类机制=是;台账类机制=否)。
 * 此前 12 个机制不论职责都塞 12 个候选,agent 实际只读台账、`已分析会话` 恒 0,
 * 预览成本却按 12 会话计入。按机制职责精确投放,才谈得上「分析的会话被认账」。 */
  analyzesSessions: boolean;
}

/**
 * 12 条机制目录。`satisfies` 而不是类型注解:保留字面量类型,同时强制 12 个 id 一个不落。
 */
export const RSI_MECHANISMS: Record<RsiMechanismId, RsiMechanismSpec> = {
  nightly: {
    id: "nightly",
    title: "夜间任务",
    goal: "复盘最近一昼夜的会话与夜间 run,判断夜间整合覆盖是否完整、候选是否被消化、有哪些该转成 follow-up 的欠账。",
    dataSources: [".genie/rsi/nightly/", ".genie/journals/", ".genie/rsi/rework-chains.jsonl"],
    resultHint: "产出夜间整合复盘条目:覆盖了哪些会话、哪些步骤空转或失败、下一轮该补什么。",
    defaultDriver: "agent",
    defaultEnabled: true,
    analyzesSessions: true,
  },
  evidence: {
    id: "evidence",
    title: "证据图",
    goal: "基于证据图的节点与边判断证据链是否闭合:主张有没有支撑、支撑是否过期、哪条连线是空口断言。",
    dataSources: [".genie/evidence/graph.jsonl"],
    resultHint: "产出证据图体检条目:未支撑的主张、悬空节点、过期支撑各成一条。",
    defaultDriver: "agent",
    defaultEnabled: true,
    analyzesSessions: false,
  },
  experiments: {
    id: "experiments",
    title: "实验",
    goal: "从实验台账判定哪些实验该继续、该收敛、该回滚,以及决策与指标是否自洽。",
    dataSources: [".genie/experiments/ledger.jsonl"],
    resultHint: "产出实验结论条目:每条形如「实验 X 应 adopt/reject/iterate/rollback,依据指标 …」。",
    defaultDriver: "agent",
    defaultEnabled: true,
    analyzesSessions: false,
  },
  cost: {
    id: "cost",
    title: "成本与熔断",
    goal: "结合成本台账与熔断记录判断成本趋势、预算燃烧速率,以及熔断触发与恢复是否合理。",
    dataSources: [".genie/rsi/cost.jsonl", ".genie/rsi/breaker.jsonl"],
    resultHint: "产出成本治理条目:预算燃烧速率、异常花费来源、熔断是否该触发或该恢复。",
    defaultDriver: "agent",
    defaultEnabled: true,
    analyzesSessions: false,
  },
  injection: {
    id: "injection",
    title: "注入防护",
    goal: "复核注入防护的命中台账与人工批准记录,判断是否存在绕过、误报,或长期挂着的待批准命中。",
    dataSources: [".genie/rsi/injection.jsonl"],
    resultHint: "产出注入防护条目:新出现的攻击面、误报规则、待人工批准或该长期采信的命中。",
    defaultDriver: "agent",
    defaultEnabled: true,
    analyzesSessions: false,
  },
  tools: {
    id: "tools",
    title: "数据工具",
    goal: "基于数据工具的注册、钉扎与使用痕迹判断工具是否被真实使用,哪些该退役、哪些能力还缺。",
    dataSources: [".genie/rsi/tools/", ".genie/rsi/tool-pins.json"],
    resultHint: "产出工具治理条目:该退役的工具、该补的能力、注册与检索不一致项。",
    defaultDriver: "agent",
    defaultEnabled: true,
    analyzesSessions: true,
  },
  changeRequests: {
    id: "changeRequests",
    title: "变更请求",
    goal: "判断变更请求的流转(提案 → 批准 → 落地 → 回滚)是否卡住,哪一条该推进、哪一条该关。",
    dataSources: [".genie/rsi/change-requests.jsonl", ".genie/rsi/proposals/"],
    resultHint: "产出变更请求条目:卡住的请求、该推进的下一步、该关闭的原因。",
    defaultDriver: "agent",
    defaultEnabled: true,
    analyzesSessions: false,
  },
  cohort: {
    id: "cohort",
    title: "同批指标",
    goal: "看同批指标与签名样本,判断同批对比是否可比、有没有异常批次或指标漂移。",
    dataSources: [".genie/rsi/cohort.jsonl", ".genie/rsi/signatures.jsonl"],
    resultHint: "产出同批指标条目:不可比批次、异常批次、需要重算的口径。",
    defaultDriver: "agent",
    defaultEnabled: true,
    analyzesSessions: false,
  },
  negativeKb: {
    id: "negativeKb",
    title: "负面知识",
    goal: "复核负面知识库的死路记录,判断哪些该翻案、哪些该过期、哪些该在规划期注入提醒。",
    dataSources: [".genie/rsi/negkb.jsonl"],
    resultHint: "产出负面知识条目:该翻案的死路、该过期的死路、该进规划注入的建议。",
    defaultDriver: "agent",
    defaultEnabled: true,
    analyzesSessions: true,
  },
  prompts: {
    id: "prompts",
    title: "提示词版本",
    goal: "看提示词版本 book 与钉扎情况,判断哪个版本在真实会话里表现更好,该推广还是该回退。",
    dataSources: [".genie/rsi/prompts/book.json", ".genie/rsi/prompts/pins.json"],
    resultHint: "产出提示词版本条目:版本优劣对比、该钉扎或该回退的版本与依据。",
    defaultDriver: "agent",
    defaultEnabled: true,
    analyzesSessions: false,
  },
  atlas: {
    id: "atlas",
    title: "方向图",
    goal: "基于方向图判断当前方向是否仍成立,哪些方向该新增、该合流、该下线。",
    dataSources: [".genie/rsi/atlas/"],
    resultHint: "产出方向图条目:该新增的方向、该合流或下线的方向,以及支撑它的证据。",
    defaultDriver: "agent",
    defaultEnabled: true,
    analyzesSessions: false,
  },
  pathology: {
    id: "pathology",
    title: "病理目录",
    goal: "看病理目录判断重复出现的问题模式是否已被根治,哪些该升级为机制、哪些可以降级。",
    dataSources: [".genie/rsi/pathology.jsonl"],
    resultHint: "产出病理目录条目:复发的病理模式、该升级为机制的条目、可标记已根治的条目。",
    defaultDriver: "agent",
    defaultEnabled: true,
    analyzesSessions: true,
  },
};

/** 目录查询:未知 id(或非字符串)→ undefined,不 throw。 */
export function mechanismSpec(id: string): RsiMechanismSpec | undefined {
  if (typeof id !== "string") return undefined;
  const key = id.trim();
  if (key === "") return undefined;
  return (RSI_MECHANISMS as Record<string, RsiMechanismSpec | undefined>)[key];
}

/** 生效配置:目录缺省 + 覆盖层(override 优先;非法覆盖值按缺省处理)。 */
export function resolveMechanismConfig(
  id: string,
  override?: { enabled?: boolean; driver?: RsiMechanismDriver },
): { id: RsiMechanismId; title: string; enabled: boolean; driver: RsiMechanismDriver } | undefined {
  const spec = mechanismSpec(id);
  if (!spec) return undefined;
  const overrideEnabled = typeof override?.enabled === "boolean" ? override.enabled : undefined;
  const overrideDriver = normalizeDriver(override?.driver);
  return {
    id: spec.id,
    title: spec.title,
    enabled: overrideEnabled ?? spec.defaultEnabled,
    driver: overrideDriver ?? spec.defaultDriver,
  };
}

function normalizeDriver(value: unknown): RsiMechanismDriver | undefined {
  return value === "agent" || value === "code" ? value : undefined;
}

/** brief 里「待分析会话」的一条候选(近 3 日 · 所有项目 · 未分析过)。 */
export interface AgentBriefAnalysisCandidate {
  sessionId: string;
 /** 归属项目(取不到就缺省,不编造)。 */
  projectId?: string;
 /** 最后活动时刻(ms epoch);缺省=不显示时间。 */
  lastActiveAt?: number;
}

/** brief 的会话分析计划入参( RSI-SESSION-COST:每次运行只分析列出的会话)。 */
export interface AgentBriefAnalysis {
 /** 窗口天数(缺省 3)。 */
  windowDays?: number;
 /** 候选会话(空数组=本窗口无未分析会话)。 */
  candidates?: readonly AgentBriefAnalysisCandidate[];
}

/** brief 生成入参。 */
export interface AgentBriefOptions {
 /** 机制 id(未知 id 不 throw,返回说明文本)。 */
  id: string;
 /** 仓库根(数据源路径按它拼绝对路径)。 */
  root: string;
 /** agent 该把结果 JSON 写到哪(绝对或 root 相对,原样透传)。 */
  resultPath: string;
 /** 待分析会话计划(缺省=不注入该小节,旧行为逐字不变)。 */
  analysis?: AgentBriefAnalysis;
 /** 本次运行的 token 预算(缺省=不注入;0/非法=不注入)。软预算:先结论后证据,接近预算就收尾。 */
  budgetTokens?: number;
 /** 实验配额因子(ROI downshift 的消费面;仅 experiments 机制且 0<f<1 时注入)。 */
  experimentQuotaFactor?: number;
}

/** 「预算」小节:软预算(不硬停,但要求在预算内先保证结果文件写全)。 */
function budgetSection(budgetTokens: number | undefined): string[] {
  const budget = typeof budgetTokens === "number" && Number.isFinite(budgetTokens) && budgetTokens > 0
    ? Math.floor(budgetTokens)
    : 0;
  if (budget === 0) return [];
  return [
    "## 本次运行预算",
    `- token 预算:${budget}(输入+输出)。先给结论、再补证据条目;接近预算时立即收尾,不要为凑条目继续逐文件细读。`,
    "- 预算不是硬停:宁可少写 1~2 条,也不要把 resultPath 留空或写坏 JSON。",
    "",
  ];
}

/** 「实验配额」小节:ROI downshift 的 experimentQuotaFactor 消费面(只有 experiments 机制注入)。
 * 口径:N=本轮 queue 里可用候选数,最多 ceil(N×factor) 条转入实验,其余显式 defer(不静默丢)。 */
function experimentQuotaSection(id: string, factor: number | undefined): string[] {
  if (id !== "experiments") return [];
  const f = typeof factor === "number" && Number.isFinite(factor) && factor > 0 && factor < 1 ? factor : 0;
  if (f === 0) return [];
  return [
    "## 实验配额(ROI 降频生效中)",
    `- 本轮配额因子 x${f}:候选队列里最多把 ceil(N×${f})(N=本轮可用候选数,至少 1 条)转入实验。`,
    "- 未转入的候选**不许静默丢弃**:逐条记录候选 id + defer 原因(「配额降频」),写进结果条目或 detail,下轮配额恢复时优先取。",
    "- 判断「配额是否应该继续」也算发现:如果本轮候选 ROI 普遍低,如实写,不要为凑数硬转。",
    "",
  ];
}

/** 「待分析会话」小节:逐行列出候选 + 硬规则(只分析列出的会话 / 最终回复必须带记账行)。 */
function analysisSection(analysis: AgentBriefAnalysis | undefined): string[] {
  if (analysis === undefined || analysis === null) return [];
  const days = typeof analysis.windowDays === "number" && Number.isFinite(analysis.windowDays) && analysis.windowDays > 0
    ? analysis.windowDays
    : 3;
  const list = Array.isArray(analysis.candidates) ? analysis.candidates : [];
  const rows: string[] = [];
  for (const candidate of list) {
    const sessionId = typeof candidate?.sessionId === "string" ? candidate.sessionId.trim() : "";
    if (sessionId === "") continue;
    const projectId = typeof candidate.projectId === "string" && candidate.projectId.trim() !== "" ? candidate.projectId : undefined;
    const at = typeof candidate.lastActiveAt === "number" && Number.isFinite(candidate.lastActiveAt)
      ? new Date(candidate.lastActiveAt).toISOString()
      : undefined;
    const meta = [
      `项目 ${projectId ?? "(未绑定)"}`,
      ...(at === undefined ? [] : [`最后活动 ${at}`]),
    ].join(",");
    rows.push(`- ${sessionId}(${meta})`);
  }
  return [
    `## 待分析会话(近 ${days} 日 · 所有项目 · 未分析过)`,
    ...(rows.length > 0 ? rows : ["本窗口无未分析会话"]),
    "",
    "规则:",
    "1. 上面的候选会话是本机制的主数据:先逐个读关键片段(可 grep/head,不必整读),再产出条目;列了但读不到就照实写「会话缺失」。",
    "2. 每条结论都要能指到某个会话里的具体事件/工具调用,不许跨会话脑补;detail 里写 sessionId 与 file:line 证据。",
    `3. 最终回复**必须含一行** \`已分析会话: <sid1>, <sid2>\`(一个都没分析就写 \`已分析会话: (无)\`);`,
    "   这一行是记账依据,逐字遵守(代码按它记「这些会话已分析过」,写错 id 就不算数)。",
    "4. 每个真正读过的候选会话至少贡献 1 条结果条目(没有发现就写 status=info 的「无异常 + 依据」);一个条目都不产出的会话视为未分析。",
    "",
  ];
}

/** 剥掉尾部斜杠,避免拼出 `//`。 */
function trimRoot(root: unknown): string {
  const text = typeof root === "string" ? root.trim() : "";
  if (text === "") return "";
  return text.replace(/[\\/]+$/, "");
}

/** root + root 相对路径 → 绝对路径(零 node:path,纯字符串拼接)。 */
function absolute(root: string, relative: string): string {
  const rel = relative.replace(/^[\\/]+/, "");
  return root === "" ? rel : `${root}/${rel}`;
}

/**
 * 把一条机制目录翻成给 agent 的任务书(brief)。
 * 结构固定 6 段(+可选第 7 段):标题与目标 / 数据源绝对路径 / [待分析会话] / 红线 / 允许的采集方式 /
 * 结果文件与 schema / 期望产出。传 `analysis` 才插「待分析会话」小节(默认不插,旧行为不变)。
 * 未知 id → 返回简短说明(含可用 id 清单),不 throw——派单方据此 fail-closed 到 reason。
 */
export function buildAgentBrief(opts: AgentBriefOptions): string {
  const spec = mechanismSpec(opts?.id as string);
  if (!spec) {
    const raw = typeof opts?.id === "string" ? opts.id : String(opts?.id ?? "");
    return [
      `未知 RSI 机制 id:"${raw}"。`,
      `可用机制 id:${RSI_MECHANISM_IDS.join(" / ")}。`,
      "本 brief 无可执行内容:请换合法 id 重试(rsi.status 可查全部机制)。",
    ].join("\n");
  }

  const root = trimRoot(opts.root);
  const given = typeof opts.resultPath === "string" ? opts.resultPath.trim() : "";
  const resultPath = given === "" ? absolute(root, `.genie/rsi/agent-runs/${spec.id}/<runId>.result.json`) : given;
  const sources = spec.dataSources.map((source) => `- ${absolute(root, source)}(只读,${source})`);
  const schema = `{"items":[{"id":"kebab-id","title":"≤30字主张","summary":"≤200字结论+为什么重要","evidence":"file:line 或 字段=值","impact":"不处理的后果","action":"最小可执行动作","status":"ok|warn|bad|info"}]}`;

  return [
    `# RSI 机制任务:${spec.title}(id=${spec.id})`,
    "",
    "## 标题与目标(title / goal)",
    `- title:${spec.title}`,
    `- goal(目标):${spec.goal}`,
    "",
    "## 数据源(dataSources,只读,绝对路径)",
    ...(sources.length > 0 ? sources : ["- (本机制无数据源)"]),
    "",
    ...analysisSection(opts.analysis),
    ...budgetSection(opts.budgetTokens),
    ...experimentQuotaSection(spec.id, opts.experimentQuotaFactor),
    "## 红线",
    "1. 只用上面数据源里的真实数据;文件缺失或为空就照实写「无数据」,不许推断或补全。",
    "2. 禁止编造数字、比例、日期、文件名与引用:每个数字都要能指到数据源里的具体行或字段。",
    "3. 不得修改任何源码、配置与既有台账;不得写数据源目录之外的路径;不 commit、不 push。",
    "",
    "## 任务形态(只读审计,不走编码仪式)",
    "- 这是**只读审计任务**:直接读数据源 → 写 resultPath → 最终回复列条目;不要落白板、不要 spawn_subagent、不要展开五阶段/task_phase 仪式。",
    "- 若工具面强制 plan-gate:用一次 board_upsert(exemptReason=\"只读 RSI 审计,不改源码/配置/台账\")拿豁免即可,不要建板。",
    "",
    "## 允许的采集方式",
    "- 可以运行仓内 scripts/*.mts 做只读统计(先读脚本确认是只读再用)。",
    "- 可以直接读上面列出的 .genie 台账 / JSONL:大文件用 grep / head 定位,不要整读。",
    "- **不要对 .genie 全目录递归 grep/find**(324MB journal + 9p 慢盘会挂几分钟);只在上面列出的数据源路径内定向读,或 grep 指定文件。",
    "- 不跑构建、不跑全量测试、不跑任何写盘脚本。",
    "",
    "## 结果输出(resultPath + schema)",
    `- resultPath(结果文件):${resultPath}`,
    "- 写单个 UTF-8 JSON 文件,不要用 markdown 代码块包裹。",
    "- **resultPath 的 runId 必须逐字照抄**(少一位/多一位=本轮零产出);写完立即用 ls 或 read_file 确认该文件存在。",
    `- schema(逐字照抄结构,只改值):${schema}`,
    "- 条数 **1~6**(结论级发现;超过 6 条只保留影响最大的 6 条,其余在最终回复一句话带过,不写 items)。",
    "- id 用 kebab-case 且在本机制内唯一;title ≤30 字;summary ≤200 字。",
    `- status 只取 ${RSI_RESULT_STATUSES.join(" | ")} 之一。`,
    '- 一条结果都没有时写 {"items":[]}(空数组),不要编占位条目。',
    "",
    "## 结果质量(最高优先级:拒绝流水账)",
    "每条必须是「主张 → 证据 → 影响 → 建议」四件套,缺一即质量不合格:",
    "- **title**:一句可判定的主张/风险,不是观察记录;不要以「某字段缺失/某文件不存在」当标题。",
    "- **summary**:结论 + 为什么重要(具体到哪个决策/哪类任务会受影响),≤200 字。",
    "- **evidence**:file:line 或「字段名=具体数值」,必须能在数据源里逐字复核;禁止只写「台账里」这种泛指。",
    "- **impact**:不处理会怎样(具体后果/风险,不是「影响可读性」这类套话)。",
    "- **action**:最小可执行动作(改哪个文件/字段、谁来做、验收口径),不要「建议完善/加强监控」。",
    "- **禁止流水账**:复述台账行数/字段名/文件存在性(除非它直接阻断一个结论)、同一个问题拆成多条、无证据推测、把「无数据」写成多条;没有值得报的发现就写 {\"items\":[]}。",
    "- detail 可选(补充上下文);主要证据/影响/建议放对应字段,不要全塞 detail。",
    "",
    "## 本机制期望产出的结果条目",
    spec.resultHint,
    "",
    "## 最终回复(会话窗里给人看的产出)",
    "分析完成后,除了写 resultPath,还必须在**最终回复**里按下面格式列出全部结果条目(与结果 JSON 完全一致,不增减、不改写):",
    "- <title>:<summary>",
    "",
    "要求:每条一行;条数与 JSON 的 items 相同;没有结果就回复「无数据(已核对 <数据源>)」并说明缺什么。",
    "这段回复会直接显示在 RSI 会话窗里,是用户看到的产出面,不要省略。",
  ].join("\n");
}
