/**
 * code2flow 形态的静态调用索引(designs/16 code2flow 思想移植的图形态升级):
 * ① 全图一次构建→JSON 落盘(.genie/sense-index/<hash>/),vibe coding agent 按需查询,不塞 system prompt;
 * ② 节点三分类(code2flow 语义):trunk=索引内无调用方(入口)/leaf=不调用别人(叶子)/regular=其余;
 * ③ 分组:File(必有)/Class(容器存在时);渲染=graphviz dot 风格 mermaid(flowchart,子图=群组框);
 * ④ 边分色=调用类型:this 调用(金)/import 解析(蓝)/唯一名兜底(绿,code2flow trunk 边主色)。
 * 静态产物由任务开工/面板刷新时增量重建(commit sha + mtime 指纹双段过期判定,step-057 补真)。
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { buildCallGraph, listSourceFiles, isNonCallableSymbolKind, GRAPH_SKIP_DIRS as GRAPH_SKIP_DIRS_SET, GRAPH_SOURCE_EXT as GRAPH_SOURCE_EXT_SET, maxFilesDefault, INDEX_EXTRACTOR_VERSION, type CallGraph, type FlowEdge, type SymbolKind } from "./engine";
import { indexDir, readFingerprintRecord, writeFingerprintRecord, writeIndexMeta } from "./index-meta";
import { computeLanguageCoverage } from "./coverage";
import { computeIndexBridge } from "./index-bridge";
import type { BridgeEdge, BridgeStats } from "../sensing/crosslang-bridge";

export type NodeKind = "trunk" | "leaf" | "regular";

export interface C2fNode {
  id: string;          // 相对路径#Container.name(与 callgraph Symbol.id 相对化后一致)
  name: string;        // 显示名(parent/container 限定名 + name)
  file: string;        // 相对路径
  line: number;
  container?: string;  // 类名(有则归入 Class 群组)
  /** 2026-10-21:词法父符号限定名(类方法=Class;函数内嵌箭头/嵌套函数=外层函数限定名;
   * 顶层缺席)。旧索引无此字段=按顶层处理(加性,零回退面)。 */
  parent?: string;
  kind: NodeKind;
  outCount: number;    // 调用了几个不同符号
  inCount: number;      // 被几个不同符号调用
  /** 函数完整签名(step-066 impact 增量字段,旧索引无=查询侧显式降级):
   * 构建期 safeSignature 已算好、classify 之前被丢弃——现落盘。类型文本引擎侧已截 120 字符。 */
  sig?: { params: { name: string; type?: string; optional?: boolean }[]; returnType?: string };
  /** step-079 分层覆盖(designs/25):lexical=词法兜底档(零边、不进 entrypoints/relink 精度口径)。
   * 旧索引/结构档缺省=structural(无字段)。 */
  tier?: "structural" | "lexical";
  /** step-079:原始符号 kind(C2fNode.kind 是 trunk/leaf/regular 图语义,原始 kind 会被
   * recount 重算覆盖)——typedef/variable/interface/type/enum 豁免 trunk/leaf 语义,
   * relink 不作解析目标。旧索引无此字段。
   * senseB21:inline-js=模板字符串内嵌 JS 虚拟符号(不豁免 trunk/leaf——它有调用边,
   * 是网页结构的真实入口/叶子;incremental recount/relink 按「非声明 kind」通用语义)。
   * 2026-10-21:interface/type/enum=TS 类型声明;arrow=const 箭头函数(参与调用图)。 */
  symKind?: SymbolKind;
  /** step-102:Go 类型声明的 struct/interface 区分(engine Symbol.typeKind 透传;加性——
   * 旧索引无此字段=未知,消费侧只对 "interface" 特判,其余按原语义)。 */
  typeKind?: "struct" | "interface";
  /** step-089 P1(designs/26 §2.1):声明时数据类型文本(variable/typedef 专用;缺省=无类型信息)。 */
  dataType?: string;
  /** 2026-10-22 P0:C/C++ 函数原型(无函数体)。查询面据此在同名定义在场时折叠声明,
   *  避免 .h/.c 双条目把「无调用方」重复呈现。旧索引无此字段=按定义处理。 */
  proto?: boolean;
}

export interface C2fEdge {
  from: string;
  to: string;
  toName: string;
  file: string;
  line: number;
  /** 调用类型(着色):this=同类方法金/import=import 解析蓝/unique=唯一名兜底绿/unresolved=未解析虚灰 */
  kind: "this" | "import" | "unique" | "unresolved";
  /** 2026-10-26:未解析边的调用形态(relink 作用域闸;additive,旧索引无此字段=未知)。
   * prop/bound 不得在增量 relink 里按唯一名跨文件兜底(属性调用 x.trim()→RingBuffer.trim 实锚)。 */
  callForm?: "bare" | "prop" | "new" | "bound" | "import" | "external";
}

/** 扫描面文件的去向(2026-11-08 全覆盖;见 C2fIndex.fileStatus)。 */
export interface C2fFileStatus {
  status: "indexed" | "symbol-less" | "skipped" | "error";
  reason?: string;
}

export interface C2fIndex {
  version: 1;
  /** 抽取器版本(INDEX_EXTRACTOR_VERSION,engine 单一真相;旧索引无此字段=隐式 v1)。
   * 增量复用与 doctor 据此判定「源码未变但抽取结果可能过期」——缺字段=旧抽取器产物,
   * 下游必须显式区分「旧版」与「当前版」,不得把缺席当最新。 */
  extractorVersion?: number;
  root: string;
  gitHead: string;
  builtAt: number;
  buildMs: number;
  nodes: C2fNode[];
  edges: C2fEdge[];
  /** 文件→节点 id(按需查询面)。 */
  byFile: Record<string, string[]>;
  /** 符号名→节点 id(重名并列)。 */
  byName: Record<string, string[]>;
  /** HEAD 解析到 commit sha(step-057:旧版存的是分支引用名,提交/编辑都不判过期)。 */
  headSha?: string;
  /** 源文件 mtime 指纹:构建时扫描集的最大 mtimeMs。 */
  srcMtime?: number;
  /** 源文件计数指纹(新增/删除文件也判过期)。 */
  srcCount?: number;
  /** 采样口径(step-141,采样索引的诚实过期判定):构建期扫描被截断/采样(GENIE_SENSE_MAX_FILES
   * 上限或堆预算降数)时落盘——此时 srcCount 是**采样集**计数,与磁盘全量计数天然不等,
   * indexStale 不得拿它与全量指纹比(否则采样仓永久「索引可能过期」:poly-grafana 采样 1219 vs
   * 磁盘实见 16619 实锤,而 git HEAD 其实一致)。
   * checkSet=确定性抽样的相对路径+构建时 mtime(≤64,按字典序等距取样):采样集内的删除
   * (missing)与编辑(mtime 变大)由它检出;采样集外的新增/编辑无法可靠检出(查询期 walk 上限
   * 与构建期不同,全量 maxMtime 口径不可比)——这一点由 samplingNote 如实说出,不假装覆盖。 */
  srcSampled?: { limit: number; totalSeen?: number; checkSet: { rel: string; mtime: number }[] };
  /** 文件级 import 依赖(step-066 impact 增量字段,旧索引无=import 通道显式降级):
   * 被导入文件 → 导入它的文件清单(impact 查「改这个文件牵连谁」的直接答案面)。
   * TS/JS 档由 ts-morph import 解析产出;step-099(RC-096-B2)起 Go 由 adapter 逐文件
   * import 清单经 expandGoImports(go.mod 模块锚)展开并入;python/java 结构档暂不产
   * (查询侧如实标注)。step-099 起新建索引恒写本字段(空也写 {})——字段在场=
   * 构建版本支持 import 通道,缺席=旧格式索引。 */
  importers?: Record<string, string[]>;
  /** step-099(RC-096-B5):构建期弃边台账(同名消歧/无目标等被诚实移除的跨文件候选,
   * 按被调名聚合;名字按 count 降序封顶 300)。旧索引无=查询侧「无记录」如实显示,不报错。 */
  dropped?: Record<string, { count: number; reasons: Record<string, number>; samples: { file: string; line: number }[] }>;
  /** dropped 的名字总数(封顶截断前;> Object.keys(dropped).length 即发生过截断)。 */
  droppedNames?: number;
  /** 2026-10-22 P0:解析含语法错误的文件(相对路径,封顶 200;errorFileCount 为权威计数)。
   * 这些文件仍产出符号,但局部 ERROR 可能吃掉若干调用边——impact/callers 据此显式提示
   * 「调用面可能不完整」。旧索引无此字段=未知(查询侧不得当作零盲区)。 */
  errorFiles?: string[];
  errorFileCount?: number;
  /** 2026-11-08:解析前守卫/结构档跳过的文件(相对路径+原因,封顶 200)。查询面据此把
   * 「文件无索引符号」翻译成可操作原因(超大/压缩产物/语法盲区),并指路 refs/grep。 */
  skippedFiles?: { rel: string; reason: string }[];
  /** 2026-11-08 全覆盖:扫描面文件 → 去向(每个源文件都有状态,不再有「未解释的缺失」)。
   *  - indexed:产出至少一个符号;
   *  - symbol-less:已扫描且解析成功,但没有可索引的函数/类/类型声明(barrel/副作用脚本/测试用例);
   *  - skipped:解析守卫或结构档跳过(带原因,如压缩产物/超大文件);
   *  - error:装载/解析失败(带原因)。
   * 旧索引无此字段=未知(查询面保持旧文案)。 */
  fileStatus?: Record<string, C2fFileStatus>;
  /** 语言覆盖报告(step-067 fail-visible):磁盘源文件数/有索引符号文件数按扩展名分列。
   * 旧索引无此字段=doctor/entrypoints 现场重算(显式降级,不假绿)。 */
  coverage?: import("./coverage").LanguageCoverage;
  /** step-106:跨语言桥边段(A1 HTTP api 桥,designs/27 §7 落地)——确定性边
   * (exact/exact-folded,过可信度闸)+统计落盘。旧索引无此字段=桥通道未构建
   * (查询侧如实缺省,不报错、输出零新行)。
   * 与 C2fEdge 互补不替代:C2fEdge=符号级「谁调用谁」(语言内,from/to 是符号 id);
   * 桥边=连接器级「谁经 HTTP 通道到达谁」(跨语言,from 是前端字面量调用点 file:line,
   * 不是符号)——故不入 edges[]/byName/callers 语义,独立字段存放。
   * first2 候选/1 段前缀命中按 step-103 纪律不进索引(低置信不混入确定性边)。 */
  bridge?: {
    state: "bridge-connected" | "bridge-partial" | "no-endpoints" | "no-frontend" | "no-match" | "degraded";
    edges: BridgeEdge[];
    /** 桥边统计(exactUnion 等对账口径);degraded 时缺省(不编造 0)。 */
    stats?: BridgeStats;
    /** 构建时实用的前端扩展名(收窄口径可见性;缺省=宽网未收窄,字段缺席)。 */
    frontendExts?: string[];
    /** 提取降级/失败原因(fail-visible;桥通道失败不毙索引构建但失败可见)。 */
    degraded?: string;
  };
}

/** git HEAD 短 hash(索引身份;失败=空串,退化为时间戳身份)。 */
function gitHead(root: string): string {
  try {
    return readFileSync(join(root, ".git", "HEAD"), "utf-8").trim();
  } catch {
    return "";
  }
}

/** HEAD 解析到 commit sha:「ref: refs/heads/x」读引用文件/packed-refs;detached=sha 本身。
 * 失败=空串(非 git 仓/残缺 .git,staleness 退化到 mtime 指纹档)。 */
export function gitHeadSha(root: string): string {
  const head = gitHead(root);
  if (!head) return "";
  if (!head.startsWith("ref:")) return head.trim(); // detached HEAD:直接是 sha
  const ref = head.slice(4).trim();
  try {
    // ref 围栏(review 抓):只信 refs/ 开头且无 ..,防 HEAD 被构造后读 .git 外文件
    if (!ref.startsWith("refs/") || ref.includes("..")) return "";
    const sha = readFileSync(join(root, ".git", ref), "utf-8").trim();
    if (sha) return sha;
  } catch {
    // 引用文件不存在→走 packed-refs(新 clone/gc 后常态)。
  }
  try {
    const packed = readFileSync(join(root, ".git", "packed-refs"), "utf-8");
    for (const line of packed.split("\n")) {
      if (line.startsWith("#") || line.startsWith("^")) continue;
      const sp = line.indexOf(" ");
      if (sp > 0 && line.slice(sp + 1).trim() === ref) return line.slice(0, sp).trim();
    }
  } catch {
    // 无 packed-refs
  }
  return "";
}

/** 源文件 mtime 指纹。同步版(srcFingerprint)只走构建收口/测试断言路径;
 * 查询路径用 srcFingerprintCached(TTL 到期异步刷新)——9p 慢盘同步全仓 stat 秒级阻塞事件循环,
 * 不能进 WS 消息/工具查询路径(step-057 三期 B2,对齐 file-index 时间预算教训)。 */
const fpCache = new Map<string, { at: number; fp: { count: number; maxMtime: number } }>();
const fpRefreshing = new Set<string>();
const FP_TTL_MS = 10_000;

/** 异步指纹预算(2026-11-08):旧值硬编码 2s,9p 慢盘全量 walk 实测 7.5s——永远走不完,
 * 缓存永不落盘,indexStale 因此恒「未知→不过期」(7700 实锤:索引静默陈旧 8 天)。放宽到 15s
 * (GENIE_SENSE_FP_BUDGET_MS 可调);超时仍不写缓存(不完整指纹不冒充结论)。 */
function fpBudgetMs(): number {
  const n = Number(process.env.GENIE_SENSE_FP_BUDGET_MS ?? 15_000);
  return Number.isFinite(n) && n >= 200 ? n : 15_000;
}

/** 无可用指纹时索引的最大可信年龄(2026-11-08):超过即判过期并触发一次后台重建。
 * 默认 1h。构建成功后 builtAt 刷新,不会反复重建;有盘上指纹时以指纹为准。 */
function maxIndexAgeMs(): number {
  const n = Number(process.env.GENIE_SENSE_MAX_INDEX_AGE_MS ?? 3_600_000);
  return Number.isFinite(n) && n >= 0 ? n : 3_600_000;
}

export function srcFingerprint(root: string, force = false): { count: number; maxMtime: number; at: number } {
  const hit = fpCache.get(root);
  if (!force && hit && Date.now() - hit.at < FP_TTL_MS) return { ...hit.fp, at: hit.at };
  const fp = walkFingerprintSync(root);
  const at = Date.now();
  fpCache.set(root, { at, fp });
  // 同步构建/断言路径也是「一次完整 walk」——落盘供后续冷进程复用(小文件,失败容忍)。
  writeFingerprintRecord(root, { at, ...fp });
  return { ...fp, at };
}

function walkFingerprintSync(root: string): { count: number; maxMtime: number } {
  let count = 0;
  let maxMtime = 0;
  // step-079 RC-G:与 listSourceFiles 同一上限缺省(硬编码 4000 会在上限提升后口径漂移)
  const limit = maxFilesDefault();
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    if (count > limit) break;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (GRAPH_SKIP_DIRS_SET.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (GRAPH_SOURCE_EXT_SET.has(e.name.slice(e.name.lastIndexOf(".")))) {
        count++;
        try {
          const m = statSync(full).mtimeMs;
          if (m > maxMtime) maxMtime = m;
        } catch {
          // 扫描间文件消失:忽略(下次指纹自然反映)
        }
      }
      if (count > limit) break;
    }
  }
  return { count, maxMtime };
}

/** 指纹后台刷新间隔(2026-11-08):预算放宽到 15s 后,9p 上一次全量 walk ≈7.5s——若仍按
 *  内存 TTL(10s)触发,连续查询会让 walk 每 10s 跑一次。独立成 60s:读侧永远拿最近结论
 *  (stale-while-revalidate),过期检测最多滞后 60s(索引重建本身是分钟级,无实质影响)。 */
function fpRefreshMs(): number {
  const n = Number(process.env.GENIE_SENSE_FP_REFRESH_MS ?? 60_000);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
}

/** 查询路径指纹:读侧永远返回最近一次完整 walk 的结论;后台 walk 每 fpRefreshMs 至多一次。
 * 冷启动三层(2026-11-08):
 *  ① 本进程内存缓存;
 *  ② 盘上 fp.json(上一次完整 walk 的结论,跨进程复用;9p 上全量 walk 7.5s,不能每进程重扫);
 *  ③ 都没有=返回 null(绝不同步建缓存——2026-10-30 冻结收割 ×2 实锤)。
 * 返回的 at=该指纹的完成时刻。 */
export function srcFingerprintCached(root: string): { count: number; maxMtime: number; at?: number } | null {
  const hit = fpCache.get(root);
  const refreshMs = fpRefreshMs();
  if (hit && Date.now() - hit.at < refreshMs) return { ...hit.fp, at: hit.at };
  // 冷启动:先读盘上最近一次完整指纹(只有本进程没缓存时才读,避免每次查询多一次文件 IO)。
  const persisted = hit ? null : readFingerprintRecord(root);
  if (persisted) fpCache.set(root, { at: persisted.at, fp: { count: persisted.count, maxMtime: persisted.maxMtime } });
  const lastAt = hit?.at ?? persisted?.at ?? 0;
  if (Date.now() - lastAt >= refreshMs && !fpRefreshing.has(root)) {
    fpRefreshing.add(root);
    void (async () => {
      const { readdir } = await import("node:fs/promises");
      let count = 0;
      let maxMtime = 0;
      let completed = true;
      const t0 = Date.now();
      const budget = fpBudgetMs();
      const limit = maxFilesDefault(); // step-079:与同步版同口径
      const stack = [root];
      while (stack.length) {
        if (Date.now() - t0 > budget || count > limit) { completed = false; break; }
        const dir = stack.pop()!;
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true }); // 目录间让出事件循环
        } catch {
          continue;
        }
        for (const e of entries) {
          if (e.name.startsWith(".")) continue;
          if (GRAPH_SKIP_DIRS_SET.has(e.name)) continue;
          const full = join(dir, e.name);
          if (e.isDirectory()) {
            stack.push(full);
          } else if (GRAPH_SOURCE_EXT_SET.has(e.name.slice(e.name.lastIndexOf(".")))) {
            count++;
            try {
              const m = statSync(full).mtimeMs;
              if (m > maxMtime) maxMtime = m;
            } catch {
              // 扫描间文件消失:忽略
            }
          }
        }
      }
      if (completed) {
        const at = Date.now();
        const fp = { count, maxMtime };
        fpCache.set(root, { at, fp });
        writeFingerprintRecord(root, { at, ...fp }); // 冷进程下次直接复用,不再重扫
      }
      fpRefreshing.delete(root);
    })().catch(() => { fpRefreshing.delete(root); });
  }
  if (persisted) return { count: persisted.count, maxMtime: persisted.maxMtime, at: persisted.at };
  return hit ? { ...hit.fp, at: hit.at } : null; // 冷启动且无盘上指纹=未知
}

/** 从全图分类节点(code2flow 语义):trunk=无具名调用方/leaf=不调用别人/regular=其余。
 * trunk 判定只看**具名函数**调用方:模块级虚调用方(`#<module>`,顶层语句/匿名回调)不取消
 * 入口资格——WS 连接回调里的 handleMessage、组合根 main.ts 里的 createGatewayApp 都是合法
 * 「从这开始读」的入口,但被谁调用在 callers 里如实可见(2026-10-14)。
 * 2026-10-15 起导出:code-sense-cli 增量索引(子图构建+既有文件搬运合并)复用同一分类,
 * 单一真相=本函数,消费端不得自建第二份分类实现。 */
export function classify(graph: CallGraph, root: string): { nodes: C2fNode[]; edges: C2fEdge[] } {
  const nodes: C2fNode[] = [];
  const edges: C2fEdge[] = [];
  const ghostSuffix = "#" + MODULE_CALLER_ID;
  // 各符号出边去重计数(callee 级)
  const outTargets = new Map<string, Set<string>>();
  const inSources = new Map<string, Set<string>>();
  const namedIn = new Map<string, Set<string>>();
  for (const [caller, list] of graph.outEdges) {
    for (const e of list) {
      const target = e.to || `ext:${caller}@${e.line}:${e.toName ?? "?"}`;
      if (!outTargets.get(caller)) outTargets.set(caller, new Set());
      outTargets.get(caller)!.add(target);
      if (e.to) {
        if (!inSources.get(e.to)) inSources.set(e.to, new Set());
        inSources.get(e.to)!.add(caller);
        if (!caller.endsWith(ghostSuffix)) {
          if (!namedIn.get(e.to)) namedIn.set(e.to, new Set());
          namedIn.get(e.to)!.add(caller);
        }
      }
      edges.push({
        from: caller.replace(root + "/", ""),
        to: (e.to ?? "").replace(root + "/", ""),
        toName: e.toName ?? "",
        file: e.file,
        line: e.line,
        kind: edgeKind(caller, e, graph),
        ...(e.to || !e.callForm ? {} : { callForm: e.callForm }),
      });
    }
  }
  for (const sym of graph.symbols.values()) {
    const id = sym.id.replace(root + "/", "");
    const outN = outTargets.get(sym.id)?.size ?? 0;
    const inN = inSources.get(sym.id)?.size ?? 0;
    // 类节点不做 trunk/leaf 分类(语义只对函数成立;类是命名空间容器)
    const isClass = sym.kind === "class";
    // step-079:typedef/variable 与 lexical 档符号不参与 trunk/leaf 语义——它们没有调用边,
    // 落 trunk 会污染 entrypoints(词法覆盖产物 ≠ 程序入口)。
    // 2026-10-21:interface/type/enum 同列声明豁免(arrow 是真实函数,不豁免)。
    const isAux = isClass || isNonCallableSymbolKind(sym.kind) || sym.tier === "lexical";
    const qualifier = sym.parent ?? sym.container;
    nodes.push({
      id,
      name: qualifier ? qualifier + "." + sym.name : sym.name,
      file: sym.file.replace(root + "/", ""),
      line: sym.line,
      ...(sym.container ? { container: sym.container } : {}),
      ...(sym.parent ? { parent: sym.parent } : {}),
      kind: isAux ? "regular" : (namedIn.get(sym.id)?.size ?? 0) === 0 ? "trunk" : outN === 0 ? "leaf" : "regular",
      outCount: outN,
      inCount: inN,
      ...(sym.tier ? { tier: sym.tier } : {}),
      ...(sym.kind !== "function" && sym.kind !== "method" ? { symKind: sym.kind } : {}),
      ...(sym.typeKind ? { typeKind: sym.typeKind } : {}),
      ...(sym.dataType ? { dataType: sym.dataType } : {}),
      ...(sym.proto ? { proto: true } : {}),
      // 签名落盘(step-066):引擎构建期已算,旧版在此丢弃——impact 的签名分节数据源。
      // 类节点无签名语义,不落。
      ...(isClass ? {} : sym.signature ? { sig: { params: sym.signature.params, ...(sym.signature.returnType ? { returnType: sym.signature.returnType } : {}) } } : {}),
    });
  }
  return { nodes, edges };
}

function buildByMaps(nodes: C2fNode[]): { byFile: Record<string, string[]>; byName: Record<string, string[]> } {
  // 无原型对象:符号名撞 Object.prototype(toString/valueOf/constructor 等合法标识符)时,
  // 普通对象读到继承函数,`??= []` 不生效 → .push 崩,整仓索引构建失败(qwen-audio-agent 实证)
  const byFile = Object.create(null) as Record<string, string[]>;
  const byName = Object.create(null) as Record<string, string[]>;
  for (const n of nodes) {
    (byFile[n.file] ??= []).push(n.id);
    (byName[n.name] ??= []).push(n.id);
    // 裸名索引:方法登记名是 Class.method,但 agent 查询用裸方法名(实锤:查
    // build_evidence_pack 得「未找到」)——裸名并列,多命中由查询侧分别列出
    const dot = n.name.lastIndexOf(".");
    if (dot > 0) {
      const bare = n.name.slice(dot + 1);
      const list = (byName[bare] ??= []);
      if (!list.includes(n.id)) list.push(n.id);
    }
  }
  return { byFile, byName };
}

/** 边类型(着色语义):this=同类方法金/import=ast 解析蓝/unique=唯一名兜底绿/unresolved=虚灰。 */
function edgeKind(callerId: string, e: FlowEdge, graph: CallGraph): C2fEdge["kind"] {
  if (!e.to) return "unresolved";
  const caller = graph.symbols.get(callerId);
  const callee = graph.symbols.get(e.to);
  if (caller && callee && caller.container && callee.container && caller.container === callee.container) return "this";
  return e.evidenceKind === "ast" ? "import" : "unique";
}

/** 全图索引构建(同步入口;大仓分钟级,调用方决定何时跑)。
 * step-057:构建时记录 headSha + 源文件 mtime/计数指纹(过期判定的身份面)。
 * step-066:graph.imports → importers 映射(被导入文件→导入方清单)落盘,impact 的
 * import 通道数据源;旧索引无该字段=查询侧显式降级(不重建也可用)。
 * step-099:Go 结构档 import 经 expandGoImports 并入同一 importers 面;droppedCandidates
 * 弃边台账落盘(RC-096-B5,同名消歧弃边从不可见变可查)。 */
export async function buildC2fIndex(root: string): Promise<C2fIndex> {
  const graph = await buildCallGraph(root);
  const { nodes, edges } = classify(graph, root);
  // step-098:JSX 使用证据降权(伪入口修复)——classify 之后、byMaps 之前(kind 不影响 byName/byFile)。
  // 文件清单重新枚举一次(零符号 tsx 文件——箭头函数组件页——不在 graph 里但可能是使用方);
  // listSourceFiles 返回绝对路径,转相对与节点 file 口径对齐。
  applyJsxComponentUsage(root, (await listSourceFiles(root)).map((p) => p.replace(root + "/", "")), nodes);
  const { byFile, byName } = buildByMaps(nodes);
  // 2026-11-08:构建收口取**新鲜**指纹(旧实现可能命中查询期缓存,srcMtime 落后于构建结束时点
  // → 刚建完的索引立刻被判过期/或漏判)。同步 walk 7.5s 相对整次构建(≈90s)可接受。
  const fp = srcFingerprint(root, true);
  // 语言覆盖报告(step-067 fail-visible;磁盘口径=engine 同一扫描)
  // step-079:结构档逐文件 outcome → 分层计数(full/lexical/empty/skipped)+ coveragePct
  const coverage = await computeLanguageCoverage(root, Object.keys(byFile), {
    outcomes: graph.structOutcomes,
    truncated: graph.structTruncated,
    layeredScope: "full",
  });
  // importers:方向反转(imports: 被导入→导入方集合,已是 impact 需要的方向,键转相对路径)
  const importers: Record<string, string[]> = {};
  const mergeImportEdges = (edges2: Iterable<readonly [string, ReadonlySet<string>]>): void => {
    for (const [target, froms] of edges2) {
      const rel = target.replace(root + "/", "");
      if (!importers[rel]) importers[rel] = [];
      for (const f of froms) {
        const relFrom = f.replace(root + "/", "");
        if (!importers[rel]!.includes(relFrom)) importers[rel]!.push(relFrom);
      }
    }
  };
  if (graph.imports) mergeImportEdges(graph.imports);
  // step-099 RC-B2:Go 结构档 import 依赖(go.mod 锚定,同包文件不互列——Go 包级可见性
  // 由调用边承载,单包仓互列是纯噪音)
  if (graph.structFileImports && graph.structFileImports.size > 0) {
    mergeImportEdges(expandGoImports(root, graph.structFileImports, Object.keys(byFile)));
  }
  // step-099 RC-B5:弃边台账落盘(名字按 count 降序封顶 300;计数权威,样本 ≤3 由引擎侧控制)
  let dropped: C2fIndex["dropped"];
  let droppedNames: number | undefined;
  if (graph.droppedCandidates && graph.droppedCandidates.size > 0) {
    const entries = [...graph.droppedCandidates.entries()].sort((a, b) => b[1].count - a[1].count);
    droppedNames = entries.length;
    dropped = {};
    for (const [name, e] of entries.slice(0, 300)) {
      dropped[name] = { count: e.count, reasons: e.reasons, samples: e.samples };
    }
  }
  // 2026-10-22 P0:解析含语法错误的文件清单(相对路径,封顶 200;计数权威)。
  // 与 coverage.skipped 不同:这些文件仍产出符号/多数边(tier=full),但局部 ERROR 可能吃掉
  // 少量调用——impact 必须据此提示「调用面可能不完整」,不能把缺口读成 0 调用方。
  const errorFileList: string[] = [];
  let errorFileCount = 0;
  if (graph.structOutcomes) {
    for (const [file, oc] of graph.structOutcomes) {
      if (!oc.errors) continue;
      errorFileCount++;
      if (errorFileList.length < 200) errorFileList.push(file);
    }
  }
  // 2026-11-08:解析守卫/结构档跳过清单落盘(相对路径+原因,封顶 200;去重保序)。
  // 查询面对「文件无索引符号」查这张表,给「超大/压缩产物被跳过,可用 refs/grep」的可操作回执。
  const skippedFiles: { rel: string; reason: string }[] = [];
  const skippedSeen = new Set<string>();
  const pushSkip = (rel: string, reason: string): void => {
    if (skippedSeen.has(rel) || skippedFiles.length >= 200) return;
    skippedSeen.add(rel);
    skippedFiles.push({ rel, reason });
  };
  if (graph.guardSkips) for (const [rel, reason] of graph.guardSkips) pushSkip(rel, reason);
  if (graph.structOutcomes) {
    for (const [rel, oc] of graph.structOutcomes) {
      if (oc.tier === "skipped") pushSkip(rel, oc.reason ?? "解析跳过(原因未登记)");
    }
  }
  // 2026-11-08 全覆盖:扫描面每个文件一条去向。缺省 symbol-less(已扫描、解析成功、无可索引声明),
  // 有符号→indexed,守卫跳过→skipped,装载失败→error。查询面据此永不再把「有文件但无符号」
  // 误报成「文件不存在/无索引」。
  const fileStatus: Record<string, C2fFileStatus> = {};
  for (const rel of graph.scannedFiles ?? []) fileStatus[rel] = { status: "symbol-less" };
  for (const rel of Object.keys(byFile)) fileStatus[rel] = { status: "indexed" };
  for (const s of skippedFiles) fileStatus[s.rel] = { status: "skipped", reason: s.reason };
  for (const rel of graph.unparsableFiles ?? []) {
    fileStatus[rel] = { status: "error", reason: "ts-morph 装载失败(文件存在但未能解析)" };
  }
  // 文件级去向并入覆盖报告:按符号的 x/y 之外,把「其余文件去哪了」一次说清(全覆盖口径)。
  const statusList = Object.values(fileStatus);
  if (statusList.length > 0) {
    coverage.fileStatus = {
      scanned: statusList.length,
      indexed: statusList.filter((s) => s.status === "indexed").length,
      symbolLess: statusList.filter((s) => s.status === "symbol-less").length,
      skipped: statusList.filter((s) => s.status === "skipped").length,
      error: statusList.filter((s) => s.status === "error").length,
    };
  }
  // step-106:桥边段落盘(全量构建恒重算——秒级确定性行扫描,103 实测 grafana ≤4.4s;
  // 失败/降级形态由 computeIndexBridge 兜成字段内标注,不毙索引构建)
  const bridge = await computeIndexBridge(root);
  return {
    version: 1,
    extractorVersion: INDEX_EXTRACTOR_VERSION,
    root,
    gitHead: gitHead(root),
    builtAt: Date.now(),
    buildMs: graph.buildMs,
    nodes,
    edges,
    byFile,
    byName,
    headSha: gitHeadSha(root),
    srcMtime: fp.maxMtime,
    srcCount: fp.count,
    importers,
    ...(dropped ? { dropped } : {}),
    ...(droppedNames !== undefined ? { droppedNames } : {}),
    errorFiles: errorFileList,
    errorFileCount,
    ...(skippedFiles.length > 0 ? { skippedFiles } : {}),
    ...(Object.keys(fileStatus).length > 0 ? { fileStatus } : {}),
    coverage,
    ...(bridge ? { bridge } : {}),
  };
}

/** step-099 RC-B2:Go 结构档 import 清单 → 文件级 importers 边(绝对路径 target → 导入方集合,
 * 与 CallGraph.imports 同方向同路径口径,调用方负责转相对)。
 * 判定锚 = 仓根 go.mod 的 `module <path>`:import 路径以模块路径为前缀=仓内包,映射到
 * 对应目录内全部非测试 .go 文件(Go import 是包级语义,文件级映射按目录展开;测试文件
 * 不是包的导入目标故不作 target,但作为导入方正常计入)。
 * 无 go.mod / 外部路径 / 多 module 仓(go.work/子 module)= 跳过不猜(诚实缺省)。
 * 同包文件不互为 importers(包内可见性由调用边承载)。 */
export function expandGoImports(
  root: string,
  raw: ReadonlyMap<string, readonly string[]>,
  allRelFiles: readonly string[],
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  let modulePath: string | null = null;
  try {
    const gomod = readFileSync(join(root, "go.mod"), "utf-8");
    modulePath = /^module\s+(\S+)/m.exec(gomod)?.[1] ?? null;
  } catch {
    return out; // 无 go.mod:不猜
  }
  if (!modulePath) return out;
  // 目录 → 目标 .go 文件(测试文件不作 target)
  const dirFiles = new Map<string, string[]>();
  for (const rel of allRelFiles) {
    if (!rel.endsWith(".go") || /_test\.go$/.test(rel)) continue;
    const d = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const list = dirFiles.get(d) ?? [];
    list.push(rel);
    dirFiles.set(d, list);
  }
  for (const [absImporter, paths] of raw) {
    const relImporter = absImporter.replace(root + "/", "");
    for (const p of paths) {
      if (p !== modulePath && !p.startsWith(modulePath + "/")) continue; // 标准库/外部:跳过
      const sub = p.slice(modulePath.length).replace(/^\//, "");
      for (const t of dirFiles.get(sub) ?? []) {
        if (t === relImporter) continue;
        const absT = join(root, t);
        const set = out.get(absT) ?? new Set<string>();
        set.add(absImporter);
        out.set(absT, set);
      }
    }
  }
  return out;
}

/** 索引落盘路径(.genie/sense-index/<rootHash>/index.json);实现迁到 index-meta(零重依赖),
 *  这里 re-export 保持既有消费方(codesense-cli/build-lock/registry)零改动。 */
export { indexDir } from "./index-meta";

export function saveIndex(root: string, index: C2fIndex): string {
  const dir = indexDir(root);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "index.json");
  writeFileSync(p, JSON.stringify(index));
  // 2026-11-08:小体积构建元数据(根预算闸/诊断面读它,不必解析 30MB index.json)。
  const statuses = index.fileStatus ? Object.values(index.fileStatus) : [];
  writeIndexMeta(root, {
    version: 1,
    root,
    builtAt: index.builtAt,
    ...(index.srcCount !== undefined ? { srcCount: index.srcCount } : {}),
    ...(index.srcMtime !== undefined ? { srcMtime: index.srcMtime } : {}),
    nodes: index.nodes.length,
    edges: index.edges.length,
    ...(index.extractorVersion !== undefined ? { extractorVersion: index.extractorVersion } : {}),
    ...(statuses.length > 0 ? {
      fileStatus: {
        scanned: statuses.length,
        indexed: statuses.filter((s) => s.status === "indexed").length,
        symbolLess: statuses.filter((s) => s.status === "symbol-less").length,
        skipped: statuses.filter((s) => s.status === "skipped").length,
        error: statuses.filter((s) => s.status === "error").length,
      },
    } : {}),
  });
  // 构建即一次「完整源文件调查」:顺手把指纹记录刷新到构建时点,后续冷进程无需重扫。
  if (index.srcMtime !== undefined && index.srcCount !== undefined) {
    writeFingerprintRecord(root, { at: index.builtAt, count: index.srcCount, maxMtime: index.srcMtime });
  }
  return p;
}

export function loadIndex(root: string): C2fIndex | null {
  const p = join(indexDir(root), "index.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as C2fIndex;
  } catch {
    return null;
  }
}

/** 异步加载(2026-10-30 worker 冻结事故:索引 JSON 实测 29-40MB,同步 readFileSync 在 9p
 *  停顿时把 session-worker 事件循环冻了 183s 被强制收割)。IO 走 fs.promises;JSON.parse
 *  (40MB≈1s,每进程每根一次)保留同步——量级可容忍,拆 worker_threads 不值。 */
export async function loadIndexAsync(root: string): Promise<C2fIndex | null> {
  const p = join(indexDir(root), "index.json");
  try {
    if (!(await fsp.stat(p)).isFile()) return null;
  } catch {
    return null;
  }
  try {
    return JSON.parse(await fsp.readFile(p, "utf-8")) as C2fIndex;
  } catch {
    return null;
  }
}

/** 索引是否采样构建(step-141,采样索引的诚实过期判定)。
 * 识别两路:①新索引显式落 srcSampled;②旧索引(今日之前的产物)靠 coverage.truncated 的
 * 「扫描达文件上限 / 堆预算自适应采样」字样——这批索引正是「永久 stale 误报」的受害者,
 * 不识别就等于没修(poly-grafana 采样 1219 / 磁盘实见 16619 实锤)。
 * 注意 coverage.truncated 还承载「skipped 原因明细截取」等非采样原因,故按字样判别而不是「有即采样」。 */
export function isSampledIndex(index: C2fIndex | null): boolean {
  if (!index) return false;
  if (index.srcSampled) return true;
  const reason = index.coverage?.truncated?.reason;
  return typeof reason === "string" && /扫描达文件上限|堆预算自适应采样/.test(reason);
}

/** 采样索引的诚实说明(查询面注记共用):不静默——采样索引上的 count 比对不可用,
 * 已退化为 mtime/HEAD,用户看到的「新鲜」结论建立在少了哪些信号上一目了然。 */
export function samplingNote(index: C2fIndex | null): string | undefined {
  if (!index || !isSampledIndex(index)) return undefined;
  const limit = index.srcSampled?.limit ?? index.coverage?.truncated?.limit;
  const total = index.srcSampled?.totalSeen;
  const bits = [limit !== undefined ? `采样上限 ${limit}` : "构建期采样", total !== undefined ? `磁盘实见 ${total}` : undefined]
    .filter(Boolean).join(",");
  return `采样索引(${bits}):文件计数口径不同,count 比对已退化为 mtime/HEAD`;
}

/** 确定性空索引(step-141):构建跑过、覆盖报告在场、且所有支持语言扩展名都是
 * 「磁盘有文件但 0 个文件产出符号」——重建结果确定相同,不该永久「自愈」抖动。
 * 实锤形态:php-laravel / ruby-jekyll 是纯 PHP/Ruby 仓,磁盘上仅剩 3 个零函数 js 资源脚本,
 * 每次查询都被空索引自愈档判 stale → 永久刷「索引可能过期」。
 * 边界:旧格式索引(step-067 前产物,无 coverage)不适用本函数——那批是「旧版不收 py/go/java」
 * 的残缺索引,仍须走自愈重建(五仓实证)。带 truncated(采样/截断)的空索引也不算确定性空。 */
function isDeterministicEmpty(index: C2fIndex): boolean {
  if (index.nodes.length > 0) return false;
  const cov = index.coverage;
  if (!cov) return false;
  if (cov.truncated) return false;
  const exts = Object.values(cov.byExt) as { indexedFiles: number }[];
  if (exts.length === 0) return false;
  return exts.every((c) => c.indexedFiles === 0);
}

/** 索引是否过期(step-057 双段判定 + 2026-10-14 自愈档):
 * ① headSha 档:新旧索引都有 sha 且不同 → 过期(提交即过期);
 * ② 旧格式档:索引无 srcMtime(step-057 之前的产物)→ 过期,触发一次升级重建——
 *    旧「分支名比对」档会让 10-13 前的空索引/残缺索引永久「新鲜」,查询永远空结果不自愈(五仓实证);
 * ③ mtime 指纹档:源文件最大 mtime 越过构建时点,或文件计数变化(增/删文件)→ 过期(未提交的编辑也覆盖);
 * ④ 空索引自愈:索引 0 节点但仓里有源文件 → 过期(典型:旧版不收 py/go/java 的残缺索引)。
 *    例外(step-141):已构建且覆盖报告证明「全部支持语言文件零符号」= 确定性空,重建无用,
 *    不再永久抖动(纯 PHP/Ruby 仓仅剩零函数 js 脚本的实锤形态)。
 * ⑤ 采样索引档(step-141):构建期扫描被截断/降数时 srcCount 是采样集计数,与磁盘全量计数天然不等,
 *    count 比对退化为「不比对」;采样集内的删除/编辑靠 srcSampled.checkSet(≤64 条确定性取样)检出,
 *    采样集外的新增无法可靠检出——由 samplingNote 如实说明。无 checkSet 的旧采样索引只比 mtime/HEAD。 */
export function indexStale(root: string, index: C2fIndex | null): boolean {
  if (!index) return true;
  const sha = gitHeadSha(root);
  if (sha && index.headSha && sha !== index.headSha) return true;
  if (index.srcMtime === undefined) return true; // 旧格式:升级重建(新构建恒带指纹)
  const fp = srcFingerprintCached(root); // 查询路径:异步刷新档(同步全仓 stat 会阻塞事件循环)
  const builtAt = typeof index.builtAt === "number" && Number.isFinite(index.builtAt) ? index.builtAt : 0;
  if (!fp) {
    // 2026-11-08:旧实现「未知→暂不过期」让索引可静默陈旧(7700 实锤 8 天)。改为:无指纹时
    // 只有「构建时间够新」才可信;超过 maxIndexAgeMs(默认 1h)判过期并触发一次后台重建。
    // 无 builtAt=更老的格式,直接过期(与 srcMtime 档升级重建同口径)。
    return builtAt === 0 || Date.now() - builtAt > maxIndexAgeMs();
  }
  // 盘上指纹是「一次完整 walk 的结论」:内容比对成立即可,不因它本身较旧就强制重建
  // (旧指纹的盲窗由同进程 15s 异步刷新兜底;按年龄强制重建会让空闲仓每小时重建一次)。
  const sampled = isSampledIndex(index);
  if (fp.maxMtime > index.srcMtime) return true;
  if (!sampled && index.srcCount !== undefined && fp.count !== index.srcCount) return true;
  // 采样对应集删除/编辑检出:构建期登记的取样文件消失(missing)或其 mtime 变大 = 索引确实过期
  // (廉价 existsSync+statSync,≤64 次/查询)。采样集外的新增无法检出——见 samplingNote 的诚实说明。
  if (sampled && index.srcSampled?.checkSet?.length) {
    for (const probe of index.srcSampled.checkSet) {
      try {
        if (statSync(join(root, probe.rel)).mtimeMs > probe.mtime) return true;
      } catch {
        return true; // 取样文件消失=采样集有删除
      }
    }
  }
  if (index.nodes.length === 0 && fp.count > 0) {
    return !isDeterministicEmpty(index); // 确定性空不再永久自愈(重建结果相同)
  }
  return false;
}

// ---- 按需查询(code_index 工具的消费面,全部读静态 JSON,毫秒级) ----

export interface SymbolQueryResult {
  symbol: C2fNode;
  callers: { id: string; name: string; file: string; line: number }[];
  callees: { id: string; name: string; file: string; line: number }[];
}

/** 查符号:定义+谁调用它+它调用谁(静态索引,毫秒级)。callers/callees 按调用方符号 id 去重
 * (同一调用方的多个调用点=一条关系,重复条目只放大数字不增信息)。 */
export function querySymbol(index: C2fIndex, name: string): SymbolQueryResult[] {
  // Object.hasOwn 守卫:JSON 回读后 byName 是普通对象,查 toString/constructor 等原型名且
  // 索引无此键时会读到继承函数——不守卫则 ids.map 二次崩(与 buildByMaps 同族)
  const ids = Object.hasOwn(index.byName, name) ? index.byName[name]! : [];
  const out = ids.map((id) => {
    const node = index.nodes.find((n) => n.id === id)!;
    const callers: SymbolQueryResult["callers"] = [];
    const seenCallers = new Set<string>();
    for (const e of index.edges) {
      if (e.to !== id || seenCallers.has(e.from)) continue;
      seenCallers.add(e.from);
      callers.push(nodeRef(index, e.from));
    }
    const callees: SymbolQueryResult["callees"] = [];
    const seenCallees = new Set<string>();
    for (const e of index.edges) {
      if (e.from !== id || !e.to || seenCallees.has(e.to)) continue;
      seenCallees.add(e.to);
      callees.push(nodeRef(index, e.to));
    }
    return { symbol: node, callers, callees };
  });
  // 2026-10-22 P0:同名定义在场时折叠 .h 原型——旧输出把声明也当「入口」并列,
  // 用户看到两条同名且都「无调用方」,删改判断被噪音污染。仅当存在真实定义时才折叠;
  // 纯头文件库(只有原型)保持原样。
  return out.some((r) => !r.symbol.proto) ? out.filter((r) => !r.symbol.proto) : out;
}

function nodeRef(index: C2fIndex, id: string): { id: string; name: string; file: string; line: number } {
  const n = index.nodes.find((x) => x.id === id);
  if (n) return { id: n.id, name: n.name, file: n.file, line: n.line };
  // 索引外 id(当前仅模块级虚调用方 `path#<module>`,engine 侧不入节点表)
  const hash = id.lastIndexOf("#");
  const name = hash >= 0 ? id.slice(hash + 1) : id;
  const file = hash >= 0 ? id.slice(0, hash) : "";
  return { id, name, file, line: 0 };
}

// ---- 符号名容错建议(2026-10-21 批次 B):精确未命中不让 agent 断链 ----

/** 带上界剪枝的编辑距离:超过 cap 立即返回 -1(候选扫描用,不付全矩阵代价)。 */
function editDistanceWithin(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return -1;
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1);
  let cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    let rowMin = cur[0]!;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (cur[j]! < rowMin) rowMin = cur[j]!;
    }
    if (rowMin > cap) return -1; // 行最小值已超界:整个对齐不可能再 ≤cap
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[n]! <= cap ? prev[n]! : -1;
}

function maxInCountOf(index: C2fIndex, ids: string[]): number {
  let max = 0;
  for (const id of ids) {
    const n = index.nodes.find((x) => x.id === id);
    if (n && n.inCount > max) max = n.inCount;
  }
  return max;
}

/** 符号名容错建议(2026-10-21 B):精确未命中时依次——①规范化命中(小写+剥分隔符的
 * 典范形相等:INIT_DETECTOR / initdetect → init_detector——agent 最常见的拼写误差是
 * 大小写与下划线,典范形等价是强信号)②典范形编辑距离≤2(真打字错:initdettor)。
 * 候选≤limit,组内按 inCount 降序(被调用多=更可能是目标)。索引内确定性计算,毫秒级;
 * 消费面=code_index_symbol 的 miss 提示(CLI/MCP/查询三面同源)。
 * 实锤背景:symbol INIT_DETECTOR / initdetect 双双「未找到符号」断链。 */
export function suggestSymbolNames(index: C2fIndex, name: string, limit = 5): string[] {
  if (!name || limit <= 0) return [];
  const canonQuery = canonSymbolName(name);
  const canonHits: { name: string; inCount: number }[] = [];
  const nearMisses: { name: string; inCount: number }[] = [];
  for (const cand of Object.keys(index.byName)) {
    if (!Object.hasOwn(index.byName, cand)) continue; // 原型键守卫(与 querySymbol 同口径)
    if (cand === name) continue;
    const canon = canonSymbolName(cand);
    if (!canon || canon.length < 3) continue;
    if (canon === canonQuery) {
      canonHits.push({ name: cand, inCount: maxInCountOf(index, index.byName[cand]!) });
      continue;
    }
    if (Math.abs(canon.length - canonQuery.length) > 2) continue;
    const d = editDistanceWithin(canon, canonQuery, 2);
    if (d >= 0) nearMisses.push({ name: cand, inCount: maxInCountOf(index, index.byName[cand]!) });
  }
  const byIn = (a: { name: string; inCount: number }, b: { name: string; inCount: number }): number =>
    b.inCount - a.inCount || a.name.localeCompare(b.name);
  return [
    ...canonHits.sort(byIn).map((c) => c.name),
    ...nearMisses.sort(byIn).map((c) => c.name),
  ].slice(0, limit);
}

/** 符号名典范形:小写+剥非字母数字(下划线/连字符/$ 等)——大小写与分隔符误差在此归一。 */
function canonSymbolName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
}

/** 查文件:该文件全部符号(含分类)。 */
export function queryFile(index: C2fIndex, file: string): C2fNode[] {
  const ids = Object.hasOwn(index.byFile, file) ? index.byFile[file]! : [];
  return ids.map((id) => index.nodes.find((n) => n.id === id)!).filter(Boolean);
}

/** 测试文件路径判定/isTestPath 定义在 ../path-filter(六面同源单一真相):
 * c2f 内部直接用,下游统一从 path-filter 引入——c2f 不再做 re-export 兼容层
 * (消除「导出但检测不到调用方」的假死代码信号,并让单一真相显式可查)。 */
import { isTestPath, isNonProductPath, nonProductFilterNote } from "../path-filter";

/** 查入口(trunk 函数):vibe coding 的「从哪开始读」。
 * 测试文件路径的入口排后(genie-voice 实锤:pytest 测试方法无人具名调用恒 trunk 且下游大,
 * 把真实入口挤出 top-N——工具目的是生产入口,测试入口仍保留在清单尾部不隐瞒)。
 * 2026-10-20(step-141 P1-1):非产品路径(docs/tutorial/examples/test mocks 等)入口默认过滤——
 * py-fastapi 的 docs_src/** 教程曾占 top8 的 6 席;口径=path-filter 单一真相,
 * opts.all=true 是逃生口(过滤条数由 queryEntryPointsMeta 如实呈报,不静默清零)。 */
export function queryEntryPoints(index: C2fIndex, limit = 20, opts: { all?: boolean } = {}): C2fNode[] {
  return queryEntryPointsMeta(index, limit, opts).kept;
}

/** 入口查询带过滤元信息(过滤条数/样本/Happy-path 注记由调用方渲染)。 */
export function queryEntryPointsMeta(
  index: C2fIndex,
  limit = 20,
  opts: { all?: boolean } = {},
): { kept: C2fNode[]; filtered: number; samples: string[]; note: string } {
  const byOut = (a: C2fNode, b: C2fNode): number => b.outCount - a.outCount;
  const eps = index.nodes.filter((n) => n.kind === "trunk");
  // 非产品路径先剔(--all 放行);测试文件仍保留但排后(诚实:测试入口不隐瞒)
  const product = opts.all ? eps : eps.filter((n) => !isNonProductPath(n.file));
  const filtered = eps.length - product.length;
  const samples: string[] = [];
  if (filtered > 0 && !opts.all) {
    for (const n of eps) {
      if (isNonProductPath(n.file) && samples.length < 3 && !samples.includes(n.file)) samples.push(n.file);
    }
  }
  const prod = product.filter((n) => !isTestPath(n.file)).sort(byOut);
  const test = product.filter((n) => isTestPath(n.file)).sort(byOut);
  const kept = [...prod, ...test].slice(0, limit);
  return { kept, filtered, samples, note: nonProductFilterNote(filtered, samples, opts) };
}

// ---- step-098(RC-096-A2②):JSX 使用证据 → 入口判定 ----
// React 组件的 JSX 引用(`<RTCCard />`)不是 CallExpression,ts-morph 调用收集天然看不见;
// `dynamic(() => import(...))` 动态 import 也不进 getImportDeclarations——组件被真实使用却
// 恒落 trunk(伪入口,agent_alpha RTCCard 实锤:page.tsx 用 <DynamicRTCCard> 而它顶进入口榜)。
// 不入引擎(引擎线另有归属),只在入口判定面做「使用证据降权」:有证据证明组件被 JSX 引用的
// trunk 节点降为 regular/leaf(不造边、不改 inCount——callers 语义不被污染;零证据不猜)。

/** tsconfig paths 别名表(最近 tsconfig 逐目录缓存;只支持 `前缀/*` 形——覆盖 Next.js `@/*` 主流形态)。 */
function loadTsconfigAliases(dir: string, root: string): { prefix: string; baseDir: string }[] {
  let cur = dir;
  for (let i = 0; i < 8; i++) {
    const p = join(root, cur === "." ? "tsconfig.json" : cur + "/tsconfig.json");
    if (existsSync(p)) {
      try {
        const text = readFileSync(p, "utf-8").replace(/\/\/[^\n]*/g, ""); // tsconfig 允许行注释
        const j = JSON.parse(text) as { compilerOptions?: { paths?: Record<string, string[]> } };
        const paths = j.compilerOptions?.paths ?? {};
        const out: { prefix: string; baseDir: string }[] = [];
        for (const [k, v] of Object.entries(paths)) {
          if (!k.endsWith("/*") || !v[0]?.endsWith("/*")) continue;
          // baseDir 值剥 `./` 前缀("./*"→""、"./src/*"→"src/")——与仓内相对路径口径对齐
          out.push({ prefix: k.slice(0, -1), baseDir: (cur === "." ? "" : cur + "/") + v[0].slice(0, -1).replace(/^\.\//, "") });
        }
        return out;
      } catch {
        return [];
      }
    }
    if (cur === "." || !cur.includes("/")) break;
    cur = cur.slice(0, cur.lastIndexOf("/"));
  }
  return [];
}

/** 模块说明符 → 仓内相对路径(存在性只查文件清单,不 stat;外部包/解析不了=null 不猜)。 */
function resolveModuleSpec(spec: string, fromFile: string, fileSet: Set<string>, aliases: { prefix: string; baseDir: string }[]): string | null {
  let base: string | null = null;
  if (spec.startsWith("./") || spec.startsWith("../")) {
    const dir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : "";
    const parts = (dir ? dir + "/" + spec : spec).split("/");
    const norm: string[] = [];
    for (const p of parts) {
      if (p === "." || p === "") continue;
      if (p === "..") norm.pop();
      else norm.push(p);
    }
    base = norm.join("/");
  } else {
    for (const a of aliases) {
      if (spec.startsWith(a.prefix)) { base = a.baseDir + spec.slice(a.prefix.length); break; }
    }
  }
  if (!base) return null;
  const exts = [".tsx", ".ts", ".jsx", ".js", ".mts", ".cts", ".mjs", ".cjs"];
  for (const e of exts) if (fileSet.has(base + e)) return base + e;
  if (fileSet.has(base)) return base;
  for (const e of exts) if (fileSet.has(base + "/index" + e)) return base + "/index" + e;
  return null;
}

/** 单文件 JSX 使用提取:大写 JSX 标签 + import 绑定表(命名/默认/动态)。 */
function extractJsxUsage(text: string): { tags: { name: string; line: number }[]; bindings: Map<string, { spec: string; importedName: string | null }> } {
  const tags: { name: string; line: number }[] = [];
  const bindings = new Map<string, { spec: string; importedName: string | null }>();
  // 命名 import(含 as):import { A, B as C } from "spec"
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    for (const part of m[1]!.split(",")) {
      const asM = /^\s*([\w$]+)\s+as\s+([\w$]+)\s*$/.exec(part);
      const local = (asM ? asM[2] : part.trim())!;
      const imported = (asM ? asM[1] : part.trim())!;
      if (/^[\w$]+$/.test(local)) bindings.set(local, { spec: m[2]!, importedName: imported });
    }
  }
  // 默认 import(可带命名部分):import D from / import D, {..} from —— 命名空间 import * as 不进此形态
  for (const m of text.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*["']([^"']+)["']/g)) {
    if (!bindings.has(m[1]!)) bindings.set(m[1]!, { spec: m[2]!, importedName: null });
  }
  // 动态 import 组件别名(next/dynamic、React.lazy):const X = dynamic(() => import("spec"))
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Z][\w$]*)\s*=\s*(?:dynamic|lazy)\s*\(\s*(?:async\s*)?(?:\(\)\s*=>\s*)?import\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    if (!bindings.has(m[1]!)) bindings.set(m[1]!, { spec: m[2]!, importedName: null });
  }
  // JSX 大写标签(<Name 后跟空白/>/换行;成员表达式 <A.B> 与 HTML 小写标签天然不命中)
  for (const m of text.matchAll(/<([A-Z][\w$]*)[\s/>]/g)) {
    const line = text.slice(0, m.index).split("\n").length;
    tags.push({ name: m[1]!, line });
  }
  return { tags, bindings };
}

/** JSX 使用证据降权:被 JSX 引用的 trunk 节点降 regular/leaf(不造边、不改 inCount)。
 * 归属规则(宁缺勿错):命名 import → 目标文件同名符号;默认/动态 import → 本地绑定名优先、
 * 目标文件 basename 兜底(唯一才认);index barrel → 沿 re-export 一跳再配(React 主流形态);
 * 未导入名 → 同文件符号。返回 {usages, demoted} 计数。
 * 调用点必须在 trunk 分类之后(buildC2fIndex=classify 后;增量链=recount 后)——顺序即语义。 */
export function applyJsxComponentUsage(root: string, files: string[], nodes: C2fNode[]): { usages: number; demoted: number } {
  const tsxFiles = files.filter((f) => /\.(tsx|jsx)$/.test(f));
  if (tsxFiles.length === 0) return { usages: 0, demoted: 0 };
  const fileSet = new Set(files);
  const byFileNodes = new Map<string, C2fNode[]>();
  for (const n of nodes) {
    const list = byFileNodes.get(n.file) ?? [];
    list.push(n);
    byFileNodes.set(n.file, list);
  }
  const aliasCache = new Map<string, { prefix: string; baseDir: string }[]>();
  let usages = 0;
  let demoted = 0;
  const demote = (n: C2fNode): void => {
    if (n.kind !== "trunk") return;
    n.kind = n.outCount === 0 ? "leaf" : "regular";
    demoted++;
  };
  /** 目标文件内按名匹配(裸名或容器尾段);唯一才认(多同名不猜)。 */
  const matchIn = (file: string, name: string, uniqueOnly: boolean): C2fNode | undefined => {
    const cands = (byFileNodes.get(file) ?? []).filter((n) => n.name === name || n.name.endsWith("." + name));
    return uniqueOnly ? (cands.length === 1 ? cands[0] : undefined) : cands[0];
  };
  /** 默认/动态导入的归属名序列:本地绑定名优先(导入方通常按组件命名),文件 basename 兜底。 */
  const baseOf = (file: string): string => (file.split("/").pop() ?? "").replace(/\.(tsx|jsx|ts|js|mts|cts|mjs|cjs)$/, "");
  /** barrel 一跳:index 文件的 re-export 说明符(export {..} from / export * from)。 */
  const barrelSpecs = (indexFile: string): string[] => {
    try {
      const t = readFileSync(join(root, indexFile), "utf-8");
      return [...t.matchAll(/export\s+(?:\{[^}]*\}|\*)\s*from\s*["']([^"']+)["']/g)].map((m) => m[1]!);
    } catch {
      return [];
    }
  };
  for (const f of tsxFiles) {
    let text: string;
    try {
      text = readFileSync(join(root, f), "utf-8");
    } catch {
      continue;
    }
    const { tags, bindings } = extractJsxUsage(text);
    if (tags.length === 0) continue;
    const dirKey = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ".";
    if (!aliasCache.has(dirKey)) aliasCache.set(dirKey, loadTsconfigAliases(dirKey, root));
    const aliases = aliasCache.get(dirKey)!;
    const resolvedCache = new Map<string, string | null>();
    const resolve = (spec: string, fromFile: string): string | null => {
      const key = fromFile + "" + spec;
      if (!resolvedCache.has(key)) resolvedCache.set(key, resolveModuleSpec(spec, fromFile, fileSet, aliases));
      return resolvedCache.get(key)!;
    };
    for (const tag of tags) {
      const b = bindings.get(tag.name);
      // 候选(文件,名字)对:命名 import=imported 名;默认/动态=本地名→basename;未导入=同文件同名
      const attempts: { file: string; name: string; uniqueOnly: boolean }[] = [];
      if (b) {
        const tf = resolve(b.spec, f);
        if (!tf) continue;
        if (b.importedName) {
          attempts.push({ file: tf, name: b.importedName, uniqueOnly: false });
        } else {
          attempts.push({ file: tf, name: tag.name, uniqueOnly: false }); // 本地绑定名(CameraBlock→Camera.tsx 实锤)
          attempts.push({ file: tf, name: baseOf(tf), uniqueOnly: true }); // basename 兜底(RTCCard.tsx 形态)
        }
      } else {
        attempts.push({ file: f, name: tag.name, uniqueOnly: false }); // 同文件定义+同文件使用
      }
      let hit: C2fNode | undefined;
      for (const a of attempts) {
        hit = matchIn(a.file, a.name, a.uniqueOnly);
        if (hit) break;
        // barrel 一跳:目标为 index 文件且直配失败 → 沿 re-export 再配一次(React 组件主流形态)
        if (baseOf(a.file) === "index") {
          for (const spec of barrelSpecs(a.file)) {
            const tf2 = resolve(spec, a.file);
            if (!tf2) continue;
            hit = matchIn(tf2, a.name, false) ?? (b && !b.importedName ? matchIn(tf2, baseOf(tf2), true) : undefined);
            if (hit) break;
          }
        }
        if (hit) break;
      }
      if (!hit) continue;
      usages++;
      demote(hit);
    }
  }
  return { usages, demoted };
}

// ---- code2flow 风格渲染(mermaid flowchart,子图=File/Class 群组框) ----

const EDGE_STYLE: Record<C2fEdge["kind"], string> = {
  this: "stroke:#c98f45",
  import: "stroke:#5b8ec9",
  unique: "stroke:#5aa06a",
  unresolved: "stroke:#6b5c4a,stroke-dasharray:4 3",
};

/** 渲染某符号邻域(code2flow 形态):所在 File 子图+Class 子图+上下游节点+分类着色。
 * 模块级虚调用方(索引外的 `path#<module>` id)合成伪节点上图——组合根调用关系是人读图的
 * 关键边,丢掉会让「谁调用它」在图上看不出来(2026-10-14)。 */
export function renderNeighborhood(index: C2fIndex, name: string, maxNodes = 26, depth = 1): string {
  const hits = querySymbol(index, name);
  if (hits.length === 0) return "flowchart TD\n  none[\"未找到符号: " + name + "\"]";
  const h = hits[0]!;
  const keep = new Map<string, C2fNode>();
  const depthOf = new Map<string, number>();
  keep.set(h.symbol.id, h.symbol);
  depthOf.set(h.symbol.id, 0);
  for (const c of h.callers.slice(0, 8)) {
    const n = nodeOrPseudo(index, c.id);
    if (n) { keep.set(n.id, n); depthOf.set(n.id, 1); }
  }
  for (const c of h.callees.slice(0, 8)) {
    const n = nodeOrPseudo(index, c.id);
    if (n) { keep.set(n.id, n); depthOf.set(n.id, 1); }
  }
  // depth≥2:从圆心按关系边 BFS 扩层(每节点每方向扇出 4、全局 maxNodes 封顶防爆炸);
  // 深层节点入 keep 后,渲染/×N 合并/分组与既有路径完全同一份。
  for (let d = 2; d <= depth && keep.size < maxNodes; d++) {
    const frontier = [...keep.keys()].filter((id) => (depthOf.get(id) ?? 0) === d - 1);
    for (const id of frontier) {
      if (keep.size >= maxNodes) break;
      let fan = 0;
      for (const e of index.edges) {
        if (keep.size >= maxNodes || fan >= 4) break;
        const other = e.to === id ? e.from : e.from === id ? e.to : null;
        if (!other || keep.has(other)) continue;
        const n = nodeOrPseudo(index, other);
        if (!n) continue;
        keep.set(n.id, n);
        depthOf.set(n.id, d);
        fan++;
      }
    }
  }
  return renderSubgraph(index, keep, h.symbol.id, maxNodes, depth > 1 ? depthOf : undefined);
}

/** 索引内节点直取;模块级虚调用方合成伪节点(kind=regular,不冒充入口/叶子);其余未知 id=null。 */
function nodeOrPseudo(index: C2fIndex, id: string): C2fNode | null {
  const real = index.nodes.find((x) => x.id === id);
  if (real) return real;
  if (id.endsWith("#" + MODULE_CALLER_ID)) {
    return { id, name: MODULE_CALLER_ID, file: id.slice(0, -("#" + MODULE_CALLER_ID).length), line: 0, kind: "regular", outCount: 0, inCount: 0 };
  }
  return null;
}

const MODULE_CALLER_ID = "<module>";

/** 渲染文件级 code2flow 图(全文件符号+文件内调用+跨文件目标占位)。
 * 含本文件的模块级调用(`<module>` 伪节点:顶层语句/匿名回调发起的边,2026-10-14)。 */
export function renderFile(index: C2fIndex, file: string, maxNodes = 30): string {
  const nodes = queryFile(index, file);
  if (nodes.length === 0) return "flowchart TD\n  none[\"文件无符号: " + file + "\"]";
  const keep = new Map<string, C2fNode>();
  for (const n of nodes.slice(0, maxNodes)) keep.set(n.id, n);
  // 模块级调用:该文件 `<module>` 虚调用方有出边则上图(合并渲染由 renderSubgraph 按对去重)
  const modId = `${file}#${MODULE_CALLER_ID}`;
  if (!keep.has(modId) && index.edges.some((e) => e.from === modId)) {
    keep.set(modId, { id: modId, name: MODULE_CALLER_ID, file, line: 0, kind: "regular", outCount: 0, inCount: 0 });
  }
  // 跨文件调用目标占位(含 <module> 的出边目标;leaf 类不拉全)
  for (const n of [...keep.values()]) {
    for (const e of index.edges) {
      if (e.from === n.id && e.to && !keep.has(e.to) && keep.size < maxNodes + 8) {
        const t = index.nodes.find((x) => x.id === e.to);
        if (t) keep.set(t.id, t);
      }
    }
  }
  return renderSubgraph(index, keep, undefined, maxNodes);
}

/** code2flow 风格 mermaid:File 子图(虚线框)+Class 子图(实线框)+节点分类色+边分色。 */
function renderSubgraph(index: C2fIndex, keep: Map<string, C2fNode>, centerId: string | undefined, _maxNodes: number, depthOf?: Map<string, number>): string {
  const lines: string[] = ["flowchart TD"];
  const idMap = new Map<string, string>();
  let seq = 0;
  const nid = (id: string) => {
    if (!idMap.has(id)) idMap.set(id, "n" + seq++);
    return idMap.get(id)!;
  };
  // 分组:file → container → nodes
  const byFileLocal = new Map<string, Map<string, C2fNode[]>>();
  for (const n of keep.values()) {
    if (!byFileLocal.has(n.file)) byFileLocal.set(n.file, new Map());
    const cont = n.container ?? "";
    const m = byFileLocal.get(n.file)!;
    if (!m.has(cont)) m.set(cont, []);
    m.get(cont)!.push(n);
  }
  let fileSeq = 0;
  for (const [file, containers] of byFileLocal) {
    const fid = "f" + fileSeq++;
    lines.push(`  subgraph ${fid}["File: ${file}"]`);
    for (const [cont, ns] of containers) {
      if (cont) {
        const cid = fid + "c" + seq++;
        lines.push(`    subgraph ${cid}["Class: ${cont}"]`);
        for (const n of ns) lines.push(`      ${nid(n.id)}["${nodeLabel(n)}"]`);
        lines.push("    end");
      } else {
        for (const n of ns) lines.push(`    ${nid(n.id)}["${nodeLabel(n)}"]`);
      }
    }
    lines.push("  end");
  }
  // 边(只画 keep 内的;同(调用方,被调方)对合并成一条——hub 的几十个调用点逐行画边会把图
  // 炸成不可读(实测 handleMessage 90+ 条边指向同一 safeSend),合并标 ×N 保留调用密度信息)
  const edgeAgg = new Map<string, { from: string; to: string; line: number; count: number }>();
  for (const e of index.edges) {
    if (!keep.has(e.from) || !keep.has(e.to)) continue;
    const k = `${e.from}|${e.to}`;
    const cur = edgeAgg.get(k);
    if (cur) cur.count++;
    else edgeAgg.set(k, { from: e.from, to: e.to, line: e.line, count: 1 });
  }
  for (const a of edgeAgg.values()) {
    // depth 标注(仅 depth>1 渲染传入 depthOf 时):边层级=距圆心更远一端的层数;d1 不标(缺省输出逐字节不变)
    const dMark = depthOf ? ` d${Math.max(depthOf.get(a.from) ?? 1, depthOf.get(a.to) ?? 1)}` : "";
    lines.push(`  ${nid(a.from)} -->|${a.line}${a.count > 1 ? ` ×${a.count}` : ""}${dMark}| ${nid(a.to)}`);
  }
  // 中心高亮
  if (centerId && idMap.has(centerId)) lines.push(`  style ${idMap.get(centerId)} fill:#c98f45,stroke:#ece1d1,color:#0b0806,font-weight:bold`);
  lines.push("  classDef trunk fill:#8a5a2a,stroke:#c98f45,color:#fff;");
  lines.push("  classDef leaf fill:#5aa06a,stroke:#7ec98f,color:#fff;");
  lines.push("  classDef regular fill:#4a4440,stroke:#8a7a5a,color:#ece1d1;");
  // 按类打 class
  const kinds: Record<NodeKind, string[]> = { trunk: [], leaf: [], regular: [] };
  for (const n of keep.values()) kinds[n.kind].push(nid(n.id));
  if (kinds.trunk.length) lines.push("  class " + kinds.trunk.join(",") + " trunk;");
  if (kinds.leaf.length) lines.push("  class " + kinds.leaf.join(",") + " leaf;");
  if (kinds.regular.length) lines.push("  class " + kinds.regular.join(",") + " regular;");
  return lines.join("\n");
}

/** mermaid 标签转义(review 抓:engine 可产 <anonymous> 类名,裸拼会断图)。 */
function escLabel(s2: string): string {
  return s2.replace(/"/g, "'").replace(/[<>]/g, (c) => (c === "<" ? "(" : ")"));
}
function nodeLabel(n: C2fNode): string {
  if (n.name === MODULE_CALLER_ID) return `◆ ${escLabel(MODULE_CALLER_ID)}<br/>${escLabel(n.file.split("/").slice(-1)[0] ?? n.file)}`;
  const icon = n.kind === "trunk" ? "▼" : n.kind === "leaf" ? "●" : "○";
  return `${icon} ${escLabel(n.name)}<br/>${escLabel(n.file.split("/").slice(-1)[0] ?? n.file)}:${n.line}`;
}
