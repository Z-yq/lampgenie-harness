# genie-memory 方案评审
subtitle: 面向技术负责人的架构与风险评审
verdict: 有条件通过
verdict_note: 分层清晰;凭据与口径先整改
meta: genie-memory@abc123 · 2026-10-27

## 01 定位与目标
claim: 它是记忆服务,不是对话服务
### 这是什么系统
```stats
20+ | 条 HTTP 路由 | service/app.py:318
8 | 份维度配置 | dialogue_memory/dimensions/
3 | 层记忆 L2→L4 | README.md:20
```
- **服务面不小** — 30 余条路由挂在同一个 FastAPI 实例,边界集中在 service 层
- **配置驱动层级** — 8 份维度配置决定浓缩触发条件,阈值不在代码里写死
> 证据: service/app.py:318 · README.md:20

### 系统边界
```compare
做的三件事: 切分对话成 MemCell | 按维度浓缩 | 按层召回
不做的三件事: 生成回复 | 维持长连接 | 自建记忆状态
```
- **边界就是契约** — 宿主只投递消息批次并读取召回结果,对话推理完全留在调用方
- **越界的代价** — 单条接口依赖宿主维护的缓存,独立部署形态下会丢历史消息
> 证据: service/app.py:566

## 02 核心流程
claim: 两条管线各五步
### 写入链
```flow
recv: 收消息批次
decide: 判定是否写入
seg: 切段
memcell: 生成 MemCell
drop: 丢弃不入库
recv -> decide
decide -> seg: 是
decide -> drop: 否
seg -> memcell
```
- **并发闸** — 写入判定批内有界并发 4,防止历史回放一次性压垮 LLM 端点
- **失败语义** — 判定失败重试一次才抛错,单条坏数据不会中断整批消息入库
> 证据: service/ingest.py:46

### 判定与建议
```quote
有条件通过
凭据与能力口径两项需先整改
start_service.sh:9-10
```
- **通过的理由** — 写入、召回、浓缩三条链路都能指到具体函数,没有黑箱式外部依赖
- **整改节奏** — 凭据问题本周轮换止血,向量口径下个迭代统一到文档
> 证据: start_service.sh:9-10

### 死代码实证
```code
service/recall_engine.py:20-25
try:
    from . import recall_components
    RECALL_COMPONENTS_AVAILABLE = True
except ImportError:
    RECALL_COMPONENTS_AVAILABLE = False
```
- **导入不存在的包** — recall_components 目录不存在,恒走 fallback 分支
- **下游全空转** — pipeline 为空,策略名一路传到 no-op
> 证据: recall_engine.py:20-45
