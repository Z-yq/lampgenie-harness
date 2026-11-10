#!/usr/bin/env node
/**
 * Office→PDF 共享准入 CLI(#182):准入 / 结算 / 撤销 / 淘汰 / 关停 / 报告。
 *
 * 纯表面层:准入裁决在 packages/harness-runtime/src/agent/office-pdf-admission.ts,
 * 持久层(原子写 .genie/rsi/office-pdf.json)在 apps/gateway/src/office-pdf-store.ts。
 * 本文件只做 argv 解析、输出格式与退出码映射;不 spawn 真 LibreOffice,
 * --complete 用注入的「假转换器」把最小合法 PDF 写进 <root>/.genie/rsi/office-pdf-out/<digest>.pdf。
 *
 * 退出码:0 成功(REUSED/JOINED/STARTED/QUEUED/READY/CANCELLED/EVICTED/REPORT)
 *         1 参数或运行错误(含坏账本)
 *         2 业务拒绝(REJECTED / INVALID_OUTPUT / SOURCE_CHANGED)。
 *
 * 用法:
 *   node --experimental-strip-types --conditions=development scripts/office-pdf.mts --root <dir> \
 *     [--admit <file>] [--priority foreground|background] [--gen <generation>] \
 *     [--complete <key> [--head <s>] [--tail <s>]] [--cancel <readerId> [--key <k>]] \
 *     [--evict <n>] [--report] [--json]
 */
import { readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

import {
  admitOnDisk,
  cancelOnDisk,
  completeOnDisk,
  disposeOnDisk,
  evictOnDisk,
  isOfficePdfRejection,
  reportOfficePdf,
  writeStubPdf,
  type Converter,
} from "../apps/gateway/src/office-pdf-store.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_REJECT = 2;

const VALUE_FLAGS = new Set(["root", "admit", "priority", "gen", "complete", "head", "tail", "cancel", "key", "evict"]);
const BOOL_FLAGS = new Set(["report", "dispose", "json", "help"]);

const DEFAULT_GENERATION = "libreoffice-stub-1";

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

function usageText(): string {
  return [
    "用法: office-pdf --root <dir> <动作> [--json]",
    "  --admit <file>                        为一份源文件申请转换(同 digest 第二次 = JOINED)",
    "     --priority foreground|background   缺省 foreground",
    "     --gen <generation>                 转换器代号(缺省 libreoffice-stub-1)",
    "  --complete <key> [--head <s>] [--tail <s>]  结算:假转换器写产物 → 校验首尾 → READY",
    "  --cancel <readerId> [--key <k>]        撤读者(最后一个读者撤了 = 转换作废)",
    "  --evict <n>                           按 lastUsed 淘汰到 ≤ n 份",
    "  --dispose                             关停(清在转/排队,之后拒绝一切准入)",
    "  --report                              账本报告",
  ].join("\n");
}

let readerSeq = 0;

function newReaderId(): string {
  readerSeq += 1;
  return `r-${Date.now().toString(36)}-${process.pid.toString(36)}-${readerSeq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function out(json: boolean, payload: Record<string, unknown>, lines: string[]): void {
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`${lines.join("\n")}\n`);
}

/** 主码:业务拒绝优先展示(便于自动化只看第一行)。 */
function primaryCode(codes: string[], ok: boolean): string {
  for (const code of codes) if (isOfficePdfRejection(code)) return code;
  const first = codes[0];
  if (first !== undefined) return first;
  return ok ? "OFFICEPDF_OK" : "OFFICEPDF_INVALID";
}

function exitFor(codes: string[], ok: boolean): number {
  for (const code of codes) if (isOfficePdfRejection(code)) return EXIT_REJECT;
  return ok ? EXIT_OK : EXIT_USAGE;
}

/** 假转换器:写最小合法 PDF 并回报真实 stat(不 spawn 真 LibreOffice)。 */
const stubConverter: Converter = (input) => writeStubPdf(input.root, { key: input.key, digest: input.digest, extension: input.extension });

function main(argv: string[]): number {
  const parsed = parseArgs(argv);
  const json = parsed.flags.has("json");
  const root = (parsed.values.get("root") ?? "").trim();

  if (parsed.flags.has("help") || argv.length === 0) {
    out(json, { ok: true, codes: ["OFFICEPDF_HELP"], usage: usageText() }, [usageText()]);
    return EXIT_OK;
  }
  if (parsed.unknown.length > 0) throw new UsageError(`未知参数: ${parsed.unknown.join(" ")}`);
  if (root === "") throw new UsageError("缺少 --root <dir>");

  const actions = ["admit", "complete", "cancel", "evict", "dispose", "report"].filter(
    (action) => parsed.values.has(action) || parsed.flags.has(action),
  );
  if (actions.length === 0) throw new UsageError("缺少动作(见 --help)");
  if (actions.length > 1) throw new UsageError(`一次只能做一个动作: ${actions.join(", ")}`);
  const action = actions[0] ?? "";

  if (action === "admit") {
    const file = (parsed.values.get("admit") ?? "").trim();
    if (file === "") throw new UsageError("--admit 需要源文件路径");
    const priorityRaw = (parsed.values.get("priority") ?? "foreground").trim();
    if (priorityRaw !== "foreground" && priorityRaw !== "background") throw new UsageError("--priority 只能是 foreground|background");
    const generation = (parsed.values.get("gen") ?? "").trim() === "" ? DEFAULT_GENERATION : (parsed.values.get("gen") ?? "").trim();
    const sourcePath = resolve(file);
    let bytes: Buffer;
    let size: number;
    let mtimeMs: number;
    try {
      bytes = readFileSync(sourcePath);
      const info = statSync(sourcePath);
      size = info.size;
      mtimeMs = Math.round(info.mtimeMs);
    } catch (err) {
      throw new UsageError(`读不到源文件: ${file}(${err instanceof Error ? err.message : String(err)})`);
    }
    const ext = extname(sourcePath).replace(/^\./, "").toLowerCase() || "bin";
    const id = newReaderId();
    // 账本只存 digest/size,绝不存源字节;sourceVersion = size:mtimeMs。
    const result = admitOnDisk(
      root,
      {
        id,
        extension: ext,
        converterGeneration: generation,
        bytes: new Uint8Array(bytes),
        size,
        priority: priorityRaw,
        sourceVersion: `${size}:${mtimeMs}`,
        name: sourcePath,
        now: Date.now(),
      },
      { sourcePath },
    );
    const primary = primaryCode(result.codes, result.ok);
    out(
      json,
      {
        ok: result.ok,
        action: result.action,
        codes: result.codes,
        code: primary,
        key: result.key,
        readerId: id,
        readers: result.readers,
        file: basename(sourcePath),
        sourceVersion: `${size}:${mtimeMs}`,
        persisted: result.persisted,
        queued: result.detail?.["queued"],
        summary: result.summary,
        ledger: result.file,
      },
      [
        `${primary} action=${result.action ?? "-"} key=${result.key ?? "-"} readers=${result.readers} id=${id}`,
        `  source=${basename(sourcePath)} version=${size}:${mtimeMs} gen=${generation} priority=${priorityRaw} persisted=${result.persisted}`,
      ],
    );
    return exitFor(result.codes, result.ok);
  }

  if (action === "complete") {
    const key = (parsed.values.get("complete") ?? "").trim();
    if (key === "") throw new UsageError("--complete 需要 key");
    const head = parsed.values.get("head");
    const tail = parsed.values.get("tail");
    const result = completeOnDisk(root, {
      key,
      converter: stubConverter,
      head: head === undefined || head === "" ? undefined : head,
      tail: tail === undefined || tail === "" ? undefined : tail,
      now: Date.now(),
    });
    const primary = primaryCode(result.codes, result.ok);
    const reasons = (result.detail?.["reasons"] as string[] | undefined) ?? [];
    out(
      json,
      {
        ok: result.ok,
        action: result.action,
        codes: result.codes,
        code: primary,
        key: result.key,
        path: result.entry?.path,
        size: result.entry?.size,
        releasedBytes: result.detail?.["releasedBytes"],
        reasons,
        persisted: result.persisted,
        summary: result.summary,
        ledger: result.file,
      },
      [
        `${primary} key=${key} size=${result.entry?.size ?? "-"} released=${result.detail?.["releasedBytes"] ?? "-"} reasons=${reasons.join(",") || "-"}`,
        `  path=${result.entry?.path ?? "-"} cached=${result.summary["cache"] ?? 0} inflight=${result.summary["inflight"] ?? 0}`,
      ],
    );
    return exitFor(result.codes, result.ok);
  }

  if (action === "cancel") {
    const id = (parsed.values.get("cancel") ?? "").trim();
    if (id === "") throw new UsageError("--cancel 需要读者 id");
    const key = (parsed.values.get("key") ?? "").trim();
    const result = cancelOnDisk(root, { id, key: key === "" ? undefined : key, now: Date.now() });
    const primary = primaryCode(result.codes, result.ok);
    const aborted = result.detail?.["aborted"] === true;
    out(
      json,
      {
        ok: result.ok,
        action: result.action,
        codes: result.codes,
        code: aborted ? "OFFICEPDF_CANCELLED" : primary,
        id,
        aborted,
        remaining: result.readers,
        releasedBytes: result.detail?.["releasedBytes"],
        persisted: result.persisted,
        summary: result.summary,
        ledger: result.file,
      },
      [
        `${aborted ? "OFFICEPDF_CANCELLED" : primary} id=${id} aborted=${aborted} remaining=${result.readers} released=${result.detail?.["releasedBytes"] ?? 0}`,
        `  inflight=${result.summary["inflight"] ?? 0} conversions=${result.summary["conversions"] ?? 0} activeBytes=${result.summary["activeBytes"] ?? 0}`,
      ],
    );
    return exitFor(result.codes, result.ok);
  }

  if (action === "evict") {
    const raw = (parsed.values.get("evict") ?? "").trim();
    const maxEntries = Number(raw);
    if (raw === "" || !Number.isFinite(maxEntries) || maxEntries < 0) throw new UsageError(`--evict 非法: ${raw}`);
    const result = evictOnDisk(root, { maxEntries, now: Date.now() });
    const evicted = (result.detail?.["evicted"] as string[] | undefined) ?? [];
    const primary = evicted.length > 0 ? "OFFICEPDF_EVICTED" : primaryCode(result.codes, result.ok);
    out(
      json,
      {
        ok: result.ok,
        action: result.action,
        codes: result.codes,
        code: primary,
        evicted,
        maxEntries,
        persisted: result.persisted,
        summary: result.summary,
        ledger: result.file,
      },
      [`${primary} evicted=${evicted.length} keys=${evicted.join(",") || "-"} cache=${result.summary["cache"] ?? 0}`],
    );
    return exitFor(result.codes, result.ok);
  }

  if (action === "dispose") {
    const result = disposeOnDisk(root);
    const unavailable = (result.detail?.["unavailable"] as string[] | undefined) ?? [];
    out(
      json,
      { ok: result.ok, codes: result.codes, code: primaryCode(result.codes, result.ok), unavailable, persisted: result.persisted, summary: result.summary, ledger: result.file },
      [`OFFICEPDF_DISPOSED unavailable=${unavailable.length} ids=${unavailable.join(",") || "-"} persisted=${result.persisted}`],
    );
    return exitFor(result.codes, result.ok);
  }

  // report
  const report = reportOfficePdf(root);
  const s = report.summary;
  const primary = report.ok ? "OFFICEPDF_REPORT" : primaryCode(report.codes, false);
  const lines = [
    `${primary} file=${report.file} cache=${s["cache"] ?? 0} ready=${s["ready"] ?? 0} failed=${s["failed"] ?? 0} inflight=${s["inflight"] ?? 0} readers=${s["readers"] ?? 0} queue=${s["queue"] ?? 0} conversions=${s["conversions"] ?? 0} activeBytes=${s["activeBytes"] ?? 0} aliases=${s["aliases"] ?? 0} disposed=${s["disposed"] ?? 0}`,
    ...report.cache.map((entry) => `- ${entry.key} ${entry.status} size=${entry.size} lastUsed=${entry.lastUsed} path=${entry.path || "-"}`),
    ...report.inflight.map((entry) => `* ${entry.key} inflight ext=${entry.extension} size=${entry.size} readers=${entry.readers} priority=${entry.priority}`),
    ...report.queue.map((entry) => `q ${entry.id} key=${entry.key} priority=${entry.priority} since=${entry.now}`),
  ];
  out(json, report as unknown as Record<string, unknown>, lines);
  return report.ok ? EXIT_OK : EXIT_USAGE;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  const isUsage = err instanceof UsageError;
  process.stdout.write(`${JSON.stringify({ ok: false, codes: [isUsage ? "OFFICEPDF_USAGE_ERROR" : "OFFICEPDF_RUNTIME_ERROR"], message })}\n`);
  process.exit(EXIT_USAGE);
}
