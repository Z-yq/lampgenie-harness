import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Project } from "ts-morph";
import {
  extractInlineJsUnits, parseInlineJsAst, parseInlineJsAstTolerant, collectInlineJs, inlineJsTextCandidate,
} from "../src/callgraph/inline-js";
import { buildCallGraphFromFiles } from "../src/callgraph/engine";
import { buildC2fIndex, querySymbol, queryFile, saveIndex } from "../src/callgraph/c2f";
import { fileSymbolsOf } from "../src/index";

/** senseB21:内嵌脚本索引单测(虚拟 JS 提取/符号登记/inline 作用域边/kind 贯通)。 */

function writeFixture(dir: string): string {
  // 宿主 TS + 模板内嵌 SPA:<script> 块(function 声明+const 箭头+模块级接线+插值)
  const src = [
    "const PRESETS = JSON.stringify([{ id: 1 }]);",
    "const PAGE = `<!doctype html><html><head><style>.x{color:red}</style></head><body>",
    "<div id=\"view-board\"></div>",
    "<script src=\"/assets/ext.js\"></script>",
    "<script>",
    "function refreshModelPill() { renderPill(); }",
    "function renderPill() { deep(1); }",
    "const deep = (n) => { sink(n); };",
    "function sink(n) { if (n > 0) refreshModelPill(); }",
    "$(\"act-board\").onclick = () => switchView(\"board\");",
    "const CFG = ${PRESETS};",
    "setTimeout(tick, 500);",
    "</script>",
    "</body></html>`;",
    "export function realTsSide(): number { return 1; }",
    "",
  ].join("\n");
  const f = join(dir, "panel.ts");
  writeFileSync(f, src);
  return f;
}

describe("senseB21 内嵌脚本提取(extractInlineJsUnits/parseInlineJsAst)", () => {
  it("script 块提取:外链跳过、行号精确、插值替换保行", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-injs-"));
    try {
      const f = writeFixture(dir);
      const project = new Project({ skipAddingFilesFromTsConfig: true });
      const sf = project.addSourceFileAtPath(f);
      const units = extractInlineJsUnits(sf, "panel.ts");
      // 只有内联 script(src= 外链跳过)
      expect(units).toHaveLength(1);
      const u = units[0]!;
      expect(u.unit).toBe("panel.ts:script-1");
      expect(u.container).toBe("PAGE·script-1");
      expect(u.startLine).toBe(5); // <script> 所在行
      expect(u.approxLines).toBe(false); // ${PRESETS} 单行插值:行号不漂移
      expect(u.js).toContain("undefined"); // 插值已替换
      expect(u.js).not.toContain("${PRESETS}");
      // 行号精确核对:refreshModelPill 在宿主第 6 行
      const ast = await parseInlineJsAst(u.js);
      expect(ast).toBeDefined();
      const refresh = ast!.decls.find((d) => d.name === "refreshModelPill");
      expect(refresh).toBeDefined();
      expect(u.startLine + refresh!.row).toBe(6);
      const deep = ast!.decls.find((d) => d.name === "deep");
      expect(deep?.kind).toBe("arrow");
      expect(u.startLine + deep!.row).toBe(8);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("非 JS 内容不产单元(mermaid/CSS/密度不足)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-injs2-"));
    try {
      const f = join(dir, "doc.ts");
      writeFileSync(f, [
        "const CSS = `.a{color:red}.b{margin:0}`;",
        "const MERMAID = `flowchart TD",
        "  a --> b",
        "`;",
        "const SHORT = `<script>reset();</script>`;", // 密度 0
        "const PROSE = `This function does nothing. Use it well.`;", // 散文(无 function 声明形态)
        "",
      ].join("\n"));
      const project = new Project({ skipAddingFilesFromTsConfig: true });
      const sf = project.addSourceFileAtPath(f);
      const units = extractInlineJsUnits(sf, "doc.ts");
      expect(units).toHaveLength(0);
      expect(inlineJsTextCandidate("const x = 1;")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("语法错误单元静默跳过(诚实降级,零假符号)", async () => {
    const ast = await parseInlineJsAst("function broken( { <<< totally not js");
    expect(ast).toBeUndefined();
  }, 30_000);

  it("大脚本局部语法错:容错切段只丢坏段,好段符号/行号照常(2026-11-08 panel 盲区修复)", async () => {
    const js = [
      "function goodA() { goodB(); }",
      "",
      "function goodB() {}",
      "",
      "function broken( { <<< not js",
      "",
      "function goodC() { goodA(); }",
    ].join("\n");
    // 整段仍诚实判死(不产半成品)
    expect(await parseInlineJsAst(js)).toBeUndefined();
    const ast = await parseInlineJsAstTolerant(js);
    expect(ast).toBeDefined();
    expect(ast!.partial).toBe(true);
    const names = ast!.decls.map((d) => d.name);
    expect(names).toContain("goodA");
    expect(names).toContain("goodB");
    expect(names).toContain("goodC");
    expect(names).not.toContain("broken"); // 坏段整体丢弃
    // 行号按段基址回填到整段坐标系(goodC 在整段第 7 行,0-based row=6)
    const c = ast!.decls.find((d) => d.name === "goodC")!;
    expect(c.row).toBe(6);
    // 调用也带段偏移:goodC 内对 goodA 的调用在第 7 行
    const call = ast!.calls.find((x) => x.name === "goodA");
    expect(call).toBeDefined();
    expect(call!.row).toBe(6);
  }, 30_000);
});

describe("senseB21 引擎接入(collectInlineJs/buildCallGraphFromFiles)", () => {
  it("内嵌函数进 callgraph:kind=inline-js、inline 作用域边、<module> 归属", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-injs3-"));
    try {
      writeFixture(dir);
      const graph = await buildCallGraphFromFiles(dir, ["panel.ts"]);
      const sym = (name: string) => [...graph.symbols.values()].find((s) => s.name === name);
      // 宿主真 TS 符号照常
      expect(sym("realTsSide")?.kind).toBe("function");
      // 内嵌虚拟符号:kind=inline-js、file=宿主、行号精确
      const refresh = sym("refreshModelPill");
      expect(refresh?.kind).toBe("inline-js");
      expect(refresh?.file.endsWith("panel.ts")).toBe(true);
      expect(refresh?.line).toBe(6);
      expect(refresh?.container).toBe("PAGE·script-1");
      // inline 作用域边:refresh → renderPill → deep → sink → refresh(环)
      const callersOf = (name: string) => [...graph.inEdges.get(sym(name)!.id) ?? []].map((e) => e.from.split("#").pop());
      const calleesOf = (name: string) => [...graph.outEdges.get(sym(name)!.id) ?? []].map((e) => e.to ? e.to.split("#").pop() : `(${e.toName})`);
      expect(callersOf("renderPill")).toContain("PAGE·script-1.refreshModelPill");
      expect(callersOf("refreshModelPill")).toContain("PAGE·script-1.sink");
      expect(calleesOf("refreshModelPill")).toContain("PAGE·script-1.renderPill");
      // 跨不出宿主 TS:setTimeout 未解析边(无 to);噪声名(setTimeout)不进边表
      expect(calleesOf("deep")).toEqual(["PAGE·script-1.sink"]);
      // 模块级归属:顶层接线调用归 <module>
      const modEdges = graph.outEdges.get(`${refresh!.file}#<module>`) ?? [];
      expect(modEdges.some((e) => e.toName === "switchView")).toBe(true);
      expect(modEdges.some((e) => e.toName === "setTimeout")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("collectInlineJs 非候选文件零成本返回 null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-injs4-"));
    try {
      const f = join(dir, "plain.ts");
      writeFileSync(f, "export const one = 1;\n");
      const project = new Project({ skipAddingFilesFromTsConfig: true });
      const sf = project.addSourceFileAtPath(f);
      expect(await collectInlineJs(sf, { symbols: new Map(), outEdges: new Map(), inEdges: new Map(), byName: new Map(), buildMs: 0 } as never, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("senseB21/senseB23 索引贯通(C2fIndex + 查询面)", () => {
  it("内嵌函数进 c2f 索引:symbol/file 查询可查、symKind=inline-js、trunk/leaf 语义", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-injs5-"));
    try {
      writeFixture(dir);
      const idx = await buildC2fIndex(dir);
      const hits = querySymbol(idx, "refreshModelPill");
      expect(hits).toHaveLength(1);
      expect(hits[0]!.symbol.symKind).toBe("inline-js");
      expect(hits[0]!.symbol.file).toBe("panel.ts");
      expect(hits[0]!.symbol.line).toBe(6);
 // 上游(sink)/下游(renderPill)非空——任务3 验径
      expect(hits[0]!.callers.length).toBeGreaterThan(0);
      expect(hits[0]!.callees.length).toBeGreaterThan(0);
      expect(hits[0]!.callers[0]!.name).toBe("PAGE·script-1.sink");
      // 文件符号表:panel.ts 同文件混排真 TS 与内嵌符号
      const fileNodes = queryFile(idx, "panel.ts");
      expect(fileNodes.some((n) => n.name === "realTsSide")).toBe(true);
      expect(fileNodes.some((n) => n.symKind === "inline-js")).toBe(true);
      // trunk/leaf 语义:inline 符号参与(renderPill 被 refresh 调 → 非 trunk)
      const renderPill = querySymbol(idx, "renderPill")[0]!;
      expect(renderPill.symbol.kind).not.toBe("trunk");
      // 签名:JS 参数名(无类型)
      expect(renderPill.symbol.sig?.params).toEqual([]);
      const deep = querySymbol(idx, "deep")[0]!;
      expect(deep.symbol.sig?.params.map((p) => p.name)).toEqual(["n"]);
      // fileSymbolsOf 显示面:kind 如实 inline-js(任务3 挡板排查面)
      saveIndex(dir, idx);
      const fsr = await fileSymbolsOf(dir, "panel.ts");
      expect(fsr.symbols.find((s) => s.name === "refreshModelPill")?.kind).toBe("inline-js");
      expect(fsr.symbols.find((s) => s.name === "realTsSide")?.kind).toBe("function");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
