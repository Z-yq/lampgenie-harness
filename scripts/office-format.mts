#!/usr/bin/env node
/**
 * Office 格式级业务规则检查 CLI(2026-11 #):参数解析 + 输出 + 退出码,不掺业务判定。
 * 事实抽取在 apps/gateway/src/office-format-store.ts,
 * 规则裁决在 packages/harness-runtime/src/agent/office-format-rules.ts;本文件只做三件事:
 * 1. 把 argv 折成 {root, files, json, report}(缺参/未知 flag 立即 exit 1,不猜默认值);
 * 2. 调 runFormatCheck,按 `--json`(机器读)/`--report`(人读)/缺省(一行一文件)三种方式打印;
 * 3. 把 runFormatCheck 的 exitCode 原样转成进程退出码。
 * 退出码:0 = pass/warn;2 = fail(任一 p0,含抽取失败导致的 FORMAT_INVALID);1 = 参数/读取错误。
 * 用法:
 * node --experimental-strip-types --conditions=development scripts/office-format.mts \
 * --root /tmp/m102-check --check a.docx b.xlsx [--report|--json]
 */
import { readFormatLedger, runFormatCheck } from "../apps/gateway/src/office-format-store.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;

const VALUE_FLAGS = new Set(["root", "check"]);
const BOOL_FLAGS = new Set(["json", "report", "help"]);

interface Parsed {
  root?: string;
  files: string[];
  json: boolean;
  report: boolean;
  help: boolean;
}

/** argv → Parsed;未知 flag / 缺值一律 throw(由 main 折成 exit 1)。 */
function parseArgv(argv: readonly string[]): Parsed {
  const out: Parsed = { files: [], json: false, report: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i] ?? "";
    if (!raw.startsWith("--")) throw new Error(`无法识别的参数:${raw}`);
    const eq = raw.indexOf("=");
    const flag = (eq < 0 ? raw.slice(2) : raw.slice(2, eq)).trim();
    const inline = eq < 0 ? undefined : raw.slice(eq + 1);
    if (BOOL_FLAGS.has(flag)) {
      if (inline !== undefined) throw new Error(`--${flag} 不接受取值`);
      if (flag === "json") out.json = true;
      else if (flag === "report") out.report = true;
      else out.help = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw new Error(`无法识别的参数:--${flag}`);
    if (inline !== undefined) {
      if (flag === "root") out.root = inline;
      else out.files.push(inline);
      continue;
    }
    if (flag === "root") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--root 需要目录参数");
      out.root = value;
      i += 1;
      continue;
    }
 // --check 吃掉后面所有非 flag 参数(文件列表)
    let took = 0;
    for (let j = i + 1; j < argv.length; j += 1) {
      const next = argv[j] ?? "";
      if (next.startsWith("--")) break;
      out.files.push(next);
      took += 1;
    }
    if (took === 0) throw new Error("--check 需要至少一个文件");
    i += took;
  }
  return out;
}

const USAGE = [
  "用法: node --experimental-strip-types scripts/office-format.mts --root <dir> --check <file...> [--json] [--report]",
  "  --root    产物根(必须在 /tmp 下的绝对路径)",
  "  --check   待检查的 docx/xlsx/pptx/pdf(可多个)",
  "  --json    打印机器可读 JSON",
  "  --report  打印人读摘要(逐条 issue 的 ruleId/severity/location/message/fixHint)",
  "退出码: 0 pass/warn, 2 fail(任一 p0), 1 参数或读取错误",
].join("\n");

/** 人读摘要:一行结论 + 每条 issue 的定位与修法。 */
function printReport(root: string, out: Awaited<ReturnType<typeof runFormatCheck>>): void {
  for (const item of out.results) {
    const { code, verdict, counts } = item.report;
    console.log(`${code} ${verdict} ${item.format ?? "unknown"} ${item.file} (p0=${counts.p0} p1=${counts.p1} p2=${counts.p2})`);
    for (const issue of item.report.issues) {
      console.log(`  - [${issue.severity}] ${issue.ruleId} @ ${issue.location}: ${issue.message}`);
      console.log(`    fix: ${issue.fixHint}`);
    }
  }
  const pass = out.results.filter((r) => r.report.verdict === "pass").length;
  const warn = out.results.filter((r) => r.report.verdict === "warn").length;
  const fail = out.results.filter((r) => r.report.verdict === "fail").length;
  const ledger = readFormatLedger(root);
  console.log(`汇总: ${out.code} 共 ${out.results.length} 个文件(pass=${pass} warn=${warn} fail=${fail});root=${root};账本 ${ledger.length} 条`);
}

async function main(): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgv(process.argv.slice(2));
  } catch (err) {
    console.error(`参数错误:${err instanceof Error ? err.message : String(err)}`);
    console.error(USAGE);
    return EXIT_USAGE;
  }
  if (parsed.help) {
    console.log(USAGE);
    return EXIT_OK;
  }
  if (parsed.root === undefined || parsed.root.trim() === "") {
    console.error("参数错误:缺 --root");
    console.error(USAGE);
    return EXIT_USAGE;
  }
  if (parsed.files.length === 0) {
    console.error("参数错误:缺 --check <file...>");
    console.error(USAGE);
    return EXIT_USAGE;
  }

  const out = await runFormatCheck({ root: parsed.root, files: parsed.files });
  if (parsed.json) {
    console.log(JSON.stringify(out, null, 2));
  } else if (parsed.report) {
    printReport(out.root === "" ? parsed.root : out.root, out);
  } else {
    for (const item of out.results) {
      const { code, verdict, counts } = item.report;
      console.log(`${item.file}\t${item.format ?? "unknown"}\t${code}\t${verdict}\tp0=${counts.p0} p1=${counts.p1} p2=${counts.p2}`);
    }
    console.log(`汇总: ${out.code}(exit ${out.exitCode})`);
  }
  if (out.error !== undefined) console.error(`错误:${out.code} ${out.error}`);
  return out.exitCode;
}

process.exitCode = await main();
