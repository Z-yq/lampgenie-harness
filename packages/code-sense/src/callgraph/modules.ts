/**
 * 代码 → 工作流模块整理(七期):
 * code-sense 的本职扩展——把静态索引里的符号整理成工作流模块节点,
 * 边=真实调用关系(不做任何编造)。纯函数,只读索引。
 *
 * 分类启发式(名字词表 + 调用图出入度,确定性):
 *   start   = trunk 且名字~启动/入口/主流程
 *   llm     = 名字~模型/生成/推断/提示
 *   http    = 名字~网络请求/远端调用
 *   retrieval=名字~检索/查找知识
 *   classifier=名字~分类/路由分发
 *   aggregate=名字~聚合合并
 *   loop    = 名字~遍历迭代
 *   template= 名字~渲染格式化序列化
 *   end     = leaf 且名字~输出/应答/打印
 *   agent   = 名字~代理/编排
 * 其余:function(函数件);类容器:module。
 */
import type { C2fIndex, C2fNode } from "./c2f";

export interface CodeModuleNode {
  id: string;
  kind: string;
  label: string;
  summary: string;
  symbolRef: { name: string; file: string; line: number };
  inCount: number;
  outCount: number;
}

export interface CodeModuleEdge {
  from: string;
  to: string;
  kind: "call" | "data";
  line: number;
  crossFile: boolean;
}

export interface FileModules {
  file: string;
  nodes: CodeModuleNode[];
  edges: CodeModuleEdge[];
  crossFileTargets: { name: string; file: string; line: number }[];
}

const RX = {
  start: /(start|main|boot|init|launch|entry|create.*app|setup|wire)/i,
  llm: /(llm|chat|complet|prompt|infer|generat|summar|translat|embed)/i,
  http: /(fetch|http|request|api|invoke|call.*remote|webhook|upload|download)/i,
  retrieval: /(retriev|search|lookup|query.*kb|find.*index|recall)/i,
  classifier: /(classif|categor|route|dispatch|match.*type|pick.*branch)/i,
  aggregate: /(aggregate|merge|collect|combine|reduce|fold|join)/i,
  loop: /(loop|iterat|each|traverse|walk|scan|foreach)/i,
  template: /(template|render|format|serialize|stringify|markdown|pretty|display|to.*string)/i,
  end: /(answer|reply|respond|output|emit|print|send|broadcast|log$|flush)/i,
  agent: /(agent|orchestr|coordinat|dispatch.*task)/i,
};

/** 单符号分类:词表(序=优先级)> 结构(trunk/leaf)。 */
export function classifySymbol(n: C2fNode): string {
  const name = n.name;
  // 决策件优先:名字带条件/分支语义(if/else 用词边界,防 class**if**y 类子串误命中)
  if (/(decide|branch|switch|choose|filter|valid|check|guard|\bif\b|\belse\b)/i.test(name)) return "decision";
  for (const [kind, re] of Object.entries(RX)) {
    if (re.test(name)) {
      // start 要求入口结构(trunk);end 要求叶子结构——名字对不上结构时退 function 防误标
      if (kind === "start" && n.inCount > 0) continue;
      if (kind === "end" && n.outCount > 0) continue;
      return kind;
    }
  }
  return n.kind === "trunk" ? "start" : n.kind === "leaf" ? "end" : "function";
}

const KIND_SUMMARY: Record<string, string> = {
  start: "流程入口:被这个文件的主链发起",
  llm: "模型调用:与 LLM 推断/生成相关",
  http: "外部调用:网络请求/远端 API",
  retrieval: "知识检索:查找/召回",
  classifier: "分类路由:按类型分发",
  aggregate: "聚合合并:汇拢多路输入",
  loop: "循环遍历:迭代处理",
  template: "模板渲染:格式化/序列化输出形态",
  end: "流程出口:叶子输出",
  decision: "判断分支:条件分叉",
  agent: "代理编排:任务调度",
  function: "常规函数件",
  module: "模块容器",
};

/** 文件 → 工作流模块图(节点=文件内符号,边=文件内真实调用;跨文件目标单列供参考)。 */
export function fileToModules(index: C2fIndex, relFile: string, maxNodes = 40): FileModules {
  const inFileIds = new Set(index.byFile[relFile] ?? []);
  const nodes: CodeModuleNode[] = [];
  for (const id of inFileIds) {
    const n = index.nodes.find((x) => x.id === id);
    if (!n) continue;
    // review 抓:原「类容器→module」分支永不命中(C2fNode 无类标记)且冗余 find——直接用 classifySymbol
    const kind = classifySymbol(n);
    nodes.push({
      id,
      kind,
      label: n.name,
      summary: KIND_SUMMARY[kind] ?? "常规函数件",
      symbolRef: { name: n.name, file: n.file, line: n.line },
      inCount: n.inCount,
      outCount: n.outCount,
    });
    if (nodes.length >= maxNodes) break;
  }
  const edges: CodeModuleEdge[] = [];
  const cross = new Map<string, { name: string; file: string; line: number }>();
  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const e of index.edges) {
    if (!nodeIds.has(e.from)) continue;
    if (nodeIds.has(e.to)) {
      edges.push({ from: e.from, to: e.to, kind: "call", line: e.line, crossFile: false });
    } else if (e.to) {
      // 跨文件真实目标:不造节点,列表透出(人可顺着去看)
      const t = index.nodes.find((x) => x.id === e.to);
      if (t && !cross.has(t.name)) cross.set(t.name, { name: t.name, file: t.file, line: t.line });
    }
  }
  return { file: relFile, nodes, edges, crossFileTargets: [...cross.values()].slice(0, 12) };
}
