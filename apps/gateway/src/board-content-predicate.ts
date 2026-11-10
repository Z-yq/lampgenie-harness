/** 板「内容节点」判据(单一真源,2026-11-04 用户口径「板偏计划步骤而非实际开发内容逻辑」)。
 *
 * 原实现两处分叉:plan-gate 局部 `isContentNode`(agent-wiring.ts)与类型门局部 `hasContent`
 * (board-contract/rules/type-conformance.ts),后者判据更宽(多 分钟/字符/input/output/qps/条
 * 与 [万千亿]? 量级)。两侧分叉会让「同一张板在闸门与类型门得两个结论」,故归一到这里:
 * 取宽版,判据放宽只会让更多板被判内容节点(纯计划步骤板仍判非内容)。
 *
 * 本模块零内部依赖(不 import board-contract / agent-wiring,防循环)。
 *
 * 用途二(2026-11-04 boardType=composition 作业思路板):`isCompositionStructure` 判「这张板是不是
 * 作业思路结构」——章节节点(kind=section)≥2 且章之间有带关系词的 data 边;类型门
 * (board-contract/rules/type-conformance.ts)复用同一个关系词表 `COMPOSITION_RELATIONS`,防两侧分叉。
 * 办公任务(调研/汇报/写文章/PPT)的板画的是表达结构:主题·受众·章节·章间关系,不是 todo list。
 */

/** 内容节点=指向实际对象(targets/symbolRef)或带命令级验收(accept),
 * 或 summary/label 带指标数字·量级/文件路径(分析类任务的「内容」=数据与口径)。 */
export function isContentNode(n: { targets?: unknown; symbolRef?: unknown; accept?: unknown; summary?: unknown; label?: unknown }): boolean {
  if (Array.isArray(n.targets) && n.targets.length > 0) return true;
  if (n.symbolRef) return true;
  if (Array.isArray(n.accept) && n.accept.some((a) => {
    const o = (a ?? {}) as { cmd?: unknown; expect?: unknown };
    return !!String(o.cmd ?? "").trim() || !!String(o.expect ?? "").trim();
  })) return true;
  if (/[0-9]+(\.[0-9]+)?\s*[万千亿]?\s*(ms|s|秒|分钟|MB|KB|GB|token|字符|input|output|qps|次|%|x|倍|行|条)/i.test(String(n.summary ?? ""))) return true;
  return /[\w-]+\.(ts|tsx|js|py|go|rs|java|c|cpp)\b/.test(`${String(n.label ?? "")} ${String(n.summary ?? "")}`);
}

/** 板首「主题节点」判据(2026-11-04 用户口径「白板看得懂」):一张板的第一件事是让读者知道
 *  「这个大流程在系统里是干什么用的、本次开发改的是其中哪一环」。只有一串步骤卡、读者看完整板
 *  不知道用途的板判不合格。判定:节点 id 以 theme 开头(含任意大小写/序号,如 theme-1/THEME_2),
 *  或节点 group 含「主题」。单一真源,类型门与其它闸门都从这里取,防两处分叉。 */
export function hasThemeNode(nodes: { id: string; group?: unknown }[]): boolean {
  return (nodes ?? []).some((n) => /^theme/i.test(String(n?.id ?? "")) || /主题/.test(String(n?.group ?? "")));
}

/** 作业思路板(composition)的章间关系词表:单一真源,类型门
 * (board-contract/rules/type-conformance.ts)从这里 import,不在两处各写一份。 */
export const COMPOSITION_RELATIONS = ["承接", "递进", "并列", "对照", "因果"] as const;

/** 作业思路板的结构判据:≥2 个 section 节点 + 至少一条两端都是 section 的边且 label 命中关系词。
 *  label 允许前后带其它词(如「01→02 递进」「s1→s2 承接上文」),用 includes 判关系词。 */
export function isCompositionStructure(
  nodes: { id: string; kind?: string }[],
  edges: { from: string; to: string; label?: string }[],
): boolean {
  const sectionIds = new Set(nodes.filter((n) => String(n.kind ?? "") === "section").map((n) => String(n.id)));
  if (sectionIds.size < 2) return false;
  return (edges ?? []).some((e) => {
    if (!sectionIds.has(String(e.from)) || !sectionIds.has(String(e.to))) return false;
    const l = String(e.label ?? "").trim();
    return COMPOSITION_RELATIONS.some((r) => l.includes(r));
  });
}