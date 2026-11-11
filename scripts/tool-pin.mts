#!/usr/bin/env node
/**
 * 工具版本钉扎 CLI(#207):create / show / close / call / upgrade / replay / list-calls / report。
 * 纯表面层:钉扎判据与会话状态机在
 * packages/harness-runtime/src/agent/tool-version-pin.ts(纯逻辑)
 * apps/gateway/src/tool-pins-store.ts(.genie/rsi/tool-pins.jsonl 追加事件 + 投影)
 * 本文件只做 argv 解析、调 store、把 codes 映射成退出码。不自己判版本、不自己写台账。
 * 退出码:0 成功 / 1 参数错(未知 flag、缺必填、JSON 坏、TOOL_PIN_INVALID、TOOL_PIN_DUPLICATE)
 * 2 状态拒绝(TOOL_PIN_SESSION_LOCKED / CONFIRM_REQUIRED / UNKNOWN_TOOL / SCHEMA_MISSING / INCOMPATIBLE)
 * 3 不存在(TOOL_PIN_NOT_FOUND)
 * `--help` 或无参 → 打印用法并退出 0;`--json` → 输出 {ok, codes, exitCode, ...payload}。
 * 跑法:`npx tsx scripts/tool-pin.mts --create s1 --catalog c.json --root /tmp/x`
 * (store 里的 runtime 模块是两跳惰性解析的,tsx 解析不到 dist 时会回退仓内 src,无需 build)。
 */
import { readFileSync } from "node:fs";
import {
  applyUpgrade,
  closeSession,
  countSessionCalls,
  createPins,
  getPins,
  listCalls,
  recordCall,
  replayCall,
  reportPins,
} from "../apps/gateway/src/tool-pins-store.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_REJECTED = 2;
const EXIT_NOT_FOUND = 3;

/** 协议/台账稳定码(字面量:CLI 不能静态 import 未 build 的 runtime 包,码是公开契约)。 */
const CODE_INVALID = "TOOL_PIN_INVALID";
const CODE_NOT_FOUND = "TOOL_PIN_NOT_FOUND";
const CODE_DUPLICATE = "TOOL_PIN_DUPLICATE";
const CODE_SESSION_LOCKED = "TOOL_PIN_SESSION_LOCKED";
const CODE_CONFIRM_REQUIRED = "TOOL_PIN_CONFIRM_REQUIRED";
const CODE_UNKNOWN_TOOL = "TOOL_PIN_UNKNOWN_TOOL";
const CODE_SCHEMA_MISSING = "TOOL_PIN_SCHEMA_MISSING";
const CODE_INCOMPATIBLE = "TOOL_PIN_INCOMPATIBLE";
const CODE_REPLAY_RESOLVED = "TOOL_PIN_REPLAY_RESOLVED";

/** 退出码 2 的码集合(状态/闸门拒绝);NOT_FOUND 单独走 3,其余非空码 1。 */
const REJECT_CODES: ReadonlySet<string> = new Set<string>([
  CODE_SESSION_LOCKED,
  CODE_CONFIRM_REQUIRED,
  CODE_UNKNOWN_TOOL,
  CODE_SCHEMA_MISSING,
  CODE_INCOMPATIBLE,
]);

/** 子命令 → 位置参数个数(`--call <sessionId> <tool>` 这类「值紧跟子命令」)。 */
const SUBCOMMANDS: ReadonlyMap<string, number> = new Map<string, number>([
  ["create", 1],
  ["show", 1],
  ["close", 1],
  ["call", 2],
  ["upgrade", 3],
  ["replay", 2],
  ["list-calls", 0],
  ["report", 0],
]);

const VALUE_FLAGS: ReadonlySet<string> = new Set<string>(["root", "catalog", "overrides", "args", "batch", "call-id", "by", "session"]);
const BOOL_FLAGS: ReadonlySet<string> = new Set<string>(["json", "confirm", "help"]);

const USAGE = `用法: npx tsx scripts/tool-pin.mts <子命令> [选项]

子命令:
  --create <sessionId> --catalog <catalog.json|-> [--overrides <json>]
                                           开启会话钉扎(catalog 快照一并落盘)
  --show <sessionId>                       看会话钉住的版本与升级史
  --close <sessionId>                      关闭会话(之后 call/upgrade 被拒)
  --call <sessionId> <tool> [--args <json>] [--batch <key>] [--call-id <id>]
                                           记一次调用(callId 缺省 call-<该会话已有调用数+1>)
  --upgrade <sessionId> <tool> <to> --by <who> [--confirm]
                                           会话内升级(不加 --confirm 会被拒 CONFIRM_REQUIRED)
  --replay <sessionId> <callId> --catalog <catalog.json|->
                                           按记录版本回放(取不到该版 schema → SCHEMA_MISSING)
  --list-calls [--session <s>]             调用列表(可按会话过滤)
  --report                                 台账报告(open/closed/byVersion/upgrades)

通用: --root <dir>(台账根,缺省当前目录) --json --help
退出码: 0 成功 / 1 参数错或 INVALID|DUPLICATE / 2 状态拒绝 / 3 不存在
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

/** 码 → 退出码:不存在 3、状态拒绝 2、其余非空码 1、成功 0。 */
function exitCodeOf(res: { ok: boolean; codes: string[] }): number {
  if (res.ok) return EXIT_OK;
  if (res.codes.includes(CODE_NOT_FOUND)) return EXIT_NOT_FOUND;
  if (res.codes.some((code) => REJECT_CODES.has(code))) return EXIT_REJECTED;
  return EXIT_USAGE;
}

function usageError(message: string, json: boolean): void {
  emit({ ok: false, codes: [CODE_INVALID], exitCode: EXIT_USAGE, error: message }, json, [`错误: ${message}`]);
}

interface Parsed {
 /** 子命令名(不带 --),缺省 undefined。 */
  cmd?: string;
 /** 子命令后的位置参数(按 argv 顺序)。 */
  args: string[];
  values: Map<string, string>;
  flags: Set<string>;
  unknown: string[];
}

function parseArgs(argv: string[]): Parsed {
  const parsed: Parsed = { args: [], values: new Map<string, string>(), flags: new Set<string>(), unknown: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i] ?? "";
    if (!raw.startsWith("--")) {
      parsed.unknown.push(raw);
      continue;
    }
    const key = raw.slice(2);
    const arity = SUBCOMMANDS.get(key);
    if (arity !== undefined) {
      if (parsed.cmd !== undefined) {
        parsed.unknown.push(raw);
        continue;
      }
      parsed.cmd = key;
      for (let n = 0; n < arity; n += 1) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) break;
        parsed.args.push(next);
        i += 1;
      }
      continue;
    }
    if (VALUE_FLAGS.has(key)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        parsed.values.set(key, "");
        continue;
      }
      parsed.values.set(key, next);
      i += 1;
      continue;
    }
    if (BOOL_FLAGS.has(key)) {
      parsed.flags.add(key);
      continue;
    }
    parsed.unknown.push(raw);
  }
  return parsed;
}

/** 读 JSON 入参:`-` 表示 stdin;坏 JSON 返回 undefined(由调用方按参数错退 1)。 */
function readJsonSource(source: string): unknown {
  let text: string;
  try {
    text = source === "-" ? readFileSync(0, "utf8") : readFileSync(source, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseJsonValue(raw: string | undefined): unknown {
  if (raw === undefined || raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const json = parsed.flags.has("json");

  if (parsed.flags.has("help") || process.argv.length <= 2) {
    process.stdout.write(USAGE);
    process.exitCode = EXIT_OK;
    return;
  }
  if (parsed.unknown.length > 0) return usageError(`未知选项或多余参数: ${parsed.unknown.join(", ")}`, json);
  if (parsed.cmd === undefined) return usageError("需要指定子命令(--help 看用法)", json);

  const cmd = parsed.cmd;
  const root = parsed.values.get("root")?.trim() || process.cwd();
  const [first, second, third] = parsed.args;

  switch (cmd) {
    case "create": {
      const sessionId = first?.trim();
      if (sessionId === undefined || sessionId === "") return usageError("create 需要 <sessionId>", json);
      const catalogSource = parsed.values.get("catalog");
      if (catalogSource === undefined || catalogSource.trim() === "") {
        return usageError("create 需要 --catalog <catalog.json|->", json);
      }
      const catalog = readJsonSource(catalogSource.trim());
      if (!isRecord(catalog)) return usageError("catalog 不是合法 JSON 对象", json);
      const overridesRaw = parsed.values.get("overrides");
      let overrides: Record<string, string> | undefined;
      if (overridesRaw !== undefined) {
        const value = parseJsonValue(overridesRaw);
        if (!isRecord(value)) return usageError("--overrides 需要 JSON 对象", json);
        overrides = value as Record<string, string>;
      }
      const res = await createPins(root, {
        sessionId,
        catalog: catalog as Parameters<typeof createPins>[1]["catalog"],
        ...(overrides === undefined ? {} : { overrides }),
      });
      const exitCode = exitCodeOf(res);
      const versions = res.pins?.versions ?? {};
      const pinned = Object.entries(versions).map(([tool, version]) => `${tool}@${version}`);
      emit(
        { ok: res.ok, codes: res.codes, exitCode, sessionId, versions },
        json,
        [`create ${sessionId} pinned=${pinned.join(",") || "-"}`, `  versions: ${pinned.join(" ") || "-"}`],
      );
      return;
    }
    case "show": {
      const sessionId = first?.trim();
      if (sessionId === undefined || sessionId === "") return usageError("show 需要 <sessionId>", json);
      const res = getPins(root, sessionId);
      const ok = res.pins !== undefined;
      const exitCode = exitCodeOf({ ok, codes: ok ? [] : res.codes });
      const pins = res.pins;
      emit(
        {
          ok,
          codes: ok ? [] : res.codes,
          exitCode,
          sessionId,
          status: pins?.status ?? "",
          versions: pins?.versions ?? {},
          upgrades: pins?.upgrades ?? [],
        },
        json,
        pins === undefined
          ? [`show ${sessionId} 未找到`]
          : [
              `show ${sessionId} status=${pins.status} pinned=${Object.entries(pins.versions)
                .map(([tool, version]) => `${tool}@${version}`)
                .join(",")} upgrades=${pins.upgrades.length}`,
              ...pins.upgrades.map(
                (item) => `  upgrade ${item.tool} ${item.from} → ${item.to} by=${item.by} at=${item.at}`,
              ),
            ],
      );
      return;
    }
    case "close": {
      const sessionId = first?.trim();
      if (sessionId === undefined || sessionId === "") return usageError("close 需要 <sessionId>", json);
      const res = closeSession(root, sessionId);
      const exitCode = exitCodeOf(res);
      emit({ ok: res.ok, codes: res.codes, exitCode, sessionId }, json, [`close ${sessionId}`]);
      return;
    }
    case "call": {
      const sessionId = first?.trim();
      const tool = second?.trim();
      if (sessionId === undefined || sessionId === "" || tool === undefined || tool === "") {
        return usageError("call 需要 <sessionId> <tool>", json);
      }
      const argsRaw = parsed.values.get("args");
      let args: Record<string, unknown> | undefined;
      if (argsRaw !== undefined) {
        const value = parseJsonValue(argsRaw);
        if (!isRecord(value)) return usageError("--args 需要 JSON 对象", json);
        args = value;
      }
      const explicit =
        parsed.values.get("call-id") === undefined ? undefined : parsed.values.get("call-id")?.trim() || undefined;
      let callId = explicit;
      if (callId === undefined) {
        let existing = 0;
        try {
          existing = countSessionCalls(root, sessionId);
        } catch {
          existing = 0;
        }
        callId = `call-${existing + 1}`;
      }
      const batch = parsed.values.get("batch")?.trim() || undefined;
      const res = await recordCall(root, {
        sessionId,
        callId,
        tool,
        ...(args === undefined ? {} : { args }),
        ...(batch === undefined ? {} : { traceBatchKey: batch }),
      });
      const exitCode = exitCodeOf(res);
      emit(
        {
          ok: res.ok,
          codes: res.codes,
          exitCode,
          sessionId,
          callId,
          tool,
          version: res.call?.version ?? "",
          call: res.call,
        },
        json,
        [
          `call ${sessionId} ${tool}@${res.call?.version ?? "-"} callId=${callId}`,
          `  callId: ${callId}`,
        ],
      );
      return;
    }
    case "upgrade": {
      const sessionId = first?.trim();
      const tool = second?.trim();
      const to = third?.trim();
      if (
        sessionId === undefined ||
        sessionId === "" ||
        tool === undefined ||
        tool === "" ||
        to === undefined ||
        to === ""
      ) {
        return usageError("upgrade 需要 <sessionId> <tool> <to>", json);
      }
      const by = parsed.values.get("by")?.trim();
      if (by === undefined || by === "") return usageError("upgrade 需要 --by <who>", json);
      const res = await applyUpgrade(root, { sessionId, tool, to, by, confirmed: parsed.flags.has("confirm") });
      const exitCode = exitCodeOf(res);
      emit(
        {
          ok: res.ok,
          codes: res.codes,
          exitCode,
          sessionId,
          tool,
          to,
          by,
          confirmed: parsed.flags.has("confirm"),
          versions: res.pins?.versions ?? {},
        },
        json,
        [
          `upgrade ${sessionId} ${tool} → ${to} by=${by} confirmed=${parsed.flags.has("confirm")}`,
          ...(res.pins === undefined
            ? []
            : [`  versions: ${Object.entries(res.pins.versions).map(([k, v]) => `${k}@${v}`).join(",")}`]),
        ],
      );
      return;
    }
    case "replay": {
      const sessionId = first?.trim();
      const callId = second?.trim();
      if (sessionId === undefined || sessionId === "" || callId === undefined || callId === "") {
        return usageError("replay 需要 <sessionId> <callId>", json);
      }
      const catalogSource = parsed.values.get("catalog");
      if (catalogSource === undefined || catalogSource.trim() === "") {
        return usageError("replay 需要 --catalog <catalog.json|->", json);
      }
      const catalog = readJsonSource(catalogSource.trim());
      if (!isRecord(catalog)) return usageError("catalog 不是合法 JSON 对象", json);
      const res = await replayCall(root, {
        sessionId,
        callId,
        catalog: catalog as Parameters<typeof replayCall>[1]["catalog"],
      });
      const ok = res.codes.includes(CODE_REPLAY_RESOLVED);
      const exitCode = exitCodeOf({ ok, codes: res.codes });
      emit(
        { ok, codes: res.codes, exitCode, sessionId, callId, schema: res.schema },
        json,
        [
          `replay ${sessionId}/${callId} → ${ok ? "REPLAY_RESOLVED" : "未解析"}`,
          ...(res.schema === undefined ? [] : [`  schema: ${JSON.stringify(res.schema)}`]),
        ],
      );
      return;
    }
    case "list-calls": {
      const session = parsed.values.get("session")?.trim() || undefined;
      const res = listCalls(root, session === undefined ? {} : { sessionId: session });
      emit(
        {
          ok: true,
          codes: [],
          exitCode: EXIT_OK,
          calls: res.calls,
          parseErrors: res.parseErrors,
          badLines: res.badLines,
        },
        json,
        [
          `list-calls ${res.calls.length} 次(parseErrors=${res.parseErrors} badLines=[${res.badLines.join(",")}])`,
          ...res.calls.map(
            (item) => `  ${item.sessionId} ${item.callId} ${item.tool}@${item.version}${item.traceBatchKey === undefined ? "" : ` batch=${item.traceBatchKey}`}`,
          ),
        ],
      );
      return;
    }
    case "report": {
      const res = reportPins(root);
      const byVersion = Object.entries(res.callsByVersion).map(([key, count]) => `  ${key} = ${count}`);
      emit({ ...res, ok: true, codes: [], exitCode: EXIT_OK }, json, [
        `report path=${res.path}`,
        `open=[${res.open.join(",")}] closed=[${res.closed.join(",")}]`,
        `totalLines=${res.totalLines} parseErrors=${res.parseErrors} badLines=[${res.badLines.join(",")}]`,
        "byVersion:",
        ...(byVersion.length === 0 ? ["  -"] : byVersion),
        "upgrades:",
        ...(res.upgrades.length === 0
          ? ["  -"]
          : res.upgrades.map(
              (item) => `  ${item.sessionId} ${item.tool} ${item.from} → ${item.to} by=${item.by} confirmed=${item.confirmed} at=${item.at}`,
            )),
      ]);
      return;
    }
    default:
      return usageError(`未知子命令: ${cmd}`, json);
  }
}

await main();
