#!/usr/bin/env node
// 前缀缓存命中率采样标定(缺口#23, 件1)。
// 目的:给「按龄微压缩/温区裁剪值不值」的经济门提供一个**本地可复算的命中率基线**——
// 不做任何实时探测(那需要真实 key),只从已落盘的 journal 聚合 provider 实际上报的缓存命中。
// 口径(与 src/agent/trace-stats.ts 的 tokens 聚合同源):
// 事件 kind=message.agent → payload.usage.{inputTokens,cachedTokens},逐次累加;
// cumulativeHitRate = cachedSum / inputSum。
// 排除(不编数):
// 1) usage 里没有有限数值 cachedTokens 的请求(provider 未上报缓存 → 样本无效);
// 2) prefixBreak=true 的 context.prune 事件之后的下一个 message.agent 步
// (reset 类动作打碎了前缀,那次请求的 miss 不属于「稳态命中率」)。
// 样本门槛:采样会话 < 30 或总调用 < 100 → pending:true + reason,不产出可信率。
// 用法:node scripts/calibrate-prefix-hit.mjs [--limit 30] [--out .genie/prefix-hit-baseline.json]
import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

const args = process.argv.slice(2);
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Math.max(1, parseInt(args[limitIdx + 1], 10) || 30) : 30;
const outIdx = args.indexOf("--out");
const OUT = outIdx >= 0 ? args[outIdx + 1] : join(process.cwd(), ".genie", "prefix-hit-baseline.json");

const dir = join(process.cwd(), ".genie", "journals", "sessions");

// —— 逐文件流式解析(行级,容错:坏行跳过不中断) ——
function scanSession(file) {
  const usage = []; // {input, cached} 按调用序
  let excludedNoCached = 0;
  let excludedPrefixBreak = 0;
  let broken = false; // 上一个 context.prune 是否带 prefixBreak(只排除紧随其后的一步)
  try {
    const lines = readFileSync(join(dir, file), "utf8").split("\n");
    for (const line of lines) {
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      const kind = ev?.kind ?? ev?.type;
      if (kind === "context.prune") {
        broken = ev?.payload?.prefixBreak === true;
        continue;
      }
      if (kind !== "message.agent") continue;
      const u = ev?.payload?.usage;
      const input = typeof u?.inputTokens === "number" && Number.isFinite(u.inputTokens) ? u.inputTokens : null;
      const cached = typeof u?.cachedTokens === "number" && Number.isFinite(u.cachedTokens) ? u.cachedTokens : null;
      if (cached === null) { excludedNoCached += 1; broken = false; continue; }
      if (broken) { excludedPrefixBreak += 1; broken = false; continue; }
      usage.push({ input: input ?? 0, cached });
    }
  } catch { /* 读失败按空会话处理 */ }
  return { usage, excludedNoCached, excludedPrefixBreak };
}

// —— 选最近 LIMIT 个会话(按 mtime 新→旧;只认 .jsonl) ——
let files = [];
try {
  files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => { const p = join(dir, f); return { f, mtime: statSync(p).mtimeMs }; })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, LIMIT)
    .map((x) => x.f);
} catch {
  console.error(`[calibrate-prefix-hit] journal 目录不存在或不可读: ${dir}`);
  process.exit(1);
}

const perSession = [];
let callsTotal = 0, cachedSum = 0, inputSum = 0, excludedNoCached = 0, excludedPrefixBreak = 0;
for (const f of files) {
  const r = scanSession(f);
  excludedNoCached += r.excludedNoCached;
  excludedPrefixBreak += r.excludedPrefixBreak;
  const calls = r.usage.length;
  const sIn = r.usage.reduce((a, u) => a + u.input, 0);
  const sCa = r.usage.reduce((a, u) => a + u.cached, 0);
  callsTotal += calls; cachedSum += sCa; inputSum += sIn;
  perSession.push({ sessionId: f.replace(/\.jsonl$/, ""), calls, rate: calls > 0 && sIn > 0 ? sCa / sIn : 0 });
}

const reasons = [];
if (files.length < 30) reasons.push(`sampledSessions=${files.length} < 30`);
if (callsTotal < 100) reasons.push(`callsTotal=${callsTotal} < 100`);
const pending = reasons.length > 0;

const baseline = {
  sampledSessions: files.length,
  callsTotal,
  cachedSum,
  inputSum,
  cumulativeHitRate: inputSum > 0 ? cachedSum / inputSum : 0,
  perSession,
  generatedAt: new Date().toISOString(),
  method: "journal-usage-aggregation",
  ...(pending ? { pending: true, reason: reasons.join("; ") } : {}),
};

if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(baseline, null, 2) + "\n");

console.log(`[calibrate-prefix-hit] 写出 ${OUT}`);
console.log(`  sampledSessions = ${baseline.sampledSessions}`);
console.log(`  callsTotal      = ${callsTotal}(另排除:未上报 cached ${excludedNoCached} 次 / prefixBreak 后首步 ${excludedPrefixBreak} 次)`);
console.log(`  cachedSum       = ${cachedSum}`);
console.log(`  inputSum        = ${inputSum}`);
console.log(`  cumulativeHitRate = ${inputSum > 0 ? (100 * cachedSum / inputSum).toFixed(2) + "%" : "n/a"}`);
if (pending) console.log(`  pending: ${baseline.reason}`);
