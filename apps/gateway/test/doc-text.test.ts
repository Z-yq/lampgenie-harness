import { describe, it, expect, afterAll } from "vitest";
import JSZip from "jszip";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import {
  parseDocFile, isDocExt, DOC_MAX_BYTES, DOC_PARSE_EXT,
} from "../src/doc-text.js";

const TMP = mkdtempSync(join(tmpdir(), "genie-doc-text-"));
afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } });

function writeSample(name: string, data: Buffer): string {
  const p = join(TMP, name);
  writeFileSync(p, data);
  return p;
}

/** 最小 docx:[Content_Types].xml + word/document.xml(正文 + 标题 + 表格)。 */
async function makeDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>季度总结</w:t></w:r></w:p>
<w:p><w:r><w:t>这是正文第一段,用来验证 docx 抽文本。</w:t></w:r></w:p>
<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>指标</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>数值</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>营收</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
<w:p><w:r><w:t>结尾一句。</w:t></w:r></w:p>
</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

/** 最小 pptx:presentation.xml + 一页含 <a:t>标题</a:t>。 */
async function makePptx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`);
  zip.file("ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<p:sldIdLst><p:sldId id="256" r:id="rId2" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></p:sldIdLst>
<p:sldSz cx="9144000" cy="6858000"/></p:presentation>`);
  zip.file("ppt/slides/slide1.xml", `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="标题"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="500000"/></a:xfrm></p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>季度汇报</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="正文"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="0" y="600000"/><a:ext cx="1000000" cy="500000"/></a:xfrm></p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>要点一</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

/** 最小 xlsx:workbook.xml(表名) + sharedStrings.xml + sheet1.xml。 */
async function makeXlsx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="销售数据" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file("xl/sharedStrings.xml", `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">
<si><t>区域</t></si><si><t>金额</t></si><si><t>华东</t></si></sst>`);
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1234.5</v></c><c r="C2" t="inlineStr"><is><t>备注文本</t></is></c></row>
</sheetData></worksheet>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

/** 最小 PDF:FlateDecode 内容流含 BT ... (Hello World) Tj ET。 */
function makePdf(withText = true): Buffer {
  const content = withText ? "BT /F1 12 Tf 72 720 Td (Hello World) Tj ET\n" : "";
  const data = deflateSync(Buffer.from(content, "latin1"));
  const head = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
    + "2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n"
    + "3 0 obj<</Type/Page/Parent 2 0 R/Contents 4 0 R>>endobj\n"
    + `4 0 obj<</Length ${data.length}/Filter/FlateDecode>>\nstream\n`;
  const tail = "\nendstream\nendobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";
  return Buffer.concat([Buffer.from(head, "latin1"), data, Buffer.from(tail, "latin1")]);
}

/** 指定内容流文本的最小 PDF(FlateDecode 包一层)。 */
function makePdfWithContent(content: string): Buffer {
  const data = deflateSync(Buffer.from(content, "latin1"));
  const head = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
    + "2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n"
    + "3 0 obj<</Type/Page/Parent 2 0 R/Contents 4 0 R>>endobj\n"
    + `4 0 obj<</Length ${data.length}/Filter/FlateDecode>>\nstream\n`;
  const tail = "\nendstream\nendobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";
  return Buffer.concat([Buffer.from(head, "latin1"), data, Buffer.from(tail, "latin1")]);
}

/** 最小 ASCII85 编码(给双层 Filter 用例造数据;约定以 `~>` 结尾)。 */
function ascii85Encode(data: Buffer): string {
  let out = "";
  let i = 0;
  const group5 = (v0: number): string => {
    let v = v0;
    const c: string[] = [];
    for (let k = 0; k < 5; k++) { c.push(String.fromCharCode((v % 85) + 33)); v = Math.floor(v / 85); }
    return c.reverse().join("");
  };
  for (; i + 4 <= data.length; i += 4) {
    const v = ((data[i] as number) * 16777216) + ((data[i + 1] as number) * 65536)
      + ((data[i + 2] as number) * 256) + (data[i + 3] as number);
    out += v === 0 ? "z" : group5(v);
  }
  const rest = data.length - i;
  if (rest > 0) {
    const pad = [0, 0, 0, 0];
    for (let k = 0; k < rest; k++) pad[k] = data[i + k] as number;
    const v = (pad[0] * 16777216) + (pad[1] * 65536) + (pad[2] * 256) + pad[3];
    out += group5(v).slice(0, rest + 1);
  }
  return out + "~>";
}

describe("doc-text: docx/pptx", () => {
  it("docx 输出含正文文字与标题前缀", async () => {
    const p = writeSample("a.docx", await makeDocx());
    const r = await parseDocFile(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("docx");
    expect(r.text).toContain("这是正文第一段");
    expect(r.text).toContain("# 季度总结");
    expect(r.text).toContain("指标 | 数值");
  });

  it("pptx 输出含第 1 页与该页文字", async () => {
    const p = writeSample("a.pptx", await makePptx());
    const r = await parseDocFile(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain("=== 第 1 页 ===");
    expect(r.text).toContain("季度汇报");
  });
});

describe("doc-text: xlsx/zip", () => {
  it("xlsx 输出含 sharedStrings 文字与数值格", async () => {
    const p = writeSample("a.xlsx", await makeXlsx());
    const r = await parseDocFile(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain("=== Sheet: 销售数据 ===");
    expect(r.text).toContain("华东");
    expect(r.text).toContain("1234.5");
    expect(r.text).toContain("备注文本");
  });

  it("zip 输出含条目路径并可提示 docx", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", "<x/>");
    zip.file("readme.txt", "hi");
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    const p = writeSample("a.zip", buf);
    const r = await parseDocFile(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("zip");
    expect(r.text).toContain("word/document.xml");
    expect(r.text).toContain("readme.txt");
    expect(r.text).toContain("这是 docx");
  });
});

describe("doc-text: pdf", () => {
  it("抽出 Hello World", async () => {
    const p = writeSample("a.pdf", makePdf(true));
    const r = await parseDocFile(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("pdf");
    expect(r.text).toContain("Hello World");
  });

  it("无文本层 → ok:false 且 reason 含「无文本层」", async () => {
    const p = writeSample("scan.pdf", makePdf(false));
    const r = await parseDocFile(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("无文本层");
    expect(r.kind).toBe("pdf");
  });

  it("纯扫描件(完全没有 stream)→ ok:false 且 reason 含「无文本层」", async () => {
    // 只有页面对象,一个内容流都没有(扫描件的典型形态)
    const raw = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
      + "2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n"
      + "3 0 obj<</Type/Page/Parent 2 0 R/Resources<<>>>>endobj\n"
      + "trailer<</Root 1 0 R>>\n%%EOF\n";
    const p = writeSample("scan-only.pdf", Buffer.from(raw, "latin1"));
    const r = await parseDocFile(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("无文本层");
  });

  it("可见字符 < 8 → ok:false 且 reason 含「过少」", async () => {
    // (Hi) 只有 2 个可见字符:不能算抽取成功
    const p = writeSample("tiny.pdf", makePdfWithContent("BT /F1 12 Tf 72 720 Td (Hi) Tj ET\n"));
    const r = await parseDocFile(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("过少");
    expect(r.kind).toBe("pdf");
  });

  it("十六进制串 <...> 按 UTF-16BE 抽出中文(无 ToUnicode 时并注明)", async () => {
    // 宋体中文排版测试 = 8 个可见字符,正好过下限
    const content = "BT /F0 22 Tf 60 760 Td <5B8B4F534E2D6587639272486D4B8BD5> Tj ET\n";
    const p = writeSample("hex.pdf", makePdfWithContent(content));
    const r = await parseDocFile(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain("宋体中文排版测试");
    expect(r.note).toContain("PDF 无 ToUnicode");
  });

  it("ASCII85+Flate 双层流也能解(paper.pdf 的压缩形态)", async () => {
    const plainBuf = deflateSync(Buffer.from("BT /F1 12 Tf 72 720 Td (Caching helps latency) Tj ET\n", "latin1"));
    const a85 = ascii85Encode(plainBuf);
    const head = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
      + "2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n"
      + "3 0 obj<</Type/Page/Parent 2 0 R/Contents 4 0 R>>endobj\n"
      + `4 0 obj<</Length ${a85.length}/Filter [ /ASCII85Decode /FlateDecode ]>>\nstream\n`;
    const tail = "\nendstream\nendobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";
    const buf = Buffer.concat([Buffer.from(head, "latin1"), Buffer.from(a85, "latin1"), Buffer.from(tail, "latin1")]);
    const p = writeSample("a85.pdf", buf);
    const r = await parseDocFile(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain("Caching helps latency");
  });
});

// ───────────────────────── 真实仓内样本(test/fixtures/office,自带生成器) ─────────────────────────
const FIXTURES = fileURLToPath(new URL("./fixtures/office/", import.meta.url));
const fixture = (name: string): string => join(FIXTURES, name);

describe("doc-text: 真实样本", () => {
  it("cjk-sample.pdf:十六进制正文按 ToUnicode 抽出中文,字体标注行也保留", async () => {
    const r = await parseDocFile(fixture("cjk-sample.pdf"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("pdf");
    expect(r.text).toContain("宋体");
    expect(r.text).toContain("横排简体样张");
    expect(r.text).toContain("楷体");
    // 字体标注行是页面上真实印出来的字,必须保留
    expect(r.text).toContain("STSong-Light");
    expect(r.text).toContain("KaiTi_GB2312");
    expect(r.note).toContain("已按 ToUnicode 解码");
  });

  it("paper-sample.pdf:压缩内容流 + CID 字体,不再误判无文本层", async () => {
    const r = await parseDocFile(fixture("paper-sample.pdf"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("pdf");
    expect(r.text).toContain("Serving Latency Notes");
    expect(r.text).toContain("latency");
    expect(r.text).toContain("中文摘要");
    expect(r.note).toContain("PDF 无 ToUnicode");
  });

  it("report-sample.docx:抽到标题、表格与结尾段落", async () => {
    const r = await parseDocFile(fixture("report-sample.docx"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("docx");
    expect(r.text).toContain("# 运营月度汇总");
    expect(r.text).toContain("华东 | 156");
    expect(r.text).toContain("环比继续改善");
    expect(r.text).toContain("口径说明");
  });

  it("budget-sample.xlsx:抽到表名、表头与两个 Sheet", async () => {
    const r = await parseDocFile(fixture("budget-sample.xlsx"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("xlsx");
    expect(r.text).toContain("=== Sheet: 营收 ===");
    expect(r.text).toContain("区域\tQ1");
    expect(r.text).toContain("=== Sheet: 假设 ===");
    expect(r.text).toContain("单位:万元");
  });

  it("launch-sample.pptx:抽到 3 页与页内文字/表格", async () => {
    const r = await parseDocFile(fixture("launch-sample.pptx"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("pptx");
    expect(r.text).toContain("=== 第 1 页 ===");
    expect(r.text).toContain("版本发布计划");
    expect(r.text).toContain("11 月:回顾");
    expect(r.text).toContain("物项 | 预算 | 负责人");
  });
});

describe("doc-text: 边界", () => {
  it("超 DOC_MAX_BYTES 走体积拒绝 / 常量值正确", async () => {
    expect(DOC_MAX_BYTES).toBe(64 * 1024 * 1024);
    // 造一个略大于上限的文件(内容全是 0,先被体积闸拦下,不会进解析)
    try {
      const big = Buffer.alloc(DOC_MAX_BYTES + 1);
      const p = writeSample("big.zip", big);
      const r = await parseDocFile(p);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("文件过大");
    } catch {
      // 磁盘/内存不足时只认常量断言
    }
  });

  it("未知扩展 → ok:false", async () => {
    const p = writeSample("a.bin", Buffer.from("x"));
    const r = await parseDocFile(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("不支持解析的类型");
  });

  it("不存在的文件 → ok:false 不抛", async () => {
    const r = await parseDocFile(join(TMP, "nope-zzz.docx"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("读取失败");
  });

  it("文本类按 utf-8 读并可截断", async () => {
    const p = writeSample("a.md", Buffer.from("# 标题\n正文内容", "utf8"));
    const r = await parseDocFile(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("text");
    expect(r.text).toContain("正文内容");
    const cut = await parseDocFile(p, { maxChars: 3 });
    expect(cut.ok && cut.text.length === 3).toBe(true);
    expect(cut.ok && cut.note === "已截断").toBe(true);
  });

  it("isDocExt 大小写与带点都认", () => {
    expect(isDocExt("DOCX")).toBe(true);
    expect(isDocExt(".docx")).toBe(true);
    expect(isDocExt("Md")).toBe(true);
    expect(isDocExt("pdf")).toBe(true);
    expect(isDocExt("exe")).toBe(false);
    expect(isDocExt("")).toBe(false);
    expect(DOC_PARSE_EXT.has("zip")).toBe(true);
  });
});

// ───────────────────────── 路径围栏 ─────────────────────────
describe("parseDocFile 路径围栏 roots", () => {
  it("根内文件 + roots=[根] → 正常解析", async () => {
    const p = writeSample("fence-inside.md", Buffer.from("围栏内正文", "utf8"));
    const r = await parseDocFile(p, { roots: [TMP] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("text");
    expect(r.text).toContain("围栏内正文");
  });

  it("越界路径 + roots=[根] → DOC_PATH_OUT_OF_ROOT 且不读文件", async () => {
    const outside = join(tmpdir(), "genie-doc-text-outside-fence.md");
    const r = await parseDocFile(outside, { roots: [TMP] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("DOC_PATH_OUT_OF_ROOT");
    expect(r.kind).toBe("md");
 // 围栏在读文件之前:即便文件不存在也不能落到「读取失败」
    expect(r.reason).not.toContain("读取失败");
  });

  it("不传 roots → 旧行为(越界路径也照旧解析)", async () => {
    const p = writeSample("fence-legacy.md", Buffer.from("旧行为正文", "utf8"));
    const r = await parseDocFile(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain("旧行为正文");
  });

  it("roots 为空数组 → 旧行为", async () => {
    const p = writeSample("fence-empty-roots.md", Buffer.from("空根正文", "utf8"));
    const r = await parseDocFile(p, { roots: [] });
    expect(r.ok).toBe(true);
  });

  it("双根命中任一 → 放行", async () => {
    const p = writeSample("fence-two-roots.md", Buffer.from("双根正文", "utf8"));
    const otherRoot = join(tmpdir(), "genie-doc-text-other-root");
    const r = await parseDocFile(p, { roots: [otherRoot, TMP] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain("双根正文");
  });
});