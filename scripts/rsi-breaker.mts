#!/usr/bin/env node
/**
 * RSI 熔断器 CLI(#197):状态 / 人工暂停 / 人工恢复 / 评估 / 基准快照 / 回滚计划 / 报告。
 * 纯表面层:所有状态机与基准逻辑在
 * packages/harness-runtime/src/agent/rsi-circuit-breaker.ts(纯逻辑)
 * apps/gateway/src/rsi-breaker-store.ts(.genie/rsi/breaker.jsonl 追加事件 + 投影)
 * 本文件只做 argv 解析、JSON 文件读入与退出码映射。
 * 退出码:0 成功 / 1 参数或运行错误 / 2 被熔断阻断或被拒 / 3 重复或无效基线。
 */
import fs from "node:fs";
import path from "node:path";

import {
  evaluateAndApply,
  getBaseline,
  getState,
  listBaselines,
  markRollbackApplied,
  outcomesFromExperiments,
  pause,
  planRollback,
  reportBreaker,
  resume,
  takeBaseline,
} from "../apps/gateway/src/rsi-breaker-store.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_REJECTED = 2;
const EXIT_BASELINE = 3;

const VALUE_FLAGS = new Set([
  "root",
  "by",
  "reason",
  "scope",
  "kind",
  "from-experiments",
  "guard",
  "policy",
  "file",
  "label",
  "experiments",
  "rollback-plan",
  "mark-rolled-back",
]);

const BOOL_FLAGS = new Set(["status", "pause", "resume", "evaluate", "apply", "baseline", "baselines", "report", "json", "help"]);

type Parsed = { values: Map<string, string>; flags: Set<string>; positional: string[] };

function parseArgs(argv: string[]): Parsed {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
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
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, codes: [message], exitCode: code }, null, 2)}\n`);
  else process.stdout.write(`${message}\n`);
  process.exit(code);
  throw new Error(message);
}

function readJsonFile(file: string): unknown {
  const abs = path.resolve(file);
  const text = fs.readFileSync(abs, "utf8");
  return JSON.parse(text);
}

function emit(json: boolean, payload: Record<string, unknown>, lines: string[]): void {
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`${lines.join("\n")}\n`);
}

function scopeOf(value: string | undefined): "all" | "nightly" | "experiments" | "injection" | undefined {
  if (value === undefined) return undefined;
  if (value === "all" || value === "nightly" || value === "experiments" || value === "injection") return value;
  return undefined;
}

function codeExit(codes: string[]): number {
  if (codes.some((c) => c === "RSI_BASELINE_DUPLICATE" || c === "RSI_BASELINE_MISSING" || c === "RSI_ROLLBACK_ALREADY_APPLIED")) {
    return EXIT_BASELINE;
  }
  return EXIT_REJECTED;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  const json = parsed.flags.has("json");
  const root = parsed.values.get("root") ?? "";
  const get = (name: string): string | undefined => parsed.values.get(name);

  if (parsed.flags.has("help") || (parsed.flags.size === 0 && parsed.values.size === 0)) {
    process.stdout.write(
      [
        "用法:node --experimental-strip-types scripts/rsi-breaker.mts --root <dir> <子命令> [--json]",
        "  --status",
        "  --pause --by <who> --reason <text> [--scope all|nightly|experiments|injection]",
        "  --resume --by <who> --reason <text> [--kind human|agent]",
        "  --evaluate --from-experiments <experimentLedgerRoot> [--guard <json>] [--policy <json>] [--apply]",
        "  --baseline --file <snapshot.json> [--label <text>]",
        "  --baselines",
        "  --rollback-plan <baselineId> [--experiments <file>]",
        "  --mark-rolled-back <baselineId>",
        "  --report",
        "退出码:0 成功 / 1 参数错误 / 2 被熔断阻断或被拒 / 3 重复或无效基线",
      ].join("\n") + "\n",
    );
    return EXIT_OK;
  }

  if (!root) fail(EXIT_USAGE, "--root 必填", json);

  if (parsed.flags.has("status")) {
    const state = await getState(root);
    emit(json, { ok: true, state }, [
      `paused=${state.paused}`,
      `scope=${state.scope}`,
      `trigger=${state.trigger ?? "-"}`,
      `by=${state.by ?? "-"}`,
      `reason=${state.reason ?? "-"}`,
      `pausedAt=${state.pausedAt ?? "-"}`,
      `recoveredAt=${state.recoveredAt ?? "-"}`,
    ]);
    return EXIT_OK;
  }

  if (parsed.flags.has("pause")) {
    const scopeRaw = get("scope");
    const scope = scopeOf(scopeRaw);
    if (scopeRaw !== undefined && scope === undefined) fail(EXIT_USAGE, `--scope 非法:${scopeRaw}`, json);
    const res = await pause(root, { by: get("by") ?? "", reason: get("reason") ?? "", scope });
    emit(json, res, [
      `ok=${res.ok}`,
      `codes=${res.codes.join(",") || "-"}`,
      `paused=${res.state.paused}`,
      `scope=${res.state.scope}`,
      `trigger=${res.state.trigger ?? "-"}`,
    ]);
    return res.ok ? EXIT_OK : codeExit(res.codes);
  }

  if (parsed.flags.has("resume")) {
    const kindRaw = get("kind") ?? "human";
    if (kindRaw !== "human" && kindRaw !== "agent") fail(EXIT_USAGE, `--kind 非法:${kindRaw}`, json);
    const res = await resume(root, { by: get("by") ?? "", reason: get("reason") ?? "", kind: kindRaw });
    emit(json, res, [
      `ok=${res.ok}`,
      `codes=${res.codes.join(",") || "-"}`,
      `paused=${res.state.paused}`,
      `recoveredAt=${res.state.recoveredAt ?? "-"}`,
    ]);
    return res.ok ? EXIT_OK : codeExit(res.codes);
  }

  if (parsed.flags.has("evaluate")) {
    const fromRoot = get("from-experiments");
    const outcomes = fromRoot ? await outcomesFromExperiments(fromRoot) : [];
    const guardFile = get("guard");
    const guardMetrics = guardFile ? (readJsonFile(guardFile) as Record<string, number>) : undefined;
    const policyFile = get("policy");
    const policy = policyFile ? (readJsonFile(policyFile) as Record<string, unknown>) : undefined;
    const apply = parsed.flags.has("apply");
    const res = await evaluateAndApply(root, { outcomes, guardMetrics, policy: policy as never, apply });
    emit(json, { ...res, sourceOutcomes: outcomes.length }, [
      `shouldPause=${res.evaluation.shouldPause}`,
      `trigger=${res.evaluation.trigger ?? "-"}`,
      `streak=${res.evaluation.streak}`,
      `codes=${res.codes.join(",") || "-"}`,
      `breaches=${res.evaluation.breaches.map((b) => `${b.metric}:${b.value}${b.direction === "increase" ? "<" : ">"}${b.threshold}`).join(",") || "-"}`,
      `applied=${res.applied}`,
      `paused=${res.state.paused}`,
      `state.trigger=${res.state.trigger ?? "-"}`,
    ]);
    return res.ok ? EXIT_OK : codeExit(res.codes);
  }

  if (parsed.flags.has("baseline")) {
    const file = get("file");
    if (!file) fail(EXIT_USAGE, "--baseline 需要 --file <snapshot.json>", json);
    let payload: Record<string, unknown>;
    try {
      payload = readJsonFile(file) as Record<string, unknown>;
    } catch (err) {
      fail(EXIT_BASELINE, `无效基线文件:${(err as Error).message}`, json);
    }
    const versions = payload.versions as Record<string, unknown> | undefined;
    if (typeof payload.id !== "string" || !payload.id || !versions) {
      fail(EXIT_BASELINE, "无效基线文件:缺少 id 或 versions", json);
    }
    const missing = ["tools", "tips", "prompts", "wiki", "graph"].filter((k) => typeof versions[k] !== "string");
    if (missing.length) fail(EXIT_BASELINE, `无效基线文件:versions 缺 ${missing.join(",")}`, json);
    const res = await takeBaseline(root, {
      id: payload.id,
      label: get("label") ?? (typeof payload.label === "string" ? payload.label : undefined),
      at: typeof payload.at === "string" ? payload.at : undefined,
      versions: versions as never,
      metrics: (payload.metrics as Record<string, number> | undefined) ?? {},
    });
    emit(json, res, [`ok=${res.ok}`, `codes=${res.codes.join(",") || "-"}`, `hash=${res.snapshot?.hash ?? "-"}`]);
    return res.ok ? EXIT_OK : codeExit(res.codes);
  }

  if (parsed.flags.has("baselines")) {
    const baselines = await listBaselines(root);
    emit(json, { ok: true, baselines }, baselines.length
      ? baselines.map((b, i) => `${i + 1}. ${b.id} ${b.label ?? ""} ${b.at} ${b.hash}`)
      : ["(无基准快照)"]);
    return EXIT_OK;
  }

  if (parsed.values.has("rollback-plan")) {
    const targetId = get("rollback-plan") || parsed.positional[0] || "";
    if (!targetId) fail(EXIT_USAGE, "--rollback-plan <baselineId> 缺少基线 id", json);
    const expFile = get("experiments");
    const affectedExperiments = expFile ? (readJsonFile(expFile) as string[]) : undefined;
    const res = await planRollback(root, targetId, { affectedExperiments });
    const lines = [`ok=${res.ok}`, `codes=${res.codes.join(",") || "-"}`];
    if (res.plan) {
      res.plan.steps.forEach((s, i) => lines.push(`${i + 1}. ${s.step} ref=${s.ref} — ${s.note}`));
      lines.push(`requeue=${res.plan.requeueExperiments.join(",") || "(空)"}`);
    }
    emit(json, res, lines);
    if (!res.ok) return codeExit(res.codes);
    const target = await getBaseline(root, targetId);
    return target ? EXIT_OK : codeExit(["RSI_BASELINE_MISSING"]);
  }

  if (parsed.values.has("mark-rolled-back")) {
    const targetId = get("mark-rolled-back") || parsed.positional[0] || "";
    if (!targetId) fail(EXIT_USAGE, "--mark-rolled-back <baselineId> 缺少基线 id", json);
    const res = await markRollbackApplied(root, targetId);
    emit(json, res, [`ok=${res.ok}`, `codes=${res.codes.join(",") || "-"}`, `baseline=${targetId}`]);
    return res.ok ? EXIT_OK : codeExit(res.codes);
  }

  if (parsed.flags.has("report")) {
    const report = await reportBreaker(root);
    emit(json, { ok: true, ...report }, [
      `paused=${report.state.paused}`,
      `scope=${report.state.scope}`,
      `trigger=${report.state.trigger ?? "-"}`,
      `baselines=${report.baselines.length}${report.baselines.length ? ` (${report.baselines.map((b) => b.id).join(",")})` : ""}`,
      `history=${report.history.length}`,
      `badLines=${report.badLines}`,
      `rollbacksApplied=${report.rollbacksApplied.join(",") || "(空)"}`,
    ]);
    return EXIT_OK;
  }

  fail(EXIT_USAGE, "缺少子命令(--status/--pause/--resume/--evaluate/--baseline/--baselines/--rollback-plan/--mark-rolled-back/--report)", json);
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stdout.write(`error: ${(err as Error)?.message ?? String(err)}\n`);
    process.exit(EXIT_USAGE);
  },
);
