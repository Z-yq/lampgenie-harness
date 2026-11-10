/**
 * wiki ask 中文分词修复单测(2026-10-21 批次 A):
 * 四轮实测实锤——
 *  - 「怎么给 cobra 添加 flag 校验」→ 关键词含「怎么给」整词(无停用词);
 *  - 「如何添加子命令」→ 关键词「如何, 何添, 添加, 加子」(2-gram 残渣);
 *  - grep 命中含「xxx_test.go:15 — package cobra」零信息行(package 声明行被当命中)。
 * 修复:停用词表+词典最长匹配切词+声明行过滤;页面打分逻辑不变(同分同序)。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { askWiki, extractKeywords } from "../src/wiki/index";

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

describe("extractKeywords 中文分词(停用词+残渣)", () => {
  it("实锤 1:「怎么给 cobra 添加 flag 校验」——无停用词整词、无残渣", () => {
    const kw = extractKeywords("怎么给 cobra 添加 flag 校验");
    expect(kw).toContain("cobra");
    expect(kw).toContain("flag");
    expect(kw).toContain("添加");
    expect(kw).toContain("校验");
    for (const k of kw) {
      expect(k, `停用词不得入列: ${k}`).not.toMatch(/^(怎么|怎样|如何|什么|哪些|为什么|是不是|能不能|请|告诉|给)$|^[怎么如何什么是能不能给]{1,2}$/);
    }
    expect(kw.some((k) => k.includes("怎"))).toBe(false);
  });

  it("实锤 2:「如何添加子命令」——无「如何」、无 何添/加子 残渣", () => {
    const kw = extractKeywords("如何添加子命令");
    expect(kw).toContain("添加");
    expect(kw).toContain("子命令");
    expect(kw).not.toContain("如何");
    expect(kw).not.toContain("何添");
    expect(kw).not.toContain("加子");
    expect(kw).not.toContain("子命");
  });

  it("既有回归面:「runAlpha 是做什么的」仍含 runAlpha;「runAlpha 入口」可命中页面", () => {
    expect(extractKeywords("runAlpha 是做什么的")).toContain("runAlpha");
    expect(extractKeywords("runAlpha 入口").length).toBeGreaterThan(0);
  });

  it("纯域词段无词典命中:滑窗兜底仍可用(产物 ≥2 字且过停用词)", () => {
    const kw = extractKeywords("跨语言桥接边设计");
    expect(kw.length).toBeGreaterThan(0);
    for (const k of kw) {
      expect(k.length).toBeGreaterThanOrEqual(2);
      expect(k).not.toMatch(/^(怎么|如何|什么|哪些|的|了|吗)$/);
    }
  });

  it("疑问短语剥离后内容词保留:「怎么处理」「怎么校验」类", () => {
    const kw = extractKeywords("怎么处理");
    expect(kw).toEqual(["处理"]);
    expect(extractKeywords("怎么校验")).toEqual(["校验"]);
  });
});

describe("askWiki grep 命中声明行过滤", () => {
  it("package/import 行不再入命中;真实实现行保留", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-wikiask-"));
    created.push(dir);
    const files: Record<string, string> = {
      // Go 形态:package 声明行 + flag 校验真实使用行(bench go-cobra 实锤形态)
      "cobra_check.go": [
        "package cobra",
        "",
        "import (",
        '  "github.com/spf13/cobra"',
        ")",
        "",
        "func validateFlags(cmd *cobra.Command) error {",
        "  return cmd.ValidateFlagGroups()",
        "}",
      ].join("\n"),
      // TS 形态:import 行 + 实现行
      "flagcheck.ts": [
        'import { cobra } from "./cobra";',
        "export function flagCheck(cobra: string): boolean {",
        "  return cobra.length > 0;",
        "}",
      ].join("\n"),
    };
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    const r = await askWiki(dir, "怎么给 cobra 添加 flag 校验");
    // 关键词面:无停用词/残渣
    expect(r.keywords).not.toContain("怎么给");
    expect(r.keywords.some((k) => /^[怎么如何什么是能不能]{2}$/.test(k))).toBe(false);
    // 命中面:package/import 声明行零信息,过滤
    expect(r.matches.some((m) => /^\s*package\s/.test(m.text))).toBe(false);
    expect(r.matches.some((m) => /^\s*import\s/.test(m.text))).toBe(false);
    expect(r.matches.some((m) => m.text.includes("import"))).toBe(false);
    // 真实实现/使用行保留
    expect(r.matches.some((m) => m.file === "cobra_check.go" && m.text.includes("validateFlags"))).toBe(true);
    expect(r.matches.some((m) => m.file === "flagcheck.ts" && m.text.includes("flagCheck"))).toBe(true);
  });
});
