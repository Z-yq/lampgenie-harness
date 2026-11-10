/**
 * L1 调用图引擎( §6.1/6.2):ts-morph semantic 档。
 * 归属启发式(code2flow 模型移植):this.x→同类;import 符号→源模块;唯一名兜底。
 * 每边带 tier=semantic + evidence=ast(file:line)。
 */
import { Project, SyntaxKind, VariableDeclarationKind, type SourceFile, type CallExpression, type Node as MorphNode } from "ts-morph";
import { readdir, stat, open } from "node:fs/promises";
import { join } from "node:path";
import { isVendoredPath } from "../path-filter";

/** 索引抽取器版本(单一真相;**任何抽取行为变化必须 +1**)。
 * 为什么需要它:增量复用按文件指纹(mtime+size)搬运节点/边——源码没变但抽取器升级时,
 * 老文件会永远停留在旧抽取结果(验收注意:engine.ts 源码顶层 50 条只报 28 条、
 * 纯类型文件 0 条,doctor 却因 builtAt/mtime 新鲜而假绿)。
 * 版本语义:
 * - v1(隐式,产物无字段)= 之前的抽取器(仅函数/类/方法/带注解变量);
 *  - v2=interface/type/enum/模块级 const/嵌套箭头与嵌套函数全收(file 面补全)。
 * 消费方单一真相: c2f.buildC2fIndex(落盘 C2fIndex.extractorVersion)、
 * code-sense-cli/incremental(复用闸 + sidecar.extractorVersion + 一次全量迁移)、
 * code-sense-cli/doctor(索引版本 vs 本常量的一致性告警)。 */
export const INDEX_EXTRACTOR_VERSION = 6;

/** 符号 kind 全集(engine/c2f/incremental 共用;新增 kind 必须同步 callgraph/c2f 的
 * symKind 与 isNonCallableSymbolKind 豁免口径)。
 * - function/method/class/arrow/inline-js:调用图语义目标(可被 callers/callees 解析)
 * - typedef/variable/interface/type/enum:声明符号,只进符号表/查询面,不作调用解析目标。 */
export type SymbolKind = "function" | "method" | "class" | "arrow" | "typedef" | "variable" | "interface" | "type" | "enum" | "inline-js";

/** 非调用解析目标 kind(typedef/variable 为既有豁免; 补 interface/type/enum——
 * 与 querySymbol 可查性解耦:CallGraph.byName 不收这些名字,索引面 buildByMaps 仍全收)。 */
export function isNonCallableSymbolKind(kind: SymbolKind): boolean {
  return kind === "typedef" || kind === "variable" || kind === "interface" || kind === "type" || kind === "enum";
}

export interface Symbol {
  name: string;
  /** 唯一标识:相对路径#容器.名 */
  id: string;
 /** typedef/variable 为诚实 kind 扩展(C 全档 typedef 与 lexical 档变量/数组);
   * 消费面只特判 class,新 kind 按「非类」走通用语义。
   * senseB21:inline-js=模板字符串内嵌 <script>/JS 段的虚拟符号(网页结构感知);参与
   * trunk/leaf 语义(有调用边),C2fNode.symKind 透传同名标注。
 * interface/type/enum=TS 类型声明(符号表可见,非调用解析目标);
   * arrow=const 箭头函数/函数表达式(变量名即符号名,参与调用图)。 */
  kind: SymbolKind;
  file: string;
  line: number;
  container?: string; // 最近类容器(Class 分组;函数内嵌符号无类时为 undefined)
 /** :词法父符号限定名(所在 class/函数/接口;类方法=Class.method 的 Class,
   * 嵌套箭头=外层函数限定名)。顶层为空。id 的 `#` 后限定段与它一致;
   * C2fNode.parent 透传(显示名=parent+'.'+name)。 */
  parent?: string;
  signature?: Signature;
 /** Go 类型声明的 struct/interface 区分(094 精度门假边归因:仓内接口
   * balancer.Balancer 与实现体 gracefulswitch.Balancer 撞名,receiverType 窄化被「唯一命中」)。
   * 仅 Go adapter 注册;缺省=非 Go 类型/别名/旧索引(未知)——消费侧(resolveStructCrossFile
   * 撞名闸)只对 "interface" 特判,其余一律按原语义(加性字段,向后兼容)。 */
  typeKind?: "struct" | "interface";
 /** P1( §2):声明时数据类型文本(变量/typedef 专用;归一化空白,截 120)。
   * 缺省=该符号无类型信息(如实)。查询面(file action/vars)有则显。 */
  dataType?: string;
 /** P0:C/C++ 函数原型(declaration/field_declaration 无函数体)。
   * 跨文件同名消歧时定义优先:候选池里只要有唯一非原型定义,就落到它(修复 .cpp 测试调用
   * 因 .c 定义 + .h 原型双候选而整条弃边)。缺省=定义或非 C/C++ 语言。 */
  proto?: boolean;
 /** 分层覆盖:lexical=词法兜底档符号(零边、不进 byName、不进
   * entrypoints、不作 relink 目标——只进覆盖计数与符号查询);缺省=structural。 */
  tier?: "structural" | "lexical";
}

export interface Signature {
  params: { name: string; type?: string; optional?: boolean; default?: string }[];
  returnType?: string;
  generics?: string[];
}

export interface FlowEdge {
  from: string;  // symbol id
  to: string;    // symbol id(解析不到目标时 toName 保留)
  toName?: string;
  file: string;
  line: number;
  tier: "semantic" | "structural" | "lexical";
  evidenceKind: "ast" | "index" | "readme" | "grep" | "suggested" | "inferred";
 /** A1:结构档接收者形态候选(obj.method)携带接收者类型证据(类名)——
   * merge 层按 Class.method 候选集消歧(替代对方法名必然同名失效的「全图唯一名」闸)。 */
  receiverType?: string;
 /** receiverType 证据的包目录钉扎(仅 Go 产):白名单限定类型 `pkg.T`→pkg 的仓内
   * 相对目录;裸名 T→引用方文件目录(同包语义)。撞名闸按它精确判定「证据是否指向接口所在包」
 * ——同名接口在别包时证据必是结构体,放行(否则误杀同包结构体真边,grpc-go 经验证 58 条);
   * 缺省(非 Go 候选)=保守语义:名册命中即弃边。 */
  receiverTypeDir?: string;
 /** A1:模块别名候选(import a.b as z → z.foo)携带来源模块路径提示(dots→slashes 子串)。 */
  moduleHint?: string;
 /** :未解析边的调用形态(relink 作用域闸)。prop=属性调用(x.trim/fs.readFile),
   * bound=标识符在本文件有局部绑定(参数/局部变量/import),二者都不得在增量 relink 里按
 * 「全仓唯一同名」跨文件兜底——依据:code-sense 全量索引 relink 把 400+ 个字符串 .trim
   * 连到 RingBuffer.trim,整仓模块图出现 code-sense→harness-terminal ×422 的假主干。
   * bare=自由标识符(保留 code2flow 的唯一名兜底);new=new Cls()(保留类构造解析机会)。 */
  callForm?: "bare" | "prop" | "new" | "bound" | "import" | "external";
}

export interface CallGraph {
  symbols: Map<string, Symbol>;
  /** caller id → edges */
  outEdges: Map<string, FlowEdge[]>;
  /** callee id → edges */
  inEdges: Map<string, FlowEdge[]>;
  /** 名字索引(唯一名兜底用):name → ids */
  byName: Map<string, string[]>;
 /** 文件级 import 依赖( impact):被导入文件(绝对路径)→ 导入方文件集合。
 * ts-morph 档在构建期一次解析; 起 Go 经 structFileImports 展开后并入(见 c2f
 * expandGoImports);python/java 结构档的 import 映射为后续轮边界(登记于)。 */
  imports?: Map<string, Set<string>>;
 /** RC-B2:结构档 adapter 上报的逐文件原始 import 路径清单(绝对路径文件 →
   *  原始 import 路径列表,Go 的 importBindings 值集)。文件→文件的映射需 go.mod 模块锚,
   *  由 c2f/incremental 两侧共用 expandGoImports 展开,adapter/引擎不猜。 */
  structFileImports?: Map<string, string[]>;
 /** RC-B5:构建期弃边台账(跨文件候选解析失败被移除的边,按被调名聚合)。
 * 「诚实弃边」此前完全不可见(096 评测 has_access 锚注意)——落盘后由索引携带,
   *  impact/symbol 输出面可读。自归属 miss(self.x 兄弟查找失败)不在此列:它们以
   *  to="" 未解析边形态留在索引里,查询侧可直接计数。 */
  droppedCandidates?: Map<string, DroppedCandidateEntry>;
 /** 分层覆盖( §1):结构档逐文件 outcome(full/lexical/empty/skipped),
   * mergeStructAdapters 填充;coverage manifest 的分档计数与 skippedReasons 数据源。
   * 无 outcome 的文件(ts/js 语义档)不进分层口径(如实:其「0 符号」不可判 empty,RC-C)。 */
  structOutcomes?: Map<string, { tier: "full" | "lexical" | "empty" | "skipped"; reason?: string; errors?: boolean }>;
 /** :ts/js 语义档解析前守卫跳过的文件(相对路径 → 原因)。此前只进 coverage 的自由文本,
   *  查询面无法把「文件无索引符号」翻译成可操作原因;结构化后由索引携带、formatQuery 消费。 */
  guardSkips?: Map<string, string>;
 /** 全覆盖:本次扫描的全部源码文件(相对路径,含零符号/守卫跳过/解析失败)。
   *  索引据此建文件级状态表——任何文件都能回答「在不在扫描面/为什么没有符号」,
   *  不再把「有文件但无符号」误报成「文件不存在/无索引」。 */
  scannedFiles?: string[];
 /** :ts-morph 装载失败的文件(相对路径)。旧实现 catch 后静默丢弃,
   *  这类文件既不在 byFile 也没有任何原因登记;现结构化落盘,查询面如实说明。 */
  unparsableFiles?: string[];
 /** RC-G:上限/RSS 护栏截断登记(如实,不静默)。 */
  structTruncated?: { reason: string; limit?: number };
  buildMs: number;
}

/** RC-B5:弃边台账条目(按被调名聚合)。 */
export interface DroppedCandidateEntry {
  count: number;
  /** 原因 → 次数(三桶:同名候选非唯一/同名存在但证据不匹配/全图无同名符号)。 */
  reasons: Record<string, number>;
  /** 样本调用点(≤3,调试锚点;计数权威在 count)。 */
  samples: { file: string; line: number }[];
}

/** ts-morph 语义档扩展名(ts/js)——ts-morph pass 只吃这些(把 .py 喂给 ts-morph 会解析出垃圾符号)。 */
export const GRAPH_TS_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
/** 结构 adapter 档扩展名(python/go/java, §5)。 起进全图索引——此前 adapter
 * 只接在懒解析路径(buildCallGraphFromFiles),全图索引(listSourceFiles)根本不列 .py/.go/.java,
 * 五个 Python 仓的索引全空或只剩杂散 js,code_index 查询恒「未找到符号」。 */
export const GRAPH_STRUCT_EXT = new Set([".py", ".go", ".java",
 // C/C++(tree-sitter-c/cpp 结构档;清单与 adapters/cpp.ts CPP_EXTS 保持一致)
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx",
 // Rust/C#/Ruby/PHP(tree-sitter-wasms 同包资产;adapters/{rust,csharp,ruby,php}.ts)
  ".rs", ".cs", ".rb", ".php"]);
/** 源文件全集(文件列表+指纹口径)=两类合集。 */
export const GRAPH_SOURCE_EXT = new Set([...GRAPH_TS_EXT, ...GRAPH_STRUCT_EXT]);
export const GRAPH_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "vendor", "ref", "coverage", ".zcode", "docs",
  // python 生态目录(venv 无点前缀须显式跳;.venv 点前缀已天然跳过;__pycache__ 只含 .pyc,防患)
  "venv", "__pycache__", "site-packages"]);

/** 扫描文件上限:GENIE_SENSE_MAX_FILES(env,≥10)可配,缺省 6000( RC-G:
 * 4000 硬上限把 opencv 4590 截断在 doc/*.js 名额上;步进幅度控制单仓内存上界,
 * 配合 mergeStructAdapters 的 RSS 护栏)。所有扫描口径(listSourceFiles/coverage 磁盘枚举/
 * c2f walkFingerprintSync)必须同走此函数,防「同扫描同分母」与假过期口径漂移。 */
export function maxFilesDefault(): number {
  const raw = process.env.GENIE_SENSE_MAX_FILES;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 10 ? n : 6000;
}

/** mergeStructAdapters 的 RSS 护栏( RC-G):超过即停止处理剩余结构档文件,
 * 余下文件 outcome=skipped(reason=内存护栏)并登记 truncation——宁缺勿 OOM(WSL 崩机教训)。 */
export function maxRssBytes(): number {
  const raw = process.env.GENIE_SENSE_MAX_RSS_MB;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 256 ? n * 1024 * 1024 : 4608 * 1024 * 1024;
}

// ---- RC-K:解析前防御(压缩产物/超大单文件) ----
// owncast 注意:static/web/_next 539 个 Next.js 压缩 chunk(最大 722KB/34 行、510KB/1 行)使整仓
// 索引在任何堆帽下死于 heap OOM(exit 134)或 RangeError 栈溢出(exit 1)——一目录打死全仓。
// 防 OOM 只能防在前:解析前 stat+头部采样判压缩产物/超大,跳过并诚实登记(不进 covered)。
// 阈值对正常源码零误伤设计:手写代码平均行长 <200;单条长字符串常量的文件长行占比极低不命中。
/** 超大单文件守卫:源文件超过 4MB 不解析(堆压力;诚实 skipped,GENIE_SENSE_PARSE_GUARD=off 关)。
 * 2MB → 4MB。7700 审计注意:apps/gateway/src/panel.ts 2.28MB(面板主文件)被 2MB
 * 守卫整文件跳过 → 上千个前端函数在索引里不存在,symbol/impact 永远未命中。4MB 仍远低于 ts-morph
 * 的堆压力线,且压缩产物仍由后面的「平均行长/长行占比」启发拦住。 */
export const PARSE_GUARD_MAX_BYTES = 4 * 1024 * 1024;
/** 压缩产物启发只对 ≥32KB 的文件采样(小文件解析成本可忽略,不设防)。 */
export const PARSE_GUARD_MIN_BYTES = 32 * 1024;
/** 采样头部字节数。 */
export const PARSE_GUARD_SAMPLE_BYTES = 64 * 1024;
/** 平均行长阈值(压缩 bundle 采样均值通常 >5k;手写代码 <200)。 */
export const PARSE_GUARD_AVG_LINE = 2000;
/** 「长行」判定行宽与占比(双条件防单条长字符串常量误杀:须 ≥3 条长行且占比 >50%)。 */
export const PARSE_GUARD_LONG_LINE = 1000;

const guardCache = new Map<string, { key: string; reason: string | null }>();

/** 解析前守卫判定:返回 null=放行;返回字符串=跳过原因。stat+头部采样,不读全文。 */
export async function parseGuardReason(absPath: string): Promise<string | null> {
  if (process.env.GENIE_SENSE_PARSE_GUARD === "off") return null;
  let st;
  try { st = await stat(absPath); } catch { return null; }
  if (!st.isFile()) return null;
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = guardCache.get(absPath);
  if (hit && hit.key === key) return hit.reason;
  let reason: string | null = null;
  if (st.size > PARSE_GUARD_MAX_BYTES) {
    reason = `超大单文件 ${(st.size / 1048576).toFixed(1)}MB > 4MB 解析上限(GENIE_SENSE_PARSE_GUARD=off 可关)`;
  } else if (st.size >= PARSE_GUARD_MIN_BYTES) {
    try {
      const fh = await open(absPath, "r");
      try {
        const buf = Buffer.alloc(Math.min(PARSE_GUARD_SAMPLE_BYTES, st.size));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        const sample = buf.subarray(0, bytesRead).toString("utf-8");
        const lines = sample.split("\n");
        let longLines = 0;
        for (const l of lines) if (l.length > PARSE_GUARD_LONG_LINE) longLines++;
        const nLines = Math.max(1, lines.length);
        const avg = Math.round(sample.length / nLines);
        const ratio = longLines / nLines;
        if (avg > PARSE_GUARD_AVG_LINE) {
          reason = `压缩产物启发: 采样平均行长 ${avg} 字符 > ${PARSE_GUARD_AVG_LINE}(高度疑似压缩 bundle;GENIE_SENSE_PARSE_GUARD=off 可关)`;
        } else if (longLines >= 3 && ratio > 0.5) {
          reason = `压缩产物启发: 长行(>${PARSE_GUARD_LONG_LINE} 字符)占比 ${Math.round(ratio * 100)}%(高度疑似压缩 bundle;GENIE_SENSE_PARSE_GUARD=off 可关)`;
        }
      } finally { await fh.close(); }
    } catch { /* 读不了=放行(解析层自会报错) */ }
  }
  if (guardCache.size > 4096) guardCache.clear();
  guardCache.set(absPath, { key, reason });
  return reason;
}

/** 先自枚举(排除 vendor/node_modules——addSourceFilesAtPaths 后过滤太晚会 OOM),再加载。
 * 导出:索引 staleness 的 mtime 指纹要枚举同一文件集(与构建同口径,防两处漂移)。 */
export async function listSourceFiles(root: string, limit = maxFilesDefault()): Promise<string[]> {
  return (await listSourceFilesDetailed(root, limit)).files;
}

/** 同 listSourceFiles,附截断元数据( RC-G:截断必须如实登记进 coverage manifest,
 * 不许「分母=截断后集合」的静默口径)。skipped 不计总数(要计数须走完整个 walk,与上限目的相悖);
 * 上限语义=「至少 limit 个,可能有更多」。 RC-L:超限截断改**确定性公平采样**——
 * 旧版按目录遍历序满 limit 即停(grafana 经验证 go 只入扫 22%/ts 31%/tsx 19%,覆盖表象下 76%
 * 仓库未见过),新版全量枚举(安全帽)后按扩展名配额(最大余数法)分配;totalSeen=磁盘实见数。 */
export interface SourceScan { files: string[]; truncated: boolean; limit: number; totalSeen?: number }

export async function listSourceFilesDetailed(root: string, limit = maxFilesDefault()): Promise<SourceScan> {
  // 阶段一:全量枚举(路径级,安全帽 ENUM_CAP 防病态仓撑爆内存)。旧版满 limit 即停——
  // 截断面偏向遍历序靠前目录且各语言配额失衡(RC-L);公平采样必须先知道各语言磁盘总量。
  const ENUM_CAP = Math.max(limit * 8, 65536);
  const out: string[] = []; // walk 序(不截断时按旧序原样返回,零回退面)
  const groups = new Map<string, number[]>(); // 扩展名 → out 下标(公平采样分组)
  let enumCapped = false;
  async function walk(dir: string, depth: number): Promise<void> {
    if (out.length >= ENUM_CAP) { enumCapped = true; return; }
    if (depth > 12) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= ENUM_CAP) { enumCapped = true; return; }
      if (e.name.startsWith(".")) continue;
      if (GRAPH_SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (GRAPH_SOURCE_EXT.has(e.name.slice(e.name.lastIndexOf(".")))) {
        const ext = e.name.slice(e.name.lastIndexOf("."));
        const g = groups.get(ext);
        if (g) g.push(out.length); else groups.set(ext, [out.length]);
        out.push(full);
      }
    }
  }
  await walk(root, 0);
  const total = out.length;
  if (total <= limit && !enumCapped) {
    return { files: out, truncated: false, limit, totalSeen: total };
  }
  // 阶段二:按扩展名配额公平采样(最大余数法/Hamilton)。确定性三保险:扩展名字典序、
  // 余数并列按扩展名字典序、组内按 walk 序取前 quota 个——同盘同参可复现。
  const exts = [...groups.keys()].sort();
  const quota = new Map<string, number>();
  let allocated = 0;
  const rems: { ext: string; rem: number }[] = [];
  for (const ext of exts) {
    const n = groups.get(ext)!.length;
    const q = Math.floor((n * limit) / total);
    quota.set(ext, q);
    allocated += q;
    rems.push({ ext, rem: (n * limit) / total - q });
  }
  rems.sort((a, b) => b.rem - a.rem || (a.ext < b.ext ? -1 : a.ext > b.ext ? 1 : 0));
  for (let k = 0; allocated < limit && k < rems.length; k++) {
    quota.set(rems[k]!.ext, quota.get(rems[k]!.ext)! + 1);
    allocated++;
  }
  const files: string[] = [];
  for (const ext of exts) {
    const idxs = groups.get(ext)!.slice(0, Math.min(quota.get(ext) ?? 0, groups.get(ext)!.length));
    for (const i of idxs) files.push(out[i]!);
  }
  return { files, truncated: true, limit, totalSeen: total };
}

/** 扫描 root,构建调用图(ts/js 走 ts-morph 语义档;python/go/java 走结构 adapter,见 mergeStructAdapters)。
 * RC-K:①ts/js 进 ts-morph 前过 parseGuardReason(压缩产物/超大文件跳过并聚合登记,
 * 不进 covered);②符号/调用收集逐文件 try/catch——此前一文件 throw(压缩产物栈溢出)全仓弃。 */
export async function buildCallGraph(root: string): Promise<CallGraph> {
  const t0 = Date.now();
  const project = new Project({ skipAddingFilesFromTsConfig: true });
  const scan = await listSourceFilesDetailed(root);
  const paths = scan.files;
  const guardSkips: { rel: string; reason: string }[] = [];
  const unparsable: string[] = [];
  for (const p of paths) {
    if (!GRAPH_TS_EXT.has(p.slice(p.lastIndexOf(".")))) continue; // 结构语言走 adapter,不喂 ts-morph
    const guard = await parseGuardReason(p);
    if (guard) { guardSkips.push({ rel: p.replace(root + "/", "").replace(/\\/g, "/"), reason: guard }); continue; }
    try { project.addSourceFileAtPath(p); } catch { unparsable.push(p.replace(root + "/", "")); /* 登记后不静默丢 */ }
  }
  const files = project.getSourceFiles();

  const graph: CallGraph = {
    symbols: new Map(), outEdges: new Map(), inEdges: new Map(), byName: new Map(),
    buildMs: 0,
    scannedFiles: paths.map((p) => p.replace(root + "/", "").replace(/\\/g, "/")),
    ...(guardSkips.length > 0 ? { guardSkips: new Map(guardSkips.map((g) => [g.rel, g.reason])) } : {}),
    ...(unparsable.length > 0 ? { unparsableFiles: unparsable.map((p) => p.replace(/\\/g, "/")) } : {}),
  };

  // Pass 1: 收集符号(函数/方法/类)——逐文件包保护(RC-K:坏文件只废自己)
  let tsParseFailures = 0;
  for (const sf of files) {
    try { collectSymbols(sf, graph); } catch { tsParseFailures++; }
  }

  // Pass 2: 收集调用边(归属启发式)——逐文件包保护
  for (const sf of files) {
    try { collectCalls(sf, graph, root); } catch { tsParseFailures++; }
  }

 // Pass 2.5: 文件 import 依赖( impact 的 import 通道数据源):
  // 被 import 的仓内文件 → 导入方文件。解析不了来源(外部包/动态拼接)不记——宁可缺不假连。
  const imports = new Map<string, Set<string>>();
  for (const sf of files) {
    for (const imp of sf.getImportDeclarations()) {
      const src = imp.getModuleSpecifierSourceFile();
      if (!src) continue;
      const target = src.getFilePath();
      const from = sf.getFilePath();
      if (target === from) continue;
      if (!imports.has(target)) imports.set(target, new Set());
      imports.get(target)!.add(from);
    }
  }
  graph.imports = imports;

 // Pass 3: 结构 adapter 汇入(python/go/java; 全图索引接入)
  await mergeStructAdapters(graph, root, paths.map((p) => p.replace(root + "/", "")));

  // senseB21 Pass 3.5: 内嵌脚本索引(ts/js 文件模板字符串里的 <script>/JS 段)——置于
  // mergeStructAdapters 之后:inline 符号名不进 resolveStructCrossFile 的候选视野(浏览器侧
  // JS 永不解析到服务端符号,反向同理);解析失败=该文件零产出,不毙整图。
  // (动态 import 带 .js 后缀:dist ESM 直连消费时无后缀会 ERR_MODULE_NOT_FOUND)
  {
    const { collectInlineJs } = await import("./inline-js.js");
    for (const sf of files) {
      try {
        await collectInlineJs(sf, graph, root);
      } catch { /* 单文件内嵌提取失败:静默诚实降级 */ }
    }
  }

 // 扫描上限截断如实登记( RC-G)——「分母=截断后集合」不再静默;
  // RSS 护栏登记(merge 内已设)优先,不覆盖。
 // RC-K:守卫跳过/解析失败聚合登记(诚实计量,不进 covered;不进分层口径防 coveragePct 假跌)
  const guardNotes: string[] = [];
  if (guardSkips.length > 0) {
    const sample = guardSkips.slice(0, 3).map((g) => g.rel).join(", ");
    guardNotes.push(`${guardSkips.length} 个文件解析前跳过(压缩产物/超大文件守卫: ${sample}${guardSkips.length > 3 ? " …" : ""})`);
  }
  if (tsParseFailures > 0) guardNotes.push(`${tsParseFailures} 个文件解析失败跳过(逐文件包保护,不毙全仓)`);
  if (guardNotes.length > 0) {
    const note = guardNotes.join("; ") + "(GENIE_SENSE_PARSE_GUARD=off 可关守卫)";
    graph.structTruncated = graph.structTruncated ? { reason: `${graph.structTruncated.reason};${note}` } : { reason: note };
  }
  if (scan.truncated && !graph.structTruncated) {
    const seen = scan.totalSeen ?? `${scan.limit}+`;
    graph.structTruncated = { reason: `扫描达文件上限 ${scan.limit}(磁盘实见 ${seen},可用 GENIE_SENSE_MAX_FILES 调节;超限按语言配额公平采样),可能存在未扫描文件`, limit: scan.limit };
  } else if (scan.truncated && graph.structTruncated) {
    graph.structTruncated = { reason: `${graph.structTruncated.reason};扫描达文件上限 ${scan.limit}(磁盘实见 ${scan.totalSeen ?? "?"},按语言配额公平采样)` };
  }
  graph.buildMs = Date.now() - t0;
  return graph;
}

function relPath(sf: SourceFile, root: string): string {
  return sf.getFilePath().replace(root + "/", "");
}

/** 声明节点的自身符号名(父链/自身限定名共用):
 * - 函数/方法/类/接口/类型别名/enum:声明名(匿名函数/类保留诚实占位符)
 * - const/let/var x = () => {} / x = function () {}:变量名即符号名(匿名回调不命名→undefined)
 * - 其余节点(VariableDeclaration/Block/...)无自身名。 */
function selfDeclName(node: MorphNode): string | undefined {
  switch (node.getKind()) {
    case SyntaxKind.FunctionDeclaration:
      return node.asKind(SyntaxKind.FunctionDeclaration)!.getName() ?? "<anonymous>";
    case SyntaxKind.MethodDeclaration:
      return node.asKind(SyntaxKind.MethodDeclaration)!.getName();
    case SyntaxKind.ClassDeclaration:
      return node.asKind(SyntaxKind.ClassDeclaration)!.getName() ?? "<anonymous-class>";
    case SyntaxKind.InterfaceDeclaration:
      return node.asKind(SyntaxKind.InterfaceDeclaration)!.getName();
    case SyntaxKind.TypeAliasDeclaration:
      return node.asKind(SyntaxKind.TypeAliasDeclaration)!.getName();
    case SyntaxKind.EnumDeclaration:
      return node.asKind(SyntaxKind.EnumDeclaration)!.getName();
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.FunctionExpression: {
      const p = node.getParent();
      if (p?.getKind() !== SyntaxKind.VariableDeclaration) return undefined;
      const nameNode = p.asKind(SyntaxKind.VariableDeclaration)!.getNameNode();
      if (nameNode.getKind() !== SyntaxKind.Identifier) return undefined;
      const name = nameNode.getText().trim();
      return /^[$_\w][$_\w]*$/.test(name) ? name : undefined;
    }
    default:
      return undefined;
  }
}

/** 词法父链限定名 + 最近类容器。includeSelf=true 时把节点自身也算进限定名
 * (enclosingSymbolId 用,产出的 id 与 collectSymbols 登记一致);false=只取父链。 */
function enclosingInfo(node: MorphNode, includeSelf: boolean): { parent?: string; container?: string } {
  const names: string[] = [];
  let container: string | undefined;
  let cur: MorphNode | undefined = includeSelf ? node : node.getParent();
  while (cur && cur.getKind() !== SyntaxKind.SourceFile) {
    const nm = selfDeclName(cur);
    if (nm) names.push(nm);
    if (!container && cur.getKind() === SyntaxKind.ClassDeclaration) {
      container = cur.asKind(SyntaxKind.ClassDeclaration)!.getName() ?? undefined;
    }
    cur = cur.getParent();
  }
  return {
    ...(names.length > 0 ? { parent: names.reverse().join(".") } : {}),
    ...(container ? { container } : {}),
  };
}

/** 符号收集(补全):函数声明(含嵌套)/类+方法/interface/type/enum/
 * const 箭头函数与函数表达式(变量名即符号名,含函数体内嵌套)/模块级常量。
 * 类型声明走 addVariableSymbol 同款「不进 byName」通道(不作调用解析目标;
 * 索引面 querySymbol 仍可查——C2fIndex.byName 由节点表全量构建)。
 * 模板字符串内嵌 JS 不在此列(inline-js.ts 既有独立能力,边界不混)。 */
function collectSymbols(sf: SourceFile, graph: CallGraph): void {
  sf.forEachDescendant((node) => {
    switch (node.getKind()) {
      case SyntaxKind.FunctionDeclaration: {
        const fn = node.asKind(SyntaxKind.FunctionDeclaration)!;
        const name = fn.getName() ?? "<anonymous>";
        const info = enclosingInfo(node, false);
        addSymbol(graph, {
          name,
          id: symId(sf, name, info.parent),
          kind: "function",
          ...(info.parent ? { parent: info.parent } : {}),
          ...(info.container ? { container: info.container } : {}),
          file: "", line: fn.getStartLineNumber(),
          signature: safeSignature(fn),
        }, sf);
        break;
      }
      case SyntaxKind.ClassDeclaration: {
 // 类本身也入索引(覆盖审计:70 个 export class 全部缺席,
        // code_index_symbol 查类名「未找到」——类是调用图的合法圆心)
        const cls = node.asKind(SyntaxKind.ClassDeclaration)!;
        const name = cls.getName() ?? "<anonymous-class>";
        const info = enclosingInfo(node, false);
        addSymbol(graph, {
          name,
          id: symId(sf, name, info.parent),
          kind: "class",
          ...(info.parent ? { parent: info.parent } : {}),
          ...(info.container ? { container: info.container } : {}),
          file: "", line: cls.getStartLineNumber(),
          signature: safeSignature(cls),
        }, sf);
        for (const m of cls.getMethods()) {
          const minfo = enclosingInfo(m, false);
          addSymbol(graph, {
            name: m.getName(),
            id: symId(sf, m.getName(), minfo.parent),
            kind: "method",
            ...(minfo.parent ? { parent: minfo.parent } : {}),
            ...(minfo.container ? { container: minfo.container } : {}),
            file: "", line: m.getStartLineNumber(),
            signature: safeSignature(m),
          }, sf);
        }
 // P1( §2.2):带注解的类属性补导出为 variable 符号(零边、不进 byName——
        // 变量不参与调用解析语义)。注解即声明时类型;无注解属性不猜(如实缺)。
        for (const prop of cls.getProperties()) {
          const t = annotationText(prop);
          if (!t) continue;
          const pinfo = enclosingInfo(prop, false);
          addVariableSymbol(graph, {
            name: prop.getName(),
            id: symId(sf, prop.getName(), pinfo.parent),
            kind: "variable",
            ...(pinfo.parent ? { parent: pinfo.parent } : {}),
            ...(pinfo.container ? { container: pinfo.container } : {}),
            file: "", line: prop.getStartLineNumber(),
            dataType: t,
          }, sf);
        }
        break;
      }
      case SyntaxKind.InterfaceDeclaration: {
        const inf = node.asKind(SyntaxKind.InterfaceDeclaration)!;
        const name = inf.getName();
        const info = enclosingInfo(node, false);
        addVariableSymbol(graph, {
          name,
          id: symId(sf, name, info.parent),
          kind: "interface",
          ...(info.parent ? { parent: info.parent } : {}),
          ...(info.container ? { container: info.container } : {}),
          file: "", line: inf.getStartLineNumber(),
        }, sf);
        break;
      }
      case SyntaxKind.TypeAliasDeclaration: {
        const ta = node.asKind(SyntaxKind.TypeAliasDeclaration)!;
        const name = ta.getName();
        const info = enclosingInfo(node, false);
        const aliasType = annotationText(ta);
        addVariableSymbol(graph, {
          name,
          id: symId(sf, name, info.parent),
          kind: "type",
          ...(info.parent ? { parent: info.parent } : {}),
          ...(info.container ? { container: info.container } : {}),
          file: "", line: ta.getStartLineNumber(),
          ...(aliasType ? { dataType: aliasType } : {}),
        }, sf);
        break;
      }
      case SyntaxKind.EnumDeclaration: {
        const en = node.asKind(SyntaxKind.EnumDeclaration)!;
        const name = en.getName();
        const info = enclosingInfo(node, false);
        addVariableSymbol(graph, {
          name,
          id: symId(sf, name, info.parent),
          kind: "enum",
          ...(info.parent ? { parent: info.parent } : {}),
          ...(info.container ? { container: info.container } : {}),
          file: "", line: en.getStartLineNumber(),
        }, sf);
        break;
      }
      case SyntaxKind.ArrowFunction:
      case SyntaxKind.FunctionExpression: {
        // const/let/var x = () => {} / function () {}:变量名即符号名;匿名回调不命名(不猜)
        const name = selfDeclName(node);
        if (!name) break;
        const info = enclosingInfo(node, false);
        const fn = node.asKind(node.getKind() === SyntaxKind.ArrowFunction ? SyntaxKind.ArrowFunction : SyntaxKind.FunctionExpression)!;
        addSymbol(graph, {
          name,
          id: symId(sf, name, info.parent),
          kind: "arrow",
          ...(info.parent ? { parent: info.parent } : {}),
          ...(info.container ? { container: info.container } : {}),
          file: "", line: fn.getStartLineNumber(),
          signature: safeSignature(fn),
        }, sf);
        break;
      }
      case SyntaxKind.VariableDeclaration: {
 // 模块级常量(此前只收带注解的;const 对象/数字常量等无注解声明全缺席)。
 // 函数体内局部不入索引( §2.4);箭头/函数表达式初始化由上一分支按 arrow 收。
        const decl = node.asKind(SyntaxKind.VariableDeclaration)!;
        const declList = decl.getParentIfKind(SyntaxKind.VariableDeclarationList);
        const stmt = declList?.getParentIfKind(SyntaxKind.VariableStatement);
        if (!declList || !stmt || stmt.getParent()?.getKind() !== SyntaxKind.SourceFile) break;
        const nameNode = decl.getNameNode();
        if (nameNode.getKind() !== SyntaxKind.Identifier) break; // 解构形态不猜
        const name = nameNode.getText().trim();
        if (!/^[$_\w][$_\w]*$/.test(name)) break;
        const init = decl.getInitializer();
        if (init && (init.getKind() === SyntaxKind.ArrowFunction || init.getKind() === SyntaxKind.FunctionExpression)) break;
        const t = annotationText(decl);
        const isConst = declList.getDeclarationKind() === VariableDeclarationKind.Const;
        if (!t && !isConst) break; // 无注解 let/var 不猜;const 无论是否有注解都登记(常量即符号)
        addVariableSymbol(graph, {
          name,
          id: symId(sf, name, undefined),
          kind: "variable",
          file: "", line: decl.getStartLineNumber(),
          ...(t ? { dataType: t } : {}),
        }, sf);
        break;
      }
      default:
        break;
    }
  });
}

/** 变量注解类型文本(纯语法查询,不触 typechecker):无注解=undefined(不推断,推断归 typed/ 档)。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function annotationText(decl: any): string | undefined {
  try {
    const tn = decl.getTypeNode?.();
    if (!tn) return undefined;
    const text = String(tn.getText()).replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 120) : undefined;
  } catch {
    return undefined;
  }
}

/** 变量/类型声明登记(仅供符号表/查询面):与 addSymbol 唯一差别=不进 byName
 * (声明名不得被调用解析吸收; §2.2 既有纪律, 扩到 interface/type/enum)。 */
function addVariableSymbol(graph: CallGraph, sym: Omit<Symbol, "file"> & { file: string }, sf: SourceFile): void {
  const full: Symbol = { ...sym, file: sf.getFilePath() };
  graph.symbols.set(full.id, full);
}

/** 签名提取防御式:独立加载文件的 typechecker 可能崩(escapedName undefined)——
 * 崩则降级为参数名列表(诚实:不冒充有类型)。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeSignature(fn: any): Signature | undefined {
  try {
    const params = fn.getParameters?.() ?? [];
    const parsed = params.map((p: { getName?: () => string; isOptional?: () => boolean; getType?: () => { getText(): string } }) => {
      let type: string | undefined;
      try { type = p.getType?.().getText().slice(0, 120); } catch { type = undefined; }
      return { name: p.getName?.() ?? "?", type, optional: p.isOptional?.() };
    });
    let returnType: string | undefined;
    try { returnType = fn.getReturnType?.().getText().slice(0, 120); } catch { returnType = undefined; }
    return { params: parsed, ...(returnType ? { returnType } : {}) };
  } catch {
    return undefined;
  }
}

function symId(sf: SourceFile, name: string, parent?: string): string {
  // 相对路径#父限定.名 —— root 在 addSymbol 时替换
  return `${sf.getFilePath()}#${parent ? parent + "." : ""}${name}`;
}

function addSymbol(graph: CallGraph, sym: Omit<Symbol, "file"> & { file: string }, sf: SourceFile): void {
  const file = sf.getFilePath();
  sym.id = sym.id.replace(file, file); // 保持绝对路径 id,显示时再转相对
  const full: Symbol = { ...sym, file };
  graph.symbols.set(full.id, full);
  const list = graph.byName.get(full.name) ?? [];
  list.push(full.id);
  graph.byName.set(full.name, list);
}

function collectCalls(sf: SourceFile, graph: CallGraph, root: string): void {
  const relFile = relPath(sf, root);
  const fileText = sf.getFullText();
  sf.forEachDescendant((node: MorphNode) => {
    const kind = node.getKind();
    const isCall = kind === SyntaxKind.CallExpression;
    const isNew = kind === SyntaxKind.NewExpression;
    if (!isCall && !isNew) return;
 // new Cls 也是「类符号的调用方」(qwen/dify 验证:类圆心 callers 恒 0,agent 问
    // 「谁实例化这个类」拿不到任何答案)——与 CallExpression 同一归属链
    // 统一形态:取被调表达式(Identifier / PropertyAccess)
    const expr = isNew
      ? (node.asKind(SyntaxKind.NewExpression)!.getExpression() as MorphNode)
      : (node.asKind(SyntaxKind.CallExpression)!.getExpression() as MorphNode);
    const calleeName = expr.getKind() === SyntaxKind.Identifier
      ? expr.getText()
      : expr.getKind() === SyntaxKind.PropertyAccessExpression
        ? expr.asKind(SyntaxKind.PropertyAccessExpression)!.getName()
        : undefined;
    if (!calleeName) return;
 // 模块级调用归因(实仓注意:main.ts:129 组合根调 createGatewayApp 的边整个丢失,
    // callers 只剩测试文件——匿名箭头/顶层语句没有可命名的 enclosing 符号,归到每文件一个
    // `<module>` 虚调用方(不入 symbols,查询/渲染侧按 id 特判),不冒充成某个假函数。
    const callerId = enclosingSymbolId(node) ?? `${sf.getFilePath()}#${MODULE_CALLER}`;

    // 归属启发式:
    // ① this.x(...) → 同类方法
    // ② import 的符号 → 源模块符号
    // ③ 唯一名兜底 → 同名唯一符号
    let toId: string | undefined;
    const propAccess = expr;
    if (propAccess.getKind() === SyntaxKind.PropertyAccessExpression) {
      const prop = propAccess.asKind(SyntaxKind.PropertyAccessExpression)!;
      const baseText = prop.getExpression().getText();
      const propName = prop.getName();
      if (baseText === "this") {
        const inClass = prop.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
        if (inClass) {
          const methodId = `${sf.getFilePath()}#${inClass.getName() ?? ""}.${propName}`;
          toId = graph.symbols.has(methodId) ? methodId : undefined;
        }
      }
    }
    const isPropCall = propAccess.getKind() === SyntaxKind.PropertyAccessExpression;
    const bind = bindingForm(sf, expr, calleeName, fileText);
    const callForm: FlowEdge["callForm"] = isNew
      ? "new"
      : isPropCall
        ? "prop"
        : bind === "free"
          ? "bare"
          : bind === "local"
            ? "bound"
            : bind === "import-internal"
              ? "import"
              : "external";
    if (!toId) {
      const candidates = graph.byName.get(calleeName) ?? [];
      const isProp = isPropCall;
      if (!isProp) {
        // 裸标识符调用:唯一名兜底(测试框架注入全局除外——绑定来自运行时注入,
        // 仓内同名的本地辅助函数不吸收其它文件的 test()/describe() 调用;
        // 同文件局部声明是词法可见的遮蔽绑定,保留解析)
        if (candidates.length === 1) {
          const cand = candidates[0]!;
          if (INJECTED_GLOBALS.has(calleeName)) {
            if (cand.startsWith(sf.getFilePath() + "#")) toId = cand;
          } else if (!localBindingBlocksFallback(sf, expr, calleeName, cand, bind)) {
            toId = cand;
          }
        } else if (candidates.length > 1) {
          // import 解析:当前文件 import 了哪个来源
          toId = resolveByImportEvidence(sf, calleeName, candidates) ?? undefined;
        }
      } else {
 // 属性调用:证据解析,永不唯一名兜底(fs.pathExists→fs-extra、arr.push→数组 验证)
        toId = resolvePropCall(expr, sf, calleeName, graph, newExprTypes(sf)) ?? undefined;
      }
    }

    const edge: FlowEdge = {
      from: callerId,
      to: toId ?? "",
      toName: calleeName,
      file: relFile,
      line: node.getStartLineNumber(),
      tier: "semantic",
      evidenceKind: toId ? "ast" : "inferred",
      ...(toId ? {} : { callForm }),
    };
    pushEdge(graph.outEdges, callerId, edge);
    if (toId) pushEdge(graph.inEdges, toId, edge);
  });
}

/** 唯一名兜底的作用域闸(整仓 flow 注意):裸标识符在**本文件有局部绑定**时,
 * 词法作用域已经决定了它的指向——不能再按「全仓唯一同名」吸走别处的符号。三类依据:
 * ① 外部 import:`import { join } from "node:path"; join(...)` 被连到仓内唯一的
 * `.spec.cjs#join`(测试文件里的小工具)——整仓 400+ 条假边,模块级图出现
 *    `packages/code-sense → apps/gateway ×851` 的假主干;
 * ② 参数/局部变量:`handler(payload)`(EventBus 的 for-of 参数)被连到
 *    `titlebar-preload.js#handler`;`dirOf(...)`(collectLocalTypes 的回调参数)被连到
 *    `ExperienceStore.dirOf`;
 * ③ CJS 解构 `const { join } = require("node:path")` 同理(绑定节点在当前文件)。
 * 判定:ident.getSymbol() 的声明在本文件 → 只允许连到「同文件声明」或「该 import 的来源文件
 * 里的符号」;两者都不成立=阻断。自由标识符(无局部绑定,如全局函数)保持原兜底语义。
 * 同文件箭头函数/普通函数声明照常放行(绑定与候选同文件);import 到同仓模块也放行
 * (来源文件前缀匹配),不改变真边召回。 */
type BindingForm = "free" | "local" | "import-internal" | "import-external";

/** 未解析调用的绑定形态(relink/唯一名兜底的作用域闸数据源):
 * free=自由标识符;local=参数/局部变量/同文件声明;import-internal=相对路径/工作区域名 import;
 * import-external=node:path/fs 等外部包。 全量索引依据:
 * ① x.trim() 是属性调用(prop),与绑定无关;② handler/dirOf 是参数(local);
 * ③ join@node:path 是 external;④ @lampgenie/* 工作区 import 即使 ts-morph 解析不到源文件,
 * 也按 internal 放行 relink(否则真实跨包边全丢,经验证模块图 65→11 边)。 */
function bindingForm(sf: SourceFile, expr: MorphNode, calleeName: string, fileText?: string): BindingForm {
  let local = false;
  try {
    local = (expr.getSymbol()?.getDeclarations() ?? []).some((d) => d.getSourceFile().getFilePath() === sf.getFilePath());
  } catch {
    local = false;
  }
 // CJS/.js 不在 tsconfig 时 getSymbol 可能为空(依据:apps/desktop/paths.js 的
  // `const { join } = require("node:path")` 被当自由标识符,连到测试文件里的 join ×85)。
  // 文本级兜底只做「有绑定/无绑定」判定,不解析复杂作用域;ts-morph 无本地符号时以它为准
  // (同一表达式两次 getSymbol() 结果可能漂移,不能让 callForm 与解析闸读到不同结论)。
  if (!local) {
    let cache = textualFormCache.get(sf);
    if (!cache) { cache = new Map(); textualFormCache.set(sf, cache); }
    const hit = cache.get(calleeName);
    if (hit) return hit;
    const form = textualBindingForm(fileText ?? sf.getFullText(), calleeName);
    cache.set(calleeName, form);
    return form;
  }
  try {
    for (const imp of sf.getImportDeclarations()) {
      const bound = [
        imp.getDefaultImport()?.getText(),
        imp.getNamespaceImport()?.getText(),
        ...imp.getNamedImports().map((n) => n.getName()),
      ];
      if (!bound.includes(calleeName)) continue;
      if (imp.getModuleSpecifierSourceFile()) return "import-internal";
      const spec = imp.getModuleSpecifierValue();
      if (spec.startsWith(".") || spec.startsWith("@lampgenie/") || spec.startsWith("@/") || spec.startsWith("~/")) {
        return "import-internal"; // 工作区别名/相对路径:源文件未解析也按仓内处理(relink 兜底)
      }
      return "import-external";
    }
  } catch {
    return "local"; // import 枚举失败:保守按本地绑定(不跨文件兜底)
  }
  return "local";
}

/** 文本级绑定形态缓存:同一文件内同名调用共享一次判定(collectCalls 每文件上万次调用,
 * 每次 getFullText()+6 个正则会把索引构建拖慢)。 */
const textualFormCache = new WeakMap<SourceFile, Map<string, BindingForm>>();

/** 文本级绑定形态兜底(ts-morph 无符号时):require 解构/直接 require/ESM import/本地声明。
 * 外部包(node:path/fs)返回 external,工作区/相对路径返回 import-internal;都交给调用方闸门。 */
function textualBindingForm(text: string, name: string): BindingForm {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const specForm = (spec: string): BindingForm =>
    spec.startsWith(".") || spec.startsWith("@lampgenie/") || spec.startsWith("@/") || spec.startsWith("~/")
      ? "import-internal"
      : "import-external";
  let m = new RegExp(`(?:const|let|var)\\s+\\{[^}]*\\b${esc}\\b[^}]*\\}\\s*=\\s*require\\(\\s*["']([^"']+)["']\\s*\\)`).exec(text);
  if (m) return specForm(m[1]!);
  m = new RegExp(`(?:const|let|var)\\s+${esc}\\s*=\\s*require\\(\\s*["']([^"']+)["']\\s*\\)`).exec(text);
  if (m) return specForm(m[1]!);
  m = new RegExp(`import\\s+[^;]*\\b${esc}\\b[^;]*from\\s*["']([^"']+)["']`).exec(text);
  if (m) return specForm(m[1]!);
  if (new RegExp(`(?:const|let|var|function|class)\\s+${esc}\\b`).test(text)) return "local";
  return "free";
}

function localBindingBlocksFallback(sf: SourceFile, expr: MorphNode, calleeName: string, candidateId: string, bind: BindingForm): boolean {
  const sfPath = sf.getFilePath();
  if (bind === "free") return false; // 自由标识符
  if (candidateId.startsWith(sfPath + "#")) return false; // 同文件声明(函数/箭头/递归)
  try {
    for (const imp of sf.getImportDeclarations()) {
      const bound = [
        imp.getDefaultImport()?.getText(),
        imp.getNamespaceImport()?.getText(),
        ...imp.getNamedImports().map((n) => n.getName()),
      ];
      if (!bound.includes(calleeName)) continue;
      const src = imp.getModuleSpecifierSourceFile();
      if (src && candidateId.startsWith(src.getFilePath() + "#")) return false; // import 的真来源
    }
  } catch { /* import 枚举失败:保守阻断(宁可少一条边,不造跨模块假主干) */ }
  return true;
}

/** 模块级(顶层语句/匿名回调内)调用的虚调用方 id:`<file>#<module>`(MODULE_CALLER 为 # 后缀)。
 * 不入 graph.symbols:消费面(c2f 节点表/档案钻取 byFile)按节点表驱动,天然不见;
 * 查询面(querySymbol callers)与渲染面(renderNeighborhood)对 `#<module>` 结尾 id 特判成
 * 「模块级调用」伪节点。 */
export const MODULE_CALLER = "<module>";

/** 属性调用(obj.x())的证据解析白名单形态:只认 this/命名 import/命名空间 import/new 接收者,
 * **永不走唯一名兜底**。验证(teamai-cli):`fs.pathExists` 是 fs-extra 的方法,仓内恰好只有一个
 * 同名函数时被吸走——虚报文件 114/189;denylist 词表是猫鼠游戏(fs-extra/set/map/任意库方法),
 * 证据闸才是收敛解。代价=无类型证据的普通对象属性调用不解析(丢真边可接受,零虚报优先)。
 * 裸标识符调用的唯一名兜底保留,但测试框架注入全局除外(describe/it/test 等的绑定来自运行时
 * 注入,仓内同名的本地辅助函数会被吸走——opencode test-debug.ts 经验证 502 个假 caller)。 */
export const INJECTED_GLOBALS = new Set([
  "describe", "it", "test", "expect", "vi", "suite", "check",
  "beforeEach", "afterEach", "beforeAll", "afterAll", "setup", "teardown",
]);

/** 结构 adapter 跨文件解析(经验证:python 同文件调用召回尚可,跨文件 0/11——
 * 各 adapter 只在单文件 byName 里找,import 收集了没消费)。解析对象=adapter 发射的跨文件候选
 * (to===""+toName,可丢弃:解析不了=移除,与旧版「不发射」等价)**加**未解析的自归属边
 * (self.x 兄弟查找失败=容器归属盲区,不可丢弃:解析不了保持原状,不改变既有语义)。
 * 两者都按「同语言+全图唯一名」解析。
 * A1:方法名几乎必然跨类同名(全图唯一名闸对方法调用系统性弃边,三仓评测
 * R=0/20 注意)——候选带 receiverType 时先按 container=receiverType 过滤(Class.method
 * 候选集),再按 moduleHint(文件路径子串)二次收窄;仍非唯一=保持不解析(宁缺勿错)。
 * RC-B5:被移除的候选进 graph.droppedCandidates 台账(按被调名聚合,
 * 原因三桶)——「诚实弃边」从不可见变为索引可查。 */
function resolveStructCrossFile(graph: CallGraph, candidates: FlowEdge[], selfMisses: FlowEdge[]): void {
  const extOf = (file: string) => file.slice(file.lastIndexOf("."));
 // Go 接口类型名册(typeKind=interface,仅 Go adapter 注册),按名→所在包目录集。
  // receiverType 名为接口时,候选实现体方法必属「仓内接口 X 与实现体 Y 撞名」(Go 语法:接口不能
  // 有方法接收者,container=R 的方法存在 ⟹ 另有非接口类型 R):接口值调用的真实动态类型不可静态
 // 判定(094 假边注意:child balancer.Balancer(接口)→ gracefulswitch.Balancer.UpdateClientConnState),
  // 不再窄化「唯一命中」,如实弃边+进弃边台账。但同名接口在**别的包**时证据钉扎(receiverTypeDir)
  // 指向结构体包=证据非接口,放行(无钉扎则误杀同包结构体真边:grpc-go internal/transport.Stream
 // vs 根包接口 grpc.Stream 经验证 58 条)。其它语言/旧索引符号无 typeKind=interface →名册天然为空
  // →逐位旧行为(零回退面)。
  const goIfaceDirs = new Map<string, Set<string>>();
  for (const s of graph.symbols.values()) {
    if (s.kind === "class" && s.typeKind === "interface") {
      const dir = s.file.includes("/") ? s.file.slice(0, s.file.lastIndexOf("/")) : "";
      const set = goIfaceDirs.get(s.name) ?? new Set<string>();
      set.add(dir);
      goIfaceDirs.set(s.name, set);
    }
  }
 /** C/C++ 语言族(C 函数调用点在 .c、声明锚在 .h——同扩展名闸会把这一形态整体弃边;
 * saadk_c mwInit 依据:调用在 memwatch.c、唯一索引锚是 memwatch.h 原型,定义体被语法 ERROR 丢弃)。
   * 仅作兜底:同扩展名候选在场时优先(定义优先语义不变),族内唯一才解析。清单与 adapters/cpp.ts CPP_EXTS 同口径。 */
  const C_FAMILY_EXTS = new Set([".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"]);
 /** P1(缺口①):libc/C 内建常用名(跨文件解析时几乎总是被 vendored 头的
   * 同名声明吸收成假边)。同文件定义不经此路径(resolveLocal 先连);仓内有真产品定义
   * 时名单不生效(见 tryResolve 的 productDef 守卫)。 */
  const C_LIBC_NAMES = new Set([
    "free", "malloc", "calloc", "realloc", "aligned_alloc", "posix_memalign",
    "round", "roundf", "roundl", "lround", "llround", "nearbyint", "rint",
    "sqrt", "sqrtf", "sqrtl", "pow", "powf", "powl", "exp", "expf", "expl",
    "log", "logf", "log2", "log10", "log1p", "fabs", "fabsf", "cbrt", "hypot",
    "floor", "floorf", "ceil", "ceilf", "fmod", "modf", "trunc",
    "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sinh", "cosh", "tanh",
    "abs", "labs", "llabs", "fmin", "fmax", "fclamp", "min", "max", "clamp",
    "memcpy", "memmove", "memset", "memcmp", "memchr",
    "strcpy", "strncpy", "strcat", "strncat", "strlen", "strcmp", "strncmp",
    "strchr", "strrchr", "strstr", "strdup", "strtok", "strtol", "strtoul", "strtod",
    "snprintf", "sprintf", "vsprintf", "vsnprintf", "printf", "fprintf", "vprintf", "vfprintf",
    "puts", "putchar", "fputs", "fgets", "gets", "getchar", "fputc",
    "atoi", "atol", "atof", "sscanf", "scanf",
    "exit", "abort", "atexit", "assert",
    "qsort", "bsearch", "rand", "srand",
    "fopen", "fclose", "fread", "fwrite", "fseek", "ftell", "rewind", "fflush", "remove", "rename",
    "sleep", "usleep", "nanosleep", "getpid", "gettimeofday", "clock", "time",
  ]);
  const narrow = (pool: string[], e: FlowEdge): string[] => {
    let out = pool;
    if (e.receiverType) out = out.filter((id) => graph.symbols.get(id)!.container === e.receiverType);
    if (out.length > 1 && e.moduleHint) {
      out = out.filter((id) => graph.symbols.get(id)!.file.replace(/\\/g, "/").includes(e.moduleHint!));
    }
    return out;
  };
  /** 解析候选:命中=回填 e.to+inEdges 并返回 null;未命中=返回弃边原因(进台账)。 */
  const tryResolve = (e: FlowEdge): string | null => {
    if (e.to || !e.toName) return null;
    const byName = (graph.byName.get(e.toName) ?? []).filter((id) => graph.symbols.has(id));
 // P1(缺口①):libc/内建常用名的跨文件唯一名解析几乎总是假目标——仓内同名
 // 只是 vendored 头的声明(经验证 saadk_6920 的 round/free 被 flann/matrix.h 吸收,71 条
    // 产品→thirdparty 假边)。真实目标是 libc,连过去=受影响文件清单掺入厂商头。仅当仓内
    // 没有「非原型且非 vendored」的产品定义时拒连(自家真定义照常解析);弃边进台账可追溯。
    if (C_LIBC_NAMES.has(e.toName) && C_FAMILY_EXTS.has(extOf(e.file))) {
      const productDef = byName.some((id) => {
        const s = graph.symbols.get(id)!;
        return s.proto !== true && !isVendoredPath(s.file);
      });
      if (!productDef) return `libc/内建函数(${e.toName})——外部依赖,仓内同名仅为头文件声明,不连边`;
    }
    let pool = byName.filter((id) => extOf(graph.symbols.get(id)!.file) === extOf(e.file));
    pool = narrow(pool, e);
    if (pool.length === 0 && C_FAMILY_EXTS.has(extOf(e.file))) {
      pool = narrow(byName.filter((id) => C_FAMILY_EXTS.has(extOf(graph.symbols.get(id)!.file))), e);
    }
 // P0:C/C++ 定义优先——原型(.h 声明)不该与定义(.c)平票把调用整条弃掉。
 // 依据:yolox/test/*.cpp 调 SA_YOLOX_Init,候选=.c 定义 + .h 原型 → 旧逻辑弃边,
    // 关联测试恒 0。池内存在非原型时先剔原型;两处都是定义(构建开关二选一)仍如实弃边。
    if (pool.length > 1) {
      const defs = pool.filter((id) => graph.symbols.get(id)?.proto !== true);
      if (defs.length > 0) pool = defs;
    }
 // 撞名闸:唯一候选在场且 receiverType 有接口名册命中时——证据目录指向接口所在包
    // (或无钉扎,保守)=该候选只能是撞名实现体的方法,不可消歧,弃边(台账);证据目录指向别包
    // =证据是结构体(接口在别包重名),放行。精度与「宁缺勿错」优先于这条召回。
    if (pool.length === 1 && e.receiverType) {
      const dirs = goIfaceDirs.get(e.receiverType);
      if (dirs && (e.receiverTypeDir === undefined || dirs.has(e.receiverTypeDir))) {
        return `接口与实现体撞名: receiverType=${e.receiverType} 是仓内接口(包目录 ${[...dirs].join("|") || "."}),候选为实现体方法,不可消歧(宁缺勿错)`;
      }
    }
    if (pool.length !== 1) {
      if (byName.length === 0) return "全图无同名符号(外部依赖/动态形态)";
      if (pool.length > 1) {
        const defs = pool.filter((id) => graph.symbols.get(id)?.proto !== true);
        if (defs.length > 1) return `同名候选非唯一(${defs.length} 处定义——可能由构建开关/条件编译选择,静态不可判定)`;
        return `同名候选非唯一(收窄后仍有 ${pool.length} 处待选)`;
      }
      return "同名存在但类型/模块证据不匹配";
    }
    const target = graph.symbols.get(pool[0]!);
    if (!target) return "全图无同名符号(外部依赖/动态形态)";
    e.to = target.id;
    e.evidenceKind = "index";
    pushEdge(graph.inEdges, e.to, e);
    return null;
  };
  const ledger = new Map<string, DroppedCandidateEntry>();
  const recordDrop = (e: FlowEdge, reason: string): void => {
    const name = e.toName ?? "?";
    const cur = ledger.get(name) ?? { count: 0, reasons: {}, samples: [] };
    cur.count++;
    cur.reasons[reason] = (cur.reasons[reason] ?? 0) + 1;
    if (cur.samples.length < 3 && !cur.samples.some((s) => s.file === e.file && s.line === e.line)) {
      cur.samples.push({ file: e.file, line: e.line });
    }
    ledger.set(name, cur);
  };
  for (const e of candidates) {
    const reason = tryResolve(e);
    if (reason) recordDrop(e, reason);
  }
  // selfMisses 解析失败不丢边(to="" 留在索引,查询面可计数)——不进弃边台账
  for (const e of selfMisses) tryResolve(e);
  if (ledger.size > 0) graph.droppedCandidates = ledger;
  const drop = candidates.filter((e) => !e.to);
  if (drop.length === 0) return;
  const dropSet = new Set(drop);
  for (const [key, list] of graph.outEdges) {
    const filtered = list.filter((x) => !dropSet.has(x));
    if (filtered.length !== list.length) graph.outEdges.set(key, filtered);
  }
}

function pushEdge(m: Map<string, FlowEdge[]>, key: string, e: FlowEdge): void {
  const list = m.get(key) ?? [];
  list.push(e);
  m.set(key, list);
}

function enclosingSymbolId(node: MorphNode): string | undefined {
  const sf = node.getSourceFile();
  let cur: MorphNode | undefined = node.getParent();
  while (cur) {
    const k = cur.getKind();
    // 与 collectSymbols 的登记口径同源:方法/函数声明/变量赋值的箭头与函数表达式。
    // 匿名回调不命名→继续上溯(既有语义:回调内调用归最近具名函数,无则归 <module>)。
    if (k === SyntaxKind.MethodDeclaration || k === SyntaxKind.FunctionDeclaration
      || k === SyntaxKind.ArrowFunction || k === SyntaxKind.FunctionExpression) {
      const name = selfDeclName(cur);
      if (name) {
        const info = enclosingInfo(cur, true);
        if (info.parent) return `${sf.getFilePath()}#${info.parent}`;
      }
    }
    cur = cur.getParent();
  }
  return undefined;
}

/** 同文件 new 表达式接收者类型表:`const repo = new TaskStore()` → repo→[TaskStore]。
 * 属性调用(obj.method)的内建成员黑名单把真调用也拦下(TaskStore.values 经验证)——
 * 接收者是本文件 new 出来的实例时,`new` 证据足以安全解析到 `Class.method`(同文件闸,精度高:
 * 数组/Map/标准库接收者不是 new 出来的标识符,天然不受影响)。懒构建每文件一次。 */
const newTypeCache = new Map<SourceFile, Map<string, string[]>>();
function newExprTypes(sf: SourceFile): Map<string, string[]> {
  let m = newTypeCache.get(sf);
  if (m) return m;
  if (newTypeCache.size > 256) newTypeCache.clear(); // 常驻进程防护:懒解析路径每查询新文件集
  // name → "cls|enclosingSymbolId"(函数作用域闸:同文件不同函数的同名变量互不泄漏,
  // paramCaller 的参数 r 不得吃到 newCaller 里 const r = new Repo() 的证据)
  m = new Map<string, string[]>();
  try {
 // getVariableDeclarations 只返回语句级声明(函数体内的 const 拿不到,经验证 0)——
    // 必须 descendants:useStore 里的 `const s = new Store()` 是本修复的主场景
    for (const decl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const init = decl.getInitializer();
      if (!init || init.getKind() !== SyntaxKind.NewExpression) continue;
      const cls = init.asKind(SyntaxKind.NewExpression)!.getExpression().getText().trim();
      if (!/^[$_\w]+$/.test(cls)) continue;
      const name = decl.getNameNode().getText().trim();
      if (!name) continue;
      const scope = enclosingSymbolId(decl) ?? "";
      const entry = `${cls}|${scope}`;
      const list = m.get(name) ?? [];
      if (!list.includes(entry)) list.push(entry);
      m.set(name, list);
    }
  } catch { /* 声明枚举失败=无 new 证据,保守不解析 */ }
  newTypeCache.set(sf, m);
  return m;
}

/** 命名 import 证据:calleeName 在本文件 named import 名单里 → 只认来源模块中的同名符号。 */
function resolveByImportEvidence(sf: SourceFile, calleeName: string, candidates: string[]): string | null {
  for (const imp of sf.getImportDeclarations()) {
    const named = imp.getNamedImports().find((n) => n.getName() === calleeName);
    if (!named) continue;
    const src = imp.getModuleSpecifierSourceFile();
    if (src) {
      const match = candidates.find((c) => c.startsWith(src.getFilePath() + "#"));
      if (match) return match;
    }
  }
  return null;
}

/** 属性调用证据解析(this 已在上游处理):命名空间/默认 import、new 接收者、同文件类静态调用。
 * 任何证据都不成立=不解析(外来对象方法:fs.pathExists/arr.push/cache.set 验证,虚报源头)。
 * 返回 null=无证据。 */
function resolvePropCall(
  expr: MorphNode, sf: SourceFile, propName: string,
  graph: CallGraph, newTypes: Map<string, string[]>,
): string | null {
  let baseText: string;
  try {
    baseText = expr.getText().replace(/\s*\.\s*[\w$]+\s*$/, "").trim();
  } catch {
    return null;
  }
  if (!/^[$_\w]+(\.[$_\w]+)*$/.test(baseText)) return null; // 复杂表达式接收者:无证据
  const base0 = baseText.split(".")[0]!;
  // ① 命名空间/默认 import:绑定名=接收者 → 只认来源模块内符号;模块解析不了/无此符号=外来对象,压制
  try {
    for (const imp of sf.getImportDeclarations()) {
      const ns = imp.getNamespaceImport()?.getText() ?? imp.getDefaultImport()?.getText();
      if (ns !== base0) continue;
      const src = imp.getModuleSpecifierSourceFile();
      if (!src) return null; // 外部模块(fs-extra 等):来源不可达=无此符号证据,不兜底
      const cands = graph.byName.get(propName) ?? [];
      const hit = cands.find((c) => c.startsWith(src.getFilePath() + "#"));
      return hit ?? null;
    }
  } catch { /* import 枚举失败:继续其它证据 */ }
  // ② new 表达式接收者:const r = new Cls() → r.method → Cls.method。同文件 + **同函数作用域**闸
  const callScope = enclosingSymbolId(expr) ?? "";
  const entries = newTypes.get(base0);
  if (entries) {
    for (const entry of entries) {
      const sep = entry.lastIndexOf("|");
      const cls = entry.slice(0, sep);
      const scope = entry.slice(sep + 1);
      if (scope !== callScope) continue;
      const id = `${sf.getFilePath()}#${cls}.${propName}`;
      if (graph.symbols.has(id)) return id;
    }
  }
  // ③ 同文件类静态调用:Config.load() → Config 为本文件类名(类节点在 symbols)
  const staticId = `${sf.getFilePath()}#${baseText}.${propName}`;
  if (graph.symbols.has(staticId)) return staticId;
  return null;
}

/** target 子图:中心符号上下游 N 跳( §6.1)。 */
export function subgraph(
  graph: CallGraph,
  centerPredicate: (s: Symbol) => boolean,
  depth: number,
  root: string): { center?: Symbol; upstream: FlowEdge[]; downstream: FlowEdge[] } {
  const center = [...graph.symbols.values()].find(centerPredicate);
  if (!center) return { upstream: [], downstream: [] };

  const downstream: FlowEdge[] = [];
  const downSeen = new Set([center.id]);
  let frontier = [center.id];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of graph.outEdges.get(id) ?? []) {
        downstream.push(toRelative(e, root));
        if (e.to && !downSeen.has(e.to)) { downSeen.add(e.to); next.push(e.to); }
      }
    }
    frontier = next;
  }

  const upstream: FlowEdge[] = [];
  const upSeen = new Set([center.id]);
  frontier = [center.id];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of graph.inEdges.get(id) ?? []) {
        upstream.push(toRelative(e, root));
        if (!upSeen.has(e.from)) { upSeen.add(e.from); next.push(e.from); }
      }
    }
    frontier = next;
  }

  // id 与边同口径转相对(此前 center.id 留绝对路径而边已转相对——下游消费(关系图节点合并/
  // 面板下钻对照)会把同一符号当两个节点)
  return {
    center: { ...center, file: center.file.replace(root + "/", ""), id: center.id.replace(root + "/", "") },
    upstream,
    downstream,
  };
}

function toRelative(e: FlowEdge, root: string): FlowEdge {
  return { ...e, from: e.from.replace(root + "/", ""), to: e.to.replace(root + "/", "") };
}

/** 结构 adapter 单文件解析结果(python/go/java/cpp/rust/csharp/ruby/php 共用契约)。
 * crossFileCandidates:本文件内解析不到、但名字在 import 名单里的裸调用候选边
 * (to===""+toName)——由 mergeStructAdapters 在全图合并后统一解析(python 专用,go/java 可不产)。
 * imports( RC-B2):本文件原始 import 路径清单(Go 产;python/java 待后续轮)。 */
type StructParseResult = { symbols: (Symbol & { signature?: Signature })[]; edges: FlowEdge[]; failures: unknown[]; crossFileCandidates?: FlowEdge[]; imports?: string[] };

/** 结构 adapter 按需加载器(懒 import:bundle 形态内联,dev 形态动态加载)。 */
const cppAdapter = async (): Promise<{ parse: (root: string, f: string) => Promise<StructParseResult> }> => ({
  parse: (await import("../adapters/cpp")).parseCppFile,
});
const STRUCT_ADAPTERS: { ext: string; load: () => Promise<{ parse: (root: string, f: string) => Promise<StructParseResult> }> }[] = [
  { ext: ".py", load: async () => ({ parse: (await import("../adapters/python")).parsePythonFile }) },
  { ext: ".go", load: async () => ({ parse: (await import("../adapters/go")).parseGoFile }) },
  { ext: ".java", load: async () => ({ parse: (await import("../adapters/java")).parseJavaFile }) },
 // C/C++(tree-sitter-c/cpp;提取子集与错误容忍策略见 adapters/cpp.ts 头注)
  { ext: ".c", load: cppAdapter },
  { ext: ".h", load: cppAdapter },
  { ext: ".cc", load: cppAdapter },
  { ext: ".cpp", load: cppAdapter },
  { ext: ".cxx", load: cppAdapter },
  { ext: ".hh", load: cppAdapter },
  { ext: ".hpp", load: cppAdapter },
  { ext: ".hxx", load: cppAdapter },
 // Rust/C#/Ruby/PHP(tree-sitter wasm 主路径 + 文本回退;接口与 java/go 同形)
  { ext: ".rs", load: async () => ({ parse: (await import("../adapters/rust")).parseRustFile }) },
  { ext: ".cs", load: async () => ({ parse: (await import("../adapters/csharp")).parseCsharpFile }) },
  { ext: ".rb", load: async () => ({ parse: (await import("../adapters/ruby")).parseRubyFile }) },
  { ext: ".php", load: async () => ({ parse: (await import("../adapters/php")).parsePhpFile }) },
];

/** 结构 adapter 汇入:解析 relFiles 中对应扩展名的文件,符号与边合并进图(全图索引与懒解析共用)。
 * 单文件解析失败=该文件进盲区跳过(诚实,不冒充全量);adapter 加载失败=该语言退回未接入形态。
 * 合并完成后跑 resolveStructCrossFile:候选跨文件边按全图唯一名解析。
 * ①逐文件 outcome 聚合进 graph.structOutcomes(分层覆盖数据源);②lexical 档符号
 * 只进 graph.symbols(覆盖计数/查询),**不进 byName**——防跨文件候选解析吸收词法符号产假边
 * (lexical 的边不参与 callers/callees 精度口径);③RSS 护栏:超 GENIE_SENSE_MAX_RSS_MB 停止
 * 处理剩余文件,余下 outcome=skipped + graph.structTruncated 登记。 */
export async function mergeStructAdapters(graph: CallGraph, root: string, relFiles: string[]): Promise<void> {
  const crossFileCandidates: FlowEdge[] = [];
  const selfMisses: FlowEdge[] = [];
  const outcomes = new Map<string, { tier: "full" | "lexical" | "empty" | "skipped"; reason?: string; errors?: boolean }>();
  graph.structOutcomes = outcomes;
  const rssLimit = maxRssBytes();
  let guardTripped = false;
  for (const t of STRUCT_ADAPTERS) {
    if (guardTripped) break;
    const structFiles = relFiles.filter((f) => f.endsWith(t.ext));
    if (structFiles.length === 0) continue;
    let adapter: { parse: (root: string, f: string) => Promise<StructParseResult> };
    try {
      adapter = await t.load();
    } catch {
      continue; // adapter 加载失败:该语言退回词法档语义(与未接入一致)
    }
    for (const f of structFiles) {
      if (guardTripped) break;
      if (process.memoryUsage().rss > rssLimit) {
        guardTripped = true;
        graph.structTruncated = { reason: `RSS 护栏触发(>${Math.round(rssLimit / 1024 / 1024)}MB),剩余结构档文件停止处理(可用 GENIE_SENSE_MAX_RSS_MB 调节)` };
        break;
      }
 // RC-K:解析前守卫(压缩产物/超大单文件)——结构档同样设防(超大 .h/.cpp 是
 // 076 病态成本验证面);跳过如实登记 outcome=skipped
      const guard = await parseGuardReason(join(root, f));
      if (guard) {
        outcomes.set(f, { tier: "skipped", reason: guard });
        continue;
      }
      try {
        const r = await adapter.parse(root, f);
 // RC-B2:结构档逐文件 import 清单聚合(绝对路径键;展开归 expandGoImports)
        if (r.imports && r.imports.length > 0) {
          if (!graph.structFileImports) graph.structFileImports = new Map();
          graph.structFileImports.set(join(root, f), r.imports);
        }
        const hasOutcome = (r as { outcome?: { tier: "full" | "lexical" | "empty" | "skipped"; reason?: string; errors?: boolean } }).outcome;
        outcomes.set(f, hasOutcome ?? (r.symbols.length > 0
          ? { tier: "full" as const }
          : r.failures.length > 0
            ? { tier: "skipped" as const, reason: String((r.failures[0] as { reason?: unknown } | undefined)?.reason ?? r.failures[0]) }
            : { tier: "empty" as const, reason: "解析成功但无顶层声明" }));
        for (const sym of r.symbols) {
          graph.symbols.set(sym.id, sym);
 // P1:variable 一律不进 byName(structural 档推广 lexical 既有纪律)——
          // 防跨文件候选解析按名吸收变量符号产假边(调用解析语义只对函数成立)。
 // typedef/interface/type/enum 同列声明豁免(isNonCallableSymbolKind)。
          if (sym.tier === "lexical" || isNonCallableSymbolKind(sym.kind)) continue;
          const ids = graph.byName.get(sym.name) ?? [];
          ids.push(sym.id);
          graph.byName.set(sym.name, ids);
        }
        for (const e of r.edges) {
          const out = graph.outEdges.get(e.from) ?? [];
          out.push(e);
          graph.outEdges.set(e.from, out);
          if (e.to) {
            const inc = graph.inEdges.get(e.to) ?? [];
            inc.push(e);
            graph.inEdges.set(e.to, inc);
          } else if (e.tier === "structural") {
            selfMisses.push(e); // self.x 兄弟查找失败:容器归属盲区,合并后给一次全图唯一名机会
          }
        }
        if (r.crossFileCandidates) {
          for (const c of r.crossFileCandidates) {
            // 候选边先进 outEdges(caller 侧成立),inEdges 待解析命中再推——
            // resolveStructCrossFile 解析=e.to 回填+inEdges;丢弃=从 outEdges 移除
            const out = graph.outEdges.get(c.from) ?? [];
            out.push(c);
            graph.outEdges.set(c.from, out);
            crossFileCandidates.push(c);
          }
        }
      } catch {
 // 该文件解析盲区:跳过。 RC-K:此前静默——现在如实登记 outcome=skipped
        // (失败不毙全仓 + 覆盖面可见)
        outcomes.set(f, { tier: "skipped", reason: "解析异常跳过(单文件包保护)" });
      }
    }
  }
  // RSS 护栏触发:未处理的文件如实登记 skipped(分母内、分子外,不冒充覆盖)
  if (guardTripped) {
    const processed = new Set(outcomes.keys());
    for (const t of STRUCT_ADAPTERS) {
      for (const f of relFiles.filter((x) => x.endsWith(t.ext))) {
        if (!processed.has(f)) outcomes.set(f, { tier: "skipped", reason: graph.structTruncated?.reason ?? "内存护栏" });
      }
    }
  }
  // 全部文件合并后解析:此时 byName 才是全图视野(单文件解析时跨文件目标尚不存在)
  resolveStructCrossFile(graph, crossFileCandidates, selfMisses);
}

/** 懒解析( §7.2 A2):只解析指定文件集(定位→小图),大仓 debug 秒级。 */
export async function buildCallGraphFromFiles(root: string, relFiles: string[]): Promise<CallGraph> {
  const t0 = Date.now();
  // 结构语言走各自 adapter(mergeStructAdapters);ts/js 才进 ts-morph。
  // 非 TS/JS 源文件(md/图片名等)剔除:grep 命中会把 md 带进 focus,ts-morph 把 markdown
  // 当 TS 解析单文件秒级开销(审计 R2 修复:ZC-14 文档提及路径 3.3s 的真凶)
  const tsFiles = relFiles.filter((f) => GRAPH_TS_EXT.has(f.slice(f.lastIndexOf("."))));
  const project = new Project({ skipAddingFilesFromTsConfig: true });
  const guardSkipsLocal: { rel: string; reason: string }[] = [];
  const unparsable: string[] = [];
  for (const f of tsFiles) {
 // RC-K:懒解析路径同过守卫(增量重扫的变更文件里也可能混进压缩产物)
    const guard = await parseGuardReason(join(root, f));
    if (guard) { guardSkipsLocal.push({ rel: f, reason: guard }); continue; }
    try { project.addSourceFileAtPath(`${root}/${f}`); } catch { unparsable.push(f); }
  }
  const graph: CallGraph = {
    symbols: new Map(), outEdges: new Map(), inEdges: new Map(), byName: new Map(), buildMs: 0,
    scannedFiles: [...relFiles],
    ...(guardSkipsLocal.length > 0 ? { guardSkips: new Map(guardSkipsLocal.map((g) => [g.rel, g.reason])) } : {}),
    ...(unparsable.length > 0 ? { unparsableFiles: unparsable } : {}),
  };
  const files = project.getSourceFiles();
  for (const sf of files) collectSymbols(sf, graph);
  for (const sf of files) collectCalls(sf, graph, root);
  await mergeStructAdapters(graph, root, relFiles);
  // senseB21: 懒解析路径同接内嵌脚本索引(debug 剖面对 panel.ts 内嵌函数可查的主通路;
  // .js 后缀=dist ESM 直连消费可解析)
  {
    const { collectInlineJs } = await import("./inline-js.js");
    for (const sf of files) {
      try {
        await collectInlineJs(sf, graph, root);
      } catch { /* 单文件失败:静默降级 */ }
    }
  }
  graph.buildMs = Date.now() - t0;
  return graph;
}
