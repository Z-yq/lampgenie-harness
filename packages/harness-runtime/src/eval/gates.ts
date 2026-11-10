/**
 * 门禁( §4):L1 契约 eval 全绿 + 跑批均值不低于阈值 → 绿;否则红清单+exit 1。
 * 覆盖阈值:override(带理由)→放行但落 eval.gate-override 审计(改门槛要留痕)。
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runContractEval, type ContractRule } from "./contract-eval.js";
import type { BatchRunResult } from "./batch.js";
import type { AuditLog } from "../security/audit-log.js";

export interface GateSpec {
  /** 门禁集名(改门禁集走 MR,此文件即留痕)。 */
  name: string;
  /** L1 契约规则(引用 contract-eval 同构)。 */
  contractRules: ContractRule[];
  /** 跑批均值阈值(0-100;低于即红)。 */
  minMean: number;
  /** 单用例下限(低于即红;缺省不检)。 */
  minPerCase?: number;
}

export interface GateOutcome {
  pass: boolean;
  contractViolations: number;
  mean: number;
  redList: string[];
  overridden: boolean;
}

export function loadGates(file: string): GateSpec {
  if (!existsSync(file)) throw new Error(`门禁集不存在:${file}`);
  const text = readFileSync(file, "utf-8");
  const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "default";
  const minMean = Number(/^minMean:\s*([\d.]+)$/m.exec(text)?.[1] ?? 0);
  return { name, contractRules: [], minMean, minPerCase: Number(/^minPerCase:\s*([\d.]+)$/m.exec(text)?.[1] ?? NaN) || undefined };
}

/** 跑门禁:L1 violations + 跑批对照阈值;override 留审计后放行。 */
export function runGates(
  spec: GateSpec,
  cwd: string,
  batch: BatchRunResult | null,
  opts: { override?: { reason: string; actor: string }; audit?: AuditLog } = {},
): GateOutcome {
  const violations = runContractEval(spec.contractRules, cwd);
  const redList: string[] = [];
  for (const v of violations) redList.push(`L1 ${v.rule}: ${v.file} ${v.missing ? `缺「${v.missing}」` : `禁词「${v.forbidden}」`}`);
  let mean = 0;
  if (batch) {
    mean = batch.mean;
    if (batch.mean < spec.minMean) redList.push(`L3 均值 ${batch.mean.toFixed(2)} < 阈值 ${spec.minMean}(集=${spec.name})`);
    if (spec.minPerCase !== undefined) {
      for (const r of batch.results) {
        if (r.score < spec.minPerCase) redList.push(`L3 用例 ${r.caseId}=${r.score} < ${spec.minPerCase}`);
      }
    }
  } else {
    redList.push("L3 跑批结果缺失(门禁集要求跑批)");
  }
  let overridden = false;
  if (redList.length > 0 && opts.override && opts.audit) {
    // 门槛变更要留痕:override 是显式逃生口,不是静默跳过。
    opts.audit.append(
      {
        actor: { kind: "user", device: opts.override.actor },
        action: "eval.gate-override",
        target: { type: "gate", id: spec.name },
        result: "ok",
        source_ip_scope: "unknown",
      },
      { reason: opts.override.reason, redList },
    );
    overridden = true;
  }
  return { pass: redList.length === 0 || overridden, contractViolations: violations.length, mean, redList, overridden };
}
