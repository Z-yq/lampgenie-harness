/**
 * 多轮评审编排(ocr agent.go 思想 TS 重写):confirmed_comments 增量防重、
 * 零新增早停、grace round、规则 checklist 注入、定位三级降级接线。
 */
import type { Finding, ReviewLlm } from "./index";
import { REVIEW_PROMPT } from "./prompt";
import { locateFinding, type LocatedFinding, type LlmRelocate } from "./resolver";
import { filterFindings } from "./filter";
import { loadRules } from "./rules";

export interface RoundResult {
  round: number;
  newFindings: Finding[];
  confirmedTotal: number;
  earlyStopped: boolean;
}

export interface MultiroundOptions {
  maxRounds?: number;   // 默认 2(ocr effort=medium)
  files: { path: string; diffText: string; status: string }[];
  llm: ReviewLlm;
  /** 规则层(缺省内置)。 */
  customRules?: { pattern: string; checklist: string }[];
  diffContext: string;
  /** 项目规则层根目录(项目 .opencodereview/rule.json 的查找基准;缺省 process.cwd)。 */
  rulesRoot?: string;
  /** 每轮注入的附加上下文(变更文件全文/约定文件/code_sense 影响面)。 */
  contextNote?: string;
  /** 提示词覆盖(step-116 全文件扫描用;缺省=diff 审查 REVIEW_PROMPT,既有行为不变)。 */
  promptOverride?: string;
  /** LLM 重定位第四级(纯 opt-in,透传 locateFinding;缺省=三档行为不变)。 */
  llmRelocate?: LlmRelocate;
}

/** 单轮评审调用(附加上下文+规则按文件注入+confirmed 防重;解析失败重试 1 次)。 */
async function reviewRound(
  opts: MultiroundOptions,
  round: number,
  confirmed: Finding[],
): Promise<Finding[]> {
  const { rulesFor } = loadRules(opts.rulesRoot ?? process.cwd(), opts.customRules);
  const rulesText = opts.files
    .slice(0, 15)
    .map((f) => `<rules for="${f.path}">\n${rulesFor(f.path)}\n</rules>`)
    .join("\n");
  const confirmedText = confirmed.length
    ? `\n### 已确认的发现(此前轮次,勿重复报告)\n${confirmed.map((f) => `- [${f.severity}] ${f.file}:${f.line} ${f.title}`).join("\n")}`
    : "";
  const base = (opts.promptOverride ?? REVIEW_PROMPT).replace("$ARGUMENTS", `第 ${round} 轮评审`)
    + (opts.contextNote ? `\n\n${opts.contextNote}` : "")
    + `\n\n---\n## 按文件规则\n${rulesText}${confirmedText}\n\n## Diff\n${opts.diffContext.slice(0, 60_000)}`;
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = attempt === 0 ? base : `${base}\n\n上一版输出无法解析(${lastErr}),严格只输出 JSON。`;
    const r = await opts.llm.chat(prompt);
    try {
      const parsed = JSON.parse(r.content.trim().replace(/^```json\s*|\s*```$/g, "")) as { findings?: Finding[] };
      return Array.isArray(parsed.findings) ? parsed.findings : [];
    } catch (err) {
      lastErr = String(err).slice(0, 100);
    }
  }
  return []; // 两轮解析失败=该轮零新增→早停逻辑自然处理
}

/** 多轮编排:确认集滚雪球,零新增早停;末尾 grace round。 */
export async function multiroundReview(opts: MultiroundOptions): Promise<{
  confirmed: Finding[];
  located: (Finding & LocatedFinding)[];
  rounds: RoundResult[];
  graceRoundRan: boolean;
}> {
  const maxRounds = opts.maxRounds ?? 2;
  const confirmed: Finding[] = [];
  const rounds: RoundResult[] = [];
  let earlyStopped = false;

  for (let round = 1; round <= maxRounds; round++) {
    const fresh = await reviewRound(opts, round, confirmed);
    // 去重(同 file+title 视为重复)
    const seen = new Set(confirmed.map((f) => `${f.file}|${f.title}`));
    const added = fresh.filter((f) => !seen.has(`${f.file}|${f.title}`));
    confirmed.push(...added);
    rounds.push({ round, newFindings: added, confirmedTotal: confirmed.length, earlyStopped: false });
    if (added.length === 0 && round < maxRounds) {
      earlyStopped = true;
      rounds[rounds.length - 1]!.earlyStopped = true;
      break;
    }
  }

  // grace round:只带 confirmed 清单,要求吐出「已发现但未报告」的
  let graceRoundRan = false;
  if (!earlyStopped && confirmed.length > 0) {
    graceRoundRan = true;
    const grace = await opts.llm.chat(
      `以下是已确认的审查发现清单。检查你的分析过程中是否还有已发现但未报告的问题,只输出补充问题的 JSON(同 findings schema),没有则 {"findings":[],"summary":"无补充"}。\n${JSON.stringify(confirmed.map((f) => ({ file: f.file, title: f.title })), null, 1)}`,
    );
    try {
      const parsed = JSON.parse(grace.content.trim().replace(/^```json\s*|\s*```$/g, "")) as { findings: Finding[] };
      confirmed.push(...(parsed.findings ?? []));
    } catch { /* grace 失败不致命 */ }
  }

  // 定位三级降级+可选 LLM 第四级(锚点缺失时 fallback=模型行号)
  const located: (Finding & LocatedFinding)[] = [];
  for (const f of confirmed) {
    const loc = await locateFinding(
      {
        file: f.file,
        anchorText: f.anchorText ?? f.detail.split("\n")[0] ?? "",
        fallbackLine: f.line,
      },
      opts.files,
      { llmRelocate: opts.llmRelocate },
    );
    located.push({ ...f, ...loc });
  }

  return { confirmed, located, rounds, graceRoundRan };
}
