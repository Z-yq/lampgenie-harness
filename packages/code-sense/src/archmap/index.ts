/**
 * archmap(designs/16 §6.3):管线设计(采样→摘录→索引→LLM 两段式→校验修复环)参考 gitdiagram 项目(MIT,致谢),本仓独立实现。
 * 采样(打分+多样性)→摘录→SOURCE INDEX→LLM 两段式→zod 校验→修复环→mermaid。
 * LLM 注入式(LlmProvider):无 LLM 时 plan 剖面降级为静态模块结构。
 */
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join, dirname, relative } from "node:path";

// ---- 采样器(gitdiagram 打分移植,五语言 manifest 扩展) ----
const MANIFESTS = ["package.json", "pyproject.toml", "go.mod", "pom.xml", "Cargo.toml", "requirements.txt"];
const ENTRY_RE = /(^|\/)(main|app|index|server|gateway|cli)\.[tj]sx?$/;
const KEYWORD_RE = /(service|pipeline|worker|core|runtime|engine|provider|adapter|router|handler)/i;
const NEGATIVE_RE = /(test|spec|\.config|\.d\.ts|mock|fixture|bench)/i;

export interface SampledFile {
  path: string;       // 相对根
  score: number;
  excerpt: string;
}

export async function sampleFiles(root: string, files: string[], budget = { files: 12, chars: 48_000 }): Promise<SampledFile[]> {
  const scored: { path: string; score: number }[] = [];
  for (const f of files) {
    let s = 0;
    const base = f.split("/").pop()!;
    if (MANIFESTS.includes(base)) s += 45;
    if (ENTRY_RE.test(f)) s += 28;
    if (KEYWORD_RE.test(f)) s += 22;
    if (base === "README.md") s += 20;
    if (NEGATIVE_RE.test(f)) s -= 30;
    if (s > 0) scored.push({ path: f, score: s });
  }
  scored.sort((a, b) => b.score - a.score);

  // 多样性惩罚:同目录超过 3 个后每个 -10(防单一文件夹吃光名额)
  const perDir = new Map<string, number>();
  const picked: { path: string; score: number }[] = [];
  for (const c of scored) {
    const dir = dirname(c.path);
    const n = perDir.get(dir) ?? 0;
    const adjusted = c.score - Math.max(0, n - 2) * 10;
    if (adjusted <= 0) continue;
    picked.push({ ...c, score: adjusted });
    perDir.set(dir, n + 1);
    if (picked.length >= budget.files) break;
  }

  const out: SampledFile[] = [];
  let total = 0;
  for (const c of picked) {
    let content = "";
    try {
      content = await readFile(join(root, c.path), "utf-8");
    } catch { continue; }
    // 摘录:import 区全保留 + 头部窗口(gitdiagram:围绕架构相关代码,一期简化为头 120 行)
    const lines = content.split("\n");
    const imports = lines.filter((l) => /^\s*(import|from|#include|require)/.test(l));
    const head = lines.slice(0, 120).join("\n");
    const excerpt = (imports.join("\n") + "\n" + head).slice(0, Math.min(4000, budget.chars - total));
    total += excerpt.length;
    out.push({ path: c.path, score: c.score, excerpt });
    if (total >= budget.chars) break;
  }
  return out;
}

// ---- SOURCE INDEX(gitdiagram:import 对照文件表,确定性证据层) ----
export interface SourceIndexEntry {
  file: string;
  imports: string[];        // 解析到的仓内相对路径(存在者)
  unresolvedImports: string[]; // 包名(外部依赖)
}

export async function buildSourceIndex(root: string, sampled: SampledFile[], allFiles: Set<string>): Promise<SourceIndexEntry[]> {
  const entries: SourceIndexEntry[] = [];
  for (const s of sampled) {
    const imports: string[] = [];
    const unresolved: string[] = [];
    for (const line of s.excerpt.split("\n")) {
      // TS/JS import ... from "./x";Python from .x import
      const m = /from\s+["'](\.[^"']+)["']|import\s+.*from\s+["'](\.[^"']+)["']/.exec(line)
        ?? /^from\s+(\.[\w.]+)\s+import/.exec(line);
      const spec = (m?.[1] ?? m?.[2] ?? m?.[3]);
      if (!spec) {
        const pkg = /from\s+["'](@?[\w][^"']*)["']/.exec(line)?.[1];
        if (pkg) unresolved.push(pkg);
        continue;
      }
      // 相对路径解析到仓内文件(尝试扩展名补全)
      const dir = dirname(s.path);
      const cand = join(dir, spec).replace(/\\/g, "/");
      for (const suffix of ["", ".ts", ".tsx", ".js", "/index.ts", "/index.js"]) {
        const probe = (cand + suffix).replace(/^\.\//, "");
        if (allFiles.has(probe)) { imports.push(probe); break; }
      }
    }
    entries.push({ file: s.path, imports, unresolvedImports: [...new Set(unresolved)] });
  }
  return entries;
}

// ---- graph schema(gitdiagram zod 形状) ----
export const GraphNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  evidencePath: z.string().optional(),
});
export const GraphEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
  /** 三源证据:excerpt/index/readme 之一;inferred=虚线。 */
  evidence: z.enum(["excerpt", "index", "readme", "inferred"]),
  evidencePath: z.string().optional(),
});
export const GraphSchema = z.object({
  nodes: z.array(GraphNodeSchema).max(34),
  edges: z.array(GraphEdgeSchema).max(48),
});
export type Graph = z.infer<typeof GraphSchema>;

// ---- 校验+修复环 ----
export interface ValidationIssue {
  kind: "bad-path" | "bad-ref" | "schema";
  detail: string;
}

export function validateGraph(g: Graph, rootFiles: Set<string>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodeIds = new Set(g.nodes.map((n) => n.id));
  for (const n of g.nodes) {
    if (n.evidencePath && !rootFiles.has(n.evidencePath)) {
      issues.push({ kind: "bad-path", detail: `节点 ${n.id} 的 evidencePath 不存在: ${n.evidencePath}` });
    }
  }
  for (const e of g.edges) {
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) {
      issues.push({ kind: "bad-ref", detail: `边 ${e.from}→${e.to} 引用不存在的节点` });
    }
    if (e.evidence !== "inferred" && e.evidencePath && !rootFiles.has(e.evidencePath)) {
      issues.push({ kind: "bad-path", detail: `边 ${e.from}→${e.to} 的 evidencePath 不存在: ${e.evidencePath}` });
    }
  }
  return issues;
}

// ---- mermaid 编译器(确定性) ----
export function graphToMermaid(g: Graph): string {
  const lines = ["flowchart TD"];
  for (const n of g.nodes) {
    lines.push(`  ${safeId(n.id)}["${n.label.replace(/"/g, "'")}"]`);
  }
  for (const e of g.edges) {
    const arrow = e.evidence === "inferred" ? "-.->" : "-->";
    const label = e.label ? `|${e.label.replace(/[|]/g, "/")}|` : "";
    lines.push(`  ${safeId(e.from)} ${arrow}${label} ${safeId(e.to)}`);
  }
  return lines.join("\n");
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, "_");
}

// ---- 两段式 LLM 生成(prompt 移植自 gitdiagram,本地化措辞) ----
export interface ArchLlm {
  /** 第一段:解说;第二段:图 JSON。 */
  generate(introPrompt: string, graphPrompt: string): Promise<{ narrative: string; graphJson: string }>;
}

export async function generateArchitecture(
  root: string,
  files: string[],
  llm: ArchLlm,
  opts: { maxRepairRounds?: number } = {},
): Promise<{ graph: Graph; narrative: string; repairs: number }> {
  const rootFiles = new Set(files);
  const sampled = await sampleFiles(root, files);
  const index = await buildSourceIndex(root, sampled, rootFiles);

  const indexText = index
    .map((e) => `${e.file} → imports: ${e.imports.join(", ") || "(无仓内)"}`)
    .join("\n");
  const excerptText = sampled.map((s) => `### ${s.path}\n\`\`\`\n${s.excerpt}\n\`\`\``).join("\n");

  const introPrompt = `你是架构分析师。以下是一个代码库的采样(摘录+SOURCE INDEX),写一段 200 字以内的架构解说:系统分几块、各自职责、依赖方向。\n\n${excerptText}\n\nSOURCE INDEX:\n${indexText}`;
  const graphPrompt = `基于以下解说与 SOURCE INDEX,输出架构图 JSON(schema: {"nodes":[{"id","label","evidencePath"}],"edges":[{"from","to","label","evidence","evidencePath"}]})。
规则:每条边的 evidence 必须是 excerpt/index/readme 之一且 evidencePath 是 SOURCE INDEX 里出现过的真实路径;给不出证据就 evidence:"inferred"。节点≤15,边≤25。只输出 JSON。\n\n解说:\n${introPrompt}\n\nSOURCE INDEX:\n${indexText}`;

  const maxRounds = opts.maxRepairRounds ?? 2;
  const r0 = await llm.generate(introPrompt, graphPrompt);
  let graph = parseGraph(r0.graphJson);
  let repairs = 0;
  for (let i = 0; i < maxRounds; i++) {
    const issues = graph ? validateGraph(graph, rootFiles) : [{ kind: "schema" as const, detail: "JSON 解析失败" }];
    if (issues.length === 0) break;
    repairs++;
    const fixPrompt = `${graphPrompt}\n\n上一版有以下问题,修正后重输出完整 JSON:\n${issues.map((x) => `- ${x.detail}`).join("\n")}`;
    const rn = await llm.generate(introPrompt, fixPrompt);
    graph = parseGraph(rn.graphJson);
  }
  return { graph: graph ?? { nodes: [], edges: [] }, narrative: r0.narrative, repairs };
}

function parseGraph(raw: string): Graph | null {
  try {
    const cleaned = raw.trim().replace(/^```json\s*|\s*```$/g, "");
    return GraphSchema.parse(JSON.parse(cleaned));
  } catch {
    return null;
  }
}

// ---- git 热点(designs/16 §7.2,纯静态) ----
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileP = promisify(execFile);

export async function gitHotspots(root: string, days = 30, top = 5): Promise<string[]> {
  try {
    const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    const { stdout } = await execFileP("git", ["log", `--since=${since}`, "--name-only", "--format="], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
    const count = new Map<string, number>();
    // 代码文件优先(2026-10-13 质量审计:AGENTS.md/pnpm-lock.yaml 出现在架构热点=噪声,
    // 热点的语义是「代码热点」;文档/锁文件改得勤不代表架构热点)
    const isCode = (f: string) => /\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|rs)$/.test(f);
    for (const line of stdout.split("\n")) {
      const f = line.trim();
      if (f && isCode(f)) count.set(f, (count.get(f) ?? 0) + 1);
    }
    return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([f]) => f);
  } catch {
    return []; // 无 git 或失败:静默(热点是增强,不是必需)
  }
}
