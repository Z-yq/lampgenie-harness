/**
 * 项目档案管线:
 * 纯静态零 LLM 的模块级架构图管线——扫描→模块聚类→import 依赖边→mermaid。
 * 纪律:分批 setImmediate 让步(不阻塞任务执行);进度经 WS 广播;产物持久化 .genie/profiles/<id>.json;
 * 任务终态钩子记录 recentChanges(模块命中)+ 防抖自动重建(agent 加了模块→图上出现,新模块打 🆕)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { scanProject } from "@lampgenie/code-sense/project";
import { getIndexBestEffort } from "./sense-index-manager.js";
import { relative, sep } from "node:path";

export interface ProfileModule {
  name: string;
  path: string;
  files: number;
  lines: number;
  deps: string[];
  keyFiles: string[];
  desc: string;
  addedAt?: number;
  /** LLM 导读已覆盖(desc=AI 一句话+统计后缀)。 */
  descHasAi?: boolean;
}

/** 规划项(全量开发:图上规划态的原子操作。 */
export type PlanItem =
  | { id: string; kind: "add-module"; name: string; note: string; createdAt: number }
  | { id: string; kind: "remove-module"; name: string; reason: string; createdAt: number }
  | { id: string; kind: "add-dep"; from: string; to: string; note: string; createdAt: number };

/** 模块×git 历史(演进打通):per-module 最近提交。 */
export interface ModuleGitHistory {
  module: string;
  commits: { sha: string; subject: string; author: string; at: number }[];
  commits30d: number;
}

export interface ProfileChange {
  at: number;
  taskId: string;
  title: string;
  modules: string[];
  files: number;
  add: number;
  del: number;
}

export interface ProjectProfileData {
  projectId: string;
  root: string;
  state: "pending" | "running" | "done" | "failed";
  progress: number;
  stage: string;
  startedAt: number;
  finishedAt?: number;
  modules: ProfileModule[];
  edges: { from: string; to: string }[];
  mermaid: string;
  stats: { files: number; lines: number; languages: Record<string, number>; projectState: string };
  recentChanges: ProfileChange[];
  newModules: string[];
  /** 规划态(图上编辑,生成任务书用)。 */
  plan: PlanItem[];
  /** git 历史×模块(仓库才有)。 */
  gitHistory?: ModuleGitHistory[];
  error?: string;
}

const SRC_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".java", ".rs", ".rb", ".php", ".vue", ".html"]);

/** 文件路径 → 模块名(packages/<x>、apps/<x>、src/<x>、顶层目录;根文件=“(根)”)。
 * 容器目录下的单文件(packages/build.ts)按文件名去扩展名;顶层目录下的根级单文件同理。 */
export function moduleOf(relPath: string): string {
  const parts = relPath.split(sep);
  if (parts.length === 1) return "(根)";
  const head = parts[0]!;
  if ((head === "packages" || head === "apps" || head === "tools" || head === "services") && parts.length === 2) {
    return parts[1]!.replace(/\.[a-z]+$/, "");
  }
  if ((head === "packages" || head === "apps" || head === "tools" || head === "services") && parts.length > 2) return parts[1]!;
  if (head === "src" && parts.length >= 2) return parts[1]!;
  return head;
}

/** 轻量 import 提取(相对路径 Only:./ ../;裸包名=外部依赖不入图)。TS/JS/py。 */
export function extractRelImports(relPath: string, text: string): string[] {
  const out: string[] = [];
  const ext = relPath.slice(relPath.lastIndexOf("."));
  if (ext === ".py") {
    for (const m of text.matchAll(/^\s*from\s+\.(\.?[\w.]*)\s+import/gm)) {
      out.push(m[1] ?? "");
    }
  } else if (ext === ".go") {
    // go 内部包通常同模块路径,跳过相对(go 无相对 import)
  } else {
    for (const m of text.matchAll(/(?:from\s+|require\(\s*|import\(\s*|import\s+)["'](\.[^"']*)["']/g)) {
      out.push(m[1] ?? "");
    }
  }
  return out;
}

/** 解析相对导入 → 目标文件路径(尝试扩展名补全;失败返回 undefined)。 */
function resolveImport(fromFile: string, spec: string, allFiles: Set<string>): string | undefined {
  const base = dirname(fromFile);
  const target = join(base, spec).split(sep).join("/");
  const cands = [target, target + ".ts", target + ".tsx", target + ".js", target + ".mjs", target + ".py", target + "/index.ts", target + "/index.js", target + "/__init__.py"];
  for (const c of cands) if (allFiles.has(c)) return c;
  // 目录前缀命中(子模块任意文件)
  for (const f of allFiles) if (f === target || f.startsWith(target + "/")) return f;
  return undefined;
}

function mermaidOf(modules: ProfileModule[], edges: { from: string; to: string }[], plan: PlanItem[] = []): string {
  const top = [...modules].sort((a, b) => b.lines - a.lines).slice(0, 32);
  const keep = new Set(top.map((m) => m.name));
  const maxLines = Math.max(1, ...top.map((m) => m.lines));
  // 规划态覆盖:计划删除的现有模块;计划新增的模块(即使不在 top 也上 图)。
  const plannedDel = new Set(plan.filter((x) => x.kind === "remove-module").map((x) => (x as { name: string }).name));
  const plannedAdd = plan.filter((x) => x.kind === "add-module") as { name: string; note: string }[];
  for (const a of plannedAdd) keep.add(a.name);
  const lines = ["flowchart LR"];
  for (const m of top) {
    const cls = plannedDel.has(m.name) ? "pdel" : m.lines > maxLines * 0.5 ? "big" : m.lines > maxLines * 0.15 ? "mid" : "small";
    lines.push(`  ${id(m.name)}["${m.name}<br/>${m.files} 文件 · ${m.lines} 行"]:::${cls}`);
  }
  for (const a of plannedAdd) {
    if (top.some((m) => m.name === a.name)) continue;
    lines.push(`  ${id(a.name)}["${a.name}<br/>${escMm(a.note || "规划新增")}"]:::pnew`);
  }
  const seen = new Set<string>();
  for (const e of edges) {
    if (!keep.has(e.from) || !keep.has(e.to) || e.from === e.to) continue;
    const k = e.from + "->" + e.to;
    if (seen.has(k)) continue;
    seen.add(k);
    lines.push(`  ${id(e.from)} --> ${id(e.to)}`);
    if (seen.size > 80) break;
  }
  // 规划边(虚线)
  for (const pe of plan.filter((x) => x.kind === "add-dep") as { from: string; to: string }[]) {
    lines.push(`  ${id(pe.from)} -.-> ${id(pe.to)}`);
  }
  lines.push("  classDef big fill:#c98f45,color:#0b0806,stroke:#f0d9ae");
  lines.push("  classDef mid fill:#8f6430,color:#f2e7d4,stroke:#c98f45");
  lines.push("  classDef small fill:#2a1d10,color:#97836a,stroke:#8f6430");
  lines.push("  classDef pnew fill:#1f3320,color:#9dc08b,stroke:#9dc08b,stroke-dasharray:4 3");
  lines.push("  classDef pdel fill:#2a1414,color:#e08a7a,stroke:#e08a7a,stroke-dasharray:2 3");
  return lines.join("\n");
  function id(name: string): string {
    return "m_" + name.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 24);
  }
  function escMm(x: string): string {
    return x.replace(/["<>\n]/g, " ").slice(0, 40);
  }
}

/** 规划 → 结构化任务书。 */
export function planToInstruction(plan: PlanItem[]): string {
  if (!plan.length) return "";
  const adds = plan.filter((x) => x.kind === "add-module") as { name: string; note: string }[];
  const dels = plan.filter((x) => x.kind === "remove-module") as { name: string; reason: string }[];
  const deps = plan.filter((x) => x.kind === "add-dep") as { from: string; to: string; note: string }[];
  const parts = ["按以下架构规划实施(来自项目档案的图上规划,规划即契约):"];
  if (adds.length) parts.push("\n## 新增模块\n" + adds.map((a) => `- **${a.name}**:${a.note || "按规划职责实现"}`).join("\n"));
  if (dels.length) parts.push("\n## 移除模块\n" + dels.map((d) => `- **${d.name}**:${d.reason || "规划废弃;先迁移引用再删除"}`).join("\n"));
  if (deps.length) parts.push("\n## 新增依赖\n" + deps.map((e) => `- **${e.from} → ${e.to}**:${e.note || "建立该依赖(单向,禁反向)"}`).join("\n"));
  parts.push("\n## 纪律\n- 实施前先读项目档案的模块图,确认现状与规划差异;\n- 每完成一个规划项自验(测试/类型检查);\n- 完成后架构应与规划一致(项目档案会自动重建比对)。");
  return parts.join("\n");
}

/** git log --numstat 输出 → per-module 最近提交(≤5)+30 天计数。 */
export function parseGitLog(out: string, root: string): ModuleGitHistory[] {
  const byMod = new Map<string, { sha: string; subject: string; author: string; at: number }[]>();
  const commitRe = /^([0-9a-f]{7,40})\x1f(.+?)\x1f(\d+)\x1f(.+)$/;
  const numRe = /^(\d+|-)\s+(\d+|-)\s+(.+)$/;
  let cur: { sha: string; subject: string; author: string; at: number } | null = null;
  const now = Date.now();
  const c30 = new Map<string, number>();
  for (const line of out.split("\n")) {
    const cm = commitRe.exec(line);
    if (cm) {
      cur = { sha: cm[1]!.slice(0, 8), author: cm[2]!, at: Number(cm[3]) * 1000, subject: cm[4]!.slice(0, 80) };
      continue;
    }
    const nm = numRe.exec(line);
    if (!nm || !cur) continue;
    const rel = nm[3]!.replace(/"/g, "");
    const mod = rel.includes("/") ? moduleOf(rel) : "(根)";
    const list = byMod.get(mod) ?? [];
    if (list.length < 5) list.push(cur);
    byMod.set(mod, list);
    if (now - cur.at < 30 * 86_400_000) c30.set(mod, (c30.get(mod) ?? 0) + 1);
  }
  void root;
  return [...byMod.entries()].map(([module, commits]) => ({ module, commits, commits30d: c30.get(module) ?? 0 }));
}

export class ProjectProfileIndex {
  private profiles = new Map<string, ProjectProfileData>();
  private running = new Set<string>();
  private rebuildTimers = new Map<string, NodeJS.Timeout>();
  private listeners: ((p: ProjectProfileData) => void)[] = [];

  constructor(
    private readonly profilesDir: string,
    private readonly resolveRoot: (projectId: string) => string | undefined,
    /** LLM 导读(可选;无=纯静态描述)。 */
    private readonly llm?: { chat(messages: { role: string; content: string }[]): Promise<{ content: string }> },
  ) {}

  /** 进度订阅(app 注入广播)。 */
  onProgress(fn: (p: ProjectProfileData) => void): void {
    this.listeners.push(fn);
  }

  private emit(p: ProjectProfileData): void {
    for (const fn of this.listeners) fn(p);
  }

  private fileOf(projectId: string): string {
    return join(this.profilesDir, projectId.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json");
  }

  /** 移除项目时清除其档案产物(内存登记+落盘文件;不存在=幂等 no-op)。
 * 「已移除项目」残留根治:项目删除不再遗留 <pid>.json 死数据。 */
  purge(projectId: string): void {
    this.profiles.delete(projectId);
    this.rebuildTimers.delete(projectId);
    try {
      rmSync(this.fileOf(projectId), { force: true });
    } catch {
      // 文件系统层失败容忍:登记已清,残留文件不影响行为(resolveRoot 已查不到该项目)
    }
  }

  get(projectId: string): ProjectProfileData | undefined {
    const hit = this.profiles.get(projectId);
    if (hit) return hit;
    const f = this.fileOf(projectId);
    if (existsSync(f)) {
      try {
        const p = JSON.parse(readFileSync(f, "utf-8")) as ProjectProfileData;
        this.profiles.set(projectId, p);
        return p;
      } catch {
        // 坏文件容忍
      }
    }
    return undefined;
  }

  /** 取或建(面板 profile.get 与 project.add 钩子共用):无档案或失败→启动管线;有→原样返回。 */
  getOrStart(projectId: string): ProjectProfileData | { started: true } | { error: string } {
    const cur = this.get(projectId);
    if (cur && (cur.state === "done" || cur.state === "running")) return cur;
    const root = this.resolveRoot(projectId);
    if (!root) return { error: "项目不存在:" + projectId };
    void this.build(projectId, root);
    return { started: true };
  }

  /** 强制重建(保留 recentChanges/newModules 演进史)。 */
  rebuild(projectId: string): boolean {
    const root = this.resolveRoot(projectId);
    if (!root) return false;
    const prev = this.get(projectId);
    void this.build(projectId, root, prev);
    return true;
  }

  /** 主管线:全异步分批,进度推进,产物落盘。 */
  async build(projectId: string, root: string, prev?: ProjectProfileData): Promise<ProjectProfileData> {
    if (this.running.has(projectId)) return this.get(projectId)!;
    this.running.add(projectId);
    const startedAt = Date.now();
    const p: ProjectProfileData = {
      projectId, root,
      state: "running", progress: 3, stage: "扫描源文件",
      startedAt,
      modules: [], edges: [], mermaid: "",
      stats: { files: 0, lines: 0, languages: {}, projectState: "EMPTY" },
      recentChanges: prev?.recentChanges ?? [],
      newModules: prev?.newModules ?? [],
      plan: prev?.plan ?? [],
    };
    this.profiles.set(projectId, p);
    this.emit(p);
    const tick = async (progress: number, stage: string) => {
      p.progress = progress;
      p.stage = stage;
      this.emit(p);
      await new Promise<void>((r) => setImmediate(r));
    };
    try {
      const scan = await scanProject(root);
      p.stats.projectState = scan.state;
      p.stats.files = scan.files.length;
      await tick(12, `扫描完成:${scan.files.length} 个源文件`);

 // 单图同构。
 // 修复(对比 ZCode startup「只预热 active、避免重复重活」;AGENTS 主进程假死注意):
      // 旧实现在索引过期时直接 void c2f.buildC2fIndex(root) = **主进程**全仓 ts-morph 扫描,
      // 每添加一个项目触发一次,连续添加多项目=主进程卡死(添加风暴时「列表滞后/添加没反应」的另一真因)。
      // 改走 sense-index-manager:有索引(即使过期)先用快路径;缺/过期交给 worker 子进程后台重建
      // (getIndexBestEffort 内有 in-flight 去重与失败冷却),本次构建走轻路径(扫描+目录聚类)。
      const best = getIndexBestEffort(root);
      const c2fIndex = best.index;
      if (c2fIndex && c2fIndex.nodes.length > 0) {
        await this.buildFromC2f(p, root, c2fIndex, tick, prev);
        return p;
      }

      // 语言统计 + 行数 + import 边(分批)
      const allFiles = new Set(scan.files);
      const modStats = new Map<string, { files: number; lines: number; key: string[] }>();
      const edgeSet = new Set<string>();
      const lang: Record<string, number> = {};
      const BATCH = 60;
      for (let i = 0; i < scan.files.length; i += BATCH) {
        const batch = scan.files.slice(i, i + BATCH);
        for (const f of batch) {
          const mod = moduleOf(f);
          const st = modStats.get(mod) ?? { files: 0, lines: 0, key: [] };
          st.files++;
          const ext = f.slice(f.lastIndexOf("."));
          lang[ext] = (lang[ext] ?? 0) + 1;
          let text = "";
          try {
            text = readFileSync(join(root, f), "utf-8");
          } catch {
            continue;
          }
          st.lines += text.length ? text.split("\n").length : 0;
          if (st.key.length < 5) st.key.push(f);
          modStats.set(mod, st);
          for (const spec of extractRelImports(f, text)) {
            const tgt = resolveImport(f, spec, allFiles);
            if (!tgt) continue;
            const tm = moduleOf(tgt);
            if (tm !== mod) edgeSet.add(mod + "\u0000" + tm);
          }
        }
        await tick(12 + Math.round(58 * Math.min(1, (i + BATCH) / Math.max(1, scan.files.length))), "解析模块与依赖");
      }
      p.stats.lines = [...modStats.values()].reduce((s, x) => s + x.lines, 0);
      p.stats.languages = lang;
      await tick(74, "聚合模块图");

      // 新模块检测(相对上次档案)
      const prevNames = new Set((prev?.modules ?? []).map((m) => m.name));
      const now = Date.now();
      const newModules: string[] = [];
      p.modules = [...modStats.entries()]
        .map(([name, st]) => {
          const isNew = prevNames.size > 0 && !prevNames.has(name);
          if (isNew) newModules.push(name);
          return {
            name, path: name === "(根)" ? "" : name,
            files: st.files, lines: st.lines,
            deps: [...edgeSet].filter((e) => e.startsWith(name + "\u0000")).map((e) => e.split("\u0000")[1]!).sort(),
            keyFiles: st.key,
            desc: st.files + " 文件 · " + st.lines + " 行 · 代表:" + st.key.slice(0, 2).join(", "),
            ...(isNew ? { addedAt: now } : {}),
          };
        })
        .sort((a, b) => b.lines - a.lines);
      p.edges = [...edgeSet].map((e) => { const [from, to] = e.split("\u0000")!; return { from: from!, to: to! }; });
      if (newModules.length) {
        p.newModules = [...new Set([...(prev?.newModules ?? []), ...newModules])].slice(-20);
        p.recentChanges = [{ at: now, taskId: "-", title: "新增模块:" + newModules.join(", "), modules: newModules, files: 0, add: 0, del: 0 }, ...(prev?.recentChanges ?? [])].slice(0, 20);
      }
      // git 历史×模块(演进打通):近 200 提交的 numstat 文件→模块映射;非 git 仓库跳过。
      if (existsSync(join(root, ".git"))) {
        await tick(82, "关联 git 历史");
        try {
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const out = await promisify(execFile)("git", ["log", "--numstat", "--format=%H%x1f%an%x1f%at%x1f%s", "-n", "200"], { cwd: root, maxBuffer: 8 * 1024 * 1024 }).then((r) => r.stdout).catch(() => "");
          p.gitHistory = parseGitLog(out, root);
        } catch {
          p.gitHistory = undefined;
        }
      }
      await tick(88, "绘制架构图");
      p.mermaid = mermaidOf(p.modules, p.edges, p.plan);
      p.state = "done";
      p.progress = 100;
      p.stage = "完成";
      p.finishedAt = Date.now();
    } catch (err) {
      p.state = "failed";
      p.stage = "失败";
      p.error = String(err).slice(0, 300);
      p.finishedAt = Date.now();
    } finally {
      this.running.delete(projectId);
      this.persist(projectId);
      this.emit(p);
      // LLM 导读(后台,不挡 done):一次调用生成 ≤12 个模块的一句话职责;完成再广播触发面板重拉。
      if (p.state === "done" && this.llm) void this.enrichDescriptions(projectId, p).catch(() => {});
    }
    return p;
  }

 /** 单图同构路径:从 c2f 静态索引聚合档案——模块=目录聚类(函数级节点),
   * 边=跨模块函数调用聚合(比 import 静态扫描更真实:运行可达的调用面);
   * 类/方法进 keyFiles;行数仍逐文件(索引无行数字段)。 */
  private async buildFromC2f(
    p: ProjectProfileData,
    root: string,
    idx: import("@lampgenie/code-sense").C2fIndex,
    tick: (progress: number, stage: string) => Promise<void>,
    prev?: ProjectProfileData): Promise<void> {
    const { queryEntryPoints } = await import("@lampgenie/code-sense");
    const modOfFn = moduleOf;
    await tick(30, "从调用索引聚合模块");
    // 节点聚类 + 类/入口标记
    const modStats = new Map<string, { files: Set<string>; nodes: number; entry: string[]; classes: string[] }>();
    for (const n of idx.nodes) {
      const mod = modOfFn(n.file);
      const st = modStats.get(mod) ?? { files: new Set<string>(), nodes: 0, entry: [], classes: [] };
      st.files.add(n.file);
      st.nodes++;
      if (n.kind === "trunk" && st.entry.length < 3) st.entry.push(n.name);
      if (n.file.endsWith(".ts") && /^class$/i.test("") === false && !n.container && n.name[0] === n.name[0]?.toUpperCase() && n.name.includes(".") === false && st.classes.length < 3) {
        // 大写开头且无容器且非方法=导出类节点(engine kind=class 在 c2f 未带 kind,此处按命名启发;误差可接受,keyFiles 级)
      }
      modStats.set(mod, st);
    }
    // 跨模块边(函数级聚合)
    const modEdges = new Map<string, number>(); // from\u0000to → 调用次数
    for (const e of idx.edges) {
      if (!e.to) continue;
      const fn = idx.nodes.find((x) => x.id === e.from);
      const tn = idx.nodes.find((x) => x.id === e.to);
      if (!fn || !tn) continue;
      const fm = modOfFn(fn.file), tm = modOfFn(tn.file);
      if (fm === tm) continue;
      const k = fm + "\u0000" + tm;
      modEdges.set(k, (modEdges.get(k) ?? 0) + 1);
    }
    await tick(55, `聚合 ${modStats.size} 模块 / ${modEdges.size} 跨模块调用边`);
    // 行数/语言(逐文件轻扫,索引无行数)
    const lang: Record<string, number> = {};
    let totalLines = 0;
    const allFiles = new Set<string>();
    for (const n of idx.nodes) allFiles.add(n.file);
    const BATCH = 60;
    const filesArr = [...allFiles];
    const modLines = new Map<string, number>();
    for (let i = 0; i < filesArr.length; i += BATCH) {
      for (const f of filesArr.slice(i, i + BATCH)) {
        const mod = modOfFn(f);
        const ext = f.slice(f.lastIndexOf("."));
        lang[ext] = (lang[ext] ?? 0) + 1;
        try {
          const n = readFileSync(join(root, f), "utf-8").split("\n").length;
          totalLines += n;
          modLines.set(mod, (modLines.get(mod) ?? 0) + n);
        } catch { continue; }
      }
      await tick(55 + Math.round(15 * Math.min(1, (i + BATCH) / Math.max(1, filesArr.length))), "统计行数");
    }
    p.stats.lines = totalLines;
    p.stats.languages = lang;
    // 入口函数(trunk)做档案的「从哪开始读」
    const entryNames = new Set(queryEntryPoints(idx, 200).map((n) => n.name));
    const prevNames = new Set((prev?.modules ?? []).map((m) => m.name));
    const now = Date.now();
    const newModules: string[] = [];
    p.modules = [...modStats.entries()]
      .map(([name, st]) => {
        const isNew = prevNames.size > 0 && !prevNames.has(name);
        if (isNew) newModules.push(name);
        const lines = modLines.get(name) ?? 0;
        const entryHint = st.entry.length ? " 入口:" + st.entry.slice(0, 2).join(",") : "";
        return {
          name, path: name === "(根)" ? "" : name,
          files: st.files.size, lines,
          deps: [...modEdges.entries()].filter(([k]) => k.startsWith(name + "\u0000")).map(([k]) => k.split("\u0000")[1]!).sort(),
          keyFiles: [...st.files].slice(0, 5),
          desc: st.nodes + " 符号 · " + lines + " 行" + entryHint,
          ...(isNew ? { addedAt: now } : {}),
        };
      })
      .sort((a, b) => b.lines - a.lines);
    p.edges = [...modEdges.entries()].map(([k, n]) => { const [from, to] = k.split("\u0000")!; return { from: from!, to: to!, weight: n }; }) as typeof p.edges;
    if (newModules.length) {
      p.newModules = [...new Set([...(prev?.newModules ?? []), ...newModules])].slice(-20);
      p.recentChanges = [{ at: now, taskId: "-", title: "新增模块:" + newModules.join(", "), modules: newModules, files: 0, add: 0, del: 0 }, ...(prev?.recentChanges ?? [])].slice(0, 20);
    }
    if (existsSync(join(root, ".git"))) {
      await tick(82, "关联 git 历史");
      try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const out = await promisify(execFile)("git", ["log", "--numstat", "--format=%H%x1f%an%x1f%at%x1f%s", "-n", "200"], { cwd: root, maxBuffer: 8 * 1024 * 1024 }).then((r) => r.stdout).catch(() => "");
        p.gitHistory = parseGitLog(out, root);
      } catch {
        p.gitHistory = undefined;
      }
    }
    await tick(88, "绘制架构图");
    p.mermaid = mermaidOf(p.modules, p.edges as { from: string; to: string }[], p.plan);
    p.state = "done";
    p.progress = 100;
    p.stage = "完成(c2f 单图)";
    p.finishedAt = Date.now();
  }

  /** LLM 导读:静态描述升级为一句话职责(aiRead 标记;失败保持静态)。 */
  private async enrichDescriptions(projectId: string, p: ProjectProfileData): Promise<void> {
    const targets = p.modules.filter((m) => !m.descHasAi).sort((a, b) => b.lines - a.lines).slice(0, 12);
    if (!targets.length) return;
    const list = targets.map((m) => `- ${m.name}(代表文件:${m.keyFiles.slice(0, 2).join(", ")})`).join("\n");
    try {
      const res = await this.llm!.chat([
        { role: "system", content: "你是架构导读员。为每个模块输出一句话职责描述(≤50字,中文,说清它管什么;不要文件数行数这类统计)。只输出 JSON 对象,键=模块名,值=描述。" },
        { role: "user", content: "模块清单:\n" + list },
      ]);
      const txt = res.content ?? "";
      const start = txt.indexOf("{");
      const end = txt.lastIndexOf("}");
      if (start < 0 || end <= start) return;
      const map = JSON.parse(txt.slice(start, end + 1)) as Record<string, string>;
      let hit = 0;
      for (const m of targets) {
        const d = map[m.name];
        if (typeof d === "string" && d.trim()) {
          m.desc = d.trim().slice(0, 80) + " · " + m.files + " 文件/" + m.lines + " 行";
          m.descHasAi = true;
          hit++;
        }
      }
      if (hit > 0) {
        this.persist(projectId);
        this.emit(p); // done 态再广播一次→面板重拉完整档案
      }
    } catch {
      // LLM 失败:静态描述保持(诚实降级)
    }
  }

  /** 任务终态钩子:文件变更映射到模块 → recentChanges;防抖自动重建(图随 agent 演进)。 */
  recordChange(projectId: string, change: { taskId: string; title?: string; files: { path: string }[]; add: number; del: number }): void {
    const p = this.get(projectId);
    if (!p) return;
    const root = this.resolveRoot(projectId);
    if (!root) return;
    const mods = new Set<string>();
    for (const f of change.files) {
      let rel = f.path;
      try {
        rel = relative(root, f.path);
      } catch {
        // 不同盘符等:按路径前缀退化处理
      }
      if (rel.startsWith("..")) continue;
      mods.add(moduleOf(rel.split(sep).join("/")));
    }
    p.recentChanges = [{ at: Date.now(), taskId: change.taskId, title: change.title ?? change.taskId, modules: [...mods], files: change.files.length, add: change.add, del: change.del }, ...p.recentChanges].slice(0, 20);
    this.persist(projectId);
    // 防抖重建(10s):静默合并连续变更
    const t = this.rebuildTimers.get(projectId);
    if (t) clearTimeout(t);
    this.rebuildTimers.set(projectId, setTimeout(() => {
      this.rebuildTimers.delete(projectId);
      this.rebuild(projectId);
    }, 10_000));
    this.rebuildTimers.get(projectId)?.unref?.();
  }

  /** 规划项增改(按 id upsert;名称冲突守卫)。 */
  planUpsert(projectId: string, item: PlanItem): PlanItem[] | { error: string } {
    const p = this.get(projectId);
    if (!p) return { error: "档案不存在(先构建)" };
    const existingNames = new Set(p.modules.map((m) => m.name));
    if (item.kind === "add-module") {
      if (!/^[\w.-]{1,40}$/.test(item.name)) return { error: "模块名须为字母/数字/-/_/.(≤40)" };
      if (existingNames.has(item.name)) return { error: "模块已存在:" + item.name };
    }
    if (item.kind === "remove-module" && !existingNames.has(item.name)) return { error: "模块不存在:" + item.name };
    if (item.kind === "add-dep" && (item.from === item.to)) return { error: "依赖两端相同" };
    p.plan = [...p.plan.filter((x) => x.id !== item.id), item];
    this.persist(projectId);
    this.reRender(projectId, p);
    return p.plan;
  }

  planRemove(projectId: string, id: string): PlanItem[] | { error: string } {
    const p = this.get(projectId);
    if (!p) return { error: "档案不存在" };
    p.plan = p.plan.filter((x) => x.id !== id);
    this.persist(projectId);
    this.reRender(projectId, p);
    return p.plan;
  }

  /** 规划落地:生成任务书文本(调用方据此提交任务);返回文本,不动任务系统(职责分离)。 */
  planInstruction(projectId: string): string | { error: string } {
    const p = this.get(projectId);
    if (!p || !p.plan.length) return { error: "无规划项" };
    return planToInstruction(p.plan);
  }

  /** 规划清空(落地后调用)。 */
  planClear(projectId: string): PlanItem[] {
    const p = this.get(projectId);
    if (!p) return [];
    p.plan = [];
    this.persist(projectId);
    this.reRender(projectId, p);
    return p.plan;
  }

  private reRender(projectId: string, p: ProjectProfileData): void {
    if (p.state === "done") {
      p.mermaid = mermaidOf(p.modules, p.edges, p.plan);
      this.persist(projectId);
    }
    this.emit(p);
  }

  private persist(projectId: string): void {
    const p = this.profiles.get(projectId);
    if (!p) return;
    try {
      mkdirSync(this.profilesDir, { recursive: true });
      writeFileSync(this.fileOf(projectId), JSON.stringify(p, null, 1) + "\n");
    } catch {
      // 只读环境容忍
    }
  }
}
