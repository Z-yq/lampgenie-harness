/**
 * M5 完成审计(2026-11):把已有各段收尾机制的事实**聚合成一张可判定的记分卡**。
 *
 * 设计约束(用户口径「只聚合不重写」):
 * - 本模块零 IO、不 import 任何业务读取函数——各段事实(board P0 覆盖率 / 验证账本 /
 *   交付物核对 / 全链路审计 / 引用账本 / 变更账本)由调用方(agent-wiring 收尾段)采集后传入,
 *   本模块只做判定 + 渲染,便于单测穷举每条判据,也避免在收尾路径上再读磁盘。
 * - 渲染是「噪音控制」的:全 pass/na 返回空串——不收尾文本里塞一张全绿的卡。
 * - 硬上限 COMPLETION_RENDER_MAX:超预算丢 item 行并补「…(省略 N 项)」,但标题与汇总行必须保留。
 */

/** 六行记分卡(顺序=渲染顺序)。 */
export type CompletionItemId = "board" | "verify" | "deliverable" | "change" | "citation" | "change-ledger";
export type CompletionStatus = "pass" | "warn" | "fail" | "na";

export interface CompletionItem {
  id: CompletionItemId;
  status: CompletionStatus;
  /** 人读标签(渲染行首)。 */
  label: string;
  /** 判定明细(渲染冒号后;>200 字截断)。 */
  detail: string;
}

/** 各段机制的事实快照:字段缺失 = 该段未采集(该行判 na,detail「未采集」)。 */
export interface CompletionFacts {
  board?: { hasBoard: boolean; p0Total: number; p0Passed: number; staleEvidence: number; hasNegativeAccept: boolean };
  verify?: { stale: boolean; reason?: string; writes: number; verificationCount: number };
  deliverables?: { declared: number; missing: number };
  change?: { scope: "surface" | "normal"; manifest: boolean; auditPassed: boolean; verified: boolean; negativeAssertions: number };
  citations?: { inScope: boolean; registered: number; missing: number };
  ledger?: { changed: number; unknown: number; oversized: number };
}

export interface CompletionAudit {
  /** items 里没有任何 fail(=hard 模式下不补跑)。 */
  passed: boolean;
  warnings: number;
  fails: number;
  items: CompletionItem[];
  /** 全 pass/na 时为 ""。 */
  rendered: string;
}

/** 渲染总长硬上限(字符)。 */
export const COMPLETION_RENDER_MAX = 1200;
/** 单条 detail 截断长度。 */
const DETAIL_MAX = 200;
const OMIT_RESERVE = 24;

export const COMPLETION_LABELS: Record<CompletionItemId, string> = {
  board: "白板 P0",
  verify: "验证账本",
  deliverable: "交付物",
  change: "全链路审计",
  citation: "引用账本",
  "change-ledger": "变更账本",
};

const ICON: Record<CompletionStatus, string> = { pass: "✅", warn: "⚠", fail: "❌", na: "–" };

const NA_MISSING = "未采集";
const NA_NA = "本任务不适用";

const item = (id: CompletionItemId, status: CompletionStatus, detail: string): CompletionItem => ({
  id, status, label: COMPLETION_LABELS[id], detail,
});

/** board 行:无板/无 P0 → na;P0 未满或证据过期 → fail;全绿但无负面断言 → warn。 */
function boardItem(f: CompletionFacts["board"]): CompletionItem {
  if (!f) return item("board", "na", NA_MISSING);
  if (!f.hasBoard || f.p0Total === 0) return item("board", "na", NA_NA);
  const passedText = `P0 ${f.p0Passed}/${f.p0Total} 通过`;
  if (f.p0Passed < f.p0Total || f.staleEvidence > 0) {
    const parts = [passedText];
    if (f.staleEvidence > 0) parts.push(`证据过期 ${f.staleEvidence} 条`);
    return item("board", "fail", parts.join(";"));
  }
  if (f.hasNegativeAccept === false) return item("board", "warn", `${passedText};P0 无负面断言`);
  return item("board", "pass", passedText);
}

/** verify 行:无代码写 → na;验证后仍改代码/无验证记录 → warn;否则 pass。 */
function verifyItem(f: CompletionFacts["verify"]): CompletionItem {
  if (!f) return item("verify", "na", NA_MISSING);
  if (f.writes === 0) return item("verify", "na", NA_NA);
  if (f.stale) {
    return item("verify", "warn", f.reason === "no-verification"
      ? `改了 ${f.writes} 个代码文件但无验证记录`
      : `最近一次验证后又改了 ${f.writes} 个文件`);
  }
  return item("verify", "pass", `验证 ${f.verificationCount} 次,改动已覆盖`);
}

/** deliverable 行:无声明 → na;缺失 >0 → fail;否则 pass。 */
function deliverableItem(f: CompletionFacts["deliverables"]): CompletionItem {
  if (!f) return item("deliverable", "na", NA_MISSING);
  if (f.declared === 0) return item("deliverable", "na", NA_NA);
  if (f.missing > 0) return item("deliverable", "fail", `声明 ${f.declared} 项,缺失 ${f.missing} 项`);
  return item("deliverable", "pass", `声明 ${f.declared} 项,全部在位`);
}

/** change 行:非全链路任务 → na;盘点/审计/验收证据三项全真才 pass;无负面断言降 warn。 */
function changeItem(f: CompletionFacts["change"]): CompletionItem {
  if (!f) return item("change", "na", NA_MISSING);
  if (f.scope === "normal") return item("change", "na", NA_NA);
  const missing: string[] = [];
  if (!f.manifest) missing.push("缺盘点");
  if (!f.auditPassed) missing.push("未跑审计或审计未通过");
  if (!f.verified) missing.push("验收证据未全通过");
  if (missing.length) return item("change", "fail", missing.join("、"));
  const ok = `盘点/审计/验收证据齐全(负面断言 ${f.negativeAssertions} 条)`;
  if (f.negativeAssertions === 0) return item("change", "warn", `${ok};无负面断言(旧入口不可达未验证)`);
  return item("change", "pass", ok);
}

/** citation 行:不在作用域 → na;正文引用未登记 → fail;有登记 → pass;零登记 → na。 */
function citationItem(f: CompletionFacts["citations"]): CompletionItem {
  if (!f) return item("citation", "na", NA_MISSING);
  if (!f.inScope) return item("citation", "na", NA_NA);
  if (f.missing > 0) return item("citation", "fail", `登记 ${f.registered} 条,正文缺登记 ${f.missing} 处`);
  if (f.registered > 0) return item("citation", "pass", `登记 ${f.registered} 条,正文引用齐全`);
  return item("citation", "na", NA_NA);
}

/** change-ledger 行:零变更 → na;有未跟踪/超大文件 → warn(仅信息,永不 fail);否则 pass。 */
function ledgerItem(f: CompletionFacts["ledger"]): CompletionItem {
  if (!f) return item("change-ledger", "na", NA_MISSING);
  if (f.changed + f.unknown + f.oversized === 0) return item("change-ledger", "na", NA_NA);
  if (f.unknown > 0 || f.oversized > 0) {
    const parts = [`变更 ${f.changed} 个文件`];
    if (f.unknown > 0) parts.push(`未跟踪 ${f.unknown} 个`);
    if (f.oversized > 0) parts.push(`超大 ${f.oversized} 个`);
    return item("change-ledger", "warn", parts.join(";"));
  }
  return item("change-ledger", "pass", `变更 ${f.changed} 个文件`);
}

/** 聚合判定:六行 + 汇总;渲染全 pass/na 时为 ""。 */
export function buildCompletionAudit(facts: CompletionFacts): CompletionAudit {
  const items = [
    boardItem(facts.board),
    verifyItem(facts.verify),
    deliverableItem(facts.deliverables),
    changeItem(facts.change),
    citationItem(facts.citations),
    ledgerItem(facts.ledger),
  ];
  const fails = items.filter((i) => i.status === "fail").length;
  const warnings = items.filter((i) => i.status === "warn").length;
  return { passed: fails === 0, warnings, fails, items, rendered: renderCompletionAudit(items) };
}

/** 单行文本(超长 detail 先截断)。 */
function lineOf(it: CompletionItem): string {
  const detail = it.detail.length > DETAIL_MAX ? `${it.detail.slice(0, DETAIL_MAX - 1)}…` : it.detail;
  return `${ICON[it.status]} ${it.label}:${detail}`;
}

/**
 * 渲染记分卡。全 pass/na → ""(不加噪音);否则 `## 完成审计` + 每行 + 汇总行,
 * 总长 ≤ COMPLETION_RENDER_MAX(超预算丢 item 行并补「…(省略 N 项)」,标题与汇总行永远保留)。
 */
export function renderCompletionAudit(items: readonly CompletionItem[]): string {
  if (!items.length) return "";
  if (items.every((i) => i.status === "pass" || i.status === "na")) return "";
  const header = "## 完成审计";
  const summary = `通过 ${items.filter((i) => i.status === "pass").length} / 警告 ${items.filter((i) => i.status === "warn").length} / 失败 ${items.filter((i) => i.status === "fail").length}`;
  // 预算:总上限 - 标题行 - 汇总行 - 两个换行(省略行按 OMIT_RESERVE 预留)。
  const budget = COMPLETION_RENDER_MAX - header.length - summary.length - 2 - OMIT_RESERVE;
  const kept: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const it of items) {
    const line = lineOf(it);
    if (used + line.length + 1 <= budget) {
      kept.push(line);
      used += line.length + 1;
    } else omitted++;
  }
  // 省略行本身也要装得下:仍超预算就从末尾继续丢 item 行(汇总数字不变,只看被保留的行)。
  let omitText = omitted ? `…(省略 ${omitted} 项)` : "";
  const total = () => header.length + summary.length + 2
    + kept.reduce((a, l) => a + l.length + 1, 0)
    + (omitText ? omitText.length + 1 : 0);
  while (omitted > 0 && total() > COMPLETION_RENDER_MAX && kept.length) {
    kept.pop();
    omitted++;
    omitText = `…(省略 ${omitted} 项)`;
  }
  const lines = [header, ...kept, ...(omitText ? [omitText] : []), summary];
  return lines.join("\n");
}
