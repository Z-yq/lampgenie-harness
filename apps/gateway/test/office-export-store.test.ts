/**
 * office-export-store(-B)单测:抽取层 / manifest / 引擎壳 / 产物与账本 / 组合流程。
 * 夹具纪律:
 * - OOXML 夹具全部用 jszip 在 /tmp 的 mkdtemp 目录里现场造(仓里不塞二进制);
 * - 需要「真引擎」的用例(renderToPdf/renderToPng/runVerify)用 pptxgenjs 现场生成 deck 再交给 soffice/gs;
 * - 真实件只有 docs/review/harness-intro.pptx(仓库自带的介绍稿);
 * - 引擎缺失用不存在的绝对路径 bin 触发(不依赖环境里到底有没有装 soffice);
 * - afterAll 递归删掉临时根,不留垃圾。
 */
import { afterAll, describe, expect, it } from "vitest";
import JSZip from "jszip";
import pptxgenjs from "pptxgenjs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  OFFICE_EXPORT_STORE_CODES,
  OfficeExportError,
  exitCodeOf,
  extractFacts,
  inputKindOf,
  officeExportPaths,
  pdfPageCount,
  readExportLedger,
  readManifest,
  registerManifest,
  renderToPdf,
  renderToPng,
  resolveSafeRoot,
  runPreflight,
  runVerify,
  sha256Hex,
  verifyManifestFiles,
  writeExportReport,
} from "../src/office-export-store.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const REAL_PPTX = join(REPO_ROOT, "docs/review/harness-intro.pptx");

/** 产物根必须能过 /tmp 闸,所以临时目录固定建在 /tmp(mkdtemp:进程/轮次唯一)。 */
const TMP_ROOT = mkdtempSync("/tmp/m106-export-test-");
const OUT_ROOT = join(TMP_ROOT, "root");
mkdirSync(OUT_ROOT, { recursive: true });

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
 /* 清理失败不影响结论 */
  }
});

let seq = 0;
function tmpFile(name: string, content?: string | Buffer): string {
  seq += 1;
  const file = join(TMP_ROOT, `${seq}-${name}`);
  mkdirSync(TMP_ROOT, { recursive: true });
  if (content !== undefined) writeFileSync(file, content);
  return file;
}

/** 取 store 抛出的稳定码(没 throw 就返回 <no-throw>,断言会明显失败而不是静默通过)。 */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    const boxed = err as { code?: unknown; message?: unknown };
    if (typeof boxed.code === "string") return boxed.code;
    return `<other:${typeof boxed.message === "string" ? boxed.message : String(err)}>`;
  }
  return "<no-throw>";
}

const P_NS =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** 一个 slide:spTree 里放 sp(带 a:t)与可选的 pic/graphicFrame。 */
function slideXml(texts: readonly string[], opts?: { pic?: number; latin?: readonly string[] }): string {
  const latin = (opts?.latin ?? []).map((typeface) => `<a:latin typeface="${typeface}"/>`).join("");
  const run = texts.map((text) => `<a:p><a:r><a:rPr>${latin}</a:rPr><a:t>${text}</a:t></a:r></a:p>`).join("");
  const shape = texts.length === 0 ? "" : `<p:sp><p:txBody>${run}</p:txBody></p:sp>`;
  const pics = Array.from({ length: opts?.pic ?? 0 }, () => "<p:pic><p:blipFill><a:blip/></p:blipFill></p:pic>").join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?><p:sld ${P_NS}><p:cSld><p:spTree>` +
    `${shape}${pics}` +
    `</p:spTree></p:cSld></p:sld>`
  );
}

/** 现场造最小 pptx(slides 逐页;可带 External rels)。 */
async function makePptx(opts: { slides: readonly string[]; externalRels?: readonly string[] }): Promise<string> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  );
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${P_NS}><p:sldIdLst>${opts.slides
      .map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`)
      .join("")}</p:sldIdLst></p:presentation>`,
  );
  opts.slides.forEach((xml, index) => {
    zip.file(`ppt/slides/slide${index + 1}.xml`, xml);
  });
  if (opts.externalRels !== undefined && opts.externalRels.length > 0) {
    const rels = opts.externalRels
      .map(
        (target, index) =>
          `<Relationship Id="rId9${index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${target}" TargetMode="External"/>`,
      )
      .join("");
    zip.file(
      "ppt/slides/_rels/slide1.xml.rels",
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
    );
  }
  const file = tmpFile("fixture.pptx");
  writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
  return file;
}

async function makeDocx(): Promise<string> {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body>' +
      '<w:p><w:pPr><w:rPr><w:rFonts w:ascii="Calibri"/></w:rPr></w:pPr><w:r><w:t>第一段正文</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>第二段</w:t></w:r></w:p>' +
      '<w:p><w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r></w:p>' +
      "</w:body></w:document>",
  );
  const file = tmpFile("fixture.docx");
  writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
  return file;
}

async function makeXlsx(): Promise<string> {
  const zip = new JSZip();
  zip.file(
    "xl/workbook.xml",
    '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets>' +
      '<sheet name="销售" sheetId="1" r:id="rId1"/>' +
      '<sheet name="空表" sheetId="2" r:id="rId2"/>' +
      "</sheets></workbook>",
  );
  zip.file(
    "xl/sharedStrings.xml",
    '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      "<si><t>销售额</t></si></sst>",
  );
  zip.file(
    "xl/worksheets/sheet1.xml",
    '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>直接文本</t></is></c></row>' +
      "</sheetData></worksheet>",
  );
  zip.file(
    "xl/worksheets/sheet2.xml",
    '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"/></row></sheetData></worksheet>',
  );
  const file = tmpFile("fixture.xlsx");
  writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
  return file;
}

/** pptxgenjs 生成的真 deck(既能抽事实,也能交给 soffice 转 PDF)。 */
async function makePptxGenJsDeck(slides: readonly (readonly string[])[]): Promise<string> {
  const deck = new pptxgenjs();
  deck.layout = "LAYOUT_16x9";
  for (const texts of slides) {
    const slide = deck.addSlide();
    texts.forEach((text, index) => {
      slide.addText(text, { x: 0.6, y: 0.6 + index * 0.9, w: 8, h: 0.8, fontSize: 20 });
    });
  }
  const file = tmpFile("deck.pptx");
  await deck.writeFile({ fileName: file });
  return file;
}

// ---------------------------------------------------------------------------
// 路径与安全闸
// ---------------------------------------------------------------------------

describe("resolveSafeRoot / officeExportPaths", () => {
  it("拒绝 / 作为 root", () => {
    expect(codeOf(() => resolveSafeRoot("/"))).toBe("OFFICE_EXPORT_ROOT_UNSAFE");
  });

  it("拒绝仓内路径", () => {
    expect(codeOf(() => resolveSafeRoot(join(REPO_ROOT, ".genie/office")))).toBe("OFFICE_EXPORT_ROOT_UNSAFE");
  });

  it("接受 /tmp 下的目录并返回 realpath", () => {
    const root = join(TMP_ROOT, "safe-root");
    const safe = resolveSafeRoot(root);
    expect(safe.startsWith("/tmp/")).toBe(true);
    expect(existsSync(safe)).toBe(true);
  });

  it("产物路径固定在 .genie/office 下", () => {
    const paths = officeExportPaths(join(TMP_ROOT, "paths-root"));
    expect(paths.dir.endsWith("/.genie/office")).toBe(true);
    expect(paths.vendorDir.endsWith("/.genie/office/vendor")).toBe(true);
    expect(paths.outDir.endsWith("/.genie/office/export")).toBe(true);
    expect(paths.ledgerFile.endsWith("/.genie/office/ledger.jsonl")).toBe(true);
  });

  it("稳定码表与 sha256 归一", () => {
    expect([...OFFICE_EXPORT_STORE_CODES]).toEqual([
      "OFFICE_EXPORT_ROOT_UNSAFE",
      "OFFICE_EXPORT_FILE_UNREADABLE",
      "OFFICE_EXPORT_RENDER_FAILED",
      "OFFICE_EXPORT_USAGE",
    ]);
    expect(sha256Hex("abc")).toBe(sha256Hex(Buffer.from("abc", "utf8")));
    expect(sha256Hex("abc")).toHaveLength(64);
  });

  it("inputKindOf 认扩展名,认不出返回 null", () => {
    expect(inputKindOf("/tmp/a.pptx")).toBe("pptx");
    expect(inputKindOf("/tmp/a.docx")).toBe("docx");
    expect(inputKindOf("/tmp/a.xlsx")).toBe("xlsx");
    expect(inputKindOf("/tmp/a.md")).toBe("md");
    expect(inputKindOf("/tmp/a.html")).toBe("html");
    expect(inputKindOf("/tmp/a.pdf")).toBe("pdf");
    expect(inputKindOf("/tmp/a.zip")).toBeNull();
    expect(inputKindOf("/tmp/noext")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 抽取:真实件 + 现场夹具
// ---------------------------------------------------------------------------

describe("extractFacts", () => {
  it("真实 harness-intro.pptx:页数>0、每页有文本、字体非空", async () => {
    const facts = await extractFacts(REAL_PPTX);
    expect(facts.inputKind).toBe("pptx");
    expect(facts.pageCount).toBeGreaterThan(0);
    expect(facts.pages).toHaveLength(facts.pageCount);
    for (const page of facts.pages) {
      expect((page.texts ?? []).length).toBeGreaterThan(0);
    }
    expect(facts.fonts.length).toBeGreaterThan(0);
    expect(facts.fonts.some((font) => font.startsWith("+"))).toBe(false);
  });

  it("最小 pptx:抽到 External 外链与 TODO 占位,空页 nonEmpty=false", async () => {
    const file = await makePptx({
      slides: [
        slideXml(["TODO: 补标题", "正文一"], { latin: ["思源黑体", "+mn-lt"], pic: 1 }),
        slideXml([]),
      ],
      externalRels: ["https://example.com/bg.png"],
    });
    const facts = await extractFacts(file);
    expect(facts.pageCount).toBe(2);
    expect(facts.pages[0]?.texts).toContain("TODO: 补标题");
    expect(facts.pages[0]?.images).toBe(1);
    expect(facts.placeholders).toContain("TODO");
    expect(facts.externalRefs).toContain("https://example.com/bg.png");
    expect(facts.fonts).toContain("思源黑体");
    expect(facts.fonts).not.toContain("+mn-lt");
 // 外链图 = 媒体没内嵌
    expect(facts.mediaEmbedded).toBe(false);
    const empty = facts.pages[1]!;
    const nonEmpty =
      (empty.text ?? "").length > 0 || (empty.texts ?? []).length > 0 || (empty.shapes ?? 0) > 0 || (empty.images ?? 0) > 0;
    expect(nonEmpty).toBe(false);
  });

  it("最小 docx:整篇一页,段落文本/字体/图片都在", async () => {
    const facts = await extractFacts(await makeDocx());
    expect(facts.inputKind).toBe("docx");
    expect(facts.pageCount).toBe(1);
    expect(facts.pages[0]?.texts).toContain("第一段正文");
    expect(facts.pages[0]?.texts).toContain("第二段");
    expect(facts.pages[0]?.images).toBe(1);
    expect(facts.fonts).toContain("Calibri");
    expect(facts.mediaEmbedded).toBe(true);
  });

  it("最小 xlsx:workbook 的 sheet 数=页数,sharedStrings 能回填,空表不算有内容", async () => {
    const facts = await extractFacts(await makeXlsx());
    expect(facts.inputKind).toBe("xlsx");
    expect(facts.pageCount).toBe(2);
    expect(facts.pages).toHaveLength(2);
    expect(facts.pages[0]?.texts).toContain("销售额");
    expect(facts.pages[0]?.texts).toContain("直接文本");
    expect(facts.pages[1]?.texts ?? []).toHaveLength(0);
  });

  it("md:代码块里的 TODO 不算占位,正文 TODO 与外链照收", async () => {
    const onlyCode = tmpFile(
      "code-only.md",
      ["# 标题", "", "```ts", "// TODO: 示例代码里的待办", "```", ""].join("\n"),
    );
    expect((await extractFacts(onlyCode)).placeholders).toHaveLength(0);

    const withBody = tmpFile(
      "body.md",
      ["# 标题", "", "TODO: 正文待办", "", "参考 https://example.com/doc", ""].join("\n"),
    );
    const facts = await extractFacts(withBody);
    expect(facts.placeholders).toContain("TODO");
    expect(facts.externalRefs.some((ref) => ref.includes("example.com/doc"))).toBe(true);
  });

  it("html:script/style 被剔掉,正文留下,href 进外链", async () => {
    const file = tmpFile(
      "page.html",
      '<html><head><style>.a{color:red}</style><script>var TODO = "x";</script></head>' +
        '<body><p>正文段落</p><a href="https://example.com/b">链接</a></body></html>',
    );
    const facts = await extractFacts(file);
    expect(facts.inputKind).toBe("html");
    expect(facts.pageCount).toBe(1);
    expect(facts.pages[0]?.text ?? "").toContain("正文段落");
    expect(facts.pages[0]?.text ?? "").not.toContain("TODO");
    expect(facts.placeholders).toHaveLength(0);
    expect(facts.externalRefs).toContain("https://example.com/b");
  });

  it("读不到/不是压缩包一律 throw FILE_UNREADABLE,不返回假事实", async () => {
    await expect(extractFacts(join(TMP_ROOT, "nope.pptx"))).rejects.toThrow(OfficeExportError);
    await expect(extractFacts(tmpFile("broken.pptx", "not a zip"))).rejects.toThrow(/OOXML/);
    await expect(extractFacts(tmpFile("empty.docx", ""))).rejects.toThrow(/为空/);
  });
});

// ---------------------------------------------------------------------------
// 引擎壳
// ---------------------------------------------------------------------------

describe("renderToPdf / renderToPng / pdfPageCount", () => {
  it(
    "真 soffice 出 PDF(>0 字节)+ 真 gs 出 PNG(>0 张)",
    async () => {
      const deck = await makePptxGenJsDeck([["导出冒烟一"], ["导出冒烟二"]]);
      const pdfDir = join(TMP_ROOT, "render-pdf");
      const rendered = renderToPdf(deck, pdfDir);
      expect(rendered.engine).toBe("soffice");
      expect(rendered.pdfPath).not.toBeNull();
      expect(statSync(rendered.pdfPath!).size).toBeGreaterThan(0);
      expect(pdfPageCount(rendered.pdfPath!)).toBeGreaterThanOrEqual(2);

      const pngDir = join(TMP_ROOT, "render-png");
      const rastered = renderToPng(rendered.pdfPath!, pngDir);
      expect(rastered.engine).toBe("gs");
      expect(rastered.pngPaths.length).toBeGreaterThan(0);
      for (const png of rastered.pngPaths) expect(statSync(png).size).toBeGreaterThan(0);
    },
    240_000);

  it("引擎缺失:soffice 与 gs 都报 EXPORT_ENGINE_MISSING", async () => {
    const deck = await makePptxGenJsDeck([["缺失引擎用例"]]);
    expect(codeOf(() => renderToPdf(deck, join(TMP_ROOT, "missing-pdf"), { bin: "/nonexistent/soffice-xyz" }))).toBe(
      "EXPORT_ENGINE_MISSING",
    );
    expect(
      codeOf(() => renderToPng(deck, join(TMP_ROOT, "missing-png"), { bin: "/nonexistent/gs-xyz" })),
    ).toBe("EXPORT_ENGINE_MISSING");
  });

  it("非 PDF 输入喂给 gs 会失败(不伪造产物)", () => {
    const bogus = tmpFile("bogus.pdf", "%PDF-1.4 not really a pdf");
    expect(codeOf(() => renderToPng(bogus, join(TMP_ROOT, "bogus-png")))).toBe("OFFICE_EXPORT_RENDER_FAILED");
  });
});

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

describe("registerManifest / verifyManifestFiles", () => {
  it("同文件登记两次 reused=true,内容一改就 MANIFEST_MISMATCH", () => {
    const root = join(TMP_ROOT, "manifest-root");
    const vendor = tmpFile("vendor-a.bin", "fonts-and-templates-v1");
    const first = registerManifest(root, "acme", vendor);
    expect(first.reused).toBe(false);
    expect(first.manifest.entries).toHaveLength(1);
    expect(first.manifest.entries[0]?.name).toBe(basename(vendor));
    expect(first.manifest.entries[0]?.sha256).toBe(sha256Hex(readFileSync(vendor)));
    expect(existsSync(first.path)).toBe(true);

    const second = registerManifest(root, "acme", vendor);
    expect(second.reused).toBe(true);
    expect(second.manifest.entries).toHaveLength(1);

    expect(verifyManifestFiles(root, "acme", [{ path: vendor }]).verdict.code).toBe("EXPORT_OK");

    writeFileSync(vendor, "fonts-and-templates-v2");
    const tampered = verifyManifestFiles(root, "acme", [{ path: vendor }]);
    expect(tampered.verdict.code).toBe("EXPORT_MANIFEST_MISMATCH");
    expect(tampered.actual[0]?.sha256).toBe(sha256Hex(readFileSync(vendor)));
  });

  it("manifest 不存在 → MANIFEST_MISSING;readManifest 返回 null", () => {
    const root = join(TMP_ROOT, "manifest-empty");
    expect(readManifest(root, "ghost")).toBeNull();
    const out = verifyManifestFiles(root, "ghost", [{ path: tmpFile("ghost.bin", "x") }]);
    expect(out.verdict.code).toBe("EXPORT_MANIFEST_MISSING");
    expect(out.verdict.ok).toBe(false);
  });

  it("manifest name 含 / 或 .. 报 OFFICE_EXPORT_USAGE", () => {
    const root = join(TMP_ROOT, "manifest-bad");
    const vendor = tmpFile("vendor-b.bin", "z");
    expect(codeOf(() => registerManifest(root, "a/b", vendor))).toBe("OFFICE_EXPORT_USAGE");
    expect(codeOf(() => registerManifest(root, "..", vendor))).toBe("OFFICE_EXPORT_USAGE");
    expect(codeOf(() => registerManifest(root, "", vendor))).toBe("OFFICE_EXPORT_USAGE");
  });

  it("同名文件换内容会覆盖该条(entries 不重复)", () => {
    const root = join(TMP_ROOT, "manifest-overwrite");
    const vendor = tmpFile("vendor-c.bin", "v1");
    registerManifest(root, "acme", vendor);
    writeFileSync(vendor, "v2-different-bytes");
    const again = registerManifest(root, "acme", vendor);
    expect(again.reused).toBe(false);
    expect(again.manifest.entries).toHaveLength(1);
    expect(again.manifest.entries[0]?.sha256).toBe(sha256Hex(readFileSync(vendor)));
  });

  it("登记条目带本地绝对 path:落盘可读回,离线校验直接 EXPORT_OK", () => {
    const root = join(TMP_ROOT, "manifest-path");
    const vendor = tmpFile("vendor-offline.zip", "offline-vendor-bytes-v1");
    const registered = registerManifest(root, "acme", vendor);

    const entry = registered.manifest.entries[0];
    expect(entry?.path).toBe(resolve(vendor));
    expect(isAbsolute(entry?.path ?? "")).toBe(true);

 // 落盘的清单读回来同样带 path(不是只在返回值里补)
    const reread = readManifest(root, "acme");
    expect(reread?.entries[0]?.path).toBe(resolve(vendor));

    const online = verifyManifestFiles(root, "acme", [{ path: vendor }]);
    expect(online.verdict.code).toBe("EXPORT_OK");
    const offline = verifyManifestFiles(root, "acme", [{ path: vendor }], { offline: true });
    expect(offline.verdict.code).toBe("EXPORT_OK");
  });

  it("同文件重复登记 reused=true;同 basename 换目录(同内容)则重写并以最新 path 为准", () => {
    const root = join(TMP_ROOT, "manifest-reuse-path");
    const first = tmpFile("same-base.bin", "same-content-bytes");
    const one = registerManifest(root, "acme", first);
    expect(one.reused).toBe(false);

    const again = registerManifest(root, "acme", first);
    expect(again.reused).toBe(true);
    expect(again.manifest.entries).toHaveLength(1);
    expect(again.manifest.entries[0]?.path).toBe(resolve(first));

 // 同 basename 但来自另一目录:内容一致也必须重写,path 取最新
    const elsewhere = join(TMP_ROOT, "manifest-reuse-path-copy");
    mkdirSync(elsewhere, { recursive: true });
    const copy = join(elsewhere, basename(first));
    writeFileSync(copy, "same-content-bytes");
    const moved = registerManifest(root, "acme", copy);
    expect(moved.reused).toBe(false);
    expect(moved.manifest.entries).toHaveLength(1);
    expect(moved.manifest.entries[0]?.path).toBe(resolve(copy));
  });

  it("旧清单(entries 无 path)可读可在线校验,离线仍如实报 OFFLINE_VIOLATION", () => {
    const root = join(TMP_ROOT, "manifest-legacy");
    const legacyFile = tmpFile("legacy.bin", "legacy-bytes-v1");
    const legacyBytes = readFileSync(legacyFile);
 // 手写旧格式清单:没有 path 字段
    const vendorDir = officeExportPaths(root).vendorDir;
    mkdirSync(vendorDir, { recursive: true });
    writeFileSync(
      join(vendorDir, "acme.manifest.json"),
      JSON.stringify({
        name: "acme",
        version: "1",
        entries: [{ name: basename(legacyFile), sha256: sha256Hex(legacyBytes), bytes: legacyBytes.length }],
      }),
    );

    const reread = readManifest(root, "acme");
    expect(reread?.entries).toHaveLength(1);
    expect(reread?.entries[0]?.path).toBeUndefined();

 // 在线校验不受影响
    expect(verifyManifestFiles(root, "acme", [{ path: legacyFile }]).verdict.code).toBe("EXPORT_OK");

 // 离线按 runtime 规则如实拒绝,不静默补 path
    const offline = verifyManifestFiles(root, "acme", [{ path: legacyFile }], { offline: true });
    expect(offline.verdict.code).toBe("EXPORT_OFFLINE_VIOLATION");
    expect(offline.verdict.mismatches.some((item) => item.includes("离线模式要求本地 path"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 产物与账本 / 退出码
// ---------------------------------------------------------------------------

describe("writeExportReport / readExportLedger / exitCodeOf", () => {
  it("同 sha+target 幂等:第二次 reused、账本行数不变;换 target 追加一行", () => {
    const root = join(TMP_ROOT, "report-root");
    const inputSha256 = sha256Hex("input-bytes");
    const base = {
      inputPath: "/tmp/deck.pptx",
      inputSha256,
      target: "pdf" as const,
      code: "EXPORT_OK" as const,
    };
    const first = writeExportReport(root, { ...base, at: 1_700_000_000_000 });
    expect(first.reused).toBe(false);
    expect(first.ledgerAppended).toBe(true);
    expect(existsSync(first.reportPath)).toBe(true);
    expect(first.reportPath.endsWith(`/${inputSha256.slice(0, 12)}.json`)).toBe(true);

    const second = writeExportReport(root, { ...base, at: 1_700_000_123_456 });
    expect(second.reused).toBe(true);
    expect(second.ledgerAppended).toBe(false);
    expect(readExportLedger(root)).toHaveLength(1);

    const other = writeExportReport(root, { ...base, target: "md", at: 1_700_000_200_000 });
    expect(other.ledgerAppended).toBe(true);
    expect(readExportLedger(root)).toHaveLength(2);
    expect(readExportLedger(root).map((line) => line.target).sort()).toEqual(["md", "pdf"]);

    const ledgerText = readFileSync(join(officeExportPaths(root).ledgerFile), "utf8");
    expect(ledgerText.trim().split("\n")).toHaveLength(2);
  });

  it("exitCodeOf 三档:OK=0、内容违规=2、其余=1", () => {
    expect(exitCodeOf("EXPORT_OK")).toBe(0);
    for (const code of [
      "EXPORT_UNSUPPORTED",
      "EXPORT_MANIFEST_MISSING",
      "EXPORT_MANIFEST_MISMATCH",
      "EXPORT_EXTERNAL_REF",
      "EXPORT_PLACEHOLDER",
      "EXPORT_EMPTY_PAGE",
      "EXPORT_EMPTY_DECK",
      "EXPORT_OFFLINE_VIOLATION",
      "EXPORT_ARTIFACT_INVALID",
    ]) {
      expect(exitCodeOf(code)).toBe(2);
    }
    for (const code of ["EXPORT_INVALID", "EXPORT_ENGINE_MISSING", "EXPORT_ENGINE_UNAVAILABLE", ...OFFICE_EXPORT_STORE_CODES]) {
      expect(exitCodeOf(code)).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 组合流程
// ---------------------------------------------------------------------------

describe("runPreflight", () => {
  it("真实 deck → EXPORT_OK", async () => {
    const out = await runPreflight(join(TMP_ROOT, "preflight-real"), REAL_PPTX, "pdf");
    expect(out.preflight.code).toBe("EXPORT_OK");
    expect(out.preflight.ok).toBe(true);
    expect(out.preflight.route.engine).toBe("soffice");
    expect(existsSync(out.reportPath)).toBe(true);
    expect(out.facts.pageCount).toBeGreaterThan(0);
  });

  it("含 TODO 的 pptxgenjs deck → EXPORT_PLACEHOLDER", async () => {
    const deck = await makePptxGenJsDeck([["封面"], ["TODO: 补充要点"]]);
    const out = await runPreflight(join(TMP_ROOT, "preflight-placeholder"), deck, "pdf");
    expect(out.preflight.code).toBe("EXPORT_PLACEHOLDER");
    expect(out.preflight.failures.map((issue) => issue.code)).toContain("EXPORT_PLACEHOLDER");
  });

  it("有一页全空的 pptxgenjs deck → EXPORT_EMPTY_PAGE 且点名第 2 页", async () => {
 // pptxgenjs 的 addSlide 不带任何对象 = 真空页。
    const emptyDeck = await makePptxGenJsDeck([["有内容的一页"], []]);
    const facts = await extractFacts(emptyDeck);
    expect(facts.pageCount).toBeGreaterThanOrEqual(2);
    expect((facts.pages[0]?.texts ?? []).length).toBeGreaterThan(0);
    expect((facts.pages[1]?.texts ?? []).length).toBe(0);

    const out = await runPreflight(join(TMP_ROOT, "preflight-empty"), emptyDeck, "pdf");
    expect(out.preflight.code).toBe("EXPORT_EMPTY_PAGE");
    const detail = out.preflight.failures.map((issue) => issue.detail).join(" | ");
    expect(detail).toContain("第 2 页");
  });
});

describe("runVerify", () => {
  it("真实 PDF 产物 → EXPORT_OK;页数错一位 → ARTIFACT_INVALID;空文件 → invalid", async () => {
    const deck = await makePptxGenJsDeck([["校验页一"], ["校验页二"]]);
    const pdf = renderToPdf(deck, join(TMP_ROOT, "verify-pdf")).pdfPath!;
    const root = join(TMP_ROOT, "verify-root");

    const ok = runVerify(root, deck, pdf);
    expect(ok.verdict.ok).toBe(true);
    expect(ok.verdict.code).toBe("EXPORT_OK");
    expect(ok.artifactPages).toBeGreaterThanOrEqual(2);
    expect(ok.artifactSha256).toBe(sha256Hex(readFileSync(pdf)));
    expect(existsSync(ok.reportPath)).toBe(true);

    const wrong = runVerify(root, deck, pdf, ok.artifactPages + 1);
    expect(wrong.verdict.ok).toBe(false);
    expect(wrong.verdict.code).toBe("EXPORT_ARTIFACT_INVALID");

    const empty = tmpFile("empty-artifact.pdf", "");
    const bad = runVerify(root, deck, empty);
    expect(bad.verdict.ok).toBe(false);
    expect(bad.verdict.code).toBe("EXPORT_ARTIFACT_INVALID");
  }, 240_000);
});
