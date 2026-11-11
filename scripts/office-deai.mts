#!/usr/bin/env -S npx tsx
/**
 * 办公输出「去 AI 味」审计 CLI(node --experimental-strip-types / tsx 均可直跑)。
 * 为什么要一个 CLI 而不是只留 store API:
 * 审计的价值在「能进 CI 当门禁」——退出码是唯一不会被人忽略的输出。
 * 所以这里的核心契约是退出码,不是文案:
 * 0 = 全部 pass 或 warn(可发)
 * 2 = 任一文档 fail(拦住)
 * 1 = 参数 / 读取 / 存储错误(这次判断不成立,不能当成通过)
 * 三者互斥且必须区分:把「读不到文件」混进 0 会让门禁永久放行,混进 2 会让人以为是文档问题。
 * 为什么 store 只在真正要干活时才动态加载:--help 不该拉起 jszip 与 runtime,
 * 否则「忘了怎么用」这个最轻的请求要付最重的启动成本。
 * 真实运行 root 必须在 /tmp 下(store 侧 checkRoot 强制):审计产物是临时证据,
 * 落进仓库会污染工作区并被误提交。
 */
import { readFile } from "node:fs/promises";
import process from "node:process";

/** store 面(只声明这里用到的字段,避免把类型依赖静态拉进来)。 */
interface CheckOutcome {
  ok: boolean;
  code: string;
  codes: string[];
  file: string;
  kind: string;
  hash: string;
  score: number;
  verdict: "pass" | "warn" | "fail";
  residualScore?: number;
  residualVerdict?: "pass" | "warn" | "fail";
  findings: number;
  topRules: { ruleId: string; count: number }[];
  chars: number;
  artifactPath?: string;
  appended?: boolean;
  parseError?: string;
}

interface LedgerEntryLike {
  hash: string;
  file: string;
  score: number;
  verdict: string;
  residualScore?: number;
  residualVerdict?: string;
}

interface ReportLike {
  ok: boolean;
  code?: string;
  files: number;
  scores: number[];
  verdicts: { pass: number; warn: number; fail: number };
  topRules: { ruleId: string; count: number }[];
  parseErrors: number;
  rulesVersion: string;
}

interface StoreLike {
  checkRoot(root: string): { ok: boolean; code?: string; reason?: string; resolved: string };
  checkDocument(
    root: string,
    file: string,
    opts?: { threshold?: number; exemptions?: unknown[] },
  ): Promise<CheckOutcome>;
  readLedger(root: string): Promise<{ ok: boolean; entries: LedgerEntryLike[]; parseErrors: number; code?: string }>;
  buildReport(root: string): Promise<ReportLike>;
  ledgerPathOf(root: string): string;
}

const USAGE = `办公去 AI 味审计(office-deai)

用法:
  node --experimental-strip-types --conditions=development scripts/office-deai.mts \\
    --root <dir> --check <file...> [--threshold 60] [--exemptions <json>] [--json]
  ... --root <dir> --report [--json]

参数:
  --root <dir>        产物与台账根目录(必须在 /tmp 下;仓内 root 会被拒绝)
  --check <file...>   待审计文件(md/txt/docx/pptx/xlsx),可多个
  --threshold <n>     fail 阈值(缺省 60);warn 阈值固定 40(除非 threshold<=40,自动下压)
  --exemptions <json> 豁免清单:JSON 数组 [{ruleId,excerpt,reason,owner?}] 或 {"exemptions":[...]}
  --json              机器可读输出(单文件=对象,多文件=数组)
  --report            读台账输出汇总(files/scores/verdicts/topRules/parseErrors)
  --help              本说明(不加载 store)

退出码:0 = 全部 pass/warn;2 = 任一文档 fail;1 = 参数/读取/存储错误
产物:<root>/.genie/office/deai/<sha256前12>.json + ledger.jsonl(同 hash 不重复追加)
`;

interface Args {
  root?: string;
  check: string[];
  threshold?: number;
  exemptions?: string;
  json: boolean;
  report: boolean;
  help: boolean;
  error?: string;
}

/** 手写参数解析:cli 只有 7 个开关,引解析库不值得;但要保证 --check 吃多值。 */
function parseArgs(argv: string[]): Args {
  const args: Args = { check: [], json: false, report: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--root" || token === "--threshold" || token === "--exemptions") {
      const value = argv[i + 1];
      if (value === undefined) {
        args.error = `${token} 缺少取值`;
        return args;
      }
      i += 1;
      if (token === "--root") args.root = value;
      else if (token === "--exemptions") args.exemptions = value;
      else {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
          args.error = `--threshold 必须是 1..100 的数字(收到 ${value})`;
          return args;
        }
        args.threshold = parsed;
      }
      continue;
    }
    if (token === "--check") {
      let consumed = 0;
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        args.check.push(argv[i + 1]);
        i += 1;
        consumed += 1;
      }
      if (consumed === 0) {
        args.error = "--check 至少给一个文件";
        return args;
      }
      continue;
    }
    if (token === "--json") args.json = true;
    else if (token === "--report") args.report = true;
    else if (token === "--help" || token === "-h") args.help = true;
    else {
      args.error = `未知参数:${token}`;
      return args;
    }
  }
  return args;
}

/** 读豁免清单:接受数组或 {exemptions:[...]};坏 JSON 直接算参数错误(不能静默忽略豁免)。 */
async function loadExemptions(path: string): Promise<{ ok: boolean; list?: unknown[]; reason?: string }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return { ok: false, reason: `读不到豁免文件:${String((error as { code?: string }).code ?? error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: "豁免文件不是合法 JSON" };
  }
  if (Array.isArray(parsed)) return { ok: true, list: parsed };
  if (parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { exemptions?: unknown }).exemptions)) {
    return { ok: true, list: (parsed as { exemptions: unknown[] }).exemptions };
  }
  return { ok: false, reason: "豁免文件必须是数组或 {exemptions:[...]}" };
}

function isErrorCode(code: string): boolean {
  return code !== "DEAI_OK" && code !== "DEAI_EMPTY";
}

function topRuleText(rules: { ruleId: string; count: number }[]): string {
  if (rules.length === 0) return "无";
  return rules
    .slice(0, 5)
    .map((rule) => `${rule.ruleId}×${rule.count}`)
    .join(", ");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.error !== undefined) {
    process.stderr.write(`参数错误:${args.error}\n\n${USAGE}`);
    return 1;
  }
  if (args.root === undefined) {
    process.stderr.write(`参数错误:缺少 --root\n\n${USAGE}`);
    return 1;
  }
  if (!args.report && args.check.length === 0) {
    process.stderr.write(`参数错误:需要 --check <file...> 或 --report\n\n${USAGE}`);
    return 1;
  }

 // 动态加载:--help 之外才需要 jszip 与 runtime。
  const store = (await import(new URL("../apps/gateway/src/office-deai-store.ts", import.meta.url).href)) as unknown as StoreLike;

  let exemptions: unknown[] | undefined;
  if (args.exemptions !== undefined) {
    const loaded = await loadExemptions(args.exemptions);
    if (!loaded.ok) {
      process.stderr.write(`参数错误:${loaded.reason ?? "豁免文件无效"}\n`);
      return 1;
    }
    exemptions = loaded.list;
  }

  if (args.report) {
    const report = await store.buildReport(args.root);
    if (!report.ok) {
      process.stderr.write(`报告失败:${report.code ?? "DEAI_STORE_FAILED"}\n`);
      return 1;
    }
    if (args.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      const lines: string[] = [];
      lines.push(`台账:${store.ledgerPathOf(args.root)}`);
      lines.push(`文件数:${report.files}  规则版本:${report.rulesVersion}`);
      lines.push(`verdict:pass=${report.verdicts.pass} warn=${report.verdicts.warn} fail=${report.verdicts.fail}`);
      lines.push(`平均分:${report.scores.length > 0 ? Math.round(report.scores.reduce((a, b) => a + b, 0) / report.scores.length) : 0}`);
      lines.push(`分数:${report.scores.join(", ")}`);
      lines.push(`top 规则:${topRuleText(report.topRules)}`);
      lines.push(`坏行(parseErrors):${report.parseErrors}`);
      process.stdout.write(`${lines.join("\n")}\n`);
    }
    return 0;
  }

  const rootCheck = store.checkRoot(args.root);
  if (!rootCheck.ok) {
    process.stderr.write(
      `存储错误:${rootCheck.code ?? "DEAI_ROOT_UNSAFE"} ${rootCheck.reason ?? "root 不合规(必须在 /tmp 下)"}\n`,
    );
    return 1;
  }

  const outcomes: CheckOutcome[] = [];
  let hadError = false;
  for (const file of args.check) {
    const outcome = await store.checkDocument(args.root, file, { threshold: args.threshold, exemptions });
    outcomes.push(outcome);
    if (!outcome.ok || isErrorCode(outcome.code)) hadError = true;
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(outcomes.length === 1 ? outcomes[0] : outcomes, null, 2)}\n`);
  } else {
    const lines: string[] = [];
    for (const outcome of outcomes) {
      if (!outcome.ok || isErrorCode(outcome.code)) {
        lines.push(`[error] ${outcome.code} file=${outcome.file} ${outcome.parseError ?? ""}`.trim());
        continue;
      }
      const residual =
        outcome.residualScore === undefined
          ? ""
          : `  residual=${outcome.residualScore}(${outcome.residualVerdict})`;
      lines.push(
        `[${outcome.verdict}] score=${outcome.score} file=${outcome.file} kind=${outcome.kind} chars=${outcome.chars} findings=${outcome.findings}${residual}`,
      );
      lines.push(`  top: ${topRuleText(outcome.topRules)}`);
      if (outcome.artifactPath !== undefined) {
        lines.push(`  artifact: ${outcome.artifactPath} ledger-appended=${outcome.appended === true ? "yes" : "no(同 hash 已存在)"}`);
      }
    }
    process.stdout.write(`${lines.join("\n")}\n`);
  }

 // 错误优先于 fail:读不到文件的判断不成立,不能当「文档通过」也不能当「文档不合格」。
  if (hadError) return 1;
  return outcomes.some((outcome) => outcome.verdict === "fail") ? 2 : 0;
}

// 不 throw:任何意外都折成退出码 1,CLI 的契约是退出码而不是栈。
main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`内部错误:${String((error as { message?: string }).message ?? error)}\n`);
    process.exit(1);
  });
