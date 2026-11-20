/**
 * 改前链路闸:首次编辑某源码文件时,若本任务尚未查过该文件/符号的链路,
 * 在 edit_file 回执注入显式提醒 + 自动附该文件符号表(把链路带进上下文,不依赖模型自觉)。
 * 语义:显式提示 + 自动带数据,**不硬拦**(硬拦会误伤新建文件/纯文档编辑等合法流)。
 * - 已查过(ledger.coversFile)→ 不打扰(返回 undefined);
 * - 每任务每文件只提示一次;非源码扩展名跳过;
 * - 符号表取不到(索引缺失/查询失败)→ 降级为纯提醒(fail-soft,绝不阻塞编辑)。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SenseQueryLedger } from "./sense-query-ledger.js";
import { isSourceFile } from "./sense-root-gate.js";

export interface SenseEditGuardInfo {
  path: string;
  covered: boolean;
  symbolsAttached: boolean;
}

const SYMBOL_TABLE_MAX = 1500;

export function createSenseEditGuard(opts: {
  root: string;
  ledger: SenseQueryLedger;
 /** 文件符号表取数(进程内索引查询,不触发构建);不可用返回 null → 降级纯提醒。 */
  fileSymbols?: (rel: string) => Promise<string | null>;
  onHint?: (info: SenseEditGuardInfo) => void;
}): (rel: string) => Promise<string | undefined> {
  const hinted = new Set<string>();
  return async (rel: string): Promise<string | undefined> => {
    const r = String(rel ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
    if (!r || !isSourceFile(r)) return undefined;
    if (hinted.has(r)) return undefined;
    let content = "";
    try {
      content = await readFile(join(opts.root, r), "utf8");
    } catch {
      return undefined; // 读不到内容(新建/删除)→ 不提示
    }
    if (opts.ledger.coversFile(r, content)) return undefined; // 链路已查 → 不打扰
    hinted.add(r);
    let table: string | null = null;
    try {
      table = opts.fileSymbols ? await opts.fileSymbols(r) : null;
    } catch {
      table = null;
    }
    const attached = table !== null && table.trim().length > 0;
    try {
      opts.onHint?.({ path: r, covered: false, symbolsAttached: attached });
    } catch {
 /* 留痕失败不阻塞编辑 */
    }
    const lines = [
      "<system-reminder>",
      `⚠️ 改前链路未查:本任务尚未对 ${r} 做 code_sense 链路查询(file/symbol/impact)。`,
      "改符号前先查上下游,避免只改局部不顾完整逻辑链:",
      "1. code_sense action=impact target=<要改的符号>(上下游闭包+受影响文件+关联测试)",
      "2. 核对上游调用方是否需同步修改;确认影响面闭合再继续编辑",
    ];
    if (attached) {
      lines.push(
        "附:本文件符号表(自动带出,供选 impact 目标):",
        table!.slice(0, SYMBOL_TABLE_MAX) + (table!.length > SYMBOL_TABLE_MAX ? "\n…(截断)" : ""),
      );
    }
    lines.push("</system-reminder>");
    return lines.join("\n");
  };
}

/**
 * 高影响模块编辑硬门(§11 P1「advisory→可测门」):
 * advisory 警告经验证采纳率 0/4(生产:4 个会话收到高影响警告,code_sense 调用 114-190 次,
 * radiation 0 次)——建议型注入在 agent 侧可被无成本忽略。本门把「改高影响模块前先拿辐射面
 * 清单」变成**可拒绝的硬门**(与 plan-gate 同范式):
 * - 目标文件命中 atlas 热点模块且 riskLevel=high;
 * - 本任务尚未对其实施 radiation/impact 查询(ledger.coversFileWith 词边界覆盖判定);
 * - → 拒绝本次编辑,回执指路 `code_sense action=radiation target=<导出符号>`;
 * - 逃生:同模块第 3 次尝试放行(记 impact.gate.escape,防死锁);非源码/新文件/快照不可用
 * /索引不可用一律 fail-soft 放行(绝不误伤合法流)。
 * 与 createHighImpactEditWarning 的关系:警告保留(先给一次软提醒),门在其后;警告每模块一次,
 * 门每次编辑前检查。通过(已查)后不再打扰。
 */
export interface HighImpactEditGateInfo {
  path: string;
  upstream: number;
  isEntrypoint: boolean;
  denials: number;
}

export function createHighImpactEditGate(opts: {
  getAtlasJson: () => unknown;
  ledger: SenseQueryLedger;
 /** 读文件内容(覆盖判定要词边界匹配符号;新文件/读失败 → 放行)。 */
  readFileContent?: (rel: string) => Promise<string | null>;
 /** 同模块最多拒绝次数(缺省 2;第 3 次放行并记 escape)。 */
  maxDenials?: number;
  onDeny?: (info: HighImpactEditGateInfo) => void;
  onEscape?: (info: HighImpactEditGateInfo) => void;
}): (rel: string) => Promise<string | undefined> {
  const attempts = new Map<string, number>();
  const maxDenials = typeof opts.maxDenials === "number" && opts.maxDenials >= 0 ? Math.floor(opts.maxDenials) : 2;
  return async (rel: string): Promise<string | undefined> => {
    const r = String(rel ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
    if (!r || !isSourceFile(r)) return undefined;
    const atlasJson = opts.getAtlasJson() as { derived?: { moduleActivity?: Array<{ path: string; context?: { upstream: number; isEntrypoint: boolean; riskLevel: "high" | "medium" | "low" } }> } } | undefined | null;
    const modules = atlasJson?.derived?.moduleActivity ?? [];
    const hit = modules.find((m) => {
      if (m.context?.riskLevel !== "high") return false;
      const mPath = m.path.replace(/\\/g, "/");
      return r === mPath || r.endsWith("/" + mPath) || mPath.endsWith("/" + r);
    });
    if (hit === undefined || hit.context === undefined) return undefined;
    let content: string | null = null;
    try {
      content = opts.readFileContent ? await opts.readFileContent(r) : null;
    } catch {
      content = null;
    }
    if (content === null) return undefined; // 新文件/读失败:fail-soft
    if (opts.ledger.coversFileWith(r, content, ["radiation", "impact"])) return undefined;
    const n = attempts.get(hit.path) ?? 0;
    const info: HighImpactEditGateInfo = { path: hit.path, upstream: hit.context.upstream, isEntrypoint: hit.context.isEntrypoint, denials: n + 1 };
    if (n >= maxDenials) {
      try { opts.onEscape?.(info); } catch { /* 留痕失败不阻塞 */ }
      return undefined; // 逃生放行(已拒 maxDenials 次)
    }
    attempts.set(hit.path, n + 1);
    try { opts.onDeny?.(info); } catch { /* 留痕失败不阻塞 */ }
    const entry = hit.context.isEntrypoint ? ",入口函数" : "";
    return [
      `错误:高影响模块改动被拦(impact-gate):${hit.path}(${hit.context.upstream} 个上游调用方${entry})`,
      "本任务尚未对该模块做过影响面查询——改它之前必须拿到辐射面清单:",
      "  code_sense action=radiation target=<本文件的导出符号>(上游调用方/下游依赖/契约/副作用四分面)",
      "核对清单中的上游调用方是否需要同步修改,然后再重新编辑。",
      `(已拦 ${n + 1}/${maxDenials} 次;第 ${maxDenials + 1} 次将放行以避死锁——但请先查清单。)`,
    ].join("\n");
  };
}
