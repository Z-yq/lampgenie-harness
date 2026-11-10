/**
 * Journal: append-only 事件日志。整个 harness 的唯一事实源。
 * 事件词汇沿用 deepseek-harness 开源项目公开的 journal 规格(致谢,Apache/MIT 生态通用做法),
 * 实现为本仓自研。设计原则:
 *  - 只增不改:事件一旦写入不可变;修正通过追加新事件。
 *  - 崩溃可重放:任意时刻的内存状态都能从日志从头重建。
 *  - 每行一个 JSON 对象(JSONL),便于流式读与 grep。
 */

/** 事件种类。一期先定义核心集;扩展只增不改。 */
export type EventKind =
  // 会话生命周期
  | "session.start"
  | "session.end"
 // 会话→项目归属绑定( ZCode session.project_id 语义移植):首次解析 owner 时写一条
  // (幂等键 session.project.bind.<sid>,只写一次),payload={projectId,source,boundAt}。
  // deriveMessages 不读(不进 LLM 上下文);重启回放/分叉复制随事件继承;owner 不可被 active 改写。
  | "session.project.bind"
  // 消息
  | "message.user"
  | "message.agent"
  | "message.system"
  // 工具
  | "tool.call"
  | "tool.result"
 // 工具结果语义 token(面板着色):read_file 成功后旁路异步落账,
  // payload={toolCallId,path,language,tokens[],truncated?};tokens=SemanticTokenFile.tokens 子集
 // ( §2.1)。纯面板渲染遥测:不入 LLM 上下文(deriveMessages 不读)、不进会话导出。
  | "tool.tokens"
  // 任务调度
  | "task.enqueue"
  // 会话消息队列持久化(重启即丢根治):每次队列变更(入队/出队/删除/抢占/发送)落一条
  // 当期全量快照,payload={sessionId, items: QueueItem[]}。回放=每会话取最后一条快照
  // (快照语义,后写覆盖前写);已出队提交过的项丢弃(idempotencyKey 前缀 queue. 的 task.*
  // 事件在场即判已提交——终态或被重启收编都算,不重排防二次执行)。
  // 环境态事件:不入 LLM 上下文(deriveMessages 走 kind 白名单,不读)、不进会话导出
  // (session-export 只映射 message.user/agent 与 tool.result)、session.fork 排除集已登记。
  | "queue.sync"
 // 项目引用纠偏(「已移除项目」残留根治):项目移除/启动 scrub 清任务的 projectId
  | "task.project.clear"
  | "todo.updated"
 // agent loop 追踪边界(dsh turn/step 对应物)
  | "turn.start"
  | "turn.end"
  | "step.start"
  | "step.end"
 // 权限闸门
  | "permission.gate"
 // code-sense 预热/注入可观测
  | "sense.preheat"
 // 任务开工全局意识注入可观测(任务必先过 code_sense)
  | "sense.orient"
  | "workflow.run.start"
  | "workflow.run.done"
  | "task.start"
  | "task.progress"
  | "task.done"
  | "task.fail"
 // 任务删除墓碑(用户用户反馈「这些删不掉」):删除此前只落内存(tasks Map),
  // journal 无删除事件 → 网关每次重启回放 task.* 快照,删掉的任务全部复活。
  // 本事件 payload={taskIds:string[];sessionId?:string};回放时先扫本事件建墓碑集,再跳过被删 id。
  | "task.deleted"
  // 压缩
  | "compact.start"
  | "compact.done"
  // 压缩失败/跳过留痕(2026-11 边界元数据轮):此前 head 为空、摘要空串两条诚实返回路径在事件流里
  // 什么都不留,前端只能靠回包 reason,看板/审计无从区分「跳过」与「失败」。
  // payload={reason,trigger};不参与 deriveMessages(不是会话真相)。
  | "compact.failed"
  | "compact.skipped"
 // 压缩事务未收尾:某次 compact.start 之后既无 compact.done 也无 compact.failed
  // (进程崩溃/被杀/异常逃逸)。payload={startSeq,startedAt,ageMs,trigger};幂等键
  // `compact-abandoned:<sessionId>:<startSeq>` 保证同一条悬空 start 只落一次。
  // deriveMessages 不读(过程遥测,不是会话真相)。
  | "compact.abandoned"
 // 上下文治理( Phase 0):读侧折叠/剪枝与增长突增留痕。
  // deriveMessages 不读(不是会话真相,只是读侧治理遥测);面板/审计按需消费。
  | "context.prune"
  | "context.growth"
 // 大结果入口闸门:工具结果进 journal **之前**被切块/摘要/落盘的留痕。
  // payload={tool,chars,tokens,chunks,keptChunks,keptChars,digestChars,policy,dumpPath?,scorer,
  //          droppedChunks,droppedChars,durationMs,dumpError?};deriveMessages 不读(不是会话真相)。
  | "context.intake"
  // 模型评分(Phase 1/2):shadow 只记录建议;active 的 keep/drop 参与剪枝。
  // payload={mode,providerUrl,model,apiType,minConfidence,effectiveKeep,effectiveDrop,
  //          candidates,decisions,error?,durationMs,step}
  // effectiveKeep/Drop = 本次按 minConfidence 复算后**真正生效**的集合大小(2026-11-04 审计:
  // T-E 36h 1271 次评分全被阈值丢弃,只看事件存在与否会误判为「已在工作」)。
  | "context.model.score"
 // 会话目标( /goal)
  | "goal.set"
 // 计划文件落盘( /plan 审批流)
  | "plan.saved"
 // 语义流程白板:agent 写板/人改板;payload=路径+摘要,正文在 .genie/boards/
  | "board.update"
  // 子 agent
  | "subagent.spawn"
  | "subagent.result"
  | "subagent.backgrounded"
 // 子代理工作区事件流:进程内子代理的 loop 事件裁剪入账(payload={agentId,kind,…原字段}),
  // 面板子代理工作区 tab 专用回放;主会话渲染过滤该 kind。
  | "subagent.event"
  // workflow 引擎
  | "review.findings"
 // 评审评论一键回注聊天窗:面板把评论编成修复指令注入会话,payload={count,files,source,taskId,targetSessionId}
  | "review.inject"
  | "automation.run"
  | "checkpoint.create"
  | "checkpoint.restore"
  | "workflow.ask"
 // 工作流板节点状态:board-workflow runner 的节点级运行态
  // (payload={wfId,boardTaskId,nodeId,state:running|done|failed,detail,ms});面板画布高亮的数据源。
  | "workflow.node"
 // 管理面
  | "hook.run"
  // companion 轨系统注入(fixC5/C6,最大权限管家):notice=任务终态通知(done/failed/cancelled,
  // payload={taskId,state,text});relay=coding 助手 ask_user 转接(payload={requestId,text})。
  // 可见性:不进 deriveMessages 白名单——companion 侧由 buildCompanionSystem 的
  // 「近期系统注入」块按 sessionId 读回注入(下一轮自动可见);环境态:session.fork 排除集语义同族。
 /** @deprecated legacy 只读:新链写 super.notice/super.relay,旧 companion.* 不再写入。 */
  | "companion.notice"
 /** @deprecated legacy 只读:见上。 */
  | "companion.relay"
 // super agent 指挥台:notice=任务状态通知(payload={taskId,state,text});
  // relay=coding 助手 ask_user 转接(payload={requestId,text})。语义/可见性同 companion.* 一族。
  | "super.notice"
  | "super.relay"
 // LLM 调用轨迹指针:全量 messages+响应落 .genie/llm-trace/ 文件,
  // journal 只记指针(payload={file,turn,step,model,ms});deriveMessages 不读,回放/导出排除。
  | "llm.trace"
 // tips 注入留痕:
  // loop 每步把 ephemeral tip 注入 LLM 请求时旁路落一条,payload={keys:string[],text:string,step,turn,
  // chars,truncated?}。**deriveMessages 白名单不读**——留痕只为面板可见/可回放,零上下文影响
  // (tip 的 ephemeral 契约不变);session.fork 排除集语义同 llm.trace。
  | "tip.injected"
 // 任务开工审计锚(会话审计增强):任务类别(初判)+ kickoff 纪律卡版本 + 组装后
  // 系统提示指纹(sha1 前 12 位+字符数)+ 关键纪律段在场标志(五阶段/plan-gate/验收四步/
  // code_sense 用法)。审「提示词是否按类加载正确」不必读 llm.trace 全文,本事件即确定性答案;
  // deriveMessages 白名单不读(零上下文影响),session.fork 排除集语义同 tip.injected。
  | "task.context"
  // 任务执行轨迹卡(J1,2026-11 token 轮):loop 每 N 步(或 phase 切换时)旁路落一条结构化轨迹,
  // payload={taskId?,step,turn,steps,calls,tools:Record<string,number>,parallelRate,errors,retries,
  // tokensSpent,phase?,subgoal}——只含计数/比率/子目标,不含任何对话正文。
  // **deriveMessages 白名单不读**(纯旁路/面板可读):轨迹是「机器在干什么」的画像,不是会话真相,
  // 进上下文纯属重复计费;面板/复盘/子代理工作区按 sessionId 读回即可。
  | "task.trajectory"
  // system 提示词快照(token 轮 P1,designs/token-opt-round3-p1 §3):会话首轮把当轮 system 全文
  // 落一条(same session same sha 只落一条,幂等由写入方保证),payload={sha,text,chars,truncated?}。
  // 角色:node0 冻结的唯一数据源——loop 取该 session **第一条**非 truncated 快照当 messages[0],
  // 系统提示后续变更改为在历史之后追加 user 消息([系统提示更新]),不再原地重写 node0(前缀缓存
  // 从 token 0 失效的根因)。**deriveMessages 白名单不读本 kind**(纯旁路记录,零上下文影响);
  // session.fork 随事件继承(分叉会话沿用源会话的 node0 冻结基线与 clone 语义一致)。
  | "system.prompt"
  // per-session 主模型覆盖切换(session.model.set 落账;payload={model,providerId?,source:"session"})。
  // 全局 cfg.set 路径不动(设置页语义保持),source 字段预留来源甄别。
  | "model.switch"
 // 板质量遥测(遥测闭环):audit 结果与骨架生成/剔除的结构化落账;deriveMessages
  // 白名单不读(非会话真相);跨会话消费(基线表/看板)→ CROSS_SESSION_KINDS 进 global.jsonl。
  | "board.audit"
  | "board.skeleton"
 // 网关终态投递义务(apps/gateway/src/delivery-obligation.ts):payload=义务全量快照,
  // 同 obligationId 后写覆盖前写(启动回放取最后一条)。deriveMessages 白名单不读(非会话真相);
  // 按会话落账(不属于跨会话 kind);session.fork 时随 task.* 同族排除(见 server.ts SESSION_FORK_EXCLUDED_KINDS)。
  | "delivery.obligation"
 // 持久效果队列(apps/gateway/src/effect-queue.ts):payload 见各事件形状;
  // 无 sessionId(落 global.jsonl),deriveMessages 白名单不读(非会话真相)。
  | "effect.enqueued"
  | "effect.replaced"
  | "effect.done"
  | "effect.failed"
  | "effect.deferred"
  | "effect.health"
  // 通用
  | "custom";

/** 一条日志事件。T 为 payload 的具体类型。 */
export interface JournalEvent<T = unknown> {
  /** 单调递增序号,由 journal 写入时分配。 */
  seq: number;
  /** 事件种类。 */
  kind: EventKind;
  /** 事件产生时间(epoch ms)。 */
  time: number;
  /** 所属会话 id。 */
  sessionId: string;
  /** 事件负载,结构由 kind 决定。 */
  payload: T;
  /** 幂等键:同一 idempotencyKey 的事件不会被重复写入。 */
  idempotencyKey?: string;
}

/** 写入事件时省略 seq/time(由 journal 分配)。 */
export type NewEvent<T = unknown> = Omit<JournalEvent<T>, "seq" | "time"> & {
  time?: number;
};

/** 事件监听器。 */
export type EventListener = (event: JournalEvent) => void;
