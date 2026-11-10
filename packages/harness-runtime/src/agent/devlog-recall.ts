/**
 * DevLog 检索注入(step-009 P5 补账,R5-C9 修复):压缩落盘的 devlog/*.json
 * 按关键词命中注入新任务 instructions(与经验 recall 并列的第二条历史回顾通道)。
 * 零 embedding:query 分词 × summary 子串计分(grep 纪律)。
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface DevlogEntry {
  file: string;
  sessionId: string;
  summary: string;
  compactedAt?: number;
  score: number;
  matchedOn: string[];
}

/** 检索:devlogDir 下 *.json 的 summary 与 query 分词命中计分(每词 2 分,≥2 分入选)。 */
export function recallDevlogs(devlogDir: string, query: string, max = 2): DevlogEntry[] {
  if (!existsSync(devlogDir)) return [];
  const terms = [...new Set(query.split(/[\s,;:、,]+/).map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 2))];
  if (terms.length === 0) return [];
  const out: DevlogEntry[] = [];
  for (const f of readdirSync(devlogDir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const j = JSON.parse(readFileSync(join(devlogDir, f), "utf-8")) as {
        sessionId?: string; summary?: string; compactedAt?: number;
      };
      const summary = String(j.summary ?? "");
      const low = summary.toLowerCase();
      let score = 0;
      const matchedOn: string[] = [];
      for (const t of terms) {
        if (low.includes(t)) { score += 2; matchedOn.push(t); }
      }
      if (score >= 2) {
        out.push({
          file: f,
          sessionId: String(j.sessionId ?? ""),
          summary,
          compactedAt: j.compactedAt,
          score,
          matchedOn: [...new Set(matchedOn)],
        });
      }
    } catch { /* 坏文件跳过,不阻塞开工 */ }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, max);
}

/** 注入格式:instructions 尾部的 DevLog 提示块。 */
export function renderDevlogBlock(recalled: DevlogEntry[]): string {
  if (recalled.length === 0) return "";
  const lines = ["", "## 历史 DevLog 提示(压缩落盘的历史会话摘要)"];
  for (const r of recalled) {
    lines.push(`- [${r.file}](${r.matchedOn.slice(0, 2).join(",")} 命中) ${r.summary.slice(0, 200).replace(/\n/g, " ")}`);
  }
  lines.push("(历史摘要,若与本任务冲突以任务为准)");
  return lines.join("\n");
}
