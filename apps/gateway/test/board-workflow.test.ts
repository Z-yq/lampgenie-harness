/**
 * 工作流板单测:编译器(图规则 fail-visible)/WFN 标记解析/runner 真跑(MemoryJournal+假 executor)。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import type { BoardDoc } from "@lampgenie/protocol";
import { compileWorkflowBoard, parseWfnMarker, applyWfnMarker, runWorkflowBoard, workflowBoardInflight, type WfNodeStates } from "../src/board-workflow.js";
import { workflowBoard } from "../src/board-sense.js";

function wfDoc(nodes: BoardDoc["nodes"], edges: BoardDoc["edges"]): BoardDoc {
  return {
    version: 1, taskId: "t-wf", sessionId: "s-wf", title: "测试工作流板", status: "draft", docKind: "workflow",
    rev: 1, nodes, edges, planned_files: [], updatedAt: 0,
  } as BoardDoc;
}

const N = (id: string, kind: string, wf: Record<string, unknown> = {}): BoardDoc["nodes"][number] =>
  ({ id, kind, label: id, summary: "s", change: "add", done: false, comments: [], flow: [], wf }) as BoardDoc["nodes"][number];

describe("编译器:图规则", () => {
  it("三节点链(script→test→notify)编译通过,脚本含引擎调用与 WFN 标记", () => {
    const doc = wfDoc(
      [N("n1", "wf-script", { command: "echo setup" }), N("n2", "wf-test", { command: "echo test" }), N("n3", "wf-notify", { message: "完成" })],
      [{ from: "n1", to: "n2", kind: "call" }, { from: "n2", to: "n3", kind: "call" }],
    );
    const r = compileWorkflowBoard(doc);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.order).toEqual(["n1", "n2", "n3"]);
    expect(r.script).toContain('world.run("echo setup"');
    expect(r.script).toContain('world.run("echo test"');
    expect(r.script).toContain('report({ node: "n3"');
    expect(r.script).toContain('WFN|" + id + "|start'); // __wfn 帮手
    expect(r.script).not.toContain("require(");
  });

  it("条件分支:两条出边 label 真/假 → if/else 内联,then/else 英文 label 亦认", () => {
    const doc = wfDoc(
      [N("n1", "wf-script", { command: "echo x" }), N("c", "wf-condition", { cond: 'R["n1"].code === 0' }), N("ok", "wf-notify", { message: "走了真" }), N("bad", "wf-notify", { message: "走了假" })],
      [
        { from: "n1", to: "c", kind: "call" },
        { from: "c", to: "ok", kind: "call", label: "真" },
        { from: "c", to: "bad", kind: "call", label: "假" },
      ],
    );
    const r = compileWorkflowBoard(doc);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.script).toContain('Boolean(R["n1"].code === 0)');
    expect(r.script).toContain('WFN|c|taken|"');
    expect(r.script.indexOf('"走了真"')).toBeGreaterThan(r.script.indexOf("if (v)"));
    // then/else 英文归一
    const doc2 = wfDoc(doc.nodes, doc.edges.map((e) => ({ ...e, label: e.label === "真" ? "then" : e.label === "假" ? "else" : e.label })));
    expect(compileWorkflowBoard(doc2).ok).toBe(true);
  });

  it("并发扇出:wf-parallel 出边≥2 → Promise.all 包分支;孤立节点=独立源并发起跑", () => {
    const doc = wfDoc(
      [N("p", "wf-parallel"), N("a", "wf-script", { command: "echo a" }), N("b", "wf-script", { command: "echo b" }), N("t", "wf-notify", { message: "汇合" })],
      [
        { from: "p", to: "a", kind: "call" }, { from: "p", to: "b", kind: "call" },
        { from: "a", to: "t", kind: "call" }, { from: "b", to: "t", kind: "call" },
      ],
    );
    const r = compileWorkflowBoard(doc);
    expect(r.ok).toBe(false); // a/b 都连 t=扇入(v1 不支持,fail-visible)
    expect((r as { errors: string[] }).errors.some((e) => e.includes("扇入"))).toBe(true);
    // 去掉汇合边:t 无边=独立源(不是孤岛)——与 a/b 并发起跑,合法
    const doc2 = wfDoc(doc.nodes, doc.edges.filter((e) => e.to !== "t"));
    const r2 = compileWorkflowBoard(doc2);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.script).toContain("Promise.all");
    expect(r2.order).toContain("t");
  });

  it("多源=并发(Promise.all);单源不包", () => {
    const doc = wfDoc([N("a", "wf-script", { command: "echo a" }), N("b", "wf-script", { command: "echo b" })], []);
    const r = compileWorkflowBoard(doc);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.script).toContain("Promise.all"); // 两个源并发起跑
  });

  it("编译错误 fail-visible:环/缺 command/普通节点双出口/条件缺 label/非 wf 节点/design 板", () => {
    const cyc = wfDoc(
      [N("a", "wf-script", { command: "echo a" }), N("b", "wf-script", { command: "echo b" })],
      [{ from: "a", to: "b", kind: "call" }, { from: "b", to: "a", kind: "call" }],
    );
    const rCyc = compileWorkflowBoard(cyc);
    expect(rCyc.ok).toBe(false);
    expect((rCyc as { errors: string[] }).errors.some((e) => e.includes("成环"))).toBe(true);

    const noCmd = wfDoc([N("a", "wf-script", {})], []);
    const rNo = compileWorkflowBoard(noCmd);
    expect(rNo.ok).toBe(false);
    expect((rNo as { errors: string[] }).errors.some((e) => e.includes("缺 command"))).toBe(true);

    const multi = wfDoc(
      [N("a", "wf-script", { command: "echo a" }), N("b", "wf-notify", { message: "b" }), N("c", "wf-notify", { message: "c" })],
      [{ from: "a", to: "b", kind: "call" }, { from: "a", to: "c", kind: "call" }],
    );
    const rM = compileWorkflowBoard(multi);
    expect(rM.ok).toBe(false);
    expect((rM as { errors: string[] }).errors.some((e) => e.includes("普通节点只允许 1 条出边"))).toBe(true);

    const badCond = wfDoc(
      [N("c", "wf-condition", { cond: "true" }), N("a", "wf-notify", { message: "a" }), N("b", "wf-notify", { message: "b" })],
      [{ from: "c", to: "a", kind: "call" }, { from: "c", to: "b", kind: "call" }],
    );
    const rB = compileWorkflowBoard(badCond);
    expect(rB.ok).toBe(false);
    expect((rB as { errors: string[] }).errors.some((e) => e.includes("一条「真」一条「假」"))).toBe(true);

    const mixed = wfDoc([N("a", "module")], []);
    const rMix = compileWorkflowBoard(mixed);
    expect(rMix.ok).toBe(false);
    expect((rMix as { errors: string[] }).errors.some((e) => e.includes("不是 wf-*"))).toBe(true);

    const design = wfDoc([N("a", "wf-script", { command: "echo a" })], []);
    (design as { docKind?: string }).docKind = "design";
    const rD = compileWorkflowBoard(design);
    expect(rD.ok).toBe(false);
    expect((rD as { errors: string[] }).errors[0]).toContain("docKind");

    // 命令文本含引擎静态禁令词:编译通过(白名单/禁令是运行期引擎纪律,fail-visible 在运行结果)
    const proc = wfDoc([N("a", "wf-script", { command: 'node -e "process.exit(0)"' })], []);
    expect(compileWorkflowBoard(proc).ok).toBe(true);
  });

  it("wf-agent/wf-test 配置完备校验 + actor 缺省 worker", () => {
    const noInstr = wfDoc([N("a", "wf-agent", {})], []);
    const r1 = compileWorkflowBoard(noInstr);
    expect(r1.ok).toBe(false);
    expect((r1 as { errors: string[] }).errors.some((e) => e.includes("缺 instructions"))).toBe(true);
    const ok = wfDoc([N("a", "wf-agent", { instructions: "分析一下" })], []);
    const r2 = compileWorkflowBoard(ok);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.script).toContain('agent("worker").ask("分析一下")');
    // wf-test 门语义:非 0 退出码 throw(链上后续不跑)——在首个三节点链测试的板上补验
    const testDoc = wfDoc([N("t1", "wf-test", { command: "npx vitest run nope.test.ts" })], []);
    const rt = compileWorkflowBoard(testDoc);
    expect(rt.ok).toBe(true);
    if (!rt.ok) return;
    expect(rt.script).toContain("if (r.code !== 0) throw");
  });
});

describe("WFN 标记:解析与状态投影", () => {
  it("start/taken/done/fail 全链路状态转移", () => {
    expect(parseWfnMarker("WFN|n1|start")).toEqual({ nodeId: "n1", state: "start", detail: "" });
    expect(parseWfnMarker("WFN|c1|taken|真")).toEqual({ nodeId: "c1", state: "taken", detail: "真" });
    expect(parseWfnMarker("WFN|n1|done|123")).toEqual({ nodeId: "n1", state: "done", detail: "123" });
    expect(parseWfnMarker("WFN|n1|fail|12|Error: x")).toEqual({ nodeId: "n1", state: "fail", detail: "12|Error: x" });
    expect(parseWfnMarker("普通日志")).toBeNull();
    const s: WfNodeStates = {};
    expect(applyWfnMarker(s, { nodeId: "n1", state: "start", detail: "" })).toBe(true);
    expect(s.n1).toEqual({ state: "running" });
    applyWfnMarker(s, { nodeId: "n1", state: "done", detail: "42" });
    expect(s.n1).toEqual({ state: "done", ms: 42 });
    applyWfnMarker(s, { nodeId: "c", state: "taken", detail: "真" });
    applyWfnMarker(s, { nodeId: "c", state: "done", detail: "7" });
    expect(s.c).toEqual({ state: "done", ms: 7, detail: "真" }); // done 不抹 taken 的分支信息
    applyWfnMarker(s, { nodeId: "n1", state: "fail", detail: "5|boom" });
    expect(s.n1.state).toBe("failed");
  });
});

describe("runner:真跑(MemoryJournal+假 executor)", () => {
  it("script→condition→notify 链真跑:节点状态依次 done,journal 留 workflow.node/run.start/run.done", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfb-"));
    try {
      const j = new MemoryJournal();
      const doc = wfDoc(
        [
          N("n1", "wf-script", { command: "echo board-wf-e2e" }),
          N("c1", "wf-condition", { cond: 'R["n1"].code === 0' }),
          N("okp", "wf-notify", { message: "真分支到达" }),
          N("badp", "wf-notify", { message: "假分支到达" }),
        ],
        [
          { from: "n1", to: "c1", kind: "call" },
          { from: "c1", to: "okp", kind: "call", label: "真" },
          { from: "c1", to: "badp", kind: "call", label: "假" },
        ],
      );
      const broadcast: Record<string, unknown>[] = [];
      const executor = {
        kind: "fake" as const,
        async spawn(spec: { taskId: string }, onEvent: (e: unknown) => void) {
          onEvent({ type: "result", result: { ok: true, finalText: "代理回复:" + spec.taskId } });
          return { taskId: spec.taskId, cancel: async () => {}, steer: async () => true, respondPermission: async () => {} };
        },
      };
      const out = await runWorkflowBoard({ root, journal: j, doc, executor: executor as never, broadcast: (m) => broadcast.push(m) });
      expect(out.ok).toBe(true);
      expect(out.states.n1?.state).toBe("done");
      expect(out.states.c1?.state).toBe("done");
      expect(out.states.c1?.detail).toBe("真"); // 条件走了真分支
      expect(out.states.okp?.state).toBe("done");
      expect(out.states.badp).toBeUndefined(); // 假分支未执行
      // journal 三类事件留痕
      const kinds = j.readAll().map((e) => e.kind);
      expect(kinds).toContain("workflow.run.start");
      expect(kinds).toContain("workflow.run.done");
      const nodeEvents = j.readAll().filter((e) => e.kind === "workflow.node");
      expect(nodeEvents.length).toBeGreaterThanOrEqual(7); // n1×2 + c1×3(start/taken/done)+ okp×2;假分支 0
      // 广播:progress 若干 + 终态 result
      const types = broadcast.map((m) => (m as { type: string }).type);
      expect(types.filter((t) => t === "board.workflow.progress").length).toBeGreaterThanOrEqual(7);
      expect(types).toContain("board.workflow.result");
      // 引擎 report(通知节点成果)
      expect(out.result?.items.some((it) => it.node === "okp")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("wf-agent 节点走假 executor 派发;在飞表防并发", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfb2-"));
    try {
      const j = new MemoryJournal();
      const doc = wfDoc(
        [N("ag", "wf-agent", { actor: "analyst", instructions: "看看" }), N("nt", "wf-notify", { message: "代理完了" })],
        [{ from: "ag", to: "nt", kind: "call" }],
      );
      const executor = {
        kind: "fake" as const,
        async spawn(spec: { taskId: string; instructions: string }, onEvent: (e: unknown) => void) {
          onEvent({ type: "result", result: { ok: true, finalText: "已分析:" + spec.instructions.slice(0, 4) } });
          return { taskId: spec.taskId, cancel: async () => {}, steer: async () => true, respondPermission: async () => {} };
        },
      };
      const out = await runWorkflowBoard({ root, journal: j, doc, executor: executor as never, broadcast: () => {} });
      expect(out.ok).toBe(true);
      expect(out.result?.items.some((it) => it.node === "nt")).toBe(true);
      expect(workflowBoardInflight(doc.taskId)).toBeNull(); // 收尾即清
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("编译失败:零执行,errors 原样返回", async () => {
    const j = new MemoryJournal();
    const doc = wfDoc([N("a", "wf-script", {})], []);
    const out = await runWorkflowBoard({ root: ".", journal: j, doc, executor: null as never, broadcast: () => {} });
    expect(out.ok).toBe(false);
    expect((out as { errors?: string[] }).errors?.some((e) => e.includes("缺 command"))).toBe(true);
    expect(j.readAll().filter((e) => e.kind === "workflow.node")).toHaveLength(0);
  });

  it("无 executor:纯确定性流照跑(script/test/notify 全 done);wf-agent 节点显式失败不静默", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfb3-"));
    try {
      const j = new MemoryJournal();
      // 确定性三节点链:不派发,无 executor 也应全 done
      const okDoc = wfDoc(
        [N("n1", "wf-script", { command: "echo noexec-ok" }), N("n2", "wf-test", { command: "echo noexec-test" }), N("n3", "wf-notify", { message: "无 executor 也可跑" })],
        [{ from: "n1", to: "n2", kind: "call" }, { from: "n2", to: "n3", kind: "call" }],
      );
      const out = await runWorkflowBoard({ root, journal: j, doc: okDoc, broadcast: () => {} }); // 不传 executor
      expect(out.ok).toBe(true);
      expect(out.states.n1?.state).toBe("done");
      expect(out.states.n3?.state).toBe("done");
      // wf-agent 板:agent 节点显式 failed(红态)+错误信息含「未配置 executor」;面板可 fail-visible
      const agDoc = wfDoc(
        [N("ag", "wf-agent", { instructions: "分析" }), N("nt", "wf-notify", { message: "到不了" })],
        [{ from: "ag", to: "nt", kind: "call" }],
      );
      const out2 = await runWorkflowBoard({ root, journal: j, doc: agDoc, broadcast: () => {} });
      expect(out2.ok).toBe(false);
      expect(out2.states.ag?.state).toBe("failed");
      expect(String(out2.states.ag?.detail)).toContain("未配置 executor");
      expect(out2.states.nt).toBeUndefined(); // 失败即停,后续节点零执行
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("board-sense workflowBoard 转换器", () => {
  it("spec→工作流板节点边;引用不存在步骤的边丢弃", () => {
    const b = workflowBoard({
      title: "t",
      steps: [
        { id: "s1", kind: "wf-script", label: "准备", config: { command: "echo hi" } },
        { id: "s2", kind: "wf-notify", label: "通知", config: { message: "done" } },
      ],
      edges: [{ from: "s1", to: "s2" }, { from: "s1", to: "ghost" }],
    });
    expect(b.nodes).toHaveLength(2);
    expect(b.nodes[0].wf).toEqual({ command: "echo hi" });
    expect(b.edges).toHaveLength(1);
    expect(compileWorkflowBoard({ ...wfDoc(b.nodes, b.edges), title: b.title, taskId: "tb" } as BoardDoc).ok).toBe(true);
  });
});
