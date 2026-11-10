import { describe, it, expect, afterAll } from "vitest";
import JSZip from "jszip";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkOfficeArtifact, type QaFinding } from "../src/office-qa.js";

/** 产物 QA 合约:用 jszip 现场造最小 OOXML 夹具,不依赖仓内二进制。
 *  覆盖:三类产物正常、坏 zip、缺必需 part、占位残留、空内容、不支持扩展、
 *  XML 解析失败、checker 内部异常不得算通过。 */
const dir = mkdtempSync(join(tmpdir(), "office-qa-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, data: Buffer | string): string {
  const p = join(dir, name);
  writeFileSync(p, data);
  return p;
}

const PPT_PRESENTATION =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst/></p:presentation>';

function slideXml(text: string | null): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>' +
    '<p:sp><p:txBody><a:p><a:r><a:t>' +
    (text ?? "") +
    "</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>"
  );
}

function docXml(text: string | null): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    "<w:p><w:r><w:t>" +
    (text ?? "") +
    "</w:t></w:r></w:p></w:body></w:document>"
  );
}

const WORKBOOK_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets/></workbook>';

const SHARED_STRINGS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>季度总结</t></si></sst>';

async function makePptx(opts: { presentation?: boolean; text?: string | null } = {}): Promise<Buffer> {
  const zip = new JSZip();
  if (opts.presentation !== false) zip.file("ppt/presentation.xml", PPT_PRESENTATION);
  if (opts.text !== null) zip.file("ppt/slides/slide1.xml", slideXml(opts.text === undefined ? "季度汇报" : opts.text));
  return zip.generateAsync({ type: "nodebuffer" });
}

async function makeDocx(opts: { document?: boolean; text?: string | null; documentXml?: string } = {}): Promise<Buffer> {
  const zip = new JSZip();
  if (opts.document !== false) zip.file("word/document.xml", opts.documentXml ?? docXml(opts.text === undefined ? "正文" : opts.text));
  return zip.generateAsync({ type: "nodebuffer" });
}

async function makeXlsx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("xl/workbook.xml", WORKBOOK_XML);
  zip.file("xl/sharedStrings.xml", SHARED_STRINGS);
  return zip.generateAsync({ type: "nodebuffer" });
}

function find(report: { findings: QaFinding[] }, code: string): QaFinding | undefined {
  return report.findings.find((f) => f.code === code);
}

describe("office-qa: 合法产物", () => {
  it("最小 pptx/docx/xlsx 均 ok,且每项 finding 都有 remediation 字段", async () => {
    const cases: Array<[string, Buffer]> = [
      ["ok.pptx", await makePptx()],
      ["ok.docx", await makeDocx()],
      ["ok.xlsx", await makeXlsx()],
    ];
    for (const [name, buf] of cases) {
      const report = await checkOfficeArtifact(write(name, buf));
      expect(report.ok, `${name} 应通过`).toBe(true);
      expect(report.findings.every((f) => typeof f.remediation === "string")).toBe(true);
      expect(report.findings.some((f) => !f.passed && f.severity === "error")).toBe(false);
    }
  });
});

describe("office-qa: 结构缺陷", () => {
  it("坏 zip → invalid-zip(error)", async () => {
    const report = await checkOfficeArtifact(write("bad.pptx", Buffer.from("this is definitely not a zip")));
    expect(report.ok).toBe(false);
    const f = find(report, "invalid-zip");
    expect(f).toBeTruthy();
    expect(f?.passed).toBe(false);
    expect(f?.severity).toBe("error");
    expect(f?.remediation.length).toBeGreaterThan(0);
  });

  it("缺必需 part(pptx 无 presentation.xml)→ missing-part(error)", async () => {
    const report = await checkOfficeArtifact(write("no-part.pptx", await makePptx({ presentation: false })));
    expect(report.ok).toBe(false);
    const f = find(report, "missing-part");
    expect(f?.passed).toBe(false);
    expect(f?.message).toContain("ppt/presentation.xml");
  });

  it("XML 标签不闭合 → xml-parse-error(error)", async () => {
    const broken = docXml("正文").replace("</w:body>", "");
    const report = await checkOfficeArtifact(write("broken.docx", await makeDocx({ documentXml: broken })));
    expect(report.ok).toBe(false);
    expect(find(report, "xml-parse-error")?.passed).toBe(false);
  });

  it("空内容(无文本节点)→ empty-content(error)", async () => {
    const report = await checkOfficeArtifact(write("empty.docx", await makeDocx({ text: null })));
    expect(report.ok).toBe(false);
    expect(find(report, "empty-content")?.passed).toBe(false);
  });
});

describe("office-qa: 内容质量", () => {
  it("占位残留(TODO/{{…}}/[待填]/lorem ipsum)→ placeholder-residue(error)", async () => {
    const texts = ["TODO: 补充结论", "{{ 标题 }}", "[待填] 请补充", "lorem ipsum dolor"];
    for (const [i, text] of texts.entries()) {
      const report = await checkOfficeArtifact(write(`placeholder-${i}.docx`, await makeDocx({ text })));
      expect(report.ok, text).toBe(false);
      const f = find(report, "placeholder-residue");
      expect(f?.passed, text).toBe(false);
      expect(f?.remediation.length).toBeGreaterThan(0);
    }
  });
});

describe("office-qa: 边界", () => {
  it("不支持的扩展 → unsupported-ext(error)", async () => {
    const report = await checkOfficeArtifact(write("note.txt", "hello"));
    expect(report.ok).toBe(false);
    expect(find(report, "unsupported-ext")?.passed).toBe(false);
  });

  it("文件不存在 → io-error,不当通过", async () => {
    const report = await checkOfficeArtifact(join(dir, "nope.pptx"));
    expect(report.ok).toBe(false);
    expect(find(report, "io-error")?.passed).toBe(false);
  });

  it("checker 内部异常 → checker-crash(error),绝不 ok", async () => {
    // 畸形入参:toString 抛错,触发外层 catch 兜底
    const evil = {
      toString() {
        throw new Error("boom-from-test");
      },
    } as unknown as string;
    const report = await checkOfficeArtifact(evil);
    expect(report.ok).toBe(false);
    const f = find(report, "checker-crash");
    expect(f?.passed).toBe(false);
    expect(f?.severity).toBe("error");
    expect(f?.message).toContain("boom-from-test");
  });
});
