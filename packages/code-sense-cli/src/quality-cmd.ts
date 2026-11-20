/**
 * `codesense quality` 薄壳(确定性质量门 CLI 层):加载索引 → computeQuality → 文本/JSON 输出。
 * 分层纪律:指标全部在 `@lampgenie/code-sense/world/quality`(纯函数,可单测),
 * 本文件只做「root 解析 / 索引就绪 / --json 与 --gate 出口」三件事,零指标逻辑。
 * dispatch 由 cli.ts 接线(本文件不改 cli.ts)。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeQuality, renderQualityReport, type QualityReport } from "@lampgenie/code-sense/world/quality";
import { resolveContext } from "./query.js";

export interface QualityCmdOptions {
  root?: string;
  json?: boolean;
 /** !pass.all 时 exit 1(硬门)。 */
  gate?: boolean;
 /** 契约面配对对账(默认关:代价/噪声)。 */
  surface?: boolean;
 /** 文档文件:内容作为 docText 做 `路径:行号` 确定性校验。 */
  doc?: string;
  quiet?: boolean;
}

/** 退出码:0=正常(或无门失败)/1=--gate 且未通过/2=索引未就绪或 doc 文件缺失。 */
export async function qualityCmd(opts: QualityCmdOptions): Promise<number> {
  const ctx = await resolveContext({ root: opts.root, quiet: opts.quiet });
  if (!opts.quiet) for (const n of ctx.notes) process.stderr.write(`[codesense] ${n}\n`);

  if (ctx.repos.length === 0) {
    process.stderr.write(
      "[codesense] 索引未就绪:无可用仓索引——先运行 `codesense index --register`(或去掉 --no-build 语义自行构建)。\n",
    );
    return 2;
  }
 // 多仓根:优先与 ctx.root 同根的仓,否则取节点数最多的仓(确定性:节点数降序 + 名字典序)。
  const same = ctx.repos.find((r) => r.root === ctx.root);
  const sorted = [...ctx.repos].sort((a, b) => b.index.nodes.length - a.index.nodes.length || a.name.localeCompare(b.name));
  const st = same ?? sorted[0]!;
  if (ctx.repos.length > 1) {
    process.stderr.write(
      `[codesense] 多仓根:quality 只对 \`${st.name}\`(${st.root})出报告;其余 ${ctx.repos.length - 1} 个根需 --root 单指。\n`,
    );
  }

  let docText: string | undefined;
  if (opts.doc) {
    const docPath = resolve(opts.doc);
    if (!existsSync(docPath)) {
      process.stderr.write(`[codesense] --doc 文件不存在: ${docPath}\n`);
      return 2;
    }
    docText = readFileSync(docPath, "utf-8");
  }

  const report: QualityReport = computeQuality(st.index, {
    ...(opts.surface ? { withSurface: true } : {}),
    ...(docText === undefined ? {} : { docText }),
  });

  process.stdout.write(opts.json ? JSON.stringify(report, null, 2) + "\n" : renderQualityReport(report));
  return opts.gate && !report.pass.all ? 1 : 0;
}
