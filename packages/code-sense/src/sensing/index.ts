/**
 * sensing/index( /):业务逻辑感知编排面。
 * queryApiSurface:确定性提取(http-api)→ OpenAPI 对账(openapi)→ handler→索引挂载与
 * impact 影响面(只读消费 c2f 产物,索引缺席=显式降级)→ 语义层(注入式,opt-in)。
 * 进程内 TTL 缓存(root+srcFingerprint 键);不落盘(与 c2f 索引格式零耦合)。
 */
import { isAbsolute, join, relative } from "node:path";
import { readFile } from "node:fs/promises";
import { grepFilesIn } from "../search";
import { srcFingerprintCached } from "../callgraph/c2f";
import { isTestPath } from "../path-filter";
// 非产品路径过滤(共享口径,path-filter.ts 单一真相):docs/examples/tutorial/
// mocks/testdata/fixtures/bench 等段与 .md/.rst/.txt 文档不是「这个项目提供的代码能力」。
// 经验证:py-fastapi 的 docs_src/** 占 api 474 端点的大多数、mmdetection 的 docs/ 被当算法文件、
// ts-xstate 的 migration.md 被算成 3 个状态机。过滤发生在 sensingKeepFile 之后(叠加而非替代),
// 且必须诚实呈报(filtered>0 就带 note,过滤后清空也不假装无数据)。
import {
  filterNonProductPaths,
  nonProductFilterNote,
  type PathFilterResult,
} from "../path-filter";

/** sensing 候选文件目录排除(与 project.ts SKIP_DIRS 同纪律:vendor/ref/dist 不是业务代码)。 */
const SENSING_SKIP_RE = /(^|\/)(node_modules|vendor|dist|build|\.venv|__pycache__|ref|coverage)\//;
export function sensingKeepFile(rel: string): boolean {
 // 测试文件不入 sensing(c2f 同纪律;注意:本仓 sensing-api.test.ts 的 fixture 字符串
  // 被提取器当成真实端点——「工具扫描自身 fixture」自污染)
  return !SENSING_SKIP_RE.test(rel) && !isTestPath(rel);
}
import { extractApiSurface, type ApiEndpoint, type ApiSurface } from "./http-api";
import { reconcileForRoot, specFingerprint, type SpecReconcile } from "./openapi";
import { getSensingDeps, runSemanticBatch, excerptAt, type EvidenceAnchor } from "./semantic";

export * from "./http-api";
export * from "./openapi";
export * from "./semantic";
export * from "./procentries";
export { extractStateMachinesFromFile, extractStateMachineSurface, STATE_FINGERPRINT_LITERALS } from "./statemachines";
export type { StateMachine, StateTransition, StateMachineSurface } from "./statemachines";
export { extractAlgoProfileFromFile, extractAlgoSurface, ALGO_FINGERPRINT_LITERALS } from "./algoprofile";
export type { AlgoKind, AlgoSignal, AlgoProfile, AlgoSurface } from "./algoprofile";

export interface ApiEndpointJoined extends ApiEndpoint {
  /** handler 在静态索引中的节点 id(querySymbol 解析命中时)。 */
  handlerNodeId?: string;
  /** 影响面摘要(索引在场时;缺索引=undefined 且 surface.degraded 有说明)。 */
  impactSummary?: { directCallers: number; transitiveCallers: number; fileCount: number; testCount: number };
  /** LLM 语义(opt-in;缺席=undefined,不假报)。 */
  semantic?: string;
}

export interface ApiSurfaceResult {
  endpoints: ApiEndpointJoined[];
  frameworks: string[];
  scannedFiles: number;
  reconcile?: SpecReconcile;
  /** 索引增强层状态:ok=已挂载影响面;degraded 时带原因。 */
  indexJoin: { status: "ok" | "degraded"; reason?: string };
  semanticLayer: { status: "ok" | "off" | "failed"; dropped?: number; repairs?: number; reason?: string };
  /** 非产品路径过滤呈报(缺席=零过滤;filtered>0 时 note 必非空——诚实原则:
   * 过滤后端点为空也要看见「为什么空」,不得静默清零)。 */
  pathFilter?: { filtered: number; note: string };
}

// ---- 进程内 TTL 缓存(与 lazyGraphCache 同构纪律) ----
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; fp: string; result: ApiSurfaceResult }>();
export function invalidateApiSurfaceCache(root?: string): void {
  if (!root) { cache.clear(); return; }
  for (const k of [...cache.keys()]) if (k.startsWith(root + "|")) cache.delete(k);
}

/** 接口语义层查询主入口。opts.withSemantics=true 且已注入 senseLlm 时跑 LLM 语义层。 */
export async function queryApiSurface(
  root: string,
  opts?: { withSemantics?: boolean; refresh?: boolean; withImpact?: boolean; all?: boolean },
): Promise<ApiSurfaceResult> {
  const fp = srcFingerprintCached(root) ?? { count: -1, maxMtime: -1 }; // 冷启动=未知:占位键不命中任何已存缓存(几秒后异步指纹入缓存即精确)
  const fpKey = `${fp.count}:${fp.maxMtime}`;
  // 缓存键必须含 spec 指纹(openapi.ts specFingerprint = spec 文件清单 + 各文件 mtime)。
 // 注意缺陷:源码扩展名指纹(GRAPH_SOURCE_EXT)不含 openapi.yaml/json,长驻进程(MCP serve)
  // 里改了 spec,旧代码在 60s TTL 内继续返回旧对账(或缺对账)——bridge 每轮自行发现 spec
  // 不受影响,于是 api 面与 bridge 面对不上。specKey 的取值代价见 openapi.ts 的档位注释
  // (廉价档 stat 已知 spec;深档 readdir 每 1s 最多一次)。refresh=true 视为调用方明确要求
  // 重新发现(force),不吃深档节流——否则 refresh 仍可能给出 1s 内的旧 spec 清单。
  const specFp = await specFingerprint(root, opts?.refresh === true);
  const key = `${root}|${fpKey}|spec:${specFp.key}|${opts?.withSemantics ? "s" : ""}|${opts?.all ? "all" : ""}`;
  const hit = cache.get(key);
  if (hit && !opts?.refresh && Date.now() - hit.at < TTL_MS) return hit.result;

  // ① 指纹预筛(rg 字面量):含框架指纹的文件才读;Next.js 纯文件约定(零框架 import 的
  // pages/api|app/api 文件)走目录补扫——grep 指纹覆盖不到无 import 的路由文件。
 // max=3000(自 1500 上调):字面量清单重排后特异框架 pattern 在前,grafana 类
  // 混语大仓 go 侧候选( RouteRegister/chi/net-http 家族)合计可超 1500——上限过低会把
  // 泛型 "net/http" 命中的既有 net-http 路由文件挤出候选(56 端点回退风险)。
 // agent_alpha 经验证 20 文件含 fastapi 字面量,不受影响。
  const { API_FINGERPRINT_LITERALS } = await import("./http-api");
  const candFiles = new Set((await grepFilesIn(root, API_FINGERPRINT_LITERALS, { max: 3000 })).filter(sensingKeepFile));
  const { readdir } = await import("node:fs/promises");
  for (const base of ["pages/api", "app/api", "src/pages/api", "src/app/api"]) {
    const walkApi = async (dir: string, depth: number): Promise<void> => {
      if (depth > 6) return;
      let entries;
      try { entries = await readdir(join(root, dir), { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) await walkApi(rel, depth + 1);
        else if (/\.[jt]sx?$/.test(e.name)) candFiles.add(rel);
      }
    };
    await walkApi(base, 0);
  }
  // ①' 非产品路径过滤(叠加在 sensingKeepFile 之后;Next.js 目录补扫的候选一并过闸):
  // docs_src/** 教程、examples/**、mocks/** 里的「路由形态」不是这个服务提供的接口。
  const fileFilter: PathFilterResult<string> = filterNonProductPaths([...candFiles], (x) => x, { all: opts?.all });
  const surface: ApiSurface = await extractApiSurface(root, fileFilter.kept);

  // ② OpenAPI 对账(单一真相源:openapi.ts reconcileForRoot;specFiles 直接复用上一步
  // specFingerprint 的发现结果,避免同一轮第二次全仓遍历)
  let reconcile: SpecReconcile | undefined;
  const specAtRoot = await reconcileForRoot(root, surface.endpoints, { specFiles: specFp.specFiles });
  if (specAtRoot.reconcile) reconcile = specAtRoot.reconcile;

  // ③ handler→索引挂载+影响面(只读消费;索引缺席显式降级)
  const joined: ApiEndpointJoined[] = surface.endpoints.map((e) => ({ ...e }));
  let indexJoin: ApiSurfaceResult["indexJoin"] = { status: "degraded", reason: "未请求影响面(withImpact=false)" };
  if (opts?.withImpact !== false) {
    const { loadIndex, querySymbol } = await import("../callgraph/c2f");
    const { queryImpact } = await import("../callgraph/impact");
    const index = loadIndex(root);
    if (index) {
      for (const e of joined) {
        if (!e.handler) continue;
        const syms = querySymbol(index, e.handler);
        const sameFile = syms.find((s) => s.symbol.file === e.file) ?? syms[0];
        if (!sameFile) continue;
        e.handlerNodeId = sameFile.symbol.id;
        const imp = queryImpact(index, sameFile.symbol.name, { depth: 2 });
        e.impactSummary = {
          directCallers: imp.summary.directCallers,
          transitiveCallers: imp.summary.transitiveCallers,
          fileCount: imp.summary.fileCount,
          testCount: imp.summary.testCount,
        };
      }
      indexJoin = { status: "ok" };
    } else {
      indexJoin = { status: "degraded", reason: "静态索引未构建——接口清单可用,影响面不可用(激活: codesense index)" };
    }
  }

  // ④ 语义层(opt-in 注入)
  const result: ApiSurfaceResult = {
    endpoints: joined,
    frameworks: surface.frameworks,
    scannedFiles: surface.scannedFiles,
    ...(reconcile ? { reconcile } : {}),
    indexJoin,
    semanticLayer: { status: "off", reason: "未请求语义层(withSemantics=false)" },
    ...(fileFilter.filtered > 0
      ? { pathFilter: { filtered: fileFilter.filtered, note: nonProductFilterNote(fileFilter.filtered, fileFilter.samples, { all: opts?.all }) } }
      : {}),
  };
  if (opts?.withSemantics) {
    const llm = getSensingDeps().senseLlm;
    if (!llm) {
      result.semanticLayer = { status: "off", reason: "未注入 senseLlm(setSensingDeps 激活)" };
    } else {
      const targets = joined.slice(0, 30); // 语义层规模纪律:≤30 接口
      const anchors: EvidenceAnchor[] = [];
      const excerpts: string[] = [];
      for (let i = 0; i < targets.length; i++) {
        const e = targets[i]!;
        const id = `E${i + 1}`;
        anchors.push({
          id, file: e.file, line: e.line,
          text: `${e.method} ${e.path}${e.handler ? ` → handler ${e.handler}` : ""}${e.docHint ? `(代码注释: ${e.docHint})` : ""}${reconcile ? (reconcile.both.find((b) => normalizeKey(b) === normalizeKey(e))?.summary ? `(规范描述: ${reconcile.both.find((b) => normalizeKey(b) === normalizeKey(e))!.summary})` : "") : ""}`,
        });
        const code = e.handler ? await excerptAt(root, e.file, e.line, 20) : "";
        if (code) excerpts.push(`[${id}] ${e.file}:${e.line}\n${code}`);
      }
      const outcome = await runSemanticBatch(
        "你是后端接口分析师。为下列 HTTP 接口各写一句职责描述(这个接口接收什么、返回什么、干什么用;只写代码事实能支撑的内容,不推测业务背景)。",
        anchors,
        excerpts.join("\n\n").slice(0, 12000),
      );
      if (!outcome) {
        result.semanticLayer = { status: "off", reason: "无锚点" };
      } else {
        for (const e of joined) {
          const idx = targets.indexOf(e);
          if (idx < 0) continue;
          const s = outcome.items.get(`E${idx + 1}`);
          if (s) e.semantic = s;
        }
        result.semanticLayer = {
          status: outcome.ok ? "ok" : "failed",
          ...(outcome.dropped ? { dropped: outcome.dropped } : {}),
          ...(outcome.repairs ? { repairs: outcome.repairs } : {}),
          ...(!outcome.ok ? { reason: "LLM 输出校验/修复环后仍不合格,语义层拒收(确定性清单不受影响)" } : {}),
        };
      }
    }
  }

  cache.set(key, { at: Date.now(), fp: fpKey, result });
  return result;
}

function normalizeKey(x: { method: string; path: string }): string {
  return `${x.method} ${x.path.replace(/:([\w]+)/g, "{}").replace(/\{[^}]+\}/g, "{}").replace(/\/+$/, "")}`;
}

// ============================== 状态机(P2) ==============================

import { extractStateMachineSurface, STATE_FINGERPRINT_LITERALS, type StateMachineSurface } from "./statemachines";

const stateCache = new Map<string, { at: number; result: StateMachineSurfaceResult }>();

/** 状态机表面结果 = statemachines 的纯产物 + 过滤呈报(不改 statemachines 的 Surface 类型:
 * 那个类型是「提取器输出」的契约,过滤是编排层的口径,两者分层)。 */
export interface StateMachineSurfaceResult extends StateMachineSurface {
  /** 非产品路径过滤呈报(缺席=零过滤;filtered>0 时 note 必非空)。 */
  pathFilter?: { filtered: number; note: string };
}

/** 状态机表面查询(确定性;指纹预筛→行扫描;docs/examples/.md 等非产品路径先剔除)。 */
export async function queryStateMachines(root: string, opts?: { refresh?: boolean; all?: boolean }): Promise<StateMachineSurfaceResult> {
  const fp = srcFingerprintCached(root) ?? { count: -1, maxMtime: -1 }; // 冷启动=未知:占位键不命中任何已存缓存(几秒后异步指纹入缓存即精确)
  const key = `${root}|${fp.count}:${fp.maxMtime}|${opts?.all ? "all" : ""}`;
  const hit = stateCache.get(key);
  if (hit && !opts?.refresh && Date.now() - hit.at < TTL_MS) return hit.result;
  const candFiles = (await grepFilesIn(root, STATE_FINGERPRINT_LITERALS, { max: 1200 })).filter(sensingKeepFile);
  // 非产品路径过滤:ts-xstate 的 migration.md 文档示例不再算状态机(验收锚点)
  const fileFilter = filterNonProductPaths(candFiles, (x) => x, { all: opts?.all });
  const surface = await extractStateMachineSurface(root, fileFilter.kept);
  const result: StateMachineSurfaceResult = {
    ...surface,
    ...(fileFilter.filtered > 0
      ? { pathFilter: { filtered: fileFilter.filtered, note: nonProductFilterNote(fileFilter.filtered, fileFilter.samples, { all: opts?.all }) } }
      : {}),
  };
  stateCache.set(key, { at: Date.now(), result });
  return result;
}

/** 文本渲染(CLI/工具面同源)。 */
export function renderStateMachines(r: StateMachineSurfaceResult): string {
  const lines: string[] = [];
  lines.push(`状态机表面: ${r.machines.length} 个(扫描文件 ${r.scannedFiles})`);
  if (r.pathFilter && r.pathFilter.note) lines.push(`  [路径过滤] ${r.pathFilter.note}`);
  for (const m of r.machines) {
    lines.push(`  ${m.name} [${m.form}] @ ${m.file}`);
    if (m.form === "redux-slice" && m.redux) {
      lines.push(`    (动作驱动变更,非具名状态机)状态字段: ${m.redux.stateFields.join(", ") || "无"};动作: ${m.redux.actions.join(", ") || "无"}`);
      continue;
    }
    lines.push(`    状态(${m.states.length}): ${m.states.join(", ")}`);
    for (const t of m.transitions.slice(0, 20)) {
      lines.push(`    ${t.from} --${t.trigger ?? ""}→ ${t.to} @${t.evidence.line}`);
    }
    if (m.transitions.length > 20) lines.push(`    …转移共 ${m.transitions.length} 条(截断)`);
    if (m.candidates.length > 0) lines.push(`    低置信候选 ${m.candidates.length} 条(未入图)`);
  }
  if (r.statusHints.length > 0) {
    lines.push(`  DB status 词法提示(${r.statusHints.length},词法级可能含误判,仅供人工排查入口):`);
    for (const h of r.statusHints.slice(0, 10)) lines.push(`    ${h.file}:${h.line} ${h.text}`);
  }
  return lines.join("\n");
}

/** 文本渲染(CLI/工具面同源)。 */
export function renderApiSurface(r: ApiSurfaceResult): string {
  const lines: string[] = [];
  lines.push(`接口表面: ${r.endpoints.length} 个端点(框架: ${r.frameworks.join(", ") || "未识别"};扫描文件 ${r.scannedFiles})`);
  // 诚实原则:过滤发生时首行后立刻呈报条数+样本+--all 逃生口(端点数为 0 时也照报)
  if (r.pathFilter && r.pathFilter.note) lines.push(`  [路径过滤] ${r.pathFilter.note}`);
  const byFile = new Map<string, ApiEndpointJoined[]>();
  for (const e of r.endpoints) {
    const arr = byFile.get(e.file) ?? [];
    arr.push(e);
    byFile.set(e.file, arr);
  }
  for (const [file, eps] of byFile) {
    lines.push(`  ${file}:`);
    for (const e of eps) {
      const parts = [`    ${e.method} ${e.path}`];
      if (e.handler) parts.push(`→ ${e.handler}`);
      parts.push(`@${e.line}`);
      if (e.prefixInferred) parts.push(`(前缀跨文件挂载,本地未解析)`);
      if (e.docHint) parts.push(`— ${e.docHint}`);
      if (e.semantic) parts.push(`\n      语义(模型解读): ${e.semantic}`);
      if (e.impactSummary) {
        parts.push(`\n      影响面: 直接调用方 ${e.impactSummary.directCallers} / 传递 ${e.impactSummary.transitiveCallers} / 文件 ${e.impactSummary.fileCount} / 测试 ${e.impactSummary.testCount}`);
      }
      lines.push(parts.join(" "));
    }
  }
  if (r.reconcile) {
    const rc = r.reconcile;
    lines.push(`  规范对账(${rc.spec.file}, 解析=${rc.spec.parse}): 一致 ${rc.both.length} / 仅规范 ${rc.specOnly.length} / 仅代码 ${rc.codeOnly.length}`);
    for (const s of rc.specOnly.slice(0, 10)) lines.push(`    [仅规范] ${s.method} ${s.path}${s.summary ? ` — ${s.summary}` : ""}`);
    for (const c of rc.codeOnly.slice(0, 10)) lines.push(`    [仅代码] ${c.method} ${c.path} @${c.file}:${c.line}`);
  }
  if (r.indexJoin.status === "degraded") lines.push(`  [降级] 影响面: ${r.indexJoin.reason}`);
  if (r.semanticLayer.status !== "ok") lines.push(`  [语义层] ${r.semanticLayer.status}: ${r.semanticLayer.reason ?? ""}`);
  return lines.join("\n");
}

// ============================== 算法画像(P3) ==============================

import { extractAlgoSurface, ALGO_FINGERPRINT_LITERALS, type AlgoSurface, type AlgoProfile } from "./algoprofile";

export interface AlgoSurfaceResult extends AlgoSurface {
  /** LLM 算法导读(opt-in;按文件键)。 */
  walkthroughs?: Record<string, string[]>;
  semanticLayer: { status: "ok" | "off" | "failed"; dropped?: number; repairs?: number; reason?: string };
  /** 非产品路径过滤呈报(缺席=零过滤;filtered>0 时 note 必非空)。 */
  pathFilter?: { filtered: number; note: string };
}

const algoCache = new Map<string, { at: number; result: AlgoSurfaceResult }>();

/** 算法画像查询主入口。opts.file=聚焦单文件(导读粒度);withSemantics+注入=LLM 步骤导读。 */
export async function queryAlgoProfiles(
  root: string,
  opts?: { withSemantics?: boolean; refresh?: boolean; file?: string; all?: boolean },
): Promise<AlgoSurfaceResult> {
  const fp = srcFingerprintCached(root) ?? { count: -1, maxMtime: -1 }; // 冷启动=未知:占位键不命中任何已存缓存(几秒后异步指纹入缓存即精确)
  const key = `${root}|${fp.count}:${fp.maxMtime}|${opts?.file ?? ""}|${opts?.withSemantics ? "s" : ""}|${opts?.all ? "all" : ""}`;
  const hit = algoCache.get(key);
  if (hit && !opts?.refresh && Date.now() - hit.at < TTL_MS) return hit.result;

 // P0:file 参数此前只用于语义导读目标,画像仍全仓扫描(两个不同文件返回同一
  // 24/30)。显式给文件时只画像该文件,且绕开 grep 指纹预筛(任意语言/无指纹也能看单文件)。
  let fileFiltered: { filtered: number; samples: string[] } | undefined;
  let candFiles: string[];
  if (opts?.file) {
    const rel = (isAbsolute(opts.file) ? relative(root, opts.file) : opts.file).split("\\").join("/");
    let exact = true;
    try { await readFile(join(root, rel), "utf-8"); } catch { exact = false; }
    if (exact) {
      candFiles = [rel];
    } else {
      // 用户常给 basename(onnx_infer.py):在全仓候选里按后缀解析真实相对路径。
      const all = (await grepFilesIn(root, ALGO_FINGERPRINT_LITERALS, { max: 1200 })).filter(sensingKeepFile);
      const hits = all.filter((f) => f === rel || f.endsWith("/" + rel));
      candFiles = hits.length > 0 ? hits : [rel];
    }
  } else {
    candFiles = (await grepFilesIn(root, ALGO_FINGERPRINT_LITERALS, { max: 1200 })).filter(sensingKeepFile);
    // 非产品路径过滤:mmdetection 的 docs/** 教程不是这个仓的算法实现
    const fileFilter = filterNonProductPaths(candFiles, (x) => x, { all: opts?.all });
    candFiles = fileFilter.kept;
    if (fileFilter.filtered > 0) fileFiltered = { filtered: fileFilter.filtered, samples: fileFilter.samples };
  }
  const surface = await extractAlgoSurface(root, candFiles);

  const result: AlgoSurfaceResult = {
    ...surface,
    semanticLayer: { status: "off", reason: "未请求语义层(withSemantics=false)" },
    ...(fileFiltered
      ? { pathFilter: { filtered: fileFiltered.filtered, note: nonProductFilterNote(fileFiltered.filtered, fileFiltered.samples, { all: opts?.all }) } }
      : {}),
  };

  if (opts?.withSemantics) {
    const llm = getSensingDeps().senseLlm;
    if (!llm) {
      result.semanticLayer = { status: "off", reason: "未注入 senseLlm(setSensingDeps 激活)" };
    } else {
      // 导读粒度:聚焦文件 > 信号最多前 3 个文件(规模纪律)
      const targets = opts.file
        ? surface.profiles.filter((p) => p.file === opts.file || p.file.endsWith(opts.file!))
        : surface.profiles.slice(0, 3);
      if (targets.length === 0) {
        result.semanticLayer = { status: "failed", reason: "无匹配文件可导读" };
      } else {
        const anchors: EvidenceAnchor[] = [];
        const excerpts: string[] = [];
        const fileOfAnchor = new Map<string, AlgoProfile>();
        for (const p of targets) {
          for (let k = 0; k < p.signals.length; k++) {
            const s = p.signals[k]!;
            const id = `A${anchors.length + 1}`;
            anchors.push({ id, file: p.file, line: s.line, text: `${s.pattern}(${p.kinds[0]})` });
            fileOfAnchor.set(id, p);
          }
        }
        for (const p of targets.slice(0, 3)) {
          const code = await excerptAt(root, p.file, p.signals[0]?.line ?? 1, 40);
          if (code) excerpts.push(`### ${p.file}\n${code}`);
        }
        const outcome = await runSemanticBatch(
          "你是算法工程师。为下列算法信号锚各写一句导读(这一步在管线里干什么:数据/模型/训练/推理/评估;只说代码事实能支撑的内容)。",
          anchors,
          excerpts.join("\n\n").slice(0, 12000),
        );
        if (!outcome) {
          result.semanticLayer = { status: "off", reason: "无锚点" };
        } else {
          const walkthroughs: Record<string, string[]> = {};
          for (const [aid, summary] of outcome.items) {
            const p = fileOfAnchor.get(aid);
            if (!p) continue;
            walkthroughs[p.file] = [...(walkthroughs[p.file] ?? []), summary];
          }
          result.walkthroughs = walkthroughs;
          result.semanticLayer = {
            status: outcome.ok ? "ok" : "failed",
            ...(outcome.dropped ? { dropped: outcome.dropped } : {}),
            ...(outcome.repairs ? { repairs: outcome.repairs } : {}),
          };
        }
      }
    }
  }

  algoCache.set(key, { at: Date.now(), result });
  return result;
}

/** 文本渲染(CLI/工具面同源)。 */
export function renderAlgoProfiles(r: AlgoSurfaceResult): string {
  const lines: string[] = [];
  lines.push(`算法画像: ${r.profiles.length} 个文件(扫描 ${r.scannedFiles});管线角色分布:`);
  if (r.pathFilter && r.pathFilter.note) lines.push(`  [路径过滤] ${r.pathFilter.note}`);
  for (const m of r.modules) {
    lines.push(`  ${m.dir}: ${m.kinds.join("+")} (${m.files} 文件)`);
  }
  for (const p of r.profiles.slice(0, 20)) {
    lines.push(`  ${p.file} [${p.kinds.join(",")}]`);
    for (const s of p.signals.slice(0, 6)) lines.push(`    信号: ${s.pattern} @${s.line}`);
    for (const e of p.entryPoints.slice(0, 4)) lines.push(`    入口: ${e.name}(${e.role})@${e.line}`);
    for (const w of r.walkthroughs?.[p.file] ?? []) lines.push(`    导读(模型解读): ${w}`);
  }
  if (r.profiles.length > 20) lines.push(`  …共 ${r.profiles.length} 个(截断)`);
  if (r.semanticLayer.status !== "ok") lines.push(`  [语义层] ${r.semanticLayer.status}: ${r.semanticLayer.reason ?? ""}`);
  return lines.join("\n");
}
