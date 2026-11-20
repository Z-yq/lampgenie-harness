#!/usr/bin/env node
// provider TTL 探针(缺口#30, 件2)——**占位说明,不执行任何网络请求**。
// 为什么存在:按龄微压缩(microcompact-age.ts)的前提是「provider 按消息前缀做 prompt 缓存,
// 且缓存 TTL 覆盖闲置窗口」。这个前提只有用**真实 key 经验证**才能确认;本仓不持有生产 key,
// 所以这里只固化验证方法。验证通过后,装配方设 GENIE_PROVIDER_TTL_VERIFIED=true 放开守卫;
// 人工实验场景可用 GENIE_AGE_MICROCOMPACT_FORCE=1 越过守卫直接观察。
// 验证方法(手动执行,约 10 分钟):
// 1. 准备:同一 model、同一 system prompt、同一 tools 集、同一前 N 条消息(≥ 2000 token,
// 太短可能整个落进 provider 的免缓存短前缀);真实 API key;能看响应 usage 的客户端
// (本仓 provider 层或 curl)。
// 2. 请求 A:发出该前缀 + 一条尾部 user → 记 usage.cachedTokens(首次通常 0)与 inputTokens。
// 3. 等待间隔 T(建议 T = 按龄判定的闲置阈值 idleMs,缺省 30 分钟;可另测 5m/10m/60m 采样曲线)。
// 4. 请求 B:**逐字相同**的前缀(字节级一致,不许重排/重格式化)+ 相同尾部 user → 记 usage.cachedTokens。
// 5. 判定:cachedTokens(B) > 0 且 ≈ inputTokens(B) → TTL ≥ T,守卫可设 VERIFIED=true;
// cachedTokens(B) = 0 → TTL < T,按龄裁剪在该闲置阈值下必然全量 uncached 重算
// (uncached 单价约为命中的 50 倍),**不得**放开守卫;可缩短 idleMs 后重测。
// 6. 对照:再发一次请求 C(与 B 间隔 < 1 分钟)确认短间隔命中正常,排除「该 provider 根本
// 不做前缀缓存」的情形——C 也 miss 则问题在 provider 能力而非 TTL。
// 注意事项:
// - 判定只认 API 返回的 usage.cachedTokens,不认本地估算;
// - 部分提供方(如 Anthropic)需显式 cache_control 标记才会缓存,deepseek 系按前缀自动缓存;
// - 两请求间不得有任何写 journal/改 messages 的动作(否则测的是「前缀变了」而不是 TTL)。
// 本脚本留作后续自动化锚点:实现时在本文件补 fetch 逻辑(读 env 的 key/model/前缀样例,
// 不入库),输出 {ttlVerified, intervalMs, cachedB, inputB} 供装配方写 GENIE_PROVIDER_TTL_VERIFIED。

console.log(`[probe-provider-ttl] 占位探针:不执行网络请求(需真实 key,本仓不跑)。
验证方法:同 provider 间隔 T 分钟连发两次逐字相同前缀的请求,看第二次的 usage.cachedTokens:
  cachedTokens>0(≈inputTokens)→ TTL≥T,设 GENIE_PROVIDER_TTL_VERIFIED=true 放开按龄守卫;
  cachedTokens=0 → TTL<T,按龄裁剪会全量 uncached 重算(约 50 倍单价),不得放开守卫。
完整步骤(含请求 C 对照与注意事项)见本文件注释。人工实验可用 GENIE_AGE_MICROCOMPACT_FORCE=1 越过守卫。`);
