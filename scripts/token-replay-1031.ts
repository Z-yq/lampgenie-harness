/**
 * step-1031 回放:M对同一批真实 llm-trace 请求,比较三种口径
 *   ①字符粗估(旧口径:非 ASCII 码点 1 tok、ASCII 0.25 tok,ceil)—— 即 step-1027 llm-trace.countTokens
 *   ②真分词器(cl100k rawTokens)—— 新口径,未标定
 *   ③provider 上报 usage.inputTokens —— 标定基准
 *
 * 用法:node --experimental-strip-types scripts/token-replay-1031.ts [traceDir]
 * 默认取仓根 .genie/llm-trace/web-opt1106-tracefull-1793940463380。
 * 输出:逐样本表(前 12 条)+ 偏差统计(中位相对误差 / p90 / 分档:CJK 主导 vs 代码主导)。
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rawTokens, estimatorKind } from "../packages/harness-runtime/src/agent/token-estimate.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DEFAULT_DIR = join(ROOT, ".genie", "llm-trace", "web-opt1106-tracefull-1793940463380");
const dir = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_DIR;

/** 旧口径(step-1027 countTokens):非 ASCII 码点 1 tok、ASCII 0.25 tok,累加后 ceil。 */
function oldCharEstimate(s: string): number {
  let tok = 0;
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i) ?? 0;
    if (cp > 0xffff) i++;
    tok += cp > 0x7f ? 1 : 0.25;
  }
  return Math.ceil(tok);
}

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? "" : s;
  } catch {
    return "";
  }
}

/** 与 llm-trace.estimateInputTokens 同源的「请求文本」:messages(role+content+toolCalls+toolCallId)+ 工具面。 */
function requestText(j: any): string {
  let s = "";
  for (const m of Array.isArray(j.request?.messages) ? j.request.messages : []) {
    const c = m?.content;
    s += (typeof m?.role === "string" ? m.role : "");
    s += typeof c === "string" ? c : c === undefined || c === null ? "" : safeJson(c);
    s += m?.toolCalls === undefined || m?.toolCalls === null ? "" : safeJson(m.toolCalls);
    s += typeof m?.toolCallId === "string" ? m.toolCallId : "";
  }
  for (const t of Array.isArray(j.tools) ? j.tools : []) {
    s += typeof t?.name === "string" ? t.name : "";
    s += typeof t?.description === "string" ? t.description : "";
    s += t?.parameters === undefined || t?.parameters === null ? "" : safeJson(t.parameters);
  }
  return s;
}

function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))));
  return a[i]!;
}

function median(xs: number[]): number {
  return pct(xs, 50);
}

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/g;
function cjkRatio(s: string): number {
  if (!s.length) return 0;
  const hits = s.match(CJK_RE)?.length ?? 0;
  return hits / s.length;
}

type Row = { file: string; chars: number; oldEst: number; tokEst: number; reported: number; cjk: number };

if (!existsSync(dir)) {
  console.error(`回放目录不存在: ${dir}`);
  process.exit(1);
}
const files = readdirSync(dir).filter((f) => f.startsWith("call-") && f.endsWith(".json")).sort();
const rows: Row[] = [];
for (const f of files) {
  let j: any;
  try {
    j = JSON.parse(readFileSync(join(dir, f), "utf8"));
  } catch {
    continue;
  }
  const reported = Number(j.response?.usage?.inputTokens ?? 0);
  if (!(reported > 0)) continue;
  const text = requestText(j);
  rows.push({ file: f, chars: text.length, oldEst: oldCharEstimate(text), tokEst: rawTokens(text), reported, cjk: cjkRatio(text) });
}

const errOf = (est: number, rep: number) => (rep > 0 ? Math.abs(est - rep) / rep : 0);
const signedOf = (est: number, rep: number) => (rep > 0 ? est / rep : 0);

for (const [tag, subset] of [
  ["全部", rows],
  ["中文主导(cjk≥10%)", rows.filter((r) => r.cjk >= 0.1)],
  ["代码/英文主导(cjk<10%)", rows.filter((r) => r.cjk < 0.1)],
] as const) {
  if (!subset.length) continue;
  const oldErr = subset.map((r) => errOf(r.oldEst, r.reported));
  const tokErr = subset.map((r) => errOf(r.tokEst, r.reported));
  console.log(
    `${tag}: n=${subset.length} | 字符粗估 中位误差 ${(median(oldErr) * 100).toFixed(1)}% p90 ${(pct(oldErr, 90) * 100).toFixed(1)}% 中位比 ${median(subset.map((r) => signedOf(r.oldEst, r.reported))).toFixed(3)}` +
      ` | 分词器 中位误差 ${(median(tokErr) * 100).toFixed(1)}% p90 ${(pct(tokErr, 90) * 100).toFixed(1)}% 中位比 ${median(subset.map((r) => signedOf(r.tokEst, r.reported))).toFixed(3)}`,
  );
}

console.log("\n样本(前 12 条):file | chars | 字符粗估 | 分词器 | 上报 | 粗估误差 | 分词器误差 | cjk%");
for (const r of rows.slice(0, 12)) {
  console.log(
    `${r.file.slice(0, 24)} | ${r.chars} | ${r.oldEst} | ${r.tokEst} | ${r.reported} | ${(errOf(r.oldEst, r.reported) * 100).toFixed(1)}% | ${(errOf(r.tokEst, r.reported) * 100).toFixed(1)}% | ${(r.cjk * 100).toFixed(0)}%`,
  );
}
console.log(`\n分词器状态: ${estimatorKind()}(fallback 表示资产缺失,数字会退化为 CJK 系数)`);
