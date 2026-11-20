import type { BoardAccept } from "@lampgenie/protocol";

/** 紧凑白板 DSL → BoardDoc 片段(step:LLM 落板省字节)。
 * 背景:agent 落板时要逐节点写全字段 JSON(40164 字节的板 ≈ 1.2 万 token),其中大半是重复键名。
 * 本解析器只吃「行式 DSL」,把键名压成行首关键字,字段用 `|` 分隔,经验证同板 ≈34% 字节。
 * 语法(稳定版,可直接写进文档/提示词):
 * ```
 * %% board v1
 * title: <自由文本到行尾>
 * type: code            # → meta.boardType
 * scale: M              # → meta.scale
 * kind: design          # → meta.docKind
 * lane <泳道名> : <id> <id> <id>        # 声明泳道成员与板上顺序(→ node.group)
 * node <id> <kind> <change> [<phase>] "<label>" | <summary> [| <before>]
 *   accept: [<type>] <cmd> => <expect> [| <note>]   # 可重复;type 省略则不写 type 字段
 *   targets: <file1>, <file2>
 *   sym: <name>@<file>:<line>
 *   flow: step <text>                             # 可重复,顺序即数组顺序
 *   flow: branch <cond> ? <thenText> : <elseText> # elseText 可省
 *   flow: loop over <expr> | body <t1>; <t2>
 * edge <from> -> <to> : <label>         # -> call / ->> data / ~> verify / => nav / =>> contains
 * ```
 * accept 的 `<type>` ∈ command|browser|manual|negative(非法值 → W_ACCEPT_TYPE_UNKNOWN 并省略);
 * `<note>` 是 ` | ` 之后的说明(≤300,超限截断)。accept 的 cmd 按**最后一个** ` => ` 切分,
 * 所以 cmd 里本身带箭头也不会切错。
 * 细节:`%%` 版本行、空行、`#` 开头行忽略;缩进(2 空格)的附属行作用于最近一个 node 行;
 * 文本里要写 `|` 请转义成 `\|`;未知行记 E_UNKNOWN_LINE 并跳过(不抛错)。
 * 长度的校验:超出 zod 上限(label ≤160/summary,before ≤500/accept.cmd ≤500/targets 每项 ≤400…)
 * 一律 warn + 截断,避免「解析成功但落盘被 zod 拒」。
 */

/** 诊断:line 为 1-based 行号。 */
export interface BoardDslDiag {
  line: number;
  severity: "error" | "warn";
  code: string;
  message: string;
}

/** 节点:字段名对齐 BoardNodeZ;未在 DSL 里写的字段保持 undefined,由 zod default/optional 补。 */
export interface BoardDslNode {
  id: string;
  /** BoardNodeZ.kind 枚举内值;DSL 给了非法值时省略(→ zod default "function")。 */
  kind?: string;
  label: string;
  /** 省略时回退为 label。 */
  summary: string;
  /** 由 lane 行赋予;未进任何 lane 则 undefined。 */
  group?: string;
  before?: string;
  /** add | modify | delete | keep;非法值省略(→ zod default "modify")。 */
  change?: string;
  /** P0 | P1 | P2;非法值省略。 */
  phase?: string;
  symbolRef?: { name: string; file?: string; line?: number };
  targets?: string[];
  accept?: BoardAccept[];
  /** 代码级流程(扁平子集):step / branch(有 then[, else]) / loop(有 over[, body]);由 flow: 行按序追加。 */
  flow?: BoardDslFlowStep[];
  /** mergeDslWithNodes 要补的其余可选字段(JSON 白名单内的部分,与 BoardNodeZ 同名)。 */
  evidence?: unknown[];
  comments?: string[];
  wf?: unknown;
  fileRef?: string;
  done?: boolean;
  pos?: { x: number; y: number };
}

/** flow 步骤(对齐 BoardFlowStepZ 的扁平子集:DSL 只表达一层 branch/loop 的 then/else/body)。 */
export interface BoardDslFlowStep {
  type: "step" | "branch" | "loop";
  text?: string;
  cond?: string;
  over?: string;
  then?: BoardDslFlowStep[];
  else?: BoardDslFlowStep[];
  body?: BoardDslFlowStep[];
}

/** 边:对齐 BoardDocZ.edges 元素(from/to/kind/label)。 */
export interface BoardDslEdge {
  from: string;
  to: string;
  kind: "call" | "data" | "verify" | "nav" | "contains";
  label?: string;
}

export interface BoardDslResult {
  /** 只表示「能出板」(nodes 非空);错误明细看 diags。 */
  ok: boolean;
  diags: BoardDslDiag[];
  meta: { title?: string; boardType?: string; scale?: string; docKind?: string };
  nodes: BoardDslNode[];
  edges: BoardDslEdge[];
 /** serializeBoardDsl 的 `%% json-extra` 段载荷(原样 JSON.parse 结果;无该段为 undefined)。
 * 读侧由调用方自行 merge(主干表达不了的白名单字段:comments/pos/done/evidence/humanEdits 等)。 */
  extra?: unknown;
}

/** 箭头 → 边 kind(文档化用)。 */
export const BOARD_DSL_ARROWS: Record<string, BoardDslEdge["kind"]> = {
  "->": "call",
  "->>": "data",
  "~>": "verify",
  "=>": "nav",
  "=>>": "contains",
};

/** 与 BoardNodeZ.kind 枚举同步(只用于给出「未知 kind」提示,不阻断解析)。 */
const KINDS = new Set([
  "module", "function", "decision", "note", "llm", "tool", "io",
  "start", "end", "http", "template", "aggregate", "loop", "retrieval", "classifier", "agent",
  "page", "section", "component", "nav",
  "wf-script", "wf-test", "wf-agent", "wf-condition", "wf-parallel", "wf-notify",
]);
const CHANGES = new Set(["add", "modify", "delete", "keep"]);
const PHASES = new Set(["P0", "P1", "P2"]);
const BOARD_TYPES = new Set([
  "code", "test", "docs", "ui", "ui-func", "fault", "refactor", "perf",
  "data", "contract", "deploy", "research", "orchestration", "matrix", "composition",
]);
const DOC_KINDS = new Set(["design", "page", "workflow"]);
const ACCEPT_TYPES = new Set(["command", "browser", "manual", "negative"]);

/** zod 侧上限的镜像。 */
const LIMIT = {
  id: 60, label: 160, summary: 500, before: 500, group: 80,
  target: 400, targets: 30, acceptCmd: 500, acceptExpect: 300, accept: 12, acceptNote: 300,
  symName: 200, symFile: 400, edgeLabel: 120,
  nodes: 60, edges: 120, title: 200,
  flow: 40, flowText: 500, flowCond: 500,
};

const NODE_RE = /^node\s+(\S+)\s+(\S+)\s+(\S+)(.*)$/;
const LANE_RE = /^lane\s+(.+?)\s+:\s*([^\s:]+(?:\s+[^\s:]+)*)?\s*$/;
const EDGE_RE = /^edge\s+(\S+)\s+(=>>|->>|~>|=>|->)\s+(\S+)(?:\s*:\s*(.*))?$/;
const META_RE = /^(title|type|scale|kind)\s*:\s*(.*)$/;

function unescapeText(s: string): string {
  return s.replace(/\\\|/g, "|").replace(/\\"/g, '"');
}

/** 按未转义的 ` | ` 切分(label 之后的 summary/before)。 */
function splitUnescaped(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") { cur += "\\|"; i++; continue; }
    if (ch === " " && s[i + 1] === "|" && s[i + 2] === " ") { out.push(cur); cur = ""; i += 2; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => unescapeText(x.trim()));
}

type FlowDiag = (line: number, severity: BoardDslDiag["severity"], code: string, message: string) => void;
type FlowClip = (value: string, max: number, line: number, code: string, field: string) => string;

/** 解析一条 `flow:` 附属行 → 扁平 flow step;不可表达/字段缺失 → E_FLOW_SYNTAX 返 undefined(整板不落)。
 * ```
 * flow: step <text>
 * flow: branch <cond> ? <thenText> : <elseText>   (elseText 可省)
 * flow: loop over <expr> | body <t1>; <t2>
 * ``` */
function parseFlowLine(spec: string, lineNo: number, diag: FlowDiag, clip: FlowClip): BoardDslFlowStep | undefined {
  const bad = (why: string): undefined => {
    diag(lineNo, "error", "E_FLOW_SYNTAX", `flow 行不可表达:${why}(当前只支持 step / branch <cond> ? <then>[: <else>] / loop over <expr> | body <a>; <b>)`);
    return undefined;
  };
  const stepOf = (raw: string, field: string, max: number): BoardDslFlowStep | undefined => {
    const text = unescapeText(raw.trim());
    if (text === "") {
      diag(lineNo, "error", "E_FLOW_SYNTAX", `flow 行 ${field} 为空`);
      return undefined;
    }
    return { type: "step", text: clip(text, max, lineNo, "W_TRUNCATE_FLOW_TEXT", `flow.${field}`) };
  };

  if (spec === "") return bad("缺少内容");
  const kindOf = /^(\S+)\s*(.*)$/.exec(spec)!;
  const head = (kindOf[1] ?? "").toLowerCase();
  const rest = (kindOf[2] ?? "").trim();

  if (head === "step" || head === "s") {
    const one = stepOf(rest, "step", LIMIT.flowText);
    return one ? one : bad("step 文本为空");
  }

  if (head === "branch" || head === "b") {
    const q = rest.indexOf(" ? ");
    if (q <= 0) return bad("branch 缺少 ` ? ` 或条件为空");
    const cond = clip(unescapeText(rest.slice(0, q).trim()), LIMIT.flowCond, lineNo, "W_TRUNCATE_FLOW_COND", "flow.cond");
    let thenRaw = rest.slice(q + 3).trim();
    let elseRaw = "";
    const colon = thenRaw.indexOf(" : ");
    if (colon >= 0) {
      elseRaw = thenRaw.slice(colon + 3).trim();
      thenRaw = thenRaw.slice(0, colon).trim();
    }
    const thenStep = stepOf(thenRaw, "branch.then", LIMIT.flowText);
    if (!thenStep) return bad("branch 的 then 文本为空");
    const out: BoardDslFlowStep = { type: "branch", cond, then: [thenStep] };
    if (elseRaw !== "") {
      const elseStep = stepOf(elseRaw, "branch.else", LIMIT.flowText);
      if (!elseStep) return bad("branch 的 else 文本为空");
      out.else = [elseStep];
    }
    return out;
  }

  if (head === "loop" || head === "l") {
    if (!/^over\s+/i.test(rest)) return bad("loop 需要 `over <expr>`");
    const bodyAt = rest.search(/\s\|\s*body\s+/i);
    if (bodyAt < 0) return bad("loop 需要 `| body <文本>`");
    const over = clip(unescapeText(rest.slice(4, bodyAt).trim()), LIMIT.flowCond, lineNo, "W_TRUNCATE_FLOW_COND", "flow.over");
    if (over === "") return bad("loop 的 over 为空");
    const bodyText = rest.slice(rest.indexOf("body", bodyAt) + 4).trim();
    const pieces = bodyText.split(";").map((x) => x.trim()).filter((x) => x !== "");
    if (pieces.length === 0) return bad("loop 的 body 文本为空");
    const body: BoardDslFlowStep[] = [];
    for (const piece of pieces) {
      const one = stepOf(piece, "loop.body", LIMIT.flowText);
      if (!one) return bad("loop 的 body 段为空");
      body.push(one);
    }
    return { type: "loop", over, body };
  }

  return bad(`未知 flow 类型 ${kindOf[1]}`);
}

/** dsl nodes 与 nodes JSON 同给时的合并(纯函数,不改入参):
 * - 以 dsl 节点为基底与顺序;同 id 的 JSON 节点**只补 dsl 未提供(undefined)的白名单字段**;
 * - 白名单(Q4=B):flow/evidence/comments/wf/fileRef/done/pos —— id/kind/label/summary/group/before/
 *   change/phase/targets/accept/symbolRef 一律以 dsl 为准(JSON 值忽略);
 * - JSON 独有 id 不并入(防两版并板),返回长度恒等于 dslNodes.length。 */
const MERGE_FILL_KEYS = ["flow", "evidence", "comments", "wf", "fileRef", "done", "pos"] as const;

export function mergeDslWithNodes(
  dslNodes: BoardDslNode[],
  jsonNodes: unknown,
): { nodes: Record<string, unknown>[]; filled: number } {
  const list = Array.isArray(jsonNodes) ? jsonNodes : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const raw of list) {
    if (raw === null || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : "";
    if (id === "" || byId.has(id)) continue;
    byId.set(id, rec);
  }
  let filled = 0;
  const nodes = dslNodes.map((dslNode) => {
    const out: Record<string, unknown> = { ...dslNode };
    const json = byId.get(dslNode.id);
    if (!json) return out;
    let touched = false;
    for (const key of MERGE_FILL_KEYS) {
      if (out[key] !== undefined) continue;
      const value = json[key];
      if (value === undefined) continue;
      out[key] = value;
      touched = true;
    }
    if (touched) filled += 1;
    return out;
  });
  return { nodes, filled };
}

export function parseBoardDsl(text: string): BoardDslResult {
  const diags: BoardDslDiag[] = [];
  const nodes: BoardDslNode[] = [];
  const pending: { line: number; from: string; to: string; kind: BoardDslEdge["kind"]; label?: string }[] = [];
  const meta: BoardDslResult["meta"] = {};
  /** id → 声明行(重复 id 检测用)。 */
  const declared = new Map<string, number>();
  /** id → 泳道名(同一节点多个 lane 重复引用:留第一次)。 */
  const laneOf = new Map<string, string>();
 /** accept 项 → 声明行(锚点错误诊断用行号)。 */
  const anchorLines = new WeakMap<object, number>();
  let current: BoardDslNode | null = null;
 /** serializeBoardDsl `%% json-extra` 段的载荷(单行 JSON,遇 `{` 开头行吞入)。 */
  let extra: unknown;

  const diag = (line: number, severity: BoardDslDiag["severity"], code: string, message: string): void => {
    diags.push({ line, severity, code, message });
  };

  /** 超限 warn + 截断。 */
  const clip = (value: string, max: number, line: number, code: string, field: string): string => {
    if (value.length <= max) return value;
    diag(line, "warn", code, `${field} 超长(${value.length} > ${max}),已截断`);
    return value.slice(0, max);
  };

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i] ?? "";
    const body = raw.trim();

    if (body === "" || body.startsWith("#")) continue;

 // 版本行:%% board v1(其它 %% 注释行也吞掉;紧随 json-extra 标记后的 JSON 载荷行一并收进 extra)
    if (body.startsWith("%%")) {
      if (/^%%\s*board\b/i.test(body) && !/^%%\s*board\s+v1\b/i.test(body)) {
        diag(lineNo, "warn", "W_VERSION", `未知 DSL 版本行,按 v1 解析:${body}`);
      }
      continue;
    }

 // json-extra 载荷行(serializeBoardDsl 输出的单行 JSON;主干永远可直接回读)
    if (body.startsWith("{")) {
      try {
        extra = JSON.parse(body);
      } catch {
        diag(lineNo, "warn", "W_EXTRA_JSON", "json-extra 载荷不是合法 JSON,忽略");
      }
      continue;
    }

    // 缩进 = 上一个 node 的附属行
    if (/^[ \t]/.test(raw)) {
      if (!current) {
        diag(lineNo, "error", "E_NO_NODE", `附属行没有所属 node 行:${body}`);
        continue;
      }
      if (body.startsWith("accept:")) {
        let rule = body.slice("accept:".length).trim();
        // type 前缀(可省):accept: [command] <cmd> => <expect>
        let acceptType: string | undefined;
        const typeM = /^\[([A-Za-z0-9_-]+)\]\s*/.exec(rule);
        if (typeM) {
          const t = (typeM[1] ?? "").toLowerCase();
          if (ACCEPT_TYPES.has(t)) acceptType = t;
          else diag(lineNo, "warn", "W_ACCEPT_TYPE_UNKNOWN", `未知 accept type:${typeM[1]}(省略;可选 command/browser/manual/negative)`);
          rule = rule.slice(typeM[0].length);
        }
        // note:最后一个未转义 ` | ` 之后是说明(与 node 行同套 `\|` 转义约定)
        let noteRaw: string | undefined;
        const noteParts = splitUnescaped(rule);
        if (noteParts.length > 1) {
          noteRaw = noteParts[noteParts.length - 1] ?? "";
          rule = noteParts.slice(0, -1).join(" | ");
        }
        // cmd 内可能自带箭头:按**最后**一个 ` => ` 切分
        const at = rule.lastIndexOf(" => ");
        const cmdRaw = (at >= 0 ? rule.slice(0, at) : rule).trim();
        const expectRaw = at >= 0 ? rule.slice(at + 4).trim() : "";
        if (cmdRaw === "") {
          diag(lineNo, "error", "E_ACCEPT_EMPTY", "accept 缺少 cmd");
          continue;
        }
        const list = current.accept ?? (current.accept = []);
        if (list.length >= LIMIT.accept) {
          diag(lineNo, "warn", "W_ACCEPT_CAP", `accept 超过 ${LIMIT.accept} 条,已丢弃多余项`);
          continue;
        }
        const cmd = clip(unescapeText(cmdRaw), LIMIT.acceptCmd, lineNo, "W_TRUNCATE_ACCEPT_CMD", "accept.cmd");
        const expect = clip(unescapeText(expectRaw || "通过"), LIMIT.acceptExpect, lineNo, "W_TRUNCATE_ACCEPT_EXPECT", "accept.expect");
        // 省略 type 就不写该字段(旧板逐字节等价,不默认填 command)
        const item: BoardAccept = { cmd, expect };
        if (acceptType !== undefined) item.type = acceptType as BoardAccept["type"];
        if (noteRaw !== undefined && noteRaw.trim() !== "") {
          item.note = clip(unescapeText(noteRaw.trim()), LIMIT.acceptNote, lineNo, "W_TRUNCATE_ACCEPT_NOTE", "accept.note");
        }
        anchorLines.set(item, lineNo);
        list.push(item);
        continue;
      }
      if (body.startsWith("targets:")) {
        const rest = body.slice("targets:".length).trim();
        const list = current.targets ?? (current.targets = []);
        for (const piece of rest.split(",")) {
          const raw2 = piece.trim();
          if (raw2 === "") continue;
          if (list.length >= LIMIT.targets) {
            diag(lineNo, "warn", "W_TARGETS_CAP", `targets 超过 ${LIMIT.targets} 项,已丢弃多余项`);
            break;
          }
          list.push(clip(unescapeText(raw2), LIMIT.target, lineNo, "W_TRUNCATE_TARGET", "targets 项"));
        }
        continue;
      }
      if (body.startsWith("sym:")) {
        const spec = body.slice("sym:".length).trim();
        if (spec === "") {
          diag(lineNo, "error", "E_SYM_SYNTAX", "sym 行缺少内容(<name>@<file>:<line>)");
          continue;
        }
        let name = spec;
        let file: string | undefined;
        let line: number | undefined;
        const at = spec.indexOf("@");
        if (at >= 0) {
          name = spec.slice(0, at);
          let tail = spec.slice(at + 1);
          const colon = tail.lastIndexOf(":");
          if (colon > 0 && /^\d+$/.test(tail.slice(colon + 1))) {
            line = Number(tail.slice(colon + 1));
            tail = tail.slice(0, colon);
          }
          if (tail !== "") file = tail;
        }
        if (name.trim() === "") {
          diag(lineNo, "error", "E_SYM_SYNTAX", `sym 缺少符号名:${spec}`);
          continue;
        }
        const ref: NonNullable<BoardDslNode["symbolRef"]> = {
          name: clip(name.trim(), LIMIT.symName, lineNo, "W_TRUNCATE_SYM_NAME", "symbolRef.name"),
        };
        if (file) ref.file = clip(unescapeText(file), LIMIT.symFile, lineNo, "W_TRUNCATE_SYM_FILE", "symbolRef.file");
        if (line !== undefined) ref.line = line;
        current.symbolRef = ref;
        continue;
      }
      if (body.startsWith("flow:")) {
        const spec = body.slice("flow:".length).trim();
        const steps = current.flow ?? (current.flow = []);
        if (steps.length >= LIMIT.flow) {
          diag(lineNo, "warn", "W_FLOW_CAP", `flow 超过 ${LIMIT.flow} 条,已丢弃多余项`);
          continue;
        }
        const step = parseFlowLine(spec, lineNo, diag, clip);
        if (step) steps.push(step);
        continue;
      }
      diag(lineNo, "error", "E_UNKNOWN_LINE", `未知附属行:${body}`);
      continue;
    }

    // ---- 顶层行 ----
    const metaM = META_RE.exec(body);
    if (metaM) {
      const key = metaM[1] as "title" | "type" | "scale" | "kind";
      const value = metaM[2] ?? "";
      if (key === "title") {
        meta.title = clip(value, LIMIT.title, lineNo, "W_TRUNCATE_TITLE", "title");
      } else if (key === "type") {
        meta.boardType = value;
        if (!BOARD_TYPES.has(value)) diag(lineNo, "warn", "W_META_ENUM", `未知板型 type:${value}`);
      } else if (key === "scale") {
        meta.scale = value;
        if (!["S", "M", "L"].includes(value)) diag(lineNo, "warn", "W_META_ENUM", `未知规模 scale:${value}`);
      } else {
        meta.docKind = value;
        if (!DOC_KINDS.has(value)) diag(lineNo, "warn", "W_META_ENUM", `未知文档体裁 kind:${value}`);
      }
      continue;
    }

    if (body.startsWith("lane ")) {
      const m = LANE_RE.exec(body);
      if (!m) {
        diag(lineNo, "error", "E_LANE_SYNTAX", `lane 行语法错误:${body}`);
        continue;
      }
      const laneName = clip((m[1] ?? "").trim(), LIMIT.group, lineNo, "W_TRUNCATE_GROUP", "lane 名");
      const ids = (m[2] ?? "").split(/\s+/).filter((x) => x !== "");
      for (const id of ids) {
        const prev = laneOf.get(id);
        if (prev !== undefined) {
          diag(lineNo, "warn", "W_DUP_LANE_NODE", `节点 ${id} 已在泳道「${prev}」声明,重复引用以第一次为准`);
          continue;
        }
        laneOf.set(id, laneName);
      }
      continue;
    }

    if (body.startsWith("node ")) {
      const m = NODE_RE.exec(body);
      if (!m) {
        diag(lineNo, "error", "E_NODE_SYNTAX", `node 行语法残缺(需 id/kind/change/"label"):${body}`);
        current = null;
        continue;
      }
      const id = clip(m[1] ?? "", LIMIT.id, lineNo, "W_TRUNCATE_ID", "node.id");
      const kind = m[2] ?? "";
      const change = m[3] ?? "";
      let rest = m[4] ?? "";

      // 可选 phase:label 前若还有裸 token(P0/P1/P2)
      let phase: string | undefined;
      const phaseM = /^\s+([A-Za-z0-9]+)(?=\s)/.exec(rest);
      if (phaseM) {
        phase = phaseM[1];
        rest = rest.slice(phaseM[0].length);
      }

      const labelM = /^\s+"((?:[^"\\]|\\.)*)"\s*(.*)$/.exec(rest);
      if (!labelM) {
        diag(lineNo, "error", "E_NODE_SYNTAX", `node ${id} 缺少带双引号的 label,该节点丢弃`);
        current = null;
        continue;
      }
      const label = clip(unescapeText(labelM[1] ?? ""), LIMIT.label, lineNo, "W_TRUNCATE_LABEL", "label");
      if (label === "") {
        diag(lineNo, "error", "E_NODE_SYNTAX", `node ${id} 的 label 为空,该节点丢弃`);
        current = null;
        continue;
      }
      if (declared.has(id)) {
        diag(lineNo, "error", "E_DUP_ID", `节点 id 重复:${id}(首次声明在第 ${declared.get(id)} 行),该节点丢弃`);
        current = null;
        continue;
      }

      const tail = (labelM[2] ?? "").trim();
      const parts = tail === "" ? [] : splitUnescaped(tail.replace(/^\|\s*/, ""));
      const summaryRaw = parts.length > 0 ? (parts[0] ?? "") : "";
      const beforeRaw = parts.length > 1 ? (parts[1] ?? "") : "";

      const node: BoardDslNode = {
        id,
        label,
        summary: summaryRaw === ""
          ? label
          : clip(summaryRaw, LIMIT.summary, lineNo, "W_TRUNCATE_SUMMARY", "summary"),
      };
      if (KINDS.has(kind)) node.kind = kind;
      else diag(lineNo, "warn", "W_KIND_UNKNOWN", `未知节点 kind:${kind}(省略,zod 回退 function)`);
      if (CHANGES.has(change)) node.change = change;
      else diag(lineNo, "warn", "W_CHANGE_UNKNOWN", `未知 change:${change}(省略,zod 回退 modify)`);
      if (phase !== undefined) {
        if (PHASES.has(phase)) node.phase = phase;
        else diag(lineNo, "warn", "W_PHASE_UNKNOWN", `未知 phase:${phase}(省略)`);
      }
      if (beforeRaw !== "") node.before = clip(beforeRaw, LIMIT.before, lineNo, "W_TRUNCATE_BEFORE", "before");

      if (nodes.length >= LIMIT.nodes) {
        diag(lineNo, "error", "E_NODES_CAP", `节点数超过 ${LIMIT.nodes},该节点丢弃`);
        current = null;
        continue;
      }
      declared.set(id, lineNo);
      nodes.push(node);
      current = node;
      continue;
    }

    if (body.startsWith("edge ")) {
      const m = EDGE_RE.exec(body);
      if (!m) {
        diag(lineNo, "error", "E_EDGE_SYNTAX", `edge 行语法错误:${body}`);
        continue;
      }
      const arrow = m[2] ?? "->";
      const label = (m[4] ?? "").trim();
      pending.push({
        line: lineNo,
        from: m[1] ?? "",
        to: m[3] ?? "",
        kind: BOARD_DSL_ARROWS[arrow] ?? "call",
        ...(label === "" ? {} : { label: clip(label, LIMIT.edgeLabel, lineNo, "W_TRUNCATE_EDGE_LABEL", "edge.label") }),
      });
      continue;
    }

    diag(lineNo, "error", "E_UNKNOWN_LINE", `未知行:${body}`);
  }

  // lane → group(以第一次声明为准,已在 lane 阶段去重)
  for (const node of nodes) {
    const group = laneOf.get(node.id);
    if (group !== undefined) node.group = group;
  }

 // 边:悬空丢弃 + 上限
  const edges: BoardDslEdge[] = [];
  for (const e of pending) {
    if (!declared.has(e.from) || !declared.has(e.to)) {
      const missing = [!declared.has(e.from) ? e.from : "", !declared.has(e.to) ? e.to : ""].filter((x) => x !== "");
      diag(e.line, "warn", "W_DANGLING_EDGE", `边的端点未声明:${missing.join(", ")},该边丢弃`);
      continue;
    }
    if (edges.length >= LIMIT.edges) {
      diag(e.line, "warn", "W_EDGES_CAP", `边数超过 ${LIMIT.edges},已丢弃多余边`);
      continue;
    }
    edges.push({ from: e.from, to: e.to, kind: e.kind, ...(e.label === undefined ? {} : { label: e.label }) });
  }

  if (nodes.length === 0) {
    diag(lines.length, "error", "E_NO_NODES", "解析结果没有任何有效节点");
  }

 // ---- accept 锚点展开(后置遍历,引用可前向声明)----
 // 语法:accept: @p01 → 复用 p01 首条 accept 的 cmd 整条
 // accept: @p01.cmd~"P0-4" → 以 p01.cmd 为基串,把引号内文本替换为 "P0-4"
 // 悬空(节点不存在/无 accept)= error,不静默空 cmd;链式引用 = error;深度≤1。
  const anchorById = new Map<string, BoardDslNode>();
  for (const n of nodes) anchorById.set(n.id, n);
  for (const n of nodes) {
    const list = n.accept;
    if (!list) continue;
    let dropped = false;
    for (let ai = 0; ai < list.length; ai++) {
      const item = list[ai]!;
      const cmd = item.cmd;
      if (cmd === undefined || !cmd.startsWith("@")) continue;
      const m = /^@([A-Za-z0-9_.-]+?)(?:\.cmd~"((?:[^"\\]|\\.)*)")?$/.exec(cmd);
      if (!m) {
        diag(anchorLines.get(item) ?? lines.length, "error", "E_ANCHOR_SYNTAX", `accept 锚点语法错误:${cmd}(支持 @<id> 或 @<id>.cmd~"<新文本>")`);
        list.splice(ai, 1); ai--; dropped = true;
        continue;
      }
      const refId = m[1] ?? "";
      const repl = m[2] !== undefined ? unescapeText(m[2]) : undefined;
      const ref = anchorById.get(refId);
      const refAcc = ref?.accept?.[0];
      const base = refAcc?.cmd;
      if (refId === n.id) {
        diag(anchorLines.get(item) ?? lines.length, "error", "E_ANCHOR_SELF", `accept 锚点禁止自引用:${cmd}`);
        list.splice(ai, 1); ai--; dropped = true;
        continue;
      }
      if (ref === undefined || refAcc === undefined || base === undefined) {
        diag(anchorLines.get(item) ?? lines.length, "error", "E_ANCHOR_MISSING", `accept 锚点悬空:${cmd}(节点 ${refId} 不存在或没有 accept)`);
        list.splice(ai, 1); ai--; dropped = true;
        continue;
      }
      if (base.startsWith("@")) {
        diag(anchorLines.get(item) ?? lines.length, "error", "E_ANCHOR_CHAIN", `accept 锚点禁止链式引用:${cmd} 的目标 cmd 仍是锚点(深度≤1)`);
        list.splice(ai, 1); ai--; dropped = true;
        continue;
      }
      if (repl === undefined) {
        item.cmd = base;
      } else {
 // 前缀复用 + 替换差异后缀:以 base 为基串,把第一个引号段的引号内文本换成 repl。
 // 例:base=`pnpm -t "P0-1" test`,repl="P0-4" → `pnpm -t "P0-4" test`。
        const q1 = base.indexOf('"');
        if (q1 < 0) {
          diag(anchorLines.get(item) ?? lines.length, "error", "E_ANCHOR_NO_QUOTE", `accept 锚点替换失败:目标 cmd 无引号段可替换(${refId}.cmd=${base})`);
          list.splice(ai, 1); ai--; dropped = true;
          continue;
        }
        const q2 = base.indexOf('"', q1 + 1);
        item.cmd = q2 > q1 ? base.slice(0, q1 + 1) + repl + base.slice(q2) : `${base} "${repl}"`;
      }
      if (item.expect === "通过" && refAcc.expect !== undefined) item.expect = refAcc.expect;
    }
    if (list.length === 0 && dropped) delete n.accept;
  }

  return { ok: nodes.length > 0, diags, meta, nodes, edges, ...(extra !== undefined ? { extra } : {}) };
}

// ---------------------------------------------------------------------------
// G5③ 读侧序列化器:BoardDoc → DSL 文本(与写侧同文法)。
// 双段输出防丢字段:DSL 主干 + `%% json-extra` 段(主干 serialize 不出的字段
// comments/humanEdits/pos/done/evidence 等白名单原样 JSON;parseBoardDsl 吞掉 %% 行,
// 主干永远可直接 parseBoardDsl 回读,extra 由读侧调用方 JSON.parse 后 merge)。
// ---------------------------------------------------------------------------

/** json-extra 白名单:节点级(按 id 收集)与板级两层;主干已表达的字段不重复存。 */
const EXTRA_NODE_KEYS = ["comments", "pos", "done", "evidence", "fileRef", "wf", "visual"] as const;
const EXTRA_DOC_KEYS = ["status", "rev", "docGenre", "planned_files", "actual_files", "humanEdits", "version", "updatedAt"] as const;

/** D1:全角字符(等)是正文,逐字保留不转义;只转义会破坏行式语法的 `\ | "`。 */
function escDsl(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/"/g, '\\"');
}

export function serializeBoardDsl(doc: {
  title?: string;
  boardType?: string;
  scale?: string;
  docKind?: string;
  nodes?: unknown[];
  edges?: { from: string; to: string; kind?: string; label?: string; virtual?: boolean }[];
  [k: string]: unknown;
}): string {
  const out: string[] = ["%% board v1"];
  if (doc.title !== undefined) out.push(`title: ${doc.title}`);
  if (doc.boardType !== undefined) out.push(`type: ${doc.boardType}`);
  if (doc.scale !== undefined) out.push(`scale: ${doc.scale}`);
  if (doc.docKind !== undefined) out.push(`kind: ${doc.docKind}`);

  const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  const extraNodes: Record<string, Record<string, unknown>> = {};
  const laneOrder: string[] = [];
  const laneMembers = new Map<string, string[]>();
  for (const raw of nodes) {
    if (typeof raw !== "object" || raw === null) continue;
    const n = raw as Record<string, unknown>;
    const id = typeof n.id === "string" ? n.id : "";
    const g = typeof n.group === "string" && n.group !== "" ? n.group : "";
    if (id === "" || g === "") continue;
    if (!laneMembers.has(g)) { laneMembers.set(g, []); laneOrder.push(g); }
    laneMembers.get(g)!.push(id);
  }
  for (const g of laneOrder) out.push(`lane ${g} : ${(laneMembers.get(g) ?? []).join(" ")}`);

  const ARROW_OF: Record<string, string> = { call: "->", data: "->>", verify: "~>", nav: "=>", contains: "=>>" };
  for (const raw of nodes) {
    if (typeof raw !== "object" || raw === null) continue;
    const n = raw as Record<string, unknown>;
    const id = String(n.id ?? "");
    if (id === "") continue;
    const head = [
      "node", id,
      typeof n.kind === "string" ? n.kind : "function",
      typeof n.change === "string" ? n.change : "modify",
      ...(typeof n.phase === "string" ? [n.phase] : []),
      `"${escDsl(typeof n.label === "string" ? n.label : id)}"`,
    ].join(" ");
    const summary = typeof n.summary === "string" && n.summary !== "" ? n.summary : String(n.label ?? id);
    const before = typeof n.before === "string" && n.before !== "" ? ` | ${escDsl(n.before)}` : "";
    out.push(`${head} | ${escDsl(summary)}${before}`);

    const nodeExtra: Record<string, unknown> = {};
    for (const key of EXTRA_NODE_KEYS) {
      const v = n[key];
      if (v === undefined) continue;
      if (key === "comments" && Array.isArray(v) && v.length === 0) continue;
      if (key === "done" && v === false) continue;
      nodeExtra[key] = v;
    }

    if (Array.isArray(n.accept)) {
      for (const a of n.accept) {
        if (typeof a !== "object" || a === null) continue;
        const acc = a as Record<string, unknown>;
        const cmd = typeof acc.cmd === "string" ? acc.cmd : "";
        if (cmd === "") continue;
        const typeP = typeof acc.type === "string" ? `[${acc.type}] ` : "";
        const note = typeof acc.note === "string" && acc.note !== "" ? ` | ${escDsl(acc.note)}` : "";
        const expect = typeof acc.expect === "string" ? acc.expect : "通过";
        out.push(`  accept: ${typeP}${escDsl(cmd)} => ${escDsl(expect)}${note}`);
      }
    }
    if (Array.isArray(n.targets) && n.targets.length > 0) {
      out.push(`  targets: ${n.targets.filter((t): t is string => typeof t === "string").map(escDsl).join(", ")}`);
    }
    const sr = n.symbolRef;
    if (typeof sr === "object" && sr !== null) {
      const r = sr as Record<string, unknown>;
      const name = typeof r.name === "string" ? r.name : "";
      if (name !== "") {
        const file = typeof r.file === "string" ? `@${r.file}` : "";
        const line = typeof r.line === "number" ? `:${r.line}` : "";
        out.push(`  sym: ${name}${file}${line}`);
      }
    }
    if (Array.isArray(n.flow) && n.flow.length > 0) {
      const emitFlow = (steps: unknown[]): void => {
        for (const raw2 of steps) {
          if (typeof raw2 !== "object" || raw2 === null) continue;
          const f = raw2 as Record<string, unknown>;
          const then0 = Array.isArray(f.then) ? String((f.then[0] as Record<string, unknown> | undefined)?.text ?? "") : "";
          if (f.type === "step") out.push(`  flow: step ${escDsl(String(f.text ?? ""))}`);
          else if (f.type === "branch") {
            const els = Array.isArray(f.else) && f.else.length > 0
              ? ` : ${escDsl(String((f.else[0] as Record<string, unknown> | undefined)?.text ?? ""))}` : "";
            out.push(`  flow: branch ${escDsl(String(f.cond ?? ""))} ? ${escDsl(then0)}${els}`);
          } else if (f.type === "loop") {
            const body = Array.isArray(f.body)
              ? f.body.map((b) => String((b as Record<string, unknown>)?.text ?? "")).filter((s) => s !== "").join("; ")
              : "";
            out.push(`  flow: loop over ${escDsl(String(f.over ?? ""))} | body ${escDsl(body)}`);
          }
        }
      };
      emitFlow(n.flow);
      if (!serializeFlowFlatCheck(n.flow)) nodeExtra.flow = n.flow; // 多步嵌套 DSL 表达不了 → extra 兜底
    }
    if (Object.keys(nodeExtra).length > 0) extraNodes[id] = nodeExtra;
  }

  const edges = Array.isArray(doc.edges) ? doc.edges : [];
  for (const e of edges) {
    if (!e || typeof e !== "object") continue;
    if (e.virtual === true) continue; // 主文法无 virtual,走 json-extra,不重复出主干
    const arrow = ARROW_OF[e.kind ?? "call"] ?? "->";
    const label = typeof e.label === "string" && e.label !== "" ? ` : ${e.label}` : "";
    out.push(`edge ${e.from} ${arrow} ${e.to}${label}`);
  }

 // ---- %% json-extra 段 ----
  const extraDoc: Record<string, unknown> = {};
  for (const key of EXTRA_DOC_KEYS) {
    const v = doc[key];
    if (v === undefined) continue;
    if (key === "planned_files" && Array.isArray(v) && v.length === 0) continue;
    if (key === "updatedAt" && v === 0) continue;
    extraDoc[key] = v;
  }
  const virtualEdges = edges
    .filter((e) => e && typeof e === "object" && e.virtual === true)
    .map((e) => ({ from: e.from, to: e.to, kind: e.kind ?? "call", ...(e.label !== undefined ? { label: e.label } : {}) }));
  if (virtualEdges.length > 0) extraDoc.virtualEdges = virtualEdges;
  if (Object.keys(extraNodes).length > 0) extraDoc.nodes = extraNodes;

  if (Object.keys(extraDoc).length > 0) {
    out.push("%% json-extra(serializeBoardDsl 兜底字段:parseBoardDsl 忽略本段;读侧 JSON.parse 后 merge)");
    out.push(JSON.stringify(extraDoc));
  }
  return out.join("\n") + "\n";
}

/** flow 能否被扁平 DSL 无损表达(branch 的 then/else、loop 的 body 都至多单步)。 */
function serializeFlowFlatCheck(flow: unknown[]): boolean {
  const flat = (steps: unknown): boolean => !Array.isArray(steps) || steps.length <= 1;
  return flow.every((f) => {
    if (typeof f !== "object" || f === null) return true;
    const r = f as Record<string, unknown>;
    if (r.type === "branch") return flat(r.then) && flat(r.else);
    if (r.type === "loop") return flat(r.body);
    return true;
  });
}