/**
 * 概念足迹面(surface):一个标识符/概念在全仓「七类表面」上的落点清单。
 * 解决的问题:替换/迁移/下线一个字符串标识(消息名、事件 kind、配置键、面板文案、
 * 静态资源名、测试引用、文档章节)时,symbol/impact 都是空的——只能靠人肉 grep 逐个类别
 * 拼清单,且「改完到底还漏没漏哪一类」无从判定。本模块把它做成一等能力:
 *   扫描 = 复用 retrieval/literal-refs 的 scanLiteralRefs(不另写文件遍历器),
 *   分类 = 纯函数 classifySurfaceHit(file, text) 单测覆盖,
 *   审计 = audit.ts(逐条 resolution:resolved/removed/keep-legacy+理由),
 *   scope = change-scope.ts(「这是不是一次全面替换」的确定性判定,不调 LLM)。
 * 确定性纪律:
 *  - 不调 LLM、不加三方依赖、id 不含时间/随机(`<category>:<file>:<line>:<concepts>`),
 *    同一份输入两跑 id 全等;
 *  - 排除 node_modules/dist/.genie/vendor/.git(直接继承 isExcludedPath / DEFAULT_EXCLUDE_DIRS),
 *    单文件 >1.5MB 与二进制不读(继承 scanLiteralRefs 行为);
 *  - 截断/降级写进 knownLimits,不静默。
 */
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { readdir } from "node:fs/promises";
import { DEFAULT_EXCLUDE_DIRS, isExcludedPath, scanLiteralRefs } from "../retrieval/literal-refs.js";
import { isDocLikePath, isTestPath } from "../path-filter.js";

export type SurfaceCategory =
  | "symbol" | "protocol" | "journal" | "config" | "ui" | "assets"
  | "deploy" | "db" | "i18n" | "tests" | "docs";
export type SurfaceSuggest = "change" | "remove" | "keep-legacy";

/**
 * 渲染/统计的固定顺序(统计头与 markdown 分类计数都按它,避免逐 run 漂移)。
 * 起改为「改动依赖层序」:定义与数据源头在前(protocol/db/journal/config),
 * 代码居中,资源/部署在外围,tests/docs 收尾。顺序即截断优先级——hits 超上限时先丢末位类别,
 * 故「被截断的都是回改面」而不是定义面。与 chain.ts 的 SURFACE_LAYER_ORDER 必须逐字相同
 * (两边各自成字面量:index↔chain 有 re-export 环,若在初始化期求值对方 const 会撞 TDZ;
 * change-chain 测试断言两者相等,防止漂移)。
 */
export const SURFACE_CATEGORIES: readonly SurfaceCategory[] = [
  "protocol", "db", "journal", "config", "symbol", "ui", "assets", "deploy", "i18n", "tests", "docs",
];

export interface SurfaceHit {
  /** 稳定 id:`<category>:<file>:<line>:<concept>`(多 concept 命中同一行时 concept 用逗号连)。 */
  id: string;
  category: SurfaceCategory;
  file: string;
  line: number;
  text: string;
  suggest: SurfaceSuggest;
  concept: string;
}

export interface SurfaceReport {
  root: string;
  concepts: string[];
  hits: SurfaceHit[];
  byCategory: Record<SurfaceCategory, number>;
  /** 遍历过的候选文件数(仅 walk 引擎回报;grep 通道不回该数=缺席,不编造)。 */
  scannedFiles?: number;
  truncated: boolean;
  knownLimits: string[];
}

// ---- 分类(纯函数:先路径后模式) ----

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

/** 媒体/字体类资源扩展名:本身就是资源文件,不看目录也能判成 assets。 */
const MEDIA_EXT_RE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg|mp4|webm|mov|mkv|avi|mp3|wav|ogg|flac|m4a|woff2?|ttf|otf|eot|glb|gltf)$/i;
/** 静态目录里的文本型资源(选择器/文案/清单):落在 assets 目录下即算「资源侧」。 */
const TEXT_ASSET_EXT_RE = /\.(css|scss|sass|less|html?|hbs|ejs|json|webmanifest)$/i;
const ASSET_SEGS = new Set(["assets", "asset", "static", "public", "media", "img", "images", "fonts", "videos"]);
const DOC_SEGS = new Set(["docs", "doc", "designs", "tasks", "devlog"]);
const UI_SEGS = new Set(["panel", "ui", "views", "components", "pages"]);

/** 协议面:仓内 packages/protocol 下的任何命中(消息名/类型/枚举/错误码的单一真相)。 */
function isProtocolPath(p: string): boolean {
  return /^packages\/protocol\//.test(p) || p.includes("/packages/protocol/");
}

/** 配置面(路径类):genie.config*.json / *.schema.ts / .env。 */
function isConfigPath(p: string): boolean {
  return /(^|\/)genie\.config(\.[\w.-]+)?\.json$/.test(p)
    || /\.schema\.ts$/.test(p)
    || /(^|\/)\.env(\.[\w-]+)?$/.test(p);
}

function baseName(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] ?? "";
}

function isAssetPath(p: string): boolean {
  if (MEDIA_EXT_RE.test(p)) return true;
  const segs = p.split("/");
  if (!segs.some((s) => ASSET_SEGS.has(s))) return false;
  return MEDIA_EXT_RE.test(baseName(p)) || TEXT_ASSET_EXT_RE.test(baseName(p));
}

/** 部署/CI 面(路径类):容器、流水线、编排、部署脚本与平台配置。 */
function isDeployPath(p: string): boolean {
  const segs = p.split("/");
  return /(^|\/)Dockerfile(\.[\w-]+)?$/i.test(p)
    || /(^|\/)docker-compose[\w.-]*\.(ya?ml)$/i.test(p)
    || /(^|\/)\.github\/workflows\//.test(p)
    || /(^|\/)\.gitlab-ci\.ya?ml$/i.test(p)
    || /(^|\/)Jenkinsfile$/.test(p)
    || segs.some((s) => s === "k8s" || s === "helm" || s === "charts" || s === "deploy")
    || /(^|\/)scripts\/deploy[\w.-]*$/i.test(p)
    || /(^|\/)(fly\.toml|Procfile|vercel\.json|netlify\.toml|\.dockerignore)$/i.test(p);
}

/** 数据面(路径类):迁移脚本与 schema 是「改列名/删字段」必须同批改的地方。 */
function isDbPath(p: string): boolean {
  const segs = p.split("/");
  return segs.some((s) => s === "migrations" || s === "migration")
    || /\.sql$/i.test(p)
    || /(^|\/)prisma\/schema\.prisma$/.test(p)
    || /(^|\/)db\/schema\.[\w]+$/.test(p)
    || /(^|\/)seed[\w.-]*\.sql$/i.test(p);
}

/** 多语言面(路径类):文案 key 的落点,改文案不改这里就是只改一半。 */
function isI18nPath(p: string): boolean {
  const segs = p.split("/");
  return segs.some((s) => s === "locales" || s === "locale" || s === "i18n" || s === "translations")
    || /(^|\/)messages\/[\w.-]+\.json$/i.test(p)
    || /\.(po|pot)$/i.test(p);
}

/** UI 面(路径类):gateway 面板源码 + apps/<app>/(panel|ui|views|components|pages) 下的视图代码。 */
function isUiPath(p: string): boolean {
  if (/(^|\/)apps\/gateway\/src\/panel[\w.-]*\.(ts|tsx|js|jsx)$/.test(p)) return true;
  return /(^|\/)apps\/[^/]+\/(src\/)?(panel|ui|views|components|pages)\//.test(p);
}

function isDocsPath(p: string): boolean {
  if (isDocLikePath(p)) return true;
  const segs = p.split("/");
  return segs.some((s) => DOC_SEGS.has(s));
}

/** journal 面(模式类):事件 kind 字符串常量的形态。 */
const JOURNAL_RE = /\bkind\s*[:=]|\bkind\s*===?|\bEventKind\b|\bpayload\.type\b|\btype\s*:\s*"[a-z][\w-]*\.(?:kind|event|journal)\b/i;

/** config 面(模式类):环境变量名与 genie 配置键。 */
const CONFIG_RE = /\bprocess\.env\.[A-Za-z_][\w]*|\bGENIE_[A-Z0-9_]+\b|\b[A-Z][A-Z0-9_]{2,}_(URL|PATH|TOKEN|KEY|PORT|HOST|DIR|HOME|ENV|MODE|TIMEOUT|ROOT)\b|\bgenie\.config\b/;

/** 带 UI 选择器/文案形态的行(纯内容判定;路径已能覆盖时不走到这里)。 */
const UI_TEXT_RE = /(^|\s)[.#][\w-]+\s*\{|document\.querySelector|data-testid=|classList\./;

/**
 * 命中分类。**先路径后模式**:路径能定性的一律先判(protocol/config 路径 → tests → docs →
 * assets → ui),剩下才是模式类(journal 事件 kind → config 环境变量/配置键),
 * 最后兜底 symbol(其余源码命中)。理由:路径是「这段文本属于哪个产品表面」的强证据,
 * 一行测试里的 `kind:` 不等于事件表;相反模式只在路径无法定性时才该发声。
 */
export function classifySurfaceHit(file: string, text: string): SurfaceCategory {
  const p = toPosix(file);
  // —— 路径类(强证据,优先级高于模式类)——
  // tests 先于 protocol:packages/protocol/test 下的断言是测试夹具,不是协议定义本身
  // (协议定义在 packages/protocol/src);否则「protocol 面已有命中」会把测试面吞成 0。
  if (isTestPath(p)) return "tests";
  if (isProtocolPath(p)) return "protocol";
  if (isDeployPath(p)) return "deploy";
  if (isDbPath(p)) return "db";
  if (isI18nPath(p)) return "i18n";
  if (isConfigPath(p)) return "config";
  if (isDocsPath(p)) return "docs";
  if (isAssetPath(p)) return "assets";
  if (isUiPath(p)) return "ui";
  // —— 模式类(路径无法定性时才发声;journal 先于 config,与产品口径一致)——
  if (JOURNAL_RE.test(text)) return "journal";
  if (CONFIG_RE.test(text)) return "config";
  if (UI_TEXT_RE.test(text)) return "ui";
  return "symbol";
}

// ---- 路径名通道(二进制/无扩展名资产的内容扫不到,文件名就是落点) ----

/** 路径名匹配的最小 concept 长度:2 字/2 字符在路径里几乎处处命中(ai/os/go),只会淹没真落点。 */
const PATH_NAME_MIN_CONCEPT = 3;
/** 路径名通道的文件数上限:超限如实标 truncated,不静默当零命中。 */
const MAX_PATH_FILES = 50_000;

/**
 * 路径名命中的分类(纯函数,无文件系统)。
 * 为什么需要这条通道:删 `dh-video.mp4` 这类二进制资产时,内容通道恒零命中(二进制不读),
 * 唯一落点是文件名本身;`app-config.yaml`、`.dockerignore` 这类文件也可能不被内容 glob 覆盖。
 * 返回 null=不算路径名命中(concept 太短或不出现),否则给出该路径的类别
 * (媒体/静态目录→assets,部署/数据/多语言路径按各自类别,便于回执按层排序)。
 */
export function classifySurfacePath(relPath: string, concept: string): SurfaceCategory | null {
  const c = (concept ?? "").trim();
  if (c.length < PATH_NAME_MIN_CONCEPT) return null;
  const p = toPosix(relPath);
  if (!p.toLowerCase().includes(c.toLowerCase())) return null;
  return classifySurfaceHit(p, p);
}

/** 仓内文件清单:git 面走 ls-files(继承 .gitignore,整仓毫秒级);非 git 仓退回遍历
 *  (排除口径复用 isExcludedPath,不另立忽略表)。 */
function runGit(root: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", args, { cwd: root, maxBuffer: 128 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolvePromise(String(stdout));
    });
  });
}

async function listRepoFiles(root: string, maxFiles: number): Promise<{ files: string[]; truncated: boolean }> {
  try {
    const stdout = await runGit(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    const files = [...new Set(stdout.split("\0").filter(Boolean).map(toPosix))]
      .filter((f) => !isExcludedPath(f))
      .sort();
    if (files.length > maxFiles) return { files: files.slice(0, maxFiles), truncated: true };
    return { files, truncated: false };
  } catch {
    // 非 git 仓/无 git:自实现遍历(只列文件名,不读内容——二进制资产也要能看见)。
  }
  const files: string[] = [];
  let truncated = false;
  const stack: string[] = [""];
  while (stack.length > 0) {
    const relDir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(relDir ? join(root, relDir) : root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!isExcludedPath(rel)) stack.push(rel);
        continue;
      }
      if (!e.isFile() || isExcludedPath(rel)) continue;
      if (files.length >= maxFiles) {
        truncated = true;
        stack.length = 0;
        break;
      }
      files.push(rel);
    }
  }
  return { files: files.sort(), truncated };
}

/** 缺省建议:一律 change(保守);只有「明确是历史文档章节」才给 keep-legacy。 */
function suggestFor(category: SurfaceCategory, file: string, text: string): SurfaceSuggest {
  if (category !== "docs") return "change";
  const p = toPosix(file);
  const historicPath = /(^|\/)(tasks|designs|devlog)\//.test(p);
  const historicText = /历史|遗留|旧的|旧版|legacy|deprecated|obsolete/i.test(text);
  return historicPath && historicText ? "keep-legacy" : "change";
}

// ---- 扫描 ----

export interface ScanSurfaceOptions {
  maxHits?: number;
  maxPerFile?: number;
  /** 扫描引擎:缺省 grep(与 codesense refs 同源,整仓毫秒级);walk=自实现遍历降级档(千文件仓分钟级)。 */
  engine?: "grep" | "walk";
  /** 路径名通道(缺省开):concept ≥3 字时对文件相对路径做包含匹配,命中给 assets/db/deploy/i18n 等类别。 */
  pathNames?: boolean;
}

interface MergedHit {
  file: string;
  line: number;
  text: string;
  concepts: Set<string>;
}

function emptyByCategory(): Record<SurfaceCategory, number> {
  return Object.fromEntries(SURFACE_CATEGORIES.map((c) => [c, 0])) as Record<SurfaceCategory, number>;
}

export async function scanSurface(
  root: string,
  concepts: string[],
  opts: ScanSurfaceOptions = {},
): Promise<SurfaceReport> {
  const resolvedRoot = resolve(root);
  const maxHits = Math.max(1, opts.maxHits ?? 2000);
  const maxPerFile = Math.max(1, opts.maxPerFile ?? 200);
  const list = [...new Set(concepts.map((c) => c.trim()).filter(Boolean))];
  const knownLimits: string[] = [
    "按字面量出现判定:拼接串/变量中转/模板插值里的概念不识别(refs 层口径)。",
    "代码面含未加引号的标识符出现(变量/类型/import/调用点),不再只认引号字面量;"
    + "判据是词边界整词命中(标识符形态),这类命中统一记 string-literal 语境、按路径+行文本落 symbol 面。",
    `排除 ${DEFAULT_EXCLUDE_DIRS.join("/")}(路径段)与 *.min.js;二进制与 >1.5MB 的单文件不读。`,
    "分类只认路径与行文本形态,不做语义推断:命名不规范的资源/配置可能落到 symbol。",
    "suggest 缺省 change;仅 tasks|designs|devlog 且行内含历史/遗留/旧 的文档命中给 keep-legacy。",
    "路径名通道(concept ≥3 字,大小写不敏感):只看文件名不看内容,二进制资产靠它才发现;"
    + "命中的类别按路径定性(媒体/静态目录→assets,部署/数据/多语言路径→各自层),不一律记 assets。"
    + "文件清单走 git ls-files(继承 .gitignore),非 git 仓退回遍历(复用 isExcludedPath 排除口径)。",
    `单文件命中上限 ${maxPerFile},总命中上限 ${maxHits}。`,
  ];
  if (list.length === 0) {
    knownLimits.unshift("需要至少一个非空 concept。");
    return {
      root: resolvedRoot, concepts: [], hits: [], byCategory: emptyByCategory(),
      scannedFiles: 0, truncated: false, knownLimits,
    };
  }

  const merged = new Map<string, MergedHit>();
  let scannedFiles: number | undefined;
  let truncated = false;
  for (const concept of list) {
    // 默认走 refs 的 grep 通道(与 codesense refs 同源,整仓毫秒级);walk 是降级档,
 // 千级文件的仓会到分钟级(经验证本仓 walk 单概念 ~210s),故只按需开启,并顺带得到 scannedFiles。
    const res = await scanLiteralRefs(resolvedRoot, concept, {
      ...(opts.engine ? { engine: opts.engine } : {}),
      maxHits,
      maxPerFile,
      // 概念足迹要的是「概念出现在哪」,不是「是不是字面量」:未加引号的标识符出现
      // (类型名/函数名/import/调用点)也必须进 symbol 面,否则「替换一个符号」时该面是瞎的。
      includeBare: true,
    });
    if (typeof res.scannedFiles === "number") scannedFiles = Math.max(scannedFiles ?? 0, res.scannedFiles);
    if (res.truncated) truncated = true;
    for (const h of res.hits) {
      const key = `${h.file}:${h.line}`;
      const cur = merged.get(key);
      if (cur) {
        cur.concepts.add(concept);
        continue;
      }
      merged.set(key, { file: h.file, line: h.line, text: h.text, concepts: new Set([concept]) });
    }
  }

  // —— 路径名通道(内容通道看不见的落点:二进制资产、无扩展名文件) ——
  // 文件清单复用 git ls-files / isExcludedPath 排除口径;只匹配名字、不读内容。
  const pathConcepts = list.filter((c) => c.length >= PATH_NAME_MIN_CONCEPT);
  if (pathConcepts.length > 0 && opts.pathNames !== false) {
    const listed = await listRepoFiles(resolvedRoot, MAX_PATH_FILES);
    if (listed.truncated) {
      truncated = true;
      knownLimits.push(`路径名通道列出文件达上限 ${MAX_PATH_FILES},更后面的文件名未匹配(结果偏少,不是零命中)。`);
    }
    for (const file of listed.files) {
      // 与内容命中按 file+line 去重:路径名命中的 line 恒为 0,不会与行命中撞车。
      if (merged.has(`${file}:0`)) continue;
      const matched = pathConcepts.filter((c) => classifySurfacePath(file, c) !== null);
      if (matched.length === 0) continue;
      merged.set(`${file}:0`, { file, line: 0, text: file, concepts: new Set(matched) });
    }
  }

  const hits: SurfaceHit[] = [];
  for (const m of merged.values()) {
    const category = classifySurfaceHit(m.file, m.text);
    // concept 用逗号连(排序后拼接:id 两跑稳定,不受 concept 入参顺序影响)
    const concept = [...m.concepts].sort((a, b) => a.localeCompare(b)).join(",");
    hits.push({
      id: `${category}:${m.file}:${m.line}:${concept}`,
      category,
      file: m.file,
      line: m.line,
      text: m.text,
      suggest: suggestFor(category, m.file, m.text),
      concept,
    });
  }
  const catOrder = new Map(SURFACE_CATEGORIES.map((c, i) => [c, i]));
  hits.sort((a, b) =>
    (catOrder.get(a.category) ?? 99) - (catOrder.get(b.category) ?? 99)
    || a.file.localeCompare(b.file)
    || a.line - b.line
    || a.id.localeCompare(b.id));

  if (hits.length > maxHits) {
    truncated = true;
    const kept = hits.slice(0, maxHits);
    const byCategory = emptyByCategory();
    for (const h of kept) byCategory[h.category]++;
    return { root: resolvedRoot, concepts: list, hits: kept, byCategory, scannedFiles, truncated, knownLimits };
  }

  const byCategory = emptyByCategory();
  for (const h of hits) byCategory[h.category]++;
  return { root: resolvedRoot, concepts: list, hits, byCategory, scannedFiles, truncated, knownLimits };
}

// ---- 渲染 ----

/** markdown 清单:每行 `- [ ] <category> <file>:<line> — <text trimmed 120>` + 分类计数头。 */
export function renderSurfaceMarkdown(r: SurfaceReport): string {
  const lines: string[] = [];
  lines.push(`### 概念足迹 surface — ${r.concepts.join(", ") || "(无 concept)"}`);
  lines.push("");
  lines.push(`root: ${r.root}`);
  lines.push(
    `命中 ${r.hits.length} 行 / 扫描 ${r.scannedFiles ?? "?（grep 通道不回文件数）"} 文件${r.truncated ? "(已截断)" : ""}`
    + ` · 分类计数: ${SURFACE_CATEGORIES.map((c) => `${c} ${r.byCategory[c] ?? 0}`).join(" / ")}`,
  );
  if (r.hits.length === 0) {
    lines.push("");
    lines.push("(零命中:概念可能未出现,或被排除目录过滤;见已知边界)");
  } else {
    lines.push("");
    for (const h of r.hits) {
      const text = h.text.trim().replace(/\s+/g, " ").slice(0, 120);
      // line=0 是路径名命中(没有行号),渲染成裸路径——写成 `file:0` 会被当成「第 0 行」误读。
      lines.push(`- [ ] ${h.category} ${h.line > 0 ? `${h.file}:${h.line}` : h.file} — ${text}`);
    }
  }
  if (r.knownLimits.length > 0) {
    lines.push("");
    lines.push("已知边界:");
    for (const l of r.knownLimits) lines.push(`- ${l}`);
  }
  return lines.join("\n");
}

export { classifyChangeScope } from "./change-scope.js";
export type { ChangeScope, ChangeScopeVerdict } from "./change-scope.js";
export { auditSurface } from "./audit.js";
export type { SurfaceAudit, SurfaceResolution } from "./audit.js";
export { buildSurfaceChainMap, renderSurfaceChainMarkdown, SURFACE_LAYER_ORDER } from "./chain.js";
export type { SurfaceChainEdge, SurfaceChainMap, SurfaceChainNode } from "./chain.js";
