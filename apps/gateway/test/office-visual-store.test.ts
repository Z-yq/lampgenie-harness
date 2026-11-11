/**
 * office-visual-store 单测:jszip 现场造夹具(不落二进制资产),覆盖几何解析 / 渲染降级 / 报告落盘。
 * 造夹具的原则:只写「最小但合法」的 OOXML 片段——能证明口径的那几行属性,别的一律不写,
 * 这样断言失败时一眼能看出是哪个换算错了。渲染只测**引擎缺失/失败**路径(真跑 soffice 太慢,
 * 且 CI 上不一定装),但真实渲染路径由 scripts/office-visual.mts 手工验收覆盖。
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  OFFICE_VISUAL_CODES,
  OFFICE_VISUAL_VERSION,
  RENDER_ENGINE_MISSING,
  RENDER_FAILED,
  RENDER_OK,
  VISUAL_EMPTY_DECK,
  VISUAL_INVALID,
  VISUAL_IO_ERROR,
  VISUAL_OK,
  parsePptxGeometry,
  renderSlides,
  runVisualCheck,
  visualRootAllowed,
  writeVisualReport,
} from "../src/office-visual-store.js";

// ───────────────────────── 夹具工具 ─────────────────────────

/** 最小 PNG:8 字节魔数 + IHDR 块(宽高各 4 字节大端在 16/20);只用头,不造 base64。 */
function pngHeader(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); // IHDR 数据长度
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8; // bit depth
  b[25] = 6; // color type RGBA
  return b;
}

interface SlideInput {
 /** slide 部件名(不带 .xml),例如 "slide1";用于构造 ppt/slides/<name>.xml */
  name: string;
 /** spTree 内部的形状片段 */
  body: string;
 /** slide 自己的 rels:Id → Target(相对 ppt/slides) */
  rels?: Record<string, string>;
 /** slide 自己的媒体部件:部件路径 → 字节 */
  media?: Record<string, Uint8Array>;
 /** 页面底色(a:srgbClr@val 的 6 位十六进制);不写表示该页没有 p:bg */
  bg?: string;
}

/** 造一个 PPTX 包(全内存 → Uint8Array)。 */
async function buildPptx(opts: {
  slides: SlideInput[];
 /** p:sldSz;传 null 表示不写(测默认值) */
  sldSz?: { cx: number; cy: number } | null;
 /** sldId 列表:r:id → slide 部件名;传 null 表示不写 sldIdLst */
  sldIds?: { id: string; target: string }[] | null;
 /** presentation.xml.rels 的 Id → Target;传 null 表示不写 rels 部件 */
  presRels?: Record<string, string> | null;
 /** 母版底色(slide 没写 p:bg 时应当继承它);不写表示不造母版部件 */
  masterBg?: string;
}): Promise<Uint8Array> {
  const zip = new JSZip();
  const sldSz =
    opts.sldSz === null
      ? ""
      : `<p:sldSz cx="${opts.sldSz?.cx ?? 12192000}" cy="${opts.sldSz?.cy ?? 6858000}" type="screen16x9"/>`;
  const sldIdLst =
    opts.sldIds === null
      ? ""
      : `<p:sldIdLst>${(opts.sldIds ?? opts.slides.map((s, i) => ({ id: `rId${i + 1}`, target: s.name })))
          .map((s, i) => `<p:sldId id="${256 + i}" r:id="${s.id}"/>`)
          .join("")}</p:sldIdLst>`;
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">${sldSz}${sldIdLst}</p:presentation>`,
  );
  if (opts.presRels !== null) {
    const rels = opts.presRels ?? Object.fromEntries(opts.slides.map((s, i) => [`rId${i + 1}`, `slides/${s.name}.xml`]));
    zip.file(
      "ppt/_rels/presentation.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Object.entries(rels)
        .map(([id, target]) => `<Relationship Id="${id}" Type="x/slide" Target="${target}"/>`)
        .join("")}</Relationships>`,
    );
  }
  for (const s of opts.slides) {
    const bgXml = s.bg ? `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${s.bg}"/></a:solidFill></p:bgPr></p:bg>` : "";
    zip.file(
      `ppt/slides/${s.name}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld>${bgXml}<p:spTree>${s.body}</p:spTree></p:cSld></p:sld>`,
    );
    if (s.rels) {
      zip.file(
        `ppt/slides/_rels/${s.name}.xml.rels`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Object.entries(s.rels)
          .map(([id, target]) => `<Relationship Id="${id}" Type="x/image" Target="${target}"/>`)
          .join("")}</Relationships>`,
      );
    }
    for (const [path, bytes] of Object.entries(s.media ?? {})) zip.file(path, bytes);
  }
  if (opts.masterBg) {
    zip.file(
      "ppt/slideMasters/slideMaster1.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${opts.masterBg}"/></a:solidFill></p:bgPr></p:bg><p:spTree/></p:cSld></p:sldMaster>`,
    );
  }
  return zip.generateAsync({ type: "uint8array" });
}

/** 一个普通文本框:off/ext 用 EMU 给,txBody 里放 runs。 */
function sp(opts: { x: number; y: number; cx: number; cy: number; runs?: string; extra?: string; ph?: string; descr?: string }): string {
  const ph = opts.ph ? `<p:nvPr><p:ph type="${opts.ph}"/></p:nvPr>` : "";
  const descr = opts.descr !== undefined ? ` descr="${opts.descr}"` : "";
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="S"${descr}/><p:cNvSpPr/><p:nvSpPr-placeholder>${ph}</p:nvSpPr-placeholder></p:nvSpPr><p:spPr><a:xfrm><a:off x="${opts.x}" y="${opts.y}"/><a:ext cx="${opts.cx}" cy="${opts.cy}"/></a:xfrm></p:spPr>${opts.extra ?? ""}${opts.runs ?? ""}</p:sp>`;
}

/** 一个图片:p:pic + blipFill/blip@r:embed。 */
function pic(opts: { x: number; y: number; cx: number; cy: number; embed: string; descr?: string }): string {
  const descr = opts.descr !== undefined ? ` descr="${opts.descr}"` : "";
  return `<p:pic><p:nvPicPr><p:cNvPr id="3" name="P"${descr}/><p:cNvPicPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${opts.embed}"/></p:blipFill><p:spPr><a:xfrm><a:off x="${opts.x}" y="${opts.y}"/><a:ext cx="${opts.cx}" cy="${opts.cy}"/></a:xfrm></p:spPr></p:pic>`;
}

/** 形状的 txBody:一个段落若干 run,首个 rPr 带 sz/颜色/加粗。 */
function txBody(text: string, rPr?: { sz?: number; b?: 0 | 1; color?: string; endSz?: number }): string {
  const sz = rPr?.sz ? ` sz="${rPr.sz}"` : "";
  const b = rPr?.b !== undefined ? ` b="${rPr.b}"` : "";
  const fill = rPr?.color ? `<a:solidFill><a:srgbClr val="${rPr.color}"/></a:solidFill>` : "";
  const end = rPr?.endSz ? `<a:endParaRPr sz="${rPr.endSz}"/>` : "";
  return `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN"${sz}${b}>${fill}</a:rPr><a:t>${text}</a:t></a:r>${end}</a:p></p:txBody>`;
}

let tmpRoot = "";

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "office-visual-test-"));
});

afterAll(async () => {
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

// ───────────────────────── 几何解析:页面尺寸 ─────────────────────────
describe("parsePptxGeometry:页面尺寸", () => {
  it("sldSz 12192000×6858000 → 960×540pt,off/ext 同步折成 pt", async () => {
    const buf = await buildPptx({
      slides: [{ name: "slide1", body: sp({ x: 1270000, y: 635000, cx: 2540000, cy: 1270000 }) }],
    });
    const r = await parsePptxGeometry(buf);
    expect(r.ok).toBe(true);
    expect(r.code).toBe(VISUAL_OK);
    expect(r.slideCount).toBe(1);
    expect(r.pages[0]!.width).toBe(960);
    expect(r.pages[0]!.height).toBe(540);
 // 1270000/12700 = 100pt;635000/12700 = 50pt;2540000 → 200pt;1270000 → 100pt
    expect(r.pages[0]!.shapes[0]!.rect).toEqual({ x: 100, y: 50, w: 200, h: 100 });
  });

  it("缺 sldSz → 退回 16:9 默认 960×540 并留告警", async () => {
    const buf = await buildPptx({
      sldSz: null,
      slides: [{ name: "slide1", body: sp({ x: 0, y: 0, cx: 1270000, cy: 1270000 }) }],
    });
    const r = await parsePptxGeometry(buf);
    expect(r.ok).toBe(true);
    expect(r.pages[0]!.width).toBe(960);
    expect(r.pages[0]!.height).toBe(540);
    expect(r.warnings.join()).toContain("sldSz");
  });

  it("4:3 的 sldSz(9144000×6858000)→ 720×540pt", async () => {
    const buf = await buildPptx({
      sldSz: { cx: 9144000, cy: 6858000 },
      slides: [{ name: "slide1", body: sp({ x: 0, y: 0, cx: 1270000, cy: 1270000 }) }],
    });
    const r = await parsePptxGeometry(buf);
    expect(r.pages[0]!.width).toBe(720);
    expect(r.pages[0]!.height).toBe(540);
  });
});

// ───────────────────────── 几何解析:slide 顺序 ─────────────────────────
describe("parsePptxGeometry:slide 顺序", () => {
  it("按 presentation.xml.rels 的 r:id 顺序(故意与文件名相反)", async () => {
    const buf = await buildPptx({
      slides: [
        { name: "slide1", body: sp({ x: 0, y: 0, cx: 1270000, cy: 127000 }), },
        { name: "slide2", body: sp({ x: 1270000, y: 0, cx: 1270000, cy: 127000 }), },
      ],
 // rId1 → slide2,rId2 → slide1:sldIdLst 顺序 = [rId1, rId2] → 页序应为 slide2、slide1
      presRels: { rId1: "slides/slide2.xml", rId2: "slides/slide1.xml" },
      sldIds: [{ id: "rId1", target: "slide2" }, { id: "rId2", target: "slide1" }],
    });
    const r = await parsePptxGeometry(buf);
    expect(r.ok).toBe(true);
    expect(r.pages).toHaveLength(2);
 // slide2 的形状在 x=100pt → 第一页;slide1 在 x=0 → 第二页
    expect(r.pages[0]!.index).toBe(1);
    expect(r.pages[0]!.shapes[0]!.rect.x).toBe(100);
    expect(r.pages[1]!.index).toBe(2);
    expect(r.pages[1]!.shapes[0]!.rect.x).toBe(0);
  });

  it("缺 presentation.xml.rels → 退回 slideN 数字序(slide10 排在 slide2 之后)", async () => {
    const buf = await buildPptx({
      presRels: null,
      sldIds: null,
      slides: [
        { name: "slide10", body: sp({ x: 1270000, y: 0, cx: 1270000, cy: 127000 }) },
        { name: "slide2", body: sp({ x: 381000, y: 0, cx: 1270000, cy: 127000 }) },
      ],
    });
    const r = await parsePptxGeometry(buf);
    expect(r.ok).toBe(true);
 // 数字序:slide2(381000 → 30pt)在前,slide10(100pt)在后
    expect(r.pages).toHaveLength(2);
    expect(r.pages[0]!.shapes[0]!.rect.x).toBe(30);
    expect(r.pages[1]!.shapes[0]!.rect.x).toBe(100);
  });
});

// ───────────────────────── 几何解析:组坐标 ─────────────────────────
describe("parsePptxGeometry:组合形状坐标累加", () => {
  it("grpSp off=1000000 + 子 sp off=500000 → x 累加成 1500000EMU(118.11pt)", async () => {
    const grp = `<p:grpSp><p:nvGrpSpPr/><p:grpSpPr><a:xfrm><a:off x="1000000" y="0"/><a:ext cx="4000000" cy="2000000"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="4" name="C"/><p:cNvSpPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="500000" y="0"/><a:ext cx="1270000" cy="1270000"/></a:xfrm></p:spPr>${txBody("组内")}</p:sp></p:grpSp>`;
    const r = await parsePptxGeometry(await buildPptx({ slides: [{ name: "slide1", body: grp }] }));
    expect(r.ok).toBe(true);
    const sh = r.pages[0]!.shapes[0]!;
 // 1500000/12700 = 118.1102… → 两位小数
    expect(sh.rect.x).toBe(118.11);
    expect(sh.rect.w).toBe(100); // 组无 chExt → 缩放 1,宽不变
  });

  it("组带 chOff/chExt 缩放:ext 2000000 / chExt 1000000 → sx=2,子宽与位移都翻倍", async () => {
    const grp = `<p:grpSp><p:nvGrpSpPr/><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="2000000"/><a:chOff x="0" y="0"/><a:chExt cx="1000000" cy="1000000"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="5" name="C"/><p:cNvSpPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="500000" y="0"/><a:ext cx="500000" cy="500000"/></a:xfrm></p:spPr>${txBody("缩放")}</p:sp></p:grpSp>`;
    const r = await parsePptxGeometry(await buildPptx({ slides: [{ name: "slide1", body: grp }] }));
    const sh = r.pages[0]!.shapes[0]!;
    expect(sh.rect.x).toBe(78.74); // 1000000/12700 = 78.7401…
    expect(sh.rect.w).toBe(78.74); // 500000*2 = 1000000
  });

  it("组的 chExt 为 0 时按缩放 1 处理,不产出 NaN/Infinity", async () => {
    const grp = `<p:grpSp><p:nvGrpSpPr/><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="6" name="C"/><p:cNvSpPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="1270000" y="1270000"/><a:ext cx="1270000" cy="1270000"/></a:xfrm></p:spPr></p:sp></p:grpSp>`;
    const r = await parsePptxGeometry(await buildPptx({ slides: [{ name: "slide1", body: grp }] }));
    const sh = r.pages[0]!.shapes[0]!;
    expect(Number.isFinite(sh.rect.x)).toBe(true);
    expect(sh.rect).toEqual({ x: 100, y: 100, w: 100, h: 100 });
  });

  it("缺 xfrm/off/ext 的形状不抛错,矩形退 0", async () => {
    const r = await parsePptxGeometry(
      await buildPptx({ slides: [{ name: "slide1", body: `<p:sp><p:nvSpPr><p:cNvPr id="7" name="X"/><p:cNvSpPr/></p:nvSpPr><p:spPr/></p:sp>` }] }),
    );
    expect(r.ok).toBe(true);
    expect(r.pages[0]!.shapes[0]!.rect).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

// ───────────────────────── 几何解析:文本属性 ─────────────────────────
describe("parsePptxGeometry:文本 / 字号 / 颜色 / 填充", () => {
  it("多个 a:t 拼成一个 text,kind=text", async () => {
    const body = `<p:sp><p:nvSpPr><p:cNvPr id="8" name="T"/><p:cNvSpPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="1270000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1800"/><a:t>你好</a:t></a:r><a:r><a:t>世界</a:t></a:r></a:p></p:txBody></p:sp>`;
    const r = await parsePptxGeometry(await buildPptx({ slides: [{ name: "slide1", body }] }));
    const sh = r.pages[0]!.shapes[0]!;
    expect(sh.kind).toBe("text");
    expect(sh.text).toBe("你好世界");
    expect(sh.fontSizePt).toBe(18);
  });

  it("sz=800(百分之一 pt)→ fontSizePt=8", async () => {
    const r = await parsePptxGeometry(
      await buildPptx({ slides: [{ name: "slide1", body: sp({ x: 0, y: 0, cx: 1270000, cy: 1270000, runs: txBody("小字", { sz: 800 }) }) }] }),
    );
    expect(r.pages[0]!.shapes[0]!.fontSizePt).toBe(8);
  });

  it("只有 endParaRPr 带 sz 时也取到字号", async () => {
    const body = `<p:sp><p:nvSpPr><p:cNvPr id="9" name="E"/><p:cNvSpPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="1270000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>空段落</a:t></a:r><a:endParaRPr sz="2400"/></a:p></p:txBody></p:sp>`;
    const r = await parsePptxGeometry(await buildPptx({ slides: [{ name: "slide1", body }] }));
    expect(r.pages[0]!.shapes[0]!.fontSizePt).toBe(24);
  });

  it("srgbClr 颜色 → #rrggbb(大写输入规范化)", async () => {
    const r = await parsePptxGeometry(
      await buildPptx({
        slides: [{ name: "slide1", body: sp({ x: 0, y: 0, cx: 1270000, cy: 1270000, runs: txBody("红字", { sz: 2000, color: "FF0000" }) }) }],
      }),
    );
    expect(r.pages[0]!.shapes[0]!.color).toBe("#ff0000");
  });

  it("b=\"1\" → bold=true", async () => {
    const r = await parsePptxGeometry(
      await buildPptx({ slides: [{ name: "slide1", body: sp({ x: 0, y: 0, cx: 1270000, cy: 1270000, runs: txBody("粗体", { sz: 2000, b: 1 }) }) }] }),
    );
    expect(r.pages[0]!.shapes[0]!.bold).toBe(true);
  });

  it("spPr/a:solidFill/a:srgbClr@val → fill", async () => {
    const extra = `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="1270000"/></a:xfrm><a:solidFill><a:srgbClr val="00AAFF"/></a:solidFill></p:spPr>`;
    const body = `<p:sp><p:nvSpPr><p:cNvPr id="10" name="F"/><p:cNvSpPr/></p:nvSpPr>${extra}</p:sp>`;
    const r = await parsePptxGeometry(await buildPptx({ slides: [{ name: "slide1", body }] }));
    const sh = r.pages[0]!.shapes[0]!;
    expect(sh.fill).toBe("#00aaff");
    expect(sh.kind).toBe("shape");
  });

  it("ph type=title → isTitle;正文占位符不算标题", async () => {
    const titleBody = `<p:sp><p:nvSpPr><p:cNvPr id="11" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2540000" cy="1270000"/></a:xfrm></p:spPr>${txBody("封面标题", { sz: 4000 })}</p:sp>`;
    const bodyBody = `<p:sp><p:nvSpPr><p:cNvPr id="12" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="2540000"/><a:ext cx="2540000" cy="1270000"/></a:xfrm></p:spPr>${txBody("正文", { sz: 1800 })}</p:sp>`;
    const r = await parsePptxGeometry(await buildPptx({ slides: [{ name: "slide1", body: titleBody + bodyBody }] }));
    expect(r.pages[0]!.shapes[0]!.isTitle).toBe(true);
    expect(r.pages[0]!.shapes[1]!.isTitle).toBeUndefined();
  });
});

// ───────────────────────── 几何解析:图片 ─────────────────────────
describe("parsePptxGeometry:图片", () => {
  it("pic 的 r:embed → slide rels → media → PNG 头像素尺寸", async () => {
    const buf = await buildPptx({
      slides: [
        {
          name: "slide1",
          body: pic({ x: 0, y: 0, cx: 2540000, cy: 1270000, embed: "rId2" }),
          rels: { rId2: "../media/image1.png" },
          media: { "ppt/media/image1.png": pngHeader(640, 480) },
        },
      ],
    });
    const r = await parsePptxGeometry(buf);
    const sh = r.pages[0]!.shapes[0]!;
    expect(sh.kind).toBe("image");
    expect(sh.imagePx).toEqual({ w: 640, h: 480 });
    expect(r.mediaCount).toBe(1);
  });

  it("media 不是可识别图片格式 → 省略 imagePx(不造假期数字)并留告警", async () => {
    const buf = await buildPptx({
      slides: [
        {
          name: "slide1",
          body: pic({ x: 0, y: 0, cx: 1270000, cy: 1270000, embed: "rId2" }),
          rels: { rId2: "../media/blob.bin" },
          media: { "ppt/media/blob.bin": Buffer.from("not-an-image-at-all") },
        },
      ],
    });
    const r = await parsePptxGeometry(buf);
    expect(r.pages[0]!.shapes[0]!.imagePx).toBeUndefined();
    expect(r.warnings.join()).toContain("像素尺寸");
  });

  it("r:embed 指向不存在的 rel → 省略 imagePx 且不抛错", async () => {
    const buf = await buildPptx({
      slides: [{ name: "slide1", body: pic({ x: 0, y: 0, cx: 1270000, cy: 1270000, embed: "rId9" }) }],
    });
    const r = await parsePptxGeometry(buf);
    expect(r.ok).toBe(true);
    expect(r.pages[0]!.shapes[0]!.imagePx).toBeUndefined();
  });

  it("descr → altText;空白 descr 视为缺", async () => {
    const buf = await buildPptx({
      slides: [
        {
          name: "slide1",
          body:
            pic({ x: 0, y: 0, cx: 1270000, cy: 1270000, embed: "rId2", descr: "架构图" }) +
            pic({ x: 0, y: 0, cx: 1270000, cy: 1270000, embed: "rId2", descr: "   " }),
          rels: { rId2: "../media/image1.png" },
          media: { "ppt/media/image1.png": pngHeader(10, 10) },
        },
      ],
    });
    const r = await parsePptxGeometry(buf);
    expect(r.pages[0]!.shapes[0]!.altText).toBe("架构图");
    expect(r.pages[0]!.shapes[1]!.altText).toBeUndefined();
  });

  it("带文本的 pic 仍优先记为 text(避免把说明文字当纯图)", async () => {
    const body = `<p:pic><p:nvPicPr><p:cNvPr id="13" name="PT"/><p:cNvPicPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="1270000"/></a:xfrm></p:spPr>${txBody("图注", { sz: 1200 })}</p:pic>`;
    const r = await parsePptxGeometry(
      await buildPptx({
        slides: [{ name: "slide1", body, rels: { rId2: "../media/image1.png" }, media: { "ppt/media/image1.png": pngHeader(20, 20) } }],
      }),
    );
    expect(r.pages[0]!.shapes[0]!.kind).toBe("text");
    expect(r.pages[0]!.shapes[0]!.imagePx).toEqual({ w: 20, h: 20 });
  });
});

// ───────────────────────── 几何解析:坏输入 ─────────────────────────
describe("parsePptxGeometry:坏输入", () => {
  it("坏 zip → VISUAL_INVALID 且 pages 为空", async () => {
    const r = await parsePptxGeometry(Buffer.from("PK\u0003\u0004 definitely not a zip"));
    expect(r.ok).toBe(false);
    expect(r.code).toBe(VISUAL_INVALID);
    expect(r.pages).toEqual([]);
  });

  it("合法 zip 但不是 OOXML(缺 presentation.xml)→ VISUAL_INVALID", async () => {
    const zip = new JSZip();
    zip.file("hello.txt", "hi");
    const r = await parsePptxGeometry(await zip.generateAsync({ type: "uint8array" }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe(VISUAL_INVALID);
    expect(r.warnings.join()).toContain("presentation.xml");
  });

  it("没有任何 slide → VISUAL_EMPTY_DECK", async () => {
    const r = await parsePptxGeometry(await buildPptx({ slides: [] }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe(VISUAL_EMPTY_DECK);
    expect(r.pages).toEqual([]);
  });

  it("CODES 常量表覆盖全部 7 个稳定 code 且版本为 1", () => {
    expect(OFFICE_VISUAL_VERSION).toBe(1);
    expect([...OFFICE_VISUAL_CODES].sort()).toEqual(
      [VISUAL_OK, VISUAL_INVALID, VISUAL_EMPTY_DECK, VISUAL_IO_ERROR, RENDER_OK, RENDER_ENGINE_MISSING, RENDER_FAILED].sort(),
    );
    expect(OFFICE_VISUAL_CODES).toHaveLength(7);
  });
});

// ───────────────────────── 渲染:降级路径 ─────────────────────────
describe("renderSlides:引擎缺失 / 失败", () => {
  it("soffice 不存在 → RENDER_ENGINE_MISSING、pngPaths 空、outDir 无占位文件", async () => {
    const dir = join(tmpRoot, "render-missing");
    const r = await renderSlides(join(tmpRoot, "nope.pptx"), dir, {
      binaries: { soffice: "definitely-not-a-real-soffice-binary", gs: "definitely-not-a-real-gs-binary" },
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(RENDER_ENGINE_MISSING);
    expect(r.engine).toBe("none");
    expect(r.pngPaths).toEqual([]);
    expect(r.pages).toBe(0);
    expect(typeof r.durationMs).toBe("number");
 // 关键:绝不写占位 PNG
    const files = existsSync(dir) ? await readdir(dir) : [];
    expect(files.filter((f) => /\.png$/i.test(f))).toEqual([]);
  });

  it("引擎存在但不产出 PDF → RENDER_FAILED(不伪造成 RENDER_OK)", async () => {
    const dir = join(tmpRoot, "render-failed");
    const r = await renderSlides(join(tmpRoot, "nope.pptx"), dir, {
      binaries: { soffice: process.execPath, gs: "definitely-not-a-real-gs-binary" },
      timeoutMs: 20_000,
    });
    expect(r.ok).toBe(false);
    expect([RENDER_FAILED, RENDER_ENGINE_MISSING]).toContain(r.code);
    expect(r.pngPaths).toEqual([]);
    expect(r.pages).toBe(0);
  });

  it("渲染失败时 pngPaths 只含真实存在且 >0 字节的 slide-*.png(空文件不算)", async () => {
    const dir = join(tmpRoot, "render-empty-png");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "slide-001.png"), "");
    const r = await renderSlides(join(tmpRoot, "nope.pptx"), dir, {
      binaries: { soffice: "definitely-not-a-real-soffice-binary", gs: "definitely-not-a-real-gs-binary" },
    });
    expect(r.ok).toBe(false);
    expect(r.pngPaths).toEqual([]); // 0 字节的假图不计入
  });
});

// ───────────────────────── 落盘:root 守卫 ─────────────────────────
describe("visualRootAllowed", () => {
  it("/tmp 与其子路径放行(含尾斜杠写法)", () => {
    expect(visualRootAllowed("/tmp")).toBe(true);
    expect(visualRootAllowed("/tmp/")).toBe(true);
    expect(visualRootAllowed("/tmp/m100b")).toBe(true);
    expect(visualRootAllowed("/tmp/m100b/")).toBe(true);
    expect(visualRootAllowed("/tmp/a/b/c")).toBe(true);
  });

  it("非 /tmp 前缀/相对路径/空前缀一律拒绝", () => {
    expect(visualRootAllowed("/var/tmp/x")).toBe(false);
    expect(visualRootAllowed("/tmpfoo")).toBe(false);
    expect(visualRootAllowed("/home/user")).toBe(false);
    expect(visualRootAllowed("tmp/x")).toBe(false);
    expect(visualRootAllowed("")).toBe(false);
    expect(visualRootAllowed("/tmp/../etc")).toBe(false);
  });
});

// ───────────────────────── 落盘:报告 + ledger ─────────────────────────
/** 假报告:只用 store 需要的字段(store 不解释 issues/metrics 语义)。 */
function fakeReport(over: Partial<Record<string, unknown>> = {}) {
  return {
    ok: true,
    code: "VIS_OK",
    score: 92,
    verdict: "pass",
    issues: [],
    metrics: { pages: 2, shapes: 4, p0: 0, p1: 0, p2: 0 },
    ...over,
  } as never;
}

describe("writeVisualReport:落盘 / 幂等 / 拒写", () => {
  it("报告按 sha256 前 12 位落盘,字段与指纹一致", async () => {
    const root = await mkdtemp(join(tmpdir(), "office-visual-root-"));
    const pptxPath = join(root, "deck.pptx");
    const bytes = Buffer.from("fake-pptx-bytes");
    await writeFile(pptxPath, bytes);
    const r = await writeVisualReport(root, { pptxPath, report: fakeReport() });
    expect(r.ok).toBe(true);
    expect(r.code).toBe(VISUAL_OK);
    const expectedFp = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
    expect(r.fingerprint).toBe(expectedFp);
    expect(r.reportPath).toBe(join(root, ".genie", "office", "visual", `${expectedFp}.json`));
    const body = JSON.parse(await readFile(r.reportPath!, "utf8"));
    expect(body.version).toBe(OFFICE_VISUAL_VERSION);
    expect(body.fingerprint).toBe(expectedFp);
    expect(body.pptxPath).toBe(pptxPath);
    expect(body.machine.verdict).toBe("pass");
    expect(body.machine.score).toBe(92);
    expect(body.render).toBeNull();
 // 无渲染 → 逐页复核全是 pending(缺图不许写成 ready)
    expect(body.review.pendingCount).toBe(2);
    expect(body.review.perPage.every((p: { status: string }) => p.status === "pending")).toBe(true);
  });

  it("带渲染结果时 report.render 记录 engine 与 pngPaths,review 里有 png 的页为 ready", async () => {
    const root = await mkdtemp(join(tmpdir(), "office-visual-root-"));
    const pptxPath = join(root, "deck2.pptx");
    await writeFile(pptxPath, "bytes-2");
    const r = await writeVisualReport(root, {
      pptxPath,
      report: fakeReport({ metrics: { pages: 2 } }),
      render: { engine: "soffice+gs", pngPaths: ["/tmp/x/slide-001.png"] },
    });
    const body = JSON.parse(await readFile(r.reportPath!, "utf8"));
    expect(body.render.engine).toBe("soffice+gs");
    expect(body.render.pngPaths).toEqual(["/tmp/x/slide-001.png"]);
    expect(body.review.perPage[0].status).toBe("ready");
    expect(body.review.perPage[1].status).toBe("pending");
    expect(body.review.pendingCount).toBe(1);
  });

  it("同指纹写两次:ledger 只有一行(幂等),报告内容不变", async () => {
    const root = await mkdtemp(join(tmpdir(), "office-visual-root-"));
    const pptxPath = join(root, "deck3.pptx");
    await writeFile(pptxPath, "same-bytes");
    const a = await writeVisualReport(root, { pptxPath, report: fakeReport() });
    const first = await readFile(a.reportPath!, "utf8");
    const b = await writeVisualReport(root, { pptxPath, report: fakeReport() });
    expect(b.ok).toBe(true);
    expect(b.fingerprint).toBe(a.fingerprint);
    const lines = (await readFile(a.ledgerPath!, "utf8")).split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).fingerprint).toBe(a.fingerprint);
 // 幂等口径:ledger 不重复追加;报告 machine/render 不变(at 是本次写入时间戳,允许刷新)
    const again = JSON.parse(await readFile(a.reportPath!, "utf8"));
    const firstBody = JSON.parse(first);
    expect(again.machine).toEqual(firstBody.machine);
    expect(again.render).toEqual(firstBody.render);
 // 目录里没有残留 .tmp
    const files = await readdir(join(root, ".genie", "office", "visual"));
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("不同指纹写两个文件,ledger 各一行", async () => {
    const root = await mkdtemp(join(tmpdir(), "office-visual-root-"));
    const p1 = join(root, "a.pptx");
    const p2 = join(root, "b.pptx");
    await writeFile(p1, "AAA");
    await writeFile(p2, "BBB");
    const a = await writeVisualReport(root, { pptxPath: p1, report: fakeReport() });
    const b = await writeVisualReport(root, { pptxPath: p2, report: fakeReport({ verdict: "fail", score: 10 }) });
    expect(a.fingerprint).not.toBe(b.fingerprint);
    const lines = (await readFile(a.ledgerPath!, "utf8")).split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).verdict).toBe("fail");
  });

  it("root 不在 /tmp 之下 → VISUAL_INVALID 且一个文件都不写", async () => {
    const root = await mkdtemp(join(tmpdir(), "office-visual-root-"));
    const outside = join(process.cwd(), `notallowed-visual-${Date.now()}`); // 仓库目录(不在 /tmp 之下)
    const pptxPath = join(root, "deck4.pptx");
    await writeFile(pptxPath, "bytes");
    const r = await writeVisualReport(outside, { pptxPath, report: fakeReport() });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(VISUAL_INVALID);
    expect(r.reportPath).toBeUndefined();
    expect(r.ledgerPath).toBeUndefined();
    expect(existsSync(join(outside, ".genie"))).toBe(false);
    expect(r.fingerprint).toHaveLength(12);
  });

  it("源文件读不出 → VISUAL_IO_ERROR 且不写报告", async () => {
    const root = await mkdtemp(join(tmpdir(), "office-visual-root-"));
    const r = await writeVisualReport(root, { pptxPath: join(root, "missing.pptx"), report: fakeReport() });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(VISUAL_IO_ERROR);
    expect(existsSync(join(root, ".genie", "office", "visual"))).toBe(false);
  });
});

// ───────────────────────── 一站式 runVisualCheck ─────────────────────────
describe("runVisualCheck:端到端(不渲染)", () => {
  it("正常单据 → 有报告与 ledger,metrics.pages 与解析页数一致", async () => {
    const root = await mkdtemp(join(tmpdir(), "office-visual-run-"));
    const pptxPath = join(root, "ok.pptx");
    const buf = await buildPptx({
      slides: [{ name: "slide1", body: sp({ x: 635000, y: 635000, cx: 5000000, cy: 2540000, runs: txBody("正文内容", { sz: 2400 }) }) }],
    });
    await writeFile(pptxPath, buf);
    const r = await runVisualCheck({ root, pptxPath });
    expect(r.report.metrics.pages).toBe(1);
    expect([0, 2]).toContain(r.exitCode);
    expect(r.reportPath).toBeTruthy();
    expect(r.ledgerPath).toBeTruthy();
    expect(r.render).toBeNull();
    expect(existsSync(r.reportPath!)).toBe(true);
  });

  it("坏 pptx → exitCode 1 且 code=VISUAL_INVALID", async () => {
    const root = await mkdtemp(join(tmpdir(), "office-visual-run-"));
    const pptxPath = join(root, "bad.pptx");
    await writeFile(pptxPath, "not a zip");
    const r = await runVisualCheck({ root, pptxPath });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(VISUAL_INVALID);
    expect(r.exitCode).toBe(1);
  });

  it("文件不存在 → exitCode 1 且 code=VISUAL_IO_ERROR", async () => {
    const root = await mkdtemp(join(tmpdir(), "office-visual-run-"));
    const r = await runVisualCheck({ root, pptxPath: join(root, "absent.pptx") });
    expect(r.code).toBe(VISUAL_IO_ERROR);
    expect(r.exitCode).toBe(1);
  });

  it("请求渲染但引擎缺失 → exitCode 1、code=RENDER_ENGINE_MISSING、仍给出机器报告", async () => {
    const root = await mkdtemp(join(tmpdir(), "office-visual-run-"));
    const pptxPath = join(root, "deck.pptx");
    await writeFile(
      pptxPath,
      await buildPptx({ slides: [{ name: "slide1", body: sp({ x: 0, y: 0, cx: 1270000, cy: 1270000, runs: txBody("x", { sz: 1800 }) }) }] }),
    );
 // 真跑 soffice:本机装了会成功(慢),没装则引擎缺失;两种都只断言「不假装通过」
    const r = await runVisualCheck({ root, pptxPath, renderOutDir: join(root, "png") });
    if (!r.render!.ok) {
      expect(r.exitCode).toBe(1);
      expect([RENDER_ENGINE_MISSING, RENDER_FAILED]).toContain(r.code);
    } else {
      expect(r.render!.engine).toBe("soffice+gs");
      expect(r.render!.pngPaths.length).toBeGreaterThan(0);
    }
    expect(r.report.metrics.pages).toBe(1);
  }, 180_000);
});

// ───────────────────────── 页面底色(对比度判定的前提) ─────────────────────────
describe("parsePptxGeometry:页面底色", () => {
  const darkText = (sz: number): string => txBody("深底浅字", { sz, color: "EDEAE2" });

  it("slide 自己的 p:bg/solidFill 落进 page.background(小写 #rrggbb)", async () => {
    const bytes = await buildPptx({
      slides: [{ name: "slide1", bg: "0E100F", body: sp({ x: 0, y: 0, cx: 2000000, cy: 800000, runs: darkText(1800) }) }],
    });
    const r = await parsePptxGeometry(bytes);
    expect(r.ok).toBe(true);
    expect(r.pages[0]?.background).toBe("#0e100f");
  });

  it("slide 没写 p:bg 时继承母版底色", async () => {
    const bytes = await buildPptx({
      masterBg: "112233",
      slides: [{ name: "slide1", body: sp({ x: 0, y: 0, cx: 2000000, cy: 800000, runs: darkText(1800) }) }],
    });
    const r = await parsePptxGeometry(bytes);
    expect(r.pages[0]?.background).toBe("#112233");
  });

  it("slide 与母版都没写 bg 时 background 字段缺省(不造白色)", async () => {
    const bytes = await buildPptx({
      slides: [{ name: "slide1", body: sp({ x: 0, y: 0, cx: 2000000, cy: 800000, runs: darkText(1800) }) }],
    });
    const r = await parsePptxGeometry(bytes);
    expect(r.pages[0]).toBeDefined();
    expect(r.pages[0]?.background).toBeUndefined();
  });

  it("slide 的 bg 覆盖母版 bg(逐页取自己的)", async () => {
    const bytes = await buildPptx({
      masterBg: "112233",
      slides: [{ name: "slide1", bg: "0E100F", body: sp({ x: 0, y: 0, cx: 2000000, cy: 800000, runs: darkText(1800) }) }],
    });
    const r = await parsePptxGeometry(bytes);
    expect(r.pages[0]?.background).toBe("#0e100f");
  });

  it("深色底 + 浅色字经 runVisualCheck 不判低对比(白底假设会报 VIS_CONTRAST)", async () => {
    const root = await mkdtemp(join(tmpdir(), "office-visual-bg-"));
    const withBg = join(root, "dark.pptx");
    const noBg = join(root, "white.pptx");
    const body = () => sp({ x: 60, y: 60, cx: 4000000, cy: 1200000, runs: darkText(1800) });
    await writeFile(withBg, await buildPptx({ slides: [{ name: "slide1", bg: "0E100F", body: body() }] }));
    await writeFile(noBg, await buildPptx({ slides: [{ name: "slide1", body: body() }] }));
    const dark = await runVisualCheck({ root, pptxPath: withBg });
    const plain = await runVisualCheck({ root, pptxPath: noBg });
    expect(dark.report.issues.filter((i) => i.ruleId === "VIS_CONTRAST")).toHaveLength(0);
    expect(plain.report.issues.filter((i) => i.ruleId === "VIS_CONTRAST")).toHaveLength(1);
  });
});
