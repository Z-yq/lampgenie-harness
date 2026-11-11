#!/usr/bin/env tsx
/**
 * office-visual CLI —— 给「PPTX 视觉质检」一条能在终端/CI 直接跑的命令。
 * node --experimental-strip-types scripts/office-visual.mts \
 * --root /tmp/m100b --check docs/review/harness-intro.pptx [--render <outdir>] [--json] [--report]
 * 设计口径:
 * ① 判定与落盘全在 apps/gateway/src/office-visual-store.ts(单一实现),这里只做参数解析与输出;
 * ② 退出码是给流水线的契约 —— 0 过含 warn;2 是真有 p0/p1 或空盘;1 是「没法判」(参数/IO/root/渲染);
 * ③ --json 时 stdout 只有一行 JSON(日志全走 stderr),方便 jq 直取。
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { runVisualCheck, visualRootAllowed, OFFICE_VISUAL_VERSION } from "../apps/gateway/src/office-visual-store.ts";

const USAGE = `office-visual —— PPTX 视觉质检(几何 + 真渲染 + 报告落盘),版本 v${OFFICE_VISUAL_VERSION}

用法:
  node --experimental-strip-types scripts/office-visual.mts --root <dir> --check <pptx> [选项]

选项:
  --root <dir>     报告落盘根目录(必须在 /tmp 之下,否则拒绝)
  --check <pptx>   被检 PPTX 路径
  --render <dir>   请求真渲染(soffice → PDF → gs → PNG);引擎缺失时退出码 1
  --json           只输出一行 JSON
  --report         额外打印报告路径与 ledger 路径
  -h, --help       打印本帮助

退出码:0 = pass/warn;2 = fail(含任一 p0/p1)或空盘;1 = 参数错误 / 文件读不到 / root 不合法 / 渲染失败`;

interface Args {
  root: string;
  check: string;
  render: string | null;
  json: boolean;
  report: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): { ok: true; args: Args } | { ok: false; error: string } {
  const args: Args = { root: "", check: "", render: null, json: false, report: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const takeValue = (): string | null => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) return null;
      i++;
      return next;
    };
    if (a === "-h" || a === "--help") args.help = true;
    else if (a === "--json") args.json = true;
    else if (a === "--report") args.report = true;
    else if (a === "--root" || a === "--check" || a === "--render") {
      const v = takeValue();
      if (v === null) return { ok: false, error: `${a} 缺少参数值` };
      if (a === "--root") args.root = v;
      else if (a === "--check") args.check = v;
      else args.render = v;
    } else return { ok: false, error: `未知参数:${a}` };
  }
  if (args.help) return { ok: true, args };
  if (!args.root) return { ok: false, error: "缺少 --root" };
  if (!args.check) return { ok: false, error: "缺少 --check" };
  return { ok: true, args };
}

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    log(`参数错误:${parsed.error}\n`);
    log(USAGE);
    return 1;
  }
  const args = parsed.args;
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
 // root 守卫先于任何读文件:不许把报告写到 /tmp 之外
  if (!visualRootAllowed(args.root)) {
    log(`root 不合法:${args.root} —— 只允许 /tmp 之下(拿到用户目录/家目录一律拒写)`);
    return 1;
  }
  const pptxPath = resolve(args.check);
  if (!existsSync(pptxPath) || !statSync(pptxPath).isFile()) {
    log(`文件读不到:${pptxPath}`);
    return 1;
  }

  const result = await runVisualCheck({
    root: resolve(args.root),
    pptxPath,
    renderOutDir: args.render ? resolve(args.render) : undefined,
  });

  const issues = Array.isArray(result.report.issues) ? result.report.issues : [];
  const pngPaths = result.render?.ok ? result.render.pngPaths : [];
 // 视觉评审只能逐页看真实 PNG:缺图的页数如用户反馈,不把「没渲染」说成「已复核」
  const pagesTotal = Number(result.report.metrics?.pages ?? 0);
  const missingPngs = Math.max(0, pagesTotal - pngPaths.length);

  if (args.json) {
 // stdout 只一行 JSON;其余都走 stderr
    const line = {
      verdict: result.report.verdict,
      score: result.report.score,
      code: result.report.code,
 // 渲染结论单独给:机器 verdict 与「渲染引擎缺失」是两件事,混在一个 code 里会看不出到底是哪一步出的结论
      renderCode: result.code === result.report.code ? null : result.code,
      issues: issues.length,
      metrics: result.report.metrics,
      render: { engine: result.render?.engine ?? "none", pngPaths },
      reportPath: result.reportPath ?? null,
      ledgerPath: result.ledgerPath ?? null,
      exitCode: result.exitCode,
      fingerprint: result.fingerprint,
    };
    process.stdout.write(`${JSON.stringify(line)}\n`);
  } else {
    const verdict = String(result.report.verdict ?? "fail").toUpperCase();
    process.stdout.write(`\n${verdict}  ${pptxPath}\n`);
    process.stdout.write(
      `  code=${result.report.code}  score=${result.report.score}  pages=${result.report.metrics?.pages ?? "?"}  ` +
        `issues=${issues.length}  pngs=${pngPaths.length}\n`,
    );
    if (issues.length === 0) {
      process.stdout.write("  无问题:几何与文案均在阈值内\n");
    } else {
      for (const it of issues) {
        const sev = String((it as { severity?: unknown }).severity ?? "?");
        const page = (it as { page?: unknown }).page ?? "-";
        const ruleId = String((it as { ruleId?: unknown }).ruleId ?? "?");
        const detail = String((it as { detail?: unknown }).detail ?? "");
        const fixHint = String((it as { fixHint?: unknown }).fixHint ?? "");
        process.stdout.write(`  [${sev}] p${page} ${ruleId} ${detail}\n`);
        if (fixHint) process.stdout.write(`        修法:${fixHint}\n`);
      }
    }
    if (result.render && !result.render.ok) {
      process.stdout.write(`  渲染:${result.render.code} ${result.render.detail ?? ""}(未产出任何 PNG)\n`);
    }
    if (result.render) process.stdout.write(`  未出 PNG:${missingPngs} 页(视觉评审需逐页 PNG,未出图的页不得声称已评审)\n`);
    if (args.report) {
      process.stdout.write(`  报告:${result.reportPath ?? "(未落盘)"}\n`);
      process.stdout.write(`  ledger:${result.ledgerPath ?? "(未落盘)"}\n`);
      process.stdout.write(`  指纹:${result.fingerprint}\n`);
    }
  }
  if (result.detail) log(`detail: ${result.detail}`);
  return result.exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    log(`内部异常:${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
