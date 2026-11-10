/**
 * 模块视图(2026-10-22 P1):分组规则 + 跨模块交互矩阵 + 枢纽/测试面分离 + mermaid。
 * 分组规则在 agent_alpha 上经 grep 逐边验证(根文件自成组;modules/ 摊二级)。
 */
import { describe, it, expect } from "vitest";
import { moduleGroupOf, buildModuleView, renderModuleView, mermaidModuleGraph } from "../src/callgraph/modview";
import type { C2fIndex, C2fNode, C2fEdge } from "../src/callgraph/c2f";

function mkIndex(nodes: [string, string][], edges: [string, string, number][]): C2fIndex {
  const ns: C2fNode[] = nodes.map(([file, name]) => ({
    id: `${file}#${name}`, name, file, line: 1, kind: "regular", outCount: 0, inCount: 0,
  }));
  const es: C2fEdge[] = edges.flatMap(([from, to, n]) =>
    Array.from({ length: n }, () => ({ from, to, toName: "", file: from.slice(0, from.lastIndexOf("#")), line: 1, kind: "call" as const })));
  const byFile: Record<string, string[]> = {};
  const byName: Record<string, string[]> = {};
  for (const n of ns) {
    (byFile[n.file] ??= []).push(n.id);
    (byName[n.name] ??= []).push(n.id);
  }
  return { version: 1, root: "/x", gitHead: "", builtAt: 0, buildMs: 0, nodes: ns, edges: es, byFile, byName };
}

describe("moduleGroupOf 分组规则", () => {
  it("根文件自成组;modules/tests/packages/apps/cmd/src/internal 摊二级;其余一级", () => {
    expect(moduleGroupOf("web_chat_server.py")).toBe("web_chat_server.py");
    expect(moduleGroupOf("modules/agent_modules_v2/core/x.py")).toBe("modules/agent_modules_v2");
    expect(moduleGroupOf("modules/omni/y.py")).toBe("modules/omni");
    expect(moduleGroupOf("tests/test_a.py")).toBe("tests"); // 测试=单一面不摊(实仓:tests/bak 等摊开会混进主干)
    expect(moduleGroupOf("tests/ws_api_e2e/c_code/x.c")).toBe("tests");
    expect(moduleGroupOf("modules/digital_human_service_async.py")).toBe("modules/digital_human_service_async.py"); // 散文件根语义
    expect(moduleGroupOf("packages/core/src/a.ts")).toBe("packages/core");
    expect(moduleGroupOf("cmd/foo/main.go")).toBe("cmd/foo");
    expect(moduleGroupOf("webrtc_server/worker.py")).toBe("webrtc_server");
  });
});

describe("buildModuleView 矩阵/枢纽/测试面", () => {
  it("跨组边聚合(A→B=调用方向);tests 单列不进主干;枢纽=被依赖最多", () => {
    const idx = mkIndex(
      [
        ["modules/core/eng.py", "run"], ["modules/core/eng.py", "helper"],
        ["modules/omni/rt.py", "on_event"], ["voice_interaction/vi.py", "loop"],
        ["web_chat_server.py", "chat"], ["tests/test_eng.py", "t1"], ["tests/test_eng2.py", "t2"],
      ],
      [
        ["modules/core/eng.py#run", "modules/core/eng.py#helper", 1], // 组内边不计
        ["modules/omni/rt.py#on_event", "modules/core/eng.py#run", 17],
        ["voice_interaction/vi.py#loop", "modules/core/eng.py#run", 26],
        ["web_chat_server.py#chat", "modules/core/eng.py#run", 9],
        ["tests/test_eng.py#t1", "modules/core/eng.py#run", 40],
        ["tests/test_eng2.py#t2", "modules/omni/rt.py#on_event", 3],
      ],
    );
    const v = buildModuleView(idx);
    expect(v.interactions.map((e) => `${e.from}→${e.to}:${e.count}`)).toEqual([
      "voice_interaction→modules/core:26",
      "modules/omni→modules/core:17",
      "web_chat_server.py→modules/core:9",
    ]);
    expect(v.hubs[0]).toMatchObject({ module: "modules/core", sourceModules: 3, inEdges: 52 });
    expect(v.testLinks[0]).toMatchObject({ module: "modules/core", edges: 40, testFiles: 1 });
    expect(v.testLinks[1]).toMatchObject({ module: "modules/omni", edges: 3 });
    // 模块清单含根文件组
    expect(v.modules.some((m) => m.name === "web_chat_server.py")).toBe(true);
  });

  it("渲染:清单/交互主干/枢纽/测试面四节;graph=true 出 mermaid 边标签", () => {
    const idx = mkIndex(
      [["modules/core/eng.py", "run"], ["web_chat_server.py", "chat"]],
      [["web_chat_server.py#chat", "modules/core/eng.py#run", 9]],
    );
    const text = renderModuleView(buildModuleView(idx));
    expect(text).toContain("模块视图");
    expect(text).toContain("交互主干");
    expect(text).toContain("web_chat_server.py → modules/core ×9");
    expect(text).toContain("枢纽");
    const g = renderModuleView(buildModuleView(idx), { graph: true });
    expect(g).toContain("graph LR");
    expect(g).toContain("-->|×9|");
    expect(mermaidModuleGraph(buildModuleView(idx))).toMatch(/m\d+\["/);
  });
});
