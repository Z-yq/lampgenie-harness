/**
 * RC 批修复回归测试(RC-K/L/M/N/O 的机制层锚定):
 * - RC-L:listSourceFilesDetailed 超限按语言配额公平采样(确定性、比例≈磁盘占比、不超限零变化)
 * - RC-K:parseGuardReason 压缩产物/超大守卫 + buildCallGraph 逐文件包保护(坏文件不毙全仓)
 * - RC-M:extractApiSurface 文档路径守卫(.md/docs 不提取)
 * - RC-O:python 模块级调用(decorator 形态)+ import 别名 toName 回落原名
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSourceFilesDetailed, parseGuardReason, buildCallGraph } from "../src/callgraph/engine";
import { extractApiSurface } from "../src/sensing/http-api";
import { parsePythonFile } from "../src/adapters/python";

function tmpRepo(tag: string): string {
  return mkdtempSync(join(tmpdir(), `gh-rc85-${tag}-`));
}

describe("RC-L 公平截断(listSourceFilesDetailed)", () => {
  it("超限按扩展名配额采样:30 go + 10 ts,limit=12 → 9:3(比例保持),两次调用逐字节一致", async () => {
    const dir = tmpRepo("fair");
    for (let i = 0; i < 30; i++) writeFileSync(join(dir, `svc${i}.go`), "package main\n");
    const sub = join(dir, "web");
    mkdirSync(sub);
    for (let i = 0; i < 10; i++) writeFileSync(join(sub, `app${i}.ts`), "export const x = 1;\n");
    const a = await listSourceFilesDetailed(dir, 12);
    const b = await listSourceFilesDetailed(dir, 12);
    expect(a.truncated).toBe(true);
    expect(a.totalSeen).toBe(40);
    expect(a.files.length).toBe(12);
    const go = a.files.filter((f) => f.endsWith(".go")).length;
    const ts = a.files.filter((f) => f.endsWith(".ts")).length;
    expect(go).toBe(9); // 30/40*12=9
    expect(ts).toBe(3); // 10/40*12=3
    expect(a.files).toEqual(b.files); // 确定性可复现
    rmSync(dir, { recursive: true, force: true });
  });

  it("不超限:全部返回、truncated=false(旧 walk 序语义保持)", async () => {
    const dir = tmpRepo("nofair");
    writeFileSync(join(dir, "a.ts"), "export const x = 1;\n");
    writeFileSync(join(dir, "b.py"), "def f():\n    pass\n");
    const r = await listSourceFilesDetailed(dir, 100);
    expect(r.truncated).toBe(false);
    expect(r.files.length).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("RC-K 解析前守卫(parseGuardReason)", () => {
  it("超大单文件(>2MB)返回原因;≥32KB 单行压缩产物返回原因", async () => {
    const dir = tmpRepo("guard");
    const big = join(dir, "big.ts");
    writeFileSync(big, "export const x = `" + "a".repeat(2 * 1024 * 1024) + "`;\n");
    const bigReason = await parseGuardReason(big);
    expect(bigReason).toContain("超大单文件");
    const mini = join(dir, "chunk.js");
    writeFileSync(mini, "(function(){" + "var a=1;".repeat(12 * 1024) + "})();"); // ~74KB 单行
    const miniReason = await parseGuardReason(mini);
    expect(miniReason).toContain("压缩产物启发");
    const normal = join(dir, "normal.ts");
    writeFileSync(normal, `export function f(): number {\n  return 1; // ${"x".repeat(200)}\n}\n`.repeat(400)); // ~100KB 正常多行
    expect(await parseGuardReason(normal)).toBeNull();
    // 单条长字符串常量不误杀:多数短行 + 1 条 30KB 长行
    const oneLong = join(dir, "prompt.py");
    writeFileSync(oneLong, `PROMPT = "${"y".repeat(30 * 1024)}"\n` + "def f():\n    return 1\n".repeat(300));
    expect(await parseGuardReason(oneLong)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("buildCallGraph:压缩产物跳过不毙全仓,structTruncated 诚实登记", async () => {
    const dir = tmpRepo("build");
    writeFileSync(join(dir, "good.ts"), "export function goodFn(): number { return 1; }\n");
    writeFileSync(join(dir, "bad.js"), "(function(){" + "var a=1;".repeat(12 * 1024) + "})();");
    const graph = await buildCallGraph(dir);
    const names = [...graph.symbols.values()].map((s) => s.name);
    expect(names).toContain("goodFn");
    expect(graph.structTruncated?.reason ?? "").toContain("解析前跳过");
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});

describe("RC-M 文档路径守卫(extractApiSurface)", () => {
  it(".md 文档里的接口示例不提取,真 .py 端点照常", async () => {
    const dir = tmpRepo("doc");
    const specs = join(dir, "specs");
    mkdirSync(specs);
    writeFileSync(join(specs, "product-spec.md"), [
      "# spec",
      "```python",
      "from fastapi import FastAPI",
      'app = FastAPI()',
      '@app.get("/api/health")',
      "def health(): ...",
      "```",
    ].join("\n"));
    writeFileSync(join(dir, "main.py"), [
      "from fastapi import FastAPI",
      "app = FastAPI()",
      '@app.get("/real")',
      "def real(): ...",
    ].join("\n"));
    const r = await extractApiSurface(dir, ["specs/product-spec.md", "main.py"]);
    expect(r.endpoints.map((e) => e.path)).toEqual(["/real"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("RC-O python 模块级调用 + import 别名", () => {
  it("decorator 行的模块级调用发 <module> 调用方边(redash org_scoped_rule 形态)", async () => {
    const dir = tmpRepo("pymod");
    const rel = "routes.py";
    writeFileSync(join(dir, rel), [
      '"""Module docstring mentions foo() for details — 不算调用."""',
      "def org_scoped_rule(rule):",
      "    return rule",
      "",
      '@route(org_scoped_rule("/api/x"))',
      "def handler():",
      "    pass",
    ].join("\n"));
    const r = await parsePythonFile(dir, rel);
    const modEdges = r.edges.filter((e) => e.from.endsWith("#<module>"));
    expect(modEdges.length).toBeGreaterThanOrEqual(1);
    const hit = modEdges.find((e) => e.toName === "org_scoped_rule");
    expect(hit).toBeTruthy();
    expect(hit!.to).toContain("org_scoped_rule");
    expect(hit!.evidenceKind).toBe("ast");
    // 模块 docstring 提及 foo() 不产生假边
    expect(modEdges.find((e) => e.toName === "foo")).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it("from x import f as g:候选 toName 回落原名 f(merge 层按目标符号名解析)", async () => {
    const dir = tmpRepo("pyalias");
    writeFileSync(join(dir, "base.py"), "def org_scoped_rule(rule):\n    return rule\n");
    writeFileSync(join(dir, "user.py"), [
      "from base import org_scoped_rule as osr",
      "",
      "@route(osr(\"/y\"))",
      "def handler():",
      "    pass",
    ].join("\n"));
    const r = await parsePythonFile(dir, "user.py");
    const cand = r.crossFileCandidates.find((c) => c.toName === "org_scoped_rule");
    expect(cand).toBeTruthy();
    expect(cand!.from).toContain("#<module>");
    // 全图合并后解析成真边(buildCallGraph 小仓直跑)
    const graph = await buildCallGraph(dir);
    const targetId = [...graph.symbols.values()].find((s) => s.name === "org_scoped_rule")?.id;
    expect(targetId).toBeTruthy();
    const ins = graph.inEdges.get(targetId!) ?? [];
    expect(ins.some((e) => e.from.endsWith("user.py#<module>"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("模块级 main() 调用直连同文件符号(__main__ 形态)", async () => {
    const dir = tmpRepo("pymain");
    const rel = "cli.py";
    writeFileSync(join(dir, rel), [
      "def main():",
      "    pass",
      "",
      'if __name__ == "__main__":',
      "    main()",
    ].join("\n"));
    const r = await parsePythonFile(dir, rel);
    const e = r.edges.find((x) => x.from.endsWith("#<module>") && x.toName === "main");
    expect(e).toBeTruthy();
    expect(e!.to).toContain("cli.py#main");
    rmSync(dir, { recursive: true, force: true });
  });
});
