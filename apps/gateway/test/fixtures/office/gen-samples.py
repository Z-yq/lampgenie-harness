# 本仓测试样本生成器(自研,非任何外部项目文件)。
# 生成 5 个「真实形态」样本,供 doc-text 解析器测试使用:
#   cjk-sample.pdf      手工构造 PDF:非内嵌 CJK 字体 + ToUnicode CMap(含部首码点)
#   paper-sample.pdf    reportlab 生成:压缩内容流 + CID 字体(无 ToUnicode)
#   report-sample.docx  python-docx:标题层级/表格/加粗/链接/分页
#   budget-sample.xlsx  openpyxl:双 Sheet/公式/合并单元格/百分比格式
#   launch-sample.pptx  python-pptx:标题页/时间线页/表格页/备注
# 再生成方式(在本目录执行):
#   uv run --with python-docx==1.1.2 --with openpyxl==3.1.5 --with python-pptx==1.0.2 --with reportlab==4.2.5 gen-samples.py
#   python3 gen-samples.py   # 仅 cjk-sample.pdf(标准库即可)

from __future__ import annotations

import struct
import zlib

# ────────────────────────── cjk-sample.pdf ──────────────────────────
# 特征:页面上所有 CJK 字体都不内嵌,解析器必须处理字体名/ToUnicode:
#   F0  STSong-Light,预定义 CMap UniGB-UCS2-H(十六进制正文直接是 UTF-16BE)
#   F1  字体名以 GBK 双字节内码书写(/#BA#DA#CC#E5 = 黑体)
#   F2  SimSun,其 ToUnicode 把部分汉字映到部首码点(⽞⻩,Chrome 打印 PDF 的真实行为)
#   F3  KaiTi_GB2312
# 另有 Helvetica 打印的字体标注行,验证标注文字不丢。


def _cmap_stream(pairs: list[tuple[int, str]]) -> bytes:
    rows = "\n".join(f"<{cid:04X}> <{ord(ch):04X}>" for cid, ch in pairs)
    body = (
        "/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n"
        "/CMapName /Custom-Identity-UCS def /CMapType 2 def\n"
        "1 begincodespacerange <0000> <FFFF> endcodespacerange\n"
        f"{len(pairs)} beginbfchar\n{rows}\nendbfchar\n"
        "endcmap CMapName currentdict /CMap defineresource pop end end"
    ).encode("latin-1")
    return b"<< /Length " + str(len(body)).encode() + b" >>\nstream\n" + body + b"\nendstream"


def _font_descriptor(name: str) -> str:
    return (
        f"<< /Type /FontDescriptor /FontName /{name} /Flags 4 /FontBBox [-120 -140 1000 860] "
        "/ItalicAngle 0 /Ascent 860 /Descent -140 /CapHeight 680 /StemV 76 >>"
    )


def _identity_cjk_font(base_obj: int, font_name: str, glyphs: str) -> tuple[dict[int, object], str]:
    """Type0 字体四件套(字典/子字体/描述符/ToUnicode);返回对象与内容流十六进制。"""
    cids = [210 + i for i in range(len(glyphs))]
    objs: dict[int, object] = {
        base_obj: (
            f"<< /Type /Font /Subtype /Type0 /BaseFont /{font_name} /Encoding /Identity-H "
            f"/DescendantFonts [{base_obj + 1} 0 R] /ToUnicode {base_obj + 3} 0 R >>"
        ),
        base_obj + 1: (
            f"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /{font_name} "
            "/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> "
            f"/FontDescriptor {base_obj + 2} 0 R /DW 960 >>"
        ),
        base_obj + 2: _font_descriptor(font_name),
        base_obj + 3: _cmap_stream(list(zip(cids, glyphs))),
    }
    return objs, "".join(f"{cid:04X}" for cid in cids)


def build_cjk_pdf() -> bytes:
    objs: dict[int, object] = {
        1: "<< /Type /Catalog /Pages 2 0 R >>",
        2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        3: (
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R "
            "/Resources << /Font << /F0 10 0 R /F1 20 0 R /F2 30 0 R /F3 40 0 R /F8 50 0 R >> >> >>"
        ),
        10: (
            "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H "
            "/DescendantFonts [11 0 R] >>"
        ),
        11: (
            "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light "
            "/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> "
            "/FontDescriptor 12 0 R /DW 1000 >>"
        ),
        12: _font_descriptor("STSong-Light"),
        50: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    }
    hei_objs, hei_hex = _identity_cjk_font(20, "#BA#DA#CC#E5", "黑体名称：粗黑样张")
    sun_objs, sun_hex = _identity_cjk_font(30, "SimSun", "天地⽞⻩，部首映字样张")
    kai_objs, kai_hex = _identity_cjk_font(40, "KaiTi_GB2312", "楷体：楷书样张")
    objs.update(hei_objs)
    objs.update(sun_objs)
    objs.update(kai_objs)
    song_hex = "宋体：横排简体样张".encode("utf-16-be").hex().upper()
    rows = [
        ("F0", song_hex, "F0 STSong-Light predefined CMap"),
        ("F1", hei_hex, "F1 GBK-named font, serif flag"),
        ("F2", sun_hex, "F2 SimSun radicals via ToUnicode"),
        ("F3", kai_hex, "F3 KaiTi_GB2312"),
    ]
    stream = ""
    for i, (font, hex_text, label) in enumerate(rows):
        y = 750 - i * 72
        stream += f"BT /F8 9 Tf 60 {y + 28} Td ({label}) Tj ET\n"
        stream += f"BT /{font} 21 Tf 60 {y} Td <{hex_text}> Tj ET\n"
    raw = stream.encode("latin-1")
    objs[4] = b"<< /Length " + str(len(raw)).encode() + b" >>\nstream\n" + raw + b"\nendstream"

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets: dict[int, int] = {}
    for num in sorted(objs):
        body = objs[num]
        body = body.encode("latin-1") if isinstance(body, str) else body
        offsets[num] = len(out)
        out += f"{num} 0 obj\n".encode() + body + b"\nendobj\n"
    xref_at = len(out)
    count = max(objs) + 1
    out += f"xref\n0 {count}\n0000000000 65535 f \n".encode()
    out += b"".join(b"%010d 00000 n \n" % offsets[n] for n in sorted(objs))
    out += f"trailer\n<< /Size {count} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n".encode()
    return bytes(out)


# ────────────────────────── paper-sample.pdf ──────────────────────────

def build_paper_pdf(path: str) -> None:
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfgen import canvas

    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    width, height = A4
    c = canvas.Canvas(path, pagesize=A4)
    c.setTitle("Serving Latency Notes")
    c.setFont("Helvetica-Bold", 20)
    c.drawString(72, height - 88, "Serving Latency Notes")
    c.setFont("Helvetica", 12)
    for i, line in enumerate(
        [
            "Abstract: request batching cuts tail latency in half.",
            "Measured p95 drops from 820 ms to 410 ms.",
        ]
    ):
        c.drawString(72, height - 128 - i * 18, line)
    c.setFont("STSong-Light", 12)
    c.drawString(72, height - 178, "中文摘要：批处理显著降低尾延迟。")
    c.linkURL("https://example.com/latency-notes", (72, height - 214, 320, height - 196))
    c.setFont("Helvetica", 12)
    c.drawString(72, height - 210, "https://example.com/latency-notes")
    c.bookmarkPage("overview")
    c.addOutlineEntry("Overview", "overview", level=0)
    c.showPage()
    c.setFont("Helvetica-Bold", 16)
    c.drawString(72, height - 88, "Setup")
    c.setFont("Helvetica", 12)
    c.drawString(72, height - 118, "We replay one week of recorded traffic across three batch sizes.")
    c.bookmarkPage("setup")
    c.addOutlineEntry("Setup", "setup", level=0)
    c.save()


# ────────────────────────── report-sample.docx ──────────────────────────

def build_report_docx(path: str) -> None:
    from docx import Document
    from docx.shared import Pt

    doc = Document()
    doc.core_properties.title = "运营月度汇总"
    doc.add_heading("运营月度汇总", level=1)
    doc.add_paragraph("本报告汇总本月各区域运营数据与结论。")
    doc.add_heading("营收概览", level=2)
    p = doc.add_paragraph("环比增长 ")
    p.add_run("18%").bold = True
    p.add_run(",主要由华东区域拉动。")
    table = doc.add_table(rows=3, cols=2)
    for r, (a, b) in enumerate([("区域", "营收"), ("华东", "156"), ("华南", "98")]):
        table.cell(r, 0).text = a
        table.cell(r, 1).text = b
    doc.add_heading("展望", level=2)
    doc.add_paragraph("下月预计环比继续改善。重点跟进渠道侧库存。")
    for i in range(1, 4):
        doc.add_paragraph(f"风险项 {i}:物流时效波动。", style="List Bullet")
    q = doc.add_paragraph("详见 ")
    q.add_run("https://example.com/ops-monthly").font.size = Pt(10)
    doc.add_page_break()
    doc.add_heading("附录", level=2)
    doc.add_paragraph("口径说明与数据来源见第二页。")
    doc.save(path)


# ────────────────────────── budget-sample.xlsx ──────────────────────────

def build_budget_xlsx(path: str) -> None:
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill

    wb = Workbook()
    ws = wb.active
    ws.title = "营收"
    ws.append(["区域", "Q1", "Q2", "Q3", "合计"])
    for cell in ws[1]:
        cell.font = Font(bold=True)
        cell.fill = PatternFill("solid", fgColor="E2EFDA")
    rows = [("华东", 210, 230, 256), ("华南", 150, 168, 190), ("华北", 90, 96, 101)]
    for i, (region, *values) in enumerate(rows, start=2):
        ws.append([region, *values, f"=SUM(B{i}:D{i})"])
    ws.append(["合计", "=SUM(B2:B4)", "=SUM(C2:C4)", "=SUM(D2:D4)", "=SUM(E2:E4)"])
    ws.merge_cells("A7:E7")
    ws["A7"] = "金额单位:万元"
    notes = wb.create_sheet("假设")
    notes["A1"] = "项目"
    notes["B1"] = "取值"
    notes["A2"] = "季度环比增长"
    notes["B2"] = 0.18
    notes["B2"].number_format = "0%"
    wb.save(path)


# ────────────────────────── launch-sample.pptx ──────────────────────────

def build_launch_pptx(path: str) -> None:
    from pptx import Presentation
    from pptx.util import Inches, Pt as PptPt

    prs = Presentation()
    s1 = prs.slides.add_slide(prs.slide_layouts[0])
    s1.shapes.title.text = "版本发布计划"
    s1.placeholders[1].text = "秋季版本的整体节奏"
    s2 = prs.slides.add_slide(prs.slide_layouts[1])
    s2.shapes.title.text = "时间线"
    body = s2.placeholders[1].text_frame
    body.text = "9 月:内测"
    body.add_paragraph().text = "10 月:公测"
    body.add_paragraph().text = "11 月:回顾"
    box = s2.shapes.add_textbox(Inches(6), Inches(5.5), Inches(3), Inches(1))
    box.text_frame.text = "负责人:陈明"
    box.text_frame.paragraphs[0].runs[0].font.size = PptPt(14)
    s2.notes_slide.notes_text_frame.text = "备注里补充内测反馈的量化结论。"
    s3 = prs.slides.add_slide(prs.slide_layouts[5])
    s3.shapes.title.text = "预算"
    table = s3.shapes.add_table(3, 3, Inches(1), Inches(2), Inches(8), Inches(1.5)).table
    for r, row in enumerate([("物项", "预算", "负责人"), ("推广", "42k", "王一"), ("活动", "27k", "赵二")]):
        for col, value in enumerate(row):
            table.cell(r, col).text = value
    prs.save(path)


def main() -> None:
    with open("cjk-sample.pdf", "wb") as f:
        f.write(build_cjk_pdf())
    build_paper_pdf("paper-sample.pdf")
    build_report_docx("report-sample.docx")
    build_budget_xlsx("budget-sample.xlsx")
    build_launch_pptx("launch-sample.pptx")
    print("samples written: cjk-sample.pdf paper-sample.pdf report-sample.docx budget-sample.xlsx launch-sample.pptx")


if __name__ == "__main__":
    main()
