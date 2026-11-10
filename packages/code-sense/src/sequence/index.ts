/**
 * sequence/state(designs/16 §6.6/6.7):静态时序(语句序+异步边界)、
 * 状态机提取(TRANSITIONS 金标准)、journal 动态序。
 */
import { Project, SyntaxKind, type CallExpression, type SourceFile } from "ts-morph";
import type { Journal } from "@lampgenie/core";

// ---- 静态时序 ----
export interface SeqStep {
  caller: string;
  callee: string;
  order: number;          // 语句序(函数体内出现顺序)
  asyncBoundary: "sync" | "await" | "callback" | "timer";
  /** 源行号(证据纪律:R5-C20 接入 debug 剖面时补)。 */
  line?: number;
}
export interface StaticSequence {
  steps: SeqStep[];
  mermaid: string;
  asyncBoundaries: number;
}

/** 提取单个函数体内的调用语句序(ts-morph)。 */
export function extractSequence(sf: SourceFile, functionName: string): StaticSequence {
  const steps: SeqStep[] = [];
  let order = 0;
  sf.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.CallExpression) return;
    const call = node as CallExpression;
    const fn = call.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration)
      ?? call.getFirstAncestorByKind(SyntaxKind.MethodDeclaration);
    if (!fn || fn.getName?.() !== functionName) return;

    const callee = call.getExpression().getText().slice(0, 40);
    // 异步边界判定:被 await 包裹 / 回调参数 / 定时器
    let boundary: SeqStep["asyncBoundary"] = "sync";
    const p = call.getParent();
    if (p?.getKind() === SyntaxKind.AwaitExpression) boundary = "await";
    else if (/setTimeout|setInterval/.test(callee)) boundary = "timer";
    else if (call.getArguments().some((a) => a.getKind() === SyntaxKind.ArrowFunction || a.getKind() === SyntaxKind.FunctionExpression)) boundary = "callback";
    steps.push({ caller: functionName, callee, order: order++, asyncBoundary: boundary, line: call.getStartLineNumber() });
  });
  return toMermaid(steps);
}

function toMermaid(steps: SeqStep[]): StaticSequence {
  const lines = ["sequenceDiagram"];
  lines.push("  participant M as 模块");
  let prev = "M";
  const asyncCount = steps.filter((s) => s.asyncBoundary !== "sync").length;
  for (const s of steps) {
    const label = s.asyncBoundary === "sync" ? s.callee : `${s.callee} [${s.asyncBoundary}]`;
    lines.push(`  ${prev}->>M: ${label}`);
    prev = "M";
  }
  if (asyncCount > 0) {
    lines.push(`  Note over M: 静态序≠运行序(异步边界 ${asyncCount} 处)`);
  }
  return { steps, mermaid: lines.join("\n"), asyncBoundaries: asyncCount };
}

// ---- 状态机提取 ----
export interface Transition { from: string; to: string; evidenceLine?: number }
export interface StateMachine {
  states: string[];
  transitions: Transition[];
  mermaid: string;
}

/** TRANSITIONS 形态字面量表(本仓 core/task.ts 金标准):
 * const T: Record<State, ReadonlySet<State>> = { s: new Set([...]) } */
export function extractStateMachineFromTransitions(sourceText: string): StateMachine | null {
  const states = new Set<string>();
  const transitions: Transition[] = [];
  // new Set(["a", "b"]) 形态,键为状态
  const re = /([A-Za-z_][\w]*)\s*:\s*new Set\(\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sourceText))) {
    const from = m[1]!;
    states.add(from);
    const targets = m[2]!.match(/["']([^"']+)["']/g) ?? [];
    for (const t of targets) {
      const to = t.replace(/["']/g, "");
      states.add(to);
      transitions.push({ from, to });
    }
  }
  if (states.size === 0) return null;
  const lines = ["stateDiagram-v2"];
  for (const t of transitions) lines.push(`  ${t.from} --> ${t.to}`);
  return { states: [...states], transitions, mermaid: lines.join("\n") };
}

// ---- journal 动态序(harness 独有,designs/16 §22.3) ----
export interface RuntimeSequence {
  mermaid: string;
  events: { kind: string; time: number }[];
}

/** 从 journal 事件序生成真实运行时序图。 */
export function runtimeSequenceFromJournal(journal: Journal, sessionId: string): RuntimeSequence {
  const events = journal
    .readAll()
    .filter((e) => e.sessionId === sessionId && (e.kind.startsWith("tool.") || e.kind.startsWith("task.")))
    .map((e) => ({ kind: e.kind as string, time: e.time }));
  const lines = ["sequenceDiagram", "  participant U as 用户", "  participant A as Agent", "  participant T as 工具"];
  let prevActor = "U";
  for (const e of events) {
    const actor = e.kind.startsWith("tool.") ? "T" : "A";
    lines.push(`  ${prevActor}->>${actor}: ${e.kind}`);
    prevActor = actor;
  }
  return { mermaid: lines.join("\n"), events };
}

// ---- 入口:对一个符号产出静态序(ts-morph Project 由调用方给或自建) ----
export async function sequenceOfSymbol(root: string, files: string[], symbol: string): Promise<StaticSequence | null> {
  const { Project: P } = await import("ts-morph");
  const project = new P({ skipAddingFilesFromTsConfig: true });
  for (const f of files) {
    try { project.addSourceFileAtPath(`${root}/${f}`); } catch { /* skip */ }
  }
  for (const sf of project.getSourceFiles()) {
    const seq = extractSequence(sf, symbol);
    if (seq.steps.length > 0) return seq;
  }
  return null;
}
