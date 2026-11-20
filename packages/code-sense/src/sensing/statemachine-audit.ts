/**
 * sensing/statemachine-audit(设计稿 06-code-sense §14.4):状态机缺陷审计——纯投影层。
 * 六签名(全部确定性,消费 statemachines.ts 已产的 states/transitions,不改提取器一行):
 * ① unreachable-state 不可达状态:声明了但(非初始态且)没有任何转移能进入;
 * ② no-exit 无出转移:进得去出不来且不是终态(终态=词典命中 or 无出度双判);
 * ③ ghost-transition 幽灵转移:转移表写了 states 集没有的状态(抄错名/重构漏改);
 * ④ missing-reverse 丢失双向:同 trigger A→B 有而 B→A 无(对称操作半实现);
 * ⑤ cross-machine-write 跨机冲突:同文件 ≥2 台机器的转移引用同一状态名(交叉维护);
 * ⑥ dead-terminal 死终态链:终态之后仍有出转移(声明与转移表矛盾)。
 * 边界纪律(设计 §14.7-5):①②⑥ 只对 form ∈ {transitions-table, switch, state-pattern}
 * 启用——XState/redux-slice 的转移是框架语义,结构判据不适用,硬套必产假阳性
 * (redux-slice 无 transitions 天然不触发;显式跳过 xstate)。
 */
import type { StateMachine } from "./statemachines";

export interface StateMachineDefect {
  kind: "unreachable-state" | "no-exit" | "ghost-transition" | "missing-reverse" | "cross-machine-write" | "dead-terminal";
  machine: string;
  file: string;
  line: number;
  detail: string;
}

/** 终态词典(词表法;与结构法「无出度」互补,双判降误报)。 */
const TERMINAL_WORDS = ["done", "complete", "finished", "complete".toUpperCase(), "error", "failed", "success", "closed", "cancelled", "canceled", "终", "完"];

function isTerminalState(name: string): boolean {
  const lower = name.toLowerCase();
  return TERMINAL_WORDS.some((w) => lower === w || lower.startsWith(w) || lower.endsWith(w));
}

/** ①②⑥ 启用形态:显式状态机(表/switch/状态模式);xstate/redux-slice 跳过。 */
const STRUCTURAL_FORMS = new Set(["transitions-table", "switch", "state-pattern"]);

function firstLineOf(m: StateMachine): number {
  return m.transitions[0]?.evidence.line ?? 0;
}

export function auditStateMachines(machines: StateMachine[]): StateMachineDefect[] {
  const out: StateMachineDefect[] = [];
  for (const m of machines) {
    if (m.form === "redux-slice") continue; // 无 transitions,无图可审
    const states = new Set(m.states);
    const toSet = new Set(m.transitions.map((t) => t.to));
    const fromSet = new Set(m.transitions.map((t) => t.from));
    const initial = m.states[0] ?? "";
    const structural = STRUCTURAL_FORMS.has(m.form);

 // ③ 幽灵转移:所有形态通用(转移写了声明集外的状态,任何形态都是真信号)
    for (const t of m.transitions) {
      const ghosts: string[] = [];
      if (!states.has(t.from)) ghosts.push(t.from);
      if (!states.has(t.to)) ghosts.push(t.to);
      if (ghosts.length) {
        out.push({
          kind: "ghost-transition", machine: m.name, file: m.file, line: t.evidence.line,
          detail: `转移 ${t.from} --${t.trigger ?? ""}→ ${t.to} 引用了状态集之外的名字: ${ghosts.join(", ")}(抄错名/重构漏改嫌疑)`,
        });
      }
    }

    if (!structural) continue; // ①②⑥ 仅显式状态机形态启用(xstate 框架语义跳过)

 // ① 不可达状态:非初始态且无任何转移进入
    for (const s of m.states) {
      if (s === initial || /initial/i.test(s)) continue;
      if (!toSet.has(s)) {
        out.push({
          kind: "unreachable-state", machine: m.name, file: m.file, line: firstLineOf(m),
          detail: `状态 "${s}" 声明了但没有任何转移能进入(初始态 ${initial || "(无)"})——死状态候选`,
        });
      }
    }

 // ② 无出转移 + ⑥ 死终态链
    for (const s of m.states) {
      const hasExit = fromSet.has(s);
      const terminal = isTerminalState(s);
      if (!hasExit && !terminal) {
        out.push({
          kind: "no-exit", machine: m.name, file: m.file, line: firstLineOf(m),
          detail: `状态 "${s}" 进得去出不来,且名字不像终态——卡死候选`,
        });
      }
      if (terminal && hasExit) {
        out.push({
          kind: "dead-terminal", machine: m.name, file: m.file, line: firstLineOf(m),
          detail: `状态 "${s}" 是终态词典命中,但仍有出转移——终态声明与转移表矛盾`,
        });
      }
    }

 // ④ 丢失双向(设计 §14.4 原文:「对称操作半实现,如 lock/unlock、open/close 只写了一半」)——
 // 单向转移是常态(start→running 不需要 running→start),只对**对称动词**触发,否则满屏误报。
    const REVERSE_TRIGGERS = /^(?:lock|unlock|open|close|enable|disable|show|hide|mount|unmount|pause|resume|connect|disconnect|subscribe|unsubscribe|acquire|release)$/i;
    const pairKey = (a: string, b: string, trig: string) => `${a}\u0000${b}\u0000${trig}`;
    const dirs = new Set(m.transitions.filter((t) => t.trigger).map((t) => pairKey(t.from, t.to, t.trigger!)));
    const seenReverse = new Set<string>();
    for (const t of m.transitions) {
      if (!t.trigger || !REVERSE_TRIGGERS.test(t.trigger)) continue;
      const fwd = pairKey(t.from, t.to, t.trigger);
      const rev = pairKey(t.to, t.from, t.trigger);
      if (dirs.has(rev)) continue;
      const seenKey = fwd;
      if (seenReverse.has(seenKey)) continue;
      seenReverse.add(seenKey);
      out.push({
        kind: "missing-reverse", machine: m.name, file: m.file, line: t.evidence.line,
        detail: `对称 trigger "${t.trigger}" 有 ${t.from}→${t.to} 但无 ${t.to}→${t.from}(对称操作半实现候选;非对称动词不判定)`,
      });
    }
  }

 // ⑤ 跨机冲突:同文件 ≥2 台机器的转移引用同一状态名(以 file+state 聚合)
  const writers = new Map<string, Map<string, number>>();
  for (const m of machines) {
    for (const t of m.transitions) {
      for (const s of [t.from, t.to]) {
        const k = `${m.file}\u0000${s}`;
        let per = writers.get(k);
        if (!per) writers.set(k, (per = new Map()));
        per.set(m.name, (per.get(m.name) ?? 0) + 1);
      }
    }
  }
  for (const [k, per] of writers) {
    if (per.size < 2) continue;
    const [file, state] = k.split("\u0000");
    const names = [...per.keys()];
    out.push({
      kind: "cross-machine-write", machine: names.join("+"), file: file ?? "", line: 0,
      detail: `状态 "${state}" 被 ${per.size} 台机器的转移引用(${names.join(", ")})——交叉维护候选(各玩各的)`,
    });
  }

  out.sort((a, b) => a.kind.localeCompare(b.kind) || a.machine.localeCompare(b.machine) || a.line - b.line);
  return out;
}
