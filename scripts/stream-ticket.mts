#!/usr/bin/env -S node --experimental-strip-types
/**
 * 一次性流票据 CLI(M30):issue / consume / url / prune / report。
 *
 * 纯表面层:票据判定在 packages/harness-runtime/src/agent/stream-ticket.ts(纯逻辑),
 * 落盘与原子写在 apps/gateway/src/stream-ticket-store.ts
 * (`<root>/.genie/rsi/tickets.json`,整文件原子快照)。本文件只做 argv 解析与退出码映射。
 *
 * 用法:node --experimental-strip-types scripts/stream-ticket.mts --root <dir> <子命令> [--json]
 *   --issue --pty p --dir d --ws w          换一张票(打印 TICKET_ISSUED <id>)
 *   --consume <id> --pty p --dir d --ws w   用票(打印 TICKET_CONSUMED <id>)
 *   --url <url> [--pty p --dir d --ws w]    按 url 的 ticket 参数判放行(可选绑定上下文)
 *   --prune                                 清理过期未消费票
 *   --report                                台账视图
 *   --json                                  机器可读输出
 *   --help                                  本帮助
 *
 * 一次只允许一个子命令(--issue / --consume / --url / --prune / --report 任选其一)。
 * 退出码:0 成功(ISSUED / CONSUMED / PRUNED / REPORT / allowed=true);
 *         1 参数错误与非状态错(NOT_FOUND / NO_TICKET / INVALID / STORE_ERROR);
 *         2 状态冲突(REPLAY / EXPIRED / BINDING_MISMATCH,以及 allowed=false 的这三类)。
 * 落盘位置:`<root>/.genie/rsi/tickets.json`(真实运行请只给 /tmp 下的 root)。
 */
import process from "node:process";

import {
  allowUrl,
  consume,
  issue,
  prune,
  reportTickets,
  ticketsPath,
} from "../apps/gateway/src/stream-ticket-store.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_STATE = 2;

/** 属于「票状态冲突」的码 → 退出码 2;其余失败(找不到/参数/存储)一律 1。 */
const STATE_CODES = new Set<string>(["TICKET_REPLAY", "TICKET_EXPIRED", "TICKET_BINDING_MISMATCH"]);

const VALUE_FLAGS = new Set(["root", "pty", "dir", "ws", "consume", "url"]);

const BOOL_FLAGS = new Set(["issue", "prune", "report", "json", "help"]);

const COMMANDS = ["issue", "consume", "url", "prune", "report"] as const;

type Command = (typeof COMMANDS)[number];

const HELP = [
  "一次性流票据 CLI:用 --root 指定台账根目录(<root>/.genie/rsi/tickets.json)",
  "",
  "用法:node --experimental-strip-types scripts/stream-ticket.mts --root <dir> <子命令> [--json]",
  "",
  "子命令:",
  "  --issue --pty p --dir d --ws w             换一张票(默认 TTL 60s)",
  "  --consume <id> --pty p --dir d --ws w      用票(一张票只能成功换一次)",
  "  --url <url> [--pty p --dir d --ws w]       按 url 的 ticket 参数判放行(可带绑定上下文)",
  "  --prune                                    清理过期未消费票",
  "  --report                                   台账视图(total/active/consumed/expired)",
  "  --json                                     机器可读输出",
  "  --help                                     本帮助",
  "",
  "退出码:0 成功;1 参数错误 / NOT_FOUND / NO_TICKET / INVALID / STORE_ERROR;",
  "        2 REPLAY / EXPIRED / BINDING_MISMATCH(以及 allowed=false 的这三类)",
].join("\n");

interface Parsed {
  values: Map<string, string>;
  flags: Set<string>;
}

class UsageError extends Error {}

function parseArgv(argv: string[]): Parsed {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (raw === undefined || !raw.startsWith("--")) throw new UsageError(`无法识别的参数:${raw}`);
    const name = raw.slice(2);
    if (BOOL_FLAGS.has(name)) {
      flags.add(name);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new UsageError(`未知选项:${raw}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${raw} 缺少取值`);
    values.set(name, value);
    i += 1;
  }
  return { values, flags };
}

function commandOf(parsed: Parsed): Command {
  const present: Command[] = [];
  if (parsed.flags.has("issue")) present.push("issue");
  if (parsed.values.has("consume")) present.push("consume");
  if (parsed.values.has("url")) present.push("url");
  if (parsed.flags.has("prune")) present.push("prune");
  if (parsed.flags.has("report")) present.push("report");
  if (present.length === 0) throw new UsageError("缺少子命令(--issue / --consume / --url / --prune / --report)");
  if (present.length > 1) {
    throw new UsageError(`一次只允许一个子命令,收到:${present.map((c) => `--${c}`).join(" ")}`);
  }
  return present[0] as Command;
}

function requireRoot(parsed: Parsed): string {
  const root = parsed.values.get("root");
  if (root === undefined || root.trim() === "") throw new UsageError("缺少 --root <dir>");
  return root;
}

function requireValue(parsed: Parsed, name: string): string {
  const value = parsed.values.get(name);
  if (value === undefined || value.trim() === "") throw new UsageError(`缺少 --${name}`);
  return value;
}

/** 绑定三元组:pty/dir/ws 要么都给、要么都不给(url 场景可省)。 */
function bindingOf(parsed: Parsed, required: boolean) {
  const pty = parsed.values.get("pty");
  const dir = parsed.values.get("dir");
  const ws = parsed.values.get("ws");
  const given = [pty, dir, ws].filter((value) => value !== undefined).length;
  if (given === 0) {
    if (required) throw new UsageError("缺少绑定上下文:--pty / --dir / --ws 三个都要给");
    return undefined;
  }
  if (given !== 3) throw new UsageError("绑定上下文必须成套:--pty / --dir / --ws");
  return {
    ptyId: requireValue(parsed, "pty"),
    directory: requireValue(parsed, "dir"),
    workspaceId: requireValue(parsed, "ws"),
  };
}

function printJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function exitOf(code: string, allowed?: boolean): number {
  if (code === "TICKET_STORE_ERROR" || code === "TICKET_INVALID" || code === "TICKET_NOT_FOUND" || code === "TICKET_NO_TICKET") {
    return EXIT_USAGE;
  }
  if (STATE_CODES.has(code)) return EXIT_STATE;
  if (code === "TICKET_ISSUED" || code === "TICKET_CONSUMED" || code === "TICKET_PRUNED") return EXIT_OK;
  return allowed === true ? EXIT_OK : EXIT_USAGE;
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgv(argv);
  const asJson = parsed.flags.has("json");

  if (parsed.flags.has("help")) {
    process.stdout.write(`${HELP}\n`);
    return EXIT_OK;
  }

  const command = commandOf(parsed);
  const root = requireRoot(parsed);

  if (command === "issue") {
    const binding = bindingOf(parsed, true);
    const result = issue(root, { binding: binding!, now: Date.now() });
    if (asJson) printJson(result);
    else if (result.ok) process.stdout.write(`TICKET_ISSUED ${result.ticket.id}\n`);
    else process.stderr.write(`${result.code} ${result.reason}\n`);
    if (!asJson && result.ok && !result.persisted) {
      process.stderr.write(`写盘失败:${ticketsPath(root)}\n`);
    }
    if (result.ok && !result.persisted) return EXIT_USAGE;
    return result.ok ? EXIT_OK : exitOf(result.code);
  }

  if (command === "consume") {
    const ticketId = requireValue(parsed, "consume");
    const binding = bindingOf(parsed, true);
    const result = consume(root, { ticketId, binding: binding!, now: Date.now() });
    if (asJson) printJson(result);
    else if (result.code === "TICKET_CONSUMED") process.stdout.write(`TICKET_CONSUMED ${result.ticketId}\n`);
    else process.stderr.write(`${result.code} ${result.ticketId}${result.reason === undefined ? "" : ` ${result.reason}`}\n`);
    return exitOf(result.code);
  }

  if (command === "url") {
    const url = requireValue(parsed, "url");
    const binding = bindingOf(parsed, false);
    const result =
      binding === undefined
        ? allowUrl(root, { url, now: Date.now() })
        : allowUrl(root, { url, binding, now: Date.now() });
    if (asJson) printJson(result);
    else if (result.allowed) process.stdout.write(`allowed=true ${result.code} ${result.ticketId}\n`);
    else process.stderr.write(`allowed=false ${result.code} ${result.ticketId}\n`);
    return result.allowed ? EXIT_OK : exitOf(result.code, result.allowed);
  }

  if (command === "prune") {
    const result = prune(root, { now: Date.now() });
    if (asJson) printJson(result);
    else {
      process.stdout.write(
        `${result.code} ${result.pruned.length} 条${result.pruned.length === 0 ? "" : `:${result.pruned.join(",")}`}\n`,
      );
    }
    return result.code === "TICKET_PRUNED" ? EXIT_OK : EXIT_USAGE;
  }

  const report = reportTickets(root);
  if (asJson) printJson(report);
  else if ("code" in report) process.stderr.write(`${report.code} ${report.reason}\n`);
  else {
    process.stdout.write(
      `total=${report.total} active=${report.active} consumed=${report.consumed} expired=${report.expired}\n` +
        `${report.path}\n`,
    );
    for (const ticket of report.tickets) {
      process.stdout.write(`- ${ticket.id} ${ticket.state} pty=${ticket.ptyId} dir=${ticket.directory}\n`);
    }
  }
  return "code" in report ? EXIT_USAGE : EXIT_OK;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n${HELP}\n`);
    } else {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exitCode = EXIT_USAGE;
  },
);
