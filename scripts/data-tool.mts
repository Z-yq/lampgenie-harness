#!/usr/bin/env -S npx tsx
/**
 * data 层工具 CLI(tsx / node --experimental-strip-types 直跑):
 * register / unregister / list / resolve / pin / doctor / report。
 * 落盘:`<root>/.genie/rsi/tools/<name>.json` + `<root>/.genie/rsi/tool-pins.json`;
 * store 每次调用都重读目录(热加载,无需重启进程)。真源:
 * apps/gateway/src/data-tool-store.ts,语义在 packages/harness-runtime/src/agent/data-tool-registry.ts。
 * 用法:
 * tsx scripts/data-tool.mts --help
 * tsx scripts/data-tool.mts --root /tmp/dt --register /tmp/dt/cache_probe.json [--native a,b] [--approve <by>] [--approver-kind human|owner|agent]
 * cat spec.json | tsx scripts/data-tool.mts --root /tmp/dt --register -
 * tsx scripts/data-tool.mts --root /tmp/dt --unregister <name>
 * tsx scripts/data-tool.mts --root /tmp/dt --list [--json]
 * tsx scripts/data-tool.mts --root /tmp/dt --resolve <name> [--session <id>]
 * tsx scripts/data-tool.mts --root /tmp/dt --pin <session> <name> <version>
 * tsx scripts/data-tool.mts --root /tmp/dt --doctor [--env <envfile.json>]
 * tsx scripts/data-tool.mts --root /tmp/dt --report [--json]
 * 退出码:
 * 0 成功
 * 1 参数错误(缺 --root / 未知子命令 / 缺必填位置参数 / spec 读不到或 JSON 非法 / --env 非法 /
 * store 返回 ok:false 且 codes 里没有任何已知业务码)
 * 2 被拒: DATA_TOOL_NATIVE_IMMUTABLE / DATA_TOOL_NEEDS_APPROVAL / DATA_TOOL_INVALID / 任何 MOD_* 码
 * 3 重复/陈旧/不存在: DATA_TOOL_DUPLICATE / DATA_TOOL_VERSION_STALE / DATA_TOOL_PIN_UNKNOWN / DATA_TOOL_UNREGISTERED
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

type ApproverKind = "human" | "owner" | "agent";

/** 依赖体检输入(与 store 的 DoctorEnv 同形)。 */
interface DoctorEnvView {
  binaries?: string[];
  envVars?: string[];
  files?: string[];
  mcpMethods?: string[];
}

interface DataToolEntryView {
  name: string;
  version: string;
  degraded?: string[];
  shadowOf?: string;
  wrapOf?: string;
}

/** store 面(惰性解析:--help 不触发任何 import;签名以 apps/gateway/src/data-tool-store.ts 为准)。 */
interface StoreModule {
  registerDataTool(
    root: string,
    spec: unknown,
    opts?: {
      nativeNames?: string[];
      approval?: { ok?: boolean; by?: string; kind?: ApproverKind };
      now?: number;
    },
  ): {
    ok: boolean;
    codes: string[];
    reason?: string;
    spec?: { name: string; version: string };
    gate?: { decision: string; codes: string[]; details?: string[] };
  };
  unregisterDataTool(
    root: string,
    name: string): { ok: boolean; codes: string[]; restored?: string; reason?: string };
  listToolStore(
    root: string,
    opts?: { nativeNames?: string[]; pluginNames?: string[] },
  ): {
    native: string[];
    data: DataToolEntryView[];
    plugin: string[];
    degraded: Record<string, string[]>;
    pins: Record<string, Record<string, string>>;
    bad: Array<{ file: string; reason: string }>;
  };
  resolveDataTool(
    root: string,
    name: string,
    opts?: { sessionId?: string },
  ): {
    spec?: { name: string; version: string };
    layer: "native" | "data" | "plugin";
    degraded?: string[];
    codes: string[];
  };
  pinDataTool(
    root: string,
    sessionId: string,
    name: string,
    version: string): { ok: boolean; pins: Record<string, Record<string, string>>; codes: string[]; reason?: string };
  doctorDataTools(
    root: string,
    env: DoctorEnvView): {
    ok: boolean;
    missing: Array<{ name: string; kind: string; dep: string }>;
    degraded: string[];
    codes: string[];
  };
  reportTools(root: string, opts?: { env?: DoctorEnvView; nativeNames?: string[]; pluginNames?: string[] }): {
    ok: boolean;
    dir: string;
    files: string[];
    native: string[];
    data: DataToolEntryView[];
    plugin: string[];
    degraded: Record<string, string[]>;
    pins: Record<string, Record<string, string>>;
    bad: Array<{ file: string; reason: string }>;
  };
}

const USAGE = `data 层工具 CLI(register / unregister / list / resolve / pin / doctor / report)

用法:
  data-tool --root <dir> --register <spec.json|-> [--native <name,name>] [--approve <by>] [--approver-kind human|owner|agent]
  data-tool --root <dir> --unregister <name>
  data-tool --root <dir> --list [--json]
  data-tool --root <dir> --resolve <name> [--session <id>] [--json]
  data-tool --root <dir> --pin <session> <name> <version> [--json]
  data-tool --root <dir> --doctor [--env <envfile.json>] [--json]
  data-tool --root <dir> --report [--json]
  data-tool --help

子命令:
  --register <src>   注册/升级 data 工具;src 为 spec JSON 路径,"-" 从 stdin 读
  --unregister <n>   卸载 data 工具(删文件 + 清理钉扎)
  --list             列 native / data / plugin / degraded / bad
  --resolve <n>      解析生效工具(session 钉扎 > data 当前版本 > native)
  --pin <s> <n> <v>  把 session 钉到某版本
  --doctor           依赖体检(binaries/envVars/files/mcpMethods)
  --report           汇总报表(目录/文件/三层/钉扎/坏文件)
  --help, -h         打印本用法

选项:
  --root <dir>                必需(除 --help);落盘在 <root>/.genie/rsi/**
 --native <name,name> --register 时的原生工具名单(逗号分隔,缺省空)
 --approve <by> 模拟人类批准(传给 store 的 approval.by)
 --approver-kind <kind> human | owner | agent(缺省 human)
 --session <id> --resolve 的 session(取钉扎版本)
 --env <file> --doctor 的依赖环境 JSON:{binaries?,envVars?,files?,mcpMethods?}
 --json 只输出一行 JSON

退出码:
 0 成功
 1 参数错误(缺 --root / 未知子命令 / 缺必填位置参数 / spec 读不到或 JSON 非法 / --env 非法 /
 store 返回 ok:false 且 codes 里没有任何已知业务码)
 2 被拒:DATA_TOOL_NATIVE_IMMUTABLE / DATA_TOOL_NEEDS_APPROVAL / DATA_TOOL_INVALID / 任何 MOD_* 码
 3 重复/陈旧/不存在:DATA_TOOL_DUPLICATE / DATA_TOOL_VERSION_STALE / DATA_TOOL_PIN_UNKNOWN / DATA_TOOL_UNREGISTERED
`;

interface ParsedArgs {
 root?: string;
 help: boolean;
 json: boolean;
 register?: string;
 native?: string;
 approve?: string;
 approverKind?: string;
 unregister?: string;
 list: boolean;
 resolve?: string;
 session?: string;
 pin: boolean;
 doctor: boolean;
 env?: string;
 report: boolean;
 rest: string[];
}

/** 手写 argv 解析:--key value 与开关两种;未知选项抛错(由 main 折成 exit 1)。 */
function parseArgv(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { help: false, json: false, list: false, pin: false, doctor: false, report: false, rest: [] };
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
      case "--register":
        out.register = valueOf(i, arg);
        i += 1;
        break;
      case "--native":
        out.native = valueOf(i, arg);
        i += 1;
        break;
      case "--approve":
        out.approve = valueOf(i, arg);
        i += 1;
        break;
      case "--approver-kind":
        out.approverKind = valueOf(i, arg);
        i += 1;
        break;
      case "--unregister":
        out.unregister = valueOf(i, arg);
        i += 1;
        break;
      case "--list":
        out.list = true;
        break;
      case "--resolve":
        out.resolve = valueOf(i, arg);
        i += 1;
        break;
      case "--session":
        out.session = valueOf(i, arg);
        i += 1;
        break;
      case "--pin":
        out.pin = true;
        break;
      case "--doctor":
        out.doctor = true;
        break;
      case "--env":
        out.env = valueOf(i, arg);
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

async function loadStore(): Promise<StoreModule> {
  return (await import(new URL("../apps/gateway/src/data-tool-store.ts", import.meta.url).href)) as unknown as StoreModule;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonSource(src: string): Promise<unknown> {
  let text: string;
  try {
    text = src === "-" ? await readStdin() : await readFile(resolve(src), "utf8");
  } catch (error) {
    throw new Error(`读 spec 失败(${src}): ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`spec 不是合法 JSON(${src}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readDoctorEnv(src: string | undefined): Promise<DoctorEnvView> {
  if (src === undefined) return {};
  let text: string;
  try {
    text = await readFile(resolve(src), "utf8");
  } catch (error) {
    throw new Error(`读 --env 文件失败(${src}): ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`--env 文件不是合法 JSON(${src}): ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error(`--env 文件必须是 JSON 对象(${src})`);
  const out: DoctorEnvView = {};
  for (const key of ["binaries", "envVars", "files", "mcpMethods"] as const) {
    const value = parsed[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw new Error(`--env.${key} 必须是字符串数组(${src})`);
    }
    out[key] = value as string[];
  }
  return out;
}

function splitList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

const DENY_CODES = new Set(["DATA_TOOL_NATIVE_IMMUTABLE", "DATA_TOOL_NEEDS_APPROVAL", "DATA_TOOL_INVALID"]);
const DUP_CODES = new Set([
  "DATA_TOOL_DUPLICATE",
  "DATA_TOOL_VERSION_STALE",
  "DATA_TOOL_PIN_UNKNOWN",
  "DATA_TOOL_UNREGISTERED",
]);

/** 业务码 → exit(2 高于 3);无业务码返回 undefined(由调用方决定成功 0 或失败 1)。 */
function businessExit(codes: string[]): number | undefined {
  if (codes.some((code) => DENY_CODES.has(code) || code.startsWith("MOD_"))) return 2;
  if (codes.some((code) => DUP_CODES.has(code))) return 3;
  return undefined;
}

function failureExit(codes: string[]): number {
  return businessExit(codes) ?? 1;
}

function codesLine(codes: string[] | undefined): string {
  return codes === undefined || codes.length === 0 ? "(none)" : codes.join(", ");
}

function fail(res: { codes?: string[]; reason?: string }, label: string): void {
  if (res.reason !== undefined && res.reason !== "") process.stderr.write(`${label}: ${res.reason}\n`);
  process.stderr.write(`codes: ${codesLine(res.codes)}\n`);
}

function marks(entry: DataToolEntryView): string {
  const out: string[] = [];
  if (entry.shadowOf !== undefined) out.push("[shadow]");
  if (entry.wrapOf !== undefined) out.push("[wrap]");
  if ((entry.degraded ?? []).length > 0) out.push("[degraded]");
  return out.join(" ");
}

function formatDataList(entries: DataToolEntryView[]): string {
  if (entries.length === 0) return "  (无 data 工具)";
  return entries
    .map((entry) => {
      const tag = marks(entry);
      return `  ${entry.name}@${entry.version}${tag === "" ? "" : ` ${tag}`}`;
    })
    .join("\n");
}

function formatPins(pins: Record<string, Record<string, string>>): string {
  const sessions = Object.keys(pins).filter((sessionId) => Object.keys(pins[sessionId] ?? {}).length > 0);
  if (sessions.length === 0) return "(无钉扎)";
  return sessions
    .map((sessionId) => {
      const row = pins[sessionId] ?? {};
      const pairs = Object.keys(row).map((name) => `${sessionId} -> ${name}@${row[name]}`);
      return pairs.join(", ");
    })
    .join("; ");
}

function formatDegraded(degraded: Record<string, string[]>): string {
  const names = Object.keys(degraded);
  if (names.length === 0) return "(无降级)";
  return names.map((name) => `${name}: ${(degraded[name] ?? []).join(", ")}`).join("; ");
}

/** 从 --approve / spec.approval 组装 store 的 approval 面。 */
function approvalOf(args: ParsedArgs, spec: unknown): { ok?: boolean; by?: string; kind?: ApproverKind } | undefined {
  if (args.approve !== undefined) {
    const kind = (args.approverKind ?? "human") as ApproverKind;
    return { ok: true, by: args.approve, kind };
  }
  if (isRecord(spec) && isRecord(spec.approval) && spec.approval.ok === true) {
    const by = typeof spec.approval.approverId === "string" ? spec.approval.approverId : undefined;
    const rawKind = spec.approval.approverKind;
    const kind = rawKind === "human" || rawKind === "owner" || rawKind === "agent" ? rawKind : undefined;
    return { ok: true, ...(by === undefined ? {} : { by }), ...(kind === undefined ? {} : { kind }) };
  }
  return undefined;
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
  const nativeNames = splitList(args.native);
  if (args.approverKind !== undefined && !["human", "owner", "agent"].includes(args.approverKind)) {
    process.stderr.write(`--approver-kind 只允许 human|owner|agent,收到:${args.approverKind}\n`);
    return 1;
  }

  const store = await loadStore();

 // ---- register ----
  if (args.register !== undefined) {
    let spec: unknown;
    try {
      spec = await readJsonSource(args.register);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    const approval = approvalOf(args, spec);
    const res = store.registerDataTool(root, spec, { nativeNames, ...(approval === undefined ? {} : { approval }) });
    if (!res.ok) {
      fail(res, "注册失败");
      return failureExit(res.codes);
    }
    if (args.json) {
      process.stdout.write(`${JSON.stringify(res)}\n`);
      return 0;
    }
    const name = res.spec?.name ?? "";
    const version = res.spec?.version ?? "";
    process.stdout.write(`registered: ${name}@${version} (codes=${codesLine(res.codes)})\n`);
    return 0;
  }

 // ---- unregister ----
  if (args.unregister !== undefined) {
    const res = store.unregisterDataTool(root, args.unregister);
    if (!res.ok) {
      fail(res, "卸载失败");
      return failureExit(res.codes);
    }
    if (args.json) {
      process.stdout.write(`${JSON.stringify(res)}\n`);
      return 0;
    }
    const restored = res.restored === undefined ? "" : ` restored=${res.restored}`;
    process.stdout.write(`unregistered ${args.unregister}${restored} (codes=${codesLine(res.codes)})\n`);
    return 0;
  }

 // ---- list ----
  if (args.list) {
    const listed = store.listToolStore(root, { nativeNames });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(listed)}\n`);
      return 0;
    }
    const lines = [
      `native(${listed.native.length}): ${listed.native.length === 0 ? "(无)" : listed.native.join(", ")}`,
      `data(${listed.data.length}):`,
      formatDataList(listed.data),
      `plugin(${listed.plugin.length}): ${listed.plugin.length === 0 ? "(无)" : listed.plugin.join(", ")}`,
      `degraded: ${formatDegraded(listed.degraded)}`,
      `bad: ${listed.bad.length}`,
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  }

 // ---- resolve ----
  if (args.resolve !== undefined) {
    const res = store.resolveDataTool(root, args.resolve, { ...(args.session === undefined ? {} : { sessionId: args.session }) });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(res)}\n`);
      return businessExit(res.codes) ?? 0;
    }
    const head = res.spec === undefined ? args.resolve : `${res.spec.name}@${res.spec.version}`;
    const degraded = (res.degraded ?? []).length === 0 ? "" : `, degraded=${(res.degraded ?? []).join(",")}`;
    process.stdout.write(`${head} (layer=${res.layer}, codes=${res.codes.join(",")}${degraded})\n`);
    return businessExit(res.codes) ?? 0;
  }

 // ---- pin ----
  if (args.pin) {
    if (args.rest.length < 3) {
      process.stderr.write("--pin 需要三个位置参数:<session> <name> <version>\n");
      return 1;
    }
    const [sessionId, name, version] = args.rest as [string, string, string];
    const res = store.pinDataTool(root, sessionId, name, version);
    if (!res.ok) {
      fail(res, "钉扎失败");
      return failureExit(res.codes);
    }
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ok: res.ok, pins: res.pins, codes: res.codes })}\n`);
      return 0;
    }
    process.stdout.write(`pinned ${sessionId} -> ${name}@${version} (codes=${codesLine(res.codes)})\n`);
    return 0;
  }

 // ---- doctor ----
  if (args.doctor) {
    let env: DoctorEnvView;
    try {
      env = await readDoctorEnv(args.env);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    const res = store.doctorDataTools(root, env);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(res)}\n`);
      return res.codes.includes("DATA_TOOL_INVALID") ? failureExit(res.codes) : 0;
    }
    if (res.missing.length === 0 && res.degraded.length === 0 && res.codes.length === 0) {
      process.stdout.write("doctor: ok\n");
      return 0;
    }
    const lines = [
      `missing: ${res.missing.length}`,
      ...res.missing.map((item) => `  - ${item.name} ${item.kind}:${item.dep}`),
      `degraded: ${res.degraded.length === 0 ? "(无)" : res.degraded.join(", ")}`,
      `codes: ${codesLine(res.codes)}`,
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
 // 缺失/降级本身不算失败(降级仍是可用工具)
    return res.codes.includes("DATA_TOOL_INVALID") ? failureExit(res.codes) : 0;
  }

 // ---- report ----
  if (args.report) {
    let reportEnv: DoctorEnvView | undefined;
    if (args.env !== undefined) {
      try {
        reportEnv = await readDoctorEnv(args.env);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
    }
    const report = store.reportTools(root, {
      ...(reportEnv === undefined ? {} : { env: reportEnv }),
      nativeNames: splitList(args.native),
    });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
      return 0;
    }
    const lines = [
      `dir: ${report.dir}`,
      `files: ${report.files.length}`,
      `native: ${report.native.length}`,
      `data(${report.data.length}):`,
      formatDataList(report.data),
      `plugin(${report.plugin.length}): ${report.plugin.length === 0 ? "(无)" : report.plugin.join(", ")}`,
      `degraded: ${formatDegraded(report.degraded)}`,
      `pins: ${formatPins(report.pins)}`,
      `bad: ${report.bad.length}`,
      ...report.bad.map((item) => `  - ${item.file}: ${item.reason}`),
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  }

  process.stderr.write("未知子命令(见 --help:--register/--unregister/--list/--resolve/--pin/--doctor/--report)\n");
  return 1;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`data 工具 CLI 失败:${(err as Error)?.message ?? String(err)}\n`);
    process.exitCode = 1;
  });
