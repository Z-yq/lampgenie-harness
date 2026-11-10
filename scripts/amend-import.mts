#!/usr/bin/env node
/**
 * 改派导入(amend-import)CLI:预检 / 建缓存 / 匹配 / 关门 / 续跑决策 / 报告。
 *
 * 纯表面层:裁决在 packages/harness-runtime/src/agent/amend-import.ts,
 * 持久层(原子写 .genie/rsi/amend.json)在 apps/gateway/src/amend-import-store.ts。
 * 本文件只做 argv 解析、输出格式与退出码映射。
 *
 * 退出码:0 成功(含 FALLBACK_LIVE / HIT / MISS 这类正常结论)
 *         1 参数或运行/存储错误
 *         2 业务拒绝(precheck 任意失败码 / HASH_DIVERGED / DOOR_CLOSED / ...)
 *
 * 用法:
 *   node --experimental-strip-types --conditions=development scripts/amend-import.mts --root <dir> \
 *     [--precheck <run.json> [--target-session s]] [--build <run.json>] \
 *     [--match --actor a --ask id --hash h] [--world-calls n] \
 *     [--resume --cache-ok true|false] [--report] [--json]
 */
import {
  buildFromFile,
  closeOnDisk,
  isAmendRejection,
  matchOnDisk,
  precheckFromFile,
  reportAmendStore,
  resumeOnDisk,
} from "../apps/gateway/src/amend-import-store.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_REJECT = 2;

const VALUE_FLAGS = new Set([
  "root",
  "precheck",
  "target-session",
  "build",
  "actor",
  "ask",
  "hash",
  "world-calls",
  "cache-ok",
]);
const BOOL_FLAGS = new Set(["match", "resume", "report", "json", "help"]);

type Parsed = { values: Map<string, string>; flags: Set<string>; unknown: string[] };

function parseArgs(argv: string[]): Parsed {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const unknown: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i] ?? "";
    if (!raw.startsWith("--")) {
      unknown.push(raw);
      continue;
    }
    const name = raw.slice(2);
    if (VALUE_FLAGS.has(name)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        values.set(name, "");
        continue;
      }
      values.set(name, next);
      i += 1;
      continue;
    }
    if (BOOL_FLAGS.has(name)) flags.add(name);
    else unknown.push(raw);
  }
  return { values, flags, unknown };
}

class UsageError extends Error {}

function out(json: boolean, payload: Record<string, unknown>, line: string): void {
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`${line}\n`);
}

function primaryCode(codes: string[], fallback: string): string {
  return codes[0] ?? fallback;
}

/** 正常结论码:即便 ok=false(MISS 查不到条目 / FALLBACK_LIVE 降级)也不代表执行失败。 */
const NORMAL_CODES = new Set(["AMEND_MISS", "AMEND_FALLBACK_LIVE"]);

function exitFor(ok: boolean, codes: string[]): number {
  if (ok) return EXIT_OK;
  if (codes.length > 0 && codes.every((code) => NORMAL_CODES.has(code))) return EXIT_OK;
  // 业务拒绝(precheck 的 INVALID/RUN_MISSING/BOUNDARY_MISSING/TARGET_DIRTY、HASH_DIVERGED、DOOR_CLOSED)→ 2;
  // 其余(用法/运行/存储错误,如 AMEND_STORE_ERROR)→ 1:存储坏了不是「场景不允许」。
  const rejected = codes.some((code) => isAmendRejection(code));
  return rejected ? EXIT_REJECT : EXIT_USAGE;
}

function joinOrDash(list: string[]): string {
  return list.length === 0 ? "-" : list.join(",");
}

function usageText(): string {
  return [
    "用法: amend-import --root <dir> <动作> [--json]",
    "  --precheck <run.json> [--target-session <s>]  预检(失败即 exit 2)",
    "  --build [<run.json>]                          构建导入缓存(缺省用账本里的 run)",
    "  --match --actor <a> --ask <id> [--hash <h>]   导入匹配",
    "  --world-calls <n>                             世界写发生 → 关门",
    "  --resume --cache-ok true|false                续跑决策(cache|live)",
    "  --report                                      账本摘要",
  ].join("\n");
}

function main(argv: string[]): number {
  const parsed = parseArgs(argv);
  const json = parsed.flags.has("json");
  const root = (parsed.values.get("root") ?? "").trim();

  if (parsed.flags.has("help") || argv.length === 0) {
    out(json, { ok: true, codes: ["AMEND_HELP"], usage: usageText() }, usageText());
    return EXIT_OK;
  }
  if (parsed.unknown.length > 0) throw new UsageError(`未知参数: ${parsed.unknown.join(" ")}`);
  if (root === "") throw new UsageError("缺少 --root <dir>");

  const actions = ["precheck", "build", "match", "world-calls", "resume", "report"].filter(
    (action) => parsed.flags.has(action) || parsed.values.has(action),
  );
  if (actions.length === 0) throw new UsageError("缺少动作(见 --help)");
  if (actions.length > 1) throw new UsageError(`一次只能做一个动作: ${actions.join(", ")}`);
  const action = actions[0] ?? "";

  if (action === "precheck") {
    const runFile = (parsed.values.get("precheck") ?? "").trim();
    if (runFile === "") throw new UsageError("--precheck 需要 run.json 路径");
    const targetSessionId = (parsed.values.get("target-session") ?? "").trim();
    const r = precheckFromFile(root, runFile, targetSessionId === "" ? {} : { targetSessionId });
    const code = primaryCode(r.codes, "AMEND_PRECHECK_OK");
    out(json, r as unknown as Record<string, unknown>, [
      `${code} run=${r.runId || "-"} stopped=${r.stopped} pending=${joinOrDash(r.pending)} file=${r.file}`,
    ].join(" "));
    return exitFor(r.ok, r.codes);
  }

  if (action === "build") {
    const runFile = (parsed.values.get("build") ?? "").trim();
    const r = buildFromFile(root, runFile === "" ? undefined : runFile);
    const code = primaryCode(r.codes, "AMEND_CACHE_BUILT");
    out(json, r as unknown as Record<string, unknown>, [
      `${code} actors=${r.cacheActors} asks=${r.cacheAsks} world=${r.worldQueue} persisted=${r.persisted}`,
    ].join(" "));
    return exitFor(r.ok, r.codes);
  }

  if (action === "match") {
    const actor = (parsed.values.get("actor") ?? "").trim();
    const askId = (parsed.values.get("ask") ?? "").trim();
    if (actor === "") throw new UsageError("--match 需要 --actor <a>");
    if (askId === "") throw new UsageError("--match 需要 --ask <id>");
    const hash = (parsed.values.get("hash") ?? "").trim();
    const r = matchOnDisk(root, hash === "" ? { actor, askId } : { actor, askId, payloadHash: hash });
    const code = primaryCode(r.codes, r.hit ? "AMEND_HIT" : "AMEND_MISS");
    const node = r.node;
    out(json, r as unknown as Record<string, unknown>, [
      `${code} hit=${r.hit} imported=${node?.id ?? "-"} kind=${node?.kind ?? "-"} toolCalls=${node?.toolCalls ?? 0} actor=${actor} ask=${askId}`,
    ].join(" "));
    return exitFor(r.ok, r.codes);
  }

  if (action === "world-calls") {
    const raw = (parsed.values.get("world-calls") ?? "").trim();
    const worldToolCalls = raw === "" ? Number.NaN : Number(raw);
    if (!Number.isFinite(worldToolCalls) || worldToolCalls < 0) throw new UsageError(`--world-calls 非法: ${raw}`);
    const r = closeOnDisk(root, { worldToolCalls });
    const code = primaryCode(r.codes, "AMEND_DOOR_CLOSED");
    out(json, r as unknown as Record<string, unknown>, [`${code} closed=${r.closed} worldCalls=${worldToolCalls} persisted=${r.persisted}`].join(" "));
    return exitFor(r.ok, r.codes);
  }

  if (action === "resume") {
    const cacheOkRaw = (parsed.values.get("cache-ok") ?? "").trim().toLowerCase();
    if (cacheOkRaw !== "true" && cacheOkRaw !== "false") throw new UsageError("--resume 需要 --cache-ok true|false");
    const r = resumeOnDisk(root, { cacheOk: cacheOkRaw === "true" });
    const code = primaryCode(r.codes, r.mode === "cache" ? "AMEND_RESUME_CACHE" : "AMEND_FALLBACK_LIVE");
    out(json, r as unknown as Record<string, unknown>, [`${code} mode=${r.mode} persisted=${r.persisted}`].join(" "));
    return exitFor(r.ok, r.codes);
  }

  // report
  const report = reportAmendStore(root);
  const code = primaryCode(report.codes, "AMEND_REPORT");
  out(json, report as unknown as Record<string, unknown>, [
    `${code} file=${report.file} run=${report.runId || "-"}`,
    `completed=${report.asks.completed} running=${report.asks.running} failed=${report.asks.failed}`,
    `actors=${report.cacheActors} asks=${report.cacheAsks} world=${report.worldQueue} closed=${report.closed}`,
    `diverged=${joinOrDash(report.diverged)} precheck=${report.precheckCode ?? "-"} resume=${report.resumeMode ?? "-"}`,
  ].join(" "));
  return report.ok ? EXIT_OK : EXIT_USAGE;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  const isUsage = err instanceof UsageError;
  process.stdout.write(`${JSON.stringify({ ok: false, codes: [isUsage ? "AMEND_USAGE_ERROR" : "AMEND_RUNTIME_ERROR"], message })}\n`);
  process.exit(EXIT_USAGE);
}
