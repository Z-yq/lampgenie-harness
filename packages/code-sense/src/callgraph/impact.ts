/**
 * impact——改动影响面查询:一次查询=「改这个函数牵连什么」的完整清单。
 * 四个通道,全部读静态索引(毫秒级,零 LLM):
 * ① 签名:C2fNode.sig(起构建落盘;旧索引无=显式降级不假报);
 * ② 调用闭包:callers/callees 双向 BFS,逐跳 dN 标注;d1 完整不封顶(与 A4 修复同语义),
 *    d≥2 每层封顶防爆炸,截断如实标注;
 * ③ 受影响文件:闭包触达文件(调用通道)+ import 该定义所在文件的文件(import 通道,
 *    C2fIndex.importers,旧索引无=只出调用通道并注明);
 * ④ 关联测试:闭包中位于测试路径的调用方(直接 d1/间接 dN 分列)+ import 通道的测试文件。
 * 向后兼容:旧 .genie/sense-index/ 不重建即可用——sig/importers 缺省,对应分节标注降级。
 */
import type { C2fIndex, C2fNode } from "./c2f";
import { querySymbol } from "./c2f";
import { isTestPath } from "../path-filter";
import type { BridgeEdge } from "../sensing/crosslang-bridge";

export interface ImpactRef {
  id: string;
  name: string;
  file: string;
  line: number;
  depth: number;
}

export interface ImpactTestRef extends ImpactRef {
  /** call=闭包里调用到它;import=import 通道(只到文件级,无行号语义→line=0)。 */
  via: "call" | "import";
 /** (RC-096-B3):跨深度定位——跳数 > 查询闭包深度,由测试通道专属延伸扫描发现
   * (ValidateFlagGroups 类形态:专属测试经 Execute→execute 3 跳触达,≤d2 闭包看不见)。 */
  beyondDepth?: boolean;
}

export interface ImpactFileRef {
  file: string;
  /** 调用通道:闭包里有符号定义在此文件。 */
  viaCall: boolean;
  /** import 通道:该文件 import 了定义所在文件(定义文件自身不计)。 */
  viaImport: boolean;
  /** 闭包触达的最小深度(定义文件=0;纯 import 通道=Infinity)。 */
  minDepth: number;
}

export interface ImpactDefinition {
  symbol: C2fNode;
  /** 签名一行文本(「(a: string, b?: number): void」);无 sig=undefined。 */
  signature?: string;
  callers: ImpactRef[];
  callees: ImpactRef[];
 /** 跨语言桥边命中( §7 落地;索引无 bridge 段=undefined)。
   * role=backend-handler:本定义是端点 handler(handler 名配对,裸名兼容方法形态——
 * grafana HTTPServer.Logout↔handler=Logout 注意),列出前端字面量调用点;
   * role=frontend-caller:本定义是前端符号,字面量按「同文件最近前驱节点」归属到它,
   * 列出触达的后端端点。 */
  bridges?: ImpactBridgeHit[];
}

/** 单条桥边命中。 */
export interface ImpactBridgeHit {
  role: "backend-handler" | "frontend-caller";
  edge: BridgeEdge;
  /** backend-handler 专用标记:路由注册文件(edge.to.file)与 handler 定义同文件。
   * false=跨文件名绑定(grafana 常态:注册在 api.go、定义在 login.go)——如实标注。 */
  sameFile: boolean;
}

/** (RC-096-B5):弃边与不可见面——「诚实弃边」的计量从构建期台账读出。 */
export interface ImpactDroppedNote {
  /** 构建期弃边台账中匹配查询裸名的条目;null=该名无弃边记录(或旧索引无台账字段)。 */
  ledger: { count: number; reasons: Record<string, number>; samples: { file: string; line: number }[] } | null;
  /** 台账字段在索引中是否存在(旧索引=false——「无记录」与「零弃边」要区分)。 */
  ledgerAvailable: boolean;
  /** 索引内 to="" 未解析边中 toName 匹配查询裸名的数量(发射了但目标未解析:
   * 动态形态/无类型证据/自归属盲区——与弃边不同,这些边仍在索引里)。 */
  unresolvedEdges: number;
  /** 台账名字总数超落盘封顶(300)——计数可能未含全部名字。 */
  ledgerTruncated: boolean;
}

export interface ImpactResult {
  query: string;
  depth: number;
  definitions: ImpactDefinition[];
  files: ImpactFileRef[];
  tests: ImpactTestRef[];
  /** import 通道是否可用(索引带 importers 字段)。false=旧索引,文件/测试清单只含调用通道。 */
  importChannel: boolean;
 /** 定义文件语言不在 import 解析面(py/java/c 族)时如实注记(importChannel 为真也可能空)。 */
  importCapable: boolean;
 /** (RC-096-B3):跨深度测试扫描是否触发封顶(节点/跳数),true=更深处可能还有测试。 */
  testScanCapped: boolean;
 /** (RC-096-B5):弃边与不可见计量面。 */
  dropped: ImpactDroppedNote;
 /** 索引是否带桥边段(false=旧索引/通道关闭,桥边段整体缺席不报错)。 */
  bridgeChannel: boolean;
 /** P0:图置信度——解析含语法错误的文件面。known=false 表示旧索引未记录
   * (盲区未知,不得当作零盲区);related=本次查询触点里落在错误文件列表中的文件。
   * 有盲区时「0 调用方」不能作为可删除/可改签名的依据。 */
  graphHealth?: {
    known: boolean;
    errorFileCount: number;
    related: string[];
  };
  truncated: boolean;
  /** 每定义每侧 d1 直接关系计数(闭包封顶不影响 d1 完整性)。 */
  summary: {
    directCallers: number;
    directCallees: number;
    transitiveCallers: number;
    transitiveCallees: number;
    fileCount: number;
    testCount: number;
 /** 全部定义的桥边命中总数(仅 >0 时在渲染汇总行出现)。 */
    bridges?: number;
  };
}

/** 深层(d≥2)每层封顶(与 querySymbolDeep 修复同值;d1 恒完整——影响面的第一跳必须全量)。 */
const DEEP_CAP_PER_LEVEL = 24;
export const IMPACT_DEFAULT_DEPTH = 2;

/** (RC-096-B3):关联测试跨深度通道参数——闭包深度之外最多再走的跳数与全局访问封顶。
 * 语义:测试文件包含性匹配不受调用跳数限制(「3 跳外的专属测试」假阴性的根治),
 * 但必须有资源闸:热符号的全图调用方闭包可爆炸,只收集测试路径节点、封顶如实标注。 */
const TEST_EXTRA_DEPTH = 6;
const TEST_NODE_CAP = 400;

/** 邻接表:一次 O(E) 建立,BFS 不再逐层全边扫描(评测 A4 同族性能面)。 */
function adjacency(index: C2fIndex): { callersOf: Map<string, string[]>; calleesOf: Map<string, string[]> } {
  const callersOf = new Map<string, string[]>();
  const calleesOf = new Map<string, string[]>();
  for (const e of index.edges) {
    if (e.to) {
      const list = callersOf.get(e.to) ?? [];
      if (!list.includes(e.from)) list.push(e.from);
      callersOf.set(e.to, list);
      const out = calleesOf.get(e.from) ?? [];
      if (!out.includes(e.to)) out.push(e.to);
      calleesOf.set(e.from, out);
    }
  }
  return { callersOf, calleesOf };
}

function bfs(
  startId: string,
  dir: "callers" | "callees",
  adj: Map<string, string[]>,
  depth: number,
  nodeById: Map<string, C2fNode>,
): { refs: ImpactRef[]; truncated: boolean } {
  const refs: ImpactRef[] = [];
  const seen = new Set<string>([startId]);
  let frontier = [startId];
  let truncated = false;
  for (let d = 1; d <= depth && !truncated; d++) {
    const cap = d === 1 ? Infinity : DEEP_CAP_PER_LEVEL;
    const next: string[] = [];
    let levelCount = 0;
    for (const id of frontier) {
      for (const other of adj.get(id) ?? []) {
        if (seen.has(other)) continue;
        seen.add(other);
        if (levelCount >= cap) { truncated = true; break; }
        refs.push(toRef(nodeById, other, d));
        levelCount++;
        next.push(other);
      }
      if (truncated) break;
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return { refs, truncated };
}

/** (RC-096-B3):跨深度测试调用方扫描——从定义符号沿 callers 方向 BFS 到
 * depth+TEST_EXTRA_DEPTH,只收集「位于测试路径」的节点,跳数 > depth 的标 beyondDepth。
 * 与主闭包 BFS 独立(主闭包的语义=depth 内全类型节点,不动);防爆双闸:跳数+访问节点数。 */
function bfsTestCallers(
  startId: string,
  callersOf: Map<string, string[]>,
  depth: number,
  nodeById: Map<string, C2fNode>,
): { refs: ImpactTestRef[]; capped: boolean } {
  const refs: ImpactTestRef[] = [];
  const seen = new Set<string>([startId]);
  let frontier = [startId];
  let capped = false;
  const maxDepth = depth + TEST_EXTRA_DEPTH;
  for (let d = 1; d <= maxDepth; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const other of callersOf.get(id) ?? []) {
        if (seen.has(other)) continue;
        seen.add(other);
        if (seen.size > TEST_NODE_CAP) { capped = true; break; }
        const n = nodeById.get(other);
        const file = n ? n.file : other.slice(0, Math.max(0, other.lastIndexOf("#")));
        if (isTestPath(file)) {
          refs.push({ ...toRef(nodeById, other, d), via: "call", ...(d > depth ? { beyondDepth: true } : {}) });
        }
        next.push(other);
      }
      if (capped) break;
    }
    if (capped) break;
    frontier = next;
    if (frontier.length === 0) break;
  }
  return { refs, capped };
}

// 模块级缓存:同一 index 反复查询不重复建 nodeById
const nodeByIdCache = new WeakMap<C2fIndex, Map<string, C2fNode>>();
function nodeTable(index: C2fIndex): Map<string, C2fNode> {
  let m = nodeByIdCache.get(index);
  if (!m) {
    m = new Map(index.nodes.map((n) => [n.id, n]));
    nodeByIdCache.set(index, m);
  }
  return m;
}

function toRef(nodeById: Map<string, C2fNode>, id: string, depth: number): ImpactRef {
  const n = nodeById.get(id);
  if (n) return { id: n.id, name: n.name, file: n.file, line: n.line, depth };
  // <module> 虚调用方等索引外 id:与 c2f.nodeRef 同形(name/file 从 id 拆)
  const hash = id.lastIndexOf("#");
  return { id, name: hash >= 0 ? id.slice(hash + 1) : id, file: hash >= 0 ? id.slice(0, hash) : "", line: 0, depth };
}

/** 签名一行渲染:「(a: string, b?: number): void」。展示侧超 220 字符截断(索引数据不动)。 */
export function renderSignature(sig: NonNullable<C2fNode["sig"]>): string {
  const params = sig.params
    .map((p) => `${p.name}${p.type ? ": " + p.type : ""}${p.optional ? "?" : ""}`)
    .join(", ");
  const line = `(${params})${sig.returnType ? ": " + sig.returnType : ""}`;
  return line.length > 220 ? line.slice(0, 217) + "…" : line;
}

/** 影响面查询:符号名 → 闭包/文件/测试/签名四通道清单。多定义(同名)逐定义分列。 */
export function queryImpact(index: C2fIndex, name: string, opts?: { depth?: number }): ImpactResult {
  const depth = Math.max(1, Math.floor(opts?.depth ?? IMPACT_DEFAULT_DEPTH));
  const hits = querySymbol(index, name);
  const { callersOf, calleesOf } = adjacency(index);
  const nodeById = nodeTable(index);
  const importers = index.importers ?? null;

  const definitions: ImpactDefinition[] = [];
  const fileMap = new Map<string, ImpactFileRef>();
  const truncatedBy = { callers: false, callees: false };
  let directCallers = 0;
  let directCallees = 0;
  let transitiveCallers = 0;
  let transitiveCallees = 0;

  const touchFile = (file: string, viaCall: boolean, depthAt: number): void => {
    if (!file) return;
    const cur = fileMap.get(file);
    if (!cur) {
      fileMap.set(file, { file, viaCall, viaImport: false, minDepth: depthAt });
      return;
    }
    if (viaCall) cur.viaCall = true;
    if (depthAt < cur.minDepth) cur.minDepth = depthAt;
  };

  for (const h of hits) {
    const sym = h.symbol;
    const callers = bfs(sym.id, "callers", callersOf, depth, nodeById);
    const callees = bfs(sym.id, "callees", calleesOf, depth, nodeById);
    if (callers.truncated) truncatedBy.callers = true;
    if (callees.truncated) truncatedBy.callees = true;
    directCallers += callers.refs.filter((r) => r.depth === 1).length;
    directCallees += callees.refs.filter((r) => r.depth === 1).length;
    transitiveCallers += callers.refs.filter((r) => r.depth > 1).length;
    transitiveCallees += callees.refs.filter((r) => r.depth > 1).length;
    definitions.push({
      symbol: sym,
      ...(sym.sig ? { signature: renderSignature(sym.sig) } : {}),
      callers: callers.refs,
      callees: callees.refs,
    });
    // 文件聚合:定义文件(depth 0)+闭包触达文件
    touchFile(sym.file, true, 0);
    for (const r of [...callers.refs, ...callees.refs]) touchFile(r.file, true, r.depth);
  }

  // import 通道:import 了定义所在文件的文件(无调用闭包也能到=接口消费方)
  const defFiles = [...new Set(hits.map((h) => h.symbol.file))];
  const importOnlyFiles: string[] = [];
  if (importers) {
    for (const f of defFiles) {
      for (const imp of importers[f] ?? []) {
        if (defFiles.includes(imp)) continue; // 自文件/定义文件互导不算外部影响
        const cur = fileMap.get(imp);
        if (cur) {
          cur.viaImport = true;
        } else {
          fileMap.set(imp, { file: imp, viaCall: false, viaImport: true, minDepth: Infinity });
          importOnlyFiles.push(imp);
        }
      }
    }
  }

  // 关联测试:闭包调用通道(d1=直接测试,dN=间接)+ import 通道的测试文件
  const tests: ImpactTestRef[] = [];
  const testSeen = new Set<string>();
  for (const d of definitions) {
    for (const r of d.callers) {
      if (!isTestPath(r.file) || testSeen.has(r.id + ":" + r.line)) continue;
      testSeen.add(r.id + ":" + r.line);
      tests.push({ ...r, via: "call" });
    }
  }
 // (RC-096-B3):跨深度测试扫描——测试文件包含性匹配不受调用跳数限制
  // (闭包 d 层封顶可能漏掉的 ≤depth 测试也由这里补齐;>depth 的标 beyondDepth)
  let testScanCapped = false;
  for (const h of hits) {
    const r = bfsTestCallers(h.symbol.id, callersOf, depth, nodeById);
    if (r.capped) testScanCapped = true;
    for (const t of r.refs) {
      const k = t.id + ":" + t.line;
      if (testSeen.has(k)) continue;
      testSeen.add(k);
      tests.push(t);
    }
  }
  if (importers) {
    for (const f of importOnlyFiles) {
      if (!isTestPath(f)) continue;
      tests.push({ id: f, name: f, file: f, line: 0, depth: 0, via: "import" });
    }
  }

 // (RC-096-B5):弃边与不可见计量(裸名与原名双查——台账键=调用点书写的被调名)
  const bare = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  const ledgerEntry = index.dropped
    ? (index.dropped[name] ?? index.dropped[bare] ?? null)
    : null;
  let unresolvedEdges = 0;
  for (const e of index.edges) {
    if (!e.to && (e.toName === name || e.toName === bare)) unresolvedEdges++;
  }
  const dropped: ImpactDroppedNote = {
    ledger: ledgerEntry,
    ledgerAvailable: index.dropped !== undefined,
    unresolvedEdges,
    ledgerTruncated: index.droppedNames !== undefined && index.dropped !== undefined
      ? index.droppedNames > Object.keys(index.dropped).length
      : false,
  };

 // (RC-096-B2):import 通道的语言能力面——TS/JS/Go 产 importers;
  // 定义文件语言不在面内时 import 通道对本符号恒空,如实注记(不算通道不可用)。
  const IMPORT_CAPABLE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go"]);
  const extOf = (f: string): string => f.slice(f.lastIndexOf("."));
  const importCapable = defFiles.length > 0 && defFiles.some((f) => IMPORT_CAPABLE_EXT.has(extOf(f)));

 // 跨语言桥边段——索引带 bridge 段时按定义配对(确定性,零 LLM):
  // ① backend-handler:edge.to.handler === 符号名/裸名(裸名兼容 Class.method 形态——
 // grafana HTTPServer.Logout↔handler=Logout 注意),且定义文件与路由注册文件同语言族
  //    (同扩展名或同属 JS 族)——跨语言同名不绑(前端 hello() 不得吸收后端 flask hello
  //    的桥边;名绑定是确定性层的全部证据,同族收窄是诚实边界);
  // ② frontend-caller:edge.from.file === 定义文件,归属=同文件最近前驱节点
  //    (nodes 中 line ≤ from.line 的最大 line 节点;归属不到=边不出现在任何符号段,
  //    宁缺勿错——文件级全量在 codesense bridge 面)。
  const bridge = index.bridge ?? null;
  let bridgeHits = 0;
  if (bridge && bridge.edges.length > 0 && definitions.length > 0) {
    const TSJS_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
    const sameLangFamily = (a: string, b: string): boolean => {
      const ea = extOf(a);
      const eb = extOf(b);
      return ea === eb || (TSJS_EXT.has(ea) && TSJS_EXT.has(eb));
    };
    const byHandler = new Map<string, BridgeEdge[]>();
    const feByFile = new Map<string, BridgeEdge[]>();
    for (const e of bridge.edges) {
      if (e.to.handler) {
        const list = byHandler.get(e.to.handler) ?? [];
        list.push(e);
        byHandler.set(e.to.handler, list);
      }
      const fl = feByFile.get(e.from.file) ?? [];
      fl.push(e);
      feByFile.set(e.from.file, fl);
    }
    // 定义文件的前端节点行表(懒建,仅当该文件有桥边字面量)
    const nodesByFile = new Map<string, C2fNode[]>();
    const nodesOf = (file: string): C2fNode[] => {
      let list = nodesByFile.get(file);
      if (!list) {
        list = index.nodes.filter((n) => n.file === file).sort((a, b) => a.line - b.line);
        nodesByFile.set(file, list);
      }
      return list;
    };
    const ownerOf = (file: string, line: number): C2fNode | undefined => {
      const list = nodesOf(file);
      let hit: C2fNode | undefined;
      for (const n of list) {
        if (n.line > line) break;
        hit = n;
      }
      return hit;
    };
    for (const d of definitions) {
      const sym = d.symbol;
      const bare = sym.name.includes(".") ? sym.name.slice(sym.name.lastIndexOf(".") + 1) : sym.name;
      const hits: ImpactBridgeHit[] = [];
      const seen = new Set<BridgeEdge>();
      for (const key of bare === sym.name ? [sym.name] : [sym.name, bare]) {
        for (const e of byHandler.get(key) ?? []) {
          if (seen.has(e) || !sameLangFamily(sym.file, e.to.file)) continue;
          seen.add(e);
          hits.push({ role: "backend-handler", edge: e, sameFile: e.to.file === sym.file });
        }
      }
      for (const e of feByFile.get(sym.file) ?? []) {
        if (seen.has(e)) continue;
        if (ownerOf(sym.file, e.from.line)?.id !== sym.id) continue;
        seen.add(e);
        hits.push({ role: "frontend-caller", edge: e, sameFile: true });
      }
      if (hits.length > 0) {
        hits.sort((a, b) => a.edge.from.file === b.edge.from.file ? a.edge.from.line - b.edge.from.line : a.edge.from.file.localeCompare(b.edge.from.file));
        d.bridges = hits;
        bridgeHits += hits.length;
      }
    }
  }

  const files = [...fileMap.values()].sort((a, b) => {
    if (a.minDepth !== b.minDepth) return a.minDepth - b.minDepth;
    return a.file.localeCompare(b.file);
  });

 // P0:图置信度。索引字段缺席=旧索引(未知),不得把「没记录」读成「零盲区」;
  // 字段在场且 >0 时,本次查询触达的解析错误文件单独列出(定义文件自身 + 受影响文件)。
  const errKnown = index.errorFiles !== undefined || index.errorFileCount !== undefined;
  const errSet = new Set(index.errorFiles ?? []);
  const relatedErrorFiles = files.map((f) => f.file).filter((f) => errSet.has(f));
  const graphHealth = {
    known: errKnown,
    errorFileCount: index.errorFileCount ?? (index.errorFiles?.length ?? 0),
    related: relatedErrorFiles,
  };

  return {
    query: name,
    depth,
    definitions,
    files,
    tests,
    importChannel: Boolean(importers),
    importCapable,
    testScanCapped,
    dropped,
    bridgeChannel: bridge !== null,
    graphHealth,
    truncated: truncatedBy.callers || truncatedBy.callees,
    summary: {
      directCallers,
      directCallees,
      transitiveCallers,
      transitiveCallees,
      fileCount: files.length,
      testCount: tests.length,
      ...(bridgeHits > 0 ? { bridges: bridgeHits } : {}),
    },
  };
}

// ---- 文本渲染(LLM/CLI 同源;预算封顶,截断如实标注) ----

const MAX_D1_LINES = 40; // d1 完整计数在 summary,展示行数仍要预算(hub 符号 500 调用方会炸输出)
const MAX_DEEP_LINES = 30;
const MAX_FILE_LINES = 40;
const MAX_TEST_LINES = 20;
const MAX_BRIDGE_LINES = 20; // 桥边段每方向展示帽(JSON 面完整,截断只在渲染层)

function refLine(r: ImpactRef): string {
  const loc = r.line > 0 ? `:${r.line}` : "";
  return `    (d${r.depth}) ${r.name} @ ${r.file}${loc}`;
}

/** 影响面文本(单仓;跨仓由调用方加 [repo] 头)。旧索引降级显式标注。
 * 同名多定义头进 impact 面(此前只在 symbol 面,RC-096-B5);关联测试四组分列
 * (直接/间接/跨深度/import);尾部「弃边与不可见」段恒在场。 */
export function renderImpact(r: ImpactResult): string {
  const lines: string[] = [];
  // 同名多定义头(与 mcp-core formatAmbiguityHeader 同口径;弃边明细在末节)
  if (r.definitions.length > 1) {
    lines.push(`⚠ 同名定义 ${r.definitions.length} 处(按类名前缀/文件区分,逐条列出如下;裸名调用的同名弃边见末节「弃边与不可见」):`);
    for (const d of r.definitions) lines.push(`  - ${d.symbol.name} @ ${d.symbol.file}:${d.symbol.line}`);
  }
  for (const d of r.definitions) {
    const sym = d.symbol;
    const kind = sym.kind === "trunk" ? "入口(trunk,索引内无调用方)" : sym.kind === "leaf" ? "叶子(leaf)" : "常规";
    lines.push(`改动影响面: ${sym.name} [${kind}] — ${sym.file}:${sym.line}`);
    if (d.signature) {
      lines.push(`  签名: ${sym.name}${d.signature}`);
    } else {
      lines.push("  签名: 未索引(旧格式索引——重建索引后可用: codesense index)");
    }
    if (d.callers.length === 0) {
 // (RC-096-B6):索引内无调用方≠无上游波及(弃边/动态调用可能未覆盖,见末节计量)
      lines.push("  上游调用方: 索引内无(入口形态——索引未覆盖的调用方仍可能受影响,弃边计量见末节)");
    } else {
      const d1 = d.callers.filter((x) => x.depth === 1);
      const deep = d.callers.filter((x) => x.depth > 1);
      lines.push(`  上游调用方(${d.callers.length}个,直接 ${d1.length} + 间接 ${deep.length}):`);
      lines.push(...d1.slice(0, MAX_D1_LINES).map(refLine));
      if (d1.length > MAX_D1_LINES) lines.push(`    …直接调用方还有 ${d1.length - MAX_D1_LINES} 个(计数完整,展示截断)`);
      lines.push(...deep.slice(0, MAX_DEEP_LINES).map(refLine));
      if (deep.length > MAX_DEEP_LINES) lines.push(`    …间接调用方还有 ${deep.length - MAX_DEEP_LINES} 个(计数完整,展示截断)`);
    }
    if (d.callees.length > 0) {
      const d1 = d.callees.filter((x) => x.depth === 1);
      const deep = d.callees.filter((x) => x.depth > 1);
      lines.push(`  下游依赖(${d.callees.length}个,直接 ${d1.length} + 间接 ${deep.length})——签名/行为变更需同步检查:`);
      lines.push(...d1.slice(0, MAX_D1_LINES).map(refLine));
      lines.push(...deep.slice(0, MAX_DEEP_LINES).map(refLine));
      if (d1.length + deep.length > MAX_D1_LINES + MAX_DEEP_LINES) lines.push(`    …下游还有 ${d.callees.length - MAX_D1_LINES - MAX_DEEP_LINES} 个(计数完整,展示截断)`);
    }
 // 跨语言桥边段(仅当本定义有命中时出段——零命中/旧索引零新行,输出面不回退)
    if (d.bridges && d.bridges.length > 0) {
      const asBackend = d.bridges.filter((h) => h.role === "backend-handler");
      const asFrontend = d.bridges.filter((h) => h.role === "frontend-caller");
      const confOf = (e: BridgeEdge): string => (e.confidence === "high" ? "高" : "中");
      const matchOf = (e: BridgeEdge): string => (e.match === "exact-folded" ? "exact·折叠" : e.match);
      lines.push(`  跨语言桥边(http-api,${d.bridges.length} 条;每条双端 file:line 证据):`);
      if (asBackend.length > 0) {
        lines.push(`    作为后端 handler——前端调用点(${asBackend.length}):`);
        for (const h of asBackend.slice(0, MAX_BRIDGE_LINES)) {
          const e = h.edge;
          lines.push(`      [${matchOf(e)}|${confOf(e)}] ${e.to.method} ${e.to.path} @ ${e.to.file}:${e.to.line} ← 前端 ${e.from.file}:${e.from.line} \`${e.from.literal}\`${e.from.foldedFrom ? `(折叠自 ${e.from.foldedFrom})` : ""}${h.sameFile ? "" : "(handler 名跨文件绑定)"}`);
        }
        if (asBackend.length > MAX_BRIDGE_LINES) lines.push(`      …还有 ${asBackend.length - MAX_BRIDGE_LINES} 条(计数完整,展示截断)`);
      }
      if (asFrontend.length > 0) {
        lines.push(`    作为前端调用方——触达后端端点(${asFrontend.length};归属=同文件最近前驱符号):`);
        for (const h of asFrontend.slice(0, MAX_BRIDGE_LINES)) {
          const e = h.edge;
          lines.push(`      [${matchOf(e)}|${confOf(e)}] \`${e.from.literal}\` @ ${e.from.file}:${e.from.line} → ${e.to.method} ${e.to.path}${e.to.handler ? ` → ${e.to.handler}` : ""} @ ${e.to.file}:${e.to.line}`);
        }
        if (asFrontend.length > MAX_BRIDGE_LINES) lines.push(`      …还有 ${asFrontend.length - MAX_BRIDGE_LINES} 条(计数完整,展示截断)`);
      }
    }
  }
  // 受影响文件
  const callFiles = r.files.filter((f) => f.viaCall);
  const importOnly = r.files.filter((f) => !f.viaCall);
  lines.push(`  受影响文件(${r.files.length}):`);
  lines.push(...callFiles.slice(0, MAX_FILE_LINES).map((f) => `    ${f.file}(调用通道, 最近 d${f.minDepth === Infinity ? "?" : f.minDepth})`));
  if (callFiles.length > MAX_FILE_LINES) lines.push(`    …还有 ${callFiles.length - MAX_FILE_LINES} 个文件`);
  if (importOnly.length > 0) {
    lines.push(...importOnly.slice(0, MAX_FILE_LINES).map((f) => `    ${f.file}(import 通道)`));
    if (importOnly.length > MAX_FILE_LINES) lines.push(`    …还有 ${importOnly.length - MAX_FILE_LINES} 个 import 方文件`);
  }
 // 关联测试( RC-B3:四组分列——直接/间接/跨深度/import 通道)
  if (r.tests.length === 0) {
 // 措辞纪律(096 RC-B3 注意):「建议补测试」不能再无条件出现——跨深度扫描与 import 通道
    // 都覆盖后才允许给建议,且必须带「深度外未穷尽」的诚实尾巴
    lines.push(`  关联测试: 未发现(调用闭包 ≤d${r.depth} + 跨深度延伸 ${TEST_EXTRA_DEPTH} 跳 + import 通道均无测试路径文件${r.testScanCapped ? ";跨深度扫描触发节点封顶,更深处未穷尽" : "——更深处未穷尽"};若确认无测试保护建议补测试)`);
  } else {
    const direct = r.tests.filter((t) => t.via === "call" && t.depth === 1);
    const indirect = r.tests.filter((t) => t.via === "call" && t.depth > 1 && !t.beyondDepth);
    const beyond = r.tests.filter((t) => t.beyondDepth);
    const viaImport = r.tests.filter((t) => t.via === "import");
    lines.push(`  关联测试(${r.tests.length}):直接 ${direct.length} / 间接 ${indirect.length} / 跨深度 ${beyond.length} / import 通道 ${viaImport.length}`);
    for (const t of [...direct, ...indirect, ...beyond, ...viaImport].slice(0, MAX_TEST_LINES)) {
      const tag = t.via === "import" ? "(import)" : t.beyondDepth ? `(d${t.depth},跨深度)` : `(d${t.depth})`;
      lines.push(`    ${tag} ${t.file}${t.line > 0 ? ":" + t.line : ""} — ${t.name}`);
    }
    if (r.tests.length > MAX_TEST_LINES) lines.push(`    …还有 ${r.tests.length - MAX_TEST_LINES} 个测试(计数完整,展示截断)`);
  }
  if (!r.importChannel) {
 // RC-B2:此提示现在对 Go 也真实可兑现(重建后 importers 落盘)
    lines.push("  (旧格式索引:import 通道不可用——文件/测试清单仅含调用通道;重建索引后补全: codesense index)");
  } else if (!r.importCapable && r.definitions.length > 0) {
    lines.push("  (import 通道注记: 定义文件语言暂不落 importers(python/java/c 族;TS/JS/Go 支持)——本符号的 import 通道为空属预期,调用通道不受影响)");
  }
 // P0:图置信度必须显式——缺边不能被读成「没有调用方」。旧 JSON/手工构造
  // 的 ImpactResult 可能没有该字段:按「未知」呈现,不得静默当作零盲区。
  const gh = r.graphHealth;
  if (!gh || !gh.known) {
    lines.push("  图盲区: 旧索引未记录解析错误面(重建后可按文件核对;当前「0 调用方」不得视为可安全删除)");
  } else if (gh.errorFileCount > 0) {
    const rel = gh.related;
    if (rel.length > 0) {
      lines.push(`  图盲区: 本符号触点含 ${rel.length} 个解析错误文件(${rel.slice(0, 5).join(", ")}${rel.length > 5 ? " …" : ""})——调用面可能不完整,不能仅凭 0 调用方判定可删除/可改签名`);
    } else if (r.summary.directCallers + r.summary.transitiveCallers === 0) {
      lines.push(`  图盲区: 全仓 ${gh.errorFileCount} 个文件解析含语法错误(本符号未直接触达)——0 调用方仍可能漏,删改前建议核对错误文件`);
    } else {
      lines.push(`  图盲区: 全仓 ${gh.errorFileCount} 个文件解析含语法错误(本符号触点 0)——已找到的调用面可用,仍可能有遗漏`);
    }
  }
 // 弃边与不可见( RC-B5,恒在场:「弃了边」对用户透明是 096 has_access 锚的注意缺口)
  {
    const dp = r.dropped;
    const bits: string[] = [];
    if (dp.ledger) {
      const reasons = Object.entries(dp.ledger.reasons).map(([k, v]) => `${k} ×${v}`).join("; ");
      const samples = dp.ledger.samples.map((s) => `${s.file}:${s.line}`).join(", ");
      bits.push(`同名调用候选构建期被弃 ${dp.ledger.count} 处(${reasons})${samples ? `;样本: ${samples}` : ""}`);
    } else if (!dp.ledgerAvailable) {
      bits.push("构建期弃边台账=旧索引无此字段(重建后可查: codesense index)");
    }
    if (dp.unresolvedEdges > 0) {
      bits.push(`索引内未解析边 ${dp.unresolvedEdges} 处(发射了但目标未解析:动态形态/无类型证据/自归属盲区,edges 中标 unresolved)`);
    }
    const body = bits.length > 0 ? bits.join(";") : "无记录(该名称无构建期弃边,索引内未解析边 0 处)";
    lines.push(`  弃边与不可见: ${body}${dp.ledgerTruncated ? "(台账名字数超落盘封顶 300,计数未含全部)" : ""}`);
  }
  const s = r.summary;
  lines.push(`  汇总: 直接调用方 ${s.directCallers} | 间接调用方 ${s.transitiveCallers} | 下游 ${s.directCallees}+${s.transitiveCallees} | 受影响文件 ${s.fileCount} | 关联测试 ${s.testCount}${s.bridges ? ` | 跨语言桥边 ${s.bridges}` : ""}${r.truncated ? " | 闭包深层每层 24 条封顶已截断" : ""}`);
  return lines.join("\n");
}
