#!/usr/bin/env node
/**
 * 闲时算力票据 CLI(#175):取票 → 就绪 → 认领 → 结算 / 过期 / 回收 / 手动续号 / 轮询 / 派发 / 报告。
 *
 * 纯表面层:状态机在 packages/harness-runtime/src/agent/idle-ticket.ts,
 * 持久层(原子写 .genie/rsi/idle-tickets.json)在 apps/gateway/src/idle-ticket-store.ts。
 * 本文件只做 argv 解析、输出格式与退出码映射。
 *
 * 退出码:0 成功 / 1 参数或运行错误(含坏账本) / 2 业务拒绝
 *         (重复 pending / 额度不足 / 不可调度 / 过期 / 派发拒绝)。
 *
 * 用法:
 *   node --experimental-strip-types --conditions=development scripts/idle-ticket.mts --root <dir> \
 *     [--create --session s] [--ready <id>] [--claim <id>] [--expire <id>] \
 *     [--settle <id> --outcome ok|4xx|5xx] [--reclaim] [--continue <id>] \
 *     [--poll --last <ms>] [--dispatch] [--report] [--json] [--now <ms>] [--budget-ok true|false]
 */
import {
  continueExpiredOnDisk,
  claimOnDisk,
  createTicketOnDisk,
  dispatchRoundOnDisk,
  expireOnDisk,
  IDLE_REJECTION_CODES,
  makeReadyOnDisk,
  pollOnDisk,
  readTicketStore,
  reclaimStaleOnDisk,
  reportTickets,
  settleOnDisk,
} from "../apps/gateway/src/idle-ticket-store.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_REJECT = 2;

const VALUE_FLAGS = new Set(["root", "session", "ready", "claim", "expire", "settle", "outcome", "continue", "last", "now", "budget-ok"]);
const BOOL_FLAGS = new Set(["create", "reclaim", "poll", "dispatch", "report", "json", "help"]);

type Parsed = { values: Map<string, string>; flags: Set<string>; unknown: string[] };

function parseArgs(argv: string[]): Parsed {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const unknown: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i] ?? "";
    if (!raw.startsWith("--")) {
      unknown.push(raw);
      continue;
    }
    const name = raw.slice(2);
    if (VALUE_FLAGS.has(name)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        values.set(name, "");
        continue;
      }
      values.set(name, next);
      i += 1;
      continue;
    }
    if (BOOL_FLAGS.has(name)) flags.add(name);
    else unknown.push(raw);
  }
  return { values, flags, unknown };
}

class UsageError extends Error {}

function out(json: boolean, payload: Record<string, unknown>, lines: string[]): void {
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`${lines.join("\n")}\n`);
}

function exitFor(ok: boolean, code: string): number {
  if (ok) return EXIT_OK;
  return (IDLE_REJECTION_CODES as readonly string[]).includes(code) ? EXIT_REJECT : EXIT_USAGE;
}

function usageText(): string {
  return [
    "用法: idle-ticket --root <dir> <动作> [--json]",
    "  --create --session <s>        取一张新票(先取票,再落库)",
    "  --ready <id>                  票变 ready(挂 deadline,缺省 10min)",
    "  --claim <id>                  原子 CAS 认领(只有 ready 且未过期能认领)",
    "  --expire <id>                 过期收口(ready/queued 过 deadline → expired)",
    "  --settle <id> --outcome <o>   结算 ok|4xx|5xx(5xx 保持 active 待重试)",
    "  --reclaim                     回收超 10min 未结算的 active",
    "  --continue <id>               手动续号(仅 expired 且本地仍 queued)",
    "  --poll --last <ms>            轮询间隔裁决(5s–5min)",
    "  --dispatch                    派发轮闸门(有 ready/active 则拒绝)",
    "  --report                      账本报告",
    "  --now <ms>  --budget-ok <bool>  辅助参数(确定性时间 / 额度)",
  ].join("\n");
}

function main(argv: string[]): number {
  const parsed = parseArgs(argv);
  const json = parsed.flags.has("json");
  const root = (parsed.values.get("root") ?? "").trim();

  if (parsed.flags.has("help") || argv.length === 0) {
    out(json, { ok: true, codes: ["IDLE_HELP"], usage: usageText() }, [usageText()]);
    return EXIT_OK;
  }
  if (parsed.unknown.length > 0) throw new UsageError(`未知参数: ${parsed.unknown.join(" ")}`);
  if (root === "") throw new UsageError("缺少 --root <dir>");

  const nowRaw = parsed.values.get("now");
  const now = nowRaw === undefined || nowRaw === "" ? undefined : Number(nowRaw);
  if (now !== undefined && (!Number.isFinite(now) || now < 0)) throw new UsageError(`--now 非法: ${nowRaw}`);

  const actions = ["create", "ready", "claim", "expire", "settle", "reclaim", "continue", "poll", "dispatch", "report"].filter(
    (action) => parsed.flags.has(action) || parsed.values.has(action),
  );
  if (actions.length === 0) throw new UsageError("缺少动作(见 --help)");
  if (actions.length > 1) throw new UsageError(`一次只能做一个动作: ${actions.join(", ")}`);
  const action = actions[0];

  const needId = (flag: string): string => {
    const id = (parsed.values.get(flag) ?? "").trim();
    if (id === "") throw new UsageError(`缺少 ${flag} 的票据 id`);
    return id;
  };

  if (action === "create") {
    const session = (parsed.values.get("session") ?? "").trim();
    if (session === "") throw new UsageError("--create 需要 --session <s>");
    const budgetRaw = (parsed.values.get("budget-ok") ?? "true").trim().toLowerCase();
    if (budgetRaw !== "true" && budgetRaw !== "false") throw new UsageError("--budget-ok 只能是 true|false");
    const r = createTicketOnDisk(root, { sessionId: session, now, budgetOk: budgetRaw !== "false" });
    out(json, r as unknown as Record<string, unknown>, [`${r.code} ${r.ticket?.id ?? "-"} session=${session} local=${r.ticket?.localStatus ?? "-"} ticket=${r.ticket?.ticketStatus ?? "-"}`]);
    return exitFor(r.ok, r.code);
  }

  if (action === "ready") {
    const r = makeReadyOnDisk(root, { id: needId("ready"), now });
    out(json, r as unknown as Record<string, unknown>, [`${r.code} ${r.ticket?.id ?? "-"} deadline=${r.ticket?.readyDeadline ?? "-"}`]);
    return exitFor(r.ok, r.code);
  }

  if (action === "claim") {
    const r = claimOnDisk(root, { id: needId("claim"), now });
    out(json, r as unknown as Record<string, unknown>, [`${r.code} ${r.ticket?.id ?? "-"} ticket=${r.ticket?.ticketStatus ?? "-"} claimedAt=${r.ticket?.claimedAt ?? "-"}`]);
    return exitFor(r.ok, r.code);
  }

  if (action === "expire") {
    const r = expireOnDisk(root, { id: needId("expire"), now });
    out(json, r as unknown as Record<string, unknown>, [`${r.code} ${r.ticket?.id ?? "-"} ticket=${r.ticket?.ticketStatus ?? "-"}`]);
    return exitFor(r.ok, r.code);
  }

  if (action === "settle") {
    const id = needId("settle");
    const outcome = (parsed.values.get("outcome") ?? "").trim();
    if (outcome !== "ok" && outcome !== "4xx" && outcome !== "5xx") throw new UsageError("--settle 需要 --outcome ok|4xx|5xx");
    const r = settleOnDisk(root, { id, outcome, now });
    out(json, r as unknown as Record<string, unknown>, [`${r.code} ${r.ticket?.id ?? "-"} local=${r.ticket?.localStatus ?? "-"} attempts=${r.ticket?.attempts ?? 0}`]);
    return exitFor(r.ok, r.code);
  }

  if (action === "reclaim") {
    const r = reclaimStaleOnDisk(root, { now });
    out(json, r as unknown as Record<string, unknown>, [
      `${r.code} reclaimed=${r.reclaimed.length} requeued=${r.requeued.map((t) => t.id).join(",") || "-"} failed=${r.failed.map((t) => t.id).join(",") || "-"}`,
    ]);
    return exitFor(r.ok, r.code);
  }

  if (action === "continue") {
    const r = continueExpiredOnDisk(root, { id: needId("continue"), now });
    out(json, r as unknown as Record<string, unknown>, [`${r.code} ${r.ticket?.id ?? "-"} from=${r.detail?.["sourceId"] ?? "-"}`]);
    return exitFor(r.ok, r.code);
  }

  if (action === "poll") {
    const lastRaw = parsed.values.get("last");
    const last = lastRaw === undefined || lastRaw === "" ? undefined : Number(lastRaw);
    if (last !== undefined && (!Number.isFinite(last) || last < 0)) throw new UsageError(`--last 非法: ${lastRaw}`);
    const r = pollOnDisk(root, { lastPollAt: last, now });
    out(json, r as unknown as Record<string, unknown>, [`${r.code} due=${r.due} waitMs=${r.waitMs} overdue=${r.overdue} pending=${r.pendingIds.join(",") || "-"}`]);
    // POLL_WAIT 是「还没到点」的正常结论(exit 0),只有非法入参才是错误。
    return r.code === "IDLE_INVALID" ? EXIT_USAGE : EXIT_OK;
  }

  if (action === "dispatch") {
    const r = dispatchRoundOnDisk(root);
    out(json, r as unknown as Record<string, unknown>, [`${r.code} rejected=${r.rejected} blocking=${r.blockingIds.join(",") || "-"}`]);
    return exitFor(r.ok, r.code);
  }

  // report
  const report = reportTickets(root, { now });
  const lines = [
    `${report.ok ? "IDLE_REPORT" : "IDLE_STORE_ERROR"} file=${report.file} total=${report.total} pending=${report.pending} settled=${report.settled}`,
    `local: queued=${report.byLocalStatus.queued} schedulable=${report.byLocalStatus.schedulable} running=${report.byLocalStatus.running} done=${report.byLocalStatus.done} failed=${report.byLocalStatus.failed}`,
    `ticket: queued=${report.byTicketStatus.queued} ready=${report.byTicketStatus.ready} active=${report.byTicketStatus.active} expired=${report.byTicketStatus.expired}`,
    ...report.tickets.map(
      (t) => `- ${t.id} session=${t.sessionId} local=${t.localStatus} ticket=${t.ticketStatus} rev=${t.revision}${t.settledAt === undefined ? "" : ` settled=${t.settledAt}`}`,
    ),
  ];
  out(json, report as unknown as Record<string, unknown>, lines);
  if (!report.ok) return EXIT_USAGE;
  return EXIT_OK;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  const isUsage = err instanceof UsageError;
  process.stdout.write(`${JSON.stringify({ ok: false, codes: [isUsage ? "IDLE_USAGE_ERROR" : "IDLE_RUNTIME_ERROR"], message })}\n`);
  process.exit(EXIT_USAGE);
}
