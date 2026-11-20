/**
 * LLM 语义归因层(主线 g-rsi-closed-loop 终局前置)。
 * P2-⑥ 抽样验证:确定性 diff-semantics 只能分类 40% 返工链(60% = 30% None + 30% uncategorized)。
 * 本模块对无分类链做 LLM 归因——读 fix/build 会话上下文,产出 defectClass + verdict + confidence,
 * 以 append-only enrichment 行写回 rework-chains.jsonl(不改原始 detect 行)。
 * 设计:
 * - 调用面:gateway 主进程(有 LLM 工厂)调度,不在 nightly worker(无凭证)里跑
 * - 幂等:同 chainId 已有 enrichment 行(且 LLM_ATTRIBUTION_VERSION 未变)→ 跳过
 * - 预算:每链 input ≤4k 字符 + output ≤200 字符;每轮最多 enrichMax 条(缺省 10)
 * - 输出:defectClass∈七类 / verdict∈三态 / confidence 0-1 / reason ≤80字
 * - 可纠正:enrichment 行带 model+version,人工可用 CLI 覆写
 * 依赖纪律:node:fs + harness-runtime 纯逻辑 + LLM 工厂注入(不在模块级引 gateway 业务)。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const LLM_ATTRIBUTION_VERSION = 1;

/** 七类缺陷(与 diff-semantics 的七类对齐;runtime rework-chain 的 defectClass 枚举)。 */
export const DEFECT_CLASSES = [
  "contract",    // 契约不一致(签名/返回语义/错误语义)
  "boundary",    // 边界遗漏(空值/极端值/未枚举状态)
  "concurrency", // 并发假设错误(竞态/死锁/时序)
  "resource",    // 资源泄漏/管理错误(连接/内存/锁)
  "protocol",    // 协议/编解码错误(序列化/字符集/格式)
  "logic",       // 逻辑错误(算法/条件/分支)
  "regression",  // 回归(修复引入新问题)
] as const;
export type LlmDefectClass = (typeof DEFECT_CLASSES)[number];

export interface AttributionInput {
  chainId: string;
  fixSession: string;
  buildSession: string;
  path: string;
 /** fix 会话的 diff 摘要(旧文本→新文本的关键变化,≤2k 字符)。 */
  diffSummary: string;
 /** build 会话当时读过的文件(决策时信息可得性的证据)。 */
  buildReadPaths: string[];
 /** fix 会话的标题(人类可读的修复意图)。 */
  fixTitle: string;
}

export interface AttributionResult {
  chainId: string;
  defectClass: LlmDefectClass;
  verdict: "preventable" | "drift" | "unknown";
  confidence: number;
  reason: string;
  model: string;
  version: number;
  at: number;
}

export interface AttributionEnrichmentLine {
  v: number;
  type: "enrichment";
  at: number;
  chainId: string;
  result: AttributionResult;
}

/** 构建归因 prompt(纯函数,可单测)。 */
export function buildAttributionPrompt(input: AttributionInput): { system: string; user: string } {
  const system = [
    "你是代码缺陷归因专家。根据修复会话的信息,判断原始实现的缺陷类别和可预防性。",
    "",
    "缺陷类别(选一个):",
    ...DEFECT_CLASSES.map((c) => `- ${c}`),
    "",
    "verdict(选一个):",
    "- preventable: build 时正确答案在仓库/上下文中可得但未取(过程缺陷,可预防)",
    "- drift: build 时答案不存在(需求后变/外部约束变化,不可预防)",
    "- unknown: 信息不足以判断",
    "",
    "输出 JSON(只输出 JSON,不写其他):",
    '{"defectClass":"...","verdict":"...","confidence":0.0-1.0,"reason":"≤80字一句话"}',
  ].join("\n");

  const user = [
    `## 修复信息`,
    `- 修复会话: ${input.fixSession} (${input.fixTitle})`,
    `- 原始构建会话: ${input.buildSession}`,
    `- 修改文件: ${input.path}`,
    "",
    `## diff 摘要`,
    input.diffSummary.slice(0, 2000),
    "",
    `## 构建会话当时读过的文件(决策时信息可得性证据)`,
    input.buildReadPaths.length > 0 ? input.buildReadPaths.slice(0, 20).join("\n") : "(无记录)",
    "",
    `## 判定规则`,
    `- 如果 build 读过相关文件却仍写出缺陷 → preventable(信息可得未取)`,
    `- 如果 build 没读过相关文件且文件当时可能不存在 → drift`,
    `- 如果无法判断 → unknown`,
  ].join("\n");

  return { system, user };
}

/** 解析 LLM 回复为 AttributionResult(纯函数;失败返回 null 不 throw)。 */
export function parseAttributionResponse(
  chainId: string,
  response: string,
  model: string,
  now: number,
): AttributionResult | null {
  try {
 // 剥 markdown 围栏
    const text = response.replace(/```(?:json)?\n?/g, "").trim();
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const defectClass = String(parsed.defectClass ?? "");
    const verdict = String(parsed.verdict ?? "");
    const confidence = Number(parsed.confidence);
    const reason = String(parsed.reason ?? "").slice(0, 120);
    if (!(DEFECT_CLASSES as readonly string[]).includes(defectClass)) return null;
    if (!["preventable", "drift", "unknown"].includes(verdict)) return null;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
    return {
      chainId,
      defectClass: defectClass as LlmDefectClass,
      verdict: verdict as AttributionResult["verdict"],
      confidence: Math.round(confidence * 100) / 100,
      reason,
      model,
      version: LLM_ATTRIBUTION_VERSION,
      at: now,
    };
  } catch {
    return null;
  }
}

/** 读 rework-chains.jsonl,返回待归因链(uncategorized/None 且无同版 enrichment)。 */
export function findUnattributedChains(
  root: string,
  opts: { max?: number } = {},
): AttributionInput[] {
  const ledger = join(root, ".genie", "rsi", "rework-chains.jsonl");
  if (!existsSync(ledger)) return [];
  const max = opts.max ?? 10;
  const enriched = new Map<string, number>(); // chainId → enrichment version
  const rawChains: Array<Record<string, unknown>> = [];
  try {
    for (const line of readFileSync(ledger, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const d = JSON.parse(line) as Record<string, unknown>;
        if (d.type === "enrichment" && typeof d.chainId === "string") {
          const ver = (d.result as Record<string, unknown>)?.version;
          enriched.set(d.chainId, typeof ver === "number" ? ver : 0);
        } else if (d.chainId !== undefined || d.fixSession !== undefined) {
          rawChains.push(d);
        }
      } catch { /* 坏行跳过 */ }
    }
  } catch { return []; }
  const out: AttributionInput[] = [];
  for (const c of rawChains) {
    if (out.length >= max) break;
    const chainId = String(c.chainId ?? "");
    const defectClass = String(c.defectClass ?? "");
    if (chainId === "" || (defectClass !== "uncategorized" && defectClass !== "" && defectClass !== "None")) continue;
    if (enriched.has(chainId) && enriched.get(chainId) === LLM_ATTRIBUTION_VERSION) continue; // 已归因
    out.push({
      chainId,
      fixSession: String(c.fixSession ?? ""),
      buildSession: String(c.buildSession ?? ""),
      path: String(c.path ?? ""),
      diffSummary: String(c.diffSummary ?? c.fixDiff ?? ""),
      buildReadPaths: Array.isArray(c.buildReadPaths) ? (c.buildReadPaths as string[]) : [],
      fixTitle: String(c.fixTitle ?? c.title ?? ""),
    });
  }
  return out;
}

/** 写入 enrichment 行(append-only,不改原始 detect 行)。 */
export function writeEnrichment(root: string, result: AttributionResult): boolean {
  const ledger = join(root, ".genie", "rsi", "rework-chains.jsonl");
  try {
    mkdirSync(dirname(ledger), { recursive: true });
    const line: AttributionEnrichmentLine = { v: 1, type: "enrichment", at: result.at, chainId: result.chainId, result };
    appendFileSync(ledger, JSON.stringify(line) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * 对外主入口:执行一轮 LLM 归因。
 * chatFn 由调用方注入(gateway 的 LLM 工厂/测试 mock)——本模块零凭证依赖。
 */
export async function runSemanticAttribution(
  root: string,
  chatFn: (messages: Array<{ role: string; content: string }>) => Promise<{ content: string }>,
  model: string,
  opts: { now?: number; max?: number } = {},
): Promise<{ enriched: number; skipped: number; errors: number; results: AttributionResult[] }> {
  const now = opts.now ?? Date.now();
  const pending = findUnattributedChains(root, { max: opts.max });
  const out = { enriched: 0, skipped: 0, errors: 0, results: [] as AttributionResult[] };
  for (const input of pending) {
    const { system, user } = buildAttributionPrompt(input);
    try {
      const response = await chatFn([
        { role: "system", content: system },
        { role: "user", content: user },
      ]);
      const result = parseAttributionResponse(input.chainId, response.content, model, now);
      if (result === null) {
        out.errors += 1;
        continue;
      }
      if (writeEnrichment(root, result)) {
        out.enriched += 1;
        out.results.push(result);
      } else {
        out.errors += 1;
      }
    } catch {
      out.errors += 1;
    }
  }
  return out;
}
