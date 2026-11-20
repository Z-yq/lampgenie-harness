/**
 * retrieval/inline-js(查询时兜底,G-E):
 * - 反引号状态机:模板串 span/每行归属/宿主常量识别;
 * - findInlineJsDefs:定义形态 + 词边界 + 「行在模板串内」双闸;
 * - 与 callgraph/inline-js(索引期)分工:这里兜「索引未建/新文件/解析失败单元」的查询时形态,
 * 真实仓锚:cvEdgeInner 定义在 script-canvas-ops.ts 模板串内(审计注意)。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { findInlineJsDefs, renderInlineJsDefs, scanTemplateSpans } from "../src/retrieval/inline-js.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TMP: string[] = [];

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "codesense-retr-inlinejs-"));
  TMP.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

afterEach(() => {
  for (const d of TMP.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
 /* 临时目录清理失败不影响断言 */
    }
  }
});

describe("scanTemplateSpans(反引号状态机)", () => {
  it("模板串行归属 + 宿主常量识别 + 串外行不归属", () => {
    const text = [
      "export const PANEL_JS_X = `// canvas demo", // 1 开串(宿主)
      "function foo() {", // 2 串内
      "  return 1;", // 3 串内
      "`;", // 4 关串
      "function realFn() {}", // 5 串外
    ].join("\n");
    const st = scanTemplateSpans(text);
    expect(st.spans).toHaveLength(1);
    expect(st.spans[0]!.hostConst).toBe("PANEL_JS_X");
    expect(st.spans[0]!.startLine).toBe(1);
    expect(st.lineSpan[1]).toBe(0); // 行 2 串内
    expect(st.lineSpan[2]).toBe(0); // 行 3 串内
    expect(st.lineSpan[4]).toBe(-1); // 行 5 串外
  });

  it("普通单/双引号串里的反引号不误开模板", () => {
    const text = 'const s = "a ` b";\nconst t = \'x ` y\';\nfunction f(){}\n';
    const st = scanTemplateSpans(text);
    expect(st.spans).toHaveLength(0);
  });

  it("行注释/块注释里的引号不污染状态", () => {
    const text = [
      "// don`t comment", // 行注释里的反引号:忽略
      "/* it's a 'block */", // 块注释里的引号:忽略
      "const t = `tpl", // 真开串
      "function g(){}", // 串内
      "`;", // 关串
    ].join("\n");
    const st = scanTemplateSpans(text);
    expect(st.spans).toHaveLength(1);
    expect(st.lineSpan[3]).toBe(0); // 行 4 串内
  });

  it("转义反引号不关串", () => {
    const text = 'const t = `a \\` b\nfunction h(){}\n`;\n';
    const st = scanTemplateSpans(text);
    expect(st.spans).toHaveLength(1);
    expect(st.lineSpan[1]).toBe(0); // 行 2 仍在串内
  });
});

describe("findInlineJsDefs(定义形态 + 双闸)", () => {
  it("模板串内 function/const 定义命中并回链宿主常量;真实源码同名定义不报", async () => {
    const dir = fixture({
      "src/panel.ts": [
        "export const PANEL_JS_DEMO = `// demo",
        "function innerFn(a){ return a; }",
        "const innerVar = 1;",
        "`;",
        "export function innerFn(){}", // 真实源码同名定义(索引该管,不归 inline-js 兜底报)
        "",
      ].join("\n"),
    });
    const r = await findInlineJsDefs(dir, "innerFn");
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.file).toBe("src/panel.ts");
    expect(r.hits[0]!.line).toBe(2);
    expect(r.hits[0]!.form).toBe("function");
    expect(r.hits[0]!.hostConst).toBe("PANEL_JS_DEMO");
    expect(r.hits[0]!.hostLine).toBe(1);

    const rv = await findInlineJsDefs(dir, "innerVar");
    expect(rv.hits).toHaveLength(1);
    expect(rv.hits[0]!.form).toBe("const");
  });

  it("词边界:fooBar 不命中 foo;myfunction foo 不命中 function foo", async () => {
    const dir = fixture({
      "src/p.ts": "const T = `function fooBar(){}`;\nconst U = `myfunction foo(){}`;\n",
    });
    expect((await findInlineJsDefs(dir, "foo")).hits).toHaveLength(0);
    expect((await findInlineJsDefs(dir, "fooBar")).hits).toHaveLength(1);
  });

  it("非法名字直接空返回;渲染零命中返回空串", async () => {
    const dir = fixture({ "src/p.ts": "const T = `function ok(){}`;\n" });
    expect((await findInlineJsDefs(dir, "a-b")).hits).toHaveLength(0);
    expect((await findInlineJsDefs(dir, "notThere")).hits).toHaveLength(0);
    expect(renderInlineJsDefs(await findInlineJsDefs(dir, "notThere"))).toBe("");
  });

  it("渲染段带 [inline-js] 与宿主回链", async () => {
    const dir = fixture({
      "src/panel.ts": "export const PANEL_JS_R = `x\nfunction renderThing(){}\n`;\n",
    });
    const text = renderInlineJsDefs(await findInlineJsDefs(dir, "renderThing"));
    expect(text).toContain("[inline-js]");
    expect(text).toContain("function renderThing — src/panel.ts:2");
    expect(text).toContain("宿主 PANEL_JS_R @ :1");
    expect(text).toContain("refs renderThing");
  });

  it("真实仓锚:cvEdgeInner 定义在 script-canvas-ops.ts 模板串内(审计实测确认形态)", async () => {
    const r = await findInlineJsDefs(ROOT, "cvEdgeInner");
    expect(r.hits.length).toBeGreaterThan(0);
    const hit = r.hits.find((h) => h.file === "apps/gateway/src/panel/script-canvas-ops.ts");
    expect(hit).toBeDefined();
    expect(hit!.line).toBe(1309);
    expect(hit!.hostConst).toBeTruthy();
  });
});
