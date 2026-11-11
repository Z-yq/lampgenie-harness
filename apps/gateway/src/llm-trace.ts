/**
 * LLM 调用轨迹落盘(glm-5.3-flash 会话「不知道在干什么,
 * 每次调用的 message 和 output 都要记录方便 debug」)。此前 journal 只有 message.agent 摘要
 * (text+toolCalls)——请求侧喂了什么(system/历史/注入提醒)、原始响应、模型档全不可见,
 * 弱模型会话排障只能靠行为倒推。
 * 形态:每次 chat 一文件 <baseDir>/<sessionId>/call-<seq>-t<turn>s<step>.json,内容=「怎么送给
 * LLM 服务的就怎么记」——全量请求 messages+**工具完整规格 schema**+provider 参数面
 * (baseUrl/apiType/maxTokens/reasoningEffort/timeoutMs,复现 wire 请求的全部输入;apiKey 永不落)+
 * 响应全文(content/toolCalls/usage/reasoning)+model/耗时/TTFT;journal 追加 llm.trace 指针事件
 * (file+meta,不带 payload)——journal 不膨胀,全文在文件,两者按 sessionId+turn+step 对齐。
 * 子代理 loop 配 MemoryJournal 时指针事件是 no-op,但文件照落(sessionId=subagent-<taskId>
 * 自成目录,ls 可发现);子代理的每步行动(工具调用与结果)随 messages 历史全量在场。
 * 旁路纪律:写失败静默(轨迹绝不打断主链);messages 里无凭证(请求体同 dumpRequestBody 口径,
 * apiKey 只在 headers 永不落盘)。
 */
import { constants as fsConstants, promises as fsp } from "node:fs";
import { dirname, join } from "node:path";
import { redactText, type Journal } from "@lampgenie/core";
import type { LlmCallTrace } from "@lampgenie/runtime/agent/loop";
// token 口径统一见 agent/token-estimate.ts(真分词器 + 标定 ratio;本文件不再自带字符系数)。
import { rawTokens, calibrate, calibrationOf } from "@lampgenie/runtime/agent/token-estimate";
import { repoRoot } from "./repo-root.js";
import { TRACE_FILE_RE, pruneLlmTrace } from "./llm-trace-retention.js";
import { miningWindowStart, migratePathFor, retentionVerdict } from "./trace-retention-policy.js";
import { loadEvidenceGraph } from "./evidence-graph-store.js";
// 前缀算法复用 panel-traj-model(已实现 msgKeyOf/commonPrefixLen),不重写。
import { commonPrefixLen } from "./panel-traj-model.js";

/**
 * 轨迹落盘脱敏(轨迹追踪 P1-B 接线):messages 里**天然夹带明文**——工具结果正文回显了
 * `curl -H "Authorization: Bearer sk-…"`、用户贴进对话的 key、`.env` 的 cat 输出。journal 侧
 * 已在 journal.ts 的 append 里过 `redactEventPayload`,轨迹文件是同一份明文的另一条落地路径,
 * 不脱敏等于把 journal 的门只关了一半。递归走 string(消息 content 可能是 string 或 parts 数组、
 * 工具入参是 JSON 字符串),`GENIE_JOURNAL_REDACT=0` 时 `redactText` 原样返回(全关)。
 */
function redactDeep<T>(v: T): T {
  if (typeof v === "string") return redactText(v as unknown as string) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => redactDeep(x)) as unknown as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = redactDeep(val);
    return out as unknown as T;
  }
  return v;
}

/**
 * prune 节流常量(轨迹追踪 P1 接线。
 * 为什么不是每次写完都 prune:`pruneLlmTrace` 要 `readdir` 全树 + 每个 `call-*.json` 一次
 * `stat`(会话几百个目录 × 几百个文件 = 上万次 syscall;.genie 常落在 9p 上,单次 stat 是
 * 毫秒级)→ 每次 LLM 调用都跑会把旁路成本变成主链成本。双条件「写满 N 次」**或**「距上次
 * ≥10 分钟」:高频会话靠计数收敛(每 50 次调用扫一次),低频会话靠时间兜底(一天只调几次也
 * 会定期清一次),任一满足即跑。
 */
const PRUNE_EVERY_N_WRITES = 50;
const PRUNE_MIN_INTERVAL_MS = 10 * 60 * 1000;
/** 模块级写入计数(所有 sink 实例共享,sink 每会话/每子代理新建,计数放实例里等于永不触发)。 */
let writesSincePrune = 0;
let lastPruneAt = 0;

/** 挖掘窗口天数(env 缺省 7;配坏 → 回落缺省,不让笔误把窗口保护整块关掉)。 */
function miningWindowDays(): number | undefined {
  const raw = process.env?.GENIE_LLM_TRACE_MINING_WINDOW_DAYS;
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * 证据图谱里出现过的 sessionId(去重)——这些会话的轨迹是审计回溯的原始现场,必须钉扎。
 * 读不到证据图(fail-soft):返回空集 + 一行 warning;本轮窗口保护照常生效,只是识别不出
 * 「被谁引用」,不静默、也不因此放弃清理(证据图缺失≠全部钉扎,那会让清理永久停摆)。
 */
export function collectEvidenceSessions(root: string = repoRoot()): Set<string> {
  const out = new Set<string>();
  try {
    const { graph } = loadEvidenceGraph(root);
    const nodes: Record<string, { source?: { sessionId?: string } }> =
      (graph as unknown as { nodes?: Record<string, { source?: { sessionId?: string } }> } | undefined)?.nodes ?? {};
    for (const node of Object.values(nodes)) {
      const sid = node?.source?.sessionId;
      if (typeof sid === "string" && sid.trim() !== "") out.add(sid);
    }
  } catch (e) {
    console.warn(`[llm-trace] 证据图谱不可读,本轮仅按挖掘窗口钉扎:${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
  return out;
}

/** 迁移单文件上限:证据区不是备份盘,超大轨迹搬过去只会把磁盘问题复制一份。 */
const MIGRATE_MAX_FILE_BYTES = 50 * 1024 * 1024;

/**
 * 把「被证据引用的轨迹」复制一份到证据区 `<root>/.genie/evidence/traces/<session>/<file>`。
 * 纪律:
 * - 只复制,不动原文件:原处仍被 pin(删不删由人决定),迁移只是让证据区自带现场;
 * - 已存在跳过(COPYFILE_EXCL,幂等)+ 单文件 >50MB 跳过;
 * - 单文件失败只计数不抛:迁移失败仍 pin,文件留在原处——绝不因为搬不动就删。
 */
export async function migrateEvidenceTraces(opts: {
  traceRoot: string;
  evidenceRoot: string;
  sessions: ReadonlySet<string>;
  maxBytes?: number;
}): Promise<{ migrated: number; skipped: number; failed: number }> {
  const { traceRoot, evidenceRoot, sessions } = opts;
  const maxBytes = Number.isFinite(opts.maxBytes) ? Number(opts.maxBytes) : MIGRATE_MAX_FILE_BYTES;
  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  if (!sessions || sessions.size === 0) return { migrated, skipped, failed };
  let dirs: string[] = [];
  try {
    dirs = await fsp.readdir(traceRoot);
  } catch {
    return { migrated, skipped, failed }; // 轨迹目录不可读:迁移是旁路,静默
  }
  for (const sessionId of dirs) {
    if (!sessions.has(sessionId)) continue;
    const sessionDir = join(traceRoot, sessionId);
    let files: string[] = [];
    try {
      files = await fsp.readdir(sessionDir);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!TRACE_FILE_RE.test(name)) continue;
      const src = join(sessionDir, name);
      const dst = migratePathFor(evidenceRoot, sessionId, name);
      try {
        const st = await fsp.stat(src);
        if (!st.isFile()) continue;
        if (st.size > maxBytes) {
          skipped++;
          continue;
        }
        await fsp.mkdir(dirname(dst), { recursive: true });
        await fsp.copyFile(src, dst, fsConstants.COPYFILE_EXCL);
        migrated++;
      } catch (e) {
        if ((e as { code?: string })?.code === "EEXIST") {
          skipped++; // 已迁移过:幂等
          continue;
        }
        failed++; // 单文件失败不阻塞整轮
      }
    }
  }
  return { migrated, skipped, failed };
}

/** 一轮完整清理:证据图 → 窗口 → 迁移 → prune(全在旁路异步链里,异常由调用方 catch)。 */
async function runPrune(root: string, protectPath: string): Promise<void> {
  const now = Date.now();
  const windowStart = miningWindowStart({ now, days: miningWindowDays() });
  const evidenceRoot = repoRoot();
  const evidenceSessions = collectEvidenceSessions(evidenceRoot);
 // 迁移先于 prune:被引用的现场要先在证据区有副本,否则删/留都只有原处一份。
  const mig = await migrateEvidenceTraces({ traceRoot: root, evidenceRoot, sessions: evidenceSessions });
  if (mig.failed > 0) {
    console.warn(`[llm-trace] 证据区迁移失败 ${mig.failed} 份(文件仍被钉扎,留在原处)`);
  }
  await pruneLlmTrace(root, {
    protectPath,
 // pin 闭包:证据引用优先于挖掘窗口(窗口外的被引用轨迹同样不删)。
    shouldPin: (f) => {
      const v = retentionVerdict({ sessionId: f.sessionId, epoch: f.epoch, now, windowStart, evidenceSessions });
      return { pin: v.pin, reason: v.reason };
    },
    onPinStats: (s) => {
      if (s.pinnedOverBudget) {
        console.warn(`[llm-trace] 钉扎 ${s.pinned} 份轨迹自身已超总量上限,按证据/窗口纪律保留未删`);
      }
    },
  });
}

/**
 * 触发一次旁路 prune(不 await、不抛)。返回是否真的发起了。
 * - `GENIE_LLM_TRACE_KEEP_PER_SESSION=0` = 关闭清理(直接 return,连目录都不扫)。
 * - 异步旁路:`void ...catch(()=>{})`——轨迹清理是优化不是主链,失败静默(见 catch 注释)。
 */
function maybePrune(root: string, protectPath: string): void {
  if (process.env?.GENIE_LLM_TRACE_KEEP_PER_SESSION === "0") return; // 显式关闭:不扫不删
  writesSincePrune++;
  const now = Date.now();
  const enoughWrites = writesSincePrune >= PRUNE_EVERY_N_WRITES;
  // 首次(lastPruneAt=0)只认计数:启动瞬间扫全树没必要,等攒够 N 次再说。
  const enoughTime = lastPruneAt !== 0 && now - lastPruneAt >= PRUNE_MIN_INTERVAL_MS;
  if (!enoughWrites && !enoughTime) return;
  writesSincePrune = 0;
  lastPruneAt = now;
  // 绝不 await:prune 可能扫上万文件,await 会把清理成本挂到 LLM 调用尾上。
  // catch 静默:清理是旁路优化——目录不存在/权限/占用都不该让主链(更不该让用户)看见;
 // 证据图/迁移失败已在 runPrune 内各自 warn 一次,这里只挡意外异常。
  void runPrune(root, protectPath).catch(() => { /* 旁路优化:清理失败无害,静默 */ });
}

// ===================== 本地估算 + 前缀缓存估算 + 用量异常标记 =====================
/**
 * 为什么需要本地估算:provider 上报的 usage 不可全信——经验证有会话报
 * `input 111976 / cached 110848`,下一步只追加一条小工具回执却报 `input 166159 / cached 150528`
 * (增量 54283 ≫ 实际新增内容),「缓存命中」甚至超过上一步的整个 input。没有本地独立口径就无法
 * 判定「上报值是不是假的」,于是统计/成本/命中率全跟着漂。这里给一个**离线可算**的估算:
 * 与 wire 请求同源(messages+tools),不依赖 provider,用来做上报值的对照基准与异常标记。
 * 口径纪律:是**量级估算**,不是计费口径(与 panel-traj-model.approxTokens 同源思路)——
 * 非 ASCII 码点各 1 tok(中文/emoji 一字≈1 tok),其余 4 字符 1 tok;累加完 Math.ceil。
 * 空输入=0(不返回 NaN/负数),永不对调用方抛(估算失败不打断主链)。
 */
function safeJsonOf(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? "" : s;
  } catch {
    return ""; // 循环引用/不可序列化:当作无内容,估算退化为偏小(异常标记侧有 0.6 下限兜底)
  }
}

/** 单条消息的估算文本:role + content(非字符串 JSON 化)+ toolCalls(JSON)+ toolCallId。 */
function messageTextOf(m: unknown): string {
  const o = m && typeof m === "object" ? (m as Record<string, unknown>) : {};
  const c = o.content;
  const cs = typeof c === "string" ? c : c === undefined || c === null ? "" : safeJsonOf(c);
  const tc = o.toolCalls === undefined || o.toolCalls === null ? "" : safeJsonOf(o.toolCalls);
  const id = typeof o.toolCallId === "string" ? o.toolCallId : "";
  return (typeof o.role === "string" ? o.role : "") + cs + tc + id;
}

/** 工具面文本:每个 tool 的 name + description + parameters schema JSON。 */
function toolTextOf(tools: unknown): string {
  if (!Array.isArray(tools)) return "";
  let s = "";
  for (const t of tools) {
    const o = t && typeof t === "object" ? (t as Record<string, unknown>) : {};
    s += (typeof o.name === "string" ? o.name : "") + (typeof o.description === "string" ? o.description : "");
    s += o.parameters === undefined || o.parameters === null ? "" : safeJsonOf(o.parameters);
  }
  return s;
}

/** 本地估算本次请求的输入 token 量级(空输入=0;不返回 NaN/负数)。
 *  token 口径统一见 agent/token-estimate.ts(rawTokens = cl100k 真分词计数;不可用时 CJK 回退)。 */
export function estimateInputTokens(messages: unknown, tools?: unknown): number {
  try {
    const msgs = Array.isArray(messages) ? messages : [];
    let raw = 0;
    for (const m of msgs) raw += rawTokens(messageTextOf(m));
    raw += rawTokens(toolTextOf(tools));
    const out = Math.ceil(raw);
    return Number.isFinite(out) && out > 0 ? out : 0;
  } catch {
    return 0;
  }
}

/**
 * 前缀缓存命中部分的估算(provider 的 prompt caching 只对**连续公共前缀**计费打折;
 * 逐字比较走 panel-traj-model.commonPrefixLen,不在这里重写算法)。
 * - 无 prev / prev 为空 → 0(首调没有可复用前缀);
 * - 命中条数内按 estimateInputTokens 同口径累加 token;
 * - 工具面**完全相同**才算命中(工具 schema 变了,provider 侧缓存前缀同样断掉)。
 */
export function estimateCachedInputTokens(
  prev: { messages?: unknown; tools?: unknown } | undefined,
  cur: { messages?: unknown; tools?: unknown },
): number {
  try {
    const prevMsgs = prev && Array.isArray(prev.messages) ? (prev.messages as unknown[]) : [];
    const curMsgs = cur && Array.isArray(cur.messages) ? (cur.messages as unknown[]) : [];
    if (!prevMsgs.length || !curMsgs.length) return 0;
    const hit = commonPrefixLen(prevMsgs, curMsgs);
    if (hit <= 0) return 0;
    let raw = 0;
    for (let i = 0; i < hit; i++) raw += rawTokens(messageTextOf(curMsgs[i]));
    if (safeJsonOf(prev?.tools) === safeJsonOf(cur?.tools)) raw += rawTokens(toolTextOf(cur?.tools));
    const out = Math.ceil(raw);
    return Number.isFinite(out) && out > 0 ? out : 0;
  } catch {
    return 0;
  }
}

/**
 * per-session 上一请求基准(sink 每会话/每子代理新建,状态放实例里等于每次都是首调 →
 * 必须模块级共享;容量 64 兜住「一个网关进程活很多会话」的常驻内存)。
 * 只存估算所需的最小面(messages/tools)+ 上报 input(判「cached > 上一步 input」用),
 * 不存响应全文;命中要刷新到末尾(真 LRU:活跃会话不被低频会话挤出)。
 */
type PrefixCacheEntry = { messages: unknown; tools: unknown; reportedInput: number };
const PREFIX_CACHE_CAP = 64;
const prefixCache = new Map<string, PrefixCacheEntry>();

function prefixCacheGet(sessionId: string): PrefixCacheEntry | undefined {
  const hit = prefixCache.get(sessionId);
  if (!hit) return undefined;
  prefixCache.delete(sessionId); // 读命中刷新到末尾(最近使用)
  prefixCache.set(sessionId, hit);
  return hit;
}

function prefixCacheSet(sessionId: string, entry: PrefixCacheEntry): void {
  prefixCache.delete(sessionId);
  prefixCache.set(sessionId, entry);
  while (prefixCache.size > PREFIX_CACHE_CAP) {
    const oldest = prefixCache.keys().next().value;
    if (oldest === undefined) break;
    prefixCache.delete(oldest);
  }
}

function finiteOf(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 上报 usage 的可疑判据(任一命中即标记;缺值/0 的判据不参与,避免「provider 不报 cached」
 * 被误判成异常)。返回一句中文可读原因(带具体数字),正常时 undefined。
 * - 上报 input 远超/远低于本地估算(>1.25 倍 / <0.6 倍):口径漂移或串号;
 * - 上报 cached > 上一步的整个 input:缓存命中不可能超过上一次请求的全部输入(注意造假/串会话);
 * - 上报 cached > 本次估算的 1.1 倍:命中量超过本请求全部内容。
 */
function usageAnomalyOf(a: {
  est: number;
  reportedInput: number;
  reportedCached: number;
  prevInput: number;
}): string | undefined {
  const reasons: string[] = [];
  const { est, reportedInput: ri, reportedCached: rc, prevInput } = a;
  if (ri > 0) {
    if (est > 0) {
      if (ri > est * 1.25) reasons.push(`上报 input ${ri} 为本地估算 ${est} 的 ${(ri / est).toFixed(1)} 倍`);
      else if (ri < est * 0.6) reasons.push(`上报 input ${ri} 仅本地估算 ${est} 的 ${(ri / est).toFixed(1)} 倍`);
    } else {
      reasons.push(`上报 input ${ri} 而本地估算为 0`);
    }
  }
  if (rc > 0) {
    if (prevInput > 0 && rc > prevInput) reasons.push(`上报 cached ${rc} > 上一步 input ${prevInput}`);
    if (est > 0 && rc > est * 1.1) reasons.push(`上报 cached ${rc} 超过本次估算 ${est} 的 1.1 倍`);
  }
  return reasons.length ? reasons.join(";") : undefined;
}

// ===================== 指针事件入账(2026-11 修「文件在、事件永久缺失」) =====================
/**
 * 病灶:此前只在文件写成功后 `journal.append({kind:"llm.trace"})`,append 抛错被外层 try 静默吞掉
 * → 轨迹文件落在盘上、journal 里却没有指针事件,事件永久缺失且无人知道(经验证本会话 23 个 call
 * 文件只有 21 条 llm.trace)。
 * 修法:一次入账 = 一次同步 append,失败**立即重试一次**;仍失败则异步把一行 JSON 追加到 drop 日志
 * (旁路诊断,不抛不 await)。不变量不变:先写文件、再发指针;任何失败都不得让主链抛错。
 * 幂等:**以 file 路径为键**,同一 file 在进程内只成功入账一次。键在**首次 append 之前**就占用
 * (claim)——因为 append 可能「先落地再抛错」,若等成功后再记账,重试就会双写。
 */
const claimedTraceFiles = new Set<string>();

/** drop 日志默认路径:与轨迹根并列,即 `<.genie>/logs/llm-trace-drop.log`
 *  (trace root = <.genie>/llm-trace → dirname = <.genie>)。 */
function defaultDropLogPath(root: string): string {
  return join(dirname(root), "logs", "llm-trace-drop.log");
}

function appendTraceEvent(
  journal: Journal,
  event: { kind: "llm.trace"; sessionId: string; payload: Record<string, unknown> },
  meta: { file: string; sessionId: string; turn: number; step: number; dropLogPath: string },
): void {
  if (claimedTraceFiles.has(meta.file)) return; // 本 file 已入账(或在重试中)——不双写
  claimedTraceFiles.add(meta.file);
  try {
    journal.append(event as never);
    return;
  } catch (e1) {
    // 重试一次(同一次调用内的幂等重试:键已占,不会产生第二条)。
    try {
      journal.append(event as never);
      return;
    } catch (e2) {
      // 两投两失:指针事件按「已丢失」处理,落一行 drop 诊断(文件在盘上仍可人工发现)。
      const line = JSON.stringify({
        ts: Date.now(),
        sessionId: meta.sessionId,
        turn: meta.turn,
        step: meta.step,
        file: meta.file,
        error: String(e2 ?? e1).slice(0, 300),
      }) + "\n";
      void fsp.mkdir(dirname(meta.dropLogPath), { recursive: true })
        .then(() => fsp.appendFile(meta.dropLogPath, line, "utf-8"))
        .catch(() => { /* 诊断旁路:drop 日志也写不进就算了,绝不打断主链 */ });
    }
  }
}

/**
 * (2026-11 usage-envelope):取 loop 回调带过来的请求信封指纹(16 hex sha256 前缀)。
 * runtime 的 LlmCallTrace 类型尚未声明该字段(loop 以 `...envKey` spread 传入),这里按运行期值
 * 取用;非 string / 非 16 hex 一律视为缺失——旧 journal 的 payload 形状逐字不变。
 */
function envelopeOf(info: LlmCallTrace): string | undefined {
  const v = (info as LlmCallTrace & { envelope?: unknown }).envelope;
  return typeof v === "string" && /^[0-9a-f]{16}$/.test(v) ? v : undefined;
}

/** 构造轨迹 sink。
 *  @param dropLogPath 指针事件彻底丢失时的 drop 日志路径;缺省先读 env `GENIE_LLM_TRACE_DROP_LOG`
 *    (测试注入 tmpdir 用),再缺省 `<.genie>/logs/llm-trace-drop.log`。 */
export function makeLlmTraceSink(journal: Journal, baseDir?: string, dropLogPath?: string): (info: LlmCallTrace) => void {
  const root = baseDir ?? join(repoRoot(), ".genie", "llm-trace");
  const dropLog = dropLogPath || process.env?.GENIE_LLM_TRACE_DROP_LOG || defaultDropLogPath(root);
  const seqByDir = new Map<string, number>();
  return (info) => {
 // 同步段只做 CPU 工作(提醒扫描+stringify);**落盘异步**(冻结注意:writeFileSync
    // 把全量请求体(几十 KB~数 MB)同步写 9p,停顿时 worker 事件循环冻在半截文件上 196s 被收割
    // ——.genie/llm-trace/.../call-0005-t2s4.json 76KB 半截即物证)。fire-and-forget:轨迹是
    // 旁路,乱序/迟到无害;指针事件(journal llm.trace)在文件写完后才发——「指针在⇒文件在」
    // 的不变量保持。
    try {
 // 本地估算+前缀命中估算+上报值异常标记。**只做 CPU**(与提醒扫描/stringify 同一
      // 同步段纪律):估算 = 遍历 messages 数码点,几十 KB 级别是微秒量级;绝不能在这里新增 await。
      // 顺序:先取 baseline(上一请求)再写本次缓存——先写会把「上一步」变成自己,前缀命中恒等于全量。
      // token 口径统一见 agent/token-estimate.ts:本地估算走 rawTokens(cl100k 真分词),
      // 再用本 provider 的历史标定 ratio 换成「标定后估算」;ratio 恒 1(样本不足)时与 raw 相同。
      const estInputRaw = estimateInputTokens(info.messages, info.tools);
      const prevReq = prefixCacheGet(info.sessionId);
      const estCachedRaw = prevReq ? estimateCachedInputTokens(prevReq, { messages: info.messages, tools: info.tools }) : 0;
      const usage = (info.response as { usage?: { inputTokens?: number; cachedTokens?: number; outputTokens?: number } } | undefined)?.usage;
      const reportedInput = finiteOf(usage?.inputTokens);
      const reportedCached = finiteOf(usage?.cachedTokens);
      // 标定键:provider 面(baseUrl 优先,退 apiType)+ 本次模型名。
      const providerKey = String(info.provider?.["baseUrl"] ?? "") || String(info.provider?.["apiType"] ?? "");
      const modelKey = info.model ?? "";
      // ratio 必须在 calibrate **之前**取:本次样本不该回头改本步自己的展示值。
      const ratioBefore = calibrationOf(providerKey, modelKey).ratio;
      const estInput = Math.ceil(estInputRaw * ratioBefore);
      const anomaly = usageAnomalyOf({ est: estInput, reportedInput, reportedCached, prevInput: prevReq?.reportedInput ?? 0 });
      // 标定采样(suspect=上报值被判异常时不采:异常样本会污染 ratio)。
      const outputRawTokens =
        rawTokens(String(info.response.content ?? "")) + rawTokens(String(info.response.reasoning ?? ""));
      calibrate({
        providerKey,
        model: modelKey,
        estInputRaw,
        reportedInput: reportedInput || undefined,
        estOutputRaw: outputRawTokens,
        reportedOutput: finiteOf(usage?.outputTokens) || undefined,
        suspect: Boolean(anomaly),
      });
      // 本次更新后的标定比(标定之后取才含本次样本)。
      const estRatio = calibrationOf(providerKey, modelKey).ratio;
      // 失败调用也写(失败调用的 messages 仍是下一次的前缀基准;reportedInput 缺值记 0=不参与判据)。
      prefixCacheSet(info.sessionId, { messages: info.messages, tools: info.tools, reportedInput });
      // sessionId 只含安全字符(web-*/companion:*/subagent-*),仍防御性清洗做目录名。
      const dir = join(root, info.sessionId.replace(/[^a-zA-Z0-9._:-]/g, "_"));
      const seq = (seqByDir.get(dir) ?? 0) + 1;
      seqByDir.set(dir, seq);
      // 文件名带毫秒时戳兜底:sink 每实例独立(子代理每派发新建 loop+sink,seq 归零),
      // turn 号又来自进程级静态计数器——同名撞写会静默丢轨迹,时戳保证永不覆盖。
      const file = join(dir, `call-${String(seq).padStart(4, "0")}-t${info.turn}s${info.step}-${Date.now()}.json`);
 // 注入提醒普查(会话审计增强):本请求实际携带了哪些 ephemeral 提醒块——
      // tips/todo/已读清单/board 锚/时间盒。审「提示词是否加载正确/有无冗余复读」不必再解包
      // messages 全文,journal 指针事件上一眼可见。
      const reminders: string[] = [];
      for (const m of info.messages) {
        if (m.role !== "user") continue;
        const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
        if (!c.includes("<system-reminder>")) continue;
 // (2026-11 token 轮):任务内轨迹回看块(loop 的 task.trajectory 旁路产物经 tips 注入)。
 // 必须先于 tips 分类判定:tips 块是本条的包封壳,先命中 >tips(会把轨迹块一并吞成 tips,
        // 审计时就分不出「注了纪律」还是「注了轨迹回看」。
        if (c.includes("任务内轨迹")) reminders.push("trajectory");
        else if (c.includes(">tips(")) {
          const km = c.match(/>tips\([^)]*\)/);
          reminders.push("tips" + (km ? ":" + km[0].replace(/[>()]/g, "").replace("tips", "").slice(0, 30) : ""));
        }
        else if (c.includes("未完成项")) reminders.push("todo");
        else if (c.includes("已读文件清单")) reminders.push("readlist");
        else if (c.includes("流程阶段") || c.includes("P0 落目标")) reminders.push("board");
        else if (c.includes("时间盒仅剩")) reminders.push("deadline");
        else if (c.includes("子代理重操作审批")) reminders.push("pending-approval");
        else reminders.push("other:" + c.slice(17, 37));
      }
      const body = {
        ts: Date.now(),
        sessionId: info.sessionId,
        turn: info.turn,
        step: info.step,
        model: info.model ?? "(provider 未暴露 model 字段)",
        durationMs: info.durationMs,
        ...(info.ttftMs !== undefined ? { ttftMs: info.ttftMs } : {}),
        ...(info.provider ? { provider: info.provider } : {}),
        ...(info.error ? { error: info.error } : {}),
        toolNames: info.toolNames,
        tools: info.tools,
        request: { messageCount: info.messages.length, messages: redactDeep(info.messages) },
        response: redactDeep(info.response),
        ...(reminders.length ? { reminders } : {}),
      };
      const env = envelopeOf(info); // 信封指纹(同步段取值)
      const bodyStr = JSON.stringify(body, null, 1);
      void (async () => {
        try {
          await fsp.mkdir(dir, { recursive: true });
          await fsp.writeFile(file, bodyStr, "utf-8");
          // 保留策略接线(P1):写完这一份后按节流条件旁路清理(protectPath=刚写的文件,
          // 清理器保证永不删除它)。放 journal.append 之前——指针事件发出去就代表文件在,
          // 不依赖清理结果。
          maybePrune(root, file);
          // 指针事件入账(2026-11):抽成 appendTraceEvent——失败重试一次、两投两失落 drop 日志。
          // 不变量不变:文件已写完才发指针;任何失败都不向外抛(主链不受轨迹影响)。
          appendTraceEvent(
            journal,
            {
              kind: "llm.trace",
              sessionId: info.sessionId,
              payload: {
                file,
                turn: info.turn,
                step: info.step,
                model: info.model,
                durationMs: info.durationMs,
 // (2026-11 usage-envelope):信封指纹透传(白名单补一项)。此前 payload 是显式
 // 白名单,loop 侧算出的 envelope 到此被丢弃,trace-stats 的 usageEnvelope /
 // tokensDeduped 在真实 journal 上恒不出现。缺失/非法值不写该键(旧行为不变)。
                ...(env ? { envelope: env } : {}),
                ...(info.response.usage ? { usage: info.response.usage } : {}),
 // 构型摘要(用户用户反馈「journal 里看不到 system/构型」):journal 侧可见的
                // 有界速览——角色链/system 头部/输出头部/工具调用名;全文仍在 file(指针哲学不变)。
                messageRoles: info.messages.map((m) => m.role),
                systemHead: String(info.messages[0]?.content ?? "").slice(0, 120),
                responseHead: String(info.response.content ?? "").slice(0, 80),
                ...(reminders.length ? { reminders } : {}),
                ...(info.error ? { error: info.error.slice(0, 300) } : {}),
                ...(info.response.toolCalls?.length ? { toolCalls: info.response.toolCalls.map((c) => c.name) } : {}),
 // 采集层:本地估算(input/前缀命中)+ 上报值异常标记。总是给前两项
                // (首调 cached=0、失败调用也给)——下游按字段名消费,不用猜「没这键=旧版本还是正常」。
                estimatedInputTokens: estInput,
                // 前缀命中同样乘 ratio(与 estInput 同尺):ratio 恒 1 时逐值等于 raw。
                estimatedCachedTokens: Math.ceil(estCachedRaw * ratioBefore),
                ...(estRatio ? { estRatio } : {}),
                ...(anomaly ? { usageSuspect: true, usageAnomaly: anomaly } : {}),
              },
            },
            { file, sessionId: info.sessionId, turn: info.turn, step: info.step, dropLogPath: dropLog },
          );
        } catch {
          /* 轨迹旁路:落盘失败不影响主链(指针不落=读者不会指向不存在的文件) */
        }
      })();
    } catch {
      /* 轨迹旁路:同步段(stringify 等)失败不影响主链 */
    }
  };
}
