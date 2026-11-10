/**
 * 模块作用注记(2026-10-27):flow 模块图节点旁的一句话「这个模块是干什么的」。
 *
 * 为什么(用户口径):只看模块名 + 「21 文件/329 符号」读不出职责;模块作用要标在图旁边。
 *
 * 来源优先级(全部确定性,不调 LLM):
 *   1. package.json description(TS/JS monorepo 的权威一句话)
 *   2. 模块 README(首个有意义的标题/段落)
 *   3. Python __init__.py 的 docstring / 顶部注释(跳过 license 头)
 *   4. 名称线索(gateway/code-sense/runtime/model/...)
 *   5. 拓扑角色(入口/核心/编排/叶子/内部)
 * 1-3 是文档原文;4-5 是推断——调用方用 `moduleAnnotationText` 给推断值加 ≈,
 * 页面表格单独列来源,不把推断冒充文档。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeFlow, FlowNode } from "./flow";

export type ModuleNoteSource = "package.json" | "docstring" | "readme" | "topology" | "name";

export interface ModuleNote {
  text: string;
  source: ModuleNoteSource;
}

const MAX_READ = 200_000;

function readText(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const t = readFileSync(path, "utf8");
    return t.length > MAX_READ ? t.slice(0, MAX_READ) : t;
  } catch {
    return undefined;
  }
}

/** 去 Markdown 噪音/HTML 注释/徽章,压成一行。 */
function cleanNote(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clipNote(s: string, max = 80): string {
  const t = cleanNote(s);
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function packageNote(root: string, dir: string): string | undefined {
  const text = readText(join(root, dir, "package.json"));
  if (!text) return undefined;
  try {
    const j = JSON.parse(text) as { description?: unknown };
    if (typeof j.description === "string" && j.description.trim()) return clipNote(j.description);
  } catch {
    // 坏的 package.json:当没有,不当空
  }
  return undefined;
}

function sameModuleName(text: string, module: string): boolean {
  const norm = (s: string): string => s.toLowerCase().replace(/^@[^/]+\//, "").replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
  const a = norm(text);
  const b = norm(module.split("/").pop() ?? module);
  return !!a && (a === b || b.endsWith(a) || a.endsWith(b));
}

function readmeNote(text: string, module: string): string | undefined {
  const lines = text.split(/\r?\n/).slice(0, 60).map((l) => l.trim()).filter(Boolean);
  const heading = lines.find((l) => /^#\s+/.test(l));
  if (heading) {
    const h = cleanNote(heading.replace(/^#+\s*/, ""));
    // 只认破折号/冒号/「 - 」,不能把模块名里的连字符当分隔符(pkg-readme → readme 的坑)
    const m = /^(.*?)\s*(?:[—–]|\s-\s|::?)\s*(.+)$/.exec(h);
    if (m?.[2] && m[2].trim().length >= 4) return clipNote(m[2]);
    if (h && !sameModuleName(h, module)) return clipNote(h);
  }
  const para = lines.find((l) => {
    if (/^#|^```|^!\[|^\[!\[|^<|^\|/.test(l)) return false;
    if (/copyright|license|licensed|all rights reserved/i.test(l)) return false;
    const clean = cleanNote(l);
    return clean.length >= 8 && !sameModuleName(clean, module);
  });
  return para ? clipNote(para) : undefined;
}

function pythonNote(text: string): string | undefined {
  // 跳过文件头注释/空行后的 docstring
  const m = /^(?:\s*#[^\n]*\n|\s*\n)*(?:"""([\s\S]*?)"""|'''([\s\S]*?)''')/.exec(text);
  if (m) {
    const body = (m[1] ?? m[2] ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const first = body[0] ?? "";
    const second = body[1] ?? "";
    // 第一行很短时补第二行(如「自动记忆机制模块」+「提供记忆提取/缓存/管理」)
    const merged = first.length <= 12 && second && (first + second).length <= 80 ? `${first};${second}` : first;
    if (merged) return clipNote(merged);
  }
  // 顶部 # 注释块:跳过 license/copyright,取第一条描述
  const comments: string[] = [];
  for (const line of text.split(/\r?\n/).slice(0, 40)) {
    const t = line.trim();
    if (!t) {
      if (comments.length > 0) break;
      continue;
    }
    if (!t.startsWith("#")) {
      if (comments.length > 0) break;
      continue;
    }
    comments.push(t.replace(/^#+\s?/, ""));
  }
  const useful = comments.find((x) =>
    x.length >= 6 &&
    !/copyright|license|licensed|permission|warrant|limitations|http|www\.|unless|distributed|all rights reserved/i.test(x)
  );
  return useful ? clipNote(useful) : undefined;
}

const NAME_HINTS: [RegExp, string][] = [
  [/code-?sense-cli|(^|[-_/])cli($|[-_/])/i, "CLI 适配层"],
  [/gateway|server|api|service/i, "服务/API 与编排层"],
  [/code-?sense|sense/i, "代码索引与感知"],
  [/session/i, "会话执行/调度"],
  [/runtime/i, "运行时/任务调度"],
  [/protocol/i, "协议与类型契约"],
  [/experience|(^|[-_/])memo($|[-_/])/i, "经验/记忆沉淀"],
  [/terminal|shell/i, "终端/命令执行"],
  [/workflow/i, "工作流编排"],
  [/executor|execution/i, "执行器"],
  [/node-agent|agent/i, "节点/代理"],
  [/relay/i, "中继/转发"],
  [/lsp/i, "语言服务/LSP"],
  [/desktop|electron/i, "桌面壳/客户端"],
  [/web|ui|panel|front/i, "界面层"],
  [/dialogue|dialog/i, "对话/交互记忆"],
  [/model|llm|train|infer|speech|voice|audio/i, "模型/推理/训练"],
  [/vision|face|video/i, "视觉/视频处理"],
  [/memory|store|db|database|repo|persist|cache/i, "记忆/存储层"],
  [/notebook/i, "笔记本/记录"],
  [/docs?|readme/i, "文档"],
  [/scripts?|tools?/i, "脚本/运维工具"],
  [/test|spec/i, "测试"],
  [/util|common|shared|helper|lib/i, "工具库"],
  [/core/i, "核心库"],
];

function nameNote(label: string): string | undefined {
  for (const [re, text] of NAME_HINTS) if (re.test(label)) return text;
  return undefined;
}

function topologyNote(n: FlowNode): string {
  if (n.entry) return "入口/启动装配";
  if (n.in >= 3) return `核心/被 ${n.in} 个上游依赖`;
  if (n.out >= 3 && n.in === 0) return `编排层:调用 ${n.out} 个模块`;
  if (n.outCalls === 0) return "叶子/工具库";
  return "内部模块";
}

/** 模块级 flow → 每个模块一句话作用;非模块级返回空。 */
export function moduleNotes(
  root: string,
  flow: CodeFlow,
  opts: { docs?: Record<string, string> } = {},
): Record<string, ModuleNote> {
  if (flow.level !== "module") return {};
  const out: Record<string, ModuleNote> = {};
  for (const n of flow.nodes) {
    if (n.label === "<module>") continue;
    const label = n.label;
    const isRoot = /^\(?root\)?$/i.test(label);
    const dir = isRoot ? "" : label;
    const docs = opts.docs?.[label];
    if (docs?.trim()) {
      out[label] = { text: clipNote(docs), source: "package.json" };
      continue;
    }
    const pkg = packageNote(root, dir);
    if (pkg) {
      out[label] = { text: pkg, source: "package.json" };
      continue;
    }
    const readme = readText(join(root, dir, "README.md"));
    const rn = readme ? readmeNote(readme, label) : undefined;
    if (rn) {
      out[label] = { text: rn, source: "readme" };
      continue;
    }
    const init = readText(join(root, dir, "__init__.py"));
    const py = init ? pythonNote(init) : undefined;
    if (py) {
      out[label] = { text: py, source: "docstring" };
      continue;
    }
    if (isRoot) {
      out[label] = { text: "仓库根/组合根", source: "name" };
      continue;
    }
    const name = nameNote(label);
    if (name) {
      out[label] = { text: name, source: "name" };
      continue;
    }
    out[label] = { text: topologyNote(n), source: "topology" };
  }
  return out;
}

/** 图内注记文本:推断来源加 ≈ 前缀,文档来源原样。 */
export function moduleAnnotationText(note: ModuleNote): string {
  return `${note.source === "name" || note.source === "topology" ? "≈ " : ""}${note.text}`;
}

export const MODULE_NOTE_SOURCE_LABEL: Record<ModuleNoteSource, string> = {
  "package.json": "package.json",
  docstring: "模块 docstring",
  readme: "README",
  name: "名称推断",
  topology: "拓扑推断",
};
