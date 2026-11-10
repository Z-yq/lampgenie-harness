import { describe, it, expect, afterAll } from "vitest";
import JSZip from "jszip";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  XLSX_ERROR_CODES,
  formulaCellsOf,
  formulaTemplate,
  recalcWithSoffice,
  scanChartGaps,
  scanFormulaErrors,
  scanFormulaPatternDrift,
} from "../src/xlsx-recalc.js";
import { checkOfficeArtifact } from "../src/office-qa.js";

/** M103 表格计算真值链:纯内存夹具,不依赖 soffice / openpyxl。
 *  覆盖:7 类错误码、普通文本不误报、公式漂移两态、recalc 三态、office-qa 接线。 */
const dir = mkdtempSync(join(tmpdir(), "xlsx-recalc-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const WORKBOOK_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets/></workbook>';

const SHARED_STRINGS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>季度数据</t></si><si><t>#N/A 表示无数据</t></si></sst>';

function sheetXml(cellsXml: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    cellsXml +
    "</sheetData></worksheet>"
  );
}

function errCell(ref: string, code: string): string {
  return `<c r="${ref}" t="e"><v>${code.replace(/&/g, "&amp;")}</v></c>`;
}

function write(name: string, data: Buffer | string): string {
  const p = join(dir, name);
  writeFileSync(p, data);
  return p;
}

async function makeXlsx(cellsXml: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("xl/workbook.xml", WORKBOOK_XML);
  zip.file("xl/sharedStrings.xml", SHARED_STRINGS);
  zip.file("xl/worksheets/sheet1.xml", sheetXml(cellsXml));
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("scanFormulaErrors: 错误值", () => {
  it("7 类错误码各命中一次,且 <f> 节点里的错误公式也算命中", () => {
    const cells =
      XLSX_ERROR_CODES.map((code, i) => errCell(`A${i + 1}`, code)).join("") +
      '<c r="B1"><f>#REF!</f></c>';
    const hits = scanFormulaErrors({ "xl/worksheets/sheet1.xml": sheetXml(cells) });
    expect(hits.map((h) => h.code).sort()).toEqual([...XLSX_ERROR_CODES, "#REF!"].sort());
    expect(hits).toHaveLength(8);
    for (const h of hits) {
      expect(h.sheet).toBe("xl/worksheets/sheet1.xml");
      expect(h.cell).toMatch(/^[AB]\d$/);
      expect(h.snippet).toContain(h.code);
    }
    // B1 是公式节点命中
    expect(hits.some((h) => h.cell === "B1" && h.code === "#REF!")).toBe(true);
  });

  it("普通文本里的 #N/A / #REF! 字样不误报(只认 <v>/<f> 内的完整错误码)", () => {
    const cells =
      '<c r="A1" t="s"><v>1</v></c>' +
      '<c r="A2" t="inlineStr"><is><t>#N/A 说明:此行缺少数据</t></is></c>' +
      '<c r="A3"><f>IFERROR(B1,"#N/A")</f></c>' +
      '<c r="A4"><f>A1&amp;"#REF!"</f></c>' +
      '<c r="A5" t="str"><v>#N/A 不是错误值,是文案</v></c>';
    expect(scanFormulaErrors({ sheet1: sheetXml(cells) })).toHaveLength(0);
  });
});

describe("scanFormulaPatternDrift: 同列同形", () => {
  const consistent = [
    { ref: "C2", formula: "A2*B2" },
    { ref: "C3", formula: "A3*B3" },
    { ref: "C4", formula: "A4*B4" },
    { ref: "C5", formula: "A5*B5" },
  ];

  it("同列 4 行公式一致 → 零漂移", () => {
    expect(scanFormulaPatternDrift({ name: "sheet1", cells: consistent })).toHaveLength(0);
  });

  it("第 3 行改成引用别的列 → 只报那一行", () => {
    const cells = consistent.map((c) => (c.ref === "C4" ? { ref: "C4", formula: "A4*D4" } : c));
    const drift = scanFormulaPatternDrift({ name: "sheet1", cells });
    expect(drift).toHaveLength(1);
    expect(drift[0]).toEqual({
      sheet: "sheet1",
      column: "C",
      expected: "A{r}*B{r}",
      actual: "A4*D4",
      ref: "C4",
    });
  });

  it("绝对引用按原样保留($A$2 与 $A$3 同形);短序列(<3 行)不判漂移", () => {
    expect(formulaTemplate("$A$2*$B$2")).toBe(formulaTemplate("$A$9*$B$9"));
    // 绝对/相对混用本身就是漂移信号(口径:只替换行号,不做规范化)
    expect(formulaTemplate("$A$2")).not.toBe(formulaTemplate("A3"));
    expect(formulaTemplate("ROUND(A2,2)+0.13")).toContain("0.13"); // 小数不被当行号
    expect(
      scanFormulaPatternDrift({
        name: "s",
        cells: [
          { ref: "C2", formula: "A2*B2" },
          { ref: "C3", formula: "A3*D3" },
        ],
      }),
    ).toHaveLength(0);
  });

  it("formulaCellsOf 从 worksheet XML 抽出带公式的单元格", () => {
    const xml = sheetXml(
      '<c r="C2"><f>A2*B2</f><v>2</v></c><c r="C3" t="s"><v>0</v></c><c r="C4"><f>SUM(A2:A3)</f></c>',
    );
    expect(formulaCellsOf(xml)).toEqual([
      { ref: "C2", formula: "A2*B2" },
      { ref: "C4", formula: "SUM(A2:A3)" },
    ]);
  });
});

describe("recalcWithSoffice: 三态不得含糊", () => {
  it("引擎不存在(spawn ENOENT)→ skipped,reason 写明未找到引擎", async () => {
    const res = await recalcWithSoffice(join(dir, "whatever.xlsx"), {
      run: async () => ({ ok: false, stdout: "", stderr: "spawn soffice ENOENT" }),
    });
    expect(res.status).toBe("skipped");
    expect(res.reason ?? "").toContain("soffice");
    expect((res.reason ?? "").length).toBeGreaterThan(0);
  });

  it("引擎在但退出非 0 → failed,reason 带 stderr 摘要(不得当 skipped/ok)", async () => {
    const res = await recalcWithSoffice(join(dir, "broken.xlsx"), {
      run: async () => ({ ok: false, stdout: "", stderr: "Error: source file could not be loaded" }),
    });
    expect(res.status).toBe("failed");
    expect(res.reason ?? "").toContain("source file could not be loaded");
  });

  it("重算成功且产出文件 → ok + outputPath 指向产物", async () => {
    const src = write("recalc-ok.xlsx", "fake-xlsx");
    const res = await recalcWithSoffice(src, {
      run: async (_cmd, args) => {
        const outdir = args[args.indexOf("--outdir") + 1] as string;
        writeFileSync(join(outdir, basename(src)), "recalculated");
        return { ok: true, stdout: "convert ok", stderr: "" };
      },
    });
    expect(res.status).toBe("ok");
    expect(res.outputPath).toBeTruthy();
    expect(readFileSync(res.outputPath as string, "utf8")).toBe("recalculated");
    rmSync(dirname(res.outputPath as string), { recursive: true, force: true });
  });

  it("命令返回成功但没产出文件 → failed(不把「没转换」说成 ok)", async () => {
    const src = write("recalc-nofile.xlsx", "fake-xlsx");
    const res = await recalcWithSoffice(src, { run: async () => ({ ok: true, stdout: "", stderr: "" }) });
    expect(res.status).toBe("failed");
    expect(res.reason ?? "").toContain("未产出");
  });
});

describe("scanChartGaps: 空图表", () => {
  it("引用区域全空 → 报;有值时 → 不报", () => {
    const charts = {
      "xl/charts/chart1.xml": '<chart><c:f>Sheet1!$B$2:$B$5</c:f></chart>',
      "xl/charts/chart2.xml": '<chart><c:f>Sheet1!$A$2:$A$5</c:f></chart>',
    };
    const emptySheets = { "xl/worksheets/sheet1.xml": sheetXml('<c r="D9"><v>7</v></c>') };
    expect(scanChartGaps(charts, emptySheets)).toEqual([
      { part: "xl/charts/chart1.xml", range: "Sheet1!$B$2:$B$5" },
      { part: "xl/charts/chart2.xml", range: "Sheet1!$A$2:$A$5" },
    ]);
    const filledSheets = {
      "xl/worksheets/sheet1.xml": sheetXml('<c r="A3"><v>7</v></c><c r="B4"><v>9</v></c>'),
    };
    expect(scanChartGaps(charts, filledSheets)).toHaveLength(0);
  });
});

describe("office-qa 接线:带错误值+漂移的 xlsx", () => {
  const DIRTY_CELLS =
    '<c r="A2"><v>1</v></c><c r="B2"><v>2</v></c><c r="C2"><f>A2*B2</f></c>' +
    '<c r="A3"><v>3</v></c><c r="B3"><v>4</v></c><c r="C3"><f>A3*B3</f></c>' +
    '<c r="A4"><v>5</v></c><c r="B4"><v>6</v></c><c r="C4"><f>A4*D4</f></c>' +
    '<c r="A5"><v>7</v></c><c r="B5"><v>8</v></c><c r="C5"><f>A5*B5</f></c>' +
    errCell("D1", "#REF!");

  it("formula-error(error)+formula-pattern-drift(warning)+recalc-skipped(warning),ok=false", async () => {
    const report = await checkOfficeArtifact(write("dirty.xlsx", await makeXlsx(DIRTY_CELLS)), {
      recalc: false,
    });
    const failed = report.findings.filter((f) => !f.passed);
    const err = failed.find((f) => f.code === "formula-error");
    expect(err?.severity).toBe("error");
    expect(err?.message).toContain("D1");
    expect(err?.message).toContain("#REF!");
    expect(err?.message).toContain("<c r=\"D1\""); // snippet 在场
    const drift = failed.find((f) => f.code === "formula-pattern-drift");
    expect(drift?.severity).toBe("warning");
    expect(drift?.message).toContain("C4");
    const skipped = failed.find((f) => f.code === "recalc-skipped");
    expect(skipped?.severity).toBe("warning");
    expect(skipped?.message).toContain("未重算");
    expect(report.ok).toBe(false);
  });

  it("--recalc=false 时干净 xlsx 仍出 recalc-skipped,但 error 数为 0 → ok 保持 true", async () => {
    const clean = write(
      "clean.xlsx",
      await makeXlsx('<c r="A1" t="s"><v>0</v></c><c r="B1"><v>12</v></c><c r="C1"><f>A1</f><v>3</v></c>'),
    );
    const report = await checkOfficeArtifact(clean, { recalc: false });
    const skipped = report.findings.find((f) => f.code === "recalc-skipped");
    expect(skipped?.passed).toBe(false);
    expect(skipped?.severity).toBe("warning");
    expect(report.findings.filter((f) => !f.passed && f.severity === "error")).toHaveLength(0);
    expect(report.ok).toBe(true);
  });
});
