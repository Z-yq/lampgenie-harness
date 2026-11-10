#!/usr/bin/env tsx
/**
 * M145 上下文构成归因 CLI:读 journal,打印该会话最近 N 帧 context.breakdown 的分类占比。
 *
 * 用法:
 *   tsx scripts/context-breakdown.mts --session <sid> [--journal <dir>] [--json] [--last N]
 *
 *   --session <sid>   会话 id(必填;对应 <journal>/<sid>.jsonl 或 <journal>/sessions/<sid>.jsonl)
 *   --journal <dir>   journal 根目录(缺省 .genie/journals)
 *   --json            机器可读输出
 *   --last <N>        只打最后 N 帧(缺省 1)
 *
 * 退出码:0 = 已输出(含「该会话无 context.breakdown」);2 = 参数错误 / journal 无法解析。
 * 口径:chars 逐字(exact)、tokens 本地估算(local_estimate);provider usage 只做对照行,
 * 不覆盖本地估算值。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CONTEXT_BREAKDOWN_KEYS,
  renderBreakdownTable,
  type ContextBreakdownEntry,
} from "../packages/harness-runtime/src/agent/context-breakdown.ts";

interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

interface Frame {
  turn: number;
  step: number;
  at?: number;
  entries: ContextBreakdownEntry[];
  totalChars: number;
  totalTokensEstimate: number;
  providerUsage: ProviderUsage;
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
  throw new Error(msg);
}

const KNOWN = new Set(["--session", "--journal", "--json", "--last"]);
for (let i = 0; i < args.length; i += 1) {
  const a = args[i]!;
  if (a === "--json") continue;
  if (!KNOWN.has(a)) fail(`未知参数:${a}`);
  if (args[i + 1] === undefined) fail(`参数 ${a} 缺少取值`);
  i += 1;
}

const sessionId = flag("--session");
if (!sessionId) fail("缺少 --session <sid>");
const journalRoot = resolve(flag("--journal") ?? ".genie/journals");
const asJson = args.includes("--json");
const lastRaw = flag("--last");
let last = 1;
if (lastRaw !== undefined) {
  const n = Number.parseInt(lastRaw, 10);
  if (!Number.isFinite(n) || n <= 0) fail(`--last 需要正整数,收到 ${lastRaw}`);
  last = n;
}

/** 候选 journal 文件:<root>/<sid>.jsonl 与 <root>/sessions/<sid>.jsonl。 */
const candidates = [join(journalRoot, `${sessionId}.jsonl`), join(journalRoot, "sessions", `${sessionId}.jsonl`)];
const journalFile = candidates.find((p) => existsSync(p));

function noEvent(): never {
  if (asJson) {
    console.log(JSON.stringify({ sessionId, journalFile: journalFile ?? null, count: 0, frames: [] }, null, 2));
  } else {
    console.log(`该会话无 context.breakdown(session=${sessionId},journal=${journalRoot})`);
  }
  process.exit(0);
  throw new Error("unreachable");
}

if (!journalFile) noEvent();

let raw = "";
try {
  raw = readFileSync(journalFile!, "utf8");
} catch (err) {
  fail(`无法读取 journal:${journalFile}(${err instanceof Error ? err.message : String(err)})`);
}

const frames: Frame[] = [];
const lines = raw.split("\n");
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i]!.trim();
  if (line === "") continue;
  let ev: unknown;
  try {
    ev = JSON.parse(line);
  } catch {
    fail(`journal 解析失败:${journalFile}:${i + 1}(坏 journal,exit 2)`);
  }
  if (!ev || typeof ev !== "object") continue;
  const o = ev as Record<string, unknown>;
  if (o["kind"] !== "custom") continue;
  const payload = o["payload"];
  if (!payload || typeof payload !== "object") continue;
  const p = payload as Record<string, unknown>;
  if (p["what"] !== "context.breakdown") continue;
  if (typeof p["sessionId"] === "string" && p["sessionId"] !== sessionId) continue;
  const entries = Array.isArray(p["entries"]) ? (p["entries"] as ContextBreakdownEntry[]) : [];
  frames.push({
    turn: typeof p["turn"] === "number" ? p["turn"] : -1,
    step: typeof p["step"] === "number" ? p["step"] : -1,
    ...(typeof p["at"] === "number" ? { at: p["at"] } : {}),
    entries,
    totalChars: typeof p["totalChars"] === "number" ? p["totalChars"] : entries.reduce((n, e) => n + (e.chars ?? 0), 0),
    totalTokensEstimate:
      typeof p["totalTokensEstimate"] === "number"
        ? p["totalTokensEstimate"]
        : entries.reduce((n, e) => n + (e.tokens ?? 0), 0),
    providerUsage: (p["providerUsage"] && typeof p["providerUsage"] === "object" ? p["providerUsage"] : {}) as ProviderUsage,
  });
}

if (frames.length === 0) noEvent();

const tail = frames.slice(-last);

function usageLine(u: ProviderUsage, estimate: number): string {
  const parts: string[] = [];
  if (typeof u.inputTokens === "number") parts.push(`input=${u.inputTokens}`);
  if (typeof u.outputTokens === "number") parts.push(`output=${u.outputTokens}`);
  if (typeof u.totalTokens === "number") parts.push(`total=${u.totalTokens}`);
  const reported = typeof u.totalTokens === "number"
    ? u.totalTokens
    : typeof u.inputTokens === "number" || typeof u.outputTokens === "number"
      ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0)
      : undefined;
  if (parts.length === 0) return `provider usage: missing(provider 未上报;本地估算 ${estimate})`;
  const diff = reported !== undefined && estimate > 0 ? `,本地估算 ${estimate}(差 ${(((reported - estimate) / estimate) * 100).toFixed(1)}%)` : `,本地估算 ${estimate}`;
  return `provider usage: ${parts.join(" ")}${diff}`;
}

if (asJson) {
  console.log(JSON.stringify({
    sessionId,
    journalFile,
    count: tail.length,
    frames: tail.map((f) => ({
      turn: f.turn,
      step: f.step,
      ...(f.at !== undefined ? { at: f.at } : {}),
      totalChars: f.totalChars,
      totalTokensEstimate: f.totalTokensEstimate,
      providerUsage: f.providerUsage,
      entries: f.entries,
    })),
    keys: [...CONTEXT_BREAKDOWN_KEYS],
  }, null, 2));
  process.exit(0);
}

for (const f of tail) {
  const when = f.at !== undefined ? new Date(f.at).toISOString() : "-";
  console.log(`== turn ${f.turn} step ${f.step} @ ${when} (${journalFile})`);
  console.log(renderBreakdownTable(f.entries));
  console.log(usageLine(f.providerUsage, f.totalTokensEstimate));
  console.log("");
}
process.exit(0);
