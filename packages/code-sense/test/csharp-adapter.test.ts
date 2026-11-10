/**
 * C# structural adapter(2026-10-25):tree-sitter wasm 主路径 + 文本回退。
 * 覆盖:class/interface/构造器/方法/字段/内嵌调用/跨文件候选/签名/引擎集成。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCsharpFile, parseCsharpText } from "../src/adapters/csharp";
import { buildCallGraphFromFiles } from "../src/callgraph/engine";

const CS_SRC = [
  "using System;",
  "namespace Demo {",
  "  public interface IShape { double Area(); }",
  "  public class Point : IShape {",
  "    private Helper helper;",
  "    public Point(int x) { this.x = x; }",
  "    public double Area() { return Helper.Run(x); }",
  "    public void Show() {",
  "      this.Area();",
  "      helper.Run();",
  "    }",
  "  }",
  "  public class Helper {",
  "    public int Run(int v) { return v; }",
  "  }",
  "  public static class Util {",
  "    public static void Run() {",
  "      var p = new Point(1);",
  "      p.Area();",
  "      Other.Do();",
  "    }",
  "  }",
  "}",
];
const ln = (needle: string): number => CS_SRC.findIndex((l) => l.includes(needle)) + 1;

function csFixture(): { dir: string; rel: string } {
  const dir = mkdtempSync(join(tmpdir(), "gh-cs-"));
  writeFileSync(join(dir, "A.cs"), CS_SRC.join("\n") + "\n");
  return { dir, rel: "A.cs" };
}

describe("C# structural adapter(tree-sitter)", () => {
  it("类型/构造器/方法/字段提取 + 行号 + 容器", async () => {
    const { dir, rel } = csFixture();
    try {
      const r = await parseCsharpFile(dir, rel);
      expect(r.source).toBe("tree-sitter");
      expect(r.failures).toHaveLength(0);
      const labels = r.symbols.map((s) => `${s.kind}:${s.container ? s.container + "." : ""}${s.name}`);
      expect(labels).toContain("interface:IShape");
      expect(labels).toContain("class:Point");
      expect(labels).toContain("class:Helper");
      expect(labels).toContain("class:Util");
      expect(labels).toContain("variable:Point.helper");
      expect(labels).toContain("method:Point.Point");
      expect(labels).toContain("method:Point.Area");
      expect(labels).toContain("method:Point.Show");
      expect(labels).toContain("method:Helper.Run");
      expect(labels).toContain("method:Util.Run");
      const byId = new Map(r.symbols.map((s) => [s.id, s]));
      expect(byId.get("A.cs#Point")!.line).toBe(ln("public class Point"));
      expect(byId.get("A.cs#Point.Point")!.line).toBe(ln("public Point(int x)"));
      expect(byId.get("A.cs#Point.Area")!.line).toBe(ln("public double Area()"));
      expect(byId.get("A.cs#Helper.Run")!.line).toBe(ln("public int Run(int v)"));
      expect(byId.get("A.cs#Point.helper")!.dataType).toBe("Helper");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("签名:Type name 顺序 + 返回类型;构造器无返回", async () => {
    const { dir, rel } = csFixture();
    try {
      const r = await parseCsharpFile(dir, rel);
      const byId = new Map(r.symbols.map((s) => [s.id, s]));
      expect(byId.get("A.cs#Point.Point")!.signature!.params).toEqual([{ name: "x", type: "int" }]);
      expect(byId.get("A.cs#Point.Point")!.signature!.returnType).toBeUndefined();
      expect(byId.get("A.cs#Point.Area")!.signature!.returnType).toBe("double");
      expect(byId.get("A.cs#Helper.Run")!.signature!.params).toEqual([{ name: "v", type: "int" }]);
      expect(byId.get("A.cs#Helper.Run")!.signature!.returnType).toBe("int");
      expect(byId.get("A.cs#Util.Run")!.signature!.returnType).toBe("void");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("调用边:this/字段类型/静态类/构造器;tier=structural", async () => {
    const { dir, rel } = csFixture();
    try {
      const r = await parseCsharpFile(dir, rel);
      const idOf = (label: string) => r.symbols.find((s) => s.id.endsWith(label))!.id;
      const out = (label: string) => r.edges.filter((e) => e.from === idOf(label));
      expect(out("Point.Area").map((e) => `${e.toName}@${e.line}`)).toEqual(["Run@7"]);
      expect(out("Point.Show").map((e) => `${e.toName}@${e.line}`).sort()).toEqual(["Area@9", "Run@10"]);
      expect(out("Util.Run").map((e) => `${e.toName}@${e.line}`).sort()).toEqual(["Area@19", "Point@18"]);
      expect(r.edges.every((e) => e.tier === "structural" && e.evidenceKind === "ast")).toBe(true);
      const cand = (r.crossFileCandidates ?? []).find((c) => c.toName === "Do");
      expect(cand).toBeTruthy();
      expect(cand!.receiverType).toBe("Other");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("文本回退(source=text):类型/构造器/方法在场、零边", () => {
    const r = parseCsharpText("A.cs", CS_SRC.join("\n"));
    expect(r.source).toBe("text");
    expect(r.edges).toHaveLength(0);
    const labels = r.symbols.map((s) => `${s.kind}:${s.container ? s.container + "." : ""}${s.name}`);
    expect(labels).toContain("class:Point");
    expect(labels).toContain("interface:IShape");
    expect(labels).toContain("method:Point.Point");
    expect(labels).toContain("method:Point.Area");
  });
});

describe("C# 跨文件候选解析(engine merge)", () => {
  it("Util.Run() 静态形态 → 跨文件 Util.Run(evidenceKind=index)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-cs-xfile-"));
    try {
      writeFileSync(join(dir, "Util.cs"), "public class Util { public static void Run() {} }\n");
      writeFileSync(join(dir, "Main.cs"), "public class MainClass {\n  public void Go() {\n    Util.Run();\n  }\n}\n");
      const g = await buildCallGraphFromFiles(dir, ["Util.cs", "Main.cs"]);
      const go = [...g.symbols.values()].find((s) => s.name === "Go")!;
      const e = (g.outEdges.get(go.id) ?? []).find((x) => x.toName === "Run");
      expect(e).toBeTruthy();
      expect(e!.to).toContain("Util.cs#Util.Run");
      expect(e!.evidenceKind).toBe("index");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
