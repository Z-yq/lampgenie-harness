#!/usr/bin/env -S npx tsx
/**
 * 外部事件源插件 CLI(tsx / node --experimental-strip-types 直跑):
 * kind / instance / write / replay / claim / report。
 *
 * 落盘:`<root>/.genie/rsi/sources.json`(单文件快照,含 nextSeq);
 * store 每次调用都重读盘(热加载,无需重启进程)。真源:
 * apps/gateway/src/source-store.ts,语义在 packages/harness-runtime/src/agent/source-registry.ts。
 *
 * 用法:
 *   tsx scripts/source-plugin.mts --help
 *   tsx scripts/source-plugin.mts --root /tmp/sp --kind /tmp/sp/mail.kind.json
 *   tsx scripts/source-plugin.mts --root /tmp/sp --instance /tmp/sp/i1.json
 *   tsx scripts/source-plugin.mts --root /tmp/sp --write /tmp/sp/ev.json
 *   tsx scripts/source-plugin.mts --root /tmp/sp --replay --instance i1 [--from 3] [--json]
 *   tsx scripts/source-plugin.mts --root /tmp/sp --claim --instance i1 --key mail-heartbeat
 *   tsx scripts/source-plugin.mts --root /tmp/sp --report [--json]
 *
 * --instance 消歧:同一命令行出现 --replay 或 --claim 时,`--instance` 的值是**实例 id**;
 * 否则 `--instance` 的值是**实例定义文件路径**(JSON:`{id,kind,config?,enabled?}`)。
 *
 * 退出码:
 *   0 成功
 *   1 参数错误(缺 --root / 未知参数 / 缺必填取值 / 文件读不到 / JSON 非法 / 缺子命令 /
 *     子命令互斥冲突 / store 返回的码不在下列业务码表内,如 SOURCE_WRITE_FAILED)
 *   2 业务拒绝(SOURCE_RESERVED_NAME / SOURCE_DUPLICATE_KIND / SOURCE_UNKNOWN_KIND /
 *     SOURCE_CONFIG_INVALID / SOURCE_CLAIM_CONFLICT / SOURCE_HEALTH_CLAIM_DUPLICATE /
 *     SOURCE_DISABLED / SOURCE_INVALID)
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

/** 业务拒绝码(命中即 exit 2;其余失败码按参数/IO 错误折成 exit 1)。 */
const BUSINESS_CODES = new Set<string>([
  "SOURCE_RESERVED_NAME",
  "SOURCE_DUPLICATE_KIND",
  "SOURCE_UNKNOWN_KIND",
  "SOURCE_CONFIG_INVALID",
  "SOURCE_CLAIM_CONFLICT",
  "SOURCE_HEALTH_CLAIM_DUPLICATE",
  "SOURCE_DISABLED",
  "SOURCE_INVALID",
]);

interface SourceKindView {
  kind: string;
  schema: string;
  title?: string;
}

interface SourceInstanceView {
  id: string;
  kind: string;
  enabled: boolean;
  claims: string[];
}

interface SourceEventView {
  seq: number;
  instanceId: string;
  type: string;
}

interface StoreResult {
  ok: boolean;
  code: string;
  codes?: string[];
  path: string;
  reason?: string;
}

/** store 面(惰性解析:--help 不触发任何 import;签名以 apps/gateway/src/source-store.ts 为准)。 */
interface StoreModule {
  registerSourceKind(
    root: string,
    kind: unknown,
  ): StoreResult & { kind?: SourceKindView };
  registerSourceInstance(
    root: string,
    input: { id: string; kind: string; config?: Record<string, unknown>; enabled?: boolean },
  ): StoreResult & { instance?: SourceInstanceView };
  writeSourceEvent(
    root: string,
    input: { instanceId: string; event: { type: string; payload?: Record<string, unknown>; at?: number }; at?: number },
  ): StoreResult & { seq?: number };
  replaySource(
    root: string,
    input: { instanceId?: string; fromSeq?: number },
  ): StoreResult & { events: SourceEventView[] };
  claimSourceHealth(root: string, input: { instanceId: string; key: string }): StoreResult & { claimId?: string };
  reportSources(root: string): {
    ok: boolean;
    kinds: string[];
    enabled: string[];
    disabled: string[];
    claims: string[];
    events: number;
    nextSeq: number;
    text: string;
    path: string;
  };
}

const USAGE = `外部事件源插件 CLI(kind / instance / write / replay / claim / report)

用法:
  source-plugin --root <dir> --kind <kind.json>
  source-plugin --root <dir> --instance <instance.json>
  source-plugin --root <dir> --write <event.json>
  source-plugin --root <dir> --replay --instance <id> [--from <seq>]
  source-plugin --root <dir> --claim --instance <id> --key <k>
  source-plugin --root <dir> --report [--json]
  source-plugin --help

子命令:
  --kind <file>      注册 SourceKind(文件内容 = SourceKind JSON)
  --instance <file>  注册实例(文件内容 = {id,kind,config?,enabled?})
  --write <file>     写事件(文件内容 = {instanceId, event:{type,payload?,at?}, at?})
  --replay           重放事件(seq > --from,缺省 0)
  --claim            health 认领(占全局 claim 位)
  --report           汇总报表(kinds/enabled/disabled/claims/events/nextSeq)
  --json             机器可读输出(单行 JSON)
  --help, -h         打印本用法

--instance 消歧:
  同一命令行出现 --replay 或 --claim 时,--instance 的值是**实例 id**;
  否则 --instance 的值是**实例定义文件路径**(JSON:{id,kind,config?,enabled?})。

退出码:
  0 成功
  1 参数错误(缺 --root / 未知参数 / 缺必填取值 / 文件读不到 / JSON 非法 / 缺子命令 / 子命令冲突 / 非业务失败码)
  2 业务拒绝(SOURCE_RESERVED_NAME / SOURCE_DUPLICATE_KIND / SOURCE_UNKNOWN_KIND /
    SOURCE_CONFIG_INVALID / SOURCE_CLAIM_CONFLICT / SOURCE_HEALTH_CLAIM_DUPLICATE /
    SOURCE_DISABLED / SOURCE_INVALID)

输出约定:
  成功  OK <code> + 明细行;--json 输出 {"ok":true,"code":"SOURCE_WROTE","seq":1,...}
  失败  EXIT <code> <reason>(stderr);--json 输出 {"ok":false,"code":...,"reason":...}
`;

interface ParsedArgs {
  root?: string;
  help: boolean;
  json: boolean;
  kind?: string;
  instance?: string;
  write?: string;
  replay: boolean;
  claim: boolean;
  key?: string;
  from?: string;
  report: boolean;
  rest: string[];
}

/** 手写 argv 解析:--key value 与开关两种;未知选项抛错(由 main 折成 exit 1)。 */
function parseArgv(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { help: false, json: false, replay: false, claim: false, report: false, rest: [] };
  const valueOf = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} 缺少取值`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case "--help":
      case "-h":
        out.help = true;
        break;
      case "--root":
        out.root = valueOf(i, arg);
        i += 1;
        break;
      case "--kind":
        out.kind = valueOf(i, arg);
        i += 1;
        break;
      case "--instance":
        out.instance = valueOf(i, arg);
        i += 1;
        break;
      case "--write":
        out.write = valueOf(i, arg);
        i += 1;
        break;
      case "--replay":
        out.replay = true;
        break;
      case "--claim":
        out.claim = true;
        break;
      case "--key":
        out.key = valueOf(i, arg);
        i += 1;
        break;
      case "--from":
        out.from = valueOf(i, arg);
        i += 1;
        break;
      case "--report":
        out.report = true;
        break;
      case "--json":
        out.json = true;
        break;
      default:
        if (arg.startsWith("-") && arg !== "-") throw new Error(`未知参数:${arg}`);
        out.rest.push(arg);
        break;
    }
  }
  return out;
}

/** 惰性加载 store:--help / 参数错误都不会触发模块加载。 */
async function loadStore(): Promise<StoreModule> {
  const url = new URL("../apps/gateway/src/source-store.ts", import.meta.url).href;
  return (await import(url)) as unknown as StoreModule;
}

async function readJsonFile(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`读不到文件:${path} (${error instanceof Error ? error.message : String(error)})`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`JSON 非法:${path} (${error instanceof Error ? error.message : String(error)})`);
  }
}

function emitOk(code: string, details: string[]): void {
  process.stdout.write(`${[`OK ${code}`, ...details].join("\n")}\n`);
}

/** 失败:code 属业务码 → 2,否则 1(参数/IO/未知码)。 */
function emitFail(result: { code: string; reason?: string }, json: boolean): number {
  const reason = typeof result.reason === "string" && result.reason.length > 0 ? result.reason : "(无原因)";
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, code: result.code, reason })}\n`);
  else process.stderr.write(`EXIT ${result.code} ${reason}\n`);
  return BUSINESS_CODES.has(result.code) ? 2 : 1;
}

function parseFrom(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`--from 必须是非负数字,收到:${raw}`);
  return value;
}

async function main(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgv(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.root === undefined || args.root.trim() === "") {
    process.stderr.write("缺少 --root <dir>(见 --help)\n");
    return 1;
  }
  const root = resolve(args.root);

  // 子命令定位:--replay / --claim 在场时 --instance 是 id,否则是文件路径。
  const instanceIsId = args.replay || args.claim;
  const instanceFile = instanceIsId ? undefined : args.instance;
  const ops = [
    args.kind !== undefined ? "--kind" : undefined,
    args.write !== undefined ? "--write" : undefined,
    args.replay ? "--replay" : undefined,
    args.claim ? "--claim" : undefined,
    args.report ? "--report" : undefined,
    instanceFile !== undefined ? "--instance" : undefined,
  ].filter((item): item is string => item !== undefined);
  if (ops.length === 0) {
    process.stderr.write("缺少子命令(见 --help:--kind/--instance/--write/--replay/--claim/--report)\n");
    return 1;
  }
  if (ops.length > 1) {
    process.stderr.write(`子命令互斥,一次只能跑一个,收到:${ops.join(", ")}\n`);
    return 1;
  }

  if (args.replay && args.instance === undefined) {
    process.stderr.write("--replay 需要 --instance <id>\n");
    return 1;
  }
  if (args.claim && (args.instance === undefined || args.key === undefined)) {
    process.stderr.write("--claim 需要 --instance <id> 与 --key <k>\n");
    return 1;
  }
  let fromSeq: number | undefined;
  try {
    fromSeq = parseFrom(args.from);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const store = await loadStore();

  // ---- kind ----
  if (args.kind !== undefined) {
    let kind: unknown;
    try {
      kind = await readJsonFile(args.kind);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    const res = store.registerSourceKind(root, kind);
    if (!res.ok) return emitFail(res, args.json);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(res)}\n`);
      return 0;
    }
    emitOk(res.code, [`kind: ${res.kind?.kind ?? ""}`, `schema: ${res.kind?.schema ?? ""}`, `path: ${res.path}`]);
    return 0;
  }

  // ---- instance(文件) ----
  if (instanceFile !== undefined) {
    let input: unknown;
    try {
      input = await readJsonFile(instanceFile);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    const res = store.registerSourceInstance(root, input as { id: string; kind: string });
    if (!res.ok) return emitFail(res, args.json);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(res)}\n`);
      return 0;
    }
    emitOk(res.code, [
      `instance: ${res.instance?.id ?? ""} (kind=${res.instance?.kind ?? ""}, enabled=${String(res.instance?.enabled ?? false)})`,
      `claims: ${(res.instance?.claims ?? []).length === 0 ? "(无)" : (res.instance?.claims ?? []).join(", ")}`,
      `path: ${res.path}`,
    ]);
    return 0;
  }

  // ---- write ----
  if (args.write !== undefined) {
    let input: unknown;
    try {
      input = await readJsonFile(args.write);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    const res = store.writeSourceEvent(root, input as { instanceId: string; event: { type: string } });
    if (!res.ok) return emitFail(res, args.json);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(res)}\n`);
      return 0;
    }
    emitOk(res.code, [`seq: ${res.seq ?? 0}`, `path: ${res.path}`]);
    return 0;
  }

  // ---- replay ----
  if (args.replay) {
    const res = store.replaySource(root, {
      instanceId: args.instance,
      ...(fromSeq === undefined ? {} : { fromSeq }),
    });
    if (!res.ok) return emitFail(res, args.json);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(res)}\n`);
      return 0;
    }
    const detail = res.events.map((event) => `  - seq=${event.seq} instance=${event.instanceId} type=${event.type}`);
    emitOk(res.code, [`events(${res.events.length}):`, ...(detail.length === 0 ? ["  (无)"] : detail), `path: ${res.path}`]);
    return 0;
  }

  // ---- claim ----
  if (args.claim) {
    const res = store.claimSourceHealth(root, { instanceId: args.instance ?? "", key: args.key ?? "" });
    if (!res.ok) return emitFail(res, args.json);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(res)}\n`);
      return 0;
    }
    emitOk(res.code, [`claim: ${res.claimId ?? ""}`, `path: ${res.path}`]);
    return 0;
  }

  // ---- report ----
  if (args.report) {
    const report = store.reportSources(root);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
      return 0;
    }
    process.stdout.write(`OK SOURCE_REPORTED\n${report.text}`);
    return 0;
  }

  process.stderr.write("未知子命令(见 --help:--kind/--instance/--write/--replay/--claim/--report)\n");
  return 1;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`source 插件 CLI 失败:${(err as Error)?.message ?? String(err)}\n`);
    process.exitCode = 1;
  });
