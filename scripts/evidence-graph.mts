#!/usr/bin/env -S npx tsx
/**
 * 证据图谱 CLI(tsx 直跑):add / supersede / correct / authoritative / query / conflicts / history / decay / rescore-model / report。
 *
 * 用法:
 *   tsx scripts/evidence-graph.mts --help
 *   tsx scripts/evidence-graph.mts --root /tmp/evg --add /tmp/ev.json        # "-" 从 stdin 读
 *   tsx scripts/evidence-graph.mts --root /tmp/evg --supersede <id> --file /tmp/ev.json --by lead --reason "新证据"
 *   tsx scripts/evidence-graph.mts --root /tmp/evg --correct <id> [--statement s] [--confidence n] --by u --reason r
 *   tsx scripts/evidence-graph.mts --root /tmp/evg --authoritative <id>
 *   tsx scripts/evidence-graph.mts --root /tmp/evg --query [--kind fact] [--project p] [--module m] [--tool t] [--tip t] [--at ISO] [--history] [--json]
 *   tsx scripts/evidence-graph.mts --root /tmp/evg --conflicts [--json]
 *   tsx scripts/evidence-graph.mts --root /tmp/evg --history <id> [--json]
 *   tsx scripts/evidence-graph.mts --root /tmp/evg --decay --half-life-days 7 --stale-below 0.4 --archive-below 0.1 --max-nodes 100 [--apply] [--json]
 *   tsx scripts/evidence-graph.mts --root /tmp/evg --report [--json]
 *
 * 退出码:0 成功;1 运行/校验失败(码打到 stderr);2 参数错误;3 重复证据(EVIDENCE_DUPLICATE)。
 * 落盘位置:`<root>/.genie/evidence/graph.jsonl`(真实运行请只给 /tmp 下的 root)。
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

/** store 面(惰性解析:--help 不触发任何 imports)。 */
interface StoreModule {
  addEvidence(root: string, input: unknown): { ok: boolean; code?: string; id?: string };
  supersedeEvidence(
    root: string,
    oldId: string,
    input: unknown,
    opts: { by?: string; reason?: string; at?: number },
  ): { ok: boolean; code?: string; id?: string };
  correctEvidence(
    root: string,
    id: string,
    input: { statement?: string; confidence?: number; by?: string; reason?: string; at?: number },
  ): { ok: boolean; code?: string; id?: string };
  markAuthoritative(root: string, id: string): { ok: boolean; code?: string; id?: string };
  queryEvidence(root: string, filter: Record<string, unknown>): Array<Record<string, unknown>>;
  conflicts(root: string, at?: number): Array<Record<string, unknown>>;
  history(root: string, id: string): Array<Record<string, unknown>>;
  applyDecay(root: string, policy: Record<string, unknown>): { ok: boolean; code?: string; report?: Record<string, unknown> };
  rescoreForModelVersion(
    root: string,
    modelVersion: string,
    opts?: { apply?: boolean; at?: number },
  ): { ok: boolean; code?: string; rescored: string[]; ids?: string[]; statuses?: Record<string, string>; preview?: boolean };
  loadEvidenceGraph(root: string): { graph: { nodes: Record<string, Record<string, unknown>> } };
  reportEvidence(root: string): Record<string, unknown>;
  evidenceGraphPath(root: string): string;
}

/** runtime 纯逻辑面(--decay 预览用,不写盘)。 */
interface RuntimeModule {
  applyDecay(
    graph: unknown,
    policy: Record<string, unknown>,
  ): { ok: boolean; report: Record<string, unknown> };
}

interface ParsedArgs {
  root: string;
  add?: string;
  supersede?: string;
  correct?: string;
  authoritative?: string;
  query: boolean;
  conflicts: boolean;
  history?: string;
  includeHistory: boolean;
  decay: boolean;
  rescoreModel?: string;
  report: boolean;
  apply: boolean;
  json: boolean;
  help: boolean;
  file?: string;
  statement?: string;
  confidence?: number;
  by?: string;
  reason?: string;
  kind?: string;
  project?: string;
  module?: string;
  tool?: string;
  tip?: string;
  at?: number;
  halfLifeDays?: number;
  staleBelow?: number;
  archiveBelow?: number;
  maxNodes?: number;
}

const USAGE = `证据图谱 CLI(append-only jsonl)

用法:
  tsx scripts/evidence-graph.mts [--root <dir>] --add <file.json|->             追加证据
  tsx scripts/evidence-graph.mts [--root <dir>] --supersede <id> --file <f> --by <name> --reason <text>
  tsx scripts/evidence-graph.mts [--root <dir>] --correct <id> [--statement <s>] [--confidence <n>] --by <name> --reason <text>
  tsx scripts/evidence-graph.mts [--root <dir>] --authoritative <id>            指定权威版
  tsx scripts/evidence-graph.mts [--root <dir>] --query [--kind <k>] [--project <p>] [--module <m>] [--tool <t>] [--tip <t>] [--at <ISO>] [--history]
  tsx scripts/evidence-graph.mts [--root <dir>] --conflicts
  tsx scripts/evidence-graph.mts [--root <dir>] --history <id>
  tsx scripts/evidence-graph.mts [--root <dir>] --decay --half-life-days <N> --stale-below <x> [--archive-below <y>] [--max-nodes <N>] [--apply]
  tsx scripts/evidence-graph.mts [--root <dir>] --rescore-model <version> [--apply] [--json]
  tsx scripts/evidence-graph.mts [--root <dir>] --report
  tsx scripts/evidence-graph.mts --help

选项:
  --root <dir>       图谱根目录(缺省 process.cwd();落在 <root>/.genie/evidence/graph.jsonl)
  --add <path>       证据 JSON 文件;"-" 表示 stdin
  --file <path>      supersede 用新证据 JSON 文件
  --supersede <id>   用新证据取代指定 id
  --correct <id>     纠正指定 id(生成新版本,历史保留)
  --authoritative <id> 指定权威版(同冲突组其它降为 latest)
  --query            查询(默认只看当前有效 + active;--history 放开全部版本)
  --history <id>     查看版本链(oldest→newest)
  --conflicts        列出显式冲突组(并存节点 + latest/authoritative)
  --decay            衰减评估;不带 --apply 只预览不写盘(--stale-below 缺省 0.5)
  --rescore-model <v> 模型换代重估:旧 modelVersion 的 active 证据置 stale;不带 --apply 只预览
  --report           汇总报告
  --at <ISO>         查询/评估的时间点(ISO 字符串)
  --kind <k>         fact|insight|anti-pattern|direction
  --project/--module/--tool/--tip <v>  关联过滤
  --half-life-days/--stale-below/--archive-below/--max-nodes  衰减策略
  --apply            真正落盘(decay / rescore-model)
  --json             机器可读输出
  --help             打印本用法

退出码:
  0 成功;1 运行/校验失败(码在 stderr);2 参数错误;3 重复证据
`;

/** 手写 argv 解析:--key value 与开关两种;未知选项/缺值抛错(由 main 折成 exit 2)。 */
function parseArgv(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    root: process.cwd(),
    query: false,
    conflicts: false,
    includeHistory: false,
    decay: false,
    report: false,
    apply: false,
    json: false,
    help: false,
  };
  const valueOf = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} 缺少取值`);
    return v;
  };
  const numOf = (i: number, flag: string): number => {
    const raw = valueOf(i, flag);
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${flag} 需要数字,收到 ${raw}`);
    return n;
  };
  const isoOf = (i: number, flag: string): number => {
    const raw = valueOf(i, flag);
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) throw new Error(`${flag} 需要 ISO 时间,收到 ${raw}`);
    return ms;
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
      case "--add":
        out.add = valueOf(i, arg);
        i += 1;
        break;
      case "--file":
        out.file = valueOf(i, arg);
        i += 1;
        break;
      case "--supersede":
        out.supersede = valueOf(i, arg);
        i += 1;
        break;
      case "--correct":
        out.correct = valueOf(i, arg);
        i += 1;
        break;
      case "--authoritative":
        out.authoritative = valueOf(i, arg);
        i += 1;
        break;
      case "--query":
        out.query = true;
        break;
      case "--conflicts":
        out.conflicts = true;
        break;
      case "--history": {
        // 两义:--history <id> 看版本链;--query --history 放开历史版本(后面没有取值即后者)。
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          out.history = next;
          i += 1;
        } else {
          out.includeHistory = true;
        }
        break;
      }
      case "--decay":
        out.decay = true;
        break;
      case "--report":
        out.report = true;
        break;
      case "--apply":
        out.apply = true;
        break;
      case "--json":
        out.json = true;
        break;
      case "--statement":
        out.statement = valueOf(i, arg);
        i += 1;
        break;
      case "--confidence":
        out.confidence = numOf(i, arg);
        i += 1;
        break;
      case "--by":
        out.by = valueOf(i, arg);
        i += 1;
        break;
      case "--reason":
        out.reason = valueOf(i, arg);
        i += 1;
        break;
      case "--kind":
        out.kind = valueOf(i, arg);
        i += 1;
        break;
      case "--project":
        out.project = valueOf(i, arg);
        i += 1;
        break;
      case "--module":
        out.module = valueOf(i, arg);
        i += 1;
        break;
      case "--tool":
        out.tool = valueOf(i, arg);
        i += 1;
        break;
      case "--tip":
        out.tip = valueOf(i, arg);
        i += 1;
        break;
      case "--at":
        out.at = isoOf(i, arg);
        i += 1;
        break;
      case "--half-life-days":
        out.halfLifeDays = numOf(i, arg);
        i += 1;
        break;
      case "--stale-below":
        out.staleBelow = numOf(i, arg);
        i += 1;
        break;
      case "--archive-below":
        out.archiveBelow = numOf(i, arg);
        i += 1;
        break;
      case "--max-nodes":
        out.maxNodes = numOf(i, arg);
        i += 1;
        break;
      case "--rescore-model":
        out.rescoreModel = valueOf(i, arg);
        i += 1;
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
  return (await import("../apps/gateway/src/evidence-graph-store.ts")) as unknown as StoreModule;
}

async function loadRuntime(): Promise<RuntimeModule> {
  return (await import("../packages/harness-runtime/src/agent/evidence-graph.ts")) as unknown as RuntimeModule;
}

function iso(ms: unknown): string {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

function clip(text: unknown, n = 60): string {
  const s = typeof text === "string" ? text : JSON.stringify(text);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** 节点一行摘要。 */
function formatNode(node: Record<string, unknown>): string {
  const flags: string[] = [];
  if (node["authoritativeness"] === "authoritative") flags.push("authoritative");
  if (node["supersededBy"]) flags.push(`→${node["supersededBy"]}`);
  return `${node["id"]}  ${node["kind"]}  ${node["status"]}  c=${node["confidence"]}  from=${iso(node["validFrom"])}${
    node["validTo"] ? `  to=${iso(node["validTo"])}` : ""
  }${flags.length ? `  [${flags.join(" ")}]` : ""}  ${clip(node["statement"])}`;
}

function exitFor(result: { ok: boolean; code?: string }): number {
  if (result.ok) return 0;
  if (result.code === "EVIDENCE_DUPLICATE") return 3;
  return 1;
}

async function main(): Promise<number> {
  const args = parseArgv(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const store = await loadStore();

  if (args.add !== undefined) {
    const input = await readJsonSource(args.add);
    const result = store.addEvidence(args.root, input);
    if (!result.ok) {
      process.stderr.write(`${result.code ?? "EVIDENCE_STORE_ERROR"}\n`);
      return exitFor(result);
    }
    process.stdout.write(args.json ? `${JSON.stringify(result)}\n` : `added ${result.id}\n`);
    return 0;
  }

  if (args.supersede !== undefined) {
    if (!args.file || !args.by || !args.reason) throw new Error("--supersede 需要 --file --by --reason");
    const input = await readJsonSource(args.file);
    const result = store.supersedeEvidence(args.root, args.supersede, input, {
      by: args.by,
      reason: args.reason,
      at: args.at,
    });
    if (!result.ok) {
      process.stderr.write(`${result.code ?? "EVIDENCE_STORE_ERROR"}\n`);
      return exitFor(result);
    }
    process.stdout.write(args.json ? `${JSON.stringify(result)}\n` : `superseded ${args.supersede} → ${result.id}\n`);
    return 0;
  }

  if (args.correct !== undefined) {
    if (!args.by || !args.reason) throw new Error("--correct 需要 --by --reason");
    if (args.statement === undefined && args.confidence === undefined) {
      throw new Error("--correct 至少要给 --statement 或 --confidence");
    }
    const result = store.correctEvidence(args.root, args.correct, {
      statement: args.statement,
      confidence: args.confidence,
      by: args.by,
      reason: args.reason,
      at: args.at,
    });
    if (!result.ok) {
      process.stderr.write(`${result.code ?? "EVIDENCE_STORE_ERROR"}\n`);
      return exitFor(result);
    }
    process.stdout.write(args.json ? `${JSON.stringify(result)}\n` : `corrected ${args.correct} → ${result.id}\n`);
    return 0;
  }

  if (args.authoritative !== undefined) {
    const result = store.markAuthoritative(args.root, args.authoritative);
    if (!result.ok) {
      process.stderr.write(`${result.code ?? "EVIDENCE_STORE_ERROR"}\n`);
      return exitFor(result);
    }
    process.stdout.write(args.json ? `${JSON.stringify(result)}\n` : `authoritative ${args.authoritative}\n`);
    return 0;
  }

  if (args.query) {
    const filter: Record<string, unknown> = {
      at: args.at,
      includeHistory: args.includeHistory,
      kind: args.kind,
      projectId: args.project,
      module: args.module,
      tool: args.tool,
      tip: args.tip,
    };
    for (const key of Object.keys(filter)) if (filter[key] === undefined) delete filter[key];
    const nodes = store.queryEvidence(args.root, filter);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(nodes, null, 2)}\n`);
    } else if (nodes.length === 0) {
      process.stdout.write("(无匹配证据)\n");
    } else {
      for (const node of nodes) process.stdout.write(`${formatNode(node)}\n`);
    }
    return 0;
  }

  if (args.conflicts) {
    const groups = store.conflicts(args.root, args.at);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(groups, null, 2)}\n`);
    } else if (groups.length === 0) {
      process.stdout.write("(无冲突)\n");
    } else {
      for (const group of groups) {
        const nodes = group["nodes"] as Array<Record<string, unknown>>;
        process.stdout.write(
          `conflict ${group["associationKey"]} (${group["kind"]}) latest=${group["latestId"]}${
            group["authoritativeId"] ? ` authoritative=${group["authoritativeId"]}` : ""
          }\n`,
        );
        for (const node of nodes) process.stdout.write(`  ${formatNode(node)}\n`);
      }
    }
    return 0;
  }

  if (args.history !== undefined) {
    const chain = store.history(args.root, args.history);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(chain, null, 2)}\n`);
    } else if (chain.length === 0) {
      process.stdout.write("(未找到该 id)\n");
    } else {
      chain.forEach((node, index) => process.stdout.write(`v${index + 1}  ${formatNode(node)}\n`));
    }
    return 0;
  }

  if (args.decay) {
    if (args.halfLifeDays === undefined) {
      throw new Error("--decay 需要 --half-life-days");
    }
    const policy: Record<string, unknown> = {
      at: args.at,
      halfLifeDays: args.halfLifeDays,
      staleBelow: args.staleBelow ?? 0.5,
      archiveBelow: args.archiveBelow,
      maxNodes: args.maxNodes,
    };
    for (const key of Object.keys(policy)) if (policy[key] === undefined) delete policy[key];

    if (args.apply) {
      const result = store.applyDecay(args.root, policy);
      if (!result.ok) {
        process.stderr.write(`${result.code ?? "EVIDENCE_STORE_ERROR"}\n`);
        return 1;
      }
      process.stdout.write(args.json ? `${JSON.stringify(result.report)}\n` : formatDecayReport(result.report!));
      return 0;
    }

    const runtime = await loadRuntime();
    const projection = store.loadEvidenceGraph(args.root);
    const preview = runtime.applyDecay(projection.graph, policy);
    if (!preview.ok) {
      process.stderr.write("EVIDENCE_INVALID_INPUT\n");
      return 1;
    }
    process.stdout.write(
      args.json ? `${JSON.stringify(preview.report)}\n` : `(dry-run,未写盘)\n${formatDecayReport(preview.report)}`,
    );
    return 0;
  }

  if (args.rescoreModel !== undefined) {
    const result = store.rescoreForModelVersion(args.root, args.rescoreModel, {
      apply: args.apply,
      at: args.at,
    });
    if (!result.ok) {
      process.stderr.write(`${result.code ?? "EVIDENCE_STORE_ERROR"}\n`);
      return 1;
    }
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      const ids = result.ids ?? result.rescored;
      process.stdout.write(
        `rescored=${result.rescored.length} ids=[${ids.join(",")}] ${
          result.preview ? "(dry-run,未写盘)" : "(applied)"
        }\n`,
      );
    }
    return 0;
  }

  if (args.report) {
    const report = store.reportEvidence(args.root);
    process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
    return 0;
  }

  throw new Error("需要指定一个动作(--add/--supersede/--correct/--authoritative/--query/--conflicts/--history/--decay/--report)");
}

function formatDecayReport(report: Record<string, unknown>): string {
  return [
    `at=${iso(report["at"])}`,
    `stale=${report["stale"]} archived=${report["archived"]} evicted=${report["evicted"]} rescored=${report["rescored"]}`,
    `staleIds=[${(report["staleIds"] as string[] | undefined)?.join(",") ?? ""}]`,
    `archivedIds=[${(report["archivedIds"] as string[] | undefined)?.join(",") ?? ""}]`,
    `evictedIds=[${(report["evictedIds"] as string[] | undefined)?.join(",") ?? ""}]`,
  ].join("\n");
}

function formatReport(report: Record<string, unknown>): string {
  return [
    `nodes=${report["nodes"]} active=${report["active"]} stale=${report["stale"]} archived=${report["archived"]}`,
    `conflicts=${report["conflicts"]} parseErrors=${report["parseErrors"]} totalLines=${report["totalLines"]}`,
    `byKind=${JSON.stringify(report["byKind"])}`,
  ].join("\n");
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
