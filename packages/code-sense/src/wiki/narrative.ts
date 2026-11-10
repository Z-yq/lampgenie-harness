/**
 * wiki LLM 叙述层:注入式管线 + zod + 引用回查 + 修复 1 轮。
 * 红线:LLM 只写叙述;事实/图/行号来自确定性扫描。每个 section 至少 1 条可回查引用,
 * 有效引用全丢的 section 整段不写(无据不写)。失败=显式降级,不冒充。
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { WikiCitation, WikiConfig, WikiNarrative, WikiNarrativeFeature, WikiNarrativeSection } from "./types";
import { validateCitation, type SourceCache, type WikiInput } from "./scan";

const CiteZ = z.object({
  file: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  anchor: z.string().min(1),
});
const SectionZ = z.object({
  heading: z.string().min(1),
  body: z.string().min(1),
  cites: z.array(CiteZ).min(1),
});
const FeatureZ = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  cites: z.array(CiteZ).min(1),
});
const NarrativeZ = z.object({
  summary: z.string().optional(),
  sections: z.array(SectionZ).min(1),
  // 仅 features 页:功能线语义命名(确定性 id 必须来自 flow 骨架)
  features: z.array(FeatureZ).optional(),
});
type RawNarrative = z.infer<typeof NarrativeZ>;

export interface NarrativeOutcome {
  narrative?: WikiNarrative;
  error?: string;
  calls: number;
  audit: { checked: number; passed: number; failed: number; droppedSections: number };
}

interface Excerpt {
  file: string;
  text: string;
  chars: number;
}

/** 页面摘录:带行号;单页文件/字符预算(成本护栏)。 */
export async function collectExcerpts(
  cache: SourceCache,
  files: string[],
  maxChars: number,
  maxFiles = 6): Promise<Excerpt[]> {
  const picked: { file: string; lines: string[] }[] = [];
  for (const f of files.slice(0, maxFiles)) {
    const lines = await cache.load(f);
    if (!lines || lines.length === 0) continue;
    picked.push({ file: f, lines });
  }
  const out: Excerpt[] = [];
  let used = 0;
  for (const p of picked) {
    const buf: string[] = [`### ${p.file}`];
    for (let i = 0; i < p.lines.length && i < 500; i++) {
      const line = `${i + 1}: ${p.lines[i] ?? ""}`;
      if (used + line.length > maxChars) break;
      buf.push(line);
      used += line.length + 1;
    }
    if (buf.length > 1) out.push({ file: p.file, text: buf.join("\n"), chars: buf.join("\n").length });
    if (used >= maxChars) break;
  }
  return out;
}

export function pageNarrativeHash(files: string[], excerpts: Excerpt[]): string {
  return createHash("sha256").update(JSON.stringify({ files, excerpts: excerpts.map((e) => [e.file, e.chars]) })).digest("hex");
}

export function buildWikiPrompt(opts: {
  repo: string;
  title: string;
  kind: string;
  moduleName?: string;
  excerpts: Excerpt[];
 /** :整仓 code flow 骨架(入口/边/功能线)。guide/features 页用它约束叙述:
   * 不得添加骨架里不存在的模块/调用边;图已由确定性骨架提供,正文不再出 mermaid。 */
  flowContext?: string;
}): string {
  const fileList = opts.excerpts.map((e) => e.file).join("\n- ");
  return `你是仓库技术文档作者。只为给定的仓库写一页 wiki,面向开发者。

严格要求:
1. 只能依据下方【源码摘录】中的事实写作;不得使用外部知识,不得编造文件、函数、行为。
2. 只输出一个 JSON 对象(不要 markdown 围栏、不要解释),schema:
{"summary":"一句话总结(≤120字)","sections":[{"heading":"小节标题","body":"小节正文(Markdown,不含 # 标题)","cites":[{"file":"仓库相对路径","startLine":1,"endLine":10,"anchor":"必须逐字出现在该行范围内的源码片段"}]}]}
3. 每个 section 至少 1 条 cites;cites 的 file 必须是摘录文件之一;startLine/endLine 必须来自摘录左侧行号;
   anchor 必须从该范围里的源码行原样摘取(空白折叠后逐字匹配),不能改写、不能概括。
4. 2-5 个 section;正文中文;不要写"根据代码""本文档"之类空话;不要输出 mermaid(图由确定性骨架提供)。
5. 如果摘录不足以支撑某个小节,就不要写该小节。
6. 如果给了【代码流骨架】,你的叙述必须与骨架一致:入口、模块、调用方向、功能线不得改写或新增;
   可以解释"为什么这样分层/这条功能线做什么",但每个判断都要能落到源码引用上。
7. 如果页面 kind=features,额外输出 "features" 数组(与 sections 同级):每条功能线一条
   {"id":"骨架里的 id(原样复制,不得新增/删除)","name":"语义名(≤12 字,用户视角)","description":"一句话用户能力(≤60 字)","cites":[引用]};
   cites 规则同 section;id 对不上或引用全无效的条目会被丢弃。

仓库:${opts.repo}
页面:${opts.title}(${opts.kind}${opts.moduleName ? `;模块 ${opts.moduleName}` : ""})
可用文件:
- ${fileList}
${opts.flowContext ? `\n【代码流骨架(确定性;必须一致)】\n${opts.flowContext}\n` : ""}
【源码摘录】
${opts.excerpts.map((e) => e.text).join("\n\n")}`;
}

/** JSON 提取(容忍模型包 ```json 围栏/前后废话)。 */
export function parseNarrativeJson(raw: string): RawNarrative {
  let text = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) text = fence[1]!.trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) text = text.slice(first, last + 1);
  const parsed = JSON.parse(text) as unknown;
  return NarrativeZ.parse(parsed);
}

function cleanBody(s: string): string {
  return s
    .split(/\r?\n/)
    .filter((l) => !/^\s*#{1,6}\s/.test(l)) // 小节内不许再出标题(结构由调用方控制)
    .join("\n")
    .replace(/```mermaid[\s\S]*?```/gi, "")
    .trim()
    .slice(0, 4_000);
}

/** 逐条回查:有效 cite 保留;无效丢弃并计数;段内无有效 cite=整段不写。 */
export async function validateNarrative(
  raw: RawNarrative,
  input: WikiInput,
  cache: SourceCache): Promise<{ narrative: WikiNarrative | null; audit: NarrativeOutcome["audit"]; reasons: string[] }> {
  const audit = { checked: 0, passed: 0, failed: 0, droppedSections: 0 };
  const reasons: string[] = [];
  const sections: WikiNarrativeSection[] = [];
  for (const s of raw.sections) {
    const valid: WikiCitation[] = [];
    for (const c of s.cites.slice(0, 6)) {
      audit.checked++;
      const r = await validateCitation(input.root, cache, c);
      if (r.ok) {
        audit.passed++;
        valid.push({ file: c.file, startLine: c.startLine, endLine: c.endLine, anchor: c.anchor });
      } else {
        audit.failed++;
        reasons.push(`${s.heading}: ${c.file}:${c.startLine} — ${r.reason ?? "引用回查失败"}`);
      }
    }
    const body = cleanBody(s.body);
    if (valid.length === 0 || !body) {
      audit.droppedSections++;
      continue;
    }
    sections.push({ heading: s.heading.trim().slice(0, 80), body, cites: valid });
  }
  // 功能线语义命名:cite 逐条回查;名字/描述保留,id 由页面侧与确定性 features 对齐。
  const featNames: WikiNarrativeFeature[] = [];
  for (const f of raw.features ?? []) {
    const valid: WikiCitation[] = [];
    for (const c of f.cites.slice(0, 4)) {
      audit.checked++;
      const r = await validateCitation(input.root, cache, c);
      if (r.ok) { audit.passed++; valid.push({ file: c.file, startLine: c.startLine, endLine: c.endLine, anchor: c.anchor }); }
      else { audit.failed++; reasons.push(`${f.id}: ${c.file}:${c.startLine} — ${r.reason ?? "功能线引用回查失败"}`); }
    }
    if (valid.length === 0) continue;
    featNames.push({ id: f.id.trim(), name: f.name.trim().slice(0, 40), description: f.description.trim().slice(0, 120), cites: valid });
  }
  if (sections.length === 0) return { narrative: null, audit, reasons };
  return {
    narrative: {
      summary: (raw.summary ?? "").trim().slice(0, 500),
      sections,
      ...(featNames.length > 0 ? { features: featNames } : {}),
      audit,
    },
    audit,
    reasons,
  };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`LLM 调用超时(${ms}ms)`)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 生成一页叙述:摘录→LLM→JSON→引用回查;失败时 1 次修复;仍失败=null(调用方降级)。 */
export async function generateNarrative(opts: {
  input: WikiInput;
  cache: SourceCache;
  config: WikiConfig;
  llm: { generate(prompt: string): Promise<string> };
  title: string;
  kind: string;
  files: string[];
  moduleName?: string;
  flowContext?: string;
}): Promise<NarrativeOutcome> {
  const excerpts = await collectExcerpts(opts.cache, opts.files, opts.config.maxExcerptChars);
  if (excerpts.length === 0) {
    return { error: "无可用源码摘录", calls: 0, audit: { checked: 0, passed: 0, failed: 0, droppedSections: 0 } };
  }
  const prompt = buildWikiPrompt({
    repo: opts.input.repo, title: opts.title, kind: opts.kind, excerpts,
    ...(opts.moduleName ? { moduleName: opts.moduleName } : {}),
    ...(opts.flowContext ? { flowContext: opts.flowContext } : {}),
  });
  let calls = 0;
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const ask = attempt === 0
      ? prompt
      : `${prompt}\n\n上一次输出有以下问题,请修正后只输出完整 JSON:\n${lastErr.slice(0, 1200)}`;
    calls++;
    let rawText = "";
    try {
      rawText = await withTimeout(opts.llm.generate(ask), opts.config.llmTimeoutMs);
    } catch (err) {
      lastErr = `LLM 调用失败: ${String(err).slice(0, 200)}`;
      continue;
    }
    let parsed: RawNarrative;
    try {
      parsed = parseNarrativeJson(rawText);
    } catch (err) {
      lastErr = `JSON/schema 校验失败: ${String(err).slice(0, 300)}`;
      continue;
    }
    const v = await validateNarrative(parsed, opts.input, opts.cache);
    if (v.narrative) return { narrative: v.narrative, calls, audit: v.audit };
    lastErr = `引用回查后无有效小节: ${v.reasons.slice(0, 8).join(" | ") || "所有 section 的 cite 均无效"}`;
  }
  return { error: lastErr || "LLM 叙述生成失败", calls, audit: { checked: 0, passed: 0, failed: 0, droppedSections: 0 } };
}
