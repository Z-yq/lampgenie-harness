/**
 * senseB22:app 路由画像(前端路由表。
 * 盲区:panel.ts 这类零构建单文件 SPA 没有路由框架(无 React Router/Vue Router 配置),
 * 路由=自写 switchView(name) + data-view 属性 + act-* 按钮接线——pageflow 的三形态
 * (HTML 多页/React/Vue)全不命中,前端结构感知为零。本模块消费 senseB21 的内嵌脚本
 * 提取与 tree-sitter javascript AST,识别这类自写路由:
 *   - 路由器函数:function 名命中 switchView/setView/… 族,或函数体含 `dataset.view =`
 * 赋值(panel 依据:switchView 内 `document.body.dataset.view = name`);
 *   - 视图清单:路由器形参的 `param === "字面量"` 收敛守卫 ∪ 路由器调用点字面量实参
 *     ∪ 宿主文件 HTML/CSS 的 id="view-*" / data-view="*";
 *   - 打开函数:各 switchView("x") 调用点的最内层包围具名函数(newDraft/openSession…);
 *     顶层接线归「模块级」,同时识别 `$("act-xxx").onclick =` 触发器;
 *   - 入口渲染函数:路由器体内 `if (name === "x") { fn(); }` 守卫分支内的调用
 * (board→boardRefresh/overlayPull、pipeline→renderPipeline 依据)。
 * 确定性提取,零 LLM;未检出路由器=显式降级说明,不猜。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Project } from "ts-morph";
import { extractInlineJsUnits, parseInlineJsAst, inlineJsTextCandidate, type JsNode, type InlineJsDecl } from "../callgraph/inline-js";

/** 自写路由器函数名族(常见命名;函数体信号是第二判据)。 */
const ROUTER_NAME_RE = /^(switchView|setView|changeView|showView|goToView|goView|activateView|setActiveView|selectView|switchTab|setTab|switchPage|setPage)$/;
/** 路由器函数体信号:`dataset.view =` / `.view =` 赋值(SPA data-view 惯用法)。 */
const ROUTER_BODY_RE = /dataset\.view\s*=|\.view\s*=\s*[a-zA-Z$_]/;
/** 宿主 HTML/CSS 的视图属性: id="view-x" / data-view="x"。 */
const VIEW_ATTR_RE = /(?:id|data-view)\s*=\s*"view-([\w-]+)"|data-view\s*=\s*"([\w-]+)"/g;
/** 触发器接线:`$("act-x").onclick =` / `getElementById("act-x").onclick =`。 */
const TRIGGER_RE = /\$\s*\(\s*["']([\w-]+)["']\s*\)\.(?:onclick|addEventListener)|getElementById\s*\(\s*["']([\w-]+)["']\s*\)\.onclick/;

export interface AppRouteOpen {
  /** 打开该视图的函数名;顶层接线=「(模块级)」。 */
  fn: string;
  /** switchView("x") 调用点宿主行。 */
  line: number;
  /** 触发器元素 id($("act-x").onclick 接线形态)。 */
  trigger?: string;
}
export interface AppRouteEntry {
  /** 路由器守卫分支内的入口渲染/加载函数名。 */
  name: string;
  /** 定义处宿主行(同单元声明表定位;未在本单元声明=调用行)。 */
  line: number;
}
export interface AppRoute {
  view: string;
  file: string;
  opens: AppRouteOpen[];
  entries: AppRouteEntry[];
}
export interface AppRoutesResult {
  router: { name: string; file: string; line: number } | null;
  routes: AppRoute[];
  /** 参与扫描的 ts/js 文件数(预闸后建 AST 的候选)。 */
  scannedFiles: number;
  /** 提取到的内嵌 JS 单元数。 */
  units: number;
  degraded: string[];
}

function childrenOf(node: JsNode): JsNode[] {
  const c = node.children;
  return typeof c === "function" ? c.call(node) : (c ?? []);
}

/** 字符串字面量节点的值(去引号;非字符串节点=undefined)。 */
function stringLit(node: JsNode | undefined): string | undefined {
  if (!node || (node.type !== "string" && node.type !== "string_fragment")) return undefined;
  const t = node.text;
  return t.length >= 2 ? t.slice(1, -1) : t;
}

/** 最内层包围声明(区间包含判定;senseB21 的 decls 表复用)。 */
function enclosingDecl(decls: InlineJsDecl[], idx: number): InlineJsDecl | undefined {
  let best: InlineJsDecl | undefined;
  for (const d of decls) {
    if (idx >= d.startIdx && idx < d.endIdx) {
      if (!best || d.endIdx - d.startIdx < best.endIdx - best.startIdx) best = d;
    }
  }
  return best;
}

/** 沿 parent 链向上找最近的指定类型节点(≤8 跳,防跨出函数体)。 */
function ancestorOfType(node: JsNode, types: string[], maxHops = 8): JsNode | null {
  let cur = node.parent;
  for (let i = 0; cur && i < maxHops; i++) {
    if (types.includes(cur.type)) return cur;
    cur = cur.parent;
  }
  return null;
}

/** 子树内调用名清单(去重保序;过滤路由器自身/纯 DOM·序列化噪声;row=单元内 0-based 行)。 */
const ENTRY_NOISE = new Set(["$", "classList", "addEventListener", "querySelector", "querySelectorAll", "getElementById", "setTimeout", "setInterval", "focus", "toggle", "log", "stringify", "parse", "String", "Number", "Boolean", "Array", "Object", "encodeURIComponent", "decodeURIComponent", "JSON"]);
function callsIn(node: JsNode, routerName: string): { name: string; row: number }[] {
  const out: { name: string; row: number }[] = [];
  const seen = new Set<string>();
  for (const c of node.descendantsOfType("call_expression")) {
    const t = childrenOf(c)[0]?.text?.trim();
    if (!t) continue;
    const name = t.includes(".") ? t.split(".").at(-1)! : t;
    if (name === routerName || seen.has(name) || ENTRY_NOISE.has(name)) continue;
    if (!/^[$_\w][$\w]*$/.test(name)) continue;
    seen.add(name);
    out.push({ name, row: c.startPosition.row });
  }
  return out;
}

interface UnitRoutes {
  router: { name: string; row: number } | null;
  views: Map<string, { opens: AppRouteOpen[]; entries: AppRouteEntry[] }>;
}

/** 单个内嵌单元的路由提取(AST 确定性;无路由器=空结果)。 */
function routesOfUnit(
  unit: { js: string; startLine: number },
  decls: InlineJsDecl[],
  root: JsNode): UnitRoutes {
  const views = new Map<string, { opens: AppRouteOpen[]; entries: AppRouteEntry[] }>();
  const viewOf = (v: string): { opens: AppRouteOpen[]; entries: AppRouteEntry[] } => {
    let e = views.get(v);
    if (!e) {
      e = { opens: [], entries: [] };
      views.set(v, e);
    }
    return e;
  };
  // ① 路由器函数判定(名字族 ∪ 体信号)
  let routerFn: JsNode | null = null;
  let routerName = "";
  for (const f of root.descendantsOfType("function_declaration")) {
    const name = childrenOf(f).find((c) => c.type === "identifier")?.text ?? "";
    if (ROUTER_NAME_RE.test(name) || ROUTER_BODY_RE.test(f.text)) {
      routerFn = f;
      routerName = name;
      break;
    }
  }
  if (!routerFn) return { router: null, views };
  // 形参名(守卫字面量判定的锚)
  const params = routerFn.descendantsOfType("formal_parameters")[0];
  const paramName = params ? childrenOf(params).find((c) => c.type === "identifier")?.text ?? "" : "";
  // ② 守卫字面量:name === "x"(路由器体内;含三元的 === 收敛)
  if (paramName) {
    for (const bin of routerFn.descendantsOfType("binary_expression")) {
      const kids = childrenOf(bin);
      if (kids.length !== 3 || kids[1]!.text !== "===") continue;
      const [l, , r] = kids as [JsNode, JsNode, JsNode];
      let lit: string | undefined;
      if (l.type === "identifier" && l.text === paramName) lit = stringLit(r);
      else if (r.type === "identifier" && r.text === paramName) lit = stringLit(l);
      if (!lit) continue;
      const slot = viewOf(lit);
      // 守卫分支内的调用=该视图入口渲染/加载函数(if_statement/三元/表达式语句为界)
      const scope = ancestorOfType(bin, ["if_statement", "conditional_expression"])
        ?? ancestorOfType(bin, ["expression_statement", "for_statement", "switch_case"]);
      if (!scope) continue;
      for (const call of callsIn(scope, routerName)) {
        const def = decls.find((d) => d.name === call.name);
        const line = unit.startLine + (def ? def.row : call.row);
        if (!slot.entries.some((e) => e.name === call.name)) slot.entries.push({ name: call.name, line });
      }
    }
  }
  // ③ 路由器调用点:打开函数 + 触发器
  for (const call of root.descendantsOfType("call_expression")) {
    const callee = childrenOf(call)[0]?.text?.trim();
    if (callee !== routerName) continue;
    // call_expression children: [函数表达式, arguments];arguments 含 "(" ")" 匿名 token,
    // 具名首参=第一个 string 子节点
    const argsNode = childrenOf(call)[1];
    const lit = stringLit(argsNode ? childrenOf(argsNode).find((c) => c.type === "string") : undefined);
    if (!lit) continue; // 动态视图名(switchView(cond ? "a" : "b")):不猜
    const hostLine = unit.startLine + call.startPosition.row;
    const encl = enclosingDecl(decls, call.startIndex);
    let trigger: string | undefined;
    const stmt = ancestorOfType(call, ["expression_statement"]);
    if (stmt) {
      const tm = TRIGGER_RE.exec(stmt.text);
      trigger = tm?.[1] ?? tm?.[2] ?? undefined;
    }
    viewOf(lit).opens.push({ fn: encl ? encl.name : "(模块级)", line: hostLine, ...(trigger ? { trigger } : {}) });
  }
  const routerDecl = decls.find((d) => d.name === routerName);
  return { router: { name: routerName, row: routerDecl ? routerDecl.row : 0 }, views };
}

/** 候选文件上限(全仓文本预闸后的建 AST 面;panel 级单文件 1MB 无压力)。 */
const MAX_CANDIDATE_FILES = 300;

/** app 路由画像主入口:确定性提取,零 LLM。files 缺省=自扫描(scanProject 同源扩展名面)。 */
export async function queryAppRoutes(root: string, files?: string[]): Promise<AppRoutesResult> {
  const degraded: string[] = [];
  let list = files;
  if (!list) {
    const { scanProject } = await import("../project");
    list = (await scanProject(root)).files;
  }
  const tsFiles = list.filter((f) => /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(f));
  // 文本预闸:inlineJsTextCandidate(含 <script> 或 form-B 密度门)
  const candidates: string[] = [];
  const texts = new Map<string, string>();
  for (const f of tsFiles) {
    if (candidates.length >= MAX_CANDIDATE_FILES) {
      degraded.push(`候选文件封顶 ${MAX_CANDIDATE_FILES}(其余文件未扫描)`);
      break;
    }
    try {
      const text = await readFile(join(root, f), "utf-8");
      if (text.length > 2 * 1024 * 1024) continue;
      if (!inlineJsTextCandidate(text)) continue;
      candidates.push(f);
      texts.set(f, text);
    } catch {
      /* 读失败:跳过 */
    }
  }
  const result: AppRoutesResult = { router: null, routes: [], scannedFiles: candidates.length, units: 0, degraded };
  if (candidates.length === 0) {
    degraded.push("未发现内嵌脚本单元(模板字符串 <script>/JS 段)——无 SPA 路由可提取");
    return result;
  }
  const project = new Project({ skipAddingFilesFromTsConfig: true });
  for (const f of candidates) {
    try {
      project.addSourceFileAtPath(join(root, f));
    } catch {
      /* 单文件解析失败:跳过 */
    }
  }
  for (const f of candidates) {
    const sf = project.getSourceFile(join(root, f));
    if (!sf) continue;
    const units = extractInlineJsUnits(sf, f);
    if (units.length === 0) continue;
    // 宿主 HTML/CSS 视图属性并入清单(id="view-x" / data-view="x")
    const attrViews = new Set<string>();
    const text = texts.get(f) ?? "";
    for (const m of text.matchAll(VIEW_ATTR_RE)) {
      const v = m[1] ?? m[2];
      if (v) attrViews.add(v);
    }
    for (const u of units) {
      result.units++;
      const ast = await parseInlineJsAst(u.js);
      if (!ast) continue;
      const r = routesOfUnit(u, ast.decls, ast.root);
      if (r.router && !result.router) {
        result.router = { name: r.router.name, file: f, line: u.startLine + r.router.row };
      }
      for (const [view, slot] of r.views) {
        const exist = result.routes.find((x) => x.view === view && x.file === f);
        if (exist) {
          for (const o of slot.opens) if (!exist.opens.some((y) => y.line === o.line)) exist.opens.push(o);
          for (const e of slot.entries) if (!exist.entries.some((y) => y.name === e.name)) exist.entries.push(e);
        } else {
          result.routes.push({ view, file: f, opens: slot.opens, entries: slot.entries });
        }
      }
    }
    for (const v of attrViews) {
      if (!result.routes.some((x) => x.view === v && x.file === f)) result.routes.push({ view: v, file: f, opens: [], entries: [] });
    }
  }
  if (!result.router) {
    degraded.push("未检出路由器函数(自写 switchView/dataset.view 族或 React/Vue Router 配置)——pageflow 三形态与本模块自写形态均未命中");
  }
  result.routes.sort((a, b) => b.opens.length + b.entries.length - (a.opens.length + a.entries.length));
  return result;
}

/** 人类可读渲染(CLI/LLM 同源文本)。 */
export function renderAppRoutes(r: AppRoutesResult): string {
  const lines: string[] = [];
  if (!r.router) {
    lines.push(`app 路由: 未检出路由器(扫描 ${r.scannedFiles} 文件 / ${r.units} 内嵌单元)`);
    for (const d of r.degraded) lines.push(`  - ${d}`);
    return lines.join("\n");
  }
  lines.push(`app 路由: ${r.router.name} @ ${r.router.file}:${r.router.line}(视图 ${r.routes.length} 个 · 扫描 ${r.scannedFiles} 文件 / ${r.units} 内嵌单元)`);
  for (const route of r.routes) {
    const opens = route.opens.length > 0
      ? route.opens.slice(0, 6).map((o) => `${o.fn}:${o.line}${o.trigger ? `(触发 ${o.trigger})` : ""}`).join("、")
      : "(无路由器调用点——仅属性清单)";
    const entries = route.entries.length > 0
      ? route.entries.slice(0, 6).map((e) => `${e.name}:${e.line}`).join("、")
      : "(守卫分支无入口调用)";
    lines.push(`  ${route.view} — ${route.file}`);
    lines.push(`    打开: ${opens}${route.opens.length > 6 ? ` …×${route.opens.length}` : ""}`);
    lines.push(`    入口渲染: ${entries}${route.entries.length > 6 ? ` …×${route.entries.length}` : ""}`);
  }
  for (const d of r.degraded) lines.push(`  ⚠️ ${d}`);
  return lines.join("\n");
}
