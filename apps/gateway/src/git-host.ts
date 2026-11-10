/**
 * Git 托管甄别(fixD1,团队 issue 双通道前置):origin remote URL → 托管平台画像。
 * github.com→github;/gitlab\.|gitlab\.com/→gitlab;私有域名→gitlab-self(可配 gitHost 覆盖);
 * 本地路径/空→none。纯函数无 IO,项目注册时可缓存进 registry(kind 只增字段不破坏现有)。
 */
export type GitHostKind = "github" | "gitlab" | "gitlab-self" | "none";

export interface GitHostInfo {
  kind: GitHostKind;
  /** REST API 基址(none 时空串)。 */
  apiBase: string;
  /** full_name(owner/repo;none/null)。GitHub=两段;GitLab=**末两段**(兼容既有语义)。 */
  repo: string | null;
  /** 完整命名空间路径(GitLab 子组场景必须用完整路径定位项目:group/sub/repo;
   *  GitHub 与 repo 相同)。issue-service 的 GitLab REST 走本字段(末两段会 404)。 */
  fullPath?: string | null;
  /** 解析出的裸域名(端口已剥;本地路径为空串)。 */
  host: string;
}

/** 覆盖项:gitHost=私有域名的平台定性覆盖(如自建 Gitea 按 github 兼容面接入);仅作用于私有域名。 */
export interface GitHostOverride {
  gitHost?: "github" | "gitlab";
}

interface ParsedRemote {
  /** 裸域名(端口已剥;小写归一)。 */
  host: string;
  /** 显式端口(无=undefined)。 */
  port?: number;
  /** 传输 scheme(http/https/ssh/git);scp 形无 scheme=undefined。 */
  scheme?: string;
  path: string;
}

/** URL → {host, port, scheme, path}:兼容 scp 形(git@host:owner/repo.git)、ssh://、http(s)://、带端口/用户。 */
function parseRemote(url: string): ParsedRemote | null {
  const u = url.trim();
  if (!u) return null;
  // scp 形:git@host:path(无 scheme,按 git 协议语义;API 侧随后按 https 兜底)
  const scp = u.match(/^(?:[a-zA-Z0-9._-]+@)([a-zA-Z0-9.-]+?)(?::)(.+)$/);
  if (scp && scp[1] && scp[2]) {
    return { host: stripPort(scp[1]), path: cleanPath(scp[2]) };
  }
  // scheme 形
  const scheme = u.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^\/]+)\/(.+)$/);
  const schemeName = scheme?.[1];
  const schemeHost = scheme?.[2];
  const schemePath = scheme?.[3];
  if (schemeName && schemeHost && schemePath) {
    // 去掉 userinfo(git@host / user:token@host)
    const hostPart = schemeHost.replace(/^[^@]*@/, "");
    const hostOnly = stripPort(hostPart);
    // 无点主机名:localhost/单标签内网名——带端口时按内网自建处理,否则当本地路径语义。
    if (!hostOnly.includes(".") && !/:\d+$/.test(hostPart)) return null;
    const portMatch = /:(\d+)$/.exec(hostPart);
    return {
      host: hostOnly,
      ...(portMatch ? { port: Number(portMatch[1]) } : {}),
      scheme: schemeName.toLowerCase(),
      path: cleanPath(schemePath),
    };
  }
  return null; // 本地路径(/x/y、相对路径)
}

function stripPort(host: string): string {
  return host.replace(/:\d+$/, "");
}

function cleanPath(p: string): string {
  return p.trim().replace(/\.git$/, "").replace(/^\/+/, "").replace(/\/+$/, "");
}

/** path → full_name:取前两段(owner/repo);多级(group/sub/repo)取末两段(gitlab 子组合并语义近似的保守面)。 */
function repoOf(path: string): string | null {
  const segs = path.split("/").filter(Boolean);
  if (segs.length < 2) return null;
  return segs.slice(-2).join("/");
}

/** 甄别主函数。remoteUrl=null/本地路径→none;私有域名默认 gitlab-self,override.gitHost 可改判。 */
export function detectGitHost(remoteUrl: string | null, override?: GitHostOverride): GitHostInfo {
  if (!remoteUrl) return { kind: "none", apiBase: "", repo: null, fullPath: null, host: "" };
  const parsed = parseRemote(remoteUrl);
  if (!parsed || !parsed.host) return { kind: "none", apiBase: "", repo: null, fullPath: null, host: "" };
  const repo = repoOf(parsed.path);
  const fullPath = parsed.path || null;
  const host = parsed.host.toLowerCase();
  // 自建实例的 API 基址必须跟随 remote 的真实 scheme 与端口:内网自建 GitLab 常见形态是
  // http://192.168.8.60:8080/group/repo.git,硬编 https+裸域名会连不上(或者打到错误的 https 端口)。
  // scp 形(git@host:path)没有 scheme 信息,API 语义按 https 兜底(与 gitlab/github 官方一致)。
  const apiOrigin = `${parsed.scheme === "http" ? "http" : "https"}://${host}${parsed.port ? `:${parsed.port}` : ""}`;
  const selfHosted = parsed.scheme === "http" || parsed.port !== undefined;
  if (host === "github.com" || host.endsWith(".github.com")) {
    return { kind: "github", apiBase: "https://api.github.com", repo, fullPath, host };
  }
  if (host === "gitlab.com" || host.includes("gitlab")) {
    // gitlab.com 用官方 API 域;其余 gitlab.* 域名(子域/自建命名)apiBase 跟随实际域名。
    if (host === "gitlab.com" && !selfHosted) return { kind: "gitlab", apiBase: "https://gitlab.com/api/v4", repo, fullPath, host };
    return { kind: "gitlab", apiBase: `${apiOrigin}/api/v4`, repo, fullPath, host };
  }
  // 私有域名:默认 gitlab-self(自建 GitLab 最常见);override.gitHost 显式改判。
  const forced = override?.gitHost;
  if (forced === "github") {
    // GitHub Enterprise:API 前缀是 /api/v3。
    return { kind: "github", apiBase: `${apiOrigin}/api/v3`, repo, fullPath, host };
  }
  if (forced === "gitlab") {
    return { kind: "gitlab", apiBase: `${apiOrigin}/api/v4`, repo, fullPath, host };
  }
  return { kind: "gitlab-self", apiBase: `${apiOrigin}/api/v4`, repo, fullPath, host };
}
