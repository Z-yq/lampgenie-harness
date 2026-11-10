/**
 * 四语言 adapter 引擎注册冒烟:GRAPH_STRUCT_EXT 注册 + mergeStructAdapters
 * 按扩展名分派 + 跨文件候选解析(每语言一条最小闭环)。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCallGraphFromFiles, GRAPH_STRUCT_EXT } from "../src/callgraph/engine";

describe("四语言 adapter 注册与合并冒烟", () => {
  it("GRAPH_STRUCT_EXT 含 .rs/.cs/.rb/.php", () => {
    for (const ext of [".rs", ".cs", ".rb", ".php"]) expect(GRAPH_STRUCT_EXT.has(ext)).toBe(true);
  });

  it("同仓四语言文件全部进图,各自跨文件候选可解析", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-multilang-"));
    try {
      writeFileSync(join(dir, "lib.rs"), "pub struct Util {}\nimpl Util { pub fn run(&self) -> i32 { 1 } }\n");
      writeFileSync(join(dir, "main.rs"), "fn caller(u: &Util) {\n    u.run();\n}\n");
      writeFileSync(join(dir, "Util.cs"), "public class Util { public static void Run() {} }\n");
      writeFileSync(join(dir, "Main.cs"), "public class MainClass {\n  public void Go() {\n    Util.Run();\n  }\n}\n");
      writeFileSync(join(dir, "helper.rb"), "class Helper\n  def log(x)\n    x\n  end\nend\n");
      writeFileSync(join(dir, "main.rb"), "class Worker\n  def run\n    Helper.new.log(\"x\")\n  end\nend\n");
      writeFileSync(join(dir, "util.php"), "<?php\nclass Util { public static function run() {} }\n");
      writeFileSync(join(dir, "main.php"), "<?php\nfunction go() {\n    Util::run();\n}\n");
      const files = ["lib.rs", "main.rs", "Util.cs", "Main.cs", "helper.rb", "main.rb", "util.php", "main.php"];
      const g = await buildCallGraphFromFiles(dir, files);
      // 四语言符号都在场(各语言互不覆盖:容器/类名相同也被文件 id 区分)
      const refs = [
        "lib.rs#Util.run", "Util.cs#Util.Run", "helper.rb#Helper.log", "util.php#Util.run",
        "main.rs#caller", "Main.cs#MainClass.Go", "main.rb#Worker.run", "main.php#go",
      ];
      for (const id of refs) expect(g.symbols.has(id)).toBe(true);
      // 跨文件候选全部 resolved(evidenceKind=index)
      const edgeOf = (callerId: string, toName: string) =>
        (g.outEdges.get(callerId) ?? []).find((e) => e.toName === toName);
      expect(edgeOf("main.rs#caller", "run")?.to).toBe("lib.rs#Util.run");
      expect(edgeOf("Main.cs#MainClass.Go", "Run")?.to).toBe("Util.cs#Util.Run");
      expect(edgeOf("main.rb#Worker.run", "log")?.to).toBe("helper.rb#Helper.log");
      expect(edgeOf("main.php#go", "run")?.to).toBe("util.php#Util.run");
      for (const [caller, toName] of [["main.rs#caller", "run"], ["Main.cs#MainClass.Go", "Run"], ["main.rb#Worker.run", "log"], ["main.php#go", "run"]] as const) {
        expect(edgeOf(caller, toName)?.evidenceKind).toBe("index");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
