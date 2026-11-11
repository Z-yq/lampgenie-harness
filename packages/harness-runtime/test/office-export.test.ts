/**
 * 导出路由与预检(-A 纯逻辑):码表 / 路由表 / 离线 / 清单 / 预检 / 产物 / 离线保证。
 * 全部直测纯函数:不碰文件系统、不读环境与时钟(可用引擎与引擎规格都由用例给)。
 */
import { describe, expect, it } from "vitest";
import {
  ENGINE_SPECS,
  ENGINES,
  EXPORT_ARTIFACT_INVALID,
  EXPORT_CODES,
  EXPORT_CONTRACT_VERSION,
  EXPORT_EMPTY_DECK,
  EXPORT_EMPTY_PAGE,
  EXPORT_ENGINE_MISSING,
  EXPORT_ENGINE_UNAVAILABLE,
  EXPORT_EXTERNAL_REF,
  EXPORT_FONT_MISSING,
  EXPORT_INVALID,
  EXPORT_MANIFEST_MISMATCH,
  EXPORT_MANIFEST_MISSING,
  EXPORT_OFFLINE_VIOLATION,
  EXPORT_OK,
  EXPORT_PLACEHOLDER,
  EXPORT_UNSUPPORTED,
  findExternalRefs,
  findPlaceholders,
  INPUT_KINDS,
  isExternalRef,
  offlineGuarantee,
  perPageReport,
  PLACEHOLDER_PATTERNS,
  preflightExport,
  routeExport,
  TARGETS,
  verifyArtifact,
  verifyVendorManifest,
} from "../src/agent/office-export.ts";
import type { Engine, InputKind, PreflightRequest, Target, VendorManifest } from "../src/agent/office-export.ts";

/** 一个形态合法的 sha256(内容无关,只验形态)。 */
const SHA_A = "a".repeat(64);
/** 另一个形态合法的 sha256。 */
const SHA_B = "b".repeat(64);

describe("码表与常量", () => {
  it("契约版本为 1", () => {
    expect(EXPORT_CONTRACT_VERSION).toBe(1);
  });

  it("EXPORT_CODES 固定顺序且无重复", () => {
    expect(EXPORT_CODES.length).toBe(14);
    expect(EXPORT_CODES).toEqual([
      EXPORT_OK,
      EXPORT_INVALID,
      EXPORT_UNSUPPORTED,
      EXPORT_ENGINE_MISSING,
      EXPORT_ENGINE_UNAVAILABLE,
      EXPORT_MANIFEST_MISSING,
      EXPORT_MANIFEST_MISMATCH,
      EXPORT_EXTERNAL_REF,
      EXPORT_PLACEHOLDER,
      EXPORT_EMPTY_PAGE,
      EXPORT_EMPTY_DECK,
      EXPORT_OFFLINE_VIOLATION,
      EXPORT_ARTIFACT_INVALID,
      EXPORT_FONT_MISSING,
    ]);
    expect(new Set(EXPORT_CODES).size).toBe(EXPORT_CODES.length);
  });

  it("每个码常量的字面量与契约一致", () => {
    expect({
      EXPORT_OK,
      EXPORT_INVALID,
      EXPORT_UNSUPPORTED,
      EXPORT_ENGINE_MISSING,
      EXPORT_ENGINE_UNAVAILABLE,
      EXPORT_MANIFEST_MISSING,
      EXPORT_MANIFEST_MISMATCH,
      EXPORT_EXTERNAL_REF,
      EXPORT_PLACEHOLDER,
      EXPORT_EMPTY_PAGE,
      EXPORT_EMPTY_DECK,
      EXPORT_OFFLINE_VIOLATION,
      EXPORT_ARTIFACT_INVALID,
      EXPORT_FONT_MISSING,
    }).toEqual({
      EXPORT_OK: "EXPORT_OK",
      EXPORT_INVALID: "EXPORT_INVALID",
      EXPORT_UNSUPPORTED: "EXPORT_UNSUPPORTED",
      EXPORT_ENGINE_MISSING: "EXPORT_ENGINE_MISSING",
      EXPORT_ENGINE_UNAVAILABLE: "EXPORT_ENGINE_UNAVAILABLE",
      EXPORT_MANIFEST_MISSING: "EXPORT_MANIFEST_MISSING",
      EXPORT_MANIFEST_MISMATCH: "EXPORT_MANIFEST_MISMATCH",
      EXPORT_EXTERNAL_REF: "EXPORT_EXTERNAL_REF",
      EXPORT_PLACEHOLDER: "EXPORT_PLACEHOLDER",
      EXPORT_EMPTY_PAGE: "EXPORT_EMPTY_PAGE",
      EXPORT_EMPTY_DECK: "EXPORT_EMPTY_DECK",
      EXPORT_OFFLINE_VIOLATION: "EXPORT_OFFLINE_VIOLATION",
      EXPORT_ARTIFACT_INVALID: "EXPORT_ARTIFACT_INVALID",
      EXPORT_FONT_MISSING: "EXPORT_FONT_MISSING",
    });
  });

  it("输入格式/目标格式/引擎清单固定", () => {
    expect(INPUT_KINDS).toEqual(["pptx", "docx", "xlsx", "md", "html", "pdf"]);
    expect(TARGETS).toEqual(["pptx", "pdf", "png", "md", "html"]);
    expect(ENGINES).toEqual(["soffice", "gs", "pptxgenjs", "native-md", "native-html"]);
  });

  it("五个引擎缺省全部离线", () => {
    for (const engine of ENGINES) {
      expect(ENGINE_SPECS[engine]).toEqual({ engine, requiresNetwork: false });
    }
  });

  it("占位词表固定", () => {
    expect(PLACEHOLDER_PATTERNS).toEqual(["TODO", "待填", "TBD", "XXX", "lorem ipsum"]);
  });
});

describe("路由表", () => {
  it("pptx→pdf 走 soffice", () => {
    expect(routeExport({ input: "pptx", target: "pdf" })).toEqual({
      supported: true,
      engine: "soffice",
      code: EXPORT_OK,
    });
  });

  it("pptx→png 报 soffice 且 reason 点明第二段 gs", () => {
    const result = routeExport({ input: "pptx", target: "png" });
    expect(result.supported).toBe(true);
    expect(result.code).toBe(EXPORT_OK);
    expect(result.engine).toBe("soffice");
    expect(result.reason).toContain("gs");
  });

  it("pptx→pptx 走 pptxgenjs", () => {
    const result = routeExport({ input: "pptx", target: "pptx" });
    expect(result).toMatchObject({ supported: true, engine: "pptxgenjs", code: EXPORT_OK });
  });

  it("docx→pdf 走 soffice", () => {
    expect(routeExport({ input: "docx", target: "pdf" })).toMatchObject({ supported: true, engine: "soffice" });
  });

  it("docx→png 走 soffice+gs", () => {
    const result = routeExport({ input: "docx", target: "png" });
    expect(result).toMatchObject({ supported: true, engine: "soffice", code: EXPORT_OK });
    expect(result.reason).toContain("gs");
  });

  it("xlsx→pdf 走 soffice", () => {
    expect(routeExport({ input: "xlsx", target: "pdf" })).toMatchObject({ supported: true, engine: "soffice" });
  });

  it("xlsx→png 走 soffice+gs", () => {
    const result = routeExport({ input: "xlsx", target: "png" });
    expect(result).toMatchObject({ supported: true, engine: "soffice" });
    expect(result.reason).toContain("gs");
  });

  it("md→html 走 native-md", () => {
    expect(routeExport({ input: "md", target: "html" })).toMatchObject({ supported: true, engine: "native-md" });
  });

  it("md→md 走 native-md", () => {
    expect(routeExport({ input: "md", target: "md" })).toMatchObject({ supported: true, engine: "native-md" });
  });

  it("md→pptx 走 pptxgenjs", () => {
    expect(routeExport({ input: "md", target: "pptx" })).toMatchObject({ supported: true, engine: "pptxgenjs" });
  });

  it("html→html 走 native-html", () => {
    expect(routeExport({ input: "html", target: "html" })).toMatchObject({ supported: true, engine: "native-html" });
  });

  it("html→pdf 走 soffice", () => {
    expect(routeExport({ input: "html", target: "pdf" })).toMatchObject({ supported: true, engine: "soffice" });
  });

  it("pdf→png 走 gs", () => {
    expect(routeExport({ input: "pdf", target: "png" })).toEqual({
      supported: true,
      engine: "gs",
      code: EXPORT_OK,
    });
  });

  it("十三条支持路由全量断言", () => {
    const routes: Array<[InputKind, Target, Engine]> = [
      ["pptx", "pdf", "soffice"],
      ["pptx", "png", "soffice"],
      ["pptx", "pptx", "pptxgenjs"],
      ["docx", "pdf", "soffice"],
      ["docx", "png", "soffice"],
      ["xlsx", "pdf", "soffice"],
      ["xlsx", "png", "soffice"],
      ["md", "html", "native-md"],
      ["md", "md", "native-md"],
      ["md", "pptx", "pptxgenjs"],
      ["html", "html", "native-html"],
      ["html", "pdf", "soffice"],
      ["pdf", "png", "gs"],
    ];
    for (const [input, target, engine] of routes) {
      const result = routeExport({ input, target });
      expect(result, `${input}->${target}`).toMatchObject({ supported: true, engine, code: EXPORT_OK });
    }
  });

  it("md→pdf 不支持", () => {
    expect(routeExport({ input: "md", target: "pdf" })).toMatchObject({
      supported: false,
      code: EXPORT_UNSUPPORTED,
    });
  });

  it("docx→html 不支持", () => {
    expect(routeExport({ input: "docx", target: "html" }).code).toBe(EXPORT_UNSUPPORTED);
  });

  it("html→png 不支持", () => {
    expect(routeExport({ input: "html", target: "png" }).code).toBe(EXPORT_UNSUPPORTED);
  });

  it("pptx→md 不支持", () => {
    expect(routeExport({ input: "pptx", target: "md" }).code).toBe(EXPORT_UNSUPPORTED);
  });

  it("pdf→pptx 不支持", () => {
    expect(routeExport({ input: "pdf", target: "pptx" }).code).toBe(EXPORT_UNSUPPORTED);
  });

  it("pptx→html 不支持且不带引擎", () => {
    const result = routeExport({ input: "pptx", target: "html" });
    expect(result.supported).toBe(false);
    expect(result.engine).toBeUndefined();
    expect(result.code).toBe(EXPORT_UNSUPPORTED);
  });

  it("availableEngines 缺第二段 gs → ENGINE_MISSING 并点名 gs", () => {
    const result = routeExport({ input: "pptx", target: "png", availableEngines: ["soffice"] });
    expect(result.supported).toBe(false);
    expect(result.code).toBe(EXPORT_ENGINE_MISSING);
    expect(result.reason).toContain("gs");
  });

  it("availableEngines 为空 → ENGINE_MISSING", () => {
    const result = routeExport({ input: "md", target: "html", availableEngines: [] });
    expect(result.code).toBe(EXPORT_ENGINE_MISSING);
    expect(result.reason).toContain("native-md");
  });

  it("availableEngines 缺省视为全可用", () => {
    expect(routeExport({ input: "pdf", target: "png" }).code).toBe(EXPORT_OK);
  });

  it("offline 且引擎 requiresNetwork → ENGINE_UNAVAILABLE", () => {
    const result = routeExport({
      input: "pptx",
      target: "pdf",
      offline: true,
      engineSpecs: { soffice: { engine: "soffice", requiresNetwork: true } },
    });
    expect(result.supported).toBe(false);
    expect(result.code).toBe(EXPORT_ENGINE_UNAVAILABLE);
    expect(result.reason).toContain("soffice");
  });

  it("offline 且第二段 requiresNetwork → ENGINE_UNAVAILABLE 点名 gs", () => {
    const result = routeExport({
      input: "docx",
      target: "png",
      offline: true,
      engineSpecs: { gs: { engine: "gs", requiresNetwork: true } },
    });
    expect(result.code).toBe(EXPORT_ENGINE_UNAVAILABLE);
    expect(result.reason).toContain("gs");
  });

  it("offline 且全离线引擎 → 通过", () => {
    expect(routeExport({ input: "md", target: "md", offline: true }).code).toBe(EXPORT_OK);
  });

  it("engineSpecs 覆盖只影响被点名的引擎", () => {
    const onlyGsOffline = routeExport({
      input: "pptx",
      target: "png",
      offline: true,
      engineSpecs: { gs: { engine: "gs", requiresNetwork: false } },
    });
    expect(onlyGsOffline.code).toBe(EXPORT_OK);
  });
});

describe("确定性与不可变", () => {
  it("routeExport 同入参两次深相等", () => {
    const req = { input: "pptx" as InputKind, target: "png" as Target, offline: true };
    expect(routeExport(req)).toEqual(routeExport(req));
  });

  it("preflightExport 同入参两次深相等", () => {
    const req: PreflightRequest = {
      inputKind: "md",
      target: "html",
      pages: [{ text: "正文 TODO" }, {}],
      externalRefs: ["https://example.com/a"],
      fonts: [],
      offline: true,
    };
    expect(preflightExport(req)).toEqual(preflightExport(req));
  });

  it("preflightExport 不改入参(pages/externalRefs 快照不变)", () => {
    const req: PreflightRequest = {
      inputKind: "docx",
      target: "pdf",
      pages: [{ text: "第一页" }, { texts: ["a", "b"], shapes: 2 }],
      externalRefs: ["https://example.com/x", "file:///tmp/y"],
      fonts: ["Noto Sans CJK"],
      manifest: {
        name: "vendor",
        version: "1.0.0",
        entries: [{ name: "bin/soffice", sha256: SHA_A, bytes: 10 }],
      },
    };
    const snapshot = JSON.stringify(req);
    preflightExport(req);
    expect(JSON.stringify(req)).toBe(snapshot);
  });

  it("verifyVendorManifest 不改入参", () => {
    const manifest: VendorManifest = {
      name: "vendor",
      version: "1.0.0",
      entries: [
        { name: "bin/soffice", sha256: SHA_A, bytes: 100, path: "vendor/bin/soffice" },
        { name: "bin/soffice", sha256: SHA_A, bytes: 100 },
      ],
    };
    const snapshot = JSON.stringify(manifest);
    verifyVendorManifest(manifest, { actual: [{ name: "bin/soffice", sha256: SHA_A, bytes: 100 }] });
    expect(JSON.stringify(manifest)).toBe(snapshot);
  });
});

describe("verifyVendorManifest", () => {
  it("空清单 → MANIFEST_MISSING", () => {
    const verdict = verifyVendorManifest(null);
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe(EXPORT_MANIFEST_MISSING);
  });

  it("形状坏(缺 version)→ MANIFEST_MISSING", () => {
    const broken = { name: "vendor", entries: [] } as unknown as VendorManifest;
    expect(verifyVendorManifest(broken).code).toBe(EXPORT_MANIFEST_MISSING);
  });

  it("entries 为空 → MANIFEST_MISMATCH", () => {
    const verdict = verifyVendorManifest({ name: "vendor", version: "1.0.0", entries: [] });
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe(EXPORT_MANIFEST_MISMATCH);
    expect(verdict.mismatches[0]).toContain("vendor");
  });

  it("条目重名 → MANIFEST_MISMATCH 逐条点名", () => {
    const verdict = verifyVendorManifest({
      name: "vendor",
      version: "1.0.0",
      entries: [
        { name: "bin/soffice", sha256: SHA_A, bytes: 1, path: "p" },
        { name: "bin/soffice", sha256: SHA_A, bytes: 1, path: "p" },
      ],
    });
    expect(verdict.code).toBe(EXPORT_MANIFEST_MISMATCH);
    expect(verdict.mismatches.some((line) => line.startsWith("bin/soffice: 条目重复"))).toBe(true);
  });

  it("sha256 非 64 位十六进制 → MANIFEST_MISMATCH", () => {
    const verdict = verifyVendorManifest({
      name: "vendor",
      version: "1.0.0",
      entries: [{ name: "f.ttf", sha256: "deadbeef", bytes: 1, path: "p" }],
    });
    expect(verdict.code).toBe(EXPORT_MANIFEST_MISMATCH);
    expect(verdict.mismatches[0]).toContain("f.ttf");
  });

  it("bytes<=0 → MANIFEST_MISMATCH", () => {
    const verdict = verifyVendorManifest({
      name: "vendor",
      version: "1.0.0",
      entries: [{ name: "f.ttf", sha256: SHA_A, bytes: 0, path: "p" }],
    });
    expect(verdict.code).toBe(EXPORT_MANIFEST_MISMATCH);
  });

  it("actual 缺条目 → MANIFEST_MISSING", () => {
    const verdict = verifyVendorManifest(
      {
        name: "vendor",
        version: "1.0.0",
        entries: [
          { name: "a", sha256: SHA_A, bytes: 1, path: "p" },
          { name: "b", sha256: SHA_A, bytes: 1, path: "p" },
        ],
      },
      { actual: [{ name: "a", sha256: SHA_A, bytes: 1 }] },
    );
    expect(verdict.code).toBe(EXPORT_MANIFEST_MISSING);
    expect(verdict.mismatches).toContain("b: 实际产物缺失");
  });

  it("actual 被篡改(sha/bytes 不符)→ MANIFEST_MISMATCH", () => {
    const verdict = verifyVendorManifest(
      { name: "vendor", version: "1.0.0", entries: [{ name: "a", sha256: SHA_A, bytes: 1, path: "p" }] },
      { actual: [{ name: "a", sha256: SHA_B, bytes: 2 }] },
    );
    expect(verdict.code).toBe(EXPORT_MANIFEST_MISMATCH);
    expect(verdict.mismatches.length).toBe(2);
  });

  it("离线且条目无 path → OFFLINE_VIOLATION", () => {
    const verdict = verifyVendorManifest(
      { name: "vendor", version: "1.0.0", entries: [{ name: "a", sha256: SHA_A, bytes: 1 }] },
      { offline: true },
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe(EXPORT_OFFLINE_VIOLATION);
    expect(verdict.mismatches[0]).toContain("path");
  });

  it("正常清单 + actual 吻合 → ok", () => {
    const verdict = verifyVendorManifest(
      { name: "vendor", version: "1.0.0", entries: [{ name: "a", sha256: SHA_A, bytes: 7, path: "p" }] },
      { offline: true, actual: [{ name: "a", sha256: SHA_A, bytes: 7 }] },
    );
    expect(verdict).toEqual({ ok: true, code: EXPORT_OK, mismatches: [], warnings: [] });
  });
});

describe("perPageReport", () => {
  it("有文本的页字数非零", () => {
    const [report] = perPageReport([{ text: "hello" }]);
    expect(report).toEqual({ index: 1, nonEmpty: true, chars: 5, shapes: 0, images: 0 });
  });

  it("texts 数组按块累加", () => {
    const [report] = perPageReport([{ texts: ["ab", "cde"] }]);
    expect(report?.chars).toBe(5);
    expect(report?.nonEmpty).toBe(true);
  });

  it("只有形状/图片也算有内容", () => {
    const [first, second] = perPageReport([{ shapes: 2 }, { images: 1 }]);
    expect(first).toEqual({ index: 1, nonEmpty: true, chars: 0, shapes: 2, images: 0 });
    expect(second).toEqual({ index: 2, nonEmpty: true, chars: 0, shapes: 0, images: 1 });
  });

  it("空页 nonEmpty=false 且显式 index 优先", () => {
    const reports = perPageReport([{}, { index: 7, text: "x" }]);
    expect(reports[0]).toEqual({ index: 1, nonEmpty: false, chars: 0, shapes: 0, images: 0 });
    expect(reports[1]?.index).toBe(7);
  });
});

describe("findPlaceholders / findExternalRefs / isExternalRef", () => {
  it("大小写不敏感、去重、返回 pattern 原文", () => {
    expect(findPlaceholders("todo 与 TODO 与 ToDo 都要报")).toEqual(["TODO"]);
  });

  it("中文占位词与 lorem ipsum 命中", () => {
    expect(findPlaceholders("这里待填")).toEqual(["待填"]);
    expect(findPlaceholders("Lorem Ipsum dolor")).toEqual(["lorem ipsum"]);
  });

  it("ignoreCodeBlocks 剔除围栏与行内代码", () => {
    const text = ["正常文本", "```ts", "// TODO", "```", "行内 `TBD` 代码"].join("\n");
    expect(findPlaceholders(text)).toEqual(["TODO", "TBD"]);
    expect(findPlaceholders(text, { ignoreCodeBlocks: true })).toEqual([]);
  });

  it("空文本不命中", () => {
    expect(findPlaceholders("")).toEqual([]);
    expect(findExternalRefs("")).toEqual([]);
  });

  it("findExternalRefs 抓 http/file 并去重", () => {
    const text =
      "见 https://example.com/a 与 http://example.com/b,再看 https://example.com/a 与 file:///tmp/c";
    expect(findExternalRefs(text)).toEqual([
      "https://example.com/a",
      "http://example.com/b",
      "file:///tmp/c",
    ]);
  });

  it("isExternalRef 区分外链与普通文本", () => {
    expect(isExternalRef("https://example.com")).toBe(true);
    expect(isExternalRef("file:///tmp/x.png")).toBe(true);
    expect(isExternalRef("./assets/x.png")).toBe(false);
    expect(isExternalRef("见 https://example.com")).toBe(false);
  });
});

describe("preflightExport", () => {
  it("干净输入 → ok", () => {
    const result = preflightExport({
      inputKind: "md",
      target: "md",
      pages: [{ text: "正文" }],
      fonts: ["Noto Sans CJK"],
    });
    expect(result.ok).toBe(true);
    expect(result.code).toBe(EXPORT_OK);
    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.perPage.length).toBe(1);
  });

  it("大写 TODO → PLACEHOLDER", () => {
    const result = preflightExport({ inputKind: "md", target: "html", pages: [{ text: "TODO: 补一段" }] });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(EXPORT_PLACEHOLDER);
    expect(result.failures[0]?.detail).toContain("TODO");
  });

  it("小写 todo 也命中", () => {
    const result = preflightExport({ inputKind: "md", target: "html", pages: [{ text: "todo 待补" }] });
    expect(result.code).toBe(EXPORT_PLACEHOLDER);
  });

  it("待填命中且按页点名", () => {
    const result = preflightExport({
      inputKind: "md",
      target: "html",
      pages: [{ text: "第一页" }, { text: "这里待填" }],
    });
    expect(result.code).toBe(EXPORT_PLACEHOLDER);
    expect(result.failures[0]?.detail).toContain("第 2 页");
  });

  it("lorem ipsum 命中", () => {
    const result = preflightExport({ inputKind: "md", target: "html", pages: [{ text: "Lorem Ipsum" }] });
    expect(result.code).toBe(EXPORT_PLACEHOLDER);
  });

  it("显式占位词逐条点名", () => {
    const result = preflightExport({
      inputKind: "md",
      target: "html",
      pages: [{ text: "正文" }],
      placeholders: ["封面标题", "目录"],
    });
    expect(result.code).toBe(EXPORT_PLACEHOLDER);
    expect(result.failures.length).toBe(2);
  });

  it("在线外链只进 warnings", () => {
    const result = preflightExport({
      inputKind: "html",
      target: "html",
      pages: [{ text: "参见 https://example.com/doc" }],
      fonts: ["Noto Sans CJK"],
    });
    expect(result.ok).toBe(true);
    expect(result.code).toBe(EXPORT_OK);
    expect(result.warnings.some((issue) => issue.code === EXPORT_EXTERNAL_REF)).toBe(true);
  });

  it("离线外链 → OFFLINE_VIOLATION", () => {
    const result = preflightExport({
      inputKind: "html",
      target: "html",
      pages: [{ text: "正文" }],
      externalRefs: ["https://example.com/doc"],
      offline: true,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(EXPORT_OFFLINE_VIOLATION);
    expect(result.failures[0]?.detail).toContain("https://example.com/doc");
  });

  it("空页逐页点名", () => {
    const result = preflightExport({
      inputKind: "md",
      target: "html",
      pages: [{ text: "有内容" }, {}, {}],
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(EXPORT_EMPTY_PAGE);
    const details = result.failures.map((issue) => issue.detail);
    expect(details).toEqual(["第 2 页为空", "第 3 页为空"]);
  });

  it("空 deck → EMPTY_DECK", () => {
    const result = preflightExport({ inputKind: "md", target: "html", pages: [] });
    expect(result.code).toBe(EXPORT_EMPTY_DECK);
  });

  it("没有字体 → 只警告 FONT_MISSING", () => {
    const result = preflightExport({ inputKind: "md", target: "html", pages: [{ text: "正文" }] });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((issue) => issue.code === EXPORT_FONT_MISSING)).toBe(true);
  });

  it("离线缺字体清单声明 → 额外 FONT_MISSING 警告", () => {
    const result = preflightExport({
      inputKind: "md",
      target: "md",
      pages: [{ text: "正文" }],
      fonts: ["Noto Sans CJK"],
      offline: true,
      manifest: { name: "vendor", version: "1.0.0", entries: [{ name: "bin/gs", sha256: SHA_A, bytes: 9, path: "p" }] },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.filter((issue) => issue.code === EXPORT_FONT_MISSING).length).toBe(1);
  });

  it("requireFontManifest:false 时不催字体清单", () => {
    const result = preflightExport({
      inputKind: "md",
      target: "md",
      pages: [{ text: "正文" }],
      fonts: ["Noto Sans CJK"],
      offline: true,
      requireFontManifest: false,
      manifest: { name: "vendor", version: "1.0.0", entries: [{ name: "bin/gs", sha256: SHA_A, bytes: 9, path: "p" }] },
    });
    expect(result.warnings.some((issue) => issue.code === EXPORT_FONT_MISSING)).toBe(false);
  });

  it("manifest 失败码并入 failures", () => {
    const result = preflightExport({
      inputKind: "docx",
      target: "pdf",
      pages: [{ text: "正文" }],
      fonts: ["Noto Sans CJK"],
      manifest: {
        name: "vendor",
        version: "1.0.0",
        entries: [
          { name: "bin/soffice", sha256: SHA_A, bytes: 1, path: "p" },
          { name: "bin/soffice", sha256: SHA_A, bytes: 1, path: "p" },
        ],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(EXPORT_MANIFEST_MISMATCH);
    expect(result.failures.some((issue) => issue.code === EXPORT_MANIFEST_MISMATCH)).toBe(true);
  });

  it("路由失败时 code 就是路由码", () => {
    const result = preflightExport({ inputKind: "md", target: "pdf", pages: [{ text: "正文" }] });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(EXPORT_UNSUPPORTED);
    expect(result.failures).toEqual([]);
    expect(result.route.code).toBe(EXPORT_UNSUPPORTED);
  });

  it("引擎缺失时 code=ENGINE_MISSING", () => {
    const result = preflightExport({
      inputKind: "pptx",
      target: "png",
      pages: [{ text: "正文" }],
      availableEngines: ["soffice"],
    });
    expect(result.code).toBe(EXPORT_ENGINE_MISSING);
  });

  it("离线且引擎要联网时 code=ENGINE_UNAVAILABLE", () => {
    const result = preflightExport({
      inputKind: "pptx",
      target: "pdf",
      pages: [{ text: "正文" }],
      offline: true,
      engineSpecs: { soffice: { engine: "soffice", requiresNetwork: true } },
    });
    expect(result.code).toBe(EXPORT_ENGINE_UNAVAILABLE);
  });

  it("多处问题全收(占位 + 空页 + 外链)", () => {
    const result = preflightExport({
      inputKind: "md",
      target: "html",
      pages: [{ text: "TODO" }, {}],
      externalRefs: ["file:///tmp/a.png"],
      offline: true,
    });
    const codes = result.failures.map((issue) => issue.code);
    expect(codes).toContain(EXPORT_PLACEHOLDER);
    expect(codes).toContain(EXPORT_EMPTY_PAGE);
    expect(codes).toContain(EXPORT_OFFLINE_VIOLATION);
    expect(result.code).toBe(EXPORT_PLACEHOLDER);
  });
});

describe("verifyArtifact", () => {
  it("字节数非正 → ARTIFACT_INVALID", () => {
    const verdict = verifyArtifact({ inputSha256: SHA_A, artifactSha256: SHA_B, bytes: 0, pages: 1 });
    expect(verdict).toEqual({ ok: false, code: EXPORT_ARTIFACT_INVALID, detail: "空产物:字节数必须为正" });
  });

  it("页数非正 → ARTIFACT_INVALID", () => {
    expect(verifyArtifact({ inputSha256: SHA_A, artifactSha256: SHA_B, bytes: 10, pages: 0 }).code).toBe(
      EXPORT_ARTIFACT_INVALID);
  });

  it("inputSha256 形态不对 → ARTIFACT_INVALID", () => {
    const verdict = verifyArtifact({ inputSha256: "zz", artifactSha256: SHA_B, bytes: 10, pages: 1 });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain("inputSha256");
  });

  it("artifactSha256 缺失 → ARTIFACT_INVALID", () => {
    expect(verifyArtifact({ inputSha256: SHA_A, bytes: 10, pages: 1 }).code).toBe(EXPORT_ARTIFACT_INVALID);
  });

  it("expectedPages 不符 → detail 写期望与实际", () => {
    const verdict = verifyArtifact({
      inputSha256: SHA_A,
      artifactSha256: SHA_B,
      bytes: 10,
      pages: 3,
      expectedPages: 5,
    });
    expect(verdict.code).toBe(EXPORT_ARTIFACT_INVALID);
    expect(verdict.detail).toContain("5");
    expect(verdict.detail).toContain("3");
  });

  it("合法产物 → ok(不要求两个 sha 相等)", () => {
    const verdict = verifyArtifact({
      inputSha256: SHA_A,
      artifactSha256: SHA_B,
      bytes: 10,
      pages: 2,
      expectedPages: 2,
    });
    expect(verdict).toEqual({ ok: true, code: EXPORT_OK, detail: "产物校验通过" });
  });
});

describe("offlineGuarantee", () => {
  it("引擎需要网络 → 不满足", () => {
    const result = offlineGuarantee({
      engine: "soffice",
      manifestVerified: true,
      mediaEmbedded: true,
      engineSpecs: { soffice: { engine: "soffice", requiresNetwork: true } },
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(EXPORT_OFFLINE_VIOLATION);
    expect(result.reasons[0]).toContain("soffice");
  });

  it("存在外链 → 不满足并逐条点名", () => {
    const result = offlineGuarantee({
      engine: "native-md",
      externalRefs: ["https://example.com/a", "file:///tmp/b"],
      manifestVerified: true,
      mediaEmbedded: true,
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.length).toBe(2);
    expect(result.reasons.join("\n")).toContain("https://example.com/a");
  });

  it("清单未校验 → 不满足", () => {
    const result = offlineGuarantee({ engine: "gs", manifestVerified: false, mediaEmbedded: true });
    expect(result.code).toBe(EXPORT_OFFLINE_VIOLATION);
    expect(result.reasons).toEqual(["vendor 清单未通过校验"]);
  });

  it("媒体未内嵌 → 不满足", () => {
    const result = offlineGuarantee({ engine: "gs", manifestVerified: true, mediaEmbedded: false });
    expect(result.reasons).toEqual(["媒体未内嵌"]);
  });

  it("四条件全满足 → ok", () => {
    const result = offlineGuarantee({
      engine: "native-html",
      externalRefs: [],
      manifestVerified: true,
      mediaEmbedded: true,
    });
    expect(result).toEqual({ ok: true, code: EXPORT_OK, reasons: [] });
  });
});
