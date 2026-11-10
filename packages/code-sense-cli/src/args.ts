/** 极简参数解析(零依赖):--key value / --key=value / 布尔开关;其余进位置参数。 */
import { homedir } from "node:os";
import { join } from "node:path";

export interface ParsedArgs {
  /** 位置参数(非 -- 开头)。 */
  _: string[];
  /** 旗标:布尔开关或取值。 */
  flags: Record<string, string | boolean>;
}

const BOOLEAN_DEFAULTS = new Set(["json", "no-color", "force", "purge", "quiet", "no-build", "no-llm", "refresh", "mermaid", "help", "version", "deep", "impact", "register", "locals", "semantics", "write", "graph", "all", "no-tests", "no-docs", "include-tests", "include-docs", "candidates", "semantic", "dot", "no-graph", "keep-isolated", "no-legend", "no-process-entries", "no-flow"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("-") || a === "-") {
      out._.push(a);
      continue;
    }
    let key = a.replace(/^--?/, "");
    let value: string | boolean = true;
    const eq = key.indexOf("=");
    if (eq >= 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else if (!BOOLEAN_DEFAULTS.has(key) && i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) {
      value = argv[++i]!;
    }
    out.flags[key] = value;
  }
  return out;
}

/** 波浪号展开:`~`/`~/x` → 用户主目录。CLI 常经 execFile/引号包裹等非 shell 路径
 * 调用,shell 不代展开——参数面统一自展,`--root '~/x'` 与 `--root ~/x` 同语义。其余原样返回。 */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

export function flagStr(p: ParsedArgs, key: string): string | undefined {
  const v = p.flags[key];
  return typeof v === "string" ? v : undefined;
}

export function flagBool(p: ParsedArgs, key: string): boolean {
  return p.flags[key] === true || p.flags[key] === "true";
}
