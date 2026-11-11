#!/usr/bin/env node
/**
 * RSI 产出注入安全边界 CLI(#198):准入判定 / 人工批准 / 来源拉黑 / 状态 / 台账报告。
 * 纯表面层:所有判定在
 * packages/harness-runtime/src/agent/rsi-injection-guard.ts(纯逻辑)
 * apps/gateway/src/rsi-injection-store.ts(.genie/rsi/injection.jsonl 追加台账)
 * 本文件只做 argv 解析、payload 读入与退出码映射。
 * 跑法:node --experimental-strip-types scripts/rsi-injection-guard.mts --help
 * 退出码:0 通过/成功 / 1 参数或运行错误 / 2 被拒(码打 stderr) / 3 重复(已批/已拉黑)。
 */
import fs from "node:fs";
import path from "node:path";

import {
  approveInjection,
  blacklistSource,
  guardInjection,
  injectionPaths,
  isBlacklisted,
  reportInjections,
} from "../apps/gateway/src/rsi-injection-store.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_REJECTED = 2;
const EXIT_DUPLICATE = 3;

const VALUE_FLAGS = new Set(["root", "guard", "approve", "blacklist", "status", "by", "reason", "kind"]);
const BOOL_FLAGS = new Set(["json", "help", "report"]);

/** 重复类码 → 退出码 3(与「被拒」区分:重复不是安全判定失败,是审计链显形)。 */
const DUPLICATE_CODES = new Set(["INJ_ALREADY_APPROVED", "INJ_ALREADY_BLACKLISTED"]);

type Parsed = { values: Map<string, string>; flags: Set<string>; positional: string[] };

function parseArgs(argv: string[]): Parsed {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    if (!raw.startsWith("--")) {
      positional.push(raw);
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
      i++;
      continue;
    }
    if (BOOL_FLAGS.has(name)) flags.add(name);
  }
  return { values, flags, positional };
}

function fail(code: number, message: string, json: boolean): never {
  const text = `${message}\n`;
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, codes: [message], exitCode: code }, null, 2)}\n`);
  else process.stderr.write(text);
  process.exit(code);
  throw new Error(message);
}

function readPayload(spec: string): unknown {
  const raw = spec === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(path.resolve(spec), "utf8");
  return JSON.parse(raw);
}

function emit(json: boolean, payload: Record<string, unknown>, lines: string[]): void {
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`${lines.join("\n")}\n`);
}

function codeExit(codes: string[]): number {
  if (codes.some((c) => DUPLICATE_CODES.has(c))) return EXIT_DUPLICATE;
  return EXIT_REJECTED;
}

const HELP = [
  "用法:node --experimental-strip-types scripts/rsi-injection-guard.mts --root <dir> <子命令> [--json]",
  "  --guard <payload.json|->            准入判定(payload 见 rsi-injection-guard.ts 的 InjectionPayload)",
  "  --approve <auditId> --by <who> [--kind human|agent]   人工批准(缺省 human;agent 一律不算)",
  "  --blacklist <sourceId> --by <who> --reason <text>    拉黑来源",
  "  --status <sourceId>                 查来源是否已拉黑",
  "  --report [--json]                   台账投影报告",
  "  --help",
  `台账:<root>/.genie/rsi/injection.jsonl(append-only,只落 sha256,不落原文)`,
  "退出码:0 通过/成功 / 1 参数错误 / 2 被拒(码打 stderr) / 3 已被批准或已拉黑",
].join("\n");

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  const json = parsed.flags.has("json");
  const get = (name: string): string | undefined => parsed.values.get(name);
  const root = get("root") ?? "";

  if (parsed.flags.has("help") || (parsed.flags.size === 0 && parsed.values.size === 0)) {
    process.stdout.write(`${HELP}\n`);
    return EXIT_OK;
  }

  if (!root) fail(EXIT_USAGE, "--root 必填", json);

  if (parsed.values.has("guard")) {
    const spec = get("guard") ?? "";
    if (!spec) fail(EXIT_USAGE, "--guard 需要 <payload.json|->", json);
    let payload: unknown;
    try {
      payload = readPayload(spec);
    } catch (err) {
      fail(EXIT_USAGE, `payload 读取/解析失败:${(err as Error).message}`, json);
    }
    const res = await guardInjection(root, payload as never);
    const risk = res.riskFlags.map((f) => `${f.kind}:${f.match}`).join(" , ") || "-";
    emit(
      json,
      {
        ok: res.ok,
        auditId: res.auditId,
        codes: res.codes,
        sanitizedText: res.sanitizedText,
        wrapped: res.wrapped,
        riskFlags: res.riskFlags,
        templateId: res.templateId ?? null,
        approvalRef: res.approvalRef ?? null,
        ledger: injectionPaths(root).file,
      },
      [
        `ok=${res.ok}`,
        `auditId=${res.auditId}`,
        `codes=${res.codes.join(",") || "-"}`,
        ...(res.approvalRef ? [`approvalRef=${res.approvalRef}`] : []),
        `riskFlags=${risk}`,
        `sanitizedText=${res.sanitizedText ?? ""}`,
        `wrapped=${res.wrapped ?? ""}`,
      ],
    );
    if (!res.ok) {
      process.stderr.write(`codes=${res.codes.join(",")}\n`);
      return codeExit(res.codes);
    }
    return EXIT_OK;
  }

  if (parsed.values.has("approve")) {
    const auditId = (get("approve") ?? "") || parsed.positional[0] || "";
    if (!auditId) fail(EXIT_USAGE, "--approve 需要 <auditId>", json);
    const by = get("by") ?? "";
    if (!by) fail(EXIT_USAGE, "--approve 需要 --by <who>", json);
    const kindRaw = get("kind") ?? "human";
    if (kindRaw !== "human" && kindRaw !== "agent") fail(EXIT_USAGE, `--kind 非法:${kindRaw}`, json);
    const res = await approveInjection(root, auditId, { by, kind: kindRaw });
    emit(json, { ...res, auditId, by, kind: kindRaw }, [`ok=${res.ok}`, `auditId=${auditId}`, `code=${res.code ?? "-"}`]);
    if (res.ok) return EXIT_OK;
    process.stderr.write(`codes=${res.code ?? ""}\n`);
    return codeExit([res.code ?? ""]);
  }

  if (parsed.values.has("blacklist")) {
    const sourceId = (get("blacklist") ?? "") || parsed.positional[0] || "";
    if (!sourceId) fail(EXIT_USAGE, "--blacklist 需要 <sourceId>", json);
    const by = get("by") ?? "";
    const reason = get("reason") ?? "";
    if (!by) fail(EXIT_USAGE, "--blacklist 需要 --by <who>", json);
    if (!reason) fail(EXIT_USAGE, "--blacklist 需要 --reason <text>", json);
    const res = await blacklistSource(root, sourceId, { by, reason });
    emit(json, { ...res, sourceId, by, reason }, [`ok=${res.ok}`, `sourceId=${sourceId}`, `code=${res.code ?? "-"}`]);
    if (res.ok) return EXIT_OK;
    process.stderr.write(`codes=${res.code ?? ""}\n`);
    return codeExit([res.code ?? ""]);
  }

  if (parsed.values.has("status")) {
    const sourceId = (get("status") ?? "") || parsed.positional[0] || "";
    if (!sourceId) fail(EXIT_USAGE, "--status 需要 <sourceId>", json);
    const blocked = isBlacklisted(root, sourceId);
    emit(json, { ok: true, sourceId, blacklisted: blocked }, [`sourceId=${sourceId}`, `blacklisted=${blocked}`]);
    return EXIT_OK;
  }

  if (parsed.flags.has("report")) {
    const report = reportInjections(root);
    const fmt = (rec: Record<string, number>): string =>
      Object.entries(rec)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([k, v]) => `${k}:${v}`)
        .join(" , ") || "-";
    emit(json, { ok: true, ...report }, [
      `total=${report.total}`,
      `lines=${report.lines}`,
      `corruptLines=${report.corruptLines}`,
      `pendingApproval=${report.pendingApproval}`,
      `blacklisted=${report.blacklisted.join(",") || "-"}`,
      `byCode=${fmt(report.byCode)}`,
      `byChannel=${fmt(report.byChannel)}`,
      `bySource=${fmt(report.bySource)}`,
    ]);
    return EXIT_OK;
  }

  fail(EXIT_USAGE, "缺少子命令(--guard/--approve/--blacklist/--status/--report)", json);
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`error: ${(err as Error)?.message ?? String(err)}\n`);
    process.exit(EXIT_USAGE);
  },
);
