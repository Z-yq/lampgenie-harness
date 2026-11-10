/**
 * sensing/crosslang-bridge( /):跨语言桥边——HTTP api 桥原型。
 * 把 bridge.mjs 的「前后端路径对账计数」升级为「桥边」一等数据结构:
 * 每条边 = 前端调用点(file:line + 字面量) → 后端路由(file:line + method + handler),
 * 带 kind="bridge" / confidence / tier×evidence 双诚实轴标注( v8)。
 * 配对语义与 bridge.mjs 全等(段级通配规范化 + 同文件 const 折叠),per-endpoint exact
 * 覆盖率可与 /100 的桥证据逐仓对账(grafana 360/523 等为回归基线)。
 * 防幻觉红线:
 *  ① 双端证据行(前端 file:line + 后端 file:line)齐备才出边;
 *  ② exact/exact-folded 才进正式边;first2 = candidates 区(medium),1 段前缀命中只聚合
 *     计数(low,不出边)——低置信不混入确定性边清单;
 *  ③ 折叠字面量 match="exact-folded" 独立标注,不冒充原生字面量;
 *  ④ C 档形态(运行时反射/动态注册/中间件改写/数据流派发)只登记 knownLimits,不产边。
 * ⑤ :LLM 消歧候选区独立导出(matchBridgeCandidates/queryBridgeCandidates/
 *     includeCandidates)——tier=semantic、带双端证据链,确定性边整体排除,两区不混。
 * 本模块是 http-api 的纯消费方(extractApiSurface/queryApiSurface 零改动),不修改任何
 * 既有 sensing 文件;桥边不进 c2f 索引(独立数据结构+查询面,入索引另立项)。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { queryApiSurface } from "./index";
import { reconcileForRoot, specFingerprint } from "./openapi";
import { normalizePath } from "./http-api";
// 路径口径共享模块(path-filter.ts 单一真相):前端字面量若来自 docs/examples/tutorial/
// mocks/fixtures/testdata/bench 段或 .md 文档,不作前端证据。
import { isNonProductEvidencePath, nonProductFilterNote } from "../path-filter";
import type { ApiEndpoint } from "./http-api";

const execFileP = promisify(execFile);

// ============================ 数据结构 ============================

export interface BridgeEdgeFrom {
  side: "frontend";
  file: string;            // 仓内相对路径
  line: number;            // 证据行
  literal: string;         // 参与配对的字面量(折叠后)
  foldedFrom?: string;     // 折叠前原文(exact-folded 时)或 `const NAME`(常量值形态)
}

export interface BridgeEdgeTo {
  side: "backend";
  file: string;
  line: number;
  method: string;
  path: string;
  handler?: string;
  framework: string;
  prefixInferred?: boolean;
}

export interface BridgeEdge {
  kind: "bridge";
  bridge: "http-api";                 // 连接器形态(A2-A6 扩展位, §4)
  from: BridgeEdgeFrom;
  to: BridgeEdgeTo;
  match: "exact" | "exact-folded";
  confidence: "high" | "medium";      // prefixInferred 端点降一档(§3.3)
  tier: "structural";
  evidence: "grep";
  note?: string;
}

export interface BridgeCandidate {
  from: BridgeEdgeFrom;
  to: BridgeEdgeTo;
  match: "first2";
  confidence: "medium" | "low";
  note?: string;
}

/** LLM 消歧候选:候选区独立数据结构,与确定性 BridgeEdge 严格分离。
 * 语义 = 前端 file:line+literal ↔ 后端 file:line+method+handler,附 reason + 双端 evidence 链;
 * tier=semantic 表示「语义层待消歧」——不入索引、不进 edges、不冒充 grep 证据。
 * 形态:first2(前 2 段一致,medium/low)与 prefix1(仅首段一致,low,需显式开启)。 */
export interface BridgeSemanticCandidate {
  kind: "bridge-candidate";
  bridge: "http-api";
  tier: "semantic";
  from: BridgeEdgeFrom;
  to: BridgeEdgeTo;
  match: "first2" | "prefix1";
  confidence: "medium" | "low";
  /** 为什么只是候选(不满足 exact 的哪条:段数/尾段/可信度)。 */
  reason: string;
  /** 双端证据链:前端证据 → 后端证据 → 配对差异 → 置信度。 */
  evidence: string[];
}

export interface BridgeCandidateStats {
  endpoints: number;
  /** 已有确定性 exact 边、不产候选的端点数。 */
  endpointsExact: number;
  /** 参与候选判定的端点数(= endpoints - endpointsExact)。 */
  endpointsConsidered: number;
  first2: number;
  prefix1: number;
  candidates: number;
  /** 候选帽截断数(判定不受帽影响,计数如实)。 */
  capped: number;
  /** 无候选的端点数(前 2 段/前缀均不匹配或可信度闸拦截)。 */
  unmatchedEndpoints: number;
}

export interface BridgeCandidateSurface {
  state: BridgeSurface["state"];
  candidates: BridgeSemanticCandidate[];
  stats: BridgeCandidateStats;
  /** 确定性 exact 配对数(未截断口径;候选区恒不含它们——消费方可直接断言不混)。 */
  deterministicEdges: number;
  truncated: string[];
  knownLimits: string[];
  pathFilter?: { filtered: number; note: string };
  degraded?: { reason: string };
}

export interface BridgeStats {
  endpoints: number;
  frameworks: string[];
  frontendFiles: number;              // 字面量命中文件数
  literalOccurrences: number;         // 原生字面量命中点数(过滤后)
  literalsUnique: number;
  foldedLiterals: number;
  edges: number;
  candidates: number;
  /** per-endpoint 覆盖(与 bridge.mjs exact/partial 同口径,可逐仓对账):
   * exactUnion = 有 ≥1 条 exact(原生或折叠)命中的端点数。 */
  endpointsExactNative: number;
  endpointsExactFolded: number;
  endpointsExactUnion: number;
  endpointsFirst2Only: number;        // 仅 first2 档命中(≈ bridge.mjs partial)
  endpointsUnmatched: number;
  /** 1 段前缀命中(如字面量 "/api" 撞上 /api/** 族)——只计数不出边(low 档噪声闸)。 */
  prefix1segHits: number;
}

export interface BridgeSurface {
  state: "bridge-connected" | "bridge-partial" | "no-endpoints" | "no-frontend" | "no-match";
  edges: BridgeEdge[];
  candidates: BridgeCandidate[];
  stats: BridgeStats;
  /** 无前端字面量命中的端点(截断清单;全量数在 stats.endpointsUnmatched)。 */
  unmatchedEndpoints: { method: string; path: string; file: string; line: number }[];
  /** 未参与任何配对的前端字面量数(词法全量扫描含非 fetch 语境,如实计数不猜语义)。 */
  unmatchedLiteralCount: number;
  truncated: string[];                // 各帽命中登记(哪一项被截断)
 /** C 档形态登记( §6):静态不可行,永不产边。 */
  knownLimits: string[];
 /** 非产品路径过滤呈报:filtered=被丢弃的前端字面量条数,docs/examples/
   * tutorial/mocks 下的「前端调用」不再算桥边证据;缺席=零过滤。 */
  pathFilter?: { filtered: number; note: string };
  degraded?: { reason: string };
 /** (includeCandidates=true 才在场):LLM 消歧候选区,与 edges 严格分离。
   * 缺省不产出 → 既有 JSON/文本输出逐字节兼容。 */
  semanticCandidates?: BridgeSemanticCandidate[];
  semanticCandidateStats?: BridgeCandidateStats;
}

const KNOWN_LIMITS = [
  "C1 运行时反射/循环注册(如 for bp in […]: register(bp))——注册源是运行时列表值,静态不可见,不产边",
  "C2 中间件/装饰器运行时改写路由表——最终路由是运行时组合,不产边",
  "C3 动态拼接的通道名/路径(字面量不在源码中)——不产边",
  "C4 运行时数据流派发(dispatch 表运行时装填)——静态只见表结构,不产边",
];

// ============================ 前端字面量收集 ============================

/** 路径形字面量模式(与 bridge.mjs 同口径):引号/反引号紧跟 / 开头的串。 */
const LIT_PATTERN = "[\"'`]/[A-Za-z0-9_][A-Za-z0-9_\\-./:{}$]*";

let rgAvailable: boolean | null = null;
async function haveRg(): Promise<boolean> {
  if (rgAvailable !== null) return rgAvailable;
  try { await execFileP("rg", ["--version"]); rgAvailable = true; } catch { rgAvailable = false; }
  return rgAvailable;
}

interface FeLiteral {
  raw: string;
  file: string;
  line: number;
  folded: boolean;
  foldedFrom?: string;
}

/** 资源扩展名噪声(bridge.mjs 同款过滤)。 */
const ASSET_EXT_RE = /\.(png|jpg|svg|css|ico|woff|md|json|html|txt|lock|toml|yaml|yml)$/i;

function literalOk(t: string): boolean {
  if (!t || t.length < 2) return false;
  if (!/[A-Za-z]/.test(t)) return false;             // 滤掉 "/2" 类纯数字
  if (ASSET_EXT_RE.test(t)) return false;
  return true;
}

/** 至少含一个「非纯 ${...} 通配」的段(全通配串是噪声,会吸走任意单段端点)。 */
function hasLiteralSeg(v: string): boolean {
  return v.split("/").some((seg) => seg && !/^\$\{.*\}$/.test(seg) && /[A-Za-z]/.test(seg));
}

interface ConstDef { value: string; line: number }

/** 同模块 const/let/var 单行字符串/模板定义(bridge.mjs constDefsOf 移植,+行号)。 */
function constDefsOf(text: string, offs: number[]): Map<string, ConstDef> {
  const defs = new Map<string, ConstDef>();
  const re = /(?:^|\n)[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;\n]+)?=[ \t]*(['"`])((?:\\.|(?!\2)[^\\\n])*)\2/g;
  for (const m of text.matchAll(re)) {
    defs.set(m[1]!, { value: m[3]!, line: lineAt(offs, m.index ?? 0) });
  }
  return defs;
}

/** ${IDENT} 是同文件 const → 递归内联(深 5;解析不掉的 ${…} 原样保留,环无害=幂等替换)。 */
function foldConstRefs(text: string, defs: Map<string, ConstDef>, depth = 0): string {
  if (depth > 5) return text;
  return text.replace(/\$\{([A-Za-z_$][\w$]*)\}/g, (whole, id: string) => {
    const v = defs.get(id);
    return v === undefined ? whole : foldConstRefs(v.value, defs, depth + 1);
  });
}

function lineOffsets(text: string): number[] {
  const offs = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") offs.push(i + 1);
  return offs;
}
function lineAt(offs: number[], idx: number): number {
  let lo = 0, hi = offs.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (offs[mid]! <= idx) lo = mid; else hi = mid - 1; }
  return lo + 1;
}

const FRONTEND_EXTS_DEFAULT = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "vue"];
const MAX_LITERALS = 9000;
const MAX_FOLD_FILES = 2000;

/** 前端路径字面量收集:rg -o -n 带行号(bridge.mjs 无行号,桥边的证据行即此处增量)。
 * 导出供探针/审计脚本复用(queryBridgeEdges 内部同一入口,语义单一出处)。
 * 非产品路径过滤:poly-grafana 的 public/test/mocks/** 与 docs/** 里出现的前端
 * 路径字面量不是「这个前端真的在调后端」的证据——按文件路径在收集期直接丢弃,并如实统计
 * 被丢弃的「字面量条数」(filtered.literals),调用方据此输出过滤注记,不得静默清零。
 * opts.all=true 原样放行(逃生口);该参数为可选第四参,不改变既有三参调用面。 */
export async function collectFrontendLiterals(
  root: string,
  exts: string[],
  truncated: string[],
  opts?: { all?: boolean },
): Promise<{ literals: FeLiteral[]; files: number; filtered?: { literals: number; note: string } } | null> {
  let stdout = "";
  if (await haveRg()) {
    try {
      const r = await execFileP("rg", [
        "-o", "-n", "--no-heading", "--no-messages",
        ...exts.flatMap((e) => ["-g", `*.${e}`]),
        "-e", LIT_PATTERN, "--", root,
      ], { maxBuffer: 64 * 1024 * 1024 });
      stdout = r.stdout;
    } catch (e) {
      if ((e as { code?: number }).code !== 1) throw e; // 1=零命中
    }
  } else {
    // 兜底:grep -P(ugrep/ GNU grep;不支持 PCRE 的环境=显式降级)
    try {
      const r = await execFileP("grep", [
        "-rPon", "--no-messages",
        ...exts.map((e) => `--include=*.${e}`),
        "-e", LIT_PATTERN, "--", root,
      ], { maxBuffer: 64 * 1024 * 1024 });
      stdout = r.stdout;
    } catch (e) {
      if ((e as { code?: number }).code === 1) stdout = "";
      else return null; // 无 PCRE → degraded
    }
  }
  const seen = new Set<string>();
  const byFile = new Map<string, FeLiteral[]>();
  const literals: FeLiteral[] = [];
  // 非产品路径过滤统计(docs/examples/tutorial/mocks/fixtures/testdata/bench 段 + .md 等文档)
  const filteredSamples: string[] = [];
  let filteredLiterals = 0;
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
    const m = /^(.*):(\d+):(.*)$/.exec(clean);
    if (!m) continue;
    const file = m[1]!.startsWith(root) ? m[1]!.slice(root.length).replace(/^\//, "") : m[1]!;
    const raw = m[3]!.replace(/^["'`]/, "").trim();
    if (!literalOk(raw)) continue;
    const key = `${file}:${m[2]}:${raw}`;
    if (seen.has(key)) continue;
    seen.add(key);
 // 非产品路径文件里的字面量不作为前端证据(grafana public/test/mocks/** 注意);
 // 测试文件同样不作前端证据(owncast 的 test/automated/** 前端 fixture 曾
    // 混进「正式边」而注记里却说已过滤——rg 只按扩展名扫,isNonProductPath 不认 test/ 段,
    // 滤网与注记不同源)。丢弃但计数——调用方输出「已过滤 N 条」,不静默清零。
    if (!opts?.all && isNonProductEvidencePath(file)) {
      filteredLiterals++;
      if (filteredSamples.length < 3 && !filteredSamples.includes(file)) filteredSamples.push(file);
      continue;
    }
    const lit: FeLiteral = { raw, file, line: Number(m[2]), folded: false };
    literals.push(lit);
    const arr = byFile.get(file) ?? [];
    arr.push(lit);
    byFile.set(file, arr);
    if (literals.length >= MAX_LITERALS) { truncated.push(`literals@${MAX_LITERALS}`); break; }
  }

 // 同文件 const 折叠( RC-N 通道移植):字面量里的 ${CONST} 内联 + const 路径值本身入账
  let filesRead = 0;
  const uniqueNative = new Set(literals.map((l) => l.raw));
  for (const [file, lits] of byFile) {
    if (filesRead >= MAX_FOLD_FILES) { truncated.push(`foldFiles@${MAX_FOLD_FILES}`); break; }
    let text: string;
    try { text = await readFile(join(root, file), "utf8"); filesRead++; } catch { continue; }
    const offs = lineOffsets(text);
    const defs = constDefsOf(text, offs);
    if (defs.size === 0) continue;
    for (const lit of lits) {
      if (!/\$\{[A-Za-z_$][\w$]*\}/.test(lit.raw)) continue;
      const foldedLit = foldConstRefs(lit.raw, defs);
      if (foldedLit !== lit.raw && !uniqueNative.has(foldedLit) && hasLiteralSeg(foldedLit) && literalOk(foldedLit)) {
        uniqueNative.add(foldedLit);
        literals.push({ raw: foldedLit, file: lit.file, line: lit.line, folded: true, foldedFrom: lit.raw });
      }
    }
    for (const [name, def] of defs) {
      const v = foldConstRefs(def.value, defs);
      if (v.length >= 2 && /^[$/]/.test(v) && /[A-Za-z]/.test(v) && !/\s/.test(v)
        && hasLiteralSeg(v) && !uniqueNative.has(v) && literalOk(v)) {
        uniqueNative.add(v);
        literals.push({ raw: v, file, line: def.line, folded: true, foldedFrom: `const ${name}` });
      }
    }
  }
  return {
    literals,
    files: byFile.size,
    // filtered:被丢弃的非产品路径字面量条数(0 时不给注记,但结构里仍如实带 0)
    ...(filteredLiterals > 0
      ? { filtered: { literals: filteredLiterals, note: nonProductFilterNote(filteredLiterals, filteredSamples, { all: opts?.all }) } }
      : {}),
  };
}

// ============================ 段级规范化与配对(bridge.mjs 语义移植) ============================

function normSegments(p: string): string[] {
  return p.split("/").filter(Boolean).map((seg) => {
    if (/^\{.*\}$/.test(seg) || /^:.+/.test(seg) || /^\$\{.*\}$/.test(seg)) return "*";
    return seg.toLowerCase();
  });
}
function segMatch(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((s, i) => s === "*" || b[i] === "*" || s === b[i]);
}
/** 配对可信度闸(防幻觉):除段级通配配对成立外,要求至少一段「双侧实体且相等」——
 * 否则纯通配互吸出假边(grafana 注意:折叠字面量 "${k8sGroup}/v0alpha1"(首段未解析)
 * 通配配对上 GET /login/:name——login 与 k8sGroup 毫无关系)。 */
function segMatchCredible(a: string[], b: string[]): boolean {
  if (!segMatch(a, b)) return false;
  return a.some((s, i) => s !== "*" && b[i] !== "*" && s === b[i]);
}

const MAX_EDGES_PER_ENDPOINT = 25;
const MAX_EDGES = 6000;
const MAX_CANDIDATES = 300;
const MAX_UNMATCHED_LIST = 50;

interface LitIndexed extends FeLiteral { segs: string[] }

function bridgeToOf(ep: ApiEndpoint): BridgeEdgeTo {
  return {
    side: "backend", file: ep.file, line: ep.line, method: ep.method, path: ep.path,
    ...(ep.handler ? { handler: ep.handler } : {}), framework: ep.framework,
    ...(ep.prefixInferred ? { prefixInferred: true } : {}),
  };
}

function bridgeFromOf(l: FeLiteral): BridgeEdgeFrom {
  return {
    side: "frontend", file: l.file, line: l.line, literal: l.raw,
    ...(l.foldedFrom ? { foldedFrom: l.foldedFrom } : {}),
  };
}

/** 端点×字面量配对(纯函数,fixture 可单测)。
 * opts.credibilityGate 缺省 true(可信闸:≥1 段双实体相等);显式 false=bridge.mjs 旧语义
 * (纯通配配对)——仅供对账/审计脚本量化闸门代价,生产路径不得关闭。 */
export function matchBridgeEdges(
  endpoints: ApiEndpoint[],
  literals: FeLiteral[],
  opts?: { credibilityGate?: boolean },
): Pick<BridgeSurface, "edges" | "candidates" | "stats" | "unmatchedEndpoints" | "unmatchedLiteralCount" | "truncated"> {
  const gate = opts?.credibilityGate !== false;
  const exactHit = (a: string[], b: string[]) => (gate ? segMatchCredible(a, b) : segMatch(a, b));
  const truncated: string[] = [];
  const lits: LitIndexed[] = literals.map((l) => ({ ...l, segs: normSegments(l.raw.split("?")[0] ?? "") }));
  const edges: BridgeEdge[] = [];
  const candidates: BridgeCandidate[] = [];
  const usedLit = new Set<LitIndexed>();
  const epExactNative = new Set<number>();
  const epExactFolded = new Set<number>();
  const epFirst2 = new Set<number>();
  let prefix1segHits = 0;
  const unmatched: BridgeSurface["unmatchedEndpoints"] = [];

  for (let ei = 0; ei < endpoints.length; ei++) {
    const ep = endpoints[ei]!;
    const segsB = normSegments((ep.path ?? "").split("?")[0] ?? "");
    if (segsB.length === 0) continue;
    let perEp = 0;
    let anyExact = false;
    // exact 档(原生优先,折叠次之——顺序即置信序)
    for (const wantFolded of [false, true]) {
      for (const l of lits) {
        if (l.folded !== wantFolded || !exactHit(segsB, l.segs)) continue;
        if (perEp >= MAX_EDGES_PER_ENDPOINT) { truncated.push(`edgesPerEndpoint@${MAX_EDGES_PER_ENDPOINT}(${ep.method} ${ep.path})`); break; }
        if (edges.length >= MAX_EDGES) { truncated.push(`edges@${MAX_EDGES}`); break; }
        const downgrade = ep.prefixInferred;
        edges.push({
          kind: "bridge", bridge: "http-api",
          from: bridgeFromOf(l), to: bridgeToOf(ep),
          match: wantFolded ? "exact-folded" : "exact",
          confidence: downgrade ? "medium" : "high",
          tier: "structural", evidence: "grep",
          note: [
            wantFolded ? "前端字面量经同文件 const 折叠(确定性替换,非原生字面量)" : "",
            downgrade ? "后端路径含未解析前缀(prefixInferred),置信度降一档" : "",
          ].filter(Boolean).join(";") || undefined,
        });
        usedLit.add(l);
        (wantFolded ? epExactFolded : epExactNative).add(ei);
        anyExact = true;
        perEp++;
      }
    }
    if (anyExact) continue;
    if (edges.length >= MAX_EDGES) break; // 总帽命中即停(后续端点只会反复撞帽)
    // first2 档(候选区,medium)——命中判定与候选清单截断解耦:帽满只停记录,不停判定,
 // 否则 endpointsFirst2Only/unmatched 统计被帽污染(grafana 验证 61 vs 107 假缺口)。
    let perEpCand = 0;
    let hasFirst2 = false;
    for (const l of lits) {
      if (l.segs.length < 2 || segsB.length < 2) continue;
      const first2 = l.segs.slice(0, 2);
      if (!first2.every((s, i) => s === "*" || segsB[i] === "*" || s === segsB[i])) continue;
      // 同可信度闸:前两段内至少一段双实体相等,否则通配互吸(first2 档的假阳性同族)
      if (gate && !first2.some((s, i) => s !== "*" && segsB[i] !== "*" && s === segsB[i])) continue;
      hasFirst2 = true;
      usedLit.add(l);
      if (candidates.length >= MAX_CANDIDATES) { if (!truncated.some((t) => t.startsWith("candidates@"))) truncated.push(`candidates@${MAX_CANDIDATES}`); continue; }
      if (perEpCand >= 5) continue; // 单端点候选帽(候选区不追求穷举;判定不受帽影响)
      candidates.push({
        from: bridgeFromOf(l), to: bridgeToOf(ep), match: "first2",
        confidence: ep.prefixInferred ? "low" : "medium",
        note: "前 2 段一致的部分配对(非全路径),低置信候选——未入正式边",
      });
      perEpCand++;
    }
    if (hasFirst2) { epFirst2.add(ei); continue; }
    // 1 段前缀档:只计数(baseURL 类字面量如 "/api" 撞 /api/** 族,出边即噪声洪泛)
    for (const l of lits) {
      if (l.segs.length === 1 && segsB[0] !== "*" && l.segs[0] === segsB[0]) { prefix1segHits++; usedLit.add(l); break; }
    }
    // 走到这里 = exact/first2 均未命中(exact 已 continue、first2 已 continue)
    if (unmatched.length < MAX_UNMATCHED_LIST) {
      unmatched.push({ method: ep.method, path: ep.path, file: ep.file, line: ep.line });
    }
  }

  const unmatchedCount = endpoints.filter((_, ei) =>
    !epExactNative.has(ei) && !epExactFolded.has(ei) && !epFirst2.has(ei)).length;
  const epExactUnion = new Set([...epExactNative, ...epExactFolded]).size;

  return {
    edges, candidates, truncated,
    unmatchedEndpoints: unmatched,
    unmatchedLiteralCount: lits.filter((l) => !usedLit.has(l)).length,
    stats: {
      endpoints: endpoints.length,
      frameworks: [...new Set(endpoints.map((e) => e.framework))],
      frontendFiles: 0, // 调用方回填
      literalOccurrences: literals.filter((l) => !l.folded).length,
      literalsUnique: new Set(literals.map((l) => l.raw)).size,
      foldedLiterals: literals.filter((l) => l.folded).length,
      edges: edges.length,
      candidates: candidates.length,
      endpointsExactNative: epExactNative.size,
      endpointsExactFolded: epExactFolded.size,
      endpointsExactUnion: epExactUnion,
      endpointsFirst2Only: epFirst2.size,
      endpointsUnmatched: unmatchedCount,
      prefix1segHits,
    },
  };
}

// ============================ 查询主入口 ============================

/**
 * LLM 消歧候选区(纯函数,fixture 可单测;2026-10-25)。
 * 与 matchBridgeEdges 的 candidates 区别:此处是**独立导出数据结构**(tier=semantic),
 * 每条候选带 reason+双端 evidence 链,且**已有确定性 exact 边的端点整体排除**(不与确定性边混)。
 * 口径:
 * - 端点先做 exact 判定(原生/折叠,同可信度闸)——命中即不进候选区(deterministicEdges 计数);
 * - 幸存端点做前 2 段配对(first2,medium;prefixInferred→low);
 * - includePrefix1=true 时,前 2 段无命中的端点再收 1 段前缀(low,高噪声,显式开关)。
 * - 每端点帽 5(first2)/3(prefix1),全局帽 MAX_CANDIDATES;帽只停记录不停判定(计数如实)。
 */
export function matchBridgeCandidates(
  endpoints: ApiEndpoint[],
  literals: FeLiteral[],
  opts?: { credibilityGate?: boolean; includePrefix1?: boolean },
): { candidates: BridgeSemanticCandidate[]; stats: BridgeCandidateStats; truncated: string[]; deterministicEdges: number } {
  const gate = opts?.credibilityGate !== false;
  const includePrefix1 = opts?.includePrefix1 === true;
  const truncated: string[] = [];
  const lits: LitIndexed[] = literals.map((l) => ({ ...l, segs: normSegments(l.raw.split("?")[0] ?? "") }));
  const candidates: BridgeSemanticCandidate[] = [];
  const exactHit = (a: string[], b: string[]) => (gate ? segMatchCredible(a, b) : segMatch(a, b));
  let endpointsExact = 0;
  let deterministicEdges = 0;
  const considered: { ep: ApiEndpoint; segsB: string[] }[] = [];
  for (const ep of endpoints) {
    const segsB = normSegments((ep.path ?? "").split("?")[0] ?? "");
    if (segsB.length === 0) continue;
    let exact = false;
    for (const l of lits) {
      if (!exactHit(segsB, l.segs)) continue;
      exact = true;
      deterministicEdges++;
    }
    if (exact) {
      endpointsExact++;
      continue;
    }
    considered.push({ ep, segsB });
  }

  let first2 = 0;
  let prefix1 = 0;
  let capped = 0;
  let unmatched = 0;
  const FULL_DIFF = (segsL: string[], segsB: string[]): string =>
    segsL.length !== segsB.length
      ? `段数 ${segsL.length}≠${segsB.length}`
      : "尾段不等";
  const mk = (l: LitIndexed, ep: ApiEndpoint, segsB: string[], match: "first2" | "prefix1", confidence: "medium" | "low"): BridgeSemanticCandidate => {
    const n = match === "first2" ? 2 : 1;
    const matchedPart = l.segs.slice(0, n).map((s, i) => `${i + 1}:${s}`).join(" ");
    const epPart = segsB.slice(0, n).map((s, i) => `${i + 1}:${s}`).join(" ");
    const reason = match === "first2"
      ? `前 2 段一致的部分配对(非全路径):${FULL_DIFF(l.segs, segsB)}`
      : "仅首段一致的单段前缀(高噪声:baseURL 类字面量),未达前 2 段门槛";
    const evidence = [
      `前端证据: ${l.file}:${l.line} 字面量 \`${l.raw}\`${l.foldedFrom ? `(折叠自 ${l.foldedFrom})` : ""} → 规范化段 [${l.segs.join("/")}]`,
      `后端证据: ${ep.file}:${ep.line} ${ep.method} ${ep.path}${ep.handler ? ` → ${ep.handler}` : ""} [${ep.framework}] → 规范化段 [${segsB.join("/")}]`,
      match === "first2"
        ? `配对: 前 2 段一致(${matchedPart} ↔ ${epPart});${FULL_DIFF(l.segs, segsB)} → 非 exact`
        : `配对: 仅首段一致(${matchedPart} ↔ ${epPart});单段证据不足 → 非 exact`,
      `置信度: ${confidence}${ep.prefixInferred ? "(后端路径含未解析前缀 prefixInferred,降一档)" : ""};tier=semantic(LLM 消歧候选,未入确定性边)`,
    ];
    return {
      kind: "bridge-candidate", bridge: "http-api", tier: "semantic",
      from: bridgeFromOf(l), to: bridgeToOf(ep),
      match, confidence, reason, evidence,
    };
  };

  for (const { ep, segsB } of considered) {
    let perEp = 0;
    let matchedAny = false;
    for (const l of lits) {
      if (l.segs.length < 2 || segsB.length < 2) continue;
      const firstSegs = l.segs.slice(0, 2);
      if (!firstSegs.every((s, i) => s === "*" || segsB[i] === "*" || s === segsB[i])) continue;
      if (gate && !firstSegs.some((s, i) => s !== "*" && segsB[i] !== "*" && s === segsB[i])) continue;
      matchedAny = true;
      if (perEp >= 5 || candidates.length >= MAX_CANDIDATES) {
        capped++;
        continue;
      }
      candidates.push(mk(l, ep, segsB, "first2", ep.prefixInferred ? "low" : "medium"));
      first2++;
      perEp++;
    }
    if (matchedAny) continue;
    if (includePrefix1) {
      let perPrefix = 0;
      for (const l of lits) {
        if (l.segs.length !== 1) continue;
        const s0 = l.segs[0]!;
        if (s0 === "*" || segsB[0] === "*" || s0 !== segsB[0]) continue;
        matchedAny = true;
        if (perPrefix >= 3 || candidates.length >= MAX_CANDIDATES) {
          capped++;
          continue;
        }
        candidates.push(mk(l, ep, segsB, "prefix1", "low"));
        prefix1++;
        perPrefix++;
      }
    }
    if (!matchedAny) unmatched++;
  }
  if (capped > 0) truncated.push(`semanticCandidates capped=${capped}`);
  return {
    candidates,
    stats: {
      endpoints: endpoints.length,
      endpointsExact,
      endpointsConsidered: considered.length,
      first2,
      prefix1,
      candidates: candidates.length,
      capped,
      unmatchedEndpoints: unmatched,
    },
    truncated,
    deterministicEdges,
  };
}

export interface QueryBridgeOptions {
  /** 前端扩展名(缺省 ts/tsx/js/jsx/mjs/cjs/vue)。 */
  frontendExts?: string[];
  refresh?: boolean;
  /** true=不做非产品路径过滤(docs/examples/tutorial/mocks 下前端字面量与后端端点都放行;
   * 逃生口,缺省 false=过滤)。 */
  all?: boolean;
 /** :同时产出 LLM 消歧候选区(semanticCandidates;缺省不产出,输出与既有逐字节兼容)。 */
  includeCandidates?: boolean;
  /** 候选区口径:first2(缺省)=仅前 2 段;all=追加 1 段前缀(low)。 */
  candidateMode?: "first2" | "all";
}

/**
 * 桥边查询:后端端点(queryApiSurface 复用,withImpact=false 不读索引)+ 前端字面量
 * (rg 行扫描)→ 段级规范化配对 → 桥边清单。索引缺席不影响(纯行扫描链)。
 * opts.includeCandidates=true 时同一趟扫描附带 LLM 消歧候选区(不与 edges 混)。
 */
export async function queryBridgeEdges(root: string, opts?: QueryBridgeOptions): Promise<BridgeSurface> {
  const truncated: string[] = [];
  // 后端端点同样过非产品路径闸(all 透传给 queryApiSurface:桥的两端口径必须一致)
  const api = await queryApiSurface(root, { withImpact: false, refresh: opts?.refresh, ...(opts?.all ? { all: true } : {}) });
  const endpoints = api.endpoints;

  const fe = await collectFrontendLiterals(root, opts?.frontendExts ?? FRONTEND_EXTS_DEFAULT, truncated, { all: opts?.all });
  // 过滤呈报:filtered=被丢弃的前端字面量条数(note 非空即输出;过滤后零边也照报)
  const pathFilter = fe?.filtered && fe.filtered.note
    ? { filtered: fe.filtered.literals, note: fe.filtered.note }
    : undefined;
  const emptyCandidateFields = (): Pick<BridgeSurface, "semanticCandidates" | "semanticCandidateStats"> =>
    opts?.includeCandidates
      ? { semanticCandidates: [], semanticCandidateStats: emptyCandidateStats(endpoints.length) }
      : {};
  if (fe === null) {
    return {
      state: endpoints.length ? "no-frontend" : "no-endpoints",
      edges: [], candidates: [], unmatchedEndpoints: [], unmatchedLiteralCount: 0,
      truncated, knownLimits: KNOWN_LIMITS,
      stats: emptyStats(endpoints),
      ...(pathFilter ? { pathFilter } : {}),
      degraded: { reason: "前端字面量收集降级:无 rg 且系统 grep 不支持 -P(PCRE)" },
      ...emptyCandidateFields(),
    };
  }
  if (endpoints.length === 0) {
    return {
      state: "no-endpoints", edges: [], candidates: [], unmatchedEndpoints: [],
      unmatchedLiteralCount: fe.literals.length, truncated, knownLimits: KNOWN_LIMITS,
      ...(pathFilter ? { pathFilter } : {}),
      stats: { ...emptyStats(endpoints), frontendFiles: fe.files, literalOccurrences: fe.literals.filter((l) => !l.folded).length, foldedLiterals: fe.literals.filter((l) => l.folded).length, literalsUnique: new Set(fe.literals.map((l) => l.raw)).size },
      ...emptyCandidateFields(),
    };
  }

  const matched = matchBridgeEdges(endpoints, fe.literals);
  matched.stats.frontendFiles = fe.files;
  const semantic = opts?.includeCandidates
    ? matchBridgeCandidates(endpoints, fe.literals, { includePrefix1: opts.candidateMode === "all" })
    : undefined;
  const allTruncated = [...truncated, ...matched.truncated, ...(semantic?.truncated ?? [])];
  const state: BridgeSurface["state"] =
    matched.stats.endpointsExactUnion > 0 ? "bridge-connected"
      : matched.stats.endpointsFirst2Only > 0 ? "bridge-partial"
        : fe.literals.length > 0 ? "no-match" // 有前端字面量但零配对(如统一走代理),不是「无前端」
          : "no-frontend";
  return {
    state,
    edges: matched.edges,
    candidates: matched.candidates,
    stats: matched.stats,
    unmatchedEndpoints: matched.unmatchedEndpoints,
    unmatchedLiteralCount: matched.unmatchedLiteralCount,
    truncated: [...new Set(allTruncated)],
    knownLimits: KNOWN_LIMITS,
    ...(pathFilter ? { pathFilter } : {}),
    ...(semantic
      ? { semanticCandidates: semantic.candidates, semanticCandidateStats: semantic.stats }
      : {}),
  };
}

function emptyCandidateStats(endpoints: number): BridgeCandidateStats {
  return {
    endpoints,
    endpointsExact: 0,
    endpointsConsidered: endpoints,
    first2: 0,
    prefix1: 0,
    candidates: 0,
    capped: 0,
    unmatchedEndpoints: endpoints,
  };
}

/** BridgeSurface → 候选区视图(CLI 与 queryBridgeCandidates 共用;不重新扫描)。 */
export function bridgeCandidateSurfaceOf(r: BridgeSurface): BridgeCandidateSurface {
  return {
    state: r.state,
    candidates: r.semanticCandidates ?? [],
    stats: r.semanticCandidateStats ?? emptyCandidateStats(r.stats.endpoints),
    deterministicEdges: r.edges.length,
    truncated: r.truncated,
    knownLimits: r.knownLimits,
    ...(r.pathFilter ? { pathFilter: r.pathFilter } : {}),
    ...(r.degraded ? { degraded: r.degraded } : {}),
  };
}

/**
 * 独立候选区查询:一次 queryBridgeEdges(includeCandidates)后取候选视图。
 * 候选 tier=semantic、带双端证据链;确定性边不进 candidates(消费方无需再去重)。
 * includePrefix1=true 追加 1 段前缀(low,高噪声,显式开关)。
 */
export async function queryBridgeCandidates(
  root: string,
  opts?: QueryBridgeOptions & { includePrefix1?: boolean },
): Promise<BridgeCandidateSurface> {
  const { includePrefix1, ...rest } = opts ?? {};
  const r = await queryBridgeEdges(root, {
    ...rest,
    includeCandidates: true,
    candidateMode: includePrefix1 ? "all" : "first2",
  });
  return bridgeCandidateSurfaceOf(r);
}

function emptyStats(endpoints: ApiEndpoint[]): BridgeStats {
  return {
    endpoints: endpoints.length, frameworks: [...new Set(endpoints.map((e) => e.framework))],
    frontendFiles: 0, literalOccurrences: 0, literalsUnique: 0, foldedLiterals: 0,
    edges: 0, candidates: 0,
    endpointsExactNative: 0, endpointsExactFolded: 0, endpointsExactUnion: 0,
    endpointsFirst2Only: 0, endpointsUnmatched: endpoints.length, prefix1segHits: 0,
  };
}

/** rg/grep 通用行扫描( A2-A6 共用):pattern 命中行带 file:line:content。
 * 仅 rg 通道(A2-A6 是新增形态,不为它们实现 grep 兜底——无 rg=显式降级,与 A1 的
 * grep 兜底存量语义无涉)。返回 null=rg 缺席(降级);[] =零命中。 */
async function rgLines(
  root: string,
  pattern: string,
  exts: string[],
  opts?: { fixed?: boolean; maxBufferMb?: number },
): Promise<{ file: string; line: number; text: string }[] | null> {
  if (!(await haveRg())) return null;
  let stdout = "";
  try {
    const r = await execFileP("rg", [
      "-n", "--no-heading", "--no-messages",
      ...(opts?.fixed ? ["-F"] : []),
      ...exts.flatMap((e) => ["-g", e]),
      "-e", pattern, "--", root,
    ], { maxBuffer: (opts?.maxBufferMb ?? 64) * 1024 * 1024 });
    stdout = r.stdout;
  } catch (e) {
    if ((e as { code?: number }).code === 1) return [];
    throw e;
  }
  const out: { file: string; line: number; text: string }[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
    const m = /^(.*):(\d+):(.*)$/.exec(clean);
    if (!m) continue;
    const file = m[1]!.startsWith(root) ? m[1]!.slice(root.length).replace(/^\//, "") : m[1]!;
    out.push({ file, line: Number(m[2]), text: m[3]! });
  }
  return out;
}

/** 前端证据行路径过滤(ws/ipc 通道面共享; D2)。
 * 这两面用 rgLines 直扫前端扩展名,没有经过 http-api 的 collectFrontendLiterals 滤网,
 * 于是 test/ 与 .next/_next 产物里的 `new WebSocket(...)`/`ipcRenderer.invoke(...)` 会冒充
 * 前端证据——与 http-api 面口径漂移。此处按同一 path-filter 判定丢弃并计数(计数走
 * nonProductFilterNote 呈报,不静默清零)。opts.all=true 原样放行。 */
function filterFrontendRows<T extends { file: string }>(
  rows: T[],
  state: { filtered: number; samples: string[] },
  all?: boolean): T[] {
  if (all) return rows;
  const kept: T[] = [];
  for (const r of rows) {
    if (isNonProductEvidencePath(r.file)) {
      state.filtered++;
      if (state.samples.length < 3 && !state.samples.includes(r.file)) state.samples.push(r.file);
      continue;
    }
    kept.push(r);
  }
  return kept;
}

/** rg --files 文件枚举(A6 proto/桩发现用;-g 形态过滤,gitignore 遵守 rg 缺省)。 */
async function rgFiles(root: string, globs: string[]): Promise<string[] | null> {
  if (!(await haveRg())) return null;
  let stdout = "";
  try {
    const r = await execFileP("rg", ["--files", ...globs.flatMap((g) => ["-g", g]), "--", root], { maxBuffer: 16 * 1024 * 1024 });
    stdout = r.stdout;
  } catch (e) {
    if ((e as { code?: number }).code === 1) return [];
    throw e;
  }
  return stdout.split("\n").filter(Boolean).map((f) => (f.startsWith(root) ? f.slice(root.length).replace(/^\//, "") : f));
}

/** 批量文件文本读取(带帽,逐文件失败跳过)。 */
async function readTexts(root: string, files: string[], cap: number, truncated: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const f of files) {
    if (out.size >= cap) { truncated.push(`readTexts@${cap}`); break; }
    try { out.set(f, await readFile(join(root, f), "utf8")); } catch { /* 跳过 */ }
  }
  return out;
}

/** 从文本 offset 起取「首个顶层实参」文本(深度 0 逗号或闭括号为止;字符串/模板感知,帽 400 字符)。 */
function firstArgSpan(text: string, openParenIdx: number): string {
  let depth = 0, quote: string | null = null, cur = "";
  for (let j = openParenIdx + 1; j < Math.min(text.length, openParenIdx + 400); j++) {
    const ch = text[j]!;
    if (quote) {
      if (ch === "\\") { cur += ch + (text[++j] ?? ""); continue; }
      if (ch === quote) quote = null;
      cur += ch; continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; cur += ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) return cur.trim();
      depth--;
    } else if (ch === "," && depth === 0) return cur.trim();
    cur += ch;
  }
  return cur.trim();
}

// ============================ A2 ws-channel( §4) ============================

export interface WsConnectionPoint {
  file: string;
  line: number;
  /** new WebSocket(…) 首参原文(截断 120)。 */
  argText: string;
  resolution: "literal" | "folded" | "unresolved";
  /** 解析出的 ws/wss URL(resolution≠unresolved 时)。 */
  url?: string;
  foldedFrom?: string;
}

export interface WsChannelEdge {
  kind: "bridge";
  bridge: "ws-channel";
  from: { side: "frontend"; file: string; line: number; literal: string; via: "ws-scheme" | "path-literal"; foldedFrom?: string };
  to: { side: "backend"; file: string; line: number; method: "WS"; path: string; handler?: string; framework: string; prefixInferred?: boolean };
  match: "exact";
  confidence: "high" | "medium";
  tier: "structural";
  evidence: "grep";
  note?: string;
}

export interface WsChannelSurface {
  state: "ws-connected" | "no-ws-endpoints" | "no-frontend-match";
  edges: WsChannelEdge[];
  /** new WebSocket(…) 连接点全量(含解析失败——owncast URL 对象拼装=B3 口径,登记不出边)。 */
  connectionPoints: WsConnectionPoint[];
  unmatchedEndpoints: { path: string; file: string; line: number }[];
  stats: { wsEndpoints: number; connectionPoints: number; resolvedPoints: number; edges: number; pathLiteralHits: number };
  truncated: string[];
  knownLimits: string[];
 /** 前端证据行路径过滤呈报(可选,缺席=零过滤; D2 加性字段)。 */
  pathFilter?: { filtered: number; note: string };
  degraded?: { reason: string };
}

const WS_KNOWN_LIMITS = [
  "B3 URL 变量拼装(new WebSocket(url.toString()) / buildWsUri(…))——连接点登记,不出边",
  "A2 路径字面量通道仅对 ≥2 段的 ws 端点路径生效(单段字面量如 ws 会洪泛,不配)",
  "C3 运行时拼接的 ws 路径——字面量不在源码中,不产边",
];

const MAX_WS_EDGES = 500;
const MAX_WS_PER_ENDPOINT = 10;

/** ws/wss URL → 路径(协议族过滤:非 ws/wss 返回 undefined)。 */
function wsUrlPath(url: string): string | undefined {
  const m = /^wss?:\/\/[^/\s]+(\/[^?\s#]*)?/.exec(url);
  if (!m) return undefined;
  return m[1] ?? "/";
}

/**
 * A2 WebSocket 通道桥边:后端 ws 端点(queryApiSurface kind=ws,零改动消费)× 前端两通道——
 * ① new WebSocket("wss://…") 字面量(同文件 const 折叠)路径段配对(exact+可信闸,high);
 * ② ws 端点路径(去首 /,≥2 段)在前端文件的字面量出现点(medium,note 标「未见调用语境」)。
 */
export async function queryWsChannelEdges(root: string, opts?: { frontendExts?: string[]; all?: boolean }): Promise<WsChannelSurface> {
  const truncated: string[] = [];
  const exts = opts?.frontendExts ?? FRONTEND_EXTS_DEFAULT;
  const api = await queryApiSurface(root, { withImpact: false });
  const wsEndpoints = api.endpoints.filter((e) => e.kind === "ws");
  const base: Omit<WsChannelSurface, "state"> = {
    edges: [], connectionPoints: [], unmatchedEndpoints: [],
    stats: { wsEndpoints: wsEndpoints.length, connectionPoints: 0, resolvedPoints: 0, edges: 0, pathLiteralHits: 0 },
    truncated, knownLimits: WS_KNOWN_LIMITS,
  };
  if (wsEndpoints.length === 0) return { state: "no-ws-endpoints", ...base };

  // ① new WebSocket(…) 连接点
  const rawHits = await rgLines(root, "new\\s+WebSocket\\s*\\(", exts.map((e) => `*.${e}`));
  if (rawHits === null) {
    return { state: "no-frontend-match", ...base, degraded: { reason: "rg 缺席,WS 前端连接点扫描降级" } };
  }
  // 前端证据行路径过滤(与 http-api 面同一 path-filter 口径;test/ 与产物目录里的
  // new WebSocket 不是「这个前端真的在连」的证据)
  const wsFilterState = { filtered: 0, samples: [] as string[] };
  const hits = filterFrontendRows(rawHits, wsFilterState, opts?.all);
  const hitFiles = [...new Set(hits.map((h) => h.file))];
  const texts = await readTexts(root, hitFiles, 400, truncated);
  const points: WsConnectionPoint[] = [];
  for (const h of hits) {
    const text = texts.get(h.file);
    if (!text) continue;
    const offs = lineOffsets(text);
    const lineStart = offs[h.line - 1];
    if (lineStart === undefined) continue;
    const callIdx = text.indexOf("new", lineStart);
    const parenIdx = text.indexOf("(", callIdx);
    if (callIdx < 0 || parenIdx < 0) continue;
    const arg = firstArgSpan(text, parenIdx);
    const defs = constDefsOf(text, offs);
    let resolution: WsConnectionPoint["resolution"] = "unresolved";
    let url: string | undefined;
    let foldedFrom: string | undefined;
    const litM = /^(["'`])([^"'`]*)\1/.exec(arg);
    if (litM) {
      const folded = /\$\{[A-Za-z_$][\w$]*\}/.test(litM[2]!) ? foldConstRefs(litM[2]!, defs) : litM[2]!;
      if (/^wss?:\/\//.test(folded)) {
        resolution = folded === litM[2]! ? "literal" : "folded";
        url = folded;
        if (resolution === "folded") foldedFrom = litM[2]!;
      }
    } else {
      // 裸标识符:同文件 const 折叠一层(const uri = "wss://…")
      const idM = /^[A-Za-z_$][\w$]*$/.exec(arg);
      const def = idM ? defs.get(idM[0]!) : undefined;
      if (def && /^wss?:\/\//.test(foldConstRefs(def.value, defs))) {
        resolution = "folded";
        url = foldConstRefs(def.value, defs);
        foldedFrom = `const ${idM![0]!}`;
      }
    }
    points.push({
      file: h.file, line: h.line, argText: arg.slice(0, 120), resolution,
      ...(url ? { url } : {}), ...(foldedFrom ? { foldedFrom } : {}),
    });
  }

  const edges: WsChannelEdge[] = [];
  const matchedEp = new Set<number>();
  const epSegs = wsEndpoints.map((e) => normSegments(e.path.split("?")[0] ?? ""));
  const toOf = (e: ApiEndpoint): WsChannelEdge["to"] => ({
    side: "backend", file: e.file, line: e.line, method: "WS", path: e.path,
    ...(e.handler ? { handler: e.handler } : {}), framework: e.framework,
    ...(e.prefixInferred ? { prefixInferred: true } : {}),
  });
  const perEp = new Map<number, number>();
  const pushEdge = (ei: number, from: WsChannelEdge["from"], conf: "high" | "medium", note?: string): void => {
    if (edges.length >= MAX_WS_EDGES) { if (!truncated.includes(`wsEdges@${MAX_WS_EDGES}`)) truncated.push(`wsEdges@${MAX_WS_EDGES}`); return; }
    const n = perEp.get(ei) ?? 0;
    if (n >= MAX_WS_PER_ENDPOINT) return;
    const ep = wsEndpoints[ei]!;
    const downgrade = ep.prefixInferred && conf === "high";
    edges.push({
      kind: "bridge", bridge: "ws-channel", from, to: toOf(ep), match: "exact",
      confidence: downgrade ? "medium" : conf,
      tier: "structural", evidence: "grep",
      ...(note || downgrade ? { note: [note, downgrade ? "后端路径含未解析前缀(prefixInferred),置信度降一档" : ""].filter(Boolean).join(";") } : {}),
    });
    perEp.set(ei, n + 1);
    matchedEp.add(ei);
  };

  // ① ws-scheme 配对
  const pairedKeys = new Set<string>();
  for (const p of points) {
    if (!p.url) continue;
    const path = wsUrlPath(p.url);
    if (!path) continue;
    const segs = normSegments(path);
    if (segs.length === 0) continue;
    for (let ei = 0; ei < wsEndpoints.length; ei++) {
      if (!segMatchCredible(epSegs[ei]!, segs)) continue;
      pushEdge(ei, {
        side: "frontend", file: p.file, line: p.line, literal: p.url, via: "ws-scheme",
        ...(p.foldedFrom ? { foldedFrom: p.foldedFrom } : {}),
      }, "high", p.resolution === "folded" ? "前端 URL 经同文件 const 折叠(确定性替换)" : undefined);
      pairedKeys.add(`${ei}|${p.file}:${p.line}`);
    }
  }

  // ② 路径字面量通道(≥2 段端点;字面量=端点路径去首 /)
  let pathLiteralHits = 0;
  for (let ei = 0; ei < wsEndpoints.length; ei++) {
    const ep = wsEndpoints[ei]!;
    const bare = ep.path.replace(/^\/+/, "");
    if (!bare.includes("/") || bare.includes("*") || bare.includes("{")) continue; // 单段/含通配:不配(防洪泛)
    const occ = await rgLines(root, bare, exts.map((e) => `*.${e}`), { fixed: true });
    if (!occ) continue;
    // 路径字面量通道同样是前端证据行:test/ 与产物目录里的字面量不是「前端真的在用的路径」
    const occKept = filterFrontendRows(occ, wsFilterState, opts?.all);
    for (const o of occKept) {
      pathLiteralHits++;
      if (pairedKeys.has(`${ei}|${o.file}:${o.line}`)) continue; // ① 已配(同行)
      pushEdge(ei, { side: "frontend", file: o.file, line: o.line, literal: bare, via: "path-literal" },
        "medium", "路径字面量配对(未见 WebSocket 调用语境)");
      pairedKeys.add(`${ei}|${o.file}:${o.line}`);
    }
  }

  const unmatched = wsEndpoints
    .map((e, ei) => ({ e, ei }))
    .filter(({ ei }) => !matchedEp.has(ei))
    .slice(0, 50)
    .map(({ e }) => ({ path: e.path, file: e.file, line: e.line }));
  const stats = {
    wsEndpoints: wsEndpoints.length, connectionPoints: points.length,
    resolvedPoints: points.filter((p) => p.resolution !== "unresolved").length,
    edges: edges.length, pathLiteralHits,
  };
  return {
    state: edges.length > 0 ? "ws-connected" : "no-frontend-match",
    edges, connectionPoints: points, unmatchedEndpoints: unmatched,
    stats, truncated, knownLimits: WS_KNOWN_LIMITS,
    // 诚实呈报:前端证据行被路径过滤时显式输出(filtered>0 才有 note)
    ...(wsFilterState.filtered > 0
      ? { pathFilter: { filtered: wsFilterState.filtered, note: nonProductFilterNote(wsFilterState.filtered, wsFilterState.samples, { all: opts?.all }) } }
      : {}),
  };
}

export function renderWsChannelEdges(r: WsChannelSurface): string {
  const lines: string[] = [];
  lines.push(`跨语言桥边(ws-channel): ${r.edges.length} 条边(状态: ${r.state})`);
  lines.push(`  ws 端点 ${r.stats.wsEndpoints} · 连接点 ${r.stats.connectionPoints}(解析出 URL ${r.stats.resolvedPoints})· 路径字面量命中 ${r.stats.pathLiteralHits}`);
  // 诚实原则:前端证据行被路径过滤(产物/test)时显式呈报
  if (r.pathFilter && r.pathFilter.note) lines.push(`  [路径过滤] ${r.pathFilter.note}`);
  if (r.degraded) lines.push(`  [降级] ${r.degraded.reason}`);
  for (const e of r.edges.slice(0, 30)) {
    const conf = e.confidence === "high" ? "高" : "中";
    lines.push(`  [${e.from.via}|${conf}] WS ${e.to.path}`);
    lines.push(`      前端 ${e.from.file}:${e.from.line}  \`${e.from.literal}\`${e.from.foldedFrom ? `(折叠自 ${e.from.foldedFrom})` : ""}`);
    lines.push(`      后端 ${e.to.file}:${e.to.line}${e.to.handler ? `  → ${e.to.handler}` : ""}  [${e.to.framework}]`);
  }
  if (r.edges.length > 30) lines.push(`  …边共 ${r.edges.length} 条(截断,--json 看全量)`);
  const unresolved = r.connectionPoints.filter((p) => p.resolution === "unresolved");
  if (unresolved.length > 0) {
    lines.push(`  未解析连接点(URL 变量拼装,B3 口径不出边,前 5):`);
    for (const p of unresolved.slice(0, 5)) lines.push(`    ${p.file}:${p.line}  new WebSocket(${p.argText})`);
  }
  if (r.unmatchedEndpoints.length > 0) {
    lines.push(`  无前端配对的 ws 端点(前 5):`);
    for (const u of r.unmatchedEndpoints.slice(0, 5)) lines.push(`    WS ${u.path} @${u.file}:${u.line}`);
  }
  if (r.truncated.length > 0) lines.push(`  [截断] ${r.truncated.join("; ")}`);
  return lines.join("\n");
}

// ============================ A3 spec-reconcile( §4) ============================

export interface SpecBridgeEdge {
  kind: "bridge";
  bridge: "spec-reconcile";
  from: { side: "spec"; file: string; line?: number; method: string; path: string; summary?: string };
  to: { side: "code"; file: string; line: number; method: string; path: string; handler?: string; framework: string };
  confidence: "high";
  tier: "structural";
  evidence: "grep";
  note?: string;
}

export interface SpecBridgeSurface {
  state: "spec-connected" | "spec-no-match" | "no-spec" | "no-endpoints";
  specFile?: string;
  specParse?: "full" | "partial";
  edges: SpecBridgeEdge[];
  /** 规范声称存在、代码未提取到(提取器缺口排查;low,不进边清单)。 */
  specOnly: { method: string; path: string; line?: number; summary?: string }[];
  /** 代码有、规范没有(规范过期候选)。 */
  codeOnly: { method: string; path: string; file: string; line: number }[];
  stats: { specOps: number; endpoints: number; both: number; specOnly: number; codeOnly: number; specLinesResolved: number; a1Endorsed: number };
  notes: string[];
}

/** spec 文件行号补全(桥边证据行;openapi.ts 的 SpecOperation 无行号,本模块独立行扫描,
 * 不改 077 既有产物):JSON=`"<path>"` 首个出现行("paths" 键之后);YAML=indent≥2 的
 * `<path>:` 行。找不到=undefined(如实,不猜行号)。 */
export function specPathLines(specText: string, isJson: boolean, paths: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const lines = specText.split("\n");
  if (isJson) {
    let pathsLine = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/"paths"\s*:/.test(lines[i]!)) { pathsLine = i; break; }
    }
    for (const p of paths) {
      const needle = `"${p}"`;
      for (let i = pathsLine; i < lines.length; i++) {
        if (lines[i]!.includes(needle)) { out.set(p, i + 1); break; }
      }
    }
  } else {
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s+)["']?(\/[^"':]*?)["']?\s*:\s*$/.exec(lines[i]!);
      if (!m) continue;
      const p = m[2]!;
      if (!out.has(p)) out.set(p, i + 1);
    }
  }
  return out;
}

/**
 * A3 OpenAPI 权威对账桥边化:spec(权威源)× code 提取的三态(077 reconcileSpec 零改动消费),
 * both → 边(spec 行 ↔ 端点 file:line,high);specOnly/codeOnly 如实列清单,不产边。
 * opts.a1Edges:对 A1 exact 边做第三方背书计数(端点 ∈ spec both 集),不改原数组。
 */
export async function querySpecBridgeEdges(
  root: string,
  opts?: { a1Edges?: BridgeEdge[] },
): Promise<SpecBridgeSurface> {
  const base: SpecBridgeSurface = {
    state: "no-spec", edges: [], specOnly: [], codeOnly: [],
    stats: { specOps: 0, endpoints: 0, both: 0, specOnly: 0, codeOnly: 0, specLinesResolved: 0, a1Endorsed: 0 },
    notes: [],
  };
  // 先发现 spec(单一真相源的发现口径):无 spec 走快速返回,不做昂贵的 API 提取
  // (原实现同样先 findSpecFiles 再提取;这条快速路径不能因为换实现而丢掉)。
  const discover = await specFingerprint(root);
  if (discover.specFiles.length === 0) return base;
  const api = await queryApiSurface(root, { withImpact: false });
  const endpoints = api.endpoints;
  // 单一真相源:spec 解析/对账一律走 openapi.ts reconcileForRoot(本模块只做
  // 「spec 形态桥边化」+ 行号补全,不再自串 findSpecFiles→parseSpecFile→reconcileSpec);
  // specFiles 复用上一步发现结果,避免同一轮第二次全仓遍历。
  const atRoot = await reconcileForRoot(root, endpoints, { specFiles: discover.specFiles });
  const specFile = atRoot.specFiles[0];
  const spec = atRoot.spec;
  // specFile 与 spec/reconcile 同生共死:三者任一缺席即 no-spec(specFile 缺席时 TS 也无法窄化)
  if (specFile === undefined || !spec || !atRoot.reconcile) return base;
  let specText = "";
  try { specText = await readFile(join(root, specFile), "utf8"); } catch { /* 行号补全降级 */ }
  base.specFile = specFile;
  base.specParse = spec.parse;
  if (endpoints.length === 0) {
    base.state = "no-endpoints";
    base.stats.specOps = spec.operations.length;
    return base;
  }
  const rc = atRoot.reconcile;
  const lineMap = specText
    ? specPathLines(specText, /\.json$/i.test(specFile), spec.operations.map((o) => o.path))
    : new Map<string, number>();

  const edges: SpecBridgeEdge[] = [];
  for (const b of rc.both) {
    const ep = b.endpoint!;
    const line = lineMap.get(b.path);
    edges.push({
      kind: "bridge", bridge: "spec-reconcile",
      from: {
        side: "spec", file: specFile, ...(line ? { line } : {}),
        method: b.method, path: b.path, ...(b.summary ? { summary: b.summary } : {}),
      },
      to: {
        side: "code", file: ep.file, line: ep.line, method: ep.method, path: ep.path,
        ...(ep.handler ? { handler: ep.handler } : {}), framework: ep.framework,
      },
      confidence: "high", tier: "structural", evidence: "grep",
      note: "spec 为权威源,与代码提取一致(normalizePath+method 键)",
    });
  }
  const specOnly = rc.specOnly.slice(0, 200).map((op) => ({
    method: op.method, path: op.path,
    ...(lineMap.get(op.path) ? { line: lineMap.get(op.path)! } : {}),
    ...(op.summary ? { summary: op.summary } : {}),
  }));
  const codeOnly = rc.codeOnly.slice(0, 200).map((e) => ({ method: e.method, path: e.path, file: e.file, line: e.line }));

  // A1 背书计数(端点 ∈ both 集的 A1 边)
  let a1Endorsed = 0;
  if (opts?.a1Edges) {
    const bothKeys = new Set(rc.both.map((b) => `${b.method} ${normalizePath(b.path)}`));
    const epByKey = new Map<string, ApiEndpoint>();
    for (const ep of endpoints) epByKey.set(`${ep.file}:${ep.line}:${ep.path}`, ep);
    for (const e of opts.a1Edges) {
      const ep = epByKey.get(`${e.to.file}:${e.to.line}:${e.to.path}`);
      if (!ep) continue;
      const keys = ep.method === "ANY"
        ? ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].map((m) => `${m} ${normalizePath(ep.path)}`)
        : [`${ep.method} ${normalizePath(ep.path)}`];
      if (keys.some((k) => bothKeys.has(k))) a1Endorsed++;
    }
  }

  return {
    state: edges.length > 0 ? "spec-connected" : "spec-no-match",
    specFile, specParse: spec.parse,
    edges, specOnly, codeOnly,
    stats: {
      specOps: spec.operations.length, endpoints: endpoints.length,
      both: rc.both.length, specOnly: rc.specOnly.length, codeOnly: rc.codeOnly.length,
      specLinesResolved: lineMap.size, a1Endorsed,
    },
    notes: [...spec.notes.slice(0, 10),
      ...(rc.specOnly.length > 200 ? [`specOnly 截断 200/${rc.specOnly.length}`] : []),
      ...(rc.codeOnly.length > 200 ? [`codeOnly 截断 200/${rc.codeOnly.length}`] : [])],
  };
}

export function renderSpecBridgeEdges(r: SpecBridgeSurface): string {
  const lines: string[] = [];
  lines.push(`跨语言桥边(spec-reconcile): ${r.edges.length} 条边(状态: ${r.state})`);
  if (r.specFile) lines.push(`  spec: ${r.specFile}(解析=${r.specParse});对账: 一致 ${r.stats.both} / 仅规范 ${r.stats.specOnly} / 仅代码 ${r.stats.codeOnly};spec 行号 ${r.stats.specLinesResolved}/${r.stats.specOps}`);
  if (r.stats.a1Endorsed > 0) lines.push(`  A1 背书: ${r.stats.a1Endorsed} 条 http-api 边的端点亦在 spec(权威源第三方背书)`);
  for (const e of r.edges.slice(0, 30)) {
    lines.push(`  [spec|高] ${e.from.method} ${e.from.path}`);
    lines.push(`      规范 ${e.from.file}${e.from.line ? `:${e.from.line}` : "(行号未定位)"}${e.from.summary ? `  — ${e.from.summary}` : ""}`);
    lines.push(`      代码 ${e.to.file}:${e.to.line}${e.to.handler ? `  → ${e.to.handler}` : ""}  [${e.to.framework}]`);
  }
  if (r.edges.length > 30) lines.push(`  …边共 ${r.edges.length} 条(截断,--json 看全量)`);
  if (r.specOnly.length > 0) {
    lines.push(`  仅规范(代码未提取到,提取器缺口排查,前 10):`);
    for (const s of r.specOnly.slice(0, 10)) lines.push(`    ${s.method} ${s.path}${s.line ? ` @:${s.line}` : ""}${s.summary ? ` — ${s.summary}` : ""}`);
  }
  if (r.codeOnly.length > 0) {
    lines.push(`  仅代码(规范过期候选,前 10):`);
    for (const c of r.codeOnly.slice(0, 10)) lines.push(`    ${c.method} ${c.path} @${c.file}:${c.line}`);
  }
  for (const n of r.notes.slice(0, 5)) lines.push(`  [note] ${n}`);
  return lines.join("\n");
}

// ============================ A4 ipc-channel( §4) ============================

export type IpcSide = "main" | "renderer";

export interface IpcSite {
  file: string;
  line: number;
  side: IpcSide;
  /** 调用形态:receiver.method(如 ipcMain.handle / ipcRendererInternal.invoke / handleMessage)。 */
  call: string;
  /** 首参原文(截断 120)。 */
  rawArg: string;
  channel?: string;            // 解析出的通道名(template 通道=归一化后形态)
  channelKind: "literal" | "enum" | "template" | "unresolved";
  enumRef?: string;            // ENUM.MEMBER 引用(enum 通道)
  enumDefFile?: string;        // 枚举成员定义文件(跨文件枚举的证据链)
  enumDefLine?: number;        // 枚举成员定义行
}

export interface IpcChannelEdge {
  kind: "bridge";
  bridge: "ipc-channel";
  from: { side: "renderer"; file: string; line: number; call: string; rawArg: string };
  to: { side: "main"; file: string; line: number; call: string; rawArg: string };
  channel: string;
  confidence: "high" | "medium";
  tier: "structural";
  evidence: "grep";
  note?: string;
}

export interface IpcChannelSurface {
  state: "ipc-connected" | "no-ipc-sites" | "one-side-only";
  edges: IpcChannelEdge[];
  /** 解析失败的调用点(动态拼接通道名=C3 口径,登记不产边)。 */
  unresolved: IpcSite[];
  /** 仅单侧出现的通道名(主进程注册了但渲染侧未见调用,或反之)。 */
  mainOnlyChannels: string[];
  rendererOnlyChannels: string[];
  stats: { enumTables: number; enumMembers: number; sites: number; mainSites: number; rendererSites: number; channels: number; edges: number };
  truncated: string[];
  knownLimits: string[];
 /** 调用点路径过滤呈报(可选,缺席=零过滤; D2 加性字段)。 */
  pathFilter?: { filtered: number; note: string };
  degraded?: { reason: string };
}

const IPC_KNOWN_LIMITS = [
  "C3 动态拼接通道名(运行时变量/插值无静态前缀)——登记 unresolved,不产边",
  "仓内自定义 wrapper(electron 的 handleMessage 族)不进缺省面——opts.extraWrappers 显式登记后才收",
  "webContents.send ↔ ipcRenderer.on 方向(主→渲染)不在本形态配对面( §4 只设计 invoke/send ↔ handle/on)",
];

/** TS 枚举表解析:`enum X { A = 'a', B = "b" }`(const enum 同)。返回 MEMBER→{value,line}。 */
export function parseEnumTables(text: string): Map<string, Map<string, { value: string; line: number }>> {
  const tables = new Map<string, Map<string, { value: string; line: number }>>();
  const lines = text.split("\n");
  const offs = lineOffsets(text);
  for (const m of text.matchAll(/\benum\s+([A-Za-z_]\w*)\s*\{/g)) {
    const name = m[1]!;
    let depth = 0;
    let end = -1;
    for (let j = m.index!; j < text.length; j++) {
      const ch = text[j]!;
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) continue;
    const body = text.slice(m.index!, end);
    const members = new Map<string, { value: string; line: number }>();
    for (const mm of body.matchAll(/\b([A-Za-z_]\w*)\s*=\s*(['"])((?:\\.|(?!\2).)*?)\2/g)) {
      const memberOff = m.index! + mm.index!;
      members.set(mm[1]!, { value: mm[3]!, line: lineAt(offs, memberOff) });
    }
    if (members.size > 0) tables.set(name, members);
  }
  return tables;
}

const IPC_RECEIVERS: Record<string, IpcSide> = {
  ipcMain: "main", ipcMainInternal: "main",
  ipcRenderer: "renderer", ipcRendererInternal: "renderer",
};
const IPC_METHODS = "(?:handle|handleOnce|on|once|invoke|send|sendSync|sendToHost)";
const MAX_IPC_EDGES = 2000;
const MAX_IPC_PER_CHANNEL = 20;

/**
 * A4 Electron IPC 桥边:双进程通道名字面量配对——渲染侧 invoke/send 调用点 → 主侧 handle/on
 * 注册点,通道名相等出边。三通道:字面量直取(high)/ ENUM.MEMBER 枚举表查表(high+note,
 * 确定性)/ 模板 `${…}` 洞归一(*)后双侧模板相等(medium+note)。动态拼接=unresolved 登记。
 * opts.extraWrappers:仓内自定义包装函数(如 electron 的 handleMessage/handleMessageSync/
 * handleSync=main,invokeSync=renderer)显式登记后同规则收编。
 */
export async function queryIpcChannelEdges(
  root: string,
  opts?: { exts?: string[]; extraWrappers?: { name: string; side: IpcSide }[]; all?: boolean },
): Promise<IpcChannelSurface> {
  const truncated: string[] = [];
  const exts = (opts?.exts ?? ["ts", "tsx", "js", "jsx", "mjs", "cjs"]).map((e) => `*.${e}`);
  const base: Omit<IpcChannelSurface, "state"> = {
    edges: [], unresolved: [], mainOnlyChannels: [], rendererOnlyChannels: [],
    stats: { enumTables: 0, enumMembers: 0, sites: 0, mainSites: 0, rendererSites: 0, channels: 0, edges: 0 },
    truncated, knownLimits: IPC_KNOWN_LIMITS,
  };

  // 调用点扫描
  const wrapperNames = (opts?.extraWrappers ?? []).map((w) => w.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const patterns = [`\\b(?:ipcMain|ipcMainInternal|ipcRenderer|ipcRendererInternal)\\.${IPC_METHODS}\\s*\\(`];
  for (const w of wrapperNames) patterns.push(`\\b${w}\\s*\\(`);
  // 前端证据行路径过滤(与 http-api 面同一 path-filter 口径;测试夹具与产物目录里的
 // ipcRenderer.invoke 不是「这个应用真的在用的通道」—— D2)
  const ipcFilterState = { filtered: 0, samples: [] as string[] };
  const rawHits: { file: string; line: number; text: string }[] = [];
  for (const pat of patterns) {
    const r = await rgLines(root, pat, exts);
    if (r === null) return { state: "no-ipc-sites", ...base, degraded: { reason: "rg 缺席,IPC 调用点扫描降级" } };
    rawHits.push(...r);
  }
  // 注意:filterFrontendRows 在 all=true 时返回**同一引用**,故用新变量承接,
  // 绝不能原地清零原数组(否则 --all 逃生口会把扫到的调用点也清掉)。
  const hits = filterFrontendRows(rawHits, ipcFilterState, opts?.all);
  const ipcPathFilter = ipcFilterState.filtered > 0
    ? { filtered: ipcFilterState.filtered, note: nonProductFilterNote(ipcFilterState.filtered, ipcFilterState.samples, { all: opts?.all }) }
    : undefined;
  if (hits.length === 0) {
    return { state: "no-ipc-sites", ...base, ...(ipcPathFilter ? { pathFilter: ipcPathFilter } : {}) };
  }

  const hitFiles = [...new Set(hits.map((h) => h.file))];
  const texts = await readTexts(root, hitFiles, 600, truncated);

  // 枚举表(全部命中文件 + opts 指定枚举文件之外的集中枚举文件按 ipc-message 命名惯例补扫)
  const enumTables = new Map<string, { value: string; file: string; line: number }>();
  const enumFiles = await rgFiles(root, ["*ipc-message*", "*ipc-channels*", "*ipc-constants*"]);
  for (const f of [...hitFiles, ...(enumFiles ?? [])]) {
    let text = texts.get(f);
    if (!text) {
      try { text = await readFile(join(root, f), "utf8"); } catch { continue; }
      texts.set(f, text);
    }
    for (const [enumName, members] of parseEnumTables(text)) {
      for (const [member, v] of members) {
        enumTables.set(`${enumName}.${member}`, { value: v.value, file: f, line: v.line });
      }
    }
  }

  // 调用点解析
  const sites: IpcSite[] = [];
  const seenSite = new Set<string>();
  for (const h of hits) {
    const key = `${h.file}:${h.line}:${h.text.trim().slice(0, 60)}`;
    if (seenSite.has(key)) continue;
    seenSite.add(key);
    const text = texts.get(h.file);
    if (!text) continue;
    const offs = lineOffsets(text);
    const lineStart = offs[h.line - 1];
    if (lineStart === undefined) continue;
    // 定位本行的调用形态——模式定位必须限定在命中行本身(rg 的行级命中语义),
 // 禁用跨行窗口(注意:declare 行的 lineTail 含后续行的 canonical 调用,会冒名错配);
    // 首参解析(firstArgSpan)仍可跨行。
    const lineText = h.text;
    let side: IpcSide | undefined;
    let call = "";
    let parenIdx = -1;
    const cm = new RegExp(`\\b(ipcMain|ipcMainInternal|ipcRenderer|ipcRendererInternal)\\.(handle|handleOnce|on|once|invoke|send|sendSync|sendToHost)\\s*\\(`).exec(lineText);
    if (cm) {
      side = IPC_RECEIVERS[cm[1]!];
      call = `${cm[1]}.${cm[2]}`;
      parenIdx = lineStart + cm.index + cm[0].length - 1;
    } else {
      for (const w of opts?.extraWrappers ?? []) {
        const wm = new RegExp(`\\b${w.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`).exec(lineText);
        if (wm) { side = w.side; call = w.name; parenIdx = lineStart + wm.index + wm[0].length - 1; break; }
      }
    }
    if (!side || parenIdx < 0) continue;
    const arg = firstArgSpan(text, parenIdx);
    const site: IpcSite = { file: h.file, line: h.line, side, call, rawArg: arg.slice(0, 120), channelKind: "unresolved" };
    const litM = /^(["'])([^"']*)\1$/.exec(arg);
    const tplM = /^`([^`]*)`$/.exec(arg);
    const enumM = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(arg);
    if (litM) {
      site.channel = litM[2]!; site.channelKind = "literal";
    } else if (tplM) {
      const norm = tplM[1]!.replace(/\$\{[^}]*\}/g, "*");
      if (norm.replace(/\*/g, "").length >= 4) { site.channel = norm; site.channelKind = "template"; }
    } else if (enumM) {
      const ref = `${enumM[1]}.${enumM[2]}`;
      const hit = enumTables.get(ref);
      if (hit) {
        site.channel = hit.value; site.channelKind = "enum"; site.enumRef = ref;
        site.enumDefFile = hit.file; site.enumDefLine = hit.line;
      }
    }
    sites.push(site);
    if (site.channelKind === "unresolved") base.unresolved.push(site);
  }

 // 配对( §4 口径):渲染侧发起调用 {invoke,send,sendSync,sendToHost} × 主侧注册
  // {handle,handleOnce,on,once};wrapper 按 opts 声明的 side 归位。渲染侧 .on 监听(配
  // webContents.send,本形态不收)不进配对——如实落入 rendererOnly 清单。
  const RENDERER_CALL = new Set(["invoke", "send", "sendSync", "sendToHost"]);
  const MAIN_REG = new Set(["handle", "handleOnce", "on", "once"]);
  const mainByChannel = new Map<string, IpcSite[]>();
  const rendererSites: IpcSite[] = [];
  for (const s of sites) {
    if (!s.channel) continue;
    const method = s.call.includes(".") ? s.call.split(".")[1]! : undefined;
    if (s.side === "main") {
      if (method && !MAIN_REG.has(method)) continue; // 主侧非注册形态不收
      const arr = mainByChannel.get(s.channel) ?? [];
      arr.push(s);
      mainByChannel.set(s.channel, arr);
    } else {
      if (method && !RENDERER_CALL.has(method)) continue; // 渲染侧监听形态不配
      rendererSites.push(s);
    }
  }
  const edges: IpcChannelEdge[] = [];
  const perChannel = new Map<string, number>();
  for (const r of rendererSites) {
    const mains = mainByChannel.get(r.channel!);
    if (!mains) continue;
    for (const m of mains) {
      if (edges.length >= MAX_IPC_EDGES) { if (!truncated.includes(`ipcEdges@${MAX_IPC_EDGES}`)) truncated.push(`ipcEdges@${MAX_IPC_EDGES}`); break; }
      const n = perChannel.get(r.channel!) ?? 0;
      if (n >= MAX_IPC_PER_CHANNEL) break;
      const tpl = r.channelKind === "template" || m.channelKind === "template";
      edges.push({
        kind: "bridge", bridge: "ipc-channel",
        from: { side: "renderer", file: r.file, line: r.line, call: r.call, rawArg: r.rawArg },
        to: { side: "main", file: m.file, line: m.line, call: m.call, rawArg: m.rawArg },
        channel: r.channel!,
        confidence: tpl ? "medium" : "high",
        tier: "structural", evidence: "grep",
        note: [
          r.channelKind === "enum" || m.channelKind === "enum" ? "通道名经枚举表查表解析(确定性)" : "",
          tpl ? "模板通道(含运行时插值段,归一化后双侧相等)" : "",
        ].filter(Boolean).join(";") || undefined,
      });
      perChannel.set(r.channel!, n + 1);
    }
  }

  const mainChannels = new Set(mainByChannel.keys());
  const rendererChannels = new Set(rendererSites.map((s) => s.channel!));
  base.edges = edges;
  base.mainOnlyChannels = [...mainChannels].filter((ch) => !rendererChannels.has(ch)).slice(0, 50);
  base.rendererOnlyChannels = [...rendererChannels].filter((ch) => !mainChannels.has(ch)).slice(0, 50);
  base.stats = {
    enumTables: new Set([...enumTables.values()].map((v) => v.file)).size,
    enumMembers: enumTables.size,
    sites: sites.length,
    mainSites: sites.filter((s) => s.side === "main").length,
    rendererSites: sites.filter((s) => s.side === "renderer").length,
    channels: new Set([...mainChannels, ...rendererChannels]).size,
    edges: edges.length,
  };
  return {
    state: edges.length > 0 ? "ipc-connected" : sites.length > 0 ? "one-side-only" : "no-ipc-sites",
    ...base,
    // 诚实呈报:前端证据行被路径过滤时显式输出(filtered>0 才有 note)
    ...(ipcPathFilter ? { pathFilter: ipcPathFilter } : {}),
  };
}

export function renderIpcChannelEdges(r: IpcChannelSurface): string {
  const lines: string[] = [];
  lines.push(`跨语言桥边(ipc-channel): ${r.edges.length} 条边(状态: ${r.state})`);
  lines.push(`  调用点 ${r.stats.sites}(主 ${r.stats.mainSites}/渲染 ${r.stats.rendererSites})· 通道 ${r.stats.channels} · 枚举成员 ${r.stats.enumMembers}`);
  // 诚实原则:调用点被路径过滤(产物/test)时显式呈报
  if (r.pathFilter && r.pathFilter.note) lines.push(`  [路径过滤] ${r.pathFilter.note}`);
  if (r.degraded) lines.push(`  [降级] ${r.degraded.reason}`);
  for (const e of r.edges.slice(0, 30)) {
    const conf = e.confidence === "high" ? "高" : "中";
    lines.push(`  [${conf}] ${e.channel}`);
    lines.push(`      渲染 ${e.from.file}:${e.from.line}  ${e.from.call}(\`${e.from.rawArg}\`)`);
    lines.push(`      主程 ${e.to.file}:${e.to.line}  ${e.to.call}(\`${e.to.rawArg}\`)`);
  }
  if (r.edges.length > 30) lines.push(`  …边共 ${r.edges.length} 条(截断,--json 看全量)`);
  if (r.mainOnlyChannels.length > 0) lines.push(`  仅主进程注册的通道(前 10): ${r.mainOnlyChannels.slice(0, 10).join(", ")}`);
  if (r.rendererOnlyChannels.length > 0) lines.push(`  仅渲染侧调用的通道(前 10): ${r.rendererOnlyChannels.slice(0, 10).join(", ")}`);
  if (r.unresolved.length > 0) lines.push(`  动态通道名登记(C3,不出边): ${r.unresolved.length} 处,如 ${r.unresolved[0]!.file}:${r.unresolved[0]!.line} \`${r.unresolved[0]!.rawArg}\``);
  if (r.truncated.length > 0) lines.push(`  [截断] ${r.truncated.join("; ")}`);
  return lines.join("\n");
}

// ============================ A5 abi-py-capi( §4) ============================

export interface PyCapiEntry {
  pyName: string;            // Python 侧导出名(PyMethodDef 表项首字段)
  cFn: string;               // C 侧函数符号(表项次字段)
  table: string;             // 所在 PyMethodDef 表名
  file: string;
  line: number;              // 表项首字段行(证据行)
  module?: string;           // PyInit_<mod> 绑定的模块名(同文件 .m_methods 解析成功时)
}

export interface PyCapiEdge {
  kind: "bridge";
  bridge: "abi-py-capi";
  from: { side: "abi-table"; file: string; line: number; pyName: string; table: string; module?: string };
  to: { side: "c-impl"; file: string; line: number; symbol: string };
  confidence: "high";
  tier: "structural";
  evidence: "grep";
  note?: string;
}

export interface PyCapiSurface {
  state: "capi-connected" | "no-capi-tables" | "no-defs";
  edges: PyCapiEdge[];
  /** c_fn 定义多候选(歧义,low,不进边)。 */
  ambiguous: { entry: PyCapiEntry; defCandidates: { file: string; line: number }[] }[];
  /** c_fn 定义未找到(宏生成/跨仓形态——登记不猜)。 */
  unresolved: PyCapiEntry[];
  stats: { tables: number; entries: number; modules: number; edges: number; ambiguous: number; unresolved: number };
  truncated: string[];
  knownLimits: string[];
  degraded?: { reason: string };
}

const CAPI_KNOWN_LIMITS = [
  "宏生成的 C 函数(PyArray_ 族宏展开)——静态不可见,定义定位失败入 unresolved,不猜",
  "Python 侧 模块.name(调用点属 c2f 族内解析覆盖面( §4),桥边只把 py_name 解析到 c_fn",
  "跨语言 C 变体(neovim luaL_Reg 数组)同族未收——表形态按 PyMethodDef 专型",
];

/** PyMethodDef 表解析(纯函数,fixture 可单测):多行表项 {"py_name",(PyCFunction)c_fn,…}。 */
export function parsePyMethodDefTables(file: string, text: string): { entries: PyCapiEntry[]; tableRanges: { start: number; end: number }[] } {
  const lines = text.split("\n");
  const entries: PyCapiEntry[] = [];
  const tableRanges: { start: number; end: number }[] = [];
  // PyInit 与 .m_methods 绑定(同文件)
  const initM = /PyMODINIT_FUNC\s+PyInit_(\w+)/.exec(text);
  const moduleName = initM?.[1];
  for (let i = 0; i < lines.length; i++) {
    const tm = /\bPyMethodDef\s+(\w+)\s*\[\s*\]\s*=\s*\{/.exec(lines[i]!);
    if (!tm) continue;
    const table = tm[1]!;
    // 表体定界(帽 1500 行)
    let end = i;
    for (let j = i; j < Math.min(lines.length, i + 1500); j++) {
      if (/^\s*\};/.test(lines[j]!)) { end = j; break; }
    }
    tableRanges.push({ start: i, end });
    for (let j = i; j <= end; j++) {
      const em = /\{\s*"([^"]+)"/.exec(lines[j]!);
      if (!em) continue;
      if (em[1] === "NULL") continue; // 哨兵 {NULL, NULL, 0, NULL}
      // 表项 span:本行起 ≤8 行到 `}` 闭合
      let span = "";
      for (let k = j; k < Math.min(end + 1, j + 8); k++) {
        span += lines[k]! + "\n";
        if (/\}/.test(lines[k]!)) break;
      }
      const cm = /(\w+)\s*,\s*METH_/.exec(span);
      if (!cm) continue; // 无 METH_ 标志的表项形态不收(不猜)
      entries.push({
        pyName: em[1]!, cFn: cm[1]!, table, file, line: j + 1,
        ...(moduleName ? { module: moduleName } : {}),
      });
    }
    i = end;
  }
  return { entries, tableRanges };
}

/** c_fn 定义形态判定:candidate 行不含 `"` 与 `(PyCFunction)`;名字前无 `=`/`.`/`->`;
 * 且自该行起 8 行内括号深度归零后出现 `{`(定义体)。 */
function isCDefinition(lines: string[], li: number, nameIdx: number): boolean {
  const line = lines[li]!;
  const before = line.slice(0, nameIdx);
  if (before.includes('"') || before.includes("(PyCFunction)") || /[=.]\s*$/.test(before) || /->\s*$/.test(before)) return false;
  let depth = 0, quote: string | null = null;
  for (let k = li; k < Math.min(lines.length, li + 8); k++) {
    const l = lines[k]!;
    const from = k === li ? nameIdx : 0;
    for (let j = from; j < l.length; j++) {
      const ch = l[j]!;
      if (quote) { if (ch === "\\") { j++; continue; } if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          const rest = l.slice(j + 1).trim();
          if (rest.startsWith("{")) return true;
          if (rest === "") {
 // 本行) 后空:下一非空行须以 { 开头(返回类型/参数换行形态)
            for (let q = k + 1; q < Math.min(lines.length, k + 4); q++) {
              const t = lines[q]!.trim();
              if (!t) continue;
              return t.startsWith("{");
            }
            return false;
          }
          return false; // ) 后接 ;或代码=声明/调用
        }
      }
    }
  }
  return false;
}

/**
 * A5 Python C-API 注册表桥边:PyMethodDef 表项(py_name ↔ c_fn,双字段同行证据)+
 * c_fn 定义定位(唯一定义→high 边;0 个→unresolved 登记;>1 个→ambiguous 候选,不裁决)。
 */
export async function queryPyCapiEdges(root: string, opts?: { cExts?: string[] }): Promise<PyCapiSurface> {
  const truncated: string[] = [];
 // numpy 注意:C-API 定义落在 .cpp(unique.cpp:505 array__unique_hash)——c/h 缺省会漏定义
  const cexts = (opts?.cExts ?? ["c", "h", "cpp", "cc", "cxx", "hpp"]).flatMap((e) => [`*.${e}`]);
  const base: Omit<PyCapiSurface, "state"> = {
    edges: [], ambiguous: [], unresolved: [],
    stats: { tables: 0, entries: 0, modules: 0, edges: 0, ambiguous: 0, unresolved: 0 },
    truncated, knownLimits: CAPI_KNOWN_LIMITS,
  };
  // 表文件发现
  const tableHits = await rgLines(root, "\\bPyMethodDef\\s+\\w+\\s*\\[", cexts);
  if (tableHits === null) return { state: "no-capi-tables", ...base, degraded: { reason: "rg 缺席,C-API 表扫描降级" } };
  if (tableHits.length === 0) return { state: "no-capi-tables", ...base };
  const tableFiles = [...new Set(tableHits.map((h) => h.file))];
  const texts = await readTexts(root, tableFiles, 120, truncated);

  const allEntries: PyCapiEntry[] = [];
  const tableRangesByFile = new Map<string, { start: number; end: number }[]>();
  let tables = 0;
  for (const [f, text] of texts) {
    const { entries, tableRanges } = parsePyMethodDefTables(f, text);
    allEntries.push(...entries);
    tableRangesByFile.set(f, tableRanges);
    tables += tableRanges.length;
  }
  base.stats.tables = tables;
  base.stats.entries = allEntries.length;
  base.stats.modules = new Set(allEntries.map((e) => e.module).filter(Boolean)).size;
  if (allEntries.length === 0) return { state: "no-capi-tables", ...base };

  // c_fn 定义定位:一次 rg 交替代数(分块 60)
  const cFns = [...new Set(allEntries.map((e) => e.cFn))];
  const defHits: { file: string; line: number; text: string }[] = [];
  for (let i = 0; i < cFns.length; i += 60) {
    const chunk = cFns.slice(i, i + 60);
    const r = await rgLines(root, `\\b(?:${chunk.join("|")})\\s*\\(`, cexts, { maxBufferMb: 64 });
    if (r) defHits.push(...r);
  }
  // 定义验证所需文件文本(复用表文件缓存,缺则补读)
  const defFiles = [...new Set(defHits.map((h) => h.file))];
  const defTexts = await readTexts(root, defFiles.filter((f) => !texts.has(f)), 200, truncated);
  for (const [f, t] of texts) defTexts.set(f, t);
  const defLinesByFile = new Map<string, string[]>();
  const linesOf = (f: string): string[] | undefined => {
    if (!defLinesByFile.has(f)) {
      const t = defTexts.get(f);
      if (!t) return undefined;
      defLinesByFile.set(f, t.split("\n"));
    }
    return defLinesByFile.get(f);
  };

  const defsByFn = new Map<string, { file: string; line: number }[]>();
  const cFnSet = new Set(cFns);
  for (const h of defHits) {
    const lines = linesOf(h.file);
    if (!lines) continue;
    const ranges = tableRangesByFile.get(h.file) ?? [];
    if (ranges.some((r) => h.line - 1 >= r.start && h.line - 1 <= r.end)) continue; // 表内命中=表项不是定义
    // 该行全部「名字(」命中,交集 cFn 集合(O(行内名字数),不逐 cFn 扫行)
    for (const nm of h.text.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
      const cFn = nm[1]!;
      if (!cFnSet.has(cFn)) continue;
      if (!isCDefinition(lines, h.line - 1, nm.index!)) continue;
      const arr = defsByFn.get(cFn) ?? [];
      if (!arr.some((d) => d.file === h.file && d.line === h.line)) arr.push({ file: h.file, line: h.line });
      defsByFn.set(cFn, arr);
    }
  }

  const edges: PyCapiEdge[] = [];
  const ambiguous: PyCapiSurface["ambiguous"] = [];
  const unresolved: PyCapiEntry[] = [];
  for (const e of allEntries) {
    const defs = defsByFn.get(e.cFn) ?? [];
    if (defs.length === 1) {
      edges.push({
        kind: "bridge", bridge: "abi-py-capi",
        from: { side: "abi-table", file: e.file, line: e.line, pyName: e.pyName, table: e.table, ...(e.module ? { module: e.module } : {}) },
        to: { side: "c-impl", file: defs[0]!.file, line: defs[0]!.line, symbol: e.cFn },
        confidence: "high", tier: "structural", evidence: "grep",
        note: "PyMethodDef 表项 ↔ 唯一 C 定义(静态表配对)",
      });
    } else if (defs.length > 1) {
      ambiguous.push({ entry: e, defCandidates: defs.slice(0, 10) });
    } else {
      unresolved.push(e);
    }
  }
  base.edges = edges;
  base.ambiguous = ambiguous.slice(0, 100);
  base.unresolved = unresolved.slice(0, 200);
  base.stats.edges = edges.length;
  base.stats.ambiguous = ambiguous.length;
  base.stats.unresolved = unresolved.length;
  return {
    state: edges.length > 0 ? "capi-connected" : "no-defs",
    ...base,
  };
}

export function renderPyCapiEdges(r: PyCapiSurface): string {
  const lines: string[] = [];
  lines.push(`跨语言桥边(abi-py-capi): ${r.edges.length} 条边(状态: ${r.state})`);
  lines.push(`  PyMethodDef 表 ${r.stats.tables} · 表项 ${r.stats.entries} · 模块 ${r.stats.modules} · 歧义 ${r.stats.ambiguous} · 未定位 ${r.stats.unresolved}`);
  if (r.degraded) lines.push(`  [降级] ${r.degraded.reason}`);
  for (const e of r.edges.slice(0, 30)) {
    lines.push(`  [高] ${e.from.module ? `${e.from.module}.` : ""}${e.from.pyName} → ${e.to.symbol}`);
    lines.push(`      表项 ${e.from.file}:${e.from.line}(${e.from.table})`);
    lines.push(`      定义 ${e.to.file}:${e.to.line}`);
  }
  if (r.edges.length > 30) lines.push(`  …边共 ${r.edges.length} 条(截断,--json 看全量)`);
  if (r.ambiguous.length > 0) {
    lines.push(`  歧义表项(c_fn 多定义候选,不裁决,前 5):`);
    for (const a of r.ambiguous.slice(0, 5)) lines.push(`    ${a.entry.pyName} → ${a.entry.cFn}: ${a.defCandidates.map((d) => `${d.file}:${d.line}`).join(" | ")}`);
  }
  if (r.unresolved.length > 0) lines.push(`  未定位定义的表项(宏生成等,登记不猜): ${r.stats.unresolved} 条`);
  if (r.truncated.length > 0) lines.push(`  [截断] ${r.truncated.join("; ")}`);
  return lines.join("\n");
}

// ============================ A6 rpc-proto( §4) ============================

export interface ProtoRpc {
  service: string;
  name: string;
  file: string;
  line: number;
  reqType?: string;
  respType?: string;
}

export interface GrpcProtoEdge {
  kind: "bridge";
  bridge: "rpc-proto";
  from: { side: "proto"; file: string; line: number; service: string; rpc: string };
  to:
    | { side: "stub"; file: string; line: number; via: "source-comment" | "filename"; symbol?: string }
    | { side: "impl"; file: string; line: number; symbol: string };
  confidence: "high" | "medium";
  tier: "structural";
  evidence: "grep";
  note?: string;
}

export interface GrpcProtoSurface {
  state: "grpc-connected" | "no-proto" | "no-stubs" | "no-edges";
  protos: { file: string; services: number; rpcs: number }[];
  edges: GrpcProtoEdge[];
 /** 客户端调用点(.RpcName(非生成文件)——medium 候选,帽 50。 */
  clientCalls: { file: string; line: number; rpc: string; service: string }[];
  /** 有 rpc 但未配到任何生成桩的 proto(只检入 proto 的仓态,如实登记)。 */
  protosWithoutStubs: string[];
  /** 未能回链 proto 的生成桩(无 source 注释且文件名推导不唯一)。 */
  stubsWithoutProto: string[];
  stats: { protoFiles: number; services: number; rpcs: number; stubFiles: number; edges: number; clientCalls: number };
  truncated: string[];
  knownLimits: string[];
  degraded?: { reason: string };
}

const GRPC_KNOWN_LIMITS = [
  "TS/Python hand-written 实现配对未做(形态发散)——本形态实现边只覆盖 Go(func (recv) RpcName()",
  "proto 中无 service 的文件(纯 message)=零 rpc,如实计数不出边",
  "生成桩缺失(只检入 proto)=protosWithoutStubs 登记,不产假边",
];

/** proto 行扫描(纯函数):service 块内 rpc 行带行号;`service X {}` 单行形态与同行 rpc 同收。 */
export function parseProtoFile(file: string, text: string): { services: string[]; rpcs: ProtoRpc[] } {
  const lines = text.split("\n");
  const services: string[] = [];
  const rpcs: ProtoRpc[] = [];
  let curService: string | null = null;
  let depth = 0;
  const rpcRe = /\brpc\s+(\w+)\s*\(\s*(?:stream\s+)?([\w.]+)\s*\)\s*returns\s*\(\s*(?:stream\s+)?([\w.]+)\s*\)/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimStart().startsWith("//")) continue;
    const sm = /^\s*service\s+(\w+)\s*\{?/.exec(line);
    if (sm && curService === null) {
      curService = sm[1]!;
      services.push(curService);
    }
    if (curService !== null) {
      for (const rm of line.matchAll(rpcRe)) {
        rpcs.push({ service: curService, name: rm[1]!, file, line: i + 1, reqType: rm[2]!, respType: rm[3]! });
      }
      depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      if (depth <= 0) { curService = null; depth = 0; }
    }
  }
  return { services, rpcs };
}

/** 生成桩 → proto 回链:优先 `// source: <path>` 权威注释;缺则文件名推导
 * (X_grpc.pb.go/X.pb.go/X_pb2.py/X_pb2_grpc.py/X_grpc_pb.* ↔ X.proto,唯一基名命中才收)。 */
function bindStubToProto(stubFile: string, headText: string, protoByBase: Map<string, string[]>): { proto?: string; via: "source-comment" | "filename"; line?: number } {
  const headLines = headText.split("\n").slice(0, 40);
  for (let i = 0; i < headLines.length; i++) {
    const m = /\/\/\s*source:\s*(\S+)/.exec(headLines[i]!);
    if (m) return { proto: m[1]!, via: "source-comment", line: i + 1 };
  }
  const base = stubFile.split("/").pop()!
    .replace(/_grpc\.pb\.go$/, "").replace(/\.pb\.go$/, "")
    .replace(/_pb2_grpc\.py$/, "").replace(/_pb2\.py$/, "")
    .replace(/_grpc_pb\.(ts|js|d\.ts)$/, "");
  const hits = protoByBase.get(base) ?? [];
  if (hits.length === 1) return { proto: hits[0]!, via: "filename" };
  return { via: "filename" };
}

/**
 * A6 gRPC/Protobuf 桥边:proto service/rpc(权威源,行扫描带行号)↔ 生成桩(source 注释/文件名
 * 推导双通道)↔ Go hand-written 实现(方法名=rpc 名)。客户端调用点进 candidates(medium,帽)。
 */
export async function queryGrpcProtoEdges(root: string): Promise<GrpcProtoSurface> {
  const truncated: string[] = [];
  const base: Omit<GrpcProtoSurface, "state"> = {
    protos: [], edges: [], clientCalls: [], protosWithoutStubs: [], stubsWithoutProto: [],
    stats: { protoFiles: 0, services: 0, rpcs: 0, stubFiles: 0, edges: 0, clientCalls: 0 },
    truncated, knownLimits: GRPC_KNOWN_LIMITS,
  };
  const protoFiles = await rgFiles(root, ["*.proto"]);
  if (protoFiles === null) return { state: "no-proto", ...base, degraded: { reason: "rg 缺席,proto 发现降级" } };
  if (protoFiles.length === 0) return { state: "no-proto", ...base };

  const protoTexts = await readTexts(root, protoFiles.slice(0, 200), 200, truncated);
  const allRpcs: ProtoRpc[] = [];
  const protos: GrpcProtoSurface["protos"] = [];
  for (const [f, text] of protoTexts) {
    const { services, rpcs } = parseProtoFile(f, text);
    protos.push({ file: f, services: services.length, rpcs: rpcs.length });
    allRpcs.push(...rpcs);
  }
  base.protos = protos;

  // 生成桩发现与回链
  const stubGlobs = ["*_grpc.pb.go", "*.pb.go", "*_pb2.py", "*_pb2_grpc.py", "*_grpc_pb.ts", "*_grpc_pb.d.ts", "*_grpc_pb.js"];
  const stubFiles = (await rgFiles(root, stubGlobs)) ?? [];
  const protoByBase = new Map<string, string[]>();
  for (const p of protoFiles) {
    const base2 = p.split("/").pop()!.replace(/\.proto$/, "");
    const arr = protoByBase.get(base2) ?? [];
    arr.push(p);
    protoByBase.set(base2, arr);
  }
  // source 注释回链:读桩文件头(帽 80 个文件)
  const stubBind = new Map<string, { proto?: string; via: "source-comment" | "filename"; line?: number }>();
  const stubHeads = await readTexts(root, stubFiles.slice(0, 80), 80, truncated);
  for (const sf of stubFiles) {
    const head = stubHeads.get(sf) ?? "";
    stubBind.set(sf, bindStubToProto(sf, head, protoByBase));
  }
  // proto → 桩(多桩:go+py 同 proto 可能)
  const protoToStubs = new Map<string, { file: string; via: "source-comment" | "filename"; line?: number }[]>();
  for (const [sf, bind] of stubBind) {
    if (!bind.proto) continue;
    // source 注释的路径可能是仓内相对全路径或与 protoFiles 的 rel 一致
    const rel = protoFiles.includes(bind.proto) ? bind.proto
      : protoFiles.find((p) => bind.proto!.endsWith(p) || p.endsWith(bind.proto!));
    if (!rel) continue;
    const arr = protoToStubs.get(rel) ?? [];
    arr.push({ file: sf, via: bind.via, ...(bind.line ? { line: bind.line } : {}) });
    protoToStubs.set(rel, arr);
  }

  // Go 桩内 FullMethodName 常量行定位(rpc 级证据)
  const goStubConstLine = new Map<string, number>(); // `${stubFile}|${Service}|${Rpc}` → line
  for (const [sf] of stubBind) {
    if (!sf.endsWith("_grpc.pb.go")) continue;
    let text = stubHeads.get(sf);
    if (text === undefined) {
      try { text = await readFile(join(root, sf), "utf8"); } catch { continue; }
    } else {
      // stubHeads 是全文件文本(readTexts 读全文),直接用
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = /(\w+)_(\w+)_FullMethodName\s*=/.exec(lines[i]!);
      if (m) goStubConstLine.set(`${sf}|${m[1]}|${m[2]}`, i + 1);
    }
  }

  const edges: GrpcProtoEdge[] = [];
  const protosWithEdges = new Set<string>();
  for (const rpc of allRpcs) {
    const stubs = protoToStubs.get(rpc.file) ?? [];
    for (const st of stubs) {
      const constLine = goStubConstLine.get(`${st.file}|${rpc.service}|${rpc.name}`);
      edges.push({
        kind: "bridge", bridge: "rpc-proto",
        from: { side: "proto", file: rpc.file, line: rpc.line, service: rpc.service, rpc: rpc.name },
        to: {
          side: "stub", file: st.file, line: constLine ?? st.line ?? 1, via: st.via,
          ...(constLine ? { symbol: `${rpc.service}_${rpc.name}_FullMethodName` } : {}),
        },
        confidence: "high", tier: "structural", evidence: "grep",
        note: `proto 为权威源;生成桩回链=${st.via === "source-comment" ? "// source 注释" : "文件名推导"}${constLine ? "" : "(rpc 常量未定位,桩文件级证据)"}`,
      });
      protosWithEdges.add(rpc.file);
    }
  }

  // Go hand-written 实现:func (recv) RpcName(
  const rpcNames = [...new Set(allRpcs.map((r) => r.name))];
  const serviceOfRpc = new Map<string, string>();
  for (const r of allRpcs) if (!serviceOfRpc.has(r.name)) serviceOfRpc.set(r.name, r.service);
 // rpc 名跨 service 重复(go-grpc-go 注意:Search ∈ SearchService/SearchServiceV3)——
  // 方法名配对归属不可分,实现边降 medium+note(桩边有 service 限定常量,不受影响)
  const rpcNameServices = new Map<string, Set<string>>();
  for (const r of allRpcs) {
    const s = rpcNameServices.get(r.name) ?? new Set<string>();
    s.add(r.service);
    rpcNameServices.set(r.name, s);
  }
  if (rpcNames.length > 0) {
    const implHits: { file: string; line: number; text: string }[] = [];
    for (let i = 0; i < rpcNames.length; i += 60) {
      const chunk = rpcNames.slice(i, i + 60);
      const r = await rgLines(root, `^func\\s*\\([^)]*\\)\\s*(?:${chunk.join("|")})\\s*\\(`, ["*.go", "!*.pb.go"]);
      if (r) implHits.push(...r);
    }
    for (const h of implHits) {
      const m = /^func\s*\([^)]*\)\s*(\w+)\s*\(/.exec(h.text);
      if (!m) continue;
      const rpcsNamed = allRpcs.filter((r) => r.name === m[1]!);
      if (rpcsNamed.length === 0) continue;
      for (const rpc of rpcsNamed) {
        const colliding = rpcsNamed.length > 1;
        edges.push({
          kind: "bridge", bridge: "rpc-proto",
          from: { side: "proto", file: rpc.file, line: rpc.line, service: rpc.service, rpc: rpc.name },
          to: { side: "impl", file: h.file, line: h.line, symbol: m[1]! },
          confidence: colliding ? "medium" : "high", tier: "structural", evidence: "grep",
          note: colliding
            ? `方法名=rpc 名符号配对;rpc 名跨 ${rpcsNamed.length} 个 service 重复,归属歧义降档`
            : "方法名=rpc 名符号配对(hand-written 实现)",
        });
        protosWithEdges.add(rpc.file);
      }
    }
 // 客户端调用点候选(.RpcName(非生成、非定义行)
    const callHits: { file: string; line: number; text: string }[] = [];
    for (let i = 0; i < rpcNames.length; i += 60) {
      const chunk = rpcNames.slice(i, i + 60);
      const r = await rgLines(root, `\\.(?:${chunk.join("|")})\\s*\\(`, ["*.go", "!*.pb.go"]);
      if (r) callHits.push(...r);
    }
    for (const h of callHits.slice(0, 50)) {
      if (/^func\s/.test(h.text.trim())) continue;
      const m = /\.(\w+)\s*\(/.exec(h.text);
      if (!m || !serviceOfRpc.has(m[1]!)) continue;
      base.clientCalls.push({ file: h.file, line: h.line, rpc: m[1]!, service: serviceOfRpc.get(m[1]!)! });
    }
    if (callHits.length > 50) truncated.push(`clientCalls@50(${callHits.length})`);
  }

  base.edges = edges;
  base.protosWithoutStubs = protos.filter((p) => p.rpcs > 0 && !protoToStubs.has(p.file)).map((p) => p.file).slice(0, 50);
  base.stubsWithoutProto = stubFiles.filter((sf) => !stubBind.get(sf)?.proto).slice(0, 50);
  base.stats = {
    protoFiles: protoFiles.length,
    services: protos.reduce((a, p) => a + p.services, 0),
    rpcs: allRpcs.length,
    stubFiles: stubFiles.length,
    edges: edges.length,
    clientCalls: base.clientCalls.length,
  };
  return {
    state: edges.length > 0 ? "grpc-connected" : stubFiles.length === 0 ? "no-stubs" : "no-edges",
    ...base,
  };
}

export function renderGrpcProtoEdges(r: GrpcProtoSurface): string {
  const lines: string[] = [];
  lines.push(`跨语言桥边(rpc-proto): ${r.edges.length} 条边(状态: ${r.state})`);
  lines.push(`  proto ${r.stats.protoFiles} 个(service ${r.stats.services}/rpc ${r.stats.rpcs})· 生成桩 ${r.stats.stubFiles} · 客户端调用候选 ${r.stats.clientCalls}`);
  if (r.degraded) lines.push(`  [降级] ${r.degraded.reason}`);
  for (const e of r.edges.slice(0, 30)) {
    const toDesc = e.to.side === "stub"
      ? `桩 ${e.to.file}:${e.to.line}(${e.to.via === "source-comment" ? "source注释" : "文件名"})`
      : `实现 ${e.to.file}:${e.to.line}  func ${(e.to as { symbol?: string }).symbol ?? ""}`;
    lines.push(`  [${e.confidence === "high" ? "高" : "中"}] ${e.from.service}.${e.from.rpc}`);
    lines.push(`      proto ${e.from.file}:${e.from.line}`);
    lines.push(`      ${toDesc}`);
  }
  if (r.edges.length > 30) lines.push(`  …边共 ${r.edges.length} 条(截断,--json 看全量)`);
  if (r.clientCalls.length > 0) {
    lines.push(`  客户端调用候选(medium,前 10):`);
    for (const c of r.clientCalls.slice(0, 10)) lines.push(`    ${c.service}.${c.rpc} ← ${c.file}:${c.line}`);
  }
  if (r.protosWithoutStubs.length > 0) lines.push(`  有 rpc 无桩的 proto(前 10): ${r.protosWithoutStubs.slice(0, 10).join(", ")}`);
  if (r.stubsWithoutProto.length > 0) lines.push(`  无 proto 回链的桩(前 10): ${r.stubsWithoutProto.slice(0, 10).join(", ")}`);
  if (r.truncated.length > 0) lines.push(`  [截断] ${r.truncated.join("; ")}`);
  return lines.join("\n");
}

// ============================ 文本渲染(CLI/工具同源) ============================

export function renderBridgeEdges(r: BridgeSurface): string {
  const lines: string[] = [];
  const s = r.stats;
  lines.push(`跨语言桥边(http-api): ${s.edges} 条正式边 / ${s.candidates} 条候选(状态: ${r.state})`);
  lines.push(`  端点覆盖: exact ${s.endpointsExactUnion}/${s.endpoints}(原生 ${s.endpointsExactNative} + 折叠 ${s.endpointsExactFolded})· 仅部分配对 ${s.endpointsFirst2Only} · 无配对 ${s.endpointsUnmatched}`);
  lines.push(`  前端字面量: ${s.literalOccurrences} 命中点(${s.literalsUnique} 唯一)+ 折叠 ${s.foldedLiterals};未参与配对 ${r.unmatchedLiteralCount};1段前缀命中 ${s.prefix1segHits}(仅计数)`);
  // 诚实原则:过滤发生时显式呈报(docs/examples/tutorial/mocks 下的前端字面量不作证据)
  if (r.pathFilter && r.pathFilter.note) lines.push(`  [路径过滤] ${r.pathFilter.note}`);
  if (r.degraded) lines.push(`  [降级] ${r.degraded.reason}`);
  const show = r.edges.slice(0, 40);
  for (const e of show) {
    const conf = e.confidence === "high" ? "高" : "中";
    lines.push(`  [${e.match}|${conf}] ${e.to.method} ${e.to.path}`);
    lines.push(`      前端 ${e.from.file}:${e.from.line}  \`${e.from.literal}\`${e.from.foldedFrom ? `(折叠自 ${e.from.foldedFrom})` : ""}`);
    lines.push(`      后端 ${e.to.file}:${e.to.line}${e.to.handler ? `  → ${e.to.handler}` : ""}  [${e.to.framework}]`);
  }
  if (r.edges.length > show.length) lines.push(`  …边共 ${r.edges.length} 条(截断,--json 看全量)`);
  if (r.candidates.length > 0) {
    lines.push(`  候选(first2 部分配对,低置信未入正式边,前 10):`);
    for (const c of r.candidates.slice(0, 10)) {
      lines.push(`    ${c.to.method} ${c.to.path} ← ${c.from.file}:${c.from.line} \`${c.from.literal}\``);
    }
  }
  if (r.unmatchedEndpoints.length > 0) {
    lines.push(`  无前端配对的端点(前 ${Math.min(10, r.unmatchedEndpoints.length)} / 共 ${s.endpointsUnmatched}):`);
    for (const u of r.unmatchedEndpoints.slice(0, 10)) lines.push(`    ${u.method} ${u.path} @${u.file}:${u.line}`);
  }
  if (r.truncated.length > 0) lines.push(`  [截断] ${r.truncated.join("; ")}`);
  lines.push(`  [已知边界] ${KNOWN_LIMITS.length} 类静态不可行形态登记(--json 见 knownLimits),不产边`);
  return lines.join("\n");
}

/** LLM 消歧候选区文本渲染(CLI --candidates / 工具消费;与 renderBridgeEdges 分离)。 */
export function renderBridgeCandidates(r: BridgeCandidateSurface): string {
  const lines: string[] = [];
  const s = r.stats;
  lines.push(`LLM 消歧候选区(http-api): ${r.candidates.length} 条候选 / 确定性边 ${r.deterministicEdges} 条(不在候选区)`);
  lines.push(`  端点: ${s.endpoints} 个;已有确定性边 ${s.endpointsExact} 个(不产候选);参与候选判定 ${s.endpointsConsidered} 个`);
  lines.push(`  候选分档: first2 ${s.first2} · prefix1 ${s.prefix1} · 帽截断 ${s.capped} · 无候选端点 ${s.unmatchedEndpoints}`);
  if (r.pathFilter?.note) lines.push(`  [路径过滤] ${r.pathFilter.note}`);
  if (r.degraded) lines.push(`  [降级] ${r.degraded.reason}`);
  if (r.candidates.length === 0) {
    lines.push(`  (零候选:所有端点要么已有确定性 exact 边,要么前 2 段不匹配/可信度闸拦截)`);
  }
  const show = r.candidates.slice(0, 20);
  for (const c of show) {
    const conf = c.confidence === "medium" ? "中" : "低";
    lines.push(`  [${c.match}|${conf}|semantic] ${c.to.method} ${c.to.path}`);
    lines.push(`      前端 ${c.from.file}:${c.from.line}  \`${c.from.literal}\`${c.from.foldedFrom ? `(折叠自 ${c.from.foldedFrom})` : ""}`);
    lines.push(`      后端 ${c.to.file}:${c.to.line}${c.to.handler ? `  → ${c.to.handler}` : ""}  [${c.to.framework}]`);
    lines.push(`      理由: ${c.reason}`);
    for (const e of c.evidence) lines.push(`      · ${e}`);
  }
  if (r.candidates.length > show.length) lines.push(`  …候选共 ${r.candidates.length} 条(截断,--json 看全量)`);
  if (r.truncated.length > 0) lines.push(`  [截断] ${r.truncated.join("; ")}`);
  lines.push(`  [纪律] tier=semantic 候选仅供 LLM 消歧;确定性边仍以 exact/exact-folded 为准,两者不混`);
  return lines.join("\n");
}
