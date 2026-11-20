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
