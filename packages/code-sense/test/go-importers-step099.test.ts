/**
 * RC-B2 测试:Go importers 落盘。
 * ① adapter 层:parseGoFile 结果带本文件 import 路径清单;
 * ② 展开层:expandGoImports 按 go.mod 模块锚把包路径映射到目录内非测试 .go 文件
 *    (外部路径/无 go.mod=跳过不猜;同包不互列);
 * ③ 索引层:buildC2fIndex 后 importers 含跨包映射,纯 Go 仓字段在场(消灭
 * 「重建后补全」做不到的形态——096 评测 go-cobra fresh 重建字段缺席注意);
 * ④ 增量/全量共用同一 expandGoImports(单一真相);
 * ⑤ impact 面:纯 Go 仓 importers 在场 → 不再出现「旧格式索引」降级提示。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseGoFile } from "../src/adapters/go";
import { buildC2fIndex, expandGoImports } from "../src/callgraph/c2f";
import { queryImpact, renderImpact } from "../src/callgraph/impact";

function mkWs(): string {
  return mkdtempSync(join(tmpdir(), "cs-goimp-"));
}

/** 两包 Go 仓夹具:module example.com/demo;pkg/ 库包 + cmd/ 主包 import 它。 */
function seedGoWs(dir: string): void {
  writeFileSync(join(dir, "go.mod"), "module example.com/demo\n\ngo 1.22\n");
  mkdirSync(join(dir, "pkg", "flags"), { recursive: true });
  mkdirSync(join(dir, "cmd", "tool"), { recursive: true });
  writeFileSync(join(dir, "pkg", "flags", "flags.go"), [
    "package flags",
    "",
    "func Validate(name string) bool { return len(name) > 0 }",
    "",
  ].join("\n"));
  writeFileSync(join(dir, "cmd", "tool", "main.go"), [
    "package main",
    "",
    "import (",
    '	"fmt"',
    '	"example.com/demo/pkg/flags"',
    ")",
    "",
    "func main() {",
    '	if flags.Validate("x") { fmt.Println("ok") }',
    "}",
    "",
  ].join("\n"));
  // 同包测试文件:不 import 本包(包内可见),不应作为 importers target 出现
  writeFileSync(join(dir, "pkg", "flags", "flags_test.go"), [
    "package flags",
    "",
    'import "testing"',
    "",
    "func TestValidate(t *testing.T) {",
    '	if !Validate("a") { t.Fail() }',
    "}",
    "",
  ].join("\n"));
}

describe(" RC-B2:Go importers 落盘", () => {
  it("adapter 层:parseGoFile 带 import 路径清单(块形态+单行形态)", async () => {
    const dir = mkWs();
    seedGoWs(dir);
    const r = await parseGoFile(dir, join("cmd", "tool", "main.go"));
    expect(r.imports).toBeDefined();
    expect(r.imports).toContain("example.com/demo/pkg/flags");
    expect(r.imports).toContain("fmt"); // 原始清单如实含标准库,仓内/外判定归展开层
    rmSync(dir, { recursive: true, force: true });
  });

  it("展开层:go.mod 锚定跨包映射;外部路径跳过;同包不互列;测试文件不作 target", async () => {
    const dir = mkWs();
    seedGoWs(dir);
    const raw = new Map<string, string[]>([
      [join(dir, "cmd", "tool", "main.go"), ["fmt", "example.com/demo/pkg/flags"]],
    ]);
    const edges = expandGoImports(dir, raw, ["cmd/tool/main.go", "pkg/flags/flags.go", "pkg/flags/flags_test.go"]);
    // flags.go 的 importers 含 main.go;fmt 不映射;flags_test.go 不作 target
    const targets = [...edges.keys()].map((t) => t.replace(dir + "/", ""));
    expect(targets).toContain("pkg/flags/flags.go");
    expect(targets).not.toContain("pkg/flags/flags_test.go");
    const froms = [...edges.get(join(dir, "pkg", "flags", "flags.go"))!].map((f) => f.replace(dir + "/", ""));
    expect(froms).toEqual(["cmd/tool/main.go"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("展开层:无 go.mod 仓=空结果(不猜)", async () => {
    const dir = mkWs();
    mkdirSync(join(dir, "p"), { recursive: true });
    writeFileSync(join(dir, "p", "a.go"), "package p\n\nfunc A() {}\n");
    const raw = new Map<string, string[]>([[join(dir, "p", "a.go"), ["example.com/x/p"]]]);
    const edges = expandGoImports(dir, raw, ["p/a.go"]);
    expect(edges.size).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("索引层:纯 Go 仓构建后 importers 字段在场且含跨包映射;impact 无「旧格式索引」降级提示", async () => {
    const dir = mkWs();
    seedGoWs(dir);
    const index = await buildC2fIndex(dir);
    expect(index.importers).toBeDefined(); // 字段在场=版本支持(096 RC-B2 的消除点)
    expect(index.importers!["pkg/flags/flags.go"]).toEqual(["cmd/tool/main.go"]);
    // impact 面:import 通道可用 + 不再出现旧格式降级语
    const r = queryImpact(index, "Validate", { depth: 2 });
    expect(r.importChannel).toBe(true);
    expect(r.importCapable).toBe(true);
    const text = renderImpact(r);
    expect(text).not.toContain("旧格式索引:import 通道不可用");
    // 跨深度测试通道顺带验证(B3):flags_test.go 直接调 Validate(d1,同包边)在测试清单
    expect(r.tests.some((t) => t.file === "pkg/flags/flags_test.go")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
