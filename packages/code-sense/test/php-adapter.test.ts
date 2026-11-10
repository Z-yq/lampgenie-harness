/**
 * PHP structural adapter(2026-10-25):tree-sitter wasm 主路径 + 文本回退。
 * 覆盖:class/interface/trait/属性/构造器/方法/函数/内嵌调用/跨文件候选。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePhpFile, parsePhpText } from "../src/adapters/php";
import { buildCallGraphFromFiles } from "../src/callgraph/engine";

const PHP_SRC = [
  "<?php",
  "namespace Demo;",
  "use Other\\Thing;",
  "interface Shape { public function area(): float; }",
  "trait Loggable { public function log(): void { helper(); } }",
  "class Point implements Shape {",
  "    private int $x;",
  "    public function __construct(int $x) { $this->x = $x; }",
  "    public function area(): float { return $this->helper(); }",
  "    private function helper(): float { return 1.0; }",
  "    public static function make(): self { return new self(1); }",
  "}",
  "function top_level(int $x) {",
  "    $p = new Point($x);",
  "    $p->area();",
  "    helper2();",
  "    Thing::run();",
  "}",
  "function helper2() {}",
];
const ln = (needle: string): number => PHP_SRC.findIndex((l) => l.includes(needle)) + 1;

function phpFixture(): { dir: string; rel: string } {
  const dir = mkdtempSync(join(tmpdir(), "gh-php-"));
  writeFileSync(join(dir, "a.php"), PHP_SRC.join("\n") + "\n");
  return { dir, rel: "a.php" };
}

describe("PHP structural adapter(tree-sitter)", () => {
  it("类型/属性/构造器/方法/函数提取 + 行号 + 容器", async () => {
    const { dir, rel } = phpFixture();
    try {
      const r = await parsePhpFile(dir, rel);
      expect(r.source).toBe("tree-sitter");
      expect(r.failures).toHaveLength(0);
      const labels = r.symbols.map((s) => `${s.kind}:${s.container ? s.container + "." : ""}${s.name}`);
      expect(labels).toContain("interface:Shape");
      expect(labels).toContain("class:Loggable");
      expect(labels).toContain("class:Point");
      expect(labels).toContain("variable:Point.x");
      expect(labels).toContain("method:Shape.area");
      expect(labels).toContain("method:Loggable.log");
      expect(labels).toContain("method:Point.__construct");
      expect(labels).toContain("method:Point.area");
      expect(labels).toContain("method:Point.helper");
      expect(labels).toContain("method:Point.make");
      expect(labels).toContain("function:top_level");
      expect(labels).toContain("function:helper2");
      const byId = new Map(r.symbols.map((s) => [s.id, s]));
      expect(byId.get("a.php#Point")!.line).toBe(ln("class Point"));
      expect(byId.get("a.php#Point.__construct")!.line).toBe(ln("public function __construct"));
      expect(byId.get("a.php#Point.area")!.line).toBe(ln("return $this->helper"));
      expect(byId.get("a.php#Point.helper")!.line).toBe(ln("private function helper"));
      expect(byId.get("a.php#top_level")!.line).toBe(ln("function top_level"));
      expect(byId.get("a.php#Point.x")!.dataType).toBe("int");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("签名:PHP Type $name 顺序 + 返回类型", async () => {
    const { dir, rel } = phpFixture();
    try {
      const r = await parsePhpFile(dir, rel);
      const byId = new Map(r.symbols.map((s) => [s.id, s]));
      expect(byId.get("a.php#Point.__construct")!.signature!.params).toEqual([{ name: "x", type: "int" }]);
      expect(byId.get("a.php#Point.__construct")!.signature!.returnType).toBeUndefined();
      expect(byId.get("a.php#Point.area")!.signature!.returnType).toBe("float");
      expect(byId.get("a.php#top_level")!.signature!.params).toEqual([{ name: "x", type: "int" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("调用边:$this/局部 new 类型证据/裸函数/静态类/构造器", async () => {
    const { dir, rel } = phpFixture();
    try {
      const r = await parsePhpFile(dir, rel);
      const idOf = (label: string) => r.symbols.find((s) => s.id.endsWith(label))!.id;
      const out = (label: string) => r.edges.filter((e) => e.from === idOf(label));
      expect(out("Point.area").map((e) => `${e.toName}@${e.line}`)).toEqual(["helper@9"]);
      expect(out("Point.make").map((e) => `${e.toName}@${e.line}`)).toEqual(["__construct@11"]);
      expect(out("top_level").map((e) => `${e.toName}@${e.line}`).sort()).toEqual(
        ["__construct@14", "area@15", "helper2@16"].sort(),
      );
      expect(r.edges.every((e) => e.tier === "structural" && e.evidenceKind === "ast")).toBe(true);
      const cands = r.crossFileCandidates ?? [];
      expect(cands.find((c) => c.toName === "run")?.receiverType).toBe("Thing");
      expect(cands.find((c) => c.toName === "helper")).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("文本回退(source=text):类型/方法/函数在场、零边", () => {
    const r = parsePhpText("a.php", PHP_SRC.join("\n"));
    expect(r.source).toBe("text");
    expect(r.edges).toHaveLength(0);
    const labels = r.symbols.map((s) => `${s.kind}:${s.container ? s.container + "." : ""}${s.name}`);
    expect(labels).toContain("class:Point");
    expect(labels).toContain("interface:Shape");
    expect(labels).toContain("method:Point.__construct");
    expect(labels).toContain("method:Point.area");
    expect(labels).toContain("function:top_level");
  });
});

describe("PHP 跨文件候选解析(engine merge)", () => {
  it("Util::run() 静态形态 → 跨文件 Util.run(evidenceKind=index)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-php-xfile-"));
    try {
      writeFileSync(join(dir, "util.php"), "<?php\nclass Util { public static function run() {} }\n");
      writeFileSync(join(dir, "main.php"), "<?php\nfunction go() {\n    Util::run();\n}\n");
      const g = await buildCallGraphFromFiles(dir, ["util.php", "main.php"]);
      const go = [...g.symbols.values()].find((s) => s.name === "go")!;
      const e = (g.outEdges.get(go.id) ?? []).find((x) => x.toName === "run");
      expect(e).toBeTruthy();
      expect(e!.to).toContain("util.php#Util.run");
      expect(e!.evidenceKind).toBe("index");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
