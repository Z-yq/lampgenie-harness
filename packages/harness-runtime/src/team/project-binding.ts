/**
 * 项目↔团队绑定(designs/23):「每个项目一个 team,有 git 就有 team」。
 * 绑定键 = 激活项目的 git origin remote ↔ roster projects.yaml 的 repo 字段
 * (协议/凭据/尾斜杠/.git 后缀不敏感);无 remote 回退项目 label 与 projects key 直配。
 * 纯函数无 IO——绑定决策可单测锚定。
 */

export interface ProjectRegistryEntry {
  type?: string;
  repo?: string;
}

/** git remote URL 归一化:去协议/凭据/scp 形态冒号/尾斜杠/.git 后缀,统一小写。 */
export function normalizeRepoUrl(raw: string): string {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, ""); // https:// http:// git:// ssh://
  s = s.replace(/^[^/@]+@/, ""); // git@ 形态的用户段
  // scp 形态 host:path(冒号出现在任何斜杠之前)→ host/path;带端口 URL(host:port/)不受影响。
  const colon = s.indexOf(":");
  const slash = s.indexOf("/");
  if (colon !== -1 && (slash === -1 || colon < slash)) s = s.slice(0, colon) + "/" + s.slice(colon + 1);
  s = s.replace(/\/+$/, ""); // 尾斜杠
  s = s.replace(/\.git$/i, ""); // .git 后缀
  return s.toLowerCase();
}

/**
 * 绑定解析:优先 repo 归一化匹配;无 remote 或匹配不上时回退「项目 label === projects key」。
 * 返回 roster projects 里的项目 id;绑不上返回 null(调用方给「候选-only」视图)。
 */
export function matchProjectId(
  projects: Record<string, ProjectRegistryEntry>,
  remoteUrl: string | null,
  label: string,
): string | null {
  if (remoteUrl) {
    const want = normalizeRepoUrl(remoteUrl);
    if (want) {
      for (const [id, p] of Object.entries(projects)) {
        if (p?.repo && normalizeRepoUrl(p.repo) === want) return id;
      }
    }
  }
  const byLabel = Object.keys(projects).find((id) => id.toLowerCase() === String(label ?? "").toLowerCase());
  return byLabel ?? null;
}
