/**
 * 收尾残留重扫(。
 * 背景: 之前 changeAudit 收尾只看「有没有 change.audit 记录」;审计通过却仍有旧概念
 * 散落在代码里,任务照样 done。本模块把「重扫事实 → 残留判定」收成纯逻辑:
 * - 命中面:重扫出的旧概念命中,allowed/explained 之外的都算「未解释残留」;
 * - 清单面:action 为 replace/remove/rename 的条目,target 仍是占位或 status 未
 * (不在 done/migrated/removed/kept/accepted)算「去向未」。
 * 口径:
 * - 纯逻辑:零 IO、不抛错、确定性、不修改入参(扫描与 journal 读取在调用方)。
 * - 两种来源同时有残留 → code 优先 RESIDUAL_HITS(命中是更硬的证据)。
 * - SCAN_UNAVAILABLE 不由本模块产生:调用方扫描失败时显式标记,closeout 只留痕不判定。
 */

export const RESIDUAL_CODES = ["OK", "RESIDUAL_HITS", "UNRESOLVED_ENTRY", "SCAN_UNAVAILABLE"] as const;
export type ResidualCode = (typeof RESIDUAL_CODES)[number];

/** 单条命中文本上限(与 change_surface 摘要口径一致)。 */
export const HIT_TEXT_MAX = 160;
/** verdict 文本里最多列多少条(fail 原因仍给计数)。 */
export const FINDINGS_TEXT_MAX = 8;
/** verdict 文本总长上限(与 CLOSEOUT_SECTION_MAX 同量级)。 */
export const RESIDUAL_TEXT_MAX = 1200;

/** 重扫命中(agent-wiring 由 SurfaceReport.hits 映射;allowed/explained 供人工豁免面扩展)。 */
export interface ResidualHitInput {
  file: string;
  line?: number;
  text?: string;
 /** true=该命中已被显式放行(保留旧实现等),不计残留。 */
  allowed?: boolean;
 /** 非空=该命中已有人读得懂的解释,不计残留。 */
  explained?: string;
}

/** 清单条目(change.surface 事件里带 action/target/status 的条目;旧事件没有则为空)。 */
export interface ResidualManifestEntry {
  id?: string;
  action?: string;
  target?: string;
  status?: string;
}

/** 收尾残留事实:由 agent-wiring 组装后放进 TaskCloseoutInput.changeFacts.residual。 */
export interface ResidualFact {
  concept: string;
  manifest: ResidualManifestEntry[];
  hits: ResidualHitInput[];
  rescanAt?: number;
 /** 调用方扫描失败时的显式标记(本模块不产码,closeout 据此跳过判定)。 */
  code?: ResidualCode;
}

export interface ResidualFinding {
  kind: "hit" | "unresolved";
  file?: string;
  line?: number;
  text?: string;
  entryId?: string;
  reason: string;
}

export interface ResidualFindingResult {
  code: ResidualCode;
  findings: ResidualFinding[];
  counts: { hits: number; unresolved: number; skipped: number };
}

export interface ResidualVerdict {
  warn: boolean;
  hardFail: boolean;
  mark: string;
  text: string;
}

/** 只有这三类 action 的条目才需要「去向」(keep/说明类条目不查)。 */
const UNRESOLVED_ACTIONS = new Set(["replace", "remove", "rename"]);
/** 去向已的 status 集合。 */
const RESOLVED_STATUSES = new Set(["done", "migrated", "removed", "kept", "accepted"]);
/** target 占位符:中文「待」/TBD/问号(含全角?)。 */
const PLACEHOLDER_RE = /待|tbd|\?|？/i;

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * 判定残留:命中未解释 + 清单条目去向未。不抛错(畸形输入按缺席处理)。
 */
export function residualFindings(input: {
  concept?: unknown;
  manifest?: unknown;
  hits?: unknown;
}): ResidualFindingResult {
  const concept = str(input?.concept).trim();
  const findings: ResidualFinding[] = [];
  let hitCount = 0;
  let unresolvedCount = 0;
  let skipped = 0;

 // ---- 命中面:allowed / explained 之外的旧概念出现都算残留 ----
  for (const raw of asArray(input?.hits)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      skipped++;
      continue;
    }
    const h = raw as ResidualHitInput;
    const explained = typeof h.explained === "string" ? h.explained.trim() : "";
    if (h.allowed === true || explained !== "") {
      skipped++;
      continue;
    }
    const file = str(h.file);
    const line = num(h.line);
    const text = str(h.text).slice(0, HIT_TEXT_MAX);
    findings.push({
      kind: "hit",
      ...(file ? { file } : {}),
      ...(line !== undefined ? { line } : {}),
      text,
      reason: concept ? `旧概念「${concept}」仍出现且未解释` : "旧概念仍出现且未解释",
    });
    hitCount++;
  }

 // ---- 清单面:replace/remove/rename 条目的 target 与 status 必须 ----
  for (const [i, raw] of asArray(input?.manifest).entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      skipped++;
      continue;
    }
    const e = raw as ResidualManifestEntry;
    const action = str(e.action).trim().toLowerCase();
    if (!UNRESOLVED_ACTIONS.has(action)) {
      skipped++;
      continue;
    }
    const target = str(e.target).trim();
    const status = str(e.status).trim().toLowerCase();
    const targetEmpty = target === "";
    const targetBad = targetEmpty || PLACEHOLDER_RE.test(target);
    const statusBad = !RESOLVED_STATUSES.has(status);
    if (!targetBad && !statusBad) {
      skipped++;
      continue;
    }
    const id = str(e.id).trim();
    const parts: string[] = [];
    if (targetEmpty) parts.push("target 为空");
    else if (targetBad) parts.push(`target 仍是占位(${target.slice(0, 40)})`);
    if (statusBad) parts.push(status ? `status 未收口(${status.slice(0, 20)})` : "status 未定");
    findings.push({
      kind: "unresolved",
      entryId: id || `#${i}`,
      reason: `清单条目 ${action} 去向未收口:${parts.join(";")}`,
    });
    unresolvedCount++;
  }

  const code: ResidualCode = hitCount > 0
    ? "RESIDUAL_HITS"
    : unresolvedCount > 0
      ? "UNRESOLVED_ENTRY"
      : "OK";
  return { code, findings, counts: { hits: hitCount, unresolved: unresolvedCount, skipped } };
}

function compareFinding(a: ResidualFinding, b: ResidualFinding): number {
  const ka = a.file ?? "";
  const kb = b.file ?? "";
  if (ka !== kb) return ka < kb ? -1 : 1;
  const la = a.line ?? 0;
  const lb = b.line ?? 0;
  if (la !== lb) return la - lb;
  const ea = a.entryId ?? "";
  const eb = b.entryId ?? "";
  if (ea !== eb) return ea < eb ? -1 : 1;
  return 0;
}

/** 确定性排序(file → line → entryId)后逐条渲染,格式固定,便于测试与日志对拍。 */
export function formatResidualFindings(findings: readonly ResidualFinding[]): string[] {
  const list = asArray(findings).filter(
    (f): f is ResidualFinding => !!f && typeof f === "object" && !Array.isArray(f),
  );
  return [...list].sort(compareFinding).map((f) => f.kind === "hit"
    ? `- [hit] ${f.file || "(未知文件)"}${f.line !== undefined ? `:${f.line}` : ""} — ${f.text || f.reason}`
    : `- [unresolved] ${f.entryId || "(无条目 id)"} — ${f.reason}`);
}

/**
 * 残留判定 → 收尾语义:warn 只挂警告,hard 阻止 done。
 * 无 findings 时四个字段全空(调用方零输出)。
 */
export function residualVerdict(input: { findings?: unknown; mode?: unknown }): ResidualVerdict {
  const findings = asArray(input?.findings).filter(
    (f): f is ResidualFinding => !!f && typeof f === "object" && !Array.isArray(f),
  );
  const mode = input?.mode === "hard" ? "hard" : "warn";
  if (!findings.length) return { warn: false, hardFail: false, mark: "", text: "" };
  const lines = formatResidualFindings(findings);
  const hits = findings.filter((f) => f.kind === "hit").length;
  const unresolved = findings.length - hits;
  const shown = lines.slice(0, FINDINGS_TEXT_MAX);
  const header = `## 残留审计(命中未解释 ${hits} 条 / 清单未收口 ${unresolved} 条)`;
  let text = [header, ...shown].join("\n");
  if (lines.length > FINDINGS_TEXT_MAX) text += `\n…还有 ${lines.length - FINDINGS_TEXT_MAX} 条`;
  if (text.length > RESIDUAL_TEXT_MAX) text = `${text.slice(0, RESIDUAL_TEXT_MAX - 1)}…`;
  return {
    warn: mode === "warn",
    hardFail: mode === "hard",
    mark: mode === "hard" ? "❌ 残留未解释" : "⚠ 残留",
    text,
  };
}
