#!/usr/bin/env -S node --experimental-strip-types
/**
 * 会话查询游标 generation CLI:--issue / --validate / --bump / --report。
 *
 * 纯表面层:指纹/判定/推进语义在 packages/harness-runtime/src/agent/session-cursor.ts(纯逻辑),
 * 落盘与投影在 apps/gateway/src/session-cursor-store.ts(`<root>/.genie/rsi/cursor-state.json`)。
 * 本文件只做 argv 解析、JSON 读入、打印与退出码映射。
 *
 * 用法:
 *   node --experimental-strip-types scripts/session-cursor.mts --root <dir> --issue --query <file> [--before N | --after N] [--json]
 *   node --experimental-strip-types scripts/session-cursor.mts --root <dir> --validate <cursor.json> --query <file> [--json]
 *   node --experimental-strip-types scripts/session-cursor.mts --root <dir> --bump --cause <cause> [--json]
 *   node --experimental-strip-types scripts/session-cursor.mts --root <dir> --report [--json]
 *
 * 输入:--query / --validate 的取值可为路径或 `-`(stdin)。
 * 退出码:0 成功 / 1 参数错误(含 IO 失败、store 写失败)/ 2 游标不可用
 * (CURSOR_STALE / CURSOR_QUERY_MISMATCH / CURSOR_INVALID,输出行里带 code=...)。
 * 为什么 stale 用 2 而不是 0:语料变了这件事必须让 shell 里的调用方看得见,否则「翻页翻到空」
 * 又会被当成「没有更多数据」。
 */
import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  bump,
  issue,
  report,
  validate,
} from "../apps/gateway/src/session-cursor-store.ts";
import { GENERATION_CAUSES } from "../packages/harness-runtime/src/agent/session-cursor.ts";
import type { GenerationCause } from "../packages/harness-runtime/src/agent/session-cursor.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_CURSOR_UNUSABLE = 2;

const BOOL_FLAGS = new Set(["issue", "bump", "report", "json", "help"]);

const VALUE_FLAGS = new Set(["root", "validate", "query", "before", "after", "cause"]);

const COMMANDS = ["issue", "validate", "bump", "report"] as const;

type Command = (typeof COMMANDS)[number];

/** 判定为「游标不可用」的运行时码:统一退出 2。 */
const UNUSABLE_CODES = new Set(["CURSOR_STALE", "CURSOR_QUERY_MISMATCH", "CURSOR_INVALID"]);

interface Parsed {
  values: Map<string, string>;
  flags: Set<string>;
}

const HELP = [
  "用法:node --experimental-strip-types scripts/session-cursor.mts --root <dir> <子命令> [--json]",
  "",
  "  --root <dir>                       台账根目录(必填;真实运行请只给 /tmp 下的目录)",
  "  --issue --query <file|-> [--before N | --after N]   按当前 generation 签发游标",
  "  --validate <cursor.json> --query <file|->           校验游标能否用于本次查询",
  "  --bump --cause <cause>             推进 generation(cause: index-rebuild / corpus-change / reconcile / restart)",
  "  --report                           台账报表(generation / issued / bumps / stale / causes)",
  "  --json                             机器可读输出",
  "  --help                             本帮助",
  "",
  "退出码:0 成功 / 1 参数错误 / 2 游标不可用(CURSOR_STALE / CURSOR_QUERY_MISMATCH / CURSOR_INVALID)。",
].join("\n");

function parseArgs(argv: string[]): Parsed {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]!;
    if (!raw.startsWith("--")) throw new Error(`无法识别的参数:${raw}`);
    const name = raw.slice(2);
    if (BOOL_FLAGS.has(name)) {
      flags.add(name);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new Error(`未知选项 --${name}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`--${name} 需要取值`);
    values.set(name, next);
    i += 1;
  }
  return { values, flags };
}

function commandOf(parsed: Parsed): Command | undefined {
  const found = COMMANDS.filter(
    (command) => parsed.flags.has(command) || (command === "validate" && parsed.values.has("validate")),
  );
  if (found.length > 1) throw new Error(`子命令互斥,只给一个:${found.join(" / ")}`);
  return found[0];
}

function p(line: string): void {
  process.stdout.write(`${line}\n`);
}

// 下游提前关管道(`--report | head -3`)时 stdout 会抛 EPIPE:静默收工,不把栈当结论打给用户。
process.stdout.on("error", (error: { code?: string }) => {
  if (error.code === "EPIPE") process.exit(0);
});

function printJson(value: unknown): void {
  p(JSON.stringify(value, null, 2));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

/** 读 JSON 参数(路径或 `-`);解析失败属于参数错误 → 退出 1。 */
async function readJson(spec: string, label: string): Promise<unknown> {
  const text = spec === "-" ? await readStdin() : await readFile(spec, "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON:${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 收回 --issue --json 直接重定向出来的结果文件:`{...envelope}` 与裸信封都接受。 */
function envelopeOf(raw: unknown): unknown {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    if (record["envelope"] !== undefined) return record["envelope"];
  }
  return raw;
}

function intOf(value: string | undefined, label: string): number | undefined {  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`--${label} 需要非负整数,收到 ${value}`);
  return parsed;
}

function causeOf(value: string | undefined): GenerationCause {
  if (value === undefined) throw new Error(`--bump 需要 --cause <${GENERATION_CAUSES.join(" | ")}>`);
  const known = (GENERATION_CAUSES as readonly string[]).includes(value);
  if (!known) throw new Error(`未知 cause ${value},可选:${GENERATION_CAUSES.join(" / ")}`);
  return value as GenerationCause;
}

/** 游标不可用 → 2;其余失败(store 写失败/IO)→ 1。 */
function exitCodeOf(code: string): number {
  return UNUSABLE_CODES.has(code) ? EXIT_CURSOR_UNUSABLE : EXIT_USAGE;
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.flags.has("help")) {
    p(HELP);
    return EXIT_OK;
  }
  const root = parsed.values.get("root");
  if (root === undefined) throw new Error("缺少 --root <dir>");
  const asJson = parsed.flags.has("json");
  const command = commandOf(parsed);
  if (command === undefined) {
    throw new Error("需要至少一个子命令(--issue / --validate / --bump / --report)");
  }

  if (command === "issue") {
    const querySpec = parsed.values.get("query");
    if (querySpec === undefined) throw new Error("--issue 需要 --query <file|->");
    const beforeSeq = intOf(parsed.values.get("before"), "before");
    const afterSeq = intOf(parsed.values.get("after"), "after");
    if (beforeSeq !== undefined && afterSeq !== undefined) throw new Error("--before 与 --after 只能给一个");
    const position: { beforeSeq?: number; afterSeq?: number } = {};
    if (beforeSeq !== undefined) position.beforeSeq = beforeSeq;
    if (afterSeq !== undefined) position.afterSeq = afterSeq;
    const query = await readJson(querySpec, "--query");
    const result = issue(root, { query, position });
    if (asJson) printJson(result);
    else p(`issue: code=${result.code} id=${result.id ?? "-"} generation=${result.generation}`);
    return result.ok ? EXIT_OK : exitCodeOf(result.code);
  }

  if (command === "validate") {
    const cursorSpec = parsed.values.get("validate");
    if (cursorSpec === undefined || cursorSpec === "") throw new Error("--validate 需要 <cursor.json> 取值");
    const querySpec = parsed.values.get("query");
    if (querySpec === undefined) throw new Error("--validate 需要 --query <file|->");
    const envelope = envelopeOf(await readJson(cursorSpec, "--validate"));
    const query = await readJson(querySpec, "--query");
    const result = validate(root, envelope, { query });
    if (asJson) printJson(result);
    else p(`validate: code=${result.code} generation=${result.generation} detail=${result.detail}`);
    return result.ok ? EXIT_OK : exitCodeOf(result.code);
  }

  if (command === "bump") {
    const cause = causeOf(parsed.values.get("cause"));
    const result = bump(root, { cause });
    if (asJson) printJson(result);
    else p(`bump: code=${result.code} cause=${cause} ${result.from} -> ${result.to}`);
    return result.ok ? EXIT_OK : EXIT_USAGE;
  }

  // report
  const result = report(root);
  if (asJson) {
    printJson(result);
  } else {
    p(
      `report: generation=${result.generation} issued=${result.issued} bumps=${result.bumps} stale=${result.stale} causes=${result.causes.join(",") || "-"} codes=${result.codes.join(",") || "-"}`,
    );
  }
  return EXIT_OK;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT_USAGE;
  });
