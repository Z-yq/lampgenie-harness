/**
 * nightly 经验蒸馏质量门 + 折叠编排( W2)。
 * 经验沉淀改 super agent 每日 dreaming(nightly 机制)统一做。nightly 机制 agent
 * 按 brief 的「经验蒸馏」小节产出 `exp:<category>/<name>` 结果项;本模块在 settle 收尾时:
 * ① 纯函数质量门(零 LLM、零 IO、不 throw,模式照 rsi-quality.ts):类目白名单 / name 形态 /
 * description≤60 / body≥80 / 证据 refs(sessionId/taskId)非空;
 * ② 折叠编排:每晚缺省上限 5;同名同内容跳过(先 store.read+readBody 比对,防 version 空转);
 * 同名异内容 store.write fold-in(version+1);单条失败静默记账,绝不破坏 settle 主链。
 * 类目白名单唯一真相在 agent-wiring/tools.ts 的 FOLD_CATEGORY_WHITELIST(只读复用,不复制文案)。
 */
import { FOLD_CATEGORY_WHITELIST } from "./agent-wiring/tools.js";
import type { ExperienceStore } from "@lampgenie/experience";

/** 经验候选结果项的 title 前缀(与 brief 的 schema 约定逐字一致)。 */
export const EXPERIENCE_TITLE_PREFIX = "exp:";

/** 每晚折叠上限(缺省硬编码,不进 genie.config.json;少而准)。 */
export const EXPERIENCE_FOLD_MAX_PER_NIGHT = 5;

/** description 上限:与经验库写入侧 WRITE_MAX_DESCRIPTION_LENGTH 同口径(60 字符)。 */
export const EXPERIENCE_DESCRIPTION_MAX = 60;

/** body 下限:场景/做法/坑三段写全的最短篇幅。 */
export const EXPERIENCE_BODY_MIN = 80;

/** name 长度上限(目录名形态)。 */
export const EXPERIENCE_NAME_MAX = 60;

/** 小写连字符(允许数字段;不允许首尾/连续连字符、下划线、大写、空格)。 */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 稳定码:调用方只按码分支,不解析文案。 */
export type ExperienceGateCode =
  | "NOT_EXPERIENCE"
  | "BAD_CATEGORY"
  | "BAD_NAME"
  | "MISSING_DESCRIPTION"
  | "LONG_DESCRIPTION"
  | "SHORT_BODY"
  | "NO_EVIDENCE";

/** 质量门入参:RsiResultItem 的结构子集(普通结论项也传进来,按 NOT_EXPERIENCE 分流)。 */
export interface ExperienceCandidateInput {
  id?: string;
  title?: string;
  summary?: string;
  detail?: string;
  evidence?: string;
}

/** 过门后的经验候选(refs 已从 evidence 解析成 sessionId:<id> / taskId:<id>)。 */
export interface ExperienceCandidate {
  category: string;
  name: string;
  description: string;
  body: string;
  refs: string[];
  itemId?: string;
}

export interface ExperienceGateVerdict {
  candidate: ExperienceCandidate | null;
  codes: ExperienceGateCode[];
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 证据 refs:只认 sessionId:<id> / taskId:<id>(冒号或等号均可),其余泛指不算证据。 */
function parseEvidenceRefs(evidence: string): string[] {
  const refs: string[] = [];
  const pattern = /(sessionId|taskId)\s*[:=]\s*([A-Za-z0-9._-]+)/g;
  for (const match of evidence.matchAll(pattern)) {
    refs.push(`${match[1]}:${match[2]}`);
  }
  return refs;
}

/** 单条候选质量门(纯函数):非 exp: 项 → NOT_EXPERIENCE(不算拒绝,是普通结论项)。 */
export function assessExperienceCandidate(item: ExperienceCandidateInput | null | undefined): ExperienceGateVerdict {
  const title = str(item?.title);
  if (!title.startsWith(EXPERIENCE_TITLE_PREFIX)) {
    return { candidate: null, codes: ["NOT_EXPERIENCE"] };
  }
  const codes: ExperienceGateCode[] = [];
  const rest = title.slice(EXPERIENCE_TITLE_PREFIX.length);
  const slash = rest.indexOf("/");
  const category = slash < 0 ? "" : rest.slice(0, slash).trim();
  const name = slash < 0 ? "" : rest.slice(slash + 1).trim();
  if (!(FOLD_CATEGORY_WHITELIST as readonly string[]).includes(category)) codes.push("BAD_CATEGORY");
  if (name === "" || name.length > EXPERIENCE_NAME_MAX || !NAME_PATTERN.test(name)) codes.push("BAD_NAME");
  const description = str(item?.summary);
  if (description === "") codes.push("MISSING_DESCRIPTION");
  else if (description.length > EXPERIENCE_DESCRIPTION_MAX) codes.push("LONG_DESCRIPTION");
  const body = str(item?.detail);
  if (body.length < EXPERIENCE_BODY_MIN) codes.push("SHORT_BODY");
  const refs = parseEvidenceRefs(str(item?.evidence));
  if (refs.length === 0) codes.push("NO_EVIDENCE");
  if (codes.length > 0) return { candidate: null, codes };
  const itemId = str(item?.id);
  return {
    candidate: { category, name, description, body, refs, ...(itemId === "" ? {} : { itemId }) },
    codes: [],
  };
}

export interface ExperienceSelection {
  accepted: ExperienceCandidate[];
  rejected: { itemId?: string; codes: ExperienceGateCode[] }[];
  truncated: number;
}

/** 批量选候选(纯函数):过门 → 批内同名去重(取首条)→ 上限截断(超出计入 truncated,不静默)。 */
export function selectExperienceCandidates(
  items: readonly ExperienceCandidateInput[] | null | undefined,
  max: number = EXPERIENCE_FOLD_MAX_PER_NIGHT,
): ExperienceSelection {
  const accepted: ExperienceCandidate[] = [];
  const rejected: ExperienceSelection["rejected"] = [];
  const seen = new Set<string>();
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : EXPERIENCE_FOLD_MAX_PER_NIGHT;
  let truncated = 0;
  for (const item of Array.isArray(items) ? items : []) {
    const verdict = assessExperienceCandidate(item);
    if (verdict.candidate === null) {
      if (!verdict.codes.includes("NOT_EXPERIENCE")) {
        const itemId = str(item?.id);
        rejected.push({ ...(itemId === "" ? {} : { itemId }), codes: verdict.codes });
      }
      continue;
    }
    const key = `${verdict.candidate.category}/${verdict.candidate.name}`;
    if (seen.has(key)) continue;
    if (accepted.length >= limit) {
      truncated += 1;
      continue;
    }
    seen.add(key);
    accepted.push(verdict.candidate);
  }
  return { accepted, rejected, truncated };
}

export interface ExperienceFoldOutcome {
  folded: number;
  skipped: number;
  rejected: number;
  truncated: number;
  errors: string[];
}

/** 折叠编排(IO 经注入的 store;单条失败静默记账,整体绝不 throw)。
 * 同名同内容(body+description 均一致)跳过,防 version 空转;同名异内容 fold-in(version+1)。 */
export async function foldExperienceCandidates(
  store: ExperienceStore,
  candidates: readonly ExperienceCandidate[],
): Promise<ExperienceFoldOutcome> {
  const outcome: ExperienceFoldOutcome = { folded: 0, skipped: 0, rejected: 0, truncated: 0, errors: [] };
  for (const candidate of candidates.slice(0, EXPERIENCE_FOLD_MAX_PER_NIGHT)) {
    try {
      const existing = store.read(candidate.category, candidate.name);
      if (existing) {
        const body = store.readBody(candidate.category, candidate.name);
        if (body.trim() === candidate.body.trim() && existing.description === candidate.description) {
          outcome.skipped += 1;
          continue;
        }
      }
      await store.write(
        { category: candidate.category, name: candidate.name, description: candidate.description, created_by: "agent" },
        candidate.body,
      );
      outcome.folded += 1;
    } catch (err) {
      outcome.errors.push(
        `${candidate.category}/${candidate.name}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
      );
    }
  }
  return outcome;
}

/** settle 主链入口:结果项 → 质量门 → 折叠,一次调用拿全记账数字(绝不 throw)。 */
export async function foldExperiencesFromResults(
  store: ExperienceStore,
  items: readonly ExperienceCandidateInput[] | null | undefined,
): Promise<ExperienceFoldOutcome> {
  const selection = selectExperienceCandidates(items);
  const outcome = await foldExperienceCandidates(store, selection.accepted);
  return { ...outcome, rejected: selection.rejected.length, truncated: selection.truncated };
}
