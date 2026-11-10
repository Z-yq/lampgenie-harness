#!/usr/bin/env tsx
/**
 * 同步权威协议 CLI(#113)。
 *
 * 用法:
 *   tsx scripts/sync-authority.mts --root <dir> [动作]
 *
 * 动作(每次调用只做一件,按下面顺序取第一个命中的):
 *   --accept <file|->      接受一条事件;文件是事件对象或 {event:{...}};`-` 从 stdin 读
 *   --migrate              归属转移,需 --aggregate / --from / --to(可选 --at)
 *   --subscribe            先订阅拿脏位再读历史,需 --aggregate(可选 --since,缺省 0)
 *   --watermark <id>       查水位
 *   --report               报表(聚合摘要 + owner + 事件总数)
 *
 * 其它参数:
 *   --root <dir>           仓库/任务根(<root>/.genie/rsi/sync.json),必填
 *   --json                 stdout 打结构化 JSON(缺省打人读摘要)
 *   --help                 打用法
 *
 * 退出码:0 成功;1 参数错误 / IO 错 / SYNC_INVALID;
 *         2 协议冲突类失败(SYNC_CONFLICT_DIE / SYNC_MIGRATE_FAILED / SYNC_PROXY_REFUSED)。
 * stdout 只放结果,stderr 放给人读的失败原因(含稳定码,便于 grep)。
 */
import { readFileSync } from "node:fs";
import {
  accept,
  migrate,
  report,
  subscribe,
  watermark,
} from "../apps/gateway/src/sync-authority-store.ts";
import type { AuthorityEvent } from "../packages/harness-runtime/src/agent/sync-authority.ts";

const USAGE = [
  "用法: sync-authority --root <dir> [--accept <file|->] | [--migrate --aggregate a --from o1 --to o2] | [--subscribe --aggregate a --since n] | [--watermark a] | [--report] [--json]",
  "退出码: 0 成功 / 1 参数或 IO 错误 / 2 协议冲突(CONFLICT_DIE / MIGRATE_FAILED / PROXY_REFUSED)",
].join("\n");

class ArgError extends Error {}

const BOOLEAN_FLAGS = new Set(["migrate", "subscribe", "report", "json", "help"]);
const VALUE_FLAGS = new Set(["root", "accept", "aggregate", "from", "to", "since", "at", "watermark"]);

type Options = Record<string, string | true>;

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

function textOf(opts: Options, name: string): string {
  const value = opts[name];
  if (typeof value !== "string" || value.trim() === "") throw new ArgError(`--${name} 必填`);
  return value.trim();
}

function intOf(opts: Options, name: string, fallback?: number): number {
  const value = opts[name];
  if (value === undefined) {
    if (fallback === undefined) throw new ArgError(`--${name} 必填`);
    return fallback;
  }
  if (typeof value !== "string") throw new ArgError(`--${name} 需要数字`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ArgError(`--${name} 需要数字: ${value}`);
  return parsed;
}

function readJson(src: string): unknown {
  let text: string;
  try {
    text = src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  } catch (error) {
    throw new ArgError(`读不到 ${src}:${(error as Error).message}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ArgError(`${src} 不是合法 JSON:${(error as Error).message}`);
  }
}

function asEvent(value: unknown, file: string): AuthorityEvent {
  const raw =
    value !== null && typeof value === "object" && "event" in (value as Record<string, unknown>)
      ? (value as Record<string, unknown>).event
      : value;
  if (raw === null || typeof raw !== "object") throw new ArgError(`${file} 必须是事件对象或 {event:...}`);
  const record = raw as Record<string, unknown>;
  const aggregateId = typeof record.aggregateId === "string" ? record.aggregateId : "";
  const ownerId = typeof record.ownerId === "string" ? record.ownerId : "";
  const payloadHash = typeof record.payloadHash === "string" ? record.payloadHash : "";
  const seq = typeof record.seq === "number" ? record.seq : Number.NaN;
  const at = typeof record.at === "number" && Number.isFinite(record.at) ? record.at : Date.now();
  if (aggregateId === "" || ownerId === "" || payloadHash === "" || !Number.isFinite(seq)) {
    throw new ArgError(`${file} 缺 aggregateId/seq/ownerId/payloadHash`);
  }
  return { aggregateId, seq, ownerId, payloadHash, at };
}

const CONFLICT_CODES = new Set([
  "SYNC_CONFLICT_DIE",
  "SYNC_MIGRATE_FAILED",
  "SYNC_PROXY_REFUSED",
]);

const INVALID_CODES = new Set(["SYNC_INVALID"]);

function exitCodeOf(code: string): number {
  if (CONFLICT_CODES.has(code)) return 2;
  if (INVALID_CODES.has(code)) return 1;
  return 0;
}

function emit(json: boolean, payload: unknown, lines: string[]): void {
  if (json) process.stdout.write(`${JSON.stringify(payload)}\n`);
  else process.stdout.write(`${lines.join("\n")}\n`);
}

async function main(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const root = textOf(opts, "root");

  if (typeof opts.accept === "string") {
    const event = asEvent(readJson(opts.accept), opts.accept === "-" ? "stdin" : opts.accept);
    const out = await accept(root, event);
    if (out.code !== "SYNC_ACCEPTED") process.stderr.write(`${out.code} ${event.aggregateId}#${event.seq}\n`);
    emit(
      opts.json === true,
      { action: "accept", code: out.code, persisted: out.persisted, aggregateId: event.aggregateId, seq: event.seq },
      [`accept ${event.aggregateId}#${event.seq} -> ${out.code}${out.persisted ? " (已落盘)" : " (未落盘)"}`],
    );
    return exitCodeOf(out.code);
  }

  if (opts.migrate === true) {
    const aggregateId = textOf(opts, "aggregate");
    const fromOwner = textOf(opts, "from");
    const toOwner = textOf(opts, "to");
    const at = opts.at === undefined ? Date.now() : intOf(opts, "at");
    const out = await migrate(root, { aggregateId, fromOwner, toOwner, at });
    if (out.code !== "SYNC_MIGRATED") {
      process.stderr.write(`${out.code} ${out.reason ?? ""}\n`);
    }
    emit(
      opts.json === true,
      {
        action: "migrate",
        code: out.code,
        aggregateId,
        fromOwner,
        toOwner,
        phases: out.phases,
        replays: out.replays.length,
        revokedOwner: out.revokedOwner ?? null,
        leaseToken: out.leaseToken ?? null,
        reason: out.reason ?? null,
        persisted: out.persisted,
      },
      [
        `migrate ${aggregateId} ${fromOwner} -> ${toOwner} -> ${out.code}`,
        `phases: ${out.phases.join(" -> ") || "(none)"} / replays: ${out.replays.length}` +
          (out.reason === undefined ? "" : ` / reason: ${out.reason}`),
      ],
    );
    return exitCodeOf(out.code);
  }

  if (opts.subscribe === true) {
    const aggregateId = textOf(opts, "aggregate");
    const sinceSeq = intOf(opts, "since", 0);
    const out = await subscribe(root, { aggregateId, sinceSeq });
    if (out.code !== "SYNC_SUBSCRIBED") process.stderr.write(`${out.code} ${aggregateId}\n`);
    emit(
      opts.json === true,
      {
        action: "subscribe",
        code: out.code,
        aggregateId,
        sinceSeq,
        dirtyFromSeq: out.subscription.dirtyFromSeq,
        watermark: out.watermark,
        history: out.history,
      },
      [
        `subscribe ${aggregateId} since=${sinceSeq} -> ${out.code}`,
        `dirtyFromSeq: ${out.subscription.dirtyFromSeq} / watermark: ${out.watermark} / history: ${out.history.length}`,
        ...out.history.map((item) => `  ${item.aggregateId}#${item.seq} ${item.ownerId} ${item.payloadHash}`),
      ],
    );
    return exitCodeOf(out.code);
  }

  if (typeof opts.watermark === "string") {
    const id = opts.watermark.trim();
    const value = await watermark(root, id);
    emit(opts.json === true, { action: "watermark", aggregateId: id, watermark: value }, [
      `watermark ${id} = ${value}`,
    ]);
    return 0;
  }

  if (opts.report === true) {
    const out = await report(root);
    emit(
      opts.json === true,
      { action: "report", ...out },
      [
        `report totalEvents=${out.totalEvents} aggregates=${out.aggregates.length}`,
        ...out.aggregates.map((item) => `  ${item.id} owner=${item.ownerId} watermark=${item.watermark} events=${item.events}`),
        `owners: ${Object.keys(out.owners).join(", ") || "(none)"}`,
      ],
    );
    return 0;
  }

  throw new ArgError("缺动作:--accept / --migrate / --subscribe / --watermark / --report");
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof ArgError ? error.message : (error as Error)?.message ?? String(error);
    process.stderr.write(`${error instanceof ArgError ? "ARG_ERROR" : "STORE_ERROR"} ${message}\n`);
    if (error instanceof ArgError) process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
  });
