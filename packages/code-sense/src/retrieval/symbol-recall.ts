/**
 * 符号优先召回(2026-10-21):自然语言问句 → 候选符号(读静态索引,毫秒级)。
 *
 * 背景(用户实报):`explore "子代理 spawn 权限审批怎么回到父会话"` 只回 grep 行,前列是
 * plan.approve / AGENTS.md 噪声;真正答案 makeSubagentPermissionAsker(agent-wiring.ts:83)与
 * permission-broker.ts 完全进不了前列——而 `symbol makeSubagentPermissionAsker` 一次即中。
 * 瓶颈在**入口词**不在索引:中文问句没有 camelCase 字面量,grep 只能撞运气。
 *
 * 管线:
 *   ① queryTerms(中文分词+中英词典+驼峰切分) → 召回词表(cjk.ts 纯函数)
 *   ② 词表 × 索引符号名 token 打分(IDF 降权通用词 + 多词覆盖加分)
 *   ③ 二轮邻居一致性:候选的 1 跳调用邻居名里出现其它查询词 → 加分
 *      (LlmLoopBackend.spawn 自身不含 subagent,但它调用 renderSubagentHeavyOpDiscipline)
 *   ④ 取 top-N 主候选 + top 候选的直接 callers/callees 各 1-2 个作「1 跳扩展」上下文
 *   ⑤ 输出携带「被谁调/调谁/命中原因」,消费面可直接渲染与给下一步命令
 *
 * 红线:索引缺失/损坏 → 返回空 symbols + degraded 说明(不编造符号);不在本函数内建索引。
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { indexDir, loadIndex, type C2fEdge, type C2fIndex, type C2fNode } from "../callgraph/c2f";
import { isNonProductPath, isTestPath } from "../path-filter";
import { queryTerms, splitIdentifier, type QueryTerm, type QueryTerms } from "./cjk";

/** 打分用的最小符号面(C2fNode 结构兼容;单测可直接造)。 */
export interface SymbolDoc {
  id: string;
  name: string;
  file: string;
  line: number;
  container?: string;
  inCount: number;
  outCount: number;
  symKind?: string;
  /** 2026-10-22:C/C++ 函数原型(与 C2fNode.proto 同源);同名定义在场时召回层折叠。 */
  proto?: boolean;
}

export interface SymbolScore {
  doc: SymbolDoc;
  score: number;
  /** 命中的查询词数(多词覆盖=强信号)。 */
  coverage: number;
  /** 命中的查询词(按词表序,已去重)。 */
  matched: string[];
  /** 二轮邻居一致性:候选的调用邻居名里额外命中的查询词数。 */
  neighborHits: number;
}

export interface SymbolRef {
  name: string;
  file: string;
  line: number;
}

/** 输出候选(gateway/CLI/wiki 三面同源;`--json` 的 symbols[] 元素)。 */
export interface SymbolCandidate {
  name: string;
  file: string;
  line: number;
  container?: string;
  score: number;
  /** 命中原因(可读,面板/报告直接展示)。 */
  reasons: string[];
  /** 被谁调用(直接 1 跳,封顶 3;空=索引内无调用方)。 */
  callers: SymbolRef[];
  /** 调用了谁(直接 1 跳,封顶 3)。 */
  callees: SymbolRef[];
  /** true=由前序候选的 1 跳调用关系扩展进来(定义文件的邻居)。 */
  expanded?: boolean;
}

const tokenCache = new WeakMap<SymbolDoc, string[]>();
function docTokens(doc: SymbolDoc): string[] {
  let t = tokenCache.get(doc);
  if (!t) {
    t = splitIdentifier(doc.name);
    if (doc.container) for (const c of splitIdentifier(doc.container)) if (!t.includes(c)) t.push(c);
    tokenCache.set(doc, t);
  }
  return t;
}

/** 单 token 匹配强度:整 token 3 / 前缀 2(≥3 字符)/ 包含 1.5(≥4 字符)。 */
export function tokenMatchStrength(tokens: readonly string[], term: string): number {
  let best = 0;
  for (const tok of tokens) {
    if (tok === term) return 3;
    if (term.length >= 3 && tok.startsWith(term)) {
      if (best < 2) best = 2;
    } else if (term.length >= 4 && tok.includes(term)) {
      if (best < 1.5) best = 1.5;
    }
  }
  return best;
}

/** 词表文档频率(与 tokenMatchStrength 同口径:前缀/包含也算命中)。 */
export function buildTermDocFreq(docs: readonly SymbolDoc[], terms: readonly QueryTerm[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const t of terms) df.set(t.term, 0);
  for (const doc of docs) {
    const tokens = docTokens(doc);
    for (const t of terms) {
      if (tokenMatchStrength(tokens, t.term) > 0) df.set(t.term, (df.get(t.term) ?? 0) + 1);
    }
  }
  return df;
}

const byScore = (a: SymbolScore, b: SymbolScore): number =>
  b.score - a.score
  || a.doc.name.localeCompare(b.doc.name)
  || a.doc.file.localeCompare(b.doc.file)
  || a.doc.line - b.doc.line;

export interface ScoreOptions {
  /** 测试文件降权(默认 true):测试符号同名多、命中多,抢生产符号的席位。 */
  demoteTests?: boolean;
  /** 非产品路径(docs/tasks/ref/fixtures…)降权(默认 true)。 */
  demoteNonProduct?: boolean;
}

/** 纯打分:词表 × 符号名 token。返回 coverage>0 的符号(未排序前按入参序)。 */
export function scoreSymbols(
  docs: readonly SymbolDoc[],
  terms: readonly QueryTerm[],
  opts: ScoreOptions = {},
): SymbolScore[] {
  if (docs.length === 0 || terms.length === 0) return [];
  const demoteTests = opts.demoteTests !== false;
  const demoteNonProduct = opts.demoteNonProduct !== false;
  const df = buildTermDocFreq(docs, terms);
  const N = docs.length;
  const idf = new Map<string, number>();
  for (const t of terms) idf.set(t.term, Math.log(1 + N / (1 + (df.get(t.term) ?? 0))));

  const out: SymbolScore[] = [];
  for (const doc of docs) {
    const tokens = docTokens(doc);
    let score = 0;
    let coverage = 0;
    const matched: string[] = [];
    for (const t of terms) {
      const strength = tokenMatchStrength(tokens, t.term);
      if (strength <= 0) continue;
      coverage++;
      matched.push(t.term);
      score += strength * t.weight * (idf.get(t.term) ?? 1);
    }
    if (coverage === 0) continue;
    // 多词覆盖:两个概念同时命中远强于同一概念的多词根变体命中
    if (coverage >= 2) score += 2.5 * (coverage - 1);
    if (coverage >= 3) score += 3;
    // 入度轻加分(被调用多=更可能是用户要找的公共入口;只做同分/近分裁决)
    score += 0.4 * Math.log(1 + Math.max(0, doc.inCount));
    // 整名精确(查询里直接给了标识符)——强信号,不再靠 token 近似
    if (terms.some((t) => t.source === "identifier" && doc.name.toLowerCase() === t.term)) score += 8;
    if (demoteTests && isTestPath(doc.file)) score *= 0.4;
    if (demoteNonProduct && isNonProductPath(doc.file)) score *= 0.3;
    out.push({ doc, score, coverage, matched, neighborHits: 0 });
  }
  return out.sort(byScore);
}

/** 二轮:邻居一致性。候选自身没命中的查询词,若它的直接调用邻居名命中,则加分
 * (子代理派发=LlmLoopBackend.spawn 这类「名字不含概念词」的入口靠这一轮浮上来)。
 * 只对前 top 个候选做(全量邻居扫描=O(edges),没必要)。纯函数:邻居名由回调提供。 */
export function applyNeighborCoherence(
  scores: readonly SymbolScore[],
  neighborNamesOf: (id: string) => readonly string[],
  terms: readonly QueryTerm[],
  opts: { top?: number; bonus?: number } = {},
): SymbolScore[] {
  const top = Math.min(opts.top ?? 30, scores.length);
  const bonus = opts.bonus ?? 2.2;
  const out = scores.map((s) => ({ ...s, matched: [...s.matched] }));
  for (let i = 0; i < top; i++) {
    const s = out[i]!;
    const names = neighborNamesOf(s.doc.id);
    if (names.length === 0) continue;
    const neighborTokens = names.map((n) => splitIdentifier(n));
    let hits = 0;
    for (const t of terms) {
      if (s.matched.includes(t.term)) continue;
      if (neighborTokens.some((toks) => tokenMatchStrength(toks, t.term) > 0)) hits++;
    }
    if (hits > 0) {
      s.neighborHits = hits;
      s.score += hits * bonus;
    }
  }
  return out.sort(byScore);
}

// ---- 索引面(带单条缓存;索引 JSON 可达 17MB,explore 每次重新解析不可接受) ----

interface EdgeMaps {
  out: Map<string, C2fEdge[]>;
  in: Map<string, C2fEdge[]>;
  byId: Map<string, C2fNode>;
}

let indexCache: { root: string; mtimeMs: number; size: number; index: C2fIndex } | null = null;

/** 读索引(只读、绝不触发构建)。单条缓存按 index.json 的 mtime+size 失效。
 * 返回 null=索引未就绪(调用方显式降级到 grep)。 */
export function loadIndexCached(root: string): C2fIndex | null {
  const p = join(indexDir(root), "index.json");
  let st: { mtimeMs: number; size: number };
  try {
    const s = statSync(p);
    st = { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
  if (indexCache && indexCache.root === root && indexCache.mtimeMs === st.mtimeMs && indexCache.size === st.size) {
    return indexCache.index;
  }
  const index = loadIndex(root);
  if (!index) return null;
  indexCache = { root, ...st, index };
  return index;
}

/** 单测/长驻进程手动失效(索引重建后不必等 mtime 精度)。 */
export function clearSymbolRecallCache(): void {
  indexCache = null;
}

const edgeMapCache = new WeakMap<C2fIndex, EdgeMaps>();
function edgeMaps(index: C2fIndex): EdgeMaps {
  let m = edgeMapCache.get(index);
  if (!m) {
    const out = new Map<string, C2fEdge[]>();
    const inn = new Map<string, C2fEdge[]>();
    for (const e of index.edges) {
      let o = out.get(e.from);
      if (!o) out.set(e.from, (o = []));
      o.push(e);
      if (!e.to) continue;
      let i = inn.get(e.to);
      if (!i) inn.set(e.to, (i = []));
      i.push(e);
    }
    m = { out, in: inn, byId: new Map(index.nodes.map((n) => [n.id, n])) };
    edgeMapCache.set(index, m);
  }
  return m;
}

export interface SymbolRecallOptions {
  /** 主候选数(默认 8)。 */
  limit?: number;
  /** 1 跳扩展候选总数(默认 4;0=关闭)。 */
  expand?: number;
  /** 从主候选前几个做扩展(默认 3)。 */
  expandFrom?: number;
  /** 每个邻居方向取几个(默认 2)。 */
  expandPer?: number;
}

export interface SymbolRecallResult {
  symbols: SymbolCandidate[];
  terms: QueryTerms;
  /** 索引内符号数(0=索引未就绪)。 */
  indexSize: number;
  /** 索引不可用时的诚实说明;可用时缺省。 */
  degraded?: string;
}

/** 查询 → 候选符号(explore / wiki ask 共用;只读静态索引,毫秒级)。 */
export function recallSymbols(root: string, query: string, opts: SymbolRecallOptions = {}): SymbolRecallResult {
  const limit = opts.limit ?? 8;
  const expand = opts.expand ?? 4;
  const expandFrom = opts.expandFrom ?? 3;
  const expandPer = opts.expandPer ?? 2;
  const terms = queryTerms(query);
  const index = loadIndexCached(root);
  if (!index || index.nodes.length === 0) {
    return {
      symbols: [], terms, indexSize: 0,
      degraded: "静态索引未就绪(.genie/sense-index 无可用 index.json)——符号召回降级为 grep;codesense index 构建后恢复",
    };
  }
  const docs: SymbolDoc[] = index.nodes;
  const firstPass = scoreSymbols(docs, terms.terms);
  if (firstPass.length === 0) {
    return { symbols: [], terms, indexSize: docs.length };
  }
  const maps = edgeMaps(index);
  const neighborNamesOf = (id: string): string[] => {
    const names: string[] = [];
    for (const e of maps.out.get(id) ?? []) {
      const n = maps.byId.get(e.to);
      if (n) names.push(n.name);
    }
    for (const e of maps.in.get(id) ?? []) {
      const n = maps.byId.get(e.from);
      if (n) names.push(n.name);
    }
    return names;
  };
  const ranked = applyNeighborCoherence(firstPass, neighborNamesOf, terms.terms);
  // 2026-10-22 P0:同名定义在场时折叠 .h 原型——否则 explore 同时给出定义与声明两条,
  // 用户会误以为有两个实现(实锚 saadk_6920 SA_YOLOX_Init .c/.h 双条)。
  const defNames = new Set(ranked.filter((s) => !s.doc.proto).map((s) => s.doc.name));
  const rankedDedup = ranked.filter((s) => !(s.doc.proto && defNames.has(s.doc.name)));
  const primaries = diversePick(rankedDedup, Math.max(0, limit));

  const refs = (edges: C2fEdge[], side: "from" | "to"): SymbolRef[] => {
    const out: SymbolRef[] = [];
    const seen = new Set<string>();
    for (const e of edges) {
      const id = side === "from" ? e.from : e.to;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const n = maps.byId.get(id);
      const name = n?.name ?? (id.split("#").pop() ?? "");
      if (!name) continue; // 模块级虚节点(`path#`)：无符号名,展示无意义
      // 索引内的 <module>/匿名容器 id 不在 nodes[]:行号回落**边上的调用行**(e.line),
      // 不能填 0(实测会渲染成 `.execute@agent-wiring.ts:0` 这类假坐标)
      out.push({ name, file: n?.file ?? (id.split("#")[0] ?? e.file), line: n?.line ?? e.line });
    }
    return out;
  };

  const candidates: SymbolCandidate[] = primaries.map((s) => ({
    name: s.doc.name,
    file: s.doc.file,
    line: s.doc.line,
    ...(s.doc.container ? { container: s.doc.container } : {}),
    score: Math.round(s.score * 100) / 100,
    reasons: reasonOf(s),
    callers: refs(maps.in.get(s.doc.id) ?? [], "from").slice(0, 3),
    callees: refs(maps.out.get(s.doc.id) ?? [], "to").slice(0, 3),
  }));

  // ④ 1 跳扩展:定义文件的邻居(调用方/被调方)也纳入结果,标 expanded。
  // 质量门:邻居名命中查询词=强相关(必收);未命中的邻居只从**第一名**候选取(≤2),
  // 其它候选的未命中邻居不收——否则唯一名兜底边(如 NodeDispatch.delegate → InMemory
  // CredentialStore.resolve)会把无关符号带进结果。
  if (expand > 0) {
    const seenIds = new Set(primaries.map((s) => s.doc.id));
    const expanded: SymbolCandidate[] = [];
    const matchesAnyTerm = (name: string): boolean => {
      const toks = splitIdentifier(name);
      return terms.terms.some((t) => tokenMatchStrength(toks, t.term) > 0);
    };
    for (const p of primaries.slice(0, expandFrom)) {
      const isFirst = primaries[0]?.doc.id === p.doc.id;
      const picks: { node: C2fNode; why: string; matched: boolean }[] = [];
      const ins = maps.in.get(p.doc.id) ?? [];
      const outs = maps.out.get(p.doc.id) ?? [];
      // 两个方向交替取,保证「谁在用它」与「它用了谁」都在场
      for (let i = 0; i < Math.max(ins.length, outs.length) && picks.length < expandPer * 3; i++) {
        const inEdge = ins[i];
        if (inEdge) {
          const n = maps.byId.get(inEdge.from);
          if (n) picks.push({ node: n, why: `1 跳扩展: 它调用 ${p.doc.name}`, matched: matchesAnyTerm(n.name) });
        }
        const outEdge = outs[i];
        if (outEdge) {
          const n = maps.byId.get(outEdge.to);
          if (n) picks.push({ node: n, why: `1 跳扩展: ${p.doc.name} 调用它`, matched: matchesAnyTerm(n.name) });
        }
      }
      // 词命中优先 > 生产文件优先(测试文件靠后;邻居不抢主候选席位)
      picks.sort((a, b) =>
        Number(b.matched) - Number(a.matched)
        || Number(isTestPath(a.node.file)) - Number(isTestPath(b.node.file)));
      let taken = 0;
      for (const pick of picks) {
        if (taken >= expandPer || expanded.length >= expand) break;
        if (seenIds.has(pick.node.id)) continue;
        if (!pick.matched && !isFirst) continue;
        seenIds.add(pick.node.id);
        taken++;
        expanded.push({
          name: pick.node.name,
          file: pick.node.file,
          line: pick.node.line,
          ...(pick.node.container ? { container: pick.node.container } : {}),
          score: Math.round(p.score * 0.35 * 100) / 100,
          reasons: [pick.why],
          callers: [], // 扩展候选不重复展开二级关系(输出体积与噪声控制)
          callees: [],
          expanded: true,
        });
      }
      if (expanded.length >= expand) break;
    }
    candidates.push(...expanded.sort((a, b) => b.score - a.score));
  }

  return { symbols: candidates, terms, indexSize: docs.length };
}

/** 结果多样性(2026-10-21):同一文件/同一容器最多 2 席——否则一个类的方法会占满 top-N
 * (「子代理 spawn 权限审批」实测 ParentAskBroker.* 连占 4 席,把 permission-broker.ts 挤掉)。
 * 多样性不足时才回填(不因去重让结果空转)。 */
function diversePick(ranked: readonly SymbolScore[], limit: number): SymbolScore[] {
  const out: SymbolScore[] = [];
  const perFile = new Map<string, number>();
  const perContainer = new Map<string, number>();
  for (const s of ranked) {
    if (out.length >= limit) break;
    const f = perFile.get(s.doc.file) ?? 0;
    if (f >= 2) continue;
    const c = s.doc.container ? (perContainer.get(s.doc.container) ?? 0) : 0;
    if (s.doc.container && c >= 2) continue;
    out.push(s);
    perFile.set(s.doc.file, f + 1);
    if (s.doc.container) perContainer.set(s.doc.container, c + 1);
  }
  if (out.length < limit) {
    const seen = new Set(out);
    for (const s of ranked) {
      if (out.length >= limit) break;
      if (seen.has(s)) continue;
      out.push(s);
      seen.add(s);
    }
  }
  return out;
}

function reasonOf(s: SymbolScore): string[] {  const reasons: string[] = [];
  const shown = s.matched.slice(0, 6);
  reasons.push(`词命中 ${shown.join("/")}${s.matched.length > shown.length ? ` 等 ${s.matched.length} 词` : ""}`);
  if (s.coverage >= 2) reasons.push(`多词覆盖 ${s.coverage}`);
  if (s.neighborHits > 0) reasons.push(`邻居词命中 +${s.neighborHits}`);
  if (isTestPath(s.doc.file)) reasons.push("测试文件(降权)");
  return reasons;
}
