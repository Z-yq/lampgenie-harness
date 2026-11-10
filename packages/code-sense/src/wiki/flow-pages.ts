/**
 * 代码档案的 flow / 语义指南 / 功能拆解页。
 * 分工(与 §9 一致):
 *  - flow 页:确定性图(module/file/功能线 mermaid)+ 入口/分层/枢纽表,事实全部来自
 *    buildCodeFlow;不含 LLM。
 *  - guide / features 页:确定性骨架(入口、路径、模块、关键文件/函数)为正文;
 *    LLM 只追加「语义解读」小节(每条带 file:line 引用回查),不改事实字段/图。
 * 图在面板「Wiki 文档」tab 内由 mermaid 渲染;页内 path:line 自动变可点击引用。
 */
import type { PageDraft } from "./pages";
import { citeAt, ensureMinCitations, metaLine, pageFooter, renderNarrative } from "./pages";
import type { WikiCitation, WikiConfig, WikiNarrative } from "./types";
import type { WikiFlowBundle } from "./flow-source";
import type { SourceCache, WikiInput } from "./scan";
import { renderCodeFlowMermaid, type CodeFlow } from "../callgraph/flow";
import { cfgDescriptionRows, cfgReturnSummary, renderCfgMermaid } from "../sensing/cfg";
import { MODULE_NOTE_SOURCE_LABEL } from "../callgraph/module-notes";
import type { WikiPipelineCfg } from "./cfg-source";
import { slugify } from "./pages";

function flowBanner(input: WikiInput, bundle: WikiFlowBundle): string {
  const st = bundle.summary;
  const source = bundle.source === "index" ? "符号级静态索引" : "词法级(仅 import;未加载索引)";
  const bits = [
    `数据 ${source}`,
    `${st.level} 层`,
    `${st.nodes} 节点/${st.edges} 边`,
    `入口 ${st.entries}`,
    `未解析调用 ${st.unresolvedCalls}`,
    st.omittedNodes || st.omittedEdges ? `裁剪 ${st.omittedNodes} 节点/${st.omittedEdges} 边` : "无裁剪",
    ...(st.bridgeEdges ? [`HTTP 桥 ${st.bridgeEdges}`] : []),
  ];
  return metaLine(input, "确定性骨架", bits.join(" · "));
}

function esc(s: string): string {
  return s.replace(/\|/g, "/").replace(/\r?\n/g, " ").slice(0, 80);
}

function mermaidBlock(code: string): string[] {
  return ["```mermaid", code, "```", ""];
}

function entryKindLabel(kind?: string): string {
  if (kind === "process") return "进程入口";
  if (kind === "root") return "组合根";
  if (kind === "module-root") return "组合根";
  if (kind === "trunk") return "零入度";
  return kind ?? "入口";
}

/** 全仓代码流页(模块级主图 + 文件级热点 + 入口/分层/枢纽)。 */
export async function buildFlowPage(
  input: WikiInput,
  cache: SourceCache,
  config: WikiConfig,
  bundle: WikiFlowBundle): Promise<PageDraft> {
  const flow = bundle.primary;
  const cites: WikiCitation[] = [];
  const lines: string[] = [`# ${input.displayName} 全仓代码流`, "", flowBanner(input, bundle), ""];

  // 入口引用(可回查 file:line)
  for (const n of flow.nodes.filter((x) => x.entry).slice(0, 6)) {
    if (!n.file) continue;
    const c = await citeAt(cache, n.file, n.line ?? 1);
    if (c) cites.push(c);
  }

  lines.push("## 这张图怎么读", "");
  lines.push("- **▶ / 金色节点**:入口/trunk(索引内没人调用它,流程从这里开始);**绿色**:leaf(不调用别人);**灰色**:regular;虚线节点=零连接;虚线边=跨语言 HTTP 桥。");
  lines.push("- 文件/模块顶层语句(`<module>` 组合根)在**跨文件/跨模块**调用时成为入口;被上层调用的库内组合根不算项目入口。`new Class()` 在函数级图里落到构造器节点,类本身只作分组。");
  lines.push("- 边上的 `×N` 是调用点数;默认裁掉零连接节点,预算裁剪按「入口可达 + 调用量」优先,省略数在页脚如实登记。");
  lines.push("- **模块名下方斜体=模块作用/角色**:package.json/README/模块 docstring 有就用原文;`≈`=名称/拓扑推断(来源见下表)。");
  lines.push("- 测试文件与 tasks/docs/examples 等非产品路径默认不进图(避免测试调用淹没主干)。", "");

  lines.push("## 模块级总览", "");
  const moduleFlow = bundle.moduleFlow;
  lines.push(...mermaidBlock(renderCodeFlowMermaid(moduleFlow, { legend: true })));
  lines.push("### 模块作用(图旁斜体)", "");
  lines.push("| 模块 | 作用/角色 | 来源 | 规模 | 入口/枢纽 |", "| --- | --- | --- | --- | --- |");
  for (const n of moduleFlow.nodes.slice(0, 24)) {
    const note = bundle.moduleNotes[n.label];
    const role = n.entry ? "入口" : n.in > 0 ? `被 ${n.in} 个上游依赖` : n.out > 0 ? "下游装载器" : "内部闭环";
    lines.push(`| ${n.label} | ${note?.text ?? "—"} | ${note ? MODULE_NOTE_SOURCE_LABEL[note.source] : "—"} | ${n.files ?? "-"} 文件 · ${n.symbols ?? "-"} 符号 | ${role} |`);
  }
  lines.push("");
  if (flow.level !== "module") {
    lines.push("### 文件级总览(模块数不足 4,主图改用文件级)", "");
    lines.push(...mermaidBlock(renderCodeFlowMermaid(flow, { legend: false })));
    lines.push("");
  }

  lines.push("### 入口与主干", "", "| 入口 | 类型 | 出/入 | 主干路径(按调用量) |", "| --- | --- | --- | --- |");
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const outEdges = new Map<string, typeof flow.edges>();
  for (const e of flow.edges) (outEdges.get(e.from) ?? outEdges.set(e.from, []).get(e.from)!).push(e);
  for (const list of outEdges.values()) list.sort((a, b) => b.count - a.count);
  for (const n of flow.nodes.filter((x) => x.entry).slice(0, 12)) {
    const path: string[] = [n.label];
    const seen = new Set<string>([n.id]);
    let cur = n.id;
    for (let hop = 0; hop < 4; hop++) {
      const nxt = (outEdges.get(cur) ?? []).find((e) => !seen.has(e.to));
      if (!nxt) break;
      path.push(byId.get(nxt.to)?.label ?? nxt.to);
      seen.add(nxt.to);
      cur = nxt.to;
    }
    lines.push(`| ${n.label} | ${entryKindLabel(n.entryKind)} | ${n.outCalls}/${n.inCalls} | ${path.join(" → ")} |`);
  }
  lines.push("");

  const layers = new Map<number, string[]>();
  for (const n of flow.nodes) {
    if (n.depth < 0) continue;
    (layers.get(n.depth) ?? layers.set(n.depth, []).get(n.depth)!).push(n.label);
  }
  if (layers.size > 0) {
    lines.push("### 分层(距最近入口跳数)", "", "| 层 | 节点(按调用量) |", "| --- | --- |");
    for (const d of [...layers.keys()].sort((a, b) => a - b).slice(0, 8)) {
      lines.push(`| d${d} | ${layers.get(d)!.slice(0, 12).join(", ")} |`);
    }
    lines.push("");
  }

  const hubs = flow.nodes.filter((n) => n.inCalls > 0).sort((a, b) => b.inCalls - a.inCalls).slice(0, 8);
  if (hubs.length > 0) {
    lines.push("### 枢纽(被依赖最多)", "", "| 节点 | 入边 | 上游数 | 内部调用 |", "| --- | --- | --- | --- |");
    for (const n of hubs) lines.push(`| ${n.label} | ${n.inCalls} | ${n.in} | ${n.internalCalls} |`);
    lines.push("");
  }

  if (bundle.fileFlow && bundle.fileFlow.nodes.length > 0) {
    lines.push("## 文件级全量代码流", "");
    lines.push(`> 文件级全仓图(**全部 ${bundle.fileFlow.stats.nodesShown} 个文件节点,不设上限**;分组=所属模块);用于定位「改动会沿哪条文件链扩散」。`, "");
    lines.push(...mermaidBlock(renderCodeFlowMermaid(bundle.fileFlow, { legend: false })));
    lines.push("### 高频文件边", "", "| 调用方 | 被调方 | 调用点 |", "| --- | --- | --- |");
    const fById = new Map(bundle.fileFlow.nodes.map((n) => [n.id, n]));
    for (const e of bundle.fileFlow.edges.slice(0, 15)) {
      const a = fById.get(e.from)?.label ?? e.from;
      const b = fById.get(e.to)?.label ?? e.to;
      lines.push(`| ${a} | ${b} | ×${e.count} |`);
      const f = fById.get(e.from)?.file;
      if (f) {
        const c = await citeAt(cache, f, fById.get(e.from)?.line ?? 1);
        if (c) cites.push(c);
      }
    }
    lines.push("");
  }

  lines.push("## 口径与降级", "");
  lines.push(`- 数据源:${bundle.source === "index" ? "静态调用索引(符号级;已按 sourceRef 解析)" : "词法级模块/import 扫描(未加载索引,运行 codesense index 后重建可升级)"}`);
  for (const n of bundle.notes) lines.push(`- ${n}`);
  lines.push(`- 本页图由确定性构建器生成(mermaid 可直接在面板渲染);DOT/JSON 可用 codesense flow --dot/--json 导出。`, "");

  const sources = [...new Set([
    ...flow.nodes.filter((n) => n.file).map((n) => n.file!),
    ...bundle.featureFiles,
    ...bundle.llmFiles,
  ])].slice(0, 20);
  const finalCites = await ensureMinCitations(input, cache, cites, 5, sources);
  lines.push(pageFooter(finalCites));
  return {
    id: "flow",
    title: `${input.displayName} 全仓代码流`,
    kind: "flow",
    section: "flow",
    order: 15,
    file: "flow.md",
    summary: `${bundle.summary.level} 层 · ${bundle.summary.nodes} 节点/${bundle.summary.edges} 边 · 入口 ${bundle.summary.entries} · 功能线 ${bundle.features.length}`,
    markdown: lines.join("\n"),
    citations: finalCites,
    sources,
    generator: "deterministic",
    llm: "off",
  };
}

/** 单模块 file 级 flow 子页。 */
export async function buildModuleFlowPage(
  input: WikiInput,
  cache: SourceCache,
  config: WikiConfig,
  moduleName: string,
  flow: CodeFlow,
  bundle: WikiFlowBundle): Promise<PageDraft> {
  const cites: WikiCitation[] = [];
  const lines: string[] = [`# 模块 ${moduleName} · 文件级代码流`, "", flowBanner(input, bundle), ""];
  const modNote = bundle.moduleNotes[moduleName];
  if (modNote) lines.push(`> 模块作用: ${modNote.text}(${MODULE_NOTE_SOURCE_LABEL[modNote.source]})`, "");
  lines.push(`> 本模块子图:${flow.stats.nodesShown} 文件节点 / ${flow.stats.edgesShown} 边(全量,不设上限)· 入口 ${flow.entries.length}。`, "");
  const files = input.moduleFiles.get(moduleName) ?? [];
  lines.push(`> 模块内 ${files.length} 个源文件;下图只保留模块作用域(--scope ${moduleName})内的文件节点。`, "");
  lines.push(...mermaidBlock(renderCodeFlowMermaid(flow, { legend: true })));

  lines.push("### 模块内入口", "", "| 入口 | 类型 | 出/入 |", "| --- | --- | --- |");
  for (const n of flow.nodes.filter((x) => x.entry).slice(0, 10)) {
    lines.push(`| ${n.label} | ${entryKindLabel(n.entryKind)} | ${n.outCalls}/${n.inCalls} |`);
    if (n.file) {
      const c = await citeAt(cache, n.file, n.line ?? 1);
      if (c) cites.push(c);
    }
  }
  lines.push("");
  lines.push("### 调用最密的文件边", "", "| 调用方 | 被调方 | 调用点 |", "| --- | --- | --- |");
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  for (const e of flow.edges.slice(0, 15)) {
    lines.push(`| ${byId.get(e.from)?.label ?? e.from} | ${byId.get(e.to)?.label ?? e.to} | ×${e.count} |`);
  }
  lines.push("");
  // 与别的模块的接口(模块级图上跨出本模块的边)
  const cross = bundle.moduleFlow.edges.filter((e) => {
    const a = bundle.moduleFlow.nodes.find((n) => n.id === e.from)?.label;
    const b = bundle.moduleFlow.nodes.find((n) => n.id === e.to)?.label;
    return a === moduleName && b !== moduleName;
  }).slice(0, 12);
  if (cross.length > 0) {
    lines.push("### 对外依赖(本模块 → 其他模块)", "", "| 目标模块 | 调用点 |", "| --- | --- |");
    for (const e of cross) {
      const b = bundle.moduleFlow.nodes.find((n) => n.id === e.to)?.label ?? e.to;
      lines.push(`| ${b} | ×${e.count} |`);
    }
    lines.push("");
  }
  const sources = files.slice(0, 20);
  const finalCites = await ensureMinCitations(input, cache, cites, 5, sources);
  lines.push(pageFooter(finalCites));
  return {
    id: `flow/${slugify(moduleName)}`,
    title: `模块 ${moduleName} · 文件级 flow`,
    kind: "flow-module",
    section: "flow",
    order: 16,
    file: `flow/${slugify(moduleName)}.md`,
    summary: `${moduleName}:${flow.stats.nodesShown} 文件节点/${flow.stats.edgesShown} 边`,
    moduleName,
    markdown: lines.join("\n"),
    citations: finalCites,
    sources,
    generator: "deterministic",
    llm: "off",
  };
}

/** 语义级代码指南(确定性阅读骨架 + LLM 语义解读)。 */
export async function buildGuidePage(
  input: WikiInput,
  cache: SourceCache,
  config: WikiConfig,
  bundle: WikiFlowBundle,
  narrative?: WikiNarrative): Promise<PageDraft> {
  const flow = bundle.primary;
  const cites: WikiCitation[] = [];
  const lines: string[] = [`# ${input.displayName} 语义级代码指南`, "", flowBanner(input, bundle), ""];
  if (narrative) lines.push(renderNarrative(narrative));

 // ---- 问答式组装(通用机制):按读者自然问题顺序,信号层驱动,哪类信号在场呈现哪类 ----
  const surfaces = bundle.surfaces;
  const SHAPE_LABEL: Record<string, string> = { service: "HTTP 服务", cli: "命令行/脚本", mixed: "服务 + 命令行", library: "库(被别人 import)" };
  lines.push("## 一、这个项目是什么、干什么用", "");
  lines.push(`> 形态:**${SHAPE_LABEL[surfaces?.shape ?? "library"] ?? "库"}** · ${input.sourceFiles.length} 个源文件 · ${input.modules.length} 个模块;一句话定位见页首导读(LLM,带引用)。`, "");
  lines.push("## 二、怎么跑起来(入口在哪)", "");
  if (surfaces && (surfaces.inSurfaces.length > 0 || surfaces.outSurfaces.length > 0)) {
    lines.push(`> 进来 ${surfaces.inSurfaces.length} 个入口面(写端点/进程入口)/ 出去 ${surfaces.outSurfaces.length} 个出口面(读端点)${surfaces.httpFrameworks.length ? `;框架 ${surfaces.httpFrameworks.join("/")}` : ""}。全部 file:line 可回源。`, "");
    lines.push("| 入口面 | 类型 | 位置 | 说明 |", "| --- | --- | --- | --- |");
    for (const e of surfaces.inSurfaces.slice(0, 12)) {
      const c = await citeAt(cache, e.file, e.line);
      if (c) cites.push(c);
      lines.push(`| ${e.name} | ${e.kind === "process" ? "进程/CLI" : e.kind === "ws" ? "WebSocket" : e.kind === "root" ? "组合根" : "写端点"} | ${e.file}:${e.line} | ${e.detail ? esc(e.detail) : ""} |`);
    }
    if (surfaces.inSurfaces.length > 12) lines.push(`| … | 还有 ${surfaces.inSurfaces.length - 12} 个 | | |`);
    lines.push("");
  } else {
    lines.push("> 未检出 HTTP 端点/进程入口(库形态):被其它仓 import 使用;公开能力见「入口与运行」与模块页。", "");
  }
  for (const item of input.hints.run.slice(0, 5)) {
    const c = await citeAt(cache, item.file, item.line);
    if (c) cites.push(c);
  }

  // ---- Q3+Q4:什么进来/出去 + 有哪些处理管线(管线簇) ----
  if (surfaces && surfaces.outSurfaces.length > 0) {
    lines.push("## 三、什么进来、什么出去", "");
    lines.push("| 出口面 | 类型 | 位置 | 说明 |", "| --- | --- | --- | --- |");
    for (const e of surfaces.outSurfaces.slice(0, 8)) {
      const c = await citeAt(cache, e.file, e.line);
      if (c) cites.push(c);
      lines.push(`| ${e.name} | 读端点 | ${e.file}:${e.line} | ${e.detail ? esc(e.detail) : ""} |`);
    }
    if (surfaces.outSurfaces.length > 8) lines.push(`| … | 还有 ${surfaces.outSurfaces.length - 8} 个 | | |`);
    lines.push("");
  }
  if (surfaces && surfaces.pipelines.length > 0) {
    lines.push(`## ${surfaces.outSurfaces.length > 0 ? "四" : "三"}、有哪些处理管线(入 → 处理 → 存储)`, "");
    lines.push("> 管线=入界面出发的 file 级下游链,按下游重叠度聚类(共享处理链的入口归为一族);d0=接入 → d1=处理 → d2+=核心/存储。", "");
    lines.push("| 管线 | 触发面 | 分层(d0→d2) | 存储/核心 |", "| --- | --- | --- | --- |");
    for (const p of surfaces.pipelines) {
      const layerText = p.layers.map((l) => `d${l.depth}:${l.files.slice(0, 2).join("|")}${l.hub ? `(枢纽 ${l.hub})` : ""}`).join(" → ");
      lines.push(`| ${p.title} | ${p.triggers.map((t) => t.name).slice(0, 3).join(", ")}${p.triggers.length > 3 ? ` 等${p.triggers.length}` : ""} | ${layerText} | ${p.sinks.slice(0, 2).join(", ") || "-"} |`);
    }
    lines.push("", "最大一簇的完整图(其余见「功能拆解」页):", "");
    lines.push(...mermaidBlock(surfaces.pipelines[0]!.mermaid));
    lines.push("");
  } else {
    lines.push(`## ${surfaces && surfaces.outSurfaces.length > 0 ? "四" : "三"}、有哪些处理管线`, "");
    lines.push("> 未检出可聚类的下游链(零入界面/库形态);主调用结构见下节模块图。", "");
  }

  lines.push("## 五、代码怎么组织(模块与分层)", "");
  lines.push("> 模块名下方斜体=作用/角色:有 package.json/README/模块 docstring 用原文;`≈`=名称/拓扑推断(来源见表)。", "");
  const moduleFlow = bundle.moduleFlow;
  lines.push(...mermaidBlock(renderCodeFlowMermaid(moduleFlow, { legend: false })));
  lines.push(
    "| 层 | 模块 | 规模提示(文件数 · 符号数) | 入口/枢纽 | 作用/角色(来源) |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const n of moduleFlow.nodes.slice(0, 24)) {
    const role = n.entry ? "入口" : n.in > 0 ? `被 ${n.in} 个上游依赖` : n.out > 0 ? "下游装载器" : "内部闭环";
    const note = bundle.moduleNotes[n.label];
    const doc = note
      ? `${note.text}(${MODULE_NOTE_SOURCE_LABEL[note.source]})`
      : (bundle.moduleDocs[n.label] ?? "");
    lines.push(`| d${n.depth < 0 ? "?" : n.depth} | ${n.label} | ${n.files ?? "-"} · ${n.symbols ?? "-"} | ${role} | ${doc} |`);
  }
  lines.push("");

  lines.push("## 六、按功能线阅读(=管线簇)", "");
  lines.push("| # | 功能线 | 入口 | 下游模块 | 关键文件 |", "| --- | --- | --- | --- | --- |");
  const sem = new Map((narrative?.features ?? []).map((f) => [f.id, f]));
  bundle.features.forEach((f, i) => {
    const name = sem.get(f.id)?.name ?? f.title;
    lines.push(`| F${i + 1} | ${name} | ${f.entry.label} | ${f.modules.filter((m) => m !== f.entry.label).slice(0, 6).join(", ")} | ${f.files.slice(0, 3).join(", ")} |`);
  });
  lines.push("");

  lines.push("## 七、推荐阅读顺序", "");
  const entryFiles = [...new Set([
    ...flow.nodes.filter((n) => n.entry && n.file).map((n) => n.file!),
    ...bundle.featureFiles,
    ...bundle.llmFiles,
  ])].slice(0, 12);
  entryFiles.forEach((f, i) => lines.push(`${i + 1}. \`${f}\` — ${flow.nodes.find((n) => n.file === f)?.label ?? "入口/热点文件"}`));
  lines.push("");
  lines.push("> 先读入口 → 再顺着图读下游模块 → 最后按功能线看关键函数;每一步的 file:line 都来自静态索引,可点开回源。", "");

  const sources = [...new Set([...entryFiles, ...bundle.featureFiles])].slice(0, 20);
  const finalCites = await ensureMinCitations(input, cache, cites, 5, sources);
  lines.push(pageFooter(finalCites));
  return {
    id: "guide",
    title: `${input.displayName} 语义级代码指南`,
    kind: "guide",
    section: "guide",
    order: 60,
    file: "guide.md",
    summary: narrative?.summary || `入口 ${flow.entries.length} 条 · 功能线 ${bundle.features.length} 条 · 分层 d0-d${Math.max(0, ...flow.nodes.map((n) => n.depth))}`,
    markdown: lines.join("\n"),
    citations: finalCites,
    sources,
    generator: narrative ? "llm+validated" : "deterministic",
    llm: narrative ? "on" : "off",
  };
}

/** 功能拆解页:每个入口一条功能线 + 子图 + 关键函数;LLM 只补语义解读。 */
export async function buildFeaturesPage(
  input: WikiInput,
  cache: SourceCache,
  config: WikiConfig,
  bundle: WikiFlowBundle,
  narrative?: WikiNarrative): Promise<PageDraft> {
  const cites: WikiCitation[] = [];
  const lines: string[] = [`# ${input.displayName} 功能拆解`, "", flowBanner(input, bundle), ""];
  if (narrative) lines.push(renderNarrative(narrative));

  const sem = new Map((narrative?.features ?? []).map((f) => [f.id, f]));
  for (const sf of narrative?.features ?? []) cites.push(...sf.cites);
  lines.push("## 功能线总览", "");
  lines.push("| # | 功能线(管线) | 触发面 | 类型 | 触达 | 关键文件 |", "| --- | --- | --- | --- | --- | --- |");
  bundle.features.forEach((f, i) => {
    const name = sem.get(f.id)?.name ?? f.title;
    const triggerText = (f.triggers ?? [{ name: f.entry.label }]).map((t) => t.name).slice(0, 3).join(", ");
    const triggerCount = f.triggers?.length ?? 1;
    lines.push(`| F${i + 1} | ${name} | ${triggerText}${triggerCount > 3 ? ` 等${triggerCount}` : ""} | ${entryKindLabel(f.entry.kind)} | ${f.reach} | ${f.files.slice(0, 3).join(", ")} |`);
  });
  lines.push("");
  lines.push("> 功能线=**管线簇**:入界面(写端点/进程入口)→ 下游闭包 → 按重叠度聚类(共享处理链的入口归为一族);d0=接入 → d1=处理 → d2+=核心/存储。LLM 的语义命名只在下方解读小节,不改这张表。", "");

  for (let i = 0; i < bundle.features.length; i++) {
    const f = bundle.features[i]!;
    const sf = sem.get(f.id);
    lines.push(`## F${i + 1} · ${sf?.name ?? f.title}`, "");
    if (sf) {
      lines.push(`- **语义描述**: ${sf.description}`);
      lines.push(`- **确定性入口**: ${f.title}`);
    }
    if (f.triggers && f.triggers.length > 0) {
      lines.push(`- **触发面**(${f.triggers.length} 个): ${f.triggers.slice(0, 6).map((t) => `${t.name} @ ${t.file}:${t.line}`).join("; ")}${f.triggers.length > 6 ? ` …+${f.triggers.length - 6}` : ""}`);
      for (const t of f.triggers.slice(0, 4)) {
        const c = await citeAt(cache, t.file, t.line);
        if (c) cites.push(c);
      }
    }
    lines.push(`- **入口**: ${f.entry.label}(${entryKindLabel(f.entry.kind)}${f.entry.file ? ` @ ${f.entry.file}${f.entry.line ? ":" + f.entry.line : ""}` : ""})`);
    lines.push(`- **主干路径**: ${f.path.join(" → ")}`);
    lines.push(`- **下游模块**: ${f.modules.filter((m) => m !== f.entry.label).join(", ") || "(无跨模块下游)"}`);
    lines.push(`- **关键文件**: ${f.files.map((x) => `\`${x}\``).join(", ") || "(无可定位文件)"}`);
    if (f.symbols.length > 0) {
      lines.push(`- **关键函数**: ${f.symbols.map((s) => `\`${s.name}\` @ ${s.file}:${s.line}`).join("; ")}`);
      for (const s of f.symbols.slice(0, 6)) {
        const c = await citeAt(cache, s.file, s.line);
        if (c) cites.push(c);
      }
    }
    if (f.entry.file && f.entry.line) {
      const c = await citeAt(cache, f.entry.file, f.entry.line);
      if (c) cites.push(c);
    }
    lines.push("");
    lines.push(...mermaidBlock(f.mermaid));
  }

  const sources = [...new Set([...bundle.featureFiles, ...bundle.features.map((f) => f.entry.file ?? "")].filter(Boolean))].slice(0, 20);
  const finalCites = await ensureMinCitations(input, cache, cites, 5, sources);
  lines.push(pageFooter(finalCites));
  return {
    id: "features",
    title: `${input.displayName} 功能拆解`,
    kind: "features",
    section: "features",
    order: 70,
    file: "features.md",
    summary: `${bundle.features.length} 条功能线(入口可达子图;确定性拆解)`,
    markdown: lines.join("\n"),
    citations: finalCites,
    sources,
    generator: narrative ? "llm+validated" : "deterministic",
    llm: narrative ? "on" : "off",
  };
}

/**
 * 管线「关键流程图」页:函数体语句级 CFG——真实语句/条件菱形/是·否/
 * 循环回边/try-catch/return-throw;长函数分页(不丢节点)。功能线语义名仍由 features 页承载,
 * 本页只负责「这条管线在代码里到底怎么走」。
 */
export async function buildPipelineCfgPage(
  input: WikiInput,
  cache: SourceCache,
  config: WikiConfig,
  cfg: WikiPipelineCfg): Promise<PageDraft> {
  const cites: WikiCitation[] = [];
  const totalNodes = cfg.functions.reduce((a, f) => a + f.nodes.length, 0);
  const totalDiagrams = cfg.functions.reduce((a, f) => a + (f.pages?.length ?? 1), 0);
  const lines: string[] = [
    `# 管线 ${cfg.title} · 关键流程图`,
    "",
    metaLine(input, "确定性骨架", `管线触达 ${cfg.reach} 文件 · 关键函数 ${cfg.functions.length} 个 · ${totalNodes} 节点/${totalDiagrams} 张图 · 长函数分页不丢节点`),
    "",
    "## 这条管线怎么走", "",
    `> 触发面 ${cfg.triggers.length} 个;分层 ${cfg.layers.map((l) => `d${l.depth}: ${l.files.slice(0, 2).join(", ")}`).join(" → ")}。下面按「入口优先 + 复杂度」选 ${cfg.functions.length} 个函数,画到语句级。功能线语义名/一句话能力见「功能拆解」页。`, "",
  ];
  if (cfg.triggers.length > 0) {
    lines.push("| 触发面 | 类型 | 位置 |", "| --- | --- | --- |");
    for (const t of cfg.triggers.slice(0, 10)) {
      const c = await citeAt(cache, t.file, t.line);
      if (c) cites.push(c);
      lines.push(`| ${t.name} | ${t.kind} | ${t.file}:${t.line} |`);
    }
    lines.push("");
  }
  lines.push("## 怎么读这些图", "");
  lines.push("- **菱形**=条件/循环(边上「是/否/进入/退出/循环」);**紫框**=循环体;**绿框**=try;**红框**=catch;**蓝框**=调用;**绿/红**=返回/抛出;**黄框**=函数速览/模块常量。");
  lines.push("- 框里是**源码原文压缩**(不是摘要);`file:line` 可回源。");
  lines.push("- **函数速览是确定性摘录**:职责=源码注释首句,输入=签名参数,输出=return 表达式,关键判断/循环=CFG,副作用=调用名启发式,上下游=静态索引;没有的写「—/索引未提供」,无注释就写「未写源码注释」,不编造。完整注释见 `codesense cfg <函数> --json`。");
  lines.push("- 函数超过 ~22 个节点自动分页,跨页边是「←/→ 第 N 页」跳转桩;**节点/边不删**;完整单图可用 `codesense cfg <函数> --full` 导出。", "");

  // 关键函数一览(参考 deepwiki-open 的 Key Functions 表:先给读者一张总表,再看逐函数细节)
  lines.push("## 关键函数一览", "");
  lines.push("| # | 函数 | 职责(源码注释首句) | 输入 → 输出 | 判断/循环 | 位置 |", "| --- | --- | --- | --- | --- | --- |");
  for (let i = 0; i < cfg.functions.length; i++) {
    const fn = cfg.functions[i]!;
    const d = fn.description;
    const input = d.params.slice(0, 4).map((p) => p.name || p.raw).join(", ") + (d.params.length > 4 ? ` …+${d.params.length - 4}` : "");
    const output = cfgReturnSummary(d);
    lines.push(`| ${i + 1} | ${esc(fn.name)} | ${esc(d.purpose)} | ${esc(`${input || "—"} → ${output}`)} | ${d.keyConditions.length}/${d.loops.length} | ${fn.file}:${fn.line} |`);
  }
  lines.push("");

  for (let i = 0; i < cfg.functions.length; i++) {
    const fn = cfg.functions[i]!;
    lines.push(`## 函数 ${i + 1}/${cfg.functions.length} · ${fn.name} — ${fn.file}:${fn.line}`, "");
    lines.push(
      `> ${fn.file}:${fn.line}-${fn.lineEnd} · 语句 ${fn.stats.statements} · 决策 ${fn.stats.decisions}` +
      ` · 循环 ${fn.stats.loops} · 复杂度 ${fn.stats.complexity} · 返回 ${fn.stats.returns} · 抛出 ${fn.stats.throws}` +
      (fn.pages ? ` · 分页 ${fn.pages.length} 页` : ""),
      "",
    );
    lines.push("### 函数速览", "");
    lines.push("| 项 | 内容 |", "| --- | --- |");
    for (const row of cfgDescriptionRows(fn, true)) lines.push(`| ${row.label} | ${row.value} |`);
    lines.push("");
    if (fn.description.details) {
      lines.push("#### 源码注释 / 设计备注", "", fn.description.details, "");
    }
    const c = await citeAt(cache, fn.file, fn.line);
    if (c) cites.push(c);
    if (fn.pages && fn.pages.length > 1) {
      for (const p of fn.pages) lines.push(`### ${p.title}`, "", ...mermaidBlock(p.mermaid));
    } else {
      lines.push(...mermaidBlock(renderCfgMermaid(fn)));
    }
    lines.push(`> 已知边界: ${fn.knownLimits.slice(0, 3).join(" ")}`, "");
  }

  lines.push("## 候选函数(选择过程)", "");
  lines.push("> 从管线文件里按「入口优先 + 决策×3+语句+调用」选前 N;未入选/未能定位的也列出来,不假装只有这几个函数。", "");
  lines.push("| 函数 | 位置 | 语句 | 决策 | 节点 | 分数 | 选中 | 说明 |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const c of cfg.candidates.slice(0, 24)) {
    lines.push(`| ${c.name} | ${c.file}:${c.line} | ${c.statements} | ${c.decisions} | ${c.nodes} | ${c.score} | ${c.picked ? "✓" : ""} | ${esc(c.reason ?? "")} |`);
  }
  if (cfg.candidates.length > 24) lines.push(`| … | 还有 ${cfg.candidates.length - 24} 个候选(封顶 24 行) | | | | | | |`);
  lines.push("");
  for (const n of cfg.notes) lines.push(`- ${n}`);
  lines.push("");

  const sources = [...new Set([...cfg.functions.map((f) => f.file), ...cfg.triggers.map((t) => t.file)])].slice(0, 20);
  const finalCites = await ensureMinCitations(input, cache, cites, 5, sources);
  lines.push(pageFooter(finalCites));
  return {
    id: `cfg/${cfg.pipelineId}`,
    title: `管线 ${cfg.title} · 关键流程图`,
    kind: "algo",
    section: "algo",
    order: 75,
    file: `cfg/${cfg.pipelineId}.md`,
    summary: `${cfg.functions.length} 个关键函数 · ${totalNodes} 节点 · ${totalDiagrams} 张图(确定性语句级 CFG)`,
    markdown: lines.join("\n"),
    citations: finalCites,
    sources,
    generator: "deterministic",
    llm: "off",
  };
}