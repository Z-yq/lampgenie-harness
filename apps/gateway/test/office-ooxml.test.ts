import { describe, it, expect, afterAll } from "vitest";
import JSZip from "jszip";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOffice, readOfficePart, OFFICE_MAX_BYTES } from "../src/office-ooxml.js";
import { servePanel } from "../src/panel.js";

/** Office(PPTX/DOCX)只读预览服务端半边(板 ide-o1):
 *  - 解析:jszip 现场造最小 OOXML fixture(不依赖仓内二进制),断言 AST 契约(slides/blocks/runs/表格);
 *  - 路由:临时项目根 + 真面板实例,断言 /ide/office 与 /ide/office/media 的沙箱/白名单/错误码;
 *  - 负例:非 zip 字节 → 「不是有效的 OOXML 文件」;.exe → 403「仅 .pptx/.docx」;part 穿越 → 400。
 */
const PNG_1x1 = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8fff030000601020081b7b4b10000000049454e44ae426082", "hex");

const SLIDE_W = 12192000, SLIDE_H = 6858000;

const PPTX_SLIDE = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>' +
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
  // 文本形状:字号 1800(18pt)+ 粗体 + 颜色 + 居中
  '<p:sp><p:nvSpPr><p:cNvPr id="2" name="标题"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
  '<p:spPr><a:xfrm><a:off x="1270000" y="635000"/><a:ext cx="8890000" cy="1270000"/></a:xfrm></p:spPr>' +
  '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="1800" b="1" lang="zh-CN">' +
  '<a:solidFill><a:srgbClr val="C00000"/></a:solidFill></a:rPr><a:t>季度汇报 &amp; 演示</a:t></a:r></a:p>' +
  '</p:txBody></p:sp>' +
  // 图片:r:embed → rels → ppt/media/image1.png
  '<p:pic><p:nvPicPr><p:cNvPr id="3" name="图片 1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
  '<p:blipFill><a:blip r:embed="rId2"/></p:blipFill>' +
  '<p:spPr><a:xfrm><a:off x="2540000" y="1905000"/><a:ext cx="914400" cy="914400"/></a:xfrm></p:spPr></p:pic>' +
  // 组合形状:V1 不展开 → unsupported/group
  '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="4" name="组"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="3000" cy="4000"/></a:xfrm></p:grpSpPr></p:grpSp>' +
  // 图表:graphicFrame + chart → unsupported/chart
  '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="图表 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
  '<p:xfrm><a:off x="500" y="600"/><a:ext cx="7000" cy="8000"/></p:xfrm>' +
  '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
  '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId9"/></a:graphicData></a:graphic></p:graphicFrame>' +
  '</p:spTree></p:cSld></p:sld>';

const PPTX_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/>' +
  '</Relationships>';

const DOCX_BODY = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
  '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>章节标题</w:t></w:r></w:p>' +
  '<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/></w:numPr><w:jc w:val="center"/></w:pPr>' +
  '<w:r><w:rPr><w:b/><w:sz w:val="28"/><w:color w:val="1F6FEB"/></w:rPr><w:t>加粗要点</w:t></w:r>' +
  '<w:r><w:t xml:space="preserve"> 普通尾巴</w:t></w:r></w:p>' +
  '<w:tbl><w:tblPr/>' +
  '<w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr>' +
  '<w:tr><w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc></w:tr>' +
  '</w:tbl>' +
  // 修订:删除的文字不产出,插入的保留
  '<w:p><w:del><w:r><w:delText>已删除</w:delText></w:r></w:del><w:ins><w:r><w:t>新增段落</w:t></w:r></w:ins></w:p>' +
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>' +
  '</w:body></w:document>';

async function buildPptx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file("ppt/presentation.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:sldIdLst><p:sldId id="256" r:id="rId2" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></p:sldIdLst>' +
    '<p:sldSz cx="' + SLIDE_W + '" cy="' + SLIDE_H + '"/></p:presentation>');
  zip.file("ppt/slides/slide1.xml", PPTX_SLIDE);
  zip.file("ppt/slides/_rels/slide1.xml.rels", PPTX_RELS);
  zip.file("ppt/media/image1.png", PNG_1x1);
  return await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function buildDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file("word/document.xml", DOCX_BODY);
  zip.file("word/media/image1.png", PNG_1x1);
  return await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

describe("parseOffice:PPTX(最小 fixture:1 页 + 文本框 + 1x1 png)", () => {
  it("slides/页面尺寸/文本框 runs/图片 src/不支持项", async () => {
    const ast = await parseOffice(await buildPptx(), ".pptx", { docPath: "deck/示例.pptx", pid: "vitest-office" });
    expect(ast.kind).toBe("pptx");
    if (ast.kind !== "pptx") return;
    expect(ast.slides.length).toBe(1);
    const s = ast.slides[0];
    expect(s).toBeTruthy();
    if (!s) return;
    expect(s.index).toBe(1);
    expect(s.widthEmu).toBe(SLIDE_W);
    expect(s.heightEmu).toBe(SLIDE_H);

    const txt = s.shapes.find((x) => x.type === "text");
    expect(txt).toBeTruthy();
    if (!txt) return;
    expect(txt.text).toBe("季度汇报 & 演示");           // &amp; 实体解码
    expect(txt.x).toBe(1270000);
    expect(txt.cy).toBe(1270000);
    expect(txt.align).toBe("c");
    expect(txt.runs && txt.runs[0] && txt.runs[0].sizePt).toBe(18); // 1800 百分之一磅 → 18pt
    expect(txt.runs && txt.runs[0] && txt.runs[0].bold).toBe(true);
    expect(txt.runs && txt.runs[0] && txt.runs[0].color).toBe("#C00000");

    const img = s.shapes.find((x) => x.type === "image");
    expect(img).toBeTruthy();
    if (!img) return;
    expect(img.src).toContain("/ide/office/media?");
    expect(img.src).toContain("part=ppt/media/image1.png");
    expect(img.src).toContain("path=" + encodeURIComponent("deck/示例.pptx"));
    expect(img.src).toContain("pid=vitest-office");
    expect(img.cx).toBe(914400);

    // AST v2:空组合不再产出 unsupported/group(展平后没有子形状 = 没有形状)
    expect(s.shapes.some((x) => x.unsupportedKind === "group")).toBe(false);
    // 图表部件 rId9 在 rels 里不存在 → 仍按 unsupported/chart 降级(不崩、不假装有数据)
    const chart = s.shapes.find((x) => x.unsupportedKind === "chart");
    expect(chart && chart.type).toBe("unsupported");
  });

  it("缺字段不抛错:只有 spTree 的空页也能出 slide", async () => {
    const zip = new JSZip();
    zip.file("ppt/presentation.xml", "<p:presentation/>");
    zip.file("ppt/slides/slide2.xml", "<p:sld><p:cSld><p:spTree/></p:cSld></p:sld>");
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    const ast = await parseOffice(buf, ".pptx");
    expect(ast.kind).toBe("pptx");
    if (ast.kind !== "pptx") return;
    expect(ast.slides.length).toBe(1);
    expect(ast.slides[0] && ast.slides[0].shapes.length).toBe(0);
    expect(ast.slides[0] && ast.slides[0].widthEmu > 0).toBe(true); // 缺 sldSz 走默认
  });
});

describe("parseOffice:DOCX(Heading1 + 粗体 run + 2x2 表格)", () => {
  it("blocks 样式/runs/表格/修订跳过", async () => {
    const ast = await parseOffice(await buildDocx(), ".docx");
    expect(ast.kind).toBe("docx");
    if (ast.kind !== "docx") return;
    expect(ast.blocks.length).toBe(4);
    expect(ast.blocks[0] && ast.blocks[0].style).toBe("Heading1");
    const b1 = ast.blocks[1];
    expect(b1 && b1.align).toBe("center");
    expect(b1 && b1.listLevel).toBe(1);
    const boldRun = (b1 && b1.runs ? b1.runs : []).find((r) => r.bold);
    expect(boldRun && boldRun.sizePt).toBe(14); // w:sz 28 半磅 → 14pt
    expect(boldRun && boldRun.color).toBe("#1F6FEB");
    const tbl = ast.blocks[2];
    expect(tbl && tbl.type).toBe("table");
    expect(tbl && tbl.rows ? tbl.rows.length : 0).toBe(2);
    expect(tbl && tbl.rows ? tbl.rows[0] : []).toEqual(["A1", "B1"]);
    expect(tbl && tbl.rows ? tbl.rows[1] : []).toEqual(["A2", "B2"]);
    const rev = ast.blocks[3];
    const revText = (rev && rev.runs ? rev.runs : []).map((r) => r.text).join("");
    expect(revText).toBe("已删除新增段落"); // AST v2:w:del 的原文不再被丢弃
    expect((rev && rev.runs ? rev.runs : []).map((r) => r.revised)).toEqual(["del", "ins"]);
  });
});

describe("parseOffice:负例与守卫", () => {
  it("非 zip 字节 → 抛「不是有效的 OOXML 文件」", async () => {
    await expect(parseOffice(Buffer.from("this is not a zip at all"), ".pptx")).rejects.toThrow("不是有效的 OOXML 文件");
    await expect(parseOffice(Buffer.from("MZ......"), ".docx")).rejects.toThrow("不是有效的 OOXML 文件");
  });

  it("扩展名不是 .pptx/.docx → 抛含「仅 .pptx/.docx」(路由层另有 403,此处锁函数口径)", async () => {
    await expect(parseOffice(Buffer.from("MZ"), ".exe" as unknown as ".pptx")).rejects.toThrow("仅 .pptx/.docx");
  });

  it(">128MB 直接拒(防内存炸弹,文案带新上限)", async () => {
    expect(OFFICE_MAX_BYTES).toBe(128 * 1024 * 1024); // AST v2:64MB → 128MB
    const big = Buffer.alloc(OFFICE_MAX_BYTES + 1, 0);
    await expect(parseOffice(big, ".pptx")).rejects.toThrow("128");
  });

  it("readOfficePart:白名单前缀 + 包内不存在", async () => {
    const buf = await buildPptx();
    const got = await readOfficePart(buf, "ppt/media/image1.png");
    expect(got && Buffer.compare(got, PNG_1x1)).toBe(0);
    expect(await readOfficePart(buf, "ppt/../secret.txt")).toBe(null);
    expect(await readOfficePart(buf, "docProps/thumb.png")).toBe(null); // 前缀白名单
    expect(await readOfficePart(buf, "ppt/media/none.png")).toBe(null);
  });
});

// ═════════════════ AST v2:主题/表格/渐变阴影描边/组合/图表/SmartArt/Word 修订批注 ═════════════════
const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const PPTX_LEN = "<p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>" +
  "<p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>";

/** 造 1 页 pptx:slideBody 塞进 spTree;extra 追加任意部件(主题/母版/图表部件…)。 */
async function buildPptx2(slideBody: string, extra: Record<string, string> = {}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file("ppt/presentation.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:sldSz cx="' + SLIDE_W + '" cy="' + SLIDE_H + '"/></p:presentation>');
  zip.file("ppt/slides/slide1.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sld ' + A_NS + '><p:cSld><p:spTree>' + PPTX_LEN + slideBody + '</p:spTree></p:cSld></p:sld>');
  for (const n of Object.keys(extra)) zip.file(n, extra[n] as string);
  return await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
const THEME1 = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="T"><a:themeElements>' +
  '<a:clrScheme name="C">' +
  '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>' +
  '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>' +
  '</a:clrScheme></a:themeElements></a:theme>';
const slideRels = (body: string) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + body + '</Relationships>';
const rel = (id: string, type: string, target: string) =>
  '<Relationship Id="' + id + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/' + type + '" Target="' + target + '"/>';
const sp = (inner: string, ph = "") => '<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/>' +
  (ph ? '<p:nvPr><p:ph' + ph + '/></p:nvPr>' : '<p:nvPr/>') + '</p:nvSpPr>' + inner + '</p:sp>';

describe("AST v2:主题色/母版继承", () => {
  it("schemeClr accent1 + lumMod 60000/lumOff 20000 → 确定颜色;占位符字号从版式继承", async () => {
    const body = sp('<p:spPr><a:xfrm><a:off x="10" y="20"/><a:ext cx="30" cy="40"/></a:xfrm></p:spPr>' +
      '<p:txBody><a:bodyPr/><a:p><a:r><a:rPr><a:solidFill><a:schemeClr val="accent1">' +
      '<a:lumMod val="60000"/><a:lumOff val="20000"/></a:schemeClr></a:solidFill></a:rPr><a:t>继承</a:t></a:r></a:p></p:txBody>', ' type="body"');
    const layout = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>' +
      '<p:sp><p:nvSpPr><p:cNvPr id="9" name="ph"/><p:cNvSpPr/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>' +
      '<p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="3600"/><a:t>layout</a:t></a:r></a:p></p:txBody></p:sp>' +
      '</p:spTree></p:cSld></p:sldLayout>';
    const buf = await buildPptx2(body, {
      "ppt/theme/theme1.xml": THEME1,
      "ppt/slideLayouts/slideLayout1.xml": layout,
      "ppt/slides/_rels/slide1.xml.rels": slideRels(rel("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml")),
    });
    const ast = await parseOffice(buf, ".pptx");
    if (ast.kind !== "pptx") throw new Error("kind");
    const s = ast.slides[0]?.shapes[0];
    // #4472C4 → HSL 亮度 0.5176*0.6+0.2 → #4170C3(独立算法核对过)
    expect(s?.runs?.[0]?.color).toBe("#4170C3");
    expect(s?.runs?.[0]?.sizePt).toBe(36);           // 3600 百分之一磅 → 36pt(版式占位符继承)
    expect(JSON.stringify(ast)).not.toContain("NaN");
  });

  it("negative:删掉 theme1.xml → 不崩、schemeClr 回退为无 color、无 NaN/#undefined", async () => {
    const body = sp('<p:spPr><a:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></a:xfrm>' +
      '<a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr>' +
      '<p:txBody><a:bodyPr/><a:p><a:r><a:rPr><a:solidFill><a:schemeClr val="accent2"/></a:solidFill></a:rPr>' +
      '<a:t>无主题</a:t></a:r></a:p></p:txBody>');
    const ast = await parseOffice(await buildPptx2(body), ".pptx"); // 包内没有 theme1.xml
    if (ast.kind !== "pptx") throw new Error("kind");
    expect(ast.slides.length).toBe(1);
    const s = ast.slides[0]?.shapes[0];
    expect(s?.runs?.[0]?.color).toBeUndefined();
    expect(s?.fill).toBeUndefined();
    expect(JSON.stringify(ast)).not.toContain("NaN");
    expect(JSON.stringify(ast)).not.toContain("#undefined");
  });

  it("母版背景色 → 无显式 fill 的形状继承底色;有显式 fill 的不被覆盖", async () => {
    const master = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld>' +
      '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFF2CC"/></a:solidFill></p:bgPr></p:bg><p:spTree/>' +
      '</p:cSld></p:sldMaster>';
    const body = sp('<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></a:xfrm></p:spPr>') +
      sp('<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></a:xfrm>' +
        '<a:solidFill><a:srgbClr val="123456"/></a:solidFill></p:spPr>');
    const ast = await parseOffice(await buildPptx2(body, {
      "ppt/theme/theme1.xml": THEME1,
      "ppt/slideMasters/slideMaster1.xml": master,
    }), ".pptx");
    if (ast.kind !== "pptx") throw new Error("kind");
    expect(ast.slides[0]?.shapes[0]?.fill).toBe("#FFF2CC"); // 母版底色兜底
    expect(ast.slides[0]?.shapes[1]?.fill).toBe("#123456"); // 显式 fill 优先
  });
});

describe("AST v2:PPT 表格结构化", () => {
  it("3×2 表格 → type:table、rows/cells/colWidthsEmu", async () => {
    const tr = (a: string, b: string) => '<a:tr><a:tc><a:txBody><a:p><a:r><a:t>' + a + '</a:t></a:r></a:p></a:txBody></a:tc>' +
      '<a:tc><a:txBody><a:p><a:r><a:t>' + b + '</a:t></a:r></a:p></a:txBody></a:tc></a:tr>';
    const body = '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="表"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
      '<p:xfrm><a:off x="100" y="200"/><a:ext cx="3000" cy="4000"/></p:xfrm>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
      '<a:tbl><a:tblGrid><a:gridCol w="1000"/><a:gridCol w="2000"/></a:tblGrid>' +
      tr("A1", "B1") + tr("A2", "B2") + tr("A3", "B3") + '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
    const ast = await parseOffice(await buildPptx2(body), ".pptx");
    if (ast.kind !== "pptx") throw new Error("kind");
    const s = ast.slides[0]?.shapes[0];
    expect(s?.type).toBe("table");
    expect(s?.table?.rows.length).toBe(3);
    expect(s?.table?.rows[0]?.cells.length).toBe(2);
    expect(s?.table?.rows[2]?.cells.map((c) => c.text)).toEqual(["A3", "B3"]);
    expect(s?.table?.colWidthsEmu).toEqual([1000, 2000]);
    expect(s?.x).toBe(100);                            // graphicFrame 几何(V1 误取成 0)
  });

  it("negative:有 a:tbl 但 0 个 a:tr → 不抛错,rows 为 []", async () => {
    const body = '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="空表"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
      '<p:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></p:xfrm>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
      '<a:tbl><a:tblGrid/></a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
    const ast = await parseOffice(await buildPptx2(body), ".pptx");
    if (ast.kind !== "pptx") throw new Error("kind");
    const s = ast.slides[0]?.shapes[0];
    expect(s?.type).toBe("table");
    expect(Array.isArray(s?.table?.rows)).toBe(true);
    expect(s?.table?.rows).toEqual([]);
  });
});

describe("AST v2:渐变/阴影/描边", () => {
  it("双 stop gradFill + outerShdw + ln → gradient/shadow/stroke 全出且数值正确", async () => {
    const body = sp('<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm>' +
      '<a:gradFill><a:gsLst><a:gs pos="100000"><a:srgbClr val="FF0000"/></a:gs>' +
      '<a:gs pos="0"><a:srgbClr val="00FF00"/></a:gs></a:gsLst><a:lin ang="5400000"/></a:gradFill>' +
      '<a:effectLst><a:outerShdw blurRad="63500" dist="254000" dir="2700000"><a:srgbClr val="000000"/></a:outerShdw></a:effectLst>' +
      '<a:ln w="12700"><a:solidFill><a:srgbClr val="112233"/></a:solidFill></a:ln></p:spPr>');
    const ast = await parseOffice(await buildPptx2(body), ".pptx");
    if (ast.kind !== "pptx") throw new Error("kind");
    const s = ast.slides[0]?.shapes[0];
    const fill = s?.fill;
    expect(typeof fill === "object" && !!fill && "gradient" in fill).toBe(true);
    if (typeof fill !== "object" || !fill || !("gradient" in fill)) return;
    expect(fill.gradient.stops.length).toBe(2);
    expect(fill.gradient.stops.map((x) => x.pos)).toEqual([0, 1]);   // 按 pos 升序
    expect(fill.gradient.stops[0]?.color).toBe("#00FF00");
    expect(fill.gradient.angle).toBe(180);                           // ang 5400000 → 90° +90(CSS 约定)
    expect(s?.shadow).toEqual({ color: "#000000", blurEmu: 63500, dxEmu: 179605, dyEmu: 179605 }); // dir=2700000 → 45°:254000*cos/sin(45°)=179605
    expect(s?.stroke).toEqual({ widthEmu: 12700, color: "#112233" });
  });

  it("negative:无 a:ln / 无 effectLst 的普通矩形 → 不含 shadow/stroke 字段,fill 仍是纯色字符串", async () => {
    const body = sp('<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm>' +
      '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:spPr>');
    const ast = await parseOffice(await buildPptx2(body), ".pptx");
    if (ast.kind !== "pptx") throw new Error("kind");
    const s = ast.slides[0]?.shapes[0];
    expect(s?.fill).toBe("#FF0000");
    expect(s && "shadow" in s).toBe(false);
    expect(s && "stroke" in s).toBe(false);
  });
});

describe("AST v2:组合形状展开", () => {
  it("2 子形状的 grpSp → 展平为绝对坐标(父 off + 子相对×缩放),不再有 unsupportedKind:'group'", async () => {
    const body = '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="4" name="组"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
      '<p:grpSpPr><a:xfrm><a:off x="1000" y="2000"/><a:ext cx="2000" cy="2000"/>' +
      '<a:chOff x="0" y="0"/><a:chExt cx="1000" cy="1000"/></a:xfrm></p:grpSpPr>' +
      sp('<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm>' +
        '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:spPr>') +
      sp('<p:spPr><a:xfrm><a:off x="500" y="500"/><a:ext cx="100" cy="100"/></a:xfrm>' +
        '<a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></p:spPr>') + '</p:grpSp>';
    const ast = await parseOffice(await buildPptx2(body), ".pptx");
    if (ast.kind !== "pptx") throw new Error("kind");
    const shapes = ast.slides[0]?.shapes ?? [];
    expect(shapes.length).toBe(2);
    expect(shapes.some((x) => x.unsupportedKind === "group")).toBe(false);
    expect(shapes.map((x) => [x.x, x.y, x.cx, x.cy])).toEqual([[1000, 2000, 200, 200], [2000, 3000, 200, 200]]);
  });

  it("negative:缺 chExt 的组合 → 坐标全为有限数(不出 NaN/Infinity)", async () => {
    const body = '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="4" name="组"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
      '<p:grpSpPr><a:xfrm><a:off x="5" y="6"/><a:ext cx="7" cy="8"/></a:xfrm></p:grpSpPr>' +
      sp('<p:spPr><a:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></a:xfrm></p:spPr>') + '</p:grpSp>';
    const ast = await parseOffice(await buildPptx2(body), ".pptx");
    if (ast.kind !== "pptx") throw new Error("kind");
    const s = ast.slides[0]?.shapes[0];
    expect(s).toBeTruthy();
    for (const v of [s?.x, s?.y, s?.cx, s?.cy]) expect(Number.isFinite(v)).toBe(true);
    expect(JSON.stringify(ast)).not.toContain("NaN");
  });
});

describe("AST v2:图表数据", () => {
  const chartXml = (sers: string) => '<?xml version="1.0" encoding="UTF-8"?>' +
    '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea>' +
    '<c:barChart><c:barDir val="col"/>' + sers + '</c:barChart></c:plotArea></c:chart></c:chartSpace>';
  const ser = (name: string) => '<c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>' + name + '</c:v></c:pt></c:strCache></c:strRef></c:tx>' +
    '<c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat>' +
    '<c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser>';
  const frame = '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="图"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
    '<p:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></p:xfrm>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
    '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId9"/></a:graphicData></a:graphic></p:graphicFrame>';

  it("柱状图 → type:chart、kind:'bar'、series[0].vals 与 XML 逐项相等", async () => {
    const buf = await buildPptx2(frame, {
      "ppt/charts/chart1.xml": chartXml(ser("销量")),
      "ppt/slides/_rels/slide1.xml.rels": slideRels(rel("rId9", "chart", "../charts/chart1.xml")),
    });
    const ast = await parseOffice(buf, ".pptx");
    if (ast.kind !== "pptx") throw new Error("kind");
    const s = ast.slides[0]?.shapes[0];
    expect(s?.type).toBe("chart");
    expect(s?.chart?.kind).toBe("bar");
    expect(s?.chart?.series[0]?.name).toBe("销量");
    expect(s?.chart?.series[0]?.cats).toEqual(["Q1", "Q2"]);
    expect(s?.chart?.series[0]?.vals).toEqual([10, 20]);
  });

  it("negative:c:ser 为空 → series:[](不抛错、不给 undefined)", async () => {
    const buf = await buildPptx2(frame, {
      "ppt/charts/chart1.xml": chartXml(""),
      "ppt/slides/_rels/slide1.xml.rels": slideRels(rel("rId9", "chart", "../charts/chart1.xml")),
    });
    const ast = await parseOffice(buf, ".pptx");
    if (ast.kind !== "pptx") throw new Error("kind");
    const s = ast.slides[0]?.shapes[0];
    expect(s?.chart?.kind).toBe("bar");
    expect(s?.chart?.series).toEqual([]);
  });
});

describe("AST v2:SmartArt 树", () => {
  const frame = '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="6" name="图"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
    '<p:xfrm><a:off x="10" y="20"/><a:ext cx="30" cy="40"/></p:xfrm>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram">' +
    '<dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" ' +
    'r:dm="rId10" r:lo="rId11" r:qs="rId12" r:cs="rId13"/></a:graphicData></a:graphic></p:graphicFrame>';
  const data = (pts: string, cxns: string) => '<?xml version="1.0" encoding="UTF-8"?>' +
    '<dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dgm:ptLst>' + pts + '</dgm:ptLst>' +
    '<dgm:cxnLst>' + cxns + '</dgm:cxnLst></dgm:dataModel>';
  const pt = (id: string, text: string) => '<dgm:pt modelId="' + id + '"><dgm:t><a:p><a:r><a:t>' + text + '</a:t></a:r></a:p></dgm:t></dgm:pt>';
  const cxn = (src: string, dst: string) => '<dgm:cxn type="parOf" srcId="' + src + '" destId="' + dst + '"/>';

  it("3 节点 → diagram.nodes.length===3 且 parentId 指向父 modelId", async () => {
    const buf = await buildPptx2(frame, {
      "ppt/diagrams/data1.xml": data(pt("n1", "根") + pt("n2", "子A") + pt("n3", "子B"), cxn("n1", "n2") + cxn("n1", "n3")),
      "ppt/slides/_rels/slide1.xml.rels": slideRels(rel("rId10", "diagramData", "../diagrams/data1.xml")),
    });
    const ast = await parseOffice(buf, ".pptx");
    if (ast.kind !== "pptx") throw new Error("kind");
    const s = ast.slides[0]?.shapes[0];
    expect(s?.type).toBe("shape");                    // 契约:SmartArt 仍是 shape(不新增 type)
    expect(s?.diagram?.nodes.length).toBe(3);
    const nodes = s?.diagram?.nodes ?? [];
    const byId = new Map<string, (typeof nodes)[number]>(nodes.map((n) => [n.id, n] as [string, (typeof nodes)[number]]));
    expect(byId.get("n1")?.text).toBe("根");
    expect(byId.get("n1")?.parentId).toBeUndefined();
    expect(byId.get("n2")?.parentId).toBe("n1");
    expect(byId.get("n3")?.parentId).toBe("n1");
  });

  it("negative:dgm:pt 为空 → nodes:[](不抛错)", async () => {
    const buf = await buildPptx2(frame, {
      "ppt/diagrams/data1.xml": data("", ""),
      "ppt/slides/_rels/slide1.xml.rels": slideRels(rel("rId10", "diagramData", "../diagrams/data1.xml")),
    });
    const ast = await parseOffice(buf, ".pptx");
    if (ast.kind !== "pptx") throw new Error("kind");
    expect(ast.slides[0]?.shapes[0]?.diagram?.nodes).toEqual([]);
  });
});

/** 造 docx:document.xml 内联批注 + 可选额外部件(comments/header1/footnotes)。 */
async function buildDocx2(documentXml: string, extra: Record<string, string> = {}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file("word/document.xml", documentXml);
  for (const n of Object.keys(extra)) zip.file(n, extra[n] as string);
  return await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

describe("AST v2:Word 修订/批注/页眉脚注", () => {
  it("w:ins → revised:'ins';w:del 的 delText 原文必须出现在 runs 里(negative:不得静默丢)", async () => {
    const doc = '<?xml version="1.0" encoding="UTF-8"?><w:document ' + W_NS + '><w:body>' +
      '<w:p><w:ins w:id="1" w:author="A"><w:r><w:t>新加</w:t></w:r></w:ins>' +
      '<w:del w:id="2" w:author="A"><w:r><w:delText>被删掉的原文</w:delText></w:r></w:del></w:p>' +
      '</w:body></w:document>';
    const ast = await parseOffice(await buildDocx2(doc), ".docx");
    if (ast.kind !== "docx") throw new Error("kind");
    const runs = ast.blocks[0]?.runs ?? [];
    expect(runs.find((r) => r.text === "新加")?.revised).toBe("ins");
    const del = runs.find((r) => r.revised === "del");
    expect(del?.text).toBe("被删掉的原文");            // 不得丢
    expect(runs.some((r) => r.revised === "del" && r.text.indexOf("被删掉") >= 0)).toBe(true);
  });

  it("negative:无修订的普通段落不产出 revised 字段", async () => {
    const doc = '<?xml version="1.0" encoding="UTF-8"?><w:document ' + W_NS + '><w:body>' +
      '<w:p><w:r><w:t>普通</w:t></w:r></w:p></w:body></w:document>';
    const ast = await parseOffice(await buildDocx2(doc), ".docx");
    if (ast.kind !== "docx") throw new Error("kind");
    expect(ast.blocks[0]?.runs?.[0]).toEqual({ text: "普通" });
  });

  it("commentRangeStart + comments.xml → block.comments 含「作者: 内容」(string[])", async () => {
    const doc = '<?xml version="1.0" encoding="UTF-8"?><w:document ' + W_NS + '><w:body>' +
      '<w:p><w:commentRangeStart w:id="7"/><w:r><w:t>标记段落</w:t></w:r><w:commentRangeEnd w:id="7"/></w:p>' +
      '</w:body></w:document>';
    const comments = '<?xml version="1.0" encoding="UTF-8"?><w:comments ' + W_NS + '>' +
      '<w:comment w:id="7" w:author="张三"><w:p><w:r><w:t>这里要改</w:t></w:r></w:p></w:comment></w:comments>';
    const ast = await parseOffice(await buildDocx2(doc, { "word/comments.xml": comments }), ".docx");
    if (ast.kind !== "docx") throw new Error("kind");
    expect(ast.blocks[0]?.comments).toEqual(["张三: 这里要改"]);
    expect(typeof ast.blocks[0]?.comments?.[0]).toBe("string"); // 契约:string[] 不是对象数组
  });

  it("negative:comments.xml 缺失 → 无 comments 字段,不抛错", async () => {
    const doc = '<?xml version="1.0" encoding="UTF-8"?><w:document ' + W_NS + '><w:body>' +
      '<w:p><w:commentRangeStart w:id="7"/><w:r><w:t>x</w:t></w:r></w:p></w:body></w:document>';
    const ast = await parseOffice(await buildDocx2(doc), ".docx");
    if (ast.kind !== "docx") throw new Error("kind");
    expect(ast.blocks.length).toBe(1);
    expect(ast.blocks[0] && "comments" in ast.blocks[0]).toBe(false);
  });

  it("header1/footnotes → 落 docx.headers/footnotes 且 blocks 里不含它们(negative)", async () => {
    const doc = '<?xml version="1.0" encoding="UTF-8"?><w:document ' + W_NS + '><w:body>' +
      '<w:p><w:r><w:t>正文一段</w:t></w:r></w:p></w:body></w:document>';
    const header = '<?xml version="1.0" encoding="UTF-8"?><w:hdr ' + W_NS + '>' +
      '<w:p><w:r><w:t>页眉文字</w:t></w:r></w:p></w:hdr>';
    const footer = '<?xml version="1.0" encoding="UTF-8"?><w:ftr ' + W_NS + '>' +
      '<w:p><w:r><w:t>页脚文字</w:t></w:r></w:p></w:ftr>';
    const notes = '<?xml version="1.0" encoding="UTF-8"?><w:footnotes ' + W_NS + '>' +
      '<w:footnote w:id="1"><w:p><w:r><w:t>脚注文字</w:t></w:r></w:p></w:footnote></w:footnotes>';
    const ast = await parseOffice(await buildDocx2(doc, {
      "word/header1.xml": header, "word/footer1.xml": footer, "word/footnotes.xml": notes,
    }), ".docx");
    if (ast.kind !== "docx") throw new Error("kind");
    expect(ast.blocks.length).toBe(1);                 // blocks 只含 body(blockIndex 不漂移)
    expect(ast.blocks[0]?.runs?.map((r) => r.text).join("")).toBe("正文一段");
    expect(ast.headers?.length).toBe(1);
    expect(ast.headers?.[0]?.runs?.map((r) => r.text).join("")).toBe("页眉文字");
    expect(ast.footers?.[0]?.runs?.map((r) => r.text).join("")).toBe("页脚文字");
    expect(ast.footnotes?.[0]?.runs?.map((r) => r.text).join("")).toBe("脚注文字");
    const all = JSON.stringify(ast.blocks);
    expect(all).not.toContain("页眉文字");
    expect(all).not.toContain("脚注文字");
  });

  it("negative:无页眉/脚注部件 → 不产出 headers/footers/footnotes 字段", async () => {
    const doc = '<?xml version="1.0" encoding="UTF-8"?><w:document ' + W_NS + '><w:body>' +
      '<w:p><w:r><w:t>x</w:t></w:r></w:p></w:body></w:document>';
    const ast = await parseOffice(await buildDocx2(doc), ".docx");
    if (ast.kind !== "docx") throw new Error("kind");
    expect(ast.headers).toBeUndefined();
    expect(ast.footers).toBeUndefined();
    expect(ast.footnotes).toBeUndefined();
  });
});

// ───────────────────────── 路由层(/ide/office 与 /ide/office/media) ─────────────────────────
const TMP_ROOT = mkdtempSync(join(tmpdir(), "genie-ide-office-"));
const PID = "vitest-office";
const PROJ = join(TMP_ROOT, PID);
mkdirSync(join(PROJ, "deck"), { recursive: true });
const PORT = 7937;
const BASE = "http://127.0.0.1:" + PORT;
const panel = servePanel(PORT, () => { /* 不需要 WS */ }, {
  ideProjectRoot: (pid?: string) => (pid === PID ? PROJ : undefined),
});

afterAll(async () => {
  await panel.close();
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const officeUrl = (rel: string, pid = PID) => BASE + "/ide/office?path=" + encodeURIComponent(rel) + "&pid=" + pid;
const mediaUrl = (rel: string, part: string, pid = PID) =>
  BASE + "/ide/office/media?path=" + encodeURIComponent(rel) + "&part=" + encodeURIComponent(part) + "&pid=" + pid;

describe("/ide/office 路由:沙箱 + 白名单 + 错误码", () => {
  it("pptx/docx → 200 JSON(AST);.exe → 403「仅 .pptx/.docx」;穿越/不存在 → 403/400/404", async () => {
    writeFileSync(join(PROJ, "deck", "示例.pptx"), await buildPptx());
    writeFileSync(join(PROJ, "note.docx"), await buildDocx());
    writeFileSync(join(PROJ, "evil.exe"), "MZ");
    writeFileSync(join(PROJ, "broken.pptx"), "not a zip");
    mkdirSync(join(PROJ, ".git"), { recursive: true });
    writeFileSync(join(PROJ, ".git", "secret.pptx"), await buildPptx());
    await wait(120);

    const r1 = await fetch(officeUrl("deck/示例.pptx"));
    expect(r1.status).toBe(200);
    expect(r1.headers.get("content-type")).toContain("application/json");
    const ast1 = await r1.json() as { kind?: string; slides?: { shapes: { src?: string }[] }[] };
    expect(ast1.kind).toBe("pptx");
    expect(ast1.slides && ast1.slides[0] && ast1.slides[0].shapes.some((x) => !!x.src)).toBe(true);

    const r2 = await fetch(officeUrl("note.docx"));
    expect(r2.status).toBe(200);
    const ast2 = await r2.json() as { kind?: string; blocks?: unknown[] };
    expect(ast2.kind).toBe("docx");
    expect(ast2.blocks ? ast2.blocks.length : 0).toBe(4);

    const r3 = await fetch(officeUrl("evil.exe"));
    expect(r3.status).toBe(403);
    expect(await r3.text()).toContain("仅 .pptx/.docx");

    const r4 = await fetch(officeUrl("../escape.pptx"));
    expect(r4.status).toBe(403);

    const r5 = await fetch(officeUrl(".git/secret.pptx"));
    expect(r5.status).toBe(403);

    const r6 = await fetch(officeUrl(""));
    expect(r6.status).toBe(400);

    const r7 = await fetch(officeUrl("missing.pptx"));
    expect(r7.status).toBe(404);

    const r8 = await fetch(officeUrl("broken.pptx"));
    expect(r8.status).toBe(500);
    expect(await r8.text()).toContain("解析失败");

    const r9 = await fetch(officeUrl("note.docx", "no-such-project"));
    expect(r9.status).toBe(400); // 项目不存在 → 400(与 /ide/asset 同口径)
  }, 30_000);

  it("/ide/office/media:part 白名单 + 源文件沙箱 + content-type", async () => {
    await wait(60);
    const ok = await fetch(mediaUrl("deck/示例.pptx", "ppt/media/image1.png"));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("image/png");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.compare(Buffer.from(await ok.arrayBuffer()), PNG_1x1)).toBe(0);

    const bad = await fetch(mediaUrl("deck/示例.pptx", "../../etc/passwd"));
    expect(bad.status).toBe(400);
    const bad2 = await fetch(mediaUrl("deck/示例.pptx", "docProps/thumb.png"));
    expect(bad2.status).toBe(400);
    const miss = await fetch(mediaUrl("deck/示例.pptx", "ppt/media/nope.png"));
    expect(miss.status).toBe(404);
    const escape = await fetch(mediaUrl("../evil.pptx", "ppt/media/image1.png"));
    expect(escape.status).toBe(403);
    const exeSrc = await fetch(mediaUrl("evil.exe", "ppt/media/image1.png"));
    expect(exeSrc.status).toBe(403);
  }, 30_000);
});
