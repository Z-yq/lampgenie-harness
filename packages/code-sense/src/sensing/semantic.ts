/**
 * sensing/semantic(step-077 / designs/24 §3):LLM 语义层注入式管线。
 *
 * 红线(与 archmap/modulemap/review 三先例同源):
 *  ① 语义产物独立字段(不混入确定性字段);
 *  ② 每条语义必须引用白名单锚(确定性层已提取的真实 {file,line} 锚点);
 *  ③ zod 校验 + 引用回查双闸 → 修复环 ≤2 → 再失败该条拒收+droppedCount 计数,缺位不补占位;
 *  ④ 未注入 senseLlm = 显式降级(degraded 条目由调用方组装),绝不静默。
 */
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** 注入式 LLM 契约(与 archmap ArchLlm 同构,单段 prompt 形态)。 */
export interface SenseLlm {
  generate(prompt: string): Promise<string>;
}

export interface SensingDeps {
  senseLlm?: SenseLlm;
}
let deps: SensingDeps = {};
export function setSensingDeps(d: SensingDeps): void { deps = d; }
export function getSensingDeps(): SensingDeps { return deps; }

/** 白名单锚:发给 LLM 的事实条目,LLM 只能引用这些锚 id。 */
export interface EvidenceAnchor {
  id: string;        // E1/E2...
  file: string;
  line: number;
  text: string;      // 锚内容摘要(给 LLM 看的事实)
}

/** 语义条目(schema 通用形态:每个产物条目=ref+文本+evidenceRef)。 */
export const SemanticItemSchema = z.object({
  ref: z.string(),                       // 对应的锚 id(该语义描述的是哪个事实)
  summary: z.string().max(200),
  evidenceRef: z.string(),               // 证据锚 id(必须 ∈ 白名单)
});
export const SemanticBatchSchema = z.object({
  items: z.array(SemanticItemSchema).max(60),
});
export type SemanticItem = z.infer<typeof SemanticItemSchema>;

export interface SemanticOutcome {
  /** ref → summary(校验通过且引用回查通过的条目)。 */
  items: Map<string, string>;
  /** 引用伪造/schema 坏导致的拒收条数(如实计数)。 */
  dropped: number;
  /** 修复环触发次数。 */
  repairs: number;
  /** 全部失败/LLM 缺席=null 语义层(调用方组装 degraded)。 */
  ok: boolean;
}

/** 从 handler 所在文件摘代码窗(def 行起 maxLines 行),供 LLM 判读。失败=空串。 */
export async function excerptAt(root: string, file: string, line: number, maxLines = 24): Promise<string> {
  try {
    const text = await readFile(join(root, file), "utf-8");
    const lines = text.split("\n");
    return lines.slice(Math.max(0, line - 1), Math.max(0, line - 1) + maxLines).join("\n").slice(0, 2400);
  } catch {
    return "";
  }
}

function parseBatch(raw: string): z.infer<typeof SemanticBatchSchema> | null {
  try {
    let cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/g, "");
    // 模型常带「好的,以下是结果:」或尾注;取首个 { 到末个 } 之间的 JSON 主体,
    // 不要求整段纯 JSON(2026-10-20 多仓实测:整段严格解析会把可用输出整批拒收)。
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    cleaned = cleaned.slice(start, end + 1);
    return SemanticBatchSchema.parse(JSON.parse(cleaned));
  } catch {
    return null;
  }
}

/** 引用回查:evidenceRef 必须 ∈ 白名单锚;ref ∈ 锚 id(缺省)或显式 refSlots;summary 为空拒收。 */
function validateBatch(
  batch: z.infer<typeof SemanticBatchSchema>,
  anchors: EvidenceAnchor[],
  refSlots?: string[],
): { kept: SemanticItem[]; issues: string[] } {
  const ids = new Set(anchors.map((a) => a.id));
  const refs = new Set(refSlots && refSlots.length > 0 ? refSlots : anchors.map((a) => a.id));
  const kept: SemanticItem[] = [];
  const issues: string[] = [];
  for (const it of batch.items) {
    if (!refs.has(it.ref)) { issues.push(`条目引用了不存在的目标锚 ${it.ref}`); continue; }
    if (!ids.has(it.evidenceRef)) { issues.push(`条目 ${it.ref} 的 evidenceRef=${it.evidenceRef} 不在白名单`); continue; }
    if (!it.summary.trim()) { issues.push(`条目 ${it.ref} 的 summary 为空`); continue; }
    kept.push(it);
  }
  return { kept, issues };
}

export interface BatchOpts {
  maxRepairRounds?: number;
  /** step-089 P3:输出槽位形态——ref 取具名槽位(purpose/cap-N)而非锚 id;
   * evidenceRef 仍必须 ∈ 锚白名单(引用回查不放松)。缺省=ref 即锚 id(step-077 行为)。 */
  refSlots?: string[];
}

/**
 * 语义批生成管线(zod+白名单+修复环;archmap generateArchitecture 同款纪律)。
 * @param taskPrompt 任务描述(「为以下 HTTP 接口写职责描述」类)
 * @param anchors 白名单事实锚(确定性层产物)
 * @param extraContext 额外上下文(如 handler 代码窗摘录)
 */
export async function runSemanticBatch(
  taskPrompt: string,
  anchors: EvidenceAnchor[],
  extraContext: string,
  opts?: BatchOpts,
): Promise<SemanticOutcome | null> {
  const llm = deps.senseLlm;
  if (!llm || anchors.length === 0) return null;
  const anchorText = anchors
    .map((a) => `[${a.id}] ${a.file}:${a.line} — ${a.text}`)
    .join("\n");
  const refRule = opts?.refSlots && opts.refSlots.length > 0
    ? `ref 只能取:${opts.refSlots.join(" / ")}(不需要的槽位跳过);evidenceRef 必须来自事实锚清单。`
    : "ref 与 evidenceRef 必须来自上面清单的 id。";
  const basePrompt = `${taskPrompt}

事实锚清单(白名单,你的每条输出必须且只能引用这些锚):
${anchorText}

${extraContext ? `补充上下文:\n${extraContext}\n\n` : ""}输出 JSON(schema: {"items":[{"ref": 目标锚id, "summary": "≤80字职责描述(中文,陈述事实不推测)", "evidenceRef": 证据锚id}]})。规则:summary 只写锚内容能直接支撑的事实,推测不出就跳过该锚;${refRule}只输出 JSON。`;

  const maxRounds = opts?.maxRepairRounds ?? 2;
  let repairs = 0;
  let raw = await llm.generate(basePrompt);
  for (let round = 0; round <= maxRounds; round++) {
    const batch = parseBatch(raw);
    if (batch) {
      const { kept, issues } = validateBatch(batch, anchors, opts?.refSlots);
      if (issues.length === 0) {
        return { items: new Map(kept.map((k) => [k.ref, k.summary])), dropped: 0, repairs, ok: true };
      }
      if (kept.length > 0 && round === maxRounds) {
        // 末轮:保合格条目,拒收问题条目(计数)
        return { items: new Map(kept.map((k) => [k.ref, k.summary])), dropped: issues.length, repairs, ok: true };
      }
      repairs++;
      raw = await llm.generate(`${basePrompt}\n\n上一版有以下问题,修正后重输出完整 JSON:\n${issues.map((x) => `- ${x}`).join("\n")}`);
    } else {
      if (round === maxRounds) return { items: new Map(), dropped: anchors.length, repairs, ok: false };
      repairs++;
      raw = await llm.generate(`${basePrompt}\n\n上一版 JSON 解析失败(要求:纯 JSON,无 markdown 围栏,无注释)。重输出完整 JSON。`);
    }
  }
  return { items: new Map(), dropped: anchors.length, repairs, ok: false };
}
