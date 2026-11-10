/**
 * surface 审计:把「概念足迹清单」和「逐条处置结论」对账,判断这次替换/下线是否真的走完了。
 *
 * 规则(确定性,不做语义猜测):
 *  - resolution 按 file 匹配(给了 line 则必须相等);resolved / removed 计入 resolved;
 *  - keep-legacy 必须带非空 reason(≥4 字),否则进 invalidJustifications 且不算 justified;
 *  - 一条命中的 file:line 没有任何 resolution 覆盖 → unexplained;
 *  - passed = unexplained 为空 && invalidJustifications 为空。
 * 说明:keep-legacy 只是「有理由地保留」,不是「已解决」——它进 justified 不进 resolved,
 * 以便回报区分「改了」和「决定不改」。
 */
import type { SurfaceHit, SurfaceReport } from "./index.js";

export interface SurfaceResolution {
  file: string;
  line?: number;
  status: "resolved" | "removed" | "keep-legacy";
  reason?: string;
}

export interface SurfaceAudit {
  passed: boolean;
  total: number;
  resolved: number;
  justified: number;
  unexplained: Pick<SurfaceHit, "id" | "category" | "file" | "line" | "text">[];
  invalidJustifications: { file: string; line?: number; why: string }[];
  summary: string;
}

const MIN_REASON_CHARS = 4;

function toPosix(p: string): string {
  return (p ?? "").split("\\").join("/").replace(/^\.\//, "");
}

function useLine(r: SurfaceResolution): number | undefined {
  return typeof r.line === "number" ? r.line : undefined;
}

export function auditSurface(report: SurfaceReport, resolutions: SurfaceResolution[]): SurfaceAudit {
  const list = resolutions ?? [];
  const invalid: { file: string; line?: number; why: string }[] = [];

  // 有效理由判定先做(一次),后面逐条命中只查表:同一 resolution 的无效理由只记一条。
  const okResolution = new Set<SurfaceResolution>();
  for (const r of list) {
    if (r.status !== "keep-legacy") {
      okResolution.add(r);
      continue;
    }
    const reason = (r.reason ?? "").trim();
    if (reason.length >= MIN_REASON_CHARS) {
      okResolution.add(r);
    } else {
      invalid.push({
        file: toPosix(r.file),
        ...(useLine(r) !== undefined ? { line: useLine(r)! } : {}),
        why: reason.length === 0 ? "keep-legacy 缺少 reason" : `keep-legacy reason 过短(${reason.length} 字,需 ≥${MIN_REASON_CHARS})`,
      });
    }
  }

  const unexplained: SurfaceAudit["unexplained"] = [];
  let resolved = 0;
  let justified = 0;
  for (const h of report.hits) {
    const file = toPosix(h.file);
    // 按 file 匹配(给了 line 则必须相等);同一命中只吃一条 resolution,顺序按入参(确定性)。
    const hit = list.find((r) => toPosix(r.file) === file && (useLine(r) === undefined || useLine(r) === h.line));
    if (!hit) {
      unexplained.push({ id: h.id, category: h.category, file: h.file, line: h.line, text: h.text });
      continue;
    }
    if (hit.status === "resolved" || hit.status === "removed") resolved++;
    else if (okResolution.has(hit)) justified++;
    // keep-legacy 且理由无效:既不算 resolved 也不算 justified(已进 invalidJustifications)
  }

  const total = report.hits.length;
  const passed = unexplained.length === 0 && invalid.length === 0;
  const summary = total === 0
    ? "概念足迹为空:没有可审计的命中(概念未出现或被过滤;先确认扫描口径)"
    : `${passed ? "通过" : "未通过"}:命中 ${total} 行 / 已处置 ${resolved} / 有理由保留 ${justified}`
      + ` / 未解释 ${unexplained.length} / 无效理由 ${invalid.length}`;
  return { passed, total, resolved, justified, unexplained, invalidJustifications: invalid, summary };
}
