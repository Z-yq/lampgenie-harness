/**
 * 模块作用注记:flow 模块图节点旁的一句话——package.json > README >
 * __init__.py docstring/顶部注释 > 名称线索 > 拓扑角色;推断来源加 ≈,不冒充文档。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { moduleAnnotationText, moduleNotes } from "../src/callgraph/module-notes";
import type { CodeFlow, FlowNode } from "../src/callgraph/flow";

function node(label: string, extra: Partial<FlowNode> = {}): FlowNode {
  return {
    id: `m:${label}`, label, group: "root files", kind: "regular", entry: false, depth: 1,
    out: 0, in: 0, outCalls: 0, inCalls: 0, internalCalls: 0, unresolved: 0,
    files: 2, symbols: 10, ...extra,
  };
}

function moduleFlow(nodes: FlowNode[]): CodeFlow {
  return { level: "module", root: "/x", direction: "LR", nodes, edges: [], groups: [], entries: [], stats: {} as CodeFlow["stats"], notes: [] };
}

function write(base: string, rel: string, content: string): void {
  const abs = join(base, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

describe("module-notes", () => {
  it("来源优先级:package.json > README > docstring > 名称 > 拓扑;推断加 ≈", () => {
    const root = mkdtempSync(join(tmpdir(), "modnotes-"));
    try {
      write(root, "pkg-desc/package.json", JSON.stringify({ name: "pkg-desc", description: "描述型包:负责 A" }));
      write(root, "pkg-readme/README.md", "# pkg-readme — README 里的作用\n\n正文");
      write(root, "pkg-py/__init__.py", '"""独立记忆抽取服务（FastAPI 装配层）\n\n设计依据：tasks/.md\n"""\n');
      write(root, "pkg-py2/__init__.py", '"""\n自动记忆机制模块\n提供记忆提取、缓存和管理功能\n"""\n');
      write(root, "pkg-readme2/README.md", "# pkg-readme2\n\nA tiny two-package demo for code flow wiki.\n");

      const flow = moduleFlow([
        node("pkg-desc"),
        node("pkg-readme"),
        node("pkg-py"),
        node("pkg-py2"),
        node("pkg-readme2"),
        node("packages/gateway"),
        node("misc", { in: 4 }),
        node("(root)"),
      ]);
      const notes = moduleNotes(root, flow);
      expect(notes["pkg-desc"]).toMatchObject({ source: "package.json", text: "描述型包:负责 A" });
      expect(notes["pkg-readme"]).toMatchObject({ source: "readme", text: "README 里的作用" });
      expect(notes["pkg-py"]?.source).toBe("docstring");
      expect(notes["pkg-py"]?.text).toBe("独立记忆抽取服务（FastAPI 装配层）");
      expect(notes["pkg-py2"]?.source).toBe("docstring");
      expect(notes["pkg-py2"]?.text).toContain("自动记忆机制模块");
      expect(notes["pkg-py2"]?.text).toContain("缓存和管理功能");
      // README 标题与模块同名 → 退到首段
      expect(notes["pkg-readme2"]?.source).toBe("readme");
      expect(notes["pkg-readme2"]?.text).toContain("two-package demo");
      // 名称线索
      expect(notes["packages/gateway"]).toMatchObject({ source: "name", text: "服务/API 与编排层" });
      expect(moduleAnnotationText(notes["packages/gateway"]!)).toMatch(/^≈ /);
      // 名称无线索 → 拓扑
      expect(notes["misc"]).toMatchObject({ source: "topology", text: "核心/被 4 个上游依赖" });
      expect(moduleAnnotationText(notes["misc"]!)).toMatch(/^≈ /);
      // 根模块无文档 → 组合根
      expect(notes["(root)"]).toMatchObject({ source: "name", text: "仓库根/组合根" });
      // 文档来源不加 ≈
      expect(moduleAnnotationText(notes["pkg-desc"]!)).toBe("描述型包:负责 A");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("docs 覆盖 package.json;非模块级返回空", () => {
    const root = mkdtempSync(join(tmpdir(), "modnotes2-"));
    try {
      const flow = moduleFlow([node("pkg")]);
      const notes = moduleNotes(root, flow, { docs: { pkg: "面板传入的描述" } });
      expect(notes.pkg).toMatchObject({ source: "package.json", text: "面板传入的描述" });
      const fnFlow = { ...flow, level: "file" as const };
      expect(moduleNotes(root, fnFlow)).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
