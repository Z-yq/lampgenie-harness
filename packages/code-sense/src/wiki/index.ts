/**
 * wiki 编排层:生成/增量重建/读取/词法问答。
 * 存储:.genie/wiki/<repo>/manifest.json + <page>.md
 * 缓存:git sha + 输入指纹(全文件 mtime:size);sha 变→git diff 求变更集→只重建受影响页。
 * 红线:不做 embedding/向量库;问答=wiki 页面词法检索 + 既有 grepIn(code_index/grep 面)。
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { grepIn, normalizeQuery } from "../search";
import { CJK_STOPWORDS, segmentCjkRun } from "../retrieval/cjk";
import { recallSymbols, type SymbolCandidate } from "../retrieval/symbol-recall";
import { generateNarrative } from "./narrative";
import {
  buildDependencies, buildEntrypoints, buildFileTree, buildModulePage, buildOverview,
  slugify, type PageDraft,
} from "./pages";
import { loadWikiFlow, type WikiFlowBundle } from "./flow-source";
import { buildFeaturesPage, buildFlowPage, buildGuidePage, buildModuleFlowPage, buildPipelineCfgPage } from "./flow-pages";
import { buildGraphs, scanWikiInputs, SourceCache, validateCitation, type WikiInput } from "./scan";
import {
  normalizeConfig, wikiDir, wikiPath, wikiRepoName, WIKI_GENERATOR_VERSION,
  type WikiCitation, type WikiConfig, type WikiManifest, type WikiPageMeta,
  type WikiRebuildOptions, type WikiRebuildResult, type WikiListResult,
} from "./types";

const execFileP = promisify(execFile);

interface PlannedPage {
  id: string;
  title: string;
  kind: "overview" | "file-tree" | "modules" | "entrypoints" | "dependencies" | "flow" | "flow-module" | "guide" | "features" | "algo";
  wide: boolean;
  sources: string[];
  moduleName?: string;
  /** algo 页:对应 bundle.cfgs 的管线 id。 */
  cfgId?: string;
}

function planPages(input: WikiInput, config: WikiConfig, flow?: WikiFlowBundle | null): PlannedPage[] {
  const mods = [...input.modules]
    .map((m) => ({ m, files: input.moduleFiles.get(m.name) ?? [] }))
    .filter((x) => x.files.length > 0)
    .sort((a, b) => b.files.length - a.files.length || a.m.name.localeCompare(b.m.name))
    .slice(0, config.maxModules);
  const flowPages: PlannedPage[] = flow
    ? [
      { id: "flow", title: "全仓代码流", kind: "flow", wide: true, sources: flow.llmFiles },
      ...flow.moduleNames.map((name) => ({
        id: `flow/${slugify(name)}`, title: `模块 ${name} · 文件级 flow`, kind: "flow-module" as const,
        wide: true, sources: input.moduleFiles.get(name) ?? [], moduleName: name,
      })),
      { id: "guide", title: "语义级代码指南", kind: "guide", wide: true, sources: flow.llmFiles },
      { id: "features", title: "功能拆解", kind: "features", wide: true, sources: flow.featureFiles },
      ...flow.cfgs.map((c) => ({
        id: `cfg/${c.pipelineId}`, title: `管线 ${c.title} · 关键流程图`, kind: "algo" as const,
        wide: true, sources: [...new Set(c.functions.map((f) => f.file))], cfgId: c.pipelineId,
      })),
    ]
    : [];
  return [
    { id: "overview", title: `${input.repo} 仓库概览`, kind: "overview", wide: true, sources: [] },
    ...flowPages,
    { id: "file-tree", title: "文件树", kind: "file-tree", wide: true, sources: [] },
    ...mods.map(({ m, files }) => ({
      id: `modules/${slugify(m.name)}`, title: `模块 ${m.name}`, kind: "modules" as const,
      wide: false, sources: files, moduleName: m.name,
    })),
    { id: "entrypoints", title: "入口与运行", kind: "entrypoints", wide: true, sources: [] },
    { id: "dependencies", title: "依赖图", kind: "dependencies", wide: true, sources: [] },
  ];
}

async function gitChangedFiles(root: string, oldSha: string, newSha: string): Promise<string[] | null> {
  if (!oldSha || !newSha || oldSha === newSha) return null;
  try {
    const { stdout } = await execFileP("git", ["-C", root, "diff", "--name-only", oldSha, newSha], { maxBuffer: 16 * 1024 * 1024 });
    return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return null; // 非 git/浅克隆/历史缺失:退化为指纹 diff
  }
}

function fingerprintChanged(prev: Record<string, string>, cur: Record<string, string>): string[] {
  const changed = new Set<string>();
  for (const [f, fp] of Object.entries(cur)) if (prev[f] !== fp) changed.add(f);
  for (const f of Object.keys(prev)) if (!(f in cur)) changed.add(f);
  return [...changed];
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data, "utf-8");
  await rename(tmp, path);
}

export async function readWikiManifest(root: string): Promise<WikiManifest | null> {
  try {
    const raw = await readFile(wikiPath(root, "manifest.json"), "utf-8");
    const m = JSON.parse(raw) as WikiManifest;
    if (!m || m.version !== 1 || !Array.isArray(m.pages)) return null;
    return m;
  } catch {
    return null;
  }
}

/** 大文件优先(LLM 摘录/符号提取的性价比选择)。 */
async function largestFiles(cache: SourceCache, files: string[], n: number): Promise<string[]> {
  const sized: { file: string; lines: number }[] = [];
  for (const f of files) sized.push({ file: f, lines: await cache.lineCount(f) });
  return sized.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file)).slice(0, n).map((x) => x.file);
}

function overviewLlmFiles(input: WikiInput, moduleFiles: string[]): string[] {
  const readme = ["README.md", "README.MD", "readme.md", "README.rst"].find((f) => input.allFiles.includes(f));
  return [...new Set([
    ...(readme ? [readme] : []),
    ...input.hints.identity.map((x) => x.file),
    ...input.hints.entryFiles.slice(0, 4).map((x) => x.file),
    ...moduleFiles.slice(0, 4),
  ])].slice(0, 6);
}

export async function rebuildWiki(root: string, opts: WikiRebuildOptions = {}): Promise<WikiRebuildResult> {
  const started = Date.now();
  const config = normalizeConfig(opts.config);
  const repo = wikiRepoName(root);
  const dir = wikiDir(root);
  const input = await scanWikiInputs(root, config, repo);
  const cache = new SourceCache(root);
  const prev = await readWikiManifest(root);
  const flowBundle = opts.flow === false ? null : await loadWikiFlow(root, input, { maxFeatures: config.maxFeatures, maxFlowFiles: config.maxFlowFiles });
  if (flowBundle === null && opts.flow !== false) {
    // 无模块/无文件可扫:如实降级,不生成空 flow 页
  }
  const planned = planPages(input, config, flowBundle);
  const llm = opts.llm;
  const llmEnabled = !!llm && opts.withLlm !== false && config.maxLlmPages > 0;
  // 缓存键必须含 LLM 模式与模型:否则 --no-llm 会命中 LLM 产物、LLM 轮会命中确定性骨架。
  const effectiveHash = createHash("sha256")
    .update(JSON.stringify({
      input: input.inputHash,
      llm: llmEnabled,
      model: opts.llmModel ?? "",
      // flow 开关参与缓存键:否则 --no-flow 之后不带开关重建会命中无 flow 页的旧 manifest。
      flow: opts.flow !== false,
    }))
    .digest("hex");

  const allIds = planned.map((p) => p.id);
  if (prev && !opts.refresh && prev.generatorVersion === WIKI_GENERATOR_VERSION && prev.gitHead === input.gitHead && prev.inputHash === effectiveHash) {
    const kept = prev.pages.filter((p) => p.generator === "llm+validated").map((p) => p.id);
    const hitWarnings = !llmEnabled && kept.length > 0
      ? [`LLM 页 ${kept.length} 页保留(无凭证;--refresh --no-llm 才会降级覆盖)`]
      : [];
    return {
      manifest: prev, hit: true, reason: "git sha + 输入指纹 + LLM 模式一致(零生成)",
      rebuilt: [], reused: allIds, removed: [], llmCalls: 0, durationMs: Date.now() - started,
      ...(hitWarnings.length > 0 ? { warnings: hitWarnings } : {}),
    };
  }

  // 变更集:git diff(提交间)+ 指纹 diff(未提交/非 git)取并集
  const changed = new Set<string>();
  if (prev) {
    const gitChanged = await gitChangedFiles(root, prev.gitHead, input.gitHead);
    if (gitChanged) for (const f of gitChanged) changed.add(f);
    for (const f of fingerprintChanged(prev.files, input.files)) changed.add(f);
  } else {
    for (const f of Object.keys(input.files)) changed.add(f);
  }
  const changedArr = [...changed];

  const llmPages = new Set<string>();
  if (llmEnabled && config.maxLlmPages > 0) {
    const budget = config.maxLlmPages;
    llmPages.add("overview");
 // 语义指南/功能拆解优先(它们消费 code flow 骨架);剩余预算给模块页。
    // 预算必须严格生效(--pages 1 的既有测试/成本护栏都按「最多 N 页 LLM」算)。
    if (flowBundle && llmPages.size < budget) llmPages.add("guide");
    if (flowBundle && llmPages.size < budget) llmPages.add("features");
    for (const p of planned) {
      if (p.kind === "modules" && llmPages.size < budget) llmPages.add(p.id);
    }
  }

  const pages: WikiPageMeta[] = [];
  const rebuilt: string[] = [];
  const reused: string[] = [];
  const removed: string[] = [];
  let llmCalls = 0;
  let llmFailed = 0;
  let droppedSections = 0;
  const llmOnPages: string[] = [];
  const graphs = buildGraphs(input, config);

  const prevById = new Map<string, WikiPageMeta>((prev?.pages ?? []).map((p) => [p.id, p]));
  const moduleFileMap = new Map<string, string[]>();
  for (const p of planned) if (p.moduleName) moduleFileMap.set(p.id, p.sources);
  // 生成器版本/LLM 模式/模型变化:所有页失效(与 source 增量正交)。
  const generatorStale = !!prev && prev.generatorVersion !== WIKI_GENERATOR_VERSION;
  // 降级保护:上一次是 LLM 模式(或存在 LLM 产物页),本次 LLM 关闭且非「显式 --no-llm + refresh」
  // → 既有 LLM 页保留(不失效、不重生成、md 逐字不变),避免无凭证时静默覆盖付费内容。
  const prevHadLlm = !!prev && (prev.llm.enabled || prev.pages.some((p) => p.generator === "llm+validated"));
  const allowDowngrade = opts.refresh === true && opts.explicitNoLlm === true;
  const protectLlmPages = prevHadLlm && !llmEnabled && !allowDowngrade;
  const llmModeStale = !!prev && prev.llm.enabled !== llmEnabled && !protectLlmPages;
  const modelStale = !!prev && !protectLlmPages && (prev.llm.model ?? "") !== (llmEnabled ? (opts.llmModel ?? "") : "");
  const protectedIds: string[] = [];
  const degraded: WikiManifest["degraded"] = [];
  // 保护生效时不登记「仅生成确定性骨架」(会误导:LLM 页其实还在);改由保护告警登记。
  if (!llmEnabled && !protectLlmPages) {
    degraded.push({
      layer: "llm",
      reason: opts.withLlm === false ? "调用方显式关闭 LLM(withLlm=false)" : "未注入 LLM;仅生成确定性骨架",
      howToActivate: "配置 GENIE_LLM_BASE_URL/MODEL/API_KEY(或 codesense config set llm.*);面板走 gateway 主 LLM",
    });
  }
  if (input.scanTruncated.scanned < input.scanTruncated.total) {
    degraded.push({
      layer: "scan",
      reason: `依赖扫描上限 ${config.maxScanFiles}:${input.scanTruncated.scanned}/${input.scanTruncated.total} 个源文件参与 import 扫描`,
      howToActivate: "提高 config.maxScanFiles / GENIE_SENSE_MAX_FILES",
    });
  }

  for (const plan of planned) {
    const old = prevById.get(plan.id);
    const oldMd = old ? await exists(join(dir, old.file)) : false;
    const affected = generatorStale || llmModeStale || modelStale || !prev || opts.refresh || plan.wide || !old || !oldMd || plan.sources.some((f) => changed.has(f));
    // LLM 页保护:即便 refresh/wide/源码变更导致 affected,也原样保留(仅 md 在场时)。
    if (protectLlmPages && old && oldMd && old.generator === "llm+validated") {
      const markdown = await readFile(join(dir, old.file), "utf-8");
      pages.push({ ...old, bytes: Buffer.byteLength(markdown, "utf-8") });
      reused.push(plan.id);
      protectedIds.push(plan.id);
      llmOnPages.push(plan.id);
      continue;
    }
    if (!affected && old) {
      const markdown = await readFile(join(dir, old.file), "utf-8");
      pages.push({ ...old, bytes: Buffer.byteLength(markdown, "utf-8") });
      reused.push(plan.id);
      // manifest 的 llm.pages 是「当前产物中由 LLM 生成的页」,复用页也要登记(否则只报本轮新生成)。
      if (old.generator === "llm+validated" && old.llm === "on") llmOnPages.push(plan.id);
      continue;
    }

    let page: PageDraft | null = null;
    let narrativeErr: string | undefined;
    if (llmEnabled && llm && llmPages.has(plan.id)) {
      const files = plan.kind === "overview"
        ? overviewLlmFiles(input, [...new Set([...moduleFileMap.values()].flat())])
        : plan.kind === "guide"
          ? (flowBundle?.llmFiles ?? [])
          : plan.kind === "features"
            ? (flowBundle?.featureFiles.length ? flowBundle.featureFiles : flowBundle?.llmFiles ?? [])
            : await largestFiles(cache, plan.sources, 6);
      const flowContext = (plan.kind === "guide" || plan.kind === "features") ? flowBundle?.llmContext : undefined;
      const out = await generateNarrative({
        input, cache, config, llm, title: plan.title,
        kind: plan.kind, files,
        ...(plan.moduleName ? { moduleName: plan.moduleName } : {}),
        ...(flowContext ? { flowContext } : {}),
      });
      llmCalls += out.calls;
      droppedSections += out.audit.droppedSections;
      if (out.narrative) {
        llmOnPages.push(plan.id);
        if (plan.kind === "overview") page = await buildOverview(input, cache, config, out.narrative);
        else if (plan.kind === "modules" && plan.moduleName) page = await buildModulePage(input, cache, config, plan.moduleName, out.narrative);
        else if (plan.kind === "guide" && flowBundle) page = await buildGuidePage(input, cache, config, flowBundle, out.narrative);
        else if (plan.kind === "features" && flowBundle) page = await buildFeaturesPage(input, cache, config, flowBundle, out.narrative);
      } else {
        llmFailed++;
        narrativeErr = out.error ?? "LLM 叙述失败";
        degraded.push({
          layer: "llm", reason: `${plan.id}: ${narrativeErr}`,
          howToActivate: "检查模型端点/凭证;可 codesense wiki rebuild --no-llm 走确定性骨架",
        });
      }
    }
    if (!page) {
      if (plan.kind === "overview") page = await buildOverview(input, cache, config);
      else if (plan.kind === "file-tree") page = await buildFileTree(input, cache, config);
      else if (plan.kind === "entrypoints") {
        const KIND_RANK: Record<string, number> = { process: 0, root: 1, "http-write": 2, ws: 3 };
        const runnable = flowBundle?.surfaces
          ? flowBundle.surfaces.inSurfaces
            .map((e) => ({
              name: e.name,
              kindLabel: e.kind === "process" ? "进程/CLI 入口" : e.kind === "ws" ? "WebSocket 端点" : e.kind === "root" ? "组合根(启动装配)" : "HTTP 写端点",
              file: e.file, line: e.line, ...(e.detail ? { detail: e.detail } : {}),
              rank: KIND_RANK[e.kind] ?? 9,
            }))
            .sort((a, b) => a.rank - b.rank || a.file.localeCompare(b.file) || a.line - b.line)
            .map(({ rank: _rank, ...rest }) => rest)
          : undefined;
        page = await buildEntrypoints(input, cache, config, runnable);
      }
      else if (plan.kind === "dependencies") page = await buildDependencies(input, cache, config, graphs);
      else if (plan.kind === "flow" && flowBundle) page = await buildFlowPage(input, cache, config, flowBundle);
      else if (plan.kind === "flow-module" && plan.moduleName && flowBundle) {
        const mf = flowBundle.moduleFlows[plan.moduleName];
        if (mf) page = await buildModuleFlowPage(input, cache, config, plan.moduleName, mf, flowBundle);
      } else if (plan.kind === "guide" && flowBundle) page = await buildGuidePage(input, cache, config, flowBundle);
      else if (plan.kind === "features" && flowBundle) page = await buildFeaturesPage(input, cache, config, flowBundle);
      else if (plan.kind === "algo" && flowBundle && plan.cfgId) {
        const cfg = flowBundle.cfgs.find((c) => c.pipelineId === plan.cfgId);
        if (cfg) page = await buildPipelineCfgPage(input, cache, config, cfg);
      }
      else if (plan.moduleName) page = await buildModulePage(input, cache, config, plan.moduleName);
    }
    if (!page) continue;
    if (narrativeErr) page.llm = "failed";
    await writeAtomic(join(dir, page.file), page.markdown);
    const meta: WikiPageMeta = {
      id: page.id, title: page.title, kind: page.kind, section: page.section, order: page.order,
      file: page.file, summary: page.summary, citations: page.citations, sources: page.sources,
      ...(page.moduleName ? { moduleName: page.moduleName } : {}),
      generator: page.generator, llm: page.llm, bytes: Buffer.byteLength(page.markdown, "utf-8"),
      updatedAt: Date.now(),
      ...(page.generator === "llm+validated"
        ? { llmInputHash: createHash("sha256").update(JSON.stringify({ inputHash: input.inputHash, id: page.id, sources: page.sources })).digest("hex") }
        : {}),
    };
    pages.push(meta);
    rebuilt.push(plan.id);
    if (page.generator === "llm+validated" && page.sources.length === 0) {
      // 理论上不会发生;防御性记录
      degraded.push({ layer: "llm", reason: `${page.id}: LLM 页 sources 为空`, howToActivate: "重建" });
    }
  }

  // 删除不再计划的旧页
  for (const old of prev?.pages ?? []) {
    if (!planned.some((p) => p.id === old.id)) {
      try {
        await rm(join(dir, old.file), { force: true });
        removed.push(old.id);
      } catch {
        // 删除失败不影响 manifest
      }
    }
  }

  // 引用审计(最终 manifest 的每条引用;确定性引用本应全过,失败必须可见)
  let checked = 0, passed = 0, failed = 0;
  for (const p of pages) {
    for (const c of p.citations) {
      checked++;
      const r = await validateCitation(root, cache, c);
      if (r.ok) passed++;
      else failed++;
    }
  }

  pages.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const warnings: string[] = [];
  if (protectedIds.length > 0) {
    const w = `LLM 页 ${protectedIds.length} 页保留(无凭证;--refresh --no-llm 才会降级覆盖)`;
    warnings.push(w);
    degraded.push({
      layer: "llm",
      reason: w,
      howToActivate: "配置 GENIE_LLM_BASE_URL/MODEL/API_KEY 恢复 LLM 叙述;确认降级请 codesense wiki rebuild --refresh --no-llm",
    });
  }
  const manifest: WikiManifest = {
    version: 1,
    generatorVersion: WIKI_GENERATOR_VERSION,
    repo,
    generatedAt: Date.now(),
    gitHead: input.gitHead,
    inputHash: effectiveHash,
    files: input.files,
    config,
    llm: { enabled: llmEnabled, ...(opts.llmModel ? { model: opts.llmModel } : {}), pages: llmOnPages, failed: llmFailed },
    pages,
    graphs,
    citationAudit: { checked, passed, failed, droppedSections },
    degraded,
    ...(flowBundle ? { flow: flowBundle.summary } : {}),
  };
  await writeAtomic(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  return {
    manifest, hit: false,
    reason: prev ? `增量重建:变更 ${changedArr.length} 个文件` : "首次生成",
    rebuilt, reused, removed, llmCalls, durationMs: Date.now() - started,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export async function listWiki(root: string): Promise<WikiListResult> {
  const manifest = await readWikiManifest(root);
  let ok = false;
  if (manifest && manifest.pages.length > 0) ok = await exists(join(wikiDir(root), manifest.pages[0]!.file));
  return {
    repo: wikiRepoName(root),
    dir: wikiDir(root),
    exists: ok,
    manifest: ok ? manifest : null,
  };
}

export async function getWikiPage(root: string, pageId: string): Promise<{ manifest: WikiManifest; page: WikiPageMeta; markdown: string } | null> {
  const manifest = await readWikiManifest(root);
  if (!manifest) return null;
  const page = manifest.pages.find((p) => p.id === pageId) ?? manifest.pages.find((p) => p.file === pageId);
  if (!page) return null;
  try {
    const markdown = await readFile(join(wikiDir(root), page.file), "utf-8");
    return { manifest, page, markdown };
  } catch {
    return null;
  }
}

// ---- 词法问答(零 embedding:wiki 页打分 + 既有 grepIn) ----

export interface WikiAskPageHit {
  id: string;
  title: string;
  score: number;
  snippet: string;
 /** 页面命中来源:symbol=由符号候选的文件归属补进来的页(符号优先)。 */
  via?: "symbol";
}

export interface WikiAskResult {
  question: string;
  keywords: string[];
  pages: WikiAskPageHit[];
  matches: { file: string; line: number; text: string }[];
  note: string;
 /** 符号优先召回(可选/加性):页面零命中时由符号命中兜底,
   * 并把符号所在文件映射到所属模块页。缺省=索引未就绪或零命中(已降级)。 */
  symbols?: SymbolCandidate[];
  /** 符号召回降级说明(索引未就绪时在场;可用时缺省)。 */
  symbolDegraded?: string;
}

/** 中文切词(停用词+词典最长匹配+滑窗兜底)已迁到 ../search/cjk.ts(纯函数单一真相):
 * wiki 关键词抽取与 explore 符号召回共用同一词表/同一分词口径,不复制(漂移=口径分裂)。 */

export function extractKeywords(question: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const t = raw.trim();
    if (t.length < 2 || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    out.push(t);
  };
  for (const m of question.matchAll(/[A-Za-z_][A-Za-z0-9_.$-]{1,}/g)) {
    for (const v of normalizeQuery(m[0])) add(v);
  }
  for (const m of question.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    segmentCjkRun(m[0], add);
  }
  return out.slice(0, 8);
}

/** grep 命中里的零信息声明行( A):package/import/from-import/#include/using/
 * require("…")/"use strict"——纯导入语句对「哪里实现/怎么用」零贡献,过滤后再截断呈现。 */
const NOISE_DECL_LINE_RE = new RegExp(
  [
    "^\\s*package\\s+[\\w.$]+\\s*;?\\s*$", // Go/Java: package cobra
    "^\\s*import\\s", // TS/Go/Java/Python: import … / import (
    "^\\s*from\\s+[\\w.]+\\s+import\\s", // Python: from mmdet import …
    "^\\s*#include\\s", // C/C++
    "^\\s*using\\s+(?:namespace\\s)?[\\w.]+\\s*;", // C#: using System;
    "^\\s*require\\s*\\(", // JS: require("…")
    '^\\s*["\']use strict["\']',
  ].join("|"),
);

function countOccurrences(hay: string, needle: string): number {  if (!needle) return 0;
  const h = hay.toLowerCase();
  const n = needle.toLowerCase();
  let count = 0;
  let i = 0;
  while ((i = h.indexOf(n, i)) >= 0) {
    count++;
    i += n.length;
  }
  return count;
}

function snippetAround(text: string, needle: string): string {
  const i = text.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return text.replace(/\s+/g, " ").trim().slice(0, 160);
  const start = Math.max(0, i - 60);
  return text.slice(start, i + needle.length + 100).replace(/\s+/g, " ").trim();
}

export async function askWiki(root: string, question: string, opts: { maxMatches?: number } = {}): Promise<WikiAskResult> {
  const keywords = extractKeywords(question);
 // 符号优先召回:与 explore 同源(cjk 分词+词典 → 静态索引打分)。
 // 页面词法检索对中文问句经常 0 命中(「子代理怎么派发」经验证页面无命中),符号命中兜底,
  // 并把符号所在文件映射到所属模块页与源码行。
  const recall = recallSymbols(root, question, { limit: 6, expand: 2 });
  const manifest = await readWikiManifest(root);
  const pages: WikiAskPageHit[] = [];
  if (manifest) {
    for (const p of manifest.pages) {
      let md = "";
      try {
        md = await readFile(join(wikiDir(root), p.file), "utf-8");
      } catch {
        continue;
      }
      let score = 0;
      let snippet = p.summary;
      for (const k of keywords) {
        score += countOccurrences(p.title, k) * 4;
        score += countOccurrences(p.summary, k) * 2;
        score += countOccurrences(md, k);
        if (snippet === p.summary) snippet = snippetAround(md, k);
      }
      if (score > 0) pages.push({ id: p.id, title: p.title, score, snippet: snippet.slice(0, 200) });
    }
  }
  // 符号 → 页面映射:符号所在文件精确归属模块页;无精确页则按目录前缀归属(模块页 sources 覆盖)。
  // 只映射前 3 个符号(页面块不被符号块淹没);已命中的页只加分不重复入列。
  if (manifest && recall.symbols.length > 0) {
    const byId = new Map(pages.map((p) => [p.id, p]));
    for (const sym of recall.symbols.filter((s) => !s.expanded).slice(0, 3)) {
      const page = pageForFile(manifest, sym.file);
      if (!page) continue;
      const boost = Math.max(1, Math.round(sym.score));
      const existing = byId.get(page.id);
      if (existing) {
        existing.score += boost;
        continue;
      }
      const hit: WikiAskPageHit = {
        id: page.id, title: page.title, score: boost,
        snippet: `${sym.name} — ${sym.file}:${sym.line}`, via: "symbol",
      };
      pages.push(hit);
      byId.set(page.id, hit);
    }
  }
  pages.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  let matches: WikiAskResult["matches"] = [];
  if (keywords.length > 0) {
    try {
      const hit = await grepIn(root, keywords.slice(0, 5), { max: opts.maxMatches ?? 30 });
      matches = hit
 // 纯声明行过滤( A):package/import/from-import/#include 对「哪里实现」零贡献
 // (注意:问 cobra flag 校验,命中含「bash_completionsV2_test.go:15 — package cobra」)
        .filter((m) => !NOISE_DECL_LINE_RE.test(m.text))
        .map((m) => ({ file: m.file, line: m.line, text: String(m.text).slice(0, 180) }));
    } catch {
      matches = []; // grep 不可用:页面检索仍可用
    }
  }
  const symbolFallback = pages.length === 0 && recall.symbols.length > 0;
  return {
    question, keywords, pages: pages.slice(0, 5), matches,
    ...(recall.symbols.length ? { symbols: recall.symbols } : {}),
    ...(recall.degraded ? { symbolDegraded: recall.degraded } : {}),
    note: symbolFallback
      ? `页面词法零命中,已由符号优先召回兜底(${recall.symbols.length} 个候选;词法检索零 embedding);深度问答请用既有 code_index_* / code_sense / grep 工具`
      : "词法检索(零 embedding);深度问答请用既有 code_index_* / code_sense / grep 工具",
  };
}

/** 符号文件 → wiki 页:只认模块页(kind=modules)——file-tree 全量收编 657 个文件,
 * 拿它当「所属模块」是假映射;精确 sources 优先,其次同目录前缀。 */
function pageForFile(manifest: WikiManifest, file: string): WikiPageMeta | undefined {
  const modulePages = manifest.pages.filter((p) => p.kind === "modules");
  const exact = modulePages.find((p) => p.sources.includes(file));
  if (exact) return exact;
  const dir = file.split("/").slice(0, -1).join("/");
  if (!dir) return undefined;
  return modulePages.find((p) => p.sources.some((s) => s.startsWith(dir + "/")));
}

/** 页面引用抽检工具(CLI/验收用):逐条回查并返回结果。 */
export async function auditWikiCitations(root: string, pageId?: string): Promise<{
  checked: number; passed: number; failed: number;
  failures: { page: string; file: string; line: number; reason: string }[];
}> {
  const manifest = await readWikiManifest(root);
  const cache = new SourceCache(root);
  const failures: { page: string; file: string; line: number; reason: string }[] = [];
  let checked = 0, passed = 0, failed = 0;
  for (const p of manifest?.pages ?? []) {
    if (pageId && p.id !== pageId) continue;
    for (const c of p.citations) {
      checked++;
      const r = await validateCitation(root, cache, c);
      if (r.ok) passed++;
      else {
        failed++;
        failures.push({ page: p.id, file: c.file, line: c.startLine, reason: r.reason ?? "校验失败" });
      }
    }
  }
  return { checked, passed, failed, failures };
}

export type { WikiCitation, WikiConfig, WikiLlm, WikiManifest, WikiPageMeta } from "./types";
