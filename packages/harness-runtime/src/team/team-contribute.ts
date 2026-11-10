/**
 * 会话经验贡献( §2.4 / teamai-cli contribute):
 * 纯函数层——learnings 文件名 slug 化 + 文档渲染。**无 IO**(relay 的 git 写入在 team-relay.ts),
 * 便于单测与读侧(teamai-bridge.parseLearningMeta)形态对齐。
 * 落点:团队仓 `teamai-learnings` 分支的 `learnings/<ts>-<slug>.md`。
 */

/** slug 长度上限(契约 §2.4:截断 40)。 */
export const LEARNING_SLUG_MAX = 40;

/** 标题 → 文件名 slug:非字母数字转 `-`,压缩连续分隔符,截断 40,空则 `untitled`。 */
export function learningSlug(title: string): string {
  const slug = String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, LEARNING_SLUG_MAX)
    .replace(/-+$/, "");
  return slug || "untitled";
}

/** learnings 文件相对路径(团队仓内)。ts=毫秒时间戳(纯函数,不取时钟)。 */
export function learningPath(ts: number, title: string): string {
  return `learnings/${Math.trunc(Number(ts) || 0)}-${learningSlug(title)}.md`;
}

export interface LearningDocInput {
  title: string;
  body: string;
  author: string;
  tags?: string[];
  /** 写入时刻(缺省 Date.now() 的调用方注入;本函数仍是纯函数)。 */
  at?: Date | number | string;
}

function isoAt(at: LearningDocInput["at"]): string {
  if (at === undefined) return new Date(0).toISOString();
  if (at instanceof Date) return at.toISOString();
  if (typeof at === "number") return new Date(at).toISOString();
  return String(at);
}

/**
 * learnings 文档渲染:frontmatter(title/tags/author/at)+ 正文。
 * `date:` 与 `at:` 同值镜像——读侧 `parseLearningMeta` 消费 `date:`(digest.learnings.date 不为空),
 * `at:` 是契约 §2.4 规定的字段名。
 */
export function renderLearningDoc(input: LearningDocInput): string {
  const title = String(input.title ?? "").replace(/"/g, "'").replace(/\s+/g, " ").trim();
  const tags = (input.tags ?? [])
    .map((t) => String(t).replace(/[[\],]/g, "").trim())
    .filter(Boolean);
  const author = String(input.author ?? "").trim() || "unknown";
  const at = isoAt(input.at);
  const body = String(input.body ?? "").replace(/\s+$/, "");
  return [
    "---",
    `title: "${title}"`,
    `tags: [${tags.join(", ")}]`,
    `author: ${author}`,
    `at: ${at}`,
    `date: ${at}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}
