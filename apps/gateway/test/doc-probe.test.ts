/**
 * doc-probe 纯逻辑探测层单测(任务)。
 * 覆盖四类探测(PDF / OOXML zip / 协议 / 路径)、大小上限、外链计数、确定性与不 throw。
 */
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import {
  DOC_PROBE_CODES,
  probeDocument,
  sanitizeExternalTarget,
  isPathWithinRoot,
  probeVerdictToErrorCode,
} from "../src/doc-probe.js";

// ───────────────────────── 夹具 ─────────────────────────

/** 最小 PDF:可调页数/加密/缺头/缺尾。 */
function makePdf(
  opts: { pages?: number; encrypt?: boolean; header?: boolean; startxref?: boolean } = {},
): Uint8Array {
  const pages = opts.pages ?? 1;
  let body = "";
  if (opts.header !== false) body += "%PDF-1.7\n";
  body += `2 0 obj\n<< /Type /Pages /Kids [] /Count ${pages} >>\nendobj\n`;
  for (let i = 0; i < pages; i++) {
    body += `${i + 3} 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n`;
  }
  body += `trailer\n<< /Root 2 0 R${opts.encrypt ? " /Encrypt 9 0 R" : ""} >>\n`;
  if (opts.startxref !== false) body += "startxref\n0\n%%EOF\n";
  return new TextEncoder().encode(body);
}

const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";

function docxFiles(opts: { text?: string; rels?: string } = {}): Record<string, string> {
  const files: Record<string, string> = {
    "[Content_Types].xml":
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`,
    "word/document.xml":
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${opts.text ? `<w:p><w:r><w:t>${opts.text}</w:t></w:r></w:p>` : ""}</w:body></w:document>`,
  };
  if (opts.rels) files["word/_rels/document.xml.rels"] = opts.rels;
  return files;
}

function relsXml(targets: { target: string; mode?: string }[]): string {
  const body = targets
    .map(
      (t, i) =>
        `<Relationship Id="rId${i + 1}" Type="${REL_TYPE}" Target="${t.target}"${
          t.mode === "internal" ? "" : ' TargetMode="External"'
        }/>`,
    )
    .join("");
  return `<?xml version="1.0"?><Relationships xmlns="${RELS_NS}">${body}</Relationships>`;
}

async function zipBytes(
  files: Record<string, string>,
  compression: "DEFLATE" | "STORE" = "DEFLATE",
): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [k, v] of Object.entries(files)) zip.file(k, v);
  return await zip.generateAsync({ type: "uint8array", compression });
}

// ───────────────────────── 码表 ─────────────────────────

describe("doc-probe: 码表与错误码映射", () => {
  it("DOC_PROBE_CODES 六码且顺序固定", () => {
    expect(DOC_PROBE_CODES).toEqual(["OK", "ENCRYPTED", "CORRUPT", "ZIP_BOMB", "TOO_LARGE", "UNSUPPORTED"]);
  });

  it("每个可失败码都映射到专门错误码,OK 无错误码", () => {
    expect(probeVerdictToErrorCode("ENCRYPTED")).toBe("DOC_ENCRYPTED");
    expect(probeVerdictToErrorCode("CORRUPT")).toBe("DOC_CORRUPT");
    expect(probeVerdictToErrorCode("ZIP_BOMB")).toBe("DOC_ZIP_BOMB");
    expect(probeVerdictToErrorCode("TOO_LARGE")).toBe("DOC_TOO_LARGE");
    expect(probeVerdictToErrorCode("UNSUPPORTED")).toBe("DOC_UNSUPPORTED");
    expect(probeVerdictToErrorCode("OK")).toBeUndefined();
  });
});

// ───────────────────────── PDF ─────────────────────────

describe("doc-probe: pdf", () => {
  it("有效 PDF → OK,页数按 /Type /Page 计数", () => {
    const r = probeDocument(makePdf({ pages: 1 }), "pdf");
    expect(r.code).toBe("OK");
    expect(r.kind).toBe("pdf");
    expect(r.pages).toBe(1);
    expect(r.encrypted).toBeUndefined();
    expect(r.corrupt).toBeUndefined();
  });

  it("多页计数排除 /Type /Pages 页树", () => {
    const r = probeDocument(makePdf({ pages: 3 }), "pdf");
    expect(r.code).toBe("OK");
    expect(r.pages).toBe(3);
  });

  it("含 /Encrypt → ENCRYPTED(探针 A)", () => {
    const r = probeDocument(makePdf({ encrypt: true }), "pdf");
    expect(r.code).toBe("ENCRYPTED");
    expect(r.encrypted).toBe(true);
  });

  it("无 %PDF- 头 → CORRUPT(探针 B)", () => {
    const r = probeDocument(makePdf({ header: false }), "pdf");
    expect(r.code).toBe("CORRUPT");
    expect(r.corrupt).toBe(true);
    expect(r.warnings.join()).toContain("%PDF-");
  });

  it("缺 startxref → CORRUPT", () => {
    const r = probeDocument(makePdf({ startxref: false }), "pdf");
    expect(r.code).toBe("CORRUPT");
    expect(r.warnings.join()).toContain("startxref");
  });

  it("超过字节上限 → TOO_LARGE", () => {
    const r = probeDocument(makePdf(), "pdf", { maxBytes: 10 });
    expect(r.code).toBe("TOO_LARGE");
    expect(r.bytes).toBeGreaterThan(10);
  });
});

// ───────────────────────── OOXML ─────────────────────────

describe("doc-probe: ooxml", () => {
  it("docx zip → OK 且解压总量来自中央目录", async () => {
    const bytes = await zipBytes(docxFiles({ text: "hello" }));
    const r = probeDocument(bytes, "docx");
    expect(r.code).toBe("OK");
    expect(r.kind).toBe("docx");
    expect(r.zipUncompressedBytes).toBeGreaterThan(0);
  });

  it("pptx / xlsx kind 正确", async () => {
    const bytes = await zipBytes(docxFiles({ text: "hello" }));
    expect(probeDocument(bytes, "pptx").kind).toBe("pptx");
    expect(probeDocument(bytes, "xlsx").kind).toBe("xlsx");
  });

  it("不是 zip 头 → CORRUPT", () => {
    const r = probeDocument(new TextEncoder().encode("not a zip at all"), "docx");
    expect(r.code).toBe("CORRUPT");
    expect(r.corrupt).toBe(true);
  });

  it("解压总量超过上限 → ZIP_BOMB(探针 C)", async () => {
    const bytes = await zipBytes({ "word/document.xml": "x".repeat(5000) });
    const r = probeDocument(bytes, "docx", { maxUncompressed: 100 });
    expect(r.code).toBe("ZIP_BOMB");
    expect(r.zipUncompressedBytes).toBeGreaterThan(100);
    expect(r.warnings.join()).toContain("解压总量");
  });

  it("外链 http/https 放行、javascript: 拒绝(探针 D)", async () => {
    const bytes = await zipBytes(
      docxFiles({
        text: "hello world",
        rels: relsXml([
          { target: "https://example.com/a" },
          { target: "http://example.com/b" },
          { target: "javascript:alert(1)" },
        ]),
      }),
    );
    const r = probeDocument(bytes, "docx");
    expect(r.code).toBe("OK");
    const allowed = r.externalLinks.filter((l) => l.allowed).map((l) => l.target);
    const denied = r.externalLinks.filter((l) => !l.allowed).map((l) => l.target);
    expect(allowed).toEqual(["https://example.com/a", "http://example.com/b"]);
    expect(denied).toEqual(["javascript:alert(1)"]);
    expect(r.externalLinks.find((l) => l.target.startsWith("javascript:"))?.reason).toContain("危险协议");
    expect(r.warnings.join()).toContain("已丢弃 1 个不安全外链");
  });

  it("data/file/vbscript 一律拒绝", async () => {
    const bytes = await zipBytes(
      docxFiles({
        rels: relsXml([
          { target: "data:text/html;base64,AAAA" },
          { target: "file:///etc/passwd" },
          { target: "vbscript:msgbox(1)" },
        ]),
      }),
    );
    const r = probeDocument(bytes, "docx");
    expect(r.externalLinks).toHaveLength(3);
    expect(r.externalLinks.every((l) => !l.allowed)).toBe(true);
    expect(r.warnings.join()).toContain("已丢弃 3 个不安全外链");
  });

  it("内部 Target(非 External)不计入外链", async () => {
    const bytes = await zipBytes(
      docxFiles({
        rels: relsXml([{ target: "media/image1.png", mode: "internal" }]),
      }),
    );
    const r = probeDocument(bytes, "docx");
    expect(r.externalLinks).toHaveLength(0);
  });
});

// ───────────────────────── 协议白名单 ─────────────────────────

describe("doc-probe: sanitizeExternalTarget", () => {
  it("https 放行,大小写/前后空白不敏感", () => {
    expect(sanitizeExternalTarget("  HTTPS://Example.com/x  ")).toMatchObject({ allowed: true, protocol: "https" });
  });

  it("http 放行", () => {
    expect(sanitizeExternalTarget("http://a.b/c")).toMatchObject({ allowed: true, protocol: "http" });
  });

  it("javascript: 拒绝", () => {
    const v = sanitizeExternalTarget("javascript:alert(1)");
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("危险协议");
  });

  it("data: 拒绝", () => {
    expect(sanitizeExternalTarget("data:text/plain,hi").allowed).toBe(false);
  });

  it("file: 拒绝", () => {
    expect(sanitizeExternalTarget("file:///etc/passwd").allowed).toBe(false);
  });

  it("空目标拒绝", () => {
    expect(sanitizeExternalTarget("   ").allowed).toBe(false);
  });

  it("相对路径拒绝", () => {
    const v = sanitizeExternalTarget("../a/b.html");
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("相对路径");
  });

  it("http: 缺 // 拒绝", () => {
    expect(sanitizeExternalTarget("http:foo").allowed).toBe(false);
  });
});

// ───────────────────────── 路径归一 ─────────────────────────

describe("doc-probe: isPathWithinRoot", () => {
  it("子路径在根内", () => {
    expect(isPathWithinRoot("/root/a/b.txt", "/root")).toBe(true);
  });

  it("相同路径算在根内", () => {
    expect(isPathWithinRoot("/root", "/root")).toBe(true);
  });

  it("`..` 回退越界 → false(探针 F)", () => {
    expect(isPathWithinRoot("/root/../../etc/passwd", "/root")).toBe(false);
    expect(isPathWithinRoot("/root/a/../../../etc/passwd", "/root")).toBe(false);
  });

  it("前缀相近的兄弟目录不算在根内", () => {
    expect(isPathWithinRoot("/root2/a", "/root")).toBe(false);
  });

  it("分隔符统一(反斜杠也认)", () => {
    expect(isPathWithinRoot("/root\\a\\b", "/root")).toBe(true);
  });

  it("Windows 盘符路径大小写不敏感", () => {
    expect(isPathWithinRoot("C:\\Root\\A\\B.docx", "c:/root")).toBe(true);
    expect(isPathWithinRoot("D:\\Root\\A", "c:/root")).toBe(false);
  });

  it("`.` 段被归一", () => {
    expect(isPathWithinRoot("/root/./a/../b", "/root")).toBe(true);
  });
});

// ───────────────────────── 确定性与不 throw ─────────────────────────

describe("doc-probe: 确定性 / 不 throw", () => {
  it("同输入两次探测结果逐字一致", async () => {
    const bytes = await zipBytes(
      docxFiles({ text: "hello", rels: relsXml([{ target: "javascript:alert(1)" }]) }),
    );
    const a = probeDocument(bytes, "docx");
    const b = probeDocument(bytes, "docx");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("不支持的扩展名 → UNSUPPORTED", () => {
    const r = probeDocument(new TextEncoder().encode("hi"), "md");
    expect(r.code).toBe("UNSUPPORTED");
    expect(r.kind).toBe("other");
  });

  it("垃圾字节/空字节/非 Uint8Array 输入都不抛错", () => {
    expect(() => probeDocument(new Uint8Array([1, 2, 3]), "pdf")).not.toThrow();
    expect(probeDocument(new Uint8Array([1, 2, 3]), "pdf").code).toBe("CORRUPT");
    expect(probeDocument(new Uint8Array(0), "docx").code).toBe("CORRUPT");
    const weird = probeDocument(undefined as unknown as Uint8Array, "docx");
    expect(weird.code).toBe("CORRUPT");
  });
});
