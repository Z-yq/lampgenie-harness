/**
 * P1-④(主线 g-rsi-closed-loop ④):机制发现→提案自动转换器。
 * 背景(100 会话分析注意):12 机制产出 64 条带证据发现,但全部停在 results.jsonl/看板——
 * 机制是只读审计员,工单要靠人抄进 change-requests。本桥在周期时把本轮 bad 级发现
 * 自动立提案(dedupeKey=`item-<mech>-<item.id>` 派生幂等 id;重复=merge 不重复开单)。
 * 纪律:只转 status=bad(warn 级留看板——开单噪音比漏报伤害大);target 未知就诚实写
 * "unknown"不编造;evidence 逐字搬机制的 file:line 证据,转换器不生产证据。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequest } from "./change-request-store.js";

interface MechanismResultItem {
  id?: unknown;
  title?: unknown;
  summary?: unknown;
  evidence?: unknown;
  impact?: unknown;
  action?: unknown;
  status?: unknown;
}

export interface FindingsBridgeResult {
  created: string[];
  merged: string[];
  skipped: number;
  codes: string[];
}

/** 读一个机制 run 的结果文件(items);文件缺失/坏 JSON=空(fail-soft)。 */
function readResultItems(agentRunsDir: string, mechanismId: string, runId: string): MechanismResultItem[] {
  const file = join(agentRunsDir, mechanismId, `${runId}.result.json`);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { items?: unknown };
    return Array.isArray(parsed.items) ? (parsed.items as MechanismResultItem[]) : [];
  } catch {
    return [];
  }
}

/**
 * 把一个周期里全部机制 run 的 bad 级发现转成 change-requests 提案。
 * runIds:机制→runId 映射(调度器 cycle.runIds);幂等靠 createRequest 的 dedupeKey 判重。
 */
export function fileCycleFindingsToChangeRequests(
  root: string,
  runIds: Record<string, string>,
  opts: { at?: number } = {},
): FindingsBridgeResult {
  const out: FindingsBridgeResult = { created: [], merged: [], skipped: 0, codes: [] };
  const agentRunsDir = join(root, ".genie", "rsi", "agent-runs");
  for (const [mechanismId, runId] of Object.entries(runIds)) {
    if (typeof runId !== "string" || runId === "") continue;
    for (const item of readResultItems(agentRunsDir, mechanismId, runId)) {
      if (item.status !== "bad") {
        if (item.status === "warn") out.skipped += 1;
        continue;
      }
      const itemId = typeof item.id === "string" && item.id !== "" ? item.id : `untitled-${out.created.length + out.merged.length}`;
      const title = typeof item.title === "string" && item.title !== "" ? item.title : `${mechanismId} bad 发现(无标题)`;
      const summary = typeof item.summary === "string" ? item.summary : "";
      const evidence = typeof item.evidence === "string" ? item.evidence : "";
      const impact = typeof item.impact === "string" ? item.impact : "";
      const action = typeof item.action === "string" ? item.action : "";
      const res = createRequest(
        root,
        {
          title: title.slice(0, 120),
          kind: "mechanism-gap",
          target: { module: "unknown(机制发现,未定位代码模块)" },
          evidenceRefs: evidence !== "" ? [evidence.slice(0, 300)] : [`.genie/rsi/agent-runs/${mechanismId}/${runId}.result.json`],
          reproSteps: [summary.slice(0, 400) || "(见结果文件)"],
          impact: { files: [], users: "RSI 运营/开发", blastRadius: impact.slice(0, 300) },
          expectedBehavior: action.slice(0, 400) || "按机制建议的 action 处理",
          observedBehavior: `${summary.slice(0, 200)}|证据:${evidence.slice(0, 200)}`,
          provenance: "rsi",
          dedupeKey: `item-${mechanismId}-${itemId}`.slice(0, 60),
        },
        opts,
      );
      if (res.ok && (res.code === "CHANGE_REQ_CREATED" || res.code === undefined)) out.created.push(res.id ?? itemId);
      else if (res.ok && res.code === "CHANGE_REQ_MERGED") out.merged.push(res.id ?? itemId);
      else if (res.code !== undefined && res.code !== "CR_INVALID") out.codes.push(res.code);
    }
  }
  return out;
}
