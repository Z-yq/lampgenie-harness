#!/usr/bin/env tsx
/**
 * 夹具录制/回放 CLI(#110)。
 *
 * 用法:
 *   tsx scripts/fixture-replay.mts --root <dir> --scope <name> [动作]
 *
 * 动作(每次调用只做一件,按下面顺序取第一个命中的):
 *   --refresh              删夹具文件(刷新 = 删文件重录)
 *   --report               报告单个 scope,或(不给 --scope)列出目录里全部夹具
 *   --expect <file>        打开 scope:JSON 数组或 {expected:[...]};文件存在 → replay,缺失 → record(CI 下失败)
 *   --replay <file>        回放一条请求(JSON ExpectedRequest,或 {request:...})
 *   --record <file>        录制一条 {request,response,at?};命中密钥拒绝写盘并保留旧文件
 *   --close                关闭 scope:used==total 才成功
 *
 * 其它参数:
 *   --root <dir>           仓库/任务根(<root>/.genie/fixtures/<name>.json),必填
 *   --scope <name>         scope 名,除「--report 列全部」外必填
 *   --env <file>           凭据值来源:JSON 对象(按 credential-like 变量名过滤)或字符串数组;缺省扫 process.env
 *   --passthrough          显式放行(不打夹具、不录制),退出码 0
 *   --help                 打用法
 *
 * 退出码:0 成功(含 passthrough);1 夹具语义失败(MISMATCH / INCOMPLETE / SECRET_DETECTED /
 * REPLAY_MISSING / INVALID / NOT_FOUND);2 参数错误或 IO 失败(FIXTURE_STORE_ERROR)。
 * stdout 一行 JSON(不含 scope 全文,只带 summary),stderr 给人读的失败原因。
 */
import { readFileSync } from "node:fs";
import { credentialEnvValues } from "../packages/harness-runtime/src/agent/fixture-replay.ts";
import type { ExpectedRequest } from "../packages/harness-runtime/src/agent/fixture-replay.ts";
import { close, fixturePath, openScope, record, refresh, replayNext, report } from "../apps/gateway/src/fixture-store.ts";
import type { FixtureStoreResult } from "../apps/gateway/src/fixture-store.ts";

const USAGE = [
  "用法: fixture-replay --root <dir> [--scope <name>] [--expect <file> | --replay <file> | --record <file> | --close | --refresh | --report] [--env <file>] [--passthrough]",
  "退出码: 0 成功 / 1 夹具失败 / 2 参数或 IO 错误",
].join("\n");

class ArgError extends Error {}

const BOOLEAN_FLAGS = new Set(["refresh", "report", "close", "passthrough", "help"]);
const VALUE_FLAGS = new Set(["root", "scope", "expect", "replay", "record", "env"]);

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

function readJson(src: string): unknown {
  const text = src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ArgError(`${src} 不是合法 JSON:${(error as Error).message}`);
  }
}

function asRequest(value: unknown, file: string): ExpectedRequest {
  const raw = value !== null && typeof value === "object" && "request" in (value as Record<string, unknown>)
    ? (value as Record<string, unknown>).request
    : value;
  if (raw === null || typeof raw !== "object") throw new ArgError(`${file} 必须是请求对象或 {request:...}`);
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id === "") throw new ArgError(`${file} 缺 id`);
  if (typeof r.method !== "string" || r.method === "") throw new ArgError(`${file} 缺 method`);
  if (typeof r.url !== "string" || r.url === "") throw new ArgError(`${file} 缺 url`);
  return raw as ExpectedRequest;
}

function asExpected(value: unknown, file: string): ExpectedRequest[] {
  const list = Array.isArray(value)
    ? value
    : value !== null && typeof value === "object" && Array.isArray((value as Record<string, unknown>).expected)
      ? (value as Record<string, unknown>).expected
      : undefined;
  if (!Array.isArray(list)) throw new ArgError(`${file} 必须是请求数组或 {expected:[...]}`);
  return list.map((item, i) => asRequest(item, `${file}[${i}]`));
}

function asEnvValues(value: unknown, file: string): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (value !== null && typeof value === "object") {
    const env: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (typeof v === "string") env[k] = v;
    return credentialEnvValues(env);
  }
  throw new ArgError(`${file} 必须是对象或字符串数组`);
}

function envValuesOf(opts: Options): string[] {
  if (typeof opts.env === "string") return asEnvValues(readJson(opts.env), opts.env);
  return credentialEnvValues(process.env);
}

const OK_CODES = new Set([
  "FIXTURE_OPENED",
  "FIXTURE_MATCHED",
  "FIXTURE_RECORDED",
  "FIXTURE_CLOSED",
  "FIXTURE_REFRESHED",
  "FIXTURE_PASSTHROUGH",
  "FIXTURE_REPORT",
  "FIXTURE_CLEAN",
]);

function exitCodeOf(result: FixtureStoreResult): number {
  if (OK_CODES.has(result.code)) return 0;
  if (result.code === "FIXTURE_STORE_ERROR") return 2;
  return 1;
}

function emit(result: FixtureStoreResult): void {
  const { scope: _scope, ...rest } = result;
  process.stdout.write(`${JSON.stringify(rest)}\n`);
  if (!OK_CODES.has(result.code)) {
    process.stderr.write(`✗ ${result.code}${result.reason ? `: ${result.reason}` : ""}\n`);
    for (const hit of result.hits ?? []) process.stderr.write(`  secret ${hit.kind} @${hit.at} ${hit.preview}\n`);
    for (const err of result.errors ?? []) process.stderr.write(`  ${err}\n`);
  }
}

async function run(opts: Options): Promise<number> {
  if (opts.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const root = opts.root;
  if (typeof root !== "string" || root === "") throw new ArgError("--root 必填");
  const scope = typeof opts.scope === "string" ? opts.scope : undefined;
  const needsScope = opts.report !== true || scope !== undefined;
  if (needsScope && scope === undefined) throw new ArgError("--scope 必填(除 --report 列全部)");
  if (opts.passthrough === true) {
    emit({ code: "FIXTURE_PASSTHROUGH", path: scope ? fixturePath(root, scope) : undefined, mode: "passthrough", reason: "explicit-passthrough" });
    return 0;
  }
  if (opts.refresh === true) {
    const result = await refresh(root, scope as string);
    emit(result);
    return exitCodeOf(result);
  }
  if (opts.report === true) {
    const result = await report(root, scope);
    emit(result);
    return exitCodeOf(result);
  }
  if (typeof opts.expect === "string") {
    const expected = asExpected(readJson(opts.expect), opts.expect);
    const result = await openScope(root, scope as string, expected, { envMode: process.env.CI });
    emit(result);
    return exitCodeOf(result);
  }
  if (typeof opts.replay === "string") {
    const request = asRequest(readJson(opts.replay), opts.replay);
    const result = await replayNext(root, scope as string, request);
    emit(result);
    return exitCodeOf(result);
  }
  if (typeof opts.record === "string") {
    const payload = readJson(opts.record);
    if (payload === null || typeof payload !== "object") throw new ArgError(`${opts.record} 必须是 {request,response}`);
    const p = payload as Record<string, unknown>;
    const request = asRequest(p.request, `${opts.record}.request`);
    if (!("response" in p)) throw new ArgError(`${opts.record} 缺 response`);
    const at = typeof p.at === "number" && Number.isFinite(p.at) ? p.at : undefined;
    const result = await record(root, scope as string, { request, response: p.response, ...(at !== undefined ? { at } : {}) }, { envValues: envValuesOf(opts) });
    emit(result);
    return exitCodeOf(result);
  }
  if (opts.close === true) {
    const result = await close(root, scope as string);
    emit(result);
    return exitCodeOf(result);
  }
  throw new ArgError("缺少动作:--expect / --replay / --record / --close / --refresh / --report");
}

async function main(): Promise<number> {
  try {
    return await run(parseArgs(process.argv.slice(2)));
  } catch (error) {
    if (error instanceof ArgError) {
      process.stderr.write(`参数错误: ${error.message}\n${USAGE}\n`);
      return 2;
    }
    process.stderr.write(`✗ 运行失败: ${(error as Error).message}\n`);
    return 2;
  }
}

process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
process.exitCode = await main();
