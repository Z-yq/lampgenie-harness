/**
 * doc-probe 接线测试(任务):
 * - 源码接线断言:doc-text 解析前调用 probe、office-ooxml 导入协议白名单与统计导出;
 * - 真 doc-text 路径:专门错误码、扫描件标注、页数/丢弃外链 note;
 * - 真 office-ooxml 路径:外链统计 allowed/denied。
 */
import { describe, it, expect, afterAll } from "vitest";
import JSZip from "jszip";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { parseDocFile } from "../src/doc-text.js";
import { parseOffice, getExternalLinkStats } from "../src/office-ooxml.js";

const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "genie-doc-probe-wiring-"));
afterAll(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
 /* 忽略 */
  }
});

function writeSample(name: string, data: Buffer | Uint8Array): string {
  const p = join(TMP, name);
  writeFileSync(p, data);
  return p;
}

// ───────────────────────── 源码接线 ─────────────────────────

describe("wiring: 源码接线", () => {
  const docTextSrc = readFileSync(join(SRC_DIR, "doc-text.ts"), "utf8");
  const officeSrc = readFileSync(join(SRC_DIR, "office-ooxml.ts"), "utf8");
  const agentWiringSrc = readFileSync(join(SRC_DIR, "agent-wiring.ts"), "utf8");

  it("doc-text 从 ./doc-probe.js 导入 probeDocument", () => {
    expect(docTextSrc).toContain('from "./doc-probe.js"');
    expect(docTextSrc).toContain("probeDocument(");
    expect(docTextSrc).toContain("probeVerdictToErrorCode");
  });

  it("doc-text 在解析分支之前调用 probeDocument", () => {
    const probeAt = docTextSrc.indexOf("probeDocument(buf");
    const officeAt = docTextSrc.indexOf("flattenOffice(buf");
    const pdfAt = docTextSrc.indexOf("flattenPdf(buf)");
    expect(probeAt).toBeGreaterThan(0);
    expect(probeAt).toBeLessThan(officeAt);
    expect(probeAt).toBeLessThan(pdfAt);
  });

  it("doc-text ok 分支声明 scanSuspected 并在 0/少量字符时标注", () => {
    expect(docTextSrc).toContain("scanSuspected");
    expect(docTextSrc).toContain("疑似扫描件/无文本层");
    expect(docTextSrc).toContain("DOC_TOO_LARGE");
  });

  it("parseDocFile 接入路径围栏,agent-wiring 传 repoRoot+taskRoot 双根", () => {
 // 围栏实现:doc-text 导入了 isPathWithinRoot 且签名带 roots
    expect(docTextSrc).toContain("isPathWithinRoot");
    expect(docTextSrc).toContain("roots?: string[]");
    expect(docTextSrc).toContain("DOC_PATH_OUT_OF_ROOT");
 // 围栏在读文件之前(不命中就不落 readFile)
    const fenceAt = docTextSrc.indexOf("DOC_PATH_OUT_OF_ROOT");
    const readAt = docTextSrc.indexOf("readFile(path)");
    expect(fenceAt).toBeGreaterThan(0);
    expect(readAt).toBeGreaterThan(0);
    expect(fenceAt).toBeLessThan(readAt);
 // 生产消费方:read_attachment 的解析调用必须传双根
    expect(agentWiringSrc).toContain("roots: [...new Set([repoRoot(), taskRoot]");
  });

  it("office-ooxml 导入 sanitizeExternalTarget 并导出外链统计", () => {
    expect(officeSrc).toContain('from "./doc-probe.js"');
    expect(officeSrc).toContain("sanitizeExternalTarget");
    expect(officeSrc).toContain("export function getExternalLinkStats");
    expect(officeSrc).toContain("export function resetExternalLinkStats");
  });
});

// ───────────────────────── 真 doc-text 路径 ─────────────────────────

const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";

function makeDocx(opts: { text?: string; rels?: string } = {}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${
      opts.text ? `<w:p><w:r><w:t>${opts.text}</w:t></w:r></w:p>` : ""
    }</w:body></w:document>`,
  );
  if (opts.rels) zip.file("word/_rels/document.xml.rels", opts.rels);
  return zip.generateAsync({ type: "nodebuffer" });
}

function relsXml(targets: string[]): string {
  const body = targets
    .map((t, i) => `<Relationship Id="rId${i + 1}" Type="${REL_TYPE}" Target="${t}" TargetMode="External"/>`)
    .join("");
  return `<?xml version="1.0"?><Relationships xmlns="${RELS_NS}">${body}</Relationships>`;
}

/** 真正能抽出文本的 PDF(FlateDecode 内容流);可追加一个空页对象改变页数。 */
function makePdf(opts: { extraPages?: number; encrypt?: boolean; header?: boolean } = {}): Buffer {
  const content = "BT /F1 12 Tf 72 720 Td (Hello World) Tj ET\n";
  const data = deflateSync(Buffer.from(content, "latin1"));
  let head =
    (opts.header === false ? "" : "%PDF-1.4\n") +
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/Contents 4 0 R>>endobj\n";
  for (let i = 0; i < (opts.extraPages ?? 0); i++) {
    head += `${5 + i} 0 obj<</Type/Page/Parent 2 0 R>>endobj\n`;
  }
  head += `4 0 obj<</Length ${data.length}/Filter/FlateDecode>>\nstream\n`;
  const tail = `\nendstream\nendobj\ntrailer<</Root 1 0 R${opts.encrypt ? " /Encrypt 9 0 R" : ""}>>\nstartxref\n0\n%%EOF\n`;
  return Buffer.concat([Buffer.from(head, "latin1"), data, Buffer.from(tail, "latin1")]);
}

describe("wiring: 真 doc-text 路径", () => {
  it("加密 PDF → ok:false 且 reason 带 DOC_ENCRYPTED", async () => {
    const p = writeSample("enc.pdf", makePdf({ encrypt: true }));
    const r = await parseDocFile(p);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("DOC_ENCRYPTED");
  });

  it("损坏 PDF(无 %PDF 头)→ DOC_CORRUPT", async () => {
    const p = writeSample("bad.pdf", makePdf({ header: false }));
    const r = await parseDocFile(p);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("DOC_CORRUPT");
  });

  it("非 zip 的 docx → DOC_CORRUPT", async () => {
    const p = writeSample("fake.docx", Buffer.from("this is not a zip"));
    const r = await parseDocFile(p);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("DOC_CORRUPT");
  });

  it("0 字符 docx → ok:true 但 scanSuspected 且 note 提示转图(探针 E)", async () => {
    const p = writeSample("scan.docx", await makeDocx());
    const r = await parseDocFile(p);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toBe("");
      expect(r.scanSuspected).toBe(true);
      expect(r.note || "").toContain("疑似扫描件");
      expect(r.note || "").toContain("view_image");
    }
  });

  it("docx 含 javascript: 外链 → note 报告已丢弃", async () => {
    const p = writeSample(
      "link.docx",
      await makeDocx({ text: "hello world", rels: relsXml(["javascript:alert(1)"]) }),
    );
    const r = await parseDocFile(p);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.note || "").toContain("已丢弃 1 个不安全外链");
      expect(r.scanSuspected).toBeUndefined();
    }
  });

  it("多页 PDF → note 回填页数与字符密度", async () => {
    const p = writeSample("pages.pdf", makePdf({ extraPages: 1 }));
    const r = await parseDocFile(p);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.note || "").toContain("共 2 页");
  });
});

// ───────────────────────── 真 office-ooxml 路径 ─────────────────────────

function makePptxWithExternalLinks(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`,
  );
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
  );
  zip.file(
    "ppt/slides/slide1.xml",
    `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sld>`,
  );
  zip.file(
    "ppt/slides/_rels/slide1.xml.rels",
    relsXml(["https://example.com/a", "javascript:alert(1)"]),
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("wiring: office-ooxml 外链统计", () => {
  it("parseOffice 后统计 http/https=allowed、危险协议=denied", async () => {
    const buf = await makePptxWithExternalLinks();
    const ast = await parseOffice(buf, ".pptx");
    expect(ast.kind).toBe("pptx");
    const stats = getExternalLinkStats();
    expect(stats.allowed).toBe(1);
    expect(stats.denied).toBe(1);
    expect(stats.deniedTargets).toContain("javascript:alert(1)");
  });
});
