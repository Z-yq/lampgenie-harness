#!/usr/bin/env tsx
/**
 * 审计覆盖对账(designs/10 §6「覆盖面核对」,step-015 D4):
 * live 动作清单 vs 代码产生点 grep 对账——每个 live 动作必须有 ≥1 个真实产生点,
 * pending 清单显式登记(有表但不假装有产生点)。退出码=对账结果。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SRC_DIRS = ["packages", "apps"];

/** 与 security/audit-log.ts 的 live/pending 清单同源(双处声明=对账对象;不一致即红)。
 * resource.push(step-069 同步):产生点=team-relay.ts doTeamaiPush(技能推送审计)。 */
const LIVE = ["config.change", "member.invite", "resource.push", "roster.merge", "eval.gate-override"];
const PENDING = ["permission.approve", "credential.rotate", "member.revoke", "build.push-direct", "im.pull-history", "node.remove", "role.change"];

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    if (f === "node_modules" || f === "dist" || f === "test" || f === "vendor" || f === "ref") continue;
    const p = join(dir, f);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const files = SRC_DIRS.flatMap((d) => walk(join(ROOT, d)));
const producePoints = new Map<string, string[]>();
for (const action of LIVE) producePoints.set(action, []);
// 产生点形态:action: "<name>" 字面量(append 调用处)。
for (const f of files) {
  const text = readFileSync(f, "utf-8");
  for (const action of LIVE) {
    if (text.includes(`action: "${action}"`)) producePoints.get(action)!.push(f.replace(ROOT + "/", ""));
  }
}

let fail = false;
console.log("== 审计动作产生点对账 ==");
for (const action of LIVE) {
  const points = producePoints.get(action)!;
  if (points.length === 0) {
    console.error(`❌ ${action}:无产生点(live 清单里但代码零命中)`);
    fail = true;
  } else {
    console.log(`✅ ${action}:${points.length} 处 → ${points.join(", ")}`);
  }
}
for (const action of PENDING) console.log(`⏸ ${action}:pending 登记(无产生点,建产生点时迁入 live)`);

// 双源一致性:audit-log.ts 的导出清单 vs 本脚本清单。
const auditSrc = readFileSync(join(ROOT, "packages/harness-runtime/src/security/audit-log.ts"), "utf-8");
const declaredLive = [...auditSrc.matchAll(/"([a-z.-]+)",/g)].map((m) => m[1]).filter((s) => LIVE.includes(s!));
const liveSet = new Set(declaredLive);
if (LIVE.some((a) => !liveSet.has(a))) {
  console.error("❌ 双源不一致:audit-log.ts 的 AUDIT_ACTIONS 与本脚本 LIVE 清单有分叉");
  fail = true;
}

process.exit(fail ? 1 : 0);
