/**
 * 概念足迹面 surface:在 os.tmpdir 造一个玩具仓(七类表面各一处),断言
 * 分类覆盖、排除目录零命中、JSON 可序列化、markdown 行形态、id 两跑稳定。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanSurface, renderSurfaceMarkdown, classifySurfaceHit } from "../src/surface/index.js";
import type { SurfaceReport } from "../src/surface/index.js";

const CONCEPT = "demoFlag";
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

let root = "";
let report: SurfaceReport;

function put(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "surface-toy-"));
  // protocol:消息名/类型单一真相
  put("packages/protocol/src/messages.ts", `export const M = z.literal("${CONCEPT}");\n`);
  // journal:事件 kind 常量(路径无特殊段,靠行模式)
  put("src/journal/events.ts", `export const K = { kind: "${CONCEPT}" };\n`);
  // config:配置文件路径
  put("genie.config.json", `{ "feature": "${CONCEPT}" }\n`);
  // ui:gateway 面板
  put("apps/gateway/src/panel.ts", `const label = "${CONCEPT}";\n`);
  // assets:静态目录下的资源清单文件
  put("assets/demo-assets.json", `{ "id": "${CONCEPT}" }\n`);
  // tests:测试文件
  put("packages/protocol/test/demo.test.ts", `expect("${CONCEPT}").toBeTruthy();\n`);
  // docs:文档
  put("docs/demo.md", `# demo\n\n这里是 ${CONCEPT} 的说明。\n`);
  // symbol:普通源码
  put("src/demo-flag.ts", `export const v = "${CONCEPT}";\n`);
  // symbol:未加引号的标识符(定义与使用点)——概念足迹必须能看见,否则「替换一个符号」是瞎的
  put("src/demo-flag-use.ts", `import { x } from "./demo";\nexport function readFlag() { return ${CONCEPT}; }\n`);
  // 三个必须被排除的目录
  put("node_modules/pkg/index.ts", `const x = "${CONCEPT}";\n`);
  put("dist/bundle.ts", `const x = "${CONCEPT}";\n`);
  put(".git/hooks/probe.ts", `const x = "${CONCEPT}";\n`);
  report = await scanSurface(root, [CONCEPT]);
}, 60_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function cat(c: string) {
  return report.hits.filter((h) => h.category === c);
}

describe("scanSurface 七类表面", () => {
  it("七类各 ≥1 命中", () => {
    for (const c of ["symbol", "protocol", "journal", "config", "ui", "assets", "tests", "docs"] as const) {
      expect(cat(c).length, `分类 ${c} 应有命中: ${JSON.stringify(report.hits.map((h) => `${h.category} ${h.file}`))}`)
        .toBeGreaterThanOrEqual(1);
    }
  });

  it("byCategory 与 hits 一致,覆盖全部 11 类键", () => {
    expect(Object.keys(report.byCategory).sort()).toEqual(
      ["protocol", "db", "journal", "config", "symbol", "ui", "assets", "deploy", "i18n", "tests", "docs"].sort(),
    );
    for (const [k, v] of Object.entries(report.byCategory)) {
      expect(v, `byCategory.${k}`).toBe(cat(k).length);
    }
  });

  it("未加引号的标识符出现进 symbol 面(includeBare,2026-11-06)", () => {
    const bare = report.hits.filter((h) => h.file === "src/demo-flag-use.ts");
    expect(bare.length, `裸标识符行应有命中: ${JSON.stringify(report.hits.map((h) => `${h.category} ${h.file}:${h.line}`))}`).toBe(1);
    expect(bare[0]!.category).toBe("symbol");
    expect(bare[0]!.line).toBe(2);
  });

  it("node_modules/dist/.git 下零命中", () => {
    for (const h of report.hits) {
      expect(h.file).not.toMatch(/(^|\/)(node_modules|dist|\.git)\//);
    }
  });

  it("scannedFiles 口径:grep 通道缺席是如实缺席,walk 通道才回报(不编造)", async () => {
    const viaWalk = await scanSurface(root, [CONCEPT], { engine: "walk" });
    expect(viaWalk.scannedFiles).toBeGreaterThan(0);
    expect(report.scannedFiles === undefined || report.scannedFiles > 0).toBe(true);
  });

  it("报告可 JSON.stringify/parse 往返", () => {
    const round = JSON.parse(JSON.stringify(report)) as SurfaceReport;
    expect(round.hits.length).toBe(report.hits.length);
    expect(round.hits[0]!.id).toBe(report.hits[0]!.id);
    expect(round.byCategory).toEqual(report.byCategory);
    expect(round.scannedFiles).toBe(report.scannedFiles);
  });

  it("id 稳定:同一次调用两次结果 id 全等(id 含 <category>:<file>:<line>:<concept>)", async () => {
    const again = await scanSurface(root, [CONCEPT]);
    expect(again.hits.map((h) => h.id)).toEqual(report.hits.map((h) => h.id));
    for (const h of report.hits) {
      expect(h.id).toBe(`${h.category}:${h.file}:${h.line}:${h.concept}`);
    }
  });

  it("同一 file:line 多概念命中合并成一条(concept 逗号连)", async () => {
    put("src/multi.ts", `const a = "${CONCEPT}";\nconst b = "${CONCEPT}Alt";\n`);
    const r = await scanSurface(root, [CONCEPT, "demoFlagAlt"]);
    const multi = r.hits.filter((h) => h.file === "src/multi.ts");
    expect(multi.length).toBe(2);
    const sameLine = multi.find((h) => h.line === 2)!;
    expect(sameLine.concept).toContain("demoFlagAlt");
  });

  it("markdown:每行含 [ ] 与 file:line,头部有分类计数", () => {
    const md = renderSurfaceMarkdown(report);
    const hitLines = md.split("\n").filter((l) => l.startsWith("- [ ] "));
    expect(hitLines.length).toBe(report.hits.length);
    for (const h of report.hits) {
      const line = hitLines.find((l) => l.includes(`${h.file}:${h.line}`));
      expect(line, `markdown 应含 ${h.file}:${h.line}`).toBeTruthy();
    }
    expect(md).toContain("分类计数");
    for (const c of ["protocol", "journal", "config", "ui", "assets", "tests", "docs", "symbol"]) {
      expect(md).toContain(`${c} `);
    }
  });
});

describe("classifySurfaceHit(纯函数)", () => {
  it("路径类优先于模式类:测试里的 kind: 仍是 tests", () => {
    expect(classifySurfaceHit("test/x.test.ts", 'kind: "a.b"')).toBe("tests");
    expect(classifySurfaceHit("packages/protocol/src/m.ts", 'kind: "a.b"')).toBe("protocol");
    expect(classifySurfaceHit("genie.config.json", '"x": 1')).toBe("config");
    expect(classifySurfaceHit("docs/a.md", "kind: x")).toBe("docs");
    expect(classifySurfaceHit("assets/logo.png", "x")).toBe("assets");
    expect(classifySurfaceHit("apps/gateway/src/panel.ts", "const t = 1")).toBe("ui");
    expect(classifySurfaceHit("src/a.ts", 'kind: "job.done"')).toBe("journal");
    expect(classifySurfaceHit("src/a.ts", "process.env.GENIE_HOME")).toBe("config");
    expect(classifySurfaceHit("src/a.ts", "export const x = 1")).toBe("symbol");
  });
});

describe("本仓真实冒烟", () => {
  it("scanSurface(repoRoot, [concept]) 在 grep 通道下不命中排除目录且能快速返回", async () => {
    const t0 = Date.now();
    const r = await scanSurface(REPO_ROOT, [CONCEPT]);
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect(r.hits.every((h) => !/(^|\/)(node_modules|dist|\.git)\//.test(h.file))).toBe(true);
  }, 120_000);

  it("未加引号的标识符(源码定义/使用点)进 symbol 面(includeBare,2026-11-06)", async () => {
    // SurfaceChainMap 只以未加引号的标识符形态出现(定义在 chain.ts、导出于 surface/index.ts)
    const r = await scanSurface(REPO_ROOT, ["SurfaceChainMap"]);
    const sym = r.hits.filter((h) => h.category === "symbol");
    expect(sym.length, `symbol 面应有命中: ${JSON.stringify(r.byCategory)}`).toBeGreaterThan(0);
    const files = new Set(sym.map((h) => h.file));
    expect(files.has("packages/code-sense/src/surface/chain.ts"), `命中文件应含定义文件,实际: ${[...files].join(", ")}`).toBe(true);
    expect(files.has("packages/code-sense/src/surface/index.ts")).toBe(true);

    // 工具名同理(boardUpsertTool 是真实符号,定义在 gateway 侧)
    const t = await scanSurface(REPO_ROOT, ["boardUpsertTool"]);
    const tsym = t.hits.filter((h) => h.category === "symbol");
    expect(tsym.length).toBeGreaterThan(0);
    expect(tsym.some((h) => h.file.includes("apps/gateway/src/")), `实际: ${[...new Set(tsym.map((h) => h.file))].join(", ")}`).toBe(true);
  }, 180_000);
});
