/**
 * 办公去 AI 味持久层:抽取(md/txt/docx/pptx/xlsx)/ 坏件码 / root 白名单 / 原子落盘 /
 * ledger 幂等 / 坏台账容错 / 豁免 residual / 阈值覆盖 / 汇总报表。
 * 所有真实写盘一律在 os.tmpdir 下;输入工件用 jszip 现造。
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import {
  DEAI_STORE_CODES,
  DEAI_STORE_VERSION,
  artifactPathOf,
  buildReport,
  checkDocument,
  checkRoot,
  deaiDir,
  extractDocument,
  ledgerPathOf,
  readLedger,
} from "../src/office-deai-store";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const roots: string[] = [];

function makeRoot(tag = "genie-deai-"): string {
  const root = mkdtempSync(join(tmpdir(), tag));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root === undefined) continue;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
 /* 清理失败不影响断言 */
    }
  }
});

async function writeZip(file: string, entries: Record<string, string>): Promise<string> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
  return file;
}

function writeText(file: string, content: string): string {
  writeFileSync(file, content, "utf8");
  return file;
}

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** docx:一个普通段落 + 一个两格表格 + 一个尾段,全部走 w:t(表格文本夹在中间验证出现序)。 */
async function makeDocx(dir: string, name = "doc.docx"): Promise<string> {
  const body =
    "<w:p><w:r><w:t>第一段文本</w:t></w:r></w:p>" +
    "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格甲</w:t></w:r></w:p></w:tc>" +
    "<w:tc><w:p><w:r><w:t>表格乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl>" +
    "<w:p><w:r><w:t>尾段文本 &amp; 结束</w:t></w:r></w:p>";
  return writeZip(join(dir, name), {
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document ${W_NS}><w:body>${body}</w:body></w:document>`,
  });
}

/** pptx:故意用 slide2 + slide10,字典序会把 slide10 排前面,只有数字序才对。 */
async function makePptx(dir: string, name = "deck.pptx"): Promise<string> {
  const slide = (text: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody>` +
    `<a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  return writeZip(join(dir, name), {
    "ppt/slides/slide2.xml": slide("第二页文本"),
    "ppt/slides/slide10.xml": slide("第十页文本"),
  });
}

async function makeXlsx(dir: string, name = "sheet.xlsx", withShared = true): Promise<string> {
  const entries: Record<string, string> = {
    "xl/worksheets/sheet1.xml":
      '<?xml version="1.0" encoding="UTF-8"?><worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2"><v>42</v></c></row>' +
      "</sheetData></worksheet>",
  };
  if (withShared) {
    entries["xl/sharedStrings.xml"] =
      "<sst><si><t>共享甲</t></si><si><t>共享乙 &amp; 附加</t></si></sst>";
  }
  return writeZip(join(dir, name), entries);
}

async function makeInlineXlsx(dir: string, name = "inline.xlsx"): Promise<string> {
  return writeZip(join(dir, name), {
    "xl/worksheets/sheet1.xml":
      '<worksheet><sheetData><row r="1">' +
      '<c r="A1" t="inlineStr"><is><t>内联文本</t></is></c>' +
      '<c r="B1" t="str"><v>直写串</v></c>' +
      "</row></sheetData></worksheet>",
  });
}

/** 约 800 字的中性填充:不命中任何规则,用来把命中密度稀释到「分数不饱和」区间。 */
const FILLER = Array.from({ length: 36 }, (_, i) => `第${i + 1}段记录当日构建耗时与失败次数。`).join("");

function fillerDoc(dir: string, tail: string, name = "filler.txt"): string {
  return writeText(join(dir, name), `${FILLER}${tail}`);
}

describe("extractDocument:纯文本 / md", () => {
  it("md 抽取非空且 chars 等于文本长度", async () => {
    const dir = makeRoot();
    const content = "# 标题\n\n正文第一行。\n";
    const file = writeText(join(dir, "a.md"), content);
    const doc = await extractDocument(file);
    expect(doc.ok).toBe(true);
    expect(doc.code).toBe("DEAI_OK");
    expect(doc.kind).toBe("md");
    expect(doc.text).toBe(content);
    expect(doc.chars).toBe(content.length);
    expect(doc.hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("txt 抽取保留原文并给出 12 位 hash", async () => {
    const dir = makeRoot();
    const content = "第一行\n第二行\n";
    const file = writeText(join(dir, "b.txt"), content);
    const doc = await extractDocument(file);
    expect(doc.ok).toBe(true);
    expect(doc.kind).toBe("txt");
    expect(doc.chars).toBe(content.length);
    expect(doc.hash).toHaveLength(12);
  });

  it("同一内容两次抽取 hash 相同", async () => {
    const dir = makeRoot();
    const a = await extractDocument(writeText(join(dir, "x.txt"), "同样的字节"));
    const b = await extractDocument(writeText(join(dir, "y.txt"), "同样的字节"));
    expect(a.hash).toBe(b.hash);
  });
});

describe("extractDocument:docx", () => {
  it("抽取段落与表格文本(非空)", async () => {
    const dir = makeRoot();
    const doc = await extractDocument(await makeDocx(dir));
    expect(doc.ok).toBe(true);
    expect(doc.kind).toBe("docx");
    expect(doc.text).toContain("第一段文本");
    expect(doc.text).toContain("表格甲");
    expect(doc.text).toContain("表格乙");
    expect(doc.chars).toBe(doc.text.length);
  });

  it("按 document.xml 出现序排列(表格在中间)且解码 XML 实体", async () => {
    const dir = makeRoot();
    const doc = await extractDocument(await makeDocx(dir));
    const order = ["第一段文本", "表格甲", "表格乙", "尾段文本"].map((needle) => doc.text.indexOf(needle));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(doc.text).toContain("& 结束");
  });

  it("坏 zip 当 docx → DEAI_PARSE_FAILED 且不 throw", async () => {
    const dir = makeRoot();
    const file = writeText(join(dir, "bad.docx"), "这不是一个 zip 文件");
    await expect(extractDocument(file)).resolves.toMatchObject({ ok: false, code: "DEAI_PARSE_FAILED" });
  });

  it("docx 缺 word/document.xml → DEAI_PARSE_FAILED", async () => {
    const dir = makeRoot();
    const file = await writeZip(join(dir, "empty.docx"), { "word/other.xml": "<x/>" });
    const doc = await extractDocument(file);
    expect(doc.ok).toBe(false);
    expect(doc.code).toBe("DEAI_PARSE_FAILED");
  });
});

describe("extractDocument:pptx", () => {
  it("slide2/slide10 按数字升序(不进字典序坑)", async () => {
    const dir = makeRoot();
    const doc = await extractDocument(await makePptx(dir));
    expect(doc.ok).toBe(true);
    expect(doc.text.indexOf("第二页文本")).toBeLessThan(doc.text.indexOf("第十页文本"));
  });

  it("a:t 抽取非空", async () => {
    const dir = makeRoot();
    const doc = await extractDocument(await makePptx(dir));
    expect(doc.chars).toBeGreaterThan(0);
    expect(doc.text).toContain("第十页文本");
  });
});

describe("extractDocument:xlsx", () => {
  it("sharedStrings + t=\"s\" 引用取值正确", async () => {
    const dir = makeRoot();
    const doc = await extractDocument(await makeXlsx(dir));
    expect(doc.ok).toBe(true);
    expect(doc.text).toContain("共享甲");
    expect(doc.text).toContain("共享乙 & 附加");
    expect(doc.text).toContain("42");
  });

  it("inlineStr / t=\"str\" 也能抽", async () => {
    const dir = makeRoot();
    const doc = await extractDocument(await makeInlineXlsx(dir));
    expect(doc.ok).toBe(true);
    expect(doc.text).toContain("内联文本");
    expect(doc.text).toContain("直写串");
  });

  it("sharedStrings 缺失时不影响抽取(字符串单元格为空)", async () => {
    const dir = makeRoot();
    const doc = await extractDocument(await makeXlsx(dir, "no-shared.xlsx", false));
    expect(doc.ok).toBe(true);
    expect(doc.text).toContain("42");
    expect(doc.text).not.toContain("共享甲");
  });
});

describe("extractDocument:失败路径", () => {
  it("不存在的文件 → DEAI_READ_FAILED", async () => {
    const dir = makeRoot();
    const doc = await extractDocument(join(dir, "missing.md"));
    expect(doc.ok).toBe(false);
    expect(doc.code).toBe("DEAI_READ_FAILED");
    expect(doc.chars).toBe(0);
  });

  it("不支持的扩展名 → DEAI_UNSUPPORTED_KIND", async () => {
    const dir = makeRoot();
    const file = writeText(join(dir, "note.pdf"), "%PDF-1.4");
    const doc = await extractDocument(file);
    expect(doc.ok).toBe(false);
    expect(doc.code).toBe("DEAI_UNSUPPORTED_KIND");
  });

  it("稳定码表包含全部必需码", () => {
    for (const code of [
      "DEAI_OK",
      "DEAI_INVALID",
      "DEAI_ROOT_UNSAFE",
      "DEAI_READ_FAILED",
      "DEAI_PARSE_FAILED",
      "DEAI_STORE_FAILED",
      "DEAI_UNSUPPORTED_KIND",
    ]) {
      expect(DEAI_STORE_CODES).toContain(code);
    }
    expect(DEAI_STORE_VERSION).toBe(1);
  });
});

describe("checkRoot:临时目录白名单", () => {
  it("仓内路径 → DEAI_ROOT_UNSAFE", () => {
    const verdict = checkRoot(join(REPO_ROOT, ".genie", "deai-probe"));
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe("DEAI_ROOT_UNSAFE");
  });

  it("仓内 root 下 checkDocument 不写任何文件", async () => {
    const dir = makeRoot();
    const file = writeText(join(dir, "doc.txt"), "正文");
    const root = join(REPO_ROOT, ".genie", `deai-probe-${process.pid}-${Date.now()}`);
    const outcome = await checkDocument(root, file);
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("DEAI_ROOT_UNSAFE");
    expect(existsSync(join(root, ".genie", "office", "deai"))).toBe(false);
    expect(existsSync(root)).toBe(false);
  });

  it("tmpdir 下 → ok,且 /tmpfoo 不算 /tmp", () => {
    expect(checkRoot(makeRoot()).ok).toBe(true);
    const tricky = checkRoot("/tmpfoo-deai-probe");
    expect(tricky.ok).toBe(false);
    expect(tricky.code).toBe("DEAI_ROOT_UNSAFE");
  });
});

describe("checkDocument:落盘与幂等", () => {
  it("首跑写 artifact + ledger 1 行,appended=true", async () => {
    const dir = makeRoot();
    const root = makeRoot();
    const file = fillerDoc(dir, "这里赋能全行业。", "one.txt");
    const outcome = await checkDocument(root, file);
    expect(outcome.ok).toBe(true);
    expect(outcome.appended).toBe(true);
    expect(outcome.artifactPath).toBe(artifactPathOf(root, outcome.hash));
    expect(existsSync(outcome.artifactPath ?? "")).toBe(true);
    const lines = readFileSync(ledgerPathOf(root), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  it("首跑后目录内没有 .tmp 残留", async () => {
    const dir = makeRoot();
    const root = makeRoot();
    await checkDocument(root, fillerDoc(dir, "赋能全行业。"));
    const dirty = readdirSync(deaiDir(root)).filter((name) => /\.tmp/.test(name));
    expect(dirty).toEqual([]);
  });

  it("同文件再跑 appended=false 且 ledger 仍 1 行", async () => {
    const dir = makeRoot();
    const root = makeRoot();
    const file = fillerDoc(dir, "赋能全行业。", "same.txt");
    const first = await checkDocument(root, file);
    const second = await checkDocument(root, file);
    expect(first.appended).toBe(true);
    expect(second.appended).toBe(false);
    expect(second.hash).toBe(first.hash);
    const lines = readFileSync(ledgerPathOf(root), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  it("再跑后目录内同样没有 .tmp 残留", async () => {
    const dir = makeRoot();
    const root = makeRoot();
    const file = fillerDoc(dir, "赋能全行业。", "again.txt");
    await checkDocument(root, file);
    await checkDocument(root, file);
    expect(readdirSync(deaiDir(root)).filter((name) => /\.tmp/.test(name))).toEqual([]);
  });

  it("artifact 每行可 JSON.parse、hash 文件名 12 位、内容可序列化", async () => {
    const dir = makeRoot();
    const root = makeRoot();
    const file = fillerDoc(dir, "赋能全行业。", "art.txt");
    await checkDocument(root, file);
    const names = readdirSync(deaiDir(root)).filter((name) => name.endsWith(".json"));
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[0-9a-f]{12}\.json$/);
    const artifact = JSON.parse(readFileSync(join(deaiDir(root), names[0] ?? ""), "utf8")) as {
      hash: string;
      findings: unknown[];
      stats: unknown;
      audit: unknown;
    };
    expect(artifact.hash).toBe((names[0] ?? "").slice(0, 12));
    expect(Array.isArray(artifact.findings)).toBe(true);
    expect(artifact.stats).toBeTruthy();
    expect(artifact.audit).toBeTruthy();
    expect(JSON.stringify(artifact).length).toBeGreaterThan(0);
  });

  it("审计不改动输入文件(字节不变)", async () => {
    const dir = makeRoot();
    const root = makeRoot();
    const file = fillerDoc(dir, "赋能全行业。", "readonly.txt");
    const before = readFileSync(file);
    await checkDocument(root, file);
    expect(readFileSync(file).equals(before)).toBe(true);
  });
});

describe("readLedger / buildReport", () => {
  it("ledger.jsonl 每行可 JSON.parse 且 parseErrors=0", async () => {
    const dir = makeRoot();
    const root = makeRoot();
    await checkDocument(root, fillerDoc(dir, "赋能全行业。", "l1.txt"));
    await checkDocument(root, fillerDoc(dir, "首先其次再者。", "l2.txt"));
    const raw = readFileSync(ledgerPathOf(root), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { hash: string; score: number; topRules: unknown[]; codes: string[] };
      expect(parsed.hash).toHaveLength(12);
      expect(typeof parsed.score).toBe("number");
      expect(Array.isArray(parsed.topRules)).toBe(true);
      expect(Array.isArray(parsed.codes)).toBe(true);
    }
    const ledger = await readLedger(root);
    expect(ledger.ok).toBe(true);
    expect(ledger.parseErrors).toBe(0);
    expect(ledger.entries).toHaveLength(2);
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("坏台账行 → parseErrors≥1 且不 throw", async () => {
    const dir = makeRoot();
    const root = makeRoot();
    await checkDocument(root, fillerDoc(dir, "赋能全行业。", "good.txt"));
    const ledgerFile = ledgerPathOf(root);
    writeFileSync(ledgerFile, `${readFileSync(ledgerFile, "utf8")}{ 这一行不是 JSON\n`, "utf8");
    const ledger = await readLedger(root);
    expect(ledger.ok).toBe(true);
    expect(ledger.parseErrors).toBeGreaterThanOrEqual(1);
    expect(ledger.entries.length).toBeGreaterThanOrEqual(1);
  });

  it("空 root(无台账)readLedger 返回空且 ok", async () => {
    const root = makeRoot();
    mkdirSync(root, { recursive: true });
    const ledger = await readLedger(root);
    expect(ledger.ok).toBe(true);
    expect(ledger.entries).toEqual([]);
    expect(ledger.parseErrors).toBe(0);
  });

  it("buildReport 的 files/scores/verdicts/topRules 与 ledger 行数一致", async () => {
    const dir = makeRoot();
    const root = makeRoot();
    await checkDocument(root, fillerDoc(dir, "我们在当今数字化时代赋能全行业的闭环抓手。", "r1.txt"));
    await checkDocument(root, fillerDoc(dir, "首先需要说明其次再给结论。", "r2.txt"));
    const ledger = await readLedger(root);
    const report = await buildReport(root);
    expect(report.ok).toBe(true);
    expect(report.files).toBe(ledger.entries.length);
    expect(report.scores).toHaveLength(ledger.entries.length);
    expect(report.verdicts.pass + report.verdicts.warn + report.verdicts.fail).toBe(ledger.entries.length);
    expect(report.rulesVersion).toBe(ledger.entries[0]?.rulesVersion);
    expect(report.topRules.length).toBeLessThanOrEqual(5);
    expect(report.parseErrors).toBe(0);
    for (const rule of report.topRules) expect(rule.count).toBeGreaterThan(0);
  });
});

describe("豁免与阈值", () => {
  it("exemptions 生效时 residualScore < score 且台账记 residual", async () => {
    const dir = makeRoot();
    const root = makeRoot();
    const file = fillerDoc(dir, "这里赋能一次,那里赋能两次,还要赋能三次。", "exempt.txt");
    const plain = await checkDocument(root, file);
    expect(plain.residualScore).toBeUndefined();
    const artifact = JSON.parse(readFileSync(plain.artifactPath ?? "", "utf8")) as {
      findings: { ruleId: string; excerpt: string }[];
    };
    const first = artifact.findings[0];
    expect(first).toBeTruthy();
    const exempted = await checkDocument(root, file, {
      exemptions: [{ ruleId: first?.ruleId, excerpt: first?.excerpt, reason: "行业术语,已与业务核对" }],
    });
    expect(exempted.ok).toBe(true);
    expect(typeof exempted.residualScore).toBe("number");
    expect(exempted.residualScore ?? 0).toBeLessThan(exempted.score);
    expect(exempted.verdict).toBe(exempted.residualVerdict);
    expect(exempted.appended).toBe(false);
    const ledger = await readLedger(root);
    expect(ledger.entries).toHaveLength(1);
  });

  it("threshold 覆盖 failThreshold:同一文档不同 threshold 得不同 verdict", async () => {
    const dir = makeRoot();
    const rootA = makeRoot();
    const rootB = makeRoot();
    const file = fillerDoc(dir, "首先需要说明,其次再给结论,最后收尾。", "threshold.txt");
    const loose = await checkDocument(rootA, file, { threshold: 95 });
    const strict = await checkDocument(rootB, file, { threshold: 10 });
    expect(loose.ok).toBe(true);
    expect(strict.ok).toBe(true);
    expect(loose.score).toBe(strict.score);
    expect(loose.verdict).not.toBe(strict.verdict);
    const ledgerStrict = await readLedger(rootB);
    expect(ledgerStrict.entries[0]?.failThreshold).toBe(10);
    expect(Number(ledgerStrict.entries[0]?.warnThreshold)).toBeLessThan(10);
  });
});
