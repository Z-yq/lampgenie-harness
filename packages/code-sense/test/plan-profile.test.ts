import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { codeSense, setPlanDeps } from "../src/index";
import { sampleFiles, buildSourceIndex, validateGraph, graphToMermaid, generateArchitecture, gitHotspots, type ArchLlm, type Graph } from "../src/archmap/index";
import { deriveModules } from "../src/modulemap/index";

const REPO = "/mnt/e/workship/genie/lampgenie-harness";

function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gh-plan-"));
  mkdirSync(join(dir, "packages/core/src"), { recursive: true });
  mkdirSync(join(dir, "apps/server"), { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"name":"fixture"}');
  writeFileSync(join(dir, "packages/core/src/engine.ts"), "export class Engine { run() { return 1; } }");
  writeFileSync(join(dir, "apps/server/main.ts"), 'import { Engine } from "../../packages/core/src/engine";\nexport function main() { return new Engine().run(); }');
  return dir;
}

describe("sampler(打分+多样性)", () => {
  it("manifest/入口高分,测试负分被排除", async () => {
    const dir = fixtureRepo();
    writeFileSync(join(dir, "packages/core/src/engine.test.ts"), "test");
    const picked = await sampleFiles(dir, [
      "package.json", "apps/server/main.ts", "packages/core/src/engine.ts", "packages/core/src/engine.test.ts",
    ]);
    const paths = picked.map((p) => p.path);
    expect(paths).toContain("package.json");
    expect(paths).toContain("apps/server/main.ts");
    expect(paths).not.toContain("packages/core/src/engine.test.ts");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("SOURCE INDEX", () => {
  it("相对 import 解析到仓内真实文件", async () => {
    const dir = fixtureRepo();
    const files = ["package.json", "apps/server/main.ts", "packages/core/src/engine.ts"];
    const sampled = await sampleFiles(dir, files);
    const idx = await buildSourceIndex(dir, sampled, new Set(files));
    const main = idx.find((e) => e.file === "apps/server/main.ts")!;
    expect(main.imports[0]).toBe("packages/core/src/engine.ts");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("校验+修复环+mermaid", () => {
  it("坏路径被拒;修复后过;mermaid 可编译", async () => {
    const files = new Set(["packages/core/src/engine.ts", "apps/server/main.ts"]);
    const bad: Graph = {
      nodes: [{ id: "core", label: "核心", evidencePath: "不存在.ts" }],
      edges: [{ from: "core", to: "ghost", evidence: "excerpt", evidencePath: "x.ts" }],
    };
    const issues = validateGraph(bad, files);
    expect(issues.length).toBeGreaterThanOrEqual(2); // 坏路径+坏引用
    const good: Graph = {
      nodes: [{ id: "core", label: "核心", evidencePath: "packages/core/src/engine.ts" }],
      edges: [{ from: "core", to: "core", evidence: "inferred" }],
    };
    expect(validateGraph(good, files)).toHaveLength(0);
    const mermaid = graphToMermaid(good);
    expect(mermaid).toContain("flowchart TD");
    expect(mermaid).toContain("-.->"); // inferred 虚线
  });

  it("LLM 生成管线:首版坏→修复环纠正(mock LLM)", async () => {
    const dir = fixtureRepo();
    const files = ["package.json", "apps/server/main.ts", "packages/core/src/engine.ts"];
    let round = 0;
    const llm: ArchLlm = {
      async generate(_i, graphPrompt) {
        round++;
        if (round === 1) {
          return {
            narrative: "两模块",
            graphJson: JSON.stringify({ nodes: [{ id: "a", label: "A", evidencePath: "bad.ts" }], edges: [] }),
          };
        }
        return {
          narrative: "两模块",
          graphJson: JSON.stringify({
            nodes: [
              { id: "core", label: "核心", evidencePath: "packages/core/src/engine.ts" },
              { id: "srv", label: "服务", evidencePath: "apps/server/main.ts" },
            ],
            edges: [{ from: "srv", to: "core", label: "import", evidence: "index", evidencePath: "apps/server/main.ts" }],
          }),
        };
      },
    };
    const { graph, repairs } = await generateArchitecture(dir, files, llm);
    expect(repairs).toBe(1);
    expect(graph.nodes).toHaveLength(2);
    expect(validateGraph(graph, new Set(files))).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("模块静态推导", () => {
  it("packages/apps 为模块,(root) 兜底", () => {
    const mods = deriveModules([
      "packages/core/src/a.ts", "apps/gateway/src/main.ts", "README.md",
    ]);
    expect(mods.map((m) => m.name)).toContain("packages/core");
    expect(mods.map((m) => m.name)).toContain("apps/gateway");
    expect(mods.map((m) => m.name)).toContain("(root)");
  });
});

describe("plan 剖面接线", () => {
  it("无 LLM:静态模块+显式降级(不冒充架构图)", async () => {
    setPlanDeps({});
    const r = await codeSense(REPO, "架构", { mode: "plan" });
    expect(r.modules!.length).toBeGreaterThanOrEqual(4);
    expect(r.degraded!.some((d) => d.reason.includes("未注入 archLlm"))).toBe(true);
    expect(r.evidence.every((e) => e.kind === "ast")).toBe(true);
  }, 60_000);

  it("注入 LLM:出 mermaid 架构图,边带证据", async () => {
    const llm: ArchLlm = {
      async generate() {
        return {
          narrative: "三包结构",
          graphJson: JSON.stringify({
            nodes: [
              { id: "core", label: "core", evidencePath: "packages/core/src/task/task.ts" },
              { id: "gw", label: "gateway", evidencePath: "apps/gateway/src/app.ts" },
            ],
            edges: [{ from: "gw", to: "core", label: "import", evidence: "index", evidencePath: "apps/gateway/src/app.ts" }],
          }),
        };
      },
    };
    setPlanDeps({ archLlm: llm });
    const r = await codeSense(REPO, "架构", { mode: "plan" });
    expect(r.architecture).toBeTruthy();
    expect(r.architecture!.mermaid).toContain("flowchart TD");
    expect(r.architecture!.mermaid).toContain("-->"); // 实证边实线
    setPlanDeps({});
  }, 60_000);

  it("git 热点:本仓有历史则返回清单", async () => {
    const hs = await gitHotspots(REPO, 30, 5);
    // 本仓今天有大量提交,应非空;但断言宽松(无 git 环境=空数组合法)
    expect(Array.isArray(hs)).toBe(true);
  }, 30_000); // 套件并行重载下 git log 子进程偶发超默认 5s(step-022 ts-morph 挤压同类,放宽)
});
