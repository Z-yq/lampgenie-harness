#!/usr/bin/env node
/**
 * 计划退出评审 CLI(#10):--request / --decide / --timeout / --apply / --report。
 *
 * 纯表面层:状态机在 packages/harness-runtime/src/agent/plan-exit-review.ts,
 * 持久层(原子写 .genie/rsi/plan-exits.json)在 apps/gateway/src/plan-exit-store.ts。
 * 本文件只做 argv 解析、输出格式与退出码映射。
 *
 * 退出码:0 成功 / 1 参数或运行错误(含坏账本)
 *         2 业务拒绝(计划不全 / 无交互通道 / 缺反馈 / 超时失败 / 未到生效点 / 状态非法)。
 *
 * 用法:
 *   node --experimental-strip-types --conditions=development scripts/plan-exit.mts --root <dir> \
 *     [--request <file> --channel panel|cli|none] \
 *     [--decide <id> approve|keep-planning --feedback <s>] \
 *     [--timeout <id> --timeout-ms <ms>] [--apply <id>] [--report] \
 *     [--now <ms>] [--pre-step-at <ms>] [--json]
 */
import { readFileSync } from "node:fs";

import {
  applyPlanExitOnDisk,
  decidePlanExitOnDisk,
  isPlanExitRejection,
  PLAN_EXIT_STORE_ERROR,
  PLAN_EXIT_STORE_WRITE_MISMATCH,
  reportPlanExits,
  requestPlanExitOnDisk,
  timeoutPlanExitOnDisk,
} from "../apps/gateway/src/plan-exit-store.ts";
import type { PlanSubmission } from "@lampgenie/runtime/agent/plan-exit-review";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_REJECT = 2;

const VALUE_FLAGS = new Set([
  "root",
  "request",
  "channel",
  "decide",
  "timeout",
  "apply",
  "feedback",
  "now",
  "pre-step-at",
  "timeout-ms",
]);
const BOOL_FLAGS = new Set(["report", "json", "help"]);

type Parsed = { values: Map<string, string>; flags: Set<string>; positionals: string[]; unknown: string[] };

function parseArgs(argv: string[]): Parsed {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  const unknown: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i] ?? "";
    if (!raw.startsWith("--")) {
      positionals.push(raw);
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
  return { values, flags, positionals, unknown };
}

class UsageError extends Error {}

function out(json: boolean, payload: Record<string, unknown>, lines: string[]): void {
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`${lines.join("\n")}\n`);
}

/** 0 成功;坏账本/写失败算运行错误(1);其余 PLANEXIT_* 业务结论都是 2。 */
function exitFor(ok: boolean, code: string): number {
  if (ok) return EXIT_OK;
  if (code === PLAN_EXIT_STORE_ERROR || code === PLAN_EXIT_STORE_WRITE_MISMATCH) return EXIT_USAGE;
  return isPlanExitRejection(code) ? EXIT_REJECT : EXIT_USAGE;
}

function usageText(): string {
  return [
    "用法: plan-exit --root <dir> <动作> [--json]",
    "  --request <file> --channel panel|cli|none  提交计划退出评审(完整计划才落 pending)",
    "  --decide <id> approve|keep-planning        记录决定(keep-planning 必须 --feedback)",
    "  --timeout <id> [--timeout-ms <ms>]         超时裁决(到点 → failed,不自动批准)",
    "  --apply <id> [--pre-step-at <ms>]          下一次 pre-step 应用 pending exit(只一次)",
    "  --report                                   评审账本报告",
    "  --now <ms>  辅助参数(确定性时间)",
  ].join("\n");
}

function parseNumber(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new UsageError(`--${flag} 非法: ${raw}`);
  return value;
}

function main(argv: string[]): number {
  const parsed = parseArgs(argv);
  const json = parsed.flags.has("json");
  const root = (parsed.values.get("root") ?? "").trim();

  if (parsed.flags.has("help") || argv.length === 0) {
    out(json, { ok: true, codes: ["PLANEXIT_HELP"], usage: usageText() }, [usageText()]);
    return EXIT_OK;
  }
  if (parsed.unknown.length > 0) throw new UsageError(`未知参数: ${parsed.unknown.join(" ")}`);
  if (root === "") throw new UsageError("缺少 --root <dir>");

  const now = parseNumber(parsed.values.get("now"), "now");

  const actions: string[] = [];
  if (parsed.values.has("request")) actions.push("request");
  if (parsed.values.has("decide")) actions.push("decide");
  if (parsed.values.has("timeout")) actions.push("timeout");
  if (parsed.values.has("apply")) actions.push("apply");
  if (parsed.flags.has("report")) actions.push("report");
  if (actions.length === 0) throw new UsageError("缺少动作(见 --help)");
  if (actions.length > 1) throw new UsageError(`一次只能做一个动作: ${actions.join(", ")}`);
  const action = actions[0] as string;

  if (action === "request") {
    const file = (parsed.values.get("request") ?? "").trim();
    if (file === "") throw new UsageError("--request 需要计划文件路径");
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new UsageError(`无法读取/解析计划文件: ${file}`);
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new UsageError("计划文件必须是 JSON 对象");
    const rec = raw as Record<string, unknown>;
    const channelKind = (parsed.values.get("channel") ?? "").trim();
    if (channelKind !== "panel" && channelKind !== "cli" && channelKind !== "none") {
      throw new UsageError("--channel 只能是 panel|cli|none");
    }
    const timeoutMs = parseNumber(parsed.values.get("timeout-ms"), "timeout-ms");
    const submission: PlanSubmission = {
      planId: typeof rec["planId"] === "string" ? (rec["planId"] as string) : "",
      sessionId: typeof rec["sessionId"] === "string" ? (rec["sessionId"] as string) : "",
      plan: rec["plan"] as PlanSubmission["plan"],
      submittedAt: typeof rec["submittedAt"] === "number" ? (rec["submittedAt"] as number) : (now ?? Date.now()),
    };
    const r = requestPlanExitOnDisk(root, { submission, channel: { kind: channelKind, timeoutMs } });
    out(json, r as unknown as Record<string, unknown>, [
      `${r.code} plan=${r.state?.planId ?? "-"} status=${r.state?.status ?? "-"} written=${r.written}${r.detail === undefined ? "" : ` detail=${r.detail}`}`,
    ]);
    return exitFor(r.ok, r.code);
  }

  if (action === "decide") {
    const planId = (parsed.values.get("decide") ?? "").trim();
    if (planId === "") throw new UsageError("--decide 需要评审 id");
    const decision = parsed.positionals[0] ?? "";
    if (decision !== "approve" && decision !== "keep-planning") {
      throw new UsageError("--decide <id> 后必须跟 approve|keep-planning");
    }
    const feedback = parsed.values.get("feedback");
    const r = decidePlanExitOnDisk(root, { planId, decision, feedback, at: now ?? Date.now() });
    out(json, r as unknown as Record<string, unknown>, [
      `${r.code} plan=${planId} status=${r.state?.status ?? "-"} resume=${r.resume} written=${r.written}${r.feedback === undefined ? "" : ` feedback=${r.feedback}`}`,
    ]);
    return exitFor(r.ok, r.code);
  }

  if (action === "timeout") {
    const planId = (parsed.values.get("timeout") ?? "").trim();
    if (planId === "") throw new UsageError("--timeout 需要评审 id");
    const timeoutMs = parseNumber(parsed.values.get("timeout-ms"), "timeout-ms");
    const r = timeoutPlanExitOnDisk(root, { planId, now: now ?? Date.now(), timeoutMs });
    out(json, r as unknown as Record<string, unknown>, [
      `${r.code} plan=${planId} status=${r.state?.status ?? "-"} written=${r.written}${r.detail === undefined ? "" : ` detail=${r.detail}`}`,
    ]);
    return exitFor(r.ok, r.code);
  }

  if (action === "apply") {
    const planId = (parsed.values.get("apply") ?? "").trim();
    if (planId === "") throw new UsageError("--apply 需要评审 id");
    const preStepAt = now ?? parseNumber(parsed.values.get("pre-step-at"), "pre-step-at") ?? Date.now();
    const r = applyPlanExitOnDisk(root, { planId, preStepAt });
    out(json, r as unknown as Record<string, unknown>, [
      `${r.code} plan=${planId} status=${r.state?.status ?? "-"} applied=${r.state?.exitApplied === true}`,
    ]);
    return exitFor(r.ok, r.code);
  }

  const report = reportPlanExits(root);
  const lines = [
    `${report.ok ? "PLANEXIT_REPORT" : "PLANEXIT_STORE_ERROR"} file=${report.file} total=${report.total}`,
    `pending=${report.byStatus.pending} approved=${report.byStatus.approved} rejected=${report.byStatus.rejected} failed=${report.byStatus.failed}`,
    ...report.reviews.map(
      (r) =>
        `- ${r.planId} status=${r.status} exitApplied=${r.exitApplied === true}${r.pendingExitAt === undefined ? "" : ` due=${r.pendingExitAt}`}${r.feedback === undefined ? "" : ` feedback=${r.feedback}`}`,
    ),
  ];
  out(json, report as unknown as Record<string, unknown>, lines);
  return report.ok ? EXIT_OK : EXIT_USAGE;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stdout.write(`${JSON.stringify({ ok: false, codes: [err instanceof UsageError ? "PLANEXIT_USAGE_ERROR" : "PLANEXIT_RUNTIME_ERROR"], message })}\n`);
  process.exit(EXIT_USAGE);
}
