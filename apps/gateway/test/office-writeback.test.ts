import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { MemoryJournal } from "@lampgenie/core";
import { parseOffice, rewriteOfficeText } from "../src/office-ooxml.js";
import { startGatewayServer } from "../src/server.js";
import { TaskSupervisor } from "../src/task-manager.js";
import type { ProjectRegistry } from "../src/projects.js";

/** Office 文本级回写(2026-10-29 板节点「OOXML 文本回写」P2):
 *  - 现场 jszip 造 2 页 pptx(每页一个文本框)与 docx(2 段 + 1 表格),不依赖仓内二进制;
 *  - 改一处 → 重新 parseOffice 断言目标块已变、**其它块逐字不变**;
 *  - 负例:下标越界抛错(不静默返回原 buf);文本含 & < > " ' → 转义后能原样读回(不破 XML)。
 *
 *  字节口径(**不骗自己**):zip 重新打包后整体字节必然与原文件不同(DEFLATE 流/条目顺序/时间戳),
 *  所以这里断言的是「其它条目的**解压后内容**不变」,不是「zip 字节不变」。
 */
const SLIDE_W = 12192000, SLIDE_H = 6858000;

function slideXml(text: string): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>' +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="文本框 1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="1270000" y="635000"/><a:ext cx="8890000" cy="1270000"/></a:xfrm></p:spPr>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="1800" lang="zh-CN"/>' +
    '<a:t>' + text + '</a:t></a:r></a:p></p:txBody></p:sp>' +
    '</p:spTree></p:cSld></p:sld>';
}

const POINTER_PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8fff030000601020081b7b4b10000000049454e44ae426082", "hex");
const EXTRA_PART = '<extra xmlns="urn:test"><v>原样保留</v></extra>';

async function buildPptx2(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file("ppt/presentation.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:sldSz cx="' + SLIDE_W + '" cy="' + SLIDE_H + '"/></p:presentation>');
  zip.file("ppt/slides/slide1.xml", slideXml("第一页原文"));
  zip.file("ppt/slides/slide2.xml", slideXml("第二页原文"));
  zip.file("ppt/media/image1.png", POINTER_PNG);
  zip.file("docProps/extra.xml", EXTRA_PART); // 无关条目:验证"其它条目解压内容不变"
  return await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

const DOCX_BODY = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
  '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一段原文</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>第二段</w:t></w:r><w:r><w:t>原文</w:t></w:r></w:p>' +
  '<w:tbl><w:tblPr/>' +
  '<w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr>' +
  '<w:tr><w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc></w:tr>' +
  '</w:tbl>' +
  '</w:body></w:document>';

async function buildDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file("word/document.xml", DOCX_BODY);
  zip.file("word/media/image1.png", POINTER_PNG);
  zip.file("docProps/extra.xml", EXTRA_PART);
  return await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** 取 zip 里除指定 part 外所有条目的解压后内容(用于断言"其它条目一律不动")。 */
async function entriesExcept(buf: Buffer, skip: string[]): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(buf);
  const out: Record<string, string> = {};
  for (const name of Object.keys(zip.files).sort()) {
    if (skip.includes(name)) continue;
    const f = zip.file(name);
    if (!f) continue;
    out[name] = await f.async("base64");
  }
  return out;
}

describe("rewriteOfficeText:PPTX 第 1 页", () => {
  it("改第 1 页文本 → 第 1 页变、第 2 页与其它条目不变", async () => {
    const src = await buildPptx2();
    const before = await entriesExcept(src, ["ppt/slides/slide1.xml"]);
    const out = await rewriteOfficeText(src, ".pptx", [{ slideIndex: 1, shapeIndex: 0, text: "第一页改后" }]);

    const ast = await parseOffice(out, ".pptx");
    expect(ast.kind).toBe("pptx");
    if (ast.kind !== "pptx") return;
    expect(ast.slides.length).toBe(2);
    const s1 = ast.slides[0], s2 = ast.slides[1];
    if (!s1 || !s2) return;
    expect(s1.shapes[0] && s1.shapes[0].text).toBe("第一页改后");
    expect(s2.shapes[0] && s2.shapes[0].text).toBe("第二页原文"); // 未动的页逐字不变

    // 其它条目的解压后内容逐字不变(slide1 除外;zip 整体字节必变,不做字节断言)
    expect(await entriesExcept(out, ["ppt/slides/slide1.xml"])).toEqual(before);
  });

  it("改第 2 页 + 第 1 页同一次调用(多页各自写回)", async () => {
    const src = await buildPptx2();
    const out = await rewriteOfficeText(src, ".pptx", [
      { slideIndex: 1, shapeIndex: 0, text: "P1" },
      { slideIndex: 2, shapeIndex: 0, text: "P2" },
    ]);
    const ast = await parseOffice(out, ".pptx");
    if (ast.kind !== "pptx") return;
    expect(ast.slides[0]?.shapes[0]?.text).toBe("P1");
    expect(ast.slides[1]?.shapes[0]?.text).toBe("P2");
  });

  it("negative:shapeIndex / slideIndex 越界 → 抛错(不静默返回原 buf)", async () => {
    const src = await buildPptx2();
    await expect(rewriteOfficeText(src, ".pptx", [{ slideIndex: 1, shapeIndex: 9, text: "x" }]))
      .rejects.toThrow("shapeIndex 越界");
    await expect(rewriteOfficeText(src, ".pptx", [{ slideIndex: 5, shapeIndex: 0, text: "x" }]))
      .rejects.toThrow("下标越界");
    await expect(rewriteOfficeText(src, ".pptx", []))
      .rejects.toThrow("没有要写入的文本改动");
  });

  it("negative:文本含 & < > \" ' → 写入后能原样读回(转义正确,不破 XML)", async () => {
    const src = await buildPptx2();
    const tricky = 'A & B < C > D "E" \'F\'';
    const out = await rewriteOfficeText(src, ".pptx", [{ slideIndex: 1, shapeIndex: 0, text: tricky }]);
    const ast = await parseOffice(out, ".pptx");
    if (ast.kind !== "pptx") return;
    expect(ast.slides[0]?.shapes[0]?.text).toBe(tricky);

    // 落盘的 XML 必须真的转义过(不是把裸 & 塞回去)
    const zip = await JSZip.loadAsync(out);
    const xml = await zip.file("ppt/slides/slide1.xml")?.async("string");
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&lt;");
    expect(xml).not.toContain("A & B");
  });
});

describe("rewriteOfficeText:DOCX 第 2 段", () => {
  it("改第 2 段 → 第 1 段与表格不变", async () => {
    const src = await buildDocx();
    const before = await entriesExcept(src, ["word/document.xml"]);
    const out = await rewriteOfficeText(src, ".docx", [{ blockIndex: 1, text: "第二段已改" }]);

    const ast = await parseOffice(out, ".docx");
    expect(ast.kind).toBe("docx");
    if (ast.kind !== "docx") return;
    const p0 = ast.blocks[0], p1 = ast.blocks[1], tbl = ast.blocks[2];
    expect(p0?.type).toBe("p");
    expect(p0?.runs?.[0]?.text).toBe("第一段原文"); // 未动的段落不变
    expect(p1?.type).toBe("p");
    expect(p1?.runs?.map((r) => r.text).join("")).toBe("第二段已改"); // 多 run 段落合并成第一 run
    expect(tbl?.type).toBe("table");
    expect(tbl?.rows).toEqual([["A1", "B1"], ["A2", "B2"]]); // 表格文本不变

    expect(await entriesExcept(out, ["word/document.xml"])).toEqual(before);
  });

  it("negative:blockIndex 越界 / 指向表格 → 抛错", async () => {
    const src = await buildDocx();
    await expect(rewriteOfficeText(src, ".docx", [{ blockIndex: 9, text: "x" }]))
      .rejects.toThrow("blockIndex 越界");
    await expect(rewriteOfficeText(src, ".docx", [{ blockIndex: 2, text: "x" }]))
      .rejects.toThrow("不是段落");
  });

  it("negative:docx 文本含 XML 元字符 → 原样读回", async () => {
    const src = await buildDocx();
    const tricky = "<tag> & \"q\" 'a'";
    const out = await rewriteOfficeText(src, ".docx", [{ blockIndex: 0, text: tricky }]);
    const ast = await parseOffice(out, ".docx");
    if (ast.kind !== "docx") return;
    expect(ast.blocks[0]?.runs?.[0]?.text).toBe(tricky);
  });
});

describe("rewriteOfficeText:入参守卫", () => {
  it("非 OOXML 字节 / 错扩展名 / 空 edits 一律抛错", async () => {
    const buf = Buffer.from("not a zip");
    await expect(rewriteOfficeText(buf, ".pptx", [{ slideIndex: 1, shapeIndex: 0, text: "x" }]))
      .rejects.toThrow("不是有效的 OOXML 文件");
    await expect(rewriteOfficeText(await buildPptx2(), ".xlsx" as ".pptx", [{ slideIndex: 1, shapeIndex: 0, text: "x" }]))
      .rejects.toThrow("仅 .pptx/.docx 可回写");
  });
});

// ───────────────────────── 端到端(真面板 WS 通道,同 ide-fs.test.ts 基建) ─────────────────────────
describe("ide.office.edit 端到端(真 gateway WS)", () => {
  it("改 docx 第 1 段 → ok:true,重新解析读到新文本", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-office-wb-"));
    const httpServer = createServer();
    try {
      writeFileSync(join(dir, "note.docx"), await buildDocx());
      await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
      const port = (httpServer.address() as { port: number }).port;
      const srv = startGatewayServer({
        port, server: httpServer, taskManager: new TaskSupervisor(), journal: new MemoryJournal(),
        projects: { activeId: () => "p1", resolveWorkdir: () => dir, list: () => [] } as unknown as ProjectRegistry,
      });
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const inbox: Record<string, unknown>[] = [];
      ws.on("message", (r) => inbox.push(JSON.parse(r.toString()) as Record<string, unknown>));
      await new Promise((r) => ws.on("open", r));
      const send = (o: object) => ws.send(JSON.stringify({ v: 1, ...o }));
      const waitType = (t: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(t + " 超时")), 15_000);
        const p = setInterval(() => {
          const i = inbox.findIndex((x) => x.type === t);
          if (i >= 0) { clearTimeout(timer); clearInterval(p); resolve(inbox.splice(i, 1)[0] as Record<string, unknown>); }
        }, 25);
      });
      try {
        // ① ide.office.edit:docx 第 1 段整体替换
        send({ type: "ide.office.edit", path: "note.docx", edits: [{ blockIndex: 0, text: "端到端已改" }] });
        const r1 = await waitType("ide.office.edit.result");
        expect(r1.ok).toBe(true);
        expect(Number(r1.bytes)).toBeGreaterThan(0);
        const ast = await parseOffice(readFileSync(join(dir, "note.docx")), ".docx");
        if (ast.kind === "docx") {
          expect(ast.blocks[0]?.runs?.[0]?.text).toBe("端到端已改");
          expect(ast.blocks[1]?.runs?.map((x) => x.text).join("")).toBe("第二段原文"); // 其它块不变
        }

        // ② 负例:越界下标 → ok:false + 明确原因(不静默成功)
        send({ type: "ide.office.edit", path: "note.docx", edits: [{ blockIndex: 99, text: "x" }] });
        const r2 = await waitType("ide.office.edit.result");
        expect(r2.ok).toBe(false);
        expect(String(r2.error)).toContain("越界");

        // ③ 负例:非 .pptx/.docx 扩展名被拒
        send({ type: "ide.office.edit", path: "note.txt", edits: [{ blockIndex: 0, text: "x" }] });
        const r3 = await waitType("ide.office.edit.result");
        expect(r3.ok).toBe(false);
        expect(String(r3.error)).toContain("仅 .pptx/.docx");
      } finally {
        try { ws.close(); } catch { /* 已断开容忍 */ }
        await srv.close();
        await new Promise<void>((r) => { httpServer.close(() => r()); httpServer.closeAllConnections?.(); });
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});
