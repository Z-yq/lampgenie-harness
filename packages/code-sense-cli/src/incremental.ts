/**
 * 增量索引引擎(code-sense-cli 独有;code-sense 核心库零改动,只消费其导出):
 *
 * 目标(2026-10-15 G4 补充):`init ./aa` → `init ./bb` → `init ./` 的重叠子树不得重复探索——
 * 按「相对路径 + 文件指纹(mtime+size)」粒度复用既有文件数据:同一文件直接搬运其节点/边,
 * 变了/新出现才重扫;init/index 输出「复用 N 文件 / 新扫 M 文件」。
 *
 * 正确性边界(如实):
 *  - 节点:按文件归属搬运,文件未变=节点逐字段等价。
 *  - 边:搬运「调用方文件未变」的边;其 to 指向已变/已删文件的,先降级 unresolved,
 *    再走 relink(唯一裸名+同扩展名闸,镜像 engine resolveStructCrossFile 语义;DENY 名单
 *    沿用 engine 的 METHOD_FALLBACK_DENY,绝不造 engine 会主动压制的假边)。
 *  - 增量模式对「变更文件→未变更文件」的调用,子图内无 import 证据,走唯一名兜底:
 *    同名歧义的边会缺失(全量重建恢复,--force)。这是与全量 build 的已知精度差,诚实登记。
 *  - trunk/leaf 重分类:类节点豁免(类 id 全量路径记入 sidecar.classes;无记录的搬运文件=
 *    同文件 container 前缀启发式兜底),函数节点从合并后边集重算(namedIn 语义与 c2f classify 一致)。
 *  - index.srcMtime/srcCount 用 code-sense 的 srcFingerprint(与 indexStale 同口径)——
 *    自建走查的 4000 上限/深度语义与库有微差,会造出「永远差一个文件」的假过期,必须同源。
 *  - 指纹=mtimeMs+size:drvfs/网络盘不引 hash(全量 hash 4k 文件在慢盘代价过高);
 *    mtime 粒度足够区分编辑,size 兜底截断误判。指纹 sidecar 与索引同目录,同进退。
 *  - 版本闸(2026-10-21):指纹只证明源码没变,不证明抽取结果没过期——sidecar/索引须同时
 *    记录当前 INDEX_EXTRACTOR_VERSION 才允许搬运;旧版产物=一次全量重扫迁移(随后恢复增量)。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
// 单一真相=code-sense:engine 子路径拿图构建,根出口拿 c2f 索引面(与 MCP/gateway 同源)
import {
  buildCallGraph, buildCallGraphFromFiles, listSourceFilesDetailed, maxFilesDefault, MODULE_CALLER,
  isNonCallableSymbolKind, INDEX_EXTRACTOR_VERSION,
  type CallGraph,
} from "@lampgenie/code-sense/callgraph/engine";
import {
  classify, saveIndex, loadIndex, gitHeadSha, srcFingerprint, indexDir, expandGoImports, applyJsxComponentUsage,
  type C2fIndex, type C2fNode, type C2fEdge,
} from "@lampgenie/code-sense/callgraph/c2f";
import { computeIndexBridge } from "@lampgenie/code-sense/callgraph/index-bridge";
import { computeLanguageCoverage, coverageVerdict, type LanguageCoverage } from "@lampgenie/code-sense/callgraph/coverage";
import {
  loadSidecar, loadIndexMigrated, overlappingRoots, saveSidecar, statFingerprint,
  normalizeRoot, canonicalPath,
  type FileFingerprint, type FingerprintSidecar,
} from "./registry.js";
import { acquireBuildLock, releaseBuildLock, type LockInfo } from "./build-lock.js";
import { estimateIndexMemory, applyBudgetReduce } from "./heap-budget.js";

/** 同根已有索引在飞时的礼貌拒绝(step-086 单飞锁;cli.ts 捕获后 exit 3)。 */
export class IndexBusyError extends Error {
  constructor(root: string, info: LockInfo | null, waitedMs: number) {
    const who = info
      ? `pid ${info.pid}(${info.holder}${info.startedAt ? `,${info.startedAt} 起` : ""}${info.host ? `@${info.host}` : ""})`
      : "未知持有者";
    super(`同一根已有索引在飞,未重复索引: ${root}\n  持有者: ${who};本请求等待 ${(waitedMs / 1000).toFixed(0)}s 超时。\n  处理:等在飞构建完成(产物自动复用),或 GENIE_SENSE_INDEX_LOCK_WAIT_MS 调大等待上限。`);
    this.name = "IndexBusyError";
  }
}

export interface BuildOutcome {
  root: string;
  index: C2fIndex;
  indexDir: string;
  /** 复用(未重扫)文件(target 相对路径)。 */
  reused: string[];
  /** 新扫/重扫文件。 */
  scanned: string[];
  buildMs: number;
  mode: "incremental" | "full";
  fingerprints: Record<string, FileFingerprint>;
  relinked: number;
  /** 本次产物记录的抽取器版本(= engine INDEX_EXTRACTOR_VERSION)。 */
  extractorVersion: number;
  /** 旧 sidecar/索引的抽取器版本与当前不一致,触发一次版本迁移全量重扫(from=旧版本,
   * to=当前)。只在本轮确实发生迁移(而非首次构建/--force)时出现。 */
  versionMigration?: { from: number; to: number };
}

const GHOST_SUFFIX = "#" + MODULE_CALLER;

/** rel 路径统一 “/” 分隔(索引键口径;c2f 产物同口径)。 */
function toRelSep(root: string, abs: string): string {
  return abs.slice(root.length + 1).split("\\").join("/");
}

/** 先验 id/路径重映射:prior 相对段加/剥前缀,保持 `<path>#<sym>` 形态。
 * dir=add:prior 是 target 的后代(prior 短路径 → target 长路径);
 * dir=strip:prior 是 target 的祖先或自身同段(去交集段)。 */
function remapId(id: string, seg: string, dir: "add" | "strip"): string {
  if (!seg) return id;
  const hash = id.lastIndexOf("#");
  const path = hash >= 0 ? id.slice(0, hash) : id;
  const sym = hash >= 0 ? id.slice(hash) : "";
  if (dir === "add") return `${seg}/${path}${sym}`;
  return path.startsWith(seg + "/") ? path.slice(seg.length + 1) + sym : id;
}

function remapRel(rel: string, seg: string, dir: "add" | "strip"): string {
  if (!seg) return rel;
  if (dir === "add") return `${seg}/${rel}`;
  return rel.startsWith(seg + "/") ? rel.slice(seg.length + 1) : rel;
}

/** 先验映射(target↔prior 相对路径互转)。 */
interface PriorMapping {
  seg: string;
  dir: "add" | "strip";
  toPriorRel(targetRel: string): string | null;
}

function priorMapping(target: string, priorRoot: string): PriorMapping | null {
  const t = normalizeRoot(target);
  const p = normalizeRoot(priorRoot);
  if (p === t) return { seg: "", dir: "strip", toPriorRel: (tr) => tr };
  if (p.startsWith(t + sep)) {
    const seg = relative(t, p).split(sep).join("/");
    return { seg, dir: "add", toPriorRel: (tr) => (tr.startsWith(seg + "/") ? tr.slice(seg.length + 1) : null) };
  }
  if (t.startsWith(p + sep)) {
    const seg = relative(p, t).split(sep).join("/");
    return { seg, dir: "strip", toPriorRel: (tr) => `${seg}/${tr}` };
  }
  return null; // 不重叠(调用方由 overlappingRoots 保证,防御)
}

/** 扫描 root 文件集与指纹(engine 同口径走 listSourceFilesDetailed:扩展名/跳过目录/上限一致,
 * 截断元数据如实透出进 coverage manifest——step-079 RC-G)。
 * 指纹键=规范化绝对路径(realpath):同一物理目录经不同父 cwd/路径拼写(符号链接)发起的
 * init/增量命中同一批键;rel 列表仍是 engine 口径(喂 buildCallGraphFromFiles/报告)。 */
interface ScanEntry { rel: string; abs: string; fp: FileFingerprint }

async function scanFingerprints(root: string): Promise<{ rels: string[]; entries: ScanEntry[]; fps: Record<string, FileFingerprint>; truncated?: { reason: string; limit?: number } }> {
  const scan = await listSourceFilesDetailed(root);
  const absFiles = scan.files;
  const rels: string[] = [];
  const entries: ScanEntry[] = [];
  const fps: Record<string, FileFingerprint> = {};
  for (const abs of absFiles) {
    const rel = toRelSep(root, abs);
    const canon = canonicalPath(abs);
    const fp = statFingerprint(canon);
    if (!fp) continue; // 扫描间隙消失:本轮不收(与引擎盲区语义一致)
    rels.push(rel);
    entries.push({ rel, abs: canon, fp });
    fps[canon] = fp; // sidecar 落盘形态:键=规范绝对路径
  }
  return {
    rels, entries, fps,
    ...(scan.truncated ? { truncated: { reason: `扫描达文件上限 ${scan.limit}(磁盘实见 ${scan.totalSeen ?? `${scan.limit}+`},GENIE_SENSE_MAX_FILES 可调;超限按语言配额公平采样),可能存在未扫描文件`, limit: scan.limit } } : {}),
  };
}

interface Carried { nodes: C2fNode[]; edges: C2fEdge[]; classes: Set<string>; classesKnown: boolean }

/** 大数组 push(step-085:spread 形态在 16 万+元素时超 V8 调用栈参数上限 → RangeError
 * 「Maximum call stack size exceeded」整仓索引死;grafana 6000 文件 16.7 万边实测,
 * step-081 4000 文件 11.2 万边属贴线幸存)。逐条循环 push,行为等价。 */
function pushAll<T>(dst: T[], src: Iterable<T>): void {
  for (const x of src) dst.push(x);
}

/** 复用收集结果:搬运表 + 版本迁移诊断。 */
interface ReuseCollection {
  /** target 相对路径 → 可搬运的节点/边快照。 */
  carried: Map<string, Carried>;
  /** 指纹命中、但产出它的抽取器版本与当前不一致而拒绝复用的文件数。 */
  versionBlocked: number;
  /** 被拒来源的旧抽取器版本(取最大;无旧版/无被拒=undefined)。 */
  oldExtractorVersion?: number;
  /** 目标自身旧产物的抽取器版本(存在且与当前不一致;无自身产物=undefined)。
   * 用于纯类型文件等「旧索引 0 节点、无文件可搬运」的根:仍能如实报告版本迁移。 */
  selfExtractorVersion?: number;
}

/** 收集可复用文件:重叠 root(注册表)+ 目标自身旧产物,索引+sidecar 指纹双证,
 * 按「近者优先(路径更深)」认领。自复用不需要 init 登记——`codesense index` 单独跑也有增量。
 * 指纹命中=规范绝对路径直查(sidecar v2);prior 索引内容定位仍按 prior 相对路径
 * (索引 id/路径是 prior 根相对口径,搬运时经 seg/dir 重映射)。
 *
 * 版本闸(2026-10-21 验收缺口 1):指纹只证明「源码没变」,不证明「抽取结果仍是最新」——
 * sidecar 与索引都必须记录当前 INDEX_EXTRACTOR_VERSION 才允许搬运。旧产物(无字段=
 * 隐式 v1)一律拒绝复用,由调用方触发一次全量重扫并落新版本。 */
function collectReusables(root: string, entries: ScanEntry[]): ReuseCollection {
  const out = new Map<string, Carried>();
  let versionBlocked = 0;
  let oldExtractorVersion: number | undefined;
  let selfExtractorVersion: number | undefined;
  const tryCarry = (priorRoot: string, seg: string, dir: "add" | "strip", toPriorRel: (tr: string) => string | null, self = false): void => {
    const pIdx = loadIndexMigrated(priorRoot); // 迁移形态:旧 hash 目录里的 index.json 也可作搬运源
    if (!pIdx) return;
    const side = loadSidecar(priorRoot); // 迁移形态:载入时已做旧根→当前根键重映射
    if (!side) return; // 无指纹:无法证明文件未变,不复用(诚实)
    // 版本闸:sidecar 与索引双证(任一侧缺字段=旧产物)。单看 sidecar 可能遇到
    // 「index 被其它构建路径重写」的混杂态;单看索引则漏掉指纹来源的换代。
    // 缺字段=隐式 v1(不是 0):历史产物一律视作第一代抽取器。
    const priorVer = side.extractorVersion ?? 1;
    const idxVer = pIdx.extractorVersion ?? 1;
    const versionOk = priorVer === INDEX_EXTRACTOR_VERSION && idxVer === INDEX_EXTRACTOR_VERSION;
    // 自身上次产物换代:即使没有任何文件可搬运(纯类型文件旧索引 0 节点),也算一次版本迁移
    if (self && !versionOk) selfExtractorVersion = Math.min(priorVer, idxVer);
    for (const e of entries) {
      const targetRel = e.rel;
      if (out.has(targetRel)) continue; // 近者已认领
      const priorRel = toPriorRel(targetRel);
      if (priorRel === null) continue; // 不在 prior 子树
      const old = side.files[e.abs]; // 指纹命中=规范绝对路径直查(v2 键)
      if (!old) continue;
      if (old.mtime !== e.fp.mtime || old.size !== e.fp.size) continue; // 变了:重扫
      const priorNodes = pIdx.nodes.filter((n) => n.file === priorRel);
      if (priorNodes.length === 0) continue; // prior 索引没这文件(构建盲区):不冒充复用
      if (!versionOk) {
        // 本可复用、但抽取器换代:拒绝搬运,登记迁移信号(由 buildLocked 全量重扫一次)
        versionBlocked++;
        // 混杂态取较老的一侧:任一侧是旧代,搬运内容的来源代际即按旧代记账
        const stale = Math.min(priorVer, idxVer);
        if (oldExtractorVersion === undefined || stale > oldExtractorVersion) oldExtractorVersion = stale;
        continue;
      }
      const priorEdges = pIdx.edges.filter((e2) => e2.file === priorRel);
      out.set(targetRel, {
        nodes: priorNodes.map((n) => ({ ...n, id: remapId(n.id, seg, dir), file: targetRel })),
        edges: priorEdges.map((e) => ({
          ...e,
          from: remapId(e.from, seg, dir),
          to: e.to ? remapId(e.to, seg, dir) : "",
          file: targetRel,
        })),
        classes: new Set((side.classes ?? []).map((id) => remapId(id, seg, dir))),
        classesKnown: Array.isArray(side.classes),
      });
    }
  };
  for (const prior of overlappingRoots(root)) {
    const map = priorMapping(root, prior.root);
    if (map) tryCarry(prior.root, map.seg, map.dir, map.toPriorRel);
  }
  // 自复用(target 自身上次产物):seg 空,相对路径直用
  tryCarry(root, "", "strip", (tr) => tr, true);
  return {
    carried: out,
    versionBlocked,
    ...(oldExtractorVersion !== undefined ? { oldExtractorVersion } : {}),
    ...(selfExtractorVersion !== undefined ? { selfExtractorVersion } : {}),
  };
}

function addToSetMap(m: Map<string, Set<string>>, key: string, val: string): void {
  const s = m.get(key);
  if (s) s.add(val);
  else m.set(key, new Set([val]));
}

/** 合并后重算出入度与 trunk/leaf/regular(语义=c2f classify:namedIn 排除 <module> 虚调用方;
 * 类节点豁免恒 regular;step-079:lexical 档与 typedef/variable 符号同样豁免——它们没有调用边,
 * 落 trunk 会污染 entrypoints,与 classify 的 isAux 规则同源镜像;2026-10-21:interface/type/enum
 * 同列声明豁免(isNonCallableSymbolKind 单一真相)。 */
function recount(nodes: C2fNode[], edges: C2fEdge[], classIds: Set<string>): void {
  const outTargets = new Map<string, Set<string>>();
  const namedIn = new Map<string, Set<string>>();
  for (const e of edges) {
    addToSetMap(outTargets, e.from, e.to || `ext:${e.from}@${e.line}:${e.toName ?? "?"}`);
    if (e.to && !e.from.endsWith(GHOST_SUFFIX)) addToSetMap(namedIn, e.to, e.from);
  }
  const isAux = (n: C2fNode): boolean =>
    classIds.has(n.id) || n.tier === "lexical" || (n.symKind !== undefined && isNonCallableSymbolKind(n.symKind));
  for (const n of nodes) {
    n.outCount = outTargets.get(n.id)?.size ?? 0;
    n.inCount = namedIn.get(n.id)?.size ?? 0;
    n.kind = isAux(n) ? "regular" : n.inCount === 0 ? "trunk" : n.outCount === 0 ? "leaf" : "regular";
  }
}

/** relink:unresolved 边按唯一裸名+同扩展名解析(镜像 engine 的唯一名兜底;
 * 压制名单=各快照不兜底语义的并集,被引擎压制的调用绝不借此还魂)。返回 relink 数。
 * step-079:lexical/typedef/variable 节点不作解析目标——调用边的语义目标是函数/方法,
 * 同名词法声明吸收边=假边(lexical 不参与 callers/callees 精度口径)。
 * 2026-10-21:interface/type/enum 同列(isNonCallableSymbolKind)。 */
function relink(nodes: C2fNode[], edges: C2fEdge[], suppressed: Set<string>): number {
  const extOf = (f: string) => f.slice(f.lastIndexOf("."));
  const byBare = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.tier === "lexical" || (n.symKind !== undefined && isNonCallableSymbolKind(n.symKind))) continue;
    const bare = n.name.includes(".") ? n.name.slice(n.name.lastIndexOf(".") + 1) : n.name;
    const list = byBare.get(bare) ?? [];
    list.push(n.id);
    byBare.set(bare, list);
  }
  let hits = 0;
  for (const e of edges) {
    if (e.to || !e.toName || suppressed.has(e.toName)) continue;
    // 2026-10-26 作用域闸:属性调用(x.trim()/fs.readFile)、局部参数/变量、外部包 import
    // 不得按全仓唯一同名跨文件兜底——engine 语义早已如此,relink 旧实现绕过它造出
    // code-sense→harness-terminal ×422 的假主干。工作区 import(callForm=import)保留 relink:
    // ts-morph 解析不到 @lampgenie/* 源文件时,唯一名兜底是真实跨包边的最后通道。
    if (e.callForm === "prop" || e.callForm === "bound" || e.callForm === "external") continue;
    const ids = byBare.get(e.toName);
    if (!ids || ids.length !== 1) continue;
    const target = nodes.find((n) => n.id === ids[0]);
    if (!target || extOf(target.file) !== extOf(e.file)) continue;
    e.to = target.id;
    e.kind = "unique";
    hits++;
  }
  return hits;
}

/** relink 的压制名单=engine 各快照「不唯一名兜底」语义的并集:
 * 旧 engine 快照导出 METHOD_FALLBACK_DENY(属性调用内建成员黑名单),新快照改为
 * INJECTED_GLOBALS(测试框架注入全局)且属性调用一律不兜底。消费端对导出名不做静态依赖
 * (并发线在途时两形态并存),动态读 + 并集=任何快照下 relink 都不会造 engine 会压制的边。 */
async function relinkSuppression(): Promise<Set<string>> {
  const mod = (await import("@lampgenie/code-sense/callgraph/engine")) as {
    METHOD_FALLBACK_DENY?: Set<string>;
    INJECTED_GLOBALS?: Set<string>;
  };
  const out = new Set<string>();
  for (const s of [mod.METHOD_FALLBACK_DENY, mod.INJECTED_GLOBALS]) {
    if (s) for (const name of s) out.add(name);
  }
  return out;
}

/** byFile/byName(镜像 c2f buildByMaps:方法名裸名并列 + 无原型对象防符号名撞 Object.prototype)。 */
function buildMaps(nodes: C2fNode[]): { byFile: Record<string, string[]>; byName: Record<string, string[]> } {
  const byFile = Object.create(null) as Record<string, string[]>;
  const byName = Object.create(null) as Record<string, string[]>;
  for (const n of nodes) {
    (byFile[n.file] ??= []).push(n.id);
    (byName[n.name] ??= []).push(n.id);
    const dot = n.name.lastIndexOf(".");
    if (dot > 0) {
      const bare = n.name.slice(dot + 1);
      const list = (byName[bare] ??= []);
      if (!list.includes(n.id)) list.push(n.id);
    }
  }
  return { byFile, byName };
}

function gitHeadRaw(root: string): string {
  try {
    return readFileSync(join(root, ".git", "HEAD"), "utf-8").trim();
  } catch {
    return "";
  }
}

/** 类节点 rel id 集(engine 符号 kind=class,精确)。 */
function exactClassIds(graph: CallGraph, root: string): Set<string> {
  const ids = new Set<string>();
  for (const s of graph.symbols.values()) {
    if (s.kind === "class") ids.add(toRelSep(root, s.id.slice(0, s.id.lastIndexOf("#"))));
  }
  return ids;
}

/** 启发式类集(旧产物无 classes 记录时的兜底):节点名恰为同文件某方法 container 且自身无 container。 */
function heuristicClassIds(nodes: C2fNode[], onlyFiles: Set<string> | null): Set<string> {
  const ids = new Set<string>();
  const containers = new Set(nodes.filter((n) => n.container).map((n) => `${n.file}#${n.container}`));
  for (const n of nodes) {
    if (n.container) continue;
    if (onlyFiles && !onlyFiles.has(n.file)) continue;
    if (containers.has(`${n.file}#${n.name}`)) ids.add(n.id);
  }
  return ids;
}

/**
 * 带复用的索引构建。
 *  - force=true:全量重建(仍走 buildCallGraph+classify 单一真相,只是不做搬运)。
 *  - 默认:重叠 root 的 sidecar 指纹比对 → 未变文件搬节点/边,变更文件子图重扫 → 合并+
 *    revalidate+relink+重分类。无可复用先验=退化为全量(mode="full")。
 *  - step-086 单飞锁:全程持同根 build.lock(跨进程单飞;忙则等待复用在飞结果,超时礼貌拒绝);
 *  - step-086 堆预算:构建前估算内存,超预算自动按 RC-L 公平采样降数(GENIE_SENSE_MAX_FILES,
 *    截断如实登记进 coverage)——heapBudget="off" 可关(测试/确知小仓)。
 */
export async function buildIndexWithReuse(root: string, opts: { force?: boolean; onProgress?: (msg: string) => void; heapBudget?: "auto" | "off"; lockWaitMs?: number } = {}): Promise<BuildOutcome> {
  const t0 = Date.now();
  const progress = opts.onProgress ?? (() => {});
  // 不存在的路径拒绝索引(此前会静默写一份空索引+空 sidecar,迁移发现的「最新者」会被它污染)
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`根不存在或不是目录: ${root}`);
  }
  // 堆预算自适应(RC-K2):risk 档设 GENIE_SENSE_MAX_FILES 降数,引擎照常公平采样+登记截断。
  let heapNote = "";
  if (opts.heapBudget !== "off") {
    try {
      const est = await estimateIndexMemory(root);
      if (est.tier === "risk") {
        const reduced = applyBudgetReduce(est);
        progress(`堆预算: 估算 ${est.estMb}MB > 预算 ${est.budgetMb}MB${reduced ? `,按公平采样降数 ${reduced} 文件` : ""}(建议堆帽 ${est.recommendedHeapMb}MB)`);
        heapNote = `;堆预算自适应采样(估算 ${est.estMb}MB > 预算 ${est.budgetMb}MB,降数 ${reduced ?? "失败"})`;
      } else if (est.tier === "warn") {
        progress(`堆预算: 估算 ${est.estMb}MB 贴预算线 ${est.budgetMb}MB(建议堆帽 ${est.recommendedHeapMb}MB)`);
      }
    } catch {
      /* 估算失败不拦构建(RC-K2 是防御层,非前置门) */
    }
  }
  // 同根单飞锁:忙→等在飞构建完成(其产物落盘后本进程增量复用,近零成本);等不到→礼貌拒绝。
  const lock = await acquireBuildLock(root, {
    holder: "cli",
    ...(opts.lockWaitMs !== undefined ? { waitMs: opts.lockWaitMs } : {}),
    onWait: (info) => progress(`同根索引在飞(pid ${info.pid}),等待其完成…`),
  });
  if (!lock.ok) throw new IndexBusyError(root, lock.info, lock.waited);
  try {
    return await buildLocked(root, opts, progress, t0, heapNote);
  } finally {
    releaseBuildLock(root);
  }
}

/** 采样索引的删除/编辑检出取样集(step-141):按字典序排序后等距取 ≤64 条(相对路径+mtime)。
 * 目的不是「覆盖全部文件」而是「采样对应集的删除/编辑能被廉价检出」——采样集外的变化在采样
 * 索引上不可靠检出(采样统计口径与查询期全量 walk 不可比),由 samplingNote 如实说明。 */
export function sampleCheckSet(rels: readonly string[], mtimeOf: (rel: string) => number, cap = 64): { rel: string; mtime: number }[] {
  if (rels.length === 0) return [];
  const sorted = [...rels].sort();
  const picked = sorted.length <= cap
    ? sorted
    : Array.from({ length: cap }, (_, i) => sorted[Math.floor(i * (sorted.length / cap))]!);
  const seen = new Set<string>();
  const out: { rel: string; mtime: number }[] = [];
  for (const rel of picked) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    out.push({ rel, mtime: mtimeOf(rel) });
  }
  return out;
}

async function buildLocked(root: string, opts: { force?: boolean }, progress: (msg: string) => void, t0: number, heapNote: string): Promise<BuildOutcome> {
  const { rels, entries, fps, truncated: scanTruncated } = await scanFingerprints(root);
  progress(`扫描 ${rels.length} 个源文件`);

  const reuse: ReuseCollection = opts.force
    ? { carried: new Map<string, Carried>(), versionBlocked: 0 }
    : collectReusables(root, entries);
  const reusables = reuse.carried;
  const changed = rels.filter((r) => !reusables.has(r));
  const mode: "incremental" | "full" = reusables.size > 0 ? "incremental" : "full";
  // 版本迁移=「旧产物本可复用,但抽取器已换代」且本轮没有任何当前版来源可搬 → 全量重扫一次。
  // 与 --force(用户显式要求)/ 首次构建(无先验)区分:只在有版本证据时成立,避免误报。
  // 证据两路:①有指纹命中文件被版本闸拒绝(versionBlocked>0);②目标自身旧索引/指纹换代
  // (纯类型文件旧索引 0 节点时没有文件可拒绝,但产物仍是旧代)。
  const legacyVersion = reuse.selfExtractorVersion ?? reuse.oldExtractorVersion;
  const versionMigration = !opts.force && reusables.size === 0 && legacyVersion !== undefined
    ? { from: legacyVersion, to: INDEX_EXTRACTOR_VERSION }
    : undefined;

  const nodes: C2fNode[] = [];
  const edges: C2fEdge[] = [];
  const classIds = new Set<string>();
  let freshGraph: CallGraph | null = null;

  if (mode === "full") {
    // 构建日志区分两种原因:版本升级全量重扫 vs 首次/无先验全量(验收缺口 1 可排查性)。
    progress(versionMigration
      ? `版本升级全量重扫(抽取器 v${versionMigration.from} → v${versionMigration.to}${reuse.versionBlocked > 0 ? `;${reuse.versionBlocked} 文件因旧版抽取结果不复用` : ""})`
      : `全量解析 ${changed.length} 文件(ts-morph / 结构 adapter)`);
    freshGraph = await buildCallGraph(root);
    const cls = classify(freshGraph, root);
    pushAll(nodes, cls.nodes);
    pushAll(edges, cls.edges);
    for (const id of exactClassIds(freshGraph, root)) classIds.add(id);
  } else {
    const classesMissingFiles = new Set<string>();
    for (const [file, c] of reusables) {
      pushAll(nodes, c.nodes);
      pushAll(edges, c.edges);
      for (const id of c.classes) classIds.add(id);
      if (!c.classesKnown) classesMissingFiles.add(file);
    }
    progress(`增量复用 ${reusables.size} 文件 / 新扫 ${changed.length} 文件${reuse.versionBlocked > 0 ? `(另 ${reuse.versionBlocked} 文件因抽取器版本升级重扫)` : ""}`);
    if (changed.length > 0) {
      freshGraph = await buildCallGraphFromFiles(root, changed);
      const cls = classify(freshGraph, root);
      pushAll(nodes, cls.nodes);
      pushAll(edges, cls.edges);
      for (const id of exactClassIds(freshGraph, root)) classIds.add(id);
    }
    // 搬运边的 to 指向已变/已删文件:降级 unresolved(relink 给一次唯一名机会)
    const idSet = new Set(nodes.map((n) => n.id));
    for (const e of edges) {
      if (e.to && !idSet.has(e.to)) {
        e.to = "";
        e.kind = "unresolved";
      }
    }
    for (const id of heuristicClassIds(nodes, classesMissingFiles)) classIds.add(id);
  }

  const { byFile, byName } = buildMaps(nodes);
  const relinked = relink(nodes, edges, await relinkSuppression());
  recount(nodes, edges, classIds);
  // step-098(RC-096-A2②):JSX 使用证据降权——必须在 recount 之后(recount 会按边集把
  // 搬运节点的 kind 重算回 trunk,JSX 降权最后跑才不被覆盖;单一实现=code-sense 导出)。
  applyJsxComponentUsage(root, rels, nodes);

  // importers(step-066 impact 的 import 通道):精确增量语义——
  // 全量=全图 imports;增量=上一版 importers 剔除本轮变更文件的贡献,再并上变更文件的新贡献
  // (freshGraph 只解析变更文件,其 imports 恰好只含变更文件的边,两边拼起来仍是全量真值)。
  // 旧版索引无该字段=undefined,impact 查询侧显式降级。
  // step-099 RC-B2 两点修正:①Go 结构档 import 经同一 expandGoImports(与全量 buildC2fIndex
  // 同函数同口径)并入——展开用的目标文件集=合并后 byFile 全量键(含未变更文件,跨包映射
  // 不因增量视野收窄);②字段恒写(空也写 {}):字段在场=构建版本支持 import 通道,
  // 纯 Go 仓 fresh 重建不再被误判「旧格式索引」(096 评测 RC-B2 实锤)。
  const prev = loadIndex(root);
  let importers: Record<string, string[]> | undefined = prev?.importers
    ? Object.fromEntries(Object.entries(prev.importers).map(([k, v]) => [k, [...v]]))
    : undefined;
  if (importers && changed.length > 0) {
    const changedSet = new Set(changed);
    for (const k of Object.keys(importers)) {
      if (importers[k]!.some((f) => changedSet.has(f))) importers[k] = importers[k]!.filter((f) => !changedSet.has(f));
    }
  }
  if (freshGraph?.imports && freshGraph.imports.size > 0) {
    importers ??= {};
    for (const [target, froms] of freshGraph.imports) {
      const rel = target.replace(root + "/", "");
      const list = importers[rel] ?? (importers[rel] = []);
      for (const f of froms) {
        const rf = f.replace(root + "/", "");
        if (!list.includes(rf)) list.push(rf);
      }
    }
  }
  if (freshGraph?.structFileImports && freshGraph.structFileImports.size > 0) {
    importers ??= {};
    const goEdges = expandGoImports(root, freshGraph.structFileImports, Object.keys(byFile));
    for (const [target, froms] of goEdges) {
      const rel = target.replace(root + "/", "");
      const list = importers[rel] ?? (importers[rel] = []);
      for (const f of froms) {
        const rf = f.replace(root + "/", "");
        if (!list.includes(rf)) list.push(rf);
      }
    }
  }

  // step-099 RC-B5:弃边台账增量合并——语义折衷如实登记:逐名字粒度「变更文件碰到即整条剔除,
  // 再并本轮新台账」。同名候选横跨未变更文件时,其旧计数会一并剔除(样本只存 ≤3 不足反推),
  // 该名字的计数在下次全量重建前可能偏低——接受(诊断面非正确性面;全量重建是权威)。
  let dropped: C2fIndex["dropped"];
  let droppedNames: number | undefined;
  {
    const merged = new Map<string, { count: number; reasons: Record<string, number>; samples: { file: string; line: number }[] }>();
    if (prev?.dropped) {
      const changedSet = new Set(changed);
      for (const [name, e] of Object.entries(prev.dropped)) {
        if (changed.length > 0 && e.samples.some((s) => changedSet.has(s.file))) continue;
        merged.set(name, { count: e.count, reasons: { ...e.reasons }, samples: [...e.samples] });
      }
    }
    if (freshGraph?.droppedCandidates) {
      for (const [name, e] of freshGraph.droppedCandidates) {
        const cur = merged.get(name) ?? { count: 0, reasons: {}, samples: [] };
        cur.count += e.count;
        for (const [r, n] of Object.entries(e.reasons)) cur.reasons[r] = (cur.reasons[r] ?? 0) + n;
        for (const s of e.samples) {
          if (cur.samples.length < 3 && !cur.samples.some((x) => x.file === s.file && x.line === s.line)) cur.samples.push(s);
        }
        merged.set(name, cur);
      }
    }
    if (merged.size > 0) {
      const entries = [...merged.entries()].sort((a, b) => b[1].count - a[1].count);
      droppedNames = entries.length;
      dropped = {};
      for (const [name, e] of entries.slice(0, 300)) dropped[name] = e;
    }
  }

  // srcMtime/srcCount 必须与 indexStale 的指纹口径同源(srcFingerprint),否则假过期抖动
  const fp = srcFingerprint(root);
  // step-141 采样口径落盘:构建期扫描被截断/降数时,srcCount 是采样集计数(与磁盘全量天然不等),
  // indexStale 靠本字段知道「count 比对不可用」并退化为 mtime/HEAD;checkSet=确定性抽样相对路径
  // (≤64 条,按字典序等距取),用于廉价检出采样集内的删除(新增/编辑由 maxMtime 覆盖)。
  const sampledBuild = Boolean(scanTruncated || freshGraph?.structTruncated);
  const mtimeOfRel = new Map(entries.map((e) => [e.rel, e.fp.mtime]));
  const srcSampled = sampledBuild
    ? {
        limit: scanTruncated?.limit ?? maxFilesDefault(),
        ...(rels.length > 0 ? { totalSeen: rels.length } : {}),
        checkSet: sampleCheckSet(rels, (rel) => mtimeOfRel.get(rel) ?? 0),
      }
    : undefined;
  // 堆预算降数的截断登记(step-086):无论来源(引擎 structTruncated/扫描截断),追加坡预算段,
  // 如实区分「引擎上限」与「堆预算采样」。
  const withHeapNote = (t?: { reason: string; limit?: number }): { reason: string; limit?: number } | undefined => {
    if (!heapNote) return t;
    if (!t) return { reason: `堆预算自适应采样${heapNote}` };
    return { ...t, reason: t.reason + heapNote };
  };
  // 语言覆盖报告(step-067 fail-visible;step-079 分层):
  // - 全量(mode=full):结构档逐文件 outcome 齐备 → 分层计数+coveragePct+skippedReasons;
  // - 增量零变更:上一版 coverage 对当前盘面仍逐字成立 → 原样 carry(附最新截断登记);
  // - 增量有重扫:outcome 只覆盖重扫文件,分层不可归因 → legacy 口径(layeredScope 缺省,如实)。
  let coverage: LanguageCoverage;
  if (mode === "full") {
    coverage = await computeLanguageCoverage(root, Object.keys(byFile), {
      outcomes: freshGraph?.structOutcomes,
      truncated: withHeapNote(freshGraph?.structTruncated ?? scanTruncated),
      layeredScope: "full",
    });
  } else if (changed.length === 0 && prev?.coverage) {
    const carried = withHeapNote(scanTruncated);
    coverage = { ...prev.coverage, ...(carried && !prev.coverage.truncated ? { truncated: carried } : {}) };
  } else {
    const carried = withHeapNote(scanTruncated);
    coverage = await computeLanguageCoverage(root, Object.keys(byFile), carried ? { truncated: carried } : {});
  }
  // step-106:桥边段(designs/27 §7 落地)——零变更且上一版有桥边=原样 carry(与 coverage
  // carry 同口径:桥边是整仓确定性行扫描的函数,文件零变更→产物逐字节可复现);否则重算
  // (旧格式索引 prev 无 bridge=升级重算一次;全量/有变更=权威重算)。秒级(103 实测
  // grafana ≤4.4s);失败由 computeIndexBridge 兜成字段内 degraded 标注,不毙索引构建。
  let bridge: C2fIndex["bridge"];
  if (!opts.force && changed.length === 0 && prev?.bridge) {
    bridge = prev.bridge;
  } else {
    const t0b = Date.now();
    bridge = await computeIndexBridge(root);
    if (bridge?.degraded) progress(`桥边段降级: ${bridge.degraded}`);
    else if (bridge) progress(`桥边段: ${bridge.edges.length} 条(state=${bridge.state},${Date.now() - t0b}ms)`);
  }
  // 2026-10-22 P0:解析含语法错误的文件面(增量语义:上版已知错误文件剔除本轮变更文件,
  // 再并本轮重扫文件的 errors;计数在已知面内权威,旧面曾截断时按上一版计数保守继承)。
  let errorSet = new Set(prev?.errorFiles ?? []);
  let errorFileCount = prev?.errorFileCount ?? errorSet.size;
  if (mode === "full" || !prev) {
    errorSet = new Set();
    if (freshGraph?.structOutcomes) {
      for (const [f, oc] of freshGraph.structOutcomes) if (oc.errors) errorSet.add(f);
    }
    errorFileCount = errorSet.size;
  } else {
    const changedSet = new Set(changed);
    const removed = [...errorSet].filter((f) => changedSet.has(f)).length;
    for (const f of changedSet) errorSet.delete(f);
    if (freshGraph?.structOutcomes) {
      for (const [f, oc] of freshGraph.structOutcomes) if (oc.errors) errorSet.add(f);
    }
    errorFileCount = Math.max(errorSet.size, errorFileCount - removed);
  }
  // 2026-11-08:解析守卫/结构档跳过清单(与 c2f.buildC2fIndex 同口径)。增量语义:未变更文件
  // 从上一版 carry;本轮重扫文件按 freshGraph 重建(guardSkips + structOutcomes.skipped)。
  const skippedMap = new Map<string, string>();
  if (mode !== "full" && prev?.skippedFiles) {
    const changedSet = new Set(changed);
    for (const s of prev.skippedFiles) if (!changedSet.has(s.rel)) skippedMap.set(s.rel, s.reason);
  }
  if (freshGraph) {
    for (const [rel, reason] of freshGraph.guardSkips ?? []) skippedMap.set(rel, reason);
    for (const [rel, oc] of freshGraph.structOutcomes ?? []) {
      if (oc.tier === "skipped") skippedMap.set(rel, oc.reason ?? "解析跳过(原因未登记)");
    }
  }
  const skippedFiles = [...skippedMap.entries()].slice(0, 200).map(([rel, reason]) => ({ rel, reason }));
  // 2026-11-08 全覆盖:rels 是每轮完整扫描清单(含复用文件),据此重建文件级状态表。
  // 缺省 symbol-less,有符号→indexed,守卫/结构档跳过→skipped,装载失败→error。
  const fileStatus: Record<string, { status: "indexed" | "symbol-less" | "skipped" | "error"; reason?: string }> = {};
  for (const rel of rels) fileStatus[rel] = { status: "symbol-less" };
  for (const rel of Object.keys(byFile)) fileStatus[rel] = { status: "indexed" };
  for (const s of skippedFiles) fileStatus[s.rel] = { status: "skipped", reason: s.reason };
  for (const rel of freshGraph?.unparsableFiles ?? []) {
    fileStatus[rel] = { status: "error", reason: "ts-morph 装载失败(文件存在但未能解析)" };
  }
  // 文件级去向并入覆盖报告(与 c2f.buildC2fIndex 同口径)。
  const statusList = Object.values(fileStatus);
  if (statusList.length > 0 && coverage) {
    coverage.fileStatus = {
      scanned: statusList.length,
      indexed: statusList.filter((s) => s.status === "indexed").length,
      symbolLess: statusList.filter((s) => s.status === "symbol-less").length,
      skipped: statusList.filter((s) => s.status === "skipped").length,
      error: statusList.filter((s) => s.status === "error").length,
    };
  }
  const index: C2fIndex = {
    version: 1,
    extractorVersion: INDEX_EXTRACTOR_VERSION,
    root,
    gitHead: gitHeadRaw(root),
    builtAt: Date.now(),
    buildMs: Date.now() - t0,
    nodes,
    edges,
    byFile,
    byName,
    headSha: gitHeadSha(root),
    srcMtime: fp.maxMtime,
    srcCount: fp.count,
    // step-099:importers 恒写(空也写 {})——字段在场=版本标记,缺席=旧格式索引
    importers: importers ?? {},
    ...(dropped ? { dropped } : {}),
    ...(droppedNames !== undefined ? { droppedNames } : {}),
    errorFiles: [...errorSet].slice(0, 200),
    errorFileCount,
    ...(skippedFiles.length > 0 ? { skippedFiles } : {}),
    ...(Object.keys(fileStatus).length > 0 ? { fileStatus } : {}),
    coverage,
    ...(bridge ? { bridge } : {}),
  };
  saveIndex(root, index);

  // sidecar v2:root 与键均为规范化绝对路径(realpath)——跨父 cwd/路径拼写可复用,迁移可重映射。
  // extractorVersion 与索引同源落盘:下次复用判断的版本闸依据(缺字段=旧产物,不得搬运)。
  const sidecar: FingerprintSidecar = {
    version: 2,
    root: canonicalPath(root),
    builtAt: Date.now(),
    files: fps,
    extractorVersion: INDEX_EXTRACTOR_VERSION,
    classes: [...classIds],
  };
  saveSidecar(root, sidecar);

  return {
    root,
    index,
    indexDir: indexDir(root),
    reused: [...reusables.keys()].sort(),
    scanned: [...changed].sort(),
    buildMs: index.buildMs,
    mode,
    fingerprints: fps,
    relinked,
    extractorVersion: INDEX_EXTRACTOR_VERSION,
    ...(versionMigration ? { versionMigration } : {}),
  };
}

/** 诊断:某文件相对上次 sidecar 是否变化。 */
export function fileChangedSince(root: string, rel: string): "same" | "changed" | "unknown" {
  const side = loadSidecar(root);
  if (!side) return "unknown";
  const canon = canonicalPath(join(root, rel)); // sidecar v2:键=规范化绝对路径
  const fp = statFingerprint(canon);
  const old = side.files[canon];
  if (!fp || !old) return "unknown";
  return fp.mtime === old.mtime && fp.size === old.size ? "same" : "changed";
}
