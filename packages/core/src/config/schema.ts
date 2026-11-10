/**
 * 配置 schema(zod,默认值就地——ZCode validationAppSettings 模式)。
 * 双轨红线( §4/ §10):coding 轨(vibe coding/子 agent)与 audio 轨(主 agent
 * 语音管家:chat 大脑+ASR 耳+TTS 嘴)是两个顶层命名空间,凭证引用各自独立,互不混用。
 * 凭证引用化红线:配置里只存 env 名,明文值只从 env/密钥文件解析,绝不落配置文件。
 */
import { z } from "zod";

/** 端点+凭证引用的通用形状(两轨共用形态,命名空间独立)。 */
const endpointRef = {
  baseUrl: z.string().optional(),
  /** 引用 providers[] 的 id:baseUrl/apiKeyEnv 未显式给出时从该 provider 继承。 */
  providerId: z.string().optional(),
  model: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(600_000).default(60_000),
  maxTokens: z.number().int().min(0).max(1_000_000).optional(),
 /** 思考力度(ZCode effort 下拉对齐):low/medium/high/xhigh;""=显式关(请求不发该参数)。
 * (视频 2):默认=high,档位对齐「低/中/高/最高」(端点经验证接受 xhigh)。
   * 请求侧映射 reasoning_effort;响应侧采集 reasoning_content 进思考卡。 */
  reasoningEffort: z.union([z.literal(""), z.enum(["low", "medium", "high", "xhigh"])]).default("high"),
 /** 上下文窗口(tokens,容量看板+到阈自动 /compact;ZCode ContextWindow 对齐)。 */
  contextWindow: z.number().int().min(1000).max(10_000_000).optional(),
 /** 主实施轨思考力度( O2):实施=改代码/跑命令,缺省 high(不进 UI 下拉档位选择)。
   * 语义:非空档位恒进请求体(与 reasoningEffort 的「仅显式携带」不同,这里是本轨唯一权威);
   * ""=显式关(请求不带该参数)。旧 reasoningEffort 对主实施轨不再生效(2026-10-20 用户拍板)。 */
  implementationEffort: z.union([z.literal(""), z.enum(["low", "medium", "high", "xhigh"])]).optional(),
};
const roleRef = z.object({
  model: z.string(),
  baseUrl: z.string().optional(),
  providerId: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
  maxTokens: z.number().int().min(0).max(1_000_000).optional(),
 /** 角色思考力度( O2):review/subagent 缺省 xhigh,compact 跟随主实施轨;""=显式关。 */
  reasoningEffort: z.union([z.literal(""), z.enum(["low", "medium", "high", "xhigh"])]).optional(),
});

/** 设置页「清除」发的空串按「未设置」处理( web.search 清除按钮存量 bug:
 * 空串被 enum/min(1) 拒绝 → cfg.set 必抛错,用户点清除只会看到报错)。 */
const emptyToUndefined = (v: unknown): unknown =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

export const ConfigSchema = z.object({
  gateway: z.object({
    port: z.number().int().min(1).max(65535).default(7700),
    /** 面板(HTTP+WS 同端口);false=纯 WS。 */
    panel: z.boolean().default(true),
 /** 面板只读( ui 板五态):true=设置页编辑控件禁用,cfg.set 服务端硬拒;模型可查看不可切。 */
    panelReadOnly: z.boolean().default(false),
  }).default({}),
  executor: z.object({
 /** echo|dsh|none|zcode|opencode;dsh 未构建 fail-visible;zcode/opencode=外部 CLI 一次性后端。 */
    kind: z.enum(["echo", "dsh", "none", "zcode", "opencode"]).default("echo"),
  }).default({}),
 /** coding 轨(vibe coding/子 agent, §10):任务执行与代码工具的模型族。 */
  coding: z.object({
    /** 主 coding 模型(任务执行;旧顶层 llm 块迁移而来)。 */
    llm: z.object(endpointRef).extend({
 /** 主模型是否接收图像输入( view_image):缺省 true(主流新模型多模态);
       * false=纯文本模型,view_image 改走 coding.vlm 视觉兜底(图转文字描述),
 * 未配置 vlm 则如用户反馈错(不硬造能力)。 */
      vision: z.boolean().optional(),
    }).default({}),
 /** 视觉兜底模型(二次定稿=同 provider 语义):
     * 只填 model(必填),baseUrl/providerId/apiKeyEnv 继承 coding.llm 同一 provider——
     * 主模型无视觉(coding.llm.vision=false)时 view_image 用同 provider 的视觉模型把图转
     * 文字描述;同 provider 也没有(未配置)=无法处理图片,如实告知用户。 */
    vlm: roleRef.optional(),
    /** 按角色分模型(hermes auxiliary.<task>/dsh providers.<route> 模式):
     * 未填字段继承 coding.llm;只有 model 必填。compact=压缩便宜模型;review=code_review 深审。 */
    models: z.object({
      compact: roleRef.optional(),
      review: roleRef.optional(),
 /** 子代理模型(ZCode subagent_model 语义):spawn 的 LLM 循环用独立端点/模型,
       * 与主链路隔离——共享 MAAS 端点的服务端会话串扰不再打父子链路。未配置=回退主 llm。 */
      subagent: roleRef.optional(),
      /** 提炼模型(2026-11):大结果智能入上下文与 git diff 提炼用小模型;未配置=回退压缩模型(compact)。 */
      digest: roleRef.optional(),
 /** 语音任务书模型:聊天窗麦克风录音→整理成任务书;需支持音频输入的
       * 多模态模型(如 qwen3.8-omni-flash)。未配置=该功能不可用(面板按钮明确指路,不静默降级)。 */
      voice: roleRef.optional(),
    }).default({}),
 /** 停用模型(设置页模型列表):不进快切菜单;空数组=全部可用。 */
    disabledModels: z.array(z.string()).default([]),
 /** 编辑后 LSP 诊断 + 保存即格式化(参照 opencode/deepseek-harness)。
     * 独立子键(不与设置页既有字段耦合):enabled 缺省 on;server 缺失=静默跳过(fail-soft)、
     * 不阻塞写入;format=保存即格式化。timeoutMs=单次诊断/格式化各自预算。 */
    lsp: z.object({
      enabled: z.boolean().default(true),
      timeoutMs: z.number().int().min(100).max(30_000).default(2000),
      maxDiagnostics: z.number().int().min(1).max(200).default(20),
      format: z.boolean().default(true),
 /** 写前 baseline + 写后 delta:只报「写前不存在的新增」诊断。
       * 缺省 true 与 packages/harness-lsp 的 resolveLspSettings 一致;显式 false=旧行为(全量报告)。 */
      baseline: z.boolean().default(true),
 /** :是否把 warning 一并回灌(缺省 false=只报 ERROR,与 resolveLspSettings 一致)。 */
      includeWarnings: z.boolean().default(false),
    }).default({}),
  }).default({}),
 /** 上下文模型评分( Phase 1):默认本地 150M Jev(/decide);
   * 也可填任意 OpenAI 兼容“提炼 provider”。mode=off/shadow/active。
   * shadow 只记录不剪;active 用高置信度 keep/drop 参与 microcompact。 */
  context: z.object({
    modelScoring: z.object({
      mode: z.enum(["off", "shadow", "active"]).default("shadow"),
      /** 本地 150M 默认 05_serve.py --serve --port 8105(8000/8102/8103 已被本机服务占用);
       * 其它 provider 填自己的 baseUrl。 */
      providerUrl: z.string().min(1).max(500).default("http://127.0.0.1:8105"),
      /** 模型标签;jev 协议不发送该字段,openai 协议作为 model 发送。 */
      model: z.string().min(1).max(200).default("jev-150m"),
      apiType: z.enum(["jev", "openai"]).default("jev"),
      /** 外部 provider 凭证引用名(本地 150M 无 auth 可留空)。 */
      apiKeyEnv: z.string().min(1).max(64).optional(),
      minConfidence: z.number().min(0).max(1).default(0.9),
      maxCandidates: z.number().int().min(1).max(50).default(12),
      scoreEverySteps: z.number().int().min(1).max(100).default(5),
 /** 12 候选=24 问=3 行;CPU 8 线程经验证约 2.9s,3s 会贴边超时,留 8s 余量。 */
      timeoutMs: z.number().int().min(500).max(60_000).default(8_000),
      /** 内置 150M 服务由 7700 网关托管:boot 时探活→未装则告警→已装则 spawn;
       * 外部 provider URL(非 loopback)不自动拉起。路径留空=services/model-150m 默认位置。 */
      localService: z.object({
        autoStart: z.boolean().default(true),
        /** 解释器;留空优先 services/model-150m/.venv/bin/python,否则 python3。 */
        python: z.string().optional(),
        /** 上游 150M 仓库路径(留空=services/model-150m/upstream)。 */
        repoPath: z.string().optional(),
        /** jevlite.pt 路径(留空=services/model-150m/jevlite.pt)。 */
        checkpointPath: z.string().optional(),
        port: z.number().int().min(1).max(65535).default(8105),
        device: z.enum(["cpu", "cuda"]).optional(),
        threads: z.number().int().min(1).max(64).default(8),
        maxBatchSize: z.number().int().min(1).max(128).default(16),
        maxWaitMs: z.number().min(0).max(1_000).default(20),
        maxQueue: z.number().int().min(1).max(10_000).default(256),
        requestTimeoutS: z.number().min(0.1).max(120).default(10),
        maxRows: z.number().int().min(1).max(512).default(32),
        /** CPU/9p 首次加载 torch/ModernBERT 较慢;5 分钟窗口避免 supervisor 误判超时。 */
        startupTimeoutMs: z.number().int().min(1_000).max(600_000).default(300_000),
      }).default({}),
    }).default({}),
  }).default({}),
 /** audio 轨(主 agent——语音管家大脑+耳嘴,「主管理进程」/ 链路):
   * chat=主 agent 对话/任务编排大脑(一期文本任务面即它);asr/tts=语音链路(voice 二期消费,配置面先就位)。 */
  audio: z.object({
    chat: z.object({
      ...endpointRef,
      /** 对话协议:chat=OpenAI HTTP;realtime=DashScope api-ws WebSocket(文本会话)。缺省按模型名含 realtime 自动判定。 */
      protocol: z.enum(["chat", "realtime"]).optional(),
 /** 语音链路形态(两接口口径,协议参考 qwen-audio-agent,致谢):
       * - omni-query:一次 query 调用(qwen3.8-omni* 口径)——音/视频作为输入内容直接进一次
       *   OpenAI 兼容 chat(多模态 content:input_audio/image_url),文本出,再走既有 audio.tts 外接转语音;
       * - realtime-plus:realtime 会话(qwen-audio-3.1-realtime* 口径,只吃语音输入)——语音直接进
       *   api-ws 会话,text+audio 直出(模型自带语音),链路上不再外挂 tts。
       * 缺省按模型名推断:/realtime/i → realtime-plus;其余(含 qwen3.8-omni*)→ omni-query;
       * 显式 protocol 优先(chat→omni-query,realtime→realtime-plus)。结构性字段(provider 形态),改后需重启。 */
      chatMode: z.enum(["omni-query", "realtime-plus"]).optional(),
      /** realtime-plus 输出音色(session.voice;realtime 音色域与 tts 模型不同,如 longanlingxin)。缺省=端点默认音色。 */
      voice: z.string().optional(),
 /** 上下文窗口(tokens,容量看板+到阈自动 /compact)。 */
      contextWindow: z.number().int().min(1000).max(10_000_000).optional(),
    }).default({}),
 /** ASR(语音→文本), 选型 qwen3-asr。 */
    asr: z.object({ ...endpointRef, provider: z.string().optional() }).default({}),
 /** TTS(文本→语音), 选型 qwen3-tts。 */
    tts: z.object({ ...endpointRef, provider: z.string().optional(), voice: z.string().optional() }).default({}),
  }).default({}),
  /** 多 Provider 目录(ZCode provider_config.json 模式裁剪版;两轨共用端点目录,凭证引用各轨独立):
   * 每条 = 端点+凭证引用+模型目录;明文 key 永不入配置(个人层 omit apiKey,同 ZCode rule-data-schema)。 */
  providers: z.array(z.object({
    /** 唯一标识(如 maas-bj)。 */
    id: z.string().min(1),
    /** 显示名。 */
    name: z.string().default(""),
    baseUrl: z.string().min(1),
    /** 凭证引用(env 变量名;值在 env 或 .genie/secrets.json)。 */
    apiKeyEnv: z.string().optional(),
    /** 接口协议(codex wire_api / ZCode provider api.type 对齐):chat=OpenAI chat/completions
     *  (缺省,当前运行时唯一可执行路径);responses/anthropic=配置预留,运行时尚未适配。
     *  不设 default:旧配置文件不被灌值,读取侧按 chat 处理。 */
    apiType: z.enum(["chat", "responses", "anthropic"]).optional(),
    /** 自定义请求头(ZCode provider api.headers 对齐;值会写入配置文件,凭证请用 env 引用名)。 */
    headers: z.record(z.string(), z.string()).optional(),
 /** 接入方式:api=按量 API Key;token-plan=Coding 套餐/订阅(同一服务商可不同
     *  baseUrl/keyEnv/模型清单)。缺省(undefined)=api,旧配置零破坏、不被灌值。 */
    authMode: z.enum(["api", "token-plan"]).optional(),
    /** 该端点可用模型目录(ZCode 模型管理语义:条目可携带 contextWindow/maxTokens/能力元数据;
     *  字符串=旧形态仅名字,读取侧归一)。能力标记缺省 undefined=未知(UI 不显示假徽标)。 */
    models: z.array(z.union([
      z.string(),
      z.object({
        name: z.string().min(1),
        /** 上下文窗口(tokens;容量看板分母+到阈自动 /compact,选中即生效)。 */
        contextWindow: z.number().int().min(1000).max(10_000_000).optional(),
        /** 最大输出(tokens;缺省=轨级 coding.llm.maxTokens)。 */
        maxTokens: z.number().int().min(0).max(1_000_000).optional(),
        /** 能力标记(ZCode model properties 裁剪):true=支持,false=明确不支持,缺省=未知。 */
        supportsToolCall: z.boolean().optional(),
        supportsImage: z.boolean().optional(),
        supportsVideo: z.boolean().optional(),
        supportsAudio: z.boolean().optional(),
        supportsPdf: z.boolean().optional(),
        supportsJsonSchemaOutput: z.boolean().optional(),
 /** 单价覆盖(元 / 百万 token;设置台「模型设置」可填):内置表
         *  packages/core/src/config/model-prices.ts 优先被它覆盖。null=官方未单列该段(不按 0 算);
         *  缺省 undefined=用内置表。只对 authMode=api 的端点参与金额展示(token-plan 不计费)。 */
        price: z.object({
          cacheRead: z.number().min(0).max(100_000).nullable().optional(),
          cacheWrite: z.number().min(0).max(100_000).nullable().optional(),
          inputMiss: z.number().min(0).max(100_000).optional(),
          output: z.number().min(0).max(100_000).optional(),
        }).optional(),
      }),
    ])).default([]),
  })).default([]),
  tasks: z.object({
    /** 终态任务自动归档天数;0=关(默认)。 */
    autoArchiveDays: z.number().int().min(0).max(3650).default(0),
 /** 终态任务保留期(天,超期非置顶物理清除);0=关(默认; 保留期能力)。 */
    retentionDays: z.number().int().min(0).max(3650).default(0),
  }).default({}),
  journal: z.object({
    /** 会话日志目录;null=内存(测试)。 */
    dir: z.string().nullable().default(".genie/journals"),
  }).default({}),
  experience: z.object({
    root: z.string().default(".genie/experiences"),
  }).default({}),
  concurrency: z.object({
    maxConcurrent: z.number().int().min(1).max(64).default(4),
    maxConcurrentPerOwner: z.number().int().min(1).max(16).default(2),
    maxConcurrentSystem: z.number().int().min(1).max(16).default(2),
  }).default({}),
 /** 浏览器控制(ZCode 浏览器控制对齐):agent 无头浏览器工具的开关与域名白名单。
   * 2026-11 browser-ux-redo:缺省开启(人机随时可用),新增 idle 回收阈值/持久 profile/headless 三项。 */
  browser: z.object({
    /** 缺省 true(人机都随时可用);显式 false 仍关(agent 回「未启用」,面板给一键启用)。 */
    enabled: z.boolean().default(true),
    /** 域名白名单(空=全允许;配置即收紧)。 */
    allowDomains: z.array(z.string()).default([]),
    /** idle tab 回收阈值(分钟,1..240,缺省 30;正被面板视图订阅的 tab 不回收)。 */
    idleMinutes: z.number().int().min(1).max(240).default(30),
    /** 浏览器 profile 形态:persistent=登录态跨重启保留(缺省);ephemeral=每次全新临时 profile。 */
    profile: z.enum(["persistent", "ephemeral"]).default("persistent"),
    /** 持久 profile 目录(相对仓根;绝对路径原样用)。 */
    profileDir: z.string().default(".genie/browser-profile"),
    /** headless 缺省:Linux/其他平台无头(服务器/容器最稳),Windows/macOS 有头(人随时可看)。 */
    headless: z.boolean().default(process.platform !== "win32" && process.platform !== "darwin"),
  }).default({}),
 /** 公网检索/抓取工具:web_search 的搜索 provider 配置层——
   * 面板设置页(设置→模型设置→工具提供商)写这里;配置优先于 env(EXA_API_KEY 等旧 env 路继续兼容)。
 * provider 缺省=默认 DeepSeek(2026-10-28);取不到密钥时 web_search 自动降级为内置
   * 静态检索(DuckDuckGo HTML = curl 等价),失败再提示 agent 用 browser 工具。 */
  web: z.object({
    search: z.object({
      /** 搜索 provider:exa|perplexity|deepseek|custom(deepseek=Anthropic 兼容端点的
       * 服务端 web_search 工具,如 api-docs.deepseek.com/zh-cn/guides/search 形态)。
 * 缺省=默认 DeepSeek(2026-10-28);设置页「清除」发的空串按「未设置」处理
       * (存量 bug:空串原先被 enum 拒绝 → 清除按钮必报错)。 */
      provider: z.preprocess(emptyToUndefined, z.enum(["exa", "perplexity", "deepseek", "custom"]).optional()),
      /** API Key 的凭证引用名(值存 .genie/secrets.json,永不进配置文件);缺省
       * 默认态 DEEPSEEK_API_KEY,显式 provider 缺省 GENIE_WEB_SEARCH_KEY。 */
      apiKeyEnv: z.preprocess(emptyToUndefined, z.string().min(1).max(64).optional()),
      /** custom 端点(或覆盖默认端点);model=perplexity/deepseek 的模型名覆盖。 */
      endpoint: z.preprocess(emptyToUndefined, z.string().min(1).max(500).optional()),
      model: z.preprocess(emptyToUndefined, z.string().min(1).max(200).optional()),
 /** 显式关闭:true=即使有密钥也不用搜索 API,web_search 直接走
       * curl(内置静态检索)/browser 兜底。provider 缺省时默认按 DeepSeek 解析。 */
      disabled: z.boolean().optional(),
    }).default({}),
  }).default({}),
 /** 本地额度(ZCode 套餐/额度卡对齐;自托管=预算而非计费):0=不设限。 */ quota: z.object({
    weeklyTokens: z.number().int().min(0).default(0),
  }).default({}),
 /** 权限模式(ZCode 输入区权限下拉对齐):对 ask 命中的全局处置,热生效。
   * ask=现状(面板在线征求,超时 fail-closed);auto=本会话自动放行不问;readonly=自动拒绝写类操作;
 * plan=只读+规划提示( /plan; 审计 C11:枚举漏 plan→UI 切 Plan 被 schema 拒,服务端从未进过 plan 模式)。 */
  permissions: z.object({
    mode: z.enum(["ask", "auto", "readonly", "plan"]).default("ask"),
 /** 权限预设(预设名 → {sandbox,approval,mode} 的唯一真源在 gateway 的 permission-presets.ts):
     * 合法性由 resolvePreset 在**启动**与**cfg.set 保存**两个入口校验(zod 层不做跨包耦合,也不给
     * .default——缺省口径由 resolveStartupPreset 统一给,避免 schema 与预设表两处各写一份缺省)。
     * custom=面板自由组合,不可覆盖表行;auto=启动缺省别名(解析为 defaultPreset)。 */
    preset: z.string().min(1).max(64).optional(),
    defaultPreset: z.string().min(1).max(64).optional(),
  }).default({}),
  /** 截图标注(2026-11):面板标注编辑器提交链的两条增强轨——小模型整理任务书(refine)
   * 与录音转写(voiceParse)。都 fail-soft:未配置/失败 → 回落模板任务书,提交照常。 */
  annotate: z.object({
    /** 是否用小模型把图注+录音整理成结构化任务书;缺省(未设置)=on。 */
    refine: z.boolean().optional(),
    /** 录音转写端点(OpenAI 兼容 chat/completions,支持 input_audio)。 */
    voiceParse: z.object({
      baseUrl: z.preprocess(emptyToUndefined, z.string().min(1).max(500).optional()),
      model: z.preprocess(emptyToUndefined, z.string().min(1).max(200).optional()),
      /** 凭证引用名(值存 .genie/secrets.json 或同名 env);缺省 GENIE_LLM_API_KEY。 */
      apiKeyEnv: z.preprocess(emptyToUndefined, z.string().min(1).max(64).optional()),
      timeoutMs: z.number().int().min(1000).max(300_000).optional(),
    }).default({}),
  }).default({}),
  agent: z.object({
 // 主 agent 单任务最大步数(上限 3000;每步=一次 LLM 调用+工具轮)。
    maxSteps: z.number().int().min(1).max(3000).default(3000),
 /** 前台子代理自动转后台阈值( ZCode autoBackgroundMs 语义):超时未完→父拿 agentId 立即返回,
     * 子代理 detach 后台继续,task_output 收割。缺省 180s;0=禁用。 */
    subagentAutoBackgroundMs: z.number().int().min(0).max(3_600_000).optional(),
 /** 绝对压缩阈值(tokens:仅当模型未声明 contextWindow 时生效(声明了→阈值=窗口×80%)。
     * 未配置且无窗口→0.8×缺省窗口(1M)=800_000,宁晚不早。旧默认 24_000 是「动不动压缩」的
     * 阈值根因,已废为不内置。env GENIE_COMPACT_THRESHOLD_TOKENS 经 loadConfig 并入本字段。 */
    compactThresholdTokens: z.number().int().min(1000).max(10_000_000).optional(),
 /**  压缩后文件正文补回:真压缩后按 readAt 重读最近 N 个已读文件补回正文。
     * enabled 缺省 true(旧配置无此字段=启用);maxFiles 3-8 缺省 5;单文件/总量 token 上限缺省 5k/50k。 */
    compactRehydrate: z.object({
      enabled: z.boolean().optional(),
      maxFiles: z.number().int().min(3).max(8).optional(),
      maxFileTokens: z.number().int().min(100).max(200_000).optional(),
      maxTotalTokens: z.number().int().min(500).max(1_000_000).optional(),
    }).optional(),
    /** 子代理默认时间盒(分钟):spawn_subagent 未显式传 deadlineMin 时的缺省时限。
     * 到点 harness 强制收割——子 loop 收中止信号,已有产出打包为**部分结果**交付主 agent
     * (收割不是 fail,finalText 显式标注)。缺省(未配置)=不限时,仅给「建议时限」提示。
 * 狗food 验证:152min 无一交卷,提示词时间盒被模型无视——时间盒必须机制强制。 */
    subagentDeadlineMin: z.number().min(0).max(1440).optional(),
    /** planner 专属缺省时间盒(分钟):未显式传 deadlineMin、且全局 subagentDeadlineMin 未配置时生效。
     * 未配置=8(规划任务勘探/落板/step.md 的合理上限;到点收割部分结果,防止单个 planner 长期
     * 占住全局并发槽导致大批任务排队);显式 0=planner 也不限时。 */
    plannerDeadlineMin: z.number().min(0).max(1440).optional(),
    /** 子代理无产出预警(分钟):超过该时长无任何新工具调用 → output.txt 写 [warn] 行 +
     * task_output 结果带 stale 标记(主 agent 可决策止损重派)。缺省 20。 */
    subagentStaleWarnMin: z.number().min(0.01).max(1440).optional(),
 /** plan-gate 规划强制闸( planner 流程代码级强制,不再只靠提示词):
     * hard(缺省)=本任务无白板时,派发写角色子代理与主 agent 直写文件均被工具层拦截(指路 planner);
     * soft=只 journal 提醒不拦;off=关闭。 */
    planGate: z.enum(["hard", "soft", "off"]).optional(),
 /** 写前持久化屏障:off=完全不调 journal.flushStrict(基础设施/测试逃生);
     *  hard(缺省)=工具执行/LLM 请求前 fail-closed。env GENIE_WRITE_BARRIER 优先于本字段。 */
    writeBarrier: z.enum(["off", "hard"]).optional(),
 /** 全链路变更收尾审计(第二批):surface 类任务在最终 answer 前的处置。
     * hard=必须有 passed 且带验收证据(E2E/负面断言)的 change.audit、且无 warning 级语义孤儿,
     * 否则先补跑一轮审计;仍不满足 → 任务置 failed(journal change.audit.hard-fail),代码改动不回滚。
     * warn(缺省)=回执警告 + 验收摘要标记,不硬杀;off=完全跳过。
     * env GENIE_CHANGE_AUDIT 优先于本字段。 */
    changeAudit: z.enum(["hard", "warn", "off"]).optional(),
 /** 任务级验证账本:收尾时核对「最后一次成功验证之后是否又改过代码」。
     * off=不检查;warn(缺省)=收尾在回执追加可见提示(不拦任务);hard=先补跑一轮(要求先跑验证命令),
     * 仍 stale → 任务置 failed(journal verify.ledger.hard-fail),代码改动不回滚。
     * 只对代码文件写入计数;`.md/.mdx/.txt/.rst` 文档改动不与验证挂钩(抑制提示)。
     * env GENIE_VERIFY_ON_STOP 优先于本字段。 */
    verifyOnStop: z.enum(["off", "warn", "hard"]).optional(),
 /** 研究引用账本收尾审计:正文 [n] 必须在 cite_source 登记表里。
     * off=不检查;warn(缺省,代码内回退值)=回执追加警告;hard=先补跑一轮,仍缺 → failed。
     * 此前只在 agent-wiring 用 as cast 读,配置写了会被 schema 剥离 → 本字段补齐配置面。
     * env GENIE_CITATION_AUDIT 优先于本字段。 */
    citationAudit: z.enum(["off", "warn", "hard"]).optional(),
 /** 完成审计记分卡(,2026-11):收尾聚合 board P0 / 验证账本 / 交付物 / 变更审计 / 引用账本。
     * off=跳过;warn(缺省,代码内回退值)=有 fail/warn 时正文追加;hard=先补跑一轮,仍不满足 → failed。
     * env GENIE_COMPLETION_AUDIT 优先于本字段。 */
    completionAudit: z.enum(["off", "warn", "hard"]).optional(),
 /** todo_write 并行进行中策略:false(缺省)=同一时刻只允许一个 in_progress,多个时
     * 工具显式失败(进度失真);true=允许并行 in_progress。 */
    todoAllowParallelInProgress: z.boolean().optional(),
 /** 会话 worker 进程化(设计参考 ZCode(致谢):一会话一进程,gateway 只做聚合):
     * true(缺省)=每个 running 任务 fork 独立 session-worker 进程跑 agent loop(重活不落
     * gateway 事件循环,会话间进程隔离);false=进程内(旧路径,全部现有测试走的形态)。
     * env GENIE_SESSION_WORKER=off 强制关;测试环境(VITEST)自动回进程内。 */
    sessionWorker: z.boolean().optional(),
 /** 开工前置门:基线新鲜度校验(,2026-11)。开工第一轮前量「本地分支 vs 上游」:
     * behind(上游独有提交)>0 且 blockOnBehind(缺省 true)→ 任务 failed 并给出 git pull --rebase
     * 修复命令(不在旧基线上开工);diverged/ahead 只注入提示不拦。
     * env:GENIE_FRESHNESS=off 全局关;GENIE_FRESHNESS_BLOCK=off 把 behind 降级为警告。 */
    startupFreshness: z.object({
      enabled: z.boolean().optional(),
      blockOnBehind: z.boolean().optional(),
      maxAheadCommits: z.number().int().min(1).max(10000).optional(),
      fetch: z.boolean().optional(),
      timeoutMs: z.number().int().min(500).max(120_000).optional(),
    }).optional(),
  }).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

/** cfg.set 可热应用的字段(改完即时生效,无需重启);其余写入文件并标注 needsRestart。
 * 模型名/超时/maxTokens 全热(provider.update);结构性字段(端点/凭证引用/并发)冷。 */
export const HOT_CONFIG_PATHS = new Set([
  "coding.llm.model", "coding.llm.timeoutMs", "coding.llm.maxTokens", "coding.llm.reasoningEffort", "coding.llm.contextWindow",
  "coding.llm.implementationEffort",
  "coding.vlm.model", "coding.vlm.timeoutMs", "coding.vlm.maxTokens",
  "coding.models.compact.model", "coding.models.compact.timeoutMs", "coding.models.compact.maxTokens",
  "coding.models.compact.reasoningEffort",
  "coding.models.review.model", "coding.models.review.timeoutMs", "coding.models.review.maxTokens",
  "coding.models.review.reasoningEffort",
  "coding.models.subagent.model", "coding.models.subagent.timeoutMs", "coding.models.subagent.maxTokens",
  "coding.models.subagent.reasoningEffort",
  "coding.models.digest.model", "coding.models.digest.timeoutMs", "coding.models.digest.maxTokens",
  "coding.models.digest.reasoningEffort",
  // 语音任务书角色:服务端每次 voice.draft 请求现读 live config(无 provider 实例),模型/超时恒热。
  "coding.models.voice.model", "coding.models.voice.timeoutMs", "coding.models.voice.maxTokens",
  "coding.disabledModels",
  "audio.chat.model", "audio.chat.timeoutMs", "audio.chat.maxTokens", "audio.chat.contextWindow", "audio.chat.reasoningEffort",
  "audio.tts.voice", "audio.tts.model",
  "permissions.mode",
 // 权限预设:preset 变更=原子 apply(差异旋钮一次落地),defaultPreset 只影响下次启动口径。
  "permissions.preset", "permissions.defaultPreset",
  "browser.enabled", "browser.allowDomains", "browser.idleMinutes", "browser.profile", "browser.profileDir", "browser.headless",
  "quota.weeklyTokens",
 // web.search:设置页写入即对下一次 web_search 生效(工具每查询现读配置)。
  "web.search.provider", "web.search.apiKeyEnv", "web.search.endpoint", "web.search.model",
  "web.search.disabled",
  // annotate(2026-11):标注提交链的整理/转写开关,下一次 annotate.submit 现读生效。
  "annotate.refine", "annotate.voiceParse.baseUrl", "annotate.voiceParse.model",
  "annotate.voiceParse.apiKeyEnv", "annotate.voiceParse.timeoutMs",
 // context.modelScoring( Phase 1):面板配置对新任务生效;运行中 loop 持启动快照。
  "context.modelScoring.mode", "context.modelScoring.providerUrl", "context.modelScoring.model",
  "context.modelScoring.apiType", "context.modelScoring.apiKeyEnv", "context.modelScoring.minConfidence",
  "context.modelScoring.maxCandidates", "context.modelScoring.scoreEverySteps", "context.modelScoring.timeoutMs",
]);

/** 旧版顶层 llm/models → coding 轨迁移(v0 配置文件兼容;一次性 preprocess,loadConfig 调用)。 */
export function migrateLegacyConfig(raw: unknown): Record<string, unknown> {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return (r ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...r };
  if ("llm" in out || "models" in out) {
    const coding = { ...((out.coding as Record<string, unknown> | undefined) ?? {}) };
    if (out.llm && !("llm" in coding)) coding.llm = out.llm;
    if (out.models && !("models" in coding)) coding.models = out.models;
    out.coding = coding;
    delete out.llm;
    delete out.models;
  }
  return out;
}
