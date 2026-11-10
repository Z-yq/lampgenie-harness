/**
 * sensing/statemachines(step-077 P2 / designs/24 §2.2):状态机感知泛化。
 *
 * 形态清单(全部确定性行扫描,触发点带 {file,line} 证据):
 *   F1 transitions-table:TRANSITIONS 字面量表(key: new Set([...]))——sequence/index.ts 金标准形态的泛化;
 *   F2 switch/if-else 转移:状态变量声明(联合类型/enum/字面量赋值)+ 转移赋值双条件收敛
 *      (赋值目标=状态变量 ∧ 值 ∈ 声明状态集)——缺一进 candidates 不进正式 transitions;
 *   F3 state-pattern 类族:多类 extends 同一 State 基类 + context.setState(new X()) 转移;
 *   F4 XState createMachine 配置对象(braces 配对提取 states/on 映射);
 *   F5 Redux createSlice(弱化产物:slice 名+状态字段+reducer 动作清单,标 redux-slice 防误读为状态机)。
 *
 * 砍量(designs/24 §2.2 论证):DB status 字段流转不做(跨文件 ORM 数据流,假阳/假阴双高)——
 * 退化为 statusHints 词法提示区(tier=lexical,标注「可能含误判,仅供人工排查入口」)。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createBraceTracker } from "../adapters/braces";

export interface StateTransition {
  from: string;
  to: string;
  /** 触发事件(XState/Redux 动作名;switch=case 标签)。 */
  trigger?: string;
  evidence: { file: string; line: number };
}

export interface StateMachine {
  name: string;
  form: "transitions-table" | "switch" | "state-pattern" | "xstate" | "redux-slice";
  file: string;
  states: string[];
  transitions: StateTransition[];
  /** 低置信候选(单条件满足,不进正式图)。 */
  candidates: { text: string; evidence: { file: string; line: number } }[];
  /** redux-slice 专用:状态字段与动作清单(不产出状态机图)。 */
  redux?: { stateFields: string[]; actions: string[] };
  mermaid: string;
}

export interface StateMachineSurface {
  machines: StateMachine[];
  /** DB status 词法提示区(砍量降级产物,lexical 级)。 */
  statusHints: { file: string; line: number; text: string }[];
  scannedFiles: number;
}

// ---------- F1:TRANSITIONS 字面量表 ----------
function extractTransitionsTable(file: string, lines: string[]): StateMachine[] {
  const text = lines.join("\n");
  const re = /(\w+)\s*:\s*new Set\(\s*\[([^\]]*)\]/g;
  const transitions: StateTransition[] = [];
  const states = new Set<string>();
  let m: RegExpExecArray | null;
  let firstIdx = -1;
  while ((m = re.exec(text))) {
    if (firstIdx < 0) firstIdx = m.index;
    const from = m[1]!;
    const line = text.slice(0, m.index).split("\n").length;
    states.add(from);
    for (const t of m[2]!.match(/["']([^"']+)["']/g) ?? []) {
      const to = t.replace(/["']/g, "");
      states.add(to);
      transitions.push({ from, to, evidence: { file, line } });
    }
  }
  if (transitions.length === 0) return [];
  // 名称守卫(实锤误报:vendor 里 `stepEvents: new Set([...])` 这类普通集合映射被当状态机):
  // 声明名含 TRANSITION/STATE/MACHINE 或类型注记 Record<*State*, Set<*State*>> 才算状态转移表,
  // 否则整体降级为 candidates(不产机,不误报)。
  const lookback = text.slice(Math.max(0, firstIdx - 400), firstIdx);
  const named = /(\w*(?:TRANSITION|STATE|MACHINE)\w*)\s*(?::[^=]*)?=\s*\{/i.test(lookback)
    || /Record<\s*\w*(?:State|Status|Phase|Stage|Mode)\w*\s*,\s*(?:Readonly)?Set</i.test(lookback);
  if (!named) return []; // 非状态机语义的 Set 映射:静默跳过(不出候选噪音,反例有测试锚定)
  return [{
    name: `transitions-table@${file}`, form: "transitions-table", file,
    states: [...states], transitions, candidates: [],
    mermaid: toMermaid([...states], transitions),
  }];
}

// ---------- F2:switch/if-else 转移(双条件收敛) ----------
const STATE_VAR_RE = /\b(state|status|phase|stage|mode)\b/i;

/** 注释行守卫(与 http-api 同款:注释里的示例形态不当真)。 */
function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("#") || t.startsWith("*") || t.startsWith("/*");
}


function extractSwitchMachines(file: string, lines: string[]): StateMachine[] {
  // 注意:用原始行扫描(BraceTracker 的 code 会剥离字符串内容,字面量状态值被掏空——
  // F2 全程不需要括号深度,裸行即准)
  const raw = lines;
  // ① 状态字面量集:联合类型 / enum
  const stateSet = new Set<string>();
  const unionRe = /(?:type\s+\w*(?:State|Status|Phase|Stage|Mode)\w*\s*=\s*)([^;]+);/i;
  for (const line of raw) {
    const um = unionRe.exec(line);
    if (um) {
      for (const lit of um[1]!.match(/["'][^"']+["']/g) ?? []) stateSet.add(lit.replace(/["']/g, ""));
    }
    const em = /enum\s+\w*(?:State|Status|Phase|Stage|Mode)\w*\s*\{([^}]*)\}/i.exec(line);
    if (em) {
      for (const k of em[1]!.split(",")) {
        const name = k.trim().split("=")[0]!.trim();
        if (name) stateSet.add(name);
      }
    }
  }
  // ② 转移赋值:`(this.|self.)?(state|status|...) = "x"` / `setState("x")`
  const transitions: StateTransition[] = [];
  const candidates: StateMachine["candidates"] = [];
  const assignRe = /(?:this\.|self\.)?(state|status|phase|stage|mode)\s*=\s*["']([\w-]+)["']/i;
  const setRe = /set(?:State|Status|Phase|Stage|Mode)\(\s*["']([\w-]+)["']\s*\)/;
  // 上下文跟踪:最近的 case 标签 / if 条件字面量(转移的 from)
  let ctxFrom: string | undefined;
  let ctxTrigger: string | undefined;
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i]!;
    if (isCommentLine(line)) continue;
    const caseM = /case\s+["']?([\w-]+)["']?\s*:/.exec(line);
    if (caseM) { ctxFrom = caseM[1]!; ctxTrigger = caseM[1]!; }
    const ifM = /(?:if|elif|else\s+if)\s*\(.*?(?:state|status|phase|stage|mode)\s*===?\s*["']([\w-]+)["']/i.exec(line);
    if (ifM) { ctxFrom = ifM[1]!; ctxTrigger = ifM[1]!; }
    const am = assignRe.exec(line);
    const sm = setRe.exec(line);
    const to = am?.[2] ?? sm?.[1];
    if (to) {
      // 双条件收敛:①值 ∈ 声明状态集(或状态集未知但形态像状态机)②有 from 上下文(case/if)——
      // 无上下文=初始赋值/裸赋值(实锤:`private state: GateState = "idle"` 声明行被当转移)
      if (ctxFrom && (stateSet.size === 0 || stateSet.has(to))) {
        stateSet.add(to);
        stateSet.add(ctxFrom);
        transitions.push({ from: ctxFrom, to, ...(ctxTrigger ? { trigger: ctxTrigger } : {}), evidence: { file, line: i + 1 } });
        continue;
      }
      candidates.push({ text: `转移赋值 → "${to}"(${ctxFrom ? "状态集未声明该值" : "无 case/if 上下文(疑似初始赋值)"})`, evidence: { file, line: i + 1 } });
    }
  }
  if (transitions.length === 0) return [];
  const states = [...new Set(transitions.flatMap((t) => [t.from, t.to]).filter((s) => s && s !== "?"))];
  return [{
    name: `switch-machine@${file}`, form: "switch", file,
    states, transitions, candidates,
    mermaid: toMermaid(states, transitions),
  }];
}

// ---------- F3:状态模式类族 ----------
function extractStatePattern(file: string, lines: string[]): StateMachine[] {
  // class XxxState extends/implements YyyState|StateBase|IState
  const classRe = /class\s+(\w+)\s+(?:extends|implements)\s+(\w*(?:State|StateBase|IState))\b/;
  const classes: string[] = [];
  for (const line of lines) {
    const m = classRe.exec(line);
    if (m && m[1] !== m[2]) classes.push(m[1]!);
  }
  if (classes.length < 2) return [];
  // 转移:(this.context.|context.|ctx.)setState/transitionTo(new X())
  const transitions: StateTransition[] = [];
  let curClass = "";
  for (let i = 0; i < lines.length; i++) {
    if (isCommentLine(lines[i]!)) continue;
    const cm = classRe.exec(lines[i]!);
    if (cm) curClass = cm[1]!;
    const tm = /(?:setState|transitionTo|set_state)\(\s*new\s+(\w+)\s*\(/.exec(lines[i]!);
    if (tm && curClass && classes.includes(tm[1]!)) {
      transitions.push({ from: curClass, to: tm[1]!, evidence: { file, line: i + 1 } });
    }
  }
  if (transitions.length === 0) return [];
  return [{
    name: `state-pattern@${file}`, form: "state-pattern", file,
    states: classes, transitions, candidates: [],
    mermaid: toMermaid(classes, transitions),
  }];
}

// ---------- F4:XState createMachine ----------
function extractXState(file: string, lines: string[]): StateMachine[] {
  const out: StateMachine[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/createMachine\s*\(/.test(lines[i]!)) continue;
    // 括号配对提取整个配置对象;raw(值提取用原始行,事件名/目标都是字符串字面量)+code(结构深度)
    const tracker = createBraceTracker();
    const block: { raw: string; depth: number; no: number }[] = [];
    let started = false;
    for (let j = i; j < lines.length; j++) {
      const { depth } = tracker.feed(lines[j]!);
      if (/createMachine\s*\(\s*\{/.test(lines[j]!)) started = true;
      if (started) block.push({ raw: lines[j]!, depth, no: j + 1 });
      if (started && depth === 0) break;
    }
    const transitions: StateTransition[] = [];
    const states: string[] = [];
    let inStates = false; let statesDepth = 0;
    let curState = ""; let curStateLine = 0;
    let inOn = false; let onBase = 0;
    const evLineRe = /(\w+)\s*:\s*["']([\w-]+)["']/g;
    // target 对象形态:[^}{] 防跨越嵌套键(`on: { TOGGLE: "x", RESET: { target: "y" } }`
    // 的 [^}] 会从 on 一路吞到 RESET 的 target,trigger 被误记成 "on"——实锤于 toggle fixture)
    const evTargetRe = /(\w+)\s*:\s*\{[^}{]*?target\s*:\s*["']([\w-]+)["']/g;
    const scanEvents = (text: string, lineNo: number): void => {
      // target 对象形态先提(防 { target: "x" } 里的 target 被当事件名)
      const consumed: [number, number][] = [];
      for (const m of text.matchAll(evTargetRe)) {
        if (curState) transitions.push({ from: curState, to: m[2]!, trigger: m[1]!, evidence: { file, line: lineNo } });
        consumed.push([m.index!, m.index! + m[0].length]);
      }
      for (const m of text.matchAll(evLineRe)) {
        if (m[1] === "target") continue;
        if (consumed.some(([a, b]) => m.index! >= a && m.index! < b)) continue;
        if (curState) transitions.push({ from: curState, to: m[2]!, trigger: m[1]!, evidence: { file, line: lineNo } });
      }
    };
    for (const b of block) {
      if (!inStates) {
        if (/^\s*states\s*:/.test(b.raw)) { inStates = true; statesDepth = b.depth; }
        continue;
      }
      if (inStates && b.depth < statesDepth) { inStates = false; inOn = false; continue; }
      // on 块内消费(深度 ≥ onBase);状态键(相对深 1)切换 curState
      const keyM = /^\s*(\w+)\s*:\s*\{/.exec(b.raw);
      if (inOn && b.depth < onBase) inOn = false;
      if (inOn) scanEvents(b.raw, b.no);
      if (keyM && b.depth === statesDepth + 1 && !["on", "entry", "exit", "actions", "initial", "states", "meta", "tags", "after", "always", "invoke", "onDone"].includes(keyM[1]!)) {
        curState = keyM[1]!;
        curStateLine = b.no;
        states.push(curState);
        continue;
      }
      if (curState && /^\s*on\s*:/.test(b.raw)) {
        inOn = true; onBase = b.depth;
        // 事件可能与 on: 同行(on: { TOGGLE: "x" })
        scanEvents(b.raw.slice(b.raw.indexOf("on")), b.no);
      }
    }
    if (states.length > 0) {
      out.push({
        name: `xstate@${file}:${i + 1}`, form: "xstate", file,
        states: [...new Set([...states, ...transitions.map((t) => t.to)])],
        transitions, candidates: [],
        mermaid: toMermaid([...new Set(states)], transitions),
      });
    }
  }
  return out;
}

// ---------- F5:Redux createSlice(弱化产物) ----------
function extractReduxSlice(file: string, lines: string[]): StateMachine[] {
  const out: StateMachine[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/createSlice\s*\(/.test(lines[i]!)) continue;
    const tracker = createBraceTracker();
    // 2026-10-22 P0:记录「喂入前」的花括号深度——旧实现用行处理后深度判 reducers 键,
    // 单行签名 `setOptions: (state, action) => {` 处理后深度已多一层,16 个 reducer 只认出
    // 第 1 个(首键恰好写成 `addChatItem: (` 跨行、深度未变)。另带圆括号深度,排除参数行
    // (action: PayloadAction<...>)被误当动作名。
    const block: { raw: string; code: string; before: number; depth: number; no: number }[] = [];
    let started = false;
    for (let j = i; j < lines.length; j++) {
      const before = tracker.depth;
      const { depth, code } = tracker.feed(lines[j]!);
      if (/createSlice\s*\(\s*\{/.test(lines[j]!)) started = true;
      if (started) block.push({ raw: lines[j]!, code, before, depth, no: j + 1 });
      if (started && depth === 0) break;
    }
    let name = "";
    let initialDepth = 0, reducersDepth = 0;
    let initialParen = 0, reducersParen = 0;
    let paren = 0; // 跨行圆括号深度(剥字符串/注释后的 code 计数)
    const stateFields: string[] = [];
    const actions: string[] = [];
    for (const b of block) {
      const nm = /name\s*:\s*["']([\w-]+)["']/.exec(b.raw);
      if (nm && !name) name = nm[1]!;
      // createSlice( 未闭合时 paren 恒 ≥1:以「reducers 行当时的 paren」为基准,
      // 参数表所在层(reducersParen+1)自然被排除。声明行必须 continue——否则同行的
      // 「深度回落=块关」判定会把刚设好的深度立刻清掉(before 比块内层少 1)。
      if (/^\s*initialState\s*:/.test(b.raw) && !initialDepth) { initialDepth = b.before + 1; initialParen = paren; paren += parenDelta(b.code); continue; }
      // reducers 声明行=initialState 块已结束(否则下一个 action 键会被同时算进状态字段)
      if (/^\s*reducers\s*:/.test(b.raw) && !reducersDepth) { initialDepth = 0; reducersDepth = b.before + 1; reducersParen = paren; paren += parenDelta(b.code); continue; }
      // 块内键深度=块内一层的 before 深度;深度回落=块关
      if (initialDepth && b.before < initialDepth) initialDepth = 0;
      if (reducersDepth && b.before < reducersDepth) reducersDepth = 0;
      const keyM = /^\s*["']?(\w+)["']?\s*[:(]/.exec(b.raw);
      if (keyM) {
        if (initialDepth && b.before === initialDepth && paren === initialParen) stateFields.push(keyM[1]!);
        if (reducersDepth && b.before === reducersDepth && paren === reducersParen) actions.push(keyM[1]!);
      }
      paren += parenDelta(b.code);
    }
    if (name || stateFields.length > 0 || actions.length > 0) {
      out.push({
        name: `redux-slice:${name || file}`, form: "redux-slice", file,
        states: [], transitions: [], candidates: [],
        redux: { stateFields, actions },
        mermaid: "", // 弱化产物不出状态机图(如实:Redux 是动作驱动变更,非具名状态机)
      });
    }
  }
  return out;
}

/** 一行剥离后的圆括号净增量(参数表跨行时保持 >0,用于排除参数行冒充动作键)。 */
function parenDelta(code: string): number {
  let d = 0;
  for (const ch of code) {
    if (ch === "(") d++;
    else if (ch === ")") d--;
  }
  return d;
}

// ---------- 组合入口 ----------
export function extractStateMachinesFromFile(file: string, text: string): StateMachine[] {
  const lines = text.split("\n");
  return [
    ...extractTransitionsTable(file, lines),
    ...extractSwitchMachines(file, lines),
    ...extractStatePattern(file, lines),
    ...extractXState(file, lines),
    ...extractReduxSlice(file, lines),
  ];
}

/** 指纹(字面量;grep 预筛用)。 */
export const STATE_FINGERPRINT_LITERALS = [
  "new Set([",
  "createMachine(",
  "createSlice(",
  "setState(",
  "transitionTo(",
  "switch (state",
  "switch(state",
  "switch (this.state",
  ".status = ",
  ".state = ",
  "self.state =",
];

const STATUS_HINT_RE = /(?:\w+\.(?:status|state)\s*=\s*["'][\w-]+["']|update\([^)]*\bstatus\b)/;

export async function extractStateMachineSurface(root: string, files: string[]): Promise<StateMachineSurface> {
  const machines: StateMachine[] = [];
  const statusHints: StateMachineSurface["statusHints"] = [];
  let scanned = 0;
  for (const f of files) {
    let text = "";
    try { text = await readFile(join(root, f), "utf-8"); } catch { continue; }
    scanned++;
    machines.push(...extractStateMachinesFromFile(f, text));
    // DB status 提示区(词法级,标注可能误判)
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (isCommentLine(lines[i]!)) continue;
      if (STATUS_HINT_RE.test(lines[i]!)) {
        statusHints.push({ file: f, line: i + 1, text: lines[i]!.trim().slice(0, 100) });
      }
    }
  }
  return { machines, statusHints: statusHints.slice(0, 40), scannedFiles: scanned };
}

function toMermaid(states: string[], transitions: StateTransition[]): string {
  const lines = ["stateDiagram-v2"];
  for (const t of transitions) {
    const label = t.trigger ? ` : ${t.trigger}` : "";
    lines.push(`  ${sanitize(t.from)} --> ${sanitize(t.to)}${label}`);
  }
  return lines.join("\n");
}

function sanitize(s: string): string {
  return s.replace(/[^\w-]/g, "_");
}
