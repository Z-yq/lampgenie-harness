#!/usr/bin/env node
/**
 * 工具热升级 CLI(工具热升级 2026-11):init / shadow / canary / switch / rollback / retire / resolve /
 * native-plan / list / report。
 *
 * 纯表面层:段位状态机与判据在
 *   packages/harness-runtime/src/agent/tool-upgrade-protocol.ts(纯逻辑)
 *   apps/gateway/src/tool-upgrade-store.ts(.genie/rsi/tool-upgrades.jsonl 追加事件 + 投影,
 *   并负责把 switch 的实验台账、rollback 的熔断闸门串起来)
 * 本文件只做 argv 解析、调 store、把 codes 映射成退出码。不自己判段位、不自己写台账。
 *
 * 退出码:0 成功 / 1 参数错(未知 flag、缺必填、TOOL_UP_INVALID、alias 冲突、重复版本)
 *         2 门或状态拒绝(TOOL_UP_STAGE_ORDER / TOOL_UP_KEEP_WINDOW_ACTIVE / TOOL_UP_NATIVE_STRATEGY)
 *         3 不存在(TOOL_UP_NOT_FOUND)
 * `--help` 或无参 → 打印用法并退出 0;`--json` → 输出 {ok, codes, exitCode, ...payload}。
 */
import {
  initUpgrade,
  listUpgrades,
  promoteCanary,
  reportUpgrades,
  resolveCall,
  retireVersion,
  rollbackVersion,
  startShadow,
  switchVersion,
} from "../apps/gateway/src/tool-upgrade-store.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_REJECTED = 2;
const EXIT_NOT_FOUND = 3;

/** 协议稳定码(字面量:CLI 不能静态 import 未 build 的 runtime 包,码是公开契约)。 */
const CODE_INVALID = "TOOL_UP_INVALID";
const CODE_NOT_FOUND = "TOOL_UP_NOT_FOUND";
const CODE_STAGE_ORDER = "TOOL_UP_STAGE_ORDER";
const CODE_KEEP_WINDOW = "TOOL_UP_KEEP_WINDOW_ACTIVE";
const CODE_NATIVE_STRATEGY = "TOOL_UP_NATIVE_STRATEGY";

const VALUE_FLAGS = new Set([
  "root",
  "name",
  "version",
  "alias",
  "scope",
  "percent",
  "session",
  "project",
  "to",
  "reason",
  "experiment-root",
  "breaker-root",
  "kind",
  "ref",
  "successor",
]);

const BOOL_FLAGS = new Set([
  "init",
  "shadow",
  "canary",
  "switch",
  "rollback",
  "retire",
  "resolve",
  "native-plan",
  "list",
  "report",
  "json",
  "help",
]);

const SUBCOMMANDS = [
  "init",
  "shadow",
  "canary",
  "switch",
  "rollback",
  "retire",
  "resolve",
  "native-plan",
  "list",
  "report",
] as const;

type Subcommand = (typeof SUBCOMMANDS)[number];

/** 需要工具名的子命令(允许 `--init svc` 这种「值紧跟子命令」写法)。 */
const NAMED_SUBCOMMANDS: ReadonlySet<string> = new Set<string>([
  "init",
  "shadow",
  "canary",
  "switch",
  "rollback",
  "retire",
  "resolve",
]);

interface Parsed {
  values: Map<string, string>;
  flags: Set<string>;
  unknown: string[];
}

function parseArgs(argv: string[]): Parsed {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const unknown: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i] ?? "";
    if (!raw.startsWith("--")) continue;
    const key = raw.slice(2);
    if (VALUE_FLAGS.has(key)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        values.set(key, "");
        continue;
      }
      values.set(key, next);
      i += 1;
      continue;
    }
    if (BOOL_FLAGS.has(key)) {
      flags.add(key);
      // 形如 `--init svc`:子命令后面直接跟工具名(等价 `--name svc`)。
      if (NAMED_SUBCOMMANDS.has(key) && !values.has("name")) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          values.set("name", next);
          i += 1;
        }
      }
      continue;
    }
    unknown.push(raw);
  }
  return { values, flags, unknown };
}

/** runtime 面(只用到 nativeUpgradePlan;签名以协议文件为准)。 */
interface NativePlanShape {
  ok: boolean;
  codes: string[];
  [key: string]: unknown;
}

interface ToolUpgradeRuntime {
  nativeUpgradePlan(opts: { kind: "wrap" | "demote" | "tips"; ref: string; successor?: string }): NativePlanShape;
}

let runtime: ToolUpgradeRuntime | undefined;

/** 两跳解析 runtime(同 store 的纪律):spec 解析不到未 build 的 dist 时回退相对 src URL。 */
async function loadRuntime(): Promise<ToolUpgradeRuntime> {
  if (runtime !== undefined) return runtime;
  const spec = "@lampgenie/runtime/agent/tool-upgrade-protocol";
  try {
    runtime = (await import(spec)) as unknown as ToolUpgradeRuntime;
  } catch {
    const srcUrl = new URL("../packages/harness-runtime/src/agent/tool-upgrade-protocol.ts", import.meta.url).href;
    runtime = (await import(srcUrl)) as unknown as ToolUpgradeRuntime;
  }
  return runtime;
}

const USAGE = `用法: node --experimental-strip-types scripts/tool-upgrade.mts <子命令> [选项]

子命令:
  --init <name> --version <v>                              首个版本落盘(current=v)
  --shadow <name> --version <v> --alias <a>                起影子版,挂到别名槽位
  --canary <name> --version <v> --scope session|project|percent [--percent n]
                                                           灰度:配置分流口径(percent 缺省 0)
  --switch <name> --version <v> [--experiment-root <dir>]  新版接管 current(可选同步写 #192 实验台账)
  --rollback <name> --to <v> [--breaker-root <dir>] [--reason s]
                                                           回滚 current(可选同时熔断)
  --retire <name> --version <v>                            下线版本(保留窗口没走完会被拒)
  --resolve <name> [--session s] [--project p] [--alias a]  解析一次调用落哪个版本
  --native-plan --kind wrap|demote|tips --ref <r> [--successor s]
                                                           原生兼容策略计划
  --list [--name n]                                        台账列表
  --report                                                 台账报告(含 warnings/path)

通用: --root <dir>(台账根,缺省当前目录) --json --help
退出码: 0 成功 / 1 参数错 / 2 门或状态拒绝 / 3 不存在
`;

interface EmitPayload {
  ok: boolean;
  codes: string[];
  exitCode: number;
}

function emit(payload: EmitPayload & Record<string, unknown>, json: boolean, human: string[]): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    const lines = [...human];
    if (!payload.ok) lines.push(`codes=${payload.codes.join(",") || CODE_INVALID}`);
    lines.push(`exit=${payload.exitCode}`);
    process.stdout.write(`${lines.join("\n")}\n`);
  }
  process.exitCode = payload.exitCode;
}

/** 码 → 退出码:门/状态拒绝 2、不存在 3、其余非空码 1。 */
function exitCodeOf(codes: string[]): number {
  if (codes.some((code) => code === CODE_STAGE_ORDER || code === CODE_KEEP_WINDOW || code === CODE_NATIVE_STRATEGY)) {
    return EXIT_REJECTED;
  }
  if (codes.includes(CODE_NOT_FOUND)) return EXIT_NOT_FOUND;
  if (codes.length > 0) return EXIT_USAGE;
  return EXIT_OK;
}

function usageError(message: string, json: boolean): void {
  emit({ ok: false, codes: [CODE_INVALID], exitCode: EXIT_USAGE, error: message }, json, [`错误: ${message}`]);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const json = parsed.flags.has("json");
  const command = SUBCOMMANDS.filter((name) => parsed.flags.has(name));

  if (parsed.flags.has("help") || process.argv.length <= 2) {
    process.stdout.write(USAGE);
    process.exitCode = EXIT_OK;
    return;
  }
  if (parsed.unknown.length > 0) return usageError(`未知选项: ${parsed.unknown.join(", ")}`, json);
  if (command.length !== 1) {
    return usageError(`需要且只能指定一个子命令(收到: ${command.join(", ") || "无"})`, json);
  }

  const sub = command[0] as Subcommand;
  const root = parsed.values.get("root")?.trim() || process.cwd();
  const name = parsed.values.get("name")?.trim() || undefined;
  const version = parsed.values.get("version")?.trim() || undefined;

  if (sub !== "native-plan" && sub !== "list" && sub !== "report" && name === undefined) {
    return usageError(`${sub} 需要 --name`, json);
  }

  switch (sub) {
    case "init": {
      if (version === undefined) return usageError("init 需要 --version", json);
      const res = initUpgrade(root, { name: name as string, version });
      const exitCode = res.ok ? EXIT_OK : exitCodeOf(res.codes);
      emit(
        { ok: res.ok, codes: res.codes, exitCode, name, current: res.state?.current ?? "" },
        json,
        [`init ${name} current=${res.state?.current ?? ""}`],
      );
      return;
    }
    case "shadow": {
      if (version === undefined) return usageError("shadow 需要 --version", json);
      const alias = parsed.values.get("alias")?.trim() || undefined;
      if (alias === undefined) return usageError("shadow 需要 --alias", json);
      const res = startShadow(root, { name: name as string, newVersion: version, alias });
      const exitCode = res.ok ? EXIT_OK : exitCodeOf(res.codes);
      emit(
        { ok: res.ok, codes: res.codes, exitCode, name, version, alias, current: res.state?.current ?? "" },
        json,
        [`shadow ${name}@${version} alias=${alias} current=${res.state?.current ?? ""}`],
      );
      return;
    }
    case "canary": {
      if (version === undefined) return usageError("canary 需要 --version", json);
      const scope = parsed.values.get("scope")?.trim();
      if (scope !== "session" && scope !== "project" && scope !== "percent") {
        return usageError("canary 需要 --scope session|project|percent", json);
      }
      const percentRaw = parsed.values.get("percent")?.trim();
      let percent: number | undefined;
      if (percentRaw !== undefined && percentRaw !== "") {
        percent = Number(percentRaw);
        if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
          return usageError("--percent 必须是 0..100 的数字", json);
        }
      }
      const canaryScope = scope as "session" | "project" | "percent";
      const canary = percent === undefined ? { scope: canaryScope } : { scope: canaryScope, percent };
      const res = promoteCanary(root, { name: name as string, version, canary });
      const exitCode = res.ok ? EXIT_OK : exitCodeOf(res.codes);
      emit(
        { ok: res.ok, codes: res.codes, exitCode, name, version, canary },
        json,
        [`canary ${name}@${version} scope=${scope}${percent === undefined ? "" : ` percent=${percent}`}`],
      );
      return;
    }
    case "switch": {
      if (version === undefined) return usageError("switch 需要 --version", json);
      const experimentRoot = parsed.values.get("experiment-root")?.trim() || undefined;
      const res = switchVersion(root, {
        name: name as string,
        version,
        ...(experimentRoot === undefined ? {} : { experimentRoot }),
      });
      const exitCode = res.ok ? EXIT_OK : exitCodeOf(res.codes);
      emit(
        { ok: res.ok, codes: res.codes, exitCode, name, current: res.state?.current ?? "", warnings: res.warnings },
        json,
        [
          `switch ${name}@${version} current=${res.state?.current ?? ""}`,
          ...res.warnings.map((item) => `warning: ${item.name} ${item.code}`),
        ],
      );
      return;
    }
    case "rollback": {
      const to = parsed.values.get("to")?.trim() || undefined;
      if (to === undefined) return usageError("rollback 需要 --to", json);
      const breakerRoot = parsed.values.get("breaker-root")?.trim() || undefined;
      const reason = parsed.values.get("reason")?.trim() || undefined;
      const res = await rollbackVersion(root, {
        name: name as string,
        toVersion: to,
        ...(breakerRoot === undefined ? {} : { breakerRoot }),
        ...(reason === undefined ? {} : { reason }),
      });
      const exitCode = res.ok ? EXIT_OK : exitCodeOf(res.codes);
      emit(
        { ok: res.ok, codes: res.codes, exitCode, name, current: res.state?.current ?? "", warnings: res.warnings },
        json,
        [
          `rollback ${name} → ${to} current=${res.state?.current ?? ""}`,
          ...res.warnings.map((item) => `warning: ${item.name} ${item.code}`),
        ],
      );
      return;
    }
    case "retire": {
      if (version === undefined) return usageError("retire 需要 --version", json);
      const res = retireVersion(root, { name: name as string, version });
      const exitCode = res.ok ? EXIT_OK : exitCodeOf(res.codes);
      const target = res.state?.versions.find((item) => item.version === version);
      emit(
        { ok: res.ok, codes: res.codes, exitCode, name, version, stage: target?.stage ?? "" },
        json,
        [`retire ${name}@${version} stage=${target?.stage ?? ""}`],
      );
      return;
    }
    case "resolve": {
      const sessionId = parsed.values.get("session")?.trim() || undefined;
      const projectId = parsed.values.get("project")?.trim() || undefined;
      const alias = parsed.values.get("alias")?.trim() || undefined;
      const res = resolveCall(root, {
        name: name as string,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(projectId === undefined ? {} : { projectId }),
        ...(alias === undefined ? {} : { alias }),
      });
      const exitCode = res.ok ? EXIT_OK : exitCodeOf(res.codes);
      emit(
        { ok: res.ok, codes: res.codes, exitCode, name, version: res.version, stage: res.stage, source: res.source },
        json,
        [`resolve ${name} → ${res.version || "-"} stage=${res.stage || "-"} source=${res.source || "-"}`],
      );
      return;
    }
    case "native-plan": {
      const kind = parsed.values.get("kind")?.trim();
      if (kind !== "wrap" && kind !== "demote" && kind !== "tips") {
        return usageError("native-plan 需要 --kind wrap|demote|tips", json);
      }
      const ref = parsed.values.get("ref")?.trim() || undefined;
      if (ref === undefined) return usageError("native-plan 需要 --ref", json);
      const successor = parsed.values.get("successor")?.trim() || undefined;
      const rtMod = await loadRuntime();
      const plan = rtMod.nativeUpgradePlan(successor === undefined ? { kind, ref } : { kind, ref, successor });
      const codes = plan.ok === true ? [] : [...plan.codes];
      const exitCode = plan.ok === true ? EXIT_OK : exitCodeOf(codes);
      emit({ ok: plan.ok === true, codes, exitCode, plan }, json, [
        plan.ok === true ? `native-plan ${kind} ${ref}` : `native-plan ${kind} ${ref} 被拒`,
        JSON.stringify(plan),
      ]);
      return;
    }
    case "list": {
      const res = listUpgrades(root, name);
      emit(
        {
          ok: res.ok,
          codes: [],
          exitCode: EXIT_OK,
          upgrades: res.upgrades,
          badLines: res.badLines,
          totalLines: res.totalLines,
        },
        json,
        [
          `list ${res.upgrades.length} 个工具(badLines=${res.badLines} totalLines=${res.totalLines})`,
          ...res.upgrades.map((item) => `  ${item.name} current=${item.current} stage=${item.stage || "-"}`),
        ],
      );
      return;
    }
    case "report": {
      const res = reportUpgrades(root);
      emit({ ...res, ok: res.ok, codes: [], exitCode: EXIT_OK }, json, [
        `report ${res.names.length} 个工具 path=${res.path}`,
        `badLines=${res.badLines} totalLines=${res.totalLines}`,
        ...res.names.map((key) => {
          const entry = res.perName[key];
          return `  ${key} current=${entry?.current ?? ""} versions=${entry?.versions.length ?? 0}`;
        }),
        ...res.warnings.map((item) => `warning: ${item.name} ${item.code}`),
      ]);
      return;
    }
    default:
      return usageError(`未知子命令: ${sub}`, json);
  }
}

await main();
