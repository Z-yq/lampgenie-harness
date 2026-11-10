#!/usr/bin/env -S npx tsx
/**
 * 工作流留白 CLI(tsx 直跑 / node --experimental-strip-types 均可):scan / reach / fill / chain / report。
 *
 * 用法:
 *   tsx scripts/workflow-hole.mts --help
 *   node --experimental-strip-types scripts/workflow-hole.mts --root /tmp/wh --scan /tmp/wh/flow.mjs [--id wf-a]
 *   tsx scripts/workflow-hole.mts --root /tmp/wh --reach wf-a --site 1a2b3c4d
 *   tsx scripts/workflow-hole.mts --root /tmp/wh --fill wf-a --site 1a2b3c4d --body /tmp/wh/body.mjs
 *   tsx scripts/workflow-hole.mts --root /tmp/wh --chain wf-a --name review --prompt "谁来做评审"
 *   tsx scripts/workflow-hole.mts --root /tmp/wh --report [--json]
 *
 * 退出码:0 成功;1 参数错 / 其他失败(含 WORKFLOW_HOLE_NOT_FOUND / INVALID_INPUT / STORE_ERROR);
 *         2 拒绝拼接(HOLE_SITE_DRIFT 漂移 / HOLE_INVALID_BODY 坏体 / HOLE_COMPILE_FAILED 编译失败)。
 * 落盘位置:`<root>/.genie/rsi/holes.json` + `<root>/drafts/<id>.mjs`(真实运行请只给 /tmp 下的 root)。
 * --help 不加载 store 面(纯静态用法文本)。
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

/** 站点视图(store 返回的 HoleState 里我们关心的字段)。 */
interface SiteLike {
  siteId: string;
  name: string;
  prompt: string;
  line: number;
  status: string;
  bodyHash?: string;
}

interface StateLike {
  script: { id: string; source: string; hash: string };
  sites: Record<string, SiteLike>;
  memory: Record<string, { body: string; at: number }>;
  stoppedAt?: string;
}

/** 各动作的返回形状(store 层统一为 {ok,codes,...})。 */
interface StoreResult {
  ok: boolean;
  codes?: string[];
  code?: string;
  state?: StateLike;
  site?: SiteLike;
  event?: { type: string; siteId: string; draftPath: string; line: number };
  draftPath?: string;
  count?: number;
  resumed?: boolean;
  reason?: string;
  parseErrors?: number;
}

interface ReportResult {
  ok: boolean;
  total: number;
  byStatus: { waiting: number; filled: number };
  waitingSites: number;
  memoryHits: number;
  drafts: number;
  parseErrors: number;
}

interface StoreModule {
  scanScript(root: string, input: { id?: string; source?: string; file?: string }): StoreResult;
  reachHoleAt(root: string, id: string, siteId: string): StoreResult;
  fillHoleAt(root: string, id: string, input: { siteId: string; body: string }): StoreResult;
  chainHoleAt(root: string, id: string, input: { name: string; prompt: string }): StoreResult;
  getState(root: string, id: string): StoreResult;
  reportHoles(root: string): ReportResult;
}

interface ParsedArgs {
  root?: string;
  scan?: string;
  id?: string;
  reach?: string;
  fill?: string;
  chain?: string;
  site?: string;
  body?: string;
  name?: string;
  prompt?: string;
  report: boolean;
  json: boolean;
  help: boolean;
}

const USAGE = `工作流留白 CLI(hole/fill)

用法:
  tsx scripts/workflow-hole.mts --root <dir> --scan <file> [--id <id>] [--json]
  tsx scripts/workflow-hole.mts --root <dir> --reach <id> --site <siteId> [--json]
  tsx scripts/workflow-hole.mts --root <dir> --fill <id> --site <siteId> --body <file> [--json]
  tsx scripts/workflow-hole.mts --root <dir> --chain <id> --name <n> --prompt <p> [--json]
  tsx scripts/workflow-hole.mts --root <dir> --report [--json]
  tsx scripts/workflow-hole.mts --help

选项:
  --root <dir>     台账根目录(必填;states 落 <root>/.genie/rsi/holes.json,draft 落 <root>/drafts/<id>.mjs)
  --scan <file>    扫描脚本里的 hole 调用并落盘(不给 --id 时用 wf-<hash 前 6>)
  --id <id>        指定工作流 id(--scan 时)
  --reach <id>     到达留白点(停驻该分支,不写 node row)
  --fill <id>      填充留白点(只提交函数体语句)
  --chain <id>     在脚本尾部再长一个留白点
  --site <siteId>  --reach / --fill 的目标站点
  --body <file>    --fill 的函数体文件;"-" 表示 stdin
  --name/--prompt  --chain 新留白的名字与提示语
  --report         汇总报表(total / byStatus / memoryHits / drafts / parseErrors)
  --json           机器可读输出
  --help           打印本用法(不加载 store)

退出码:
  0 成功;1 参数错 / 其他失败;2 拒绝拼接(HOLE_SITE_DRIFT / HOLE_INVALID_BODY / HOLE_COMPILE_FAILED)
`;

/** 参数解析:错误一律抛(由 main 折叠成退出码 1)。 */
function parseArgv(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { report: false, json: false, help: false };
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
      case "--scan":
        out.scan = valueOf(i, arg);
        i += 1;
        break;
      case "--id":
        out.id = valueOf(i, arg);
        i += 1;
        break;
      case "--reach":
        out.reach = valueOf(i, arg);
        i += 1;
        break;
      case "--fill":
        out.fill = valueOf(i, arg);
        i += 1;
        break;
      case "--chain":
        out.chain = valueOf(i, arg);
        i += 1;
        break;
      case "--site":
        out.site = valueOf(i, arg);
        i += 1;
        break;
      case "--body":
        out.body = valueOf(i, arg);
        i += 1;
        break;
      case "--name":
        out.name = valueOf(i, arg);
        i += 1;
        break;
      case "--prompt":
        out.prompt = valueOf(i, arg);
        i += 1;
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

/** 读 stdin 全文(--body -)。 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

/** 读函数体文件或 stdin("-")。 */
async function readBodySource(src: string): Promise<string> {
  return src === "-" ? await readStdin() : readFile(resolve(src), "utf8");
}

/** store 面(惰性解析:--help 不触发任何 import)。 */
async function loadStore(): Promise<StoreModule> {
  return (await import("../apps/gateway/src/workflow-hole-store.ts")) as unknown as StoreModule;
}

/** 退出码约定(见文件头):拒绝拼接单独给 2,别和参数错混在一起。 */
function exitFor(result: { ok: boolean; codes?: string[]; code?: string }): number {
  const codes = result.codes ?? (result.code !== undefined ? [result.code] : []);
  if (codes.some((c) => c === "HOLE_SITE_DRIFT" || c === "HOLE_INVALID_BODY" || c === "HOLE_COMPILE_FAILED")) return 2;
  return result.ok ? 0 : 1;
}

/** 机器可读摘要(state 只留摘要,不吐整份 source)。 */
function stateSummary(state: StateLike, draftPath?: string): Record<string, unknown> {
  const sites = Object.values(state.sites);
  return {
    id: state.script.id,
    hash: state.script.hash,
    lines: state.script.source.split("\n").length,
    stoppedAt: state.stoppedAt ?? null,
    draftPath: draftPath ?? null,
    sites: sites.map((s) => ({
      siteId: s.siteId,
      name: s.name,
      prompt: s.prompt,
      line: s.line,
      status: s.status,
      bodyHash: s.bodyHash ?? null,
    })),
  };
}

/** 一条站点的可读行。 */
function formatSite(site: SiteLike): string {
  const prompt = site.prompt.length > 40 ? `${site.prompt.slice(0, 39)}…` : site.prompt;
  return `  ${site.siteId}  line=${site.line}  ${site.status}  ${site.name}  "${prompt}"`;
}

/** 统一出口:失败打稳定码到 stderr;成功打 code + 摘要到 stdout。 */
function emit(args: ParsedArgs, result: StoreResult, stdout: string): number {
  const codes = result.codes ?? [];
  if (!result.ok) {
    if (args.json) process.stdout.write(`${JSON.stringify({ ok: false, codes, reason: result.reason ?? null })}\n`);
    process.stderr.write(`${codes.join(",") || "WORKFLOW_HOLE_STORE_ERROR"}${result.reason ? ` ${result.reason}` : ""}\n`);
    return exitFor(result);
  }
  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        codes,
        state: result.state !== undefined ? stateSummary(result.state, result.draftPath) : null,
        site: result.site ?? null,
        event: result.event ?? null,
        resumed: result.resumed ?? null,
        draftPath: result.draftPath ?? null,
      })}\n`,
    );
    return exitFor(result);
  }
  if (codes.length > 0) process.stdout.write(`code=${codes.join(",")}\n`);
  process.stdout.write(stdout);
  return exitFor(result);
}

/** --report 人读视图。 */
function formatReport(report: ReportResult): string {
  return [
    `total=${report.total} byStatus=${JSON.stringify(report.byStatus)} waitingSites=${report.waitingSites}`,
    `memoryHits=${report.memoryHits} drafts=${report.drafts} parseErrors=${report.parseErrors}`,
  ].join("\n") + "\n";
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

  if (args.scan !== undefined) {
    const result = store.scanScript(root, {
      file: resolve(args.scan),
      ...(args.id !== undefined ? { id: args.id } : {}),
    });
    const state = result.state;
    const stdout =
      state === undefined
        ? ""
        : [
            `scanned ${state.script.id} hash=${state.script.hash} sites=${Object.keys(state.sites).length} draft=${result.draftPath ?? ""}`,
            ...Object.values(state.sites).map(formatSite),
          ].join("\n") + "\n";
    return emit(args, result, stdout);
  }

  if (args.reach !== undefined) {
    if (args.site === undefined) throw new Error("--reach 需要 --site");
    const result = store.reachHoleAt(root, args.reach, args.site);
    const stdout =
      result.event === undefined
        ? ""
        : `reached ${result.event.siteId} line=${result.event.line} waiting draft=${result.event.draftPath}\n`;
    return emit(args, result, stdout);
  }

  if (args.fill !== undefined) {
    if (args.site === undefined) throw new Error("--fill 需要 --site");
    if (args.body === undefined) throw new Error("--fill 需要 --body");
    const body = await readBodySource(args.body);
    const result = store.fillHoleAt(root, args.fill, { siteId: args.site, body });
    const state = result.state;
    const hash = state !== undefined ? `hash=${state.script.hash}` : "";
    const stdout = `filled ${args.site} status=filled ${hash} bodyHash=${
      result.site?.bodyHash ?? ""
    } resumed=${result.resumed === true}\n`;
    return emit(args, result, stdout);
  }

  if (args.chain !== undefined) {
    if (args.name === undefined) throw new Error("--chain 需要 --name");
    const result = store.chainHoleAt(root, args.chain, { name: args.name, prompt: args.prompt ?? "" });
    const site = result.site;
    const stdout =
      site === undefined
        ? ""
        : `chained ${site.name} site=${site.siteId} line=${site.line} sites=${
            result.state !== undefined ? Object.keys(result.state.sites).length : 0
          }\n`;
    return emit(args, result, stdout);
  }

  if (args.report) {
    const report = store.reportHoles(root);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
      return 0;
    }
    process.stdout.write(formatReport(report));
    return 0;
  }

  throw new Error("需要指定一个动作(--scan/--reach/--fill/--chain/--report)");
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
