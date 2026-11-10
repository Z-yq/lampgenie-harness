/**
 * Rust structural adapter(2026-10-25):tree-sitter wasm 主路径 + 文本回退。
 * 覆盖:类/函数/方法/内嵌调用/跨文件候选/签名/语法盲区/引擎集成。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRustFile, parseRustText } from "../src/adapters/rust";
import { buildCallGraphFromFiles } from "../src/callgraph/engine";

const RUST_SRC = [
  "use crate::util;",
  "pub struct Counter { value: i32 }",
  "pub trait Tick { fn tick(&self) -> i32; }",
  "impl Counter {",
  "    pub fn new() -> Self { Counter { value: 0 } }",
  "    pub fn bump(&mut self) {",
  "        self.tick();",
  "        self.helper();",
  "    }",
  "    fn helper(&self) -> i32 { 1 }",
  "}",
  "impl Tick for Counter { fn tick(&self) -> i32 { self.helper() } }",
  "fn main() {",
  "    let c = Counter::new();",
  "    c.bump();",
  "    util::trace(1);",
  "}",
  "fn log(x: i32) {}",
];
const ln = (needle: string): number => RUST_SRC.findIndex((l) => l.includes(needle)) + 1;

function rustFixture(): { dir: string; rel: string } {
  const dir = mkdtempSync(join(tmpdir(), "gh-rust-"));
  writeFileSync(join(dir, "main.rs"), RUST_SRC.join("\n") + "\n");
  return { dir, rel: "main.rs" };
}

describe("Rust structural adapter(tree-sitter)", () => {
  it("类型/方法/函数/字段提取 + 行号 + 容器", async () => {
    const { dir, rel } = rustFixture();
    try {
      const r = await parseRustFile(dir, rel);
      expect(r.source).toBe("tree-sitter");
      expect(r.failures).toHaveLength(0);
      const byId = new Map(r.symbols.map((s) => [s.id, s]));
      expect(r.symbols.map((s) => `${s.kind}:${s.container ? s.container + "." : ""}${s.name}`).sort()).toEqual(
        [
          "class:Counter", "interface:Tick", "variable:Counter.value",
          "method:Tick.tick", "method:Counter.new", "method:Counter.bump",
          "method:Counter.helper", "method:Counter.tick",
          "function:main", "function:log",
        ].sort(),
      );
      expect(byId.get("main.rs#Counter")!.line).toBe(ln("pub struct Counter"));
      expect(byId.get("main.rs#Counter.new")!.line).toBe(ln("pub fn new"));
      expect(byId.get("main.rs#Counter.bump")!.line).toBe(ln("pub fn bump"));
      expect(byId.get("main.rs#Counter.helper")!.line).toBe(ln("fn helper"));
      expect(byId.get("main.rs#Counter.tick")!.line).toBe(ln("impl Tick for Counter"));
      expect(byId.get("main.rs#main")!.line).toBe(ln("fn main()"));
      expect(byId.get("main.rs#log")!.line).toBe(ln("fn log(x: i32)"));
      expect(byId.get("main.rs#Counter.value")!.dataType).toBe("i32");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("签名:params/return/self;泛型不猜时留空", async () => {
    const { dir, rel } = rustFixture();
    try {
      const r = await parseRustFile(dir, rel);
      const byName = (n: string) => r.symbols.find((s) => s.name === n && s.container !== "Tick")!;
      const nw = byName("new");
      expect(nw.signature!.params).toEqual([]);
      expect(nw.signature!.returnType).toBe("Self");
      const bump = byName("bump");
      expect(bump.signature!.params.map((p) => p.name)).toEqual(["self"]);
      const log = byName("log");
      expect(log.signature!.params).toEqual([{ name: "x", type: "i32" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("调用边:self/字段/类型证据/静态路径;tier=structural", async () => {
    const { dir, rel } = rustFixture();
    try {
      const r = await parseRustFile(dir, rel);
      const idOf = (label: string) => r.symbols.find((s) => s.id.endsWith(label))!.id;
      const out = (label: string) => r.edges.filter((e) => e.from === idOf(label));
      expect(out("Counter.bump").map((e) => `${e.toName}@${e.line}`).sort()).toEqual(["helper@8", "tick@7"]);
      expect(out("Counter.tick").map((e) => `${e.toName}@${e.line}`)).toEqual(["helper@12"]);
      expect(out("main").map((e) => `${e.toName}@${e.line}`).sort()).toEqual(["bump@15", "new@14"]);
      expect(r.edges.every((e) => e.tier === "structural" && e.evidenceKind === "ast")).toBe(true);
      // 模块路径调用:util::trace 带 receiverType 证据进候选区
      const cand = (r.crossFileCandidates ?? []).find((c) => c.toName === "trace");
      expect(cand).toBeTruthy();
      expect(cand!.receiverType).toBe("util");
      expect(cand!.to).toBe("");
      // 宏调用/未解析裸名不产假边
      expect(r.edges.some((e) => e.toName === "println")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("文件缺失进盲区;语法残缺不吐半成品(整文件 ERROR → 空符号+失败)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-rust-bad-"));
    try {
      const miss = await parseRustFile(dir, "nope.rs");
      expect(miss.symbols).toHaveLength(0);
      expect(miss.failures).toHaveLength(1);
      writeFileSync(join(dir, "bad.rs"), "fn broken( { impl }}}\n");
      const bad = await parseRustFile(dir, "bad.rs");
      // 错误恢复节点不得冒充声明;文本回退也拿不到完整声明 → 失败如实登记
      expect(bad.symbols).toHaveLength(0);
      expect(bad.failures.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("文本回退(source=text):符号在场、零边", () => {
    const r = parseRustText("main.rs", RUST_SRC.join("\n"));
    expect(r.source).toBe("text");
    expect(r.edges).toHaveLength(0);
    const names = r.symbols.map((s) => `${s.kind}:${s.container ? s.container + "." : ""}${s.name}`);
    expect(names).toContain("class:Counter");
    expect(names).toContain("interface:Tick");
    expect(names).toContain("method:Counter.new");
    expect(names).toContain("method:Counter.helper");
    expect(names).toContain("function:main");
  });
});

describe("Rust 跨文件候选解析(engine merge)", () => {
  it("参数类型证据 &Util + u.run() → 跨文件 Util.run(evidenceKind=index)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-rust-xfile-"));
    try {
      writeFileSync(join(dir, "util.rs"), "pub struct Util {}\nimpl Util { pub fn run(&self) -> i32 { 1 } }\n");
      writeFileSync(join(dir, "main.rs"), "fn caller(u: &Util) {\n    u.run();\n}\n");
      const g = await buildCallGraphFromFiles(dir, ["util.rs", "main.rs"]);
      const caller = [...g.symbols.values()].find((s) => s.name === "caller")!;
      const e = (g.outEdges.get(caller.id) ?? []).find((x) => x.toName === "run");
      expect(e).toBeTruthy();
      expect(e!.to).toContain("util.rs#Util.run");
      expect(e!.evidenceKind).toBe("index");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
