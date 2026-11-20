/**
 * statemachine-audit 测试(设计稿 14.4 六签名):
 * 手造 StateMachine 直测投影层(不依赖文件扫描)+ xstate 边界负例 + 渲染附注。
 */
import { describe, it, expect } from "vitest";
import { auditStateMachines } from "../src/sensing/statemachine-audit.js";
import type { StateMachine } from "../src/sensing/statemachines.js";
import { renderStateMachines } from "../src/sensing/index.js";

const ev = (line: number) => ({ file: "m.ts", line });

function mkMachine(over: Partial<StateMachine>): StateMachine {
  return {
    name: "M", form: "transitions-table", file: "m.ts",
    states: ["idle", "running", "done"],
    transitions: [
      { from: "idle", to: "running", trigger: "start", evidence: ev(3) },
      { from: "running", to: "done", trigger: "finish", evidence: ev(4) },
    ],
    candidates: [], mermaid: "",
    ...over,
  };
}

describe("auditStateMachines 六签名", () => {
  it("① 不可达状态:声明了但无转移进入(非初始态)", () => {
    const out = auditStateMachines([mkMachine({ states: ["idle", "running", "orphaned", "done"] })]);
    expect(out.some((d) => d.kind === "unreachable-state" && d.detail.includes("orphaned"))).toBe(true);
  });

  it("② 无出转移:进得去出不来且非终态词典命中", () => {
    const out = auditStateMachines([mkMachine({
      states: ["idle", "stuck", "done"],
      transitions: [
        { from: "idle", to: "stuck", trigger: "enter", evidence: ev(3) },
        { from: "idle", to: "done", trigger: "skip", evidence: ev(4) },
      ],
    })]);
    expect(out.some((d) => d.kind === "no-exit" && d.detail.includes("stuck"))).toBe(true);
  });

  it("③ 幽灵转移:转移引用声明集外的状态名", () => {
    const out = auditStateMachines([mkMachine({
      transitions: [
        { from: "idle", to: "runnning", trigger: "start", evidence: ev(3) }, // 拼错:running→runnning
      ],
    })]);
    expect(out.some((d) => d.kind === "ghost-transition" && d.detail.includes("runnning"))).toBe(true);
  });

  it("④ 丢失双向:同 trigger A→B 有而 B→A 无", () => {
    const out = auditStateMachines([mkMachine({
      states: ["unlocked", "locked"],
      transitions: [{ from: "unlocked", to: "locked", trigger: "lock", evidence: ev(2) }],
    })]);
    expect(out.some((d) => d.kind === "missing-reverse" && d.detail.includes("lock"))).toBe(true);
  });

  it("⑤ 跨机冲突:同文件两台机器转移引用同一状态名", () => {
    const a = mkMachine({ name: "A", states: ["s1", "s2"], transitions: [{ from: "s1", to: "s2", evidence: ev(1) }] });
    const b = mkMachine({ name: "B", states: ["s2", "s3"], transitions: [{ from: "s2", to: "s3", evidence: ev(9) }] });
    const out = auditStateMachines([a, b]);
    expect(out.some((d) => d.kind === "cross-machine-write" && d.detail.includes("s2"))).toBe(true);
  });

  it("⑥ 死终态链:终态词典命中但仍有出转移", () => {
    const out = auditStateMachines([mkMachine({
      states: ["idle", "done"],
      transitions: [
        { from: "idle", to: "done", trigger: "finish", evidence: ev(2) },
        { from: "done", to: "idle", trigger: "reset", evidence: ev(3) },
      ],
    })]);
    expect(out.some((d) => d.kind === "dead-terminal" && d.detail.includes("done"))).toBe(true);
  });

  it("negative:xstate 形态不触发 ①②⑥(框架语义跳过),③ 幽灵转移仍生效", () => {
    const m = mkMachine({
      form: "xstate",
      states: ["idle", "unreachableX", "done"],
      transitions: [
        { from: "idle", to: "done", trigger: "go", evidence: ev(2) },
        { from: "idle", to: "ghostY", trigger: "err", evidence: ev(3) },
      ],
    });
    const out = auditStateMachines([m]);
    expect(out.some((d) => d.kind === "unreachable-state")).toBe(false);
    expect(out.some((d) => d.kind === "no-exit")).toBe(false);
    expect(out.some((d) => d.kind === "dead-terminal")).toBe(false);
    expect(out.some((d) => d.kind === "ghost-transition" && d.detail.includes("ghostY"))).toBe(true);
  });

  it("negative:redux-slice 无 transitions,零输出", () => {
    const m = mkMachine({
      form: "redux-slice", states: ["idle", "done"], transitions: [],
      redux: { stateFields: ["status"], actions: ["start"] },
    });
    expect(auditStateMachines([m])).toEqual([]);
  });

  it("negative:健康机器(idle→running→done)零缺陷", () => {
    expect(auditStateMachines([mkMachine({})])).toEqual([]);
  });

  it("渲染:mode=state 回执含附注段(投影层判定口径)", () => {
    const machines = [mkMachine({ states: ["idle", "running", "orphaned", "done"] })];
    const defects = auditStateMachines(machines);
    const text = renderStateMachines({ machines, statusHints: [], scannedFiles: 1, defects });
    expect(text).toContain("⚠ 状态机缺陷");
    expect(text).toContain("候选非定论");
    expect(text).toContain("unreachable-state");
 // 零缺陷时不产附注段
    const clean = renderStateMachines({ machines: [mkMachine({})], statusHints: [], scannedFiles: 1 });
    expect(clean).not.toContain("状态机缺陷");
  });
});
