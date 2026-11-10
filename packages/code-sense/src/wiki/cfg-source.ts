/**
 * 代码档案 × 关键流程图(2026-10-27):把管线簇从「文件级调用图」下沉到 **函数体语句级**。
 *
 * 触发点(用户口径):模块/文件方框 + 端点列表「不是人能看懂的」;示例是语句级流程图——
 * 真实语句/条件菱形/是·否/循环回边/调用标注。本模块为每条管线挑关键函数(入口优先 +
 * 决策×3+语句+调用),用 sensing/cfg 生成可读的 CFG;长函数自动分页(节点/边不删)。
 *
 * 纪律:
 *  - 只挑「索引里可定位到函数体」的符号;类/变量/声明显式跳过并记录原因(候选表)。
 *  - 选 3 个是**编辑选择**(入口优先+复杂度),不是 node 上限;完整候选表在页面上,
 *    未入选函数不假装不存在。
 *  - 无索引/词法级降级=不生成(没有符号级事实就不画),不是画一张空图。
 */
import type { C2fIndex, C2fNode } from "../callgraph/c2f";
import {
  pickPipelineFunctions,
  type CfgCandidate,
  type CfgFileResult,
  type CfgFunction,
} from "../sensing/cfg";
import { attachCfgContext } from "../sensing/cfg-context";
import type { RepoPipeline, PipelineLayer, PipelineTrigger } from "./surfaces";

export interface WikiPipelineCfg {
  pipelineId: string;
  title: string;
  triggers: PipelineTrigger[];
  reach: number;
  layers: PipelineLayer[];
  /** 本页函数(入口优先 + 决策×3+语句+调用,前 N)。 */
  functions: CfgFunction[];
  /** 考虑过的候选(含未选中原因;诚实呈现选择过程)。 */
  candidates: CfgCandidate[];
  notes: string[];
}

const CALLABLE_KINDS = new Set(["function", "method", "arrow"]);
const MAX_CANDIDATES = 40;

/** 候选函数:管线文件按深度序,每文件活动度 top3(入口文件 top6);去重封顶 40。 */
function collectCandidates(p: RepoPipeline, index: C2fIndex, byId: Map<string, C2fNode>): { name: string; file: string; line: number }[] {
  const entry = new Set(p.entryFiles);
  const out: { name: string; file: string; line: number }[] = [];
  const seen = new Set<string>();
  for (const file of p.files) {
    const ids = index.byFile[file] ?? [];
    if (ids.length === 0) continue;
    const nodes: C2fNode[] = [];
    for (const id of ids) {
      const n = byId.get(id);
      if (!n) continue;
      if (n.symKind && !CALLABLE_KINDS.has(n.symKind)) continue;
      nodes.push(n);
    }
    nodes.sort((a, b) => (b.inCount + b.outCount) - (a.inCount + a.outCount) || a.line - b.line);
    for (const n of nodes.slice(0, entry.has(file) ? 6 : 3)) {
      const key = `${file}#${n.name}#${n.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: n.name, file, line: n.line });
      if (out.length >= MAX_CANDIDATES) return out;
    }
  }
  return out;
}

export async function buildPipelineCfgs(
  root: string,
  index: C2fIndex | null,
  pipelines: RepoPipeline[],
  opts: { maxPerPipeline?: number; cache?: Map<string, CfgFileResult | null> } = {},
): Promise<WikiPipelineCfg[]> {
  if (!index || pipelines.length === 0) return [];
  const byId = new Map(index.nodes.map((n) => [n.id, n]));
  const cache = opts.cache ?? new Map<string, CfgFileResult | null>();
  const out: WikiPipelineCfg[] = [];
  for (const p of pipelines) {
    const candidates = collectCandidates(p, index, byId);
    if (candidates.length === 0) continue;
    const picked = await pickPipelineFunctions(root, p.files, p.entryFiles, candidates, {
      max: opts.maxPerPipeline ?? 3,
      cache,
    });
    if (picked.functions.length === 0) continue;
    // 函数说明的上游/下游:从静态索引贴回(缺席=页面显示「索引未提供」)
    for (const fn of picked.functions) attachCfgContext(fn, index, byId);
    out.push({
      pipelineId: p.id,
      title: p.title,
      triggers: p.triggers,
      reach: p.reach,
      layers: p.layers,
      functions: picked.functions,
      candidates: picked.candidates,
      notes: picked.notes,
    });
  }
  return out;
}
