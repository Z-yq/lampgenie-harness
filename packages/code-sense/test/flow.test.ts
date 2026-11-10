/**
 * 整仓 code flow(2026-10-26):分层聚合(module/file/function)+ code2flow 语义
 * (root/trunk/leaf/regular、File/Class 分组、默认裁零连接、目标上下游子图、DOT/mermaid)。
 */
import { describe, it, expect } from "vitest";
import {
  buildCodeFlow, renderCodeFlowMermaid, renderCodeFlowDot, renderCodeFlowText, codeFlowJson, FlowTargetError,
  type FlowOptions,
} from "../src/callgraph/flow";
import type { C2fIndex, C2fEdge, C2fNode } from "../src/callgraph/c2f";

interface NodeSpec {
  id: string;
  file: string;
  name: string;
  line?: number;
  symKind?: C2fNode["symKind"];
  container?: string;
  tier?: C2fNode["tier"];
}

function mkIndex(nodes: NodeSpec[], edges: [string, string, number?][]): C2fIndex {
  const ns: C2fNode[] = nodes.map((n) => ({
    id: n.id,
    name: n.name,
    file: n.file,
    line: n.line ?? 1,
    kind: "regular",
    outCount: 0,
    inCount: 0,
    ...(n.symKind ? { symKind: n.symKind } : {}),
    ...(n.container ? { container: n.container } : {}),
    ...(n.tier ? { tier: n.tier } : {}),
  }));
  const es: C2fEdge[] = [];
  for (const [from, to, count] of edges) {
    for (let i = 0; i < (count ?? 1); i++) {
      es.push({ from, to, toName: to.slice(to.lastIndexOf("#") + 1), file: from.slice(0, from.lastIndexOf("#")), line: 1, kind: "import" });
    }
  }
  const byFile = Object.create(null) as Record<string, string[]>;
  const byName = Object.create(null) as Record<string, string[]>;
  for (const n of ns) {
    (byFile[n.file] ??= []).push(n.id);
    (byName[n.name] ??= []).push(n.id);
    const dot = n.name.lastIndexOf(".");
    if (dot > 0) (byName[n.name.slice(dot + 1)] ??= []).push(n.id);
  }
  return { version: 1, root: "/proj", gitHead: "", builtAt: 0, buildMs: 0, nodes: ns, edges: es, byFile, byName };
}

/** 一个小型多模块仓:
 *  apps/web/main.ts main → apps/gateway/server.ts handle → packages/core/store.ts Store.read
 *  server.ts 顶层(module-root)也调 handle;Store 是类容器;另有测试/任务脚本噪声边。
 */
const index = mkIndex(
  [
    { id: "apps/web/src/main.ts#main", file: "apps/web/src/main.ts", name: "main" },
    { id: "apps/web/src/app.ts#render", file: "apps/web/src/app.ts", name: "render" },
    { id: "apps/gateway/src/server.ts#handle", file: "apps/gateway/src/server.ts", name: "handle" },
    { id: "apps/gateway/src/server.ts#start", file: "apps/gateway/src/server.ts", name: "start" },
    { id: "packages/core/src/store.ts#Store", file: "packages/core/src/store.ts", name: "Store", symKind: "class" },
    { id: "packages/core/src/store.ts#Store.read", file: "packages/core/src/store.ts", name: "Store.read", container: "Store" },
    { id: "packages/core/src/store.ts#Store.constructor", file: "packages/core/src/store.ts", name: "Store.constructor", container: "Store" },
    { id: "packages/core/src/util.ts#noop", file: "packages/core/src/util.ts", name: "noop" },
    { id: "tests/gateway.test.ts#t", file: "tests/gateway.test.ts", name: "t" },
    { id: "tasks/probe.ts#p", file: "tasks/probe.ts", name: "p" },
  ],
  [
    ["apps/web/src/main.ts#main", "apps/gateway/src/server.ts#handle", 3],
    ["apps/gateway/src/server.ts#<module>", "apps/gateway/src/server.ts#start"],
    ["apps/gateway/src/server.ts#<module>", "packages/core/src/util.ts#noop"], // 组合根跨文件调用=入口证据
    ["apps/gateway/src/server.ts#start", "apps/gateway/src/server.ts#handle", 2],
    ["apps/gateway/src/server.ts#handle", "packages/core/src/store.ts#Store.read", 4],
    ["apps/gateway/src/server.ts#handle", "packages/core/src/store.ts#Store", 2], // new Store()
    ["tests/gateway.test.ts#t", "apps/gateway/src/server.ts#handle", 9],
    ["tasks/probe.ts#p", "apps/gateway/src/server.ts#handle", 7],
    ["packages/core/src/util.ts#noop", ""], // 未解析(外部调用)
  ],
);

const opts = (o: FlowOptions = {}): FlowOptions => ({ level: "module", processEntries: [], ...o });

describe("flow: module 层", () => {
  it("按目录聚合;测试/非产品路径默认排除;入口=模块级启动调用;trunk/leaf 分类", () => {
    const f = buildCodeFlow(index, opts());
    expect(f.level).toBe("module");
    expect(f.nodes.map((n) => n.label).sort()).toEqual(["apps/gateway", "apps/web", "packages/core"]);
    const web = f.nodes.find((n) => n.label === "apps/web")!;
    const gw = f.nodes.find((n) => n.label === "apps/gateway")!;
    const core = f.nodes.find((n) => n.label === "packages/core")!;
    expect(web.kind).toBe("trunk"); // 入度 0
    expect(core.kind).toBe("leaf"); // 出度 0
    // 新入口口径:被上层调用的库内组合根不算项目入口(gw 有 web→gw 入边);
    // 无入口时按零入度 trunk 兜底 → web 是流程起点。
    expect(web.entry).toBe(true);
    expect(web.entryKind).toBe("trunk");
    expect(gw.entry).toBe(false);
    expect(f.edges.map((e) => `${e.from}→${e.to}×${e.count}`).sort()).toEqual([
      "m:apps/gateway→m:packages/core×7",
      "m:apps/web→m:apps/gateway×3",
    ]);
    // 测试/任务边被排除
    expect(f.stats.sourceFiles).toBe(5);
    expect(f.nodes.some((n) => n.label.includes("tests"))).toBe(false);
  });

  it("模块作用注记:annotations 进 mermaid 节点斜体 + 文本段 + JSON", () => {
    const f = buildCodeFlow(index, opts());
    f.annotations = { "apps/web": "前端入口", "apps/gateway": "≈ 服务/API 与编排层" };
    const mmd = renderCodeFlowMermaid(f);
    expect(mmd).toContain("<i>前端入口</i>");
    expect(mmd).toContain("≈ 服务/API 与编排层");
    const text = renderCodeFlowText(f);
    expect(text).toContain("模块作用/角色");
    expect(text).toContain("apps/web — 前端入口");
    const j = codeFlowJson(f) as { annotations?: Record<string, string> };
    expect(j.annotations?.["apps/web"]).toBe("前端入口");
  });

  it("组合根=入口(跨文件模块级调用);被上层调用的库不算入口", () => {
    const idx2 = mkIndex(
      [
        { id: "apps/cli/src/main.ts#main", file: "apps/cli/src/main.ts", name: "main" },
        { id: "packages/lib/src/core.ts#run", file: "packages/lib/src/core.ts", name: "run" },
      ],
      [["apps/cli/src/main.ts#<module>", "packages/lib/src/core.ts#run"]],
    );
    const f = buildCodeFlow(idx2, opts());
    const cli = f.nodes.find((n) => n.label === "apps/cli")!;
    expect(cli.entry).toBe(true);
    expect(cli.entryKind).toBe("module-root");
    expect(f.nodes.find((n) => n.label === "packages/lib")!.entry).toBe(false);
  });

  it("includeTests/includeNonProduct 放开噪声路径", () => {
    const f = buildCodeFlow(index, opts({ includeTests: true, includeNonProduct: true }));
    expect(f.nodes.map((n) => n.label).sort()).toEqual(["apps/gateway", "apps/web", "packages/core", "tasks", "tests"]);
  });

  it("scope 收窄;include/exclude 正则", () => {
    const f = buildCodeFlow(index, opts({ scope: "apps/gateway" }));
    expect(f.nodes.map((n) => n.label)).toEqual(["apps/gateway"]);
    const g = buildCodeFlow(index, opts({ exclude: "^packages/" }));
    expect(g.nodes.map((n) => n.label).sort()).toEqual(["apps/gateway", "apps/web"]);
  });

  it("跨语言桥边以虚线边接入(module/file 层)", () => {
    const withBridge: C2fIndex = {
      ...index,
      bridge: {
        state: "bridge-connected",
        edges: [{
          kind: "bridge", bridge: "http-api", tier: "structural", evidence: "grep", match: "exact", confidence: "high",
          from: { side: "frontend", file: "apps/web/src/app.ts", line: 4, literal: "/api/users" },
          to: { side: "backend", file: "apps/gateway/src/server.ts", line: 9, method: "GET", path: "/api/users", framework: "express" },
        }],
      },
    };
    const f = buildCodeFlow(withBridge, opts());
    const bridge = f.edges.find((e) => e.bridge);
    expect(bridge?.label).toBe("HTTP GET /api/users");
    expect(f.stats.bridgeEdges).toBe(1);
    expect(renderCodeFlowMermaid(f)).toContain("-.->|HTTP GET /api/users|");
  });

  it("max-nodes 预算:入口优先,省略数如实统计", () => {
    const f = buildCodeFlow(index, opts({ maxNodes: 2 }));
    expect(f.nodes.length).toBeLessThanOrEqual(2);
    expect(f.nodes.some((n) => n.label === "apps/gateway")).toBe(true); // 入口必留
    expect(f.stats.nodesOmitted).toBeGreaterThan(0);
    expect(f.stats.truncated).toBe(true);
  });
});

describe("flow: file / function 层", () => {
  it("file 层:节点=文件,分组=模块组;真正入口=零入度 main.ts,被调用的 server.ts 不算", () => {
    const f = buildCodeFlow(index, opts({ level: "file" }));
    expect(f.nodes.some((n) => n.label.endsWith("main.ts") && n.entry)).toBe(true);
    expect(f.nodes.some((n) => n.label.endsWith("server.ts") && n.entry)).toBe(false);
    expect(f.nodes.some((n) => n.label.endsWith("server.ts"))).toBe(true);
    // 同文件 start→handle 是内部调用,不画跨文件边
    expect(f.stats.internalCalls).toBeGreaterThan(0);
    const groups = f.groups.map((g) => g.label).sort();
    expect(groups).toContain("apps/gateway");
  });

  it("function 层:合成 <module> root 节点;File/Class 分组;new Class() 落到构造器", () => {
    const f = buildCodeFlow(index, opts({ level: "function" }));
    const root = f.nodes.find((n) => n.label === "<module>");
    expect(root?.entry).toBe(true);
    expect(f.nodes.some((n) => n.label === "handle")).toBe(true);
    const groups = f.groups.map((g) => g.label);
    expect(groups).toContain("File: apps/gateway/src/server.ts");
    expect(groups).toContain("Class: Store");
    const ctor = f.nodes.find((n) => n.label === "Store.constructor");
    expect(ctor).toBeTruthy();
    // handle → Store.constructor(new Store) ×2
    expect(f.edges.some((e) => e.to === "s:packages/core/src/store.ts#Store.constructor" && e.count === 2)).toBe(true);
    // 类节点本身不入图
    expect(f.nodes.some((n) => n.label === "Store")).toBe(false);
  });

  it("测试里的测试函数默认不入 function 层图;--include-tests 放开", () => {
    const f = buildCodeFlow(index, opts({ level: "function" }));
    expect(f.nodes.some((n) => n.label === "t")).toBe(false);
    const g = buildCodeFlow(index, opts({ level: "function", includeTests: true }));
    expect(g.nodes.some((n) => n.label === "t")).toBe(true);
  });

  it("进程入口调用被标为 entry(main)", () => {
    const f = buildCodeFlow(index, opts({
      level: "function",
      processEntries: [{ kind: "js-bin", lang: "js", file: "apps/web/src/main.ts", line: 1, label: "bin 守卫@1", calls: ["main"] }],
    }));
    const main = f.nodes.find((n) => n.label === "main")!;
    expect(main.entry).toBe(true);
    expect(main.entryKind).toBe("process");
  });

  it("auto 层:模块≥6 走 module,否则按文件/函数", () => {
    expect(buildCodeFlow(index, { level: "auto", processEntries: [] }).level).toBe("function");
    const many = mkIndex(
      Array.from({ length: 7 }, (_, i) => ({ id: `mod${i}/a.ts#f${i}`, file: `mod${i}/a.ts`, name: `f${i}` })),
      Array.from({ length: 6 }, (_, i) => [`mod${i}/a.ts#f${i}`, `mod${i + 1}/a.ts#f${i + 1}`] as [string, string]),
    );
    expect(buildCodeFlow(many, { level: "auto", processEntries: [] }).level).toBe("module");
  });
});

describe("flow: 目标子图 / 裁剪 / 渲染", () => {
  it("target + upstream/downstream 只保留子图,center 标记", () => {
    const f = buildCodeFlow(index, opts({ level: "function", target: "handle", upstream: 1, downstream: 1 }));
    expect(f.center).toBe("s:apps/gateway/src/server.ts#handle");
    const labels = f.nodes.map((n) => n.label);
    expect(labels).toContain("handle");
    expect(labels).toContain("main"); // 上游 1 跳
    expect(labels).toContain("Store.read"); // 下游 1 跳
    expect(labels).not.toContain("render");
  });

  it("目标不存在抛 FlowTargetError 并给候选", () => {
    try {
      buildCodeFlow(index, opts({ level: "function", target: "zzz" }));
      throw new Error("应该抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(FlowTargetError);
      expect((err as FlowTargetError).candidates.length).toBeGreaterThan(0);
    }
  });

  it("零连接节点默认裁掉;--keep-isolated 保留并标 isolated", () => {
    const f = buildCodeFlow(index, opts({ level: "function" }));
    expect(f.nodes.some((n) => n.label === "render")).toBe(false); // 无调用边
    expect(f.stats.isolatedDropped).toBeGreaterThan(0);
    const g = buildCodeFlow(index, opts({ level: "function", keepIsolated: true }));
    expect(g.nodes.some((n) => n.label === "render")).toBe(true);
    expect(g.nodes.find((n) => n.label === "render")!.kind).toBe("isolated");
  });

  it("mermaid:分组子图/三色 classDef/边着色/linkStyle/入口描边/图例语法", () => {
    const f = buildCodeFlow(index, opts({ level: "function" }));
    const m = renderCodeFlowMermaid(f);
    expect(m.startsWith("flowchart LR")).toBe(true);
    expect(m).toContain('subgraph g');
    expect(m).toContain("classDef fTrunk");
    expect(m).toContain("classDef fLeaf");
    expect(m).toContain("linkStyle");
    expect(m).toContain("stroke:#ffd27f");
    expect(m).toContain('lg0["▼ 入口/trunk(无人调用)"]');
    expect(m).not.toContain('["lg0"]');
    expect(m).toContain("-->|×");
  });

  it("DOT:rankdir/cluster/三色节点/边标签;桥边 dashed", () => {
    const withBridge: C2fIndex = {
      ...index,
      bridge: {
        state: "bridge-connected",
        edges: [{
          kind: "bridge", bridge: "http-api", tier: "structural", evidence: "grep", match: "exact", confidence: "high",
          from: { side: "frontend", file: "apps/web/src/app.ts", line: 4, literal: "/api/users" },
          to: { side: "backend", file: "apps/gateway/src/server.ts", line: 9, method: "GET", path: "/api/users", framework: "express" },
        }],
      },
    };
    const dot = renderCodeFlowDot(buildCodeFlow(withBridge, opts({ level: "file" })));
    expect(dot.startsWith("digraph code_flow {")).toBe(true);
    expect(dot).toContain('rankdir="LR"');
    expect(dot).toContain("subgraph cluster_g");
    expect(dot).toContain('fillcolor="#966F33"');
    expect(dot).toContain('label="×');
    expect(dot).toContain('style="dashed"');
  });

  it("文本面:入口/主干路径/主要流/分层/枢纽/口径", () => {
    const text = renderCodeFlowText(buildCodeFlow(index, opts({ level: "module" })));
    expect(text).toContain("整仓代码流 · 模块级");
    expect(text).toContain("入口(流程起点)");
    expect(text).toContain("主干路径");
    expect(text).toContain("分层");
    expect(text).toContain("口径");
  });

  it("JSON 面字段完整", () => {
    const j = codeFlowJson(buildCodeFlow(index, opts({ level: "module" }))) as Record<string, unknown>;
    expect(j.level).toBe("module");
    expect(Array.isArray(j.nodes)).toBe(true);
    expect(Array.isArray(j.edges)).toBe(true);
    expect((j.stats as Record<string, unknown>).nodesShown).toBeTypeOf("number");
    expect(Array.isArray(j.entries)).toBe(true);
  });
});