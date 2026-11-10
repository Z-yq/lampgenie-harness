/**
 * L3 跑批( §3):评测集×backend×judge,journal-first(每用例先落盘再汇总),
 * 失败用例不丢其余结果。backend/judge 注入式——CI 用确定性实现,真 LLM 另测(不冒充)。
 * 同 seed 可复现:输入+seed 决定 backend 脚本步进,分差应为 0。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface BatchCase {
  id: string;
  version: number;
  seed: number;
  input: string;
}

export interface BatchJudgeResult {
  caseId: string;
  score: number;
  notes?: string;
}

/** 跑批产物:逐用例明细+汇总(与上次 diff 由 gates 层做)。 */
export interface BatchRunResult {
  runId: string;
  at: number;
  results: BatchJudgeResult[];
  mean: number;
}

export type BatchBackend = (input: string, seed: number) => Promise<string>;
export type BatchJudge = (c: BatchCase, output: string) => Promise<{ score: number; notes?: string }>;

/** 评测集加载(*.yaml 的最小子集:id/version/seed/input;完整 schema 逐步收敛)。 */
export function loadCases(dir: string): BatchCase[] {
  if (!existsSync(dir)) return [];
  const cases: BatchCase[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".yaml") && !f.endsWith(".json")) continue;
    const text = readFileSync(join(dir, f), "utf-8");
    // 受控解析:yaml 扁平字段(id/version/seed)+ input 块;json 直读。
    if (f.endsWith(".json")) {
      const j = JSON.parse(text) as BatchCase;
      cases.push(j);
      continue;
    }
    const id = /^id:\s*(.+)$/m.exec(text)?.[1]?.trim();
    const version = Number(/^version:\s*(\d+)$/m.exec(text)?.[1] ?? 1);
    const seed = Number(/^seed:\s*(\d+)$/m.exec(text)?.[1] ?? 0);
    const input = /^input:\s*\|\n([\s\S]*?)(?=\n[a-z]|\n*$)/m.exec(text)?.[1]?.trim() ?? "";
    if (id) cases.push({ id, version, seed, input });
  }
  return cases;
}

/** 跑一批。journal-first:每用例结果先写 results 目录再汇总(崩了不丢已完成的)。 */
export async function runBatch(
  cases: BatchCase[],
  backend: BatchBackend,
  judge: BatchJudge,
  resultsDir: string): Promise<BatchRunResult> {
  mkdirSync(resultsDir, { recursive: true });
  const runId = `run-${Date.now().toString(36)}`;
  const results: BatchJudgeResult[] = [];
  for (const c of cases) {
    // 单用例失败不中断整批(失败用例记 0 分+notes,其余照跑)。
    let judged: { score: number; notes?: string } = { score: 0, notes: "case-error" };
    try {
      const output = await backend(c.input, c.seed);
      judged = await judge(c, output);
    } catch (err) {
      judged = { score: 0, notes: String(err).slice(0, 120) };
    }
    const r: BatchJudgeResult = { caseId: c.id, ...judged };
    results.push(r);
    // journal-first:逐用例落盘。
    writeFileSync(join(resultsDir, `${runId}-${c.id}.json`), JSON.stringify({ runId, case: c, result: r }, null, 2));
  }
  const mean = results.length ? results.reduce((s, r) => s + r.score, 0) / results.length : 0;
  const run: BatchRunResult = { runId, at: Date.now(), results, mean };
  writeFileSync(join(resultsDir, `${runId}-summary.json`), JSON.stringify(run, null, 2));
  return run;
}
