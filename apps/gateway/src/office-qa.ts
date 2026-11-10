/**
 * 产物 QA 合约:把「质量门只写在提示词里」变成可执行 checker。
 * 为什么要有这一层:提示词里的「请检查页数/禁用占位符/别导出空文件」对模型没有约束力,
 * 产物到底合不合格只有拿到二进制才能判断。这里对 .pptx/.docx/.xlsx 做只读体检,
 * 每类问题给稳定 code + severity + remediation,并保证 **checker 自身崩溃绝不算通过**
 * (内部异常转成 error finding `checker-crash`)。
 * 对外契约(scripts/office-qa.mts 依赖):
 *   checkOfficeArtifact(absPath) -> { ok, findings[] },ok = 没有 error 级失败项。
 * 检查项(每项一条 finding,passed 表示该项是否满足):
 *   - unsupported-ext  扩展名不是 .pptx/.docx/.xlsx
 *   - io-error         文件读不出来
 *   - empty-file       0 字节
 *   - artifact-too-large / artifact-large  体积超上限(上限复用 office-ooxml 的 OFFICE_MAX_BYTES)
 *   - invalid-zip      zip/OOXML 包解不开
 *   - missing-part     缺必需部件(pptx: ppt/presentation.xml;docx: word/document.xml;xlsx: xl/workbook.xml)
 *   - xml-parse-error  XML 标签不闭合/无法解析
 *   - empty-content    包内没有非空文本节点
 *   - placeholder-residue  TODO / {{…}} / [待填] / lorem ipsum 等占位残留
 *   - formula-error      xlsx:单元格缓存值/公式里出现 7 类 Excel 错误码(每条带 cell/snippet)
 *   - formula-pattern-drift xlsx:同列连续 ≥3 行公式应同形,个别偏离给 warning
 *   - chart-empty        xlsx:图表引用区域全空(导出的空图)
 *   - recalc-skipped     xlsx:没重算(引擎缺失或未开 --recalc);明确「未重算」,绝不声称干净
 *   - recalc-failed      xlsx:重算跑了但失败(超时/非零退出/没产出),按 error 计
 *   - checker-crash    检查器内部异常(不得视为通过)
 */
import { readFile, rm } from "node:fs/promises";
import { dirname, extname } from "node:path";
import JSZip from "jszip";
import { OFFICE_MAX_BYTES } from "./office-ooxml.js";
import {
  formulaCellsOf,
  recalcWithSoffice,
  scanChartGaps,
  scanFormulaErrors,
  scanFormulaPatternDrift,
} from "./xlsx-recalc.js";

export type QaSeverity = "error" | "warning";

export interface QaFinding {
  /** 稳定 code(同一类问题永远同一个 code,便于 CI/脚本按 code 处理)。 */
  code: string;
  /** 人类可读的检查项名称。 */
  name: string;
  /** 该项是否满足。 */
  passed: boolean;
  severity: QaSeverity;
  message: string;
  /** 不满足时怎么改;通过时为空串。 */
  remediation: string;
}

export interface QaReport {
  ok: boolean;
  findings: QaFinding[];
}

/** 超过这个体积给 warning(不影响 ok):大课件传输/预览都会明显变慢。 */
const QA_LARGE_BYTES = 20 * 1024 * 1024;

/** 各扩展名的必需部件(缺了就是包不完整,不是「风格问题」)。 */
const REQUIRED_PART: Record<string, string> = {
  ".pptx": "ppt/presentation.xml",
  ".docx": "word/document.xml",
  ".xlsx": "xl/workbook.xml",
};

/** 正文文本所在的 part 白名单(只在正文里查占位/空内容,不扫 styles/theme,避免误报)。 */
const TEXT_PART_RES: Record<string, RegExp[]> = {
  ".pptx": [/^ppt\/slides\/[^/]+\.xml$/, /^ppt\/notesSlides\/[^/]+\.xml$/],
  ".docx": [
    /^word\/document\.xml$/,
    /^word\/header\d*\.xml$/,
    /^word\/footer\d*\.xml$/,
    /^word\/footnotes\.xml$/,
    /^word\/endnotes\.xml$/,
  ],
  ".xlsx": [/^xl\/sharedStrings\.xml$/, /^xl\/worksheets\/[^/]+\.xml$/],
};

/** 占位文本模式(至少覆盖 TODO / {{…}} / [待填] / lorem ipsum)。 */
const PLACEHOLDER_RES: Array<{ re: RegExp; label: string }> = [
  { re: /\bTODO\b/i, label: "TODO" },
  { re: /\bTBD\b/i, label: "TBD" },
  { re: /\bFIXME\b/i, label: "FIXME" },
  { re: /\bXXX\b/, label: "XXX" },
  { re: /lorem\s+ipsum/i, label: "lorem ipsum" },
  { re: /\{\{[^}]*\}\}/, label: "{{…}}" },
  { re: /\[待填\]/, label: "[待填]" },
  { re: /待(?:填写|补充|定)/, label: "待填写/补充/定" },
  { re: /请填写/, label: "请填写" },
];

/** 体检入口:按扩展名分派;任何内部异常都转成 error finding,绝不当通过。
 *  opts.recalc 只对 .xlsx 生效:为 true 时尝试用 soffice 真重算(公式没有缓存值也能拿到真值)。 */
export async function checkOfficeArtifact(
  absPath: string,
  opts: { recalc?: boolean } = {},
): Promise<QaReport> {
  const findings: QaFinding[] = [];
  const emit = (
    code: string,
    name: string,
    passed: boolean,
    severity: QaSeverity,
    message: string,
    remediation: string): void => {
    findings.push({ code, name, passed, severity, message, remediation: passed ? "" : remediation });
  };

  try {
    // String() 放在 try 内:畸形入参(toString 抛错)也走 checker-crash,不静默放行。
    const ext = extname(String(absPath ?? "")).toLowerCase();
    if (!(ext in REQUIRED_PART)) {
      emit(
        "unsupported-ext",
        "产物类型",
        false,
        "error",
        `不支持的产物类型: ${ext || "(无扩展名)"}(仅 .pptx/.docx/.xlsx)`,
        "把产物导出为 .pptx/.docx/.xlsx 后再检测",
      );
      return { ok: false, findings };
    }

    let buf: Buffer;
    try {
      buf = await readFile(absPath);
    } catch (err) {
      emit("io-error", "文件可读", false, "error", `读取文件失败: ${msgOf(err)}`, "确认路径存在且当前进程有读权限");
      return { ok: false, findings };
    }
    if (buf.length === 0) {
      emit("empty-file", "非空文件", false, "error", "文件为 0 字节", "重新生成产物(0 字节通常是导出失败)");
      return { ok: false, findings };
    }

    // 体积:超上限直接阻断(office-ooxml 解析器同样会拒),大文件另给 warning 提示。
    if (buf.length > OFFICE_MAX_BYTES) {
      emit(
        "artifact-too-large",
        "体积上限",
        false,
        "error",
        `${mb(buf.length)} 超过上限 ${mb(OFFICE_MAX_BYTES)}`,
        "压缩图片/拆分文件/降低嵌入分辨率后重新导出",
      );
      return { ok: false, findings };
    }
    emit("artifact-too-large", "体积上限", true, "error", `${mb(buf.length)} ≤ ${mb(OFFICE_MAX_BYTES)}`, "");
    if (buf.length > QA_LARGE_BYTES) {
      emit(
        "artifact-large",
        "体积提示",
        false,
        "warning",
        `${mb(buf.length)} 超过 ${mb(QA_LARGE_BYTES)},传输/预览会明显变慢`,
        "能压则压(图片降采样、去掉未用母版)",
      );
    } else {
      emit("artifact-large", "体积提示", true, "warning", `${mb(buf.length)} ≤ ${mb(QA_LARGE_BYTES)}`, "");
    }

    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(buf);
    } catch (err) {
      emit(
        "invalid-zip",
        "ZIP 完整性",
        false,
        "error",
        `不是有效的 zip/OOXML 包: ${msgOf(err)}`,
        "按 OOXML 规范重新导出(扩展名与实际格式要一致)",
      );
      return { ok: false, findings };
    }
    emit("invalid-zip", "ZIP 完整性", true, "error", "zip 可解包", "");

    const required = REQUIRED_PART[ext] as string;
    const hasRequired = Boolean(zip.file(required));
    emit(
      "missing-part",
      "必需部件",
      hasRequired,
      "error",
      hasRequired ? `含必需部件 ${required}` : `缺少必需部件 ${required}`,
      `用标准 Office/WPS/pptxgenjs 导出 ${ext};缺 ${required} 说明包不完整`,
    );

    // XML 完整性:逐個 .xml/.rels 做标签配对扫描(不引 XML 解析器,够抓截断/坏蛋包)。
    const xmlBad: string[] = [];
    for (const name of Object.keys(zip.files).filter((n) => /\.(xml|rels)$/i.test(n)).slice(0, 400)) {
      const f = zip.file(name);
      if (!f) continue;
      const issue = xmlIssue(await f.async("string"));
      if (issue) xmlBad.push(`${name}: ${issue}`);
      if (xmlBad.length >= 3) break;
    }
    emit(
      "xml-parse-error",
      "XML 完整性",
      xmlBad.length === 0,
      "error",
      xmlBad.length === 0 ? "XML 标签配对正常" : `XML 解析失败: ${xmlBad.join("; ")}`,
      "重新导出产物;手工改过 XML 的话先修好标签闭合与转义",
    );

    // 正文文本:一次性收集,供「空内容」与「占位残留」两项复用。
    const parts: Array<{ part: string; text: string }> = [];
    const textRes = TEXT_PART_RES[ext] as RegExp[];
    for (const name of Object.keys(zip.files)) {
      if (!textRes.some((re) => re.test(name))) continue;
      const f = zip.file(name);
      if (!f) continue;
      const xml = await f.async("string");
      parts.push({ part: name, text: plainText(xml) });
    }
    const nonEmpty = parts.filter((p) => p.text.trim());
    const totalChars = nonEmpty.reduce((n, p) => n + p.text.trim().length, 0);
    emit(
      "empty-content",
      "内容非空",
      totalChars > 0,
      "error",
      totalChars > 0 ? `${nonEmpty.length} 个文本部件共 ${totalChars} 字` : "包内没有非空文本节点",
      "补正文内容后重新导出;只有样式/图形没有文字通常意味着导出不完整",
    );

    const hits: string[] = [];
    for (const { part, text } of parts) {
      for (const { re, label } of PLACEHOLDER_RES) {
        const m = re.exec(text);
        if (m) hits.push(`${part} → ${label}${snippet(text, m.index)}`);
        if (hits.length >= 3) break;
      }
      if (hits.length >= 3) break;
    }
    emit(
      "placeholder-residue",
      "占位文本",
      hits.length === 0,
      "error",
      hits.length === 0 ? "未发现占位残留" : `发现占位残留: ${hits.join("; ")}`,
      "把 TODO/{{…}}/[待填]/lorem ipsum 等替换成真实文案",
    );

 // ---- xlsx 计算真值链:错误值 / 公式漂移 / 空图表 / 重算真值 ----
    if (ext === ".xlsx") {
      const { sheets, charts } = await collectXlsxParts(zip);
      const formulaCells = Object.entries(sheets).flatMap(([name, xml]) =>
        formulaCellsOf(xml).map((c) => ({ ...c, sheet: name })),
      );
      const hasCachedValues = Object.values(sheets).some((xml) => /<v(?:\s[^>]*)?>/.test(xml));

      const errors = scanFormulaErrors(sheets);
      if (errors.length > 0) {
        for (const hit of errors.slice(0, 10)) {
          emit(
            "formula-error",
            "公式错误值",
            false,
            "error",
            `${hit.cell} 计算结果为 ${hit.code}(${hit.sheet}) ${hit.snippet}`,
            "修掉失效引用/类型不符/除零后重新导出,并确认该格带缓存值",
          );
        }
        if (errors.length > 10) {
          emit("formula-error", "公式错误值", false, "error", `另有 ${errors.length - 10} 处错误值未逐条列出`, "批量修完再跑一次 QA");
        }
      } else if (hasCachedValues) {
        emit("formula-error", "公式错误值", true, "error", "已有缓存值里没有 #REF!/#VALUE! 等错误值", "");
      }
      // 公式有值但一格缓存值都没有 = 「没算过」,这一项不算通过:交给下面的 recalc 分支明说。

      const drifts = Object.entries(sheets).flatMap(([name, xml]) =>
        scanFormulaPatternDrift({ name, cells: formulaCellsOf(xml) }),
      );
      for (const d of drifts.slice(0, 10)) {
        emit(
          "formula-pattern-drift",
          "公式同列一致性",
          false,
          "warning",
          `${d.ref}(列 ${d.column})与同列模板不符:期望 ${d.expected},实际 ${d.actual}`,
          "整列统一向下填充,避免个别行引用错列/漏行",
        );
      }

      for (const gap of scanChartGaps(charts, sheets).slice(0, 5)) {
        emit(
          "chart-empty",
          "图表数据区",
          false,
          "warning",
          `${gap.part} 引用区域 ${gap.range} 全空`,
          "补数据或修正图表引用范围,否则导出的是空图",
        );
      }

      if (opts.recalc) {
        const rc = await recalcWithSoffice(absPath);
        if (rc.status === "skipped") {
          emit(
            "recalc-skipped",
            "重算",
            false,
            "warning",
            `未重算:${rc.reason ?? "没有可用重算引擎"}`,
            "安装 LibreOffice(soffice)后重跑,或换有重算引擎的机器",
          );
        } else if (rc.status === "failed" || !rc.outputPath) {
          emit(
            "recalc-failed",
            "重算",
            false,
            "error",
            `重算失败:${rc.reason ?? "未产出文件"}`,
            "检查 soffice 能否正常退出与临时目录可写;未重算时公式可能只是「看起来对」",
          );
        } else {
          const outPath = rc.outputPath;
          try {
            const outZip = await JSZip.loadAsync(await readFile(outPath));
            const recalcErrors = scanFormulaErrors((await collectXlsxParts(outZip)).sheets);
            const before = new Set(errors.map((e) => `${e.cell}|${e.code}`));
            if (recalcErrors.length === 0) {
              emit("formula-error", "公式错误值", true, "error", `重算完成,${formulaCells.length} 个公式均无错误值`, "");
            }
            for (const hit of recalcErrors) {
              if (before.has(`${hit.cell}|${hit.code}`)) continue; // 原文件已报过,不重复
              emit(
                "formula-error",
                "公式错误值",
                false,
                "error",
                `${hit.cell} 重算后为 ${hit.code}(${hit.sheet}) ${hit.snippet}`,
                "修掉该格的引用/类型/除零问题后重新导出",
              );
            }
          } catch (err) {
            emit("recalc-failed", "重算", false, "error", `重算产物读不出来: ${msgOf(err)}`, "检查临时目录权限;本次不计为「重算通过」");
          } finally {
            await rm(dirname(outPath), { recursive: true, force: true }).catch(() => {});
          }
        }
      } else {
        const why =
          formulaCells.length > 0 && !hasCachedValues
            ? `${formulaCells.length} 个公式没有缓存值,未重算前无法判断计算是否报错`
            : "未执行重算引擎,只检查了已有缓存值";
        emit("recalc-skipped", "重算", false, "warning", `未重算:${why}`, "加 --recalc 或安装 LibreOffice(soffice)后复核");
      }
    }
  } catch (err) {
    // 最后一道保险:任何未归类的内部异常都必须变成 error finding(脚本崩溃不得被当通过)。
    findings.push({
      code: "checker-crash",
      name: "检查器执行",
      passed: false,
      severity: "error",
      message: `检查器内部异常: ${msgOf(err)}(异常不得视为通过)`,
      remediation: "这是检查器 bug 或畸形输入:保留该文件与堆栈反馈维护者;本次结果不计为通过",
    });
  }

  const ok = !findings.some((f) => !f.passed && f.severity === "error");
  return { ok, findings };
}

/** 取 xlsx 包里的 worksheet 与 chart XML(部件路径 → 文本);不做 file→sheet 名映射以免猜错。 */
async function collectXlsxParts(
  zip: JSZip): Promise<{ sheets: Record<string, string>; charts: Record<string, string> }> {
  const sheets: Record<string, string> = {};
  const charts: Record<string, string> = {};
  for (const name of Object.keys(zip.files)) {
    const isSheet = /^xl\/worksheets\/[^/]+\.xml$/.test(name);
    const isChart = /^xl\/charts\/[^/]+\.xml$/.test(name);
    if (!isSheet && !isChart) continue;
    const f = zip.file(name);
    if (!f) continue;
    const xml = await f.async("string");
    if (isSheet) sheets[name] = xml;
    else charts[name] = xml;
  }
  return { sheets, charts };
}

/** 收集 OOXML 正文文本节点(a:t / w:t / t),供空内容与占位检查。 */
function plainText(xml: string): string {
  const out: string[] = [];
  const re = /<(a:t|w:t|t)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(unescapeXml(m[2] ?? ""));
  return out.join("\n");
}

/** 轻量 XML 标签配对检查:返回问题描述,正常返回 null。 */
function xmlIssue(xml: string): string | null {
  const s = xml
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "");
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const between = s.slice(last, m.index);
    if (between.includes("<")) return "存在无法解析的 '<'";
    last = re.lastIndex;
    const closing = m[1] === "/";
    const name = m[2] as string;
    const selfClose = m[4] === "/";
    if (closing) {
      const open = stack.pop();
      if (open !== name) return open ? `标签未正确闭合(<${open}> 与 </${name}>)` : `多余的结束标签 </${name}>`;
    } else if (!selfClose) {
      stack.push(name);
    }
  }
  if (s.slice(last).includes("<")) return "存在无法解析的 '<'";
  if (stack.length) return `未闭合标签 <${stack[stack.length - 1]}>`;
  return null;
}

function unescapeXml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (all, ent: string) => {
    if (ent === "amp") return "&";
    if (ent === "lt") return "<";
    if (ent === "gt") return ">";
    if (ent === "quot") return '"';
    if (ent === "apos") return "'";
    const code = ent.startsWith("#x") ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
    try {
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    } catch {
      return all;
    }
  });
}

function snippet(text: string, at: number): string {
  const start = Math.max(0, at - 12);
  return `(…${text.slice(start, Math.min(text.length, at + 24)).replace(/\s+/g, " ")}…)`;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
