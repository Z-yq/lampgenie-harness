/**
 * 白板 → flowkit OFK DSL 序列化(白板族,扩「白板出图」)。
 * 职责单一:BoardDoc → OFK 文本(纯函数,无 IO 无依赖),编译/导出在 board-diagram.ts。
 * 为什么必须清洗:OFK 解析器(openflowkit-mcp 0.2.4)对标签里的语法字符敏感——
 * 经验证 `{`/`}` 会被当成 group 块开合(W106)+ 连带 `->` 行被丢(W101);行内出现裸换行
 * 直接 W102 Unterminated quote 并丢行;边标签里的 `{` 触发 W101 Block opener。
 * 丢行=整张图缺节点,所以这里逐字符族替换 + 每个替换记 warnings(排查用,不静默)。
 * 经验证(CLEAN = 无诊断):`[` `]` `|` `:` `；` `<` `>` `#` `%` 双引号(含转义)反斜杠在标签里安全;
 * 危险集 = `{` `}` 换行 边标签 `{`。任务书要求的替换集是危险集超集,超集不伤正确性,一并执行。
 */

import type { BoardDoc, BoardFlowStep } from "@lampgenie/protocol";

export interface OfkSerializeResult {
  /** 完整 OFK 文本(含首行 `%% ofk 1`、flowchart、direction 头)。 */
  ofk: string;
  /** 清洗/截断/丢边记录,一条一句便于排查("node n3: label 含 {} 已替换")。 */
  warnings: string[];
}

/** 节点上限(与 protocol BoardDocZ.nodes max(60) 一致;超出截断防巨型图)。 */
const MAX_NODES = 60;
/** desc 总预算(字符,中文按 1 字算)。 */
export const DESC_MAX = 120;
/**
 * desc 内「summary 首句」部分的预算。
 * 出图经验证(17 节点真板,节点卡宽 790px):~72 字就把卡撑到边、再长就被 flowkit 硬切且无省略号。
 * 总预算 DESC_MAX 不变,summary 单独限宽是为了留足给 flow 概述与锚段——三者一起挤 120 字时
 * 最先被切掉的总是锚段/流程,而锚段是「在哪」的唯一线索。
 */
export const DESC_LABEL_BUDGET = 72;
/** 截断必须显式加省略号:硬裁=静默丢信息(读者看不出摘要被截了)。 */
const ELLIPSIS = "…";
/** summary 取首句的切分符(全角句号/分号、半角分号、全角/半角竖线)。 */
const SENTENCE_SEP = /[。；;｜|]/;

type Node = BoardDoc["nodes"][number];
type Edge = BoardDoc["edges"][number];

/**
 * kind → OFK shape。合法 shape 词表(oflk gram 5.1)只有 16 个:
 * `rect rounded circle ellipse diamond cylinder hexagon cloud doc note
 *  parallelogram person queue component browser mobile`——别的词会被当未知属性(W131)。
 * 所以本函数只返回这 16 个词之一;未识别 kind 退化成 rect(=默认形状,序列化时也不必省略)。
 */
export function shapeFor(kind: string): string {
  switch (kind) {
    case "decision":
    case "wf-condition":
    case "classifier":
      return "diamond";
    case "start":
    case "end":
      return "ellipse";
    case "note":
      return "note";
    case "io":
      return "parallelogram";
    default:
      break;
  }
  switch (kind) {
    case "module":
    case "component":
    case "http":
      return "component";
    case "llm":
      return "rounded";
    case "tool":
    case "loop":
      return "hexagon";
    case "aggregate":
    case "wf-parallel":
      return "queue";
    case "retrieval":
      return "cylinder";
    case "agent":
    case "wf-agent":
      return "person";
    case "page":
      return "browser";
    case "template":
      return "doc";
    case "wf-notify":
      return "note";
    case "section":
    case "nav":
    case "wf-script":
    case "wf-test":
    case "function":
    default:
      return "rect";
  }
}

/** change → OFK 颜色词。keep/未知不上色(不写 color 属性,保持画布素色)。 */
function colorFor(change: string | undefined): string {
  switch (change) {
    case "add":
      return "green";
    case "modify":
      return "orange";
    case "delete":
      return "red";
    default:
      return "";
  }
}

/** 多段 flow 概述之间的分隔符(全角竖线——ASCII `|` 会被 OFK 当语法字符)。 */
const OUTLINE_SEP = " ｜ ";
/** 分支/循环体里最多列几条 step 文本。 */
const OUTLINE_ITEMS = 2;

/** 把一组 step 的 text 前 N 条用「、」连,超出加「 等」;无文本返回空串。 */
function stepTexts(steps: BoardFlowStep[] | undefined): string {
  const arr = Array.isArray(steps) ? steps : [];
  const texts: string[] = [];
  for (const s of arr) {
    const t = typeof s.text === "string" ? s.text.trim() : "";
    if (t) texts.push(t);
  }
  if (!texts.length) return "";
  const head = texts.slice(0, OUTLINE_ITEMS).join("、");
  return texts.length > OUTLINE_ITEMS ? `${head} 等` : head;
}

/**
 * flow → 一行副标题概述(纯函数,独立便于单测)。
 * branch: `分支: <cond>; 是→<then 前2条>; 否→<else 前2条>`(else 空则省略「否→」段)
 * loop:   `循环 <over>: <body 前2条>`
 * step:   忽略(顶层 step 不进副标题,顺序由画布节点本身表达)。
 * 无 flow/全是 step → 空串。多段用 ` ｜ ` 连接。
 */
export function flowOutline(flow: BoardFlowStep[] | undefined): string {
  const roots = Array.isArray(flow) ? flow : [];
  const parts: string[] = [];
  for (const s of roots) {
    if (s.type === "branch") {
      const cond = (s.cond ?? "").trim();
      let seg = `分支: ${cond}`;
      const thenTxt = stepTexts(s.then);
      if (thenTxt) seg += `; 是→${thenTxt}`;
      const elseTxt = stepTexts(s.else);
      if (elseTxt) seg += `; 否→${elseTxt}`;
      parts.push(seg);
    } else if (s.type === "loop") {
      const over = (s.over ?? "").trim();
      const bodyTxt = stepTexts(s.body);
      parts.push(bodyTxt ? `循环 ${over}: ${bodyTxt}` : `循环 ${over}`);
    }
  }
  return parts.join(OUTLINE_SEP);
}

/** 锚段与 summary/flow 之间、锚段内部两段之间的分隔符。 */
const ANCHOR_SEP = " · ";
/** 锚段括注符:用 ⟨⟩(U+27E8/U+27E9)而非 `<>`——`<>` 是 OFK/HTML 转义敏感字符族,sanitize 也不动 ⟨⟩。 */
const ANCHOR_OPEN = "⟨";
const ANCHOR_CLOSE = "⟩";
/** targets 最多出的文件基名个数,余量写成 `+N`。 */
const ANCHOR_MAX_TARGETS = 2;
/** 锚段占用预算后 summary 侧至少要保住多少字,低于此值就退化成「锚段在前」。 */
const DESC_SUMMARY_MIN = 40;

/**
 * 路径 → 文件基名:targets 允许 `path#symbol`,只取 `#` 前的路径;兼容 `/` 与 `\`。
 * 纯字符串切分,不引 path 依赖(本模块保持无依赖纯函数)。
 */
function fileBase(raw: string): string {
  const head = String(raw ?? "").split("#")[0] ?? "";
  const path = head.trim();
  const segs = path.split(/[/\\]/).filter((s) => s.length > 0);
  const last = segs[segs.length - 1];
  return last ?? "";
}

/**
 * 节点 → 结构化锚文本(「这个节点对应仓库哪段代码」)。
 * 有 symbolRef → `⟨符号名 @ 文件基名:行号⟩`;有 targets → `⟨a.ts, b.ts⟩`(最多 2 个,余量 `+N`);
 * 两者都有用 ` · ` 连(符号段在前);都没有 → 空串(旧板/办公板 desc 逐字不变)。
 * 为什么进 desc:SVG 默认视图只渲染 label+desc,不进 desc 用户就看不到节点↔代码的关联。
 */
export function anchorText(n: Node): string {
  const parts: string[] = [];
  const ref = n.symbolRef;
  if (ref && typeof ref.name === "string" && ref.name.trim()) {
    const name = ref.name.trim();
    const base = fileBase(String(ref.file ?? ""));
    const line = Number(ref.line);
    const loc = base ? `${base}${Number.isFinite(line) && line > 0 ? `:${line}` : ""}` : "";
    parts.push(`${ANCHOR_OPEN}${loc ? `${name} @ ${loc}` : name}${ANCHOR_CLOSE}`);
  }
  const bases: string[] = [];
  for (const t of Array.isArray(n.targets) ? n.targets : []) {
    const b = fileBase(String(t ?? ""));
    if (b && !bases.includes(b)) bases.push(b);
  }
  if (bases.length) {
    const shown = bases.slice(0, ANCHOR_MAX_TARGETS).join(", ");
    const rest = bases.length - ANCHOR_MAX_TARGETS;
    parts.push(`${ANCHOR_OPEN}${shown}${rest > 0 ? ` +${rest}` : ""}${ANCHOR_CLOSE}`);
  }
  return parts.join(ANCHOR_SEP);
}

/**
 * label 缺失时的关系词兜底表(克制动词,来源是数据里的 `kind`——不自动编造语义)。
 * 只覆盖 BoardDocZ 的 kind 词表;未命中就保持无 label,并记一条 warning 说明无可映射词。
 */
const EDGE_KIND_VERB: Record<string, string> = {
  call: "调用",
  data: "数据",
  verify: "验证",
  nav: "跳转",
  contains: "包含",
};

/**
 * 边 → 箭头记号(OFK 边不能上色,只能靠线型表达语义):
 * contains → `--`(无箭头实线,组合关系);verify/nav → `-->`(虚线,非执行依赖);
 * call/data/未知 → `->`;virtual(推导出的待核实边)在 `->` 基础上升级成虚线。
 */
function arrowFor(e: Edge): string {
  const kind = String(e.kind ?? "call");
  if (kind === "contains") return "--";
  if (kind === "verify" || kind === "nav") return "-->";
  return (e as { virtual?: boolean }).virtual === true ? "-->" : "->";
}

/**
 * 单字段清洗:按危险字符族逐类替换,每类替换记一条 warning。
 * 顺序有讲究:`\` 先转义(否则后面的 `\"` 会被二次转义),`"` 再转义,换行压平。
 * @param raw 原文
 * @param where 记录前缀(如 `node n3: label`)
 * @param warnings warning 累积数组
 */
export function sanitize(raw: string, where: string, warnings: string[], opts: { keepColon?: boolean } = {}): string {
  let out = raw;
  // [原字符, 替换, warning 里显示的名字] —— 顺序即安全性顺序,不可重排。
  const singles: Array<[string, string, string]> = [
    ["\\", "\\\\", "反斜杠"],
    ['"', '\\"', "双引号"],
    ["\r", " ", "换行"],
    ["\n", " ", "换行"],
    ["{", "（", "{}"],
    ["}", "）", "{}"],
    ["[", "(", "[]"],
    ["]", ")", "[]"],
    ["|", "/", "|"],
    [":", "；", ":"],
  ];
  const noted = new Set<string>();
  for (const [ch, rep, name] of singles) {
    // 结构化锚(`⟨符号 @ file.ts:60⟩`)要保留 ASCII `:` 表达行号——`:` 在标签/desc 引号内
 // 经验证是 OFK 安全字符(见文件头),保留只为可读性。
    if (ch === ":" && opts.keepColon) continue;
    if (out.includes(ch)) {
      out = out.split(ch).join(rep);
      // 同类多字符(如 `{` 与 `}`)只记一条,避免 warnings 噪音翻倍。
      if (!noted.has(name)) {
        noted.add(name);
        warnings.push(`${where} 含 ${name} 已替换`);
      }
    }
  }
  return out;
}

/**
 * 截断 + 记 warning(按字符数,不按字节,中文按 1 字算)。
 * 末尾一定补 `…`:溢出被下游(flowkit SVG)直接切掉时读者无从判断是否被截,省略号是唯一的可见信号。
 */
function clip(text: string, max: number, where: string, warnings: string[]): string {
  if (text.length <= max) return text;
  warnings.push(`${where} 超长 ${text.length} 字已截断至 ${max} 字(含省略号)`);
  if (max <= 0) return "";
  if (max === 1) return ELLIPSIS;
  return `${text.slice(0, max - 1)}${ELLIPSIS}`;
}

/**
 * summary → 首句(「有什么用」只回答一次,后面的补充说明进 desc 只会挤掉流程/锚段)。
 * 按 `。；;｜|` 切第一个;去掉句末标点;全空(没有可读首句)时回退到原文去尾标点。
 */
export function firstSentence(summary: string): string {
  const s = String(summary ?? "").trim();
  if (!s) return "";
  const m = SENTENCE_SEP.exec(s);
  const head = m ? s.slice(0, m.index) : s;
  const strip = (t: string) => t.trim().replace(/[。；;｜|，,、\s]+$/, "");
  return strip(head) || strip(s);
}

/**
 * 节点行: `<id> [<shape>, label: "<label>", desc: "<summary> ｜ <flow>", color: <色>]`。
 * color 放在末尾:属性表是按词表分派的(color 属 colour 类),位置不敏感;放末尾让既有
 * 「`n1 [rect, label: "…", desc: "…"]`」形态断言在无 change 着色时逐字不变。
 */
function nodeLine(n: Node, warnings: string[]): string {
  const id = sanitize(n.id, `node ${n.id}: id`, warnings);
  const label = sanitize(n.label, `node ${n.id}: label`, warnings);
  const shape = shapeFor(String(n.kind ?? "function"));
  let line = `  ${id} [${shape}, label: "${label}"`;
  const where = `node ${n.id}: summary`;
  const rawSummary = (n.summary ?? "").trim();
  // 「有什么用」= summary 首句,且按节点可用宽度单独限宽(DESC_LABEL_BUDGET)。
  const summary = rawSummary ? clip(firstSentence(rawSummary), DESC_LABEL_BUDGET, where, warnings) : "";
  const outline = flowOutline(n.flow);
  // 先把 summary 与 flow 概述拼成一条,再 clip(按合并后长度截断),最后 sanitize——
  // 顺序不可反:清洗会把 1 字符展开成 2 字符,先 sanitize 后 clip 会让截断字数与 warning 不符。
  const raw = outline ? `${summary}${summary ? OUTLINE_SEP : ""}${outline}` : summary;
  const rawAnchor = anchorText(n);
  const anchor = rawAnchor ? sanitize(rawAnchor, where, warnings, { keepColon: true }) : "";
  // 锚段(节点↔代码)永远完整保留:clip 预算从 summary 侧收,即 clip(raw, DESC_MAX - anchorLen) + anchor。
  // 退让规则:留给 summary 的预算不足 DESC_SUMMARY_MIN 时改「锚段在前、summary 在后」——
  // 否则极短预算会把 summary 切到只剩几个字,信息量比锚段还低。
  // 注意 body 单独 sanitize(冒号仍按既有规则换成 `；`),锚段单独 sanitize 且保留 `:` 表行号——
  // 两者分开做,既有 summary/flow 的 desc 形态断言才逐字不变。
  let desc: string | null = null;
  if (anchor) {
    const budget = DESC_MAX - anchor.length;
    if (budget >= DESC_SUMMARY_MIN) {
      const body = raw ? sanitize(clip(raw, budget, where, warnings), where, warnings) : "";
      desc = body ? `${body}${ANCHOR_SEP}${anchor}` : anchor;
    } else {
      const body = raw ? sanitize(clip(raw, Math.max(budget - ANCHOR_SEP.length, 0), where, warnings), where, warnings) : "";
      desc = body ? `${anchor}${ANCHOR_SEP}${body}` : anchor;
    }
  } else if (raw) {
    desc = sanitize(clip(raw, DESC_MAX, where, warnings), where, warnings);
  }
  if (desc) line += `, desc: "${desc}"`;
  // change 不在词表内(keep/undefined/脏值)一律不上色,且绝不抛。
  const color = colorFor(typeof n.change === "string" ? n.change : "");
  if (color) line += `, color: ${color}`;
  return `${line}]`;
}

/**
 * BoardDoc → OFK 文本。
 * 布局策略:同 group 节点包进 `group "<名>" {` 块;无 group 节点在最外层;
 * 边(无缩进)全部写在整个图末尾——OFK 的 group 块只影响布局分区,边写在块外可跨泳道。
 */
export function serializeBoard(doc: BoardDoc): OfkSerializeResult {
  const warnings: string[] = [];
  const allNodes: Node[] = Array.isArray(doc.nodes) ? doc.nodes : [];
  let nodes = allNodes;
  if (nodes.length > MAX_NODES) {
    warnings.push(`节点数 ${nodes.length} 超上限 ${MAX_NODES},已截断`);
    nodes = nodes.slice(0, MAX_NODES);
  }
  const known = new Set(nodes.map((n) => n.id));
  const direction = doc.boardType === "code" ? "right" : "down";

  const lines: string[] = ["%% ofk 1", "flowchart", `direction: ${direction}`, ""];

  // 按 group 分组,保持首次出现顺序(group 名顺序 = 节点里首次出现的顺序)。
  const groups = new Map<string, Node[]>();
  const loose: Node[] = [];
  for (const n of nodes) {
    const g = typeof n.group === "string" ? n.group.trim() : "";
    if (!g) {
      loose.push(n);
      continue;
    }
    const arr = groups.get(g);
    if (arr) arr.push(n);
    else groups.set(g, [n]);
  }

  if (loose.length) {
    // `%%` 只能出现在版本行(grammar.md §2.2:它不是注释)——写成 `  %% 未分泳道` 会被解析成
 // 名为「%% 未分泳道」的节点(活面板经验证:画布上多出一个空框)。注释统一用 `//`。
    lines.push("// 未分泳道");
    for (const n of loose) lines.push(nodeLine(n, warnings));
    lines.push("");
  }

  for (const [gname, members] of groups) {
    const gid = sanitize(gname, `group ${gname}`, warnings);
    lines.push(`  group "${gid}" {`);
    for (const n of members) lines.push(`  ${nodeLine(n, warnings)}`);
    lines.push("  }");
    lines.push("");
  }

  // 边:from/to 必须都在(截断后的)节点集里,否则丢边 + warning。
  const edgeLines: string[] = [];
  for (const e of Array.isArray(doc.edges) ? doc.edges : []) {
    const from = String(e.from ?? "");
    const to = String(e.to ?? "");
    if (!known.has(from) || !known.has(to)) {
      const missing = !known.has(from) ? from : to;
      warnings.push(`edge ${from} -> ${to}: 端点 ${missing} 不在节点集,已丢弃`);
      continue;
    }
    const fid = sanitize(from, `edge ${from}->${to}: from`, warnings);
    const tid = sanitize(to, `edge ${from}->${to}: to`, warnings);
    let line = `${fid} ${arrowFor(e)} ${tid}`;
    const label = typeof e.label === "string" ? e.label.trim() : "";
    if (label) {
      line += ` : ${sanitize(label, `edge ${from}->${to}: label`, warnings)}`;
    } else {
      // label 缺失时用 kind 兜底(不是编造):关系词来源是数据里的 kind,virtual 人工边同样适用。
      const kind = typeof e.kind === "string" ? e.kind.trim() : "";
      const verb = kind ? EDGE_KIND_VERB[kind] : "";
      if (verb) {
        line += ` : ${verb}`;
        warnings.push(`edge ${from}->${to}: label 缺失,已用 kind=${kind} 兜底`);
      } else if (kind) {
        warnings.push(`edge ${from}->${to}: label 缺失且 kind=${kind} 无可映射关系词`);
      }
    }
    edgeLines.push(line);
  }
  if (edgeLines.length) lines.push(...edgeLines);

  return { ofk: `${lines.join("\n")}\n`, warnings };
}