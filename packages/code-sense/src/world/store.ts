/**
 * 世界模型产物落盘与新鲜度。
 * 目的:把 L0 骨架 + L1 模块页**预渲染**成小文件常驻盘上,查询侧只读几 KB,
 * 不再为「看一眼全局」付 86MB 索引的解析成本(经验证 CLI 单命令 8.6–25.6s,索引 read+parse 1.2s,
 * 其余是进程与查询开销;见 docs/world-model-benchmark.md §8)。
 * 产物位置:`<root>/.genie/sense-index/<sha1(root)前12>/world/`
 * - `manifest.json` 产物身份(指纹/字节/token 估算/页表)
 * - `skeleton.md` L0 骨架层(≤ WORLD_L0_MAX_BYTES)
 * - `modules/<slug>.md` L1 模块页(每页 ≤ WORLD_L1_PAGE_MAX_BYTES)
 * **失效判定不加载索引**:只读 meta.json(1KB)+ fp.json(63B)。三条信号:
 * 1. meta.builtAt ≠ manifest.fp.builtAt → 索引已重建,产物落后(stale)
 * 2. meta.extractorVersion ≠ 指纹 → 抽取器换代(stale)
 * 3. fp.json(最近一次完整 walk 的盘上指纹)显示 count/maxMtime 已超构建时值 → 源码在索引后改过(stale)
 * 第 3 条是**尽力而为**:fp.json 只在有人跑过带指纹刷新的查询时才更新,缺席即视为未知(不假装新鲜,
 * 也不假装陈旧——manifest 里 `fp.maxMtime` 缺席时 freshness 记 `unknown-source` 提示)。
 * 本模块只依赖 node:fs / node:path 与类型导入:刻意不 import callgraph/c2f(会拖进 ts-morph),
 * 保证「读世界模型」的路径不背索引构建的依赖。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { indexDir, indexMetaPath, type IndexMeta } from "../callgraph/index-meta.js";
import { fingerprintRecordPath, type FingerprintRecord } from "../callgraph/index-meta.js";
import type { DrillCorpus } from "./drilldown.js";

/** 世界模型产物目录。 */
export function worldDir(root: string): string {
  return join(indexDir(root), "world");
}

export function worldManifestPath(root: string): string {
  return join(worldDir(root), "manifest.json");
}

export function worldSkeletonPath(root: string): string {
  return join(worldDir(root), "skeleton.md");
}

/** 模块名 → 安全文件名(packages/gateway → packages__gateway)。 */
export function moduleSlug(module: string): string {
  const s = module.replace(/[^A-Za-z0-9._-]+/g, "__").replace(/^__+|__+$/g, "");
  return s.length > 0 ? s.slice(0, 96) : "_root";
}

export function worldModulePagePath(root: string, module: string): string {
  return join(worldDir(root), "modules", `${moduleSlug(module)}.md`);
}

/** 产物身份里的索引指纹(只取「变了就得重渲染」的字段)。 */
export interface WorldFingerprint {
  builtAt: number;
  extractorVersion?: number;
  srcCount?: number;
  srcMtime?: number;
}

export interface WorldManifestPage {
  module: string;
  slug: string;
  bytes: number;
}

export interface WorldManifest {
  version: 1;
  root: string;
 /** 渲染时刻(与 fp.builtAt 区分:前者=产物,后者=索引)。 */
  at: number;
  fp: WorldFingerprint;
  renderMs: number;
  bytes: { skeleton: number; pages: number; total: number };
 /** token 估算两档(诚实标口径:都不是真 tokenizer)。 */
  tokens: { chars4: number; cjkAware: number };
 /** 确定性阅读时长估算:minutes = ceil(totalBytes / 500),按 500B/min 技术阅读速度估。 */
  readingTime: { minutes: number };
  pages: WorldManifestPage[];
}

/** 渲染产物(reinterpret:render.ts 的返回值形状,这里用结构化最小依赖避免互相 import 成环)。 */
export interface WorldArtifactInput {
  skeleton: string;
  pages: { module: string; markdown: string; bytes: number }[];
 /** 索引身份(缺省从 meta.json 读;meta 缺席时由调用方给)。 */
  fp?: WorldFingerprint;
  renderMs?: number;
}

export interface WorldFreshness {
 /** fresh=产物与索引同代;stale=需 --rebuild;unknown=缺 meta/manifest,无法判定。 */
  state: "fresh" | "stale" | "unknown";
  reasons: string[];
 /** 产物指纹与当前 meta 的差异摘要(供头行打印)。 */
  indexBuiltAt?: number;
  worldBuiltAt?: number;
}

function readJson<T>(p: string): T | null {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as T;
  } catch {
    return null;
  }
}

export function readWorldManifest(root: string): WorldManifest | null {
  const m = readJson<WorldManifest>(worldManifestPath(root));
  if (!m || m.version !== 1 || !Array.isArray(m.pages)) return null;
  return m;
}

export function readIndexMetaFile(root: string): IndexMeta | null {
  return readJson<IndexMeta>(indexMetaPath(root));
}

function readFpRecord(root: string): FingerprintRecord | null {
  return readJson<FingerprintRecord>(fingerprintRecordPath(root));
}

/** token 估算:CJK 字符按 1.5 char/token、其余按 4 char/token(与 docs 的 chars/4、chars/2.5 两档同源口径)。 */
export function estimateTokens(text: string): { chars4: number; cjkAware: number } {
  const cjk = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
  const other = text.length - cjk;
  return {
    chars4: Math.ceil(text.length / 4),
    cjkAware: Math.ceil(other / 4 + cjk / 1.5),
  };
}

/** 从 meta.json 取指纹(纯读 1KB,不碰 86MB 索引)。 */
export function fingerprintFromMeta(meta: IndexMeta | null): WorldFingerprint | null {
  if (!meta) return null;
  return {
    builtAt: meta.builtAt,
    extractorVersion: meta.extractorVersion,
    srcCount: meta.srcCount,
    srcMtime: meta.srcMtime,
  };
}

/** 写产物(整目录覆盖:先清 modules/ 再写,避免换模块名后残留旧页)。 */
export function writeWorldArtifact(root: string, art: WorldArtifactInput): WorldManifest {
  const dir = worldDir(root);
  const modDir = join(dir, "modules");
  mkdirSync(modDir, { recursive: true });

  const meta = readIndexMetaFile(root);
  const fp = art.fp ?? fingerprintFromMeta(meta);
  if (!fp) {
    throw new Error(
      `缺索引元数据:${indexMetaPath(root)} 不存在——先运行 codesense index 建索引,再 world --rebuild`,
    );
  }

 // 清旧页(manifest 旧表里的文件也一并清,保证目录内只剩本次产物)
  const prev = readWorldManifest(root);
  if (prev) for (const p of prev.pages) rmSync(join(modDir, `${p.slug}.md`), { force: true });

  const pages: WorldManifestPage[] = [];
  let pagesBytes = 0;
  for (const p of art.pages) {
    const slug = moduleSlug(p.module);
    writeFileSync(join(modDir, `${slug}.md`), p.markdown, "utf-8");
    const bytes = Buffer.byteLength(p.markdown, "utf-8");
    pages.push({ module: p.module, slug, bytes });
    pagesBytes += bytes;
  }

  writeFileSync(worldSkeletonPath(root), art.skeleton, "utf-8");
  const skeletonBytes = Buffer.byteLength(art.skeleton, "utf-8");

  const allText = art.skeleton + art.pages.map((p) => p.markdown).join("\n");
  const tokens = estimateTokens(allText);

  const totalBytes = skeletonBytes + pagesBytes;
  const manifest: WorldManifest = {
    version: 1,
    root,
    at: Date.now(),
    fp,
    renderMs: Math.round(art.renderMs ?? 0),
    bytes: { skeleton: skeletonBytes, pages: pagesBytes, total: totalBytes },
    tokens,
 // 按 500B/min 技术阅读速度估:minutes = ceil(totalBytes / 500)(确定性,同字节两跑全等)
    readingTime: { minutes: Math.ceil(totalBytes / 500) },
    pages,
  };
  writeFileSync(worldManifestPath(root), JSON.stringify(manifest, null, 2), "utf-8");
  return manifest;
}

/**
 * 新鲜度判定(**零索引加载**):meta.json + fp.json 两份小文件即可。
 * 不判「源码今天改过但 fp.json 尚未刷新」——那是索引自身的过期问题,由 `--check` 走完整 indexStale 判。
 */
export function worldFreshness(root: string, manifest: WorldManifest | null): WorldFreshness {
  if (!manifest) return { state: "unknown", reasons: ["产物缺失(world/manifest.json 不存在)"] };
  const meta = readIndexMetaFile(root);
  if (!meta) {
    return { state: "unknown", reasons: [`缺索引元数据 meta.json(${indexMetaPath(root)})`], worldBuiltAt: manifest.fp.builtAt };
  }
  const reasons: string[] = [];
  if (meta.builtAt !== manifest.fp.builtAt) {
    reasons.push(`索引已重建(meta.builtAt=${meta.builtAt} ≠ 产指纹 ${manifest.fp.builtAt})`);
  }
  if ((meta.extractorVersion ?? 1) !== (manifest.fp.extractorVersion ?? 1)) {
    reasons.push(`抽取器换代(meta=${meta.extractorVersion ?? 1} ≠ 产指纹 ${manifest.fp.extractorVersion ?? 1})`);
  }
  const fp = readFpRecord(root);
  if (fp && typeof meta.srcMtime === "number") {
    if ((typeof meta.srcCount === "number" && fp.count !== meta.srcCount) || fp.maxMtime > meta.srcMtime) {
      reasons.push(
        `源码在索引后改动过(盘上指纹 ${fp.count} 文件/maxMtime ${Math.round(fp.maxMtime)} > 构建时 ${meta.srcCount} / ${Math.round(meta.srcMtime)})——先 codesense index 再 world --rebuild`,
      );
    }
  }
  const state: WorldFreshness["state"] = reasons.length === 0 ? "fresh" : "stale";
  return { state, reasons, indexBuiltAt: meta.builtAt, worldBuiltAt: manifest.fp.builtAt };
}

/** 头行:产物身份 + 新鲜度。任何读路径都先给这一行(agent 据此决定是否重建)。 */
export function renderWorldHeader(root: string, manifest: WorldManifest | null, fresh: WorldFreshness): string {
  const at = manifest ? new Date(manifest.at).toISOString().replace("T", " ").slice(0, 19) : "(无产物)";
  const idxAt = manifest ? new Date(manifest.fp.builtAt).toISOString().replace("T", " ").slice(0, 19) : "(无)";
  const staleTag =
    fresh.state === "fresh" ? "fresh" : fresh.state === "stale" ? "STALE" : "UNKNOWN";
  const lines = [
    `<!-- world · ${staleTag} · index builtAt=${idxAt} · rendered=${at} · l0=${manifest?.bytes.skeleton ?? 0}B / l1=${manifest?.bytes.pages ?? 0}B · tokens≈${manifest?.tokens.chars4 ?? 0}(@4) / ${manifest?.tokens.cjkAware ?? 0}(CJK-aware) -->`,
  ];
  if (fresh.state !== "fresh") {
    lines.push(`> ⚠ 世界模型${fresh.state === "stale" ? "陈旧" : "无法判定新鲜度"}:${fresh.reasons.join(";")}`);
    lines.push(`> 修复:\`codesense world --rebuild\`(索引本身过期时先 \`codesense index\`)`);
  }
  return lines.join("\n");
}

export interface WorldSkeletonRead {
  manifest: WorldManifest | null;
  text: string | null;
  fresh: WorldFreshness;
  header: string;
}

/** 读 L0(不加载索引)。 */
export function readWorldSkeleton(root: string): WorldSkeletonRead {
  const manifest = readWorldManifest(root);
  const fresh = worldFreshness(root, manifest);
  const p = worldSkeletonPath(root);
  const text = existsSync(p) ? readFileSync(p, "utf-8") : null;
  return { manifest, text, fresh, header: renderWorldHeader(root, manifest, fresh) };
}

export interface WorldModuleRead {
  module: string;
  text: string;
  manifestPage: WorldManifestPage | null;
}

/** 读单个 L1 模块页(不加载索引;模块名可给 name 或 slug)。 */
export function readWorldModulePage(root: string, module: string): WorldModuleRead | null {
  const manifest = readWorldManifest(root);
  const slug = moduleSlug(module);
  const page = manifest?.pages.find((p) => p.module === module || p.slug === slug) ?? null;
  const p = join(worldDir(root), "modules", `${page?.slug ?? slug}.md`);
  if (!existsSync(p)) return null;
  return { module: page?.module ?? module, text: readFileSync(p, "utf-8"), manifestPage: page };
}

/** 产物里的模块名清单(读 manifest,不加载索引)。 */
export function listWorldModules(root: string): string[] {
  return (readWorldManifest(root)?.pages ?? []).map((p) => p.module);
}

/** 下钻语料文件(模块 × 职责/目录/文件名/符号名;机器面,不进注入面)。 */
export function drillCorpusPath(root: string): string {
  return join(worldDir(root), "drill.json");
}

export function readDrillCorpus(root: string): DrillCorpus | null {
  const c = readJson<DrillCorpus>(drillCorpusPath(root));
  if (!c || c.version !== 1 || !Array.isArray(c.modules)) return null;
  return c;
}

export function writeDrillCorpus(root: string, corpus: DrillCorpus): void {
  mkdirSync(worldDir(root), { recursive: true });
  writeFileSync(drillCorpusPath(root), JSON.stringify(corpus), "utf-8");
}
