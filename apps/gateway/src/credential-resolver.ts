/**
 * 凭证引用 → 执行环境边界。
 * 为什么子进程只该看到它需要的凭证:
 * session-worker 是按「一会话一进程」fork 出来的,默认会整份继承 gateway 的 process.env。
 * gateway 进程里同时装着 LLM Key / git token / npm token / MCP 密钥……agent 在子进程里跑的
 * 任何一条命令(甚至一次 `env` 调试输出)都可能把这些值带走。凭证的「名字」(credentialRef)
 * 不能等于「值随手可得」:落到执行环境时按来源(origin)白名单解析,凭证类变量只放行
 * 解析出来的那一个,解析失败 fail-closed(不注入、留审计);普通环境变量照常继承
 * (子进程的工具链/代理/配置都靠它们),明文绝不回显、不落日志。
 * 本模块是纯函数集:不可变(不修改传入对象)、确定性(无时间/随机)、不 throw。
 */

/** 凭证来源白名单:只有这些 origin 才可能拿到凭证。 */
export const CREDENTIAL_ORIGINS = ["llm", "mcp", "git", "npm", "task", "terminal"] as const;
export type CredentialOrigin = (typeof CREDENTIAL_ORIGINS)[number];

const ORIGIN_SET: ReadonlySet<string> = new Set<string>(CREDENTIAL_ORIGINS);

/**
 * 每个 origin 允许注入/放行的凭证变量名(缺省空)。
 * 清洗侧:空 = 不允许任何凭证类变量穿过(除安全基线)。
 * 解析侧:空 = 该来源未登记名字限制,只做 ref/origin 合法性校验(非空清单才逐名比对)。
 */
export const ORIGIN_ALLOWED_ENV: Readonly<Record<CredentialOrigin, readonly string[]>> = Object.freeze({
  llm: Object.freeze([] as string[]),
  mcp: Object.freeze([] as string[]),
  git: Object.freeze([] as string[]),
  npm: Object.freeze([] as string[]),
  task: Object.freeze([] as string[]),
  terminal: Object.freeze([] as string[]),
});

/** 永远保留的安全基线(跨平台;子进程跑命令/找 home/本地化都靠它们)。 */
const SAFE_BASELINE_EXACT: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "SHELL",
  "TERM",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
];

/** 基线里的前缀族(本地化 LC_ALL/LC_CTYPE…)。 */
const SAFE_BASELINE_PREFIXES: readonly string[] = ["LC_"];

/** 一眼像凭证的变量名:未登记白名单就删。 */
const SECRET_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

/** 合法环境变量名(同时挡住 `A=B`、空白、含 `=` 的注入尝试)。 */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface CleanEnvOptions {
 /** 额外放行的凭证变量名(单次调用级白名单)。 */
  allowNames?: readonly string[];
 /** 额外豁免的变量名前缀(即使名称像凭证,也不删)。 */
  keepPrefixes?: readonly string[];
 /** 按 origin 覆写允许清单(缺省用 ORIGIN_ALLOWED_ENV)。 */
  allowNamesByOrigin?: Partial<Record<CredentialOrigin, readonly string[]>>;
}

/** 允许清单:origin 清单 + 本次 allowNames。 */
function allowSetFor(origin: string, opts: CleanEnvOptions): Set<string> {
  const out = new Set<string>();
  const byOrigin = (opts.allowNamesByOrigin ?? ORIGIN_ALLOWED_ENV) as Record<string, readonly string[] | undefined>;
  if (ORIGIN_SET.has(origin)) {
    for (const name of byOrigin[origin] ?? []) out.add(name);
  }
  for (const name of opts.allowNames ?? []) out.add(name);
  return out;
}

/**
 * 为 origin 生成干净的子进程环境:安全基线必保留,凭证类变量按白名单放行,其余普通变量照常继承。
 * - 永远保留安全基线(PATH/HOME/USER/TMPDIR/TEMP/TMP/LANG/LC_ 前缀/SHELL/TERM/SYSTEMROOT/
 * WINDIR/COMSPEC/PATHEXT/APPDATA/LOCALAPPDATA);
 * - 名称像凭证的(KEY/TOKEN/SECRET/…)未在 allowNames/origin 清单/keepPrefixes 里一律删;
 * - 非凭证普通变量保留(工具链/代理/GENIE_* 配置都靠它们;过度白名单会打崩 worker);
 * - 返回新对象,不改 baseEnv;值不输出。
 */
export function cleanEnvForOrigin(
  baseEnv: Readonly<Record<string, string | undefined>> | undefined | null,
  origin: CredentialOrigin | string,
  opts: CleanEnvOptions = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    if (!baseEnv || typeof baseEnv !== "object") return out;
    const name = typeof origin === "string" ? origin : "";
    const allow = allowSetFor(name, opts);
    const baseline = new Set<string>(SAFE_BASELINE_EXACT);
    const keepPrefixes = [...SAFE_BASELINE_PREFIXES, ...(opts.keepPrefixes ?? [])];
    for (const [key, value] of Object.entries(baseEnv)) {
      if (typeof value !== "string") continue;
      if (allow.has(key) || baseline.has(key)) {
        out[key] = value;
        continue;
      }
      if (SECRET_NAME_RE.test(key)) {
 // 凭证类:只有显式豁免前缀(如 keepPrefixes)才保留,否则删
        if (keepPrefixes.some((p) => key.startsWith(p))) out[key] = value;
        continue;
      }
 // 非凭证普通变量:保留(安全基线因此天然保留)
      out[key] = value;
    }
    return out;
  } catch {
    return out; // fail-closed:清洗出错宁可环境更小,也不放值出去
  }
}

export type CredentialFailureCode = "CREDENTIAL_DENIED" | "CREDENTIAL_MISSING";

export interface ResolveCredentialOptions {
 /** 进程环境(优先于 secrets)。 */
  env?: Readonly<Record<string, string | undefined>>;
 /** .genie/secrets.json 形态的名字→值表(只取单个键,绝不整体外传)。 */
  secrets?: Readonly<Record<string, unknown>>;
 /** 按 origin 覆写的允许名单(非空则名录内才放行)。 */
  allowNamesByOrigin?: Partial<Record<CredentialOrigin, readonly string[]>>;
}

export type CredentialResolution =
  | { ok: true; envName: string; value: string; env: Record<string, string> }
  | { ok: false; code: CredentialFailureCode };

/**
 * 按来源解析一个凭证引用:ref 空 / origin 未知 / 不在该 origin 白名单 → DENIED;
 * 先 env[ref] 再 secrets[ref],都没有 → MISSING。成功只返回单个变量的 env 片段。
 */
export function resolveCredential(
  ref: string | undefined | null,
  origin: CredentialOrigin | string,
  opts: ResolveCredentialOptions = {},
): CredentialResolution {
  try {
    const name = typeof ref === "string" ? ref.trim() : "";
    if (!name || !ENV_NAME_RE.test(name)) return { ok: false, code: "CREDENTIAL_DENIED" };
    if (!ORIGIN_SET.has(origin)) return { ok: false, code: "CREDENTIAL_DENIED" };
    const byOrigin = (opts.allowNamesByOrigin ?? ORIGIN_ALLOWED_ENV) as Record<string, readonly string[] | undefined>;
    const list = byOrigin[origin] ?? [];
    if (list.length > 0 && !list.includes(name)) return { ok: false, code: "CREDENTIAL_DENIED" };
    const envValue = opts.env?.[name];
    let value: string | undefined;
    if (typeof envValue === "string" && envValue.length > 0) {
      value = envValue;
    } else {
      const secretValue = opts.secrets?.[name];
      if (typeof secretValue === "string" && secretValue.length > 0) value = secretValue;
    }
    if (value === undefined) return { ok: false, code: "CREDENTIAL_MISSING" };
    return { ok: true, envName: name, value, env: { [name]: value } };
  } catch {
    return { ok: false, code: "CREDENTIAL_DENIED" };
  }
}

/** 打码:长度 <8 只给 "***";否则 "***" + 末 4 位。 */
export function maskCredential(value: string | undefined | null): string {
  try {
    if (typeof value !== "string" || value.length < 8) return "***";
    return `***${value.slice(-4)}`;
  } catch {
    return "***";
  }
}

/** 可落日志的审计对象:只含 ref/origin/code/envName/masked,绝不含明文。 */
export interface CredentialAuditLine {
  ref: string;
  origin: string;
  code: string;
  envName?: string;
  masked?: string;
}

export function credentialAuditLine(
  ref: string | undefined | null,
  origin: CredentialOrigin | string,
  result: CredentialResolution | undefined | null): CredentialAuditLine {
  const name = typeof ref === "string" ? ref.trim() : "";
  const originName = typeof origin === "string" ? origin : "";
  try {
    if (result && result.ok === true) {
      return { ref: name, origin: originName, code: "OK", envName: result.envName, masked: maskCredential(result.value) };
    }
    const code = result && result.ok === false && typeof result.code === "string" ? result.code : "CREDENTIAL_DENIED";
    return { ref: name, origin: originName, code };
  } catch {
    return { ref: name, origin: originName, code: "CREDENTIAL_DENIED" };
  }
}
