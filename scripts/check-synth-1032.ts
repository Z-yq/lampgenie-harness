/**
 * step-1032 真数据自愈核对：对真实 .genie/llm-trace 目录 × journal llm.trace 事件，
 * 计算「文件数 / 已入账数 / 需补 synth 数」，验证看板自愈在真实会话上成立。
 * 用法：node --experimental-strip-types scripts/check-synth-1032.ts [sessionId ...]
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TRACE = join(ROOT, ".genie", "llm-trace");
const SESSIONS = join(ROOT, ".genie", "journals", "sessions");

/** 该会话在 journal 里已入账的 traceFile 集合（按 sessionId 过滤 + 只认 call-*.json）。 */
function accountedFiles(sessionId: string): Set<string> {
  const jf = join(SESSIONS, `${sessionId}.jsonl`);
  const out = new Set<string>();
  if (!existsSync(jf)) return out;
  for (const line of readFileSync(jf, "utf8").split("\n")) {
    if (!line) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e?.kind !== "llm.trace") continue;
    const f = e?.payload?.file;
    if (typeof f === "string" && f) out.add(f);
  }
  return out;
}

const ids = process.argv.slice(2);
const targets = ids.length
  ? ids
  : readdirSync(TRACE).filter((d) => {
      try {
        return readdirSync(join(TRACE, d)).length > 0;
      } catch {
        return false;
      }
    });

let totalFiles = 0;
let totalAccounted = 0;
let totalSynth = 0;
const rows: string[] = [];
for (const sid of targets) {
  const dir = join(TRACE, sid);
  if (!existsSync(dir)) continue;
  const files = readdirSync(dir).filter((f) => f.startsWith("call-") && f.endsWith(".json"));
  if (!files.length) continue;
  const acc = accountedFiles(sid);
  const missing = files.filter((f) => !acc.has(join(dir, f)));
  totalFiles += files.length;
  totalAccounted += files.length - missing.length;
  totalSynth += missing.length;
  if (missing.length) rows.push(`${sid}: files=${files.length} accounted=${files.length - missing.length} synth=${missing.length} 例:${missing.slice(0, 2).join(",")}`);
}
console.log("会话数", targets.length, "| 文件合计", totalFiles, "| 已入账", totalAccounted, "| 需 synth", totalSynth);
for (const r of rows.slice(0, 20)) console.log("  ", r);
if (!rows.length) console.log("  (所有会话 0 丢事件)");
