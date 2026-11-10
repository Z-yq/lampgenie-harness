#!/usr/bin/env -S npx tsx
/**
 * 表面替换溯源 CLI(tsx 直跑):append / replace / transcript / version / report。
 *
 * 用法:
 *   tsx scripts/surface-trace.mts --root /tmp/st --append /tmp/st/ev.json     # 每行一个 ev JSON,或一个 JSON 数组
 *   tsx scripts/surface-trace.mts --root /tmp/st --replace /tmp/st/rep.json
 *   tsx scripts/surface-trace.mts --root /tmp/st --report [--json]
 *   tsx scripts/surface-trace.mts --root /tmp/st --transcript
 *   tsx scripts/surface-trace.mts --root /tmp/st --version
 *
 * 退出码:0 成功;1 输入非法(JSON 解析失败 / 形状不合法 / append 的 seq 冲突);
 *        2 契约级拒收(SURFACE_SOURCE_MISSING / SOURCE_NOT_EARLIER / SOURCE_DUPLICATE /
 *          SHADOW_INCOMPLETE / TOOL_FIELDS_MUTATED / GENERATION_STALE / INVALID)。
 *        stderr 打错误码;--json 机器可读。
 * 落盘位置:`<root>/.genie/rsi/surface.jsonl`(真实运行请只给 /tmp 下的 root)。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

/** store 面(惰性解析:--help 不触发任何 imports)。 */
interface StoreModule {
  appendEvent(root: string, event: unknown): { ok: boolean; codes: string[]; events?: number };
  replaceEvent(root: string, event: unknown): { ok: boolean; codes: string[]; events?: number };
  transcript(root: string): { ok: true; events: Array<Record<string, unknown>>; codes: string[] };
  version(root: string): number;
  report(root: string): Record<string, unknown>;
  surfaceTracePath(root: string): string;
}

/** runtime 纯逻辑面(只为拿失败码表做退出码分流)。 */
interface RuntimeModule {
  SURFACE_FAILURE_CODES: readonly string[];
}

interface ParsedArgs {
  root: string;
  append?: string;
  replace?: string;
  transcript: boolean;
  version: boolean;
  report: boolean;
  json: boolean;
  help: boolean;
}

const USAGE = `表面替换溯源 CLI(append-only jsonl,落在 <root>/.genie/rsi/surface.jsonl)

用法:
  tsx scripts/surface-trace.mts --root <dir> --append <file>     追加事件(append)
  tsx scripts/surface-trace.mts --root <dir> --replace <file>    追加改写事件(replace)
  tsx scripts/surface-trace.mts --root <dir> --transcript        人读转录(只含 append-origin)
  tsx scripts/surface-trace.mts --root <dir> --version           派生缓存版本(= contentGeneration)
  tsx scripts/surface-trace.mts --root <dir> --report            投影 + 结构体检
  tsx scripts/surface-trace.mts --help

选项:
  --root <dir>   台账根目录(必填)
  --append <f>   事件文件:"每行一个 ev JSON"或"一个 JSON 数组"
  --replace <f>  同上,事件需带 surfaceOp=replace / sourceEventSeqs / replaceGeneration
  --json         机器可读输出
  --transcript / --version / --report  可与 --append/--replace 组合(先写后读)

退出码:0 成功;1 输入非法(JSON/形状/append seq 冲突);2 契约级拒收(码打到 stderr)。
`;

function valueOf(argv: string[], index: number, arg: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${arg} 缺少取值`);
  return value;
}

/** 手写 argv 解析(与 evidence-graph.mts 同风格,不引依赖)。 */
function parseArgv(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    root: "",
    transcript: false,
    version: false,
    report: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case "--root":
        out.root = valueOf(argv, i, arg);
        i += 1;
        break;
      case "--append":
        out.append = valueOf(argv, i, arg);
        i += 1;
        break;
      case "--replace":
        out.replace = valueOf(argv, i, arg);
        i += 1;
        break;
      case "--transcript":
        out.transcript = true;
        break;
      case "--version":
        out.version = true;
        break;
      case "--report":
        out.report = true;
        break;
      case "--json":
        out.json = true;
        break;
      case "--help":
      case "-h":
        out.help = true;
        break;
      default:
        throw new Error(`未知参数:${arg}`);
    }
  }
  return out;
}

/** 读事件文件:先按整体 JSON(数组或单对象)解析,失败再按行解析。 */
function parseEvents(text: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  try {
    const whole = JSON.parse(trimmed) as unknown;
    return Array.isArray(whole) ? whole : [whole];
  } catch {
    const out: unknown[] = [];
    for (const line of trimmed.split("\n")) {
      const raw = line.trim();
      if (raw === "") continue;
      out.push(JSON.parse(raw) as unknown);
    }
    return out;
  }
}

function readEvents(file: string): unknown[] {
  return parseEvents(readFileSync(resolve(file), "utf8"));
}

async function loadStore(): Promise<StoreModule> {
  return (await import("../apps/gateway/src/surface-trace-store.ts")) as unknown as StoreModule;
}

async function loadRuntime(): Promise<RuntimeModule> {
  return (await import("../packages/harness-runtime/src/agent/surface-trace.ts")) as unknown as RuntimeModule;
}

function clip(text: unknown, n = 60): string {
  const s = typeof text === "string" ? text : JSON.stringify(text);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** 失败码 → 退出码:append 侧的拒收一律算输入非法(1),replace 侧算契约级拒收(2)。 */
function exitForFailures(op: "append" | "replace", codes: string[], failureCodes: readonly string[]): number {
  if (!codes.some((code) => failureCodes.includes(code))) return 0;
  return op === "append" ? 1 : 2;
}

async function main(): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgv(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`SURFACE_INVALID 参数错误:${(error as Error).message}\n`);
    return 1;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.root.trim() === "") {
    process.stderr.write("SURFACE_INVALID 缺少 --root\n");
    return 1;
  }
  if (!args.append && !args.replace && !args.transcript && !args.version && !args.report) {
    process.stderr.write("SURFACE_INVALID 至少需要一个动作(--append/--replace/--transcript/--version/--report)\n");
    return 1;
  }

  const [store, runtime] = await Promise.all([loadStore(), loadRuntime()]);
  const failureCodes = runtime.SURFACE_FAILURE_CODES;
  const summary: Record<string, unknown> = { root: resolve(args.root), path: store.surfaceTracePath(args.root) };

  for (const [op, file] of [
    ["append", args.append],
    ["replace", args.replace],
  ] as const) {
    if (file === undefined) continue;
    let events: unknown[];
    try {
      events = readEvents(file);
    } catch (error) {
      process.stderr.write(`SURFACE_INVALID 读/解析事件文件失败(${file}):${(error as Error).message}\n`);
      if (args.json) process.stdout.write(`${JSON.stringify({ ok: false, codes: ["SURFACE_INVALID"], error: (error as Error).message })}\n`);
      return 1;
    }
    if (events.length === 0) {
      process.stderr.write(`SURFACE_INVALID 事件文件为空(${file})\n`);
      return 1;
    }
    for (const event of events) {
      const result = op === "append" ? store.appendEvent(args.root, event) : store.replaceEvent(args.root, event);
      if (!result.ok) {
        process.stderr.write(`${result.codes.join(" ")}\n`);
        if (args.json) {
          process.stdout.write(
            `${JSON.stringify({ ok: false, op, codes: result.codes, event: clip(event, 200) })}\n`,
          );
        }
        return exitForFailures(op, result.codes, failureCodes) || 1;
      }
      if (!args.json) {
        process.stdout.write(`${op} ok  seq=${clip((event as Record<string, unknown>)["seq"], 12)}  ${result.codes.join(" ")}\n`);
      }
      summary[op] = { ok: true, codes: result.codes, written: events.length };
    }
  }

  if (args.version) {
    const current = store.version(args.root);
    summary["version"] = current;
    if (!args.json) process.stdout.write(`contentGeneration=${current}\n`);
  }
  if (args.transcript) {
    const built = store.transcript(args.root);
    summary["transcript"] = built.events;
    if (!args.json) {
      if (built.events.length === 0) process.stdout.write("(empty)\n");
      for (const event of built.events) {
        process.stdout.write(
          `#${String(event["seq"])}  ${String(event["kind"])}  ${clip(event["content"], 70)}\n`,
        );
      }
    }
  }
  if (args.report) {
    const built = store.report(args.root);
    summary["report"] = built;
    if (!args.json) {
      process.stdout.write(
        `events=${(built["events"] as unknown[]).length}  contentGeneration=${String(built["contentGeneration"])}  ` +
          `appendOrigin=[${(built["appendOrigin"] as number[]).join(",")}]  shadowed=[${(built["shadowed"] as number[]).join(",")}]\n`,
      );
      const broken = built["broken"] as { ok: boolean; issues: Array<Record<string, unknown>> };
      process.stdout.write(`broken=${broken.ok ? "false" : "true"}\n`);
      for (const issue of broken.issues) {
        process.stdout.write(`  ! ${String(issue["code"])}  seq=${String(issue["seq"] ?? "-")}  ${String(issue["detail"] ?? "")}\n`);
      }
    }
  }

  if (args.json) process.stdout.write(`${JSON.stringify(summary)}\n`);
  return 0;
}

process.exitCode = await main();
