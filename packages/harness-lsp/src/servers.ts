/**
 * 语言路由 + 本机语言服务器探测(step-114)。
 * 纪律:探测纯同步文件系统检查,不执行 which 子进程;server 缺失=null(调用方 fail-soft)。
 * 覆盖口:GENIE_LSP_<FAMILY>_COMMAND(空白切分;用于自定义 server/测试 fake server)。
 */
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export type LanguageFamily = "ts" | "js" | "py" | "go";

export interface LanguageRoute {
  family: LanguageFamily;
  /** LSP languageId(textDocument/didOpen)。 */
  languageId: string;
  /** 格式化缩进形态。 */
  tabSize: number;
  insertSpaces: boolean;
}

export interface ServerSpec {
  /** 稳定 id(manager broken 缓存/观测用)。 */
  id: string;
  /** 可执行文件绝对路径或 PATH 名。 */
  command: string;
  args: string[];
  /** 面向日志的标签。 */
  label: string;
}

const EXT_ROUTE: Record<string, LanguageRoute> = {
  ".ts": { family: "ts", languageId: "typescript", tabSize: 2, insertSpaces: true },
  ".tsx": { family: "ts", languageId: "typescriptreact", tabSize: 2, insertSpaces: true },
  ".mts": { family: "ts", languageId: "typescript", tabSize: 2, insertSpaces: true },
  ".cts": { family: "ts", languageId: "typescript", tabSize: 2, insertSpaces: true },
  ".js": { family: "js", languageId: "javascript", tabSize: 2, insertSpaces: true },
  ".jsx": { family: "js", languageId: "javascriptreact", tabSize: 2, insertSpaces: true },
  ".mjs": { family: "js", languageId: "javascript", tabSize: 2, insertSpaces: true },
  ".cjs": { family: "js", languageId: "javascript", tabSize: 2, insertSpaces: true },
  ".py": { family: "py", languageId: "python", tabSize: 4, insertSpaces: true },
  ".go": { family: "go", languageId: "go", tabSize: 4, insertSpaces: false },
};

export function languageRouteOf(absPath: string): LanguageRoute | null {
  const m = /(\.[^.\\/]+)$/.exec(absPath);
  if (!m) return null;
  return EXT_ROUTE[m[1]!.toLowerCase()] ?? null;
}

const execCache = new Map<string, string | null>();

/** PATH 扫描(带缓存):返回可执行文件绝对路径,缺失=null。 */
export function findExecutable(name: string): string | null {
  const cached = execCache.get(name);
  if (cached !== undefined) return cached;
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  let found: string | null = null;
  outer:
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = join(dir, name + ext);
      try {
        if (!existsSync(full) || !statSync(full).isFile()) continue;
        accessSync(full, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        found = full;
        break outer;
      } catch { /* 继续找 */ }
    }
  }
  execCache.set(name, found);
  return found;
}

/** 测试/热装后重置探测缓存(生产不需要)。 */
export function resetServerDiscoveryCache(): void {
  execCache.clear();
}

function overrideFor(family: LanguageFamily): ServerSpec | null {
  const envSuffix = family === "js" ? "TYPESCRIPT" : family === "py" ? "PYTHON" : family.toUpperCase();
  const envName = `GENIE_LSP_${envSuffix}_COMMAND`;
  const raw = String(process.env[envName] ?? "").trim();
  if (!raw) return null;
  const parts = raw.split(/\s+/);
  const command = parts[0]!;
  const resolved = isAbsolute(command) || command.includes("/") || command.includes("\\") ? command : (findExecutable(command) ?? command);
  return { id: `env:${family}:${command}`, command: resolved, args: parts.slice(1), label: `env ${envName}` };
}

function firstAvailable(id: string, candidates: { command: string; args: string[] }[]): ServerSpec | null {
  for (const c of candidates) {
    const command = findExecutable(c.command);
    if (command) return { id, command, args: c.args, label: c.command };
  }
  return null;
}

/**
 * 按文件类型探测可用语言服务器。
 * TS/JS 共用 typescript-language-server;Python 依次 pyright/basedpyright/pylsp;Go 仅 gopls。
 */
export function discoverServer(route: LanguageRoute): ServerSpec | null {
  const override = overrideFor(route.family);
  if (override) return override;
  switch (route.family) {
    case "ts":
    case "js":
      return firstAvailable("typescript-language-server", [{ command: "typescript-language-server", args: ["--stdio"] }]);
    case "py":
      return firstAvailable("python-lsp", [
        { command: "pyright-langserver", args: ["--stdio"] },
        { command: "basedpyright-langserver", args: ["--stdio"] },
        { command: "pylsp", args: [] },
      ]);
    case "go":
      return firstAvailable("gopls", [{ command: "gopls", args: ["serve"] }]);
    default:
      return null;
  }
}
