#!/usr/bin/env -S npx tsx
/**
 * 自我修改安全门 CLI(tsx 直跑):request / approve / deny / apply / rollback / list / report。
 *
 * 门的口径(runtime self-modification):证据 + 影响面 + dry-run + canary + rollback point + owner 六件套;
 * RSI 生成改动必须人类审批;不可逆改动必须人类审批;apply 前按冻结 hash 复核(MOD_HASH_MISMATCH)。
 *
 * 用法:
 *   tsx scripts/self-modification.mts --help
 *   tsx scripts/self-modification.mts --root /tmp/selfmod --request /tmp/selfmod/req.json
 *   tsx scripts/self-modification.mts --root /tmp/selfmod --request - < req.json
 *   tsx scripts/self-modification.mts --root /tmp/selfmod --approve <id> --by <name> [--kind human|owner] [--reason "..."]
 *   tsx scripts/self-modification.mts --root /tmp/selfmod --deny <id> --reason "..."
 *   tsx scripts/self-modification.mts --root /tmp/selfmod --apply <id> [--frozen-hash <h>]
 *   tsx scripts/self-modification.mts --root /tmp/selfmod --rollback <id> --reason "..."
 *   tsx scripts/self-modification.mts --root /tmp/selfmod --list [--json]
 *   tsx scripts/self-modification.mts --root /tmp/selfmod --report [--json]
 *
 * 退出码:0 成功;1 运行/校验失败;2 被门拒(deny 或 need-approval,codes 打 stderr);
 *        3 重复请求 / 已是终态。
 * 落盘位置:`<root>/.genie/self-mod/requests.jsonl`(真实运行只给 /tmp 下的 root)。
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

/** store 面(惰性解析:--help 不触发任何 imports)。 */
interface StoreModule {
  selfModificationPath(root: string): string;
  requestModification(
    root: string,
    req: unknown,
    policy?: { requireCanary?: boolean; allowAgentSelfApprove?: boolean },
  ): { ok: boolean; id?: string; code?: string; decision?: string; codes: string[]; details?: string[] };
  approveModification(
    root: string,
    id: string,
    opts?: { by?: string; kind?: "human" | "owner" | "agent"; reason?: string },
  ): { ok: boolean; id?: string; code?: string; decision?: string; codes: string[] };
  denyModification(
    root: string,
    id: string,
    opts?: { by?: string; reason?: string },
  ): { ok: boolean; id?: string; code?: string; decision?: string; codes: string[] };
  markApplied(
    root: string,
    id: string,
    opts?: { frozenHash?: string },
  ): { ok: boolean; id?: string; code?: string; decision?: string; codes: string[]; frozenHash?: string };
  rollbackModification(
    root: string,
    id: string,
    opts?: { reason?: string },
  ): { ok: boolean; id?: string; code?: string; decision?: string; codes: string[] };
  listModifications(
    root: string,
    filter?: { surface?: string; decision?: string },
  ): Array<Record<string, unknown>>;
  getModification(root: string, id: string): Record<string, unknown> | undefined;
  reportModifications(root: string): Record<string, unknown>;
}

type ParsedArgs = {
  root: string;
  request?: string;
  approve?: string;
  deny?: string;
  apply?: string;
  rollback?: string;
  by?: string;
  kind?: string;
  reason?: string;
  frozenHash?: string;
  list: boolean;
  report: boolean;
  json: boolean;
  help: boolean;
};

const USAGE = `自我修改安全门 CLI(append-only jsonl)

用法:
  tsx scripts/self-modification.mts [--root <dir>] --request <file.json|->
  tsx scripts/self-modification.mts [--root <dir>] --approve <id> --by <name> [--kind human|owner] [--reason <text>]
  tsx scripts/self-modification.mts [--root <dir>] --deny <id> --reason <text>
  tsx scripts/self-modification.mts [--root <dir>] --apply <id> [--frozen-hash <h>]
  tsx scripts/self-modification.mts [--root <dir>] --rollback <id> --reason <text>
  tsx scripts/self-modification.mts [--root <dir>] --list [--json]
  tsx scripts/self-modification.mts [--root <dir>] --report [--json]
  tsx scripts/self-modification.mts --help

选项:
  --root <dir>        存储根目录(缺省 process.cwd();落在 <root>/.genie/self-mod/requests.jsonl)
  --request <path>    提交一次自我修改请求 JSON;"-" 表示从 stdin 读
  --approve <id>      审批请求(--by 必填)
  --deny <id>         拒绝请求(--reason 必填)
  --apply <id>        标记已应用(可选 --frozen-hash;缺省取请求落盘时的冻结 hash)
  --rollback <id>     回滚(--reason 必填)
  --by <name>         审批人/操作人
  --kind <k>          审批人类型:human | owner(缺省 human)
  --reason <text>     deny / rollback 必填,approve 可选
  --frozen-hash <h>   apply 前核对冻结 hash(不符=MOD_HASH_MISMATCH)
  --list              列出请求(默认表格,--json 输出 JSON)
  --report            汇总报告(默认人类可读,--json 输出 JSON)
  --json              与 --list/--report 搭配
  --help              打印本用法

退出码:
  0 成功;1 运行/校验失败;2 被门拒(deny 或 need-approval,codes 在 stderr);3 重复请求/已是终态
`;

/** 手写 argv 解析:--key value 与开关两种;未知选项抛错(由 main 折成 exit 1)。 */
function parseArgv(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { root: process.cwd(), list: false, report: false, json: false, help: false };
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
      case "--request":
        out.request = valueOf(i, arg);
        i += 1;
        break;
      case "--approve":
        out.approve = valueOf(i, arg);
        i += 1;
        break;
      case "--deny":
        out.deny = valueOf(i, arg);
        i += 1;
        break;
      case "--apply":
        out.apply = valueOf(i, arg);
        i += 1;
        break;
      case "--rollback":
        out.rollback = valueOf(i, arg);
        i += 1;
        break;
      case "--by":
        out.by = valueOf(i, arg);
        i += 1;
        break;
      case "--kind":
        out.kind = valueOf(i, arg);
        i += 1;
        break;
      case "--reason":
        out.reason = valueOf(i, arg);
        i += 1;
        break;
      case "--frozen-hash":
        out.frozenHash = valueOf(i, arg);
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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonSource(src: string): Promise<unknown> {
  const text = src === "-" ? await readStdin() : await readFile(resolve(src), "utf8");
  return JSON.parse(text) as unknown;
}

async function loadStore(): Promise<StoreModule> {
  return (await import("../apps/gateway/src/self-modification-store.ts")) as unknown as StoreModule;
}

function codesText(res: { code?: string; codes?: string[] }): string {
  const codes = res.codes ?? [];
  if (codes.length > 0) return codes.join(",");
  return res.code ?? "MOD_STORE_ERROR";
}

/** 表格: id / surface / decision / applied / targetRef(截断 40)。 */
function formatTable(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "(无自我修改请求)";
  const header = ["id", "surface", "decision", "applied", "targetRef"];
  const width = [24, 8, 14, 8, 40];
  const clip = (text: string, n: number): string => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
  const cells = rows.map((row) => {
    const decision = (row["decision"] ?? {}) as Record<string, unknown>;
    return [
      String(row["id"] ?? ""),
      String(row["surface"] ?? ""),
      String(decision["kind"] ?? ""),
      row["applied"] === true ? "yes" : "no",
      clip(String(row["targetRef"] ?? ""), width[4]!),
    ];
  });
  const lines = [header, ...cells].map((cols) => cols.map((c, i) => c.padEnd(width[i]!)).join("  ").trimEnd());
  return lines.join("\n");
}

/** 人类可读报告。 */
function formatReport(report: Record<string, unknown>): string {
  const bySurface = Object.entries((report["bySurface"] ?? {}) as Record<string, number>)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return [
    "自我修改安全门报告",
    `  total: ${String(report["total"] ?? 0)}`,
    `  pending: ${String(report["pending"] ?? 0)} / allowed: ${String(report["allowed"] ?? 0)} / needApproval: ${String(report["needApproval"] ?? 0)}`,
    `  denied: ${String(report["denied"] ?? 0)} / applied: ${String(report["applied"] ?? 0)} / rolledBack: ${String(report["rolledBack"] ?? 0)}`,
    `  bySurface: ${bySurface === "" ? "(空)" : bySurface}`,
    `  lines: ${String(report["totalLines"] ?? 0)} (bad: ${String(report["badLines"] ?? 0)})`,
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
    args.request !== undefined,
    args.approve !== undefined,
    args.deny !== undefined,
    args.apply !== undefined,
    args.rollback !== undefined,
    args.list,
    args.report,
  ].filter(Boolean).length;
  if (actions === 0) {
    process.stderr.write(`缺少动作(--request / --approve / --deny / --apply / --rollback / --list / --report)\n\n${USAGE}`);
    return 1;
  }
  if (actions > 1) {
    process.stderr.write("一次只能做一件事(--request / --approve / --deny / --apply / --rollback / --list / --report 互斥)\n");
    return 1;
  }

  const store = await loadStore();
  const root = resolve(args.root);

  if (args.request !== undefined) {
    let payload: unknown;
    try {
      payload = await readJsonSource(args.request);
    } catch (err) {
      process.stderr.write(`读取请求 JSON 失败:${(err as Error).message}\n`);
      return 1;
    }
    let res: ReturnType<StoreModule["requestModification"]>;
    try {
      res = store.requestModification(root, payload);
    } catch (err) {
      process.stderr.write(`请求参数非法:${(err as Error).message}\n`);
      return 1;
    }
    if (!res.ok) {
      if (res.code === "MOD_DUPLICATE") {
        process.stderr.write(`重复请求:${res.id ?? ""}\n`);
        return 3;
      }
      if (res.decision === "deny" || res.decision === "need-approval") {
        process.stderr.write(`被门拒(${res.decision}):${codesText(res)}\n`);
        return 2;
      }
      process.stderr.write(`记录失败:${codesText(res)}\n`);
      return 1;
    }
    process.stdout.write(`requested ${res.id ?? ""} ${res.decision ?? "allow"}\n`);
    return 0;
  }

  if (args.approve !== undefined) {
    const by = (args.by ?? "").trim();
    if (by === "") {
      process.stderr.write("--approve 需要 --by <name>\n");
      return 1;
    }
    const kind = args.kind ?? "human";
    if (!["human", "owner", "agent"].includes(kind)) {
      process.stderr.write(`未知审批人类型:${kind}(允许 human|owner|agent)\n`);
      return 1;
    }
    const res = store.approveModification(root, args.approve, {
      by,
      kind: kind as "human" | "owner" | "agent",
      reason: args.reason,
    });
    if (res.ok) {
      process.stdout.write(`approved ${args.approve} ${res.decision ?? "allow"}\n`);
      return 0;
    }
    process.stderr.write(`审批未放行:${codesText(res)}\n`);
    if (res.code === "MOD_DECISION_FINAL") return 3;
    if (res.code === "MOD_NOT_FOUND" || res.code === "MOD_APPROVER_MISSING") return 1;
    return 2;
  }

  if (args.deny !== undefined) {
    const reason = (args.reason ?? "").trim();
    if (reason === "") {
      process.stderr.write("--deny 需要 --reason <text>\n");
      return 1;
    }
    const res = store.denyModification(root, args.deny, { by: args.by, reason });
    if (res.ok) {
      process.stdout.write(`denied ${args.deny}\n`);
      return 0;
    }
    process.stderr.write(`拒绝失败:${codesText(res)}\n`);
    if (res.code === "MOD_DECISION_FINAL") return 3;
    return 1;
  }

  if (args.apply !== undefined) {
    let frozenHash = args.frozenHash;
    if (frozenHash === undefined) {
      const record = store.getModification(root, args.apply);
      if (!record) {
        process.stderr.write(`未找到请求:${args.apply}\n`);
        return 1;
      }
      frozenHash = typeof record["frozenHash"] === "string" ? record["frozenHash"] : "";
    }
    const res = store.markApplied(root, args.apply, { frozenHash });
    if (res.ok) {
      process.stdout.write(`applied ${args.apply} ${res.frozenHash ?? frozenHash}\n`);
      return 0;
    }
    process.stderr.write(`apply 失败:${codesText(res)}\n`);
    if (res.code === "MOD_DECISION_FINAL") return 3;
    if (res.code === "MOD_NOT_FOUND") return 1;
    // MOD_HASH_MISMATCH 等属校验失败
    return 1;
  }

  if (args.rollback !== undefined) {
    const reason = (args.reason ?? "").trim();
    if (reason === "") {
      process.stderr.write("--rollback 需要 --reason <text>\n");
      return 1;
    }
    const res = store.rollbackModification(root, args.rollback, { reason });
    if (res.ok) {
      process.stdout.write(`rolled-back ${args.rollback}\n`);
      return 0;
    }
    process.stderr.write(`回滚失败:${codesText(res)}\n`);
    if (res.code === "MOD_DECISION_FINAL") return 3;
    return 1;
  }

  if (args.list) {
    const rows = store.listModifications(root);
    process.stdout.write(args.json ? `${JSON.stringify(rows, null, 2)}\n` : `${formatTable(rows)}\n`);
    return 0;
  }

  const report = store.reportModifications(root);
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`自我修改安全门 CLI 失败:${(err as Error)?.message ?? String(err)}\n`);
    process.exitCode = 1;
  });
