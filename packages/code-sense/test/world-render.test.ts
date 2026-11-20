/**
 * 世界模型确定性渲染器测试:
 * ① 幂等:同一 idx 两次渲染逐字节相同(L0 与每模块 L1 页);
 * ② 预算:L0 ≤ WORLD_L0_MAX_BYTES、L1 每页 ≤ WORLD_L1_PAGE_MAX_BYTES;
 * ③ 不静默截断:超量夹具下每页出现 `…(+N`;
 * ④ 无画像不抛:purpose 面写 `(未生成)`(不编造主旨);
 * ⑤ opts 生效:入口/枢纽展示条数随 opts 收敛;
 * ⑥ 行尾无空格(注入面小产物的硬要求)。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildC2fIndex, type C2fIndex, type C2fNode, type C2fEdge } from "../src/callgraph/c2f";
import { renderWorldSkeleton, renderWorldModulePages, WORLD_L0_MAX_BYTES, WORLD_L1_PAGE_MAX_BYTES } from "../src/world/render";

let ws = "";
let index: C2fIndex;

beforeAll(async () => {
  ws = mkdtempSync(join(tmpdir(), "csworld-"));
  mkdirSync(join(ws, "core"), { recursive: true });
  mkdirSync(join(ws, "app"), { recursive: true });
  mkdirSync(join(ws, "lib"), { recursive: true });
  writeFileSync(join(ws, "core", "util.ts"), [
    "export function coreUtil(x: number): string { return \"v\" + x; }",
    "export function unusedHelper(): void {}",
    "",
  ].join("\n"));
  writeFileSync(join(ws, "app", "main.ts"), [
    "import { coreUtil } from \"../core/util\";",
    "export function runApp(): string { return coreUtil(1); }",
    "export function otherEntry(): string { return coreUtil(2); }",
    "",
  ].join("\n"));
  writeFileSync(join(ws, "lib", "tool.ts"), [
    "export function standalone(): void {}",
    "",
  ].join("\n"));
  index = await buildC2fIndex(ws);
}, 60_000);

afterAll(() => {
  if (ws) rmSync(ws, { recursive: true, force: true });
});

/** 取 markdown 里某个 `## <title>` 段的正文行(到下一个 `## ` 为止)。 */
function sectionOf(md: string, titlePrefix: string): string[] {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## ") && l.slice(3).startsWith(titlePrefix));
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("## ")) break;
    out.push(lines[i]!);
  }
  return out;
}

/** 手搓超量索引(30 模块 × 14 符号 + 跨模块边):不 loadIndex 真仓 86MB 索引。 */
function syntheticIndex(): C2fIndex {
  const nodes: C2fNode[] = [];
  const edges: C2fEdge[] = [];
  const byFile: Record<string, string[]> = {};
  const byName: Record<string, string[]> = {};
  const mods = 30;
  const symsPerMod = 14;
  for (let m = 0; m < mods; m++) {
    const mod = `m${m}`;
    for (let k = 0; k < symsPerMod; k++) {
      const file = `${mod}/f${k % 7}.ts`;
      const name = `fn${k}`;
      const id = `${file}#${name}`;
      nodes.push({ id, name, file, line: k + 1, kind: m === 0 ? "regular" : "trunk", outCount: 1, inCount: 1 });
      (byFile[file] ??= []).push(id);
      (byName[name] ??= []).push(id);
    }
  }
 // 边:m(>0) 的每个符号 → m0 的首个符号(制造 hub 与跨模块交互)
  const hubId = nodes[0]!.id;
  for (let m = 1; m < mods; m++) {
    for (let k = 0; k < symsPerMod; k++) {
      const from = `${`m${m}`}/f${k % 7}.ts#fn${k}`;
      edges.push({ from, to: hubId, toName: "fn0", file: `${`m${m}`}/f${k % 7}.ts`, line: k + 1, kind: "import" });
    }
  }
  return {
    version: 1,
    root: "/nonexistent-world-fixture",
    gitHead: "",
    builtAt: 1_700_000_000_000,
    buildMs: 1,
    nodes,
    edges,
    byFile,
    byName,
  };
}

describe("world 渲染器 · 确定性", () => {
  it("同一 idx 两次渲染逐字节相同(L0 + L1 全部页)", () => {
    const a = renderWorldSkeleton(index);
    const b = renderWorldSkeleton(index);
    expect(b).toBe(a);
    const pa = renderWorldModulePages(index);
    const pb = renderWorldModulePages(index);
    expect(pb.map((p) => `${p.module}\u0000${p.bytes}\u0000${p.markdown}`)).toEqual(
      pa.map((p) => `${p.module}\u0000${p.bytes}\u0000${p.markdown}`),
    );
  });

  it("时间戳只来自 idx.builtAt(不取 now)", () => {
    const iso = new Date(index.builtAt).toISOString();
    expect(renderWorldSkeleton(index).split("\n")[0]).toContain(`builtAt=${iso}`);
    const firstPage = renderWorldModulePages(index)[0]!;
    expect(firstPage.markdown.split("\n")[0]).toContain(`builtAt=${iso}`);
  });

  it("L0 头行带节点/边计数与 ISO 时间", () => {
    const head = renderWorldSkeleton(index).split("\n")[0]!;
    expect(head).toMatch(/^<!-- world L0 · nodes=\d+ · edges=\d+ · builtAt=\d{4}-\d{2}-\d{2}T/);
 });

 it("行尾无空格、无 \\r,且以单个换行收尾", => {
 const texts = [renderWorldSkeleton(index), ...renderWorldModulePages(index).map((p) => p.markdown)];
 for (const t of texts) {
 expect(t).not.toContain("\r");
 for (const line of t.split("\n")) expect(line).toBe(line.replace(/[ \t]+$/, ""));
 expect(t.endsWith("\n")).toBe(true);
 }
 });
});

describe("world 渲染器 · 预算与截断", => {
 it("小夹具 L0 ≤ WORLD_L0_MAX_BYTES,每页 ≤ WORLD_L1_PAGE_MAX_BYTES 且 bytes 字段与实测一致", => {
 const l0 = renderWorldSkeleton(index);
 expect(Buffer.byteLength(l0, "utf8")).toBeLessThanOrEqual(WORLD_L0_MAX_BYTES);
 for (const p of renderWorldModulePages(index)) {
 expect(p.bytes).toBe(Buffer.byteLength(p.markdown, "utf8"));
 expect(p.bytes).toBeLessThanOrEqual(WORLD_L1_PAGE_MAX_BYTES);
 }
 });

 it("超量夹具:每页 ≤ 1024B 且出现 …(+N 截断注记(L0 亦然)", => {
 const big = syntheticIndex;
 const l0 = renderWorldSkeleton(big);
 expect(Buffer.byteLength(l0, "utf8")).toBeLessThanOrEqual(WORLD_L0_MAX_BYTES);
 expect(l0).toMatch(/…\(\+\d+|超 \d+B 预算/);
 const pages = renderWorldModulePages(big);
 expect(pages.length).toBe(30);
 for (const p of pages) {
 expect(p.bytes).toBeLessThanOrEqual(WORLD_L1_PAGE_MAX_BYTES);
 expect(p.markdown).toMatch(/…\(\+\d+/);
 }
 });

 it("模块清单超量写出下钻提示(放宽预算时可见完整注记)", => {
 const l0 = renderWorldSkeleton(syntheticIndex, { maxBytes: 20_000 });
 expect(l0).toMatch(/…\(\+\d+ 模块,用 codesense world --module <name> 下钻\)/);
 });

 it("maxBytes/pageMaxBytes 可收窄并显式标注超预算", => {
 const l0 = renderWorldSkeleton(syntheticIndex, { maxBytes: 400 });
 expect(Buffer.byteLength(l0, "utf8")).toBeLessThanOrEqual(400);
 expect(l0).toMatch(/超 400B 预算/);
 const page = renderWorldModulePages(syntheticIndex, { pageMaxBytes: 300 })[0]!;
 expect(page.bytes).toBeLessThanOrEqual(300);
 expect(page.markdown).toMatch(/超 300B 预算/);
 });
});

describe("world 渲染器 · 数据面", => {
 it("无项目画像时不抛,purpose 写 (未生成)", => {
 expect( => renderWorldSkeleton(index)).not.toThrow;
 expect(renderWorldSkeleton(index)).toContain("(未生成");
 });

 it("入口/枢纽展示条数随 opts 收敛", => {
 const l0 = renderWorldSkeleton(index, { entryLimit: 1, hubLimit: 1 });
 const entryLines = sectionOf(l0, "入口 trunk").filter((l) => /^- \S+:\d+ /.test(l));
 expect(entryLines.length).toBeLessThanOrEqual(1);
 const hubLines = sectionOf(l0, "枢纽").filter((l) => l.startsWith("- ") && l.includes("被 "));
 expect(hubLines.length).toBeLessThanOrEqual(1);
 const wide = renderWorldSkeleton(index, { entryLimit: 20, hubLimit: 10 });
 expect(sectionOf(wide, "入口 trunk").filter((l) => /^- \S+:\d+ /.test(l)).length)
 .toBeGreaterThanOrEqual(entryLines.length);
 });

 it("模块清单行数 = 模块数(未超上限时每模块一行)", => {
 const groups = new Set(index.nodes.map((n) => n.file.split("/")[0]!));
 const lines = sectionOf(renderWorldSkeleton(index), "模块清单").filter((l) => /^- \S+ — /.test(l));
 expect(lines.length).toBe(groups.size);
 });

 it("L1 页覆盖全部模块且每页带模块名/职责/关键文件", => {
 const pages = renderWorldModulePages(index, { topFiles: 1, exportLimit: 1 });
 expect(pages.map((p) => p.module).sort).toEqual([...new Set(index.nodes.map((n) => n.file.split("/")[0]!))].sort);
 for (const p of pages) {
 expect(p.markdown).toContain(`# 模块 ${p.module}`);
 expect(p.markdown).toContain("职责:");
 expect(p.markdown).toContain("关键文件");
 }
 });
});

import { readFileSync } from "node:fs";

describe("职责来源证据锚点(Zread 形态)", => {
 let aws = "";
 let aidx: C2fIndex;
 beforeAll(async => {
 aws = mkdtempSync(join(tmpdir, "csworld-anchor-"));
 mkdirSync(join(aws, "pkgx"), { recursive: true });
 // description 键在第 4 行(行号必须真:渲染器要读文件定位到这一行)
 writeFileSync(join(aws, "pkgx", "package.json"), [
 "{",
 ' "name": "pkgx",',
 ' "version": "1.0.0",',
 ' "description": "anchor fixture duty"',
 "}",
 "",
 ].join("\n"));
 writeFileSync(join(aws, "pkgx", "index.ts"), [
 "export function anchorA: string { return anchorB; }",
 'export function anchorB: string { return "b"; }',
 "",
 ].join("\n"));
 mkdirSync(join(aws, "readme-mod"), { recursive: true });
 writeFileSync(join(aws, "readme-mod", "README.md"), ["# readme-mod — reading fixture duty", "", "some paragraph text", ""].join("\n"));
 writeFileSync(join(aws, "readme-mod", "index.ts"), ["export function readmeFn: void {}", ""].join("\n"));
 mkdirSync(join(aws, "bare"), { recursive: true });
 writeFileSync(join(aws, "bare", "b.ts"), ["export function bareFn: void {}", ""].join("\n"));
 aidx = await buildC2fIndex(aws);
 }, 60_000);
 afterAll( => {
 if (aws) rmSync(aws, { recursive: true, force: true });
 });

 it("package.json description → 职责来源行带真实 file:line", => {
 const page = renderWorldModulePages(aidx).find((p) => p.module === "pkgx");
 expect(page).toBeDefined;
 const srcLine = page!.markdown.split("\n").find((l) => l.startsWith("- 职责来源:"))!;
 expect(srcLine).toContain("pkgx/package.json:4");
 // 行号必须真:夹具第 4 行正是 description 键所在行
 const real = readFileSync(join(aws, "pkgx", "package.json"), "utf-8").split("\n")[3]!;
 expect(real).toContain('"description"');
 expect(page!.markdown).toContain("anchor fixture duty");
 });

 it("README 首段来源也带真依据点", => {
 const page = renderWorldModulePages(aidx).find((p) => p.module === "readme-mod");
 expect(page).toBeDefined;
 expect(page!.markdown).toContain("readme-mod/README.md:1");
 const real = readFileSync(join(aws, "readme-mod", "README.md"), "utf-8").split("\n")[0]!;
 expect(real).toContain("reading fixture duty");
 });

 it("推断来源保留原标签(不硬造锚点)", => {
 const bare = renderWorldModulePages(aidx).find((p) => p.module === "bare")!;
 const srcLine = bare.markdown.split("\n").find((l) => l.startsWith("- 职责来源:"))!;
 expect(srcLine).toMatch(/^- 职责来源: (名称推断|拓扑推断)$/);
 });

 it("每页 ≤1024B 且两次渲染逐字节相同", => {
 const a = renderWorldModulePages(aidx);
 const b = renderWorldModulePages(aidx);
 expect(b.map((p) => `${p.module}\u0000${p.bytes}\u0000${p.markdown}`)).toEqual(
 a.map((p) => `${p.module}\u0000${p.bytes}\u0000${p.markdown}`),
);
 for (const p of a) {
 expect(p.bytes).toBe(Buffer.byteLength(p.markdown, "utf8"));
 expect(p.bytes).toBeLessThanOrEqual(WORLD_L1_PAGE_MAX_BYTES);
 }
 });
});
