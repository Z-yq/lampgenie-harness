/**
 * 防幻觉事实核查(ocr prompts/review_filter_task_*.md 移植+改造,Apache-2.0,
 * 设计参考 alibaba open-code-review(Apache-2.0,致谢),本仓独立实现):两个删除依据+五类保护主题+宁保不删。
 * code_sense 增强:Ground B 证据可带调用图上下游。
 */
import { z } from "zod";
import type { Finding } from "./index";

export const FILTER_PROMPT = `你是评论事实核查员。对每条代码审查评论,判断它是否能被 diff 直接证明是错误的,只删可证明错误的。

## 删除依据(仅此两条,缺一不可)
- Ground A:评论引用的目标代码在该文件中根本不存在(锚点完全对不上)
- Ground B:评论的断言与 diff 中该行的实际代码直接矛盾(单行即可证伪)

## 保护主题(以下五类评论永不删除,即使证据不足)
1. 内存安全问题(泄漏/越界/悬垂)
2. 并发问题(竞态/死锁/非线程安全)
3. 链接/依赖一致性问题
4. 行为变更(与旧行为不同,可能无意)
5. 未使用的参数/变量(死代码)

## 纪律
- 宁可保留一条可疑评论,不可错删一条真问题
- 证据不足以删除 = 保留
- 不确定锚点是否匹配 = 保留(定位问题不等于评论错误)

## 输入:评论列表(JSON)+ 相关 diff + 变更符号影响面(code_sense)
## 输出(严格 JSON)
{"analysis":"逐条一句话判定依据","remove_indices":[],"keep_indices":[]}
只输出 JSON。`;

export const FilterResultSchema = z.object({
  analysis: z.string(),
  remove_indices: z.array(z.number().int().nonnegative()),
  keep_indices: z.array(z.number().int().nonnegative()),
});
export type FilterResult = z.infer<typeof FilterResultSchema>;

/** 保护主题关键词(五类,deterministic pre-guard:命中即跳过 LLM 判删)。 */
const PROTECTED_RE = [
  /内存|泄漏|越界|悬垂|memory|leak|out.of.bounds/i,
  /竞态|死锁|并发|race|deadlock|thread|并发安全/i,
  /链接|依赖一致|dependency|link(ing)?\s*(error|mismatch)/i,
  /行为(变更|改变)|behavior(al)?\s*change|break(ing)?\s*(change|behavior)/i,
  /未(使用|用到)|unused\s*(param|variable|import)/i,
];

export function isProtected(finding: Finding): boolean {
  const text = `${finding.title} ${finding.detail}`;
  return PROTECTED_RE.some((re) => re.test(text));
}

/** filter 总入口:保护主题确定性保留;其余交 LLM(注入式,无 LLM=全保留)。 */
export async function filterFindings(
  findings: Finding[],
  diffContext: string,
  impact?: string,
  llm?: { chat(prompt: string): Promise<{ content: string }> },
): Promise<{ kept: Finding[]; removed: Finding[]; filterRan: boolean }> {
  const removable: { idx: number; f: Finding }[] = [];
  const protectedF: Finding[] = [];
  findings.forEach((f, idx) => {
    if (isProtected(f)) protectedF.push(f);
    else removable.push({ idx, f });
  });
  if (!llm || removable.length === 0) {
    return { kept: findings, removed: [], filterRan: false };
  }
  const prompt = `${FILTER_PROMPT}\n\n---\n评论列表(索引为原数组下标):\n${JSON.stringify(removable.map(({ idx, f }) => ({ idx, ...f })), null, 1)}\n\ndiff:\n\`\`\`\n${diffContext.slice(0, 20_000)}\n\`\`\`\n${impact ? `\n影响面:\n${impact}` : ""}`;
  try {
    const r = await llm.chat(prompt);
    const cleaned = r.content.trim().replace(/^```json\s*|\s*```$/g, "");
    const parsed = FilterResultSchema.parse(JSON.parse(cleaned));
    const removeSet = new Set(parsed.remove_indices);
    const kept = [...protectedF, ...removable.filter(({ idx }) => !removeSet.has(idx)).map(({ f }) => f)];
    const removed = removable.filter(({ idx }) => removeSet.has(idx)).map(({ f }) => f);
    return { kept, removed, filterRan: true };
  } catch {
    // 解析失败:宁保不删
    return { kept: findings, removed: [], filterRan: false };
  }
}
