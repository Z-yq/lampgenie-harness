/**
 * Ruby structural adapter(2026-10-25):tree-sitter wasm 主路径 + 文本回退。
 * 覆盖:module/class/实例方法/singleton 方法/隐式 self 裸调用/赋值类型证据/跨文件候选。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRubyFile, parseRubyText } from "../src/adapters/ruby";
import { buildCallGraphFromFiles } from "../src/callgraph/engine";

const RUBY_SRC = [
  "require \"json\"",
  "module Demo",
  "  class Counter",
  "    def initialize",
  "      @value = 0",
  "    end",
  "    def bump",
  "      helper",
  "      @logger = Logger.new",
  "      @logger.write(\"x\")",
  "    end",
  "    def self.create",
  "      new",
  "    end",
  "    private",
  "    def helper",
  "      1",
  "    end",
  "  end",
  "end",
  "class Worker",
  "  def run",
  "    c = Demo::Counter.new",
  "    c.bump",
  "    External.call(\"x\")",
  "  end",
  "end",
  "def top_level(x)",
  "  x",
  "end",
];
const ln = (needle: string): number => RUBY_SRC.findIndex((l) => l.trim() === needle || l.includes(needle)) + 1;

function rubyFixture(): { dir: string; rel: string } {
  const dir = mkdtempSync(join(tmpdir(), "gh-rb-"));
  writeFileSync(join(dir, "main.rb"), RUBY_SRC.join("\n") + "\n");
  return { dir, rel: "main.rb" };
}

describe("Ruby structural adapter(tree-sitter)", () => {
  it("module/class/实例方法/singleton 方法提取 + 行号 + 容器", async () => {
    const { dir, rel } = rubyFixture();
    try {
      const r = await parseRubyFile(dir, rel);
      expect(r.source).toBe("tree-sitter");
      expect(r.failures).toHaveLength(0);
      const labels = r.symbols.map((s) => `${s.kind}:${s.container ? s.container + "." : ""}${s.name}`);
      expect(labels).toContain("class:Demo");
      expect(labels).toContain("class:Demo.Counter");
      expect(labels).toContain("class:Worker");
      expect(labels).toContain("method:Counter.initialize");
      expect(labels).toContain("method:Counter.bump");
      expect(labels).toContain("method:Counter.create");
      expect(labels).toContain("method:Counter.helper");
      expect(labels).toContain("method:Worker.run");
      expect(labels).toContain("function:top_level");
      const byId = new Map(r.symbols.map((s) => [s.id, s]));
      expect(byId.get("main.rb#Demo.Counter")!.line).toBe(ln("class Counter"));
      expect(byId.get("main.rb#Counter.initialize")!.line).toBe(ln("def initialize"));
      expect(byId.get("main.rb#Counter.bump")!.line).toBe(ln("def bump"));
      expect(byId.get("main.rb#Counter.create")!.line).toBe(ln("def self.create"));
      expect(byId.get("main.rb#Counter.helper")!.line).toBe(ln("def helper"));
      expect(byId.get("main.rb#Worker.run")!.line).toBe(ln("def run"));
      expect(byId.get("main.rb#top_level")!.line).toBe(ln("def top_level(x)"));
      expect(byId.get("main.rb#top_level")!.signature!.params).toEqual([{ name: "x" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("调用边:隐式 self 裸调用/赋值类型证据/常量接收者;tier=structural", async () => {
    const { dir, rel } = rubyFixture();
    try {
      const r = await parseRubyFile(dir, rel);
      const idOf = (label: string) => r.symbols.find((s) => s.id.endsWith(label))!.id;
      const out = (label: string) => r.edges.filter((e) => e.from === idOf(label));
      expect(out("Counter.bump").map((e) => `${e.toName}@${e.line}`)).toEqual(["helper@8"]);
      expect(out("Worker.run").map((e) => `${e.toName}@${e.line}`)).toEqual(["bump@24"]);
      expect(r.edges.every((e) => e.tier === "structural" && e.evidenceKind === "ast")).toBe(true);
      const cands = r.crossFileCandidates ?? [];
      const write = cands.find((c) => c.toName === "write");
      expect(write?.receiverType).toBe("Logger");
      expect(cands.find((c) => c.toName === "call")?.receiverType).toBe("External");
      expect(cands.find((c) => c.toName === "new" && c.receiverType === "Logger")).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("文本回退(source=text):缩进栈容器正确、零边", () => {
    const r = parseRubyText("main.rb", RUBY_SRC.join("\n"));
    expect(r.source).toBe("text");
    expect(r.edges).toHaveLength(0);
    const labels = r.symbols.map((s) => `${s.kind}:${s.container ? s.container + "." : ""}${s.name}`);
    expect(labels).toContain("class:Demo");
    expect(labels).toContain("class:Demo.Counter");
    expect(labels).toContain("method:Counter.initialize");
    expect(labels).toContain("method:Counter.bump");
    expect(labels).toContain("method:Counter.helper");
    expect(labels).toContain("function:top_level");
  });
});

describe("Ruby 跨文件候选解析(engine merge)", () => {
  it("Helper.new.log 链式构造 → 跨文件 Helper.log(evidenceKind=index)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-rb-xfile-"));
    try {
      writeFileSync(join(dir, "helper.rb"), "class Helper\n  def log(x)\n    x\n  end\nend\n");
      writeFileSync(join(dir, "main.rb"), "class Worker\n  def run\n    Helper.new.log(\"x\")\n  end\nend\n");
      const g = await buildCallGraphFromFiles(dir, ["helper.rb", "main.rb"]);
      const run = [...g.symbols.values()].find((s) => s.name === "run")!;
      const e = (g.outEdges.get(run.id) ?? []).find((x) => x.toName === "log");
      expect(e).toBeTruthy();
      expect(e!.to).toContain("helper.rb#Helper.log");
      expect(e!.evidenceKind).toBe("index");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
