# 会话记录审计指南(给 agent:如何根据 journal+trace 判断流程与提示词是否正确)

> 2026-10-24 起,7700 的每次任务在 journal 与 llm-trace 里留有**确定性审计锚**。本页是字段地图与审计方法——不需要读源码,按这里的路径即可回答「流程对不对、提示词加载对不对、有没有冗余注入、token 花在哪」。

## 记录布局

| 位置 | 内容 | 说明 |
|---|---|---|
| `.genie/journals/sessions/<sessionId>.jsonl` | 会话肥事件:message.*、tool.call/result、step.*、turn.*、llm.trace 指针、tip.injected、task.context、task.phase、permission.gate、todo.updated、subagent.event、compact.* | 每会话一文件;journal 分文件路由(跨会话小 kind 进 global) |
| `.genie/journals/global.jsonl` | 跨会话事件:task.*、subagent.spawn/result、goal.set、custom(task.class 等)、board.update | **task.class 的 heuristic/agent 双源记录在这里**——按 sessionId 过滤并入读 |
| `.genie/journals/gateway.jsonl` | 旧版单文件(2026-10-22 前历史,冻结只读) | 只在考古旧会话时用 |
| `.genie/llm-trace/<sessionId>/call-XXXX-tN sM-<ts>.json` | 每次 LLM 调用**全文**:全量 request messages(含 system、注入提醒原文)、工具 schema、响应全文、usage、reminders 普查 | 「模型到底看到了什么」的唯一真相源 |
| `.genie/logs/gateway.log.<ts>` | 网关 stdout(启动/清算/警告;`GENIE_WORKER_JOURNAL_DEBUG=1` 时含 worker 上行 kind 摘要) | 排 transport 类丢失 |

## 审计问答(按问题查)

### 1. 提示词是否按任务类别加载正确?
读会话的 **`task.context`** 事件(开工即落,一条定案):
```json
{"kind":"task.context","payload":{"taskClass":"office","card":"office 版","systemSha":"a1b2…","systemChars":8421,
 "flags":{"fivePhase":false,"planGate":false,"verify4":false,"senseUsage":false}}}
```
- `taskClass`+`card`:类别与纪律卡版本;qa/office 应为 `fivePhase/planGate/verify4=false`,coding 全 true
- `systemSha/systemChars`:组装后系统提示指纹——两任务同类同配置应同 sha;不同即提示词组装有变量
- 类别更正链:再读 `global.jsonl` 里该会话的 `task.class` 事件(`source: heuristic→agent` 双源)

### 2. 模型每步实际收到了哪些注入(有无冗余复读)?
每条 `llm.trace` 事件带 **`reminders`** 普查数组:`["tips:dispatch","readlist","board"]`。
- 冗余判据:同一 reminder 名连续出现在大量调用的数组里=复读(2026-10-24 后已读清单已改「变化触发+每10步」,正常应只在变化步出现)
- tips 原文:读同会话 `tip.injected` 事件(keys+text)
- 全文核对:trace 文件 `request.messages` 里 `<system-reminder>` 块逐字可见

### 3. 流程是否走了该走的门?
- 阶段序列:会话文件 `task.phase` 事件(phase/skip 序列;qa/office 类应无或极少)
- plan-gate:`plan.gate` / `permission.gate` 事件(effect: denied/board-present/soft-warn;denied 连发=模型卡门)
- 收尾:`plan.gate effect=p0-open-at-done` 警示=P0 未全绿即宣称完成的拦截留痕

### 4. token 花在哪?
逐条 `llm.trace` 的 `usage`(inputTokens/outputTokens)累加=任务总消耗;`messageRoles` 长度=上下文膨胀斜率;单次 input 突增对照该次 trace 的 `request.messages` 找膨胀源(通常是长工具结果,查 microcompact 配置)。

### 5. 子代理干了什么?
会话文件 `subagent.spawn/result` + `subagent.event`(工具调用流);子代理 LLM 全文在 `.genie/llm-trace/subagent-<taskId>/`;任务书原文在 spawn 事件。

## 已知路由细节(避免误判「丢事件」)
- `task.class`/`custom`/`task.*` 在 **global.jsonl**(不在会话文件)——分析必须并读两处
- `tip.injected`/`task.context`/`llm.trace` 是旁路留痕,**不进模型上下文**(deriveMessages 白名单不读)
- session-worker 模式(每任务一进程)下事件经 ProxyJournal 批量上行到网关落账;worker 上行可观测:`GENIE_WORKER_JOURNAL_DEBUG=1` 时网关日志打印每批 kind 摘要——排查「事件在 worker 发了但 journal 没有」开此开关复现
