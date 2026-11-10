/**
 * 工具面即 SDK(PTC/代码模式)run_code 工具级单测。
 * 覆盖:串行多工具链(结果/calls/journal 三账一致)、未知工具、maxCalls、
 * 子调用超时不污染后续、权限 predicate 拒绝且目标未执行、输出截断、沙箱越界、并发排队、签名清单。
 */
import { describe, it, expect } from "vitest";
import type { Tool } from "@lampgenie/runtime/agent/loop";
import {
  createCodeModeTool,
  buildSignatureList,
  toolSignature,
  type CodeModeLimits,
  type CodeModePermission,
  type CodeModeSubExecutor,
} from "../src/code-mode-tool.js";

interface RunCodeResult {
  ok: boolean;
  result?: string;
  truncated?: boolean;
  code?: string;
  error?: string;
  errorName?: string;
  calls: Array<{ tool: string; argsHash: string; durationMs: number; ok: boolean; error?: string }>;
  logs: string[];
}

function mkTool(name: string, execute: (args: unknown) => unknown, parameters?: Record<string, unknown>): Tool {
  return {
    name,
    description: name,
    parameters: parameters ?? { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    async execute(args: unknown) {
      return String(await execute(args));
    },
  } as Tool;
}

interface HarnessOpts {
  executeSub?: CodeModeSubExecutor;
  permission?: CodeModePermission;
  limits?: CodeModeLimits;
}

function harness(tools: Tool[], opts: HarnessOpts = {}) {
  const events: Array<Record<string, unknown>> = [];
  const executeSub: CodeModeSubExecutor =
    opts.executeSub ??
    (async (name, args) => {
      const target = tools.find((t) => t.name === name);
      if (!target) throw new Error(`未知工具:${name}`);
      return target.execute(args);
    });
  const tool = createCodeModeTool({
    tools,
    executeSub,
    journal: {
      append(event) {
        events.push(event.payload);
        return event;
      },
    },
    sessionId: "s-test",
    taskId: "t-test",
    ...(opts.permission ? { permission: opts.permission } : {}),
    ...(opts.limits ? { limits: opts.limits } : {}),
  });
  return { tool, events };
}

async function run(tool: Tool, code: string): Promise<RunCodeResult> {
  return JSON.parse(String(await tool.execute({ code }))) as RunCodeResult;
}

describe(" run_code 代码模式", () => {
  it("两个工具串行调用 → result 正确、calls 2 条、journal code.mode.call 2 条", async () => {
    const tools = [
      mkTool("add", (a) => {
        const x = a as { a: number; b: number };
        return x.a + x.b;
      }, { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }),
      mkTool("upper", (a) => {
        const x = a as { text: string };
        return x.text.toUpperCase();
      }, { type: "object", properties: { text: { type: "string" } }, required: ["text"] }),
    ];
    const { tool, events } = harness(tools);
    const out = await run(
      tool,
      [
        'const sum = await tools.add({a: 2, b: 3});',
        'const up = await tools.upper({text: "ab"});',
        "return sum + \":\" + up;",
      ].join("\n"),
    );
    expect(out.ok).toBe(true);
    expect(out.result).toBe("5:AB");
    expect(out.calls).toHaveLength(2);
    expect(out.calls.map((c) => c.tool)).toEqual(["add", "upper"]);
    const ledger = events.filter((e) => e.type === "code.mode.call");
    expect(ledger).toHaveLength(2);
    expect(ledger.every((e) => e.codeMode === true)).toBe(true);
    expect(ledger.map((e) => e.tool)).toEqual(["add", "upper"]);
    expect(ledger.every((e) => typeof e.argsHash === "string" && (e.argsHash as string).length === 12)).toBe(true);
  });

  it("未知工具 → UNKNOWN_TOOL 且不抛", async () => {
    const { tool } = harness([mkTool("add", () => "1")]);
    const out = await run(tool, 'const r = await tools.nope({}); return JSON.stringify(r);');
    expect(out.ok).toBe(true);
    expect(out.result).toContain("UNKNOWN_TOOL");
    expect(out.calls).toHaveLength(0);
  });

  it("41 次调用 → 第 41 次 CODE_LIMIT_CALLS", async () => {
    const { tool } = harness([mkTool("echo", (a) => `v${(a as { i: number }).i}`)], { limits: { maxCalls: 40 } });
    const out = await run(
      tool,
      [
        "const answers = [];",
        "for (let i = 0; i < 41; i += 1) { answers.push(await tools.echo({i})); }",
        'return JSON.stringify({ first: answers[0], last: answers[40], count: answers.length });',
      ].join("\n"),
    );
    expect(out.ok).toBe(true);
    const parsed = JSON.parse(out.result!) as { first: string; last: { error?: string }; count: number };
    expect(parsed.count).toBe(41);
    expect(parsed.first).toBe("v0");
    expect(parsed.last.error).toBe("CODE_LIMIT_CALLS");
    expect(out.calls).toHaveLength(40);
    expect(out.calls.filter((c) => c.error === "CODE_LIMIT_CALLS")).toHaveLength(0);
  });

  it("子调用超时 → error CODE_TIMEOUT,后续调用不受影响", async () => {
    const tools = [mkTool("slow", () => "late"), mkTool("fast", () => "ok")];
    const { tool } = harness(tools, {
      limits: { perCallTimeoutMs: 30, totalTimeoutMs: 5_000 },
      executeSub: async (name) => {
        if (name === "slow") return new Promise<string>((resolve) => setTimeout(() => resolve("late"), 200));
        return "ok";
      },
    });
    const out = await run(
      tool,
      [
        "const a = await tools.slow({});",
        "const b = await tools.fast({});",
        "return JSON.stringify({ a, b });",
      ].join("\n"),
    );
    expect(out.ok).toBe(true);
    const parsed = JSON.parse(out.result!) as { a: { error?: string }; b: string };
    expect(parsed.a.error).toBe("CODE_TIMEOUT");
    expect(parsed.b).toBe("ok");
    expect(out.calls.map((c) => c.error ?? "ok")).toEqual(["CODE_TIMEOUT", "ok"]);
  });

  it("权限 predicate 拒 → PERMISSION_DENIED 且目标 execute 未执行", async () => {
    let executed = 0;
    const tools = [mkTool("secret", () => {
      executed += 1;
      return "secret-value";
    })];
    const { tool, events } = harness(tools, {
      permission: (name) => (name === "secret" ? { allow: false, reason: "测试拒绝" } : true),
    });
    const out = await run(tool, 'const r = await tools.secret({}); return JSON.stringify(r);');
    expect(out.ok).toBe(true);
    expect(out.result).toContain("PERMISSION_DENIED");
    expect(out.result).toContain("测试拒绝");
    expect(executed).toBe(0);
    expect(out.calls[0]!.error).toBe("PERMISSION_DENIED");
    const ledger = events.filter((e) => e.type === "code.mode.call");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.ok).toBe(false);
    expect(ledger[0]!.error).toBe("PERMISSION_DENIED");
  });

  it("输出 30k → 截断 + CODE_OUTPUT_TRUNCATED 标记", async () => {
    const tools = [mkTool("big", () => "x".repeat(30_000))];
    const { tool } = harness(tools);
    const out = await run(tool, "return await tools.big({});");
    expect(out.ok).toBe(true);
    expect(out.truncated).toBe(true);
    expect(out.code).toBe("CODE_OUTPUT_TRUNCATED");
    expect(out.result!.length).toBeLessThan(30_000);
    expect(out.result!).toContain("结果已截断");
  });

  it("沙箱:require/process/fetch 访问 → ReferenceError 进 ok:false", async () => {
    const { tool } = harness([mkTool("noop", () => "ok")]);
    for (const expr of ['require("fs")', "process.env", "fetch(\"http://x\")"]) {
      const out = await run(tool, `return ${expr};`);
      expect(out.ok).toBe(false);
      expect(out.errorName).toBe("ReferenceError");
      expect(String(out.error)).toMatch(/is not defined/);
    }
  });

  it("并发>3 的调用排队后全部完成(不丢)", async () => {
    const tools = [mkTool("t", (a) => `t${(a as { i: number }).i}`)];
    let active = 0;
    let maxActive = 0;
    const { tool } = harness(tools, {
      limits: { concurrency: 3 },
      executeSub: async (name, args) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 40));
        active -= 1;
        return `t${(args as { i: number }).i}`;
      },
    });
    const out = await run(
      tool,
      [
        "const rs = await Promise.all([0,1,2,3,4,5].map((i) => tools.t({i})));",
        'return rs.join(",");',
      ].join("\n"),
    );
    expect(out.ok).toBe(true);
    expect(out.result).toBe("t0,t1,t2,t3,t4,t5");
    expect(out.calls).toHaveLength(6);
    expect(out.calls.every((c) => c.ok)).toBe(true);
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("签名清单含工具名与必填参数", () => {
    const tools = [
      mkTool("add", () => 0, {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" }, note: { type: "string" } },
        required: ["a", "b"],
      }),
      mkTool("upper", () => "", { type: "object", properties: { text: { type: "string" } }, required: ["text"] }),
    ];
    const sig = toolSignature(tools[0]!);
    expect(sig).toBe("add(a:number, b:number, note?:string)");
    const list = buildSignatureList(tools);
    expect(list).toContain('add(a:number, b:number, note?:string)');
    expect(list).toContain("upper(text:string)");
    const { tool } = harness(tools);
    expect(tool.name).toBe("run_code");
    expect(tool.description).toContain("add(a:number, b:number, note?:string)");
    expect(tool.description).toContain("upper(text:string)");
    // run_code 自身不进 SDK 清单(禁递归)。
    expect(tool.description).not.toContain("run_code(");
  });
});
