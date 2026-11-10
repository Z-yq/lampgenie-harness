/**
 * 开工回顾(recall):任务 query→经验检索(grep 关键词+域匹配,零 embedding)
 * →命中条目注入;+curator 确定性生命周期。
 */
import type { ExperienceStore } from "./store";
import { renameSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface RecalledExperience {
  category: string;
  name: string;
  description: string;
  body: string;
  score: number;
  matchedOn: string[];
}

/** 检索:query 分词与 name/description/body 的关键词命中计分。 */
export function recallExperiences(store: ExperienceStore, query: string, max = 3): RecalledExperience[] {
  const terms = [...new Set(query.split(/[\s,;:、,]+/).map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 2))];
  if (terms.length === 0) return [];
  const out: RecalledExperience[] = [];
  for (const { category, name, description } of store.index()) {
    const body = store.readBody(category, name);
    const nameLow = name.toLowerCase();
    const descLow = description.toLowerCase();
    const bodyLow = body.toLowerCase();
    let score = 0;
    const matchedOn: string[] = [];
    for (const t of terms) {
      if (nameLow.includes(t)) { score += 3; matchedOn.push(`name:${t}`); }
      if (descLow.includes(t)) { score += 2; matchedOn.push(`desc:${t}`); }
      if (bodyLow.includes(t)) { score += 1; matchedOn.push(`body:${t}`); }
    }
    if (score >= 3) {
      out.push({ category, name, description, body: body.slice(0, 600), score, matchedOn: [...new Set(matchedOn)] });
    }
  }
  out.sort((a, b) => b.score - a.score);
  // 命中即计使用(bump use;patch 后首次使用计入 reuse_after_patch)
  for (const r of out.slice(0, max)) {
    try { store.bumpUse(r.category, r.name, "use"); } catch { /* sidecar 缺失不阻塞 */ }
  }
  return out.slice(0, max);
}

/** 注入格式:instructions 尾部的经验提示块。 */
export function renderRecallBlock(recalled: RecalledExperience[]): string {
  if (recalled.length === 0) return "";
  const lines = ["", "## 过往经验提示(开工回顾,来自经验库)"];
  for (const r of recalled) {
    lines.push(`- [经验:${r.name}](${r.matchedOn.slice(0, 2).join(",")} 命中) ${r.description}`);
    lines.push(`  摘要: ${r.body.slice(0, 200).replace(/\n/g, " ")}`);
  }
  lines.push("(以上为历史沉淀,若与本任务冲突以任务为准;发现经验有误请修复而非绕过)");
  return lines.join("\n");
}

// ---- curator(确定性生命周期,Hermes active→stale 14d→archived 30d) ----
export const STALE_DAYS = 14;
export const ARCHIVE_DAYS = 30;

export interface CuratorReport { staled: string[]; archived: string[]; protectedFromArchive: string[] }

export function runCurator(store: ExperienceStore, now = Date.now()): CuratorReport {
  const report: CuratorReport = { staled: [], archived: [], protectedFromArchive: [] };
  for (const { category, name } of store.index()) {
    const fm = store.read(category, name);
    const usage = store.usage(category, name);
    if (!fm) continue;
    const created = new Date(fm.created_at).getTime();
    const lastUsed = usage.last_used_at ? new Date(usage.last_used_at).getTime() : null;
    const lastActivity = Math.max(created, lastUsed ?? 0);
    const idleDays = (now - lastActivity) / 864e5;

    // 状态推进:active→stale→archived
    if (fm.status === "active" && idleDays > STALE_DAYS) {
      store.setStatus(category, name, "stale");
      report.staled.push(`${category}/${name}`);
    } else if (fm.status === "stale" && idleDays > ARCHIVE_DAYS) {
      // use=0 的新条目永不归档(Hermes 纪律:给新技能被用到的机会)
      if (usage.use_count === 0 && (now - created) / 864e5 < ARCHIVE_DAYS * 2) {
        report.protectedFromArchive.push(`${category}/${name}`);
        continue;
      }
      archiveEntry(store, category, name);
      report.archived.push(`${category}/${name}`);
    }
  }
  return report;
}

/** archive=移 .archive/ 子目录,永不删除(可 restore)。 */
function archiveEntry(store: ExperienceStore, category: string, name: string): void {
  const src = join(store.root, category, name);
  const dst = join(store.root, ".archive", category, name);
  if (!existsSync(src)) return;
  mkdirSync(join(store.root, ".archive", category), { recursive: true });
  renameSync(src, dst);
  store.appendLedgerPublic({ at: new Date().toISOString(), action: "archive", category, name, version: 0, prevHash: null, newHash: null });
}
