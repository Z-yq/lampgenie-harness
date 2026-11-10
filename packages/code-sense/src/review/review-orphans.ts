/**
 * 评审数据引用孤儿检查(step-058,board-store 边引用完整性同律):
 * ocr/open-code-review 链的四源发现(确定性/反模式/CLI/LLM)在 codeReview() 出口汇合,
 * 每条 finding 的 file 引用必须在「工作树或本次审查目标」内可解析,行号必须落在文件实际
 * 行数内——引用落空的发现是脏数据(面板卡片点击即「文件不可读」,回写店记到幻影路径),
 * 拒收并 fail-visible 计数,不让模块各玩各的数据。
 *
 * 三态判定(board-store 同律:拒脏不丢真):
 * - 文件在工作树存在 → 收录;行号越界夹到文件末行(clamped 计数,引用目标在、定位不准而已);
 * - 文件不在工作树但在审查目标 diff 里(deleted 文件)→ 收录(diff 本身就是引用目标);
 * - 两处都不在(幻觉路径/越界路径)→ 拒收,orphan 计数,进 summary 可见。
 * 另附回写店孤儿对账(只报不删:sticky 语义保留历史,删除是下轮 resolved 收敛的事)。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Finding } from "./index";
import type { ReviewTarget } from "./index";
import type { ReviewCommentStore } from "./writeback";

export interface OrphanCheckResult {
  /** 通过引用检查的发现(行号已夹紧)。 */
  kept: Finding[];
  /** 被拒收的孤儿引用(幻影路径),fail-visible 进 summary。 */
  orphans: Array<{ finding: Finding; reason: string }>;
  /** 行号越界被夹到文件末行的条数(引用在、定位不准)。 */
  clamped: number;
  /** 仅存在于目标 diff 的引用(deleted 文件):收录且单独计数。 */
  diffOnly: number;
  /** 2026-10-20 用户口径「只审本 session 修改内容」:文件不在变更集而被剔除的条数(可见计数)。 */
  outOfScope: number;
}

function lineCount(abs: string): number {
  try {
    return readFileSync(abs, "utf-8").split("\n").length;
  } catch {
    return 1;
  }
}

/**
 * 出口引用闸:四源合一后统一过这道,任何调用方不再各自校验。
 * root=评审目标仓根(与 collectReviewTarget 同一根);target=本次审查目标(diff 引用白名单)。
 */
export function checkFindingRefs(root: string, target: ReviewTarget, findings: Finding[]): OrphanCheckResult {
  const rootAbs = resolve(root);
  const norm = (p: string) => String(p || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const diffPaths = new Set(target.files.map((f) => norm(f.path)));
  const kept: Finding[] = [];
  let outOfScope = 0; // 只审本任务变更集:范围外路径直接剔除(不是孤儿,计数可见)
  const orphans: Array<{ finding: Finding; reason: string }> = [];
  let clamped = 0;
  let diffOnly = 0;
  for (const f of findings) {
    if (isAbsolute(f.file) || f.file.includes("..")) {
      orphans.push({ finding: f, reason: "路径越界(绝对路径或 ..)" });
      continue;
    }

    const abs = join(rootAbs, f.file);
    if (!resolve(abs).startsWith(rootAbs)) {
      orphans.push({ finding: f, reason: "路径越界(解析后逃出仓根)" });
      continue;
    }
    if (existsSync(abs) && statSync(abs).isFile()) {
      // 2026-10-20 用户口径:code review 只审本 session 修改的内容——文件存在但不在本次变更集=
      // 范围外,不计 finding(此前照收 → 全仓 lint/回写店对账等外来 finding 混进本任务结论)。
      // 顺序放在存在性之后:幻觉路径(不存在)仍按孤儿拒收,fail-visible 不丢。
      if (!diffPaths.has(norm(f.file))) {
        outOfScope += 1;
        continue;
      }
      const lines = lineCount(abs);
      if (f.line > lines || f.line < 1) {
        kept.push({ ...f, line: Math.min(Math.max(1, f.line), lines) });
        clamped += 1;
      } else {
        kept.push(f);
      }
      continue;
    }
    if (diffPaths.has(f.file)) {
      kept.push(f); // deleted 文件:审查目标是 diff,引用合法
      diffOnly += 1;
      continue;
    }
    orphans.push({ finding: f, reason: "文件不存在于工作树与审查目标" });
  }
  return { kept, orphans, clamped, diffOnly, outOfScope };
}

/** 孤儿摘要短语(fail-visible,拼进 codeReview summary)。 */
export function orphanNote(r: OrphanCheckResult): string {
  const parts: string[] = [];
  if (r.orphans.length) parts.push(`孤儿引用拒收 ${r.orphans.length} 条`);
  if (r.clamped) parts.push(`行号夹紧 ${r.clamped} 条`);
  if (r.diffOnly) parts.push(`diff 独引 ${r.diffOnly} 条`);
  if (r.outOfScope) parts.push(`范围外剔除 ${r.outOfScope} 条(只审本任务变更集)`);
  return parts.length ? `;引用孤儿检查 ${parts.join("/")}` : "";
}

export interface StoreSweepResult {
  /** 工作树中文件已不存在的条目(sticky 语义保留,只报不删)。 */
  missingFile: Array<{ key: string; path: string; line: number }>;
}

/**
 * 回写店孤儿对账(只读):path 在工作树已不存在的条目=引用孤儿。
 * 不自动删除——sticky 设计有意保留 resolved 历史;对账数字进 summary,清理另议。
 */
export function sweepStoreOrphans(root: string, store: ReviewCommentStore, scope?: Set<string>): StoreSweepResult {
  // scope 在场=只报本次变更集内的孤儿(本任务删/改名的文件);别家会话的陈旧条目不再混进本任务 summary。
  const norm = (p: string) => String(p || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const missingFile: StoreSweepResult["missingFile"] = [];
  for (const c of store.comments) {
    if (scope && !scope.has(norm(c.path))) continue;
    if (isAbsolute(c.path) || c.path.includes("..")) {
      missingFile.push({ key: c.key, path: c.path, line: c.line });
      continue;
    }
    const abs = join(resolve(root), c.path);
    if (!resolve(abs).startsWith(resolve(root)) || !existsSync(abs)) {
      missingFile.push({ key: c.key, path: c.path, line: c.line });
    }
  }
  return { missingFile };
}
