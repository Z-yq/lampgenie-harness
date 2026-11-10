/**
 * board-workflow(参照 dify 工作流语义):工作流板(docKind=workflow)↔ harness-workflow 引擎。
 * - compileWorkflowBoard:纯函数编译器——画布 BoardDoc(nodes=wf-* 类型化配置,edges=执行顺序/分支)
 * → 引擎 TS 脚本(原生形态,facade=agent/world/report/log/now);编译错误 fail-visible 全列出。
 * - 图规则:①DAG(环=错误);②普通节点出边≤1,wf-parallel 出边≥2(全并发),wf-condition 恰 2 条
 *   出边(label 真/假);③多源=Promise.all 并发;④扇入(多入边)暂不支持(错误提示,不静默错跑);
 *   ⑤必填配置缺失=错误;⑥非 wf-* 节点混入=错误(design/page 板不编)。
 * - 节点状态标记:编译器给每节点包 __wfn 帮手,log("WFN|<id>|<state>|<detail>")
 *   state∈start/taken/done/fail;引擎 onLog 回调实时上抛(引擎加性扩展),runner 解析→journal
 *   workflow.node 事件→WS board.workflow.progress 广播→面板节点高亮。
 * - runWorkflowBoard:服务端 runner(journal+executor+可选面板直答路由+广播注入)。
 * 引擎纪律如实继承:world.run 白名单(测试运行器/node/git 只读/ls/cat/grep/tail);
 * 脚本静态禁令(源文本不得含 require(/process./import()——命令文本以字符串字面量嵌进脚本源,
 * 含 process. 的命令会被引擎拒,属引擎既有安全边界,不绕)。
 */
import type { BoardDoc } from "@lampgenie/protocol";
import { WorkflowEngine, type WorkflowResult } from "@lampgenie/workflow";
import type { Journal } from "@lampgenie/core";
import type { SubagentBackend } from "@lampgenie/executors";
import { createHash } from "node:crypto";

export type WfNodeKind = "wf-script" | "wf-test" | "wf-agent" | "wf-condition" | "wf-parallel" | "wf-notify";
export const WF_NODE_KINDS: readonly WfNodeKind[] = ["wf-script", "wf-test", "wf-agent", "wf-condition", "wf-parallel", "wf-notify"] as const;

export interface WfNodeStates {
  [nodeId: string]: { state: "running" | "done" | "failed"; ms?: number; detail?: string };
}
export type WfCompileResult =
  | { ok: true; script: string; order: string[] }
  | { ok: false; errors: string[] };

type WfNode = BoardDoc["nodes"][number] & { kind: WfNodeKind; wf?: { command?: string; timeoutMs?: number; actor?: string; instructions?: string; cond?: string; message?: string } };

const isWfKind = (k: string): k is WfNodeKind => (WF_NODE_KINDS as readonly string[]).includes(k);

/** 条件出边 label 归一:真/then/是 → then;假/else/否 → else。 */
function condBranchOf(label: string | undefined): "then" | "else" | null {
  const t = String(label ?? "").trim().toLowerCase();
  if (t === "真" || t === "then" || t === "是") return "then";
  if (t === "假" || t === "else" || t === "否") return "else";
  return null;
}

/** 画布 doc → 引擎脚本(纯函数,零 IO 零随机)。 */
export function compileWorkflowBoard(doc: BoardDoc): WfCompileResult {
  const errors: string[] = [];
  if (doc.docKind !== "workflow") return { ok: false, errors: ["板类型不是 workflow(docKind=" + (doc.docKind ?? "design") + ")——工作流编译只吃 docKind=workflow 板"] };
  const badKind = doc.nodes.find((n) => !isWfKind(n.kind));
  if (badKind) errors.push(`节点 ${badKind.id}(${badKind.label})类型 ${badKind.kind} 不是 wf-* 可执行节点——工作流板只能放 wf-script/wf-test/wf-agent/wf-condition/wf-parallel/wf-notify`);
  if (errors.length) return { ok: false, errors };

  const nodes = new Map<string, WfNode>(doc.nodes.map((n) => [n.id, n as WfNode]));
  const succ = new Map<string, BoardDoc["edges"]>();
  const pred = new Map<string, string[]>();
  for (const id of nodes.keys()) { succ.set(id, []); pred.set(id, []); }
  for (const e of doc.edges) {
    if (!nodes.has(e.from) || !nodes.has(e.to)) continue; // board-store 已拒脏边;编译容错跳过
    succ.get(e.from)!.push(e);
    pred.get(e.to)!.push(e.from);
  }
  // 重复边(同 from→to 两条)会让节点被发射两次
  const seenEdge = new Set<string>();
  for (const e of doc.edges) {
    const k = e.from + ">" + e.to;
    if (!nodes.has(e.from) || !nodes.has(e.to)) continue;
    if (seenEdge.has(k)) errors.push(`重复边 ${e.from} → ${e.to}(同一对节点只连一条)`);
    seenEdge.add(k);
  }
  // 扇入(多入边)暂不支持:节点会被发射两次=静默错跑,宁可 fail-visible
  for (const [id, ps] of pred) {
    if (ps.length > 1) errors.push(`节点 ${id}(${nodes.get(id)?.label ?? ""})有 ${ps.length} 条入边——扇入(汇合)暂不支持:并发分支各自收尾,或用 wf-parallel 出边表达扇出`);
  }
  // 环检测(DFS 三色)
  const color = new Map<string, 0 | 1 | 2>(); // 0=未访 1=在途 2=完成
  const stack: string[] = [];
  const dfs = (id: string): void => {
    color.set(id, 1);
    stack.push(id);
    for (const e of succ.get(id) ?? []) {
      const c = color.get(e.to) ?? 0;
      if (c === 1) {
        const at = stack.indexOf(e.to);
        errors.push("成环: " + (at >= 0 ? stack.slice(at).join(" → ") + " → " + e.to : id + " → " + e.to));
      } else if (c === 0) dfs(e.to);
    }
    stack.pop();
    color.set(id, 2);
  };
  for (const id of nodes.keys()) if ((color.get(id) ?? 0) === 0) dfs(id);

  // 出边规则 + 必填配置
  for (const n of doc.nodes) {
    const wf = n as WfNode;
    const outs = succ.get(n.id) ?? [];
    const cfg = wf.wf ?? {};
    if (n.kind === "wf-parallel" && outs.length < 2) errors.push(`节点 ${n.id}(${n.label})wf-parallel 需要 ≥2 条出边(并发扇出),当前 ${outs.length}`);
    if (n.kind !== "wf-parallel" && n.kind !== "wf-condition" && outs.length > 1) errors.push(`节点 ${n.id}(${n.label})有 ${outs.length} 条出边——普通节点只允许 1 条出边,多路请用 wf-parallel(并发)或 wf-condition(条件分支)`);
    if (n.kind === "wf-condition") {
      if (outs.length !== 2) errors.push(`节点 ${n.id}(${n.label})wf-condition 需要恰好 2 条出边(label 真/假),当前 ${outs.length}`);
      else {
        const [e1 = { to: "", kind: "call" as const, from: "", label: undefined }, e2 = { to: "", kind: "call" as const, from: "", label: undefined }] = outs;
        const b1 = condBranchOf(e1.label), b2 = condBranchOf(e2.label);
        if (!b1 || !b2 || b1 === b2) errors.push(`节点 ${n.id}(${n.label})wf-condition 两条出边 label 必须一条「真」一条「假」(当前:「${e1.label ?? ""}」「${e2.label ?? ""}」)`);
        else if (e1.to === e2.to) errors.push(`节点 ${n.id}(${n.label})wf-condition 真/假分支指向同一节点 ${e1.to}(两分支会被各跑一次)`);
      }
      if (!String(cfg.cond ?? "").trim()) errors.push(`节点 ${n.id}(${n.label})wf-condition 缺条件表达式 cond(JS 表达式,引用 R["<节点id>"],如 R["setup"].code === 0)`);
    }
    if ((n.kind === "wf-script" || n.kind === "wf-test") && !String(cfg.command ?? "").trim()) errors.push(`节点 ${n.id}(${n.label})${n.kind} 缺 command(world.run 白名单命令,如 npx vitest run test/x.test.ts)`);
    if (n.kind === "wf-agent" && !String(cfg.instructions ?? "").trim()) errors.push(`节点 ${n.id}(${n.label})wf-agent 缺 instructions(派给子代理的指令)`);
    if (n.kind === "wf-notify" && !String(cfg.message ?? "").trim()) errors.push(`节点 ${n.id}(${n.label})wf-notify 缺 message(通知/成果内容)`);
  }
  if (errors.length) return { ok: false, errors };

  // ---- 发射(递归内联;无扇入+DAG ⇒ 每节点恰好发射一次) ----
  const order: string[] = [];
  const emitted = new Set<string>();
  const J = JSON.stringify; // 字符串字面量安全嵌入(引号/换行全转义)
  const timeoutOf = (n: WfNode): string => (n.wf?.timeoutMs ? String(Math.min(Math.max(1, Math.floor(n.wf.timeoutMs)), 600_000)) : "120000");

  const emitChain = (id: string): string => {
    if (emitted.has(id)) return `throw new Error("内部错误:节点 ${id} 被二次发射(扇入未拦截?)");`;
    emitted.add(id);
    order.push(id);
    const n = nodes.get(id)!;
    const outs = succ.get(id) ?? [];
    const next = outs.length && n.kind !== "wf-parallel" && n.kind !== "wf-condition" ? emitChain(outs[0]!.to) : "";
    switch (n.kind) {
      case "wf-script":
        return [
          `await __wfn(${J(id)}, async () => {`,
          `  R[${J(id)}] = await world.run(${J(n.wf?.command ?? "")}, { timeoutMs: ${timeoutOf(n)} });`,
          `  return R[${J(id)}].code === 0;`,
          `});`,
          next,
        ].join("\n");
      case "wf-test":
        return [
          `await __wfn(${J(id)}, async () => {`,
          `  const r = await world.run(${J(n.wf?.command ?? "")}, { timeoutMs: ${timeoutOf(n)} });`,
          `  R[${J(id)}] = r;`,
          `  report({ node: ${J(id)}, label: ${J(n.label)}, ok: r.code === 0, tail: String(r.stdout || r.stderr || "").slice(-300) });`,
          `  if (r.code !== 0) throw new Error("测试命令退出码 " + r.code + ": " + String(r.stderr || r.stdout || "").slice(0, 160));`,
          `  return true;`,
          `});`,
          next,
        ].join("\n");
      case "wf-agent":
        return [
          `await __wfn(${J(id)}, async () => {`,
          `  const ans = await agent(${J(n.wf?.actor || "worker")}).ask(${J(n.wf?.instructions ?? "")});`,
          `  R[${J(id)}] = ans;`,
          `  return true;`,
          `});`,
          next,
        ].join("\n");
      case "wf-notify":
        return [
          `await __wfn(${J(id)}, async () => {`,
          `  report({ node: ${J(id)}, label: ${J(n.label)}, message: ${J(n.wf?.message ?? "")} });`,
          `  log("通知:" + ${J(n.wf?.message ?? "")});`,
          `  return true;`,
          `});`,
          next,
        ].join("\n");
      case "wf-parallel": {
        const branches = outs.map((e) => `(async () => {\n${emitChain(e.to)}\n})()`);
        return [
          `await __wfn(${J(id)}, async () => {`,
          `  await Promise.all([`,
          branches.join(",\n"),
          `  ]);`,
          `  return true;`,
          `});`,
        ].join("\n");
      }
      case "wf-condition": {
        const first = outs[0]!, second = outs[1]!; // 长度=2 已在规则段校验
        const thenEdge = condBranchOf(first.label) === "then" ? first : second;
        const elseEdge = condBranchOf(first.label) === "else" ? first : second;
        return [
          `await __wfn(${J(id)}, async () => {`,
          `  const v = Boolean(${String(n.wf?.cond ?? "false")});`,
          `  log("WFN|${id}|taken|" + (v ? "真" : "假"));`,
          `  if (v) {`,
          emitChain(thenEdge.to),
          `  } else {`,
          emitChain(elseEdge.to),
          `  }`,
          `  return v;`,
          `});`,
        ].join("\n");
      }
      default:
        return `throw new Error("内部错误:未知节点类型 ${n.kind}");`;
    }
  };

  const sources = doc.nodes.filter((n) => (pred.get(n.id) ?? []).length === 0).map((n) => n.id);
  if (!sources.length) return { ok: false, errors: ["无入口节点(全部节点都有入边=环或脏边)"] };
  const body = sources.length === 1
    ? emitChain(sources[0]!)
    : sources.map((s) => `(async () => {\n${emitChain(s)}\n})()`).join(",\n");
  const header = [
    `// workflow 板「${doc.title}」(${doc.taskId})·  board-workflow 编译产物`,
    `// 节点结果域:R["<id>"];状态标记:WFN|<id>|<state>|<detail>`,
    `const R = {};`,
    `async function __wfn(id, fn) {`,
    `  log("WFN|" + id + "|start");`,
    `  const t0 = now();`,
    `  try {`,
    `    const v = await fn();`,
    `    log("WFN|" + id + "|done|" + (now() - t0));`,
    `    return v;`,
    `  } catch (e) {`,
    `    log("WFN|" + id + "|fail|" + (now() - t0) + "|" + String(e).slice(0, 80));`,
    `    throw e;`,
    `  }`,
    `}`,
  ].join("\n");
  const script = header + "\n" + (sources.length === 1 ? body : `await Promise.all([\n${body}\n]);`) + "\n";
  // 未被任何链触达的节点(孤岛)如实登记为编译警告级错误(用户画了但不执行=fail-visible 优于静默)
  const orphans = doc.nodes.filter((n) => !emitted.has(n.id)).map((n) => n.id);
  if (orphans.length) return { ok: false, errors: [`节点未接入执行链(孤岛,无入口可达): ${orphans.join(", ")}`] };
  return { ok: true, script, order };
}

// ---- WFN 标记解析(journal/广播前的纯投影) ----

/** 解析一条 log:WFN|id|state|detail → {nodeId,state,detail} | null(state∈start/taken/done/fail)。 */
export function parseWfnMarker(msg: string): { nodeId: string; state: "start" | "taken" | "done" | "fail"; detail: string } | null {
  const m = /^WFN\|([A-Za-z0-9_-]+)\|(start|taken|done|fail)\|?([\s\S]*)$/.exec(msg);
  if (!m) return null;
  return { nodeId: m[1]!, state: m[2] as "start" | "taken" | "done" | "fail", detail: m[3] ?? "" };
}

/** 标记 → 状态表增量(纯函数):start→running;taken→running+detail(走真/假);done→done+ms;fail→failed+detail。 */
export function applyWfnMarker(states: WfNodeStates, marker: { nodeId: string; state: string; detail: string }): boolean {
  const cur = states[marker.nodeId];
  switch (marker.state) {
    case "start":
      states[marker.nodeId] = { state: "running" };
      return true;
    case "taken":
      states[marker.nodeId] = { state: cur?.state ?? "running", ...(cur?.ms !== undefined ? { ms: cur.ms } : {}), detail: marker.detail || (cur?.detail ?? "") };
      return true;
    case "done": {
      const ms = Number.parseInt(marker.detail, 10);
      states[marker.nodeId] = { state: "done", ...(Number.isFinite(ms) ? { ms } : {}), ...(cur?.detail ? { detail: cur.detail } : {}) };
      return true;
    }
    case "fail":
      states[marker.nodeId] = { state: "failed", ...(cur?.detail ? { detail: cur.detail + " · " + marker.detail } : (marker.detail ? { detail: marker.detail } : {})) };
      return true;
    default:
      return false;
  }
}

// ---- 服务端 runner ----

/** 同一 board 并发 run 拒(在飞表;进程级)。 */
const runInflight = new Map<string, { wfId: string; at: number }>();
export function workflowBoardInflight(taskId: string): string | null {
  const it = runInflight.get(taskId);
  if (it && Date.now() - it.at > 15 * 60_000) { runInflight.delete(taskId); return null; } // 15min 兜底回收
  return it ? it.wfId : null;
}

export interface RunWorkflowBoardOpts {
  root: string;
  journal: Journal;
  doc: BoardDoc;
  /** 子代理后端(wf-agent 节点派发回退);可缺——纯确定性流(script/test/condition/parallel/notify)
   * 不经派发照跑,wf-agent 节点显式失败(fail-visible 红态,不静默拒整板)。 */
  executor?: SubagentBackend | null;
  /** WS 广播(面板进度/终态)。 */
  broadcast: (msg: Record<string, unknown>) => void;
  /** 面板直答路由(F6;缺省=ask 全走 executor)。 */
  workflowAskRouter?: { ask(wfId: string, cacheKey: string, instructions: string): Promise<string | null> } | null;
  /** 引擎总超时(缺省 600s,同引擎缺省)。 */
  timeoutMs?: number;
}

export interface RunWorkflowBoardOutcome {
  wfId: string;
  ok: boolean;
  errors?: string[];
  result?: WorkflowResult;
  states: WfNodeStates;
}

/** 编译+执行(journal 留痕:workflow.run.start/workflow.node/workflow.run.done;广播 progress/result)。 */
export async function runWorkflowBoard(opts: RunWorkflowBoardOpts): Promise<RunWorkflowBoardOutcome> {
  const { doc, journal, executor, broadcast } = opts;
  const NO_EXECUTOR_MSG = "网关未配置 executor——wf-agent 节点无法派发(纯确定性节点 script/test/condition/parallel/notify 不受影响)";
  const compile = compileWorkflowBoard(doc);
  const wfId = `wfb-${doc.taskId}-${Date.now()}`;
  if (!compile.ok) return { wfId, ok: false, errors: compile.errors, states: {} };

  const states: WfNodeStates = {};
  journal.append({ kind: "workflow.run.start", sessionId: doc.sessionId, payload: { wfId, boardTaskId: doc.taskId, title: doc.title, by: "board" } });
  const onProgress = (nodeId: string, state: string, detail: string, ms?: number): void => {
    journal.append({ kind: "workflow.node", sessionId: doc.sessionId, payload: { wfId, boardTaskId: doc.taskId, nodeId, state, detail, ...(ms !== undefined ? { ms } : {}) } });
    broadcast({ v: 1, type: "board.workflow.progress", sessionId: doc.sessionId, taskId: doc.taskId, wfId, states: { ...states } });
  };
  const engine = new WorkflowEngine({
    root: opts.root, journal, workflowId: wfId,
    // 引擎类型要 executor,但本 runner 恒注入 dispatch(引擎缺省派发不触达);缺 executor 时给不可达桩
    executor: (executor
      ? { ...executor, spawn: executor.spawn.bind(executor) }
      : { spawn: async () => { throw new Error(NO_EXECUTOR_MSG); } }) as never,
    onLog: (msg) => {
      const marker = parseWfnMarker(msg);
      if (!marker) return;
      if (applyWfnMarker(states, marker)) {
        const st = states[marker.nodeId]!;
        onProgress(marker.nodeId, st.state, marker.detail ?? "", st.ms);
      }
    },
    dispatch: async (instr) => {
      // F6 同款:面板在线先问面板;超时/离线回退 executor
      const hash = createHash("sha256").update(instr).digest("hex").slice(0, 12);
      const direct = opts.workflowAskRouter ? await opts.workflowAskRouter.ask(wfId, "panel:" + hash, instr) : null;
      if (direct !== null) return direct;
      if (!executor) throw new Error(NO_EXECUTOR_MSG); // wf-agent 节点显式失败,确定性流不受影响
      return new Promise<string>((resolve, reject) => {
        void executor.spawn({ taskId: wfId, instructions: instr, workdir: opts.root, permissions: "sandbox" }, (e) => {
          if (e.type === "result") e.result.ok ? resolve(e.result.finalText ?? "") : reject(new Error(e.result.error?.detail ?? e.result.error?.kind ?? "agent 失败"));
        }).catch(reject);
      });
    },
  });
  runInflight.set(doc.taskId, { wfId, at: Date.now() });
  let result: WorkflowResult;
  try {
    result = await engine.run(compile.script, opts.timeoutMs ?? 600_000);
  } finally {
    runInflight.delete(doc.taskId);
  }
  // 引擎失败(编译产物语法/静态禁令/超时):整体 failed 广播,states 保留已到进度
  if (!result.ok && Object.keys(states).length === 0) {
    broadcast({ v: 1, type: "board.workflow.result", sessionId: doc.sessionId, taskId: doc.taskId, wfId, ok: false, error: result.error ?? "workflow 运行失败", states: {} });
    journal.append({ kind: "workflow.run.done", sessionId: doc.sessionId, payload: { wfId, boardTaskId: doc.taskId, ok: false, by: "board" } });
    return { wfId, ok: false, errors: [result.error ?? "workflow 运行失败"], result, states };
  }
  journal.append({ kind: "workflow.run.done", sessionId: doc.sessionId, payload: { wfId, boardTaskId: doc.taskId, ok: result.ok, by: "board" } });
  broadcast({
    v: 1, type: "board.workflow.result", sessionId: doc.sessionId, taskId: doc.taskId, wfId,
    ok: result.ok, partial: result.partial, ...(result.error ? { error: result.error } : {}),
    items: result.items.slice(0, 30), logs: result.logs.slice(-40), durationMs: result.durationMs, states: { ...states },
  });
  return { wfId, ok: result.ok, result, states };
}
