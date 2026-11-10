import { describe, it, expect } from "vitest";
import { callchainMermaid } from "../src/callgraph/render";
import { renderForLlm } from "../src/llm";
import type { CodeSenseResult } from "../src/index";
import type { FlowEdge } from "../src/callgraph/engine";

function edge(p: Partial<FlowEdge>): FlowEdge {
  return {
    from: "a.ts#caller", to: "a.ts#callee", toName: "callee",
    file: "a.ts", line: 10, tier: "semantic", evidenceKind: "ast",
    ...p,
  };
}

describe("ZC-7 调用链关系图(面向人)", () => {
  it("圆心高亮/上下游方向/标签带 file:line", () => {
    const d = callchainMermaid({
      center: { name: "createGatewayApp", id: "apps/gateway/src/app.ts#createGatewayApp", file: "apps/gateway/src/app.ts", line: 57 },
      upstream: [edge({ from: "main.ts#boot", to: "apps/gateway/src/app.ts#createGatewayApp", toName: "createGatewayApp", line: 12 })],
      downstream: [edge({ from: "apps/gateway/src/app.ts#createGatewayApp", to: "apps/gateway/src/app.ts#ensureServer", toName: "ensureServer", line: 120 })],
    });
    expect(d.mermaid).toContain("flowchart TD");
    expect(d.mermaid).toContain('nd0["createGatewayApp<br/>gateway/src/app.ts:57"]');
    expect(d.mermaid).toContain("class nd0 ctr");
    // 下游边:圆心→ensureServer(L120);上游边:boot→圆心(L12)——方向=caller→callee
    expect(d.mermaid).toContain("nd0 -->|L120| nd1");
    expect(d.mermaid).toContain("nd2 -->|L12| nd0");
    expect(d.mermaid).toContain("classDef ctr");
    expect(d.nodeCount).toBe(3);
    expect(d.nodes.map((n) => n.name)).toContain("ensureServer");
    expect(d.truncated).toBe(false);
  });
  it("未解析目标=虚线节点,不冒充已解析", () => {
    const d = callchainMermaid({
      center: { name: "f", id: "a.ts#f", file: "a.ts", line: 1 },
      upstream: [],
      downstream: [edge({ from: "a.ts#f", to: "", toName: "dynamicHook", line: 5 })],
    });
    expect(d.mermaid).toContain("-.->");
    expect(d.mermaid).toContain('dynamicHook');
    expect(d.mermaid).toContain("classDef ext");
  });
  it("标签注入面封死(实体转义)+ 节点/边上限按近邻优先", () => {
    const downstream: FlowEdge[] = [];
    // 符号名带 HTML 特殊字符(id 尾段进标签)——必须实体转义
    for (let i = 0; i < 60; i++) downstream.push(edge({ from: "a.ts#f", to: `m${i}.ts#g<i>"${i}`, toName: `g${i}`, line: i + 1 }));
    const d = callchainMermaid({
      center: { name: "f", id: "a.ts#f", file: "a.ts", line: 1 },
      upstream: [],
      downstream,
    });
    expect(d.nodeCount).toBeLessThanOrEqual(34);
    expect(d.edgeCount).toBeLessThanOrEqual(48);
    expect(d.truncated).toBe(true);
    expect(d.mermaid).toContain("&lt;i&gt;&quot;");
    expect(d.mermaid).not.toContain("<i>\"");
  });
});

describe("ZC-8 LLM 增强信息文本(面向 LLM)", () => {
  const base: CodeSenseResult = {
    mode: "debug",
    projectState: "MATURE",
    callchain: {
      center: { name: "createGatewayApp", id: "a.ts#createGatewayApp", file: "apps/gateway/src/app.ts", line: 57 },
      upstream: [],
      downstream: [edge({ from: "a.ts#createGatewayApp", to: "a.ts#ensureServer", toName: "ensureServer", line: 120 })],
      mermaid: "flowchart TD",
      mermaidNodes: [{ id: "nd0", name: "createGatewayApp" }],
    },
    signatures: { createGatewayApp: { params: [{ name: "opts", type: "GatewayAppOptions" }], returnType: "GatewayApp" } },
    evidence: [],
    cache: { hit: false, builtAt: 0 },
    budget: { truncated: false, omittedCount: 0 },
  };
  it("debug 剖面:圆心(定义处)/签名/下游带 tier 与 file:line,引用与类型定义在文本,mermaid 源不进", () => {
    const rich: CodeSenseResult = {
      ...base,
      references: [{ file: "main.ts", line: 5, text: "createGatewayApp(opts)" }],
      referenceCount: 1,
      typeDefs: { GatewayAppOptions: { file: "apps/gateway/src/app.ts", line: 45 } },
    };
    const t = renderForLlm(rich);
    expect(t).toContain("[code_sense debug]");
    expect(t).toContain("圆心(定义处): createGatewayApp — apps/gateway/src/app.ts:57");
    expect(t).toContain("签名 createGatewayApp(opts: GatewayAppOptions) → GatewayApp");
    expect(t).toContain("→ ensureServer @ a.ts:120 [ast/semantic]");
    expect(t).toContain("类型定义:");
    expect(t).toContain("GatewayAppOptions → apps/gateway/src/app.ts:45");
    expect(t).toContain("全仓引用 1 处");
    expect(t).toContain("main.ts:5");
    expect(t).not.toContain("flowchart TD\n  nd0");
    expect(t).toContain("关系图 1 节点");
  });
  it("降级与预算裁剪如实呈现", () => {
    const t = renderForLlm({
      ...base,
      degraded: [{ layer: "archmap", reason: "未注入 archLlm", howToActivate: "setPlanDeps" }],
      budget: { truncated: true, omittedCount: 7 },
    } as CodeSenseResult);
    expect(t).toContain("[降级] archmap: 未注入 archLlm");
    expect(t).toContain("省略 7 条");
  });
  it("explore 剖面:matches 行带命中文本", () => {
    const t = renderForLlm({
      ...base,
      mode: "explore",
      callchain: undefined,
      matches: [{ file: "a.ts", line: 3, text: "export function alpha() {}" }],
    } as CodeSenseResult);
    expect(t).toContain("a.ts:3 export function alpha() {}");
    expect(t).not.toContain("圆心");
  });
});
