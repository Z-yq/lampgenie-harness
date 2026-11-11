#!/usr/bin/env -S npx tsx
/**
 * 改进提案 CLI(tsx 直跑):create / list / show / transition / ship / verify / supersede / export / report。
 * 用法:
 * tsx scripts/change-request.mts --help
 * tsx scripts/change-request.mts --root /tmp/cr --create /tmp/cr.json # "-" 从 stdin 读
 * tsx scripts/change-request.mts --root /tmp/cr --list [--status shipped] [--json]
 * tsx scripts/change-request.mts --root /tmp/cr --show <id> [--json]
 * tsx scripts/change-request.mts --root /tmp/cr --transition <id> <to> --by <who> [--note <n>]
 * tsx scripts/change-request.mts --root /tmp/cr --ship <id> --version <v>
 * tsx scripts/change-request.mts --root /tmp/cr --verify <id> --observed true|false [--note <n>]
 * tsx scripts/change-request.mts --root /tmp/cr --supersede <id> --by-id <id>
 * tsx scripts/change-request.mts --root /tmp/cr --export <id>
 * tsx scripts/change-request.mts --root /tmp/cr --report [--json]
 * 退出码:0 成功;1 参数错;2 信息性非成功(MERGED / STILL_OBSERVED / TRANSITION_INVALID / STATUS_UNCHANGED);
 * 3 不存在(CHANGE_REQ_NOT_FOUND)。
 * 落盘位置:`<root>/.genie/rsi/change-requests.jsonl`(真实运行请只给 /tmp 下的 root)。
 * --help 不加载 store 面(纯静态用法文本)。
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

/** store 面(惰性解析:--help 不触发任何 imports)。 */
interface RequestLike {
  id: string;
  title: string;
  kind: string;
  target: { module: string; symbol?: string };
  evidenceRefs: string[];
  reproSteps: string[];
  impact: { files?: string[]; users?: string; blastRadius?: string };
  expectedBehavior: string;
  observedBehavior: string;
  status: string;
  dedupeKey: string;
  provenance: string;
  createdAt: number;
  updatedAt: number;
  release?: { version: string; at: number };
  verification?: { checkedAt: number; stillObserved: boolean; note?: string };
  supersededBy?: string;
  lastTransition?: { to: string; by?: string; note?: string; at: number };
}

interface StoreResult {
  ok: boolean;
  code?: string;
  id?: string;
  request?: RequestLike;
  merged?: boolean;
  path?: string;
}

interface StoreModule {
  createRequest(root: string, input: unknown, opts?: { at?: number }): StoreResult;
  getRequest(root: string, id: string): StoreResult;
  listRequests(root: string, opts?: { status?: string }): {
    ok: true;
    requests: RequestLike[];
    parseErrors: number;
  };
  transition(root: string, id: string, to: string, opts?: { by?: string; note?: string }): StoreResult;
  ship(root: string, id: string, opts?: { version?: string }): StoreResult;
  verify(root: string, id: string, opts?: { observed?: boolean; note?: string }): StoreResult;
  supersede(root: string, id: string, opts?: { byId?: string }): StoreResult;
  exportMarkdown(root: string, id: string): StoreResult;
  reportRequests(root: string, opts?: { at?: number }): {
    ok: true;
    total: number;
    byStatus: Record<string, number>;
    byKind: Record<string, number>;
    openAged: { olderThanDays: number; count: number; ids: string[] };
    parseErrors: number;
    totalLines: number;
  };
}

interface ParsedArgs {
  root?: string;
  create?: string;
  list: boolean;
  status?: string;
  json: boolean;
  show?: string;
  transition?: { id: string; to: string };
  by?: string;
  note?: string;
  ship?: string;
  version?: string;
  verify?: string;
  observed?: boolean;
  supersede?: string;
  byId?: string;
  export?: string;
  report: boolean;
  help: boolean;
}

const USAGE = `改进提案 CLI(append-only jsonl)

用法:
  tsx scripts/change-request.mts --root <dir> --create <file|->            新建提案(自动判重合并)
  tsx scripts/change-request.mts --root <dir> --list [--status <s>] [--json]
  tsx scripts/change-request.mts --root <dir> --show <id> [--json]
  tsx scripts/change-request.mts --root <dir> --transition <id> <to> --by <who> [--note <n>]
  tsx scripts/change-request.mts --root <dir> --ship <id> --version <v>
  tsx scripts/change-request.mts --root <dir> --verify <id> --observed true|false [--note <n>]
  tsx scripts/change-request.mts --root <dir> --supersede <id> --by-id <id>
  tsx scripts/change-request.mts --root <dir> --export <id>
  tsx scripts/change-request.mts --root <dir> --report [--json]
  tsx scripts/change-request.mts --help

选项:
  --root <dir>       台账根目录(必填;落在 <root>/.genie/rsi/change-requests.jsonl)
  --create <path>    提案 JSON 文件;"-" 表示 stdin
  --list             列出提案(--status 过滤)
  --show <id>        查看一条提案
  --transition <id> <to>  流转:proposed→accepted|rejected|superseded;accepted→scheduled|superseded|rejected;
                          scheduled→shipped|superseded;shipped→superseded
  --ship <id>        记发版(需 --version)
  --verify <id>      发版后核对(需 --observed true|false)
  --supersede <id>   被另一条取代(需 --by-id)
  --export <id>      导出人读提案到 <root>/.genie/rsi/proposals/<id>.md
  --report           汇总报表(byStatus / byKind / 7 天积压)
  --json             机器可读输出
  --help             打印本用法(不加载 store)

退出码:
  0 成功;1 参数错;2 信息性非成功(CHANGE_REQ_MERGED / CHANGE_REQ_STILL_OBSERVED /
  CHANGE_REQ_TRANSITION_INVALID / CHANGE_REQ_STATUS_UNCHANGED);3 不存在(CHANGE_REQ_NOT_FOUND)
`;

/** 参数解析:错误一律抛(由 main 折叠成退出码 1)。 */
function parseArgv(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { list: false, report: false, json: false, help: false };
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
        out.root = resolve(valueOf(i, arg));
        i += 1;
        break;
      case "--create":
        out.create = valueOf(i, arg);
        i += 1;
        break;
      case "--list":
        out.list = true;
        break;
      case "--status":
        out.status = valueOf(i, arg);
        i += 1;
        break;
      case "--json":
        out.json = true;
        break;
      case "--show":
        out.show = valueOf(i, arg);
        i += 1;
        break;
      case "--transition": {
        const id = valueOf(i, arg);
        const to = argv[i + 2];
        if (to === undefined || to.startsWith("--")) throw new Error("--transition 需要 <id> <to> 两个取值");
        out.transition = { id, to };
        i += 2;
        break;
      }
      case "--by":
        out.by = valueOf(i, arg);
        i += 1;
        break;
      case "--note":
        out.note = valueOf(i, arg);
        i += 1;
        break;
      case "--ship":
        out.ship = valueOf(i, arg);
        i += 1;
        break;
      case "--version":
        out.version = valueOf(i, arg);
        i += 1;
        break;
      case "--verify":
        out.verify = valueOf(i, arg);
        i += 1;
        break;
      case "--observed": {
        const raw = valueOf(i, arg);
        if (raw !== "true" && raw !== "false") throw new Error(`--observed 只接受 true|false,收到 ${raw}`);
        out.observed = raw === "true";
        i += 1;
        break;
      }
      case "--supersede":
        out.supersede = valueOf(i, arg);
        i += 1;
        break;
      case "--by-id":
        out.byId = valueOf(i, arg);
        i += 1;
        break;
      case "--export":
        out.export = valueOf(i, arg);
        i += 1;
        break;
      case "--report":
        out.report = true;
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
  return (await import("../apps/gateway/src/change-request-store.ts")) as unknown as StoreModule;
}

function iso(ms: unknown): string {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

function clip(text: unknown, n = 70): string {
  const s = typeof text === "string" ? text : String(text ?? "");
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** 退出码约定(见文件头)。 */
function exitFor(result: StoreResult): number {
  const code = result.code;
  if (code === "CHANGE_REQ_NOT_FOUND") return 3;
  if (code === "CHANGE_REQ_INVALID" || code === "CHANGE_REQ_LEDGER_WRITE_VERIFY_FAILED" || code === "CHANGE_REQ_STORE_ERROR") {
    return 1;
  }
  if (
    code === "CHANGE_REQ_MERGED" ||
    code === "CHANGE_REQ_STILL_OBSERVED" ||
    code === "CHANGE_REQ_TRANSITION_INVALID" ||
    code === "CHANGE_REQ_STATUS_UNCHANGED"
  ) {
    return 2;
  }
  return result.ok ? 0 : 1;
}

/** 一行摘要。 */
function formatRequest(request: RequestLike): string {
  const extra: string[] = [];
  if (request.release) extra.push(`release=${request.release.version}`);
  if (request.verification) extra.push(`verified=${request.verification.stillObserved ? "still" : "gone"}`);
  if (request.supersededBy) extra.push(`→${request.supersededBy}`);
  return `${request.id}  ${request.status}  ${request.kind}  ${request.target.module}${
    request.target.symbol ? `#${request.target.symbol}` : ""
  }${extra.length > 0 ? `  [${extra.join(" ")}]` : ""}  ${clip(request.title)}`;
}

/** --show 的人读视图。 */
function formatDetail(request: RequestLike): string {
  const lines = [
    `id=${request.id}`,
    `status=${request.status}`,
    `kind=${request.kind}`,
    `module=${request.target.module}${request.target.symbol ? `#${request.target.symbol}` : ""}`,
    `title=${request.title}`,
    `dedupeKey=${request.dedupeKey}`,
    `provenance=${request.provenance}`,
    `createdAt=${iso(request.createdAt)} updatedAt=${iso(request.updatedAt)}`,
    `evidenceRefs=[${request.evidenceRefs.join(",")}]`,
    `reproSteps=${request.reproSteps.length}`,
    `expected=${clip(request.expectedBehavior, 100)}`,
    `observed=${clip(request.observedBehavior, 100)}`,
  ];
  if (request.release) lines.push(`release=${request.release.version}@${iso(request.release.at)}`);
  if (request.verification) {
    lines.push(
      `verification.checkedAt=${iso(request.verification.checkedAt)} stillObserved=${request.verification.stillObserved}`,
    );
  }
  if (request.supersededBy) lines.push(`supersededBy=${request.supersededBy}`);
  if (request.lastTransition) {
    const lt = request.lastTransition;
    lines.push(`lastTransition=${lt.to}${lt.by ? ` by ${lt.by}` : ""}${lt.note ? ` (${lt.note})` : ""} @${iso(lt.at)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** 打印结果:成功走 stdout,失败码走 stderr;稳定码始终打出来。 */
function report(result: StoreResult, stdout: string): number {
  const code = result.code;
  if (!result.ok) {
    process.stderr.write(`${code ?? "CHANGE_REQ_STORE_ERROR"}\n`);
    if (result.request !== undefined) process.stderr.write(formatDetail(result.request));
    return exitFor(result);
  }
  if (code !== undefined) process.stdout.write(`code=${code}\n`);
  process.stdout.write(stdout);
  return exitFor(result);
}

async function main(): Promise<number> {
  const args = parseArgv(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.root === undefined) throw new Error("--root 必填");

  const root = args.root;
  const store = await loadStore();

  if (args.create !== undefined) {
    const input = await readJsonSource(args.create);
    const result = store.createRequest(root, input);
    if (args.json) {
      if (!result.ok) process.stderr.write(`${result.code ?? "CHANGE_REQ_STORE_ERROR"}\n`);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return exitFor(result);
    }
    const request = result.request;
    const stdout = `id=${result.id} merged=${result.merged === true} status=${request?.status ?? ""} evidenceRefs=${
      request?.evidenceRefs.length ?? 0
    } reproSteps=${request?.reproSteps.length ?? 0}\n`;
    return report(result, stdout);
  }

  if (args.list) {
    const list = store.listRequests(root, { status: args.status });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(list)}\n`);
      return 0;
    }
    if (list.requests.length === 0) process.stdout.write("(无提案)\n");
    for (const request of list.requests) process.stdout.write(`${formatRequest(request)}\n`);
    process.stdout.write(`total=${list.requests.length} parseErrors=${list.parseErrors}\n`);
    return 0;
  }

  if (args.show !== undefined) {
    const result = store.getRequest(root, args.show);
    if (!result.ok) return report(result, "");
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result.request)}\n`);
      return 0;
    }
    process.stdout.write(formatDetail(result.request!));
    return 0;
  }

  if (args.transition !== undefined) {
    if (args.by === undefined) throw new Error("--transition 需要 --by");
    const result = store.transition(root, args.transition.id, args.transition.to, {
      by: args.by,
      note: args.note,
    });
    return report(result, `transitioned ${args.transition.id} → ${result.request?.status ?? ""}\n`);
  }

  if (args.ship !== undefined) {
    if (args.version === undefined) throw new Error("--ship 需要 --version");
    const result = store.ship(root, args.ship, { version: args.version });
    return report(result, `shipped ${args.ship} version=${result.request?.release?.version ?? args.version}\n`);
  }

  if (args.verify !== undefined) {
    if (args.observed === undefined) throw new Error("--verify 需要 --observed true|false");
    const result = store.verify(root, args.verify, { observed: args.observed, note: args.note });
    return report(
      result,
      `verified ${args.verify} → status=${result.request?.status ?? ""} stillObserved=${
        result.request?.verification?.stillObserved ?? ""
      }\n`,
    );
  }

  if (args.supersede !== undefined) {
    if (args.byId === undefined) throw new Error("--supersede 需要 --by-id");
    const result = store.supersede(root, args.supersede, { byId: args.byId });
    return report(result, `superseded ${args.supersede} by ${args.byId}\n`);
  }

  if (args.export !== undefined) {
    const result = store.exportMarkdown(root, args.export);
    if (!result.ok) return report(result, "");
    const text = await readFile(result.path!, "utf8").catch(() => "");
    process.stdout.write(`exported ${args.export} → ${result.path}\n${text}`);
    return 0;
  }

  if (args.report) {
    const reportData = store.reportRequests(root);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(reportData)}\n`);
      return 0;
    }
    process.stdout.write(
      [
        `total=${reportData.total} parseErrors=${reportData.parseErrors} totalLines=${reportData.totalLines}`,
        `byStatus=${JSON.stringify(reportData.byStatus)}`,
        `byKind=${JSON.stringify(reportData.byKind)}`,
        `openAged.olderThanDays=${reportData.openAged.olderThanDays} count=${reportData.openAged.count} ids=[${reportData.openAged.ids.join(",")}]`,
      ].join("\n") + "\n",
    );
    return 0;
  }

  throw new Error("需要指定一个动作(--create/--list/--show/--transition/--ship/--verify/--supersede/--export/--report)");
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
