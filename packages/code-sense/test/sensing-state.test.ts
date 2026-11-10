/**
 * sensing/statemachines 测试(step-077 P2):
 * F1 TRANSITIONS 字面量表(含金标准形态)/ F2 switch+联合类型双条件收敛(单条件进 candidates)/
 * F3 状态模式类族 / F4 XState createMachine / F5 Redux createSlice(弱化产物,不出图)/
 * statusHints 词法提示区 / 反例零误报 / codeSense mode=state e2e / mermaid 形态校验。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractStateMachinesFromFile, queryStateMachines, renderStateMachines, codeSense } from "@lampgenie/code-sense";

const F1 = `const TRANSITIONS: Readonly<Record<TaskState, ReadonlySet<TaskState>>> = {
  queued:    new Set(["running", "done", "failed", "cancelled"]),
  running:   new Set(["blocked", "done", "failed", "cancelled"]),
  blocked:   new Set(["running", "cancelled"]),
  done:      new Set(),
  failed:    new Set(),
  cancelled: new Set(),
};
`;

const F2 = `type GateState = "idle" | "loading" | "ready" | "failed";

export class Gate {
  private state: GateState = "idle";

  dispatch(action: string): void {
    switch (this.state) {
      case "idle":
        if (action === "load") this.state = "loading";
        break;
      case "loading":
        if (action === "ok") this.state = "ready";
        else this.state = "failed";
        break;
      case "ready":
        if (action === "reset") this.state = "idle";
        break;
    }
  }
}
`;

const F2_CANDIDATE_ONLY = `export class Foo {
  private level = 1;
  bump(): void {
    // 无状态集声明、无 switch/if 上下文——单条件赋值只进 candidates
    this.score = "high";
  }
}
`;

const F3 = `abstract class OrderState {
  abstract pay(ctx: OrderContext): void;
}

class PendingState extends OrderState {
  pay(ctx: OrderContext): void {
    ctx.setState(new PaidState());
  }
}

class PaidState extends OrderState {
  pay(ctx: OrderContext): void {
    throw new Error("already paid");
  }
  ship(ctx: OrderContext): void {
    ctx.setState(new ShippedState());
  }
}

class ShippedState extends OrderState {
  pay(ctx: OrderContext): void {}
}
`;

const F4 = `import { createMachine } from "xstate";

export const toggleMachine = createMachine({
  id: "toggle",
  initial: "inactive",
  states: {
    inactive: {
      on: { TOGGLE: "active" },
    },
    active: {
      on: { TOGGLE: "inactive", RESET: { target: "inactive" } },
    },
  },
});
`;

const F5 = `import { createSlice } from "@reduxjs/toolkit";

export const counterSlice = createSlice({
  name: "counter",
  initialState: {
    value: 0,
    status: "idle",
  },
  reducers: {
    increment: (state) => { state.value += 1; },
    setStatus: (state, action) => { state.status = action.payload; },
  },
});
`;

const STATUS_HINT = `async function markPaid(order) {
  order.status = "paid";
  await repo.update(order.id, { status: "paid" });
}
`;

const PLAIN = `export function add(a: number, b: number): number { return a + b; }
`;

describe("statemachines 五形态", () => {
  it("F1:TRANSITIONS 字面量表(金标准形态)", () => {
    const ms = extractStateMachinesFromFile("task.ts", F1);
    expect(ms.length).toBe(1);
    expect(ms[0]!.form).toBe("transitions-table");
    expect(ms[0]!.states.sort()).toEqual(["blocked", "cancelled", "done", "failed", "queued", "running"]);
    expect(ms[0]!.transitions).toContainEqual({ from: "queued", to: "running", evidence: { file: "task.ts", line: 2 } });
    expect(ms[0]!.mermaid).toContain("stateDiagram-v2");
    expect(ms[0]!.mermaid).toContain("queued --> running");
  });

  it("F2:switch+联合类型双条件收敛;case 上下文为 from", () => {
    const ms = extractStateMachinesFromFile("gate.ts", F2);
    expect(ms.length).toBe(1);
    const m = ms[0]!;
    expect(m.form).toBe("switch");
    expect(m.states.sort()).toEqual(["failed", "idle", "loading", "ready"]);
    const flat = m.transitions.map((t) => `${t.from}->${t.to}`);
    expect(flat).toContain("idle->loading");
    expect(flat).toContain("loading->ready");
    expect(flat).toContain("loading->failed");
    expect(flat).toContain("ready->idle");
  });

  it("F2 反例:无状态声明无上下文的裸赋值 → 不进 transitions(进 candidates)", () => {
    const ms = extractStateMachinesFromFile("foo.ts", F2_CANDIDATE_ONLY);
    expect(ms).toEqual([]); // 零转移不产机
  });

  it("F3:状态模式类族(多类 extends 同基类 + setState(new X()))", () => {
    const ms = extractStateMachinesFromFile("order.ts", F3);
    expect(ms.length).toBe(1);
    expect(ms[0]!.form).toBe("state-pattern");
    expect(ms[0]!.states).toEqual(["PendingState", "PaidState", "ShippedState"]);
    const flat = ms[0]!.transitions.map((t) => `${t.from}->${t.to}`);
    expect(flat).toContain("PendingState->PaidState");
    expect(flat).toContain("PaidState->ShippedState");
  });

  it("F4:XState createMachine(states/on/target 两形态)", () => {
    const ms = extractStateMachinesFromFile("toggle.ts", F4);
    expect(ms.length).toBe(1);
    const m = ms[0]!;
    expect(m.form).toBe("xstate");
    expect(m.states.sort()).toEqual(["active", "inactive"]);
    const flat = m.transitions.map((t) => `${t.from}-${t.trigger}->${t.to}`);
    expect(flat).toContain("inactive-TOGGLE->active");
    expect(flat).toContain("active-TOGGLE->inactive");
    expect(flat).toContain("active-RESET->inactive");
  });

  it("F5:Redux createSlice=弱化产物(字段+动作清单,不出状态机图)", () => {
    const ms = extractStateMachinesFromFile("counter.ts", F5);
    expect(ms.length).toBe(1);
    const m = ms[0]!;
    expect(m.form).toBe("redux-slice");
    expect(m.redux?.stateFields.sort()).toEqual(["status", "value"]);
    expect(m.redux?.actions.sort()).toEqual(["increment", "setStatus"]);
    expect(m.transitions).toEqual([]);
    expect(m.mermaid).toBe(""); // 不冒充状态机
  });

  it("F5 回归(2026-10-22 P0):多行 reducer 签名/单行箭头混排时动作全召回,参数行不冒充动作", () => {
    const src = [
      "export const globalSlice = createSlice({",
      '  name: "global",',
      "  initialState: {",
      "    connected: false,",
      "    agentState: \"idle\",",
      "  },",
      "  reducers: {",
      "    addChatItem: (",
      "      state,",
      "      action: PayloadAction<Partial<IOptions>>",
      "    ) => {",
      "      state.connected = true;",
      "    },",
      "    setOptions: (state, action: PayloadAction<Partial<IOptions>>) => {",
      "      Object.assign(state, action.payload);",
      "    },",
      "    setConnected: (state, action: PayloadAction<boolean>) => {",
      "      state.connected = action.payload;",
      "    },",
      "    startNewSession: (state) => {",
      "      state.agentState = \"idle\";",
      "    },",
      "    reset: (state) => {",
      "      state.connected = false;",
      "    },",
      "  },",
      "});",
    ].join("\n");
    const ms = extractStateMachinesFromFile("global.ts", src);
    expect(ms.length).toBe(1);
    const red = ms[0]!.redux!;
    expect(red.actions.sort()).toEqual(["addChatItem", "reset", "setConnected", "setOptions", "startNewSession"]);
    expect(red.actions).not.toContain("action");
    expect(red.actions).not.toContain("state");
    expect(red.stateFields.sort()).toEqual(["agentState", "connected"]);
  });

  it("反例:无状态机文件零产出", () => {
    expect(extractStateMachinesFromFile("util.ts", PLAIN)).toEqual([]);
  });

  it("F1 名称守卫:非状态机语义的 Set 映射静默跳过(vendor 误报实锤形态)", () => {
    const vendorForm = `export const TYPE_MAP = {
  stepEvents: new Set(["assistant/attempt"]),
  typing: new Set(["Protocol"]),
};
`;
    expect(extractStateMachinesFromFile("vendor/x/tools/py-types.ts", vendorForm)).toEqual([]);
  });
});

// ============================ 非产品路径过滤(P1-1,2026-10-20) ============================

describe("queryStateMachines 非产品路径过滤(.md 文档示例不是状态机)", () => {
  // ts-xstate 实锤形态:docs/migration.md 里的 xstate 示例被算成状态机
  // (文档正文用 F4 的 createMachine 形态——提取器按内容认形态,不看扩展名)
  const DOC_MACHINE = `# 迁移指南

旧版本的状态机写法:

\`\`\`ts
import { createMachine } from "xstate";

export const docMachine = createMachine({
  id: "doc",
  initial: "inactive",
  states: {
    inactive: {
      on: { TOGGLE: "active" },
    },
    active: {
      on: { TOGGLE: "inactive" },
    },
  },
});
\`\`\`
`;

  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cssense-statefilter-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "docs"), { recursive: true });
    mkdirSync(join(dir, "examples"), { recursive: true });
    writeFileSync(join(dir, "src", "toggle.ts"), F4);
    writeFileSync(join(dir, "docs", "migration.md"), DOC_MACHINE);
    writeFileSync(join(dir, "examples", "demo.ts"), F1);
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it("docs/*.md 与 examples/ 被过滤 + pathFilter 呈报 + render 注记;all=true 重新出现", async () => {
    const r = await queryStateMachines(dir, { refresh: true });
    // ① 过滤生效:只剩产品路径的 toggle(文档 .md 与 examples/ 的都不算)
    expect(r.machines.map((m) => m.file)).toEqual(["src/toggle.ts"]);
    expect(r.machines.every((m) => !m.file.startsWith("docs/") && !m.file.startsWith("examples/"))).toBe(true);
    // ② 诚实呈报
    expect(r.pathFilter).toBeTruthy();
    expect(r.pathFilter!.filtered).toBeGreaterThan(0);
    expect(r.pathFilter!.note).toContain("已过滤");
    expect(renderStateMachines(r).split("\n")[1]).toContain("[路径过滤]");
    // ③ 逃生口
    const all = await queryStateMachines(dir, { refresh: true, all: true });
    expect(all.machines.some((m) => m.file === "docs/migration.md")).toBe(true);
    expect(all.machines.some((m) => m.file === "examples/demo.ts")).toBe(true);
    expect(all.pathFilter).toBeUndefined();
  });

  it("过滤后清零不静默:只剩 docs/ 状态机时 pathFilter 仍在", async () => {
    const only = mkdtempSync(join(tmpdir(), "cssense-statefilter-only-"));
    mkdirSync(join(only, "docs"), { recursive: true });
    writeFileSync(join(only, "docs", "migration.md"), DOC_MACHINE);
    try {
      const r = await queryStateMachines(only, { refresh: true });
      expect(r.machines).toEqual([]);
      expect(r.pathFilter?.filtered).toBeGreaterThan(0);
      expect(r.pathFilter?.note).toContain("已过滤");
      expect(renderStateMachines(r)).toContain("[路径过滤]");
    } finally {
      rmSync(only, { recursive: true, force: true });
    }
  });
});

describe("queryStateMachines 仓级 + codeSense mode=state", () => {
  let ws = "";
  beforeAll(() => {
    ws = mkdtempSync(join(tmpdir(), "cssense-state-"));
    mkdirSync(join(ws, "src"), { recursive: true });
    writeFileSync(join(ws, "src", "task.ts"), F1);
    writeFileSync(join(ws, "src", "gate.ts"), F2);
    writeFileSync(join(ws, "src", "order.ts"), F3);
    writeFileSync(join(ws, "src", "toggle.ts"), F4);
    writeFileSync(join(ws, "src", "counter.ts"), F5);
    writeFileSync(join(ws, "src", "repo.ts"), STATUS_HINT);
    writeFileSync(join(ws, "src", "util.ts"), PLAIN);
  });
  afterAll(() => { rmSync(ws, { recursive: true, force: true }); });

  it("仓级五形态聚合 + statusHints 词法提示区", async () => {
    const r = await queryStateMachines(ws, { refresh: true });
    const forms = r.machines.map((m) => m.form).sort();
    expect(forms).toEqual(["redux-slice", "state-pattern", "switch", "transitions-table", "xstate"]);
    expect(r.statusHints.length).toBeGreaterThanOrEqual(2);
    // gate.ts 的 this.state="loading" 与 repo.ts 的 order.status="paid" 都是词法命中;
    // 关键是 DB status 写点(repo.ts)在提示区在场
    expect(r.statusHints.some((h) => h.file === "src/repo.ts" && h.text.includes("status"))).toBe(true);
  });

  it("codeSense mode=state:auto 关键词判定 + 证据行在场", async () => {
    const r = await codeSense(ws, "状态机有哪些", {});
    expect(r.mode).toBe("state");
    expect(r.state?.machines.length).toBe(5);
    expect(r.evidence.length).toBeGreaterThan(0);
    // mermaid 全形态可解析性(基础形态校验:stateDiagram-v2 头+箭头行)
    for (const m of r.state!.machines) {
      if (m.form === "redux-slice") continue;
      expect(m.mermaid.startsWith("stateDiagram-v2")).toBe(true);
      expect(m.mermaid).toMatch(/-->/);
    }
  });

  it("反例:无状态机仓显式降级", async () => {
    const empty = mkdtempSync(join(tmpdir(), "cssense-state-empty-"));
    mkdirSync(join(empty, "src"), { recursive: true });
    writeFileSync(join(empty, "src", "util.ts"), PLAIN);
    const r = await codeSense(empty, "状态机", {});
    expect(r.state?.machines).toEqual([]);
    expect(r.degraded?.some((d) => d.layer === "sensing-state")).toBe(true);
    rmSync(empty, { recursive: true, force: true });
  });
});
