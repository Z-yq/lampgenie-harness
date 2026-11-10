/**
 * 代码档案 × code flow(2026-10-26):flow 页持久化 + 模块 flow 子页 + 语义指南/功能拆解。
 * 双路径:有索引=符号级(module/file 两层);无索引=词法级(既有 wiki.test 覆盖)。
 * LLM 只写带引用回查的语义解读,flow 骨架/图仍由确定性构建器产出。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { buildC2fIndex, saveIndex } from "../src/callgraph/c2f";
import { rebuildWiki, listWiki } from "../src/wiki/index";

const created: string[] = [];

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "gg-wikiflow-"));
  created.push(dir);
  const files: Record<string, string> = {
    "README.md": "# flow-demo\n\nA tiny two-package demo for code flow wiki.\n",
    "package.json": JSON.stringify({ name: "flow-demo", version: "0.1.0" }, null, 2),
    "packages/alpha/package.json": JSON.stringify({ name: "@demo/alpha", version: "0.1.0", description: "Alpha 包:示例入口与帮助函数", bin: { alpha: "./src/index.ts" } }, null, 2),
    "packages/alpha/src/index.ts": [
      'import { help } from "./util";',
      "",
      "export interface AlphaOptions {",
      "  verbose?: boolean;",
      "}",
      "",
      "export function runAlpha(opts: AlphaOptions): string {",
      '  return help("alpha") + (opts.verbose ? "!" : "");',
      "}",
      "",
      "export function alphaMain(): string {",
      "  return runAlpha({ verbose: true });",
      "}",
    ].join("\n"),
    "packages/alpha/src/util.ts": [
      "export function help(name: string): string {",
      '  return "help:" + name;',
      "}",
    ].join("\n"),
    "packages/beta/package.json": JSON.stringify({ name: "@demo/beta", version: "0.1.0", description: "Beta 包:复用 alpha 的示例" }, null, 2),
    "packages/beta/src/index.ts": [
      'import { runAlpha } from "../../alpha/src/index";',
      'import { processItems } from "./worker";',
      "",
      "export function runBeta(n: number): string {",
      '  return runAlpha({ verbose: false }) + processItems(n);',
      "}",
    ].join("\n"),
    "packages/beta/src/worker.ts": [
      "/** 偶数/奇数分流。 */",
      "export function processItems(n: number): string {",
      '  let out = "";',
      "  // 逐项判断",
      "  for (let i = 0; i < n; i++) {",
      "    if (i % 2 === 0) {",
      '      out += "even";',
      "    } else {",
      '      out += "odd";',
      "    }",
      "  }",
      "  return out;",
      "}",
    ].join("\n"),
    "apps/cli/src/main.ts": [
      'import { runBeta } from "../../../packages/beta/src/index";',
      "",
      "export function main(): string {",
      "  return runBeta(3);",
      "}",
    ].join("\n"),
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

function wikiOut(dir: string): string {
  return join(dir, ".genie/wiki", basename(dir));
}

let sharedDir = "";
beforeAll(async () => {
  sharedDir = fixture();
  const idx = await buildC2fIndex(sharedDir);
  saveIndex(sharedDir, idx);
}, 120_000);
afterAll(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

describe("代码档案 × code flow", () => {
  it("有索引:生成 flow/模块 flow/指南/功能拆解页;manifest.flow=符号级;图/mermaid 可渲染", async () => {
    const dir = sharedDir;
    const res = await rebuildWiki(dir, { withLlm: false });
    const ids = res.manifest.pages.map((p) => p.id);
    expect(ids).toContain("flow");
    expect(ids).toContain("guide");
    expect(ids).toContain("features");
    expect(ids.some((id) => id.startsWith("flow/"))).toBe(true);
    expect(res.manifest.flow?.source).toBe("index");
    expect(res.manifest.flow!.features.length).toBeGreaterThan(0);
    // flow 页有模块图 + 入口表 + 分层;功能拆解页有 F1 + 子图
    const flowMd = readFileSync(join(wikiOut(dir), "flow.md"), "utf-8");
    expect(flowMd).toContain("全仓代码流");
    expect(flowMd).toContain("```mermaid");
    expect(flowMd).toContain("入口与主干");
    expect(flowMd).toContain("模块作用(图旁斜体)");
    expect(flowMd).toContain("Alpha 包:示例入口与帮助函数");
    expect(flowMd).toContain("<i>Alpha 包");
    expect(flowMd).toContain("分层");
    const featMd = readFileSync(join(wikiOut(dir), "features.md"), "utf-8");
    expect(featMd).toContain("功能拆解");
    const guideMd = readFileSync(join(wikiOut(dir), "guide.md"), "utf-8");
    expect(guideMd).toContain("作用/角色(来源)");
    expect(guideMd).toContain("Alpha 包:示例入口与帮助函数");
    expect(featMd).toMatch(/## F1 ·/);
    expect(featMd).toContain("```mermaid");
    // 关键流程图:每条管线一页,函数体语句级 CFG(真实语句/是·否/循环)
    const cfgMeta = res.manifest.pages.find((p) => p.kind === "algo");
    expect(cfgMeta).toBeTruthy();
    expect(cfgMeta!.id.startsWith("cfg/")).toBe(true);
    const cfgMd = readFileSync(join(wikiOut(dir), cfgMeta!.file), "utf-8");
    expect(cfgMd).toContain("关键流程图");
    expect(cfgMd).toContain("processItems");
    expect(cfgMd).toContain("out +=");
    expect(cfgMd).toContain("是");
    expect(cfgMd).toContain("否");
    expect(cfgMd).toContain("循环");
    expect(cfgMd).toContain("```mermaid");
    expect(cfgMd).toContain("候选函数(选择过程)");
    expect(cfgMd).toContain("关键函数一览");
    expect(cfgMd).toContain("### 函数速览");
    expect(cfgMd).toContain("| 职责 |");
    expect(cfgMd).toContain("| 输入 |");
    expect(cfgMd).toContain("| 输出 |");
    expect(cfgMd).toContain("| 上游调用方 |");
    // 每个页面引用都过回查
    expect(res.manifest.citationAudit.failed).toBe(0);
  }, 120_000);

  it("LLM:guide/features 消费 code flow 骨架(提示词含骨架),叙述带引用回查", async () => {
    const dir = sharedDir;
    const prompts: string[] = [];
    const makeAnswer = (prompt: string) => {
      const id = /\[id=([^\]]+)\]/.exec(prompt)?.[1] ?? "all";
      return JSON.stringify({
        summary: "两包示例:alpha 提供帮助函数,beta 复用 alpha。",
        sections: [{
          heading: "启动链",
          body: "入口 apps/cli 调用 beta,beta 复用 alpha 的 runAlpha。",
          cites: [{ file: "packages/alpha/src/index.ts", startLine: 7, endLine: 7, anchor: "export function runAlpha(opts: AlphaOptions): string {" }],
        }],
        features: [{
          id,
          name: "命令行入口",
          description: "从命令行启动并复用 alpha/beta 的示例能力。",
          cites: [{ file: "packages/alpha/src/index.ts", startLine: 7, endLine: 7, anchor: "export function runAlpha(opts: AlphaOptions): string {" }],
        }],
      });
    };
    const llm = { async generate(prompt: string) { prompts.push(prompt); return makeAnswer(prompt); } };
    const res = await rebuildWiki(dir, { llm, withLlm: true, config: { maxLlmPages: 3 } });
    const guide = res.manifest.pages.find((p) => p.id === "guide");
    const features = res.manifest.pages.find((p) => p.id === "features");
    expect(guide?.generator).toBe("llm+validated");
    expect(features?.generator).toBe("llm+validated");
    expect(res.manifest.llm.pages).toEqual(expect.arrayContaining(["guide", "features"]));
    const featMd = readFileSync(join(wikiOut(dir), "features.md"), "utf-8");
    expect(featMd).toContain("命令行入口"); // LLM 语义命名(表头/功能线标题)
    expect(featMd).toContain("语义描述");
    // 提示词带确定性骨架纪律
    const guidePrompt = prompts.find((p) => p.includes("语义级代码指南"));
    expect(guidePrompt).toBeTruthy();
    expect(guidePrompt).toContain("代码流骨架");
    const featPrompt = prompts.find((p) => p.includes("功能拆解"));
    expect(featPrompt).toContain("代码流骨架");
    const list = await listWiki(dir);
    expect(list.manifest?.flow?.source).toBe("index");
  }, 120_000);

  it("flow:false 关闭 flow 页(旧行为/快速重建)", async () => {
    const dir = sharedDir;
    const res = await rebuildWiki(dir, { withLlm: false, flow: false });
    const ids = res.manifest.pages.map((p) => p.id);
    expect(ids).not.toContain("flow");
    expect(ids).not.toContain("guide");
    expect(ids).not.toContain("features");
    expect(res.manifest.flow).toBeUndefined();
  }, 120_000);

  it("flow 开关参与缓存键:--no-flow 之后不带开关重建,flow 页会回来(不命中旧 manifest)", async () => {
    const dir = sharedDir;
    const res = await rebuildWiki(dir, { withLlm: false });
    const ids = res.manifest.pages.map((p) => p.id);
    expect(ids).toContain("flow");
    expect(ids).toContain("guide");
    expect(ids).toContain("features");
    expect(res.manifest.flow).toBeTruthy();
  }, 120_000);
});