#!/usr/bin/env -S node --experimental-strip-types
/**
 * RSI #209 提示词版本与覆盖治理 CLI(tsx / node --experimental-strip-types 直跑)。
 *
 * 用法:
 *   node --experimental-strip-types scripts/prompt-version.mts --root /tmp/pv --init builtins.json
 *   node --experimental-strip-types scripts/prompt-version.mts --root /tmp/pv --init - < builtins.json
 *   node --experimental-strip-types scripts/prompt-version.mts --root /tmp/pv --save system.coding --file - --base 1 [--origin user|project|env|rsi] [--author zhq] [--note "..."] [--approve zhq]
 *   node --experimental-strip-types scripts/prompt-version.mts --root /tmp/pv --resolve system.coding [--revision 1] [--session s1]
 *   node --experimental-strip-types scripts/prompt-version.mts --root /tmp/pv --pin s1
 *   node --experimental-strip-types scripts/prompt-version.mts --root /tmp/pv --history system.coding
 *   node --experimental-strip-types scripts/prompt-version.mts --root /tmp/pv --default-update system.coding --file -
 *   node --experimental-strip-types scripts/prompt-version.mts --root /tmp/pv --diff system.coding
 *   node --experimental-strip-types scripts/prompt-version.mts --root /tmp/pv --accept-default system.coding
 *   node --experimental-strip-types scripts/prompt-version.mts --root /tmp/pv --keep-mine system.coding
 *   node --experimental-strip-types scripts/prompt-version.mts --root /tmp/pv --prune
 *   node --experimental-strip-types scripts/prompt-version.mts --root /tmp/pv --report
 *
 * 退出码:0 成功(含 NOOP/PRUNED 的幂等结果);1 参数错;
 *         2 冲突/占位符校验失败/保留名/需审批(含 MOD_*);3 版本不存在/未知 key。
 * 落盘位置:`<root>/.genie/rsi/prompts/{book,pins}.json`(真实运行请只给 /tmp 下的 root)。
 */
import { readFileSync } from "node:fs";
import process from "node:process";
import {
  acceptDefault,
  diffWithDefault,
  history,
  initBook,
  keepOverride,
  pinSession,
  pruneRedundant,
  reportPrompts,
  resolve,
  resolveForSession,
  saveRevision,
  updateBuiltin,
} from "../apps/gateway/src/prompt-version-store.ts";

const USAGE = [
  "提示词版本治理 CLI(#209)",
  "  --root <dir>                    必填:数据根(<root>/.genie/rsi/prompts/)",
  "  --init <builtins.json|->        建书:内置默认文本表 {key: text}",
  "  --save <key> --file <text|-> --base <rev> [--origin user|project|env|rsi] [--author] [--note] [--approve <by>]",
  "  --resolve <key> [--revision n] [--session s]",
  "  --pin <sessionId>               钉扎会话到当前版本",
  "  --history <key>                 回读版本序列",
  "  --default-update <key> --file <text|->",
  "  --diff <key>                    我的覆盖 vs 新默认的行 diff",
  "  --accept-default <key>          用新默认(忽略我的覆盖)",
  "  --keep-mine <key>               保留我的覆盖",
  "  --prune                         清掉与默认相同的冗余覆盖",
  "  --report                        汇总 keys/revisions/pins/status",
  "  --json / --help",
  "退出码:0 成功;1 参数错;2 冲突/校验失败/需审批;3 版本不存在/未知 key",
].join("\n");

const COMMANDS = ["init", "save", "resolve", "pin", "history", "default-update", "diff", "accept-default", "keep-mine", "prune", "report"] as const;
const BOOLEAN_FLAGS = new Set(["json", "help", "prune", "report"]);
const VALUE_FLAGS = new Set(["root", "init", "save", "file", "base", "origin", "author", "note", "approve", "resolve", "revision", "session", "pin", "history", "default-update", "diff", "accept-default", "keep-mine"]);

type Options = Record<string, string | true>;

// 下游提前关管道(如 `| head`)不该让 CLI 崩:吞掉 EPIPE,交给退出码表达结果。
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

/** 参数错:退出码 1(与校验失败的 2 区分)。 */
class ArgError extends Error {}

function parseArgs(argv: string[]): Options {
  const opts: Options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (!token.startsWith("--")) throw new ArgError(`位置参数不支持: ${token}`);
    const name = token.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      opts[name] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new ArgError(`未知参数 --${name}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new ArgError(`--${name} 缺少取值`);
    opts[name] = value;
    i += 1;
  }
  return opts;
}

function readText(src: string): string {
  if (src === "-") return readFileSync(0, "utf8");
  return readFileSync(src, "utf8");
}

const EXIT3 = new Set(["PROMPT_REVISION_NOT_FOUND", "PROMPT_UNKNOWN_KEY"]);
const EXIT2 = new Set([
  "PROMPT_CONFLICT",
  "PROMPT_PLACEHOLDER_MISSING",
  "PROMPT_PLACEHOLDER_UNKNOWN",
  "PROMPT_RESERVED_NAME",
  "PROMPT_NEEDS_APPROVAL",
  "PROMPT_INVALID",
]);

function exitCodeOf(codes: readonly string[]): number {
  if (codes.some((code) => EXIT3.has(code))) return 3;
  if (codes.some((code) => EXIT2.has(code) || code.startsWith("MOD_"))) return 2;
  return 0;
}

function printCodes(codes: readonly string[]): void {
  if (codes.length === 0) return;
  process.stdout.write(`codes: ${codes.join(", ")}\n`);
}

function stamp(at: number | undefined): string {
  if (typeof at !== "number" || at <= 0) return "-";
  return new Date(at).toISOString();
}

function oneLine(text: string, limit = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function failCodes(command: string, result: { codes: string[]; draft?: string; gateDetails?: string[] }): number {
  process.stderr.write(`✗ ${command} 失败\n`);
  process.stderr.write(`codes: ${result.codes.join(", ")}\n`);
  if (result.draft !== undefined) process.stderr.write(`draft: ${result.draft}\n`);
  if (result.gateDetails !== undefined && result.gateDetails.length > 0) {
    for (const detail of result.gateDetails) process.stderr.write(`  ${detail}\n`);
  }
  return exitCodeOf(result.codes);
}

async function run(opts: Options): Promise<number> {
  const json = opts["json"] === true;
  const command = COMMANDS.find((name) => opts[name] !== undefined);
  const root = typeof opts["root"] === "string" ? opts["root"] : "";
  if (command === undefined) throw new ArgError("缺少子命令(--init/--save/--resolve/...)");
  if (root === "") throw new ArgError("缺少 --root");

  const emit = (payload: unknown): void => {
    if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  };

  switch (command) {
    case "init": {
      const src = String(opts["init"]);
      const parsed = JSON.parse(readText(src)) as Record<string, string>;
      const result = await initBook(root, { builtins: parsed });
      emit(result);
      if (!json) {
        process.stdout.write(`init: ${Object.keys(result.book.keys).length} keys (${Object.keys(result.book.keys).join(", ")})\n`);
        printCodes(result.codes);
      }
      return result.ok ? 0 : exitCodeOf(result.codes);
    }
    case "save": {
      const key = String(opts["save"]);
      const file = opts["file"];
      if (typeof file !== "string") throw new ArgError("--save 需要 --file <text|->");
      const baseRaw = opts["base"];
      if (typeof baseRaw !== "string") throw new ArgError("--save 需要 --base <rev>");
      const base = Number(baseRaw);
      if (!Number.isInteger(base)) throw new ArgError(`--base 必须是整数(实际 ${baseRaw})`);
      const origin = typeof opts["origin"] === "string" ? opts["origin"] : "user";
      if (!["user", "project", "env", "rsi"].includes(origin)) throw new ArgError(`--origin 只能是 user|project|env|rsi(实际 ${origin})`);
      const approve = typeof opts["approve"] === "string" ? opts["approve"] : "";
      const result = await saveRevision(root, {
        key,
        text: readText(file),
        baseRevision: base,
        origin: origin as "user" | "project" | "env" | "rsi",
        ...(typeof opts["author"] === "string" ? { author: opts["author"] } : {}),
        ...(typeof opts["note"] === "string" ? { note: opts["note"] } : {}),
        ...(approve !== "" ? { approval: { ok: true, by: approve } } : {}),
      });
      emit(result);
      if (!result.ok) return failCodes("save", result);
      if (!json) {
        const rev = result.revision;
        if (rev === undefined) {
          process.stdout.write(`saved: ${key} 无新版本(与默认相同)\n`);
        } else {
          process.stdout.write(`saved: ${key} rev ${rev.revision} origin=${rev.origin} base=${rev.baseRevision ?? "?"} 前驱=${rev.predecessor ?? "-"}\n`);
        }
        printCodes(result.codes);
      }
      return 0;
    }
    case "resolve": {
      const key = String(opts["resolve"]);
      const session = typeof opts["session"] === "string" ? opts["session"] : "";
      const revisionRaw = opts["revision"];
      const revision = typeof revisionRaw === "string" ? Number(revisionRaw) : undefined;
      if (revision !== undefined && !Number.isInteger(revision)) throw new ArgError(`--revision 必须是整数(实际 ${String(revisionRaw)})`);
      const result = session !== "" ? await resolveForSession(root, session, key) : await resolve(root, key, revision !== undefined ? { revision } : {});
      emit(result);
      if (!result.ok) {
        process.stderr.write(`✗ resolve 失败\ncodes: ${result.codes.join(", ")}\n`);
        return exitCodeOf(result.codes);
      }
      if (!json) {
        const label = session !== "" ? `session ${session}` : "default";
        process.stdout.write(`${key} @${label} rev ${result.revision}:\n${result.text}\n`);
        printCodes(result.codes);
      }
      return 0;
    }
    case "pin": {
      const sessionId = String(opts["pin"]);
      const result = await pinSession(root, sessionId);
      emit(result);
      if (!result.ok) {
        process.stderr.write(`✗ pin 失败\ncodes: ${result.codes.join(", ")}\n`);
        return exitCodeOf(result.codes);
      }
      if (!json) {
        const pinned = result.pins;
        process.stdout.write(`pinned: ${pinned?.sessionId} (${Object.keys(pinned?.revisions ?? {}).length} keys) at ${stamp(pinned?.createdAt)}\n`);
        printCodes(result.codes);
      }
      return 0;
    }
    case "history": {
      const result = await history(root, String(opts["history"]));
      emit(result);
      if (!result.ok) {
        process.stderr.write(`✗ history 失败\ncodes: ${result.codes.join(", ")}\n`);
        return exitCodeOf(result.codes);
      }
      if (!json) {
        process.stdout.write(`${result.key} current=${result.current} status=${result.status}\n`);
        for (const rev of result.revisions ?? []) {
          process.stdout.write(`  #${rev.revision} ${rev.origin} pred=${rev.predecessor ?? "-"} base=${rev.baseRevision ?? "-"} ${stamp(rev.timestamp)}${rev.author ? ` by=${rev.author}` : ""} | ${oneLine(rev.text)}${rev.note ? ` | note=${rev.note}` : ""}\n`);
        }
      }
      return 0;
    }
    case "default-update": {
      const key = String(opts["default-update"]);
      const file = opts["file"];
      if (typeof file !== "string") throw new ArgError("--default-update 需要 --file <text|->");
      const result = await updateBuiltin(root, { key, text: readText(file) });
      emit(result);
      if (!result.ok) {
        process.stderr.write(`✗ default-update 失败\ncodes: ${result.codes.join(", ")}\n`);
        return exitCodeOf(result.codes);
      }
      if (!json) {
        const record = result.book.keys[key];
        process.stdout.write(`default updated: ${key} status=${record?.status ?? "?"} affected=${result.affected.length > 0 ? result.affected.join(", ") : "(无覆盖)"}\n`);
        printCodes(result.codes);
      }
      return 0;
    }
    case "diff": {
      const key = String(opts["diff"]);
      const result = await diffWithDefault(root, key);
      emit(result);
      if (!result.ok) {
        process.stderr.write(`✗ diff 失败\ncodes: ${result.codes.join(", ")}\n`);
        return exitCodeOf(result.codes);
      }
      if (!json) {
        process.stdout.write(`${key} ${result.same ? "与默认相同" : "与默认不同的行 diff(- 我的 / + 新默认)"}\n`);
        for (const line of result.lines) {
          const prefix = line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  ";
          process.stdout.write(`${prefix}${line.text}\n`);
        }
      }
      return 0;
    }
    case "accept-default": {
      const key = String(opts["accept-default"]);
      const result = await acceptDefault(root, key);
      emit({ ok: result.ok, codes: result.codes, current: result.book.keys[key]?.current, status: result.book.keys[key]?.status });
      if (!result.ok) {
        process.stderr.write(`✗ accept-default 失败\ncodes: ${result.codes.join(", ")}\n`);
        return exitCodeOf(result.codes);
      }
      if (!json) {
        process.stdout.write(`accepted default: ${key} current=${result.book.keys[key]?.current ?? "?"} status=${result.book.keys[key]?.status ?? "?"}\n`);
        printCodes(result.codes);
      }
      return 0;
    }
    case "keep-mine": {
      const key = String(opts["keep-mine"]);
      const result = await keepOverride(root, key);
      emit({ ok: result.ok, codes: result.codes, current: result.book.keys[key]?.current, status: result.book.keys[key]?.status });
      if (!result.ok) {
        process.stderr.write(`✗ keep-mine 失败\ncodes: ${result.codes.join(", ")}\n`);
        return exitCodeOf(result.codes);
      }
      if (!json) {
        process.stdout.write(`kept override: ${key} current=${result.book.keys[key]?.current ?? "?"} status=${result.book.keys[key]?.status ?? "?"}\n`);
        printCodes(result.codes);
      }
      return 0;
    }
    case "prune": {
      const result = await pruneRedundant(root);
      emit(result);
      if (!json) {
        process.stdout.write(result.pruned.length > 0 ? `pruned: ${result.pruned.join(", ")}\n` : "pruned: (无冗余覆盖)\n");
        printCodes(result.codes);
      }
      return 0;
    }
    case "report": {
      const result = await reportPrompts(root);
      emit(result);
      if (!json) {
        process.stdout.write(`prompts report\n  keys: ${result.keys}\n  revisions: ${result.revisions}\n  pins: ${result.pins}\n`);
        const statusEntries = Object.entries(result.status).map(([name, count]) => `${name}=${count}`);
        process.stdout.write(`  status: ${statusEntries.length > 0 ? statusEntries.join(", ") : "(空)"}\n`);
        for (const entry of result.entries) {
          process.stdout.write(`  - ${entry.key} current=${entry.current} status=${entry.status} revisions=${entry.revisions}\n`);
        }
        for (const pin of result.pinnedSessions) {
          process.stdout.write(`  pin ${pin.sessionId} created=${stamp(pin.createdAt)} keys=${pin.pinned}\n`);
        }
        printCodes(result.codes);
      }
      return result.ok ? 0 : exitCodeOf(result.codes);
    }
    default:
      throw new ArgError(`未知子命令 ${String(command)}`);
  }
}

async function main(): Promise<number> {
  let opts: Options;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`参数错误: ${(error as Error).message}\n\n${USAGE}\n`);
    return 1;
  }
  if (opts["help"] === true) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    return await run(opts);
  } catch (error) {
    if (error instanceof ArgError) {
      process.stderr.write(`参数错误: ${error.message}\n\n${USAGE}\n`);
      return 1;
    }
    process.stderr.write(`✗ 运行失败: ${(error as Error).message}\n`);
    return 1;
  }
}

const code = await main();
process.exitCode = code;
