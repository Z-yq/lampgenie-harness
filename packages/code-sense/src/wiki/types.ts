/**
 * wiki(step-118):repo wiki 的类型与常量。
 *
 * 定位:持久、可导航、可引用的仓库 wiki(给人看 + 给 agent 读)。事实/行号/图确定性;
 * LLM 仅写叙述,且每条叙述必须带可回查的 file:line anchor(无据不写)。
 * 红线(designs/16):不引入 embedding/向量库;Q&A 走既有 code_index/grep。
 */
import { join } from "node:path";

/** 生成器版本:页面结构/图规则变化时 +1(参与 inputHash;否则旧 manifest 会命中过期页)。 */
export const WIKI_GENERATOR_VERSION = 15;

export type WikiPageKind =
  | "overview" | "file-tree" | "modules" | "entrypoints" | "dependencies"
  // 2026-10-26:整仓 code flow 落档 + 由 flow 派生的语义指南/功能拆解
  | "flow" | "flow-module" | "guide" | "features"
  // 2026-10-27:管线关键函数语句级流程图
  | "algo";
export type WikiPageSection =
  | "overview" | "structure" | "modules" | "entrypoints" | "graph"
  | "flow" | "guide" | "features" | "algo";
export type WikiGenerator = "deterministic" | "llm+validated";

/** 行号引用:file 必须相对仓库根;anchor 必须在 [startLine,endLine] 内逐字出现。 */
export interface WikiCitation {
  file: string;
  startLine: number;
  endLine: number;
  anchor: string;
}

/** LLM 叙述(已通过 anchor 回查的段落;无有效引用的段落在生成期被丢弃)。 */
export interface WikiNarrativeSection {
  heading: string;
  body: string;
  cites: WikiCitation[];
}

/** 功能线的 LLM 语义命名(2026-10-26):只改展示名/一句话能力,不改确定性入口/模块/文件清单;
 * cites 必须通过 file:line 回查,id 必须对应 flow 骨架里的功能线 id。 */
export interface WikiNarrativeFeature {
  id: string;
  name: string;
  description: string;
  cites: WikiCitation[];
}

export interface WikiNarrative {
  summary: string;
  sections: WikiNarrativeSection[];
  /** 仅 features 页:功能线 id → 语义名/能力描述(校验后)。 */
  features?: WikiNarrativeFeature[];
  audit?: { checked: number; passed: number; failed: number; droppedSections: number };
}

export interface WikiPageMeta {
  id: string;
  title: string;
  kind: WikiPageKind;
  section: WikiPageSection;
  order: number;
  /** 相对 wiki 目录的 md 路径(如 "overview.md" / "modules/packages-core.md")。 */
  file: string;
  summary: string;
  citations: WikiCitation[];
  /** 模块页:模块名(面板「在结构中查看」跳转到代码档案结构 tab)。 */
  moduleName?: string;
  /** 页面依赖的源文件(增量失效粒度)。 */
  sources: string[];
  generator: WikiGenerator;
  llm: "on" | "off" | "failed";
  bytes: number;
  updatedAt: number;
  /** LLM 页的输入指纹(源码未变时不重复花钱)。 */
  llmInputHash?: string;
}

export interface WikiGraphNode {
  id: string;
  /** 图内短标签(module=去 packages/apps 前缀;file=basename)——保证缩放后字号可读。 */
  label: string;
  kind: "module" | "file";
  /** 原始完整名(module 路径/文件相对路径;边表与下钻用)。 */
  full?: string;
}

export interface WikiGraphEdge {
  from: string;
  to: string;
  label?: string;
  count: number;
  evidence?: { file: string; line: number };
}

export interface WikiGraph {
  scope: "module" | "file";
  mermaid: string;
  nodes: WikiGraphNode[];
  edges: WikiGraphEdge[];
}

/** 功能拆解(由整仓 flow 的入口子图确定性派生;LLM 只在页面里补充语义命名/解读)。 */
export interface WikiFeatureSymbol {
  name: string;
  file: string;
  line: number;
  calls: number;
}

export interface WikiFeatureTrigger {
  name: string;
  kind: string;
  file: string;
  line: number;
  detail?: string;
}

export interface WikiFeature {
  id: string;
  /** 确定性标题(代表触发面);LLM 可在叙述里给语义名,不改事实字段。 */
  title: string;
  /** 2026-10-27 管线簇:一个功能线可有多个触发面(5 个训练脚本共享下游=1 族)。 */
  triggers?: WikiFeatureTrigger[];
  entry: { label: string; kind: string; file?: string; line?: number };
  /** 贪心主干(入口 → … ≤4 跳)。 */
  path: string[];
  /** 下游模块(含入口模块,BFS ≤3 跳)。 */
  modules: string[];
  /** 该功能线触及的关键文件(带调用量排序)。 */
  files: string[];
  /** 关键函数(索引在场时;file:line 可回查)。 */
  symbols: WikiFeatureSymbol[];
  /** 子图内的模块级边。 */
  edges: { from: string; to: string; count: number }[];
  reach: number;
  /** 单功能线 mermaid(确定性,filterCodeFlow + renderCodeFlowMermaid)。 */
  mermaid: string;
}

/** manifest 里的 flow 摘要(面板/agent 快速消费;完整图在 flow 页 markdown)。 */
export interface WikiFlowSummary {
  source: "index" | "lexical";
  level: string;
  nodes: number;
  edges: number;
  entries: number;
  omittedNodes: number;
  omittedEdges: number;
  unresolvedCalls: number;
  bridgeEdges: number;
  features: WikiFeature[];
  notes: string[];
}

export interface WikiCitationAudit {
  checked: number;
  passed: number;
  failed: number;
  droppedSections: number;
}

export interface WikiDegraded {
  layer: string;
  reason: string;
  howToActivate: string;
}

export interface WikiLlmInfo {
  enabled: boolean;
  model?: string;
  /** 实际走 LLM 的页 id。 */
  pages: string[];
  failed: number;
}

export interface WikiManifest {
  version: 1;
  generatorVersion: number;
  repo: string;
  generatedAt: number;
  /** git HEAD sha(非 git/读取失败=空串,失效退化为输入指纹)。 */
  gitHead: string;
  /** 配置 + 全文件 (path:mtimeMs:size) 的 sha256。 */
  inputHash: string;
  files: Record<string, string>;
  config: WikiConfig;
  llm: WikiLlmInfo;
  pages: WikiPageMeta[];
  graphs: WikiGraph[];
  citationAudit: WikiCitationAudit;
  degraded: WikiDegraded[];
  /** 2026-10-26:整仓 code flow 摘要(旧 manifest 无此字段=旧版本生成)。 */
  flow?: WikiFlowSummary;
}

export interface WikiConfig {
  /** 模块页上限(文件数 top N)。 */
  maxModules: number;
  /** LLM 叙述页上限(overview + top 模块页);成本护栏。 */
  maxLlmPages: number;
  /** 单页文件清单上限。 */
  maxFilesPerPage: number;
  /** 单页 LLM 摘录字符上限。 */
  maxExcerptChars: number;
  /** 文件树深度。 */
  treeDepth: number;
  /** 单页 LLM 调用超时(ms)。 */
  llmTimeoutMs: number;
  /** 依赖扫描文件上限(大仓护栏;超出如实登记降级)。 */
  maxScanFiles: number;
  /** 每个模块页关键符号上限。 */
  maxSymbols: number;
  /** 功能拆解条数上限(入口 flow 数)。 */
  maxFeatures: number;
  /** 全仓/模块 file 级 flow 的节点预算(0=不设上限,诚实全量;2026-10-27 用户口径)。 */
  maxFlowFiles: number;
}

export const DEFAULT_WIKI_CONFIG: WikiConfig = {
  maxModules: 8,
  maxLlmPages: 4,
  maxFilesPerPage: 20,
  maxExcerptChars: 12_000,
  treeDepth: 3,
  llmTimeoutMs: 90_000,
  maxScanFiles: 3_000,
  maxSymbols: 12,
  maxFeatures: 8,
  maxFlowFiles: 0,
};

export interface WikiLlm {
  generate(prompt: string): Promise<string>;
}

export interface WikiRebuildOptions {
  /** 忽略 sha/指纹缓存,全页重建(LLM 页重新调用)。 */
  refresh?: boolean;
  /** 注入 LLM;缺省=仅确定性骨架(显式降级)。 */
  llm?: WikiLlm;
  /** 仅用于 manifest 记录(脱敏,不含凭证)。 */
  llmModel?: string;
  /** false=即使注入了 LLM 也不调用(强制确定性)。 */
  withLlm?: boolean;
  /** 调用方显式关 LLM(CLI: 用户传了 --no-llm)。仅显式场景 + refresh 才允许降级覆盖既有 LLM 页。 */
  explicitNoLlm?: boolean;
  /** false=不生成 flow/guide/features 页(旧行为/快速重建)。 */
  flow?: boolean;
  config?: Partial<WikiConfig>;
}

export interface WikiRebuildResult {
  manifest: WikiManifest;
  hit: boolean;
  reason: string;
  rebuilt: string[];
  reused: string[];
  removed: string[];
  llmCalls: number;
  durationMs: number;
  /** 必须展示给用户的显著告警(如「LLM 页被保留」);CLI 不得吞掉。 */
  warnings?: string[];
}

export interface WikiListResult {
  repo: string;
  dir: string;
  exists: boolean;
  manifest: WikiManifest | null;
}

/** wiki 目录:.genie/wiki/<repo>/(repo=sanitized basename)。 */
export function wikiRepoName(root: string): string {
  const base = root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "repo";
  return base.replace(/[^A-Za-z0-9._-]/g, "_") || "repo";
}

export function wikiDir(root: string): string {
  return join(root, ".genie", "wiki", wikiRepoName(root));
}

export function wikiPath(root: string, file: string): string {
  return join(wikiDir(root), file);
}

export function normalizeConfig(partial?: Partial<WikiConfig>): WikiConfig {
  const cfg = { ...DEFAULT_WIKI_CONFIG, ...(partial ?? {}) };
  const int = (v: number, min: number, max: number, dflt: number) =>
    Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : dflt;
  return {
    maxModules: int(cfg.maxModules, 1, 40, DEFAULT_WIKI_CONFIG.maxModules),
    maxLlmPages: int(cfg.maxLlmPages, 0, 40, DEFAULT_WIKI_CONFIG.maxLlmPages),
    maxFilesPerPage: int(cfg.maxFilesPerPage, 5, 200, DEFAULT_WIKI_CONFIG.maxFilesPerPage),
    maxExcerptChars: int(cfg.maxExcerptChars, 2_000, 80_000, DEFAULT_WIKI_CONFIG.maxExcerptChars),
    treeDepth: int(cfg.treeDepth, 1, 8, DEFAULT_WIKI_CONFIG.treeDepth),
    llmTimeoutMs: int(cfg.llmTimeoutMs, 5_000, 300_000, DEFAULT_WIKI_CONFIG.llmTimeoutMs),
    maxScanFiles: int(cfg.maxScanFiles, 50, 20_000, DEFAULT_WIKI_CONFIG.maxScanFiles),
    maxSymbols: int(cfg.maxSymbols, 3, 80, DEFAULT_WIKI_CONFIG.maxSymbols),
    maxFeatures: int(cfg.maxFeatures, 1, 20, DEFAULT_WIKI_CONFIG.maxFeatures),
    maxFlowFiles: int(cfg.maxFlowFiles, 0, 2000, DEFAULT_WIKI_CONFIG.maxFlowFiles),
  };
}
