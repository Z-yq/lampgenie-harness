#!/usr/bin/env -S npx tsx
/**
 * 实验台账 CLI(tsx 直跑):record / decide / list / report。
 * 用法:
 * tsx scripts/experiment-ledger.mts --help
 * tsx scripts/experiment-ledger.mts --root /tmp/exp --record exp.json
 * tsx scripts/experiment-ledger.mts --root /tmp/exp --record - < exp.json
 * tsx scripts/experiment-ledger.mts --root /tmp/exp --decide <id> --decision adopt --reason "..." [--result r.json] [--by lead]
 * tsx scripts/experiment-ledger.mts --root /tmp/exp --list [--json]
 * tsx scripts/experiment-ledger.mts --root /tmp/exp --report [--json]
 * 退出码:0 成功;1 参数/校验错误或缺必需参数;2 adopt 被闸门拒(码打到 stderr);
 * 3 重复实验(EXP_DUPLICATE / EXP_DUPLICATE_HYPOTHESIS);其他 store 失败 → 1。
 * 落盘位置:`<root>/.genie/experiments/ledger.jsonl`(真实运行请只给 /tmp 下的 root)。
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

/** store 面(惰性解析:--help 不触发任何 imports)。 */
interface StoreModule {
  recordExperiment(root: string, exp: unknown): { ok: boolean; code?: string; id?: string };
  decideExperiment(
    root: string,
    id: string,
    kind: "adopt" | "reject" | "iterate" | "rollback",
    opts: { reason?: string; by?: string; resultMetrics?: unknown[] },
  ): { ok: boolean; code?: string; codes: string[] };
  listExperiments(
    root: string,
    filter?: { projectId?: string; taskClass?: string; model?: string; decision?: string },
  ): Array<Record<string, unknown>>;
  reportExperiments(root: string): Record<string, unknown>;
  experimentLedgerPath(root: string): string;
}

type ParsedArgs = {
  root: string;
  record?: string;
  decide?: string;
  decision?: string;
  reason?: string;
  result?: string;
  by?: string;
  list: boolean;
  report: boolean;
  json: boolean;
  help: boolean;
};

const USAGE = `实验台账 CLI(append-only jsonl)

用法:
  tsx scripts/experiment-ledger.mts [--root <dir>] --record <file.json|->
  tsx scripts/experiment-ledger.mts [--root <dir>] --decide <id> --decision <adopt|reject|iterate|rollback> --reason <text> [--result <file.json>] [--by <name>]
  tsx scripts/experiment-ledger.mts [--root <dir>] --list [--json]
  tsx scripts/experiment-ledger.mts [--root <dir>] --report [--json]
  tsx scripts/experiment-ledger.mts --help

选项:
  --root <dir>     台账根目录(缺省 process.cwd();台账落在 <root>/.genie/experiments/ledger.jsonl)
  --record <path>  记录一个实验 JSON 文件;"-" 表示从 stdin 读
  --decide <id>    对指定实验下发决策
  --decision <k>   adopt | reject | iterate | rollback
  --reason <text>  决策理由(reject/iterate/rollback 必填;adopt 可选)
  --result <path>  结果指标 JSON(ExperimentMetric[]),用于覆盖/补齐 metrics
  --by <name>      决策人
  --list           列出实验(默认表格,--json 输出 JSON)
  --report         汇总报告(默认人类可读,--json 输出 JSON)
  --json           与 --list/--report 搭配,输出 JSON
  --help           打印本用法

退出码:
  0 成功;1 参数/校验错误或缺必需参数;2 adopt 被闸门拒(codes 在 stderr);3 重复实验

示例:
  tsx scripts/experiment-ledger.mts --root /tmp/exp-demo --record /tmp/exp.json
  tsx scripts/experiment-ledger.mts --root /tmp/exp-demo --decide exp-xxxx --decision adopt --reason "显著且无回归"
`;

/** 手写 argv 解析:--key value 与开关两种;未知选项抛错(由 main 折成 exit 1)。 */
function parseArgv(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    root: process.cwd(),
    list: false,
    report: false,
    json: false,
    help: false,
  };
  const valueOf = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} 缺少取值`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case "--help":
      case "-h":
        out.help = true;
        break;
      case "--root":
        out.root = valueOf(i, arg);
        i += 1;
        break;
      case "--record":
        out.record = valueOf(i, arg);
        i += 1;
        break;
      case "--decide":
        out.decide = valueOf(i, arg);
        i += 1;
        break;
      case "--decision":
        out.decision = valueOf(i, arg);
        i += 1;
        break;
      case "--reason":
        out.reason = valueOf(i, arg);
        i += 1;
        break;
      case "--result":
        out.result = valueOf(i, arg);
        i += 1;
        break;
      case "--by":
        out.by = valueOf(i, arg);
        i += 1;
        break;
      case "--list":
        out.list = true;
        break;
      case "--report":
        out.report = true;
        break;
      case "--json":
        out.json = true;
        break;
      default:
        throw new Error(`未知参数:${arg}`);
    }
  }
  return out;
}

/** 读 stdin 全文。 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

/** 读 JSON 文件或 stdin("-")。 */
async function readJsonSource(src: string): Promise<unknown> {
  const text = src === "-" ? await readStdin() : await readFile(resolve(src), "utf8");
  return JSON.parse(text) as unknown;
}

async function loadStore(): Promise<StoreModule> {
  return (await import("../apps/gateway/src/experiment-store.ts")) as unknown as StoreModule;
}

/** id/decision 之外的表格列(claim 截断到 48 字符)。 */
function formatTable(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "(无实验)";
  const header = ["id", "decision", "surface", "claim"];
  const width = [20, 10, 8, 48];
  const clip = (text: string, n: number): string => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
  const cells = rows.map((row) => {
    const hypothesis = (row["hypothesis"] ?? {}) as Record<string, unknown>;
    const intervention = (row["intervention"] ?? {}) as Record<string, unknown>;
    const decision = (row["decision"] ?? {}) as Record<string, unknown>;
    return [
      String(row["id"] ?? ""),
      String(decision["kind"] ?? ""),
      String(intervention["surface"] ?? ""),
      clip(String(hypothesis["claim"] ?? ""), width[3]!),
    ];
  });
  const lines = [header, ...cells].map((cols) => cols.map((c, i) => c.padEnd(width[i]!)).join("  ").trimEnd());
  return lines.join("\n");
}

/** 人类可读报告。 */
function formatReport(report: Record<string, unknown>): string {
  const dump = (label: string, bag: unknown): string => {
    const entries = Object.entries((bag ?? {}) as Record<string, number>);
    if (entries.length === 0) return `  ${label}: (空)`;
    return `  ${label}: ${entries.map(([k, v]) => `${k}=${v}`).join(", ")}`;
  };
  const strata = (report["byStratum"] ?? {}) as Record<string, unknown>;
  return [
    `实验台账报告`,
    `  total: ${String(report["total"] ?? 0)}`,
    dump("byDecision", report["byDecision"]),
    dump("bySurface", report["bySurface"]),
    dump("byStratum.projectId", strata["projectId"]),
    dump("byStratum.taskClass", strata["taskClass"]),
    dump("byStratum.model", strata["model"]),
    `  conflicts: ${String(report["conflicts"] ?? 0)}`,
    `  parseErrors: ${String(report["parseErrors"] ?? 0)}`,
  ].join("\n");
}

const DUPLICATE_CODES = new Set(["EXP_DUPLICATE", "EXP_DUPLICATE_HYPOTHESIS"]);

/** 主流程:返回退出码。 */
async function main(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgv(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    return 1;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const actions = [args.record !== undefined, args.decide !== undefined, args.list, args.report].filter(Boolean).length;
  if (actions === 0) {
    process.stderr.write(`缺少动作(--record / --decide / --list / --report)\n\n${USAGE}`);
    return 1;
  }
  if (actions > 1) {
    process.stderr.write("一次只能做一件事(--record / --decide / --list / --report 互斥)\n");
    return 1;
  }

  const store = await loadStore();
  const root = resolve(args.root);

  if (args.record !== undefined) {
    let payload: unknown;
    try {
      payload = await readJsonSource(args.record);
    } catch (err) {
      process.stderr.write(`读取实验 JSON 失败:${(err as Error).message}\n`);
      return 1;
    }
    let res: { ok: boolean; code?: string; id?: string };
    try {
      res = store.recordExperiment(root, payload);
    } catch (err) {
 // 参数错误是唯一允许 throw 的路径(TypeError)。
      process.stderr.write(`实验参数非法:${(err as Error).message}\n`);
      return 1;
    }
    if (!res.ok) {
      process.stderr.write(`记录失败:${res.code ?? "EXP_STORE_ERROR"}${res.id ? ` (${res.id})` : ""}\n`);
      return res.code !== undefined && DUPLICATE_CODES.has(res.code) ? 3 : 1;
    }
    process.stdout.write(`recorded ${res.id}\n`);
    return 0;
  }

  if (args.decide !== undefined) {
    const kind = args.decision;
    if (kind === undefined) {
      process.stderr.write("--decide 需要 --decision adopt|reject|iterate|rollback\n");
      return 1;
    }
    if (!["adopt", "reject", "iterate", "rollback"].includes(kind)) {
      process.stderr.write(`未知决策类型:${kind}(允许 adopt|reject|iterate|rollback)\n`);
      return 1;
    }
    if (!["adopt"].includes(kind) && (args.reason ?? "").trim() === "") {
      process.stderr.write(`--decision ${kind} 需要 --reason <text>\n`);
      return 1;
    }
    let resultMetrics: unknown[] | undefined;
    if (args.result !== undefined) {
      try {
        const parsed = await readJsonSource(args.result);
        if (!Array.isArray(parsed)) throw new Error("结果指标必须是 ExperimentMetric[] 数组");
        resultMetrics = parsed;
      } catch (err) {
        process.stderr.write(`读取结果指标失败:${(err as Error).message}\n`);
        return 1;
      }
    }
    let res: { ok: boolean; code?: string; codes: string[] };
    try {
      res = store.decideExperiment(root, args.decide, kind as "adopt", {
        reason: args.reason,
        by: args.by,
        resultMetrics,
      });
    } catch (err) {
      process.stderr.write(`决策参数非法:${(err as Error).message}\n`);
      return 1;
    }
    if (!res.ok) {
      const codes = res.codes.length > 0 ? res.codes.join(",") : (res.code ?? "EXP_STORE_ERROR");
      if (kind === "adopt") {
        process.stderr.write(`adopt 被拒:${codes}\n`);
        return 2;
      }
      if (res.code !== undefined && DUPLICATE_CODES.has(res.code)) {
        process.stderr.write(`决策失败:${codes}\n`);
        return 3;
      }
      process.stderr.write(`决策失败:${codes}\n`);
      return 1;
    }
    process.stdout.write(`decided ${args.decide} ${kind}\n`);
    return 0;
  }

  if (args.list) {
    const rows = store.listExperiments(root, args.decision !== undefined ? { decision: args.decision } : undefined);
    process.stdout.write(args.json ? `${JSON.stringify(rows, null, 2)}\n` : `${formatTable(rows)}\n`);
    return 0;
  }

  const report = store.reportExperiments(root);
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`实验台账 CLI 失败:${(err as Error)?.message ?? String(err)}\n`);
    process.exitCode = 1;
  });
