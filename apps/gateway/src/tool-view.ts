/**
 * tool_view 按需注入:
 * 长描述工具(>TOOL_SUMMARY_CHARS)的 wire description 摘要为首句+指路,完整用法/参数细则/
 * 纪律由 tool_view(name) 按需查看——大 description 不再每步随 tools 参数常驻重发。
 * 参数 schema 保持原样(摘要只动 description):模型的调用参数质量不降,只有用法细节延迟。
 * ref 对照:dsh defer_loading / ZCode 无对应物;经验证主会话 27 工具 tools 参数 39k chars,
 * 其中 browser 2242 / board_upsert 1697+schema / spawn_subagent 1091 全是 description 大头。
 */
import type { Tool } from "@lampgenie/runtime/agent/loop";
import { fullDocFor } from "./tool-full-docs.js";

/** description 超过此字符数才摘要化(短的天然全量,无枚举豁免名单可维护)。 */
export const TOOL_SUMMARY_CHARS = 240;

/** wire 体量(description+schema)超过此值才延迟加载(「用时再选」)。
 * 3000 是经验证分界:此前命中者=board_upsert 7760/browser 7043(大 schema 工具),
 * 起板工具进 CORE_NEVER_DEFER(见彼处注释),命中者只剩 browser——
 * 「延迟机制存在但只延迟了一个工具」的格局不变,但那个工具不能再是闸门的指定出口。 */
export const TOOL_DEFER_MIN_CHARS = 3_000;

/** 永不延迟的核心工具:每步都可能用到,延迟=必多一轮往返,且它们的 schema 都不大。
 * 例外按经验证 wire 体量:read_file 约 900 / terminal 1589 / spawn_subagent 4030(在名单里但
 *  体量大——它是派发骨架,延迟会拖慢主线,故显式豁免)。
 * board_upsert(死锁事故后加入):它是 plan-gate 的指定出口(「先落板再动工」),
 *  延迟它=闸门要求一个清单里不存在的工具——受约束的函数名采样把「写板」意图掰成最接近的
 * board_read,经验证 38 步同参死循环(会话 web-1793329725963)。省的钱按 冻结备忘
 *  的口径≈¥0.00005/步(缓存命中期),对一个死锁风险是净亏。 */
export const CORE_NEVER_DEFER = new Set([
  "read_file", "write_file", "edit_file", "glob", "grep", "list_dir", "terminal", "run_cmd",
  "todo_write", "task_phase", "board_read", "board_upsert", "spawn_subagent", "task_output", "answer_subagent",
 // ask_user/clarify:等待用户答复类工具一旦延迟,模型「想问一句」时会先撞上「工具不在清单」,
  // 于是改成自己猜——延迟的是往返,丢的是澄清机会。
  "ask_user", "clarify",
  "code_sense", "skill_view", "tool_view",
]);

/** 渐进披露的固定 bridge 工具:常驻、永不延迟——它们是「按需加载」的唯一入口,
 * 延迟入口=延迟机制本身不可达(与 board_upsert 死锁同型)。 */
export const BRIDGE_TOOL_NAMES = new Set(["tool_view", "tool_search", "tool_call"]);

/** 摘要保留的首句长度上限。 */
const SUMMARY_SENTENCE_CHARS = 200;

/**
 * 按任务类别裁剪的工具名(**装配期不装配**,不是延迟加载)( token 轮 P2)。
 * 为什么不走延迟加载:经验证 27 个工具的 wire 体量**全部 < TOOL_DEFER_MIN_CHARS(3000)**
 * (最大 spawn_subagent 1941,取自真实 trace),阈值一个都命中不了——这就是「延迟机制存在但
 * 只延迟了 board_upsert 一个」的根因。而把阈值调低到能命中是**净亏**:loop 的
 * `advertisedTools()` 是 burst 语义——任一延迟工具被激活就全部重新放量(为保前缀稳定),
 * 经验证单次 burst 代价 196k uncached(¥0.39);而省下的 5000 字符在缓存命中期每步只值 ¥0.00005。
 * 所以正确做法是「从头就不装配」:tools 数组在任务开始时定死,整个任务期间不变,不会触发 burst。
 * 裁剪原则:**只去掉该类别基本不可能用到、且删掉不会造成「工具不存在」硬失败误导的工具**。
 * 拿不准的一律保留——省几千字符不值一个任务失败。
 */
export const TASK_CLASS_TOOL_DENY: Readonly<Record<string, readonly string[]>> = {
  // 问答/调研:不产出 PPT/会议纪要、不跑 workflow、不转向在跑任务、不折叠经验
  qa: ["board_export_pptx", "import_meeting", "steer_task", "run_workflow"],
  // 办公产出:不评审代码、不转向、不检索历史会话
  office: ["code_review", "steer_task", "session_search"],
  // coding 全量(默认,不裁剪)
};

/** 按任务类别过滤工具数组(纯函数;未知类别=原样返回,行为与改前一致)。 */
export function pruneToolsForTaskClass<T extends { name: string }>(tools: T[], taskClass: string | undefined): T[] {
  const deny = taskClass ? TASK_CLASS_TOOL_DENY[taskClass] : undefined;
  if (!deny || deny.length === 0) return tools;
  const denySet = new Set(deny);
  return tools.filter((t) => !denySet.has(t.name));
}

/**
 * 会话级工具面冻结( token 轮 P3,修 P2-1 副作用)。
 * **病灶经验证**(本会话 `web-1793267686700`,363 调):工具面在一个会话里变了 4 次
 * `27→29→27→29→23`,每次变化都让最前缀不同 → **整段历史重新计费**,累计 unc 463,716 ≈ ¥0.93,
 * 占该会话未命中的 21%。最贵一次 unc=344,016(¥0.688)、msgs=758 —— 单次代价远超
 * taskClass 裁剪整场省下的 1,372 字符(≈¥0.001)。
 * 根因:tools 数组在请求最前缀,cache 只认「逐字节相同的开头」。同 session 跨任务时
 * taskClass 变了(qa↔coding↔office)→ deny 表不同 → 工具集增减 → 前缀全废。
 * 改法:**按 session 单调累积**——首次装配按 taskClass 裁剪;此后该 session 只会**增加**
 * 工具(取并集),**永不删减**。于是工具面在整个会话生命周期内最多变化几次(且总是「追加」,
 * 比「替换」便宜),不会出现 23→27 的往返。
 * 为什么「只增不减」而不是「首次定死」:
 * ① 定死会在类别更正(用户 task_phase 改 taskClass)后让本该有的工具缺失 → 任务失败,代价远大于 token;
 * ② 只增的语义与「模型已知什么」一致——工具一旦被广告过就不能悄悄消失(否则历史里的调用记录会指向「不存在的工具」);
 * ③ 并集是单调的,所以它收敛:最多变 N 次后稳定。
 * 内存口径:Map<sessionId, Set<toolName>>,进程内常驻。会话数有限,单个 Set 至多几十项,无泄漏风险;
 * 不做持久化——网关重启后重新裁剪一次是正确行为(新进程本来就没有旧前缀可复用)。
 */
const SESSION_TOOL_FLOOR = new Map<string, Set<string>>();

/** 清空会话冻结集(测试用;也用于「用户要求彻底重置会话」路径)。 */
export function resetSessionToolFloor(sessionId?: string): void {
  if (sessionId === undefined) SESSION_TOOL_FLOOR.clear();
  else SESSION_TOOL_FLOOR.delete(sessionId);
}

/**
 * 会话级工具面冻结:返回「本次装配结果 ∪ 该 session 已装配过的工具」。
 * sessionId 缺省 = 不冻结(纯按 taskClass 裁剪),兼容旧调用点与单测。
 */
export function freezeToolsForSession<T extends { name: string }>(
  tools: T[],
  taskClass: string | undefined,
  sessionId: string | undefined): T[] {
  const pruned = pruneToolsForTaskClass(tools, taskClass);
  if (!sessionId) return pruned;
  const seen = SESSION_TOOL_FLOOR.get(sessionId);
  if (!seen) {
    SESSION_TOOL_FLOOR.set(sessionId, new Set(pruned.map((t) => t.name)));
    return pruned;
  }
  // 只增:本次裁剪掉、但会话历史上广告过的工具要补回来(否则前缀从该位置起变化)
  const out = pruned.slice();
  const have = new Set(out.map((t) => t.name));
  for (const t of tools) {
    if (seen.has(t.name) && !have.has(t.name)) {
      out.push(t);
      have.add(t.name);
    }
  }
  for (const n of have) seen.add(n);
  return out;
}

/** 取 description 首句(到第一个中文句号/分号或长度上限)。 */
function firstSentence(description: string): string {
  const s = description.trim();
  const m = /[。;；]/.exec(s);
  const cut = m && m.index > 0 && m.index <= SUMMARY_SENTENCE_CHARS ? m.index : SUMMARY_SENTENCE_CHARS;
  return (cut < s.length ? s.slice(0, cut) + "…" : s);
}

/** 单工具摘要化(不变更 execute/schema,只换 description)。 */
export function summarizeToolDescription(name: string, description: string): string {
  return `${firstSentence(description)}(完整用法/参数细则/纪律先调 tool_view(name="${name}") 查看)`;
}

/** 目录文本预算(字符)。4000 ≈ 1k token:目录只是「还有哪些工具可按需加载」的索引,
 * 超出这个量级就不是索引而是第二份工具清单了(大板 60 工具经验证目录 6k+ 字符)。 */
export const TOOL_CATALOG_MAX_CHARS = 4_000;

/** tool_search 默认/上限返回条数(limit 即分页粒度;上限 50 防一次把整份目录吐回来)。 */
const TOOL_SEARCH_DEFAULT_LIMIT = 10;
const TOOL_SEARCH_MAX_LIMIT = 50;
/** 加权口径:name 命中 3 分、description 命中 1 分(大小写不敏感,空格分词后逐词累加)。 */
const SEARCH_NAME_SCORE = 3;
const SEARCH_DESC_SCORE = 1;

/** 目录降级档位:full(名字+首句)→names(仅名字)→summary(前若干名字+计数)→bare(硬截断)→none(不写)。 */
export type ToolCatalogMode = "full" | "names" | "summary" | "bare" | "none";

export interface ToolCatalog {
  text: string;
  mode: ToolCatalogMode;
}

/**
 * 构建延迟目录文本并按预算降级。**只降目录,不动工具**:
 * 目录被截断不影响任何工具的可调用性——模型可随时用 tool_search 重新检索。
 */
export function buildToolCatalog(
  deferredNames: string[],
  full: Map<string, Tool>,
  maxChars: number = TOOL_CATALOG_MAX_CHARS): ToolCatalog {
  if (deferredNames.length === 0) return { text: "", mode: "none" };
  const limit = Math.max(0, maxChars);
  const fullText = deferredNames
    .map((n) => `${n}(${firstSentence(full.get(n)?.description ?? "").slice(0, 40)})`)
    .join(",");
  if (fullText.length <= limit) return { text: fullText, mode: "full" };
  const namesText = deferredNames.join(",");
  if (namesText.length <= limit) return { text: namesText, mode: "names" };
  // summary:尽量多列名字,尾部换成一个计数提示;仍装不下就只剩 bare。
  const total = deferredNames.length;
  const note = (rest: number) => `…等共${total}个(其余用 tool_search 检索)`;
  const keep: string[] = [];
  for (const n of deferredNames) {
    const rest = total - keep.length - 1;
    if (keep.concat(n).join(",").length + note(rest).length > limit) break;
    keep.push(n);
  }
  if (keep.length > 0) return { text: `${keep.join(",")}${note(total - keep.length)}`, mode: "summary" };
  // bare:硬截断到预算并以逗号收尾(读者看得出列表被截断)。
  return { text: `${namesText.slice(0, Math.max(0, limit - 1))},`, mode: "bare" };
}

/** 关键词打分(纯函数,便于单测):name 命中 3 分、description 命中 1 分,空白分词后逐词累加。 */
export function scoreToolMatch(query: string, name: string, description: string): number {
  const tokens = query.toLowerCase().split(/\s+/).filter((s) => s.length > 0);
  if (tokens.length === 0) return 0;
  const n = name.toLowerCase();
  const d = description.toLowerCase();
  let score = 0;
  for (const tk of tokens) {
    if (n.includes(tk)) score += SEARCH_NAME_SCORE;
    if (d.includes(tk)) score += SEARCH_DESC_SCORE;
  }
  return score;
}

/** tool_search:在延迟目录里加权检索(只写方法,不放全量目录——目录按预算落在 tool_view)。 */
function toolSearchTool(full: Map<string, Tool>, deferredNames: string[]): Tool {
  return {
    name: "tool_search",
    description:
      "在延迟加载的工具目录里按关键词检索(目录里只有不在工具清单中的工具;清单内工具直接调用即可)。" +
      "query=关键词,空白分词、大小写不敏感,name 命中 3 分/description 命中 1 分,同分按 name 字典序;" +
      "limit=返回条数(默认 10,上限 50)。返回 `name: 首句` 列表;零命中返回「无匹配」与目录总数。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词(可空格分隔多个词)" },
        limit: { type: "number", description: `返回条数(默认 ${TOOL_SEARCH_DEFAULT_LIMIT},上限 ${TOOL_SEARCH_MAX_LIMIT})` },
      },
      required: ["query"],
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(raw: unknown) {
      const a = (raw ?? {}) as { query?: unknown; limit?: unknown };
      const query = String(a.query ?? "").trim();
      const total = deferredNames.length;
      const rawLimit = Number(a.limit);
      const limit =
        Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(Math.floor(rawLimit), TOOL_SEARCH_MAX_LIMIT)
          : TOOL_SEARCH_DEFAULT_LIMIT;
      const hits = deferredNames
        .map((name) => ({ name, score: scoreToolMatch(query, name, full.get(name)?.description ?? "") }))
        .filter((h) => h.score > 0)
        .sort((x, y) => y.score - x.score || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
      if (hits.length === 0) {
        return `[tool_search] 无匹配(查询 "${query}";延迟工具目录共 ${total} 个)`;
      }
      const page = hits.slice(0, limit);
      const more = hits.length > page.length ? `(共 ${hits.length} 个,还有 ${hits.length - page.length} 个未显示,加大 limit)` : "";
      return [
        `[tool_search] ${page.length} 个匹配${more}:`,
        ...page.map((h) => `${h.name}: ${firstSentence(full.get(h.name)?.description ?? "")}`),
      ].join("\n");
    },
  };
}

/** tool_call:只桥接**只读**的延迟工具(写类/执行类必须直调,否则绕过权限审批链)。 */
function toolCallTool(full: Map<string, Tool>, deferredNames: string[]): Tool {
  return {
    name: "tool_call",
    description:
      "桥接调用一个只读的延迟加载工具:name=工具名(须在延迟目录中),arguments=该工具的参数对象;按底层 schema 校验必填字段后转发执行并返回其结果。" +
      "非只读工具需直接调用,tool_call 只桥接只读工具(避免绕过审批)。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "延迟目录中的工具名" },
        arguments: { type: "object", description: "该工具的参数对象(按其 schema)" },
      },
      required: ["name"],
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(raw: unknown) {
      const a = (raw ?? {}) as { name?: unknown; arguments?: unknown };
      const name = String(a.name ?? "");
      const target = full.get(name);
      if (!target) {
        return `[tool_call] 未知工具 ${name};延迟目录:${deferredNames.join(", ") || "(空)"}`;
      }
      if (!deferredNames.includes(name)) {
        return `[tool_call] ${name} 不是延迟加载工具(已在工具清单里),请直接调用。`;
      }
      let readOnly = false;
      try {
        readOnly = target.isReadOnly?.(a.arguments ?? {}) === true;
      } catch {
        readOnly = false;
      }
      if (!readOnly) {
        return `[tool_call] ${name} 非只读工具:需直接调用,tool_call 只桥接只读工具(避免绕过审批)。`;
      }
      if (a.arguments !== undefined && (typeof a.arguments !== "object" || a.arguments === null || Array.isArray(a.arguments))) {
        return `[tool_call] ${name} 的 arguments 必须是参数对象(收到 ${Array.isArray(a.arguments) ? "数组" : typeof a.arguments})。`;
      }
      const args = (a.arguments ?? {}) as Record<string, unknown>;
      const requiredRaw = (target.parameters as { required?: unknown })?.required;
      const required = Array.isArray(requiredRaw) ? requiredRaw.filter((k): k is string => typeof k === "string") : [];
      const missing = required.filter((k) => args[k] === undefined || args[k] === null);
      if (missing.length > 0) {
        return `[tool_call] ${name} 缺少必填参数:${missing.join(", ")}(该工具的必填字段:${required.join(", ")})`;
      }
      return await target.execute(args);
    },
  };
}

/** tool_view 工具本体:name enum=在场工具全集;返回原 description 全文+参数 schema。
 * 延迟工具目录写进 description(模型据此知道「还有哪些工具可按需加载」)。 */
function toolViewTool(full: Map<string, Tool>, deferredNames: string[], catalogMaxChars?: number): Tool {
  const names = [...full.keys()];
  const cat = buildToolCatalog(deferredNames, full, catalogMaxChars);
  const catalog =
    cat.mode === "none"
      ? ""
      : "延迟加载工具(未在使用前不进工具清单;先调本工具看全文,或调 tool_search 检索;" +
        `目录 ${cat.mode} 档):` +
        cat.text;
  return {
    name: "tool_view",
    description:
      "查看某个工具的完整用法说明与参数细则(长描述工具在工具清单里只有首句摘要)。" +
      "首次使用某个复杂工具(如 board_upsert/spawn_subagent/browser)前先调它看完整说明,再按说明调用。" +
      catalog,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", enum: names, description: "工具名(枚举=当前在场工具全集)" },
      },
      required: ["name"],
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(args: unknown) {
      const n = String((args as { name?: unknown })?.name ?? "");
      const t = full.get(n);
      if (!t) return `[tool_view] 未知工具 ${n};在场工具:${names.join(", ")}`;
 // 全量说明书(工具面瘦身):wire description 只留必须常驻的部分,被移出的规则
      // 正文落在 tool-full-docs.ts;这里优先取专档,没有专档的工具仍返回自身 description。
      return [
        `# ${t.name} 完整说明`,
        "",
        "## 用法(全量)",
        fullDocFor(t.name, t.description),
        "",
        "## 参数 schema",
        "```json",
        JSON.stringify(t.parameters, null, 2),
        "```",
      ].join("\n");
    },
  };
}

/**
 * 装配:摘要化长描述工具、按 wire 体量打 defer 标并追加 bridge 工具(tool_view/tool_search/tool_call)。
 * 返回新数组(原数组不变)。loop 执行面与 trace 面拿到的就是同一份包装后清单(怎么送的怎么记/怎么执行)。
 * opts.defer=false 或 env GENIE_TOOL_DEFER=off = 关闭延迟加载(只做描述摘要,回退口径)。
 * **装配失败纪律**:任何异常都退回入参 tools 原样(工具照旧可用),只 console.error 一次——
 * 工具面装配是任务启动的前置,装配 bug 不该让整个任务起不来,也不该静默丢工具。
 */
export function attachToolView(
  tools: Tool[],
  opts?: { defer?: boolean; deferMinChars?: number; catalogMaxChars?: number },
): Tool[] {
  try {
    return attachToolViewInner(tools, opts);
  } catch (err) {
    console.error("[tool-view] 工具面装配失败,已回退未包装的原工具列表:", err);
    return tools;
  }
}

function attachToolViewInner(
  tools: Tool[],
  opts?: { defer?: boolean; deferMinChars?: number; catalogMaxChars?: number },
): Tool[] {
  if (tools.length === 0) return tools;
  const full = new Map(tools.map((t) => [t.name, t]));
  const deferEnabled = opts?.defer ?? String(process.env.GENIE_TOOL_DEFER ?? "").toLowerCase() !== "off";
  const minChars = opts?.deferMinChars ?? TOOL_DEFER_MIN_CHARS;
  const summarized = tools.map((t) =>
    t.description.length > TOOL_SUMMARY_CHARS ? { ...t, description: summarizeToolDescription(t.name, t.description) } : t);
  if (!deferEnabled) {
    summarized.push(
      toolViewTool(full, [], opts?.catalogMaxChars),
      toolSearchTool(full, []),
      toolCallTool(full, []),
    );
    return summarized;
  }
  const deferredNames: string[] = [];
  const out = summarized.map((t) => {
    // 判定用**原始**规格体量(摘要后 description 已被截短,按摘要后判定会让「description 大」
    // 的工具反而逃过延迟——实体例:9000 字描述的工具摘要后不足阈值)。
    const orig = full.get(t.name)!;
    const wire = orig.description.length + JSON.stringify(orig.parameters).length;
    if (BRIDGE_TOOL_NAMES.has(t.name) || CORE_NEVER_DEFER.has(t.name) || wire < minChars) return t;
    deferredNames.push(t.name);
    return { ...t, deferred: true };
  });
  out.push(
    toolViewTool(full, deferredNames, opts?.catalogMaxChars),
    toolSearchTool(full, deferredNames),
    toolCallTool(full, deferredNames),
  );
  return out;
}
