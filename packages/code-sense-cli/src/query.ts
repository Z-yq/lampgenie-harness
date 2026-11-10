/**
 * 查询指令实现(symbol/callers/callees/entrypoints/file/filegraph/graph):
 *  - 人类可读文本 = mcp-core dispatchTool 的同一份输出(三方同源,零漂移);
 *  - --json = 结构化查询结果(direct querySymbol/queryFile/queryEntryPoints/render*),
 *    agent 消费用,仓归属逐条标注。
 *  - 索引缺失:自动补建一次(增量复用引擎,除非 --no-build);索引过期:照常用+stderr 提示
 *    (一次性进程不做后台重建,fork 会成孤儿;要更新显式跑 `codesense index`)。
 *  - root 解析:位置参数/--root > 注册表就近(逐级向上) > .genie/sense-index 隐式根;
 *    都没有 → init 引导文案,exit 2。
 */
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { existsSync, mkdirSync, readdirSync, writeFileSync, type Dirent } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  indexStale, loadIndex, queryEntryPoints, queryEntryPointsMeta, queryFile, querySymbol, renderFile, renderNeighborhood, samplingNote,
  type C2fIndex, type C2fNode, type SymbolQueryResult,
} from "@lampgenie/code-sense/callgraph/c2f";
import { queryImpact, renderImpact } from "@lampgenie/code-sense/callgraph/impact";
import { languageCoverageCachedSync, coverageWarnings } from "@lampgenie/code-sense/callgraph/coverage";
import { scanProcessEntriesSync } from "@lampgenie/code-sense/sensing/procentries";
import { buildModuleView, renderModuleView } from "@lampgenie/code-sense/callgraph/modview";
import {
  buildCodeFlow, codeFlowJson, FlowTargetError, renderCodeFlowDot, renderCodeFlowMermaid, renderCodeFlowText,
  type CodeFlow, type FlowDirection, type FlowLevel,
} from "@lampgenie/code-sense/callgraph/flow";
import {
  buildFileCfgs, cfgJson, pickFunction, renderCfgDot, renderCfgMermaid, renderCfgText,
  type CfgFileResult, type CfgFunction,
} from "@lampgenie/code-sense/sensing/cfg";
import { attachCfgContext } from "@lampgenie/code-sense/sensing/cfg-context";
import { moduleAnnotationText, moduleNotes, type ModuleNote } from "@lampgenie/code-sense/callgraph/module-notes";
import { discoverRoots, createCodeIndexMcp, formatEntrypointsBlock, querySymbolDeep, symbolSuggestions, type DeepRef, type RepoState } from "./mcp-core.js";
import { expandTilde } from "./args.js";
import { loadRegistry, resolveProjectRoot } from "./registry.js";
import { buildIndexWithReuse } from "./incremental.js";

export interface QueryContext {
  root: string;
  rootSource: string;
  repos: RepoState[];
  notes: string[];
  mcp: ReturnType<typeof createCodeIndexMcp>;
}

export class ResolveError extends Error {}

/** 解析 root + 同步确保各仓索引可用(缺失自动建;过期如实标注)。 */
export async function resolveContext(opts: { root?: string; noBuild?: boolean; quiet?: boolean }): Promise<QueryContext> {
  let root = opts.root ?? "";
  let source = "--root";
  if (!root) {
    const hit = resolveProjectRoot(process.cwd());
    if (!hit) {
      throw new ResolveError(
        "未找到 codesense 根——当前目录未 init,上层目录也没有已登记的根。\n" +
        "  处理:①在本项目根运行 `codesense index --register`(探索+建索引+登记,重叠子树自动复用);\n" +
        "        ②或用 `codesense --root <项目路径> <指令>` 显式指定;\n" +
        "        ③`codesense roots` 查看已登记的根。",
      );
    }
    root = hit.root;
    source = hit.source;
  }
  // step-092 fail-visible:根不存在此前静默滑向「零仓 + 全 miss」(错误伪装成查询未命中);
  // 显式 --root 打错路径 / 注册表根被删都值得一句人话,而不是让用户怀疑索引质量。
  if (!existsSync(root)) {
    throw new ResolveError(
      source === "--root"
        ? `root 不存在: ${root}(--root 指向的目录不在盘上;波浪号路径已自动展开,请核对盘上真实路径)`
        : `注册表根已失效: ${root}(来源 ${source};可运行 \`codesense roots\` 核对、\`codesense remove <root>\` 清理)`,
    );
  }
  const notes: string[] = [];
  // 隐式根(.genie/sense-index 产物在盘)=该目录已是「被索引单元」,不再展开子仓——
  // 否则单项目仓(如 lampgenie-harness,子目录满是 package.json)会被拆成十几个子仓索引,
  // 真正的代码在未展开的 apps/ 下,查询全 miss。--root/注册表根保持 gateway 同款的展开语义。
  const repos = source === "index-artifact" ? [root] : discoverRoots(root);
  for (const r of repos) {
    let idx = loadIndex(r);
    if (!idx) {
      if (opts.noBuild) {
        notes.push(`${basename(r)}: 索引缺失(--no-build 跳过自动建)`);
        continue;
      }
      const out = await buildIndexWithReuse(r, { onProgress: opts.quiet ? undefined : (m) => process.stderr.write(`[codesense] ${basename(r)}: ${m}\n`) });
      idx = out.index;
      notes.push(`${basename(r)}: 索引缺失已自动构建(${out.mode},复用 ${out.reused.length}/新扫 ${out.scanned.length})——建议 init 登记该根`);
    } else if (indexStale(r, idx)) {
      notes.push(`${basename(r)}: 索引可能过期(源码有变动),查询按现有索引回答;运行 codesense index 更新`);
    }
    // step-141 P0-1:采样索引的判定口径诚实呈报(不静默——COUNT 比对已退化,mtime/HEAD 仍是有效信号)
    const sNote = samplingNote(idx);
    if (sNote) notes.push(`${basename(r)}: ${sNote}`);
  }
  const ready = repos
    .map((r) => {
      const idx = loadIndex(r);
      return idx ? { root: r, name: basename(r), index: idx, stale: indexStale(r, idx) } : null;
    })
    .filter((s): s is RepoState => s !== null);
  return { root, rootSource: source, repos: ready, notes, mcp: createCodeIndexMcp(root, { autoBuild: false }) };
}

function toolText(ctx: QueryContext, tool: string, args: Record<string, unknown>): { text: string; isError: boolean } {
  const r = ctx.mcp.dispatchTool(tool, args);
  return { text: r.content[0]?.text ?? "", isError: r.isError };
}

const MISS_MARKS = ["未找到符号", "文件无索引符号", "索引尚未就绪", "未知仓", "索引为空"];

function isMiss(text: string): boolean {
  return MISS_MARKS.some((m) => text.includes(m));
}

export interface QueryOutput {
  text: string;
  json?: unknown;
  /** 语义缺失(未命中/未就绪):exit 1。 */
  miss: boolean;
}

export function querySymbolCmd(ctx: QueryContext, name: string, repo?: string, json = false, depth?: number): QueryOutput {
  if (!json) {
    const t = toolText(ctx, "code_index_symbol", { name, ...(repo ? { repo } : {}), ...(depth ? { depth } : {}) });
    return { text: t.text, miss: t.isError || isMiss(t.text) };
  }
  const sts = pickRepos(ctx, repo);
  const suggest = sts.length > 0 ? symbolSuggestions(sts, name) : [];
  if (depth) {
    const hits = sts.flatMap((st) => querySymbolDeep(st.index, name, depth).map((h) => ({
      repo: st.name,
      symbol: h.symbol,
      callers: h.callersDeep.map(({ id: _id, depth: d, ...rest }) => ({ ...rest, depth: d })),
      callees: h.calleesDeep.map(({ id: _id, depth: d, ...rest }) => ({ ...rest, depth: d })),
      truncated: h.truncated,
    })));
    return {
      text: "",
      miss: hits.length === 0,
      json: {
        query: "symbol", name, depth, repos: sts.map((s) => s.name), hitCount: hits.length, hits,
        ...(hits.length === 0 && suggest.length ? { suggestions: suggest } : {}),
      },
    };
  }
  const hits = sts.flatMap((st) => querySymbol(st.index, name).map((h) => ({ repo: st.name, ...h })));
  return {
    text: "",
    miss: hits.length === 0,
    json: {
      query: "symbol", name, repos: sts.map((s) => s.name), hitCount: hits.length, hits,
      ...(hits.length === 0 && suggest.length ? { suggestions: suggest } : {}),
    },
  };
}

/** callers/callees:结构化单侧视图(调用方/被调方去重语义与 querySymbol 一致)。 */
export function queryEdgeCmd(ctx: QueryContext, name: string, side: "callers" | "callees", repo?: string, json = false, depth?: number): QueryOutput {
  const sts = pickRepos(ctx, repo);
  const perRepo = sts.map((st) => {
    const hits = depth
      ? querySymbolDeep(st.index, name, depth).map((h) => ({ ...h, truncated: h.truncated, [side]: (side === "callers" ? h.callersDeep : h.calleesDeep) as DeepRef[] }))
      : querySymbol(st.index, name).map((h) => ({ ...h, truncated: false, [side]: side === "callers" ? h.callers : h.callees }));
    const edges = hits.map((h) => ({
      symbol: { name: h.symbol.name, file: h.symbol.file, line: h.symbol.line, kind: h.symbol.kind },
      [side]: h[side],
      ...(depth ? { truncated: h.truncated } : {}),
    }));
    return { repo: st.name, definitions: edges, ...(depth ? { depth } : {}) };
  });
  const total = perRepo.reduce((n, r) => n + r.definitions.length, 0);
  if (json) {
    return { text: "", miss: total === 0, json: { query: side, name, repos: perRepo } };
  }
  if (total === 0) {
    return { text: `未找到符号: ${name}(已查就绪仓: ${sts.map((s) => s.name).join(", ") || "无"})`, miss: true };
  }
  const ref = (c: { name: string; file: string; line: number; depth?: number }) =>
    (c.line > 0 ? `${c.name}@${c.file}:${c.line}` : `${c.name}@${c.file}`) + (c.depth && c.depth > 1 ? ` (d${c.depth})` : "");
  const lines: string[] = [];
  for (const r of perRepo) {
    for (const def of r.definitions) {
      const list = (def as { callers?: { name: string; file: string; line: number; depth?: number }[]; callees?: { name: string; file: string; line: number; depth?: number }[] })[side] ?? [];
      lines.push(`[${r.repo}] ${def.symbol.name} — ${def.symbol.file}:${def.symbol.line}`);
      if (list.length === 0) {
        lines.push(side === "callers" ? "  被调用: 无(入口函数)" : "  调用: 无(叶子函数)");
      } else {
        lines.push(`  ${side === "callers" ? "被调用" : "调用"}(${list.length})${depth ? ` depth=${depth}` : ""}:`);
        for (const c of list) lines.push(`    ${ref(c)}`);
      }
    }
  }
  return { text: lines.join("\n"), miss: false };
}

export function queryEntrypointsCmd(ctx: QueryContext, repo?: string, limit = 15, json = false, all = false): QueryOutput {  const sts = pickRepos(ctx, repo);
  if (!json) {
    // 不走 dispatchTool:--limit 是 CLI 面(默认 8=MCP 同款);limit 缺省时文本与 MCP 逐字一致
    if (sts.length === 0) return { text: "索引尚未就绪", miss: true };
    const text = sts.map((st) => formatEntrypointsBlock(st, Math.max(limit, 15), limit, { all })).join("\n")
      + (sts.some((s) => s.stale) ? "\n(索引可能过期: " + sts.filter((s) => s.stale).map((s) => s.name).join(", ") + ")" : "");
    return { text, miss: sts.length === 0 };
  }
  return {
    text: "",
    miss: sts.length === 0,
    json: {
      query: "entrypoints",
      repos: sts.map((st) => {
        // step-067 fail-visible:覆盖状态随 entrypoints 一并返回(零覆盖语言不再无声缺席)
        const cov = st.index.coverage ?? languageCoverageCachedSync(st.root, Object.keys(st.index.byFile));
        // step-141 P1-1:非产品路径过滤条数随 JSON 一并给出(agent 消费面同样可见过滤口径)
        const meta = queryEntryPointsMeta(st.index, limit, { all });
        // 2026-10-22 P1:进程入口(启动器/进程 main)——JSON 面与文本首节同源
        const proc = scanProcessEntriesSync(st.root, st.index, { all });
        return {
          repo: st.name,
          coverage: cov,
          coverageWarnings: coverageWarnings(cov),
          processEntries: proc.entries,
          ...(proc.filtered > 0 ? { processEntriesFiltered: proc.filtered } : {}),
          ...(meta.filtered > 0 || all ? { pathFilter: { filtered: meta.filtered, note: meta.note } } : {}),
          entrypoints: meta.kept,
        };
      }),
    },
  };
}

/** modules:模块视图(2026-10-22 P1)——清单+跨模块交互矩阵+枢纽/测试面;--graph 追加 mermaid。 */
export function queryModulesCmd(ctx: QueryContext, repo?: string, json = false, graph = false): QueryOutput {
  const sts = pickRepos(ctx, repo);
  if (sts.length === 0) return { text: "索引尚未就绪", miss: true };
  if (json) {
    return {
      text: "",
      miss: false,
      json: {
        query: "modules",
        repos: sts.map((st) => ({ repo: st.name, ...buildModuleView(st.index) })),
      },
    };
  }
  const text = sts.map((st) => `## ${st.name}\n${renderModuleView(buildModuleView(st.index), { graph })}`).join("\n\n")
    + (sts.some((s) => s.stale) ? `\n(索引可能过期: ${sts.filter((s) => s.stale).map((s) => s.name).join(", ")})` : "");
  return { text, miss: false };
}

export function queryFileCmd(ctx: QueryContext, path: string, repo: string | undefined, json: boolean, graph: boolean): QueryOutput {
  // step-092 形态一致(vars/tokens 同族):波浪号自展 + 绝对路径落在仓内时相对化(索引键=根相对路径)。
  const abs0 = expandTilde(path.replace(/\\/g, "/"));
  const relFor = (root: string): string => {
    if (!isAbsolute(abs0)) return abs0;
    const rel = relative(root, abs0);
    return rel.startsWith("..") ? abs0 : rel;
  };
  if (!json) {
    const preferred = repo ? ctx.repos.find((s) => s.name === repo)?.root : ctx.repos.length === 1 ? ctx.repos[0]!.root : undefined;
    const p2 = preferred ? relFor(preferred) : abs0;
    const t = toolText(ctx, graph ? "code_index_filegraph" : "code_index_file", { path: p2, ...(repo ? { repo } : {}) });
    return { text: t.text, miss: t.isError || isMiss(t.text) };
  }
  const sts = pickRepos(ctx, repo);
  const norm = abs0;
  let found: { repo: string; path: string; symbols?: C2fNode[]; mermaid?: string } | null = null;
  for (const st of sts) {
    const key = relFor(st.root);
    const nodes = queryFile(st.index, key);
    if (nodes.length === 0) continue;
    found = graph
      ? { repo: st.name, path: key, mermaid: renderFile(st.index, key) }
      : { repo: st.name, path: key, symbols: nodes };
    break;
  }
  return {
    text: "",
    miss: !found,
    json: found ?? { query: graph ? "filegraph" : "file", path: norm, error: "文件无索引符号" },
  };
}

export function queryGraphCmd(ctx: QueryContext, name: string, repo?: string, json = false, depth?: number): QueryOutput {
  if (!json) {
    const t = toolText(ctx, "code_index_graph", { name, ...(repo ? { repo } : {}), ...(depth ? { depth } : {}) });
    return { text: t.text, miss: t.isError || isMiss(t.text) };
  }
  const sts = pickRepos(ctx, repo);
  for (const st of sts) {
    if (querySymbol(st.index, name).length > 0) {
      return { text: "", miss: false, json: { query: "graph", name, ...(depth ? { depth } : {}), repo: st.name, mermaid: renderNeighborhood(st.index, name, 26, depth ?? 1) } };
    }
  }
  return { text: "", miss: true, json: { query: "graph", name, error: "未找到符号" } };
}

/** api:HTTP 接口表面(step-077,确定性行扫描,不依赖索引构建;索引在场=handler 影响面增强)。
 * 收尾批 I(2026-10-21):--semantics 走 api-semantics 模块(批量 ≤12/请求+上限 40+
 * git sha+端点指纹持久缓存+无凭证显式 off),替换 step-089 P2 的 sensing 单批注入路径
 * (旧路径无持久缓存、缺凭证 exit 2)。--write 显式开启缓存落盘(基线仓默认只读)。 */
export async function queryApiCmd(
  ctx: QueryContext,
  json = false,
  opts?: { semantics?: boolean; all?: boolean; writeCache?: boolean },
): Promise<QueryOutput> {
  const { queryApiSurface, renderApiSurface } = await import("@lampgenie/code-sense/sensing/index");
  const r = await queryApiSurface(ctx.root, { withImpact: true, withSemantics: false, all: opts?.all });
  let semanticBlock: string | undefined;
  let semanticJson: unknown;
  if (opts?.semantics) {
    const { annotateApiSemantics, renderApiSemantics } = await import("./api-semantics.js");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    // 语义回填需改 endpoints——先克隆,防污染 queryApiSurface 的进程内 TTL 缓存对象
    r.endpoints = r.endpoints.map((e) => ({ ...e }));
    const inputs = r.endpoints.map((e) => {
      let codeExcerpt: string | undefined;
      try {
        const src = readFileSync(join(ctx.root, e.file), "utf-8").split("\n");
        const from = Math.max(0, e.line - 3);
        codeExcerpt = src.slice(from, from + 14).join("\n");
      } catch { /* 读不到=无摘要,如实缺席 */ }
      return {
        method: e.method, path: e.path, handler: e.handler, file: e.file, line: e.line,
        docHint: e.docHint, ...(codeExcerpt ? { codeExcerpt } : {}),
      };
    });
    const sem = await annotateApiSemantics(inputs, { root: ctx.root, writeCache: opts?.writeCache === true });
    for (let i = 0; i < r.endpoints.length; i++) {
      const s = sem.endpoints[i]?.semantic;
      if (s) r.endpoints[i]!.semantic = s;
    }
    r.semanticLayer = {
      status: sem.status === "cached" ? "ok" : sem.status === "off" ? "off" : sem.status,
      ...(sem.reason ? { reason: sem.reason } : {}),
      ...(sem.dropped !== undefined ? { dropped: sem.dropped } : {}),
    };
    semanticBlock = renderApiSemantics(sem);
    semanticJson = {
      status: sem.status, llmCalls: sem.llmCalls, batches: sem.batches,
      ...(sem.truncated ? { truncated: sem.truncated } : {}),
      ...(sem.cache ? { cache: sem.cache } : {}),
      ...(sem.reason ? { reason: sem.reason } : {}),
    };
  }
  if (json) {
    return {
      text: "",
      miss: r.endpoints.length === 0,
      json: { query: "api", root: ctx.root, ...r, ...(semanticJson ? { semantics: semanticJson } : {}) },
    };
  }
  const base = renderApiSurface(r);
  return { text: semanticBlock ? `${base}\n${semanticBlock}` : base, miss: r.endpoints.length === 0 };
}

/** state:状态机表面(step-077 P2,五形态确定性提取,不依赖索引构建)。 */
export async function queryStateCmd(ctx: QueryContext, json = false, opts?: { all?: boolean }): Promise<QueryOutput> {
  const { queryStateMachines, renderStateMachines } = await import("@lampgenie/code-sense/sensing/index");
  const r = await queryStateMachines(ctx.root, { all: opts?.all });
  if (json) return { text: "", miss: r.machines.length === 0, json: { query: "state", root: ctx.root, ...r } };
  return { text: renderStateMachines(r), miss: r.machines.length === 0 };
}

/** algo:算法画像(step-077 P3,框架 API 模式识别,不依赖索引构建;file=聚焦导读)。 */
export async function queryAlgoCmd(ctx: QueryContext, json = false, file?: string, opts?: { all?: boolean }): Promise<QueryOutput> {
  const { queryAlgoProfiles, renderAlgoProfiles } = await import("@lampgenie/code-sense/sensing/index");
  const r = await queryAlgoProfiles(ctx.root, { ...(file ? { file } : {}), all: opts?.all });
  if (json) return { text: "", miss: r.profiles.length === 0, json: { query: "algo", root: ctx.root, ...r } };
  return { text: renderAlgoProfiles(r), miss: r.profiles.length === 0 };
}

/** bridge:跨语言桥边(step-103 / designs/27;HTTP api 桥原型——前端 fetch 字面量 ↔ 后端
 * route 的确定性配对,每条边带双端 file:line 证据;纯行扫描链,不依赖索引)。
 * step-107:--forms 扩展 A2-A6 形态(ws=WebSocket 通道/spec=OpenAPI 对账/ipc=Electron IPC/
 * capi=Python C-API/grpc=gRPC Protobuf;缺省 http-api,与 step-103 行为恒等;all=全形态)。
 * 2026-10-25:--candidates 追加 LLM 消歧候选区(tier=semantic,带双端证据链;确定性边仍默认输出
 * 且不进候选区);--candidates=all 追加 1 段前缀(low)。 */
export async function queryBridgeCmd(
  ctx: QueryContext,
  json = false,
  opts?: { forms?: string; all?: boolean; candidates?: boolean; includePrefix1?: boolean },
): Promise<QueryOutput> {
  const formsRaw = (opts?.forms ?? "http-api").split(",").map((s) => s.trim()).filter(Boolean);
  const forms = formsRaw.includes("all") ? ["http-api", "ws", "spec", "ipc", "capi", "grpc"] : formsRaw;
  const sections: string[] = [];
  const jsonOut: Record<string, unknown> = {};
  let anyHit = false;
  for (const f of forms) {
    if (f === "http-api") {
      const { queryBridgeEdges, renderBridgeEdges, renderBridgeCandidates, bridgeCandidateSurfaceOf } = await import("@lampgenie/code-sense/sensing/crosslang-bridge");
      const r = await queryBridgeEdges(ctx.root, {
        all: opts?.all,
        ...(opts?.candidates
          ? { includeCandidates: true, candidateMode: opts.includePrefix1 ? ("all" as const) : ("first2" as const) }
          : {}),
      });
      jsonOut["http-api"] = r;
      sections.push(renderBridgeEdges(r));
      if (opts?.candidates) sections.push(renderBridgeCandidates(bridgeCandidateSurfaceOf(r)));
      anyHit = anyHit || r.edges.length > 0;
    } else if (f === "ws") {
      const { queryWsChannelEdges, renderWsChannelEdges } = await import("@lampgenie/code-sense/sensing/crosslang-bridge");
      const r = await queryWsChannelEdges(ctx.root, { all: opts?.all });
      jsonOut["ws"] = r;
      sections.push(renderWsChannelEdges(r));
      anyHit = anyHit || r.edges.length > 0;
    } else if (f === "spec") {
      const { querySpecBridgeEdges, renderSpecBridgeEdges } = await import("@lampgenie/code-sense/sensing/crosslang-bridge");
      const r = await querySpecBridgeEdges(ctx.root);
      jsonOut["spec"] = r;
      sections.push(renderSpecBridgeEdges(r));
      anyHit = anyHit || r.edges.length > 0;
    } else if (f === "ipc") {
      const { queryIpcChannelEdges, renderIpcChannelEdges } = await import("@lampgenie/code-sense/sensing/crosslang-bridge");
      const r = await queryIpcChannelEdges(ctx.root, { all: opts?.all });
      jsonOut["ipc"] = r;
      sections.push(renderIpcChannelEdges(r));
      anyHit = anyHit || r.edges.length > 0;
    } else if (f === "capi") {
      const { queryPyCapiEdges, renderPyCapiEdges } = await import("@lampgenie/code-sense/sensing/crosslang-bridge");
      const r = await queryPyCapiEdges(ctx.root);
      jsonOut["capi"] = r;
      sections.push(renderPyCapiEdges(r));
      anyHit = anyHit || r.edges.length > 0;
    } else if (f === "grpc") {
      const { queryGrpcProtoEdges, renderGrpcProtoEdges } = await import("@lampgenie/code-sense/sensing/crosslang-bridge");
      const r = await queryGrpcProtoEdges(ctx.root);
      jsonOut["grpc"] = r;
      sections.push(renderGrpcProtoEdges(r));
      anyHit = anyHit || r.edges.length > 0;
    } else {
      sections.push(`[bridge] 未知形态: ${f}(可选 http-api/ws/spec/ipc/capi/grpc/all)`);
    }
  }
  if (json) {
    // 兼容:缺省单形态 http-api 的 JSON 形态与 step-103 恒等(顶層铺平);多形态/显式指定才进 forms 区
    if (formsRaw.length === 0 || (forms.length === 1 && forms[0] === "http-api" && !formsRaw.includes("all"))) {
      return { text: "", miss: !anyHit, json: { query: "bridge", root: ctx.root, ...(jsonOut["http-api"] as object) } };
    }
    return { text: "", miss: !anyHit, json: { query: "bridge", root: ctx.root, forms, ...jsonOut } };
  }
  return { text: sections.join("\n"), miss: !anyHit };
}

/** refs:字面量引用面(2026-10-21,确定性行扫描,索引非前置)。
 * 删除一个「字符串标识」的动作(如 action === "graph")时 symbol/impact 全空、review --scan
 * 0 条、explore 不命中——本命令按语境(case/eq/z-literal/object-key/string/doc)列出全部
 * 引用点,覆盖产品源码+测试+文档/提示词文本;所属符号读现成静态索引,缺席=留空不猜。
 * 默认排除 node_modules/dist/.genie/vendor;--no-tests/--no-docs 可关(缺省都开)。 */
export async function queryRefsCmd(
  root: string,
  literal: string,
  json = false,
  opts?: { includeTests?: boolean; includeDocs?: boolean },
): Promise<QueryOutput> {
  const { scanLiteralRefs, renderLiteralRefs } = await import("@lampgenie/code-sense/retrieval/literal-refs");
  const r = await scanLiteralRefs(root, literal, {
    ...(opts?.includeTests === false ? { includeTests: false } : {}),
    ...(opts?.includeDocs === false ? { includeDocs: false } : {}),
  });
  if (json) return { text: "", miss: r.hits.length === 0, json: r };
  return { text: renderLiteralRefs(r), miss: r.hits.length === 0 };
}

/** branches:分支/循环骨架(2026-10-21,tree-sitter 全树走查,索引非前置)。
 * 「这个调用在什么条件下发生」:if/elif/else 条件文本 + while/do-while/for/for-of/
 * for-in/switch/case + 三元,每点带行距/嵌套深度/迭代目标/该分支直接调用的函数/
 * 所属函数。refs 的代码命中已联动挂最内层决策点标注;本命令是文件级全骨架形态。 */
export async function queryBranchesCmd(
  ctx: QueryContext,
  path: string,
  repo: string | undefined,
  json = false,
): Promise<QueryOutput> {
  const { root, rel } = resolveTypedTarget(ctx, path, repo);
  const { scanDecisionFile, renderDecisionSkeleton } = await import("@lampgenie/code-sense/sensing/decision");
  const r = await scanDecisionFile(root, rel.replace(/\\/g, "/"));
  if (!r) {
    const msg = "不支持的文件类型或读取失败(支持 py/ts/tsx/js/jsx/mjs/cjs/c/h/cc/cpp/hpp/java/go)";
    if (json) return { text: "", miss: true, json: { query: "branches", path: rel, error: msg } };
    return { text: `codesense branches ${rel} — ${msg}`, miss: true };
  }
  if (json) return { text: "", miss: r.points.length === 0, json: r };
  return { text: renderDecisionSkeleton(r), miss: r.points.length === 0 };
}

// ---- cfg:函数级控制流图(2026-10-27) ----

export interface CfgCliOptions {
  file?: string;
  line?: number;
  /** 同仓被调函数展开层数(0=只画主函数)。 */
  depth?: number;
  /** true=整函数单图(长函数默认分页)。 */
  full?: boolean;
  /** false=连续语句不合并(--no-merge;图会长很多)。 */
  merge?: boolean;
  /** 显式节点上限(0=不设上限,诚实全量)。 */
  maxNodes?: number;
}

export interface CfgQueryResult extends QueryOutput {
  cfgFunctions: CfgFunction[];
}

interface CfgHit { root: string; file: string; name: string; line: number; score: number }

const CALLABLE_KINDS = new Set(["function", "method", "arrow"]);

/** --depth 跨文件解析时跳过的通用/内置名:属性调用(obj.get)与导入函数(get_time)语法同形,
 *  拿不到接收者类型时宁可不展开,也不把 dict.get 连到无关的同名方法(实锚踩过)。
 *  同文件解析不受此限(同文件同名方法大概率就是目标)。 */
const GENERIC_CALLEES = new Set([
  "get", "set", "add", "append", "extend", "update", "items", "values", "keys", "pop", "remove",
  "split", "join", "replace", "strip", "format", "write", "read", "open", "close", "run", "call",
  "apply", "map", "filter", "find", "push", "sort", "sorted", "len", "str", "int", "bool", "list",
  "dict", "sum", "min", "max", "print", "warning", "debug", "info", "error", "dumps", "loads",
  "encode", "decode", "startswith", "endswith", "lower", "upper", "copy", "clear", "insert", "index",
  "count", "next", "iter", "assign", "has", "test", "exec", "match", "search", "group", "compile",
  "sleep", "exists", "mkdir", "makedirs", "basename", "dirname", "splitext", "getenv", "setdefault",
  "equals", "hashCode", "size", "isEmpty", "contains", "put", "forEach", "stream", "collect", "reduce",
  "println", "printf", "trim", "charAt", "substring", "toString", "parse", "stringify",
]);

function cfgHitOfNode(st: RepoState, n: { name: string; file: string; line: number; symKind?: string; inCount: number; outCount: number }): CfgHit | null {
  if (n.symKind && !CALLABLE_KINDS.has(n.symKind)) return null;
  return { root: st.root, file: n.file, name: n.name, line: n.line, score: n.inCount + n.outCount };
}

/** 定位函数:显式 --file 直达;否则索引 byName(短名/限定名)+ 全名后缀兜底。 */
function resolveCfgHits(ctx: QueryContext, name: string, repo: string | undefined, file: string | undefined, line: number | undefined): { hits: CfgHit[]; error?: string } {
  if (file) {
    const { root, rel } = resolveTypedTarget(ctx, file, repo);
    return { hits: [{ root, file: rel.replace(/\\/g, "/"), name, line: line ?? 0, score: 0 }] };
  }
  const sts = pickRepos(ctx, repo);
  if (sts.length === 0) return { hits: [], error: repo ? `未知仓: ${repo}` : "索引尚未就绪" };
  const short = name.split(".").pop() ?? name;
  const hits: CfgHit[] = [];
  const seen = new Set<string>();
  const push = (h: CfgHit | null): void => {
    if (!h) return;
    const key = `${h.root}::${h.file}::${h.name}::${h.line}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push(h);
  };
  for (const st of sts) {
    const ids = new Set([...(st.index.byName[name] ?? []), ...(short !== name ? st.index.byName[short] ?? [] : [])]);
    for (const id of ids) {
      const n = st.index.nodes.find((x) => x.id === id);
      if (n) push(cfgHitOfNode(st, n));
    }
  }
  // byName 缺名(旧索引/限定名变体):按 .short 后缀走一遍节点集(9k 级,可接受)
  if (hits.length === 0) {
    for (const st of sts) {
      for (const n of st.index.nodes) {
        if (n.name === short || n.name.endsWith(`.${short}`)) push(cfgHitOfNode(st, n));
      }
    }
  }
  return {
    hits: hits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line),
    ...(hits.length === 0 ? { error: `未找到函数 ${name}(索引内无同名可调用符号)` } : {}),
  };
}

export async function queryCfgCmd(
  ctx: QueryContext,
  name: string,
  repo: string | undefined,
  json = false,
  opts: CfgCliOptions = {},
): Promise<CfgQueryResult> {
  const { hits, error } = resolveCfgHits(ctx, name, repo, opts.file, opts.line);
  if (!hits || hits.length === 0) {
    const msg = error ?? `未找到函数 ${name}`;
    const suggestions = symbolSuggestions(ctx.repos, name, 5);
    const text = suggestions.length > 0 ? `${msg}\n  你是不是想找: ${suggestions.join(", ")}` : msg;
    if (json) return { text: "", miss: true, json: { query: "cfg", name, error: msg, suggestions }, cfgFunctions: [] };
    return { text, miss: true, cfgFunctions: [] };
  }
  const notes: string[] = [];
  if (hits.length > 1) {
    const others = hits.slice(1, 4).map((h) => `${h.file}:${h.line}`).join(", ");
    notes.push(`同名可调用符号 ${hits.length} 个;已选 ${hits[0]!.file}:${hits[0]!.line}${others ? `(其它: ${others};可用 --file/--line 指定)` : ""}`);
  }
  const fileCache = new Map<string, CfgFileResult | null>();
  const loadFile = async (root: string, file: string): Promise<CfgFileResult | null> => {
    const key = `${root}::${file}`;
    if (!fileCache.has(key)) fileCache.set(key, await buildFileCfgs(root, file, { maxNodes: opts.maxNodes ?? 0 }));
    return fileCache.get(key) ?? null;
  };
  const loadHit = async (hit: CfgHit): Promise<{ fn: CfgFunction; res: CfgFileResult } | { error: string }> => {
    const res = await loadFile(hit.root, hit.file);
    if (!res) {
      return { error: `${hit.file}: 语言不支持 / 读取失败 / 语法错误(tree-sitter 整文件拒收)` };
    }
    const fn = pickFunction(res.functions, hit.name, hit.line > 0 ? hit.line : undefined);
    if (!fn) {
      const names = res.functions.slice(0, 8).map((f) => f.name).join(", ");
      return { error: `${hit.file}: 未定位到函数 ${hit.name} 的函数体${names ? `(文件内函数: ${names}…)` : "(文件内无可绘制函数)"}` };
    }
    return { fn, res };
  };

  // 上游/下游:优先同 root 的索引,其次任何包含该文件的仓索引;缺席=页面/文本显示「索引未提供」
  const attachContext = (fn: CfgFunction, root: string): void => {
    const st = ctx.repos.find((s) => s.root === root) ?? ctx.repos.find((s) => Boolean(s.index.byFile[fn.file]));
    if (st) attachCfgContext(fn, st.index);
  };
  const primary = await loadHit(hits[0]!);
  if ("error" in primary) {
    if (json) return { text: "", miss: true, json: { query: "cfg", name, error: primary.error }, cfgFunctions: [] };
    return { text: `codesense cfg ${name} — ${primary.error}`, miss: true, cfgFunctions: [] };
  }
  attachContext(primary.fn, hits[0]!.root);
  const functions: CfgFunction[] = [primary.fn];
  const seen = new Set([`${primary.fn.file}#${primary.fn.name}#${primary.fn.line}`]);
  const calleeNotes: string[] = [];

  // --depth:展开同仓被调函数(每个函数一张图;跨语言/库函数不解析=缺席,不硬造)
  const depth = Math.max(0, opts.depth ?? 0);
  if (depth > 0) {
    const queue: { hit: CfgHit; fn: CfgFunction; res: CfgFileResult; level: number }[] = [
      { hit: hits[0]!, fn: primary.fn, res: primary.res, level: 0 },
    ];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur.level >= depth) continue;
      for (const call of cur.fn.stats.calls) {
        // 同文件优先(最常见),再按仓索引找第一个可调用定义
        const same = pickFunction(cur.res.functions, call);
        let calleeHit: CfgHit | null = same
          ? { root: cur.hit.root, file: same.file, name: same.name, line: same.line, score: 0 }
          : null;
        if (!calleeHit && !GENERIC_CALLEES.has(call)) {
          // 同名函数可能跨语言/跨任务目录(实锚:Python 的 .get 命中 tasks 里的 JS get):
          // 先按「同仓同目录 > 同仓 > 其它仓」+「同扩展名」+「非 tests/tasks」排序,再取第一个。
          const extOf = (f: string): string => f.slice(f.lastIndexOf(".")).toLowerCase();
          const callerExt = extOf(cur.hit.file);
          const callerDir = dirname(cur.hit.file);
          const ranked: { h: CfgHit; rank: number }[] = [];
          for (const st of pickRepos(ctx, repo)) {
            for (const id of st.index.byName[call] ?? []) {
              const n = st.index.nodes.find((x) => x.id === id);
              const h = n ? cfgHitOfNode(st, n) : null;
              if (!h || extOf(h.file) !== callerExt) continue;
              const dir = dirname(h.file);
              const base = st.root === cur.hit.root ? (dir === callerDir ? 0 : 1) : 5;
              const noisy = /^(tasks|docs|examples|tests?|scripts)\//.test(h.file) || /(^|\/)(test|tests|__tests__)\//.test(h.file);
              ranked.push({ h, rank: base + (noisy ? 3 : 0) });
            }
          }
          ranked.sort((a, b) => a.rank - b.rank || b.h.score - a.h.score || a.h.file.localeCompare(b.h.file));
          calleeHit = ranked[0]?.h ?? null;
        }
        if (!calleeHit) continue;
        const loaded = await loadHit(calleeHit);
        if ("error" in loaded) continue;
        attachContext(loaded.fn, calleeHit.root);
        const key = `${loaded.fn.file}#${loaded.fn.name}#${loaded.fn.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        functions.push(loaded.fn);
        queue.push({ hit: calleeHit, fn: loaded.fn, res: loaded.res, level: cur.level + 1 });
      }
    }
    if (functions.length === 1) calleeNotes.push("--depth 未展开到同仓被调函数(调用名在索引里没有可定位的函数体)");
  }

  if (json) {
    return {
      text: "",
      miss: false,
      cfgFunctions: functions,
      json: {
        query: "cfg",
        name,
        notes: [...notes, ...calleeNotes],
        functions: functions.map(cfgJson),
      },
    };
  }
  const parts: string[] = [];
  if (notes.length > 0 || calleeNotes.length > 0) parts.push([...notes, ...calleeNotes].join("\n"));
  parts.push(`codesense cfg ${name} — 函数级控制流图(${functions.length} 个函数)`);
  functions.forEach((fn, i) => {
    parts.push("");
    parts.push(`## ${i === 0 ? "主函数" : `被调函数 ${i}`} · ${fn.name} — ${fn.file}:${fn.line}-${fn.lineEnd}`);
    parts.push(renderCfgText(fn, { full: opts.full, merge: opts.merge !== false, header: false }));
  });
  return { text: parts.join("\n"), miss: false, cfgFunctions: functions };
}

/** cfg --out:每个函数一份;.mmd/.md/.json/.dot;svg/png 走 graphviz(与 flow 同口径)。 */
export function writeCfgOut(functions: CfgFunction[], out: string, opts: { merge?: boolean } = {}): { written: string[]; errors: string[] } {
  const written: string[] = [];
  const errors: string[] = [];
  if (functions.length === 0) return { written, errors: ["无函数图可写出"] };
  const ext = (out.slice(out.lastIndexOf(".")) || ".mmd").toLowerCase();
  const base = out.slice(0, out.length - ext.length) || out;
  const targets = functions.length === 1
    ? [{ fn: functions[0]!, path: out }]
    : functions.map((fn) => ({ fn, path: `${base}-${fn.name.replace(/[^A-Za-z0-9._-]/g, "_")}${ext}` }));
  for (const t of targets) {
    try {
      mkdirSync(dirname(resolve(t.path)), { recursive: true });
      if (ext === ".json") {
        writeFileSync(t.path, JSON.stringify(cfgJson(t.fn), null, 2) + "\n", "utf-8");
      } else if (ext === ".dot" || ext === ".gv") {
        writeFileSync(t.path, renderCfgDot(t.fn) + "\n", "utf-8");
      } else if (ext === ".md") {
        writeFileSync(t.path, "```mermaid\n" + renderCfgMermaid(t.fn, { merge: opts.merge !== false }) + "\n```\n", "utf-8");
      } else if (ext === ".svg" || ext === ".png") {
        const dotPath = `${t.path}.dot`;
        writeFileSync(dotPath, renderCfgDot(t.fn) + "\n", "utf-8");
        const bin = spawnSync("dot", [`-T${ext.slice(1)}`, "-o", t.path, dotPath], { encoding: "utf-8", timeout: 120_000 });
        if (bin.error || bin.status !== 0) {
          errors.push(`graphviz 渲染失败(${ext}): ${bin.error?.message ?? (bin.stderr || `exit ${bin.status}`)}——已保留 DOT: ${dotPath}`);
          continue;
        }
      } else {
        writeFileSync(t.path, renderCfgMermaid(t.fn, { merge: opts.merge !== false }) + "\n", "utf-8");
      }
      written.push(t.path);
    } catch (err) {
      errors.push(`写出失败 ${t.path}: ${String(err instanceof Error ? err.message : err)}`);
    }
  }
  return { written, errors };
}

/** typed 目标解析:file 相对路径;波浪号自展(非 shell 调用形态);显式 repo 定向仓;多仓前缀(仓名/首段)自动剥;绝对路径相对化。 */
function resolveTypedTarget(ctx: QueryContext, file: string, repo?: string): { root: string; rel: string } {
  const p = expandTilde(file.replace(/\\/g, "/"));
  if (isAbsolute(p)) {
    const rel = relative(ctx.root, p);
    if (!rel.startsWith("..")) return { root: ctx.root, rel };
    // root 外绝对路径:以文件所在目录为根(只读单文件提取,零写入)
    return { root: dirname(p), rel: basename(p) };
  }
  const firstSeg = p.split("/")[0]!;
  if (repo) {
    const st = ctx.repos.find((s) => s.name === repo);
    const root = st?.root ?? join(ctx.root, repo);
    return { root, rel: p.startsWith(repo + "/") ? p.slice(repo.length + 1) : p };
  }
  const hit = ctx.repos.find((s) => s.name === firstSeg);
  if (hit && ctx.repos.length > 1) return { root: hit.root, rel: p.slice(firstSeg.length + 1) };
  return { root: ctx.root, rel: p };
}

/** vars/tokens 缺文件预检(step-092):deep 层对读取失败只留 `slice(0,80)` 截断理由,ENOENT 完整路径
 * 被拦腰斩断(实测呈现为「open '/home/…/bench)」半截路径,读起来像参数被截断)。这里在读文件前拦:
 * 给完整解析路径 + 仓内同名文件建议(有界走查,只在错误路径付费)。命中返回 miss 输出,未命中返回 null。 */
function typedFileMissing(ctx: QueryContext, root: string, rel: string, query: "vars" | "tokens", json: boolean): QueryOutput | null {
  if (existsSync(join(root, rel))) return null;
  const abs = join(root, rel);
  const hits = suggestSameNameFiles(root, rel);
  const hint = hits.length ? `\n  仓内同名文件(至多列 5): ${hits.join("  ")}\n  可用该相对路径重试。` : "";
  if (json) {
    return {
      text: "",
      miss: true,
      json: { query, root, file: rel, error: `文件不存在: ${abs}(相对路径按 root 解析)`, ...(hits.length ? { suggestions: hits } : {}) },
    };
  }
  return { text: `${rel}: 文件不存在(按 root 解析: ${abs})${hint}`, miss: true };
}

/** 仓内同名文件建议(有界走查:跳隐藏目录/node_modules 等;≤5 命中,且 2 万项 / 1.5s 双预算封顶——
 * 错误路径的体验增强不允许在大仓/慢盘上变成第二次等待)。 */
function suggestSameNameFiles(root: string, rel: string, cap = 5): string[] {
  const target = basename(rel.replace(/\\/g, "/"));
  if (!target || target === "." || target === "..") return [];
  const SKIP = new Set([".git", "node_modules", "dist", ".genie", ".venv", "venv", "__pycache__", "target", ".codesense"]);
  const hits: string[] = [];
  const stack = [root];
  const started = Date.now();
  let visited = 0;
  while (stack.length > 0 && hits.length < cap && visited < 20_000 && Date.now() - started < 1500) {
    const dir = stack.pop()!;
    let list: Dirent[];
    try {
      list = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of list) {
      if (++visited > 20_000 || Date.now() - started >= 1500) break;
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP.has(ent.name) && !ent.name.startsWith(".")) stack.push(abs);
      } else if (ent.name === target) {
        hits.push(relative(root, abs));
        if (hits.length >= cap) break;
      }
    }
  }
  return hits;
}

/** vars:文件变量类型清单(step-089 P1,逐文件深提取,不依赖索引构建)。
 * locals=true(--locals)扩入函数内注解面(param/parameter/local;F 批收尾)。 */
export async function queryVarsCmd(ctx: QueryContext, file: string, repo: string | undefined, json: boolean, locals = false): Promise<QueryOutput> {
  const { extractTypedSymbols, renderVars } = await import("@lampgenie/code-sense/typed/index");
  const { root, rel } = resolveTypedTarget(ctx, file, repo);
  const missing = typedFileMissing(ctx, root, rel, "vars", json);
  if (missing) return missing;
  const r = await extractTypedSymbols(root, rel);
  if (json) {
    const { varsOf } = await import("@lampgenie/code-sense/typed/index");
    return {
      text: "",
      miss: r.symbols.length === 0,
      json: { query: "vars", root, locals, vars: varsOf(r.symbols, { locals }), ...r },
    };
  }
  return { text: renderVars(r, { locals }), miss: r.symbols.length === 0 };
}

/** tokens:semantic-token JSON 流导出(step-089 P1;--json=全量流,文本面=摘要)。 */
export async function queryTokensCmd(ctx: QueryContext, file: string, repo: string | undefined, json: boolean): Promise<QueryOutput> {
  const { extractTypedSymbols, toSemanticTokens, varsOf } = await import("@lampgenie/code-sense/typed/index");
  const { root, rel } = resolveTypedTarget(ctx, file, repo);
  const missing = typedFileMissing(ctx, root, rel, "tokens", json);
  if (missing) return missing;
  const r = await extractTypedSymbols(root, rel);
  const stream = toSemanticTokens(r);
  if (json) {
    return { text: "", miss: !stream || stream.tokens.length === 0, json: stream ?? { query: "tokens", error: r.degraded?.reason ?? "无 token(不支持的语言)" } };
  }
  if (!stream || stream.tokens.length === 0) {
    return { text: `${rel}: 无 semantic token(${r.degraded?.reason ?? "无带 span 符号"})`, miss: true };
  }
  const byKind = new Map<string, number>();
  for (const t of stream.tokens) byKind.set(t.kind, (byKind.get(t.kind) ?? 0) + 1);
  const kinds = [...byKind.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(", ");
  return {
    text: [
      `${rel}(${stream.language}): ${stream.tokens.length} tokens(${kinds};变量 ${varsOf(r.symbols).length} 个)`,
      `(完整流: codesense tokens ${file} --json——semantic-token JSON,供 UI 语义着色/外部编辑器集成)`,
    ].join("\n"),
    miss: false,
  };
}

/** project:项目底座认知(step-089 P3;骨架现算,LLM purpose 走凭证解析链+指纹缓存)。 */
export async function queryProjectCmd(
  ctx: QueryContext,
  json: boolean,
  opts: { write?: boolean; noLlm?: boolean; refresh?: boolean } = {},
): Promise<QueryOutput> {
  const pp = await import("@lampgenie/code-sense/project-profile");
  let withLlm = false;
  if (!opts.noLlm) {
    const { resolveLlmConfig, makeSenseLlm, makeAskFileLlm } = await import("./llm-config.js");
    const r = resolveLlmConfig();
    if (r) {
      // 凭证在场=自动走 LLM(指纹缓存保护重复调用不重花钱);--no-llm 显式关
      const { setSensingDeps } = await import("@lampgenie/code-sense/sensing/index");
      setSensingDeps({ senseLlm: r.kind === "ask-file" ? makeAskFileLlm(r.dir) : makeSenseLlm(r.cfg) });
      withLlm = true;
    }
  }
  const profile = await pp.queryProjectProfile(ctx.root, { withLlm, refresh: opts.refresh });
  let path: string | undefined;
  if (opts.write) path = pp.writeProjectProfile(ctx.root, profile);
  if (json) {
    return { text: "", miss: false, json: { query: "project", writtenTo: path, ...profile } };
  }
  const text = pp.renderProjectProfile(profile, { stale: false }) + (path ? `\n(已落盘: ${path})` : "");
  return { text, miss: false };
}

/** impact:改动影响面清单(签名/双向闭包/受影响文件/关联测试;--json 给 agent 结构化面)。 */
/** 整仓 code flow(2026-10-26):module/file/function 三层聚合 + 入口/分层/裁剪,
 * 与 `codesense flow` / gateway code_sense action=flow / MCP code_index_flow 同核。 */
export interface FlowCliOptions {
  level?: FlowLevel | "auto";
  scope?: string;
  include?: string;
  exclude?: string;
  maxNodes?: number;
  maxEdges?: number;
  keepIsolated?: boolean;
  includeTests?: boolean;
  includeNonProduct?: boolean;
  target?: string;
  upstream?: number;
  downstream?: number;
  bridges?: boolean;
  processEntries?: boolean;
  graph?: boolean;
  dot?: boolean;
  direction?: FlowDirection;
  legend?: boolean;
}

export interface FlowQueryResult extends QueryOutput {
  flows: { name: string; flow: CodeFlow }[];
}

export function queryFlowCmd(ctx: QueryContext, repo: string | undefined, json: boolean, opts: FlowCliOptions = {}): FlowQueryResult {
  const sts = pickRepos(ctx, repo);
  if (sts.length === 0) {
    return { text: repo ? `未知仓: ${repo}` : "索引尚未就绪", miss: true, flows: [] };
  }
  const flows: { name: string; flow: CodeFlow }[] = [];
  const errors: string[] = [];
  const notesByRepo = new Map<string, Record<string, ModuleNote>>();
  for (const st of sts) {
    const processEntries = opts.processEntries === false
      ? []
      : scanProcessEntriesSync(st.root, st.index, { all: opts.includeNonProduct }).entries;
    try {
      const flow = buildCodeFlow(st.index, {
        level: opts.level ?? "auto",
        ...(opts.scope ? { scope: opts.scope } : {}),
        ...(opts.include ? { include: opts.include } : {}),
        ...(opts.exclude ? { exclude: opts.exclude } : {}),
        ...(opts.maxNodes !== undefined ? { maxNodes: opts.maxNodes } : {}),
        ...(opts.maxEdges !== undefined ? { maxEdges: opts.maxEdges } : {}),
        ...(opts.keepIsolated !== undefined ? { keepIsolated: opts.keepIsolated } : {}),
        ...(opts.includeTests !== undefined ? { includeTests: opts.includeTests } : {}),
        ...(opts.includeNonProduct !== undefined ? { includeNonProduct: opts.includeNonProduct } : {}),
        ...(opts.target ? { target: opts.target } : {}),
        ...(opts.upstream !== undefined ? { upstream: opts.upstream } : {}),
        ...(opts.downstream !== undefined ? { downstream: opts.downstream } : {}),
        ...(opts.bridges !== undefined ? { bridges: opts.bridges } : {}),
        ...(opts.direction ? { direction: opts.direction } : {}),
        processEntries,
      });
      // 模块图节点旁的一句话作用(package.json/README/docstring 优先;推断加 ≈)
      if (flow.level === "module") {
        const mn = moduleNotes(st.root, flow);
        flow.annotations = Object.fromEntries(Object.entries(mn).map(([k, v]) => [k, moduleAnnotationText(v)]));
        notesByRepo.set(st.name, mn);
      }
      flows.push({ name: st.name, flow });
    } catch (err) {
      if (err instanceof FlowTargetError) errors.push(`[${st.name}] ${err.message}`);
      else throw err;
    }
  }
  const stale = sts.some((s) => s.stale) ? "\n(索引可能过期: " + sts.filter((s) => s.stale).map((s) => s.name).join(", ") + ")" : "";
  if (json) {
    return {
      text: "",
      miss: flows.length === 0,
      flows,
      json: {
        query: "flow",
        repos: flows.map(({ name, flow }) => ({
          repo: name,
          flow: codeFlowJson(flow),
          ...(notesByRepo.has(name) ? { moduleNotes: notesByRepo.get(name) } : {}),
          ...(opts.graph ? { mermaid: renderCodeFlowMermaid(flow, { legend: opts.legend }) } : {}),
          ...(opts.dot ? { dot: renderCodeFlowDot(flow, { legend: opts.legend }) } : {}),
        })),
        ...(errors.length ? { errors } : {}),
      },
    };
  }
  const parts = flows.map(({ name, flow }) => {
    const head = sts.length > 1 ? `## ${name}\n` : "";
    const graph = opts.graph === false ? "" : "\n\n" + renderCodeFlowMermaid(flow, { legend: opts.legend });
    const dot = opts.dot ? "\n\n" + renderCodeFlowDot(flow, { legend: opts.legend }) : "";
    return head + renderCodeFlowText(flow) + graph + dot;
  });
  if (errors.length) parts.push("\n" + errors.join("\n"));
  return { text: parts.join("\n\n") + stale, miss: flows.length === 0, flows };
}

export function queryImpactCmd(ctx: QueryContext, name: string, repo?: string, json = false, depth = 2): QueryOutput {
  const sts = pickRepos(ctx, repo);
  const perRepo = sts.map((st) => {
    const r = queryImpact(st.index, name, { depth });
    return { repo: st.name, hit: r.definitions.length > 0, impact: r, text: `[${st.name}] ${renderImpact(r)}` };
  });
  const hits = perRepo.filter((p) => p.hit);
  if (json) {
    return {
      text: "",
      miss: hits.length === 0,
      json: {
        query: "impact", name, depth,
        repos: hits.map((p) => ({ repo: p.repo, ...p.impact })),
        ...(hits.length === 0 ? { error: `未找到符号: ${name}` } : {}),
      },
    };
  }
  if (hits.length === 0) {
    return { text: `未找到符号: ${name}(已查就绪仓: ${sts.map((s) => s.name).join(", ") || "无"})`, miss: true };
  }
  return { text: hits.map((h) => h.text).join("\n---\n"), miss: false };
}

function pickRepos(ctx: QueryContext, repo?: string): RepoState[] {
  if (!repo) return ctx.repos;
  const hit = ctx.repos.filter((s) => s.name === repo);
  if (hit.length > 0) return hit;
  // 注册表回查(2026-10-21 E④):--repo 定向的仓不在当前根的展开集时回查 ~/.codesense/registry.json
  // ——cd 进仓可查而 --repo 报「未知仓」的路由不一致在此收口(dispatchTool 的 repoByName 同款)。
  const reg = loadRegistry().roots.find((e) => e.name === repo);
  if (reg && existsSync(reg.root)) {
    const idx = loadIndex(reg.root);
    if (idx) return [{ root: reg.root, name: reg.name, index: idx, stale: indexStale(reg.root, idx) }];
  }
  return [];
}

/** 符号引用格式化(--json 元数据附带入stderr 的 note 汇聚用)。 */
export function emptyIndexRepos(ctx: QueryContext): string[] {
  return ctx.repos.filter((s) => s.index.nodes.length === 0).map((s) => s.name);
}

export type { C2fIndex, SymbolQueryResult };
