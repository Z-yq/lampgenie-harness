#!/usr/bin/env -S npx tsx
/**
 * Tool Foundry CLI(tsx 直跑):observe / mine / candidates / shadow / evaluate / register / retire / report。
 * store 面:`apps/gateway/src/tool-foundry-store.ts`(惰性解析 —— --help 不触发任何 import,
 * 既避免 --help 去加载 runtime 模块,也避免给帮助路径带出写盘副作用)。
 * 退出码:
 * 0 成功
 * 1 参数 / JSON 解析错误、store 参数非法(TypeError)、INVALID 码
 * 2 需审批(FOUNDRY_NEEDS_APPROVAL)/ 影子未达标(FOUNDRY_LOW_REUSE / FOUNDRY_SHADOW_FAIL)/
 * 已被退役(retire 上的 FOUNDRY_DUPLICATE)
 * 3 候选不存在(candidate-not-found)/ 重复(FOUNDRY_DUPLICATE from mine、register)
 * 落盘位置:`<root>/.genie/rsi/foundry.jsonl`(真实运行请只给 /tmp 下的 root,别污染仓库 .genie)。
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

interface ObservationLike {
  id: string;
  signature: string;
  sessionId: string;
  projectId: string;
  at: number;
  success: boolean;
  cost: { tokens: number; wallMs: number; toolCalls: number };
  failureMode?: string;
}

interface DataToolSpecLike {
  name: string;
  version: string;
  layer: string;
  handler: { kind: string; ref: string };
  owner?: string;
  description?: string;
  permissions?: { mode: string; allowlist?: string[] };
  registeredBy?: string;
}

interface CandidateLike {
  id: string;
  name: string;
  description: string;
  sourceSignature: string;
  kind: string;
  frequency: number;
  sessions: number;
  projects: string[];
  estimatedSavings: { tokens: number; toolCalls: number };
  contract: { parameters: Record<string, unknown>; returns?: string };
  permissions: { mode: string; allowlist?: string[] };
  failureModes: string[];
  status: string;
  shadow?: { runs: number; successes: number; rejectedAt?: number };
  dataToolSpec?: DataToolSpecLike;
  createdAt: number;
  updatedAt: number;
}

interface DiscardLike {
  signature: string;
  reason: string;
}

interface CodesResult {
  ok: boolean;
  codes: string[];
  reason?: string;
}

/** store 面(只列本 CLI 用到的成员)。 */
interface FoundryStoreModule {
  foundryPath(root: string): string;
  observe(
    root: string,
    input: unknown): { ok: boolean; codes: string[]; observation?: ObservationLike; reason?: string };
  mine(
    root: string,
    opts?: { minOccurrences?: number; minSessions?: number },
  ): {
    ok: boolean;
    codes: string[];
    candidates?: CandidateLike[];
    discarded?: DiscardLike[];
    duplicateSignatures?: string[];
    reason?: string;
  };
  listCandidates(root: string, filter?: { status?: string }): CandidateLike[];
  startShadow(root: string, id: string): CodesResult & { candidate?: CandidateLike };
  evaluateShadow(
    root: string,
    id: string,
    input: { runs: number; successes: number },
  ): CodesResult & { candidate?: CandidateLike };
  register(root: string, id: string, opts: { approved: boolean }): CodesResult & {
    candidate?: CandidateLike;
    dataToolSpec?: DataToolSpecLike;
  };
  retire(root: string, id: string, opts: { reason: string }): CodesResult & { candidate?: CandidateLike };
  report(root: string): {
    total: number;
    byStatus: Record<string, number>;
    estimatedSavings: { tokens: number; toolCalls: number };
    failureModes: { mode: string; count: number }[];
    observations: number;
    badLines: number;
  };
}

type ParsedArgs = {
  root: string;
  observe?: string;
  mine: boolean;
  minOccurrences?: number;
  minSessions?: number;
  candidates: boolean;
  status?: string;
  shadow?: string;
  evaluate?: string;
  runs?: number;
  successes?: number;
  register?: string;
  approve: boolean;
  retire?: string;
  reason?: string;
  report: boolean;
  json: boolean;
  help: boolean;
};

const USAGE = `Tool Foundry CLI(append-only jsonl: <root>/.genie/rsi/foundry.jsonl)

用法:
  npx tsx scripts/tool-foundry.mts --root <dir> --observe <file.json|->
  npx tsx scripts/tool-foundry.mts --root <dir> --mine [--min-occurrences n] [--min-sessions n] [--json]
  npx tsx scripts/tool-foundry.mts --root <dir> --candidates [--status s] [--json]
  npx tsx scripts/tool-foundry.mts --root <dir> --shadow <candidate-id>
  npx tsx scripts/tool-foundry.mts --root <dir> --evaluate <candidate-id> --runs n --successes n
  npx tsx scripts/tool-foundry.mts --root <dir> --register <candidate-id> [--approve]
  npx tsx scripts/tool-foundry.mts --root <dir> --retire <candidate-id> --reason "text"
  npx tsx scripts/tool-foundry.mts --root <dir> --report [--json]
  npx tsx scripts/tool-foundry.mts --help

选项:
  --root <dir>         台账根目录(缺省 process.cwd();请给 /tmp 下的目录)
  --observe <path>     观测 JSON(单个对象或数组);"-" 从 stdin 读
  --mine               按签名聚合观测并挖掘候选
  --min-occurrences n  挖掘门槛:同签名最少次数(缺省 3)
  --min-sessions n     挖掘门槛:最少会话数(缺省 2)
  --candidates         列出候选
  --status <s>         按状态过滤 candidate|shadow|registered|retired|rejected
  --shadow <id>        候选进影子
  --evaluate <id>      影子评估(--runs / --successes 必填)
  --runs n             影子运行次数
  --successes n        影子成功次数
  --register <id>      注册为 data 层工具(需 --approve 人工批准)
  --approve            人工批准标记
  --retire <id>        下线候选(--reason 必填)
  --reason <text>      下线理由
  --report             汇总报告(状态分布 / 总节省 / 失败模式 / 坏行数)
  --json               与 --mine / --candidates / --report 搭配,输出 JSON
  --help               打印本用法(不加载 store)

退出码:
  0 成功;1 参数/JSON 错误;2 需审批或影子未达标或已被退役;
  3 候选不存在或重复(前者的 reason=candidate-not-found)
`;

const NOT_FOUND = "candidate-not-found";

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`${flag} 需要取值`);
  return value;
}

function readPositiveInt(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${flag} 需要非负整数,收到 ${raw}`);
  return value;
}

function parseArgv(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    root: process.cwd(),
    mine: false,
    candidates: false,
    approve: false,
    report: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case "--root":
        args.root = readValue(argv, i, token);
        i += 1;
        break;
      case "--observe":
        args.observe = readValue(argv, i, token);
        i += 1;
        break;
      case "--mine":
        args.mine = true;
        break;
      case "--min-occurrences":
        args.minOccurrences = readPositiveInt(readValue(argv, i, token), token);
        i += 1;
        break;
      case "--min-sessions":
        args.minSessions = readPositiveInt(readValue(argv, i, token), token);
        i += 1;
        break;
      case "--candidates":
        args.candidates = true;
        break;
      case "--status":
        args.status = readValue(argv, i, token);
        i += 1;
        break;
      case "--shadow":
        args.shadow = readValue(argv, i, token);
        i += 1;
        break;
      case "--evaluate":
        args.evaluate = readValue(argv, i, token);
        i += 1;
        break;
      case "--runs":
        args.runs = readPositiveInt(readValue(argv, i, token), token);
        i += 1;
        break;
      case "--successes":
        args.successes = readPositiveInt(readValue(argv, i, token), token);
        i += 1;
        break;
      case "--register":
        args.register = readValue(argv, i, token);
        i += 1;
        break;
      case "--approve":
        args.approve = true;
        break;
      case "--retire":
        args.retire = readValue(argv, i, token);
        i += 1;
        break;
      case "--reason":
        args.reason = readValue(argv, i, token);
        i += 1;
        break;
      case "--report":
        args.report = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`未知参数:${token}`);
    }
  }
  return args;
}

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

/** store 惰性解析(--help 不触发)。 */
async function loadStore(): Promise<FoundryStoreModule> {
  return (await import("../apps/gateway/src/tool-foundry-store.ts")) as unknown as FoundryStoreModule;
}

function codesOf(res: { codes?: string[]; code?: string; reason?: string }): string {
  const codes = (res.codes ?? []).filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  if (codes.length > 0) return codes.join(",");
  if (typeof res.code === "string" && res.code.length > 0) return res.code;
  return "FOUNDRY_UNKNOWN";
}

function has(res: { codes?: string[] }, code: string): boolean {
  return Array.isArray(res.codes) && res.codes.includes(code);
}

/** 失败:码打到 stderr,返回退出码。 */
function fail(exitCode: number, label: string, res: { codes?: string[]; code?: string; reason?: string }): number {
  const reason = res.reason !== undefined ? ` (${res.reason})` : "";
  process.stderr.write(`${label}:${codesOf(res)}${reason}\n`);
  return exitCode;
}

function formatCandidate(candidate: CandidateLike, index: number): string {
  const projects = candidate.projects.length > 0 ? candidate.projects.join(", ") : "(无)";
  const allowlist =
    candidate.permissions.allowlist !== undefined && candidate.permissions.allowlist.length > 0
      ? ` allowlist=${candidate.permissions.allowlist.join(",")}`
      : "";
  const failureModes = candidate.failureModes.length > 0 ? candidate.failureModes.join(", ") : "(无)";
  const returns = candidate.contract.returns ?? "(未声明)";
  return [
    `${index + 1}. ${candidate.name} [${candidate.id}] status=${candidate.status}`,
    `   签名: ${candidate.sourceSignature}`,
    `   频次: ${candidate.frequency} 次 / 会话: ${candidate.sessions} 个 / 项目: ${projects}`,
    `   预估节省: tokens ${candidate.estimatedSavings.tokens} / toolCalls ${candidate.estimatedSavings.toolCalls}`,
    `   契约: parameters=${JSON.stringify(candidate.contract.parameters)} → returns=${returns}`,
    `   权限: ${candidate.permissions.mode}${allowlist}`,
    `   失败模式: ${failureModes}`,
  ].join("\n");
}

function formatCandidateTable(rows: CandidateLike[]): string {
  if (rows.length === 0) return "(无候选)";
  const header = ["id", "name", "status", "freq", "sessions"].map((cell) => cell.padEnd(12));
  const lines = rows.map((row) =>
    [
      row.id.padEnd(12),
      row.name.padEnd(12),
      row.status.padEnd(12),
      String(row.frequency).padEnd(12),
      String(row.sessions).padEnd(12),
    ]
      .join("  ")
      .trimEnd(),
  );
  return [header.join("  ").trimEnd(), ...lines].join("\n");
}

function describeDiscards(discarded: DiscardLike[]): string {
  if (discarded.length === 0) return "  discarded: (无)";
  return [
    "  discarded:",
    ...discarded.map((entry) => `    ${entry.signature || "(空签名)"} → ${entry.reason}`),
  ].join("\n");
}

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

  const actions = [
    args.observe !== undefined,
    args.mine,
    args.candidates,
    args.shadow !== undefined,
    args.evaluate !== undefined,
    args.register !== undefined,
    args.retire !== undefined,
    args.report,
  ].filter(Boolean).length;
  if (actions === 0) {
    process.stderr.write("缺少动作(--observe / --mine / --candidates / --shadow / --evaluate / --register / --retire / --report)\n\n");
    return 1;
  }
  if (actions > 1) {
    process.stderr.write("一次只能做一件事(动作互斥)\n");
    return 1;
  }
  if (args.evaluate !== undefined && (args.runs === undefined || args.successes === undefined)) {
    process.stderr.write("--evaluate 需要 --runs 与 --successes\n");
    return 1;
  }
  if (args.register !== undefined && args.retire !== undefined) {
    process.stderr.write("--register 与 --retire 互斥\n");
    return 1;
  }
  if (args.retire !== undefined && (args.reason ?? "").trim() === "") {
    process.stderr.write("--retire 需要 --reason <text>\n");
    return 1;
  }

  const store = await loadStore();
  const root = resolve(args.root);

  if (args.observe !== undefined) {
    let payload: unknown;
    try {
      payload = await readJsonSource(args.observe);
    } catch (err) {
      process.stderr.write(`读取观测 JSON 失败:${(err as Error).message}\n`);
      return 1;
    }
    const items = Array.isArray(payload) ? payload : [payload];
    if (items.length === 0) {
      process.stderr.write("观测 JSON 为空数组,没有任何观测可写\n");
      return 1;
    }
    let failed = 0;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      let res: { ok: boolean; codes: string[]; observation?: ObservationLike; reason?: string };
      try {
        res = store.observe(root, item);
      } catch (err) {
        process.stderr.write(`observe#${index + 1} 参数非法:${(err as Error).message}\n`);
        return 1;
      }
      if (!res.ok) {
        failed += 1;
        const reason = res.reason !== undefined ? ` (${res.reason})` : "";
        process.stderr.write(`observe#${index + 1} 失败:${codesOf(res)}${reason}\n`);
        continue;
      }
      process.stdout.write(`observe#${index + 1} ${res.observation?.id ?? "(no-id)"} ${codesOf(res)}\n`);
    }
    return failed > 0 ? 1 : 0;
  }

  if (args.mine) {
    const opts: { minOccurrences?: number; minSessions?: number } = {};
    if (args.minOccurrences !== undefined) opts.minOccurrences = args.minOccurrences;
    if (args.minSessions !== undefined) opts.minSessions = args.minSessions;
    let res: ReturnType<FoundryStoreModule["mine"]>;
    try {
      res = store.mine(root, Object.keys(opts).length > 0 ? opts : undefined);
    } catch (err) {
      process.stderr.write(`挖掘参数非法:${(err as Error).message}\n`);
      return 1;
    }
    if (!res.ok) return has(res, "FOUNDRY_DUPLICATE") ? fail(3, "挖掘失败", res) : fail(1, "挖掘失败", res);
    const candidates = res.candidates ?? [];
    const discarded = res.discarded ?? [];
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ candidates, discarded }, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(`候选:${candidates.length} 个\n`);
    candidates.forEach((candidate, index) => {
      process.stdout.write(`${formatCandidate(candidate, index)}\n`);
    });
    process.stdout.write(`${describeDiscards(discarded)}\n`);
    return 0;
  }

  if (args.candidates) {
    const filter = args.status !== undefined ? { status: args.status } : undefined;
    let rows: CandidateLike[];
    try {
      rows = store.listCandidates(root, filter);
    } catch (err) {
      process.stderr.write(`列出候选失败:${(err as Error).message}\n`);
      return 1;
    }
    process.stdout.write(args.json ? `${JSON.stringify(rows, null, 2)}\n` : `${formatCandidateTable(rows)}\n`);
    return 0;
  }

  if (args.shadow !== undefined) {
    const res = store.startShadow(root, args.shadow);
    if (res.ok && has(res, "FOUNDRY_SHADOW_STARTED")) {
      process.stdout.write(`FOUNDRY_SHADOW_STARTED ${args.shadow}\n`);
      return 0;
    }
    if (res.reason === NOT_FOUND) return fail(3, "进影子失败", res);
    if (has(res, "FOUNDRY_INVALID")) return fail(1, "进影子失败", res);
    return fail(2, "进影子失败", res);
  }

  if (args.evaluate !== undefined) {
    const runs = args.runs as number;
    const successes = args.successes as number;
    const res = store.evaluateShadow(root, args.evaluate, { runs, successes });
    const rate = runs === 0 ? 0 : successes / runs;
    if (res.ok && has(res, "FOUNDRY_SHADOW_PASS")) {
      process.stdout.write(
        `FOUNDRY_SHADOW_PASS ${args.evaluate} runs=${runs} successes=${successes} rate=${rate.toFixed(2)}\n`,
      );
      return 0;
    }
    if (res.reason === NOT_FOUND) return fail(3, "影子评估失败", res);
    if (has(res, "FOUNDRY_LOW_REUSE") || has(res, "FOUNDRY_SHADOW_FAIL")) {
      process.stderr.write(
        `影子评估失败:${codesOf(res)} runs=${runs} successes=${successes} rate=${rate.toFixed(2)}\n`,
      );
      return 2;
    }
    return fail(1, "影子评估失败", res);
  }

  if (args.register !== undefined) {
    const res = store.register(root, args.register, { approved: args.approve });
    if (res.ok && has(res, "FOUNDRY_REGISTERED")) {
      const spec = res.dataToolSpec;
      if (spec === undefined) {
        process.stderr.write("注册成功但 store 未回 dataToolSpec\n");
        return 1;
      }
      process.stdout.write(
        [
          `FOUNDRY_REGISTERED ${args.register}`,
          `  dataToolSpec: name=${spec.name} version=${spec.version} layer=${spec.layer} handler=${spec.handler.kind}:${spec.handler.ref}`,
        ].join("\n") + "\n",
      );
      return 0;
    }
    if (res.reason === NOT_FOUND) return fail(3, "注册失败", res);
    if (has(res, "FOUNDRY_DUPLICATE")) return fail(3, "注册失败", res);
    if (has(res, "FOUNDRY_NEEDS_APPROVAL")) return fail(2, "注册失败", res);
    return fail(1, "注册失败", res);
  }

  if (args.retire !== undefined) {
    const res = store.retire(root, args.retire, { reason: args.reason as string });
    if (res.ok && has(res, "FOUNDRY_RETIRED")) {
      process.stdout.write(`FOUNDRY_RETIRED ${args.retire} reason=${args.reason as string}\n`);
      return 0;
    }
    if (res.reason === NOT_FOUND) return fail(3, "下线失败", res);
 // 已被退役:按规格回 2(重复下线是终态冲突,不是新事实)。
    if (has(res, "FOUNDRY_DUPLICATE")) return fail(2, "下线失败", res);
    return fail(1, "下线失败", res);
  }

  const report = store.report(root);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  const byStatus =
    Object.keys(report.byStatus).length === 0
      ? "(空)"
      : Object.entries(report.byStatus)
          .map(([status, count]) => `${status}=${count}`)
          .join(", ");
  const failureModes =
    report.failureModes.length === 0
      ? "(空)"
      : report.failureModes.map((entry) => `${entry.mode}=${entry.count}`).join(", ");
  process.stdout.write(
    [
      "Tool Foundry 报告",
      `  ledger: ${store.foundryPath(root)}`,
      `  observations: ${report.observations}`,
      `  total: ${report.total}`,
      `  byStatus: ${byStatus}`,
      `  estimatedSavings: tokens=${report.estimatedSavings.tokens}, toolCalls=${report.estimatedSavings.toolCalls}`,
      `  failureModes: ${failureModes}`,
      `  badLines: ${report.badLines}`,
    ].join("\n") + "\n",
  );
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`Tool Foundry CLI 失败:${(err as Error)?.message ?? String(err)}\n`);
    process.exitCode = 1;
  });
