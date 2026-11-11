#!/usr/bin/env -S npx tsx
/**
 * 办公文档可寻址契约 CLI(node --experimental-strip-types / tsx 均可直跑)。
 * 为什么要有 CLI:可寻址契约的价值在「能进 CI 当门禁」——退出码是唯一不会被人忽略的输出。
 * 退出码契约(互斥且必须区分):
 * 0 = TOC 与正文一致,锚点(若给)唯一命中
 * 2 = TOC 漂移(缺/多/序/重/越界/off-by-one)或锚点 AMBIGUOUS / NOT_FOUND
 * 1 = 参数 / 读取错误(或锚点 INVALID:这轮判断不成立,不能当成通过)
 * 把「读不到文件」混进 0 会让门禁永久放行,混进 2 会让人以为是文档问题。
 * 用法:
 * --file <deck.md|txt> [--anchor <p3/第3页/...>] [--json] [--report]
 * [--levels 2,3] [--require-toc] [--help]
 * 只读:本 CLI 不写任何文件(off-by-one 只给修正建议,不改原稿)。
 */
import { readFile } from "node:fs/promises";
import process from "node:process";
import {
  OFFICE_ANCHOR_VERSION,
  extractHeadings,
  parseTocDocument,
  resolveAnchor,
  validateToc,
} from "../packages/harness-runtime/src/agent/office-anchor.ts";
import type { AnchorResolution } from "../packages/harness-runtime/src/agent/office-anchor.ts";

interface CliOptions {
  file: string | null;
  anchor: string | null;
  json: boolean;
  report: boolean;
  levels: number[];
  requireToc: boolean;
  help: boolean;
}

const USAGE = `office-anchor v${OFFICE_ANCHOR_VERSION} — 办公文档可寻址契约 CLI

用法:
  office-anchor --file <deck.md|txt> [--anchor <p3|第3页|slide 3|标题>] [--json] [--report]
                [--levels 2,3] [--require-toc]

参数:
  --file, -f <path>   要体检的 deck.md / 文本(必填)
  --anchor, -a <raw>  额外做锚点解析:1-based 页码或标题文本
  --json              输出机器可读 JSON
  --report            附加一行结论
  --levels <list>     参与标题编号的标题层级(缺省 2,3)
  --require-toc       空目录也判 TOC_DRIFT(missing-toc)
  --help, -h          显示本帮助

退出码:0 = 全通过;2 = TOC 漂移 / 锚点歧义 / 未找到;1 = 参数或读取错误`;

function parseArgs(argv: readonly string[]): { ok: boolean; options: CliOptions; error?: string } {
  const options: CliOptions = {
    file: null,
    anchor: null,
    json: false,
    report: false,
    levels: [2, 3],
    requireToc: false,
    help: false,
  };
  let error: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    const take = (): string | null => {
      const value = argv[i + 1];
      if (value === undefined) {
        error = `参数 ${arg} 缺少值`;
        return null;
      }
      i += 1;
      return value;
    };

    if (arg === "--file" || arg === "-f") {
      const value = take();
      if (value !== null) options.file = value;
    } else if (arg === "--anchor" || arg === "-a") {
      const value = take();
      if (value !== null) options.anchor = value;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--report") {
      options.report = true;
    } else if (arg === "--require-toc") {
      options.requireToc = true;
    } else if (arg === "--levels") {
      const value = take();
      if (value !== null) {
        const levels = value
          .split(",")
          .map((part) => Number(part.trim()))
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= 6);
        if (levels.length === 0) error = `--levels 需要 1..6 的数字列表,收到:${value}`;
        else options.levels = levels;
      }
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      error = `未知参数:${arg}`;
    }

    if (error) break;
  }

  if (error) return { ok: false, options, error };
  if (options.help) return { ok: true, options };
  if (!options.file) return { ok: false, options, error: "缺少 --file <path>" };
  return { ok: true, options };
}

function renderIssues(issues: ReturnType<typeof validateToc>["issues"]): string[] {
  return issues.map((issue) => {
    const kind = issue.kind ? `/${issue.kind}` : "";
    const title = issue.title ? `「${issue.title}」` : "";
    const suggestion = issue.suggestion ? ` → ${issue.suggestion}` : "";
    return `  - [${issue.code}${kind}] ${title}${issue.message}${suggestion}`;
  });
}

function renderAnchor(anchor: AnchorResolution): string[] {
  const lines: string[] = [];
  const hit = anchor.candidates[0];
  lines.push(
    `锚点: ${anchor.query} → ${anchor.code}` +
      (anchor.ok ? ` index=${anchor.index}「${hit?.text ?? ""}」` : ""),
  );
  for (const candidate of anchor.candidates) {
    lines.push(
      `  · #${candidate.index} ${candidate.match} score=${candidate.score} ${candidate.text}`,
    );
  }
  return lines;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error ?? "参数错误");
    console.error(USAGE);
    return 1;
  }
  const options = parsed.options;
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const file = options.file as string;
  let markdown: string;
  try {
    markdown = await readFile(file, "utf8");
  } catch (error) {
    console.error(`读取失败:${file}:${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const headings = extractHeadings(markdown, { levels: options.levels });
  const tocDoc = parseTocDocument(markdown);
  const validation = validateToc(tocDoc.entries, headings, { requireToc: options.requireToc });
  const anchor = options.anchor === null ? null : resolveAnchor(headings, options.anchor);
  const anchorInvalid = anchor !== null && anchor.code === "INVALID";
  const exitCode = anchorInvalid ? 1 : validation.ok && (anchor === null || anchor.ok) ? 0 : 2;

  if (options.json) {
    const payload = {
      version: OFFICE_ANCHOR_VERSION,
      file,
      levels: options.levels,
      headings: { count: headings.length, list: headings },
      toc: {
        declared: tocDoc.declared,
        headingLine: tocDoc.headingLine,
        count: tocDoc.entries.length,
        entries: tocDoc.entries,
      },
      validation: {
        ok: validation.ok,
        offByOne: validation.offByOne,
        issues: validation.issues,
        matched: validation.matched,
      },
      ...(anchor === null
        ? {}
        : {
            anchor: {
              query: anchor.query,
              ok: anchor.ok,
              code: anchor.code,
              index: anchor.index,
              kind: anchor.anchor.kind,
              candidates: anchor.candidates,
            },
          }),
      exitCode,
    };
    console.log(JSON.stringify(payload, null, 2));
  } else {
    const lines: string[] = [];
    lines.push(`office-anchor v${OFFICE_ANCHOR_VERSION}`);
    lines.push(`文件:${file}`);
    lines.push(`标题:${headings.length} 条(level ${options.levels.join(",")})`);
    lines.push(
      `目录:${
        tocDoc.declared
          ? `${tocDoc.entries.length} 条(目录节第 ${tocDoc.headingLine ?? 0} 行)`
          : "未声明(0 条)"
      }`,
    );
    lines.push(
      `validateToc:${validation.ok ? "PASS" : `FAIL(${validation.issues.length} 个问题)`}`,
    );
    lines.push(...renderIssues(validation.issues));
    if (validation.offByOne !== null) lines.push(`off-by-one:整体相差 ${validation.offByOne}`);
    if (anchor !== null) lines.push(...renderAnchor(anchor));
    if (options.report) {
      lines.push(
        `结论:${
          exitCode === 0 ? "PASS" : exitCode === 2 ? "DRIFT_OR_AMBIGUOUS" : "INVALID_OR_READ_ERROR"
        }`,
      );
    }
    console.log(lines.join("\n"));
  }

  return exitCode;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`未预期错误:${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
