/**
 * code_sense 统一入口(合并):agent 面只保留一个代码认知工具。
 * 旧 code_index 的结构动作并入本工具 action 面,旧 code_sense 的语义画像面保留在 mode 面:
 *  - action(结构面,毫秒级静态索引):symbol | file | impact | entrypoints | project | wire | refs | surface | vars | branches | flow
 *    (refs=字面量引用面:删字符串标识的动作/查错误串与提示词引用时用;
 *     branches=分支/循环骨架:if/elif/else/while/for/switch/三元,答「这个调用在什么条件下发生」)
 *    —— 已删除 graph/filegraph/api(code_index 的历史动作):api 与语义面 mode=api 完全重复,
 *       graph/filegraph 在 agent 面近零使用(7 千次工具调用里 0/1 次)。
 *  - mode(语义画像面,action 缺席时生效):auto | debug | plan | explore | ui | api | state | algo
 * 数据源与旧实现同源:symbol/file/impact/entrypoints/project 走 sense-index-manager.codeIndexQuery;
 * wire 走 @lampgenie/code-sense/wire(与 codesense wire 命令同源);refs 走
 * @lampgenie/code-sense/retrieval/literal-refs(与 codesense refs 同源);vars 直接复用 CLI 的
 * queryVarsCmd(typed 深提取 + 缺文件建议,零重写);branches 走 @lampgenie/code-sense/sensing/decision
 * (tree-sitter 全树走查,与 codesense branches 命令同源);语义面走 code-sense codeSense+renderForLlm。
 */
import { basename, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import type { WorkspaceRepo } from "./sense-root-gate.js";
import type { Tool } from "@lampgenie/runtime/agent/loop";
import type { RemoteProject } from "./remote-project.js";

/** 唯一工具名(面板/权限规则/日志均按此名识别;不要另起别名)。 */
export const SENSE_TOOL_NAME = "code_sense";

/** 结构面动作(action 在场 → 走静态索引/行扫描,毫秒级)。 */
export const SENSE_ACTIONS = ["symbol", "file", "impact", "entrypoints", "project", "wire", "refs", "surface", "vars", "branches", "orphans", "flow", "radiation", "world"] as const;
export type SenseAction = (typeof SENSE_ACTIONS)[number];

/** 语义画像面(无 action 时生效)。 */
export const SENSE_MODES = ["auto", "debug", "plan", "explore", "ui", "api", "state", "algo"] as const;
export type SenseMode = (typeof SENSE_MODES)[number];

/** 已删除的旧 code_index 动作 → 迁移指引(旧习惯调用给确定性指路,不静默降级)。 */
const RETIRED_ACTIONS: Record<string, string> = {
  api: "action=api 已删除:HTTP 接口表面改用 mode=api(语义面,与旧 action 完全同源)",
  graph: "action=graph 已删除:符号上下游用 action=symbol;需要调用链时序/引用面用 mode=debug",
  filegraph: "action=filegraph 已删除:文件符号表用 action=file;跨文件调用关系用 mode=debug",
 // §12.5 漂移登记闭合:journal 经验证 grep×22/files×4 次调用落「未知 action」——补定向迁移指引。
  grep: "action=grep 已删除:字面量引用面用 action=refs(8 类语境逐点足迹,含 UI 显示/文案/配置)",
  files: "action=files 已删除:整文件符号表用 action=file;文件遍历式检索用 action=refs 或 mode=explore",
};

export interface SenseStructOpts {
  level?: string;
  maxNodes?: number;
  graph?: boolean;
}

export type SenseDispatch =
  | { kind: "structural"; action: SenseAction; target: string; opts?: SenseStructOpts; rootOverride?: string }
  | { kind: "semantic"; mode: SenseMode; query: string; rootOverride?: string }
  | { kind: "invalid"; reason: string };

function usage(): string {
  return [
    "code_sense 用法(二选一):",
    "主命令三角(优先记这三个):函数关联关系用 action=impact(上下游调用闭包+关联测试);一个数值/字面量在哪里被用(含 UI 显示位置/文案/配置)用 action=refs——UI 渲染点不走 impact 走 refs;命名形态未知的找路用 mode=explore(自由文本分词召回)。孤儿逻辑自查用 action=orphans(验收前:孤独导出/仅测试接线/孤儿事件/双胞胎,确定性毫秒级)。",
    "① 结构面 action=symbol|file|impact|entrypoints|project|wire|refs|surface|vars|branches|orphans|flow|radiation|world,target=符号名/文件相对路径/字面量/概念词/flow 的 scope;radiation=改动辐射面四分面清单(上游/下游/契约/副作用);orphans=孤儿逻辑自查(target 可选=模块/路径前缀,缺省全仓);",
    "② 语义面 mode=auto|debug|plan|explore|ui|api|state|algo + query(符号名/关键词)。",
    "③ 概念足迹 action=surface,target=概念词(多个用逗号分隔,如 SuperAgent,dh-video):替换/迁移一个概念时 11 类(protocol/db/journal/config/symbol/ui/assets/deploy/i18n/tests/docs)表面一次列全。",
    "④ 世界模型 action=world(纯读预渲染产物,不加载索引/不触发构建):target 空=L0 骨架全文;target=\"module:<名>\"=单模块页;target=任务文本=按词面下钻 top3 模块页(带命中理由)。",
  ].join("\n");
}

/** 参数面判定(纯函数,测试直测):action 优先走结构面;无 action 才走语义 mode 面。 */
export function dispatchSenseArgs(args: unknown): SenseDispatch {
  const a = (args ?? {}) as { action?: unknown; mode?: unknown; target?: unknown; query?: unknown; level?: unknown; maxNodes?: unknown; graph?: unknown; root?: unknown };
  const action = typeof a.action === "string" ? a.action.trim() : "";
  const mode = typeof a.mode === "string" ? a.mode.trim() : "";
  const target = typeof a.target === "string" ? a.target.trim() : "";
  const query = typeof a.query === "string" ? a.query.trim() : "";
  if (action) {
    const retired = RETIRED_ACTIONS[action];
    if (retired) return { kind: "invalid", reason: retired };
    if (!(SENSE_ACTIONS as readonly string[]).includes(action)) {
      return { kind: "invalid", reason: `未知 action: ${action}(可选 ${SENSE_ACTIONS.join("/")})\n` + usage() };
    }
    // 兼容旧习惯:结构动作误把目标写进 query 时按 target 兜住(不静默丢参数)。
    const level = typeof a.level === "string" && a.level.trim() ? a.level.trim() : undefined;
    const maxNodes = typeof a.maxNodes === "number" && Number.isFinite(a.maxNodes) ? a.maxNodes : undefined;
    const graph = typeof a.graph === "boolean" ? a.graph : undefined;
    const opts: SenseStructOpts | undefined = level || maxNodes !== undefined || graph !== undefined
      ? { ...(level ? { level } : {}), ...(maxNodes !== undefined ? { maxNodes } : {}), ...(graph !== undefined ? { graph } : {}) }
      : undefined;
    const effTarget = target || query;
    const rootOverride = typeof a.root === "string" && a.root.trim() ? a.root.trim() : undefined;
 // 入参纠偏( token 轮 P2):经验证 code_sense 硬失败 21.4%——典型错法是拿
    // 「目录路径」当符号名查 symbol/impact。旧口径会把 `/src/agent` 当符号名查,索引里当然零命中,
    // 回一段「未找到符号」的表面成功(带空清单),模型只能自己悟,于是重试或改用 read_file 整读。
    // 这里前置识别并给出**确定性的替代调用**(不是笼统建议),把一次空转变成一次正确调用。
    const targetHint = structuralTargetHint(action as SenseAction, effTarget);
    if (targetHint) return { kind: "invalid", reason: targetHint };
    // surface 的 target 是概念词(可逗号分隔多个):空 target 会扫出「零命中」冒充成功,这里前置拦下。
    if (action === "surface" && !effTarget) {
      return { kind: "invalid", reason: "action=surface 需要 target=概念词或符号名(多个用逗号分隔,如 SuperAgent,dh-video)\n" + usage() };
    }
    return { kind: "structural", action: action as SenseAction, target: effTarget, ...(opts ? { opts } : {}), ...(rootOverride ? { rootOverride } : {}) };
  }
  const m = (mode || "auto") as SenseMode;
  if (!(SENSE_MODES as readonly string[]).includes(m)) {
    return { kind: "invalid", reason: `未知 mode: ${mode}(可选 ${SENSE_MODES.join("/")})\n` + usage() };
  }
  if (!query) return { kind: "invalid", reason: "语义面需要 query(代码符号名/关键词);结构面请传 action\n" + usage() };
 // mode=debug 要求符号名;传目录/文件路径必然零命中(经验证这是 21.4% 硬失败的另一半)。
  const debugHint = semanticQueryHint(m, query);
  if (debugHint) return { kind: "invalid", reason: debugHint };
  const rootOverride = typeof a.root === "string" && a.root.trim() ? a.root.trim() : undefined;
  return { kind: "semantic", mode: m, query, ...(rootOverride ? { rootOverride } : {}) };
}

/** 结构面 target 形态校验:返回纠偏文本(=不执行),undefined=放行。
 *  只拦**确定会零命中**的形态(目录路径 / 带扩展名的文件名 → 当符号名查),
 *  不拦「符号名可能不存在」(那是正常查询,空结果是有效信息)。 */
export function structuralTargetHint(action: SenseAction, target: string): string | undefined {
  if (!target) return undefined; // 各 action 自己的「需要 target」文案更准确,这里不抢
  const needsSymbol = action === "symbol" || action === "impact" || action === "radiation";
  if (!needsSymbol) return undefined;
  const looksPath = /[\\/]/.test(target) || /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|h|cpp|hpp|md|json)$/i.test(target);
  if (!looksPath) return undefined;
  const trimmed = target.replace(/^\.\//, "").replace(/\/+$/, "");
  return `target="${target}" 是路径/文件名,不是符号名——${action} 按符号名查索引,传路径必然零命中。改用:\n`
    + `  · 看这个文件里有哪些符号/类型:action=file, target="${trimmed}"(返回文件符号表,带类型+行号)\n`
    + `  · 看这个文件的分支/条件骨架:action=branches, target="${trimmed}"\n`
    + `  · 想按关键词/目录导读做语义检索:mode=explore, query="${trimmed.split("/").slice(-1)[0] ?? trimmed}"`;
}

/** 语义面 query 形态校验(仅 debug 强要求符号名)。 */
export function semanticQueryHint(mode: SenseMode, query: string): string | undefined {
  if (mode !== "debug") return undefined;
  const looksPath = /[\\/]/.test(query) && !/\s/.test(query);
  const hasCjk = /[\u4e00-\u9fff]/.test(query);
  if (!looksPath && !hasCjk) return undefined;
  const why = hasCjk
    ? "中文自然语言(debug 只认代码符号名,自然语言会零命中)"
    : "路径形态(debug 只认符号名)";
  return `mode=debug 的 query="${query}" 是${why}。改用:\n`
    + `  · 要「某功能/关键词在哪些文件被提到」:mode=explore, query="${hasCjk ? query : (query.split("/").slice(-1)[0] ?? query)}"\n`
    + `  · 要「某个符号的调用链/签名」:mode=debug, query="<真实符号名>"(如 deriveMessages / AgentLoop.runTurn)\n`
    + `  · 不确定符号名:action=file, target="<所在文件>" 先看符号表`;
}

/** a1(命中率三修):root 收窄后需要剥冗余前缀的结构动作(file/vars/branches/flow——
 *  target 都是路径形态)。不含 refs(字面量匹配,前缀即语义)/symbol/impact(路径形态已被
 *  structuralTargetHint 前置拦下,到不了这里)。 */
const ROOT_NARROW_TARGET_ACTIONS = new Set<SenseAction>(["file", "vars", "branches", "flow"]);

/** root 显式收窄后,target 仍带「工作区根→子仓」相对前缀/绝对路径时剥成相对子仓路径。
 * 注意:root="packages/harness-workflow" + target="packages/harness-workflow/src/engine.ts"
 * → 子仓索引 byFile 键是相对路径,不剥必零命中「文件无索引符号」死路(11-03 seq 427487-427530)。 */
export function stripRedundantTargetPrefix(repoRoot: string, effRoot: string, target: string): string {
  const norm = (s: string): string => s.replaceAll("\\", "/").replace(/^\.\//, "");
  const t = norm(target);
  const prefix = norm(relative(repoRoot, effRoot));
  // 绝对路径形态:落在收窄根内(等于根或位于根下)→ 相对化
  if (isAbsolute(t)) {
    const abs = normalize(resolve(t));
    const eff = normalize(effRoot);
    if (abs === eff || abs.startsWith(eff + sep)) return norm(relative(effRoot, abs));
    return t; // 根外绝对路径:不擅动(各 action 自己的 miss 文案更准确)
  }
  if (prefix && prefix !== ".") {
    if (t === prefix) return "";
    if (t.startsWith(prefix + "/")) return t.slice(prefix.length + 1);
  }
  return t;
}

/** 结构面执行(action 分派)。 */
async function runStructural(root: string, action: SenseAction, target: string, opts?: SenseStructOpts): Promise<string> {
  if (action === "refs") {
    if (!target) return "action=refs 需要 target=字面量(不含引号,如 graph / track.view)";
    // 字面量引用面:删除/修改一个字符串标识时 symbol/impact 全空——这里给按语境的确定性引用清单,
    // 覆盖产品源码+测试+文档/提示词文本(默认排除 node_modules/dist/.genie/vendor)。
    const { scanLiteralRefs, renderLiteralRefs } = await import("@lampgenie/code-sense/retrieval/literal-refs");
    const r = await scanLiteralRefs(root, target);
    return renderLiteralRefs(r).slice(0, 14_000);
  }
  if (action === "surface") {
    if (!target) return "action=surface 需要 target=概念词或符号名(多个用逗号分隔,如 SuperAgent,dh-video)";
 // 概念足迹:替换/迁移/改名一个概念时 11 类表面(protocol/db/journal/config/symbol/
    // ui/assets/deploy/i18n/tests/docs)一次列全,替掉「协议面 grep 一轮 + 配置面一轮 + 文档面一轮」的多轮试错。
    // 括号内分类清单与 code-sense 的 SURFACE_CATEGORIES 同步维护(此处写死,避免为文案新增跨包 import)。
    const { scanSurface, renderSurfaceMarkdown } = await import("@lampgenie/code-sense/surface");
    const concepts = target.split(",").map((s) => s.trim()).filter(Boolean);
    const r = await scanSurface(root, concepts);
    return renderSurfaceMarkdown(r).slice(0, 14_000);
  }
  if (action === "branches") {
    if (!target) return "action=branches 需要 target=文件相对路径(如 modules/asr/qwen_asr.py / src/engine/loop.cpp)";
 // 分支/循环骨架:if/elif/else 条件+while/for/switch 循环语义,每点带条件文本/
    // 迭代目标/分支直接调用/所属函数——条件关系(「这个调用在什么条件下发生」)不必回源码。
    const { scanDecisionFile, renderDecisionSkeleton } = await import("@lampgenie/code-sense/sensing/decision");
    const r = await scanDecisionFile(root, target.replace(/\\/g, "/"));
    if (!r) {
      return `未提取到分支/循环骨架: ${target}(支持 py/ts/tsx/js/jsx/mjs/cjs/c/h/cc/cpp/hpp/java/go;文件须存在于仓内)`;
    }
    return renderDecisionSkeleton(r).slice(0, 14_000);
  }
  if (action === "orphans") {
 // 孤儿逻辑自查(设计稿 14.2):孤独导出/仅测试接线/孤儿事件/双胞胎,确定性行扫描,验收前毫秒级自查。
    const { scanOrphans, renderOrphans } = await import("@lampgenie/code-sense/sensing/orphan-audit");
    const r = await scanOrphans(root, target || undefined);
    return renderOrphans(r).slice(0, 14_000);
  }
  if (action === "wire") {
    // 协议表面(WS 消息 union ↔ 收发点/孤儿):与 codesense wire 同源,纯行/结构扫描,不触发索引构建。
    const { scanWire, renderWire } = await import("@lampgenie/code-sense/wire");
    return renderWire(scanWire(root)).slice(0, 14_000);
  }
  if (action === "vars") {
    if (!target) return "action=vars 需要 target=文件相对路径(如 apps/gateway/src/agent-wiring.ts)";
    // 直接复用 CLI vars 实现(typed 深提取 + 缺文件同名建议);单仓上下文,repo 定向不适用。
    const { queryVarsCmd } = await import("@lampgenie/code-sense-cli/query");
    const ctx = {
      root,
      rootSource: "code_sense(action=vars)",
      repos: [{ name: basename(root) || "repo", root }],
      notes: [],
    } as unknown as Parameters<typeof queryVarsCmd>[0];
    const out = await queryVarsCmd(ctx, target, undefined, false);
    return out.text.slice(0, 14_000) || `未提取到变量类型: ${target}`;
  }
  if (action === "flow") {
 // 整仓 code flow:与 codesense flow / MCP code_index_flow 同核。
    // target=scope(目录/文件前缀),level/maxNodes 可选;索引缺失=显式降级,不冻结构建。
 // 冻结治理:loadIndex→loadIndexAsync(索引 JSON 29-40MB,同步读在 9p 停顿时冻事件循环)。
    const { loadIndexAsync } = await import("@lampgenie/code-sense/callgraph/c2f");
 // 首查等待( ①同口径):未索引子仓轮询等构建落地(上限同 GENIE_SENSE_INDEX_WAIT_MS;
    // 500ms 间隔让出事件循环),到点未完才降级,带已等待时长与上限。
    let index = await loadIndexAsync(root);
    if (!index) {
      const { waitForIndexReady, firstQueryWaitMsForLog } = await import("./sense-index-manager.js");
      const t0 = Date.now();
      index = await waitForIndexReady(root);
      if (!index) {
        const cap = firstQueryWaitMsForLog();
        return `调用索引尚未就绪(已等待 ${Math.round((Date.now() - t0) / 1000)}s,预计剩余约 ${Math.max(0, Math.round((cap - (Date.now() - t0)) / 1000))}s,上限 ${Math.round(cap / 1000)}s 由 GENIE_SENSE_INDEX_WAIT_MS 控制;首次构建需 1-2 分钟,后台进行中,稍后再试)`;
      }
    }
    const { buildCodeFlow, FlowTargetError, renderCodeFlowMermaid, renderCodeFlowText } = await import("@lampgenie/code-sense/callgraph/flow");
    const { scanProcessEntriesSync } = await import("@lampgenie/code-sense/sensing/procentries");
    const level = opts?.level === "module" || opts?.level === "file" || opts?.level === "function" ? opts.level : "auto";
    try {
      const flow = buildCodeFlow(index, {
        level,
        ...(target ? { scope: target } : {}),
        ...(opts?.maxNodes !== undefined ? { maxNodes: opts.maxNodes } : {}),
        processEntries: scanProcessEntriesSync(root, index).entries,
      });
      return renderCodeFlowText(flow) + (opts?.graph === false ? "" : "\n\n" + renderCodeFlowMermaid(flow, { legend: false }));
    } catch (e: unknown) {
      if (e instanceof FlowTargetError) return e.message;
      throw e;
    }
  }
  if ((action === "symbol" || action === "file" || action === "impact" || action === "radiation") && !target) {
    return action === "file"
      ? "action=file 需要 target=文件相对路径"
      : `action=${action} 需要 target=符号名`;
  }
  const { codeIndexQuery } = await import("./sense-index-manager.js");
 // L3 radiation(设计稿 35):组合 impact+symbol 成四分面辐射清单(上游/下游/契约/副作用)
  if (action === "radiation") {
    return await radiationChecklist(root, target, codeIndexQuery);
  }
  return (await codeIndexQuery(root, action, target)).slice(0, 14_000);
}

/**
 * L3 辐射面枚举器(设计稿 35 实施;设想的「清单不靠人记靠工具产出」终态)。
 * 组合既有 action(impact+symbol)成**四分面清单**:上游调用方/下游消费点/契约字段/副作用面。
 * 副作用检测=import 边可证的白名单(设计稿 §2.1 确定性优先,名字命中无 import 证的进 unknown)。
 */
async function radiationChecklist(
  root: string,
  symbol: string,
  query: (root: string, action: string, target: string) => Promise<string>,
): Promise<string> {
  const [impactText, symbolText] = await Promise.all([
    query(root, "impact", symbol).catch(() => "impact 查询失败"),
    query(root, "symbol", symbol).catch(() => "symbol 查询失败"),
  ]);

 // 从 impact 输出提取上游/下游/受影响文件/关联测试(文本解析,与 CLI 输出格式同源)
  const callers: string[] = [];
  const callees: string[] = [];
  const affectedFiles: string[] = [];
  const tests: string[] = [];
  let section = "";
  for (const line of impactText.split("\n")) {
    if (line.includes("上游调用方")) section = "callers";
    else if (line.includes("下游依赖")) section = "callees";
    else if (line.includes("受影响文件")) section = "files";
    else if (line.includes("关联测试")) section = "tests";
    else if (line.trim().startsWith("(")) {
      const trimmed = line.trim();
      if (section === "callers") callers.push(trimmed);
      else if (section === "callees") callees.push(trimmed);
      else if (section === "tests") tests.push(trimmed);
    } else if (section === "files" && line.trim() && !line.includes("汇总") && !line.includes("弃边")) {
      affectedFiles.push(line.trim());
    }
  }

 // 契约面:从 symbol 输出提取签名
  const sigMatch = symbolText.match(/签名[::]\s*(.+)/);
  const signature = sigMatch ? sigMatch[1]!.trim() : "(symbol 查询未返回签名)";

 // 副作用面:下游调用名 + 受影响文件的 import 白名单检测
  const calleeNames = callees.map((c) => {
    const m = /\((?:d\d+,)?\s*([^@\s]+)\s*@/.exec(c) || /\)\s*(\w+)\s*@/.exec(c);
    return m ? m[1]! : "";
  }).filter(Boolean);

  const sideEffects = detectSideEffects(calleeNames, affectedFiles);

 // 渲染四分面清单
  const lines: string[] = [
    `## 改动辐射面:${symbol}`,
    "",
    "### 上游调用方(改签名/返回值前必查)",
    ...(callers.length > 0 ? callers.map((c) => `- ${c}`) : ["- (无上游调用方——可能是入口/独立函数)"]),
    "",
    "### 下游依赖(行为变更需同步检查)",
    ...(callees.length > 0 ? callees.map((c) => `- ${c}`) : ["- (无下游依赖)"]),
    "",
    "### 契约(签名+类型)",
    `- 签名:${signature}`,
    "",
    "### 副作用面(改这里会触达什么)",
    ...(sideEffects.length > 0 ? sideEffects : ["- (import 边未检出副作用——注意:白名单只覆盖已知模式,不代表零副作用)"]),
    "",
    "### 关联测试",
    ...(tests.length > 0 ? tests.map((t) => `- ${t}`) : ["- (无关联测试——改动后可能需要补)"]),
    "",
    "### 受影响文件",
    ...(affectedFiles.length > 0 ? affectedFiles.map((f) => `- ${f}`) : []),
    "",
    `> 来源:code_sense impact+symbol(静态索引);副作用=白名单检测(确定性优先,名字命中无 import 证进 unknown)。`,
    `> 用途:改 ${symbol} 前先把上面的面画全——这正是「影响面未闭合」的预防动作。`,
  ];
  return lines.join("\n").slice(0, 14_000);
}

/** 副作用白名单(设计稿 §2.1;import 边可证的才进 high,名字命中进 low→unknown) */
const SIDE_EFFECT_PATTERNS: ReadonlyArray<{ re: RegExp; bucket: string; label: string }> = [
  { re: /writeFile|appendFile|mkdir|rename|unlink|rmSync|writeSync/i, bucket: "fs", label: "写文件" },
  { re: /fetch|WebSocket|net\.connect|http\.request|axios/i, bucket: "network", label: "网络请求" },
  { re: /execFile|spawn|execSync|child_process|process\.exit|process\.kill/i, bucket: "process", label: "进程操作" },
  { re: /Date\.now|Math\.random|crypto\.randomUUID|hrtime/i, bucket: "nondeterminism", label: "非确定性" },
  { re: /process\.env\[|globalThis\./i, bucket: "global", label: "全局状态" },
];

function detectSideEffects(calleeNames: readonly string[], affectedFiles: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of calleeNames) {
    for (const p of SIDE_EFFECT_PATTERNS) {
      if (p.re.test(name) && !seen.has(p.label)) {
        seen.add(p.label);
        out.push(`- ⚠️ ${p.label}(下游调用 \`${name}\` 命中 ${p.bucket} 模式)`);
      }
    }
  }
  for (const file of affectedFiles) {
    if (/write|save|persist|send|emit/i.test(file) && !seen.has("文件名暗示写操作")) {
      seen.add("文件名暗示写操作");
      out.push(`- ⚠️ 文件名暗示写操作:${file}(需 import 边确认)`);
    }
  }
  return out;
}

/** root 参数解析(巨根治理):子仓名/相对路径/绝对路径 → 绝对根;必须落在工作区内。
 *  失败给确定性纠偏(不静默忽略——模型给了 root 却被丢掉会以为已收窄)。 */
function resolveRootOverride(base: string, override?: string): { ok: true; root: string } | { ok: false; reason: string } {
  if (!override) return { ok: true, root: base };
  const t = override.replace(/\\/g, "/").trim();
  if (!t) return { ok: true, root: base };
  const nb = normalize(base);
  const abs = isAbsolute(t) ? normalize(t) : resolve(nb, t);
  if (abs !== nb && !abs.startsWith(nb + sep)) {
    return { ok: false, reason: `root="${override}" 解析到工作区之外(${abs})——root 只接受工作区内的子仓名/子路径(如 root="services")。` };
  }
  if (abs !== nb && !existsSync(abs)) {
    return { ok: false, reason: `root="${override}" 指向不存在的路径(${abs})——用子仓名或其下真实路径。` };
  }
  return { ok: true, root: abs };
}

/** target 落在子仓内时,换算成相对子仓根的路径(file/vars/branches/flow 自动收窄用)。 */
function targetRelToSub(sub: WorkspaceRepo, target: string): string {
  const t = target.replace(/\\/g, "/").replace(/^\.\//, "");
  if (isAbsolute(t)) return relative(sub.path, t).replace(/\\/g, "/");
  if (t === sub.name) return "";
  return t.startsWith(sub.name + "/") ? t.slice(sub.name.length + 1) : t;
}

/** 结果短 TTL 缓存:同 (root, action/mode, target/query) 30s 内复用。
 * 7700 审计注意:近 3.5 天 22 组完全重复调用(部分同一步双发),在 9p 慢盘上每次 3-14s。
 *  只缓存非错误结果;容量 64(结果 ≤14K 字符);TTL 短到不会掩盖源码变更。 */
const SENSE_RESULT_TTL_MS = 30_000;
const senseResultCache = new Map<string, { at: number; value: string }>();
function senseCacheKey(root: string, d: Exclude<SenseDispatch, { kind: "invalid" }>): string {
  return root + "\u0000" + JSON.stringify(d);
}

/** 闸内执行(巨根治理核心):根在预算内=原行为;超预算=工作区分流,拒绝必须带路。 */
async function runGated(root: string, d: Exclude<SenseDispatch, { kind: "invalid" }>): Promise<string> {
  const key = senseCacheKey(root, d);
  const hit = senseResultCache.get(key);
  if (hit && Date.now() - hit.at < SENSE_RESULT_TTL_MS) return hit.value;
  const value = await runGatedUncached(root, d);
  if (!value.startsWith("code_sense 错误")) {
    senseResultCache.set(key, { at: Date.now(), value });
    if (senseResultCache.size > 64) {
      const oldest = [...senseResultCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) senseResultCache.delete(oldest[0]);
    }
  }
  return value;
}

async function runGatedUncached(root: string, d: Exclude<SenseDispatch, { kind: "invalid" }>): Promise<string> {
 // world:纯读几 KB 常驻产物——不走重闸/不加载索引/不触发构建,置于 rootScanVerdict 之前。
  if (d.kind === "structural" && d.action === "world") return runWorldAction(root, d.target);
  const { rootScanVerdict, detectWorkspaceRepos, refineRootForTarget, workspaceRefusalText, renderWorkspaceRepos } = await import("./sense-root-gate.js");
  const verdict = await rootScanVerdict(root);
  if (verdict.ok) {
    if (d.kind === "structural") return await runStructural(root, d.action, d.target, d.opts);
    const { codeSense, renderForLlm } = await import("@lampgenie/code-sense");
    const r = await codeSense(root, d.query, { mode: d.mode });
    return renderForLlm(r).slice(0, 14_000) || JSON.stringify(r).slice(0, 14_000);
  }
 // ---- 超预算根:不再裸扫/裸建(注意:巨根采样重建压垮 9p 拖死全系统)。工作区感知分流 ----
  const repos = await detectWorkspaceRepos(root);
  if (d.kind === "semantic") {
    return workspaceRefusalText(root, verdict, repos, "语义扫描")
      + "\n(语义画像面在子仓上完全可用:本调用加 root=\"<子仓名>\" 后重查。)";
  }
  const action = d.action;
  // ① 路径前缀自动收窄:file/vars/branches/flow 的 target 是路径/scope,带子仓名前缀即收
  if (action === "file" || action === "vars" || action === "branches" || action === "flow") {
    const sub = refineRootForTarget(root, repos, d.target);
    if (sub) {
      const repo = repos.find((r) => r.path === sub)!;
      const subVerdict = await rootScanVerdict(sub);
      if (!subVerdict.ok) return workspaceRefusalText(sub, subVerdict, await detectWorkspaceRepos(sub), "扫描");
      const rel = targetRelToSub(repo, d.target);
      return `[根已自动收窄→${repo.name}(target 带子仓前缀)]\n` + await runStructural(sub, action, rel, d.opts);
    }
    return workspaceRefusalText(root, verdict, repos, `${action} 扫描`)
      + `\n(target="${d.target}" 未落在任何子仓内;target 带子仓路径前缀(如 "${(repos[0]?.name ?? "<子仓>")}/src/x.py")可自动收窄。)`;
  }
  // ② symbol/impact:在已建索引的子仓内扇出(不触发构建);未建索引的子仓如实点名
  if (action === "symbol" || action === "impact") {
    const { codeIndexQueryNoBuild } = await import("./sense-index-manager.js");
    const searched: string[] = [];
    const notSearched: string[] = [];
    const hits: string[] = [];
    // 全根本身的既有(采样)索引优先入列:巨根若曾建过索引,它覆盖全部子仓,是信息量最大的源
    const rootOut = await codeIndexQueryNoBuild(root, action, d.target).catch(() => null);
    if (rootOut !== null && !rootOut.startsWith("未找到符号") && !rootOut.startsWith("文件无索引符号")) {
      hits.push(`【全根采样索引(可能滞后,不自动重建)】\n` + rootOut);
    }
    for (const r of repos) {
      const out = await codeIndexQueryNoBuild(r.path, action, d.target).catch(() => null);
      if (out === null) { notSearched.push(r.name); continue; }
      searched.push(r.name);
      if (!out.startsWith("未找到符号") && !out.startsWith("文件无索引符号")) hits.push(`【${r.name}】\n` + out);
    }
    const head = `[工作区扇出] ${action} "${d.target}"(多仓工作区根不整根建索引):`;
    if (!searched.length && !notSearched.length) return workspaceRefusalText(root, verdict, repos, "建索引");
    if (!hits.length) {
      return head + ` 已建索引子仓(${searched.join(",") || "无"})内未命中。`
        + (notSearched.length ? `\n未搜索(无盘上索引):${notSearched.join(",")}——要搜它们:本调用加 root="<子仓名>"(首次自动建,小根秒~分钟级)。` : "")
        + "\n也可换面:mode=explore 关键词检索 / grep 按路径找定义。";
    }
    return head + ` 搜索了 ${searched.join(",")}。\n` + hits.join("\n---\n").slice(0, 14_000)
      + (notSearched.length ? `\n(未搜索:${notSearched.join(",")}(无盘上索引);要搜加 root="<子仓名>"。)` : "");
  }
  // ③ 总览类(entrypoints/project)与全根扫描类(refs/wire):工作区总览 + 指引
  if (action === "entrypoints" || action === "project") {
    return `[多仓工作区总览] ${root}(整根不建索引:${verdict.reason})\n子仓:\n` + renderWorkspaceRepos(repos)
      + "\n逐仓查看:本调用加 root=\"<子仓名>\" 后重查(action=" + action + " 在子仓根执行)。";
  }
  // refs/wire:字面量/协议扫描是全根行扫描,巨根上代价高——同 refusal 带路
  return workspaceRefusalText(root, verdict, repos, `${action} 全根扫描`)
    + `\n(${action} 支持 root 收窄:本调用加 root="<子仓名>" 后在子仓上执行。)`;
}

/** 远端 code_sense 映射:结构面/语义面 → codesense CLI argv。
 *  远端运行时(自带 Node 20 + CLI)由连接安装到 ~/.genie/genie-sense,经工作区服务执行。 */
export type RemoteSensePlan = { argv: string[] } | { unsupported: string };

export function senseArgvFor(d: SenseDispatch, root: string): RemoteSensePlan {
  if (d.kind === "invalid") return { unsupported: d.reason };
  if (d.kind === "structural") {
    const t = d.target;
    const o = d.opts ?? {};
    switch (d.action) {
      case "symbol": return { argv: ["symbol", t, "--root", root] };
      case "impact": return { argv: ["impact", t, "--root", root] };
      case "file": return { argv: ["file", t, "--root", root] };
      case "entrypoints": return { argv: ["entrypoints", "--root", root] };
      case "project": return { argv: ["project", "--root", root, "--no-llm"] };
      case "wire": return { argv: ["wire", "--root", root] };
      case "refs": return { argv: ["refs", t, "--root", root] };
      case "surface": {
 // 概念足迹:CLI 语义是 `codesense surface <概念1> [概念2 …]`,
        // 故 target 里的逗号拆成多个位置参数(不是一次传一个逗号串)。
        const concepts = t.split(",").map((x) => x.trim()).filter(Boolean);
        if (concepts.length === 0) return { unsupported: "action=surface 需要 target=概念词或符号名(多个用逗号分隔)" };
        return { argv: ["surface", ...concepts, "--root", root] };
      }
      case "vars": return { argv: ["vars", t, "--root", root] };
      case "branches": return { argv: ["branches", t, "--root", root] };
      case "flow": {
        const argv = ["flow", t || ".", "--root", root, "--level", String(o.level || "auto")];
        if (typeof o.maxNodes === "number" && Number.isFinite(o.maxNodes) && o.maxNodes > 0) argv.push("--max-nodes", String(Math.floor(o.maxNodes)));
        return { argv };
      }
      case "world": {
 // 世界模型:CLI `codesense world [--module <名> | --for "<任务文本>"]`,纯读产物。
 // --root 与其余动作同口径(远端按收窄根执行;CLI world 经 rootArg 读它)。
        if (!t) return { argv: ["world", "--root", root] };
        if (t.startsWith("module:")) return { argv: ["world", "--module", t.slice("module:".length).trim(), "--root", root] };
        return { argv: ["world", "--for", t, "--root", root] };
      }
 // 穷举兜底:action 联合新增成员时若忘补 case,控制流会穿透到下面的
      // semantic 分支,TS 无法把 d 收窄 → 3 条「Property 'query'/'mode' does not exist」。
      // default 让编译器检查形参类型(不再是 never),新增 action 漏接会在类型层暴露。
      default: return { unsupported: "未知 structural action:" + String((d as { action?: unknown }).action) };
    }
  }
  const q = d.query.trim();
  if (!q) return { unsupported: "mode 需要 query(符号名/关键词)" };
  switch (d.mode) {
    case "auto": return { argv: ["explore", q, "--root", root] };
    case "explore": return { argv: ["explore", q, "--root", root] };
    case "api": return { argv: ["api", "--root", root] };
    case "state": return { argv: ["state", "--root", root] };
    case "algo": return { argv: ["algo", "--root", root] };
    case "plan": return { argv: ["modules", "--root", root] };
    case "debug": return { argv: ["symbol", q, "--root", root, "--depth", "2"] };
    case "ui":
      return { unsupported: "mode=ui(页面流语义画像)暂不支持远端项目;请用 action=file/branches 或 mode=explore" };
  }
  return { unsupported: "未知 mode:" + String(d.mode) };
}

/** 经工作区服务在远端执行 code_sense(远端运行时未安装/通道不可用 → 明确报错)。 */
export async function runRemoteSense(remote: RemoteProject, d: SenseDispatch, root: string): Promise<string> {
  const plan = senseArgvFor(d, root);
  if ("unsupported" in plan) return plan.unsupported;
  const where = remote.kind === "wsl" ? "WSL:" + remote.distro : "SSH:" + remote.host;
  try {
    const { tryChannelJson } = await import("./remote-channel.js");
    const ch = await tryChannelJson(remote, "sense", { argv: plan.argv });
    if (!ch) return `code_sense(远端 ${where})失败:工作区服务未就绪——项目菜单「优化远程连接」重装后再试`;
    if (!ch.ok) return `code_sense(远端 ${where})失败:${String((ch as { error?: string }).error ?? "未知错误").slice(0, 300)}`;
    const data = (ch.data ?? {}) as { stdout?: string; stderr?: string; exit?: number; truncated?: boolean };
    const out = String(data.stdout ?? "");
    const err = String(data.stderr ?? "").trim();
    if ((data.exit ?? 0) !== 0 && !out.trim()) return `code_sense(远端 ${where})执行失败(exit ${data.exit}):${(err || "无输出").slice(0, 400)}`;
    const body = out + (err ? "\n[stderr] " + err.slice(0, 400) : "") + (data.truncated ? "\n…(输出截断)" : "");
    return ("[远端 " + where + "]\n" + body).slice(0, 14_000);
  } catch (e: unknown) {
    return `code_sense(远端 ${where})错误:${String((e as Error)?.message ?? e).slice(0, 200)}`;
  }
}

/** world:纯读常驻产物(零索引加载/不触发构建)。
 * 空 target=L0 骨架;module:<名>=单页;其它文本=确定性词面下钻 top3(带命中理由)。
 * 产物缺失只给重建指路,不自动建(重建要读 86MB 索引,属显式操作)。 */
async function runWorldAction(root: string, target: string): Promise<string> {
  const { readWorldManifest, readWorldSkeleton, readWorldModulePage, readDrillCorpus, listWorldModules, worldFreshness } =
    await import("@lampgenie/code-sense/world/store");
  const { selectModules } = await import("@lampgenie/code-sense/world/drilldown");
  const manifest = readWorldManifest(root);
  if (!manifest) {
    return `世界模型产物缺失(${root}/.genie/sense-index/<hash>/world/)。重建路径:\n`
      + "  1. codesense index --register(索引缺失时;全量构建约数分钟)\n"
      + "  2. codesense world --rebuild(读索引渲染产物,实测 ~3.4s)\n"
      + "(world 读路径不加载索引;本提示不自动触发构建。)";
  }
  const fresh = worldFreshness(root, manifest);
  const staleLine = fresh.state === "fresh" ? ""
    : `> ⚠ 世界模型${fresh.state === "stale" ? "陈旧" : "新鲜度未知"}:${fresh.reasons.join(";")}——codesense world --rebuild 重建\n`;
  const t = String(target ?? "").trim();
  if (!t) {
    const skel = readWorldSkeleton(root);
    if (!skel.text) return "世界模型 L0 骨架缺失(manifest 在但 skeleton.md 不在)——codesense world --rebuild 重建。";
    return (staleLine + skel.text).slice(0, 14_000);
  }
  if (t.startsWith("module:")) {
    const name = t.slice("module:".length).trim();
    const page = readWorldModulePage(root, name);
    if (!page) {
      const mods = listWorldModules(root);
      return `没有模块 \`${name}\` 的页面。已产出模块(${mods.length}):${mods.slice(0, 30).join(", ")}${mods.length > 30 ? " …" : ""}\n用 target="module:<名>" 指定。`;
    }
    return (staleLine + page.text).slice(0, 14_000);
  }
  const corpus = readDrillCorpus(root);
  if (!corpus) return "下钻语料缺失(drill.json)——codesense world --rebuild 重建。";
  const hits = selectModules(corpus, { text: t }, { max: 3 });
  if (hits.length === 0) {
    const mods = listWorldModules(root).slice(0, 3);
    return `零词面命中(任务文本与模块名/目录/文件名/符号无词面交集,不猜语义)。按规模候选:${mods.join(", ")}\n用 target="module:<名>" 指定单页。`;
  }
  const parts: string[] = [`${staleLine}下钻命中 ${hits.length} 个模块(确定性词面打分,零 LLM):`];
  for (const h of hits) {
    const page = readWorldModulePage(root, h.module);
    if (!page) continue;
    parts.push(`\n### ${h.module}(score=${h.score};命中:${h.hits.join(", ")})\n${page.text}`);
  }
  return parts.join("\n").slice(0, 14_000);
}

/** code_sense 工具(合并后唯一入口;只读、并发安全)。
 * onQuery:结构面调用留痕回调——喂改前链路闸的 ledger(每任务实例)。 */
export function codeSenseTool(repoRoot: string, remote?: RemoteProject, onQuery?: (action: string, target: string) => void): Tool {
  return {
    name: SENSE_TOOL_NAME,
    description:
      "Unified code-cognition entry point (structural face in ms, semantic profile in s). Pick the face that fits YOUR question; it is not a fixed set of commands. " +
      "**action = structural face (static call index)**: impact = change blast radius (call before editing/deleting/refactoring any function: full signature + bidirectional call closure + affected files + related tests) | " +
      "symbol = definition/callers/callees | file = file symbol table (with types) | project = project baseline profile (keeps work aligned with the mainline) | " +
      "wire = protocol surface (WS message union vs send/receive points, orphan declarations — this system's interface is a message protocol, not HTTP) | " +
      "refs = literal reference surface (deleting string identifiers, checking error strings/prompt references: lists every site by context — case/eq/object-key/string/doc — each hit annotated with its branch, target = the literal) | " +
      "surface = concept footprint (replace/migrate/rename: 11 surfaces at once — protocol/db/journal/config/symbol/ui/assets/deploy/i18n/tests/docs, target = concept name(s)) | " +
      "branches = branch/loop skeleton (target = file path: if/elif/else condition text + while/for/switch loops + ternaries, each branch with the functions it calls and its owning function — answers \"under what condition does this call happen\") | " +
      "flow = repo-wide code flow (target may be a scope; level = module|file|function|auto, default auto; entries/layers/mainline/hubs; graph=false for text only) | " +
      "vars = file variable inventory grouped by type | " +
      "entrypoints = entry function list (**usually no need to call: already injected in your kickoff context**). " +
      "**mode = semantic profile face (used when action is absent)**: debug = call chain/signature/static timing/repo-wide references/type definitions (query must be a real code symbol — directories, file names and natural language are rejected) | " +
      "plan = architecture map + module guide + git hotspots | explore = keyword greps aggregation (when the naming shape is unknown or you need a directory guide; query = concrete keywords) | ui = page flow | " +
      "api = HTTP interface surface (endpoints + handler blast radius) | state = state machine surface | algo = algorithm profile. " +
      "target = the symbol name / file path / literal for the action (symbol/impact/file/vars/refs); query = the input for mode. action wins when both are present. " +
      "**Multi-repo workspaces (a root holding several sub-repos) are not indexed as one**: pass root=\"<subrepo>\" to narrow execution there; a target prefixed with a subrepo path narrows automatically; bare symbol/impact fans out over already-indexed sub-repos and reports which repos were skipped. " +
      "One hard rule: the target of a symbol query must be a real code symbol name (directory paths or natural language necessarily return nothing and you get a correction hint).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [...SENSE_ACTIONS],
          description:
            "Structural face (ms): symbol|file|impact(blast radius; call before editing a function)|entrypoints(usually no need — already in kickoff context)|" +
            "project|wire(protocol surface)|refs(literal references)|surface(concept footprint: 11 surfaces — protocol/db/journal/config/symbol/ui/assets/deploy/i18n/tests/docs — at once)|vars|branches(branch/loop conditions with each branch's calls)|world(read pre-rendered world artifacts, no index load: empty target=L0 skeleton; module:<name>=one page; text=drill-down top3)",
        },
        mode: {
          type: "string",
          enum: [...SENSE_MODES],
          description:
            "Semantic profile face (when action is absent): auto|debug|plan|explore|ui|api|state|algo (auto: page words→ui, interface/state/algorithm words→api/state/algo, symbol→debug, planning→plan, else explore)",
        },
        target: {
          type: "string",
          description: "Action target: symbol/impact=symbol name; file/vars/branches=file path; refs=literal (unquoted); flow=scope prefix. " +
            "One call, whole table (preferred over looping one symbol at a time): file = a whole file's symbol table, refs/flow/branches/vars/wire = every hit at once — only fall back to per-symbol `symbol` when you need one exact signature.",
        },
        level: {
          type: "string",
          enum: ["module", "file", "function", "auto"],
          description: "Aggregation level for action=flow (default auto: module when >=6 modules, else file/function)",
        },
        maxNodes: { type: "number", description: "Narrow the node count for action=flow (default: no cap, honest full output)" },
        query: { type: "string", description: "Input for a semantic mode: symbol name, keywords or a natural-language intent (debug requires a code symbol)" },
        root: { type: "string", description: "Narrow the query root (needed in multi-repo workspaces): a workspace root holding several sub-repos is not indexed as one — pass root=\"<subrepo>\" (e.g. services) and this call runs inside that sub-repo (supports symbol/impact/file/vars/branches/flow/refs/wire/semantic faces). A target prefixed with a subrepo path narrows automatically; bare symbol/impact only fans out over already-indexed sub-repos" },
      },
      required: [],
    },
    isReadOnly: () => true, // RC-096 C1:纯读索引/扫描,声明只读使 plan 模式「改前必查 impact」纪律可达
    isConcurrencySafe: () => true,
    async execute(args: unknown) {
      const d = dispatchSenseArgs(args);
      if (d.kind === "invalid") return d.reason;
 // 结构面查询留痕 → 改前链路台账(记录意图;覆盖判定仍由 ledger 按词边界做)。
      if (d.kind === "structural") { try { onQuery?.(d.action, d.target); } catch { /* 记录失败不阻塞查询 */ } }
 // 远程项目(SSH/WSL:结构面/语义面经工作区服务在远端 CLI 执行(索引也在远端建)。
      if (remote) return await runRemoteSense(remote, d, repoRoot);
      try {
 // root 收窄(巨根治理):显式 root=子仓名/子路径 → 按新根走全流程(闸/索引按子仓判定)。
        const ro = resolveRootOverride(repoRoot, d.rootOverride);
        if (!ro.ok) return ro.reason;
        const effRoot = ro.root;
 // a1(命中率三修):root 显式收窄后,target 仍带「工作区根→子仓」相对前缀/绝对
        // 路径时剥成相对子仓路径,否则 file/vars/branches/flow 在子仓索引内零命中
 // (注意 11-03 seq 427487-427530:「文件无索引符号」死路)。symbol/impact 的路径形态已被
        // dispatchSenseArgs→structuralTargetHint 前置拦下;refs 按字面量匹配,前缀即语义,不剥。
        if (effRoot !== repoRoot && d.kind === "structural" && ROOT_NARROW_TARGET_ACTIONS.has(d.action)) {
          d.target = stripRedundantTargetPrefix(repoRoot, effRoot, d.target);
        }
        const gated = await runGated(effRoot, d);
        if (effRoot !== repoRoot) return `[根已收窄→${relative(repoRoot, effRoot) || basename(effRoot)}(root 参数)]\n` + gated;
        return gated;
      } catch (err) {
        return `code_sense 错误: ${String(err).slice(0, 200)}`;
      }
    },
  };
}
