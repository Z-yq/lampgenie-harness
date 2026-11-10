#!/usr/bin/env tsx
/**
 * M130 Prompt footprint 归因 CLI。
 *
 * 用法:
 *   tsx scripts/prompt-footprint.mts --manifest <json> [--json]
 *   tsx scripts/prompt-footprint.mts --diff <base.json> <next.json> [--changed id1,id2] [--json]
 *
 *   --manifest <json>  footprint manifest(见 parseFootprintManifest);打印分块表 + 类别占比 + top5
 *   --diff A B         离线 A/B:changedIds 之外的公共分块必须逐字节相等
 *   --changed <ids>    允许变化的分块 id(逗号分隔)
 *   --json             机器可读输出
 *
 * 退出码:0 = 通过;2 = 参数字节断言失败 / 参数错误;3 = manifest 坏(JSON 非法或缺字段)。
 * 口径:chars 逐字 exact;tokensRaw 不乘系数;tokensEstimate 乘 provider 标定 ratio(缺省 1),两列不合成。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SECTION_CATEGORIES,
  buildFootprint,
  diffFootprint,
  parseFootprintManifest,
  type FootprintInput,
  type FootprintReport,
} from "../packages/harness-runtime/src/agent/prompt-footprint.ts";

const args = process.argv.slice(2);

function valueOf(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function fail(code: number, msg: string): never {
  console.error(msg);
  process.exit(code);
  throw new Error(msg);
}

const KNOWN = new Set(["--manifest", "--diff", "--changed", "--json"]);
for (let i = 0; i < args.length; i += 1) {
  const a = args[i]!;
  if (a === "--json") continue;
  if (!KNOWN.has(a)) fail(2, `未知参数: ${a}`);
  if (a === "--manifest" || a === "--diff" || a === "--changed") {
    if (args[i + 1] === undefined) fail(2, `参数 ${a} 缺少取值`);
    if (a === "--diff") {
      if (args[i + 2] === undefined) fail(2, "参数 --diff 需要两个文件");
      i += 2;
    } else {
      i += 1;
    }
  }
}

const manifestPath = valueOf("--manifest");
const diffIdx = args.indexOf("--diff");
const changedArg = valueOf("--changed");
const changedIds = changedArg ? changedArg.split(",").map((s) => s.trim()).filter((s) => s.length > 0) : [];

if (!manifestPath && diffIdx < 0) fail(2, "用法: --manifest <json> | --diff <base.json> <next.json>");

function loadManifest(path: string): FootprintInput {
  const abs = resolve(path);
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch (err) {
    fail(3, `manifest 读取失败(${path}): ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = parseFootprintManifest(raw);
  if (!parsed.ok) fail(3, `${parsed.code}: ${parsed.message}(${path})`);
  return parsed.input;
}

function pct(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

function renderReport(report: FootprintReport): string {
  const lines: string[] = ["# Prompt footprint(字符 / tokensRaw / tokensEstimate)"];
  lines.push("类别\t字符\ttokensRaw\ttokensEstimate\t占比");
  for (const cat of SECTION_CATEGORIES) {
    const s = report.byCategory[cat];
    if (s.chars === 0 && s.tokensRaw === 0 && s.tokensEstimate === 0) continue;
    lines.push(`${cat}\t${s.chars}\t${s.tokensRaw}\t${s.tokensEstimate}\t${pct(s.share)}`);
  }
  lines.push(`${"合计"}\t${report.total.chars}\t${report.total.tokensRaw}\t${report.total.tokensEstimate}\t${"-"}`);
  lines.push("", "top5:");
  report.top.forEach((e, i) => {
    const share = report.total.tokensEstimate > 0 ? e.tokensEstimate / report.total.tokensEstimate : 0;
    lines.push(`  ${i + 1}. ${e.id} [${e.category}] chars=${e.chars} raw=${e.tokensRaw} est=${e.tokensEstimate} share=${pct(share)}`);
  });
  if (report.top.length === 0) lines.push("  (空)");
  return lines.join("\n");
}

if (manifestPath) {
  const input = loadManifest(manifestPath);
  const report = buildFootprint(input);
  if (args.includes("--json")) {
    console.log(JSON.stringify({ mode: "manifest", source: manifestPath, report }, null, 2));
  } else {
    console.log(renderReport(report));
  }
  process.exit(0);
}

// --diff 模式
const basePath = args[diffIdx + 1]!;
const nextPath = args[diffIdx + 2]!;
const base = loadManifest(basePath);
const next = loadManifest(nextPath);
const diff = diffFootprint(base, next, { changedIds });
if (!diff.ok) {
  if (args.includes("--json")) console.log(JSON.stringify({ mode: "diff", base: basePath, next: nextPath, diff }, null, 2));
  else console.error(`${diff.code}: 未声明却变了字节的分块: ${diff.ids.join(",") || "(none)"}`);
  process.exit(2);
}
if (args.includes("--json")) {
  console.log(JSON.stringify({ mode: "diff", base: basePath, next: nextPath, diff }, null, 2));
} else {
  const lines: string[] = ["# Prompt footprint diff(字节断言通过)", "changed:"];
  if (diff.changed.length === 0) lines.push("  (无)");
  for (const c of diff.changed) {
    const sign = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);
    lines.push(`  ${c.id} [${c.category}] chars ${sign(c.charsDelta)} raw ${sign(c.tokensRawDelta)} est ${sign(c.tokensEstimateDelta)}`);
  }
  lines.push(`added: ${diff.added.join(",") || "(无)"}`);
  lines.push(`removed: ${diff.removed.join(",") || "(无)"}`);
  const t = diff.total;
  const sign = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);
  lines.push(`total: chars ${sign(t.charsDelta)} raw ${sign(t.tokensRawDelta)} est ${sign(t.tokensEstimateDelta)}`);
  console.log(lines.join("\n"));
}
process.exit(0);
