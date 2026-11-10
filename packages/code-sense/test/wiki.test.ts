/**
 * wiki 单测:确定性骨架/引用回查/缓存/增量/LLM 注入与降级/词法问答。
 * 不依赖真实 LLM 与网络。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  rebuildWiki, listWiki, getWikiPage, askWiki, auditWikiCitations, extractKeywords,
} from "../src/wiki/index";

const created: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "gh-wiki-"));
  created.push(dir);
  const files: Record<string, string> = {
    "README.md": [
      "# demo-monorepo",
      "",
      "A tiny demo with two workspace packages.",
      "",
      "## Usage",
      "",
      "npm test",
    ].join("\n"),
    "package.json": JSON.stringify({ name: "demo-monorepo", version: "0.1.0", description: "demo wiki fixture", scripts: { test: "vitest" } }, null, 2),
    "packages/alpha/package.json": JSON.stringify({ name: "@demo/alpha", version: "0.1.0" }, null, 2),
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
      "export const alphaVersion = 1;",
    ].join("\n"),
    "packages/alpha/src/util.ts": [
      "export function help(name: string): string {",
      '  return "help:" + name;',
      "}",
    ].join("\n"),
    "packages/beta/package.json": JSON.stringify({ name: "@demo/beta", version: "0.1.0" }, null, 2),
    "packages/beta/src/index.ts": [
      'import { help } from "../../alpha/src/util";',
      "",
      "export function runBeta(): string {",
      '  return help("beta");',
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

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

describe("确定性骨架 + 引用回查", () => {
  it("生成 9 页(概览/全仓流程/树/两模块/入口/依赖/指南/功能拆解),每页 ≥5 条可回查引用", async () => {
    const dir = fixture();
    const res = await rebuildWiki(dir, { withLlm: false });
    expect(res.hit).toBe(false);
    expect(res.manifest.pages.map((p) => p.id)).toEqual([
      "overview", "flow", "file-tree", "modules/packages-alpha", "modules/packages-beta", "entrypoints", "dependencies", "guide", "features",
    ]);
 // 无索引时 flow 明确降级为词法级(页面/manifest 同口径)
    expect(res.manifest.flow?.source).toBe("lexical");
    const flowPage = readFileSync(join(wikiOut(dir), "flow.md"), "utf-8");
    expect(flowPage).toContain("全仓代码流");
    expect(flowPage).toContain("```mermaid");
    const featuresPage = readFileSync(join(wikiOut(dir), "features.md"), "utf-8");
    expect(featuresPage).toContain("功能拆解");
    expect(res.manifest.llm.enabled).toBe(false);
    expect(res.manifest.degraded.some((d) => d.layer === "llm")).toBe(true);
    for (const p of res.manifest.pages) {
      expect(p.citations.length, p.id).toBeGreaterThanOrEqual(5);
      expect(p.generator).toBe("deterministic");
      const md = readFileSync(join(wikiOut(dir), p.file), "utf-8");
      expect(md).toContain("## 引用(行号可校验)");
    }
    const audit = await auditWikiCitations(dir);
    expect(audit.failed).toBe(0);
    expect(audit.checked).toBeGreaterThanOrEqual(30);
    // 行号抽检:manifest 每条 citation 的 anchor 必须真的在文件范围内
    for (const p of res.manifest.pages) {
      for (const c of p.citations) {
        const lines = readFileSync(join(dir, c.file), "utf-8").split(/\r?\n/);
        const range = lines.slice(c.startLine - 1, c.endLine).join("\n").replace(/\s+/g, " ");
        expect(range, `${p.id} ${c.file}:${c.startLine}`).toContain(c.anchor.replace(/\s+/g, " "));
      }
    }
  });

  it("依赖图含跨模块 + 文件级 mermaid 与证据行", async () => {
    const dir = fixture();
    const res = await rebuildWiki(dir, { withLlm: false });
    const graphScopes = res.manifest.graphs.map((g) => g.scope).sort();
    expect(graphScopes).toEqual(["file", "module"]);
    const moduleGraph = res.manifest.graphs.find((g) => g.scope === "module")!;
    expect(moduleGraph.mermaid).toContain("flowchart TD");
    expect(moduleGraph.edges.some((e) => e.from === "packages/beta" && e.to === "packages/alpha")).toBe(true);
    const dep = await getWikiPage(dir, "dependencies");
    expect(dep?.markdown).toContain("```mermaid");
    expect(dep?.markdown).toContain("packages/beta/src/index.ts:1 — import");
  });
});

describe("缓存与增量", () => {
  it("二次 rebuild 命中 sha/指纹,零生成", async () => {
    const dir = fixture();
    const first = await rebuildWiki(dir, { withLlm: false });
    const second = await rebuildWiki(dir, { withLlm: false });
    expect(second.hit).toBe(true);
    expect(second.rebuilt).toEqual([]);
    expect(second.manifest.generatedAt).toBe(first.manifest.generatedAt);
    expect(second.reason).toContain("零生成");
  });

  it("源码变更→只重建受影响模块页,未变模块复用", async () => {
    const dir = fixture();
    await rebuildWiki(dir, { withLlm: false });
    appendFileSync(join(dir, "packages/alpha/src/util.ts"), "\nexport const extra = 2;\n");
    const res = await rebuildWiki(dir, { withLlm: false });
    expect(res.hit).toBe(false);
    expect(res.rebuilt).toContain("modules/packages-alpha");
    expect(res.reused).toContain("modules/packages-beta");
    // 全仓页(概览/树/入口/依赖)按设计重建
    expect(res.rebuilt).toContain("overview");
    expect(res.reused).not.toContain("overview");
  });

  it("LLM 模式参与缓存键:确定性缓存不会被 LLM 调用误命中", async () => {
    const dir = fixture();
    await rebuildWiki(dir, { withLlm: false });
    let calls = 0;
    const llm = {
      async generate() {
        calls++;
        return JSON.stringify({
          summary: "s", sections: [{
            heading: "h", body: "b",
            cites: [{ file: "packages/alpha/src/index.ts", startLine: 7, endLine: 7, anchor: "export function runAlpha(opts: AlphaOptions): string {" }],
          }],
        });
      },
    };
    const res = await rebuildWiki(dir, { llm, withLlm: true, config: { maxLlmPages: 1 } });
    expect(res.hit).toBe(false);
    expect(calls).toBe(1);
    expect(res.manifest.pages.find((p) => p.id === "overview")?.generator).toBe("llm+validated");
    // 同模式再跑=命中,零调用
    const again = await rebuildWiki(dir, { llm, withLlm: true, config: { maxLlmPages: 1 } });
    expect(again.hit).toBe(true);
    expect(calls).toBe(1);
  });

  it("生成器版本变化→全页失效(禁止旧结构页被复用)", async () => {
    const dir = fixture();
    await rebuildWiki(dir, { withLlm: false });
    const mf = JSON.parse(readFileSync(join(wikiOut(dir), "manifest.json"), "utf-8"));
    mf.generatorVersion = 1;
    writeFileSync(join(wikiOut(dir), "manifest.json"), JSON.stringify(mf));
    const res = await rebuildWiki(dir, { withLlm: false });
    expect(res.hit).toBe(false);
    expect(res.rebuilt.length).toBe(res.manifest.pages.length);
    expect(res.reused).toEqual([]);
  });

  it("refresh=true 强制全量重建", async () => {
    const dir = fixture();
    await rebuildWiki(dir, { withLlm: false });
    const res = await rebuildWiki(dir, { withLlm: false, refresh: true });
    expect(res.hit).toBe(false);
    expect(res.rebuilt.length).toBe(res.manifest.pages.length);
    expect(res.reused).toEqual([]);
  });
});

describe("LLM 注入(引用回查/降级)", () => {
  it("有效引用进入 LLM 页;伪造引用的 section 整段丢弃", async () => {
    const dir = fixture();
    let calls = 0;
    const llm = {
      async generate(prompt: string) {
        calls++;
        expect(prompt).toContain("源码摘录");
        return JSON.stringify({
          summary: "演示仓库导读",
          sections: [
            {
              heading: "Alpha 能力",
              body: "runAlpha 提供统一的命令行入口。",
              cites: [
                { file: "packages/alpha/src/index.ts", startLine: 7, endLine: 7, anchor: "export function runAlpha(opts: AlphaOptions): string {" },
              ],
            },
            {
              heading: "伪造小节",
              body: "这一节引用不存在的位置。",
              cites: [{ file: "packages/alpha/src/index.ts", startLine: 7, endLine: 7, anchor: "完全不存在的代码片段" }],
            },
          ],
        });
      },
    };
    const res = await rebuildWiki(dir, { llm, withLlm: true, config: { maxLlmPages: 1 } });
    expect(calls).toBe(1);
    const overview = res.manifest.pages.find((p) => p.id === "overview")!;
    expect(overview.generator).toBe("llm+validated");
    expect(overview.llm).toBe("on");
    const md = readFileSync(join(wikiOut(dir), overview.file), "utf-8");
    expect(md).toContain("## 导读(LLM 叙述");
    expect(md).toContain("Alpha 能力");
    expect(md).not.toContain("伪造小节");
    expect(res.manifest.citationAudit.droppedSections).toBe(1);
    expect(res.manifest.llm.pages).toContain("overview");
  });

  it("LLM 返回坏 JSON→两次尝试后确定性降级(llm=failed + degraded)", async () => {
    const dir = fixture();
    let calls = 0;
    const llm = { async generate() { calls++; return "这不是 JSON"; } };
    const res = await rebuildWiki(dir, { llm, withLlm: true, config: { maxLlmPages: 1 } });
    expect(calls).toBe(2); // 首轮 + 1 次修复
    const overview = res.manifest.pages.find((p) => p.id === "overview")!;
    expect(overview.generator).toBe("deterministic");
    expect(overview.llm).toBe("failed");
    expect(res.manifest.degraded.some((d) => d.layer === "llm" && d.reason.includes("overview"))).toBe(true);
    expect(res.manifest.llm.failed).toBe(1);
  });
});

describe("降级保护(无凭证不得静默覆盖 LLM 页)", () => {
  const MARKER = "LLM-ONLY-MARKER-7f3a9c:这段导读由线上模型生成,不得被无凭证降级静默覆盖。";
  /** 造「LLM 模式已生成 overview」的初始态:overview=llm+validated 且带可识别长标记。 */
  async function seedLlmWiki(dir: string): Promise<string> {
    const llm = {
      async generate() {
        return JSON.stringify({
          summary: MARKER,
          sections: [{
            heading: "Alpha 能力",
            body: `runAlpha 提供命令行入口。${MARKER}`,
            cites: [{ file: "packages/alpha/src/index.ts", startLine: 7, endLine: 7, anchor: "export function runAlpha(opts: AlphaOptions): string {" }],
          }],
        });
      },
    };
    const first = await rebuildWiki(dir, { llm, withLlm: true, config: { maxLlmPages: 1 } });
    expect(first.manifest.llm.enabled).toBe(true);
    expect(first.manifest.llm.pages).toContain("overview");
    const before = first.manifest.pages.find((p) => p.id === "overview")!;
    expect(before.generator).toBe("llm+validated");
    expect(readFileSync(join(wikiOut(dir), before.file), "utf-8")).toContain(MARKER);
    return readFileSync(join(wikiOut(dir), before.file), "utf-8");
  }

  it("无凭证 + 非 refresh + 非显式 --no-llm:LLM 页逐字保留并给出告警", async () => {
    const dir = fixture();
    const originalMd = await seedLlmWiki(dir);
    const seededManifest = JSON.parse(readFileSync(join(wikiOut(dir), "manifest.json"), "utf-8"));
    const seededOverview = seededManifest.pages.find((p: { id: string }) => p.id === "overview");

    // 无 LLM 注入、不 refresh、不显式 no-llm(模拟无凭证环境)
    const res = await rebuildWiki(dir, { withLlm: false });
    expect(res.hit).toBe(false);
    // 页 md 逐字未变
    expect(readFileSync(join(wikiOut(dir), "overview.md"), "utf-8")).toBe(originalMd);
    // 页不被重生成
    expect(res.rebuilt).not.toContain("overview");
    expect(res.reused).toContain("overview");
    // manifest 保留该页元数据 + 记 llm 页
    const overview = res.manifest.pages.find((p) => p.id === "overview")!;
    expect(overview.generator).toBe("llm+validated");
    expect(overview.llm).toBe("on");
    expect(overview.llmInputHash).toBe(seededOverview.llmInputHash);
    expect(overview.updatedAt).toBe(seededOverview.updatedAt);
    expect(res.manifest.llm.pages).toContain("overview");
    // 显著告警 + 正确计数
    expect(res.warnings).toEqual(["LLM 页 1 页保留(无凭证;--refresh --no-llm 才会降级覆盖)"]);
    expect(res.manifest.degraded.some((d) => d.layer === "llm" && d.reason.includes("LLM 页 1 页保留"))).toBe(true);
    // 确定性页照常按原逻辑重建(全仓页 wide → 重建)
    expect(res.rebuilt).toContain("file-tree");

    // 再次同条件=缓存短路,但告警仍不得消失
    const again = await rebuildWiki(dir, { withLlm: false });
    expect(again.hit).toBe(true);
    expect(again.warnings).toEqual(["LLM 页 1 页保留(无凭证;--refresh --no-llm 才会降级覆盖)"]);
    expect(readFileSync(join(wikiOut(dir), "overview.md"), "utf-8")).toBe(originalMd);
  });

  it("refresh + 显式 explicitNoLlm:允许降级覆盖,且无保留告警", async () => {
    const dir = fixture();
    await seedLlmWiki(dir);
    const res = await rebuildWiki(dir, { refresh: true, withLlm: false, explicitNoLlm: true });
    expect(res.hit).toBe(false);
    expect(res.rebuilt).toContain("overview");
    const overview = res.manifest.pages.find((p) => p.id === "overview")!;
    expect(overview.generator).toBe("deterministic");
    expect(overview.llm).toBe("off");
    const md = readFileSync(join(wikiOut(dir), "overview.md"), "utf-8");
    expect(md).not.toContain(MARKER);
    expect(md).toContain("## 引用(行号可校验)");
    expect((res.warnings ?? []).some((w) => w.includes("保留"))).toBe(false);
  });

  it("显式 explicitNoLlm 但无 refresh:仍走保护(唯一降级路径是 refresh + --no-llm)", async () => {
    const dir = fixture();
    const originalMd = await seedLlmWiki(dir);
    const res = await rebuildWiki(dir, { withLlm: false, explicitNoLlm: true });
    expect(readFileSync(join(wikiOut(dir), "overview.md"), "utf-8")).toBe(originalMd);
    expect(res.warnings?.[0]).toContain("LLM 页 1 页保留");
  });

  it("不回归:LLM 模式一致且输入未变→仍走缓存短路、零调用、无告警", async () => {
    const dir = fixture();
    let calls = 0;
    const llm = {
      async generate() {
        calls++;
        return JSON.stringify({
          summary: "演示导读",
          sections: [{
            heading: "h", body: "b",
            cites: [{ file: "packages/alpha/src/index.ts", startLine: 7, endLine: 7, anchor: "export function runAlpha(opts: AlphaOptions): string {" }],
          }],
        });
      },
    };
    await rebuildWiki(dir, { llm, withLlm: true, config: { maxLlmPages: 1 } });
    const again = await rebuildWiki(dir, { llm, withLlm: true, config: { maxLlmPages: 1 } });
    expect(again.hit).toBe(true);
    expect(calls).toBe(1);
    expect(again.warnings ?? []).toEqual([]);
    expect(again.manifest.llm.enabled).toBe(true);
  });
});

describe("读取/问答", () => {
  it("list/get 只读且不触发重建", async () => {
    const dir = fixture();
    await rebuildWiki(dir, { withLlm: false });
    const before = JSON.parse(readFileSync(join(wikiOut(dir), "manifest.json"), "utf-8"));
    const list = await listWiki(dir);
    expect(list.exists).toBe(true);
    expect(list.manifest?.pages.length).toBe(9);
    const page = await getWikiPage(dir, "overview");
    expect(page?.markdown).toContain("# demo-monorepo 仓库概览");
    const after = JSON.parse(readFileSync(join(wikiOut(dir), "manifest.json"), "utf-8"));
    expect(after.generatedAt).toBe(before.generatedAt);
    expect(existsSync(join(wikiOut(dir), "overview.md"))).toBe(true);
  });

  it("词法问答:页面命中 + grep 命中(零 embedding)", async () => {
    const dir = fixture();
    await rebuildWiki(dir, { withLlm: false });
    expect(extractKeywords("runAlpha 是做什么的")).toContain("runAlpha");
    const r = await askWiki(dir, "runAlpha 入口");
    expect(r.keywords.length).toBeGreaterThan(0);
    expect(r.pages.length).toBeGreaterThan(0);
    expect(r.matches.some((m) => m.file === "packages/alpha/src/index.ts")).toBe(true);
    expect(r.note).toContain("零 embedding");
  });
});
