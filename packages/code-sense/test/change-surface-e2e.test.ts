/**
 * 全链路闭环端到端夹具:在临时目录造一个玩具概念 demoFlag,分布在
 * protocol / journal / config / ui / assets / tests / docs 七类表面,然后走
 * 「scan → 只改 ui → audit failed(列出剩余)→ 改全 → audit passed」的完整闭环。
 * 这条用例是「证明没有只改一半」的机制级验收:不是断言某个函数返回值,而是断言
 * 流程能真实拦住「只改 UI 就交差」。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { auditSurface, scanSurface } from "../src/surface/index.js";
import type { SurfaceHit, SurfaceReport, SurfaceResolution } from "../src/surface/index.js";

const CONCEPT = "demoFlag";
let root = "";
let report: SurfaceReport;

function put(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "surface-e2e-"));
  // protocol:消息名/类型单一真相
  put("packages/protocol/src/messages.ts", `export const M = z.literal("${CONCEPT}");\n`);
  // journal:事件 kind 字符串
  put("packages/core/src/journal-kinds.ts", `export const K = { kind: "${CONCEPT}" };\n`);
  // config:配置键
  put("apps/gateway/genie.config.json", `{ "features": { "${CONCEPT}": true } }\n`);
  // ui:面板文案
  put("apps/gateway/src/panel.ts", `const label = "开关 ${CONCEPT}";\n`);
  // assets:资源清单
  put("apps/gateway/assets/manifest.json", `{ "icons": ["${CONCEPT}.png"] }\n`);
  // tests:断言
  put("apps/gateway/test/demo.test.ts", `expect("${CONCEPT}").toBe("${CONCEPT}");\n`);
  // docs:文档章节
  put("docs/spec.md", `## ${CONCEPT}\n\n${CONCEPT} 用于开关演示。\n`);
  report = await scanSurface(root, [CONCEPT]);
}, 60_000);

afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function hitsIn(category: SurfaceHit["category"]): SurfaceHit[] {
  return report.hits.filter((h) => h.category === category);
}

function resolutionsFor(categories: SurfaceHit["category"][]): SurfaceResolution[] {
  return report.hits
    .filter((h) => categories.includes(h.category))
    .map((h) => ({ file: h.file, line: h.line, status: "resolved" as const }));
}

describe("demoFlag 全链路夹具", () => {
  it("盘点:七类表面各至少一处命中(protocol/journal/config/ui/assets/tests/docs)", () => {
    for (const c of ["protocol", "journal", "config", "ui", "assets", "tests", "docs"] as const) {
      expect(hitsIn(c).length, `分类 ${c}: ${JSON.stringify(report.hits.map((h) => `${h.category}:${h.file}`))}`)
        .toBeGreaterThanOrEqual(1);
    }
    expect(report.hits.length).toBeGreaterThanOrEqual(7);
  });

  it("只改 UI → audit failed 并逐类列出剩余(这就是「只改一半」被拦住的地方)", () => {
    const audit = auditSurface(report, resolutionsFor(["ui"]));
    expect(audit.passed).toBe(false);
    const cats = new Set(audit.unexplained.map((u) => u.category));
    for (const c of ["protocol", "journal", "config", "assets", "tests", "docs"] as const) {
      expect(cats.has(c), `未处理清单应含 ${c}`).toBe(true);
    }
    expect(cats.has("ui"), "已改的 ui 不该出现在未处理清单").toBe(false);
    expect(audit.resolved).toBe(hitsIn("ui").length);
    expect(audit.summary).toContain("未通过");
  });

  it("改全 → audit passed(0 unexplained)", () => {
    const all = ["protocol", "journal", "config", "ui", "assets", "tests", "docs"] as const;
    const audit = auditSurface(report, resolutionsFor([...all]));
    expect(audit.unexplained).toEqual([]);
    expect(audit.passed).toBe(true);
    expect(audit.summary).toContain("通过");
  });

  it("keep-legacy 不带理由 → 仍算未处理(不允许用「保留旧」静默消项)", () => {
    const all = ["protocol", "journal", "config", "ui", "assets", "tests", "docs"] as const;
    const resolutions = resolutionsFor([...all]);
    resolutions[0] = { ...resolutions[0]!, status: "keep-legacy" };
    const audit = auditSurface(report, resolutions);
    expect(audit.passed).toBe(false);
    expect(audit.invalidJustifications.length).toBe(1);

    const withReason = resolutions.map((r, i) => (i === 0 ? { ...r, reason: "旧客户端仍需读该标记" } : r));
    expect(auditSurface(report, withReason).passed).toBe(true);
  });

  it("改完了但删掉一个文件(removed)→ 该行不再计未处理", () => {
    const all = ["protocol", "journal", "config", "ui", "assets", "tests", "docs"] as const;
    const resolutions = resolutionsFor([...all]).map((r) => ({ ...r, status: "removed" as const }));
    expect(auditSurface(report, resolutions).passed).toBe(true);
  });
});
