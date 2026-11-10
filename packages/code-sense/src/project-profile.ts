/**
 * project-profile(step-089 P3 / designs/26 §4):项目底座认知——「这个项目大概是干什么的」。
 *
 * 确定性骨架(永不依赖 LLM):README 首段+包清单(package.json/pyproject/go.mod/Cargo/
 * CMakeLists)+框架指纹(imports,grep 字面量)+entrypoints(只读 c2f 索引,缺席=显式降级)
 * +目录拓扑,全部带证据行(白名单锚)。
 *
 * LLM purpose 层(走 P2 凭证解析链,step-077 runSemanticBatch 管线复用):purpose 一句话+
 * 主线能力清单+「改什么会偏离主线」提示,zod+引用回查+修复环 ≤2;无 LLM=显式 degraded,
 * 确定性骨架不冒充语义产物。
 *
 * 存储:.genie/sense-index/profile.json(--write 显式落盘;LLM 产物按指纹缓存,
 * 指纹同=复用不重花钱)。消费方:codesense project / gateway code_index action=project /
 * agent-wiring「项目主线」注入(≤300 字符)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanProject } from "./project";
import { grepMatchesAny } from "./search";
import { indexDir, loadIndex, queryEntryPoints, srcFingerprintCached } from "./callgraph/c2f";
import { scanProcessEntriesSync } from "./sensing/procentries";
import { isNonProductPath, evidenceRank, isTestPath } from "./path-filter";
import { getSensingDeps, runSemanticBatch, type EvidenceAnchor } from "./sensing/semantic";

// ---- 框架指纹(确定性:import 字面量 → 框架名+领域提示) ----

interface FrameworkFingerprint {
  name: string;
  literals: string[];
  domain: string;
  /** true=应用领域框架(web/ml/cv)才参与项目领域判定;工具库(Zod/Cobra/Grafana)
   * 只作依赖事实——把 Zod 判成项目领域会把 schema 校验库抬成主线(2026-10-20 实锤)。 */
  appDomain: boolean;
}

const FRAMEWORKS: FrameworkFingerprint[] = [
  { name: "FastAPI", literals: ["from fastapi", "import fastapi"], domain: "web-backend", appDomain: true },
  { name: "Flask", literals: ["from flask", "import flask"], domain: "web-backend", appDomain: true },
  { name: "Django", literals: ["from django", "import django"], domain: "web-backend", appDomain: true },
  { name: "Express", literals: ['require("express")', "from \"express\"", "import express"], domain: "web-backend", appDomain: true },
  { name: "Next.js", literals: ['from "next', "from 'next", "require(\"next\")"], domain: "web-frontend", appDomain: true },
  { name: "React", literals: ['from "react"', "from 'react'"], domain: "web-frontend", appDomain: true },
  { name: "Vue", literals: ['from "vue"', "from 'vue'"], domain: "web-frontend", appDomain: true },
  { name: "PyTorch", literals: ["import torch", "from torch"], domain: "ml-training", appDomain: true },
  { name: "TensorFlow", literals: ["import tensorflow", "from tensorflow"], domain: "ml-training", appDomain: true },
  { name: "MMDetection", literals: ["import mmdet", "from mmdet"], domain: "ml-vision", appDomain: true },
  { name: "OpenCV", literals: ["import cv2", "opencv2/"], domain: "cv", appDomain: true },
  { name: "Grafana", literals: ["@grafana/"], domain: "observability", appDomain: false },
  { name: "Zod", literals: ['from "zod"', "from 'zod'"], domain: "schema-validation", appDomain: false },
  { name: "Cobra", literals: ["github.com/spf13/cobra"], domain: "cli", appDomain: false },
];

/** 框架指纹扫描面:只扫代码扩展名。文档/任务史里的示例 import 不是依赖证据
 * (此前 glob 含 md,step 文档里一句 `github.com/spf13/cobra` 就把 Cobra 记成能力)。 */
const FRAMEWORK_GLOB = "*.{ts,tsx,js,jsx,mjs,cjs,py,go,java,rs,html,vue,c,cc,cpp,h,hpp}";

/** 非产品主线路径/证据优先级:2026-10-20 迁至 ./path-filter(六面同源单一真相),
 * 此处 re-export 保持既有导入面(测试与下游从 project-profile 取的引用不破)。 */
export { isNonProductPath, evidenceRank, isTestPath } from "./path-filter";

/** 命中行是否真是导入语句(而非指纹表/夹具/文档里的字符串字面量)。
 * 2026-10-20 实锤:project-profile.ts 自己的 FRAMEWORKS 表被 grep 回 12 族框架,
 * lampgenie-harness 因此被判成同时具备 FastAPI/Flask/React/PyTorch/OpenCV 的 web-backend。
 * 证据行必须落在 import/from/require/#include 语境,数据表行(以 { 或引号开头)天然排除。 */
export function isImportContext(file: string, line: string): boolean {
  const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
  if (ext === ".py") return /^(from|import)\s+/.test(line.trim());
  if (ext === ".java") return /^import\s+/.test(line.trim());
  if (ext === ".rs") return /^(use|extern\s+crate)\s+/.test(line.trim());
  if (ext === ".go") return /^import\s+/.test(line.trim()) || /^(?:[\w.]+\s+)?"[^"]+"\s*$/.test(line.trim());
  if (ext === ".c" || ext === ".cc" || ext === ".cpp" || ext === ".h" || ext === ".hpp") return /^#\s*include\b/.test(line.trim());
  // ts/js/vue/html:先剥字符串字面量再判——指纹表里的 'require("express")' 是数据,
  // 不是调用;不剥会把它当成真实 require(2026-10-20 二次实锤)。
  const code = line.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '""');
  const t = code.trim();
  return /^(import|export)\b/.test(t) || /(?:^|[^.\w])require\s*\(/.test(t) || /(?:^|[^.\w])import\s*\(/.test(t);
}

/** 在文件内容里找首个「含字面量且处于导入语境」的行;Go 的 import 块要整文件语境
 * (块内是裸引号行),否则同文件其他裸字符串会被误认。找不到=不是依赖。 */
export function findImportLine(file: string, content: string, literals: string[]): number {
  const lines = content.split("\n");
  const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
  const jsLike = /\.(ts|tsx|js|jsx|mjs|cjs|vue|html)$/i.test(file);
  let inGoImport = false;
  let inTemplate = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const t = line.trim();
    if (ext === ".go") {
      if (/^import\s*\(/.test(t)) { inGoImport = true; continue; }
      if (inGoImport && t === ")") { inGoImport = false; continue; }
    }
    if (jsLike) {
      // 模板字符串里的 Python/JS 片段不是本仓导入(测试夹具 `import torch` 实锤);
      // 跨行模板要跟踪状态,单行含反引号的行也不作证据。
      const ticks = (line.match(/(?<!\\)`/g) ?? []).length;
      if (inTemplate) {
        if (ticks % 2 === 1) inTemplate = false;
        continue;
      }
      if (ticks > 0) {
        if (ticks % 2 === 1) inTemplate = true;
        continue;
      }
    }
    if (!literals.some((lit) => line.includes(lit))) continue;
    if (ext === ".go" && !/^import\s+/.test(t) && !(inGoImport && /^(?:[\w.]+\s+)?"[^"]+"\s*$/.test(t))) continue;
    if (isImportContext(file, line)) return i + 1;
  }
  return 0;
}

// ---- 确定性骨架 ----

export interface EvidenceRef {
  file: string;
  line: number;
}

export interface ProjectProfileSkeleton {
  purposeCandidates: { text: string; source: string; evidence: EvidenceRef }[];
  domain?: string;
  techStack: { language: string; files: number }[];
  frameworks: { name: string; domain: string; evidence: EvidenceRef }[];
  entrypoints?: string[];
  topoNotes: string[];
  /** 构建系统文件(CMake/Make/meson/bazel):加子系统/模块的接线面。旧产物无此字段=未采集。 */
  buildFiles?: { count: number; samples: string[] };
  maturity: string;
  degraded: { layer: string; reason: string }[];
}

const README_CANDIDATES = [
  "README.md", "readme.md", "Readme.md", "README.markdown", "readme.markdown",
  "README.mdx", "README.rst", "README.txt", "README.adoc", "README.org",
];

const LANG_NAV = /(简体中文|繁體中文|中文|english|日本語|한국어|русский|deutsch|español|français|italiano|português|polski|nederlands|türkçe|العربية|ไทย|tiếng việt|bahasa indonesia|dansk|norsk|svenska|suomi|čeština|magyar|română|български|українська|ελληνικά|עברית|فارسی|हिन्दी|বাংলা)/i;

/** 程序性章节:内容不是「项目是什么/主线能力」。首段扫描与章节锚共用同一口径。 */
const NOISY_HEADING = /^(install|installation|usage|quick ?start|getting started|license|licence|contribut\w*|changelog|table of contents|resources?|overview|about|features?|support|documentation|docs?|links?|community|requirements?|prerequisites?|build|development|testing|faq|examples?|roadmap|acknowledg\w*|sponsors?|security|benchmarks?|安装|使用|快速开始|许可|贡献|更新日志|目录)$/i;

/** 导航/横幅/标记行:不是项目宗旨。2026-10-20 实测:dify 首段抓到 alt=、ZCode 抓到
 * 语言切换行、opencode 抓到安装代码块——这些都被 LLM 当成 purpose 证据,总结直接跑偏。 */
function looksLikeNavOrMarkup(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/<a\s|href=|alt=|src=|<img|!\[/i.test(t)) return true;
  if (/^alt=/i.test(t)) return true;
  if (/^[|\-•·]\s/.test(t) || /^\*\s/.test(t)) return true; // 列表/资源导航(OpenCV 的 "* Homepage" 实锤;不误伤 **bold**)
  if (LANG_NAV.test(t) && /[|·]/.test(t)) return true; // 语言切换行
  if (/^(简体中文|繁體中文|english|日本語|한국어)\s*[|·]/i.test(t)) return true;
  if (/^(\[[^\]]*\]\([^)]*\)\s*[|、]?\s*){2,}/.test(t)) return true; // 纯链接导航行
  const urls = (t.match(/https?:\/\//g) ?? []).length;
  const proseLetters = (t.replace(/https?:\/\/\S+/g, " ").match(/\p{L}/gu) ?? []).length;
  // URL 续行/资源页脚:行首是 URL,或多 URL 且几乎没有散文(Electron 的正常描述含 4 个链接)
  if (urls > 0 && (/^(https?:|<https?:)/i.test(t) || (urls >= 2 && proseLetters < 60))) return true;
  if (urls > 0 && proseLetters < 20) return true; // 少量文字 + 链接=导航条
  const mdLinks = (t.match(/\[[^\]]*\]\([^)]*\)/g) ?? []).length;
  if (mdLinks >= 2) {
    // 链接多但散文也多=正常描述(Electron 首段 4 个链接);链接多且几乎无文字=导航条
    const prose = t.replace(/\[[^\]]*\]\([^)]*\)/g, " ").replace(/[*_`#>|]/g, " ");
    const proseLetters = (prose.match(/\p{L}/gu) ?? []).length;
    if (proseLetters < 80 && (mdLinks >= 3 || /\|/.test(t))) return true;
  }
  if (/translations?:/i.test(t) && t.length < 300) return true; // 多语言导航(poly-electron)
  if (/^:[a-z0-9_+-]+:/i.test(t)) return true; // :memo:/:book: 等徽标行
  if (/other languages|crowdin/i.test(t)) return true; // 翻译导航续行
  return false;
}

/** 是否像「项目是什么」的散文段:排除 badge/链接堆/表格/代码,过短或全是符号的不要。 */
function isProseParagraph(text: string): boolean {
  const t = text.trim();
  if (t.length < 12) return false;
  if (looksLikeNavOrMarkup(t)) return false;
  const letters = (t.match(/\p{L}/gu) ?? []).length;
  if (letters < 6) return false;
  const markup = (t.match(/[<>\[\]{}|`]/g) ?? []).length;
  return markup <= t.length * 0.12;
}

/** 单行 `<p>一句话</p>` 取内文(opencode 的 "The open source AI coding agent." 就是这种)。 */
function htmlParagraphText(line: string): string | null {
  const m = /^<p\b[^>]*>(.*?)<\/p>\s*$/i.exec(line.trim());
  if (!m) return null;
  const inner = m[1]!.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
  return inner || null;
}

/** README 首个有效散文段(HTML 横幅/badge/语言切换/代码块跳过;窗口 200 行;
 * 300 字符截断)。坏段落不终止扫描——继续找下一个真段落,找不到=null(显式降级不猜)。 */
export function readmeFirstParagraph(root: string): { text: string; file: string; line: number } | null {
  for (const name of README_CANDIDATES) {
    const p = join(root, name);
    if (!existsSync(p)) continue;
    try {
      const lines = readFileSync(p, "utf-8").split("\n");
      let para: string[] = [];
      let startLine = 0;
      let fenced = false;
      let skipSection = false;
      const flush = (): { text: string; file: string; line: number } | null => {
        if (para.length === 0) return null;
        const text = para.join(" ").slice(0, 300).trim();
        const line = startLine;
        para = [];
        return isProseParagraph(text) ? { text, file: name, line } : null;
      };
      for (let i = 0; i < Math.min(lines.length, 200); i++) {
        let l = lines[i]!.trim();
        if (/^(```|~~~)/.test(l)) {
          fenced = !fenced;
          const hit = flush();
          if (hit) return hit;
          continue;
        }
        if (fenced) continue;
        if (!l) { const hit = flush(); if (hit) return hit; continue; }
        if (/^#{1,6}\s/.test(l)) {
          const hit = flush();
          if (hit) return hit;
          // 程序性章节(Resources/Contributing/Install…)的内容不是项目宗旨,整段跳过
          skipSection = NOISY_HEADING.test(l.replace(/^#+\s+/, "").trim());
          continue;
        }
        if (skipSection) continue;
        const html = htmlParagraphText(l);
        if (html !== null) l = html;
        // HTML 横幅行/实体行/注释/badge/分隔线
        if (/^<|^&[a-z]+;?|^&nbsp|^<!--|^\[!|^!\[|^={3,}|-{3,}$/.test(l)) continue;
        if (looksLikeNavOrMarkup(l)) continue;
        if (para.length === 0) startLine = i + 1;
        para.push(l);
        if (para.join(" ").length > 300) { const hit = flush(); if (hit) return hit; }
      }
      const hit = flush();
      if (hit) return hit;
    } catch { /* 读取失败试下一个候选 */ }
  }
  return null;
}

/** README 章节标题(buildSkeleton 只作事实锚,不进 purpose 候选)。
 * 首段只能说明「是什么」,主线能力往往只在章节结构里(白板/子代理/感知…);
 * 跳过程序性章节(安装/许可/贡献),避免把脚手架噪声抬成能力。 */
export function readmeHeadings(root: string, max = 8): { text: string; file: string; line: number }[] {
  for (const name of README_CANDIDATES) {
    const p = join(root, name);
    if (!existsSync(p)) continue;
    try {
      const lines = readFileSync(p, "utf-8").split("\n");
      const out: { text: string; file: string; line: number }[] = [];
      let fenced = false;
      for (let i = 0; i < lines.length && out.length < max; i++) {
        const l = lines[i]!;
        if (/^\s*(```|~~~)/.test(l)) { fenced = !fenced; continue; }
        if (fenced) continue;
        const m = /^#{2,4}\s+(.+?)\s*#*\s*$/.exec(l);
        if (!m) continue;
        const text = m[1]!.trim();
        if (!text || NOISY_HEADING.test(text)) continue;
        out.push({ text, file: name, line: i + 1 });
      }
      if (out.length > 0) return out;
    } catch { /* 读取失败试下一个候选 */ }
  }
  return [];
}

interface ManifestFact {
  key: string;
  value: string;
  file: string;
  line: number;
}

function lineOfPattern(text: string, re: RegExp): { value: string; line: number } | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]!);
    if (m) {
      // 无捕获组的形态(如定位 "name": 行)回退整体匹配文本——首版 m[1]! 抛 TypeError
      // 被上游静默 catch 吞成「零事实」,测试抓出
      return { value: (m[1] ?? m[0]).trim(), line: i + 1 };
    }
  }
  return null;
}

/** 包清单扫描(package.json/pyproject.toml/go.mod/Cargo.toml/CMakeLists.txt;存在才读)。 */
export function scanManifests(root: string): { facts: ManifestFact[]; files: string[] } {
  const facts: ManifestFact[] = [];
  const files: string[] = [];
  const pkg = join(root, "package.json");
  if (existsSync(pkg)) {
    files.push("package.json");
    try {
      const text = readFileSync(pkg, "utf-8");
      const j = JSON.parse(text) as { name?: string; description?: string };
      if (j.name) facts.push({ key: "name", value: j.name, file: "package.json", line: lineOfPattern(text, /"name"\s*:/)?.line ?? 1 });
      if (j.description) facts.push({ key: "description", value: j.description.slice(0, 200), file: "package.json", line: lineOfPattern(text, /"description"\s*:/)?.line ?? 1 });
    } catch { /* 坏 JSON 如实跳过(不冒充事实) */ }
  }
  const pyproject = join(root, "pyproject.toml");
  if (existsSync(pyproject)) {
    files.push("pyproject.toml");
    const text = readFileSync(pyproject, "utf-8");
    const name = lineOfPattern(text, /^name\s*=\s*"([^"]+)"/m);
    if (name) facts.push({ key: "name", value: name.value, file: "pyproject.toml", line: name.line });
    const desc = lineOfPattern(text, /^description\s*=\s*"([^"]*)"/m);
    if (desc) facts.push({ key: "description", value: desc.value.slice(0, 200), file: "pyproject.toml", line: desc.line });
  }
  const goMod = join(root, "go.mod");
  if (existsSync(goMod)) {
    files.push("go.mod");
    const text = readFileSync(goMod, "utf-8");
    const mod = lineOfPattern(text, /^module\s+(\S+)/m);
    if (mod) facts.push({ key: "module", value: mod.value, file: "go.mod", line: mod.line });
  }
  const cargo = join(root, "Cargo.toml");
  if (existsSync(cargo)) {
    files.push("Cargo.toml");
    const text = readFileSync(cargo, "utf-8");
    const name = lineOfPattern(text, /^name\s*=\s*"([^"]+)"/m);
    if (name) facts.push({ key: "name", value: name.value, file: "Cargo.toml", line: name.line });
    const desc = lineOfPattern(text, /^description\s*=\s*"([^"]*)"/m);
    if (desc) facts.push({ key: "description", value: desc.value.slice(0, 200), file: "Cargo.toml", line: desc.line });
  }
  const cmake = join(root, "CMakeLists.txt");
  if (existsSync(cmake)) {
    files.push("CMakeLists.txt");
    const text = readFileSync(cmake, "utf-8");
    const proj = lineOfPattern(text, /^project\s*\(\s*([\w.-]+)/m);
    if (proj) facts.push({ key: "project", value: proj.value, file: "CMakeLists.txt", line: proj.line });
  }
  return { facts, files };
}

/** 框架指纹(grep 字面量 → 导入语境回查;每框架取首个有效文件为证据)。
 * step-098(RC-096-A3):命中偏好非测试路径——证据锚进 LLM 事实表,锚在测试文件会把
 * 「X 的测试」放大成主线能力失真;全测试命中才回退首个(如实,不虚构)。
 * 2026-10-20:字面量必须落在真实 import 语境,且排除 tasks/docs/vendor 等非产品路径;
 * 否则指纹表自身、任务文档示例、第三方依赖都会被算成本项目主线能力。 */
export async function detectFrameworks(root: string): Promise<{ frameworks: ProjectProfileSkeleton["frameworks"]; domain?: string }> {
  // 一次全仓行级扫描(旧实现逐框架 grep:14 族 × 多 pattern = 40+ 次全仓扫描,dify 实测 157s)。
  // 行文本先过导入语境/非产品路径,再按「非测试优先」为每族挑候选;最后读该文件用
  // findImportLine 复核(排除模板字符串/Go import 块等行级盲区)。每族最多 24 个候选,
  // 稀有框架不会因为全局读取配额被挤掉。
  const allLiterals = [...new Set(FRAMEWORKS.flatMap((fw) => fw.literals))];
  const matches = await grepMatchesAny(root, allLiterals, { glob: FRAMEWORK_GLOB, max: 6000, perFile: 20 });
  // fw → file → 最优 rank(同文件多行命中只算一个候选;否则一个脚本文件 20 行命中
  // 会占满 24 个候选位,把 api/ 里的生产证据挤掉——dify Flask 实锤)。
  const byFw = new Map<string, Map<string, number>>();
  const domainFiles = new Map<string, Set<string>>();
  for (const m of matches) {
    if (isNonProductPath(m.file)) continue;
    if (!isImportContext(m.file, m.text)) continue;
    const rank = evidenceRank(m.file);
    for (const fw of FRAMEWORKS) {
      if (!fw.literals.some((lit) => m.text.includes(lit))) continue;
      const files = byFw.get(fw.name) ?? new Map<string, number>();
      const prev = files.get(m.file);
      if (prev === undefined || rank < prev) files.set(m.file, rank);
      byFw.set(fw.name, files);
      if (rank === 0 && fw.appDomain) {
        const set = domainFiles.get(fw.name) ?? new Set<string>();
        set.add(m.file);
        domainFiles.set(fw.name, set);
      }
    }
  }
  const found = new Map<string, EvidenceRef>();
  const cache = new Map<string, string>();
  for (const fw of FRAMEWORKS) {
    const files = byFw.get(fw.name);
    if (!files) continue;
    const cands = [...files.entries()]
      .map(([file, rank]) => ({ file, rank }))
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 24);
    for (const c of cands) {
      let content = cache.get(c.file);
      if (content === undefined) {
        try {
          content = readFileSync(join(root, c.file), "utf-8");
        } catch { continue; }
        cache.set(c.file, content);
      }
      const line = findImportLine(c.file, content, fw.literals);
      if (line > 0) { found.set(fw.name, { file: c.file, line }); break; } // 只出现在指纹表/文档/夹具里的字面量不是依赖
    }
  }
  const frameworks = FRAMEWORKS
    .filter((fw) => found.has(fw.name))
    .map((fw) => ({ name: fw.name, domain: fw.domain, evidence: found.get(fw.name)! }));
  // 领域判定要求应用框架至少有 2 个产品源码文件,且按证据文件数取最多者——
  // opencv 仓里 PyTorch/TensorFlow 只有少量样例,OpenCV 才是领域主线(2026-10-20 实测)。
  const appFw = FRAMEWORKS
    .filter((fw) => fw.appDomain && found.has(fw.name) && (domainFiles.get(fw.name)?.size ?? 0) >= 2)
    .sort((a, b) => (domainFiles.get(b.name)?.size ?? 0) - (domainFiles.get(a.name)?.size ?? 0))[0];
  return { frameworks, ...(appFw ? { domain: appFw.domain } : {}) };
}

/** 确定性骨架组装(scanProject 复用;entrypoints 只读索引,缺席=显式降级)。 */
export async function buildSkeleton(root: string): Promise<{ skeleton: ProjectProfileSkeleton; anchors: EvidenceAnchor[] }> {
  const scan = await scanProject(root);
  const degraded: ProjectProfileSkeleton["degraded"] = [];
  const purposeCandidates: ProjectProfileSkeleton["purposeCandidates"] = [];
  const anchors: EvidenceAnchor[] = [];
  let anchorId = 0;
  const addAnchor = (file: string, line: number, text: string): string => {
    anchorId++;
    const id = `E${anchorId}`;
    anchors.push({ id, file, line, text: text.slice(0, 200) });
    return id;
  };

  const readme = readmeFirstParagraph(root);
  if (readme) {
    purposeCandidates.push({ text: readme.text, source: "README 首段", evidence: { file: readme.file, line: readme.line } });
    addAnchor(readme.file, readme.line, readme.text);
    // 章节标题作事实锚(只给 LLM 判读能力用,不冒充 purpose)——首段讲「是什么」,
    // 章节结构才承载「主线能力有哪些」。
    for (const h of readmeHeadings(root, 6)) addAnchor(h.file, h.line, `README 章节 ${h.text}`);
  } else {
    // 有的 README 没有散文首段(OpenCV 开篇就是 Resources 导航),但 H2 自带一句
    // 产品定义——用它作确定性 purpose 候选,比「无候选」诚实且仍有证据行。
    const heading = readmeHeadings(root, 8).find((h) => isProseParagraph(h.text));
    if (heading) {
      purposeCandidates.push({ text: heading.text, source: "README 标题", evidence: { file: heading.file, line: heading.line } });
      addAnchor(heading.file, heading.line, heading.text);
    } else {
      degraded.push({ layer: "readme", reason: "根目录无 README(或首段无可提取文本)——purpose 候选缺 README 面" });
    }
  }

  const { facts, files: manifestFiles } = scanManifests(root);
  for (const f of facts) {
    if (f.key === "description" || f.key === "name" || f.key === "project") {
      purposeCandidates.push({ text: `${f.key}=${f.value}`, source: f.file, evidence: { file: f.file, line: f.line } });
      addAnchor(f.file, f.line, `${f.key}: ${f.value}`);
    }
  }
  if (manifestFiles.length === 0) degraded.push({ layer: "manifest", reason: "无包清单(package.json/pyproject/go.mod/Cargo/CMakeLists)——技术栈只按扩展名统计" });

  const { frameworks, domain } = await detectFrameworks(root);
  for (const fw of frameworks.slice(0, 8)) {
    // 测试/脚本/示例里才出现的框架仍是事实,但标注「仅测试/示例使用」——避免 LLM 把
    // 测试夹具或压测 mock 写成项目主线能力(dify 的 Flask 压测 mock 实锤)。
    const weak = evidenceRank(fw.evidence.file) > 0 ? "[仅测试/示例使用]" : "";
    addAnchor(fw.evidence.file, fw.evidence.line, `框架指纹 ${fw.name}(${fw.domain})${weak}`);
  }
  if (frameworks.length === 0) degraded.push({ layer: "frameworks", reason: "未检出受支持框架指纹(一期指纹表 14 族;未覆盖框架如实不猜)" });

  // 技术栈按扩展名
  const byExt = new Map<string, number>();
  for (const f of scan.files) {
    const ext = f.slice(f.lastIndexOf(".")).toLowerCase();
    if (!ext) continue;
    byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
  }
  const techStack = [...byExt.entries()]
    .map(([language, files]) => ({ language, files }))
    .sort((a, b) => b.files - a.files)
    .slice(0, 8);

  // 目录拓扑(顶层目录源文件数,≤6 行)
  const byTop = new Map<string, number>();
  for (const f of scan.files) {
    const top = f.includes("/") ? f.split("/")[0]! : "(根)";
    byTop.set(top, (byTop.get(top) ?? 0) + 1);
  }
  const topoNotes = [...byTop.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([dir, n]) => `${dir}/ ×${n}`);

  // 入口(只读 c2f 索引;缺席=显式降级不阻塞骨架)
  // step-098(RC-096-A3):骨架/anchors 只收生产入口——测试入口沿 LLM 事实锚放大成
  // 「支持 X 及其测试」的主线能力失真(go-cobra profile 实锤)。取宽窗口过滤后截 6。
  // 2026-10-20:tasks/**/evidence 探针与文档示例不是产品入口(曾把 step-124 probe.cjs 的
  // main 抬进前 3,LLM 因此把「任务探针脚本」写成主线能力)。
  let entrypoints: string[] | undefined;
  const index = loadIndex(root);
  // 2026-10-22 P1:进程入口优先(启动器/进程 main——「这个仓怎么跑起来」的直接答案;
  // agent_alpha webrtc_multiprocess_server 实锚:扇出榜 top-300 之外)。扇出入口随后补位。
  const proc = scanProcessEntriesSync(root, index);
  const procLines = proc.entries
    .filter((e) => !isTestPath(e.file))
    .slice(0, 4)
    .map((e) => `${e.label} — ${e.file}${e.calls.length > 0 ? `(→ ${e.calls.slice(0, 2).join(", ")})` : ""}`);
  if (index) {
    const prodEps = queryEntryPoints(index, 24)
      .filter((n) => !isTestPath(n.file) && !isNonProductPath(n.file))
      .slice(0, 6);
    const fanLines = prodEps.map((n) => `${n.name} — ${n.file}:${n.line}`);
    entrypoints = [...procLines, ...fanLines].slice(0, 6);
    for (const ep of (procLines.length > 0 ? procLines : fanLines).slice(0, 3)) addAnchor("(index)", 1, `入口 ${ep}`);
  } else if (procLines.length > 0) {
    entrypoints = procLines;
    for (const ep of procLines.slice(0, 3)) addAnchor(ep.split(" — ")[1] ?? "(scan)", 1, `进程入口 ${ep}`);
  } else {
    degraded.push({ layer: "index", reason: "c2f 索引未构建——扇出入口缺席(进程入口扫描已尽力;codesense index 后重建 profile 可补)" });
  }

  const skeleton: ProjectProfileSkeleton = {
    purposeCandidates,
    ...(domain ? { domain } : {}),
    techStack,
    frameworks,
    ...(entrypoints ? { entrypoints } : {}),
    topoNotes,
    ...(scan.buildFiles.length > 0 ? { buildFiles: { count: scan.buildFiles.length, samples: scan.buildFiles.slice(0, 8) } } : {}),
    maturity: scan.state,
    degraded,
  };
  return { skeleton, anchors };
}

// ---- LLM purpose 层(runSemanticBatch 复用;zod+白名单+修复环在管线内) ----

export interface ProjectLlmLayer {
  purpose: string;
  capabilities: string[];
  driftWarnings: string[];
  dropped?: number;
  repairs?: number;
}

const CAP_SLOTS = 6;
const DRIFT_SLOTS = 4;

export async function llmPurposeLayer(
  skeleton: ProjectProfileSkeleton,
  anchors: EvidenceAnchor[],
): Promise<{ layer?: ProjectLlmLayer; status: "ok" | "off" | "failed"; reason?: string; dropped?: number; repairs?: number }> {
  const llm = getSensingDeps().senseLlm;
  if (!llm) {
    return { status: "off", reason: "未注入 senseLlm(无 LLM 配置)——purpose 层缺席,确定性骨架独立可用;激活: codesense config set llm.* 或 GENIE_LLM_* env" };
  }
  if (anchors.length === 0) {
    return { status: "failed", reason: "确定性骨架无证据锚(README/manifest 全缺)——语义层无据不输出" };
  }
  // 产品级证据门:只有仓库名时,代码事实(框架/入口/拓扑)能拼出「技术构成」但拼不出
  // 「这个项目为什么存在」。2026-10-20 实锤:lampgenie-harness 仅 name= 候选,LLM 把指纹表
  // 噪声写成「项目主业=框架指纹识别」。宁可显式 failed,不输出看似合理的猜测。
  const hasProductEvidence = skeleton.purposeCandidates.some(
    (c) => c.source.includes("README") || c.text.startsWith("description="),
  );
  if (!hasProductEvidence) {
    return {
      status: "failed",
      reason: "缺少产品级证据(根 README 首段与包 description 均缺,只剩仓库名/代码事实)——语义层不猜测;补 README 或 package.json description 后重新生成",
    };
  }
  const refs: string[] = ["purpose", ...Array.from({ length: CAP_SLOTS }, (_, i) => `cap-${i + 1}`), ...Array.from({ length: DRIFT_SLOTS }, (_, i) => `drift-${i + 1}`)];
  const taskPrompt = `你是代码仓库分析师。根据给定事实锚,为这个项目生成:
1. purpose:一句话(≤50字)说清「这个项目大概是干什么的」(中文,陈述事实,以锚内容为准,不推测);
2. 主线能力(cap-1..cap-6):这个项目存在的核心能力清单(每条 ≤40 字;最多 6 条,没有就少写);
3. 偏离提示(drift-1..drift-4):「什么样的改动会偏离该项目主线」(每条 ≤40 字,给 coding agent 的护栏提示;最多 4 条)。
判断纪律:purpose 优先依据 README 首段/包 description;主线能力优先依据 README 章节与产品描述。框架、入口、目录只是技术事实——单个包、测试/脚本/示例里的库(尤其标注「仅测试使用」的锚)不构成项目主线能力,不要写成 cap;没有产品级证据时宁可少写。
只输出 JSON(schema: {"items":[{"ref": "purpose|cap-N|drift-N", "summary": "...", "evidenceRef": "锚id"}]})。只输出 JSON。`;
  const outcome = await runSemanticBatch(taskPrompt, anchors, "", { maxRepairRounds: 2, refSlots: refs });
  if (!outcome || !outcome.ok || !outcome.items.has("purpose")) {
    return { status: "failed", reason: outcome ? `语义层失败(修复环 ${outcome.repairs} 轮后仍不合格,拒收 ${outcome.dropped} 条)` : "语义层返回空", ...(outcome ? { dropped: outcome.dropped, repairs: outcome.repairs } : {}) };
  }
  const layer: ProjectLlmLayer = {
    purpose: outcome.items.get("purpose")!,
    capabilities: Array.from({ length: CAP_SLOTS }, (_, i) => outcome.items.get(`cap-${i + 1}`)).filter((x): x is string => !!x),
    driftWarnings: Array.from({ length: DRIFT_SLOTS }, (_, i) => outcome.items.get(`drift-${i + 1}`)).filter((x): x is string => !!x),
    dropped: outcome.dropped,
    repairs: outcome.repairs,
  };
  return { layer, status: "ok", dropped: outcome.dropped, repairs: outcome.repairs };
}

// ---- 产物与落盘 ----

export interface ProjectProfile {
  version: 1;
  /** 语义代次(2026-10-20):2=框架指纹/证据面修正后的画像。旧缓存无此字段,
   * 读侧按失效处理,避免「新骨架 + 旧错误语义」混用;保留 version=1 让重启前的
   * 旧网关也能读懂并展示修正后的画像(生成字段向后兼容)。 */
  generation: 2;
  root: string;
  fingerprint: string;
  builtAt: number;
  skeleton: ProjectProfileSkeleton;
  llm?: ProjectLlmLayer;
  llmState: { status: "ok" | "off" | "failed"; reason?: string };
  /** 读取时的指纹核对结果(write 时恒 fresh)。 */
  stale?: boolean;
}

export function profilePath(root: string): string {
  return join(indexDir(root), "profile.json");
}

/** 指纹键(2026-10-30 冷路径改造):srcFingerprintCached 无缓存(进程冷启动)返回 null——
 * 绝不同步全仓 stat(冻结收割 ×2 实锤),也绝不把占位键写进持久化 manifest(毒化:此后每次
 * load 都指纹不匹配误报 stale)。null 语义=「未知,假定一致」:查询侧复用盘上 manifest 的
 * 已存键(缓存命中,不重花 LLM);load 侧不误报 stale;几秒后异步指纹入缓存即精确。 */
function fingerprintOf(root: string): string | null {
  const fp = srcFingerprintCached(root);
  return fp ? `${fp.count}:${fp.maxMtime}` : null;
}

/** 查询:骨架现算;--llm 且已配置凭证时跑语义层;manifest 指纹同=复用缓存 LLM 产物不重花钱。 */
export async function queryProjectProfile(
  root: string,
  opts: { withLlm?: boolean; refresh?: boolean } = {},
): Promise<ProjectProfile> {
  const fpCold = fingerprintOf(root); // 冷启动可能 null(异步指纹在途)
  const { skeleton, anchors } = await buildSkeleton(root);
  // buildSkeleton 走了几秒 fs 异步——异步指纹通常已入缓存,再取一次;仍未知=复用盘上 manifest
  // 已存键(假定一致,不重花 LLM);无 manifest=空串(写盘后下次指纹已知会如实标 stale,自愈)。
  const fingerprint = fpCold ?? fingerprintOf(root) ?? readManifestFingerprint(root) ?? "";

  // 缓存:manifest 指纹同 → 复用 LLM 产物(骨架仍现算,毫秒~秒级)
  let cachedLlm: ProjectLlmLayer | undefined;
  if (!opts.refresh) {
    try {
      const cached = JSON.parse(readFileSync(profilePath(root), "utf-8")) as ProjectProfile;
      if (cached.version === 1 && cached.generation === 2 && cached.fingerprint === fingerprint && cached.llm) {
        cachedLlm = cached.llm;
      }
    } catch { /* 无 manifest/坏 JSON=无缓存,如实 */ }
  }

  let llmState: ProjectProfile["llmState"];
  let llm: ProjectLlmLayer | undefined;
  if (cachedLlm) {
    llm = cachedLlm;
    llmState = { status: "ok" };
  } else if (opts.withLlm) {
    const r = await llmPurposeLayer(skeleton, anchors);
    llmState = { status: r.status, ...(r.reason ? { reason: r.reason } : {}) };
    llm = r.layer;
  } else {
    llmState = { status: "off", reason: "未请求 LLM(--no-llm 或未配置);确定性骨架独立可用" };
  }

  return {
    version: 1,
    generation: 2,
    root,
    fingerprint,
    builtAt: Date.now(),
    skeleton,
    ...(llm ? { llm } : {}),
    llmState,
  };
}

/** 落盘(--write;目录随 indexDir 创建)。 */
export function writeProjectProfile(root: string, profile: ProjectProfile): string {
  const dir = indexDir(root);
  mkdirSync(dir, { recursive: true });
  const p = profilePath(root);
  writeFileSync(p, JSON.stringify(profile, null, 2) + "\n");
  return p;
}

/** 盘上 manifest 的已存指纹键(冷启动未知时的「假定一致」锚点;缺席=null)。 */
function readManifestFingerprint(root: string): string | null {
  try {
    return (JSON.parse(readFileSync(profilePath(root), "utf-8")) as ProjectProfile).fingerprint ?? null;
  } catch {
    return null;
  }
}

/** 读 manifest(gateway action=project / 注入用;同步读,缺席=null,stale=指纹不匹配;
 * 指纹未知(进程冷启动)=不误报 stale,异步指纹入缓存后下次调用得准确判定)。 */
export function loadProjectProfile(root: string): { profile: ProjectProfile; stale: boolean } | null {
  const p = profilePath(root);
  if (!existsSync(p)) return null;
  try {
    const profile = JSON.parse(readFileSync(p, "utf-8")) as ProjectProfile;
    if (profile.version !== 1 || profile.generation !== 2) return null;
    const fpNow = fingerprintOf(root);
    return { profile, stale: fpNow !== null && profile.fingerprint !== fpNow };
  } catch {
    return null;
  }
}

// ---- 渲染(CLI/MCP/注入三方共用文本面) ----

export function renderProjectProfile(profile: ProjectProfile, opts: { stale?: boolean; maxChars?: number } = {}): string {
  const s = profile.skeleton;
  const out: string[] = [];
  out.push(`项目画像(${profile.root};成熟度 ${s.maturity};指纹 ${profile.fingerprint}${opts.stale ? ";⚠️ 源码已变动,建议重建" : ""})`);
  if (profile.llm) {
    out.push(`  purpose(LLM 解读,证据锚=下方事实): ${profile.llm.purpose}`);
    for (const c of profile.llm.capabilities) out.push(`  主线能力: ${c}`);
    for (const d of profile.llm.driftWarnings) out.push(`  偏离提示: ${d}`);
  } else {
    out.push(`  purpose: ${profile.llmState.status === "off" ? "(未生成——" + (profile.llmState.reason ?? "无 LLM") + ")" : "(生成失败——" + (profile.llmState.reason ?? "") + ")"}`);
  }
  for (const pc of s.purposeCandidates.slice(0, 3)) {
    out.push(`  purpose 候选(${pc.source} @${pc.evidence.file}:${pc.evidence.line}): ${pc.text.slice(0, 160)}`);
  }
  if (s.domain) out.push(`  领域(框架指纹映射): ${s.domain}`);
  if (s.techStack.length > 0) out.push(`  技术栈: ${s.techStack.map((t) => `${t.language}×${t.files}`).join(", ")}`);
  if (s.frameworks.length > 0) out.push(`  框架: ${s.frameworks.map((f) => `${f.name}@${f.evidence.file}:${f.evidence.line}`).join(", ")}`);
  if (s.entrypoints?.length) out.push(`  入口: ${s.entrypoints.slice(0, 4).join(" | ")}`);
  if (s.topoNotes.length > 0) out.push(`  目录拓扑: ${s.topoNotes.join(", ")}`);
  if (s.buildFiles?.count) out.push(`  构建文件: ${s.buildFiles.count} 个(${s.buildFiles.samples.join(", ")}${s.buildFiles.count > s.buildFiles.samples.length ? " …" : ""})——新增子系统/模块的接线面`);
  for (const d of s.degraded) out.push(`  [降级] ${d.layer}: ${d.reason}`);
  const text = out.join("\n");
  return opts.maxChars && text.length > opts.maxChars ? text.slice(0, opts.maxChars) + "…(截断)" : text;
}

/** 「项目主线」注入块(agent-wiring 用;≤300 字符硬预算;无 manifest=空串零开销)。
 * 只认产品级 purpose(README/description);仅仓库名或纯代码事实=零注入——
 * 错误的主线比没有主线更伤(2026-10-20:旧画像把「框架指纹识别」注入成了项目主线)。 */
export function projectMainlineBlock(root: string, maxChars = 300): string {
  const loaded = loadProjectProfile(root);
  if (!loaded) return "";
  const { profile } = loaded;
  const productPurpose = profile.skeleton.purposeCandidates.find(
    (c) => c.source.includes("README") || c.text.startsWith("description="),
  )?.text;
  if (!productPurpose) return "";
  const rawPurpose = profile.llm?.purpose ?? productPurpose;
  if (!rawPurpose) return "";
  const trimEnd = (s: string): string => s.replace(/[。.]\s*$/, ""); // 部件间以「。」连接,防叠句号
  const parts: string[] = [`项目主线:${trimEnd(rawPurpose)}`];
  const caps = profile.llm?.capabilities ?? [];
  if (caps.length > 0) parts.push(`主线能力:${caps.slice(0, 3).map(trimEnd).join(";")}`);
  const drift = profile.llm?.driftWarnings ?? [];
  if (drift.length > 0) parts.push(`偏离主线的大改(如:${drift.slice(0, 2).map(trimEnd).join(";")})先向用户确认`);
  const body = parts.join("。").slice(0, maxChars);
  return `\n\n## 项目主线(code-sense 项目画像,防偏离)\n${body}\n`;
}
