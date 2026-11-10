#!/usr/bin/env -S node --experimental-strip-types
/**
 * typed submit 协议 CLI(RSI #31):--open / --submit / --nudge / --report。
 *
 * 纯表面层:校验与次数逻辑在 packages/harness-runtime/src/agent/typed-submit.ts,
 * 落盘在 apps/gateway/src/typed-submit-store.ts(`<root>/.genie/rsi/typed-submits.json`)。
 * 本文件只做 argv 解析、JSON 读入与退出码映射。
 *
 * 用法:
 *   node --experimental-strip-types scripts/typed-submit.mts --root <dir> --open --ask <id> --schema <file|-> [--json]
 *   node --experimental-strip-types scripts/typed-submit.mts --root <dir> --submit <id> --payload <file|-> [--json]
 *   node --experimental-strip-types scripts/typed-submit.mts --root <dir> --nudge <id> [--json]
 *   node --experimental-strip-types scripts/typed-submit.mts --root <dir> --report [--json]
 *
 * 退出码:0 成功 / 1 参数错误(含未知 ask)/ 2 schema 校验失败(带 violations)或次数耗尽。
 *
 * 运行前提:`NODE_OPTIONS=--conditions=development`(store 用 `@lampgenie/runtime/agent/*`
 * 的 development 条件解析到 src;与 apps/gateway 的 test 脚本同口径)。
 */
import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  nudgeTypedSubmit,
  openTypedSubmit,
  reportTypedSubmits,
  submitTypedSubmit,
  TYPED_SUBMIT_REL,
  type TypedSubmitOpResult,
} from "../apps/gateway/src/typed-submit-store.ts";
import {
  TYPED_VALIDATION_FAILED,
  TYPED_VIOLATION,
  type JsonSchema,
} from "../packages/harness-runtime/src/agent/typed-submit.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_VALIDATION = 2;

const VALUE_FLAGS = new Set(["root", "ask", "schema", "submit", "payload", "nudge"]);
const BOOL_FLAGS = new Set(["open", "report", "json", "help"]);

const HELP = [
  "用法:node --experimental-strip-types scripts/typed-submit.mts --root <dir> <子命令> [--json]",
  "",
  "  --root <dir>                  台账根目录(真实运行请只给 /tmp 下的目录)",
  "  --open --ask <id> --schema <file|->   登记一个 typed ask 及其 schema",
  "  --submit <id> --payload <file|->      提交结果(未过 schema 回 violations)",
  "  --nudge <id>                          turn 结束仍未提交 → 补一次 nudge;再补即 failed",
  "  --report                              汇总投影(状态计数/次数分布)",
  "  --json                                输出 JSON",
  "  --help                                本帮助",
  "",
  `台账:${TYPED_SUBMIT_REL}`,
  "退出码:0 成功 / 1 参数错误 / 2 校验失败(带 violations)或次数耗尽。",
].join("\n");

interface Parsed {
  values: Map<string, string>;
  flags: Set<string>;
}

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
    if (!VALUE_FLAGS.has(name)) throw new Error(`无法识别的参数:${raw}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`参数 --${name} 缺少取值`);
    values.set(name, next);
    i += 1;
  }
  return { values, flags };
}

async function readJsonArg(path: string, what: string): Promise<unknown> {
  const text = path === "-" ? await readStdin() : await readFile(path, "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${what} 不是合法 JSON:${(error as Error).message}`);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function exitCodeOf(result: TypedSubmitOpResult): number {
  if (result.ok) return EXIT_OK;
  const hit = result.codes.some(
    (code) => code === TYPED_VIOLATION || code === TYPED_VALIDATION_FAILED,
  );
  return hit ? EXIT_VALIDATION : EXIT_USAGE;
}

function printViolations(result: TypedSubmitOpResult): void {
  for (const violation of result.violations ?? []) {
    console.log(
      `violation path=${violation.path} expected=${violation.expected} got=${violation.got}`,
    );
  }
  for (const code of result.codes) console.log(code);
  if (result.reason) console.log(`reason=${result.reason}`);
}

function describeEntry(result: TypedSubmitOpResult): string {
  const state = result.entry?.state;
  if (!state) return "";
  return `ask=${state.askId} status=${state.status} attempts=${state.attempts} nudged=${state.nudged}`;
}

async function main(argv: string[]): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(`参数错误:${(error as Error).message}`);
    console.error(HELP);
    return EXIT_USAGE;
  }
  const { values, flags } = parsed;
  if (flags.has("help")) {
    console.log(HELP);
    return EXIT_OK;
  }
  const json = flags.has("json");
  const root = values.get("root");
  if (!root) {
    console.error("缺少 --root");
    return EXIT_USAGE;
  }

  const modes = [
    flags.has("open") ? "open" : "",
    values.has("submit") ? "submit" : "",
    values.has("nudge") ? "nudge" : "",
    flags.has("report") ? "report" : "",
  ].filter(Boolean);
  if (modes.length !== 1) {
    console.error(`需要一个且仅一个子命令(--open / --submit / --nudge / --report),收到:${modes.join(",") || "无"}`);
    return EXIT_USAGE;
  }

  const mode = modes[0]!;
  try {
    if (mode === "open") {
      const askId = values.get("ask");
      const schemaPath = values.get("schema");
      if (!askId || !schemaPath) {
        console.error("--open 需要 --ask <id> 与 --schema <file|->");
        return EXIT_USAGE;
      }
      const schema = (await readJsonArg(schemaPath, "schema")) as JsonSchema;
      const result = openTypedSubmit(root, askId, schema);
      if (!json) {
        if (result.ok) console.log(`opened ${describeEntry(result)} schema=${schemaPath}`);
        else printViolations(result);
      } else {
        console.log(JSON.stringify({ mode, ...result }, null, 2));
      }
      return exitCodeOf(result);
    }

    if (mode === "submit") {
      const askId = values.get("submit")!;
      const payloadPath = values.get("payload");
      if (!payloadPath) {
        console.error("--submit 需要 --payload <file|->");
        return EXIT_USAGE;
      }
      const payload = await readJsonArg(payloadPath, "payload");
      const result = submitTypedSubmit(root, askId, payload);
      if (!json) {
        if (result.ok) console.log(`SUBMITTED ${describeEntry(result)}`);
        else printViolations(result);
      } else {
        console.log(JSON.stringify({ mode, askId, ...result }, null, 2));
      }
      return exitCodeOf(result);
    }

    if (mode === "nudge") {
      const askId = values.get("nudge")!;
      const result = nudgeTypedSubmit(root, askId);
      if (!json) {
        if (result.ok) {
          console.log(`NUDGED ${describeEntry(result)}`);
          if (result.message) console.log(result.message);
        } else {
          printViolations(result);
        }
      } else {
        console.log(JSON.stringify({ mode, askId, ...result }, null, 2));
      }
      return exitCodeOf(result);
    }

    const report = reportTypedSubmits(root);
    if (json) {
      console.log(JSON.stringify({ mode: "report", root, ...report }, null, 2));
      return EXIT_OK;
    }
    console.log(`total=${report.total} open=${report.open} settled=${report.settled} failed=${report.failed} nudged=${report.nudged}`);
    const attempts = Object.entries(report.byAttempts)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([k, v]) => `${k}:${v}`)
      .join(" ");
    console.log(`byAttempts: ${attempts || "-"}`);
    for (const row of report.asks) {
      console.log(`- ${row.askId} status=${row.status} attempts=${row.attempts} nudged=${row.nudged}`);
    }
    return EXIT_OK;
  } catch (error) {
    console.error(`执行失败:${(error as Error).message}`);
    return EXIT_USAGE;
  }
}

process.exitCode = await main(process.argv.slice(2));
